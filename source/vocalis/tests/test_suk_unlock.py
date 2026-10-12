"""A locked-vault 401 re-opens the vault with the tab's SUK instead of signing the user out.

Drives tests/suk_unlock_spec.mjs against the real util/suk.js and util/http.js. Skips when node
isn't installed — same contract as test_stems_ui.py.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SPEC = Path(__file__).with_name("suk_unlock_spec.mjs")


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_locked_401_redeems_the_session_unlock_key_instead_of_signing_out():
    r = subprocess.run([NODE, str(SPEC)], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=60)
    assert r.returncode == 0, f"node spec failed:\n{r.stdout}\n{r.stderr}"
