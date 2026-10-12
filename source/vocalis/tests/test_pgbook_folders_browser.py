"""Browser tests cover folder controls on the Playground library and Books shelf: child rows show selection ticks; ticking does not trigger the row action; move and remove use the same selection; removing a row refreshes the list; and filtering excludes hidden rows from the selection.

The fixture pins every directory into `tmp_path` and asserts those bindings before browser interaction. Modules import copies of path constants, so patching one importer does not rebind the others. This prevents browser tests from touching configured user libraries.

Skipped when Chrome or Node is unavailable."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

from conftest import REPO_ROOT, assert_spec_ran, bound_server

SPEC = Path(__file__).parent / "pgbook_folders_browser_spec.mjs"
NODE = shutil.which("node")

# The refs the spec names, spelled once here. A clip's ref is `<voice dir>/<stem>`, which is what
# `playground_clips.list_clips` builds and what the row carries as `data-vrow` — the same string
# `folderAssign` sends, which is rule 9 of the contract: tick the identity the row already has.
VOICE_DIR = "Test Voice"
CLIPS = [
    ("Sample_Track_01_ab12cd01", "Sample Track 01", "Red birds fly above quiet water."),
    ("Sample_Track_02_ab12cd02", "Sample Track 02", "Blue stones rest beside low grass."),
    ("Sample_Track_03_ab12cd03", "Sample Track 03", "Soft rain falls across empty sand."),
    ("Sample_Track_04_ab12cd04", "Sample Track 04", "Small clouds drift beyond open hills."),
]
# 📌 NO WORD IS SHARED BETWEEN A NAME AND ANY OTHER ROW'S TEXT. `filtRows` matches every typed
# word against `name + voice_label + voice + text`, so a stray word in another clip's text
# would make the filter check assert the wrong thing while still passing.
BOOKS = ["Sample_Book_01", "Sample_Book_02", "Sample_Book_03"]


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
def test_both_libraries_tick_every_row_and_can_take_them_back_out_of_a_folder(tmp_path, monkeypatch):
    out = tmp_path / "output"
    chunks = tmp_path / "chunks"
    for d in (out, out / "playground" / VOICE_DIR, out / "books", chunks, tmp_path / "cache"):
        d.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(tmp_path / "cache"))
    settings = tmp_path / "app_settings.yaml"
    settings.write_text(yaml.safe_dump({"output_dir": str(out)}), encoding="utf-8")

    import book_to_audio
    import enhance
    import folders as folders_store
    import playground_clips
    import vocalis.runtime.paths as paths
    import vocalis.runtime.settings as rt_settings
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings)

    # 🔴 EVERY IMPORTER, NOT JUST THE SOURCE MODULE. `from book_to_audio import OUTPUT_DIR` binds a
    # COPY into each importing module's namespace, so `monkeypatch.setattr(book_to_audio, ...)`
    # rebinds precisely one name and leaves six modules pointed at the developer's real output
    # tree. The list is enumerated rather than recited from memory:
    #     grep -rn "^from book_to_audio import" src/vocalis/ | grep OUTPUT_DIR
    # and `raising=True` (the default) is deliberate — if one of them is renamed or drops the
    # import, this fails at setup instead of quietly un-pinning the suite from the install again.
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    for modname in ("vocalis.web.books", "vocalis.web.clips", "vocalis.web.playground",
                    "vocalis.web.system", "vocalis.web.train", "vocalis.web.voices",
                    "vocalis.runtime.configs"):
        __import__(modname)
        import sys
        monkeypatch.setattr(sys.modules[modname], "OUTPUT_DIR", out)
    from vocalis.web import playground as web_playground
    monkeypatch.setattr(web_playground, "CHUNKS_ROOT", chunks)

    # `paths.FOLDERS` is pinned by conftest's autouse fixture into a private mkdtemp already; it is
    # re-pinned into tmp_path here so the seeding below writes the same file the routes read, and
    # so the assert further down has something to name.
    monkeypatch.setattr(paths, "FOLDERS", tmp_path / "folders.yaml")

    # ── the clips ───────────────────────────────────────────────────────────
    vdir = out / "playground" / VOICE_DIR
    for i, (stem, name, text) in enumerate(CLIPS):
        mp3 = vdir / f"{stem}.mp3"
        mp3.write_bytes(b"ID3" + b"\0" * 2048)
        os.utime(mp3, (1_754_500_000 + i, 1_754_500_000 + i))
        size, mtime = enhance.source_stat(mp3)
        # The bandwidth measurement is PRE-CACHED, so `list_clips` touches no audio. Left cold it
        # would shell out to ffprobe/ffmpeg once per clip on fake bytes — slow, noisy in the log,
        # and entirely beside the point of a folder test.
        playground_clips.write_clip_yaml(vdir / f"{stem}.yaml", {
            "voice": "Test Voice.wav", "exaggeration": 0.5, "cfg": 0.5, "temperature": 0.8,
            "name": name, "text": text, "duration_s": 2.0,
            "bandwidth_hz": 12000, "bandwidth_size": size, "bandwidth_mtime": mtime})

    # ── the books ───────────────────────────────────────────────────────────
    # A folder under output/books with any chapter audio in it IS a book to `scan_library`; no
    # sidecar is needed and none is written, so this seeds the "imported" shape a real shelf has.
    for i, b in enumerate(BOOKS):
        chap = out / "books" / b / "mp3"
        chap.mkdir(parents=True)
        (chap / "Chapter_01.mp3").write_bytes(b"ID3" + b"\0" * 512)
        # Space timestamps well apart because `scan_library` uses the newest mtime under each
        # book, including the `mp3` directory. Book 01 is oldest, Book 03 is middle, and Book 02
        # is newest, so ascending date order differs from the title order.
        stamp = 1_700_000_000 + (0, 2, 1)[i] * 86_400
        os.utime(chap / "Chapter_01.mp3", (stamp, stamp))
        os.utime(chap, (stamp, stamp))

    # ── one folder in each scope, so the spec has a destination to press ────
    folders_store.create(tmp_path, "playground_clips", "Sample Folder")
    folders_store.create(tmp_path, "books", "Sample Folder")

    # 🔴 A SECOND OPINION, OFF THE FILESYSTEM, BEFORE A SINGLE CLICK. Each binding above is one
    # line, and this is what makes a future edit that drops one fail HERE instead of quietly
    # filing unrelated clips into a folder the fixture never created.
    import sys as _sys
    assert paths.FOLDERS.parent == tmp_path, f"folders.yaml is not pinned into tmp_path: {paths.FOLDERS}"
    assert folders_store.listing(tmp_path, "books")["folders"], "the seeded folder did not land in tmp_path"
    for modname in ("vocalis.web.books", "vocalis.web.playground", "vocalis.web.clips",
                    "vocalis.web.system", "vocalis.web.train", "vocalis.web.voices",
                    "vocalis.runtime.configs"):
        got = _sys.modules[modname].OUTPUT_DIR
        assert Path(got) == out, f"{modname}.OUTPUT_DIR is not pinned into tmp_path - this test would write to the real install: {got}"
    assert Path(book_to_audio.OUTPUT_DIR) == out
    assert Path(web_playground.CHUNKS_ROOT) == chunks

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
                           errors="replace", timeout=240)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, ("the folder tick column failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    # 9.5.7: 50 -> 53, the three checks the Book shelf's new order control brought with it.
    # MEASURED the way the docstring says — floor=9999 once, read "made only 53 assertions".
    assert_spec_ran(r, SPEC, floor=53)

    # 🔴 A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("PG: the library shows all four clips, each with a tick",
                  "PG: ✚ Folder, ⇤ Remove from folder and the refresh beside them sit on ONE line",
                  "BOOKS: ✚ Folder, ⇤ Remove from folder and the refresh beside them sit on ONE line",
                  "PG: the folder buttons and the refresh stay INSIDE a 900px panel",
                  "PG: the toolbar is still ONE row tall at 900px",
                  "a click in the tick cell's corner does NOT rewrite the editor",
                  "BOOKS: the folder buttons and the refresh stay INSIDE a 900px panel",
                  "BOOKS: the toolbar is still ONE row tall at 900px",
                  "PG: the ⇤ Remove from folder button is on the toolbar",
                  "PG: ticking a row does not load the clip",
                  "PG: the tick set is the one the panel reads",
                  "PG: ⇥ Move selected here files the ticked clips",
                  "PG: and they left the root",
                  "PG: the move cleared the ticks",
                  "PG: select-all cannot reach the rows a closed folder is hiding",
                  "PG: opening the folder brings its clips back on screen",
                  "PG: every row INSIDE the open folder carries a tick",
                  "PG: ticking a row inside the open folder registers",
                  "PG: ⇤ Remove from folder takes them back out to the root",
                  "PG: and all four clips are below the divider again",
                  "PG: the un-file cleared the ticks too",
                  "PG: a filter drops the ticks it hides",
                  "PG: and the tick is GONE, not merely hidden",
                  "BOOKS: the shelf shows all three books, each with a tick",
                  "BOOKS: the ⇤ Remove from folder button is on the toolbar",
                  "BOOKS: ticking a card does not open the book",
                  "BOOKS: ⇥ Move selected here files the ticked books",
                  "BOOKS: and they left the shelf root",
                  "BOOKS: the move cleared the ticks",
                  "BOOKS: opening the folder brings its books back on screen",
                  "BOOKS: every card INSIDE the open folder carries a tick",
                  "BOOKS: ticking a card inside the open folder registers",
                  "BOOKS: ⇤ Remove from folder takes them back out to the root",
                  "BOOKS: and all three books are below the divider again",
                  "BOOKS: the un-file cleared the ticks too",
                  "BOOKS: a filter drops the ticks it hides",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
