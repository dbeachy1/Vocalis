"""Browser coverage for the Appearance text-size slider and the rendered root scale. The test isolates browser state and checks the visible result."""
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

SPEC = Path(__file__).parent / "ui_font_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"


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



# ✅ ONE ATTEMPT AS OF 7.3-m12b, BECAUSE THE RACE THIS LOOP EXISTED FOR WAS A BUG IN THE SPEC.
#
# What stood here, and it was wrong in an instructive way:
#
#   "🔴 ATTEMPTS, BECAUSE THIS SPEC RACES THE APP AND THE RACE IS PARKED. … The failure signature
#    is always the same: after the reload the page reports `cache=16, --fs=16px, server=16` … So
#    the server loses the write. `PUT /settings/app` is a load → mutate → save under
#    `settings.APP_LOCK`; a lost update there is the shape that comment warns about, and a slow
#    machine widens the window. ⚠️ THIS DOES NOT FIX THAT, ON PURPOSE, AND THIS RETRY DOES NOT ADDRESS THE SERVER-SIDE RACE."
#
# 🔴 THE SERVER NEVER LOST A WRITE. IT NEVER RECEIVED ONE. Settled by dumping the file rather than
# by reasoning about it: at the end of a full three-attempt run `install/app_settings.yaml`
# **did not exist**, and a fetch interceptor recorded **zero** PUTs. The cause is in
# `ui_font_browser_spec.mjs`'s `waitFor`, which tested `!!(<expression>)` — and `!!` of a Promise is
# `true`, synchronously. So the assertion "and persisted to the server" passed on its first poll
# without reading a response, and returning instantly is what let `Page.navigate` fire before the
# PUT's 250ms debounce, discarding it. That file's note has the full mechanism.
#
# 📌 EVERY OBSERVATION IN THE OLD PARAGRAPH WAS ACCURATE AND THE CONCLUSION WAS STILL WRONG. Slow
# runs really did fail more often — a slower box gives the debounce more chance to fire before the
# navigate, so a LOST update and an UNSENT one produce the same correlation with wall-clock. The
# two are separated by one question (did anything get written?) which nobody asked for two sessions.
#
# 🔴 AND THE RETRY LOOP IS WHY THEY DIDN'T HAVE TO. It converted a deterministic, reproducible,
# five-minute defect into a 1-in-8 annoyance with a paragraph explaining it away. **A retry is a
# decision to stop learning from a failure**; it is worth it only when the cause is understood and
# genuinely external. Here it hid the evidence AND the check it was protecting was vacuous, so the
# suite was paying for three browser launches to assert nothing.
#
# ⚠️ IF THIS GOES RED, BELIEVE IT. There is no known flake in this spec any more, and re-running it
# to see if it passes the second time is the habit this comment exists to end.
#
# ⚠️ The timeout marker stays regardless — a single browser attempt still exceeds `pytest.ini`'s
# `--timeout=60` on a loaded box, and `--timeout-method=thread` kills the whole xdist worker rather
# than failing the test, which surfaces as `node down: Not properly terminated` with none of the
# spec's output (test_wbedit_browser.py:568).
_ATTEMPTS = 1


@pytest.mark.timeout(120)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_text_size_setting_actually_resizes_text(tmp_path, monkeypatch):
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
    # 🔴 Never the developer's real app_settings.yaml: this test WRITES ui_font_px, and pointing
    # it at the host would leave the user's UI at whatever size the spec finished on.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    # 🔴 THE SENSOR ROW HAS TO EXIST FOR THE FLOOR CHECK TO MEAN ANYTHING. `.ulab` is rendered per
    # GPU row, so without this the spec's `max(0.75rem,12px)` assertions depend on what hardware
    # the host happens to enumerate — and they did: this test passed alone and failed inside the
    # full suite, where `getComputedStyle(null)` threw a TypeError that named nothing useful.
    # Mocked exactly as test_devices_browser.py does, so the host's real card count is never asserted
    # against.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    # ⚠️ THE SERVER STAYS UP ACROSS ALL THREE ATTEMPTS, and `app_settings.yaml` with it — so a
    # retry is NOT a fresh install, and one specific thing makes it work:
    #
    # 🔴 THE RETRY LEANS ON THE SPEC ENDING WITH RESET, AND WOULD BE USELESS WITHOUT IT. The spec's
    # first assertion is `the page renders at the 16px base`. Attempt 2 gets a fresh Chrome profile
    # (the spec mkdtemps one), so its localStorage is empty and the size it sees comes from the
    # SERVER — which attempt 1 left at whatever it finished on. `$('uiFontReset').click()` is the
    # last thing the spec does and it persists 16, including on the failing path: the observed
    # failures all still printed `Reset returns to the 16px default`. Move Reset earlier, or stop
    # persisting it, and every retry fails its baseline for a reason that has nothing to do with
    # the check that failed first.
    #
    # ⚠️ An attempt that THROWS before Reset (`the Appearance panel never rendered`) does leave the
    # server dirty. That is fine and deliberate: those are hard failures, and they fail all three
    # attempts either way.
    attempts = []
    try:
        for _ in range(_ATTEMPTS):
            r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=180)
            attempts.append(r)
            if r.returncode == 0:
                break
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    # 🔴 THE WRITE REACHED DISK, ASSERTED SEPARATELY FROM THE BROWSER'S VIEW OF IT — 7.3-m12b.
    # The spec asks the SERVER over HTTP, which is the right question for the feature and the wrong
    # one for the bug that hid here for two sessions: a GET returning the clamped DEFAULT is
    # indistinguishable from a GET returning a stored 16, so `server=16` read as "the write was
    # lost" when the truth was that `app_settings.yaml` had never been created at all. Looking at
    # the file is what separated them, so the check that separates them lives here permanently.
    #
    # ⚠️ NOT `ui_font_px == 16`, and not any value. The spec's last act is Reset, which persists 16
    # deliberately — so the VALUE proves nothing and the KEY'S EXISTENCE proves everything: it can
    # only be there if a PUT was sent, accepted and saved.
    app_settings = install / "app_settings.yaml"
    assert app_settings.exists(), (
        "the spec finished without app_settings.yaml ever being created, so not one of its PUTs "
        "reached the server. Every persistence check it makes is then vacuous and its reload "
        "assertions are measuring localStorage. See the `_ATTEMPTS` note above — this is exactly "
        "the state that was mistaken for a lost-update race for two sessions.")
    assert "ui_font_px" in app_settings.read_text(encoding="utf-8"), (
        "app_settings.yaml exists but holds no ui_font_px — the route accepted a PUT that did not "
        "carry the setting, or save_app_settings wrote a dict it had not merged into.")
    assert attempts[-1].returncode == 0, (
        "the text-size setting failed in a real browser. 🔴 THERE IS NO KNOWN FLAKE IN THIS SPEC — "
        "the 'parked timing race' it used to retry around was a bug in the spec's own `waitFor` "
        "and was fixed at 7.3-m12b. Re-running to see whether it passes the second time is the "
        "habit that hid it for two sessions. Read this instead:\n\n"
        + "\n\n".join(f"── attempt {i + 1} ──\n{a.stdout}\n{a.stderr}"
                      for i, a in enumerate(attempts)))

    # 🔴 AND THE ATTEMPT THAT PASSED RAN TO THE END. Exiting 0 cannot tell a pass from a spec
    # that stopped checking early. ⚠️ MEASURED ON `attempts[-1]`, NOT ON AN ARBITRARY ATTEMPT:
    # this wrapper retries up to _ATTEMPTS times and keeps them all, so a guard placed on the
    # wrong element would assert against a FAILED run that a later one superseded - which is why
    # the mechanical sweep refused this file instead of guessing.
    assert_spec_ran(attempts[-1], SPEC)
