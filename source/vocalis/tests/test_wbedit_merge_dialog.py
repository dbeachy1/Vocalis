"""Tests merge-dialog behavior and conflict presentation."""
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran

NODE = shutil.which("node")
INDEX = REPO_ROOT / "src" / "webui" / "index.html"
SPEC = Path(__file__).parent / "wbedit_merge_dialog_smoke.mjs"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_the_merge_dialog_pre_selects_the_imported_file():
    r = subprocess.run(
        [NODE, str(SPEC), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"node smoke failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END — the exit code cannot tell a pass from a script that stopped
    # checking, because an early return leaves the run SHORTER and still green. The floor is
    # DERIVED here (14, and the spec emits 14): every ok() in it is unconditional, so there is
    # nothing for a hand-picked number to be more honest about.
    assert_spec_ran(r, SPEC)
