"""Browser coverage for the board, VRM, and RAM temperature readouts.

The unit tests cover sensor parsing; this browser spec checks the rendered header: placement in
its grid cell, alignment with the adjacent status row, and independent warning colors for each
readout. It uses a real headless browser and skips when Chrome or Node.js is unavailable.
"""
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
from vocalis.runtime import temps as rt_temps

SPEC = Path(__file__).parent / "board_temp_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: Distinct sensor values expose swapped labels; `dimms` supplies the module count used by the
#: tooltip. Keep the board-to-VRM offset so the rendered values remain easy to distinguish.
FAKE_TEMPS = {"mb": 37, "vrm": 54, "ram": 43, "dimms": 2}


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
def test_the_board_temperatures_print_in_a_real_browser(tmp_path, monkeypatch):
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

    # The suite must not read host sensors. Stub each figure so the test is independent of the
    # machine running it, whether or not board sensors are available.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr("tts_utils.cpu_stats", lambda: {
        "pct": 420, "mhz": 3900, "power_w": 62, "temp_c": 61, "cores": 32,
        "mem_used_gb": 15.2, "mem_total_gb": 89.7, "mem_reclaimable_gb": 4.0,
        # The rows this readout has to NOT have moved — the spec measures their right edges.
        "swap_used_gb": 9.1, "swap_total_gb": 64.0,
        "mem_psi": {"avg10": 0.0, "avg60": 0.0, "avg300": 0.01, "total_s": 2002},
        "uptime_s": 58980, "loadavg": [0.07, 0.95, 2.14]})
    monkeypatch.setattr(gpu_mod.power, "snapshot", lambda: {
        "w": 655, "cpu_w": 62, "gpu_w": 593, "gpus": 2, "avg": [640, 620, 300],
        "span_s": 900, "peak_w": 812, "peak_ago_s": 3600, "since_s": 7200, "n": 900,
        "peak_cpu_w": 219, "peak_gpu_w": 593})
    # 🔴 A UPS IS STUBBED SO THE "TWIN" ASSERTIONS HAVE SOMETHING TO MEASURE. This line is
    # #upsLine's twin — same column, same right edge, one row up — and with the UPS absent
    # that element is display:none with a 0x0 rect, so both checks compared against zero and
    # reported a failure that was purely this fixture. An assertion about two things agreeing
    # needs BOTH of them on the page.
    monkeypatch.setattr(gpu_mod.ups, "snapshot", lambda: {
        "status": "OL", "load_pct": 47, "w": 705, "batt_pct": 100, "runtime_s": 1440,
        "input_v": 123.3, "nominal_w": 1500, "model": "PR1500LCD", "charging": False,
        "replace_batt": False, "age_s": 1.2, "warn_pct": 85})
    # ⚠️ EVERY THRESHOLD FROM THE REAL CONSTANT, NEVER A LITERAL. The spec drives each figure past
    # its own threshold and reads them back out of /system/stats, so a fixture hardcoding 60/95/55
    # would keep passing after any of them moved — which is the copy that sending `warn` at all
    # exists to prevent. The board pair comes from WARN_C; RAM's is the module's own `temp1_max`,
    # for which the fallback constant stands in here.
    monkeypatch.setattr(gpu_mod.temps, "snapshot",
                        lambda: dict(FAKE_TEMPS,
                                     warn=dict(rt_temps.WARN_C, ram=rt_temps.RAM_WARN_DEFAULT)))
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
        "the header's board temperature readout failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END - exiting 0 cannot tell a pass from a spec that stopped checking.
    # ⚠️ AN EXPLICIT floor=, BECAUSE THE DERIVATION FAILS ON THIS FILE - NOT BECAUSE THE SPEC IS
    # CONDITIONAL. conftest's scanner derives 0 here and refuses rather than installing a check that
    # asserts nothing; but measured properly, ZERO of these 41 ok() calls sit inside an if or a for.
    # The 0 is the scanner's brace tracking losing a close inside a template literal. That matters
    # for trusting the number below: if the calls really were conditional, pinning their full count
    # would be brittle on any box where a branch did not fire. They are not, so 41 is stable.
    # The number was MEASURED - set absurdly high once, then read off the failure message. Never
    # guess it: a floor under the true count permits precisely the drift it exists to catch.
    assert_spec_ran(r, SPEC, floor=41)
