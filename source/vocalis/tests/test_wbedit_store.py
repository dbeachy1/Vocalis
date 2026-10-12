"""Tests document and pass storage, validation, and durability."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault_fs
from wbedit import formats, runner
from wbedit.backends.mock import MockBackend
from wbedit.core.job import Job
from wbedit.store import (DocumentStore, Instruction, InstructionLibrary, MissingDocument,
                          PassStore, RevisionConflict, StoreCorrupt)
from wbedit.store.documents import DOCS_DIR
from wbedit.store.models import Document, Pass, Proposal, Revision

BOOK = {
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "constant": False, "disable": False, "order": 100,
              "comment": "Sample Entry 1", "content": "Test Character 1 keeps the ledger."},
        "1": {"uid": 1, "key": ["weather"], "constant": False, "disable": False, "order": 100,
              "comment": "Weather", "content": "The rains come off the estuary."},
        "2": {"uid": 2, "key": ["wards"], "constant": True, "disable": False, "order": 50,
              "comment": "X-the upper wards", "content": "Test Character 1 never goes above."},
    }
}

CARD = {
    "spec": "chara_card_v2", "spec_version": "2.0",
    "data": {"name": "Test Character 2", "description": "A tall woman.", "personality": "Wry.",
             "scenario": "A tavern.", "first_mes": "You again.", "mes_example": "<START>",
             "extensions": {"taproom_avatar_focus": {"x": 0.1, "y": 0.2, "w": 0.5}}},
}


@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


@pytest.fixture
def passes(tmp_path):
    return PassStore(tmp_path / "wbedit")


def a_doc(store, content=None, **kw):
    kw.setdefault("name", "Sample World Book 1")
    kw.setdefault("kind", "worldbook")
    return store.create(copy.deepcopy(content or BOOK), **kw)


# ───────────────────────────────────────────────────────── I15, and it is the point

def test_the_store_touches_nothing_at_import_or_construction(tmp_path):
    """Checks that the store touches nothing at import or construction."""
    root = tmp_path / "never"
    DocumentStore(root)
    PassStore(root)
    InstructionLibrary(root)
    assert not root.exists(), "constructing a store created something on disk"


def test_a_locked_vault_never_becomes_an_empty_library(store, monkeypatch):
    """Checks that a locked vault never becomes an empty library."""
    a_doc(store)
    assert len(store.list_documents()) == 1

    class VaultLocked(Exception):
        pass

    def locked(*_a, **_k):
        raise VaultLocked("vault is locked")

    monkeypatch.setattr(vault_fs, "listdir", locked)
    monkeypatch.setattr(vault_fs, "read_text", locked)
    with pytest.raises(VaultLocked):
        store.list_documents()


def test_a_corrupt_record_is_refused_and_never_written_over(store):
    """I7 applied to the store: a validator holds back, it never repairs. The file survives for
    hand repair — healing by overwriting destroys the evidence and the content at once."""
    doc = a_doc(store)
    (store.root / DOCS_DIR / doc.id / "meta.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(StoreCorrupt):
        store.get(doc.id)
    assert (store.root / DOCS_DIR / doc.id / "meta.json").read_text(encoding="utf-8") \
        == "{not json", "the store rewrote a file it could not read"


def test_one_corrupt_document_does_not_hide_the_others(store):
    good = a_doc(store, name="Readable")
    bad = a_doc(store, name="Broken")
    (store.root / DOCS_DIR / bad.id / "meta.json").write_text("{", encoding="utf-8")
    names = [d.name for d in store.list_documents()]
    assert names == ["Readable"], "a single bad record made the whole Library unopenable"
    assert good.id in {d.id for d in store.list_documents()}


def test_there_is_no_index_file_the_directory_is_the_library(store):
    """The structural half of I15: no single file holds the list, so no single write can lose
    it."""
    a_doc(store, name="One")
    a_doc(store, name="Two")
    top = {p.name for p in (store.root).iterdir()}
    assert top == {DOCS_DIR}, f"something other than the documents tree appeared: {top}"


# ───────────────────────────────────────────────────────── documents & revisions

def test_import_writes_revision_zero_and_it_is_the_bytes_as_imported(store):
    doc = a_doc(store)
    assert doc.latest == 0
    rev = store.revision(doc.id, 0)
    assert rev.n == 0 and rev.note == "import"
    assert rev.content == BOOK, "revision 0 is not the document that was imported"


def test_the_imported_document_is_immutable_under_a_later_revision(store):
    """I8. Every edit mints a new revision; revision 0 is what came in, forever."""
    doc = a_doc(store)
    later = copy.deepcopy(BOOK)
    later["entries"]["0"]["content"] = "Renamed Character 1 keeps the ledger."
    store.add_revision(doc.id, later, note="hand edit")
    assert store.revision(doc.id, 0).content == BOOK
    assert store.revision(doc.id, 1).content["entries"]["0"]["content"].startswith("Renamed Character 1")
    assert store.get(doc.id).latest == 1


# ─────────────────────────────────────────────────── §2.1 — the id is a path component

@pytest.mark.parametrize("bad", [
    "..", "../evil", "..\\evil", "..\\..\\evil", "a/b", "a\\b", "/etc/passwd", "C:\\Windows",
    ".", ".hidden", "", "  ", "x" * 65, "a.b", "a\x00b", "a:b", "a b", "a%5Cb", "~", "..%2Fevil",
])
def test_a_document_id_can_never_leave_the_documents_directory(store, bad):
    """Checks that a document id can never leave the documents directory."""
    with pytest.raises(MissingDocument):
        store._dir(bad)


@pytest.mark.parametrize("bad", ["..", "../evil", "..\\..\\evil", "a/b", "a\\b", "", "a.b"])
def test_the_pass_store_refuses_the_same_ids_the_document_store_does(passes, bad):
    """Checks that the pass store refuses the same ids the document store does."""
    with pytest.raises(MissingDocument):
        passes._passes(bad)
    with pytest.raises(MissingDocument):
        passes._dir("a1b2c3d4", bad)          # a valid doc_id, a hostile pass_id


def test_a_real_id_still_resolves_under_the_documents_directory(store):
    """The guard must not be so tight it refuses the ids the store actually mints."""
    doc = a_doc(store)
    d = store._dir(doc.id)
    assert d.parent == store._docs(), "a real id must land directly under documents/"
    assert store.get(doc.id).id == doc.id, "the ordinary read path still works"


# ─────────────────────────────────── Revision conflict detection

def _content_of(store, doc_id, n=None):
    return store.revision(doc_id, n).content["entries"]["0"]["content"]


def test_an_edit_built_on_an_older_revision_is_refused_not_silently_merged(store):
    """Checks that an edit built on an older revision is refused not silently merged."""
    doc = a_doc(store)
    loc = ("entries", "0", "content")
    store.apply_edits(doc.id, 0, [(loc, "second")], note="a")
    store.apply_edits(doc.id, 1, [(loc, "third")], note="b")

    with pytest.raises(RevisionConflict) as exc:
        store.apply_edits(doc.id, 0, [(loc, "a typo fix made while looking at revision 0")],
                          note="stale")

    assert (exc.value.base, exc.value.latest) == (0, 2), "the 409 must carry both numbers"
    assert store.revisions(doc.id) == [0, 1, 2], "a refused edit must not mint a revision"
    assert _content_of(store, doc.id) == "third", "the head moved under a refused edit"


def test_a_pass_applied_from_a_stale_base_cannot_discard_what_landed_since(store):
    """Checks that a pass applied from a stale base cannot discard what landed since."""
    doc = a_doc(store)
    loc = ("entries", "0", "content")
    store.apply_edits(doc.id, 0, [(loc, "applied by pass B")], note="B")
    stale = [Proposal(index=1, locator=loc, label="Content", status="CHANGED", original="x",
                      revised="what pass A wanted", review="approved")]

    with pytest.raises(RevisionConflict):
        store.materialize(doc.id, 0, stale, pass_id="A")

    assert _content_of(store, doc.id) == "applied by pass B", "pass B's work was discarded"


def test_rollback_is_exempt_because_going_back_is_what_he_asked_for(store):
    """Rollback bypasses the conflict guard because it intentionally restores a prior revision."""
    doc = a_doc(store)
    loc = ("entries", "0", "content")
    store.apply_edits(doc.id, 0, [(loc, "second")], note="a")
    store.apply_edits(doc.id, 1, [(loc, "third")], note="b")

    rev = store.rollback(doc.id, 0)

    assert rev.n == 3 and rev.from_revision == 0, "rollback must mint forward, never rewind"
    assert _content_of(store, doc.id) == _content_of(store, doc.id, 0)
    assert store.revisions(doc.id) == [0, 1, 2, 3], "history was truncated"
    # and the head is writable again immediately, at its new number
    store.apply_edits(doc.id, 3, [(loc, "fourth")], note="c")
    assert _content_of(store, doc.id) == "fourth"


def test_the_conflict_check_reads_the_filesystem_not_the_stale_metadata(store):
    """Checks that the conflict check reads the filesystem not the stale metadata."""
    doc = a_doc(store)
    loc = ("entries", "0", "content")
    store.apply_edits(doc.id, 0, [(loc, "second")], note="a")

    d = store.get(doc.id)
    d.latest = 0                       # simulate the crash window
    store._write_meta(d)
    assert store.get(doc.id).latest == 0 and store.latest_on_disk(doc.id) == 1

    with pytest.raises(RevisionConflict):
        store.apply_edits(doc.id, 0, [(loc, "would have overwritten revision 1")], note="stale")


def test_the_revision_index_carries_when_each_one_was_made(store):
    """The revision index exposes each revision’s stored creation timestamp."""
    doc = a_doc(store)
    store.add_revision(doc.id, {"entries": {}}, note="hand edit")
    idx = store.revision_index(doc.id)
    assert [m["n"] for m in idx] == [0, 1], "the index is not every revision, ascending"
    assert all(isinstance(m["created_at"], float) and m["created_at"] > 0 for m in idx), \
        "a revision with no usable timestamp cannot be labeled"
    assert idx[0]["note"] == "import" and idx[1]["note"] == "hand edit"
    assert idx[0]["created_at"] <= idx[1]["created_at"]


def test_the_index_reads_the_stored_time_not_the_files_mtime(store, monkeypatch):
    """Checks that the index reads the stored time not the files mtime."""
    doc = a_doc(store)
    rev = store.add_revision(doc.id, {"entries": {}}, note="hand edit")
    p = store._rev(doc.id, rev.n)
    body = json.loads(vault_fs.read_bytes(p).decode("utf-8"))
    body["created_at"] = 1_000_000_000.0                      # Use a fixed old timestamp so the test does not depend on the current date.
    vault_fs.write_json_atomic(p, body)
    assert store.revision_index(doc.id)[1]["created_at"] == 1_000_000_000.0


def test_one_unreadable_revision_does_not_break_the_whole_picker(store):
    """Checks that one unreadable revision does not break the whole picker."""
    doc = a_doc(store)
    store.add_revision(doc.id, {"entries": {}}, note="hand edit")
    vault_fs.write_bytes(store._rev(doc.id, 1), b"{not json")
    idx = store.revision_index(doc.id)
    assert [m["n"] for m in idx] == [0, 1]
    assert idx[1]["created_at"] is None


def test_a_revision_number_is_never_reused_even_if_the_metadata_disagrees(store):
    """Checks that a revision number is never reused even if the metadata disagrees."""
    doc = a_doc(store)
    store.add_revision(doc.id, {"entries": {}}, note="one")
    d = store.get(doc.id)
    d.latest = 0                                   # simulate the crash window
    store._write_meta(d)
    rev = store.add_revision(doc.id, {"entries": {"9": {}}}, note="two")
    assert rev.n == 2, "the store reused a revision number and clobbered history"
    assert store.revision(doc.id, 1).note == "one"


def test_rollback_mints_a_new_revision_and_never_rewinds(store):
    """Rollback selects an earlier revision’s content and records it as a new revision; it does not truncate history."""
    doc = a_doc(store)
    two = copy.deepcopy(BOOK)
    two["entries"]["0"]["content"] = "second"
    store.add_revision(doc.id, two, note="edit")
    three = copy.deepcopy(BOOK)
    three["entries"]["0"]["content"] = "third"
    store.add_revision(doc.id, three, note="edit")

    back = store.rollback(doc.id, 1)
    assert back.n == 3, "rollback rewound the numbering"
    assert back.from_revision == 1
    assert back.content == store.revision(doc.id, 1).content
    assert store.revisions(doc.id) == [0, 1, 2, 3], "rollback deleted history"


def test_delete_takes_the_whole_document_including_its_passes(store, passes):
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="x", model="m", sampler={}, selection=[],
                     total=1)
    assert passes.list_passes(doc.id)
    store.delete(doc.id)
    assert not (store.root / DOCS_DIR / doc.id).exists()
    assert passes.list_passes(doc.id) == []
    with pytest.raises(MissingDocument):
        store.get(doc.id)


def test_a_card_keeps_its_focus_rect_and_it_is_not_in_the_revision(store):
    """§4.3 — the rect describes the IMAGE. It arrives with the card at no extra cost, and it
    belongs to the Document (and its Asset) rather than to document text."""
    doc = store.create(copy.deepcopy(CARD), name="Test Character 2", kind="card",
                       focus=CARD["data"]["extensions"]["taproom_avatar_focus"])
    assert store.get(doc.id).focus == {"x": 0.1, "y": 0.2, "w": 0.5}


# ───────────────────────────────────────────────────────── passes & proposals

def _proposal(index=1, status="CHANGED", review="approved", **kw):
    kw.setdefault("locator", ("entries", "0", "content"))
    kw.setdefault("label", "Sample Entry 1")
    kw.setdefault("original", "Test Character 1 keeps the ledger.")
    kw.setdefault("revised", "Renamed Character 1 keeps the ledger.")
    return Proposal(index=index, status=status, review=review, **kw)


def test_a_pass_is_durable_before_the_first_request_goes_out(passes, store):
    """I10 in fact rather than by convention: the byte-frozen instruction is on disk before any
    field is sent, so nothing later can amend the string the pass is defined by."""
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="Rename X to Y.", model="glm",
                     sampler={"rep_pen": 1.0}, selection=[["entries", "0", "content"]], total=3)
    on_disk = passes.get(doc.id, p.id)
    assert on_disk.instruction == "Rename X to Y."
    assert on_disk.status == "running" and on_disk.cursor == 0
    assert on_disk.sampler["rep_pen"] == 1.0, "the sampler a pass ran under was not recorded"
    assert on_disk.model == "glm", "§3.1 — a pass run under another model is not the same pass"


def test_each_proposal_is_its_own_file_so_a_flush_is_not_o_of_the_pass(passes, store):
    """§5 — flush per field, not per pass. A 30-minute run must survive a restart with everything
    up to field N durable, and the cost of that must not grow with N."""
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="i", model="m", sampler={}, selection=[],
                     total=3)
    for i in (1, 2, 3):
        passes.record(doc.id, p.id, _proposal(index=i))
    d = passes.root / DOCS_DIR / doc.id / "passes" / p.id / "prop"
    assert sorted(x.name for x in d.iterdir()) == ["0001.json", "0002.json", "0003.json"]


def test_the_cursor_advances_only_after_the_proposal_is_durable(passes, store, monkeypatch):
    """Checks that the cursor advances only after the proposal is durable."""
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="i", model="m", sampler={}, selection=[],
                     total=2)
    seen = []
    real = vault_fs.write_json_atomic

    def spy(path, obj, **kw):
        seen.append(Path(path).name)
        return real(path, obj, **kw)

    monkeypatch.setattr(vault_fs, "write_json_atomic", spy)
    passes.record(doc.id, p.id, _proposal(index=1))
    assert seen == ["0001.json", "meta.json"], \
        f"the cursor was written before the proposal it counts: {seen}"
    assert passes.get(doc.id, p.id).cursor == 1


def test_the_cursor_never_moves_backwards_on_a_resumed_field(passes, store):
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="i", model="m", sampler={}, selection=[],
                     total=110)
    passes.record(doc.id, p.id, _proposal(index=110))
    passes.record(doc.id, p.id, _proposal(index=34))
    assert passes.get(doc.id, p.id).cursor == 110, \
        "a re-run field rewound the cursor and would re-run everything after it"


def test_review_marks_a_row_and_never_touches_the_document(passes, store):
    """Checks that review marks a row and never touches the document."""
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="i", model="m", sampler={}, selection=[],
                     total=1)
    passes.record(doc.id, p.id, _proposal(index=1, review="pending"))
    passes.review(doc.id, p.id, 1, "approved")
    assert passes.proposal(doc.id, p.id, 1).review == "approved"
    assert store.revisions(doc.id) == [0], "approving a proposal minted a revision"
    assert store.revision(doc.id, 0).content == BOOK


def test_a_hand_edit_implies_approval_and_is_what_gets_applied(passes, store):
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="i", model="m", sampler={}, selection=[],
                     total=1)
    passes.record(doc.id, p.id, _proposal(index=1, review="pending"))
    got = passes.review(doc.id, p.id, 1, "edited", edited="Test User's own words.")
    assert got.review == "edited"
    assert got.text == "Test User's own words.", "the hand-edit is not what would be applied"


def test_bulk_review_leaves_the_rows_with_nothing_to_decide_alone(passes, store):
    """"Approve all" on a pass with 80 NOCHANGE rows must not report 80 approvals that apply
    nothing — that makes the count in the confirmation dialog a lie."""
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="i", model="m", sampler={}, selection=[],
                     total=3)
    passes.record(doc.id, p.id, _proposal(index=1, review="pending"))
    passes.record(doc.id, p.id, _proposal(index=2, status="NOCHANGE", review="none",
                                          revised=None))
    passes.record(doc.id, p.id, _proposal(index=3, review="pending"))
    assert passes.review_all(doc.id, p.id, "approved") == 2
    assert passes.proposal(doc.id, p.id, 2).review == "none"


# ───────────────────────────────────────────────────────── materialize

def test_materialize_applies_only_the_accepted_rows(store, passes):
    """Checks that materialize applies only the accepted rows."""
    doc = a_doc(store)
    props = [
        _proposal(index=1, review="approved", locator=("entries", "0", "content"),
                  revised="Renamed Character 1 keeps the ledger."),
        _proposal(index=2, review="rejected", locator=("entries", "1", "content"),
                  original="The rains come off the estuary.", revised="REJECTED TEXT"),
        _proposal(index=3, review="edited", locator=("entries", "2", "content"),
                  original="Test Character 1 never goes above.", revised="model text",
                  edited="Test User's own words."),
    ]
    rev = store.materialize(doc.id, 0, props, pass_id="p1")
    assert rev is not None and rev.n == 1 and rev.from_revision == 0 and rev.pass_id == "p1"
    e = rev.content["entries"]
    assert e["0"]["content"] == "Renamed Character 1 keeps the ledger."
    assert e["1"]["content"] == "The rains come off the estuary.", "a rejected row was applied"
    assert e["2"]["content"] == "Test User's own words."


def test_materialize_leaves_everything_it_did_not_address_byte_identical(store):
    """Checks that materialize leaves everything it did not address byte identical."""
    doc = store.create(copy.deepcopy(CARD), name="Test Character 2", kind="card")
    props = [_proposal(index=1, locator=("data", "description"), original="A tall woman.",
                       revised="A tall, wry woman.")]
    rev = store.materialize(doc.id, 0, props)
    before = copy.deepcopy(CARD)
    after = copy.deepcopy(rev.content)
    before["data"]["description"] = after["data"]["description"]
    assert json.dumps(after) == json.dumps(before), \
        "materializing changed something outside the field it was given"


def test_materialize_returns_none_when_nothing_was_accepted(store):
    doc = a_doc(store)
    props = [_proposal(index=1, review="rejected"),
             _proposal(index=2, status="NOCHANGE", review="none", revised=None)]
    assert store.materialize(doc.id, 0, props) is None
    assert store.revisions(doc.id) == [0], "an empty pass minted a revision"


def test_materialize_is_loud_when_the_document_moved_under_the_pass(store):
    """Possible only if a revision was minted between the pass starting and being reviewed.
    Silently dropping the field would report "applied" for an edit that never landed."""
    doc = a_doc(store)
    props = [_proposal(index=1, locator=("entries", "99", "content"))]
    with pytest.raises(MissingDocument):
        store.materialize(doc.id, 0, props)


def test_the_base_revision_is_never_mutated_by_materializing_from_it(store):
    """Checks that the base revision is never mutated by materializing from it."""
    doc = a_doc(store)
    store.materialize(doc.id, 0, [_proposal(index=1)])
    assert store.revision(doc.id, 0).content == BOOK


# ───────────────────────────────────────────────────────── the whole loop, stored

def test_a_pass_runs_and_every_proposal_survives_a_restart(store, passes):
    """Checks that a pass runs and every proposal survives a restart."""
    doc = a_doc(store)
    jobs = formats.collect(store.revision(doc.id, 0).content, rel="sample-world-book-1.json")
    assert len(jobs) == 3

    p = passes.start(doc.id, revision=0, instruction="Rename Test Character 1 to Renamed Character 1.",
                     model="mock", sampler={"rep_pen": 1.0},
                     selection=[list(j.locator) for j in jobs], total=len(jobs))

    for ev in runner.run(jobs, instruction="Rename Test Character 1 to Renamed Character 1.",
                         backend=MockBackend(), prompt=lambda j, i: [{"role": "user",
                                                                     "content": j.original}],
                         sleep=lambda _s: None):
        if ev.kind == runner.FIELD_RESULT:
            passes.record(doc.id, p.id, Proposal.from_event(ev))
        if ev.kind == runner.PASS_FINISH:
            passes.finish(doc.id, p.id, tally=ev.tally)

    fresh = PassStore(store.root)                       # nothing in memory survives
    reread = fresh.get(doc.id, p.id)
    assert reread.status == "done" and reread.cursor == 3
    props = fresh.proposals(doc.id, p.id)
    # Document order: the Ledger and the X entry both name Test Character 1; Weather does not.
    assert [x.status for x in props] == ["CHANGED", "NOCHANGE", "CHANGED"]
    assert [x.review for x in props] == ["approved", "none", "approved"], \
        "I7 — an unflagged CHANGED row defaults to approved; a NOCHANGE row has nothing to decide"

    rev = DocumentStore(store.root).materialize(doc.id, 0, props, pass_id=p.id)
    assert rev is not None and rev.n == 1
    assert "Test Character 1" not in json.dumps(rev.content), "the pass did not reach the document"
    # I9, at the end of the whole pipeline: the X entry was edited like its neighbors.
    assert rev.content["entries"]["2"]["content"].startswith("Renamed Character 1")


def test_a_proposal_round_trips_through_json_with_its_locator_types_intact(passes, store):
    """Checks that a proposal round trips through json with its locator types intact."""
    doc = a_doc(store)
    p = passes.start(doc.id, revision=0, instruction="i", model="m", sampler={}, selection=[],
                     total=2)
    passes.record(doc.id, p.id, _proposal(index=1, locator=("entries", "3", "content")))
    passes.record(doc.id, p.id, _proposal(index=2, locator=("data", "character_book", "entries",
                                                            0, "content")))
    got = {x.index: x.locator for x in PassStore(store.root).proposals(doc.id, p.id)}
    assert got[1] == ("entries", "3", "content")
    assert got[2] == ("data", "character_book", "entries", 0, "content")


# ───────────────────────────────────────────────────────── the instruction library

@pytest.fixture
def library(tmp_path):
    return InstructionLibrary(tmp_path / "wbedit")


def test_the_library_survives_being_thrown_away_and_rebuilt(library, tmp_path):
    """A new store instance reads the same persisted library after reconstruction."""
    library.add(name="Americanize", text="Change British spellings to American.")
    again = InstructionLibrary(tmp_path / "wbedit")
    assert [i.name for i in again.list()] == ["Americanize"]


def test_one_library_is_shared_by_cards_and_books(library):
    """Cards and worldbooks share one document library; `kind` filters views without partitioning storage."""
    library.add(name="Both", text="Tighten the prose, keep every proper noun.")
    library.add(name="Cards only", text="Rewrite in second person.", kind="card")
    # Most recently updated first — the picker's order, not insertion order.
    assert [i.name for i in library.list()] == ["Cards only", "Both"]
    assert [i.name for i in library.list("worldbook")] == ["Both"]
    assert {i.name for i in library.list("card")} == {"Both", "Cards only"}


def test_favorites_come_first(library):
    library.add(name="Ordinary", text="a")
    fav = library.add(name="Starred", text="b")
    library.update(fav.id, favorite=True)
    assert [i.name for i in library.list()][0] == "Starred"


def test_a_locked_or_corrupt_library_is_never_written_over(library):
    """Checks that a locked or corrupt library is never written over."""
    library.add(name="Precious", text="twenty minutes of refining")
    library.path.write_text("{ broken", encoding="utf-8")
    with pytest.raises(StoreCorrupt):
        library.list()
    with pytest.raises(StoreCorrupt):
        library.add(name="New", text="x")
    assert library.path.read_text(encoding="utf-8") == "{ broken"


def test_an_unknown_field_is_refused_rather_than_ignored(library):
    """Checks that an unknown field is refused rather than ignored."""
    ins = library.add(name="a", text="b")
    with pytest.raises(ValueError):
        library.update(ins.id, favourite=True)         # Accept the legacy spelling for reads while using the current spelling for writes.


def test_a_run_is_attached_to_the_instruction_that_produced_it(library):
    """§5 — the evidence about whether an instruction is any good."""
    ins = library.add(name="Rename", text="Rename X to Y.")
    library.record_run(ins.id, doc_id="d1", doc_name="Sample World Book 1", pass_id="p1",
                       tally={"CHANGED": 34, "NOCHANGE": 76})
    runs = library.get(ins.id).runs
    assert len(runs) == 1 and runs[0]["tally"]["CHANGED"] == 34
    assert runs[0]["doc_name"] == "Sample World Book 1"


def test_a_deleted_instruction_does_not_fail_a_finished_pass(library):
    """A pass outliving the library entry it came from is normal."""
    library.record_run("gone", doc_id="d", doc_name="n", pass_id="p", tally={})


def test_editing_a_library_entry_cannot_reach_back_into_a_pass_that_used_it(library, passes,
                                                                            store):
    """I10 — the library holds the editable master; a Pass holds the frozen copy taken when it
    started. A report must never describe an instruction that never ran."""
    doc = a_doc(store)
    ins = library.add(name="Rename", text="Rename Test Character 10 to Renamed Test Character 10.")
    p = passes.start(doc.id, revision=0, instruction=ins.text, model="m", sampler={},
                     selection=[], total=1)
    library.update(ins.id, text="COMPLETELY DIFFERENT")
    assert passes.get(doc.id, p.id).instruction == "Rename Test Character 10 to Renamed Test Character 10."


# ─────────────────────────────────── §8.2 — a card's primary book, held by ID
#
# 🔴 EVERY FAILURE IN THIS SECTION IS SILENT. A card points at its book by NAME
# (`data.extensions.world`) because that is SillyTavern's format; we resolve that name to a
# `Document.id` once, at import, and the Character Cards filter matches on the id — which is why a
# rename cannot break it. When the resolution is wrong there is no exception and no empty row:
# the character simply never appears under its book, and nothing anywhere says why. So each of
# these tests is about a link that would otherwise go quietly missing.


def a_card(store, name="Test Character 9", world_ref="", content=None):
    return store.create(copy.deepcopy(content or CARD), name=name, kind="card",
                        world_ref=world_ref)


def test_a_card_imported_after_its_book_resolves_to_that_books_id(store):
    """Checks that a card imported after its book resolves to that books id."""
    book = a_doc(store, name="Sample World Book 2")
    card = a_card(store, world_ref="Sample World Book 2")
    got = store.get(card.id)
    assert got.world_id == book.id, "a card imported after its book did not resolve to it"
    assert got.world_ref == "Sample World Book 2", "the name the card carried was discarded"


def test_a_card_imported_before_its_book_is_linked_when_the_book_arrives(store):
    """Retain `world_ref` when its worldbook is unavailable so a later import can complete the link."""
    card = a_card(store, world_ref="Sample World Book 2")
    assert store.get(card.id).world_id == "", "there was no book yet — nothing to resolve to"

    book = a_doc(store, name="Sample World Book 2")
    assert store.get(card.id).world_id == book.id, \
        "the book arrived and the card that named it was left orphaned"


def test_renaming_a_book_to_the_name_a_card_already_carried_completes_the_link(store):
    """A renamed assembled worldbook can match the reference retained by an imported card."""
    book = a_doc(store, name="Sample World Book 2-compiled")
    card = a_card(store, world_ref="Sample World Book 2")
    assert store.get(card.id).world_id == "", "it matched a name the book did not have"

    store.rename(book.id, "Sample World Book 2")
    assert store.get(card.id).world_id == book.id, \
        "a rename that finally matched the card's world_ref did not link it"


def test_linking_orphans_never_steals_a_card_that_is_already_linked_elsewhere(store):
    """Only an empty `world_id` may be filled; a name match must not replace another valid link."""
    first = a_doc(store, name="Sample World Book 2")
    card = a_card(store, world_ref="Sample World Book 2")
    assert store.get(card.id).world_id == first.id

    store.rename(first.id, "Sample World Book 2 Prime")
    assert store.get(card.id).world_id == first.id, "a rename broke a link held by id"

    second = a_doc(store, name="Sample World Book 2")
    assert store.get(card.id).world_id == first.id, \
        "a newly imported book stole a card that was already linked"
    assert second.id != first.id


def test_linking_orphans_is_idempotent_and_the_second_run_reports_nothing_to_do(store):
    """Repeated reconciliation is idempotent and reports only links created by the current call."""
    book = a_doc(store, name="Sample World Book 2-compiled")
    card = a_card(store, world_ref="Sample World Book 2")

    book.name = "Sample World Book 2"                        # what `rename()` hands it
    assert store.link_orphan_cards(book) == 1
    assert store.link_orphan_cards(book) == 0, "a second run re-counted a link it had made before"
    assert store.get(card.id).world_id == book.id


def test_a_books_name_matches_a_cards_world_ref_ignoring_case_and_whitespace(store):
    """Worldbook reference matching strips whitespace and ignores case in both directions."""
    early = a_card(store, name="Imported first", world_ref="  sample world book 2 ")
    book = a_doc(store, name="Sample World Book 2")
    late = a_card(store, name="Imported second", world_ref=" SAMPLE WORLD BOOK 2\t")

    assert store.get(early.id).world_id == book.id, "link_orphan_cards matched too strictly"
    assert store.get(late.id).world_id == book.id, "resolve_worldbook matched too strictly"
    assert store.resolve_worldbook("\nSaMpLe WoRlD BoOk 2  ") == book.id


def test_a_card_naming_a_book_we_do_not_hold_keeps_the_name_and_resolves_nothing(store):
    """Preserve references to unavailable worldbooks so they can resolve if the book is imported later."""
    card = a_card(store, world_ref="Sample World Book 9")
    got = store.get(card.id)
    assert got.world_ref == "Sample World Book 9", "the unresolved name was thrown away"
    assert got.world_id == ""
    assert store.resolve_worldbook("Sample World Book 9") == ""


def test_a_card_with_no_primary_book_carries_neither_half_of_the_link(store):
    """Checks that a card with no primary book carries neither half of the link."""
    other = a_card(store, name="Also book-less")
    card = a_card(store)
    got = store.get(card.id)
    assert got.world_ref == "" and got.world_id == ""
    assert store.resolve_worldbook("") == "" and store.resolve_worldbook("   ") == ""
    assert store.get(other.id).world_id == ""


def test_only_a_worldbook_with_a_name_can_claim_the_cards_that_named_it(store):
    """Checks that only a worldbook with a name can claim the cards that named it."""
    orphan = a_card(store, world_ref="Sample World Book 2")
    bookless = a_card(store, name="Also book-less")

    impostor = a_card(store, name="Sample World Book 2")            # a CARD, not a worldbook
    assert store.link_orphan_cards(impostor) == 0
    assert store.get(orphan.id).world_id == "", "a card claimed another card's world_ref"

    nameless = a_doc(store, name="   ")
    assert store.link_orphan_cards(nameless) == 0
    assert store.get(bookless.id).world_id == "", \
        "a blank-named book swallowed every card that had no book"


def test_a_worldbook_never_gets_a_world_id_even_if_it_arrives_with_a_world_ref(store):
    """Checks that a worldbook never gets a world id even if it arrives with a world ref."""
    a_doc(store, name="Sample World Book 2")
    odd = store.create(copy.deepcopy(BOOK), name="Sample World Book 10", kind="worldbook",
                       world_ref="Sample World Book 2")
    assert store.get(odd.id).world_id == "", "a worldbook resolved a world_ref of its own"

    # ...and it stays empty when the named book is (re)imported and sweeps for orphans.
    again = a_doc(store, name="Sample World Book 2")
    assert store.link_orphan_cards(again) == 0
    assert store.get(odd.id).world_id == ""


def test_both_halves_of_the_world_link_survive_the_json_round_trip(store):
    """Persist both worldbook link fields through serialization and reload."""
    doc = Document(id="abc", kind="card", name="Test Character 9", world_ref="Sample World Book 2",
                   world_id="deadbeefdeadbeef", world_set=True)
    d = doc.to_dict()
    assert d["world_ref"] == "Sample World Book 2" and d["world_id"] == "deadbeefdeadbeef"
    # `world_set` tells a send the link was explicitly selected rather than inherited from the
    # card; an in-memory-only flag would arm an unlink of the linked SillyTavern
    # card for exactly as long as the process ran, and then quietly stop doing so.
    assert d["world_set"] is True
    back = Document.from_dict(json.loads(json.dumps(d)))
    assert back.world_ref == "Sample World Book 2" and back.world_id == "deadbeefdeadbeef"
    assert back.world_set is True

    # And through the store, which is the path the Library actually uses.
    book = a_doc(store, name="Sample World Book 2")
    card = a_card(store, world_ref="Sample World Book 2")
    assert DocumentStore(store.root).get(card.id).world_id == book.id


def test_a_document_written_before_the_world_fields_existed_still_loads(store):
    """Documents created before world-link fields existed load with safe defaults."""
    doc = a_card(store, world_ref="Sample World Book 2")
    p = store.root / DOCS_DIR / doc.id / "meta.json"
    old = json.loads(p.read_text(encoding="utf-8"))
    del old["world_ref"]
    del old["world_id"]
    p.write_text(json.dumps(old), encoding="utf-8")

    got = store.get(doc.id)
    assert got.world_ref == "" and got.world_id == ""
    assert got.name == "Test Character 9" and got.kind == "card", "the rest of the record was lost"
    assert [d.id for d in store.list_documents()] == [doc.id], \
        "an old record made the Library unreadable"

    # The bare minimum a very old record could be, straight through the model.
    bare = Document.from_dict({"id": "x", "kind": "card"})
    assert bare.world_ref == "" and bare.world_id == ""
    # Keep `world_set` false when absent so unrelated saves do not write a link the user never selected.
    assert bare.world_set is False


def test_deleting_a_worldbook_releases_the_cards_that_pointed_at_it(store):
    """Deleting a worldbook clears dangling ids while preserving the card’s textual reference."""
    book = a_doc(store, name="Sample World Book 2")
    card = a_card(store, world_ref="Sample World Book 2")
    other = a_card(store, name="Test Character 12", world_ref="Somewhere Else")
    assert store.get(card.id).world_id == book.id, "precondition: the card was linked"

    store.delete(book.id)

    got = store.get(card.id)
    assert got.world_id == "", "the card kept an id pointing at a book that no longer exists"
    assert got.world_ref == "Sample World Book 2", \
        "the card's own name for its book was thrown away, making the state unrecoverable"
    assert store.get(other.id).world_ref == "Somewhere Else", "an unrelated card was touched"


def test_a_released_card_relinks_when_its_book_comes_back(store):
    """Checks that a released card relinks when its book comes back."""
    book = a_doc(store, name="Sample World Book 2")
    card = a_card(store, world_ref="Sample World Book 2")
    store.delete(book.id)

    again = a_doc(store, name="Sample World Book 2")
    assert store.get(card.id).world_id == again.id, \
        "re-importing the book did not pick the released card back up"


def test_deleting_a_card_releases_nothing_and_raises_nothing(store):
    """Checks that deleting a card releases nothing and raises nothing."""
    book = a_doc(store, name="Sample World Book 2")
    keep = a_card(store, world_ref="Sample World Book 2")
    doomed = a_card(store, name="Test Character 13")

    store.delete(doomed.id)
    assert store.get(keep.id).world_id == book.id, "deleting one card broke another card's link"


def test_a_document_whose_record_is_corrupt_can_still_be_deleted(store):
    """Checks that a document whose record is corrupt can still be deleted."""
    doc = a_doc(store, name="Sample World Book 2")
    (store.root / DOCS_DIR / doc.id / "meta.json").write_text("{not json", encoding="utf-8")

    store.delete(doc.id)
    assert not (store.root / DOCS_DIR / doc.id).exists(), "a corrupt document could not be deleted"


# ── Atomic file reads ────────────────────────────────────────────────────────

def test_a_read_retries_the_windows_sharing_violation_and_then_raises(monkeypatch, tmp_path):
    """Checks that a read retries the windows sharing violation and then raises."""
    from wbedit.store import documents as d

    p = tmp_path / "meta.json"
    p.write_text('{"ok": true}', encoding="utf-8")

    calls = {"n": 0}
    real = d.vault_fs.read_text

    def flaky(path, *a, **kw):
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError(13, "sharing violation")
        return real(path, *a, **kw)

    monkeypatch.setattr(d.vault_fs, "read_text", flaky)
    monkeypatch.setattr(d, "_READ_DELAY_S", 0.0)
    assert d._read_json(p) == {"ok": True}
    assert calls["n"] == 3, "it must actually have retried, not swallowed the error"


def test_a_read_that_never_succeeds_RAISES_rather_than_returning_nothing(monkeypatch, tmp_path):
    """Checks that a read that never succeeds raises rather than returning nothing."""
    from wbedit.store import documents as d

    monkeypatch.setattr(d.vault_fs, "read_text",
                        lambda *a, **kw: (_ for _ in ()).throw(PermissionError(13, "locked")))
    monkeypatch.setattr(d, "_READ_DELAY_S", 0.0)
    with pytest.raises(PermissionError):
        d._read_json(tmp_path / "meta.json")


def test_a_corrupt_file_is_NOT_retried(monkeypatch, tmp_path):
    """Checks that a corrupt file is not retried."""
    from wbedit.store import documents as d

    calls = {"n": 0}

    def counted(path, *a, **kw):
        calls["n"] += 1
        return "{not json at all"

    monkeypatch.setattr(d.vault_fs, "read_text", counted)
    with pytest.raises(d.StoreCorrupt) as exc:
        d._read_json(tmp_path / "meta.json")
    assert calls["n"] == 1, "a parse failure must not be retried"
    assert "not json at all" not in str(exc.value), "I16 — the body reached the message"
