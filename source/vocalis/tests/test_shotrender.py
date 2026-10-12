"""The render queue: one card per SHOT, segments sequential inside it (9.0-m9).

🔴 **THE INVARIANT THESE SPECS EXIST FOR IS INVISIBLE IN THE OUTPUT.** A queue that dispatched
SEGMENTS instead of shots would look correct, run twice as wide, and produce video whose second
half does not follow from its first — because each segment renders fine on its own and only their
ORDER carries the dependency. There is nothing to see in a frame; there is only the schedule.

⚠️ §8b's warning, carried by §5.3: *"the constraint from one pipeline must not be cargo-culted onto
the other."* Image generation has no such dependency; video does. These are the tests that stop
someone reading `loragen` and "fixing" this to match it.
"""
from __future__ import annotations

import threading

import pytest

from vocalis.runtime import shotrender
from vocalis.runtime.gpu import GPUS


@pytest.fixture(autouse=True)
def _clean_gate():
    for d in list(GPUS.external()):
        GPUS.release_external(d)
    yield
    for d in list(GPUS.external()):
        GPUS.release_external(d)


class _Recorder:
    """Records every dispatch as (shot_id, segment, prev_state) and returns a new state."""

    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, *, job, segment, prev_state):
        with self.lock:
            self.calls.append((job.shot_id, segment, prev_state))
        return f"{job.shot_id}:{segment}"


def _queue(rec, devices=("cuda:0", "cuda:1")):
    return shotrender.RenderQueue(dispatch=rec, devices=lambda: list(devices))


# ── segment arithmetic ────────────────────────────────────────────────────────

@pytest.mark.parametrize("length,expected", [
    (5.0, 1), (10.0, 2), (12.0, 3), (0.1, 1), (20.0, 4), (0.0, 0),
])
def test_segments_round_UP(length, expected):
    """⚠️ CEILING, NOT ROUND. A 12-second shot at a 5-second window is THREE segments. A round
    would silently drop the last two seconds of every shot whose length is not a multiple of the
    window — and the loss lands at the END of the shot, where it reads as a cut coming early
    rather than as a missing segment."""
    assert shotrender.segments_for(length) == expected


# ── the invariant ─────────────────────────────────────────────────────────────

def test_segments_within_a_shot_run_in_order_and_are_chained():
    """🔴 SEGMENT N IS CONDITIONED ON N-1's LATENT STATE. Both halves are asserted: the ORDER, and
    that each call actually receives the previous call's result. A loop that ran them in order but
    threw the state away would pass an order-only check and still produce incoherent video."""
    rec = _Recorder()
    q = _queue(rec)
    job = q.submit("prod1", "shotA", 0, 12.0)
    q.pump()
    q.run_one(job)

    assert [c[1] for c in rec.calls] == [0, 1, 2], rec.calls
    assert [c[2] for c in rec.calls] == [None, "shotA:0", "shotA:1"], (
        "a segment did not receive the previous segment's state - the chain is broken"
    )
    assert job.state == "done" and job.done == 3


def test_the_queue_item_is_a_shot_and_the_queue_cannot_name_a_segment():
    """🔴 STRUCTURAL, NOT TEXTUAL. The reason a segment can never be scheduled independently is
    that the QUEUE has no vocabulary for one: `submit` accepts a shot and nothing else, and the
    sequential loop lives inside `run_one`. A future change wanting segment-level parallelism
    would have to ADD a parameter, which is a decision somebody makes on purpose rather than a
    scheduling accident.

    ⚠️ ASSERTED ON THE SIGNATURE, NOT ON THE SOURCE TEXT. The first version grepped `submit`'s
    source for 'segment' and failed on `total = segments_for(length_s)` — a legitimate line
    that computes how many segments the SHOT will need. Grepping code for a word finds the
    word, not the concept.
    """
    import inspect

    params = set(inspect.signature(shotrender.RenderQueue.submit).parameters)
    assert "shot_id" in params
    assert not {p for p in params if 'segment' in p}, (
        f'submit takes a segment parameter ({params}) - a segment can be queued on its own'
    )
    assert 'segment' not in shotrender.RenderJob.__dataclass_fields__

    # ⚠️ A THIRD ASSERTION WAS DELETED HERE RATHER THAN FIXED: it checked that `pump` contained
    # no `for `, meaning to say 'pump does not walk segments'. It matched pump's own list
    # comprehension over DEVICES. An assertion that has to be contorted to pass is usually one
    # that was never testing what it claimed — the signature and field checks above are the
    # invariant, and they are exact.

def test_two_shots_run_on_two_cards_at_once():
    """Across shots, fully independent — different shots on different cards, near-linear."""
    rec = _Recorder()
    q = _queue(rec)
    a = q.submit("prod1", "shotA", 0, 5.0)
    b = q.submit("prod1", "shotB", 1, 5.0)
    assert q.pump() == 2, "the second card was left idle"
    assert {a.device, b.device} == {"cuda:0", "cuda:1"}


def test_a_third_shot_waits_for_a_card():
    rec = _Recorder()
    q = _queue(rec)
    q.submit("prod1", "shotA", 0, 5.0)
    q.submit("prod1", "shotB", 1, 5.0)
    c = q.submit("prod1", "shotC", 2, 5.0)
    q.pump()
    assert c.state == "queued" and not c.device
    assert len(q.snapshot()["running"]) == 2


def test_finishing_a_shot_pumps_the_next_one():
    """🔴 8.0-m22/m23 WERE ALL PUMP BUGS OF THIS FAMILY: the queue never pumped on completion, so
    work sat in `pending` with an idle card beside it and the fleet looked half-broken."""
    rec = _Recorder()
    q = _queue(rec, devices=("cuda:0",))
    a = q.submit("prod1", "shotA", 0, 5.0)
    c = q.submit("prod1", "shotC", 1, 5.0)
    q.pump()
    assert c.state == "queued"

    q.run_one(a)
    assert c.state == "running", "finishing a shot did not start the next one"
    assert c.device == "cuda:0"


# ── the lease ─────────────────────────────────────────────────────────────────

def test_the_card_is_leased_for_the_WHOLE_shot_not_per_segment():
    """🔴 THE SAME RULE m4 ESTABLISHED, AND FOR THE SAME REASON. A lease taken and released around
    each segment is briefly absent between them — and `/comfyui/stop` refuses only while a lease is
    held, so a Stop landing in that window kills a live render. Here the window would occur once
    per segment, i.e. dozens of times per shot."""
    seen = []

    def dispatch(*, job, segment, prev_state):
        seen.append(dict(GPUS.external()))
        return None

    q = _queue(dispatch)
    job = q.submit("prod1", "shotA", 0, 15.0)
    q.pump()
    q.run_one(job)

    assert len(seen) == 3
    for held in seen:
        assert held, "the card was unleased between segments - a Stop would kill the render"
        assert any(v.startswith("shot-render:") for v in held.values()), held


def test_the_lease_is_released_when_the_shot_ends_however_it_ends():
    """A leaked lease makes `/comfyui/stop` refuse for ever — the m5 lesson, one module over."""
    def boom(*, job, segment, prev_state):
        raise RuntimeError("LongCat fell over")

    q = _queue(boom)
    job = q.submit("prod1", "shotA", 0, 5.0)
    q.pump()
    assert GPUS.external()
    q.run_one(job)
    assert job.state == "failed" and "LongCat" in job.error
    assert not GPUS.external(), "a failed render kept the card"


def test_one_failure_does_not_stop_the_other_shots():
    """⚠️ "A guard that crashes the run it was meant to protect is worse than no guard." A render
    fleet that stops because one shot failed loses a night for the other nineteen."""
    def sometimes(*, job, segment, prev_state):
        if job.shot_id == "bad":
            raise RuntimeError("nope")
        return "ok"

    q = _queue(sometimes, devices=("cuda:0",))
    bad = q.submit("prod1", "bad", 0, 5.0)
    good = q.submit("prod1", "good", 1, 5.0)
    q.pump()
    q.run_one(bad)
    assert good.state == "running", "a failed shot stranded the queue"
    q.run_one(good)
    assert good.state == "done"


# ── refusal and cancel ────────────────────────────────────────────────────────

def test_the_same_shot_cannot_be_queued_twice():
    """⚠️ Two renders of one shot race to write the same output, and the loser's frames interleave
    with the winner's."""
    q = _queue(_Recorder())
    q.submit("prod1", "shotA", 0, 5.0)
    with pytest.raises(shotrender.RenderRefused):
        q.submit("prod1", "shotA", 0, 5.0)


def test_a_zero_length_shot_is_refused():
    q = _queue(_Recorder())
    with pytest.raises(shotrender.RenderRefused):
        q.submit("prod1", "shotA", 0, 0.0)


def test_canceling_a_queued_shot_removes_it_before_it_starts():
    rec = _Recorder()
    q = _queue(rec, devices=("cuda:0",))
    q.submit("prod1", "shotA", 0, 5.0)
    later = q.submit("prod1", "shotB", 1, 5.0)
    q.pump()
    assert q.cancel(later.id) is True
    assert later.state == "canceled"
    assert not any(c[0] == "shotB" for c in rec.calls)


def test_canceling_a_running_shot_stops_it_BETWEEN_segments():
    """⚠️ BETWEEN, NOT MID-SEGMENT. A segment killed halfway leaves no latent state for the
    next one, so the shot could not be resumed — and stopping cleanly costs at most one
    segment of work."""
    calls = []
    holder = {}

    def canceling(*, job, segment, prev_state):
        calls.append(segment)
        if segment == 1:
            holder['q'].cancel(job.id)
        return 'state'

    q = shotrender.RenderQueue(dispatch=canceling, devices=lambda: ['cuda:0'])
    holder['q'] = q
    job = q.submit('prod1', 'shotA', 0, 25.0)      # 5 segments
    q.pump()
    q.run_one(job)

    assert job.state == 'canceled'
    assert calls == [0, 1], f'stopped mid-segment or ran on: {calls}'
    assert job.done == 2, job.done
    assert not GPUS.external(), 'a canceled render kept the card'

def test_cancel_all_clears_the_queue():
    q = _queue(_Recorder())
    q.submit("prod1", "a", 0, 5.0)
    q.submit("prod1", "b", 1, 5.0)
    q.submit("prod1", "c", 2, 5.0)
    q.pump()
    assert q.cancel_all() == 3
    assert not q.snapshot()["pending"]


def test_no_wall_clock_estimate_is_derived_from_the_segment_count():
    """📌 THE FOURTH TIME THIS RELEASE HAS REFUSED ONE. The source document's "90-175 s of
    compute per second of output" is a RANGE from someone else's hardware. The segment count is
    exact; a duration built from that range would be fiction with a number on it.

    🔴 COMMENTS AND DOCSTRINGS STRIPPED, AND MATCHED ON WORD BOUNDARIES. The first version
    searched the raw module text for 'eta' and matched the middle of the word 'd-eta-il'. That
    is the ninth prose-as-code failure in this session and the second in this file — the defect
    is never the assertion, it is the WINDOW and the INPUT.
    """
    import io as _io
    import inspect
    import re
    import tokenize

    src = inspect.getsource(shotrender)
    # Blank COMMENT and STRING tokens; what is left is code.
    code = []
    for tok in tokenize.generate_tokens(_io.StringIO(src).readline):
        if tok.type in (tokenize.COMMENT, tokenize.STRING):
            continue
        code.append(tok.string)
    code = ' '.join(code)

    for word in ('eta', 'estimate', 'estimated_seconds', 'remaining_s'):
        assert not re.search(r'\b' + word + r'\b', code, re.I), (
            f'{word!r} appears in CODE - a wall-clock estimate is being derived'
        )


# ── the completion pump must reach a worker (9.0 review) ──────────────────────

def test_finishing_a_shot_actually_DISPATCHES_the_next_one_not_just_marks_it():
    """🔴 THE FLAGS WERE RIGHT AND NOBODY RAN THE JOB.

    `test_finishing_a_shot_pumps_the_next_one` above asserts `state == "running"` and
    `device == "cuda:0"` — and both of those are set by `pump_jobs` itself, before any worker
    exists. The completion path called `pump()`, the counting wrapper, which throws away the list
    `pump_jobs` returns *"so the caller can run them"*. So shot C was marked running, had its card
    leased, and was dispatched by nobody — permanently, because a later pump skips it (no longer
    pending) and its device is no longer free.

    ⚠️ THIS ASSERTS THE DISPATCH RECORDER SAW IT, which is the only thing that distinguishes the
    two states. The old test passes on the bug; this one does not.
    """
    rec = _Recorder()
    ran = []
    q = shotrender.RenderQueue(dispatch=rec, devices=lambda: ["cuda:0"],
                               run_job=lambda job: ran.append(job) or q.run_one(job))
    a = q.submit("prod1", "shotA", 0, 5.0)
    c = q.submit("prod1", "shotC", 1, 5.0)
    q.pump()
    assert c.state == "queued"

    q.run_one(a)

    assert [j.shot_id for j in ran] == ["shotC"], "the completion pump never reached a worker"
    assert {sid for sid, _seg, _prev in rec.calls} == {"shotA", "shotC"}, (
        "shotC was marked running but never dispatched - the strand this test exists for")
    assert c.state == "done", f"shotC ended {c.state!r}, so it was never actually run"


def test_a_card_another_subsystem_holds_is_not_stolen_by_the_render_queue():
    """🔴 `free` IS COMPUTED FROM THE QUEUE'S OWN `_running`, WHICH KNOWS NOTHING ABOUT ANY OTHER
    HOLDER. So a card leased by a LoRA generation looked free, `claim_external`'s False was
    discarded, and the render started on it anyway — and its `finally` then released the
    GENERATION's lease, which is what makes `/comfyui/stop` see an idle box and kill a live run.
    """
    from vocalis.runtime.gpu import GPUS
    assert GPUS.claim_external("cuda:0", "lora:someone-else")
    try:
        rec = _Recorder()
        q = _queue(rec, devices=("cuda:0",))
        job = q.submit("prod1", "shotA", 0, 5.0)
        started = q.pump_jobs()

        assert started == [], "the render queue took a card another subsystem holds"
        assert job.state == "queued" and not job.device, (
            "the refused job must go back to pending, not sit in `running` with no worker")
        assert GPUS.external().get("cuda:0") == "lora:someone-else", (
            "the other subsystem's lease was overwritten")
    finally:
        GPUS.release_external("cuda:0", "lora:someone-else")


def test_a_release_cannot_hand_back_a_lease_the_caller_never_held():
    """The floor under all four ignored-claim sites: even a caller that proceeds without a lease
    cannot corrupt the table for the run that actually holds the card."""
    from vocalis.runtime.gpu import GPUS
    assert GPUS.claim_external("cuda:1", 'lora-train:Test-Subject')
    try:
        assert GPUS.release_external("cuda:1", "lora-face:deadbeef") is False
        assert GPUS.external().get("cuda:1") == 'lora-train:Test-Subject'
        assert GPUS.release_external("cuda:1", 'lora-train:Test-Subject') is True
        assert "cuda:1" not in GPUS.external()
    finally:
        GPUS.release_external("cuda:1")
