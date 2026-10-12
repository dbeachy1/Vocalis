"""Tests for sending document changes to the SillyTavern extension. They cover single-winner claims, sweep exclusion, retry-safe reports, and the extension response contract."""
from __future__ import annotations

import time

import pytest

from conftest import REPO_ROOT, lock_the_vault  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import paths
from wbedit import pairing, push, sweep
from wbedit.store import DocumentStore

BOOK = {"entries": {"0": {"uid": 0, "key": ["ledger"], "content": "He keeps the ledger."}}}
CHUNK = {"section": "A", "entries": [{"keys": ["ledger"], "content": "He keeps it."}]}
CARD = {"spec": "chara_card_v2",
        "data": {"name": "Test_Character", "description": "An accountant.", "first_mes": "Hello.",
                 "extensions": {"world": ""}}}
MIRRORED = {"spec": "chara_card_v2",
            "data": {"name": "Test_Character", "description": "An accountant.",
                     "extensions": {"world": 'Test World Book 1'},
                     "character_book": {"name": 'Test World Book 1',
                                        "entries": [{"keys": ["k"], "content": "c"}]}}}


@pytest.fixture(autouse=True)
def _fresh():
    """🔴 MODULE-LEVEL STATE, RESET AROUND EVERY TEST — a leftover in-flight job would make the
    next test's `request()` fail for the wrong reason, and it would look like the refusal working."""
    for mod, attrs in ((push, ("_job", "_running", "_result")), (sweep, ("_result",))):
        for a in attrs:
            setattr(mod, a, None)
    push._started_at = push._job_at = sweep._started_at = sweep._seen_at = sweep._requested_at = 0.0
    sweep._requested = False
    yield
    for mod, attrs in ((push, ("_job", "_running", "_result")), (sweep, ("_result",))):
        for a in attrs:
            setattr(mod, a, None)
    push._started_at = push._job_at = sweep._started_at = sweep._seen_at = sweep._requested_at = 0.0
    sweep._requested = False


# ───────────────────────────────────────────── the coordinator

def test_only_one_tab_can_claim_a_send():
    """Only one extension tab may claim a send at a time, preventing duplicate writes and lost updates."""
    push.request("d1", 3, kind="card", name="Test_Character")
    first = push.claim()
    assert first is not None and first["id"] == "d1"
    assert push.claim() is None, "a second tab claimed the same send"


def test_a_second_send_is_refused_while_one_is_in_flight():
    """🔴 REFUSED, NOT QUEUED. A queue would have to survive a restart to mean anything, and a
    write into his install revived from disk — for a revision he has since replaced — is a
    surprise this product does not get to spring."""
    assert push.request("d1", 1, kind="card", name="A") is True
    assert push.request("d2", 1, kind="card", name="B") is False, "two sends were accepted"
    push.claim()
    assert push.request("d2", 1, kind="card", name="B") is False, \
        "a send was accepted while one was in flight"


def test_an_abandoned_send_ages_out(monkeypatch):
    """⚠️ Without the ceiling, one dropped request wedges the feature forever: every later Send is
    refused as "already running" with no way back short of restarting Vocalis."""
    push.request("d1", 1, kind="card", name="A")
    push.claim()
    assert push.status()["running"] is not None
    monkeypatch.setattr(push.time, "time", lambda: push._started_at + push.STALE_RUN_S + 1)
    assert push.status()["running"] is None
    assert push.request("d2", 1, kind="card", name="B") is True


def test_finishing_records_the_outcome():
    push.request("d1", 4, kind="worldbook", name='Test World Book 1')
    push.claim()
    push.finish({"ok": True, "created": False})
    s = push.status()
    assert s["running"] is None and s["pending"] is None
    assert s["last"]["ok"] is True


def test_a_canceled_request_does_not_fire_when_a_tab_opens():
    """🔴 An uncollected send that fires an hour later is an unannounced WRITE into his install,
    of a revision he may have replaced twice since."""
    push.request("d1", 1, kind="card", name="A")
    push.cancel()
    assert push.claim() is None


# ───────────────────────────────────────────── 7.0-m4w: a hidden tab is not a missing tab

def test_a_send_waits_out_a_throttled_tab(monkeypatch):
    """A send remains pending long enough for a hidden browser tab to reach its throttled polling interval."""
    push.request("d1", 1, kind="card", name="Test_Character")
    monkeypatch.setattr(push.time, "time", lambda: push._job_at + 120)
    assert push.status()["pending"] is not None, "a queued send was dropped while a tab was merely slow"
    assert push.claim() is not None, "the tab checked in and found nothing to do"


def test_an_uncollected_send_gives_up_eventually_and_says_so(monkeypatch):
    """⚠️ Waiting is bounded. Collecting this performs a WRITE into his install, so "an hour later,
    forgotten" is not an outcome — `PENDING_S` is the ceiling and the giving-up is *reported*."""
    push.request("d1", 1, kind="card", name="Test_Character")
    monkeypatch.setattr(push.time, "time", lambda: push._job_at + push.PENDING_S + 1)
    s = push.status()
    assert s["pending"] is None and s["running"] is None
    assert s["last"]["ok"] is False and s["last"]["expired"] is True
    assert "Test_Character" in s["last"]["reason"], "the message does not say WHICH document went nowhere"
    assert push.claim() is None, "an expired job was still collectable"


def test_an_expired_send_never_reports_the_previous_send_s_result(monkeypatch):
    """An expired send records its outcome before a later send starts, so stale success cannot be displayed."""
    push.request("d1", 1, kind="card", name="Test_Character")
    push.claim()
    push.finish({"ok": True, "created": False})
    assert push.status()["last"]["ok"] is True                       # the good one, genuinely

    push.request("d2", 1, kind="worldbook", name='Test World Book 1')
    monkeypatch.setattr(push.time, "time", lambda: push._job_at + push.PENDING_S + 1)
    last = push.status()["last"]
    assert last["ok"] is False, "an unsent document was reported using the previous send's success"
    assert 'Test World Book 1' in last["reason"]


def test_a_dropped_run_never_reports_the_previous_send_s_result(monkeypatch):
    """🔴 The same hole on the in-flight path, and it has always been reachable: close the tab
    mid-write and `_in_flight_locked()` expired the run silently, leaving the last success standing.

    ⚠️ The wording has to be honest about what it does NOT know — the extension took the job, so the
    write may or may not have landed. Saying "not sent" would be a guess.
    """
    push.request("d1", 1, kind="card", name="Test_Character")
    push.claim()
    push.finish({"ok": True, "created": False})

    push.request("d2", 1, kind="worldbook", name='Test World Book 1')
    push.claim()
    monkeypatch.setattr(push.time, "time", lambda: push._started_at + push.STALE_RUN_S + 1)
    last = push.status()["last"]
    assert last["ok"] is False, "a dropped write was reported using the previous send's success"
    assert last["expired"] is True and 'Test World Book 1' in last["reason"]
    assert "may or may not" in last["reason"], "it claims to know whether the write landed"


# ───────────────────────────────────────────── the routes

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def auth(client):
    return {"Authorization": f"Bearer {pairing.rotate()}"}


@pytest.fixture
def store(client):
    return DocumentStore(paths.WBEDIT_DIR)


def _import(store, content, *, kind, st_ref, name):
    d, _ = store.import_from_st(content, kind=kind, st_ref=st_ref, name=name,
                                focus={}, world_ref="")
    return d


def test_the_poll_carries_the_job_and_never_the_document(client, auth, store):
    """🔴 A 5s HEARTBEAT MUST NOT CARRY HIS PROSE. The poll answer ends up in proxy logs and
    devtools panes; the content comes over `/pair/plan`, which is the authenticated document
    channel I16 already allows bodies on."""
    d = _import(store, BOOK, kind="worldbook", st_ref='Test World Book 1', name='Test World Book 1')
    client.post(f"/wbedit/documents/{d.id}/send", json={})

    body = client.get("/pair/poll", headers=auth).get_json()
    assert body["push"]["id"] == d.id
    assert "He keeps the ledger" not in str(body)
    assert client.get("/pair/poll", headers=auth).get_json()["push"] is None, \
        "the send was handed out twice"


def test_a_send_and_a_sweep_are_never_handed_out_together(client, auth, store):
    """A sweep and a send never run concurrently, while the pending window remains longer than the sweep lease."""
    d = _import(store, BOOK, kind="worldbook", st_ref='Test World Book 1', name='Test World Book 1')
    sweep.request()
    client.post(f"/wbedit/documents/{d.id}/send", json={})

    first = client.get("/pair/poll", headers=auth).get_json()
    assert first["sweep"] is True and first["push"] is None, "both jobs went out at once"

    # The sweep is now RUNNING. A second tab polling must not be handed the send.
    second = client.get("/pair/poll", headers=auth).get_json()
    assert second["sweep"] is False, "the sweep went out twice"
    assert second["push"] is None, "a send was handed out while a sweep was still running"

    # …and it is PENDING, not dropped — the distinction the original test was protecting.
    assert client.get("/wbedit/st-push").get_json()["pending"]["id"] == d.id

    # Once the sweep reports, the send goes out on the next poll.
    sweep.finish({"books": 1, "cards": 0, "personas": 0, "unchanged": 0, "failed": []})
    third = client.get("/pair/poll", headers=auth).get_json()
    assert third["push"]["id"] == d.id, "the send never went out after the sweep ended"

    assert sweep.STALE_RUN_S < push.PENDING_S, (
        "a sweep can now outlive a pending send, so blocking the send behind it would falsely "
        "report failure for a completed send — the exact bug the first assertion prevents")


def test_the_plan_route_carries_the_content_and_needs_the_token(client, auth, store):
    d = _import(store, BOOK, kind="worldbook", st_ref='Test World Book 1', name='Test World Book 1')
    assert client.get(f"/pair/plan/{d.id}").status_code == 401, "the plan answered without a token"
    body = client.get(f"/pair/plan/{d.id}", headers=auth).get_json()
    assert body["kind"] == "worldbook" and body["target"] == 'Test World Book 1'
    assert body["book"] == BOOK
    assert body["revision"] == d.latest


def test_the_plan_serves_the_revision_asked_for(client, auth, store):
    """📌 Sending an older revision is how an overwrite in SillyTavern gets undone (§8), so a
    default-to-latest here would defeat the recovery path it exists for."""
    d = _import(store, BOOK, kind="worldbook", st_ref='Test World Book 1', name='Test World Book 1')
    n = d.latest
    later = dict(BOOK, entries={"0": {"uid": 0, "key": ["ledger"], "content": "Rewritten."}})
    d2, _ = store.import_from_st(later, kind="worldbook", st_ref='Test World Book 1', name='Test World Book 1',
                                 focus={}, world_ref="")
    assert d2.latest > n, "the fixture did not actually mint a second revision"
    first = client.get(f"/pair/plan/{d.id}?revision={n}", headers=auth).get_json()
    assert first["book"] == BOOK, "an older revision came back as the latest one"
    assert first["revision"] == n


def test_a_mirrored_lorebook_is_dropped_and_named(client, auth, store):
    """🔴 The whole reason the plan is built on this side. Sent, it lands, reports success, and is
    re-baked over by his next save in SillyTavern — silent and delayed."""
    d = _import(store, MIRRORED, kind="card", st_ref="Test_Character.png", name="Test_Character")
    body = client.get(f"/pair/plan/{d.id}", headers=auth).get_json()
    assert "character_book" not in body["merge"]["data"]
    assert body["dropped"] and 'Test World Book 1' in body["dropped"][0]


def test_what_will_not_be_sent_is_known_on_the_press(client, store):
    """🔴 BEFORE THE WRITE, NOT AFTER. The dropped list rides in the job so the status line carries
    it for the whole send, rather than appearing in a summary he has stopped looking at."""
    d = _import(store, MIRRORED, kind="card", st_ref="Test_Character.png", name="Test_Character")
    s = client.post(f"/wbedit/documents/{d.id}/send", json={}).get_json()
    assert s["pending"]["dropped"], "the press did not say what it would leave out"


def test_an_unsendable_document_is_refused_on_the_press(client, store):
    """📌 A section chunk file is not a World Book. The message tells him what to do instead, and
    it arrives on the click rather than five seconds later."""
    d = _import(store, CHUNK, kind="worldbook", st_ref="", name="A_Guilds")
    r = client.post(f"/wbedit/documents/{d.id}/send", json={})
    assert r.status_code == 400
    assert "assemble" in r.get_json()["error"].lower()
    assert push.status()["pending"] is None, "a refused send was still recorded"


def test_a_second_press_while_one_is_running_is_a_409(client, store):
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    assert client.post(f"/wbedit/documents/{d.id}/send", json={}).status_code == 200
    r = client.post(f"/wbedit/documents/{d.id}/send", json={})
    assert r.status_code == 409
    assert r.get_json()["error"]


def test_the_button_reports_that_nothing_is_listening(client, store):
    """200 with the status, not an error — "no tab open" is a real state with an obvious fix, and
    a 409 for it would read as a fault in Vocalis. Same contract as the import button."""
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    r = client.post(f"/wbedit/documents/{d.id}/send", json={})
    assert r.status_code == 200
    assert client.get("/wbedit/st-push").get_json()["connected"] is False


def test_a_failed_send_reports_and_ends_the_run(client, auth, store):
    """⚠️ Only this call ends the run, and only one send may be in flight — so a failure that
    stayed silent would block every later send until the timeout."""
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    client.post("/pair/push", headers=auth,
                json={"ok": False, "reason": "SillyTavern refused the write", "id": d.id})
    s = client.get("/wbedit/st-push").get_json()
    assert s["running"] is None
    assert s["last"]["ok"] is False and s["last"]["reason"] == "SillyTavern refused the write"


def test_a_garbled_push_report_still_ends_the_run(client, auth, store):
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    assert client.post("/pair/push", headers=auth,
                       json={"ok": "yes please", "revision": "three"}).status_code == 200
    s = client.get("/wbedit/st-push").get_json()
    assert s["running"] is None
    assert s["last"]["ok"] is False, "a non-boolean ok was read as success"
    assert s["last"]["reason"], "a failure with no reason must still say something"


# ── 7.4 / §9a.33 · a card SillyTavern has never seen ─────────────────────────

def _upload(store, content, *, name):
    """A directly uploaded card has no SillyTavern reference but remains eligible for a send plan."""
    return store.create(content, name=name, kind="card", source="upload")


def test_the_plan_for_a_card_st_has_never_seen_is_a_create(client, auth, store):
    d = _upload(store, CARD, name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    plan = client.get(f"/pair/plan/{d.id}", headers=auth).get_json()
    assert plan["kind"] == "card" and plan["create"] is True
    assert plan["card"], "the extension has nothing to import without the card itself"
    assert plan["name"] == "Test_Character"


def test_the_filename_sillytavern_chose_becomes_our_st_ref(client, auth, store):
    """🔴 WITHOUT THIS, THE SECOND SAVE CREATES A SECOND CHARACTER. Their `getPngName`
    disambiguates a collision (a second `Test_Character` becomes `Test_Character2`), so the key is not
    predictable from this side — it has to be reported and recorded, or every later send takes the
    create branch again and silently abandons the copy before it."""
    d = _upload(store, CARD, name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    client.post("/pair/push", headers=auth,
                json={"ok": True, "created": True, "ref": "Test_Character2.png", "id": d.id})
    assert store.get(d.id).st_ref == "Test_Character2.png"

    # …and the next send is an ordinary merge, addressed at the file that now exists.
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    plan = client.get(f"/pair/plan/{d.id}", headers=auth).get_json()
    assert plan.get("create") is None and plan["target"] == "Test_Character2.png"


def test_a_created_card_whose_picture_failed_still_records_the_reference(client, auth, store):
    """A created card keeps its reference when picture upload fails, so retrying does not duplicate the card."""
    d = _upload(store, CARD, name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    client.post("/pair/push", headers=auth,
                json={"ok": False, "reason": "the text was saved, but the picture did not go "
                                              "through", "created": True, "ref": "Test_Character.png",
                      "id": d.id})
    assert store.get(d.id).st_ref == "Test_Character.png"


def test_a_reference_never_overwrites_one_we_already_have(client, auth, store):
    """⚠️ An existing `st_ref` is SillyTavern's own identity for a document we swept from it
    (§8.1). A report naming a different one is a stale run or a bug, and repointing a whole
    history at another file on their disk is not a thing to do on either."""
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    client.post("/pair/push", headers=auth,
                json={"ok": True, "created": True, "ref": "SomethingElse.png", "id": d.id})
    assert store.get(d.id).st_ref == "Test_Character.png"


def test_an_unclaimed_report_cannot_plant_a_reference(client, auth, store):
    """A.4's rule reaches the new write too: nothing may change in the store on the strength of a
    report for a run nobody is waiting for."""
    d = _upload(store, CARD, name="Test_Character")
    client.post("/pair/push", headers=auth,
                json={"ok": True, "created": True, "ref": "Test_Character.png", "id": d.id})
    assert store.get(d.id).st_ref == ""


def test_a_push_report_never_carries_a_message_verbatim(client, auth, store):
    """🔴 I16 AT THE BOUNDARY. `merge-attributes` answers a validation failure with the validator's
    own string and a 500 with `exception.toString()` — either can quote a slice of the card."""
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    client.post("/pair/push", headers=auth, json={"ok": False, "reason": "x" * 5000})
    assert len(client.get("/wbedit/st-push").get_json()["last"]["reason"]) <= 200


def test_the_status_route_answers_while_the_vault_is_locked(client, monkeypatch):
    """It reads no documents. Going blank here takes away the pane's ability to say why.

    `lock_the_vault` makes every `vault_fs`
    accessor raise for the duration, which is what the sentence in the name claims.

    The state is set up BEFORE the lock deliberately: a route that answered 200 with an empty
    body while locked would pass a bare status-code check and still take away the one thing the
    pane needs, which is the reason it must not go blank.
    """
    push.request("d1", 2, kind="card", name="Test_Character")
    push.claim()
    push.finish({"ok": True, "id": "d1"})
    push.request("d2", 1, kind="worldbook", name='Test World Book 2')

    lock_the_vault(monkeypatch)

    r = client.get("/wbedit/st-push")
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body["pending"]["id"] == "d2", "the pending send vanished while the vault was locked"
    assert body["last"]["ok"] is True, "the last result vanished while the vault was locked"
    assert body["running"] is None
    assert "connected" in body, "the pane cannot say whether a tab is listening"


def test_a_missing_document_is_a_404_not_a_500(client, auth):
    assert client.get("/pair/plan/nope", headers=auth).status_code == 404


# ──────────────────────── §4.1 — a report can only end the run it is about

def test_a_late_report_cannot_overwrite_the_result_of_a_later_send():
    """A late report from an expired send cannot alter a later in-flight send or replace its recorded result."""
    assert push.request("A", 3, kind="card", name="Test_Character") is True
    assert push.claim()["id"] == "A"

    push._started_at = time.time() - (push.STALE_RUN_S + 1)     # age it past the ceiling
    assert push.status()["running"] is None, "the run should have been reaped"
    assert push.status()["last"].get("expired") is True

    assert push.request("B", 4, kind="card", name='Test Character 2') is True
    assert push.claim()["id"] == "B"

    push.finish({"ok": True, "id": "A"})                        # tab A, very late

    st = push.status()
    assert st["running"] is not None, "B's in-flight run was ended by a report about A"
    assert st["running"]["id"] == "B", "the wrong run is in flight"
    assert st["last"].get("expired") is True, "A's late success overwrote the honest result"


def test_a_report_with_nothing_in_flight_is_dropped_not_filed():
    """A `POST /pair/push {"ok": true}` from a caller that never claimed must not manufacture a
    success — the truthful `last` is whatever is already there."""
    before = push.status()["last"]
    push.finish({"ok": True, "wrote": "everything"})
    assert push.status()["last"] == before, "a success was invented from an unclaimed report"


def test_the_ordinary_report_still_ends_its_own_run():
    """⚠️ The guard must not break the path that matters — with or without an echoed id."""
    push.request("A", 3, kind="card", name="Test_Character")
    push.claim()
    push.finish({"ok": True, "id": "A"})
    assert push.status()["running"] is None and push.status()["last"]["ok"] is True


def test_a_report_that_echoes_no_id_still_ends_the_run_it_claimed():
    """The extension has always been allowed to report without echoing the id, so requiring one
    would break a tab mid-upgrade. Absent is ours; present-and-different is not."""
    push.request("C", 9, kind="worldbook", name='Test World Book 2')
    push.claim()
    push.finish({"ok": True})
    assert push.status()["running"] is None and push.status()["last"]["ok"] is True


# ──────────────────────── the same guard, reached over HTTP
#
# The tests above call `push.finish` directly. The HTTP route also has to reject an unclaimed
# report, so these cases exercise that boundary with a request.


def test_an_unclaimed_push_report_over_HTTP_cannot_render_a_success(client, auth, store):
    """A report without a claimed run cannot produce a successful status."""
    assert push.status()["running"] is None and push.status()["last"] is None
    r = client.post("/pair/push", headers=auth,
                    json={"ok": True, "id": "d1", "revision": 3, "created": True})
    assert r.status_code == 200, "the extension is not the thing to punish for a late report"
    st = client.get("/wbedit/st-push").get_json()
    assert st["last"] is None, "an unclaimed report over HTTP invented a success"
    assert st["running"] is None


#: The report must not clear `avatar_dirty` unless it ends a claimed run; direct-call cases do not
#: exercise this HTTP side effect.
def test_an_unclaimed_push_report_over_HTTP_has_no_SIDE_EFFECT_EITHER(client, auth, store):
    """A report without a claimed run cannot clear the document’s pending avatar update."""
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    store.put_avatar(d.id, b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    assert store.get(d.id).avatar_dirty is True, "the fixture did not mark the picture as new"

    assert push.status()["running"] is None
    r = client.post("/pair/push", headers=auth,
                    json={"ok": True, "avatar": True, "id": d.id})
    assert r.status_code == 200

    assert store.get(d.id).avatar_dirty is True, (
        "an unclaimed report cleared avatar_dirty — the next real send will not carry the new "
        "picture and SillyTavern keeps the old face")


def test_a_claimed_push_report_over_HTTP_still_does_both(client, auth, store):
    """⚠️ The guard must not break the path that matters, and this is the HTTP half of it."""
    d = _import(store, CARD, kind="card", st_ref="Test_Character.png", name="Test_Character")
    store.put_avatar(d.id, b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)

    r = client.post("/pair/push", headers=auth, json={"ok": True, "avatar": True, "id": d.id})
    assert r.status_code == 200
    st = client.get("/wbedit/st-push").get_json()
    assert st["last"]["ok"] is True and st["running"] is None
    assert store.get(d.id).avatar_dirty is False, "a real send did not clear the flag"


def test_a_sweep_report_with_nothing_claimed_cannot_invent_an_import():
    """The sibling in `sweep`, same finding: an unguarded report made the Library render
    "imported 12 books" for an import that never ran."""
    before = sweep.status()["last"]
    sweep.finish({"ok": True, "books": 12, "cards": 4})
    assert sweep.status()["last"] == before, "an import was invented from an unclaimed report"

    sweep.request()
    assert sweep.claim() is True
    sweep.finish({"ok": True, "books": 12})
    assert sweep.status()["last"]["books"] == 12, "a real sweep must still report"


def test_the_send_reports_what_it_actually_wrote_to(client, auth, store):
    """The completion response names the document the extension created or updated."""
    d = _upload(store, CARD, name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    client.post("/pair/push", headers=auth,
                json={"ok": True, "created": False, "wrote": "Test User at the keyboard", "id": d.id})

    last = client.get("/wbedit/st-push").get_json()["last"]
    assert last["wrote"] == "Test User at the keyboard"
    assert last["created"] is False, "and the branch travels with it, because that is the other half"


def test_a_report_without_a_subject_still_succeeds(client, auth, store):
    """Older extension reports without a subject name remain valid when the send succeeded."""
    d = _upload(store, CARD, name="Test_Character")
    client.post(f"/wbedit/documents/{d.id}/send", json={})
    client.get("/pair/poll", headers=auth)
    client.post("/pair/push", headers=auth, json={"ok": True, "created": True, "id": d.id})

    last = client.get("/wbedit/st-push").get_json()["last"]
    assert last["ok"] is True
    assert last["wrote"] == "", "absent means absent, never None — the pane tests it for truthiness"
