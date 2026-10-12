"""Browser coverage for the hardware strip fallback paths when telemetry is absent or stalled."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import assert_spec_ran, bound_server  # importing conftest is also the sys.path side effect

import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.web import system as web_system

SPEC = Path(__file__).parent / "strip_fallback_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

CPU = {"pct": 42, "mhz": 3900, "power_w": 62, "temp_c": 61, "cores": 32,
       "mem_used_gb": 15.2, "mem_total_gb": 89.7, "mem_reclaimable_gb": 4.0,
       "swap_used_gb": 9.1, "swap_total_gb": 64.0,
       "mem_psi": {"avg10": 0.0, "avg60": 0.0, "avg300": 0.01, "total_s": 2002},
       "uptime_s": 58980, "loadavg": [0.07, 0.95, 2.14]}


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


def _run(tmp_path, monkeypatch, mode):
    """One browser run against a server configured to break the stream in `mode`'s way."""
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

    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    monkeypatch.setattr("tts_utils.cpu_stats", lambda: dict(CPU))
    monkeypatch.setattr(gpu_mod.power, "snapshot", lambda: None)
    gpu_mod._STRIP.update(t=0.0, v=None)

    if mode == "refused":
        # 🔴 ZERO, not one: `_strip_stream_open` refuses on the FIRST request, so the page never
        # gets a stream at all and the 503 cue is what has to carry it.
        monkeypatch.setattr(web_system, "MAX_STRIP_STREAMS", 0)
    else:
        # ⚠️ SIX SECONDS: twice the client's 3s STALL_MS, which is all this needs, and NOT the
        # thirty it used to be. 🔴 THE SLOT IS RELEASED WHEN THE WRITER NEXT WAKES, so the release
        # lag equals the frame interval — at thirty seconds this test left a slot claimed long
        # after it finished and handed 503s to whatever ran next in the same xdist worker. The
        # full suite caught it; it passed alone. In production the interval is 0.25s and the lag
        # is invisible, which is exactly why only an exaggerated test could show it.
        monkeypatch.setattr(web_system, "STRIP_FRAME_S", 6.0)

    # The slot release is the signal the `finally` below waits on: the real release runs, then
    # the waiter is woken, so the counter is never polled.
    stream_closed = threading.Condition()
    real_close = web_system._strip_stream_close

    def _noting_close():
        real_close()
        with stream_closed:
            stream_closed.notify_all()
    monkeypatch.setattr(web_system, "_strip_stream_close", _noting_close)

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        return subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome(), mode],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=240)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        # 🔴 DO NOT HAND THE NEXT TEST A DIRTY COUNTER. The stalled stream's generator is asleep
        # between frames, so its slot is freed only when that sleep ends — after this function
        # would otherwise return. A test that leaves shared process state dirty is not finished,
        # however green it reports, and `_strip_streams` is shared by every test in this worker.
        # Waits on the release itself (`_strip_stream_close`, patched above), so it returns the
        # moment the sleeping generator wakes and unwinds, however long that takes up to the
        # ceiling; a slot that never comes back is reported rather than left for the next test.
        try:
            with stream_closed:
                released = stream_closed.wait_for(
                    lambda: web_system.strip_stream_count() == 0, timeout=20)
            assert released, ("a strip stream slot was never released: "
                              f"{web_system.strip_stream_count()} still claimed")
        finally:
            socket.setdefaulttimeout(old_timeout)


@pytest.mark.timeout(300)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_refused_stream_falls_back_to_polling(tmp_path, monkeypatch):
    r = _run(tmp_path, monkeypatch, "refused")
    assert r.returncode == 0, ("a 503-refused strip stream did not fall back in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR PER MODE, NOT A SHARED ONE. This spec takes the mode as an argv and gates four
    # assertions on `if (mode === 'stalled')`, so the two tests emit different counts BY DESIGN.
    # One shared number would be too high for the smaller mode (intermittent red) and too low
    # for the larger (a guard doing less than it looks like it does). Each measured separately.
    assert_spec_ran(r, SPEC, floor=5)

    # 🔴 AND IT RAN TO THE END - exiting 0 cannot tell a pass from a spec that stopped checking.
    # ⚠️ AN EXPLICIT floor=, NOT THE DERIVED ONE, AND THAT IS THE WHOLE POINT OF THIS FILE BEING
    # DIFFERENT. Every ok() call in this spec sits inside a conditional, so the derived floor is 0
    # - a check that would read exactly like a guard while asserting nothing. conftest's helper
    # REFUSES that rather than installing it quietly. The number below was MEASURED: set absurdly
    # high once, then read off the failure message. Never guess it - a floor under the true count
    # permits precisely the drift it exists to catch.


@pytest.mark.timeout(300)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_stream_that_goes_quiet_hands_over_to_the_poll(tmp_path, monkeypatch):
    r = _run(tmp_path, monkeypatch, "stalled")
    assert r.returncode == 0, ("a silent strip stream did not hand over to the poll in a real "
                               f"browser:\n{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR PER MODE, NOT A SHARED ONE. This spec takes the mode as an argv and gates four
    # assertions on `if (mode === 'stalled')`, so the two tests emit different counts BY DESIGN.
    # One shared number would be too high for the smaller mode (intermittent red) and too low
    # for the larger (a guard doing less than it looks like it does). Each measured separately.
    assert_spec_ran(r, SPEC, floor=5)
