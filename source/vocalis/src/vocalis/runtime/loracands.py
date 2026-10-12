"""Generate seed-face candidates and promote a selected image through the upload pipeline.

Candidates stay separate until chosen; promotion uses the same crop and resize logic as an
upload. A run is sequential on one authorized card so the candidate set remains coherent.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field as dc_field

import vault_fs
from loguru import logger

from . import flux2, paths
from .gpu import GPUS

#: Number of candidates shown by default and maximum allowed in one run.
DEFAULT_COUNT = 4
MAX_COUNT = 8

#: Editable starting prompt; identity details are supplied by the user.
DEFAULT_PROMPT = ("Portrait photograph of a person, head-and-shoulders framing, plain neutral "
                  "background, soft even lighting, neutral relaxed expression, natural skin "
                  "texture with visible pores, sharp focus, high detail, photorealistic, "
                  "shot on 85mm lens.")

PREFIX = "cand-"
SUFFIX = ".png"


class CandidatesRefused(RuntimeError):
    """The run cannot start, and why."""


def candidates_dir(subject_id: str):
    """Routed, therefore encrypted. A candidate is a photograph of a face — the sharpest content
    class in this release — and it is one whether or not it was ever chosen."""
    from .lorasubj import dataset_dir
    dataset_dir(subject_id)                       # reuse its id check; one guard, one place
    return paths.LORA_FACE_CANDIDATES / subject_id


@dataclass
class CandidateRun:
    subject_id: str = ""
    prompt: str = ""
    total: int = 0
    done: int = 0
    failed: int = 0
    running: bool = False
    error: str = ""
    device: str = ""
    started: float = 0.0

    def as_dict(self) -> dict:
        return {"subject_id": self.subject_id, "prompt": self.prompt, "total": self.total,
                "done": self.done, "failed": self.failed, "running": self.running,
                "error": self.error, "device": self.device, "started": self.started}


class Candidates:
    """One candidate run per process, like training and unlike generation.

    Runs are refused while another is active because both would write into the same candidate set.
    """

    def __init__(self, *, dispatch, devices):
        self._dispatch = dispatch
        self._devices = devices
        self._lock = threading.RLock()
        self._state = CandidateRun()
        # Stop after the in-flight render; `running` remains true while its card lease is held.
        self._stop = False

    def snapshot(self) -> dict:
        with self._lock:
            return self._state.as_dict()

    def start(self, subject_id: str, prompt: str, count: int) -> dict:
        with self._lock:
            if self._state.running:
                raise CandidatesRefused("a candidate run is already going")
            self._stop = False
            if not (prompt or "").strip():
                raise CandidatesRefused("a candidate needs a prompt")
            n = max(1, min(MAX_COUNT, int(count or DEFAULT_COUNT)))

            devices = list(self._devices())
            if not devices:
                raise CandidatesRefused("no ComfyUI backend is configured")
            device = devices[0]
            # Hold the external GPU lease for the run and refuse to start if the card is busy.
            label = f"lora-face:{subject_id[:8]}"
            if not GPUS.claim_external(device, label):
                raise CandidatesRefused(
                    "the card is busy - a render, an enhancement or another generation holds it")

            self._state = CandidateRun(subject_id=subject_id, prompt=prompt, total=n,
                                       running=True, device=device, started=time.time())
            threading.Thread(target=self._run, args=(subject_id, prompt, n, device),
                             daemon=True).start()
            return self._state.as_dict()

    def _run(self, subject_id: str, prompt: str, n: int, device: str) -> None:
        try:
            d = candidates_dir(subject_id)
            vault_fs.mkdir(d)
            for i in range(n):
                with self._lock:
                    if self._stop:
                        break                      # canceled between images
                try:
                    data = self._dispatch(prompt=prompt, seed=flux2.seed_for(f"{subject_id}:c{i}"))
                    vault_fs.write_bytes(d / f"{PREFIX}{i:02d}{SUFFIX}", data)
                    with self._lock:
                        self._state.done += 1
                except (flux2.GraphFailed, OSError) as exc:
                    logger.error(f"lora face candidate {i} failed: {exc}")
                    with self._lock:
                        self._state.failed += 1
                        self._state.error = str(exc)
        finally:
            with self._lock:
                self._state.running = False
            # Release only this run's lease, including after failures or cancellation.
            GPUS.release_external(device, f"lora-face:{subject_id[:8]}")

    def cancel(self) -> dict:
        """Stop after the image in flight.

        Keep `running` true until the worker releases its GPU lease in `finally`.
        """
        with self._lock:
            self._stop = True
            return self._state.as_dict()


def list_candidates(subject_id: str) -> list:
    """Return sorted candidate filenames from storage, including after the run ends."""
    try:
        names = vault_fs.glob(candidates_dir(subject_id), f"{PREFIX}*{SUFFIX}")
    except (OSError, ValueError):
        return []
    return sorted(names)


def choose(subject_id: str, name: str) -> dict:
    """Promote one candidate to the subject's seed face.

    Pass the selected image through `loraface.put()` so uploads and generated candidates share
    normalization. Match the client value against the stored listing before reading it.
    """
    from . import loraface

    if name not in list_candidates(subject_id):
        raise CandidatesRefused("no such candidate")
    data = vault_fs.read_bytes(candidates_dir(subject_id) / name)
    return loraface.put(subject_id, data)


def sweep(subject_id: str) -> int:
    """Delete every candidate for this subject.

    Keep candidate cleanup explicit so users can review the remaining images after selection.
    """
    d = candidates_dir(subject_id)
    gone = 0
    for name in list_candidates(subject_id):
        vault_fs.unlink(d / name, missing_ok=True)
        gone += 1
    return gone
