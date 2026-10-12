"""Tests merging draft edits against document revisions."""
from __future__ import annotations

import itertools
import json

import pytest

import vault_fs
from wbedit import assemble
from wbedit.formats import merge
from wbedit.store import DocumentStore


# ── helpers ──────────────────────────────────────────────────────────────────────────────────

def entry(uid, comment, content, **extra):
    """A compiled-ST worldbook entry. `key` defaults to something non-empty because a `normal`
    entry with no keywords is inert and `worldbook.inert_entries` exists to refuse it."""
    e = {"uid": uid, "comment": comment, "content": content, "key": [comment.lower()],
         "constant": False, "disable": False, "order": 100}
    e.update(extra)
    return e


def book(*entries):
    """The compiled shape: `entries` a dict keyed by the STRING uid (`assemble.py:523`)."""
    return {"entries": {str(e["uid"]): e for e in entries}}


def by_label(result, label):
    for item in result.entries:
        if item.label == label:
            return item
    raise AssertionError(f"no entry labeled {label!r} in {[e.label for e in result.entries]}")


def field(item, name):
    for f in item.fields:
        if f.name == name:
            return f
    raise AssertionError(f"no field {name!r} in {[f.name for f in item.fields]}")


# ── Entry-by-entry merge rules ──────────────────────────────────────────────────────────────

def test_an_entry_he_never_touched_takes_the_update():
    """*"for anything that has no edits, you replace it."* The headline case."""
    base = book(entry(1, "Sample World Book 1", "The guilds are old."))
    mine = book(entry(1, "Sample World Book 1", "The guilds are old."))
    theirs = book(entry(1, "Sample World Book 1", "The guilds are old and quarrelsome."))

    result = merge.merge_worldbook(base, mine, theirs)
    item = by_label(result, "Sample World Book 1")

    assert item.status == merge.CHANGED
    content = field(item, "content")
    assert content.verdict == merge.TAKE_THEIRS
    assert content.resolved == "The guilds are old and quarrelsome."
    assert result.clean, "nothing here needs a decision"


def test_an_edit_of_his_that_the_file_did_not_touch_stands():
    base = book(entry(1, "Sample World Book 1", "The guilds are old."))
    mine = book(entry(1, "Sample World Book 1", "The guilds are ANCIENT."))
    theirs = book(entry(1, "Sample World Book 1", "The guilds are old."))

    result = merge.merge_worldbook(base, mine, theirs)
    content = field(by_label(result, "Sample World Book 1"), "content")

    assert content.verdict == merge.KEEP_MINE
    assert content.resolved == "The guilds are ANCIENT."
    assert result.clean


def test_both_changed_it_differently_is_a_conflict_that_keeps_his_text():
    base = book(entry(1, "Sample World Book 1", "The guilds are old."))
    mine = book(entry(1, "Sample World Book 1", "The guilds are ANCIENT."))
    theirs = book(entry(1, "Sample World Book 1", "The guilds are quarrelsome."))

    result = merge.merge_worldbook(base, mine, theirs)
    content = field(by_label(result, "Sample World Book 1"), "content")

    assert content.verdict == merge.CONFLICT
    # 🔴 The safety property, stated on the one case where it is load-bearing.
    assert content.resolved == "The guilds are ANCIENT."
    assert content.theirs == "The guilds are quarrelsome."  # Keep incoming text available for conflict review.
    assert result.conflicts == 1
    assert not result.clean


def test_both_made_the_same_change_is_not_a_conflict():
    """Checks that both made the same change is not a conflict."""
    base = book(entry(1, "Sample World Book 1", "The guilds are old."))
    mine = book(entry(1, "Sample World Book 1", "The guilds are ancient."))
    theirs = book(entry(1, "Sample World Book 1", "The guilds are ancient."))

    result = merge.merge_worldbook(base, mine, theirs)
    content = field(by_label(result, "Sample World Book 1"), "content")

    assert content.verdict == merge.AGREED
    assert content.resolved == "The guilds are ancient."
    assert result.clean


def test_untouched_by_anyone_is_reported_as_same():
    same = book(entry(1, "Sample World Book 1", "The guilds are old."))
    result = merge.merge_worldbook(same, same, same)

    assert by_label(result, "Sample World Book 1").status == merge.SAME
    assert result.tally()[merge.SAME] == 1
    assert result.clean


# ── entries appearing and disappearing ───────────────────────────────────────────────────────

def test_an_entry_new_in_the_file_is_added():
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))

    result = merge.merge_worldbook(base, mine, theirs)
    item = by_label(result, "Weather")

    assert item.status == merge.ADDED
    assert item.entry["content"] == "wet"
    assert result.clean, "an addition needs no decision"


def test_an_entry_dropped_by_the_file_and_untouched_by_him_is_an_ordinary_delete():
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    theirs = book(entry(1, "Sample World Book 1", "old"))

    result = merge.merge_worldbook(base, mine, theirs)

    assert by_label(result, "Weather").status == merge.REMOVED
    assert result.clean


def test_the_file_dropping_an_entry_he_edited_is_a_conflict():
    """Checks that an incoming deletion conflicts with a local edit."""
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet and BITTER"))
    theirs = book(entry(1, "Sample World Book 1", "old"))

    result = merge.merge_worldbook(base, mine, theirs)
    item = by_label(result, "Weather")

    assert item.status == merge.REMOVED_EDITED
    assert result.conflicts == 1
    assert not result.clean
    assert result.tally()[merge.REMOVED_EDITED] == 1


def test_an_entry_he_wrote_since_the_last_import_is_not_deleted_by_the_file():
    """The file has never seen it, so the file's silence about it says nothing."""
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(9, "My Notes", "mine alone"))
    theirs = book(entry(1, "Sample World Book 1", "old"))

    result = merge.merge_worldbook(base, mine, theirs)
    item = by_label(result, "My Notes")

    assert item.status == merge.MINE_ONLY
    assert result.clean


def test_an_entry_he_deleted_is_never_re_added_by_the_import():
    """Checks that an incoming file does not restore an entry deleted locally."""
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))

    result = merge.merge_worldbook(base, mine, theirs)
    item = by_label(result, "Weather")

    assert item.status == merge.REMOVED
    assert result.clean, "he already decided this when he deleted it"


def test_an_entry_he_deleted_that_the_file_has_since_updated_is_reported_but_not_a_conflict():
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet and BITTER"))

    result = merge.merge_worldbook(base, mine, theirs)
    item = by_label(result, "Weather")

    assert item.status == merge.REMOVED_UPDATED
    assert result.tally()[merge.REMOVED_UPDATED] == 1
    assert result.clean, "keeping it deleted honors an edit he made and loses nothing"


# ── identity: which entry is which ───────────────────────────────────────────────────────────

def test_entries_are_matched_by_uid_not_by_position():
    """A model that reorders the book must not read as delete-all + add-all."""
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    theirs = book(entry(2, "Weather", "wet"), entry(1, "Sample World Book 1", "OLDER"))

    result = merge.merge_worldbook(base, mine, theirs)

    assert len(result.entries) == 2
    assert {e.match for e in result.entries} == {merge.BY_UID}
    assert field(by_label(result, "Sample World Book 1"), "content").resolved == "OLDER"
    assert by_label(result, "Weather").status == merge.SAME


def test_a_string_uid_and_an_int_uid_are_the_same_entry():
    """A compiled book keys `entries` by the string "1" while the entry carries the int 1; a file
    a model wrote may spell it either way, and `"1" != 1` would read one entry as two."""
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = {"entries": {"1": entry("1", "Sample World Book 1", "OLDER")}}

    result = merge.merge_worldbook(base, mine, theirs)

    assert len(result.entries) == 1
    assert result.entries[0].match == merge.BY_UID


def test_a_renumbered_file_is_matched_by_title_and_says_so():
    """The model rebuilt the book instead of editing it: uids are fresh, titles survived."""
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    theirs = book(entry(77, "Sample World Book 1", "OLDER"), entry(78, "Weather", "wet"))

    result = merge.merge_worldbook(base, mine, theirs)

    assert len(result.entries) == 2, "must not read as two adds and two deletes"
    assert {e.match for e in result.entries} == {merge.BY_COMMENT}
    assert result.renumbered, "the pane has to be able to say the file was regenerated"
    assert field(by_label(result, "Sample World Book 1"), "content").resolved == "OLDER"


def test_a_file_that_reuses_uids_for_different_entries_is_flagged_as_renumbered():
    """Checks that a file that reuses uids for different entries is flagged as renumbered."""
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    theirs = book(entry(1, "Weather", "wet"), entry(2, "Sample World Book 1", "old"))

    result = merge.merge_worldbook(base, mine, theirs)

    assert result.renumbered


def test_a_duplicate_uid_on_one_side_is_not_used_as_an_identity():
    """Two entries claiming uid 7 would otherwise have one of them silently win the lookup, which
    puts one entry's text into another entry's history."""
    base = book(entry(7, "Sample World Book 1", "old"))
    mine = book(entry(7, "Sample World Book 1", "old"))
    theirs = {"entries": {"a": entry(7, "Sample World Book 1", "OLDER"), "b": entry(7, "Weather", "wet")}}

    result = merge.merge_worldbook(base, mine, theirs)
    guilds = by_label(result, "Sample World Book 1")

    assert guilds.match == merge.BY_COMMENT, "uid was ambiguous, so the title had to carry it"
    assert field(guilds, "content").resolved == "OLDER"
    assert by_label(result, "Weather").status == merge.ADDED


def test_an_entry_matching_on_neither_rung_is_an_add_and_a_delete_never_a_guess():
    """Checks that an entry matching on neither rung is an add and a delete never a guess."""
    base = book(entry(1, "Sample World Book 1", "the guilds are old", key=["guild", "trade", "charter"]))
    mine = book(entry(1, "Sample World Book 1", "the guilds are old", key=["guild", "trade", "charter"]))
    theirs = book(entry(5, "Sample World Book 10", "the guilds are old",
                        key=["guild", "trade", "charter"]))

    result = merge.merge_worldbook(base, mine, theirs)
    statuses = {e.label: e.status for e in result.entries}

    assert statuses == {"Sample World Book 1": merge.REMOVED, "Sample World Book 10": merge.ADDED}


# ── field-level details that would otherwise generate noise or lose data ─────────────────────

def test_reordered_keywords_are_not_an_edit():
    """SillyTavern scans keywords for a match and does not care which is first. Treating a
    reorder as a change would put every entry in the book into the review pane."""
    base = book(entry(1, "Sample World Book 1", "old", key=["guild", "trade"]))
    mine = book(entry(1, "Sample World Book 1", "old", key=["guild", "trade"]))
    theirs = book(entry(1, "Sample World Book 1", "old", key=["trade", "guild"]))

    result = merge.merge_worldbook(base, mine, theirs)

    assert by_label(result, "Sample World Book 1").status == merge.SAME
    assert field(by_label(result, "Sample World Book 1"), "key").verdict == merge.UNCHANGED


def test_a_genuinely_changed_keyword_list_is_still_seen():
    """The mutation that proves the test above is not vacuous."""
    base = book(entry(1, "Sample World Book 1", "old", key=["guild", "trade"]))
    mine = book(entry(1, "Sample World Book 1", "old", key=["guild", "trade"]))
    theirs = book(entry(1, "Sample World Book 1", "old", key=["guild", "trade", "charter"]))

    result = merge.merge_worldbook(base, mine, theirs)

    assert field(by_label(result, "Sample World Book 1"), "key").verdict == merge.TAKE_THEIRS


def test_a_deliberate_null_is_not_the_same_as_a_missing_field():
    """Checks that a deliberate null is not the same as a missing field."""
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old", scanDepth=None))
    theirs = book(entry(1, "Sample World Book 1", "old"))

    result = merge.merge_worldbook(base, mine, theirs)
    scan = field(by_label(result, "Sample World Book 1"), "scanDepth")

    assert scan.verdict == merge.KEEP_MINE
    assert scan.resolved is None
    assert scan.to_dict()["resolved"] is None
    assert "base" not in scan.to_dict(), "an absent side is omitted, never sent as null"


def test_a_field_only_the_file_has_is_added():
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = book(entry(1, "Sample World Book 1", "old", sticky=3))

    result = merge.merge_worldbook(base, mine, theirs)
    sticky = field(by_label(result, "Sample World Book 1"), "sticky")

    assert sticky.verdict == merge.TAKE_THEIRS
    assert sticky.resolved == 3


def test_a_field_he_removed_that_the_file_changed_is_a_conflict_that_stays_removed():
    base = book(entry(1, "Sample World Book 1", "old", sticky=1))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = book(entry(1, "Sample World Book 1", "old", sticky=9))

    result = merge.merge_worldbook(base, mine, theirs)
    sticky = field(by_label(result, "Sample World Book 1"), "sticky")

    assert sticky.verdict == merge.CONFLICT
    assert sticky.to_dict()["remove"] is True
    assert "resolved" not in sticky.to_dict()


# ── shapes ───────────────────────────────────────────────────────────────────────────────────

def test_the_section_chunk_shape_merges_against_the_compiled_shape():
    """A compiled book keys `entries` by string and spells the keyword field `key`; a section file
    uses a list and `keys`. Entries align by identity, so the two shapes meet."""
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = {"section": "01", "entries": [entry(1, "Sample World Book 1", "OLDER")]}

    result = merge.merge_worldbook(base, mine, theirs)

    assert len(result.entries) == 1
    assert field(result.entries[0], "content").resolved == "OLDER"
    assert result.entries[0].mine_key == "1", "the compiled side keeps its string key"
    assert result.entries[0].theirs_key == 0, "the list side keeps its int index"


def test_book_level_fields_merge_too_and_entries_are_left_to_the_entry_walk():
    base = {"name": "Sample World Book 3", "entries": {}}
    mine = {"name": "Sample World Book 3", "entries": {}}
    theirs = {"name": "Sample World Book 3 (revised)", "entries": {}}

    result = merge.merge_worldbook(base, mine, theirs)
    names = [f.name for f in result.doc_fields]

    assert "entries" not in names, "the entry walk owns that key"
    assert result.doc_fields[0].verdict == merge.TAKE_THEIRS
    assert result.doc_fields[0].resolved == "Sample World Book 3 (revised)"


def test_a_nested_card_shape_gets_a_verdict_per_field_not_one_per_blob():
    """A V2 card wraps everything in `data`; one verdict for the wrapper would make every card a
    single conflict. This is what makes the card side of the feature free."""
    base = {"spec": "chara_card_v2",
            "data": {"name": "Test Character 11", "description": "a scribe", "personality": "dry"}}
    mine = {"spec": "chara_card_v2",
            "data": {"name": "Test Character 11", "description": "a scribe", "personality": "DRY AND SHARP"}}
    theirs = {"spec": "chara_card_v2",
              "data": {"name": "Test Character 11", "description": "a court scribe", "personality": "dry"}}

    fields = {f.name: f for f in merge.merge_mapping(base, mine, theirs)}

    assert fields["data.description"].verdict == merge.TAKE_THEIRS
    assert fields["data.description"].resolved == "a court scribe"
    assert fields["data.personality"].verdict == merge.KEEP_MINE
    assert fields["data.personality"].resolved == "DRY AND SHARP"
    assert fields["data.name"].verdict == merge.UNCHANGED


def test_the_result_is_json_and_the_row_order_is_stable():
    """Checks that the result is json and the row order is stable."""
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "WET AND BITTER"))
    theirs = book(entry(2, "Weather", "damp"), entry(3, "Roads", "muddy"))

    first = merge.merge_worldbook(base, mine, theirs).to_dict()
    second = merge.merge_worldbook(base, mine, theirs).to_dict()

    assert first == second
    assert json.loads(json.dumps(first)) == first


# ── 🔴 the invariants ────────────────────────────────────────────────────────────────────────

#: A small alphabet, plus "the field is not there at all". Three values drawn from it cover every
#: row of the table and every absence combination — 64 cases per field name.
_VALUES = (merge.ABSENT, None, "", "a", "b")


@pytest.mark.parametrize("base,mine,theirs", list(itertools.product(_VALUES, repeat=3)))
def test_an_edit_of_his_is_never_overwritten_and_a_field_he_left_alone_takes_the_update(
        base, mine, theirs):
    """Checks that local edits are preserved while untouched fields accept incoming values."""
    result = merge.merge_field(["f"], base, mine, theirs)

    if merge._same(base, mine):
        assert merge._same(result.resolved, theirs), "he never touched it — take the update"
    else:
        assert merge._same(result.resolved, mine), "his edit stands until he says otherwise"


@pytest.mark.parametrize("base,mine,theirs", list(itertools.product(_VALUES, repeat=3)))
def test_a_conflict_is_declared_exactly_when_all_three_sides_disagree(base, mine, theirs):
    """The complement of the rule above: the merge must not hide a real disagreement behind a
    silent choice, and must not manufacture a decision where there is nothing to decide."""
    result = merge.merge_field(["f"], base, mine, theirs)
    three_way = (not merge._same(base, mine)
                 and not merge._same(base, theirs)
                 and not merge._same(mine, theirs))

    assert (result.verdict == merge.CONFLICT) is three_way


def test_the_verdict_always_matches_what_the_merge_actually_writes():
    """Checks that the verdict always matches what the merge actually writes."""
    for base, mine, theirs in itertools.product(_VALUES, repeat=3):
        r = merge.merge_field(["f"], base, mine, theirs)
        if r.verdict == merge.TAKE_THEIRS:
            assert merge._same(r.resolved, theirs) and not merge._same(base, theirs)
        else:
            assert merge._same(r.resolved, mine)
        if r.verdict == merge.UNCHANGED:
            assert merge._same(base, mine) and merge._same(base, theirs)
        if r.verdict == merge.AGREED:
            assert merge._same(mine, theirs) and not merge._same(base, mine)
        if r.verdict == merge.KEEP_MINE:
            assert merge._same(base, theirs) and not merge._same(base, mine)


def test_no_entry_of_his_is_dropped_without_the_result_saying_so():
    """Checks that every dropped local entry is reported in the merge result."""
    base = book(entry(1, "Untouched", "a"), entry(2, "He edited", "b"),
                entry(3, "They edited", "c"), entry(4, "Both edited", "d"),
                entry(5, "They delete it", "e"), entry(6, "They delete his edit", "f"))
    mine = book(entry(1, "Untouched", "a"), entry(2, "He edited", "B!"),
                entry(3, "They edited", "c"), entry(4, "Both edited", "D!"),
                entry(5, "They delete it", "e"), entry(6, "They delete his edit", "F!"),
                entry(9, "He wrote it", "g"))
    theirs = book(entry(1, "Untouched", "a"), entry(2, "He edited", "b"),
                  entry(3, "They edited", "C?"), entry(4, "Both edited", "D?"),
                  entry(7, "They wrote it", "h"))

    result = merge.merge_worldbook(base, mine, theirs)
    seen = {e.label: e for e in result.entries}

    assert set(seen) == {"Untouched", "He edited", "They edited", "Both edited",
                         "They delete it", "They delete his edit", "He wrote it",
                         "They wrote it"}
    assert seen["Untouched"].status == merge.SAME
    assert seen["He edited"].status == merge.SAME, "the merge writes nothing here"
    assert seen["They edited"].status == merge.CHANGED
    assert seen["Both edited"].status == merge.CHANGED, "a decision is never filtered out"
    assert field(seen["He edited"], "content").resolved == "B!"
    assert field(seen["They edited"], "content").resolved == "C?"
    assert field(seen["Both edited"], "content").verdict == merge.CONFLICT
    assert field(seen["Both edited"], "content").resolved == "D!"
    assert seen["They delete it"].status == merge.REMOVED
    assert seen["They delete his edit"].status == merge.REMOVED_EDITED
    assert seen["He wrote it"].status == merge.MINE_ONLY
    assert seen["They wrote it"].status == merge.ADDED

    assert result.conflicts == 2
    assert result.tally() == {merge.ADDED: 1, merge.REMOVED: 1, merge.REMOVED_EDITED: 1,
                              merge.REMOVED_UPDATED: 0, merge.MINE_ONLY: 1, merge.CHANGED: 2,
                              merge.SAME: 2, "conflicts": 2}


# ── applying it: `assemble.apply_merge` ──────────────────────────────────────────────────────
#
# 🔴 The arithmetic above says what SHOULD happen. These say the document that comes out actually
# says it — a different claim, and the one the stored library depends on.

def merged(base, mine, theirs, **kw):
    return assemble.apply_merge(mine, merge.merge_worldbook(base, mine, theirs), **kw)


def entries_of(doc):
    return {e["comment"]: e for e in doc["entries"].values()}


def test_applying_a_merge_writes_the_update_and_keeps_his_edit():
    base = book(entry(1, "Untouched", "a"), entry(2, "He edited", "b"))
    mine = book(entry(1, "Untouched", "a"), entry(2, "He edited", "B!"))
    theirs = book(entry(1, "Untouched", "A?"), entry(2, "He edited", "b"))

    out = entries_of(merged(base, mine, theirs))

    assert out["Untouched"]["content"] == "A?", "he never touched it — take the update"
    assert out["He edited"]["content"] == "B!", "his edit stands"


def test_a_conflict_writes_his_text_unless_he_says_otherwise():
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "MINE"))
    theirs = book(entry(1, "Sample World Book 1", "THEIRS"))

    assert entries_of(merged(base, mine, theirs))["Sample World Book 1"]["content"] == "MINE"

    picked = merged(base, mine, theirs, field_choices={"0:content": "theirs"})
    assert entries_of(picked)["Sample World Book 1"]["content"] == "THEIRS"


def test_a_key_this_codebase_has_never_heard_of_survives_the_merge():
    """Checks that a key this codebase has never heard of survives the merge."""
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old", outletName="north gate", triggers=["dawn"]))
    theirs = book(entry(1, "Sample World Book 1", "OLDER"))

    out = entries_of(merged(base, mine, theirs))["Sample World Book 1"]

    assert out["content"] == "OLDER"
    assert out["outletName"] == "north gate"
    assert out["triggers"] == ["dawn"]


def test_an_entry_the_file_dropped_that_he_had_edited_is_still_there_afterwards():
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet and BITTER"))
    theirs = book(entry(1, "Sample World Book 1", "old"))

    out = entries_of(merged(base, mine, theirs))

    assert out["Weather"]["content"] == "wet and BITTER"
    dropped = entries_of(merged(base, mine, theirs, entry_choices={"1": "drop"}))
    assert "Weather" not in dropped


def test_an_entry_missing_from_the_file_is_kept_by_default():
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    theirs = book(entry(1, "Sample World Book 1", "old"))

    result = merge.merge_worldbook(base, mine, theirs)
    assert entries_of(assemble.apply_merge(mine, result))["Weather"]["content"] == "wet"
    index = next(i for i, e in enumerate(result.entries) if e.label == "Weather")
    assert "Weather" not in entries_of(assemble.apply_merge(
        mine, result, entry_choices={str(index): "drop"}))


def test_an_entry_he_deleted_stays_deleted_but_he_can_ask_for_it_back():
    base = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet and BITTER"))

    result = merge.merge_worldbook(base, mine, theirs)
    index = next(i for i, e in enumerate(result.entries) if e.label == "Weather")

    assert "Weather" not in entries_of(assemble.apply_merge(mine, result))
    back = assemble.apply_merge(mine, result, entry_choices={str(index): "keep"})
    assert entries_of(back)["Weather"]["content"] == "wet and BITTER"


def test_an_added_entry_is_renumbered_into_the_book_and_never_takes_the_files_uid():
    """Checks that an added entry is renumbered into the book and never takes the files uid."""
    base = book(entry(0, "Sample World Book 1", "old"), entry(5, "Roads", "muddy"))
    mine = book(entry(0, "Sample World Book 1", "old"), entry(5, "Roads", "muddy"))
    theirs = book(entry(0, "Sample World Book 1", "old"), entry(5, "Roads", "muddy"),
                  entry(99, "Weather", "wet"))

    out = merged(base, mine, theirs)

    assert set(out["entries"]) == {"0", "5", "6"}
    assert out["entries"]["6"]["uid"] == 6
    assert out["entries"]["6"]["comment"] == "Weather"
    assert out["entries"]["0"]["content"] == "old", "his entries kept their keys"


def test_an_added_entry_is_born_at_the_books_own_priority_not_the_assemblers():
    """The assembler's default order is 20 and an imported book's entries carry 100, so an entry
    born at 20 is the first one cut from the prompt, silently."""
    base = book(entry(1, "Sample World Book 1", "old", order=100))
    mine = book(entry(1, "Sample World Book 1", "old", order=100))
    theirs = book(entry(1, "Sample World Book 1", "old", order=100), entry(2, "Weather", "wet"))

    out = entries_of(merged(base, mine, theirs))

    assert out["Weather"]["order"] == 100


def test_an_added_entry_arrives_complete_rather_than_as_the_fragment_the_file_held():
    base = book(entry(1, "Sample World Book 1", "old"))
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = {"entries": {"1": entry(1, "Sample World Book 1", "old"),
                          "2": {"uid": 2, "comment": "Weather", "content": "wet",
                                "keys": ["rain"]}}}

    out = entries_of(merged(base, mine, theirs))["Weather"]

    assert out["key"] == ["rain"], "`keys` is aliased to `key`, or SillyTavern never fires it"
    assert "probability" in out and "selectiveLogic" in out, "the full DEFAULTS set"


def test_document_level_fields_are_written_too():
    base = {"name": "Sample World Book 3", "entries": {}}
    mine = {"name": "Sample World Book 3", "entries": {}}
    theirs = {"name": "Sample World Book 3 (revised)", "entries": {}}

    assert merged(base, mine, theirs)["name"] == "Sample World Book 3 (revised)"


def test_his_entry_order_is_preserved_and_additions_go_on_the_end():
    """Checks that local entry order is preserved and incoming additions are appended."""
    base = book(entry(1, "A", "a"), entry(2, "B", "b"), entry(3, "C", "c"))
    mine = book(entry(1, "A", "a"), entry(2, "B", "b"), entry(3, "C", "c"))
    theirs = book(entry(3, "C", "c"), entry(9, "D", "d"), entry(1, "A", "a"), entry(2, "B", "b"))

    out = merged(base, mine, theirs)

    assert [e["comment"] for e in out["entries"].values()] == ["A", "B", "C", "D"]


def test_nothing_of_his_is_lost_when_the_whole_mixed_book_is_applied():
    """Checks that applying a mixed merge preserves all local content not explicitly replaced."""
    base = book(entry(1, "Untouched", "a"), entry(2, "He edited", "b"),
                entry(3, "They edited", "c"), entry(4, "Both edited", "d"),
                entry(5, "They delete it", "e"), entry(6, "They delete his edit", "f"))
    mine = book(entry(1, "Untouched", "a"), entry(2, "He edited", "B!"),
                entry(3, "They edited", "c"), entry(4, "Both edited", "D!"),
                entry(5, "They delete it", "e"), entry(6, "They delete his edit", "F!"),
                entry(9, "He wrote it", "g"))
    theirs = book(entry(1, "Untouched", "a"), entry(2, "He edited", "b"),
                  entry(3, "They edited", "C?"), entry(4, "Both edited", "D?"),
                  entry(7, "They wrote it", "h"))

    out = entries_of(merged(base, mine, theirs))

    assert set(out) == {"Untouched", "He edited", "They edited", "Both edited",
                        "They delete it", "They delete his edit", "He wrote it",
                        "They wrote it"}
    assert out["He edited"]["content"] == "B!"
    assert out["They edited"]["content"] == "C?"
    assert out["Both edited"]["content"] == "D!", "conflict keeps his text"
    assert out["They delete his edit"]["content"] == "F!"
    assert out["He wrote it"]["content"] == "g"
    assert out["They delete it"]["content"] == "e", "an omission cannot delete his entry"


# ── finding the base: `DocumentStore.merge_base` ─────────────────────────────────────────────
#
# 🔴 The arithmetic is only as good as the revision it is pointed at. These are about WHICH
# revision that is, and the one that matters is the second merge of a book.

def a_store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


def test_the_merge_base_of_a_freshly_imported_book_is_revision_zero(tmp_path):
    store = a_store(tmp_path)
    doc = store.create(book(entry(1, "Sample World Book 1", "old")), name="Sample World Book 3", kind="worldbook")

    assert store.merge_base(doc.id).n == 0


def test_hand_edits_do_not_move_the_merge_base(tmp_path):
    """Checks that hand edits do not move the merge base."""
    store = a_store(tmp_path)
    doc = store.create(book(entry(1, "Sample World Book 1", "old")), name="Sample World Book 3", kind="worldbook")
    store.add_revision(doc.id, book(entry(1, "Sample World Book 1", "MINE")), note="hand edit")
    store.add_revision(doc.id, book(entry(1, "Sample World Book 1", "MINE AGAIN")), note="hand edit")

    assert store.merge_base(doc.id).n == 0
    assert store.latest_on_disk(doc.id) == 2


def test_a_re_import_moves_the_merge_base_forward(tmp_path):
    """Checks that a re import moves the merge base forward."""
    store = a_store(tmp_path)
    store.create(book(entry(1, "Sample World Book 1", "old")), name="Sample World Book 3", kind="worldbook")
    doc, created, changed = store.import_from_file(
        book(entry(1, "Sample World Book 1", "SECOND IMPORT")), kind="worldbook", name="Sample World Book 3")

    assert (created, changed) == (False, True)
    base = store.merge_base(doc.id)
    assert base.n == 1
    assert base.content["entries"]["1"]["content"] == "SECOND IMPORT"


def test_an_import_is_marked_as_one_and_a_hand_edit_is_not(tmp_path):
    """`kind` is the claim; `note` is the sentence shown in the picker."""
    store = a_store(tmp_path)
    doc = store.create(book(entry(1, "Sample World Book 1", "old")), name="Sample World Book 3", kind="worldbook")
    store.add_revision(doc.id, book(entry(1, "Sample World Book 1", "MINE")), note="hand edit")
    store.import_from_file(book(entry(1, "Sample World Book 1", "again")), kind="worldbook", name="Sample World Book 3")

    kinds = {r["n"]: r["kind"] for r in store.revision_index(doc.id)}

    assert kinds == {0: "import", 1: "", 2: "import"}


def test_history_written_before_the_field_existed_is_still_found_by_its_note(tmp_path):
    """Checks that history written before the field existed is still found by its note."""
    store = a_store(tmp_path)
    doc = store.create(book(entry(1, "Sample World Book 1", "old")), name="Sample World Book 3", kind="worldbook")
    store.add_revision(doc.id, book(entry(1, "Sample World Book 1", "MINE")), note="hand edit")
    store.import_from_file(book(entry(1, "Sample World Book 1", "again")), kind="worldbook", name="Sample World Book 3")

    for n in store.revisions(doc.id):
        raw = json.loads(json.dumps(store.revision(doc.id, n).to_dict()))
        raw.pop("kind", None)
        vault_fs.write_json_atomic(store._rev(doc.id, n), raw)

    assert store.revision(doc.id, 2).kind == "", "the field really is gone"
    assert store.merge_base(doc.id).n == 2, "the note carried it"


def test_a_document_claiming_no_import_anywhere_falls_back_to_revision_zero(tmp_path):
    """Checks that a document claiming no import anywhere falls back to revision zero."""
    store = a_store(tmp_path)
    doc = store.create(book(entry(1, "Sample World Book 1", "old")), name="Sample World Book 3", kind="worldbook")
    store.add_revision(doc.id, book(entry(1, "Sample World Book 1", "MINE")), note="hand edit")

    for n in store.revisions(doc.id):
        raw = json.loads(json.dumps(store.revision(doc.id, n).to_dict()))
        raw["kind"] = ""
        raw["note"] = "reworded by some later feature"
        vault_fs.write_json_atomic(store._rev(doc.id, n), raw)

    assert store.merge_base(doc.id).n == 0


def test_the_base_the_head_and_the_file_make_a_merge_that_keeps_his_edit(tmp_path):
    """Checks that merge resolution preserves local edits against the base and incoming file."""
    store = a_store(tmp_path)
    doc = store.create(book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet")),
                       name="Sample World Book 3", kind="worldbook")
    store.add_revision(doc.id, book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "WET, BITTER")),
                       note="hand edit")

    incoming = book(entry(1, "Sample World Book 1", "OLDER"), entry(2, "Weather", "wet"))
    result = merge.merge_worldbook(store.merge_base(doc.id).content,
                                   store.revision(doc.id).content, incoming)
    out = entries_of(assemble.apply_merge(store.revision(doc.id).content, result))

    assert out["Sample World Book 1"]["content"] == "OLDER", "he never touched it"
    assert out["Weather"]["content"] == "WET, BITTER", "he did"
    assert result.clean, "no decision needed for either"


# ── character cards: the same engine, pointed somewhere else ─────────────────────────────────
#
# The same five-row merge table applies to worldbooks and character cards. Only the entry location
# differs, as carried by `MergeResult.container`; shared regressions should fail both test groups.

def card(name="Test Character 11", **data):
    base = {"spec": "chara_card_v2", "spec_version": "2.0",
            "data": {"name": name, "description": "a scribe", "personality": "dry",
                     "scenario": "the lower wards", "first_mes": "Hello.",
                     "alternate_greetings": ["Evening."]}}
    base["data"].update(data)
    return base


def test_a_card_field_he_never_touched_takes_the_update():
    base, mine = card(), card()
    theirs = card(description="a court scribe")

    fields = {f.name: f for f in merge.merge_card(base, mine, theirs).doc_fields}

    assert fields["data.description"].verdict == merge.TAKE_THEIRS
    assert fields["data.description"].resolved == "a court scribe"


def test_a_card_field_he_edited_survives_and_a_clash_is_a_conflict():
    base = card()
    mine = card(personality="DRY AND SHARP", scenario="the upper wards")
    theirs = card(personality="wry", scenario="the lower wards")

    result = merge.merge_card(base, mine, theirs)
    fields = {f.name: f for f in result.doc_fields}

    assert fields["data.scenario"].verdict == merge.KEEP_MINE
    assert fields["data.scenario"].resolved == "the upper wards"
    assert fields["data.personality"].verdict == merge.CONFLICT
    assert fields["data.personality"].resolved == "DRY AND SHARP", "his text stands"
    assert result.conflicts == 1


def test_applying_a_card_merge_writes_a_card_and_not_an_entries_key():
    base = card()
    mine = card(personality="DRY AND SHARP")
    theirs = card(description="a court scribe")

    out = assemble.apply_merge(mine, merge.merge_card(base, mine, theirs))

    assert out["data"]["description"] == "a court scribe"
    assert out["data"]["personality"] == "DRY AND SHARP"
    assert out["spec"] == "chara_card_v2"
    assert "entries" not in out, "a card with no lorebook grows no entries container"


def test_an_embedded_lorebook_gets_the_entry_walk_not_a_blob_comparison():
    """Checks that an embedded lorebook gets the entry walk not a blob comparison."""
    def with_book(*entries):
        c = card()
        c["data"]["character_book"] = {"name": "Test Character 11's lore", "entries": list(entries)}
        return c

    base = with_book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "wet"))
    mine = with_book(entry(1, "Sample World Book 1", "old"), entry(2, "Weather", "WET AND BITTER"))
    # Reordered AND with one entry updated: order must not matter, identity must.
    theirs = with_book(entry(2, "Weather", "wet"), entry(1, "Sample World Book 1", "OLDER"))

    result = merge.merge_card(base, mine, theirs)

    assert result.container == ["data", "character_book", "entries"]
    assert len(result.entries) == 2, "reordering is not delete-all plus add-all"
    assert {e.match for e in result.entries} == {merge.BY_UID}

    out = assemble.apply_merge(mine, result)
    book_entries = {e["comment"]: e for e in out["data"]["character_book"]["entries"]}
    assert book_entries["Sample World Book 1"]["content"] == "OLDER"
    assert book_entries["Weather"]["content"] == "WET AND BITTER"
    assert out["data"]["character_book"]["name"] == "Test Character 11's lore", "the book's own fields survive"


def test_a_v1_cards_embedded_book_is_found_too():
    """V1 is flat — no `data` wrapper — and both spellings are excluded from the field merge so
    neither falls into the recursive comparison."""
    def flat(content):
        return {"name": "Test Character 11", "description": "a scribe", "first_mes": "Hello.",
                "character_book": {"entries": [entry(1, "Sample World Book 1", content)]}}

    result = merge.merge_card(flat("old"), flat("old"), flat("OLDER"))

    assert result.container == ["character_book", "entries"]
    assert assemble.apply_merge(flat("old"), result)["character_book"]["entries"][0]["content"] \
        == "OLDER"


def test_the_embedded_entries_are_not_also_compared_as_fields():
    """Checks that the embedded entries are not also compared as fields."""
    c = card()
    c["data"]["character_book"] = {"entries": [entry(1, "Sample World Book 1", "old")]}
    names = [f.name for f in merge.merge_card(c, c, c).doc_fields]

    assert "data.character_book.entries" not in names
    assert not any(n.startswith("data.character_book.entries.") for n in names)
    assert "data.character_book.name" not in names, "absent here, not skipped — it is not set"


def test_a_card_and_a_worldbook_use_the_same_five_row_table():
    """The regression guard for the whole design: one engine. If a card merge ever grows its own
    verdict logic, these two stop agreeing."""
    for verdicts in [("old", "old", "new"), ("old", "MINE", "old"), ("old", "MINE", "THEIRS"),
                     ("old", "same", "same"), ("old", "old", "old")]:
        b, m, t = verdicts
        as_card = {f.name: f for f in merge.merge_card(card(description=b), card(description=m),
                                                       card(description=t)).doc_fields}
        as_book = merge.merge_worldbook(book(entry(1, "E", b)), book(entry(1, "E", m)),
                                        book(entry(1, "E", t)))
        book_field = next(f for f in as_book.entries[0].fields if f.name == "content")

        assert as_card["data.description"].verdict == book_field.verdict, verdicts
        assert as_card["data.description"].resolved == book_field.resolved, verdicts


# ── the container the merge has to CREATE, and the shape it has to keep ──────────────────────
#
# When merge creates an embedded-book container, its shape must come from the incoming book rather
# than from the document, which has no container yet.

def test_a_card_that_gains_an_embedded_lorebook_merges_instead_of_raising():
    plain = card()
    theirs = card()
    theirs["data"]["character_book"] = {"entries": [entry(1, "Sample World Book 1", "old")]}

    result = merge.merge_card(plain, plain, theirs)
    out = assemble.apply_merge(plain, result)

    assert [e.status for e in result.entries] == [merge.ADDED]
    assert [e["comment"] for e in out["data"]["character_book"]["entries"]] == ["Sample World Book 1"]


def test_a_card_with_no_lorebook_anywhere_is_not_given_an_empty_one():
    """Checks that a card with no lorebook anywhere is not given an empty one."""
    mine = card()
    theirs = card()
    theirs["data"]["description"] = "a court scribe"

    out = assemble.apply_merge(mine, merge.merge_card(card(), mine, theirs))

    assert "character_book" not in out["data"]
    assert out["data"]["description"] == "a court scribe", "the field merge still happened"


def test_the_output_keeps_his_container_shape_not_the_incoming_files():
    """Checks that the output preserves the local document container shape."""
    mine = {"section": "01", "entries": [entry(1, "Sample World Book 1", "old", keys=["g"])]}
    theirs = book(entry(1, "Sample World Book 1", "OLDER"))

    result = merge.merge_worldbook(mine, mine, theirs)
    out = assemble.apply_merge(mine, result)

    assert result.compiled is False
    assert isinstance(out["entries"], list)
    assert out["entries"][0]["content"] == "OLDER"


def test_a_compiled_book_stays_compiled_when_the_file_is_a_section_chunk():
    """Checks that a compiled book stays compiled when the file is a section chunk."""
    mine = book(entry(1, "Sample World Book 1", "old"))
    theirs = {"section": "01", "entries": [entry(1, "Sample World Book 1", "OLDER")]}

    result = merge.merge_worldbook(mine, mine, theirs)
    out = assemble.apply_merge(mine, result)

    assert result.compiled is True
    assert isinstance(out["entries"], dict)
    assert out["entries"]["1"]["content"] == "OLDER"
