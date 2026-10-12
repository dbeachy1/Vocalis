"""The KoboldCpp tab's render helpers, driven through Node (4.7-m1).

test_kobold_routes.py talks to the routes. Nothing there would notice that the admin token
input quietly became type="password" again, that the Show toggle started flipping el.type,
or that a remote host's detail line describes the LOCAL box's configs — and each of those is
a specific decision this design spent pages on. So the real helpers are sliced out of the
real index.html and exercised. See kobold_ui_smoke.mjs.

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
def test_kobold_tab_renders():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "kobold_ui_smoke.mjs"), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"node smoke failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
    # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
    # file has no SPEC constant, so conftest cannot derive one from a module-level path.
    # 9.3 raised this from 70 to 95 with the ticked-cards warning's 25 checks. MEASURED, not
    # guessed: a full run of the smoke prints exactly 95 `ok` lines, and every one of them is
    # unconditional at top level or guarded by a check that fails first if its input is gone —
    # so a correct run cannot come out lower, and a floor left at 70 would let a quarter of the
    # file stop running while still reading like a guard.
    assert_spec_ran(r, Path(__file__).parent / "kobold_ui_smoke.mjs", floor=95)
