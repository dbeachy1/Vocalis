"""Node smoke coverage for the Devices settings rows.

Route tests do not verify the rendered controls. This spec runs the actual UI helpers from
`index.html` to check worker-count controls, offline satellite rows, and fully qualified remote
card IDs. It skips when Node.js is unavailable.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran

NODE = shutil.which("node")
INDEX = REPO_ROOT / "src" / "webui" / "index.html"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_device_rows_render_and_save():
    r = subprocess.run(
        [NODE, str(Path(__file__).parent / "devices_ui_smoke.mjs"), str(INDEX)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"node smoke failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a script that stopped
    # checking - an early return leaves the run SHORTER and still green. ⚠\Fe0f MEASURED floor: this
    # file has no SPEC constant, so conftest cannot derive one from a module-level path.
    assert_spec_ran(r, Path(__file__).parent / "devices_ui_smoke.mjs", floor=55)
