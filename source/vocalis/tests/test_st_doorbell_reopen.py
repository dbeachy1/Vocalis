"""The pairing channel state is scoped per browser tab. These tests verify that reopening a doorbell does not share or reset state across tabs."""
import shutil
import subprocess
from pathlib import Path

import pytest

# 9.0.12 — the browser-spec output guard. Importing conftest is also the sys.path side effect
# every other browser wrapper in this tree relies on.
# ⚠️ NO `# noqa: F401` HERE. The neighboring REPO_ROOT imports carry one because they exist
# ONLY for that side effect and are never referenced; this name IS called below, so the
# suppression would be noise - and the tree's noqa ratchet counts it. Copying a suppression
# from a nearby line without checking whether its reason holds is how a ceiling gets raised.
from conftest import assert_spec_ran

NODE = shutil.which("node")
SPEC = Path(__file__).parent / "st_doorbell_reopen_spec.mjs"
EXT = Path(__file__).parent.parent / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_pairing_channel_reopens_is_gated_and_is_single_winner():
    r = subprocess.run([NODE, str(SPEC), str(EXT)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=120)
    assert r.returncode == 0, f"pairing-channel spec failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. Until 9.0.12 this file asserted nothing but the exit code, and a
    # spec that returns early, loses a selector rename or has a block deleted exits 0 and is
    # merely SHORTER. ⚠️ MEASURED, not derived: the two scanners disagree on this spec (32 vs 29),
    # so a derived number here would be a coin flip between a weak guard and a red suite.
    assert_spec_ran(r, SPEC, floor=27)
    # ⚠️ A spec that silently stopped checking exits 0 as happily as one that passed — the
    # anti-deletion rule the browser specs use, applied here for the same reason.
    for named in ("the fallback tick RE-OPENS the stream once the backoff has elapsed",
                  "a transport drop is left to the browser",
                  "and is capped at five minutes",
                  "a switched-off extension opens no stream",
                  "a switched-off extension never claims a sweep",
                  "tab B does not claim a job while tab A is mid-run",
                  "an expired lease from a crashed tab is taken over",
                  "a tab that loses the write race",
                  "no usable storage degrades to the per-tab guards alone"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
