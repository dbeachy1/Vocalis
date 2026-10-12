"""The folder controls on the voice-side lists support both filing and removal. Browser coverage
checks the remove gesture, verifies that tick state survives repaint, and catches missing module-
scope wiring that leaves a button visible but ineffective.

This test writes folder data in two scopes (the Docker edition has no training or RVC panels), so each install path and store is redirected to
`tmp_path` and checked before Chrome starts. It skips when Node or Chrome is unavailable."""
import importlib
import os
import shutil
import socket
import struct
import subprocess
import threading
import wave
from pathlib import Path

import pytest
import yaml

# 📌 BOTH NAMES ARE CALLED, SO THERE IS NOTHING TO SUPPRESS. The neighboring browser drivers
# import `REPO_ROOT` purely for conftest's `sys.path` side effect and carry a lint-ignore for the
# unused name; this file asserts against the repo root as well as serving from it, so the import
# earns itself and the ignore that came with the template came out. `test_webui_types.py` prices
# those markers tree-wide, and one copied in from a template costs the same as one that was needed.
# ⚠️ IT CANNOT EVEN BE NAMED IN A COMMENT: that ratchet counts the tree's TEXT, so spelling the
# marker out here would itself be an occurrence. Its own constant records four additions caught
# exactly that way — this line was very nearly the fifth.
from conftest import REPO_ROOT, assert_spec_ran, bound_server

import vocalis.runtime.paths as rt_paths
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "voices_folders_browser_spec.mjs"
NODE = shutil.which("node")

#: One token — "zephyr" — is the spec's filter query for all three lists, and it must match
#: exactly one row in each. The TTS list searches `label + filename`, the clip picker searches the
#: clip's STEM (not its ref) and the registry searches `name + training`, so the names share no
#: substring: a query that matched two rows would make the hidden-tick assertions vacuous.
#: ⚠️ Keep in step with LISTS at the top of `voices_folders_browser_spec.mjs`.
VOICES = ["Zephyr.wav", "Marlow.wav", "Petrichor.wav"]
CLIPS = ["Zephyr_clip.mp3", "Marlow_clip.mp3", "Petrichor_clip.mp3"]
# (the RVC `voice_models` fixture that fed Voice Training ▸ Trained voices went with that surface)

#: Every module that did `from book_to_audio import OUTPUT_DIR` and therefore holds its OWN copy.
OUTPUT_DIR_HOLDERS = ("book_to_audio", "vocalis.runtime.configs", "vocalis.web.clips",
                      "vocalis.web.playground", "vocalis.web.system", "vocalis.web.train",
                      "vocalis.web.voices", "vocalis_server")


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


def _silence(p: Path) -> None:
    """A real, tiny WAV. `/voices` lists files rather than decoding them, but a fixture that is
    not actually audio is one route change away from being the reason a spec fails."""
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(struct.pack("<800h", *([0] * 800)))


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_every_voice_list_can_file_a_row_and_take_it_back_out(tmp_path, monkeypatch):
    samples = tmp_path / "voice_samples"
    pool = tmp_path / "voice_training"
    out = tmp_path / "output"
    cache = tmp_path / "cache"
    for d in (samples, pool, out, cache):
        d.mkdir(parents=True)

    for nm in VOICES:
        _silence(samples / nm)
    for nm in CLIPS:
        # Placeholder bytes are the honest fixture: nothing here plays or measures audio, and the
        # listing degrades to "no duration" rather than failing. `clips_train_browser_spec` drives
        # the same pool the same way.
        (pool / nm).write_bytes(b"ID3" + b"\0" * 2048)

    # 🔴 THE INSTALL-ROOT PINS. conftest points these at a throwaway root already; they are pinned
    # again HERE, at tmp_path, so the assertions below can prove it from the one directory this
    # test owns. FOLDERS is the one that matters most: `folders.for_rows` and every /folders route
    # resolve the store as `paths.FOLDERS.parent`, so an unpinned FOLDERS writes three scopes of
    # test folders into the developer's own Vocalis, where nothing prunes them.
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", samples)
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(rt_paths, "FOLDERS", tmp_path / "folders.yaml")
    monkeypatch.setattr(rt_paths, "UI_STATE", tmp_path / "ui_state.yaml")

    settings = tmp_path / "app_settings.yaml"
    settings.write_text(yaml.safe_dump({"output_dir": str(out)}), encoding="utf-8")
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings)

    monkeypatch.setenv("VOCALIS_TRAINING_DIR", str(pool))
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(tmp_path / "scratch"))

    # 🔴 EVERY BINDING OF OUTPUT_DIR, NOT ONE. `from book_to_audio import OUTPUT_DIR` is a COPY per
    # importer, so patching the source module rebinds nothing in the seven others — and the first
    # run of `test_vs_buttons_browser` wrote a real job into the legacy checkout's output folder for exactly
    # this reason. The tab this spec drives reads the render tree at boot (Clips, the Playground
    # library); it writes nothing there, but "it only reads it" is a claim about today's code.
    for mod_name in OUTPUT_DIR_HOLDERS:
        mod = importlib.import_module(mod_name)
        if hasattr(mod, "OUTPUT_DIR"):
            monkeypatch.setattr(mod, "OUTPUT_DIR", out)

    import vocalis_server as vs
    from vocalis.runtime import configs as rt_configs

    # 🔴 A SECOND OPINION, OFF THE RESOLVED CONFIG, BEFORE THE BROWSER IS EVEN STARTED. The pins
    # above are one line each; this is what makes an edit that drops one fail HERE, by name,
    # instead of writing outside the isolated test directories.
    real = Path(REPO_ROOT)
    pinned = {
        "paths.VOICE_SAMPLES": Path(rt_paths.VOICE_SAMPLES),
        "paths.FOLDERS": Path(rt_paths.FOLDERS),
        "paths.VOICE_SETTINGS": Path(rt_paths.VOICE_SETTINGS),
        "paths.UI_STATE": Path(rt_paths.UI_STATE),
        "settings.APP_SETTINGS": Path(rt_settings.APP_SETTINGS),
        "speech_cfg().training_dir": Path(rt_configs.speech_cfg().training_dir),
    }
    for mod_name in OUTPUT_DIR_HOLDERS:
        mod = importlib.import_module(mod_name)
        if hasattr(mod, "OUTPUT_DIR"):
            pinned[f"{mod_name}.OUTPUT_DIR"] = Path(mod.OUTPUT_DIR)
    for what, p in pinned.items():
        assert tmp_path in p.parents or p == tmp_path, (
            f"{what} is not inside tmp_path - this test would write to the real install: {p}")
        assert real not in p.parents and p != real, (
            f"{what} resolves inside the repo itself: {p}")

    vs.app.config["TESTING"] = False

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)          # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, ("the voice lists' folder controls failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 AN EXPLICIT, MEASURED floor=. conftest's derivation lands under its meaningful
    # threshold on this spec and REFUSES rather than installing a check that asserts nothing.
    # The number below was measured - floor set absurdly high once, true count read off the
    # failure message - never derived and never guessed: a floor under the true count reads as a
    # guard while permitting exactly the drift it exists to catch.
    # Docker edition: 114 with four lists; re-measured at 64 for the two that remain (Uploaded voices
    # and Speech clips) plus the delete block, by reading the true count off the failure message.
    assert_spec_ran(r, SPEC, floor=64)

    # 🔴 A SPEC THAT SILENTLY STOPPED CHECKING EXITS 0 AS HAPPILY AS ONE THAT PASSED — and this
    # one loops over three lists, so a `continue` that skipped a whole panel would still be green.
    # Naming every check PER SCOPE is what makes that a failure instead of a shorter run.
    # 🔴 KEYED ON THE PANEL, NOT THE SCOPE, SINCE 9.0.6 — and the difference is a hole this census
    # would otherwise have. Two panels now render `train_sources` (Voice Training's picker and the
    # Speech clip library), so a scope-keyed census is satisfied by EITHER of them: one could be
    # skipped entirely and every string below would still be found. `what` is unique per entry.
    for scope in ("Voices ▸ Uploaded voices", "Voice Studio ▸ Speech clips"):
        for named in (f"{scope}: the list renders the three fixture rows",
                      f"{scope}: ✚ Folder is on the toolbar with a real size",
                      f"{scope}: ⇤ Remove from folder exists",
                      f"{scope}: and it is a real control, not a zero-sized one",
                      f"{scope}: the folder is created server-side",
                      f"{scope}: ↻ Refresh brings the folder row into the list",
                      f"{scope}: every row carries a tick box",
                      f"{scope}: clicking the box ticks the row",
                      f"{scope}: the set holds BOTH rows",
                      f"{scope}: filtering to",
                      f"{scope}: the row the filter KEPT on screen is still ticked",
                      f"{scope}: ⇥ Move selected here reaches the SERVER",
                      f"{scope}: and ONLY it",
                      f"{scope}: the folder row itself counts the filing",
                      f"{scope}: the folder opens and the filed row is painted inside it",
                      f"{scope}: the row INSIDE the open folder carries a tick",
                      f"{scope}: ⇤ Remove from folder takes it back OUT",
                      f"{scope}: and the row is painted back at the ROOT",
                      f"{scope}: and the folder's OWN COUNT goes back to (0)"):
            assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

    # The three panels do NOT answer the tick questions the same way, and a spec that quietly
    # stopped making the distinction would be the easiest thing in this file to lose.
    for named in ("Voices ▸ Uploaded voices: ticking a voice does not open its player",
                  # 🔴 9.0.6 — the Speech list's own answer, and it is the one with teeth: this
                  # panel carries an INLINE RENAME EDITOR, so a tick that re-rendered would
                  # destroy a name being typed in a different row.
                  "Voice Studio ▸ Speech clips: ticking a clip opens no rename box",
                  "Voices ▸ Uploaded voices: the tick the filter hid was DROPPED",
                  "Voice Studio ▸ Speech clips: the tick the filter hid was DROPPED",
                  # 9.7.2 — 🗑 Delete selected, the verb the tick set never had. Registered here
                  # for the reason the whole roster exists: a spec that quietly stopped running
                  # these would exit 0 just as happily as one that ran them.
                  "Voices ▸ Uploaded voices: a row can be ticked for deletion",
                  "Voices ▸ Uploaded voices: 🗑 Delete selected arms once rows are ticked",
                  "Voices ▸ Uploaded voices: …and it says how many it is about to delete",
                  "Voices ▸ Uploaded voices: pressing it asks before deleting anything",
                  "🔴 Voices ▸ Uploaded voices: both ticked voices are deleted ON THE SERVER",
                  "Voices ▸ Uploaded voices: and the list repaints without them",
                  "Voices ▸ Uploaded voices: and the button disarms, because the selection is gone",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
