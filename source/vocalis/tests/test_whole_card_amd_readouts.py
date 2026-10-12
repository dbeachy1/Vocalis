"""An AMD (ROCm) satellite fills its card readouts from the package's own readers.

The AMD Linux test machine, October 10, 2026: two Radeon AI PRO R9700 behind the satellite image sent every card readout
as null on `/satellite/gpustats` (NVML has no handle for an AMD card), so the Vocalis header showed
the cards as "0.0 / 0.0 GB" with no name. The same container's `tts_utils` readers all answered.
`vocalis_gb` stays as it was and stays clamped to `used_gb`.

Stand-in readers and a stand-in PyTorch only: no GPU, no NVML.
"""
import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "satellite"))
gs = importlib.import_module("vocalis_satellite_gpustats")
_sat = importlib.import_module("test_satellite_gpustats")
FakeNVML, FakeTorch, FakeEngine, _card, KEYS = (
    _sat.FakeNVML, _sat.FakeTorch, _sat.FakeEngine, _sat._card, _sat.KEYS)

GB = 1024 ** 3


class RocmTorch(FakeTorch):
    version = SimpleNamespace(cuda=None, hip="7.14")


class CudaTorch(FakeTorch):
    version = SimpleNamespace(cuda="12.4", hip=None)


class Log:
    def __init__(self):
        self.info_lines, self.warning_lines = [], []

    def info(self, m):
        self.info_lines.append(m)

    def warning(self, m):
        self.warning_lines.append(m)

    def debug(self, m):
        pass


def readers(**over):
    """Stand-ins for the package's six readers; `over` replaces any of them. Every call is
    recorded in `.calls`."""
    calls = []

    def rec(name, fn):
        def wrapper(*a):
            calls.append((name, a))
            return fn(*a)
        return wrapper

    table = {
        "vram_used_total_sensor": lambda i: (int(13.2 * GB), int(31.9 * GB)),
        "gpu_util_percent": lambda i: 4,
        "gpu_temp_c": lambda i: 45,
        "gpu_power_w": lambda i: 18,
        "gpu_clocks_mhz": lambda i: (117, 96),
        "gpu_fan_pct": lambda i: 20,
    }
    table.update(over)
    ns = SimpleNamespace(**{n: rec(n, f) for n, f in table.items()})
    ns.calls = calls
    return ns


@pytest.fixture
def log(monkeypatch):
    lg = Log()
    monkeypatch.setattr(gs, "logger", lg)
    return lg


@pytest.fixture(autouse=True)
def _no_pdh(monkeypatch):
    monkeypatch.setattr(gs, "_PDH_SAMPLER", gs.PdhSampler(pdh_loader=lambda: None))


def _install(monkeypatch, torch, rd=None):
    monkeypatch.setitem(sys.modules, "torch", torch)
    gs.set_package_readers(rd)


def _sample(n=1):
    return gs.sample(FakeEngine(n))["gpus"]


def test_an_amd_satellite_gets_every_field_from_the_package_readers(monkeypatch):
    torch = RocmTorch(["aaaa"], names=["AMD Radeon AI PRO R9700"])
    rd = readers()
    _install(monkeypatch, torch, rd)
    g = _sample()[0]
    assert set(g) == KEYS, "the entry shape does not change"
    assert g == {"index": 0, "device": "cuda:0", "name": "AMD Radeon AI PRO R9700",
                 "total_gb": 31.9, "used_gb": 13.2, "free_gb": 18.7, "vocalis_gb": 1.0,
                 "util_pct": 4, "sclk_mhz": 117, "mclk_mhz": 96,
                 "power_w": 18, "temp_c": 45, "fan_pct": 20}
    assert all(isinstance(g[k], int) for k in ("util_pct", "sclk_mhz", "mclk_mhz", "power_w",
                                               "temp_c", "fan_pct"))
    assert sorted(n for n, _ in rd.calls) == sorted(
        ["vram_used_total_sensor", "gpu_util_percent", "gpu_temp_c", "gpu_power_w", "gpu_clocks_mhz",
         "gpu_fan_pct"]), "one call per reader per card per sample"


def test_each_card_is_read_by_its_own_index(monkeypatch):
    torch = RocmTorch(["aaaa", "bbbb"], names=["card A", "card B"])
    rd = readers()
    _install(monkeypatch, torch, rd)
    gpus = _sample(2)
    assert [g["name"] for g in gpus] == ["card A", "card B"]
    assert {a for _n, a in rd.calls} == {(0,), (1,)}


def test_free_is_total_minus_used_with_one_decimal_like_gpu_stats(monkeypatch):
    _install(monkeypatch, RocmTorch(["aaaa"]),
             readers(vram_used_total_sensor=lambda i: (int(10.04 * GB), int(31.96 * GB))))
    g = _sample()[0]
    assert (g["total_gb"], g["used_gb"], g["free_gb"]) == (
        round(int(31.96 * GB) / GB, 1), round(int(10.04 * GB) / GB, 1),
        round((int(31.96 * GB) - int(10.04 * GB)) / GB, 1))


def test_a_reader_with_no_answer_and_one_that_raises_blank_only_their_own_fields(
        monkeypatch, log):
    def boom(i):
        raise OSError("hwmon went away")

    _install(monkeypatch, RocmTorch(["aaaa"]),
             readers(gpu_fan_pct=lambda i: None, gpu_temp_c=boom))
    for _ in range(3):
        g = _sample()[0]
    assert g["fan_pct"] is None and g["temp_c"] is None
    assert (g["util_pct"], g["power_w"], g["sclk_mhz"], g["mclk_mhz"]) == (4, 18, 117, 96)
    assert (g["total_gb"], g["used_gb"], g["free_gb"]) == (31.9, 13.2, 18.7)
    fan = [m for m in log.warning_lines if "fan_pct" in m]
    temp = [m for m in log.warning_lines if "temp_c" in m]
    assert len(fan) == 1 and "cuda:0" in fan[0], "logged once per card and field"
    assert len(temp) == 1 and "OSError" in temp[0] and "hwmon went away" in temp[0]
    assert len(log.warning_lines) == 2


def test_the_log_is_once_per_card_and_field(monkeypatch, log):
    _install(monkeypatch, RocmTorch(["aaaa", "bbbb"]), readers(gpu_fan_pct=lambda i: None))
    for _ in range(3):
        _sample(2)
    assert len([m for m in log.warning_lines if "fan_pct" in m]) == 2


def test_a_failing_memory_reader_leaves_only_the_memory_fields_null(monkeypatch, log):
    def boom(i):
        raise RuntimeError("sysfs unreadable")

    _install(monkeypatch, RocmTorch(["aaaa"]), readers(vram_used_total_sensor=boom))
    g = _sample()[0]
    assert (g["total_gb"], g["used_gb"], g["free_gb"]) == (None, None, None)
    assert g["util_pct"] == 4 and g["name"] == "torch-name"
    assert g["vocalis_gb"] == 1.0, "no used_gb to clamp against: the value is as it was"


def test_a_half_answered_clock_pair_blanks_only_the_missing_half(monkeypatch, log):
    _install(monkeypatch, RocmTorch(["aaaa"]), readers(gpu_clocks_mhz=lambda i: (0, None)))
    g = _sample()[0]
    assert g["sclk_mhz"] == 0, "an idle AMD core clock of 0 is a value, not a missing reading"
    assert g["mclk_mhz"] is None
    assert len([m for m in log.warning_lines if "mclk_mhz" in m]) == 1


def test_a_reader_returning_nonsense_does_not_fail_the_verb(monkeypatch, log):
    _install(monkeypatch, RocmTorch(["aaaa"]),
             readers(vram_used_total_sensor=lambda i: None, gpu_util_percent=lambda i: "x",
                     gpu_clocks_mhz=lambda i: 5))
    g = _sample()[0]
    assert g["total_gb"] is None and g["util_pct"] is None
    assert g["sclk_mhz"] is None and g["mclk_mhz"] is None
    assert g["temp_c"] == 45


def test_vocalis_gb_stays_clamped_to_used_gb(monkeypatch):
    _install(monkeypatch, RocmTorch(["aaaa"], reserved=40 * GB), readers())
    g = _sample()[0]
    assert g["used_gb"] == 13.2 and g["vocalis_gb"] == 13.2


def test_the_name_is_read_once_per_card_and_never_from_a_context_creating_call(monkeypatch):
    torch = RocmTorch(["aaaa"], names=["AMD Radeon AI PRO R9700"])
    _install(monkeypatch, torch, readers())
    for _ in range(3):
        _sample()
    assert torch.device_name_calls == [0], "cached after the first read"
    assert torch.mem_info_calls == [], "no memory-info (context-creating) call from the module"


def test_a_name_that_cannot_be_read_leaves_only_the_name_null(monkeypatch, log):
    torch = RocmTorch(["aaaa"])

    def refuse(i):
        raise RuntimeError("no such device")

    torch.get_device_name = refuse
    _install(monkeypatch, torch, readers())
    g = _sample()[0]
    assert g["name"] is None and g["total_gb"] == 31.9
    assert len([m for m in log.warning_lines if " name " in m]) == 1


def test_an_nvidia_card_with_a_handle_is_built_exactly_as_before(monkeypatch):
    """The package readers are installed, but a CUDA card with an NVML handle never uses them."""
    rd = readers()
    monkeypatch.setitem(sys.modules, "torch", CudaTorch(["aaaa"]))
    monkeypatch.setitem(sys.modules, "pynvml", FakeNVML([_card("AAAA", "RTX 4090")]))
    gs.set_package_readers(rd)
    g = _sample()[0]
    assert g == {"index": 0, "device": "cuda:0", "name": "RTX 4090",
                 "total_gb": 24.0, "used_gb": 4.0, "free_gb": 20.0, "vocalis_gb": 1.0,
                 "util_pct": 11, "sclk_mhz": 345, "mclk_mhz": 1313,
                 "power_w": 70, "temp_c": 51, "fan_pct": 0}
    assert rd.calls == []


def test_an_nvidia_card_without_a_handle_keeps_null_fields(monkeypatch):
    """Two cards and no UUID match: no handle, and not an AMD card either, so no package
    readers (their memory would be PyTorch's number and their sensors AMD-only)."""
    rd = readers()
    monkeypatch.setitem(sys.modules, "torch", CudaTorch(["aaaa", "bbbb"]))
    monkeypatch.setitem(sys.modules, "pynvml", FakeNVML([_card("xxxx", "A"), _card("yyyy", "B")]))
    gs.set_package_readers(rd)
    for g in _sample(2):
        assert g["name"] is None and g["total_gb"] is None and g["temp_c"] is None
    assert rd.calls == []


def test_no_reader_is_called_on_a_build_without_the_package_readers(monkeypatch):
    torch = RocmTorch(["aaaa"], names=["AMD Radeon AI PRO R9700"])
    _install(monkeypatch, torch, None)
    g = _sample()[0]
    assert all(g[k] is None for k in ("name", "total_gb", "used_gb", "free_gb", "util_pct",
                                      "sclk_mhz", "mclk_mhz", "power_w", "temp_c", "fan_pct"))
    assert torch.device_name_calls == [] and torch.properties_calls == []
    assert g["vocalis_gb"] == 1.0, "vocalis_gb is untouched"


def test_a_module_missing_a_reader_is_refused_and_logged(monkeypatch, log):
    incomplete = SimpleNamespace(vram_used_total_sensor=lambda i: (1, 2))
    assert gs.set_package_readers(incomplete) is False
    assert gs._CARD_READERS is None
    assert "missing" in log.warning_lines[0]
    assert gs.set_package_readers(readers()) is True


def test_the_server_hands_the_package_readers_to_the_readout_module_at_start(monkeypatch,
                                                                              tmp_path):
    import server
    tts_utils = importlib.import_module("tts_utils")
    monkeypatch.setattr(server, "logger", Log())
    assert server.settle_whole_card_source().startswith("package tts_utils.device_mem_gb")
    assert gs._CARD_READERS is tts_utils
    # A standalone folder (no package source) takes them away again.
    server.settle_whole_card_source(tmp_path / "no-such-src")
    assert gs._CARD_READERS is None


# ── memory from the system sensor only: no torch.cuda.mem_get_info from the readout ──────────

class SensorTorch(RocmTorch):
    """A ROCm torch whose card properties carry a PCI address, so the REAL sensor reader in
    `tts_utils` is the one answering; `mem_get_info` is recorded by `FakeTorch`."""

    def get_device_properties(self, i):
        self.properties_calls.append(i)
        return SimpleNamespace(uuid=self._uuids[i], pci_bus_id=3, pci_domain_id=0)


def _real_readers(monkeypatch, sensor):
    """The real `tts_utils` as the readers, with the sysfs lookup replaced by `sensor`; every
    other reader answers as in the other tests."""
    tu = importlib.import_module("tts_utils")
    monkeypatch.setattr(tu, "_amd_sysfs_vram_by_pci", sensor)
    for name, fn in (("gpu_util_percent", lambda i: 4), ("gpu_temp_c", lambda i: 45),
                     ("gpu_power_w", lambda i: 18), ("gpu_clocks_mhz", lambda i: (117, 96)),
                     ("gpu_fan_pct", lambda i: 20)):
        monkeypatch.setattr(tu, name, fn)
    return tu


def test_the_system_sensor_answering_gives_the_numbers_as_before(monkeypatch):
    torch = SensorTorch(["aaaa"], names=["AMD Radeon AI PRO R9700"])
    tu = _real_readers(monkeypatch, lambda dom, bus: (int(13.2 * GB), int(31.9 * GB)))
    _install(monkeypatch, torch, tu)
    g = _sample()[0]
    assert (g["total_gb"], g["used_gb"], g["free_gb"]) == (31.9, 13.2, 18.7)
    assert torch.mem_info_calls == []


def test_a_silent_sensor_gives_null_memory_logs_once_and_never_calls_mem_get_info(
        monkeypatch, log):
    torch = SensorTorch(["aaaa"], names=["AMD Radeon AI PRO R9700"])
    tu = _real_readers(monkeypatch, lambda dom, bus: (None, None))
    _install(monkeypatch, torch, tu)
    for _ in range(3):
        g = _sample()[0]
    assert (g["total_gb"], g["used_gb"], g["free_gb"]) == (None, None, None)
    assert torch.mem_info_calls == [], "that call creates a CUDA context on a card with no model"
    memory = [m for m in log.warning_lines if "memory" in m]
    assert len(memory) == 1 and "cuda:0" in memory[0]
    # Everything else is unaffected.
    assert (g["util_pct"], g["temp_c"], g["power_w"], g["fan_pct"]) == (4, 45, 18, 20)
    assert (g["sclk_mhz"], g["mclk_mhz"]) == (117, 96)
    assert g["name"] == "AMD Radeon AI PRO R9700"
    assert g["vocalis_gb"] == 1.0, "no used_gb to clamp against: as before"


def test_the_sensor_only_reader_is_only_the_sensor(monkeypatch):
    tu = importlib.import_module("tts_utils")
    torch = SensorTorch(["aaaa"])
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setattr(tu, "_amd_sysfs_vram_by_pci", lambda dom, bus: (5 * GB, 32 * GB))
    assert tu.vram_used_total_sensor("cuda:0") == (5 * GB, 32 * GB)
    monkeypatch.setattr(tu, "_amd_sysfs_vram_by_pci", lambda dom, bus: (None, None))
    assert tu.vram_used_total_sensor(0) is None
    # No PCI address at all (not an AMD card): None, not PyTorch's number.
    plain = RocmTorch(["aaaa"])
    monkeypatch.setitem(sys.modules, "torch", plain)
    assert tu.vram_used_total_sensor("cuda:0") is None
    assert plain.mem_info_calls == [] and torch.mem_info_calls == []


def test_vram_used_total_itself_keeps_its_three_source_order(monkeypatch):
    """The satellite's free-memory path is unchanged: sensor, NVML, then PyTorch."""
    tu = importlib.import_module("tts_utils")
    torch = RocmTorch(["aaaa"])
    monkeypatch.setitem(sys.modules, "torch", torch)
    assert tu.vram_used_total("cuda:0") == (4 * GB, 24 * GB), "FakeTorch's mem_get_info"
    assert torch.mem_info_calls == [0]
