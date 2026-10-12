"""Tests World Books and Character Cards interface structure and controls."""
import shutil
import subprocess

from conftest import assert_spec_ran
from pathlib import Path

import pytest

NODE = shutil.which("node")
INDEX = Path(__file__).parent.parent / "src" / "webui" / "index.html"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_the_editor_sub_tabs_are_wired_escaped_and_the_shell_is_wide():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "wbedit_ui_smoke.mjs"), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0, f"wbedit UI smoke failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
    # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
    # file has no SPEC constant, so conftest cannot derive one from a module-level path.
    assert_spec_ran(r, Path(__file__).parent / "wbedit_ui_smoke.mjs", floor=45)

    # Register every browser assertion so a missing check cannot produce a passing smoke test.
    for named in ("the sub-tabs read",
                  "Character Voices",
                  "Scene Clips",
                  "nested inside the SillyTavern section",
                  "the 1080px shell is gone",
                  "and so does the footer",
                  "no hand-written 1080 survives",
                  "is estimated at",
                  "the diff marks the changed span",
                  "the unchanged tail is NOT marked",
                  "escaped on the way into the diff",
                  "reads no body field off the frame",
                  "fetches the announced proposal",
                  "escaped into the Library row",
                  "escaped into the review row",
                  "rendered but folded",
                  "one is already running",
                  "the failure path says",
                  "never renders",
                  "is defined somewhere (page or module)",
                  "all three sub-tabs are wired"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
