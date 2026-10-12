"""8.9 — every scope whose ref MOVES on a rename must carry the folder assignment across.

🔴 WHY A TEST AND NOT A COMMENT. This exact bug has now been shipped three times in one codebase,
and every time the thing that failed was prose:

  * 6.2 → 8.8.3: starring a SCENE and renaming it dropped the star. `for_rows` filtered the orphan
    out on the next listing, so there was no error — the star had simply been there a moment ago.
  * 8.8.3 → 8.8.6: the fix landed for scenes and shipped with a docstring certifying the other two
    kinds safe ("a playground ref is identity-keyed", "an upload's is its filename"). Both were
    wrong. A reader checking whether the playground half needed the same call found a comment
    saying no, and stopped looking. That is what a certifying comment costs when it is wrong.
  * 8.9: the FIRST draft of `folders.rekey`'s docstring copied that same wrong paragraph in.

So the hazard is declared as data — `folders.RENAME_MOVES_REF` — and this file proves each entry is
actually handled. A prose warning cannot fail; this can.

⚠️ IT IS A SOURCE SCAN, DELIBERATELY. The failure mode is not "the hook is wrong", it is "somebody
added a rename path and never wrote the hook at all" — which no behavioral test can reach, because
the route it would exercise does not exist yet. What CAN be checked is that every declared-unstable
scope is named by a real `folders.rekey` call somewhere in the tree.

🔴 AND IT PARSES RATHER THAN GREPS (8.9.14), BECAUSE A COMMENT USED TO SATISFY IT. The scan was a
regex over raw text until then, so commenting the hook out left it green — measured, not supposed:

    old regex scan sees the commented-out call: True  -> would have PASSED
    AST scan: CAUGHT

Read the list above again with that in mind. Every one of the three previous outings of this bug
was PROSE claiming the hook was unnecessary — so a ratchet a comment could satisfy was built out
of exactly the material that had already failed three times, guarding against itself.
"""
import ast
import re
from pathlib import Path

import pytest


# 📌 NO `sys.path` PREAMBLE HERE, AND SO NO IMPORT-ORDER SUPPRESSION EITHER.
# `tests/conftest.py` puts `src/` on `sys.path` at import time and pytest loads conftest before
# any test module, so the older per-file insert — and the lint suppressions it forced on every
# import under it — bought nothing. If this ever breaks it breaks LOUDLY, with an ImportError.
# ⚠️ And the token itself is deliberately not spelled out anywhere above: the suppression
# ratchet is a TEXTUAL scanner, so a comment boasting about not having one is counted as three
# of them. Caught by that ratchet, which is the ratchet working.
import folders

SRC = Path(__file__).parent.parent / "src"


def _sources():
    return {p: p.read_text(encoding="utf-8", errors="replace") for p in SRC.rglob("*.py")}


def _rekey_scopes():
    """`{scope: [files]}` for every REAL `folders.rekey(...)` call, found by parsing.

    🔴 8.9.14 — PARSED, NOT GREPPED, BECAUSE A COMMENT USED TO SATISFY THIS RATCHET. The old scan
    was a regex over raw file text, so a commented-out call, a call inside a docstring, or an
    example in prose counted as the hook being present. That is the scanner-counts-mentions
    failure, and it is especially bad HERE: this file exists because the same bug shipped three
    times, and every one of those times the thing that failed was PROSE claiming the hook was not
    needed. A ratchet that a comment can satisfy is a ratchet made of the material that already
    failed. `src/folders.py` even contains the literal string `folders.rekey(..., "<scope>", ...)`
    in its own docstring; it survives only because `<scope>` is a placeholder.

    ⚠️ The repo already parses rather than greps in `test_csrf_surface.py` and
    `test_no_shadowed_calls.py`; this is the same technique, not a new one.
    """
    out = {}
    for p, s in _sources().items():
        try:
            tree = ast.parse(s)
        except SyntaxError:                      # not ours to fail on; the lint suite owns that
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if not (isinstance(f, ast.Attribute) and f.attr == "rekey"
                    and isinstance(f.value, ast.Name) and f.value.id == "folders"):
                continue
            for a in node.args:
                if isinstance(a, ast.Constant) and isinstance(a.value, str):
                    out.setdefault(a.value, []).append(str(p.relative_to(SRC)))
    return out


# DOCKER EDITION: `voices_rvc` is still declared in folders.RENAME_MOVES_REF, but its rename route
# (`rename_voice()` on the Training/Voice-Swap voice lists) was excluded with those surfaces, so there is no
# rename path left that could need the hook. It is exempted HERE, by name, and the test after the ratchet
# below fails the moment a rekey call for it appears, which is the signal to remove it from this set.
RENAME_ROUTE_EXCLUDED = {"voices_rvc"}


@pytest.mark.parametrize("scope", [s for s in folders.RENAME_MOVES_REF if s not in RENAME_ROUTE_EXCLUDED])
def test_every_scope_whose_ref_moves_has_a_rekey_call(scope):
    """🔴 THE RATCHET. Declaring a scope unstable and then not carrying its assignment across a
    rename is the whole bug — the row drops out of its folder in silence."""
    hits = _rekey_scopes().get(scope, [])
    assert hits, (
        f"`{scope}` is listed in folders.RENAME_MOVES_REF — its ref MOVES when the item is "
        f"renamed — but nothing in src/ calls `folders.rekey(..., \"{scope}\", ...)`.\n\n"
        f"Without that call the rename leaves the assignment naming a row that no longer exists, "
        f"`for_rows` drops it on the next listing, and the item silently leaves its folder. There "
        f"is no error and no log line; the only tell is that it was filed a moment ago.\n\n"
        f"Either add the call to that scope's rename route, or — better — give the scope an "
        f"IMMUTABLE key so it can leave this tuple altogether (see `voices_tts`)."
    )


def test_a_scope_exempted_for_an_excluded_rename_route_really_has_none():
    """The exemption above is only honest while the rename route it excuses is absent. If a
    `folders.rekey(..., "voices_rvc", ...)` call appears, the route came back and the scope belongs
    in the ratchet again, which this failure tells you."""
    for scope in RENAME_ROUTE_EXCLUDED:
        assert scope in folders.RENAME_MOVES_REF, f"{scope} is no longer declared unstable - drop its exemption"
        assert not _rekey_scopes().get(scope), (
            f"`{scope}` is exempted from the rekey ratchet as an excluded surface but now has a rekey "
            f"call ({_rekey_scopes().get(scope)}); remove it from RENAME_ROUTE_EXCLUDED."
        )


def test_the_star_carries_across_the_same_renames():
    """The sibling store has the identical hazard on the identical routes, and its three call
    sites are what 8.8.6 had to go back and add. Pinned here so the two cannot drift apart:
    a future rename route that remembers one store and forgets the other is the likeliest
    version of this bug's fourth outing."""
    joined = "\n".join(_sources().values())
    for kind in ("SCENE", "PLAYGROUND", "UPLOAD"):
        assert re.search(r"clip_favorites\.rekey\s*\([^)]*clip_sources\." + kind, joined, re.S), (
            f"no `clip_favorites.rekey(..., clip_sources.{kind}, ...)` call in src/ — the star "
            f"for that kind is dropped by a rename, which is the bug 8.8.6 fixed."
        )


def test_a_scope_with_an_immutable_key_is_NOT_in_the_list():
    """📌 The list is a hazard register, not a checklist of scopes. `voices_tts` keys on a filename
    that §14.6 makes immutable for life, so it needs no hook and must not acquire one — the safest
    scope is the one with nothing to remember. If this ever fails, check whether §14.6 still holds
    before adding the hook: the hook would be treating the symptom."""
    assert "voices_tts" not in folders.RENAME_MOVES_REF


def test_every_listed_scope_is_a_real_scope():
    """A typo here would silently exempt the scope it meant to protect — the test above would pass
    for a name nothing uses, and the real scope would go unguarded."""
    unknown = [s for s in folders.RENAME_MOVES_REF if s not in folders.SCOPES]
    assert not unknown, f"not real scopes: {unknown} (folders.SCOPES has {folders.SCOPES})"
