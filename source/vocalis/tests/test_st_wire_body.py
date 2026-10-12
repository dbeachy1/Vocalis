"""9.5.17 — the extension's POST body must carry every field the server reads.

The body is assembled field by field in pushDone, so each field can be valid on both sides of the
interface yet be omitted in transit. The spec extracts the real body-building function and pins
the complete payload shape, including the report, reference, and avatar fields.
"""
from __future__ import annotations

import shutil
import subprocess

from vocalis.runtime import paths

import pytest

#: Located the way every sibling spec locates it — `conftest` does not export one.
NODE = shutil.which("node")

SPEC = paths.BASE_DIR / "tests" / "st_wire_body_spec.mjs"
EXT = paths.BASE_DIR / "sillytavern" / "extension"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_push_report_body_carries_every_field_the_server_reads():
    r = subprocess.run([NODE, str(SPEC), str(EXT)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"the wire body spec failed:\n{r.stdout}\n{r.stderr}"
    # 🔴 AND IT RAN TO THE END. An early return or a renamed function exits 0 and is merely
    # SHORTER, which is the shape of a spec that stops being able to fail.
    assert r.stdout.count("  ok   ") >= 12, \
        f"the spec printed fewer checks than it defines — did a block stop executing?\n{r.stdout}"
