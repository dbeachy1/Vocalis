"""Tests World Book assembly, validation, and character-card metadata preservation."""
from __future__ import annotations

import base64
import json
import struct
import zlib

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import assemble as wb
from wbedit.formats import png_card

BASELINE = REPO_ROOT / "reference" / "worldbook-builder" / "build_worldbook.py"


def a_chunk(section="A", name="Core", entries=None, **kw):
    doc = {"section": section, "section_name": name, "entries": entries or []}
    doc.update(kw)
    return doc


def an_entry(**kw):
    e = {"id": "A1", "comment": "A1 — a thing", "keys": ["thing"],
         "content": "A thing exists in the world."}
    e.update(kw)
    return e


# ── expansion ────────────────────────────────────────────────────────────────

def test_a_lightweight_entry_is_expanded_to_the_full_ST_field_set():
    """A chunk entry names four fields; SillyTavern wants forty. Anything the chunk does not
    mention falls back to DEFAULTS, so a chunk author writes only what differs."""
    book, rep = wb.assemble([("A_x.json", a_chunk(entries=[an_entry()]))])
    e = book["entries"]["0"]
    assert e["content"] == "A thing exists in the world."
    assert e["key"] == ["thing"], "`keys` is the chunk-schema alias for ST's `key`"
    assert e["uid"] == 0 and e["displayIndex"] == 0
    assert set(wb.DEFAULTS) <= set(e), "a field ST expects is missing from the expansion"
    for build_only in ("id", "class", "keys", "notes"):
        assert build_only not in e, f"{build_only} is build-only and must never be emitted"


def test_the_assembler_still_stamps_its_own_order_on_a_compiled_book():
    """`DEFAULTS["order"]` remains 20 for books compiled from chunks. The new-entry path changes
    independently; `expand()` retains its existing contract."""
    book, _ = wb.assemble([("A_x.json", a_chunk(entries=[an_entry()]))])
    assert book["entries"]["0"]["order"] == 20 == wb.DEFAULTS["order"]


def test_a_new_entry_takes_the_order_its_neighbors_use():
    """The mode, not the max: a new entry should read as an ordinary member of the book, not
    outrank a constant its author deliberately put on top."""
    entries = {"0": {"order": 100}, "1": {"order": 100}, "2": {"order": 400}}
    assert wb.order_for_new_entry(entries) == 100
    assert wb.new_entry(9, order=wb.order_for_new_entry(entries))["order"] == 100


def test_an_empty_book_falls_back_to_SILLYTAVERNS_default_not_the_assemblers():
    """Checks that an empty book uses SillyTavern's default order, not the assembler default."""
    assert wb.ST_DEFAULT_ORDER == 100
    for empty in ({}, [], None, {"0": {"comment": "no order key"}}):
        assert wb.order_for_new_entry(empty) == 100


def test_a_tie_on_order_breaks_HIGH_because_the_two_failures_are_not_symmetric():
    """Checks that tied entries use the higher order value so a low value cannot make an entry disappear."""
    assert wb.order_for_new_entry({"0": {"order": 20}, "1": {"order": 100}}) == 100


def test_a_boolean_order_does_not_vote():
    """`True` is an `int` in Python, so a hand-edited book carrying `"order": true` would
    otherwise elect an order of 1 — below everything, which is the exact failure being fixed."""
    assert wb.order_for_new_entry({"0": {"order": True}, "1": {"order": 100}}) == 100
    assert wb.order_for_new_entry({"0": {"order": True}}) == 100


def test_new_entry_without_an_order_is_unchanged_from_m4z():
    """The compatibility hinge — `None` keeps the assembler's value, so no caller that has not
    been taught about this moves under it."""
    assert wb.new_entry(0)["order"] == wb.DEFAULTS["order"]


def test_an_unrecognized_field_is_warned_about_and_passed_through_not_dropped():
    """Checks that an unrecognized field is warned about and passed through not dropped."""
    book, rep = wb.assemble([("A_x.json", a_chunk(entries=[an_entry(prohability=50)]))])
    assert any("prohability" in w for w in rep.warnings), rep.warnings
    assert book["entries"]["0"]["prohability"] == 50, "it was dropped rather than passed through"


def test_uids_are_assigned_in_filename_order_whatever_order_they_arrive_in():
    """Checks that uids are assigned in filename order whatever order they arrive in."""
    files = [
        ("C_third.json", a_chunk("C", entries=[an_entry(id="C1", comment="C1")])),
        ("A_first.json", a_chunk("A", entries=[an_entry(id="A1", comment="A1")])),
        ("B_second.json", a_chunk("B", entries=[an_entry(id="B1", comment="B1")])),
    ]
    book, _ = wb.assemble(files)
    assert [book["entries"][str(i)]["comment"] for i in range(3)] == ["A1", "B1", "C1"]


def test_a_build_config_among_the_files_is_used_and_not_treated_as_a_section():
    book, rep = wb.assemble([
        ("build-config.json", {"world_name": "Sample World Book 2", "constant_token_budget": 42}),
        ("A_x.json", a_chunk(entries=[an_entry()])),
    ])
    assert rep.world_name == "Sample World Book 2"
    assert rep.constant_budget == 42
    assert rep.entries == 1, "the config was counted as a section"


# ── validation: errors abort, warnings do not ────────────────────────────────

def test_an_entry_that_can_never_fire_is_an_ERROR_and_nothing_is_assembled():
    """Checks that an entry that can never fire is an error and nothing is assembled."""
    with pytest.raises(wb.AssemblyFailed) as exc:
        wb.assemble([("A_x.json", a_chunk(entries=[an_entry(keys=[])]))])
    assert any("never fire" in e for e in exc.value.errors)


def test_a_noisy_key_is_a_WARNING_and_the_book_is_still_built():
    """…and warnings do NOT abort. A high-frequency key is a judgment call, not a defect."""
    book, rep = wb.assemble([
        ("build-config.json", {"noisy_keys": ["thing"]}),
        ("A_x.json", a_chunk(entries=[an_entry()])),
    ])
    assert book["entries"], "a warning aborted the build"
    assert any("high-frequency" in w for w in rep.warnings)


def test_a_duplicate_id_is_an_error():
    with pytest.raises(wb.AssemblyFailed) as exc:
        wb.assemble([("A_x.json", a_chunk(entries=[an_entry(), an_entry()]))])
    assert any("duplicate" in e for e in exc.value.errors)


def test_empty_content_is_an_error():
    with pytest.raises(wb.AssemblyFailed) as exc:
        wb.assemble([("A_x.json", a_chunk(entries=[an_entry(content="   ")]))])
    assert any("empty content" in e for e in exc.value.errors)


# ── the budget analysis, which §6.5 calls the real prize ─────────────────────

def test_worst_case_concurrency_counts_a_group_as_its_LARGEST_member_not_the_sum():
    """Checks that worst case concurrency counts a group as its largest member not the sum."""
    big = "x" * 4000
    files = [("A_x.json", a_chunk(entries=[
        an_entry(id="A1", comment="A1", keys=["shared"], content=big, group="g"),
        an_entry(id="A2", comment="A2", keys=["shared"], content=big, group="g"),
    ]))]
    _, rep = wb.assemble(files)
    assert rep.worst_key == "shared"
    # one member (4000 chars / 4.0), not two.
    assert 900 < rep.worst_tokens < 1100, rep.worst_tokens


def test_the_constant_footprint_is_reported_against_its_budget():
    files = [("build-config.json", {"constant_token_budget": 5000}),
             ("A_x.json", a_chunk(entries=[
                 an_entry(constant=True, keys=[], content="y" * 2000, ignoreBudget=True)]))]
    _, rep = wb.assemble(files)
    assert rep.constant_tokens == pytest.approx(500.0)
    assert rep.constant_budget == 5000


def test_a_book_over_the_WI_budget_is_an_error_not_a_warning():
    files = [("build-config.json", {"wi_budget_tokens": 100}),
             ("A_x.json", a_chunk(entries=[an_entry(content="z" * 8000)]))]
    with pytest.raises(wb.AssemblyFailed) as exc:
        wb.assemble(files)
    assert any("worst-case concurrency" in e for e in exc.value.errors)


# ── I9, at the assembler ─────────────────────────────────────────────────────

def test_an_X_section_is_assembled_exactly_like_every_other():
    """Checks that the X section is assembled exactly like every other section."""
    files = [("A_open.json", a_chunk("A", entries=[an_entry(id="A1", comment="A1")])),
             ("X_sealed.json", a_chunk("X", entries=[an_entry(id="X1", comment="X1 — the reveal",
                                                              keys=["reveal"])]))]
    book, rep = wb.assemble(files)
    assert rep.entries == 2
    assert book["entries"]["1"]["comment"] == "X1 — the reveal"
    assert book["entries"]["1"]["content"], "an X entry lost its content"
    assert [s["file"] for s in rep.sections] == ["A_open.json", "X_sealed.json"]


# ── the head-to-head against the legacy assembler ───────────────────────────

@pytest.mark.skipif(not BASELINE.is_file(), reason="the vendored baseline is missing")
def test_the_port_reproduces_the_baseline_byte_for_byte(tmp_path):
    """Checks that the port reproduces the baseline byte for byte."""
    import subprocess
    import sys

    sections = tmp_path / "sections"
    sections.mkdir()
    corpus = {
        "A_core.json": a_chunk("A", "Core", entry_limit=1000, entries=[
            an_entry(id="A1", comment="A1 — the world", keys=[], constant=True,
                     ignoreBudget=True, order=100, content="The world is wide."),
            an_entry(id="A2", comment="A2 — the rule", keys=[], constant=True,
                     ignoreBudget=True, order=99, content="Do not write for the user."),
        ]),
        "B_people.json": a_chunk("B", "People", entries=[
            an_entry(id="B1", comment="B1 — Test Character 10", keys=["test", "character"],
                     content="Test Character 1 keeps the ledger.", sticky=2),
            an_entry(id="B2", comment="B2 — the mayor", keys=["mayor"], group="civics",
                     groupWeight=50, content="The mayor is elected and unhappy about it."),
        ]),
        "X_sealed.json": a_chunk("X", "Sealed", entries=[
            an_entry(id="X1", comment="X1 — the reveal", keys=["reveal"],
    content="Unreviewed sample content."),
        ]),
    }
    for fname, doc in corpus.items():
        (sections / fname).write_text(json.dumps(doc, indent=2), encoding="utf-8")
    cfg = {"world_name": "Testland", "out": "book.json", "constant_token_budget": 900,
           "wi_budget_tokens": 12096, "noisy_keys": ["the"]}
    (tmp_path / "build-config.json").write_text(json.dumps(cfg), encoding="utf-8")

    r = subprocess.run([sys.executable, str(BASELINE), "--dir", str(tmp_path), "--quiet"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=120)
    out = tmp_path / "book.json"
    assert out.is_file(), f"the baseline did not build:\n{r.stdout}\n{r.stderr}"
    theirs = json.loads(out.read_text(encoding="utf-8"))

    # Reversed on the way in, to prove the sort is ours and not the caller's.
    files = [("build-config.json", cfg)] + [(f, d) for f, d in reversed(list(corpus.items()))]
    ours, rep = wb.assemble(files)

    assert json.dumps(ours, sort_keys=True) == json.dumps(theirs, sort_keys=True), \
        "the port and the baseline disagree — a DEFAULTS field or the uid order has drifted"
    assert rep.entries == len(theirs["entries"]) == 5


# ── PNG cards (§4.3.1) ───────────────────────────────────────────────────────

def _png(chunks_extra=()):
    """A minimal but structurally real PNG: signature, IHDR, IDAT, IEND, plus extras."""
    def chunk(ctype: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + ctype + data
                + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    body = png_card.PNG_SIGNATURE + chunk(b"IHDR", ihdr)
    for ctype, data in chunks_extra:
        body += chunk(ctype, data)
    body += chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b"")
    return body


def _text(key: str, doc) -> tuple[bytes, bytes]:
    return b"tEXt", key.encode("ascii") + b"\x00" + base64.b64encode(
        json.dumps(doc).encode("utf-8"))


CARD = {"spec": "chara_card_v2", "spec_version": "2.0",
        "data": {"name": "Test Character 2", "description": "A tall woman.", "first_mes": "You again.",
                 "extensions": {"taproom_avatar_focus": {"x": 0.1, "y": 0.2, "w": 0.5}}}}


def test_a_card_is_read_out_of_a_png():
    doc, key = png_card.read_card(_png([_text("chara", CARD)]))
    assert key == "chara"
    assert doc["data"]["name"] == "Test Character 2"


def test_ccv3_wins_over_chara_when_both_are_present():
    """Checks that `ccv3` wins over `chara` when both fields are present."""
    v3 = {"spec": "chara_card_v3", "data": {"name": "Test Character 2", "nickname": "TC2"}}
    doc, key = png_card.read_card(_png([_text("chara", CARD), _text("ccv3", v3)]))
    assert key == "ccv3" and doc["data"].get("nickname") == "TC2"


def test_a_png_with_no_card_says_so_distinctly():
    """Checks that a png with no card says so distinctly."""
    with pytest.raises(png_card.NoCardInPng):
        png_card.read_card(_png())
    with pytest.raises(png_card.NotAPng):
        png_card.read_card(b"this is not a png at all")


def test_the_focus_rect_comes_off_the_card():
    assert png_card.focus_rect(CARD) == {"x": 0.1, "y": 0.2, "w": 0.5}
    assert png_card.focus_rect({"data": {"name": "x"}}) == {}, \
        "absent means 'largest centered square' — the normal case, not a failure"


def test_writing_a_card_back_keeps_every_other_byte():
    """Checks that writing a card back keeps every other byte."""
    foreign = (b"tEXt", b"parameters\x00a ComfyUI workflow blob")
    actl = (b"acTL", struct.pack(">II", 2, 0))          # an animated PNG's control chunk
    blob = _png([foreign, actl, _text("chara", CARD)])

    edited = dict(CARD)
    edited["data"] = dict(CARD["data"], description="A tall, wry woman.")
    out = png_card.write_card(blob, edited)

    back, _ = png_card.read_card(out)
    assert back["data"]["description"] == "A tall, wry woman."
    kinds = [c for c, _ in png_card.chunks(out)]
    assert "acTL" in kinds, "the animation control chunk was dropped — an APNG would be flattened"
    assert any(d.startswith(b"parameters\x00") for c, d in png_card.chunks(out) if c == "tEXt"), \
        "a foreign ancillary chunk was dropped"
    assert kinds[-1] == "IEND" and kinds[0] == "IHDR", "the chunk framing was not preserved"


def test_a_card_png_with_no_card_chunk_gains_one_on_write():
    out = png_card.write_card(_png(), CARD)
    doc, key = png_card.read_card(out)
    assert key == "chara" and doc["data"]["name"] == "Test Character 2"
