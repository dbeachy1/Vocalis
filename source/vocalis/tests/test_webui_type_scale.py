"""The root type-scale setting controls page text. Components should inherit it rather than hard-coding a second scale."""
import re
from pathlib import Path

from conftest import page_html  # noqa: F401  (sys.path side effect)

from vocalis.runtime import paths

HTML = Path(paths.WEBUI) / "index.html"


def _html() -> str:
    """The page AS SERVED. Every check in this file is about a font-size DECLARATION, and
    those left index.html for src/webui/css/ at 7.3.19 — see conftest.page_html."""
    return page_html()


def test_no_font_size_is_stated_in_pixels():
    """🔴 THE WHOLE GUARD. 44 declarations were converted; the count of survivors is zero.

    ⚠️ Two things are deliberately NOT covered, and neither matches this pattern, so nobody
    needs to carve out an exception for them:

      * SVG `font-size="10"` -- an ATTRIBUTE (`=`, not `:`), in user-space units inside a
        `viewBox`. Those labels scale with the chart they annotate; `rem` there would pin chart
        text to page text, which is wrong in both directions.
      * `'font-size:' + Math.round(px * 0.44) + 'px'` -- the avatar initial, computed at runtime
        from the avatar's own pixel size, so it is already relative to the thing it sits in.

    If a future reader "finishes the job" on either, this docstring is the reason not to.
    """
    hits = re.findall(r".{0,60}font-size:\s*[0-9.]+px.{0,20}", _html())
    assert not hits, (
        "a font size is hard-wired to pixels again, which opts it out of `--fs`:\n  "
        + "\n  ".join(hits))


def test_the_root_is_pinned_to_the_knob():
    """`rem` means nothing without an explicit root. Unpinned, 1rem is the browser's default
    rather than the app's base, so every converted size would jump the moment the base moves --
    in the opposite direction from the one intended."""
    html = _html()
    assert re.search(r"--fs:\s*[0-9.]+px", html), "`--fs` is gone from :root"
    assert re.search(r"html\{[^}]*font-size:\s*var\(--fs\)", html), (
        "`html` no longer reads `--fs`, so the knob is disconnected and rem falls back to the "
        "browser default")


def test_body_follows_the_root_rather_than_restating_it():
    """The body follows the root type scale so inputs and other controls inherit the same setting."""
    m = re.search(r"\bbody\{[^}]*\bfont:\s*([^;/]+)/", _html())
    assert m, "the body font shorthand is gone or reshaped -- check this test still describes it"
    assert m.group(1).strip() == "1rem", (
        f"body states its size as {m.group(1).strip()!r} instead of inheriting the root; "
        "`font:inherit` controls will not follow `--fs`")


def test_the_form_controls_inherit():
    """The four editable types are one rule. If that rule ever stops saying `font:inherit`, the
    boxes stop tracking the base and this whole mechanism misses the thing it was built for."""
    m = re.search(r"input\[type=text\][^{]*textarea\{([^}]*)\}", _html())
    assert m, "the shared input/textarea/select rule has been split or renamed"
    assert "font:inherit" in m.group(1).replace(" ", ""), m.group(1)
