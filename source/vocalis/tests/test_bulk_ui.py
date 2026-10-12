"""The Bulk tab's staged-file list, exercised through Node.

Route tests do not verify that staged files render, that removal targets the correct file, or
that names are escaped before insertion into HTML. This smoke test extracts and exercises the
real render helpers from index.html. It skips when Node is unavailable."""
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran

NODE = shutil.which("node")
INDEX = REPO_ROOT / "src" / "webui" / "index.html"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_bulk_staged_list_renders():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "bulk_staged_smoke.mjs"), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"node smoke failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
    # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
    # file has no SPEC constant, so conftest cannot derive one from a module-level path.
    assert_spec_ran(r, Path(__file__).parent / "bulk_staged_smoke.mjs", floor=41)
