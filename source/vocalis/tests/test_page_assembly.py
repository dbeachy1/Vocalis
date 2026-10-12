"""`runtime/page.assemble()` — the page built from its parts (9.0-m0, TECH_DEBT #1).

🔴 **WHAT THIS FILE IS GUARDING.** `index.html` is being split into per-tab includes because it
sat on its line ceiling and the register's standing instruction was that the next markup change
does the extraction. The split introduces a templating engine into a file that was previously
served by three `str.replace` calls, and an engine brings its own failure modes to a page that
has been safe from them for a year. Each test below pins one of those.

⚠️ **The one that is easy to get wrong is `test_double_braces_are_literal`.** Making `{{CSRF}}`,
`{{ADMIN_USER}}` and `{{UI_STATE}}` into Jinja variables is the obvious implementation — they are
already written in Jinja's syntax. It is wrong, and the page proves it: four `{{...}}` in there
are prose, not placeholders, and one of them would substitute the account's UI state into an HTML
comment on every load. Nothing else in the suite asserts on comment text, so that would ship.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from vocalis.runtime import page, paths

REPO_ROOT = Path(__file__).resolve().parents[1]
INDEX = REPO_ROOT / "src" / "webui" / "index.html"


def test_assembled_page_matches_the_file_byte_for_byte_until_markup_moves():
    """🔴 THE MECHANISM LANDED WITHOUT MOVING ANYTHING, AND THAT IS PROVABLE.

    m0 is two separately verifiable events: introduce the assembler, then move the markup. While
    nothing is extracted this equality holds exactly, so a regression in the *engine* cannot hide
    behind a regression in the *extraction*.

    ⚠️ **This test retires the moment the first panel moves** — replace it with the coverage
    below rather than deleting it silently. It is here to make the first step honest, not forever.
    """
    if "{% include" in INDEX.read_text(encoding="utf-8"):
        pytest.skip("markup has been extracted; byte-identity no longer applies (see docstring)")
    assert page.assemble().encode("utf-8") == INDEX.read_bytes()


def test_line_endings_follow_the_checkout_not_a_hardcoded_guess():
    """🔴 `core.autocrlf=true`: THIS FILE IS CRLF ON WINDOWS AND LF ON POSIX.

    Jinja normalizes newlines to `newline_sequence`, default `\\n`. Left alone the assembler
    returned a page **2,005 bytes shorter than the file it read** — one byte per line — which is
    the shape of bug that reads as "nothing changed" until a regex that spans a line break stops
    matching. Hard-coding `\\r\\n` fixes Windows and breaks POSIX; this asserts the detection.
    """
    on_disk = INDEX.read_bytes()
    expected = b"\r\n" if b"\r\n" in on_disk[:65536] else b"\n"
    out = page.assemble().encode("utf-8")
    assert expected in out, "the assembled page lost the checkout's line ending"
    if expected == b"\r\n":
        assert out.count(b"\n") == out.count(b"\r\n"), "mixed endings: some lines were normalized"


def test_double_braces_are_literal_so_prose_cannot_be_substituted(tmp_path, monkeypatch):
    """🔴 VARIABLES ARE DISABLED. FOUR `{{...}}` IN THE PAGE ARE TEXT, NOT PLACEHOLDERS.

    Three are `{{user}}` in comments about SillyTavern's macro; one is a comment quoting
    `{{UI_STATE}}` while describing the substitution. With variables live, the first three render
    empty and the fourth **leaks the UI state into a comment**. Both are invisible to every other
    test in this suite, because none of them read comment text.
    """
    # DOCKER EDITION: the page is now a bundle shell and the prose `{{user}}` comments no longer live
    # in the assembled HTML, so counting them there proves nothing. The mechanism is exercised
    # directly instead: a template tree with `{{user}}` prose and a comment quoting `{{UI_STATE}}`,
    # run through the same environment. (A real page is checked for its placeholders below.)
    (tmp_path / "index.html").write_text(
        "<!-- SillyTavern macro {{user}} and {{user}} and {{user}}; quoting {{UI_STATE}} -->\n"
        "<meta name=\"csrf\" content=\"{{CSRF}}\">\n",
        encoding="utf-8")
    with monkeypatch.context() as scoped:  # scoped, so the REAL page below sees the real WEBUI path
        scoped.setattr(paths, "WEBUI", tmp_path)
        page.reset_cache()
        try:
            synthetic = page.assemble()
        finally:
            page.reset_cache()
    assert synthetic.count("{{user}}") == 3, (
        "'{{user}}' vanished from the page - Jinja variables have been re-enabled and are eating "
        "prose. See runtime/page.py: variable_start_string is moved on purpose."
    )
    assert "{{UI_STATE}}" in synthetic and "{{CSRF}}" in synthetic

    # The three route placeholders must ALSO survive assembly of the REAL page untouched - the route
    # substitutes them afterward, in a documented order, and that order is what stops injected prose
    # containing a literal {{ADMIN_USER}} from being re-expanded.
    out = page.assemble()
    for ph in ("{{CSRF}}", "{{ADMIN_USER}}", "{{UI_STATE}}"):
        assert ph in out, f"{ph} did not survive assembly; the route can no longer substitute it"


def test_no_ui_state_json_can_reach_a_comment():
    """The concrete form of the leak above, asserted on the artifact rather than the mechanism.

    A comment that *mentions* `{{UI_STATE}}` is fine. A comment containing a JSON object is the
    bug. This looks for the shape rather than any particular key, so it still fires if the state's
    contents change.
    """
    for comment in re.findall(r"<!--.*?-->", page.assemble(), re.S):
        assert not re.search(r'\{\s*"[A-Za-z_]+"\s*:', comment), (
            "an HTML comment contains a JSON object - the UI state has been substituted into "
            f"prose:\n{comment[:300]}"
        )


def test_includes_are_expanded(tmp_path, monkeypatch):
    """`{% include %}` works, which is the entire point of introducing the engine.

    Built against a temp tree rather than the real page so it keeps passing while the real
    extraction is still in progress, and so it cannot be satisfied by markup that already exists.
    """
    monkeypatch.setattr(paths, "WEBUI", tmp_path)
    page.reset_cache()
    try:
        (tmp_path / "partials").mkdir()
        (tmp_path / "partials" / "bit.html").write_text("<b>INCLUDED</b>\n", encoding="utf-8")
        (tmp_path / "index.html").write_text(
            "<a>{{NOT_A_VARIABLE}}</a>\n{% include 'partials/bit.html' %}\n", encoding="utf-8"
        )
        out = page.assemble()
        assert "<b>INCLUDED</b>" in out, "the include was not expanded"
        assert "{{NOT_A_VARIABLE}}" in out, "a placeholder was eaten by the engine"
        assert "{% include" not in out, "the include tag itself survived into the output"
    finally:
        page.reset_cache()


def test_a_missing_include_fails_loudly_rather_than_rendering_a_hole(tmp_path, monkeypatch):
    """🔴 A PANEL THAT SILENTLY DOES NOT RENDER IS THE WORST OUTCOME OF THIS REFACTOR.

    The failure to avoid is a tab that opens empty in production because its file was renamed.
    Jinja raises `TemplateNotFound` for a missing include; this pins that it is not swallowed, so
    the mistake surfaces as a 500 on the page rather than as one silently missing tab.
    """
    from jinja2 import TemplateNotFound

    monkeypatch.setattr(paths, "WEBUI", tmp_path)
    page.reset_cache()
    try:
        (tmp_path / "index.html").write_text("{% include 'partials/gone.html' %}\n", encoding="utf-8")
        with pytest.raises(TemplateNotFound):
            page.assemble()
    finally:
        page.reset_cache()


def test_the_js_assembler_agrees_with_the_python_one(tmp_path):
    """🔴 THERE ARE TWO ASSEMBLERS, AND THIS IS WHAT MAKES THAT SAFE.

    `tests/_websrc.mjs` expands `{% include %}` in JavaScript because the .mjs harnesses are
    handed the page's REAL path and derive `jsRoot` from its directory — hand them a temp file the
    Python side assembled and they find no modules beside it. So the duplication is forced.

    It is only tolerable because the Python side restricts itself to one static feature. The
    moment either grows a conditional, a loop or a variable, the harnesses would start seeing a
    different page from the one the server sends, and every smoke test would be quietly testing
    fiction. This fails first instead.

    Compared after normalizing newlines: the JS reader folds CRLF to LF on purpose (a CRLF
    checkout zeroes out newline-anchored regexes), while the Python side preserves the checkout's
    endings so `assemble()` round-trips the file.
    """
    node = shutil.which("node")
    if not node:
        pytest.skip("node not on PATH")

    script = tmp_path / "cmp.mjs"
    script.write_text(
        "import { readPage } from %s;\n"
        "process.stdout.write(await readPage(process.argv[2]));\n"
        # Windows ESM refuses a bare drive path ("b:/..."); the specifier must be a file:// URL.
        % json.dumps((Path(__file__).parent / "_websrc.mjs").as_uri()),
        encoding="utf-8",
    )
    r = subprocess.run([node, str(script), str(INDEX)], capture_output=True, timeout=120)
    assert r.returncode == 0, f"node failed: {r.stderr.decode('utf-8', 'replace')[:600]}"

    # readPage also inlines the stylesheets, so compare only up to <body> - the part both build.
    js = r.stdout.decode("utf-8").replace("\r\n", "\n")
    py = page.assemble().replace("\r\n", "\n")
    marker = "<body>"
    assert marker in js and marker in py, "the page lost its <body> - one assembler is broken"
    assert js[js.index(marker):] == py[py.index(marker):], (
        "the JS and Python assemblers disagree about the page body. One of them has grown a "
        "feature the other does not implement - see _websrc.mjs's readPageSource comment."
    )
