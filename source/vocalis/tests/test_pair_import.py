"""Tests document import behavior between Vocalis and the SillyTavern extension: stable identity across re-pushes, explicit kind handling, safe picture retries, and a minimal response payload."""
from __future__ import annotations

import copy

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import paths
from wbedit import pairing
from wbedit.store import DocumentStore

BOOK = {
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "constant": False, "disable": False, "order": 100,
              "comment": 'Test Entry 1', "content": 'Test Character 1 keeps the ledger.'},
    }
}

#: A pre-compile section chunk file: a bare LIST, which `formats.detect.doc_kind` reads as a
#: worldbook and `formats.worldbook.iter_entries` walks. See the display-name regression below.
CHUNK = [
    {"uid": 0, "keys": ["ledger"], "comment": 'Test Entry 1', "content": "He keeps the ledger."},
]

CARD = {
    "spec": "chara_card_v2", "spec_version": "2.0",
    "data": {"name": 'Test Character', "description": "A tall woman.", "personality": "Wry.",
             "scenario": "A tavern.", "first_mes": "You again.", "mes_example": "<START>",
             "extensions": {"world": 'Sample Book'}},
}


@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


def push(store, content, *, kind, st_ref, name=""):
    return store.import_from_st(copy.deepcopy(content), kind=kind, st_ref=st_ref,
                                name=name or st_ref,
                                world_ref=(content.get("data", {}).get("extensions", {})
                                           .get("world", "") if kind == "card" else ""))


# ───────────────────────────────────────────── the store: one ST document is one Library row

def test_a_first_push_files_a_document_marked_as_coming_from_sillytavern(store):
    doc, created = push(store, BOOK, kind="worldbook", st_ref='Sample Book')
    assert created is True
    assert doc.source == "st", "an ST push filed as an upload is indistinguishable from a file"
    assert doc.st_ref == 'Sample Book'
    assert doc.latest == 0
    assert len(store.list_documents()) == 1


def test_pushing_the_same_book_twice_makes_one_row_with_two_revisions(store):
    """🔴 THE POINT OF THE MILESTONE. A second press of the button is revision 1, not row 2."""
    first, created_a = push(store, BOOK, kind="worldbook", st_ref='Sample Book')

    changed = copy.deepcopy(BOOK)
    changed["entries"]["0"]["content"] = 'Test Character 1 burned the ledger.'
    second, created_b = push(store, changed, kind="worldbook", st_ref='Sample Book')

    assert created_a is True and created_b is False
    assert second.id == first.id, "a re-push filed a SECOND library row"
    assert len(store.list_documents()) == 1
    assert store.revisions(first.id) == [0, 1]
    assert second.latest == 1
    assert store.revision(first.id, 1).content["entries"]["0"]["content"] \
        == 'Test Character 1 burned the ledger.'


def test_a_re_push_never_destroys_what_the_user_edited_here(store):
    """His work stays reachable. A revision is 'on top of', never 'instead of' — and `rollback()`
    is what makes that a promise rather than a hope."""
    doc, _ = push(store, BOOK, kind="worldbook", st_ref='Sample Book')
    edited = copy.deepcopy(BOOK)
    edited["entries"]["0"]["content"] = "Test User's own wording."
    store.add_revision(doc.id, edited, note="a pass")

    push(store, BOOK, kind="worldbook", st_ref='Sample Book')

    assert store.revisions(doc.id) == [0, 1, 2]
    assert store.revision(doc.id, 1).content["entries"]["0"]["content"] == "Test User's own wording."
    rolled = store.rollback(doc.id, 1)
    assert rolled.content["entries"]["0"]["content"] == "Test User's own wording."


def test_two_different_books_are_two_documents(store):
    a, _ = push(store, BOOK, kind="worldbook", st_ref='Sample Book')
    b, _ = push(store, BOOK, kind="worldbook", st_ref='Test World Book 2')
    assert a.id != b.id
    assert len(store.list_documents()) == 2


def test_the_st_key_is_matched_exactly_unlike_a_worldbook_name(store):
    """🔴 DELIBERATELY UNLIKE `resolve_worldbook`, WHICH CASE-FOLDS, and the asymmetry is the
    reason. That one matches two human-typed strings that mean the same book. This one matches
    SillyTavern's own key, and their books are files on a case-sensitive filesystem — so folding
    here would MERGE TWO REAL BOOKS into one row and start overwriting one with the other. Too
    strict costs a duplicate row; too loose costs content."""
    a, _ = push(store, BOOK, kind="worldbook", st_ref='Sample Book')
    b, created = push(store, BOOK, kind="worldbook", st_ref="test-world-book-1")
    assert created is True
    assert b.id != a.id


def test_a_push_never_lands_on_top_of_something_the_user_uploaded(store):
    """Separate lineages. He imported a file; a push from ST is not a new version of that."""
    uploaded = store.create(copy.deepcopy(BOOK), name='Sample Book', kind="worldbook",
                            source="upload")
    pushed, created = push(store, BOOK, kind="worldbook", st_ref='Sample Book')
    assert created is True
    assert pushed.id != uploaded.id
    assert store.get(uploaded.id).latest == 0, "a push minted a revision on an uploaded document"


def test_a_card_and_a_book_with_the_same_key_do_not_collide(store):
    """A card's key is an avatar filename and a book's is a book name; nothing stops them
    matching, and reading one as the other would file a card's content onto a lorebook."""
    book, _ = push(store, BOOK, kind="worldbook", st_ref='Test Character')
    card, created = push(store, CARD, kind="card", st_ref='Test Character')
    assert created is True
    assert card.id != book.id


def test_the_library_row_keeps_the_supplied_name(store):
    """§8.2 hands him a rename button; a push must not quietly retitle the row he named."""
    doc, _ = push(store, BOOK, kind="worldbook", st_ref='Sample Book', name='Sample Book')
    store.rename(doc.id, 'Sample Book (working copy)')
    again, created = push(store, BOOK, kind="worldbook", st_ref='Sample Book', name='Sample Book')
    assert created is False
    assert again.name == 'Sample Book (working copy)'


# ───────────────────────────────────────────── §8.2: the link a re-push must not break

def test_a_book_renamed_in_vocalis_survives_a_re_push_of_its_card(store):
    """An existing card keeps its worldbook link by document ID when that book is renamed."""
    book, _ = push(store, BOOK, kind="worldbook", st_ref='Sample Book', name='Sample Book')
    card, _ = push(store, CARD, kind="card", st_ref='Test Character.png')
    assert card.world_id == book.id

    store.rename(book.id, 'Sample Book (2nd draft)')
    again, created = push(store, CARD, kind="card", st_ref='Test Character.png')

    assert created is False
    assert again.world_id == book.id, "a re-push broke a link a rename was supposed to survive"


def test_a_card_that_now_names_a_different_book_is_relinked(store):
    """The other direction: he changed the card's lorebook in SillyTavern, so the incoming
    document IS authoritative about which book it names."""
    first_book, _ = push(store, BOOK, kind="worldbook", st_ref='Sample Book', name='Sample Book')
    second_book, _ = push(store, BOOK, kind="worldbook", st_ref='Test World Book 2', name='Test World Book 2')
    card, _ = push(store, CARD, kind="card", st_ref='Test Character.png')
    assert card.world_id == first_book.id

    moved = copy.deepcopy(CARD)
    moved["data"]["extensions"]["world"] = 'Test World Book 2'
    again, _ = push(store, moved, kind="card", st_ref='Test Character.png')

    assert again.world_ref == 'Test World Book 2'
    assert again.world_id == second_book.id


def test_re_pushing_a_book_attaches_a_card_that_arrived_in_between(store):
    """`link_orphan_cards` is idempotent and runs here too — import order must not matter, and a
    re-push is just another moment at which the link can finally be made."""
    card, _ = push(store, CARD, kind="card", st_ref='Test Character.png')
    assert card.world_id == "", "there was no book to resolve against yet"

    book, _ = push(store, BOOK, kind="worldbook", st_ref='Sample Book', name='Sample Book')
    assert store.get(card.id).world_id == book.id


# ───────────────────────────────────────────── the route

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def auth(client):
    return {"Authorization": f"Bearer {pairing.rotate()}"}


def test_the_route_creates_then_revises(client, auth):
    """Creating a document adds one revision; identical re-pushes do not add revisions."""
    a = client.post("/pair/documents", json={"st_ref": 'Sample Book', "document": BOOK},
                    headers=auth)
    assert a.status_code == 201, a.get_json()
    assert a.get_json()["created"] is True
    assert a.get_json()["revision"] == 0

    same = client.post("/pair/documents", json={"st_ref": 'Sample Book', "document": BOOK},
                       headers=auth)
    assert same.status_code == 200
    assert same.get_json()["created"] is False
    assert same.get_json()["revision"] == 0, "an unchanged re-push minted a revision"
    assert same.get_json()["id"] == a.get_json()["id"]

    changed = copy.deepcopy(BOOK)
    changed["entries"]["0"]["content"] = 'Test Character 1 burned the ledger.'
    b = client.post("/pair/documents", json={"st_ref": 'Sample Book', "document": changed},
                    headers=auth)
    assert b.status_code == 200
    assert b.get_json()["created"] is False
    assert b.get_json()["revision"] == 1
    assert b.get_json()["id"] == a.get_json()["id"]


def test_the_kind_is_detected_and_a_declared_one_is_ignored(client, auth):
    """🔴 §4.2 — TYPE IS DETECTED, NEVER DECLARED. A `kind` arriving from outside the process is a
    second answer to a question we already answer by looking, and a caller holding a token could
    file a card as a worldbook so the collectors read a third of it."""
    r = client.post("/pair/documents",
                    json={"st_ref": 'Test Character.png', "kind": "worldbook", "document": CARD},
                    headers=auth)
    assert r.status_code == 201
    assert r.get_json()["kind"] == "card"


def test_a_push_with_no_key_is_refused(client, auth):
    """🔴 Loudly. Without `st_ref` every press of the button files another identical row, and a
    Library nobody can clean up is a worse outcome than a 400 on the first press."""
    r = client.post("/pair/documents", json={"document": BOOK}, headers=auth)
    assert r.status_code == 400
    r2 = client.post("/pair/documents", json={"st_ref": "   ", "document": BOOK}, headers=auth)
    assert r2.status_code == 400


def test_something_that_is_neither_a_card_nor_a_book_is_refused(client, auth):
    r = client.post("/pair/documents", json={"st_ref": "x", "document": {"hello": "world"}},
                    headers=auth)
    assert r.status_code == 400
    r2 = client.post("/pair/documents", json={"st_ref": "x", "document": "not a document"},
                     headers=auth)
    assert r2.status_code == 400


def test_a_section_chunk_file_is_a_worldbook_even_though_it_is_a_bare_list(client, auth):
    """`doc_kind` reads a list as a worldbook and `iter_entries` walks it, so the whole path has
    to hold — including the display name, which is where it used to fall over."""
    r = client.post("/pair/documents", json={"st_ref": "Guilds", "document": CHUNK}, headers=auth)
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["kind"] == "worldbook"


def test_the_response_carries_no_document_content(client, auth):
    """The extension response exposes only identity and result metadata; avatar flags permit safe picture retries without returning document content."""
    r = client.post("/pair/documents", json={"st_ref": 'Sample Book', "document": BOOK},
                    headers=auth)
    blob = r.get_data(as_text=True)
    assert 'Test Character 1' not in blob
    assert set(r.get_json()) == {"id", "kind", "created", "revision", "avatar", "avatar_dirty"}


# ───────────────────────────────────────────── the avatar (§4.3)

#: A one-pixel PNG. Real bytes, because the route's whole contract is that it stores them
#: unchanged — a fake header would pass the signature check and prove nothing about the rest.
PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       b"\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
       b"\x00\x00\x00\x00IEND\xaeB`\x82")


def _a_card(client, auth, st_ref='Test Character.png'):
    r = client.post("/pair/documents", json={"st_ref": st_ref, "document": CARD}, headers=auth)
    assert r.status_code == 201, r.get_json()
    return r.get_json()["id"]


def test_the_card_png_is_stored_byte_for_byte(client, auth, tmp_path):
    """🔴 §4.3 — THE CARD PNG *IS* THE AVATAR AND NOTHING MAY RE-ENCODE IT. An animated PNG has to
    survive and so do foreign ancillary chunks (ComfyUI generation metadata); a Pillow round trip
    destroys both, and Pillow is not even a declared dependency. Compared as bytes, because that
    is the only comparison that can fail when someone adds a "harmless" normalization."""
    doc_id = _a_card(client, auth)
    r = client.post(f"/pair/documents/{doc_id}/avatar", data=PNG,
                    content_type="image/png", headers=auth)
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["bytes"] == len(PNG)

    store = DocumentStore(paths.WBEDIT_DIR)
    assert store.asset(doc_id, "card.png") == PNG


def test_something_that_is_not_a_png_is_refused(client, auth):
    """A proxy's HTML login page or a JSON error body must not be filed as a character's face."""
    doc_id = _a_card(client, auth)
    r = client.post(f"/pair/documents/{doc_id}/avatar", data=b'{"error":"nope"}',
                    content_type="image/png", headers=auth)
    assert r.status_code == 400


def test_an_avatar_for_a_worldbook_is_refused(client, auth):
    """An unreachable blob in the vault that nothing serves and nothing deletes."""
    r = client.post("/pair/documents", json={"st_ref": 'Sample Book', "document": BOOK},
                    headers=auth)
    book_id = r.get_json()["id"]
    r2 = client.post(f"/pair/documents/{book_id}/avatar", data=PNG,
                     content_type="image/png", headers=auth)
    assert r2.status_code == 400


#: §8.3 — a persona, in the shape `sweepPersonas` actually pushes.
PERSONA = {"spec": "vocalis_persona_v1", "avatar": "test-user.png", "name": "Test User",
           "description": "A software engineer who reads code fluently.",
           "title": "The one at the keyboard", "position": 0, "depth": 4, "role": 0}


def test_a_persona_picture_is_accepted_and_stored_byte_for_byte(client, auth):
    """Persona pictures are accepted and stored byte-for-byte; worldbooks remain the only kind without pictures."""
    r = client.post("/pair/documents", json={"st_ref": "test-user.png", "document": PERSONA},
                    headers=auth)
    assert r.status_code == 201, r.get_json()
    doc_id = r.get_json()["id"]

    up = client.post(f"/pair/documents/{doc_id}/avatar", data=PNG,
                     content_type="image/png", headers=auth)
    assert up.status_code == 201, up.get_json()

    # Byte-for-byte, same as a card: it is his own picture and it routes into the vault.
    store = DocumentStore(paths.WBEDIT_DIR)
    assert store.asset(doc_id, "card.png") == PNG


def test_a_persona_that_has_a_picture_says_so_on_the_next_push(client, auth):
    """Item 12's retry rule has to work for personas too, or a failed picture never gets a second
    attempt — `sweepPersonas` skips the fetch on `!sent.created && sent.avatar`."""
    body = {"st_ref": "test-user.png", "document": PERSONA}
    first = client.post("/pair/documents", json=body, headers=auth).get_json()
    assert first["avatar"] is False, "a freshly filed persona has no picture yet"

    client.post(f"/pair/documents/{first['id']}/avatar", data=PNG,
                content_type="image/png", headers=auth)
    again = client.post("/pair/documents", json=body, headers=auth).get_json()
    assert again["avatar"] is True


def test_every_kind_that_can_have_a_picture_is_allowed_one(client, auth):
    """Every importable kind has an explicit avatar policy so a new kind cannot inherit a silent rejection."""
    from vocalis.web.pair import AVATAR_KINDS
    from wbedit.store.models import KINDS

    assert AVATAR_KINDS == frozenset(KINDS) - {"worldbook"}, (
        "a new kind arrived — decide whether it has a picture, and say so here")
    assert "persona" in AVATAR_KINDS and "card" in AVATAR_KINDS


def test_an_avatar_for_a_document_we_do_not_hold_is_a_404(client, auth):
    r = client.post("/pair/documents/deadbeefdeadbeef/avatar", data=PNG,
                    content_type="image/png", headers=auth)
    assert r.status_code == 404


def test_an_oversized_push_is_refused(client, auth):
    from vocalis.web.pair import MAX_BODY
    big = {"entries": {"0": {"uid": 0, "content": "x" * (MAX_BODY + 1)}}}
    r = client.post("/pair/documents", json={"st_ref": "Huge", "document": big}, headers=auth)
    assert r.status_code == 413


# ── item 12: a failed picture upload must be retryable ──────────────────────
#
# The extension fetched the card PNG only when `created` was true. That was a deliberate cost
# decision — a card is ~700 KB at p50 and re-sending every picture on every press is minutes of
# transfer for nothing — but it made a SINGLE failure permanent: every later press saw
# `created: false` and skipped the upload, so the card kept a blank face forever and the only
# escape was deleting the row and re-importing.
#
# 🔴 The response now carries `avatar`, so the extension can retry exactly when the picture is
# missing and never otherwise. These specs pin BOTH halves — the retry and the restraint.

def test_the_import_response_says_whether_vocalis_holds_the_picture(client, auth):
    r = client.post("/pair/documents", json={"st_ref": 'Test Character.png', "document": CARD},
                    headers=auth)
    assert r.status_code == 201
    body = r.get_json()
    assert body["avatar"] is False, "a freshly filed card has no picture yet"

    doc_id = body["id"]
    assert client.post(f"/pair/documents/{doc_id}/avatar", data=b"\x89PNG\r\n\x1a\n" + b"x" * 64,
                       headers={**auth, "Content-Type": "image/png"}).status_code == 201

    again = client.post("/pair/documents", json={"st_ref": 'Test Character.png', "document": CARD},
                        headers=auth)
    assert again.get_json()["avatar"] is True, (
        "after the picture lands, a re-push must report it as present — otherwise the extension "
        "re-uploads ~700 KB per card on every single press")


def test_a_card_whose_picture_never_arrived_keeps_asking(client, auth):
    """🔴 The actual bug. `created` is false from the second press onward, so `avatar` is the
    ONLY thing that can distinguish "already has its face" from "never got one"."""
    first = client.post("/pair/documents", json={"st_ref": 'Test Character.png', "document": CARD},
                        headers=auth).get_json()
    assert first["created"] is True and first["avatar"] is False

    # …the avatar POST fails here, and is simply never made.
    for _ in range(3):
        again = client.post("/pair/documents", json={"st_ref": 'Test Character.png', "document": CARD},
                            headers=auth).get_json()
        assert again["created"] is False, "a re-push is not a create"
        assert again["avatar"] is False, (
            "the card still has no picture, and the response has to keep saying so — this is "
            "what makes pressing the button again a repair rather than a no-op")


# ── changed pictures under unchanged card text ──────────────────────────────
# `avatar_ref` tracks SillyTavern's current image. A replacement does not create a text revision,
# so the extension must compare that reference and upload when it changes.

def _push(client, auth, *, ref=None, st_ref='Test Character.png', document=CARD):
    body = {"st_ref": st_ref, "document": document}
    if ref is not None:
        body["avatar_ref"] = ref
    return client.post("/pair/documents", json=body, headers=auth).get_json()


def _put_png(client, auth, doc_id, blob, *, ref=None):
    headers = {**auth, "Content-Type": "image/png"}
    if ref is not None:
        headers["X-Vocalis-Avatar-Ref"] = ref
    return client.post(f"/pair/documents/{doc_id}/avatar", data=blob, headers=headers)


def test_a_picture_replaced_in_sillytavern_is_asked_for_again(client, auth):
    """A changed picture under the same card text is detected even when the file timestamp is unchanged."""
    first = _push(client, auth, ref="1000")
    assert first["avatar"] is False
    assert _put_png(client, auth, first["id"], PNG, ref="1000").status_code == 201

    assert _push(client, auth, ref="1000")["avatar"] is True, "nothing changed — do not re-send"
    assert _push(client, auth, ref="2000")["avatar"] is False, (
        "the picture in SillyTavern was replaced and the response must say we do not have it — "
        "this is the whole of the fix")


def test_the_new_picture_lands_and_the_asking_stops(client, auth):
    """The repair completes rather than looping: once the fresh bytes and their stamp arrive, the
    next push is quiet again. A fix that never converged would re-send 700 KB on every press."""
    first = _push(client, auth, ref="1000")
    _put_png(client, auth, first["id"], PNG, ref="1000")

    other = b"\x89PNG\r\n\x1a\n" + b"different" * 8
    assert _put_png(client, auth, first["id"], other, ref="2000").status_code == 201
    assert _push(client, auth, ref="2000")["avatar"] is True
    store = DocumentStore(paths.WBEDIT_DIR)
    assert store.asset(first["id"], "card.png") == other, "the NEW bytes, stored verbatim"


def test_an_extension_that_sends_no_stamp_gets_the_old_answer(client, auth):
    """⚠️ NO COORDINATED DEPLOY. A pre-7.3.9 extension talking to a 7.3.9 server must not be told
    its pictures are all stale — that would re-send every card on every press, which is the cost
    the whole mechanism exists to avoid paying for nothing."""
    first = _push(client, auth)
    _put_png(client, auth, first["id"], PNG)
    assert _push(client, auth)["avatar"] is True


def test_a_picture_uploaded_here_is_not_clobbered_by_a_sweep(client, auth):
    """🔴 THE FRESHNESS RULE MUST NOT EAT HIS OWN UPLOAD. `avatar_dirty` means the Library's copy
    is AHEAD of SillyTavern's and is queued to be sent there. Re-fetching would overwrite it with
    exactly the file it is waiting to replace — a silent loss caused by a fix for staleness."""
    first = _push(client, auth, ref="1000")
    store = DocumentStore(paths.WBEDIT_DIR)
    store.put_avatar(first["id"], PNG)             # the Library's upload button: no stamp, dirty
    assert store.get(first["id"]).avatar_dirty is True

    again = _push(client, auth, ref="9999")
    assert again["avatar"] is True, "a stamp mismatch must not outrank a pending local picture"
    assert again["avatar_dirty"] is True, "and the persona sweep is told so directly"


def test_the_same_bytes_arriving_again_are_not_a_change(client, auth):
    """Identical image bytes are not treated as a change when the file timestamp moves."""
    first = _push(client, auth, ref="1000")
    _put_png(client, auth, first["id"], PNG, ref="1000")
    store = DocumentStore(paths.WBEDIT_DIR)
    assert store.get(first["id"]).avatar_dirty is False

    assert _put_png(client, auth, first["id"], PNG, ref="2000").status_code == 201
    doc = store.get(first["id"])
    assert doc.avatar_dirty is False, "same bytes, so SillyTavern is not behind us"
    assert doc.avatar_ref == "2000", (
        "but the new stamp IS recorded — otherwise the sweep re-fetches this picture for ever")
