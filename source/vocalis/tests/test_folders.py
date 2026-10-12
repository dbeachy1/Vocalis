"""One level of virtual folders over every listing in the app.

Four things in `src/folders.py` are load-bearing and none of them is obvious from the signatures:

🔴 **A FOLDER IS A LABEL, SO NOTHING HERE MAY TOUCH AN ITEM.** Delete the folder and you lose the
label; the item is exactly where it always was. Every store behind these lists is content-addressed
or keyed on a registry name, so a real `mkdir` would move paths a dozen resolvers assume.

🔴 **AN ASSIGNMENT REFERENCES AN ID, NEVER A NAME.** That is the entire reason a rename is one
string write — and the reason a rename must be provable NOT to move a single member.

🔴 **ONE FILE FOR TEN SCOPES, AND A MUTATION MUST ABORT ON A FILE IT COULD NOT READ.** Writing one
scope back over an unparseable store would erase every OTHER scope's folders. `stems._record` pays
for that lesson in full; the tests at the bottom pin the bytes on disk, not just the exception.

⚠️ **A STALE ASSIGNMENT IS HARMLESS AND IS DELIBERATELY NOT CLEANED UP** — but a stale one must
never be COUNTED, or a folder shows `(12)` over four surviving rows and someone goes looking for
what is missing. `counts` reads the LISTING; the map is only ever consulted through it."""
import re
from pathlib import Path

import pytest


# 📌 NO `sys.path` PREAMBLE HERE, AND SO NO IMPORT-ORDER SUPPRESSION EITHER.
# `tests/conftest.py` puts `src/` on `sys.path` at import time and pytest loads conftest before
# any test module, so the older per-file insert — and the lint suppressions it forced on every
# import under it — bought nothing. If this ever breaks it breaks LOUDLY, with an ImportError.
# ⚠️ And the token itself is deliberately not spelled out anywhere above: the suppression
# ratchet is a TEXTUAL scanner, so a comment boasting about not having one is counted as three
# of them. Caught by that ratchet, which is the ratchet working.
import folders

SCOPE = "scenes"
OTHER = "playground_clips"

# Every public function that takes a scope. The closed set is validated at the route, so a
# function that forgot `_check_scope` would grow this file one invented key at a time.
BY_SCOPE = (
    ("list_folders", lambda root, scope: folders.list_folders(root, scope)),
    ("create",       lambda root, scope: folders.create(root, scope, 'Sample Folder')),
    ("rename",       lambda root, scope: folders.rename(root, scope, "f_00000000", 'Sample Folder')),
    ("delete",       lambda root, scope: folders.delete(root, scope, "f_00000000")),
    ("assign",       lambda root, scope: folders.assign(root, scope, ["a"], "f_00000000")),
    ("rekey",        lambda root, scope: folders.rekey(root, scope, "a", "b")),
    ("for_rows",     lambda root, scope: folders.for_rows(root, scope, [{"ref": "a"}])),
    ("counts",       lambda root, scope: folders.counts(root, scope, [{"ref": "a"}])),
)


def _mk(root, scope=SCOPE, name='Sample Folder'):
    return folders.create(root, scope, name)["id"]


def _folder_of(root, ref, scope=SCOPE):
    """What `for_rows` — the only reader — would stamp on a row naming `ref`."""
    return folders.for_rows(root, scope, [{"ref": ref}])[0]["folder"]


# ── the empty store ──────────────────────────────────────────────────────────────────────

def test_no_file_at_all_reads_as_an_empty_document(tmp_path):
    assert folders.load(tmp_path) == {"folders": {}, "assign": {}}
    assert folders.list_folders(tmp_path, SCOPE) == []


def test_an_absent_store_is_not_a_corrupt_one_even_when_strict(tmp_path):
    """⚠️ ABSENT ≠ CORRUPT. A missing file has nothing to destroy, so the writer's own strict
    door must open on it — otherwise the very first `create()` on a fresh install raises."""
    assert folders.load(tmp_path, strict=True) == {"folders": {}, "assign": {}}
    assert folders.create(tmp_path, SCOPE, 'Sample Folder')["name"] == 'Sample Folder'


# ── folders ──────────────────────────────────────────────────────────────────────────────

def test_create_hands_back_an_id_not_a_name(tmp_path):
    """🔴 AN ID IS WHAT AN ASSIGNMENT REFERENCES. Keying members on the name would make a rename
    a rewrite of every one of its assignments, and a half-failed rename would scatter them."""
    row = folders.create(tmp_path, SCOPE, 'Sample Folder')
    assert re.fullmatch(r"f_[0-9a-f]{8}", row["id"]), row["id"]
    assert row["name"] == 'Sample Folder'
    assert folders.list_folders(tmp_path, SCOPE) == [row]


def test_two_folders_never_share_an_id(tmp_path):
    ids = {folders.create(tmp_path, SCOPE, f"n{i}")["id"] for i in range(12)}
    assert len(ids) == 12


def test_a_duplicate_name_is_refused_case_insensitively(tmp_path):
    """`list_folders` sorts case-insensitively, so `Demos` and `demos` would render as two
    adjacent identical rows with no way to tell which one a drag landed in."""
    folders.create(tmp_path, SCOPE, 'Sample Folder')
    with pytest.raises(ValueError):
        folders.create(tmp_path, SCOPE, 'Sample Folder')
    with pytest.raises(ValueError):
        folders.create(tmp_path, SCOPE, "sAmPlE fOlDeR")
    assert len(folders.list_folders(tmp_path, SCOPE)) == 1


def test_a_nameless_folder_is_refused(tmp_path):
    for bad in ("", "   ", "\n\t ", None):
        with pytest.raises(ValueError):
            folders.create(tmp_path, SCOPE, bad)
    assert folders.list_folders(tmp_path, SCOPE) == []


def test_a_name_is_whitespace_collapsed_because_a_label_has_no_newlines(tmp_path):
    row = folders.create(tmp_path, SCOPE, "  Ferry \n  crossing   takes  ")
    assert row["name"] == "Ferry crossing takes"
    # …and the collapsed form is what the duplicate check sees.
    with pytest.raises(ValueError):
        folders.create(tmp_path, SCOPE, "Ferry crossing takes")


def test_a_name_is_capped_because_a_label_is_not_a_document(tmp_path):
    """🔴 A COUNT CAP IS NOT A SIZE CAP — `clip_favorites` shipped with only the first and one
    POST wrote a multi-megabyte entry that every later read decrypted."""
    row = folders.create(tmp_path, SCOPE, "A" * 500)
    assert row["name"] == "A" * folders.MAX_NAME_LEN
    assert folders.list_folders(tmp_path, SCOPE)[0]["name"] == "A" * folders.MAX_NAME_LEN


def test_the_list_comes_back_in_name_order_case_insensitively(tmp_path):
    """📌 Sorted on the server rather than in the client so all three panels over one dataset
    agree without three comparators."""
    for n in ("zebra", "Apple", "mango", "Banana"):
        folders.create(tmp_path, SCOPE, n)
    assert [r["name"] for r in folders.list_folders(tmp_path, SCOPE)] == \
        ["Apple", "Banana", "mango", "zebra"]


def test_listing_is_the_folders_and_this_scope_s_assignment_map_from_one_read(tmp_path):
    """🔴 THE MAP IS FOR THE PANELS WHOSE REF THE SERVER CANNOT COMPUTE, and `list_folders` is
    now the `["folders"]` half of it — one read where two calls would have parsed the file
    twice on the path of every tab open."""
    fid = folders.create(tmp_path, SCOPE, "Uploaded")["id"]
    folders.create(tmp_path, "acelib", "Elsewhere")
    folders.assign(tmp_path, SCOPE, ["speech/sp1", "pg/c1"], fid)
    folders.assign(tmp_path, "acelib", ["other"], folders.list_folders(tmp_path, "acelib")[0]["id"])
    out = folders.listing(tmp_path, SCOPE)
    assert out["folders"] == [{"id": fid, "name": "Uploaded"}]
    assert out["assign"] == {"speech/sp1": fid, "pg/c1": fid}, "another scope's refs must not leak in"
    assert folders.list_folders(tmp_path, SCOPE) == out["folders"]


def test_listing_a_scope_with_nothing_in_it_is_two_empties(tmp_path):
    """Absent ≠ corrupt: the file does not exist here at all."""
    assert folders.listing(tmp_path, SCOPE) == {"folders": [], "assign": {}}


def test_listing_hands_back_a_copy_so_a_caller_cannot_edit_the_store(tmp_path):
    """`load()` builds a fresh document per call today, but the map is handed to a route that
    serializes it — a shared reference is one `dict.pop` away from a mutation nothing wrote."""
    fid = folders.create(tmp_path, SCOPE, "Uploaded")["id"]
    folders.assign(tmp_path, SCOPE, ["a.wav"], fid)
    folders.listing(tmp_path, SCOPE)["assign"].clear()
    assert folders.listing(tmp_path, SCOPE)["assign"] == {"a.wav": fid}


def test_listing_rejects_a_scope_that_is_not_in_the_closed_set(tmp_path):
    with pytest.raises(ValueError):
        folders.listing(tmp_path, "definitely_not_a_scope")


# ── 🔴 a rename is ONE STRING, and it moves nobody ───────────────────────────────────────

def test_a_rename_keeps_the_id(tmp_path):
    fid = _mk(tmp_path)
    assert folders.rename(tmp_path, SCOPE, fid, "Barges") == {"id": fid, "name": "Barges"}
    assert folders.list_folders(tmp_path, SCOPE) == [{"id": fid, "name": "Barges"}]


def test_a_rename_does_not_move_a_single_member(tmp_path):
    """🔴 THE PAYOFF OF KEYING ON AN ID, and the one property that is silently wrong if the
    store ever keys a member on the folder's NAME: the members do not follow the rename, they
    simply never notice it."""
    fid = _mk(tmp_path)
    assert folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34", "barge_ff00ff00"], fid) == 2
    folders.rename(tmp_path, SCOPE, fid, "Barges")
    rows = folders.for_rows(tmp_path, SCOPE,
                            [{"ref": "ferry_ab12cd34"}, {"ref": "barge_ff00ff00"}])
    assert [r["folder"] for r in rows] == [fid, fid]
    assert folders.counts(tmp_path, SCOPE, rows) == {fid: 2}


def test_a_rename_onto_another_folders_name_is_refused(tmp_path):
    _mk(tmp_path, name='Sample Folder')
    fid = _mk(tmp_path, name="Rejects")
    with pytest.raises(ValueError):
        folders.rename(tmp_path, SCOPE, fid, "sample folder")
    assert dict(folders.list_folders(tmp_path, SCOPE)[0]) == {"id": fid, "name": "Rejects"}


def test_renaming_a_folder_to_its_own_name_in_a_different_case_is_allowed(tmp_path):
    """The duplicate check must exclude the row being renamed, or fixing the capitalization of
    a folder is impossible."""
    fid = _mk(tmp_path, name="sample folder")
    assert folders.rename(tmp_path, SCOPE, fid, 'Sample Folder')["name"] == 'Sample Folder'


def test_renaming_an_unknown_folder_raises(tmp_path):
    _mk(tmp_path)
    with pytest.raises(ValueError):
        folders.rename(tmp_path, SCOPE, "f_deadbeef", "Barges")


# ── 🔴 delete removes the LABEL and nothing else ─────────────────────────────────────────

def test_deleting_a_folder_returns_its_members_to_unfiled(tmp_path):
    """🔴 THE CONFIRM DIALOG HAS TO SAY SO IN THOSE WORDS. This store holds no path and cannot
    delete an item even if it wanted to; `for_rows` stamping None is what "unfiled" IS."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34", "barge_ff00ff00"], fid)
    assert folders.delete(tmp_path, SCOPE, fid) is True
    assert folders.list_folders(tmp_path, SCOPE) == []
    rows = folders.for_rows(tmp_path, SCOPE,
                            [{"ref": "ferry_ab12cd34"}, {"ref": "barge_ff00ff00"}])
    assert [r["folder"] for r in rows] == [None, None]


def test_deleting_a_folder_deletes_no_item_data(tmp_path):
    """📌 A FOLDER CAN NEVER ORPHAN ANYTHING — every other decision in the module leans on it.
    The store is handed an install root, so the cheapest honest proof is that a real file
    sitting beside it is still there afterward."""
    item = tmp_path / "ferry_ab12cd34.mp3"
    item.write_bytes(b"ID3 fake audio")
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34"], fid)
    folders.delete(tmp_path, SCOPE, fid)
    assert item.read_bytes() == b"ID3 fake audio"


def test_deleting_one_folder_leaves_its_neighbors_members_alone(tmp_path):
    """It is a whole-file read-modify-write, so the blast radius of getting this wrong is
    everybody else's folders."""
    keep = _mk(tmp_path, name='Sample Folder')
    drop = _mk(tmp_path, name="Rejects")
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34"], keep)
    folders.assign(tmp_path, SCOPE, ["barge_ff00ff00"], drop)
    folders.delete(tmp_path, SCOPE, drop)
    assert _folder_of(tmp_path, "ferry_ab12cd34") == keep
    assert _folder_of(tmp_path, "barge_ff00ff00") is None


def test_deleting_a_folder_that_is_not_there_reports_false(tmp_path):
    fid = _mk(tmp_path)
    assert folders.delete(tmp_path, SCOPE, "f_deadbeef") is False
    assert folders.list_folders(tmp_path, SCOPE) == [{"id": fid, "name": 'Sample Folder'}]


# ── membership ───────────────────────────────────────────────────────────────────────────

def test_assign_files_rows_and_reports_how_many_moved(tmp_path):
    fid = _mk(tmp_path)
    assert folders.assign(tmp_path, SCOPE, ["a", "b", "c"], fid) == 3
    assert _folder_of(tmp_path, "b") == fid


def test_refiling_a_row_into_the_folder_it_is_already_in_moves_nothing(tmp_path):
    """The count is what the toast reports — *"Moved 3 items"* over a no-op drag is a lie the
    user cannot check."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["a", "b"], fid)
    assert folders.assign(tmp_path, SCOPE, ["a", "b"], fid) == 0
    assert folders.assign(tmp_path, SCOPE, ["a", "b", "c"], fid) == 1


def test_a_row_moves_from_one_folder_to_another(tmp_path):
    src = _mk(tmp_path, name='Sample Folder')
    dst = _mk(tmp_path, name="Rejects")
    folders.assign(tmp_path, SCOPE, ["a"], src)
    assert folders.assign(tmp_path, SCOPE, ["a"], dst) == 1
    assert _folder_of(tmp_path, "a") == dst
    rows = [{"ref": "a"}]
    assert folders.counts(tmp_path, SCOPE, rows) == {dst: 1}


def test_a_falsy_folder_id_unfiles(tmp_path):
    """One verb with one destination — the folder row's `⇥ Move selected here` button and a
    drag onto `Unfiled` are the same call."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["a", "b"], fid)
    assert folders.assign(tmp_path, SCOPE, ["a"], None) == 1
    assert _folder_of(tmp_path, "a") is None
    assert _folder_of(tmp_path, "b") == fid
    assert folders.assign(tmp_path, SCOPE, ["a"], "") == 0     # already unfiled: nothing moved


def test_filing_into_a_folder_that_does_not_exist_raises(tmp_path):
    """An assignment naming a folder nothing renders is invisible, so the write must be refused
    rather than persisted for a reader that will silently drop it."""
    _mk(tmp_path)
    with pytest.raises(ValueError):
        folders.assign(tmp_path, SCOPE, ["a"], "f_deadbeef")
    assert _folder_of(tmp_path, "a") is None


def test_an_empty_selection_moves_nothing(tmp_path):
    fid = _mk(tmp_path)
    assert folders.assign(tmp_path, SCOPE, [], fid) == 0
    assert folders.assign(tmp_path, SCOPE, None, fid) == 0


# ── 🔴 a rename that MOVES the ref — the bug class that surfaced this store ───────────────
#
# Where a store's key is its display name, a rename moves the key and the assignment is silently
# orphaned: the row leaves its folder and nothing reports it. `scenes` and `voices_rvc` are both
# like that. The star had exactly this bug from 6.2 until 8.8.6.

def test_rekey_carries_an_assignment_across_a_moved_ref(tmp_path):
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34"], fid)
    assert folders.rekey(tmp_path, SCOPE, "ferry_ab12cd34", "barge_ab12cd34") is True
    assert _folder_of(tmp_path, "barge_ab12cd34") == fid
    assert _folder_of(tmp_path, "ferry_ab12cd34") is None


def test_rekey_never_manufactures_an_assignment(tmp_path):
    """⚠️ The routes call this unconditionally on every rename, which is only safe because an
    UNFILED row that gets renamed must not come back filed."""
    _mk(tmp_path)
    assert folders.rekey(tmp_path, SCOPE, "ferry_ab12cd34", "barge_ab12cd34") is False
    assert folders.load(tmp_path)["assign"] == {}


def test_rekey_writes_nothing_at_all_when_the_ref_was_never_filed(tmp_path):
    """🔴 RED ON PURPOSE — `_mutate` WRITES UNCONDITIONALLY, so a rename of an UNFILED row
    rewrites the whole store (and creates it on an install that has never used a folder).

    Not merely "no assignment appears": no WRITE happens. The rename routes call `rekey` on
    EVERY rename and almost every renamed row is unfiled, so this is the common path — and the
    whole-file read-modify-write is the one hazard this module's header is about. `_mutate`
    runs `fn(doc)` and then writes whatever `fn` did or did not do, so `go`'s "nothing to
    carry" early return still costs a full rewrite of ten scopes' folders. `delete()` on an
    unknown id and `assign()` refiling a row into the folder it is already in do the same.

    The fix belongs in `_mutate` (a sentinel from `fn` meaning "no change, do not write"), not
    here — this test is the signal, so it stays."""
    assert folders.rekey(tmp_path, SCOPE, "ferry_ab12cd34", "barge_ab12cd34") is False
    assert not folders.path_for(tmp_path).exists()


def test_rekey_is_a_no_op_when_the_ref_did_not_move(tmp_path):
    """A no-op rename hands back the SAME ref, and this must not disturb it."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34"], fid)
    assert folders.rekey(tmp_path, SCOPE, "ferry_ab12cd34", "ferry_ab12cd34") is False
    assert _folder_of(tmp_path, "ferry_ab12cd34") == fid


def test_rekey_leaves_every_other_row_alone(tmp_path):
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34", "barge_ff00ff00"], fid)
    folders.rekey(tmp_path, SCOPE, "ferry_ab12cd34", "punt_ab12cd34")
    assert _folder_of(tmp_path, "barge_ff00ff00") == fid
    assert _folder_of(tmp_path, "punt_ab12cd34") == fid


# ── reading a listing ────────────────────────────────────────────────────────────────────

def test_for_rows_stamps_every_row_it_is_handed(tmp_path):
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["a"], fid)
    rows = [{"ref": "a"}, {"ref": "b"}]
    out = folders.for_rows(tmp_path, SCOPE, rows)
    assert out is rows                                    # stamps in place; returns the same list
    assert out == [{"ref": "a", "folder": fid}, {"ref": "b", "folder": None}]


def test_a_stale_assignment_does_not_resurrect_a_deleted_row(tmp_path):
    """⚠️ DELIBERATELY NOT CLEANED UP. `for_rows` is the only reader and it only ever stamps
    rows it was handed, so cascading a delete into this file would be ten more writes and one
    of them would be missed."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["deleted_ab12cd34", "still_here_ff00ff00"], fid)
    out = folders.for_rows(tmp_path, SCOPE, [{"ref": "still_here_ff00ff00"}])
    assert out == [{"ref": "still_here_ff00ff00", "folder": fid}]


def test_for_rows_honors_a_listing_that_names_its_ref_something_else(tmp_path):
    """Ten stores feed this and they do not agree on a column name — `stem`, `hash`, `name`."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34"], fid)
    rows = [{"stem": "ferry_ab12cd34"}]
    assert folders.for_rows(tmp_path, SCOPE, rows, ref_key="stem")[0]["folder"] == fid
    # …and the default key finds nothing in the same rows, which is what makes the argument
    # load-bearing rather than cosmetic.
    assert folders.for_rows(tmp_path, SCOPE, [{"stem": "ferry_ab12cd34"}])[0]["folder"] is None


def test_counts_are_taken_from_the_listing_and_never_from_the_assignment_map(tmp_path):
    """🔴 The map holds stale entries BY DESIGN, so a count taken from it would show `(3)` on a
    folder with one surviving item — wrong in the one direction that sends someone looking for
    what is missing."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["alive", "deleted_1", "deleted_2"], fid)
    assert folders.load(tmp_path)["assign"][SCOPE] == {"alive": fid, "deleted_1": fid,
                                                       "deleted_2": fid}
    assert folders.counts(tmp_path, SCOPE, [{"ref": "alive"}]) == {fid: 1}


def test_counts_omits_a_folder_with_nothing_in_this_listing(tmp_path):
    """An empty folder is a row the UI still renders; a `0` in this dict would be a different
    contract from an absent key, and the caller has to know which."""
    keep = _mk(tmp_path, name='Sample Folder')
    _mk(tmp_path, name="Empties")
    folders.assign(tmp_path, SCOPE, ["a"], keep)
    assert folders.counts(tmp_path, SCOPE, [{"ref": "a"}, {"ref": "unfiled"}]) == {keep: 1}


def test_counts_honors_a_non_default_ref_key(tmp_path):
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34"], fid)
    assert folders.counts(tmp_path, SCOPE, [{"stem": "ferry_ab12cd34"}], ref_key="stem") == {fid: 1}


# ── 🔴 scope is the DATASET, and two of them never see each other ────────────────────────

def test_two_scopes_with_the_same_folder_name_are_two_folders(tmp_path):
    """🔴 SCOPE IS THE DATA, NEVER THE PANEL — but one file holds all ten, so the isolation is
    a property of the code rather than of the storage."""
    a = folders.create(tmp_path, SCOPE, 'Sample Folder')["id"]
    b = folders.create(tmp_path, OTHER, 'Sample Folder')["id"]
    assert a != b
    assert [r["id"] for r in folders.list_folders(tmp_path, SCOPE)] == [a]
    assert [r["id"] for r in folders.list_folders(tmp_path, OTHER)] == [b]


def test_the_same_ref_files_independently_in_two_scopes(tmp_path):
    a = folders.create(tmp_path, SCOPE, 'Sample Folder')["id"]
    b = folders.create(tmp_path, OTHER, 'Sample Folder')["id"]
    folders.assign(tmp_path, SCOPE, ["same_name_ab12cd34"], a)
    assert _folder_of(tmp_path, "same_name_ab12cd34", scope=SCOPE) == a
    assert _folder_of(tmp_path, "same_name_ab12cd34", scope=OTHER) is None
    folders.assign(tmp_path, OTHER, ["same_name_ab12cd34"], b)
    folders.delete(tmp_path, SCOPE, a)
    assert _folder_of(tmp_path, "same_name_ab12cd34", scope=OTHER) == b


def test_every_function_that_takes_a_scope_refuses_an_unknown_one(tmp_path):
    """🔴 A CLOSED SET. An open-ended scope string would let a stuck or hostile client grow this
    file one invented key at a time, and `for_rows` would never read any of them."""
    for name, call in BY_SCOPE:
        with pytest.raises(ValueError, match="unknown scope"):
            call(tmp_path, "not_a_scope")
        assert not folders.path_for(tmp_path).exists(), f"{name} wrote a file for a bad scope"


def test_the_scope_list_is_the_one_the_store_validates_against(tmp_path):
    """Adding a listing to the app means adding its name here, on purpose — so every member of
    `SCOPES` has to actually work."""
    for scope in folders.SCOPES:
        assert folders.create(tmp_path, scope, 'Sample Folder')["name"] == 'Sample Folder'


# ── caps ─────────────────────────────────────────────────────────────────────────────────

def test_the_number_of_folders_in_one_scope_is_capped(tmp_path):
    folders.save(tmp_path, {"folders": {SCOPE: [{"id": f"f_{i:08x}", "name": f"n{i}"}
                                                for i in range(folders.MAX_FOLDERS_PER_SCOPE)]},
                            "assign": {}})
    with pytest.raises(ValueError):
        folders.create(tmp_path, SCOPE, "one too many")


def test_an_over_long_ref_is_REFUSED_and_takes_the_whole_call_with_it(tmp_path):
    """🔴 THE SIZE DIMENSION, which `clip_favorites` shipped without: a JSON body may be 128 MB,
    so one POST with a multi-megabyte ref wrote an entry every later read decrypted.

    🔴 AND IT REFUSES LOUDLY RATHER THAN FILTERING QUIETLY. The first cut dropped the over-long
    ref and returned `moved: 1` for a two-ref call — a partial success the caller cannot tell
    from a whole one, learning that one of its rows moved and nothing about which was refused or
    why. The other bound on the same request (`MAX_REFS_PER_CALL`, at the route) is a 400, and
    two limits on one call must not disagree about how they fail.

    The all-or-nothing half is what this pins hardest: the GOOD ref in the same call must not be
    filed either, or "it failed" and "it half-worked" become the same response."""
    fid = _mk(tmp_path)
    huge = "x" * (folders.MAX_REF_LEN + 1)
    with pytest.raises(ValueError):
        folders.assign(tmp_path, SCOPE, ["ok", huge], fid)
    assert _folder_of(tmp_path, "ok") is None
    assert _folder_of(tmp_path, huge) is None


def test_rekey_refuses_to_move_an_entry_onto_an_over_long_ref(tmp_path):
    """…and leaves the entry where it was, rather than dropping it on the floor."""
    fid = _mk(tmp_path)
    folders.assign(tmp_path, SCOPE, ["ferry_ab12cd34"], fid)
    assert folders.rekey(tmp_path, SCOPE, "ferry_ab12cd34",
                         "y" * (folders.MAX_REF_LEN + 1)) is False
    assert _folder_of(tmp_path, "ferry_ab12cd34") == fid


# ── junk on disk is dropped by the READER, never by a writer ─────────────────────────────

def test_a_reader_drops_malformed_rows_instead_of_taking_the_tab_down(tmp_path):
    """🔴 SILENTLY DROPPING JUNK IS RIGHT IN A READER AND WRONG IN A MUTATOR. A reader that
    raised on one bad row would take a whole tab down over a label."""
    import yaml
    folders.path_for(tmp_path).write_text(yaml.safe_dump({
        "folders": {
            SCOPE: [{"id": "f_00000001", "name": "Good"},
                    {"id": "not-an-id", "name": "Bad id"},
                    {"id": "f_00000002", "name": ""},
                    "a bare string"],
            "no_such_scope": [{"id": "f_00000003", "name": "Invented"}],
        },
        "assign": {SCOPE: {"a": "f_00000001", "b": "f_00000099"}},
    }), encoding="utf-8")
    doc = folders.load(tmp_path)
    assert doc["folders"] == {SCOPE: [{"id": "f_00000001", "name": "Good"}]}
    assert doc["assign"] == {SCOPE: {"a": "f_00000001"}}      # "b" named no surviving folder


# ── 🔴 the corruption contract: reads degrade, writes ABORT ──────────────────────────────
#
# Ten scopes share one file. A mutation that wrote after a failed read would put one scope back
# over a store it could not parse and take every OTHER scope's folders with it. `stems._record`
# refuses the same way and for the same reason.

GARBAGE = b"{not: a mapping\n\x00\x01 and definitely not yaml"


@pytest.fixture
def corrupt(tmp_path):
    folders.path_for(tmp_path).write_bytes(GARBAGE)
    return tmp_path


def test_an_unreadable_store_reads_as_no_folders_rather_than_a_broken_tab(corrupt):
    """A convenience store degrades; it does not take the page down. This feature is an overlay
    on a flat list, and a flat list is exactly what "no folders" renders."""
    assert folders.load(corrupt) == {"folders": {}, "assign": {}}
    assert folders.list_folders(corrupt, SCOPE) == []
    assert folders.for_rows(corrupt, SCOPE, [{"ref": "a"}]) == [{"ref": "a", "folder": None}]
    assert folders.counts(corrupt, SCOPE, [{"ref": "a"}]) == {}


def test_the_writers_door_is_strict_where_the_readers_is_not(corrupt):
    with pytest.raises(folders.FoldersUnreadable):
        folders.load(corrupt, strict=True)


def test_a_file_that_parses_but_is_not_a_mapping_is_unreadable_too(tmp_path):
    """`yaml.safe_load` is happy with a list. `_clean` would coerce it to blank and the next
    write would then erase it — so the strict door has to refuse the SHAPE, not just a parse
    error."""
    folders.path_for(tmp_path).write_text("- a\n- b\n", encoding="utf-8")
    assert folders.load(tmp_path) == {"folders": {}, "assign": {}}
    with pytest.raises(folders.FoldersUnreadable):
        folders.load(tmp_path, strict=True)


@pytest.mark.parametrize("what,call", [
    ("create", lambda root: folders.create(root, SCOPE, 'Sample Folder')),
    ("rename", lambda root: folders.rename(root, SCOPE, "f_00000001", 'Sample Folder')),
    ("delete", lambda root: folders.delete(root, SCOPE, "f_00000001")),
    ("assign", lambda root: folders.assign(root, SCOPE, ["a"], "f_00000001")),
    ("unfile", lambda root: folders.assign(root, SCOPE, ["a"], None)),
])
def test_a_mutation_on_an_unreadable_store_raises_and_writes_nothing(corrupt, what, call):
    """🔴 THE WHOLE GUARANTEE, AND IT IS ABOUT THE BYTES. Raising is only half of it: what must
    not happen is this one scope's change being written back over a file holding nine other
    scopes' folders."""
    with pytest.raises(folders.FoldersUnreadable):
        call(corrupt)
    assert folders.path_for(corrupt).read_bytes() == GARBAGE


def test_rekey_on_an_unreadable_store_reports_false_and_writes_nothing(corrupt):
    """The one mutator that swallows it, deliberately: the rename on disk has ALREADY happened,
    so losing the label degrades to the bug `rekey` exists to prevent — survivable. Reporting a
    completed rename as failed is not. It still must not touch the file."""
    assert folders.rekey(corrupt, SCOPE, "ferry_ab12cd34", "barge_ab12cd34") is False
    assert folders.path_for(corrupt).read_bytes() == GARBAGE


# ── 🔴 the file is in the vault ──────────────────────────────────────────────────────────

def test_the_folders_file_is_a_ROUTED_install_file():
    """🔴 A folder name is user-authored text — the same class of content the store encrypts audio
    for. Left out of the route table it would be a plaintext list of the names the user chose, sitting
    inside an encrypted install, and nothing would complain: a missed WRITE is SILENT and the
    file looks perfect forever. Asserted against the table itself, because that table is what
    `vault_fs` consults."""
    import vault_store
    assert "folders.yaml" in vault_store.ROUTES["install"]["files"]


def test_every_write_goes_through_vault_fs(monkeypatch, tmp_path):
    """The census would catch a raw `open()` eventually; this catches it here, and says why.
    Both doors are pinned — `save()` for a caller holding a whole document, and a mutator,
    which writes INLINE under the module lock rather than calling `save`."""
    import vault_fs
    seen = []
    monkeypatch.setattr(vault_fs, "write_yaml_atomic",
                        lambda p, data, **kw: seen.append((p, data)))
    folders.save(tmp_path, {"folders": {}, "assign": {}})
    folders.create(tmp_path, SCOPE, 'Sample Folder')
    assert [p.name for p, _ in seen] == ["folders.yaml", "folders.yaml"]
    assert seen[-1][1]["folders"][SCOPE][0]["name"] == 'Sample Folder'
