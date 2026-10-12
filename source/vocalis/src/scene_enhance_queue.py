"""Persist the ordered scene-enhancement queue on the server and start work as cards become available. Reuse the single-scene start path. Retry transient busy or locked-vault conditions; remove terminal failures while retaining their reasons for display. A non-blocking pump guard prevents concurrent callers from assigning the same free card."""
from __future__ import annotations

import threading
import weakref
from pathlib import Path
from typing import Callable

from loguru import logger

import scene_enhance

#: How long to wait before re-offering the head of the queue to a box whose cards are busy.
#: Moved here from the page (`SC_ENH_RETRY_MS`), with its reasoning: an enhancement is minutes and
#: the blocking work (a render, a training) is minutes to hours, so polling faster buys nothing and
#: writes a log line each time. 30 s is slow enough to be invisible and fast enough that a card
#: freeing at 3am is picked up before morning.
RETRY_S = 30.0
#: A queue longer than this is a bug in whatever sent it, not an evening of work.
MAX_QUEUE = 500

# Outcomes of one start attempt, as `classify` reports them.
STARTED, RUNNING, WAIT, REFUSED = "started", "running", "wait", "refused"

# Every live queue, so a finishing job can wake whichever one started it without holding a strong
# reference that keeps a test's queue (and its tmp path) alive for the rest of the run.
_LIVE: "weakref.WeakSet[EnhanceQueue]" = weakref.WeakSet()
#: The queue the running app built — `vocalis_server.main()` boots it after an unlock.
CURRENT: "EnhanceQueue | None" = None


def classify(body: dict, code: int) -> tuple[str, str]:
    """Turn the start route's `(body, code)` into `(outcome, detail)`.

    `detail` is the job id for STARTED/RUNNING, and the sentence for WAIT/REFUSED.
    """
    err = body.get("error") if isinstance(body, dict) else None
    if code == 202:
        return STARTED, str(body.get("job_id") or "")
    if code == 409 and isinstance(err, dict) and err.get("job_id"):
        # "this scene is already being enhanced" — not a failure, the job is simply running.
        return RUNNING, str(err["job_id"])
    if code == 409 and body.get("busy"):
        return WAIT, str(err or "every card is busy")
    if code >= 500:
        return WAIT, str(err or "the server could not start it")
    msg = err.get("message") if isinstance(err, dict) else err
    if code == 404 and not msg:
        msg = "that scene is no longer there"
    return REFUSED, str(msg or "the request was refused")


class EnhanceQueue:
    """The waiting scenes, and the pump that starts them. Thread-safe; see the module docstring."""

    def __init__(self, path, try_start: Callable[[str], tuple[dict, int]], *,
                 cards: Callable[[], int] = lambda: 1, retry_s: float = RETRY_S):
        # 🔴 A PATH OR A CALLABLE THAT RETURNS ONE, RESOLVED ON EVERY USE. `vocalis_server` builds
        # its app ONCE, at import, so a path captured here is whatever `paths.SCENE_ENHANCE_QUEUE`
        # was at that instant — the real install's file, or the first test's tmp dir — for the
        # rest of the process. In the suite that leaked one test's fourteen queued scenes into the
        # next test's Clips tab (the strip grew and pushed its Chapters button off screen). The web
        # layer passes `lambda: paths.SCENE_ENHANCE_QUEUE`; see `ensure_loaded` for the reset.
        self._path_fn = path if callable(path) else (lambda p=Path(path): p)
        self._loaded_from: Path | None = None
        self._try_start = try_start
        self._cards = cards
        self.retry_s = retry_s
        # Serialize the disk read and publication as one initialization step. Without this,
        # concurrent first callers can both read the old file; a Clear or Remove can then save
        # the updated queue before the first reader publishes its stale snapshot over it.
        self._load_lock = threading.Lock()
        self._lock = threading.Lock()
        self._pumping = threading.Lock()
        self._again = False
        self._wake = threading.Event()
        self._worker: threading.Thread | None = None
        self._loaded = False
        self.queue: list[str] = []
        self.starting: set[str] = set()
        self.failed: dict[str, str] = {}
        self.wait = ""
        self.done = 0
        self._mine: dict[str, str] = {}          # job id → ref, for jobs this queue started
        #: Refs taken out (✕, Clear, Stop everything) WHILE their start was in flight. The start
        #: route spends up to seconds measuring before it registers a job, so a withdrawal in that
        #: window cannot cancel anything yet; the pump cancels the job the moment it appears.
        self._withdrawn: set[str] = set()
        _LIVE.add(self)

    # ── persistence ─────────────────────────────────────────────────────────────────────────

    @property
    def path(self) -> Path:
        return Path(self._path_fn())

    def ensure_loaded(self) -> bool:
        """Read the saved queue once. False while the vault is locked — the caller retries.

        ⚠️ "Once" is once PER FILE: if the path now resolves somewhere else, everything held in
        memory described the old file and is dropped before the new one is read. In production the
        path never moves; in the suite it moves with every test, and this is what keeps the one
        import-time app from carrying one test's queue into the next.
        """
        with self._load_lock:
            path = self.path
            if self._loaded and path == self._loaded_from:
                return True
            if self._loaded:
                with self._lock:
                    self.queue, self.failed, self._mine = [], {}, {}
                    self.starting, self._withdrawn = set(), set()
                    self.wait, self.done, self._loaded = "", 0, False
            import yaml

            import vault_fs
            try:
                data = yaml.safe_load(vault_fs.read_text(path)) if vault_fs.exists(path) else []
            except vault_fs.locked_exc():
                return False
            except (yaml.YAMLError, OSError, UnicodeDecodeError) as exc:
                # A damaged file is not a reason to refuse every enhancement; start empty and say so.
                logger.error(f"enhance queue: {path.name} is unreadable ({type(exc).__name__}) "
                             f"— starting with an empty queue")
                data = []
            if not isinstance(data, list):       # a hand-edited or foreign file
                data = []
            refs = [r for r in data if isinstance(r, str) and r][:MAX_QUEUE]
            with self._lock:
                # Anything added while we were locked goes AFTER what was saved — it was asked later.
                self.queue = refs + [r for r in self.queue if r not in refs]
                self._loaded = True
                self._loaded_from = path
        if refs:
            logger.info(f"enhance queue: restored {len(refs)} waiting scene(s) from disk")
        return True

    def _save_locked(self) -> None:
        """Caller holds `_lock`. A failed write is logged, never raised into a request."""
        import yaml

        import vault_fs
        try:
            vault_fs.write_yaml_atomic(self.path, list(self.queue))
        except vault_fs.locked_exc():
            logger.warning("enhance queue: vault locked — change held in memory, not saved")
        except (OSError, yaml.YAMLError) as exc:
            logger.error(f"enhance queue: could not save {self.path.name} ({type(exc).__name__})")

    # ── what the Clips tab reads and changes ────────────────────────────────────────────────

    def snapshot(self) -> dict:
        self.ensure_loaded()
        with self._lock:
            return {"queue": list(self.queue), "starting": sorted(self.starting),
                    "failed": dict(self.failed), "wait": self.wait, "done": self.done,
                    "limit": max(1, int(self._cards() or 1))}

    def add(self, refs) -> list[str]:
        """Append refs not already waiting or running. Returns the ones actually added."""
        self.ensure_loaded()
        added = []
        with self._lock:
            # A new BATCH begins when nothing is waiting and nothing of ours is running, so "3 done"
            # always counts the run being watched (the page's 9.2.1 rule, moved here).
            if not self.queue and not self._mine and not self.starting:
                self.done = 0
                self.failed.clear()
            for r in refs:
                r = str(r)
                if (r in self.queue or len(self.queue) >= MAX_QUEUE
                        or scene_enhance.running_for(r) is not None):
                    continue
                self.failed.pop(r, None)
                self.queue.append(r)
                added.append(r)
            if added:
                self._save_locked()
        if added:
            logger.info(f"enhance queue: +{len(added)} → {len(self.queue)} waiting")
            self.kick()
        return added

    def remove(self, ref: str) -> bool:
        self.ensure_loaded()
        with self._lock:
            if ref not in self.queue:
                return False
            self.queue.remove(ref)
            if ref in self.starting:
                self._withdrawn.add(ref)
            if not self.queue:
                self.wait = ""
            self._save_locked()
        logger.info(f"enhance queue: removed one → {len(self.queue)} waiting")
        return True

    def clear(self) -> int:
        self.ensure_loaded()
        with self._lock:
            n = len(self.queue)
            self._withdrawn |= self.starting & set(self.queue)
            self.queue = []
            self.wait = ""
            self._save_locked()
        logger.info(f"enhance queue: cleared {n} waiting")
        return n

    def move(self, ref: str, before: str | None) -> bool:
        """Put `ref` immediately before `before`, or at the end when that is None/unknown.

        Stated as "before which ref", never as an index — the page's 9.5.6 rule: an index computed
        against the visible list is off by one the moment the moved row is spliced out of it.
        """
        self.ensure_loaded()
        with self._lock:
            if ref == before or ref not in self.queue:
                return False
            rest = [r for r in self.queue if r != ref]
            at = rest.index(before) if before in rest else len(rest)
            rest.insert(at, ref)
            if rest == self.queue:
                return False
            self.queue = rest
            self._save_locked()
        return True

    def stop_all(self) -> int:
        """Empty the queue, THEN cancel every running scene enhancement — in that order, so the
        pump cannot refill the card a cancel has just freed. Returns how many were canceled."""
        self.clear()
        with scene_enhance.JOBS_LOCK:
            live = [j for j in scene_enhance.JOBS.values() if j.status in scene_enhance.ACTIVE]
        for j in live:
            j.cancel.set()
        logger.info(f"enhance queue: stop everything — canceled {len(live)} running")
        return len(live)

    # ── the pump ────────────────────────────────────────────────────────────────────────────

    def pump(self) -> None:
        """One pass: offer the head of the queue to the box until a card refuses. Safe anytime."""
        if not self._pumping.acquire(blocking=False):
            self._again = True
            return
        try:
            while True:
                self._again = False
                self._pass()
                if not self._again:
                    break
        finally:
            self._pumping.release()

    def _pass(self) -> None:
        if not self.ensure_loaded():
            with self._lock:
                self.wait = "Vocalis is locked — log in and the queue carries on"
            return
        with self._lock:
            candidates = [r for r in self.queue if r not in self.starting]
        for ref in candidates:
            with self._lock:
                if ref not in self.queue:          # taken out while an earlier start ran
                    continue
                self.starting.add(ref)
            try:
                body, code = self._try_start(ref)
                outcome, detail = classify(body, code)
            except Exception as exc:               # noqa: BLE001 — never kill the worker
                import vault_fs
                if isinstance(exc, vault_fs.locked_exc()):
                    outcome, detail = WAIT, "Vocalis is locked — log in and the queue carries on"
                else:
                    logger.exception(f"enhance queue: starting {ref} raised {type(exc).__name__}")
                    outcome, detail = WAIT, f"the server hit an error ({type(exc).__name__})"
            finally:
                with self._lock:
                    self.starting.discard(ref)
            with self._lock:
                withdrawn = ref in self._withdrawn
                self._withdrawn.discard(ref)
                if withdrawn:
                    # 🔴 TAKEN OUT WHILE IT WAS STARTING. Stop everything, Clear or ✕ arrived while
                    # the route was still measuring, so there was no job to cancel then. There is
                    # now: cancel it before it spends twenty minutes of a card nobody wants.
                    if outcome == STARTED:
                        job = scene_enhance.JOBS.get(detail)
                        if job is not None:
                            job.cancel.set()
                        logger.info(f"enhance queue: {ref} was withdrawn while starting — canceled")
                    self._save_locked()
                    continue
                if outcome == WAIT:
                    self.wait = f"{detail} — retrying every {int(self.retry_s)}s"
                    logger.info(f"enhance queue: waiting — {detail}")
                    return
                if ref in self.queue:
                    self.queue.remove(ref)
                self.wait = ""
                if outcome == STARTED:
                    job = scene_enhance.JOBS.get(detail)
                    if job is not None and job.status not in scene_enhance.ACTIVE:
                        # It already finished — a fast failure's hook ran before we got here and
                        # found nothing to count. Count it now instead of waiting on it for ever.
                        self._settle_locked(detail, ref, job)
                    else:
                        self._mine[detail] = ref
                elif outcome == REFUSED:
                    self.failed[ref] = detail
                self._save_locked()
            logger.info(f"enhance queue: {outcome} — {len(self.queue)} still waiting"
                        + (f" ({detail})" if outcome == REFUSED else ""))

    def _settle_locked(self, job_id: str, ref: str, job) -> None:
        """Caller holds `_lock`. Count one terminal job of ours exactly once — every path that
        learns a job ended (the finish hook, the pump, the worker's sweep) comes through here, and
        popping `_mine` first is what makes a second arrival a no-op."""
        self._mine.pop(job_id, None)
        if job is not None and job.status == "done":
            self.done += 1
        elif job is not None and job.status == "failed":
            self.failed[ref] = job.error or "something went wrong"

    def job_finished(self, job) -> None:
        """`scene_enhance`'s finish hook: count it, keep a failure's reason, and fill the card."""
        with self._lock:
            ref = self._mine.get(job.id)
            if ref is not None:
                self._settle_locked(job.id, ref, job)
            waiting = bool(self.queue)
        # A card just came free. Even a job the worker's sweep already settled (it can see the
        # terminal status a moment before this hook runs, while the card is still held) must wake
        # the queue here — otherwise the next scene waits out the 30 s retry for a card that is
        # sitting idle.
        if ref is not None or waiting:
            self.kick()

    # ── the worker ──────────────────────────────────────────────────────────────────────────

    def kick(self) -> None:
        """Pump now, on the worker; start the worker if it is not running."""
        self._wake.set()
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(target=self._run, daemon=True,
                                            name="scene-enhance-queue")
            self._worker.start()

    def _run(self) -> None:
        try:
            self._loop()
        except BaseException:
            # A `VaultAuthError` (a BaseException by design) or anything else that escaped the
            # pump. Log it and let go of the slot, so the next change starts a fresh worker instead
            # of finding a dead one it believes is alive.
            logger.exception("enhance queue: the worker died")
            with self._lock:
                if self._worker is threading.current_thread():
                    self._worker = None
            raise

    def _loop(self) -> None:
        while True:
            self._wake.clear()
            self.pump()
            # A job of ours that ended without its finish reaching us — pruned from the registry,
            # never registered, or finished in the gap before the pump recorded it — can never
            # report back, and waiting for it would keep this thread alive for the life of the
            # process. Settle every one that is no longer ACTIVE; `_settle_locked` counts each
            # exactly once, so racing the finish hook here cannot double a `done`.
            with scene_enhance.JOBS_LOCK:
                jobs = dict(scene_enhance.JOBS)
            with self._lock:
                for jid, ref in list(self._mine.items()):
                    job = jobs.get(jid)
                    if job is None or job.status not in scene_enhance.ACTIVE:
                        self._settle_locked(jid, ref, job)
                idle = not self.queue and not self._mine and self._loaded
                # 🔴 DETACH UNDER THE SAME LOCK THAT DECIDED "IDLE". `kick()` starts a worker only
                # when none is alive, and this thread is still alive for a moment after it decides
                # to leave — so an `add` landing in that gap saw a live worker, started nothing,
                # and its scene sat in the queue until the next add. Clearing `_worker` here means
                # that `add` finds no worker and starts a fresh one.
                if idle:
                    self._worker = None
            if idle:
                logger.info(f"enhance queue: empty — worker stopping (done {self.done})")
                return
            # Waiting on a busy card, a locked vault, or a job of ours still running: a finish or
            # a change wakes us early; otherwise try again after `retry_s`.
            self._wake.wait(self.retry_s)


def _on_job_finish(job) -> None:
    for q in list(_LIVE):
        q.job_finished(job)


scene_enhance.ON_FINISH.append(_on_job_finish)


def boot() -> None:
    """Called once by `vocalis_server.main()`: resume a queue saved before the last restart.

    The saved file is in the vault, and the vault is locked until someone logs in, so this just
    starts the worker — its first pass finds the file unreadable, says so on the strip, and tries
    again every `RETRY_S` until the login makes it readable.
    """
    q = CURRENT
    if q is None:
        return
    import vault_fs
    try:
        pending = vault_fs.exists(q.path)
    except (OSError, vault_fs.locked_exc()):
        # Locked (the usual case right after a restart): we cannot even tell whether a queue was
        # saved, so assume one was — the worker's first pass will find out once someone logs in.
        pending = True
    if pending:
        logger.info("enhance queue: a saved queue exists — resuming once the vault is unlocked")
        q.kick()
