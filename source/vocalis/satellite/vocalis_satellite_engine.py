"""Satellite Chatterbox replicas, voice cache, and request cancellation.

This module is standalone because the satellite package is copied without the Vocalis source
tree. Voice input is passed to `prepare_conditionals` through `BytesIO`, and rendered audio is
returned as an array; this module does not persist voice or render data.
"""
import io
import importlib
import os
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from loguru import logger

# Bound cached conditionals by estimated VRAM use. Cache growth reduces free VRAM and therefore
# the batch size; a proportional budget with floor and ceiling avoids an oversized fixed count.
GB_PER_CACHED_VOICE = 0.215         # measured; the number this whole bound turns on
VOICE_CACHE_GB_MIN, VOICE_CACHE_GB_MAX = 0.5, 2.5
VOICE_CACHE_FRACTION = 0.10
VOICE_CACHE_FALLBACK = 8            # when the card cannot be asked (CPU, or no CUDA)


def voice_cache_size(device: str = None) -> int:
    """How many prepared voices this device may hold. Never fewer than two — a two-character
    scene alternating speakers must not evict on every single chunk."""
    try:
        import torch
        if device and str(device).startswith("cuda") and torch.cuda.is_available():
            idx = 0
            if ":" in str(device):
                try:
                    idx = int(str(device).split(":")[1])
                except ValueError:
                    idx = 0
            total = torch.cuda.mem_get_info(idx)[1] / 1024 ** 3
            budget = min(VOICE_CACHE_GB_MAX,
                         max(VOICE_CACHE_GB_MIN, VOICE_CACHE_FRACTION * total))
            return max(2, int(budget / GB_PER_CACHED_VOICE))
    except Exception:                                    # noqa: BLE001 — a cache bound must
        pass                                             # never be the thing that fails a load
    return VOICE_CACHE_FALLBACK


class SatelliteError(Exception):
    """Anything the caller should see as a 4xx/5xx rather than a stack trace."""


class GenerationCanceled(Exception):
    """Raised inside the token-sampling or vocoder loop when this request's cancel Event is set.

    Mirrors `tts_utils.GenerationCanceled`. Aborts an in-flight render within one step instead
    of letting tens of seconds of audio finish for a listener who has already gone away.
    """


# The active request's cancel Event, read by the loops running on THIS worker thread.
# Thread-local state lets a cancellation target one render when requests share a process.
_GEN_CANCEL = threading.local()


def _cancellable_tqdm(it, *a, **kw):
    """Drop-in for the `tqdm` symbol inside chatterbox's iterative loops.

    `it` may be a plain iterable such as `range`, not a progress wrapper. Close it only when it
    provides a callable `close()` method before raising the cancellation exception.
    """
    ev = getattr(_GEN_CANCEL, "event", None)
    for x in it:
        if ev is not None and ev.is_set():
            close = getattr(it, "close", None)      # a real tqdm has one; a range does not
            if callable(close):
                close()
            raise GenerationCanceled()
        yield x


def _install_cancel_hook():
    """Swap `tqdm` for the cancellable wrapper in EVERY iterative stage of a render.

    Install the wrapper in both the T3 sampler and s3gen flow-matching vocoder so cancellation
    remains responsive during either stage.

    Idempotent, and called at model load so importing this module stays cheap.
    """
    import chatterbox.models.s3gen.flow_matching as fmmod
    import chatterbox.models.t3.t3 as t3mod
    for mod in (t3mod, fmmod):
        if not getattr(mod, "_vocalis_cancellable", False):
            mod.tqdm = _cancellable_tqdm
            mod._vocalis_cancellable = True


class VoiceCache:
    """Prepared conditionals, keyed by the voice hash Vocalis sends. Bytes in, never files.

    Caches the *conditionals* rather than the wav: `prepare_conditionals` runs `embed_ref`, a
    tokenizer forward pass and the voice-encoder embedding, all GPU work, and without this every
    render would redo it and re-ship the sample. Vocalis memoizes `voice_for_model` for the same
    reason.
    """

    def __init__(self, maxsize: int = None, device: str = None):
        self._d = OrderedDict()          # hash -> conds object
        self._lock = threading.Lock()
        self._max = int(maxsize) if maxsize else voice_cache_size(device)

    def get(self, voice_hash: str):
        with self._lock:
            if voice_hash not in self._d:
                return None
            self._d.move_to_end(voice_hash)
            return self._d[voice_hash]

    def put(self, voice_hash: str, conds) -> None:
        dropped = []
        with self._lock:
            self._d[voice_hash] = conds
            self._d.move_to_end(voice_hash)
            while len(self._d) > self._max:
                dropped.append(self._d.popitem(last=False))
        if not dropped:
            return
        for name, _ in dropped:
            logger.info(f"voice cache full — evicted {name[:8]}…")
        # Return freed blocks to the driver so batch sizing sees the reclaimed VRAM. Do this
        # outside the cache lock because `empty_cache()` synchronizes the device.
        del dropped
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:                                # noqa: BLE001 — see voice_cache_size
            pass

    def warm(self) -> list:
        with self._lock:
            return list(self._d.keys())

    def clear(self) -> None:
        with self._lock:
            self._d.clear()


class Replica:
    """One loaded model on one device, plus the lock that serializes renders through it."""

    def __init__(self, device: str, model):
        self.device = device
        self.model = model
        self.lock = threading.Lock()
        self.voices = VoiceCache(device=device)
        self.sr = int(model.sr)


class Engine:
    """Every replica this satellite holds, and the render entry point.

    Replicas are per (device, slot) so Vocalis's per-device worker count maps
    straight through: `load({"cuda:0": 2})` puts two replicas on card 0.
    """

    def __init__(self):
        self._replicas = []              # list[Replica]
        self._lock = threading.Lock()
        # `_lock` guards replica mutations; this lock serializes the full plan read-modify-write
        # across long model loads so concurrent calls cannot create duplicate replicas.
        self._load_lock = threading.Lock()
        self._gen = 0                    # bumped by unload/_trim; see load()
        self._loading = 0
        self._cancels = {}               # request_id -> threading.Event
        self._cancel_lock = threading.Lock()

    # ── lifecycle ────────────────────────────────────────────────────────────

    def load(self, plan: dict) -> dict:
        """plan: {device: worker_count}. DECLARATIVE — the requested count is the TOTAL after
        this call, not an amount to add. Returns what is resident afterward.

        The plan is declarative: repeated calls set the requested total rather than adding more
        replicas. Per-device failures are logged and skipped so one device's load failure does
        not block other devices. Serialize the operation here because callers may use different
        locks, and concurrent network requests can still arrive together.
        """
        import torch
        from chatterbox.tts import ChatterboxTTS

        with self._lock:
            self._loading += 1                     # counts waiters too — `loading()` should say
        try:                                       # "busy" while a second load queues
            with self._load_lock:
                return self._load_locked(plan, torch, ChatterboxTTS)
        finally:
            with self._lock:
                self._loading -= 1

    def _load_locked(self, plan: dict, torch, ChatterboxTTS) -> dict:
        """`load()`'s body, with `_load_lock` held. Split out only so the lock spans the whole
        read-modify-write rather than being threaded through a `with` inside a `try/finally`."""
        _install_cancel_hook()
        got = {}
        with self._lock:
            gen = self._gen
            current = {}
            for replica in self._replicas:
                current[replica.device] = current.get(replica.device, 0) + 1
        local_model_dir = None
        if os.environ.get("VOCALIS_REQUIRE_LOCALMODEL") == "1":
            needs_new_replica = any(
                int(count) > current.get(device, 0) for device, count in plan.items())
            if needs_new_replica:
                model_dir = os.environ.get("VOCALIS_CHATTERBOX_MODEL_DIR")
                if not model_dir:
                    raise RuntimeError(
                        "VOCALIS_REQUIRE_LOCALMODEL=1 requires "
                        "VOCALIS_CHATTERBOX_MODEL_DIR")
                source_root = Path(__file__).resolve().parent.parent / "src"
                validator_path = source_root / "tts_utils.py"
                if not validator_path.is_file():
                    raise RuntimeError(
                        f"Package-controlled Chatterbox validator is missing: {validator_path}")
                source_text = str(source_root)
                if source_text not in sys.path:
                    sys.path.insert(0, source_text)
                validator = importlib.import_module("tts_utils")
                if Path(validator.__file__).resolve() != validator_path.resolve():
                    raise RuntimeError("Chatterbox validator did not load from package source")
                local_model_dir = validator._verified_chatterbox_model_dir(model_dir)
        for device, count in plan.items():
            want = int(count)
            have = self.worker_counts().get(device, 0)
            if have > want:
                self._trim(device, have - want)
                have = self.worker_counts().get(device, 0)
            loaded = have
            for slot in range(have, want):
                try:
                    t0 = time.time()
                    if os.environ.get("VOCALIS_REQUIRE_LOCALMODEL") == "1":
                        model = ChatterboxTTS.from_local(local_model_dir, device=device)
                    else:
                        model = ChatterboxTTS.from_pretrained(device=device)
                    with self._lock:
                        # ⏏ Unload landed while this replica was loading. Appending it now
                        # would hold VRAM the panel has already reported as released.
                        if self._gen != gen:
                            logger.info(f"replica {slot} on {device}: released while it was "
                                        f"still loading — dropping it")
                            del model
                        # Count inline because `worker_counts()` would reacquire this non-reentrant
                        # lock and deadlock.
                            got[device] = sum(1 for r in self._replicas if r.device == device)
                            return got
                        self._replicas.append(Replica(device, model))
                    loaded += 1
                    # Bound this process's memory after loading, when the current device is known.
                    # Failure is non-fatal; batch sizing still uses the available-memory check.
                    try:
                        import vocalis_satellite_batch as batchmod
                        batchmod.bound_process_memory(device)
                    except Exception as exc:                # noqa: BLE001
                        logger.warning(f"{device}: could not cap torch's share of the card "
                                       f"({exc}) — a runaway pass can still page to host RAM")
                    free = total = None
                    if device.startswith("cuda") and torch.cuda.is_available():
                        # October 10, 2026: the same whole-card free that `bound_process_memory`
                        # just used (the driver's view where there is one), over PyTorch's own
                        # total -- not `mem_get_info`'s free, which on Windows ignores other
                        # programs. `free_and_total_gb` does not raise on a reader failure.
                        import vocalis_satellite_batch as batchmod
                        free, total = batchmod.free_and_total_gb(device)
                    where = f", {free:.1f}/{total:.1f} GB free" if free is not None else ""
                    logger.info(f"replica {slot} on {device}: loaded in "
                                f"{time.time() - t0:.1f}s{where}")
                except Exception as exc:                    # noqa: BLE001
                    logger.exception(f"replica {slot} on {device} failed to load: {exc}")
                    break                                   # rest of this card is hopeless
            got[device] = loaded
            if loaded == 0 and want > 0:
                logger.warning(f"{device}: no replicas loaded — excluding this device")
            elif want == 0:
                # Not a failure: Vocalis says zero when its card is unticked, and saying so is
                # how the VRAM comes back at all (a card left OUT of the plan is silence).
                # ASCII — this is the satellite's console, and loguru renders a stray glyph as
                # a literal ⚙ escape rather than the character.
                logger.info(f"{device}: released - Vocalis no longer asks for this card")
        return got

    def _trim(self, device: str, n: int) -> None:
        """Drop `n` replicas from `device` — the shrinking half of a declarative load."""
        import gc

        import torch
        # Do not bump `_gen` here: `_trim` is called while `_load_locked` is applying this plan.
        with self._lock:
            victims = [r for r in self._replicas if r.device == device][-n:]
            self._replicas = [r for r in self._replicas if r not in victims]
        del victims
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info(f"{device}: released {n} replica(s) — the plan asked for fewer")

    def unload(self) -> int:
        import gc

        import torch
        with self._lock:
            n, self._replicas = len(self._replicas), []
            # Anything a concurrent load still has in flight belongs to a dead generation now —
            # `_load_locked` drops it rather than resurrecting VRAM this call just released.
            self._gen += 1
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info(f"unloaded {n} replica(s)")
        return n

    # ── state ────────────────────────────────────────────────────────────────

    def ready(self) -> bool:
        with self._lock:
            return bool(self._replicas)

    def loading(self) -> bool:
        with self._lock:
            return self._loading > 0

    def devices(self) -> list:
        with self._lock:
            return sorted({r.device for r in self._replicas})

    def available_devices(self) -> list:
        """Every card this machine HAS, whether or not a replica sits on it.

        Unlike `devices()`, this lists hardware even when no replica is resident. Settings needs
        available cards so an idle satellite can be enabled and loaded.

        Empty when there is no CUDA: a satellite exists to lend a GPU, and offering its CPU
        would be offering something nobody would choose.
        """
        import torch
        if not torch.cuda.is_available():
            return []
        return [f"cuda:{i}" for i in range(torch.cuda.device_count())]

    def worker_counts(self) -> dict:
        with self._lock:
            out = {}
            for r in self._replicas:
                out[r.device] = out.get(r.device, 0) + 1
            return out

    def sample_rate(self):
        with self._lock:
            return self._replicas[0].sr if self._replicas else None

    def warm_voices(self) -> list:
        with self._lock:
            reps = list(self._replicas)
        seen = set()
        for r in reps:
            seen.update(r.voices.warm())
        return sorted(seen)

    # ── voices ───────────────────────────────────────────────────────────────

    def add_voice(self, voice_hash: str, audio_bytes: bytes) -> int:
        """Prepare conditionals on every replica from bytes held in memory.

        Pass audio bytes through `BytesIO`; `librosa.load` accepts file-like objects. Avoiding a
        temporary file keeps the sample in memory throughout preparation.
        """
        with self._lock:
            reps = list(self._replicas)
        if not reps:
            raise SatelliteError("no model loaded")
        n = 0
        for r in reps:
            with r.lock:
                prev = getattr(r.model, "conds", None)
                try:
                    r.model.prepare_conditionals(io.BytesIO(audio_bytes), exaggeration=0.5)
                    r.voices.put(voice_hash, r.model.conds)
                    n += 1
                finally:
                    # Leave the replica exactly as it was found. A half-applied voice here
                    # would make the NEXT render use whichever conditionals happened to be
                    # resident so the next render cannot inherit another request's conditionals.
                    r.model.conds = prev
        logger.info(f"voice {voice_hash[:8]}… prepared on {n} replica(s)")
        return n

    def has_voice(self, voice_hash: str) -> bool:
        with self._lock:
            reps = list(self._replicas)
        return bool(reps) and all(r.voices.get(voice_hash) is not None for r in reps)

    # ── cancellation ─────────────────────────────────────────────────────────

    def cancel(self, request_id: str) -> bool:
        """Request cancellation; a missing request is a normal completion race."""
        with self._cancel_lock:
            ev = self._cancels.get(request_id)
        if ev is None:
            return False
        ev.set()
        logger.info(f"cancel requested for {request_id}")
        return True

    def _register(self, request_id: str) -> threading.Event:
        ev = threading.Event()
        with self._cancel_lock:
            self._cancels[request_id] = ev
        return ev

    def _release(self, request_id: str) -> None:
        with self._cancel_lock:
            self._cancels.pop(request_id, None)

    # ── render ───────────────────────────────────────────────────────────────

    def render(self, request_id: str, text: str, voice_hash: str, *,
               exaggeration: float = 0.5, cfg: float = 0.5,
               temperature: float = 0.8, device: str = None) -> tuple:
        """One chunk in, float32 mono out. Returns (audio, sample_rate).

        Raises `GenerationCanceled` if canceled mid-render; never returns a partial chunk because
        the caller may persist each returned chunk as complete.
        """
        rep = self._acquire(voice_hash, device)
        if rep is None:
            raise SatelliteError("no model loaded")
        ev = self._register(request_id)
        try:
            with rep.lock:
                # An empty hash selects Chatterbox's default voice. Leave the model's current
                # conditionals unchanged when no cached voice was requested.
                prev = getattr(rep.model, "conds", None)
                if voice_hash:
                    conds = rep.voices.get(voice_hash)
                    if conds is None:
                        raise SatelliteError(f"voice {voice_hash} not loaded")
                    rep.model.conds = conds
                _GEN_CANCEL.event = ev
                t0 = time.time()
                try:
                    wav = rep.model.generate(text, exaggeration=exaggeration,
                                             cfg_weight=cfg, temperature=temperature)
                finally:
                    _GEN_CANCEL.event = None
                    rep.model.conds = prev
            audio = wav.squeeze(0).float().cpu().numpy().astype(np.float32)
            dt = time.time() - t0
            audio_s = len(audio) / rep.sr
            # `dt` can be exactly 0.0 — `time.time()` has ~16 ms granularity on Windows and the
            # satellite is a Windows box, so a very short chunk divides by zero and takes the
            # whole render down ON THE SUCCESS PATH, after the audio is already made. `stream()`
            # guards this; `render()` did not.
            rate = f" ({audio_s / dt:.2f}x realtime)" if dt > 0 else ""
            # Log request metadata only; do not include prompt text or voice names.
            logger.info(f"rendered {request_id} on {rep.device}: {len(text)} chars -> "
                        f"{audio_s:.1f}s in {dt:.1f}s{rate}")
            return audio, rep.sr
        finally:
            self._release(request_id)

    def render_batch(self, request_id: str, texts: list, voice_hash: str, *,
                     exaggeration: float = 0.5, cfg: float = 0.5,
                     temperature: float = 0.8, device: str = None) -> tuple:
        """6.2 — N chunks through ONE forward pass. Returns (list[np.float32], sample_rate).

        Measured 6.98× at n=8 on a 4090, and 0.98× at n=1 — so this is the right call even for a
        single chunk and the caller never has to decide. `DESIGN_6_2_BATCHING`.

        The satellite bounds each batch using its current free VRAM and replica footprint; a
        configured static limit would not reflect other processes using the device.

        Cancellation discards the batch. Each returned chunk is persisted as complete, and a
        batch is one forward pass, so a partial result cannot be safely separated.
        """
        wavs, sr = [], self.sample_rate()
        for _idx, wav in self.render_batch_iter(request_id, texts, voice_hash,
                                                exaggeration=exaggeration, cfg=cfg,
                                                temperature=temperature, device=device):
            wavs.append(wav)
        return wavs, self._last_batch_sr or sr

    _last_batch_sr = None

    def render_batch_iter(self, request_id: str, texts: list, voice_hash: str, *,
                          exaggeration: float = 0.5, cfg: float = 0.5,
                          temperature: float = 0.8, device: str = None,
                          more_available: bool = False, held_out: list = None):
        """The same, yielding `(index, audio)` as each internal pass finishes.

        Split the input according to current device capacity and yield each completed pass
        immediately so the caller can persist progress before later work finishes.
        """
        import vocalis_satellite_batch as batchmod
        if not texts:
            return
        rep = self._acquire(voice_hash, device)
        if rep is None:
            raise SatelliteError("no model loaded")
        ev = self._register(request_id)
        try:
            with rep.lock:
                prev = getattr(rep.model, "conds", None)
                if voice_hash:
                    conds = rep.voices.get(voice_hash)
                    if conds is None:
                        raise SatelliteError(f"voice {voice_hash} not loaded")
                    rep.model.conds = conds
                t0 = time.time()
                total = 0
                self._last_batch_sr = rep.sr
                # The T3 loop reads `cancel`; the s3gen loop reads this thread-local through the
                # patched `tqdm` wrapper. Set both cancellation paths for batched rendering.
                _GEN_CANCEL.event = ev
                try:
                    for idx, wav in batchmod.render_batch_iter(
                            rep.model, list(texts), device=rep.device,
                            exaggeration=exaggeration, cfg=cfg, temperature=temperature,
                            cancel=ev.is_set,
                            more_available=more_available, held_out=held_out):
                        total += len(wav)
                        yield idx, wav
                except batchmod.BatchCanceled:
                    raise GenerationCanceled()
                finally:
                    _GEN_CANCEL.event = None
                    rep.model.conds = prev
            dt = time.time() - t0
            audio_s = total / rep.sr
            rate = f" ({audio_s / dt:.2f}x realtime)" if dt > 0 else ""
            # Log request metadata only; do not include prompt text or voice names.
            logger.info(f"rendered {request_id} on {rep.device}: batch of {len(texts)} -> "
                        f"{audio_s:.1f}s in {dt:.1f}s{rate}")
        finally:
            self._release(request_id)

    def stream(self, request_id: str, text: str, voice_hash: str, *,
               exaggeration: float = 0.5, cfg: float = 0.5, temperature: float = 0.8,
               config=None, device: str = None):
        """The m4 verb: one chunk, yielded as float32 windows while it renders.

        A generator. The first `yield` is `("sr", <rate>)`; every later one is
        `("audio", np.float32 array)`. It ends normally when the chunk is done, and raises
        `GenerationCanceled` if Vocalis canceled it mid-render.

        A canceled stream retains already-yielded windows because they have already reached the
        listener. The caller must not persist the truncated current chunk as a completed result.

        The replica lock covers the full stream. Interleaving requests would race while swapping
        conditionals on the shared model object.
        """
        import torch
        from vocalis_stream_core import generate_stream

        rep = self._acquire(voice_hash, device)
        if rep is None:
            raise SatelliteError("no model loaded")
        ev = self._register(request_id)
        try:
            with rep.lock:
                # An empty hash selects Chatterbox's default voice. Leave the model's current
                # conditionals unchanged when no cached voice was requested.
                prev = getattr(rep.model, "conds", None)
                if voice_hash:
                    conds = rep.voices.get(voice_hash)
                    if conds is None:
                        raise SatelliteError(f"voice {voice_hash} not loaded")
                    rep.model.conds = conds
                _GEN_CANCEL.event = ev
                t0 = time.time()
                n_samples = 0
                try:
                    yield ("sr", rep.sr)
                    # audio_prompt_path is deliberately absent: the conditionals are already
                    # on the model, from the cache above. That is also what keeps the stream
                    # core's one `src/` import (voice_for_model) out of reach on this box —
                    # it lives inside the audio_prompt_path branch.
                    for window in generate_stream(rep.model, text,
                                                  exaggeration=exaggeration,
                                                  cfg_weight=cfg,
                                                  temperature=temperature,
                                                  config=config):
                        if ev.is_set():
                            raise GenerationCanceled()
                        n_samples += len(window)
                        yield ("audio", np.asarray(window, dtype=np.float32))
                finally:
                    _GEN_CANCEL.event = None
                    rep.model.conds = prev
                    if torch.cuda.is_available():
                        # The streamer pins a noise tensor sized for max_new_tokens and the
                        # flow decoder re-runs over a growing prefix, so a stream's peak is
                        # higher than a batch chunk's. Release cached allocations before another
                        # process or request needs the device.
                        torch.cuda.empty_cache()
            dt = time.time() - t0
            audio_s = n_samples / rep.sr if rep.sr else 0.0
            rate = f" ({audio_s / dt:.2f}x realtime)" if dt > 0 else ""
            # Events, never content — same rule as render(), and this fires on every stream.
            logger.info(f"streamed {request_id} on {rep.device}: {len(text)} chars -> "
                        f"{audio_s:.1f}s in {dt:.1f}s{rate}")
        finally:
            self._release(request_id)

    def _acquire(self, voice_hash: str, device: str = None):
        """Prefer a replica that already has this voice; otherwise the least busy one.

        Respect the requested device so pool scheduling and per-device render measurements stay
        aligned. Selecting the first available replica could route work to one card while another
        remained idle and record its rate against the wrong device. The governor then plans a
        buffer floor from a card that did nothing — §3.3's "a rate for a machine that does not
        exist", one level down. Latent while a satellite has one card; wrong the day it has two.

        A device Vocalis names but this satellite has no replica on falls back to the whole pool
        rather than failing the render, with one warning — the two boxes can legitimately
        disagree about what is loaded while a plan is being applied.
        """
        with self._lock:
            reps = list(self._replicas)
        if not reps:
            return None
        if device:
            on_card = [r for r in reps if r.device == device]
            if on_card:
                reps = on_card
            else:
                logger.warning(f"asked for {device} but no replica is loaded there — using "
                               f"whatever is resident ({sorted({r.device for r in reps})})")
        warm = [r for r in reps if r.voices.get(voice_hash) is not None]
        pool = warm or reps
        free = [r for r in pool if not r.lock.locked()]
        return (free or pool)[0]


ENGINE = Engine()
