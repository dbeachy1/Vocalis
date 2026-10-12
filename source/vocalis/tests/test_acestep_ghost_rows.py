"""Uncertain ACE-Step jobs keep their device reservation until a result or child exit is known."""
import threading
import time
from types import SimpleNamespace

import pytest
from flask import Flask

import vocalis_server as vs
from vocalis.runtime import acecands, acerun
from vocalis.runtime import acestep as rt
from vocalis.runtime import jobs as jobs_mod
from vocalis.runtime import paths as rt_paths
from vocalis.runtime import settings as rt_settings
from vocalis.web import acestep as web_ace


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def own_store(monkeypatch, tmp_path):
    """This file's candidate store, never the host's and never another test's."""
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", tmp_path / "ace_candidates.json")
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    monkeypatch.setattr(rt, "_BACKENDS", {})
    monkeypatch.setattr(rt, "_STOP_ALL", threading.Event())


@pytest.fixture(autouse=True)
def only_my_rows():
    """`jobs.JOBS` and `QUEUE` are process-wide and shared with every other acestep spec, so
    this file cleans up exactly what it added — and nothing it did not."""
    before = set(jobs_mod.JOBS)
    yield
    for jid in [j for j in jobs_mod.JOBS if j not in before]:
        jobs_mod.JOBS.pop(jid, None)
        web_ace.QUEUE.release(jid)


@pytest.fixture
def latched(client):
    """One poll first, so rehydration has already happened.

    🔴 THIS IS THE STATE A GHOST LIVES IN, not a test convenience. `_rearm_unfinished` runs ONCE
    per process, on the first readable jobs poll — a row still "running" after it has run is
    exactly the row nothing will ever start a watcher for. Polling first also stops these specs
    firing a real reattach thread at a dead port.
    """
    client.get("/acestep/jobs")
    return client


def _ghost(jid="ghost-1", *, device="cuda:1", seen_ago=3600.0, stamped=True):
    """One persisted running row whose child ownership cannot be confirmed."""
    j = jobs_mod.Job(id=jid, docx="", voice="", params=None, gpus=device, workers=1)
    j.kind = "acestep"
    j.status = "running"
    j.started_at = time.time() - seen_ago
    j.detail = {"title": 'Sample Track', "device": device, "model": "acestep-v15-xl-sft",
                "url": "http://127.0.0.1:7685", "task_id": "task-1"}
    if stamped:
        j.detail["seen_at"] = time.time() - seen_ago
    jobs_mod.JOBS[jid] = j
    return j


def _row(client, jid):
    rows = client.get("/acestep/jobs").get_json()["jobs"]
    return next((r for r in rows if r["id"] == jid), None)


def _fresh_jobs_client():
    """Create a fresh route closure to model process-local rehydration state."""
    app = Flask(__name__)
    app.register_blueprint(web_ace.create_acestep_blueprint())
    return app.test_client()


def test_unresolved_restart_row_keeps_its_device_reserved():
    """A restart without a matching local child leaves outcome and device ownership unresolved."""
    acecands.remember("ghost-1", "running", time.time() - 3600,
                      {"title": "Sample Track", "device": "cuda:1",
                       "url": "http://127.0.0.1:7685", "task_id": "task-1"})

    client = _fresh_jobs_client()
    row = _row(client, "ghost-1")
    assert row["status"] == "running", row
    assert "unresolved" in row["error"] and "no matching locally owned child" in row["error"]
    assert web_ace.QUEUE.device_of("ghost-1") == "cuda:1"
    assert not web_ace.QUEUE.claim("second-job", "cuda:1"), (
        "a second render reached a device reserved by an unresolved submission")


def test_unresolved_status_does_not_claim_the_render_stopped():
    acecands.remember("ghost-wording", "running", time.time() - 3600,
                      {"title": "Sample Track", "device": "cuda:1",
                       "url": "http://127.0.0.1:7685", "task_id": "task-wording"})

    client = _fresh_jobs_client()
    row = _row(client, "ghost-wording")
    assert row["status"] == "running"
    assert "outcome is unresolved" in row["error"]
    assert "stopped" not in row["error"] and "canceled" not in row["error"]


def test_missing_heartbeat_is_only_a_stale_watcher_signal(latched):
    g = _ghost(stamped=False)
    assert acerun.is_stale(g) is True
    assert web_ace.QUEUE.claim(g.id, "cuda:1")
    row = _row(latched, g.id)
    assert row["status"] == "running", row
    assert web_ace.QUEUE.device_of(g.id) == "cuda:1"


def test_unresolved_record_remains_running_across_rehydration():
    started = time.time() - 3600
    acecands.remember("ghost-2", "running", started,
                      {"title": 'Sample Track', "device": "cuda:1", "url": "http://127.0.0.1:7685",
                       "task_id": "task-2"})
    client = _fresh_jobs_client()
    row = _row(client, "ghost-2")
    assert row["status"] == "running" and "unresolved" in row["error"]
    assert web_ace.QUEUE.device_of("ghost-2") == "cuda:1"
    assert [c["status"] for c in acecands.load_all()] == ["running"]

    # Simulate the volatile registry and queue being rebuilt on a later process start.
    jobs_mod.JOBS.pop("ghost-2", None)
    web_ace.QUEUE.release("ghost-2")
    restarted_client = _fresh_jobs_client()
    assert restarted_client.get("/acestep/jobs").status_code == 200
    assert jobs_mod.JOBS["ghost-2"].status == "running"
    assert web_ace.QUEUE.device_of("ghost-2") == "cuda:1"
    assert not web_ace.QUEUE.claim("second-after-restart", "cuda:1")


# The ACE runtime only runs in the Linux container; its exit handling kills the child group with
# SIGKILL, which has no Windows signal. Same marker as tests/test_acestep_runtime.py.
@pytest.mark.skipif(not hasattr(__import__("signal"), "SIGKILL"), reason="POSIX-only kill escalation")
def test_confirmed_owned_child_exit_settles_an_unwatched_row(two_cards):
    g = _ghost("owned-exit")
    g.detail["backend_generation"] = rt.process_generation("cuda:1")
    assert web_ace.QUEUE.claim(g.id, "cuda:1")

    child = rt._BACKENDS["cuda:1"].process
    child.returncode = 1
    state = rt.process_state("cuda:1")

    assert state["state"] == "failed"
    assert g.status == "failed"
    assert "exited unexpectedly" in g.error
    assert web_ace.QUEUE.device_of(g.id) is None


def test_discard_all_preserves_unresolved_running_rows(latched):
    g = _ghost()
    assert web_ace.QUEUE.claim(g.id, "cuda:1")
    r = latched.post("/acestep/candidates/discard_all").get_json()
    assert g.id not in r["ids"] and r["still_running"] == 1
    assert _row(latched, g.id)["status"] == "running"
    assert web_ace.QUEUE.device_of(g.id) == "cuda:1"


def test_recent_watcher_heartbeats_remain_running(latched):
    fresh = _ghost("live-1", seen_ago=0.0)
    slow = _ghost("live-2", seen_ago=30.0)
    latched.get("/acestep/jobs")
    assert jobs_mod.JOBS[fresh.id].status == "running"
    assert jobs_mod.JOBS[slow.id].status == "running"


def test_a_long_render_keeps_beating(monkeypatch):
    """The mutation guard on `_beat`: delete the stamp from the poll loop and every render
    longer than a minute becomes a ghost on the very next tray poll."""
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    job = jobs_mod.Job(id="beat-1", docx="", voice="", params=None, gpus="", workers=1)
    job.kind = "acestep"
    job.detail = {"device": "cuda:0"}
    beats = []

    def _poll(url, tid):
        beats.append((job.detail or {}).get("seen_at"))
        if len(beats) >= 3:
            job.cancel.set()
            return {"status": rt.SUCCEEDED, "audio": ["/tmp/test.flac"],
                    "error": None, "progress": None}
        return {"status": rt.RUNNING, "audio": [], "error": None, "progress": None}

    monkeypatch.setattr(acerun.acestep, "poll", _poll)
    acerun.run_job(job, "http://127.0.0.1:7685", "cuda:0", {},
                   SimpleNamespace(done=lambda jid: None), task_id="task-3")
    assert len(beats) == 3 and all(beats), f"the render was not beating: {beats}"
    assert beats[2] > beats[0], "the stamp never advanced — it is set once, not renewed"
    assert acerun.is_stale(job) is False


def test_status_poll_does_not_clear_an_existing_reservation(client, monkeypatch):
    """Status polling does not clear an unresolved job's existing reservation."""
    monkeypatch.setattr(rt, "installed", lambda: [
        ("acestep-api.service", "http://127.0.0.1:7683", "cuda:0"),
        ("acestep-api-gpu1.service", "http://127.0.0.1:7685", "cuda:1")])
    monkeypatch.setattr(rt_settings, "load_app_settings",
                        lambda: {"devices": [{"id": "cuda:0", "enabled": True},
                                             {"id": "cuda:1", "enabled": True}]})
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": False, "model_loaded": None, "model": None})
    monkeypatch.setattr(rt, "active_states", lambda insts=None: {})
    g = _ghost("ghost-3")
    assert web_ace.QUEUE.claim(g.id, "cuda:1")
    assert client.get("/acestep/status").status_code == 200
    assert jobs_mod.JOBS[g.id].status == "running"
    assert web_ace.QUEUE.device_of(g.id) == "cuda:1"
    assert not web_ace.QUEUE.claim("status-second", "cuda:1")


# The backend can fabricate a running result for an unknown task ID. An empty task inventory from /v1/stats is authoritative, so reattachment must detect a missing backend job instead of polling a synthetic running row until timeout.


def _watched_job(jid="watch-1"):
    j = jobs_mod.Job(id=jid, docx="", voice="", params=None, gpus="cuda:0", workers=1)
    j.kind = "acestep"
    j.detail = {"device": "cuda:0", "title": 'Sample Track'}
    return j


def _running_answer():
    return {"status": rt.RUNNING, "audio": [], "error": None, "progress": None}


def test_empty_stats_do_not_release_an_unresolved_submission(monkeypatch):
    """An unknown task with empty stats stays reserved until a terminal result arrives."""
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(acerun, "MAX_POLL_MISSES", 3)
    uncertain = threading.Event()
    empty_stats_seen = threading.Event()
    terminal = threading.Event()

    def _poll(url, tid):
        if terminal.is_set():
            return {"status": "FAILED", "audio": [], "error": "terminal backend result",
                    "progress": None}
        uncertain.set()
        return _running_answer()

    def _stats(url, timeout=5.0):
        empty_stats_seen.set()
        return {"reachable": True, "queued": 0, "running": 0, "total": 0}

    monkeypatch.setattr(acerun.acestep, "poll", _poll)
    monkeypatch.setattr(acerun.acestep, "stats", _stats)
    job = _watched_job("unknown-task")
    jobs_mod.JOBS[job.id] = job
    assert web_ace.QUEUE.claim(job.id, "cuda:0")
    queue = SimpleNamespace(done=lambda jid: web_ace.QUEUE.release(jid))
    watcher = threading.Thread(
        target=acerun.run_job,
        args=(job, "http://127.0.0.1:7683", "cuda:0", {}, queue),
        kwargs={"task_id": "gone-with-the-backend"},
        daemon=True,
    )
    watcher.start()
    try:
        assert uncertain.wait(2), "the watcher did not observe the ambiguous response"
        assert empty_stats_seen.wait(2), "the empty backend inventory was not checked"
        assert job.status == "running"
        assert web_ace.QUEUE.device_of(job.id) == "cuda:0"
        assert not web_ace.QUEUE.claim("second-job", "cuda:0"), (
            "empty stats released a device with an unresolved submitted task")
    finally:
        terminal.set()
        watcher.join(2)
    assert not watcher.is_alive(), "the controlled watcher did not settle after terminal result"
    assert job.status == "failed" and job.error == "terminal backend result"
    assert web_ace.QUEUE.device_of(job.id) is None


def test_a_real_render_is_never_declared_gone(monkeypatch):
    """🔴 THE HALF THAT COSTS A SONG IF IT IS WRONG. A backend with work in flight says so, and
    the existence check must then stay out of the way however long the render takes."""
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(acerun, "MAX_POLL_MISSES", 3)
    polls = []

    def _poll(url, tid):
        polls.append(1)
        if len(polls) >= 8:
            job.cancel.set()
            return {"status": rt.SUCCEEDED, "audio": ["/tmp/test.flac"],
                    "error": None, "progress": None}
        return _running_answer()

    monkeypatch.setattr(acerun.acestep, "poll", _poll)
    monkeypatch.setattr(acerun.acestep, "stats",
                        lambda url, timeout=5.0: {"reachable": True, "queued": 0, "running": 1,
                                                  "total": 1})
    job = _watched_job("watch-2")
    acerun.run_job(job, "http://127.0.0.1:7685", "cuda:0", {},
                   SimpleNamespace(done=lambda jid: None), task_id="a-real-one")
    assert len(polls) >= 8, "a render the backend says it is running was cut short"
    assert job.status == "canceled"


def test_an_upstream_without_the_stats_route_is_left_alone(monkeypatch):
    """⚠️ `reachable: False` MUST MEAN "I LEARNED NOTHING", never "it is gone". An older backend
    that does not serve `/v1/stats` would otherwise have every one of its renders killed by a
    404 — the check turning into the opposite of the guarantee it exists to give."""
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(acerun, "MAX_POLL_MISSES", 3)
    polls = []

    def _poll(url, tid):
        polls.append(1)
        if len(polls) >= 8:
            job.cancel.set()
            return {"status": rt.SUCCEEDED, "audio": ["/tmp/test.flac"],
                    "error": None, "progress": None}
        return _running_answer()

    monkeypatch.setattr(acerun.acestep, "poll", _poll)
    monkeypatch.setattr(acerun.acestep, "stats",
                        lambda url, timeout=5.0: {"reachable": False, "queued": 0, "running": 0,
                                                  "total": 0})
    job = _watched_job("watch-3")
    acerun.run_job(job, "http://127.0.0.1:7685", "cuda:0", {},
                   SimpleNamespace(done=lambda jid: None), task_id="unknowable")
    assert len(polls) >= 8 and job.status == "canceled"


def test_stats_reads_the_shape_the_backend_actually_sends():
    """The wire shape, pinned from the live answer rather than from the docs:
    `{"data": {"jobs": {...}, "queue_size": 0}, "code": 200}`."""
    from unittest import mock
    body = b'{"data":{"jobs":{"total":0,"queued":0,"running":0,"succeeded":0,"failed":0},' \
           b'"queue_size":0,"queue_maxsize":200},"code":200,"error":null}'
    resp = mock.MagicMock()
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = lambda *a: False
    with mock.patch.object(rt.urllib.request, "urlopen", return_value=resp):
        got = rt.stats("http://127.0.0.1:7683")
    assert got == {"reachable": True, "queued": 0, "running": 0, "total": 0}


# ── the model a card "holds", and what Cancel leaves behind ───────────────────────────────

@pytest.fixture
def two_cards(monkeypatch):
    """Two owned child processes answer HTTP while neither has a model loaded."""
    import types
    instances = [
        ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0"),
        ("acestep-api-gpu1", "http://127.0.0.1:7685", "cuda:1")]
    monkeypatch.setattr(rt, "configured", lambda _settings=None: instances)
    monkeypatch.setattr(rt, "installed", lambda: instances)
    monkeypatch.setattr(rt_settings, "load_app_settings",
                        lambda: {"devices": [{"id": "cuda:0", "enabled": True},
                                             {"id": "cuda:1", "enabled": True}]})
    monkeypatch.setattr(rt, "_runtime_inputs", lambda: (
        "/opt/python", "/opt/acestep", "/models/vocalis/acestep"))

    class FakeChild:
        pid = 941_219
        returncode = None

        def poll(self):
            return self.returncode

    monkeypatch.setattr(rt.subprocess, "Popen", lambda *args, **kwargs: FakeChild())
    for service, url, _device in instances:
        result = rt.start_instance(service=service)
        assert result["ok"], result
        rt.mark_http_ready(url)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": False, "model": "acestep-v15-turbo"})
    monkeypatch.setattr(rt, "inventory", lambda url: {"reachable": True, "tasks": {}})
    monkeypatch.setattr(rt, "chosen_model", lambda device: "acestep-v15-xl-sft")
    before = dict(web_ace._MODEL_BY_URL)
    started = []
    thread_api = types.SimpleNamespace(**vars(threading))
    thread_api.Thread = lambda target, name=None, args=(), daemon=None: type(
        "T", (), {"start": lambda self: started.append(args)})()
    monkeypatch.setattr(web_ace, "threading", thread_api)
    yield started
    web_ace._MODEL_BY_URL.clear()
    web_ace._MODEL_BY_URL.update(before)


def test_a_card_without_a_loaded_model_refuses_generation(client, two_cards):
    """An answering child without a loaded model waits for explicit initialization."""
    response = client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}})
    assert response.status_code == 409
    assert "loaded, ready model" in response.get_json()["error"]
    assert not any(getattr(job, "kind", "") == "acestep" for job in jobs_mod.JOBS.values())


@pytest.fixture
def two_ready_cards(monkeypatch, two_cards):
    """The same owned children after each reports a loaded model."""
    for _service, url, _device in rt.installed():
        rt.mark_model_ready(url, True)
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": "acestep-v15-turbo"})
    return two_cards


def test_a_card_really_holding_turbo_still_renders_turbo(client, two_ready_cards, monkeypatch):
    """⚠️ THE FIX MUST NOT BECOME "ALWAYS USE THE DROPDOWN". A card that has genuinely loaded a
    model keeps running it — Generate must never start a silent 19 GB model swap, and the row
    says what is loaded so the two never disagree."""
    monkeypatch.setattr(rt, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": "acestep-v15-turbo"})
    made = client.post("/acestep/generate", json={"template": {"name": 'Sample Track'}}).get_json()
    assert [j["model"] for j in made["jobs"]] == ["acestep-v15-turbo"] * 2, made["jobs"]


def test_canceling_a_queued_render_removes_the_row_outright(client, two_ready_cards):
    """Canceling a queued render removes its row in one action; it has not started and needs no second dismissal."""
    client.post("/acestep/generate", json={"template": {}})          # fills both cards
    third = client.post("/acestep/generate", json={"template": {}}).get_json()["jobs"][0]
    jid = third["job_id"]
    assert _row(client, jid) is not None, "the third song should be queued and visible"
    r = client.post(f"/acestep/jobs/{jid}/cancel").get_json()
    assert r["removed"] is True and r["was_running"] is False
    assert _row(client, jid) is None, "the row survived its own cancel"
    assert all(c.get("id") != jid for c in acecands.load_all()), (
        "the record survived, so the canceled song comes back on the next restart")


def test_canceling_a_queued_render_does_not_spend_the_undo_slot(client, two_ready_cards):
    """⚠️ `drop`, NOT `forget`. The bin is one slot deep and holds the last DISCARD; tidying a
    canceled row through it would silently destroy the Undo for a song discarded a moment ago."""
    acecands.remember("kept-1", "done", 1.0, {"title": "Keeper"})
    acecands.forget("kept-1")                       # the song whose Undo must survive
    assert acecands.bin_size() == 1
    client.post("/acestep/generate", json={"template": {}})
    third = client.post("/acestep/generate", json={"template": {}}).get_json()["jobs"][0]
    client.post(f"/acestep/jobs/{third['job_id']}/cancel")
    assert acecands.bin_size() == 1, "canceling a queued song emptied the recycle bin"
    assert [c.get("id") for c in acecands.undo()] == ["kept-1"]
