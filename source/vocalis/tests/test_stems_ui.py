"""The Stems tab's UI, driven through Node (4.0 M4, §7).

index.html has no build step: a syntax error in its inline script kills the whole web
UI at parse time, and nothing else in this suite would notice — every Python test here
talks to the routes, not the page. So the real script block gets PARSED on every run,
and the stem widget's render helpers get exercised against the real file.

The interesting assertion is the one §7h forces: anything that repaints is built once
and updated in place, so a pill click must re-point the existing player rather than
re-render the row (a rebuilt <audio> restarts from zero). See stems_widget_smoke.mjs.

Skips when node isn't installed — same contract as test_st_extension_smoke.py.
"""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran

NODE = shutil.which("node")
INDEX = REPO_ROOT / "src" / "webui" / "index.html"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_stems_widget_and_ui_script():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "stems_widget_smoke.mjs"), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"node smoke failed:\n{r.stdout}\n{r.stderr}"

    # The exit code alone cannot distinguish success from an early return; assert the spec ran
    # through its complete set of checks.
    # 34, not 33: the Docker port split the legacy "inline blocks loaded" check into two (the
    # pre-paint block is non-empty; the module tree clears a size floor). Measured, not guessed.
    assert_spec_ran(r, Path(__file__).parent / "stems_widget_smoke.mjs", floor=34)


# ── 8.6.1: the split queue is ONE control, and it survives a reload ───────────

# 🔴 DOCKER TREE: THE STEMS TAB'S BROWSER CODE LIVES IN `stems.js`. The legacy app kept it in
# `js/media/voiceswap.js` next to Voice Swap; Voice Swap execution is not part of this product, so
# that file does not exist here and every source-level check below read a missing file. Every
# anchor below is the same CLAIM it always was, pointed at its new owner.
STEMS_JS = REPO_ROOT / "src" / "webui" / "js" / "media" / "stems.js"


def test_the_split_queue_is_restored_and_not_only_saved():
    """The queue must load persisted state during page initialization. Saving without restoring would replace the stored queue with an empty list after reload."""
    src = STEMS_JS.read_text(encoding="utf-8")
    assert "function ssQueueLoad(" in src, "the restore helper is gone"
    calls = [ln.strip() for ln in src.splitlines()
             if "ssQueueLoad()" in ln and not ln.strip().startswith("function")]
    assert calls, ("ssQueueLoad() is defined but never called — the split queue is saved and "
                   "never restored, so a reload silently empties it")
    assert any("ss.queue = ssQueueLoad()" in c for c in calls), (
        f"ssQueueLoad() is called but its result is not assigned to ss.queue: {calls}")


def test_there_is_exactly_one_go_button_for_the_split_queue():
    """The Songs and Stems panels share one split action. Two competing controls make it unclear which selection will be processed."""
    src = STEMS_JS.read_text(encoding="utf-8")
    # 🔴 9.0-m0: page_markup(), and here it is LOAD-BEARING RATHER THAN COSMETIC. The assertion
    # below is NEGATIVE, so reading the 198-line shell does not fail - it passes VACUOUSLY,
    # for ever, whatever the Stems panel actually contains. A green test that cannot go red is
    # worse than a red one. The extraction did not break this check; it silently disarmed it.
    from conftest import page_markup
    html = page_markup()
    assert 'id="ssQueueGo"' not in html, "the second go button is back in the markup"
    assert "$('ssQueueGo')" not in src, "the second go button is back in the wiring"
    # ⚠️ `\)?` ADMITS THE m10 CAST AND NOTHING ELSE. `$()` became honestly nullable, so this
    # reads `/** @type {VEl} */ ($('ssSplit')).onclick` now. Still pinned: THAT button's onclick.
    assert re.search(r"\$\('ssSplit'\)\)?\.onclick", src) and "ssQueueRun()" in src, (
        "the green Split button must run the queue")


def test_ticked_songs_can_be_put_into_the_split_queue():
    """When multiple songs are selected, the UI must offer an action that adds each selected song to the split queue."""
    src = STEMS_JS.read_text(encoding="utf-8")
    assert "ssSrcBulkQueue" in src
    assert re.search(r"\$\('ssSrcBulkQueue'\)\)?\.onclick", src), (
        "the bulk queue button is rendered but not wired")


def test_the_stems_library_is_reconciled_not_repainted():
    """Refreshing the library must reconcile rows in place. Replacing the full list would discard playback state and close expanded rows. The browser smoke checks the identity property that reconciliation depends on; this source-level test also guards against restoring `innerHTML` in the renderer."""
    src = STEMS_JS.read_text(encoding="utf-8")
    body = src[src.index("export function ssRenderLib"):]
    body = body[:body.index("\n}\n")]
    assert "reconcile(" in body, "ssRenderLib no longer reconciles"
    # 🔴 THE ONE ASSERTION IN THIS FILE m10 COULD HAVE MADE VACUOUS, AND IT IS A NEGATIVE ONE.
    # `$()` is nullable now, so a repaint would be written `/** @type {VEl} */ ($('ssLib')).innerHTML`
    # — which does NOT contain the old substring, because the cast's `))` splits it. The guard would
    # have gone green over exactly the regression it exists to catch. A POSITIVE pin that stops
    # matching goes red and gets fixed; a negative one just stops being able to fail.
    #
    # ⚠️ `$('ssQueueGo')` a few tests up is NOT affected — a cast keeps that substring intact — which
    # is why this needed checking one assertion at a time rather than assumed either way.
    assert not re.search(r"\$\('ssLib'\)\)?\.innerHTML", body), (
        "ssRenderLib assigns innerHTML again — that throws away a playing <audio> and slams the "
        "open row shut every time the library refreshes")


def _anchor(text, pattern):
    """Index of `pattern` in `text`, raising like `str.index` when it is not there.

    🔴 THE POINT IS THAT IT STILL BITES. A regex anchor is only safe if a miss is still a hard
    failure - widening one of these to `.*` to get green would make every assertion downstream
    vacuous, which is the exact trap 8.3's landmine 1 is about.
    """
    # ⚠️ NO `re.S`. Both call sites anchor on a SINGLE source line, and DOTALL let a lazy
    # wildcard run across newlines to find its tail somewhere else entirely - so a future edit that
    # moved either half would silently anchor on a different handler rather than raise. Keeping `.`
    # newline-bounded means a miss stays a miss, which is the only property this helper has.
    m = re.search(pattern, text)
    assert m, f"anchor {pattern!r} no longer matches stems.js - re-point it on its CLAIM"
    return m.start()


def test_clicking_a_song_row_previews_it_and_does_not_queue_it():
    """Clicking a row opens its preview; adding work to the queue remains an explicit button action. The assertion inspects only the row-click branch because the button branch is supposed to enqueue."""
    src = STEMS_JS.read_text(encoding="utf-8")
    # 🔴 SLICE THE STEMS PICKER'S HANDLER, NOT THE VOICE SWAP ONE. Both tabs render `.vsrow`
    # rows and both close over `const row = e.target.closest('.vsrow')`, so anchoring on that
    # string alone lands in `vsPicker` — where these assertions are meaningless and one of them
    # is false. `data-ssqadd` exists only in the stems picker, which is why it is the anchor.
    # ⚠️ ANCHORED BY REGEX, NOT BY EXACT BYTES, SINCE 8.8-m6. Deleting the global `EventTarget`
    # widening made `e.target` honestly `EventTarget | null`, so both anchors below now carry a
    # JSDoc cast (`const qa = /** @type {HTMLElement} */ (e.target).dataset.ssqadd;`). The CLAIM
    # is unchanged - these still pin the stems picker's `ssqadd` read and its `.vsrow` row-click
    # branch, and `_anchor` still raises if either disappears.
    stems_handler = src[_anchor(src, r"const qa = [^\n]*?e\.target\)?\.dataset\.ssqadd;"):]
    stems_handler = stems_handler[:stems_handler.index("});")]
    # …and then only the ROW-CLICK branch of it. The button branch above legitimately queues —
    # that is the whole point of the button — so asserting over the whole handler would be
    # asserting the opposite of what was asked for.
    handler = stems_handler[_anchor(stems_handler,
                                    r"const row = [^\n]*?e\.target\)?\.closest\('\.vsrow'\)"):]
    assert "ssQueuePush" not in handler, "clicking a song row queues it again"
    assert "srcOpen" in handler, "clicking a song row no longer toggles its player"
    assert "data-ssqadd" in src, "the explicit per-row queue button is gone"


def test_every_browser_spec_waits_for_chrome_before_deleting_its_profile():
    """Each browser spec must wait for Chrome to exit before removing its profile. The checker covers both the primary profile and any secondary fixture directories, and rejects swallowed delete failures."""
    specs = sorted(p for p in (REPO_ROOT / "tests").glob("*.mjs")
                   if "rm(profile" in p.read_text(encoding="utf-8"))
    # 🔴 AND THE FIXTURE DIRS, WHICH ARE THE HALF THAT GOT MISSED. Three specs mkdtemp a
    # SECOND directory beside the Chrome profile — a fake user data dir, a copy of the extension
    # — and none of them ever removed it: 12-27 MB each, every run. The profile is the one people
    # think of, so it is the one that gets a cleanup; this asserts the other one does too.
    for name, var in (("clips_favorites_browser_spec.mjs", "userDir"),
                      ("clips_train_browser_spec.mjs", "userDir"),
                      ("st_player_smoke.mjs", "tmp")):
        src = (REPO_ROOT / "tests" / name).read_text(encoding="utf-8")
        assert f"rmSync({var}," in src, (
            f"{name} mkdtemps `{var}` and never removes it - that directory is left in the OS "
            f"temp dir on every single suite run")
        # ...and the two that spawn Chrome have to WAIT for it, exactly like the thirty above.
        # The first attempt at this fix put a sync delete straight after `kill()`, which is the
        # very race that caused the leak - it left the same directories behind, and the suite's
        # own "[temp] N left" line is what said so.
        if "spawn" in src and name != "st_player_smoke.mjs":
            assert "chrome.once('exit'" in src, (
                f"{name} deletes `{var}` without waiting for Chrome to exit, so the delete fails "
                f"on Windows and the profile survives")
    assert specs, "no browser spec creates a Chrome profile any more - has the harness moved?"
    bad = []
    for p in specs:
        src = p.read_text(encoding="utf-8")
        waits = "chrome.once('exit'" in src or 'chrome.once("exit"' in src
        swallowed = "rm(profile, { recursive: true, force: true }).catch(" in src
        if not waits or swallowed:
            bad.append(f"{p.name}{'' if waits else ' (never waits for exit)'}"
                       f"{' (swallows the delete failure)' if swallowed else ''}")
    assert not bad, (
        "these browser specs delete their Chrome profile without waiting for Chrome to exit, so "
        "the delete fails on Windows and the ~78 MB profile is left in the OS temp dir:\n  "
        + "\n  ".join(bad))


def test_every_browser_spec_mutes_its_chrome():
    """Browser specs must mute their audio output so running the suite cannot play audio through the workstation speakers."""
    unmuted = []
    for f in sorted((REPO_ROOT / "tests").glob("*.mjs")):
        b = f.read_bytes()
        if b"--headless" in b and b"--mute-audio" not in b:
            unmuted.append(f.name)
    assert not unmuted, (
        "these browser specs launch Chrome without --mute-audio, so they play audio out of "
        f"whatever machine runs the suite: {unmuted}")


def test_a_lead_set_is_not_told_it_has_no_vocal():
    """A lead-only set has vocals but no instrumental, so the UI must describe the missing instrumental rather than claim the set has no vocal."""
    # 🔴 DOCKER PORT. The legacy assertion pinned `ssWhyNotSwappable`, the Voice Swap picker's
    # "why can't I swap this set" reason. That function (and the swappable picker it fed) is the
    # excluded Voice Swap surface and is not in this tree. The CLAIM, though, is retained Stems
    # behavior: a lead-only set (vocals, no instrumental) must be described by what it LACKS, not
    # mislabeled "no vocal". In this product that sentence is written by the Split note inside
    # `ssRenderTray`, so the same three pins are re-pointed there.
    src = STEMS_JS.read_text(encoding="utf-8")
    assert "function ssRenderTray" in src, "the tray/Split-note renderer is gone"
    body = src[src.index("function ssRenderTray"):]
    body = body[:body.index("\n}\n")]
    assert "ssHasLead(cur)" in body, "a lead set is not distinguished from a set with no vocal"
    assert "no instrumental" in body, "the instrumental-missing case is not named"
    assert "no vocal" not in body, "the Split note calls a lead set vocal-less again"
    # …and the old blanket string is gone from the renderer.
    assert "flag\">no vocal — not swappable</span>'" not in src, (
        "the blanket 'no vocal' label is still rendered somewhere")


# ── 8.6.6: Songs and Your stems are ONE card behind two pills ──────────────────


def test_the_two_stems_views_are_one_card_and_the_switch_is_wired():
    """The Songs and Stems views share one card, with a switch that changes which list is visible."""
    from conftest import page_markup  # 9.0-m0: the Stems panel is a partial now
    html = page_markup()
    src = STEMS_JS.read_text(encoding="utf-8")
    views = set(re.findall(r'data-ssview="([a-z]+)"', html))
    panels = set(re.findall(r'data-ssviewpanel="([a-z]+)"', html))
    assert views == {"songs", "lib"}, f"expected the two view pills, found {views}"
    assert panels == views, f"pills are {views} but the panels are {panels} - a click shows nothing"
    for ident in ("ssSongsTools", "ssLibTools", "ssPickerTotals", "ssLibTotals"):
        assert f'id="{ident}"' in html, f"{ident} is not in the page"
        assert ident in src, f"{ident} is in the page but ssSetView never touches it"
    assert "export function ssSetView(" in src, "the switch is gone"
    calls = [ln.strip() for ln in src.splitlines()
             if "ssSetView(" in ln and "function ssSetView" not in ln]
    assert any("onclick" in c for c in calls), (
        "ssSetView is defined but no pill is wired to it - the buttons would do nothing")
    assert any("SS_VIEW_KEY" in c for c in calls), (
        "ssSetView is never called at boot from the stored key, so the page always opens on "
        "Songs and the saved choice is write-only")


def test_switching_views_hides_rather_than_rebuilds():
    """Switching views must hide the inactive list instead of rebuilding it, preserving its row and player state."""
    src = STEMS_JS.read_text(encoding="utf-8")
    body = src[src.index("export function ssSetView("):]
    body = body[:body.index("\n}\n")]
    assert "style.display" in body, "the switch does not toggle display at all"
    for renderer in ("ssRenderLib(", "ssRenderPicker(", "ssLoadLib(", "ssLoadSongs(", "innerHTML"):
        assert renderer not in body, (
            f"ssSetView calls {renderer} - flipping a pill would rebuild the half it reveals and "
            "throw away a player that is mid-playback")
