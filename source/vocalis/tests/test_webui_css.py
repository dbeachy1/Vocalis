"""The stylesheet split keeps page styles in independently served files while preserving their order and cascade. Route and rendering checks cover the user-visible result."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from conftest import REPO_ROOT, page_css  # noqa: F401  (sys.path side effect)

from vocalis.runtime import paths

INDEX = paths.WEBUI / "index.html"
CSSDIR = paths.WEBUI / "css"

_LINK = re.compile(r'<link[^>]*rel="stylesheet"[^>]*href="/webui/css/([^"]+)"')

#: The longest any ONE stylesheet may be. `wbedit.css` is 252 lines and is the biggest by some way
#: — it holds the whole worldbook editor — so this is ~1.6x the largest real file.
#:
#: ⚠️ ITS JOB IS TO STOP ONE FILE BECOMING THE NEW INLINE BLOCK. A split is only worth its churn
#: while the pieces stay legible; "put it in base.css" is exactly how 886 lines accumulated in the
#: first place, one reasonable addition at a time. Crossing this means the file wants splitting
#: again, NOT that the number wants raising — the same sentence `test_webui_size.py` carries, for
#: the same reason.
FILE_LINE_CEILING = 400


def _linked() -> list[str]:
    return _LINK.findall(INDEX.read_text(encoding="utf-8"))


@pytest.fixture
def client():
    """The app's own test client — the same shape `test_server.py` uses.

    Imported INSIDE the fixture rather than at module scope: everything above is a filesystem
    check that must stay collectable on a box where importing `vocalis_server` (and torch behind
    it) is expensive or impossible.
    """
    import vocalis_server as vs
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


def test_the_page_carries_no_inline_style_block():
    """🔴 THE STRUCTURAL HALF OF THE RATCHET, and the reason it is a shape rather than a number.

    `PAGE_LINE_CEILING` alone is satisfied by putting 60 lines of CSS back in the page and taking
    60 lines of markup out. This is the statement that actually holds: the page has no `<style>` at
    all, so there is nowhere for a rule to be added inline "just this once". Zero is not a smaller
    number than 886 — it is a different kind of claim, and it cannot be walked back a line at a
    time.

    ⚠️ `<style>` ONLY, not the `style=` attribute. Inline attribute styles are used all over this
    page for one-off `display:none` seeds that the modules toggle, and they are not what grew the
    file — a rule that banned them would be reverted within a week, which is the fastest way to
    lose a guard.

    🔴 HTML COMMENTS ARE STRIPPED FIRST, AND THIS TEST FAILED ON ITS OWN FIRST RUN WITHOUT IT. The
    `<link>` block's comment explains what it replaced, so it contains the literal word `<style>`
    — and the check went red on the file it was written to pass. `test_webui_size.py` carries the
    identical note about `Object.assign(window`, arrived at the identical way. **A guard that
    cannot survive being DESCRIBED is a guard that gets reworded around instead of satisfied.**
    """
    src = re.sub(r"<!--.*?-->", "", INDEX.read_text(encoding="utf-8"), flags=re.S)
    blocks = re.findall(r"<style[^>]*>", src, re.I)
    assert not blocks, (
        f"index.html has grown a <style> block again ({len(blocks)} of them).\n"
        "\n"
        "  PUT THE RULES IN THE RIGHT FILE UNDER src/webui/css/ AND LINK IT. The page's CSS was "
        "886 inline lines in a 2,799-line file with a 2,800-line ceiling on it, which is how this "
        "split happened at all - see this module's docstring. An inline block also silently OUTRANKS "
        "the linked files for equal specificity, because it comes later in the document, so 'just "
        "this one rule' here quietly beats the file it belongs in.")


def test_every_linked_stylesheet_exists_and_nothing_is_orphaned():
    """Both directions, because each failure is silent in its own way.

    A link with no file is an unstyled page nobody's test notices (see the module docstring). A file
    with no link is 80 lines of dead CSS that reads as live — worse than deleting it, because the
    next person edits it and wonders why nothing changes.
    """
    linked = _linked()
    assert linked, "index.html links no stylesheets at all — the whole page is unstyled"
    on_disk = sorted(p.name for p in CSSDIR.glob("*.css"))

    missing = [n for n in linked if not (CSSDIR / n).is_file()]
    assert not missing, (
        f"index.html links stylesheets that do not exist: {missing}. A missing stylesheet throws "
        "nothing and logs nothing - the page just renders unstyled.")

    orphans = sorted(set(on_disk) - set(linked))
    assert not orphans, (
        f"src/webui/css holds files nothing links: {orphans}. Either link them or delete them - "
        "dead CSS that looks live is how a rule gets 'fixed' three times without effect.")


def test_the_link_order_is_the_cascade():
    """🔴 THE INVARIANT THE WHOLE SPLIT RESTS ON — see the module docstring.

    The files were cut from contiguous ranges of one block, so their order is not a preference, it
    is the original source order. This pins it as data: if a file is added or the tags are
    reordered, someone has to come here and say so deliberately, having thought about what now
    outranks what.

    ⚠️ NOT `sorted()`, NOT `glob` ORDER. Alphabetical would put `base.css` after `wbedit.css`'s
    neighbors and `items.css` before `header.css` — a cascade nobody designed, arrived at by the
    filesystem. That is precisely the accident this test exists to make impossible.
    """
    assert _linked() == [
        "base.css",      # tokens, both themes, reset, base type — everything downstream reads these
        "header.css",    # header, brand, the two control rows, edition tag
        "controls.css",  # main/panel/label/inputs/buttons/tabs
        "strip.css",     # the hardware strip: cards, bars, devices, satellites
        "logs.css",      # log panes and the library header that wraps them
        "wbedit.css",    # SillyTavern cards + worldbook editor
        "meters.css",    # playground table, and the ubar/ustat readout vocabulary
        "sysrows.css",   # the header's system lines: swap, PSI, power, UPS, board temps
        "items.css",     # list items, voices, tab wrappers, voice candidates
        "media.css",     # stems, pills, badges, modal, cleanup
        # 8.0-m2 — the ACE-Step tab's per-card model rows. LAST on purpose, and the position
        # costs nothing: every selector in it is new (`.acecards`, `.acecard`, `.acedev`,
        # `.acemodel`, `.acestate`), so it wins no equal-specificity tie and nothing above it
        # changes rank. It is also NOT one of the ten pieces the 886-line block was cut into —
        # it is a new file for a new tab, so it goes after them all rather than into the middle,
        # where a cut-point would falsely imply it had always been there.
        "acestep.css",
        # 9.0.12 — a CONTIGUOUS TAIL of acestep.css, not a new subject. That file crossed the
        # 400-line ceiling above, whose message is SPLIT IT rather than raise it, so the card's own
        # controls (Advanced, the mode selector, the LoRA row) came off the END. A suffix is the
        # only cut that costs nothing here: head + tail concatenated in this order is byte-for-byte
        # the file that shipped, so no rule changed rank. A cut from the MIDDLE would have been a
        # cascade change wearing a refactor's clothes. It must stay immediately after acestep.css.
        "aceform.css",
    ], (
        "the stylesheet link order in index.html changed. THAT IS A CASCADE CHANGE, not a tidy-up: "
        "equal-specificity rules are resolved by source order, and the first ten files ARE one "
        "886-line block cut into contiguous pieces. If the change is deliberate, update this list "
        "and say in the commit message which rules now outrank which.")


@pytest.mark.parametrize("name", sorted(p.name for p in CSSDIR.glob("*.css")))
def test_no_stylesheet_has_become_the_new_inline_block(name):
    """One file per parameter, so the failure names the file instead of a total."""
    n = len((CSSDIR / name).read_text(encoding="utf-8").splitlines())
    assert n <= FILE_LINE_CEILING, (
        f"src/webui/css/{name} is {n:,} lines, over the {FILE_LINE_CEILING:,}-line per-file "
        "ceiling. SPLIT IT - do not raise this. The point of the split is legible pieces, and a "
        "600-line stylesheet is the inline block again wearing a filename.")


def test_the_stylesheets_are_served_by_the_route_that_claims_them(client):
    """A linked stylesheet must be served by the route assigned to it; checking only the markup cannot prove the asset is available."""
    for name in _linked():
        r = client.get(f"/webui/css/{name}")
        assert r.status_code == 200, f"/webui/css/{name} returned {r.status_code}, not 200"
        assert "text/css" in r.headers["Content-Type"], (
            f"/webui/css/{name} is served as {r.headers['Content-Type']!r}, and a stylesheet with "
            "the wrong MIME type is ignored by the browser entirely")
        assert r.headers.get("Cache-Control") == "no-cache", (
            f"/webui/css/{name} is served without revalidation - a deploy would leave browsers on "
            "the old layout with no error anywhere")
        assert r.headers.get("ETag"), (
            f"/webui/css/{name} carries no ETag, so `no-cache` degrades to a full re-download of "
            "the stylesheet on every single page load")


@pytest.mark.parametrize("attack", [
    "../index.html",              # the page itself, one level up
    "../../tts_utils.py",         # out of webui entirely
    "..%2f..%2fvault.py",         # the encoded form, in case something decodes twice
    "main.js",                    # the OTHER tree's suffix — css/ must not serve js/
])
def test_the_css_route_refuses_to_leave_its_own_tree(client, attack):
    """🔴 IT TAKES A CALLER-SUPPLIED PATH. This is the same guard `/webui/js/` has always had, and
    after 7.3.19 it is literally the same code — `_webui_asset` serves both trees off one table,
    so there is no second copy to drift. These cases are what that consolidation has to keep true.

    `main.js` is in the list for a reason that is not traversal: the suffix check is what stops
    `css/` handing out a module (and `js/` handing out a stylesheet), which would otherwise be a
    perfectly ordinary-looking way to read files the other route is meant to own.
    """
    assert client.get(f"/webui/css/{attack}").status_code == 404


def test_the_helper_the_layout_tests_measure_with_returns_the_real_page_css():
    """⚠️ `page_css()` IS NOW LOAD-BEARING FOR EVERY LAYOUT TEST IN THE SUITE, and a helper that
    quietly returned "" would turn `test_strip_layout.py`'s measurements into measurements of an
    unstyled page — which do not fail, they just stop meaning anything. (That file's whole subject
    is a hand copy of the header going stale; this is the same hazard one level down.)

    So: the concatenation is non-trivial, and it carries a rule from the FIRST file and a rule from
    the LAST, i.e. the whole cascade actually arrived rather than one arbitrary piece of it.
    """
    css = page_css()
    assert len(css.splitlines()) > 800, (
        f"page_css() returned {len(css.splitlines())} lines - the page's CSS is ~886 and every "
        "layout test in the suite measures whatever this returns")
    assert "--panel:" in css, "the design tokens from base.css are missing — first file not read"
    assert ".clnlog{" in css, "the cleanup rules from media.css are missing — last file not read"


# ── an outline pill must not be given a matching fill ────────────────────────────────────────────


def test_no_flag_pill_is_painted_its_own_text_color():
    """A status pill must use a distinct background and text color so its label remains readable."""
    def _fills_without_a_color(decl):
        """A declaration block that paints a background without saying what color the text is.

        ⚠️ `border-color` CONTAINS THE SUBSTRING `color:` and must not count as one — that is what
        the pill legitimately sets alongside its text color.
        """
        return "background" in decl and "color:" not in decl.replace("border-color:", "")

    # 🔴 THE MARKUP SCAN REACHES index.html TOO, AND MATCHES A CLASS LIST. It used to read only
    # `src/webui/js/**/*.js` and only the exact attribute `class="flag"`, so a badge written in the
    # page rather than in a module — or written `class="flag ok"`, which is ordinary markup and is
    # how the `--ok` variants are spelled — was invisible to it.
    roots = sorted((Path(REPO_ROOT) / "src" / "webui" / "js").rglob("*.js"))
    roots.append(Path(REPO_ROOT) / "src" / "webui" / "index.html")
    offenders = []
    for f in roots:
        if not f.exists():
            continue
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for m in re.finditer(r'class="(?:[^"]*\s)?flag(?:\s[^"]*)?"([^>]*)', line):
                style = re.search(r'style="([^"]*)"', m.group(1))
                if style and _fills_without_a_color(style.group(1)):
                    offenders.append(
                        f"{f.relative_to(Path(REPO_ROOT)).as_posix()}:{n}  "
                        f'style="{style.group(1)}"')

    # 🔴 AND THE STYLESHEET, WHICH IS THE ONE THIS DOCSTRING NAMES AND THE ONE IT NEVER READ.
    # `.flag{background:var(--warn)}` added to items.css would repaint every badge in the app at
    # once — strictly worse than the inline override that caused the incident — and the guard
    # written to prevent exactly that was looking only at the markup.
    for css in sorted((Path(REPO_ROOT) / "src" / "webui" / "css").rglob("*.css")):
        text = css.read_text(encoding="utf-8")
        for m in re.finditer(r"([^{}]*)\{([^{}]*)\}", text):
            sel, body = m.group(1), m.group(2)
            if ".flag" in sel and _fills_without_a_color(body):
                n = text[:m.start()].count(chr(10)) + 1
                offenders.append(
                    f"{css.relative_to(Path(REPO_ROOT)).as_posix()}:{n}  "
                    f"{sel.strip()} {{{body.strip()}}}")

    assert not offenders, (
        "a `.flag` pill sets a background without setting its own text color:\n\n  "
        + "\n  ".join(offenders)
        + "\n\n  `.flag` is an OUTLINE pill: items.css gives it `color:var(--warn)` and a matching\n"
        "  border, with no fill. Filling it with the same variable paints the text the color of\n"
        "  the background, which can hide the label. The test checks text contrast as well as fill.\n\n"
        "  Either drop the background and let it be the outline pill it was designed as, or set a\n"
        "  `color:` that reads against the fill you chose."
    )
