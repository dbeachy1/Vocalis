"""Every filter box read by the UI must be written by `filtWire`. The source checks include speech filters so a missing event binding cannot pass unnoticed."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

JS = Path(__file__).resolve().parents[1] / "src" / "webui" / "js"

#: The four readers. All of them key off `FILT[id]`, so all of them are dead without a `filtWire`.
READS = re.compile(r"filt(?:Q|Rows|Count|None)\(\s*['\"]([A-Za-z0-9_-]+)['\"]")
WIRES = re.compile(r"filtWire\(\s*['\"]([A-Za-z0-9_-]+)['\"]")


def _strip_comments(src: str) -> str:
    """🔴 A SCANNER READS PROSE AS CODE, and this repo has been bitten by it repeatedly — the two
    files involved here now *document* the broken wiring, quoting the exact dead call. Unstripped,
    the census would read its own explanation as a live call site."""
    src = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    return "\n".join("" if ln.lstrip().startswith("//") else ln for ln in src.splitlines())


@pytest.fixture(scope="module")
def boxes():
    """({id: {files that read it}}, {ids that are wired})."""
    used: dict[str, set[str]] = {}
    wired: set[str] = set()
    for p in sorted(JS.rglob("*.js")):
        src = _strip_comments(p.read_text(encoding="utf-8"))
        for m in READS.finditer(src):
            used.setdefault(m.group(1), set()).add(p.name)
        wired.update(m.group(1) for m in WIRES.finditer(src))
    return used, wired


def test_every_filter_box_that_is_read_is_also_wired(boxes):
    """🔴 THE DEFECT. `spFilter` was read by `voiceswap.js` and wired by nobody."""
    used, wired = boxes
    dead = sorted(set(used) - wired)
    assert not dead, (
        "these filter boxes are READ but never `filtWire`d, so their query is never recorded and\n"
        "the box silently filters nothing:\n  "
        + "\n  ".join(f"{d}  (read in {', '.join(sorted(used[d]))})" for d in dead)
        + "\n\nWire it in `js/ui/filterwiring.js` beside the others - a raw "
        "`addEventListener('input', render)`\nlooks like wiring, calls the renderer, and does NOT "
        "write `FILT`."
    )


def test_nothing_is_wired_that_nobody_reads(boxes):
    """📌 THE OTHER DIRECTION, and it is the cheaper bug: a `filtWire` for a box no render consults
    is a keystroke handler repainting a list that ignores the query. Harmless-looking, and it means
    the same thing as the defect above from the user's side — a box that does nothing."""
    used, wired = boxes
    orphans = sorted(wired - set(used))
    assert not orphans, (
        "these boxes are wired but no render reads their query - the keystroke repaints a list "
        "that filters on nothing:\n  " + "\n  ".join(orphans)
    )


def test_the_census_is_looking_at_something(boxes):
    """⚠️ A CENSUS THAT FINDS NOTHING PASSES. If `filtQ` is renamed or the JS tree moves, both sets
    go empty and the difference is empty too — green, and blind. The floor is well under the real
    figure (11 boxes) and exists only to fail loudly when the scanner stops seeing the code."""
    used, wired = boxes
    assert len(used) >= 8, f"only {len(used)} filter boxes found - the reader regex has gone blind"
    assert len(wired) >= 8, f"only {len(wired)} filtWire calls found - the wiring scan is blind"


def test_the_guard_can_say_no():
    """🔴 MUTATION TEST, OR IT IS DECORATION. A box read and not wired must be reported."""
    src = "const x = filtRows('ghostFilter', rows, r => r.name);\nfiltWire('otherFilter', f);\n"
    used = {m.group(1) for m in READS.finditer(src)}
    wired = {m.group(1) for m in WIRES.finditer(src)}
    assert used - wired == {"ghostFilter"}, "the census would not notice an unwired box"


def test_a_commented_out_wiring_does_not_count(boxes):
    """📌 The two files this bug touched now QUOTE the dead call in their comments, so a scanner
    that read comments would find `filtWire`/`filtQ` in prose and pass on the documentation."""
    src = "// filtWire('ghostFilter', render)\nconst q = filtQ('ghostFilter');\n"
    stripped = _strip_comments(src)
    assert "filtWire" not in stripped
    assert "filtQ" in stripped
