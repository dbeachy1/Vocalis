"""Tests document identity, name uniqueness, and reference handling."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
BASELINE = REPO / "reference" / "wbedit-baseline" / "wb_batch_edit.py"
CARD = REPO / "reference" / "wbedit-baseline" / "prompts" / "Section-Editor.json"

# The mock backend rewrites this string and nothing else. Nothing below may contain it — a
# fixture that did would make the test assert "the tool changed nothing" while it changed
# something, which is the vacuous-pass shape 6.1 got bitten by.
MOCK_TRIGGER = "Test Character 1"


# --------------------------------------------------------------------------- fixtures

# A V2 card. Carries deliberate awkwardness: unicode, a nested character_book, an unknown
# top-level key, an empty field, and `alternate_greetings` (which the tool only edits when
# asked, so it must survive untouched here either way).
CARD_DOC = {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "Wren Halloway",
        "description": "A cartographer who has never left the valley — “the maps come to me”.",
        "personality": "Dry. Patient. Allergic to being thanked.",
        "scenario": "The survey office, an hour before dawn.",
        "first_mes": "*She does not look up.* You are early. Sit anywhere that is not the drafting stool.",
        "mes_example": "<START>\n{{user}}: Is the north sheet finished?\n{{char}}: It is finished the way a river is finished.",
        "alternate_greetings": ["*The door is already open.*", "*A lamp, turned low.*"],
        "creator_notes": "Do not let an instruction written for prose touch this.",
        "system_prompt": "",
        "post_history_instructions": "",
        "tags": ["cartography", "slow-burn"],
        "character_book": {
            "name": "Wren's valley",
            "entries": [
                {"id": 0, "keys": ["valley"], "content": "Steep, wet, and mapped only in parts.",
                 "enabled": True, "insertion_order": 10, "extensions": {"depth": 4}},
                {"id": 1, "keys": ["survey office"], "content": "Three rooms and a stove that lies.",
                 "enabled": True, "insertion_order": 20, "extensions": {}},
            ],
        },
        "extensions": {"vocalis": {"voice": "wren"}},
    },
    "unknown_future_key": {"kept": True},
}

# A compiled ST lorebook: `entries` is a DICT with string keys, the key field is `key`.
COMPILED_DOC = {
    "entries": {
        "0": {"uid": 0, "key": ["lantern"], "keysecondary": [], "comment": "The lantern",
              "content": "It burns green when it is lying.", "constant": False, "order": 100,
              "disable": False, "probability": 100, "depth": 4, "group": ""},
        "1": {"uid": 1, "key": ["X-the ending"], "keysecondary": [], "comment": "X-reveal",
              "content": "Withheld from the reader, not from the editor.", "constant": True,
              "order": 900, "disable": False, "probability": 100, "depth": 1, "group": "spoilers"},
    },
}

# A pre-compile section chunk: `entries` is a LIST, the key field is `keys`.
SECTION_DOC = {
    "section": "03",
    "section_name": "Trades and roads",
    "entry_limit": 40,
    "notes": "Machinery. Never edited.",
    "entries": [
        {"comment": "Saltway", "keys": ["saltway", "the road"], "constant": False, "order": 30,
         "content": "Two weeks by cart, one by river, and nobody takes the river."},
        {"comment": "X-the toll", "keys": ["toll"], "constant": False, "order": 31,
         "content": "An X entry is edited like any other — 6.4 I9."},
    ],
}

CASES = {"card": CARD_DOC, "compiled": COMPILED_DOC, "section": SECTION_DOC}


def _dump(doc: object) -> str:
    """Exactly the tool's output form (`wb_batch_edit.py:600`)."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def _key_order(node: object, path: str = "") -> list[str]:
    """Every dict's key sequence, depth-first. `==` on dicts ignores order; this does not."""
    out: list[str] = []
    if isinstance(node, dict):
        out.append(f"{path}: {list(node)}")
        for k, v in node.items():
            out.extend(_key_order(v, f"{path}/{k}"))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.extend(_key_order(v, f"{path}[{i}]"))
    return out


# ------------------------------------------------------------------------------ test


@pytest.mark.parametrize("kind", sorted(CASES))
def test_an_instruction_that_matches_nothing_returns_the_document_unchanged(kind, tmp_path):
    doc = CASES[kind]
    blob = _dump(doc)
    assert MOCK_TRIGGER not in blob, (
        f"the {kind} fixture contains the mock backend's trigger string, so this test would "
        "assert nothing — see the module docstring")

    src = tmp_path / f"{kind}.json"
    src.write_text(blob, encoding="utf-8")
    out = tmp_path / f"{kind}.out.json"
    instruction = tmp_path / "instruction.md"
    instruction.write_text(
        "Rename every occurrence of the airship Peregrine to Meridian.\n"
        "This fixture contains no airship, so nothing should change.\n", encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(BASELINE), "--in", str(src), "--out", str(out),
         "--instruction", str(instruction), "--card", str(CARD), "--mock"],
        capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, f"exit {proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    assert out.exists(), f"no output written\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"

    after = json.loads(out.read_text(encoding="utf-8"))

    # Parsed equality: nothing dropped, added, renamed or retyped.
    assert after == doc, f"{kind}: the document changed under an instruction that matched nothing"

    # Key order: `==` above would not have noticed a reordering.
    assert _key_order(after) == _key_order(doc), f"{kind}: dict key order was not preserved"

    # Byte equality: the serializer round-trips. Fixtures are written in the tool's own form.
    assert out.read_text(encoding="utf-8") == blob, f"{kind}: output was not byte-identical"


@pytest.mark.parametrize("kind", sorted(CASES))
def test_the_identity_check_can_actually_fail(kind, tmp_path):
    """Checks that the identity check can actually fail."""
    doc = json.loads(json.dumps(CASES[kind]))          # deep copy

    # Plant it in the first editable field of whichever shape this is.
    if kind == "card":
        doc["data"]["description"] = f"A cartographer known to the guild as {MOCK_TRIGGER}."
        probe = lambda d: d["data"]["description"]     # noqa: E731
    elif kind == "compiled":
        doc["entries"]["0"]["content"] = f"{MOCK_TRIGGER} keeps the lantern."
        probe = lambda d: d["entries"]["0"]["content"]  # noqa: E731
    else:
        doc["entries"][0]["content"] = f"The saltway is held by {MOCK_TRIGGER}."
        probe = lambda d: d["entries"][0]["content"]    # noqa: E731

    src = tmp_path / f"{kind}.json"
    src.write_text(_dump(doc), encoding="utf-8")
    out = tmp_path / f"{kind}.out.json"
    instruction = tmp_path / "instruction.md"
    instruction.write_text("Rename the quill.\n", encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(BASELINE), "--in", str(src), "--out", str(out),
         "--instruction", str(instruction), "--card", str(CARD), "--mock"],
        capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, f"exit {proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"

    after = json.loads(out.read_text(encoding="utf-8"))
    assert probe(after) != probe(doc), (
        f"{kind}: the mock edit did NOT land, so the identity test above proves nothing "
        f"about this format\nstdout:\n{proc.stdout}")
    assert MOCK_TRIGGER not in probe(after), f"{kind}: the substitution was partial"

    # ...and it changed ONLY that field. This is the other half of the guarantee: an editor
    # that rewrote the whole document would also pass the line above.
    before_rest, after_rest = json.loads(json.dumps(doc)), json.loads(json.dumps(after))
    if kind == "card":
        before_rest["data"]["description"] = after_rest["data"]["description"] = ""
    elif kind == "compiled":
        before_rest["entries"]["0"]["content"] = after_rest["entries"]["0"]["content"] = ""
    else:
        before_rest["entries"][0]["content"] = after_rest["entries"][0]["content"] = ""
    assert after_rest == before_rest, f"{kind}: the edit touched more than its own field"
    assert _key_order(after) == _key_order(doc), f"{kind}: an edit disturbed dict key order"


def test_the_baseline_is_still_here():
    """§2.0 — deleting the original leaves this copy as the only one. A missing
    baseline must fail loudly here rather than silently skipping every case above."""
    assert BASELINE.is_file(), f"the 6.4 baseline is gone: {BASELINE}"
    assert CARD.is_file(), f"the editor card the baseline needs is gone: {CARD}"
