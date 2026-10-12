"""ACE render records are finalized only after a result or confirmed child exit."""
import threading
from types import SimpleNamespace

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import acecands, acerun, jobs as jobs_mod


@pytest.fixture()
def fast_clock(monkeypatch):
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(acerun, "MAX_POLL_MISSES", 2)


@pytest.fixture()
def remembered(monkeypatch):
    got = []
    monkeypatch.setattr(acecands, "remember",
                        lambda jid, status, at, detail: got.append((jid, status, detail)))
    return got


def _job(jid):
    j = jobs_mod.Job(id=jid, docx="", voice="", params=None, gpus="", workers=1)
    j.kind = "acestep"
    j.status = "running"
    j.detail = {"payload": {}, "device": "cuda:0", "backend_generation": 7}
    return j


def _queue(done):
    return SimpleNamespace(done=lambda jid: done.append(jid))


@pytest.fixture
def registered_job():
    """Register only this synthetic job so child-exit lookup matches production dispatch."""
    owned = []

    def register(job):
        with jobs_mod.JOBS_LOCK:
            previous = jobs_mod.JOBS.get(job.id)
            jobs_mod.JOBS[job.id] = job
        owned.append((job.id, job, previous))
        return job

    yield register

    with jobs_mod.JOBS_LOCK:
        for job_id, job, previous in reversed(owned):
            if jobs_mod.JOBS.get(job_id) is job:
                if previous is None:
                    jobs_mod.JOBS.pop(job_id, None)
                else:
                    jobs_mod.JOBS[job_id] = previous


def test_a_dead_backend_is_remembered_as_failed(fast_clock, remembered, monkeypatch, registered_job):
    polls = []
    job = registered_job(_job("dead-1"))

    def poll(url, tid):
        polls.append(tid)
        if len(polls) == 2:
            acerun.backend_exited("cuda:0", 7, expected=False,
                                  reason="unexpected-exit", returncode=1)
        raise ConnectionError("gone")

    monkeypatch.setattr(acerun.acestep, "poll", poll)
    done = []
    acerun.run_job(job, "http://x", "cuda:0", {}, _queue(done), task_id="t-1")
    assert job.status == "failed"
    assert done == ["dead-1"], "the finally must free the card"
    assert polls == ["t-1", "t-1"]
    statuses = [s for _jid, s, _d in remembered]
    assert statuses[-1] == "failed", (
        f"the record was left saying {statuses[-1]!r} — the next boot will reattach to a dead "
        f"task and claim the card for a minute of doomed polls")
    assert "error" in remembered[-1][2]


def test_cancel_waits_for_terminal_backend_result_before_releasing_slot(
        fast_clock, remembered, monkeypatch):
    monkeypatch.setattr(acerun.acestep, "stats", lambda _url: {
        "reachable": False, "running": 0, "queued": 0})
    done = []
    j = _job("stop-1")
    j.cancel.set()
    polls = []

    def poll(url, tid):
        polls.append(tid)
        if len(polls) == 1:
            assert done == [], "the reservation was released while inference was still running"
            return {"status": acerun.acestep.RUNNING, "audio": [], "progress": 0.1}
        return {"status": acerun.acestep.SUCCEEDED, "audio": ["candidate.wav"]}

    monkeypatch.setattr(acerun.acestep, "poll", poll)
    acerun.run_job(j, "http://x", "cuda:0", {}, _queue(done), task_id="t-2")
    assert j.status == "canceled"
    assert done == ["stop-1"]
    assert polls == ["t-2", "t-2"]
    assert [s for _jid, s, _d in remembered][-1] == "canceled"


def test_watcher_timeout_does_not_release_until_owned_child_exit(remembered, monkeypatch, registered_job):
    monkeypatch.setattr(acerun, "POLL_SECONDS", 0.01)
    monkeypatch.setattr(acerun, "WATCH_SECONDS", 0.0)
    monkeypatch.setattr(acerun.acestep, "stats", lambda _url: {
        "reachable": False, "running": 0, "queued": 0})
    done = []
    j = registered_job(_job("late-1"))

    calls = []
    def poll(url, tid):
        calls.append(tid)
        assert done == [], "watch timeout must not be treated as child exit"
        if len(calls) == 2:
            acerun.backend_exited("cuda:0", 7, expected=True, reason="stop", returncode=-15)
        return {"status": acerun.acestep.RUNNING, "audio": [], "progress": 0.1}

    monkeypatch.setattr(acerun.acestep, "poll", poll)
    acerun.run_job(j, "http://x", "cuda:0", {}, _queue(done), task_id="t-3")
    assert j.status == "canceled"
    assert done == ["late-1"]
    assert calls == ["t-3", "t-3"]
    assert [s for _jid, s, _d in remembered][-1] == "canceled"


def test_an_unexpected_exception_is_remembered_as_failed(remembered, monkeypatch, registered_job):
    j = registered_job(_job("boom-1"))
    original_emit = acerun.jobs.emit
    first_emit = True

    def boom(job, extra):
        nonlocal first_emit
        acerun.backend_exited("cuda:0", 7, expected=False,
                              reason="unexpected-exit", returncode=1)
        if first_emit:
            first_emit = False
            raise RuntimeError("emit blew up mid-start")
        return original_emit(job, extra)
    # The first emit fails; later failure reporting uses the real event publisher.
    monkeypatch.setattr(acerun.jobs, "emit", boom)
    done = []
    acerun.run_job(j, "http://x", "cuda:0", {}, _queue(done), task_id="t-4")
    assert j.status == "failed"
    assert done == ["boom-1"]
    assert [s for _jid, s, _d in remembered][-1] == "failed"
