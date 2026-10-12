"""Exercise the header's power line in a headless browser against a live test server.

The server tests validate JSON and the layout tests measure a markup copy. Neither verifies the
page's `renderStrip` fan-out, shape signature, `numDue` gate, selectors, polling, or rendered DOM.
This test serves a known power sample and checks what the page prints and where it appears.

Skip when Chrome or Node.js is unavailable.
"""
import os
import shutil
import socket
import subprocess
import time
import threading
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import vault
import vault_store
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "power_line_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: The reading the page is expected to print. A spike well above the live figure, because the
#: peak carrying something the averages have forgotten is the point of sampling server-side.
#: The peak's split is DELIBERATELY not the live one: the peak is a different moment, and a page
#: that attributed it with the current sample's numbers would look right on any fixture where
#: they happen to match.
FAKE_POWER = {"w": 655, "cpu_w": 62, "gpu_w": 593, "gpus": 2,
              "avg": [640, 620, 300], "span_s": 900,
              "peak_w": 812, "peak_ago_s": 3600, "since_s": 7200, "n": 900,
              "peak_cpu_w": 219, "peak_gpu_w": 593}


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
def test_the_power_line_prints_in_a_real_browser(tmp_path, monkeypatch):
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

    # Stub every hardware reading so the page assertion is independent of the test host.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr("tts_utils.cpu_stats", lambda: {
        "pct": 420, "mhz": 3900, "power_w": 62, "temp_c": 61, "cores": 32,
        "mem_used_gb": 15.2, "mem_total_gb": 89.7, "mem_reclaimable_gb": 4.0,
        # The two lines above the power one, so the row-order check has something to be under.
        "swap_used_gb": 9.1, "swap_total_gb": 64.0,
        "mem_psi": {"avg10": 0.0, "avg60": 0.0, "avg300": 0.01, "total_s": 2002},
        "uptime_s": 58980, "loadavg": [0.07, 0.95, 2.14]})
    monkeypatch.setattr(gpu_mod.power, "snapshot", lambda: dict(FAKE_POWER))
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
        "the header's power line failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END. The exit code above cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. The floor is derived from the spec's own unconditional ok() calls, so there is no
    # constant here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=17)

    # 🔴 AND THE HELD STREAM GAVE ITS SLOT BACK. `_strip_streams` is a module-level counter shared
    # by every test in this xdist worker — the same shape as `voiceswap.JOBS` and `gpu._STRIP`,
    # both of which leaked and are now drained in conftest. This one must NOT be drained there: if
    # a browser that held a stream leaves the count raised, that is a defect in `web/system.py`,
    # and a per-test reset would hide it. Past `MAX_STRIP_STREAMS` such tests, every later browser
    # spec is refused a stream and silently falls back to polling — which would make the
    # `__stripTransport === 'stream'` assertion in this very spec start failing for a reason that
    # has nothing to do with the page.
    #
    # 📌 ASSERTED HERE RATHER THAN IN A TEST OF ITS OWN, because this spec is already PROVEN to
    # open one. A standalone holder page was written first and never opened a stream at all —
    # headless Chrome with no debugger attached appears to treat the page as hidden, and
    # `startIdleVram()` deliberately opens nothing on a hidden tab. Its own vacuity guard caught
    # that rather than reporting "no leak" from a page that never streamed.
    #
    # ⚠️ Polled, not asserted instantly: the release runs on the SERVER thread as the socket goes,
    # so an immediate assertion would be a race that fails under load and reads as a flake.
    from vocalis.web import system as web_system
    for _ in range(200):
        if web_system.strip_stream_count() == 0:
            break
        time.sleep(0.05)
    assert web_system.strip_stream_count() == 0, (
        "the browser held a strip stream and its slot was never released. That counter is "
        f"module-level, so after {web_system.MAX_STRIP_STREAMS} such tests every later browser "
        "spec is refused a stream and quietly falls back to polling. THE FIX IS IN "
        "web/system.py, NOT a fixture reset — that would hide a real leak in the release code.")
