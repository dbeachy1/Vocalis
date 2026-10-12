"""8.1 — a completed pre-render stays green until its text changes.

onCharacterMessageRendered invalidates state for regenerated text. The sweep must then re-probe
that message so the color can reflect the current cache state. An unchanged re-render should keep
the existing color without flicker or a request; changed text should invalidate and restore it.
The probe also must recover after a transient request failure rather than leaving all indicators
stuck. This browser spec checks DOM state and event ordering against the real extension code.
"""
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
def test_a_cached_message_stays_green_until_its_text_changes():
    r = subprocess.run(
        [NODE, str(HERE / "st_prerender_green_spec.mjs"), str(EXT), str(HERE / "st_dom_shim.js"),
         _chrome()],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    assert r.returncode == 0, f"green-state spec failed:\n{r.stdout}\n{r.stderr}"

    # A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("a re-render of UNCHANGED text leaves an older message green",
                  "asked the server for nothing",
                  "CHANGED text drops the color AT ONCE",
                  "a sweep puts it back on its own",
                  "after pre-rendering several in a row",
                  "a yellow that finished OFF-SCREEN is re-asked and goes green",
                  "a failed probe BACKS OFF AND RECOVERS"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
