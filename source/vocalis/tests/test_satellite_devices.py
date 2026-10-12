"""Satellites as pool devices, and per-device worker counts.

The failures guarded here are all quiet ones. A pool signature that is not stable rebuilds
itself for no reason and drops replicas out from under a live render; a migration that half-runs
loads the wrong number of workers and nothing says so; a satellite device name that starts with
`cuda` would send a remote worker down the local-VRAM path.

Design: DESIGN_5_3_SATELLITES §3.2, §3.5.
"""
import sys
import threading

import pytest

from conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT / "satellite"))

import render_rate                                 # noqa: E402
import satellite_client as sc                      # noqa: E402
import tts_utils                                   # noqa: E402
from vocalis.runtime import pool as pool_mod       # noqa: E402
from vocalis.runtime import settings as settings_mod  # noqa: E402


# ── device naming ────────────────────────────────────────────────────────────

def test_a_satellite_device_never_starts_with_cuda():
    """🔴 Load-bearing. `WorkerPool` branches on `dev.startswith("cuda")` to decide whether to
    call `torch.cuda.set_device`, run the `act_headroom_gb` fit check and `empty_cache`. A
    satellite name that tripped that branch would run local VRAM logic against a card in
    another machine."""
    d = sc.device_name("test-satellite", "cuda:0")
    assert d == "test-satellite:cuda:0"
    assert not d.startswith("cuda")
    assert sc.is_remote(d)


@pytest.mark.parametrize("local", ["cuda:0", "cuda:1", "cpu"])
def test_local_devices_are_not_remote(local):
    assert not sc.is_remote(local)
    assert sc.split_device(local) == (None, local)


def test_split_device_round_trips():
    assert sc.split_device(sc.device_name("test-satellite", "cuda:1")) == ("test-satellite", "cuda:1")


def test_load_model_dispatches_remote_by_name(monkeypatch):
    """The whole satellite integration hangs off this one branch in `load_model`."""
    seen = {}

    def _remote(dev):
        seen["dev"] = dev
        return "REMOTE"

    monkeypatch.setattr(sc, "remote_model", _remote)
    monkeypatch.setitem(sys.modules, "satellite_client", sc)
    assert tts_utils.load_model("test-satellite:cuda:0") == "REMOTE"
    assert seen["dev"] == "test-satellite:cuda:0"


# ── pool signature ───────────────────────────────────────────────────────────

def test_the_signature_is_stable_under_ordering():
    """🔴 Two identical configurations MUST hash identically. If they do not, `get_pool` sees a
    selection change, rebuilds, and drops model replicas out from under an in-flight render."""
    a = pool_mod._signature(["cuda:0", "cuda:1"], {"cuda:0": 1, "cuda:1": 2})
    b = pool_mod._signature(["cuda:1", "cuda:0"], {"cuda:1": 2, "cuda:0": 1})
    assert a == b
    assert hash(a) == hash(b)


def test_the_signature_still_distinguishes_real_changes():
    base = pool_mod._signature(["cuda:0"], {"cuda:0": 1})
    assert base != pool_mod._signature(["cuda:0"], {"cuda:0": 2})
    assert base != pool_mod._signature(["cuda:0", "cuda:1"], {"cuda:0": 1, "cuda:1": 1})


def test_the_int_form_still_works():
    """Back-compat: the CLI and older callers pass a plain int."""
    assert (pool_mod._signature(["cuda:0", "cuda:1"], 2)
            == pool_mod._signature(["cuda:0", "cuda:1"], {"cuda:0": 2, "cuda:1": 2}))


# ── per-device worker counts in the pool ─────────────────────────────────────

class _FakeModel:
    sr = 24000


@pytest.fixture
def fake_load(monkeypatch):
    built = []

    def _load(device):
        built.append(device)
        return _FakeModel()

    monkeypatch.setattr(tts_utils, "load_model", _load)
    monkeypatch.setattr(tts_utils.WorkerPool, "_init_pool_state", lambda self: None)
    return built


def test_a_dict_gives_each_device_its_own_count(fake_load):
    p = tts_utils.WorkerPool(["test-satellite:cuda:0", "test-satellite:cuda:1"],
                             {"test-satellite:cuda:0": 3, "test-satellite:cuda:1": 1})
    assert fake_load == ["test-satellite:cuda:0"] * 3 + ["test-satellite:cuda:1"]
    assert len(p.workers) == 4


def test_an_int_still_applies_to_every_device(fake_load):
    tts_utils.WorkerPool(["test-satellite:cuda:0", "test-satellite:cuda:1"], 2)
    assert fake_load == ["test-satellite:cuda:0"] * 2 + ["test-satellite:cuda:1"] * 2


def test_zero_workers_is_refused(fake_load):
    with pytest.raises(tts_utils.VocalisError):
        tts_utils.WorkerPool(["test-satellite:cuda:0"], {"test-satellite:cuda:0": 0})


def test_a_device_missing_from_the_dict_defaults_to_one(fake_load):
    tts_utils.WorkerPool(["test-satellite:cuda:0", "test-satellite:cuda:1"], {"test-satellite:cuda:0": 2})
    assert fake_load == ["test-satellite:cuda:0", "test-satellite:cuda:0", "test-satellite:cuda:1"]


# ── settings migration ───────────────────────────────────────────────────────

@pytest.fixture
def app_settings(monkeypatch):
    store = {}
    monkeypatch.setattr(settings_mod, "load_app_settings", lambda: dict(store))
    return store


def test_gpus_all_enables_every_device(app_settings):
    # `workers_per_card` is deliberately still in the config: 5.4.1 stopped reading it, and a
    # migration that carried it forward into the rows would keep it alive by the back door.
    app_settings.update({"gpus": "all", "workers_per_card": 2})
    got = pool_mod.migrate_device_settings(["cuda:0", "cuda:1"])
    assert got == [{"id": "cuda:0", "enabled": True},
                   {"id": "cuda:1", "enabled": True}]


def test_a_gpu_index_list_enables_only_those(app_settings):
    app_settings.update({"gpus": "0", "workers_per_card": 1})
    got = {d["id"]: d["enabled"] for d in
           pool_mod.migrate_device_settings(["cuda:0", "cuda:1"])}
    assert got == {"cuda:0": True, "cuda:1": False}


def test_gpus_cpu_enables_only_cpu(app_settings):
    app_settings.update({"gpus": "cpu"})
    got = {d["id"]: d["enabled"] for d in
           pool_mod.migrate_device_settings(["cuda:0", "cpu"])}
    assert got == {"cuda:0": False, "cpu": True}


def test_existing_per_device_entries_win_over_the_legacy_keys(app_settings):
    """Migration fills gaps; it must never overwrite a choice the user already made."""
    app_settings.update({
        "gpus": "all", "workers_per_card": 1,
        "devices": [{"id": "cuda:0", "enabled": False, "workers": 4}],
    })
    got = {d["id"]: d for d in pool_mod.migrate_device_settings(["cuda:0", "cuda:1"])}
    # The user's `enabled: False` survives; the stale `workers: 4` beside it does NOT come with
    # it. Dropping the key is the point -- a row that still carried it would write it back out.
    assert got["cuda:0"] == {"id": "cuda:0", "enabled": False}
    assert got["cuda:1"] == {"id": "cuda:1", "enabled": True}


def test_default_workers_is_one_per_enabled_device_whatever_is_saved(app_settings):
    """🔴 5.4.1: one worker per device, and a saved count is IGNORED rather than honored.

    A second worker on one card measured SLOWER than one (1.527x aggregate against 1.604x on
    the same eight chunks), so the setting was removed. Every deployed app_settings.yaml still
    carries the old numbers, and the whole point is that
    those values stop reaching the pool. The saved 3 and 9 below must not survive.
    """
    app_settings["devices"] = [{"id": "cuda:0", "enabled": True, "workers": 1},
                               {"id": "test-satellite:cuda:0", "enabled": True, "workers": 3},
                               {"id": "cuda:1", "enabled": False, "workers": 9}]
    assert pool_mod.default_workers() == {"cuda:0": 1, "test-satellite:cuda:0": 1}


def test_default_workers_keeps_the_dict_shape_so_the_rate_key_keeps_the_satellite(app_settings):
    """🔴 The DICT is load-bearing even though every value is 1.

    `render_rate._workers_key` only puts the satellite NAME in the key for the dict form. A bare
    scalar would make a one-worker pool on satellite A and a one-worker pool on satellite B share
    a key -- so B inherits A's measured rate and reports a wrong ETA. That is the exact bug the
    key exists to prevent, and this codebase has already shipped it once.
    """
    app_settings["devices"] = [{"id": "test-satellite:cuda:0", "enabled": True}]
    assert render_rate.key_for("R9700", 1, pool_mod.default_workers())         != render_rate.key_for("R9700", 1, pool_mod.default_workers() | {"sample-remote:cuda:0": 1})


def test_default_workers_falls_back_to_a_scalar_with_no_devices_list(app_settings):
    """A config predating `devices:` has nothing to enumerate, and an EMPTY dict is not
    'one each' -- `WorkerPool.__init__` raises `no devices selected.` on it."""
    app_settings["workers_per_card"] = 2      # still ignored; the fallback is the constant
    assert pool_mod.default_workers() == 1


def test_default_devices_lists_only_enabled_ones(app_settings):
    app_settings["devices"] = [{"id": "cuda:0", "enabled": True, "workers": 1},
                               {"id": "test-satellite:cuda:0", "enabled": False, "workers": 1}]
    assert pool_mod.default_devices() == ["cuda:0"]


def test_a_disabled_device_is_absent_from_both_answers(app_settings):
    """They are read together to build the pool, so disagreement would build a device with no
    worker count or a count for a device that is not there."""
    app_settings["devices"] = [{"id": "cuda:0", "enabled": True, "workers": 2},
                               {"id": "cuda:1", "enabled": False, "workers": 5}]
    assert set(pool_mod.default_devices()) == set(pool_mod.default_workers())


# ── a job must render where the settings say, satellite included ─────────────
#
# The setting helpers returned the right values, but book and Playground callers used
# `default_gpus()`, which drops satellites by design. A satellite-only selection therefore became
# `cpu`, and the job rebuilt a local pool instead of using the configured remote device.

def test_resolve_devices_passes_a_list_through_untouched():
    """A list is already resolved. Running it through `parse_devices` is what mangled it —
    that function understands 'all' / 'cpu' / index lists and nothing else."""
    assert pool_mod.resolve_devices(["test-satellite:cuda:0"]) == ["test-satellite:cuda:0"]
    assert pool_mod.resolve_devices(["cuda:1", "test-satellite:cuda:0"]) == ["cuda:1", "test-satellite:cuda:0"]


def test_resolve_devices_still_understands_the_cli_string():
    """`book_to_audio.py` and `generate.py` hand `--gpus` straight through."""
    assert pool_mod.resolve_devices("cpu") == ["cpu"]


def test_a_satellite_only_selection_does_not_resolve_to_cpu(app_settings):
    """🔴 The regression, stated as the thing that went wrong: with only the satellite ticked,
    what a job renders on must be the satellite — never `['cpu']`, which is what
    `parse_devices(default_gpus())` answered."""
    app_settings["devices"] = [{"id": "cuda:0", "enabled": False, "workers": 1},
                               {"id": "cuda:1", "enabled": False, "workers": 1},
                               {"id": "test-satellite:cuda:0", "enabled": True, "workers": 1}]
    assert pool_mod._local_gpus_string() == "cpu"          # unchanged: it answers about LOCAL cards
    assert pool_mod.default_devices() == ["test-satellite:cuda:0"]
    assert pool_mod.resolve_devices(pool_mod.default_devices()) == ["test-satellite:cuda:0"]


# ── the pre-render gate, on a box that renders somewhere else ────────────────
#
# The pre-render gate must use the selected device set. `pool.model_ready()` describes only the
# local pool, so a satellite-only selection must not be blocked on a local model being loaded.

@pytest.fixture
def cold_pool(monkeypatch):
    """No pool built — `model_ready()` false, as it is after a restart or the idle reaper."""
    monkeypatch.setattr(pool_mod, "_pool", None)
    assert pool_mod.model_ready() is False


def test_a_satellite_only_selection_opens_the_prerender_gate(app_settings, cold_pool):
    """🔴 The regression. Building this pool loads nothing on this box — `load_model` on a
    satellite device is an HTTP call — so clause 3 has nothing to refuse."""
    app_settings["devices"] = [{"id": "cuda:0", "enabled": False, "workers": 1},
                               {"id": "test-satellite:cuda:0", "enabled": True, "workers": 2}]
    assert pool_mod.default_devices() == ["test-satellite:cuda:0"]
    assert pool_mod.prerender_model_ready() is True


def test_a_cold_local_card_opens_the_prerender_gate(app_settings, cold_pool):
    """Pre-rendering is the user's explicit request to spend the configured speech resources."""
    app_settings["devices"] = [{"id": "cuda:0", "enabled": True, "workers": 1}]
    assert pool_mod.prerender_model_ready() is True


def test_a_mixed_selection_opens_the_prerender_gate(app_settings, cold_pool):
    """A mixed local and satellite selection must dispatch after a fresh restart."""
    app_settings["devices"] = [{"id": "cuda:0", "enabled": True, "workers": 1},
                               {"id": "test-satellite:cuda:0", "enabled": True, "workers": 1}]
    assert pool_mod.prerender_model_ready() is True


def test_cpu_selection_opens_the_prerender_gate(app_settings, cold_pool):
    app_settings["devices"] = [{"id": "cpu", "enabled": True, "workers": 1}]
    assert pool_mod.prerender_model_ready() is True


def test_a_built_pool_opens_the_gate_whatever_the_devices(app_settings, monkeypatch):
    monkeypatch.setattr(pool_mod, "_pool", object())
    app_settings["devices"] = [{"id": "cuda:0", "enabled": True, "workers": 1}]
    assert pool_mod.prerender_model_ready() is True


def test_an_empty_selection_holds_the_prerender_gate(app_settings, cold_pool, monkeypatch):
    monkeypatch.setattr(pool_mod, "default_devices", lambda *_a, **_k: [])
    assert pool_mod.prerender_model_ready() is False


def test_the_prerender_gate_never_raises(app_settings, cold_pool, monkeypatch):
    """⚠️ The dispatcher calls this once a second and does not guard the call. A saved card
    index this box no longer enumerates makes `default_devices()` raise `VocalisError` — see
    `local_cuda_devices()` for the same trap — and an exception here would retire pre-rendering
    for the life of the process. Unsure means hold."""
    def boom(*_a, **_k):
        raise tts_utils.VocalisError("card 3 does not exist on this box")
    monkeypatch.setattr(pool_mod, "default_devices", boom)
    assert pool_mod.prerender_model_ready() is False


def test_worker_note_survives_the_per_device_dict():
    """It used to interpolate `workers` straight into "N worker(s)/card", which printed a raw
    dict at the user once 5.3 made it per-device."""
    assert pool_mod.worker_note({"cuda:0": 2, "test-satellite:cuda:0": 1}, ["cuda:0", "test-satellite:cuda:0"]) \
        == "3 worker(s)"
    assert pool_mod.worker_note(2, ["cuda:0", "cuda:1"]) == "4 worker(s)"


def test_a_job_that_renders_nothing_claims_no_devices():
    """⚠️ A BLANK `gpus` is not "unspecified". `parse_devices('')` reads `'' or "all"` and
    answers every card on the box — and the jobs carrying `gpus=""` (enhance, cleanup) are
    exactly the ones that own no pool at all. `/book/cancel` asks `resolve_devices` about them,
    so canceling a background enhancement announced "up to 2 worker(s) in flight" for one child
    process, at the moment the user is anxious about whether cancel landed.

    `None` still means "unspecified" — that is the CLI's `--gpus` default, and it means 'all'.
    """
    assert pool_mod.resolve_devices("") == []
    assert pool_mod.resolve_devices("   ") == []
    assert pool_mod.worker_note(0, pool_mod.resolve_devices("")) == "0 worker(s)"
    assert pool_mod.resolve_devices(None) == pool_mod.resolve_devices("all")


def test_local_cuda_devices_survives_a_card_that_is_no_longer_there(app_settings, monkeypatch):
    """🔴 `devices:` is PERSISTED settings, and `parse_devices` validates indices against
    `torch.cuda.device_count()` and RAISES. So a card saved when it enumerated and absent now —
    one card down, or HIP_VISIBLE_DEVICES set for a co-tenant — turned every
    /playground/generate, /playground/stream, /book/start and /render/rate into a 500: they all
    reach `enhance_cards()` through `rt_params.enhance_opts()`, and there is no
    errorhandler(VocalisError). `default_devices()` answered unbothered the whole time, so the
    two disagreed about whether the box was usable at all.

    A stale index means "that card is not available", which is what an empty list says.
    """
    app_settings["devices"] = [{"id": "cuda:0", "enabled": True, "workers": 1},
                               {"id": "cuda:1", "enabled": True, "workers": 1}]

    def _boom(spec):
        raise tts_utils.VocalisError("--gpus: card 1 requested but 1 CUDA device(s) present")

    monkeypatch.setattr(pool_mod, "parse_devices", _boom)
    assert pool_mod.local_cuda_devices() == []

    from vocalis.runtime import enhancement, voxcpm_pool
    assert enhancement.enhance_cards() == []
    assert enhancement.enhance_available() is False          # was: VocalisError, on every render
    assert voxcpm_pool.usable_cards() == []


# ── the satellite engine's load is declarative ───────────────────────────────

@pytest.fixture
def engine(monkeypatch):
    """A real `Engine` with a fake model loader, so the counting logic is exercised without
    a GPU."""
    # 🔴 `monkeypatch.setitem`, NOT `sys.modules.setdefault`. setdefault installs a fake
    # top-level `chatterbox` PERMANENTLY when the real one has not been imported yet, and that
    # fake is a plain module rather than a package — so every later test in the session that
    # does `import chatterbox.models...` dies with "'chatterbox' is not a package", pointing at
    # code it has nothing to do with. It only stayed hidden because the suite runs
    # alphabetically and `test_pool.py` happened to sort earlier; adding a test file after this
    # one is enough to surface it. setitem restores whatever was there, including nothing.
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
    return eng.Engine()


def test_load_is_declarative_not_additive(engine):
    """Loading the same desired plan twice must not create a second replica or consume more VRAM."""
    assert engine.load({"cuda:0": 1}) == {"cuda:0": 1}
    assert engine.worker_counts() == {"cuda:0": 1}
    assert engine.load({"cuda:0": 1}) == {"cuda:0": 1}
    assert engine.worker_counts() == {"cuda:0": 1}, "load stacked a second replica"


def test_load_grows_and_shrinks_to_the_requested_count(engine):
    engine.load({"cuda:0": 1})
    engine.load({"cuda:0": 3})
    assert engine.worker_counts() == {"cuda:0": 3}
    engine.load({"cuda:0": 1})
    assert engine.worker_counts() == {"cuda:0": 1}, "the plan asked for fewer and was ignored"


def test_load_handles_several_devices_independently(engine):
    engine.load({"cuda:0": 2, "cuda:1": 1})
    assert engine.worker_counts() == {"cuda:0": 2, "cuda:1": 1}
    engine.load({"cuda:0": 1, "cuda:1": 2})
    assert engine.worker_counts() == {"cuda:0": 1, "cuda:1": 2}


def test_packaged_local_model_mode_uses_the_verified_local_tree(engine, monkeypatch, tmp_path):
    import types

    monkeypatch.setenv("VOCALIS_REQUIRE_LOCALMODEL", "1")
    monkeypatch.setenv("VOCALIS_CHATTERBOX_MODEL_DIR", str(tmp_path))
    validator_path = (REPO_ROOT / "src" / "tts_utils.py").resolve()
    calls = []
    validator = types.SimpleNamespace(
        __file__=str(validator_path),
        _verified_chatterbox_model_dir=lambda value: calls.append(("verify", value)) or tmp_path)

    from chatterbox import tts

    class _LocalOnly:
        sr = 24000

        @staticmethod
        def from_local(path, device=None):
            calls.append(("local", path, device))
            return _LocalOnly()

        @staticmethod
        def from_pretrained(device=None):
            raise AssertionError("packaged local mode must not download or resolve a model")

    tts.ChatterboxTTS = _LocalOnly
    monkeypatch.setattr("vocalis_satellite_engine.importlib.import_module",
                        lambda name: validator if name == "tts_utils" else None)

    assert engine.load({"cuda:0": 1}) == {"cuda:0": 1}
    assert calls == [("verify", str(tmp_path)), ("local", tmp_path, "cuda:0")]


def test_packaged_local_model_mode_fails_without_a_root_and_never_falls_back(
        engine, monkeypatch):
    monkeypatch.setenv("VOCALIS_REQUIRE_LOCALMODEL", "1")
    monkeypatch.delenv("VOCALIS_CHATTERBOX_MODEL_DIR", raising=False)
    from chatterbox import tts

    called = []

    class _NoFallback:
        @staticmethod
        def from_pretrained(device=None):
            called.append(device)
            raise AssertionError("local model mode attempted upstream download fallback")

    tts.ChatterboxTTS = _NoFallback
    with pytest.raises(RuntimeError, match="VOCALIS_CHATTERBOX_MODEL_DIR"):
        engine.load({"cuda:0": 1})
    assert called == []


def test_two_concurrent_loads_do_not_double_the_vram(engine, monkeypatch):
    """Concurrent `load()` calls must serialize the read-modify-write around model loading.

    Recovery and a settings save may both submit plans concurrently, so the satellite service
    cannot depend on its clients using one shared lock.
    """
    entered, settled, release, made = (threading.Event(), threading.Event(),
                                       threading.Event(), [])

    class _LoadLockWatcher:
        """The engine's real load lock, except that a caller who finds it taken says so."""

        def __init__(self, real):
            self._real = real

        def __enter__(self):
            if not self._real.acquire(blocking=False):
                settled.set()           # the second caller is queued behind the first
                self._real.acquire()
            return self

        def __exit__(self, *exc):
            self._real.release()
            return False

    engine._load_lock = _LoadLockWatcher(engine._load_lock)

    in_loader = []                      # one entry per call that has reached the model loader

    class _Slow:
        sr = 24000

        @staticmethod
        def from_pretrained(device=None):
            in_loader.append(device)
            if len(in_loader) == 1:
                entered.set()           # the first caller has read "0 resident" by now
                release.wait(timeout=20)    # …and stays in here until the second has arrived
            else:
                settled.set()           # a second load of the same plan reached the loader
            made.append(device)
            return _Slow()

    mod = type(sys)("chatterbox.tts")
    mod.ChatterboxTTS = _Slow
    monkeypatch.setitem(sys.modules, "chatterbox.tts", mod)

    out = []
    threads = [threading.Thread(target=lambda: out.append(engine.load({"cuda:0": 1})))
               for _ in range(2)]
    threads[0].start()
    assert entered.wait(timeout=5), "the first load never reached the model loader"
    threads[1].start()                  # …into the middle of the first one
    # The second caller is now either QUEUED behind the first (the lock reported it) or has got
    # into the loader beside it (it reported that). Either way the ordering is settled, with no
    # clock involved; the first load is held open until it is.
    try:
        assert settled.wait(timeout=20), "the second load neither queued nor reached the loader"
    finally:
        release.set()
    for t in threads:
        t.join(timeout=20)

    assert made == ["cuda:0"], f"the model was loaded {len(made)} times for a plan of 1: {made}"
    assert engine.worker_counts() == {"cuda:0": 1}, (
        f"two concurrent loads of the same plan doubled the VRAM: {engine.worker_counts()}")
    assert out == [{"cuda:0": 1}, {"cuda:0": 1}]


def test_a_render_goes_to_the_card_requested_by_the_client(engine):
    """The client sends `device` on every render; the satellite must honor that selection.
    `_acquire` taking the first free replica in load order across ALL cards. On a two-card
    satellite two concurrent chunks then both landed on card 0 while card 1 idled — and worse,
    the rate recorded against `test-satellite:cuda:1` was a time achieved on card 0 under contention, so
    the governor plans a buffer floor from a card that did no work. §3.3's "a rate for a machine
    that does not exist", one level down.
    """
    engine.load({"cuda:0": 1, "cuda:1": 1})
    assert engine._acquire("", "cuda:1").device == "cuda:1"
    assert engine._acquire("", "cuda:0").device == "cuda:0"
    # A requested card with no replica falls back rather than failing:
    # the two boxes can legitimately disagree while a plan is being applied.
    assert engine._acquire("", "cuda:7") is not None
    assert engine._acquire("", None) is not None


def test_unload_during_a_load_does_not_resurrect_the_replica(engine, monkeypatch):
    """⏏ Unload empties `_replicas`; a load already in flight then appended its model on top,
    so the card kept holding a replica the panel had reported as released."""
    releasing, unloaded, made = threading.Event(), threading.Event(), []

    class _Slow:
        sr = 24000

        @staticmethod
        def from_pretrained(device=None):
            releasing.set()
            unloaded.wait(timeout=20)           # unload lands in here, and not before
            made.append(device)
            return _Slow()

    mod = type(sys)("chatterbox.tts")
    mod.ChatterboxTTS = _Slow
    monkeypatch.setitem(sys.modules, "chatterbox.tts", mod)

    t = threading.Thread(target=lambda: engine.load({"cuda:0": 1}))
    t.start()
    assert releasing.wait(timeout=5), "the load never reached the model loader"
    engine.unload()
    unloaded.set()                      # only now may the loader finish and return its model
    t.join(timeout=20)
    assert made == ["cuda:0"], (              # the model really was built — otherwise the
        "the loader never completed, so this proves nothing")   # assertion below is vacuous
    assert engine.worker_counts() == {}, "the released replica came back"


def test_cancel_of_an_unknown_request_is_a_clean_false(engine):
    """Idempotent and late-safe: a client canceling as a render finishes is a normal race, and
    must not surface as an error."""
    assert engine.cancel("never-existed") is False


# ── the security badge cannot lie ────────────────────────────────────────────

def test_plain_http_is_never_reported_as_verified():
    c = sc.SatelliteClient("test-satellite", "http://test-satellite.invalid:7880", b"\x00" * 32)
    assert not c.is_verified
    assert "HTTP" in c.security_note()


def test_tls_without_a_pin_is_not_verified():
    """🔴 The trap from §6: unpinned self-signed TLS is barely better than plain HTTP against an
    active attacker, so it must not present as secure."""
    c = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32)
    assert not c.is_verified
    assert "NOT pinned" in c.security_note()


def test_verification_off_is_never_reported_as_verified(tmp_path):
    """A UI that says 'HTTPS ✓' while verify=False is worse than plain http — it misreports and
    nobody looks twice."""
    pem = tmp_path / "test-satellite.pem"
    pem.write_text("x")
    c = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32,
                           cert=str(pem), verify=False)
    assert not c.is_verified


def test_a_pinned_tls_client_is_verified(tmp_path):
    pem = tmp_path / "test-satellite.pem"
    pem.write_text("x")
    c = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32, cert=str(pem))
    assert c.is_verified
    assert c.verify == str(pem)


# ── what a satellite reports it HAS, versus what it has loaded ───────────────

def test_available_devices_lists_cards_with_no_replica_on_them(engine, monkeypatch):
    """🔴 The chicken-and-egg m3 would have shipped with. `devices()` lists cards holding a
    replica, so an idle satellite reports none — and a card the Settings page never lists can
    never be ticked, which is the tick that causes the load."""
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)
    assert engine.devices() == [], "nothing is loaded yet"
    assert engine.available_devices() == ["cuda:0", "cuda:1"]


def test_available_devices_is_empty_without_cuda(engine, monkeypatch):
    """A satellite exists to lend a GPU; offering its CPU would offer something nobody picks."""
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    assert engine.available_devices() == []


# ── the Settings device rows ─────────────────────────────────────────────────

def _sat_settings(monkeypatch, store):
    monkeypatch.setattr(settings_mod, "load_app_settings", lambda: dict(store))
    import vocalis.runtime.satellites as sat_mod
    return sat_mod


def test_a_satellite_is_never_enabled_by_the_legacy_migration(app_settings):
    """🔴 `gpus: "all"` predates satellites entirely, so it cannot be a statement about one.
    Reading it as "yes, load a model onto the other machine too" takes an opt-in the user never
    gave, on hardware they may not have running."""
    app_settings.update({"gpus": "all", "workers_per_card": 2})
    got = {d["id"]: d for d in
           pool_mod.migrate_device_settings(["cuda:0", "test-satellite:cuda:0"])}
    assert got["cuda:0"]["enabled"] is True
    assert got["test-satellite:cuda:0"]["enabled"] is False, "migration opted a satellite in"


def test_migration_never_carries_a_worker_count_onto_any_row(app_settings):
    """`workers_per_card` is retired, and migration must not restore the old key.

    It used to seed every LOCAL row from this number (and deliberately gave a satellite 1,
    because the host's count is tuned for co-tenancy with SillyTavern and means nothing on another
    machine). Now no row gets a count at all. Asserted over both a local and a satellite id,
    because the old code took different branches for them and only one of them was the bug.
    """
    app_settings.update({"gpus": "all", "workers_per_card": 3})
    got = pool_mod.migrate_device_settings(["cuda:0", "test-satellite:cuda:0"])
    assert all("workers" not in row for row in got), got
    assert {d["id"] for d in got} == {"cuda:0", "test-satellite:cuda:0"}


def test_default_gpus_is_derived_from_the_device_list(app_settings):
    """🔴 The half-migration running the other way. `default_gpus()` feeds VoxCPM, the
    resemble-enhance card list, books and playground — none of them Chatterbox. Left reading the
    stale `gpus:` string, unticking a card would stop Chatterbox using it while those four kept
    loading onto it."""
    app_settings.update({"gpus": "all", "workers_per_card": 1,
                         "devices": [{"id": "cuda:0", "enabled": True, "workers": 1},
                                     {"id": "cuda:1", "enabled": False, "workers": 1}]})
    assert pool_mod._local_gpus_string() == "0"


def test_default_gpus_ignores_satellites(app_settings):
    """A `test-satellite:cuda:0` is meaningless to every caller of this, and `parse_devices` would mangle
    it — it understands only 'all' / 'cpu' / index lists."""
    app_settings["devices"] = [{"id": "cuda:1", "enabled": True, "workers": 1},
                               {"id": "test-satellite:cuda:0", "enabled": True, "workers": 3}]
    assert pool_mod._local_gpus_string() == "1"


def test_default_gpus_is_cpu_when_no_local_card_is_enabled(app_settings):
    app_settings["devices"] = [{"id": "cuda:0", "enabled": False, "workers": 1},
                               {"id": "test-satellite:cuda:0", "enabled": True, "workers": 3}]
    assert pool_mod._local_gpus_string() == "cpu"


def test_default_gpus_still_reads_the_legacy_key_before_migration(app_settings):
    app_settings["gpus"] = "0,1"
    assert pool_mod._local_gpus_string() == "0,1"


def test_an_unreachable_satellite_keeps_its_remembered_cards(monkeypatch):
    """An unreachable satellite is a normal state. Keep its remembered card and worker settings
    visible while it is offline."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880"}]})
    monkeypatch.setattr(sat_mod, "health",
                        lambda n: {"reachable": False, "error": "asleep", "devices": []})
    snap = sat_mod.snapshot(["test-satellite:cuda:0", "cuda:0"])
    assert [d["id"] for d in snap["devices"]] == ["test-satellite:cuda:0"]
    assert snap["devices"][0]["reachable"] is False
    assert snap["satellites"][0]["reachable"] is False


def test_a_satellite_never_reached_contributes_no_card_rows(monkeypatch):
    """Nothing on this box knows what cards it has, so it shows as the satellite being down —
    not as a satellite with zero cards."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880"}]})
    monkeypatch.setattr(sat_mod, "health", lambda n: {"reachable": False, "devices": []})
    snap = sat_mod.snapshot([])
    assert snap["devices"] == []
    assert len(snap["satellites"]) == 1


def test_snapshot_reports_cards_the_satellite_has_but_has_not_loaded(monkeypatch):
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880"}]})
    monkeypatch.setattr(sat_mod, "health", lambda n: {
        "reachable": True, "ready": False, "devices": [],
        "available_devices": ["cuda:0", "cuda:1"]})
    snap = sat_mod.snapshot([])
    assert [d["id"] for d in snap["devices"]] == ["test-satellite:cuda:0", "test-satellite:cuda:1"]
    assert all(d["reachable"] for d in snap["devices"])


class _FakeClient:
    """Records what was declared, so the assertion is about the PLAN, not about a return value
    a stub could fake."""

    def __init__(self):
        self.plans, self.unloads = [], 0

    def load(self, plan):
        self.plans.append(dict(plan))
        return dict(plan)

    def unload(self):
        self.unloads += 1
        return 1


def test_apply_plan_declares_each_satellites_total_once(monkeypatch):
    """WorkerPool calls remote_model once per worker slot, while the satellite's cold branch
    loads only when no sample rate is present. Declare the total plan once so all slots receive
    the intended remote replicas."""
    sat_mod = _sat_settings(monkeypatch, {})
    fake = _FakeClient()
    monkeypatch.setattr(sat_mod, "client_for", lambda n: fake)
    sat_mod.apply_plan({"cuda:0": 1, "test-satellite:cuda:0": 3, "test-satellite:cuda:1": 2})
    assert fake.plans == [{"cuda:0": 3, "cuda:1": 2}], "the satellite was not told its total"


def test_the_local_cards_question_has_exactly_one_public_answer():
    """Keep the helper names aligned with the distinction they represent.

    `default_gpus()` read like "the devices a render uses" and answered "which of THIS box's
    local CUDA cards may be used" — a different question whose answer is `'cpu'` once rendering
    has moved to a satellite. Removing the ambiguous helper prevents callers from using the local
    device answer as the render-device answer.
    """
    assert not hasattr(pool_mod, "default_gpus"), (
        "the ambiguous name is back — a caller can once again ask for local cards and be given "
        "something that reads like 'where a render runs'")
    assert callable(pool_mod.default_devices)        # where a render runs
    assert callable(pool_mod.local_cuda_devices)     # which of THIS box's cards are ticked
    assert pool_mod._local_gpus_string.__name__.startswith("_"), "the 'cpu' sentinel stays private"


def test_unticking_a_satellite_card_asks_for_zero_not_silence(monkeypatch):
    """An omitted card in a declarative plan must release its replica instead of leaving VRAM
    resident until an explicit unload."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite:7880", "secret": "aa" * 32}],
        "devices": [{"id": "cuda:0", "enabled": True, "workers": 1},
                    {"id": "test-satellite:cuda:0", "enabled": False, "workers": 2},
                    {"id": "test-satellite:cuda:1", "enabled": False, "workers": 1}]})
    fake = _FakeClient()
    monkeypatch.setattr(sat_mod, "client_for", lambda n: fake)

    sat_mod.reconcile({})                       # nothing satellite-side is ticked any more
    assert fake.plans == [{"cuda:0": 0, "cuda:1": 0}], (
        f"the satellite was never told to release anything: {fake.plans}")


def test_lowering_the_worker_count_releases_the_difference(monkeypatch):
    """Same rule one step in: 3 -> 1 must be sent as 1, not as nothing. `Engine.load` trims to
    the number it is given, so the release happens on the satellite the moment it hears."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite:7880", "secret": "aa" * 32}],
        "devices": [{"id": "test-satellite:cuda:0", "enabled": True, "workers": 1},
                    {"id": "test-satellite:cuda:1", "enabled": False, "workers": 4}]})
    fake = _FakeClient()
    monkeypatch.setattr(sat_mod, "client_for", lambda n: fake)

    sat_mod.reconcile({"test-satellite:cuda:0": 1})
    assert fake.plans == [{"cuda:0": 1, "cuda:1": 0}]


def test_a_pool_build_still_releases_a_card_it_dropped(monkeypatch):
    """The same zero-fill on the render path, for the satellite that IS in the plan: building a
    pool on one of its two cards must release the other rather than leaving it loaded."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite:7880", "secret": "aa" * 32}],
        "devices": [{"id": "test-satellite:cuda:0", "enabled": True, "workers": 1},
                    {"id": "test-satellite:cuda:1", "enabled": False, "workers": 1}]})
    fake = _FakeClient()
    monkeypatch.setattr(sat_mod, "client_for", lambda n: fake)

    sat_mod.apply_plan({"cuda:0": 2, "test-satellite:cuda:0": 1})
    assert fake.plans == [{"cuda:0": 1, "cuda:1": 0}]


def test_apply_plan_ignores_local_devices(monkeypatch):
    sat_mod = _sat_settings(monkeypatch, {})
    fake = _FakeClient()
    monkeypatch.setattr(sat_mod, "client_for", lambda n: fake)
    sat_mod.apply_plan({"cuda:0": 2, "cpu": 1})
    assert fake.plans == []


def test_an_unreachable_satellite_does_not_sink_the_plan(monkeypatch):
    """`apply_plan` reports rather than raises. A satellite may be offline, so this is the
    steady state, not an error.

    ⚠️ Named for what it actually covers. It used to be called
    `..._does_not_sink_the_pool_build` and never built a pool — see the test below, which does,
    and which failed when this one passed.
    """
    from satellite_client import SatelliteError
    sat_mod = _sat_settings(monkeypatch, {})

    def _boom(name):
        raise SatelliteError("not running")
    monkeypatch.setattr(sat_mod, "client_for", _boom)
    assert sat_mod.apply_plan({"test-satellite:cuda:0": 2}) == {}      # returned, not raised


def test_an_unreachable_satellite_does_not_sink_the_POOL(monkeypatch):
    """`remote_model()` raises `SatelliteUnreachable` when the remote host is offline;
    `WorkerPool.__init__` must preserve local workers instead of failing the whole build.
    Every render on the box failed while the satellite slept, which is §11.4's documented normal
    state. `remote_model`'s docstring claimed this was already handled the same way as a card
    that will not load. It was not.

    Builds a real `WorkerPool` with one local device and one satellite, with `load_model`
    faked — the seam the old test stopped short of.
    """
    from satellite_client import SatelliteUnreachable

    def _load(dev):
        if sc.is_remote(dev):
            raise SatelliteUnreachable(f"satellite {dev!r} is not reachable — start it")
        return _FakeModel()

    monkeypatch.setattr(tts_utils, "load_model", _load)
    pool = tts_utils.WorkerPool(["cuda:0", "test-satellite:cuda:0"], {"cuda:0": 2, "test-satellite:cuda:0": 3})
    assert [w["device"] for w in pool.workers] == ["cuda:0", "cuda:0"], (
        "the local card's workers must survive a satellite that is switched off")

    # …and prove that the skip is what saves it, rather than something incidental: disable the
    # guard and the identical build dies the way it used to.
    monkeypatch.setattr(tts_utils, "_satellite_asleep", lambda exc: False)
    with pytest.raises(SatelliteUnreachable):
        tts_utils.WorkerPool(["cuda:0", "test-satellite:cuda:0"], {"cuda:0": 2, "test-satellite:cuda:0": 3})


def test_a_satellite_only_pool_says_which_satellite_is_off(monkeypatch):
    """A satellite-only selection with the satellite down.
    There is nothing to render on, so this DOES fail; it must fail saying so. "no workers could
    be loaded on any device (out of memory?)" sends the reader to the wrong machine entirely.
    """
    from satellite_client import SatelliteUnreachable

    def _load(dev):
        raise SatelliteUnreachable("satellite 'test-satellite' is not reachable at https://test-satellite:7880")

    monkeypatch.setattr(tts_utils, "load_model", _load)
    with pytest.raises(tts_utils.VocalisError) as exc:
        tts_utils.WorkerPool(["test-satellite:cuda:0"], {"test-satellite:cuda:0": 1})
    msg = str(exc.value)
    assert "test-satellite:cuda:0" in msg and "Start the satellite" in msg, msg
    assert "out of memory" not in msg.lower(), msg


def test_unload_all_reaches_every_satellite(monkeypatch):
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880"}]})
    fake = _FakeClient()
    monkeypatch.setattr(sat_mod, "client_for", lambda n: fake)
    sat_mod.unload_all()
    assert fake.unloads == 1


def test_building_a_pool_declares_the_satellite_plan_before_any_worker(monkeypatch, fake_load):
    """The ordering is the point: a worker built before the plan lands would ask a satellite for
    a replica that does not exist yet."""
    seen = []
    monkeypatch.setattr(pool_mod, "_pool", None, raising=False)
    monkeypatch.setattr(pool_mod, "_pool_sig", None, raising=False)
    import vocalis.runtime.satellites as sat_mod
    monkeypatch.setattr(sat_mod, "apply_plan", lambda counts: seen.append(dict(counts)))
    monkeypatch.setattr(pool_mod, "WorkerPool",
                        lambda devices, workers: seen.append(("pool", list(devices))))
    pool_mod.get_pool(["cuda:0", "test-satellite:cuda:0"], {"cuda:0": 1, "test-satellite:cuda:0": 3})
    assert seen[0] == {"cuda:0": 1, "test-satellite:cuda:0": 3}, "the plan did not go first"
    assert seen[1][0] == "pool"


def test_a_purely_local_pool_never_touches_the_satellite_registry(monkeypatch, fake_load):
    """A local-only pool must not pay a registry read, let alone a probe, on
    every pool build."""
    called = []
    monkeypatch.setattr(pool_mod, "_pool", None, raising=False)
    monkeypatch.setattr(pool_mod, "_pool_sig", None, raising=False)
    import vocalis.runtime.satellites as sat_mod
    monkeypatch.setattr(sat_mod, "apply_plan", lambda counts: called.append(counts))
    monkeypatch.setattr(pool_mod, "WorkerPool", lambda devices, workers: object())
    pool_mod.get_pool(["cuda:0", "cpu"], {"cuda:0": 1, "cpu": 1})
    assert called == []


def test_an_older_satellite_without_available_devices_degrades(monkeypatch):
    """§4 declares versions rather than enforcing them, so an older satellite predates the key
    and must fall back to its loaded cards rather than taking the Settings page down."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880"}]})
    monkeypatch.setattr(sat_mod, "health",
                        lambda n: {"reachable": True, "devices": ["cuda:0"]})
    snap = sat_mod.snapshot([])
    assert [d["id"] for d in snap["devices"]] == ["test-satellite:cuda:0"]


# ── recovery must not re-create the m3 under-load bug ────────────────────────

def test_reload_declares_the_FULL_plan_not_one_replica(monkeypatch):
    """🔴 `Engine.load` is DECLARATIVE — the number is the total after the call. So a recovery
    that asked for "one more replica for this worker" would set the satellite's total to 1 and
    TRIM the replicas the other workers are using: the exact silent under-load `apply_plan` was
    written to fix, re-created inside the recovery path.

    This is why `satellites.reload` owns it and `RemoteModel` only delegates — a per-worker
    object cannot know the total, and that is precisely the mistake m3 already paid for once.
    """
    from vocalis.runtime import satellites as sat

    monkeypatch.setattr(sat, "client_for",
                        lambda name: type("C", (), {"health": lambda self: {"ready": False}})())
    monkeypatch.setattr(pool_mod, "default_workers",
                        lambda *_a, **_k: {"cuda:0": 1, "test-satellite:cuda:0": 3, "other:cuda:0": 2})
    monkeypatch.setattr(pool_mod, "default_devices",
                        lambda *_a, **_k: ["cuda:0", "test-satellite:cuda:0", "other:cuda:0"])
    seen = {}
    monkeypatch.setattr(sat, "apply_plan", lambda counts: seen.update(counts))
    sat.reload("test-satellite")
    assert seen == {"test-satellite:cuda:0": 3}, (
        "reload must send test-satellite's FULL count and nothing belonging to another satellite")


def test_reload_is_a_noop_when_another_thread_already_did_it(monkeypatch):
    """Every worker on that satellite discovers the 503 at the same instant, and `Engine.load`
    is not safe to run twice concurrently — two callers would each read 'none resident' and each
    load one, doubling the VRAM. First through does the work; the rest find it ready."""
    from vocalis.runtime import satellites as sat

    monkeypatch.setattr(sat, "client_for",
                        lambda name: type("C", (), {"health": lambda self: {"ready": True}})())
    called = []
    monkeypatch.setattr(sat, "apply_plan", lambda counts: called.append(counts))
    assert sat.reload("test-satellite") is True
    assert called == [], "it must not reload a satellite that is already ready"


# ── 7.4 / §17 · the configured VRAM cap ──────────────────────────────────────
#
# Enforcement is on the satellite (tests/test_satellite_batch.py). These are the two halves that
# have to be right on THIS side: the value survives being saved and read back, and it reaches the
# wire on both verbs that carry it.

@pytest.fixture
def sat_settings(monkeypatch, tmp_path):
    """A real read/write registry over a dict, so `update` → `configured` is the round trip a
    Save actually makes rather than two calls that never meet."""
    from vocalis.runtime import satellites as sat
    store = {"satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880",
                             "secret": "ab" * 32}]}
    monkeypatch.setattr(settings_mod, "load_app_settings", lambda: dict(store))
    monkeypatch.setattr(settings_mod, "save_app_settings", lambda s: store.update(s))
    sat.forget()                       # the client cache is keyed on the entry; start clean
    return store


def test_a_satellite_with_no_cap_is_uncapped_which_is_every_one_that_exists(sat_settings):
    from vocalis.runtime import satellites as sat
    assert sat.configured()[0]["vram_cap_gb"] == 0.0


@pytest.mark.parametrize("junk", ["eight", None, {}, "", "-4"])
def test_a_hand_edited_cap_that_is_not_a_number_reads_as_uncapped(sat_settings, junk):
    """🔴 `configured()` RUNS ON EVERY /devices GET and must never raise — its own docstring says
    so, because a malformed entry taking the Settings page down is how a typo becomes an outage.
    Junk here is "no cap", which is the safe direction: the satellite behaves as it does today."""
    from vocalis.runtime import satellites as sat
    sat_settings["satellites"][0]["vram_cap_gb"] = junk
    assert sat.configured()[0]["vram_cap_gb"] == 0.0


def test_saving_a_cap_round_trips_and_clearing_the_box_lifts_it(sat_settings):
    from vocalis.runtime import satellites as sat
    sat.update("test-satellite", vram_cap_gb="10.5")
    assert sat.configured()[0]["vram_cap_gb"] == 10.5
    sat.update("test-satellite", vram_cap_gb="")            # he cleared the box
    assert sat.configured()[0]["vram_cap_gb"] == 0.0


@pytest.mark.parametrize("bad,why", [("eight", "number"), ("-1", "negative"), ("99999", "larger")])
def test_a_typed_cap_that_makes_no_sense_is_REFUSED_rather_than_zeroed(sat_settings, bad, why):
    """⚠️ The opposite rule from `configured()`, deliberately. A settings READ must not raise; a
    SAVE is a person pressing a button, and silently turning what they typed into "no cap" is the
    worst of both — it looks like it worked and the ceiling is not there."""
    from vocalis.runtime import satellites as sat
    with pytest.raises(ValueError) as exc:
        sat.update("test-satellite", vram_cap_gb=bad)
    assert why in str(exc.value)
    assert sat.configured()[0]["vram_cap_gb"] == 0.0, "a refused save must change nothing"


def test_a_client_the_POOL_IS_HOLDING_sends_the_cap_that_is_in_settings_NOW(sat_settings):
    """`remote_model()` builds a `RemoteModel` per satellite worker, which retains its client for
    the pool lifetime. Updating settings must therefore update the held client. Otherwise
    `/capacity` may send a stale zero cap, where zero means uncapped, after `/load` sets a ceiling.

    ⚠️ AND REBUILDING ON AN EDIT IS NOT THE FIX — the first version of this test asserted a
    rebuild and passed while the bug was live. `_save` calls `forget()`, so a fresh client is
    built for whoever asks next while the pool goes on holding the one it already had.
    """
    from vocalis.runtime import satellites as sat
    held = sat.client_for("test-satellite")                  # what a worker captured at pool build
    assert held.vram_cap_gb == 0.0
    assert sat.client_for("test-satellite") is held, "an unchanged entry must not rebuild"
    sat.update("test-satellite", vram_cap_gb="12")
    assert held.vram_cap_gb == 12.0, "the client the POOL is holding must carry the new ceiling"
    sat.update("test-satellite", vram_cap_gb="")
    assert held.vram_cap_gb == 0.0, "and clearing the box must reach it as well"


def test_a_cap_the_registry_cannot_read_is_NO_cap_rather_than_a_failed_render(monkeypatch):
    """⚠️ Resolving the ceiling now means a settings read sits in front of every dispatch. It is
    the same read `client_for` already made on that path, and it cannot raise anyway
    (`configured()` is written not to) — but the failure direction still has to be chosen
    deliberately, and it is "no cap said", never "no render"."""
    def boom():
        raise RuntimeError("app_settings.yaml is a smoking hole")
    client = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32, vram_cap_gb=boom)
    assert client.vram_cap_gb == 0.0


def test_a_changed_url_still_rebuilds_the_client(sat_settings):
    """⚠️ The cap left the signature; the things that make a client point at a different MACHINE
    did not. A cached client for the old host would keep POSTing there after the URL was
    corrected, which is the failure `_forget_dial` exists to prevent one layer down."""
    from vocalis.runtime import satellites as sat
    first = sat.client_for("test-satellite")
    sat.update("test-satellite", url="https://test-satellite.invalid:7881")
    assert sat.client_for("test-satellite") is not first


def test_the_cap_is_on_the_wire_for_ALL_THREE_verbs_that_can_carry_it(monkeypatch):
    """🔴 `/load` sets the allocator bound, `/capacity` sizes the pass, and `/health` is the one
    that reaches a satellite which is doing NEITHER — loaded, idle, and waiting, which is the
    state a satellite may be in when an operator configures a ceiling, because the
    reason he types one is that he is about to use that machine for something else.

    Before the probe carried it, a cap set on an idle box landed on no verb at all: nothing on
    the wire, nothing in its log, and a row that said "not in effect there" and was right.
    """
    sent = []
    client = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32, vram_cap_gb=9.0)
    monkeypatch.setattr(client, "_post_json",
                        lambda path, obj, *a, **k: (sent.append((path, obj)), (200, {"take": 3}))[1])
    client.health()
    client.load({"cuda:0": 1})
    client.capacity("cuda:0", [400, 400])
    assert [p for p, _ in sent] == ["/satellite/health", "/satellite/load", "/satellite/capacity"]
    assert all(body.get("vram_cap_gb") == 9.0 for _, body in sent), sent


@pytest.mark.parametrize("reported,live,why", [
    ({"vram_cap_gb": 6.0}, 6.0, "it said 6 and it means 6"),
    ({"vram_cap_gb": 0.0}, 0.0, "1.11 answering 'uncapped' is a real answer"),
    ({}, None, "a satellite older than 1.11 has no opinion — that is NOT zero"),
])
def test_a_satellite_that_never_mentions_a_cap_is_a_THIRD_state_not_a_zero(monkeypatch, reported,
                                                                          live, why):
    """Distinguish a missing report from an explicit zero cap. Folding both into 0.0 could suggest
    a satellite update even when the setting is missing on the host side."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880", "vram_cap_gb": 6.0}]})
    monkeypatch.setattr(sat_mod, "health",
                        lambda n: {"reachable": True, "devices": [], **reported})
    row = sat_mod.snapshot([])["satellites"][0]
    assert row["vram_cap_gb"] == 6.0
    assert row["vram_cap_live"] == live, why


# ── 11.2: the per-satellite SillyTavern batch ceiling ────────────────────────
#
# 🔴 THE ENFORCEMENT IS NOT ON THE SATELLITE, unlike the VRAM cap above, and none of these tests
# looks for it on the wire. A pass can only be made out of chunks the card was GIVEN, so bounding
# the submission bounds the pass — which is why there is no protocol field, no satellite version
# to check, and no `_live` column in the Settings row. `tests/test_pool_batching.py` and
# `tests/test_pool_topup.py` hold the enforcement half; these are the save/read/reach halves.


def test_a_satellite_with_no_batch_setting_renders_one_chunk_at_a_time(sat_settings):
    """The default and the state for every already-configured satellite."""
    from vocalis.runtime import satellites as sat
    assert sat.configured()[0]["st_max_batch"] == 1


@pytest.mark.parametrize("junk", ["eight", None, {}, "", "-4", "0"])
def test_a_hand_edited_batch_size_that_is_not_a_number_reads_as_one(sat_settings, junk):
    """⚠️ **THE OPPOSITE DIRECTION FROM THE VRAM CAP'S JUNK RULE, AND THAT IS THE POINT.** Junk
    there becomes "no ceiling" because that is what the satellite already does; junk here becomes
    the ceiling that cannot make playback wait. Unreadable input should land on the conservative
    reading, and which reading is conservative differs per setting."""
    from vocalis.runtime import satellites as sat
    sat_settings["satellites"][0]["st_max_batch"] = junk
    assert sat.configured()[0]["st_max_batch"] == 1


def test_saving_a_batch_size_round_trips_and_clearing_the_box_is_one(sat_settings):
    from vocalis.runtime import satellites as sat
    sat.update("test-satellite", st_max_batch="8")
    assert sat.configured()[0]["st_max_batch"] == 8
    sat.update("test-satellite", st_max_batch="")           # he cleared the box
    assert sat.configured()[0]["st_max_batch"] == 1, \
        "there is no 'unlimited' reading of this box — 1 IS off"


@pytest.mark.parametrize("bad,why", [("three", "whole number"), ("0", "less than 1"),
                                     ("-2", "less than 1"), ("100", "more than 64")])
def test_a_typed_batch_size_that_makes_no_sense_is_REFUSED(sat_settings, bad, why):
    """Same rule as the cap beside it: a READ normalizes, a SAVE refuses. A number silently
    turned into something else is the failure that looks like success."""
    from vocalis.runtime import satellites as sat
    sat.update("test-satellite", st_max_batch="4")           # something to be preserved
    with pytest.raises(ValueError) as exc:
        sat.update("test-satellite", st_max_batch=bad)
    assert why in str(exc.value)
    assert sat.configured()[0]["st_max_batch"] == 4, "a refused save must change nothing"


def test_a_client_the_POOL_IS_HOLDING_uses_the_batch_size_in_settings_NOW(sat_settings):
    """🔴 THE SAME HOLDER PROBLEM AS THE VRAM CAP, AND IT HAD TO BE SOLVED THE SAME WAY. A
    `RemoteModel` is built once per satellite worker and keeps its client for the life of the
    pool, so a number frozen at construction would require a restart to change.
    """
    from vocalis.runtime import satellites as sat
    held = sat.client_for("test-satellite")                  # what a worker captured at pool build
    assert held.st_max_batch == 1
    sat.update("test-satellite", st_max_batch="6")
    assert held.st_max_batch == 6, "the client the POOL is holding must carry the new ceiling"
    sat.update("test-satellite", st_max_batch="")
    assert held.st_max_batch == 1, "and clearing the box must reach it as well"


def test_a_batch_size_the_registry_cannot_read_is_ONE_rather_than_a_wide_batch():
    """⚠️ The failure direction, chosen deliberately as it was for the cap — and it is the other
    way round here. A settings read that blew up must not leave the dispatch batching eight."""
    def boom():
        raise RuntimeError("app_settings.yaml is a smoking hole")
    client = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32, st_max_batch=boom)
    assert client.st_max_batch == 1


def test_the_batch_ceiling_can_only_ever_LOWER_what_the_card_published(monkeypatch):
    """🔴 A TYPED NUMBER MUST NOT BE ABLE TO MAKE A CARD TAKE MORE THAN IT SAID IT WOULD. The two
    numbers are the same KIND — how many queued chunks to hand over at once — so the smaller wins,
    and the dispatch reads one value rather than deciding which rule applied."""
    client = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32, st_max_batch=64)
    model = sc.RemoteModel(client, "cuda:0", 24000, caps=["batch_render"], max_batch=8)
    assert model.batch_slice == 8
    assert model.st_batch_slice == 8, "the card's own ceiling still holds"
    client._st_batch = 3
    assert model.st_batch_slice == 3, "and the configured value lowers it"


def test_the_batch_ceiling_is_not_on_the_wire(monkeypatch):
    """📌 THE ABSENCE IS THE DESIGN, ASSERTED. Adding it to a verb later is not a small change: the
    satellite's own sizer would then have two ceilings to reconcile, and an older satellite would
    ignore the field while Settings claimed the setting was in effect — the exact shape of the
    earlier VRAM-cap behavior. Enforcement stays on this side; this is what says so."""
    sent = []
    client = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32, st_max_batch=4)
    monkeypatch.setattr(client, "_post_json",
                        lambda path, obj, *a, **k: (sent.append((path, obj)), (200, {"take": 3}))[1])
    client.health()
    client.load({"cuda:0": 1})
    client.capacity("cuda:0", [400])
    assert sent, "the fake never saw a request"
    assert not any("st_max_batch" in body for _, body in sent), sent


def test_the_settings_row_carries_the_batch_size(monkeypatch):
    """What ⚙ Settings ▸ Devices draws the box from. No `_live` twin, on purpose — see the banner
    above: there is nothing on the other machine that can disagree with this one."""
    sat_mod = _sat_settings(monkeypatch, {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880", "st_max_batch": 5}]})
    monkeypatch.setattr(sat_mod, "health", lambda n: {"reachable": True, "devices": []})
    row = sat_mod.snapshot([])["satellites"][0]
    assert row["st_max_batch"] == 5
    assert "st_max_batch_live" not in row


def test_an_uncapped_satellite_still_says_so_on_every_verb(monkeypatch):
    """⚠️ 0.0 is SENT, never omitted. `/load` and `/capacity` read absence as "uncapped" anyway,
    but `/health` deliberately does not — a probe must not be able to revoke a ceiling — so a
    cleared box has to arrive as an explicit zero or the satellite would keep the old one."""
    sent = []
    client = sc.SatelliteClient("test-satellite", "https://test-satellite.invalid:7880", b"\x00" * 32)
    monkeypatch.setattr(client, "_post_json",
                        lambda path, obj, *a, **k: (sent.append((path, obj)), (200, {"take": 1}))[1])
    client.health()
    assert sent[0][1] == {"vram_cap_gb": 0.0}
