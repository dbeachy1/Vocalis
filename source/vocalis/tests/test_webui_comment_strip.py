"""The harnesses' JS corpus is comment-free, and the thing that makes it so changes nothing else.

8.3-m0, DESIGN_8_3_JSDOC_TYPES.md §4.

🔴 WHY THIS GUARD EXISTS AT ALL. 8.3 puts JSDoc type annotations on every module under
src/webui/js/, and ~560 assertions across the .mjs harnesses regex over MODULE SOURCE TEXT served
to them by tests/_websrc.mjs. Comments in that text are a live hazard in both directions:

  * An unanchored POSITIVE assertion is satisfied by a comment QUOTING the code it was meant to
    prove exists. `ok(/fetch\\('\\/api\\/voices\\/delete'\\)/.test(src))` passes off a JSDoc
    @example whether or not the call survives. Green over no product — silent, and the exact
    failure class _websrc.mjs and webui_syntax_check.mjs were both written to prevent.
  * A NEGATIVE assertion goes red because someone documented why a thing was removed. Three of
    those already exist (voices_ui_smoke.mjs:915,916 and swaplib_ui_smoke.mjs:67); they are loud
    rather than silent, so they are the lesser half.

tests/_jscomments.mjs blanks the comments. This file proves it blanks ONLY the comments, because a
stripper that quietly damaged code would turn every harness into a liar about the app instead.

⚠️ THE CHECK RUNS IN NODE, NOT HERE. The subject is a `.mjs` module and the oracle is esbuild;
re-implementing either in Python would be a second, weaker copy of the thing being tested. This
file is the driver that puts it in the suite, which is where the pre-deploy gate actually is.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

ROOT = Path(REPO_ROOT)
CHECKER = ROOT / "tests" / "comment_strip_check.mjs"
STRIPPER = ROOT / "tests" / "_jscomments.mjs"

#: esbuild is optional for source checkouts. Skip when Node or esbuild is absent; the committed bundle remains testable without installing the toolchain.
_NO_NODE = shutil.which("node") is None
_NO_ESBUILD = not (ROOT / "node_modules" / "esbuild").exists()


def test_the_stripper_module_is_still_there():
    """A deleted stripper must fail here, not silently un-guard every harness."""
    assert STRIPPER.exists(), (
        f"{STRIPPER} is gone. tests/_websrc.mjs imports it to blank comments out of the JS "
        "corpus before the harnesses regex over it. Without it every unanchored source assertion "
        "can be satisfied by a comment quoting the code - see DESIGN_8_3_JSDOC_TYPES section 4."
    )
    assert CHECKER.exists(), f"{CHECKER} is gone - the stripper is now unguarded."


@pytest.mark.skipif(_NO_NODE, reason="node is not on PATH")
@pytest.mark.skipif(_NO_ESBUILD, reason="node_modules/esbuild is not installed")
def test_stripping_comments_changes_nothing_else():
    """Every module under src/webui/js, through esbuild, before and after stripping.

    The node side asserts three things this docstring should name so a failure reads plainly:

      1. `stripComments(s).length == len(s)` and the same line count - comment bytes become
         SPACES, block-comment newlines are KEPT. tests/_websrc.mjs slices by byte offset
         (`file.text.match(re).index`) and every harness failure message names a line, so a
         stripper that DELETED comments would pass the esbuild check below and still break both.
      2. esbuild's output is byte-identical before and after, with `minifyWhitespace` on so that
         comments are dropped from BOTH sides. They can then only differ if something that was not
         a comment changed.
      3. At least 40 of the modules actually contained a comment - a green run over a tree the
         stripper never touched would prove nothing.
    """
    r = subprocess.run(["node", str(CHECKER)], capture_output=True, text=True,
                       cwd=str(ROOT))
    assert r.returncode == 0, (
        "tests/comment_strip_check.mjs failed - tests/_jscomments.mjs is changing something "
        "that is not a comment, or has stopped preserving byte offsets.\n\n"
        f"{r.stdout}\n{r.stderr}"
    )


@pytest.mark.skipif(_NO_NODE, reason="node is not on PATH")
@pytest.mark.skipif(_NO_ESBUILD, reason="node_modules/esbuild is not installed")
def test_the_check_goes_red_on_a_stripper_that_eats_code():
    """The guard for the guard: prove the check above can actually fail.

    ⚠️ THIS IS NOT CEREMONY. The first version of the node check passed a `transform` with no
    `minifyWhitespace`, so esbuild PRESERVED comments on both sides and eleven real modules
    "differed" for a reason that had nothing to do with the stripper. The opposite mistake - an
    oracle so loose that nothing can fail it - is the one that ships. So: feed the same comparison
    a deliberately broken stripper and require a non-zero exit.

    The broken one is the regex everybody reaches for first, and its victim is real: this tree
    contains `'https://app.example.invalid:8001'`, and `s.replace(/\\/\\/.*$/gm, '')` truncates that line mid-string.
    """
    probe = r"""
import { transformSync } from 'esbuild';

// The stripper everybody writes first. It is a one-liner and it is wrong.
const broken = (s) => s.replace(/\/\/.*$/gm, '');

// Its victim, which is real source shape from this tree.
const src = "const u = 'https://app.example.invalid:8001';\nconst x = 1;\n";

const o = { loader: 'js', target: 'esnext', format: 'esm', minifyWhitespace: true };
const a = transformSync(src, o).code;
let b;
try { b = transformSync(broken(src), o).code; } catch { process.exit(1); }
process.exit(a === b ? 0 : 1);
"""
    f = ROOT / "temp"
    f.mkdir(exist_ok=True)
    probe_file = f / "_broken_stripper_probe.mjs"
    probe_file.write_text(probe, encoding="utf-8")
    try:
        r = subprocess.run(["node", str(probe_file)], capture_output=True, text=True,
                           cwd=str(ROOT))
        assert r.returncode != 0, (
            "The esbuild comparison passed a stripper that truncates 'https://app.example.invalid:8001' "
            "mid-string. The oracle is not actually checking anything - fix it before trusting "
            "test_stripping_comments_changes_nothing_else."
        )
    finally:
        probe_file.unlink(missing_ok=True)
