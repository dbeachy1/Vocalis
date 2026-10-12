"""Coordinate one pending SillyTavern write through the paired browser extension.

The extension performs writes from the authenticated page. This module records a short-lived
request, and the extension claims it through the existing poll route before fetching the payload.

🔴 **Claimed, not broadcast.** Multiple SillyTavern tabs can race to write the same card, and
`merge-attributes` is a read-modify-write on a PNG: the loser's copy is
the one that survives, silently. `claim()` reads and clears under one lock.

🔴 **One job at a time; a second request is refused rather than queued.** The editor sends the
document it has open. Persisting a queued write across restart could apply an obsolete revision.
`request()`
returns False while one is in flight and the pane says so.

🔴 **A hidden tab may not collect immediately.** Browsers throttle timers in hidden tabs, so the
request waits for `PENDING_S` and the UI reports it as queued.

⚠️ Requests are in memory, so restart drops a pending send. This state does not access the vault.
"""
from __future__ import annotations

import threading
import time

from loguru import logger

from . import doorbell

#: A claimed send that never reports back. The extension posts its result even on failure, so
#: reaching this means the tab was closed mid-write or the browser dropped the request. Shorter
#: than the sweep's five minutes because a send is ONE document, not the whole install: a card is
#: a single `merge-attributes` call and a book a single save, so a minute of silence is already
#: pathological rather than slow.
STALE_RUN_S = 60.0

#: How long an uncollected job waits. This exceeds common hidden-tab timer throttling while
#: limiting how long an obsolete write can remain pending.
#:
#: ⚠️ **IT IS A CEILING ON WAITING, NOT A QUEUE.** `request()` still refuses a second job, so a send
#: parked here blocks the next one — which is why the pane offers Cancel rather than only a spinner.
PENDING_S = 600.0

_LOCK = threading.Lock()
_job: dict | None = None        # requested, not yet claimed
_job_at = 0.0                   # when it was requested; 0 when there is none
_running: dict | None = None    # claimed, in flight
_started_at = 0.0
_result: dict | None = None     # the last completed send


def request(doc_id: str, revision: int, *, kind: str, name: str,
            dropped: list[str] | None = None) -> bool:
    """Request a send. False means one is already pending or in flight.

    `kind` and `name` ride along ONLY so the status line can say which document is being sent
    without a second lookup — they are our own record of our own store, never content.

    🔴 **`dropped` IS CARRIED FROM THE MOMENT OF THE PRESS, NOT REPORTED BACK AFTERWARD.** The
    caller has already built the plan, so omitted fields are known before the write starts and can
    be reported while it is in progress.
    """
    global _job, _job_at
    with _LOCK:
        _reap_locked()
        if _job is not None or _in_flight_locked():
            return False
        _job = {"id": str(doc_id), "revision": int(revision), "kind": str(kind), "name": str(name),
                "dropped": list(dropped or [])}
        _job_at = time.time()
    # m5c — outside the lock, and only on the branch that actually created a job. Ringing on the
    # refused branch would wake every tab to poll and find nothing, which is the failure mode a
    # doorbell has: it costs a round trip per listener and teaches them the bell means nothing.
    doorbell.ring()
    return True


def cancel() -> None:
    """Withdraw a request nobody collected.

    🔴 **THE UI GIVING UP MUST CLEAR THE FLAG**, for the reason `sweep.cancel` gives and one more:
    an uncollected sweep that fires an hour later is an unwanted import, but an uncollected SEND
    that fires later is an unwanted **write into SillyTavern**, of a revision the user may
    have replaced twice since. Pending has to mean "someone is waiting for this right now".
    """
    global _job, _job_at
    with _LOCK:
        _job = None
        _job_at = 0.0


def claim() -> dict | None:
    """Take the pending send, if there is one. A dict means *you* are doing it.

    🔴 Reading and clearing under ONE lock — see the module note about two tabs and a
    read-modify-write on a PNG.
    """
    global _job, _job_at, _running, _started_at
    with _LOCK:
        _reap_locked()
        if _job is None or _in_flight_locked():
            return None
        _running, _job = _job, None
        _job_at = 0.0
        _started_at = time.time()
        return dict(_running)


def finish(result: dict) -> bool:
    """The extension reporting what it managed. Ends the run whether or not it went well.

    🔴 **RETURNS WHETHER IT ACTUALLY ENDED ONE, AND THE CALLER MUST USE THAT.** A.4 stopped an
    unclaimed report from being filed, but `pair.py` was clearing `avatar_dirty` on the
    document *before* calling this and never learned that the report had been dropped — so a
    token holder POSTing `{"ok": true, "avatar": true, "id": …}` with nothing in flight changed
    the store while every status route went on telling the truth. Silent, and
    invisible to the existing tests because they all polled first. A `None` return made that
    mistake easy to make; `bool` makes it hard.

    🔴 **ONLY THE RUN THAT IS ACTUALLY IN FLIGHT CAN BE ENDED**

    This took any report from any caller and cleared whatever was running, which reopened from
    the far side the exact hole `_reap_locked` was written to close. The sequence:

      t=0   tab A claims send A and hangs (the ST write calls carry no timeout).
      t=60  `_reap_locked` expires it — `_result` is an honest {ok: false, expired: true}.
      t=62  A new request for document B is claimed.
      t=70  tab A's write finally returns and POSTs {"ok": true}.

    The old code then wrote A's success over B's in-flight run: the Editor, polling for **B**,
    saw "not pending, not running, last.ok" and rendered *"saved to SillyTavern"* for a document
    that had not been written yet. Worse, `_running` was cleared, so a third Send was accepted
    while B's write was still going — two `merge-attributes` read-modify-writes on one PNG,
    which is the lost update `claim()` exists to prevent.

    ⚠️ **A REPORT WITH NOTHING IN FLIGHT IS DROPPED, NOT FILED.** It is either a late arrival
    whose run has already been reaped and honestly reported, or a caller that never claimed —
    and in both cases the truthful `last` is the one already there.

    ⚠️ `id` is compared when the report carries one. It is not required: the extension has always
    been allowed to report without echoing it, and demanding it now would break a tab mid-upgrade
    — but when it IS present and does not match, the report is about a different send.

    ⚠️ **AND `id` IS THE DOCUMENT ID, NOT A UNIQUE RUN ID — SO ONE CASE REMAINS.** Two sends of
    the SAME document, where the first is reaped and the second claimed inside the window, cannot
    be told apart by this check; the `_running is None` guard above still stops the worst of it
    (an invented success, and a released lock), but a late report would close the second run
    early. Closing that properly needs a per-claim token echoed back, which is an extension
    change and therefore a wire-contract change — deliberately not smuggled in here. It is the
    narrow case: same document, twice, inside 60 s, with the first tab hung.
    """
    global _running, _started_at, _result
    with _LOCK:
        if _running is None:
            logger.info("wbedit: a send report arrived with nothing in flight — dropped")
            return False
        reported = result.get("id")
        if reported and reported != _running.get("id"):
            logger.info("wbedit: a send report named another run — dropped")
            return False
        _running = None
        _started_at = 0.0
        _result = dict(result)
        _result["at"] = time.time()
        return True


def status() -> dict:
    """What the Editor's send line renders. Every field is a fact, never an inference.

    ⚠️ Reaps before reporting, so "not pending and not running" is always accompanied by a `last`
    describing *this* send — see `_reap_locked`.
    """
    with _LOCK:
        _reap_locked()
        return {
            "pending": dict(_job) if _job else None,
            "running": dict(_running) if _running else None,
            "last": dict(_result) if _result else None,
        }


def _in_flight_locked() -> bool:
    """A claimed send that has not reported and has not aged out. Caller holds `_LOCK`.

    ⚠️ **The timeout is what stops one dropped request wedging the feature forever.** Without it a
    tab closed mid-write leaves `_running` set, and every later Send is refused as "one is already
    running" with no way back short of restarting Vocalis.
    """
    return _running is not None and (time.time() - _started_at) < STALE_RUN_S


def _reap_locked() -> None:
    """Age out a job nobody collected, or a run that never reported. Caller holds `_LOCK`.

    🔴 **AN EXPIRY MUST LEAVE A RESULT BEHIND, AND THIS IS A BUG FIX, NOT ONLY NEW PLUMBING.** The
    pane's terminal test is *"not pending and not running"*, and it then reads `last`. Aging a job
    out without recording anything therefore made it read the PREVIOUS send's result — so a write
    the tab dropped on the floor was reported as **"saved to SillyTavern"**, in green, because the
    send before it had gone fine. `_in_flight_locked()` has always expired `_running` silently, so
    that was reachable before m4w: close the tab mid-write and the next poll congratulates you.

    A reaped job is a failure with a reason, which is what the pane already knows how to render.
    """
    global _job, _job_at, _running, _started_at, _result
    now = time.time()
    if _job is not None and (now - _job_at) >= PENDING_S:
        name = _job.get("name") or "the document"
        _job, _job_at = None, 0.0
        _result = {"ok": False, "at": now, "expired": True,
                   "reason": "no SillyTavern tab collected it — " + str(name)
                             + " was not sent. Open SillyTavern and press Send again."}
    if _running is not None and (now - _started_at) >= STALE_RUN_S:
        name = _running.get("name") or "the document"
        _running, _started_at = None, 0.0
        _result = {"ok": False, "at": now, "expired": True,
                   "reason": "SillyTavern took the job and never reported back — " + str(name)
                             + " may or may not have been written. Check it, then send again."}
