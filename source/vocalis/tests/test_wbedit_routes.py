"""Tests World Book editing routes and their response contracts."""
from __future__ import annotations

import json
import threading

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import kobold
import vocalis_server as vs
import vocalis.web.kobold as web_kobold
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.core.contract import BEGIN, END, NOCHANGE

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

CARD = {
    "spec": "chara_card_v2", "spec_version": "2.0",
    "data": {"name": "Test Character 2", "description": "A tall woman who keeps her own counsel.",
             "personality": "Wry.", "scenario": "A tavern.", "first_mes": "You again.",
             "mes_example": "<START>\n{{user}}: Hello.\n{{char}}: Hm.",
             "extensions": {"taproom_avatar_focus": {"x": 0.1, "y": 0.2, "w": 0.5}}},
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    # The single-pass slot is a module global; a test that starts a pass must not leak it into
    # the next one, which would then see a spurious 409.
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _import(c, doc=None, name="Sample World Book 1"):
    r = c.post("/wbedit/documents", json={"document": doc or BOOK, "name": name})
    assert r.status_code == 201, r.get_json()
    return r.get_json()


# ── the library and the editor ───────────────────────────────────────────────

def test_a_worldbook_imports_and_appears_in_the_library(client):
    doc = _import(client)
    assert doc["kind"] == "worldbook" and doc["latest"] == 0
    rows = client.get("/wbedit/documents").get_json()["documents"]
    assert [r["id"] for r in rows] == [doc["id"]]
    assert rows[0]["name"] == "Sample World Book 1"


def test_a_card_is_detected_as_a_card_and_keeps_its_focus_rect(client):
    """Checks that a card is detected as a card and keeps its focus rect."""
    doc = _import(client, CARD, name="ignored")
    assert doc["kind"] == "card"
    assert doc["name"] == "Test Character 2", "the card's own name should win over the filename"
    assert doc["focus"] == {"x": 0.1, "y": 0.2, "w": 0.5}


def test_a_document_that_is_neither_is_refused_rather_than_filed(client):
    """It is raised, not skipped: a document no pass can ever touch would sit in the Library
    looking normal and show itself as an empty field list days later."""
    r = client.post("/wbedit/documents", json={"document": {"hello": "world"}})
    assert r.status_code == 400
    assert client.get("/wbedit/documents").get_json()["documents"] == []


def test_the_fields_route_lists_what_a_pass_would_edit_with_its_length(client):
    doc = _import(client)
    body = client.get(f"/wbedit/documents/{doc['id']}/fields").get_json()
    assert [f["label"] for f in body["fields"]] == ["Sample Entry 1", "Weather"]
    assert body["fields"][0]["chars"] > 0
    assert body["fields"][0]["locator"] == ["entries", "0", "content"]


def test_the_editor_shows_every_card_field_with_machinery_UNTICKED(client):
    """All supported card fields, including alternate greetings, appear in the editor with pass behavior disabled by default."""
    card = json.loads(json.dumps(CARD))
    card["data"]["creator_notes"] = "Do not redistribute."
    card["data"]["system_prompt"] = "You are {{char}}. Never break character."
    card["data"]["post_history_instructions"] = "Stay in scene."
    card["data"]["alternate_greetings"] = ["The door was already open.", "  ", "You again."]
    doc = _import(client, card)
    fields = client.get(f"/wbedit/documents/{doc['id']}/fields").get_json()["fields"]
    by_label = {f["label"]: f for f in fields}

    assert by_label["description"]["pass_default"] is True
    assert by_label["first_mes"]["pass_default"] is True
    for machinery in ("creator_notes", "system_prompt", "post_history_instructions"):
        assert machinery in by_label, f"{machinery} is editable and sendable — it must be visible"
        assert by_label[machinery]["pass_default"] is False, "I13 — never in a pass by default"

    # Each greeting is its own field, the blank one is skipped, and the indices stay ORIGINAL —
    # `alternate_greetings[2]` must address element 2, not "the second one we kept".
    greets = [f for f in fields if f["label"].startswith("alternate_greetings")]
    assert [g["label"] for g in greets] == ["alternate_greetings[0]", "alternate_greetings[2]"]
    assert greets[1]["locator"] == ["data", "alternate_greetings", 2]
    assert all(g["pass_default"] is False for g in greets), \
        "a card with eight greetings must not quadruple a pass nobody asked to quadruple"


def test_naming_card_fields_explicitly_is_an_opt_in_and_ticks_them(client):
    """Checks that naming card fields explicitly is an opt in and ticks them."""
    card = json.loads(json.dumps(CARD))
    card["data"]["creator_notes"] = "Do not redistribute."
    doc = _import(client, card)
    opted = client.get(f"/wbedit/documents/{doc['id']}/fields",
                       query_string={"card_fields": "description,creator_notes"}).get_json()
    assert [f["label"] for f in opted["fields"]] == ["description", "creator_notes"]
    assert all(f["pass_default"] is True for f in opted["fields"])


def test_a_worldbook_field_is_always_pass_default(client):
    """Worldbook entries default to enabled for passes. The explicit `is not False` check keeps a missing field from silently narrowing a book pass."""
    doc = _import(client)
    fields = client.get(f"/wbedit/documents/{doc['id']}/fields").get_json()["fields"]
    assert fields and all(f["pass_default"] is True for f in fields)


def test_a_hand_edit_mints_a_revision_and_leaves_the_import_alone(client):
    """Manual edits create a revision without changing the imported revision."""
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={"edits": [
        {"locator": ["entries", "0", "content"], "text": "Renamed Character 1 keeps the ledger.",
         "label": "Sample Entry 1"}]})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["n"] == 1

    rev0 = client.get(f"/wbedit/documents/{doc['id']}/revision/0").get_json()
    rev1 = client.get(f"/wbedit/documents/{doc['id']}/revision/1").get_json()
    assert rev0["content"] == BOOK, "I8 — the import was mutated"
    assert rev1["content"]["entries"]["0"]["content"] == "Renamed Character 1 keeps the ledger."
    assert rev1["content"]["entries"]["1"] == BOOK["entries"]["1"], "an untouched entry moved"


def test_a_hand_edit_with_a_bad_locator_is_refused(client):
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={"edits": [
        {"locator": ["entries", "99", "content"], "text": "x"}]})
    assert r.status_code == 400


@pytest.mark.parametrize("locator, what", [
    (["entries", "0"], "a whole entry, replaced by a string"),
    (["entries"], "the entire entries map"),
    (["entries", "0", "uid"], "the identity every other locator points at"),
    (["entries", "0", "order"], "insertion order — a NOT_EDITABLE setting"),
    (["entries", "0", "constant"], "an activation mode, and not a string at all"),
])
def test_a_hand_edit_may_only_address_a_field_the_editor_offered(client, locator, what):
    """Checks that a hand edit may only address a field the editor offered."""
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/edit",
                    json={"edits": [{"locator": locator, "text": "x"}]})
    assert r.status_code == 400, f"accepted an edit to {what}"
    assert "editable" in r.get_json()["error"], "the refusal must say why"
    # and nothing was minted
    assert client.get(f"/wbedit/documents/{doc['id']}").get_json()["latest"] == 0


def test_the_allow_list_does_not_refuse_the_fields_the_editor_does_offer(client):
    """Checks that the allow list does not refuse the fields the editor does offer."""
    doc = _import(client)
    fields = client.get(f"/wbedit/documents/{doc['id']}/fields").get_json()["fields"]
    assert fields, "no fields to check against"
    for f in fields:
        r = client.post(f"/wbedit/documents/{doc['id']}/edit",
                        json={"edits": [{"locator": f["locator"],
                                         "text": f"rewritten {f['label']}"}]})
        assert r.status_code == 201, f"/fields offered {f['locator']} but /edit refused it"


def test_rollback_mints_a_new_revision_and_keeps_the_history(client):
    doc = _import(client)
    client.post(f"/wbedit/documents/{doc['id']}/edit", json={"edits": [
        {"locator": ["entries", "0", "content"], "text": "second"}]})
    r = client.post(f"/wbedit/documents/{doc['id']}/rollback/0")
    assert r.status_code == 200
    assert r.get_json()["n"] == 2 and r.get_json()["from_revision"] == 0
    body = client.get(f"/wbedit/documents/{doc['id']}").get_json()
    assert body["revisions"] == [0, 1, 2], "rollback deleted history"


def test_rename_and_delete(client):
    doc = _import(client)
    assert client.post(f"/wbedit/documents/{doc['id']}/rename",
                       json={"name": "Renamed"}).get_json()["name"] == "Renamed"
    assert client.delete(f"/wbedit/documents/{doc['id']}").status_code == 200
    assert client.get(f"/wbedit/documents/{doc['id']}").status_code == 404


def test_a_missing_document_is_a_404_not_a_500(client):
    assert client.get("/wbedit/documents/nope").status_code == 404
    assert client.get("/wbedit/documents/nope/revision/0").status_code == 404




def _png_card(card, chunks_extra=()):
    """A structurally real PNG carrying `card` in a `chara` chunk, plus any extras."""
    import base64
    import struct
    import zlib

    from wbedit.formats import png_card

    def chunk(ctype: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + ctype + data
                + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))

    body = png_card.PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    body += chunk(b"tEXt", b"chara\x00" + base64.b64encode(json.dumps(card).encode("utf-8")))
    for ctype, data in chunks_extra:
        body += chunk(ctype, data)
    return body + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b"")


def _import_png(c, blob, filename="Test Character 2.png"):
    import io

    r = c.post("/wbedit/documents",
               data={"file": (io.BytesIO(blob), filename)},
               content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def test_the_avatar_comes_back_byte_for_byte_as_it_went_in(client):
    """Checks that the avatar comes back byte for byte as it went in."""
    blob = _png_card(CARD, [(b"coMf", b"workflow-metadata-that-must-survive")])
    doc = _import_png(client, blob)
    assert doc["avatar"] is True

    r = client.get(f"/wbedit/documents/{doc['id']}/avatar")
    assert r.status_code == 200
    assert r.mimetype == "image/png"
    assert r.data == blob, "the avatar was not served verbatim"
    assert b"workflow-metadata-that-must-survive" in r.data


def test_a_document_with_no_picture_is_a_404_and_never_a_placeholder(client):
    """A document without an avatar returns 404 rather than a placeholder image that could be mistaken for stored content."""
    doc = _import(client, CARD, name="Test Character 2")       # the JSON path — no picture with it
    assert doc.get("avatar") is False
    assert client.get(f"/wbedit/documents/{doc['id']}/avatar").status_code == 404
    assert client.get("/wbedit/documents/nope/avatar").status_code == 404


def test_the_library_says_which_rows_have_a_face(client):
    """Checks that the library says which rows have a face."""
    with_png = _import_png(client, _png_card(CARD))
    without = _import(client, CARD, name="Plain Test Character 2")
    book = _import(client)

    rows = {r["id"]: r for r in client.get("/wbedit/documents").get_json()["documents"]}
    assert rows[with_png["id"]]["avatar"] is True
    assert rows[without["id"]]["avatar"] is False
    assert rows[book["id"]]["avatar"] is False, "a worldbook never has one"
    # And the same answer from the single-document route the Editor opens with.
    assert client.get(f"/wbedit/documents/{with_png['id']}").get_json()["avatar"] is True


def test_the_focus_rect_travels_with_the_row_so_the_circle_can_be_cut(client):
    """Checks that the focus rect travels with the row so the circle can be cut."""
    with_rect = _import_png(client, _png_card(CARD))
    bare = json.loads(json.dumps(CARD))
    bare["data"]["extensions"].pop("taproom_avatar_focus")
    without = _import_png(client, _png_card(bare))

    rows = {r["id"]: r for r in client.get("/wbedit/documents").get_json()["documents"]}
    assert rows[with_rect["id"]]["focus"] == {"x": 0.1, "y": 0.2, "w": 0.5}
    assert rows[without["id"]]["focus"] == {}


def test_a_second_request_for_the_same_face_is_a_304(client):
    """An unchanged thumbnail returns 304 so the roster does not repeatedly decrypt and transfer the same image."""
    doc = _import_png(client, _png_card(CARD))
    first = client.get(f"/wbedit/documents/{doc['id']}/avatar")
    etag = first.headers["ETag"]
    # Revalidate cached bytes so a replaced picture is visible immediately; the 304 response for
    # an unchanged image still avoids retransferring it.
    assert etag and first.headers["Cache-Control"] == "private, no-cache"

    again = client.get(f"/wbedit/documents/{doc['id']}/avatar",
                       headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.data == b""
    assert again.headers["ETag"] == etag
    # A different tag must NOT be honored — otherwise the conditional is decorative.
    assert client.get(f"/wbedit/documents/{doc['id']}/avatar",
                      headers={"If-None-Match": '"stale"'}).status_code == 200


def test_a_locked_vault_is_a_423_rather_than_a_missing_picture(client, monkeypatch):
    """A locked vault returns 423. Returning 404 would incorrectly tell the interface that the document has no picture."""
    doc = _import_png(client, _png_card(CARD))
    import vault_fs

    class Locked(Exception):
        pass

    monkeypatch.setattr(vault_fs, "locked_exc", lambda: Locked)
    monkeypatch.setattr(vault_fs, "stat", lambda *a, **k: (_ for _ in ()).throw(Locked()))
    r = client.get(f"/wbedit/documents/{doc['id']}/avatar")
    assert r.status_code == 423
    assert r.get_json()["locked"] is True


# ── Export ───────────────────────────────────────────────────────────────────


def test_a_worldbook_exports_as_the_json_sillytavern_imports(client):
    doc = _import(client)
    r = client.get(f"/wbedit/documents/{doc['id']}/export")
    assert r.status_code == 200 and r.mimetype == "application/json"
    assert "attachment" in r.headers["Content-Disposition"]
    assert json.loads(r.data.decode("utf-8")) == BOOK


def test_a_card_exports_as_a_PNG_CARRYING_ITS_PICTURE(client):
    """Export a card with its avatar as PNG while preserving unrelated image chunks and metadata."""
    from wbedit.formats import png_card

    blob = _png_card(CARD, [(b"coMf", b"workflow-metadata-that-must-survive")])
    doc = _import_png(client, blob)
    e = client.post(f"/wbedit/documents/{doc['id']}/edit",
                    json={"edits": [{"locator": ["data", "personality"], "text": "Warmer."}]})
    assert e.status_code == 201, e.get_json()

    r = client.get(f"/wbedit/documents/{doc['id']}/export?revision=1")
    assert r.status_code == 200 and r.mimetype == "image/png"
    assert r.data.startswith(png_card.PNG_SIGNATURE)
    assert b"workflow-metadata-that-must-survive" in r.data, "a foreign chunk was dropped"

    out, _key = png_card.read_card(r.data)
    assert out["data"]["personality"] == "Warmer.", "the export carried the OLD card"


def test_a_card_with_no_picture_exports_as_json_rather_than_failing(client):
    doc = _import(client, CARD, name="Test Character 2")
    r = client.get(f"/wbedit/documents/{doc['id']}/export")
    assert r.status_code == 200 and r.mimetype == "application/json"
    assert json.loads(r.data.decode("utf-8"))["data"]["name"] == "Test Character 2"


def test_export_serves_the_revision_asked_for_and_not_the_latest(client):
    """Export the requested revision rather than silently substituting the latest revision."""
    doc = _import(client)
    e = client.post(f"/wbedit/documents/{doc['id']}/edit", json={"edits": [
        {"locator": ["entries", "0", "content"], "text": "Renamed Character 1 keeps the ledger."}]})
    assert e.status_code == 201, e.get_json()

    latest = client.get(f"/wbedit/documents/{doc['id']}/export").get_data()
    first = client.get(f"/wbedit/documents/{doc['id']}/export?revision=0").get_data()
    assert b"Renamed Character 1" in latest
    assert b"Test Character 1" in first and b"Renamed Character 1" not in first


def test_a_hostile_document_name_cannot_inject_a_response_header(client):
    """Checks that a hostile document name cannot inject a response header."""
    doc = _import(client)
    client.post(f"/wbedit/documents/{doc['id']}/rename",
                json={"name": 'evil"\r\nSet-Cookie: a=b'})
    r = client.get(f"/wbedit/documents/{doc['id']}/export")
    assert r.status_code == 200
    cd = r.headers["Content-Disposition"]
    assert "\r" not in cd and "\n" not in cd and "Set-Cookie" not in r.headers
    assert cd.count('"') == 2, f"an unescaped quote survived: {cd}"


def test_a_utf8_name_survives_the_download(client):
    """Non-ASCII document names survive the download filename encoding."""
    doc = _import(client)
    client.post(f"/wbedit/documents/{doc['id']}/rename", json={"name": "Équestria"})
    cd = client.get(f"/wbedit/documents/{doc['id']}/export").headers["Content-Disposition"]
    assert "filename*=UTF-8''%C3%89questria.json" in cd


def test_exporting_a_missing_document_is_a_404(client):
    assert client.get("/wbedit/documents/nope/export").status_code == 404


# ── I15, at the HTTP layer ───────────────────────────────────────────────────

def test_a_locked_vault_is_a_423_and_never_an_empty_library(client, monkeypatch):
    """Checks that a locked vault is a 423 and never an empty library."""
    _import(client)
    import vault_fs

    class Locked(Exception):
        pass

    monkeypatch.setattr(vault_fs, "locked_exc", lambda: Locked)
    monkeypatch.setattr(vault_fs, "listdir", lambda *a, **k: (_ for _ in ()).throw(Locked()))
    r = client.get("/wbedit/documents")
    assert r.status_code == 423
    assert r.get_json()["locked"] is True
    assert "documents" not in r.get_json()


# ── the instruction library ──────────────────────────────────────────────────

def test_the_instruction_library_round_trips_over_http(client):
    r = client.post("/wbedit/instructions", json={"name": "Americanize",
                                                  "text": "Change British spellings."})
    assert r.status_code == 201
    ins = r.get_json()
    assert client.post(f"/wbedit/instructions/{ins['id']}",
                       json={"favorite": True}).get_json()["favorite"] is True
    rows = client.get("/wbedit/instructions").get_json()["instructions"]
    assert [i["name"] for i in rows] == ["Americanize"]
    assert client.delete(f"/wbedit/instructions/{ins['id']}").status_code == 200
    assert client.get("/wbedit/instructions").get_json()["instructions"] == []


def test_an_empty_instruction_is_refused(client):
    assert client.post("/wbedit/instructions", json={"text": "   "}).status_code == 400


# ── the pass ─────────────────────────────────────────────────────────────────

@pytest.fixture
def kobold_up(monkeypatch):
    """A stubbed KoboldCpp at the same seam production talks through, so the sampler block and
    the message list are really built and really sent."""
    sent = []

    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="k",
                                                    local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"model": "koboldcpp/test-model"})

    def fake_request(cfg, path, body=None, timeout=10.0):
        sent.append((path, body))
        field = body["messages"][-1]["content"].split("FIELD\n", 1)[1]
        if "Test Character 1" not in field:
            return {"choices": [{"message": {"content": NOCHANGE}}]}
        out = field.replace("Test Character 1", "Renamed Character 1")
        return {"choices": [{"message": {
            "content": f"{BEGIN}\n{out}\n{END}\nRenamed the character."}}]}

    monkeypatch.setattr(kobold, "_request", fake_request)
    return sent


def _await_pass(client, doc_id, pass_id, timeout=15.0):
    """Join the pass's worker thread, then read its record once. The route starts the thread
    (named `wbedit-<pass id>`) before it answers 201, so the join is the completion signal; a
    thread no longer listed has already ended."""
    for t in threading.enumerate():
        if t.name == f"wbedit-{pass_id}":
            t.join(timeout)
            assert not t.is_alive(), "the pass never finished"
    body = client.get(f"/wbedit/pass/{doc_id}/{pass_id}").get_json()
    assert body["status"] in ("done", "failed", "canceled"), "the pass never finished"
    return body


def test_a_pass_runs_and_its_proposals_become_a_revision(client, kobold_up):
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."})
    assert r.status_code == 201, r.get_json()
    p = r.get_json()
    assert p["fields"] == 2 and p["model"] == "koboldcpp/test-model"

    body = _await_pass(client, doc["id"], p["id"])
    assert body["tally"]["CHANGED"] == 1 and body["tally"]["NOCHANGE"] == 1
    assert [x["status"] for x in body["proposals"]] == ["CHANGED", "NOCHANGE"]
    assert [x["review"] for x in body["proposals"]] == ["approved", "none"]

    r = client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/materialize")
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["applied"] == 1
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/1").get_json()
    assert rev["content"]["entries"]["0"]["content"].startswith("Renamed Character 1")
    assert rev["content"]["entries"]["1"] == BOOK["entries"]["1"]


def test_the_pass_sends_the_whole_sampler_block(client, kobold_up):
    """Checks that the pass sends the whole sampler block."""
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])
    assert kobold_up, "nothing was sent"
    path, body = kobold_up[0]
    assert path == "/v1/chat/completions"
    for key, value in (("rep_pen", 1.0), ("rep_pen_range", 0), ("dry_multiplier", 0),
                       ("xtc_probability", 0)):
        assert body[key] == value, f"{key} was {body.get(key)!r}, not {value!r} (I2)"
    assert body["temperature"] == 0.2 and body["stream"] is False


def test_the_instruction_is_byte_identical_across_every_request(client, kobold_up):
    """I10 — what makes 110 independent edits one coherent pass, and what keeps KoboldCpp's
    prompt prefix stable so only the field itself is processed fresh."""
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])
    prefixes = {b["messages"][-1]["content"].split("\n\nIf the instruction")[0]
                for _p, b in kobold_up}
    assert len(prefixes) == 1, "the instruction varied between requests"


def test_only_the_selected_fields_are_passed(client, kobold_up):
    """§6.2's checkboxes, at the wire."""
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass", json={
        "instruction": "Rename Test Character 1 to Renamed Character 1.",
        "locators": [["entries", "1", "content"]]}).get_json()
    assert p["fields"] == 1
    body = _await_pass(client, doc["id"], p["id"])
    assert [x["label"] for x in body["proposals"]] == ["Weather"]


def test_a_pass_with_nothing_selected_is_refused(client, kobold_up):
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/pass", json={
        "instruction": "x", "locators": [["entries", "99", "content"]]})
    assert r.status_code == 400


def test_a_field_the_editor_SHOWS_can_actually_be_passed(client, kobold_up):
    """Checks that a field the editor shows can actually be passed."""
    card = json.loads(json.dumps(CARD))
    card["data"]["alternate_greetings"] = ["Test Character 1 left the door open."]
    card["data"]["system_prompt"] = "Test Character 1 is the subject."
    doc = _import(client, card, name="Test Character 2")
    p = client.post(f"/wbedit/documents/{doc['id']}/pass", json={
        "instruction": "Rename Test Character 1 to Renamed Character 1.",
        "locators": [["data", "alternate_greetings", 0], ["data", "system_prompt"]]}).get_json()
    assert p["fields"] == 2, p

    body = _await_pass(client, doc["id"], p["id"])
    assert [x["label"] for x in body["proposals"]] == ["alternate_greetings[0]", "system_prompt"]
    assert client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/materialize").status_code == 201
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/1").get_json()
    assert rev["content"]["data"]["alternate_greetings"][0].startswith("Renamed Character 1")
    assert rev["content"]["data"]["system_prompt"].startswith("Renamed Character 1")


def test_an_unlocated_pass_still_runs_only_the_I13_DEFAULT_FIELDS(client, kobold_up):
    """Checks that an unlocated pass still runs only the i13 default fields."""
    card = json.loads(json.dumps(CARD))
    card["data"]["system_prompt"] = "Test Character 1 is the subject."
    card["data"]["alternate_greetings"] = ["Test Character 1 left the door open."]
    doc = _import(client, card, name="Test Character 2")
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    body = _await_pass(client, doc["id"], p["id"])
    labels = [x["label"] for x in body["proposals"]]
    assert labels == ["description", "personality", "scenario", "first_mes", "mes_example"]


def test_a_greeting_can_be_hand_edited_at_its_list_index(client):
    """`set_at` walks into a LIST here, not a dict — `("data", "alternate_greetings", 0)`
    addresses an element, and the neighboring greeting must round-trip untouched."""
    card = json.loads(json.dumps(CARD))
    card["data"]["alternate_greetings"] = ["The door was open.", "You again."]
    doc = _import(client, card, name="Test Character 2")
    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={"edits": [
        {"locator": ["data", "alternate_greetings", 1], "text": "You are late.",
         "label": "alternate_greetings[1]"}]})
    assert r.status_code == 201, r.get_json()
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/1").get_json()
    assert rev["content"]["data"]["alternate_greetings"] == ["The door was open.", "You are late."]


# ── I16 — the invariant that can only break here ─────────────────────────────

def test_no_field_text_reaches_the_progress_stream(client, kobold_up):
    """Checks that no field text reaches the progress stream."""
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])

    stream = client.get(f"/wbedit/pass/{doc['id']}/{p['id']}/events").get_data(as_text=True)
    assert "field.result" in stream, "the stream carried no results — this test proves nothing"
    for body_text in ("Test Character 1", "Renamed Character 1", "estuary", "lower wards", "ninth month"):
        assert body_text not in stream, f"I16 BREACH: {body_text!r} in an SSE frame"
    # ...and the labels DO travel, because a progress line that cannot say which entry it is on
    # is not a progress line.
    assert "Sample Entry 1" in stream and "Weather" in stream


def test_the_body_is_available_one_proposal_at_a_time(client, kobold_up):
    """The other half of the I16 split: the review pane's data, over an ordinary authenticated
    route. This is what makes the metadata-only stream affordable rather than useless."""
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])
    body = client.get(f"/wbedit/pass/{doc['id']}/{p['id']}/proposal/1").get_json()
    assert body["original"].startswith("Test Character 1")
    assert body["revised"].startswith("Renamed Character 1")


def test_the_pass_index_carries_no_bodies_either(client, kobold_up):
    """A "give me everything" route would be convenient, would work, and would put a whole
    book's worth of before/after text into one response some proxy will buffer."""
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])
    raw = client.get(f"/wbedit/pass/{doc['id']}/{p['id']}").get_data(as_text=True)
    assert "estuary" not in raw and "lower wards" not in raw
    assert "Sample Entry 1" in raw


# ── I12 — one pass at a time ─────────────────────────────────────────────────

def test_a_second_pass_is_refused_while_one_is_running(client, kobold_up, monkeypatch):
    """Checks that a second pass is refused while one is running."""
    slow = []
    in_request, release = threading.Event(), threading.Event()

    real = kobold._request

    def slower(cfg, path, body=None, timeout=10.0):
        slow.append(1)
        in_request.set()                  # the first pass is now inside its model call
        release.wait(30)                  # ...and stays there until the test lets it go
        return real(cfg, path, body, timeout)

    monkeypatch.setattr(kobold, "_request", slower)

    doc = _import(client)
    first = client.post(f"/wbedit/documents/{doc['id']}/pass",
                        json={"instruction": "Rename Test Character 1 to Renamed Character 1."})
    assert first.status_code == 201
    try:
        assert in_request.wait(15), "the first pass never reached its model call"
        second = client.post(f"/wbedit/documents/{doc['id']}/pass",
                             json={"instruction": "Another instruction entirely."})
        assert second.status_code == 409, second.get_json()
        assert second.get_json()["running"] is True
    finally:
        release.set()
    _await_pass(client, doc["id"], first.get_json()["id"])

    # ...and the slot frees when it ends.
    third = client.post(f"/wbedit/documents/{doc['id']}/pass",
                        json={"instruction": "Rename Test Character 1 to Renamed Character 1."})
    assert third.status_code == 201
    # 🔴 AND IT IS AWAITED, OR THIS TEST LEAKS A LIVE PASS THREAD PAST ITS OWN END.
    #
    # Without this the test returned with `wbedit-<id>` still running, and that thread does not
    # hold a store — `_docs()` and `_passes()` read `paths.WBEDIT_DIR` AT CALL TIME. So the moment
    # `monkeypatch` restores that global, a still-running pass resolves to the REAL
    # `BASE_DIR / "wbedit"` and writes its records into the live install's document store, not
    # into the tmp_path it was born in. Meanwhile pytest deletes that tmp_path underneath it.
    #
    # ⚠️ `--dist loadfile` puts many FILES in one worker process, so the damage is not confined to
    # this file: the thread runs on into whatever test comes next, and `vault_store.configure()`
    # is process-global. This is the standing hypothesis for the intermittent
    # `test_verify_all_walks_routed_tops_not_the_whole_root` failure, and it was certainly the
    # shape of the `meta.json` PermissionError that 7ac4dcf fixed from the other side.
    _await_pass(client, doc["id"], third.get_json()["id"])


def test_no_model_loaded_is_a_503_and_no_pass_is_opened(client, monkeypatch):
    """Checks that no model loaded is a 503 and no pass is opened."""
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="k",
                                                    local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"model": ""})
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/pass", json={"instruction": "x"})
    assert r.status_code == 503
    assert client.get(f"/wbedit/documents/{doc['id']}").get_json()["passes"] == []


# ── review ───────────────────────────────────────────────────────────────────

def test_rejecting_a_proposal_keeps_it_out_of_the_revision(client, kobold_up):
    """Checks that rejecting a proposal keeps it out of the revision."""
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])
    client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/proposal/1/review",
                json={"review": "rejected"})
    r = client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/materialize")
    assert r.status_code == 400, "a rejected-only pass minted a revision"
    assert client.get(f"/wbedit/documents/{doc['id']}").get_json()["revisions"] == [0]


def test_a_hand_edit_in_review_is_what_gets_applied(client, kobold_up):
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])
    client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/proposal/1/review",
                json={"review": "edited", "edited": "Test User's own words."})
    client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/materialize")
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/1").get_json()
    assert rev["content"]["entries"]["0"]["content"] == "Test User's own words."


def test_a_bad_review_state_is_refused(client, kobold_up):
    doc = _import(client)
    p = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": "Rename Test Character 1 to Renamed Character 1."}).get_json()
    _await_pass(client, doc["id"], p["id"])
    r = client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/proposal/1/review",
                    json={"review": "sort-of"})
    assert r.status_code == 400


def test_the_model_route_reports_what_is_loaded(client, kobold_up):
    """§3.1 — the tab must show which model is actually loaded before a pass starts."""
    body = client.get("/wbedit/model").get_json()
    assert body["loaded"] is True and body["model"] == "koboldcpp/test-model"


def test_an_unreachable_kobold_is_reported_not_raised(client, monkeypatch):
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="", local=True))

    def boom(cfg):
        raise kobold.KoboldUnreachable("nothing answered")

    monkeypatch.setattr(kobold, "status", boom)
    body = client.get("/wbedit/model").get_json()
    assert body["loaded"] is False and "nothing answered" in body["error"]




def _card_naming(world, name="Test Character 2"):
    """A copy of `CARD` whose primary lorebook is `world` (empty string ⇒ no `world` key)."""
    card = json.loads(json.dumps(CARD))
    card["data"]["name"] = name
    if world:
        card["data"]["extensions"]["world"] = world
    return card


def _ids(client, **query):
    """Checks that ids."""
    r = client.get("/wbedit/documents", query_string=query)
    assert r.status_code == 200, r.get_json()
    return {row["id"] for row in r.get_json()["documents"]}


def test_importing_a_card_resolves_its_worldbook_name_to_that_books_id(client):
    """Checks that importing a card resolves its worldbook name to that books id."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    assert card["kind"] == "card"
    assert card["world_ref"] == "Sample World Book 1", "the name the card carried was not kept"
    assert card["world_id"] == book["id"], "the card was not linked to the book it names"
    assert book["world_id"] == "", "a worldbook must not be linked to itself"


def test_a_card_naming_a_book_we_do_not_hold_keeps_the_name_and_links_nothing(client):
    """An unavailable worldbook does not block card import or erase the name carried by the card."""
    card = _import(client, _card_naming("A Book We Have Never Held"), name="ignored")
    assert card["world_ref"] == "A Book We Have Never Held"
    assert card["world_id"] == "", "we linked a card to a book we do not hold"


def test_the_library_filters_the_cards_down_to_one_worldbook(client):
    """Filter by worldbook identity without changing the unfiltered roster."""
    guilds = _import(client)
    estuary = _import(client, {**BOOK, "name": "Sample World Book 8"})
    sterling = _import(client, _card_naming("Sample World Book 1", "Test Character 10"))
    quill = _import(client, _card_naming("Sample World Book 1", "Test Character 11"))
    rain = _import(client, _card_naming("Sample World Book 8", "Test Character 12"))
    stranger = _import(client, _card_naming("", "Stranger"))

    assert _ids(client, world=guilds["id"]) == {sterling["id"], quill["id"]}
    assert _ids(client, world=estuary["id"]) == {rain["id"]}
    # ...and no `?world=` is the library exactly as it was before this parameter existed.
    assert _ids(client) == {guilds["id"], estuary["id"], sterling["id"], quill["id"],
                            rain["id"], stranger["id"]}

    # 🔴 STILL METADATA ONLY. The filter reads a field already on the `Document` record; if it
    # ever starts opening revisions to answer "which book", the Library pays a decrypt per row.
    raw = client.get("/wbedit/documents",
                     query_string={"world": guilds["id"]}).get_data(as_text=True)
    assert "keeps her own counsel" not in raw and "lower wards" not in raw


def test_world_none_finds_the_cards_he_has_not_associated_yet(client):
    """Checks that an unlinked World Book view includes cards not yet associated with a book."""
    guilds = _import(client)
    linked = _import(client, _card_naming("Sample World Book 1", "Test Character 10"))
    unnamed = _import(client, _card_naming("", "Stranger"))
    unheld = _import(client, _card_naming("A Book We Have Never Held", "Wanderer"))

    unlinked = _ids(client, world=web_wbedit.UNLINKED)
    assert linked["id"] not in unlinked, "a linked card was offered as unassociated"
    assert {unnamed["id"], unheld["id"]} <= unlinked
    assert guilds["id"] in unlinked, "a book has no book of its own"


def test_the_world_filter_and_the_kind_filter_combine(client):
    """The two the Cards pane actually sends together. `kind` narrows to characters, `world`
    narrows to one book, and the pane is wrong if either is dropped when both are present."""
    guilds = _import(client)
    sterling = _import(client, _card_naming("Sample World Book 1", "Test Character 10"))
    stranger = _import(client, _card_naming("", "Stranger"))

    assert _ids(client, kind="card", world=guilds["id"]) == {sterling["id"]}
    assert _ids(client, kind="worldbook", world=guilds["id"]) == set(), \
        "a worldbook is never linked to a worldbook"
    # The combination the pane sends for "not associated yet" — the book drops out here, which is
    # the whole reason `kind` is sent with it.
    assert _ids(client, kind="card", world=web_wbedit.UNLINKED) == {stranger["id"]}


def test_an_unknown_world_id_is_an_empty_list_and_never_an_error(client):
    """A stale worldbook id returns an empty list; a locked vault remains a distinct 423 response."""
    _import(client)
    _import(client, _card_naming("Sample World Book 1", "Test Character 10"))
    for garbage in ("deadbeefdeadbeef", "../../etc/passwd", "' OR 1=1 --", "🙂"):
        assert _ids(client, world=garbage) == set(), f"{garbage!r} matched something"


def test_renaming_the_book_changes_the_name_the_exported_card_carries(client):
    """Store the link by id and resolve the current worldbook name at export time. Assert the exported PNG bytes."""
    from wbedit.formats import png_card

    book = _import(client)
    card = _import_png(client, _png_card(_card_naming("Sample World Book 1")))
    assert card["world_id"] == book["id"]

    r = client.post(f"/wbedit/documents/{book['id']}/rename", json={"name": "Sample World Book 7"})
    assert r.status_code == 200, r.get_json()

    out = client.get(f"/wbedit/documents/{card['id']}/export")
    assert out.status_code == 200 and out.mimetype == "image/png"
    doc, _key = png_card.read_card(out.data)
    assert doc["data"]["extensions"]["world"] == "Sample World Book 7", \
        "the export carried the book's OLD name — the link is a name, not an id"
    # ...and the focus rect that shares that `extensions` dict was not trampled on the way past.
    assert doc["data"]["extensions"]["taproom_avatar_focus"] == {"x": 0.1, "y": 0.2, "w": 0.5}
    # The filter survives the rename for the same reason the export does.
    assert _ids(client, kind="card", world=book["id"]) == {card["id"]}


def test_a_json_card_export_carries_the_current_book_name_too(client):
    """Resolve the current worldbook name for JSON exports as well as PNG exports."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    client.post(f"/wbedit/documents/{book['id']}/rename", json={"name": "Sample World Book 7"})

    r = client.get(f"/wbedit/documents/{card['id']}/export")
    assert r.status_code == 200 and r.mimetype == "application/json"
    assert json.loads(r.data.decode("utf-8"))["data"]["extensions"]["world"] == "Sample World Book 7"


def test_exporting_a_card_whose_book_is_gone_keeps_the_name_it_arrived_with(client):
    """If the referenced worldbook is missing, preserve the card’s original `world` value rather than exporting an empty association."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    assert card["world_id"] == book["id"]
    assert client.delete(f"/wbedit/documents/{book['id']}").status_code == 200

    r = client.get(f"/wbedit/documents/{card['id']}/export")
    assert r.status_code == 200, r.get_data(as_text=True)
    assert json.loads(r.data.decode("utf-8"))["data"]["extensions"]["world"] == "Sample World Book 1"


def test_a_corrupt_worldbook_record_does_not_take_the_cards_export_with_it(client, monkeypatch):
    """A corrupt referenced worldbook record does not prevent exporting the card or modify its contents."""
    from wbedit.store import StoreCorrupt

    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")

    real_get = web_wbedit.DocumentStore.get

    def get(self, doc_id):
        if doc_id == book["id"]:
            raise StoreCorrupt("meta.json: not valid JSON")
        return real_get(self, doc_id)

    monkeypatch.setattr(web_wbedit.DocumentStore, "get", get)
    r = client.get(f"/wbedit/documents/{card['id']}/export")
    assert r.status_code == 200, r.get_data(as_text=True)
    assert json.loads(r.data.decode("utf-8"))["data"]["extensions"]["world"] == "Sample World Book 1"


def test_an_unlinked_card_exports_exactly_as_it_arrived(client):
    """An unlinked card exports byte-for-byte without inventing an `extensions` field."""
    bare = json.loads(json.dumps(CARD))
    bare["data"].pop("extensions")
    card = _import(client, bare, name="ignored")
    assert card["world_ref"] == "" and card["world_id"] == ""

    out = json.loads(client.get(f"/wbedit/documents/{card['id']}/export").data.decode("utf-8"))
    assert "extensions" not in out["data"], "an `extensions` block was invented on export"
    assert out == bare, "the card did not come back out as it went in"

    unheld = _import(client, _card_naming("A Book We Have Never Held", "Wanderer"), name="x")
    back = json.loads(client.get(f"/wbedit/documents/{unheld['id']}/export").data.decode("utf-8"))
    assert back["data"]["extensions"]["world"] == "A Book We Have Never Held"


def test_export_does_not_write_the_resolved_name_into_the_stored_revision(client):
    """Export resolves renamed worldbooks at the boundary and leaves the stored revision unchanged."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    client.post(f"/wbedit/documents/{book['id']}/rename", json={"name": "Sample World Book 7"})

    out = client.get(f"/wbedit/documents/{card['id']}/export")
    assert json.loads(out.data.decode("utf-8"))["data"]["extensions"]["world"] == \
        "Sample World Book 7", "this test proves nothing unless the export really rewrote the name"

    rev = client.get(f"/wbedit/documents/{card['id']}/revision/0").get_json()
    assert rev["content"]["data"]["extensions"]["world"] == "Sample World Book 1", \
        "export edited the stored revision — a rename is now rewriting user cards"
    assert client.get(f"/wbedit/documents/{card['id']}").get_json()["revisions"] == [0], \
        "export minted a revision"




def test_the_card_can_be_pointed_at_a_book_vocalis_holds(client):
    """The forward half of the control: a card that named nothing gets a book."""
    book = _import(client)
    card = _import(client, _card_naming(""), name="ignored")
    assert card["world_id"] == "" and card["world_ref"] == ""

    r = client.post(f"/wbedit/documents/{card['id']}/world", json={"book": book["id"]})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["world_id"] == book["id"]
    # 🔴 BOTH HALVES. `world_ref` is what `link_orphan_cards` matches on; leaving it stale would
    # mean the record disagreed with itself the moment the book was renamed.
    assert r.get_json()["world_ref"] == "Sample World Book 1"
    assert r.get_json()["world_set"] is True
    assert _ids(client, kind="card", world=book["id"]) == {card["id"]}


def test_unassociating_a_card_sticks_and_the_export_stops_naming_the_book(client):
    """Checks that unassociating a card sticks and the export stops naming the book."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    assert card["world_id"] == book["id"]

    r = client.post(f"/wbedit/documents/{card['id']}/world", json={"book": ""})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["world_id"] == "" and r.get_json()["world_ref"] == ""

    out = json.loads(client.get(f"/wbedit/documents/{card['id']}/export").data.decode("utf-8"))
    assert out["data"]["extensions"]["world"] == "", \
        "the exported card still names the book he unlinked it from"
    # ...and it is now in the "associated with nothing" bucket the Cards pane filters on.
    assert _ids(client, kind="card", world=web_wbedit.UNLINKED) == {card["id"]}
    assert _ids(client, kind="card", world=book["id"]) == set()


def test_unassociating_survives_a_rename_of_the_book_it_was_unlinked_from(client):
    """Clearing both link fields prevents a later rename from restoring the association."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    client.post(f"/wbedit/documents/{card['id']}/world", json={"book": ""})

    # A rename BACK to the name the card used to carry is the sharpest form of the trap.
    client.post(f"/wbedit/documents/{book['id']}/rename", json={"name": "Something Else"})
    client.post(f"/wbedit/documents/{book['id']}/rename", json={"name": "Sample World Book 1"})

    assert client.get(f"/wbedit/documents/{card['id']}").get_json()["world_id"] == "", \
        "a rename re-linked a deliberately unassociated card"


def test_deleting_the_book_he_picked_does_not_arm_an_unlink_of_his_sillytavern_card(client):
    """Checks that deleting a selected book does not arm an unlink of its SillyTavern card."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    # Re-set it through the route, so the flag really is on before the book goes.
    r = client.post(f"/wbedit/documents/{card['id']}/world", json={"book": book["id"]})
    assert r.status_code == 200 and r.get_json()["world_set"] is True
    assert client.delete(f"/wbedit/documents/{book['id']}").status_code == 200

    doc = client.get(f"/wbedit/documents/{card['id']}").get_json()
    assert doc["world_id"] == "" and doc["world_set"] is False
    assert doc["world_ref"] == "Sample World Book 1", "the name that makes a re-import relink it was lost"
    out = json.loads(client.get(f"/wbedit/documents/{card['id']}/export").data.decode("utf-8"))
    assert out["data"]["extensions"]["world"] == "Sample World Book 1"

    from wbedit.store.documents import DocumentStore
    store = DocumentStore(paths.WBEDIT_DIR)
    assert store.world_out(store.get(card["id"])) is None, \
        "the send would have carried an unlink nobody asked for"


def test_the_world_route_refuses_anything_that_is_not_a_world_book(client):
    """Checks that the world route refuses anything that is not a world book."""
    other = _import(client, _card_naming("", "Test Character 10"), name="ignored")
    card = _import(client, _card_naming(""), name="ignored")

    r = client.post(f"/wbedit/documents/{card['id']}/world", json={"book": other["id"]})
    assert r.status_code == 400 and "not a world book" in r.get_json()["error"]
    assert client.post(f"/wbedit/documents/{card['id']}/world",
                       json={"book": "deadbeefdeadbeef"}).status_code == 404
    # A worldbook has no worldbook of its own, and saying so is not the same as ignoring it.
    book = _import(client)
    r = client.post(f"/wbedit/documents/{book['id']}/world", json={"book": ""})
    assert r.status_code == 400 and "character card" in r.get_json()["error"]
    # A body with no `book` key at all is a bug in the caller, not "unassociate".
    assert client.post(f"/wbedit/documents/{card['id']}/world", json={}).status_code == 400
    assert client.get(f"/wbedit/documents/{card['id']}").get_json()["world_set"] is False


def test_choosing_no_book_on_a_card_that_never_had_one_invents_no_key(client):
    """Checks that choosing no book on a card that never had one invents no key."""
    bare = json.loads(json.dumps(CARD))
    bare["data"].pop("extensions")
    card = _import(client, bare, name="ignored")

    r = client.post(f"/wbedit/documents/{card['id']}/world", json={"book": ""})
    assert r.status_code == 200 and r.get_json()["world_set"] is True

    out = json.loads(client.get(f"/wbedit/documents/{card['id']}/export").data.decode("utf-8"))
    assert out == bare, "an `extensions` block was invented by unassociating an unlinked card"

    from wbedit.store.documents import DocumentStore
    store = DocumentStore(paths.WBEDIT_DIR)
    assert store.world_out(store.get(card["id"])) == "", \
        "the send lost the instruction the export was right to keep out of the file"


def test_changing_the_world_book_mints_no_revision(client):
    """Changing link metadata does not rewrite the card content or mint a revision."""
    book = _import(client)
    card = _import(client, _card_naming(""), name="ignored")
    client.post(f"/wbedit/documents/{card['id']}/world", json={"book": book["id"]})
    client.post(f"/wbedit/documents/{card['id']}/world", json={"book": ""})

    doc = client.get(f"/wbedit/documents/{card['id']}").get_json()
    assert doc["revisions"] == [0] and doc["latest"] == 0


# ── Create new entries ───────────────────────────────────────────────────

def test_a_new_world_book_is_created_empty_and_marked_as_ours(client):
    """A new worldbook starts empty and is marked as created by this application."""
    r = client.post("/wbedit/books", json={"name": "Sample World Book 3"})
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["kind"] == "worldbook" and body["name"] == "Sample World Book 3"
    assert body["source"] == "new", "a book nobody uploaded must not claim it was uploaded"
    rev = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()
    assert rev["content"] == {"entries": {}}


def test_a_new_world_book_needs_a_name(client):
    assert client.post("/wbedit/books", json={}).status_code == 400
    assert client.post("/wbedit/books", json={"name": "   "}).status_code == 400


def test_adding_an_entry_mints_a_revision_the_editor_can_address(client):
    """Checks that adding an entry mints a revision the editor can address."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 3"}).get_json()
    r = client.post(f"/wbedit/documents/{book['id']}/entry", json={"comment": "Sample Entry 1"})
    assert r.status_code == 201, r.get_json()
    out = r.get_json()
    assert out["revision"] == 1 and out["locator"] == ["entries", "0", "content"]

    fields = client.get(f"/wbedit/documents/{book['id']}/fields"
                        f"?revision={out['revision']}").get_json()["fields"]
    assert [f["label"] for f in fields] == ["Sample Entry 1"], \
        "the new entry is not visible in the editor that just created it"
    assert fields[0]["mode"] == "normal"


def test_a_new_entry_is_never_born_blank(client):
    """Checks that a new entry is never born blank."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 3"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry", json={}).get_json()
    rev = client.get(f"/wbedit/documents/{book['id']}/revision/{out['revision']}").get_json()
    entry = rev["content"]["entries"]["0"]
    assert entry["content"].strip(), "a new entry was created with no content and is unreachable"
    fields = client.get(f"/wbedit/documents/{book['id']}/fields"
                        f"?revision={out['revision']}").get_json()["fields"]
    assert len(fields) == 1, "the entry exists on disk but the editor cannot see it"


def test_a_new_entry_carries_the_whole_sillytavern_key_set(client):
    """Checks that a new entry carries the whole sillytavern key set."""
    from wbedit.assemble import DEFAULTS
    book = client.post("/wbedit/books", json={"name": "Sample World Book 3"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry", json={"comment": "X"}).get_json()
    rev = client.get(f"/wbedit/documents/{book['id']}/revision/{out['revision']}").get_json()
    entry = rev["content"]["entries"]["0"]
    assert set(DEFAULTS) <= set(entry), f"missing {set(DEFAULTS) - set(entry)}"
    assert entry["uid"] == 0 and "displayIndex" in entry


def test_a_new_entry_uid_is_max_plus_one_and_never_a_count(client):
    """Checks that a new entry uid is max plus one and never a count."""
    gappy = {"entries": {
        "0": {"uid": 0, "key": ["a"], "comment": "First", "content": "A."},
        "7": {"uid": 7, "key": ["b"], "comment": "Seventh", "content": "B."},
    }}
    doc = _import(client, gappy, name="Gappy")
    out = client.post(f"/wbedit/documents/{doc['id']}/entry", json={"comment": "New"}).get_json()
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/{out['revision']}").get_json()
    entries = rev["content"]["entries"]
    assert out["uid"] == 8, f"uid {out['uid']} would have collided with a live entry"
    assert len(entries) == 3
    assert entries["0"]["content"] == "A." and entries["7"]["content"] == "B.", \
        "adding an entry overwrote an existing one"


def test_a_new_entry_is_born_at_the_BOOKS_priority_not_the_assemblers(client):
    """New entries use the priority appropriate for the destination book: imported-book entries retain SillyTavern’s default ordering."""
    imported = {"entries": {
        "0": {"uid": 0, "key": ["a"], "comment": "First", "content": "A.", "order": 100},
        "1": {"uid": 1, "key": ["b"], "comment": "Second", "content": "B.", "order": 100},
    }}
    doc = _import(client, imported, name="From SillyTavern")
    out = client.post(f"/wbedit/documents/{doc['id']}/entry", json={"comment": "Third"}).get_json()
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/{out['revision']}").get_json()
    assert rev["content"]["entries"]["2"]["order"] == 100, \
        "the new entry ranks below every entry already in the book"
    assert out["order"] == 100, "the route must say what priority it used — nothing else shows it"


def test_a_new_entry_in_an_assembled_book_keeps_that_books_order(client):
    """New entries in assembled books retain the ordering used by the existing entries."""
    assembled = {"entries": {
        "0": {"uid": 0, "key": ["a"], "comment": "First", "content": "A.", "order": 20},
        "1": {"uid": 1, "key": ["b"], "comment": "Second", "content": "B.", "order": 20},
    }}
    doc = _import(client, assembled, name="Assembled")
    out = client.post(f"/wbedit/documents/{doc['id']}/entry", json={}).get_json()
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/{out['revision']}").get_json()
    assert rev["content"]["entries"]["2"]["order"] == 20


def test_a_new_book_gets_sillytaverns_own_default_order(client):
    """Checks that a new book receives SillyTavern’s default order."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 3"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry", json={}).get_json()
    rev = client.get(f"/wbedit/documents/{book['id']}/revision/{out['revision']}").get_json()
    assert rev["content"]["entries"]["0"]["order"] == 100
    assert out["order"] == 100


def test_a_new_entry_is_born_at_depth_and_not_in_the_character_definitions(client):
    """New entries use the configured depth default rather than being inserted into character definitions, avoiding unnecessary prompt-prefix changes."""
    from wbedit.assemble import DEFAULTS
    from wbedit.formats.depthfix import DEFAULT_DEPTH, POS_AT_DEPTH
    assert DEFAULTS["position"] != POS_AT_DEPTH, (
        "the assembler fill was changed instead — that moves every book he compiles "
        "from chunks")
    book = client.post("/wbedit/books", json={"name": "Sample World Book 3"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry", json={"comment": "New"}).get_json()
    entry = client.get(f"/wbedit/documents/{book['id']}"
                       f"/revision/{out['revision']}").get_json()["content"]["entries"]["0"]
    assert entry["position"] == POS_AT_DEPTH, (
        "a new entry lands in the character definitions and thrashes the cache from turn one")
    assert entry["depth"] == DEFAULT_DEPTH, "depth is inert unless position is 4, and vice versa"


def test_a_section_chunk_file_refuses_a_new_entry(client):
    """Checks that a section chunk file refuses a new entry."""
    chunk = {"section": "A", "section_name": "A",
             "entries": [{"keys": ["k"], "comment": "One", "content": "Text."}]}
    doc = _import(client, chunk, name="Chunk")
    r = client.post(f"/wbedit/documents/{doc['id']}/entry", json={"comment": "New"})
    assert r.status_code == 400
    assert "assemble it first" in r.get_json()["error"]


# ── 7.4 / §9a.32 · the field that is not on the card yet ─────────────────────
#
# Include empty supported fields so users can set values that are not present in the card yet.

def _fields_of(client, doc_id, revision=0):
    r = client.get(f"/wbedit/documents/{doc_id}/fields?revision={revision}")
    assert r.status_code == 200, r.get_json()
    return {tuple(f["locator"]): f for f in r.get_json()["fields"]}


def test_a_card_field_with_no_text_is_offered_as_an_empty_row(client):
    doc = _import(client, CARD, name="Test Character 2")
    fields = _fields_of(client, doc["id"])
    sys_loc = ("data", "system_prompt")
    assert sys_loc in fields, "a field the card does not carry cannot be added from anywhere"
    assert fields[sys_loc]["empty"] is True and fields[sys_loc]["chars"] == 0
    # 🔴 NEVER TICKED. A pass over an empty field asks the model to rewrite text it was never
    # sent, and it answers — inventing the contract I13 exists to keep it away from.
    assert fields[sys_loc]["pass_default"] is False
    # …and a field that HAS text is untouched by any of this.
    assert fields[("data", "description")]["empty"] is False


def test_typing_into_an_empty_field_saves_it_as_a_first_value(client):
    """Checks that typing into an empty field saves it as a first value."""
    doc = _import(client, CARD, name="Test Character 2")
    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={
        "revision": 0,
        "edits": [{"locator": ["data", "system_prompt"], "text": "Answer only in character."}]})
    assert r.status_code == 201, r.get_json()
    # `/edit` answers with the new Revision itself, so the content is right here.
    n = r.get_json()["n"]
    assert r.get_json()["content"]["data"]["system_prompt"] == "Answer only in character."
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/{n}").get_json()
    assert rev["content"]["data"]["system_prompt"] == "Answer only in character."
    # It is an ordinary field from now on — text, not empty, and its own row.
    fields = _fields_of(client, doc["id"], n)
    assert fields[("data", "system_prompt")]["empty"] is False
    assert fields[("data", "system_prompt")]["chars"] == len("Answer only in character.")


def test_an_empty_field_left_empty_mints_no_revision(client):
    """Checks that an empty field left empty mints no revision."""
    doc = _import(client, CARD, name="Test Character 2")
    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={
        "revision": 0, "edits": [{"locator": ["data", "system_prompt"], "text": ""}]})
    assert r.status_code == 400 and "nothing changed" in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{doc['id']}").get_json()["latest"] == 0


def test_no_empty_row_is_offered_for_the_greetings_list(client):
    """Checks that no empty row is offered for the greetings list."""
    doc = _import(client, CARD, name="Test Character 2")
    fields = _fields_of(client, doc["id"])
    assert not [loc for loc in fields if "alternate_greetings" in loc]


def test_a_field_holding_a_structure_is_never_offered_as_an_empty_box(client):
    """Checks that a field holding a structure is never offered as an empty box."""
    weird = json.loads(json.dumps(CARD))
    weird["data"]["system_prompt"] = {"not": "a string"}
    doc = _import(client, weird, name="Weird")
    fields = _fields_of(client, doc["id"])
    assert ("data", "system_prompt") not in fields
    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={
        "revision": 0, "edits": [{"locator": ["data", "system_prompt"], "text": "x"}]})
    assert r.status_code == 400, "a structure was replaceable by a string"


def test_a_worldbook_gets_no_empty_rows_from_any_of_this(client):
    """The flag is `card_empty` and it reaches one collector. An entry is not a fixed field set —
    there is no list of keys a book "should" have — so there is nothing to offer."""
    doc = _import(client)
    fields = _fields_of(client, doc["id"])
    assert all(f["empty"] is False for f in fields.values())


# ── 7.3.20 · ⬆ Import entry ──────────────────────────────────────────────────
#
# This fixture models a response that wraps one requested entry in a compiled book container and
# includes extra fields the importer must preserve or ignore deliberately.
DEEPSEEK_ENTRY = {
    "uid": 18,
    "key": ["Test Character 5", "Test Character 5", "her mom"],
    "keysecondary": [],
    "comment": "Test Character 5",
    "content": "Test Character 5 is Test Character 8's mother, twenty-eight, a software engineer.",
    "constant": False, "vectorized": False, "selective": True, "selectiveLogic": 0,
    "order": 68, "position": 0, "disable": False, "probability": 100, "depth": 4,
    "outletName": "", "triggers": [], "matchCreatorNotes": False, "displayIndex": 18,
}


def _entry_file(doc, name="entry.json"):
    """The upload as the browser sends it: multipart, one part called `file`."""
    import io
    return {"file": (io.BytesIO(json.dumps(doc).encode("utf-8")), name)}


def test_importing_an_entry_merges_it_and_the_editor_can_see_it(client):
    """The whole feature in one pass: a file goes in, a revision comes out, and the entry is
    addressable by the editor that imported it — which is the only definition of "it worked"."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    r = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                    data=_entry_file({"entries": {"18": DEEPSEEK_ENTRY}}),
                    content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    out = r.get_json()
    assert out["added"] == 1 and out["revision"] == 1
    fields = client.get(f"/wbedit/documents/{book['id']}/fields"
                        f"?revision={out['revision']}").get_json()["fields"]
    assert [f["label"] for f in fields] == ["Test Character 5"]
    assert fields[0]["locator"] == out["locator"]


@pytest.mark.parametrize("wrapped", [True, False])
def test_an_entry_arrives_wrapped_in_a_book_or_on_its_own(client, wrapped):
    """Both are the same data and refusing either would be refusing it on a technicality. A model
    asked for "an entry" hands back the container about half the time."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    doc = {"entries": {"18": DEEPSEEK_ENTRY}} if wrapped else DEEPSEEK_ENTRY
    r = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                    data=_entry_file(doc), content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    rev = client.get(f"/wbedit/documents/{book['id']}"
                     f"/revision/{r.get_json()['revision']}").get_json()
    assert [e["comment"] for e in rev["content"]["entries"].values()] == ["Test Character 5"]


def test_an_imported_uid_is_reassigned_and_never_overwrites_a_live_entry(client):
    """An imported uid that collides with an existing entry is reassigned so existing content is never overwritten."""
    occupied = {"entries": {"18": {"uid": 18, "key": ["a"], "comment": "Occupied",
                                   "order": 100, "content": "Text that must survive."}}}
    doc = _import(client, occupied, name="Sample World Book 4")
    out = client.post(f"/wbedit/documents/{doc['id']}/entry/import",
                      data=_entry_file({"entries": {"18": DEEPSEEK_ENTRY}}),
                      content_type="multipart/form-data").get_json()
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/{out['revision']}").get_json()
    entries = rev["content"]["entries"]
    assert entries["18"]["content"] == "Text that must survive.", "the import overwrote his entry"
    assert out["uids"] == [{"from": 18, "to": 19}], out["uids"]
    # 🔴 THE CONTAINER KEY AND THE `uid` FIELD MUST AGREE. `iter_entries` yields the key and
    # `set_at` addresses through it, while `jobs()` reads the field — two rows, silently, if the
    # renumber only touches one of them.
    assert entries["19"]["uid"] == 19 and entries["19"]["comment"] == "Test Character 5"


def test_a_file_of_several_entries_lands_as_one_revision_with_distinct_uids(client):
    """A multi-entry import creates one revision and assigns a distinct uid to each entry."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    three = {"entries": {str(i): {"uid": 18, "key": ["k"], "comment": f"E{i}",
                                  "content": f"Body {i}."} for i in range(3)}}
    out = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                      data=_entry_file(three), content_type="multipart/form-data").get_json()
    assert out["added"] == 3 and out["revision"] == 1
    rev = client.get(f"/wbedit/documents/{book['id']}/revision/1").get_json()
    entries = rev["content"]["entries"]
    assert sorted(entries) == ["0", "1", "2"]
    assert sorted(e["comment"] for e in entries.values()) == ["E0", "E1", "E2"]
    assert len(client.get(f"/wbedit/documents/{book['id']}").get_json()["revisions"]) == 2


def test_an_imported_entry_keeps_its_own_fields_and_gains_the_missing_ones(client):
    """Checks that an imported entry keeps its own fields and gains the missing ones."""
    from wbedit.assemble import DEFAULTS
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                      data=_entry_file(DEEPSEEK_ENTRY),
                      content_type="multipart/form-data").get_json()
    entry = client.get(f"/wbedit/documents/{book['id']}"
                       f"/revision/{out['revision']}").get_json()["content"]["entries"]["0"]
    assert set(DEFAULTS) <= set(entry), f"missing {set(DEFAULTS) - set(entry)}"
    assert entry["outletName"] == "" and entry["triggers"] == []
    assert "matchCreatorNotes" in entry
    assert entry["order"] == 68
    assert entry["key"] == ["Test Character 5", "Test Character 5", "her mom"]


def test_an_entry_with_no_order_of_its_own_is_born_at_the_books_priority(client):
    """§9a.22's rule reaches this door too: an entry minted below its neighbors is the first one
    dropped when the World Info budget fills, silently."""
    imported = {"entries": {
        "0": {"uid": 0, "key": ["a"], "comment": "First", "content": "A.", "order": 100},
        "1": {"uid": 1, "key": ["b"], "comment": "Second", "content": "B.", "order": 100}}}
    doc = _import(client, imported, name="From SillyTavern")
    out = client.post(f"/wbedit/documents/{doc['id']}/entry/import",
                      data=_entry_file({"key": ["c"], "comment": "Third", "content": "C."}),
                      content_type="multipart/form-data").get_json()
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/{out['revision']}").get_json()
    assert rev["content"]["entries"]["2"]["order"] == 100
    assert out["order"] == 100


def test_an_imported_entry_keeps_its_own_position_but_a_silent_one_lands_at_depth(client):
    """Checks that an imported entry keeps its own position but a silent one lands at depth."""
    from wbedit.formats.depthfix import POS_AT_DEPTH
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    kept = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                       data=_entry_file({"comment": "Placed", "key": ["a"], "content": "A.",
                                         "position": 1}),
                       content_type="multipart/form-data").get_json()
    silent = client.post(f"/wbedit/documents/{book['id']}/entry/import"
                         f"?revision={kept['revision']}",
                         data=_entry_file({"comment": "Silent", "key": ["b"], "content": "B."}),
                         content_type="multipart/form-data").get_json()
    entries = client.get(f"/wbedit/documents/{book['id']}"
                         f"/revision/{silent['revision']}").get_json()["content"]["entries"]
    assert entries["0"]["position"] == 1, "the file said 1 and got something else back"
    assert entries["1"]["position"] == POS_AT_DEPTH


def test_an_imported_entry_with_no_keywords_is_flagged_rather_than_filed_quietly(client):
    """Checks that an imported entry with no keywords is flagged rather than filed quietly."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                      data=_entry_file({"comment": "Keyless", "content": "Body."}),
                      content_type="multipart/form-data").get_json()
    assert out["inert"] == 1
    fields = client.get(f"/wbedit/documents/{book['id']}"
                        f"/fields?revision={out['revision']}").get_json()["fields"]
    assert fields[0]["inert"] is True, "and the editor marks the row it made"


def test_an_entry_with_no_text_gets_the_placeholder_rather_than_being_invisible(client):
    """Checks that an entry with no text gets the placeholder rather than being invisible."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                      data=_entry_file({"comment": "Empty", "key": ["k"], "content": "   "}),
                      content_type="multipart/form-data").get_json()
    assert out["placeholders"] == 1
    fields = client.get(f"/wbedit/documents/{book['id']}"
                        f"/fields?revision={out['revision']}").get_json()["fields"]
    assert len(fields) == 1, "the entry exists on disk but the editor cannot see it"


def test_a_section_chunk_spelling_of_the_keys_is_understood(client):
    """`keys` is the section-chunk spelling and `key` is the compiled one. Left alone, an entry
    carrying only `keys` is keyless to SillyTavern — stored, shown, never fired."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    out = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                      data=_entry_file({"comment": "Chunky", "keys": ["ledger"],
                                        "content": "Body."}),
                      content_type="multipart/form-data").get_json()
    entry = client.get(f"/wbedit/documents/{book['id']}"
                       f"/revision/{out['revision']}").get_json()["content"]["entries"]["0"]
    assert entry["key"] == ["ledger"] and out["inert"] == 0


@pytest.mark.parametrize("payload,fragment", [
    (b"not json at all", "not a JSON file"),
    (b'{"spec": "chara_card_v2"}', "no entry in that file"),
    (b'{"entries": {}}', "no entry in that file"),
])
def test_a_file_that_is_not_an_entry_is_refused_with_a_reason(client, payload, fragment):
    """Checks that a file that is not an entry is refused with a reason."""
    import io
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    r = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                    data={"file": (io.BytesIO(payload), "x.json")},
                    content_type="multipart/form-data")
    assert r.status_code == 400, r.get_json()
    assert fragment in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{book['id']}").get_json()["latest"] == 0, \
        "a refused import still minted a revision"


def test_a_hostile_entry_file_is_refused_by_the_same_pass_every_other_door_runs(client):
    """Checks that a hostile entry file is refused by the same pass every other door runs."""
    import io
    book = client.post("/wbedit/books", json={"name": "Sample World Book 4"}).get_json()
    deep = {"comment": "Deep", "key": ["k"], "content": "Body."}
    node = deep
    for _ in range(500):
        node["d"] = {}
        node = node["d"]
    r = client.post(f"/wbedit/documents/{book['id']}/entry/import",
                    data={"file": (io.BytesIO(json.dumps(deep).encode("utf-8")), "deep.json")},
                    content_type="multipart/form-data")
    assert r.status_code == 400, r.get_json()
    assert "nests more than" in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{book['id']}").get_json()["latest"] == 0


def test_a_section_chunk_file_refuses_an_imported_entry_too(client):
    """Checks that a section chunk file refuses an imported entry too."""
    chunk = {"section": "A", "section_name": "A",
             "entries": [{"keys": ["k"], "comment": "One", "content": "Text."}]}
    doc = _import(client, chunk, name="Chunk")
    r = client.post(f"/wbedit/documents/{doc['id']}/entry/import",
                    data=_entry_file(DEEPSEEK_ENTRY), content_type="multipart/form-data")
    assert r.status_code == 400
    assert "assemble it first" in r.get_json()["error"]


def test_an_empty_world_book_can_never_be_sent_to_sillytavern(client):
    """Checks that an empty world book can never be sent to sillytavern."""
    book = client.post("/wbedit/books", json={"name": "Sample World Book 3"}).get_json()
    r = client.post(f"/wbedit/documents/{book['id']}/send", json={})
    assert r.status_code == 400, "an empty book was accepted for sending"
    assert "REPLACE" in r.get_json()["error"]

    # And it becomes sendable the moment it has something in it — the check is emptiness, not a
    # blanket refusal of books this product authored.
    from wbedit import push
    try:
        client.post(f"/wbedit/documents/{book['id']}/entry", json={"comment": "Sample Entry 1"})
        assert client.post(f"/wbedit/documents/{book['id']}/send", json={}).status_code == 200
    finally:
        # ⚠️ `push` IS A MODULE GLOBAL AND A SUCCESSFUL SEND LEAVES A JOB PENDING IN IT — a leak
        # here is a 409 in whichever test draws the next send.
        #
        # `push` is module-global; cancel the pending job so later tests in this worker start clean.
        push.cancel()


def test_the_prompt_revision_routes_serve_a_picker_and_a_restore(client):
    """Exercise prompt revision history through the routes used by the browser."""
    first = {"system": "Original.", "shots": [], "wrapper": "{instruction} {field}"}
    assert client.put("/wbedit/prompt", json=first).status_code == 200
    assert client.put("/wbedit/prompt", json={**first, "system": "Experiment."}).status_code == 200

    rows = client.get("/wbedit/prompt/revisions").get_json()["revisions"]
    assert [r["n"] for r in rows] == [0, 1]
    # Metadata only — the bodies are multi-KB each and a picker needs none of them.
    assert "system" not in rows[0]

    assert client.get("/wbedit/prompt/revision/0").get_json()["system"] == "Original."
    assert client.get("/wbedit/prompt/revision/99").status_code == 404

    back = client.post("/wbedit/prompt/rollback/0")
    assert back.status_code == 200
    assert back.get_json()["system"] == "Original."
    # 🔴 Appended, never rewound: restoring 0 while sitting on 1 gives 2.
    assert [r["n"] for r in client.get("/wbedit/prompt/revisions").get_json()["revisions"]] \
        == [0, 1, 2]
    assert client.get("/wbedit/prompt/revision/1").get_json()["system"] == "Experiment."


def test_a_prompt_restore_is_refused_while_a_pass_is_running(client, monkeypatch):
    """Checks that a prompt restore is refused while a pass is running."""
    client.put("/wbedit/prompt", json={"system": "One.", "shots": [], "wrapper": "{instruction} {field}"})

    class _Fake:
        done = False
        doc_id = "d1"
        pass_id = "p1"
    monkeypatch.setattr(web_wbedit, "_RUN", _Fake())
    assert client.post("/wbedit/prompt/rollback/0").status_code == 409


def test_reset_leaves_the_prompt_it_destroyed_in_the_picker(client):
    """Checks that reset leaves the prompt it destroyed in the picker."""
    client.put("/wbedit/prompt", json={"system": "An hour of tuning.", "shots": [],
                                       "wrapper": "{instruction} {field}"})
    assert client.delete("/wbedit/prompt").status_code == 200
    rows = client.get("/wbedit/prompt/revisions").get_json()["revisions"]
    assert len(rows) == 2, "the reset recorded nothing"
    assert client.get(f"/wbedit/prompt/revision/{rows[-1]['n']}").get_json()["system"] \
        == "An hour of tuning."


# ── §9a.11 / 7.5.19: a CHARACTER CARD created from nothing — the half that stayed parked ──────

def test_a_new_card_is_created_empty_and_marked_as_ours(client):
    """A newly created character card starts with empty fields and carries the application’s source marker."""
    r = client.post("/wbedit/cards", json={"name": "Test Character 2"})
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["kind"] == "card" and body["name"] == "Test Character 2"
    assert body["source"] == "new", "a card nobody imported must not claim it was imported"
    rev = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()
    assert rev["content"]["spec"] == "chara_card_v2"
    assert rev["content"]["spec_version"] == "2.0"
    assert rev["content"]["data"]["name"] == "Test Character 2"


def test_a_new_card_satisfies_sillytaverns_own_validator(client):
    """New cards include every required field, with values of the types expected by SillyTavern’s validator."""
    body = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    data = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()["content"]["data"]
    for field in ("name", "description", "personality", "scenario", "first_mes", "mes_example",
                  "creator_notes", "system_prompt", "post_history_instructions",
                  "alternate_greetings", "tags", "creator", "character_version", "extensions"):
        assert field in data, f"TavernCardValidator refuses a card without data.{field}"
    assert isinstance(data["alternate_greetings"], list)
    assert isinstance(data["tags"], list)
    assert isinstance(data["extensions"], dict)


def test_a_new_card_carries_no_flat_v1_aliases(client):
    """New V2 cards keep authored text only under `data`; flat aliases could trigger sensitive mismatch logging in SillyTavern."""
    content = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    rev = client.get(f"/wbedit/documents/{content['id']}/revision/0").get_json()["content"]
    for field in ("description", "personality", "scenario", "first_mes", "mes_example"):
        assert field not in rev, (
            f"a flat V1 `{field}` goes stale the moment he types, and the mismatch logs his text")


def test_new_card_starts_without_world_link(client):
    """A newly created card starts without a worldbook association; the separate roster view provides that relationship."""
    body = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    assert body["world_ref"] == "" and body["world_id"] == ""
    rev = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()
    assert "world" not in rev["content"]["data"].get("extensions", {})


def test_a_new_card_has_no_st_ref_so_the_first_send_creates_it(client):
    """Checks that a new card has no st ref so the first send creates it."""
    body = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    assert body["st_ref"] == ""


def test_a_new_card_needs_a_name(client):
    assert client.post("/wbedit/cards", json={}).status_code == 400
    assert client.post("/wbedit/cards", json={"name": "   "}).status_code == 400


def test_a_created_card_opens_with_fields_it_can_be_typed_into(client):
    """Checks that a created card opens with fields it can be typed into."""
    body = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    got = client.get(f"/wbedit/documents/{body['id']}/fields").get_json()
    labels = [f["label"] for f in got["fields"]]
    assert "description" in labels and "first_mes" in labels, labels
    for f in got["fields"]:
        assert f["empty"] is True and f["chars"] == 0, f["label"]
        assert f["pass_default"] is False, f["label"]


def test_a_created_card_can_be_typed_into_and_saved(client):
    """Checks that a created card can be typed into and saved."""
    body = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    r = client.post(f"/wbedit/documents/{body['id']}/edit",
                    json={"revision": 0,
                          "edits": [{"locator": ["data", "description"],
                                     "text": "Tall, and unimpressed."}]})
    assert r.status_code in (200, 201), r.get_json()
    rev = client.get(f"/wbedit/documents/{body['id']}/revision/1").get_json()
    assert rev["content"]["data"]["description"] == "Tall, and unimpressed."


# ── §9a.11 / 7.5.20: which world book a character uses, on the character ──────────────────────

def test_a_card_reports_the_world_book_it_is_linked_to(client):
    """The card pane reports the linked worldbook for a selected character."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    got = client.get(f"/wbedit/documents/{card['id']}").get_json()
    assert got["world_id"] == book["id"], "the card did not link to the book we just imported"
    assert got["world_name"] == "Sample World Book 1"
    assert got["world_held"] is True


def test_the_world_name_follows_a_RENAME_rather_than_the_card_s_frozen_copy(client):
    """Resolve the current worldbook name from the stored id instead of displaying the card’s stale imported name."""
    book = _import(client)
    card = _import(client, _card_naming("Sample World Book 1"), name="ignored")
    r = client.post(f"/wbedit/documents/{book['id']}/rename", json={"name": "Sample World Book 1 (2026)"})
    assert r.status_code == 200, r.get_json()

    got = client.get(f"/wbedit/documents/{card['id']}").get_json()
    assert got["world_name"] == "Sample World Book 1 (2026)", "the pane would show a name the send does not"
    assert got["world_held"] is True
    # ⚠️ And the card's own frozen copy is untouched — renaming a book must not mint a revision on
    # every card that points at it (§8.2).
    assert got["world_ref"] == "Sample World Book 1"


def test_a_card_naming_a_book_vocalis_does_not_hold_says_so(client):
    """Report that a card names an unavailable worldbook without implying that the library contains it."""
    card = _import(client, _card_naming("A Book We Never Imported"), name="ignored")
    got = client.get(f"/wbedit/documents/{card['id']}").get_json()
    assert got["world_id"] == "", "nothing to resolve against"
    assert got["world_name"] == "A Book We Never Imported"
    assert got["world_held"] is False


def test_a_card_with_no_world_reports_none(client):
    """A created card, which is the state §9a.11's new button mints."""
    card = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    got = client.get(f"/wbedit/documents/{card['id']}").get_json()
    assert got["world_name"] == "" and got["world_held"] is False


def test_a_worldbook_is_not_given_a_world_of_its_own(client):
    """A book has no such link, and a persona's lorebook is a different thing living in
    SillyTavern's own settings (§8.3). Neither may claim one."""
    book = _import(client)
    got = client.get(f"/wbedit/documents/{book['id']}").get_json()
    assert got["world_name"] == "" and got["world_held"] is False


# ── §9a.11 / 7.5.15: a persona created from nothing, and the empty fields that make it usable ──

def test_a_new_persona_is_created_empty_and_marked_as_ours(client):
    """A new persona starts with empty fields and carries the application’s source marker."""
    r = client.post("/wbedit/personas", json={"name": "Test User"})
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["kind"] == "persona" and body["name"] == "Test User"
    assert body["source"] == "new", "a persona nobody imported must not claim it was imported"
    rev = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()
    # 🔴 `spec` IS WHAT MAKES IT A PERSONA. `formats.doc_kind` checks that exact string — a card
    # has no field a persona lacks, so shape cannot separate them and the marker is the answer.
    assert rev["content"]["spec"] == "vocalis_persona_v1"
    assert rev["content"]["name"] == "Test User"


def test_a_new_persona_has_no_avatar_ref_to_collide_with_a_real_one(client):
    """Checks that a new persona has no avatar ref to collide with a real one."""
    body = client.post("/wbedit/personas", json={"name": "Test User"}).get_json()
    assert body["st_ref"] == ""
    rev = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()
    assert "avatar" not in rev["content"], "an invented avatar filename can collide with a real one"


def test_a_new_persona_needs_a_name(client):
    assert client.post("/wbedit/personas", json={}).status_code == 400
    assert client.post("/wbedit/personas", json={"name": "   "}).status_code == 400


def test_a_created_persona_opens_with_fields_it_can_be_typed_into(client):
    """Checks that a created persona opens with fields it can be typed into."""
    body = client.post("/wbedit/personas", json={"name": "Test User"}).get_json()
    got = client.get(f"/wbedit/documents/{body['id']}/fields").get_json()
    assert [f["label"] for f in got["fields"]] == ["description", "title"]
    for f in got["fields"]:
        assert f["empty"] is True and f["chars"] == 0
        # ⚠️ AND UNTICKED. An empty job handed to a model asks it to rewrite text it was never
        # given, and it will answer — inventing a self-description for the USER is a worse version
        # of the failure I13 exists to prevent.
        assert f["pass_default"] is False, f["label"]


def test_an_imported_persona_can_finally_be_given_a_title(client, tmp_path):
    """Persona title editing remains available when the imported descriptor does not contain a title."""
    doc = {"spec": "vocalis_persona_v1", "avatar": "user-1.png", "name": "Test User",
           "description": "Tall, and reads code fluently."}
    made = client.post("/wbedit/documents", json={"document": doc, "name": "Test User"}).get_json()
    got = client.get(f"/wbedit/documents/{made['id']}/fields").get_json()
    rows = {f["label"]: f for f in got["fields"]}
    assert set(rows) == {"description", "title"}
    assert rows["description"]["empty"] is False and rows["description"]["pass_default"] is True
    assert rows["title"]["empty"] is True

    r = client.post(f"/wbedit/documents/{made['id']}/edit",
                    json={"edits": [{"locator": ["title"], "text": "the one at the keyboard"}]})
    assert r.status_code == 201, r.get_json()   # /edit MINTS a revision, so 201, not 200
    latest = client.get(f"/wbedit/documents/{made['id']}").get_json()["revisions"][-1]
    rev = client.get(f"/wbedit/documents/{made['id']}/revision/{latest}").get_json()
    assert rev["content"]["title"] == "the one at the keyboard"
    assert rev["content"]["description"] == "Tall, and reads code fluently.", "the other field moved"


def test_a_pass_still_sees_nothing_to_invent_on_an_empty_persona(client):
    """Empty persona fields are excluded from model passes even when the editor displays them."""
    from wbedit import formats
    blank = {"spec": "vocalis_persona_v1", "name": "Test User"}
    assert formats.collect(blank, rel="x") == []
    assert [j.label for j in formats.collect(blank, rel="x", persona_empty=True)] \
        == ["description", "title"]
    # a real one is unchanged by the flag being available — only the MISSING title appears
    real = dict(blank, avatar="user-1.png", description="Tall.")
    assert [j.label for j in formats.collect(real, rel="x")] == ["description"]
    assert [j.label for j in formats.collect(real, rel="x", persona_empty=True)] \
        == ["description", "title"]
