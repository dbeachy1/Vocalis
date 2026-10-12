#!/usr/bin/env python3
"""Shared dry/wet mix logic for the 4.4 "Clean up" denoise children (design §2.2).

WHY THIS FILE EXISTS
--------------------
The CHOSEN denoise child, denoise_dfn.py (DeepFilterNet3 -- the ear-test winner, §2.2),
mixes its denoised output against the original by an HONEST dry/wet weight and names a
sweep's files by a sortable three-digit tag. That mixing/naming is pure numpy with no model
in it, so it lives ONCE, here, rather than being copied into the child -- the same single-
source discipline the enhance shims follow ("two copies is exactly how they would drift",
enhance_audio.py). (denoise_audio.py, the superseded resemble-enhance PoC of record, predates
this split and keeps its own frozen copy; it is history, not a live path, so it is left as
committed.)

Nothing in this module imports torch, a denoiser, or the vault. It is the part worth
unit-testing on any box (tests/test_cleanup_denoise*.py).
"""
from pathlib import Path

import numpy as np


def parse_levels(spec: str) -> list:
    """A `--wet-sweep` spec ("1.0,0.7,0.4") to an ordered list of clamped strengths.

    Clamped to [0, 1] because a mix weight outside that range is a typo, not an intent;
    de-duplicated preserving order so "1,1,0.5" does not denoise-mix the same level twice;
    empty/garbage tokens are dropped rather than crashing a 90-minute run at the write step.
    """
    out = []
    for tok in str(spec or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            v = float(tok)
        except ValueError:
            continue
        v = min(1.0, max(0.0, v))
        if v not in out:
            out.append(v)
    return out


def dry_wet_mix(orig: np.ndarray, denoised: np.ndarray, wet: float) -> np.ndarray:
    """`wet`·denoised + (1-`wet`)·original, at the denoiser's sample rate.

    `wet` >= 1.0 short-circuits to the denoised signal untouched -- no truncation, no
    resample round-trip, so the fully-denoised output is bit-for-bit what the model
    produced. Otherwise the two signals are aligned to the shorter length before mixing:
    a denoiser pads/reshapes internally, so `denoised` is not guaranteed to be exactly as
    long as a resample of `orig`, and a raw `+` on mismatched lengths would raise. A few
    samples of edge difference is inaudible; a ValueError mid-run is not.
    """
    if wet >= 1.0:
        return np.asarray(denoised, dtype=np.float32)
    o = np.asarray(orig, dtype=np.float32)
    d = np.asarray(denoised, dtype=np.float32)
    n = min(len(o), len(d))
    return (wet * d[:n] + (1.0 - wet) * o[:n]).astype(np.float32)


def wet_output_path(base: Path, wet: float) -> Path:
    """`out.wav` + level 0.7 -> `out.wet070.wav`. A stable, sortable, three-digit tag so a
    sweep's files line up in a directory listing and never collide (100 vs 070 vs 040)."""
    base = Path(base)
    return base.with_name(f"{base.stem}.wet{round(wet * 100):03d}{base.suffix}")
