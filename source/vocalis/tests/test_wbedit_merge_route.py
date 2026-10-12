"""Tests HTTP behavior for draft merging and conflict resolution."""
from __future__ import annotations

import io
import json

import pytest

import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.store import DocumentStore

BOOK = {
    "name": "Sample World Book 3",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False, "position": 0,
              "content": "Test Character 1 keeps the ledger."},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "order": 100, "disable": False, "position": 0,
              "content": "It rains in the lower wards."},
    },
}

CARD = {"spec": "chara_card_v2", "data": {"name": "Test Character 11", "description": "a scribe",
                                          "first_mes": "Hello."}}


def book(**contents):
    """A copy of `BOOK` with some entry contents replaced, addressed by their comment."""
    doc = json.loads(json.dumps(BOOK))
    for comment, text in contents.items():
        for entry in doc["entries"].values():
            if entry["comment"].replace(" ", "_") == comment:
                entry["content"] = text
    return doc


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _import(c, doc, filename="Sample World Book 3.json"):
    data = {"file": (io.BytesIO(json.dumps(doc).encode("utf-8")), filename)}
    return c.post("/wbedit/documents", data=data, content_type="multipart/form-data")


def _merge(c, doc_id, doc, *, filename="Sample World Book 3.json", **form):
    data = {"file": (io.BytesIO(json.dumps(doc).encode("utf-8")), filename), **form}
    return c.post(f"/wbedit/documents/{doc_id}/merge", data=data,
                  content_type="multipart/form-data")


def _hand_edit(doc_id, doc, note="hand edit"):
    """Checks that hand edit."""
    return DocumentStore(paths.WBEDIT_DIR).add_revision(doc_id, doc, note=note)


def _content(c, doc_id, n=None):
    url = f"/wbedit/documents/{doc_id}/revision/{n}" if n is not None else None
    if url is None:
        latest = c.get(f"/wbedit/documents/{doc_id}").get_json()["latest"]
        url = f"/wbedit/documents/{doc_id}/revision/{latest}"
    return c.get(url).get_json()["content"]


def _by_comment(content):
    return {e["comment"]: e for e in content["entries"].values()}


# ── the preview ──────────────────────────────────────────────────────────────────────────────

def test_a_preview_says_what_would_happen_and_writes_nothing(client):
    doc_id = _import(client, BOOK).get_json()["id"]
    _hand_edit(doc_id, book(Weather="It POURS in the lower wards."))

    r = _merge(client, doc_id, book(Sample_Entry_1="Test Character 1 has retired."))

    assert r.status_code == 200
    j = r.get_json()
    assert j["base"] == 0 and j["revision"] == 1
    assert j["tally"]["changed"] == 1 and j["conflicts"] == 0
    assert j["name"] == "Sample World Book 3"
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 1, "nothing minted"


def test_the_preview_shows_both_sides_of_a_conflict(client):
    doc_id = _import(client, BOOK).get_json()["id"]
    _hand_edit(doc_id, book(Sample_Entry_1="MINE"))

    j = _merge(client, doc_id, book(Sample_Entry_1="THEIRS")).get_json()
    entry = next(e for e in j["entries"] if e["label"] == "Sample Entry 1")
    field = next(f for f in entry["fields"] if f["name"] == "content")

    assert j["conflicts"] == 1
    assert field["verdict"] == "conflict"
    assert (field["mine"], field["theirs"], field["resolved"]) == ("MINE", "THEIRS", "MINE")


# ── applying ─────────────────────────────────────────────────────────────────────────────────

def test_applying_writes_one_revision_that_keeps_his_edit_and_takes_the_update(client):
    doc_id = _import(client, BOOK).get_json()["id"]
    _hand_edit(doc_id, book(Weather="It POURS in the lower wards."))

    r = _merge(client, doc_id, book(Sample_Entry_1="Test Character 1 has retired."),
               apply="1", revision="1")

    assert r.status_code == 201, r.get_json()
    assert r.get_json()["revision"] == 2
    out = _by_comment(_content(client, doc_id))
    assert out["Sample Entry 1"]["content"] == "Test Character 1 has retired.", "he never touched it"
    assert out["Weather"]["content"] == "It POURS in the lower wards.", "he did"


def test_a_conflict_keeps_his_text_until_he_picks_the_other_one(client):
    doc_id = _import(client, BOOK).get_json()["id"]
    _hand_edit(doc_id, book(Sample_Entry_1="MINE"))
    incoming = book(Sample_Entry_1="THEIRS")

    j = _merge(client, doc_id, incoming).get_json()
    index = next(i for i, e in enumerate(j["entries"]) if e["label"] == "Sample Entry 1")

    _merge(client, doc_id, incoming, apply="1", revision="1")
    assert _by_comment(_content(client, doc_id))["Sample Entry 1"]["content"] == "MINE"

    _merge(client, doc_id, incoming, apply="1", revision="2",
           field_choices=json.dumps({f"{index}:content": "theirs"}))
    assert _by_comment(_content(client, doc_id))["Sample Entry 1"]["content"] == "THEIRS"


def test_the_revision_the_merge_writes_is_labeled_with_what_it_did(client):
    """Checks that the revision the merge writes is labeled with what it did."""
    doc_id = _import(client, BOOK).get_json()["id"]
    _merge(client, doc_id, book(Sample_Entry_1="new text"), apply="1", revision="0")

    store = DocumentStore(paths.WBEDIT_DIR)
    assert "merged an imported file" in store.revision(doc_id, 1).note
    assert "1 changed" in store.revision(doc_id, 1).note


def test_a_second_merge_measures_from_the_first_one(client):
    """Checks that a second merge measures from the first one."""
    doc_id = _import(client, BOOK).get_json()["id"]
    _merge(client, doc_id, book(Sample_Entry_1="first update"), apply="1", revision="0")

    j = _merge(client, doc_id, book(Sample_Entry_1="second update")).get_json()

    assert j["base"] == 1, "the merge is the new reconciliation point, not revision 0"
    assert j["conflicts"] == 0, "the first update is settled and must not come back as a decision"
    entry = next(e for e in j["entries"] if e["label"] == "Sample Entry 1")
    field = next(f for f in entry["fields"] if f["name"] == "content")
    assert field["verdict"] == "theirs" and field["resolved"] == "second update"


def test_a_second_merge_keeps_an_entry_added_by_the_first_merge(client):
    """A later partial update must not erase an entry that the first merge introduced locally."""
    doc_id = _import(client, BOOK).get_json()["id"]

    added = json.loads(json.dumps(BOOK))
    added["entries"]["9"] = {
        "uid": 9, "key": ["local"], "comment": "Local addition", "constant": False,
        "order": 100, "disable": False, "position": 0, "content": "Keep this entry.",
    }
    _merge(client, doc_id, added, apply="1", revision="0")

    # The next imported file is a partial update and does not carry the local addition.
    r = _merge(client, doc_id, book(Sample_Entry_1="second update"),
               apply="1", revision="1")
    assert r.status_code == 201, r.get_json()
    out = _by_comment(_content(client, doc_id))
    assert out["Local addition"]["content"] == "Keep this entry."


# ── the guards that make the choice indices mean anything ────────────────────────────────────

def test_applying_without_saying_which_version_is_refused(client):
    """There is no safe default for "which version were these choices made against"."""
    doc_id = _import(client, BOOK).get_json()["id"]

    r = _merge(client, doc_id, book(Sample_Entry_1="x"), apply="1")

    assert r.status_code == 400
    assert "revision" in r.get_json()["error"]


def test_a_head_that_moved_under_the_pane_is_a_409_with_the_number_in_it(client):
    """Checks that a head that moved under the pane is a 409 with the number in it."""
    doc_id = _import(client, BOOK).get_json()["id"]
    _hand_edit(doc_id, book(Sample_Entry_1="MINE"))
    _hand_edit(doc_id, book(Sample_Entry_1="MINE AGAIN"))     # the pane never saw this one

    r = _merge(client, doc_id, book(Sample_Entry_1="THEIRS"), apply="1", revision="1")

    assert r.status_code == 409
    j = r.get_json()
    assert j["conflict"] is True and j["latest"] == 2
    assert _by_comment(_content(client, doc_id))["Sample Entry 1"]["content"] == "MINE AGAIN"


@pytest.mark.parametrize("form,where", [
    ({"field_choices": "not json"}, "field_choices"),
    ({"field_choices": "[1,2]"}, "field_choices"),
    ({"field_choices": json.dumps({"0:content": "whatever"})}, "field_choices"),
    ({"entry_choices": json.dumps({"0": "obliterate"})}, "entry_choices"),
])
def test_a_choice_it_cannot_read_is_refused_rather_than_ignored(client, form, where):
    """A typo'd pick silently falling back to the computed verdict is a radio button that does
    nothing — reported as "the merge ignored me" and reproducible by nobody."""
    doc_id = _import(client, BOOK).get_json()["id"]

    r = _merge(client, doc_id, book(Sample_Entry_1="x"), apply="1", revision="0", **form)

    assert r.status_code == 400
    assert where in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 0, "nothing minted"


# ── what this door is not for ────────────────────────────────────────────────────────────────

def test_a_card_merges_into_a_card(client):
    """The URL selects the merge target; cards are matched by ID because names can be shared."""
    card_id = _import(client, CARD, filename="Test Character 11.json").get_json()["id"]
    mine = json.loads(json.dumps(CARD))
    mine["data"]["personality"] = "DRY AND SHARP"
    _hand_edit(card_id, mine)
    theirs = json.loads(json.dumps(CARD))
    theirs["data"]["description"] = "a court scribe"

    r = _merge(client, card_id, theirs, filename="Test Character 11.json", apply="1", revision="1")

    assert r.status_code == 201, r.get_json()
    data = _content(client, card_id)["data"]
    assert data["description"] == "a court scribe", "he never touched it"
    assert data["personality"] == "DRY AND SHARP", "he did"


@pytest.mark.parametrize("into,payload,name", [
    ("book", CARD, "Test Character 11.json"),
    ("card", BOOK, "Sample World Book 3.json"),
])
def test_a_file_of_the_wrong_kind_is_refused_naming_both(client, into, payload, name):
    """Checks that a file of the wrong kind is refused naming both."""
    doc_id = _import(client, BOOK if into == "book" else CARD,
                     filename="Sample World Book 3.json" if into == "book" else "Test Character 11.json").get_json()["id"]

    r = _merge(client, doc_id, payload, filename=name)

    assert r.status_code == 400
    error = r.get_json()["error"]
    assert "card" in error and "worldbook" in error


def test_merging_into_a_document_that_is_not_there_is_a_404(client):
    assert _merge(client, "0123456789abcdef", BOOK).status_code == 404


def test_a_file_that_is_not_a_document_at_all_gets_the_same_refusal_as_the_import_door(client):
    """Checks that a file that is not a document at all gets the same refusal as the import door."""
    doc_id = _import(client, BOOK).get_json()["id"]
    data = {"file": (io.BytesIO(b"this is not json"), "x.json")}
    merged = client.post(f"/wbedit/documents/{doc_id}/merge", data=data,
                         content_type="multipart/form-data")
    imported = client.post("/wbedit/documents",
                           data={"file": (io.BytesIO(b"this is not json"), "x.json")},
                           content_type="multipart/form-data")

    assert merged.status_code == imported.status_code == 400
    assert merged.get_json()["error"] == imported.get_json()["error"]


# The third conflict choice starts with incoming text so the editor can combine both versions.

def _edited_card(client):
    """A card at revision 1 with a conflicting field. Returns `(id, incoming_file)`."""
    card_id = _import(client, CARD, filename="Test Character 11.json").get_json()["id"]
    mine = json.loads(json.dumps(CARD))
    mine["data"]["description"] = "a scribe, and the keeper of the ledger"
    _hand_edit(card_id, mine)
    theirs = json.loads(json.dumps(CARD))
    theirs["data"]["description"] = "a court scribe"
    return card_id, theirs


def test_a_hand_written_resolution_is_what_lands(client):
    card_id, theirs = _edited_card(client)

    r = _merge(client, card_id, theirs, filename="Test Character 11.json", apply="1", revision="1",
               field_choices=json.dumps({"doc:data.description": "edited"}),
               field_edits=json.dumps({"doc:data.description":
                                       "a court scribe, and the keeper of the ledger"}))

    assert r.status_code == 201, r.get_json()
    assert _content(client, card_id)["data"]["description"] == \
        "a court scribe, and the keeper of the ledger"


def test_an_edited_pick_with_no_text_is_refused_rather_than_writing_nothing(client):
    """Checks that an edited pick with no text is refused rather than writing nothing."""
    card_id, theirs = _edited_card(client)

    r = _merge(client, card_id, theirs, filename="Test Character 11.json", apply="1", revision="1",
               field_choices=json.dumps({"doc:data.description": "edited"}))

    assert r.status_code == 400
    assert "doc:data.description" in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{card_id}").get_json()["latest"] == 1, "nothing minted"


def test_a_stale_edit_box_cannot_beat_the_radio_he_can_see(client):
    """Checks that the visible conflict choice takes precedence over stale edit text."""
    card_id, theirs = _edited_card(client)

    r = _merge(client, card_id, theirs, filename="Test Character 11.json", apply="1", revision="1",
               field_choices=json.dumps({"doc:data.description": "theirs"}),
               field_edits=json.dumps({"doc:data.description": "TEXT HE ABANDONED"}))

    assert r.status_code == 201, r.get_json()
    assert _content(client, card_id)["data"]["description"] == "a court scribe"


def test_the_preview_carries_the_previous_text_so_the_dialog_can_color_his_edits(client):
    """Checks that the preview includes prior text so the dialog can identify local edits."""
    card_id, theirs = _edited_card(client)

    j = _merge(client, card_id, theirs, filename="Test Character 11.json").get_json()
    field = next(f for f in j["doc_fields"] if f["name"] == "data.description")

    assert field["verdict"] == "conflict"
    assert field["base"] == "a scribe"
    assert field["mine"] == "a scribe, and the keeper of the ledger"
    assert field["theirs"] == "a court scribe"


@pytest.mark.parametrize("form,where", [
    ({"field_edits": "not json"}, "field_edits"),
    ({"field_edits": "[1,2]"}, "field_edits"),
    ({"field_edits": json.dumps({"doc:data.description": 7})}, "field_edits"),
])
def test_an_edit_map_it_cannot_read_is_refused(client, form, where):
    card_id, theirs = _edited_card(client)

    r = _merge(client, card_id, theirs, filename="Test Character 11.json", apply="1", revision="1", **form)

    assert r.status_code == 400
    assert where in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{card_id}").get_json()["latest"] == 1, "nothing minted"


def test_the_refusal_names_the_address_and_never_quotes_his_prose(client):
    """Checks that a refusal identifies the field without quoting its content."""
    card_id, theirs = _edited_card(client)
    prose = "Test Character 1 keeps the ledger of every debt in the lower wards"

    r = _merge(client, card_id, theirs, filename="Test Character 11.json", apply="1", revision="1",
               field_edits=json.dumps({"doc:data.description": [prose]}))

    error = r.get_json()["error"]
    assert r.status_code == 400
    assert "doc:data.description" in error, "it has to say WHICH field to be actionable"
    assert prose not in error and "Test Character 10" not in error
