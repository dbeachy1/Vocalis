"""Tests validation of malformed, oversized, and adversarial input."""
from __future__ import annotations

import base64
import copy
import io
import json
import math
import struct
import time
import zlib

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit import assemble as wb
from wbedit import formats
from wbedit.formats import detect, png_card, validate


# ── real bytes, built here rather than committed ─────────────────────────────

def _chunk(ctype: bytes, data: bytes) -> bytes:
    """One PNG chunk: length, 4-byte type, data, CRC. `ctype` is BYTES, deliberately — 4.1 is
    about a type that is not decodable as ASCII, so this helper must be able to write one."""
    return (struct.pack(">I", len(data)) + ctype + data
            + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))


def _png(extra=()) -> bytes:
    """A structurally real PNG: signature, IHDR, the extras, IDAT, IEND."""
    body = png_card.PNG_SIGNATURE + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    for ctype, data in extra:
        body += _chunk(ctype, data)
    return body + _chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + _chunk(b"IEND", b"")


def _text_chunk(key: str, payload: bytes) -> tuple[bytes, bytes]:
    """A `tEXt` chunk carrying an ALREADY-ENCODED base64 payload — so a test can put something
    in it that `json.dumps` would never produce."""
    return b"tEXt", key.encode("ascii") + b"\x00" + payload


def _card_chunk(key: str, doc) -> tuple[bytes, bytes]:
    return _text_chunk(key, base64.b64encode(json.dumps(doc).encode("utf-8")))


CARD = {"spec": "chara_card_v2", "spec_version": "2.0",
        "data": {"name": "Test Character 2", "description": "A tall woman.", "first_mes": "You again."}}

BOOK = {"entries": {"0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1",
                          "content": "It records every debt."}}}

#: An unpaired surrogate. Legal in a JSON *document* (`"\\ud800"` is six ASCII characters on the
#: wire) and legal in a Python `str` — and impossible to encode as UTF-8, which is what every
#: writer in the store ends in.
LONE_SURROGATE = "\ud800"


def _deep(levels: int):
    """A structure `levels` deep, parsed from real JSON text rather than built by hand — the
    review's point is that `json.loads` accepts far more than anything downstream survives."""
    return json.loads("[" * levels + "]" * levels)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _nothing_was_written(root) -> None:
    """Checks that nothing was written."""
    if not root.exists():
        return
    parts = sorted(str(p) for p in root.rglob("*.part"))
    assert not parts, f"a temp file was left behind by a failed import: {parts}"
    docs = root / "documents"
    made = sorted(p.name for p in docs.iterdir()) if docs.exists() else []
    assert not made, f"an orphan document directory was left behind: {made}"


# ── 4.1 · a chunk type with a byte ≥ 0x80 ────────────────────────────────────

def test_a_chunk_type_with_a_high_byte_survives_a_read_and_every_export():
    """Checks that a chunk type with a high byte survives a read and every export."""
    blob = _png([(b"\xd0ATA", b"a private chunk"), _card_chunk("chara", CARD)])

    types = [c for c, _ in png_card.chunks(blob)]
    assert "\xd0ATA" in types, "the chunk type did not round-trip through the decode"

    out = png_card.write_card(blob, CARD)          # this is the line that used to raise
    assert b"\xd0ATA" + b"a private chunk" in out, \
        "the foreign chunk was dropped or its type was mangled on the way out"
    assert png_card.read_card(out)[0]["data"]["name"] == "Test Character 2"


# ── 4.2 · bounded depth ──────────────────────────────────────────────────────

def test_the_gap_between_what_json_accepts_and_what_deepcopy_survives():
    """Checks that the gap between what json accepts and what deepcopy survives."""
    assert isinstance(_deep(500), list), "json.loads refused 500 levels — the premise has changed"
    with pytest.raises(RecursionError):
        copy.deepcopy(_deep(500))


def test_a_deeply_nested_card_is_refused_at_the_door():
    doc = copy.deepcopy(CARD)
    doc["data"]["extensions"] = {"whatever": _deep(500)}
    assert detect.doc_kind(doc) is None, "a document nothing downstream can copy is not a card"
    with pytest.raises(png_card.NoCardInPng):
        png_card.read_card(_png([_card_chunk("chara", doc)]))


def test_an_ordinarily_nested_document_is_not_caught_by_the_depth_bound():
    """Checks that an ordinarily nested document is not caught by the depth bound."""
    doc = copy.deepcopy(CARD)
    doc["data"]["extensions"] = {"vendor": _deep(12)}
    assert detect.doc_kind(doc) == "card"
    assert png_card.read_card(_png([_card_chunk("chara", doc)]))[1] == "chara"


def test_the_deep_card_never_reaches_the_library(client, tmp_path):
    doc = copy.deepcopy(CARD)
    doc["data"]["extensions"] = {"whatever": _deep(500)}
    r = client.post("/wbedit/documents", json={"document": doc, "name": "deep"})
    assert 400 <= r.status_code < 500, r.status_code
    assert client.get("/wbedit/documents").get_json()["documents"] == []
    _nothing_was_written(tmp_path / "wbedit")


# ── 4.3 · a shape check on `entries` ─────────────────────────────────────────

@pytest.mark.parametrize("entries", ["hello", 5, None, True])
def test_a_document_whose_entries_is_not_a_collection_is_not_a_worldbook(entries):
    """Checks that a document whose entries is not a collection is not a worldbook."""
    assert detect.doc_kind({"entries": entries}) is None


@pytest.mark.parametrize("entries", [{}, [], {"0": {"content": "x"}}, [{"content": "x"}]])
def test_a_real_entries_collection_is_still_a_worldbook(entries):
    """The control. Both shapes are real (§4.2: a compiled book is a dict, a section chunk is a
    list) and an empty one is what `POST /wbedit/books` creates."""
    assert detect.doc_kind({"entries": entries}) == "worldbook"


def test_a_string_entries_book_is_refused_rather_than_filed(client, tmp_path):
    r = client.post("/wbedit/documents", json={"document": {"entries": "hello"}, "name": "b"})
    assert r.status_code == 400, r.get_json()
    assert client.get("/wbedit/documents").get_json()["documents"] == []
    _nothing_was_written(tmp_path / "wbedit")


# ── 4.4 · every hostile upload is an AssemblyFailed ──────────────────────────

def _section(**kw):
    sec = {"section": "A", "section_name": "Core",
           "entries": [{"id": "A1", "comment": "A1", "keys": ["thing"], "content": "text"}]}
    sec.update(kw)
    return sec


#: 🔴 THE SEVEN SHAPES THE REVIEW COUNTED, each one a raw exception out of `validate()` that
#: `POST /wbedit/assemble` never caught — it catches `AssemblyFailed` and nothing else.
HOSTILE_CONFIGS = {
    "chars_per_token is zero": {"chars_per_token": 0},                    # ZeroDivisionError
    "chars_per_token is a string": {"chars_per_token": "four"},           # TypeError
    "limits is a string": {"limits": "none"},                             # AttributeError
    "a limit is a string": {"limits": {"standard": "900"}},               # TypeError on >
    "noisy_keys is a number": {"noisy_keys": 5},                          # TypeError, not iterable
    "constant_token_budget is a string": {"constant_token_budget": "lots"},  # TypeError on >
    "wi_budget_tokens is null": {"wi_budget_tokens": None},               # TypeError on >
    # ⚠️ The quiet one: a string IS iterable, so this never crashed — it made every LETTER a
    # high-frequency key and buried the report in warnings about 'l', 'e', 'd'.
    "noisy_keys is a string": {"noisy_keys": "ledger"},
    "the config is not an object": [1, 2, 3],
}


@pytest.mark.parametrize("name", sorted(HOSTILE_CONFIGS))
def test_a_hostile_build_config_is_an_assembly_error_not_a_crash(name):
    with pytest.raises(wb.AssemblyFailed) as exc:
        wb.assemble([("A_core.json", _section())], config=HOSTILE_CONFIGS[name])
    assert exc.value.errors and wb.CONFIG_NAME in exc.value.errors[0], \
        "the message must name the file the user has to fix"


#: The same failure one file over — the section chunks themselves. Not in the review's count of
#: seven; found while fixing them, and reachable from the identical upload.
HOSTILE_SECTIONS = {
    "keys is not a list": _section(entries=[{"id": "a", "comment": "c", "keys": "k",
                                             "content": "x"}]),
    "key is not a list": _section(entries=[{"id": "a", "comment": "c", "key": 5,
                                            "content": "x"}]),
    "group is a list": _section(entries=[{"id": "a", "comment": "c", "keys": ["k"],
                                          "content": "x", "group": ["g"]}]),
    "class is a list": _section(entries=[{"id": "a", "comment": "c", "keys": ["k"],
                                          "content": "x", "class": ["constant"]}]),
    "id is a list": _section(entries=[{"id": ["a"], "comment": "c", "keys": ["k"],
                                       "content": "x"}]),
    "entry_limit is a string": _section(entry_limit="40"),
    "an entry is not an object": _section(entries=["hello"]),
}


@pytest.mark.parametrize("name", sorted(HOSTILE_SECTIONS))
def test_a_hostile_section_chunk_is_an_assembly_error_not_a_crash(name):
    with pytest.raises(wb.AssemblyFailed) as exc:
        wb.assemble([("A_core.json", copy.deepcopy(HOSTILE_SECTIONS[name]))])
    assert exc.value.errors, "AssemblyFailed must carry the errors the pane renders"


def test_an_ordinary_int_id_or_group_still_builds():
    """Checks that an ordinary int id or group still builds."""
    book, report = wb.assemble([("A_core.json", _section(
        entries=[{"id": 1, "comment": "one", "keys": ["k"], "content": "x", "group": 3}]))])
    assert report.entries == 1 and book["entries"]["0"]["group"] == 3


def _upload(client, files: dict, name="Assembled"):
    data = {"files": [(io.BytesIO(json.dumps(doc).encode("utf-8")), fname)
                      for fname, doc in files.items()], "name": name}
    return client.post("/wbedit/assemble", data=data, content_type="multipart/form-data")


def test_the_assemble_route_answers_400_with_a_message(client, tmp_path):
    """Checks that the assemble route answers 400 with a message."""
    r = _upload(client, {"A_core.json": _section(), "build-config.json": {"chars_per_token": 0}})
    assert r.status_code == 400, r.status_code
    body = r.get_json()
    assert body["errors"] and "chars_per_token" in body["errors"][0]
    _nothing_was_written(tmp_path / "wbedit")


def test_a_legitimate_assemble_still_lands_in_the_library(client):
    """The control for the whole of 4.4: the guards must not have broken the feature."""
    r = _upload(client, {"A_core.json": _section(), "build-config.json": {"world_name": "Ward"}})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["report"]["entries"] == 1


# ── 4.5 · RecursionError is a RuntimeError, not a ValueError ─────────────────

def test_a_bracket_bomb_in_a_chara_chunk_is_refused_not_a_500():
    """Checks that a bracket bomb in a chara chunk is refused not a 500."""
    assert issubclass(RecursionError, RuntimeError) and not issubclass(RecursionError, ValueError)
    blob = _png([_text_chunk("chara", base64.b64encode(b"[" * 20000))])
    with pytest.raises(png_card.NoCardInPng):
        png_card.read_card(blob)


def test_the_bracket_bomb_png_gets_a_400_from_the_route(client, tmp_path):
    blob = _png([_text_chunk("chara", base64.b64encode(b"[" * 20000))])
    r = client.post("/wbedit/documents",
                    data={"file": (io.BytesIO(blob), "bomb.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 400, r.status_code
    _nothing_was_written(tmp_path / "wbedit")


# ── 4.6 · a lone surrogate ───────────────────────────────────────────────────

def test_a_lone_surrogate_cannot_be_encoded_which_is_the_whole_finding():
    with pytest.raises(UnicodeEncodeError):
        json.dumps({"d": LONE_SURROGATE}, ensure_ascii=False).encode("utf-8")
    assert issubclass(UnicodeEncodeError, ValueError), \
        "the MRO that made this look catchable where it was not"


def test_a_lone_surrogate_is_refused_and_leaves_NOTHING_behind(client, tmp_path):
    """Checks that a lone surrogate is refused and leaves nothing behind."""
    doc = copy.deepcopy(CARD)
    doc["data"]["description"] = LONE_SURROGATE
    r = client.post("/wbedit/documents", json={"document": doc, "name": "test-character-2"})
    assert 400 <= r.status_code < 500, r.status_code
    assert client.get("/wbedit/documents").get_json()["documents"] == []
    _nothing_was_written(tmp_path / "wbedit")


def test_a_lone_surrogate_in_a_png_card_says_what_is_wrong(client, tmp_path):
    """Checks that a lone surrogate in a png card says what is wrong."""
    doc = copy.deepcopy(CARD)
    doc["data"]["description"] = LONE_SURROGATE
    blob = _png([_card_chunk("chara", doc)])
    r = client.post("/wbedit/documents", data={"file": (io.BytesIO(blob), "test-character-2.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 400, r.status_code
    assert "surrogate" in r.get_json()["error"].lower(), r.get_json()
    _nothing_was_written(tmp_path / "wbedit")


def test_a_lone_surrogate_in_a_section_chunk_cannot_reach_the_store(client, tmp_path):
    """Checks that a lone surrogate in a section chunk cannot reach the store."""
    sec = _section(entries=[{"id": "A1", "comment": "A1", "keys": ["thing"],
                             "content": LONE_SURROGATE + " text"}])
    r = _upload(client, {"A_core.json": sec})
    assert r.status_code == 400, r.status_code
    _nothing_was_written(tmp_path / "wbedit")


def test_infinity_survives_json_loads_and_is_refused_anyway():
    """Checks that infinity survives json loads and is refused anyway."""
    doc = json.loads('{"spec": "chara_card_v2", "data": {"name": "S", "description": "d",'
                     ' "first_mes": "m", "extensions": {"weight": Infinity}}}')
    assert math.isinf(doc["data"]["extensions"]["weight"]), "the premise: json.loads accepts it"
    assert detect.doc_kind(doc) is None


# ── the chokepoint: one pass, every door ─────────────────────────────────────

def _door_upload_json(doc):
    return detect.doc_kind(doc)


def _door_upload_png(doc):
    return png_card.read_card(_png([_card_chunk("chara", doc)]))


def _door_pair_push(doc):
    # `POST /pair/documents` runs the identical two lines as the upload route. It is a DIFFERENT
    # blueprint with its own bearer gate, which is precisely why it is checked separately.
    return detect.doc_kind(doc)


def _door_assemble(doc):
    return wb.assemble([("A_core.json", {"section": "A", "entries": [
        {"id": "A1", "comment": "A1", "keys": ["k"], "content": "x", "extra": doc}]})])


DOORS = {
    "POST /wbedit/documents (JSON)": _door_upload_json,
    "POST /wbedit/documents (PNG)": _door_upload_png,
    "POST /pair/documents": _door_pair_push,
    "POST /wbedit/assemble": _door_assemble,
}


@pytest.mark.parametrize("door", sorted(DOORS))
@pytest.mark.parametrize("hostile", ["surrogate", "deep", "infinity"])
def test_every_door_that_builds_a_document_runs_the_same_pass(door, hostile):
    """Checks that every door that builds a document runs the same pass."""
    payload = {"surrogate": {"d": LONE_SURROGATE},
               "deep": {"d": _deep(500)},
               "infinity": {"d": float("inf")}}[hostile]
    doc = copy.deepcopy(CARD)
    doc["data"]["extensions"] = payload

    try:
        got = DOORS[door](doc)
    except (validate.InvalidDocument, png_card.NoCardInPng, wb.AssemblyFailed):
        return
    assert got is None, f"{door} accepted a document carrying a {hostile}: {type(got).__name__}"


def test_the_pass_is_reachable_as_a_public_function_for_a_better_message():
    """Checks that the pass is reachable as a public function for a better message."""
    doc = copy.deepcopy(CARD)
    doc["data"]["description"] = LONE_SURROGATE
    with pytest.raises(validate.InvalidDocument) as exc:
        validate.check_document(doc)
    assert "surrogate" in str(exc.value).lower() and "data.description" in str(exc.value)
    assert LONE_SURROGATE not in str(exc.value), "I16 — the message carries the path, never text"


def test_the_pass_cannot_be_broken_by_the_thing_it_guards_against():
    """Checks that the pass cannot be broken by the thing it guards against."""
    node: object = []
    for _ in range(5_000):
        node = [node]
    with pytest.raises(validate.InvalidDocument):
        validate.check_document(node)


# ── 4.9 · the quadratic ──────────────────────────────────────────────────────

class _CountedKey:
    """Tests  countedkey behavior."""

    calls = 0

    def __init__(self, s: str):
        self.s = s

    def __str__(self) -> str:
        type(self).calls += 1
        return self.s


def _book_of(n: int, *, keys_per: int = 4, chars: int = 2000, counted: bool = False):
    def key(i, j):
        k = f"k{i}_{j}"
        return _CountedKey(k) if counted else k
    return {"section": "A", "section_name": "Core", "entries": [
        {"id": f"e{i}", "comment": f"e{i}", "keys": [key(i, j) for j in range(keys_per)],
         "content": "x" * chars} for i in range(n)]}


@pytest.mark.parametrize("n", [20, 200])
def test_a_keys_normalization_count_does_not_depend_on_the_size_of_the_book(n):
    """Deterministic, machine-independent, and it fails hard before the hoist: at 200 entries the
    old code normalized each key **800×** (once per key in the book) instead of once."""
    _CountedKey.calls = 0
    wb.assemble([("A_core.json", _book_of(n, counted=True))])
    per_key = _CountedKey.calls / (n * 4)
    assert per_key <= 3, (
        f"each keyword was re-normalized {per_key:.0f}× for a book of {n} entries — the count "
        "grows with the book, which is the quadratic")


def test_validate_scales_linearly_ish_in_the_number_of_entries():
    """Checks that validate scales linearly ish in the number of entries."""
    def best(n):
        doc = _book_of(n)
        out = []
        for _ in range(3):
            t = time.perf_counter()
            wb.assemble([("A_core.json", copy.deepcopy(doc))])
            out.append(time.perf_counter() - t)
        return min(out)

    small, large = best(150), best(600)
    ratio = large / max(small, 1e-6)
    assert ratio < 8, (
        f"4× the entries cost {ratio:.1f}× the time ({small*1000:.1f}ms -> {large*1000:.1f}ms) — "
        "linear is ~4 and quadratic is ~16, so this is the quadratic")


def test_the_hoist_did_not_change_what_validate_reports():
    """Checks that the hoist did not change what validate reports."""
    twice = {"section": "A", "section_name": "Core", "entries": [
        {"id": "a", "comment": "a", "keys": ["ledger", "LEDGER "], "content": "x" * 400},
        {"id": "b", "comment": "b", "keys": ["ledger"], "content": "y" * 400}]}
    _book, report = wb.assemble([("A_core.json", twice)])
    assert report.worst_key == "ledger"
    # 800 chars over both entries / 4.0 chars-per-token — the duplicate listing must not make it
    # 1200 by counting entry `a` twice.
    assert report.worst_tokens == pytest.approx(200.0)


def test_the_collector_still_sees_a_book_the_assembler_built():
    """The end-to-end control for the whole file: after every guard above, an ordinary chunk
    upload still compiles into a book the editor can open."""
    book, _ = wb.assemble([("A_core.json", _book_of(3, chars=50))])
    jobs = formats.collect(book, rel="assembled.json")
    assert [j.locator for j in jobs] == [("entries", str(i), "content") for i in range(3)]


# ── A.3 · `?revision=` present and unparseable is a 400, never a silent "latest" ──────────────
#
# 🔴 THE REVIEW NAMED TWO SEND PATHS. THERE WERE FIVE LOOSE PARSES, and the worst of them is a
# WRITE the review does not list at all. `request.args.get("revision", type=int)` returns `None`
# for "absent" AND for "?revision=banana", and `DocumentStore.revision(doc_id, None)` reads
# `None` as latest — a correct default for the first case, a silent substitution in the second.

def _a_book(client, name="a-book"):
    """Two revisions, so "latest" and "the one I asked for" are different answers."""
    r = client.post("/wbedit/documents",
                    json={"document": {"entries": {"0": {"comment": "c", "content": "one"}}},
                          "name": name})
    assert r.status_code == 201, r.get_json()
    doc_id = r.get_json()["id"]
    r = client.post(f"/wbedit/documents/{doc_id}/entry?revision=0", json={"comment": "second"})
    assert r.status_code in (200, 201), r.get_json()
    return doc_id


@pytest.mark.parametrize("bad", ["banana", "", "1.5", "undefined", "null", "0x1", " "])
@pytest.mark.parametrize("route", [
    "/wbedit/documents/{id}/fields?revision={v}",
    "/wbedit/documents/{id}/export?revision={v}",
])
def test_an_unparseable_revision_on_a_read_is_a_400_and_names_the_parameter(client, route, bad):
    doc_id = _a_book(client)
    r = client.get(route.format(id=doc_id, v=bad))
    assert r.status_code == 400, f"{route} took {bad!r} and answered {r.status_code}"
    assert "revision" in (r.get_json() or {}).get("error", ""), r.get_json()


@pytest.mark.parametrize("bad", ["banana", "", "undefined"])
def test_an_unparseable_revision_on_the_SEND_path_is_a_400(client, bad):
    """The send WRITES into the linked SillyTavern installation, over existing data. Reading
    a mangled value as "latest" sends a version of the document nobody chose."""
    doc_id = _a_book(client)
    r = client.post(f"/wbedit/documents/{doc_id}/send?revision={bad}", json={})
    assert r.status_code == 400, r.get_json()


@pytest.mark.parametrize("bad", ["banana", "", "undefined"])
def test_an_unparseable_revision_on_the_ENTRY_path_MINTS_NOTHING(client, bad):
    """Checks that an unparseable revision on the entry path mints nothing."""
    doc_id = _a_book(client)
    before = client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"]
    r = client.post(f"/wbedit/documents/{doc_id}/entry?revision={bad}", json={"comment": "x"})
    assert r.status_code == 400, r.get_json()
    after = client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"]
    assert after == before, f"a refused entry still minted a revision: {before} -> {after}"


def test_an_ABSENT_revision_still_means_latest(client):
    """Checks that an absent revision still means latest."""
    doc_id = _a_book(client)
    latest = client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"]
    r = client.get(f"/wbedit/documents/{doc_id}/fields")
    assert r.status_code == 200, r.get_json()
    assert client.get(f"/wbedit/documents/{doc_id}/revision/{latest}").status_code == 200


# ── 4.6 · the four doors that still 500ed on a lone surrogate ────────────────────────────────
#
# 🔴 THE IMPORT DOOR WAS THE ONE THE REVIEW MEASURED; IT WAS NOT THE ONLY ONE. `/edit`, `/entry`,
# `/rename` and `PUT /draft` each reached `vault_fs.write_json_atomic` with a `str` holding a lone
# surrogate — legal JSON, not encodable as UTF-8 — and the encode failed INSIDE the write, after
# `mkdir` and after the `.part` had been created. Guarding four routes would have been the
# one-chokepoint-two-doors failure this whole rank is about, so the fix is in `write_json_atomic`:
# encode first, and if it cannot be encoded, nothing is created.

LONE_SURROGATE = "\ud800"


def test_write_json_atomic_refuses_before_it_creates_anything(tmp_path):
    """The unit statement of the rule, independent of any route."""
    import vault_fs as vfs
    target = tmp_path / "deep" / "nested" / "thing.json"
    with pytest.raises(ValueError):          # UnicodeEncodeError IS a ValueError
        vfs.write_json_atomic(target, {"x": LONE_SURROGATE})
    assert not target.exists()
    assert not list(tmp_path.rglob("*.part")), "a .part survived a refused write"


@pytest.mark.parametrize("door", ["edit", "entry", "rename", "draft"])
def test_a_lone_surrogate_leaves_no_part_file_on_any_write_door(client, tmp_path, door):
    doc_id = _a_book(client)
    root = tmp_path / "wbedit"
    if door == "edit":
        r = client.post(f"/wbedit/documents/{doc_id}/edit",
                        json={"base": 1, "edits": [{"locator": ["entries", "0", "content"],
                                                    "value": LONE_SURROGATE}]})
    elif door == "entry":
        r = client.post(f"/wbedit/documents/{doc_id}/entry?revision=1",
                        json={"comment": LONE_SURROGATE})
    elif door == "rename":
        r = client.post(f"/wbedit/documents/{doc_id}/rename", json={"name": LONE_SURROGATE})
    else:
        r = client.put(f"/wbedit/documents/{doc_id}/draft",
                       json={"revision": 1, "locator": ["entries", "0", "content"],
                             "text": LONE_SURROGATE})
    assert r.status_code != 500, f"{door} still 500s: {r.get_json()}"
    assert 400 <= r.status_code < 500, f"{door} answered {r.status_code}"
    parts = sorted(str(p) for p in root.rglob("*.part"))
    assert not parts, f"{door} left a temp file behind: {parts}"
