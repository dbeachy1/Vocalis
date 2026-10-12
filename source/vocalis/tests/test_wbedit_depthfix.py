"""Tests depth-aware edits, previews, and route validation."""
from __future__ import annotations

import copy
import io
import json

import pytest

# NOTE: no `from conftest import REPO_ROOT` here. Every older file in this directory
# carries one for its `sys.path` side effect, with a `# noqa: F401` to silence the unused
# import — but `tests/conftest.py:12` does that insert at MODULE level and pytest imports
# conftest before any test module beside it. The line is redundant and the suppression it
# needs is not free: `test_no_lint_ignore_code_has_grown` ratchets `# noqa` counts, and two
# new files would have pushed F401 past its ceiling. Raising a ceiling to fit new code is
# the thing that ratchet exists to refuse.

import vocalis_server as vs
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.formats import depthfix


def _entry(uid, **kw):
    e = {"uid": uid, "key": ["k%d" % uid], "keysecondary": [], "comment": "entry %d" % uid,
         "content": "text %d" % uid, "constant": False, "vectorized": False, "disable": False,
         "order": 100, "position": 0, "probability": 100, "useProbability": True, "group": ""}
    e.update(kw)
    return e


def _book(*entries):
    return {"name": "Sample World Book 1", "entries": {str(e["uid"]): e for e in entries}}


# ── the rule itself ──────────────────────────────────────────────────────────

def test_a_conditional_entry_at_the_top_moves_and_a_steady_constant_one_does_not():
    doc = _book(_entry(0, position=0), _entry(1, position=1), _entry(2, position=0, constant=True))
    p = depthfix.plan(doc)
    assert p["moving"] == 2 and p["left_stable"] == 1
    assert sorted(p["move"]) == ["0", "1"]


def test_entries_already_at_depth_and_entries_placed_elsewhere_are_left_alone():
    """Positions 2/3 are the author's note — itself injected at a depth, so already near the end
    — and 7 is Outlet, which is not auto-injected at all. Both were placed deliberately."""
    doc = _book(_entry(0, position=depthfix.POS_AT_DEPTH, depth=9),
                _entry(1, position=2), _entry(2, position=3), _entry(3, position=7))
    p = depthfix.plan(doc)
    assert p["moving"] == 0
    assert p["left_at_depth"] == 1 and p["left_placed"] == 3


def test_an_entry_with_no_position_at_all_is_never_guessed_at():
    """`None` is not "position 0". The fork's schema default was 0 and is now `atDepth`, and a
    book from some other tool may carry neither — so an absent position is left where it is."""
    doc = _book(_entry(0), _entry(1))
    del doc["entries"]["1"]["position"]
    p = depthfix.plan(doc)
    assert p["moving"] == 1 and p["left_placed"] == 1


def test_a_boolean_position_reads_as_unknown_rather_than_as_position_one():
    """`isinstance(True, int)` is True in Python, so `position: true` would otherwise read as
    After Char Defs and be silently rewritten."""
    doc = _book(_entry(0, position=True))
    assert depthfix.plan(doc)["moving"] == 0


@pytest.mark.parametrize("kw, why", [
    ({"useProbability": True, "probability": 50}, "triggers 50% of the time"),
    ({"probability": 50}, "triggers 50% of the time"),   # absent useProbability defaults TRUE
    ({"cooldown": 3}, "has a cooldown"),
    ({"delay": 5}, "has a delay"),
    ({"group": "moods"}, "is in an inclusion group"),
    # Check every condition that suppresses an always-injected entry.
    ({"delayUntilRecursion": 2}, "waits for a recursive scan"),
    ({"triggers": ["normal"]}, "only fires on some generation types"),
    ({"characterFilter": {"names": ["Test Character 2"], "tags": [], "isExclude": False}},
     "is filtered to certain characters"),
    ({"characterFilter": {"names": [], "tags": ["npc"], "isExclude": True}},
     "is filtered to certain characters"),
])
def test_an_always_injected_entry_that_does_not_fire_every_turn_is_reported(kw, why):
    """Classify entries using the fork’s activation order; disabled entries take precedence over other modes."""
    doc = _book(_entry(0, constant=True, **kw))
    p = depthfix.plan(doc)
    assert p["moving"] == 0, "not moved by default — it changes where an always-injected entry lands"
    assert p["offer_unstable"] == 1 and why in p["reasons"]
    assert depthfix.plan(doc, unstable=True)["moving"] == 1


def test_a_disabled_constant_entry_is_perfectly_stable_and_is_not_offered():
    """Checks that a disabled constant entry is perfectly stable and is not offered."""
    doc = _book(_entry(0, constant=True, disable=True, probability=50, cooldown=4))
    p = depthfix.plan(doc)
    assert p["moving"] == 0 and p["offer_unstable"] == 0 and p["left_stable"] == 1


def test_a_conditional_entry_at_the_example_messages_is_offered_but_not_moved_by_default():
    """↑EM/↓EM sit above the whole chat history too, so they do the same damage — but an entry
    parked there was usually put there on purpose, so it is offered rather than assumed."""
    doc = _book(_entry(0, position=depthfix.POS_EM_TOP), _entry(1, position=depthfix.POS_EM_BOTTOM))
    p = depthfix.plan(doc)
    assert p["moving"] == 0 and p["offer_examples"] == 2
    assert depthfix.plan(doc, examples=True)["moving"] == 2


def test_a_disabled_conditional_entry_still_moves():
    """Checks that a disabled conditional entry still moves."""
    assert depthfix.plan(_book(_entry(0, disable=True)))["moving"] == 1


# ── the transform ────────────────────────────────────────────────────────────

def test_apply_writes_exactly_three_fields_and_leaves_the_input_alone():
    doc = _book(_entry(0, position=0, order=42))
    before = copy.deepcopy(doc)
    p = depthfix.plan(doc, depth=7)
    out = depthfix.apply_plan(doc, p["move"], 7)
    assert doc == before, "the input document was mutated"
    moved = out["entries"]["0"]
    assert moved["position"] == depthfix.POS_AT_DEPTH and moved["depth"] == 7 and moved["role"] == 0
    for field in ("uid", "key", "keysecondary", "comment", "content", "constant", "order"):
        assert moved[field] == before["entries"]["0"][field]


def test_an_entry_that_already_names_a_role_keeps_it():
    doc = _book(_entry(0, role=2))
    out = depthfix.apply_plan(doc, depthfix.plan(doc)["move"], 4)
    assert out["entries"]["0"]["role"] == 2


def test_the_output_shares_no_objects_with_the_input():
    """Checks that the output shares no objects with the input."""
    doc = _book(_entry(0, position=0), _entry(1, position=2))
    out = depthfix.apply_plan(doc, depthfix.plan(doc)["move"], 4)
    for ckey in doc["entries"]:
        assert out["entries"][ckey] is not doc["entries"][ckey]


# ── the guard, mutated ───────────────────────────────────────────────────────

MUTATIONS = [
    ("the text of a moved entry", lambda o: o["entries"]["0"].__setitem__("content", "rewritten")),
    ("the text of an untouched entry", lambda o: o["entries"]["2"].__setitem__("content", "x")),
    ("a keyword list", lambda o: o["entries"]["0"].__setitem__("key", [])),
    ("a keyword list on an untouched entry", lambda o: o["entries"]["2"].__setitem__("key", [])),
    ("order", lambda o: o["entries"]["0"].__setitem__("order", 20)),
    ("constant", lambda o: o["entries"]["2"].__setitem__("constant", False)),
    ("a uid", lambda o: o["entries"]["2"].__setitem__("uid", 99)),
    ("an entry, deleted", lambda o: o["entries"].pop("2")),
    ("an entry, invented", lambda o: o["entries"].__setitem__("9", _entry(9))),
    ("the position of an untouched entry", lambda o: o["entries"]["2"].__setitem__("position", 4)),
    ("the depth written", lambda o: o["entries"]["0"].__setitem__("depth", 99)),
    ("the position written", lambda o: o["entries"]["0"].__setitem__("position", 0)),
    ("the role written", lambda o: o["entries"]["0"].pop("role")),
    ("the book's name", lambda o: o.__setitem__("name", "Something Else")),
]


@pytest.mark.parametrize("what, mutate", MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_verify_refuses_an_output_that_changed(what, mutate):
    doc = _book(_entry(0, position=0), _entry(2, position=0, constant=True))
    keys = depthfix.plan(doc)["move"]
    out = depthfix.apply_plan(doc, keys, 4)
    mutate(out)
    with pytest.raises(depthfix.DepthFixFailed):
        depthfix.verify(doc, out, keys, 4)


def test_verify_passes_the_transform_it_is_guarding():
    """Checks that verify passes the transform it is guarding."""
    doc = _book(_entry(0, position=0), _entry(2, position=0, constant=True))
    keys = depthfix.plan(doc)["move"]
    depthfix.verify(doc, depthfix.apply_plan(doc, keys, 4), keys, 4)


# ── the routes ───────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


def _post_book(c, doc, name="Sample World Book 1"):
    r = c.post("/wbedit/documents", json={"document": doc, "name": name})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["id"]


def test_the_preview_counts_without_writing(client):
    doc = _book(_entry(0), _entry(1), _entry(2, constant=True), _entry(3, position=depthfix.POS_EM_TOP))
    doc_id = _post_book(client, doc)
    j = client.get("/wbedit/documents/%s/depths" % doc_id).get_json()
    assert j["total"] == 4 and j["moving"]["base"] == 2
    assert j["moving"]["examples"] == 3 and j["offer_examples"] == 1
    assert j["default_depth"] == depthfix.DEFAULT_DEPTH
    # nothing was written
    assert client.get("/wbedit/documents/%s" % doc_id).get_json()["latest"] == 0


def test_the_preview_says_how_many_are_left_alone_and_why(client):
    """Checks that the preview says how many are left alone and why."""
    doc = _book(_entry(0), _entry(1),                        # move
                _entry(2, constant=True),                    # steady -> stable
                _entry(3, position=depthfix.POS_AT_DEPTH),   # already at depth
                _entry(4, position=2),                       # placed deliberately
                _entry(5, position=depthfix.POS_EM_TOP))     # offered, not ticked
    doc_id = _post_book(client, doc)
    j = client.get("/wbedit/documents/%s/depths" % doc_id).get_json()

    assert j["total"] == 6 and j["moving"]["base"] == 2
    assert j["leaving"]["base"] == 4, "total - moving must agree with the server's own count"
    b = j["buckets"]["base"]
    assert b == {"stable": 1, "at_depth": 1, "placed": 1, "offered": 1}
    # every entry is in exactly one column, in every combination
    for key in ("base", "examples", "unstable", "both"):
        assert j["moving"][key] + j["leaving"][key] == j["total"], key
        assert sum(j["buckets"][key].values()) == j["leaving"][key], key
    # …and the ↑EM entry really does leave the `offered` bucket when its tick goes on.
    assert j["buckets"]["examples"]["offered"] == 0
    assert j["leaving"]["examples"] == 3


def test_the_preview_carries_no_entry_content(client):
    """I16 one layer out: these books are personal material and a count is the whole answer."""
    doc = _book(_entry(0, content="Test Character 1 keeps the ledger.", comment="Sample Entry 1",
                       key=["ledger"]))
    doc_id = _post_book(client, doc)
    body = client.get("/wbedit/documents/%s/depths" % doc_id).get_data(as_text=True)
    for secret in ("Test Character 1", "Sample Entry 1", "ledger"):
        assert secret not in body


def test_applying_mints_one_revision_and_moves_only_the_conditional_entries(client):
    doc = _book(_entry(0), _entry(1), _entry(2, constant=True))
    doc_id = _post_book(client, doc)
    r = client.post("/wbedit/documents/%s/depths" % doc_id, json={"depth": 6})
    assert r.status_code == 201, r.get_json()
    j = r.get_json()
    assert j["moved"] == 2 and j["depth"] == 6 and j["revision"] == 1
    content = client.get("/wbedit/documents/%s/revision/1" % doc_id).get_json()["content"]
    assert content["entries"]["0"]["position"] == depthfix.POS_AT_DEPTH
    assert content["entries"]["0"]["depth"] == 6
    assert content["entries"]["2"]["position"] == 0, "the steady constant entry was moved"
    # 🔴 The pre-fix revision is the undo, and it is what makes this safe to do without asking.
    old = client.get("/wbedit/documents/%s/revision/0" % doc_id).get_json()["content"]
    assert old["entries"]["0"]["position"] == 0


def test_the_content_of_every_entry_survives_the_move(client):
    doc = _book(_entry(0), _entry(1), _entry(2, constant=True))
    doc_id = _post_book(client, doc)
    client.post("/wbedit/documents/%s/depths" % doc_id, json={})
    after = client.get("/wbedit/documents/%s/revision/1" % doc_id).get_json()["content"]
    for ckey, entry in doc["entries"].items():
        for field in ("uid", "key", "comment", "content", "constant", "order"):
            assert after["entries"][ckey][field] == entry[field]


def test_a_depth_outside_the_editors_own_bounds_is_refused_not_clamped(client):
    doc_id = _post_book(client, _book(_entry(0)))
    for bad in (-1, depthfix.MAX_DEPTH + 1, "four", "  ", 1.5):
        r = client.post("/wbedit/documents/%s/depths" % doc_id, json={"depth": bad})
        assert r.status_code == 400, (bad, r.get_json())
    assert client.get("/wbedit/documents/%s" % doc_id).get_json()["latest"] == 0


def test_a_book_with_nothing_to_move_mints_no_revision(client):
    """An identical revision in the picker is a rollback target that does nothing."""
    doc_id = _post_book(client, _book(_entry(0, position=depthfix.POS_AT_DEPTH, depth=4)))
    r = client.post("/wbedit/documents/%s/depths" % doc_id, json={})
    assert r.status_code == 400
    assert client.get("/wbedit/documents/%s" % doc_id).get_json()["latest"] == 0


def test_a_character_card_is_refused_by_both_routes(client):
    card = {"spec": "chara_card_v2", "spec_version": "2.0",
            "data": {"name": "Test Character 2", "description": "d", "personality": "p", "scenario": "s",
                     "first_mes": "f", "mes_example": "m"}}
    r = client.post("/wbedit/documents", json={"document": card, "name": "Test Character 2"})
    doc_id = r.get_json()["id"]
    assert client.get("/wbedit/documents/%s/depths" % doc_id).status_code == 400
    assert client.post("/wbedit/documents/%s/depths" % doc_id, json={}).status_code == 400


def test_the_extras_are_off_unless_asked_for(client):
    doc = _book(_entry(0, position=depthfix.POS_EM_TOP),
                _entry(1, constant=True, probability=50, useProbability=True))
    doc_id = _post_book(client, doc)
    assert client.post("/wbedit/documents/%s/depths" % doc_id, json={}).status_code == 400
    r = client.post("/wbedit/documents/%s/depths" % doc_id,
                    json={"examples": True, "unstable": True})
    assert r.status_code == 201 and r.get_json()["moved"] == 2



def _book_with_junk():
    """Checks that book with junk."""
    return {"name": "Sample World Book 1",
            "entries": {"0": _entry(0, position=0), "7": None, "8": "not an entry"}}


def test_a_stray_non_entry_under_entries_does_not_fail_a_correct_transform():
    """Validate the transformed structure without blaming the transform for unrelated malformed input."""
    doc = _book_with_junk()
    p = depthfix.plan(doc)
    assert p["total"] == 1 and p["move"] == ["0"], "iter_entries should have skipped the junk"
    out = depthfix.apply_plan(doc, p["move"], 4)
    depthfix.verify(doc, out, p["move"], 4)          # must NOT raise
    assert out["entries"]["7"] is None and out["entries"]["8"] == "not an entry"


@pytest.mark.parametrize("what, mutate", [
    ("a null replaced with an entry", lambda o: o["entries"].__setitem__("7", _entry(7))),
    ("a stray string rewritten", lambda o: o["entries"].__setitem__("8", "something else")),
    ("a null blanked to an empty dict", lambda o: o["entries"].__setitem__("7", {})),
])
def test_a_stray_non_entry_that_was_CHANGED_is_still_refused(what, mutate):
    """Checks that a stray non entry that was changed is still refused."""
    doc = _book_with_junk()
    keys = depthfix.plan(doc)["move"]
    out = depthfix.apply_plan(doc, keys, 4)
    mutate(out)
    with pytest.raises(depthfix.DepthFixFailed):
        depthfix.verify(doc, out, keys, 4)


ROLE_AND_TYPE_MUTATIONS = [
    # 🔴 `role` WAS THE ONE WRITTEN FIELD WHOSE VALUE NOTHING CHECKED. `position` and `depth` were
    # pinned to exact values on a moved entry; `role` was checked only for BEING an int, so a
    # regression flattening every moved entry's role to System passed the guard and minted.
    ("the role of a moved entry, rewritten", lambda o: o["entries"]["0"].__setitem__("role", 2)),
    # Compare numeric depth values without treating `4.0` as the integer `4`.
    ("a float position", lambda o: o["entries"]["0"].__setitem__("position", 4.0)),
    ("a float depth", lambda o: o["entries"]["0"].__setitem__("depth", 4.0)),
    ("a boolean position", lambda o: o["entries"]["0"].__setitem__("position", True)),
]


@pytest.mark.parametrize("what, mutate", ROLE_AND_TYPE_MUTATIONS,
                         ids=[m[0] for m in ROLE_AND_TYPE_MUTATIONS])
def test_verify_refuses_a_written_field_whose_VALUE_is_wrong(what, mutate):
    doc = _book(_entry(0, position=0), _entry(2, position=0, constant=True))
    keys = depthfix.plan(doc)["move"]
    out = depthfix.apply_plan(doc, keys, 4)
    mutate(out)
    with pytest.raises(depthfix.DepthFixFailed):
        depthfix.verify(doc, out, keys, 4)


def test_verify_refuses_a_moved_entry_whose_named_role_was_replaced():
    """`apply_plan`'s headline claim is "an entry that already names a role keeps it", and that
    claim was the only one of its three writes the guard could not falsify."""
    doc = _book(_entry(0, position=0, role=2))
    keys = depthfix.plan(doc)["move"]
    out = depthfix.apply_plan(doc, keys, 4)
    assert out["entries"]["0"]["role"] == 2
    out["entries"]["0"]["role"] = 0
    with pytest.raises(depthfix.DepthFixFailed):
        depthfix.verify(doc, out, keys, 4)


def test_an_always_injected_entry_that_never_fires_at_all_is_not_offered():
    """Checks that an always injected entry that never fires at all is not offered."""
    doc = _book(_entry(0, constant=True, probability=0))
    p = depthfix.plan(doc)
    assert p["offer_unstable"] == 0 and p["left_stable"] == 1 and p["moving"] == 0
    assert depthfix.plan(doc, unstable=True)["moving"] == 0


# ── Route-level validation ────────────────────────────────────────────────

def test_the_route_actually_calls_verify(client, monkeypatch):
    """Checks that the route actually calls verify."""
    doc_id = _post_book(client, _book(_entry(0, position=0)))
    called = []

    def refuse(before, after, keys, depth):
        called.append((sorted(keys), depth))
        raise depthfix.DepthFixFailed("planted by the test")

    monkeypatch.setattr(web_wbedit.depthfix, "verify", refuse)
    r = client.post(f"/wbedit/documents/{doc_id}/depths", json={"depth": 6})
    assert called == [(["0"], 6)], "the route never called verify with the plan it built"
    assert r.status_code == 500, r.get_json()
    assert "planted by the test" in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 0, \
        "a refused rewrite still minted a revision"


def test_a_book_with_a_stray_null_entry_can_still_be_fixed_through_the_route(client):
    """The end-to-end arm of the `verify` false alarm: this answered 500 before, over a book the
    upload door, the classifier and the preview had all accepted."""
    doc_id = _post_book(client, _book_with_junk())
    r = client.post(f"/wbedit/documents/{doc_id}/depths", json={})
    assert r.status_code == 201, r.get_json()
    content = client.get(f"/wbedit/documents/{doc_id}/revision/1").get_json()["content"]
    assert content["entries"]["0"]["position"] == depthfix.POS_AT_DEPTH
    assert content["entries"]["7"] is None and content["entries"]["8"] == "not an entry"


def _add_an_entry(client, doc_id, at, comment="second"):
    return client.post(f"/wbedit/documents/{doc_id}/entry?revision={at}",
                       json={"comment": comment})


def test_fixing_an_older_revision_is_refused_rather_than_rolling_the_head_back(client):
    """Reject a transform based on an older revision so applying it cannot replace newer head content."""
    doc_id = _post_book(client, _book(_entry(0, position=0)))
    assert _add_an_entry(client, doc_id, 0).status_code == 201
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 1

    r = client.post(f"/wbedit/documents/{doc_id}/depths?revision=0", json={})
    assert r.status_code == 409, r.get_json()
    body = r.get_json()
    assert body["conflict"] is True and body["revision"] == 0 and body["latest"] == 1
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 1, \
        "a refused fix still minted a revision"
    head = client.get(f"/wbedit/documents/{doc_id}/revision/1").get_json()["content"]
    assert len(head["entries"]) == 2, "the revision the refusal protected is still the head"


def test_fixing_the_head_is_of_course_still_allowed(client):
    """Checks that fixing the head is of course still allowed."""
    doc_id = _post_book(client, _book(_entry(0, position=0)))
    assert _add_an_entry(client, doc_id, 0).status_code == 201
    r = client.post(f"/wbedit/documents/{doc_id}/depths?revision=1", json={})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["revision"] == 2


def _one_entry_file():
    body = json.dumps({"uid": 41, "key": ["k"], "content": "t", "comment": "c"}).encode()
    return {"file": (io.BytesIO(body), "one.json")}


@pytest.mark.parametrize("door", ["entry", "entry/import"])
def test_the_other_two_mint_routes_refuse_a_stale_base_too(client, door):
    """Checks that the other two mint routes refuse a stale base too."""
    doc_id = _post_book(client, _book(_entry(0, position=0)))
    assert _add_an_entry(client, doc_id, 0).status_code == 201       # the head is now 1
    if door == "entry":
        r = client.post(f"/wbedit/documents/{doc_id}/entry?revision=0", json={"comment": "x"})
    else:
        r = client.post(f"/wbedit/documents/{doc_id}/entry/import?revision=0",
                        data=_one_entry_file(), content_type="multipart/form-data")
    assert r.status_code == 409, (door, r.get_json())
    assert r.get_json()["latest"] == 1
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 1


def test_the_refusal_says_which_kind_of_nothing_it_is(client):
    """Checks that the refusal says which kind of nothing it is."""
    only_extras = _post_book(client, _book(_entry(0, position=0, constant=True, probability=50)))
    r = client.post(f"/wbedit/documents/{only_extras}/depths", json={})
    assert r.status_code == 400
    j = r.get_json()
    assert j["offered"] == 1 and "tick one of the boxes" in j["error"]
    assert "no entry in this book is sitting above" not in j["error"]
    assert client.post(f"/wbedit/documents/{only_extras}/depths",
                       json={"unstable": True}).status_code == 201

    # Check the document’s own name as well as its upload label.
    settled_doc = dict(_book(_entry(0, position=depthfix.POS_AT_DEPTH, depth=4)),
                       name="Already Deep")
    settled = _post_book(client, settled_doc, name="Already Deep")
    r2 = client.post(f"/wbedit/documents/{settled}/depths", json={})
    assert r2.status_code == 400 and r2.get_json()["offered"] == 0
    assert "no entry in this book is sitting above" in r2.get_json()["error"]


def test_the_preview_offers_are_per_tick_combination(client):
    """Checks that the preview offers are per tick combination."""
    doc_id = _post_book(client, _book(
        _entry(0, position=0, constant=True, probability=50),
        _entry(1, position=depthfix.POS_EM_TOP, constant=True, probability=50),
    ))
    p = client.get(f"/wbedit/documents/{doc_id}/depths").get_json()
    assert p["offers"]["base"] == {"examples": 1, "unstable": 1}
    assert p["offers"]["examples"] == {"examples": 0, "unstable": 2}, \
        "the always-injected offer has to be recounted once the examples tick is on"
    assert p["offers"]["both"] == {"examples": 0, "unstable": 0}
    assert p["moving"] == {"base": 0, "examples": 0, "unstable": 1, "both": 2}
    # the flat pair an older client reads is still the base plan's, unchanged
    assert p["offer_examples"] == 1 and p["offer_unstable"] == 1


@pytest.mark.parametrize("depth", [0, 9999])
def test_the_bounds_themselves_are_accepted(client, depth):
    """Checks that the bounds themselves are accepted."""
    doc_id = _post_book(client, _book(_entry(0, position=0)), name=f"Book {depth}")
    r = client.post(f"/wbedit/documents/{doc_id}/depths", json={"depth": depth})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["depth"] == depth
    content = client.get(f"/wbedit/documents/{doc_id}/revision/1").get_json()["content"]
    assert content["entries"]["0"]["depth"] == depth


def test_a_section_chunk_file_is_refused_by_both_routes(client):
    """Checks that a section chunk file is refused by both routes."""
    chunk = {"section_name": "A", "entries": [
        {"uid": 0, "keys": ["k"], "content": "t", "position": 0}]}
    doc_id = _post_book(client, chunk, name="A chunk")
    for call in (lambda: client.get(f"/wbedit/documents/{doc_id}/depths"),
                 lambda: client.post(f"/wbedit/documents/{doc_id}/depths", json={})):
        r = call()
        assert r.status_code == 400, r.get_json()
        assert "compiled World Book" in r.get_json()["error"]
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 0


def test_the_preview_reads_the_revision_it_was_asked_for(client):
    """`wb/open.js` appends `?revision=` to BOTH depths routes and nothing pinned that it is read.
    Dropping the argument from `_compiled_book` would have gone unnoticed."""
    doc_id = _post_book(client, _book(_entry(0, position=0)))
    assert _add_an_entry(client, doc_id, 0).status_code == 201
    p0 = client.get(f"/wbedit/documents/{doc_id}/depths?revision=0").get_json()
    p1 = client.get(f"/wbedit/documents/{doc_id}/depths?revision=1").get_json()
    assert (p0["revision"], p0["total"]) == (0, 1)
    assert (p1["revision"], p1["total"]) == (1, 2)


def test_the_left_alone_buckets_in_the_APPLY_response_are_the_ones_the_client_prints(client):
    """The success line says "· N always-injected left at the top", built from `left_stable`, and
    nothing asserted that field carried that number rather than one of its two neighbors."""
    doc_id = _post_book(client, _book(
        _entry(0, position=0),
        _entry(1, position=0, constant=True),
        _entry(2, position=depthfix.POS_AT_DEPTH, depth=4),
        _entry(3, position=depthfix.POS_AN_TOP),
        _entry(4, position=depthfix.POS_OUTLET),
    ))
    j = client.post(f"/wbedit/documents/{doc_id}/depths", json={}).get_json()
    assert j["moved"] == 1 and j["total"] == 5
    assert j["left_stable"] == 1, "the always-injected steady one"
    assert j["left_at_depth"] == 1, "the one already at a depth"
    assert j["left_placed"] == 2, "the author's note and the outlet"


@pytest.mark.parametrize("call", ["preview", "apply"])
def test_a_locked_vault_is_a_423_from_both_depths_routes(client, call):
    """Both depth routes return 423 for a locked vault rather than misreporting missing content."""
    import vault_fs
    from unittest.mock import patch

    doc_id = _post_book(client, _book(_entry(0, position=0)))

    class Locked(Exception):
        pass

    def refuse(*a, **k):
        raise Locked()

    with patch.object(vault_fs, "locked_exc", lambda: Locked), \
            patch.object(vault_fs, "read_text", refuse), \
            patch.object(vault_fs, "read_bytes", refuse):
        r = (client.get(f"/wbedit/documents/{doc_id}/depths") if call == "preview"
             else client.post(f"/wbedit/documents/{doc_id}/depths", json={}))
    assert r.status_code == 423, r.get_json()
    assert r.get_json()["locked"] is True
    # and nothing was written on the way to finding out
    assert client.get(f"/wbedit/documents/{doc_id}").get_json()["latest"] == 0
