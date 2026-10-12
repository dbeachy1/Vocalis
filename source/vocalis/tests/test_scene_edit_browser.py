"""6.1-m1b — staging an edit and applying it, driven end to end in a REAL browser.

🔴 WHY, when test_scene_edit.py drives the stitch against real ffmpeg and clips_ui_smoke.mjs
checks the markup: because 6.0 shipped four defects past a green suite and every one of them
lived in the seam between those two files. The renderer built the right table, the verb produced
the right audio, and the button in the middle did nothing.

This is the whole trip: copy a Playground clip, expand a scene's chapters, paste it over a line,
press Apply, and watch a NEW scene appear in the list with the original still there. Nothing is
stubbed — a real Flask server, a real edit job, real ffmpeg, real Chrome.

Skipped, never failed, when Chrome, node or ffmpeg is absent.
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

SPEC = Path(__file__).parent / "scene_edit_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

LINES = [
    (400, 'Test Character 1', "The lighthouse had not been lit in thirty years, and she knew it."),
    (401, "Test Character 2", "Then whatever is burning up there is burning without our help."),
    (402, 'Test Character 1', "That is precisely what worries me about it."),
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
    return shutil.which("ffmpeg") and shutil.which("ffprobe")


def _tone(path: Path, secs: float, freq=440):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"sine=frequency={freq}:duration={secs}:sample_rate=24000",
                    "-ac", "1", "-b:a", "96k", str(path)],
                   check=True, capture_output=True, timeout=120)
    return path


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")
def test_a_staged_edit_applies_and_writes_a_new_scene(tmp_path, monkeypatch):
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
    # Keep the browser fixture isolated by patching OUTPUT_DIR before any route reads it.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    out = tmp_path / "output"
    import book_to_audio
    import vocalis.web.clips as clips_mod
    import vocalis.web.playground as pg_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", out)
    # 🔴 The PLAYGROUND blueprint captured its own `OUTPUT_DIR` at import (`from book_to_audio
    # import OUTPUT_DIR`), so patching book_to_audio's does not reach it. Without this the tab
    # lists configured output files instead of the temporary fixture.
    monkeypatch.setattr(pg_mod, "OUTPUT_DIR", out)

    # One scene of three messages, built the way a build builds it, plus a Playground clip to
    # paste over the middle line.
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    gap = _tone(tmp_path / "gap.mp3", 0.7, freq=1)
    parts, entries, offset = [], [], 0.0
    for i, (mesid, who, text) in enumerate(LINES):
        p = _tone(tmp_path / f"m{i}.mp3", 2.0, freq=300 + 100 * i)
        if i:
            parts.append(gap)
        parts.append(p)
        entries.append({"mesid": mesid, "character": who, "cache_key": f"k{i}",
                        "offset_s": round(offset, 3), "duration_s": 2.0, "text": text})
        offset += 2.7
    listing = tmp_path / "list.txt"
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(listing), "-c", "copy", str(root / "the_scene_ab12cd34.mp3")],
                   check=True, capture_output=True, timeout=120)
    scenes.write_manifest(root / "the_scene_ab12cd34.yaml", {
        "title": "Sample Story One", "source": "st", "chat": "a chat",
        "created": scenes.now(), "gap_s": 0.7,
        "total_duration_s": round(offset - 0.7, 2), "entries": entries})

    # A Playground clip, in the store the tab lists it from. Its sidecar is what gives it a name
    # and a duration in the library; without one the row is still listed but reads as unknown.
    import playground_clips
    _tone(out / "playground" / 'Test_Voice_1' / "a_better_take_00c0ffee.mp3", 3.0, freq=700)
    playground_clips.write_clip_yaml(
        out / "playground" / 'Test_Voice_1' / "a_better_take_00c0ffee.yaml",
        {"name": "A better take", "text": "the line, done properly", "voice": 'Test_Voice_1.wav',
         "created_ts": 1785000000, "duration_s": 3.0})

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

    assert r.returncode == 0, f"the edit flow failed in a real browser:\n{r.stdout}\n{r.stderr}"

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=17)

    for named in ("the paste buttons appear only once a clip is copied",
                  "copying says so, in the Playground",
                  "Replace asks first",
                  "the staged edit is shown in the running order",
                  "the color is really painted",
                  "Apply wrote a NEW scene",
                  "and the original is still in the list",
                  "exactly one scene was added",
                  "the staged plan is cleared once it has been applied"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

    # 🔴 And the artifact is real, checked from OUTSIDE the browser: a new scene whose manifest
    # says what it was made from. A UI that reported success while writing nothing would pass
    # every check above.
    made = [p for p in root.glob("*.yaml") if p.stem != "the_scene_ab12cd34"]
    assert len(made) == 1, f"expected exactly one new scene, got {[p.name for p in made]}"
    meta = scenes.read_manifest(made[0])
    assert meta["edited_from"] == "the_scene_ab12cd34"
    assert meta["entries"][1]["replaced_with"] == {"kind": "playground",
                                                   "ref": 'Test_Voice_1/a_better_take_00c0ffee'}
    assert (root / "the_scene_ab12cd34.mp3").exists(), "the original was destroyed"
