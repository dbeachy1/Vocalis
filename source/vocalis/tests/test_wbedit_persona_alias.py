"""Tests persona alias resolution and identity matching."""
from __future__ import annotations

import io
import json

import pytest

import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.formats import persona, st_write
from wbedit.store.documents import DocumentStore
from wbedit.store.models import Document

#: A persona document wearing our marker and naming an avatar file — what `⬇ Export` produces,
#: and what another model produces when it has been shown the export format.
CLAIMS = {
    "spec": persona.SPEC,
    "avatar": "1699-Someone.png",
    "name": "Someone Completely Different",
    "description": "REPLACEMENT DESCRIPTION written by the imported file",
    "title": "REPLACEMENT TITLE",
}

#: The persona as SillyTavern pushed it in: the sweep requires an `st_ref`, so a persona that
#: really came from over there always has one recorded.
FROM_ST = {"spec": persona.SPEC, "avatar": "1699-Someone.png", "name": "ZZ Victim Persona",
           "description": "ORIGINAL DESCRIPTION — must survive", "title": "ORIGINAL TITLE"}


# ── the send: identity comes from the store, never from the file ─────────────

def test_a_file_that_names_an_avatar_cannot_make_the_send_a_merge():
    """Without a stored `st_ref`, send planning must create a new persona; an avatar in the imported file is not an identity."""
    plan = st_write.plan(Document(id="d1", name="Someone Completely Different", kind="persona",
                                  st_ref=""),
                         CLAIMS, st_ref="", name="Someone Completely Different")

    assert plan["create"] is True
    assert plan["target"] == ""
    assert plan["name"] == "Someone Completely Different"


def test_a_recorded_st_ref_is_still_a_merge():
    """Checks that a recorded st ref is still a merge."""
    plan = st_write.plan(Document(id="d1", name="ZZ Victim Persona", kind="persona",
                                  st_ref="1699-Someone.png"),
                         FROM_ST, st_ref="1699-Someone.png", name="ZZ Victim Persona")

    assert plan.get("create") is not True
    assert plan["target"] == "1699-Someone.png"
    assert plan["persona"]["description"] == "ORIGINAL DESCRIPTION — must survive"


# ── the store: what may be done with a claim ─────────────────────────────────

@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


def test_an_unowned_claim_is_stripped_from_the_stored_content(store):
    """Checks that an unowned claim is stripped from the stored content."""
    doc, created, _ = store.import_from_file(dict(CLAIMS), kind="persona",
                                             name="Someone Completely Different",
                                             st_ref=CLAIMS["avatar"])

    assert created is True
    assert doc.st_ref == "", "an unverifiable claim must never become a link"
    body = store.revision(doc.id, doc.latest).content
    assert "avatar" not in body
    # …and every other field of the round trip is untouched.
    assert body["description"] == CLAIMS["description"]
    assert body["title"] == CLAIMS["title"]


def test_a_claim_the_library_really_owns_lands_as_the_next_revision(store):
    """Checks that a claim the library really owns lands as the next revision."""
    owner = store.import_from_st(dict(FROM_ST), kind="persona", st_ref="1699-Someone.png",
                                 name="ZZ Victim Persona")[0]

    doc, created, changed = store.import_from_file(dict(CLAIMS), kind="persona",
                                                   name="Someone Completely Different",
                                                   st_ref=CLAIMS["avatar"])

    assert created is False and changed is True
    assert doc.id == owner.id, "it is that persona, so it is that document"
    assert doc.st_ref == "1699-Someone.png"
    # ⚠️ THE ROW IS NOT RENAMED — `import_from_st` preserves the Library row's name.
    assert doc.name == "ZZ Victim Persona"
    assert len(store.list_documents()) == 1, "a second row would be the alias again"
    # The pre-import revision is the undo.
    assert store.revision(doc.id, 0).content["description"] == FROM_ST["description"]


def test_two_imports_of_one_unowned_file_are_two_rows(store):
    """Checks that two imports of one unowned file are two rows."""
    for _ in range(2):
        store.import_from_file(dict(CLAIMS), kind="persona", name="Someone Completely Different",
                               st_ref=CLAIMS["avatar"])
    assert len(store.list_documents()) == 2


# ── the door: the two halves joined ──────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _upload(c, doc, filename="someone.json"):
    return c.post("/wbedit/personas/import",
                  data={"file": (io.BytesIO(json.dumps(doc).encode("utf-8")), filename)},
                  content_type="multipart/form-data")


def test_the_reported_bug_end_to_end(client):
    """Exercise the import-to-send path and verify it cannot target an existing persona through file metadata."""
    r = _upload(client, CLAIMS)
    assert r.status_code == 201, r.get_json()
    doc_id = r.get_json()["id"]

    row = [d for d in client.get("/wbedit/documents?kind=persona").get_json()["documents"]
           if d["id"] == doc_id][0]
    assert row["st_ref"] == ""

    store = DocumentStore(paths.WBEDIT_DIR)
    document = store.get(doc_id)
    plan = st_write.plan(document, store.revision(doc_id, document.latest).content,
                         st_ref=document.st_ref, name=document.name)

    assert plan["create"] is True, "a document nothing links must never merge onto a real persona"
    assert plan["target"] == ""


def test_an_import_that_lands_on_a_swept_persona_says_so(client):
    """Checks that an import that lands on a swept persona says so."""
    DocumentStore(paths.WBEDIT_DIR).import_from_st(
        dict(FROM_ST), kind="persona", st_ref="1699-Someone.png", name="ZZ Victim Persona")

    r = _upload(client, CLAIMS)
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["created"] is False and body["changed"] is True
    assert body["name"] == "ZZ Victim Persona"
    assert body["st_ref"] == "1699-Someone.png"


# ── the picture, which NO persona check had ever exercised ───────────────────

# Exercise the avatar-present path so the extension's `fetchAvatar` to `/api/avatars/upload`
# branch and `_persona_plan`'s `has_avatar` value are covered.
#
# Both `/pair/plan/<id>` and the press-time send plan must use the same avatar state.

def _png() -> bytes:
    """Checks that png."""
    import base64
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def test_a_persona_with_a_picture_plans_a_create_that_carries_it(client):
    """Checks that a persona with a picture plans a create that carries it."""
    from wbedit.store.documents import AVATAR

    r = _upload(client, {**CLAIMS, "avatar": None})
    doc_id = r.get_json()["id"]
    store = DocumentStore(paths.WBEDIT_DIR)
    store.put_asset(doc_id, AVATAR, _png())

    document = store.get(doc_id)
    content = store.revision(doc_id, document.latest).content
    plan = st_write.plan(document, content, st_ref=document.st_ref, name=document.name,
                         avatar=document.avatar_dirty and store.has_asset(doc_id, AVATAR),
                         has_avatar=store.has_asset(doc_id, AVATAR))

    assert plan["create"] is True
    assert plan["avatar"] is True, "the extension uploads the picture off this flag alone"


def test_the_press_time_plan_and_the_collected_plan_agree_about_the_picture(client):
    """Checks that the press time plan and the collected plan agree about the picture."""
    from wbedit.store.documents import AVATAR

    doc_id = _upload(client, {**CLAIMS, "avatar": None}).get_json()["id"]
    store = DocumentStore(paths.WBEDIT_DIR)
    store.put_asset(doc_id, AVATAR, _png())
    document = store.get(doc_id)
    content = store.revision(doc_id, document.latest).content

    def build(has_avatar):
        return st_write.plan(document, content, st_ref=document.st_ref, name=document.name,
                             avatar=document.avatar_dirty and store.has_asset(doc_id, AVATAR),
                             has_avatar=has_avatar)

    press = build(store.has_asset(doc_id, AVATAR))     # what wbedit_push_request now passes
    collect = build(store.has_asset(doc_id, AVATAR))   # what pair_plan has always passed
    assert press == collect
    assert press["avatar"] is True
    # And the shape they would have had before the fix, so the difference is on the record.
    assert build(False)["avatar"] is False


def test_a_persona_merge_carries_the_picture(client):
    """Checks that a persona merge carries the picture."""
    from wbedit.store.documents import AVATAR

    store = DocumentStore(paths.WBEDIT_DIR)
    owner = store.import_from_st(dict(FROM_ST), kind="persona", st_ref="1699-Someone.png",
                                 name="ZZ Victim Persona")[0]
    store.put_asset(owner.id, AVATAR, _png())
    content = store.revision(owner.id, owner.latest).content

    changed = st_write.plan(store.get(owner.id), content, st_ref=owner.st_ref, name=owner.name,
                            avatar=True, has_avatar=True)
    assert changed.get("create") is not True and changed["target"] == "1699-Someone.png"
    assert changed["avatar"] is True, "a replaced picture has to reach the persona it belongs to"

    unchanged = st_write.plan(store.get(owner.id), content, st_ref=owner.st_ref, name=owner.name,
                              avatar=False, has_avatar=True)
    assert unchanged["avatar"] is False, "and one nobody touched must not be re-uploaded every save"
