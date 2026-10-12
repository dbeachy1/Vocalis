"""5.4: the narrate button's colors, resolved by a REAL browser.

test_st_extension_smoke.py checks that the rules exist and where they sit in the file.
This asks Chrome what it actually paints — including under :hover, where two rules of
identical specificity (0,2,0) compete and only source order separates them. Getting that
backward turns every colored button orange under the pointer while every string
assertion in the repo keeps passing, which is precisely how the Voices player shipped
broken (docs: 5.0-M10c).

Skips without Node or Chrome. Checks live in st_button_colors_spec.mjs.
"""
import shutil
import subprocess

from conftest import assert_spec_ran
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from test_voices_player_browser import _chrome        # noqa: E402

NODE = shutil.which("node")
STYLE = Path(__file__).parent.parent / "sillytavern" / "extension" / "style.css"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_button_colors_resolve_in_a_real_browser():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "st_button_colors_spec.mjs"), str(STYLE), _chrome()],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0, f"button color spec failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
    # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
    # file has no SPEC constant, so conftest cannot derive one from a module-level path.
    #
    # ⚠️ 9 → 21, MEASURED against the run that added 9.1 §1's band checks, not raised by the
    # size of the diff. A floor left at the old number would have gone on passing while the
    # entire band section stopped running.
    assert_spec_ran(r, Path(__file__).parent / "st_button_colors_spec.mjs", floor=21)
    # A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("all four states are visually distinct",
                  "instead of reverting to orange",
                  "color and glyph are separate axes",
                  # 9.1 §1 — the band. Every one of these is pure cascade: a background
                  # competing with an ST theme, and five icon rules of identical (1,4,0)
                  # specificity that only source order separates.
                  "header bar is YELLOW",
                  "a band on all of them is not a landmark",
                  "the speaker's name goes dark on the band",
                  "an ordinary row keeps the theme's color",
                  "the narrate button keeps its own color on the band",
                  "an AUDIBLE button is RED",
                  "and a PAUSED one is not",
                  "clears 4.5:1 against the band",
                  "and the UNDARKENED green would not"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
