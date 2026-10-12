#!/usr/bin/env python3
"""Store device- and step-specific enhancement timing. Estimate wall time as startup plus per-second processing cost; measure both from one child-reported run and accumulate observations. Return no estimate until a sufficiently long sample has been measured."""
import datetime
import threading
from pathlib import Path

import yaml
from loguru import logger

from tts_utils import atomic_replace, cache_root

# A sample must be long enough that scheduling noise does not dominate the measured processing rate.
MIN_AUDIO_SECONDS = 10.0

# record() updates shared totals from worker threads. Atomic file replacement protects each write, while this lock protects the full read-modify-write from lost updates.
_LOCK = threading.Lock()


def key_for(gpu_name: str, nfe: int) -> str:
    """Return the identity for one enhancement configuration. The step count affects cost, so timing from one step count must not be reused for another."""
    return f"{gpu_name or 'cpu'}|nfe={int(nfe)}"


def _path() -> Path:
    # cache_root() is documented as regenerable and safe to delete: wiping it costs one
    # un-estimated enhancement, after which the box has measured itself again.
    return cache_root() / "enhance_rates.yaml"


class RateStoreUnreadable(Exception):
    """The stored measurements could not be parsed. Strict updates raise this error rather than replacing existing configuration totals with an empty mapping."""


def _load(*, strict: bool = False) -> dict:
    """Load measured rates. In strict mode, parsing errors raise RateStoreUnreadable so a later update cannot overwrite valid measurements. A missing file is an empty store. Vault authentication failures propagate unchanged."""
    import vault_fs
    p = _path()
    if not vault_fs.exists(p):
        return {}
    try:
        d = yaml.safe_load(vault_fs.read_text(p)) or {}
    except Exception as exc:                # noqa: BLE001 — a corrupt cache is not an outage
        logger.exception(f"enhance-rate cache unreadable — ignoring it: {p}")
        if strict:
            raise RateStoreUnreadable(str(exc)) from exc
        return {}
    rates = d.get("rates")
    if isinstance(rates, dict):
        return rates
    if rates is None and not d:
        return {}                           # an empty file: nothing measured, nothing lost
    if strict:
        raise RateStoreUnreadable(f"`rates` is not a mapping ({type(rates).__name__})")
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
    """Fold one finished enhancement into this configuration's running totals.

    A run whose model load could not be timed separately (the child prints load_s=0 when the
    pre-load was refused) must never reach here: its compute_s still contains the load, and
    recording it would inflate the per-second rate for every clip that follows.

    Under _LOCK: the whole read-modify-write, not just the write (see _LOCK).
    """
    if float(audio_s) <= 0 or float(compute_s) <= 0 or float(startup_s) < 0:
        return
    with _LOCK:
        try:
            rates = _load(strict=True)
        except RateStoreUnreadable:
            # Bookkeeping must not destroy the books. Writing from {} would erase every
            # other card and step count this box has ever measured — to save one timing
            # that is worth less than any one of them. And a rate we failed to record must
            # never fail the enhancement it was measuring: log it, and let the run stand.
            logger.warning("enhance-rate cache unreadable — NOT recording this run over it "
                           "(the store keeps whatever it has)")
            return
        row = rates.get(key) or {}
        rates[key] = {
            "runs": int(row.get("runs") or 0) + 1,
            # Two decimals, not one: `startup_s` is a per-run mean of about six seconds, and
            # rounding the accumulator to a tenth throws away real precision on the term that
            # dominates a short clip's estimate.
            "audio_s": round(float(row.get("audio_s") or 0) + float(audio_s), 2),
            "compute_s": round(float(row.get("compute_s") or 0) + float(compute_s), 2),
            "startup_s": round(float(row.get("startup_s") or 0) + float(startup_s), 2),
            "updated": datetime.datetime.now().replace(microsecond=0).isoformat(),
        }
        # a crash mid-write must not eat the history — atomic on both arms. THE LOCK STAYS:
        # the vault makes the WRITE atomic and does exactly nothing for the read-modify-write
        # around it, which is the race that actually bit here (the book's per-card workers all
        # call record() as they finish).
        import vault_fs
        vault_fs.write_yaml_atomic(_path(), {"rates": rates}, sort_keys=True)


def eta_seconds(audio_seconds: float, fit, cards: int = 1, files: int = 1):
    """Wall clock for `audio_seconds` of audio, or None if `fit` is None.

    `files` is how many separate enhancer INVOCATIONS the work is split into, because each
    one pays the model load again — the book pays it once per chapter. `cards` only helps
    when there are that many INDEPENDENT files to spread across; one file runs on one card,
    and a caller must not promise a 2x speed-up it cannot deliver.
    """
    if not fit:
        return None
    startup, rate = fit
    work = max(1, int(files)) * float(startup) + max(0.0, float(audio_seconds)) * float(rate)
    return work / max(1, int(cards))


def parse_timing(line: str):
    """The child's `VOCALIS_TIMING audio_s=… load_s=… compute_s=… nfe=…` line, as a dict of
    floats — or None if this isn't that line.

    Returns None when `load_s` is 0: that is the child telling us its pre-load was refused,
    so `compute_s` still has the model load inside it. An unusable measurement is not a
    measurement, and half of one is worse than none.
    """
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
