"""A devices Save that arrives while ANOTHER Save's satellite reconcile is loading is not lost
(October 10, 2026).

Seen live (a Windows Vocalis with a two-card satellite on the AMD Linux test machine): the user ticked the satellite's first card
and, at once, its second. The first Save took the card gate and loaded the model on the satellite
(about 9 s). The second Save's `GPUS.acquire(timeout=0.1)` failed and was logged as "a render holds
the cards"; nothing applied it afterwards. The satellite was sent {cuda:0: 1, cuda:1: 0} and never
the second card, while Settings showed the second card ticked.

What is real: `PUT /devices`, `ui._reconcile_satellites`, the real settings file in a temp folder.
What is faked: `satellites.reconcile` (it blocks on an event, so the "load" lasts exactly as long as
the test wants, with no sleeps) and, in two tests, the gate, to put a render in the window between
the first apply and the follow-up.
"""
import threading

import pytest
from loguru import logger

import vocalis.runtime.gpu as gpu_mod
import vocalis.runtime.satellites as sat_mod
import vocalis.runtime.settings as rt_settings
import vocalis.web.ui as ui
import vocalis_server as vs
from vocalis.runtime.gpu import GPUS

SAT0, SAT1 = "test-satellite:cuda:0", "test-satellite:cuda:1"


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [{"index": 0, "name": "Test Card A"}])
    monkeypatch.setattr(sat_mod, "health", lambda name: {"reachable": False, "error": "not running",
                                                         "devices": [], "ready": False})
    # The busy flag is module state: a test that fails must not poison the next one.
    monkeypatch.setattr(ui, "_sat_applying", False, raising=False)
    monkeypatch.setattr(ui, "_sat_pending", None, raising=False)


@pytest.fixture
def log():
    lines = []
    sink = logger.add(lambda m: lines.append(str(m)), level="INFO")
    yield lines
    logger.remove(sink)


class Reconcile:
    """A fake `satellites.reconcile`. The FIRST call blocks until `release_first` is set; every call
    is recorded; `fail_on` makes the n-th call (1-based) raise."""

    def __init__(self, fail_on=()):
        self.calls = []
        self.first_entered = threading.Event()
        self.release_first = threading.Event()
        self.fail_on = set(fail_on)

    def __call__(self, plan):
        self.calls.append(dict(plan))
        n = len(self.calls)
        if n == 1:
            self.first_entered.set()
            assert self.release_first.wait(10), "the test never released the first load"
        if n in self.fail_on:
            raise RuntimeError(f"load {n} blew up")
        return {}


def _reconcile_threads():
    return [t for t in threading.enumerate() if t.name == "satellite-reconcile" and t.is_alive()]


def _join(threads):
    for t in threads:
        t.join(timeout=10)
        assert not t.is_alive(), "a reconcile thread is stuck"


def _put(client, sat0=False, sat1=False):
    r = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": SAT0, "enabled": sat0},
        {"id": SAT1, "enabled": sat1}]})
    assert r.status_code == 200
    return r


def test_saves_during_a_load_collapse_into_one_follow_up_with_the_newest_plan(
        client, monkeypatch, log):
    rec = Reconcile()
    monkeypatch.setattr(sat_mod, "reconcile", rec)

    _put(client, sat0=True)                                   # the first Save: starts loading
    assert rec.first_entered.wait(10)
    (first,) = _reconcile_threads()

    _put(client, sat0=True, sat1=True)                        # second Save, during the load
    _put(client, sat1=True)                                   # third Save: the newest plan
    # Neither of them waited for the load: their threads have already ended while it is blocked.
    _join([t for t in _reconcile_threads() if t is not first])
    assert rec.calls == [{SAT0: 1}], "nothing may be applied while the first load holds the gate"
    assert [m for m in log if "another settings change is still loading" in m], \
        "the log line for this case must say what is true"
    assert not [m for m in log if "a render holds the cards" in m], \
        "and must not blame a render"

    rec.release_first.set()
    _join([first])
    assert rec.calls == [{SAT0: 1}, {SAT1: 1}], (
        "exactly one follow-up, carrying the newest saved plan (not the second Save's, not both)")
    assert ui._sat_applying is False and ui._sat_pending is None


def test_the_follow_up_applies_what_is_saved_now_not_the_plan_that_arrived_last(
        client, monkeypatch):
    """Saves are not serialized, so the last plan to ARRIVE at the reconcile is not necessarily the
    last one saved. The follow-up reads the saved devices."""
    rec = Reconcile()
    monkeypatch.setattr(sat_mod, "reconcile", rec)
    _put(client, sat0=True)
    assert rec.first_entered.wait(10)
    (first,) = _reconcile_threads()
    _put(client, sat1=True)                                   # the newest save, saved last ...
    _join([t for t in _reconcile_threads() if t is not first])
    # ... but a stale thread delivers an OLDER plan to the reconcile afterwards.
    t = threading.Thread(target=ui._reconcile_satellites, args=({SAT0: 1, SAT1: 1},),
                         name="satellite-reconcile")
    t.start()
    t.join(10)
    rec.release_first.set()
    _join([first])
    assert rec.calls == [{SAT0: 1}, {SAT1: 1}]


def test_a_save_while_a_render_holds_the_gate_is_deferred_with_no_follow_up(
        client, monkeypatch, log):
    rec = Reconcile()
    monkeypatch.setattr(sat_mod, "reconcile", rec)
    assert GPUS.acquire(timeout=1), "the gate should be free in a test"
    try:                                                      # stands in for a render
        _put(client, sat0=True)
        _join(_reconcile_threads())
    finally:
        GPUS.release()
    assert rec.calls == []
    assert [m for m in log if "a render holds the cards" in m and "next pool build" in m]
    assert not [m for m in log if "another settings change" in m]
    # Nothing is queued behind it: letting the render go applies nothing by itself ...
    assert _reconcile_threads() == [] and rec.calls == []
    assert ui._sat_applying is False and ui._sat_pending is None
    # ... and the next Save works as normal.
    rec.release_first.set()
    _put(client, sat1=True)                       # a changed selection (an unchanged one is not reconciled)
    _join(_reconcile_threads())
    assert rec.calls == [{SAT1: 1}]


class _RenderTakesTheGateAfterTheFirstApply:
    """A gate whose release() is followed, at once, by a render taking it."""

    def __init__(self):
        self.render_holds = False
        self.releases = 0

    def acquire(self, timeout=None):
        return not self.render_holds

    def release(self):
        self.releases += 1
        if self.releases == 1:
            self.render_holds = True


def test_a_follow_up_that_finds_a_render_holding_the_gate_falls_back_to_the_deferral(
        monkeypatch, log):
    gate = _RenderTakesTheGateAfterTheFirstApply()
    monkeypatch.setattr(ui, "GPUS", gate)
    rec = Reconcile()
    monkeypatch.setattr(sat_mod, "reconcile", rec)
    first = threading.Thread(target=ui._reconcile_satellites, args=({SAT0: 1},),
                             name="satellite-reconcile")
    first.start()
    assert rec.first_entered.wait(10)
    ui._reconcile_satellites({SAT0: 1, SAT1: 1})              # returns at once: the load is running
    rec.release_first.set()
    _join([first])
    assert rec.calls == [{SAT0: 1}], "the follow-up must not run while a render holds the gate"
    assert [m for m in log if "a render holds the cards" in m and "follow-up" in m]
    assert ui._sat_applying is False and ui._sat_pending is None
    # The deferral dropped the pending plan (the next pool build reads the settings); a later Save
    # is a fresh first apply.
    gate.render_holds = False
    ui._reconcile_satellites({SAT1: 1})
    assert rec.calls == [{SAT0: 1}, {SAT1: 1}]


def test_a_failing_follow_up_is_logged_and_does_not_escape(monkeypatch, log):
    rec = Reconcile(fail_on=(2,))
    monkeypatch.setattr(sat_mod, "reconcile", rec)
    escaped = []
    monkeypatch.setattr(threading, "excepthook", lambda args: escaped.append(args))
    first = threading.Thread(target=ui._reconcile_satellites, args=({SAT0: 1},),
                             name="satellite-reconcile")
    first.start()
    assert rec.first_entered.wait(10)
    ui._reconcile_satellites({SAT0: 1, SAT1: 1})
    rec.release_first.set()
    _join([first])
    assert rec.calls == [{SAT0: 1}, {SAT0: 1, SAT1: 1}]
    assert escaped == [], "nothing may kill the thread"
    failed = [m for m in log if "(follow-up) failed" in m and "load 2 blew up" in m]
    assert failed, log
    assert ui._sat_applying is False and ui._sat_pending is None, \
        "a failure must not leave every later Save queued behind a flag nobody clears"


def test_a_failing_first_apply_is_logged_and_the_pending_plan_is_still_applied(monkeypatch, log):
    rec = Reconcile(fail_on=(1,))
    monkeypatch.setattr(sat_mod, "reconcile", rec)
    escaped = []
    monkeypatch.setattr(threading, "excepthook", lambda args: escaped.append(args))
    first = threading.Thread(target=ui._reconcile_satellites, args=({SAT0: 1},),
                             name="satellite-reconcile")
    first.start()
    assert rec.first_entered.wait(10)
    ui._reconcile_satellites({SAT1: 1})
    rec.release_first.set()
    _join([first])
    assert rec.calls == [{SAT0: 1}, {SAT1: 1}]
    assert escaped == []
    assert [m for m in log if "satellite reconcile failed" in m and "load 1 blew up" in m], log
