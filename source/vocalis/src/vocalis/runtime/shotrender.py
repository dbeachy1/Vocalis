"""Schedule video rendering one shot at a time.

Segments within a shot are sequential because each consumes the prior segment's latent state;
independent shots may run on separate cards. The queue accepts an injected dispatcher so its
scheduling contract can be tested without a renderer or GPU.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field as dc_field
from typing import Callable

from loguru import logger

from .gpu import GPUS

#: A shot is rendered as N segments of this length. LongCat's window; the number of segments for a
#: shot is derived from its length, never stored — the same rule as `Shot.length` itself.
SEGMENT_S = 5.0

#: 📌 NO WALL-CLOCK ESTIMATE IS DERIVED FROM THIS. The source document's "90-175 s of compute per
#: second of output" is a RANGE from someone else's hardware, and this release has refused three
#: times to put an unmeasured duration on screen. The segment count is exact; the time is not.
MAX_SEGMENTS = 400


class RenderRefused(RuntimeError):
    """The render cannot start, and why. A refused start must never look like a started one."""


class RenderNotAvailable(RuntimeError):
    """There is no renderer on this host.

    ⚠️ Distinct from `RenderRefused`, which is about the QUEUE's state (already running, no
    length) and resolves on its own. This one is about the BOX, and no amount of waiting fixes it.
    Collapsing them would make "LongCat is not installed" look like "try again in a minute".
    """


def segments_for(length_s: float, segment_s: float = SEGMENT_S) -> int:
    """How many segments a shot of this length needs.

    ⚠️ **CEILING, NOT ROUND.** A 12-second shot at a 5-second window is three segments, not two: a
    round would silently drop the last two seconds of every shot whose length is not a multiple of
    the window, and the loss lands at the END of the shot where it reads as a cut that comes early.
    """
    if length_s <= 0 or segment_s <= 0:
        return 0
    n = int(length_s / segment_s)
    if n * segment_s < length_s - 1e-9:
        n += 1
    return min(MAX_SEGMENTS, n)


@dataclass
class RenderJob:
    """One SHOT. Never a segment — see the module docstring."""
    id: str
    production_id: str
    shot_id: str
    index: int
    length_s: float
    device: str = ""
    #: Segments completed so far. The unit of progress, because a shot is one job.
    done: int = 0
    total: int = 0
    state: str = "queued"        # queued | running | done | failed | canceled
    error: str = ""
    started: float = 0.0
    finished: float = 0.0

    def as_dict(self) -> dict:
        return {"id": self.id, "production_id": self.production_id, "shot_id": self.shot_id,
                "index": self.index, "length_s": self.length_s, "device": self.device,
                "done": self.done, "total": self.total, "state": self.state,
                "error": self.error, "started": self.started, "finished": self.finished}


class RenderQueue:
    """FIFO over shots, at most one in flight per card.

    🔴 **THE SEQUENTIAL LOOP LIVES INSIDE `run_one`, NOT IN THE QUEUE.** That is the structural
    reason a segment can never be scheduled independently: the queue has no vocabulary for one.
    A future change that wanted segment-level parallelism would have to add the concept, which is
    a decision someone makes on purpose rather than a scheduling accident.
    """

    def __init__(self, *, dispatch: Callable, devices: Callable, on_progress: Callable = None,
                 run_job: Callable = None):
        #: Optional callback for running each job returned by `pump_jobs`; omitting it keeps
        #: scheduling synchronous and easy to test.
        self._dispatch = dispatch
        self._devices = devices
        self._on_progress = on_progress
        self._run_job = run_job
        self._lock = threading.RLock()
        self._pending: list = []
        self._running: dict = {}          # device -> RenderJob
        self._finished: list = []
        self._canceled: set = set()

    # ── the queue ─────────────────────────────────────────────────────────────

    def submit(self, production_id: str, shot_id: str, index: int, length_s: float) -> RenderJob:
        with self._lock:
            total = segments_for(length_s)
            if total <= 0:
                raise RenderRefused("that shot has no length to render")
            live = [j for j in self._pending] + list(self._running.values())
            if any(j.shot_id == shot_id for j in live):
                # ⚠️ REFUSED, NOT QUEUED TWICE. Two renders of one shot race to write the same
                # output, and the loser's frames interleave with the winner's.
                raise RenderRefused("that shot is already queued or rendering")
            job = RenderJob(id=uuid.uuid4().hex[:12], production_id=production_id,
                            shot_id=shot_id, index=index, length_s=length_s, total=total)
            self._pending.append(job)
            return job

    def cancel(self, job_id: str) -> bool:
        """Cancel a queued or running shot.

        ⚠️ A RUNNING shot is marked and stops between SEGMENTS, not mid-segment. A segment killed
        halfway leaves no latent state for the next one, so the shot could not be resumed — and
        stopping cleanly costs at most one segment of work.
        """
        with self._lock:
            for j in self._pending:
                if j.id == job_id:
                    self._pending.remove(j)
                    j.state = "canceled"
                    self._finished.append(j)
                    return True
            for j in self._running.values():
                if j.id == job_id:
                    self._canceled.add(job_id)
                    return True
        return False

    def cancel_all(self) -> int:
        with self._lock:
            n = len(self._pending)
            for j in self._pending:
                j.state = "canceled"
                self._finished.append(j)
            self._pending.clear()
            for j in self._running.values():
                self._canceled.add(j.id)
                n += 1
            return n

    def pump(self) -> int:
        """How many started. Kept because it reads naturally in a test; `pump_jobs` is what a
        caller needs when it has to do something with each one."""
        return len(self.pump_jobs())

    def pump_jobs(self) -> list:
        """Start available shots and return their jobs for the caller to run.

        Callers pump after submissions, completions, and status reads so available cards do not
        leave queued shots idle.
        """
        started = []
        with self._lock:
            free = [d for d in self._devices() if d not in self._running]
            while free and self._pending:
                device = free.pop(0)
                job = self._pending.pop(0)
                job.device = device
                job.state = "running"
                job.started = time.time()
                self._running[device] = job
                # Hold the card lease for the whole shot. If another subsystem already owns the
                # card, return this job to the queue and retry on a later pump.
                if not GPUS.claim_external(device, f"shot-render:{job.production_id[:8]}"):
                    job.device = ""
                    job.state = "queued"
                    job.started = 0.0
                    del self._running[device]
                    self._pending.insert(0, job)
                    continue
                started.append(job)
        return started

    def run_one(self, job: RenderJob) -> None:
        """Render one shot sequentially because each segment depends on the prior latent state."""
        try:
            state = None
            for n in range(job.total):
                if job.id in self._canceled:
                    job.state = "canceled"
                    break
                state = self._dispatch(job=job, segment=n, prev_state=state)
                with self._lock:
                    job.done = n + 1
                if self._on_progress:
                    self._on_progress(job)
            else:
                job.state = "done"
        except Exception as exc:                                  # noqa: BLE001
            # The worker turns any failure into a readable state, because the UI is polling and
            # has nowhere else to look. It is recorded and re-raised nowhere: the queue must keep
            # running the other shots.
            job.state = "failed"
            job.error = str(exc)
            logger.error(f"shot render {job.shot_id} failed: {exc}")
        finally:
            job.finished = time.time()
            with self._lock:
                self._canceled.discard(job.id)
                if self._running.get(job.device) is job:
                    del self._running[job.device]
                self._finished.append(job)
                # ⚠️ BY LABEL, so this can only ever hand back the lease this job took.
                GPUS.release_external(job.device, f"shot-render:{job.production_id[:8]}")
            # 🔴 `pump()` DISCARDED THE JOBS IT STARTED, AND THAT STRANDED THE QUEUE.
            # `pump_jobs` only MARKS a job running and leases its card; its docstring says in
            # terms that it "returns the jobs it started, so the caller can run them", and the two
            # route call sites do exactly that. This one called the counting wrapper, so on every
            # completion the next shot was set to `running`, had its GPU leased, and was never
            # dispatched by anybody. It could not self-heal either: a later pump skips it because
            # it is already in `_running`, and its device is no longer in `free`. The card stayed
            # leased for ever, so `/comfyui/stop` 409'd for ever and `loragen.start` refused for
            # ever — a service restart was the only exit.
            for started in self.pump_jobs():
                if self._run_job is not None:
                    self._run_job(started)

    # ── what the screen reads ─────────────────────────────────────────────────

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "pending": [j.as_dict() for j in self._pending],
                "running": [j.as_dict() for j in self._running.values()],
                "finished": [j.as_dict() for j in self._finished[-50:]],
                "devices": list(self._devices()),
            }
