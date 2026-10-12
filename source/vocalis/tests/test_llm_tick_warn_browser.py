"""Browser coverage for the warning that appears before enabling a GPU while an LLM model is loaded. The test checks dialog ordering and confirms that cancelling does not save the device setting. It skips when Node or Chrome is unavailable."""
import json
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import assert_spec_ran, bound_server

import llama
import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.web import llama as web_llama

SPEC = Path(__file__).parent / "llm_tick_warn_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

ROUTER_PROPS = {"role": "router", "max_instances": 4, "models_autoload": True}
# One model HOLDING and one merely sleeping, because the sleeping one must not be named in the
# dialog — a fixture with only a loaded model cannot see that mistake.
MODELS = {"object": "list", "data": [
    {"id": "big-70b", "source": "preset", "status": {"value": "loaded"}},
    {"id": "dozy-8b", "source": "preset", "status": {"value": "sleeping"}},
]}


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


def _fake_router(cfg, path, body=None, timeout=10.0, method=None):
    if path == "/health":
        return {"status": "ok"}
    if path == "/props":
        return dict(ROUTER_PROPS)
    if path.startswith("/models"):
        return MODELS
    raise AssertionError(f"unscripted {path!r}")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_tick_a_card_warning_works_in_a_browser(tmp_path, monkeypatch):
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    store = vault_store.configure([("install", install), ("cache", cache)],
                                  install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", store)
    store.create(PW)                                  # created => unlocked
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    import vocalis_server as vs
    monkeypatch.setattr(vs.vault_store, "STORE", store)
    # 🔴 The suite must not read (or write) the developer's own app_settings.yaml.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    # 🔴 TWO CARDS, ONE OFF AND ONE ON, AND BOTH HALVES MATTER.
    #
    # One OFF because the whole spec is about turning one on — a fixture whose cards are already
    # ticked has nothing to test.
    #
    # One ON because unticking the LAST card pops the CPU-fallback modal (`saveDevices`: "every
    # card is unticked — renders will fall back to this machine's CPU"), and a one-card fixture
    # therefore fails the "unticking asks nothing" assertion for a reason that has nothing to do
    # with this feature. Measured: it did, first run.
    #
    # Neither count comes from the host; the fixture provides distinct card totals.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 47.5)
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": False},
                                               {"id": "cuda:1", "enabled": True}]})

    import vocalis.runtime.satellites as sat_mod
    monkeypatch.setattr(sat_mod, "health",
                        lambda name: {"reachable": False, "error": "not running",
                                      "devices": [], "ready": False})

    # A LOCAL llama-server holding one model. `local=True` is the gate the whole warning hangs
    # off — a remote engine is silent by design, so a fixture that left it False would pass the
    # Cancel assertions by never opening a dialog at all.
    monkeypatch.setattr(llama, "_request", _fake_router)
    monkeypatch.setattr(web_llama, "_llama_cfg", lambda: llama.LlamaConfig(
        url="http://127.0.0.1:8080", api_key="", local=True))

    # Under `tmp_path` by default, so a suite run leaves nothing behind. `VOCALIS_SHOT_DIR`
    # redirects it somewhere a human can actually open — pytest's numbered temp dirs are
    # retention-pruned, and a picture nobody can find afterward is a picture that was not looked
    # at. Set it when you want to SEE the dialog; leave it unset everywhere else.
    shot = Path(os.environ.get("VOCALIS_SHOT_DIR") or tmp_path) / "tick-warning.png"
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome(), str(shot)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, (
        "the tick-a-card warning failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 THE OTHER LAYER, AND THE SLEEPING ONE IS THE POINT. `dozy-8b` is `sleeping`: routable,
    # `is_running()` true, holding NOTHING. Naming it in the dialog would ask the operator to go and
    # unload something that would free zero bytes — and it would read entirely reasonable.
    assert "dozy-8b" not in r.stdout, (
        "the dialog named a SLEEPING model. `sleeping` releases the weights and the KV cache "
        f"while staying routable, so it is not holding the cards:\n{r.stdout}")

    # And the setting really landed in the file, not just in the page.
    saved = json.loads(json.dumps(rt_settings.load_app_settings()))
    assert saved.get("devices_warn_llm_loaded") is True, (
        f"the warning setting did not round-trip back to ON: {saved.get('devices_warn_llm_loaded')!r}")

    assert shot.exists() and shot.stat().st_size > 10_000, "no screenshot was captured"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a spec that stopped checking
    # — an early return exits 0 and is merely SHORTER.
    assert_spec_ran(r, SPEC)
