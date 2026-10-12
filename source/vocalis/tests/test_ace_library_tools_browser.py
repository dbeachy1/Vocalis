"""Exercise ACE library filtering, sorting, pagination, and bulk delete in a real browser. Filtering and sorting are client-side, and selection must cover all filtered rows across pages while excluding rows hidden by the filter. Wait through reconciliation cycles to detect state loss and verify the order of multiple data-keep children. Pin every touched directory to tmp_path and assert isolation before interaction because the spec deletes saved songs. Skip when Chrome or Node is unavailable."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

# 📌 `bound_server` alone: importing the module is what gives conftest's `sys.path` side effect,
# so there is no unused name to suppress.
from conftest import assert_spec_ran, bound_server

import vault
import vault_store
import vocalis.runtime.paths as rt_paths

SPEC = Path(__file__).parent / "ace_library_tools_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: Enough of a FLAC header that the store and the browser both treat it as audio. The rows carry
#: real `<audio>` elements pointed at these bytes; nothing here plays them.
FLAC_ISH = b"fLaC" + b"\0" * 512


def _chrome():
    for p in (os.environ.get("CHROME_PATH"),
              r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              shutil.which("chrome"), shutil.which("google-chrome"),
              shutil.which("chromium")):
        if p and Path(p).exists():
            return str(p)
    return None


@pytest.mark.timeout(300)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_ace_library_filters_sorts_pages_and_bulk_deletes_in_a_real_browser(tmp_path, monkeypatch):
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
    # 🔴 `ACE_LIBRARY` AND `ACE_LIBRARY_AUDIO` ARE THE TWO THIS TEST EXISTS AROUND: it presses
    # 🗑 Delete selected twice, and `acelib.delete` removes the index row AND unlinks the audio.
    # `UI_STATE` is written too — the chosen order lives there, and the spec reloads the page to
    # prove it survives.
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

    # ── the fixture: 30 songs, and every one of the four features needs a different thing ────
    #
    #   PAGING  — 30 against a page of 25 is the smallest fixture with a second page that is not
    #             also the first. A 26th song would page; five on page 2 also proves the page-2
    #             COUNT rather than merely its existence.
    #   ORDER   — "AAA Sample Track" and "ZZZ Sample Track" bracket the alphabet, and they are saved
    #             FIRST and LAST so that A–Z and Oldest-first give the same head while Z–A and
    #             Newest-first give the other. Four orders, two observable heads, no ambiguity.
    #   FILTER  — "ZZZ Sample Track" is unique; "one sample" matches "Sample Track One" only as two words in
    #             the wrong order, which is what proves the shared matcher rather than a substring.
    #   DELETE  — "Track 1" prefixes a knowable handful (1, 10-19) for the bulk press.
    #
    # ⚠️ NO LYRICS AND NO CAPTION on any of them. Clicking a row fires `ace:loadsong` into the form
    # above, and a form holding unsaved words puts a confirm in front of the next action — a modal
    # this spec would then be blocked behind for reasons that are not the bug.
    from vocalis.runtime import acelib
    acelib.save(FLAC_ISH, name="AAA Sample Track", model="acestep-v15-turbo", seed=1)
    acelib.save(FLAC_ISH, name="Sample Track One", model="acestep-v15-turbo", seed=2)
    for i in range(1, 28):
        acelib.save(FLAC_ISH, name=f"Track {i}", model="acestep-v15-turbo", seed=100 + i)
    acelib.save(FLAC_ISH, name="ZZZ Sample Track", model="acestep-v15-turbo", seed=999)

    # Verify each touched path resolves under tmp_path before the first browser action, so a missing fixture pin fails before any library file is read or changed.
    for name in ("FOLDERS", "UI_STATE", "ACE_TEMPLATES", "ACE_CANDIDATES",
                 "ACE_LIBRARY", "ACE_LIBRARY_AUDIO"):
        p = Path(getattr(rt_paths, name)).resolve()
        assert tmp_path.resolve() in p.parents, (
            f"paths.{name} is not pinned into tmp_path - this test DELETES SONGS and would reach "
            f"the real install: {p}")
    # …and that the ROUTES read the very module object those pins were applied to.
    from vocalis.web import acestep as web_ace
    assert web_ace.paths is rt_paths, (
        "vocalis.web.acestep is holding its own copy of the install paths - the pins above no "
        "longer reach the code under test")
    assert len(acelib.list_songs()) == 30, "the fixture's 30 songs are not in the store the route reads"

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=280)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, ("the ACE library's filter/order/pager/bulk-delete failed in a real "
                               f"browser:\n{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES BELOW, BECAUSE THEY CATCH DIFFERENT THINGS. The name list
    # catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls.
    # ⚠️ THE SPEC'S OWN UNCONDITIONAL `ok(` COUNT, MEASURED. It was 30 first — a number well under
    # the real one, which is the shape `assert_spec_ran`'s docstring calls out: a floor that far
    # below the count cannot see a block stop executing, while still reading like a guard.
    assert_spec_ran(r, SPEC, floor=46)

    # 🔴 A SPEC THAT SILENTLY STOPPED CHECKING EXITS 0 AS HAPPILY AS ONE THAT PASSED.
    for named in ("the library paints ONE page of 25, not all 30 songs",
                  "🗑 Delete selected are all on the bar",
                  "the filter bar sits UNDER the Library heading",
                  "the pager says which page you are on",
                  "Next ▸ paints the remaining 5 songs",
                  "and two full poll cycles later you are STILL on page 2",
                  "typing in the filter box narrows the list to the one match",
                  "the pager disappears when the filter leaves one page",
                  "the count describes what is ON SCREEN",
                  "two words in either order find the song a substring never would",
                  'and it says "Nothing matches" quoting the query',
                  "the heading and the bar keep their order over an empty list",
                  "clearing the box brings the whole library back",
                  "Newest first puts the last-saved song at the top",
                  "Name A–Z puts the alphabetically first song at the top",
                  "and the whole page really is in order",
                  "Name Z–A flips it",
                  "Oldest first reads the save time the other way",
                  "the order picker still SHOWS the order it was left on",
                  "All ticks every one of the 30 songs",
                  "and all 30 are still selected two poll cycles later",
                  "pressing All again clears the selection",
                  "filtering to one song drops the other 29 ticks",
                  "nothing is covering it",
                  "it asks before deleting anything",
                  "and the confirm names the song it is about to delete",
                  "30 songs became 29",
                  "the selection is spent afterward",
                  "in ONE press",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

    # 🔴 AND THE DELETES LANDED IN THE TEMP INSTALL. The browser said the server had removed them;
    # this is where that claim is checked against a filesystem the test owns.
    left = acelib.list_songs()
    assert len(left) < 30, "the bulk delete reported success and the store still holds 30 songs"
    assert not any("ZZZ Sample Track" in s.name for s in left), "the song the spec deleted is still in the store"
