"""Tests for the 4.8-m1 VoxCPM2 engine (src/voxcpm.py) + the per-model load/unload routes.

The Worker is exercised against a FAKE worker script speaking the real line protocol
via sys.executable — the lifecycle, the request/response discipline, and the failure
paths run for real (a real child process), with no torch and no voxcpm venv on the box.
"""
import json
import os
import sys
import time
from pathlib import Path

import pytest

import vault_fs
import engine_process
import voxcpm
import vocalis_server as vs
from vocalis.runtime import enhancement as rt_enh
from vocalis.runtime import voice_batch as rt_voice_batch
from vocalis.runtime import voice_templates as rt_voice_templates
import vocalis.runtime.voxcpm_pool as rt_voxpool
import vocalis.runtime.configs as rt_configs
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.pool as rt_pool
# Patch the GPU helpers in their owning module; server aliases are no longer the callers.
from vocalis.runtime import gpu as gpu_mod
# Design-job helpers are owned by the Voices blueprint, so patch that module directly.
from vocalis.web import voices as web_voices


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _vox_isolation(monkeypatch):
    """Per-test isolation, both directions: no test may see the HOST's ~/voxcpm-venv
    (the suite must never read the host — the cache_root lesson), and no test may leak
    a resident worker or a loading flag into the next."""
    monkeypatch.setenv("VOCALIS_VOXCPM_VENV", str(Path("Z:/definitely-not-here/venv")))
    yield
    vs.VOX.stop()
    vs.VOX._loading_n = 0        # a COUNT since 5.1-P3.7a — see _vox_loading_n's note
    _reset_design_batch()


def _reset_design_batch():
    """Drop the module-level design batch, the same way VOX is dropped above — and for the
    same reason, in the one place that was still missing it.

    `web_voices._BATCH` and `_BATCH_JOB` are process globals with a background runner thread
    behind them (voices.py:540-545). `_batch()` rebuilds only when `paths.VOICE_CANDIDATES`
    MOVES, so two tests that share a candidates root share the batch object — and nothing
    reset it between them. A test that ended with a batch still `running` therefore left the
    NEXT test polling a batch that was already running and could never settle: `_batch_wait`
    times out at 30 s and reports "the batch never settled", blaming a test that did nothing
    wrong. Intermittent, because it depends entirely on which tests xdist packs into this
    worker — which is exactly how it presented (one failure in a 16-worker run,
    passing in 6.3 s in isolation, and it held up a deploy).

    Cancel the round in flight, clear the flag, then drop both globals so the next test
    builds a fresh batch. A runner thread that outlives this writes into an object nobody
    reads any more, which is harmless; the point is that the NEXT test never sees it.
    """
    with web_voices._BATCH_LOCK:
        job, batch = web_voices._BATCH_JOB, web_voices._BATCH
    if job is not None and not job.cancel.is_set():
        job.cancel.set()
    if batch is not None:
        try:
            batch.set_running(False)
        except Exception:
            pass                  # a teardown whose tmp_path is already gone must not fail the test
    with web_voices._BATCH_LOCK:
        web_voices._BATCH = None
        web_voices._BATCH_JOB = None


# ── resolve_config: env -> settings -> default ───────────────────────────────

def _clear_voxcpm_env(monkeypatch):
    """resolve_config reads these overrides first; the packaged image sets them in its ENV, so a
    test of the defaults must clear them or it reports the image's paths instead."""
    for name in ("VOCALIS_VOXCPM_VENV", "VOCALIS_VOXCPM_MODEL", "VOCALIS_VOXCPM_HF_HOME",
                 "VOCALIS_VOXCPM_IDLE_S"):
        monkeypatch.delenv(name, raising=False)


def test_resolve_config_default(monkeypatch, tmp_path):
    _clear_voxcpm_env(monkeypatch)
    c = voxcpm.resolve_config({}, base_dir=tmp_path)
    # Platform-agnostic on purpose (this suite runs on both Linux and Windows):
    # the expected path is whatever engine_process.venv_python() says THIS box's layout is, not
    # a hardcoded "bin"/"python" literal that only held on POSIX.
    assert c.python == engine_process.venv_python(voxcpm.DEFAULT_VENV)
    assert c.script == tmp_path / "scripts" / "voxcpm" / "worker.py"
    assert c.model == str(voxcpm.DEFAULT_MODEL_DIR)
    assert c.hf_home == ""


def test_resolve_config_settings_beat_default(monkeypatch, tmp_path):
    _clear_voxcpm_env(monkeypatch)
    pinned_model = tmp_path / voxcpm.MODEL_REVISION
    c = voxcpm.resolve_config({"voxcpm": {"venv": str(tmp_path / "vv"), "model": str(pinned_model),
                                          "hf_home": "/models/hf"}}, base_dir=tmp_path)
    assert c.python == engine_process.venv_python(tmp_path / "vv")
    assert c.model == str(pinned_model)
    assert c.hf_home == "/models/hf"


def test_resolve_config_env_beats_settings(monkeypatch, tmp_path):
    monkeypatch.setenv("VOCALIS_VOXCPM_VENV", str(tmp_path / "envv"))
    c = voxcpm.resolve_config({"voxcpm": {"venv": "/from-file"}}, base_dir=tmp_path)
    assert c.python == engine_process.venv_python(tmp_path / "envv")


def test_resolve_config_survives_a_hand_edited_scalar(tmp_path):
    c = voxcpm.resolve_config({"voxcpm": "oops"}, base_dir=tmp_path)
    assert c.model == str(voxcpm.DEFAULT_MODEL_DIR)


def test_model_snapshot_must_be_the_complete_pinned_local_directory(tmp_path):
    c = voxcpm.resolve_config({}, base_dir=tmp_path)
    assert not c.model_ready
    assert c.model_missing_files == voxcpm.MODEL_FILES

    model = tmp_path / voxcpm.MODEL_REVISION
    model.mkdir()
    for name in voxcpm.MODEL_FILES:
        (model / name).write_bytes(b"fixture")
    c.model = str(model)
    assert c.model_ready
    (model / "model.safetensors").unlink()
    assert not c.model_ready and "model.safetensors" in c.model_missing_files

    c.model = "openbmb/VoxCPM2"
    assert not c.model_ready


def test_available_requires_python_and_script(monkeypatch, tmp_path):
    monkeypatch.delenv("VOCALIS_VOXCPM_VENV", raising=False)   # the isolation fixture set it
    c = voxcpm.resolve_config({"voxcpm": {"venv": str(tmp_path / "venv")}}, base_dir=tmp_path)
    assert not c.available                       # neither exists
    py = c.python                                 # wherever THIS box's venv_python() puts it
    py.parent.mkdir(parents=True)
    py.write_text("")
    assert not c.available                       # venv alone is not a toolchain
    sc = tmp_path / "scripts" / "voxcpm" / "worker.py"
    sc.parent.mkdir(parents=True)
    sc.write_text("")
    assert not c.available                         # a runtime without its pinned model is not ready
    model = tmp_path / voxcpm.MODEL_REVISION
    model.mkdir()
    for name in voxcpm.MODEL_FILES:
        (model / name).write_bytes(b"fixture")
    c.model = str(model)
    assert c.available


def test_venv_python_windows_and_posix():
    """The helper itself (engine_process.venv_python), both branches — mutation-proof against
    resolve_config silently going back to a hardcoded 'bin'/'python'. Driven by the
    injectable `windows` flag rather than monkeypatching os.name: this pathlib picks
    WindowsPath/PosixPath from the REAL os.name on every Path(...) construction, and
    instantiating the other platform's concrete class raises NotImplementedError ("cannot
    instantiate 'PosixPath' on your system", measured on this Windows box) — os.name
    monkeypatching would crash before the branch under test ever ran."""
    base = Path("/some/venv")
    assert engine_process.venv_python(base, windows=True) == base / "Scripts" / "python.exe"
    assert engine_process.venv_python(base, windows=False) == base / "bin" / "python"
    # And the real default: this box's actual os.name, unforced.
    assert engine_process.venv_python(base) == engine_process.venv_python(base, windows=os.name == "nt")


# ── the Worker against a fake child speaking the real protocol ───────────────

FAKE_WORKER = r"""
import json, sys
print('VOXCPM_READY {"sample_rate": 48000, "device": "cuda:0"}', flush=True)
sys.stderr.write("fake voxcpm noise\n"); sys.stderr.flush()
for line in sys.stdin:
    req = json.loads(line)
    if req.get("text") == "boom":
        print("VOXCPM_RES " + json.dumps({"id": req["id"], "ok": False, "error": "kaboom"}), flush=True)
        continue
    open(req["out"], "wb").write(b"RIFF0000WAVE")
    print("VOXCPM_RES " + json.dumps({"id": req["id"], "ok": True, "out": req["out"],
                                      "duration_s": 1.0, "compute_s": 0.1}), flush=True)
"""

DEAD_WORKER = r"""
import sys
sys.stderr.write("Traceback: the model is a lie\n")
sys.exit(3)
"""

# LOADS slowly (ready comes late) but answers at once — the window m2e opened, where a cancel
# lands while the engine is still starting up and there is no child to kill yet.
SLOW_LOAD_WORKER = r"""
import json, sys, time
time.sleep(2)
print('VOXCPM_READY {"sample_rate": 48000}', flush=True)
for line in sys.stdin:
    req = json.loads(line)
    open(req["out"], "wb").write(b"RIFF0000WAVE")
    print("VOXCPM_RES " + json.dumps({"id": req["id"], "ok": True, "out": req["out"],
                                      "duration_s": 1.0, "compute_s": 0.1}), flush=True)
"""

# Answers slowly, so a design job can be canceled mid-generate (the cancel kills the child).
SLOW_WORKER = r"""
import json, sys, time
print('VOXCPM_READY {"sample_rate": 48000}', flush=True)
for line in sys.stdin:
    req = json.loads(line)
    time.sleep(30)
    open(req["out"], "wb").write(b"RIFF0000WAVE")
    print("VOXCPM_RES " + json.dumps({"id": req["id"], "ok": True, "out": req["out"],
                                      "duration_s": 1.0, "compute_s": 0.1}), flush=True)
"""


def _fake_cfg(tmp_path, body=FAKE_WORKER) -> voxcpm.VoxcpmConfig:
    script = tmp_path / "fake_worker.py"
    script.write_text(body, encoding="utf-8")
    model = tmp_path / voxcpm.MODEL_REVISION
    model.mkdir(exist_ok=True)
    for name in voxcpm.MODEL_FILES:
        (model / name).write_bytes(b"fixture")
    return voxcpm.VoxcpmConfig(python=Path(sys.executable), script=script,
                               model=str(model))


def test_worker_lifecycle_and_generate(tmp_path):
    w = voxcpm.Worker(_fake_cfg(tmp_path), "cuda:0")
    w.start()
    w.wait_ready(timeout=30)
    assert w.ready and w.sample_rate == 48000
    out = tmp_path / "clip.wav"
    res = w.generate("(a warm voice)hello", out, seed=7, timeout=30)
    assert res["ok"] and out.is_file()
    # requests are serial and id-matched — a second one still lands
    res2 = w.generate("(a warm voice)again", tmp_path / "c2.wav", seed=8, timeout=30)
    assert res2["id"] > res["id"]
    w.stop()
    assert not w.alive
    w.stop()                                     # idempotent


def test_worker_generation_error_raises_and_worker_survives(tmp_path):
    w = voxcpm.Worker(_fake_cfg(tmp_path), "cuda:0")
    w.start()
    w.wait_ready(timeout=30)
    with pytest.raises(voxcpm.VoxcpmError, match="kaboom"):
        w.generate("boom", tmp_path / "x.wav", seed=1, timeout=30)
    assert w.alive                               # one bad request must not kill the worker
    res = w.generate("(ok)fine", tmp_path / "y.wav", seed=2, timeout=30)
    assert res["ok"]
    w.stop()


def test_worker_death_reports_stderr_tail(tmp_path):
    w = voxcpm.Worker(_fake_cfg(tmp_path, DEAD_WORKER), "cuda:0")
    w.start()
    with pytest.raises(voxcpm.VoxcpmError, match="the model is a lie"):
        w.wait_ready(timeout=30)
    assert not w.ready


def test_generate_before_ready_refuses(tmp_path):
    w = voxcpm.Worker(_fake_cfg(tmp_path), "cuda:0")
    with pytest.raises(voxcpm.VoxcpmError, match="not loaded"):
        w.generate("(x)y", tmp_path / "z.wav", seed=1)


# ── the routes: which=chatterbox|voxcpm|all ──────────────────────────────────

def _copy_freeze(src, dst, device=None, cancel=None):
    import shutil
    shutil.copyfile(src, dst)


def _raise_canceled(src, dst, device=None, cancel=None):
    raise web_voices._DesignCanceled()


def _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0",), body=FAKE_WORKER):
    cfg = _fake_cfg(tmp_path, body)
    monkeypatch.setattr(rt_configs, "voxcpm_cfg", lambda: cfg)
    # Patch the device helpers where the active pool and route code read them; the server
    # no longer consumes a parse_devices binding.
    monkeypatch.setattr(rt_voxpool.chatterbox_pool, "local_cuda_devices",
                        lambda *_a, **_k: list(devices))
    monkeypatch.setattr(gpu_mod, "cards_emptiest_first", lambda cards: list(cards))
    # The worker has no vault key, so candidates stay in scratch. Redirect the scratch
    # root to preserve the production path shape.
    monkeypatch.setattr(rt_configs, "scratch_root", lambda: tmp_path / "scratch")
    # The fake worker emits non-audio bytes. Stub only the freeze step; route tests still
    # exercise job lifecycle, claim/yield, provenance, and naming.
    monkeypatch.setattr(web_voices, "_design_freeze", _copy_freeze)
    monkeypatch.setattr(rt_enh, "enhance_available", lambda: True)
    monkeypatch.setattr(web_voices, "_design_unavailable", lambda: None)
    return cfg


def _design(client, body, timeout=15):
    """POST /voices/design and poll to a terminal state — Generate is a background job now
    (m2b), so the tests drive it exactly as the UI does. Returns the final /status json, or
    the raw response when the request answered synchronously (a 4xx before the job starts)."""
    r = client.post("/voices/design", json=body)
    if r.status_code != 202:
        return r
    jid = r.get_json()["job_id"]
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        s = client.get("/voices/design/status/" + jid).get_json()
        if s["status"] != "running":
            return s
        time.sleep(0.05)
    raise AssertionError("design job never reached a terminal state")


def _wait_vox_devices(n, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        with vs.VOX._lock:
            if sum(1 for w in vs.VOX._workers.values() if w.ready) >= n:
                return True
        time.sleep(0.05)
    return False


def _wait_vox_ready(timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if vs.VOX.ready():
            return True
        time.sleep(0.05)
    return False


def test_health_reports_voxcpm_block(client):
    j = client.get("/health").get_json()
    assert j["voxcpm"] == {"available": False, "ready": False, "loading": False, "devices": []}


def test_model_routes_reject_unknown_which(client):
    assert client.post("/model/load", json={"which": "gpt"}).status_code == 400
    assert client.post("/model/unload", json={"which": "gpt"}).status_code == 400


def test_load_voxcpm_reports_missing_pinned_model_snapshot(client, monkeypatch, tmp_path):
    monkeypatch.setenv("VOCALIS_VOXCPM_VENV", str(tmp_path / "venv"))
    cfg = voxcpm.resolve_config({"voxcpm": {"venv": str(tmp_path / "venv")}},
                                base_dir=tmp_path)
    cfg.python.parent.mkdir(parents=True)
    cfg.python.write_text("", encoding="utf-8")
    cfg.script.parent.mkdir(parents=True)
    cfg.script.write_text("", encoding="utf-8")
    monkeypatch.setattr(rt_configs, "voxcpm_cfg", lambda: cfg)
    r = client.post("/model/load", json={"which": "voxcpm"})
    assert r.status_code == 503
    j = r.get_json()
    assert j["error"] == "voxcpm_unavailable"
    assert "pinned VoxCPM2 model snapshot" in j["message"]


def test_load_voxcpm_without_a_gpu_refuses(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    # Through the helper that owns "which of THIS box's cards" — see the note in _wire_fake_vox.
    # No local CUDA card, which is what a CPU-only box answers.
    monkeypatch.setattr(rt_voxpool.chatterbox_pool, "local_cuda_devices", lambda *_a, **_k: [])
    r = client.post("/model/load", json={"which": "voxcpm"})
    assert r.status_code == 501 and r.get_json()["error"] == "no_gpu"


def test_load_voxcpm_while_a_load_is_in_flight_says_loading_not_already(client, monkeypatch,
                                                                       tmp_path):
    """🔴 5.1.1: the THIRD state — cards missing, but another POST already holds the ticket.

    `/model/load` had three answers pre-refactor: kicked a load, nothing to do, or "a load is
    already in flight". P3.8's `claim_load` returns [] for the last two alike, so the branch
    that produced the third answer went unreachable and a mid-load POST replied
    `already: true, voxcpm_ready: false` — which the old route could never emit, since
    `already` meant "it is loaded". Both UI callers discard the body, so nothing looked wrong.

    Hold the ticket with no worker resident, which is exactly the in-flight shape."""
    _wire_fake_vox(monkeypatch, tmp_path)
    assert not vs.VOX.ready(), "fixture should start with no resident worker"
    vs.VOX.loading_begin()                    # stand in for the POST that got there first
    try:
        j = client.post("/model/load", json={"which": "voxcpm"}).get_json()
        assert j["ok"] and j.get("voxcpm_loading") is True
        assert j.get("already") is not True, "a load in flight is not 'already loaded'"
    finally:
        vs.VOX.loading_end()


def test_load_and_unload_voxcpm_end_to_end(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    j = client.post("/model/load", json={"which": "voxcpm"}).get_json()
    assert j["ok"] and j["voxcpm_loading"] is True
    assert _wait_vox_ready(), "worker never became ready"
    h = client.get("/health").get_json()
    assert h["voxcpm"]["ready"] is True and h["voxcpm"]["devices"] == ["cuda:0"]
    # loaded → load again says already
    j2 = client.post("/model/load", json={"which": "voxcpm"}).get_json()
    assert j2.get("already") is True and j2.get("voxcpm_ready") is True
    # unload only voxcpm — chatterbox's state is untouched by design
    j3 = client.post("/model/unload", json={"which": "voxcpm"}).get_json()
    assert j3["ok"] and j3["voxcpm_ready"] is False
    assert not vs.VOX.ready()


def test_unload_voxcpm_needs_no_gpu_gate(client, monkeypatch, tmp_path):
    """A render holds every card — the VoxCPM2 unload must still work: its worker is
    idle by definition in m1, and killing it never touches what the render owns."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    assert vs.GPUS.acquire(timeout=2)
    try:
        r = client.post("/model/unload", json={"which": "voxcpm"})
        assert r.status_code == 200 and r.get_json()["voxcpm_ready"] is False
        # ...while the chatterbox (and all) unloads still refuse mid-render
        assert client.post("/model/unload", json={"which": "all"}).status_code == 409
    finally:
        vs.GPUS.release()


def test_default_which_is_the_pre48_contract(client, monkeypatch, tmp_path):
    """No `which` → chatterbox, untouched responses: no voxcpm keys sneak in."""
    _wire_fake_vox(monkeypatch, tmp_path)
    rt_pool._pool = object()                          # "already loaded" — no real preload spawns
    try:
        j = client.post("/model/load", json={}).get_json()
        assert j["model_ready"] is True and j["already"] is True
        assert "voxcpm_loading" not in j and "voxcpm_ready" not in j
        assert not vs.VOX.loading()
    finally:
        rt_pool._pool = None


def test_load_voxcpm_loads_one_worker_per_card(client, monkeypatch, tmp_path):
    """Two cards → two workers, so the blank-seed two-at-once path is live (§7.2)."""
    _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0", "cuda:1"))
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_devices(2), "both workers never came up"
    assert client.get("/health").get_json()["voxcpm"]["devices"] == ["cuda:0", "cuda:1"]


def test_two_overlapping_loaders_do_not_clear_each_others_loading_flag():
    """🔴 5.1-P3.7a. `loading` was ONE BOOL and TWO paths set it — POST /model/load and the
    post-cancel self-heal in /voices/design/cancel — while only the first checks whether a load
    is already running. So they overlap, and whichever finished first cleared the flag for both:
    /health then reported `loading: false` with a reload still in flight, which is exactly the
    "model unloaded, here is a live Load button" state the flag exists to prevent. Clicking it
    starts a third loader — harmless per card, since `_vox_ensure` refuses a second worker on a
    card, but ~11 s of pointless work off the back of a UI that said something untrue.

    A lock would not have fixed it. One bool cannot count two loaders, so it is a count now.

    Driven at the flag rather than through two real loads: the bug is entirely in the
    begin/end bookkeeping, and a threaded reproduction would be pinning the scheduler.
    """
    vs.VOX._loading_n = 0
    vs.VOX.loading_begin()                       # loader A (say, /model/load)
    vs.VOX.loading_begin()                       # loader B (the post-cancel self-heal)
    assert vs.VOX.loading()
    vs.VOX.loading_end()                         # A finishes first
    assert vs.VOX.loading(), \
        "the first loader to finish cleared the flag while the second was still loading"
    vs.VOX.loading_end()                         # B finishes
    assert not vs.VOX.loading()

    # And it cannot go negative: a stray end() must not make a later real load invisible.
    vs.VOX.loading_end()
    vs.VOX.loading_begin()
    assert vs.VOX.loading()
    vs.VOX.loading_end()
    assert not vs.VOX.loading()


def test_a_background_load_counts_itself_exactly_once():
    """The other half, and the trap a naive counter walks straight into: the ROUTE takes the
    ticket before starting the thread (so a second POST in the gap cannot kick a duplicate),
    which means `_vox_ensure` must not count the same load again. If it did, the count would
    never return to zero and /health would say `loading` forever."""
    vs.VOX._loading_n = 0
    vs.VOX.loading_begin()                       # what the route does before Thread().start()
    vs.VOX.load_bg([])                           # no devices: pure bookkeeping, no worker
    assert vs.VOX._loading_n == 0, \
        f"the background load leaked the count ({vs.VOX._loading_n}) — /health is stuck loading"


# ── Create a voice (m2): generate → audition → freeze ────────────────────────

def test_design_self_loads_a_cold_engine(client, monkeypatch, tmp_path):
    """4.8-m2e: Generate no longer refuses when VoxCPM2 is cold — it loads it and gets on
    with the job. It HAS to: the reaper unloads an idle engine out from under the user, so
    a 'load it first' refusal would turn Generate into a dead button after ten quiet
    minutes. The load is narrated in the job log, where the rest of the progress lives."""
    _wire_fake_vox(monkeypatch, tmp_path)
    assert not vs.VOX.ready()                       # cold: nothing was ever loaded
    s = _design(client, {"prompt": "a warm voice", "sample_text": "hello", "seed": "5"})
    assert s["status"] == "done" and len(s["candidates"]) == 1
    assert any("starting VoxCPM2" in ln for ln in s["log"]), s["log"]
    assert vs.VOX.ready()                           # ...and it stayed up for the next one


def test_design_requires_sample_text(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    r = client.post("/voices/design", json={"prompt": "a warm voice", "sample_text": "  "})
    assert r.status_code == 400


def test_design_blank_seed_generates_two_distinct(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0", "cuda:1"))
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_devices(2)
    s = _design(client, {"prompt": "a warm voice", "sample_text": "hello there"})
    assert s["status"] == "done"
    cands = s["candidates"]
    assert len(cands) == 2
    assert cands[0]["seed"] != cands[1]["seed"]          # two distinct random draws
    assert {c["device"] for c in cands} == {"cuda:0", "cuda:1"}   # one per card
    for c in cands:                                       # each audition clip is fetchable
        assert client.get(c["url"]).status_code == 200


def test_design_draws_one_per_free_card_not_a_hardcoded_two(client, monkeypatch, tmp_path):
    """Candidate count follows the number of free cards. A four-card fixture verifies the result is not hard-coded to two."""
    _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0", "cuda:1", "cuda:2", "cuda:3"))
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_devices(4)
    s = _design(client, {"sample_text": "hello there"})
    assert s["status"] == "done"
    assert len(s["candidates"]) == 4, "four free cards must draw four candidates"
    assert {c["device"] for c in s["candidates"]} == {"cuda:0", "cuda:1", "cuda:2", "cuda:3"}
    assert len({c["seed"] for c in s["candidates"]}) == 4      # four distinct draws


def test_design_on_a_one_card_box_draws_exactly_one(client, monkeypatch, tmp_path):
    """With one local card, design produces exactly one candidate and does not assume a fixed two-card system."""
    _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0",))
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    r = client.post("/voices/design", json={"sample_text": "hello"})
    assert r.status_code == 202 and r.get_json()["n"] == 1     # the UI renders this number
    jid = r.get_json()["job_id"]
    end = time.monotonic() + 20
    while time.monotonic() < end:
        s = client.get("/voices/design/status/" + jid).get_json()
        if s["status"] != "running":
            break
        time.sleep(0.05)
    assert s["status"] == "done" and len(s["candidates"]) == 1


def test_design_filled_seed_generates_one(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0", "cuda:1"))
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_devices(2)
    s = _design(client, {"sample_text": "hello", "seed": 4242})
    assert s["status"] == "done"
    assert len(s["candidates"]) == 1 and s["candidates"][0]["seed"] == 4242


def test_design_yields_to_a_render(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    assert vs.GPUS.acquire(timeout=2)                    # a render owns every card
    try:
        r = client.post("/voices/design", json={"sample_text": "hi"})
        assert r.status_code == 409 and r.get_json()["error"] == "cards_busy"
    finally:
        vs.GPUS.release()


def test_design_audio_404s_on_bad_or_missing_token(client):
    assert client.get("/voices/design/audio/not-a-token").status_code == 404
    assert client.get("/voices/design/audio/" + "a" * 32).status_code == 404


def test_design_save_places_the_candidate_into_the_voices_store(client, monkeypatch, tmp_path):
    """Save is an INSTANT copy now — the candidate was already frozen at generate time (no GPU
    claim at save). Validation + naming + collision still behave exactly like an upload."""
    _wire_fake_vox(monkeypatch, tmp_path)
    voices = tmp_path / "voice_samples"; voices.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _design(client, {"sample_text": "hello"})["candidates"][0]["token"]
    j = client.post("/voices/design/save", json={"token": tok, "name": 'TestVoice1'}).get_json()
    assert j["name"] == 'TestVoice1.wav' and (voices / 'TestVoice1.wav').is_file()
    assert j["label"] == 'TestVoice1'                    # the label is the identity (§14.2)
    assert vault_fs.exists(web_voices._design_candidates() / (tok + ".wav"))
    # 🔴 A second save under the same name is REJECTED, full stop — there is no overwrite
    # anywhere any more (§14.9.1). Passing the old overwrite flag must not resurrect it.
    tok2 = _design(client, {"sample_text": "hello"})["candidates"][0]["token"]
    r = client.post("/voices/design/save", json={"token": tok2, "name": 'TestVoice1'})
    assert r.status_code == 409 and r.get_json()["error"] == "exists"
    assert client.post("/voices/design/save",
                       json={"token": tok2, "name": 'TestVoice1', "overwrite": True}).status_code == 409
    # ...and a created voice collides with an UPLOADED one too — one namespace, both tabs.
    (voices / 'UploadedVoice.wav').write_bytes(b"RIFF0000WAVE")
    r = client.post("/voices/design/save", json={"token": tok2, "name": 'UploadedVoice'})
    assert r.status_code == 409 and "uploaded voice" in r.get_json()["message"].lower()


def test_design_save_demands_a_name(client, monkeypatch, tmp_path):
    """A designed voice has nothing to fall back on, so there is NO default name (§14.2) —
    "voice" would teach the user nothing about who it is when they meet it in a picker later."""
    _wire_fake_vox(monkeypatch, tmp_path)
    voices = tmp_path / "voice_samples"; voices.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _design(client, {"sample_text": "hello"})["candidates"][0]["token"]
    r = client.post("/voices/design/save", json={"token": tok, "name": "   "})
    assert r.status_code == 400 and not list(voices.glob("*.wav"))


def test_design_save_rejects_a_bad_or_expired_token(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    assert client.post("/voices/design/save", json={"token": "nope", "name": "x"}).status_code == 400
    assert client.post("/voices/design/save",
                       json={"token": "b" * 32, "name": "x"}).status_code == 404


# ── m2b task 2: provenance rides along with a saved voice ─────────────────────

def test_design_save_writes_provenance_sidecar(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    voices = tmp_path / "voice_samples"; voices.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _design(client, {"prompt": "a warm voice", "sample_text": "hello there", "seed": 99})["candidates"][0]["token"]
    assert client.post("/voices/design/save", json={"token": tok, "name": 'TestVoice1'}).status_code == 200
    side = voices / 'TestVoice1.voice.json'           # m3: renamed from .voxcpm.json (§14.6a)
    assert side.is_file() and not (voices / 'TestVoice1.voxcpm.json').exists()
    prov = json.loads(side.read_text(encoding="utf-8"))
    assert prov["prompt"] == "a warm voice" and prov["sample_text"] == "hello there"
    assert prov["seed"] == 99 and prov["engine"] == "voxcpm" and "created" in prov
    assert prov["origin"] == "created"           # the positive marker, not an inference


def test_voice_delete_removes_provenance_sidecar(client, monkeypatch, tmp_path):
    voices = tmp_path / "voice_samples"; voices.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    (voices / "TestVoice.wav").write_bytes(b"RIFF0000WAVE")
    (voices / "TestVoice.voice.json").write_text('{"origin": "created"}', encoding="utf-8")
    assert client.delete("/voices/TestVoice").status_code == 200
    assert not (voices / "TestVoice.wav").exists()
    assert not (voices / "TestVoice.voice.json").exists()       # the sidecar goes with the voice


# ── task 1: the freeze (incl. resemble-enhance) runs at GENERATE, on each candidate's card ──

def test_design_generate_enhances_each_candidate_on_its_card(client, monkeypatch, tmp_path):
    """Generate applies enhancement to each candidate using that candidate’s selected card settings."""
    _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0", "cuda:1"))
    import shutil
    seen = []
    def _froze(src, dst, device=None, cancel=None):
        seen.append(device)
        shutil.copyfile(src, dst)
    monkeypatch.setattr(web_voices, "_design_freeze", _froze)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_devices(2)
    s = _design(client, {"prompt": "a warm voice", "sample_text": "hello there"})
    assert s["status"] == "done" and len(s["candidates"]) == 2
    assert set(seen) == {"cuda:0", "cuda:1"}                    # each candidate enhanced on its own card


def test_design_requires_the_complete_freeze_pipeline(client, monkeypatch, tmp_path):
    """Do not create an audition candidate when a required freeze stage is unavailable."""
    _wire_fake_vox(monkeypatch, tmp_path)
    monkeypatch.setattr(web_voices, "_design_unavailable", lambda: (
        "freeze_unavailable", "The required Resemble Enhance environment is unavailable.", 503))
    r = client.post("/voices/design", json={"sample_text": "hi", "seed": 5})
    assert r.status_code == 503 and r.get_json()["error"] == "freeze_unavailable"
    assert not vs.VOX.ready()


def test_design_drops_audio_if_candidate_provenance_cannot_be_persisted(
        client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    candidates = tmp_path / "voice_candidates"
    monkeypatch.setattr(rt_paths, "VOICE_CANDIDATES", candidates)

    def _fail_provenance(*_args, **_kwargs):
        raise OSError("fixture write failure")
    monkeypatch.setattr(web_voices, "_write_candidate_prov", _fail_provenance)

    result = _design(client, {"sample_text": "hello", "seed": 7})
    assert result["status"] == "failed" and result["candidates"] == []
    assert candidates.is_dir() and list(candidates.iterdir()) == []


def test_design_generate_cancel_during_freeze_drops_the_candidate(monkeypatch, tmp_path, client):
    """A cancel landing during the freeze/enhance surfaces as _DesignCanceled → the candidate
    is dropped and the job is 'canceled', never a half-frozen clip."""
    _wire_fake_vox(monkeypatch, tmp_path)
    monkeypatch.setattr(web_voices, "_design_freeze", _raise_canceled)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    dev, _why = vs.GPUS.claim_card(vs.VOX.ready_devices())
    assert dev is not None
    job = web_voices._DesignJob(id="frzcancel", devices=[dev])
    job.cancel.set()                                           # the freeze will raise _DesignCanceled
    web_voices._design_run(job, "(x)hi", "x", "hi", [dev], [1], 2.0, 30)
    assert job.status == "canceled" and job.candidates == []


# ── m2b task 3: Generate is a cancelable background job ───────────────────────

def test_design_status_and_cancel_404_on_unknown_job(client):
    assert client.get("/voices/design/status/nope").status_code == 404
    assert client.post("/voices/design/cancel/nope").status_code == 404


def test_design_generate_is_cancelable_and_the_pool_self_heals(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path, body=SLOW_WORKER)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    jid = client.post("/voices/design", json={"sample_text": "hello"}).get_json()["job_id"]
    # wait until it's actually generating, then cancel it mid-flight
    end = time.monotonic() + 10
    while time.monotonic() < end:
        s = client.get("/voices/design/status/" + jid).get_json()
        if any("designing" in ln for ln in s["log"]):
            break
        time.sleep(0.05)
    assert client.post("/voices/design/cancel/" + jid).status_code == 200
    end = time.monotonic() + 15
    while time.monotonic() < end:
        s = client.get("/voices/design/status/" + jid).get_json()
        if s["status"] != "running":
            break
        time.sleep(0.05)
    assert s["status"] == "canceled"
    assert _wait_vox_ready()                                    # a fresh worker reloaded — pool healed


def test_design_cancel_during_the_load_skips_the_generation(client, monkeypatch, tmp_path):
    """🔴 The m2e gap, closed in m3 (§14.4).

    A cancel that arrives while the engine is still LOADING must skip the draw. m2e made
    Generate self-load a cold engine, which created a phase with no child process to kill —
    the cancel route found nothing to stop, the load completed, and the job then generated
    candidates the user had already canceled. The load itself is deliberately allowed to
    finish and the model STAYS RESIDENT (it's useful next time); only the generation is
    abandoned."""
    _wire_fake_vox(monkeypatch, tmp_path, body=SLOW_LOAD_WORKER)
    voices = tmp_path / "voice_samples"; voices.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    # No /model/load first: the engine is COLD and Generate loads it inside the job (m2e).
    jid = client.post("/voices/design", json={"sample_text": "hello"}).get_json()["job_id"]
    end = time.monotonic() + 10
    while time.monotonic() < end:                       # wait until it's actually loading
        s = client.get("/voices/design/status/" + jid).get_json()
        if any("starting VoxCPM2" in ln for ln in s["log"]):
            break
        time.sleep(0.02)
    assert any("starting VoxCPM2" in ln for ln in s["log"]), "never reached the load phase"
    assert client.post("/voices/design/cancel/" + jid).status_code == 200
    end = time.monotonic() + 20
    while time.monotonic() < end:
        s = client.get("/voices/design/status/" + jid).get_json()
        if s["status"] != "running":
            break
        time.sleep(0.05)
    assert s["status"] == "canceled"
    assert not s["candidates"], "a canceled Generate still produced candidates"
    assert any("canceled" in ln for ln in s["log"])
    # The load ran to completion and the engine is resident — the next Generate is warm.
    assert _wait_vox_ready()


def test_design_status_carries_the_progress_log(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    s = _design(client, {"sample_text": "hello", "seed": 3})
    assert s["status"] == "done"
    joined = " ".join(s["log"])
    assert "designing candidate A" in joined and "candidate A ready" in joined


# Idle worker reaping releases retained CPU and VRAM resources.

# A positive timeout is required because zero disables reaping. Tests sleep after release,
# which resets the worker's last-use time.
_REAP_NOW = 0.005


def _idle_past(seconds=0.02):
    time.sleep(seconds)


def test_reserve_and_release_track_holders(tmp_path):
    w = voxcpm.Worker(_fake_cfg(tmp_path), "cuda:0")
    w.start()
    w.wait_ready(timeout=30)
    try:
        assert w.reserve() and w.reserve()            # a count, not a flag — two holders
        _idle_past()
        assert not w.retire_if_idle(_REAP_NOW)        # ...and neither may be reaped
        w.release()
        _idle_past()
        assert not w.retire_if_idle(_REAP_NOW)        # one holder left: still not reapable
        w.release()
        _idle_past()
        assert w.retire_if_idle(_REAP_NOW)            # free at last
        assert not w.reserve()                        # retired is one-way — no new work
    finally:
        w.stop()


def test_retire_respects_the_timeout_and_the_disable(tmp_path):
    w = voxcpm.Worker(_fake_cfg(tmp_path), "cuda:0")
    w.start()
    w.wait_ready(timeout=30)
    try:
        _idle_past()
        assert not w.retire_if_idle(3600)             # freshly used — nowhere near idle
        assert not w.retire_if_idle(0)                # 0 DISABLES reaping, never "reap now"
        assert not w.retire_if_idle(-1)
        assert w.retire_if_idle(_REAP_NOW)            # ...but a real timeout that has passed does
    finally:
        w.stop()


def test_generate_on_a_retired_worker_refuses(tmp_path):
    w = voxcpm.Worker(_fake_cfg(tmp_path), "cuda:0")
    w.start()
    w.wait_ready(timeout=30)
    _idle_past()
    assert w.retire_if_idle(_REAP_NOW)
    w.stop()
    with pytest.raises(voxcpm.VoxcpmError, match="unloaded while idle"):
        w.generate("(x)y", tmp_path / "z.wav", seed=1, timeout=5)


def test_idle_s_config_precedence(monkeypatch, tmp_path):
    monkeypatch.delenv("VOCALIS_VOXCPM_IDLE_S", raising=False)
    assert voxcpm.resolve_config({}, base_dir=tmp_path).idle_s == voxcpm.IDLE_S_DEFAULT
    assert voxcpm.resolve_config({"voxcpm": {"idle_s": 90}}, base_dir=tmp_path).idle_s == 90.0
    monkeypatch.setenv("VOCALIS_VOXCPM_IDLE_S", "45")
    assert voxcpm.resolve_config({"voxcpm": {"idle_s": 90}}, base_dir=tmp_path).idle_s == 45.0
    monkeypatch.setenv("VOCALIS_VOXCPM_IDLE_S", "soon")     # hand-edited nonsense must not sink it
    assert voxcpm.resolve_config({}, base_dir=tmp_path).idle_s == voxcpm.IDLE_S_DEFAULT


def test_reaper_unloads_an_idle_worker_and_frees_the_pool(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    with vs.VOX._lock:
        w = vs.VOX._workers["cuda:0"]
    _idle_past()
    assert vs.VOX.reap_once(_REAP_NOW) == ["cuda:0"]
    assert not w.alive                               # the process is GONE — that's the point
    assert vs.VOX._workers == {} and not vs.VOX.ready()
    h = client.get("/health").get_json()
    assert h["voxcpm"]["ready"] is False and h["voxcpm"]["devices"] == []


def test_reaper_leaves_a_busy_worker_alone(client, monkeypatch, tmp_path):
    """The race the reaper must never lose: a generation can outlast the idle timeout and
    would then look idle PRECISELY because it's busy. A holder is untouchable."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    with vs.VOX._lock:
        w = vs.VOX._workers["cuda:0"]
    assert w.reserve()
    try:
        _idle_past()
        assert vs.VOX.reap_once(_REAP_NOW) == []
        assert w.alive and vs.VOX.ready()
    finally:
        w.release()
    _idle_past()
    assert vs.VOX.reap_once(_REAP_NOW) == ["cuda:0"]   # released → now reapable


def test_reaper_default_leaves_a_fresh_worker_resident(client, monkeypatch, tmp_path):
    """The 600 s default must not reap the engine you just loaded."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    assert vs.VOX.reap_once(voxcpm.IDLE_S_DEFAULT) == []
    assert vs.VOX.ready()


def test_design_reloads_after_a_reap(client, monkeypatch, tmp_path):
    """The whole point of m2e end to end: walk away, get reaped, come back, click Generate
    — and it just works, without a trip to the model selector."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    _idle_past()
    assert vs.VOX.reap_once(_REAP_NOW) == ["cuda:0"]
    s = _design(client, {"prompt": "a warm voice", "sample_text": "hello", "seed": 11})
    assert s["status"] == "done" and len(s["candidates"]) == 1
    assert any("starting VoxCPM2" in ln for ln in s["log"]), s["log"]


# Candidate files remain listed until explicitly deleted; new generation appends without
# replacing prior candidates.

def _cands(client):
    return client.get("/voices/design/candidates").get_json()


def _one_candidate(client, text="hello"):
    return _design(client, {"sample_text": text})["candidates"][0]["token"]


def test_a_reroll_ADDS_to_the_list_instead_of_replacing_it(client, monkeypatch, tmp_path):
    """🔴 THE CORE OF §18.5, and the one line of UI it used to be: Generate cleared `vc.cands`.

    Two draws must leave TWO rows. Under the old behavior the second design superseded the
    first and this list would have length 1."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    first = _one_candidate(client, "hello")
    second = _one_candidate(client, "again")
    j = _cands(client)
    got = [c["token"] for c in j["candidates"]]
    assert first in got and second in got and len(got) == 2
    # Newest first — the morning after a hundred, the ones he has not heard are at the top.
    assert got[0] == second
    assert j["total_bytes"] > 0


def test_nothing_expires_a_candidate_any_more(client, monkeypatch, tmp_path):
    """🔴 THE SWEEP IS GONE, not tuned (§18.5), and this is the sabotage proof.

    `_design_sweep()` deleted anything past `_DESIGN_TTL_S` (6 h) and ran at the TOP OF EVERY
    GENERATE — so an overnight batch starting at 23:00 actively deleted its own first hours
    before morning (§18.1). Age a candidate a week, then run the generate that used to do the
    sweeping: it must still be there. Restore either name and this test fails."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _one_candidate(client)
    root = rt_paths.VOICE_CANDIDATES
    old = time.time() - 7 * 86400
    vault_fs.utime(root / (tok + ".wav"), (old, old))
    vault_fs.utime(root / (tok + ".json"), (old, old))
    _design(client, {"sample_text": "the generate that used to sweep"})
    assert tok in [c["token"] for c in _cands(client)["candidates"]]
    assert not hasattr(web_voices, "_design_sweep"), (
        "the TTL sweep is back — it is what would delete an overnight batch's own output")
    assert not hasattr(web_voices, "_DESIGN_TTL_S")


def test_a_candidate_carries_its_seed_and_length_into_the_list(client, monkeypatch, tmp_path):
    """§18.4 — "a kept row must carry the seed forward, or 'that one, but again' is
    unanswerable." A clip kept for a month is one he will certainly want to reproduce."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    _design(client, {"prompt": "a warm voice", "sample_text": "hello there", "seed": 4242})
    c = _cands(client)["candidates"][0]
    assert c["seed"] == 4242 and c["steps"] == 30
    assert c["prompt"] == "a warm voice" and c["sample_text"] == "hello there"
    assert c["size"] > 0 and c["created"] > 0
    assert c["duration_s"] is not None      # the fake worker reports one; the row shows it


def test_a_candidate_without_provenance_still_lists(client, monkeypatch, tmp_path):
    """A candidate WAV remains visible when its optional provenance file is absent."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _one_candidate(client)
    vault_fs.unlink(rt_paths.VOICE_CANDIDATES / (tok + ".json"))
    c = _cands(client)["candidates"]
    assert len(c) == 1 and c[0]["token"] == tok and c[0]["seed"] is None
    assert c[0]["created"] > 0              # falls back to the file's mtime


def test_deleting_takes_the_clip_and_its_provenance(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    a = _one_candidate(client, "one")
    b = _one_candidate(client, "two")
    before = _cands(client)["total_bytes"]
    r = client.post("/voices/design/delete", json={"tokens": [a]}).get_json()
    assert r["deleted"] == 1 and r["freed_bytes"] > 0
    root = rt_paths.VOICE_CANDIDATES
    assert not vault_fs.exists(root / (a + ".wav"))
    assert not vault_fs.exists(root / (a + ".json")), "the provenance outlived the clip"
    after = _cands(client)
    assert [c["token"] for c in after["candidates"]] == [b]
    assert after["total_bytes"] == before - r["freed_bytes"]


def test_one_delete_endpoint_serves_the_row_and_the_mass_delete(client, monkeypatch, tmp_path):
    """"Delete one" is a list of length one. A second endpoint for the single case is the shape
    the 7.0 review kept finding: two paths that build the same thing, one of which grows a guard
    the other never gets."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    toks = [_one_candidate(client, "n%d" % i) for i in range(3)]
    r = client.post("/voices/design/delete", json={"tokens": toks}).get_json()
    assert r["deleted"] == 3
    assert _cands(client)["candidates"] == []


def test_delete_refuses_a_token_that_is_not_one(client, monkeypatch, tmp_path):
    """🔴 A bulk delete is exactly the shape where one unchecked element in a list of a hundred
    is easy to miss, so the token is validated where the unlink happens, not only at the door."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _one_candidate(client)
    # A traversal, a wildcard, an absolute path and a plain lie, mixed in with a real token.
    r = client.post("/voices/design/delete", json={"tokens": [
        '../../voice_samples/TestVoice1', "*", "/etc/passwd", "nope", None, tok]}).get_json()
    assert r["deleted"] == 1                       # only the real one
    assert _cands(client)["candidates"] == []
    assert client.post("/voices/design/delete", json={"tokens": []}).status_code == 400
    assert client.post("/voices/design/delete", json={"tokens": "abc"}).status_code == 400
    assert client.post("/voices/design/delete", json={}).status_code == 400


def test_saving_a_candidate_LEAVES_it_in_the_list(client, monkeypatch, tmp_path):
    """Saving a candidate copies it to the destination and leaves the source candidate available."""
    _wire_fake_vox(monkeypatch, tmp_path)
    voices = tmp_path / "voice_samples"
    voices.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", voices)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _one_candidate(client)
    assert client.post("/voices/design/save", json={"token": tok, "name": 'TestVoice1'}).status_code == 200
    assert [c["token"] for c in _cands(client)["candidates"]] == [tok]
    # ...and it can be saved AGAIN under a second name, which is the point of it staying.
    assert client.post("/voices/design/save", json={"token": tok, "name": 'TestVoice2'}).status_code == 200
    assert (voices / 'TestVoice1.wav').is_file() and (voices / 'TestVoice2.wav').is_file()


def test_a_candidate_survives_a_scratch_sweep(client, monkeypatch, tmp_path):
    """🔴 THE POINT OF MOVING THEM (§18.7). The startup sweep empties the scratch, and
    `CANDIDATES_SUBDIR` is no longer exempt from it — so a candidate still living there would be
    destroyed by the next `systemctl restart`, and volatile scratch storage is re-keyed on reboot.

    Sabotage: point `_design_candidates()` back at the scratch and this fails."""
    import scratch as scratch_mod
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    tok = _one_candidate(client)
    scratch_mod.sweep(rt_configs.scratch_root())
    assert [c["token"] for c in _cands(client)["candidates"]] == [tok]
    assert client.get("/voices/design/audio/" + tok).status_code == 200


# ── 7.0-m7 §18: the overnight batch ──────────────────────────────────────────

def _batch_wait(client, timeout=120):
    """Poll the batch to a settled state, exactly as the UI does.

    ⚠️ THE BUDGET IS A HANG-GUARD, NOT AN ASSERTION ABOUT SPEED, and at 30 s it was quietly
    acting like one. The pipeline under it is a FAKE — it settles instantly on an idle box — so
    the only thing that can exhaust the budget is CPU starvation. Under the full suite at 16
    workers, with `test_concat_real_audio` spawning real ffmpeg beside it, this went red three
    runs out of five while passing alone and in pairs every time. Raising it costs nothing on a
    green run and removes a failure that never said anything about the code."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        j = client.get("/voices/design/batch").get_json()
        if j["status"] not in ("running", "stopping"):
            return j
        time.sleep(0.05)
    raise AssertionError("the batch never settled")


def _batch_until_done(client, n, timeout=20):
    """Wait until the batch has banked at least `n` candidates — for the tests that need a run
    genuinely under way before they interfere with it."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        j = client.get("/voices/design/batch").get_json()
        if j["done"] >= n or j["status"] not in ("running", "stopping"):
            return j
        time.sleep(0.02)
    raise AssertionError("the batch never got going")


def test_a_batch_runs_rounds_until_the_count_is_met(client, monkeypatch, tmp_path):
    """"I could enter, you know, a hundred and hit go and just have it run overnight." One card
    means one candidate per round, so 3 asks for 3 rounds — and the list gets all three, because
    the rounds a batch repeats are the same rounds the Generate button runs."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    r = client.post("/voices/design/batch",
                    json={"count": 3, "prompt": "a warm voice", "sample_text": "hello"})
    assert r.status_code == 202
    j = _batch_wait(client)
    assert j["status"] == "done" and j["done"] == 3 and j["remaining"] == 0
    assert not j["error"]
    assert len(_cands(client)["candidates"]) == 3


def test_a_batch_never_overshoots_the_number_he_typed(client, monkeypatch, tmp_path):
    """Two cards and an odd total would finish at 4 of 3 if a round were allowed to run wide.
    "A hundred" is a budget, not a rounding hint."""
    _wire_fake_vox(monkeypatch, tmp_path, devices=("cuda:0", "cuda:1"))
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_devices(2)
    client.post("/voices/design/batch", json={"count": 3, "sample_text": "hello"})
    j = _batch_wait(client)
    assert j["done"] == 3, j["log"]
    assert len(_cands(client)["candidates"]) == 3


def test_a_second_batch_is_refused_while_one_is_running(client, monkeypatch, tmp_path):
    """Arming RESETS progress, so an accidental second press mid-run would zero a batch that is
    60 candidates in and report 0/100 with no way back to the real number."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    assert client.post("/voices/design/batch",
                       json={"count": 400, "sample_text": "hello"}).status_code == 202
    _batch_until_done(client, 1)
    r = client.post("/voices/design/batch", json={"count": 5, "sample_text": "other"})
    assert r.status_code == 409 and r.get_json()["error"] == "batch_running"
    client.post("/voices/design/batch/stop", json={})
    j = _batch_wait(client)
    assert j["total"] == 400, "the second press moved the goalposts of the running batch"


def test_stop_is_lossless_and_the_remainder_can_be_carried_on(client, monkeypatch, tmp_path):
    """swap_queue §5.2's rule: the round in flight finishes and is BANKED, then the run halts.
    Nothing is lost, and ▶ Carry on picks the rest up with its progress intact."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    client.post("/voices/design/batch", json={"count": 400, "sample_text": "hello"})
    _batch_until_done(client, 1)
    client.post("/voices/design/batch/stop", json={})
    j = _batch_wait(client)
    assert j["status"] == "stopped" and 0 < j["done"] < 400
    assert len(_cands(client)["candidates"]) == j["done"], (
        "a round that was in flight when Stop landed lost its candidate — stop is meant to be "
        "lossless, which is exactly why it waits for the round instead of canceling it")
    # Carry on: same batch, same total, progress preserved.
    assert client.post("/voices/design/batch/resume", json={}).status_code == 202
    _batch_until_done(client, j["done"] + 1)
    client.post("/voices/design/batch/stop", json={})
    j2 = _batch_wait(client)
    assert j2["total"] == 400 and j2["done"] > j["done"]


def test_resume_refuses_when_there_is_nothing_to_carry_on(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)
    r = client.post("/voices/design/batch/resume", json={})
    assert r.status_code == 409 and r.get_json()["error"] == "nothing_to_resume"


def test_a_batch_WAITS_for_a_render_instead_of_failing(client, monkeypatch, tmp_path):
    """§7.3/§18.3 — voice creation yields to renders, and a batch needs that MORE than the button
    does: it holds the box all night, so a render arriving at 02:00 must be able to get in.
    `cards_busy` is "wait and try again" here, never a failure — while the single Generate button
    answers 409 immediately. Same claim helper, two right answers to the same "no"."""
    _wire_fake_vox(monkeypatch, tmp_path)
    monkeypatch.setattr(web_voices, "_BATCH_CARD_WAIT_S", 0.1)   # 5 s in real use
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    assert vs.GPUS.acquire(timeout=2)                     # a render owns every card
    j = None
    try:
        assert client.post("/voices/design/batch",
                           json={"count": 2, "sample_text": "hello"}).status_code == 202
        # It must still be RUNNING (i.e. waiting), not failed, while the render holds the cards.
        end = time.monotonic() + 1.5
        while time.monotonic() < end:
            j = client.get("/voices/design/batch").get_json()
            assert j["status"] in ("running", "stopping"), j
            assert not j["error"], j
            assert j["done"] == 0
            time.sleep(0.1)
        assert any("waiting for a free card" in ln for ln in j["log"]), j["log"]
    finally:
        vs.GPUS.release()
    j = _batch_wait(client)
    assert j["status"] == "done" and j["done"] == 2, j["log"]


def test_a_batch_gives_up_rather_than_reporting_running_all_night(client, monkeypatch, tmp_path):
    """The other half of the same rule. Waiting forever would have the morning show "running"
    over a run that has produced nothing for eight hours, which is the least useful thing the
    status could say."""
    _wire_fake_vox(monkeypatch, tmp_path)
    monkeypatch.setattr(web_voices, "_BATCH_CARD_WAIT_S", 0.01)
    monkeypatch.setattr(web_voices, "_BATCH_CARD_TRIES", 3)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    assert vs.GPUS.acquire(timeout=2)
    try:
        client.post("/voices/design/batch", json={"count": 2, "sample_text": "hello"})
        j = _batch_wait(client)
    finally:
        vs.GPUS.release()
    assert j["status"] == "stopped" and j["done"] == 0
    assert "GPUs stayed busy" in j["error"], j


def test_a_batch_that_makes_nothing_round_after_round_gives_up(client, monkeypatch, tmp_path):
    """A batch that repeatedly produces no usable candidate must stop after its configured no-progress limit."""
    _wire_fake_vox(monkeypatch, tmp_path)

    def _broken_freeze(src, dst, device=None, cancel=None):
        raise RuntimeError("no such vault file: voice_candidates/deadbeef.hp.wav")

    monkeypatch.setattr(web_voices, "_design_freeze", _broken_freeze)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    client.post("/voices/design/batch", json={"count": 100, "sample_text": "hello"})
    j = _batch_wait(client)
    assert j["status"] == "stopped" and j["done"] == 0
    assert j["failed"] == web_voices._BATCH_BARREN_MAX, j
    assert "in a row" in j["error"], j


def test_a_second_stop_press_cancels_the_round_in_flight(client, monkeypatch, tmp_path):
    """A second stop press cancels the active round and waits for its work to finish before returning."""
    _wire_fake_vox(monkeypatch, tmp_path, body=SLOW_WORKER)   # generate blocks until killed
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    assert client.post("/voices/design/batch",
                       json={"count": 5, "sample_text": "hello"}).status_code == 202
    end = time.monotonic() + 10
    while time.monotonic() < end and web_voices._BATCH_JOB is None:
        time.sleep(0.02)
    assert web_voices._BATCH_JOB is not None, "no round ever got in flight"
    j = client.post("/voices/design/batch/stop", json={}).get_json()   # press one: graceful
    assert j["status"] == "stopping"
    assert any("cancels it now" in ln for ln in j["log"]), j["log"]
    client.post("/voices/design/batch/stop", json={})                  # press two: NOW
    j = _batch_wait(client, timeout=15)                                # ≪ the 30 s fake draw
    assert j["status"] == "stopped" and j["done"] == 0
    assert j["failed"] == 0, "a canceled round is not a failed round"
    assert any("canceling the round in flight" in ln for ln in j["log"]), j["log"]


def test_the_freeze_runs_every_stage_in_scratch_in_order(monkeypatch, tmp_path):
    """DFN3, high-pass, and enhancement use scratch intermediates before normalization."""
    from types import SimpleNamespace
    monkeypatch.setattr(rt_configs, "scratch_root", lambda: tmp_path / "scratch")
    monkeypatch.setattr(rt_configs, "cleanup_cfg",
                        lambda: SimpleNamespace(denoise_available=True))
    monkeypatch.setattr(rt_configs, "enhance_cfg",
                        lambda: SimpleNamespace(available=True))
    events = []

    def _fake_denoise(cfg, src, dst, **kw):
        events.append(("dfn3", Path(src)))
        Path(dst).write_bytes(b"denoised")
        return 0

    def _fake_ffmpeg(cmd, **kw):
        events.append(("highpass", Path(cmd[cmd.index("-i") + 1])))
        out = Path(cmd[cmd.index("-f") + 2])
        out.write_bytes(b"high-passed")
        return SimpleNamespace(returncode=0, stderr="")

    def _fake_enhance(cfg, src, dst, *, device, cancel, on_line):
        events.append(("enhance", Path(src), device))
        Path(dst).write_bytes(b"enhanced")
        return 0

    def _fake_normalize(src, dst, target_dbfs=None):
        events.append(("normalize", Path(src)))
        Path(dst).write_bytes(b"RIFF0000WAVE")

    monkeypatch.setattr(web_voices.cleanup, "run_denoise", _fake_denoise)
    monkeypatch.setattr(web_voices.enhance, "run_enhance", _fake_enhance)
    monkeypatch.setattr(web_voices, "subprocess", SimpleNamespace(run=_fake_ffmpeg))
    monkeypatch.setattr(web_voices, "voice_utils",
                        SimpleNamespace(transcode_normalize=_fake_normalize))
    raw = tmp_path / "raw.wav"
    raw.write_bytes(b"RIFF0000WAVE")
    frozen = tmp_path / "frozen.wav"
    web_voices._design_freeze(raw, frozen, device="cuda:1")
    assert [row[0] for row in events] == ["dfn3", "highpass", "enhance", "normalize"]
    assert events[0][1] == raw
    assert events[1][1].name.endswith(".den.wav")
    assert events[2][1].name.endswith(".hp.wav") and events[2][2] == "cuda:1"
    assert events[3][1].name.endswith(".enh.wav")
    assert frozen.is_file()
    assert list(web_voices._design_work().iterdir()) == []


def test_the_freeze_fails_closed_and_cleans_scratch(monkeypatch, tmp_path):
    from types import SimpleNamespace
    monkeypatch.setattr(rt_configs, "scratch_root", lambda: tmp_path / "scratch")
    monkeypatch.setattr(rt_configs, "cleanup_cfg",
                        lambda: SimpleNamespace(denoise_available=True))
    monkeypatch.setattr(rt_configs, "enhance_cfg",
                        lambda: SimpleNamespace(available=True))
    raw = tmp_path / "raw.wav"
    raw.write_bytes(b"RIFF0000WAVE")
    frozen = tmp_path / "frozen.wav"

    monkeypatch.setattr(web_voices.cleanup, "run_denoise",
                        lambda *_a, **_k: 1)
    with pytest.raises(RuntimeError, match="DFN3 cleanup failed"):
        web_voices._design_freeze(raw, frozen, device="cuda:0")
    assert not frozen.exists()
    assert list(web_voices._design_work().iterdir()) == []

    def _denoise(_cfg, _src, dst, **_kw):
        Path(dst).write_bytes(b"denoised")
        return 0
    monkeypatch.setattr(web_voices.cleanup, "run_denoise", _denoise)
    def _highpass(cmd, **_kw):
        Path(cmd[cmd.index("-f") + 2]).write_bytes(b"high-passed")
        return SimpleNamespace(returncode=0, stderr="")
    monkeypatch.setattr(web_voices, "subprocess", SimpleNamespace(run=_highpass))
    monkeypatch.setattr(web_voices.enhance, "run_enhance", lambda *_a, **_k: 2)
    monkeypatch.setattr(web_voices, "voice_utils",
                        SimpleNamespace(transcode_normalize=lambda *_a, **_k: None))
    with pytest.raises(RuntimeError, match="Resemble Enhance failed"):
        web_voices._design_freeze(raw, frozen, device="cuda:0")
    assert not frozen.exists()
    assert list(web_voices._design_work().iterdir()) == []


def test_a_batch_refuses_a_silly_count_or_no_sample(client, monkeypatch, tmp_path):
    _wire_fake_vox(monkeypatch, tmp_path)

    def bad(body):
        return client.post("/voices/design/batch", json=body).status_code

    assert bad({"count": 5}) == 400                       # no sample text
    assert bad({"count": 0, "sample_text": "x"}) == 400
    assert bad({"count": -3, "sample_text": "x"}) == 400
    assert bad({"count": "many", "sample_text": "x"}) == 400
    assert bad({"count": rt_voice_batch.MAX_BATCH + 1, "sample_text": "x"}) == 400
    assert client.get("/voices/design/batch").get_json()["status"] == "idle"


def test_a_batch_never_comes_back_from_disk_running(tmp_path):
    """🔴 swap_queue §5.3's rule, and the reason it is copied here: a crash or a reboot mid-batch
    must not have the box wake up and quietly resume 60 unattended generations by itself."""
    import yaml as _yaml
    p = tmp_path / "batch.yaml"
    b = rt_voice_batch.VoiceBatch(p)
    b.arm(10, "a warm voice", "hello", 30, 2.0)
    b.set_running(True)
    b.note_round(2, [])
    # What is actually ON DISK: no `running` key at all, so there is nothing a loader could even
    # misread as "carry on".
    raw = _yaml.safe_load(p.read_text(encoding="utf-8"))
    assert "running" not in raw and raw["done"] == 2 and raw["total"] == 10
    assert raw["prompt"] == "a warm voice"                # the form is what a resume re-runs
    # The restart. Progress survives; the RUN does not.
    again = rt_voice_batch.VoiceBatch(p)
    assert again.running is False and again.status() == "stopped"
    assert again.done == 2 and again.total == 10
    assert any("interrupted" in ln for ln in again.log), again.log
    # And a file that CLAIMS to be running is not believed either — the field is never read, so a
    # hand-edited or future-versioned file cannot start the GPUs on its own.
    p.write_text(_yaml.safe_dump({"total": 10, "done": 2, "running": True}), encoding="utf-8")
    assert rt_voice_batch.VoiceBatch(p).running is False


def test_arming_and_starting_are_ONE_operation(tmp_path):
    """🔴 The refusal has to come out of the transition, not from a `status()` read before it.

    `arm()` RESETS progress. A route that checked "is one running?" and then armed has a window
    between the two, so a double-click — or a second tab — could zero a batch 60 candidates in
    and leave two runner threads counting into the same total. Driven at the object rather than
    through HTTP because a race is what is being asserted, and the flask test client is
    single-threaded: this asserts the primitive both routes now depend on."""
    b = rt_voice_batch.VoiceBatch(tmp_path / "batch.yaml")
    assert b.arm_and_run(100, "", "hello", 30, 2.0) is True
    b.note_round(60, [])
    # The second press, with the run still live. It must change NOTHING.
    assert b.arm_and_run(5, "", "different", 30, 2.0) is False
    assert b.total == 100 and b.done == 60 and b.sample_text == "hello"
    assert b.resume() is False, "resume must refuse a batch that is already running"
    b.set_running(False)
    # Now stopped with work left: resume takes, and a second resume does not.
    assert b.resume() is True
    assert b.resume() is False
    b.set_running(False)
    # ...and a FINISHED batch has nothing to carry on.
    b.note_round(40, [])
    assert b.done == 100 and b.resume() is False


def test_arming_resets_progress_but_never_the_candidates(client, monkeypatch, tmp_path):
    """Starting a new design run resets its progress while preserving candidates already stored."""
    _wire_fake_vox(monkeypatch, tmp_path)
    client.post("/model/load", json={"which": "voxcpm"})
    assert _wait_vox_ready()
    client.post("/voices/design/batch", json={"count": 1, "sample_text": "first"})
    assert _batch_wait(client)["done"] == 1
    client.post("/voices/design/batch", json={"count": 1, "sample_text": "second"})
    j = _batch_wait(client)
    assert j["done"] == 1 and j["total"] == 1 and j["sample_text"] == "second"
    assert len(_cands(client)["candidates"]) == 2, "arming a batch ate the earlier candidates"


def test_the_batch_eta_stays_blank_until_a_round_has_finished(tmp_path):
    """A guess made from zero samples is worse than an honest blank — and worse here than in most
    places, because the first round of a cold batch pays an ~11 s model load the other forty-nine
    do not, so an ETA extrapolated from it would be wrong by hours."""
    b = rt_voice_batch.VoiceBatch(tmp_path / "batch.yaml")
    b.arm(50, "", "hello", 30, 2.0)
    b.set_running(True)
    assert b.snapshot()["eta_s"] is None, "an ETA extrapolated from zero finished rounds"
    b.note_round(1, [])
    b.set_running(False)
    # Injected rather than slept for: a real round is 30–60 s, and a test that starts and stops
    # a batch inside one monotonic tick measures 0.0 elapsed and asserts nothing. This asserts
    # the ARITHMETIC — one round took 40 s, forty-nine are left.
    b.spent_s = 40.0
    assert b.snapshot()["eta_s"] == 40 * 49


# ── §19: the log has to be able to answer "did ▶ Batch resume my old run?" ───
#
# Log a completion event and each round's timing so the UI distinguishes a new batch from a resumed run.


def test_a_good_round_says_what_it_cost(tmp_path):
    """🔴 Until §19 the log recorded only FAILURES, so forty successful rounds wrote exactly one
    line — the one from arming. That is what made a healthy batch and a resumed batch look
    identical on screen, and it is the whole reason the report was filed.

    The per-candidate figure is the point, not the per-round one: §7 runs two at once across
    `cuda:0` and `cuda:1`, so an intuition formed on a single-GPU run is ~2x off before anything
    is actually wrong, and nothing else in the system ever writes that number down.
    """
    b = rt_voice_batch.VoiceBatch(tmp_path / "batch.yaml")
    b.arm(100, "", "hello", 30, 2.0)
    b.set_running(True)
    # 34, not 33: 33/2 is 16.5 and `format(16.5, '.0f')` rounds half-to-EVEN, giving "16". A test
    # written on a tie asserts the rounding mode rather than the arithmetic, and would flip on any
    # future change to how the line is formatted.
    b.note_round(2, [], seconds=34.0)
    line = [ln for ln in b.log if ln.startswith("round done")]
    assert len(line) == 1, b.log
    assert "2 candidates" in line[0] and "34s" in line[0]
    assert "17s each" in line[0], f"the per-candidate cost is the number he needs: {line[0]}"
    assert "2 of 100" in line[0], f"and where the run has got to: {line[0]}"

    # A round that produced NOTHING is still not narrated as a success, and a canceled one is
    # not a failure — `seconds` must not have quietly changed either rule.
    b.note_round(0, [], canceled=True, seconds=12.0)
    assert len([ln for ln in b.log if ln.startswith("round done")]) == 1
    assert b.failed == 0, "a canceled round is not a failed one"

    # And the caller may omit it — `seconds=None` logs nothing, so nothing that already called
    # `note_round` starts writing half a line.
    b.note_round(1, [])
    assert len([ln for ln in b.log if ln.startswith("round done")]) == 1


def test_arming_over_a_stopped_run_SAYS_it_discarded_it(tmp_path):
    """Arming over a stopped run must make the discarded in-progress work explicit."""
    p = tmp_path / "batch.yaml"
    b = rt_voice_batch.VoiceBatch(p)
    b.arm(60, "", "hello", 30, 2.0)
    b.set_running(True)
    b.note_round(58, [], seconds=900.0)
    b.set_running(False)

    again = rt_voice_batch.VoiceBatch(p)                  # the restart
    assert again.done == 58 and again.status() == "stopped"
    again.arm(100, "", "hello", 30, 2.0)                  # he presses ▶ Batch, not ▶ Carry on
    assert again.done == 0 and again.total == 100, "arming must still reset — that part was right"
    said = " ".join(again.log)
    assert "58 of 60" in said, f"the discarded progress is named: {again.log}"
    assert "carry on" in said.lower(), f"and which button would have kept it: {again.log}"

    # Only unfinished prior work is reported as discarded; fresh and completed batches
    # have no progress to lose.
    fresh = rt_voice_batch.VoiceBatch(tmp_path / "fresh.yaml")
    fresh.arm(10, "", "hello", 30, 2.0)
    assert not any("discarded" in ln for ln in fresh.log), fresh.log
    fresh.set_running(True)
    fresh.note_round(10, [], seconds=100.0)
    fresh.set_running(False)
    fresh.arm(10, "", "hello", 30, 2.0)
    assert not any("discarded" in ln for ln in fresh.log), (
        "a finished run has no progress to lose", fresh.log)


def test_a_bounce_no_longer_desynchronizes_spent_from_done(tmp_path, monkeypatch):
    """After a restart, reported spent and completed work must remain consistent with persisted results."""
    clock = {"t": 1000.0}
    monkeypatch.setattr(rt_voice_batch.time, "monotonic", lambda: clock["t"])

    p = tmp_path / "batch.yaml"
    b = rt_voice_batch.VoiceBatch(p)
    b.arm(100, "", "hello", 30, 2.0)
    b.set_running(True)
    # 24 candidates over 24 minutes — a plausible overnight rate, and nothing like 29 seconds.
    for _ in range(12):
        clock["t"] += 120.0
        b.note_round(2, [], seconds=120.0)
    assert b.done == 24

    # Reopening without set_running(False) simulates process death; persisted elapsed time
    # must survive recovery.
    again = rt_voice_batch.VoiceBatch(p)
    assert again.done == 24 and again.status() == "stopped"
    assert again.spent_s >= 1440.0, (
        "the time those 24 candidates took did not survive the bounce, so the ETA after ▶ Carry "
        f"on is computed from a few seconds of work: spent_s={again.spent_s}")

    # ▶ Carry on, then look at the estimate before any new round has finished.
    assert again.resume() is True
    clock["t"] += 5.0
    eta = again.snapshot()["eta_s"]
    # 76 left at 60 s each ≈ 4560 s. The bug produced ~29 s, so anything in the right ORDER of
    # magnitude proves it: asserting the exact number would only pin the arithmetic to itself.
    assert eta is not None and eta > 3600, (
        f"a resumed batch still estimates from a desynchronized clock (eta_s={eta})")


def test_the_arming_line_survives_a_whole_night_of_rounds(tmp_path):
    """🔴 Now that every round logs, plain tail-trimming would evict the head.

    500 candidates one at a time is 500 lines against a 300-line cap, and the line that would go
    first is `batch armed:` — the one statement that says whether this run is fresh or resumed,
    which is the entire question §19 exists to answer. Losing it at hour six of an overnight run
    is losing it exactly when it is read.
    """
    b = rt_voice_batch.VoiceBatch(tmp_path / "batch.yaml")
    b.arm(500, "", "hello", 30, 2.0)
    b.set_running(True)
    for _ in range(rt_voice_batch._LOG_KEEP + 50):
        b.note_round(1, [], seconds=30.0)
    assert len(b.log) == rt_voice_batch._LOG_KEEP, len(b.log)
    assert b.log[0].startswith("batch armed:"), b.log[0]
    assert b.log[-1].startswith("round done"), b.log[-1]
    # …and the pin costs exactly one slot, not a growing prefix.
    assert sum(1 for ln in b.log if ln.startswith("batch armed:")) == 1


# ── 7.0-m7 §17: voice-design templates ───────────────────────────────────────
# Templates preserve a voice description and sample text for reuse, with favorites and sorting.

def _tpl(client, name="Warm narrator", **kw):
    body = {"name": name, "prompt": "a warm voice", "sample_text": "hello there", "steps": 30}
    body.update(kw)
    r = client.post("/voices/templates", json=body)
    assert r.status_code == 201, r.get_data(as_text=True)
    return r.get_json()


def _tpls(client):
    return client.get("/voices/templates").get_json()["templates"]


def test_a_template_round_trips_the_three_fields_it_holds(client):
    """A template round-trips its description, sample text, and quality-step settings without adding unrelated fields."""
    t = _tpl(client, "Warm narrator", prompt="a 20-year-old woman", sample_text="Oh, hi!", steps=22)
    assert t["name"] == "Warm narrator" and t["prompt"] == "a 20-year-old woman"
    assert t["sample_text"] == "Oh, hi!" and t["steps"] == 22
    assert t["favorite"] is False and t["used"] == 0 and t["created_at"] > 0
    assert "language" not in t and "lang" not in t, (
        "a template grew a language field — §17.4 was answered NO, and a stored language would "
        "be a second copy of a fact the sample text already carries")
    got = _tpls(client)
    assert len(got) == 1 and got[0] == t


def test_saving_ALWAYS_creates_and_never_overwrites_by_name(client):
    """🔴 §17.4, answered from the code rather than decided twice: `InstructionLibrary.add` mints
    an id and appends unconditionally, and editing is a separate verb. Two templates may share a
    name — the id is the identity. A save that quietly replaced a same-named entry would destroy
    the older one with no warning, in a store whose whole job is not losing what you refined."""
    a = _tpl(client, "Same name", prompt="first")
    b = _tpl(client, "Same name", prompt="second")
    assert a["id"] != b["id"]
    got = _tpls(client)
    assert len(got) == 2
    assert {t["prompt"] for t in got} == {"first", "second"}


def test_a_template_needs_a_name(client):
    r = client.post("/voices/templates", json={"prompt": "x", "sample_text": "y"})
    assert r.status_code == 400
    assert client.post("/voices/templates", json={"name": "   "}).status_code == 400
    assert _tpls(client) == []


def test_editing_is_a_separate_verb_and_refuses_unknown_fields(client):
    """Unknown keys are REFUSED rather than ignored — a typo that silently does nothing is a bug
    report about the UI not saving."""
    t = _tpl(client, "Before")
    r = client.post("/voices/templates/" + t["id"],
                    json={"name": "After", "prompt": "changed", "steps": 12})
    assert r.status_code == 200
    j = r.get_json()
    assert j["name"] == "After" and j["prompt"] == "changed" and j["steps"] == 12
    assert j["id"] == t["id"] and j["created_at"] == t["created_at"]
    assert j["updated_at"] >= t["updated_at"]
    assert j["sample_text"] == t["sample_text"], "a partial edit clobbered a field it never named"
    bad = client.post("/voices/templates/" + t["id"], json={"langauge": "German"})
    assert bad.status_code == 400, "a misspelled field was accepted and silently did nothing"
    assert client.post("/voices/templates/nope", json={"name": "x"}).status_code == 404
    assert client.post("/voices/templates/" + t["id"], json={}).status_code == 400


def test_favorites_float_to_the_top_they_do_not_filter(client):
    """§16.6, reused. A ★ moves a template to the top of whichever order is showing and hides
    nothing. 🔴 And it is a FLAG THE USER SET, never a character parsed out of a name: a template
    genuinely called "★ Test Voice" sorts as that text and gets no special position. This codebase has
    shipped that bug once already (kobold.sort_key)."""
    _tpl(client, "Test Voice 1")
    mid = _tpl(client, "Test Voice 2")
    _tpl(client, "★ Test Voice")               # the text, not the flag
    assert client.post("/voices/templates/" + mid["id"],
                       json={"favorite": True}).status_code == 200
    names = [t["name"] for t in _tpls(client)]
    assert names[0] == "Test Voice 2", f"the favorite did not float: {names}"
    assert set(names) == {"Test Voice 1", "Test Voice 2", "★ Test Voice"}, "a favorite FILTERED the list instead"
    assert names.index("★ Test Voice") > 0, "a star in the NAME bought a position it should not have"


def test_deleting_a_template_leaves_the_others(client):
    a, b = _tpl(client, "Keep"), _tpl(client, "Drop")
    assert client.delete("/voices/templates/" + b["id"]).status_code == 200
    assert [t["id"] for t in _tpls(client)] == [a["id"]]
    assert client.delete("/voices/templates/" + b["id"]).status_code == 404


def test_loading_a_template_counts_as_a_use(client):
    """The count is what answers "which of these thirty do I actually reach for", which neither
    the name nor the date can."""
    t = _tpl(client)
    assert client.post("/voices/templates/" + t["id"] + "/use", json={}).status_code == 200
    assert client.post("/voices/templates/" + t["id"] + "/use", json={}).status_code == 200
    assert _tpls(client)[0]["used"] == 2
    # A template deleted in another tab must not turn a load into an error dialog.
    client.delete("/voices/templates/" + t["id"])
    assert client.post("/voices/templates/" + t["id"] + "/use", json={}).status_code == 200


def test_templates_survive_a_restart(client, monkeypatch):
    """Saved templates remain available after the service restarts."""
    t = _tpl(client, "Persisted")
    assert rt_paths.VOICE_TEMPLATES.is_file()
    again = rt_voice_templates.list_templates()
    assert [x.id for x in again] == [t["id"]] and again[0].name == "Persisted"


def test_a_corrupt_library_RAISES_rather_than_reporting_none(monkeypatch, tmp_path):
    """An unreadable candidate library must raise an error; only an absent library represents no saved candidates."""
    p = tmp_path / "voice_templates.json"
    monkeypatch.setattr(rt_paths, "VOICE_TEMPLATES", p)
    assert rt_voice_templates.list_templates() == []          # absent is a fact
    p.write_text("{ not json", encoding="utf-8")
    with pytest.raises(rt_voice_templates.TemplateStoreCorrupt):
        rt_voice_templates.list_templates()
    p.write_text('{"instructions": []}', encoding="utf-8")    # right shape, wrong store
    with pytest.raises(rt_voice_templates.TemplateStoreCorrupt):
        rt_voice_templates.list_templates()
    # A corrupt file remains untouched for repair; the read must fail before writing.
    assert p.read_text(encoding="utf-8") == '{"instructions": []}'
