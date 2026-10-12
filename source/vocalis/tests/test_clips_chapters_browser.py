"""6.1 §10.3 + §10.4 — the Clips tab's chapters, driven in a REAL headless browser.

WHY a browser test, when test_clips_routes.py and test_clips_ui.py already cover this button:

They cover everything except the things that keep being wrong. The route returns the manifest and
the renderer builds the right table — all true, all tested, all green, through two separate
reports of the button being useless. In 6.1-m0 it was geometry: the panel it revealed was the
last element in the section, so it appeared below the fold. §10.3 replaced the panel with a
detail row under the scene that was clicked, and §10.4 made a chapter link start playback instead
of raising a modal telling him to press play first.

🔴 The assertion that carries this file is ADJACENCY — the detail row's top edge flush with the
clicked row's bottom edge. VERIFIED RED: render the detail rows at the foot of the table instead
and it fails, while "the chapters are in the viewport" still passes at top 395px of a 420px
viewport. That second check is the vacuous one, and it is kept only alongside two preconditions —
that the section runs off the bottom of the window (the m0 lesson), and that the button under
test is on screen to be clicked at all. The second of those caught §10.1 pushing the list down
past the fold, i.e. the spec driving a click no user could make.

⚠️ The cold-seek check is NOT a guard against assigning `currentTime` before metadata, though it
was written believing it was. Measured: neuter `scSeekPlay` to assign unconditionally and this
spec stays green, because assigning at readyState 0 sets the element's default playback start
position and Blink starts playback there. It is an end-to-end check that a cold click lands on
its offset. Said plainly here because a check mislabeled as a guard is how the 6.0-m2a cancel
defect survived review.

🔴 The scene fixture is a REAL mp3, not the placeholder bytes m0 used. The seek checks need a
decodable file with a genuine duration: fake bytes never fire `loadedmetadata`, so every assertion
about where the player ended up would be vacuous or would hang.

Skipped, never failed, when Chrome, node or ffmpeg is absent — a dev box without them must not
turn the suite red.
"""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import scenes
import vault
import vault_store
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "clips_chapters_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

# Enough messages that the chapter list is a list, and long enough text that a row is a row.
# The transcript is fiction: this file goes in git and a real one would not.
LINES = [
    (400, 'Test Character 1', "The lighthouse had not been lit in thirty years, and she knew it."),
    (401, "Test Character 2", "Then whatever is burning up there is burning without our help."),
    (402, 'Test Character 1', "That is precisely what worries me about it."),
    (403, "Test Character 2", "We should go and look before the tide turns against us."),
    (404, 'Test Character 1', "Bring the lamp. I do not intend to come back down in the dark."),
]


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


# 🔴 Worker-banded, NOT bind-to-0 — the old local version released the port before Chrome
# could take it, and that race is what stopped the suite going wider than 12 workers.


def _have_ffmpeg():
    return shutil.which("ffmpeg") is not None


def _real_mp3(path: Path, seconds: int):
    """🔴 A REAL, decodable mp3, which m0's fixture was not.

    m0 only needed the list drawn, and fake bytes were the honest fixture for that. §10.4 needs
    the browser to actually LOAD the file: `loadedmetadata` never fires on junk, so the seek
    checks would either hang or pass vacuously against a player that could never have a duration.
    It has to be longer than the last chapter offset or seeking there clamps and the assertion
    is meaningless."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"sine=frequency=220:duration={seconds}", "-b:a", "48k", str(path)],
        check=True, capture_output=True, timeout=120)


def _seed_scene(root: Path, stem: str, title: str, mp3: Path):
    """A scene is an mp3 plus a manifest."""
    (root / f"{stem}.mp3").write_bytes(mp3.read_bytes())
    entries, offset = [], 0.0
    for mesid, who, text in LINES:
        entries.append({"mesid": mesid, "character": who, "cache_key": f"k{mesid}",
                        "offset_s": round(offset, 2), "duration_s": 4.0, "text": text})
        offset += 4.0 + 0.7                       # speech plus the standard gap
    scenes.write_manifest(root / f"{stem}.yaml", {
        "title": title, "source": "st", "chat": "a chat", "gap_s": 0.7,
        "total_duration_s": round(offset - 0.7, 2), "entries": entries})


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg required to build a decodable fixture")
def test_the_chapters_open_under_the_row_and_a_chapter_starts_playback(tmp_path, monkeypatch):
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
    # Patch output to an isolated temporary directory before loading the page so it cannot
    # enumerate existing book renders.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    out = tmp_path / "output"
    import book_to_audio
    import vocalis.web.clips as clips_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", out)

    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    # Longer than the last chapter offset (4 × 4.7 = 18.8 s) with room to spare, so a seek to it
    # is a real position inside the file rather than a clamp to the end.
    src_mp3 = tmp_path / "fixture.mp3"
    _real_mp3(src_mp3, 30)
    for i, title in enumerate(("The lighthouse keeper", "The ferry at dusk", "Cached rebuild")):
        _seed_scene(root, f"scene{i}_ab12cd3{i}", title, src_mp3)

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
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

    assert r.returncode == 0, (
        "the Clips chapters failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=49)

    # A spec that silently stopped checking exits 0 as happily as one that passed — and the two
    # preconditions are the checks most worth confirming actually ran, because they are what stop
    # the assertions after them from being vacuous.
    for named in ("precondition: the section runs off the bottom of the window",
                  "precondition: the Chapters button under test is on screen",
                  "precondition: the player had NO metadata",
                  "the chapters open IMMEDIATELY under the row",
                  "and it STARTS PLAYING",
                  "typing in Search does not collapse the expanded row",
                  # Keyboard navigation shortcuts.
                  "goes back five seconds",
                  "and an arrow in the search box moves the CURSOR",
                  # 6.1 §10.5 — the player is inline, under the row, and can be put away
                  "puts NO player on screen by itself",
                  "the player opens IMMEDIATELY under the clip it is playing",
                  "and the player MOVES WITH IT",
                  "that placement is the complaint",
                  "pressing it again stops and puts the bar away",
                  # 9.6.7 — the clip runs OUT. Every §10.5 check above drives the BUTTON, so
                  # none of them could see that `scLib.playing` was cleared by `scStop` and by
                  # nothing else: the ordinary end of playback had no code path at all.
                  "the clip really reached its end",
                  "reads Close instead of staying on a red Stop",
                  "still there for him to close",
                  "makes the player disappear, exactly as the word promises",
                  "falls back to the bar at the top",
                  "playback carries on through it",
                  # m4i / §9a.3 — whose voice is this. The seeded scene is a two-hander, so the
                  # "+N others" form and the filter are both exercised on it.
                  "the Clips table has a Character column",
                  "and it sits before Name, right after the star",
                  "the row draws a circular face for the speaker",
                  "and names the first speaker",
                  "with a count of the others rather than a second circle",
                  "and the tooltip names them all",
                  "the character filter is built from who is actually present",
                  "picking a character keeps the scenes they speak in",
                  "and clearing the filter puts them all back",
                  "a filter value that no longer exists falls back to all"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
