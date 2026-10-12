"""Controlled cross-boundary integration coverage for Polish text and send."""

import shutil
import subprocess
from pathlib import Path

import pytest


NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_polish_send_cross_boundary_contract():
    """Run the real extension against controlled settings, host, DOM, and Send boundaries."""
    spec = Path(__file__).with_name("st_polish_send_integration_spec.mjs")
    result = subprocess.run(
        [NODE, str(spec)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "st_polish_send_integration_spec: ok" in result.stdout
