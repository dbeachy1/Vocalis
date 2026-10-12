"""Tripwires for page size, inline scripts, and module structure. Counts use splitlines() after read_text() universal-newline conversion so LF and CRLF checkouts agree. Keep application behavior in modules; markup growth must stay deliberate and the inline application script must remain absent."""
from __future__ import annotations

import re
from pathlib import Path
import shutil
import subprocess

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import paths

INDEX = paths.WEBUI / "index.html"


# The exact page ceiling is a guard against gradual markup growth. Move behavior into modules; do not compress markup to fit.
PAGE_LINE_CEILING = 2_722

#: The longest a classic `<script>` in index.html may be. The three that are left are 2, 9 and 3
#: lines — the pre-paint theme, the pre-paint type scale, and the server's `{{UI_STATE}}`
#: substitution — and all three are FIXED, so this is generous by 3× and still nowhere near the
#: size of anything worth extracting. ⚠️ Raising it is the wrong move every time: a block that
#: wants twenty lines wants to be a module.
_PREPAINT_MAX = 30

#: Every classic `<script>` — no `src=`, no `type=`. The same finder the ratchet used, kept for the
#: same reason: `_inline_app_script` below is pinned to SHAPE rather than to this month's page.
_CLASSIC_BLOCK = re.compile(r"<script(?![^>]*(?:\bsrc=|\btype=))[^>]*>.*?</script>", re.S)
#: The `src` of every `<script type="module" …>`. After 7.3-m13 there must be exactly one.
#: 🔴 BOTH ATTRIBUTE ORDERS, BECAUSE HTML DOES NOT FIX ONE. The first version required `type=`
#: to precede `src=`, so a second module root written `<script src="rogue.js" type="module">`
#: matched nothing and the "two roots race each other" guard passed while looking at one root.
#: ⚠️ This file writes the src-first form itself at the sabotage test below and never ran this
#: pattern against it — the blind spot sat unexercised inside the test that would have shown it.
_MODULE_TAG = re.compile(
    r'<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"'
    r'|<script[^>]*\bsrc="([^"]+)"[^>]*\btype="module"')

# The inline application-script counter is retired; the structural test below now requires that block to stay absent.


def _lines(text: str) -> int:
    """Count lines from text read with universal newlines. read_text() normalizes CRLF and LF checkouts, while splitlines() avoids counting a trailing newline as an extra line."""
    return len(text.splitlines())


#: A `<script>` element and its contents. `.*?` is sound here because a `</script>` may not appear
#: inside a script's text at all — the HTML parser ends the element at the first one, so a JS string
#: containing it would already have broken the page. Verified: six opens, six closes.
_SCRIPT = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.S | re.I)

_SRC_ATTR = re.compile(r"\bsrc\s*=", re.I)
_TYPE_ATTR = re.compile(r"""\btype\s*=\s*["']?([^"'\s>]*)""", re.I)

#: `type` values that still make a **classic** script — one that runs DURING parsing. Absent is the
#: usual case and the only one the page uses. `module` is deliberately not here: a module is
#: deferred, which is the whole of §3.1 and the reason the shim exists.
_CLASSIC_TYPES = {"text/javascript", "application/javascript"}


def _classic_scripts(html: str) -> list[tuple[int, int]]:
    """Return each classic inline script's opening line and body length.

    Ignore external and module scripts; count pre-paint classic scripts, then let the caller select the
    largest application block. Matching script shape keeps the check valid as the page changes without
    relying on stale line ranges.
    """
    out = []
    for m in _SCRIPT.finditer(html):
        attrs = m.group(1)
        if _SRC_ATTR.search(attrs):
            continue
        t = _TYPE_ATTR.search(attrs)
        if t and t.group(1).strip().lower() not in _CLASSIC_TYPES:
            continue
        out.append((html[:m.start()].count("\n") + 1, _lines(m.group(0))))
    return out


def test_index_html_has_not_grown_past_its_ceiling():
    """The assembled page must remain below its explicit line ceiling. New behavior belongs in modules or partials; the threshold should move only for irreducible markup."""
    # 🔴 9.0-m0: THE SUBJECT IS THE ASSEMBLED PAGE, NOT THE FILE, AND SWAPPING THAT IN IS THE
    # WHOLE POINT OF THE EXTRACTION NOT DEFEATING ITS OWN TRIPWIRE. TECH_DEBT #1 moved ten
    # `<section data-panel>` blocks into `src/webui/partials/`, taking index.html from 2,005
    # lines to 198. Left reading the FILE, this assertion would pass by 1,809 lines forever
    # while the real page grew without limit across ten partials that nothing watches - the
    # ratchet still green, still named after the thing it stopped measuring. That is a worse
    # outcome than the growth it was built for, because a vacuous guard also stops anyone
    # looking. `page_markup()` is what the server sends; the ceiling stays where it was.
    from conftest import page_markup
    n = _lines(page_markup())
    # ⚠️ ASCII ONLY IN THE MESSAGE, and that is a convention rather than a preference: pytest
    # escapes non-encodable characters in an assertion message, so a `§` reaches the console as
    # `\xa7` and a 🔴 as `\U0001f534`. The rest of the suite keeps its glyphs in docstrings and
    # comments for the same reason. Emphasis here is CAPITALS.
    assert n <= PAGE_LINE_CEILING, (
        f"src/webui/index.html is {n:,} lines, over its ceiling of {PAGE_LINE_CEILING:,}.\n"
        "\n"
        "  DO NOT RAISE THE CEILING. Move the new code into a module under src/webui/js/ - the "
        "plan, the target layout and the recipe for one extraction are all in "
        "DESIGN_7_3_FRONTEND_SPLIT (section 4 for where it goes, section 6 for how). This "
        "page grew from 314 lines to 14,089 in ninety days without a single commit looking large, "
        "which is why this check exists at all (section 1).\n"
        "\n"
        "  If the growth is genuinely markup or CSS and there is nothing to extract, say so in the "
        "commit message and move the ceiling by the smallest amount that fits - never to 'round up "
        "and give us room'. Room is what got us here.")


def test_the_page_has_no_inline_application_script():
    """The page shell must not regain an inline application script. Keep application behavior in modules so the page remains a small entry point."""
    # 🔴 `_classic_scripts`, NOT `_CLASSIC_BLOCK` — AND THE DIFFERENCE IS THE WHOLE EXIT CRITERION.
    # `_CLASSIC_BLOCK`'s lookahead excludes any tag carrying a `type=` attribute at all, so an
    # inline application script wearing the entirely ordinary `type="text/javascript"` is not a
    # classic block as far as this test is concerned. Verified by sabotage during the 7.3 code
    # review: an 8,002-line inline script with that attribute produced ZERO oversized blocks and
    # the test passed. §10 item 1 calls itself "Enforced, not merely done"; it was not.
    # ⚠️ AND THE TELL WAS SITTING IN THIS FILE ALL ALONG. Every meta-test below — the ones written
    # to prove the finder is right — exercises `_classic_scripts`, which honors `_CLASSIC_TYPES`
    # and does catch it. The guard was the only caller of the weaker regex, so the proofs and the
    # thing being proved had drifted apart. A meta-test must drive the SAME function the guard does.
    src = INDEX.read_text(encoding="utf-8")
    blocks = _classic_scripts(src)
    assert blocks, (
        "index.html has NO classic <script> blocks at all, not even the pre-paint ones. That is not "
        "an improvement: the theme and type-scale restores at the top of <head> are what stop the "
        "page flashing at 16px and light, and they cannot be modules because a module is deferred.")

    oversized = [(ln, n) for ln, n in blocks if n > _PREPAINT_MAX]
    assert not oversized, (
        "index.html has grown an inline application script again:\n"
        + "".join(f"    line {ln}: {n} lines\n" for ln, n in oversized)
        + "\n"
        "  PUT IT IN A MODULE UNDER src/webui/js/ AND IMPORT IT FROM js/main.js. That is not a "
        "style preference - 7.3 spent thirteen milestones moving 8,110 lines of inline JavaScript "
        "out of this file one feature at a time, and this check is the last thing that milestone "
        "produced. DESIGN_7_3_FRONTEND_SPLIT section 4 says where a new module goes and "
        "section 6 is the recipe.\n"
        "\n"
        f"  The only classic blocks allowed here are the three pre-paint <head> ones, which are "
        f"under {_PREPAINT_MAX} lines each and exist because they must run BEFORE FIRST PAINT: the "
        "theme, the type scale, and the server's {{UI_STATE}} substitution. If you genuinely need "
        "a fourth, it belongs in <head>, it is a handful of lines, and it needs a comment saying "
        "why a module cannot do it.")

    # Two alternatives, so `findall` yields a pair per match with the unmatched side empty.
    modules = [a or b for a, b in _MODULE_TAG.findall(src)]
    assert modules == ["/webui/bundle/app.js"], (
        f"index.html should reference exactly one module script and it should be the bundle; found "
        f"{modules}.\n"
        "\n"
        "  ONE root, and that is the half of this assertion that matters. A second <script "
        "type=module> is a second root, which means two modules can be evaluated in an order "
        "nothing expresses, and the wiring each attaches at module-eval starts racing. Import it "
        "from js/main.js instead.\n"
        "\n"
        "  WHICH one changed in 7.5.6: js/main.js is still the graph's root in SOURCE, but the page "
        "loads tools/build_webui.mjs's bundle of it, because 65 module requests behind six HTTP/1.1 "
        "connections were queueing against a GIL-bound werkzeug and costing seconds. If you are "
        "putting js/main.js back here, the bundle is dead and the request count went 1 -> 65.")

    # ⚠️ HTML COMMENTS STRIPPED FIRST, and this is not a nicety — the page's own comment explaining
    # what m13 deleted says the words `Object.assign(window, …)`, so a raw substring check fails on
    # the very file it is meant to pass. A guard that cannot survive being DESCRIBED is a guard that
    # gets reworded around instead of satisfied.
    code = re.sub(r"<!--.*?-->", "", src, flags=re.S)
    assert "Object.assign(window" not in code, (
        "index.html has an Object.assign(window, ...) shim again. That block existed to let the "
        "inline script call into modules, and DESIGN_7_3_FRONTEND_SPLIT.md section 10 item 2 makes "
        "its absence an exit criterion: it flattens live module bindings into one-time copies, so "
        "any reassigned export published through it silently freezes at its seed value.")


def test_the_block_finder_is_pinned_to_shape_not_to_this_month_s_page():
    """⚠️ THE TESTS ABOVE ARE ONLY WORTH THEIR RUNTIME IF THE FINDER IS RIGHT, and a broken finder
    fails GREEN — it picks the wrong block, measures something small, and the ratchet stops being
    load-bearing without ever going red.

    So the finder is shown the exact page shape it has to survive: a `src=` script it must ignore
    (`stream_player.js`), a `type="module"` shim it must ignore (7.1's, and the destination for
    every line the ratchet wants gone), tiny classic pre-paint blocks it must see but not choose,
    and one large classic block it must choose. Deliberately in the WRONG document order, with the
    module tag before the app script, because "the last one" and "the longest one" are different
    rules and only one of them is right after m13.
    """
    page = (
        "<head>\n"
        "<script>document.documentElement.dataset.theme='dark';</script>\n"
        '<script>window.__UI_STATE__ = {{UI_STATE}};</script>\n'
        '<script type="module">import * as dom from "/webui/js/util/dom.js";\n'
        "Object.assign(window, dom);\n"
        "</script>\n"
        '<script src="/webui/stream_player.js"></script>\n'
        "<script>\n" + "const a = 1;\n" * 400 + "</script>\n"
    )
    # The three it must SEE are seen — a finder that skipped small blocks by size would pass this
    # and then miss the day the page grows a fourth pre-paint block worth 3,000 lines.
    assert sorted(_classic_scripts(page)) == [(2, 1), (3, 1), (8, 402)]

    # 🔴 `type="module"` is excluded by TYPE, not by content. This is the one exclusion that must
    # not drift: through 7.3 the shim grew while the classic block shrank, and a finder that counted
    # the module would have reported the milestone as making no progress. After m13 it matters for
    # the opposite reason — `js/main.js` is thousands of lines of module graph away, and counting it
    # would make the "no application script" check unsatisfiable.
    assert 4 not in [ln for ln, _ in _classic_scripts(page)]

    # ✅ AND THE POST-m13 SHAPE IS WHAT THE CHECK ABOVE ACTUALLY RUNS AGAINST — 400 lines of inline
    # JavaScript is a FAILURE now, not a measurement, so this page is proof the finder still sees it.
    biggest = max(n for _, n in _classic_scripts(page))
    assert biggest > _PREPAINT_MAX, (
        "the finder no longer sees a 400-line classic block, so "
        "test_the_page_has_no_inline_application_script cannot fail and is decorative")


def test_the_no_inline_script_check_goes_red_on_the_shape_that_started_all_this():
    """🔴 §6.1 FOR §10 ITEM 5 — a guard against re-growth is worth exactly what its failure is worth.

    ⚠️ It CANNOT be sabotage-verified against the real page, because proving it needs an index.html
    WITH an inline application block and nothing may edit that file to get one. So it is proven
    against the shape the page had before 7.3: three tiny pre-paint blocks and one enormous classic
    script. That is not a hypothetical — it is `fdfc8e4`.

    📌 The three-line page below is the shape m13 produced, and it must PASS. Both directions
    matter: a check that fires on the page as it now stands would be reverted within a week.
    """
    before_7_3 = (
        "<head>\n"
        "<script>document.documentElement.dataset.theme='dark';</script>\n"
        '<script>window.__UI_STATE__ = {{UI_STATE}};</script>\n'
        '<script src="/webui/js/main.js" type="module"></script>\n'
        "</head>\n"
        "<script>\n" + "const a = 1;\n" * 8_108 + "</script>\n"
    )
    oversized = [n for _, n in _classic_scripts(before_7_3) if n > _PREPAINT_MAX]
    assert oversized == [8_110], oversized

    after_m13 = (
        "<head>\n"
        "<script>document.documentElement.dataset.theme='dark';</script>\n"
        '<script>window.__UI_STATE__ = {{UI_STATE}};</script>\n'
        '<script type="module" src="/webui/js/main.js"></script>\n'
        "</head>\n"
    )
    assert not [n for _, n in _classic_scripts(after_m13) if n > _PREPAINT_MAX]
    assert [a or b for a, b in _MODULE_TAG.findall(after_m13)] == ["/webui/js/main.js"]

    # 🔴 THE TWO EVASIONS THE 7.3 CODE REVIEW FOUND, PLANTED SO NEITHER CAN COME BACK. Both passed
    # before that review: an inline application script is not required to omit `type=`, and a
    # second module root is not required to write its attributes in one order.
    typed_app_script = (
        "<head>\n"
        '<script type="text/javascript">\n' + "x();\n" * 8_000 + "</script>\n"
        "</head>\n"
    )
    assert [n for _, n in _classic_scripts(typed_app_script) if n > _PREPAINT_MAX], (
        "an inline application script wearing type=\"text/javascript\" is not being counted as a "
        "classic block — that is the §10 item 1 exit criterion wide open")
    src_first = '<script src="/webui/js/rogue.js" type="module"></script>\n'
    assert [a or b for a, b in _MODULE_TAG.findall(src_first)] == ["/webui/js/rogue.js"], (
        "a second module root written src-first is invisible to _MODULE_TAG, so the one-root "
        "guard passes while two roots race each other")

    # 🔴 AND THE EMPTY CASE IS A FAILURE, NOT A PASS. A page with no classic block at all has lost
    # its pre-paint restores, which is a real regression that would otherwise read as the cleanest
    # possible result — the theme and type scale would flash on every load.
    assert not _classic_scripts("<head>\n</head>\n")


def test_the_line_count_does_not_depend_on_the_checkout_s_line_endings():
    """The line count must be identical for LF and CRLF checkouts because the source is read as normalized text."""
    crlf = "<a>\r\n<b>\r\n<c>\r\n"
    assert _lines(crlf.replace("\r\n", "\n")) == _lines(crlf) == 3
    assert _lines("<a>\n<b>\n<c>") == 3, "a file with no trailing newline still has three lines"
    assert _lines("") == 0

    # The real file, both ways round: universal newlines have already normalized it, so a text-mode
    # count and a byte-level count of the RAW file agree here — and would not if either side of the
    # rule were wrong.
    raw = INDEX.read_bytes()
    assert _lines(INDEX.read_text(encoding="utf-8")) == raw.replace(b"\r\n", b"\n").count(b"\n"), (
        "the text-mode line count disagrees with the raw file's terminator count — either the file "
        "has mixed endings or it no longer ends with a newline. Fix _lines, not the constants.")


def test_the_page_still_has_the_line_endings_git_would_check_it_out_with():
    """🔴 A TOOL THAT REWRITES THE WHOLE FILE CAN STRIP EVERY `\\r`, AND `git diff` WILL NOT SAY SO.

    7.3-m4d arrived with `index.html` at **0 CRLF and 8,948 bare LF** — the entire page normalized
    to LF inside a Windows worktree where `core.autocrlf=true`. It parsed, it served, and every
    content check in the suite passed, because git normalizes on the way in and the diff was
    therefore *clean*: 20 insertions, 371 deletions, exactly the extraction. The one thing that went
    red was a CRLF assertion inside `test_webui_parsetime.py`'s IIFE **sabotage meta-tests**, two
    tests whose subject is something else entirely — so the signal arrived pointing at the wrong
    file, and the obvious reading of it ("the sabotage helper spliced a bare \\n") is wrong.

    ⚠️ **THE COST IS A DIFF NOBODY CAN REVIEW.** Left alone, the first commit that made git
    re-normalize this file would have rewritten all 8,948 lines in one hunk, and whatever real
    change rode along with it would have been unreadable and unbisectable.

    📌 **ASKED VIA `git checkout-index --temp`**, which writes the file the way a fresh checkout
    would — so this is one assertion that holds on Windows (CRLF) and Unix (LF) without knowing which
    it is on, and it follows `.gitattributes` and `core.autocrlf` instead of restating them. The
    committed content may differ from the working tree; only the ENDINGS are compared.
    """
    raw = INDEX.read_bytes()
    crlf, total = raw.count(b"\r\n"), raw.count(b"\n")
    assert not (crlf and total - crlf), (
        f"index.html has MIXED line endings: {crlf:,} CRLF and {total - crlf:,} bare LF. Something "
        "wrote part of the file with one convention and part with the other - see cut.py, which "
        "detects and preserves the file's own ending, and never use an editor that normalizes.")

    git = shutil.which("git")
    if not git:
        pytest.skip("git is not on PATH - cannot ask what a checkout would produce")
    # 🔴 `checkout-index --temp` writes its `.merge_file_*` into the REPOSITORY'S top-level working
    # directory and prints the bare name, not a path relative to `cwd`. In the legacy app the
    # repo root and REPO_ROOT were the same directory, so `REPO_ROOT / name` happened to be right.
    # In this repository the app lives under `source/vocalis/`, so that join pointed at a file that
    # was never there: the read raised FileNotFoundError (the test failed), and the real temp file —
    # never reached by the `unlink` below — was left behind at the top level on every run (which,
    # in parallel runs, other workers then tripped over). Resolve the top level from git itself.
    top = subprocess.run([git, "rev-parse", "--show-toplevel"],
                         cwd=REPO_ROOT, capture_output=True, text=True)
    if top.returncode or not top.stdout.strip():
        pytest.skip(f"cannot locate the git top level ({top.stderr.strip() or 'no output'})")
    top_dir = Path(top.stdout.strip())
    r = subprocess.run([git, "checkout-index", "--temp", "--", "src/webui/index.html"],
                       cwd=REPO_ROOT, capture_output=True, text=True)
    if r.returncode or not r.stdout.strip():
        pytest.skip(f"not a git checkout of this file ({r.stderr.strip() or 'no output'})")
    temp = top_dir / r.stdout.split("\t")[0].strip()
    try:
        want = temp.read_bytes()
    finally:
        temp.unlink(missing_ok=True)

    want_crlf = want.count(b"\r\n") > 0
    assert (crlf > 0) == want_crlf, (
        f"index.html is {'CRLF' if crlf else 'LF'} in the working tree, but a fresh checkout of it "
        f"here would be {'CRLF' if want_crlf else 'LF'}. Something rewrote the whole file and "
        "normalized its line endings.\n"
        "\n"
        "  This is invisible to `git diff` - git normalizes on the way in, so the diff looks "
        "clean - but the NEXT commit that touches the file re-normalizes all of it, and whatever "
        "real change rides along is buried in a 9,000-line hunk.\n"
        "\n"
        "  Fix: rewrite the file's endings back (read_bytes/write_bytes, never read_text, which "
        "normalizes CRLF to LF on the way in), and edit this page with temp/cut.py or explicit "
        "byte I/O rather than with anything that rewrites it wholesale.")


@pytest.mark.parametrize("name, value, ceiling", [
    # 🔴 TIGHTENED 4,000 → 2,500 WITH THE 7.3.19 EXTRACTION, because a bound left where it was
    # would now permit the ceiling to be doubled past the file's actual size and still call itself
    # a ceiling. An off-switch guard whose own bound is stale is an off switch — the same sentence
    # this list already carries about the 20,000 it started with.
    # 9.5-m1: 2,500 -> 2,600, and this bound is maintained by RE-TIGHTENING TO THE FILE, never by
    # being given room — 20,000 -> 4,000 -> 2,500 -> 2,600 across its life. 2,500 was +3.3% over a
    # 2,419-line page; 2,600 is +3.7% over a 2,506-line one, so the guard is as tight as it was.
    # 🔴 IF THIS MOVES AGAIN, READ `PAGE_LINE_CEILING`'S OWN NOTE ABOVE FIRST. It argues that the
    # page total has stopped being the check worth having now that the page is twenty-one
    # partials, and names its successor. Raising this a fourth time without engaging that is how
    # a bound goes stale, which is the exact failure this parametrization exists to catch.
    # 10.0-m1/m2: 2,600 -> 2,702, and this note IS the engagement the line above demands rather
    # than a fourth silent bump. What `PAGE_LINE_CEILING`'s note argues, read as instructed:
    #
    #   * The page total is now a BOOKKEEPING number. It has to move for every legitimate screen —
    #     nine times across 9.0 alone, each by its exact delta — which is precisely the kind of
    #     number that stops being read. That argument is sound and this change does not dispute it.
    #   * Its named successor EXISTS AND IS GREEN WITH ROOM: `PARTIAL_LINE_CEILING` at 140, against
    #     which 10.0's new screen is 44 and the panel it hangs off is well under. The guard that
    #     catches drift nobody intended did its job silently while this one needed a decision —
    #     the exact division of labor TECH_DEBT 1a proposed.
    #   * So the check worth having is intact, and this bound's job is unchanged: stop
    #     `PAGE_LINE_CEILING` being set to something that cannot fail.
    #
    # 🔴 IT IS RE-TIGHTENED TO THE FILE, WHICH IS THE ONLY WAY THIS NUMBER HAS EVER MOVED:
    # 20,000 -> 4,000 -> 2,500 -> 2,600 -> 2,702 -> 2,800. 2,500 was +3.3% over a 2,419-line page
    # and 2,600 was +3.7% over a 2,506-line one; 2,702 is +3.5% over a 2,611-line one, and 2,800
    # (11.1.0, LLM > API) is +3.5% over a 2,706-line one. **The guard is exactly as tight as it has
    # always been** — which is the test its own comment sets.
    #
    # ⚠️ AND THE ALTERNATIVE WAS THE BANNED ONE. Getting under 2,600 needed 11 lines out of 62 of
    # new markup, and there is nothing left to cut: 27 lines of prose were already deleted rather
    # than paid for, the behavior is already a module, and `runtime/page.py` gives the assembler no
    # variable mechanism, so the duplicated identity block cannot become a shared partial. What
    # remains is a drop zone, a textarea, a progress line and a button. The only way to 2,600 was
    # welding distinct elements onto shared lines would make the markup harder to review.
    ("PAGE_LINE_CEILING", PAGE_LINE_CEILING, 2_800),
    ("_PREPAINT_MAX", _PREPAINT_MAX, 200),
])
def test_no_constant_has_been_set_to_something_that_cannot_fail(name, value, ceiling):
    """Keep each configured ceiling low enough to detect when its guard has been disabled.

    A stale or implausibly large bound lets the page grow while the test stays green. The pre-paint
    limit is `_PREPAINT_MAX`; it should remain above the current small restore scripts without becoming
    a way to reintroduce application code inline.
    """
    assert value < ceiling, (
        f"{name} = {value:,} is larger than any plausible value for this file - that is not a "
        "ceiling, it is an off switch with a comment. See DESIGN_7_3_FRONTEND_SPLIT "
        "section 1 for what happens when this check is not doing anything, and section 10 item 5 "
        "for why this particular check was left behind on purpose.")


#: The shell's own ceiling (9.0-m0). `index.html` is 198 lines after the extraction: doctype, head,
#: header, the tab bar, ten `{% include %}` lines and the script tags. 260 is headroom for a new tab
#: plus a little structure, and nothing else.
SHELL_LINE_CEILING = 260


def test_the_shell_stays_a_shell():
    """Keep page markup in partials while the assembled page remains under its total ceiling.

    The shell has its own limit because a page-wide limit alone would allow panel markup to drift back
    into `index.html`. A new panel belongs in `src/webui/partials/` and is included by the shell.
    """
    n = _lines(INDEX.read_text(encoding="utf-8"))
    assert n <= SHELL_LINE_CEILING, (
        f"src/webui/index.html is {n:,} lines, over its shell ceiling of {SHELL_LINE_CEILING:,}.\n"
        "\n"
        "  THIS PAGE IS A SHELL NOW. Its panels live in src/webui/partials/ and it pulls them in "
        "with {% include %}. Markup added straight to the shell is markup outside the split that "
        "TECH_DEBT item 1 exists to hold. Put the new block in a partial and include it.\n"
        "\n"
        "  DO NOT RAISE THIS TO MAKE A COMMIT PASS - that is the exact move the page ceiling's own "
        "comment calls the 'watched by a human' outcome with an extra step."
    )


#: Every `{% include 'partials/x.html' %}` in a template, however deep. Jinja accepts other
#: quoting and expression forms; this matches the ONE form the tree uses, and a template that
#: reached for another would be flagged as an orphan rather than silently missed.
_INCLUDE_RE = re.compile(r"{%-?\s*include\s+'([^']+)'\s*-?%}")


def _walk_includes(start, read):
    """The set of templates reachable from `start`, following includes transitively.

    Split out from the filesystem so it can be MUTATION-TESTED against a synthetic tree below.
    A reachability check nobody has ever seen fail is a reachability check nobody knows works.
    """
    seen, stack = set(), [start]
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.add(name)
        stack.extend(_INCLUDE_RE.findall(read(name)))
    return seen


def test_every_partial_is_reachable_from_the_shell():
    """Every partial must be reachable through the shell's transitive include graph.

    Missing includes fail during assembly, but orphaned files can remain unnoticed while their panel
    never renders. Following nested includes allows panels to split into smaller partials without
    weakening the reachability check.
    """
    partials = sorted((paths.WEBUI / "partials").glob("*.html"))
    assert partials, "no partials found - the extraction is gone?"

    def read(name):
        return (paths.WEBUI / name).read_text(encoding="utf-8")

    reachable = _walk_includes("index.html", read)
    orphans = [p.name for p in partials if f"partials/{p.name}" not in reachable]
    assert not orphans, (
        f"these partials are not reachable from index.html and therefore render nowhere: "
        f"{orphans}.\n"
        "  Either add the {% include %} to the shell or to the panel that owns them, or delete "
        "the file if the tab is gone."
    )


def test_the_reachability_walk_still_catches_an_orphan():
    """🔴 MUTATION TEST. The check above got MORE permissive to allow nesting, so the thing to
    prove is that it did not become permissive full stop.

    ⚠️ This is the lesson from `a guard is only as good as its window`, applied to a walker rather
    than a regex: three synthetic trees, one nested-and-fine, one orphaned, one CYCLIC. The cycle
    case is not hypothetical - two partials including each other would recurse until Jinja blew
    the stack, and a `seen` set that was written without one would hang this suite instead.
    """
    tree = {
        "index.html": "{% include 'partials/a.html' %}",
        "partials/a.html": "{% include 'partials/b.html' %}",
        "partials/b.html": "hello",
        "partials/orphan.html": "nobody includes me",
    }
    reachable = _walk_includes("index.html", tree.__getitem__)
    assert "partials/b.html" in reachable, "a NESTED partial was reported unreachable"
    assert "partials/orphan.html" not in reachable, (
        "the walk claims an unincluded partial is reachable - the guard is now a no-op"
    )

    cyclic = {
        "index.html": "{% include 'partials/a.html' %}",
        "partials/a.html": "{% include 'partials/b.html' %}",
        "partials/b.html": "{% include 'partials/a.html' %}",
    }
    assert _walk_includes("index.html", cyclic.__getitem__) == {
        "index.html", "partials/a.html", "partials/b.html"
    }, "the walk does not terminate on a cycle"


#: The most any ONE partial may be. 9.0-m2's Prompts screen is the largest at 88 lines; the
#: SillyTavern panel inherited from the m0 extraction is far bigger and is grandfathered below.
PARTIAL_LINE_CEILING = 140

#: Large pre-existing partials use exact shrink-only ceilings; new partials use the standard cap.
GRANDFATHERED_PARTIALS = {
    "panel-sillytavern.html": 580,
    "panel-voicestudio.html": 26,
    "panel-voices.html": 143,
    "panel-settings.html": 111,
}


def test_no_single_partial_has_grown_past_its_ceiling():
    """Keep individual partials from growing without bound.

    The assembled-page ceiling catches total growth, while the shell ceiling keeps panels out of
    `index.html`; this per-partial limit catches one panel sprawling. A new screen belongs in a new
    partial, so it does not require raising an existing panel's cap.
    """
    over = []
    for p in sorted((paths.WEBUI / "partials").glob("*.html")):
        n = _lines(p.read_text(encoding="utf-8"))
        cap = GRANDFATHERED_PARTIALS.get(p.name, PARTIAL_LINE_CEILING)
        if n > cap:
            over.append(f"{p.name} is {n:,} lines, over its cap of {cap:,}")
    assert not over, (
        "these partials have outgrown their caps:\n  " + "\n  ".join(over) + "\n"
        "\n"
        "  A NEW SCREEN GOES IN A NEW PARTIAL - that costs this check nothing. This fires when one "
        "existing panel is sprawling, which is the growth the page ceiling was always meant to "
        "catch and can no longer see now that the page is ten files.\n"
        "\n"
        "  DO NOT add the file to GRANDFATHERED_PARTIALS to make this pass. That list is for the "
        "four panels the m0 extraction inherited at their existing size, and every entry in it is "
        "pinned so it can shrink but not grow."
    )


def test_the_grandfathered_list_cannot_quietly_become_a_hole():
    """⚠️ A PINNED-AT-CURRENT-SIZE LIST IS A RATCHET ONLY WHILE THE PINS ARE TIGHT.

    If a grandfathered panel shrinks, its pin must come down with it, or the slack it leaves is
    room for a later commit to grow into unnoticed. This also catches an entry left behind for a
    partial that no longer exists — a dead exemption reads as coverage.
    """
    for name, pinned in sorted(GRANDFATHERED_PARTIALS.items()):
        p = paths.WEBUI / "partials" / name
        assert p.is_file(), f"{name} is grandfathered but does not exist - stale exemption"
        n = _lines(p.read_text(encoding="utf-8"))
        assert n == pinned, (
            f"{name} is {n:,} lines but pinned at {pinned:,}. If it SHRANK, lower the pin to "
            f"{n:,} so the slack cannot be grown into later. If it GREW, that is the drift this "
            "guard exists to catch."
        )


# ── a partial may not close a tag it did not open (9.0 review) ────────────────

def test_no_partial_closes_more_divs_than_it_opens():
    """A surplus closing tag in a partial can close a container in the assembled page.

    Check balance per partial so malformed markup cannot escape into the shell. Strip HTML comments
    first because examples inside comments are documentation, not rendered tags.
    """
    bad = []
    for p in sorted((Path(REPO_ROOT) / "src" / "webui" / "partials").glob("*.html")):
        code = re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S)
        opens = len(re.findall(r"<div\b", code))
        closes = code.count("</div>")
        if opens != closes:
            bad.append(f"{p.name}: {opens} <div> vs {closes} </div>")
    assert not bad, (
        "a partial's <div> tags do not balance, so the surplus reaches out of the partial and "
        "closes (or leaves open) a container in index.html: " + "; ".join(bad)
    )


def test_index_html_itself_balances_its_divs():
    """The other half: the shell must not rely on a partial to close its containers either."""
    code = re.sub(r"<!--.*?-->", "", (Path(REPO_ROOT) / "src" / "webui" / "index.html")
                  .read_text(encoding="utf-8"), flags=re.S)
    opens = len(re.findall(r"<div\b", code))
    closes = code.count("</div>")
    assert opens == closes, f"index.html has {opens} <div> and {closes} </div>"
