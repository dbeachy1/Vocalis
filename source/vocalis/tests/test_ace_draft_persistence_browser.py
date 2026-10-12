"""Exercise ACE draft persistence in a real browser, including the selected template. Verify the UI change event, debounced server-side flush, reload restore, and a transient template-list failure that must retry rather than appear empty. The two-tab case proves per-key updates merge so a tab with an older snapshot cannot overwrite another tab's later selection."""
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

SPEC = Path(__file__).parent / "ace_draft_persistence_spec.mjs"
TWOTAB_SPEC = Path(__file__).parent / "ace_draft_twotab_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

STUB_INSTALLED = [
    ("acestep-api.service", "http://127.0.0.1:7683", "cuda:0"),
    ("acestep-api-gpu1.service", "http://127.0.0.1:7685", "cuda:1"),
]
STUB_MODELS = {"http://127.0.0.1:7683": "acestep-v15-turbo",
               "http://127.0.0.1:7685": "acestep-v15-xl-sft"}


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


def _setup(tmp_path, monkeypatch):
    """The shared harness: a real app over a test vault, ACE-Step stubbed at the client seam."""
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
    # ⚠️ Unlike the sibling harnesses this one REALLY exercises /ui-state, so the state file
    # must be routed into the test vault rather than wherever paths.BASE_DIR points.
    monkeypatch.setattr(rt_paths, "UI_STATE", install / "ui_state.yaml")

    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [{"index": 0, "name": "R9700"},
                                                          {"index": 1, "name": "R9700"}])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr(rt_ace, "installed", lambda: list(STUB_INSTALLED))
    monkeypatch.setattr(rt_ace, "active_count", lambda *_a: 2)
    monkeypatch.setattr(rt_ace, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": STUB_MODELS[url]})
    monkeypatch.setattr(rt_ace, "inventory", lambda url: {
        "reachable": True, "models": list(STUB_MODELS.values()),
        "loaded": STUB_MODELS[url]})
    return vs


def _run_spec(vs, spec, timeout=240):
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(120.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        return subprocess.run([NODE, str(spec), f"http://127.0.0.1:{port}/", _chrome()],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)


@pytest.mark.timeout(300)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
@pytest.mark.parametrize("locked_window_ms", [0, 3000],
                         ids=["healthy", "locked-window-after-boot"])
def test_the_selected_template_survives_a_reload(tmp_path, monkeypatch, locked_window_ms):
    vs = _setup(tmp_path, monkeypatch)
    inner = vs.app.wsgi_app
    if locked_window_ms:
        # /acestep/templates 500s for the first N ms after every `/` load: the just-restarted
        # locked-vault window, at the HTTP level, without faking vault internals.
        boot_at = {"t": 0.0}

        def gated(environ, start_response):
            p = environ.get("PATH_INFO", "")
            if p == "/":
                boot_at["t"] = time.time()
            if (p == "/acestep/templates"
                    and environ.get("REQUEST_METHOD") == "GET"
                    and (time.time() - boot_at["t"]) * 1000 < locked_window_ms):
                start_response("500 INTERNAL SERVER ERROR",
                               [("Content-Type", "application/json")])
                return [b'{"error": "the vault is locked"}']
            return inner(environ, start_response)

        vs.app.wsgi_app = gated

    try:
        r = _run_spec(vs, SPEC)
    finally:
        vs.app.wsgi_app = inner

    print(r.stdout)
    assert r.returncode == 0, (
        f"the draft chain broke — see the per-link output above:\n{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END. The exit code above cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. The floor is derived from the spec's own unconditional ok() calls, so there is no
    # constant here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=6)


@pytest.mark.timeout(300)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_second_open_tab_cannot_erase_the_first_tabs_pick(tmp_path, monkeypatch):
    """Per-key updates must merge on the server. A second tab opened before the first tab selects a template must not erase that selection when it later changes an unrelated key."""
    vs = _setup(tmp_path, monkeypatch)
    r = _run_spec(vs, TWOTAB_SPEC)
    print(r.stdout)
    assert r.returncode == 0, (
        f"a stale tab reverted another tab's state — the whole-blob PUT is back:"
        f"\n{r.stdout}\n{r.stderr}")

    # 🔴 THIS TEST RUNS THE SPEC TOO, AND HAD NO FLOOR. Found by counting spec runs against
    # guards across every wrapper - the first test in this file was guarded and this one was not,
    # so it could stop checking silently while its sibling looked after the file's reputation.
    # ⚠️ MEASURED, not derived.
    assert_spec_ran(r, SPEC, floor=5)
