"""Tests for the server-side enhancement queue, including ordering, status, cancellation, and failure handling."""
import threading

import pytest
from flask import Flask

# `src/` is on sys.path already — conftest puts it there for every test in this directory.
import scene_enhance
import scene_enhance_queue as seq
import scenes


class FakeBox:
    """The start route, reduced to what the queue can observe: a card count, and refusals."""

    def __init__(self, cards=1, refuse=None, running=()):
        self.cards = cards
        self.refuse = dict(refuse or {})
        self.running = set(running)
        self.starts = []
        self._n = 0

    def __call__(self, ref):
        self.starts.append(ref)
        if ref in self.running:
            return {"error": {"message": "this scene is already being enhanced",
                              "job_id": f"old-{ref}"}}, 409
        if ref in self.refuse:
            return {"error": self.refuse[ref]}, 409
        if self.cards <= 0:
            return {"error": "a render is using every card", "busy": "render"}, 409
        self.cards -= 1
        self._n += 1
        return {"job_id": f"job-{self._n}", "device": "cuda:0"}, 202


@pytest.fixture(autouse=True)
def _clean_jobs():
    scene_enhance.JOBS.clear()
    yield
    scene_enhance.JOBS.clear()


def _q(tmp_path, box, cards=2):
    return seq.EnhanceQueue(tmp_path / "scene_enhance_queue.yaml", box, cards=lambda: cards)


def _add(q, refs):
    """`add` without the worker, so each test drives `pump()` itself and stays deterministic."""
    q.kick = lambda: None
    return q.add(refs)


# ── the pump ─────────────────────────────────────────────────────────────────────────────────

def test_two_cards_start_two_scenes_the_first_two_in_ask_order(tmp_path):
    box = FakeBox(cards=2)
    q = _q(tmp_path, box)
    _add(q, ["one", "two", "three"])
    q.pump()
    assert box.starts[:2] == ["one", "two"]
    assert q.queue == ["three"], "the two that started left the queue; the third waits"
    assert "every card" in q.wait and "retrying" in q.wait


def test_a_busy_card_is_a_WAIT_and_the_item_stays_at_the_head(tmp_path):
    box = FakeBox(cards=0)
    q = _q(tmp_path, box)
    _add(q, ["one", "two"])
    q.pump()
    assert box.starts == ["one"], "the pass stops at the first busy refusal — no card, no point"
    assert q.queue == ["one", "two"]
    box.cards = 1
    q.pump()
    assert q.queue == ["two"], "one card freed, one scene started, the next waits again"


def test_a_terminal_refusal_leaves_the_queue_with_its_reason_and_the_next_one_goes(tmp_path):
    box = FakeBox(cards=1, refuse={"full": "already full quality"})
    q = _q(tmp_path, box)
    _add(q, ["full", "next"])
    q.pump()
    assert q.queue == []
    assert q.failed == {"full": "already full quality"}
    assert box.starts == ["full", "next"]


def test_a_scene_already_enhancing_just_leaves_the_queue_and_is_not_a_failure(tmp_path):
    box = FakeBox(cards=1, running={"busy"})
    q = _q(tmp_path, box)
    _add(q, ["busy"])
    q.pump()
    assert q.queue == [] and q.failed == {}


def test_a_start_that_raises_is_a_wait_never_a_crash(tmp_path):
    def boom(ref):
        raise RuntimeError("disk on fire")
    q = _q(tmp_path, boom)
    _add(q, ["one"])
    q.pump()
    assert q.queue == ["one"] and "RuntimeError" in q.wait


def test_a_ref_being_started_is_never_offered_twice(tmp_path):
    """The dedupe the old in-page latch protected: a second pump arriving while a start is in
    flight must not hand the same scene out again (two writers, one twin path)."""
    gate, inside = threading.Event(), threading.Event()
    starts = []

    def slow(ref):
        starts.append(ref)
        inside.set()
        gate.wait(5)
        return {"job_id": f"j-{ref}"}, 202
    q = _q(tmp_path, slow)
    _add(q, ["one"])
    t = threading.Thread(target=q.pump)
    t.start()
    assert inside.wait(5)
    assert q.snapshot()["starting"] == ["one"]
    q.pump()                      # a second caller: asks for another pass, starts nothing
    gate.set()
    t.join(5)
    assert starts == ["one"]


# ── the batch counters ────────────────────────────────────────────────────────────────────────

def test_a_finished_job_is_counted_and_a_failed_one_keeps_its_reason(tmp_path):
    q = _q(tmp_path, FakeBox(cards=2))
    _add(q, ["a", "b"])
    q.pump()
    q.job_finished(scene_enhance.EnhanceJob(id="job-1", src_ref="a", status="done"))
    q.job_finished(scene_enhance.EnhanceJob(id="job-2", src_ref="b", status="failed",
                                            error="the enhancer crashed"))
    q.job_finished(scene_enhance.EnhanceJob(id="someone-elses", src_ref="z", status="done"))
    assert q.done == 1, "only this queue's own jobs are counted"
    assert q.failed == {"b": "the enhancer crashed"}


def test_a_new_batch_resets_the_counters_but_adding_to_a_draining_one_does_not(tmp_path):
    q = _q(tmp_path, FakeBox(cards=0))
    q.done, q.failed = 3, {"x": "old"}
    _add(q, ["a"])
    assert q.done == 0 and q.failed == {}
    q.done = 1
    _add(q, ["b"])
    assert q.done == 1


# ── what the tab changes ──────────────────────────────────────────────────────────────────────

def test_move_is_stated_before_which_ref_and_the_downward_move_lands_right(tmp_path):
    q = _q(tmp_path, FakeBox(cards=0))
    _add(q, ["a", "b", "c", "d"])
    assert q.move("a", "d") and q.queue == ["b", "c", "a", "d"]
    assert q.move("d", None) is False, "already last"
    assert q.move("a", "a") is False and q.move("zz", "b") is False
    assert q.move("b", "zz") and q.queue == ["c", "a", "d", "b"], "unknown destination = the end"


def test_add_skips_duplicates_and_scenes_already_running(tmp_path):
    scene_enhance.JOBS["j"] = scene_enhance.EnhanceJob(id="j", src_ref="live", status="enhancing")
    q = _q(tmp_path, FakeBox(cards=0))
    assert _add(q, ["a", "a", "live"]) == ["a"]


def test_stop_all_empties_the_queue_THEN_cancels_every_running_enhancement(tmp_path):
    live = scene_enhance.EnhanceJob(id="j1", src_ref="x", status="enhancing")
    done = scene_enhance.EnhanceJob(id="j2", src_ref="y", status="done")
    scene_enhance.JOBS.update({"j1": live, "j2": done})
    q = _q(tmp_path, FakeBox(cards=0))
    _add(q, ["a", "b"])
    assert q.stop_all() == 1
    assert q.queue == [] and live.cancel.is_set() and not done.cancel.is_set()


# ── it survives a restart ─────────────────────────────────────────────────────────────────────

def test_the_queue_is_saved_and_a_new_process_picks_it_up_in_order(tmp_path):
    q = _q(tmp_path, FakeBox(cards=0))
    _add(q, ["a", "b", "c"])
    q.move("c", "a")
    q.remove("b")
    again = _q(tmp_path, FakeBox(cards=0))
    assert again.snapshot()["queue"] == ["c", "a"]


def test_a_queue_whose_file_moved_forgets_the_old_one(tmp_path):
    """The app is built once, at import, so its queue must follow `paths.SCENE_ENHANCE_QUEUE`
    rather than capture it — in the suite the path moves with every test, and a captured one
    carried one test's queued scenes into the next test's Clips tab."""
    where = {"p": tmp_path / "one.yaml"}
    q = seq.EnhanceQueue(lambda: where["p"], FakeBox(cards=0))
    _add(q, ["a", "b"])
    q.done, q.failed = 2, {"x": "old"}
    where["p"] = tmp_path / "two.yaml"
    snap = q.snapshot()
    assert snap["queue"] == [] and snap["done"] == 0 and snap["failed"] == {}
    assert not (tmp_path / "two.yaml").exists()
    where["p"] = tmp_path / "one.yaml"
    assert q.snapshot()["queue"] == ["a", "b"], "and the first file still holds its own queue"


def test_an_unreadable_file_starts_empty_rather_than_failing(tmp_path):
    (tmp_path / "scene_enhance_queue.yaml").write_text("{not: [a list", encoding="utf-8")
    assert _q(tmp_path, FakeBox()).snapshot()["queue"] == []


def test_a_clear_waits_for_the_initial_disk_read_before_publishing(tmp_path, monkeypatch):
    """A stale initial read must not resurrect rows after a concurrent Clear has saved."""
    import vault_fs

    path = tmp_path / "scene_enhance_queue.yaml"
    path.write_text("- removed\n- also-removed\n", encoding="utf-8")
    q = _q(tmp_path, FakeBox())
    read_started, release_read, clear_started = (threading.Event(), threading.Event(),
                                                  threading.Event())
    save_done, settled = threading.Event(), threading.Event()
    real_read_text = vault_fs.read_text
    real_write = vault_fs.write_yaml_atomic
    reads = []

    def held_read(target):
        reads.append(target)
        if len(reads) == 1:
            read_started.set()
            assert release_read.wait(5), "test did not release the initial queue read"
        else:
            settled.set()                         # the old double read: a second reader got here
        return real_read_text(target)

    def observed_write(target, data):
        real_write(target, data)
        save_done.set()

    monkeypatch.setattr(vault_fs, "read_text", held_read)
    monkeypatch.setattr(vault_fs, "write_yaml_atomic", observed_write)

    # With the first read held, Clear does one of two things, and both are events: it waits its
    # turn at the load lock (right), or it reads the file itself (the old double read, reported
    # by `held_read` above). The test waits for whichever happens. This was a 100 ms poll for a
    # second reader, which a slow machine could miss and so pass the old code.
    class _WatchedLock:
        def __init__(self, real):
            self._real = real

        def __enter__(self):
            if not self._real.acquire(blocking=False):
                settled.set()                     # held by the loader: this caller now waits
                self._real.acquire()
            return self

        def __exit__(self, *exc):
            self._real.release()

    q._load_lock = _WatchedLock(q._load_lock)

    loader = threading.Thread(target=q.ensure_loaded)
    clearer = threading.Thread(target=lambda: (clear_started.set(), q.clear()))
    loader.start()
    assert read_started.wait(5)
    clearer.start()
    assert clear_started.wait(5)
    # The loader owns initialization through publication, so Clear cannot read or save against
    # that same not-yet-published snapshot. With the former double-read race, the second reader
    # reaches the held-read seam while the first read is suspended.
    assert settled.wait(5), "Clear neither waited for the initial load nor read the file itself"
    release_read.set()
    loader.join(5)
    clearer.join(5)
    assert not loader.is_alive() and not clearer.is_alive()
    assert len(reads) == 1, f"Clear read the queue file again instead of waiting: {reads}"
    assert save_done.is_set(), "Clear did not persist"
    assert q.queue == []
    assert q.snapshot()["queue"] == []
    assert real_read_text(path).strip() == "[]"


def test_the_file_is_vault_routed_because_a_ref_carries_the_scene_title():
    import vault_store
    assert "scene_enhance_queue.yaml" in vault_store.ROUTES["install"]["files"]


# ── the worker ────────────────────────────────────────────────────────────────────────────────

def _capture_threads(monkeypatch):
    """The worker clears `q._worker` as it leaves, so the thread object has to be caught at birth
    to be joined — reading `q._worker` after the fact is a race the worker can win."""
    born = []
    real = threading.Thread

    class Caught(real):
        def start(self):
            born.append(self)
            super().start()
    monkeypatch.setattr(seq.threading, "Thread", Caught)
    return born


def test_the_worker_drains_the_queue_by_itself_and_then_stops(tmp_path, monkeypatch):
    """The whole point of 11.2.7: nothing in a browser has to be open for the queue to move."""
    born = _capture_threads(monkeypatch)
    box = FakeBox(cards=5, refuse={"r": "already full quality"})
    q = _q(tmp_path, box)
    q.add(["a", "r"])                 # the real add — it kicks the worker
    assert len(born) == 1
    born[0].join(5)
    assert not born[0].is_alive() and q._worker is None, "with nothing left to wait for, it exits"
    assert box.starts == ["a", "r"] and q.queue == [] and q.failed == {"r": "already full quality"}


def test_an_add_while_the_worker_is_leaving_starts_a_fresh_one(tmp_path, monkeypatch):
    """The lost wakeup. The worker decides it is idle and is still ALIVE for a moment afterwards;
    an add in that moment used to see a live worker, start nothing, and strand its scene. The
    worker is held exactly there — on its "stopping" log line, after the decision — while the add
    arrives. With the detach-under-lock line removed this fails: `born` stays at one."""
    born = _capture_threads(monkeypatch)
    leaving, gate = threading.Event(), threading.Event()
    real_info = seq.logger.info

    def held_info(msg, *a, **k):
        if "worker stopping" in str(msg) and not leaving.is_set():
            leaving.set()
            gate.wait(5)
        return real_info(msg, *a, **k)
    monkeypatch.setattr(seq.logger, "info", held_info)
    q = _q(tmp_path, FakeBox(cards=5))
    q.add(["a"])
    assert leaving.wait(5)
    assert born[0].is_alive(), "precondition: the first worker is inside the gap"
    q.add(["b"])
    assert len(born) == 2, "the add started a fresh worker instead of trusting the dying one"
    gate.set()
    for t in born:
        t.join(5)
    assert q.queue == []


def test_a_finish_the_sweep_already_settled_still_wakes_a_waiting_queue(tmp_path):
    q = _q(tmp_path, FakeBox(cards=0))
    _add(q, ["b"])
    kicked = []
    q.kick = lambda: kicked.append(1)
    q.job_finished(scene_enhance.EnhanceJob(id="settled-earlier", src_ref="a", status="done"))
    assert kicked, "a freed card with scenes waiting wakes the queue at once"
    q.clear()
    kicked.clear()
    q.job_finished(scene_enhance.EnhanceJob(id="someone-elses", src_ref="z", status="done"))
    assert not kicked, "…and an unrelated finish with nothing waiting does nothing"


def test_a_job_that_finished_before_the_pump_recorded_it_is_still_counted(tmp_path):
    """A fast failure's finish hook can run before `_pass` records the job, find nothing, and
    return — leaving the job in `_mine` for ever: the worker never exits, the reason never shows,
    and the batch counters never reset. The pump settles an already-finished job on the spot."""
    def fails_fast(ref):
        scene_enhance.JOBS["j1"] = scene_enhance.EnhanceJob(id="j1", src_ref=ref, status="failed",
                                                            error="scratch dir missing")
        return {"job_id": "j1"}, 202
    q = _q(tmp_path, fails_fast)
    _add(q, ["a"])
    q.pump()
    assert q._mine == {} and q.failed == {"a": "scratch dir missing"}


def test_the_worker_sweeps_a_finished_job_whose_hook_it_never_heard(tmp_path):
    q = _q(tmp_path, FakeBox(cards=1))
    _add(q, ["a"])
    q.pump()
    assert q._mine == {"job-1": "a"}
    scene_enhance.JOBS["job-1"] = scene_enhance.EnhanceJob(id="job-1", src_ref="a", status="done")
    q._run()                          # returns once idle — which it now is
    assert q._mine == {} and q.done == 1 and q._worker is None


def test_stop_everything_during_a_start_cancels_the_job_when_it_appears(tmp_path):
    """The route measures for up to seconds before it registers a job, so Stop everything in that
    window had nothing to cancel and a twenty-minute enhancement took a card afterwards."""
    gate, inside = threading.Event(), threading.Event()
    job = scene_enhance.EnhanceJob(id="j1", src_ref="a", status="enhancing")

    def slow(ref):
        inside.set()
        gate.wait(5)
        scene_enhance.JOBS["j1"] = job
        return {"job_id": "j1"}, 202
    q = _q(tmp_path, slow)
    _add(q, ["a"])
    t = threading.Thread(target=q.pump)
    t.start()
    assert inside.wait(5)
    q.stop_all()
    gate.set()
    t.join(5)
    assert job.cancel.is_set(), "the job that registered after Stop everything was canceled"
    assert q._mine == {} and q.done == 0


def test_removing_a_row_while_it_starts_cancels_that_one_only(tmp_path):
    gate, inside = threading.Event(), threading.Event()
    job = scene_enhance.EnhanceJob(id="j1", src_ref="a", status="enhancing")

    def slow(ref):
        if ref == "a":
            inside.set()
            gate.wait(5)
            scene_enhance.JOBS["j1"] = job
            return {"job_id": "j1"}, 202
        return {"error": "busy", "busy": "cards"}, 409
    q = _q(tmp_path, slow)
    _add(q, ["a", "b"])
    t = threading.Thread(target=q.pump)
    t.start()
    assert inside.wait(5)
    assert q.remove("a")
    gate.set()
    t.join(5)
    assert job.cancel.is_set() and q.queue == ["b"]


def test_a_finishing_job_wakes_the_queue_through_the_scene_enhance_hook(tmp_path):
    q = _q(tmp_path, FakeBox(cards=1))
    _add(q, ["a"])
    q.pump()
    kicked = []
    q.kick = lambda: kicked.append(1)
    seq._on_job_finish(scene_enhance.EnhanceJob(id="job-1", src_ref="a", status="done"))
    assert q.done == 1 and kicked


def test_classify_reads_the_start_routes_answers():
    assert seq.classify({"job_id": "j"}, 202) == (seq.STARTED, "j")
    assert seq.classify({"error": {"message": "m", "job_id": "j"}}, 409) == (seq.RUNNING, "j")
    assert seq.classify({"error": "busy words", "busy": "cards"}, 409) == (seq.WAIT, "busy words")
    assert seq.classify({"error": "already full quality"}, 409) == (seq.REFUSED, "already full quality")
    assert seq.classify({"error": "that scene is no longer there"}, 404)[0] == seq.REFUSED
    assert seq.classify({"error": "no card ticked"}, 400)[0] == seq.REFUSED


# ── the routes ────────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    import book_to_audio
    import vocalis.web.clips as clips_mod
    from vocalis.web.clips import create_clips_blueprint
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", tmp_path / "output")
    app = Flask(__name__)
    bp = create_clips_blueprint()
    bp.enhance_queue.kick = lambda: None        # no worker: nothing may start in a route test
    app.register_blueprint(bp)
    c = app.test_client()
    c.queue = bp.enhance_queue
    return c


def _scene(tmp_path, stem):
    r = scenes.scenes_root(tmp_path / "output")
    r.mkdir(parents=True, exist_ok=True)
    (r / f"{stem}.mp3").write_bytes(b"ID3")
    scenes.write_manifest(r / f"{stem}.yaml", {"title": "A scene", "entries": []})
    return stem


def test_the_route_adds_real_scenes_and_refuses_anything_else(client, tmp_path):
    ref = _scene(tmp_path, "ferry_ab12cd34")
    r = client.post("/clips/scenes/enhance/queue", json={"add": [ref, "nope_00000000", "..\\evil"]})
    assert r.status_code == 200 and r.get_json()["queue"] == [ref]
    assert client.post("/clips/scenes/enhance/queue",
                       json={"add": ["nope_00000000"]}).status_code == 400


def test_the_listing_carries_the_queue_beside_the_running_jobs(client, tmp_path):
    ref = _scene(tmp_path, "ferry_ab12cd34")
    client.post("/clips/scenes/enhance/queue", json={"add": [ref]})
    body = client.get("/clips/scenes/enhance").get_json()
    assert body["jobs"] == [] and body["queue"]["queue"] == [ref]


def test_remove_move_clear_and_stop_each_reach_the_queue(client, tmp_path):
    a, b = _scene(tmp_path, "a_aaaa1111"), _scene(tmp_path, "b_bbbb2222")
    client.post("/clips/scenes/enhance/queue", json={"add": [a, b]})
    assert client.post("/clips/scenes/enhance/queue",
                       json={"move": b, "before": a}).get_json()["queue"] == [b, a]
    assert client.post("/clips/scenes/enhance/queue", json={"remove": b}).get_json()["queue"] == [a]
    assert client.post("/clips/scenes/enhance/queue", json={"clear": True}).get_json()["queue"] == []
    assert client.post("/clips/scenes/enhance/queue", json={"stop": True}).status_code == 200
    assert client.post("/clips/scenes/enhance/queue", json={}).status_code == 400
