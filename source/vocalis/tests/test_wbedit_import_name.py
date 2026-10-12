"""Tests consistent document naming across import paths."""
from __future__ import annotations

import io
import json
import re
import struct
import zlib

import pytest

# NOTE: no `from conftest import REPO_ROOT` here. Every older file in this directory
# carries one for its `sys.path` side effect, with a `# noqa: F401` to silence the unused
# import — but `tests/conftest.py:12` does that insert at MODULE level and pytest imports
# conftest before any test module beside it. The line is redundant and the suppression it
# needs is not free: `test_no_lint_ignore_code_has_grown` ratchets `# noqa` counts, and two
# new files would have pushed F401 past its ceiling. Raising a ceiling to fit new code is
# the thing that ratchet exists to refuse.

# ⚠️ `REPO_ROOT` IS IMPORTED AND USED here, unlike the older files' unused-for-its-side-effect
# version the note above argues against: the tooltip test below reads a partial off disk.
from conftest import REPO_ROOT

import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.formats import png_card
from wbedit.store import AVATAR, AmbiguousName, DocumentStore

BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False, "position": 0,
              "content": "Test Character 1 keeps the ledger of every debt in the lower wards."},
    },
}


def _revised(entries_content):
    doc = json.loads(json.dumps(BOOK))
    doc["entries"]["0"]["content"] = entries_content
    return doc


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _upload(c, doc, filename="Sample World Book 1.json"):
    """The real door — a multipart upload, the way the browser sends it."""
    data = {"file": (io.BytesIO(json.dumps(doc).encode("utf-8")), filename)}
    return c.post("/wbedit/documents", data=data, content_type="multipart/form-data")


def _rows(c):
    return c.get("/wbedit/documents").get_json()["documents"]


# ── the ask ──────────────────────────────────────────────────────────────────

def test_a_second_import_of_the_same_name_is_a_revision_not_a_second_row(client):
    first = _upload(client, BOOK)
    assert first.status_code == 201 and first.get_json()["created"] is True

    second = _upload(client, _revised("Test Character 1 has retired to the coast."))
    assert second.status_code == 200, second.get_json()
    j = second.get_json()
    assert j["created"] is False and j["changed"] is True and j["revision"] == 1
    assert j["id"] == first.get_json()["id"], "it landed on a different document"

    rows = _rows(client)
    assert len(rows) == 1 and rows[0]["latest"] == 1


def test_the_version_he_had_is_still_reachable(client):
    """Checks that documents from an older schema version remain reachable."""
    doc_id = _upload(client, BOOK).get_json()["id"]
    _upload(client, _revised("Something else entirely."))
    old = client.get("/wbedit/documents/%s/revision/0" % doc_id).get_json()["content"]
    assert old["entries"]["0"]["content"].startswith("Test Character 1 keeps the ledger")


def test_an_identical_re_import_mints_nothing(client):
    """A history full of no-ops is a history nobody reads — the rule `_revise_existing` inherited
    from the ST sweep, which may be run repeatedly."""
    doc_id = _upload(client, BOOK).get_json()["id"]
    r = _upload(client, BOOK)
    assert r.status_code == 200 and r.get_json()["changed"] is False
    assert client.get("/wbedit/documents/%s" % doc_id).get_json()["latest"] == 0


@pytest.mark.parametrize("name", ["sample world book 1", "  Sample World Book 1  ", "SAMPLE WORLD BOOK 1"])
def test_the_match_folds_case_and_trims(client, name):
    """Checks that the match folds case and trims."""
    _upload(client, BOOK)
    doc = json.loads(json.dumps(BOOK))
    doc["name"] = name
    assert _upload(client, doc, name + ".json").get_json()["created"] is False
    assert len(_rows(client)) == 1


def test_a_card_and_a_book_may_share_a_name(client):
    """A card's key is an avatar filename and a book's is a book name; nothing stops those
    colliding, and they are not the same document."""
    _upload(client, BOOK)
    card = {"spec": "chara_card_v2", "spec_version": "2.0",
            "data": {"name": "Sample World Book 1", "description": "d", "personality": "p",
                     "scenario": "s", "first_mes": "f", "mes_example": "m"}}
    r = _upload(client, card, "Sample World Book 1.json")
    assert r.status_code == 201 and r.get_json()["created"] is True
    assert len(_rows(client)) == 2


def test_two_cards_with_one_name_still_make_two_documents(client):
    """Checks that two cards with one name still make two documents."""
    card = {"spec": "chara_card_v2", "spec_version": "2.0",
            "data": {"name": "Test Character 11", "description": "Keeps the ledger.", "personality": "p",
                     "scenario": "s", "first_mes": "f", "mes_example": "m"}}
    a = _upload(client, card, "Test Character 11.json")
    b = _upload(client, card, "Test Character 11.json")
    assert a.status_code == 201 and b.status_code == 201
    assert a.get_json()["id"] != b.get_json()["id"]
    assert len(_rows(client)) == 2


def test_a_differently_named_file_still_makes_a_new_document(client):
    _upload(client, BOOK)
    other = json.loads(json.dumps(BOOK))
    other["name"] = "Sample World Book 8"
    assert _upload(client, other, "Sample World Book 8.json").status_code == 201
    assert len(_rows(client)) == 2


def test_a_file_import_lands_on_a_book_that_came_from_sillytavern(client, tmp_path):
    """Checks that a file import lands on a book that came from sillytavern."""
    store = DocumentStore(paths.WBEDIT_DIR)
    swept, created = store.import_from_st(BOOK, kind="worldbook", st_ref="Sample World Book 1.json",
                                          name="Sample World Book 1")
    assert created
    r = _upload(client, _revised("Rewritten in an external editor."))
    assert r.status_code == 200 and r.get_json()["id"] == swept.id
    assert len(_rows(client)) == 1


# ── the state it refuses to guess at ─────────────────────────────────────────

def test_two_rows_already_sharing_a_name_are_refused_rather_than_guessed_at(client):
    """Checks that two rows already sharing a name are refused rather than guessed at."""
    store = DocumentStore(paths.WBEDIT_DIR)
    store.create(BOOK, name="Sample World Book 1", kind="worldbook")
    store.create(BOOK, name="Sample World Book 1", kind="worldbook")
    r = _upload(client, _revised("A third copy."))
    assert r.status_code == 409
    assert "2 documents" in r.get_json()["error"]
    assert len(_rows(client)) == 2, "a third row was filed anyway"


def test_a_blank_name_matches_nothing_rather_than_everything(tmp_path):
    """The document whose name did not survive detection must not adopt the first blank-named row
    it finds — and must not become the row every later blank-named import lands on."""
    store = DocumentStore(tmp_path / "wbedit")
    store.create(BOOK, name="", kind="worldbook")
    assert store.find_by_name("worldbook", "   ") == []
    assert store.find_by_name("worldbook", "") == []


def test_the_exception_names_the_count_and_the_name():
    exc = AmbiguousName("worldbook", "Sample World Book 1", 3)
    assert "3 documents" in str(exc) and "Sample World Book 1" in str(exc)


# ── Import-name edge cases ───────────────────────────────────────────────────

def test_two_names_that_differ_only_by_unicode_composition_are_one_book(tmp_path, monkeypatch):
    """Checks that two names that differ only by unicode composition are one book."""
    import unicodedata

    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    store = DocumentStore(paths.WBEDIT_DIR)
    nfc = unicodedata.normalize("NFC", "Café Sample World Book 1")
    nfd = unicodedata.normalize("NFD", "Café Sample World Book 1")
    assert nfc != nfd and len(nfc) != len(nfd), "the fixture is not actually testing composition"

    made, created, _ = store.import_from_file(BOOK, kind="worldbook", name=nfc)
    assert created is True
    again, created_again, changed = store.import_from_file(
        _revised("rewritten"), kind="worldbook", name=nfd)
    assert created_again is False and changed is True
    assert again.id == made.id, "the decomposed spelling filed a second, invisible row"
    assert len(store.list_documents()) == 1


def test_two_imports_of_one_new_name_at_once_still_make_one_row(tmp_path, monkeypatch):
    """Checks that two imports of one new name at once still make one row."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    store = DocumentStore(paths.WBEDIT_DIR)
    start = threading.Barrier(2)

    def go(text):
        start.wait(timeout=10)
        return store.import_from_file(_revised(text), kind="worldbook", name="Sample World Book 1")

    # ⚠️ `future.result()` RE-RAISES in this thread with the worker's own traceback attached, which
    # is why there is no `except Exception` here collecting failures by hand. A blind except is the
    # one suppression this tree prices separately (`BLE001`), and it buys nothing a future does not
    # already give. `timeout=20` is also the deadlock detector: `IMPORT_LOCK` is taken ABOVE the
    # document lock, and a future writer that reverses that order hangs here rather than passing.
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(go, "one"), pool.submit(go, "two")]
        for f in futures:
            f.result(timeout=20)

    rows = store.list_documents()
    assert len(rows) == 1, f"two concurrent imports of one new name filed {len(rows)} rows"
    # and the door is not wedged afterward, which is the half that made it permanent
    again = store.import_from_file(_revised("three"), kind="worldbook", name="Sample World Book 1")
    assert again[1] is False and again[2] is True


def test_an_unchanged_re_import_reports_the_revision_the_store_is_actually_at(client):
    """Checks that an unchanged re import reports the revision the store is actually at."""
    first = _upload(client, BOOK)
    assert first.status_code == 201
    doc_id = first.get_json()["id"]
    # move the head on with an ordinary edit, the way a second tab would
    assert client.post(f"/wbedit/documents/{doc_id}/entry?revision=0",
                       json={"comment": "later"}).status_code == 201
    head = client.get(f"/wbedit/documents/{doc_id}/revision/1").get_json()["content"]

    same = _upload(client, head)
    assert same.status_code == 200, same.get_json()
    body = same.get_json()
    assert body["changed"] is False and body["created"] is False
    live = client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"]
    assert body["revision"] == live == 1, "the response named a revision the store had left behind"
    assert body["latest"] == live


def test_the_unchanged_path_answers_from_the_store_and_not_from_the_snapshot(tmp_path,
                                                                            monkeypatch):
    """Checks that the unchanged path answers from the store and not from the snapshot."""
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    store = DocumentStore(paths.WBEDIT_DIR)
    made, created, _ = store.import_from_file(BOOK, kind="worldbook", name="Sample World Book 1")
    assert created is True and made.latest == 0

    real_find = DocumentStore.find_by_name
    fired = []

    def racing(self, kind, name):
        matches = real_find(self, kind, name)
        if matches and not fired:
            fired.append(True)
            self.add_revision(matches[0].id, BOOK, note="another tab, in the window")
        return matches

    monkeypatch.setattr(DocumentStore, "find_by_name", racing)
    doc, created_again, changed = store.import_from_file(BOOK, kind="worldbook", name="Sample World Book 1")
    assert fired, "the race never fired — this test is not testing anything"
    assert created_again is False and changed is False, "the content really is unchanged"
    assert doc.latest == 1, "the unchanged path answered with the pre-lock snapshot"
    assert store.get(doc.id).latest == 1


def _bare_png():
    """A minimal but structurally real PNG — the shape `test_wbedit_assemble._png` uses."""
    def chunk(ctype: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + ctype + data
                + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (png_card.PNG_SIGNATURE + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b""))


def _lorebook_png(doc):
    """Checks that lorebook png."""
    return png_card.write_card(_bare_png(), doc)


def test_a_re_import_never_overwrites_the_face_of_a_document_it_did_not_create(client):
    """Checks that a re import never overwrites the face of a document it did not create."""
    made = _upload(client, BOOK)
    assert made.status_code == 201
    doc_id = made.get_json()["id"]
    store = DocumentStore(paths.WBEDIT_DIR)
    store.put_asset(doc_id, AVATAR, b"the original face")

    again = client.post("/wbedit/documents",
                        data={"file": (io.BytesIO(_lorebook_png(_revised("rewritten"))),
                                       "Sample World Book 1.png")},
                        content_type="multipart/form-data")
    assert again.status_code == 200, again.get_json()
    assert again.get_json()["id"] == doc_id, "the fixture did not exercise the merge path"
    assert again.get_json()["changed"] is True, "and it did land as a new revision"
    assert store.asset(doc_id, AVATAR) == b"the original face", \
        "a merging import overwrote a face it had no revision to restore"


def test_the_cards_pane_never_promises_a_merge_the_store_refuses_to_do(tmp_path, monkeypatch):
    """Checks that the cards pane never promises a merge the store refuses to do."""
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    store = DocumentStore(paths.WBEDIT_DIR)
    card = {"spec": "chara_card_v2", "data": {"name": "Test Character 11", "description": "one"}}
    first, created_first, _ = store.import_from_file(card, kind="card", name="Test Character 11")
    second, created_second, _ = store.import_from_file(
        {"spec": "chara_card_v2", "data": {"name": "Test Character 11", "description": "two"}},
        kind="card", name="Test Character 11")
    assert created_first and created_second and first.id != second.id, (
        "the behavior changed — a card now merges by name, and the tooltip check below is "
        "asserting the wrong thing")

    panel = (REPO_ROOT / "src" / "webui" / "partials" / "panel-sillytavern.html").read_text(
        encoding="utf-8")
    cards_controls = re.findall(r'<button[^>]*id="\w+_cards"[^>]*>', panel)
    assert cards_controls, "no cards-pane buttons found — the id convention moved"
    # ⚠️ NARROW ON PURPOSE. "as a new revision" alone hits ⬆ Save's tooltip, which says a true
    # thing about hand edits. What is forbidden is the claim about a FILE landing on a row.
    claim = r"lands on it as a new revision|rather than making a second row|matches a card already"
    liars = [c for c in cards_controls if re.search(claim, c)]
    assert not liars, (
        "a control on the CARDS pane promises the merge-by-name behavior that "
        "`import_from_file` gives worldbooks only:\n  " + "\n  ".join(liars))

    # ⚠️ And the arm that keeps it honest: the BOOKS pane does say it, because there it is true.
    books_controls = re.findall(r'<button[^>]*id="\w+_books"[^>]*>', panel)
    assert any(re.search(r"lands on it as a new revision", c) for c in books_controls), (
        "nothing on the books pane explains the merge any more — either the wording moved or "
        "this test has stopped watching anything")
