"""The harnesses' source markers tolerate RESPACING, and nothing else. 8.3.2.

🔴 WHY THIS GUARD EXISTS. 8.3.2 ran the whole JavaScript tree through Prettier. Roughly two
hundred markers across the .mjs harnesses had been written against the dense style that preceded
it (`const vOrder=list=>`), and `relaxSpace` in tests/_websrc.mjs only relaxed whitespace a marker
ALREADY had - so every one of them stopped matching. A harness reports that as "the function was
deleted", and the fix it invites is deleting the check.

`relaxSpace` now also allows whitespace the marker does NOT have, wherever the JavaScript grammar
says whitespace is insignificant. That is a real loosening of a guard, so it gets a guard of its
own, and the claim it defends is narrow:

  1. ROUND TRIP, OVER THE REAL CORPUS. For every top-level definition actually in the tree, the
     marker built from its source line and the marker built from a DENSIFIED copy of that line
     locate the same set of files. Tested against the actual definitions - 928 of them - rather
     than against fixtures somebody thought of.
  2. THE IDENTIFIER BOUNDARY IS STILL RIGID. `const vOrder` must not come to match `constvOrder`.
  3. STRING INTERIORS ARE STILL RIGID. `$('kobSave')` must not come to match `$(' kobSave')` - a
     different element id, which would point a slice at the wrong code while looking like a pass.

⚠️ POINT 3 IS THE ONE THAT NEEDED TWO GOES, AND BOTH FAILURES WERE SILENT. A marker is a FRAGMENT,
so its quotes do not always pair the way they look. `blkToEnhanceWrap').style.display=(...` begins
in the MIDDLE of a string literal, and reading its first quote as an opener swallows the rest into
one rigid atom that matches nothing. The first fix - treat unpaired markers as pure code - then
made the mirror-image fragment `:'The voice was saved, but ...` elastic INSIDE a user-visible
sentence, so `saved,but` would have satisfied a check about the exact wording. Both directions are
pinned in the node checks now.

⚠️ THE CHECK RUNS IN NODE, NOT HERE. Its subject is a `.mjs` module and its corpus is the real
module tree loaded through _websrc.mjs itself; re-implementing either in Python would be a second,
weaker copy of the thing being tested. This file is the driver that puts it in the suite, which is
where the pre-deploy gate actually is. Same shape as test_webui_comment_strip.py.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

ROOT = Path(REPO_ROOT)
CHECKER = ROOT / "tests" / "websrc_marker_check.mjs"
WEBSRC = ROOT / "tests" / "_websrc.mjs"

_NO_NODE = shutil.which("node") is None


def test_the_marker_guard_is_still_there():
    """A deleted guard must fail here, not silently un-guard every marker in every harness."""
    assert WEBSRC.exists(), (
        f"{WEBSRC} is gone. Every .mjs harness slices module source through it; without it there "
        "are no markers to guard."
    )
    assert CHECKER.exists(), (
        f"{CHECKER} is gone - relaxSpace() in tests/_websrc.mjs is now unguarded. It decides how "
        "permissively ~500 source assertions match, and it has already been wrong twice in ways "
        "that fail SILENTLY. Restore it rather than dropping the check."
    )


@pytest.mark.skipif(_NO_NODE, reason="node is not on PATH")
def test_markers_tolerate_respacing_and_nothing_else():
    """The three claims in this module's docstring, asserted by tests/websrc_marker_check.mjs.

    ⚠️ THE ROUND-TRIP HALF REFUSES TO BE VACUOUS. It counts how many of the tree's definitions
    actually carried insignificant whitespace and fails if that number collapses - because a pass
    over a corpus with nothing to densify would prove nothing at all, which is the exact shape of
    green-over-no-product this whole area exists to prevent.
    """
    r = subprocess.run(["node", str(CHECKER)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", cwd=str(ROOT))
    assert r.returncode == 0, (
        "tests/websrc_marker_check.mjs failed - relaxSpace() in tests/_websrc.mjs has either "
        "stopped tolerating respacing (harnesses will report live features as deleted) or started "
        "tolerating more than that (assertions quietly stop meaning what they say).\n\n"
        f"{r.stdout}\n{r.stderr}"
    )
