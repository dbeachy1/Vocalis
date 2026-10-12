"""Compare a trained LoRA across strengths to verify that it loads.

Use one seed for every strength so image differences reflect LoRA strength. Compare image
digests at the control and maximum strengths; report `unknown` until both are available. This
is a load check, not a quality judgment.
"""
from __future__ import annotations

import contextlib
import hashlib
import threading
import time
from dataclasses import dataclass, field as dc_field

import vault_fs
from loguru import logger

from . import flux2, paths
from .gpu import GPUS

#: §4.7's three. 0.0 is the control — it must be there or there is nothing to compare against.
DEFAULT_STRENGTHS = (0.0, 0.7, 1.0)
MAX_STRENGTHS = 5

PREFIX = "test-"
SUFFIX = ".png"


class TestRefused(RuntimeError):
    """The run cannot start, and why."""


def test_dir(subject_id: str):
    """Routed. These are images of the subject's face, same as everything else here."""
    from .lorasubj import dataset_dir
    dataset_dir(subject_id)
    return paths.LORA_TESTS / subject_id


def name_for(strength: float) -> str:
    """Return the image filename for a strength; the grid derives labels from filenames."""
    return f"{PREFIX}{strength:.2f}{SUFFIX}"


@dataclass
class TestRun:
    subject_id: str = ""
    lora: str = ""
    prompt: str = ""
    seed: int = 0
    strengths: list = dc_field(default_factory=list)
    done: int = 0
    failed: int = 0
    running: bool = False
    error: str = ""
    device: str = ""
    #: sha256 per strength, filled as they land. The verdict is computed from these.
    digests: dict = dc_field(default_factory=dict)

    def verdict(self) -> str:
        """`loaded`, `not_loaded`, or `unknown` — never a quality judgment.

        Return `unknown` until both the control and maximum-strength images are available.
        """
        lo, hi = f"{min(DEFAULT_STRENGTHS):.2f}", f"{max(self.strengths or [0]):.2f}"
        if lo not in self.digests or hi not in self.digests:
            return "unknown"
        return "not_loaded" if self.digests[lo] == self.digests[hi] else "loaded"

    def as_dict(self) -> dict:
        return {"subject_id": self.subject_id, "lora": self.lora, "prompt": self.prompt,
                "seed": self.seed, "strengths": list(self.strengths), "done": self.done,
                "failed": self.failed, "running": self.running, "error": self.error,
                "device": self.device, "digests": dict(self.digests),
                "verdict": self.verdict()}


@contextlib.contextmanager
def _no_lending(subject_id: str, lora: str):
    """Default lending behavior for a model already present in ComfyUI."""
    yield lora


class LoraTest:
    """One test run per process. Three images is minutes, not hours."""

    def __init__(self, *, dispatch, devices, lend=_no_lending):
        self._dispatch = dispatch
        self._devices = devices
        #: Inject for tests that verify the model copy remains available for the entire run.
        self._lend = lend
        self._lock = threading.RLock()
        self._state = TestRun()
        self._stop = False

    def snapshot(self) -> dict:
        with self._lock:
            return self._state.as_dict()

    def start(self, subject_id: str, lora: str, prompt: str, seed: int,
              strengths=DEFAULT_STRENGTHS) -> dict:
        with self._lock:
            if self._state.running:
                raise TestRefused("a test run is already going")
            if not (lora or "").strip():
                raise TestRefused("pick a LoRA to test")
            if not (prompt or "").strip():
                raise TestRefused("a test needs a prompt")

            vals = sorted({round(float(s), 2) for s in strengths})[:MAX_STRENGTHS]
            if len(vals) < 2:
                # One strength cannot produce a comparison.
                raise TestRefused("at least two strengths are needed to compare")

            devices = list(self._devices())
            if not devices:
                raise TestRefused("no ComfyUI backend is configured")
            device = devices[0]
            # Refuse if another job already owns the device lease.
            if not GPUS.claim_external(device, f"lora-test:{subject_id[:8]}"):
                raise TestRefused(
                    "the card is busy - a render, an enhancement or another generation holds it")

            self._stop = False
            self._state = TestRun(subject_id=subject_id, lora=lora, prompt=prompt,
                                  seed=int(seed), strengths=vals, running=True, device=device)
            threading.Thread(target=self._run, args=(subject_id, lora, prompt, int(seed), vals,
                                                     device), daemon=True).start()
            return self._state.as_dict()

    def _run(self, subject_id, lora, prompt, seed, strengths, device) -> None:
        try:
            # Keep the model copy available for every strength in this comparison.
            with self._lend(subject_id, lora) as name:
                d = test_dir(subject_id)
                vault_fs.mkdir(d)
                for s in strengths:
                    with self._lock:
                        if self._stop:
                            break
                    try:
                        # Use the same seed so image differences reflect strength changes.
                        data = self._dispatch(lora=name, prompt=prompt, seed=seed, strength=s)
                        vault_fs.write_bytes(d / name_for(s), data)
                        with self._lock:
                            self._state.digests[f"{s:.2f}"] = hashlib.sha256(data).hexdigest()[:32]
                            self._state.done += 1
                    except (flux2.GraphFailed, OSError) as exc:
                        logger.error(f"lora test at strength {s} failed: {exc}")
                        with self._lock:
                            self._state.failed += 1
                            self._state.error = str(exc)
        except OSError as exc:
            # The lend itself failed — no ComfyUI lora directory on this host, or the vault could
            # not be read. Reported as the run's error rather than dying in a daemon thread with
            # the screen still saying "running".
            logger.error(f"lora test could not lend the model: {exc}")
            with self._lock:
                self._state.failed += 1
                self._state.error = str(exc)
        finally:
            with self._lock:
                self._state.running = False
            # Release only this run's lease.
            GPUS.release_external(device, f"lora-test:{subject_id[:8]}")

    def cancel(self) -> dict:
        with self._lock:
            self._stop = True
            return self._state.as_dict()


def list_images(subject_id: str) -> list:
    try:
        return sorted(vault_fs.glob(test_dir(subject_id), f"{PREFIX}*{SUFFIX}"))
    except (OSError, ValueError):
        return []


def sweep(subject_id: str) -> int:
    d = test_dir(subject_id)
    gone = 0
    for name in list_images(subject_id):
        vault_fs.unlink(d / name, missing_ok=True)
        gone += 1
    return gone
