"""Ensure a satellite reconcile thread cannot outlive the test that started it.

🔴 WHY THIS FILE EXISTS. `PUT /devices` reconciles the satellites off the request thread — a
daemon thread, spawned per request, never joined (`web/ui.py`). `client.put(...)` returning does
not mean it has finished, and `_reconcile_satellites` holds the GPU gate across the whole
reconcile while the NEXT test's reconcile tries to take it with `GPUS.acquire(timeout=0.1)`. A
thread that outlives its test therefore makes a LATER test take the "a render holds the cards"
early return and fail claiming its request never reached the satellite.

If reconciliation is detached from the request thread, a request can return while its worker still
holds the GPU gate. The fixture joins that worker at teardown; this ordered pair models the leak
and verifies that the next test starts only after the worker has stopped.

⚠️ THE TWO TESTS BELOW ARE AN ORDERED PAIR and only mean something in order. `pytest.ini` pins
`--dist loadfile`, so a file's tests stay on one worker and keep their ordering — which is the
property that makes this testable at all. If that ever changes to plain `--dist load`, the second
test degrades to a vacuous pass (a different worker has no such thread) rather than a false
failure, so it fails safe.
"""
import threading
import time

#: Handed from the first test to the second. Module state is sound here for the same reason the
#: pair is: one file, one worker, in order.
_LEAKED: dict = {}

#: Long enough that "did the fixture join it?" cannot be confused with "did it happen to finish?".
#: The gap between one test ending and the next starting is milliseconds; this is a thousand of
#: them. Well inside the fixture's own 10 s join ceiling, so a green run pays exactly this once.
_RUNS_FOR_S = 1.0


def test_a_reconcile_thread_can_outlive_the_test_that_started_it():
    """Shaped exactly like the real one: same name, same daemon flag, deliberately still running
    when this test ends. The assertion is that the LEAK IS REAL — if this thread had finished by
    itself the pair below would prove nothing."""
    started = threading.Event()

    def _slow_reconcile():
        started.set()
        time.sleep(_RUNS_FOR_S)

    t = threading.Thread(target=_slow_reconcile, daemon=True, name="satellite-reconcile")
    t.start()
    assert started.wait(timeout=5), "the stand-in thread never got going"
    _LEAKED["t"] = t
    assert t.is_alive(), (
        "this test has to END while its thread is still running — that IS the leak being "
        "reproduced. If this fails, _RUNS_FOR_S is too short to model it.")


def test_and_the_next_test_finds_it_already_joined():
    """The fixture ran at the previous test's teardown, so by here the thread is done.

    🔴 Without `_no_satellite_reconcile_outlives_its_test` in conftest this fails: the thread
    sleeps for a second and the gap between two tests is milliseconds. That is the whole point —
    delete the fixture and this goes red, which is what stops the fix being quietly removed."""
    t = _LEAKED.get("t")
    assert t is not None, (
        "ordering broke: the first test in this file must run first, on this worker. "
        "pytest.ini pins --dist loadfile, which is what guarantees it.")
    assert not t.is_alive(), (
        "a 'satellite-reconcile' thread is STILL RUNNING inside the next test. It holds the GPU "
        "gate, so the next PUT /devices will take the 'a render holds the cards' early return and "
        "some unrelated test will fail saying its request never reached the satellite.")
