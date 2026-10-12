"""Coordinate streaming speech for a complete message: chunk input, schedule and buffer chunks, preserve their order, and detect stalls. Re-export the shared chunk renderer used by local and satellite workers so existing imports and patch points remain stable; a satellite renders chunks but never owns message-level assembly."""
import sys
from pathlib import Path

# The stream core lives with the satellite for the reason its docstring gives. Same explicit
# path insert, and the same reason, as `satellite_client.py` — one file, imported from two
# machines, because a vendored duplicate would drift and a drifted vocoder still makes audio.
_SATELLITE_DIR = Path(__file__).resolve().parent.parent / "satellite"
if str(_SATELLITE_DIR) not in sys.path:
    sys.path.insert(0, str(_SATELLITE_DIR))

from vocalis_stream_core import (      # noqa: E402,F401  (re-exported — see the docstring)
    SPEECH_VOCAB_SIZE,
    S3GenStreamer,
    StreamConfig,
    config_from_wire,
    generate_stream,
    render_config,
    stream_speech_tokens,
)


# ── Pool orchestration (3.0-M2) ────────────────────────────────────────────────

_STREAM_DONE = object()

# Local banking workers share the local CPU, so adding workers does not scale linearly. Remote satellites use separate CPUs and are not subject to this local limit.
LOCAL_BANK_PARALLELISM = 2


# Seed rates must be treated as per-device estimates, not universal pool rates. Batch and streaming workloads differ, and mixed local/remote pools have no single rate. Measure each device under its current load and use a conservative observation rather than a second machine-specific constant.
_RATE_WINDOW = 8
_rates: dict = {}                      # (device, kind) -> [audio_s/wall_s, ...]
_rates_lock = None                     # created lazily; this module is imported before threading
                                       # matters and a module-level Lock costs an import either way


def _rate_lock():
    global _rates_lock
    if _rates_lock is None:
        import threading
        _rates_lock = threading.Lock()
    return _rates_lock


def record_render_rate(device, audio_s: float, wall_s: float, streaming: bool = False) -> None:
    """Note one render's realized rate, in audio-seconds per wall-second.

    Called from `WorkerPool._worker_loop` for every completed chunk — the batch path feeds the
    banking rate, the `_StreamJob` path feeds the streaming rate. Cheap and never raises: a
    bookkeeping error here must not be able to fail a render.
    """
    try:
        if not device or wall_s <= 0 or audio_s <= 0:
            return
        key = (str(device), "stream" if streaming else "batch")
        with _rate_lock():
            seen = _rates.setdefault(key, [])
            seen.append(float(audio_s) / float(wall_s))
            del seen[:-_RATE_WINDOW]
    except Exception:                                          # noqa: BLE001
        pass


def observed_rate(device, streaming: bool = False):
    """The conservative measured rate for a device, or None if it has not rendered yet."""
    key = (str(device), "stream" if streaming else "batch")
    with _rate_lock():
        seen = list(_rates.get(key) or ())
    return min(seen) if seen else None


def reset_rates() -> None:
    """Forget every observation. For tests, and for a pool rebuild after a device change."""
    with _rate_lock():
        _rates.clear()


def device_rates(device, cfg: StreamConfig):
    """Return `(governor_rate, batch_rate)` for one device, using the slower of its recent measurement and configured seed. A rate is measured separately for batch and streaming workloads; the seed is used only before a device has completed a render. Streaming may be slower because the decoder processes a growing prefix at each window, so an optimistic seed can underrun before measurements exist. `stream_message` also folds in the live rate of chunk 1."""
    return (observed_rate(device, streaming=True) or cfg.governor_rate,
            observed_rate(device, streaming=False) or cfg.batch_rate)


def pool_device_of(model, fallback=None):
    """Return a pool-level device identifier for a model replica. A remote model includes its satellite identity (for example, `satellite:cuda:0`), while a local model may report only `cuda:0`; the pool identity keeps equal device names distinct. If neither attribute exists, return `fallback`. A missing attribute must not break rendering."""
    for attr in ("pool_device", "device"):
        got = getattr(model, attr, None)
        if got:
            return str(got)
    return fallback


def required_buffer_s(chunk_texts, cfg: StreamConfig, workers: int, *,
                      bank_rates=None, stream_rates=None) -> float:
    """Compute the governor floor: the seconds of chunk-1 audio to withhold so the complete ordered splice does not underrun. Simulate the pipeline, not only chunk 1: chunks 2+ bank on free workers at their batch rates, and the streaming worker joins the bank after its stream ends. Playback of chunk k begins at d plus the audio duration of earlier chunks, so it must be banked by then.

        `bank_rates` contains `(batch_rate, is_local)` for workers banking chunks 2+. `stream_rates` contains `(governor_rate, batch_rate)` for chunk 1’s worker. By default, model the legacy single-rate pool as `workers - 1` local bankers at `cfg.batch_rate`; this preserves existing all-local scheduling behavior.
    """
    import heapq
    est = [len(t) / cfg.chars_per_second for t in chunk_texts]
    if len(est) <= 1:
        return 0.0
    g_rate, s_bank = stream_rates or (cfg.governor_rate, cfg.batch_rate)
    stream_free = est[0] / max(g_rate, 0.05)     # chunk-1 worker frees here
    if bank_rates is None:
        bank_rates = [(cfg.batch_rate, True)] * max(int(workers) - 1, 0)
    # Local bankers are capped (see LOCAL_BANK_PARALLELISM); remote ones are not, because
    # they are not competing for this box's CPU.
    local = [r for r, is_local in bank_rates if is_local][:LOCAL_BANK_PARALLELISM]
    remote = [r for r, is_local in bank_rates if not is_local]
    free = [(0.0, max(r, 0.05)) for r in local + remote]
    free.append((stream_free, max(s_bank, 0.05)))
    heapq.heapify(free)
    d, played = 0.0, 0.0
    for k in range(1, len(est)):
        played += est[k - 1]                  # audio runway before chunk k plays
        start, rate = heapq.heappop(free)
        fin = start + est[k] / rate
        heapq.heappush(free, (fin, rate))
        d = max(d, fin - played)
    return d * cfg.governor_margin


def stream_message(pool, text: str, params, *, config: StreamConfig = None,
                   cancel=None, on_event=None,
                   stall_timeout_s=None, chunks: list = None, chunk_base: int = 0,
                   on_chunk=None, st_speech: bool = False):
    """One continuous audio stream for a whole message off the shared pool.

    The message is chunked with the standard chunker (same prosody as batch).
    Chunk 1 renders as a _StreamJob — its audio windows flow out while it
    generates; chunks 2+ render as normal INTERACTIVE jobs on the remaining
    workers and bank their audio, which is spliced in order as playback needs
    it (DESIGN_3.0 §2). The buffer governor withholds the first bytes until
    enough audio is banked to never underrun at the streaming worker's rate.

    5.3-m4: chunk 1 may be dequeued by a SATELLITE worker, in which case the runner opens a
    chunk-scoped stream to that machine and yields the PCM coming back. Everything else in this
    function is untouched — that is the whole point of the device model (§3.1).

    chunks/chunk_base — resume support (playground streaming): pass a pre-split
    chunk-text list (the TAIL of the full text's deterministic split) and the
    global index of its first chunk. Pool submissions use GLOBAL indices so the
    banking hook writes the right workspace filenames; rendering itself is
    unseeded (missing chunks are fresh takes). Default: split `text` here,
    base 0 (the whole message).

    st_speech — this stream is a SillyTavern message being played right now, so chunks 2+ are
    batched no wider than that satellite's `st_max_batch` setting (11.2). It is the only knob
    here that is about the LISTENER rather than the audio: chunks 2+ are exactly the ones a
    satellite may batch, and a batch of eight hands back eight chunks at once at the eighth's
    finish time — smooth for a build, a pause for someone listening.

    on_chunk(global_idx, wav_tensor) — fires from worker threads as each chunk's
    COMPLETE audio is known (the disk-banking hook; must be thread-safe). Never
    fires for a cancel-truncated streaming chunk: a partial chunk banked as if
    finished would resume into a permanently truncated clip.

    Yields float32 mono arrays at pool.sr. Raises RuntimeError if any chunk
    fails permanently. On consumer abandonment (GeneratorExit) the batch is
    canceled so pending chunks don't keep burning GPU.
    """
    import queue as _q
    import threading
    import time as _time

    import numpy as np

    from tts_utils import split_into_chunks, INTERACTIVE

    cfg = config or StreamConfig()
    if chunks is None:
        chunks = split_into_chunks(text)
    if not chunks:
        return
    n = len(chunks)
    # One cancel event shared by BOTH batches (chunk 1 + the deferred rest), so a
    # single set() — client disconnect or GeneratorExit — stops everything.
    cancel = cancel if cancel is not None else threading.Event()

    win_q = _q.Queue()             # windows (or exception / done sentinel) from chunk 1
    results, rlock = {}, threading.Lock()
    # Which device actually dequeued chunk 1. Not known until a worker picks the job up, which
    # is why the governor floor below is computed LAZILY, at the first window, rather than at
    # submission: on a mixed pool the streaming rate depends on which machine won the race.
    stream_device = {"id": None}
    # What chunk 1 is achieving RIGHT NOW, on whatever machine took it: audio seconds produced
    # against wall seconds spent, updated per window by the runner and read by the governor.
    # `rate` is a running MINIMUM so the floor can only ever grow as evidence arrives — a later,
    # rosier sample must not retroactively justify releasing audio we already decided to hold.
    live = {"audio_s": 0.0, "wall_s": 0.0, "rate": None}

    def save(idx, wav, sr):
        with rlock:
            results[idx] = wav
        # Banking hook. Chunks past the streaming one only reach save() COMPLETE
        # (a mid-chunk cancel discards the partial without saving), but the
        # streaming chunk's runner returns whatever it had when cancel landed —
        # guard it, or a truncated chunk 1 banks as done and poisons every resume.
        if on_chunk is not None and not (idx == chunk_base and cancel.is_set()):
            on_chunk(idx, wav)

    def runner(model, heartbeat):
        t0 = _time.time()
        pieces = []
        stream_device["id"] = pool_device_of(model)
        try:
            # A remote replica exposes `.stream`, not the local model internals required by `generate_stream`. Detect it through the shared `is_remote` capability instead of importing or type-checking the satellite class. A stream job is not retried because its audio may already be on the wire.
            if getattr(model, "is_remote", False):
                windows = model.stream(chunks[0], audio_prompt_path=params.voice,
                                       exaggeration=params.exaggeration,
                                       cfg_weight=params.cfg,
                                       temperature=params.temperature,
                                       config=cfg)
            else:
                windows = generate_stream(model, chunks[0],
                                          audio_prompt_path=params.voice,
                                          exaggeration=params.exaggeration,
                                          cfg_weight=params.cfg,
                                          temperature=params.temperature,
                                          config=cfg)
            for w in windows:
                pieces.append(w)
                live["audio_s"] += len(w) / pool.sr
                live["wall_s"] = _time.time() - t0
                if live["wall_s"] > 0:
                    seen = live["audio_s"] / live["wall_s"]
                    live["rate"] = seen if live["rate"] is None else min(live["rate"], seen)
                win_q.put(w)
                heartbeat()        # window-level watchdog progress
                if cancel is not None and cancel.is_set():
                    break
            win_q.put(_STREAM_DONE)
        except BaseException as exc:
            win_q.put(exc)         # unblock the consumer before failing the job
            raise
        wav = np.concatenate(pieces) if pieces else np.zeros(0, np.float32)
        import torch as _torch
        return _torch.from_numpy(wav).unsqueeze(0), len(chunks[0]), _time.time() - t0

    # The streaming and batch token loops share one Python process. Defer chunks 2+ until chunk 1 has emitted its first window so concurrent batch work cannot slow the first audible response; later chunks retain a playback cushion.
    batch = pool.submit([(chunk_base, chunks[0])], params, priority=INTERACTIVE,
                        save=save, total=chunk_base + n, on_event=on_event, cancel=cancel,
                        stream_runner=runner, st_speech=st_speech)
    rest_batch = None

    def submit_rest():
        nonlocal rest_batch
        if n > 1 and rest_batch is None:
            rest_batch = pool.submit([(chunk_base + i, c) for i, c in enumerate(chunks)][1:],
                                     params, priority=INTERACTIVE, save=save,
                                     total=chunk_base + n,
                                     on_event=on_event, cancel=cancel,
                                     # 11.2 — THIS is the submission the setting bounds: chunks
                                     # 2+ are the only ones a satellite can batch (chunk 1 above
                                     # is a `_StreamJob`, excluded by design).
                                     st_speech=st_speech)

    def governor_floor():
        """Pre-buffer so the WHOLE splice schedule holds, not just chunk 1 (chunks 2+ bank
        slower than realtime under contention — see required_buffer_s).

        Computed once, at the first window, because that is the first moment the streaming
        worker's device is known. On an all-local pool this is the same number it always was.
        """
        with pool._lock:
            devices = [w.get("device") for w in pool.workers]
        me = stream_device["id"]
        if me is not None and me in devices:
            devices.remove(me)                 # the streaming worker banks separately, below
        elif devices:
            devices.pop()                      # unknown device: still one fewer banker
        from satellite_client import is_remote
        banks = [(device_rates(d, cfg)[1], not is_remote(d)) for d in devices]
        g_rate, s_bank = device_rates(me, cfg) if me else (cfg.governor_rate, cfg.batch_rate)
        # Fold the live chunk-1 rate into the governor floor. A seed can overestimate a remote device before it has history; using the slower of the seed and current observation can lengthen the initial buffer, not create a new underrun.
        if live["rate"]:
            g_rate = min(g_rate, live["rate"])
        return required_buffer_s(chunks, cfg, len(devices) + 1, bank_rates=banks,
                                 stream_rates=(g_rate, s_bank))

    d, sr = None, pool.sr

    # Stall watchdog for the LIVE phase. The batch path's collect() watchdog only runs
    # AFTER drain, so without this a wedged GPU kernel mid-stream (no window ever
    # arrives / a chunk never banks) hangs the consumer forever, leaks the leased
    # worker, and never poisons the pool — a silent permanent outage on a 1-worker box.
    # Mirror collect(): after stall_s of zero progress with worker(s) alive, poison the
    # pool + raise so get_pool() rebuilds. stall_s = the batch threshold (900s; 2h on CPU).
    stall_s = (pool._resolve_stall_timeout(stall_timeout_s)
               if hasattr(pool, "_resolve_stall_timeout") else (stall_timeout_s or 900.0))
    last_progress = _time.monotonic()

    try:
        held, held_samples, released = [], 0, False
        while True:
            try:
                w = win_q.get(timeout=0.5)
            except _q.Empty:
                # The runner may NEVER run: the worker loop's cancel-skip resolves a
                # canceled-while-queued job without invoking it, and an OOM-drained
                # pool never dequeues it at all. Without these checks this generator
                # (and the thread driving it) would wedge on win_q forever.
                if batch.cancel.is_set():
                    return
                with batch.lock:
                    failure = batch.failed.get(chunk_base)
                if failure is not None:
                    raise RuntimeError(f"streaming chunk failed: {failure}")
                with pool._lock:
                    n_workers = len(pool.workers)
                if n_workers == 0:
                    raise RuntimeError("no workers left to run the stream (pool drained)")
                if _time.monotonic() - last_progress > stall_s:
                    pool.poisoned = True
                    raise RuntimeError(
                        f"streaming stalled: no audio for {stall_s:.0f}s with worker(s) "
                        f"alive — a worker is likely wedged (hung GPU kernel). Aborting.")
                continue
            last_progress = _time.monotonic()      # a window arrived — progress
            if w is _STREAM_DONE:
                break
            if isinstance(w, BaseException):
                raise RuntimeError(f"streaming chunk failed: {w!r}") from w
            # 🔴 The floor is computed BEFORE the rest is submitted, and the order is
            # load-bearing. `governor_floor` reads measured per-device rates, and the moment
            # chunks 2+ are queued a fast worker can bank one and post a fresh observation —
            # so computing the floor afterward races the banking it is supposed to be
            # predicting, and the same message yields a different floor run to run. This is
            # also what the docstring's "release decision point" has always meant.
            if not released:
                # Recomputed every window until release, because each one sharpens the live
                # rate above — the first window alone includes prompt processing and reads
                # slower than the steady state. `max` keeps the floor monotone: evidence may
                # raise it, never lower it, so audio already held is never released on the
                # strength of a rosier later sample.
                d = governor_floor() if d is None else max(d, governor_floor())
            submit_rest()          # chunk 1's critical first window is out
            if released:
                yield w
                continue
            held.append(w)
            held_samples += len(w)
            if held_samples >= d * sr:
                released = True
                out, held, held_samples = np.concatenate(held), [], 0
                yield out
        submit_rest()               # zero-window edge: make sure the rest is queued

        def await_banked(i):
            """Block until chunk i's (LOCAL index) banked audio exists. False =
            canceled / batch resolved without a result (caller returns quietly)."""
            nonlocal last_progress
            while True:
                with rlock:
                    if results.get(chunk_base + i) is not None:
                        last_progress = _time.monotonic()      # a chunk banked — progress
                        return True
                with rest_batch.lock:
                    failure = rest_batch.failed.get(chunk_base + i)
                    pending = rest_batch.pending
                if failure is not None:
                    raise RuntimeError(f"chunk {i + 1}/{n} failed: {failure}")
                if cancel.is_set():
                    return False
                if pending <= 0:
                    return False
                if _time.monotonic() - last_progress > stall_s:
                    pool.poisoned = True
                    raise RuntimeError(
                        f"streaming stalled: chunk {i + 1}/{n} not banked for "
                        f"{stall_s:.0f}s — a worker is likely wedged. Aborting.")
                rest_batch.progress.wait(0.25)
                rest_batch.progress.clear()

        if held:                    # chunk 1 finished under the buffer floor
            if not released and n > 1:
                # The floor exceeds chunk 1's ENTIRE audio: releasing now would
                # guarantee a mid-sentence stall at the first splice. Hold the
                # start until chunk 2 is actually banked — a later first note
                # beats a freeze in the middle of a word.
                if not await_banked(1):
                    return
            yield np.concatenate(held)

        # Splice the banked chunks in index order.
        for i in range(1, n):
            if not await_banked(i):
                return
            with rlock:
                w = results[chunk_base + i]
            yield w.squeeze(0).float().cpu().numpy()

        # Everything consumed; surface any bookkeeping errors + account totals.
        pool.collect(batch, stall_timeout_s=stall_timeout_s)
        if rest_batch is not None:
            pool.collect(rest_batch, stall_timeout_s=stall_timeout_s)
    except GeneratorExit:
        cancel.set()                # consumer gone (client disconnect): stop the burn
        raise
