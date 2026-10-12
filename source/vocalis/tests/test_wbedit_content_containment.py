"""Tests that field content stays out of logs, console output, and error messages."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
BASELINE = REPO / "reference" / "wbedit-baseline" / "wb_batch_edit.py"
CARD = REPO / "reference" / "wbedit-baseline" / "prompts" / "Section-Editor.json"

MOCK_TRIGGER = "Test Character 1"          # the only string the mock backend rewrites

# One unique, greppable marker per field body. Deliberately not a substring of any label,
# filename, or protocol token — a marker that collides with something legitimately printed
# would make this test fail for a reason that is not a leak.
SENTINELS = [f"ZQ{n}CONTENTMARKER{n}QZ" for n in range(1, 6)]

# The surfaces that must never carry a field body. Named individually and on purpose — see the
# module docstring. (name, extractor)
_SURFACES = (
    ("stdout", lambda p: p.stdout),
    ("stderr", lambda p: p.stderr),
)


def _book(sentinels: list[str]) -> dict:
    """Build a compiled lorebook whose entries carry distinct markers for output checks."""
    return {
        "entries": {
            str(i): {
                "uid": i,
                "key": [f"key{i}"],
                "comment": ("X-the reveal" if i == 1 else f"Entry {i}"),
                "content": f"{MOCK_TRIGGER} keeps the ledger at {s}, and says nothing about it.",
                "constant": False, "order": 100 + i, "disable": False,
            }
            for i, s in enumerate(sentinels)
        }
    }


def _run(tmp_path: Path, *extra: str, mock: bool = True) -> subprocess.CompletedProcess:
    src = tmp_path / "book.json"
    src.write_text(json.dumps(_book(SENTINELS), indent=2, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    out = tmp_path / "book.out.json"
    instruction = tmp_path / "instruction.md"
    instruction.write_text("Rename the quill throughout.\n", encoding="utf-8")
    cmd = [sys.executable, str(BASELINE), "--in", str(src), "--out", str(out),
           "--instruction", str(instruction), "--card", str(CARD)]
    cmd += ["--mock"] if mock else []
    cmd += list(extra)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=180)


def _report(tmp_path: Path) -> str:
    return (tmp_path / "book.out.report.md").read_text(encoding="utf-8")


# ------------------------------------------------------------------------------- tests


X_INDEX = 1                              # the entry whose comment starts with "X-"


def test_the_report_carries_the_field_text_which_is_what_makes_the_rest_meaningful(tmp_path):
    """Checks that the report carries the field text which is what makes the rest meaningful."""
    proc = _run(tmp_path)
    assert proc.returncode == 0, f"exit {proc.returncode}\n{proc.stdout}\n{proc.stderr}"
    report = _report(tmp_path)
    missing = [s for s in SENTINELS if s not in report]
    assert not missing, (
        f"the report is missing {len(missing)} of {len(SENTINELS)} field bodies {missing} "
        "— the run did not process what this test assumes it did, so the containment checks "
        "below are vacuous")


@pytest.mark.parametrize("surface", [n for n, _ in _SURFACES])
def test_no_field_body_reaches_the_console_on_a_normal_run(surface, tmp_path):
    proc = _run(tmp_path)
    text = dict(_SURFACES)[surface](proc)
    leaked = [s for s in SENTINELS if s in text]
    assert not leaked, f"{len(leaked)} field bodies leaked into {surface}: {leaked}\n{text}"


@pytest.mark.parametrize("surface", [n for n, _ in _SURFACES])
def test_no_field_body_reaches_the_console_when_the_model_is_unreachable(surface, tmp_path):
    """Checks that no field body reaches the console when the model is unreachable."""
    proc = _run(tmp_path, "--api", "http://127.0.0.1:9", "--retries", "0", "--timeout", "5",
                mock=False)
    text = dict(_SURFACES)[surface](proc)
    leaked = [s for s in SENTINELS if s in text]
    assert not leaked, f"{len(leaked)} field bodies leaked into {surface} on the error path: {leaked}\n{text}"


def test_no_field_body_reaches_a_traceback_when_the_document_is_malformed(tmp_path):
    """Checks that no field body reaches a traceback when the document is malformed."""
    src = tmp_path / "book.json"
    body = json.dumps(_book(SENTINELS), indent=2, ensure_ascii=False)
    src.write_text(body.replace('"entries": {', '"entries": {{', 1), encoding="utf-8")
    out = tmp_path / "book.out.json"
    instruction = tmp_path / "instruction.md"
    instruction.write_text("Rename the quill.\n", encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(BASELINE), "--in", str(src), "--out", str(out),
         "--instruction", str(instruction), "--card", str(CARD), "--mock"],
        capture_output=True, text=True, timeout=120)

    both = proc.stdout + proc.stderr
    leaked = [s for s in SENTINELS if s in both]
    assert not leaked, f"a malformed document put {len(leaked)} field bodies on the console: {leaked}\n{both}"
    assert "Traceback (most recent call last)" not in proc.stderr, (
        f"an unparseable input raised instead of being reported — a traceback is an "
        f"uncontrolled surface:\n{proc.stderr}")


def test_an_x_titled_entry_is_edited_and_reported_exactly_like_the_others(tmp_path):
    """Checks that an x titled entry is edited and reported exactly like the others."""
    proc = _run(tmp_path)
    assert proc.returncode == 0, proc.stderr
    report = _report(tmp_path)
    assert "X-the reveal" in report, "the X entry's own title should appear, unhidden"
    assert SENTINELS[X_INDEX] in report, "the X entry's text is missing from the report"
    assert "[sealed" not in report, f"sealed-mode reporting is present:\n{report[:2000]}"
