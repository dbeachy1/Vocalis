#!/usr/bin/env python3
"""Measured DeepFilterNet3 denoise timing used for estimates. Estimate wall time as `startup + rate * audio_seconds`; report no ETA until a valid measurement exists. Startup includes process creation, imports, and model load; rate covers audio processing. The cache key includes model and device, with CPU as the supported device. Wet/dry mix does not change model runtime, and measurements are stored separately from enhancement rates."""
import datetime
from pathlib import Path

import yaml
from loguru import logger

from tts_utils import atomic_replace, cache_root

# One run is enough — both parameters are measured directly — but it has to have some audio in
# it. A 2-second probe is dominated by scheduling noise and its rate is not this box's rate.
MIN_AUDIO_SECONDS = 10.0

# The one model the Clean up denoise pass uses (design §2.2). Named in the key so a future
# second denoiser cannot silently inherit DeepFilterNet3's measured rate.
MODEL = "dfn3"


def key_for(model: str = MODEL, device: str = "cpu") -> str:
    """Identity of a DENOISE CONFIGURATION: the model and the device it ran on.

    No step count (denoise has none) and no strength (the model runs once regardless of the
    dry/wet mix). Device is 'cpu' by design — DeepFilterNet3 is CPU work so a Clean up never
    competes with a render for a GPU (§2.2) — but it is in the key so a box that overrode it
    onto a card does not pollute the CPU rate."""
    return f"{model or MODEL}|{device or 'cpu'}"


def _path() -> Path:
    # cache_root() is documented as regenerable and safe to delete: wiping it costs one
    # un-estimated denoise, after which the box has measured itself again.
    return cache_root() / "cleanup_rates.yaml"


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
        logger.exception(f"cleanup-rate cache unreadable — ignoring it: {p}")
        return {}


def get(key: str):
    """(startup_seconds, seconds_per_audio_second) for this configuration, or None if this
    box has never been timed at these settings. None means: say nothing."""
    row = _load().get(key) or {}
    runs = int(row.get("runs") or 0)
    audio = float(row.get("audio_s") or 0)
    compute = float(row.get("compute_s") or 0)
    startup = float(row.get("startup_s") or 0)
    if runs < 1 or audio < MIN_AUDIO_SECONDS or compute <= 0:
        return None
    return startup / runs, compute / audio


def record(key: str, audio_s: float, compute_s: float, startup_s: float) -> None:
    """Fold one finished denoise into this configuration's running totals.

    A run whose model load could not be timed separately (the child prints load_s=0 when the
    pre-load was refused) must never reach here: its compute_s still contains the load, and
    recording it would inflate the per-second rate for every clip that follows."""
    if float(audio_s) <= 0 or float(compute_s) <= 0 or float(startup_s) < 0:
        return
    rates = _load()
    row = rates.get(key) or {}
    rates[key] = {
        "runs": int(row.get("runs") or 0) + 1,
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


def eta_seconds(audio_seconds: float, fit, files: int = 1):
    """Wall clock for `audio_seconds` of audio, or None if `fit` is None.

    `files` is how many separate denoise INVOCATIONS the work is split into, because each one
    pays the model load again — a Trim→Denoise pass denoises each surviving take on its own,
    so `files` is the number of takes. There is no `cards`: denoise is CPU and serial here."""
    if not fit:
        return None
    startup, rate = fit
    return max(1, int(files)) * float(startup) + max(0.0, float(audio_seconds)) * float(rate)


def parse_timing(line: str):
    """The child's `VOCALIS_TIMING audio_s=… load_s=… compute_s=…` line, as a dict of floats —
    or None if this isn't that line.

    Returns None when `load_s` is 0: that is the child telling us its pre-load was refused, so
    `compute_s` still has the model load inside it. An unusable measurement is not a
    measurement, and half of one is worse than none."""
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
