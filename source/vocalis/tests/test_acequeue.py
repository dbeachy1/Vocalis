"""The ACE-Step queue's one invariant and the cancellation semantics that follow.

The invariant is **at most one job in flight per backend.** Vocalis keeps unsent jobs in its own
queue so they can be removed exactly. Submitted jobs retain their reservation until a terminal
result or confirmed child exit.

So these specs are mostly about what happens under pressure — more jobs than cards, a card that
disappears mid-run, a dispatch that throws, a worker that dies. Each of those is a way to lose a
card permanently, which shows up as "ACE-Step stopped working" long after the cause.

⚠️ `dispatch` is injected, so none of this needs an ACE-Step, a GPU, or a four-minute render.
"""
import sys
import threading

import pytest

from vocalis.runtime.acequeue import AceQueue

CARDS = [("acestep-api.service", "http://127.0.0.1:7683", "cuda:0"),
         ("acestep-api-gpu1.service", "http://127.0.0.1:7685", "cuda:1")]
ONE_CARD = CARDS[:1]


def _recorder():
    calls = []
    return calls, lambda job_id, device, url: calls.append((job_id, device))


def test_two_cards_take_two_jobs_and_the_third_waits():
    """🔴 THE INVARIANT. A third job must NOT be handed to a busy backend, and must not be
    pushed at ACE-Step's own queue either — that is what would make it uncancellable."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    for j in ("a", "b", "c"):
        q.enqueue(j, CARDS)
    assert [c[0] for c in calls] == ["a", "b"], "a third job reached a backend already working"
    assert q.snapshot()["pending"] == ["c"]
    assert set(q.snapshot()["inflight"]) == {"cuda:0", "cuda:1"}


def test_finishing_one_job_starts_the_next_on_that_same_card():
    """🔴 `done()` ALONE HAS TO DO IT — AND THIS SPEC USED TO SUPPLY THE MISSING HALF.

    It read `q.done("a")` followed by `q.pump(CARDS)`, and passed, while the SERVER never
    pumped on completion at all: `enqueue` was `pump`'s only caller anywhere. So the queue
    advanced when work ARRIVED and never when work FINISHED — press Generate twice on a
    two-card box and jobs 3 and 4 sat at "queued" until you pressed it a third time, which
    makes the stall look intermittent rather than total.

    The hand-written `pump` is the whole reason it survived review: a spec that performs the
    step under test proves the mechanism works when driven, not that anything drives it. There
    is no `pump` here now, and the queue is constructed with a backends provider — which is how
    `done` learns what to fill.
    """
    calls, dispatch = _recorder()
    q = AceQueue(dispatch, lambda: CARDS)
    for j in ("a", "b", "c"):
        q.enqueue(j, CARDS)
    q.done("a")
    assert calls[-1] == ("c", "cuda:0"), (
        "the freed card did not take the next job — done() did not pump")
    assert q.snapshot()["pending"] == []


def test_a_queue_with_no_backends_provider_still_frees_the_slot():
    """⚠️ The provider is OPTIONAL, because a queue that cannot list backends must still release
    cards. Without one `done` degrades to exactly its old behavior — free the slot, start
    nothing — rather than raising inside a worker's `finally`, which is the one place an
    exception costs a card permanently."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)                      # no provider
    for j in ("a", "b", "c"):
        q.enqueue(j, CARDS)
    q.done("a")
    assert q.snapshot()["inflight"] == {"cuda:1": "b"}, "the card was not released"
    assert q.snapshot()["pending"] == ["c"], "it started a job with no way to list backends"


def test_a_backends_provider_that_throws_does_not_strand_the_card():
    """🔴 THE `finally` IS THE POINT (see acerun.py's header). `done` runs there, so anything it
    raises propagates out of a worker's cleanup and the card is held for the life of the
    process, with nothing on screen saying why. A provider that throws must cost the next job's
    start, never the slot."""
    calls, dispatch = _recorder()

    def boom():
        raise RuntimeError("settings unreadable")

    q = AceQueue(dispatch, boom)
    for j in ("a", "b", "c"):
        q.enqueue(j, CARDS)
    q.done("a")                                  # must not raise
    assert "cuda:0" not in q.snapshot()["inflight"], "a throwing provider stranded the card"


def test_a_dispatch_that_always_throws_does_not_recurse_forever():
    """⚠️ `done` pumps and the pump's error path frees a slot, so the naive version — error path
    calls `done` — is unbounded mutual recursion the moment a backend fails every dispatch.
    The pump uses `_release` instead, and its own loop gives the next job its turn."""
    seen = []

    def dispatch(job_id, device, url):
        seen.append(job_id)
        raise RuntimeError("backend refused")

    q = AceQueue(dispatch, lambda: ONE_CARD)
    for j in ("a", "b", "c"):
        q.enqueue(j, ONE_CARD)
    assert seen == ["a", "b", "c"], "the queue did not drain past a failing dispatch"
    assert q.snapshot() == {"pending": [], "inflight": {}}


def test_jobs_come_out_in_the_order_they_went_in():
    """FIFO, with no priorities — the queue is a queue. Worth pinning because 'the shortest
    song first' is the sort of cleverness that gets added later and silently starves a long one."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    for j in "abcdef":
        q.enqueue(j, ONE_CARD)
    seen = ["a"]
    for _ in range(5):
        q.done(seen[-1])
        q.pump(ONE_CARD)
        seen.append(calls[-1][0])
    assert seen == list("abcdef")


def test_a_queued_job_is_removed_exactly_and_never_reaches_a_backend():
    """🔴 THE ONLY EXACT CANCEL THERE IS, and it is exact because the job never left Vocalis.
    Nothing is asked of ACE-Step, so nothing can refuse."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    for j in ("a", "b", "c"):
        q.enqueue(j, CARDS)
    assert q.remove("c") is True
    q.done("a")
    q.pump(CARDS)
    assert "c" not in [c[0] for c in calls], "a removed job was dispatched anyway"


def test_defer_returns_unsent_work_without_dispatching_during_a_transition():
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    q.enqueue("a", ONE_CARD)
    q.enqueue("b", ONE_CARD)

    q.defer("a")

    assert calls == [("a", "cuda:0")]
    assert q.snapshot() == {"pending": ["a", "b"], "inflight": {}}
    q.pump(ONE_CARD)
    assert calls[-1] == ("a", "cuda:0")


def test_removing_a_running_job_reports_false_and_preserves_its_card_reservation():
    """A submitted job can only leave the queue after a result or confirmed child exit."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    q.enqueue("a", CARDS)
    assert q.remove("a") is False
    assert q.device_of("a") == "cuda:0", "the UI could not say which card would be lost"


def test_position_is_vocalis_own_number_and_running_jobs_have_none():
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    for j in ("a", "b", "c", "d"):
        q.enqueue(j, CARDS)
    assert q.position("a") is None and q.position("b") is None    # both in flight
    assert q.position("c") == 1 and q.position("d") == 2
    q.remove("c")
    assert q.position("d") == 1, "removing the job ahead did not move the one behind up"


def test_a_card_unticked_mid_run_is_simply_not_offered_work():
    """The device tick is live (⚙ Settings ▸ Devices stops that backend), so `backends` is
    recomputed per pump rather than cached. A card that has gone away must not be dispatched to,
    and must not strand the queue either."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    q.enqueue("a", CARDS)
    q.enqueue("b", CARDS)
    q.enqueue("c", CARDS)
    q.done("b")                        # cuda:1 finishes...
    q.pump(ONE_CARD)                   # ...and is then unticked
    assert [c[0] for c in calls] == ["a", "b"], "work went to a card that is no longer authorized"
    assert q.snapshot()["pending"] == ["c"]
    q.done("a")
    q.pump(ONE_CARD)
    assert calls[-1] == ("c", "cuda:0"), "the surviving card did not pick the queue back up"


def test_a_dispatch_that_throws_frees_the_card_instead_of_wedging_it():
    """🔴 A CARD LOST THIS WAY IS LOST FOR THE PROCESS'S LIFETIME, and it shows up much later as
    "ACE-Step stopped working" with nothing pointing at the submission that failed."""
    seen = []

    def dispatch(job_id, device, url):
        seen.append(job_id)
        if job_id == "a":
            raise RuntimeError("connection refused")

    q = AceQueue(dispatch)
    q.enqueue("a", ONE_CARD)
    assert q.snapshot()["inflight"] == {}, "the failed job kept the card"
    q.enqueue("b", ONE_CARD)
    assert seen == ["a", "b"], "the card never took another job"


def test_one_bad_submission_does_not_stall_the_whole_queue():
    """The failure above, with work behind it: the next job must get its turn in the same pump
    rather than waiting for something else to nudge the queue."""
    seen = []

    def dispatch(job_id, device, url):
        seen.append(job_id)
        if job_id in ("a", "b"):
            raise RuntimeError("nope")

    q = AceQueue(dispatch)
    for j in ("a", "b", "c"):
        q.enqueue(j, ONE_CARD)
    assert seen == ["a", "b", "c"], f"the queue stalled behind a bad submission: {seen}"
    assert q.snapshot()["inflight"] == {"cuda:0": "c"}


def test_submitting_the_same_job_twice_is_one_job():
    """A double-click, or a retry after a timeout that actually succeeded. Two entries would put
    the same song on both cards."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    q.enqueue("a", CARDS)
    q.enqueue("a", CARDS)
    assert [c[0] for c in calls] == ["a"]
    assert q.snapshot()["pending"] == []


def test_done_for_a_job_that_was_never_running_is_harmless():
    """Called from a `finally`, so it runs on paths where dispatch never got that far."""
    calls, dispatch = _recorder()
    q = AceQueue(dispatch)
    q.enqueue("a", CARDS)
    q.done("nonexistent")
    q.done("a")
    q.done("a")
    assert q.snapshot()["inflight"] == {}


def test_the_invariant_holds_when_everything_arrives_at_once():
    """🔴 THE REASON THE LOCK IS OVER BOTH STRUCTURES. Two backends generating concurrently, each
    with its own result poller, plus the queue's own writer — more concurrent writers than this
    registry has ever had (jobs.py's header says so). A torn read between "pop pending" and "mark
    inflight" puts two songs on one card, which is the one thing this module exists to prevent.

    ⚠️ THIS TOOK THREE GOES TO MAKE REAL, AND THE FIRST TWO ARE THE INTERESTING PART. Version one
    started 40 threads in a loop and joined them — not a race at all, since most finished before
    the next was started. Version two added a `Barrier` so they all arrive together. **Both
    passed with `pump`'s lock REMOVED ENTIRELY**: a spec about a lock that a missing lock does not
    fail, which is worth less than no spec because it reads as coverage.

    The reason is that the critical section is a handful of bytecodes and CPython only considers
    a thread switch every `sys.getswitchinterval()` seconds — 5 ms by default, which is an
    eternity next to this region, so it is effectively atomic by luck. Driving the interval to
    its floor makes the interpreter offer a switch at almost every bytecode, which is what turns
    "two threads could interleave here" from a theory into something that actually happens.

    ⚠️ Restored in a `finally`: leaving the interval at ~0 would slow every test after this one in
    the same worker, and the cause would be invisible.
    """
    N = 32
    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        for _attempt in range(8):
            started = []
            guard = threading.Lock()
            gate = threading.Barrier(N)

            def dispatch(job_id, device, url):
                with guard:
                    started.append((job_id, device))

            def go(i, q=None):
                gate.wait()
                q.enqueue(f"j{i}", CARDS)

            q = AceQueue(dispatch)
            threads = [threading.Thread(target=go, args=(i,), kwargs={"q": q}) for i in range(N)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert len(started) == 2, f"more than one job per card got started: {started}"
            devices = [d for _j, d in started]
            assert sorted(devices) == ["cuda:0", "cuda:1"], f"a card took two jobs: {started}"
            snap = q.snapshot()
            assert len(snap["inflight"]) == 2 and len(snap["pending"]) == N - 2
            assert len(set(snap["pending"]) | {j for j, _d in started}) == N, \
                "a job was lost or doubled"
    finally:
        sys.setswitchinterval(old_interval)
