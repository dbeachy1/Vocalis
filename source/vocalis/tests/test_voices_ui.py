"""The Voices tab's render helpers, driven through Node (4.8-m3).

test_server.py and test_voxcpm.py talk to the routes. Nothing there would notice that the
Create tab went back to listing all 27 uploaded voices, that the Seed box reappeared, that a
candidate row grew an Overwrite button again, or that the list heading kept saying "Voices"
while showing half of them — and each of those is a specific decision DESIGN_4_8_VOXCPM.md
§14 spent pages on. So the real helpers are sliced out of the real index.html and exercised.
See voices_ui_smoke.mjs.

Skips when node isn't installed — same contract as test_bulk_ui.py.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran

NODE = shutil.which("node")
INDEX = REPO_ROOT / "src" / "webui" / "index.html"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_voices_tab_renders():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "voices_ui_smoke.mjs"), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"node smoke failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
    # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
    # file has no SPEC constant, so conftest cannot derive one from a module-level path.
    assert_spec_ran(r, Path(__file__).parent / "voices_ui_smoke.mjs", floor=262)
