"""A satellite may retain a short batch and advertise how many additional chunks it can accept.

Batch overhead can dominate small passes, so the client tops up a held batch to the requested size when compatible work is available. It must flush any remainder when the chain ends, preserve chunk IDs across calls, and keep SillyTavern submissions within their configured slice. A remainder that is neither topped up nor flushed can block completion.

The tests exercise top-up, flush, section isolation, and wire-ID behavior with an in-memory satellite replica.
"""
import threading

import pytest
import torch

import tts_utils
from conftest import make_fake_pool
from tts_utils import GenParams, BATCH

SR = 100


def _wav(samples=200):
    return torch.zeros(1, int(samples))


class HoldingSat:
    """A satellite replica that holds a remainder exactly as `render_batch_iter` does.

    `room` is a full pass on this card. Anything smaller is kept rather than rendered — but ONLY
    when the caller says more is coming, which is the whole safety mechanism.
    """
    is_remote = True
    can_batch = True

    def __init__(self, room=4, take=0, slice_=32, hold_always=False, st_slice=1):
        self.sr = SR
        self.batch_slice = slice_
        # `RemoteModel.st_batch_slice` limits only live SillyTavern speech submissions.


        self.st_batch_slice = st_slice
        self.take = take                # what /satellite/capacity answers
        self.room = room
        self.hold_always = hold_always  # a BROKEN card: holds even when told no more is coming
        self.held = []                  # [(cid, text)] this card is sitting on
        self.calls = []                 # one record per request
        self.last_trailer = {}
        self.singles = []
        self.lock = threading.Lock()

    def capacity(self, lengths):
        return self.take

    def generate_batch(self, items, more_available=False, held=(), **kw):
        expected = {str(h) for h in (held or ())}
        with self.lock:
            # The real card drops anything it holds that the caller no longer names — that is
            # what stops a remainder from an abandoned chain being prepended to a stranger's work.
            dropped = [cid for cid, _t in self.held if cid not in expected]
            carried = [(cid, t) for cid, t in self.held if cid in expected]
            self.held = []
            batch = carried + [(str(cid), text) for cid, text in items]
            rec = {"sent": [str(cid) for cid, _t in items], "more": bool(more_available),
                   "named": sorted(expected), "dropped": dropped,
                   "rendered": [], "size": len(batch)}
            self.calls.append(rec)
        self.last_trailer = {}
        if (more_available or self.hold_always) and len(batch) < self.room:
            with self.lock:
                self.held = list(batch)
            self.last_trailer = {"status": "ok", "held": [cid for cid, _t in batch],
                                 "want": max(1, self.room - len(batch))}
            return
        for cid, text in batch:
            rec["rendered"].append(cid)
            # Samples ARE the text length, so a chunk landing under the wrong index is visible in
            # the saved audio rather than only in the ids — which is the failure that actually
            # matters and the one ids alone cannot catch.
            yield cid, _wav(len(text))

    def generate(self, text, **kw):
        with self.lock:
            self.singles.append(text)
        return _wav(len(text))


def _pool(model, n_workers=1):
    pool = make_fake_pool(n_workers)
    pool.sr = SR
    for w in pool.workers:
        pool._models[w["id"]] = model
    return pool


def _run(pool, texts, **kw):
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, t) for i, t in enumerate(texts)]
    out = pool.run_chunks(items, GenParams(), save, total=len(items), **kw)
    return saved, out


def _assert_all_landed(saved, texts):
    """Every chunk present, and every one of them the RIGHT chunk."""
    assert sorted(saved) == list(range(len(texts))), \
        f"chunks missing from the render: {sorted(set(range(len(texts))) - set(saved))}"
    for i, t in enumerate(texts):
        assert saved[i].shape[-1] == len(t), \
            (f"chunk {i} banked {saved[i].shape[-1]} samples but its text is {len(t)} long — "
             f"a chunk landed under another chunk's index")


# ── the top-up itself ────────────────────────────────────────────────────────


def test_a_short_remainder_is_topped_up_instead_of_rendered_small():
    """The replica holds the first two chunks, requests two more, and renders all four in one pass. This exercises the top-up path that avoids repeated short passes at a chapter tail.
    """
    sat = HoldingSat(room=4, take=2)
    texts = [f"chunk-{i:02d}" for i in range(4)]
    saved, _ = _run(_pool(sat), texts)

    _assert_all_landed(saved, texts)
    assert sat.calls[0]["rendered"] == [], \
        "the card rendered a short pass instead of holding it for a top-up"
    assert sat.calls[0]["size"] == 2 and sat.calls[1]["size"] == 4, \
        f"expected a submission of 2 held, then a pass of 4: {[c['size'] for c in sat.calls]}"
    assert len(sat.calls[1]["rendered"]) == 4, \
        f"the top-up did not render as one pass: {sat.calls}"
    assert sat.singles == [], "a chunk fell back to the serial path"


def test_the_top_up_asks_for_exactly_what_the_card_said_it_wanted():
    """Honor the card's advertised capacity exactly; the client must not infer a different target.
    """
    sat = HoldingSat(room=6, take=2)
    texts = [f"chunk-{i:02d}" for i in range(8)]
    saved, _ = _run(_pool(sat), texts)

    _assert_all_landed(saved, texts)
    # The card held 2 and had room for 4 more; the second submission must be exactly those 4.
    assert sat.calls[0]["size"] == 2, f"first submission: {sat.calls[0]}"
    assert len(sat.calls[1]["sent"]) == 4, \
        f"the top-up sent {len(sat.calls[1]['sent'])} where the card asked for 4: {sat.calls}"
    assert sat.calls[1]["size"] == 6, "the held chunks did not join the top-up in one pass"


def test_the_card_is_told_what_it_is_holding_so_a_stale_remainder_is_dropped():
    """The client identifies exactly the chunks it expects the card to be holding. If a prior chain ended abnormally, unclaimed chunks must be dropped instead of being prepended to an unrelated later submission.
    """
    sat = HoldingSat(room=4, take=2)
    texts = [f"chunk-{i:02d}" for i in range(4)]
    _run(_pool(sat), texts)

    assert sat.calls[0]["named"] == [], "the first call of a chain must name nothing as held"
    # The top-up must name exactly what the card kept, or the card would drop it.
    kept = sat.calls[0]["sent"]
    assert sat.calls[1]["named"] == sorted(kept), \
        f"the top-up named {sat.calls[1]['named']} as held, but the card kept {sorted(kept)}"
    assert sat.calls[1]["dropped"] == [], \
        f"the card dropped chunks it was still holding for us: {sat.calls[1]['dropped']}"


# ── SillyTavern batch ceiling ───────────────────────────────────────────────────


def test_the_top_up_cannot_grow_a_sillytavern_pass_past_the_setting():
    """The card may have room for a larger pass than the configured SillyTavern slice. Every rendered pass must stay within that limit and still finish; a top-up clamped to zero must flush rather than hang.

    Without the clamp, this scenario produces a pass of six.
    """
    sat = HoldingSat(room=8, take=32, st_slice=3)
    texts = [f"chunk-{i:02d}" for i in range(6)]
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, t) for i, t in enumerate(texts)]
    pool = _pool(sat)
    pool.collect(pool.submit(items, GenParams(), priority=tts_utils.INTERACTIVE, save=save,
                             total=len(items), st_speech=True))

    _assert_all_landed(saved, texts)
    assert max(c["size"] for c in sat.calls) <= 3, \
        f"a pass grew past the ceiling on a top-up: {[c['size'] for c in sat.calls]}"
    assert any(c["rendered"] for c in sat.calls), "nothing was ever rendered"


def test_a_full_capped_submission_is_rendered_ON_THE_SPOT_not_held_for_a_top_up():
    """Render each capped batch immediately. When the configured ceiling prevents the client from filling a held remainder, advertising that more is coming would make the card wait for a top-up the client cannot send.

    The test checks that no empty-hold round trip occurs and all batches remain within the cap.
    """
    sat = HoldingSat(room=8, take=32, st_slice=2)
    texts = [f"chunk-{i:02d}" for i in range(4)]
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, t) for i, t in enumerate(texts)]
    pool = _pool(sat)
    pool.collect(pool.submit(items, GenParams(), priority=tts_utils.INTERACTIVE, save=save,
                             total=len(items), st_speech=True))

    _assert_all_landed(saved, texts)
    assert all(c["rendered"] for c in sat.calls), (
        "a request that rendered nothing is a wasted round trip under a ceiling: "
        f"{[(c['size'], len(c['rendered'])) for c in sat.calls]}")
    assert not any(c["more"] for c in sat.calls), \
        "a full capped submission must not claim more is coming"
    assert len(sat.calls) == 2, \
        f"two chunks per pass, two passes, one call each: {[c['size'] for c in sat.calls]}"


# ── the flush: the chain always ends in a render ─────────────────────────────


def test_a_card_holding_with_nothing_left_to_send_is_flushed():
    """The client may announce more work before it knows whether compatible queued chunks remain. If the queue has no work that can join the held batch, send an empty submission with `more_available=False` so the card renders its remainder.

    A different section can remain queued but cannot join because its parameters differ. The flush makes this safe without dequeuing incompatible work.
    """
    sat = HoldingSat(room=8, take=32)
    a = [f"aaa-{i:02d}" for i in range(3)]
    b = [f"bbbbbb-{i:02d}" for i in range(3)]
    pool = _pool(sat)
    saved_a, saved_b, lock = {}, {}, threading.Lock()

    def save_a(idx, wav, sr):
        with lock:
            saved_a[idx] = wav

    def save_b(idx, wav, sr):
        with lock:
            saved_b[idx] = wav

    cancel = threading.Event()
    ba = pool.submit_chunks([(i, t) for i, t in enumerate(a)], GenParams(), save_a,
                            total=len(a), chapter=0, cancel=cancel)
    # A DIFFERENT voice — so it may never ride in the same pass, and the top-up drain finds
    # nothing it can take even though the queue is not empty.
    bb = pool.submit([(i, t) for i, t in enumerate(b)], GenParams(voice="someone-else"),
                     priority=BATCH, save=save_b, total=len(b), chapter=1, cancel=cancel)
    pool.collect_chunks(ba)
    pool.collect_chunks(bb)

    _assert_all_landed(saved_a, a)
    _assert_all_landed(saved_b, b)
    flushes = [c for c in sat.calls if not c["sent"]]
    assert flushes, f"the card was left holding and never flushed: {sat.calls}"
    assert all(c["more"] is False for c in flushes), \
        "a flush must say more_available=False or the card holds again and the render hangs"
    assert all(c["rendered"] for c in flushes), "the flush did not render what the card held"


def test_the_end_of_the_book_renders_the_remainder_rather_than_holding_it():
    """With no queued work, the first call sets `more_available=False` and the card renders the remainder immediately.
    """
    sat = HoldingSat(room=32, take=32)
    texts = [f"chunk-{i:02d}" for i in range(3)]
    saved, _ = _run(_pool(sat), texts)

    _assert_all_landed(saved, texts)
    assert len(sat.calls) == 1, \
        f"nothing was queued behind this, so one call should have done it: {sat.calls}"
    assert sat.calls[0]["more"] is False, \
        "the card was told more was coming when the queue was empty — it would hold and hang"
    assert len(sat.calls[0]["rendered"]) == 3


# ── what a held chunk must NOT be mistaken for ───────────────────────────────


def test_holding_is_not_a_failure():
    """A chunk explicitly held by the card is not an undelivered chunk. Carry its ID into the top-up without spending a retry or turning a healthy pass into an error.
    """
    sat = HoldingSat(room=6, take=2)
    texts = [f"chunk-{i:02d}" for i in range(12)]
    pool = _pool(sat)
    saved, _ = _run(pool, texts)

    _assert_all_landed(saved, texts)
    holds = [c for c in sat.calls if not c["rendered"]]
    assert len(holds) >= 2, f"this test needs at least two holds to be meaningful: {sat.calls}"
    assert sat.singles == [], "chunks fell back to the serial path"


def test_a_wire_id_is_never_reused_across_a_chain():
    """A held chunk keeps its ID across calls while a later submission can contain a new chunk at position zero. Position-based IDs would collide and could associate returned audio with the wrong text.
    """
    sat = HoldingSat(room=5, take=2)
    texts = [f"chunk-{i:02d}-{'x' * i}" for i in range(10)]
    saved, _ = _run(_pool(sat), texts)

    _assert_all_landed(saved, texts)
    seen, dupes = set(), []
    for call in sat.calls:
        for cid in call["sent"]:
            if cid in seen:
                dupes.append(cid)
            seen.add(cid)
    assert not dupes, f"wire id(s) reused within one render: {dupes}"


def test_two_sections_chained_through_a_hold_keep_their_own_chunk_numbers():
    """Both sections number their chunks from zero, and a hold can carry one section's IDs into a call containing the other section's chunks. Audio must land under the right index in the right section.
    """
    sat = HoldingSat(room=6, take=2)
    a = [f"a{i}-{'x' * (i + 1)}" for i in range(4)]
    b = [f"b{i}-{'y' * (i + 7)}" for i in range(4)]
    pool = _pool(sat)
    saved_a, saved_b, lock = {}, {}, threading.Lock()

    def save_a(idx, wav, sr):
        with lock:
            saved_a[idx] = wav

    def save_b(idx, wav, sr):
        with lock:
            saved_b[idx] = wav

    cancel = threading.Event()
    params = GenParams()
    ba = pool.submit_chunks([(i, t) for i, t in enumerate(a)], params, save_a,
                            total=len(a), chapter=0, cancel=cancel)
    bb = pool.submit([(i, t) for i, t in enumerate(b)], params, priority=BATCH,
                     save=save_b, total=len(b), chapter=1, cancel=cancel)
    pool.collect_chunks(ba)
    pool.collect_chunks(bb)

    _assert_all_landed(saved_a, a)
    _assert_all_landed(saved_b, b)


def test_a_card_that_holds_without_a_license_is_treated_as_broken():
    """⚠️ DEFENSIVE, and it must not hang. A card that keeps chunks after being told no more are
    coming would sit on them forever, so those ids are treated as undelivered: they are retried,
    then the render fails visibly if the card keeps violating the contract."""
    sat = HoldingSat(room=32, take=32, hold_always=True)
    texts = [f"chunk-{i:02d}" for i in range(4)]
    pool = _pool(sat)
    with pytest.raises(RuntimeError, match="failed permanently"):
        _run(pool, texts)
    assert sat.singles == [], "a broken batch was silently rerouted to serial rendering"


def test_an_old_satellite_that_never_holds_is_unaffected():
    """A satellite that does not return the optional `held` trailer keeps the one-call behavior; the client must remain compatible with that response shape.
    """

    class OldSat(HoldingSat):
        def generate_batch(self, items, more_available=False, held=(), **kw):
            self.calls.append({"sent": [str(c) for c, _ in items], "more": bool(more_available),
                               "named": sorted(str(h) for h in held), "dropped": [],
                               "rendered": [str(c) for c, _ in items], "size": len(items)})
            self.last_trailer = {}                  # no `held` key — an older build
            for cid, text in items:
                yield str(cid), _wav(len(text))

    sat = OldSat(room=4, take=2)
    texts = [f"chunk-{i:02d}" for i in range(6)]
    saved, _ = _run(_pool(sat), texts)

    _assert_all_landed(saved, texts)
    assert all(c["rendered"] for c in sat.calls), \
        "an older satellite was left holding chunks it does not know how to hold"
