"""`GpuGate`'s third class: work dispatched to another process (9.0-m4).

🔴 **WHY THIS NEEDED A CHANGE TO `GpuGate` RATHER THAN A LOCK BESIDE IT.** The class arbitrates
two kinds of GPU work, both of which run *in this process*: a RENDER owns every card, a background
ENHANCEMENT owns exactly one. 9.0 adds a third — Vocalis dispatches a job to ComfyUI, which is a
separate process holding real VRAM on a real card that `GpuGate` could not see.

A parallel lock would have "worked" in the sense that the LoRA runs would not collide with each
other. It would not have stopped a book render rebuilding its pool into VRAM ComfyUI was already
using. **A lock the arbiter cannot see is the bug; a second one just moves where the collision
happens** — and it surfaces as an unrelated CUDA OOM in whichever job loses.

Every test here is a cross-class interaction, because that is the only thing the change is for.
"""
from __future__ import annotations

import pytest

from vocalis.runtime.gpu import GpuGate


@pytest.fixture
def gate():
    return GpuGate()


def test_a_lease_is_taken_and_given_back(gate):
    assert gate.claim_external("cuda:0", 'lora:test-subject') is True
    assert gate.external() == {"cuda:0": 'lora:test-subject'}
    gate.release_external("cuda:0")
    assert gate.external() == {}


def test_two_runs_cannot_hold_the_same_card(gate):
    assert gate.claim_external("cuda:0", "lora:a") is True
    assert gate.claim_external("cuda:0", "lora:b") is False, "the card was double-booked"


def test_two_runs_CAN_hold_different_cards(gate):
    """The whole point of the dual-card design: independent images, near-linear 2x. If this
    returned False the second card would sit idle and the run would take twice as long."""
    assert gate.claim_external("cuda:0", "lora:a") is True
    assert gate.claim_external("cuda:1", "lora:b") is True


# ── the cross-class interactions, which are the reason this lives in GpuGate ──

def test_a_render_WAITS_for_external_work(gate):
    """🔴 THE ONE THAT A PARALLEL LOCK WOULD HAVE MISSED.

    A render puts a model replica on EVERY card. Starting one while ComfyUI is mid-generation
    rebuilds the pool into VRAM that is already occupied — which OOMs the render, the generation,
    or both, and reads as an unrelated CUDA failure in whichever one loses.
    """
    assert gate.claim_external("cuda:0", "lora:a") is True
    assert gate.acquire(blocking=False) is False, "a render started on top of a live generation"
    gate.release_external("cuda:0")
    assert gate.acquire(blocking=False) is True


def test_an_enhancement_will_not_take_a_card_a_generation_is_using(gate):
    """An enhancement wants ~21 GB of one card. A card mid-generation does not have it spare."""
    assert gate.claim_external("cuda:0", "lora:a") is True
    device, reason = gate.claim_card(["cuda:0"])
    assert device is None, "an enhancement claimed a card ComfyUI was generating on"
    assert reason == "cards"


def test_an_enhancement_takes_the_OTHER_card_happily(gate):
    """The lease must not be broader than it needs to be — one busy card is not both."""
    gate.claim_external("cuda:0", "lora:a")
    device, reason = gate.claim_card(["cuda:0", "cuda:1"])
    assert device == "cuda:1" and reason == ""


def test_a_generation_will_not_start_on_a_card_an_enhancement_holds(gate):
    """The converse. Both directions have to hold or the guard only works when it is lucky."""
    device, _ = gate.claim_card(["cuda:0"])
    assert device == "cuda:0"
    assert gate.claim_external("cuda:0", "lora:a") is False


def test_a_generation_yields_to_a_render_that_is_merely_QUEUED(gate):
    """⚠️ `_waiting`, not just `_render` — and this mirrors `claim_card`'s existing rule.

    A render queued for the cards is one the user is already watching a spinner for. A dataset
    generation is a background job; letting it jump in front of the interactive thing is exactly
    the mistake `claim_card` refuses to make one method up.
    """
    import threading
    gate.acquire()                      # a render holds the cards
    started = threading.Event()

    def queued_render():
        started.set()
        gate.acquire()                  # blocks: now `_waiting` is 1
        gate.release()

    t = threading.Thread(target=queued_render, daemon=True)
    t.start()
    started.wait(timeout=2)
    # give the thread a moment to actually reach the wait inside acquire()
    for _ in range(200):
        if gate.render_active():
            break
    assert gate.claim_external("cuda:0", "lora:a") is False, (
        "a generation jumped in front of a render that was already queued"
    )
    gate.release()
    t.join(timeout=2)


def test_render_active_reports_external_work(gate):
    """5.2's pre-render gate asks this before starting speculative narration, and "the box has
    nothing real to do" is false while a generation is running — even though another process is
    the one doing it."""
    assert gate.render_active() is False
    gate.claim_external("cuda:0", "lora:a")
    assert gate.render_active() is True
    gate.release_external("cuda:0")
    assert gate.render_active() is False


def test_releasing_a_card_nobody_holds_is_harmless(gate):
    """🔴 RELEASE MUST BE SAFE TO CALL ON THE FAILURE PATH.

    A lease leaked by a crashed run makes the card look permanently busy to every other class
    here and nothing would ever reclaim it — so the cleanup has to be unconditional, which means
    it will sometimes run twice or run for a card that was never claimed.
    """
    gate.release_external("cuda:0")     # never claimed
    gate.claim_external("cuda:0", "x")
    gate.release_external("cuda:0")
    gate.release_external("cuda:0")     # again
    assert gate.external() == {}
    assert gate.acquire(blocking=False) is True, "a double release left the gate wedged"
