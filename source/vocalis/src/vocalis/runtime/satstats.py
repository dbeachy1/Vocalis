"""Background GPU telemetry polling for configured satellites.

The browser reads cached samples through the local system stream; it never contacts satellites
directly. A manager reconciles one poller per configured satellite. Polling runs only while the
local strip is watched, uses a faster cadence when healthy, and exposes only readings younger
than `STALE_S`. Health capabilities are checked periodically so older satellites without
`gpustats` are not polled continuously.
"""
import threading
import time

from loguru import logger

from vocalis.runtime import satellites

#: Healthy poll cadence, in seconds.
POLL_UP_S = 0.25

#: 1 Hz while a satellite that DOES have the verb is failing to answer it — an error, a
#: timeout, a 5xx. Slower than the up rate on purpose: a satellite that has gone quiet is not
#: worth hammering four times a second while it stays quiet.
POLL_DOWN_S = 1.0

#: How often the verb list (and the satellite's reported version, for the log line) is
#: re-asked while a satellite is being watched. `satellites.health()` makes a real network call
#: every time — there is no cache to ride on — so this is deliberately much coarser than the
#: gpustats cadence above: a health call costs the same as a render's "is it even on?" probe,
#: and running it at 4 Hz would be four health probes for every one that a satellite offering
#: the verb actually needs.
VERB_RECHECK_S = 5.0

#: "Watched" means `gpu.strip_sample()` was called within this many seconds. 2 s rather than
#: something tighter: the strip itself only redraws around 4 Hz, and a value close to that
#: would flap a satellite's poller on and off between ordinary browser paint jitter.
WATCH_S = 2.0

#: Maximum age of a sample returned by `snapshot()`, independent of poll cadence.
STALE_S = 3.0

#: How often the manager thread re-reads `satellites.configured()` for satellites added or
#: removed in Settings. A second is fast enough that "I just added a satellite" does not read
#: as broken, and cheap enough to run forever: it is a settings read, never a network call.
MANAGE_S = 1.0

#: The per-satellite thread's own wake interval when nothing is due yet. Bounds how quickly a
#: resumed watch, a verb upgrade, or a cadence change is noticed — deliberately well under
#: POLL_UP_S's own 250 ms so "the first reading after a page opens arrives within one poll"
#: (§6.1) is true rather than aspirational.
TICK_S = 0.05

#: Injectable monotonic clock for deterministic scheduling checks.
_now = time.monotonic

_LOCK = threading.Lock()
_LAST_WATCH = [0.0]          # monotonic of the last watch() call — 0.0 means "never"
_GOOD: dict = {}             # satellite name -> {"t": monotonic, "gpus": [...]} — last good poll
_RUNTIME: dict = {}          # satellite name -> scheduling/logging state, see `_new_runtime`
_THREADS: dict = {}          # satellite name -> its running `_Poller`
_MANAGER: list = []          # the manager thread, if running (a list so `start` is idempotent)
_MANAGER_STOP = threading.Event()


def watch() -> None:
    """Stamp "someone is reading the strip right now". Called from `gpu.strip_sample()` on
    EVERY call — a tab, an SSE stream, a job's `vram` ticker — which is exactly the set of
    things "watched" is defined to mean. Cheap: one monotonic write under a lock, no network,
    safe to call at 4 Hz from as many threads as have the strip open."""
    with _LOCK:
        _LAST_WATCH[0] = _now()


def _watched(now: float) -> bool:
    with _LOCK:
        last = _LAST_WATCH[0]
    return bool(last) and (now - last) <= WATCH_S


def _new_runtime() -> dict:
    """Fresh per-satellite scheduling state. `mode` exists purely so a transition is logged
    once rather than on every poll — see `poll_once`'s own comments at each of its four
    transitions."""
    return {"mode": "unknown",        # "unknown" | "paused" | "no_verb" | "up" | "down"
            "next_poll": 0.0,         # next monotonic time a gpustats() call is allowed
            "next_verb_check": 0.0,   # next monotonic time health() may be asked again
            "has_verb": None}         # None = not yet checked; True/False once it has been


def poll_once(name: str, stop_event: threading.Event | None = None) -> bool | None:
    """One scheduling decision for satellite `name`: is anyone watching, does it currently
    offer `gpustats`, and does the cadence say to poll it right now — polling AT MOST ONCE per
    call. Returns True on a fresh good reading, False on a poll that was attempted and failed,
    None where nothing was due (paused, no verb yet known/offered, or between ticks, or a good
    reading that arrived after this call's own poller was told to stop — see `stop_event` below).

    `stop_event` is the poller's stop flag when called from `_run`. A response that arrives after
    removal is discarded so a stopped poller cannot recreate its cached entry.
    """
    now = _now()
    with _LOCK:
        rt = _RUNTIME.setdefault(name, _new_runtime())

    if not _watched(now):
        # Avoid logging an initial paused state; log only when an active watch stops.
        if rt["mode"] not in ("paused", "unknown"):
            logger.info(f"satellite {name!r} stats: watching stopped — polling paused")
        rt["mode"] = "paused"
        return None

    if rt["mode"] == "paused":
        # Watching resumed. Re-decide up/down/no_verb from scratch rather than assuming the
        # last-known state is still true — a satellite can come and go while nobody was
        # looking, and "resumed" says nothing about what it will say on the next actual poll.
        logger.info(f"satellite {name!r} stats: watching resumed — polling resumed")
        rt["mode"] = "unknown"

    # `next_verb_check` starts at 0.0, so the first watched tick always asks. Gating on the
    # time alone — not also on "no verb list yet" — is what holds an unreachable satellite's
    # retries to the 1 Hz set below instead of a health probe on every 50 ms tick.
    if now >= rt["next_verb_check"]:
        h = satellites.health(name)
        if not h.get("reachable"):
            # Unreachable means the capability is unknown, not absent. Preserve a known verb
            # list; otherwise retry the health check at the down cadence.
            if rt["has_verb"] is None:
                rt["next_verb_check"] = now + POLL_DOWN_S
                if rt["mode"] != "down":
                    logger.warning(f"satellite {name!r} stats: down (unreachable) — "
                                   f"retrying at {1.0 / POLL_DOWN_S:g} Hz")
                    rt["mode"] = "down"
                return False
            rt["next_verb_check"] = now + VERB_RECHECK_S
            h = {"verbs": ["gpustats"] if rt["has_verb"] else []}
        rt["next_verb_check"] = now + VERB_RECHECK_S
        has_verb = "gpustats" in (h.get("verbs") or [])
        if has_verb != rt["has_verb"]:
            version = h.get("satellite_version") or "?"
            if has_verb:
                logger.info(f"satellite {name!r} stats: 'gpustats' verb detected "
                           f"(satellite {version}) — polling begins")
            else:
                logger.info(f"satellite {name!r} stats: no 'gpustats' verb "
                           f"(satellite {version}) — not polled")
        rt["has_verb"] = has_verb
        if not has_verb:
            rt["mode"] = "no_verb"
            return None

    if not rt["has_verb"]:
        return None

    if now < rt["next_poll"]:
        return None

    from satellite_client import SatelliteError
    import vocalis_satellite_protocol as proto      # sys.path already carries satellite/ — the
    # SatelliteError import just above put it there as a side effect of loading satellite_client,
    # so this is never the first import of the protocol module.

    try:
        d = satellites.client_for(name).gpustats()
        gpus = list(d.get("gpus") or [])
    except (SatelliteError, proto.ProtocolError) as exc:
        # `client_for(name)` raises `SatelliteError` for a satellite that is not configured or
        # has no shared secret; `.gpustats()` wraps every transport failure (TLS, DNS, timeout, a
        # non-200, bad JSON) into `SatelliteError` too — except a corrupt or truncated sealed
        # reply, which surfaces as `vocalis_satellite_protocol.ProtocolError` from `open_frames`
        # and is never rewrapped. Those two names are the whole surface a satellite round trip
        # can raise; anything else escaping here would be a genuine bug worth seeing in a
        # traceback rather than folded into "down".
        rt["next_poll"] = now + POLL_DOWN_S
        if rt["mode"] != "down":
            logger.warning(f"satellite {name!r} stats: down ({type(exc).__name__}) — "
                           f"polling at {1.0 / POLL_DOWN_S:g} Hz")
            rt["mode"] = "down"
        return False

    if stop_event is not None and stop_event.is_set():
        # The poller was stopped while the request was in flight; do not recreate removed state.
        logger.info(f"satellite {name!r} stats: a poll finished after its poller was stopped — "
                   f"discarding the reading")
        return None

    with _LOCK:
        _GOOD[name] = {"t": now, "gpus": gpus}
    rt["next_poll"] = now + POLL_UP_S
    if rt["mode"] != "up":
        logger.info(f"satellite {name!r} stats: up ({len(gpus)} card"
                   f"{'s' if len(gpus) != 1 else ''}, {1.0 / POLL_UP_S:g} Hz)")
        rt["mode"] = "up"
    return True


def snapshot() -> list:
    """`[{"name": ..., "gpus": [...]}]`, sorted by name — every satellite whose last GOOD
    reading is younger than STALE_S. NEVER makes a network call: this only ever reads `_GOOD`,
    which the background pollers keep filled. Empty where nothing is fresh, never None — the
    key in `strip_sample()`'s payload is always a list."""
    now = _now()
    with _LOCK:
        items = [(name, g) for name, g in _GOOD.items() if now - g["t"] < STALE_S]
    items.sort(key=lambda kv: kv[0])
    return [{"name": name, "gpus": g["gpus"]} for name, g in items]


class _Poller:
    """One daemon thread per configured satellite. All the actual scheduling lives in
    `poll_once`; this is only the real-time wrapper around it, exactly the split `ups.py` and
    `power.py` draw between their poll function and `_loop`. Kept as a tiny object rather than
    a bare thread so `_reconcile` has something to hold, start, and stop by name."""

    def __init__(self, name: str):
        self.name = name
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name=f"satstats-{name}")
        # Suppress repeated tracebacks of the same exception type until a poll succeeds.
        self._unexpected_exc_type = None

    def start(self) -> None:
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        self._thread.join(timeout=timeout)

    def _handle_unexpected(self, exc: Exception) -> float:
        """Called from `_run`'s `except` block (so `logger.exception` still sees the live
        traceback). Logs once per exception TYPE and returns how long to wait before retrying.

        An unexpected exception must not escape the poll loop or trigger a rapid retry. Log each
        exception type once and use the slower down cadence; a successful poll resets suppression.
        """
        exc_type = type(exc)
        if exc_type is not self._unexpected_exc_type:
            logger.exception(f"satellite {self.name!r} stats poller hit an unexpected "
                             f"{exc_type.__name__} — retrying at {1.0 / POLL_DOWN_S:g} Hz "
                             f"until a poll succeeds")
            self._unexpected_exc_type = exc_type
        return POLL_DOWN_S

    def _run(self) -> None:
        # Every exception is swallowed and the loop continues — the same reasoning
        # power.py's `_loop` gives at length: a poller that dies on one bad read leaves this
        # satellite's section frozen (or worse, silently stuck showing a stale reading right up
        # until STALE_S catches it), which is worse than the one tick it is discarding.
        while not self._stop.is_set():
            try:
                # `stop_event=self._stop` is the ghost-entry guard: a poll that finishes AFTER
                # this poller was told to stop must not write `_GOOD`/`_RUNTIME` back in. See
                # `poll_once`'s own comment.
                poll_once(self.name, stop_event=self._stop)
            except Exception as exc:                                  # noqa: BLE001
                self._stop.wait(self._handle_unexpected(exc))
                continue
            self._unexpected_exc_type = None      # a clean poll — the next bug logs afresh
            self._stop.wait(TICK_S)


def _reconcile() -> None:
    """Make the running pollers match `satellites.configured()` — new entries start, removed
    ones stop and their reading is dropped from `snapshot()` immediately rather than riding out
    STALE_S. Called by the manager thread every MANAGE_S, and directly by tests."""
    names = {e["name"] for e in satellites.configured()}
    with _LOCK:
        current = set(_THREADS)

    for name in names - current:
        p = _Poller(name)
        with _LOCK:
            _THREADS[name] = p
        p.start()
        logger.info(f"satellite {name!r} stats: polling thread started")

    for name in current - names:
        with _LOCK:
            p = _THREADS.pop(name, None)
        if p is None:
            continue
        p.stop()                      # joined before its state is torn down, below
        with _LOCK:
            _GOOD.pop(name, None)
            _RUNTIME.pop(name, None)
        logger.info(f"satellite {name!r} stats: polling thread stopped — satellite removed")


def _manage_loop() -> None:
    while not _MANAGER_STOP.is_set():
        try:
            _reconcile()
        except Exception:                                            # noqa: BLE001
            logger.exception("satstats: reconciling configured satellites failed — retrying "
                             "on the next tick")
        _MANAGER_STOP.wait(MANAGE_S)


def start():
    """Start the manager thread once. Returns it (always — there is no hardware gate here the
    way `power.start()`/`ups.start()` have one: a box with zero satellites configured simply
    runs a manager thread that finds nothing to poll).

    Called from main(), NOT create_app() — same reason as every other sampler in this package:
    the suite builds hundreds of apps and none of them should start a thread reading
    `satellites.configured()`, let alone dialing one."""
    with _LOCK:
        if _MANAGER:
            return _MANAGER[0]
        _MANAGER_STOP.clear()
        t = threading.Thread(target=_manage_loop, daemon=True, name="satstats-manager")
        _MANAGER.append(t)
    t.start()
    return t


def stop(timeout: float = 2.0) -> None:
    """Stop the manager and every per-satellite poller, and forget all state. For the suite;
    production never calls it.

    Stop and join pollers before clearing shared state. In-flight requests check their stop event
    before writing a sample, preventing state from reappearing after shutdown."""
    _MANAGER_STOP.set()
    with _LOCK:
        mgr, _MANAGER[:] = list(_MANAGER), []
        pollers = list(_THREADS.values())
    for t in mgr:
        t.join(timeout=timeout)
    for p in pollers:
        p.stop(timeout=timeout)
    with _LOCK:
        _THREADS.clear()
        _GOOD.clear()
        _RUNTIME.clear()
        _LAST_WATCH[0] = 0.0
