"""Render eligible upcoming messages speculatively and promote completed audio into the ordinary speech cache. Start only when the system is idle and the model is already loaded; spool under an opaque scratch name, allow listeners to join an in-progress job, and batch queued work by voice. This module owns no Flask routes."""
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

import scratch
import vault_fs
from loguru import logger

from mp3_render import READ_BLOCK, Mp3Render, cache_hit

# Bound speculative queue size, age, and preemption so background rendering cannot grow without limit. Revisit defaults against measured workloads.
MAX_QUEUE       = 4        # bounds a group chat's burst of consecutive replies
TTL_S           = 900.0    # a queued guess older than 15 min is about a message scrolled past
MAX_PREEMPTS    = 3        # livelock backstop: a user clicking steadily must not spin a job forever
IDLE_DELAY_S    = 1.0      # debounce after the last live stream closes
SPOOL_KEEP_S    = 120.0    # keep a finished spool this long for late/slow followers (= STREAM_TTL_S)
POLL_S          = 0.25     # follower wake interval while waiting on the producer
# 6.3-m4. Messages per batched pre-pass, bounded by MAX_QUEUE anyway — the satellite re-splits
# whatever it is given by free VRAM, so this is a scheduling figure and not a claim about the
# card. It also bounds `_pre`: at most this many decoded messages are held in RAM at once,
# a few MB each.
PRERENDER_BATCH = 4


def request_identity(key, cpath):
    """Identify one cache destination while keeping the public content key unchanged."""
    if not key:
        return None
    return key, os.fspath(cpath) if cpath is not None else None


def enabled_by_env() -> bool:
    return os.environ.get("VOCALIS_PRERENDER", "1").strip().lower() not in ("0", "false", "no")


def make_gate(live_stream_count, render_active=None, model_ready=None):
    """Compose the production gate from the three signals that mean 'the box is
    busy with something real'. Each is injected rather than imported: this module
    must not grow an edge into `vocalis.runtime`, and tests need to drive them.

    Returns () -> (ok: bool, reason: str). `reason` is what /prerender/stats
    reports, so a queue that never moves can be diagnosed without a debugger."""
    def gate():
        if live_stream_count is not None and live_stream_count() > 0:
            return False, "streaming"
        if render_active is not None and render_active():
            return False, "render"
        if model_ready is not None and not model_ready():
            return False, "model-cold"
        return True, "idle"
    return gate


class PrerenderJob:
    """One speculative render: its text, its spool, and whoever joined it."""

    __slots__ = ("key", "identity", "text", "gen_kwargs", "cpath", "label", "owner", "state", "error",
                 "written", "spool", "cancel", "preempts", "created", "finished_at",
                 "followers", "_cv")

    def __init__(self, key, text, gen_kwargs, cpath, label="", owner=None):
        self.key        = key
        self.identity   = request_identity(key, cpath)
        self.text       = text
        self.gen_kwargs = gen_kwargs
        self.cpath      = cpath
        self.label      = label or "sillytavern"
        # 🔴 Which speaker's slice of the cache this belongs to. Carried on the job rather than
        # re-derived at promote time: `_promote` has only the job, and without this the finished
        # spool lands in the flat legacy tree — a cache miss on the very next request for the
        # same line, and a file no per-speaker sweep will ever evict.
        self.owner      = owner
        self.state      = "queued"      # queued -> running -> done | error | canceled
        self.error      = None
        self.written    = 0             # bytes of encoded MP3 on the spool
        self.spool      = None
        self.cancel     = threading.Event()
        self.preempts   = 0
        self.created    = time.time()
        self.finished_at = None
        self.followers  = 0
        self._cv        = threading.Condition()

    # ── producer side ────────────────────────────────────────────────────────────

    def _advance(self, n_bytes):
        with self._cv:
            self.written += n_bytes
            self._cv.notify_all()

    def _finish(self, state, error=None):
        with self._cv:
            self.state, self.error = state, error
            self.finished_at = time.time()
            self._cv.notify_all()

    def reset_for_requeue(self):
        """Put a preempted job back the way it was found: a fresh cancel Event (the
        old one is set and would abort the retry instantly), no spool, no bytes."""
        self.drop_spool()
        with self._cv:
            self.state, self.error, self.written = "queued", None, 0
            self.cancel = threading.Event()
            self._cv.notify_all()

    def drop_spool(self):
        if self.spool is not None:
            try:
                self.spool.unlink(missing_ok=True)
            except OSError:
                # A follower still has it open (Windows refuses the unlink; POSIX
                # keeps the fd valid either way). The startup sweep collects it —
                # the scratch is boot-ephemeral and every name in it is opaque.
                logger.debug(f"prerender spool for {self.key[:8]}… left for the sweep")
            self.spool = None

    # ── listener side ────────────────────────────────────────────────────────────

    def follow(self):
        """Yield the spool's encoded MP3 from byte 0, then follow the producer until
        it finishes. MP3 frames are self-contained, so a reader starting at the
        beginning of a partially-written spool gets a valid progressive stream — the
        listener receives everything rendered so far at wire speed and then tracks
        the render. Ends when the producer does; never cancels it."""
        spool = self.spool
        if spool is None:
            return
        with self._cv:
            self.followers += 1
        try:
            with open(spool, "rb") as fh:
                while True:
                    block = fh.read(READ_BLOCK)
                    if block:
                        yield block
                        continue
                    with self._cv:
                        running = self.state == "running"
                        if running:
                            self._cv.wait(POLL_S)
                    if running:
                        continue
                    # Producer has stopped. One more read: bytes can land between the
                    # read above and the state check, and dropping them would truncate
                    # the tail of every joined stream.
                    block = fh.read(READ_BLOCK)
                    while block:
                        yield block
                        block = fh.read(READ_BLOCK)
                    return
        finally:
            with self._cv:
                self.followers -= 1


class PrerenderQueue:
    """The speculative-render queue: at most MAX_QUEUE waiting, exactly one running.

    current_pool — the shared pool accessor. Called ONLY once the gate says the
    model is loaded, so it never triggers a load (see the module docstring).
    """

    def __init__(self, current_pool, nomi, *, config_factory=None, gate=None,
                 enabled=None):
        self._current_pool = current_pool
        self._nomi         = nomi
        self._config       = config_factory
        self._gate         = gate if gate is not None else (lambda: (True, "idle"))
        self._enabled      = enabled_by_env() if enabled is None else enabled

        self._lock    = threading.Lock()
        self._queued  = []              # PrerenderJob, FIFO
        self._running = None            # PrerenderJob | None
        self._done    = {}              # (key, cache path) -> PrerenderJob, kept for SPOOL_KEEP_S
        self._wake    = threading.Event()
        self._stop    = threading.Event()
        self._thread  = None
        self._gate_reason = "idle"
        self._last_busy   = 0.0
        # Completed keys nobody has asked for yet. The hit rate — the number that
        # decides whether 5.2 was worth the GPU — is (hits + attached) / completed.
        self._unclaimed = set()         # request identities with completed speculative audio
        # Request identity -> decoded samples from a batched pre-pass. Keep owners separate:
        # generation is unseeded, so equal content keys do not guarantee interchangeable audio.
        self._pre = {}
        self._n = {"completed": 0, "hits": 0, "attached": 0, "preempted": 0,
                   "dropped": 0, "declined": 0, "canceled": 0, "failed": 0,
                   "batched": 0}

    # ── public API ───────────────────────────────────────────────────────────────

    def submit(self, key, text, gen_kwargs, cpath, label="", owner=None) -> str:
        """Queue a speculative render. Returns cached | queued | running | declined.
        `declined` is not an error — it means the queue is full or switched off, and
        the client simply carries on with the latency it has today."""
        if not self._enabled:
            self._bump("declined")
            return "declined"
        if cache_hit(cpath):
            return "cached"
        identity = request_identity(key, cpath)
        with self._lock:
            if self._running is not None and self._running.identity == identity:
                return "running"
            for job in self._queued:
                if job.identity == identity:
                    return "queued"
            # 🔴 9.0.17: `_done` says a job FINISHED, not that playable audio is there now.
            # The file is the authority — a promote that landed something too short to be audio
            # leaves this map saying "done" over a stub, and this branch would answer `cached`
            # after the `cache_hit` above had already declined it. Two answers about one key,
            # from one function, four lines apart.
            done = self._done.get(identity)
            if done is not None and done.state == "done" and cache_hit(done.cpath):
                return "cached"
            if len(self._queued) >= MAX_QUEUE:
                self._n["declined"] += 1
                logger.info(f"prerender {key[:8]}… declined (queue full, {MAX_QUEUE})")
                return "declined"
            self._queued.append(PrerenderJob(key, text, gen_kwargs, cpath, label, owner))
        logger.info(f"prerender {key[:8]}… queued ({len(text)} chars)")
        self._ensure_thread()
        self._wake.set()
        return "queued"

    def attach(self, key, cpath=None):
        """A click arrived for text that is already being speculated on.

        RUNNING  -> return the job; the caller follows its spool (no second render).
        QUEUED   -> drop the queued job and return None: the click needs audio now,
                    and leaving it queued would render the same text twice.
        STARTING -> the job was dequeued but has no spool yet (a window of
                    milliseconds between `_next_ready` and the first byte). Stand it
                    down and return None. There is nothing to follow yet, and the one
                    outcome that must never happen is BOTH of them rendering.
        """
        identity = request_identity(key, cpath)
        stand_down = None
        with self._lock:
            job = self._running
            if job is not None and job.identity == identity and job.state == "running":
                if job.spool is not None:
                    self._n["attached"] += 1
                    self._unclaimed.discard(identity)
                    return job
                job.preempts = MAX_PREEMPTS + 1          # canceled, never requeued
                stand_down = job
            else:
                for i, q in enumerate(self._queued):
                    if q.identity == identity:
                        del self._queued[i]
                        logger.info(f"prerender {key[:8]}… superseded by a click")
                        return None
        if stand_down is not None:
            stand_down.cancel.set()
            logger.info(f"prerender {key[:8]}… stood down (click beat its first byte)")
        return None

    def preempt(self, except_key=None, except_cpath=None) -> bool:
        """The user clicked something ELSE. Stand the speculation down: setting the
        cancel Event aborts generation mid-chunk (the pool installs it as the token
        loop's `_GEN_CANCEL.event`, so the worker frees within one step, not one
        chunk), and the job goes back on the queue to try again when the box is idle.

        After MAX_PREEMPTS it is dropped instead. Without that counter a user
        clicking steadily through old messages would restart-and-kill the same job
        forever — a livelock that looks exactly like 'the box is hot for no reason'."""
        except_identity = request_identity(except_key, except_cpath) if except_key else None
        with self._lock:
            job = self._running
            if job is None or job.identity == except_identity or job.state != "running":
                return False
            job.preempts += 1
            self._n["preempted"] += 1
        logger.info(f"prerender {job.key[:8]}… preempted by a click "
                    f"({job.preempts}/{MAX_PREEMPTS})")
        job.cancel.set()
        return True

    def cancel(self, key=None) -> int:
        """Cancel by key, or everything when key is None (chat changed). Cancels the
        running job too — its spool is discarded rather than promoted."""
        n = 0
        with self._lock:
            keep = []
            for job in self._queued:
                if key is None or job.key == key:
                    job.state = "canceled"
                    n += 1
                else:
                    keep.append(job)
            self._queued = keep
            running = self._running
            if running is not None and (key is None or running.key == key):
                running.preempts = MAX_PREEMPTS + 1     # canceled, never requeued
                n += 1
            else:
                running = None
            self._n["canceled"] += n
        if running is not None:
            running.cancel.set()
        if n:
            logger.info(f"prerender canceled {n} job(s)"
                        + (f" for {key[:8]}…" if key else " (all)"))
        return n

    def note_claim(self, key, attached=False, cpath=None):
        """A foreground register found this key in the cache. Counts as a hit only if
        a PRE-RENDER put it there — an ordinary replay of an ordinary render is not
        evidence of anything and must not inflate the hit rate."""
        identity = request_identity(key, cpath)
        with self._lock:
            if identity in self._unclaimed:
                self._unclaimed.discard(identity)
                self._n["attached" if attached else "hits"] += 1

    def state_of(self, key, cpath=None):
        """What this queue has for `key`, WITHOUT starting anything (5.4).

        The read-only twin of `submit`, and it tests the same conditions in the same order
        for the same reason: if the two ever disagree, the button reports one thing and the
        click does another. Returns `(state, detail)`:

            playable  — running, and the buffer governor has released audio
            rendering — running, still withholding
            queued    — waiting for the gate ("2 ahead" in `detail`)
            cached    — finished and promoted, within SPOOL_KEEP_S of finishing
            None      — this queue has nothing; the CALLER still has to ask the cache,
                        which is the authority (`_done` is a 2-minute window over it)

        🔴 `written > 0` is not a byte count standing in for progress — it IS the governor's
        release decision. `stream_message` withholds every window until `required_buffer_s`
        is met, and a pre-render runs through that same path with the same StreamConfig, so
        the first byte to reach a spool is one the governor has already cleared by the same
        rule a live click gets. Anything else here would be a second opinion that can only
        drift from what playback actually does. DESIGN_5_4_BUTTON_STATE §3.1.

        Never counts as a claim: `note_claim` is NOT called. A probe is not a click, and
        letting polling touch the hit rate would drive (hits + attached) / completed toward
        100% on a chat nobody listened to — the exact number 5.2 exists to measure.
        """
        identity = request_identity(key, cpath)
        with self._lock:
            job = self._running
            if job is not None and job.identity == identity and job.state == "running":
                return ("playable" if job.written > 0 else "rendering"), None
            for i, q in enumerate(self._queued):
                if q.identity == identity:
                    return "queued", (f"{i} ahead" if i else "next")
            done = self._done.get(identity)
            if done is not None and done.state == "done" and cache_hit(done.cpath):
                return "cached", None            # …and the file has to still be playable
        return None, None

    def queued_count(self) -> int:
        with self._lock:
            return len(self._queued)

    def stats(self) -> dict:
        with self._lock:
            running = self._running
            return {"enabled": self._enabled,
                    "queued": len(self._queued),
                    "running": running.key[:8] if running is not None else None,
                    "gate": self._gate_reason,
                    "unclaimed": len(self._unclaimed),
                    **self._n}

    def stop(self):
        """Stop the dispatcher and any running producer (server shutdown / tests)."""
        self._stop.set()
        self._wake.set()
        with self._lock:
            job = self._running
        if job is not None:
            job.cancel.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)

    # ── dispatcher ───────────────────────────────────────────────────────────────

    def _bump(self, name):
        with self._lock:
            self._n[name] += 1

    def _ensure_thread(self):
        if self._thread is not None and self._thread.is_alive():
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._loop, name="prerender",
                                            daemon=True)
            self._thread.start()

    def _loop(self):
        while not self._stop.is_set():
            # 🔴 Guarded for the same reason `_produce` is, and it was NOT. The gate is three
            # injected callables owned by other modules; `_next_ready` calls them a second, and
            # anything they raise used to escape this loop and retire pre-rendering silently for
            # the life of the process — every other feature carrying on, the queue simply never
            # moving again. Sweeping is the caller of `drop_spool`, so it touches the filesystem
            # and is no safer. Nothing in here is worth a dead dispatcher.
            try:
                self._sweep()
                job = self._next_ready()
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException:                # noqa: BLE001 — VaultAuthError is not Exception
                logger.exception("prerender dispatcher failed — skipping this pass")
                job = None
            if job is None:
                self._wake.wait(1.0)
                self._wake.clear()
                continue
            try:
                self._produce(job)
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:         # noqa: BLE001 — a bad guess must never
                # BaseException, not Exception, and that is the whole point: VaultAuthError
                # deliberately does NOT inherit from Exception (vault.py says so in capitals),
                # so `except Exception` here would let a mid-render vault lock escape and kill
                # this thread — silently retiring pre-rendering for the life of the process
                # while every other feature carried on working.
                logger.exception("prerender producer failed")
                job._finish("error", str(exc) or exc.__class__.__name__)
                job.drop_spool()
                self._bump("failed")
            finally:
                with self._lock:
                    self._running = None

    def _next_ready(self):
        """The next job to produce, or None. Drops expired jobs, applies the gate,
        and takes ownership of the chosen job (`_running`) under the lock."""
        now = time.time()
        ok, reason = self._gate()
        with self._lock:
            self._gate_reason = reason
            if not ok:
                self._last_busy = now
            expired = [j for j in self._queued if now - j.created > TTL_S]
            if expired:
                self._queued = [j for j in self._queued if now - j.created <= TTL_S]
                self._n["dropped"] += len(expired)
                for j in expired:
                    logger.info(f"prerender {j.key[:8]}… dropped (stale, "
                                f"gate={reason})")
            if not ok or self._running is not None or not self._queued:
                return None
            if now - self._last_busy < IDLE_DELAY_S:
                return None
            job = self._queued.pop(0)
            job.state = "running"
            self._running = job
            logger.info(f"prerender {job.key[:8]}… starting (gate={reason})")
            return job

    def _sweep(self):
        """Retire finished spools once nobody is reading them. A crash instead leaves
        them to `scratch.sweep()` at startup — the scratch is boot-ephemeral and
        every name in it is opaque, so an orphan is inert either way."""
        now = time.time()
        with self._lock:
            stale = [k for k, j in self._done.items()
                     if j.followers <= 0 and j.finished_at is not None
                     and now - j.finished_at > SPOOL_KEEP_S]
            jobs = [self._done.pop(k) for k in stale]
            # Samples from a batched pre-pass whose job is no longer going to ask for them —
            # canceled, superseded by a click, or aged out. One place rather than a release
            # at each of those call sites, because a missed one leaks megabytes silently and
            # nothing would ever report it. `_next_ready` moves a job from `_queued` to
            # `_running` under this same lock, so there is no window where a live job is in
            # neither and its audio gets swept out from under it.
            if self._pre:
                live = {j.identity for j in self._queued}
                if self._running is not None:
                    live.add(self._running.identity)
                for k in [k for k in self._pre if k not in live]:
                    del self._pre[k]
        for j in jobs:
            j.drop_spool()

    def _produce(self, job):
        """Render one job to its spool, then promote a copy into the speech cache."""
        from tts_utils import GenParams
        pool = self._current_pool()
        params = GenParams(**job.gen_kwargs)
        config = self._config() if self._config is not None else None

        # 🔴 BEFORE THE SPOOL EXISTS, and that ordering is the whole safety argument for
        # batching here. `attach` follows a running job only once `job.spool` is set; while the
        # pre-pass is in flight it is still None, so a click landing on THIS job is stood down
        # and rendered live on the low-latency streaming path instead of waiting out a
        # submission that returns nothing until all of it lands. Create the spool first and a
        # click would attach to an empty file and sit there.
        samples = self._prebatch(pool, job, params)

        root = scratch.scratch_root()
        job.spool = root / scratch.opaque_name(
            f"prerender|{job.key}|{uuid.uuid4().hex}", ".mp3")
        job.spool.parent.mkdir(parents=True, exist_ok=True)

        # `make_stream` is Mp3Render's own hook for "the samples came from somewhere else".
        # The encode, the `promotable` rule, the governor and the failure handling all stay
        # exactly as they are — only where the audio comes from changes.
        make = None if samples is None else (lambda _p, _c, _cfg, _w=samples: iter([_w]))
        # Enable speech caps for speculative renders because a click can attach to the spool once it exists. A formed batch cannot be narrowed after attachment.
        # The pre-pass remains uncapped because it runs before the spool exists; clicks during that phase use the normal capped live path. When `make_stream` supplies precomputed samples, the speech-cap flag does not change them.
        render = Mp3Render(pool, job.text, params, cancel=job.cancel, config=config,
                           label=f"prerender {job.key[:8]}", make_stream=make, st_speech=True)
        t0 = time.time()
        render.start()
        try:
            with open(job.spool, "wb") as fh:
                for block in render.blocks():
                    fh.write(block)
                    fh.flush()               # a follower can only read what has landed
                    job._advance(len(block))
        finally:
            render.close()

        if render.promotable:
            self._promote(job, render.audio_s, time.time() - t0)
        else:
            job._finish(render.state, render.error)
            if render.state == "error":
                self._bump("failed")
            self._requeue_or_drop(job)

    def _prebatch(self, pool, job, params):
        """This job's samples, rendered in ONE submission alongside the queued guesses behind
        it that share its voice. Returns None to mean "render it the ordinary way".

        🔴 WHY: the queue was collecting almost none of 6.2's batching. Each guess went through
        `Mp3Render` -> `stream_message`, the low-latency STREAMING path, whose first chunk is a
        `_StreamJob` — and `WorkerPool._worker_loop` excludes those from batching by design. So
        a guess could only ever batch chunks 2..n OF ITSELF: three chunks batched two, and a
        one-chunk guess batched nothing at all. Flattening several guesses into one submission
        is what lifts it, and it is the same fix, and the same helper, as a scene build's.

        Streaming was the right call for a live click and it is the wrong one here for the same
        reason it was wrong for scene builds: **nobody is listening to a guess yet.** The
        latency streaming buys is spent on an audience that does not exist, and paid for in the
        throughput that decides whether the queue keeps up with the reader at all.

        Grouped by identical `gen_kwargs` because a batch is one voice — `_Batch` carries
        `params` and `_drain_batch_mates` refuses a job whose batch differs, so a group chat
        with two characters simply makes two submissions.

        ⚠️ Cancellation is the JOB's, so a preempt aborts the whole pass within one decode step
        exactly as it does today. The mates were never dequeued, so they stay queued and are
        retried; only the partial decode is lost, which is the one real cost of batching here.
        """
        from tts_utils import render_messages_in_one_batch

        with self._lock:
            ready = self._pre.pop(job.identity, None)
            if ready is not None:
                return ready                        # an earlier pre-pass already rendered it
            mates = [j for j in self._queued
                     if j.gen_kwargs == job.gen_kwargs][:PRERENDER_BATCH - 1]
        if not mates:
            return None                             # nothing to batch WITH — ordinary path
        group = [job] + mates
        try:
            wavs = render_messages_in_one_batch(pool, [j.text for j in group], params,
                                                cancel=job.cancel)
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:                # noqa: BLE001 — VaultAuthError is not Exception
            # A failed submission is not a failed GUESS. Returning None puts this job back on
            # the ordinary per-message path, which is slower and works; the mates are untouched
            # and still queued. Re-raising would take the dispatcher's whole pass down.
            logger.warning(f"prerender: batched pre-pass failed ({exc}) — one at a time")
            return None
        with self._lock:
            for mate, wav in zip(group[1:], wavs[1:]):
                if wav is not None:
                    self._pre[mate.identity] = wav
            got = sum(1 for w in wavs if w is not None)
            self._n["batched"] += got
        # No text, no character name — this fires as often as the `cached` line below, which is
        # the one that learned that lesson.
        logger.info(f"prerender batched {got}/{len(group)} guess(es) in one submission")
        return wavs[0]

    def _promote(self, job, audio_s, wall_s):
        """Bring the finished spool into the MD5 cache through the cipher. A COPY is
        promoted, not the spool itself: `promote_temp` unlinks what it is given, and
        a follower may still be reading. One extra copy of a few hundred KB."""
        copy = job.spool.parent / scratch.opaque_name(
            f"prerender-promote|{job.key}|{uuid.uuid4().hex}", ".mp3")
        try:
            shutil.copyfile(job.spool, copy)
            self._nomi.promote_temp(copy, job.key, job.owner)   # unlinks `copy`
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:                    # noqa: BLE001
            # BaseException catches VaultAuthError too (it is not an Exception, by
            # design). A guess that cannot be filed is not a reason to take anything
            # down: nothing is deleted, the scratch copy goes, the queue lives on.
            logger.exception("prerender cache promote failed")
            copy.unlink(missing_ok=True)
            job._finish("error", str(exc) or exc.__class__.__name__)
            self._bump("failed")
            return
        with self._lock:
            self._n["completed"] += 1
            self._unclaimed.add(job.identity)
            self._done[job.identity] = job
        job._finish("done")
        # No text preview and no character name — this fires more often than the
        # register line that learned that lesson (vocalis_stream_http, 5.0).
        logger.info(f"prerender {job.key[:8]}… cached ({audio_s:.1f}s audio in "
                    f"{wall_s:.1f}s)")

    def _requeue_or_drop(self, job):
        """A preempted job tries again when the box is idle; a canceled one does not,
        and neither does one that has been preempted too often."""
        if job.preempts and job.preempts <= MAX_PREEMPTS:
            job.reset_for_requeue()
            with self._lock:
                if len(self._queued) < MAX_QUEUE:
                    self._queued.append(job)
                    self._wake.set()
                    return
                self._n["dropped"] += 1
            logger.info(f"prerender {job.key[:8]}… dropped (queue full on requeue)")
            return
        job.drop_spool()
        if job.preempts > MAX_PREEMPTS:
            self._bump("dropped")
            logger.info(f"prerender {job.key[:8]}… dropped after {job.preempts} preemption(s)")
