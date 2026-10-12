"""Tests the SillyTavern worldbook import request and sweep lifecycle. Only one tab may claim a pending sweep, and unchanged imports must not create duplicate revisions."""
from __future__ import annotations

import copy

import pytest

from conftest import REPO_ROOT, lock_the_vault  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import paths
from wbedit import pairing, sweep
from wbedit.store import DocumentStore

BOOK = {"entries": {"0": {"uid": 0, "key": ["ledger"], "content": "He keeps the ledger."}}}


@pytest.fixture(autouse=True)
def _fresh_sweep():
    """🔴 MODULE-LEVEL STATE, SO IT IS RESET AROUND EVERY TEST. Under `-n 16 --dist loadfile` this
    file lands on one worker, but the tests still share a process — and a leftover `requested`
    flag would make the next test's `claim()` succeed for the wrong reason."""
    sweep._requested = False
    sweep._requested_at = 0.0
    sweep._seen_at = 0.0
    sweep._started_at = 0.0
    sweep._result = None
    yield
    sweep._requested = False
    sweep._requested_at = 0.0
    sweep._seen_at = 0.0
    sweep._started_at = 0.0
    sweep._result = None


# ───────────────────────────────────────────── the coordinator

def test_nothing_is_connected_until_something_polls():
    """Connection status requires a recent extension poll. Show a clear disconnected state instead of treating silence as a pending import."""
    assert sweep.status()["connected"] is False
    sweep.note_poll()
    assert sweep.status()["connected"] is True


def test_a_stale_poll_stops_counting_as_connected(monkeypatch):
    sweep.note_poll()
    assert sweep.status()["connected"] is True
    monkeypatch.setattr(sweep.time, "time",
                        lambda: sweep._seen_at + sweep.LIVE_WINDOW_S + 1)
    assert sweep.status()["connected"] is False


def test_only_one_tab_can_claim_a_sweep():
    """🔴 THE ONE THAT MATTERS. Read-then-clear as two steps is this bug with more lines."""
    sweep.request()
    assert sweep.claim() is True, "the first poller did not get the sweep"
    assert sweep.claim() is False, "a second tab claimed the same sweep"


def test_claiming_marks_it_running_and_finishing_ends_it():
    sweep.request()
    assert sweep.status()["pending"] is True
    sweep.claim()
    s = sweep.status()
    assert s["pending"] is False and s["running"] is True
    sweep.finish({"books": 2, "cards": 1, "unchanged": 0, "failed": []})
    s2 = sweep.status()
    assert s2["running"] is False
    assert s2["last"]["books"] == 2


def test_an_abandoned_run_ages_out(monkeypatch):
    """The tab was closed mid-sweep. Without this the Library says "importing…" forever over
    something that already stopped — the same lie as reporting a result that never landed."""
    sweep.request()
    sweep.claim()
    assert sweep.status()["running"] is True
    monkeypatch.setattr(sweep.time, "time",
                        lambda: sweep._started_at + sweep.STALE_RUN_S + 1)
    assert sweep.status()["running"] is False


# ───────────────────────────────────────────── 7.0-m4w: a hidden tab is not a missing tab

def test_a_request_waits_out_a_throttled_tab(monkeypatch):
    """A hidden browser tab may throttle its polling interval. Keep a requested sweep pending until the tab claims it or the request is explicitly withdrawn."""
    sweep.request()
    monkeypatch.setattr(sweep.time, "time", lambda: sweep._requested_at + 120)
    assert sweep.status()["pending"] is True, "a queued import was dropped while a tab was merely slow"
    assert sweep.claim() is True


def test_an_uncollected_import_never_reports_the_previous_import_s_tally(monkeypatch):
    """🔴 Expiring in silence made the pane read the PREVIOUS run's summary — "imported 12 books"
    for an import that never happened. The pane's terminal test is "not pending and not running",
    and `last` is the only thing it has to describe what it just did."""
    sweep.request()
    sweep.claim()
    sweep.finish({"books": 12, "cards": 0, "personas": 0, "unchanged": 0, "failed": []})
    assert sweep.status()["last"]["books"] == 12                     # the real one

    sweep.request()
    monkeypatch.setattr(sweep.time, "time", lambda: sweep._requested_at + sweep.PENDING_S + 1)
    s = sweep.status()
    assert s["pending"] is False and s["running"] is False
    assert s["last"]["expired"] is True and s["last"]["books"] == 0, \
        "an import that never ran was reported using the previous run's tally"
    assert sweep.claim() is False, "an expired request was still collectable"


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


def test_the_poll_is_the_heartbeat_and_the_command_in_one_call(client, auth):
    """Two jobs, one request. The extension must poll for liveness regardless, so the pending
    answer rides along rather than doubling the traffic to learn nothing extra."""
    assert sweep.status()["connected"] is False
    r = client.get("/pair/poll", headers=auth)
    assert r.status_code == 200
    assert r.get_json()["sweep"] is False
    assert sweep.status()["connected"] is True, "polling did not register a live extension"

    sweep.request()
    assert client.get("/pair/poll", headers=auth).get_json()["sweep"] is True
    assert client.get("/pair/poll", headers=auth).get_json()["sweep"] is False, \
        "the sweep was handed out twice"


def test_the_button_reports_that_nothing_is_listening(client):
    """200 with the status, NOT an error. "No tab open" is a real state with an obvious fix; a
    409 here would read as a fault in Vocalis."""
    r = client.post("/wbedit/st-sweep", json={})
    assert r.status_code == 200
    assert r.get_json()["connected"] is False
    assert r.get_json()["pending"] is True


def test_the_button_reaches_the_extension(client, auth):
    client.get("/pair/poll", headers=auth)                  # a tab is open
    r = client.post("/wbedit/st-sweep", json={})
    assert r.get_json()["connected"] is True
    assert client.get("/pair/poll", headers=auth).get_json()["sweep"] is True


def test_a_finished_sweep_reports_counts_and_names_what_failed(client, auth):
    sweep.request()
    sweep.claim()
    r = client.post("/pair/sweep", headers=auth,
                    json={"books": 3, "cards": 2, "personas": 4, "unchanged": 1,
                          "errors": ['Sample Book']})
    assert r.status_code == 200
    s = client.get("/wbedit/st-sweep").get_json()
    assert s["running"] is False
    # 🔴 EXACT EQUALITY, DELIBERATELY. §8.3's personas were counted by the extension for a whole
    # milestone before the server carried the key, and the sweep reported "nothing to import" over
    # a successful pull. An `>=`-style check would have passed throughout. A fourth kind must
    # break this line.
    assert s["last"] == {"books": 3, "cards": 2, "personas": 4, "unchanged": 1,
                         "failed": ['Sample Book'], "at": s["last"]["at"]}


def test_a_kind_the_extension_counts_but_the_server_drops_is_invisible(client, auth):
    """🔴 The persona regression, pinned as its own fact rather than as a field in the dict above.

    The extension increments `tally.personas`; if `/pair/sweep` does not carry the key, the count
    reaches the UI as absent, the Library's message code renders "nothing to import", and the
    documents are sitting in the store the whole time. Nothing errors, nothing logs, and it looks
    exactly like a broken import.
    """
    sweep.request()
    sweep.claim()
    client.post("/pair/sweep", headers=auth, json={"personas": 2})
    assert client.get("/wbedit/st-sweep").get_json()["last"]["personas"] == 2


def test_a_sweep_report_never_carries_a_message_verbatim(client, auth):
    """🔴 I16 AT THE BOUNDARY. A fetch failure on the SillyTavern side can quote a window of a
    lorebook into its message — their own `b7350db26` was exactly that — and this body renders
    into the Vocalis UI. Names are already in the Library; a parser's error text is not."""
    sweep.request()
    sweep.claim()
    client.post("/pair/sweep", headers=auth,
                json={"books": 0, "cards": 0, "errors": ["x" * 5000]})
    failed = client.get("/wbedit/st-sweep").get_json()["last"]["failed"]
    assert len(failed[0]) <= 200, "an unbounded string was stored from the extension"


def test_a_garbled_sweep_report_still_ends_the_run(client, auth):
    """A sweep that dies halfway must not leave the Library spinning for five minutes."""
    sweep.request()
    sweep.claim()
    assert sweep.status()["running"] is True
    r = client.post("/pair/sweep", headers=auth, json={"books": "lots", "errors": "nope"})
    assert r.status_code == 200
    assert sweep.status()["running"] is False
    assert sweep.status()["last"]["books"] == 0


def test_the_status_route_answers_while_the_vault_is_locked(client, monkeypatch):
    """It reads no documents — it is the state of a conversation with the browser extension. Going
    blank here would take away the pane's ability to say WHY it is blank.

    `lock_the_vault` makes every `vault_fs` accessor raise for the duration. The test verifies
    that the route still returns its last tally while the vault is locked, rather than checking
    only the status code.

    The tally is filed before the lock on purpose: answering 200 with a blank body while locked
    would satisfy a bare status-code check and still leave the Library unable to say what
    happened, which is the failure this route's exemption from `_locked_guard` exists to prevent.
    """
    sweep.request()
    sweep.claim()
    sweep.finish({"books": 3, "cards": 1, "personas": 0, "unchanged": 2, "failed": []})

    lock_the_vault(monkeypatch)

    r = client.get("/wbedit/st-sweep")
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body["last"]["books"] == 3, "the last import's tally vanished while the vault was locked"
    assert body["pending"] is False
    assert "connected" in body, "the pane cannot say whether a tab is listening"


def test_an_unclaimed_sweep_report_over_HTTP_cannot_invent_an_import(client, auth):
    """🔴 `pair.py:242` calls `sweep.finish(...)` unconditionally, and every other test of this
    route claims first — so the "nothing in flight" branch had never been executed over HTTP.

    A token holder POSTing `{"books": 12}` with no import running would have the Library render
    *imported 12 books* for an import that never ran, and a late report from a reaped run would
    overwrite the honest tally of a later one.
    """
    assert sweep.status()["last"] is None
    r = client.post("/pair/sweep", headers=auth, json={"books": 12, "cards": 4, "personas": 2})
    assert r.status_code == 200, "the extension is not the thing to punish for a late report"
    st = client.get("/wbedit/st-sweep").get_json()
    assert st["last"] is None, "an unclaimed report over HTTP invented an import"
    assert st["running"] is False


def test_a_claimed_sweep_report_over_HTTP_still_files_its_tally(client, auth):
    """⚠️ The guard must not break the path that matters — the HTTP half of it."""
    client.post("/wbedit/st-sweep", json={})
    client.get("/pair/poll", headers=auth)
    assert sweep.status()["running"] is True

    assert client.post("/pair/sweep", headers=auth,
                       json={"books": 3, "cards": 1}).status_code == 200
    st = client.get("/wbedit/st-sweep").get_json()
    assert st["last"]["books"] == 3 and st["last"]["cards"] == 1
    assert st["running"] is False


def test_a_request_can_be_withdrawn(client, auth):
    """Withdrawing a pending sweep must clear the request so a later tab poll cannot start work the requester no longer expects."""
    client.post("/wbedit/st-sweep", json={})
    assert sweep.status()["pending"] is True
    r = client.delete("/wbedit/st-sweep")
    assert r.status_code == 200
    assert r.get_json()["pending"] is False
    assert client.get("/pair/poll", headers=auth).get_json()["sweep"] is False, \
        "a withdrawn sweep was still handed to the next tab that polled"


def test_a_tab_that_has_not_polled_yet_is_not_a_missing_tab(client, auth):
    """A request remains pending before the extension's first poll, so a tab that connects shortly afterward can still claim it."""
    r = client.post("/wbedit/st-sweep", json={})
    assert r.get_json()["connected"] is False        # nothing has polled yet
    assert r.get_json()["pending"] is True           # ...and the request survives that
    assert client.get("/pair/poll", headers=auth).get_json()["sweep"] is True


# ───────────────────────────────────────────── what makes the button pressable twice

def test_an_unchanged_document_mints_no_revision(tmp_path):
    """Bulk imports are repeatable. Importing unchanged books and cards must not add duplicate revisions to their histories."""
    store = DocumentStore(tmp_path / "wbedit")
    doc, created = store.import_from_st(copy.deepcopy(BOOK), kind="worldbook",
                                        st_ref='Sample Book', name='Sample Book')
    assert created is True and store.revisions(doc.id) == [0]

    again, created2 = store.import_from_st(copy.deepcopy(BOOK), kind="worldbook",
                                           st_ref='Sample Book', name='Sample Book')
    assert created2 is False
    assert again.id == doc.id
    assert store.revisions(doc.id) == [0], "an identical re-push minted a revision"


def test_a_changed_document_still_mints_one(tmp_path):
    """The control. Without it the test above passes for a store that never writes anything."""
    store = DocumentStore(tmp_path / "wbedit")
    doc, _ = store.import_from_st(copy.deepcopy(BOOK), kind="worldbook",
                                  st_ref='Sample Book', name='Sample Book')
    changed = copy.deepcopy(BOOK)
    changed["entries"]["0"]["content"] = "He burned the ledger."
    again, created = store.import_from_st(changed, kind="worldbook",
                                          st_ref='Sample Book', name='Sample Book')
    assert created is False
    assert store.revisions(doc.id) == [0, 1]
    assert again.latest == 1
