"""Time candidate playback in a real browser with realistic generated audio fixtures. The tab wiring test uses a short tone, which cannot expose stalls on large transfers; this spec uses a 210-second, roughly 27 MB FLAC and covers playback, discard, save, and library replay. Keep the fixture size and its 8-second playback-start budget so the test remains sensitive to transfer stalls."""
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import acestep as rt_ace

SPEC = Path(__file__).parent / "acestep_playback_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

STUB_INSTALLED = [
    ("acestep-api.service", "http://127.0.0.1:7683", "cuda:0"),
    ("acestep-api-gpu1.service", "http://127.0.0.1:7685", "cuda:1"),
]
STUB_MODELS = {"http://127.0.0.1:7683": "acestep-v15-turbo",
               "http://127.0.0.1:7685": "acestep-v15-xl-sft"}

#: Use a generated 210-second FLAC, about 27 MB, so this spec can detect large-transfer stalls that a short tone would miss.
FIXTURE_SECONDS = 210


def _chrome():
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in ("chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(c)
        if found:
            return found
    for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              "/usr/bin/google-chrome", "/usr/bin/chromium"):
        if Path(c).exists():
            return c
    return None


def _start_owned_children(monkeypatch):
    """Give the stub cards what the Docker runtime requires of a card that can take work.

    The legacy runtime asked systemd whether a unit existed and counted live units; the Docker one
    owns a child process per card and `can_dispatch()` / `submission_slot()` refuse a card unless
    that child is running, HTTP-ready AND model-ready under the current generation. So the stub
    cards are started through the real lifecycle (`start_instance`) with only the process launch
    faked, then marked ready exactly as the health probe and the model loader would.

    ⚠️ `rt_ace.subprocess` is REPLACED with a copy that has a fake `Popen`; patching
    `subprocess.Popen` itself would also break the `subprocess.run` that launches Node below.
    """
    import types

    class _Child:
        pid = 941_219
        returncode = None

        def poll(self):
            return self.returncode

    monkeypatch.setattr(rt_ace, "configured", lambda _settings=None: list(STUB_INSTALLED))
    monkeypatch.setattr(rt_ace, "_BACKENDS", {})
    monkeypatch.setattr(rt_ace, "_STOP_ALL", threading.Event())
    monkeypatch.setattr(rt_ace, "_runtime_inputs", lambda: (
        "/opt/python", "/opt/acestep", "/models/vocalis/acestep"))
    monkeypatch.setattr(rt_ace, "subprocess", types.SimpleNamespace(
        **{**vars(subprocess), "Popen": lambda *args, **kwargs: _Child()}))
    for service, url, _device in STUB_INSTALLED:
        result = rt_ace.start_instance(service=service)
        assert result["ok"], result
        rt_ace.mark_http_ready(url)
        rt_ace.mark_model_ready(url, True)

def _big_flac(tmp_path):
    """A decodable FLAC of realistic size. ⚠️ Noise, not a sine — a pure tone compresses to almost
    nothing in FLAC, which would quietly hand this spec the small fixture it exists to avoid."""
    ff = shutil.which("ffmpeg")
    if ff is None:
        pytest.skip("ffmpeg is not installed")
    out = tmp_path / "big.flac"
    subprocess.run([ff, "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"anoisesrc=d={FIXTURE_SECONDS}:c=pink:r=44100:a=0.5",
                    "-ac", "2", "-c:a", "flac", str(out)],
                   check=True, timeout=180, capture_output=True)
    return out.read_bytes()


@pytest.mark.timeout(420)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_candidate_playback_starts_promptly_with_a_realistic_file(tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    store = vault_store.configure([("install", install), ("cache", cache)],
                                  install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", store)
    store.create(PW)
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    import vocalis_server as vs
    monkeypatch.setattr(vs.vault_store, "STORE", store)
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    from vocalis.runtime import paths as rt_paths
    monkeypatch.setattr(rt_paths, "ACE_TEMPLATES", install / "ace_templates.json")
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", install / "ace_candidates.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", install / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", install / "ace_library")

    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [{"index": 0, "name": "R9700"},
                                                          {"index": 1, "name": "R9700"}])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    _start_owned_children(monkeypatch)
    monkeypatch.setattr(rt_ace, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": STUB_MODELS[url]})
    monkeypatch.setattr(rt_ace, "inventory", lambda url: {
        "reachable": True, "models": list(STUB_MODELS.values()),
        "loaded": STUB_MODELS[url]})

    big = _big_flac(tmp_path)
    assert len(big) > 10_000_000, (
        f"the fixture is only {len(big):,} bytes — this spec is meaningless below about 10 MB, "
        "because a small file starts instantly on every build including the broken ones")

    submitted = {}

    def fake_submit(url, payload):
        tid = f"task-{len(submitted)}"
        submitted[tid] = {"url": url, "payload": payload, "at": time.time()}
        return tid

    def fake_poll(url, task_id):
        if time.time() - submitted[task_id]["at"] < 1.0:
            return {"status": rt_ace.RUNNING, "audio": [], "progress": 0.4}
        return {"status": rt_ace.SUCCEEDED, "audio": [f"/tmp/{task_id}.flac"], "progress": 1.0}

    monkeypatch.setattr(rt_ace, "submit", fake_submit)
    monkeypatch.setattr(rt_ace, "poll", fake_poll)
    monkeypatch.setattr(rt_ace, "fetch_audio", lambda url, path: big)

    from vocalis.runtime import jobs as jobs_mod
    from vocalis.web import acestep as web_ace
    web_ace.QUEUE._pending.clear()
    web_ace.QUEUE._inflight.clear()
    with jobs_mod.JOBS_LOCK:
        for k in [k for k, v in jobs_mod.JOBS.items() if getattr(v, "kind", "") == "acestep"]:
            jobs_mod.JOBS.pop(k, None)

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(120.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=400)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    # Printed either way: the timings are the point even when everything passes, because a number
    # that is creeping up is the early warning this spec exists to give.
    print(r.stdout)
    assert r.returncode == 0, (
        f"candidate playback stalled with a {len(big):,}-byte fixture:\n{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END. The exit code above cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. The floor is derived from the spec's own unconditional ok() calls, so there is no
    # constant here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=13)
