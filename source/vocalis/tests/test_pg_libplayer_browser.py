"""Browser tests verify the Playground library player in a real DOM: the audio element opens in its row, the play control reflects the media element state, and playback survives table rebuilds during sort, paging, selection, and refresh. Encoded MP3 fixtures are served through the route because undecodable bytes would leave the media element paused.

Skipped when Chrome, Node, or ffmpeg is unavailable."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import playground_clips
import vault
import vault_store
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "pg_libplayer_browser_spec.mjs"
NODE = shutil.which("node")
FFMPEG = shutil.which("ffmpeg")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

# Three clips, oldest first. The library sorts newest-first by mtime, so the mtimes below decide
# the row order the spec indexes into.
CLIPS = [
    ("The_ferry_at_dusk_ab12cd31", "The ferry at dusk", 1.0),
    ("The_lighthouse_keeper_ab12cd32", "The lighthouse keeper", 1.0),
    ("A_walk_in_the_rain_ab12cd33", "A walk in the rain", 1.0),
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



def _real_mp3(path: Path, seconds: float):
    """A REAL, decodable mp3. Fake bytes would 404-equivalent in the media element: `paused` never
    goes false, and every ■ check would fail while the code was correct."""
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"sine=frequency=220:duration={seconds}", "-b:a", "48k", str(path)],
        check=True, capture_output=True, timeout=120)


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_library_player_opens_in_the_row_and_stops_from_it(tmp_path, monkeypatch):
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

    # The suite must not read the host. Unpatched, OUTPUT_DIR points at the real render tree and
    # CHUNKS_ROOT points at configured workspaces — the library would list existing clips, and this spec would both
    # depend on and display them. web.playground keeps its OWN copies of both (the 5.1 §6.2
    # hazard), so patching book_to_audio alone is not enough.
    out, chunks = tmp_path / "output", tmp_path / "chunks"
    import book_to_audio
    from vocalis.web import playground as web_playground
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(web_playground, "OUTPUT_DIR", out)
    monkeypatch.setattr(web_playground, "CHUNKS_ROOT", chunks)
    chunks.mkdir()

    vdir = out / "playground" / "Narrator"
    vdir.mkdir(parents=True)
    for i, (stem, name, secs) in enumerate(CLIPS):
        mp3 = vdir / f"{stem}.mp3"
        _real_mp3(mp3, secs)
        playground_clips.write_clip_yaml(vdir / f"{stem}.yaml", {
            "voice": "Narrator.wav", "exaggeration": 0.5, "cfg": 0.5, "temperature": 0.8,
            "name": name, "text": f"{name} — a line of narration.", "duration_s": secs})
        os.utime(mp3, (1_754_500_000 + i, 1_754_500_000 + i))   # newest last => row order is reversed

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

    assert r.returncode == 0, ("the Playground library player failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=29)

    # A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("and it opens IN LINE",
                  "the ▶ on that row has become ■",
                  "pressing ■ STOPS it",
                  "a repaint MOVES the very same player node",
                  "and the clip is still playing across the repaint",
                  "and it is STILL PLAYING"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
