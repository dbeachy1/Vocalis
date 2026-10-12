"""Coordinate a one-shot SillyTavern library import with the browser extension.

The extension already has the authenticated browser session, so Vocalis records a pending request
for the extension to collect rather than storing or scraping session credentials. `claim()` clears
that request under one lock so only one tab performs the sweep. State is process-local and is
discarded on restart; it does not access the vault.
"""
from __future__ import annotations

import threading
import time

from loguru import logger

from . import doorbell

#: Seconds since a poll before the extension is considered disconnected.
LIVE_WINDOW_S = 16.0

#: A claimed sweep that never reports back. The extension posts its summary even on failure, so
#: reaching this means the tab was closed mid-sweep or the browser dropped it. Bounded so the UI
#: stops saying "importing…" over nothing.
STALE_RUN_S = 300.0

#: Maximum age in seconds for an unclaimed import request.
PENDING_S = 600.0

_LOCK = threading.Lock()
_requested = False
_requested_at = 0.0             # when the button was pressed; 0 when nothing is pending
_seen_at = 0.0
#: The extension build stamp last seen on a poll, "" until one reports (9.5.17).
_build = ""                  # last poll from any extension
#: 9.7.3 — the TAB'S OWN verdict on whether it is running the copy SillyTavern is serving:
#: "current", "stale", or "" / "unknown" when it could not find out. See `note_poll`.
_self_check = ""
_started_at = 0.0               # when a sweep was claimed; 0 when none is running
_result: dict | None = None     # the last completed sweep's summary


def note_poll(build: str = "", self_check: str = "") -> None:
    """Record that an extension is alive, WHICH COPY of it, and whether that copy is current.

    The extension reports its build and its own comparison with the copy SillyTavern serves. The
    self-check has three states: `"current"`, `"stale"`, or empty when the extension cannot decide.
    Only an explicit `"stale"` reports a mismatch. Empty defaults preserve compatibility with older
    extensions that do not send these fields.
    """
    global _seen_at, _build, _self_check
    with _LOCK:
        _seen_at = time.time()
        if build:
            _build = build
        if self_check:
            _self_check = self_check


def request() -> None:
    """Record a pending import request and notify connected extension tabs."""
    global _requested, _requested_at
    with _LOCK:
        _reap_locked()
        _requested = True
        _requested_at = time.time()
    # m5c — ring the doorbell OUTSIDE the lock. `ring()` takes the registry's lock, and holding
    # ours across it is the classic two-lock ordering hazard; there is also nothing to protect,
    # because the flag is already set and a listener that arrives late simply polls and finds it.
    doorbell.ring()


def cancel() -> None:
    """Withdraw a request nobody collected.

    Clear an unclaimed request when its waiting UI is canceled, so a later tab cannot collect it.
    """
    global _requested, _requested_at
    with _LOCK:
        _requested = False
        _requested_at = 0.0


def claim() -> bool:
    """Take the pending sweep, if there is one. True means *you* are doing it.

    🔴 Reading and clearing under ONE lock is the whole point — see the module note about two
    tabs. A `pending()` read followed by a `clear()` write is the same bug with more steps.
    """
    global _requested, _requested_at, _started_at
    with _LOCK:
        _reap_locked()
        if not _requested:
            return False
        _requested = False
        _requested_at = 0.0
        _started_at = time.time()
        return True


def finish(summary: dict) -> None:
    """The extension reporting what it managed. Ends the run whether or not it went well.

    🔴 **A REPORT WITHOUT AN ACTIVE CLAIM IS DROPPED.** Otherwise an unclaimed
    `POST /pair/sweep {"ok": true, "books": 12}` could report an import that did not run, or a
    late report from a reaped run could overwrite the tally of a later active run.

    ⚠️ `_started_at` is the claim flag here, not a `_running` dict: `claim()` sets it and this is
    the only thing that clears it. Zero means nobody is importing.
    """
    global _started_at, _result
    with _LOCK:
        if _started_at == 0.0:
            logger.info("wbedit: a sweep report arrived with nothing in flight — dropped")
            return
        _started_at = 0.0
        _result = dict(summary)
        _result["at"] = time.time()


def status() -> dict:
    """What the Library pane renders. Every field is a fact, never an inference.

    `connected` means a recent poll or an open extension stream, not merely that an installation
    exists. The poll timestamp remains a liveness signal while a page has not yet opened a stream.
    """
    now = time.time()
    with _LOCK:
        _reap_locked()
        running = _started_at > 0.0 and (now - _started_at) < STALE_RUN_S
        return {
            "connected": doorbell.count() > 0 or (now - _seen_at) < LIVE_WINDOW_S,
            "pending": _requested,
            "running": running,
            "last": dict(_result) if _result else None,
            # Extension build identifier, empty until a tab reports it.
            "build": _build,
            # Tab-reported comparison with the extension copy currently served by SillyTavern.
            "self_check": _self_check,
        }


def _reap_locked() -> None:
    """Age out a request nobody collected. Caller holds `_LOCK`.

    Expiration records an explicit empty result so the UI cannot mistake a prior summary for this
    request. Claimed runs are aged out separately by `status()`; an import request itself writes
    nothing until the extension reports its summary.
    """
    global _requested, _requested_at, _result
    now = time.time()
    if _requested and (now - _requested_at) >= PENDING_S:
        _requested, _requested_at = False, 0.0
        _result = {"at": now, "expired": True, "books": 0, "cards": 0, "personas": 0,
                   "unchanged": 0, "failed": [],
                   "reason": "no SillyTavern tab collected the request — nothing was imported. "
                             "Open SillyTavern and press this again."}
