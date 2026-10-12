"""Tests the pool-side batching contract: compatible jobs may share a submission while per-chunk guarantees remain intact."""
import json
import threading
import time

import numpy as np
import pytest
import torch

import tts_utils
from satellite_client import SatelliteUnreachable
from conftest import make_fake_pool
from tts_utils import GenParams, INTERACTIVE, BATCH

SR = 100                       # 25 speech tokens/s => the 1000-token cap is 4000 samples here


def _wav(samples=200):
    return torch.zeros(1, int(samples))


class FakeBatchSat:
    """A satellite replica that advertises batching, shaped exactly as `RemoteModel` is: the
    pool touches `sr`, `can_batch`, `batch_slice`, `capacity`, `generate_batch` and `generate`
    and nothing else."""
    is_remote = True
    can_batch = True

    def __init__(self, slice_=8, samples=200, fail=None, cancel_after=None, deliver=None,
                 take=0, st_slice=1):
        self.sr = SR
        self.batch_slice = slice_
        # `batch_slice` is the configured upper bound for this satellite submission.
        # The default is one; keep the fake aligned with production configuration.
        # Otherwise a test could model a setting users cannot select.
        # make every SillyTavern cap test vacuous.
        self.st_batch_slice = st_slice
        # 7.1 — what `/satellite/capacity` answers. 0 is "no answer" (stopped, or the request
        # failed), which keeps everything drained, so every test that does not opt in is
        # unaffected by the capacity verb.
        self.take = take
        self.capacity_asked = []        # [[length, …], …] — one entry per question
        # 🔴 KEYED BY TEXT, NEVER BY WIRE ID. Since 7.3.17 the id is `next(pool._seq)` — unique
        # for the life of the pool and dependent on how many jobs it has ever queued, so a
        # fixture keyed on `"2"` addresses a different chunk in every test, or none at all. Text
        # is the only stable name a test and the pool agree on.
        self.samples = samples          # int, or {text: int}
        self.fail = fail                # exception raised mid-reply
        self.cancel_after = cancel_after
        self.deliver = deliver          # texts to actually deliver (None = all)
        self.submissions = []           # [[id, …], …] — one entry per request
        self.submitted_texts = []       # [[text, …], …] — the same requests, by CHUNK
        self.singles = []               # texts sent one at a time (the serial path)
        self.open_batches = 0           # >0 while a reply is being consumed
        self.lock = threading.Lock()

    def capacity(self, lengths):
        with self.lock:
            self.capacity_asked.append(list(lengths))
        return self.take

    def _samples_for(self, text):
        return self.samples[text] if isinstance(self.samples, dict) else self.samples

    def generate_batch(self, items, **kw):
        with self.lock:
            self.submissions.append([cid for cid, _ in items])
            # ⚠️ ASSERT ON THESE, NOT ON THE IDS, when the question is WHICH CHUNK traveled.
            # A submission may span sections, so the wire id is neither the chunk index nor a
            # position — since 7.3.17 it is a pool-lifetime counter, because a chunk the card is
            # holding keeps its id into the next call. A test that reads identity out of the ids
            # is asking the wrong object and will pass or fail for the wrong reason.
            self.submitted_texts.append([t for _, t in items])
            self.open_batches += 1
        try:
            for i, (cid, text) in enumerate(items):
                if self.cancel_after is not None and i >= self.cancel_after:
                    raise tts_utils.GenerationCanceled()
                if self.fail is not None and i >= (self.fail[0] if isinstance(self.fail, tuple) else 0):
                    raise (self.fail[1] if isinstance(self.fail, tuple) else self.fail)
                if self.deliver is not None and text not in self.deliver:
                    continue
                yield cid, _wav(self._samples_for(text))
        finally:
            with self.lock:
                self.open_batches -= 1

    def generate(self, text, **kw):
        with self.lock:
            self.singles.append(text)
            assert self.open_batches == 0, (
                "a single render was issued while a batch reply was still open — on a real "
                "satellite that waits on the replica lock the reply itself holds: a deadlock "
                "with no error and no timeout")
        return _wav(self.samples if not isinstance(self.samples, dict) else 200)


def _pool(model, n_workers=1):
    pool = make_fake_pool(n_workers)
    pool.sr = SR
    for w in pool.workers:
        pool._models[w["id"]] = model
    return pool


def _run(pool, texts, **kw):
    """run_chunks over `texts`, returning {index: wav} and the (chars, seconds) it reported."""
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, t) for i, t in enumerate(texts)]
    out = pool.run_chunks(items, GenParams(), save, total=len(items), **kw)
    return saved, out


def _run_st(pool, texts, **kw):
    """Submit live SillyTavern speech with both interactive priority and the explicit st_speech flag. Priority alone cannot identify this traffic because other interactive callers use different batching limits."""
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, t) for i, t in enumerate(texts)]
    batch = pool.submit(items, GenParams(), priority=INTERACTIVE, save=save,
                        total=len(items), st_speech=True, **kw)
    return saved, pool.collect(batch)


# ── how many jobs travel together (7.1: the satellite is asked) ───────────────


def test_the_satellite_is_asked_how_many_it_can_take_and_is_given_that_many():
    """The advertised batch size is a ceiling, not current capacity. Query available capacity before dispatch and submit only that many chunks so queued interactive work is not delayed behind an oversized drain."""
    sat = FakeBatchSat(slice_=32, take=3)
    texts = [f"chunk-{i}" for i in range(9)]
    saved, _ = _run(_pool(sat), texts)

    assert len(saved) == 9, "every chunk must still render — the surplus is requeued, not dropped"
    assert sat.capacity_asked, "the satellite was never asked what it could take"
    assert all(all(isinstance(n, int) for n in q) for q in sat.capacity_asked), \
        f"capacity must be asked in lengths, never text: {sat.capacity_asked}"
    assert sat.capacity_asked[0] == [len(t) for t in texts[:len(sat.capacity_asked[0])]]
    assert all(len(s) <= 3 for s in sat.submissions), \
        f"a submission exceeded the capacity the satellite reported: {sat.submissions}"
    assert sum(len(s) for s in sat.submissions) + len(sat.singles) == 9










def _run_two_sections(pool, texts_a, texts_b, params_b=None, cancel_b=None, priority_b=None):
    """Submit two sections the way a book does — both queued before either is collected."""
    saved_a, saved_b, lock = {}, {}, threading.Lock()

    def save_a(idx, wav, sr):
        with lock:
            saved_a[idx] = wav

    def save_b(idx, wav, sr):
        with lock:
            saved_b[idx] = wav

    cancel = threading.Event()
    pa = GenParams()
    ba = pool.submit_chunks([(i, t) for i, t in enumerate(texts_a)], pa, save_a,
                            total=len(texts_a), chapter=0, cancel=cancel)
    bb = pool.submit(
        [(i, t) for i, t in enumerate(texts_b)],
        params_b if params_b is not None else pa,
        priority=BATCH if priority_b is None else priority_b,
        save=save_b, total=len(texts_b), chapter=1,
        cancel=cancel_b if cancel_b is not None else cancel)
    pool.collect_chunks(ba)
    pool.collect_chunks(bb)
    return saved_a, saved_b


def test_a_submission_crosses_a_section_boundary_when_the_work_is_the_same():
    """Compatible jobs from adjacent sections may share a submission. Draining must continue across section boundaries when batch parameters match, rather than leaving short tails behind."""
    sat = FakeBatchSat(slice_=32, take=8)
    saved_a, saved_b = _run_two_sections(_pool(sat), [f"a-{i}" for i in range(4)],
                                         [f"b-{i}" for i in range(4)])
    assert set(saved_a) == set(range(4)) and set(saved_b) == set(range(4))
    assert any(len(s) > 4 for s in sat.submissions), (
        f"no submission crossed the boundary — each section went on its own: {sat.submissions}")


def test_two_sections_in_one_submission_do_not_collide_on_chunk_zero():
    """🔴 EVERY SECTION NUMBERS ITS CHUNKS FROM ZERO, so the wire id cannot be the chunk index.

    Keyed on the index, section B's chunk 0 overwrites section A's in `left`: one of them is
    banked as the other — the same audio in two chapters — and the other never resolves, so
    `collect()` waits out the full stall timeout and then tears down every replica on the box.
    The ids are opaque to the satellite, so they are positions in the submission.

    The saved audio is keyed per section, and the lengths differ per section, so a crossed wire
    shows up as the wrong number of samples rather than as anything subtle.
    """
    a = [f"a-{i}" for i in range(4)]
    b = [f"b-{i}" for i in range(4)]
    # Distinct per SECTION as well as per chunk, so a crossed wire shows up as the wrong number
    # of samples rather than as something subtle.
    sat = FakeBatchSat(slice_=32, take=8, samples=None)
    sat.samples = {t: 100 * (i + 1) for i, t in enumerate(a)}
    # Under the 1000-token truncation cap (4000 samples at this SR), or the re-split fires and
    # what is banked is the RETRY's audio rather than the number this test is watching.
    sat.samples.update({t: 1000 + 100 * (i + 1) for i, t in enumerate(b)})
    saved_a, saved_b = _run_two_sections(_pool(sat), a, b)
    assert sorted(saved_a) == [0, 1, 2, 3], f"section A did not resolve: {sorted(saved_a)}"
    assert sorted(saved_b) == [0, 1, 2, 3], f"section B did not resolve: {sorted(saved_b)}"
    assert len(saved_a) + len(saved_b) == 8
    for i, t in enumerate(a):
        assert saved_a[i].shape[-1] == sat.samples[t], \
            f"section A chunk {i} banked another chunk's audio ({saved_a[i].shape[-1]} samples)"
    for i, t in enumerate(b):
        assert saved_b[i].shape[-1] == sat.samples[t], \
            f"section B chunk {i} banked another chunk's audio ({saved_b[i].shape[-1]} samples)"


@pytest.mark.parametrize("kw, why", [
    ({"params_b": GenParams(voice="someone-else")}, "a batch is ONE VOICE"),
    ({"priority_b": INTERACTIVE}, "an interactive chunk must not be dragged behind a book's"),
    ({"cancel_b": threading.Event()}, "one cancel must not take another section's chunks down"),
])
def test_a_submission_refuses_work_that_is_not_the_same_job(kw, why):
    """The three things `_Batch` identity was standing in for. Each of them alone is enough to
    keep the sections apart, and the cancel one is the subtle member: `_run_batch` arms
    `_GEN_CANCEL` once for the whole submission."""
    sat = FakeBatchSat(slice_=32, take=8)
    saved_a, saved_b = _run_two_sections(_pool(sat), [f"a-{i}" for i in range(4)],
                                         [f"b-{i}" for i in range(4)], **kw)
    assert set(saved_a) == set(range(4)) and set(saved_b) == set(range(4))
    assert all(len(s) <= 4 for s in sat.submissions), (
        f"{why} — but a submission mixed them anyway: {sat.submissions}")


def test_a_satellite_that_does_not_answer_keeps_everything_that_was_drained():
    """0 is "no answer" — the satellite is stopped, or the request failed — and it must mean
    "keep what you drained", not "take nothing". These jobs are already off the shared queue,
    so dropping them here would lose them; kept, the ordinary render path reports the failure a
    moment later and resolves them properly."""
    sat = FakeBatchSat(slice_=8, take=0)
    saved, _ = _run(_pool(sat), [f"chunk-{i}" for i in range(8)])
    assert len(saved) == 8
    assert sat.submitted_texts == [[f"chunk-{i}" for i in range(8)]], \
        f"it should have kept the whole drain: {sat.submitted_texts}"


# ── which jobs travel together ────────────────────────────────────────────────

def test_queued_chunks_go_over_in_one_submission():
    """The whole point: eight chunks that would have been eight requests are one."""
    sat = FakeBatchSat(slice_=8)
    saved, (chars, _secs) = _run(_pool(sat), [f"chunk-{i}" for i in range(8)])

    assert set(saved) == set(range(8))
    assert sat.submitted_texts == [[f"chunk-{i}" for i in range(8)]]
    assert sat.singles == [], "nothing should have gone one at a time"
    assert chars == sum(len(f"chunk-{i}") for i in range(8))


def test_the_published_ceiling_sizes_the_submission():
    """`max_batch` is how many we bother to hand over at once — never permission, and never a
    promise about the card: the satellite re-splits whatever it is given by free VRAM."""
    sat = FakeBatchSat(slice_=3)
    saved, _ = _run(_pool(sat), [f"chunk-{i}" for i in range(10)])

    assert set(saved) == set(range(10))
    assert max(len(s) for s in sat.submissions) == 3, \
        f"ten queued chunks and a ceiling of three: {sat.submissions}"
    assert sum(len(s) for s in sat.submissions) + len(sat.singles) == 10


# SillyTavern live speech has a configurable per-satellite submission ceiling. Bound each submission before draining work; the satellite may split it further according to current capacity.


def test_sillytavern_speech_is_batched_no_wider_than_the_setting():
    """Three is three, even though the card published 32 and said it could take 32 right now."""
    sat = FakeBatchSat(slice_=32, take=32, st_slice=3)
    texts = [f"chunk-{i}" for i in range(8)]
    saved, _ = _run_st(_pool(sat), texts)

    assert set(saved) == set(range(8))
    assert sat.submissions, "it must still BATCH — the setting lowers the width, it is not an off switch"
    assert max(len(s) for s in sat.submissions) <= 3, \
        f"a ceiling of three was handed a wider submission: {sat.submitted_texts}"
    assert sum(len(s) for s in sat.submissions) + len(sat.singles) == 8


def test_a_setting_of_one_keeps_sillytavern_speech_on_the_serial_path():
    """A configured live-speech limit of one keeps the serial path. There is no benefit to wrapping one chunk in a batch, and this avoids an extra capacity request before listener-facing work."""
    # ⚠️ `make_generate_fn` is deliberately NOT stubbed here, unlike the can't-batch test above:
    # the assertion is that the chunks went through the SERIAL path, and a stub swallows the only
    # call that can prove it (`FakeBatchSat.generate` is what the real one ends up invoking).
    sat = FakeBatchSat(slice_=32, take=32, st_slice=1)
    texts = [f"chunk-{i}" for i in range(5)]
    saved, _ = _run_st(_pool(sat), texts)

    assert set(saved) == set(range(5))
    assert sat.submissions == [], "a ceiling of one must never form a batch"
    assert sorted(sat.singles) == sorted(texts)
    assert sat.capacity_asked == [], \
        "and must not pay a capacity round trip to learn what it already decided"


def test_the_sillytavern_ceiling_does_not_touch_a_book():
    """The live-speech ceiling applies only to listener-facing speech. Background book, scene, and pre-render work keeps the full configured batch width."""
    sat = FakeBatchSat(slice_=32, take=32, st_slice=1)
    texts = [f"chunk-{i}" for i in range(8)]
    saved, _ = _run(_pool(sat), texts)          # run_chunks = BATCH priority, st_speech unset

    assert set(saved) == set(range(8))
    assert sat.submitted_texts == [texts], \
        f"a book must still travel in one submission: {sat.submitted_texts}"


def test_every_Mp3Render_declares_whether_a_listener_can_be_waiting_on_it():
    """Every render producer must declare whether a listener may already be waiting for its output. The live-speech ceiling applies to listener-facing work, including a speculative render once playback joins it. Key this census by enclosing function so unrelated line movement does not affect the contract."""
    import ast
    import pathlib

    # site -> is a listener possibly waiting on it?
    expected = {
        # The live serve path for every streaming caller. It passes the token entry's own flag
        # rather than a constant: Nomi, the web UI and the playground share this function.
        ("vocalis_stream_http.py", "speak_stream_serve"): True,
        # A speculative guess — which a click JOINS. See the note at the call site.
        ("prerender.py", "_produce"): True,
        # Scene builds are background work and keep the full configured batch width.
        ("scene_build.py", "render_through_the_real_path"): False,
        ("scene_build.py", "render_group_through_the_pool"): False,
    }

    src = pathlib.Path(__file__).resolve().parent.parent / "src"
    found = {}
    for path in src.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        parent = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                parent[child] = node
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
            if name != "Mp3Render":
                continue
            owner, walk = "<module>", node
            while walk in parent:
                walk = parent[walk]
                if isinstance(walk, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    owner = walk.name
                    break
            found[(path.name, owner)] = any(k.arg == "st_speech" for k in node.keywords)

    assert set(found) == set(expected), (
        f"the Mp3Render census has moved.\n  new: {sorted(set(found) - set(expected))}\n"
        f"  gone: {sorted(set(expected) - set(found))}\n"
        "  Decide, for a new one: can a listener already be waiting on these bytes? If yes it\n"
        '  must pass st_speech, or the live-speech batching ceiling silently does not apply to this render.')
    for site, wants in expected.items():
        assert found[site] == wants, (
            f"{site[0]}:{site[1]} {'no longer passes' if wants else 'now passes'} st_speech")


def test_a_satellite_that_cannot_batch_is_never_sent_a_list(monkeypatch):
    """Batching is gated on the advertised capability rather than a version string, so older or independently upgraded satellites retain the serial request path."""
    sat = FakeBatchSat()
    sat.can_batch = False
    monkeypatch.setattr(tts_utils, "make_generate_fn",
                        lambda model, chunk, *a, **k: (lambda: _wav()))
    saved, _ = _run(_pool(sat), [f"chunk-{i}" for i in range(6)])

    assert set(saved) == set(range(6))
    assert sat.submissions == []


def test_a_local_card_is_never_sent_a_list(monkeypatch):
    """A local model may not expose a `can_batch` capability. Treat an absent capability as false and keep local generation on the serial path."""
    monkeypatch.setattr(tts_utils, "make_generate_fn",
                        lambda model, chunk, *a, **k: (lambda: _wav()))
    pool = make_fake_pool(1)
    pool.sr = SR
    saved, _ = _run(pool, [f"chunk-{i}" for i in range(4)])
    assert set(saved) == set(range(4))


def test_the_drain_stops_at_another_callers_batch(monkeypatch):
    """Two submissions in flight have different params, different save callbacks and different
    cancel events. One request may only ever carry chunks of ONE of them."""
    sat = FakeBatchSat(slice_=8)
    pool = _pool(sat)
    seen, lock = [], threading.Lock()

    def save_a(idx, wav, sr):
        with lock:
            seen.append(("a", idx))

    def save_b(idx, wav, sr):
        with lock:
            seen.append(("b", idx))

    a = pool.submit([(i, f"a-{i}") for i in range(4)], GenParams(), priority=BATCH,
                    save=save_a, total=4)
    b = pool.submit([(i, f"b-{i}") for i in range(4)], GenParams(), priority=BATCH,
                    save=save_b, total=4)
    pool.collect(a)
    pool.collect(b)

    assert len(sat.submissions) >= 2, "the two callers cannot have shared one request"
    assert len(seen) == 8


def test_an_interactive_chunk_keeps_its_place_in_the_queue():
    """The drain puts back what it may not take EXACTLY as it came off — same priority, same
    sequence number — or a /speak chunk that arrived mid-drain loses its precedence."""
    sat = FakeBatchSat(slice_=8)
    pool = _pool(sat)
    order, lock = [], threading.Lock()

    def save(tag):
        def _s(idx, wav, sr):
            with lock:
                order.append(tag)
        return _s

    # Queue the work BEFORE any worker starts, so the ordering under test is the queue's.
    pool._ensure_started = lambda: None
    book = pool.submit([(i, f"book-{i}") for i in range(6)], GenParams(),
                       priority=BATCH, save=save("book"), total=6)
    talk = pool.submit([(0, "speak")], GenParams(), priority=INTERACTIVE,
                       save=save("talk"), total=1)
    del pool._ensure_started
    pool._ensure_started()
    pool.collect(talk)
    pool.collect(book)

    assert order[0] == "talk", f"INTERACTIVE must outrank the book: {order}"


def test_a_streaming_chunk_never_joins_a_batch():
    """A _StreamJob has a runner of its own and its audio may already be on the wire. It is
    also the only path whose per-chunk render rate the governor measures."""
    sat = FakeBatchSat(slice_=8)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    def runner(model, heartbeat):
        heartbeat()
        return _wav(), 5, 0.1

    b = pool.submit([(i, f"chunk-{i}") for i in range(4)], GenParams(), priority=BATCH,
                    save=save, total=4, stream_runner=runner)
    pool.collect(b)

    assert set(saved) == set(range(4))
    assert sat.submissions, "the other three still batched — else this proves nothing"
    # By TEXT, not by id: since 7.3.14 the wire id is the position in the submission, so
    # `"0" not in ids` was asking whether anything sat first in a batch — always false, for a
    # reason that has nothing to do with streaming.
    assert all("chunk-0" not in texts for texts in sat.submitted_texts), \
        f"chunk 0 is the streaming one and must not have been batched: {sat.submitted_texts}"


# ── §7.3: the per-chunk guarantees, on a chunk that arrived in a batch ────────

def test_the_quality_zone_is_per_chunk_not_per_batch(monkeypatch):
    """One row of eight hitting the 40-second cap re-renders THAT ROW. The other seven are
    banked exactly as they arrived."""
    samples = {f"chunk-{i}": 200 for i in range(4)}
    samples["chunk-2"] = 4200                            # >= 1000 tokens: truncated
    sat = FakeBatchSat(slice_=8, samples=samples)
    calls = []
    monkeypatch.setattr(tts_utils, "resplit_and_retry",
                        lambda chunk, make_fn, sr, spent_s=0.0, out=None:
                        (calls.append(chunk) or (_wav(300), len(chunk), 0.2, False)))

    saved, _ = _run(_pool(sat), [f"chunk-{i}" for i in range(4)])

    assert calls == ["chunk-2"], f"only the truncated row may be re-split: {calls}"
    assert set(saved) == set(range(4))
    assert saved[2].shape[-1] == 300, "the re-rendered audio is what gets banked"
    assert saved[1].shape[-1] == 200


def test_the_re_split_runs_after_the_reply_is_consumed():
    """🔴 The deadlock guard. The far end holds its replica lock for the whole reply
    (`Engine.render_batch_iter`), so a nested render issued while consuming it waits on a lock
    held by the request it is nested inside — no error, no timeout, no progress. The fake
    asserts it from the other side."""
    samples = {f"chunk-{i}": 200 for i in range(3)}
    samples["chunk-0"] = 4200
    sat = FakeBatchSat(slice_=8, samples=samples)
    saved, _ = _run(_pool(sat), [f"chunk-{i}" for i in range(3)])

    assert sat.submissions, "a batch must actually have happened"
    assert sat.singles, "the truncated chunk must have been re-rendered"
    assert set(saved) == set(range(3))


def test_a_cancel_banks_nothing_further_and_retries_nothing():
    """A batch is one forward pass and cannot drop a single row from the result. If cancellation occurs after a completed row is returned, retain that row and do not resubmit it."""
    sat = FakeBatchSat(slice_=8, cancel_after=2)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    cancel = threading.Event()
    b = pool.submit([(i, f"chunk-{i}") for i in range(6)], GenParams(), priority=BATCH,
                    save=save, total=6, cancel=cancel)
    pool.collect(b)                                  # must not hang, must not raise

    assert set(saved) == {0, 1}, f"only the chunks that landed are banked: {sorted(saved)}"
    assert len(sat.submissions) == 1, "a canceled batch is not retried"


def test_a_cancel_after_a_TRUNCATED_chunk_does_not_wedge_the_pool():
    """🔴 A truncated chunk is popped out of `left` and parked in `retries` for a re-split that
    runs after the reply is consumed. If the cancel lands in between, that chunk is in NEITHER
    collection — and the cancel branch used to drop `retries` wholesale, leaving its `inflight`
    and `pending` counted for ever.

    `collect()` then sees `pending > 0, inflight > 0`, waits out the full stall timeout, raises
    "a worker is likely wedged (hung GPU kernel)" and sets `poisoned`, forcing every replica on
    the box to be rebuilt. A cancel is not a wedged kernel. Through the pre-render queue this
    also wedged the speculative dispatcher for the whole timeout.

    `test_a_cancel_banks_nothing_further_and_retries_nothing` cannot catch it: its chunks are all
    a uniform 200 samples, so nothing is ever truncated and `retries` is empty when the cancel
    lands. Here chunk 0 comes back at the 1000-token cap (4000 samples at this SR) and chunk 2
    cancels — so there is exactly one chunk sitting in the deferred list.

    Verified red: with the `retries` resolution removed it fails on the stall timeout below.
    """
    # ⚠️ EVERY chunk needs an entry: `_samples_for` indexes the dict directly, so a missing
    # raises KeyError out of the generator and the pool takes the FAILURE branch instead of the
    # cancel one — which is how the first draft of this test passed against the unfixed code.
    sat = FakeBatchSat(slice_=8,
                       samples={f"chunk-{i}": (4000 if i == 0 else 200) for i in range(6)},
                       cancel_after=2)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    b = pool.submit([(i, f"chunk-{i}") for i in range(6)], GenParams(), priority=BATCH,
                    save=save, total=6, cancel=threading.Event())
    # A short timeout so a leak fails the test in a second instead of blocking it for 15 minutes.
    pool.collect(b, stall_timeout_s=5.0)

    with b.lock:
        assert b.pending == 0, f"{b.pending} chunk(s) left counted after a cancel"
        assert b.inflight == 0, f"{b.inflight} chunk(s) left in flight after a cancel"
    assert not pool.poisoned, "a cancel was misdiagnosed as a wedged kernel and poisoned the pool"


def test_an_undelivered_chunk_is_retried_not_lost():
    """The satellite reported success and sent five of six. That is a protocol violation, and
    the honest response is to put the missing one back through the ordinary retry — silently
    dropping it writes a book with a hole in it, and nothing downstream would notice."""
    texts = {f"chunk-{i}" for i in range(6)} - {"chunk-4"}
    sat = FakeBatchSat(slice_=8, deliver=texts)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, f"chunk-{i}") for i in range(6)]
    pool.collect(pool.submit(items, GenParams(), priority=BATCH, save=save, total=6))
    assert sat.submissions, "a batch must actually have happened"
    assert set(saved) == set(range(6)), "the chunk it skipped must still have been rendered"
    assert sat.singles, "and it comes back through the ordinary per-chunk path"


def test_a_failed_batch_retries_its_chunks_in_another_batch():
    """Every undelivered chunk spends an attempt, then can join a later batch when the
    satellite recovers. A temporary failure must not turn the worker into a serial renderer."""
    class FlakyBatchSat(FakeBatchSat):
        def generate_batch(self, items, **kw):
            self.fail = RuntimeError("the wire broke") if not self.submissions else None
            yield from super().generate_batch(items, **kw)

    sat = FlakyBatchSat(slice_=8)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, f"chunk-{i}") for i in range(4)]
    batch = pool.submit(items, GenParams(), priority=BATCH, save=save, total=4)
    pool.collect(batch)
    assert set(saved) == set(range(4))
    assert batch.attempts == {i: 1 for i in range(4)}
    assert len(sat.submissions) == 2
    assert sat.singles == [], "recovered chunks went through single-chunk requests"


def test_a_satellite_that_drops_chunks_fails_loudly_without_serial_downgrade():
    """A clean trailer missing two chunk ids is still a failed batch. Retry those ids up to
    their budget, then fail visibly if the satellite keeps omitting them."""
    texts = {f"chunk-{i}" for i in range(6)} - {"chunk-3", "chunk-4"}
    sat = FakeBatchSat(slice_=8, deliver=texts)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, f"chunk-{i}") for i in range(6)]
    with pytest.raises(RuntimeError, match="failed permanently"):
        pool.collect(pool.submit(items, GenParams(), priority=BATCH, save=save, total=6))
    assert set(saved) == {0, 1, 2, 5}
    assert sat.singles == [], "a missing pair was silently downgraded to serial rendering"


def test_a_permanently_broken_satellite_still_terminates():
    """The same path with nothing that can succeed: every chunk exhausts its budget and the
    render FAILS, loudly. It must not spin."""
    sat = FakeBatchSat(slice_=8, fail=RuntimeError("the wire broke"))

    def dead(*a, **k):
        raise RuntimeError("the wire broke")

    sat.generate = dead
    pool = _pool(sat)
    items = [(i, f"chunk-{i}") for i in range(4)]
    with pytest.raises(RuntimeError, match="failed permanently"):
        pool.collect(pool.submit(items, GenParams(), priority=BATCH, save=lambda *a: None,
                                 total=4))
    assert sat.submissions, "a batch must actually have been attempted"


def test_two_connection_failures_then_recovery_keep_batching():
    """After temporary connection failures, later submissions should still use the negotiated batch path."""
    class StartingSat(FakeBatchSat):
        def generate_batch(self, items, **kw):
            self.fail = (SatelliteUnreachable("satellite not started")
                         if len(self.submissions) < 2 else None)
            yield from super().generate_batch(items, **kw)

    sat = StartingSat(slice_=8)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav

    items = [(i, f"chunk-{i}") for i in range(8)]
    pool.collect(pool.submit(items, GenParams(), priority=BATCH, save=save, total=8))

    assert set(saved) == set(range(8)), "the render did not recover"
    assert len(sat.submissions) == 3, f"the retry switched to serial: {sat.submissions}"
    assert sat.singles == []
    _run(pool, [f"later-{i}" for i in range(4)])
    assert len(sat.submissions) == 4 and len(sat.submissions[-1]) == 4
    assert sat.singles == [], "batching was disabled after recovery"


def test_satellite_drops_mid_batch_and_local_cuda_finishes_every_chunk(monkeypatch):
    """An intentional satellite shutdown must not spend 28 chunks' retry budgets there.
    Chunks already delivered by the satellite stay banked; only unfinished work moves
    to the local card, which also takes the next submission.
    """
    started = threading.Event()

    class DownSat(FakeBatchSat):
        def generate_batch(self, items, **kw):
            started.set()
            yield from super().generate_batch(items, **kw)

    sat = DownSat(slice_=8, fail=(2, SatelliteUnreachable("satellite stopped")))
    pool = _pool(sat, n_workers=2)
    pool.workers[0]["device"] = 'test-satellite:cuda:0'
    pool.workers[1]["device"] = "cuda:0"
    pool._models[1] = object()
    monkeypatch.setattr(torch.cuda, "set_device", lambda _idx: None)
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda _dev: (None, None))
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a: lambda: None)

    def local_generate(text, make_fn, sr, label="", out=None):
        assert started.wait(5), "the satellite never attempted its batch"
        return _wav(), len(text), 0.1, False

    monkeypatch.setattr(tts_utils, "generate_with_retry", local_generate)
    saved, events = {}, []
    lock = threading.Lock()

    def save(idx, wav, sr):
        with lock:
            assert idx not in saved, f"chunk {idx} was rendered twice"
            saved[idx] = wav

    def on_event(event):
        with lock:
            events.append(event)

    # Fill the queue before either worker starts so the satellite gets a real batch.
    pool._started = True
    batch = pool.submit([(i, f"chunk-{i}") for i in range(8)], GenParams(),
                        priority=BATCH, save=save, total=8, on_event=on_event)
    pool._started = False
    pool._ensure_started()
    pool.collect(batch, stall_timeout_s=10)

    assert set(saved) == set(range(8))
    assert len(sat.submissions) == 1
    assert batch.attempts == {}, "a dead device must not spend text retry budgets"
    assert [w["device"] for w in pool.workers] == ["cuda:0"]
    assert len([e for e in events if e["type"] == "device_dropped"]) == 1
    assert not any(e["type"] == "chunk_failed" for e in events)

    later, _ = _run(pool, ["next-chapter"])
    assert set(later) == {0}
    assert len(sat.submissions) == 1, "a later section retried the offline satellite"


def test_a_locked_vault_mid_batch_is_re_raised_by_type():
    """BOUNDARY 3 of 5, batched half. `except Exception` cannot see a VaultAuthError, so
    without the clause by name the undelivered chunks stay counted and collect() waits forever
    on audio that will never arrive. It must also arrive at the caller AS ITSELF: "the key is
    gone" and "re-render that chunk" are different problems with different answers."""
    from vault import VaultAuthError

    sat = FakeBatchSat(slice_=8)
    pool = _pool(sat)

    def save(idx, wav, sr):
        raise VaultAuthError("authentication failed on block 0")

    items = [(i, f"chunk-{i}") for i in range(4)]
    with pytest.raises(VaultAuthError):
        pool.collect(pool.submit(items, GenParams(), priority=BATCH, save=save, total=4),
                     stall_timeout_s=10)
    assert sat.submissions, "it has to have failed inside a BATCH to be this test"


def test_a_save_failure_does_not_silently_lose_a_batched_chunk():
    """The banking half of the per-chunk guard: a disk-full on chunk 2 must fail chunk 2, not
    kill the worker and leave a hole the concat crashes on."""
    sat = FakeBatchSat(slice_=8)
    pool = _pool(sat)
    saved, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        if idx == 2:
            raise OSError("disk full")
        with lock:
            saved[idx] = wav

    items = [(i, f"chunk-{i}") for i in range(4)]
    with pytest.raises(RuntimeError, match="failed permanently"):
        pool.collect(pool.submit(items, GenParams(), priority=BATCH, save=save, total=4))
    assert sat.submissions, "it has to have failed inside a BATCH to be this test"
    assert {0, 1, 3} <= set(saved)


def test_a_cache_hit_never_reaches_the_queue():
    """§7.3's fourth rule holds by construction rather than by a check inside the pool: every
    caller filters to the chunks it is MISSING before it submits. This pins that — if a caller
    ever starts submitting cache hits, a hit would consume a batch slot."""
    import inspect

    import book_to_audio
    # 7.1: the filter and the submit live in `start_section` now — `generate_section` became
    # `start_section` + `finish_section` so a book can queue the next chapter behind the
    # current one. The rule this pins is unchanged; only the function holding it moved.
    src = inspect.getsource(book_to_audio.start_section)
    assert "missing = [(i, chunk) for i, chunk in enumerate(chunks) if i not in done_idx]" in src
    assert "submit_chunks(missing" in src, "the book must submit only the chunks it is missing"


def test_the_batched_accounting_adds_up():
    """`chars` and `seconds` are what the book's progress line and the rate log are built from.
    Per chunk the time is lumpy — a pass's wall time falls on whichever chunk closed it — but
    the total is exact."""
    sat = FakeBatchSat(slice_=8)
    texts = [f"chunk-{i}" for i in range(8)]
    saved, (chars, secs) = _run(_pool(sat), texts)
    assert sat.submitted_texts == [texts]
    assert chars == sum(len(t) for t in texts)
    assert secs >= 0.0


def test_the_reported_per_chunk_time_is_never_absurd(monkeypatch):
    """Chunks in a batch are delivered close together, so attributing the entire pass duration to one chunk produces misleading per-chunk rates. Divide the measured pass time across its chunks."""
    seen = []
    real = tts_utils.report_generated
    monkeypatch.setattr(tts_utils, "report_generated",
                        lambda chunk, wav, sr, dt, out=None:
                        (seen.append(dt) or real(chunk, wav, sr, dt, out=out)))
    # The pass takes 50 ms on a clock the test drives, not 50 ms of real sleeping: the pool reads
    # `tts_utils.time`, so the duration it divides across the chunks is exactly what is advanced.
    clock = _DrivenClock()
    monkeypatch.setattr(tts_utils, "time", clock)

    class Slow(FakeBatchSat):
        def generate_batch(self, items, **kw):
            clock.advance(0.05)                    # one "pass": every chunk lands at once
            for cid, _t in items:
                yield cid, _wav(self.samples)

    sat = Slow(slice_=4)
    _run(_pool(sat), [f"chunk-{i}" for i in range(4)])

    assert len(seen) == 4
    assert all(d > 0 for d in seen), f"no chunk may be reported as taking no time: {seen}"
    # Divide one pass duration across delivered chunks instead of assigning all elapsed time to the last one.
    # Compare relative agreement with tolerance from active clock resolution, avoiding host-specific timing limits.
    tick = time.get_clock_info("time").resolution
    assert max(seen) <= min(seen) * 2 or (max(seen) - min(seen)) <= tick, (
        f"a pass's chunks must not differ in cost: {seen} "
        f"(spread {max(seen) - min(seen):.4f}s, one clock tick is {tick:.4f}s)")


class _DrivenClock:
    """A deterministic clock lets this test assert timing arithmetic without relying on host scheduling.

    Its `sleep` method advances time in small steps while `advance` controls measured duration. Attribute lookup falls through to the real time module so unrelated callers remain available to worker threads.
    """

    def __init__(self, t=1_000.0):
        self.t = float(t)

    def advance(self, dt):
        self.t += float(dt)

    def time(self):
        return self.t

    def monotonic(self):
        return self.t

    def sleep(self, s):
        # Never the caller's duration (that is the host-dependence being removed) and never zero
        # either, so a spin-wait somewhere cannot turn into a busy loop.
        time.sleep(min(float(s or 0.0), 0.001))

    def __getattr__(self, name):
        return getattr(time, name)


def test_the_accounting_still_uses_the_clock_not_the_mean(monkeypatch):
    """Return elapsed wall-clock time rather than the sum of displayed per-chunk running means."""
    clock = _DrivenClock()
    monkeypatch.setattr(tts_utils, "time", clock)

    class Staggered(FakeBatchSat):
        """📌 ADVANCES BEFORE EACH YIELD, which is what staggers the landings. The generator is
        consumed lazily by the delivery loop, so `t0` is captured before the first advance and
        every chunk lands 10 ms after the one before it."""

        def generate_batch(self, items, **kw):
            for cid, _t in items:
                clock.advance(0.01)
                yield cid, _wav(self.samples)

    sat = Staggered(slice_=4)
    _saved, (_chars, secs) = _run(_pool(sat), [f"chunk-{i}" for i in range(4)])
    assert secs == pytest.approx(0.04, abs=1e-6), (
        f"the batch's own wall time, not the sum of the means: {secs} "
        f"(0.040 is the wall clock, 0.025 is the sum of the per-chunk means)"
    )


def test_the_governor_is_not_fed_from_the_batch_path(monkeypatch):
    """🔴 The window is the last 8 observations and the governor takes the SLOWEST of them. A
    batched pass lands several chunks back to back, so seven of eight read as instant — eight of
    those flush the window and the "slowest" becomes thousands of times realtime, which would
    have the streaming governor buffer almost nothing. The streaming path is never batched, so
    it keeps measuring the quantity it actually needs.

    Asserted on the CALL, not on `observed_rate`: the fake renders in less than the clock's
    resolution, so `record_render_rate`'s own `wall_s <= 0` guard would drop the observation and
    the test would pass against a pool that fed the governor every batched chunk."""
    import vocalis_streaming

    calls = []
    monkeypatch.setattr(vocalis_streaming, "record_render_rate",
                        lambda dev, audio_s, wall_s, streaming=False: calls.append(dev))

    sat = FakeBatchSat(slice_=8)
    _run(_pool(sat), [f"chunk-{i}" for i in range(8)])
    assert sat.submissions, "a batch must actually have happened"
    assert calls == [], f"the batch path must not feed the governor: {calls}"

    # …and the serial path still does, which is what makes the assertion above meaningful.
    sat2 = FakeBatchSat(slice_=8)
    sat2.can_batch = False
    monkeypatch.setattr(tts_utils, "make_generate_fn",
                        lambda model, chunk, *a, **k: (lambda: _wav()))
    _run(_pool(sat2), ["chunk-0"])
    assert calls, "the serial path is where the governor's measurement comes from"
