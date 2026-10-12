"""Tests text decoding and byte-preserving import behavior."""
from __future__ import annotations

import copy
import io
import json

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import kobold
import vocalis_server as vs
import vocalis.web.kobold as web_kobold
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit import pairing
from wbedit.core.contract import BEGIN, END, NOCHANGE
from wbedit.store import DocumentStore

#: Exercise punctuation, Cyrillic, Japanese, and an astral-plane character across UTF-8 paths.
HARD = ("Sample World Book 5 — polished, ambitious. "
        "She’d say “no”… Привет "
        "こんにちは \U0001F600")

EM_DASH_UTF8 = b"\xe2\x80\x94"
EM_DASH_DOUBLE = "—".encode("utf-8").decode("latin-1").encode("utf-8")

BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False, "content": HARD},
    },
}

CARD = {
    "spec": "chara_card_v2", "spec_version": "2.0",
    "data": {"name": "Test User", "description": HARD, "personality": "Wry.",
             "scenario": "Sample World Book 5.", "first_mes": "You again — hello.",
             "mes_example": "<START>", "extensions": {"world": "Sample World Book 5"}},
}


@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Both families on one app: `/pair/*` needs the settings file, `/wbedit/*` the store."""
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def auth(client):
    return {"Authorization": f"Bearer {pairing.rotate()}"}


# ── the store, and what it actually writes ───────────────────────────────────

def test_the_store_round_trips_the_hard_characters_code_point_for_code_point(store):
    doc, _ = store.import_from_st(copy.deepcopy(CARD), kind="card", st_ref="test-user.png",
                                  name="Test User", world_ref="Sample World Book 5")
    got = store.revision(doc.id, doc.latest).content["data"]["description"]
    assert got == HARD
    # Belt and braces: equality of `str` is equality of code points, but spell out the one
    # character the bug was reported on so a failure names it rather than dumping the sentence.
    assert "—" in got and "â" not in got


def test_the_revision_on_disk_is_utf8_and_not_double_encoded(store, tmp_path):
    """Checks that the revision on disk is utf8 and not double encoded."""
    doc, _ = store.import_from_st(copy.deepcopy(BOOK), kind="worldbook", st_ref="Sample World Book 1",
                                  name="Sample World Book 1", world_ref="")
    files = [p for p in (tmp_path / "wbedit").rglob("*.json") if p.is_file()]
    revs = [p for p in files if p.parent.name == "rev"]
    assert revs, "no revision file was written"

    raw = revs[0].read_bytes()
    raw.decode("utf-8")                      # raises UnicodeDecodeError if it is not valid UTF-8
    assert EM_DASH_UTF8 in raw, "the em dash is not stored as UTF-8"
    assert EM_DASH_DOUBLE not in raw, "the em dash was stored double-encoded — this is data loss"


# ── the two import routes ────────────────────────────────────────────────────

def test_an_import_from_sillytavern_round_trips_the_hard_characters(client, auth):
    """Checks that an import from sillytavern round trips the hard characters."""
    r = client.post("/pair/documents", json={"st_ref": "test-user.png", "document": CARD},
                    headers=auth)
    assert r.status_code == 201, r.get_json()
    doc_id, n = r.get_json()["id"], r.get_json()["revision"]

    content = client.get(f"/wbedit/documents/{doc_id}/revision/{n}").get_json()["content"]
    assert content["data"]["description"] == HARD
    assert content["data"]["first_mes"] == CARD["data"]["first_mes"]


def test_an_uploaded_document_round_trips_the_hard_characters(client):
    """The other door. A fix applied to one importer and not the other is the likely half-fix."""
    r = client.post("/wbedit/documents", json={"document": BOOK, "name": "Sample World Book 1"})
    assert r.status_code == 201, r.get_json()
    doc_id = r.get_json()["id"]

    content = client.get(f"/wbedit/documents/{doc_id}/revision/0").get_json()["content"]
    assert content["entries"]["0"]["content"] == HARD


def test_the_field_char_count_is_code_points_not_bytes(client):
    """Checks that the field char count is code points not bytes."""
    doc_id = client.post("/wbedit/documents",
                         json={"document": BOOK, "name": "Sample World Book 1"}).get_json()["id"]
    fields = client.get(f"/wbedit/documents/{doc_id}/fields").get_json()["fields"]
    assert [f["chars"] for f in fields] == [len(HARD)]
    assert len(HARD) < len(HARD.encode("utf-8")), "the fixture must actually be multi-byte"


# ── the PNG chunk, where a latin-1 decode is genuinely correct one line up ───

def test_a_png_card_chunk_round_trips_the_hard_characters():
    """Checks that a png card chunk round trips the hard characters."""
    import base64
    import struct
    import zlib

    from wbedit.formats import png_card

    def chunk(ctype: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + ctype + data
                + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))

    blob = png_card.PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    blob += chunk(b"tEXt", b"chara\x00" + base64.b64encode(json.dumps(CARD).encode("utf-8")))
    blob += chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b"")

    doc, key = png_card.read_card(blob)
    assert key == "chara"
    assert doc["data"]["description"] == HARD


def test_importing_a_png_card_over_http_keeps_the_hard_characters(client):
    import base64
    import struct
    import zlib

    from wbedit.formats import png_card

    def chunk(ctype: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + ctype + data
                + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))

    blob = png_card.PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    blob += chunk(b"tEXt", b"chara\x00" + base64.b64encode(json.dumps(CARD).encode("utf-8")))
    blob += chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b"")

    r = client.post("/wbedit/documents",
                    data={"file": (io.BytesIO(blob), "test-user.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    doc_id = r.get_json()["id"]

    content = client.get(f"/wbedit/documents/{doc_id}/revision/0").get_json()["content"]
    assert content["data"]["description"] == HARD


# ── and through a model pass, which is the seam with a second JSON hop ───────

class _FakeHTTPResponse:
    """Tests  fakehttpresponse behavior."""

    def __init__(self, payload: bytes):
        assert isinstance(payload, bytes)
        self._payload = payload
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self) -> bytes:
        return self._payload


@pytest.fixture
def kobold_em_dash(monkeypatch):
    """Checks that kobold em dash."""
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="k",
                                                    local=True))

    seen: dict[str, list] = {"requests": []}

    def _reply_for(path: str, body):
        if path.endswith("/api/v1/model"):
            return {"result": "koboldcpp/test-model"}
        field = body["messages"][-1]["content"].split("FIELD\n", 1)[1]
        if "—" not in field:
            return {"choices": [{"message": {"content": NOCHANGE}}]}
        out = field.replace("Sample World Book 5 — polished", "Sample World Book 6 — polished")
        return {"choices": [{"message": {
            "content": f"{BEGIN}\n{out}\n{END}\nMoved her to Sample World Book 6."}}]}

    def fake_urlopen(req, timeout=None, context=None):
        raw = req.data
        assert raw is None or isinstance(raw, bytes), \
            f"the request body reached the socket as {type(raw).__name__}, not bytes"
        body = None
        if raw is not None:
            # 🔴 The OUTBOUND half. `raw` is what `_request` produced; if it double-encoded on
            # the way out, the model would be asked to edit mojibake and would faithfully return
            # it — a corruption that round-trips its own corruption, which is precisely the class
            # of bug a string-level comparison cannot see.
            assert EM_DASH_DOUBLE not in raw, "the request body left double-encoded"
            body = json.loads(raw.decode("utf-8"))
            seen["requests"].append(raw)
        payload = json.dumps(_reply_for(req.full_url, body), ensure_ascii=False).encode("utf-8")
        seen.setdefault("replies", []).append(payload)
        return _FakeHTTPResponse(payload)

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return seen


def test_a_pass_stores_the_model_reply_with_its_em_dashes_intact(client, kobold_em_dash):
    """Checks that a pass stores the model reply with its em dashes intact."""
    import threading

    doc_id = client.post("/wbedit/documents",
                         json={"document": BOOK, "name": "Sample World Book 1"}).get_json()["id"]
    p = client.post(f"/wbedit/documents/{doc_id}/pass",
                    json={"instruction": "Move her to Sample World Book 6."})
    assert p.status_code == 201, p.get_json()
    pass_id = p.get_json()["id"]

    # The route starts the worker (named `wbedit-<pass id>`) before it answers 201, so joining it
    # is the completion signal; a thread no longer listed has already ended.
    for t in threading.enumerate():
        if t.name == f"wbedit-{pass_id}":
            t.join(15.0)
            assert not t.is_alive(), "the pass never finished"
    body = client.get(f"/wbedit/pass/{doc_id}/{pass_id}").get_json()
    assert body["status"] == "done", body

    assert client.post(f"/wbedit/pass/{doc_id}/{pass_id}/materialize").status_code == 201
    content = client.get(f"/wbedit/documents/{doc_id}/revision/1").get_json()["content"]
    got = content["entries"]["0"]["content"]
    assert "Sample World Book 6 — polished" in got, got
    assert "â" not in got, "the model's reply came back mojibake"
    assert got == HARD.replace("Sample World Book 5 — polished", "Sample World Book 6 — polished")

    # 🔴 THE STUB HAS TO HAVE BEEN LOAD-BEARING. If nothing ever reached the socket the four
    # assertions above are about a pass that never ran a request, which is the failure mode this
    # whole fixture was rewritten to escape.
    chats = [r for r in kobold_em_dash["requests"] if b"messages" in r]
    assert chats, "no chat request reached the transport — the stub was never exercised"

    # 📌 OUTBOUND, `json.dumps` DEFAULTS TO `ensure_ascii=True`, so the em dash leaves as the
    # seven ASCII bytes `—` rather than as `e2 80 94`. That is correct and it is why the
    # reported corruption cannot originate on this half: assert the code point survives the
    # round trip rather than asserting which spelling the serializer chose.
    sent = [json.loads(r.decode("utf-8"))["messages"][-1]["content"] for r in chats]
    assert any("—" in s for s in sent), "the field reached the model without its em dash"
    assert not any("â" in s for s in sent), "the field left this process already mojibake"

    # 🔴 INBOUND IS THE HALF THAT CAN BREAK, and it can only break if the bytes coming back are
    # genuinely multi-byte. `ensure_ascii=False` in the fixture is what makes that true; without
    # it `resp.read().decode(<anything latin-1-ish>)` would produce the right string anyway and
    # this test would be the vacuous one again.
    assert any(EM_DASH_UTF8 in p for p in kobold_em_dash["replies"]), \
        "the reply never carried raw UTF-8 — ensure_ascii=False was lost and this test is vacuous"
