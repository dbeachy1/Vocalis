#!/usr/bin/env python3
"""Estimate book render time from measured wall-clock throughput rather than a hardware lookup table. Accumulate observations for the active configuration, use elapsed wall time rather than summed worker time, and return no estimate until enough data is available."""
import datetime
import threading
from pathlib import Path

import yaml
from loguru import logger

from tts_utils import atomic_replace, cache_root

# The first chunk on each worker pays for model warm-up, and a short book's first section
# can be a chapter heading. So a rate is not trusted until the run has some road behind it:
# a rate from 200 characters and 8 seconds is noise wearing a number's clothes.
MIN_CHARS = 2000
MIN_SECONDS = 45.0

# record() is a read-modify-write. Its one caller is a RENDER, which GPUS still holds
# exclusively, so it would be safe BY ACCIDENT and unprotected BY CONSTRUCTION — and its twin
# enhance_rate.record() is genuinely raced by the book's per-card workers, and since 4.1-M16
# by two background enhancements on two cards. The two stores are deliberately identical;
# leaving one of them relying on a lock it does not own is how the next caller gets bitten.
_LOCK = threading.Lock()


def enough(chars: float, seconds: float) -> bool:
    """Is there enough of a run behind us to quote a rate from it?"""
    return float(chars) >= MIN_CHARS and float(seconds) >= MIN_SECONDS


def gpu_name() -> str:
    """Return the runtime device identity used to separate rate measurements. Treat the name as a cache key only, never as a lookup into assumed performance values."""
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:                       # noqa: BLE001 — a probe, not a dependency
        pass
    return "cpu"


def _workers_key(workers) -> str:
    """Return a stable worker-count component for scalar or per-device settings. Collapse uniform device mappings to the equivalent scalar key so older measurements remain reusable; keep non-uniform configurations distinct."""
    if not isinstance(workers, dict):
        return str(int(workers or 1))
    items = sorted((str(d), int(n or 1)) for d, n in workers.items())
    if not items:
        return "1"
    counts = [n for _, n in items]
    remote = [d for d, _ in items if not _is_local_device(d)]
    if remote:
        # 🔴 The satellite's NAME has to be in the key. `gpu_name` describes THIS box, so a
        # satellite-only pool of one worker and a *different* satellite-only pool of one worker
        # produce an identical key and the second inherits the first's measured rate — a wrong
        # ETA, quietly, which is exactly what this key exists to prevent. Before 5.3 the card
        # name plus the counts fully described the hardware; with another machine in the pool
        # they no longer do.
        return "+".join(str(n) for n in counts) + "@" + ",".join(remote)
    if len(set(counts)) == 1:
        return str(counts[0])                    # uniform LOCAL -> the pre-5.3 key, byte for byte
    return "+".join(str(n) for n in counts)      # e.g. "1+3" across two local cards


def _is_local_device(device: str) -> bool:
    """A card in THIS box. The canonical rule is `satellite_client.split_device`, which is not
    imported here on purpose: `render_rate` is reached by `book_to_audio.py` standalone and must
    not acquire a dependency on the satellite stack to name a key. Kept in step by
    `test_the_local_device_rule_matches_split_device`, which asserts the two agree.
    """
    d = str(device)
    return d.startswith("cuda") or d == "cpu"


def key_for(gpu_name: str, cards: int, workers) -> str:
    """Identity of a RENDERING CONFIGURATION, not of a card.

    Two cards render a book roughly twice as fast as one of them does, so a rate measured
    on one config says nothing about another. Changing --gpus or --workers gives a new key
    and starts measuring again, rather than quietly reusing a number that no longer applies.

    `workers` is an int, or the `{device: count}` dict the per-device settings produce (5.3).
    Enabling a satellite therefore changes the key, which is correct: a pool with another
    machine's card in it does not render at the rate this box was measured at.
    """
    return f"{gpu_name or 'cpu'}|{int(cards)}c{_workers_key(workers)}w"


def _path() -> Path:
    # cache_root() is documented as regenerable and safe to delete: the worst a wipe costs
    # is that the next render has no upfront estimate and measures itself again.
    return cache_root() / "render_rates.yaml"


class RateStoreUnreadable(Exception):
    """The rate store exists and will not parse. record() must ABORT on this.

    Twin of enhance_rate.RateStoreUnreadable, for the same reason: _load() used to return
    {} on a bad parse and record() wrote one key back over it, erasing every OTHER
    rendering configuration this box had ever measured. The cache is regenerable, so the
    loss is bounded — but it is a loss taken for no gain at all, and the code's own comment
    claimed it was ignoring the corrupt file while it overwrote it."""


def _load(*, strict: bool = False) -> dict:
    """strict=True (record()) raises RateStoreUnreadable rather than returning {}.

    ABSENT is not corrupt — a box that has never rendered returns {} under both.

    🔴 And a wrong key is neither: VaultAuthError is a BaseException and sails past the
    `except Exception` below, to an M5 boundary. See enhance_rate._load — same shape, same
    reason, same store."""
    import vault_fs
    p = _path()
    if not vault_fs.exists(p):
        return {}
    try:
        d = yaml.safe_load(vault_fs.read_text(p)) or {}
    except Exception as exc:                # noqa: BLE001 — a corrupt cache is not an outage
        logger.exception(f"render-rate cache unreadable — ignoring it: {p}")
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
    """The measured rate for this configuration in chars/sec, or None if we have never
    measured it (or have not measured ENOUGH of it). None means: say nothing."""
    row = _load().get(key) or {}
    chars, secs = float(row.get("chars") or 0), float(row.get("seconds") or 0)
    if not enough(chars, secs):
        return None
    return chars / secs


def record(key: str, chars: float, seconds: float) -> None:
    """Add a completed render to the selected configuration’s running totals. Accumulation prevents one unusually short or long render from determining the estimate; hold the lock for the complete read-modify-write."""
    if float(seconds) <= 0 or float(chars) <= 0:
        return
    with _LOCK:
        try:
            rates = _load(strict=True)
        except RateStoreUnreadable:
            # Never write one timing over the history of every other configuration, and
            # never fail a finished render over its own bookkeeping.
            logger.warning("render-rate cache unreadable — NOT recording this run over it "
                           "(the store keeps whatever it has)")
            return
        row = rates.get(key) or {}
        rates[key] = {
            "chars": round(float(row.get("chars") or 0) + float(chars)),
            "seconds": round(float(row.get("seconds") or 0) + float(seconds), 1),
            "updated": datetime.datetime.now().replace(microsecond=0).isoformat(),
        }
        # a crash mid-write must not eat the history — atomic on both arms. THE LOCK STAYS:
        # the vault makes the WRITE atomic and does nothing for the read-modify-write.
        import vault_fs
        vault_fs.write_yaml_atomic(_path(), {"rates": rates}, sort_keys=True)


def eta_seconds(chars_left: float, rate: float):
    """Seconds of wall clock left, or None if there is no rate to base it on."""
    if not rate or rate <= 0:
        return None
    return max(0.0, float(chars_left)) / float(rate)
