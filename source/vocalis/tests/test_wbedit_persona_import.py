"""Tests persona import and export compatibility."""
from __future__ import annotations

import io
import json

import pytest

import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.formats import persona

# Markdown persona fixture with an H1 document title and prose whose section boundaries must be
# inferred by the importer.
SAMPLE_CHARACTER_MD = """# Test Character 4 — User Persona

**Pronunciation:** test character four. Test Character 4 **test character four**.

## Persona description (paste into SillyTavern's persona field)

Test Character 4. Human, thirty. Six feet, dark hair, dark eyes, a few days of stubble.

## Notes for the author

He is not humble and not impressed.
"""

#: What `⬇ Export` hands out: our own document, marker and all.
OURS = {
    "spec": persona.SPEC,
    "avatar": "test-user.png",
    "name": "Test User",
    "description": "A software engineer who reads code fluently.",
    "title": "The one at the keyboard",
    "position": 0, "depth": 4, "role": 0,
    "lorebook": "Sample World Book 1",
}

#: What another model writes when asked for "a persona as JSON": the fields, no marker.
FOREIGN = {"name": "Test Character 4", "description": "Human, thirty.", "title": "Sample Persona Title"}

CARD_V2 = {"spec": "chara_card_v2", "spec_version": "2.0",
           "data": {"name": "Test Character 2", "description": "A tall woman.", "first_mes": "You again."}}

CARD_V1 = {"name": "Test Character 2", "description": "A tall woman.", "first_mes": "You again."}

BOOK = {"name": "Sample World Book 1", "entries": {"0": {"uid": 0, "key": ["ledger"], "content": "x"}}}


# ── the format: what a file becomes ──────────────────────────────────────────

def test_our_own_export_comes_back_verbatim():
    """Checks that our own export comes back verbatim."""
    doc, prose = persona.from_upload(json.dumps(OURS), default_name="Test User")
    assert doc == OURS
    assert prose is False


def test_a_foreign_json_becomes_a_persona():
    doc, prose = persona.from_upload(json.dumps(FOREIGN), default_name="test-character-4")
    assert doc["spec"] == persona.SPEC
    assert doc["name"] == "Test Character 4"
    assert doc["description"] == "Human, thirty."
    assert doc["title"] == "Sample Persona Title"
    assert prose is False


def test_a_foreign_files_avatar_filename_is_dropped():
    """Checks that a foreign files avatar filename is dropped."""
    doc, _ = persona.from_upload(json.dumps({**FOREIGN, "avatar": "test-user.png"}))
    assert "avatar" not in doc


def test_machinery_survives_but_only_as_numbers():
    doc, _ = persona.from_upload(json.dumps({**FOREIGN, "position": 2, "depth": 4, "role": 1}))
    assert (doc["position"], doc["depth"], doc["role"]) == (2, 4, 1)
    # `bool` is an `int` in Python, and `position: true` is not a position.
    doc, _ = persona.from_upload(json.dumps({**FOREIGN, "position": True}))
    assert "position" not in doc


@pytest.mark.parametrize("doc,expected", [
    (CARD_V2, "character card"),
    (CARD_V1, "character card"),
    (BOOK, "World Book"),
    ([{"uid": 0}], "World Book"),
])
def test_somebody_elses_document_is_refused_by_name(doc, expected):
    """Checks that somebody elses document is refused by name."""
    with pytest.raises(persona.NotAPersona) as exc:
        persona.from_upload(json.dumps(doc), default_name="x")
    assert expected in str(exc.value)


def test_markdown_takes_its_name_from_the_heading_and_keeps_every_word():
    """Checks that markdown takes its name from the heading and keeps every word."""
    doc, prose = persona.from_upload(SAMPLE_CHARACTER_MD, default_name="Test Character 4-persona")
    assert prose is True
    assert doc["spec"] == persona.SPEC
    # `# Test Character 4 — User Persona` is a document TITLE; the persona is called Test Character 4.
    assert doc["name"] == "Test Character 4"
    assert doc["description"] == SAMPLE_CHARACTER_MD.strip()
    assert "Notes for the author" in doc["description"], "nothing was dropped on the floor"


def test_the_filename_names_a_document_with_no_heading():
    doc, _ = persona.from_upload("Just some prose about me.", default_name="Test Character 4-persona")
    assert doc["name"] == "Test Character 4"
    assert doc["description"] == "Just some prose about me."


def test_a_quoted_sentence_is_prose_and_not_a_json_scalar():
    """Checks that a quoted sentence is prose and not a json scalar."""
    doc, prose = persona.from_upload('"I am Test Character 4."', default_name="test-character-4")
    assert prose is True
    assert doc["description"] == '"I am Test Character 4."'


@pytest.mark.parametrize("text", ["", "   \n\n  "])
def test_an_empty_file_is_refused(text):
    with pytest.raises(persona.NotAPersona):
        persona.from_upload(text, default_name="test-character-4")


def test_a_nameless_file_says_what_to_do_about_it():
    with pytest.raises(persona.NotAPersona) as exc:
        persona.from_upload("prose with no heading", default_name="")
    assert "# Name" in str(exc.value)


def test_a_heading_that_is_only_a_document_title_falls_back_to_the_filename():
    """Checks that a heading that is only a document title falls back to the filename."""
    doc, _ = persona.from_upload("# — User Persona\n\nprose", default_name="test-character-4")
    assert doc["name"] == "test-character-4"


def test_a_heading_that_merely_contains_the_word_persona_is_left_alone():
    """The trim is narrow on purpose: only a trailing dash-separated segment. `# Persona` is a
    heading that says nothing else, and it is still the name the file gave."""
    doc, _ = persona.from_upload("# Persona\n\nprose", default_name="test-character-4")
    assert doc["name"] == "Persona"


# ── the route: what the door does with it ────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _upload(c, blob, filename, url="/wbedit/personas/import"):
    if isinstance(blob, str):
        blob = blob.encode("utf-8")
    return c.post(url, data={"file": (io.BytesIO(blob), filename)},
                  content_type="multipart/form-data")


def test_a_persona_json_imports_and_appears_in_the_library(client):
    r = _upload(client, json.dumps(FOREIGN), "test-character-4.json")
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["kind"] == "persona"
    assert body["name"] == "Test Character 4"
    assert body["avatar"] is False, "a persona document carries no picture — that is the next step"
    assert body["prose"] is False

    rows = client.get("/wbedit/documents?kind=persona").get_json()["documents"]
    assert [d["name"] for d in rows] == ["Test Character 4"]


def test_the_markdown_he_was_handed_imports_whole(client):
    r = _upload(client, SAMPLE_CHARACTER_MD, "Test Character 4-persona.md")
    assert r.status_code == 201, r.get_json()
    body = r.get_json()
    assert body["name"] == "Test Character 4"
    assert body["prose"] is True, "the toast has to be able to say the whole file went in"

    fields = client.get(f"/wbedit/documents/{body['id']}/fields").get_json()["fields"]
    described = [f for f in fields if f["label"] == "description"]
    assert described, "the description must be a field he can edit and trim"
    assert described[0]["chars"] == len(SAMPLE_CHARACTER_MD.strip())

    rev = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()
    assert "Notes for the author" in rev["content"]["description"], "nothing was dropped"


def test_the_editor_can_type_into_an_imported_persona(client):
    """Checks that the editor can type into an imported persona."""
    body = _upload(client, json.dumps(FOREIGN), "test-character-4.json").get_json()
    fields = client.get(
        f"/wbedit/documents/{body['id']}/fields?persona_empty=1").get_json()["fields"]
    assert {f["label"] for f in fields} == {"description", "title"}


def test_our_own_export_round_trips_everything_except_the_identity(client):
    """Checks that our own export round trips everything except the identity."""
    body = _upload(client, json.dumps(OURS), "Test User.json").get_json()
    rev = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()

    assert rev["content"] == {k: v for k, v in OURS.items() if k != "avatar"}
    assert "avatar" not in rev["content"], "a file does not get to name a persona in his install"
    assert body["st_ref"] == "", "and the Library says so, rather than showing a link it has not got"


@pytest.mark.parametrize("doc,filename,expected", [
    (CARD_V2, "Test Character 2.json", "Character Cards tab"),
    (BOOK, "Sample World Book 1.json", "World Books tab"),
])
def test_the_wrong_kind_of_file_names_the_tab_that_wants_it(client, doc, filename, expected):
    r = _upload(client, json.dumps(doc), filename)
    assert r.status_code == 400
    assert expected in r.get_json()["error"]
    assert not client.get("/wbedit/documents").get_json()["documents"], "and nothing was filed"


def test_a_png_is_refused_with_the_path_that_works(client):
    """Checks that a png is refused with the path that works."""
    r = _upload(client, b"\x89PNG\r\n\x1a\n" + b"\x00" * 32, "test-user.png")
    assert r.status_code == 400
    err = r.get_json()["error"]
    assert "New Persona" in err and "Upload PNG" in err


def test_a_cp1252_file_says_so_rather_than_lying_about_the_json(client):
    """Checks that a cp1252 file says so rather than lying about the json."""
    # ⚠️ `ensure_ascii=False` is what makes this a cp1252 file at all — the default escapes the
    # é to \\u00e9 and the bytes come out pure ASCII, which decodes as UTF-8 and proves nothing.
    blob = json.dumps({**FOREIGN, "description": "Café"}, ensure_ascii=False).encode("cp1252")
    r = _upload(client, blob, "test-character-4.json")
    assert r.status_code == 400
    assert "cp1252" in r.get_json()["error"]


def test_an_oversized_file_is_413_not_a_500(client):
    r = _upload(client, b"x" * (web_wbedit.MAX_UPLOAD + 1), "huge.md")
    assert r.status_code == 413


def test_no_file_at_all_is_a_400(client):
    r = client.post("/wbedit/personas/import", data={}, content_type="multipart/form-data")
    assert r.status_code == 400


def test_a_locked_vault_refuses_the_import(client, monkeypatch):
    """Checks that a locked vault refuses the import."""
    import vault_fs

    class Locked(Exception):
        pass

    monkeypatch.setattr(vault_fs, "locked_exc", lambda: Locked)
    # An import WRITES, so the seam is the revision write rather than the `stat` the read routes
    # trip over — patching the wrong one leaves the vault "locked" in name only and the test
    # passes on a route with no guard at all.
    monkeypatch.setattr(vault_fs, "write_json_atomic",
                        lambda *a, **k: (_ for _ in ()).throw(Locked()))
    monkeypatch.setattr(vault_fs, "mkdir", lambda *a, **k: (_ for _ in ()).throw(Locked()))
    r = _upload(client, json.dumps(FOREIGN), "test-character-4.json")
    assert r.status_code == 423, r.get_json()
    assert r.get_json()["locked"] is True


# ── the picture: a FIRST one, on a document that has none ────────────────────

PNG = (b"\x89PNG\r\n\x1a\n"
       b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde")


@pytest.mark.parametrize("kind,create", [
    ("persona", lambda c: c.post("/wbedit/personas", json={"name": "Test User"})),
    ("card", lambda c: c.post("/wbedit/cards", json={"name": "Test Character 2"})),
])
def test_a_document_with_no_picture_accepts_its_first_one(client, kind, create):
    """Checks that a document with no picture accepts its first one."""
    doc = create(client).get_json()
    assert doc["avatar"] is False
    assert client.get(f"/wbedit/documents/{doc['id']}/avatar").status_code == 404

    r = client.post(f"/wbedit/documents/{doc['id']}/avatar", data=PNG,
                    content_type="image/png")
    assert r.status_code == 201, r.get_json()

    got = client.get(f"/wbedit/documents/{doc['id']}/avatar")
    assert got.status_code == 200
    assert got.data == PNG, "stored verbatim — nothing in this path decodes the image"
    rows = client.get(f"/wbedit/documents?kind={kind}").get_json()["documents"]
    assert rows[0]["avatar"] is True


def test_an_imported_persona_accepts_a_picture_too(client):
    """Checks that an imported persona accepts a picture too."""
    body = _upload(client, SAMPLE_CHARACTER_MD, "Test Character 4-persona.md").get_json()
    r = client.post(f"/wbedit/documents/{body['id']}/avatar", data=PNG, content_type="image/png")
    assert r.status_code == 201, r.get_json()
    assert client.get(f"/wbedit/documents/{body['id']}/avatar").data == PNG


# ── Thumbnail cache invalidation when the source image changes ───────────

#: A second, DIFFERENT picture. Byte-different is all this needs: the ETag folds `(size, mtime)`.
PNG2 = PNG + b"\x00\x00\x00\x00IEND\xaeB`\x82"


def test_replacing_a_picture_is_not_served_from_a_five_minute_cache(client):
    """Checks that replacing a picture is not served from a five minute cache."""
    doc = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    client.post(f"/wbedit/documents/{doc['id']}/avatar", data=PNG, content_type="image/png")

    first = client.get(f"/wbedit/documents/{doc['id']}/avatar")
    assert first.status_code == 200
    assert "no-cache" in first.headers["Cache-Control"]
    assert "no-store" not in first.headers["Cache-Control"], (
        "no-store would re-download 700 KB on every open — the point is to revalidate, not to "
        "stop keeping the bytes")

    # The conditional request still works, which is what makes `no-cache` cheap.
    again = client.get(f"/wbedit/documents/{doc['id']}/avatar",
                       headers={"If-None-Match": first.headers["ETag"]})
    assert again.status_code == 304

    client.post(f"/wbedit/documents/{doc['id']}/avatar", data=PNG2, content_type="image/png")
    after = client.get(f"/wbedit/documents/{doc['id']}/avatar",
                       headers={"If-None-Match": first.headers["ETag"]})
    assert after.status_code == 200, "a replaced picture must not revalidate as unchanged"
    assert after.data == PNG2
    assert after.headers["ETag"] != first.headers["ETag"]


def test_the_roster_and_the_document_carry_the_pictures_stamp(client):
    """Checks that the roster and the document carry the pictures stamp."""
    doc = client.post("/wbedit/cards", json={"name": "Test Character 2"}).get_json()
    rows = client.get("/wbedit/documents?kind=card").get_json()["documents"]
    assert rows[0]["avatar"] is False and rows[0]["avatar_at"] == ""

    client.post(f"/wbedit/documents/{doc['id']}/avatar", data=PNG, content_type="image/png")
    one = client.get(f"/wbedit/documents/{doc['id']}").get_json()
    assert one["avatar"] is True and one["avatar_at"]
    # The ETag is built from the same pair, so the tag must contain the stamp verbatim.
    tag = client.get(f"/wbedit/documents/{doc['id']}/avatar").headers["ETag"]
    assert one["avatar_at"] in tag, (one["avatar_at"], tag)

    client.post(f"/wbedit/documents/{doc['id']}/avatar", data=PNG2, content_type="image/png")
    two = client.get(f"/wbedit/documents/{doc['id']}").get_json()
    assert two["avatar_at"] != one["avatar_at"], (
        "a replaced picture must change the URL — Chrome will not revalidate an <img> whose src "
        "has not changed, whatever the response header says")
    assert client.get("/wbedit/documents?kind=card").get_json()["documents"][0][
        "avatar_at"] == two["avatar_at"], "the roster and the document must agree"


@pytest.mark.parametrize("body,expect_name", [
    (json.dumps(FOREIGN), "Test Character 4"),
    (SAMPLE_CHARACTER_MD, "Test Character 4"),
])
def test_a_windows_byte_order_mark_does_not_change_what_the_file_is(client, body, expect_name):
    """Checks that a windows byte order mark does not change what the file is."""
    r = _upload(client, ("\ufeff" + body).encode("utf-8"), "test-character-4.json")
    assert r.status_code == 201, r.get_json()
    got = r.get_json()
    assert got["name"] == expect_name
    assert got["prose"] is (body is SAMPLE_CHARACTER_MD), "the BOM decided which road the file took"

    rev = client.get(f"/wbedit/documents/{got['id']}/revision/0").get_json()
    assert "\ufeff" not in json.dumps(rev["content"]), "the mark was stored in his text"
    assert '"name"' not in (rev["content"].get("description") or ""), (
        "a JSON document was imported as prose about itself")
