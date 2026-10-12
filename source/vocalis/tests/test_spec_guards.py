"""Every browser spec run must assert that it RAN TO THE END. Asserted, not hoped for.

`assert r.returncode == 0` cannot tell a pass from a spec that stopped checking. A spec that returns
early, loses a selector rename, or has a block deleted **exits 0 and is merely SHORTER** — and until
9.0.12 nineteen wrappers in this tree asserted nothing else, against specs making up to 412
assertions. `test_ace_folders_browser.py` had said so in its own words for months without the point
spreading, because naming assertions by hand is a bookkeeping chore nobody repeats.

`conftest.assert_spec_ran` makes it one call. This file is what stops the next wrapper forgetting.

🔴 **WHY A META-TEST AND NOT A ONE-OFF SWEEP.** The gap recurred THREE TIMES in a single night, and
every instance was in a file that LOOKED covered:

  · `test_strip_fallback_browser.py` — two tests running the spec in two argv MODES (`refused`,
    `stalled`), with the guard on the first only. The second could stop checking silently.
  · `test_ace_draft_persistence_browser.py` — a second test running the same spec against a second
    fixture, unguarded, while the first test's guard made the file read as done.
  · `test_st_doorbell_reopen.py` / `test_st_push_boundary.py` — no `from conftest import` line to
    widen, so THREE separate mechanical sweeps skipped them and moved on.

Each was found by accident or by a throwaway script. A fix that depends on someone re-running a
scratch script is not a fix; the property itself is what has to be checked.
"""
from __future__ import annotations

import ast
import pathlib
import re

# ⚠️ NO `# noqa: F401`: REPO_ROOT is USED below. The neighboring wrappers carry one because
# their import exists only for the sys.path side effect and is never referenced - I copied the
# suppression from them without checking whether the reason held, which is the same mistake
# this tree's noqa ratchet caught two hours ago and which I had already written a comment
# about in two other files.
from conftest import REPO_ROOT

#: Wrappers whose `returncode` references legitimately outnumber their guards, each with its reason.
#:
#: 🔴 NAMED, NEVER PATTERN-MATCHED AWAY. A rule loose enough to excuse these automatically would
#: also excuse the three real gaps above — which is precisely how a guard becomes decoration. An
#: exemption costs a line here and a sentence saying why, and that is the right price for it.
# \U0001f4cc THERE IS NO SELF-EXEMPTION HERE ANY MORE, AND ITS REMOVAL WAS FORCED BY THE HYGIENE TEST
# BELOW. This file needed one while `_runs_a_spec` pattern-matched filenames: its own AST-walking
# code contains the literal string 'returncode', so it reported itself. Once the subject was
# redefined as "scripts that actually report assertions" - read from the script, not guessed from
# its name - this file stopped qualifying and the exemption went stale.
# `test_the_exemptions_still_exist_and_still_run_a_spec` caught that on its first run, which is
# exactly the hole it exists for: a stale exemption silently pre-approves the next spec run added
# to the file it names.
_GUARD_EXEMPT = {
    # Retries its spec up to `_ATTEMPTS` times and keeps every attempt, so `returncode` appears once
    # in the retry loop and once in the final assertion. Its guard sits on `attempts[-1]` on
    # purpose: asserting per-reference would assert against a FAILED attempt that a later one
    # superseded, i.e. it would report a red for a run that succeeded.
    "test_ui_font_browser.py",
}


#: What a reporting script prints per assertion. The one property this guard depends on.
_OK_LINE = "ok   "


def _reporting_scripts(src: str, tests_dir: Path) -> list[str]:
    """The `.mjs` files a wrapper runs that actually REPORT assertions.

    🔴 SUBJECT DEFINED BY BEHAVIOR, NOT BY FILENAME. The first cut of this test matched any
    wrapper mentioning `_spec.mjs` or `_smoke.mjs` and flagged `test_page_assembly.py`, which runs
    `_websrc.mjs` — a source extractor that prints no assertions. A floor there would be a claim
    about a script that reports nothing.

    ⚠️ AND THE `*_smoke.mjs` FILES ARE IN SCOPE, deliberately. It would have been convenient to
    call them "not browser specs" and exempt eight files; their output is identical, they can stop
    checking early exactly the same way, and the distinction does not exist where this guard works.
    """
    import pathlib

    out = []
    for name in re.findall(r'Path\(__file__\)\.parent\s*/\s*"([^"]+\.mjs)"', src):
        script = tests_dir / name
        if script.exists() and _OK_LINE in script.read_text(encoding="utf-8-sig", errors="replace"):
            out.append(name)
    for name in re.findall(r'SPEC\s*=\s*Path\(__file__\)\.parent\s*/\s*"([^"]+\.mjs)"', src):
        script = tests_dir / name
        if script.exists() and _OK_LINE in script.read_text(encoding="utf-8-sig", errors="replace"):
            out.append(name)
    return out


#: 🔴 HOW MANY FILES ARE EXCUSED, PINNED. This is the one-line escape from the test below: add a
#: name here and a whole wrapper stops being checked, with a diff that reads as ordinary and a
#: hygiene test that passes because the name refers to something real. The escape stays available -
#: sometimes it is right, as `test_ui_font_browser` is - but taking it means editing a number that
#: counts how many times it has been taken. Same shape as this tree's `# noqa` ceiling and the page
#: line ceiling: visible in review, impossible to do absent-mindedly.
#: ⚠️ RAISE IT ONLY WITH THE REASON IN THE SET ABOVE, never to make a red go away.
_MAX_EXEMPTIONS = 1


def test_the_exemption_list_has_not_grown():
    """A count ratchet on the escape hatch itself.

    🔴 EVERY OTHER CHECK IN THIS FILE DEFENDS AGAINST FORGETTING - a wrapper that never got a
    floor, a spec that stops checking, an exemption gone stale. This one defends against GIVING UP,
    which is the failure that actually happens at 2am: the check is inconvenient, and there is a
    one-line edit that makes it stop failing without fixing anything.

    📌 The test for whether a guard needs one of these: *is there a one-character edit that makes
    it stop failing without fixing anything?* Drop a floor to 0. Add a `# noqa`. Add a name here.
    Find that edit and make it fail.
    """
    assert len(_GUARD_EXEMPT) <= _MAX_EXEMPTIONS, (
        f"the spec-guard exemption list grew to {len(_GUARD_EXEMPT)} (ceiling {_MAX_EXEMPTIONS}): "
        f"{sorted(_GUARD_EXEMPT)}.\n"
        "  An exemption means a wrapper's spec runs are no longer checked at all. If it is right, "
        "raise the ceiling deliberately and say why in the set. If it is a red you are trying to "
        "silence, the fix is a floor on that wrapper instead."
    )


def _runs_a_spec(src: str) -> bool:
    return bool(_reporting_scripts(src, REPO_ROOT / "tests"))


def test_every_browser_spec_run_asserts_that_it_ran_to_the_end():
    """One `assert_spec_ran` per spec run, in every wrapper.

    ⚠️ COUNTED PER TEST FUNCTION, not per file. A file with two tests and one guard is the exact
    shape that shipped twice tonight: the guarded test makes the file look after the unguarded
    one's reputation, and the total-per-file reads as covered.
    """
    offenders = []
    for path in sorted((REPO_ROOT / "tests").glob("test_*.py")):
        if path.name in _GUARD_EXEMPT:
            continue
        # \U0001f534 `utf-8-sig`, NOT `utf-8`. `tests/test_streaming.py` carries a UTF-8 BOM; pytest
        # reads it happily but `ast.parse` rejects U+FEFF outright, so a plain read would make this
        # test die with "invalid non-printable character" - a message about nothing to do with the
        # guard. It passes today only because that file runs no reporting script and is filtered out
        # first; adding one would have detonated it. `utf-8-sig` strips a BOM when present and is a
        # no-op when it is not.
        src = path.read_text(encoding="utf-8-sig")
        if not _runs_a_spec(src):
            continue
        # \u26a0\ufe0f A FILE THAT WILL NOT PARSE IS REPORTED, NEVER SKIPPED. A try/except that passed over
        # it would drop a wrapper out of the census silently - which is the exact failure mode this
        # test exists to catch, reintroduced inside the test itself.
        try:
            tree = ast.parse(src)
        except SyntaxError as exc:
            offenders.append(f"{path.name} could not be parsed, so its spec runs are unchecked: {exc}")
            continue
        for fn in [n for n in ast.walk(tree)
                   if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                   and n.name.startswith("test_")]:
            runs = ast.dump(fn).count("'returncode'")
            guards = sum(1 for n in ast.walk(fn)
                         if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "assert_spec_ran")
            if runs and guards < runs:
                offenders.append(f"{path.name}::{fn.name} runs a spec {runs}x but guards {guards}")

    assert not offenders, (
        "a browser spec is run without asserting that it ran to the end:\n  "
        + "\n  ".join(offenders)
        + "\n\n  Add assert_spec_ran(r, SPEC) after the returncode assertion.\n"
          "  Pass an explicit MEASURED floor= when conftest's derivation refuses - never a guessed\n"
          "  one, and never a number read off one good run if the spec gates assertions on RUNTIME\n"
          "  state: the floor must hold on the worst run, not the one you watched."
    )


def test_the_exemptions_still_exist_and_still_run_a_spec():
    """🔴 AN EXEMPTION FOR A FILE THAT NO LONGER EXISTS IS A HOLE NOBODY CAN SEE.

    Renaming or deleting an exempted wrapper would leave a stale name in `_GUARD_EXEMPT` that
    silently excuses nothing — harmless — but a file that stops running a spec and keeps its
    exemption is worse: the next person to add a spec run to it inherits a pass. Both are caught by
    asserting the exemption is still about a real wrapper that still runs a spec.
    """
    for name in sorted(_GUARD_EXEMPT):
        p = REPO_ROOT / "tests" / name
        assert p.exists(), f"_GUARD_EXEMPT names {name}, which does not exist - drop the entry"
        assert _runs_a_spec(p.read_text(encoding="utf-8-sig")), (
            f"_GUARD_EXEMPT still excuses {name}, but it no longer runs a browser spec - drop the "
            f"entry so the next spec run added there is guarded like everywhere else")


# ── the wait helper is copied 47 times, so its shape is pinned (9.0 review) ───

_SPECS = sorted((pathlib.Path(REPO_ROOT) / "tests").glob("*_spec.mjs")) + sorted((pathlib.Path(REPO_ROOT) / "tests").glob("*_smoke.mjs"))


def _wait_bodies():
    """Every `waitFor` definition in tests/, as (path, body)."""
    out = []
    for p in _SPECS:
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r"async function waitFor\([^)]*\)\s*\{", text):
            depth, i = 0, m.end() - 1
            while i < len(text):
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            out.append((p, text[m.start():i + 1]))
    return out


def _poll_is_guarded(body: str) -> bool:
    """Is the POLL itself inside a try/catch — not merely somewhere in the same function?

    🔴 THE FIRST VERSION OF THIS GUARD ASKED `"try {" in body`, AND IT COULD NOT FAIL.
    Every copy of `waitFor` already contains a `try` in its give-up diagnostic, where it reads
    `document.readyState` to report what the page was doing. So the check was satisfied by a block
    that runs only AFTER the wait has already timed out — precisely the wrong one — and a copy
    drifted back to the racy body sailed through it. Caught by mutation, which is the only thing
    that catches this class: the assertion read exactly as reasonably as a working one.
    """
    lines = body.splitlines()
    poll = next((i for i, ln in enumerate(lines)
                 if "evaluate(cdp" in ln and "Promise.resolve(" in ln), None)
    if poll is None:
        return False
    if ".catch(" in lines[poll]:
        return True
    # Walk back over comments and blank lines to the previous line of actual code.
    j = poll - 1
    while j >= 0 and (not lines[j].strip() or lines[j].strip().startswith(("//", "*", "/*"))):
        j -= 1
    return j >= 0 and lines[j].strip() == "try {"


def test_every_waitFor_treats_a_page_exception_as_not_yet():
    """🔴 A WAIT WHOSE POLL CAN THROW IS A RACE, NOT A WAIT.

    `evaluate` raises on `exceptionDetails`, so a poll landing mid-repaint — while the very
    repaint the spec is waiting for is in progress — propagates out of `waitFor` and kills the
    spec. It presents as an environment flake: green on a quick machine, red under a loaded suite.

    🔴 **AND THE REAL DEFECT IS THAT THERE ARE 47 COPIES OF THIS FUNCTION.** Both fixes it has
    needed — `Promise.resolve(...)` instead of `!!(...)`, and this guard — had to be applied by
    hand to every copy, and the copies that miss are always the newest files, written from an
    older body. Four 9.0 specs shipped racy for exactly that reason. Nothing pinned the shape, so
    nothing said. This is that pin: it does not deduplicate the helper, but it makes a copy that
    drifts fail loudly instead of intermittently.
    """
    bodies = _wait_bodies()
    assert len(bodies) >= 40, f"only found {len(bodies)} waitFor definitions - has the scan broken?"
    racy = [p.name for p, b in bodies if not _poll_is_guarded(b)]
    assert not racy, (
        f"{len(racy)} spec(s) poll without treating a page exception as 'not yet', so a poll "
        f"during the repaint they are waiting for kills them: {racy}"
    )


def test_every_waitFor_awaits_the_expressions_value_rather_than_the_promise():
    """`!!aPromise` is synchronously true whatever it resolves to, so a wait on any
    `fetch(...).then(...)` returns on its first poll and waits for nothing — and it fails as a
    PASS, which is why it survived so long. Pinned here for the same reason as above: 47 copies."""
    bad = [p.name for p, b in _wait_bodies()
           if "Promise.resolve(" not in b and re.search(r"!!\(\$\{", b)]
    assert not bad, f"{len(bad)} spec(s) test the truthiness of a promise instead of its value: {bad}"
