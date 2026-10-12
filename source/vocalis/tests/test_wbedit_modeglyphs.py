"""Tests mode-indicator calculation for World Book entries."""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import paths

FORK_ROOT = os.environ.get("VOCALIS_SILLYTAVERN_ROOT")
FORK = Path(FORK_ROOT) if FORK_ROOT else None
FORK_INDEX = FORK / "public" / "index.html" if FORK else None

#: The three the fork actually defines. `disabled` is deliberately NOT here: SillyTavern models
#: disable as an orthogonal toggle (`fa-comment-slash`, "Temporarily disable") and derives "normal"
#: from none of the boxes being ticked, so there is no option element for it to mirror. Ours is ⛔,
#: chosen to read as *stopped* rather than as a fourth injection mode.
MIRRORED = ("constant", "normal", "vectorized")


def _fork_state_glyphs() -> dict[str, str]:
    """Checks that fork state glyphs."""
    src = FORK_INDEX.read_text(encoding="utf-8", errors="replace")
    m = re.search(r'name="entryStateSelector"(.*?)</select>', src, re.S)
    assert m, ("`entryStateSelector` is no longer a <select> in the fork's public/index.html — "
               "this parser needs updating before it can guard anything")
    out = {}
    for value, glyph in re.findall(r'<option\s+value="(\w+)"[^>]*>([^<]+)</option>', m.group(1)):
        out[value] = glyph.strip()
    assert len(out) >= 3, f"only parsed {out} out of the fork's state selector — parser is stale"
    return out


def _our_modes() -> dict[str, str]:
    """Checks that our modes."""
    srcs = [(paths.WEBUI / "index.html").read_text(encoding="utf-8")]
    srcs += [p.read_text(encoding="utf-8") for p in sorted((paths.WEBUI / "js").rglob("*.js"))]
    pat = re.compile(r"(?:export )?const WB_MODES = \{(.*?)\n\};", re.S)
    m = next((pat.search(s) for s in srcs if pat.search(s)), None)
    assert m, "WB_MODES is no longer an object literal in index.html or any module under js/"
    # Match the declaration across formatting changes while requiring `glyph` to remain its first member.
    out = dict(re.findall(r"(\w+):\s*\{\s*glyph:\s*'([^']+)'", m.group(1)))
    assert len(out) == 4, f"expected four modes, parsed {out}"
    return out


def test_our_glyphs_are_distinct_and_disabled_is_ours():
    """Checks that our glyphs are distinct and disabled is ours."""
    ours = _our_modes()
    assert set(ours) == {"constant", "normal", "vectorized", "disabled"}
    assert len(set(ours.values())) == 4, f"two modes share a glyph, which is what §9a.28 fixed: {ours}"
    assert ours["disabled"] == "⛔", (
        "the fork has no option for `disabled` to mirror, so ours is a deliberate choice — "
        f"change it here and in the WB_MODES comment together, not by accident: {ours}")


@pytest.mark.skipif(FORK_INDEX is None or not FORK_INDEX.is_file(),
                    reason=f"the SillyTavern fork is not at {FORK_INDEX} — set "
                           "VOCALIS_SILLYTAVERN_ROOT to point at it")
def test_the_three_mirrored_glyphs_still_match_the_fork():
    """Fail by mode name when the fork changes a mirrored icon. The expected glyphs come from
    `public/index.html`'s `entryStateSelector`.
    """
    fork, ours = _fork_state_glyphs(), _our_modes()
    drift = {k: (fork.get(k), ours.get(k)) for k in MIRRORED if fork.get(k) != ours.get(k)}
    assert not drift, (
        "our injection-mode glyphs no longer match SillyTavern's own entryStateSelector. "
        "§9a.28 exists so these two screens say the same thing — follow the fork, or record a "
        f"deliberate reason not to. {{mode: (fork, ours)}} = {drift}")


@pytest.mark.skipif(FORK_INDEX is None or not FORK_INDEX.is_file(),
                    reason=f"the SillyTavern fork is not at {FORK_INDEX} — set "
                           "VOCALIS_SILLYTAVERN_ROOT to point at it")
def test_the_fork_still_has_no_disabled_option():
    """Checks that the fork still has no disabled option."""
    fork = _fork_state_glyphs()
    assert "disabled" not in fork, (
        "SillyTavern's entryStateSelector now offers `disabled` — mirror its glyph instead of "
        f"keeping ours: {fork}")
