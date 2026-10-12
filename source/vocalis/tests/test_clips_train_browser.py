"""Browser coverage for importing a Clips row into the Speech library (Voice Training in the legacy app).

This round trip crosses a click handler, a module cycle, a route, and a second store. Route tests
and the bare renderer smoke cannot verify that the browser wires these pieces together or that the
imported clip arrives selected. A real browser exercises the interaction and fails on uncaught
errors; the test skips when browser tooling is unavailable.
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

SPEC = Path(__file__).parent / "clips_train_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: The two scenes the spec drives, and the difference between them IS one of its checks: a
#: one-hander and a two-hander both send straight through in this edition (the legacy
#: two-hander warning belonged to Voice Training and is gone). The stems are pinned here
#: because the spec addresses rows by `data-ref` — keep them in step with the constants at the top
#: of `clips_train_browser_spec.mjs`.
SOLO = "A_lighthouse_ab12cd30"
DUET = "The_ferry_ab12cd31"

#: The transcript is fiction: this file goes in git, and a real one would not.
SOLO_LINES = [(400, 'Test Character 1', "The lighthouse had not been lit in thirty years, and she knew it."),
              (401, 'Test Character 1', "That is precisely what worries me about it.")]
DUET_LINES = [(500, 'Test Character 1', "Bring the lamp. I do not intend to come back down in the dark."),
              (501, "Test Character 2", "Then whatever is burning up there is burning without our help.")]


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



def _seed_scene(root: Path, stem: str, title: str, lines):
    """A scene is an mp3 plus a manifest. Placeholder bytes are the honest fixture — nothing in
    this spec plays anything, and a real encode would cost seconds per scene for no assertion."""
    (root / f"{stem}.mp3").write_bytes(b"ID3 fake audio")
    entries, offset = [], 0.0
    for mesid, who, text in lines:
        entries.append({"mesid": mesid, "character": who, "cache_key": f"k{mesid}",
                        "offset_s": round(offset, 2), "duration_s": 4.0, "text": text})
        offset += 4.0 + 0.7                       # speech plus the standard gap
    scenes.write_manifest(root / f"{stem}.yaml", {
        "title": title, "source": "st", "chat": "a chat", "gap_s": 0.7,
        "total_duration_s": round(offset - 0.7, 2), "entries": entries})


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_scene_goes_to_the_speech_library_with_one_press(tmp_path, monkeypatch):
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
    # Isolate both stores before loading the page. This test imports selected output into the
    # training pool, so a missing patch could write into host data as well as reveal its contents.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")
    pool = tmp_path / "voice_training"
    pool.mkdir()
    monkeypatch.setenv("VOCALIS_TRAINING_DIR", str(pool))

    out = tmp_path / "output"
    import book_to_audio
    import vocalis.web.clips as clips_mod
    import vocalis.web.train as train_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", out)
    # ⚠️ THE THIRD BINDING, and it is the one that makes this feature work at all. `from
    # book_to_audio import OUTPUT_DIR` gives every importer its own copy; `/train/import_scene`
    # reads the one in `vocalis/web/train.py`, so patching the other two leaves the route
    # resolving scenes under the real output/ tree — where it would find nothing and 404, which
    # reads exactly like the button being broken.
    monkeypatch.setattr(train_mod, "OUTPUT_DIR", out)

    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    _seed_scene(root, SOLO, "A lighthouse", SOLO_LINES)
    _seed_scene(root, DUET, "The ferry", DUET_LINES)

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

    assert r.returncode == 0, ("＋ Speech failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    # Docker edition: 22 -> 20, the true count after the five Training-only multi-speaker warning
    # checks were replaced by three (scene listed, sent with no warning, no dialog left open).
    assert_spec_ran(r, SPEC, floor=20)

    # The clip really is on disk, in the temp pool — read from the filesystem rather than from
    # the route the spec already asked, so this is a second opinion and not the same answer twice.
    assert (pool / "A_lighthouse.mp3").exists(), (
        f"the route answered but nothing landed in {pool}: {sorted(p.name for p in pool.iterdir())}")

    # A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("＋ Speech is a real control with a real size",
                  "and it is actually visible on the row",
                  "the speech pool starts empty",
                  "under its NAME, not its stem",
                  "badged as coming from a scene",
                  "the page moves to Voice Studio",
                  "on the Speech sub-tab",
                  "the arriving clip is already listed in the Speech clips",
                  "it was copied, not moved",
                  "ASKS before replacing",
                  "left the pool exactly as it was",
                  "not left spinning",
                  "is sent straight through, with no warning to answer",
                  "and no dialog is left open",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
