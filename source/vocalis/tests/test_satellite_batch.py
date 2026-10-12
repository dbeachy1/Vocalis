"""6.2-m2 — the satellite's batched decode, at the level a CPU can check.

🔴 WHY THIS FILE EXISTS AT ALL, when the PoC already measured 6.98× and passed §7.1's gate:
because §7.1's gate needs a GPU, a 3 GB model and four minutes, so it runs when someone runs it.
The three fidelity bugs it caught all produce PLAUSIBLE AUDIO — the render sounds fine and is
subtly not what the same seed would have produced serially — and every one of them lives in the
input preparation, which is pure tensor plumbing that a CPU can check exactly:

  1. the CFG uncond row must have its TOKEN embedding blanked and its POSITIONS kept;
  2. the learned text positions must be 0..len-1 per row, with the RESULT left-padded — never
     the token ids padded first;
  3. the left pads must be masked OUT of attention, or a short chunk's output depends on how
     long its batch partners happened to be.

So a fake T3 records exactly what the transformer was handed, and these assert on it. That is
the half of §7.1 that can run every time, on any box, in milliseconds.

The rest is §5's safety bound and §6's vendor split, both of which are pure decisions.
"""
import re
import sys
import threading
import time
import types

import numpy as np
import pytest

from conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT / "satellite"))
import vocalis_satellite_batch as batch                      # noqa: E402

torch = pytest.importorskip("torch")

DIM, VOCAB, LEN_COND = 8, 16, 3


class _Out:
    """🔴 Shaped like a real `BaseModelOutputWithPast`, NOT like the call our decode happens to
    make. `last_hidden_state` is always present; `hidden_states` exists ONLY when the caller asked
    for it, which is what makes asking for it and not needing it visible here rather than free.

    The previous version had `hidden_states` and nothing else — it modeled the code, so the code
    could not be improved without the fake going red for the wrong reason. Same shape of trap as
    6.2-m2a, where the fake handed the batch a `patched_model` a fresh replica does not have.
    """

    def __init__(self, hidden, past, *, with_hidden_states):
        self.last_hidden_state = hidden
        self.past_key_values = past
        if with_hidden_states:
            self.hidden_states = [hidden]


class _Model:
    """Stands in for the LlamaModel. Records every call, so the test can read what the batch
    actually handed the transformer rather than what it meant to."""

    def __init__(self):
        self.calls = []

    def __call__(self, *, inputs_embeds, attention_mask, past_key_values,
                 use_cache, return_dict, output_hidden_states=False):
        self.calls.append({"embeds": inputs_embeds.clone(),
                           "mask": attention_mask.clone(),
                           "output_hidden_states": bool(output_hidden_states)})
        b, t, _ = inputs_embeds.shape
        return _Out(torch.zeros((b, t, DIM)), past_key_values,
                    with_hidden_states=bool(output_hidden_states))


def _speech_head(hidden):
    """Every row votes overwhelmingly for the stop token, so the decode loop finishes after one
    step and these tests are about the INPUTS, which is where all three fidelity bugs lived."""
    b, t, _ = hidden.shape
    logits = torch.full((b, t, VOCAB), -60.0)
    logits[:, :, FakeT3.HP.stop_speech_token] = 60.0
    return logits


class _SpeechPosEmb:
    def __call__(self, ids):
        return torch.zeros((*ids.shape, DIM))

    def get_fixed_embedding(self, i):
        return torch.zeros((1, 1, DIM))


class FakeT3:
    class HP:
        input_pos_emb = "learned"
        start_text_token = 0
        stop_text_token = 1
        start_speech_token = 2
        stop_speech_token = 3

    def __init__(self):
        self.device = torch.device("cpu")
        self.hp = FakeT3.HP()
        # Model a freshly loaded replica: patched_model is created lazily inside
        # T3.inference, after a serial render, so it is absent on the first batch.
        self.tfmr = _Model()
        self.speech_head = _speech_head
        # Distinct, invertible embeddings: token id -> (id+1)*100, position -> (pos+1). A row of
        # the finished tensor therefore says exactly which token AND which position produced it.
        self.text_emb = lambda ids: (ids.float() + 1).unsqueeze(-1).repeat(1, 1, DIM) * 100.0
        self.text_pos_emb = lambda ids: (
            torch.arange(ids.size(1), dtype=torch.float32)
            .view(1, -1, 1).repeat(ids.size(0), 1, DIM))
        self.speech_emb = lambda ids: torch.zeros((*ids.shape, DIM))
        # Called BOTH ways: `speech_pos_emb(ids)` for the prompt and `.get_fixed_embedding(i)`
        # per decode step. A SimpleNamespace cannot be called, so this needs a real class.
        self.speech_pos_emb = _SpeechPosEmb()

    def prepare_conditioning(self, cond):
        return torch.full((1, LEN_COND, DIM), -7.0)


def _run(rows):
    t3 = FakeT3()
    out, steps = batch.batched_t3(t3, object(), rows, max_new_tokens=4, cfg_weight=0.5)
    return t3, out, steps


def test_the_uncond_half_keeps_its_positions_and_loses_only_the_token():
    """🔴 Fidelity bug 1. `prepare_input_embeds` zeroes the CFG uncond row BEFORE adding the
    learned positional embedding. Zero the finished slice instead — the obvious way to write it —
    and the positions go too. The audio is still plausible."""
    rows = [torch.tensor([0, 5, 6, 1])]
    t3, _out, _steps = _run(rows)
    embeds = t3.tfmr.calls[0]["embeds"]
    n = 1
    text = embeds[:, LEN_COND:LEN_COND + 4, :]
    cond_row, uncond_row = text[0], text[n]
    # The cond half carries token AND position; the uncond half carries position ONLY.
    assert torch.allclose(cond_row[:, 0], torch.tensor([100.0, 600.0, 700.0, 200.0])
                          + torch.tensor([0.0, 1.0, 2.0, 3.0]))
    assert torch.allclose(uncond_row[:, 0], torch.tensor([0.0, 1.0, 2.0, 3.0]))
    assert not torch.allclose(uncond_row, torch.zeros_like(uncond_row)), (
        "the uncond row was zeroed AFTER the positional embedding — bug 1, and it sounds fine")


def test_short_rows_are_left_padded_after_embedding_not_before():
    """🔴 Fidelity bug 2. The learned text positions must be 0..len-1 for each row. Pad the token
    ids to a common length first and a short chunk's whole text lands on positions it never saw
    in training — which is invisible until you compare tokens against a serial run."""
    short, long = torch.tensor([0, 9, 1]), torch.tensor([0, 5, 6, 7, 1])
    t3, _out, _steps = _run([short, long])
    embeds = t3.tfmr.calls[0]["embeds"]
    lmax = 5
    text = embeds[:, LEN_COND:LEN_COND + lmax, :]
    # The short row occupies the LAST three columns; the first two are pad.
    assert torch.allclose(text[0][:2], torch.zeros((2, DIM))), "short row was right-padded"
    tokens_then_pos = torch.tensor([100.0, 1000.0, 200.0]) + torch.tensor([0.0, 1.0, 2.0])
    assert torch.allclose(text[0][2:, 0], tokens_then_pos), (
        "the short row's positions are not 0..len-1 — bug 2: the ids were padded first")


def test_the_left_pads_are_masked_out_of_attention():
    """🔴 Fidelity bug 3. `T3HuggingfaceBackend.forward` takes no `attention_mask`, so calling it
    leaves the pads attended as zero vectors — and a short chunk's output then depends on how
    long its batch PARTNERS were, which is the worst kind of wrong: reproducible only with the
    same partners."""
    short, long = torch.tensor([0, 9, 1]), torch.tensor([0, 5, 6, 7, 1])
    t3, _out, _steps = _run([short, long])
    call = t3.tfmr.calls[0]
    mask, embeds = call["mask"], call["embeds"]
    assert mask.shape[0] == embeds.shape[0] and mask.shape[1] == embeds.shape[1], (
        "the mask must cover the whole sequence, both CFG halves")
    lmax = 5
    text_mask = mask[:, LEN_COND:LEN_COND + lmax]
    assert text_mask[0].tolist() == [0, 0, 1, 1, 1], "the short row's pads are not masked out"
    assert text_mask[1].tolist() == [1, 1, 1, 1, 1], "the long row lost real text to the mask"
    # And BOTH CFG halves — the uncond half is padded identically and is just as attended.
    assert text_mask[2].tolist() == [0, 0, 1, 1, 1], "the uncond half of the batch is unmasked"
    # Everything outside the text block is real: conditioning, BOS, and the generated tokens.
    assert mask[:, :LEN_COND].min().item() == 1
    assert mask[:, LEN_COND + lmax:].min().item() == 1


def test_a_finished_sequence_is_frozen_rather_than_dropped():
    """Rows cannot leave a batch — the KV cache is positional. A finished one keeps emitting its
    stop token and is trimmed at the end, which is why every returned row is cut at ITS OWN EOS
    rather than at the batch's."""
    rows = [torch.tensor([0, 9, 1]), torch.tensor([0, 5, 6, 1])]
    _t3, out, steps = _run(rows)
    assert len(out) == 2 and steps == 1
    assert all(r.numel() == 0 for r in out), "everything after the stop token must be trimmed"


# ── §5: the render-time VRAM bound ───────────────────────────────────────────────────────

def test_the_batch_never_exceeds_the_measured_ceiling(monkeypatch):
    """MAX_BATCH is the largest size measured at any chunk length, not a claim that 32 always
    fits. Measurements cover 32 chunks end to end at 60 and 180 characters. batch_cap refuses 32
    LONG chunks, and the two are only meaningful together."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)     # a card with room to spare
    assert batch.batch_cap("cuda:0", 64) == batch.MAX_BATCH == 32
    assert batch.batch_cap("cuda:0", 3) == 3                   # never more than asked for
    assert batch.batch_cap("cuda:0", 1) == 1


def test_a_busy_card_shrinks_the_batch(monkeypatch):
    """Free VRAM changes with concurrent workload, so a configured capacity can become stale.
    The cap must respect the current measurement."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 6.0)       # 6 free, 2 reserved => 4 to play
    assert batch.batch_cap("cuda:0", 8) < batch.MAX_BATCH
    monkeypatch.setattr(batch, "free_gb", lambda d: 12.0)
    assert 1 < batch.batch_cap("cuda:0", 8) <= 8
    # A card with nothing free still renders — at one chunk a pass, never zero.
    monkeypatch.setattr(batch, "free_gb", lambda d: 0.1)
    assert batch.batch_cap("cuda:0", 8) == 1


# ── §15: the cost model, measured rather than guessed ────────────────────────────────────

# scripts/bench-satellite-batching.py vramgrid --drop-every 8 measured this surface on a 4090
# with 19.35 GB free. (chars, n) -> GB of live tensors at the peak of the T3 pass.
# These are what `pass_cost_gb` has to reproduce; they are the reason the constants have the
# values they have, and a change that moves any of them by more than 15% is a change to the
# physics, not a tidy-up.
MEASURED_LIVE_GB = {
    (61, 1): 0.09, (61, 8): 0.65, (61, 16): 1.38, (61, 32): 2.79,
    (182, 1): 0.16, (182, 8): 1.47, (182, 16): 2.84, (182, 32): 5.96,
    (302, 1): 0.26, (302, 8): 2.18, (302, 16): 4.53, (302, 24): 6.80,
    (405, 1): 0.35, (405, 8): 2.83, (405, 16): 5.83,
}


def test_the_model_reproduces_every_cell_that_was_measured():
    """🔴 The cost of a batched decode is its KV cache and essentially nothing else.

    2 (K,V) x 30 layers x 16 kv heads x 64 dims x 4 bytes = 240.0 KiB per position, against
    249.0 KiB measured — R² 0.9999 across 25 cells. This asserts the shipped closed form against
    the actual numbers, so that anyone who edits a constant finds out here rather than on the
    card at 720 MiB free.
    """
    worst, where = 0.0, None
    for (chars, n), measured in MEASURED_LIVE_GB.items():
        predicted = batch.pass_cost_gb(n, chars) / batch.ALLOCATOR_FACTOR
        err = abs(predicted - measured) / measured
        if err > worst:
            worst, where = err, (chars, n, predicted, measured)
    assert worst < 0.15, (
        f"the cost model has drifted from the measured surface: at {where[0]} chars x n={where[1]} "
        f"it predicts {where[2]:.2f} GB against {where[3]:.2f} GB measured ({worst:.0%} out)")


def test_the_cost_is_linear_in_n_and_superlinear_in_length():
    """🔴 This is the shape the old code had WRONG, and the error mattered in both directions.

    A previous sweep fitted cost ∝ n^1.4 and concluded batch size was dangerous — but its text
    pool cycled four chunks of DIFFERENT lengths, so growing n also grew the longest chunk, and
    the batch pads to the longest. Holding length fixed, doubling n exactly doubles the cost.
    Length is the term that grows faster than its input, because a longer chunk lengthens the
    text AND decodes for proportionally more steps: measured, 400 characters costs 4.4x what 60
    does per chunk, for 6.6x the text.
    """
    for chars in (60, 200, 400):
        assert batch.pass_cost_gb(8, chars) == pytest.approx(4 * batch.pass_cost_gb(2, chars)), \
            "cost must be exactly linear in batch size at a fixed length"
    ratio = batch.pass_cost_gb(1, 400) / batch.pass_cost_gb(1, 60)
    assert 3.5 < ratio < 5.5, (
        f"400-char chunks should cost ~4.4x what 60-char ones do, not {ratio:.1f}x — the length "
        f"term is what fills the card and it is the one that keeps being got wrong")


def test_the_batch_is_sized_by_the_LONGEST_chunk_not_the_total(monkeypatch):
    """🔴 A REAL UNDER-SIZING DEFECT, fixed here. The old cap budgeted `sum(len(t))`, but a batch
    left-pads every row to the longest and runs the decode until the LONGEST hits EOS — so a
    short chunk riding along with a long one costs exactly what the long one costs.

    A book splits at 400 characters on sentence boundaries, so its chunks scatter; a slice of
    one long chunk and seven short ones has a sum that says "cheap" and a real cost of eight
    long ones. Under-predicting is the direction that ends in the PCIe paging regime.
    """
    monkeypatch.setattr(batch, "free_gb", lambda d: 8.0)
    mixed = ["x" * 400] + ["x" * 40] * 7
    all_long = ["x" * 400] * 8
    assert batch.batch_cap("cuda:0", 8, mixed) == batch.batch_cap("cuda:0", 8, all_long), (
        "one long chunk among short ones must cost what the long one costs — sizing off the "
        "total is what let a mixed slice through at up to twice the batch the card could afford")


def test_the_cap_is_solved_for_rather_than_halved_down_to(monkeypatch):
    """The model is linear in n, so the largest affordable batch can be computed outright.

    Halving throws away capacity: a card that can afford 15 chunks would get only 8.
    """
    # 400-char chunks cost ~1.04 GB each with the allocator factor in, so ~14 GB of budget
    # should buy comfortably more than 8 — and a halving implementation can only ever say 8.
    monkeypatch.setattr(batch, "free_gb", lambda d: 16.0)      # 16 free, 2 reserved => 14
    cap = batch.batch_cap("cuda:0", 32, ["x" * 400] * 32)
    assert cap > 8, f"a 14 GB budget bought only {cap} chunks — that is the halving behavior"
    assert batch.pass_cost_gb(cap, 400) <= 14.0 + 1e-6, "and it must still fit in the budget"


# ── 1.11 / §17 · the user-specified cap ──────────────────────────────────────────────────
#
# This is an intent limit, not a satellite's declared capacity. Free VRAM changes with workload;
# the user-specified cap reserves room for other work that may start later.

@pytest.fixture(autouse=True)
def _uncapped():
    """Every other test in this file assumes no cap, and the cap is process state."""
    batch.set_vram_cap(0)
    yield
    batch.set_vram_cap(0)


def test_no_cap_is_the_default_and_leaves_the_sizer_exactly_as_it_was(monkeypatch):
    """The regression guard for every satellite already deployed. 0 means uncapped, an absent
    field means 0, and the budget is then free VRAM less `RESERVE_GB` — which is what every cost
    model test above describes."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 16.0)
    assert batch.vram_cap_gb() == 0.0
    assert batch.spend_budget_gb("cuda:0") == 16.0 - batch.RESERVE_GB


@pytest.mark.parametrize("junk", ["eight", None, "", -3, float("nan"), object()])
def test_junk_is_uncapped_rather_than_a_crash(junk):
    """This value comes from a request field on the render path. Invalid input must leave the
    satellite available rather than raising from /satellite/capacity."""
    assert batch.set_vram_cap(junk) == 0.0
    assert batch.vram_cap_gb() == 0.0


def test_the_cap_binds_the_batch_when_it_is_tighter_than_the_card(monkeypatch):
    """A 24 GB card may have ample free VRAM while another workload needs reserved headroom.
    The configured cap must constrain the batch even when free VRAM alone would allow more."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 24.0)
    monkeypatch.setattr(batch, "reserved_gb", lambda d: 0.0)
    wide = batch.batch_cap("cuda:0", 32, lengths=[400] * 32)
    batch.set_vram_cap(6)
    narrow = batch.batch_cap("cuda:0", 32, lengths=[400] * 32)
    assert narrow < wide, f"the cap did not bind ({narrow} against {wide})"
    assert narrow >= 1, "a capped card still renders — at one chunk a pass, never zero"
    assert batch.pass_cost_gb(narrow, 400) <= 6.0 + 1e-6, "and the pass fits under the cap"


def test_the_cap_is_measured_against_WHAT_WE_HOLD_not_the_cards_free_vram(monkeypatch):
    """🔴 THE ARITHMETIC THAT MAKES IT A CAP RATHER THAN A SECOND RESERVE. The ceiling is on this
    process's own footprint, so the model already resident counts against it — otherwise a 10 GB
    cap would permit 10 GB *on top of* the 3 GB of weights and the satellite would sit at 13."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)     # the card is not the constraint
    monkeypatch.setattr(batch, "reserved_gb", lambda d: 7.0)   # …but we already hold 7
    batch.set_vram_cap(10)
    assert batch.spend_budget_gb("cuda:0") == 3.0
    monkeypatch.setattr(batch, "reserved_gb", lambda d: 12.0)  # already over it
    assert batch.spend_budget_gb("cuda:0") == 0.0, "over the cap must be 0 spendable, never negative"
    assert batch.batch_cap("cuda:0", 8, lengths=[400] * 8) == 1, "and it still renders one at a time"


def test_the_card_reserve_is_not_charged_against_the_cap(monkeypatch):
    """⚠️ A 8 GB cap must mean 8 GB. Subtracting `RESERVE_GB` from the cap as well as from the
    card's free VRAM would quietly make it 6 — a number on screen that is not the number in
    effect, which is the whole failure mode this product keeps writing notes about."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    monkeypatch.setattr(batch, "reserved_gb", lambda d: 0.0)
    batch.set_vram_cap(8)
    assert batch.spend_budget_gb("cuda:0") == 8.0


def test_the_card_still_binds_when_it_is_tighter_than_the_cap(monkeypatch):
    """Both limits apply, and the smaller wins. A generous cap does not license spending VRAM a
    co-tenant is already holding — that is what `RESERVE_GB` and the watchdog are for, and the cap
    does not get to override them."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 5.0)       # 3 spendable after the reserve
    monkeypatch.setattr(batch, "reserved_gb", lambda d: 0.0)
    batch.set_vram_cap(40)
    assert batch.spend_budget_gb("cuda:0") == 3.0


def test_the_vocoder_slice_is_capped_too(monkeypatch):
    """The second-largest allocation this file makes. Capping the decode and not the vocoder
    would leave the ceiling half-enforced — and it is the pass that thrashes across PCIe when it
    does not fit (276.9 s for a chunk that costs 2.4 s)."""
    import torch as _t
    rows = [_t.zeros(400, dtype=_t.long) for _ in range(8)]
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    monkeypatch.setattr(batch, "reserved_gb", lambda d: 0.0)
    wide = batch.vocoder_slice("cuda:0", rows)
    batch.set_vram_cap(0.5)
    assert batch.vocoder_slice("cuda:0", rows) < wide


def test_the_allocator_bound_honors_the_cap_and_never_drops_below_what_is_resident(monkeypatch):
    """🔴 `set_per_process_memory_fraction` IS THE ONLY HARD STOP IN THIS FILE — everything else
    is a prediction. And it must never be set under what torch already holds: that frees nothing
    and only makes the next allocation fail, i.e. a satellite that answers every render with OOM
    until someone restarts it. Applied as far as it can be, and logged."""
    applied = {}

    class _Cuda:
        @staticmethod
        def is_available():
            return True

        @staticmethod
        def mem_get_info(idx):
            return (20 * 1024 ** 3, 24 * 1024 ** 3)            # 20 free of 24

        @staticmethod
        def memory_reserved(idx):
            return int(3 * 1024 ** 3)                          # we hold 3

        @staticmethod
        def set_per_process_memory_fraction(f, idx):
            applied["f"] = f

    fake = types.SimpleNamespace(cuda=_Cuda, version=types.SimpleNamespace(hip=None))
    # `_torch()` is the module's one door to torch, so replacing it is how a card that does not
    # exist gets to be measured. `is_cuda` reads `version.hip is None` — a real 4090, not an R9700.
    monkeypatch.setattr(batch, "_torch", lambda: fake)

    batch.set_vram_cap(0)
    batch.bound_process_memory("cuda:0")
    uncapped = applied["f"] * 24
    assert uncapped > 10, "the shipped bound is generous when nothing says otherwise"

    batch.set_vram_cap(8)
    batch.bound_process_memory("cuda:0")
    assert abs(applied["f"] * 24 - 8.0) < 0.01, "the cap did not reach the allocator"

    # A cap typed while 3 GB is already resident cannot be enforced below that.
    batch.set_vram_cap(1)
    batch.bound_process_memory("cuda:0")
    assert abs(applied["f"] * 24 - 3.0) < 0.01, "it was set below what torch already holds"


# ── the allocator allowance the card measures for itself ─────────────────────────────────

def test_a_card_that_has_measured_nothing_charges_the_shipped_constant():
    """The warm-up contract, and the reason this change cannot regress a fresh process.

    `ALLOCATOR_FACTOR` stays the answer until the card has actually landed
    `ALLOC_RATIO_MIN_SAMPLES` cheaper passes. A satellite that has just started behaves exactly
    as 1.6 did; a more expensive observation must take effect immediately.
    """
    assert batch.alloc_ratio("cuda:0") == batch.ALLOCATOR_FACTOR
    for _ in range(batch.ALLOC_RATIO_MIN_SAMPLES - 1):
        batch.note_pass_cost("cuda:0", 8, 400, 1.2 * batch.live_cost_gb(8, 400))
    assert batch.alloc_ratio("cuda:0") == batch.ALLOCATOR_FACTOR, (
        "one or two passes is not evidence — the card must not resize itself on a sample of two")


def test_the_card_stops_charging_3x_once_it_has_seen_what_a_pass_costs(monkeypatch):
    """A conservative allocator ratio can leave capacity unused after the card has measured
    actual passes. At 18.4 GB free, the prior estimate returned 14 for 32 x 400-character chunks,
    while observed batches used about 4-5 GB for 11 chunks.

    Every chunk was charged 1.044 GB — the worst-case allocator ratio of 3.0 against a
    live KV cost of 0.348 GB — while the real footprint of a landed batch of 11 at ~370 chars was
    4-5 GB, i.e. a ratio of about 1.2. Once the card has measured that, the same free VRAM has to
    buy roughly twice the batch.
    """
    monkeypatch.setattr(batch, "free_gb", lambda d: 18.4)
    lengths = ["x" * 400] * 32
    before = batch.batch_cap("cuda:0", 32, lengths)
    assert before <= 16, (
        f"the shipped constant should buy about 15 chunks here, not {before} — if this moved, "
        f"the measured allocator overhead no longer matches this test case")
    for _ in range(batch.ALLOC_RATIO_MIN_SAMPLES):
        batch.note_pass_cost("cuda:0", 16, 400, 1.2 * batch.live_cost_gb(16, 400))
    after = batch.batch_cap("cuda:0", 32, lengths)
    assert after > before, (
        f"a card that has measured its own overhead at 1.2x still only offered {after} where it "
        f"offered {before} charging 3x — the measurement is not reaching the cap")
    assert after <= batch.landed_cap("cuda:0"), (
        "…but it must not reach past a step beyond the largest pass that actually landed")


def test_a_measured_ratio_is_not_a_license_to_jump_to_a_size_never_run(monkeypatch):
    """The measured ratio must not authorize a size the card has not safely run. Here the first
    passes land at n=16 and teach a 1.91x ratio; an estimate of 26 then crosses the VRAM floor.
    The retry path must preserve the learned bound rather than halve it again to 0.5 and run
    at 9/5/2/1: 80 chunks in 153.2 s against the bench's equivalent of 103 s. The replacement for
    the constant was SLOWER than the constant.

    The ratio was not wrong — the pass missed by ~3% — extrapolating it two-thirds of the way
    past any size that had ever run was. Evidence for a size is a pass of that size landing.
    """
    monkeypatch.setattr(batch, "free_gb", lambda d: 19.35)
    lengths = ["x" * 400] * 32
    for _ in range(batch.ALLOC_RATIO_MIN_SAMPLES):
        batch.note_pass_cost("cuda:0", 16, 400, 1.91 / batch.ALLOC_RATIO_MARGIN
                             * batch.live_cost_gb(16, 400))
    proposed = batch.batch_cap("cuda:0", 32, lengths)
    assert proposed <= 20, (
        f"it proposed {proposed} off three passes of 16 — that is the jump to 26 that overran "
        f"the card, with the ratio doing the extrapolating")
    assert proposed > 16, "…and it must still be allowed to reach past what it has run"


def test_the_card_walks_up_through_sizes_it_has_landed(monkeypatch):
    """Each rung is paid for by a pass that completed, so the card climbs instead of guessing.

    This is what makes the measurement safe to act on: being wrong costs one step, not a pass
    discarded two-thirds of the way into its decode.
    """
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)     # never the binding constraint
    lengths = ["x" * 400] * 32
    reached = []
    for n in (16, 20, 25):
        for _ in range(batch.ALLOC_RATIO_MIN_SAMPLES):
            batch.note_pass_cost("cuda:0", n, 400, 1.2 * batch.live_cost_gb(n, 400))
        reached.append(batch.batch_cap("cuda:0", 32, lengths))
    assert reached == sorted(reached) and len(set(reached)) == 3, \
        f"the cap must climb as bigger passes land, not sit still or lurch: {reached}"
    assert reached[0] == 20 and reached[-1] == 31, reached


def test_the_margin_is_charged_over_the_cards_own_worst_observation():
    """The margin covers measurement error on a size the card has already run; the observed
    overrun was 3%, which a bare worst-of-window does not cover."""
    for _ in range(6):
        batch.note_pass_cost("cuda:0", 8, 400, 1.5 * batch.live_cost_gb(8, 400))
    assert batch.alloc_ratio("cuda:0") == pytest.approx(1.5 * batch.ALLOC_RATIO_MARGIN, rel=1e-6)


def test_a_costlier_book_pass_raises_the_allowance_after_one_sample():
    """A real passage may produce more tokens than the benchmark's character estimate.

    Clipping measured cost at the initial 3x made that completed pass teach the card nothing,
    even when the next 16-row proposal was already at the VRAM floor.
    """
    batch.note_pass_cost("cuda:0", 4, 400, 9.0 * batch.live_cost_gb(4, 400))
    assert batch.alloc_ratio("cuda:0") == pytest.approx(9.0 * batch.ALLOC_RATIO_MARGIN)


def test_one_costlier_pass_reduces_the_next_batch_before_three_samples(monkeypatch):
    """The measured reserve of one landed passage must prevent the next oversized proposal."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 12.6)
    lengths = ["x" * 250] * 24
    before = batch.batch_cap("cuda:0", len(lengths), lengths)
    batch.note_pass_cost("cuda:0", 10, 250, 3.8 * batch.live_cost_gb(10, 250))
    after = batch.batch_cap("cuda:0", len(lengths), lengths)
    assert batch.alloc_ratio("cuda:0") > batch.ALLOCATOR_FACTOR
    assert 1 < after < before
    assert after <= 11, (before, after)
    shorter = batch.batch_cap("cuda:0", len(lengths), lengths=[100] * 24)
    assert shorter > after, "the measured memory correction must still size each text length"


def test_a_run_of_cheap_passes_cannot_charge_less_than_the_floor():
    """A low measurement cannot convince the card that a large pass is nearly free."""
    with batch._ALLOC_RATIO_MU:
        batch._ALLOC_RATIO.clear()
    for _ in range(6):
        batch.note_pass_cost("cuda:0", 4, 400, 0.01 * batch.live_cost_gb(4, 400))
    assert batch.alloc_ratio("cuda:0") == batch.ALLOC_RATIO_FLOOR


def test_the_worst_pass_in_the_window_is_the_one_that_counts():
    """Same semantics 3.0 had — a worst case — but measured on THIS card rather than a bench.

    A mean would let a run of cheap passes average away the one expensive shape that is about to
    repeat, and the cost of being wrong is not symmetric: over-charging loses throughput,
    under-charging loses the card.
    """
    m = batch.ALLOC_RATIO_MARGIN
    for _ in range(6):
        batch.note_pass_cost("cuda:0", 4, 400, 1.2 * batch.live_cost_gb(4, 400))
    assert batch.alloc_ratio("cuda:0") == pytest.approx(1.2 * m, rel=1e-6)
    batch.note_pass_cost("cuda:0", 4, 400, 2.5 * batch.live_cost_gb(4, 400))
    assert batch.alloc_ratio("cuda:0") == pytest.approx(2.5 * m, rel=1e-6), (
        "one expensive pass must raise the charge immediately — the window is a worst-of, and a "
        "card that has just paid 2.5x is the best evidence available that it will again")


def test_the_window_forgets_so_a_card_is_not_punished_forever():
    """Without a rolling window, one unusually expensive shape could keep the card undersized for
    the lifetime of a long-running process."""
    batch.note_pass_cost("cuda:0", 4, 400, 2.9 * batch.live_cost_gb(4, 400))
    for _ in range(batch.ALLOC_RATIO_WINDOW):
        batch.note_pass_cost("cuda:0", 4, 400, 1.2 * batch.live_cost_gb(4, 400))
    assert batch.alloc_ratio("cuda:0") == pytest.approx(
        1.2 * batch.ALLOC_RATIO_MARGIN, rel=1e-6)


def test_what_one_card_measures_does_not_size_another():
    """Per DEVICE. A 4090 and an R9700 have different allocators and different residents, and
    `_LEARNED` is keyed this way for exactly the same reason."""
    for _ in range(6):
        batch.note_pass_cost("cuda:0", 4, 400, 1.2 * batch.live_cost_gb(4, 400))
    assert batch.alloc_ratio("cuda:1") == batch.ALLOCATOR_FACTOR


def _abort_after(monkeypatch, rows, n_free=100.0):
    """Drive `render_batch_iter` where the first pass trips carrying `rows` as already finished."""
    monkeypatch.setattr(batch, "free_gb", lambda d: n_free)
    monkeypatch.setattr(batch, "vocode_one",
                        lambda m, tok: np.zeros(int(tok.numel()), dtype=np.float32))
    calls = []

    def fake_pass(model, texts, device, **kw):
        calls.append(list(texts))
        if len(calls) == 1:
            exc = batch.BatchTooBig("free VRAM fell below 1.5 GB on cuda:0")
            exc.rows = dict(rows)
            raise exc
        return [np.zeros(4, dtype=np.float32) for _ in texts]

    monkeypatch.setattr(batch, "_one_pass", fake_pass)
    return calls


def test_an_aborted_pass_keeps_the_rows_that_had_already_finished(monkeypatch):
    """A watchdog interruption should preserve rows that have already completed. The watchdog
    raises from inside the decode loop, and unwinding
    dropped `predicted` and the KV cache together — so a pass that tripped at 90% of its decode
    re-ran every row from step zero. A row that has reached its own stop token is a complete
    generation and cannot change (`_finished_rows`), so it is kept and only what is genuinely
    unfinished is re-sized and retried.
    """
    calls = _abort_after(monkeypatch, {0: torch.tensor([7, 7, 7]), 2: torch.tensor([9, 9])})
    texts = [f"chunk-{i}" for i in range(4)]
    got = dict(batch.render_batch_iter(object(), texts, device="cuda:0"))

    assert sorted(got) == [0, 1, 2, 3], "every chunk must still come back"
    assert len(got[0]) == 3 and len(got[2]) == 2, \
        "the finished rows must be the SALVAGED audio, not a re-decode"
    assert all("chunk-0" not in c and "chunk-2" not in c for c in calls[1:]), \
        f"a finished row was decoded a second time: {calls}"


def test_a_pass_with_nothing_finished_backs_off_by_one_and_retries(monkeypatch):
    """The salvage must not become a way to avoid shrinking. If the trip caught the pass before
    any row finished there is nothing to keep, and the rule is the whole of it: one chunk fewer,
    remember the size, try again."""
    calls = _abort_after(monkeypatch, {})
    texts = [f"chunk-{i}" for i in range(8)]
    got = dict(batch.render_batch_iter(object(), texts, device="cuda:0"))

    assert sorted(got) == list(range(8))
    assert len(calls[0]) == 8, "the first pass should have taken the lot"
    assert len(calls[1]) == len(calls[0]) - 1, (
        f"nothing finished, so the retry backs off by ONE chunk — not by half: "
        f"{[len(c) for c in calls]}")
    # 8 tripped so the ceiling went to 7; the 7 then LANDED, which earns exactly one back. Both
    # halves of the rule in one render — it is 8 here because the card re-proved 7, not because
    # it forgot the trip.
    assert batch.batch_ceiling("cuda:0") == 8, "the card must learn from the trip AND the recovery"


def test_a_card_that_will_not_report_its_memory_is_simply_not_measured(monkeypatch):
    """🔴 A STATISTIC MUST NEVER BE ABLE TO FAIL A RENDER — and the first version of this change
    shipped as one, which is how it was found.

    `torch.cuda.is_available()` answers True on a box with a real CUDA build whose context is not
    initialized in the calling thread, and `reset_peak_memory_stats` then throws out of
    `_cuda_resetPeakMemoryStats`. Called unguarded on the hot path of every pass, that kills a
    pass which would otherwise have succeeded, for the sake of a number nothing depends on.
    Every reading here degrades to "not measured" instead.
    """
    class _Boom:
        def __getattr__(self, _name):
            raise RuntimeError("CUDA context not initialized on this thread")

    monkeypatch.setattr(batch, "_torch", lambda: types.SimpleNamespace(cuda=_Boom()))
    assert batch._dev_idx("cuda:0") is None
    batch._rebase_peak(0)                                  # must not raise
    assert batch._reserved_gb(0) is None
    assert batch._reserved_gb(0, peak=True) is None


def test_a_torn_off_pass_teaches_the_card_nothing():
    """⚠️ Only a pass that LANDED is evidence. A `BatchTooBig` leaves `_one_pass` through a raise
    before the measurement, so a pass aborted at 40% of its decode can never be recorded as a
    cheap one — which is the single observation that would make this dangerous."""
    assert batch.note_pass_cost("cuda:0", 8, 400, 0.0) == batch.ALLOCATOR_FACTOR
    assert batch.alloc_ratio("cuda:0") == batch.ALLOCATOR_FACTOR


def test_the_decode_hands_memory_back_periodically(monkeypatch):
    """🔴 The single change that made the large batches reachable at all.

    `DynamicCache` re-`cat`s the whole KV cache every step and frees a block the next step is
    already too big to reuse, so what the CARD loses runs to ~5x what the tensors weigh — 2.84 GB
    live against 15.93 GB gone, measured at n=16 x 182 chars. `expandable_segments:True` is the
    allocator setting for exactly this and is NOT SUPPORTED ON WINDOWS, so the decode hands the
    blocks back by hand. With it, n=16 x 400 chars went from unreachable to 8.10 GB.

    It looks like a stray `empty_cache()` in a hot loop, which is precisely why it is pinned.
    """
    drops = []
    monkeypatch.setattr(batch, "_drop_cache", lambda: drops.append(1))
    t3 = FakeT3()

    def never_stop(hidden):
        """Nothing votes for the stop token, so the loop runs its full length."""
        b, t, _ = hidden.shape
        logits = torch.full((b, t, VOCAB), -60.0)
        logits[:, :, FakeT3.HP.stop_speech_token + 1] = 60.0
        return logits

    t3.speech_head = never_stop
    steps = 24
    batch.batched_t3(t3, object(), [torch.tensor([0, 5, 6, 1])],
                     max_new_tokens=steps, cfg_weight=0.5)
    assert batch.DROP_EVERY, "the periodic drop was switched off"
    assert len(drops) == steps // batch.DROP_EVERY, (
        f"the decode dropped the allocator's free blocks {len(drops)} times over {steps} steps, "
        f"expected every {batch.DROP_EVERY}")


def test_the_vocoder_splits_into_passes_it_can_afford(monkeypatch):
    """🔴 The other half of the vocoder fix: `vocoder_slice` decides a size, and `_vocode_rows`
    has to actually USE it. The old code computed nothing and handed S3Gen the whole batch."""
    monkeypatch.setattr(batch, "s3gen_batching_ok", lambda d: True)
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    seen = []
    monkeypatch.setattr(batch, "vocode_batched",
                        lambda m, rows: (seen.append(len(rows)),
                                         [np.zeros(4, dtype=np.float32)] * len(rows))[1])
    monkeypatch.setattr(batch, "vocode_one",
                        lambda m, r: (seen.append(1), np.zeros(4, dtype=np.float32))[1])
    monkeypatch.setattr(batch, "_drop_cache", lambda: None)
    rows = [torch.zeros(480, dtype=torch.long) for _ in range(32)]
    out = batch._vocode_rows(object(), rows, "cuda:0")
    assert len(out) == 32, "every row must come back, however the passes were split"
    assert max(seen) * 480 <= batch.VOCODER_TOKEN_BUDGET, (
        f"a pass of {max(seen)} x 480 speech tokens exceeded the budget — this is the shape that "
        f"took the card to 720 MiB free")
    assert sum(seen) == 32 and len(seen) > 1, f"the batch was not actually split: {seen}"


def test_the_vocoder_gets_a_bound_of_its_own(monkeypatch):
    """🔴 `S3Gen.inference` is ONE opaque call: no loop we own, so no watchdog, so the whole
    decision has to be made before it — and it has to be about what the pass will WANT, not what
    happens to be free. The old pre-flight asked only the second question, said yes to 32 rows of
    480 tokens with 3 GB free, and drove the card to 720 MiB.
    """
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)     # room is not the constraint here
    rows = [torch.zeros(480, dtype=torch.long) for _ in range(32)]
    per = batch.vocoder_slice("cuda:0", rows)
    assert 1 <= per < 32, f"32 long rows went into one S3Gen pass ({per})"
    assert per * 480 <= batch.VOCODER_TOKEN_BUDGET

    # Short rows are cheap, so more of them ride together — the budget is tokens, not rows.
    short = [torch.zeros(60, dtype=torch.long) for _ in range(32)]
    assert batch.vocoder_slice("cuda:0", short) > per

    # …and a card with nothing spare REFUSES, rather than vocoding one row anyway.
    monkeypatch.setattr(batch, "free_gb", lambda d: 2.05)
    assert batch.vocoder_slice("cuda:0", rows) == 0


def test_a_card_that_cannot_hold_one_row_refuses_instead_of_paging(monkeypatch):
    """One chunk took 276.9 s at 0.1x real time when it exceeded available memory; batching the
    same chunk costs 2.4 s.

    `vocoder_slice` used to end in `max(1, ...)`, so "no room at all" and "room for exactly one"
    were the same answer, and `_vocode_rows` then vocoded a row the card had already said it
    could not hold. `S3Gen.inference` is one opaque call — no watchdog, no abort — so that row
    ran to completion out of host RAM across PCIe with nothing able to stop it.

    GPU-Z during the stall: 100% GPU load, **131 W**, 4% memory-controller load, **48% bus
    interface load**, fans idle. Healthy on the same card is 322 W, 22% and 1%. It was not
    computing; it was streaming over PCIe.

    Refusing costs a halve-and-retry. Proceeding cost four minutes that nothing could interrupt.
    """
    rows = [torch.zeros(734, dtype=torch.long) for _ in range(4)]
    monkeypatch.setattr(batch, "s3gen_batching_ok", lambda d: True)
    monkeypatch.setattr(batch, "free_gb", lambda d: 1.47)      # measured free-memory example
    monkeypatch.setattr(batch, "vocode_one",
                        lambda m, r: pytest.fail("vocoded a row the card cannot hold"))
    monkeypatch.setattr(batch, "vocode_batched",
                        lambda m, rs: pytest.fail("vocoded rows the card cannot hold"))
    with pytest.raises(batch.BatchTooBig):
        batch._vocode_rows(object(), rows, "cuda:0")

    # 🔴 AND THE SINGLE-ROW PATH IS BOUND TOO. `len(tok_rows) <= 1` used to walk straight past
    # every check into `vocode_one`, which asks nothing of the card — so the shape a submission
    # HALVES DOWN TO under memory pressure was the one shape with no bound anywhere in it.
    with pytest.raises(batch.BatchTooBig):
        batch._vocode_rows(object(), rows[:1], "cuda:0")

    # ROCm takes the unbatched vocoder path (§6) and must be bound by the same reading.
    monkeypatch.setattr(batch, "s3gen_batching_ok", lambda d: False)
    with pytest.raises(batch.BatchTooBig):
        batch._vocode_rows(object(), rows, "cuda:0")


def test_the_decodes_pool_is_handed_back_before_the_vocoder_is_sized(monkeypatch):
    """The ordering, which is all this asserts: decode, drop, then size the vocoder.

    `DROP_EVERY` runs inside the decode loop and there is another drop between vocoder
    sub-passes; neither covers this boundary, and the `DynamicCache` is only released when
    `_batched_t3` returns — into torch's pool, where `vocoder_slice`'s `mem_get_info` cannot
    see it.

    **This is insurance, not the fix.** After a batched pass of 8, the allocator reserved 3.06 GB
    against 3.03 GB allocated — holes
    0.02 GB — and `empty_cache()` returned 0.00 GB. The allocator hands the cache back on its
    own in a clean process, so the drop reclaims nothing there.

    🔴 The first version of this test cited "2.84 GB live against 15.93 GB gone from the card"
    as its justification. That figure is an EARLIER measurement from the module's comments,
    under conditions not reproduced since, and quoting it here dressed an unverified mechanism
    up as a measured one. The guard actually shown to stop the stall is `bound_process_memory`
    — see `test_torch_is_capped_so_the_driver_is_never_asked_for_the_overflow`.
    """
    order = []
    monkeypatch.setattr(batch, "_drop_cache", lambda: order.append("drop"))
    monkeypatch.setattr(batch, "batched_t3",
                        lambda *a, **kw: (order.append("decode"),
                                          ([torch.zeros(4, dtype=torch.long)], 4))[1])
    monkeypatch.setattr(batch, "text_tokens", lambda m, t: torch.zeros(4, dtype=torch.long))
    monkeypatch.setattr(batch, "_vocode_rows",
                        lambda m, rows, dev: (order.append("vocode"),
                                              [np.zeros(4, dtype=np.float32)])[1])

    class _Conds:
        t3 = types.SimpleNamespace(emotion_adv=torch.zeros(1, 1, 1))

    model = types.SimpleNamespace(conds=_Conds(), device="cuda:0", t3=object())
    batch._one_pass(model, ["hello"], "cuda:0", exaggeration=0.0, cfg=0.5,
                    temperature=0.8, cancel=None)
    assert order == ["decode", "drop", "vocode"], (
        f"the decode's pool was not handed back to the driver before the vocoder was sized: "
        f"{order}")


def test_an_oom_halves_and_retries_rather_than_failing(monkeypatch):
    """🔴 §5.2. The render must not fail for want of a smaller batch: the caller is a book, and
    the alternative to a slower pass is a hole in it."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    seen = []

    def fake_pass(model, texts, device, **kw):
        seen.append(len(texts))
        if len(texts) > 2:
            raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
        return [np.full(4, float(t), dtype=np.float32) for t in texts]

    monkeypatch.setattr(batch, "_one_pass", fake_pass)
    out = batch.render_batch(object(), [1.0, 2.0, 3.0, 4.0, 5.0], device="cuda:0")
    assert seen[0] == 5 and 2 in seen, f"it did not halve its way down: {seen}"
    assert len(out) == 5
    # 🔴 AND THE ORDER SURVIVES. A batch that reorders one entry is a chunk of a book in the
    # wrong place: silent, and unlistenable-to.
    assert [float(a[0]) for a in out] == [1.0, 2.0, 3.0, 4.0, 5.0]


def test_an_oom_at_a_batch_of_one_is_a_real_failure(monkeypatch):
    """Halving has a floor. Below one there is nothing to try, and swallowing it would hand back
    silence for a chunk that never rendered."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)

    def always_oom(model, texts, device, **kw):
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(batch, "_one_pass", always_oom)
    with pytest.raises(RuntimeError):
        batch.render_batch(object(), ["a"], device="cuda:0")


# ── the guard that actually fires: the VRAM watchdog ─────────────────────────────────────
#
# The watchdog covers a failure mode that does not raise OutOfMemoryError.
# On Windows, the NVIDIA driver's system-memory fallback may service an oversized allocation from
# host memory instead of refusing it, so the batch may thrash rather than fail. A 16-chunk workload
# on a 24 GB card left 633 MiB free and kept running.
#
# So the OOM tests above cover a path that is dead code on the box this actually runs on, and
# these cover the one that is not.

def test_the_watchdog_stops_the_pass_before_the_driver_starts_paging(monkeypatch):
    """The floor is defended DURING the decode, not after — by the time the driver is paging,
    aborting no longer helps anyone."""
    falling = iter([20.0, 18.0, 9.0, 4.0, 1.0, 0.5])
    monkeypatch.setattr(batch, "free_gb", lambda d: next(falling, 0.1))
    # ⚠️ The clock is driven by hand. This used to be a tight loop of 64 `check()` calls, which
    # only worked because the watchdog counted STEPS — and a tight loop is the one condition
    # where steps and elapsed time are interchangeable. That is exactly the conflation that let
    # a four-minute stall through, so the fake clock is not a convenience here, it is the point.
    clock = {"t": 0.0}
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])
    with pytest.raises(batch.BatchTooBig):
        for _ in range(64):
            clock["t"] += batch._WATCH_SECONDS
            check()


def test_the_watchdog_leaves_a_healthy_card_alone(monkeypatch):
    monkeypatch.setattr(batch, "free_gb", lambda d: 18.0)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None)
    for _ in range(64):
        assert check() is False


def test_the_watchdog_is_not_slowed_down_by_the_thing_it_is_watching_for(monkeypatch):
    """The watchdog must not use the stalled workload's own clock.

    It sampled every `_WATCH_EVERY = 4` steps, based on an 18–27 ms step on a healthy card. That holds on
    a healthy card and inverts on a paging one, where a step is SECONDS — so the guard went blind
    at precisely the moment it was needed. A stalled card took 3m51s to report a condition the
    watchdog was checking continuously, while it thrashed across
    PCIe throughout. It was never wrong about WHAT to look for.

    ⚠️ A step-count watchdog PASSES `test_the_watchdog_stops_the_pass_before_the_driver_starts_
    paging` — that test calls `check()` in a tight loop, where steps and time are the same thing.
    This is the test that can tell them apart, so it drives the clock forward without calling
    `check()` any more often, which is exactly what a paging decode does.
    """
    clock = {"t": 1000.0}
    monkeypatch.setattr(batch, "free_gb", lambda d: 0.4)        # the card is already paging
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])

    # One step, and it takes 2 s because the driver is servicing it out of host RAM. A
    # count-based guard needs _WATCH_EVERY of these before it so much as looks.
    clock["t"] += 2.0
    with pytest.raises(batch.BatchTooBig):
        check()


def test_a_thread_watches_the_vocoder_because_nothing_else_can(monkeypatch):
    """The vocoder runs as one opaque call, so decode-loop cancellation checks cannot monitor it.
    A separate thread must sample memory during that call and abort promptly when paging begins.

    Every other guard here is driven by the decode loop calling the cancel hook, so all of them
    are ASLEEP for the whole of `S3Gen.inference` — one opaque call, no loop we own, no hook.
    A measured chunk stalled for 276.9 s at 0.1x real time. A monitor thread uses a clock the
    blocked call cannot stretch.
    """
    monkeypatch.setattr(batch, "_MONITOR_SECONDS", 0.01)
    monkeypatch.setattr(batch, "free_gb", lambda d: 0.3)          # already paging
    with batch._PassMonitor("cuda:0", batch.VRAM_FLOOR_GB) as mon:
        deadline = time.time() + 3.0
        while mon.tripped is None and time.time() < deadline:
            time.sleep(0.01)                                      # stands in for the opaque call
    assert mon.tripped, "the thread never noticed the card was paging"
    with pytest.raises(batch.BatchTooBig):
        mon.check()


def test_the_monitor_leaves_a_healthy_card_alone(monkeypatch):
    monkeypatch.setattr(batch, "_MONITOR_SECONDS", 0.01)
    monkeypatch.setattr(batch, "free_gb", lambda d: 18.0)
    with batch._PassMonitor("cuda:0", batch.VRAM_FLOOR_GB) as mon:
        time.sleep(0.15)
    assert mon.tripped is None
    mon.check()                                                   # must not raise


def test_a_step_that_takes_orders_longer_than_its_peers_aborts_the_pass(monkeypatch):
    """A sudden eight-second step must abort even when the free-VRAM sample looks fine.

    Relative latency detects a dangerous stall; it does not prove host-RAM paging caused it.
    """
    clock = {"t": 0.0}
    monkeypatch.setattr(batch, "free_gb", lambda d: 18.0)         # VRAM looks perfectly fine
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])

    for _ in range(batch._BASELINE_STEPS + 2):                    # establish 20 ms as healthy
        clock["t"] += 0.02
        assert check() is False
    clock["t"] += 8.0                                             # one step, eight seconds
    with pytest.raises(batch.BatchTooBig, match="possible GPU memory pressure"):
        check()


def test_a_uniformly_slow_card_is_not_mistaken_for_a_stalled_one(monkeypatch):
    """An R9700 is slower than a 4090 uniformly, and this only ever compares a card to itself."""
    clock = {"t": 0.0}
    monkeypatch.setattr(batch, "free_gb", lambda d: 18.0)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])
    for _ in range(200):                                          # every step a slow 300 ms
        clock["t"] += 0.3
        assert check() is False


def test_the_watchdog_bounds_a_stall_in_SECONDS_not_in_steps(monkeypatch):
    """The bound is wall clock, so it holds however slow a step becomes."""
    clock = {"t": 0.0}
    monkeypatch.setattr(batch, "free_gb", lambda d: 0.4)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, None, clock=lambda: clock["t"])

    # Steps that each take a full minute — the paging regime. It must abort on the first one
    # past the interval, not after `_WATCH_SECONDS` worth of *steps*.
    steps = 0
    with pytest.raises(batch.BatchTooBig):
        for _ in range(100):
            steps += 1
            clock["t"] += 60.0
            check()
    assert steps == 1, f"it burned {steps} minute-long steps before looking"
    assert batch._WATCH_SECONDS <= 2.0, (
        f"_WATCH_SECONDS={batch._WATCH_SECONDS} — the whole point is a tight bound on thrash")


def test_a_user_cancel_beats_the_watchdog_and_is_final(monkeypatch):
    """A canceled render returns nothing and must not be retried at a smaller batch — the client banks
    a completed chunk as final, so a partial handed back as real poisons every resume."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 18.0)
    check = batch._vram_watchdog("cuda:0", batch.VRAM_FLOOR_GB, lambda: True)
    with pytest.raises(batch.BatchCanceled) as got:
        check()
    assert not isinstance(got.value, batch.BatchTooBig), "a user cancel must not look retryable"

    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    tries = []

    def canceled(model, texts, device, **kw):
        tries.append(len(texts))
        raise batch.BatchCanceled()

    monkeypatch.setattr(batch, "_one_pass", canceled)
    with pytest.raises(batch.BatchCanceled):
        batch.render_batch(object(), ["a", "b", "c", "d"], device="cuda:0")
    assert len(tries) == 1, f"a canceled batch was retried: {tries}"


def test_the_prefill_does_not_pay_for_tensors_nothing_reads():
    """🔴 ~2.8 GB per pass, at the shipped n=32 cell, on values that are computed and dropped.

    `output_hidden_states=True` materializes all 31 layers' outputs when exactly one is read —
    and that one is `last_hidden_state`, returned by default. The speech head then ran over every
    position of the prefix when `logits_all[:, -1, :]` is the only value ever consumed.

    Both only bite on the PREFILL, where the prefix is hundreds of positions across 2N CFG rows;
    every later step feeds a single token. And both land BEFORE the decode loop, so before the
    VRAM watchdog has sampled even once — the largest transient of the pass, in the one window
    with nothing looking, and invisible to `batch_cap`, whose cost model is KV-cache arithmetic
    and nothing else.

    Asserted on the CALL rather than on the memory, because a memory assertion needs a real card
    and this needs to run everywhere. `bench-satellite-batching.py verify` is what proves the
    output did not change: 4/4 chunks token-for-token against stock `T3.inference`.
    """
    t3 = FakeT3()
    rows = [torch.tensor([1, 2, 3]), torch.tensor([4, 5])]
    batch.batched_t3(t3, object(), rows, max_new_tokens=1, cfg_weight=0.5)

    assert t3.tfmr.calls, "the transformer was never called"
    asked = [c["output_hidden_states"] for c in t3.tfmr.calls]
    assert not any(asked), (
        "the decode asked for EVERY layer's hidden states; only the last is read, and it is "
        f"`last_hidden_state` — returned by default. output_hidden_states per call: {asked}")


def test_two_replicas_on_one_card_do_not_each_budget_the_whole_card(monkeypatch):
    """`Engine.load({"cuda:0": 2})` is supported, with one worker per
    replica, so two threads can call `batch_cap` for the same device at the same instant. Both
    read the same free-VRAM figure and both size a pass to fill it — two passes against one
    budget, which is how a card that had room for the batch runs out of it anyway.

    Asserted as the property that matters: sizing and running never overlap on one device. The
    free-VRAM probe here fails outright if a second pass is in flight, which is exactly what the
    real card cannot tell us.

    Verified red with the `_pass_lock` line removed: both threads are inside at once.
    """
    live = {"n": 0, "worst": 0}
    mu = threading.Lock()

    def free_gb(dev):
        with mu:
            live["worst"] = max(live["worst"], live["n"])
        return 100.0

    def one_pass(model, texts, device, **kw):
        with mu:
            live["n"] += 1
            live["worst"] = max(live["worst"], live["n"])
        time.sleep(0.05)
        with mu:
            live["n"] -= 1
        return [np.zeros(4, dtype=np.float32) for _ in texts]

    monkeypatch.setattr(batch, "free_gb", free_gb)
    monkeypatch.setattr(batch, "_one_pass", one_pass)

    def drive():
        list(batch.render_batch_iter(object(), ["a", "b", "c", "d"], device="cuda:0"))

    threads = [threading.Thread(target=drive) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)

    assert live["worst"] == 1, (
        f"{live['worst']} passes were live on cuda:0 at once — both sized from the same free-VRAM "
        f"reading and each budgeted the whole card")


def test_a_batch_that_cannot_halve_any_further_is_NOT_reported_as_a_cancel(monkeypatch):
    """A VRAM ceiling and a user cancel are different conditions, and `BatchTooBig`
    used to be a `BatchCanceled` — so at `want <= 1` the card's "I ran out of memory" arrived as
    "the user stopped this".

    `Engine.render_batch_iter` catches `BatchCanceled` and converts it to `GenerationCanceled`;
    the server turns that into a `{"status": "canceled"}` trailer; `iter_batch` raises
    `SatelliteCanceled`; and `WorkerPool._run_batch` DROPS every undelivered chunk on a cancel
    without retrying it, and without counting a batch failure. So a book section lost chunks
    silently and the worker kept submitting into the same wall for ever.

    Asserted as the type relationship AND at the raise site, because either alone would let the
    other be reintroduced: a future `class BatchTooBig(BatchCanceled)` passes the second test.
    """
    assert not issubclass(batch.BatchTooBig, batch.BatchCanceled), (
        "a VRAM ceiling must not be catchable as a user cancel — Engine.render_batch_iter's "
        "`except BatchCanceled` would convert it and the client would drop the chunks instead of "
        "retrying them")

    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)

    def always_too_big(model, texts, device, **kw):
        raise batch.BatchTooBig("free VRAM fell below 1.5 GB on cuda:0")

    monkeypatch.setattr(batch, "_one_pass", always_too_big)
    # It halves 1 -> raises. What escapes must be retryable, not treated as a user cancel.
    with pytest.raises(batch.BatchTooBig) as got:
        batch.render_batch(object(), ["only one"], device="cuda:0")
    assert not isinstance(got.value, batch.BatchCanceled)


def test_a_batch_the_watchdog_stopped_halves_and_retries(monkeypatch):
    """🔴 The path that replaces the OOM handler. Same outcome as §5.2 wanted — never fail the
    render for want of a smaller batch — reached by a guard that fires on the real box."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    seen = []

    def fake_pass(model, texts, device, **kw):
        seen.append(len(texts))
        if len(texts) > 2:
            raise batch.BatchTooBig("free VRAM fell below 1.5 GB on cuda:0")
        return [np.full(4, float(t), dtype=np.float32) for t in texts]

    monkeypatch.setattr(batch, "_one_pass", fake_pass)
    out = batch.render_batch(object(), [1.0, 2.0, 3.0, 4.0, 5.0], device="cuda:0")
    assert seen[0] == 5 and 2 in seen, f"it did not halve its way down: {seen}"
    assert [float(a[0]) for a in out] == [1.0, 2.0, 3.0, 4.0, 5.0], "order did not survive"


# ── the ceiling underneath every other guard ─────────────────────────────────────────────

def _fake_torch(*, free_gb, total_gb, reserved_gb, hip=None, calls=None):
    return types.SimpleNamespace(
        cuda=types.SimpleNamespace(
            is_available=lambda: True,
            mem_get_info=lambda i=0: (int(free_gb * 1024 ** 3), int(total_gb * 1024 ** 3)),
            memory_reserved=lambda i=0: int(reserved_gb * 1024 ** 3),
            set_per_process_memory_fraction=(
                lambda f, i: calls.append((f, i))) if calls is not None else (lambda f, i: None),
        ),
        version=types.SimpleNamespace(hip=hip),
    )


def test_torch_is_capped_so_the_driver_is_never_asked_for_the_overflow(monkeypatch):
    """Free VRAM is not the right signal for this guard. A measured case showed 100% GPU load,
    134 W, 6% memory-controller load, **37% bus interface
    load**, fans stopped — with **8 GB free**. It stalled identically at 23 GB used and at 16 GB.
    The driver's sysmem fallback does not fire when total free runs out; it fires when ONE
    allocation cannot find a CONTIGUOUS block, and `mem_get_info` reports total free, not the
    largest free block. So every budget in this module read "plenty of room" while the card was
    already streaming over PCIe.

    `set_per_process_memory_fraction` moves the refusal INTO TORCH, before `cudaMalloc` is
    called at all — so the driver never gets the chance to answer out of host RAM, and what
    surfaces is the `OutOfMemoryError` that `_is_oom` has always known how to halve and retry.
    """
    calls = []
    monkeypatch.setattr(batch, "_torch",
                        lambda: _fake_torch(free_gb=8.0, total_gb=24.0, reserved_gb=4.0,
                                            calls=calls))
    frac = batch.bound_process_memory("cuda:0")
    # torch already holds 4 GB; of the 8 GB free, 2 stays outside its reach for the desktop.
    assert calls == [(pytest.approx(10.0 / 24.0), 0)], f"nothing was capped: {calls}"
    assert frac == pytest.approx(10.0 / 24.0)


def test_the_cap_leaves_the_desktop_its_headroom_even_when_the_card_is_tight(monkeypatch):
    """The configured allowance is required. With less free than the
    headroom, torch may not grow AT ALL — which is the hard stop, not a bug."""
    calls = []
    monkeypatch.setattr(batch, "_torch",
                        lambda: _fake_torch(free_gb=1.0, total_gb=24.0, reserved_gb=6.0,
                                            calls=calls))
    frac = batch.bound_process_memory("cuda:0")
    assert frac == pytest.approx(6.0 / 24.0), "torch was allowed to grow into the desktop"


def test_rocm_is_left_alone(monkeypatch):
    """🔴 §6 again: `device.startswith("cuda")` is True on an R9700. There is no sysmem fallback
    to defeat on ROCm — a real OOM is already raised — so a cap here would only be a new way to
    fail a render that would have succeeded."""
    calls = []
    monkeypatch.setattr(batch, "_torch",
                        lambda: _fake_torch(free_gb=8.0, total_gb=32.0, reserved_gb=4.0,
                                            hip="7.2", calls=calls))
    assert batch.bound_process_memory("cuda:0") == 0.0
    assert calls == [], "ROCm had a CUDA-only cap applied to it"


# ── what the card learns, and how fast it is allowed to forget it ────────────────────────

@pytest.fixture(autouse=True)
def _forget_what_the_card_learned():
    """`_LEARNED` is process-global by design (per DEVICE, in memory only). Left dirty it makes
    these tests order-dependent and every other batch test quietly undersized.

    ⚠️ `_ALLOC_RATIO` is the same shape and needs the same treatment — and it fails the OTHER
    way: a dirty ratio makes every later `batch_cap` assertion quietly OVERSIZED, which reads as
    a passing test right up until it does not."""
    yield
    with batch._LEARNED_MU:
        batch._CEILING.clear()
    with batch._ALLOC_RATIO_MU:
        batch._ALLOC_RATIO.clear()
        batch._ALLOC_LANDED.clear()






def test_the_learned_correction_is_per_device():
    """Two cards in one satellite are independent: a correction measured on one must not shrink
    the other, which may be idle, larger, or serving another workload."""
    batch.note_batch_too_big("cuda:0", 16)
    assert batch.batch_ceiling("cuda:0") == 15
    assert batch.batch_ceiling("cuda:1") == 0


def test_a_trip_backs_off_by_one_chunk_and_not_by_half():
    """When a batch exceeds the ceiling, back off by one chunk and retry. Multiplicative backoff
    can leave the card at half capacity for many subsequent passes.

    The multiplicative version halved the card and crept back at 1.1x per EIGHT landed passes, so
    one trip early in a chapter held the satellite at half capacity for the ~58 passes after it —
    which is why it spent the rest of that chapter feeding on single chunks.
    """
    assert batch.note_batch_too_big("cuda:0", 16) == 15
    assert batch.batch_ceiling("cuda:0") == 15
    # …and a second trip at the new size backs off one more, never to a fraction of it.
    assert batch.note_batch_too_big("cuda:0", 15) == 14


def test_the_ceiling_only_ever_tightens_until_something_lands():
    """A trip at a SMALLER size than the ceiling must lower it; a trip at a larger one must not
    raise it. The number is "what this card may attempt", and only a landed pass may loosen it."""
    batch.note_batch_too_big("cuda:0", 16)          # ceiling 15
    batch.note_batch_too_big("cuda:0", 30)          # a bigger failure says nothing new
    assert batch.batch_ceiling("cuda:0") == 15
    batch.note_batch_too_big("cuda:0", 8)           # a smaller one does
    assert batch.batch_ceiling("cuda:0") == 7


def test_a_pass_that_lands_at_the_ceiling_earns_exactly_one_more_chunk():
    """After a pass at the ceiling succeeds, try one more chunk. Only
    AT the ceiling — a small pass landing says nothing about a big one, and raising on every
    success is how the old multiplier climbed straight back into the same wall every few minutes.
    """
    batch.note_batch_too_big("cuda:0", 16)          # ceiling 15
    batch.note_batch_ok("cuda:0", 4)                # a small pass proves nothing about 15
    assert batch.batch_ceiling("cuda:0") == 15
    batch.note_batch_ok("cuda:0", 15)               # this one does
    assert batch.batch_ceiling("cuda:0") == 16
    batch.note_batch_ok("cuda:0", 16)
    assert batch.batch_ceiling("cuda:0") == 17


def test_a_card_that_has_never_tripped_has_no_ceiling(monkeypatch):
    """0 means "nothing has failed here", not "may take nothing" — a fresh card is bounded only by
    free VRAM and the growth walk, exactly as it was before any of this existed."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    assert batch.batch_ceiling("cuda:0") == 0
    assert batch.batch_cap("cuda:0", 32, ["x" * 60] * 32) == batch.MAX_BATCH


def test_long_texts_shrink_the_batch_where_short_ones_do_not(monkeypatch):
    """Length, not count, is the variable that filled the card. A measured run with the
    same batch sizes and only the text length changed: 16 SHORT chunks cost 2.08 GB with per-chunk
    cost FLAT from 1 to 16, while 16 LONG ones drove a 24 GB card to 633 MiB free. A cap counting
    chunks alone is the wrong shape."""
    # A character heuristic predicted 13.6 GB for eight 350-character chunks; the measured batch
    # uses 5.58 GB. Exercise a genuinely constrained card rather than an inaccurate estimate:
    # 8 GB free buys eight short chunks and only six long ones.
    monkeypatch.setattr(batch, "free_gb", lambda d: 8.0)
    short = ["a short line." for _ in range(8)]
    long = ["x" * 350 for _ in range(8)]
    cap_short = batch.batch_cap("cuda:0", 8, short)
    cap_long = batch.batch_cap("cuda:0", 8, long)
    assert cap_short == 8, f"short chunks were shrunk for no reason ({cap_short})"
    assert cap_long < cap_short, (
        f"long chunks got the same batch as short ones ({cap_long} vs {cap_short}) — the cap is "
        f"counting chunks and ignoring the thing that actually fills the card")
    assert cap_long >= 1


def test_a_non_oom_error_is_not_retried(monkeypatch):
    """Halving is for memory. Retrying a real bug four times turns one traceback into four and
    the render still fails, three batches later."""
    monkeypatch.setattr(batch, "free_gb", lambda d: 100.0)
    tries = []

    def boom(model, texts, device, **kw):
        tries.append(len(texts))
        raise ValueError("the voice is not loaded")

    monkeypatch.setattr(batch, "_one_pass", boom)
    with pytest.raises(ValueError):
        batch.render_batch(object(), ["a", "b", "c", "d"], device="cuda:0")
    assert len(tries) == 1, f"a non-OOM error was retried: {tries}"


# ── §6: the vendor split ─────────────────────────────────────────────────────────────────

def test_s3gen_batching_is_cuda_only(monkeypatch):
    """🔴 §6, and it is the thing most likely to be 'cleaned up' by someone who notices that
    ROCm reports itself as `cuda` everywhere. Measured on an R9700: batched S3Gen is DEAD FLAT
    at ~4.5 s per chunk — about 2.5× worse per chunk than unbatched — and reaches 86% of wall
    time at n=16. `torch.version.hip` is the only honest signal."""
    fake = types.SimpleNamespace(
        version=types.SimpleNamespace(hip=None),
        cuda=types.SimpleNamespace(is_available=lambda: True))
    monkeypatch.setattr(batch, "_torch", lambda: fake)
    assert batch.s3gen_batching_ok("cuda:0") is True

    fake.version.hip = "7.2.0"                                 # the same device string, on ROCm
    assert batch.s3gen_batching_ok("cuda:0") is False, (
        "ROCm reports itself as cuda — device.startswith('cuda') is not the test")
    fake.version.hip = None
    assert batch.s3gen_batching_ok("cpu") is False


def test_bf16_is_not_used_anywhere_in_the_batch_path():
    """bf16 autocast measured 13.5% slower than fp32 and used about 1 GB more.
    The client wraps generation in `_autocast_ctx()` while the satellite does not; this difference is
    accidental and accidentally CORRECT. It is pinned here because it looks exactly like an
    obvious cleanup, and the cost of the cleanup is a silent 13.5%."""
    src = (REPO_ROOT / "satellite" / "vocalis_satellite_batch.py").read_text(encoding="utf-8")
    # Strip docstrings AND comments — the module explains at length why bf16 is absent, and a
    # scan that read prose would be asserting against its own warning.
    code = re.sub(r'"""[\s\S]*?"""', "", src)
    code = "\n".join(ln for ln in code.splitlines() if not ln.lstrip().startswith("#"))
    assert "autocast" not in code and "bfloat16" not in code


# ── the conditionals cache, which is VRAM the batch cannot have ──────────────────────────

def test_the_voice_cache_is_bounded_in_VRAM_not_in_voices():
    """`VOICE_CACHE_MAX = 64` was justified by an estimate of single-digit megabytes per prepared
    conditional. A measured conditional used **219.8 MiB**, so a full cache was
    **13.73 GB per replica** — on a 24 GB card. A cache miss costs 81 ms against a 2–17 s pass,
    so the old bound spent 13.7 GB to save 81 ms.

    It is not just waste. `batch_cap` sizes every pass from free VRAM, so the cache growing
    silently shrank every batch: throughput fell the longer the process ran and nothing said so.
    The bound is asserted in GB, because voices are not the unit that runs out.
    """
    import sys
    sys.path.insert(0, str(REPO_ROOT / "satellite"))
    import vocalis_satellite_engine as eng

    for total_gb, label in ((24.0, "a 4090"), (8.0, "a small card"), (48.0, "a big one")):
        n = _cache_size_for(eng, total_gb)
        cost = n * eng.GB_PER_CACHED_VOICE
        assert n >= 2, f"{label}: {n} voices — a two-character scene would evict every chunk"
        assert cost <= eng.VOICE_CACHE_GB_MAX + 1e-9, (
            f"{label}: the cache may hold {n} voices = {cost:.2f} GB, over the "
            f"{eng.VOICE_CACHE_GB_MAX} GB ceiling — that is VRAM the batch cannot have")
        assert cost <= 0.25 * total_gb, (
            f"{label}: {cost:.2f} GB of {total_gb} GB on an 81 ms saving")
    # The old behavior, stated so it cannot come back by accident.
    assert _cache_size_for(eng, 24.0) < 64


def _cache_size_for(eng, total_gb):
    """`voice_cache_size` for a card of `total_gb`, without needing one."""
    import types
    fake = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: True,
                                   mem_get_info=lambda i: (0, int(total_gb * 1024 ** 3))))
    import sys
    real = sys.modules.get("torch")
    sys.modules["torch"] = fake
    try:
        return eng.voice_cache_size("cuda:0")
    finally:
        if real is not None:
            sys.modules["torch"] = real
        else:
            del sys.modules["torch"]


def test_an_evicted_voice_is_given_back_to_the_DRIVER_not_just_to_torch(monkeypatch):
    """🔴 The half that makes the eviction worth anything.

    Dropping the last reference returns the 220 MiB to *torch's* pool. `batch_cap` reads
    `mem_get_info`, which is the DRIVER's view — a cached-but-free block still reads as
    unavailable and still shrinks the next batch. So an eviction that does not
    `empty_cache()` buys nothing for the one thing it exists to protect.
    """
    import sys
    sys.path.insert(0, str(REPO_ROOT / "satellite"))
    import vocalis_satellite_engine as eng

    drops = []
    fake = type(sys)("torch")
    fake.cuda = type(sys)("cuda")
    fake.cuda.is_available = lambda: True
    fake.cuda.empty_cache = lambda: drops.append(1)
    monkeypatch.setitem(sys.modules, "torch", fake)

    c = eng.VoiceCache(maxsize=2)
    c.put("a", object())
    c.put("b", object())
    assert not drops, "nothing was evicted yet, so nothing should have been handed back"
    c.put("c", object())                       # evicts "a"
    assert c.warm() == ["b", "c"]
    assert drops, "a voice was evicted and the memory was never returned to the driver"
