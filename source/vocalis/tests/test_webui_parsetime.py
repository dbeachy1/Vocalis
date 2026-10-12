"""🔴 THE PARSE-TIME SURFACE OF `index.html` — RETIRED AT 7.3-m13, BECAUSE ITS SUBJECT NO LONGER
EXISTS. What is left is the small part that is still true, plus the record of what the big part was.

─────────────────────────────────────────────────────────────────────────────────────────────
WHAT THIS FILE WAS, AND WHY IT IS 1,400 LINES SHORTER.

Through 7.3 the page held ONE classic inline `<script>` — 8,110 lines at m0 — plus a
`<script type="module">` shim. A classic script runs **during** document parsing; a module runs
**after** the whole document is parsed. So:

    🔴 an inline statement can never call a module export AT PARSE TIME.
       The module has not run. The name is `undefined`.

That was the one hazard capable of breaking the split silently, and the failure mode was the worst
available: not an import error but a `TypeError` much later, or nothing at all, or — past the boot
IIFE's first `await` — a genuine race that passed on a slow load and failed on a warm box (§3.1b).
This file made it fail BY NAME in 0.05s: an inventory of top-level IIFEs, a pinned table of every
parse-time-reachable name with a written reason each, and the check that actually caught it —
*no parse-time name is defined only in a module*.

✅ **m13 DELETED THE CLASSIC SCRIPT, SO THE HAZARD IS GONE BY CONSTRUCTION.** There is no inline
statement left that could call anything, at parse time or otherwise. `js/main.js` is the graph's
root and every line of application code is a module. A scan for "inline code that reaches into a
module" now has nothing to scan.

⚠️ **THE GUARD THAT REPLACES IT IS IN A DIFFERENT FILE, AND THAT IS THE POINT.** The property worth
protecting from here is not "which inline names are parse-time reachable" — it is **"there is no
inline application script at all"**, which is
`test_webui_size.py::test_the_page_has_no_inline_application_script` (§10 item 5). Keeping a
1,500-line scanner alive to measure zero would be the §11.15 failure in its purest form: a check
elaborately maintained against a subject that has stopped existing.

─────────────────────────────────────────────────────────────────────────────────────────────
📌 WHAT THE RETIRED HALF ACTUALLY BOUGHT, since deleting a test should have to say so:

  * It found `_PARSE_TIME_SURFACE` was under-measured by 4× — the scan saw calls and receivers but
    not BARE VALUES, and `$('satAdd').addEventListener('click', satAdd)` is parse-time exactly as
    hard as a call. That arm is what stopped m4l shipping a blank page (§11.8).
  * Twenty-eight names left the table across thirteen milestones, each departure a signal that a
    duplicated helper had become deletable. Two duplicates were retired that way — `esc` at m8c
    and `AUDITION_TEXT` at m12c — both on removal conditions written the day they were created.
  * `UIS` left it at m12c without anyone aiming at that, which un-canceled `util/uistate.js` and
    is why §10 item 2 was satisfiable at all (§11.29).
  * And it was itself the source of four stale pins (§11.26, §11.30), including one this ledger had
    explicitly declared safe. A scanner that measures a shrinking population grows pins like rust.

🔴 THE ONE CLAIM THAT SURVIVES IS BELOW, AND IT IS NOT A LEFTOVER. The three pre-paint `<head>`
blocks are still classic scripts, still run during parsing, and are therefore still the one place in
this application where the original hazard can be reintroduced. They are the reason this file is not
simply deleted.

See `DESIGN_7_3_FRONTEND_SPLIT` §3.1, §3.1a, §3.1b and §10.
"""
from __future__ import annotations

import re

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import paths

INDEX = paths.WEBUI / "index.html"

#: Classic `<script>` — no `src=`, no `type=`. After m13 these are only the pre-paint blocks.
_CLASSIC = re.compile(r"<script(?![^>]*(?:\bsrc=|\btype=))[^>]*>(.*?)</script>", re.S)

#: Every module under `src/webui/js/`, by exported name. Built at run time so a new module is
#: covered the moment it exists — the §3.5 lesson: a check pinned to a list covers less of the
#: product with every commit while continuing to pass.
_EXPORTED = re.compile(
    r"^export\s+(?:async\s+)?(?:function\s*\*?\s*([\w$]+)|class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+))"
    r"|^export\s*\{([^}]*)\}", re.M)


# ─────────────────────────────────────────────────────────────────────────────────────────
# ✅ `_mask_literals` SURVIVED THE RETIREMENT, AND IT IS THE ONLY THING FROM THE SCANNER THAT DID.
# `tests/test_webui_modules.py` imports it, and it is the function DESIGN_7_3 §2.3 is about — two
# earlier attempts at it failed SILENTLY, reporting 88 top-level declarations instead of 493
# because a `"` inside a regex character class opened a string state that swallowed the file.
# 🔴 Re-rolling a second masker in the file that needs one is how that bug comes back. It is kept
# here, where its history is, rather than moved: this module is still the right home for "what does
# the browser actually parse, and when".


#: Characters and keywords after which a `/` starts a REGEX rather than a division.
_REGEX_OK_AFTER = set("(,=:[!&|?{};+-*%~^<>") | {""}
_REGEX_OK_WORDS = {"return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof",
                   "do", "else", "yield", "await", "throw"}



def _blank_template(src: str, out: list, start: int, n: int) -> int:
    """Blank one template literal's TEXT, leaving its `${…}` interpolations visible.

    `start` indexes the opening backtick; returns the index just past the closing one.

    🔴 **MUTUALLY RECURSIVE WITH `_blank_interp`, AND THAT IS THE FIX.** The first version
    walked PAST an interpolation without blanking anything inside it — correct for the code in
    `${…}`, wrong for a template NESTED in that code, whose prose then stayed visible and was
    scanned as identifiers. `voice/training.js` says "mount it and refresh" inside exactly such
    a nested template, so the day a module defined a function named `refresh`, that sentence
    was reported as a module using a name it never imports.

    ⚠️ Length and newlines are preserved, because every scan downstream uses indices from this
    text against the original.
    """
    j = start + 1
    while j < n:
        if src[j] == "\\":
            j += 2
            continue
        if src[j] == "`":
            return j + 1
        if src[j] == "$" and src[j + 1:j + 2] == "{":
            j = _blank_interp(src, out, j + 2, n)
            continue
        if src[j] != "\n":
            out[j] = " "
        j += 1
    return j


def _blank_interp(src: str, out: list, start: int, n: int) -> int:
    """Walk a `${…}` interpolation, blanking the CONTENTS of any literal inside it.

    The interpolation itself is code and stays visible; a string or template *within* it is
    not, and is blanked exactly as it would be at the top level.
    """
    d, k = 1, start
    while k < n and d:
        ch = src[k]
        if ch == "{":
            d += 1
        elif ch == "}":
            d -= 1
        elif ch == "`":
            k = _blank_template(src, out, k, n)
            continue
        elif ch in "'\"":
            q, m = ch, k + 1
            while m < n and src[m] != q:
                if src[m] == "\\":
                    m += 2
                    continue
                if src[m] == "\n":
                    break
                out[m] = " "
                m += 1
            k = m
        k += 1
    return k

def _mask_literals(src: str) -> str:
    """Blank the CONTENTS of every string, template, regex and comment, preserving length and lines.

    🔴 THIS IS THE FUNCTION THAT TWO EARLIER ATTEMPTS GOT WRONG, AND BOTH FAILED SILENTLY.
    `DESIGN_7_3_FRONTEND_SPLIT.md` §2.3: a naive brace-depth scanner meets `esc` on line 2592 —

        const esc=s=>String(s==null?'':s).replace(/[&<>"]/g, …)

    — sees the `"` inside the regex's character class, opens a string state, and swallows the rest
    of the file. **The depth still returned to 0 at EOF and never went negative**, so nothing looked
    wrong; it just reported 88 top-level declarations instead of 493. Every downstream count would
    have been a fraction of the truth, and green.

    So the `/` here is disambiguated properly — regex only where an operand cannot be — and the
    result is index-aligned with the original, which is what lets every later scan use column-0
    positions from the masked text and content from either.

    📌 `${…}` inside a template is left VISIBLE: it is code, it runs, and `esc` is reached through
    exactly one of them (`` `<option>${esc(l[0])}</option>` `` inside `vcInitLang`).
    """
    out = list(src)
    n = len(src)
    i = 0
    prev = ""            # last significant token, for regex-vs-division

    def blank(a: int, b: int) -> None:
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = src[i]
        if c in "'\"":
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == c or src[j] == "\n":
                    break
                j += 1
            blank(i + 1, j)
            i, prev = j + 1, "str"
            continue
        if c == "`":
            i, prev = _blank_template(src, out, i, n), "str"
            continue
        if c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
            continue
        if c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i)
            j = n if j < 0 else j + 2
            blank(i, j)
            i = j
            continue
        if c == "/" and (prev in _REGEX_OK_WORDS or prev in _REGEX_OK_AFTER):
            j, in_class = i + 1, False
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                elif src[j] == "\n":       # an unterminated regex is a division after all
                    j = -1
                    break
                j += 1
            if j > 0:
                blank(i + 1, j)
                i, prev = j + 1, "re"
                continue
        if c.isspace():
            i += 1
            continue
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            i, prev = j, src[i:j]
            continue
        i, prev = i + 1, c
    return "".join(out)


def test_a_template_nested_in_an_interpolation_has_its_prose_blanked():
    """🔴 THE CASE THAT ESCAPED SILENTLY UNTIL 9.0-m8e.

    `${...}` is left visible because it is code — but a template nested INSIDE that code is prose
    again, and the first version only walked past it. `voice/training.js` says "mount it and
    refresh" in exactly such a place, so the day `video/video.js` defined a function named
    `refresh`, the free-name guard reported training.js as using a name it never imports.

    ⚠️ BOTH DIRECTIONS ARE ASSERTED, because the risk of a masker made more aggressive is
    that it starts eating CODE — and a scan that cannot see `esc(` reports a clean file. That is
    the failure this module's own docstring describes: 88 declarations instead of 493, and green.
    """
    bt = chr(96)
    src = "const a = " + bt + "x ${cond ? " + bt + "mount it and refresh." + bt + \
          " : " + bt + "${esc(other)}" + bt + "} y" + bt + ";"
    got = _mask_literals(src)

    assert len(got) == len(src), "the masker changed the length; every index downstream moves"
    assert "refresh" not in got, "nested template PROSE survived and reads as an identifier"
    assert "mount" not in got
    assert "cond" in got, "the interpolation CODE was blanked - the scan has gone blind"
    # ⚠️ `esc(other)` had to be written as an INTERPOLATION inside the nested template. The
    # first draft put it as bare text between backticks and expected it to survive - but bare text
    # between backticks IS prose, and blanking it is right. The test was wrong, not the masker.
    # This form proves the recursion handles depth TWO: an interpolation inside a nested template.
    assert "esc(" in got, "a call inside a nested template's own ${} was blanked - blind at depth 2"


def test_the_masker_still_survives_the_regex_that_broke_two_earlier_attempts():
    """📌 The `esc` line from DESIGN_7_3_FRONTEND_SPLIT §2.3, kept as a fixture: a naive
    scanner sees the quote inside the regex character class, opens a string, and swallows the rest
    of the file — returning to depth 0 at EOF so nothing looks wrong.
    """
    q, sq = chr(34), chr(39)
    src = ("const esc=s=>String(s==null?" + sq + sq + ":s).replace(/[&<>" + q + "]/g, c => c);"
           + chr(10) + "const after = 1;")
    got = _mask_literals(src)
    assert "after" in got, "the masker swallowed the file after a regex character class"
    assert "replace" in got


def _js_root():
    return paths.WEBUI / "js"


def _module_exports() -> dict[str, str]:
    """name -> the module that exports it. A name exported twice keeps its first sighting; the
    duplicate-export question belongs to test_webui_modules.py, not here."""
    out: dict[str, str] = {}
    for p in sorted(_js_root().rglob("*.js")):
        rel = p.relative_to(_js_root()).as_posix()
        for m in _EXPORTED.finditer(p.read_text(encoding="utf-8")):
            fn, cls, var, braces = m.groups()
            for g in (fn, cls, var):
                if g:
                    out.setdefault(g, rel)
            if braces:
                for part in braces.split(","):
                    part = part.strip()
                    if part:
                        out.setdefault(part.split()[-1], rel)
    return out


def _prepaint_blocks() -> list[str]:
    return _CLASSIC.findall(INDEX.read_text(encoding="utf-8"))


def test_the_pre_paint_blocks_are_the_only_classic_scripts_left():
    """The premise every check below depends on, asserted rather than assumed.

    ⚠️ It overlaps `test_webui_size.py` on purpose and the duplication is one line. That file owns
    the *policy* (no inline application script, §10 item 5); this one needs the *fact* before it can
    say anything about the blocks that remain, and a file whose premise is only checked somewhere
    else goes quietly vacuous the day that other file is edited.
    """
    blocks = _prepaint_blocks()
    assert blocks, (
        "index.html has no classic <script> at all — the pre-paint theme and type-scale restores "
        "are gone, and the page will flash on every load. They cannot be modules: a module is "
        "deferred and these must run before first paint.")
    biggest = max(len(b.splitlines()) for b in blocks)
    assert biggest <= 30, (
        f"the largest classic <script> in index.html is {biggest} lines, which is an application "
        f"script rather than a pre-paint restore. The parse-time hazard this file used to scan for "
        f"comes back with it — see the module docstring, and put the code in a module.")


def test_no_pre_paint_block_reaches_into_a_module():
    """🔴 THE ONE CLAIM THAT OUTLIVED THE MILESTONE, AND THE ONLY PLACE THE ORIGINAL HAZARD CAN
    STILL BE REINTRODUCED.

    The three `<head>` blocks run DURING PARSING — earlier than anything else on the page, by
    design, because their whole job is to set `data-theme` and `--fs` before the first paint and to
    hand the server's `{{UI_STATE}}` to `js/util/uistate.js`. `js/main.js` is a module and therefore
    deferred, so **every module in this application runs after all three of them.**

    So the rule that governed 8,110 lines for thirteen milestones still governs these fourteen:
    a name defined only in a module is `undefined` here. The difference is that it is now a
    fourteen-line surface instead of an eight-thousand-line one, which is why this is a
    straightforward check rather than a masker, a bare-value arm and a pinned table.

    ⚠️ THE FAILURE MODE IS WHY THIS IS WORTH KEEPING AT FOURTEEN LINES. These blocks have no error
    handling that a reader would notice — they are `try{…}catch(e){}` — so a reference to a module
    export does not throw visibly. It silently skips the restore, and the symptom is "the page
    flashes light for a moment on load", which reads as a rendering quirk rather than as a bug and
    is exactly the class of thing 7.2-m3 spent a browser spec proving.

    📌 It compares against the REAL export list, rebuilt from disk on every run, so a module that
    starts exporting `_t` or `s` tomorrow is covered without anyone remembering this file exists.
    """
    exports = _module_exports()
    assert exports, "no exports found under src/webui/js — the scan has come unstuck from the tree"

    offenders = []
    for i, block in enumerate(_prepaint_blocks()):
        # Comments and strings out first: these blocks are mostly comment, and the type-scale one
        # names `loadAppSettings()` in prose while deliberately not calling it.
        code = re.sub(r"/\*.*?\*/", " ", block, flags=re.S)
        code = re.sub(r"(?m)//.*$", " ", code)
        code = re.sub(r"'(?:\\.|[^'\\])*'", "''", code)
        code = re.sub(r'"(?:\\.|[^"\\])*"', '""', code)
        code = re.sub(r"`(?:\\.|[^`\\])*`", "``", code)
        for name in set(re.findall(r"(?<![\w.$])([A-Za-z_$][\w$]*)", code)):
            if name in exports:
                offenders.append(f"pre-paint block #{i} names `{name}`, exported by js/{exports[name]}")

    assert not offenders, (
        "a pre-paint <script> in index.html references a name that only a module defines:\n"
        + "".join(f"    {o}\n" for o in offenders)
        + "\n"
        "  THESE BLOCKS RUN DURING PARSING AND EVERY MODULE RUNS AFTER THEM, so the name is "
        "undefined at that moment. They are wrapped in try/catch, so this does not throw where you "
        "would see it - the restore is silently skipped and the page flashes on load.\n"
        "\n"
        "  Inline the handful of lines you need instead. These three blocks are deliberately "
        "self-contained and duplicate a little logic for exactly this reason "
        "(DESIGN_7_3_FRONTEND_SPLIT.md section 4: three permanent leaves).")


def test_the_module_reach_check_would_catch_a_real_one():
    """§6.1 — a guard whose failure has never been seen is a guard nobody has checked.

    ⚠️ It cannot be sabotage-verified against the real page (nothing may edit index.html to plant a
    bug), so the detector is run against a synthetic pre-paint block that reaches for a name the
    tree really does export. Using a REAL export rather than a made-up string is the point: it
    proves the comparison is against the live export list and not against a stale copy.
    """
    exports = _module_exports()
    # A name that is unambiguously a module export and could plausibly be wanted early.
    victim = "uiFontApply" if "uiFontApply" in exports else sorted(exports)[0]

    block = f"try{{ {victim}(20); }}catch(e){{}}"
    code = re.sub(r"'(?:\\.|[^'\\])*'", "''", block)
    hits = [n for n in set(re.findall(r"(?<![\w.$])([A-Za-z_$][\w$]*)", code)) if n in exports]
    assert victim in hits, (
        f"the detector does not see `{victim}` in a pre-paint block that calls it — "
        "test_no_pre_paint_block_reaches_into_a_module is decorative")

    # And the real blocks, which are clean, must not trip it — a detector that flags everything
    # satisfies the line above and destroys the file.
    assert not [n for n in set(re.findall(r"(?<![\w.$])([A-Za-z_$][\w$]*)",
                                          "try{var _t=localStorage.getItem('x');}catch(e){}"))
                if n in exports], (
        "the detector flags an ordinary pre-paint restore that touches nothing but localStorage — "
        "it is over-matching, and would be switched off within a week")
