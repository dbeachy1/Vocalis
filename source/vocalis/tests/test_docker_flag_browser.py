"""Release audit 2026-10-11 - the Docker flag reaching the page, in a real browser.

`docker_flag_browser_spec.mjs` loads the real page from a real server and checks the join the
unit tests cannot see: /health's `docker` -> `<html data-docker>` -> which text and controls are
shown (the manual book path, the loopback advice, the KoboldCpp panel's wording). Three modes: a
source run, the package, and the package with no KoboldCpp address. Skips when Node or Chrome is
unavailable."""
import json
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import assert_spec_ran, bound_server

import kobold
import vault
import vault_store
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.settings as rt_settings
from vocalis.web import kobold as web_kobold
from vocalis.web import system as web_system
from vocalis.web import ui as web_ui

SPEC = Path(__file__).parent / "docker_flag_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"
CFG = "01-Chat-Nightfall-Aurora-72B-Q6.kcpps"
#: A second config whose model file really exists, so the source run's "model file missing" is a
#: genuine finding about ONE config rather than the "every model vanished at once" locked-vault case.
CFG_REAL = "02-Real-Model.kcpps"


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


class _DockerPaths:
    """`paths` as one module sees it in Docker mode. Patched into the route modules only, so the
    app's before_request gates (which would demand a bootstrapped vault) keep their environment."""

    def __getattr__(self, name):
        return getattr(rt_paths, name)

    def docker_encrypted_mode(self):
        return True


def _fake_kobold(cfg, path, body=None, timeout=10.0):
    if path == "/api/extra/version":
        return {"result": "KoboldCpp", "version": "1.116.1", "llm": False, "admin": 2}
    if path == "/api/v1/model":
        return {"result": "inactive"}
    if path == "/api/admin/list_options":
        return [CFG, CFG_REAL, "initial_model", "unload_model"]
    raise AssertionError(path)


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
@pytest.mark.parametrize("mode", ["plain", "docker", "docker-unset"])
def test_the_docker_flag_switches_the_page_in_a_browser(mode, tmp_path, monkeypatch):
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
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [{"index": 0, "name": "Test Card A"}])

    admindir = tmp_path / "kcpps"
    admindir.mkdir()
    (admindir / CFG).write_text(json.dumps({
        "model_param": "/ai-models/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S.gguf",
        "contextsize": 98304, "gpulayers": 999}), encoding="utf-8")
    real_model = tmp_path / "real.gguf"
    real_model.write_bytes(b"x")
    (admindir / CFG_REAL).write_text(json.dumps({
        "model_param": str(real_model), "contextsize": 4096, "gpulayers": 10}), encoding="utf-8")
    if mode != "docker-unset":
        # Not in the unset case: the real `_request` is what refuses an empty address ("no URL
        # configured"), and the whole point of that mode is the page's answer to it.
        monkeypatch.setattr(kobold, "_request", _fake_kobold)

    if mode == "plain":
        cfg = kobold.KoboldConfig(url="https://127.0.0.1:5001", adminpassword="pw", local=True,
                                  admindir=admindir)
    elif mode == "docker":
        # The package's situation: KoboldCpp "on this machine" (VOCALIS_KOBOLD_LOCAL=1) but its
        # .kcpps folder is on the host, so the folder is not visible from here.
        cfg = kobold.KoboldConfig(url="http://host.docker.internal:5001", adminpassword="pw",
                                  local=True, admindir=tmp_path / "host-folder-not-mounted")
    else:
        cfg = kobold.KoboldConfig(url="", adminpassword="", local=False)
    monkeypatch.setattr(web_kobold, "_kobold_cfg", lambda: cfg)

    if mode != "plain":
        for module in (web_system, web_kobold, web_ui):
            monkeypatch.setattr(module, "paths", _DockerPaths())

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome(), mode],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=240)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, f"the Docker flag spec failed in a real browser ({mode}):\n{r.stdout}\n{r.stderr}"
    assert_spec_ran(r, SPEC, floor=10)
