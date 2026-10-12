"""The text the SillyTavern extension sends for a message: line breaks kept, and a message with
no letter or digit in it never sent. The checks are in st_message_text_spec.mjs, which runs
`cleanText` and `bodyFor`'s rule out of the extension's own source."""
import shutil
import subprocess

import pytest

from conftest import assert_spec_ran
from vocalis.runtime import paths

NODE = shutil.which("node")
SPEC = paths.BASE_DIR / "tests" / "st_message_text_spec.mjs"
EXT = paths.BASE_DIR / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_message_keeps_its_line_breaks_and_a_wordless_one_is_never_sent():
    r = subprocess.run([NODE, str(SPEC), str(EXT)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"the message text spec failed:\n{r.stdout}\n{r.stderr}"
    assert_spec_ran(r, SPEC)
