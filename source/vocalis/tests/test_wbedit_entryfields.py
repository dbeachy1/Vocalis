"""Tests typed editing and validation for World Book entry fields."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis.web.wbedit as web_wbedit
import vocalis_server as vs
from vocalis.runtime import paths
from wbedit.formats import entryfields as ef
from wbedit.formats import worldbook

# ── the fork, read-only ──────────────────────────────────────────────────────
#
# The environment variable supports other checkout locations; a missing fork skips the test.
FORK_ROOT = os.environ.get("VOCALIS_SILLYTAVERN_ROOT")
FORK = Path(FORK_ROOT) if FORK_ROOT else None
WORLD_INFO_JS = FORK / "public" / "scripts" / "world-info.js" if FORK else None

BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False, "sticky": None,
              "content": "Test Character 1 keeps the ledger of every debt in the lower wards."},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "order": 100, "disable": False,
              "content": "The rains come off the estuary in the ninth month."},
    },
}

CHUNK = {
    "section": "A", "section_name": "Core",
    "entries": [{"id": "A1", "comment": "A1 — the world", "keys": ["world"],
                 "content": "The world is wide."}],
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


def _entry(c, doc_id, uid="0", revision=None):
    n = revision if revision is not None else c.get(
        f"/wbedit/documents/{doc_id}").get_json()["latest"]
    rev = c.get(f"/wbedit/documents/{doc_id}/revision/{n}").get_json()
    return rev["content"]["entries"][uid]


def _set(c, doc_id, name, value, uid="0"):
    return c.post(f"/wbedit/documents/{doc_id}/edit",
                  json={"edits": [{"locator": ["entries", uid, name], "value": value}]})


# ── 🔴 the anti-rot rule ─────────────────────────────────────────────────────

def _fork_definition() -> dict[str, str]:
    """Checks that fork definition."""
    src = WORLD_INFO_JS.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"newWorldInfoEntryDefinition\s*=\s*\{(.*?)\n\};", src, re.S)
    assert m, ("`newWorldInfoEntryDefinition` is no longer an object literal in world-info.js — "
               "this test's parser needs updating before it can guard anything")
    out: dict[str, str] = {}
    for name, decl in re.findall(r"^\s{4}(\w+)\s*:\s*\{(.*?)\},?\s*$", m.group(1), re.M):
        t = re.search(r"type\s*:\s*'([^']+)'", decl)
        if t:
            out[name] = t.group(1)
    assert len(out) > 20, f"only parsed {len(out)} fields out of the fork's table — parser is stale"
    return out


@pytest.mark.skipif(WORLD_INFO_JS is None or not WORLD_INFO_JS.is_file(),
                    reason=f"the SillyTavern fork is not at {WORLD_INFO_JS} — set "
                           "VOCALIS_SILLYTAVERN_ROOT to point at it")
def test_every_fork_entry_field_is_accounted_for():
    """Checks that every fork entry field is accounted for."""
    fork = _fork_definition()
    known = set(ef.BY_NAME) | set(ef.NOT_EDITABLE)
    missing = sorted(set(fork) - known)
    assert not missing, (
        "SillyTavern's entry schema has field(s) Vocalis knows nothing about: "
        + ", ".join(f"{n} ({fork[n]})" for n in missing)
        + ". Add each to `formats/entryfields.ENTRY_FIELDS` if the editor should expose it, or "
          "to `NOT_EDITABLE` with the reason if he should not. Do not delete this assertion.")


@pytest.mark.skipif(
    WORLD_INFO_JS is None or not WORLD_INFO_JS.is_file(),
    reason="the SillyTavern fork is not present",
)
def test_no_entry_field_here_has_rotted_out_of_the_fork():
    """Checks that no entry field here has rotted out of the fork."""
    fork = set(_fork_definition())
    # `characterFilter` is the stored shape of the three `characterFilter*` template rows, and
    # `uid`/`displayIndex` are assigned by their editor rather than declared in that table.
    exempt = {"characterFilter", "uid", "displayIndex", "content"}
    stale = sorted((set(ef.BY_NAME) | set(ef.NOT_EDITABLE)) - fork - exempt)
    assert not stale, ("Vocalis declares entry field(s) SillyTavern no longer has: "
                       + ", ".join(stale))


@pytest.mark.skipif(
    WORLD_INFO_JS is None or not WORLD_INFO_JS.is_file(),
    reason="the SillyTavern fork is not present",
)
def test_the_declared_types_agree_with_the_forks():
    """Checks that the declared types agree with the forks."""
    fork = _fork_definition()
    # Their vocabulary to ours. `text` is ours alone (a multi-line string) and `boolint` is the
    # `delayUntilRecursion` union their own editor writes but their table flattens to `number`.
    #
    # ⚠️ **THEIR `type` IS THE STORAGE TYPE; OURS IS THE WIDGET**, and `position` is where the two
    # part company. Their table calls it `number` and their editor still draws a named select —
    # `0` means "before character definitions"; label it instead of exposing an unexplained number.
    # So an int-valued `enum` satisfies a fork `number`, and the guard keeps its teeth by
    # requiring the option values to really be ints: a `number` rendered as a checkbox or a text
    # box still fails here.
    same = {"string": {"string", "text"}, "boolean": {"bool"}, "number": {"int", "boolint"},
            "enum": {"enum", "enum?"}, "array": {"array"},
            "number?": {"int?"}, "boolean?": {"bool?"}}
    bad = []
    for name, spec in ef.BY_NAME.items():
        want = fork.get(name)
        if want is None:
            continue                      # covered by the rot test above
        ok = set(same.get(want, set()))
        if want in ("number", "number?") and all(
                isinstance(v, int) and not isinstance(v, bool) for v, _ in spec.options):
            ok |= {"enum"} if want == "number" else {"enum?"}
        if spec.type not in ok:
            bad.append(f"{name}: fork says {want!r}, we render {spec.type!r}")
    assert not bad, "entry field types disagree with SillyTavern's:\n  " + "\n  ".join(bad)


def test_every_declared_type_is_one_the_renderer_knows():
    """A typo in the table is a control that silently falls through to a text box."""
    bad = [f.name for f in ef.ENTRY_FIELDS if f.type not in ef.TYPES]
    assert not bad, f"unknown field type on: {', '.join(bad)}"
    # An enum with no options renders as an empty `<select>` — a control that cannot be set to
    # anything, over a field that has a value. It also silently satisfies the fork type check
    # above, whose int-valued-options carve-out is vacuously true on an empty list.
    empty = [f.name for f in ef.ENTRY_FIELDS if f.type.startswith("enum") and not f.options]
    assert not empty, f"enum field(s) with no options: {', '.join(empty)}"
    # And the tri-state selects need a null option or there is no way back to "not set".
    for f in ef.ENTRY_FIELDS:
        if f.type in ("enum?", "bool?"):
            assert any(v is None for v, _ in f.options), f"{f.name} has no 'not set' option"


def test_the_nullable_fields_are_declared_nullable():
    """Checks that the nullable fields are declared nullable."""
    for name in ("sticky", "cooldown", "delay", "scanDepth"):
        assert ef.BY_NAME[name].type == "int?", f"{name} must stay nullable"
    for name in ("caseSensitive", "matchWholeWords", "useGroupScoring"):
        assert ef.BY_NAME[name].type == "bool?", f"{name} must stay nullable"


def test_content_is_not_offered_twice():
    """`content` is the textarea every pass runs over. A second control writing the same locator
    would give two widgets one key and no rule about which wins."""
    assert "content" not in ef.BY_NAME
    assert "content" in ef.NOT_EDITABLE


def test_every_field_lands_in_a_declared_group():
    bad = [f.name for f in ef.ENTRY_FIELDS if f.group not in ef.GROUPS]
    assert not bad, f"field(s) in an undeclared group: {', '.join(bad)}"
    assert set(ef.GROUP_LABELS) == set(ef.GROUPS)


# ── the type guard ───────────────────────────────────────────────────────────

def test_null_and_zero_are_different_answers():
    """Checks that null and zero are different answers."""
    assert ef.coerce("sticky", None) is None
    assert ef.coerce("sticky", 0) == 0 and ef.coerce("sticky", 0) is not None


def test_a_bool_cannot_masquerade_as_a_number():
    """`isinstance(True, int)` is True in Python, so every integer check in the module excludes
    bool explicitly. A book carrying `"order": true` would otherwise sort as 1."""
    with pytest.raises(ef.BadValue):
        ef.coerce("order", True)
    with pytest.raises(ef.BadValue):
        ef.coerce("sticky", True)


def test_a_string_number_is_refused():
    """What an untyped `<input>` hands you. `set_at` writes whatever it is given and nothing
    downstream re-checks, so this is the only place it can be caught."""
    with pytest.raises(ef.BadValue):
        ef.coerce("sticky", "12")


def test_an_enum_only_takes_its_own_values():
    assert ef.coerce("position", 4) == 4
    assert ef.coerce("selectiveLogic", 3) == 3
    with pytest.raises(ef.BadValue):
        ef.coerce("position", 9)
    with pytest.raises(ef.BadValue):
        ef.coerce("selectiveLogic", True), "True must not pass as 1"


def test_a_nullable_enum_takes_null_and_a_plain_one_does_not():
    assert ef.coerce("role", None) is None
    with pytest.raises(ef.BadValue):
        ef.coerce("position", None)


def test_ranges_are_enforced():
    assert ef.coerce("probability", 100) == 100
    with pytest.raises(ef.BadValue):
        ef.coerce("probability", 101)
    with pytest.raises(ef.BadValue):
        ef.coerce("sticky", -1)


def test_an_array_must_be_strings_and_triggers_must_be_real_ones():
    assert ef.coerce("key", ["ledger", "debt"]) == ["ledger", "debt"]
    with pytest.raises(ef.BadValue):
        ef.coerce("key", [1, 2])
    assert ef.coerce("triggers", ["swipe"]) == ["swipe"]
    with pytest.raises(ef.BadValue):
        ef.coerce("triggers", ["sideways"])


def test_delay_until_recursion_keeps_all_three_of_the_forks_shapes():
    """`false` off, `true` level 1, a number for that level — `world-info.js:3875-3893` writes all
    three and `:5016` reads all three."""
    assert ef.coerce("delayUntilRecursion", False) is False
    assert ef.coerce("delayUntilRecursion", True) is True
    assert ef.coerce("delayUntilRecursion", 3) == 3
    with pytest.raises(ef.BadValue):
        ef.coerce("delayUntilRecursion", 0), "0 is not a recursion level"


def test_an_unknown_field_is_refused_rather_than_written():
    with pytest.raises(ef.BadValue):
        ef.coerce("nonsense", 1)
    with pytest.raises(ef.BadValue):
        ef.coerce("content", "prose goes through the textarea")


# ── the collector's gate ─────────────────────────────────────────────────────

def test_only_a_compiled_book_offers_the_settings_surface():
    """Checks that only a compiled book offers the settings surface."""
    compiled = worldbook.jobs(json.loads(json.dumps(BOOK)), rel="book.json")
    assert compiled[0].meta["entry"] == ["entries", "0"]
    chunk = worldbook.jobs(json.loads(json.dumps(CHUNK)), rel="A_core.json")
    assert chunk[0].meta["entry"] is None
    assert worldbook.is_compiled(BOOK) and not worldbook.is_compiled(CHUNK)


# ── the wire ─────────────────────────────────────────────────────────────────

def test_the_fields_route_carries_the_spec_and_the_entry_locator(client):
    doc = _import(client)
    body = client.get(f"/wbedit/documents/{doc['id']}/fields").get_json()
    assert body["fields"][0]["entry"] == ["entries", "0"]
    names = [s["name"] for s in body["entry_fields"]]
    assert "sticky" in names and "key" in names and "content" not in names
    assert [g["key"] for g in body["entry_groups"]] == list(ef.GROUPS)
    # The values do NOT ride along — the revision the editor already holds is the one authority.
    assert all("value" not in s for s in body["entry_fields"])


def test_a_card_field_offers_no_entry_settings(client):
    """A character card's `description` is not a worldbook entry, and `locator[:-1]` would say it
    lived at `["data"]`. The server answers, so the UI never has to guess."""
    card = {"spec": "chara_card_v2", "spec_version": "2.0",
            "data": {"name": "Test Character 2", "description": "A tall woman.", "personality": "Wry.",
                     "scenario": "A tavern.", "first_mes": "You again.", "mes_example": "x"}}
    doc = _import(client, card, name="ignored")
    fields = client.get(f"/wbedit/documents/{doc['id']}/fields").get_json()["fields"]
    assert fields and all(f["entry"] is None for f in fields)


def test_setting_sticky_mints_a_revision_and_keeps_the_type(client):
    """Set a nullable entry field and preserve its value type."""
    doc = _import(client)
    r = _set(client, doc["id"], "sticky", 4)
    assert r.status_code == 201, r.get_json()
    e = _entry(client, doc["id"])
    assert e["sticky"] == 4 and isinstance(e["sticky"], int)
    assert e["content"].startswith("Test Character 1"), "the prose must be untouched"


def test_clearing_a_nullable_back_to_not_set_is_a_real_edit(client):
    """Checks that clearing a nullable back to not set is a real edit."""
    doc = _import(client)
    assert _set(client, doc["id"], "sticky", 4).status_code == 201
    r = _set(client, doc["id"], "sticky", None)
    assert r.status_code == 201, r.get_json()
    e = _entry(client, doc["id"])
    assert e["sticky"] is None


def test_zero_is_not_mistaken_for_the_false_already_there(client):
    """Checks that zero is not mistaken for the false already there."""
    book = json.loads(json.dumps(BOOK))
    book["entries"]["0"]["sticky"] = False        # what a hand-edited book can carry
    doc = _import(client, book)
    r = _set(client, doc["id"], "sticky", 0)
    assert r.status_code == 201, r.get_json()
    e = _entry(client, doc["id"])
    assert e["sticky"] == 0 and e["sticky"] is not False


def test_an_absent_key_can_be_created(client):
    """Checks that an absent key can be created."""
    doc = _import(client)
    assert "outletName" not in _entry(client, doc["id"])
    r = _set(client, doc["id"], "outletName", "ledger")
    assert r.status_code == 201, r.get_json()
    assert _entry(client, doc["id"])["outletName"] == "ledger"


def test_a_setting_locator_outside_an_entry_is_refused(client):
    """Checks that a setting locator outside an entry is refused."""
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/edit",
                    json={"edits": [{"locator": ["name"], "value": 5}]})
    assert r.status_code == 400
    assert "not a worldbook entry" in r.get_json()["error"]


def test_a_bad_value_is_a_400_and_nothing_is_written(client):
    doc = _import(client)
    before = client.get(f"/wbedit/documents/{doc['id']}").get_json()["latest"]
    r = _set(client, doc["id"], "sticky", "soon")
    assert r.status_code == 400 and "sticky" in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{doc['id']}").get_json()["latest"] == before


def test_prose_and_settings_land_in_ONE_revision(client):
    """Checks that prose and settings land in one revision."""
    doc = _import(client)
    r = client.post(f"/wbedit/documents/{doc['id']}/edit", json={"edits": [
        {"locator": ["entries", "0", "content"], "text": "He keeps a different ledger now."},
        {"locator": ["entries", "0", "sticky"], "value": 2},
        {"locator": ["entries", "1", "key"], "value": ["rain", "estuary"]},
    ]})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["n"] == 1, "one press must be one revision"
    e0, e1 = _entry(client, doc["id"], "0"), _entry(client, doc["id"], "1")
    assert e0["content"] == "He keeps a different ledger now."
    assert e0["sticky"] == 2
    assert e1["key"] == ["rain", "estuary"]


def test_everything_not_addressed_round_trips_untouched(client):
    """§4.1 — the locator walk only ever assigns what it is given. A settings edit must not
    reshape the entry around it, because the send ships the book WHOLESALE."""
    doc = _import(client)
    before = _entry(client, doc["id"], "1")
    assert _set(client, doc["id"], "constant", True).status_code == 201
    after0, after1 = _entry(client, doc["id"], "0"), _entry(client, doc["id"], "1")
    assert after1 == before, "the entry that was not edited must be byte-identical"
    assert after0["constant"] is True
    assert after0["uid"] == 0 and after0["key"] == ["ledger"] and after0["order"] == 100


def test_the_mode_dot_follows_a_disable_typed_in_the_editor(client):
    """Checks that the mode dot follows a disable typed in the editor."""
    doc = _import(client)
    assert _set(client, doc["id"], "disable", True).status_code == 201
    fields = client.get(f"/wbedit/documents/{doc['id']}/fields").get_json()["fields"]
    assert fields[0]["mode"] == "disabled"


def test_an_edit_that_changes_nothing_is_still_refused(client):
    """Unchanged behavior, re-asserted through the typed path: a save that writes the value
    already there must not mint a revision identical to its parent."""
    doc = _import(client)
    r = _set(client, doc["id"], "order", 100)
    assert r.status_code == 400 and r.get_json()["error"] == "nothing changed"
