"""5.3-m4: streaming across the machine boundary.

Three things here are load-bearing and each one failed silently in an earlier design:

* **The governor floor must not move on a box with no satellites.** The client's constants are tuned
  contended measurements and the symptom of getting this wrong — "first audio is later than it
  needs to be" — is something nobody reports as a bug. So the legacy schedule is reproduced by
  an independent implementation and compared, rather than asserted against magic numbers.
* **A stream that stops early must be refused.** Authenticated frames arriving in a prefix look
  exactly like a short message.
* **The route's generator runs after Flask has torn the request context down.** Reading the
  request inside it raises, and every stream would fail on its first frame.

Design: DESIGN_5_3_SATELLITES §3.1, §3.3, §7.1, §10, §12.1, §12.2.
"""
import contextlib
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT / "satellite"))

import vocalis_satellite_protocol as proto      # noqa: E402
import vocalis_stream_core as core              # noqa: E402
import vocalis_streaming as vs                  # noqa: E402


# ── the shared file stays standalone ─────────────────────────────────────────

def test_the_stream_core_has_no_vocalis_imports():
    """🔴 The satellite folder is copied to a machine with no `src/` on it.

    A module-level `import tts_utils` here would not fail in the client environment — it would fail on the
    satellite, at start-up, on the other side of the house. Only `generate_stream`'s
    `audio_prompt_path` branch may reach into Vocalis, and it does so lazily and never runs
    there. Same rule, same reason, as the protocol module.
    """
    import ast
    src = (REPO_ROOT / "satellite" / "vocalis_stream_core.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    banned = {"tts_utils", "vault", "vault_fs", "scratch", "vocalis", "settings",
              "vocalis_streaming", "satellite_client"}
    for node in tree.body:                       # module level ONLY — function level is fine
        names = []
        if isinstance(node, ast.Import):
            names = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module.split(".")[0]]
        assert not (set(names) & banned), f"{names} must not be imported at module level"


def test_vocalis_streaming_still_exports_the_core_names():
    """Every `from vocalis_streaming import generate_stream` in the tree, and the suite's
    `monkeypatch.setattr(vocalis_streaming, "generate_stream", ...)`, depend on this."""
    for name in ("StreamConfig", "S3GenStreamer", "generate_stream", "stream_speech_tokens",
                 "SPEECH_VOCAB_SIZE"):
        assert getattr(vs, name) is getattr(core, name)


def test_only_the_render_knobs_cross_the_wire():
    """The governor fields are the client's scheduling view of a whole message. Sending them to a
    satellite would invite it to act on numbers describing a machine it is not."""
    wire = core.render_config(core.StreamConfig())
    for governor_only in ("governor_rate", "batch_rate", "governor_margin", "chars_per_second"):
        assert governor_only not in wire
    assert wire["step_tokens"] == 50


def test_an_unknown_config_key_is_dropped_not_fatal():
    """§4 declares versions and never enforces them, so a newer client must be able to drive an
    older satellite. An unknown knob has to degrade to this satellite's default."""
    cfg = core.config_from_wire({"step_tokens": 7, "a_knob_from_the_future": 12})
    assert cfg.step_tokens == 7
    assert cfg.n_cfm_timesteps == core.StreamConfig().n_cfm_timesteps


# ── the governor (§3.3, §12.1) ───────────────────────────────────────────────

def _legacy_floor(chunk_texts, cfg, workers):
    """The pre-5.3 implementation, transcribed. Kept as an INDEPENDENT copy on purpose: the
    point is to detect the per-worker rewrite moving the tuned floor, and a test that called
    the new function with different arguments could not do that."""
    import heapq
    est = [len(t) / cfg.chars_per_second for t in chunk_texts]
    if len(est) <= 1:
        return 0.0
    stream_free = est[0] / max(cfg.governor_rate, 0.05)
    free = [stream_free] if workers <= 1 else [0.0] * min(workers - 1, 2) + [stream_free]
    heapq.heapify(free)
    d, played = 0.0, 0.0
    for k in range(1, len(est)):
        played += est[k - 1]
        start = heapq.heappop(free)
        fin = start + est[k] / max(cfg.batch_rate, 0.05)
        heapq.heappush(free, fin)
        d = max(d, fin - played)
    return d * cfg.governor_margin


@pytest.mark.parametrize("workers", [1, 2, 3, 5, 8])
@pytest.mark.parametrize("n_chunks", [1, 2, 3, 7])
def test_the_default_rates_reproduce_the_legacy_floor(workers, n_chunks):
    """🔴 The no-regression pin. On a box with no satellites the buffer floor must be the
    number it has always been, including the local bank-parallelism cap of 2."""
    cfg = core.StreamConfig()
    chunks = [("x" * (200 + 40 * i)) for i in range(n_chunks)]
    assert vs.required_buffer_s(chunks, cfg, workers) == pytest.approx(
        _legacy_floor(chunks, cfg, workers))


def test_a_remote_banker_escapes_the_local_parallelism_cap():
    """The cap exists because the local host is CPU-bound at ~95% with one worker per card. A satellite
    banks on another machine's CPU entirely, so capping it applies the local ceiling to hardware
    that does not have it — §3.3's mistake in miniature."""
    # The rate has to make BANKING the bottleneck for worker count to matter at all: with the
    # default 0.7 a chunk banks in 1.4x its own playing time, so three slots already keep well
    # ahead of playback and the floor is set entirely by the first splice. Worker count only
    # enters the schedule once the queue cannot keep up — which is exactly the situation the
    # cap was written for, and the only one in which capping the wrong workers costs anything.
    cfg = core.StreamConfig(batch_rate=0.2)
    chunks = ["x" * 400] * 6
    local_only = vs.required_buffer_s(chunks, cfg, 5,
                                      bank_rates=[(cfg.batch_rate, True)] * 4)
    with_remote = vs.required_buffer_s(chunks, cfg, 5,
                                       bank_rates=[(cfg.batch_rate, True)] * 2
                                       + [(cfg.batch_rate, False)] * 2)
    assert with_remote < local_only, "two extra remote bankers must shorten the schedule"
    # ...and the four LOCAL ones must still be capped at two, or the cap has been lost.
    assert local_only == vs.required_buffer_s(chunks, cfg, 3,
                                              bank_rates=[(cfg.batch_rate, True)] * 2)


def test_a_faster_streaming_worker_lowers_the_floor():
    """The whole point of m4's governor work: chunk 1 on a 4090 frees its worker sooner and
    needs less withheld, so first audio arrives earlier."""
    cfg = core.StreamConfig()
    chunks = ["x" * 400] * 4
    slow = vs.required_buffer_s(chunks, cfg, 2, bank_rates=[(0.7, True)],
                                stream_rates=(0.8, 0.7))
    fast = vs.required_buffer_s(chunks, cfg, 2, bank_rates=[(0.7, True)],
                                stream_rates=(2.2, 2.0))
    assert fast < slow


def test_a_single_chunk_never_withholds_anything():
    assert vs.required_buffer_s(["only one"], core.StreamConfig(), 4) == 0.0


# ── measured rates ───────────────────────────────────────────────────────────

def test_an_unmeasured_device_falls_back_to_the_client_constants():
    cfg = core.StreamConfig()
    assert vs.device_rates('test-satellite:cuda:0', cfg) == (cfg.governor_rate, cfg.batch_rate)


def test_the_measured_rate_is_the_conservative_one():
    """🔴 The MINIMUM of the window, not the mean. An idle observation predicting a busy future
    is the direction that underruns, and an underrun is a mid-sentence gap — while being too
    conservative only costs a slightly late first note."""
    vs.record_render_rate("cuda:0", 10.0, 5.0)      # 2.0x, uncontended
    vs.record_render_rate("cuda:0", 10.0, 12.5)     # 0.8x, contended
    assert vs.observed_rate("cuda:0") == pytest.approx(0.8)


def test_streaming_and_batch_rates_are_measured_separately():
    """They are different numbers for the same card — the streaming path vocodes in windows
    over a growing prefix, the batch path does not."""
    vs.record_render_rate("cuda:0", 10.0, 10.0, streaming=True)
    vs.record_render_rate("cuda:0", 10.0, 20.0, streaming=False)
    assert vs.observed_rate("cuda:0", streaming=True) == pytest.approx(1.0)
    assert vs.observed_rate("cuda:0", streaming=False) == pytest.approx(0.5)


def test_a_nonsense_observation_is_ignored_rather_than_poisoning_the_floor():
    """Called from the worker loop on the hot path of every render; it must never raise, and a
    zero-length or zero-time render must not divide by anything."""
    vs.record_render_rate("cuda:0", 0.0, 1.0)
    vs.record_render_rate("cuda:0", 1.0, 0.0)
    vs.record_render_rate(None, 1.0, 1.0)
    assert vs.observed_rate("cuda:0") is None


def test_the_rate_window_forgets_old_observations():
    for _ in range(vs._RATE_WINDOW):
        vs.record_render_rate("cuda:0", 10.0, 10.0)     # 1.0x
    vs.record_render_rate("cuda:0", 10.0, 5.0)          # 2.0x, pushing the first one out
    assert vs.observed_rate("cuda:0") == pytest.approx(1.0)
    for _ in range(vs._RATE_WINDOW):
        vs.record_render_rate("cuda:0", 10.0, 5.0)
    assert vs.observed_rate("cuda:0") == pytest.approx(2.0), "the window never emptied"


def test_the_pool_device_of_a_bare_object_is_none():
    """The suite's fake pools hand the runner a plain `object()`. A rate lookup must never be
    the thing that breaks a render."""
    assert vs.pool_device_of(object()) is None


# ── the sealed stream reply ──────────────────────────────────────────────────

@pytest.fixture
def keypair():
    master, salt = proto.new_master(), proto.new_salt()
    return (proto.derive_key(master, salt, proto.DIR_TO_SERVER),
            proto.derive_key(master, salt, proto.DIR_TO_SERVER))


def _stream_bytes(key, windows, status="ok", *, end=True, trailer=True):
    w = proto.SealedWriter(key)
    out = [w.frame(proto.TAG_HEADER + json.dumps({"sr": 24000}).encode())]
    for win in windows:
        pcm = (np.clip(win, -1, 1) * 32767).astype("<i2").tobytes()
        out.append(w.frame(proto.TAG_AUDIO + pcm))
    if trailer:
        out.append(w.frame(proto.TAG_TRAILER + json.dumps({"status": status}).encode()))
    if end:
        out.append(w.end())
    return b"".join(out)


def test_the_tagged_payloads_round_trip(keypair):
    key, _ = keypair
    win = np.linspace(-0.5, 0.5, 240, dtype=np.float32)
    reader = proto.SealedReader(key)
    tags = []
    for payload in reader.feed(_stream_bytes(key, [win, win])):
        tags.append(payload[:1])
    reader.finish()
    assert tags == [proto.TAG_HEADER, proto.TAG_AUDIO, proto.TAG_AUDIO, proto.TAG_TRAILER]


def test_a_stream_cut_mid_flight_is_refused(keypair):
    """🔴 The truncation check. Every frame that DID arrive authenticates perfectly — a prefix
    of a real stream is indistinguishable from a short one until END is missing."""
    key, _ = keypair
    blob = _stream_bytes(key, [np.zeros(240, np.float32)] * 3, end=False)
    reader = proto.SealedReader(key)
    list(reader.feed(blob))
    with pytest.raises(proto.ProtocolError, match="truncated"):
        reader.finish()


# ── RemoteModel.stream ───────────────────────────────────────────────────────

class FakeClient:
    """Stands in for a satellite. Records what it was asked and replays a scripted reply."""

    name = 'test-satellite'

    def __init__(self, payloads=None, status=200, err=None):
        self.payloads = payloads or []
        self.status = status
        self.err = err
        self.calls = []
        self.canceled = []
        self.voices_sent = []

    def stream(self, request_id, text, voice_hash, **kw):
        self.calls.append((request_id, text, voice_hash, kw))
        if self.status != 200:
            return self.status, self.err, None
        return 200, None, iter(self.payloads)

    def render(self, request_id, text, voice_hash, **kw):
        w = proto.SealedWriter(b"\x00" * 32)
        return 200, None, [json.dumps({"sr": 24000, "samples": 4}).encode(),
                           (np.zeros(4, np.float32) * 32767).astype("<i2").tobytes()]

    def cancel(self, request_id):
        self.canceled.append(request_id)
        return True

    def send_voice(self, voice_hash, data):
        self.voices_sent.append(voice_hash)
        return {"prepared_on": 1}


def _payloads(windows, status="ok", *, trailer=True):
    out = [proto.TAG_HEADER + json.dumps({"sr": 24000}).encode()]
    for win in windows:
        out.append(proto.TAG_AUDIO + (np.clip(win, -1, 1) * 32767).astype("<i2").tobytes())
    if trailer:
        out.append(proto.TAG_TRAILER + json.dumps({"status": status}).encode())
    return out


def _remote(client, verbs=("stream",)):
    from satellite_client import RemoteModel
    return RemoteModel(client, "cuda:0", 24000, verbs=list(verbs))


def test_a_remote_model_yields_the_windows_it_is_sent():
    win = np.full(120, 0.25, dtype=np.float32)
    m = _remote(FakeClient(_payloads([win, win])))
    got = list(m.stream("hello"))
    assert len(got) == 2
    assert got[0] == pytest.approx(win, abs=1e-4)


def test_the_pool_device_carries_the_satellite_name():
    """`cuda:0` alone is ambiguous across two satellites, and the governor keys its measured
    rates on the pool-level id."""
    assert _remote(FakeClient()).pool_device == 'test-satellite:cuda:0'


def test_a_stream_without_a_trailer_is_an_error():
    """🔴 The frames authenticated and END arrived, but the satellite never said how it ended.
    Treating that as success is how a truncated render becomes a finished one."""
    m = _remote(FakeClient(_payloads([np.zeros(8, np.float32)], trailer=False)))
    with pytest.raises(Exception, match="without a trailer"):
        list(m.stream("hello"))


def test_an_error_trailer_raises():
    m = _remote(FakeClient(_payloads([np.zeros(8, np.float32)], status="error")))
    with pytest.raises(Exception, match="stream failed"):
        list(m.stream("hello"))


def test_a_canceled_trailer_keeps_the_audio_already_sent():
    """Unlike `render`, which returns nothing on cancel: these windows are already in the
    listener's ears, and `stream_message`'s save() declines to bank a truncated chunk 1."""
    win = np.full(64, 0.1, dtype=np.float32)
    got = list(_remote(FakeClient(_payloads([win, win], status="canceled"))).stream("hi"))
    assert len(got) == 2


def test_audio_before_the_header_is_refused():
    bad = [proto.TAG_AUDIO + b"\x00\x00", proto.TAG_TRAILER + b'{"status":"ok"}']
    with pytest.raises(Exception, match="before the stream header"):
        list(_remote(FakeClient(bad)).stream("hello"))


def test_an_old_satellite_degrades_to_a_whole_chunk_render():
    """🔴 A satellite older than 1.1 has no /satellite/stream, and a _StreamJob is NEVER
    retried — so failing here would abort the whole message rather than one chunk. §4 declares
    versions and does not enforce them, so the missing verb has to degrade."""
    client = FakeClient()
    m = _remote(client, verbs=("render",))
    assert not m.can_stream
    got = list(m.stream("hello"))
    assert client.calls == [], "it must not have tried the streaming verb"
    assert len(got) == 1, "the whole chunk arrives as a single window"


def test_a_satellite_that_never_declared_its_verbs_degrades_too():
    """Absence of the key IS the answer for a 1.0 satellite — it says nothing."""
    from satellite_client import RemoteModel
    assert not RemoteModel(FakeClient(), "cuda:0", 24000).can_stream


def test_the_cold_voice_handshake_ships_the_sample_and_retries():
    """409 + need_voice is the content-addressed protocol working, not a failure."""
    win = np.zeros(16, np.float32)

    class ColdThenWarm(FakeClient):
        def __init__(self):
            super().__init__()
            self.n = 0

        def stream(self, request_id, text, voice_hash, **kw):
            self.n += 1
            if self.n == 1:
                return 409, {"need_voice": voice_hash}, None
            return 200, None, iter(_payloads([win]))

    client = ColdThenWarm()
    m = _remote(client)
    m._voice_bytes_and_hash = lambda p: (b"RIFFfake", "abc123")
    assert len(list(m.stream("hello", audio_prompt_path="/voices/x.wav"))) == 1
    assert client.voices_sent == ["abc123"]


def test_canceling_a_render_whose_loop_is_a_plain_range(monkeypatch):
    """It raised `AttributeError: 'range' object has no attribute 'close'` in production.

    `_cancellable_tqdm` receives the RAW iterable, because the satellite deliberately does not
    build a tqdm (its console stays free of progress bars, unlike the local client). It then called
    `it.close()` anyway. Chatterbox's sampler passes `range(max_new_tokens)`, so EVERY canceled
    render on a satellite died inside the sampling loop with an AttributeError instead of
    `GenerationCanceled` — a 500 on `/satellite/render`, reported to the user as a failed
    render rather than as the cancel they asked for.

    The existing cancel tests all passed: they cancel through the client, the bridge and the
    route, and none of them ever ran the hook over a plain `range`.
    """
    import threading

    import vocalis_satellite_engine as eng

    ev = threading.Event()
    monkeypatch.setattr(eng._GEN_CANCEL, "event", ev, raising=False)

    it = iter(eng._cancellable_tqdm(range(1000), desc="Sampling"))
    assert next(it) == 0                      # runs normally until the cancel lands
    ev.set()
    with pytest.raises(eng.GenerationCanceled):
        next(it)

    # …and a real tqdm-like object still gets closed, which is what the call was for.
    ev.clear()
    closed = []

    class _Bar:
        def __iter__(self):
            return iter([1, 2, 3])

        def close(self):
            closed.append(True)

    it2 = iter(eng._cancellable_tqdm(_Bar()))
    assert next(it2) == 1
    ev.set()
    with pytest.raises(eng.GenerationCanceled):
        next(it2)
    assert closed == [True], "a genuine progress bar must still be closed on cancel"


def test_canceling_in_the_vocoder_whose_loop_is_a_zip(monkeypatch):
    """The sampler's `range` is not the only shape reaching the hook — `_install_cancel_hook`
    patches `s3gen/flow_matching.py` too, and that one iterates `tqdm(zip(t_span…), total=…)`.

    A `zip` has no `.close()` either, so it failed identically. The guard above already covers it
    by asking the object rather than the call site, and this pins that: narrowing the check back
    to the sampler's shape would leave the vocoder broken, which is the exact half-fix
    `_install_cancel_hook`'s own docstring records a prior partial fix — it hooked only T3, and
    cancellation looked card-dependent because whichever worker was vocoding ran to completion.
    """
    import threading

    import vocalis_satellite_engine as eng

    ev = threading.Event()
    monkeypatch.setattr(eng._GEN_CANCEL, "event", ev, raising=False)

    it = iter(eng._cancellable_tqdm(zip(range(100), range(100)), total=99))
    assert next(it) == (0, 0)
    ev.set()
    with pytest.raises(eng.GenerationCanceled):
        next(it)


def test_the_local_cancel_event_reaches_the_satellite():
    """🔴 §12.2 — the endpoint existing is not the same as cancellation working. A blocking
    HTTP call cannot poll a threading.Event, so a watcher thread bridges it; without that the
    4090 burns to the end of the message and it looks like a slow render from here."""
    import tts_utils

    ev = threading.Event()
    client = FakeClient()
    m = _remote(client)
    tts_utils._GEN_CANCEL.event = ev
    try:
        # October 10, 2026: the bridge is handed the request's client (see `RemoteModel.current_client`).
        stop, watcher = m._cancel_bridge("rid-1", m.current_client())
        ev.set()
        watcher.join(timeout=3.0)
    finally:
        tts_utils._GEN_CANCEL.event = None
        stop.set()
    assert client.canceled == ["rid-1"]


# ── stream_message dispatch (§3.1) ───────────────────────────────────────────

class _FakeRemote:
    is_remote = True
    pool_device = 'test-satellite:cuda:0'
    sr = 24000

    def __init__(self):
        self.called_with = None

    def stream(self, text, **kw):
        self.called_with = kw
        for _ in range(3):
            yield np.full(2400, 0.01, dtype=np.float32)


def test_a_remote_worker_streams_instead_of_crashing(monkeypatch):
    """🔴 The live hole m4 closes. Before this, a satellite worker dequeuing chunk 1 called
    `generate_stream` on an HTTP client — no `.t3`, no `.s3gen`, no `.conds` — which raised
    AttributeError and aborted the message, because a _StreamJob is never retried.
    """
    from conftest import make_fake_pool
    from tts_utils import GenParams

    def _boom(*a, **k):
        raise AssertionError("generate_stream must not be called for a remote replica")

    monkeypatch.setattr(vs, "generate_stream", _boom)
    pool = make_fake_pool(1)
    remote = _FakeRemote()
    pool._models = {0: remote}
    cfg = core.StreamConfig(governor_rate=1000.0, batch_rate=1000.0)
    out = list(vs.stream_message(pool, "just the one chunk", GenParams(), config=cfg))
    assert remote.called_with is not None, "the remote streaming verb was never used"
    assert sum(len(w) for w in out) == 3 * 2400


WINDOW_S = 0.1          # audio per window
_TEXT_3 = " ".join("abc"[i] * 340 + "." for i in range(3))


def _live_cfg():
    """A config whose floor lands inside a handful of 0.1 s windows, so the released amount is
    an observable quantity rather than "the whole chunk arrived first"."""
    from tts_utils import split_into_chunks
    chars = len(split_into_chunks(_TEXT_3)[0])
    return core.StreamConfig(chars_per_second=chars / 0.2)     # each chunk ~0.2 s of audio


class _SkewedClock:
    """`time.time()` plus however much wall time a fake satellite says its windows took.

    The governor measures the live streaming rate as audio seconds over `time.time()` seconds
    (`vocalis_streaming.stream_message`, which reads it through the `time` module), so the rate a
    fake satellite achieves is whatever this clock says it is. Advancing it replaces sleeping: the
    stream "takes" `wall` seconds per window and the test pays none of them. It only ever moves
    forward, and it still follows the real clock, so nothing else that reads the time can loop
    on a frozen value. When the patch is undone at teardown, `time.time()` goes back to the real
    clock and so steps BACK by the accumulated skew (up to a few seconds) for the rest of that
    worker's run."""

    def __init__(self, real):
        self._real = real
        self._skew = 0.0

    def __call__(self):
        return self._real() + self._skew

    def spend(self, seconds):
        self._skew += seconds


class _RatedRemote(_FakeRemote):
    """Streams at a KNOWN rate: `n` windows of WINDOW_S audio, each taking `wall` seconds of
    `clock` (a `_SkewedClock`) -- no real time passes."""

    def __init__(self, wall_per_window, clock, n_windows=8):
        super().__init__()
        self.wall, self.clock, self.n = wall_per_window, clock, n_windows

    def stream(self, text, **kw):
        self.called_with = kw
        for _ in range(self.n):
            self.clock.spend(self.wall)
            yield np.zeros(int(24000 * WINDOW_S), dtype=np.float32)


def _skewed_clock(monkeypatch):
    clock = _SkewedClock(time.time)
    monkeypatch.setattr(time, "time", clock)
    return clock


def _first_release_s(monkeypatch, model, cfg):
    """Run stream_message and report how much audio the FIRST release carried."""
    import torch
    from conftest import make_fake_pool
    from tts_utils import GenParams

    pool = make_fake_pool(2)
    pool._models = {0: model, 1: model}
    monkeypatch.setattr("tts_utils.make_generate_fn", lambda *a, **k: (lambda: None))
    monkeypatch.setattr("tts_utils.generate_with_retry",
                        lambda t, fn, sr, label="", out=None: (torch.zeros(1, 2400),
                                                               len(t), 0.01, False))
    out = list(vs.stream_message(pool, _TEXT_3, GenParams(), config=cfg))
    return len(out[0]) / 24000.0 if out else 0.0


def test_a_slow_satellite_buffers_more_than_a_fast_one(monkeypatch):
    """An optimistic governor_rate of 0.8 is a hazard
    for a satellite streaming while a chunk banks on the same card (measured: 0.51-0.60x), and
    an optimistic streaming rate withholds too LITTLE — a mid-sentence gap. An unmeasured
    satellite has no history to catch that, so the floor folds in the rate chunk 1 is achieving
    live, on the real device, seconds ago.
    """
    cfg = _live_cfg()
    clock = _skewed_clock(monkeypatch)
    fast = _first_release_s(monkeypatch, _RatedRemote(0.001, clock), cfg)          # ~100x realtime
    vs.reset_rates()
    slow = _first_release_s(monkeypatch, _RatedRemote(WINDOW_S / 0.2, clock), cfg)  # 0.2x realtime
    assert slow > fast, (f"a satellite streaming at 0.2x must withhold more than one at 100x "
                         f"(slow={slow:.3f}s, fast={fast:.3f}s)")


def test_the_live_rate_never_lowers_the_floor_below_the_constants(monkeypatch):
    """`min` with the configured rate, so this mechanism can only ever ADD buffer. Without that,
    a satellite whose windows happen to look quick would release earlier than the configured floor
    allows — introducing an underrun that did not exist before m4."""
    from tts_utils import split_into_chunks

    cfg = _live_cfg()
    released = _first_release_s(monkeypatch, _RatedRemote(0.001, _skewed_clock(monkeypatch)), cfg)
    baseline = vs.required_buffer_s(split_into_chunks(_TEXT_3), cfg, 2)
    assert released >= baseline, ("a fast-looking stream released earlier than the constants "
                                  f"allow ({released:.3f}s < {baseline:.3f}s)")


def test_the_remote_stream_is_given_the_render_config(monkeypatch):
    from conftest import make_fake_pool
    from tts_utils import GenParams

    pool = make_fake_pool(1)
    remote = _FakeRemote()
    pool._models = {0: remote}
    cfg = core.StreamConfig(governor_rate=1000.0, batch_rate=1000.0, step_tokens=13)
    list(vs.stream_message(pool, "one chunk", GenParams(), config=cfg))
    assert remote.called_with["config"].step_tokens == 13


# ── the satellite route ──────────────────────────────────────────────────────

@pytest.fixture
def satellite_app(monkeypatch):
    """The real Flask app with a fake ENGINE.

    ⚠️ This layer exists for one specific trap: the route returns a GENERATOR, and Flask tears
    the request context down before that generator runs. Anything reading `request` inside it
    raises "working outside of request context" — and no unit test of the engine can see that,
    because the engine is doing nothing wrong.
    """
    import server

    master = proto.new_master()
    monkeypatch.setattr(server, "_MASTER", master)

    class FakeEngine:
        def __init__(self):
            self.streamed = []
            self.ready_flag = True
            self.voices = {"abc"}

        def ready(self):
            return self.ready_flag

        def devices(self):
            """⚠️ Present because a CAP ARRIVING ON ANY VERB now asks which cards are loaded, so
            it can re-bound torch on the ones that are (`server.take_vram_cap`). A real engine has
            had this since m1; the fake only ever needed it for the health payload, where every
            test monkeypatched it in on the spot."""
            return []

        def has_voice(self, h):
            return h in self.voices

        def stream(self, request_id, text, voice_hash, **kw):
            self.streamed.append((request_id, text, voice_hash, kw))
            yield ("sr", 24000)
            for _ in range(2):
                yield ("audio", np.full(120, 0.2, dtype=np.float32))

    engine = FakeEngine()
    monkeypatch.setattr(server, "ENGINE", engine)
    server.app.config["TESTING"] = True
    return server, engine, master


def _post_sealed(app, master, path, obj):
    salt = proto.new_salt()
    k2s = proto.derive_key(master, salt, proto.DIR_TO_SATELLITE)
    s2k = proto.derive_key(master, salt, proto.DIR_TO_SERVER)
    r = app.test_client().post(path, data=proto.seal_bytes(k2s, json.dumps(obj).encode()),
                               headers={"X-Vocalis-Salt": salt.hex(),
                                        "Content-Type": "application/octet-stream"})
    return r, s2k


def test_the_route_streams_tagged_frames_after_the_context_is_gone(satellite_app):
    server, engine, master = satellite_app
    r, s2k = _post_sealed(server.app, master, "/satellite/stream",
                          {"text": "hello there", "voice_hash": "abc", "request_id": "r1"})
    assert r.status_code == 200
    reader = proto.SealedReader(s2k)
    tags = [p[:1] for p in reader.feed(r.get_data())]
    reader.finish()
    assert tags == [proto.TAG_HEADER, proto.TAG_AUDIO, proto.TAG_AUDIO, proto.TAG_TRAILER]
    assert engine.streamed[0][1] == "hello there"


def test_the_route_ends_every_stream_with_an_end_frame(satellite_app):
    server, _, master = satellite_app
    r, s2k = _post_sealed(server.app, master, "/satellite/stream",
                          {"text": "hi", "voice_hash": "abc"})
    reader = proto.SealedReader(s2k)
    list(reader.feed(r.get_data()))
    reader.finish()                      # raises if the END frame is missing


def test_a_cold_satellite_asks_for_the_voice(satellite_app):
    server, _, master = satellite_app
    r, s2k = _post_sealed(server.app, master, "/satellite/stream",
                          {"text": "hi", "voice_hash": "not-loaded"})
    assert r.status_code == 409
    assert json.loads(b"".join(proto.open_frames(s2k, r.get_data())))["need_voice"] \
        == "not-loaded"


def test_no_model_loaded_is_a_503_before_any_frame(satellite_app):
    server, engine, master = satellite_app
    engine.ready_flag = False
    r, _ = _post_sealed(server.app, master, "/satellite/stream",
                        {"text": "hi", "voice_hash": "abc"})
    assert r.status_code == 503


def test_a_mid_stream_failure_arrives_in_band(satellite_app):
    """Once a byte has been yielded the status code is spent, so the failure has to travel as a
    trailer — and the END frame still has to be written, or the client cannot tell a reported failure
    from a severed connection."""
    server, engine, master = satellite_app

    def boom(request_id, text, voice_hash, **kw):
        yield ("sr", 24000)
        yield ("audio", np.zeros(8, np.float32))
        raise RuntimeError("the card fell over")

    engine.stream = boom
    r, s2k = _post_sealed(server.app, master, "/satellite/stream",
                          {"text": "hi", "voice_hash": "abc"})
    assert r.status_code == 200
    reader = proto.SealedReader(s2k)
    payloads = list(reader.feed(r.get_data()))
    reader.finish()
    trailer = json.loads(payloads[-1][1:])
    assert trailer["status"] == "error" and "fell over" in trailer["error"]


def test_a_cancel_mid_stream_is_reported_as_canceled_not_as_failure(satellite_app):
    server, engine, master = satellite_app
    from vocalis_satellite_engine import GenerationCanceled

    def canceled(request_id, text, voice_hash, **kw):
        yield ("sr", 24000)
        yield ("audio", np.zeros(8, np.float32))
        raise GenerationCanceled()

    engine.stream = canceled
    r, s2k = _post_sealed(server.app, master, "/satellite/stream",
                          {"text": "hi", "voice_hash": "abc"})
    reader = proto.SealedReader(s2k)
    payloads = list(reader.feed(r.get_data()))
    reader.finish()
    assert json.loads(payloads[-1][1:])["status"] == "canceled"


def test_an_unsealed_request_is_refused(satellite_app):
    """The AEAD tag is the authentication — there is no bearer token, so an endpoint that
    accepted an unsealed body would be an unauthenticated endpoint."""
    server, _, _ = satellite_app
    r = server.app.test_client().post("/satellite/stream", data=b"give me audio",
                                      headers={"X-Vocalis-Salt": "00" * 32})
    assert r.status_code == 401


def test_the_health_payload_advertises_the_streaming_verb(satellite_app):
    server, _, master = satellite_app
    for attr in ("loading", "devices", "available_devices", "worker_counts", "sample_rate",
                 "warm_voices"):
        setattr(server.ENGINE, attr, (lambda *a, **k: [] if attr.endswith("s") else None))
    r, s2k = _post_sealed(server.app, master, "/satellite/health", {})
    body = json.loads(b"".join(proto.open_frames(s2k, r.get_data())))
    assert "stream" in body["verbs"]


# ── a render with no voice at all ────────────────────────────────────────────

def test_a_voiceless_render_uses_the_models_own_default(monkeypatch):
    """🔴 `audio_prompt_path=None` is how chatterbox is told to use the MODEL'S OWN voice, and
    the routes deliberately allow it — `/playground/generate` builds
    `GenParams(voice=... if voice else None)`. The client then sends an empty hash.

    The engine looked that up in the voice cache regardless, found nothing, and raised
    `voice  not loaded` — with a blank where a name should be, which is what gave it away. It hit
    `render` as well as `stream`, so it predates m4: a voiceless BATCH render on a satellite
    failed the same way. `voice_for_model` documents the identical trap on the client side, where it
    once made every render on an encrypted box die at chunk 0.
    """
    import vocalis_satellite_engine as eng

    class _Conds:
        pass

    class _Model:
        sr = 24000
        conds = _Conds()

        def generate(self, text, **kw):
            import torch
            assert self.conds is not None, "the default conditionals were thrown away"
            return torch.zeros(1, 2400)

    e = eng.Engine()
    rep = eng.Replica("cuda:0", _Model())
    e._replicas = [rep]
    default = rep.model.conds

    audio, sr = e.render("rid", "hello", "")          # no voice hash at all
    assert sr == 24000 and len(audio) == 2400
    assert rep.model.conds is default, "the replica must be left exactly as it was found"


def test_a_named_voice_that_is_missing_still_raises(monkeypatch):
    """The fix must not swallow the real error: a voice the client named but the satellite does not
    have is a genuine failure, and silently rendering it in some other voice would be worse than
    the exception."""
    import vocalis_satellite_engine as eng

    class _Model:
        sr = 24000
        conds = object()

        def generate(self, text, **kw):
            raise AssertionError("must not reach generate")

    e = eng.Engine()
    e._replicas = [eng.Replica("cuda:0", _Model())]
    with pytest.raises(eng.SatelliteError, match="not loaded"):
        e.render("rid", "hello", "deadbeef")


# ── a voice sample bigger than one frame ─────────────────────────────────────

def test_a_voice_larger_than_the_frame_cap_ships():
    """🔴 `seal_bytes` emitted exactly ONE frame, so any body over MAX_FRAME_BYTES raised
    `frame of N bytes exceeds the 8388608-byte cap`.

    Some voice samples exceed the frame cap — including samples of 19.3 MB and 11.6 MB — so picking one of
    those made the satellite unusable for that voice. It presented as a stream error on chunk 1
    while the satellite's own log showed an ordinary 409 asking for a sample it then never
    received, which points at the wrong machine entirely.

    Raising the cap would be the wrong fix: it is a DoS bound on data nobody has authenticated
    yet, and a bigger number only moves the wall.
    """
    key = proto.derive_key(proto.new_master(), proto.new_salt(), proto.DIR_TO_SATELLITE)
    voice = bytes(range(256)) * (10_100_000 // 256)      # just over the sample's 10,056,700
    assert len(voice) > proto.MAX_FRAME_BYTES
    assert proto.open_bytes(key, proto.seal_bytes(key, voice)) == voice


def test_the_split_uses_several_frames_and_still_ends():
    key = proto.derive_key(proto.new_master(), proto.new_salt(), proto.DIR_TO_SERVER)
    blob = proto.seal_bytes(key, b"x" * (proto.FRAME_PAYLOAD_BYTES * 2 + 17))
    assert len(proto.open_frames(key, blob)) == 3, "one frame per slice"
    reader = proto.SealedReader(key)
    list(reader.feed(blob))
    reader.finish()                                       # END still terminates a split body


def test_an_empty_body_still_round_trips():
    key = proto.derive_key(proto.new_master(), proto.new_salt(), proto.DIR_TO_SATELLITE)
    assert proto.open_bytes(key, proto.seal_bytes(key, b"")) == b""


def test_the_frame_payload_size_is_even_and_under_the_cap():
    """Even, or a split lands mid-sample in int16 PCM and every frame after it is noise."""
    assert proto.FRAME_PAYLOAD_BYTES % 2 == 0
    assert proto.FRAME_PAYLOAD_BYTES < proto.MAX_FRAME_BYTES - 64


def test_a_render_reply_whose_pcm_spans_frames_is_joined():
    """`_parse` demanded exactly two frames. The PCM fits in one today only because of the
    chunker's size limit — the same assumption that broke voice shipping, pointed the other way.
    """
    from satellite_client import RemoteModel
    header = json.dumps({"sr": 24000, "samples": 6}).encode()
    meta, pcm = RemoteModel._parse([header, b"\x01\x00\x02\x00", b"\x03\x00\x04\x00"])
    assert meta["sr"] == 24000
    assert pcm == b"\x01\x00\x02\x00\x03\x00\x04\x00"


# ── the satellite's own routes ───────────────────────────────────────────────
#
# ⚠️ These had NO tests. Everything above drives `Engine` directly or fakes the client, so the
# HTTP layer — what a refusal looks like on the wire, whether `device` survives the JSON, how the
# PCM is framed — was covered only by running the real thing on the real box.

def test_a_refusal_comes_back_SEALED(satellite_app):
    """It came back as `text/plain`, and the client opens every reply as an envelope before it looks
    at the status — so `b"'text' is required"` was decrypted as a frame header and reported as
    *"frame length 661939576 exceeds the cap — refusing to allocate for unauthenticated data"*.
    A bad voice sample, reported as a crypto failure, from the wrong machine.
    """
    server, _engine, master = satellite_app
    r, s2k = _post_sealed(server.app, master, "/satellite/render", {"text": ""})
    assert r.status_code == 400
    assert r.mimetype == "application/octet-stream", "the refusal is not sealed"
    body = json.loads(b"".join(proto.open_frames(s2k, r.data)).decode("utf-8"))
    assert "text" in body["error"]


def test_the_device_field_reaches_the_engine(satellite_app, monkeypatch):
    """The client sends `device` on every render, but the route dropped it, so `_acquire`
    took the first free replica across ALL cards — two chunks on card 0 while card 1 idles, and
    a render rate booked against a card that did nothing."""
    server, engine, master = satellite_app
    seen = {}

    def _render(rid, text, vh, **kw):
        seen.update(kw)
        return np.zeros(8, dtype=np.float32), 24000

    monkeypatch.setattr(engine, "render", _render, raising=False)
    r, _s2k = _post_sealed(server.app, master, "/satellite/render",
                           {"text": "hi", "voice_hash": "abc", "device": "cuda:1"})
    assert r.status_code == 200
    assert seen.get("device") == "cuda:1", f"the route dropped it: {seen}"


def test_a_reply_bigger_than_one_frame_is_split(satellite_app, monkeypatch):
    """`SealedWriter.frame` RAISES above MAX_FRAME_BYTES, and that raise lands in the
    ProtocolError handler — which answers 401, so the client reports "the shared secret does not match"
    for a chunk that was merely long. a0a875d fixed the request direction; the reply direction
    kept emitting exactly one PCM frame, and `_parse` was already taught to join several.
    """
    from satellite_client import RemoteModel
    server, engine, master = satellite_app
    n = proto.FRAME_PAYLOAD_BYTES // 2 + 1000          # int16 -> just over one frame
    monkeypatch.setattr(engine, "render",
                        lambda *a, **kw: (np.zeros(n, dtype=np.float32), 24000), raising=False)
    r, s2k = _post_sealed(server.app, master, "/satellite/render",
                          {"text": "a long one", "voice_hash": "abc"})
    assert r.status_code == 200
    frames = proto.open_frames(s2k, r.data)
    assert len(frames) >= 3, f"the PCM was emitted as one frame ({len(frames)} frames)"
    meta, pcm = RemoteModel._parse(frames)
    assert meta["samples"] == n
    assert len(pcm) == n * 2, "the joined PCM is short — a split landed wrong"


# ── 6.2: the batch form of /satellite/render ─────────────────────────────────

def _batch_engine(engine, monkeypatch, lengths):
    """A fake `render_batch_iter` whose chunks are DIFFERENT LENGTHS and different values, so a
    split that is off by one sample, or a reply reassembled in the wrong order, cannot pass.

    A GENERATOR, because that is the shape the satellite really has since 6.2: it yields each
    chunk as its internal pass finishes rather than returning the lot.
    """
    calls = []

    def fake(request_id, texts, voice_hash, **kw):
        calls.append((request_id, list(texts), voice_hash, kw))
        for i in range(len(texts)):
            yield i, np.full(lengths[i], (i + 1) / 10.0, dtype=np.float32)

    monkeypatch.setattr(engine, "render_batch_iter", fake, raising=False)
    monkeypatch.setattr(engine, "sample_rate", lambda: 24000, raising=False)
    return calls


def test_a_batch_comes_back_keyed_by_the_ids_it_was_given(satellite_app, monkeypatch):
    """🔴 §4.2 — per-chunk identity survives the round trip. The ids here are deliberately NOT
    the positions and NOT in order, because that is the only shape in which "the client is
    secretly matching on position" fails."""
    from satellite_client import RemoteModel
    server, engine, master = satellite_app
    calls = _batch_engine(engine, monkeypatch, [100, 250, 60])
    r, s2k = _post_sealed(server.app, master, "/satellite/render", {
        "voice_hash": "abc", "request_id": "r9",
        "chunks": [{"id": "ch-7", "text": "one"},
                   {"id": "ch-2", "text": "two"},
                   {"id": "ch-5", "text": "three"}]})
    assert r.status_code == 200
    sr, got = RemoteModel.split_batch(proto.open_frames(s2k, r.data))
    assert sr == 24000
    assert sorted(got) == ["ch-2", "ch-5", "ch-7"]
    # Each id got ITS OWN audio: lengths and values both match the order they were sent in.
    assert [len(got["ch-7"]), len(got["ch-2"]), len(got["ch-5"])] == [100, 250, 60]
    assert abs(float(got["ch-2"][0]) - 0.2) < 1e-3, "chunk audio was matched to the wrong id"
    assert calls[0][1] == ["one", "two", "three"], "the engine saw the texts in order"


def test_the_single_chunk_form_still_works_untouched(satellite_app, monkeypatch):
    """A satellite is upgraded independently of its client. An older client knows
    nothing about `chunks` and must go on rendering the day this deploys — so the batch branch is
    additive and the old shape is asserted, not assumed."""
    from satellite_client import RemoteModel
    server, engine, master = satellite_app
    monkeypatch.setattr(engine, "render",
                        lambda *a, **kw: (np.full(40, 0.5, dtype=np.float32), 24000),
                        raising=False)
    r, s2k = _post_sealed(server.app, master, "/satellite/render",
                          {"text": "just the one", "voice_hash": "abc"})
    assert r.status_code == 200
    meta, pcm = RemoteModel._parse(proto.open_frames(s2k, r.data))
    assert meta["samples"] == 40 and "chunks" not in meta
    assert len(pcm) == 80


def test_a_batch_that_spans_several_frames_is_split_by_SAMPLES_not_by_frame(satellite_app,
                                                                            monkeypatch):
    """The frames are a transport detail: a chunk boundary can fall anywhere inside one, and two
    chunks can share a frame. Splitting on frames would work for as long as every chunk happened
    to be frame-sized, which is exactly how long such a bug survives review."""
    from satellite_client import RemoteModel
    server, engine, master = satellite_app
    big = proto.FRAME_PAYLOAD_BYTES // 2 + 777        # int16 — comfortably over one frame
    _batch_engine(engine, monkeypatch, [big, 33, big])
    r, s2k = _post_sealed(server.app, master, "/satellite/render", {
        "voice_hash": "abc",
        "chunks": [{"id": "a", "text": "1"}, {"id": "b", "text": "2"}, {"id": "c", "text": "3"}]})
    frames = proto.open_frames(s2k, r.data)
    assert len(frames) > 3, f"the PCM came back as one frame ({len(frames)})"
    _sr, got = RemoteModel.split_batch(frames)
    assert [len(got["a"]), len(got["b"]), len(got["c"])] == [big, 33, big]
    # The 33-sample chunk is the one that proves it: it is far smaller than a frame and sits
    # between two that are larger, so it exists only inside somebody else's frame.
    assert abs(float(got["b"][0]) - 0.2) < 1e-3


def test_a_truncated_batch_reply_raises_rather_than_padding(satellite_app, monkeypatch):
    """A short reply must not become a chunk quietly padded with silence — or worse, with the
    tail of its neighbor. The client banks a completed chunk as final."""
    from satellite_client import RemoteModel, SatelliteError
    server, engine, master = satellite_app
    _batch_engine(engine, monkeypatch, [50, 50])
    r, s2k = _post_sealed(server.app, master, "/satellite/render", {
        "voice_hash": "abc", "chunks": [{"id": "a", "text": "1"}, {"id": "b", "text": "2"}]})
    frames = list(proto.open_frames(s2k, r.data))
    # Drop the LAST chunk's audio, keeping its header and the trailer: the reply now promises a
    # chunk it never delivers, which is what a connection dying mid-batch looks like.
    kept = [f for f in frames if not (f[:1] == proto.TAG_AUDIO
                                      and float(np.frombuffer(f[1:3], dtype="<i2")[0]) > 1000)]
    with pytest.raises(SatelliteError, match="cut short"):
        list(RemoteModel.iter_batch(f for f in frames[:-2]))
    assert kept is not None      # the filter above is only here to document the shape


def test_a_batch_that_fails_mid_flight_raises_at_the_caller(satellite_app, monkeypatch):
    """🔴 Once the first frame is on the wire the HTTP status is spent, so a failure part way
    through cannot be a 4xx — it arrives in the trailer. The caller must RAISE on it: keeping
    whichever chunks happened to arrive would bank a partial section as a complete one."""
    from satellite_client import RemoteModel, SatelliteError
    server, engine, master = satellite_app

    def blow_up(request_id, texts, voice_hash, **kw):
        yield 0, np.full(40, 0.1, dtype=np.float32)
        raise RuntimeError("the card fell over")

    monkeypatch.setattr(engine, "render_batch_iter", blow_up, raising=False)
    monkeypatch.setattr(engine, "sample_rate", lambda: 24000, raising=False)
    r, s2k = _post_sealed(server.app, master, "/satellite/render", {
        "voice_hash": "abc", "chunks": [{"id": "a", "text": "1"}, {"id": "b", "text": "2"}]})
    assert r.status_code == 200, "a mid-flight failure cannot change a status already sent"
    got = []
    with pytest.raises(SatelliteError, match="fell over"):
        for cid, _sr, wav in RemoteModel.iter_batch(proto.open_frames(s2k, r.data)):
            got.append(cid)
    assert got == ["a"], "the chunks that DID land are still delivered before the raise"


def test_each_chunk_is_emitted_as_it_finishes_not_all_at_the_end(satellite_app, monkeypatch):
    """A chunk's frames must be on the wire before the next chunk has
    been rendered. A fake engine that records when it is asked for each chunk, against a consumer
    that records when it receives one, is the only way to see that from outside.
    """
    from satellite_client import RemoteModel
    server, engine, master = satellite_app
    order = []

    def fake(request_id, texts, voice_hash, **kw):
        for i in range(len(texts)):
            order.append(f"render:{i}")
            yield i, np.full(30, (i + 1) / 10.0, dtype=np.float32)

    monkeypatch.setattr(engine, "render_batch_iter", fake, raising=False)
    monkeypatch.setattr(engine, "sample_rate", lambda: 24000, raising=False)

    # 🔴 buffered=False, and it is the whole point. Flask's test client collects the entire
    # response before handing it back, so a buffered call renders every chunk BEFORE the caller
    # reads one — and this check would fail against a correct server. That is an artifact of the
    # client, not of the route: the route returns a generator either way.
    salt = proto.new_salt()
    k2s = proto.derive_key(master, salt, proto.DIR_TO_SATELLITE)
    s2k = proto.derive_key(master, salt, proto.DIR_TO_SERVER)
    body = json.dumps({"voice_hash": "abc",
                       "chunks": [{"id": "a", "text": "1"}, {"id": "b", "text": "2"},
                                  {"id": "c", "text": "3"}]}).encode()
    r = server.app.test_client().post(
        "/satellite/render", data=proto.seal_bytes(k2s, body), buffered=False,
        headers={"X-Vocalis-Salt": salt.hex(), "Content-Type": "application/octet-stream"})

    reader = proto.SealedReader(s2k)

    def payloads():
        for raw in r.response:                 # lazy — pulls the route's generator one step on
            for p in reader.feed(raw):
                yield p

    for cid, _sr, _wav in RemoteModel.iter_batch(payloads()):
        order.append(f"got:{cid}")

    # Interleaved, not two blocks: each chunk is rendered and then delivered before the next is
    # rendered. Accumulate-then-send reads render,render,render,got,got,got.
    assert order[:4] == ["render:0", "got:a", "render:1", "got:b"], order
    assert order.index("got:a") < order.index("render:2"), (
        f"chunk 'a' was not delivered until later chunks had rendered: {order}")


def test_a_batch_needing_a_voice_asks_for_it_the_same_way(satellite_app):
    """The cold-voice handshake is not re-invented for batches: a 409 with `need_voice`, the
    caller ships the sample, the caller retries. Anything else would be a second protocol for
    the same problem."""
    server, _engine, master = satellite_app
    r, s2k = _post_sealed(server.app, master, "/satellite/render", {
        "voice_hash": "not-loaded", "chunks": [{"id": "a", "text": "1"}]})
    assert r.status_code == 409
    assert json.loads(proto.open_bytes(s2k, r.data))["need_voice"] == "not-loaded"


def test_an_empty_or_textless_batch_is_a_400_not_a_render(satellite_app, monkeypatch):
    """A chunk with no text renders silence, which is banked as final and is a hole in a book."""
    server, engine, master = satellite_app
    _batch_engine(engine, monkeypatch, [10])
    for bad in ([], [{"id": "a", "text": ""}], ["not an object"]):
        r, _ = _post_sealed(server.app, master, "/satellite/render",
                            {"voice_hash": "abc", "chunks": bad})
        assert r.status_code == 400, f"{bad!r} was accepted"


def test_the_health_payload_says_it_can_batch(satellite_app):
    """The client needs a capability signal. An older satellite answers a batch with "'text' is
    required"; advertise the capability rather than inferring it from a version string."""
    server, _engine, master = satellite_app
    for attr in ("loading", "devices", "available_devices", "worker_counts", "sample_rate",
                 "warm_voices"):
        setattr(server.ENGINE, attr, (lambda *a, **k: [] if attr.endswith("s") else None))
    r, s2k = _post_sealed(server.app, master, "/satellite/health", {})
    d = json.loads(b"".join(proto.open_frames(s2k, r.get_data())))
    assert "batch_render" in (d.get("capabilities") or [])
    # 1.6 adds /satellite/capacity — "how many of these chunks can this card take right now",
    # asked one round trip before dispatch. Named here for the same reason batch_render is:
    # The client gates on the capability, never on the version, so a satellite that predates the verb
    # keeps working and simply schedules the way it always did.
    assert "capacity" in (d.get("capabilities") or [])
    # 1.7 replaces the worst-case allocator ratio with measurements from each card
    # measure its own — see `alloc_ratio`. Nothing branches on this string and nothing should;
    # it is pinned here only so a satellite deploy that did not land is visible in Settings ▸
    # Devices, which is the one place it shows.
    # 1.11 adds the per-card VRAM cap (§17): `/load` and `/capacity` carry `vram_cap_gb`, health
    # reports the one in effect and what each card holds. Pinned for the reason above and no
    # other — the satellite install is a COPY, so this string in Settings ▸ Devices is the only
    # place a deploy that did not land shows up.
    # 1.11a makes that cap LAND: the probe carries it too, and a change re-runs
    # `bound_process_memory` so the allocator moves with the sizer.
    # 1.14 refuses to start a SECOND satellite on a port one is already serving (Windows let it
    # bind and sit there silently). Pinned for the reason above and no other.
    # 2.0 adds /satellite/gpustats, and the client polls it only when health lists the verb —
    # so the verb list is the contract, and the version is pinned for the reason above.
    # 2.0.2 stops the periodic PDH-refresh log spam (no wire change, no new verb) — pinned for the
    # same "a deploy that did not land is visible" reason and no other.
    # 2.0.3 is a code-review pass over the PDH/worker plumbing (a use-after-close race, a lock
    # that blocked the housekeeping thread for a whole lead-vocal job, per-tick log spam on a
    # failure, a stale PDH object cache, an avoidable CUDA context, and the HBM/GDDR6 divisor
    # boundary) — no wire or capability change, pinned for the same reason as every entry above.
    # 2.0.4 corrects the divisor log line (it printed NVML's raw 10501 as a clock in MHz) — log
    # text only, pinned for the same reason.
    # 2.1.0 learns higher batch memory costs and fixes telemetry resource ownership.
    # 2.1.1 keeps a gigabyte between the batch reserve (3 GB) and the VRAM watchdog (2 GB).
    assert d["satellite_version"] == "2.1.1"
    assert "gpustats" in (d.get("verbs") or [])
    assert d["vram_cap_gb"] == 0.0, "uncapped until the client sends a limit"
    assert isinstance(d.get("vram_reserved_gb"), dict)
    # 🔴 The published number is the measured CEILING, not what is free right now. A live figure
    # here would be stale by the time the client used it; concurrent workloads can move the
    # available-memory value. This is why batch size does not belong in a config file,
    # reintroduced one level up. The real bound is read from mem_get_info before each pass.
    import vocalis_satellite_batch as batchmod
    assert d["max_batch"] == batchmod.MAX_BATCH == 32


@pytest.fixture
def uncapped():
    """The cap is process-global by nature — it is a property of this satellite, not of a request
    — so a test that sets one must not leave it set for the next."""
    import vocalis_satellite_batch as batchmod
    batchmod.set_vram_cap(0)
    yield batchmod
    batchmod.set_vram_cap(0)


def test_the_HEALTH_PROBE_carries_the_cap_because_an_idle_satellite_answers_nothing_else(
        satellite_app, uncapped):
    """A configured 6 GB cap must reach an idle satellite, not only `/load` or `/capacity`,
    which require active work. The health probe runs while the panel is open and can deliver the
    value to a loaded, warm, idle satellite.

    Reasserting the cap on every probe also restores it after a satellite restart.
    """
    server, engine, master = satellite_app
    for attr in ("loading", "devices", "available_devices", "worker_counts", "sample_rate",
                 "warm_voices"):
        setattr(server.ENGINE, attr, (lambda *a, **k: [] if attr.endswith("s") else None))
    r, s2k = _post_sealed(server.app, master, "/satellite/health", {"vram_cap_gb": 6.0})
    d = json.loads(b"".join(proto.open_frames(s2k, r.get_data())))
    assert uncapped.vram_cap_gb() == 6.0, "the probe delivered it"
    assert d["vram_cap_gb"] == 6.0, "and the SAME reply reports it, so Settings resolves at once"


def test_a_probe_that_says_nothing_about_a_cap_must_not_REVOKE_one(satellite_app, uncapped):
    """Unlike `/load` and `/capacity`, where absence means uncapped, this health query must not
    remove a ceiling. The client sends the key —
    0.0 when the box was cleared — so lifting a cap still works exactly as it reads."""
    server, engine, master = satellite_app
    for attr in ("loading", "devices", "available_devices", "worker_counts", "sample_rate",
                 "warm_voices"):
        setattr(server.ENGINE, attr, (lambda *a, **k: [] if attr.endswith("s") else None))
    uncapped.set_vram_cap(8)
    _post_sealed(server.app, master, "/satellite/health", {})
    assert uncapped.vram_cap_gb() == 8.0
    _post_sealed(server.app, master, "/satellite/health", {"vram_cap_gb": 0})
    assert uncapped.vram_cap_gb() == 0.0, "an explicit zero IS a revocation"


def test_a_cap_that_changes_RE_BOUNDS_the_allocator_on_every_loaded_card(satellite_app, uncapped):
    """🔴 THE SIZER AND THE ALLOCATOR HAVE TO MOVE TOGETHER. `set_per_process_memory_fraction` is
    the only line that makes torch itself refuse, and it ran once per replica inside
    `Engine.load` — so a cap edited while a model is resident changed the arithmetic and left the
    allocator on the bound the last load computed.

    The log shows both halves of the mismatch: `torch capped at 6.0 GB of 24.0` from a load,
    then `VRAM cap lifted` on the next `/capacity`, then `batch OOM on cuda:0: halving to 7` —
    twice — as the sizer spent 24 GB through an allocator still refusing past 6.
    """
    server, engine, master = satellite_app
    bounded = []
    swallowed = []
    engine.devices = lambda: ["cuda:0", "cuda:1"]

    class _Log:
        def warning(self, m):
            swallowed.append(m)

        def __getattr__(self, name):                 # info/debug/...: not interesting here
            return lambda *a, **k: None

    monkey = uncapped.bound_process_memory
    monkey_logger = server.logger
    try:
        # The stand-in has the real signature on purpose. A one-argument stand-in would make the
        # route's keyword call raise TypeError, which the route logs and swallows, and the test
        # would pass through that accident (it did, once) instead of through the behavior.
        uncapped.bound_process_memory = (
            lambda device, on_change_only=False: (bounded.append((device, on_change_only)), 0.5)[1])
        server.logger = _Log()
        _post_sealed(server.app, master, "/satellite/capacity",
                     {"device": "cuda:0", "lengths": [400], "vram_cap_gb": 6.0})
        assert bounded == [("cuda:0", False), ("cuda:1", False)], (
            "a CHANGED cap re-bounds every card that is HOLDING something, not just one, with the "
            "ordinary (always-logging) call, and the capacity path does not repeat it")
        bounded.clear()
        # October 10, 2026: this half used to assert `bounded == []` ("unchanged is a no-op —
        # this runs in front of every dispatch"). Design section 10 supersedes it: free memory
        # now comes from the whole-card reading, so a cap computed while another program held
        # memory would stay low after that program left. The cap is therefore recomputed on EACH
        # capacity request for a card that has workers, with the quiet-logging flag (it logs only
        # when the applied cap moves by 0.1 GB), and only for the requested card.
        _post_sealed(server.app, master, "/satellite/capacity",
                     {"device": "cuda:0", "lengths": [400], "vram_cap_gb": 6.0})
        assert bounded == [("cuda:0", True)], (
            "an unchanged cap is still recomputed for the requested card, quietly")
        assert swallowed == [], f"the route swallowed a failure: {swallowed}"
    finally:
        uncapped.bound_process_memory = monkey
        server.logger = monkey_logger


def test_a_card_that_cannot_be_re_bounded_does_not_fail_the_request(satellite_app, uncapped):
    """A satellite that cannot cap itself is the satellite we already have (`Engine._load_locked`
    makes the same call for the same reason) — not a reason to fail a dispatch, and certainly not
    a reason to fail the liveness probe Settings reads to decide 'running'."""
    server, engine, master = satellite_app
    engine.devices = lambda: ["cuda:0"]
    monkey = uncapped.bound_process_memory
    try:
        attempts = []

        # Real signature (see the note in the test above): the failure must be THIS RuntimeError,
        # not a TypeError from a wrong call that the route happens to swallow too.
        def boom(device, on_change_only=False):
            attempts.append((device, on_change_only))
            raise RuntimeError("no CUDA context here")
        uncapped.bound_process_memory = boom
        r, s2k = _post_sealed(server.app, master, "/satellite/capacity",
                              {"device": "cuda:0", "lengths": [400, 400], "vram_cap_gb": 6.0})
        assert r.status_code == 200
        assert attempts == [("cuda:0", False)], "the cap change reached the re-bound and failed there"
        r, s2k = _post_sealed(server.app, master, "/satellite/capacity",
                              {"device": "cuda:0", "lengths": [400, 400], "vram_cap_gb": 6.0})
        assert r.status_code == 200, "the per-request recompute failing must not fail the request"
        assert attempts[-1] == ("cuda:0", True)
        assert uncapped.vram_cap_gb() == 6.0, "the sizer still honors it"
    finally:
        uncapped.bound_process_memory = monkey


def test_capacity_answers_with_what_the_card_LEARNED_not_the_raw_estimate(satellite_app,
                                                                          monkeypatch):
    """🔴 The two halves used to disagree by exactly the correction, and the gap was paid for in
    discarded passes.

    `batch_cap` is a closed-form GUESS, and it is systematically optimistic on real prose —
    `STEPS_PER_CHAR` is fitted at 1.088 where a book decodes ~2.0. A card that had already learned
    it could hold 8 told the client to send 16, and then re-discovered its own ceiling the expensive way,
    once per submission: a pass sized too big, minutes of PCIe thrash, nothing banked.

    Since 7.3.17 the correction lives INSIDE `batch_cap` — as a ceiling in chunks, set to n-1 by a
    trip at n — so both this route and `render_batch_iter` read one number and cannot disagree.
    """
    server, engine, master = satellite_app
    import vocalis_satellite_batch as batchmod

    engine.devices = lambda: ["cuda:0"]
    monkeypatch.setattr(batchmod, "free_gb", lambda d: 100.0)   # room is not the constraint
    # October 10, 2026: the route now recomputes the allocator cap on every capacity request for
    # a card with workers, which would run the REAL `bound_process_memory` against the
    # developer's card. A stand-in with the real signature keeps this test off the hardware.
    monkeypatch.setattr(batchmod, "bound_process_memory",
                        lambda device, on_change_only=False: 0.5)
    lengths = [400] * 32

    r, s2k = _post_sealed(server.app, master, "/satellite/capacity",
                          {"device": "cuda:0", "lengths": lengths})
    full = json.loads(proto.open_bytes(s2k, r.data))["take"]
    assert full > 1, "the card should offer a real batch when nothing is corrected"

    try:
        batchmod.note_batch_too_big("cuda:0", full)             # the card learns it was wrong
        assert batchmod.batch_ceiling("cuda:0") == full - 1
        r, s2k = _post_sealed(server.app, master, "/satellite/capacity",
                              {"device": "cuda:0", "lengths": lengths})
        corrected = json.loads(proto.open_bytes(s2k, r.data))["take"]
    finally:
        with batchmod._LEARNED_MU:
            batchmod._CEILING.clear()

    assert corrected == full - 1, (
        f"/satellite/capacity offered {corrected} after a pass of {full} tripped — it must answer "
        f"one chunk lower, or the client keeps handing over the size that just failed")


# ── 6.2-m3: RemoteModel.generate_batch, client-side batch handling ───────────

class BatchClient:
    """A satellite that answers the batch form. Same shape as `FakeClient`, kept separate
    because a batch reply is a stream of tagged payloads rather than two frames."""

    name = 'test-satellite'

    def __init__(self, samples=None, status=200, err=None, trailer="ok", sr=24000):
        self.samples = samples if samples is not None else {}
        self.status = status
        self.err = err
        self.trailer = trailer
        self.sr = sr
        self.batches = []          # [[(id, text), …], …]
        self.voices_sent = []
        self.canceled = []
        self.cancel_seen = threading.Event()    # set once a cancel has been recorded
        self.loaded = True

    def _frames(self, chunks):
        for c in chunks:
            n = self.samples.get(c["id"], 8)
            yield proto.TAG_HEADER + json.dumps(
                {"id": c["id"], "samples": n, "sr": self.sr}).encode()
            yield proto.TAG_AUDIO + (np.full(n, 0.5, np.float32) * 32767).astype("<i2").tobytes()
        yield proto.TAG_TRAILER + json.dumps({"status": self.trailer}).encode()

    def render_batch(self, request_id, chunks, voice_hash, **kw):
        self.batches.append([(c["id"], c["text"]) for c in chunks])
        if self.status != 200:
            return self.status, self.err, None
        return 200, None, self._frames(chunks)

    def cancel(self, request_id):
        self.canceled.append(request_id)
        self.cancel_seen.set()
        return True

    def send_voice(self, voice_hash, data):
        self.voices_sent.append(voice_hash)
        return {"prepared_on": 1}

    def security_note(self):
        return ""


def _batch_remote(client, caps=("render", "stream", "batch_render"), max_batch=8):
    from satellite_client import RemoteModel
    return RemoteModel(client, "cuda:0", 24000, verbs=["render", "stream"],
                       caps=list(caps) if caps is not None else None, max_batch=max_batch)


def test_batching_is_gated_on_the_capability_not_the_verb_list():
    """🔴 `verbs` names the ROUTES and `capabilities` names what they can be asked for — there
    is no /satellite/batch_render, batching is a FORM of /satellite/render. Reading the wrong
    list here means a 1.1 satellite gets sent a batch it answers with a 400."""
    assert _batch_remote(BatchClient()).can_batch
    assert not _batch_remote(BatchClient(), caps=("render", "stream")).can_batch
    assert not _batch_remote(BatchClient(), caps=None).can_batch, \
        "a satellite older than 1.2 says nothing, and that is the answer"


def test_the_published_ceiling_is_bounded_before_it_is_used():
    """It arrives over the wire. A satellite reporting 0 must not stall a pool and one
    reporting 10000 must not let a single worker swallow a whole section."""
    assert _batch_remote(BatchClient(), max_batch=3).batch_slice == 3
    assert _batch_remote(BatchClient(), max_batch=0).batch_slice == 8    # absent -> the default
    assert _batch_remote(BatchClient(), max_batch=10000).batch_slice == 64


def _wait_for_cancel(client, timeout=3.0):
    """The cancel is fired in a daemon thread so it can never stall the pool's worker. The fake
    client sets `cancel_seen` when it records one; the timeout only bounds a hang."""
    client.cancel_seen.wait(timeout)
    return list(client.canceled)


@contextlib.contextmanager
def _threads_settled():
    """On exit, every thread started inside the block has finished (or been joined).

    For asserting that something did NOT happen on a thread the product starts and never hands
    back, such as the fire-and-forget cancel: a sleep cannot prove absence, but "every thread the
    call started has ended" can. A thread that already ended left its effects behind for the
    assertion to see, and one that is still running is in `threading.enumerate()` and is joined."""
    before = set(threading.enumerate())
    try:
        yield
    finally:
        started = set(threading.enumerate()) - before
        for t in started:
            t.join(timeout=10)
        still_running = sorted(t.name for t in started if t.is_alive())
        assert not still_running, f"threads started inside the block did not end within 10 s: {still_running}"


def test_a_batch_we_walk_away_from_tells_the_satellite_to_stop():
    """A submission emitted no frame for the full 900 s READ_TIMEOUT, so the
    reader raised and the pool re-dispatched those chunks — WHILE THE SATELLITE CARRIED ON with
    the abandoned pass, still holding its card. The retry then landed on a GPU busy with work
    whose only consumer had left, which is a large part of why the second attempt thrashed too.
    One stall became two, and the card was never told.

    Every abnormal exit counts, not just a timeout: a truncated reply and an error trailer leave
    the far end believing someone is still listening.
    """
    from satellite_client import SatelliteError

    class Dies(BatchClient):
        def _frames(self, chunks):
            yield proto.TAG_HEADER + json.dumps(
                {"id": chunks[0]["id"], "samples": 8, "sr": self.sr}).encode()
            raise SatelliteError("read timed out")     # what a dead socket looks like from here

    client = Dies()
    with pytest.raises(SatelliteError):
        list(_batch_remote(client).generate_batch([("a", "one"), ("b", "two")]))
    assert _wait_for_cancel(client), (
        "the satellite was never told to stop — it is still rendering a batch nobody will read")


def test_a_batch_that_lands_cleanly_is_never_canceled():
    """The other half, and the one that keeps this cheap: a cancel per successful submission
    would be a round trip per pass, and would race a request id the satellite has just retired."""
    client = BatchClient(samples={"a": 8, "b": 8})
    with _threads_settled():
        got = list(_batch_remote(client).generate_batch([("a", "one"), ("b", "two")]))
    assert len(got) == 2
    assert client.canceled == [], f"a healthy batch sent a spurious cancel: {client.canceled}"


def test_a_batch_the_satellite_itself_canceled_is_not_canceled_back():
    """It has already stopped and released the card; the request id is retired. Telling it again
    is a round trip that can only ever answer False."""
    import tts_utils

    client = BatchClient(trailer="canceled")
    with pytest.raises(tts_utils.GenerationCanceled), _threads_settled():
        list(_batch_remote(client).generate_batch([("a", "one")]))
    assert client.canceled == []


def test_generate_batch_yields_each_chunk_keyed_by_its_id():
    m = _batch_remote(BatchClient(samples={"7": 30, "2": 12}))
    got = list(m.generate_batch([("7", "one"), ("2", "two")]))
    assert [cid for cid, _ in got] == ["7", "2"]
    assert [w.shape[-1] for _, w in got] == [30, 12]
    assert got[0][1].shape[0] == 1, "shaped like a chatterbox wav — (1, samples)"


def test_a_cold_batch_ships_the_voice_and_retries(tmp_path):
    """The content-addressed handshake, not re-invented: 409 + need_voice, ship, retry."""
    sample = tmp_path / "voice.wav"
    sample.write_bytes(b"RIFF....WAVEfmt ")

    class ColdOnce(BatchClient):
        def render_batch(self, request_id, chunks, voice_hash, **kw):
            if not self.voices_sent:
                self.batches.append([(c["id"], c["text"]) for c in chunks])
                return 409, {"need_voice": voice_hash}, None
            return super().render_batch(request_id, chunks, voice_hash, **kw)

    client = ColdOnce(samples={"a": 16})
    got = list(_batch_remote(client).generate_batch([("a", "hello")],
                                                    audio_prompt_path=str(sample)))
    assert client.voices_sent, "the sample must have been shipped"
    assert len(got) == 1 and got[0][0] == "a"


def test_a_canceled_batch_raises_a_cancel_and_not_a_failure():
    """🔴 BY TYPE. Once the first frame is on the wire the status is spent, so a cancel arrives
    in the trailer looking exactly like an error — and the pool answers the two differently: a
    failure is retried three times, a cancel is dropped. Flattening the cancel means three
    rounds of retries against a satellite that was told to stop."""
    import tts_utils
    m = _batch_remote(BatchClient(trailer="canceled", samples={"a": 8}))
    with pytest.raises(tts_utils.GenerationCanceled):
        list(m.generate_batch([("a", "one"), ("b", "two")]))


def test_a_failed_batch_trailer_is_still_a_failure():
    from satellite_client import SatelliteError
    m = _batch_remote(BatchClient(trailer="error", samples={"a": 8}))
    with pytest.raises(SatelliteError):
        list(m.generate_batch([("a", "one")]))


def test_a_restarted_satellite_reloads_once_then_batches(monkeypatch):
    """503 is routine when a satellite is restarted under a
    live pool. One reload, then carry on; two would be a loop."""
    from satellite_client import RemoteModel

    client = BatchClient(samples={"a": 24})
    client.status = 503
    client.err = {"error": "no model loaded"}
    calls = []

    def recover(self):
        calls.append(1)
        client.status, client.err = 200, None
        return True

    monkeypatch.setattr(RemoteModel, "_recover", recover)
    got = list(_batch_remote(client).generate_batch([("a", "one")]))
    assert calls == [1] and len(got) == 1


# ── the satellite came back empty ───────────────────────────────────────────

class _RestartedClient(FakeClient):
    """Answers 503 until its plan is re-declared, then behaves — a satellite that was closed
    and started again while the client's pool kept its workers."""

    def __init__(self, windows):
        super().__init__()
        self.loaded = False
        self.voice_cache = set()
        self.windows = windows
        self.stream_calls = 0

    def stream(self, request_id, text, voice_hash, **kw):
        self.stream_calls += 1
        if not self.loaded:
            return 503, {"error": "no model loaded"}, None
        if voice_hash and voice_hash not in self.voice_cache:
            return 409, {"need_voice": voice_hash}, None
        return 200, None, iter(_payloads(self.windows))

    def send_voice(self, voice_hash, data):
        self.voice_cache.add(voice_hash)
        return {"prepared_on": 1}


def test_a_restarted_satellite_is_reloaded_and_the_render_survives(monkeypatch):
    """A restarted satellite can respond to health checks while having no model replicas.
    The client's pool may still hold RemoteModel workers pointing at it; drop the stale workers,
    poll health, and re-add them once replicas are ready. It
    was never built, so a `_StreamJob` (never retried, by design) aborted the whole message.
    """
    win = np.full(64, 0.2, dtype=np.float32)
    client = _RestartedClient([win, win])
    m = _remote(client)
    m._voice_bytes_and_hash = lambda p: (b"RIFFfake", "abc123")

    def _reload(name):
        client.loaded = True                    # what satellites.reload() achieves
        return True

    monkeypatch.setattr("vocalis.runtime.satellites.reload", _reload)
    got = list(m.stream("hello", audio_prompt_path="/voices/x.wav"))
    assert len(got) == 2, "the render must survive the restart"
    assert client.voice_cache == {"abc123"}, "the restart emptied the voice cache; reship it"


def test_both_recoveries_can_fire_for_one_render(monkeypatch):
    """503 -> reload -> 409 -> ship voice -> 200. A restarted satellite has an empty voice cache
    too, so the two recoveries chain — which is why this is a loop and not two nested ifs."""
    client = _RestartedClient([np.zeros(16, np.float32)])
    m = _remote(client)
    m._voice_bytes_and_hash = lambda p: (b"RIFFfake", "v1")
    monkeypatch.setattr("vocalis.runtime.satellites.reload",
                        lambda name: (setattr(client, "loaded", True), True)[1])
    list(m.stream("hi", audio_prompt_path="/voices/x.wav"))
    assert client.stream_calls == 3, "expected 503, then 409, then the real one"


def test_a_reload_that_fails_still_raises(monkeypatch):
    """If the box is genuinely gone, the error must surface — recovery must not turn an outage
    into a silent hang or a pretend success."""
    client = _RestartedClient([np.zeros(8, np.float32)])
    m = _remote(client)
    monkeypatch.setattr("vocalis.runtime.satellites.reload", lambda name: False)
    with pytest.raises(Exception, match="no model loaded"):
        list(m.stream("hello"))


def test_the_reload_is_not_attempted_twice(monkeypatch):
    """One recovery per render. A satellite that answers 503 even after a successful reload is
    broken in some other way, and retrying forever would wedge the worker."""
    client = _RestartedClient([np.zeros(8, np.float32)])
    m = _remote(client)
    calls = []
    monkeypatch.setattr("vocalis.runtime.satellites.reload",
                        lambda name: (calls.append(name), True)[1])   # claims success, stays 503
    with pytest.raises(Exception, match="no model loaded"):
        list(m.stream("hello"))
    assert len(calls) == 1


# ── the wire itself: timeouts, the dial, error bodies ────────────────────────
#
# 🔴 Everything below covers code that had NO test at all. `_post`/`_post_stream` are bypassed by
# every RemoteModel test above (they inject a FakeClient returning Python objects), so the
# connect/read timeout pair, the IPv4 dial, and what happens to a reply the satellite did not
# seal were all unpinned — including the fixes 701276f and ce488c3 were written for.

class _FakeResponse:
    def __init__(self, status=200, content=b"", ctype="application/octet-stream", text=""):
        self.status_code = status
        self.content = content
        self.headers = {"Content-Type": ctype}
        self.text = text or content.decode("utf-8", "replace")

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_content(self, chunk_size=None):
        yield self.content


def _wire_client(monkeypatch, response=None, boom=None):
    """A real `SatelliteClient` with `requests.post` replaced by a recorder."""
    import satellite_client as sc
    calls = []

    def _post(url, **kw):
        calls.append({"url": url, **kw})
        if boom is not None:
            raise boom
        return response if response is not None else _FakeResponse()

    fake_requests = type(sys)("requests")
    fake_requests.post = _post
    fake_requests.exceptions = __import__("requests").exceptions
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    # The fixture host `test-satellite` is deliberately fake and does not resolve, and `_post` dials
    # through `ipv4_url` (a real `getaddrinfo`). These tests are about the wire behavior after the
    # dial (timeouts, status handling), not about DNS — which has its own tests above — so the
    # resolver is stubbed to a TEST-NET-1 (RFC 5737) address instead of depending on the machine's
    # resolver. A test that needs a different answer patches `ipv4_url` itself after this call.
    monkeypatch.setattr(sc, "ipv4_url", lambda url: 'https://192.0.2.182:7880')
    c = sc.SatelliteClient('test-satellite', 'https://test-satellite:7880', b"\x01" * 32, verify=False)
    return c, calls


def _sealed(payload: bytes) -> bytes:
    """`payload`, sealed the way the satellite would seal a reply to a fixed salt."""
    return proto.seal_bytes(proto.derive_key(b"\x01" * 32, b"\x00" * 32, proto.DIR_TO_SERVER),
                            payload)


def test_every_request_carries_the_connect_read_timeout_PAIR(monkeypatch):
    """🔴 701276f. `requests` applies a bare `timeout=` float to EACH phase, so a satellite that
    was simply switched off sat in connect() for the READ timeout — 900 s, fifteen minutes, with
    nothing in the log after "building pool", and the second press of Audition refused because
    the first was still nominally live.

    The fix is `timeout=_timeout(t)`; collapsing it back to `timeout=t` is invisible, and there
    was no test. Both call sites, because only one of them was ever going to be remembered.
    """
    import satellite_client as sc
    monkeypatch.setattr(proto, "new_salt", lambda: b"\x00" * 32)
    c, calls = _wire_client(monkeypatch, _FakeResponse(content=_sealed(b"{}")))

    c._post("/satellite/health", b"{}", sc.HEALTH_TIMEOUT)
    c._post_stream("/satellite/stream", b"{}", sc.READ_TIMEOUT)

    assert len(calls) == 2
    for call in calls:
        assert isinstance(call["timeout"], tuple), (
            f"a bare float lets connect() wait the full read timeout: {call['timeout']!r}")
        assert call["timeout"][0] == sc.CONNECT_TIMEOUT
    assert calls[0]["timeout"][1] == sc.HEALTH_TIMEOUT
    assert calls[1]["timeout"][1] == sc.READ_TIMEOUT


def test_the_host_is_dialed_as_ipv4(monkeypatch):
    """A hostname may resolve to a AAAA record while the satellite binds `0.0.0.0` — IPv4 only —
    so the box pings fine, its console looks
    healthy, and every request connects to nothing."""
    import socket

    import satellite_client as sc
    seen = {}

    def _gai(host, port, family=0, *a, **kw):
        seen["family"] = family
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ('192.0.2.182', port or 0))]

    monkeypatch.setattr(socket, "getaddrinfo", _gai)
    assert sc.ipv4_url('https://test-satellite:7880/x') == 'https://192.0.2.182:7880/x'
    assert seen["family"] == socket.AF_INET, "the address family is the whole fix"
    assert sc.ipv4_url("https://192.0.2.5:7880") == "https://192.0.2.5:7880"
    assert sc.ipv4_url("https://[fe80::1]:7880") == "https://[fe80::1]:7880"


def test_a_host_with_no_a_record_is_unreachable_not_a_crash(monkeypatch):
    import socket

    import satellite_client as sc

    def _boom(*a, **k):
        raise OSError("no A record")

    monkeypatch.setattr(socket, "getaddrinfo", _boom)
    with pytest.raises(sc.SatelliteUnreachable):
        sc.ipv4_url('https://test-satellite:7880')


def test_the_dial_is_resolved_once_but_dropped_when_the_box_moves(monkeypatch):
    """A cached address can become stale after DHCP changes. Re-resolve when connection failure
    indicates that the satellite moved, while avoiding a lookup for every chunk.
    """
    import satellite_client as sc
    resolved = []

    def _fake(url):
        resolved.append(url)
        return f"https://192.0.2.18{len(resolved)}:7880"

    monkeypatch.setattr(sc, "ipv4_url", _fake)
    c = sc.SatelliteClient('test-satellite', 'https://test-satellite:7880', b"\x01" * 32, verify=False)
    assert c.dial_url() == "https://192.0.2.181:7880"
    assert c.dial_url() == "https://192.0.2.181:7880"
    assert len(resolved) == 1, "a DNS lookup per chunk is a needless dependency"

    c._forget_dial()
    assert c.dial_url() == 'https://192.0.2.182:7880', "a failure must re-resolve"


def test_a_connection_failure_forgets_the_dialed_address(monkeypatch):
    import requests as real_requests

    import satellite_client as sc
    monkeypatch.setattr(sc, "ipv4_url", lambda url: 'https://192.0.2.182:7880')
    c, _calls = _wire_client(monkeypatch,
                             boom=real_requests.exceptions.ConnectionError("refused"))
    with pytest.raises(sc.SatelliteUnreachable) as exc:
        c._post("/satellite/health", b"{}", 5.0)
    assert c._dial is None, "the stale address survived the failure that proved it stale"
    assert '192.0.2.182' in str(exc.value), (
        "the error named the URL that WOULD work, not the address actually dialed")


def test_an_unsealed_error_body_is_read_as_the_message_it_is(monkeypatch):
    """🔴 `_post` opened frames before it looked at the status, so a body the satellite did NOT
    seal — a 404 for a mistyped path, a Flask 500, a 400 from an older satellite — was decrypted
    as an envelope. Measured against the real app: a plain-text "'text' is required" came back
    as *"frame length 661939576 exceeds the 8388608-byte cap — refusing to allocate for
    unauthenticated data"*. Pick a voice sample librosa cannot decode and that is what you are
    told: about the crypto layer, from the wrong machine.
    """
    import satellite_client as sc
    c, _calls = _wire_client(monkeypatch,
                             _FakeResponse(400, b"'text' is required", ctype="text/plain"))
    with pytest.raises(sc.SatelliteError) as exc:
        c._post("/satellite/render", b"{}", 5.0)
    assert "'text' is required" in str(exc.value)
    assert "frame length" not in str(exc.value)
    assert "400" in str(exc.value)


def test_a_sealed_refusal_still_reaches_the_caller_as_a_status(monkeypatch):
    """The other half: 409 and 503 ARE sealed, and the recovery ladders read them as statuses.
    Turning every non-200 into an exception would break the voice handshake."""
    monkeypatch.setattr(proto, "new_salt", lambda: b"\x00" * 32)
    body = _sealed(json.dumps({"need_voice": "abc"}).encode("utf-8"))
    c, _calls = _wire_client(monkeypatch, _FakeResponse(409, body))
    status, frames = c._post("/satellite/render", b"{}", 5.0)
    assert status == 409
    assert json.loads(b"".join(frames))["need_voice"] == "abc"


def test_the_dns_lookup_does_not_hold_the_dial_lock(monkeypatch):
    """⚠️ `socket.getaddrinfo` has no timeout of its own, so a resolver that has stopped
    answering costs the system default — and it used to be called with `_dial_lock` held, which
    queued every worker for that satellite, and the Settings health poll, behind one lookup.
    DNS lookup can block, so it must not hold the per-satellite lock while workers wait.
    """
    import satellite_client as sc
    holding = []

    c = sc.SatelliteClient('test-satellite', 'https://test-satellite:7880', b"\x01" * 32, verify=False)

    def _slow(url):
        holding.append(c._dial_lock.locked())
        return 'https://192.0.2.182:7880'

    monkeypatch.setattr(sc, "ipv4_url", _slow)
    c.dial_url()
    assert holding == [False], "the resolver was called with the dial lock held"


def test_a_missing_pinned_certificate_names_the_file(monkeypatch, tmp_path):
    """⚠️ The fallback handed the configured STRING to `requests` as a CA file, which raises a
    bare `OSError("Could not find a suitable TLS CA certificate bundle")` — not a
    `RequestException`, so it escaped `_post`'s handlers as a traceback in the middle of a
    render. Fails closed either way; now it says which file is missing."""
    from satellite_client import SatelliteError
    from vocalis.runtime import satellites as sat_mod
    monkeypatch.setattr(sat_mod, "cert_dir", lambda: tmp_path)
    with pytest.raises(SatelliteError, match='test-satellite.pem'):
        sat_mod._resolve_cert('test-satellite.pem')
    (tmp_path / 'test-satellite.pem').write_bytes(b"x")
    assert sat_mod._resolve_cert('test-satellite.pem') == str(tmp_path / 'test-satellite.pem')


def test_two_renders_never_share_a_request_id():
    """🔴 `<name>-<thread id>-<id(text) & 0xffffff>`: thread ids are reused by the pool and
    CPython hands the same address back for a same-sized string, so two renders on one worker
    could match on all three parts. A cancel watcher is joined with `timeout=1.0` while
    `cancel()` may take up to 60 s, so a stale cancel can still be in flight when the next line
    starts — and with a colliding id it aborts a render nobody canceled, reported as an
    ordinary cancel. The hold-to-re-render button makes cancels a hot path.
    """
    m = _remote(FakeClient())
    ids = {m._request_id("x" * 32) for _ in range(500)}   # same length: the old collision case
    assert len(ids) == 500, f"request ids collided: {500 - len(ids)} duplicates"
    assert all(i.startswith('test-satellite-') for i in ids)
