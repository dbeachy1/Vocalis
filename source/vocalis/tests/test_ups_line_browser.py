"""Browser coverage for the UPS line in the hardware header, including placement and rendered values."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import ups as rt_ups

SPEC = Path(__file__).parent / "ups_line_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: The reading the page is expected to print — the spec's own worked example, `UPS OL · 47% ·
#: 705 W · batt 100% · 24m`. 47% of 1500 W is 705 W exactly, which is the point: the watts are
#: DERIVED from the load percent, so a fixture whose two numbers do not satisfy that arithmetic
#: would let a renderer that invented its own figure pass.
FAKE_UPS = {"status": "OL", "load_pct": 47, "w": 705, "batt_pct": 100, "runtime_s": 1440,
            "input_v": 123.3, "nominal_w": 1500, "model": "PR1500LCD",
            "charging": False, "replace_batt": False, "age_s": 1.2,
            # 9.0.7 — the peak, and DELIBERATELY WELL ABOVE `w`. Equal to it would be the one
            # value that cannot tell "the peak is printed" from "the live figure is printed
            # twice", which is precisely the reading the spec's regex would give.
            "peak_w": 930,
            # Deliberately the real constant rather than a literal: the spec drives a 92% load
            # past it, and a fixture that hardcoded 85 would keep passing if the module moved.
            "warn_pct": None}


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



@pytest.mark.timeout(300)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_ups_line_prints_in_a_real_browser(tmp_path, monkeypatch):
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

    # 🔴 The suite must not read the host — including its UPS. Every figure is stubbed, so this
    # says the same thing with a UPS present, without a UPS, and on a laptop.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr("tts_utils.cpu_stats", lambda: {
        "pct": 420, "mhz": 3900, "power_w": 62, "temp_c": 61, "cores": 32,
        "mem_used_gb": 15.2, "mem_total_gb": 89.7, "mem_reclaimable_gb": 4.0,
        # The three lines above this one, so the row-order check has something to be under.
        "swap_used_gb": 9.1, "swap_total_gb": 64.0,
        "mem_psi": {"avg10": 0.0, "avg60": 0.0, "avg300": 0.01, "total_s": 2002},
        "uptime_s": 58980, "loadavg": [0.07, 0.95, 2.14]})
    monkeypatch.setattr(gpu_mod.power, "snapshot", lambda: {
        "w": 655, "cpu_w": 62, "gpu_w": 593, "gpus": 2, "avg": [640, 620, 300],
        "span_s": 900, "peak_w": 812, "peak_ago_s": 3600, "since_s": 7200, "n": 900,
        "peak_cpu_w": 219, "peak_gpu_w": 593})
    monkeypatch.setattr(gpu_mod.ups, "snapshot",
                        lambda: dict(FAKE_UPS, warn_pct=rt_ups.WARN_LOAD_PCT))
    gpu_mod._STRIP.update(t=0.0, v=None)              # no stale sample from another test

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
        "the header's UPS line failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END. The exit code above cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. The floor is derived from the spec's own unconditional ok() calls, so there is no
    # constant here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=29)
