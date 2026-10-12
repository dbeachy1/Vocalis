"""6.0 §7 — the Clips tab's UI, sliced out of the real index.html and exercised.

`test_clips_routes.py` talks to the routes, and would notice none of this: that the tab landed
in the wrong slot in the strip, that it got called "Library" (a word this app already uses for
two other things, one of them a route), that the enhanced filter reads the wrong field, that a
scene's name reaches the page unescaped, or that the list renders the transcript §5.1 was
careful not to send it.

Checks live in `clips_ui_smoke.mjs`. Skips when node isn't installed — same contract as
test_devices_ui.py.
"""
import shutil
import subprocess

from conftest import assert_spec_ran
from pathlib import Path

import pytest

NODE = shutil.which("node")
INDEX = Path(__file__).parent.parent / "src" / "webui" / "index.html"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_the_clips_tab_lists_filters_and_escapes():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "clips_ui_smoke.mjs"), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0, f"clips UI smoke failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
    # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
    # file has no SPEC constant, so conftest cannot derive one from a module-level path.
    # 9.5.7: 173 -> 190, the seventeen checks the sortable column headers brought with them.
    # 9.6.7: 190 -> 194, the four the ▶/■/✕ button's three states brought with them.
    # Measured with `node tests/clips_ui_smoke.mjs src/webui/index.html | grep -c '^  ok '`, not
    # guessed — a floor set below the real count is a floor that cannot see checks vanish.
    # Docker edition: re-measured at 204 (the 7.5 Train block became the ＋ Speech block, +1 check).
    assert_spec_ran(r, Path(__file__).parent / "clips_ui_smoke.mjs", floor=204)

    # A smoke that silently stopped checking exits 0 as happily as one that passed.
    #
    # 🔴 And that is not hypothetical: 6.0-m2's checks were appended to the .mjs AFTER its
    # `process.exit`, so twenty-two of them were dead code and the file still reported "all
    # checks passed". This list is the only thing that catches it — every block added below
    # has to put a name here.
    for named in ("not Library",
                  "the PLAYGROUND library",
                  "this IS the cleanup workflow",
                  "the list renders no message text",
                  "escaped on the way into the page",
                  # m2 §7 — the rest of the tab
                  "the Clips list has a kind filter",
                  "all three stores are listed",
                  "links its OWN route",
                  "only the scene row offers Chapters",
                  "two different keys",
                  "TICK order",
                  "counts the gaps between clips",
                  "act on the SCENES in the selection",
                  "escaped on the way into the join tray",
                  "the §9 promise on screen",
                  # 6.1 §10.3 — the chapters accordion
                  "nothing is expanded until a Chapters button is pressed",
                  "the accordion, not a footer",
                  "the detail cell spans every column",
                  "the detail row no longer carries a player slot",
                  "chapter text and speaker are escaped",
                  "the Clips search box goes through filtWire",
                  # 6.1 §10.5 — the player row
                  "no player row until something is playing",
                  "exactly one player row",
                  "not at the top of the tab",
                  "the player cell spans every column",
                  "reads Stop, in red",
                  "and every other row still reads Play",
                  # 9.6.7 — the red ■ Stop outlived the audio. `scLib.playing` is set in
                  # `scEnsurePlayer` and cleared in `scStop` and nowhere else, so reaching the
                  # end of a clip — the ordinary way playback finishes — changed nothing.
                  "reads Close, not red Stop",
                  "its tooltip is about putting the player away",
                  "the player row is still there until he closes it",
                  "a clip paused on the player bar",
                  "gets the same inline player",
                  "that IS the way to put the bar away",
                  # 6.1-m1b — staging edits
                  "staged inserts are spliced into the running order",
                  "has a real background rule behind it",
                  "and it is absent while nothing is staged",
                  "no paste buttons until something is copied",
                  "a joined scene has no",
                  "an inserted entry with a null mesid",
                  # 6.3 — Enhance on the row (7.5.1 inverted two of these; see the .mjs)
                  "a raw scene with no twin offers Enhance",
                  "already HAS a twin still offers Enhance",
                  "the enhanced take does NOT",
                  "a re-enhance REPLACES the twin",
                  "the promise it must never make again is absent",
                  # 7.5.1 — the size on the row
                  "every row shows its size beside its length",
                  "reported as having run the whole way through",
                  "is called out as CUT SHORT",
                  "an orphaned twin makes no claim at all",
                  "replaces the button with its own status",
                  "and a way to stop it",
                  "a box that cannot enhance does not offer the button at all",
                  "and it says why, where the button would have been",
                  # 7.5 — 🎓 Train on the row, now ＋ Speech in the Docker edition
                  "＋ Speech is offered on the scene and the Playground clip",
                  "and NOT on an upload",
                  "and no row offers 🎓 Train",
                  "each kind posts to its own store's import route",
                  # 6.2 — favorites
                  "every row carries a star toggle",
                  "a starred row and an unstarred one look different",
                  "favorites only leaves exactly the starred rows",
                  "the favorites filter ADDS to the enhanced one",
                  # 11.2.7 — the queue lives on the server. The 9.0.13 "fills every card" checks
                  # moved with the pump to tests/test_scene_enhance_queue.py; what the tab still
                  # owns is that a press is ONE request to the queue and never a start of its own.
                  "a press is ONE request, to the server's queue",
                  "the tab never POSTs a start itself",
                  "the strip's fan-out count is the SERVER's card count",
                  "says nothing about fan-out",
                  "the strip no longer tells him to keep the tab open",
                  "✨ Enhance selected sends one {add} in tick order",
                  "a queue left in the browser is handed to the server",
                  "the browser copy is cleared, so it is handed over exactly once",
                  # 9.2.1 — the progress bar and the stop. The first two are the ones that would
                  # pass against a bar that lies: an overrun must hold at 99, and an untimed box
                  # must sweep rather than invent a percentage.
                  "halfway through the estimate is a bar at 50%",
                  "an overrun holds at 99, never 100",
                  "an untimed box gets an indeterminate sweep",
                  "the strip counts running and done",
                  "AND asks the server to cancel what is already running",
                  "declining the confirmation leaves the queue",
                  # 9.2.2 — ✨ Enhance selected, and the two-layer wiring check behind it
                  "only the raw scene that is not already queued counts",
                  "the button says how many it would add",
                  "a twin and a Playground clip are never queued",
                  "a box that cannot enhance offers nothing to bulk-enhance",
                  "the page carries the ✨ Enhance selected button",
                  "…and something wires that id's onclick",
                  # 9.5.6 — the queue is a list, it reorders, and a drag owns the DOM until it
                  # ends. The three 🔴 ones are the defects: an inline flex:0 is what squashed the
                  # header to one word per line, an index-based move lands one place short going
                  # downward, and a render mid-drag kills the gesture with no error at all.
                  "NOTHING in the strip carries an inline flex:0",
                  "one row per waiting item, not one pill",
                  "no pills are left",
                  "every row carries its position",
                  "and they are in queue order, top to bottom",
                  "each row has its own ✕",
                  "it refuses the drag rather than accepting one that would do nothing",
                  "downward: a lands immediately before d",
                  "dropping a row onto itself changes nothing",
                  "a ref that is not in the queue is refused, not appended",
                  "each of the four real moves is sent to the server",
                  "a render arriving mid-drag does not replace the list under the cursor",
                  "the render it skipped is flushed when the drag ends",
                  "the drop commits through scEnhMove"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
