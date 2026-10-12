"""Browser coverage for the KoboldCpp warning shown when a model load conflicts with enabled GPUs. The test checks both the dialog and the request sent to the stub router, including cancellation. It skips when Node or Chrome is unavailable."""
import json
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

# Both names are USED below, so this needs no `noqa` — importing `REPO_ROOT` for the
# sys.path side effect alone would cost one, and the side effect happens either way.
from conftest import assert_spec_ran, bound_server

import kobold
import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.web import kobold as web_kobold

SPEC = Path(__file__).parent / "kobold_warn_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

CFG = "01-Chat-Nightfall-Aurora-72B-Q6.kcpps"
MODEL = "koboldcpp/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S"


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


class FakeKobold:
    """A KoboldCpp that answers at the HTTP boundary and REMEMBERS what it was asked to load.

    `loaded` is the second layer of every assertion in the spec: the dialog can say whatever it
    likes, but this list is whether a model was really posted."""

    def __init__(self):
        self.model = "inactive"
        self.loaded = []

    def __call__(self, cfg, path, body=None, timeout=10.0):
        if path == "/api/extra/version":
            return {"result": "KoboldCpp", "version": "1.116.1",
                    "llm": self.model != "inactive", "admin": 2}
        if path == "/api/v1/model":
            return {"result": self.model}
        if path == "/api/admin/list_options":
            return [CFG, "initial_model", "unload_model"]
        if path == "/api/admin/reload_config":
            self.loaded.append(body["filename"])
            # A real load takes seconds and the watcher thread polls for it; flipping the model
            # here lets that thread finish instead of spinning for its full timeout.
            self.model = MODEL
            return {"success": True}
        raise AssertionError(path)


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_ticked_cards_warning_works_in_a_browser(tmp_path, monkeypatch):
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
    settings_file = install / "app_settings.yaml"
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings_file)

    # 🔴 The fixture provides distinct inventories independent of the host, and
    # the whole spec is about what the dialog says about them.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 12.5)
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True},
                                               {"id": "cuda:1", "enabled": True}]})

    # A LOCAL KoboldCpp with configs of its own. `local=True` is the gate the whole feature hangs
    # off — a remote one is silent by design, so a fixture that left it False would pass this file
    # by never warning at all.
    admindir = tmp_path / "kcpps"
    admindir.mkdir()
    (admindir / CFG).write_text(json.dumps({
        "model_param": "/ai-models/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S.gguf",
        "contextsize": 98304, "gpulayers": 999}), encoding="utf-8")
    fake = FakeKobold()
    monkeypatch.setattr(kobold, "_request", fake)
    # ⚠️ AFTER conftest's autouse `_no_local_kobold`, deliberately: that fixture exists so the
    # suite never talks to a real KoboldCpp, and this replaces its stub with a stub of our own
    # rather than letting the host's config through.
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: kobold.KoboldConfig(
        url="https://127.0.0.1:5001", adminpassword="pw", local=True, admindir=admindir))

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=240)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, (
        "the KoboldCpp ticked-cards warning failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 THE OTHER LAYER. Steps 1-3 of the spec clicked Load twice and backed out of both dialogs;
    # step 5 unticked the cards and clicked it once more. So exactly ONE load may have reached
    # KoboldCpp, and it is the one that happened after the cards were free. A dialog that renders
    # perfectly and posts anyway is the failure this list can see and the DOM cannot.
    assert fake.loaded == [CFG], (
        f"KoboldCpp was asked to load {fake.loaded!r} — a warning that posts anyway is not a "
        f"warning, and a load that never happens is a button that does nothing:\n{r.stdout}")

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a spec that stopped checking
    # — an early return exits 0 and is merely SHORTER. MEASURED at 24 unconditional `ok` calls,
    # every one of them at top level in the spec's single try block.
    assert_spec_ran(r, SPEC, floor=24)
