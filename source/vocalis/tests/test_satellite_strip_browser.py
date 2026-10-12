"""10.21 — the header's FAN slot and satellite block, driven in a REAL browser.

WHY, when test_strip_layout.py already measures a hand copy of the header and a payload test
could pin the JSON: neither can see `renderVram`'s shape signature, the keyed
`buildVram`/`updateVram` split that now spans TWO sources (local cards and satellite cards), or
a genuine layout shift when a satellite section appears and disappears. That gap is exactly the
one power_line_browser_spec.mjs was written to close for the power line at 7.3.6, and it applies
here unchanged.

🔴 THIS DOES NOT STAND UP A SATELLITE, OR STUB `runtime/gpu.py`'s `strip_sample()` TO INCLUDE ONE.
The backend half of 10.21 (local fan sensors and the satellite stats sampler) is a separate,
concurrently-built change this file's own brief does not touch. `satellite_strip_browser_spec.mjs`
drives `hwstrip.js`'s `renderStrip()` directly with fabricated samples shaped like the design
doc's payload contract instead — the same technique `test_power_line_browser.py`'s own "hidden"
case already uses for one assertion. So the server here only needs to serve the PAGE; every figure
it draws is stubbed to nothing before the spec takes over.

Skipped, never failed, when Chrome or node is absent — a dev box without them must not turn the
suite red.
"""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server

import vault
import vault_store
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "satellite_strip_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: Fixed browser screenshot output for direct inspection; this path is outside tmp_path cleanup.
SHOT = REPO_ROOT / "temp" / "satellite_strip.png"


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
def test_the_fan_slot_and_satellite_block_render_in_a_real_browser(tmp_path, monkeypatch):
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

    # 🔴 The suite must not read the host, and this spec does not want the real strip sampler
    # running at all — every sample it measures comes from its own direct `renderStrip()` calls,
    # so the live route is stubbed to the emptiest legal answer rather than to anything realistic.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr("tts_utils.cpu_stats", lambda: {
        "pct": None, "mhz": None, "power_w": None, "temp_c": None, "cores": 8,
        "mem_used_gb": None, "mem_total_gb": None, "mem_reclaimable_gb": None,
        "swap_used_gb": None, "swap_total_gb": None, "mem_psi": None,
        "uptime_s": None, "loadavg": None})
    monkeypatch.setattr(gpu_mod.power, "snapshot", lambda: None)
    gpu_mod._STRIP.update(t=0.0, v=None)              # no stale sample from another test

    SHOT.parent.mkdir(parents=True, exist_ok=True)
    if SHOT.exists():
        SHOT.unlink()                                  # a stale image must not be mistaken for this run's

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome(), str(SHOT)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=240)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, (
        "the header's FAN slot / satellite block failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC)

    # A screenshot is written for a human to look at; its existence proves the capture path ran,
    # not that the layout is right. Only eyes do that — see the spec's own final block.
    assert SHOT.exists() and SHOT.stat().st_size > 10_000, "no screenshot was captured"
