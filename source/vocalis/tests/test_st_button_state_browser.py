"""Browser test for the narrate button client-side state machine.

Markup and CSS checks cannot prove that the client arms polling for a new reply. This test runs the real extension module with a small DOM shim and scripted transport, then checks polling transitions. It appends a row and fires the same single event used by SillyTavern so another event cannot arm polling and mask a missing transition.

Requires Node and Chrome; skips when either is unavailable."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from test_voices_player_browser import _chrome        # noqa: E402

NODE = shutil.which("node")
HERE = Path(__file__).parent
EXT = HERE.parent / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_button_walks_yellow_blue_green_on_its_own():
    r = subprocess.run(
        [NODE, str(HERE / "st_button_state_spec.mjs"), str(EXT), str(HERE / "st_dom_shim.js"),
         _chrome()],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    assert r.returncode == 0, f"button state spec failed:\n{r.stdout}\n{r.stderr}"
    # A spec that silently stopped checking exits 0 as happily as one that passed — and the
    # two named here are the ones that actually failed on the broken client.
    for named in ("polling STARTS from the pre-render path",
                  "it reaches green on its own",
                  # 7.4 §18 — the shift-click menu's two new rows, and the glyph nobody
                  # reconciled. All three are silent when they break: a menu item that does
                  # nothing, a chain that keeps going after ⏹, a stop button that reads as a
                  # speaker on the one message he is trying to stop.
                  "the shift-click menu offers Preload",
                  "and Autoplay from here on",
                  "Preload asks the server even with",
                  "and it does not switch that setting on behind his back",
                  "Autoplay starts playing at the message it was asked from",
                  "it walks on to the next message by itself",
                  "and the messages it still has to read are marked",
                  "pressing stop ends the chain",
                  "and the marks come off with it",
                  "a playing message shows the stop icon",
                  "precondition: the row comes back wearing a speaker",
                  "a message that was re-created WHILE PLAYING gets its stop icon back",
                  "precondition: the rebuilt button is a GREEN SPEAKER",
                  "a repaint of the PLAYING message keeps the stop icon",
                  "and it is still green",
                  "and the stop icon survived the color landing on top of it",
                  # 9.1 §1 — the yellow header band. The middle two are the ones that would rot
                  # silently: a band that vanished on pause, or one that did not come back when
                  # the row was rebuilt, both look exactly like "working" in a screenshot taken
                  # at the right moment.
                  "the loaded message's ROW wears the band, and only it",
                  "its button is marked AUDIBLE",
                  "pausing takes the red off the stop square",
                  "the band STAYS THROUGH THE PAUSE",
                  "and resuming brings the red back",
                  "a row re-created WHILE LOADED gets its band back",
                  "pressing stop takes the band off",
                  # 9.5.10 §18d - "preload from here on". Every one of these is silent when it
                  # breaks: a walk that skips the message the server refused leaves a hole nothing
                  # will ever fill, and a chain that ignores Stop, or that polls a switched-off
                  # server forever, both look exactly like a working feature from outside.
                  "the menu offers Preload from here on",
                  "5 is still Add and 6 is still Remove",
                  "it starts AT the message he shift-clicked",
                  "and walks forward past his own line without speaking it",
                  "the message the server refused is the one it re-sends",
                  "the last message in the chat is reached",
                  "a new reply is preloaded by the armed chain",
                  "STOP MEANS STOP",
                  "a server with pre-rendering switched off is asked ONCE",
                  "and the mode really ended",
                  "polling stops dead once everything on screen is terminal"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
