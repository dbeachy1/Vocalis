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

#: Handed from the first test to the second. Module state is sound here for the same reason the
#: pair is: one file, one worker, in order.
_LEAKED: dict = {}

#: Ceiling on how long the stand-in thread waits to be joined before giving up. It is never the
#: thing that ends a green run: the thread ends the moment the fixture calls `join` on it. If the
#: fixture is deleted nobody joins, the thread sits out this ceiling, and the second test sees it
#: alive and fails -- which is exactly the failure this pair exists to produce.
_JOIN_CEILING_S = 10.0


def test_a_reconcile_thread_can_outlive_the_test_that_started_it():
    """Shaped exactly like the real one: same name, same daemon flag, deliberately still running
    when this test ends. The assertion is that the LEAK IS REAL — if this thread had finished by
    itself the pair below would prove nothing.

    No clock decides how long it runs: the stand-in blocks on `joined`, which is set only when
    someone calls `join()` on it. Nothing in this test does, so it is alive when the test ends by
    construction; the conftest fixture's `t.join(...)` at teardown is the one thing that releases
    it, so the second test finding it stopped proves the fixture joined THIS thread."""
    started, joined = threading.Event(), threading.Event()

    def _slow_reconcile():
        started.set()
        joined.wait(timeout=_JOIN_CEILING_S)

    t = threading.Thread(target=_slow_reconcile, daemon=True, name="satellite-reconcile")
    real_join = t.join

    def _join_and_release(*args, **kwargs):
        joined.set()                      # the caller IS joining: let the thread finish
        return real_join(*args, **kwargs)

    t.join = _join_and_release
    t.start()
    assert started.wait(timeout=5), "the stand-in thread never got going"
    _LEAKED["t"] = t
    assert t.is_alive(), (
        "this test has to END while its thread is still running — that IS the leak being "
        "reproduced. It is held open until something joins it, so reaching this failure means "
        "the thread was joined or released by something other than the fixture.")


def test_and_the_next_test_finds_it_already_joined():
    """The fixture ran at the previous test's teardown, so by here the thread is done.

    🔴 Without `_no_satellite_reconcile_outlives_its_test` in conftest this fails: the thread
    only ends when it is joined, and nothing else joins it. That is the whole point —
    delete the fixture and this goes red, which is what stops the fix being quietly removed.
    (It used to sleep for a second and rely on the gap between two tests being milliseconds.)"""
    t = _LEAKED.get("t")
    assert t is not None, (
        "ordering broke: the first test in this file must run first, on this worker. "
        "pytest.ini pins --dist loadfile, which is what guarantees it.")
    assert not t.is_alive(), (
        "a 'satellite-reconcile' thread is STILL RUNNING inside the next test. It holds the GPU "
        "gate, so the next PUT /devices will take the 'a render holds the cards' early return and "
        "some unrelated test will fail saying its request never reached the satellite.")
