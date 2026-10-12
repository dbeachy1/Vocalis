"""Tests keyword requirements and SillyTavern field semantics."""
from __future__ import annotations

import json

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis.web.wbedit as web_wbedit
import vocalis_server as vs
from vocalis.runtime import paths
from wbedit.formats import worldbook


BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "content": "Test Character 1 keeps the ledger."},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "content": "The rains come off the estuary."},
    },
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _import(c, doc=None, name="Sample World Book 1"):
    r = c.post("/wbedit/documents", json={"document": doc or json.loads(json.dumps(BOOK)),
                                          "name": name})
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def _edit(c, doc_id, edits):
    return c.post(f"/wbedit/documents/{doc_id}/edit", json={"edits": edits})


# ── the predicate, over every mode ───────────────────────────────────────────

@pytest.mark.parametrize("entry,inert,why", [
    ({"comment": "plain", "content": "x"}, True, "normal with no keys — never fires"),
    ({"comment": "keyed", "content": "x", "key": ["a"]}, False, "normal with a key"),
    ({"comment": "const", "content": "x", "constant": True}, False, "constant ignores keys"),
    ({"comment": "vec", "content": "x", "vectorized": True}, False, "vectorized fires on similarity"),
    ({"comment": "off", "content": "x", "disable": True}, False, "disabled never activates"),
    ({"comment": "sticky", "content": "x", "sticky": 3}, True,
     "sticky is a RUNTIME state — it still needs a key to fire the FIRST time"),
    ({"comment": "blankkeys", "content": "x", "key": ["", "  "]}, True,
     "whitespace is not a keyword"),
    ({"comment": "chunkspelling", "content": "x", "keys": ["a"]}, False,
     "a section chunk spells it `keys`"),
])
def test_which_entries_are_inert(entry, inert, why):
    got = worldbook.inert_entries({"entries": {"0": entry}})
    assert bool(got) is inert, f"{why}: got {got}"


def test_a_non_worldbook_is_not_this_rules_business():
    """Checks that a non worldbook is not this rules business."""
    assert worldbook.inert_entries({"data": {"name": "Test Character 2"}}) == []
    assert worldbook.inert_entries(None) == []


def test_the_locator_matches_what_the_editor_holds():
    """Checks that the locator matches what the editor holds."""
    got = worldbook.inert_entries({"entries": {"7": {"comment": "x", "content": "y"}}})
    assert got == [{"label": "x", "entry": ["entries", "7"]}]


# ── the route ────────────────────────────────────────────────────────────────

def test_emptying_the_last_keyword_is_refused(client):
    doc = _import(client)
    r = _edit(client, doc["id"], [{"locator": ["entries", "0", "key"], "value": []}])
    assert r.status_code == 422, r.get_json()
    body = r.get_json()
    assert body["error"] == "entries_without_keywords"
    assert body["entries"] == [{"label": "Sample Entry 1", "entry": ["entries", "0"]}]
    # The message NAMES the entry — a 110-entry book refused with "no" is unactionable.
    assert "Sample Entry 1" in body["message"]


def test_the_refusal_wrote_NOTHING(client):
    """A validation refusal is not a partial save. The revision count must be untouched, or the
    'nothing is lost' the UI promises is a lie."""
    doc = _import(client)
    before = client.get(f"/wbedit/documents/{doc['id']}").get_json()["latest"]
    _edit(client, doc["id"], [{"locator": ["entries", "0", "key"], "value": []}])
    after = client.get(f"/wbedit/documents/{doc['id']}").get_json()["latest"]
    assert after == before
    # …and the keyword is still there.
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/{after}").get_json()
    assert rev["content"]["entries"]["0"]["key"] == ["ledger"]


def test_it_is_judged_on_the_RESULT_not_on_the_edit(client):
    """Checks that it is judged on the result not on the edit."""
    book = json.loads(json.dumps(BOOK))
    book["entries"]["2"] = {"uid": 2, "comment": "Always", "constant": True, "content": "x"}
    doc = _import(client, book, name="Const")
    r = _edit(client, doc["id"], [{"locator": ["entries", "2", "constant"], "value": False}])
    assert r.status_code == 422, r.get_json()
    assert r.get_json()["entries"] == [{"label": "Always", "entry": ["entries", "2"]}]


def test_an_edit_that_FIXES_an_entry_is_allowed(client):
    """The other half — a gate that refuses everything would pass every assertion above."""
    book = json.loads(json.dumps(BOOK))
    book["entries"]["2"] = {"uid": 2, "comment": "Broken", "content": "x"}
    doc = _import(client, book, name="Fixable")
    # It is inert on arrival, so ANY save is refused…
    # ⚠️ `text` ONLY. An edit carrying `value` takes the settings branch (`"value" in e`), which
    # rejects a prose locator before this rule is ever reached.
    assert _edit(client, doc["id"],
                 [{"locator": ["entries", "0", "content"],
                   "text": "changed"}]).status_code == 422
    # …until the keyword is supplied, in the same request as the prose.
    r = _edit(client, doc["id"], [
        {"locator": ["entries", "2", "key"], "value": ["broken"]},
        {"locator": ["entries", "0", "content"], "text": "changed"},
    ])
    assert r.status_code == 201, r.get_json()


def test_the_exempt_modes_save_normally(client):
    """Constant and vectorized entries with no keywords are legitimate and must stay saveable."""
    book = json.loads(json.dumps(BOOK))
    book["entries"]["2"] = {"uid": 2, "comment": "Always", "constant": True, "content": "x"}
    book["entries"]["3"] = {"uid": 3, "comment": "Vector", "vectorized": True, "content": "y"}
    doc = _import(client, book, name="Exempt")
    r = _edit(client, doc["id"], [{"locator": ["entries", "0", "content"], "text": "changed"}])
    assert r.status_code == 201, r.get_json()


def test_a_card_is_never_subject_to_this(client):
    """Checks that a card is never subject to this."""
    card = {"spec": "chara_card_v2", "data": {"name": "Test Character 2", "description": "A knight."}}
    doc = _import(client, card, name="Test Character 2")
    r = _edit(client, doc["id"],
              [{"locator": ["data", "description"], "text": "A knight, rewritten."}])
    assert r.status_code == 201, r.get_json()


# ── anti-rot: the fork is the reason this rule exists ────────────────────────

def test_the_fork_still_skips_keyless_entries():
    """Checks that the fork still skips keyless entries."""
    import os
    from pathlib import Path
    fork_root = os.environ.get("VOCALIS_SILLYTAVERN_ROOT")
    if not fork_root:
        pytest.skip("VOCALIS_SILLYTAVERN_ROOT is not configured")
    fork = Path(fork_root)
    js = fork / "public" / "scripts" / "world-info.js"
    if not js.is_file():
        pytest.skip(f"the SillyTavern fork is not at {fork} — set VOCALIS_SILLYTAVERN_ROOT")
    src = js.read_text(encoding="utf-8", errors="replace")
    skip = src.find("has no keys defined, skipped")
    assert skip > 0, "the fork no longer skips keyless entries — §9a.29a may be obsolete"
    const = src.find("activated because of constant")
    sticky = src.find("activated because active sticky")
    assert 0 < const < skip, "the `constant` activation no longer precedes the keyless skip"
    assert 0 < sticky < skip, "the `sticky` activation no longer precedes the keyless skip"


# ── §9a.29's PASSIVE marker: the half §9a.29a left open ──────────────────────

def test_the_fields_route_says_which_entries_are_inert(client):
    """Checks that the fields route says which entries are inert."""
    doc = {"entries": {
        "0": {"comment": "dead", "content": "x"},                       # normal, no keys
        "1": {"comment": "alive", "content": "x", "key": ["guild"]},
        "2": {"comment": "always", "content": "x", "constant": True},   # exempt
        "3": {"comment": "blank", "content": "x", "key": ["  "]},       # whitespace is not a key
    }}
    made = _import(client, doc, name="Inert probe")
    n = client.get(f"/wbedit/documents/{made['id']}").get_json()["latest"]
    r = client.get(f"/wbedit/documents/{made['id']}/fields?revision={n}")
    assert r.status_code == 200, r.get_json()
    by = {f["label"]: f for f in r.get_json()["fields"]}
    assert set(by) >= {"dead", "alive", "always", "blank"}, sorted(by)

    assert by["dead"]["inert"] is True
    assert by["blank"]["inert"] is True, "a whitespace-only keyword is not a keyword"
    assert by["alive"]["inert"] is False
    assert by["always"]["inert"] is False, "a constant entry is SUPPOSED to have no keywords"

    # 🔴 ONE PREDICATE. The route forwards `worldbook.py`'s answer rather than recomputing it —
    # a second opinion here is how the marker and the 422 refusal start disagreeing about the
    # same entry, which is the failure §9a.29a already wrote down.
    want = {tuple(e["entry"]) for e in worldbook.inert_entries(doc)}
    got = {tuple(f["entry"]) for f in r.get_json()["fields"] if f["inert"]}
    assert got == want, f"the wire disagrees with the predicate: {got} vs {want}"


def test_a_card_field_is_never_marked_inert(client):
    """A character card's own fields have no injection mode at all, so the flag must be absent-
    or-False for every one of them rather than accidentally True for an empty one."""
    made = _import(client, {"data": {"name": "Test Character 2", "description": "A tall woman.",
                                     "personality": "Wry.", "first_mes": "You again."}},
                   name="Test Character 2")
    n = client.get(f"/wbedit/documents/{made['id']}").get_json()["latest"]
    r = client.get(f"/wbedit/documents/{made['id']}/fields?revision={n}")
    assert r.status_code == 200, r.get_json()
    assert not [f for f in r.get_json()["fields"] if f.get("inert")], r.get_json()["fields"]
