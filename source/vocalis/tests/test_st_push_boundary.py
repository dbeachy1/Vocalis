"""Guard the SillyTavern-to-Vocalis boundary against content leaks and hung calls.

A malformed world-book response can put source content in a JavaScript SyntaxError. The spec
runs the real parser and boundary functions, then checks that diagnostics expose only safe labels.
It also verifies locked-vault and token failures remain actionable, and that SillyTavern requests
time out so a pending call cannot wedge the page's sweep or push state.

The Node spec extracts the real functions from the extension and injects the host-side APIs; no
browser, server, or live SillyTavern instance is needed.
"""
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
SPEC = Path(__file__).parent / "st_push_boundary_spec.mjs"
EXT = Path(__file__).parent.parent / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_push_boundary_leaks_nothing_says_why_and_cannot_hang():
    r = subprocess.run([NODE, str(SPEC), str(EXT)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=180)
    assert r.returncode == 0, f"push boundary spec failed:\n{r.stdout}\n{r.stderr}"

    # 🔴 AND IT RAN TO THE END. Until 9.0.12 this file asserted nothing but the exit code, and a
    # spec that returns early, loses a selector rename or has a block deleted exits 0 and is
    # merely SHORTER. ⚠️ MEASURED, not derived: the two scanners disagree on this spec (32 vs 29),
    # so a derived number here would be a coin flip between a weak guard and a red suite.
    # 11.1.8 raised this from 41 to 55 — thirteen cache-bust checks and one more on the create
    # path. Measured off a green run, not estimated: every ok() in this spec is unconditional, so
    # a correct run cannot come out lower and a lower one means the spec stopped early.
    assert_spec_ran(r, SPEC, floor=55)
    # ⚠️ A spec that silently stopped checking exits 0 as happily as one that passed.
    for named in ("the premise of B.5 holds on this engine",
                  "does not put source content into tally.errors",
                  "does not put card text into tally.errors",
                  "fetchCardPng reports the class, not the message",
                  "a name that is not a bare identifier is refused",
                  "a mid-sweep auto-lock is reported as the sentence that fixes it",
                  "a rotated token is reported as the sentence that fixes it",
                  "an ordinary per-document failure is NOT fatal",
                  "a locked vault produces ONE sentence for the whole sweep",
                  "a merge-attributes that never answers RETURNS",
                  "a saveWorldInfo that never resolves RETURNS",
                  "a loadWorldInfo that never answers RETURNS",
                  "an /api/characters/all that never answers",
                  "a normal card write still succeeds",
                  # 7.4 / §9a.33 — the create path. Both failure modes it can have are silent:
                  # a cheerful "created" over a write that never happened, and a lost filename
                  # that turns his next Save into a second character.
                  "a card SillyTavern has never seen is created rather than refused",
                  "and it reports the filename SillyTavern chose",
                  "through their own importer, as JSON",
                  "a 200 carrying {error:true} is a failed create",
                  "a create whose picture failed still reports the reference",
                  "a created card refreshes the roster before a picture failure can return",
                  # 🔴 11.1.8 — the send landed and the page went on showing the old face. These
                  # are CALL-SITE checks on purpose: the helper working proves nothing about
                  # whether anything reaches it, and that was the entire defect.
                  "the new picture is busted out of the browser cache under the card key",
                  "the full-size image is re-primed too",
                  "it happens AFTER the roster refetch",
                  "a merge with no picture busts nothing",
                  "busts THAT name, not the one Vocalis asked for",
                  "a repaint that never answers cannot wedge a send that already landed",
                  "a script.js without bustAvatarThumbnails still reports the send it really made",
                  "a filename with a space is primed percent-encoded",
                  "a persona primes the URL THEIR module builds",
                  "an empty filename reaches neither of them"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
