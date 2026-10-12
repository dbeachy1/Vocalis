"""Tests the HTTP contract for uploading and assembling World Book chunks."""
from __future__ import annotations

import io
import json

import pytest

from conftest import REPO_ROOT, lock_the_vault  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


def chunk(section="A", name="Core", entries=None):
    return {"section": section, "section_name": name, "entries": entries or []}


def entry(eid="A1", keys=("thing",), content="A thing exists in the world.", **kw):
    e = {"id": eid, "comment": f"{eid} — a thing", "keys": list(keys), "content": content}
    e.update(kw)
    return e


GOOD = [("A_core.json", chunk("A", "Core", [entry("A1")])),
        ("B_places.json", chunk("B", "Places", [entry("B1", keys=("estuary",),
                                                     content="The rains come off it.")]))]


def _post(client, files, **form):
    """Multipart, the way a browser's multi-file picker sends it."""
    data = {"files": [(io.BytesIO(json.dumps(doc).encode("utf-8")), fn) for fn, doc in files]}
    data.update(form)
    return client.post("/wbedit/assemble", data=data, content_type="multipart/form-data")


# ── the happy path, and where the result lands ───────────────────────────────

def test_chunks_assemble_into_a_new_library_document(client):
    r = _post(client, GOOD)
    assert r.status_code == 201, r.get_data(as_text=True)
    body = r.get_json()
    assert body["kind"] == "worldbook"
    assert body["source"] == "upload"
    assert body["report"]["entries"] == 2
    assert body["report"]["errors"] == []

    # It is in the library, readable, and holds what was assembled.
    listed = client.get("/wbedit/documents").get_json()["documents"]
    assert [d["id"] for d in listed] == [body["id"]]
    content = client.get(f"/wbedit/documents/{body['id']}/revision/0").get_json()["content"]
    assert len(content["entries"]) == 2


def test_the_form_name_wins_over_the_configs_world_name(client):
    """The Library displays the name submitted with this request."""
    files = [("build-config.json", {"world_name": "From the config"})] + GOOD
    assert _post(client, files).get_json()["name"] == "From the config"
    assert _post(client, files, name="  What Test User typed  ").get_json()["name"] == "What Test User typed"


def test_an_absurd_name_is_clamped_rather_than_stored(client):
    """`MAX_NAME` is 200. An unclamped name reaches the Library list, the send plan and the log."""
    r = _post(client, GOOD, name="n" * 5000)
    assert r.status_code == 201
    assert len(r.get_json()["name"]) == web_wbedit.MAX_NAME


def test_a_rebuild_is_a_NEW_DOCUMENT_and_never_a_revision(client):
    """Checks that a rebuild is a new document and never a revision."""
    first = _post(client, GOOD).get_json()
    second = _post(client, GOOD).get_json()
    assert first["id"] != second["id"], "a rebuild landed on the existing document"
    assert second["latest"] == 0, "a rebuild minted a revision instead of a document"
    assert len(client.get("/wbedit/documents").get_json()["documents"]) == 2


def test_the_server_sorts_by_filename_whatever_order_the_browser_sent(client):
    """Checks that the server sorts by filename whatever order the browser sent."""
    forward = _post(client, GOOD).get_json()
    backward = _post(client, list(reversed(GOOD))).get_json()

    def uids(doc):
        c = client.get(f"/wbedit/documents/{doc['id']}/revision/0").get_json()["content"]
        return [(e["uid"], e["comment"]) for e in c["entries"].values()]

    assert uids(forward) == uids(backward), "upload order changed the uid assignment"


# ── 400: the four ways a request is refused before the assembler sees it ─────

def test_no_files_is_a_400_and_says_so(client):
    r = client.post("/wbedit/assemble", data={}, content_type="multipart/form-data")
    assert r.status_code == 400
    assert r.get_json()["error"] == "no files"


def test_a_file_that_is_not_json_is_a_400_that_NAMES_IT(client):
    """Include the failing filename so a multi-file upload can be corrected directly."""
    data = {"files": [(io.BytesIO(b"{not json at all"), "C_broken.json"),
                      (io.BytesIO(json.dumps(GOOD[0][1]).encode()), "A_core.json")]}
    r = client.post("/wbedit/assemble", data=data, content_type="multipart/form-data")
    assert r.status_code == 400
    assert "C_broken.json" in r.get_json()["error"]


def test_a_file_that_is_not_utf8_is_a_400_not_a_500(client):
    """A JSON file saved as cp1252 is an ordinary user mistake, and `.decode("utf-8")` raising
    `UnicodeDecodeError` out of a route is a 500 with a traceback and no filename."""
    data = {"files": [(io.BytesIO(b'{"section": "A", "entries": [], "name": "\xe9\xe8"}'),
                       "A_latin1.json")]}
    r = client.post("/wbedit/assemble", data=data, content_type="multipart/form-data")
    assert r.status_code == 400
    assert "A_latin1.json" in r.get_json()["error"]


def test_chunks_that_do_not_validate_are_a_400_carrying_the_ERRORS(client):
    """Checks that chunks that do not validate are a 400 carrying the errors."""
    bad = [("A_core.json", chunk("A", "Core", [entry("A1", keys=(), content="")]))]
    r = _post(client, bad)
    assert r.status_code == 400, r.get_data(as_text=True)
    body = r.get_json()
    assert body["error"] == "the chunks did not validate"
    assert body["errors"], "a validation failure arrived with no errors in it"
    assert isinstance(body["errors"], list)
    assert not client.get("/wbedit/documents").get_json()["documents"], \
        "a book was filed despite failing validation"


def test_a_chunk_of_the_wrong_SHAPE_is_a_400_and_not_a_500(client):
    """Checks that a chunk of the wrong shape is a 400 and not a 500."""
    r = _post(client, [("A_core.json", ["not", "a", "chunk"])])
    assert r.status_code == 400, r.get_data(as_text=True)
    assert r.get_json()["errors"], "the shape failure carried no explanation"


# ── 413: the two ceilings ────────────────────────────────────────────────────

def test_one_oversized_file_is_a_413(client, monkeypatch):
    monkeypatch.setattr(web_wbedit, "MAX_UPLOAD", 512)
    big = chunk("A", "Core", [entry("A1", content="x" * 2000)])
    r = _post(client, [("A_core.json", big)])
    assert r.status_code == 413
    assert r.get_json()["error"] == "upload too large"


def test_many_small_files_that_add_up_are_a_413(client, monkeypatch):
    """Checks that many small files that add up are a 413."""
    monkeypatch.setattr(web_wbedit, "MAX_UPLOAD", 1024)
    one = chunk("A", "Core", [entry("A1", content="x" * 700)])
    files = [(f"{chr(65 + i)}_part.json", one) for i in range(12)]
    r = _post(client, files)
    assert r.status_code == 413
    assert r.get_json()["error"] == "upload too large"
    assert not client.get("/wbedit/documents").get_json()["documents"]


# ── the vault ────────────────────────────────────────────────────────────────

def test_a_locked_vault_is_a_423_and_never_a_500(client, monkeypatch):
    """Checks that a locked vault is a 423 and never a 500."""
    lock_the_vault(monkeypatch)
    r = _post(client, GOOD)
    assert r.status_code == 423, r.get_data(as_text=True)
    assert r.get_json()["locked"] is True
