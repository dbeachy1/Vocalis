"""7.5.25 — a focused file input must not open its picker on Space.

This is native keyboard behavior: a focused input[type=file] opens on Enter or Space. The browser
spec sends the key and observes Chrome's Page.fileChooserOpened event, which cannot be inferred
from the DOM. It enables Page.setInterceptFileChooserDialog first so the picker is observed but
never displayed as a modal dialog. A browser test is required; source assertions cannot observe
this behavior."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

SPEC = Path(__file__).parent / "file_picker_guard_spec.mjs"
NODE = shutil.which("node")


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



@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_spacebar_never_opens_a_file_dialog(tmp_path, monkeypatch):
    # This spec presses keys on a page and reads no data, but the page still LISTS things on the
    # way up — so the stores are pinned like every other browser spec rather than pointed at the user.
    out = tmp_path / "output"
    for d in ("output/stems", "uploads/songs", "uploads/stems", "voice_training",
              "voice_models", "cache", "acestep", "Applio", "books"):
        (tmp_path / d).mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("VOCALIS_SONGS_DIR", str(tmp_path / "uploads" / "songs"))
    monkeypatch.setenv("VOCALIS_STEM_UPLOADS_DIR", str(tmp_path / "uploads" / "stems"))
    monkeypatch.setenv("VOCALIS_ACESTEP_DIR", str(tmp_path / "acestep"))
    monkeypatch.setenv("VOCALIS_TRAINING_DIR", str(tmp_path / "voice_training"))
    monkeypatch.setenv("VOCALIS_APPLIO_DIR", str(tmp_path / "Applio"))
    monkeypatch.setenv("VOCALIS_RVC_DIR", str(tmp_path / "voice_models"))
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(tmp_path / "cache"))

    settings = tmp_path / "app_settings.yaml"
    settings.write_text(yaml.safe_dump({"output_dir": str(out)}), encoding="utf-8")

    import book_to_audio
    import vocalis.runtime.settings as rt_settings
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings)
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)

    import vocalis_server as vs
    vs.app.config["TESTING"] = False

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, ("the spacebar opened a file dialog:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    # ⚠️ THE FLOOR IS THE UNCONDITIONAL COUNT, NOT THE 8 THIS SPEC EMITTED WHEN MEASURED.
    # 2 of its assertions sit behind a branch, so a slower box or a loaded run can emit
    # fewer and still be entirely correct. A floor pinned to a good run's number would fail
    # intermittently - this guard caused the same failure shape as the flakes this
    # work removed. The floor must hold on the WORST run, not the observed one.
    assert_spec_ran(r, SPEC, floor=6)

    # 🔴 A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("the Upload-a-voice input is a bare, visible file input",
                  "and focus really lands on it",
                  "SPACE on it opens NO file dialog",
                  "Space opens none on the Book upload either",
                  "but ENTER still opens one",
                  "Space in a text box opens nothing",
                  "and still TYPES a space",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
