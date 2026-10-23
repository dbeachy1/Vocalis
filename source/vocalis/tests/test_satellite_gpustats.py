"""Satellite 2.0 — `POST /satellite/gpustats` (10.21, DESIGN_10_21_FAN_AND_SATELLITE_STRIP.md §5).

`nvidia-ml-py` and `pywin32` are never required here: both are faked, so the suite runs on Linux
and Windows. GPU-specific behavior is checked with controlled test doubles.
"""
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "satellite"))
import vocalis_satellite_gpustats as gs          # noqa: E402
import vocalis_satellite_protocol as proto       # noqa: E402

GB = 1024 ** 3


@pytest.fixture(autouse=True)
def _fresh_module_state(monkeypatch):
    """Every once-only cache in the module, reset per test — a mapping or a "warned" set left
    over from one test would silently change what the next one sees."""
    monkeypatch.setattr(gs, "_NVML", None)
    monkeypatch.setattr(gs, "_NVML_UNAVAILABLE_LOGGED", False)
    monkeypatch.setattr(gs, "_MAPPING", None)
    monkeypatch.setattr(gs, "_MAPPING_FALLBACK_LOGGED", set())
    # October 10, 2026: the once-only and retry state `whole_card()` added.
    monkeypatch.setattr(gs, "_NVML_RETRY_AT", None)
    monkeypatch.setattr(gs, "_MAPPING_RETRY_AT", None)
    monkeypatch.setattr(gs, "_MAPPING_FAILURE_LOGGED", False)
    monkeypatch.setattr(gs, "_HANDLE_WARNED", set())
    monkeypatch.setattr(gs, "_CARD_ACTIVE_LOGGED", set())
    monkeypatch.setattr(gs, "_CARD_CACHE", {})
    monkeypatch.setattr(gs, "_FIELD_WARNED", set())
    monkeypatch.setattr(gs, "_MCLK_DIVISOR", {})
    monkeypatch.setattr(gs, "_VOCALIS_GB_FALLBACK_LOGGED", set())
    monkeypatch.setattr(gs, "_PDH_SAMPLER", gs.PdhSampler(pdh_loader=lambda: None))


class FakeNVML:
    """Just enough of `pynvml` for `sample()`. `cards` is in NVML (PCI) order.

    🔴 `NVMLError` IS AN ATTRIBUTE OF THE FAKE MODULE, NOT A FREE-STANDING CLASS — the same
    shape the real `pynvml` module has. `gpustats.py`'s narrowed `except nvml.NVMLError` reads
    the class off whatever `nvml` object it was handed, real or fake, which is what makes this
    fake indistinguishable from the real module for that catch.
    """
    NVML_CLOCK_SM, NVML_CLOCK_MEM, NVML_TEMPERATURE_GPU = 1, 2, 0

    class NVMLError(Exception):
        pass

    def __init__(self, cards):
        self.cards = cards
        self.max_clock_calls = 0     # counts nvmlDeviceGetMaxClockInfo — the divisor read

    def nvmlInit(self):
        pass

    def nvmlDeviceGetCount(self):
        return len(self.cards)

    def nvmlDeviceGetHandleByIndex(self, i):
        return self.cards[i]

    def nvmlDeviceGetUUID(self, h):
        return h["uuid"]

    def nvmlDeviceGetName(self, h):
        return h["name"]

    def nvmlDeviceGetMemoryInfo(self, h):
        return SimpleNamespace(total=h["total"], used=h["used"], free=h["total"] - h["used"])

    def nvmlDeviceGetUtilizationRates(self, h):
        return SimpleNamespace(gpu=h["util"])

    def nvmlDeviceGetClockInfo(self, h, which):
        return h["sclk"] if which == self.NVML_CLOCK_SM else h["mclk"]

    def nvmlDeviceGetMaxClockInfo(self, h, which):
        self.max_clock_calls += 1
        if h["mclk_max"] is None:
            raise self.NVMLError("Not Supported")
        return h["mclk_max"]

    def nvmlDeviceGetPowerUsage(self, h):
        return h["power_mw"]

    def nvmlDeviceGetTemperature(self, h, which):
        return h["temp"]

    def nvmlDeviceGetFanSpeed(self, h):
        if h.get("fan") is None:
            raise self.NVMLError("Not Supported")
        return h["fan"]


def _card(uuid, name, *, used=4, fan=0, mclk=10501, mclk_max=10501):
    return {"uuid": f"GPU-{uuid}", "name": name, "total": 24 * GB, "used": used * GB,
            "util": 11, "sclk": 345, "mclk": mclk, "mclk_max": mclk_max, "power_mw": 69788,
            "temp": 51, "fan": fan}


class FakeTorch:
    """`torch` as `sample()` sees it. `uuids` is in CUDA order.

    `initialized` and `total_memory` cover the case where `torch.cuda.is_initialized()` is false
    until something has actually touched the card, and
    `mem_get_info` must not be called in that state (it would CREATE the very context this
    fake's caller is trying to avoid)."""

    def __init__(self, uuids, names=None, reserved=1 * GB, initialized=True,
                total_memory=24 * GB):
        self._uuids = uuids
        self._names = names or ["torch-name"] * len(uuids)
        self._reserved = reserved
        self._initialized = initialized
        self._total_memory = total_memory
        self.device_name_calls = []
        self.properties_calls = []
        self.mem_info_calls = []
        self.cuda = self

    def device_count(self):
        return len(self._uuids)

    def get_device_properties(self, i):
        self.properties_calls.append(i)
        return SimpleNamespace(uuid=self._uuids[i], total_memory=self._total_memory)

    def get_device_name(self, i):
        self.device_name_calls.append(i)
        return self._names[i]

    def is_initialized(self):
        return self._initialized

    def mem_get_info(self, i):
        self.mem_info_calls.append(i)
        return (20 * GB, 24 * GB)

    def memory_reserved(self, i):
        return self._reserved


class FakeEngine:
    def __init__(self, n):
        self.n = n

    def available_devices(self):
        return [f"cuda:{i}" for i in range(self.n)]


def _install(monkeypatch, torch, nvml):
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setattr(gs, "_nvml_module", lambda: nvml)


KEYS = {"index", "device", "name", "total_gb", "used_gb", "free_gb", "vocalis_gb",
        "util_pct", "sclk_mhz", "mclk_mhz", "power_w", "temp_c", "fan_pct"}


# ── NVML fields ──────────────────────────────────────────────────────────────

def test_every_field_is_mapped_with_the_right_units(monkeypatch):
    _install(monkeypatch, FakeTorch(["aaaa"]), FakeNVML([_card("AAAA", "RTX 4090")]))
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert set(g) == KEYS, "every key is always present, even when null"
    assert g == {"index": 0, "device": "cuda:0", "name": "RTX 4090",
                 "total_gb": 24.0, "used_gb": 4.0, "free_gb": 20.0, "vocalis_gb": 1.0,
                 "util_pct": 11, "sclk_mhz": 345, "mclk_mhz": 1313,
                 "power_w": 70, "temp_c": 51, "fan_pct": 0}, (
        "10501 / 8 = 1312.625 -> 1313 — GDDR6X's ÷8 divisor yields 1313 MHz")


def test_an_unsupported_fan_blanks_that_field_only(monkeypatch):
    _install(monkeypatch, FakeTorch(["aaaa"]), FakeNVML([_card("aaaa", "laptop", fan=None)]))
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert g["fan_pct"] is None
    assert g["temp_c"] == 51 and g["util_pct"] == 11 and g["name"] == "laptop"


def test_cuda_and_nvml_orders_differ_and_the_uuid_decides(monkeypatch):
    """CUDA orders fastest-first, NVML by PCI bus. Two cards, reversed: `cuda:0` must read the
    card whose UUID it has, not NVML device 0."""
    nvml = FakeNVML([_card("bbbb", "RTX 3060", used=2), _card("aaaa", "RTX 4090", used=9)])
    _install(monkeypatch, FakeTorch(["aaaa", "bbbb"]), nvml)
    gpus = gs.sample(FakeEngine(2))["gpus"]
    assert [(g["device"], g["name"], g["used_gb"]) for g in gpus] == [
        ("cuda:0", "RTX 4090", 9.0), ("cuda:1", "RTX 3060", 2.0)]


def test_resolve_pairs_one_card_even_without_a_uuid_match():
    assert gs.resolve_cuda_to_nvml(["x"], ["GPU-y"]) == {0: 0}
    assert gs.resolve_cuda_to_nvml(["x", "z"], ["GPU-y", "GPU-w"]) == {0: None, 1: None}


def test_without_nvml_torch_fallback_does_not_touch_cuda_device(monkeypatch):
    torch = FakeTorch(["aaaa"], names=["NVIDIA GeForce RTX 4090"])
    _install(monkeypatch, torch, None)
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert all(g[k] is None for k in ("name", "total_gb", "used_gb", "free_gb",
                                      "util_pct", "sclk_mhz", "mclk_mhz", "power_w",
                                      "temp_c", "fan_pct"))
    assert torch.device_name_calls == []
    assert torch.properties_calls == []
    assert torch.mem_info_calls == []


def test_no_nvml_does_not_probe_torch_even_when_process_cuda_is_initialized(monkeypatch):
    """A process-wide initialized flag cannot establish that this card owns a CUDA context.
    Name/property reads may also trigger lazy initialization, so an NVML miss leaves these
    fields empty even when another GPU initialized CUDA earlier in the process."""
    torch = FakeTorch(["aaaa"], names=["NVIDIA GeForce RTX 4090"], initialized=True,
                      total_memory=24 * GB)
    _install(monkeypatch, torch, None)
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert g["name"] is None and g["total_gb"] is None
    assert g["used_gb"] is None and g["free_gb"] is None
    assert torch.device_name_calls == []
    assert torch.properties_calls == []
    assert torch.mem_info_calls == []


# ── mclk_mhz's memory-class divisor ──────────────────────────────────────────

class _DivisorLog:
    """Just enough of `loguru.logger` to see what `_resolve_mclk_divisor` says and how often."""

    def __init__(self):
        self.info_lines = []
        self.warning_lines = []

    def info(self, m):
        self.info_lines.append(m)

    def warning(self, m):
        self.warning_lines.append(m)

    def debug(self, m):
        pass


def test_gddr6_card_divides_by_four(monkeypatch):
    """RTX A6000-class GDDR6: 14-18 Gbps reports a max of 7001-9001; 8001 -> divisor 4 ->
    2000 MHz, GPU-Z's own figure for that card."""
    _install(monkeypatch, FakeTorch(["aaaa"]),
             FakeNVML([_card("aaaa", "RTX A6000", mclk=8001, mclk_max=8001)]))
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert g["mclk_mhz"] == 2000


def test_hbm_card_is_unchanged(monkeypatch):
    """HBM reports its real clock directly — max < 5000 -> divisor 1, no correction at all."""
    _install(monkeypatch, FakeTorch(["aaaa"]),
             FakeNVML([_card("aaaa", "MI-class HBM card", mclk=1593, mclk_max=1593)]))
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert g["mclk_mhz"] == 1593


def test_hbm3e_class_is_not_divided_by_four(monkeypatch):
    """The old `3000 <= max < 9500 -> ÷4` boundary put an
    HBM3e card's rated max (~3200+ MHz) inside the GDDR6 band and would have divided its real
    clock by 4. GDDR6's lowest rated max is ~7001 (the docstring's own 14 Gbps figure), so
    `max < 5000 -> ÷1` leaves nothing misclassified on either side."""
    _install(monkeypatch, FakeTorch(["aaaa"]),
             FakeNVML([_card("aaaa", "HBM3e-class card", mclk=3201, mclk_max=3201)]))
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert g["mclk_mhz"] == 3201


def test_unreadable_max_clock_blanks_mclk_only(monkeypatch):
    """No divisor to infer without a readable max clock — `mclk_mhz` reads null rather than a
    wrong number; every other field on the same card is unaffected."""
    _install(monkeypatch, FakeTorch(["aaaa"]),
             FakeNVML([_card("aaaa", "RTX 4090", mclk_max=None)]))
    g = gs.sample(FakeEngine(1))["gpus"][0]
    assert g["mclk_mhz"] is None
    assert g["util_pct"] == 11 and g["name"] == "RTX 4090" and g["temp_c"] == 51


def test_the_divisor_is_resolved_once_and_logged_once(monkeypatch):
    """The max clock is a rated constant for the card's whole life — reading it (and logging the
    inferred class) on every one of several `sample()` calls would be both wasted NVML traffic
    and unreadable at 4 Hz."""
    nvml = FakeNVML([_card("aaaa", "RTX 4090")])
    _install(monkeypatch, FakeTorch(["aaaa"]), nvml)
    log = _DivisorLog()
    monkeypatch.setattr(gs, "logger", log)
    for _ in range(3):
        gs.sample(FakeEngine(1))
    assert nvml.max_clock_calls == 1, "the max clock is read once, not once per sample()"
    divisor_lines = [m for m in log.info_lines if "memory clock" in m]
    assert len(divisor_lines) == 1, "the divisor is logged once, not once per sample()"
    assert "÷8" in divisor_lines[0] and "10501" in divisor_lines[0]
    # The line must state the REAL clock, not present NVML's raw 10501 as a clock in MHz.
    assert "1313 MHz" in divisor_lines[0] and "10501 MHz" not in divisor_lines[0]


# ── vocalis_gb via PDH ───────────────────────────────────────────────────────

def test_pdh_sum_on_one_luid_with_one_card():
    readings = {"pid_1_luid_0x0_0x18B91_phys_0": (1_400_000_000, 1, "0x0_0x18B91"),
                "pid_2_luid_0x0_0x18B91_phys_0": (600_000_000, 2, "0x0_0x18B91")}
    got, reason = gs._vocalis_gb_bytes([0], readings, lambda i: 1)
    assert (got, reason) == ({0: 2_000_000_000}, None)


def test_two_luids_or_two_cards_fall_back_to_memory_reserved():
    two_luids = {"a": (5, 1, "0x0_0x1"), "b": (5, 1, "0x0_0x2")}
    got, reason = gs._vocalis_gb_bytes([0], two_luids, lambda i: 7)
    assert got == {0: 7} and "LUID" in reason
    one_luid = {"a": (5, 1, "0x0_0x1")}
    got, reason = gs._vocalis_gb_bytes([0, 1], one_luid, lambda i: 7)
    assert got == {0: 7, 1: 7} and reason


def test_vocalis_gb_is_clamped_to_the_whole_card(monkeypatch):
    """PDH and NVML are two reads a beat apart; our slice can land above the card's total
    used, and the header's two-color bar cannot draw that."""
    _install(monkeypatch, FakeTorch(["aaaa"]), FakeNVML([_card("aaaa", "RTX 4090", used=4)]))
    monkeypatch.setattr(gs._PDH_SAMPLER, "collect",
                        lambda: {"i": (int(4.4 * GB), 1, "0x0_0x1")})
    assert gs.sample(FakeEngine(1))["gpus"][0]["vocalis_gb"] == 4.0


class FakePDH:
    """Just enough of `win32pdh` for `PdhSampler`. `error` mirrors the real module's
    `win32pdh.error` (aliased from `pywintypes.error` — see `_pdh_module`'s own comment) so the
    narrowed `except pdh.error` in `PdhSampler` reads the same attribute off this fake that it
    would off the real module."""
    PERF_DETAIL_WIZARD, PDH_FMT_LARGE = 400, 0x400

    class error(Exception):
        pass

    def __init__(self, instances, values):
        self.instances, self.values = instances, values
        self.enumerations = 0
        self.enum_objects_calls = 0        # fix 4: EnumObjects(..., bRefresh=1) call count
        self.last_enum_objects_args = None

    def EnumObjects(self, *args):
        """Refresh PDH's cached object list before
        `EnumObjectItems` reads it. This fake has nothing to cache — it exists so `_enumerate`
        has something to call and so a test can assert it WAS called, with `bRefresh=1`."""
        self.enum_objects_calls += 1
        self.last_enum_objects_args = args
        return []

    def EnumObjectItems(self, *_a):
        self.enumerations += 1
        return ([], list(self.instances))

    def OpenQuery(self):
        return object()

    def AddCounter(self, _q, path):
        return path

    def CollectQueryData(self, _q):
        pass

    def GetFormattedCounterValue(self, h, _fmt):
        return (0, self.values[h])

    def CloseQuery(self, _q):
        pass


def test_pdh_counts_our_pid_and_the_worker_and_never_enumerates_on_a_request():
    ours, worker, stranger = 100, 200, 300
    inst = [f"pid_{p}_luid_0x00000000_0x00018B91_phys_0" for p in (ours, worker, stranger)]
    path = "\\GPU Process Memory({})\\Dedicated Usage"
    pdh = FakePDH(inst, {path.format(inst[0]): 1_000, path.format(inst[1]): 500,
                         path.format(inst[2]): 9_999})
    s = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [ours, worker])

    assert s.collect() == {}, "nothing enumerated yet: the request path returns empty, not slow"
    assert pdh.enumerations == 0, "a request must never pay the ~200 ms enumeration"

    s.tick(active=False)
    assert pdh.enumerations == 0, "no session, no enumeration"
    s.tick(active=True)
    assert pdh.enumerations == 1
    got = s.collect()
    assert sorted(b for b, _p, _l in got.values()) == [500, 1_000], "the stranger is not ours"
    for _ in range(5):
        s.collect()
    assert pdh.enumerations == 1


def test_pdh_missing_falls_back_to_memory_reserved(monkeypatch):
    _install(monkeypatch, FakeTorch(["aaaa"], reserved=2 * GB),
             FakeNVML([_card("aaaa", "RTX 4090")]))
    assert gs.sample(FakeEngine(1))["gpus"][0]["vocalis_gb"] == 2.0


def test_periodic_refresh_logs_only_on_a_changed_instance_set(monkeypatch):
    """A periodic refresh that finds the same instances repeats every `REFRESH_S` and must say
    nothing; only the first enumeration, or one whose matched instance set actually differs
    (a PID-set change here), is news."""
    ours, worker = 100, 200
    path = "\\GPU Process Memory({})\\Dedicated Usage"
    inst_ours = f"pid_{ours}_luid_0x00000000_0x00018B91_phys_0"
    inst_worker = f"pid_{worker}_luid_0x00000000_0x00018B91_phys_0"
    pdh = FakePDH([inst_ours], {path.format(inst_ours): 1_000})
    log = _DivisorLog()
    monkeypatch.setattr(gs, "logger", log)
    s = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [ours])

    s.tick(active=True)                     # first sample — the one line that must appear
    for _ in range(5):                      # several more refreshes across > REFRESH_S, no change
        # force "elapsed >= REFRESH_S" with no real sleep — `tick()`'s gate is now
        # `_last_attempt_t` (fix 3: a FAILED attempt backs off the same way, so the timer had
        # to move off `_last_enum_t`, which only a SUCCESS ever updates).
        s._last_attempt_t = 0.0
        s.tick(active=True)
    enum_lines = [m for m in log.info_lines if "PDH enumeration" in m]
    assert pdh.enumerations == 6, "every tick DID re-enumerate — only the LOGGING is throttled"
    assert len(enum_lines) == 1, "an unchanged periodic refresh must not log again"
    assert "found 1 instance(s) for pid(s) [100]" in enum_lines[0]

    # A worker PID instance appears: the matched instance set now differs, so this DOES log.
    pdh.instances.append(inst_worker)
    pdh.values[path.format(inst_worker)] = 500
    s._pid_source = lambda: [ours, worker]
    s._last_attempt_t = 0.0
    s.tick(active=True)
    enum_lines = [m for m in log.info_lines if "PDH enumeration" in m]
    assert len(enum_lines) == 2, "a new instance is news — logs exactly one more line"
    assert "found 2 instance(s) for pid(s) [100, 200] (was 1)" in enum_lines[1]


def test_enumerate_refreshes_pdhs_own_object_cache_first():
    """PDH's own object/instance list is cached until
    something refreshes it, so a model that starts loading AFTER the first enumeration — an
    idle satellite whose card only now has a process on it — would never be seen without this.
    `EnumObjects(None, None, PERF_DETAIL_WIZARD, 1)` (bRefresh=1) must run before
    `EnumObjectItems` does the real instance lookup."""
    pdh = FakePDH([], {})
    s = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [1])
    s._enumerate("test")
    assert pdh.enum_objects_calls == 1
    assert pdh.last_enum_objects_args == (None, None, pdh.PERF_DETAIL_WIZARD, 1), (
        "bRefresh must be 1 — anything else keeps reading the stale cached list")
    assert pdh.enumerations == 1, "EnumObjectItems still ran and did the real instance lookup"


def test_add_counter_failure_closes_partial_query_and_preserves_active_query():
    class PartiallyFailingPDH(FakePDH):
        def __init__(self, instances):
            super().__init__(instances, {})
            self.opened = []
            self.closed = []
            self.fail_add = False

        def OpenQuery(self):
            query = object()
            self.opened.append(query)
            return query

        def AddCounter(self, query, path):
            if self.fail_add and path.endswith("phys_1)\\Dedicated Usage"):
                raise self.error("injected AddCounter failure")
            return path

        def CloseQuery(self, query):
            self.closed.append(query)

    instances = [f"pid_100_luid_0x00000000_0x00018B91_phys_{i}" for i in range(2)]
    pdh = PartiallyFailingPDH(instances[:1])
    sampler = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [100])
    sampler._enumerate("initial")
    previous_query = sampler._hquery
    assert previous_query is pdh.opened[0]

    pdh.instances = instances
    pdh.fail_add = True
    sampler._enumerate("replacement")

    assert sampler._hquery is previous_query, "the previous working query remains installed"
    assert pdh.closed == [pdh.opened[1]], "only the incomplete replacement query is closed"


class FailingPDH:
    """Fails `EnumObjectItems` (or `OpenQuery`) on demand — fix 3's once-per-distinct-failure
    logging and `tick()`'s retry backoff need a PDH that stays broken across several calls."""
    PERF_DETAIL_WIZARD, PDH_FMT_LARGE = 400, 0x400

    class error(Exception):
        pass

    def __init__(self, message="EnumObjectItems: The handle is invalid."):
        self.fail = True
        self.message = message
        self.enum_object_items_calls = 0

    def EnumObjects(self, *_a):
        return []

    def EnumObjectItems(self, *_a):
        self.enum_object_items_calls += 1
        if self.fail:
            raise self.error(self.message)
        return ([], [])

    def OpenQuery(self):
        return object()

    def AddCounter(self, _q, path):
        return path

    def CloseQuery(self, _q):
        pass


def test_enumeration_failure_logs_once_and_recovers_once(monkeypatch):
    """A failing `EnumObjectItems` must not re-warn on
    every single retry — and `tick()` retried every second forever, because `_enumerated_pids`
    stays `None` until one succeeds (see the next test for the retry half). Now a run of
    identical failures is ONE warning, and returning to health is ONE recovery line, not one
    line per attempt either way."""
    pdh = FailingPDH()
    log = _DivisorLog()
    monkeypatch.setattr(gs, "logger", log)
    s = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [1])

    for _ in range(5):
        s._enumerate("test")
    assert pdh.enum_object_items_calls == 5, "every call DID attempt — only the LOGGING is throttled"
    fail_lines = [m for m in log.warning_lines if "PDH enumeration failed" in m]
    assert len(fail_lines) == 1, "an unchanged failure must not log again"

    pdh.fail = False
    s._enumerate("recovered")
    recovered_lines = [m for m in log.info_lines if "PDH enumeration recovered" in m]
    assert len(recovered_lines) == 1

    # A fresh failure after a recovery is news again — its own single line, not zero and not
    # one per retry.
    pdh.fail = True
    s._enumerate("test")
    s._enumerate("test")
    fail_lines = [m for m in log.warning_lines if "PDH enumeration failed" in m]
    assert len(fail_lines) == 2, "a NEW failure after a recovery logs once more"


def test_tick_backs_a_failed_enumeration_off_to_refresh_s():
    """🔴 fix 3: a failing enumeration must not be retried every tick. `tick()`'s timer now
    reads `_last_attempt_t`, set on every attempt whether it succeeds or fails, so a run of
    ticks that all land inside the same second (as these do, with no real sleep) must not
    re-attempt after the first."""
    pdh = FailingPDH()
    s = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [1])
    s.tick(active=True)
    assert pdh.enum_object_items_calls == 1
    for _ in range(5):
        s.tick(active=True)
    assert pdh.enum_object_items_calls == 1, (
        "tick() retried a failed enumeration before REFRESH_S had elapsed")


class FailingCollectPDH(FakePDH):
    """A `FakePDH` whose `CollectQueryData` can be told to fail on demand — fix 3's
    once-per-state `collect()` logging, and the `_needs_reenum` -> `tick()` wiring."""

    def __init__(self, instances, values):
        super().__init__(instances, values)
        self.fail_collect = False

    def CollectQueryData(self, _q):
        if self.fail_collect:
            raise self.error("CollectQueryData: the query handle is no longer valid.")


def test_collect_failure_logs_once_marks_reenum_and_recovers_once(monkeypatch):
    """🔴 fix 3: 'PDH collect failed' used to log on every one of the 4 Hz request-path calls.
    Now it is one line per distinct failing state, the failure marks the sampler for
    re-enumeration (`_needs_reenum`) rather than collect() retrying the same broken query
    forever, `tick()` — never the request — honors that mark, and a clean read afterward logs
    recovery exactly once."""
    ours = 100
    inst = f"pid_{ours}_luid_0x00000000_0x00018B91_phys_0"
    path = "\\GPU Process Memory({})\\Dedicated Usage"
    pdh = FailingCollectPDH([inst], {path.format(inst): 1_000})
    log = _DivisorLog()
    monkeypatch.setattr(gs, "logger", log)
    s = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [ours])
    s.tick(active=True)
    assert pdh.enumerations == 1

    pdh.fail_collect = True
    for _ in range(5):
        assert s.collect() == {}, "a failing collect must return empty, not raise"
    fail_lines = [m for m in log.warning_lines if "PDH collect failed" in m]
    assert len(fail_lines) == 1, "an unchanged collect failure must not log again"
    assert s._needs_reenum, "a collect failure marks the sampler for re-enumeration"

    # tick() honors the mark immediately, off the request path, ahead of REFRESH_S.
    s.tick(active=True)
    assert pdh.enumerations == 2, "the failure's re-enumeration request was not honored by tick()"

    pdh.fail_collect = False
    got = s.collect()
    assert got, "collect() must read cleanly again once the query is healthy"
    recovered_lines = [m for m in log.info_lines if "PDH reads recovered" in m]
    assert len(recovered_lines) == 1


class FakeSlowPDH:
    """A `FakePDH` whose `CollectQueryData` signals it has started and then blocks until
    released — giving a second thread a real, deterministic window to attempt a concurrent
    close. `CloseQuery` marks the handle dead; `CollectQueryData` checks deadness AFTER the
    block, the same shape the real race takes (the native read happens once the OS hands the
    thread the CPU back, not at the moment it was scheduled to run)."""
    PERF_DETAIL_WIZARD, PDH_FMT_LARGE = 400, 0x400

    class error(Exception):
        pass

    def __init__(self, collecting_now, allow_close):
        self._next_handle = 0
        self.dead = set()
        self.collecting_now = collecting_now
        self.allow_close = allow_close
        self.instances = ["pid_1_luid_0x0_0x1_phys_0"]

    def EnumObjects(self, *_a):
        return []

    def EnumObjectItems(self, *_a):
        return ([], list(self.instances))

    def OpenQuery(self):
        self._next_handle += 1
        return self._next_handle

    def AddCounter(self, hquery, path):
        return (hquery, path)          # the counter is tied to the query that made it

    def CollectQueryData(self, hquery):
        self.collecting_now.set()
        self.allow_close.wait(timeout=2.0)
        if hquery in self.dead:
            raise self.error(f"handle {hquery} is closed — use-after-close")

    def GetFormattedCounterValue(self, hcounter, _fmt):
        hquery, _path = hcounter
        if hquery in self.dead:
            raise self.error(f"handle {hquery} is closed — use-after-close")
        return (0, 777)

    def CloseQuery(self, hquery):
        self.dead.add(hquery)


def test_collect_cannot_race_a_concurrent_close():
    """🔴 fix 1, THE USE-AFTER-CLOSE RACE. Before the fix, `collect()` copied the query handle
    under `self._lock`, released the lock, and only THEN called `CollectQueryData` /
    `GetFormattedCounterValue` — so `_enumerate`, running on the housekeeping thread, could swap
    in a new query and `CloseQuery` the OLD one while `collect()` was still mid-read on it. This
    drives real threads because the race is a genuine ordering race between two threads: a
    single thread cannot reproduce it, only demonstrate the lock's absence or presence.

    With the fix, `_enumerate`'s swap-and-close and `collect()`'s whole read share one lock, so
    the close cannot land until `collect()` releases it — this test fails (the old query is
    dead before `collect()` finishes) if that is not true."""
    collecting_now = threading.Event()
    allow_close = threading.Event()
    pdh = FakeSlowPDH(collecting_now, allow_close)
    s = gs.PdhSampler(pdh_loader=lambda: pdh, pid_source=lambda: [1])
    s.tick(active=True)                       # opens the first query
    first_hquery = s._hquery

    result = {}

    def _collect():
        result["got"] = s.collect()

    collector = threading.Thread(target=_collect, name="collector")
    collector.start()
    assert collecting_now.wait(timeout=2.0), "collect() never reached CollectQueryData"

    # Simulate the housekeeping thread re-enumerating and closing the OLD query WHILE the
    # collector is mid-collect — a different instance forces `_enumerate` to open a new query.
    pdh.instances = ["pid_1_luid_0x0_0x2_phys_0"]
    enumerate_done = threading.Event()

    def _enumerate_again():
        s._enumerate("concurrent re-enumeration")
        enumerate_done.set()

    enumerator = threading.Thread(target=_enumerate_again, name="enumerator")
    enumerator.start()
    # Give the enumerator every chance to race ahead if the lock were not held for the whole
    # collect — it must NOT have closed the old query yet.
    enumerate_done.wait(timeout=0.2)
    assert first_hquery not in pdh.dead, (
        "the old query was closed while collect() still held it — collect() is not holding "
        "the lock across the whole PDH call")

    allow_close.set()
    collector.join(timeout=2.0)
    enumerator.join(timeout=2.0)
    assert not collector.is_alive() and not enumerator.is_alive(), "a thread never finished"
    assert result.get("got"), "collect() must have returned real data, not raced into an error"


# ── the console: the session, never the poll ─────────────────────────────────

class _Log:
    def __init__(self):
        self.lines = []

    def info(self, m):
        self.lines.append(m)


def test_started_and_stopped_once_each_for_a_burst():
    clock = {"t": 0.0}
    log = _Log()
    t = gs.PollTracker(clock=lambda: clock["t"], log=log)
    for _ in range(40):                         # ten seconds at 4 Hz
        t.note_poll("192.0.2.10")
        t.tick()
        clock["t"] += 0.25
    assert log.lines == ["stats polling started — 192.0.2.10"], "nothing per poll"
    clock["t"] += 3.0
    t.tick()
    assert len(log.lines) == 2
    assert log.lines[1].startswith("stats polling stopped — 192.0.2.10")
    assert "40 polls" in log.lines[1]
    t.tick()
    assert len(log.lines) == 2, "stopped is said once"
    t.note_poll("192.0.2.10")
    assert log.lines[-1] == "stats polling started — 192.0.2.10"


def test_the_access_line_is_swallowed_for_a_200_and_kept_for_a_401():
    import loguru
    import logging
    import server

    h = server._WerkzeugToLoguru()

    def _emit(msg):
        sent = []
        real_log, real_debug = loguru.logger.log, loguru.logger.debug
        try:
            loguru.logger.log = lambda lvl, m: sent.append(m)
            loguru.logger.debug = lambda m: None
            h.emit(logging.LogRecord("werkzeug", 20, __file__, 1, msg, None, None))
        finally:
            loguru.logger.log, loguru.logger.debug = real_log, real_debug
        return sent

    line = '192.0.2.182 - - [18/Sep/2026 13:00:00] "POST /satellite/gpustats HTTP/1.1" {} -'
    assert _emit(line.format("200")) == []
    assert len(_emit(line.format("401"))) == 1


# ── the route ────────────────────────────────────────────────────────────────

def test_the_route_answers_sealed_and_health_advertises_it(monkeypatch):
    import server

    master = proto.new_master()
    monkeypatch.setattr(server, "_MASTER", master)
    monkeypatch.setattr(server, "ENGINE", FakeEngine(1))
    monkeypatch.setattr(server.gpustats, "note_poll", lambda ip: None)
    _install(monkeypatch, FakeTorch(["aaaa"]), FakeNVML([_card("aaaa", "RTX 4090")]))
    server.app.config["TESTING"] = True

    salt = proto.new_salt()
    k2s = proto.derive_key(master, salt, proto.DIR_TO_SATELLITE)
    s2k = proto.derive_key(master, salt, proto.DIR_TO_SERVER)
    r = server.app.test_client().post(
        "/satellite/gpustats", data=proto.seal_bytes(k2s, b"{}"),
        headers={"X-Vocalis-Salt": salt.hex(), "Content-Type": "application/octet-stream"})
    assert r.status_code == 200
    body = json.loads(proto.open_bytes(s2k, r.get_data()))
    assert body["gpus"][0]["name"] == "RTX 4090"

    r = server.app.test_client().post("/satellite/gpustats", data=b"{}")
    assert r.status_code != 200, "unsealed is refused, like every verb"

    assert server.SATELLITE_VERSION == "2.1.1"
