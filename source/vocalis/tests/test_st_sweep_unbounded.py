"""6.0 §6.1 — exercise the sweep with chat windowing disabled.

When chat_truncation is zero, the client may need to reconcile a large chat rather than only the
visible window. The spec measures requests, per-message text cleanup, and elapsed time while
checking the route's 200-item chunk limit, one cleanup per message, settled-chat behavior, and
free repaint when a row leaves and returns to the DOM. Measurements inform any later decision
about viewport-bounded probing; this test does not choose that policy.
"""
import re
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
def test_the_unbounded_sweep_chunks_memoizes_and_settles():
    r = subprocess.run(
        [NODE, str(HERE / "st_sweep_unbounded_spec.mjs"), str(EXT), str(HERE / "st_dom_shim.js"),
         _chrome()],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    assert r.returncode == 0, f"sweep spec failed:\n{r.stdout}\n{r.stderr}"

    # A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("the client CHUNKS",
                  "substituteParams ran ONCE PER MESSAGE",
                  "a settled chat makes no further requests",
                  "dropped and re-added are all still green"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"

    # And the measurement itself has to be REAL. A stub that answered nothing would satisfy
    # every check above with zeroes.
    m = re.search(r"substituteParams calls\s*:\s*(\d+)", r.stdout)
    assert m and int(m.group(1)) >= 2000, (
        f"the spec measured nothing — it must clean every painted message:\n{r.stdout}")
