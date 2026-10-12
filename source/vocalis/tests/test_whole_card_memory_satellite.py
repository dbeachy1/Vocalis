"""The satellite's use of the whole-card memory number (design section 10, October 10, 2026).

On Windows PyTorch's `mem_get_info` does not see other programs, so the satellite's `free_gb`,
`bound_process_memory`, load log line and allocator cap all used a free number that was too big
(the Windows NVIDIA test machine, RTX 4090: another process held 4 GiB and PyTorch still said 22,988 MiB free while NVML said
5,670). They now use the whole-card reading, with PyTorch's total for the fraction, and the cap is
recomputed on each capacity request for a card that has workers.

No GPU and no real NVML anywhere: PyTorch is a stand-in, the whole-card reader is a function the
test controls, and the decode loop's clock is moved by hand.
"""
import ast
import importlib
import json
import sys
import types
from pathlib import Path

import pytest

from conftest import REPO_ROOT

# Loaded by name after the path is set, not with import statements below code (the lint-ignore
# ratchet in test_webui_types.py counts every suppression comment those would need).
sys.path.insert(0, str(REPO_ROOT / "satellite"))
tts_utils = importlib.import_module("tts_utils")
batch = importlib.import_module("vocalis_satellite_batch")
gs = importlib.import_module("vocalis_satellite_gpustats")
proto = importlib.import_module("vocalis_satellite_protocol")
_sat_tests = importlib.import_module("test_satellite_gpustats")
FakeNVML, _card = _sat_tests.FakeNVML, _sat_tests._card

GB = 1024 ** 3


class Log:
    def __init__(self):
        self.info_lines, self.warning_lines = [], []

    def info(self, m):
        self.info_lines.append(m)

    def warning(self, m):
        self.warning_lines.append(m)

    def debug(self, m):
        pass


class Torch:
    """PyTorch as the satellite sees it. `free_gb` / `total_gb` are what `mem_get_info` says (the
    number that is wrong on Windows); `reserved_gb` is what this process holds."""

    def __init__(self, free_gb=20.0, total_gb=24.0, reserved_gb=3.0, cuda="12.4", hip=None,
                 uuids=("aaaa",)):
        self.free_gb, self.total_gb, self.reserved_gb = free_gb, total_gb, reserved_gb
        self.uuids = list(uuids)
        self.fractions = []
        self.mem_info_calls = 0
        self.version = types.SimpleNamespace(cuda=cuda, hip=hip)
        self.cuda = types.SimpleNamespace(
            is_available=lambda: True,
            device_count=lambda: len(self.uuids),
            get_device_properties=lambda i: types.SimpleNamespace(uuid=self.uuids[i]),
            mem_get_info=self._mem_get_info,
            memory_reserved=lambda i=0: int(self.reserved_gb * GB),
            set_per_process_memory_fraction=lambda f, i: self.fractions.append((f, i)))

    def _mem_get_info(self, i=0):
        self.mem_info_calls += 1
        return int(self.free_gb * GB), int(self.total_gb * GB)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    """Everything this file's subject keeps between calls, reset; and no cap left behind."""
    monkeypatch.setitem(batch._WHOLE_CARD, "fn", None)
    monkeypatch.setitem(batch._WHOLE_CARD, "source", batch._WHOLE_CARD_STANDALONE)
    monkeypatch.setattr(batch, "_WHOLE_CARD_WARNED", set())
    monkeypatch.setattr(batch, "_CAP_LOGGED_GB", {})
    monkeypatch.setattr(batch, "_CAP_WARNED", set())
    for name, value in (("_NVML", None), ("_NVML_UNAVAILABLE_LOGGED", False),
                        ("_NVML_RETRY_AT", None), ("_MAPPING", None), ("_MAPPING_RETRY_AT", None),
                        ("_MAPPING_FAILURE_LOGGED", False), ("_MAPPING_FALLBACK_LOGGED", set()),
                        ("_HANDLE_WARNED", set()), ("_CARD_ACTIVE_LOGGED", set()),
                        ("_CARD_CACHE", {}), ("_FIELD_WARNED", set()), ("_MCLK_DIVISOR", {})):
        monkeypatch.setattr(gs, name, value)
    batch.set_vram_cap(0)
    yield
    batch.set_vram_cap(0)
    with batch._LEARNED_MU:
        batch._CEILING.clear()
    with batch._ALLOC_RATIO_MU:
        batch._ALLOC_RATIO.clear()
        batch._ALLOC_LANDED.clear()


def _torch(monkeypatch, **kw):
    t = Torch(**kw)
    monkeypatch.setattr(batch, "_torch", lambda: t)
    monkeypatch.setitem(sys.modules, "torch", t)
    return t


@pytest.fixture
def log(monkeypatch):
    lg = Log()
    monkeypatch.setattr(batch, "logger", lg)
    return lg


# ── free_gb: the whole-card number, and it never raises ──────────────────────

def test_free_gb_takes_the_whole_card_value_when_the_package_reader_is_settled(monkeypatch):
    t = _torch(monkeypatch, free_gb=20.0)                    # PyTorch: 20 GB free
    seen = []
    batch.set_whole_card_reader(lambda d: seen.append(d) or (6.0, 24.0), "test reader")
    assert batch.free_gb("cuda:0") == 6.0, "PyTorch's inflated 20 GB was used"
    assert seen == ["cuda:0"]
    assert t.mem_info_calls == 0
    assert batch.whole_card_source() == "test reader"


def test_free_gb_works_for_a_bare_cuda_device_name(monkeypatch):
    _torch(monkeypatch)
    seen = []
    batch.set_whole_card_reader(lambda d: seen.append(d) or (6.0, 24.0), "test reader")
    batch.free_gb("cuda")
    assert seen == ["cuda:0"], "tts_utils.vram_used_total cannot parse a bare 'cuda'"


def test_free_gb_never_raises_when_the_reader_does(monkeypatch, log):
    t = _torch(monkeypatch, free_gb=20.0)

    def boom(device):
        raise RuntimeError("driver went away")

    batch.set_whole_card_reader(boom, "test reader")
    for _ in range(3):
        assert batch.free_gb("cuda:0") == 20.0, "a reader failure falls through to PyTorch's number"
    assert t.mem_info_calls == 3
    assert len(log.warning_lines) == 1, "logged once per error type, not once per read"
    assert "RuntimeError" in log.warning_lines[0] and "driver went away" in log.warning_lines[0]


def test_free_gb_never_raises_even_when_pytorch_itself_cannot_answer(monkeypatch, log):
    """It is called from inside the decode loop's step hook, where a raise would abort the pass
    with an unrelated error. "Cannot be measured" is `inf`, the same as a CPU card."""
    t = _torch(monkeypatch)

    def refuse(i=0):
        raise RuntimeError("CUDA error: device lost")

    t.cuda.mem_get_info = refuse
    batch.set_whole_card_reader(lambda d: (None, None), "test reader")
    for _ in range(3):
        assert batch.free_gb("cuda:0") == float("inf")
    assert batch.free_gb("cuda:1") == float("inf")
    assert len(log.warning_lines) == 2, "once per device and error type"
    assert "cuda:0" in log.warning_lines[0] and "RuntimeError" in log.warning_lines[0]
    assert "device lost" in log.warning_lines[0]
    assert "cuda:1" in log.warning_lines[1]


def test_a_reader_with_no_answer_falls_through_to_pytorch(monkeypatch):
    _torch(monkeypatch, free_gb=20.0)
    batch.set_whole_card_reader(lambda d: (None, None), "test reader")
    assert batch.free_gb("cuda:0") == 20.0


def test_a_reader_is_used_on_a_rocm_build_too(monkeypatch):
    """The AMD satellite had the same blind spot: the reader (sysfs, in the package's order) is
    what answers there."""
    _torch(monkeypatch, free_gb=30.0, cuda=None, hip="7.2")
    batch.set_whole_card_reader(lambda d: (11.0, 32.0), "test reader")
    assert batch.free_gb("cuda:0") == 11.0


def test_a_cpu_device_still_has_no_question_to_ask(monkeypatch):
    _torch(monkeypatch)
    batch.set_whole_card_reader(lambda d: pytest.fail("asked about a cpu"), "x")
    assert batch.free_gb("cpu") == float("inf")


def test_a_standalone_folder_uses_nvml_then_pytorch(monkeypatch):
    """No package source beside the satellite: the readout module's NVML read, PyTorch second."""
    t = _torch(monkeypatch, free_gb=20.0, uuids=("aaaa",))
    nvml = FakeNVML([_card("AAAA", "RTX 4090", used=18)])         # 18 of 24 used: 6 free
    monkeypatch.setitem(sys.modules, "pynvml", nvml)
    assert batch.free_gb("cuda:0") == 6.0
    assert t.mem_info_calls == 0
    # NVML cannot be started: the answer is PyTorch's, and nothing raises.
    monkeypatch.setattr(gs, "_NVML", None)
    monkeypatch.setitem(sys.modules, "pynvml", None)
    monkeypatch.setattr(gs, "_NVML_RETRY_AT", None)
    assert batch.free_gb("cuda:0") == 20.0


def test_a_standalone_folder_never_asks_nvml_on_a_build_that_is_not_cuda(monkeypatch):
    t = _torch(monkeypatch, free_gb=30.0, cuda=None, hip="7.2")
    inits = []

    class Spy(FakeNVML):
        def nvmlInit(self):
            inits.append(1)

    monkeypatch.setitem(sys.modules, "pynvml", Spy([_card("aaaa", "x", used=1)]))
    assert batch.free_gb("cuda:0") == 30.0
    assert inits == []


def test_the_sizer_and_the_watchdog_see_the_whole_card_number(monkeypatch):
    """`spend_budget_gb` (and so `batch_cap`) read `free_gb`: with the driver saying 6 GB free,
    the budget is 6 less the 2 GB reserve, however much PyTorch claims."""
    _torch(monkeypatch, free_gb=20.0)
    batch.set_whole_card_reader(lambda d: (6.0, 24.0), "test reader")
    assert batch.spend_budget_gb("cuda:0") == pytest.approx(4.0)


# ── the settled source: server.py decides once, at start ─────────────────────

@pytest.fixture
def server_module(monkeypatch):
    import server
    # A copy of sys.path without the repository's own `src` (conftest puts it first), so a
    # `tts_utils.py` in a temporary folder is the one an import finds; restored on teardown, which
    # also undoes whatever the call under test appends.
    repo_src = (REPO_ROOT / "src").resolve()
    monkeypatch.setattr(sys, "path", [p for p in sys.path if Path(p or ".").resolve() != repo_src])
    monkeypatch.setitem(sys.modules, "tts_utils", tts_utils)       # restored on teardown
    return server


def _package_src(tmp_path, body):
    src = tmp_path / "src"
    src.mkdir()
    (src / "tts_utils.py").write_text(body, encoding="utf-8")
    return src


def test_the_source_is_the_package_reader_when_the_package_source_is_beside_the_satellite(
        monkeypatch, server_module):
    lg = Log()
    monkeypatch.setattr(server_module, "logger", lg)
    assert server_module.PACKAGE_SRC == REPO_ROOT / "src"
    label = server_module.settle_whole_card_source()
    assert label.startswith("package tts_utils.device_mem_gb")
    assert batch._WHOLE_CARD["fn"] is tts_utils.device_mem_gb
    assert any("whole-card memory source: package tts_utils.device_mem_gb" in m
               for m in lg.info_lines), lg.info_lines


def test_the_package_source_folder_is_added_to_sys_path_and_tts_utils_imported(
        monkeypatch, tmp_path, server_module):
    src = _package_src(tmp_path, "def device_mem_gb(device):\n    return (7.5, 24.0)\n")
    monkeypatch.delitem(sys.modules, "tts_utils")
    monkeypatch.setattr(server_module, "logger", Log())
    label = server_module.settle_whole_card_source(src)
    assert label.startswith("package tts_utils.device_mem_gb")
    assert str(src) in sys.path
    _torch(monkeypatch, free_gb=20.0)
    assert batch.free_gb("cuda:0") == 7.5, "the value now comes from the package's reader"


def test_a_standalone_satellite_folder_settles_on_nvml_then_pytorch(
        monkeypatch, tmp_path, server_module):
    lg = Log()
    monkeypatch.setattr(server_module, "logger", lg)
    batch.set_whole_card_reader(lambda d: (1.0, 2.0), "stale")
    label = server_module.settle_whole_card_source(tmp_path / "no-such-src")
    assert label.startswith("NVML, then PyTorch")
    assert batch._WHOLE_CARD["fn"] is None
    assert any("whole-card memory source: NVML, then PyTorch" in m for m in lg.info_lines)


def test_a_package_source_that_cannot_be_imported_is_logged_and_not_fatal(
        monkeypatch, tmp_path, server_module):
    src = _package_src(tmp_path, "raise RuntimeError('engine_process is missing')\n")
    monkeypatch.delitem(sys.modules, "tts_utils")
    lg = Log()
    monkeypatch.setattr(server_module, "logger", lg)
    label = server_module.settle_whole_card_source(src)
    assert label.startswith("NVML, then PyTorch")
    assert batch._WHOLE_CARD["fn"] is None
    assert len(lg.warning_lines) == 1
    assert "engine_process is missing" in lg.warning_lines[0]


def test_main_settles_the_source_after_the_integrated_graphics_step_and_before_serving():
    """Source order inside `main()`: the integrated-graphics decision is logged, the source is
    settled, and only then does anything bind or serve."""
    tree = ast.parse((REPO_ROOT / "satellite" / "server.py").read_text(encoding="utf-8"))
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
    positions = {}
    for node in ast.walk(main):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            positions.setdefault(node.func.id, node.lineno)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            positions.setdefault(node.func.attr, node.lineno)
    assert (positions["_log_gpu_visibility"] < positions["settle_whole_card_source"]
            < positions["_ExclusiveServer"] < positions["serve_forever"])


# ── the integrated graphics are hidden before PyTorch is imported ────────────

def test_server_hides_integrated_gpus_before_importing_torch():
    tree = ast.parse((REPO_ROOT / "satellite" / "server.py").read_text(encoding="utf-8"))

    def pos(pred):
        return next(i for i, n in enumerate(tree.body) if pred(n))

    hide = pos(lambda n: isinstance(n, ast.Assign) and "hide_integrated_rocm_gpus" in ast.dump(n))
    torch_import = pos(lambda n: isinstance(n, ast.Import)
                       and any(a.name == "torch" for a in n.names))
    helper_import = pos(lambda n: isinstance(n, ast.ImportFrom)
                        and n.module == "vocalis_torch_backend"
                        and any(a.name == "hide_integrated_rocm_gpus" for a in n.names))
    assert helper_import < hide < torch_import


def test_importing_the_server_in_the_suite_does_not_run_the_real_gpu_probe(server_module):
    """conftest replaces the helper's function before any test module is imported, so no test
    spawns a PyTorch child on an AMD machine or leaves HIP_VISIBLE_DEVICES set."""
    assert server_module._gpu_visibility == {"action": "none",
                                             "reason": "not probed in the test suite"}
    backend = sys.modules["vocalis_torch_backend"]
    assert callable(backend.hide_integrated_rocm_gpus_real), "the real one stays reachable"


@pytest.mark.parametrize("decision, expected", [
    ({"action": "hid-integrated", "visible": "0,1", "integrated": [2]},
     "ROCm: hid integrated GPU(s) [2]; HIP_VISIBLE_DEVICES=0,1"),
    ({"action": "none", "reason": "no integrated GPU"},
     "ROCm: no GPU hidden (no integrated GPU)"),
    ({"action": "none", "reason": "HIP_VISIBLE_DEVICES set explicitly"},
     "ROCm: no GPU hidden (HIP_VISIBLE_DEVICES set explicitly)"),
])
def test_what_the_integrated_graphics_step_decided_is_logged_with_its_values(
        monkeypatch, server_module, decision, expected):
    lg = Log()
    monkeypatch.setattr(server_module, "logger", lg)
    server_module._log_gpu_visibility(decision)
    assert lg.info_lines == [expected]


def test_a_host_with_no_rocm_at_all_logs_nothing_about_it(monkeypatch, server_module):
    """Every NVIDIA and Windows satellite starts here; "ROCm: no GPU hidden (no ROCm kernel
    driver)" on each of them is noise. The main server suppresses the same case."""
    lg = Log()
    monkeypatch.setattr(server_module, "logger", lg)
    server_module._log_gpu_visibility({"action": "none", "reason": "no ROCm kernel driver"})
    assert lg.info_lines == [] and lg.warning_lines == []


# ── bound_process_memory: whole-card free over PyTorch's total ───────────────

def test_the_allocator_cap_uses_the_whole_card_free_and_pytorchs_total(monkeypatch):
    # PyTorch claims 20 GB free; the driver says 6. Torch holds 3 of its 24 GB total.
    t = _torch(monkeypatch, free_gb=20.0, total_gb=24.0, reserved_gb=3.0)
    batch.set_whole_card_reader(lambda d: (6.0, 99.0), "test reader")   # its total is NOT used
    frac = batch.bound_process_memory("cuda:0")
    # allowed = 3 held + (6 free - 2 headroom) = 7 GB, over PyTorch's 24 GB total.
    assert frac == pytest.approx(7.0 / 24.0)
    assert t.fractions == [(pytest.approx(7.0 / 24.0), 0)]


@pytest.mark.parametrize("readings", [(5.0, 1.0), (1.0, 5.0)], ids=["cache-emptied-between",
                                                                    "cache-grew-between"])
def test_the_cap_uses_the_larger_of_the_reserved_figures_taken_around_the_free_read(
        monkeypatch, readings):
    """An `empty_cache()` landing between the free-memory read and the reserved read would pair a
    free figure that still counts the cache as used with a reserved figure that no longer includes
    it, and the cap would stay too tight until the next request. Reserved is read before and after
    the free-memory read, and the larger is used."""
    t = _torch(monkeypatch, free_gb=20.0, total_gb=24.0)
    seq = iter(readings)
    t.cuda.memory_reserved = lambda i=0: int(next(seq) * GB)
    batch.set_whole_card_reader(lambda d: (6.0, 24.0), "test reader")
    frac = batch.bound_process_memory("cuda:0")
    # allowed = 5 held (the larger reading) + (6 free - 2 headroom) = 9 GB over 24.
    assert frac == pytest.approx(9.0 / 24.0)
    assert next(seq, None) is None, "reserved was read exactly twice"


def test_the_allocator_cap_falls_back_to_pytorchs_free_when_the_reader_fails(monkeypatch):
    t = _torch(monkeypatch, free_gb=8.0, total_gb=24.0, reserved_gb=4.0)

    def boom(device):
        raise OSError("nothing here")

    batch.set_whole_card_reader(boom, "test reader")
    assert batch.bound_process_memory("cuda:0") == pytest.approx(10.0 / 24.0)
    assert t.fractions[-1][1] == 0


@pytest.fixture
def eng_mod(monkeypatch):
    fake_tts = sys.modules.get("chatterbox") or type(sys)("chatterbox")
    monkeypatch.setitem(sys.modules, "chatterbox", fake_tts)
    mod = type(sys)("chatterbox.tts")

    class _M:
        sr = 24000

    mod.ChatterboxTTS = type("ChatterboxTTS", (), {
        "from_pretrained": staticmethod(lambda device=None: _M())})
    monkeypatch.setitem(sys.modules, "chatterbox.tts", mod)
    monkeypatch.setattr(fake_tts, "tts", mod, raising=False)
    import vocalis_satellite_engine as eng
    monkeypatch.setattr(eng, "_install_cancel_hook", lambda: None)
    return eng


def test_the_load_log_line_uses_the_whole_card_free(monkeypatch, eng_mod):
    """`Engine._load_locked`'s log line says how much is free after a replica loads; it used
    `mem_get_info`'s number, which on Windows ignores other programs."""
    t = _torch(monkeypatch, free_gb=20.0, total_gb=24.0, reserved_gb=3.0)
    batch.set_whole_card_reader(lambda d: (6.0, 24.0), "test reader")
    lg = Log()
    monkeypatch.setattr(eng_mod, "logger", lg)
    monkeypatch.setattr(batch, "logger", Log())
    # `Engine.load` imports torch itself; `_torch` has put the stand-in in sys.modules.
    eng_mod.Engine().load({"cuda:0": 1})
    loaded = [m for m in lg.info_lines if "loaded in" in m]
    assert len(loaded) == 1 and "6.0/24.0 GB free" in loaded[0], loaded
    assert t.fractions, "the cap was applied from the same number"


# ── recomputed on each capacity request for a card that has workers ───────────

class FakeEngine:
    """Only what `/satellite/capacity` touches."""

    def __init__(self, devices):
        self._devices = list(devices)

    def devices(self):
        return list(self._devices)


def _post(server, master, path, obj):
    salt = proto.new_salt()
    k2s = proto.derive_key(master, salt, proto.DIR_TO_SATELLITE)
    s2k = proto.derive_key(master, salt, proto.DIR_TO_SERVER)
    r = server.app.test_client().post(
        path, data=proto.seal_bytes(k2s, json.dumps(obj).encode()),
        headers={"X-Vocalis-Salt": salt.hex(), "Content-Type": "application/octet-stream"})
    return r, s2k


@pytest.fixture
def capacity_app(monkeypatch):
    import server
    master = proto.new_master()
    monkeypatch.setattr(server, "_MASTER", master)
    engine = FakeEngine(["cuda:0"])
    monkeypatch.setattr(server, "ENGINE", engine)
    server.app.config["TESTING"] = True
    # Room is not the question: a roomy card by both PyTorch's number and the reader's. Tests
    # that care replace the reader.
    t = _torch(monkeypatch, free_gb=100.0, total_gb=100.0, reserved_gb=1.0)
    batch.set_whole_card_reader(lambda d: (100.0, 100.0), "test reader")
    return server, engine, master, t


def _capacity(server, master, **extra):
    r, s2k = _post(server, master, "/satellite/capacity",
                   {"device": "cuda:0", "lengths": [400], **extra})
    assert r.status_code == 200, r.data
    return json.loads(proto.open_bytes(s2k, r.data))


def test_the_cap_is_recomputed_on_every_capacity_request_for_a_card_with_workers(
        monkeypatch, capacity_app):
    server, engine, master, _t = capacity_app
    calls = []
    monkeypatch.setattr(batch, "bound_process_memory",
                        lambda device, on_change_only=False: calls.append((device, on_change_only))
                        or 0.5)
    _capacity(server, master)
    _capacity(server, master)
    _capacity(server, master)
    assert calls == [("cuda:0", True)] * 3, (
        "the cap must be recomputed on EACH request, not only when the setting changes")


def test_a_card_without_workers_is_left_alone(monkeypatch, capacity_app):
    server, engine, master, _t = capacity_app
    engine._devices = []
    calls = []
    monkeypatch.setattr(batch, "bound_process_memory",
                        lambda device, on_change_only=False: calls.append(device) or 0.5)
    _capacity(server, master)
    assert calls == []
    engine._devices = ["cuda:1"]                       # workers, but not on the requested card
    _capacity(server, master)
    assert calls == []


def test_a_changed_cap_setting_is_applied_once_not_twice(monkeypatch, capacity_app):
    server, engine, master, _t = capacity_app
    calls = []
    monkeypatch.setattr(batch, "bound_process_memory",
                        lambda device, on_change_only=False: calls.append((device, on_change_only))
                        or 0.5)
    _capacity(server, master, vram_cap_gb=6.0)
    assert calls == [("cuda:0", False)], "take_vram_cap already re-bounded every loaded card"


def test_a_recompute_that_fails_does_not_fail_the_request(monkeypatch, capacity_app):
    server, engine, master, _t = capacity_app
    lg = Log()
    monkeypatch.setattr(server, "logger", lg)

    def boom(device, on_change_only=False):
        raise RuntimeError("no CUDA context here")

    monkeypatch.setattr(batch, "bound_process_memory", boom)
    assert _capacity(server, master)["take"] >= 1
    assert len(lg.warning_lines) == 1 and "no CUDA context here" in lg.warning_lines[0]


def test_the_cap_follows_the_whole_card_free_as_another_program_comes_and_goes(
        monkeypatch, capacity_app, log):
    """The reason for recomputing: a cap set while another program held memory must not stay low
    after that program left, until Unload and Load."""
    server, engine, master, t = capacity_app
    t.total_gb, t.free_gb = 24.0, 20.0
    free = {"gb": 3.0}                                  # another program holds the rest
    batch.set_whole_card_reader(lambda d: (free["gb"], 24.0), "test reader")
    _capacity(server, master)
    free["gb"] = 19.0                                   # it exits
    _capacity(server, master)
    applied = [f * 24.0 for f, _i in t.fractions]
    assert applied == [pytest.approx(1.0 + 1.0), pytest.approx(1.0 + 17.0)], applied


def test_the_capped_at_line_is_logged_only_when_the_cap_moves_by_a_tenth_of_a_gigabyte(
        monkeypatch, log):
    t = _torch(monkeypatch, free_gb=20.0, total_gb=24.0, reserved_gb=1.0)
    free = {"gb": 10.0}
    batch.set_whole_card_reader(lambda d: (free["gb"], 24.0), "test reader")

    def capped():
        return [m for m in log.info_lines if "torch capped at" in m]

    batch.bound_process_memory("cuda:0", on_change_only=True)
    assert len(capped()) == 1, "the first application is news"
    free["gb"] = 10.05                                  # +0.05 GB: noise
    batch.bound_process_memory("cuda:0", on_change_only=True)
    assert len(capped()) == 1
    assert len(t.fractions) == 2, "it is still applied every time; only the log is quiet"
    free["gb"] = 10.2                                   # +0.2 GB since the last line
    batch.bound_process_memory("cuda:0", on_change_only=True)
    assert len(capped()) == 2 and "(was 9.0 GB)" in capped()[1], capped()
    # The load path (not on_change_only) always says so.
    batch.bound_process_memory("cuda:0")
    assert len(capped()) == 3


def test_the_below_resident_warning_is_once_per_card_and_cap_without_the_old_advice(
        monkeypatch, log):
    _torch(monkeypatch, free_gb=20.0, total_gb=24.0, reserved_gb=3.0)
    batch.set_whole_card_reader(lambda d: (20.0, 24.0), "test reader")
    batch.set_vram_cap(1.0)
    for _ in range(3):
        batch.bound_process_memory("cuda:0", on_change_only=True)
    assert len(log.warning_lines) == 1
    batch.bound_process_memory("cuda:1", on_change_only=True)
    assert len(log.warning_lines) == 2, "another card is another warning"
    batch.set_vram_cap(2.0)
    batch.bound_process_memory("cuda:0", on_change_only=True)
    assert len(log.warning_lines) == 3, "another cap value is another warning"
    for line in log.warning_lines:
        assert "Unload" not in line and "load again" not in line and "⏏" not in line


# ── the decode loop's step timer leaves out its own free-memory read ──────────

def test_a_slow_free_memory_read_does_not_look_like_memory_pressure(monkeypatch):
    """The decode loop reads free memory every half second inside its step hook and treats a
    slow step as memory pressure. A driver answer that takes 3 s must not halve a batch."""
    clock = {"t": 0.0}
    reads = []

    def slow_free(device):
        clock["t"] += 3.0                               # the driver is slow to answer
        reads.append(clock["t"])
        return 18.0

    monkeypatch.setattr(batch, "free_gb", slow_free)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])
    for _ in range(batch._BASELINE_STEPS + 60):         # healthy 20 ms steps
        clock["t"] += 0.02
        assert check() is False, "a slow read was counted as a slow decode step"
    assert len(reads) >= 2, "the read never happened, so nothing was proven"


def test_the_next_read_is_timed_from_when_the_last_one_ended(monkeypatch):
    """A driver answer slower than the half-second interval must not make every decode step do
    a read: the interval is measured from the end of the read, not from before it."""
    clock = {"t": 0.0}
    reads = []

    def slow_free(device):
        reads.append(clock["t"])
        clock["t"] += 0.8                               # slower than _WATCH_SECONDS (0.5)
        return 18.0

    monkeypatch.setattr(batch, "free_gb", slow_free)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])
    steps = batch._BASELINE_STEPS + 100
    for _ in range(steps):
        clock["t"] += 0.02
        check()
    assert len(reads) >= 3, "the watchdog stopped reading"
    gaps = [b - a for a, b in zip(reads, reads[1:])]
    assert all(g >= 0.8 + batch._WATCH_SECONDS - 1e-9 for g in gaps), (
        f"a read began less than {batch._WATCH_SECONDS} s after the previous one ended: {gaps}")
    assert len(reads) < steps / 10, f"{len(reads)} reads in {steps} steps"


def test_a_genuinely_slow_step_still_aborts_even_with_a_slow_read(monkeypatch):
    """The fix removes only the read's own duration; a real stall is still caught."""
    clock = {"t": 0.0}

    def slow_free(device):
        clock["t"] += 3.0
        return 18.0

    monkeypatch.setattr(batch, "free_gb", slow_free)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])
    for _ in range(batch._BASELINE_STEPS + 60):         # reads have happened by now
        clock["t"] += 0.02
        check()
    clock["t"] += 8.0                                   # one step, eight seconds
    with pytest.raises(batch.BatchTooBig, match="possible GPU memory pressure"):
        check()


def test_the_floor_is_still_enforced_after_the_step_timer_change(monkeypatch):
    clock = {"t": 0.0}
    monkeypatch.setattr(batch, "free_gb", lambda d: 0.4)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])
    clock["t"] += batch._WATCH_SECONDS
    with pytest.raises(batch.BatchTooBig, match="free VRAM fell below"):
        check()
