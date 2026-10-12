"""Plan and run LoRA image generation using the shared queue and GPU gate.

The queue owns scheduling; this module defines generation jobs, output paths, and run state.
Hold each card lease for the whole run so stop controls cannot race between images. Recompute
the plan from files on disk so interrupted runs resume without a separate cursor.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field as dc_field
from typing import Any

import vault_fs
from loguru import logger

from . import paths
from .acequeue import AceQueue
from .gpu import GPUS

#: Bounds. A run is `len(prompts) x per_prompt` images; §4.4's example is 10 x 5 = 50.
MAX_PER_PROMPT = 20
MAX_IMAGES = 2000


class GenerateRefused(RuntimeError):
    """The run cannot start. Carries why, because "nothing happened" is the worst answer."""


@dataclass
class GenJob:
    """One image. Identified by `(prompt_index, seq)`, which is also its filename.

    The id derives from prompt position and sequence so retries map to the same output file.
    """

    subject: str
    prompt_index: int
    seq: int
    prompt: str          # the COMPOSED prompt (identity block already prepended, §4.3)
    seed: str = ""

    @property
    def id(self) -> str:
        return f"{self.subject}:{self.prompt_index:03d}:{self.seq:02d}"

    @property
    def filename(self) -> str:
        return f"p{self.prompt_index:03d}_{self.seq:02d}.png"


@dataclass
class RunState:
    """What the screen polls. Deliberately small and derived — see `snapshot`."""

    subject: str
    total: int
    done: int = 0
    failed: int = 0
    canceled: bool = False
    started_at: float = dc_field(default_factory=lambda: time.time())
    cards: list = dc_field(default_factory=list)
    error: str = ""


def out_dir(subject_id: str):
    """Where a run's images land. Routed, like everything else here.

    Reuse the subject id validation before constructing this output path.
    """
    from .lorasubj import dataset_dir
    dataset_dir(subject_id)                       # raises on an id unsafe as a filename
    return paths.LORA_GENERATED / subject_id


def plan(subject_id: str, prompts: list, per_prompt: int) -> list:
    """The jobs still to do — recomputed from disk, never from a stored cursor.

    §4.4: *"Resumable — re-running skips images already on disk."* A file that exists is a job
    that is done. There is no counter to go stale or to repair after a crash.
    """
    per_prompt = max(1, min(int(per_prompt or 1), MAX_PER_PROMPT))
    d = out_dir(subject_id)
    have = set(vault_fs.glob(d, "*.png")) if vault_fs.exists(d) else set()
    jobs = []
    for i, prompt in enumerate(prompts or []):
        for n in range(per_prompt):
            j = GenJob(subject=subject_id, prompt_index=i, seq=n, prompt=prompt)
            if j.filename not in have:
                jobs.append(j)
    if len(jobs) > MAX_IMAGES:
        raise GenerateRefused(f"that is {len(jobs)} images; the ceiling is {MAX_IMAGES}")
    return jobs


class GenerateRun:
    """One generation run per process; concurrent runs would share its output directory."""

    def __init__(self, dispatch, backends):
        #: `dispatch(job_id, device, url)` — injected, exactly as `AceQueue` wants it. It is why
        #: every test below runs without a GPU and without ComfyUI: the scheduling invariants are
        #: the thing worth testing, and they are independent of what a job actually does.
        self._dispatch = dispatch
        #: `backends() -> [(service, url, device)]`, re-asked each pump so an unticked card stops
        #: receiving work mid-run.
        self._backends = backends
        self._lock = threading.RLock()
        self._state = None
        self._jobs = {}
        self._queue = None
        self._leased = []

    # ── lifecycle ───────────────────────────────────────────────────────────

    def start(self, subject_id: str, prompts: list, per_prompt: int) -> RunState:
        with self._lock:
            if self._state is not None and not self.finished():
                raise GenerateRefused("a generation is already running")

            jobs = plan(subject_id, prompts, per_prompt)
            if not jobs:
                raise GenerateRefused("every image already exists - nothing to generate")

            # Hold each card lease for the whole run so stop controls cannot race between images.
            self._leased = []
            for _svc, _url, device in self._backends():
                if GPUS.claim_external(device, f"lora:{subject_id}"):
                    self._leased.append(device)
            if not self._leased:
                raise GenerateRefused(
                    "the cards are busy - a render or an enhancement is using them")

            self._jobs = {j.id: j for j in jobs}
            self._state = RunState(subject=subject_id, total=len(jobs), cards=list(self._leased))
            vault_fs.mkdir(out_dir(subject_id))

            self._queue = AceQueue(dispatch=self._dispatch_one, backends=self._leased_backends)
            for j in jobs:
                self._queue.enqueue(j.id, self._leased_backends())
            return self._state

    def _leased_backends(self):
        """Only the cards this run holds. A card it could not claim is not a place to send work,
        and re-asking each pump means one unticked mid-run simply stops receiving."""
        return [(s, u, d) for s, u, d in self._backends() if d in self._leased]

    def _dispatch_one(self, job_id: str, device: str, url: str) -> None:
        job = self._jobs.get(job_id)
        if job is None:                     # canceled out from under us
            return
        self._dispatch(job, device, url)

    # ── progress ────────────────────────────────────────────────────────────

    def landed(self, job_id: str, ok: bool = True) -> None:
        """One image finished. Called by whatever the dispatcher spawned, on EVERY outcome.

        Use `done()` so the queue releases the slot and immediately dispatches pending work.
        """
        with self._lock:
            if self._state is None:
                return
            if ok:
                self._state.done += 1
            else:
                self._state.failed += 1
        if self._queue is not None:
            self._queue.done(job_id)
        if self.finished():
            self._release_cards()

    def cancel(self) -> None:
        """§4.4: *"Stop is real: it cancels the ComfyUI queue and keeps what exists."*

        Keeps what exists is free here — the images already written are files, and nothing removes
        them. What matters is that the cards come back even though the run did not complete.
        """
        with self._lock:
            if self._state is not None:
                self._state.canceled = True
            self._jobs.clear()
        self._release_cards()

    def _release_cards(self) -> None:
        """Release all leases held by this run. Safe to call more than once."""
        with self._lock:
            leased, self._leased = self._leased, []
        for d in leased:
            GPUS.release_external(d)

    def finished(self) -> bool:
        st = self._state
        if st is None:
            return True
        return bool(st.canceled) or (st.done + st.failed) >= st.total

    def snapshot(self) -> dict:
        st = self._state
        if st is None:
            return {"running": False}
        return {"running": not self.finished(), "subject": st.subject,
                "total": st.total, "done": st.done, "failed": st.failed,
                "canceled": st.canceled, "cards": list(st.cards),
                "started_at": st.started_at, "error": st.error}
