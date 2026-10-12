"""6.2 — the star on a Clips row, driven in a REAL headless browser.

WHY, when `test_clip_favorites.py` covers the route and `clips_ui_smoke.mjs` covers the
renderer: both of those have passed before while the page was visibly broken. The smoke runs the
helpers in a bare `vm` with a stubbed `$` and no CSS at all, so it cannot see a control painted
invisible, a click landing on the wrong element, or a star that never reaches the server.

🔴 The check this file exists for is PERSISTENCE ACROSS A RELOAD. A star held in the page's own
state passes every other check here — it renders, it filters, it toggles back — and is gone the
moment he refreshes. That is precisely the defect 6.2-m1 fixed for three other settings, which
were being written to raw `localStorage` and swept on every boot by `UIS`.

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

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import scenes
import vault
import vault_store
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "clips_favorites_browser_spec.mjs"
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
def test_a_star_survives_a_reload_because_it_lives_on_the_server(tmp_path, monkeypatch):
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
    # Patch OUTPUT_DIR before loading the page so the browser cannot enumerate host renders.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")
    # …and the favorites file is an INSTALL file, so it must land in the temp install too, or
    # the test writes a star into the developer's own Vocalis.
    from vocalis.runtime import paths
    monkeypatch.setattr(paths, "CLIP_FAVORITES", install / "clip_favorites.yaml")

    out = tmp_path / "output"
    import book_to_audio
    import vocalis.web.clips as clips_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", out)

    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    # Placeholder bytes are the honest fixture here: nothing in this spec plays anything, and a
    # real encode would cost seconds per scene for no assertion.
    for i, title in enumerate(("The lighthouse keeper", "The ferry at dusk")):
        (root / f"scene{i}_ab12cd3{i}.mp3").write_bytes(b"ID3 fake audio")
        scenes.write_manifest(root / f"scene{i}_ab12cd3{i}.yaml",
                              {"title": title, "source": "st", "chat": "a chat", "gap_s": 0.7,
                               "total_duration_s": 20.0, "entries": []})

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

    assert r.returncode == 0, ("the Clips favorites failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=16)

    # A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("the star is a real control with a real size",
                  "and it is actually visible",
                  "the star is in its OWN column",
                  "clicking it fills the star in",
                  "the server has it too",
                  "favorites only shows exactly the starred row",
                  "the star SURVIVES a reload",
                  "and un-starring clears it on the server too",
                  # 7.5: this one used to read `window.__vocalisErrors`, which nothing in
                  # src/webui/ has ever set — so it passed on every run whatever the page threw.
                  # The spec installs its own collector now, once per document.
                  "no uncaught page errors after the reload"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
