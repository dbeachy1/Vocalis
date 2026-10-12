"""The page's Docker-conditional texts, driven through Node (release audit, 2026-10-11).

`docker_texts_smoke.mjs` slices the real helpers out of the real modules and runs each with the
page's DOCKER flag on and off. Skips when node isn't installed - same contract as
test_voices_ui.py."""
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran

NODE = shutil.which("node")
INDEX = REPO_ROOT / "src" / "webui" / "index.html"
SPEC = Path(__file__).parent / "docker_texts_smoke.mjs"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_docker_conditional_texts_render():
    r = subprocess.run([NODE, str(SPEC), str(INDEX)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"node smoke failed:\n{r.stdout}\n{r.stderr}"
    assert_spec_ran(r, SPEC, floor=20)
