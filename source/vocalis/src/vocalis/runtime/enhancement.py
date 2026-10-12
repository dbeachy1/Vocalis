"""Coordinate enhancement availability, GPU selection, and per-file jobs.

Top-level `enhance.py` owns the engine and process configuration. This runtime module
applies application policy: card authorization, job cancellation, locking, and shared
availability checks for route callers.
"""
import subprocess
from pathlib import Path

import enhance

from vocalis.runtime import configs
from vocalis.runtime import pool as rt_pool
from vocalis.runtime.jobs import Job, emit


def enhance_cards() -> list:
    """Cards enhancement may use: the ⚙ Settings selection, CUDA only. Empty ⇒ this box
    has no GPU (the Windows dev box), and the enhancer on CPU would take days — so callers
    treat that as "unavailable" and say so, rather than starting something that never ends."""
    return rt_pool.local_cuda_devices()


ENHANCE_BUSY = {
    # Distinguish render scheduling from card-lock contention.
    "render": "a render is using every card — enhancing needs a whole card to "
              "itself. Try again when it finishes.",
    "render_waiting": "a render is queued for the cards and goes first — enhancing "
                      "needs a whole card to itself. Try again once it has run.",
    "cards": "every card is already busy (enhancing, or training a voice) — enhancing "
             "needs a whole card to itself. Try again when one frees up.",
}


def enhance_available() -> bool:
    cfg = configs.enhance_cfg()
    return cfg.available and bool(enhance_cards())


def enhance_unavailable_reason() -> str:
    """WHY it is unavailable, told apart rather than lumped together.

    Missing runtime, model files, and authorized cards have distinct remedies.
    """
    cfg = configs.enhance_cfg()
    if not cfg.available:
        return cfg.unavailable_reason + " Untick Enhance to render without it."
    return ("Enhancing has no card to run on. It needs one of THIS machine's own "
            "cards — it never runs on a satellite — and none are ticked in ⚙ Settings ▸ "
            "Devices. Tick a local card there, or untick Enhance to render without it.")


# Kept as a module constant for callers that want a static string; the reason above is what the
# routes should use, because it can tell the two causes apart.
ENHANCE_MISSING = ("Enhancing isn't available on this box — it needs the isolated "
                   "enhance environment and the pinned local model snapshot, plus a card "
                   "of its own in ⚙ Settings ▸ Devices. Untick Enhance to render without it.")


def enhance_one(job: Job, src: Path, dst: Path, nfe: int, device: str, label: str) -> bool:
    """Enhance ONE file on ONE card. False ⇒ the caller must stop (canceled).

    HOLDS THAT CARD'S LOCK. The enhancer wants ~21 GB and cannot share a card with a
    training, which owns its card for hours — so it queues behind one rather than OOMing
    both. Renders do not take card locks at all; they go through GPUS, which is where the
    render-vs-enhancement question is settled instead. The interactive job still always
    wins — a queued render stands new enhancements down — it just wins at the gate rather
    than at the lock.

    Raises on a real failure — a caller that swallowed it would encode the RAW audio at
    256k and hand back a file that is bigger, slower to make, and no better.

    It raises enhance.EnhanceFailed, not RuntimeError, because `label` is USER PROSE at two
    of the three call sites: `wav.name` is a chapter's `<NN>_<title>.wav` and `mp3.name` is
    a Playground clip named from the prompt. In str(exc) it would ride the traceback into
    logs/vocalis.log; in `.detail` it reaches the browser, which is where it belongs.
    """
    rc = enhance.run_enhance(
        configs.enhance_cfg(), src, dst, nfe, device, cancel=job.cancel,
        on_line=lambda line: emit(job, {"type": "log", "line": line}))
    if rc == -1 or job.cancel.is_set():
        return False
    if rc != 0 or not dst.is_file():
        raise enhance.EnhanceFailed(f"enhancing failed (exit {rc})",
                                    detail=f"on {label}")
    return True


# Scene enhancement uses `scene_enhance.run_enhance`, which claims GPU capacity through
# the request path. Keep this module focused on single-file enhancement jobs.


def decode_to_wav(src: Path, dst: Path) -> None:
    """MP3 → mono WAV, native sample rate (the enhancer resamples to 44.1 kHz itself).

    Both playground and training callers pass decoded audio to `enhance_one`, whose input
    reader requires WAV-compatible files.
    """
    r = subprocess.run(["ffmpeg", "-y", "-i", str(src), "-ac", "1", str(dst),
                        "-loglevel", "error"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"could not decode {src.name}: {r.stderr.strip()}")

# Shared by multiple route modules.

def enhance_default() -> bool:
    """What `enhance` means when a request doesn't say.

    Enhancement is enabled by default because Chatterbox output commonly benefits from it,
    so the box is ticked and you untick
    it rather than the other way round.

    But "on" degrades to "off" where the box cannot do it at all (no enhance venv, no
    card — e.g. the Windows dev machine). A DEFAULT that hard-fails is not a default, it
    is an outage: it would 400 every render on any box without the toolchain, including
    callers that never asked for enhancement and don't know it exists. Asking for it
    EXPLICITLY on such a box still fails, loudly and immediately — that is a real request
    that cannot be honored, and silently ignoring it would be the worse lie."""
    return enhance_available()
