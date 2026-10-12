"""Browser coverage for paging and multi-select deletion in the Stems tab song list. The fixture verifies selected rows and deletion results across pages."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

SPEC = Path(__file__).parent / "ss_songs_bulk_browser_spec.mjs"
NODE = shutil.which("node")

#: Thirty uploads — one more than a page and a bit, so page 2 is genuinely populated.
#: ⚠️ THE `aaaaaaNN` TOKEN IS LOAD-BEARING. The spec filters on "aaaaaa0" to isolate Track 01…09,
#: and that works only because after six a's, Track 10/20/30 carry a digit that is not 0. Renaming
#: these to something tidier makes that filter match ten rows and the delete assertions drift by one.
UPLOADS = [f"Track {i:02d}_aaaaaa{i:02d}.mp3" for i in range(1, 31)]
#: One ACE-Step output and one ACE library song: the two rows with NO checkbox. Neither file is
#: this panel's to remove, and the spec proves the box is absent on both.
ACESTEP = "Sample Track Two_b2c3d4e5.mp3"
ACELIB_NAME = "Sample Track Three"
#: The song that already has stems — the `stems stored` badge, and the set that must OUTLIVE it.
WITH_STEMS = UPLOADS[0]


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


def _wav(path: Path, seconds=0.4, sr=24000):
    """A real WAV, for the stem files."""
    import numpy as np
    import soundfile as sf
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    sf.write(str(path), (0.3 * np.sin(2 * np.pi * 220 * t)).astype("float32"), sr, format="WAV")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_stems_song_list_pages_and_deletes_in_bulk(tmp_path, monkeypatch):
    songs = tmp_path / "uploads" / "songs"
    stem_uploads = tmp_path / "uploads" / "stems"
    acestep = tmp_path / "acestep"
    pool = tmp_path / "voice_training"
    out = tmp_path / "output"
    stems_dir = out / "stems"
    for d in (songs, stem_uploads, acestep, pool, stems_dir):
        d.mkdir(parents=True)

    for nm in UPLOADS:
        (songs / nm).write_bytes(b"ID3" + b"\0" * 4000)
    (acestep / ACESTEP).write_bytes(b"ID3" + b"\0" * 4000)

    # 🔴 THE SUITE MUST NOT READ THE HOST, AND THIS ONE DELETES. Unpatched, `acestep_dir` defaults
    # to /ai-output/acestep, which may contain configured song files, and the spec presses Delete
    # selected. A missed binding here does not merely make the counts wrong — it removes configured files.
    monkeypatch.setenv("VOCALIS_SONGS_DIR", str(songs))
    monkeypatch.setenv("VOCALIS_STEM_UPLOADS_DIR", str(stem_uploads))
    monkeypatch.setenv("VOCALIS_ACESTEP_DIR", str(acestep))
    monkeypatch.setenv("VOCALIS_TRAINING_DIR", str(pool))
    monkeypatch.setenv("VOCALIS_APPLIO_DIR", str(tmp_path / "Applio"))
    monkeypatch.setenv("VOCALIS_RVC_DIR", str(tmp_path / "voice_models"))
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(tmp_path / "cache"))

    settings = tmp_path / "app_settings.yaml"
    settings.write_text(yaml.safe_dump({"output_dir": str(out)}), encoding="utf-8")

    import book_to_audio
    import vocalis.runtime.settings as rt_settings
    import vocalis.web.stems as stems_web
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings)
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(stems_web, "OUTPUT_DIR", out, raising=False)
    # 🔴 THE SAME PIN ITS TWO SIBLINGS CARRY (test_vs_sources_bulk_browser.py:123,
    # test_pg_convert_browser.py:114) AND THIS FILE — modeled on the vs one — shipped without.
    # `paths.UI_STATE` is `BASE_DIR / "ui_state.yaml"`, the REPO ROOT, and no env var moves it;
    # the conftest autouse pin cannot save a single-file run either, because its gate reads
    # `sys.modules` at fixture setup and this module imports the app only inside the test body.
    # Unpinned, the spec's Chrome session boots against the live ui_state.yaml a locally-run
    # server keeps real selections in — reading them, writing `vocalis-tab`/`vocalis-vstab` over
    # them, and turning pass-exactly-once the moment this panel persists one more key.
    import vocalis.runtime.paths as rt_paths_pin
    monkeypatch.setattr(rt_paths_pin, "UI_STATE", tmp_path / "ui_state.yaml")

    # ── the ACE library row ─────────────────────────────────────────────────
    # 🔴 BOTH PATHS, or `acelib` writes into the real install root. `_index()`/`_audio_dir()` read
    # `paths.X` at call time, so patching the two constants is enough and nothing else has to move.
    import vocalis.runtime.acelib as acelib
    import vocalis.runtime.paths as rt_paths
    ace_lib_dir = tmp_path / "ace_library"
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", tmp_path / "ace_library.json", raising=False)
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", ace_lib_dir, raising=False)
    ace_song = acelib.save(b"fLaC" + b"\0" * 4000, name=ACELIB_NAME)

    # ── the stem set that must survive its song ─────────────────────────────
    # A folder is a SET when it holds the sidecar; `song_ref` is what `ssSetFor` matches to paint
    # the `stems stored` badge, and it is deliberately the ref — the tie between the two panels.
    import stems as stems_mod
    set_dir = stems_dir / "Track 01_aaaaaa01"
    set_dir.mkdir()
    _wav(set_dir / "vocals.wav")
    _wav(set_dir / "instrumental.wav")
    (set_dir / stems_mod.SIDECAR).write_text(yaml.safe_dump({
        "h": "aaaaaa01" * 4, "source": "demucs", "song": "Track 01_aaaaaa01",
        "song_ref": f"uploads/{WITH_STEMS}", "song_h": "aaaaaa01" * 4,
        "duration_s": 0.4, "created": "2026-08-16T00:00:00",
    }), encoding="utf-8")

    import vocalis.runtime.configs as rt_configs
    import stemsplit
    # 🔴 DOCKER PORT. The Stems routes resolve their config through `configs.ss_cfg()`, which calls
    # `stemsplit.resolve_config` (the legacy page resolved it through `voiceswap.resolve_config`,
    # a path this product's Stems routes no longer take — patching it left the page reading the
    # real, empty stems directory, so no seeded song ever reached the browser). `ss_cfg` also reads
    # `OUTPUT_DIR` from ITS OWN module namespace (`from book_to_audio import OUTPUT_DIR`), a
    # by-value copy that patching `book_to_audio.OUTPUT_DIR` above never reaches, so it is pinned
    # here too — the same port tests/test_stems_bulk_browser.py carries.
    monkeypatch.setattr(rt_configs, "OUTPUT_DIR", out)
    real = stemsplit.resolve_config

    def _cfg(*a, **k):
        c = real(*a, **k)
        c.stems_dir = stems_dir
        c.stem_uploads_dir = stem_uploads
        return c
    monkeypatch.setattr(stemsplit, "resolve_config", _cfg)
    if hasattr(rt_configs, "_SS_CFG"):
        monkeypatch.setattr(rt_configs, "_SS_CFG", None, raising=False)

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

    assert r.returncode == 0, ("the Stems tab's song list failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    # ⚠️ THE FLOOR IS THE UNCONDITIONAL COUNT, NOT THE 65 THIS SPEC EMITTED WHEN MEASURED.
    # 2 of its assertions sit behind a branch, so a slower box or a loaded run can emit
    # fewer and still be entirely correct. A floor pinned to a good run's number would fail
    # intermittently, which would make the guard fail on valid runs and resemble the flakes this
    # work removed. The floor must hold on the WORST run, not the observed one.
    assert_spec_ran(r, SPEC, floor=63)

    # ── the second opinion, off the filesystem ──────────────────────────────
    # The spec deletes by FILTER ("aaaaaa0" → Track 01…09), so unlike the Sources spec the exact
    # nine are known here and can be named rather than merely counted.
    left = sorted(p.name for p in songs.iterdir())
    assert len(left) == 21, (
        f"Delete selected should have taken exactly nine uploads off the disk; {len(left)} of 30 "
        f"remain: {left}")
    for i in range(1, 10):
        assert f"Track {i:02d}_aaaaaa{i:02d}.mp3" not in left, f"Track {i:02d} survived the delete"
    for i in range(10, 31):
        assert f"Track {i:02d}_aaaaaa{i:02d}.mp3" in left, f"Track {i:02d} was deleted and should not be"

    # 🔴 THE TWO FILES THIS PANEL MAY NEVER TOUCH. They have no checkbox precisely because they are
    # not ours; a bulk delete that reached either would be the standing rule broken in the one
    # direction that cannot be undone.
    assert (acestep / ACESTEP).is_file(), (
        "the ACE-Step output was removed by a panel that must never remove one")
    assert (ace_lib_dir / f"{ace_song.id}.flac").is_file(), (
        "the ACE library song was removed by a panel that must not delete it")

    # 🔴 AND THE STEM SET OUTLIVED ITS SONG. This is the confusion the whole feature exists to end:
    # a set is keyed on the song's content hash, not on the song file, so deleting `Track 01`
    # leaves its separation exactly where it was. The confirm dialog says so; this proves it.
    assert (set_dir / "vocals.wav").is_file() and (set_dir / "instrumental.wav").is_file(), (
        f"deleting the song took its stems with it: {sorted(p.name for p in set_dir.iterdir()) if set_dir.is_dir() else 'the set is GONE'}")
    assert (set_dir / stems_mod.SIDECAR).is_file(), "the set lost its sidecar and stops being a set"

    # 🔴 A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("a 32-song list paints TWENTY-FIVE rows",
                  'and says where you are — "Page 1 of 2"',
                  "Previous is disabled on page 1",
                  "the totals line says WHICH twenty-five",
                  "and offers no page-size control",
                  "Next lands on the remaining seven",
                  "Next is disabled at the end",
                  "page 2 shares no row with page 1",
                  "EVERY row carries a checkbox, all thirty-two of them",
                  "the ACE library song is LISTED and HAS a checkbox",
                  "and the same for an ACE-Step output",
                  "the bulk bar is on screen before anything is ticked",
                  "and says how many it would take",
                  "the header box ticks all THIRTY",
                  "and the bar says only 30 of the 32 can be deleted here",
                  "Delete selected is DISABLED, because this panel owns none of what is left",
                  "the header box reads as fully checked",
                  "and ticking it did NOT also choose it as the song to split",
                  "and the header box goes indeterminate",
                  "but the SELECTION still holds it",
                  "and the two ticks it hid are DROPPED",
                  "typing a filter lands on page ONE",
                  "exactly one of them shows the",
                  "Select all under a filter takes the nine it is SHOWING",
                  "and says it goes from this list, without naming a panel the package does not have",
                  "and says the stems SURVIVE",
                  "and the list comes back nine shorter",
                  "but its STEM SET is untouched in Your stems",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
