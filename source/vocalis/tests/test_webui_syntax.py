"""Static checks parse the page and its inline fragments without launching the application. They guard against malformed markup and script that would prevent the UI from loading."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import paths

#: A block carrying an unsubstituted Jinja/format placeholder is not JavaScript yet.
TEMPLATE_MARKERS = ("{{UI_STATE}}",)

#: Inline `<script>` only — anything with a `src=` is a separate file with its own life.
_INLINE = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.S)


def _blocks() -> list[str]:
    html = (paths.WEBUI / "index.html").read_text(encoding="utf-8")
    return _INLINE.findall(html)


def test_the_page_still_carries_the_pre_paint_blocks_this_file_checks():
    """A guard on the guard — and the third version of it, which is the interesting part.

    🔴 IT WENT RED AT m13 EXACTLY AS DESIGNED, AND ITS OWN MESSAGE SAID WHAT TO DO. The check was
    `sizes[0] > 10 * median` — "the main inline script is dominant" — with the note:

        ⚠️ WHEN m13 DELETES THE INLINE SCRIPT THIS SHOULD GO RED, LOUDLY, and the fix is to rewrite
        this file against `src/webui/js/**` — which is what the docstring above has always said.

    It reported `block sizes [780, 223, 181], median 223`, which is three pre-paint stubs and no
    application script. ✅ **A check that predicts its own obsolescence, names the successor, and
    then fires on schedule is the only kind that can be retired safely** — compare §11.26's family,
    where five pins went red on healthy commits saying nothing useful about why.

    📌 THE SUBJECT MOVED, THE FILE DID NOT. What this file protects is unchanged: *a parse error in
    front-end code takes the whole page down and blames five innocent features*. That risk simply
    lives under `src/webui/js/` now — 64 modules of it — and the module half below has covered them
    since m0. **This test is what stops the INLINE half becoming decorative**, and after m13 the
    inline half is three tiny blocks whose only remaining property is that they exist.

    ⚠️ THREE, NOT "AT LEAST ONE". They are §4's permanent leaves and each is load-bearing at a
    moment no module can reach: `data-theme` and `--fs` before first paint, and the server's
    `{{UI_STATE}}` substitution which a module gets no substitution for. Losing one is a real
    regression that would otherwise read as tidy-up — the page would flash on every load.
    """
    blocks = _blocks()
    sizes = sorted((len(b) for b in blocks), reverse=True)
    assert len(blocks) == 3, (
        f"index.html has {len(blocks)} inline <script> blocks, expected the three pre-paint ones "
        f"(sizes {sizes}).\n"
        "  MORE than three: something has put application JavaScript back in the page. It belongs "
        "in a module under src/webui/js/, imported from js/main.js — see "
        "tests/test_webui_size.py::test_the_page_has_no_inline_application_script, which is the "
        "check that says so with the argument attached.\n"
        "  FEWER than three: a pre-paint restore has been deleted. Those set data-theme and --fs "
        "BEFORE FIRST PAINT and inject {{UI_STATE}}; a module is deferred and cannot do any of it.")
    assert max(sizes) < 5_000, (
        f"the largest inline <script> is {max(sizes):,} characters, which is too big to be a "
        f"pre-paint restore (the three are ~780, ~223 and ~181). Application JavaScript has come "
        f"back into index.html — put it in a module.")
    assert any("{{UI_STATE}}" in b for b in blocks), (
        "no inline block carries {{UI_STATE}} any more. That is the server's substitution point for "
        "account-local UI state, and js/util/uistate.js reads `window.__UI_STATE__` from it — "
        "without it every remembered tab, book and draft silently resets on load.")


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
def test_every_inline_script_parses(tmp_path):
    """🔴 The one that would have caught it. A SyntaxError here takes the WHOLE page down."""
    failures = []
    for i, block in enumerate(_blocks()):
        if any(m in block for m in TEMPLATE_MARKERS):
            continue
        f = tmp_path / f"block{i}.mjs"
        f.write_text(block, encoding="utf-8")
        r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            failures.append(f"inline <script> #{i}:\n{r.stderr.strip()}")

    assert not failures, (
        "index.html's inline JavaScript does not parse, so the page will load with NO script at "
        "all and every browser spec will fail on a missing function:\n\n" + "\n\n".join(failures))


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
def test_a_literal_newline_inside_a_quoted_string_is_caught(tmp_path):
    """Proves the check above actually fails on the exact bug it was written for, rather than
    passing because `node --check` was never really run."""
    f = tmp_path / "bad.mjs"
    f.write_text("const s = 'oh no\nthis is broken';\n", encoding="utf-8")
    r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
    assert r.returncode != 0 and "SyntaxError" in r.stderr


# ── 7.3-m0: the same question, asked of the MODULE TREE and under the RIGHT GRAMMAR ──────────
#
# 🔴 THE CHECKS ABOVE ARE AIMED AT A SHRINKING TARGET, AND SO WAS THE OTHER ONE.
# `tests/stems_widget_smoke.mjs` also runs `new vm.Script()` over the longest inline block, buried
# inside one feature's smoke test. Between them, the whole of the suite's parse coverage was
# pointed at a block that 7.3 exists to DELETE — and as code leaves it for `src/webui/js/`, that
# coverage shrinks silently, because a check that covers less does not go red, it just keeps
# passing. DESIGN_7_3_FRONTEND_SPLIT.md §3.5 names this; §7 item 2 is this section.
#
# TWO THINGS ARE ADDED, AND THE SECOND IS NOT COSMETIC:
#
# 1. **Every `.js` under `src/webui/js/`, found by `rglob` at import time.** 16 modules at m0,
#    ~35 when the milestone finishes. 🔴 THE ENUMERATION IS THE WHOLE POINT — a hardcoded list is
#    a check that stops growing with the tree, which is the same defect this section fixes. A
#    module added tomorrow, in a directory that does not exist today, is covered with no edit here.
#
# 2. **Each block parsed under the goal symbol the browser applies to it.** A classic `<script>`
#    and a `<script type="module">` are different grammars, and each accepts what the other
#    rejects. `node --check <file.js>` picks for itself: since Node 22 it auto-detects, so it will
#    happily accept an `import` inside what is really a classic script — a hard parse failure in
#    the page, green here. (That is exactly what `test_every_inline_script_parses` above does, by
#    writing each block to a `.mjs`; it is kept because it carries the incident and it is what
#    caught the original bug, but it is the LENIENT of the two.) So: classic blocks go through
#    `webui_syntax_check.mjs` and `new vm.Script`, which is the browser's own rule, and modules go
#    through `node --check --input-type=module`.
#
# ⚠️ ONE UNIT PER TEST, so the test ID *is* the offending file (`wb/fmt.js`) or block
# (`index.html:2586`). §7 item 2 requires the failure to name the file; a single test looping over
# 35 modules would name only itself, and the reader would have to open the traceback to find out
# which module broke.

#: The module tree AS IT IS ON DISK RIGHT NOW. `sorted` only fixes the order of the test IDs.
JS_ROOT = paths.WEBUI / "js"
MODULES = sorted(JS_ROOT.rglob("*.js")) if JS_ROOT.is_dir() else []

#: A floor, NOT a target. It exists so a moved `js/` root or a bad glob fails LOUDLY instead of
#: parametrizing zero cases — pytest reports an empty parameter set as a SKIP, which is the same
#: green-while-covering-nothing hole this section was written to close. The count only ever grows
#: during 7.3 (16 at m0, ~35 at the end), so 10 never needs revisiting.
MIN_MODULES = 10

#: The inline `<script>` tags again, but keeping the ATTRIBUTES — `type="module"` is what decides
#: which grammar a block is parsed under, and `_INLINE` above throws it away.
_SCRIPT_TAG = re.compile(r"<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>", re.S | re.I)

#: 🔴 index.html IS A TEMPLATE, BUT NOT A JINJA ONE (§3.4): `web/ui.py::index()` does three literal
#: `.replace()` calls, for `{{CSRF}}`, `{{ADMIN_USER}}` and `{{UI_STATE}}`. Substituting them the
#: way the route does — rather than skipping the block that carries one, as TEMPLATE_MARKERS above
#: has to — is what lets the pre-paint UI-state block be parsed instead of exempted. `null` is
#: chosen because it is valid in both positions a placeholder can occupy, a bare expression
#: (`window.__UI_STATE__={{UI_STATE}};`) and inside a string literal.
_TEMPLATE_SUB = re.compile(r"\{\{[A-Z][A-Z0-9_]*\}\}")

CHECKER = Path(__file__).parent / "webui_syntax_check.mjs"


def _inline_blocks() -> list[tuple[str, bool, str]]:
    """`(label, is_module, source)` for every inline `<script>` in index.html.

    The label carries the block's 1-based line number in the file, because the parser reports a
    line relative to the BLOCK and that number means nothing on its own in a 10,700-line page.

    🔴 THE BLOCKS ARE FOUND, NEVER LISTED. The classic app script starts at line 2586 and runs
    ~8,100 lines today; both numbers change under nearly every commit of this milestone, and the
    block ends up a fraction of that size. Anything anchored to an index or a line number here
    would spend 7.3 pointing at the wrong thing.

    ⚠️ `read_text`, not `read_bytes`: index.html is CRLF on disk and MUST STAY CRLF, but
    universal-newline decoding hands this LF without touching the file. node's parser does not
    care either way; its reported line numbers only line up with the CRLF-to-LF read.
    """
    html = (paths.WEBUI / "index.html").read_text(encoding="utf-8")
    out = []
    for m in _SCRIPT_TAG.finditer(html):
        attrs, body = m.group(1), m.group(2)
        is_module = bool(re.search(r"""type\s*=\s*["']?module""", attrs, re.I))
        line = html.count("\n", 0, m.start()) + 1
        out.append((f"index.html:{line}", is_module, _TEMPLATE_SUB.sub("null", body)))
    return out


INLINE = _inline_blocks() if (paths.WEBUI / "index.html").is_file() else []


def _parse_as_module(source: str) -> subprocess.CompletedProcess:
    """`node --check` under the MODULE goal symbol, source on stdin.

    `--input-type=module` is load-bearing, and stdin is what makes it available: the flag applies
    to piped input, while a named `.js` path is classified by the nearest package.json (there is
    none beside these files) and then by auto-detection. Naming the goal symbol is the only way to
    check the grammar the page will actually use.
    """
    return subprocess.run(
        ["node", "--check", "--input-type=module"], input=source,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def _parse_as_classic(source: str, label: str) -> subprocess.CompletedProcess:
    """`new vm.Script` — see webui_syntax_check.mjs for why the CLI cannot answer this one."""
    return subprocess.run(
        ["node", str(CHECKER), label], input=source,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def test_the_parse_checks_still_reach_the_whole_front_end():
    """🔴 THE GUARD ON THE NEW GUARDS, and the counterpart of the >100 KB assertion at the top.

    Both checks below are parametrized off disk, and a parametrized test with an empty parameter
    set IS REPORTED AS A SKIP, not a failure. So if `js/` is renamed or the `<script>` shape
    changes, they would quietly stop existing and the run would stay green — the precise shape of
    hole (§3.5) that made the old arrangement worthless. This test cannot evaporate that way,
    because it names what it expects instead of enumerating it.
    """
    assert JS_ROOT.is_dir(), (
        f"{JS_ROOT} is gone — the module tree is no longer being parsed by anything")
    assert len(MODULES) >= MIN_MODULES, (
        f"only {len(MODULES)} module(s) found under {JS_ROOT}; there were 16 at 7.3-m0 and the "
        "count only grows. A collapse here means the enumeration lost the tree, not that the "
        "tree shrank.")
    assert any(not is_module for _, is_module, _ in INLINE), (
        "index.html has no classic inline <script> left. If 7.3 has finished and the inline app "
        "script is genuinely gone, that is the milestone's exit criterion (§10) and this "
        "assertion should be retired deliberately, along with the ones at the top of this file. "
        "Until then it means the blocks were not FOUND, and nothing is being parsed.")


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
@pytest.mark.parametrize(
    "path", MODULES, ids=[str(p.relative_to(JS_ROOT)).replace("\\", "/") for p in MODULES])
def test_every_module_parses(path):
    """Every `.js` under `src/webui/js/`, as an ES module. Enumerated, never listed.

    A module that does not parse is worse than an inline block that does not: the page still
    loads, the classic script still runs, and the failure is a `SyntaxError` in the console plus
    whichever names the shim's `Object.assign` was supposed to publish being `undefined` — so it
    presents as a dead button, not as a broken page.
    """
    rel = str(path.relative_to(JS_ROOT)).replace("\\", "/")
    r = _parse_as_module(path.read_text(encoding="utf-8"))
    assert r.returncode == 0, (
        f"src/webui/js/{rel} does not parse as an ES module, so its import fails and every name "
        f"it exports is undefined in the page:\n{r.stdout}{r.stderr}")


#: The browser specs themselves. They are `.mjs` run by node, not shipped to the page — but a
#: syntax error in one costs a Chrome launch and a 25-second timeout before it says so, and the
#: message points at the top of the template literal rather than at the mistake.
SPEC_MJS = sorted((JS_ROOT.parents[2] / "tests").glob("*_spec.mjs"))


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
@pytest.mark.parametrize("path", SPEC_MJS, ids=[p.name for p in SPEC_MJS])
def test_every_browser_spec_parses(path):
    """🔴 A BACKTICK IN A COMMENT INSIDE A TEMPLATE LITERAL ENDS THE LITERAL, AND THIS IS THE
    ONLY CHEAP WAY TO FIND OUT.

    These specs build page expressions as template literals, and their comments are written in the
    same house style as the source they test — which means naming identifiers in backticks. One of
    those closes the string, and everything after it becomes a parse error somewhere else entirely.
    `acestep_tab_browser_spec.mjs` says so in its own header, and it still happened twice in one
    afternoon: once in the tab's source and once in a comment added to fix an unrelated finding.

    ⚠️ The cost of NOT having this is what makes it worth a test rather than a rule. Without it,
    the failure is a spec that spawns Chrome, times out, and reports a line number pointing at the
    start of the literal — minutes, and a misleading trail. With it, it is an instant red with the
    real line, and it runs in the same second as the rest of the parse checks.
    """
    r = _parse_as_module(path.read_text(encoding="utf-8"))
    assert r.returncode == 0, (
        f"tests/{path.name} does not parse. If the arrow points at the start of a template "
        f"literal, look for a backtick inside a comment WITHIN that literal:\n{r.stdout}{r.stderr}")


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
@pytest.mark.parametrize(
    "label,is_module,source", INLINE,
    ids=[f"{lbl}{'-module' if is_mod else '-classic'}" for lbl, is_mod, _ in INLINE])
def test_every_inline_block_parses_under_its_own_goal_symbol(label, is_module, source):
    """The page's own JavaScript, block by block, each under the grammar the browser gives it.

    Nothing is exempt here: the pre-paint UI-state block is parsed with its placeholder
    substituted rather than skipped, so the one block `test_every_inline_script_parses` above has
    to pass over is covered too.
    """
    r = _parse_as_module(source) if is_module else _parse_as_classic(source, label)
    kind = "an ES module" if is_module else "a classic script"
    assert r.returncode == 0, (
        f"the inline <script> at {label} does not parse as {kind}, so the page loads with no "
        f"JavaScript at all. Line numbers below are relative to the start of that block:\n"
        f"{r.stdout}{r.stderr}")


# ── user-facing output ─────────────────
#
# 🔴 A RED DOT IN THE UI MEANS SOMETHING IS WRONG WITH HIS DATA.
#
# This file uses 🔴 heavily and correctly: it marks the paragraph a future session must not skim
# past. That convention is for US. The moment the same glyph lands in a `title=`, a placeholder,
# or a muted help line, it stops being emphasis and becomes a status indicator — and users read it
# as a status indicator rather than emphasis.
#
# It had reached two help blurbs, both with the same issue, because the habit carries straight
# from the comment above the markup into the markup. That is why this is a test and not a note.
#
# ⚠️ Scoped to USER-VISIBLE strings only. Comments and the JS below keep the convention — a scan
# for the character anywhere in the file would fail on the very comments it is trying to protect.
USER_TEXT = re.compile(
    # attributes he hovers over or reads
    r'(?:title|placeholder|alt)="([^"]*)"'
    # …and the muted help lines under a heading. The whole opening tag is captured so the styling
    # can be inspected below — see WARNING_STYLED.
    r'|(<div[^>]*class="[^"]*\b(?:small|muted)\b[^"]*"[^>]*>)([^<]*)'
)

#: ⚠️ **A REAL WARNING MAY WEAR A WARNING GLYPH — that is the sign being used correctly.** The
#: Recovery-key panel tells him older `vault_keys.yaml` backups still answer to a rotated key, in
#: text explicitly colored with `--warn`. Flagging that would be the test insisting a genuine
#: alert stop looking like one. The rule is about NEUTRAL help text wearing an alarm, so the
#: exemption keys on the styling actually applied rather than on a list of blessed strings.
WARNING_STYLED = re.compile(r'--warn|\bclass="[^"]*\bwarn\b')

#: Emphasis glyphs that read as STATUS to someone who did not write them. 🔴 is the one that
#: caused this; the others are the same mistake wearing a different color.
STATUS_GLYPHS = ("🔴", "⚠️", "📌")


def test_no_status_glyph_leaks_into_text_the_user_reads():
    html = (paths.WEBUI / "index.html").read_text(encoding="utf-8")
    offenders = []
    for m in USER_TEXT.finditer(html):
        tag, text = m.group(2) or "", m.group(1) or m.group(3) or ""
        if tag and WARNING_STYLED.search(tag):
            continue                      # a real warning, styled as one
        for glyph in STATUS_GLYPHS:
            if glyph in text:
                line = html[:m.start()].count("\n") + 1
                offenders.append(f"index.html:{line}: {glyph} in {text.strip()[:70]!r}")
    assert not offenders, (
        "a status glyph reached the UI — it reads as 'something is wrong', not as emphasis. "
        "Keep them in comments.\n  " + "\n  ".join(offenders))


#: The one class `ui/log.js`'s `logInto` DELETES on the first line it appends, to clear the pane's
#: "nothing has happened yet" text. Anything nested inside it is deleted with it.
_PLACEHOLDER = re.compile(r'<(\w+)[^>]*class="[^"]*\bph\b[^"]*"[^>]*>(.*?)</\1>', re.S)


def test_no_element_with_an_id_hides_inside_a_log_placeholder():
    """A live element must not be placed inside a log placeholder that the first log update replaces."""
    html = (paths.WEBUI / "index.html").read_text(encoding="utf-8")
    offenders = []
    for m in _PLACEHOLDER.finditer(html):
        for found in re.findall(r'id="([^"]+)"', m.group(2)):
            line = html[: m.start()].count("\n") + 1
            offenders.append(f"index.html:{line}: #{found} is inside a .ph placeholder")
    assert not offenders, (
        "an element with an id is nested inside a `.ph` log placeholder, and `logInto` removes "
        "that placeholder the first time anything is logged into the pane. The element — and "
        "whatever it was displaying — is gone from then on, silently.\n  "
        + "\n  ".join(offenders)
        + "\n  Move it OUT of the pane. Do not null-guard the code that writes to it: that hides "
          "the throw and keeps the disappearance."
    )
