"""Tests pending edits and their lifecycle across document revisions."""
from __future__ import annotations

import copy
import json

import pytest

from conftest import REPO_ROOT  # sys.path side effect, and the NUL tripwire at the foot of this
                                # file reads a source file through it

import vault_fs
import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.store import DocumentStore, MissingDocument
from wbedit.store.documents import DRAFT

BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False,
              "content": "Test Character 1 keeps the ledger of every debt in the lower wards."},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "order": 100, "disable": False,
              "content": "The rains come off the estuary in the ninth month."},
    },
}

#: The locator the browser sends for a compiled lorebook's third entry, and the key it looks that
#: entry up by. `JSON.stringify(["entries","3","content"])` — no spaces, ever.
LOCATOR = ["entries", "3", "content"]
BROWSER_KEY = '["entries","3","content"]'


@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


def a_doc(store, content=None, **kw):
    kw.setdefault("name", "Sample World Book 1")
    kw.setdefault("kind", "worldbook")
    return store.create(copy.deepcopy(content or BOOK), **kw)


# ───────────────────────────────────────────────────────── the store

def test_a_draft_round_trips_for_the_revision_it_was_typed_against(store):
    """The plain case, and the shape everything else is a variation on: one field's unsaved text,
    put and read back for the revision that was on screen when it was typed."""
    doc = a_doc(store)
    pending = store.put_draft(doc.id, 0, LOCATOR, "Renamed Character 1 keeps the ledger.")

    assert pending == 1, "the count of pending fields is what the pane would show"
    assert store.drafts(doc.id, 0) == {BROWSER_KEY: "Renamed Character 1 keeps the ledger."}

    assert store.put_draft(doc.id, 0, ["entries", "0", "content"], "Also edited.") == 2
    assert store.drafts(doc.id, 0)[BROWSER_KEY] == "Renamed Character 1 keeps the ledger."


def test_the_draft_key_is_byte_identical_to_what_the_browser_stringifies(store):
    """Checks that the draft key is byte identical to what the browser stringifies."""
    doc = a_doc(store)
    store.put_draft(doc.id, 0, LOCATOR, "typed but not saved")

    assert list(store.drafts(doc.id, 0)) == [BROWSER_KEY], (
        "the draft key is not what JSON.stringify produces — every draft will be stored and "
        "none will ever be restored")
    assert json.dumps(LOCATOR) not in store.drafts(doc.id, 0), (
        "Python's spaced-out default form leaked into the key")

    # ...and on disk, because that is what a restarted server reads back. 📌 The key is a JSON
    # string that itself contains JSON, so in the file the inner quotes are escaped — the literal
    # to look for is `"[\"entries\",\"3\",\"content\"]"`, which is what `json.dumps` of the key
    # spells out. Still a byte-level check: the spaced-out form would not be in there.
    raw = vault_fs.read_text(store._draft(doc.id))
    assert json.dumps(BROWSER_KEY) in raw, f"the stored key is not the browser's: {raw}"
    assert json.dumps(json.dumps(LOCATOR)) not in raw
    assert list(json.loads(raw)["fields"]) == [BROWSER_KEY]

    # An int index survives as an int, exactly as `JSON.stringify` would render it.
    store.put_draft(doc.id, 0, ["data", "character_book", "entries", 0, "content"], "x")
    assert '["data","character_book","entries",0,"content"]' in store.drafts(doc.id, 0), (
        "an int locator element was stringified and no longer matches the browser's key")


def test_a_draft_is_not_offered_against_a_revision_it_was_not_typed_over(store):
    """Checks that a draft is not offered against a revision it was not typed over."""
    doc = a_doc(store)
    store.put_draft(doc.id, 0, LOCATOR, "typed against revision 0")

    assert store.drafts(doc.id, 1) == {}, "a draft was offered for a revision it never saw"
    assert store.drafts(doc.id, 7) == {}
    assert store.drafts(doc.id, 0), "the revision it WAS typed against still has it"

    # Writing against the newer revision replaces the stale scratchpad rather than merging into
    # it — the old entries describe bytes nobody is looking at any more.
    store.put_draft(doc.id, 1, ["entries", "0", "content"], "typed against revision 1")
    assert store.drafts(doc.id, 0) == {}, "the stale draft outlived the revision it belonged to"
    assert list(store.drafts(doc.id, 1)) == ['["entries","0","content"]']


def test_clearing_the_last_field_removes_the_file_rather_than_leaving_a_husk(store):
    """Checks that clearing the last field removes the file rather than leaving a husk."""
    doc = a_doc(store)
    store.put_draft(doc.id, 0, LOCATOR, "one")
    store.put_draft(doc.id, 0, ["entries", "0", "content"], "two")

    assert store.put_draft(doc.id, 0, LOCATOR, None) == 1, "removing one field took the other"
    assert list(store.drafts(doc.id, 0)) == ['["entries","0","content"]']
    assert vault_fs.exists(store._draft(doc.id)), "the surviving field lost its file"

    assert store.put_draft(doc.id, 0, ["entries", "0", "content"], None) == 0
    assert store.drafts(doc.id, 0) == {}
    assert not vault_fs.exists(store._draft(doc.id)), (
        "the last field went but an empty draft.json was left behind")
    # 📌 Named through the store's own constant, so a rename of the file cannot leave this test
    # passing against a path that no longer exists.
    assert store._draft(doc.id).name == DRAFT


def test_clearing_drafts_is_idempotent_and_safe_when_there_is_nothing_to_clear(store):
    """Checks that clearing drafts is idempotent and safe when there is nothing to clear."""
    doc = a_doc(store)
    store.clear_drafts(doc.id)                     # nothing has ever been written
    store.clear_drafts(doc.id)

    store.put_draft(doc.id, 0, LOCATOR, "one")
    store.clear_drafts(doc.id)
    store.clear_drafts(doc.id)
    assert store.drafts(doc.id, 0) == {}
    assert not vault_fs.exists(store._draft(doc.id))

    # And a document that was never created at all — the tab that saves after a delete elsewhere.
    store.clear_drafts("no-such-document")


def test_a_corrupt_scratchpad_reads_as_nothing_pending_rather_than_failing_the_open(store):
    """Checks that a corrupt scratchpad reads as nothing pending rather than failing the open."""
    doc = a_doc(store)
    store.put_draft(doc.id, 0, LOCATOR, "one")

    vault_fs.write_text(store._draft(doc.id), '{"revision": 0, "fields": {"a"')
    assert store.drafts(doc.id, 0) == {}, "a torn scratchpad raised instead of reading as empty"

    # Valid JSON of the wrong SHAPE is the same case — a list, or a dict with no `fields`.
    for junk in ("[]", '"nope"', '{"revision": 0}', "null"):
        vault_fs.write_text(store._draft(doc.id), junk)
        assert store.drafts(doc.id, 0) == {}, f"{junk} was not treated as nothing pending"

    assert store.put_draft(doc.id, 0, LOCATOR, "typed again") == 1
    assert store.drafts(doc.id, 0) == {BROWSER_KEY: "typed again"}


def test_a_draft_is_never_written_into_a_document_that_does_not_exist(store):
    """Checks that a draft is never written into a document that does not exist."""
    ghost = "no-such-document"
    with pytest.raises(MissingDocument):
        store.put_draft(ghost, 0, LOCATOR, "prose from a tab that is out of date")

    assert not vault_fs.exists(store._dir(ghost)), (
        "a draft resurrected a deleted document's directory — the text he deleted is back on "
        "disk, invisible to the Library and removable by nothing")
    assert store.list_documents() == []


def test_a_draft_survives_the_store_object_being_thrown_away(store):
    """Checks that a draft survives the store object being thrown away."""
    doc = a_doc(store)
    store.put_draft(doc.id, 0, LOCATOR, "half a paragraph he has not saved")

    restarted = DocumentStore(store.root)
    assert restarted.drafts(doc.id, 0) == {BROWSER_KEY: "half a paragraph he has not saved"}


def test_a_draft_never_reaches_the_document_or_its_history(store):
    """Checks that a draft never reaches the document or its history."""
    doc = a_doc(store)
    before = json.dumps(store.revision(doc.id, 0).content)

    store.put_draft(doc.id, 0, ["entries", "0", "content"], "NOT SAVED — must not appear anywhere")
    store.put_draft(doc.id, 0, ["entries", "1", "content"], "also not saved")

    assert json.dumps(store.revision(doc.id, 0).content) == before, (
        "a draft mutated the revision it was typed over — I8 says revision 0 is the bytes as "
        "imported, forever")
    assert store.revisions(doc.id) == [0], "a draft minted a revision"
    assert store.get(doc.id).latest == 0, "a draft moved the document's latest revision"
    assert "NOT SAVED" not in json.dumps(store.revision(doc.id, 0).content)


# ───────────────────────────────────────────────────────── the routes

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _import(c, doc=None, name="Sample World Book 1"):
    r = c.post("/wbedit/documents", json={"document": doc or BOOK, "name": name})
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def test_a_draft_put_over_http_comes_back_from_the_get(client):
    """The round trip the browser actually makes: blur puts, open gets."""
    doc = _import(client)
    r = client.put(f"/wbedit/documents/{doc['id']}/draft",
                   json={"revision": 0, "locator": LOCATOR, "text": "unsaved"})
    assert r.status_code == 200, r.get_json()
    assert r.get_json() == {"pending": 1, "revision": 0}

    body = client.get(f"/wbedit/documents/{doc['id']}/draft/0").get_json()
    # 7.3.9e — `total` counts what is ON DISK whatever revision it is stamped at, so here it
    # agrees with `len(fields)`. The case where it does not is the one it exists for: a draft
    # stranded against an older revision, which `drafts()` refuses to serve and which the UI
    # could otherwise neither see nor clear.
    assert body == {"revision": 0, "fields": {BROWSER_KEY: "unsaved"}, "total": 1}
    assert client.get(f"/wbedit/documents/{doc['id']}/draft/1").get_json()["fields"] == {}, \
        "the revision key has to survive the HTTP layer as well as the store"

    # `text: null` is the removal the browser sends when a box goes back to how it started.
    assert client.put(f"/wbedit/documents/{doc['id']}/draft",
                      json={"revision": 0, "locator": LOCATOR,
                            "text": None}).get_json()["pending"] == 0
    assert client.get(f"/wbedit/documents/{doc['id']}/draft/0").get_json()["fields"] == {}


def test_a_malformed_draft_put_is_refused_rather_than_stored_under_a_key_nobody_reads(client):
    """Checks that a malformed draft put is refused rather than stored under a key nobody reads."""
    doc = _import(client)
    url = f"/wbedit/documents/{doc['id']}/draft"

    for body in ({"revision": 0, "text": "x"},                       # no locator at all
                 {"revision": 0, "locator": "entries", "text": "x"},  # a string, not a list
                 {"revision": 0, "locator": [], "text": "x"},         # empty — addresses nothing
                 {"locator": LOCATOR, "text": "x"},                   # no revision
                 {"revision": None, "locator": LOCATOR, "text": "x"},
                 {"revision": "later", "locator": LOCATOR, "text": "x"},
                 {"revision": 0, "locator": LOCATOR, "text": 5},      # not a string, not null
                 {"revision": 0, "locator": LOCATOR, "text": ["x"]},
                 {}):
        r = client.put(url, json=body)
        assert r.status_code == 400, f"{body!r} was accepted: {r.status_code} {r.get_json()}"
        assert "error" in r.get_json()

    assert client.get(f"/wbedit/documents/{doc['id']}/draft/0").get_json()["fields"] == {}, \
        "a refused put stored something anyway"


def test_deleting_the_draft_clears_the_pending_state(client):
    """The pane's "discard" — and the belt to the braces on a save, since a client that clears
    explicitly must not need the server to have done it first."""
    doc = _import(client)
    client.put(f"/wbedit/documents/{doc['id']}/draft",
               json={"revision": 0, "locator": LOCATOR, "text": "unsaved"})

    r = client.delete(f"/wbedit/documents/{doc['id']}/draft")
    assert r.status_code == 200 and r.get_json() == {"ok": True}
    assert client.get(f"/wbedit/documents/{doc['id']}/draft/0").get_json()["fields"] == {}
    # Idempotent over HTTP too — a second discard, or one on a document with nothing pending.
    assert client.delete(f"/wbedit/documents/{doc['id']}/draft").status_code == 200


def test_a_real_save_leaves_no_draft_behind(client):
    """Checks that a real save leaves no draft behind."""
    doc = _import(client)
    client.put(f"/wbedit/documents/{doc['id']}/draft",
               json={"revision": 0, "locator": ["entries", "0", "content"],
                     "text": "Renamed Character 1 keeps the ledger."})
    assert client.get(f"/wbedit/documents/{doc['id']}/draft/0").get_json()["fields"], \
        "precondition: there was something pending to survive the save"

    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={"edits": [
        {"locator": ["entries", "0", "content"], "text": "Renamed Character 1 keeps the ledger.",
         "label": "Sample Entry 1"}]})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["n"] == 1

    for n in (0, 1):
        assert client.get(f"/wbedit/documents/{doc['id']}/draft/{n}").get_json()["fields"] == {}, \
            f"a draft survived the save that made it real, and would replay over revision {n}"
    store = DocumentStore(paths.WBEDIT_DIR)
    assert not vault_fs.exists(store._draft(doc["id"])), "the scratchpad file outlived the save"


def test_putting_a_draft_on_a_missing_document_is_a_404_and_creates_nothing(client):
    """Checks that putting a draft on a missing document is a 404 and creates nothing."""
    _import(client)                            # a real document, so the tree exists to be dirtied
    ghost = "0000000000000000"
    r = client.put(f"/wbedit/documents/{ghost}/draft",
                   json={"revision": 0, "locator": LOCATOR, "text": "prose from a stale tab"})
    assert r.status_code == 404, r.get_json()

    store = DocumentStore(paths.WBEDIT_DIR)
    assert not vault_fs.exists(store._dir(ghost)), \
        "the refused PUT created the document directory anyway"
    assert [d.id for d in store.list_documents()] != [], "precondition: the real document is there"
    assert ghost not in {d.id for d in store.list_documents()}


def test_reading_or_clearing_a_draft_on_a_missing_document_answers_200_today(client):
    """Checks that reading or clearing a draft on a missing document answers 200 today."""
    _import(client)
    ghost = "0000000000000000"

    r = client.get(f"/wbedit/documents/{ghost}/draft/0")
    # 7.3.9e — `total` joins the shape. Zero here is the honest answer for a document that
    # does not exist, and asserting it keeps this route pinned in BOTH its fields.
    assert r.status_code == 200 and r.get_json() == {"revision": 0, "fields": {}, "total": 0}

    d = client.delete(f"/wbedit/documents/{ghost}/draft")
    assert d.status_code == 200 and d.get_json() == {"ok": True}

    store = DocumentStore(paths.WBEDIT_DIR)
    assert not vault_fs.exists(store._dir(ghost)), \
        "reading or clearing a draft created a directory for a document that does not exist"


def test_a_locked_vault_is_a_423_on_every_draft_route(client, monkeypatch):
    """Checks that a locked vault is a 423 on every draft route."""
    doc = _import(client)

    class Locked(Exception):
        pass

    monkeypatch.setattr(vault_fs, "locked_exc", lambda: Locked)
    monkeypatch.setattr(vault_fs, "exists", lambda *a, **k: (_ for _ in ()).throw(Locked()))

    calls = [
        client.put(f"/wbedit/documents/{doc['id']}/draft",
                   json={"revision": 0, "locator": LOCATOR, "text": "x"}),
        client.get(f"/wbedit/documents/{doc['id']}/draft/0"),
        client.delete(f"/wbedit/documents/{doc['id']}/draft"),
    ]
    for r in calls:
        assert r.status_code == 423, f"a locked vault answered {r.status_code}"
        assert r.get_json()["locked"] is True
        assert "fields" not in r.get_json(), "a locked vault reported an empty scratchpad"


# ───────────────────────────────────────────────────────── the NUL tripwire

def test_no_nul_byte_reaches_the_draft_file_or_the_web_ui(store):
    """Checks that no nul byte reaches the draft file or the web ui."""
    doc = a_doc(store)
    store.put_draft(doc.id, 0, LOCATOR, "unsaved prose — with an em dash and a ligature: ﬁ")
    blob = vault_fs.read_bytes(store._draft(doc.id))
    assert blob.count(b"\x00") == 0, "a NUL byte reached the draft file"
    blob.decode("utf-8")

    page = (REPO_ROOT / "src" / "webui" / "index.html").read_bytes()
    assert page.count(b"\x00") == 0, (
        "src/webui/index.html contains NUL bytes — grep will treat it as binary and refuse to "
        "search it, which is how this went unnoticed the first time")
    page.decode("utf-8")


# ── 7.3.9d/e: the roster marker, and the one state it can point at but not explain ───────────
#
# `draft_count` is what the Library row's orange "(N pending edits)" is built from, and it is
# deliberately NOT filtered by revision the way `drafts()` is. The two agree in every normal flow
# because `add_revision` carries a draft forward at a single funnel — so they can only disagree
# after a crash between that revision write and the carry, which leaves a draft stamped at a
# number `drafts()` will refuse to serve.
#
# 🔴 **AND THAT DISAGREEMENT IS WHY `GET /draft/<n>` CARRIES `total`.** Before it did, the editor
# restored nothing, `↺ Revert changes` read its own empty map and said "nothing to discard", and
# the orange count on the roster could never be cleared by anything in the UI. Making the state
# visible without making it clearable is worse than leaving it invisible, which is what it was.

def test_draft_count_sees_a_draft_stranded_against_an_older_revision(client):
    doc = _import(client)
    store = DocumentStore(paths.WBEDIT_DIR)
    client.put(f"/wbedit/documents/{doc['id']}/draft",
               json={"revision": 0, "locator": LOCATOR, "text": "unsaved"})

    # The crash case, by hand: a revision exists that the draft was never carried onto.
    store.add_revision(doc["id"], {"entries": {}}, note="a pass")
    vault_fs.write_json_atomic(store._draft(doc["id"]),
                               {"revision": 0, "fields": {BROWSER_KEY: "unsaved"}}, indent=2)

    assert store.drafts(doc["id"], 1) == {}, \
        "a draft typed against revision 0 must never be draped over revision 1"
    assert store.draft_count(doc["id"]) == 1, \
        "…but it is still on disk, and the roster marker is the only thing that can say so"

    body = client.get(f"/wbedit/documents/{doc['id']}/draft/1").get_json()
    assert body["fields"] == {} and body["total"] == 1, (
        "the GET has to report BOTH — the editor restores nothing, and Revert still needs to know "
        "there is something to delete")


def test_a_stranded_draft_can_still_be_thrown_away(client):
    """The other half: whatever put it there, DELETE must clear it, or the marker is permanent."""
    doc = _import(client)
    store = DocumentStore(paths.WBEDIT_DIR)
    vault_fs.write_json_atomic(store._draft(doc["id"]),
                               {"revision": 99, "fields": {BROWSER_KEY: "orphan"}}, indent=2)
    assert store.draft_count(doc["id"]) == 1

    assert client.delete(f"/wbedit/documents/{doc['id']}/draft").status_code == 200
    assert store.draft_count(doc["id"]) == 0


def test_draft_count_is_zero_without_reading_anything_when_nothing_is_pending(client):
    """Checks that draft count is zero without reading anything when nothing is pending."""
    doc = _import(client)
    store = DocumentStore(paths.WBEDIT_DIR)
    assert not vault_fs.exists(store._draft(doc["id"]))
    assert store.draft_count(doc["id"]) == 0
