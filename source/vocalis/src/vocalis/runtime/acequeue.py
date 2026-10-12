"""Schedule accepted ACE-Step jobs FIFO across available backends.

Only one job may run per backend. Pending jobs can be removed exactly;
submitted generations cannot be interrupted. Dispatch runs outside the queue lock,
and worker completion releases its slot before pumping the next eligible job.
"""
import threading

from loguru import logger


class AceQueue:
    """One instance per process, holding every ACE-Step job Vocalis has accepted.

    A single lock protects pending and in-flight state. Dispatch runs without the
    lock; `done()` releases a slot on every worker outcome.
    """

    def __init__(self, dispatch, backends=None, can_run=None):
        self._dispatch = dispatch
        #: `can_run(job_id, device, url) -> bool`, or None for "any card takes any job". Called
        #: UNDER the lock, so it must not block — the caller's implementation reads cached maps
        #: only. A raise is treated as "yes" rather than wedging the pump: the downstream failure
        #: is one wasted render, the upstream one is a queue that never drains.
        self._can_run = can_run
        #: Fresh backend list provider used after each worker completion.
        self._backends = backends
        self._lock = threading.Lock()
        self._pending = []          # [job_id] in submission order — FIFO, no priorities
        self._inflight = {}         # device -> job_id

    # ── the queue's shape, for the UI ────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        """What the tab renders. Taken under the lock so a caller never sees a job counted
        twice — mid-`pump` a job is momentarily in neither list, and a torn read there would
        make it vanish from the UI for one poll."""
        with self._lock:
            return {"pending": list(self._pending), "inflight": dict(self._inflight)}

    def position(self, job_id: str):
        """1-based place in the queue, or None if it is running or unknown. The number the row
        shows, and it is Vocalis's own — never ACE-Step's `queue_position`, which describes a
        queue we deliberately keep empty."""
        with self._lock:
            return self._pending.index(job_id) + 1 if job_id in self._pending else None

    # ── in ──────────────────────────────────────────────────────────────────────────────
    def enqueue(self, job_id: str, backends) -> None:
        """Accept a job and start it if a backend is free."""
        with self._lock:
            if job_id in self._pending or job_id in self._inflight.values():
                return                              # idempotent: a double-submit is one job
            self._pending.append(job_id)
        self.pump(backends)

    def claim(self, job_id: str, device: str) -> bool:
        """Reserve a backend for a render that survived a Vocalis restart. Return False if the device is already tracked."""
        with self._lock:
            if device in self._inflight:
                return False
            if job_id in self._pending:
                self._pending.remove(job_id)
            self._inflight[device] = job_id
            return True

    def pump(self, backends) -> None:
        """Fill idle backends with the oldest eligible pending job.

        `backends` is recomputed by the caller so device changes are reflected. Dispatch
        runs after releasing the queue lock.
        """
        while True:
            with self._lock:
                free = [(u, d) for _s, u, d in backends if d not in self._inflight]
                if not free or not self._pending:
                    return
                # Skip jobs that only a busy backend can run; retain FIFO among
                # jobs eligible for each free backend.
                picked = None
                for url, device in free:
                    for job_id in self._pending:
                        if self._ok(job_id, device, url):
                            picked = (job_id, device, url)
                            break
                    if picked:
                        break
                if picked is None:
                    return                      # jobs exist, but no free card can run any of them
                job_id, device, url = picked
                self._pending.remove(job_id)
                self._inflight[device] = job_id
            try:
                self._dispatch(job_id, device, url)
            except Exception as e:                  # noqa: BLE001 — a dispatch that throws must
                logger.error(f"acestep dispatch {job_id} on {device}: {e}")   # not wedge the slot
                # The pump loop advances after freeing this slot.
                self.release(job_id)

    def _ok(self, job_id: str, device: str, url: str) -> bool:
        """Apply the optional scheduling gate. Treat gate errors as eligible to avoid stalling the queue."""
        if self._can_run is None:
            return True
        try:
            return bool(self._can_run(job_id, device, url))
        except Exception as e:          # noqa: BLE001 — see the docstring
            logger.warning(f"acestep queue can_run({job_id}, {device}): {e}")
            return True

    # ── out ─────────────────────────────────────────────────────────────────────────────
    def release(self, job_id: str) -> None:
        """Free a job’s backend slot without starting more work. Use from dispatch paths; `done()` is for completed workers."""
        with self._lock:
            for device, held in list(self._inflight.items()):
                if held == job_id:
                    del self._inflight[device]

    def done(self, job_id: str) -> None:
        """Release the completed job and pump the next eligible job.

        Call from a worker’s `finally` path regardless of success, failure, or cancellation.
        """
        self.release(job_id)
        if self._backends is None:
            return
        try:
            backends = self._backends()
        except Exception as e:      # noqa: BLE001 — a settings read that throws must not strand
            logger.error(f"acestep queue could not list backends after {job_id}: {e}")
            return                  # the slot is already free; the next enqueue will pump
        self.pump(backends)

    def remove(self, job_id: str) -> bool:
        """Remove a pending job that has not been submitted. Return False for jobs already in flight."""
        with self._lock:
            if job_id in self._pending:
                self._pending.remove(job_id)
                return True
            return False

    def defer(self, job_id: str) -> None:
        """Return a not-yet-submitted dispatch to the queue without pumping during shutdown."""
        with self._lock:
            for device, held in list(self._inflight.items()):
                if held == job_id:
                    del self._inflight[device]
            if job_id not in self._pending:
                self._pending.insert(0, job_id)

    def device_of(self, job_id: str):
        """Which card is running this job, or None if it is queued. What the UI needs to say
        *which* song a Stop would lose."""
        with self._lock:
            for device, held in self._inflight.items():
                if held == job_id:
                    return device
            return None
