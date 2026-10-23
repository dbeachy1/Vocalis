"""Tests for WorkerPool device parsing, dispatch, and error isolation without loading a GPU model.

The suite constructs workers with fakes and patches generation calls. GPU-backed parallelism is verified separately on target hardware.
"""
import threading

import pytest
import torch

import tts_utils
from tts_utils import parse_devices, GenParams, WorkerPool, VocalisError


# ── parse_devices ─────────────────────────────────────────────────────────────

def test_parse_devices_cpu():
    assert parse_devices("cpu") == ["cpu"]


def test_parse_devices_all(monkeypatch):
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)
    assert parse_devices("all") == ["cuda:0", "cuda:1"]
    assert parse_devices(None) == ["cuda:0", "cuda:1"]   # None defaults to 'all'


def test_parse_devices_all_falls_back_to_cpu_when_no_cuda(monkeypatch):
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 0)
    assert parse_devices("all") == ["cpu"]


def test_parse_devices_explicit_list(monkeypatch):
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)
    assert parse_devices("0,1") == ["cuda:0", "cuda:1"]
    assert parse_devices("1") == ["cuda:1"]


def test_parse_devices_out_of_range_errors(monkeypatch):
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 1)
    with pytest.raises(VocalisError):
        parse_devices("0,1")     # card 1 doesn't exist


def test_parse_devices_non_integer_errors(monkeypatch):
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)
    with pytest.raises(VocalisError):
        parse_devices("0,x")


def test_parse_devices_dedups(monkeypatch):
    """'--gpus 0,0,1' must not load a card twice — duplicates are collapsed,
    order preserved (else the second pass bypasses the fit check)."""
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)
    assert parse_devices("0,0,1,1,0") == ["cuda:0", "cuda:1"]


# ── WorkerPool.run_chunks (dispatch + error isolation) ────────────────────────

from conftest import make_fake_pool as _fake_pool  # single shared copy (also used by test_streaming)


def test_run_chunks_dispatches_all_items(monkeypatch):
    pool = _fake_pool(2)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    monkeypatch.setattr(tts_utils, "generate_with_retry",
                        lambda text, make_fn, sr, label="", out=None: ("wav", len(text), 0.1, False))

    saved = {}
    save_lock = threading.Lock()
    def save(idx, wav, sr):
        with save_lock:
            saved[idx] = wav

    items = [(i, f"chunk-{i}") for i in range(10)]
    chars, secs = pool.run_chunks(items, GenParams(), save, total=10)

    assert set(saved) == set(range(10))          # every chunk written exactly once
    assert chars == sum(len(f"chunk-{i}") for i in range(10))


def _saver():
    saved, lock = {}, threading.Lock()
    def save(idx, wav, sr):
        with lock:
            saved[idx] = wav
    return saved, save


# ── mid-generation cancel: abort the in-flight chunk, not just new dispatch ─────────

def test_cancellable_tqdm_aborts_when_event_set():
    """The wrapper swapped into chatterbox's token loop raises GenerationCanceled
    the moment the worker's cancel Event is set — and is a plain pass-through
    otherwise."""
    tts_utils._GEN_CANCEL.event = None
    assert list(tts_utils._cancellable_tqdm(range(5), disable=True)) == [0, 1, 2, 3, 4]

    ev = threading.Event()
    tts_utils._GEN_CANCEL.event = ev
    try:
        it = tts_utils._cancellable_tqdm(range(1000), disable=True)
        assert next(it) == 0                       # running normally…
        ev.set()                                   # …cancel lands mid-loop
        with pytest.raises(tts_utils.GenerationCanceled):
            next(it)
    finally:
        tts_utils._GEN_CANCEL.event = None


def test_cancel_hook_installs_into_every_chatterbox_loop():
    """Regression guard: the hook must land in BOTH iterative stages of a chunk —
    T3 token sampling AND the s3gen flow-matching vocoder. Missing either makes
    cancel look card-dependent (an unhooked stage runs to completion). Fails
    loudly if a chatterbox upgrade moves/renames these modules."""
    tts_utils._install_cancel_hook()
    import chatterbox.models.t3.t3 as t3mod
    import chatterbox.models.s3gen.flow_matching as fmmod
    assert t3mod.tqdm is tts_utils._cancellable_tqdm
    assert fmmod.tqdm is tts_utils._cancellable_tqdm


def test_worker_resolves_mid_generation_abort(monkeypatch):
    """GenerationCanceled from the token loop resolves the chunk cleanly: nothing
    saved (resume regenerates it), no retry, no error event, no worker dropped —
    and the batch drains so run_chunks returns promptly."""
    pool = _fake_pool(2)
    cancel = threading.Event()
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))

    def aborting(text, make_fn, sr, label="", out=None):
        cancel.set()                               # cancel lands while "generating"
        raise tts_utils.GenerationCanceled()
    monkeypatch.setattr(tts_utils, "generate_with_retry", aborting)

    events, elock = [], threading.Lock()
    def on_event(ev):
        with elock:
            events.append(ev)

    saved, save = _saver()
    items = [(i, f"c-{i}") for i in range(6)]
    pool.run_chunks(items, GenParams(), save, total=6, on_event=on_event, cancel=cancel)

    assert saved == {}                             # aborted chunks never write files
    assert len(pool) == 2                          # abort is not an error — no worker penalty
    assert not any(e["type"] == "chunk_failed" for e in events)
    assert any("aborted mid-generation" in e.get("line", "") for e in events)


def test_run_chunks_oom_requeues_to_survivor_and_drops_worker(monkeypatch):
    """OOM on a chunk: requeue it for a surviving worker AND permanently remove the
    OOMed worker from the pool (its replica is freed; it won't be resurrected)."""
    pool = _fake_pool(2)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))

    # Ordering is forced with a signal, not a sleep: the OOMed worker's whole handling (requeue,
    # then drop) must be finished before ANY other chunk, including the requeued one, completes.
    # `_handle_job_error` requeues first and drops second, so without this a survivor could finish
    # the requeued chunk and let run_chunks return while the drop was still a few statements away.
    dropped = threading.Event()
    real_drop = pool._drop_worker
    def drop_then_signal(wid):
        real_drop(wid)
        dropped.set()
    monkeypatch.setattr(pool, "_drop_worker", drop_then_signal)

    state = {"boomed": False, "waits_timed_out": 0}
    lock = threading.Lock()
    def flaky(text, make_fn, sr, label="", out=None):
        if text == "OOM":
            with lock:
                if not state["boomed"]:
                    state["boomed"] = True
                    raise RuntimeError("CUDA out of memory (simulated)")
        # Every other call, and the requeued OOM chunk, waits for the drop to have finished.
        # The timeout is only a ceiling on a hang; hitting it is asserted on below.
        if not dropped.wait(timeout=30):
            state["waits_timed_out"] += 1
        return ("wav", len(text), 0.1, False)
    monkeypatch.setattr(tts_utils, "generate_with_retry", flaky)

    saved, save = _saver()
    pool.run_chunks([(0, "OOM"), (1, "ok"), (2, "ok"), (3, "ok")], GenParams(), save, total=4)

    assert state["waits_timed_out"] == 0         # the drop really was signaled each time
    assert dropped.is_set()
    assert set(saved) == {0, 1, 2, 3}            # OOMed chunk 0 finished on the survivor
    assert state["boomed"] is True
    assert len(pool) == 1                        # the OOMed worker was dropped, not resurrected
    assert len(pool._models) == 1


def test_run_chunks_oom_with_no_survivor_raises(monkeypatch):
    """The drain path the old suite never covered: OOM on a chunk with NO surviving
    worker (single worker) must RAISE, not silently return success and leave a hole
    the concat later trips over. The good chunk generated before the OOM still saved."""
    pool = _fake_pool(1)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    def gen(text, make_fn, sr, label="", out=None):
        if text == "OOM":
            raise RuntimeError("CUDA out of memory")
        return ("wav", len(text), 0.1, False)
    monkeypatch.setattr(tts_utils, "generate_with_retry", gen)

    saved, save = _saver()
    with pytest.raises(RuntimeError):
        pool.run_chunks([(0, "ok"), (1, "OOM")], GenParams(), save, total=2)
    assert 0 in saved                            # work done before the OOM is not lost
    assert len(pool) == 0                         # the sole worker was dropped


def test_run_chunks_non_oom_transient_error_is_retried(monkeypatch):
    """A NON-OOM error is retried on the same (surviving) worker — a re-roll of a
    non-deterministic model often succeeds — instead of killing the worker."""
    pool = _fake_pool(1)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    tries = {"n": 0}
    lock = threading.Lock()
    def gen(text, make_fn, sr, label="", out=None):
        if text == "FLAKY":
            with lock:
                tries["n"] += 1
                if tries["n"] < 3:
                    raise RuntimeError("transient non-oom failure")
        return ("wav", len(text), 0.1, False)
    monkeypatch.setattr(tts_utils, "generate_with_retry", gen)

    saved, save = _saver()
    pool.run_chunks([(0, "FLAKY")], GenParams(), save, total=1)
    assert set(saved) == {0} and tries["n"] == 3     # failed twice, succeeded on attempt 3
    assert len(pool) == 1                            # worker survived — NOT dropped for a non-OOM error


@pytest.mark.parametrize("other_device", ['test-satellite:cuda:1', "other:cuda:0"])
def test_unreachable_satellite_without_local_worker_keeps_retry_budget(monkeypatch,
                                                                      other_device):
    """Another remote card is not local fallback; satellite-only pools retain recovery."""
    import io
    from satellite_client import SatelliteUnreachable

    pool = _fake_pool(2)
    pool.workers[0]["device"] = 'test-satellite:cuda:0'
    pool.workers[1]["device"] = other_device
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda _dev: (None, None))
    batch = tts_utils._Batch(GenParams(), tts_utils.BATCH, None, 1, None, None, None)
    batch.pending = 1
    job = tts_utils._Job(0, "one", batch)

    for attempt in (1, 2):
        assert not pool._handle_job_error(pool.workers[0], job,
                                         SatelliteUnreachable("satellite stopped"),
                                         'test-satellite:cuda:0', io.StringIO())
        assert pool._jobq.get_nowait()[2] is job
        assert batch.attempts == {0: attempt}
        assert batch.pending == 1
        assert batch.failed == {}
        assert [w["device"] for w in pool.workers] == ['test-satellite:cuda:0', other_device]


def test_unreachable_satellite_single_chunk_moves_to_local_cuda(monkeypatch):
    """The serial satellite path uses the same device failover as a batch."""
    from satellite_client import SatelliteUnreachable

    pool = _fake_pool(2)
    satellite = object()
    pool.workers[0]["device"] = 'test-satellite:cuda:0'
    pool.workers[1]["device"] = "cuda:0"
    pool._models = {0: satellite, 1: object()}
    monkeypatch.setattr(torch.cuda, "set_device", lambda _idx: None)
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda _dev: (None, None))
    satellite_started = threading.Event()

    def make_fn(model, *args):
        def render():
            if model is satellite:
                satellite_started.set()
                raise SatelliteUnreachable("satellite stopped")
            assert satellite_started.wait(5)
            return torch.zeros(1, 200)
        return render

    def generate(text, make_fn, sr, label="", out=None):
        return make_fn(text)(), len(text), 0.1, False

    monkeypatch.setattr(tts_utils, "make_generate_fn", make_fn)
    monkeypatch.setattr(tts_utils, "generate_with_retry", generate)
    saved, save = _saver()
    pool._started = True
    batch = pool.submit([(0, "one"), (1, "two")], GenParams(), save=save, total=2)
    pool._started = False
    pool._ensure_started()
    pool.collect(batch, stall_timeout_s=10)

    assert set(saved) == {0, 1}
    assert batch.attempts == {}
    assert [w["device"] for w in pool.workers] == ["cuda:0"]


def test_a_satellite_that_comes_back_rejoins_the_render_in_progress(monkeypatch):
    """Doug, 2026-10-22: a satellite was restarted mid-render; its worker was dropped, it came
    back and showed online, and not one more chunk went to it. After `rejoin`, the SAME render's
    remaining chunks reach the new satellite worker, and the satellite is no longer listed gone."""
    from satellite_client import SatelliteUnreachable

    pool = _fake_pool(2)
    old_sat, new_sat, local = object(), object(), object()
    pool.workers[0]["device"] = 'test-satellite:cuda:0'
    pool.workers[1]["device"] = "cuda:0"
    pool._models = {0: old_sat, 1: local}
    monkeypatch.setattr(torch.cuda, "set_device", lambda _idx: None)
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda _dev: (None, None))
    monkeypatch.setattr(tts_utils, "load_model", lambda dev: new_sat)
    dropped, rejoined_rendered = threading.Event(), threading.Event()
    rendered_by = {}

    def make_fn(model, text, *args):
        def render():
            if model is old_sat:
                raise SatelliteUnreachable("satellite stopped")
            if model is new_sat:
                rejoined_rendered.set()
            else:
                # The local card holds back until the rejoined satellite has taken a chunk, so
                # the assertion below cannot pass by the local card simply finishing everything.
                assert rejoined_rendered.wait(10)
            rendered_by[text] = model
            return torch.zeros(1, 200)
        return render

    def generate(text, make_fn, sr, label="", out=None):
        return make_fn(text)(), len(text), 0.1, False

    monkeypatch.setattr(tts_utils, "make_generate_fn", make_fn)
    monkeypatch.setattr(tts_utils, "generate_with_retry", generate)
    real_handle = pool._handle_job_error

    # Signalled when `_handle_job_error` RETURNS, not from inside `_drop_worker`: the device is
    # added to `_sat_gone` after the drop, so a signal from the drop let the assertion below race
    # the worker thread (proved by holding the worker between the two; the check then saw {}).
    def handle(*args):
        gone = real_handle(*args)
        if gone:
            dropped.set()
        return gone
    monkeypatch.setattr(pool, "_handle_job_error", handle)

    saved, save = _saver()
    pool._started = True
    batch = pool.submit([(i, f"c{i}") for i in range(6)], GenParams(), save=save, total=6)
    pool._started = False
    pool._ensure_started()
    assert dropped.wait(10), "the satellite's first chunk fails and its worker leaves the pool"
    assert pool.satellites_gone() == {"test-satellite": ['test-satellite:cuda:0']}

    assert pool.rejoin('test-satellite:cuda:0') is True
    pool.collect(batch, stall_timeout_s=10)

    assert set(saved) == set(range(6))
    assert new_sat in rendered_by.values(), "the returning satellite must get chunks of THIS render"
    assert pool.satellites_gone() == {}
    assert sorted(w["device"] for w in pool.workers) == ["cuda:0", 'test-satellite:cuda:0']
    assert len({w["id"] for w in pool.workers}) == 2, "a rejoined worker gets a fresh id"


def test_rejoin_adds_nothing_unless_the_satellite_left_and_now_answers(monkeypatch):
    """Only a device that left because its machine stopped answering comes back, once, and only
    when it answers; a pool being replaced takes nobody back."""
    from satellite_client import SatelliteUnreachable

    pool = _fake_pool(1)
    pool.workers[0]["device"] = "cuda:0"
    loads = []

    def load(dev):
        loads.append(dev)
        if len(loads) == 1:
            raise SatelliteUnreachable("still off")
        return object()
    monkeypatch.setattr(tts_utils, "load_model", load)

    assert pool.rejoin('test-satellite:cuda:0') is False and loads == [], "never left: no load"
    pool._sat_gone.add('test-satellite:cuda:0')
    assert pool.rejoin('test-satellite:cuda:0') is False, "still down: stays out, stays gone"
    assert pool.satellites_gone() == {"test-satellite": ['test-satellite:cuda:0']}
    assert pool.rejoin('test-satellite:cuda:0') is True
    assert pool.rejoin('test-satellite:cuda:0') is False, "a second call adds no second worker"
    assert [w["device"] for w in pool.workers] == ["cuda:0", 'test-satellite:cuda:0']

    pool._sat_gone.add('test-satellite:cuda:1')
    pool._shutdown_flag = True
    assert pool.rejoin('test-satellite:cuda:1') is False, "a pool being replaced takes nobody back"


class _GonePool:
    """The three things `rejoin_satellite` and the watcher ask of a pool, recorded."""
    poisoned = False
    _shutdown_flag = False

    def __init__(self, gone):
        self.gone = dict(gone)
        self.worker_counts = {'test-satellite:cuda:0': 1, 'test-satellite:cuda:1': 1,
                              "other:cuda:0": 1, "cuda:0": 1}
        self.rejoined = []
        self.fail = False

    def satellites_gone(self, include_waiting=False):
        return {k: list(v) for k, v in self.gone.items() if v}

    def rejoin(self, dev, force=False):
        self.rejoined.append((dev, force) if force else dev)
        if self.fail:
            return False
        self.gone = {k: [d for d in v if d != dev] for k, v in self.gone.items()}
        return True


def test_rejoin_declares_that_satellites_whole_plan_then_adds_its_missing_workers(monkeypatch):
    """The plan sent is that satellite's FULL plan from the pool (a card still working there must
    not be zeroed by a plan naming only the missing one), never another satellite's."""
    from vocalis.runtime import pool as rt_pool, satellites as sat
    pool = _GonePool({"test-satellite": ['test-satellite:cuda:1']})
    monkeypatch.setattr(rt_pool, "_pool", pool)
    plans = []
    monkeypatch.setattr(sat, "health", lambda name: {"reachable": True})
    monkeypatch.setattr(sat, "apply_plan", lambda p: plans.append(dict(p)))

    assert rt_pool.rejoin_satellite("test-satellite", pool) == ['test-satellite:cuda:1']
    assert plans == [{'test-satellite:cuda:0': 1, 'test-satellite:cuda:1': 1}]
    assert pool.rejoined == ['test-satellite:cuda:1']


def test_rejoin_does_nothing_while_the_satellite_is_down_or_nothing_is_missing(monkeypatch):
    from vocalis.runtime import pool as rt_pool, satellites as sat
    asked = []
    monkeypatch.setattr(sat, "health", lambda name: asked.append(name) or {"reachable": False})
    monkeypatch.setattr(sat, "apply_plan", lambda p: pytest.fail("no plan for a satellite that is off"))

    pool = _GonePool({"test-satellite": ['test-satellite:cuda:0']})
    monkeypatch.setattr(rt_pool, "_pool", pool)
    assert rt_pool.rejoin_satellite("test-satellite", pool) == []
    assert pool.rejoined == []
    assert rt_pool.rejoin_satellite("other", pool) == []
    assert asked == ["test-satellite"], "a satellite with nothing missing is not even asked"


def test_the_watcher_rejoins_while_its_pool_is_live_and_stops_when_it_is_replaced(monkeypatch):
    """No page has to be open: the pool's own watcher tries every missing satellite each interval,
    and ends when the pool is no longer the live one."""
    from vocalis.runtime import pool as rt_pool, satellites as sat
    pool = _GonePool({"test-satellite": ['test-satellite:cuda:0']})
    monkeypatch.setattr(sat, "health", lambda name: {"reachable": True})
    monkeypatch.setattr(sat, "apply_plan", lambda p: None)
    monkeypatch.setattr(rt_pool, "_pool", pool)
    ticks = []

    def wait(seconds):
        assert seconds == rt_pool.REJOIN_EVERY_S
        ticks.append(seconds)
        if len(ticks) == 2:
            rt_pool._pool = None                     # replaced: the next check ends the thread

    rt_pool._rejoin_watch(pool, wait=wait)
    assert pool.rejoined == ['test-satellite:cuda:0']
    assert len(ticks) == 2


def test_reconnect_rejoins_only_cards_its_saved_plan_still_asks_for_and_skips_the_wait(monkeypatch):
    """⟳ has just declared the SAVED plan itself, so nothing is declared again; a card unticked
    since the pool was built (plan 0) is not put back; and the after-timeout wait is skipped."""
    from vocalis.runtime import pool as rt_pool, satellites as sat
    pool = _GonePool({"test-satellite": ['test-satellite:cuda:0', 'test-satellite:cuda:1']})
    monkeypatch.setattr(rt_pool, "_pool", pool)
    monkeypatch.setattr(sat, "health", lambda name: {"reachable": True})
    monkeypatch.setattr(sat, "apply_plan", lambda p: pytest.fail("⟳ already declared its plan"))

    added = rt_pool.rejoin_satellite("test-satellite", plan={'test-satellite:cuda:0': 1,
                                                             'test-satellite:cuda:1': 0})
    assert added == ['test-satellite:cuda:0']
    assert pool.rejoined == [('test-satellite:cuda:0', True)], "forced, and only the ticked card"


def test_the_watcher_backs_off_a_satellite_that_answers_but_will_not_load(monkeypatch):
    """The desktop owner is gaming on the satellite's card: it answers, the load fails. It is
    asked again less often each time, up to REJOIN_BACKOFF_MAX_S, and logged once, not every 10 s."""
    from vocalis.runtime import pool as rt_pool, satellites as sat
    pool = _GonePool({"test-satellite": ['test-satellite:cuda:0']})
    pool.fail = True
    monkeypatch.setattr(sat, "health", lambda name: {"reachable": True})
    monkeypatch.setattr(sat, "apply_plan", lambda p: None)
    monkeypatch.setattr(rt_pool, "_pool", pool)
    warnings = []
    monkeypatch.setattr(rt_pool.logger, "warning", lambda m, *a, **k: warnings.append(m))
    clock = {"t": 0.0}

    def wait(seconds):
        clock["t"] += seconds
        if clock["t"] >= 3000:
            rt_pool._pool = None

    rt_pool._rejoin_watch(pool, wait=wait, now=lambda: clock["t"])
    attempts = len(pool.rejoined)
    # Every 10 s for 3,000 s would be 300 attempts; doubling from 20 s to the 600 s cap is ~10.
    assert 5 <= attempts <= 12, attempts
    assert len(warnings) == 1, warnings


def test_a_backoff_is_forgotten_once_the_satellite_is_back_in(monkeypatch):
    """Backed off to the cap, then ⟳ puts it back; when it drops again later, the watcher's first
    attempt comes on the next tick, not after the stale 600 s wait."""
    from vocalis.runtime import pool as rt_pool, satellites as sat
    pool = _GonePool({"test-satellite": ['test-satellite:cuda:0']})
    pool.fail = True
    monkeypatch.setattr(sat, "health", lambda name: {"reachable": True})
    monkeypatch.setattr(sat, "apply_plan", lambda p: None)
    monkeypatch.setattr(rt_pool, "_pool", pool)
    clock = {"t": 0.0}
    seen = {}

    def wait(seconds):
        clock["t"] += seconds
        if clock["t"] == 3000:                       # backed off to the cap by now; ⟳ puts it back
            pool.gone, pool.fail = {}, False
        elif clock["t"] == 3010:                     # one tick later it drops again
            pool.gone = {"test-satellite": ['test-satellite:cuda:0']}
            seen["before"] = len(pool.rejoined)
        elif clock["t"] >= 3020:
            rt_pool._pool = None

    rt_pool._rejoin_watch(pool, wait=wait, now=lambda: clock["t"])
    assert len(pool.rejoined) == seen["before"] + 1, "tried on the very next tick"
    assert pool.gone == {"test-satellite": []}


def test_a_satellite_that_timed_out_waits_before_it_is_taken_back_unless_reconnect_says_so(monkeypatch):
    """A crawling satellite still answers health; without the wait the watcher would hand it
    another chunk to crawl on within seconds. A satellite that stopped answering has no wait."""
    from satellite_client import SatelliteTimedOut, SatelliteUnreachable
    pool = _fake_pool(1)
    pool.workers[0]["device"] = "cuda:0"
    clock = {"t": 1000.0}
    pool._clock = lambda: clock["t"]
    monkeypatch.setattr(tts_utils, "load_model", lambda dev: object())

    pool._note_satellite_gone('test-satellite:cuda:0', SatelliteTimedOut("crawled"))
    assert pool.satellites_gone() == {}, "inside the wait it is not offered to the watcher"
    assert pool.satellites_gone(include_waiting=True) == {"test-satellite": ['test-satellite:cuda:0']}
    assert pool.rejoin('test-satellite:cuda:0') is False
    clock["t"] += pool.REJOIN_AFTER_TIMEOUT_S
    assert pool.satellites_gone() == {"test-satellite": ['test-satellite:cuda:0']}
    assert pool.rejoin('test-satellite:cuda:0') is True

    pool._note_satellite_gone('test-satellite:cuda:1', SatelliteTimedOut("crawled"))
    assert pool.rejoin('test-satellite:cuda:1', force=True) is True, "⟳ skips the wait"

    pool._note_satellite_gone('test-satellite:cuda:2', SatelliteUnreachable("switched off"))
    assert pool.satellites_gone() == {"test-satellite": ['test-satellite:cuda:2']}, "no wait"


def test_an_oom_drop_is_not_offered_for_rejoin(monkeypatch):
    """A card that ran out of memory stays out of the pool; only a satellite that stopped
    answering is remembered as gone."""
    import io
    pool = _fake_pool(2)
    pool.workers[0]["device"] = 'test-satellite:cuda:0'
    pool.workers[1]["device"] = "cuda:0"
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda _dev: (None, None))
    batch = tts_utils._Batch(GenParams(), tts_utils.BATCH, None, 1, None, None, None)
    batch.pending = 1
    oom = torch.cuda.OutOfMemoryError("CUDA out of memory")
    assert pool._handle_job_error(pool.workers[0], tts_utils._Job(0, "one", batch), oom,
                                  'test-satellite:cuda:0', io.StringIO())
    assert pool.satellites_gone() == {}


def test_run_chunks_persistent_non_oom_chunk_isolated_others_saved(monkeypatch):
    """A chunk that always fails (non-OOM) is given up on after MAX_CHUNK_ATTEMPTS,
    but every OTHER chunk is saved and run_chunks raises (so the hole surfaces)."""
    pool = _fake_pool(2)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    def gen(text, make_fn, sr, label="", out=None):
        if text == "BAD":
            raise ValueError("permanently bad chunk")
        return ("wav", len(text), 0.1, False)
    monkeypatch.setattr(tts_utils, "generate_with_retry", gen)

    saved, save = _saver()
    with pytest.raises(RuntimeError):
        pool.run_chunks([(0, "ok"), (1, "BAD"), (2, "ok"), (3, "ok")], GenParams(), save, total=4)
    assert set(saved) == {0, 2, 3}               # good chunks all landed; only BAD is missing
    assert len(pool) == 2                         # non-OOM failure never removes workers


def test_run_chunks_save_failure_does_not_silently_lose_chunk(monkeypatch):
    """A failure in save() (disk full, backend error) must be treated like any
    other chunk failure — retried then surfaced — NOT swallowed into a false
    success (the bug where save/emit ran outside the worker's try)."""
    pool = _fake_pool(1)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    monkeypatch.setattr(tts_utils, "generate_with_retry",
                        lambda text, make_fn, sr, label="", out=None: ("wav", len(text), 0.1, False))
    def save(idx, wav, sr):
        raise OSError("disk full")
    with pytest.raises(RuntimeError):
        pool.run_chunks([(0, "x")], GenParams(), save, total=1)


def test_run_chunks_oom_does_not_consume_retry_budget(monkeypatch):
    """OOM is a worker-capacity event (drop + requeue), NOT a re-roll of the chunk —
    it must not eat the chunk's non-OOM retry budget. Here a chunk OOMs once, then
    fails transiently twice on the survivor, then succeeds: with a shared budget
    (the old behavior) the second transient failure would exhaust MAX_CHUNK_ATTEMPTS
    and fail the whole run."""
    pool = _fake_pool(2)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    state = {"oomed": False, "flakes": 0}
    lock = threading.Lock()
    def gen(text, make_fn, sr, label="", out=None):
        if text == "X":
            with lock:
                if not state["oomed"]:
                    state["oomed"] = True
                    raise RuntimeError("CUDA out of memory")
                if state["flakes"] < 2:
                    state["flakes"] += 1
                    raise RuntimeError("transient non-oom failure")
        return ("wav", len(text), 0.1, False)
    monkeypatch.setattr(tts_utils, "generate_with_retry", gen)

    saved, save = _saver()
    pool.run_chunks([(0, "X")], GenParams(), save, total=1)      # must NOT raise
    assert set(saved) == {0}
    assert state["oomed"] and state["flakes"] == 2


def test_run_chunks_stall_watchdog_raises_and_poisons_pool(monkeypatch):
    """A wedged generate() (hung GPU kernel) must not hang the pool/caller forever:
    with no progress within stall_timeout_s, run_chunks aborts with RuntimeError AND
    marks the pool poisoned — the zombie thread still shares a model replica, so a
    cached pool must be rebuilt (vocalis_server.get_pool checks the flag), never
    re-dispatched alongside it."""
    pool = _fake_pool(1)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    block = threading.Event()                    # not set → generate() parks
    def hang(text, make_fn, sr, label="", out=None):
        block.wait()
        return ("wav", len(text), 0.1, False)
    monkeypatch.setattr(tts_utils, "generate_with_retry", hang)
    try:
        with pytest.raises(RuntimeError, match="stalled"):
            pool.run_chunks([(0, "x")], GenParams(), lambda *a: None, total=1, stall_timeout_s=0.2)
        assert pool.poisoned is True             # cached pools must not reuse this instance
    finally:
        block.set()                              # release the parked worker thread


def test_run_chunks_empty_is_noop():
    pool = _fake_pool(2)
    assert pool.run_chunks([], GenParams(), lambda *a: None, total=0) == (0, 0.0)


# ── Shared pool: interactive priority and no starvation ─────────────────────────────

def test_interactive_priority_jumps_ahead_of_batch(monkeypatch):
    """A live /speak (INTERACTIVE) chunk queued while a book (BATCH) render is in
    flight is served BEFORE the book's remaining queued chunks — and both batches
    complete (neither starves). Proves the shared-pool priority + interleaving."""
    pool = _fake_pool(1)                             # one worker → strict ordering to assert on
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    order, olock = [], threading.Lock()
    first_started = threading.Event()
    gate = threading.Event()                          # holds the worker on the first chunk

    def gen(text, make_fn, sr, label="", out=None):
        with olock:
            order.append(text)
            n = len(order)
        if n == 1:                                    # block on the first batch chunk...
            first_started.set()
            gate.wait(3.0)                            # ...so we can enqueue interactive behind it
        return ("wav", len(text), 0.1, False)
    monkeypatch.setattr(tts_utils, "generate_with_retry", gen)

    saved_b, save_b = _saver()
    b = pool.submit([(i, f"b{i}") for i in range(4)], GenParams(),
                    priority=tts_utils.BATCH, save=save_b, total=4)
    assert first_started.wait(3.0)                    # worker is now busy on b0
    saved_i, save_i = _saver()
    it = pool.submit([(0, "i0")], GenParams(),
                     priority=tts_utils.INTERACTIVE, save=save_i, total=1)
    gate.set()                                        # release the worker
    pool.collect(it)
    pool.collect(b)

    assert set(saved_b) == {0, 1, 2, 3} and set(saved_i) == {0}   # neither starved
    assert order[0] == "b0"
    assert order[1] == "i0", f"interactive should preempt queued batch chunks, got {order}"


def test_speak_concatenates_chunks_in_order(monkeypatch):
    """speak() fans a message's chunks across the pool and concatenates them in INDEX
    order regardless of which worker finished first."""
    pool = _fake_pool(2)
    monkeypatch.setattr(tts_utils, "make_generate_fn", lambda *a, **k: (lambda: None))
    monkeypatch.setattr(tts_utils, "split_into_chunks", lambda t, **k: ["aa", "bbb", "c"])

    def gen(text, make_fn, sr, label="", out=None):
        n = len(text)
        return (torch.full((1, 2), float(n)), n, 0.1, False)   # each chunk -> [n, n]
    monkeypatch.setattr(tts_utils, "generate_with_retry", gen)

    wav, sr = pool.speak("ignored — split is patched", GenParams())
    assert sr == 24000 and wav.shape == (1, 6)
    assert [wav[0, i].item() for i in (0, 2, 4)] == [2.0, 3.0, 1.0]   # chunk lens 2,3,1 in order


# ── VRAM helpers ───────────────────────────────────────────────────────────────────

def test_device_mem_gb_cpu_is_none():
    from tts_utils import device_mem_gb
    assert device_mem_gb("cpu") == (None, None)


def test_vram_used_total_falls_back_to_mem_get_info(monkeypatch):
    """When the AMD sysfs sensor can't map the card (non-AMD, or no pci_bus_id),
    vram_used_total falls back to torch.cuda.mem_get_info — correct on CUDA."""
    import tts_utils
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda i: type("P", (), {})())
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda i: (2 * 2**30, 10 * 2**30))
    assert tts_utils.vram_used_total("cuda:0") == (8 * 2**30, 10 * 2**30)


def test_vram_used_total_prefers_amd_sysfs(monkeypatch):
    """When the AMD sysfs sensor resolves the card, its (accurate) whole-card
    numbers win over mem_get_info's under-reported ones."""
    import tts_utils
    monkeypatch.setattr(torch.cuda, "get_device_properties",
                        lambda i: type("P", (), {"pci_bus_id": 3, "pci_domain_id": 0})())
    monkeypatch.setattr(tts_utils, "_amd_sysfs_vram_by_pci",
                        lambda dom, bus: (29 * 2**30, 32 * 2**30) if (dom, bus) == (0, 3) else (None, None))
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda i: (28 * 2**30, 32 * 2**30))  # would say 4 used
    used, total = tts_utils.vram_used_total("cuda:0")
    assert (used, total) == (29 * 2**30, 32 * 2**30)          # sysfs wins, not the 4 GB mem_get_info


def test_hwmon_dir_does_not_poison_on_unresolved_sysfs(monkeypatch, tmp_path):
    """Regression: a concurrent first-touch that momentarily leaves the sysfs dir
    unresolved must NOT freeze a card's hwmon path at None for the whole process.

    This is the cuda:1 "only GPU% shows, no temp/power/clocks" bug: util% and VRAM
    re-read the sysfs cache every sample and recovered, but _hwmon_dir cached the
    transient None permanently. _hwmon_dir must decline to cache a negative while the
    dir is unresolved, then pick up the real hwmon dir on the next sample."""
    import tts_utils
    dev = tmp_path / "card1" / "device"
    (dev / "hwmon" / "hwmon9").mkdir(parents=True)          # real dir so the glob resolves
    key = (0, 3)

    tts_utils._SYSFS_DEV_CACHE.clear()
    tts_utils._HWMON_CACHE.clear()
    monkeypatch.setattr(torch.cuda, "get_device_properties",
                        lambda i: type("P", (), {"pci_bus_id": 3, "pci_domain_id": 0})())

    calls = {"n": 0}
    def fake_resolve(dom, bus):
        # First touch mirrors the race window: another thread has reserved the key but
        # not finished its glob, so this caller observes it unresolved. Second touch: done.
        calls["n"] += 1
        tts_utils._SYSFS_DEV_CACHE[(dom, bus)] = None if calls["n"] == 1 else str(dev)
        return (None, None)
    monkeypatch.setattr(tts_utils, "_amd_sysfs_vram_by_pci", fake_resolve)

    assert tts_utils._hwmon_dir("cuda:0") is None            # unresolved this sample
    assert key not in tts_utils._HWMON_CACHE                 # ...but NOT cached negative (the fix)

    got = tts_utils._hwmon_dir("cuda:0")                     # next sample: sysfs resolved
    assert got == str(dev / "hwmon" / "hwmon9")              # real hwmon dir appears
    assert tts_utils._HWMON_CACHE[key] == got                # and is now cached once


# Per-process VRAM includes server context and library allocations.
# Count owned children; unrelated training processes and system overhead stay outside the service total.
_FDINFO = ("pos:\t0\nflags:\t02100002\nmnt_id:\t26\n"
           "drm-driver:\tamdgpu\ndrm-client-id:\t12\ndrm-pdev:\t0000:03:00.0\n"
           "drm-total-vram:\t5645632 KiB\ndrm-memory-vram:\t5645632 KiB\n"
           "drm-memory-gtt:\t1024 KiB\ndrm-resident-vram:\t5645632 KiB\n")


def test_fdinfo_vram_bytes_reads_amdgpu_accounting():
    from tts_utils import _fdinfo_vram_bytes
    assert _fdinfo_vram_bytes(_FDINFO, "0000:03:00.0") == 5645632 * 1024
    assert _fdinfo_vram_bytes(_FDINFO, "0000:07:00.0") is None      # the other card's fd


def test_fdinfo_vram_bytes_is_none_without_the_key():
    """A DRM node that reports no VRAM key is None, NOT 0 — that is what lets gpu_stats
    fall back to memory_reserved instead of drawing an empty dark-green bar. This is the
    Windows/CUDA path, and the one that would otherwise regress silently."""
    from tts_utils import _fdinfo_vram_bytes
    body = "drm-driver:\tamdgpu\ndrm-pdev:\t0000:03:00.0\ndrm-memory-gtt:\t1024 KiB\n"
    assert _fdinfo_vram_bytes(body, "0000:03:00.0") is None


def test_proc_vram_bytes_sums_vocalis_and_its_workers(monkeypatch):
    """Chatterbox runs in the server process, while VoxCPM2 runs in a child process with its own environment. Count descriptors only for the requested card; a worker using another card must not inflate this result.
    """
    import tts_utils
    other = _FDINFO.replace("0000:03:00.0", "0000:07:00.0")
    bodies = {"self": [_FDINFO],            # the server: Chatterbox + the HIP context
              "4242": [_FDINFO],            # a VoxCPM2 worker on the same card
              "4243": [other]}              # ...and one on the other card
    monkeypatch.setattr(tts_utils, "pci_addr_for_device", lambda d: "0000:03:00.0")
    monkeypatch.setattr(tts_utils, "vocalis_pids", lambda: ["self", "4242", "4243"])
    monkeypatch.setattr(tts_utils, "_render_fdinfo", lambda pid: bodies[pid])
    assert tts_utils.proc_vram_bytes("cuda:0") == 2 * 5645632 * 1024


def test_proc_vram_bytes_none_off_amd(monkeypatch):
    """No sysfs mapping for the card (Windows/CUDA) means no fdinfo to read and no
    answer — the caller keeps memory_reserved rather than reporting a confident 0."""
    import tts_utils
    monkeypatch.setattr(tts_utils, "pci_addr_for_device", lambda d: None)
    assert tts_utils.proc_vram_bytes("cuda:0") is None


def test_vocalis_pids_takes_workers_and_leaves_a_training(monkeypatch):
    """Owned VoxCPM2 and enhancement children share Vocalis's service cgroup and stop with it. Training uses a sibling scope and must survive a Vocalis restart, so its process and descendants are excluded from the owned-worker count.
    """
    import tts_utils
    kids = {"self": ["100", "200", "900"], "900": ["901"], "100": [], "200": [], "901": []}
    cg = {"self": "0::/vocalis.service\n", "100": "0::/vocalis.service\n",
          "200": "0::/vocalis.service\n",
          "900": "0::/vocalis-train-x.scope\n", "901": "0::/vocalis-train-x.scope\n"}
    monkeypatch.setattr(tts_utils, "_children_of", lambda pid: kids[pid])
    monkeypatch.setattr(tts_utils, "_cgroup_of", lambda pid: cg[pid])
    assert sorted(tts_utils.vocalis_pids()) == ["100", "200", "self"]


def test_vocalis_pids_without_cgroups_is_the_process_tree(monkeypatch):
    """Off Linux / with no readable cgroup there is nothing to compare, so descent alone
    decides. It must still not walk forever if /proc hands back a cycle."""
    import tts_utils
    kids = {"self": ["100"], "100": ["self", "200"], "200": []}
    monkeypatch.setattr(tts_utils, "_children_of", lambda pid: kids[pid])
    monkeypatch.setattr(tts_utils, "_cgroup_of", lambda pid: None)
    assert sorted(tts_utils.vocalis_pids()) == ["100", "200", "self"]


def test_pci_addr_for_device_does_not_cache_a_negative(monkeypatch, tmp_path):
    """Same lesson as _hwmon_dir above: a sysfs dir that is merely unresolved THIS sample
    must not freeze the card's PCI address at None for the life of the process."""
    import tts_utils
    # Real sysfs resolves to a dir NAMED "0000:03:00.0"; a colon is illegal in a Windows
    # filename and this suite runs on the dev box, so stand in a legal name — the function
    # only ever takes the basename of whatever the symlink resolved to.
    dev = tmp_path / "0000_03_00_0"
    dev.mkdir()
    monkeypatch.setattr(tts_utils, "_SYSFS_DEV_CACHE", {})
    monkeypatch.setattr(tts_utils, "_PDEV_CACHE", {})
    monkeypatch.setattr(torch.cuda, "get_device_properties",
                        lambda i: type("P", (), {"pci_bus_id": 3, "pci_domain_id": 0})())
    calls = {"n": 0}
    def fake_resolve(dom, bus):
        calls["n"] += 1
        tts_utils._SYSFS_DEV_CACHE[(dom, bus)] = None if calls["n"] == 1 else str(dev)
        return (None, None)
    monkeypatch.setattr(tts_utils, "_amd_sysfs_vram_by_pci", fake_resolve)

    assert tts_utils.pci_addr_for_device("cuda:0") is None      # unresolved this sample
    assert 0 not in tts_utils._PDEV_CACHE                       # ...and NOT cached (the fix)
    assert tts_utils.pci_addr_for_device("cuda:0") == "0000_03_00_0"   # next sample: resolved
    assert tts_utils._PDEV_CACHE[0] == "0000_03_00_0"           # and cached once


def _one_fake_card(monkeypatch):
    """One cuda card with every optional sensor dark; the caller supplies the VRAM."""
    import tts_utils
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 1)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda i: "AMD Radeon AI PRO R9700")
    for name in ("gpu_util_percent", "gpu_temp_c", "gpu_power_w"):
        monkeypatch.setattr(tts_utils, name, lambda i: None)
    monkeypatch.setattr(tts_utils, "gpu_clocks_mhz", lambda i: (None, None))


def test_gpu_stats_credits_vocalis_with_its_real_vram(monkeypatch):
    """Use per-process VRAM accounting for the Vocalis category. Allocator-only accounting misses process and driver allocations; system-wide overhead that belongs to no process remains outside the Vocalis total.
    """
    import tts_utils
    from vocalis.runtime import gpu as gpu_mod
    _one_fake_card(monkeypatch)
    monkeypatch.setattr(tts_utils, "vram_used_total", lambda i: (6 * 2**30, 32 * 2**30))
    monkeypatch.setattr(tts_utils, "proc_vram_bytes", lambda i: int(5.8 * 2**30))
    monkeypatch.setattr(torch.cuda, "memory_reserved", lambda i: int(3.3 * 2**30))
    g = gpu_mod.gpu_stats()[0]
    assert g["vocalis_gb"] == 5.8                               # not the 3.3 torch knows about
    assert round(g["used_gb"] - g["vocalis_gb"], 1) == 0.2       # driver overhead, nothing else


def test_gpu_stats_falls_back_to_memory_reserved(monkeypatch):
    """No DRM accounting (Windows/CUDA) keeps torch's figure — a wrong-ish dark green
    beats an empty one."""
    import tts_utils
    from vocalis.runtime import gpu as gpu_mod
    _one_fake_card(monkeypatch)
    monkeypatch.setattr(tts_utils, "vram_used_total", lambda i: (6 * 2**30, 32 * 2**30))
    monkeypatch.setattr(tts_utils, "proc_vram_bytes", lambda i: None)
    monkeypatch.setattr(torch.cuda, "memory_reserved", lambda i: int(3.3 * 2**30))
    assert gpu_mod.gpu_stats()[0]["vocalis_gb"] == 3.3


def test_gpu_stats_never_reports_more_than_the_whole_card(monkeypatch):
    """The whole-card sensor and the fdinfo read are separate syscalls a beat apart, so a
    load landing between them can make Vocalis's share exceed the card's. /gpus/stats
    asserts used_gb >= vocalis_gb, and the UI would draw a negative "other"."""
    import tts_utils
    from vocalis.runtime import gpu as gpu_mod
    _one_fake_card(monkeypatch)
    monkeypatch.setattr(tts_utils, "vram_used_total", lambda i: (6 * 2**30, 32 * 2**30))
    monkeypatch.setattr(tts_utils, "proc_vram_bytes", lambda i: 9 * 2**30)
    g = gpu_mod.gpu_stats()[0]
    assert g["vocalis_gb"] == g["used_gb"] == 6.0
    assert g["free_gb"] == 26.0


def test_is_oom_detects_cuda_and_hip():
    from tts_utils import _is_oom
    assert _is_oom(RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB"))
    assert _is_oom(RuntimeError("HIP out of memory"))
    assert not _is_oom(RuntimeError("some unrelated failure"))
    assert not _is_oom(ValueError("nope"))


# ── WorkerPool load fit and graceful OOM ───────────────────────────────────────────

class _FakeModel:
    sr = 24000


def _fake_loader(fail_after):
    """A load_model stand-in that succeeds `fail_after` times, then raises OOM."""
    state = {"n": 0}
    def _load(dev):
        state["n"] += 1
        if state["n"] > fail_after:
            raise RuntimeError("CUDA out of memory. Tried to allocate 4.00 GiB")
        return _FakeModel()
    return _load, state


def _patch_cuda(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "set_device", lambda *a, **k: None)
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: None)


def test_pool_graceful_load_oom_drops_worker_and_continues(monkeypatch):
    """Over-provisioning: workers load until one OOMs, then the pool stops on that
    card and continues with what fit — no crash, no partial-worker corruption."""
    _patch_cuda(monkeypatch)
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda dev: (10.0, 24.0))  # roomy → no fit-check
    load, state = _fake_loader(fail_after=2)
    monkeypatch.setattr(tts_utils, "load_model", load)

    pool = WorkerPool(["cuda:0"], workers_per_device=5)

    assert len(pool) == 2          # loaded 2, 3rd OOMed, stopped
    assert state["n"] == 3         # the 3rd load was attempted and failed
    assert pool.sr == 24000


def test_pool_all_workers_oom_raises_systemexit(monkeypatch):
    _patch_cuda(monkeypatch)
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda dev: (1.0, 24.0))
    load, _ = _fake_loader(fail_after=0)   # first load OOMs
    monkeypatch.setattr(tts_utils, "load_model", load)

    with pytest.raises(VocalisError):
        WorkerPool(["cuda:0"], workers_per_device=3)


def test_pool_fit_check_stops_before_oom(monkeypatch):
    """The fit check keeps activation headroom: it stops adding workers once
    free VRAM < (loaded+1) * act_headroom (1.5 GB default), before any OOM."""
    _patch_cuda(monkeypatch)
    # device_mem_gb call order is: slot0 top, slot0 after, slot1 top, slot1 after,
    # slot2 top, slot2 after, slot3 top. Headroom checks (need = (loaded+1)*1.5):
    #   slot1 top=16 vs need 3.0  -> load;  slot2 top=10 vs need 4.5 -> load;
    #   slot3 top=5  vs need 6.0  -> STOP at 3 workers.
    frees = iter([20.0, 16.0, 16.0, 10.0, 10.0, 6.0, 5.0, 5.0, 5.0])
    monkeypatch.setattr(tts_utils, "device_mem_gb", lambda dev: (next(frees), 24.0))
    load, state = _fake_loader(fail_after=999)   # never OOMs — fit-check must stop it
    monkeypatch.setattr(tts_utils, "load_model", load)

    pool = WorkerPool(["cuda:0"], workers_per_device=8)

    assert len(pool) == 3          # stopped by fit check, not by OOM
    assert state["n"] == 3         # only 3 loads attempted (no 4th)
