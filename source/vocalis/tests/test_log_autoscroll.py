"""The log auto-scroll rules, exercised through Node.

`log_autoscroll_behavior.mjs` runs the real `js/ui/log.js` against small fake elements: checking
Book's or Bulk's auto-scroll box jumps to the last line, scrolling up turns it off, and a log
whose tab was hidden while lines arrived shows its last line again when the tab comes back.
Until 2026-10-23 no test ran that file, so it could not fail. It skips when Node is unavailable."""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SPEC = Path(__file__).parent / "log_autoscroll_behavior.mjs"


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_log_autoscroll_rules():
    r = subprocess.run([NODE, str(SPEC)], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=60)
    assert r.returncode == 0, f"node behavior test failed:\n{r.stdout}\n{r.stderr}"
    # The script ends with this line only when every assertion above it ran.
    assert "PASS: Book and Bulk auto-scroll controls" in r.stdout, r.stdout
