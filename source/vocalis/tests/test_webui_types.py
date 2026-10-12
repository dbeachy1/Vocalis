"""Type-checking ratchets keep declaration shape and suppression growth visible. The suite runs the compiler because the bundler strips JSDoc without checking it; each explicit ceiling only decreases unless a compiler option adds a new error class."""
from __future__ import annotations

import ast
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

ROOT = Path(REPO_ROOT)
TSC = ROOT / "node_modules" / ".bin" / ("tsc.cmd" if shutil.which("cmd") else "tsc")

#: Error and suppression ceilings only decrease as issues are fixed. A compiler-option change may
#: establish a new measured error baseline; ordinary source changes must not raise one.
#:
#: Shared declarations affect diagnostics in every consumer, so settle common types before broad
#: annotation work. Otherwise one interface change shifts error lists across modules and obscures
#: which change introduced each result. Generic helpers such as `filtRows` should preserve the row
#: type for every renderer that uses them.
#:
#: A zero count proves only that the configured checks pass; declarations still need verification
#: against the host runtime. Raising the baseline is justified only when compiler options add a
#: new error class and the new baseline is measured; it must not be used to accept ordinary errors.
TYPE_ERRORS = 0

#: NOCHECK_FILES - files carrying `// @ts-nocheck`. Host declarations model globals supplied by
#: the external runtimes, allowing these files to remain checked without silencing whole modules.
#:
#: Keep this at zero. Add an exclusion only when a file cannot be checked against an available
#: runtime contract; do not use it to clear ordinary type errors.
NOCHECK_FILES = 0

#: PERMISSIVE_DECLS - count of members in types/dom-permissive.d.ts. The ceiling makes additions
#: explicit; prefer a call-site cast when only one operation needs a narrower DOM type.
PERMISSIVE_DECLS = 0

#: PERMISSIVE_FINGERPRINT - the EXACT member list of types/dom-permissive.d.ts, optionality
#: included, as `Interface.name` or `Interface.name?`.
#:
#: Exact member names and optionality catch changes that a count cannot. Keep this tuple empty
#: while dom-permissive.d.ts declares no extra members. Global DOM augmentations affect unrelated
#: objects throughout the application; use a JSDoc cast at the call site that knows the actual
#: element type instead.
PERMISSIVE_FINGERPRINT = ()

#: PERMISSIVE_SHAPE - the DECLARATION HEADS in that file: what each interface EXTENDS, and every
#: type alias it declares. Pinned exactly, like the member list beside it.
#:
#: Pin the full declaration, including its base type and members. Replacing `HTMLElement` with
#: `HTMLInputElement` exposes input-only properties such as `value` and `checked`; aliases can
#: widen the accessible shape too, so they are included.
PERMISSIVE_SHAPE = ("interface VEl extends HTMLElement",)

#: TYPE_ESCAPE_CEILINGS — `any` per declaration file, comments excluded. Reduce these ceilings as
#: escapes are removed.
#:
#: Count escape types across every declaration file used by the application, including host
#: declarations. Otherwise an additional declaration file could bypass the existing ceilings.
#: The host context exposes `name1` and `name2`, not a bare `name`. Declaring the latter would let
#: `ctx().name` type-check even though it is undefined at runtime. Explicit per-file ceilings make
#: every declaration file visible to this ratchet.
#:
#: `any` IS THE ESCAPE HATCH THAT DOES NOT LOOK LIKE ONE. `@ts-ignore` announces itself and is
#: counted by SUPPRESSION_CEILINGS; `any` reads as a type. In a declaration file it is worse than
#: elsewhere, because it is not "I could not work this out" - it is a promise to the checker that
#: this host member may be used any way at all.
#:
#: 🔴 AND THE ASSERTION THAT MATTERS MOST IS THE KEY SET, NOT THE COUNTS. An unrecognized .d.ts
#: fails this test, so every new declaration file must be assigned a ceiling before it is accepted.
#:
#: The 31 in host-sillytavern.d.ts are mostly host shapes nobody can honestly narrow - `chat`,
#: `characters`, `groups`, toastr's options bag, jQuery's setter values. They are priced here so
#: the number is visible and can only fall.
TYPE_ESCAPE_CEILINGS = {
    "dom-permissive.d.ts": 0,
    "host-chrome.d.ts": 0,
    "host-sillytavern.d.ts": 31,
    "st-host/narration-player-bar.d.ts": 0,
    # `getUserAvatars` repaints the persona panel and selects an entry. Keep its stub limited to
    # the function and optional primitive parameters the extension calls; a wider host contract
    # would assert behavior this suite cannot verify.
    "st-host/personas.d.ts": 0,
    # `bustAvatarThumbnails` refreshes an uploaded avatar without a manual reload. Keep its stub to
    # the function and the string arguments the extension uses.
    "st-host/script.d.ts": 0,
    "vocalis.d.ts": 0,
}

#: SUPPRESSION_CEILINGS — counts of check-suppression mechanisms across tracked files. Reduce the
#: ceilings as suppressions are removed.
#:
#: Keys are assembled from fragments so this scanner does not count its own source text.
SUPPRESSION_CEILINGS = {
    # These directives are counted in source, not in prose, so this file cannot inflate its own
    # ceilings by describing the tokens it scans for.
    "@ts-" "ignore": 0,
    "@ts-" "expect-error": 0,
    "@ts-" "nocheck": 0,
    "eslint-" "disable": 1,        # real: src/webui/js/main.js x1
    "# type:" " ignore": 0,
    # Counts reflect tracked source. Add and remove suppressions intentionally; review each
    # category independently so growth in one kind cannot be hidden by reductions in another.
    "# no" "qa": 437,          # total; the per-code split below is the one that actually pins
    # Keep conditional and unconditional skips separate: the shorter `skip` token also occurs
    # inside `skipif`. A conditional skip may represent an absent toolchain; bare `skip` disables
    # a test regardless of the failure being investigated.
    "pytest.mark." "skip": 0,
    # The scanner reads tracked files, so run it after adding new tests. Keep the conditional and
    # unconditional skip counts separate: browser and compiler tests may skip only when their
    # required toolchain is absent, never when an assertion fails.
    "pytest.mark." "skipif": 197,
    "pytest.mark." "xfail": 0,
}

#: LINT_IGNORE_CEILINGS — lint suppressions split by code so one category cannot hide growth in
#: another. The table comments explain the accepted cases for each code.
LINT_IGNORE_CEILINGS = {
    # Broad exception guards are retained only at daemon/thread boundaries where failures must not
    # terminate the worker. Per-satellite batch settings fall back to width one when unavailable.
    "BLE001": 200,
    # E402 suppressions cover imports that must follow sys.path setup for path-loaded modules.
    "E402": 117,
    # F401 suppressions are limited to imports retained for their sys.path side effect.
    "F401": 108,
    "E731": 6,
    "D102": 4,
    "SIM102": 1,
    "PERF203": 1,
}

PERMISSIVE = ROOT / "types" / "dom-permissive.d.ts"
REAL_TYPES = ROOT / "types" / "vocalis.d.ts"

_NO_NODE = shutil.which("node") is None
_NO_TSC = not (ROOT / "node_modules" / "typescript").exists()

#: `path(line,col): error TS1234: message`
_ERROR = re.compile(r"^\S.*?\(\d+,\d+\): error TS\d+:", re.M)


def _tsc() -> subprocess.CompletedProcess:
    return subprocess.run([str(TSC), "--noEmit"], capture_output=True, text=True, cwd=str(ROOT))


def test_the_type_declarations_are_still_there():
    """Deleting the declarations must fail HERE, not by silently un-typing the tree."""
    assert REAL_TYPES.exists(), (
        f"{REAL_TYPES} is gone. It holds the REAL types - HttpError, the window globals "
        "(__uiReady vs __bootDone) and the DOM expando conventions."
    )
    assert PERMISSIVE.exists(), (
        f"{PERMISSIVE} is gone. It holds every deliberate widening, in one file, so the cost is "
        "countable. Deleting it is a milestone (see DESIGN_8_3 section 3), not a cleanup."
    )
    assert (ROOT / "tsconfig.json").exists(), "tsconfig.json is gone - nothing is being checked."


@pytest.mark.skipif(_NO_NODE, reason="node is not on PATH")
@pytest.mark.skipif(_NO_TSC, reason="node_modules/typescript is not installed")
def test_the_type_error_count_has_not_gone_up():
    """Run TypeScript over the web UI, extension, and declaration files. Skip when the optional toolchain is absent, and reject a run that checked no inputs."""
    r = _tsc()
    found = len(_ERROR.findall(r.stdout))
    # Config-level TypeScript errors lack a `path(line,col)` location. Without this check, an
    # empty input set or invalid compiler option could produce zero matched diagnostics and pass.
    unmatched = len(re.findall(r"\berror TS\d+", r.stdout + r.stderr)) - found
    assert unmatched == 0, (
        f"tsc emitted {unmatched} error(s) OUTSIDE the path(line,col) shape - a config-level "
        "failure, meaning some or all of the tree was never type-checked. This gate is vacuous "
        "until that is fixed; it is not a pass.\n\n"
        f"{(r.stdout + r.stderr)[-3000:]}"
    )
    assert found <= TYPE_ERRORS, (
        f"tsc --noEmit reports {found} errors; the ceiling is {TYPE_ERRORS}.\n"
        "\n"
        "  DO NOT RAISE THE CEILING. It is a ratchet - see DESIGN_8_3_JSDOC_TYPES section 6. "
        "A JSDoc annotation is an ordinary comment until this check reads it, so an annotation "
        "added while this is red is prose, not a type.\n"
        "\n"
        f"{r.stdout[-4000:]}"
    )


@pytest.mark.skipif(_NO_NODE, reason="node is not on PATH")
@pytest.mark.skipif(_NO_TSC, reason="node_modules/typescript is not installed")
def test_the_checker_actually_sees_the_tree():
    """Require the TypeScript include globs to resolve to the source corpus.

    The error-count ratchet can pass if the configuration checks no files, so assert the resolved
    file list separately. `--listFilesOnly` verifies inputs without running type checking.
    """
    r = subprocess.run([str(TSC), "--listFilesOnly"], capture_output=True, text=True,
                       cwd=str(ROOT))
    seen = [ln for ln in r.stdout.splitlines() if "/src/webui/js/" in ln.replace("\\", "/")]
    assert len(seen) > 50, (
        f"tsc resolves only {len(seen)} files under src/webui/js (expected the whole ~77-module "
        "tree). The include globs or tsconfig.json are broken, so the error-count ratchet is "
        f"currently green over nothing.\n\n{(r.stdout + r.stderr)[-2000:]}"
    )


@pytest.mark.skipif(_NO_NODE, reason="node is not on PATH")
@pytest.mark.skipif(_NO_TSC, reason="node_modules/typescript is not installed")
def test_the_ratchet_can_actually_fail():
    """Prove the error matcher recognizes a known TypeScript diagnostic.

    If the matcher misses compiler output, the error-count gate can pass without checking the
    actual diagnostic count. A temporary invalid declaration exercises the expected format.
    """
    bad = ROOT / "temp"
    bad.mkdir(exist_ok=True)
    probe = bad / "_type_probe.ts"
    probe.write_text("export const n: number = 'not a number';\n", encoding="utf-8")
    try:
        r = subprocess.run([str(TSC), "--noEmit", "--strict", str(probe)],
                           capture_output=True, text=True, cwd=str(ROOT))
        assert _ERROR.findall(r.stdout), (
            "The error matcher found nothing in tsc output for a file that definitely does not "
            f"type-check. test_the_type_error_count_has_not_gone_up is vacuous.\n\n{r.stdout}"
        )
    finally:
        probe.unlink(missing_ok=True)


def test_the_nocheck_count_has_not_gone_up():
    """Keep whole-file TypeScript opt-outs visible and at or below their ceiling.

    The scan covers the whole file because TypeScript honors this directive anywhere before the
    first statement. Silencing a file can lower the compiler-error count, so this ratchet guards
    that separate escape path.
    """
    marked = sorted(
        p.relative_to(ROOT).as_posix()
        for p in list(ROOT.glob("src/webui/**/*.js"))
        + list(ROOT.glob("sillytavern/extension/*.js"))
        + list(ROOT.glob("nomi/chrome_extension/*.js"))
        if "bundle" not in p.parts and "@ts-nocheck" in p.read_text(encoding="utf-8", errors="ignore")
    )
    assert len(marked) <= NOCHECK_FILES, (
        f"{len(marked)} files carry @ts-nocheck; the ceiling is {NOCHECK_FILES}.\n"
        "\n"
        "  Silencing a whole file to clear a red run is the ratchet running backward. The count "
        "is the honest progress metric for this milestone (DESIGN_8_3 section 6) and must only "
        "go down.\n"
        "\n  " + "\n  ".join(marked)
    )


def test_the_deliberate_widening_has_not_grown():
    """Pin the exact widened member shape, including optionality. A member count cannot detect a stronger declaration that removes a required `?`."""
    members = _permissive_members()
    added = sorted(set(members) - set(PERMISSIVE_FINGERPRINT))

    assert not added, (
        "types/dom-permissive.d.ts declares members that are not in the pinned fingerprint:\n"
        "\n  " + "\n  ".join(added) + "\n"
        "\n"
        "  Every entry in that file is a type that LIES about the DOM. Widening one more\n"
        "  interface - or making an existing widening STRONGER by dropping its `?` - is the\n"
        "  easiest way to clear any error and the easiest way to switch the type system off by\n"
        "  degrees.\n"
        "\n"
        "  The honest fix is a JSDoc cast at the one call site that knows the real element type.\n"
        "  It is a comment and a pair of parens, and it changes nothing at runtime.\n"
        "\n"
        "  If the new member is genuinely earned, add it to PERMISSIVE_FINGERPRINT in the same\n"
        "  commit that argues for it."
    )

    assert len(members) <= PERMISSIVE_DECLS, (
        f"types/dom-permissive.d.ts declares {len(members)} members; the ceiling is "
        f"{PERMISSIVE_DECLS}."
    )


def _decl_source(path):
    """Return declaration text without comments so prose cannot affect shape counts.

    A member name or `any` mentioned in a comment is not part of the declaration.
    """
    txt = re.sub(r"/\*.*?\*/", " ", Path(path).read_text(encoding="utf-8"), flags=re.S)
    return re.sub(r"//[^\n]*", " ", txt)


def _permissive_source():
    """dom-permissive.d.ts, comments stripped."""
    return _decl_source(PERMISSIVE)


def test_no_uncounted_escape_hatches_in_ANY_declaration_file():
    """Require each declaration file, including host stubs, to have an explicit escape ceiling.

    Checking the key set prevents a new declaration file from arriving without being counted.
    """
    types_dir = ROOT / "types"
    found = {}
    for f in sorted(types_dir.rglob("*.d.ts")):
        rel = f.relative_to(types_dir).as_posix()
        found[rel] = len(re.findall(r"\bany\b", _decl_source(f)))

    unknown = sorted(set(found) - set(TYPE_ESCAPE_CEILINGS))
    assert not unknown, (
        "declaration files that no ratchet knows about: %s\n" % unknown +
        "\n"
        "  Every .d.ts is an ASSERTION about a runtime, and a wrong one does not merely fail to\n"
        "  help - it turns a real crash into a silent pass. That is how `name: string` reached\n"
        "  types/host-sillytavern.d.ts: the file arrived with nothing counting it.\n"
        "\n"
        "  Add it to TYPE_ESCAPE_CEILINGS with its measured `any` count, in the commit that adds\n"
        "  the file."
    )
    gone = sorted(set(TYPE_ESCAPE_CEILINGS) - set(found))
    assert not gone, (
        "TYPE_ESCAPE_CEILINGS names declaration files that no longer exist: %s - drop the "
        "entries, so the pin keeps describing the tree." % gone
    )

    over = {k: (v, TYPE_ESCAPE_CEILINGS[k]) for k, v in found.items()
            if v > TYPE_ESCAPE_CEILINGS[k]}
    assert not over, (
        "more `any` in a declaration file than is pinned (found, ceiling): %s\n" % over +
        "\n"
        "  `any` is the escape hatch that does not look like one: `@ts-ignore` announces itself\n"
        "  and is counted next door, while `any` reads as a type. In a .d.ts it is a promise to\n"
        "  the checker that a host member may be used any way at all.\n"
        "\n"
        "  If it is genuinely unknowable - a host's chat array, a toastr options bag - raise the\n"
        "  ceiling in the same commit and say why. If it is merely unknown, `unknown` costs one\n"
        "  cast at the call site and keeps the check."
    )


def _permissive_shape():
    """Every declaration HEAD in that file: `interface X extends Y`, plus every `type X = ...`.

    The base type and aliases can expose members without adding them to the interface body. See
    PERMISSIVE_SHAPE.
    """
    txt, out = _permissive_source(), []
    for m in re.finditer(r"\binterface\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([^{]+?))?\s*\{", txt):
        out.append("interface %s extends %s" % (m.group(1), " ".join((m.group(2) or "nothing").split())))
    for m in re.finditer(r"\btype\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);", txt):
        out.append("type %s = %s" % (m.group(1), " ".join(m.group(2).split())))
    return sorted(out)


def _permissive_members():
    """Every member declared in dom-permissive.d.ts, as `Interface.name` / `Interface.name?`.

    The `?` is part of the identity. Brace-aware scanning counts members even when an interface is
    written on one line.
    """
    txt, out = _permissive_source(), []
    for m in re.finditer(r"\binterface\s+([A-Za-z_$][\w$]*)[^{]*\{", txt):
        iface, i, depth = m.group(1), m.end(), 1
        while i < len(txt) and depth:
            depth += (txt[i] == "{") - (txt[i] == "}")
            i += 1
        for mm in re.finditer(r"(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)(\??)\s*[:(]", txt[m.end():i - 1]):
            out.append("%s.%s%s" % (iface, mm.group(1), mm.group(2)))
    return sorted(out)


def test_the_widening_cannot_come_back_through_the_BASE_TYPE():
    """Ensure `VEl` cannot regain DOM properties by extending a permissive base interface. The probe checks inherited shape directly because a member-count ratchet alone would miss this bypass."""
    shape = _permissive_shape()
    assert shape == list(PERMISSIVE_SHAPE), (
        "the declaration heads in types/dom-permissive.d.ts have changed:\n"
        "\n  pinned: %s\n  found:  %s\n" % (list(PERMISSIVE_SHAPE), shape) +
        "\n"
        "  Widening the BASE type is the cheapest way to switch this project's type checking\n"
        "  off: `extends HTMLInputElement` alone hands `.value`, `.checked`, `.files` and\n"
        "  `.disabled` back to every `$()` result in the app, and no other gate here sees it.\n"
        "\n"
        "  The honest fix is a JSDoc cast at the call site that knows the real element type.\n"
        "  If a new base or alias is genuinely earned, change PERMISSIVE_SHAPE in the same\n"
        "  commit that argues for it."
    )


def test_every_module_that_calls_dollar_imports_it():
    """Require each module that calls `$` to import the Vocalis DOM helper. Otherwise the ambient SillyTavern declaration can silently resolve the name to jQuery and accept the wrong API."""
    dom = "src/webui/js/util/dom.js"
    call = re.compile(r"(?<![A-Za-z0-9_$.])\$\(")
    imported = re.compile(r"^\s*import\s*\{[^}]*(?<![A-Za-z0-9_$])\$(?![A-Za-z0-9_$])[^}]*\}", re.M)

    missing = []
    for f in sorted((ROOT / "src" / "webui" / "js").rglob("*.js")):
        rel = f.relative_to(ROOT).as_posix()
        if rel == dom:
            continue
        text = f.read_text(encoding="utf-8")
        # comments stripped: `$('x')` quoted in prose is not a call
        code = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
        code = re.sub(r"//[^\n]*", " ", code)
        if call.search(code) and not imported.search(text):
            missing.append(rel)

    assert not missing, (
        "these modules call `$()` without importing it, so the name resolves to the ambient\n"
        "jQuery `$` declared for the SillyTavern extension instead:\n\n  "
        + "\n  ".join(missing)
        + "\n\n  jQuery's `$` takes a SELECTOR and returns a collection, so `$('someId')` finds\n"
        "  nothing and every property write on it is silently discarded — and it type-checks.\n"
        "  Add `import { $ } from '<relative>/util/dom.js';`."
    )


def _noqa_rows(text: str):
    """Row numbers carrying a REAL suppression directive, via `tokenize`.

    🔴 **A DIRECTIVE, NOT A MENTION — the rule this file already applies to `@ts-*`, extended to
    Python.** Ruff honors the marker only in a comment that TRAILS the offending code, so a
    whole-line comment discussing one, or a copy quoted inside a docstring, suppresses nothing.
    A raw text scan cannot distinguish a real directive from a mention in prose, so the scanner
    must inspect Python comment tokens that trail code.

    ⚠️ `tokenize` rather than a cleverer regex: a COMMENT token is a comment and a string token is
    a string, with no ambiguity left to get wrong. A file that will not tokenize returns None so
    the caller falls back to counting everything — a parse failure that scored 0 would read as
    "no suppressions here", which is the same vacuity in a new place.
    """
    import io
    import tokenize

    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError, ValueError):
        return None

    structural = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE,
                  tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER}
    code_rows = {t.start[0] for t in toks if t.type not in structural}
    return {t.start[0] for t in toks
            if t.type == tokenize.COMMENT and t.start[0] in code_rows}


def test_the_noqa_scan_counts_directives_and_not_mentions():
    """Check both sides of the directive distinction on one synthetic Python source.

    A real trailing directive must count; a whole-line comment, docstring copy, and plain string
    must not. This keeps prose mentions out of suppression totals.
    """
    marker = chr(35) + ' no' + 'qa: BLE001'
    lines = [
        'x = 1  ' + marker,                      # a REAL directive, trailing code
        '    ' + marker,                         # a whole-line comment: not a directive
        'def f():',
        '    ' + chr(34) * 3 + 'docs mentioning ' + marker + chr(34) * 3,
        '    return ' + repr(marker),            # the same text inside a string
    ]
    text = chr(10).join(lines) + chr(10)

    rows = _noqa_rows(text)
    assert rows is not None, 'the fixture did not tokenize - the test proves nothing'
    assert rows == {1}, (
        f'expected only line 1 to carry a directive, got {sorted(rows)}. If this is EMPTY the scanner has gone blind and every ratchet built on it is now decorative.'
    )

    counted = [i for i, _ in enumerate(lines, 1) if i in rows]
    assert counted == [1], counted

def test_no_new_suppressions_anywhere_in_the_tree():
    """🔴 THE TREE-WIDE SUPPRESSION RATCHET. Every way to switch a check off, counted and pinned.

    A gate is only as good as the cost of turning it off, and every mechanism for turning one off
    is a single token that fits on the end of the line it silences. Each is individually
    defensible, which is precisely how a tree ends up carrying hundreds of them. This test makes
    the total visible and monotonic: it may fall, never rise.

    ⚠️ ADDING ONE IS NOT FORBIDDEN, IT IS PRICED. If a suppression is genuinely earned, raise its
    number in SUPPRESSION_CEILINGS in the same commit and say why in the message. What is
    forbidden is adding one QUIETLY - and what is forbidden absolutely is OFFERING one as an
    alternative to doing the work.

    📌 Companion to the fingerprint test above: that one guards lies about TYPES, this one guards
    every other flavor of "make the warning stop".
    """
    counts = {token: 0 for token in SUPPRESSION_CEILINGS}
    offenders = {token: [] for token in SUPPRESSION_CEILINGS}

    # 🔴 A DIRECTIVE, NOT A MENTION. `@ts-nocheck` only does anything as the first thing in a
    # comment in a JS/TS file; written in a sentence it is just the name of the thing. Counting
    # occurrences conflated the two, and since the file that discusses suppressions most is this
    # one, the ratchet was buying its own allowance with its own prose.
    TS_DIRECTIVES = ("@ts-" "ignore", "@ts-" "expect-error", "@ts-" "nocheck")
    # `skip` must not match inside `skipif` - the whole point of separating them above.
    WORD_EXACT = ("pytest.mark." "skip",)

    for path in _tracked_source_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for token in SUPPRESSION_CEILINGS:
            if token in TS_DIRECTIVES:
                if path.suffix not in (".js", ".mjs", ".ts"):
                    continue
                n = len(re.findall(r"(?://|/\*+)\s*" + re.escape(token), text))
            elif token in WORD_EXACT:
                n = len(re.findall(re.escape(token) + r"\b", text))
            elif token == "# no" "qa" and path.suffix == ".py":
                # Same directive-not-mention rule as the per-code ratchet below.
                rows = _noqa_rows(text)
                n = sum(1 for m in re.finditer(re.escape(token), text)
                        if rows is None or text.count("\n", 0, m.start()) + 1 in rows)
            else:
                n = text.count(token)
            if n:
                counts[token] += n
                offenders[token].append(f"{path.relative_to(ROOT).as_posix()} x{n}")

    risen = {t: (counts[t], c) for t, c in SUPPRESSION_CEILINGS.items() if counts[t] > c}
    assert not risen, (
        "the suppression ratchet ran BACKWARD:\n"
        + "\n".join(
            f"  {t!r}: {found} found, ceiling {ceiling}\n    " + "\n    ".join(offenders[t])
            for t, (found, ceiling) in sorted(risen.items())
        )
        + "\n"
        "\n  Each of these switches a check OFF. Fix the underlying error instead. If the"
        "\n  suppression is genuinely earned, raise its ceiling in this file in the same commit"
        "\n  and say why."
    )


def _tracked_source_files():
    """Return tracked and unignored untracked source files for the suppression scan.

    Including untracked files ensures a newly created test is counted before it is staged.
    Standard ignored trees are excluded; the explicit directory list also omits the generated
    bundle and common environment/temp paths.
    """
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    skip_dirs = ("venv/", "node_modules/", "temp/", "src/webui/bundle/")
    keep_ext = (".py", ".js", ".mjs", ".ts", ".json", ".yaml", ".yml", ".cfg", ".ini")
    for line in listed.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith(skip_dirs) or not line.endswith(keep_ext):
            continue
        path = ROOT / line
        if path.is_file():
            yield path


def test_no_lint_ignore_code_has_grown():
    """Each lint-ignore CODE is pinned separately, because they are not interchangeable.

    A total can hide replacing one suppression with another. Per-code ceilings keep those changes
    visible while the table comments explain the accepted cases.
    """
    import collections

    found = collections.Counter()
    where = collections.defaultdict(list)
    for path in _tracked_source_files():
        if path.suffix != ".py":
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rows = _noqa_rows(text)
        for m in re.finditer(r"#\s*no" r"qa:\s*([A-Z]+[0-9]*)", text):
            # Only where a real directive lives. `rows is None` means the file would not
            # tokenize, and then every match counts - erring toward OVER-counting, because a
            # ratchet that under-counts is one that has quietly stopped working.
            if rows is not None and text.count("\n", 0, m.start()) + 1 not in rows:
                continue
            code = m.group(1)
            found[code] += 1
            where[code].append(path.relative_to(ROOT).as_posix())

    risen = {c: (n, LINT_IGNORE_CEILINGS.get(c, 0))
             for c, n in found.items() if n > LINT_IGNORE_CEILINGS.get(c, 0)}
    assert not risen, (
        "a lint-ignore code has grown past its ceiling:\n"
        + "\n".join(
            f"  {c}: {n} found, ceiling {ceil}  ({len(set(where[c]))} file(s))"
            for c, (n, ceil) in sorted(risen.items())
        )
        + "\n\n  These codes are not interchangeable, which is why they are pinned separately.\n"
        "  BLE001 in particular is the only one that can hide a real failure rather than a style\n"
        "  preference - if it is the one that climbed, read the diff before raising the number."
    )


@pytest.mark.skipif(_NO_NODE, reason="node is not on PATH")
@pytest.mark.skipif(_NO_TSC, reason="node_modules/typescript is not installed")
def test_the_dollar_helper_is_still_honestly_nullable():
    """Verify callers account for `$()` and `wbEl()` returning null. Restoring a non-null annotation would erase caller obligations and could lower every count without fixing the contract."""
    bad = ROOT / "temp"
    bad.mkdir(exist_ok=True)
    probe = bad / "_dollar_probe.js"
    probe.write_text(
        "// @ts-check\n"
        "import { $, wbEl } from '../src/webui/js/util/dom.js';\n"
        "/** @type {HTMLElement} */ export const a = $('x');\n"
        "/** @type {HTMLElement} */ export const b = wbEl('cards', 'y');\n",
        encoding="utf-8",
    )
    try:
        # the project's own declarations come along, or `VEl` is an unknown name and the
        # probe fails for a reason that has nothing to do with nullability
        decls = [str(d) for d in sorted((ROOT / "types").rglob("*.d.ts"))]
        r = subprocess.run(
            [str(TSC), "--noEmit", "--strict", "--allowJs", "--checkJs", "--target", "es2022",
             "--module", "es2022", "--moduleResolution", "bundler", *decls, str(probe)],
            capture_output=True, text=True, cwd=str(ROOT),
        )
        # only diagnostics located IN the probe count - an error inside dom.js would mean the
        # helper is broken, not that it is honest, and must never read as a pass
        mine = [ln for ln in r.stdout.splitlines() if "_dollar_probe" in ln]
        # THE CODE AND THE LINE, NOT THE COUNT. This used to accept any two diagnostics that
        # merely MENTIONED the probe - so renaming or moving the `$` export turned the two
        # nullability errors into two `TS2305: has no exported member` errors and the test went
        # on passing, while the helper it is named for was free to claim it cannot return null.
        # A guard that cannot say WHY it is satisfied is one rename away from measuring nothing.
        bogus = [ln for ln in mine if "TS2322" not in ln]
        assert not bogus, (
            "the nullability probe failed for a reason that is not nullability, so it proves "
            "nothing about `$`/`wbEl`. Most likely an export was renamed or moved:\n  "
            + "\n  ".join(bogus)
        )
        flagged = {int(m.group(1)) for ln in mine
                   for m in [re.search(r"\((\d+),\d+\)", ln)] if m}
        assert {3, 4} <= flagged, (
            "A non-null slot accepted the result of `$()` and/or `wbEl()`, so at least one of "
            "them has gone back to claiming it cannot return null. That silently drops the "
            "nullability obligation from every call site 8.8-m10 made honest. Restore "
            "`@returns {VEl|null}` in src/webui/js/util/dom.js -- and change the cast on the "
            "function body too, because the JSDoc is what callers see. Probe line 3 is `$` and "
            "line 4 is `wbEl`; BOTH must be rejected, and this run flagged "
            + str(sorted(flagged)) + ". tsc said: " + r.stdout
        )
    finally:
        probe.unlink(missing_ok=True)


#: Tests that walk the WHOLE repository rather than one feature, keyed by the thing they do that
#: makes them whole-tree. A file doing any of these is a gate by construction.
_WHOLE_TREE_IDIOMS = ("ls-files", "checkout-index")

#: 🔴 DELIBERATELY OUT, AND THE REASON IS PART OF THE GUARD. `test_server_starts.py` reads
#: `VERSION` like the extension stamp does, but it BOOTS THE REAL SERVER in a subprocess to do it.
#: That is a smoke test, not a static invariant, and it is slow — putting it in the 14-second group
#: would make the group something people stop running. Named here rather than silently skipped so
#: the next person can disagree with the call instead of wondering whether it was noticed.
_NOT_A_GATE = frozenset({"test_server_starts.py"})


def _code_strings(tree):
    """Every string literal in `tree` EXCEPT docstrings.

    🔴 THIS IS THE WHOLE REASON THIS CENSUS IS AN AST WALK AND NOT A GREP, and the trap is one this
    file has already been bitten by: `test_no_new_suppressions_anywhere_in_the_tree` counted
    `@ts-nocheck` textually and ended up buying its own allowance with its own prose, because the
    file that discusses a thing most is the file policing it. The module you are reading names
    every idiom below in its own comments, and a comment is not in the AST at all — so comments are
    free, and a docstring that quotes `git ls-files` is skipped explicitly.
    """
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", None)
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)                     and isinstance(body[0].value.value, str):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            yield node.value


def test_every_whole_tree_scanner_is_registered_as_a_gate():
    """Register every whole-tree invariant scanner in `conftest.GATE_FILES` so the gates selection runs it directly instead of relying on the full suite."""
    from conftest import GATE_FILES

    unregistered = {}
    for path in sorted(Path(__file__).parent.glob("test_*.py")):
        if path.name in GATE_FILES or path.name in _NOT_A_GATE:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:                                  # pragma: no cover - not this test's job
            continue
        hits = sorted({idiom for text in _code_strings(tree) for idiom in _WHOLE_TREE_IDIOMS
                       if idiom in text})
        if hits:
            unregistered[path.name] = hits

    lines = [f"  {name}: {', '.join(hits)}" for name, hits in sorted(unregistered.items())]
    assert not unregistered, "\n".join([
        "these tests walk the whole repository but are not in conftest.GATE_FILES, so",
        "`pytest -m gates` does not run them:",
        *lines,
        "",
        "  A whole-tree scanner outside the gates group is one that gets found by a four-minute",
        "  full suite instead of a fourteen-second one. Add it to GATE_FILES, or to _NOT_A_GATE",
        "  in this file with the reason.",
    ])
