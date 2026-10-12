"""Vocalis 3.0 streaming (3.0-M1): S3GenStreamer bookkeeping + GPU integration.

The non-GPU tests drive S3GenStreamer with a deterministic fake vocoder: mels
are a pure function of the token prefix and HiFi-GAN is a fixed upsampler, so
with zero drift the streamed concatenation must equal the one-shot render
EXACTLY â€” any frame/sample bookkeeping error (holdback, overlap, held tail,
finalize flush) breaks the equality.
"""
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from vocalis_streaming import S3GenStreamer, StreamConfig  # noqa: E402

SPF   = 4      # fake samples per mel frame
RATIO = 2      # mel frames per token
SR    = 24000


class FakeFlow:
    token_mel_ratio = RATIO
    pre_lookahead_len = 3


class FakeS3Gen:
    """mels[f] = value derived from tokens[f // RATIO] (+ optional drift);
    hift = repeat each frame's mean SPF times, source = same length."""

    def __init__(self, drift=0.0):
        self.flow = FakeFlow()
        self.drift = drift
        self._calls = 0

    def fake_mels(self, tokens: torch.Tensor, k_context: int) -> torch.Tensor:
        vals = tokens.view(-1).float().repeat_interleave(RATIO)   # (RATIO*k,)
        mels = vals.view(1, 1, -1).expand(1, 80, -1).clone()
        # drift: trajectories shift slightly with the amount of context
        mels += self.drift * k_context
        return mels

    def hift_inference(self, speech_feat, cache_source=None):
        frames = speech_feat.mean(dim=1)                          # (1, T)
        wav = frames.repeat_interleave(SPF, dim=1)                # (1, T*SPF)
        src = wav.unsqueeze(1)                                    # (1, 1, T*SPF)
        return wav, src


class FakeStreamer(S3GenStreamer):
    """Overrides the flow call to use the fake instead of the real S3Token2Mel."""

    def _flow_prefix(self, tokens):
        self.s3gen._calls += 1
        return self.s3gen.fake_mels(tokens, tokens.numel())


def make_streamer(drift=0.0, **cfg_kw):
    cfg = StreamConfig(noise_seed=1, wave_xfade_s=0.001, **cfg_kw)
    fake = FakeS3Gen(drift=drift)
    ref = {"prompt_feat": torch.zeros(1, 7, 80)}
    return FakeStreamer(fake, ref, SR, cfg, device=torch.device("cpu")), fake


def oneshot(fake: FakeS3Gen, tokens: torch.Tensor) -> np.ndarray:
    mels = fake.fake_mels(tokens, tokens.numel())
    wav, _ = fake.hift_inference(mels)
    return wav.squeeze(0).numpy()


def run_stream(streamer, tokens: torch.Tensor, step: int):
    """Feed the cumulative prefix the way generate_stream does; return chunks."""
    chunks, n = [], tokens.numel()
    for k in range(step, n, step):
        c = streamer.feed(tokens[:, :k])
        if c is not None and len(c):
            chunks.append(c)
    c = streamer.feed(tokens, finalize=True)
    if c is not None and len(c):
        chunks.append(c)
    return chunks


def toks(n, seed=7):
    g = torch.Generator().manual_seed(seed)
    return torch.randint(1, 6000, (1, n), generator=g)


# â”€â”€ bookkeeping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def test_short_message_single_call():
    st, fake = make_streamer()
    t = toks(30)                                   # < step_tokens: one finalize call
    chunks = run_stream(st, t, step=50)
    assert fake._calls == 1
    total = np.concatenate(chunks)
    assert len(total) == 30 * RATIO * SPF

def test_total_length_exact_multi_join():
    st, _ = make_streamer()
    t = toks(237)                                  # several joins + ragged tail
    total = np.concatenate(run_stream(st, t, step=50))
    assert len(total) == 237 * RATIO * SPF

def test_stream_equals_oneshot_when_stable():
    """Zero drift -> every smoothing op blends identical signals -> exact match."""
    st, fake = make_streamer(drift=0.0)
    t = toks(180)
    stream = np.concatenate(run_stream(st, t, step=50))
    ref = oneshot(fake, t)
    assert stream.shape == ref.shape
    np.testing.assert_allclose(stream, ref, rtol=0, atol=1e-5)

def test_drift_is_smoothed_not_stepped():
    """With drift, the join must not produce a step bigger than the drift itself."""
    st, fake = make_streamer(drift=0.001)
    t = toks(180)
    stream = np.concatenate(run_stream(st, t, step=50))
    # neighboring-sample steps: joins must stay within the same order of
    # magnitude as the injected drift (a hard un-blended switch would be ~0.05+)
    deltas = np.abs(np.diff(stream))
    tok_step = np.abs(np.diff(oneshot(fake, t))).max()   # legit signal steps
    assert deltas.max() <= tok_step + 0.01

def test_feed_below_threshold_returns_none():
    st, fake = make_streamer()
    t = toks(200)
    assert st.feed(t[:, :49]) is None                    # below step_tokens
    assert fake._calls == 0

def test_finalize_flushes_everything_and_locks():
    st, _ = make_streamer()
    t = toks(120)
    chunks = run_stream(st, t, step=50)
    assert st.finalized
    assert len(np.concatenate(chunks)) == 120 * RATIO * SPF
    with pytest.raises(AssertionError):
        st.feed(t)                                       # no feeding after finalize

def test_first_holdback_deeper_than_later():
    st, _ = make_streamer()
    t = toks(200)
    st.feed(t[:, :50])
    first = st._emitted_frames
    assert first == RATIO * (50 - st.cfg.first_holdback_tokens)
    st.feed(t[:, :100])
    assert st._emitted_frames == RATIO * (100 - st.cfg.holdback_tokens)


# ── buffer governor (`required_buffer_s`) ─────────────────────────────────────

def _gcfg(**kw):
    from vocalis_streaming import StreamConfig
    cfg = StreamConfig()
    for k, v in kw.items():
        setattr(cfg, k, v)
    return cfg


def test_governor_single_chunk_needs_no_buffer():
    from vocalis_streaming import required_buffer_s
    assert required_buffer_s(["x" * 400], _gcfg(), workers=2) == 0.0


def test_governor_covers_a_stream_underrun():
    """The observed failure: 3 equal chunks, 2 workers, banking slower than
    realtime — chunk 2 finished ~8-10 s after chunk 1's audio ran out. The
    floor must at least cover that gap."""
    from vocalis_streaming import required_buffer_s
    chunks = ["x" * 260] * 3
    cfg = _gcfg(governor_rate=1.2, batch_rate=0.7, governor_margin=1.2)
    d = required_buffer_s(chunks, cfg, workers=2)
    est1 = 260 / cfg.chars_per_second                    # chunk 1 audio ≈ 16.7 s
    need = 260 / cfg.chars_per_second / 0.7 - est1       # chunk 2 render − runway
    assert d >= need                                     # covers the gap
    assert d < est1 * 2                                  # but stays sane


def test_governor_fast_banking_needs_no_buffer():
    from vocalis_streaming import required_buffer_s
    chunks = ["x" * 260] * 3
    d = required_buffer_s(chunks, _gcfg(batch_rate=10.0, governor_rate=10.0), workers=2)
    assert d == 0.0


def test_governor_more_chunks_need_more_buffer_single_worker():
    """One worker banks everything in sequence at a deficit — the floor must
    grow with message length. (With 2+ workers the bank keeps pace and the
    floor plateaus — that's the correct schedule, not a bug.)"""
    from vocalis_streaming import required_buffer_s
    cfg = _gcfg(governor_rate=1.2, batch_rate=0.7)
    d3 = required_buffer_s(["x" * 260] * 3, cfg, workers=1)
    d6 = required_buffer_s(["x" * 260] * 6, cfg, workers=1)
    assert d6 > d3


def test_governor_bank_parallelism_capped_at_two():
    """The box is CPU-bound (~95% with one worker per card): extra workers
    must NOT shrink the floor below the 2-banker schedule."""
    from vocalis_streaming import required_buffer_s
    cfg = _gcfg(governor_rate=1.2, batch_rate=0.7)
    chunks = ["x" * 260] * 6
    assert required_buffer_s(chunks, cfg, workers=8) == \
           required_buffer_s(chunks, cfg, workers=3)


# â”€â”€ GPU integration (pass --gpu) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

TEXT = ("She set the lantern down on the old oak table and let the silence settle "
        "around them like a blanket. I never thought you would come back, she said, "
        "her voice barely above a whisper.")

def _synth_voice_prompt(directory: Path, seconds: float = 12.0, sr: int = 24000) -> str:
    """Write a short voiced-sounding reference WAV and return its path.

    📌 These two GPU tests used to read `Narrator_sample.wav` from the developer's legacy checkout
    through a dev-layout relative path (`<repo>/../Vocalis/voice_samples/`). That file is not part
    of this repo and must not be depended on, so the reference is synthesized here: a 120 Hz
    fundamental with harmonics, a slow vibrato, a syllable-rate (~4 Hz) amplitude envelope with
    gaps, and a little breath noise. It is not a real voice and does not need to be: the tests
    assert streaming shape, length and first-chunk latency, not likeness, and the reference only
    has to be a mono WAV long enough for Chatterbox to condition on (it reads about 10 s).
    Seeded, so every run conditions on identical samples.
    """
    import soundfile as sf
    rng = np.random.default_rng(1234)
    t = np.arange(int(seconds * sr)) / sr
    f0 = 120.0 * (1.0 + 0.02 * np.sin(2 * np.pi * 5.0 * t))
    phase = 2 * np.pi * np.cumsum(f0) / sr
    voiced = sum((1.0 / k) * np.sin(k * phase) for k in range(1, 12))
    envelope = np.clip(np.sin(2 * np.pi * 4.0 * t), 0.0, None) ** 0.7
    envelope *= np.clip(np.sin(2 * np.pi * 0.35 * t + 1.0) + 0.6, 0.0, 1.0)    # phrase gaps
    wav = voiced * envelope + 0.01 * rng.standard_normal(len(t))
    wav = (0.5 * wav / np.max(np.abs(wav))).astype("float32")
    path = directory / "synthetic_voice_prompt.wav"
    sf.write(str(path), wav, sr, format="WAV")
    return str(path)


def test_generate_stream_end_to_end(gpu_enabled, tmp_path):
    import time
    from chatterbox.tts import ChatterboxTTS
    from vocalis_streaming import generate_stream

    model = ChatterboxTTS.from_pretrained(device="cuda")
    voice = _synth_voice_prompt(tmp_path)
    t0 = time.time()
    first = None
    chunks = []
    for c in generate_stream(model, TEXT, audio_prompt_path=voice):
        if first is None:
            first = time.time() - t0
        chunks.append(c)
    total = np.concatenate(chunks)
    dur = len(total) / model.sr
    elapsed = time.time() - t0
    print(f"\n[e2e] first audio {first:.2f}s, total {dur:.1f}s in {elapsed:.1f}s")
    assert 5.0 < dur < 40.0                        # sane speech length for the text

    # 🔴 RELATIVE FIRST, because this assertion is about STREAMING, not about speed. It used to be
    # a bare `first < 8.0` — a fixed wall-clock budget on a box that runs this suite twelve workers
    # wide alongside headless-Chrome specs. It once flaked at 8.21 s, a 2.6% overshoot,
    # and passed on the same commit in isolation. A test whose verdict depends on what else is
    # running is not measuring what it claims to.
    #
    # The claim worth making is that the first chunk arrives EARLY IN THE RUN — that is what makes
    # it a stream rather than a batch that yields once at the end — and that ratio holds however
    # loaded the box is, because load stretches both halves together.
    assert first < elapsed * 0.6, (
        f"the first chunk arrived {first:.2f}s into a {elapsed:.2f}s run — that is not streaming")

    # ⚠️ AND AN ABSOLUTE BACKSTOP, kept because the ratio alone cannot see a uniform slowdown: a
    # model 3x slower everywhere keeps the same shape. 12 s rather than the old 8 s is a LOADED-BOX
    # budget, not a performance target — it absorbs contention while still failing a ~50%
    # regression in time-to-first-audio. If this one goes red, it is worth believing.
    assert first < 12.0, f"first audio took {first:.2f}s — time-to-first-chunk has regressed"
    out = Path(__file__).parent.parent / "spike_out"
    out.mkdir(exist_ok=True)
    import soundfile as sf
    sf.write(str(out / "streamed_e2e.wav"), total, model.sr)


# â”€â”€ M2: pool orchestration (stream_message) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import threading
import time as time_mod

import tts_utils
from tts_utils import WorkerPool, GenParams
import vocalis_streaming as vs


from conftest import make_fake_pool as _fake_pool  # single shared copy


def _three_chunk_text():
    """Three DISTINCT ~340-char sentences (pairs exceed CHUNK_SIZE -> exactly 3
    chunks; distinct so text-keyed delay/fail maps hit the intended chunk)."""
    text = " ".join(ch * 340 + "." for ch in "abc")
    from tts_utils import split_into_chunks
    chunks = split_into_chunks(text)
    assert len(chunks) == 3 and len(set(chunks)) == 3
    return text


def _patch_batch_chunks(monkeypatch, delays=None, fail_text=None):
    """Normal (non-stream) chunks return a recognizable wav; optional per-index
    delay (by chunk text) and an always-failing chunk text."""
    delays = delays or {}
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    def fake_gen(text, make_fn, sr, label="", out=None):
        if fail_text is not None and text == fail_text:
            raise RuntimeError("boom")
        time_mod.sleep(delays.get(text, 0.0))
        wav = torch.full((1, 1000 + len(text)), float(len(text)))
        return wav, len(text), 0.01, False
    monkeypatch.setattr(tts_utils, "generate_with_retry", fake_gen)


def _patch_stream_windows(monkeypatch, n_windows=4, window_len=2400, fail_at=None):
    calls = {"n": 0}
    def fake_generate_stream(model, text, **kw):
        calls["n"] += 1
        for j in range(n_windows):
            if fail_at is not None and j == fail_at:
                raise RuntimeError("stream boom")
            yield np.full(window_len, 0.001 * (j + 1), dtype=np.float32)
    monkeypatch.setattr(vs, "generate_stream", fake_generate_stream)
    return calls


def test_stream_message_orders_and_splices(monkeypatch):
    """Chunk 3 banks before chunk 2 (delays reversed) â€” output order must hold."""
    text = _three_chunk_text()
    from tts_utils import split_into_chunks
    c = split_into_chunks(text)
    _patch_batch_chunks(monkeypatch, delays={c[1]: 0.3, c[2]: 0.0})
    _patch_stream_windows(monkeypatch, n_windows=3)
    pool = _fake_pool(2)
    cfgs = vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0)      # governor ~off (d ~ 0)
    out = list(vs.stream_message(pool, text, GenParams(), config=cfgs))
    # 3 windows from chunk 1, then banked chunk 2, then banked chunk 3
    assert len(out) == 5
    assert all(len(o) == 2400 for o in out[:3])
    assert len(out[3]) == 1000 + len(c[1]) and out[3][0] == float(len(c[1]))
    assert len(out[4]) == 1000 + len(c[2]) and out[4][0] == float(len(c[2]))


def test_stream_message_governor_withholds(monkeypatch):
    """First release must be >= d seconds of audio in one piece."""
    text = _three_chunk_text()
    from tts_utils import split_into_chunks
    c0 = split_into_chunks(text)[0]
    _patch_batch_chunks(monkeypatch)
    _patch_stream_windows(monkeypatch, n_windows=6, window_len=2400)  # 0.1s @24k each
    pool = _fake_pool(2)
    cfgs = vs.StreamConfig(governor_rate=0.5, governor_margin=1.0,
                           chars_per_second=len(c0) / 0.35)  # est 0.35s -> d = 0.35s
    d_samples = int(0.35 * 24000)                            # = 8400 -> 4 windows
    out = list(vs.stream_message(pool, text, GenParams(), config=cfgs))
    assert len(out[0]) >= d_samples                          # accumulated release
    assert len(out[0]) == 4 * 2400
    assert len(out[1]) == 2400                               # passthrough after


def test_stream_message_stream_failure_no_retry(monkeypatch):
    text = _three_chunk_text()
    _patch_batch_chunks(monkeypatch)
    calls = _patch_stream_windows(monkeypatch, n_windows=4, fail_at=2)
    pool = _fake_pool(2)
    with pytest.raises(RuntimeError, match="streaming chunk failed"):
        list(vs.stream_message(pool, text, GenParams(),
                               config=vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0)))
    time_mod.sleep(0.2)                       # let workers settle
    assert calls["n"] == 1                    # a stream job is NEVER re-run


def test_stream_message_later_chunk_failure_raises(monkeypatch):
    text = _three_chunk_text()
    from tts_utils import split_into_chunks
    c = split_into_chunks(text)
    _patch_batch_chunks(monkeypatch, fail_text=c[2])          # chunk 3 always fails
    _patch_stream_windows(monkeypatch, n_windows=2)
    pool = _fake_pool(2)
    out = []
    with pytest.raises(RuntimeError, match="chunk 3/3 failed"):
        for piece in vs.stream_message(pool, text, GenParams(),
                                       config=vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0)):
            out.append(piece)
    assert len(out) >= 3                      # chunk-1 windows + banked chunk 2 arrived


def test_stream_message_cache_tee_banks_full_chunk0(monkeypatch):
    """The stream job's save() banks the CONCATENATED chunk-1 wav (cache tee)."""
    text = _three_chunk_text()
    _patch_batch_chunks(monkeypatch)
    _patch_stream_windows(monkeypatch, n_windows=3, window_len=2400)
    pool = _fake_pool(2)
    banked = {}
    orig_submit = pool.submit
    def spy_submit(items, params, **kw):
        orig_save = kw.get("save")
        def save(idx, wav, sr):
            banked[idx] = wav
            if orig_save:
                orig_save(idx, wav, sr)
        kw["save"] = save
        return orig_submit(items, params, **kw)
    pool.submit = spy_submit
    list(vs.stream_message(pool, text, GenParams(),
                           config=vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0)))
    assert 0 in banked and banked[0].shape[-1] == 3 * 2400


def test_stream_message_chunk_base_global_indices_and_on_chunk(monkeypatch):
    """Resume support (3.x playground streaming): a pre-split TAIL renders under
    GLOBAL indices — the on_chunk banking hook sees them (workspace filenames), and
    per-chunk seeds stay stable across resumes because the pool derives them from
    the submitted index."""
    text = _three_chunk_text()
    from tts_utils import split_into_chunks
    c = split_into_chunks(text)
    _patch_batch_chunks(monkeypatch)
    _patch_stream_windows(monkeypatch, n_windows=2)
    pool = _fake_pool(2)
    banked = {}
    out = list(vs.stream_message(pool, "", GenParams(),
                                 config=vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0),
                                 chunks=c[1:], chunk_base=1,
                                 on_chunk=lambda i, w: banked.setdefault(i, w)))
    # 2 windows from the tail's streaming chunk (global 1), then banked global 2
    assert len(out) == 3
    assert set(banked) == {1, 2}, "on_chunk must fire with GLOBAL indices"
    assert banked[1].shape[-1] == 2 * 2400              # chunk 1 = its concatenated windows
    assert banked[2].shape[-1] == 1000 + len(c[2])      # chunk 2 = the banked batch render


def test_stream_message_on_chunk_skips_canceled_stream_chunk(monkeypatch):
    """Cancel mid-stream must NOT bank the partial first chunk: a truncated chunk
    banked as done would make every later resume produce a permanently truncated
    clip (the file passes valid_or_remove — a cleanly-written partial WAV)."""
    cancel = threading.Event()
    def fake_generate_stream(model, text, **kw):
        yield np.full(2400, 0.5, dtype=np.float32)
        cancel.set()                                    # cancel lands mid-generation
        yield np.full(2400, 0.5, dtype=np.float32)      # runner sees cancel after this window
    monkeypatch.setattr(vs, "generate_stream", fake_generate_stream)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    pool = _fake_pool(1)
    banked = {}
    list(vs.stream_message(pool, "short.", GenParams(),
                           config=vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0),
                           cancel=cancel, on_chunk=lambda i, w: banked.setdefault(i, w)))
    assert banked == {}, "a cancel-truncated streaming chunk must never bank"


def test_stream_message_end_to_end_pool(gpu_enabled, tmp_path):
    """Real pool + real model: whole-message stream off the shared queue."""
    import soundfile as sf
    pool = WorkerPool(["cuda:0"], 1, False)
    try:
        voice = _synth_voice_prompt(tmp_path)
        text = (TEXT + " The storm outside rattled the windows, but in here the fire "
                "crackled and held the dark at bay. He took a step closer, and the "
                "floorboards sighed under the weight of everything unsaid.")
        params = GenParams(voice=voice)
        t0 = time_mod.time()
        first, chunks = None, []
        for c in vs.stream_message(pool, text, params,
                                   config=vs.StreamConfig(governor_rate=1.2)):
            if first is None:
                first = time_mod.time() - t0
            chunks.append(c)
        total = np.concatenate(chunks)
        dur = len(total) / pool.sr
        print(f"\n[m2-e2e] first audio {first:.2f}s, total {dur:.1f}s in {time_mod.time()-t0:.1f}s")
        assert 10.0 < dur < 90.0
        out = Path(__file__).parent.parent / "spike_out"
        out.mkdir(exist_ok=True)
        sf.write(str(out / "streamed_pool_e2e.wav"), total, pool.sr)
    finally:
        pool.shutdown()


def test_stream_message_no_wedge_when_canceled_before_dequeue(monkeypatch):
    """Regression (review): a cancel landing before any worker dequeues the stream
    job used to wedge the consumer forever (cancel-skip never feeds win_q)."""
    text = _three_chunk_text()
    _patch_batch_chunks(monkeypatch)
    _patch_stream_windows(monkeypatch, n_windows=2)
    pool = _fake_pool(2)
    cancel = threading.Event()
    cancel.set()                                  # canceled before submit/dequeue
    t0 = time_mod.time()
    out = list(vs.stream_message(pool, text, GenParams(), cancel=cancel,
                                 config=vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0)))
    assert time_mod.time() - t0 < 5.0             # returns promptly, no hang
    assert out == []


def test_stream_message_defers_rest_until_first_window(monkeypatch):
    """Contention fix: chunks 2+ must be submitted only AFTER chunk 1's first
    audio window ships (concurrent token loops halve chunk 1's speed via the GIL)."""
    text = _three_chunk_text()
    _patch_batch_chunks(monkeypatch)
    events = []
    def fake_generate_stream(model, text_, **kw):
        events.append("gen_start")
        for j in range(3):
            yield np.full(2400, 0.001 * (j + 1), dtype=np.float32)
    monkeypatch.setattr(vs, "generate_stream", fake_generate_stream)
    pool = _fake_pool(2)
    orig_submit = pool.submit
    def spy_submit(items, params, **kw):
        events.append(("submit", [i for i, _ in items]))
        return orig_submit(items, params, **kw)
    pool.submit = spy_submit
    out = list(vs.stream_message(pool, text, GenParams(),
                                 config=vs.StreamConfig(governor_rate=1000.0, batch_rate=1000.0)))
    assert len(out) == 5                                   # 3 windows + 2 banked
    assert events[0] == ("submit", [0])                    # stream chunk alone first
    assert events.index(("submit", [1, 2])) > events.index("gen_start")


def test_stream_stall_watchdog_poisons_and_raises(monkeypatch):
    """Regression (review #58/#59): a wedged worker mid-stream (no window ever
    arrives) must not hang forever. After stall_timeout_s the streaming consumer
    poisons the pool and raises so get_pool() rebuilds — the batch path's collect()
    watchdog is never reached on the streaming path (only runs after drain)."""
    text = _three_chunk_text()
    blocked = threading.Event()

    def hanging_stream(model, text, **kw):
        blocked.wait(30)                      # simulate a hung GPU kernel: yields nothing
        return
        yield                                 # unreachable — makes this a generator

    monkeypatch.setattr(vs, "generate_stream", hanging_stream)
    pool = _fake_pool(2)
    try:
        t0 = time_mod.monotonic()
        with pytest.raises(RuntimeError, match="stalled"):
            list(vs.stream_message(pool, text, GenParams(), stall_timeout_s=0.4,
                                   config=vs.StreamConfig(governor_rate=1000.0,
                                                          batch_rate=1000.0)))
        assert time_mod.monotonic() - t0 < 15.0       # aborted, not an indefinite hang
        assert pool.poisoned is True                    # get_pool() will now rebuild
    finally:
        blocked.set()                                   # release the parked worker thread
