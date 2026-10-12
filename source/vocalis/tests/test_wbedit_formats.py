"""Tests format detection, job collection, and lossless locator edits."""
from __future__ import annotations

import functools
import importlib.util
import json
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import formats
from wbedit.core.locator import get_at, set_at
from wbedit.formats import card, detect, worldbook

BASELINE = Path(__file__).resolve().parent.parent / "reference" / "wbedit-baseline" / "wb_batch_edit.py"


@functools.lru_cache(maxsize=1)
def _baseline():
    """Load the reference module by path and register it before execution so dataclass annotations resolve."""
    name = "wb_batch_edit_baseline"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BASELINE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# --------------------------------------------------------------------------- fixtures

V2_CARD = {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "Test Character 1",
        "description": "A ledger-keeper of the upper wards.",
        "personality": "Precise. Unhurried.",
        "scenario": "The audit has begun.",
        "first_mes": "You're late. Sit.",
        "mes_example": "<START>\n{{user}}: Hello.\n{{char}}: You're late.",
        "creator_notes": "Do not edit this — it is documentation.",
        "system_prompt": "You are {{char}}. Never break character.",
        "post_history_instructions": "Stay in scene.",
        "alternate_greetings": ["The door was open.", "  ", "Again?"],
        "character_book": {
            "entries": [
                {"comment": "Sample Entry 1", "content": "It records every debt."},
                {"comment": "X-the reveal", "content": "The ledger is a forgery."},
                {"comment": "empty one", "content": "   "},
            ]
        },
    },
}

V1_CARD = {
    "name": "Old Format",
    "description": "A flat card with no data wrapper.",
    "personality": "Terse.",
    "scenario": "",
    "first_mes": "Well?",
    "mes_example": "<START>\n{{user}}: Hi.\n{{char}}: Well?",
}

COMPILED_BOOK = {
    "entries": {
        "0": {"uid": 0, "key": ["character"], "comment": "Test Character 1",
              "content": "The ledger-keeper.", "constant": True},
        "1": {"uid": 1, "key": ["ward"], "comment": "X-the upper wards",
              "content": "Nobody goes there."},
        "2": {"uid": 2, "key": [], "comment": "blank", "content": ""},
    }
}

SECTION_FILE = {
    "section": "guilds",
    "section_name": "Sample World Book 1",
    "entry_limit": 40,
    "notes": "drafted 2026",
    "entries": [
        {"keys": ["ledger"], "comment": "Sample Entry 1", "content": "It records every debt."},
        {"keys": ["character"], "content": "Test Character 1 keeps it."},
    ],
}

BARE_LIST = [
    {"keys": ["one"], "comment": "First", "content": "The first entry."},
    {"keys": ["two"], "content": "The second entry."},
]

CASES = {
    "v2_card": V2_CARD,
    "v1_card": V1_CARD,
    "compiled_book": COMPILED_BOOK,
    "section_file": SECTION_FILE,
    "bare_list": BARE_LIST,
}


def deep(doc):
    return json.loads(json.dumps(doc))


# ------------------------------------------------------------------------ 1. detection

@pytest.mark.parametrize("name,kind", [
    ("v2_card", "card"), ("v1_card", "card"),
    ("compiled_book", "worldbook"), ("section_file", "worldbook"), ("bare_list", "worldbook"),
])
def test_each_fixture_is_detected_as_what_it_is(name, kind):
    assert detect.doc_kind(CASES[name]) == kind


def test_a_v2_card_with_an_embedded_book_is_a_CARD_not_a_worldbook():
    """Checks that a v2 card with an embedded book is a card not a worldbook."""
    assert "character_book" in V2_CARD["data"]
    assert detect.doc_kind(V2_CARD) == "card"
    labels = [j.label for j in formats.collect(V2_CARD, rel="test-character-11.json")]
    assert "description" in labels and "first_mes" in labels


@pytest.mark.parametrize("doc", [None, 42, "a string", {"unrelated": 1}, {"data": "not a dict"}])
def test_something_that_is_neither_raises_rather_than_being_skipped(doc):
    assert detect.doc_kind(doc) is None
    with pytest.raises(formats.UnsupportedDocument):
        formats.collect(doc, rel="mystery.json")


# ------------------------------------------------------------------- 2. what gets collected

def test_I13_the_machinery_fields_are_excluded_by_default():
    """creator_notes, system_prompt and post_history_instructions are a contract, not prose. An
    instruction written for character text will do something confident and stupid to them."""
    labels = [j.label for j in formats.collect(V2_CARD, rel="test-character-11.json")]
    for excluded in ("creator_notes", "system_prompt", "post_history_instructions"):
        assert V2_CARD["data"][excluded], \
            f"the fixture must actually carry {excluded}, or this asserts nothing"
        assert excluded not in labels


def test_I13_they_are_overridable_per_pass():
    labels = [j.label for j in formats.collect(
        V2_CARD, rel="test-character-11.json", card_fields=("description", "creator_notes"))]
    assert labels[:2] == ["description", "creator_notes"]


def test_alternate_greetings_are_opt_in_and_each_becomes_its_own_job():
    fields = card.CARD_FIELDS_DEFAULT + ("alternate_greetings",)
    jobs = formats.collect(V2_CARD, rel="test-character-11.json", card_fields=fields)
    greets = [j for j in jobs if j.label.startswith("alternate_greetings")]
    assert [j.label for j in greets] == ["alternate_greetings[0]", "alternate_greetings[2]"], \
        "the blank greeting must be skipped, and the indices must stay the ORIGINAL ones"
    assert greets[1].locator == ("data", "alternate_greetings", 2)


def test_m5d_CARD_FIELDS_ALL_is_every_field_the_editor_can_offer():
    """Checks that card fields all is every field the editor can offer."""
    assert card.CARD_FIELDS_ALL == tuple(card.CARD_KIND)
    assert set(card.CARD_FIELDS_DEFAULT) < set(card.CARD_FIELDS_ALL)


def test_m5d_preselect_marks_machinery_unticked_without_hiding_it():
    """I13 moved from "cannot be seen" to "is not ticked". Both halves are asserted here: every
    field is COLLECTED, and only the prose ones arrive selected."""
    jobs = formats.collect(V2_CARD, rel="test-character-11.json", card_fields=card.CARD_FIELDS_ALL,
                           card_preselect=card.CARD_FIELDS_DEFAULT)
    ticked = {j.label for j in jobs if j.meta["pass_default"]}
    shown = {j.label for j in jobs}
    for machinery in ("creator_notes", "system_prompt", "post_history_instructions",
                      "alternate_greetings[0]"):
        assert machinery in shown, f"{machinery} must be visible and hand-editable"
        assert machinery not in ticked, f"{machinery} must never be in a pass by default"
    assert {"description", "personality", "scenario", "first_mes", "mes_example"} <= ticked


def test_9a32_an_empty_field_is_offered_only_when_the_caller_asks_for_it():
    """Checks that an empty field is offered only when the caller asks for it."""
    thin = {"spec": "chara_card_v2", "data": {"name": "Test Character 11", "description": "A tall woman."}}
    passing = {j.label for j in formats.collect(thin, rel="test-character-11.json",
                                                card_fields=card.CARD_FIELDS_ALL,
                                                card_preselect=card.CARD_FIELDS_DEFAULT)}
    editing = {j.label: j for j in formats.collect(thin, rel="test-character-11.json",
                                                   card_fields=card.CARD_FIELDS_ALL,
                                                   card_preselect=card.CARD_FIELDS_DEFAULT,
                                                   card_empty=True)}
    assert passing == {"description"}
    assert "system_prompt" in editing and "personality" in editing
    assert editing["system_prompt"].original == ""
    assert editing["system_prompt"].meta["empty"] is True
    # 🔴 UNTICKED WHATEVER `preselect` SAYS. `description` IS in the pass default, so an empty one
    # would otherwise arrive selected — the one case where the flag alone is not enough.
    assert editing["personality"].meta["pass_default"] is False
    assert editing["description"].meta["pass_default"] is True
    assert editing["description"].meta["empty"] is False


def test_m5d_preselect_None_ticks_everything_which_is_every_older_caller():
    """Legacy callers that omit `card_preselect` still collect every field."""
    jobs = formats.collect(V2_CARD, rel="test-character-11.json",
                           card_fields=("description", "creator_notes"))
    assert [j.label for j in jobs][:2] == ["description", "creator_notes"]
    assert all(j.meta["pass_default"] for j in jobs)


def test_I9_an_X_titled_entry_is_collected_like_any_other():
    """X-titled entries are collected and reported like other entries."""
    embedded = [j.label for j in formats.collect(V2_CARD, rel="test-character-11.json")]
    assert any(lab.endswith("X-the reveal") for lab in embedded), embedded
    compiled = [j.label for j in formats.collect(COMPILED_BOOK, rel="book.json")]
    assert "X-the upper wards" in compiled


def test_a_blank_field_is_not_an_edit_target():
    labels = [j.label for j in formats.collect(COMPILED_BOOK, rel="book.json")]
    assert "blank" not in labels
    assert "empty one" not in [j.label for j in formats.collect(V2_CARD, rel="test-character-11.json")]


def test_the_two_worldbook_shapes_produce_the_locator_their_container_needs():
    """A compiled book's `entries` is a dict keyed by STRINGS; a section file's is a list keyed by
    ints. `doc["entries"]["0"]` and `doc["entries"][0]` are different lookups."""
    compiled = formats.collect(COMPILED_BOOK, rel="book.json")[0]
    assert compiled.locator == ("entries", "0", "content")
    section = formats.collect(SECTION_FILE, rel="sample-world-book-1.json")[0]
    assert section.locator == ("entries", 0, "content")
    bare = formats.collect(BARE_LIST, rel="loose.json")[0]
    assert bare.locator == (0, "content"), "a bare list has no 'entries' level"


def test_the_section_name_comes_from_the_document_and_falls_back_to_the_filename():
    assert formats.collect(SECTION_FILE, rel="sample-world-book-1.json")[0].meta["section"] == "Sample World Book 1"
    no_name = {"entries": [{"content": "text", "keys": []}]}
    assert formats.collect(no_name, rel="chapters/03 Sample World Book 1.json")[0].meta["section"] == "03 Sample World Book 1"


def test_mes_example_carries_the_note_that_stops_the_model_eating_its_own_separators():
    jobs = {j.label: j for j in formats.collect(V2_CARD, rel="test-character-11.json")}
    assert jobs["mes_example"].meta["note"] == card.EXAMPLE_NOTE
    assert jobs["description"].meta["note"] == ""


# ------------------------------------------------------------------- 3. the locator walk

@pytest.mark.parametrize("name", sorted(CASES))
def test_every_locator_round_trips_through_get_and_set(name):
    doc = deep(CASES[name])
    for j in formats.collect(doc, rel=f"{name}.json"):
        assert get_at(doc, j.locator) == j.original
        set_at(doc, j.locator, "REPLACED")
        assert get_at(doc, j.locator) == "REPLACED"


@pytest.mark.parametrize("name", sorted(CASES))
def test_setting_one_field_changes_nothing_else_including_key_order(name):
    """Checks that setting one field changes nothing else including key order."""
    pristine = deep(CASES[name])
    after = deep(CASES[name])
    jobs = formats.collect(after, rel=f"{name}.json")
    target = jobs[0]
    set_at(after, target.locator, "REPLACED")

    assert json.dumps(after, indent=2) != json.dumps(pristine, indent=2), \
        "set_at wrote nothing — the rest of this test would pass vacuously"

    set_at(after, target.locator, target.original)
    assert json.dumps(after, indent=2) == json.dumps(pristine, indent=2), \
        "something other than the addressed leaf changed — a key moved, appeared or was dropped"

    set_at(after, target.locator, "REPLACED")
    for j in jobs[1:]:
        assert get_at(after, j.locator) == get_at(pristine, j.locator)


def test_set_at_mutates_in_place_which_is_why_the_caller_copies():
    doc = deep(SECTION_FILE)
    set_at(doc, ("entries", 0, "content"), "new")
    assert doc["entries"][0]["content"] == "new"
    assert SECTION_FILE["entries"][0]["content"] == "It records every debt.", \
        "the module-level fixture was mutated — deep() is not deep"


# --------------------------------------------------------------------- 4. faithfulness

@pytest.mark.parametrize("name", sorted(CASES))
def test_the_port_collects_exactly_what_the_baseline_collected(name, tmp_path):
    """Checks that the port collects exactly what the baseline collected."""
    doc = deep(CASES[name])
    src = tmp_path / f"{name}.json"
    src.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    b = _baseline()
    theirs = b.collect_jobs(src, tmp_path, "content", b.CARD_FIELDS_DEFAULT)
    mine = formats.collect(deep(CASES[name]), rel=f"{name}.json")

    assert [j.rel for j in theirs] == [j.rel for j in mine]
    assert [j.locator for j in theirs] == [j.locator for j in mine]
    assert ([t.label for t, j in zip(theirs, mine) if not j.meta.get("group")]
            == [j.label for j in mine if not j.meta.get("group")])
    # And the grouped ones are the baseline's label through exactly one transformation.
    for t, j in zip(theirs, mine):
        if not j.meta.get("group"):
            continue
        want = (f"card book · entry {t.label.split('#')[-1]}"
                if t.label.startswith("embedded book #") else f"card book · {t.label}")
        assert j.label == want, (
            f"an embedded-book label changed in a way §9a.5 did not describe: "
            f"baseline {t.label!r} -> port {j.label!r}, expected {want!r}")
    assert [j.original for j in theirs] == [j.original for j in mine]
    assert [j.meta for j in theirs] == [{k: v for k, v in j.meta.items() if k in t.meta}
                                        for t, j in zip(theirs, mine)]
    # And the port never QUIETLY drops one: every baseline key must still be present by name.
    for t, j in zip(theirs, mine):
        assert set(t.meta) <= set(j.meta), f"the port lost {set(t.meta) - set(j.meta)} from meta"


def test_the_faithfulness_check_can_actually_fail(tmp_path):
    """The control. A collector that silently dropped a field would otherwise sail through the
    test above if BOTH halves dropped it — so prove the comparison is looking at something."""
    doc = deep(SECTION_FILE)
    src = tmp_path / "s.json"
    src.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    b = _baseline()
    theirs = b.collect_jobs(src, tmp_path, "content", b.CARD_FIELDS_DEFAULT)

    shortened = deep(SECTION_FILE)
    shortened["entries"] = shortened["entries"][:1]
    mine = formats.collect(shortened, rel="s.json")
    assert [j.label for j in theirs] != [j.label for j in mine]


@pytest.mark.parametrize("name", sorted(CASES))
def test_the_ported_helpers_agree_with_the_baselines_one_for_one(name):
    b = _baseline()
    doc = CASES[name]
    assert detect.doc_kind(doc) == b.doc_kind(doc)
    if detect.doc_kind(doc) == "worldbook":
        assert [k for k, _e in worldbook.iter_entries(doc)] == [k for k, _e in b.iter_entries(doc)]


# ───────────────────────────────────────────── Library row name

def test_a_bare_list_worldbook_gets_a_name_instead_of_crashing_the_import():
    """Checks that a bare list worldbook gets a name instead of crashing the import."""
    assert detect.doc_kind([{"uid": 0, "keys": [], "content": "x"}]) == "worldbook"
    assert detect.display_name([{"uid": 0}], "worldbook", "Sample World Book 1") == "Sample World Book 1"
    assert detect.display_name([], "worldbook", "") == "untitled"


def test_the_document_names_itself_when_it_can():
    """One helper for both import paths (upload and the ST push), so the same card cannot land in
    the Library under two different names depending on how it arrived."""
    card = {"spec": "chara_card_v2", "data": {"name": "Test Character 2", "first_mes": "hi"}}
    assert detect.display_name(card, "card", "ignored.png") == "Test Character 2"
    assert detect.display_name({"name": "Sample World Book 1", "entries": {}}, "worldbook", "x") \
        == "Sample World Book 1"
    assert detect.display_name({"entries": {}}, "worldbook", "Sample World Book 2") == "Sample World Book 2"


# ── §8.4: a card can arrive carrying a whole World Book that is not in its PNG ──
#
# 🔴 THE DISCRIMINATOR IS `data.extensions.world`. NEVER `character_book.name`.
#
# SillyTavern's `/api/characters/edit` runs `charaFormatData` on the way IN
# (`src/endpoints/characters.js:1291`), and that function does:
#
#     if (data.world) {
#         const file = readWorldInfoFile(directories, data.world, false);
#         if (file && file.originalData) _.set(char, 'data.character_book', file.originalData);
#         if (file && file.entries)      _.set(char, 'data.character_book',
#             convertWorldInfoToCharacterBook(data.world, file.entries));
#     }
#
# So a character with a World Book assigned gets THE WHOLE BOOK baked into `data.character_book`
# on every save, and reads it back out again forever after.
#
# Cover embedded-book ownership in both directions: a mirrored book may be nameless, while a
# card-native embedded book without a linked world remains editable.
# `charaFormatData:763` always sets `data.extensions.world` (`data.world || ''`); `readFromV2`
# passes the PNG's own value through untouched. It is on every path Vocalis reads.
#
# 🔴 WHY IT IS A CORRECTNESS BUG AND NOT A COSMETIC ONE, and the reason is NOT the one the first
# version of this comment gave. `readFromV2` does no world logic, so nothing is rebuilt on read.
# The clobber is on WRITE: an edit sent via `merge-attributes` lands in the PNG and looks
# successful, and then the user's next save in SillyTavern re-bakes the world file over it.
# Silent, and delayed — worse than an edit that visibly does nothing.


def _card_with_book(book, world=None):
    """`world` is what `data.extensions.world` says. `None` → the key is absent entirely, which is
    what a card that never went through SillyTavern looks like."""
    data = {"name": "Test Character 3", "description": "A woman who keeps her own counsel.",
            "character_book": book}
    if world is not None:
        data["extensions"] = {"world": world}
    return {"spec": "chara_card_v2", "spec_version": "2.0", "data": data}


# ───────────────────────────────────── Card-native lorebook entries

def test_an_embedded_book_entry_says_it_belongs_to_the_card():
    """Embedded book entries use a label that distinguishes them from standalone library worldbooks."""
    book = {"name": "Notes", "entries": [
        {"id": 0, "comment": "Her childhood home", "content": "A blue house."},
        {"id": 1, "content": "An entry nobody named."},
    ]}
    jobs = card.jobs(_card_with_book(book, world=""), rel="M.png")
    embedded = [j for j in jobs if j.meta["kind"] == card.EMBEDDED_BOOK_KIND]
    assert [j.label for j in embedded] == ["card book · Her childhood home",
                                           "card book · entry 1"]
    assert all(j.meta["group"] == card.EMBEDDED_BOOK_GROUP for j in embedded)
    assert "inside this card" in card.EMBEDDED_BOOK_GROUP


def test_the_cards_OWN_fields_carry_no_group():
    """The heading is drawn when the group CHANGES, so a stray group on a card field would put a
    lorebook heading over `description`."""
    jobs = card.jobs(_card_with_book({"name": "N", "entries": [
        {"id": 0, "comment": "X", "content": "T."}]}, world=""), rel="M.png")
    own = [j for j in jobs if j.meta["kind"] != card.EMBEDDED_BOOK_KIND]
    assert own and all(j.meta.get("group", "") == "" for j in own)


def test_an_embedded_entry_is_still_TICKED_by_default():
    """Checks that an embedded entry is still ticked by default."""
    jobs = card.jobs(_card_with_book({"name": "N", "entries": [
        {"id": 0, "comment": "Home", "content": "A blue house."}]}, world=""), rel="M.png")
    embedded = [j for j in jobs if j.meta["kind"] == card.EMBEDDED_BOOK_KIND]
    assert embedded and all(j.meta["pass_default"] is True for j in embedded)


def test_a_worldbook_mirrored_into_a_card_is_not_offered_as_a_card_field():
    """The exact shape their server returns for a character with a World Book assigned."""
    mirror = {"name": "Sample World", "entries": [
        {"id": 0, "comment": "Test Character 6", "content": "Test Character 7's husband. A quiet man."},
        {"id": 1, "comment": "Sample Author", "content": "Test Character 3's mother."},
    ]}
    labels = [j.label for j in
              card.jobs(_card_with_book(mirror, world="Sample World"), rel="Test Character 3.png")]
    assert "Test Character 6" not in labels, (
        "a World Book entry was offered as a character-card field — editing it there is discarded")
    assert "Sample Author" not in labels
    assert "description" in labels, "the card's own fields must still be offered"


def test_a_nameless_book_on_a_card_with_a_world_is_STILL_a_mirror():
    """Checks that a nameless book on a card with a world is still a mirror."""
    mirror = {"entries": [{"id": 0, "comment": "Test Character 6", "content": "Test Character 7's husband."}]}
    labels = [j.label for j in
              card.jobs(_card_with_book(mirror, world="Sample World"), rel="Test Character 3.png")]
    assert "Test Character 6" not in labels, (
        "a nameless book on a card with a world linked is still a mirror — the world says so")


def test_a_card_native_lorebook_IS_still_offered_even_when_it_has_a_name():
    """Checks that a card native lorebook is still offered even when it has a name."""
    own = {"name": "Test Character 3's own notes",
           "entries": [{"id": 0, "comment": "Her childhood home", "content": "A blue house."}]}
    for world in ("", None):                       # linked to nothing, and never linked at all
        labels = [j.label for j in card.jobs(_card_with_book(own, world=world), rel="M.png")]
        assert any(lab.endswith("Her childhood home") for lab in labels), (
            f"a card-native lorebook was hidden with world={world!r} — it exists nowhere else")


def test_a_missing_world_file_does_not_make_the_mirror_editable():
    """Checks that a missing world file does not make the mirror editable."""
    own = {"entries": [{"id": 0, "comment": "Orphaned", "content": "Text."}]}
    labels = [j.label for j in
              card.jobs(_card_with_book(own, world="a book that was deleted"), rel="M.png")]
    assert "Orphaned" not in labels, (
        "a world is linked, so this is not-editable regardless of whether the file is there")


def test_the_test_above_would_have_caught_the_original_bug():
    """Checks that the test above would have caught the original bug."""
    book = {"name": "Sample World",
            "entries": [{"id": 0, "comment": "Test Character 6", "content": "Test Character 7's husband."}]}
    mirrored = card.jobs(_card_with_book(book, world="Sample World"), rel="M.png")
    native = card.jobs(_card_with_book(book, world=""), rel="M.png")
    assert len(native) > len(mirrored), (
        "the same book must be treated differently by the world link alone — that IS the fix")


def test_a_whitespace_world_is_no_world_rather_than_a_mirror():
    """`"   "` is not a book title. Treating it as one would hide a card-native lorebook, which is
    the failure this must not trade for the other."""
    for blank in ("", "   ", None):
        labels = [j.label for j in
                  card.jobs(_card_with_book({"name": "Notes", "entries": [
                      {"id": 0, "comment": "Kept", "content": "Text."}]}, world=blank),
                            rel="M.png")]
        assert any(lab.endswith("Kept") for lab in labels),             f"world={blank!r} was wrongly treated as a link to a World Book"


# ───────────────────────────────────── Injection mode

def test_the_four_injection_modes_match_the_forks_own_classifier():
    """Mirror the fork’s four injection modes and preserve the rule that disabled entries take precedence."""
    assert worldbook.entry_mode({"disable": True}) == "disabled"
    assert worldbook.entry_mode({"constant": True}) == "constant"
    assert worldbook.entry_mode({"vectorized": True}) == "vectorized"
    assert worldbook.entry_mode({}) == "normal"
    # `disable` beats BOTH of the others, exactly as the fork's ordering does.
    assert worldbook.entry_mode({"disable": True, "constant": True}) == "disabled"
    assert worldbook.entry_mode({"disable": True, "vectorized": True}) == "disabled"
    # `constant` beats `vectorized`, matching the tri-state's own precedence.
    assert worldbook.entry_mode({"constant": True, "vectorized": True}) == "constant"


def test_a_mode_is_only_true_when_it_is_literally_true():
    """Checks that a mode is only true when it is literally true."""
    assert worldbook.entry_mode({"constant": "false"}) == "normal"
    assert worldbook.entry_mode({"disable": 1}) == "normal"
    assert worldbook.entry_mode("not a dict") == "normal"
    assert worldbook.entry_mode(None) == "normal"


def test_every_collected_entry_carries_its_mode():
    book = {"entries": {
        "0": {"uid": 0, "key": ["a"], "comment": "Always", "constant": True, "content": "A."},
        "1": {"uid": 1, "key": ["b"], "comment": "Keyed", "content": "B."},
        "2": {"uid": 2, "key": ["c"], "comment": "Dead", "disable": True, "content": "C."},
    }}
    modes = {j.label: j.meta.get("mode") for j in worldbook.jobs(book, rel="g.json")}
    assert modes == {"Always": "constant", "Keyed": "normal", "Dead": "disabled"}


def test_an_embedded_card_book_reports_its_real_mode_rather_than_always_normal():
    """Checks that an embedded card book reports its real mode rather than always normal."""
    book = {"name": "Notes", "entries": [
        {"id": 0, "comment": "Always", "constant": True, "content": "In every prompt."},
        {"id": 1, "comment": "Keyed", "content": "Only on a keyword."},
        {"id": 2, "comment": "Dead", "disable": True, "content": "Never."},
    ]}
    jobs = {j.label.rsplit("· ", 1)[-1]: j
            for j in card.jobs(_card_with_book(book, world=""), rel="M.png")}
    assert jobs["Always"].meta["mode"] == "constant"
    assert jobs["Always"].meta["constant"] is True, "the old hard-coded False is still there"
    assert jobs["Keyed"].meta["mode"] == "normal"
    assert jobs["Dead"].meta["mode"] == "disabled"


def test_a_card_s_own_fields_have_no_injection_mode_at_all():
    """Checks that a card s own fields have no injection mode at all."""
    jobs = card.jobs(_card_with_book({"name": "N", "entries": []}, world=""), rel="M.png")
    assert jobs, "the fixture collected nothing, so this proves nothing"
    assert all(j.meta.get("mode") == "" for j in jobs)
