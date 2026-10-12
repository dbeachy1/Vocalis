"""Tests shared-store locking and concurrent document updates."""
from __future__ import annotations

import ast
import copy
import inspect
import json
import textwrap
import threading

import pytest

from conftest import REPO_ROOT

import vault_fs
from wbedit.store import DocumentStore, InstructionLibrary, MissingDocument, PassStore
from wbedit.store.models import Proposal

#: How long the winning thread waits at a barrier the loser can never reach. Paid once per race
#: test, and ONLY when the code is correct — the failing path trips the barrier immediately.
_BARRIER_S = 1.0

BOOK = {
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "constant": False, "disable": False, "order": 100,
              "comment": "Sample Entry 1", "content": "Test Character 1 keeps the ledger."},
    }
}


@pytest.fixture
def root(tmp_path):
    return tmp_path / "wbedit"


@pytest.fixture
def store(root):
    return DocumentStore(root)


def a_doc(store, kind="worldbook", name="Sample World Book 1"):
    return store.create(copy.deepcopy(BOOK), name=name, kind=kind)


def _rendezvous(target, n=2):
    """Checks that rendezvous."""
    barrier = threading.Barrier(n)

    def wait():
        try:
            barrier.wait(timeout=_BARRIER_S)
        except threading.BrokenBarrierError:
            pass

    return barrier, wait


def _run(*fns):
    """Run each callable on its own thread; re-raise the first exception any of them saw."""
    errors: list[BaseException] = []

    def guard(fn):
        def go():
            try:
                fn()
            except BaseException as exc:            # noqa: BLE001 — re-raised on the main thread
                errors.append(exc)
        return go

    threads = [threading.Thread(target=guard(fn)) for fn in fns]
    for t in threads:
        t.start()
    for t in threads:
        # Generous, and bounded: pytest's own --timeout=60 is the real ceiling. A thread still
        # alive here means a deadlock, and `is_alive` says so loudly rather than hanging.
        t.join(timeout=30)
    alive = [t for t in threads if t.is_alive()]
    assert not alive, f"{len(alive)} worker thread(s) never finished — deadlock in the store"
    if errors:
        raise errors[0]


# ─────────────────────────────────────── §3.4 revision-number reuse ────────────────────────

def test_two_concurrent_add_revision_calls_never_mint_the_same_number(root, monkeypatch):
    """Checks that two concurrent add revision calls never mint the same number."""
    doc = a_doc(DocumentStore(root))
    _barrier, wait = _rendezvous(None)
    real = DocumentStore.revisions

    def slow_revisions(self, doc_id):
        out = real(self, doc_id)
        wait()                       # both threads have now READ the revision list
        return out

    monkeypatch.setattr(DocumentStore, "revisions", slow_revisions)

    def mint(word):
        body = copy.deepcopy(BOOK)
        body["entries"]["0"]["content"] = word
        DocumentStore(root).add_revision(doc.id, body, note=word)

    _run(lambda: mint("alpha"), lambda: mint("beta"))

    monkeypatch.undo()
    plain = DocumentStore(root)
    numbers = plain.revisions(doc.id)
    assert numbers == [0, 1, 2], f"a revision number was reused or lost: {numbers}"
    bodies = {plain.revision(doc.id, n).content["entries"]["0"]["content"] for n in (1, 2)}
    assert bodies == {"alpha", "beta"}, f"one writer's content was destroyed: {bodies}"
    assert plain.get(doc.id).latest == 2


# ─────────────────────────────────────── §3.4 metadata clobber ─────────────────────────────

def test_a_rename_racing_an_avatar_upload_loses_neither(root, monkeypatch):
    """Checks that a rename racing an avatar upload loses neither."""
    doc = a_doc(DocumentStore(root), kind="card", name="Test Character 2")
    _barrier, wait = _rendezvous(None)
    real = DocumentStore._write_meta

    def slow_write(self, record):
        wait()                       # both threads have now READ meta.json
        return real(self, record)

    monkeypatch.setattr(DocumentStore, "_write_meta", slow_write)

    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    _run(lambda: DocumentStore(root).put_avatar(doc.id, png),
         lambda: DocumentStore(root).rename(doc.id, "Test Character 2 of Sample Setting"))

    monkeypatch.undo()
    after = DocumentStore(root).get(doc.id)
    assert after.name == "Test Character 2 of Sample Setting", "the rename was clobbered by the avatar write"
    assert after.avatar_dirty is True, "avatar_dirty was clobbered — the picture never reaches ST"


# ─────────────────────────────────────── §3.4 the dismissed list ───────────────────────────

def test_two_dismissals_at_once_keep_both(root, monkeypatch):
    """Checks that two dismissals at once keep both."""
    _barrier, wait = _rendezvous(None)
    real = DocumentStore._read_dismissed

    def slow_read(self):
        out = real(self)
        wait()
        return out

    monkeypatch.setattr(DocumentStore, "_read_dismissed", slow_read)
    _run(lambda: DocumentStore(root).dismiss("Test Character 10.png"),
         lambda: DocumentStore(root).dismiss("Test Character 11.png"))

    monkeypatch.undo()
    assert sorted(DocumentStore(root).dismissed()) == ["Test Character 10.png", "Test Character 11.png"]


# ─────────────────────────────────────── §3.4 / §3.3 the pass record ───────────────────────

def test_two_proposals_recorded_at_once_keep_both_tallies(root, monkeypatch):
    """Checks that two proposals recorded at once keep both tallies."""
    doc = a_doc(DocumentStore(root))
    p = PassStore(root).start(doc.id, revision=0, instruction="tighten", model="m",
                              sampler={}, selection=[["entries", "0", "content"]], total=2)
    _barrier, wait = _rendezvous(None)
    real = PassStore.get

    def slow_get(self, doc_id, pass_id):
        out = real(self, doc_id, pass_id)
        wait()
        return out

    monkeypatch.setattr(PassStore, "get", slow_get)

    def record(i):
        prop = Proposal(index=i, locator=("entries", "0", "content"), label=f"f{i}",
                        status="CHANGED", original="a", revised="b", review="approved")
        PassStore(root).record(doc.id, p.id, prop)

    _run(lambda: record(1), lambda: record(2))

    monkeypatch.undo()
    after = PassStore(root).get(doc.id, p.id)
    assert sum(after.tally.values()) == 2, f"a proposal fell out of the tally: {after.tally}"
    assert after.cursor == 2, f"the resume cursor lost a field: {after.cursor}"


# ─────────────────────────────────────── §3.4 the instruction library ──────────────────────

def test_two_instructions_added_at_once_both_survive(root, monkeypatch):
    """Checks that two instructions added at once both survive."""
    _barrier, wait = _rendezvous(None)
    real = InstructionLibrary._read

    def slow_read(self):
        out = real(self)
        wait()
        return out

    monkeypatch.setattr(InstructionLibrary, "_read", slow_read)
    _run(lambda: InstructionLibrary(root).add(name="British to American", text="…"),
         lambda: InstructionLibrary(root).add(name="Tighten the prose", text="…"))

    monkeypatch.undo()
    assert sorted(i.name for i in InstructionLibrary(root).list()) == [
        "British to American", "Tighten the prose"]


# ─────────────────────────────────────── §1.2 carry the drafts forward ─────────────────────
#
# 🔴 **EVERY TEST BELOW GOES THROUGH A PUBLIC MINTING METHOD, NOT THROUGH `_carry_drafts`.**
# The finding is not "there is no carry function" — it is that a revision can be minted without
# one running. Testing the helper directly would prove the helper works and prove nothing about
# the five paths that reach it, which is exactly the gap a route-level fix would have left
# around `POST /pair/documents`.


def _put(store, doc_id, revision, locator, text):
    return store.put_draft(doc_id, revision, locator, text)


def test_minting_a_revision_carries_pending_typing_onto_it(store):
    """Checks that minting a revision carries pending typing onto it."""
    doc = a_doc(store)
    _put(store, doc.id, 0, ["entries", "0", "content"], "half a sentence")
    _put(store, doc.id, 0, ["entries", "0", "comment"], "renamed heading")

    new = store.add_revision(doc.id, copy.deepcopy(BOOK), note="added entry")

    assert store.drafts(doc.id, new.n) == {'["entries","0","content"]': "half a sentence",
                                           '["entries","0","comment"]': "renamed heading"}
    assert store.drafts(doc.id, 0) == {}, "the draft must not answer for its old revision too"


def test_a_rollback_carries_the_drafts_too(store):
    """Checks that a rollback carries the drafts too."""
    doc = a_doc(store)
    store.add_revision(doc.id, copy.deepcopy(BOOK), note="one")
    _put(store, doc.id, 1, ["entries", "0", "content"], "still unsaved")

    new = store.rollback(doc.id, 0)
    assert new.n == 2
    assert store.drafts(doc.id, 2) == {'["entries","0","content"]': "still unsaved"}


def test_an_st_re_push_carries_the_drafts_too(store):
    """Checks that an st re push carries the drafts too."""
    doc = store.create(copy.deepcopy(BOOK), name="Sample World Book 2", kind="worldbook", source="st",
                       st_ref="Sample World Book 2")
    _put(store, doc.id, 0, ["entries", "0", "content"], "typed while ST was pushing")

    changed = copy.deepcopy(BOOK)
    changed["entries"]["0"]["content"] = "pushed from SillyTavern"
    again, created = store.import_from_st(changed, kind="worldbook", st_ref="Sample World Book 2",
                                          name="Sample World Book 2")
    assert created is False and again.latest == 1
    assert store.drafts(doc.id, 1) == {'["entries","0","content"]': "typed while ST was pushing"}


def test_materializing_a_pass_carries_the_drafts_too(store):
    from wbedit.store.models import Proposal as P
    doc = a_doc(store)
    _put(store, doc.id, 0, ["entries", "0", "comment"], "a heading I was mid-way through")
    prop = P(index=1, locator=("entries", "0", "content"), label="Sample Entry 1", status="CHANGED",
             original="Test Character 1 keeps the ledger.", revised="Test Character 10 keeps the ledger.",
             review="approved")
    new = store.materialize(doc.id, 0, [prop], pass_id="a" * 16)
    assert new is not None
    assert store.drafts(doc.id, new.n) == {
        '["entries","0","comment"]': "a heading I was mid-way through"}


def test_a_draft_from_an_older_revision_is_not_resurrected(store):
    """Checks that a draft from an older revision is not resurrected."""
    doc = a_doc(store)
    _put(store, doc.id, 0, ["entries", "0", "content"], "typed against revision 0")
    # Mint two revisions WITHOUT the carry seeing the second: the first carries 0 → 1, so pin it
    # back to 0 to stand in for a draft left behind by an older build or a crashed mint.
    store.add_revision(doc.id, copy.deepcopy(BOOK), note="one")
    stale = {"revision": 0, "fields": {'["entries","0","content"]': "typed against revision 0"}}
    vault_fs.write_json_atomic(store._draft(doc.id), stale, indent=2)

    new = store.add_revision(doc.id, copy.deepcopy(BOOK), note="two")
    assert new.n == 2
    assert store.drafts(doc.id, 2) == {}, "a draft from the wrong base was resurrected"
    assert store.drafts(doc.id, 0) == {'["entries","0","content"]': "typed against revision 0"}


def test_a_hand_edit_clears_the_draft_rather_than_carrying_it(store):
    """Checks that a hand edit clears the draft rather than carrying it."""
    doc = a_doc(store)
    _put(store, doc.id, 0, ["entries", "0", "content"], "Test Character 1 audits the ledger.")

    new = store.apply_edits(doc.id, 0,
                            [(("entries", "0", "content"), "Test Character 1 audits the ledger.")])
    assert new is not None and new.n == 1
    assert store.drafts(doc.id, 1) == {}, "a hand edit carried its own draft forward"
    assert store.drafts(doc.id, 0) == {}
    assert not vault_fs.exists(store._draft(doc.id))


def test_a_save_that_changes_nothing_does_not_eat_the_pending_edits(store):
    """Checks that a save that changes nothing does not eat the pending edits."""
    doc = a_doc(store)
    _put(store, doc.id, 0, ["entries", "0", "content"], "unsaved and still wanted")
    assert store.apply_edits(doc.id, 0, []) is None
    assert store.drafts(doc.id, 0) == {"[\"entries\",\"0\",\"content\"]":
                                       "unsaved and still wanted"}


def test_clear_drafts_still_clears(store):
    """Checks that clear drafts still clears."""
    doc = a_doc(store)
    _put(store, doc.id, 0, ["entries", "0", "content"], "unsaved")
    store.clear_drafts(doc.id)
    assert store.drafts(doc.id, 0) == {}


def test_a_draft_put_racing_a_mint_does_not_tear_the_file(root, monkeypatch):
    """`put_draft` and the carry inside `add_revision` are both read-modify-writes of one file."""
    doc = a_doc(DocumentStore(root))
    DocumentStore(root).put_draft(doc.id, 0, ["entries", "0", "content"], "first")

    _barrier, wait = _rendezvous(None)
    real = DocumentStore._read_draft

    def slow_read(self, doc_id):
        out = real(self, doc_id)
        wait()
        return out

    monkeypatch.setattr(DocumentStore, "_read_draft", slow_read)
    _run(lambda: DocumentStore(root).add_revision(doc.id, copy.deepcopy(BOOK), note="one"),
         lambda: DocumentStore(root).put_draft(doc.id, 0, ["entries", "0", "comment"], "second"))

    monkeypatch.undo()
    # Either order is CORRECT — what must never happen is a torn file or a lost document.
    raw = json.loads(vault_fs.read_text(DocumentStore(root)._draft(doc.id)))
    assert isinstance(raw.get("fields"), dict) and raw["fields"]


# ─────────────────────────────────────── the guard against a second door ───────────────────

def test_add_revision_is_the_only_thing_that_writes_a_revision_file():
    """Checks that add revision is the only thing that writes a revision file."""
    import ast
    src = (REPO_ROOT / "src" / "wbedit" / "store" / "documents.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    writers = set()
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in ast.walk(fn):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            target = getattr(node.func, "attr", "")
            if target not in ("write_json_atomic", "write_text", "write_bytes"):
                continue
            first = node.args[0]
            if isinstance(first, ast.Call) and getattr(first.func, "attr", "") == "_rev":
                writers.add(fn.name)
    assert writers == {"create", "add_revision"}, (
        f"a new writer of revision files appeared: {sorted(writers)}. Every mint must go through "
        f"add_revision, or it skips the lock and orphans the pending draft.")




def _locks_taken_in_source(src: str) -> set:
    """Checks that locks taken in source."""
    taken = set()
    for node in ast.walk(ast.parse(textwrap.dedent(src))):
        items = []
        if isinstance(node, ast.With):
            items = node.items
        elif isinstance(node, ast.AsyncWith):
            items = node.items
        for item in items:
            call = item.context_expr
            if not isinstance(call, ast.Call):
                continue
            fn = call.func
            if (isinstance(fn, ast.Attribute) and fn.attr == "_lock"
                    and isinstance(fn.value, ast.Name) and fn.value.id == "self"):
                taken.add("_lock")
            elif isinstance(fn, ast.Name) and fn.id == "store_lock" and len(call.args) >= 2:
                sentinel = call.args[1]
                if isinstance(sentinel, ast.Name):
                    taken.add("store_lock:" + sentinel.id)
    return taken


def _locks_taken(cls, method: str) -> set:
    return _locks_taken_in_source(inspect.getsource(getattr(cls, method)))


def test_the_lock_audit_cannot_be_satisfied_by_a_comment():
    """Checks that the lock audit cannot be satisfied by a comment."""
    prose_only = '''
def mutate(self):
    # This one is safe because of `with self._lock(doc_id):` further up the call chain.
    "And store_lock(self.root, DISMISSED_LOCK) is taken by our caller."
    self._write_meta(doc)
'''
    assert _locks_taken_in_source(prose_only) == set(), (
        "the audit is reading comments and docstrings again - that is how a real missing lock "
        "hid behind the paragraph explaining why the lock had to stay")

    mentioned_but_not_held = '''
def mutate(self):
    guard = self._lock(doc_id)
    self._write_meta(doc)
'''
    assert _locks_taken_in_source(mentioned_but_not_held) == set(), (
        "a lock that is constructed and never entered is not a lock")

    held = '''
def mutate(self):
    with self._lock(doc_id):
        with store_lock(self.root, DISMISSED_LOCK):
            self._write_meta(doc)
'''
    assert _locks_taken_in_source(held) == {"_lock", "store_lock:DISMISSED_LOCK"}, (
        "the reader no longer recognizes a lock that IS held - it would pass nothing")


@pytest.mark.parametrize("method", [
    "create", "import_from_st", "import_from_file", "_revise_existing",
    "link_orphan_cards", "_release_cards", "set_focus", "put_avatar",
    "clear_avatar_dirty", "rename", "delete", "add_revision", "rollback", "materialize",
    "apply_edits", "append_log", "put_asset", "thumbnail", "drop_thumbnails", "put_draft",
    "clear_drafts", "_carry_drafts",
])
def test_every_document_store_mutation_takes_the_lock(method):
    """Checks that every document store mutation takes the lock."""
    assert "_lock" in _locks_taken(DocumentStore, method), (
        f"DocumentStore.{method} mutates without taking the lock")


@pytest.mark.parametrize("method", ["start", "record", "finish", "delete", "review", "review_all"])
def test_every_pass_store_mutation_takes_the_lock(method):
    """Checks that every pass store mutation takes the lock."""
    assert "_lock" in _locks_taken(PassStore, method), (
        f"PassStore.{method} mutates without taking the lock")


@pytest.mark.parametrize("method", ["add", "update", "delete", "record_run"])
def test_every_instruction_library_mutation_takes_the_lock(method):
    assert "_lock" in _locks_taken(InstructionLibrary, method), (
        f"InstructionLibrary.{method} mutates without taking the lock")


@pytest.mark.parametrize("method", ["dismiss", "restore"])
def test_the_dismissed_list_takes_the_root_level_lock(method):
    assert "store_lock:DISMISSED_LOCK" in _locks_taken(DocumentStore, method), (
        f"DocumentStore.{method} rewrites dismissed.json without the root-level lock")


# ─────────────────────────────────────── the lock itself ───────────────────────────────────

def test_two_stores_on_one_root_share_one_lock(tmp_path):
    """Checks that two stores on one root share one lock."""
    a, b = DocumentStore(tmp_path / "w"), PassStore(tmp_path / "w")
    held = threading.Event()
    blocked = threading.Event()

    def hold():
        with a._lock("abcdef0123456789"):
            held.set()
            assert not blocked.wait(timeout=0.3), "the second store walked straight through"

    def contend():
        held.wait(timeout=5)
        with b._lock("abcdef0123456789"):
            blocked.set()

    _run(hold, contend)
    assert blocked.is_set()


def test_the_lock_registry_does_not_grow_without_bound(tmp_path):
    """Checks that the lock registry does not grow without bound."""
    from wbedit.store.models import _LOCKS
    before = len(_LOCKS)
    store = DocumentStore(tmp_path / "w")
    for i in range(50):
        with store._lock(f"{i:016x}"):
            pass
    assert len(_LOCKS) == before, f"the registry leaked {len(_LOCKS) - before} entries"


def test_a_base_exception_releases_the_lock_and_is_not_swallowed(tmp_path):
    """Checks that a base exception releases the lock and is not swallowed."""
    from wbedit.store.models import _LOCKS, store_lock

    class Boom(BaseException):
        pass

    before = len(_LOCKS)
    with pytest.raises(Boom):
        with store_lock(tmp_path / "w", "abcdef0123456789"):
            raise Boom("a wrong key, mid-write")
    assert len(_LOCKS) == before, "the lock leaked after a BaseException"

    # 🔴 And it is genuinely RELEASED, not merely dropped from the registry — checked from
    # ANOTHER thread, because an `RLock` the main thread still held would let the main thread
    # straight back in and the test would pass while the store was wedged for every request.
    def take_it_again():
        with store_lock(tmp_path / "w", "abcdef0123456789"):
            pass

    _run(take_it_again)


def test_the_registry_refuses_a_key_that_is_not_an_id(tmp_path):
    """The registry is a dict keyed on a string that came off a URL. `is_id` gates it structurally
    rather than each of the two stores remembering to."""
    from wbedit.store.models import store_lock
    with pytest.raises(ValueError):
        with store_lock(tmp_path / "w", "../../evil"):
            pass
    with pytest.raises(MissingDocument):
        with DocumentStore(tmp_path / "w")._lock("..\\..\\evil"):
            pass


def test_nested_store_calls_do_not_self_deadlock(store):
    """Checks that nested store calls do not self deadlock."""
    doc = a_doc(store, kind="card", name="Test Character 2")
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    _run(lambda: store.put_avatar(doc.id, png))
    assert store.get(doc.id).avatar_dirty is True


def test_deleting_a_book_while_its_card_is_being_renamed_deadlocks_nothing(root):
    """Checks that deleting a book while its card is being renamed deadlocks nothing."""
    docs = DocumentStore(root)
    book = docs.create(copy.deepcopy(BOOK), name="Sample World Book 2", kind="worldbook")
    card = docs.create({"data": {"name": "Test Character 9"}}, name="Test Character 9", kind="card",
                       world_ref="Sample World Book 2")
    assert docs.get(card.id).world_id == book.id

    _run(lambda: DocumentStore(root).delete(book.id),
         lambda: DocumentStore(root).rename(card.id, "Test Character 14"))
    after = DocumentStore(root).get(card.id)
    assert after.name == "Test Character 14"
    assert after.world_ref == "Sample World Book 2", "world_ref must survive the book's deletion"
