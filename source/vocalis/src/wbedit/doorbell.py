"""The push channel's listener registry and wake-up signal.

🔴 **A DOORBELL, NOT A DELIVERY.** Everything that crosses this channel is the single fact *"there
is work"*. It never carries a job, an id, a revision or a name, and the reason is not tidiness:

`/pair/poll` does not merely report — it **claims**. `sweep.claim()` hands a sweep to exactly one
caller and `push.claim()` does the same for a send, because multiple SillyTavern tabs can race and
`merge-attributes` is a read-modify-write on a PNG. An SSE stream is a
**broadcast**: putting the job in the event hands the same job to every open tab at once, which is
precisely the lost-update race `claim()` exists to prevent, arriving disguised as an optimization.

So the sequence stays:

    Vocalis  --event: work-->  every open tab      (this module)
    tab      --GET /pair/poll-->  Vocalis          (the existing atomic claim; exactly one wins)

📌 Everything downstream of the claim is untouched by m5c. This replaces *when the tab asks*, never
*what happens when it does*.

⚠️ **It also keeps document prose off the wire**: an SSE frame ends up in
proxy logs and devtools panes, and "there is work" is the only thing that can safely live there.

🔴 **WHY THE KEEPALIVE IS SERVER-SIDE, AND WHY IT IS THE ONLY WAY A DEAD TAB IS NOTICED.** The whole
point of m5c is that the client runs no timer — a hidden tab's timer is throttled to once a minute
and eventually once per five, which is the bug this milestone exists to kill. So the liveness
mechanism has to be ours. It doubles as the reaper: a generator blocked in `Queue.get()` never
discovers that the browser went away, because it is not writing. Every `KEEPALIVE_S` it writes a
`: comment` line, and *that* is the write that raises when the socket is gone, unwinds the
generator and runs its `finally`. Without it a closed tab leaks a worker thread forever.
"""
from __future__ import annotations

import itertools
import queue
import threading

#: How often each open stream writes a `: keepalive` comment. Two jobs, both load-bearing: idle
#: proxies do not close the connection, and a tab that has gone away is discovered within this many
#: seconds rather than never (see the module note).
KEEPALIVE_S = 20.0

#: 🔴 A HARD CAP, BECAUSE EACH OPEN STREAM OCCUPIES A SERVER THREAD FOR AS LONG AS THE TAB IS OPEN.
#: Vocalis serves through `make_server(..., threaded=True)`, so a long-lived response is a thread,
#: not a coroutine. The cap allows multiple tabs while leaving capacity for other server work. A
#: client refused here is not broken — it
#: falls back to the poll path, which is exactly why that path is being kept (§9a.25).
MAX_STREAMS = 8

_LOCK = threading.Lock()
_subs: dict[int, queue.Queue] = {}
_ids = itertools.count(1)


def subscribe() -> tuple[int, queue.Queue] | None:
    """Register a listener. Returns `(id, queue)`, or `None` when the cap is reached.

    ⚠️ The caller MUST `unsubscribe(id)` in a `finally`, or the registry counts a stream that is
    no longer there — and `count()` is what tells the Library a SillyTavern tab is listening, so a
    leaked entry makes Vocalis confidently wrong about the one thing this channel exists to know.
    """
    with _LOCK:
        if len(_subs) >= MAX_STREAMS:
            return None
        sid = next(_ids)
        # maxsize=1 — this is an edge, not a mailbox. Ten rings while a tab is busy sweeping must
        # collapse into one "go and look", not queue ten redundant polls behind it.
        _subs[sid] = queue.Queue(maxsize=1)
        return sid, _subs[sid]


def unsubscribe(sid: int) -> None:
    with _LOCK:
        _subs.pop(sid, None)


def ring() -> int:
    """Wake every open stream. Returns how many were rung, for the caller's log.

    Called by `sweep.request()` and `push.request()` — the two places a job comes into existence.
    """
    with _LOCK:
        subs = list(_subs.values())
    for q in subs:
        try:
            q.put_nowait(1)
        except queue.Full:
            # Already rung and not yet collected. The listener will look once and find whatever is
            # pending, so a second token would only make it look twice for the same reason.
            pass
    return len(subs)


def count() -> int:
    """How many streams are open right now.

    🔴 This is the m5c liveness answer, and it is a FACT rather than the inference `LIVE_WINDOW_S`
    makes from recent polls: Vocalis is the server on these connections, so it knows. ⚠️ It is not
    the *whole* answer — see `sweep.status()`, which combines it with the poll window so an older
    extension copy still reads as connected until it is reloaded.
    """
    with _LOCK:
        return len(_subs)


def reset() -> None:
    """Drop every registration. Tests only — the module is process-global state, so a stream left
    registered by one test is a wrong `count()` in whichever unrelated test draws the next liveness
    assertion.

    ⚠️ Under `pytest-xdist --dist loadfile`, tests in one file share an interpreter. Clearing
    the process-global registry prevents one test's subscriptions from affecting another."""
    with _LOCK:
        _subs.clear()
