"""9.5.21 §18e — editing a message re-preloads its current text when preloading is enabled.

SillyTavern may emit MESSAGE_EDITED and MESSAGE_UPDATED for one edit. Submitting on both events
would duplicate the request, and cancellation associated with the second event could discard the
first. updateMessage writes the new text before its first event, so the request body must contain
that text rather than the value that was replaced. The browser spec checks the event ordering,
request count, and payload against the real extension code.
"""
import shutil
import subprocess
from pathlib import Path

import pytest
from test_voices_player_browser import _chrome

NODE = shutil.which("node")
HERE = Path(__file__).parent
EXT = HERE.parent / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_an_edited_message_is_preloaded_again_by_itself():
    r = subprocess.run(
        [NODE, str(HERE / "st_edit_repreload_spec.mjs"), str(EXT), str(HERE / "st_dom_shim.js"),
         _chrome()],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    assert r.returncode == 0, f"the edit re-preload spec failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 A SPEC THAT STOPPED CHECKING EARLY EXITS 0 AS HAPPILY AS ONE THAT PASSED, so each claim
    # is named here. Every one of these is a separate way the feature can be wrong, and four of
    # the five are ways it can be wrong while still LOOKING like it works.
    for named in ("re-preloads the message with nobody asking it to",
                  "sends the NEW text, never the text he replaced",
                  "exactly one preload, not one per event",
                  "goes back to green on its own",
                  "preloads nothing — the automatic path speaks the character",
                  "with pre-rendering off and no chain armed",
                  "unticking the box during the debounce",
                  "drops the pending re-preload rather than sending it at a shifted index"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
