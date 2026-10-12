"""Exercise ACE library folder controls in a real browser, including bulk selection, move/unfile actions, and selection across the two-second reconciliation cycle. Route tests cannot verify that controls are rendered or selection persists when rows are replaced. Pin every touched directory to tmp_path and assert isolation before interaction; modules that import OUTPUT_DIR by value must each be patched explicitly. Skip when Chrome or Node is unavailable."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

# 📌 `bound_server` alone: importing the module is what gives conftest's `sys.path` side effect,
# so there is no unused name to suppress. (test_folders_browser.py makes the same point.)
from conftest import assert_spec_ran, bound_server

import vault
import vault_store
import vocalis.runtime.paths as rt_paths

SPEC = Path(__file__).parent / "ace_folders_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: 🔴 NOT DECODABLE AUDIO, AND THAT IS DELIBERATE. Nothing here plays anything — the player's
#: behavior is `test_acestep_playback_browser`'s job, and pulling in ffmpeg to render a tone would
#: make this spec skip on a box that has no ffmpeg for a reason unrelated to anything it checks.
#: The rows still build a real <audio> against a real route; a media element that cannot decode
#: sets `error` on itself, which does not reach the page-error collector (a media error does not
#: bubble to `window`), so it cannot mask the check that matters.
FLAC_ISH = b"fLaC" + b"\0" * 2048


def _chrome() -> str | None:
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
def test_the_ace_library_can_tick_file_and_unfile_songs_in_a_real_browser(tmp_path, monkeypatch):
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

    import vocalis.runtime.settings as rt_settings
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    # ── every store this panel reads or WRITES, inside the temp install ──────────────────────
    # 🔴 `FOLDERS` IS THE ONE THIS TEST EXISTS AROUND: it presses ⇥ Move selected here, ⇤ Remove
    # from folder and a drag-drop, i.e. three writes to it. `UI_STATE` is written too — which
    # folder is open, and which row is expanded, both live there. `ACE_CANDIDATES` is read by the
    # /acestep/jobs poll the tray runs every 2 s.
    monkeypatch.setattr(rt_paths, "FOLDERS", install / "folders.yaml")
    monkeypatch.setattr(rt_paths, "UI_STATE", install / "ui_state.yaml")
    monkeypatch.setattr(rt_paths, "ACE_TEMPLATES", install / "ace_templates.json")
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", install / "ace_candidates.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", install / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", install / "ace_library")

    # 🔴 THE SUITE MUST NOT READ THE HOST — including its cards. `/acestep/status` is polled by
    # the header every four seconds and the tray subscribes to it.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    from vocalis.runtime import acestep as rt_ace
    monkeypatch.setattr(rt_ace, "installed", lambda: [])

    # ── the fixture: one template and two songs, one made from it and one not ────────────────
    # The template is what the library's own filter (§4.5.3) narrows on, and the spec uses it to
    # prove that hiding a row DROPS ITS TICK rather than carrying it invisibly into the next move.
    # ⚠️ NO LYRICS AND NO CAPTION on either. Clicking a row fires `ace:loadsong` into the form
    # above, and a form holding unsaved words puts a confirm dialog in front of the next template
    # change — a modal this spec would then be blocked behind for reasons that are not the bug.
    from vocalis.runtime import acelib, acetemplates
    tpl = acetemplates.save({"name": "Sample Track One"})
    acelib.save(FLAC_ISH, name="Sample Track One", template_id=tpl.id, model="acestep-v15-turbo", seed=12345)
    acelib.save(FLAC_ISH, name="Sample Track Two", model="acestep-v15-turbo", seed=54321)

    # Verify each touched path resolves under tmp_path before the first browser action, so a missing fixture pin fails before any file is read or changed.
    for name in ("FOLDERS", "UI_STATE", "ACE_TEMPLATES", "ACE_CANDIDATES",
                 "ACE_LIBRARY", "ACE_LIBRARY_AUDIO"):
        p = Path(getattr(rt_paths, name)).resolve()
        assert tmp_path.resolve() in p.parents, (
            f"paths.{name} is not pinned into tmp_path - this test would write into the real "
            f"install: {p}")
    # …and that the ROUTES read the very module object those pins were applied to. `paths` is
    # imported as a module everywhere in `vocalis/web/`, never as `from … import FOLDERS`; if that
    # ever changes, the constant is copied at import time and every pin above becomes decorative.
    from vocalis.web import acestep as web_ace
    from vocalis.web import folders as web_folders
    assert web_ace.paths is rt_paths and web_folders.paths is rt_paths, (
        "a web module is holding its own copy of the install paths - the pins above no longer "
        "reach the code under test")
    assert len(acelib.list_songs()) == 2, "the two fixture songs are not in the store the route reads"
    assert not (install / "folders.yaml").exists(), "the folder store should start empty"

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
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

    assert r.returncode == 0, ("the ACE library's tick column failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    # ⚠️ 47 IS THE SPEC'S UNCONDITIONAL `ok(` COUNT, MEASURED — not 43 + "about five". The 9.7.0
    # section added FOUR checks and this was first set to 48 on a miscount, which failed as
    # "the spec did not run to the end" over a spec that had. Counted, not guessed: every one of
    # the 47 call sites is unconditional, so this holds on the worst run as well as the best.
    assert_spec_ran(r, SPEC, floor=49)

    # 🔴 A SPEC THAT SILENTLY STOPPED CHECKING EXITS 0 AS HAPPILY AS ONE THAT PASSED. Naming the
    # assertions here is what turns an early `return`, a renamed selector or a deleted block into
    # a failure rather than into a shorter, still-green run.
    for named in ("the ACE library renders both saved songs",
                  "every library card carries a tick",
                  "each tick names the SAME id the row is keyed and filed on",
                  "the ✚ Folder button is on the library toolbar",
                  "⇤ Remove from folder is on the toolbar too",
                  "sit on ONE line",
                  "stays INSIDE the library panel",
                  "and the tick really is set by a plain click on the box",
                  "ticking a song does NOT open it",
                  "clicking the row itself still opens the lyrics box",
                  "the tick survives two full 2 s repaints of the library",
                  "and the player was never rebuilt underneath it",
                  "both songs can be ticked at once",
                  "selecting a template narrows the library",
                  "and clearing it brings the whole library back",
                  "the template filter drops the tick it hides",
                  "while the song that stayed on screen keeps its tick",
                  "⇥ Move selected here is offered on it",
                  "files the ticked song on the SERVER",
                  "the folder counts the song it now holds",
                  "and the tick set is spent once the rows have gone",
                  "the open folder is immediately followed by the song it holds",
                  "a card INSIDE an open folder carries a tick too",
                  "the filed song can be ticked where it sits, inside its folder",
                  "unfiles the song on the SERVER",
                  "puts it back at the ROOT, below the divider",
                  "and the player survived the move out of the folder",
                  "the panel REFETCHED rather than re-rendering",
                  "dragging a ticked row takes the WHOLE tick set",
                  # Keep a multi-row selection through reconciliation, then remove all selected rows in one action.
                  "both filed songs are painted inside the open folder, with ticks",
                  "the first filed song ticks inside its folder",
                  "both filed songs are ticked where they sit, inside the open folder",
                  "and both ticks are still there three poll cycles later",
                  "unfiles EVERY ticked row, not one of them",
                  "and the folder reads (0) on screen",
                  "the row is still ONE line tall with the tick in it",
                  "the title column still has room for a title",
                  "and the title is not ellipsized at this width",
                  "the tick sits on the title's line",
                  # 9.0.12 - the header toolbar was sizing the rows' actions column, and the
                  # title-vs-player comparison above stayed true for the whole of it.
                  "the row's actions reach the right edge of their own cell",
                  "narrowed to 1100px the title column keeps its floor",
                  "and the row overflows into a horizontal scrollbar instead",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

    # 🔴 AND THE WRITES LANDED IN THE TEMP INSTALL. The browser said the server had filed the
    # songs; this is where that claim is checked against a filesystem the test owns, and it is the
    # other half of the pre-flight assertion above — a pin that is correct at the start and a file
    # that appears in the right place at the end.
    assert (install / "folders.yaml").exists(), (
        "the folder assignments did not land in the temp install - where did they go?")
