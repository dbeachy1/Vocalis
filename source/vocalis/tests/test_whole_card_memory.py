"""Whole-card memory and readings on NVIDIA (design section 10, added October 10, 2026).

On Windows PyTorch's free-memory number does not see other programs (the Windows NVIDIA test machine, RTX 4090: with another
process holding 4 GiB, `torch.cuda.mem_get_info` still said 22,988 MiB free while NVML went from
10,216 to 5,670 MiB free). So there is one answer to "how much of this card is used, in total":
AMD's sysfs sensor where it exists, otherwise the NVIDIA driver through NVML matched to PyTorch's
card by UUID, otherwise PyTorch's own number.

This file covers the readout module's new entry point (`whole_card`), the main server's reader
order (`tts_utils.vram_used_total`), the NVIDIA sensor readers, and `gpu_stats` for an NVIDIA card.
The satellite's own use of the same number is in `test_whole_card_memory_satellite.py`.

No real GPU and no real NVML: the stand-in NVML and torch are the ones `test_satellite_gpustats.py`
already uses. Time is an injected clock; nothing sleeps.
"""
import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# conftest has already put `src` on sys.path; the satellite folder is added here, and the modules
# are loaded by name afterwards (not with import statements below code, which the lint-ignore
# ratchet in test_webui_types.py would count).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "satellite"))
gs = importlib.import_module("vocalis_satellite_gpustats")
tu = importlib.import_module("tts_utils")
gpu_mod = importlib.import_module("vocalis.runtime.gpu")
_sat_tests = importlib.import_module("test_satellite_gpustats")
FakeNVML, FakeTorch, _card = _sat_tests.FakeNVML, _sat_tests.FakeTorch, _sat_tests._card

GB = 1024 ** 3


class CudaTorch(FakeTorch):
    """`FakeTorch` that says it is a CUDA build, which is what lets NVML be consulted."""
    version = SimpleNamespace(cuda="12.4", hip=None)


class RocmTorch(FakeTorch):
    version = SimpleNamespace(cuda=None, hip="7.2")


class CpuTorch(FakeTorch):
    version = SimpleNamespace(cuda=None, hip=None)


class Log:
    """Just enough of `loguru.logger` to see what is said and how often."""

    def __init__(self):
        self.info_lines, self.warning_lines = [], []

    def info(self, m):
        self.info_lines.append(m)

    def warning(self, m):
        self.warning_lines.append(m)

    def debug(self, m):
        pass


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch):
    """Every once-only cache and retry stamp in the readout module, reset per test, and a clock
    that only moves when the test moves it."""
    for name, value in (("_NVML", None), ("_NVML_UNAVAILABLE_LOGGED", False),
                        ("_NVML_RETRY_AT", None), ("_MAPPING", None), ("_MAPPING_RETRY_AT", None),
                        ("_MAPPING_FAILURE_LOGGED", False), ("_MAPPING_FALLBACK_LOGGED", set()),
                        ("_HANDLE_WARNED", set()), ("_CARD_ACTIVE_LOGGED", set()),
                        ("_CARD_CACHE", {}), ("_FIELD_WARNED", set()), ("_MCLK_DIVISOR", {})):
        monkeypatch.setattr(gs, name, value)
    monkeypatch.setattr(gs, "_PDH_SAMPLER", gs.PdhSampler(pdh_loader=lambda: None))
    monkeypatch.setattr(tu, "_NVML_CALL_WARNED", False)
    clock = Clock()
    monkeypatch.setattr(gs, "_clock", clock)
    return clock


@pytest.fixture
def clock(_fresh_state):
    return _fresh_state


@pytest.fixture
def log(monkeypatch):
    lg = Log()
    monkeypatch.setattr(gs, "logger", lg)
    return lg


class CountingNVML(FakeNVML):
    """`FakeNVML` that counts its calls and checks that no lock is held while a field is read."""

    def __init__(self, cards):
        super().__init__(cards)
        self.init_calls = 0
        self.count_calls = 0
        self.memory_calls = 0
        self.fail_init = False
        self.fail_count = False
        self.lock_held_during_read = []

    def nvmlInit(self):
        self.init_calls += 1
        if self.fail_init:
            raise self.NVMLError("Driver Not Loaded")

    def nvmlDeviceGetCount(self):
        self.count_calls += 1
        if self.fail_count:
            raise self.NVMLError("Unknown Error")
        return super().nvmlDeviceGetCount()

    def nvmlDeviceGetMemoryInfo(self, h):
        self.memory_calls += 1
        self.lock_held_during_read.append(gs._INIT_LOCK.locked())
        return super().nvmlDeviceGetMemoryInfo(h)

    def nvmlDeviceGetTemperature(self, h, which):
        self.lock_held_during_read.append(gs._INIT_LOCK.locked())
        return super().nvmlDeviceGetTemperature(h, which)


class RecordingNVML(CountingNVML):
    """`CountingNVML` that also records the name of every per-field call, in order."""

    FIELD_CALLS = ("nvmlDeviceGetName", "nvmlDeviceGetMemoryInfo", "nvmlDeviceGetUtilizationRates",
                   "nvmlDeviceGetClockInfo", "nvmlDeviceGetMaxClockInfo",
                   "nvmlDeviceGetPowerUsage", "nvmlDeviceGetTemperature", "nvmlDeviceGetFanSpeed")

    def __init__(self, cards):
        super().__init__(cards)
        self.calls = []


def _record(cls, name):
    original = getattr(cls, name)

    def wrapper(self, *a, **k):
        self.calls.append(name)
        return original(self, *a, **k)

    setattr(cls, name, wrapper)


for _name in RecordingNVML.FIELD_CALLS:
    _record(RecordingNVML, _name)


def _install(monkeypatch, torch, nvml):
    """`torch` as PyTorch and `nvml` as the `pynvml` the readout module imports."""
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "pynvml", nvml)
    monkeypatch.setattr(gpu_mod, "torch", torch)


# ── the entry point: one card, no engine ────────────────────────────────────

def test_whole_card_returns_every_field_for_a_cuda_index(monkeypatch):
    _install(monkeypatch, CudaTorch(["aaaa"]), CountingNVML([_card("AAAA", "RTX 4090", used=9)]))
    c = gs.whole_card(0)
    assert c == {"name": "RTX 4090", "total_bytes": 24 * GB, "used_bytes": 9 * GB,
                 "util_pct": 11, "sclk_mhz": 345, "mclk_mhz": 1313,
                 "power_w": 70, "temp_c": 51, "fan_pct": 0}, (
        "memory comes back in UNROUNDED bytes; everything else in the satellite entry's units")


def test_the_uuid_decides_not_the_index_order(monkeypatch):
    """CUDA orders fastest-first, NVML by PCI bus: `cuda:0` must read the card whose UUID it
    has."""
    nvml = CountingNVML([_card("bbbb", "RTX 3060", used=2), _card("aaaa", "RTX 4090", used=9)])
    _install(monkeypatch, CudaTorch(["aaaa", "bbbb"]), nvml)
    assert (gs.whole_card(0)["name"], gs.whole_card(0)["used_bytes"]) == ("RTX 4090", 9 * GB)
    assert (gs.whole_card(1)["name"], gs.whole_card(1)["used_bytes"]) == ("RTX 3060", 2 * GB)


def test_a_card_with_no_uuid_match_has_no_fields_and_a_warning_once(monkeypatch, log):
    """Two cards on each side and no shared UUID (an unreadable UUID with several cards, or a MIG
    device): that card reports nothing, the caller uses PyTorch's number, and the warning is once
    per card however often it is asked."""
    nvml = CountingNVML([_card("xxxx", "A"), _card("yyyy", "B")])
    _install(monkeypatch, CudaTorch(["aaaa", "bbbb"]), nvml)
    for _ in range(3):
        assert gs.whole_card(0) is None
        assert gs.whole_card(1) is None
    no_match = [m for m in log.warning_lines if "no NVML match" in m]
    assert sorted(no_match) == ["gpustats: cuda:0 has no NVML match — GPU fields unavailable",
                                "gpustats: cuda:1 has no NVML match — GPU fields unavailable"]


def test_one_card_each_side_is_paired_without_a_uuid_match(monkeypatch):
    """The existing single-card fallback still holds for the new entry point."""
    _install(monkeypatch, CudaTorch(["x"]), CountingNVML([_card("y", "RTX 4090")]))
    assert gs.whole_card(0)["name"] == "RTX 4090"


def test_an_unsupported_fan_blanks_that_field_only(monkeypatch):
    _install(monkeypatch, CudaTorch(["aaaa"]),
             CountingNVML([_card("aaaa", "laptop", fan=None)]))
    c = gs.whole_card(0)
    assert c["fan_pct"] is None
    assert c["temp_c"] == 51 and c["util_pct"] == 11 and c["used_bytes"] == 4 * GB


def test_a_failed_memory_read_leaves_the_bytes_none_and_the_sensors_alone(monkeypatch):
    class NoMem(CountingNVML):
        def nvmlDeviceGetMemoryInfo(self, h):
            raise self.NVMLError("Not Supported")

    _install(monkeypatch, CudaTorch(["aaaa"]), NoMem([_card("aaaa", "RTX 4090")]))
    c = gs.whole_card(0)
    assert c["total_bytes"] is None and c["used_bytes"] is None
    assert c["temp_c"] == 51


def test_memory_only_makes_the_memory_call_and_none_of_the_sensor_calls(monkeypatch):
    nvml = RecordingNVML([_card("aaaa", "RTX 4090", used=9)])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    c = gs.whole_card(0, memory_only=True)
    assert c == {"name": "RTX 4090", "total_bytes": 24 * GB, "used_bytes": 9 * GB}
    assert nvml.calls == ["nvmlDeviceGetMemoryInfo", "nvmlDeviceGetName"], nvml.calls


def test_the_full_mode_still_reads_every_sensor(monkeypatch):
    nvml = RecordingNVML([_card("aaaa", "RTX 4090")])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    gs.whole_card(0)
    assert set(nvml.calls) == set(RecordingNVML.FIELD_CALLS)


def test_memory_only_follows_the_same_failure_and_retry_rules(monkeypatch, log, clock):
    """A failed start, a failed mapping, a missing package and a card with no match behave the
    same in both modes."""
    nvml = RecordingNVML([_card("aaaa", "RTX 4090")])
    nvml.fail_init = True
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    assert gs.whole_card(0, memory_only=True) is None
    clock.t += 30
    assert gs.whole_card(0) is None, "the full mode shares the remembered failure"
    assert nvml.init_calls == 1
    clock.t += 31
    nvml.fail_init = False
    nvml.fail_count = True
    assert gs.whole_card(0, memory_only=True) is None          # mapping fails
    assert gs.whole_card(0) is None and nvml.count_calls == 1
    clock.t += 61
    nvml.fail_count = False
    assert gs.whole_card(0, memory_only=True)["used_bytes"] == 4 * GB
    no_match = RecordingNVML([_card("xxxx", "A"), _card("yyyy", "B")])
    _install(monkeypatch, CudaTorch(["aaaa", "bbbb"]), no_match)
    monkeypatch.setattr(gs, "_MAPPING", None)
    monkeypatch.setattr(gs, "_NVML", None)
    assert gs.whole_card(0, memory_only=True) is None
    assert gs.whole_card(0, memory_only=True) is None
    assert len([m for m in log.warning_lines if "cuda:0 has no NVML match" in m]) == 1


def test_a_memory_failure_in_memory_only_mode_leaves_the_bytes_none(monkeypatch):
    class NoMem(RecordingNVML):
        def nvmlDeviceGetMemoryInfo(self, h):
            raise self.NVMLError("Not Supported")

    _install(monkeypatch, CudaTorch(["aaaa"]), NoMem([_card("aaaa", "RTX 4090")]))
    assert gs.whole_card(0, memory_only=True) == {"name": "RTX 4090", "total_bytes": None,
                                                  "used_bytes": None}


def test_memory_only_is_not_cached_and_a_fresh_full_read_answers_it(monkeypatch, clock):
    nvml = RecordingNVML([_card("aaaa", "RTX 4090")])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    gs.whole_card(0, max_age_s=0.5, memory_only=True)
    gs.whole_card(0, max_age_s=0.5, memory_only=True)
    assert nvml.calls.count("nvmlDeviceGetMemoryInfo") == 2, "a memory-only read was cached"
    assert "nvmlDeviceGetTemperature" not in nvml.calls
    gs.whole_card(0)                                           # a full read, then reused
    nvml.calls.clear()
    c = gs.whole_card(0, max_age_s=0.5, memory_only=True)
    assert nvml.calls == [] and set(c) == {"name", "total_bytes", "used_bytes"}


def test_the_memory_questions_ask_for_the_memory_only_mode(monkeypatch):
    """`vram_used_total` (and so the satellite's `free_gb` through `device_mem_gb`) must not pay
    for the sensors."""
    nvml = RecordingNVML([_card("aaaa", "RTX 4090", used=18)])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    assert tu.vram_used_total("cuda:0") == (18 * GB, 24 * GB)
    assert nvml.calls == ["nvmlDeviceGetMemoryInfo", "nvmlDeviceGetName"], nvml.calls


def test_the_init_lock_is_not_held_across_field_reads(monkeypatch):
    nvml = CountingNVML([_card("aaaa", "RTX 4090")])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    gs.whole_card(0)
    assert nvml.lock_held_during_read == [False, False], (
        "a slow driver answer on one thread must not stall every other reader")


# ── NVML is consulted only when PyTorch is a CUDA build ──────────────────────

@pytest.mark.parametrize("torch_cls", [RocmTorch, CpuTorch])
def test_nvml_is_untouched_on_a_build_that_is_not_cuda(monkeypatch, log, torch_cls):
    nvml = CountingNVML([_card("aaaa", "RTX 4090")])
    _install(monkeypatch, torch_cls(["aaaa"]), nvml)
    assert gs.whole_card(0) is None
    assert nvml.init_calls == 0 and nvml.count_calls == 0 and nvml.memory_calls == 0
    assert log.warning_lines == [] and log.info_lines == []


def test_the_amd_image_never_logs_that_the_package_is_missing(monkeypatch, log):
    """`pynvml` is absent from the AMD images; on a ROCm build it must not even be looked for."""
    _install(monkeypatch, RocmTorch(["aaaa"]), None)        # None in sys.modules: ImportError
    for _ in range(3):
        assert gs.whole_card(0) is None
    assert log.warning_lines == []


# ── a missing module, a failed start, a failed mapping: remembered, retried at most per minute ──

def test_a_missing_module_is_retried_after_a_minute_and_logged_once(monkeypatch, log, clock):
    _install(monkeypatch, CudaTorch(["aaaa"]), None)
    assert gs.whole_card(0) is None
    clock.t += 30
    assert gs.whole_card(0) is None
    assert len([m for m in log.warning_lines if "not installed" in m]) == 1
    # The package appears (an install in the middle of a run): found at the first retry.
    monkeypatch.setitem(sys.modules, "pynvml", CountingNVML([_card("aaaa", "RTX 4090")]))
    assert gs.whole_card(0) is None, "30 s after the failure: not asked again yet"
    clock.t += 31                                             # 61 s after the failure
    assert gs.whole_card(0)["name"] == "RTX 4090"
    assert [m for m in log.info_lines if "NVML initialized" in m]


def test_a_failed_start_is_retried_after_a_minute_not_before(monkeypatch, log, clock):
    nvml = CountingNVML([_card("aaaa", "RTX 4090")])
    nvml.fail_init = True
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    assert gs.whole_card(0) is None
    assert nvml.init_calls == 1
    clock.t += 59.9
    assert gs.whole_card(0) is None
    assert nvml.init_calls == 1, "retried before the minute was up (today it retries every call)"
    clock.t += 0.2
    assert gs.whole_card(0) is None
    assert nvml.init_calls == 2, "not retried once the minute was up"
    assert len([m for m in log.warning_lines if "nvmlInit() failed" in m]) == 1, "logged once"
    nvml.fail_init = False
    clock.t += 60.1
    assert gs.whole_card(0)["name"] == "RTX 4090"
    assert nvml.init_calls == 3


def test_a_failed_mapping_is_retried_after_a_minute_not_kept_for_the_process(
        monkeypatch, log, clock):
    nvml = CountingNVML([_card("aaaa", "RTX 4090")])
    nvml.fail_count = True
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    assert gs.whole_card(0) is None
    assert nvml.count_calls == 1
    clock.t += 30
    assert gs.whole_card(0) is None
    assert nvml.count_calls == 1, "retried inside the minute"
    clock.t += 31
    assert gs.whole_card(0) is None
    assert nvml.count_calls == 2
    assert len([m for m in log.warning_lines if "mapping failed" in m]) == 1, "logged once"
    # A failed mapping is not a "no match" for the card: that warning is for a resolved mapping.
    assert not [m for m in log.warning_lines if "no NVML match" in m]
    nvml.fail_count = False
    clock.t += 61
    assert gs.whole_card(0)["used_bytes"] == 4 * GB, "the old code kept the failure for good"


def test_the_satellite_sample_also_recovers_from_a_failed_mapping(monkeypatch, clock):
    """`sample()` shares the same mapping; it used to cache an all-None answer permanently."""
    nvml = CountingNVML([_card("aaaa", "RTX 4090")])
    nvml.fail_count = True
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    engine = SimpleNamespace(available_devices=lambda: ["cuda:0"])
    assert gs.sample(engine)["gpus"][0]["name"] is None
    nvml.fail_count = False
    clock.t += 61
    assert gs.sample(engine)["gpus"][0]["name"] == "RTX 4090"


def test_a_cached_read_is_reused_inside_max_age_and_refreshed_after(monkeypatch, clock):
    """`gpu_stats` asks for memory and then five sensors a few milliseconds apart; one NVML pass
    answers all six."""
    nvml = CountingNVML([_card("aaaa", "RTX 4090")])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    gs.whole_card(0)
    gs.whole_card(0, max_age_s=0.5)
    clock.t += 0.4
    gs.whole_card(0, max_age_s=0.5)
    assert nvml.memory_calls == 1
    clock.t += 0.2
    gs.whole_card(0, max_age_s=0.5)
    assert nvml.memory_calls == 2
    gs.whole_card(0)
    assert nvml.memory_calls == 3, "max_age_s=0 always reads"


# ── not Windows: no Windows repair advice, no pywin32 warning ────────────────

def test_on_linux_the_missing_package_warning_has_no_windows_advice(monkeypatch, log):
    monkeypatch.setattr(gs, "_IS_WINDOWS", False)
    _install(monkeypatch, CudaTorch(["aaaa"]), None)
    gs.whole_card(0)
    assert len(log.warning_lines) == 1
    assert "nvidia-ml-py is not installed" in log.warning_lines[0]
    assert "Scripts" not in log.warning_lines[0] and "pywin32" not in log.warning_lines[0]


def test_on_windows_the_missing_package_warning_keeps_its_repair_advice(monkeypatch, log):
    monkeypatch.setattr(gs, "_IS_WINDOWS", True)
    _install(monkeypatch, CudaTorch(["aaaa"]), None)
    gs.whole_card(0)
    assert "venv\\Scripts\\pip install nvidia-ml-py pywin32" in log.warning_lines[0]


def test_on_linux_pdh_being_absent_is_not_warned_about(monkeypatch, log):
    monkeypatch.setattr(gs, "_IS_WINDOWS", False)
    monkeypatch.setattr(gs, "_PDH", None)
    monkeypatch.setattr(gs, "_PDH_UNAVAILABLE_LOGGED", False)
    assert gs._pdh_module() is None
    assert log.warning_lines == []
    assert gs._PDH_UNAVAILABLE_LOGGED is False


# ── the main server's reader: the order of the three sources ─────────────────

def test_the_amd_sensor_wins_and_nvml_is_not_asked(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "get_device_properties",
                        lambda i: SimpleNamespace(pci_bus_id=3, pci_domain_id=0))
    monkeypatch.setattr(tu, "_amd_sysfs_vram_by_pci", lambda dom, bus: (29 * GB, 32 * GB))
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda i: (28 * GB, 32 * GB))
    asked = []
    monkeypatch.setattr(gs, "whole_card", lambda *a, **k: asked.append(a) or None)
    assert tu.vram_used_total("cuda:0") == (29 * GB, 32 * GB)
    assert asked == [], "NVML was consulted although the AMD sensor answered"


def test_nvml_comes_second_before_pytorchs_number(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda i: SimpleNamespace())
    # The Windows NVIDIA test machine, October 10: PyTorch says 22,988 MiB free; the driver says 5,670.
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda i: (22988 * 2**20, 24 * GB))
    monkeypatch.setattr(gs, "whole_card", lambda idx, **k: {
        "total_bytes": 24 * GB, "used_bytes": 24 * GB - 5670 * 2**20})
    used, total = tu.vram_used_total("cuda:0")
    assert (total - used) // 2**20 == 5670, "PyTorch's inflated number was used"
    free_gb, total_gb = tu.device_mem_gb("cuda:0")
    assert round(free_gb * 1024) == 5670 and total_gb == 24.0


def test_pytorchs_number_is_last_when_nvml_cannot_answer(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda i: SimpleNamespace())
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda i: (2 * GB, 10 * GB))
    monkeypatch.setattr(gs, "whole_card", lambda idx, **k: None)
    assert tu.vram_used_total("cuda:0") == (8 * GB, 10 * GB)
    # A card NVML answered for but whose memory read failed counts as "cannot answer".
    monkeypatch.setattr(gs, "whole_card", lambda idx, **k: {"total_bytes": None,
                                                            "used_bytes": None})
    assert tu.vram_used_total("cuda:0") == (8 * GB, 10 * GB)


def test_a_process_that_cannot_import_the_readout_module_falls_through_silently(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda i: SimpleNamespace())
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda i: (2 * GB, 10 * GB))
    monkeypatch.setitem(sys.modules, "vocalis_satellite_gpustats", None)      # ImportError
    lg = Log()
    monkeypatch.setattr(tu, "logger", lg)
    assert tu.vram_used_total("cuda:0") == (8 * GB, 10 * GB)
    assert tu.gpu_temp_c(0) is None and tu.gpu_fan_pct(0) is None
    assert lg.warning_lines == [] and lg.info_lines == []


def test_a_surprise_from_the_readout_module_is_logged_once_and_falls_through(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda i: SimpleNamespace())
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda i: (2 * GB, 10 * GB))

    def boom(idx, **k):
        raise ValueError("driver answered nonsense")

    monkeypatch.setattr(gs, "whole_card", boom)
    lg = Log()
    monkeypatch.setattr(tu, "logger", lg)
    for _ in range(3):
        assert tu.vram_used_total("cuda:0") == (8 * GB, 10 * GB)
    assert len(lg.warning_lines) == 1 and "driver answered nonsense" in lg.warning_lines[0]


def test_the_whole_chain_with_the_stand_in_nvml(monkeypatch):
    """The three pieces together: PyTorch (a CUDA build), the stand-in NVML, the real readout
    module and the real reader."""
    nvml = CountingNVML([_card("aaaa", "RTX 4090", used=18)])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    assert tu.vram_used_total("cuda:0") == (18 * GB, 24 * GB)
    assert tu.device_mem_gb("cuda:0") == (6.0, 24.0)


# ── the NVIDIA sensors: NVML only where the AMD sensor does not exist ─────────

def test_the_sensor_readers_return_the_nvml_values_when_there_is_no_amd_sensor(monkeypatch):
    _install(monkeypatch, CudaTorch(["aaaa"]), CountingNVML([_card("aaaa", "RTX 4090")]))
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)
    assert tu.gpu_util_percent(0) == 11
    assert tu.gpu_temp_c(0) == 51
    assert tu.gpu_power_w(0) == 70
    assert tu.gpu_clocks_mhz(0) == (345, 1313)
    assert tu.gpu_fan_pct(0) == 0


def test_each_nvidia_sensor_is_individually_none_when_the_driver_lacks_it(monkeypatch):
    _install(monkeypatch, CudaTorch(["aaaa"]),
             CountingNVML([_card("aaaa", "laptop", fan=None, mclk_max=None)]))
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)
    assert tu.gpu_fan_pct(0) is None
    assert tu.gpu_clocks_mhz(0) == (345, None), "only the memory clock is unreadable"
    assert tu.gpu_temp_c(0) == 51


def test_an_amd_sensor_still_wins_over_nvml(tmp_path, monkeypatch):
    nvml = CountingNVML([_card("aaaa", "RTX 4090")])
    _install(monkeypatch, CudaTorch(["aaaa"]), nvml)
    hw = tmp_path / "hwmon0"
    hw.mkdir()
    (hw / "temp1_input").write_text("65000\n")
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: str(hw))
    assert tu.gpu_temp_c(0) == 65
    assert tu.gpu_power_w(0) == 70, "no AMD power file: the NVML value fills in that field only"


def test_on_a_rocm_build_the_sensor_readers_do_not_reach_nvml(monkeypatch):
    nvml = CountingNVML([_card("aaaa", "x")])
    _install(monkeypatch, RocmTorch(["aaaa"]), nvml)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)
    assert tu.gpu_temp_c(0) is None and tu.gpu_fan_pct(0) is None
    assert tu.gpu_clocks_mhz(0) == (None, None)
    assert nvml.init_calls == 0


# ── gpu_stats for an NVIDIA card ─────────────────────────────────────────────

def test_gpu_stats_fills_busy_temperature_power_clocks_and_fan_for_an_nvidia_card(monkeypatch):
    nvml = CountingNVML([_card("aaaa", "RTX 4090", used=9)])
    torch = CudaTorch(["aaaa"], names=["NVIDIA GeForce RTX 4090"])
    _install(monkeypatch, torch, nvml)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)
    g = gpu_mod.gpu_stats()[0]
    assert g["name"] == "NVIDIA GeForce RTX 4090"
    assert (g["total_gb"], g["used_gb"], g["free_gb"]) == (24.0, 9.0, 15.0)
    assert (g["util_pct"], g["temp_c"], g["power_w"]) == (11, 51, 70)
    assert (g["sclk_mhz"], g["mclk_mhz"], g["fan_pct"]) == (345, 1313, 0)


def test_gpu_stats_costs_one_nvml_pass_per_card_not_six(monkeypatch):
    """`gpu_stats` runs about once a second per card and reads six values per card."""
    nvml = CountingNVML([_card("aaaa", "A"), _card("bbbb", "B")])
    _install(monkeypatch, CudaTorch(["aaaa", "bbbb"]), nvml)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)
    gpu_mod.gpu_stats()
    assert nvml.memory_calls == 2, f"{nvml.memory_calls} memory reads for 2 cards"


def test_gpu_stats_leaves_an_unmatched_card_with_none_sensors(monkeypatch):
    nvml = CountingNVML([_card("xxxx", "A"), _card("yyyy", "B")])
    _install(monkeypatch, CudaTorch(["aaaa", "bbbb"]), nvml)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)
    for g in gpu_mod.gpu_stats():
        assert g["util_pct"] is None and g["temp_c"] is None and g["power_w"] is None
        assert (g["sclk_mhz"], g["mclk_mhz"], g["fan_pct"]) == (None, None, None)
        assert g["total_gb"] == 24.0, "memory still comes from PyTorch's number"
