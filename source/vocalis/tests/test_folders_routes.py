"""8.9 — the five URLs in `vocalis/web/folders.py`, exercised over HTTP.

The store has its own tests. This file is about the thin layer above it, and that layer is not
as thin as it looks: three of its rules are things the store never sees.

🔴 **THE ROUTE OWNS THE SCOPE GATE, THE BODY SHAPE AND THE PER-CALL CAP.** `folders.py` raises
`ValueError` for a bad scope and would happily be handed a 40 KB "name" or a `refs` that is a
string; turning those into a 400 with a sentence in it is this file's job, and nothing else in
the suite asserts it. `MAX_REFS_PER_CALL` in particular exists ONLY here — the store's
`MAX_ASSIGN_PER_SCOPE` bounds what ends up on disk, not what one POST may carry, which is the
gap `clip_favorites` shipped with.

🔴 **AND THE DELETE MUST KEEP THE CONTENTS.** A folder is a label, so `DELETE` can only forget
which box something was in. `test_deleting_a_folder_keeps_its_contents…` is the guarantee the
client's confirm dialog promises the user in words, checked through the routes and read back
through the store.

📌 `import folders` here is `src/folders.py`, the store — NOT `vocalis.web.folders`, which is
imported under its full dotted name. Same arrangement the module under test has.
"""
from pathlib import Path

import pytest
from flask import Flask


# 📌 NO `sys.path` PREAMBLE HERE, AND SO NO IMPORT-ORDER SUPPRESSION EITHER.
# `tests/conftest.py` puts `src/` on `sys.path` at import time and pytest loads conftest before
# any test module, so the older per-file insert — and the lint suppressions it forced on every
# import under it — bought nothing. If this ever breaks it breaks LOUDLY, with an ImportError.
# ⚠️ And the token itself is deliberately not spelled out anywhere above: the suppression
# ratchet is a TEXTUAL scanner, so a comment boasting about not having one is counted as three
# of them. Caught by that ratchet, which is the ratchet working.
import folders
import vocalis.web.folders as folders_web
from vocalis.web.folders import create_folders_blueprint

# Two real scopes, so the isolation tests are about two datasets rather than one name twice.
SCOPE = "train_sources"
OTHER = "voiceswap_songs"

# 🔴 Not in `folders.SCOPES`, and every test that uses it re-checks that — a bogus scope that
# quietly became a real one would turn five 400-assertions vacuous in one edit.
BOGUS = "definitely_not_a_scope"


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A bare app with just this blueprint on it, over a folders.yaml in tmp_path.

    Pinning `paths.FOLDERS` is enough because the blueprint resolves `paths.FOLDERS.parent`
    PER REQUEST — it is built once at import, so a captured root would be the developer's own
    install and every test here would write into it."""
    from vocalis.runtime import paths
    monkeypatch.setattr(paths, "FOLDERS", tmp_path / "folders.yaml")
    app = Flask(__name__)
    app.register_blueprint(create_folders_blueprint())
    return app.test_client()


def _call(client, method, url, body=None):
    """`client.get`/`post`/`delete`, with a JSON body only when there is one to send."""
    return getattr(client, method)(url, **({} if body is None else {"json": body}))


def _mk(client, scope, name):
    """Create a folder through the route and return `{id, name}`."""
    r = client.post(f"/folders/{scope}", json={"name": name})
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()


def _names(client, scope):
    return [f["name"] for f in client.get(f"/folders/{scope}").get_json()["folders"]]


# ── create and list ──────────────────────────────────────────────────────────────────────

def test_a_list_with_no_folders_yet_is_an_empty_list(client):
    """The file does not exist at all here: absent ≠ corrupt, and the tab renders flat.

    🔴 THE WHOLE BODY, NOT `["folders"]` — an exact-equality assertion on the response is what
    makes a new key a decision rather than an accident. 8.9.7 added `assign` deliberately and
    this line is where that had to be said out loud."""
    r = client.get(f"/folders/{SCOPE}")
    assert r.status_code == 200
    assert r.get_json() == {"folders": [], "assign": {}}


def test_the_listing_carries_the_assignment_map(client):
    """🔴 FOR THE ONE PANEL WHOSE REF NO ROUTE CAN STAMP. Voice Swap ▸ Sources merges five stores
    and composes four of the refs itself (`stems/…`, `speech/…`, `pg/…`), so `folders.for_rows`
    never sees the string they are filed under — those rows came back unfiled forever and
    `⇥ Move selected here` looked like a dead button. Reading the map back is what makes the
    write visible."""
    made = _mk(client, SCOPE, "Uploaded")
    client.post(f"/folders/{SCOPE}/assign", json={"refs": ["speech/sp1", "pg/c1"], "folder": made["id"]})
    body = client.get(f"/folders/{SCOPE}").get_json()
    assert body["folders"] == [made]
    assert body["assign"] == {"speech/sp1": made["id"], "pg/c1": made["id"]}


def test_the_assignment_map_is_this_scope_alone(client):
    """One file holds ten scopes. A map that leaked another scope's refs would let a panel file
    a row under a folder id that does not exist in its own list."""
    mine, theirs = _mk(client, SCOPE, "Mine"), _mk(client, OTHER, "Theirs")
    client.post(f"/folders/{SCOPE}/assign", json={"refs": ["a.wav"], "folder": mine["id"]})
    client.post(f"/folders/{OTHER}/assign", json={"refs": ["b.wav"], "folder": theirs["id"]})
    assert client.get(f"/folders/{SCOPE}").get_json()["assign"] == {"a.wav": mine["id"]}
    assert client.get(f"/folders/{OTHER}").get_json()["assign"] == {"b.wav": theirs["id"]}


def test_deleting_a_folder_takes_its_refs_out_of_the_map(client):
    """The rows are KEPT — that is the whole promise — so they must read back as unfiled, and
    an entry pointing at a folder that no longer exists would make them read as filed nowhere
    visible instead."""
    made = _mk(client, SCOPE, "Uploaded")
    client.post(f"/folders/{SCOPE}/assign", json={"refs": ["stems/r1"], "folder": made["id"]})
    assert client.get(f"/folders/{SCOPE}").get_json()["assign"] == {"stems/r1": made["id"]}
    client.delete(f"/folders/{SCOPE}/{made['id']}")
    assert client.get(f"/folders/{SCOPE}").get_json() == {"folders": [], "assign": {}}


def test_a_created_folder_comes_back_in_the_listing(client):
    made = _mk(client, SCOPE, 'Sample Folder')
    assert folders._ID_RE.match(made["id"]), f"an id is `f_` + 8 hex, got {made['id']!r}"
    assert made["name"] == 'Sample Folder'
    assert client.get(f"/folders/{SCOPE}").get_json()["folders"] == [made]


def test_the_listing_is_in_name_order_regardless_of_case(client):
    "🔴 Explorer's order, decided on the server so all three panels over one dataset agree\n    without three comparators — and case-insensitive so `demos` and `Demos` do not straddle\n    `Sample Folder`."
    for name in ("zebra", "Apple", "middle"):
        _mk(client, SCOPE, name)
    assert _names(client, SCOPE) == ["Apple", "middle", "zebra"]


def test_a_name_is_stored_with_its_whitespace_collapsed(client):
    """A label has no newlines and no runs of spaces — the store normalizes, and the route
    hands back what was actually stored rather than what was typed."""
    assert _mk(client, SCOPE, '  Sample Folder   and\n  co  ')["name"] == 'Sample Folder and co'


# ── 🔴 the scope gate, on every one of the five rules ────────────────────────────────────
#
# The scope is a closed set because an open-ended one would let a stuck client grow this file
# one invented key at a time, and `for_rows` would never read any of them. The gate is at the
# route on all five, and a rule that forgot it would reach the store, raise `ValueError` and
# come back as a 500.

@pytest.mark.parametrize("method, url, body", [
    ("get",    f"/folders/{BOGUS}",            None),
    ("post",   f"/folders/{BOGUS}",            {"name": 'Sample Folder'}),
    ("post",   f"/folders/{BOGUS}/f_00000000", {"name": "Renamed"}),
    ("delete", f"/folders/{BOGUS}/f_00000000", None),
    ("post",   f"/folders/{BOGUS}/assign",     {"refs": ["a.wav"], "folder": None}),
])
def test_an_unknown_scope_is_refused_on_every_route(client, method, url, body):
    assert BOGUS not in folders.SCOPES          # the premise, so this cannot go vacuous
    r = _call(client, method, url, body)
    assert r.status_code == 400
    assert BOGUS in r.get_json()["error"], "the message must name the scope it refused"


# ── names: the store's rules, surfaced as 400s ───────────────────────────────────────────

def test_a_duplicate_name_is_refused_and_the_message_names_it(client):
    _mk(client, SCOPE, 'Sample Folder')
    r = client.post(f"/folders/{SCOPE}", json={"name": 'Sample Folder'})
    assert r.status_code == 400
    assert 'Sample Folder' in r.get_json()["error"]
    assert _names(client, SCOPE) == ['Sample Folder'], "the refused create must not have written"


def test_a_name_that_differs_only_in_case_is_still_a_duplicate(client):
    """The listing sorts case-insensitively, so `demos` and `Demos` would render as two rows
    the eye reads as one."""
    _mk(client, SCOPE, "Demos")
    assert client.post(f"/folders/{SCOPE}", json={"name": "demos"}).status_code == 400


def test_an_empty_name_is_refused(client):
    """Blank, whitespace-only and absent are one case: after collapsing, there is no label."""
    for body in ({"name": ""}, {"name": "   \n  "}, {}):
        r = client.post(f"/folders/{SCOPE}", json=body)
        assert r.status_code == 400, f"{body!r} should not make a folder"
    assert _names(client, SCOPE) == []


def test_an_absurdly_long_name_is_refused_at_the_route(client):
    """🔴 THE ROUTE'S OWN GUARD, AHEAD OF THE STORE'S TRUNCATION. `_norm_name` would take a
    40 KB string and store its first 60 characters with no complaint, and silently accepting a
    novel as a label is the shape of surprise this project keeps paying for."""
    r = client.post(f"/folders/{SCOPE}", json={"name": "x" * (folders.MAX_NAME_LEN * 4 + 1)})
    assert r.status_code == 400
    assert str(folders.MAX_NAME_LEN) in r.get_json()["error"]
    assert _names(client, SCOPE) == []


def test_a_rename_to_an_absurdly_long_name_is_refused_too(client):
    """The same guard on the rename rule — it is the other door into `_norm_name`."""
    made = _mk(client, SCOPE, 'Sample Folder')
    r = client.post(f"/folders/{SCOPE}/{made['id']}",
                    json={"name": "x" * (folders.MAX_NAME_LEN * 4 + 1)})
    assert r.status_code == 400
    assert _names(client, SCOPE) == ['Sample Folder'], "the refused rename must not have written"


def test_a_merely_long_name_is_truncated_rather_than_refused(client):
    """The route's cap is a generous multiple of the store's on purpose, so trailing whitespace
    never 400s — which means everything between the two is TRUNCATED, not rejected. Pinned
    because it is the boundary the two guards share and neither one states alone."""
    made = _mk(client, SCOPE, "y" * (folders.MAX_NAME_LEN * 2))
    assert made["name"] == "y" * folders.MAX_NAME_LEN


# ── rename ───────────────────────────────────────────────────────────────────────────────

def test_a_rename_keeps_the_id_and_changes_the_name(client):
    """📌 One string write and no member moves — the entire payoff of keying on an id."""
    made = _mk(client, SCOPE, 'Sample Folder')
    r = client.post(f"/folders/{SCOPE}/{made['id']}", json={"name": "Best takes"})
    assert r.status_code == 200
    assert r.get_json() == {"id": made["id"], "name": "Best takes"}
    assert _names(client, SCOPE) == ["Best takes"]


def test_a_rename_carries_the_folder_s_members_with_it(client, tmp_path):
    """The assignment map references the id, so a rename must not disturb a single row. If it
    ever keyed on the name instead, a half-failed rename would scatter members to unfiled."""
    made = _mk(client, SCOPE, 'Sample Folder')
    client.post(f"/folders/{SCOPE}/assign", json={"refs": ["a.wav"], "folder": made["id"]})
    client.post(f"/folders/{SCOPE}/{made['id']}", json={"name": "Best takes"})
    assert folders.for_rows(tmp_path, SCOPE, [{"ref": "a.wav"}])[0]["folder"] == made["id"]


def test_renaming_onto_a_name_that_already_exists_is_refused(client):
    _mk(client, SCOPE, 'Sample Folder')
    other = _mk(client, SCOPE, "Rejects")
    r = client.post(f"/folders/{SCOPE}/{other['id']}", json={"name": 'Sample Folder'})
    assert r.status_code == 400
    assert 'Sample Folder' in r.get_json()["error"]
    assert _names(client, SCOPE) == ["Rejects", 'Sample Folder']


def test_renaming_a_folder_to_its_own_name_is_allowed(client):
    """A no-op rename is what a user gets by opening the box and pressing OK; it must not read
    as a collision with itself."""
    made = _mk(client, SCOPE, 'Sample Folder')
    r = client.post(f"/folders/{SCOPE}/{made['id']}", json={"name": 'Sample Folder'})
    assert r.status_code == 200 and r.get_json() == made


def test_renaming_a_folder_that_does_not_exist_is_refused(client):
    r = client.post(f"/folders/{SCOPE}/f_deadbeef", json={"name": 'Sample Folder'})
    assert r.status_code == 400
    assert r.get_json()["error"]


# ── delete ───────────────────────────────────────────────────────────────────────────────

def test_deleting_a_folder_reports_it_and_removes_it_from_the_listing(client):
    made = _mk(client, SCOPE, 'Sample Folder')
    r = client.delete(f"/folders/{SCOPE}/{made['id']}")
    assert r.status_code == 200
    assert r.get_json() == {"deleted": True}
    assert _names(client, SCOPE) == []


def test_deleting_a_folder_that_is_not_there_is_false_and_not_an_error(client):
    """Two tabs open on one list is the ordinary way to reach this, and the second delete must
    not present as a failure — there is nothing left to do and that is the desired state."""
    r = client.delete(f"/folders/{SCOPE}/f_deadbeef")
    assert r.status_code == 200
    assert r.get_json() == {"deleted": False}


def test_deleting_a_folder_keeps_its_contents_and_returns_them_to_unfiled(client, tmp_path):
    '🔴 THE GUARANTEE THE CONFIRM DIALOG MAKES IN WORDS. This route holds no path and cannot\n    reach an item even in principle — but *"Delete folder \'Sample Folder\' (2 items)?"* reads as\n    delete-all to anyone who has used any other program, so the promise that the items survive\n    is asserted here, through the routes and read back through the store.'
    made = _mk(client, SCOPE, 'Sample Folder')
    refs = ["a.wav", "b.wav"]
    assert client.post(f"/folders/{SCOPE}/assign",
                       json={"refs": refs, "folder": made["id"]}).get_json()["moved"] == 2
    rows = folders.for_rows(tmp_path, SCOPE, [{"ref": r} for r in refs])
    assert [r["folder"] for r in rows] == [made["id"], made["id"]]   # the premise

    assert client.delete(f"/folders/{SCOPE}/{made['id']}").get_json() == {"deleted": True}

    rows = folders.for_rows(tmp_path, SCOPE, [{"ref": r} for r in refs])
    assert [r["folder"] for r in rows] == [None, None], (
        "the members must come back UNFILED — still listed, still playable, just unlabeled")


# ── assign ───────────────────────────────────────────────────────────────────────────────

def test_filing_rows_reports_how_many_moved_and_echoes_the_folder(client, tmp_path):
    made = _mk(client, SCOPE, 'Sample Folder')
    r = client.post(f"/folders/{SCOPE}/assign",
                    json={"refs": ["a.wav", "b.wav", "c.wav"], "folder": made["id"]})
    assert r.status_code == 200
    assert r.get_json() == {"moved": 3, "folder": made["id"]}
    stamped = folders.for_rows(tmp_path, SCOPE, [{"ref": "a.wav"}, {"ref": "b.wav"},
                                                 {"ref": "c.wav"}])
    assert {r["folder"] for r in stamped} == {made["id"]}


def test_filing_rows_that_are_already_in_that_folder_moves_nothing(client):
    """Dropping a selection onto the folder it is already in is a normal miss-click, and the
    count is what the UI reports back — `moved: 3` for a no-op would be a lie on screen."""
    made = _mk(client, SCOPE, 'Sample Folder')
    body = {"refs": ["a.wav", "b.wav"], "folder": made["id"]}
    assert client.post(f"/folders/{SCOPE}/assign", json=body).get_json()["moved"] == 2
    assert client.post(f"/folders/{SCOPE}/assign", json=body).get_json()["moved"] == 0


def test_a_null_folder_unfiles_the_rows_and_counts_only_the_ones_that_moved(client, tmp_path):
    """`folder: null` is what the `↩ Unfiled` row and the divider drop-target send. The count is
    of rows that were actually filed — an already-unfiled row moved nothing."""
    made = _mk(client, SCOPE, 'Sample Folder')
    client.post(f"/folders/{SCOPE}/assign", json={"refs": ["a.wav"], "folder": made["id"]})
    r = client.post(f"/folders/{SCOPE}/assign",
                    json={"refs": ["a.wav", "never_filed.wav"], "folder": None})
    assert r.status_code == 200
    assert r.get_json() == {"moved": 1, "folder": None}
    assert folders.for_rows(tmp_path, SCOPE, [{"ref": "a.wav"}])[0]["folder"] is None


def test_filing_into_a_folder_that_does_not_exist_is_refused(client, tmp_path):
    r = client.post(f"/folders/{SCOPE}/assign",
                    json={"refs": ["a.wav"], "folder": "f_deadbeef"})
    assert r.status_code == 400
    assert r.get_json()["error"]
    assert folders.load(tmp_path)["assign"] == {}, "a refused move must not have written"


def test_refs_must_be_a_list(client):
    """A JSON body is whatever the client sent. `"a.wav"` is iterable, so a missing check would
    file six one-character refs and report `moved: 6`."""
    for body in ({"refs": "a.wav"}, {"refs": {"a.wav": 1}}, {}, {"refs": None}):
        r = client.post(f"/folders/{SCOPE}/assign", json=body)
        assert r.status_code == 400, f"{body!r} should not be accepted as a list of refs"
        assert "refs" in r.get_json()["error"]


def test_more_rows_than_MAX_REFS_PER_CALL_in_one_move_is_refused(client, tmp_path):
    """🔴 A COUNT CAP ON THE STORE IS NOT A CAP ON ONE REQUEST, and `clip_favorites` shipped
    with only the first. `MAX_ASSIGN_PER_SCOPE` bounds what ends up on disk; a JSON body may be
    128 MB, so without this the single POST is the hole."""
    made = _mk(client, SCOPE, 'Sample Folder')
    refs = [f"r{i}.wav" for i in range(folders_web.MAX_REFS_PER_CALL + 1)]
    r = client.post(f"/folders/{SCOPE}/assign", json={"refs": refs, "folder": made["id"]})
    assert r.status_code == 400
    assert str(folders_web.MAX_REFS_PER_CALL) in r.get_json()["error"]
    assert folders.load(tmp_path)["assign"] == {}, "nothing may be written before the refusal"


# ── 🔴 scope isolation, over HTTP ────────────────────────────────────────────────────────
#
# Scope is the DATASET, not the panel, and two views of one dataset share one set of folders by
# construction. The flip side is that two DIFFERENT datasets must not leak into each other —
# ten scopes live in one file, so every one of these is a same-file, different-key assertion.

def test_two_scopes_hold_their_own_folder_of_the_same_name(client):
    a = _mk(client, SCOPE, 'Sample Folder')
    b = _mk(client, OTHER, 'Sample Folder')
    assert a["id"] != b["id"], "same name, two datasets, two folders"
    assert _names(client, SCOPE) == ['Sample Folder']
    assert _names(client, OTHER) == ['Sample Folder']


def test_a_ref_filed_in_one_scope_is_still_unfiled_in_the_other(client, tmp_path):
    """Nothing stops two datasets naming a row the same thing — an upload and a song can both
    be `take_one.wav` — and filing one must not file the other."""
    a = _mk(client, SCOPE, 'Sample Folder')
    _mk(client, OTHER, 'Sample Folder')
    client.post(f"/folders/{SCOPE}/assign", json={"refs": ["take_one.wav"], "folder": a["id"]})
    assert folders.for_rows(tmp_path, SCOPE, [{"ref": "take_one.wav"}])[0]["folder"] == a["id"]
    assert folders.for_rows(tmp_path, OTHER, [{"ref": "take_one.wav"}])[0]["folder"] is None


def test_a_folder_id_from_another_scope_is_not_a_folder_here(client):
    """The id is unique across the whole file, so this one would resolve if `assign` looked it
    up globally — and a row would land in a folder no panel showing this dataset renders."""
    a = _mk(client, SCOPE, 'Sample Folder')
    r = client.post(f"/folders/{OTHER}/assign", json={"refs": ["a.wav"], "folder": a["id"]})
    assert r.status_code == 400


def test_deleting_a_folder_in_one_scope_leaves_every_other_scope_alone(client, tmp_path):
    """🔴 THE WHOLE-FILE READ-MODIFY-WRITE HAZARD, at the routes. Ten scopes share one file, so
    the blast radius of getting a mutation wrong is everyone else's folders."""
    a = _mk(client, SCOPE, 'Sample Folder')
    b = _mk(client, OTHER, 'Sample Folder')
    client.post(f"/folders/{OTHER}/assign", json={"refs": ["song.wav"], "folder": b["id"]})
    client.delete(f"/folders/{SCOPE}/{a['id']}")
    assert _names(client, OTHER) == ['Sample Folder']
    assert folders.for_rows(tmp_path, OTHER, [{"ref": "song.wav"}])[0]["folder"] == b["id"]


# ── 🔴 registered on the real app ────────────────────────────────────────────────────────

def test_all_five_folder_rules_are_registered_on_the_real_app():
    """🔴 A BLUEPRINT WRITTEN AND NEVER REGISTERED IS THE ONE FAILURE THE TESTS ABOVE CANNOT
    SEE — every one of them builds its own bare `Flask(__name__)` and registers the blueprint by
    hand, so they stay green while the shipping app serves 404 on all five. `create_app` is
    where it has to be wired; this asserts the URL map of the app the server actually runs.

    Method-by-method, not path-only: `/folders/<scope>/<fid>` carries the rename AND the delete,
    and losing one of the two would leave the path in the map."""
    import vocalis_server as vs
    have = {(str(r.rule), m)
            for r in vs.app.url_map.iter_rules()
            for m in (r.methods - {"HEAD", "OPTIONS"})}
    want = {
        ("/folders/<scope>", "GET"),
        ("/folders/<scope>", "POST"),
        ("/folders/<scope>/<fid>", "POST"),
        ("/folders/<scope>/<fid>", "DELETE"),
        ("/folders/<scope>/assign", "POST"),
    }
    missing = sorted(want - have)
    assert not missing, (
        f"these folder rules are not on the shipping app: {missing}. Every test in this file "
        f"registers the blueprint itself, so a missing `register_blueprint` in `create_app` is "
        f"invisible to all of them and visible to the browser immediately")


def test_the_assign_rule_wins_over_the_rename_rule_for_that_path(client):
    """`/folders/<scope>/assign` and `/folders/<scope>/<fid>` both match `…/assign` on POST, and
    which one Werkzeug picks is what decides whether a move is a move or an attempt to rename a
    folder called `assign`. Static beats dynamic — pinned, because the tie is resolved by the
    router's ranking rules and not by anything in our source."""
    made = _mk(client, SCOPE, 'Sample Folder')
    r = client.post(f"/folders/{SCOPE}/assign", json={"refs": ["a.wav"], "folder": made["id"]})
    assert r.status_code == 200
    assert r.get_json() == {"moved": 1, "folder": made["id"]}, (
        "the rename rule answered instead — it would 400 on an unknown id, or worse, rename a "
        "folder whose id happened to be `assign`")
