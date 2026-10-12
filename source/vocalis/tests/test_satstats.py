"""`vocalis.runtime.satstats` — remote GPU readings folded into the local strip (10.21).

DESIGN_10_21_FAN_AND_SATELLITE_STRIP.md §6. The interesting logic lives in `poll_once`, one
scheduling decision at a time, in the same split `ups.py`/`power.py` draw between their poll
function and `_loop`: every cadence test below drives `poll_once` directly with a hand-advanced
fake clock and NO real sleep at all, and only the concurrency test (a slow satellite must not
delay another) needs a real thread, because that is a claim about threads and nothing else can
prove it.
"""
import threading
import time

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from satellite_client import SatelliteError
from vocalis.runtime import gpu as gpu_mod
from vocalis.runtime import satellites
from vocalis.runtime import satstats


@pytest.fixture(autouse=True)
def _clean_satstats_state():
    """Every global in the module, reset around each test — the same reasoning `test_ups.py`'s
    own `_clean_module_state` gives: `_GOOD`/`_RUNTIME` are resolve-and-remember caches, and a
    real `_Poller` thread left running from one test would go on reading whatever fake client
    THAT test installed, under every test after it."""
    satstats.stop()
    yield
    satstats.stop()


class _FakeClock:
    """An injected monotonic clock: advanced by hand, never by a real sleep. `satstats._now` is
    a module-level name precisely so this can replace it."""

    def __init__(self, t: float = 1_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class _FakeClient:
    """Stands in for `satellites.client_for(name)`. `fail` toggles the exception path so a test
    can flip a satellite from answering to erroring mid-run.

    Raises `SatelliteError` — the real type `poll_once`'s narrowed `except (SatelliteError,
    proto.ProtocolError)` actually catches, since `SatelliteClient.gpustats()` wraps every
    transport failure into it (see `satellite_client.py`)."""

    def __init__(self, gpus=None, fail=False):
        self.calls = 0
        self.gpus = gpus if gpus is not None else [{"index": 0, "name": "fake"}]
        self.fail = fail

    def gpustats(self):
        self.calls += 1
        if self.fail:
            raise SatelliteError("satellite went quiet")
        return {"gpus": list(self.gpus)}


def _up_health(name):
    return {"reachable": True, "verbs": ["gpustats"], "satellite_version": "2.0"}


# ── cadence: 4 Hz up, 1 Hz down, 0 unwatched ─────────────────────────────────────────────────

def test_no_polls_at_all_while_nobody_is_watching(monkeypatch):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    calls = {"health": 0, "client": 0}
    monkeypatch.setattr(satellites, "health",
                        lambda n: (calls.__setitem__("health", calls["health"] + 1), _up_health(n))[1])
    monkeypatch.setattr(satellites, "client_for",
                        lambda n: (calls.__setitem__("client", calls["client"] + 1), _FakeClient())[1])

    for _ in range(10):
        assert satstats.poll_once('test-satellite') is None
        clock.advance(1.0)                  # ten full seconds, never watched once
    assert calls == {"health": 0, "client": 0}, (
        "an unwatched satellite must cost neither a health probe nor a gpustats call")
    assert satstats.snapshot() == []


def test_four_hz_while_the_satellite_answers(monkeypatch):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    assert satstats.poll_once('test-satellite') is True, "the first reading must arrive within one poll"
    assert fake.calls == 1

    # Advancing by exactly the 4 Hz interval each time must allow exactly one more poll.
    for want_calls in range(2, 6):
        clock.advance(satstats.POLL_UP_S)
        satstats.watch()
        assert satstats.poll_once('test-satellite') is True
        assert fake.calls == want_calls

    # And asking again before the interval elapses must NOT re-poll.
    clock.advance(satstats.POLL_UP_S / 2)
    satstats.watch()
    assert satstats.poll_once('test-satellite') is None
    assert fake.calls == 5


def test_one_hz_while_the_satellite_is_down_or_erroring(monkeypatch):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient(fail=True)
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    assert satstats.poll_once('test-satellite') is False
    assert fake.calls == 1

    # Too soon for even the down cadence: no second attempt.
    clock.advance(0.3)
    satstats.watch()
    assert satstats.poll_once('test-satellite') is None
    assert fake.calls == 1

    # A full second later, the down cadence allows exactly one more attempt.
    clock.advance(satstats.POLL_DOWN_S - 0.3)
    satstats.watch()
    assert satstats.poll_once('test-satellite') is False
    assert fake.calls == 2


def test_recovering_from_down_returns_to_four_hz(monkeypatch):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient(fail=True)
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    assert satstats.poll_once('test-satellite') is False
    clock.advance(satstats.POLL_DOWN_S)
    satstats.watch()
    fake.fail = False                       # the satellite came back
    assert satstats.poll_once('test-satellite') is True
    assert satstats.snapshot() == [{"name": 'test-satellite', "gpus": fake.gpus}]

    clock.advance(satstats.POLL_UP_S)
    satstats.watch()
    assert satstats.poll_once('test-satellite') is True, "a recovered satellite must poll at 4 Hz again"


# ── the 3-second rule ─────────────────────────────────────────────────────────────────────────

def test_a_stale_reading_drops_and_a_good_poll_restores_it(monkeypatch):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient(gpus=[{"index": 0, "name": "fake"}])
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    assert satstats.poll_once('test-satellite') is True
    assert satstats.snapshot() == [{"name": 'test-satellite', "gpus": [{"index": 0, "name": "fake"}]}]

    clock.advance(satstats.STALE_S + 0.1)    # no poll happens in between — a dead satellite
    assert satstats.snapshot() == [], "a reading older than STALE_S must not still be reported"

    satstats.watch()
    assert satstats.poll_once('test-satellite') is True
    assert satstats.snapshot() == [{"name": 'test-satellite', "gpus": [{"index": 0, "name": "fake"}]}], (
        "a fresh good poll must restore the entry immediately")


# ── a satellite without the verb ─────────────────────────────────────────────────────────────

def test_a_satellite_without_the_gpustats_verb_is_never_polled(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)
    monkeypatch.setattr(satellites, "health",
                        lambda n: {"reachable": True, "verbs": [], "satellite_version": "1.14"})
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)

    satstats.watch()
    for _ in range(20):
        assert satstats.poll_once('test-satellite') is None
        clock.advance(satstats.POLL_UP_S)
        satstats.watch()
    assert fake.calls == 0, "an old satellite with no gpustats verb must never be asked for it"
    assert satstats.snapshot() == []


def test_an_unreachable_satellite_is_down_not_verbless(monkeypatch, capfd):
    """A sleeping 2.0 satellite answers health with `{"reachable": False}` and no `verbs`. That
    is "down", retried at 1 Hz — never "no gpustats verb", and a verb list already learned
    survives it so the 1 Hz gpustats poll carries on."""
    state = {"up": False}
    monkeypatch.setattr(satellites, "health",
                        lambda n: _up_health(n) if state["up"] else
                        {"reachable": False, "error": "timed out", "devices": [], "ready": False})
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)

    health_calls = []
    real_health = satellites.health
    monkeypatch.setattr(satellites, "health", lambda n: (health_calls.append(clock.t), real_health(n))[1])

    for _ in range(12):                          # 3 s at the 4 Hz tick
        satstats.watch()
        assert satstats.poll_once('test-satellite') in (False, None)
        clock.advance(satstats.POLL_UP_S)
    assert len(health_calls) == 3, "unreachable with no verb list yet: health retried at 1 Hz"
    assert fake.calls == 0

    state["up"] = True
    clock.advance(satstats.POLL_DOWN_S)
    satstats.watch()
    assert satstats.poll_once('test-satellite') is True

    # Now it sleeps again: health says unreachable, but the learned verb is kept and the
    # gpustats poll itself drops to 1 Hz.
    state["up"] = False
    fake.fail = True
    clock.advance(satstats.VERB_RECHECK_S)
    before = fake.calls
    for _ in range(8):                           # 2 s at the 4 Hz tick
        satstats.watch()
        satstats.poll_once('test-satellite')
        clock.advance(satstats.POLL_UP_S)
    assert fake.calls - before == 2, "a known-2.0 satellite that went away is polled at 1 Hz"
    out = capfd.readouterr().err
    assert "no 'gpustats' verb" not in out, out


def test_an_upgraded_satellite_is_picked_up_without_a_restart(monkeypatch):
    """The verb list is re-asked while watched — an old satellite that gets upgraded to 2.0
    must start being polled on its own, with no restart of the local service."""
    verbs = {"v": []}
    monkeypatch.setattr(satellites, "health",
                        lambda n: {"reachable": True, "verbs": list(verbs["v"]),
                                   "satellite_version": "2.0"})
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)

    satstats.watch()
    satstats.poll_once('test-satellite')
    assert fake.calls == 0

    verbs["v"] = ["gpustats"]                # the satellite was upgraded
    clock.advance(satstats.VERB_RECHECK_S)   # the next verb re-check is due
    satstats.watch()
    assert satstats.poll_once('test-satellite') is True
    assert fake.calls == 1


# ── add / remove of a configured satellite ───────────────────────────────────────────────────

def test_a_configured_satellite_starts_and_a_removed_one_stops_and_is_dropped(monkeypatch):
    cfg = [{"name": 'test-satellite', "url": 'https://test-satellite.invalid:7880'}]
    monkeypatch.setattr(satellites, "configured", lambda: list(cfg))
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats._reconcile()
    assert set(satstats._THREADS) == {'test-satellite'}

    cfg.append({"name": "sample-remote", "url": "https://sample-remote.invalid:7880"})
    satstats._reconcile()
    assert set(satstats._THREADS) == {'test-satellite', "sample-remote"}, "a satellite added in Settings must start"

    cfg.pop(0)                                             # configured satellite removed
    satstats._reconcile()
    assert set(satstats._THREADS) == {"sample-remote"}, "a removed satellite's thread must stop"
    assert 'test-satellite' not in satstats._GOOD
    assert 'test-satellite' not in satstats._RUNTIME


# ── a slow satellite must not delay another's readings ───────────────────────────────────────

def test_a_slow_satellite_does_not_delay_another(monkeypatch):
    """🔴 The reason this is one thread PER satellite. A hung request on "slow" must not stop
    "fast" from being polled at its own cadence — proven with real threads and Events, since a
    fake clock cannot demonstrate that two threads genuinely ran concurrently."""
    monkeypatch.setattr(satellites, "configured",
                        lambda: [{"name": "slow", "url": "https://slow.lan"},
                                 {"name": "fast", "url": "https://fast.lan"}])
    monkeypatch.setattr(satellites, "health", _up_health)

    slow_entered = threading.Event()
    slow_release = threading.Event()

    class _SlowClient:
        def gpustats(self):
            slow_entered.set()
            slow_release.wait(timeout=5)          # held open by the test, not by a sleep
            return {"gpus": []}

    fast_lock = threading.Lock()
    fast_calls = [0]
    fast_polled_twice = threading.Event()

    class _FastClient:
        def gpustats(self):
            with fast_lock:
                fast_calls[0] += 1
                if fast_calls[0] >= 2:
                    fast_polled_twice.set()
            return {"gpus": []}

    clients = {"slow": _SlowClient(), "fast": _FastClient()}
    monkeypatch.setattr(satellites, "client_for", lambda n: clients[n])

    satstats.watch()
    satstats._reconcile()
    try:
        assert slow_entered.wait(timeout=2), "the slow satellite's poller never even started"
        satstats.watch()      # keep the strip "watched" across the second wait window
        assert fast_polled_twice.wait(timeout=2), (
            "'fast' was delayed behind 'slow''s hung request — they must run on separate threads")
    finally:
        slow_release.set()
        satstats.stop()


# ── logging: transitions only, never per poll ────────────────────────────────────────────────

def test_transition_logs_fire_once_not_once_per_poll(monkeypatch, capsys):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    for _ in range(20):
        satstats.poll_once('test-satellite')
        clock.advance(satstats.POLL_UP_S)
        satstats.watch()
    out = capsys.readouterr().out
    assert out.count("stats: up (") == 1, out
    assert out.count("'gpustats' verb detected") == 1, out


def test_a_swallowed_exception_is_logged_once_with_its_type(monkeypatch, capsys):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient(fail=True)
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    for _ in range(5):
        satstats.poll_once('test-satellite')
        clock.advance(satstats.POLL_DOWN_S)
        satstats.watch()
    out = capsys.readouterr().out
    assert out.count("stats: down (SatelliteError)") == 1, out


def test_watching_stopped_and_resumed_are_each_logged_once(monkeypatch, capsys):
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    satstats.poll_once('test-satellite')                    # up
    clock.advance(satstats.WATCH_S + 1.0)          # nobody re-watched — it lapses
    for _ in range(5):
        satstats.poll_once('test-satellite')                 # paused, five times over
        clock.advance(0.1)
    satstats.watch()                               # a tab opens again
    satstats.poll_once('test-satellite')

    out = capsys.readouterr().out
    assert out.count("watching stopped") == 1, out
    assert out.count("watching resumed") == 1, out


# ── strip_sample(): the key is always present, and it costs no network call ─────────────────

def test_strip_sample_carries_satellites_and_makes_no_network_call(monkeypatch):
    def _boom(*_a, **_k):
        raise AssertionError("strip_sample() must never touch the network")
    monkeypatch.setattr(satellites, "client_for", _boom)
    monkeypatch.setattr(satellites, "health", _boom)
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])

    sample = gpu_mod.strip_sample()
    assert "satellites" in sample
    assert sample["satellites"] == []


def test_strip_sample_reports_a_satellite_a_background_poll_already_found(monkeypatch):
    """`snapshot()` is a pure read of `_GOOD` — populating it directly (as the real background
    poller would) and then calling `strip_sample()` proves the wiring without any thread."""
    satstats._GOOD['test-satellite'] = {"t": satstats._now(), "gpus": [{"index": 0, "name": "fake"}]}
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    sample = gpu_mod.strip_sample()
    assert sample["satellites"] == [{"name": 'test-satellite', "gpus": [{"index": 0, "name": "fake"}]}]


def test_strip_sample_calls_satstats_watch(monkeypatch):
    """An earlier draft of `gpu.strip_sample()` had its `satstats.watch()` call site replaced
    with `pass`, and the rest of this suite stayed green: the test above populates
    `_GOOD` DIRECTLY, as the real background poller would, so it never exercises `watch()` at
    all, and nothing else here calls `strip_sample()` and then checks who is "watched". Without
    that call site wired up, `poll_once`'s own §6.1 cadence rule ("no polls when nobody has read
    the strip") is unconditionally true in production — every satellite's poller sits paused
    forever, because nothing ever tells it a tab is open.

    The assertion below verifies that `strip_sample()` starts watching on every call, including a
    cache hit."""
    assert not satstats._watched(satstats._now()), (
        "must start unwatched or this test cannot tell 'watch() ran' from 'always watched'")
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])

    gpu_mod.strip_sample()

    assert satstats._watched(satstats._now()), (
        "gpu.strip_sample() must call satstats.watch() on every call, even a cache hit")


# ── ghost entry: a poll that finishes after removal must not resurrect the satellite ─────────

def test_a_poll_that_finishes_after_its_poller_is_stopped_does_not_resurrect_it(monkeypatch):
    """`_reconcile()`'s `p.stop(timeout=2.0)` gives up on
    the join long before a poll blocked inside `satellites.health()` (up to HEALTH_TIMEOUT, 5 s)
    can return, so a satellite removed in Settings can still have a poll in flight after
    `_GOOD`/`_RUNTIME` are already popped and "polling thread stopped — satellite removed" is
    already logged. Without the fix, that straggling poll finishes normally and writes
    `_GOOD[name]` right back in — the removed satellite reappears in the header for up to
    STALE_S more seconds under a log line that already claimed it was gone.

    Proven deterministically: a fake `health()` blocks on a real `Event` the test itself
    controls, never a sleep or a timeout race. `_reconcile()`'s own `p.stop(timeout=2.0)` still
    costs two real seconds here, the same as `test_a_slow_satellite_does_not_delay_another`
    above — unavoidable, since the join timing itself is what is being exercised — but the
    STRAGGLING POLL'S completion is awaited by joining ITS thread directly, not by sleeping."""
    entered = threading.Event()
    release = threading.Event()

    def _slow_health(name):
        entered.set()
        release.wait(timeout=5)
        return {"reachable": True, "verbs": ["gpustats"], "satellite_version": "2.0"}

    cfg = [{"name": 'test-satellite', "url": 'https://test-satellite.invalid'}]
    monkeypatch.setattr(satellites, "configured", lambda: list(cfg))
    monkeypatch.setattr(satellites, "health", _slow_health)
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    satstats.watch()
    satstats._reconcile()                       # starts the configured satellite's poller
    assert entered.wait(timeout=2), "the poller never even called health()"
    poller = satstats._THREADS['test-satellite']           # held here so it can be joined directly below

    cfg.clear()                                  # the satellite is removed while health() blocks
    removed = threading.Event()

    def _remove():
        satstats._reconcile()                    # blocks up to 2 s inside p.stop()'s join
        removed.set()
    remover = threading.Thread(target=_remove)
    remover.start()
    assert removed.wait(timeout=4), "_reconcile() itself hung removing the satellite"
    remover.join(timeout=1)

    # The removal already completed and logged — exactly as before this fix.
    assert 'test-satellite' not in satstats._THREADS
    assert 'test-satellite' not in satstats._GOOD
    assert 'test-satellite' not in satstats._RUNTIME

    release.set()                                # now let the stuck poll finish
    poller._thread.join(timeout=2)
    assert not poller._thread.is_alive(), "the stopped poller's thread never finished"

    assert 'test-satellite' not in satstats._GOOD, (
        "a poll that finished AFTER its poller was stopped must not resurrect the satellite")
    assert satstats.snapshot() == []


# ── unexpected exceptions: logged once per type, retried at the down cadence ─────────────────

def test_an_unexpected_exception_is_logged_once_per_type_and_waits_the_down_cadence(capsys):
    """An exception from `poll_once` must be caught by `_Poller._run` (a
    genuine bug — the brief's example is a fake client raising `AttributeError`) escaped
    `_Poller._run`'s bare `except Exception`, which logged a full traceback and waited only
    TICK_S (50 ms): twenty tracebacks a second, forever, since nothing on that path ever sets
    `next_poll`/`next_verb_check`.

    Drives `_Poller._handle_unexpected` directly — the wait/log decision factored out of `_run`
    for exactly this reason — with no thread and no real sleep at all."""
    poller = satstats._Poller('test-satellite')

    def _raise_and_handle(exc_type, msg):
        # Narrowed to the two types this test actually raises below — no blanket `except
        # Exception` (and no new `# noqa: BLE001`) needed just to drive a helper.
        try:
            raise exc_type(msg)
        except (AttributeError, RuntimeError) as exc:
            return poller._handle_unexpected(exc)

    wait1 = _raise_and_handle(AttributeError, "no such attribute")
    wait2 = _raise_and_handle(AttributeError, "no such attribute, again")
    assert wait1 == satstats.POLL_DOWN_S == wait2, (
        "an unexpected exception must be retried at the DOWN cadence, not TICK_S")

    out = capsys.readouterr().out
    assert out.count("unexpected AttributeError") == 1, (
        f"the SAME exception type repeating must log its traceback once, not on every retry: {out}")

    # A DIFFERENT exception type is a different bug and must be reported again.
    wait3 = _raise_and_handle(RuntimeError, "a different bug")
    assert wait3 == satstats.POLL_DOWN_S
    out = capsys.readouterr().out
    assert out.count("unexpected RuntimeError") == 1, out

    # And the SAME AttributeError recurring after `_run` recorded a clean poll (`_unexpected_
    # exc_type` reset to None) must be reported again too — "until a poll succeeds" is per
    # OCCURRENCE of quiet, not a permanent silence.
    poller._unexpected_exc_type = None
    wait4 = _raise_and_handle(AttributeError, "back again after a clean poll")
    assert wait4 == satstats.POLL_DOWN_S
    out = capsys.readouterr().out
    assert out.count("unexpected AttributeError") == 1, out


def test_run_wiring_retries_at_the_down_cadence_not_tick_s(monkeypatch):
    """Integration over the REAL `_Poller` thread, not just the factored decision — proving
    `_run` actually calls `_handle_unexpected` and waits its returned duration, rather than
    falling through to the old `TICK_S` wait. `POLL_DOWN_S` is sped up so the test does not cost
    a real second per retry; both `_run` and `_handle_unexpected` read it live off the module, so
    this still exercises the true cadence relationship, only faster — never a bare `time.sleep`
    used as the synchronization itself (an `Event.wait(timeout=...)` is)."""
    monkeypatch.setattr(satstats, "POLL_DOWN_S", 0.15)
    monkeypatch.setattr(satstats, "TICK_S", 0.01)
    times = []
    third_call = threading.Event()

    def _boom_poll_once(name, stop_event=None):
        times.append(time.monotonic())
        if len(times) == 3:
            third_call.set()
        raise AttributeError("no such attribute")

    monkeypatch.setattr(satstats, "poll_once", _boom_poll_once)
    poller = satstats._Poller('test-satellite')
    poller.start()
    try:
        assert third_call.wait(timeout=2), "the poller stopped retrying after the exception"
    finally:
        poller.stop(timeout=2)

    gaps = [b - a for a, b in zip(times, times[1:])]
    assert all(g >= satstats.POLL_DOWN_S * 0.5 for g in gaps), (
        f"each retry must wait roughly POLL_DOWN_S, not the 50 ms TICK_S: {gaps}")


# ── startup: "unknown" never logs "watching stopped" ──────────────────────────────────────────

def test_startup_never_watched_never_logs_watching_stopped(monkeypatch, capsys):
    """At startup every configured satellite's runtime begins in mode
    "unknown": nobody has opened a tab yet, so `_watched()` is false for every one of them before
    a single poll ever happened. Logging "watching stopped — polling paused" on THAT transition
    printed one line per configured satellite on every boot, for polling that never started in
    the first place. up/down/no_verb -> paused (a tab that WAS watching just closed) is still
    worth the line; only "unknown" -> "paused" is suppressed."""
    clock = _FakeClock()
    monkeypatch.setattr(satstats, "_now", clock)
    monkeypatch.setattr(satellites, "health", _up_health)
    fake = _FakeClient()
    monkeypatch.setattr(satellites, "client_for", lambda n: fake)

    for _ in range(10):                          # nobody ever calls watch()
        assert satstats.poll_once('test-satellite') is None
        clock.advance(1.0)

    out = capsys.readouterr().out
    assert "watching stopped" not in out, out
    assert fake.calls == 0
