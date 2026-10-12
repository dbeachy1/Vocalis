#!/usr/bin/env python3
"""Estimate voice-swap duration as startup plus per-second processing time measured from child-reported timings. Accumulate observations by active configuration and use wall-clock totals; report no estimate until sufficient data exists."""
import datetime
from pathlib import Path

import yaml
from loguru import logger

from tts_utils import atomic_replace, cache_root

# One run is enough — both parameters are measured directly, not fitted — but it has to be a
# run with some audio in it. A sub-10-second probe is dominated by scheduling noise and by
# the model load, and its rate is not this card's rate. A 15-second audition clears this.
MIN_AUDIO_SECONDS = 10.0


def key_for(gpu_name: str, f0_method: str) -> str:
    """Return the identity of one swap configuration. Include the f0 method because pitch extraction affects processing cost; use device name as an identity only, not as a speed lookup. Exclude output-only settings that do not materially change per-second cost."""
    return f"{gpu_name or 'cpu'}|f0={f0_method}"


def _path() -> Path:
    # cache_root() is documented as regenerable and safe to delete: wiping it costs one
    # un-estimated swap, after which the box has measured itself again.
    return cache_root() / "swap_rates.yaml"


def _load() -> dict:
    """🔴 AND A WRONG KEY IS NOT A CORRUPT CACHE. `VaultAuthError` is a `BaseException`, so the
    `except Exception` below cannot see it and it is not degraded to {} — it goes to an M5
    boundary instead. Same contract as `enhance_rate._load`, which is this file's sibling."""
    import vault_fs
    p = _path()
    if not vault_fs.exists(p):
        return {}
    try:
        d = yaml.safe_load(vault_fs.read_text(p)) or {}
        return d.get("rates") or {}
    except Exception:                       # noqa: BLE001 — a corrupt cache is not an outage
        logger.exception(f"swap-rate cache unreadable — ignoring it: {p}")
        return {}


def get(key: str):
    """(startup_seconds, seconds_per_audio_second) for this configuration, or None if this box
    has never been timed at these settings. None means: say nothing."""
    row = _load().get(key) or {}
    runs = int(row.get("runs") or 0)
    audio = float(row.get("audio_s") or 0)
    compute = float(row.get("compute_s") or 0)
    startup = float(row.get("startup_s") or 0)
    if runs < 1 or audio < MIN_AUDIO_SECONDS or compute <= 0:
        return None
    return startup / runs, compute / audio


def record(key: str, audio_s: float, compute_s: float, startup_s: float) -> None:
    """Fold one finished swap into this configuration's running totals.

    A run whose model load could not be timed separately (the child prints load_s=0) must
    never reach here: its compute_s still contains the load, and recording it would inflate the
    per-second rate for every clip that follows. The parse layer already drops such a line, so
    this is belt-and-braces — nonsense is simply refused."""
    if float(audio_s) <= 0 or float(compute_s) <= 0 or float(startup_s) < 0:
        return
    rates = _load()
    row = rates.get(key) or {}
    rates[key] = {
        "runs": int(row.get("runs") or 0) + 1,
        # Two decimals: startup is a per-run mean of ~15 seconds and dominates a short clip's
        # estimate, so rounding the accumulator to a tenth throws away real precision.
        "audio_s": round(float(row.get("audio_s") or 0) + float(audio_s), 2),
        "compute_s": round(float(row.get("compute_s") or 0) + float(compute_s), 2),
        "startup_s": round(float(row.get("startup_s") or 0) + float(startup_s), 2),
        "updated": datetime.datetime.now().replace(microsecond=0).isoformat(),
    }
    # a crash mid-write must not eat the history — write_yaml_atomic is atomic on BOTH arms
    # (the vault's own .part + atomic_replace inside, the repo's dance outside), so the `.part`
    # sibling no longer has to exist inside a routed tree. sort_keys=True is preserved: this is
    # a file a human reads by hand, and encryption is not a license to reformat it.
    import vault_fs
    vault_fs.write_yaml_atomic(_path(), {"rates": rates}, sort_keys=True)


def eta_seconds(audio_seconds: float, fit):
    """Wall clock for `audio_seconds` of audio, or None if `fit` is None.

    One invocation, one card: a swap is a single rvc_infer.py process (chunking and both-cards
    were retired from 4.2 — see the module docstring), so there is no `files`/`cards` fan-out to
    model the way enhance_rate's book does. wall = startup + rate x audio."""
    if not fit:
        return None
    startup, rate = fit
    return float(startup) + max(0.0, float(audio_seconds)) * float(rate)


def parse_timing(line: str):
    """The child's `VOCALIS_TIMING audio_s=… load_s=… compute_s=…` line, as a dict of floats —
    or None if this isn't that line.

    Returns None when `load_s` is 0: that is the child telling us its model load could not be
    timed apart from the conversion, so `compute_s` still has the load inside it. Half a
    measurement is worse than none — it would charge the load into the per-second rate."""
    if not line or not line.startswith("VOCALIS_TIMING "):
        return None
    out = {}
    for part in line.split()[1:]:
        k, _, v = part.partition("=")
        try:
            out[k] = float(v)
        except ValueError:
            return None
    if not {"audio_s", "load_s", "compute_s"} <= out.keys():
        return None
    if out["load_s"] <= 0 or out["audio_s"] <= 0 or out["compute_s"] <= 0:
        return None
    return out
