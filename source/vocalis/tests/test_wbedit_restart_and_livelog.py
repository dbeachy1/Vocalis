"""Tests restart behavior and replay of live progress."""
from __future__ import annotations

import copy

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.backends.kobold_chat import KoboldChat
from wbedit.store import DocumentStore, PassStore
from wbedit.store.models import PASS_STATES, Proposal

BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False,
              "content": "Test Character 1 keeps the ledger of every debt in the lower wards."},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "order": 100, "disable": False,
              "content": "The rains come off the estuary in the ninth month."},
    },
}


@pytest.fixture
def root(tmp_path, monkeypatch):
    """Checks that root."""
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    return tmp_path / "wbedit"


@pytest.fixture
def docs(root):
    return DocumentStore(root)


@pytest.fixture
def passes(root):
    return PassStore(root)


def a_doc(docs, name="Sample World Book 1"):
    return docs.create(copy.deepcopy(BOOK), name=name, kind="worldbook")


def a_pass(passes, doc_id, *, total=110):
    return passes.start(doc_id, revision=0, instruction="Rename Test Character 1 to Renamed Character 1.",
                        model="glm", sampler={"rep_pen": 1.0},
                        selection=[["entries", "0", "content"]], total=total)


def _proposal(index, status="CHANGED"):
    return Proposal(index=index, locator=("entries", "0", "content"), label="Sample Entry 1",
                    status=status, original="Test Character 1 keeps the ledger.",
                    revised="Renamed Character 1 keeps the ledger." if status == "CHANGED" else None,
                    review="approved" if status == "CHANGED" else "none")


# ── §9a.13a — the restart reconcile ──────────────────────────────────────────

def test_a_pass_left_running_by_a_restart_is_closed_out_and_says_where_it_got_to(docs, passes):
    """Checks that a pass left running by a restart is closed out and says where it got to."""
    doc = a_doc(docs)
    p = a_pass(passes, doc.id, total=110)
    passes.record(doc.id, p.id, _proposal(33))
    passes.record(doc.id, p.id, _proposal(34, status="NOCHANGE"))
    assert passes.get(doc.id, p.id).status == "running", "the fixture did not set up the defect"

    assert web_wbedit.reconcile_orphaned_passes() == [p.id]

    after = passes.get(doc.id, p.id)
    assert after.status == "interrupted"
    assert after.status in PASS_STATES, "the terminal value is not a declared pass state"
    assert after.error == "interrupted by a restart at field 34 of 110"
    assert after.finished_at > 0, "an interrupted pass with no finish time still reads as live"


def test_the_reason_carries_counts_and_no_document_text(docs, passes):
    """Checks that the reason carries counts and no document text."""
    doc = a_doc(docs)
    p = a_pass(passes, doc.id, total=2)
    passes.record(doc.id, p.id, _proposal(1))

    web_wbedit.reconcile_orphaned_passes()

    err = passes.get(doc.id, p.id).error
    assert "Test Character 1" not in err and "ledger" not in err
    assert "1 of 2" in err


def test_the_reconcile_never_moves_the_cursor_or_the_tally(docs, passes):
    """Checks that the reconcile never moves the cursor or the tally."""
    doc = a_doc(docs)
    p = a_pass(passes, doc.id, total=110)
    passes.record(doc.id, p.id, _proposal(33))
    passes.record(doc.id, p.id, _proposal(34, status="NOCHANGE"))
    before = passes.get(doc.id, p.id)

    web_wbedit.reconcile_orphaned_passes()

    after = passes.get(doc.id, p.id)
    assert after.cursor == before.cursor == 34, "the resume point moved"
    assert after.tally == before.tally == {"CHANGED": 1, "NOCHANGE": 1}
    assert after.total == 110 and after.revision == 0
    assert after.instruction == before.instruction, "I10 — the frozen instruction was rewritten"
    assert passes.proposals(doc.id, p.id) and len(passes.proposals(doc.id, p.id)) == 2, \
        "the proposals recorded before the restart did not survive the reconcile"


@pytest.mark.parametrize("status", ["done", "canceled", "failed"])
def test_a_pass_that_already_finished_is_left_byte_for_byte_alone(docs, passes, status):
    """Checks that a pass that already finished is left byte for byte alone."""
    doc = a_doc(docs)
    p = a_pass(passes, doc.id, total=3)
    passes.record(doc.id, p.id, _proposal(1))
    passes.finish(doc.id, p.id, status=status, tally={"CHANGED": 1},
                  error="TransportError" if status == "failed" else "")
    before = passes.get(doc.id, p.id).to_dict()

    assert web_wbedit.reconcile_orphaned_passes() == []
    assert passes.get(doc.id, p.id).to_dict() == before


def test_a_genuinely_live_pass_is_skipped_because_this_also_runs_on_unlock(docs, passes,
                                                                          monkeypatch):
    """Checks that a genuinely live pass is skipped because this also runs on unlock."""
    doc = a_doc(docs)
    live = a_pass(passes, doc.id, total=110)
    orphan = a_pass(passes, doc.id, total=4)
    passes.record(doc.id, live.id, _proposal(7))

    run = web_wbedit._Run(doc.id, live.id)
    assert run.done is False
    monkeypatch.setattr(web_wbedit, "_RUN", run)

    assert web_wbedit.reconcile_orphaned_passes() == [orphan.id], \
        "the reconcile closed a pass that is running right now"
    assert passes.get(doc.id, live.id).status == "running"
    assert passes.get(doc.id, live.id).cursor == 7
    assert passes.get(doc.id, orphan.id).status == "interrupted", \
        "the orphan next to it was skipped too — the live check is too broad"


def test_a_finished_run_still_sitting_in_the_global_does_not_shield_its_record(docs, passes,
                                                                              monkeypatch):
    """Checks that a finished run still sitting in the global does not shield its record."""
    doc = a_doc(docs)
    p = a_pass(passes, doc.id, total=2)
    run = web_wbedit._Run(doc.id, p.id)
    run.done = True
    monkeypatch.setattr(web_wbedit, "_RUN", run)

    assert web_wbedit.reconcile_orphaned_passes() == [p.id]
    assert passes.get(doc.id, p.id).status == "interrupted"


def test_every_document_is_swept_not_only_the_first(docs, passes):
    """Checks that every document is swept not only the first."""
    a, b, c = a_doc(docs, "A"), a_doc(docs, "B"), a_doc(docs, "C")
    ids = {a_pass(passes, d.id, total=2).id for d in (a, b, c)}

    assert set(web_wbedit.reconcile_orphaned_passes()) == ids
    for d in (a, b, c):
        assert [x.status for x in passes.list_passes(d.id)] == ["interrupted"]


def test_running_it_twice_changes_nothing_the_second_time(docs, passes):
    """Checks that running it twice changes nothing the second time."""
    doc = a_doc(docs)
    p = a_pass(passes, doc.id, total=5)
    passes.record(doc.id, p.id, _proposal(2))

    assert web_wbedit.reconcile_orphaned_passes() == [p.id]
    first = passes.get(doc.id, p.id).to_dict()

    assert web_wbedit.reconcile_orphaned_passes() == [], "the second run closed it again"
    assert passes.get(doc.id, p.id).to_dict() == first, \
        "the second run rewrote the record — `finished_at` would march forward on every boot"


def test_an_empty_store_or_a_document_with_no_passes_is_not_an_error(docs, passes):
    """Checks that an empty store or a document with no passes is not an error."""
    assert web_wbedit.reconcile_orphaned_passes() == [], "an absent store root raised or invented"

    doc = a_doc(docs)
    assert passes.list_passes(doc.id) == []
    assert web_wbedit.reconcile_orphaned_passes() == []


def test_an_unreadable_store_is_a_warning_not_a_crashed_boot(docs, passes, monkeypatch):
    """Checks that an unreadable store is a warning not a crashed boot."""
    doc = a_doc(docs)
    a_pass(passes, doc.id, total=2)

    def boom(self, doc_id):
        raise RuntimeError("the vault re-locked")

    monkeypatch.setattr(PassStore, "list_passes", boom)
    assert web_wbedit.reconcile_orphaned_passes() == []


# ── §9a.13 — the exchange is logged at SEND time ─────────────────────────────

def test_the_open_row_is_closed_in_place_rather_than_becoming_a_second_row(root):
    """Checks that the open row is closed in place rather than becoming a second row."""
    run = web_wbedit._Run("d", "p")
    body = {"messages": [{"role": "user", "content": "FIELD\nTest Character 1 keeps the ledger."}]}

    run.log_exchange(body, None)
    run.log_exchange(body, "the reply")

    assert len(run.exchanges) == 1, f"the open row was not closed in place: {run.exchanges}"
    assert run.exchanges[0]["reply"] == "the reply"
    assert run.exchanges[0]["request"] is body
    assert run.dropped == 0


def test_the_request_is_visible_before_the_reply_exists(root):
    """Checks that the request is visible before the reply exists."""
    run = web_wbedit._Run("d", "p")
    run.log_exchange({"messages": [{"role": "user", "content": "FIELD\nthe ledger"}]}, None)

    assert len(run.exchanges) == 1, "nothing was recorded while the request was in flight"
    assert run.exchanges[0]["reply"] is None, \
        "an in-flight row must be tellable from a finished one — the UI renders them differently"
    assert run.exchanges[0]["request"]["messages"][-1]["content"] == "FIELD\nthe ledger", \
        "the block that was sent is not in the row, so the window shows a spinner and no prompt"


def test_the_row_is_open_before_the_post_returns(root):
    """Checks that the row is open before the post returns."""
    run = web_wbedit._Run("d", "p")
    order: list[str] = []

    def post(path, body, timeout):
        order.append("post")
        with run.lock:
            rows = [dict(x) for x in run.exchanges]
        assert len(rows) == 1 and rows[0]["reply"] is None, (
            "the request was not logged before the blocking POST — this is exactly the window "
            f"where the live log said 'no exchange yet' for 26 seconds: {rows}")
        return {"choices": [{"message": {"content": "the reply"}}]}

    def on_exchange(body, reply):
        order.append("open" if reply is None else "close")
        run.log_exchange(body, reply)

    backend = KoboldChat(post, model="glm", on_exchange=on_exchange)
    assert backend.complete([{"role": "user", "content": "FIELD\nthe ledger"}], {}) == "the reply"

    assert order == ["open", "post", "close"], \
        f"the exchange was not opened before the call and closed after it: {order}"
    assert len(run.exchanges) == 1 and run.exchanges[0]["reply"] == "the reply"


def test_the_numbering_survives_the_open_and_close_cycle(root):
    """Checks that the numbering survives the open and close cycle."""
    run = web_wbedit._Run("d", "p")

    run.log_exchange({"messages": [{"content": "field one"}]}, None)
    assert [x["n"] for x in run.exchanges] == [1]
    run.log_exchange({"messages": [{"content": "field one"}]}, "reply one")
    assert [x["n"] for x in run.exchanges] == [1], "closing the row renumbered it"

    run.log_exchange({"messages": [{"content": "field two"}]}, None)
    assert [x["n"] for x in run.exchanges] == [1, 2]
    run.log_exchange({"messages": [{"content": "field two"}]}, "reply two")

    assert [(x["n"], x["reply"]) for x in run.exchanges] == [(1, "reply one"), (2, "reply two")]


def test_the_in_flight_row_reaches_the_window_but_never_the_saved_log(docs, passes):
    """Checks that the in flight row reaches the window but never the saved log."""
    doc = a_doc(docs)
    run = web_wbedit._Run(doc.id, "p1")
    body = {"messages": [{"role": "user", "content": "FIELD\nthe ledger"}]}

    run.log_exchange_persisted(docs, 0, "p1", body, None)
    assert len(run.exchanges) == 1 and run.exchanges[0]["reply"] is None, \
        "the live window lost the in-flight row"
    assert docs.read_log(doc.id, 0) == [], "an unanswered request was written to the saved log"

    run.log_exchange_persisted(docs, 0, "p1", body, "the reply")
    rows = docs.read_log(doc.id, 0)
    assert len(rows) == 1, f"closing the row wrote a second disk row: {rows}"
    assert rows[0]["reply"] == "the reply" and rows[0]["pass_id"] == "p1"
    assert len(run.exchanges) == 1


def test_the_saved_row_keeps_the_number_the_window_shows(docs, passes):
    """Checks that the saved row keeps the number the window shows."""
    doc = a_doc(docs)
    run = web_wbedit._Run(doc.id, "p1")
    for i in (1, 2, 3):
        body = {"messages": [{"role": "user", "content": f"FIELD\nfield {i}"}]}
        run.log_exchange_persisted(docs, 0, "p1", body, None)
        run.log_exchange_persisted(docs, 0, "p1", body, f"reply {i}")

    assert [x["n"] for x in run.exchanges] == [1, 2, 3]
    assert [r["n"] for r in docs.read_log(doc.id, 0)] == [1, 2, 3]


def test_a_logging_failure_still_never_fails_the_pass_now_that_it_fires_twice(root):
    """Checks that a logging failure still never fails the pass now that it fires twice."""
    calls: list[str] = []

    def boom(body, reply):
        calls.append("open" if reply is None else "close")
        raise ValueError("the log exploded")

    backend = KoboldChat(lambda path, body, timeout: {"choices": [{"message": {"content": "hi"}}]},
                         on_exchange=boom)
    assert backend.complete([{"role": "user", "content": "x"}], {}) == "hi"
    assert calls == ["open", "close"], \
        f"the send-time log call was skipped rather than survived: {calls}"
