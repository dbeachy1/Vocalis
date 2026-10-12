"""Run one ACE-Step job from submission through terminal state.

`AceQueue` owns scheduling; this module submits, polls, records results, and
releases a reserved slot only after a terminal result or confirmed child exit.
Cancellation stops collecting output but does not claim to interrupt inference.
"""
from __future__ import annotations

import json
import time
import threading
import urllib.error

from loguru import logger

from vocalis.runtime import acecands, acestep, jobs

#: How often to ask `/query_result`. A song is minutes, so this is not a latency-sensitive loop —
#: and each poll is an HTTP round trip against a backend that is busy doing the actual work.
POLL_SECONDS = 2.0

#: Emit a diagnostic after this interval; a timeout does not establish backend idleness.
WATCH_SECONDS = 4200.0

#: Consecutive poll failures before the backend is treated as unavailable.
MAX_POLL_MISSES = 30

#: A running job without a recent watcher heartbeat is no longer active.
#: This threshold matches the interval used to classify consecutive poll failures.
STALE_SECONDS = 60.0

_WATCHING: set[str] = set()
_WATCHING_LOCK = threading.Lock()


def backend_exited(device: str, generation: int, *, expected: bool, reason: str,
                   returncode: int | None) -> None:
    """Attach confirmed child exit to jobs owned by that exact process generation."""
    with jobs.JOBS_LOCK:
        active = [job for job in jobs.JOBS.values()
                  if getattr(job, "kind", "") == "acestep" and job.status == "running"]
    for job in active:
        detail = job.detail or {}
        if detail.get("device") != device or detail.get("backend_generation") != generation:
            continue
        event = getattr(job, "_ace_child_exit", None)
        if event is None:
            event = threading.Event()
            job._ace_child_exit = event
        job._ace_child_exit_info = {"expected": expected, "reason": reason,
                                    "returncode": returncode}
        event.set()
        with _WATCHING_LOCK:
            watching = job.id in _WATCHING
        if not watching:
            # A restored record can have no surviving watcher. Confirmed process exit is the
            # only safe point to close it and release its reservation.
            _finish_after_exit(job, device, expected, reason, returncode)


def _beat(job) -> None:
    """Record the time of the last watcher pass on the job."""
    with job.lock:
        job.detail = {**(job.detail or {}), "seen_at": time.time()}


def is_stale(job, now: float = None) -> bool:
    """Return whether a running job has missed its watcher heartbeat. Jobs from
    before heartbeat tracking have no timestamp and are treated as stale.
    """
    seen = float((job.detail or {}).get("seen_at") or 0.0)
    return (now or time.time()) - seen > STALE_SECONDS


def ensure_watcher(job, queue) -> bool:
    """Reattach status polling only while the exact recorded child is still owned here."""
    detail = job.detail or {}
    device, url = detail.get("device"), detail.get("url")
    task_id, generation = detail.get("task_id"), detail.get("backend_generation")
    if not (device and url and task_id and generation
            and acestep.owns_generation(device, generation)):
        return False
    with _WATCHING_LOCK:
        if job.id in _WATCHING:
            return True
        _WATCHING.add(job.id)
    if queue.device_of(job.id) != device and not queue.claim(job.id, device):
        with _WATCHING_LOCK:
            _WATCHING.discard(job.id)
        return False
    try:
        threading.Thread(target=run_job, name=f"acestep-re-{job.id[:8]}",
                         args=(job, url, device, detail.get("payload") or {}, queue),
                         kwargs={"task_id": task_id}, daemon=True).start()
    except RuntimeError:
        # Keep any acquired reservation: without a watcher, only child exit can release it.
        with _WATCHING_LOCK:
            _WATCHING.discard(job.id)
        return False
    return True


def can_still_produce_output(job) -> bool:
    """Whether this ACE-Step job may still cause the engine to write a song. Queued: yes, it is
    about to be dispatched. Running: only with a live watcher in this process, or when the exact
    child it was submitted to is still ours and alive.

    (2026-10-11) A "running" row restored after a restart whose child is gone (see
    `_rearm_unfinished`) keeps its status and its device reservation on purpose, and nothing
    resolves it for the life of the process: the generation counter restarts with the process, so
    no later child exit reliably matches it. It cannot write anything, so it must not be what
    keeps the output folder from ever being cleaned.
    """
    if job.status == "queued":
        return True
    if job.status != "running":
        return False
    with _WATCHING_LOCK:
        if job.id in _WATCHING:
            return True
    detail = job.detail or {}
    device, generation = detail.get("device"), detail.get("backend_generation")
    return bool(device and generation and acestep.owns_generation(device, generation))


def abandon(job, why: str) -> None:
    """Mark an unwatched running job as failed and persist the terminal state.
    This does not stop generation already running in ACE-Step.
    """
    with job.lock:
        job.status = "failed"
        job.error = why
        snapshot = {**dict(job.detail or {}), "error": why}
    _remember(job, "failed", snapshot)
    jobs.emit(job, {"type": "error", "message": why})


def _remember(job, status: str, detail: dict) -> None:
    """Persist job state without allowing vault errors to mask the render result."""
    try:
        acecands.remember(job.id, status, getattr(job, "started_at", 0.0) or 0.0, detail)
    except BaseException as exc:      # noqa: BLE001 — see the docstring
        logger.warning(f"acestep: {job.id} not remembered as {status}: {exc}")


def _finish_after_exit(job, device: str, expected: bool, reason: str,
                       returncode: int | None) -> None:
    """Persist an active row only after the owned backend's exit was confirmed."""
    status = "canceled" if expected else "failed"
    error = (f"stopped by {reason}" if expected else
             f"ACE-Step on {device} exited unexpectedly with status {returncode}")
    with job.lock:
        if job.status in ("done", "failed", "canceled"):
            return
        job.status = status
        job.error = error
        snapshot = {**dict(job.detail or {}), "error": error}
    _remember(job, status, snapshot)
    jobs.emit(job, {"type": "canceled" if expected else "error", "message": error})
    try:
        from vocalis.web import acestep as web_acestep
        web_acestep.QUEUE.done(job.id)
    except (ImportError, AttributeError):
        pass
    acecands.reconcile_output(jobs)      # see the finally in `run_job`


def _exit_info(job):
    event = getattr(job, "_ace_child_exit", None)
    if event is not None and event.is_set():
        return getattr(job, "_ace_child_exit_info", None)
    return None


def _finish_cancelled(job, reason: str) -> None:
    with job.lock:
        job.status = "canceled"
        job.error = reason
        snapshot = {**dict(job.detail or {}), "error": reason}
    _remember(job, "canceled", snapshot)
    jobs.emit(job, {"type": "canceled", "message": reason})


def _finish_failed(job, error: str) -> None:
    with job.lock:
        job.status = "failed"
        job.error = error
        snapshot = {**dict(job.detail or {}), "error": error}
    _remember(job, "failed", snapshot)
    jobs.emit(job, {"type": "error", "message": error})


def _with_body(exc):
    """Return HTTP errors with a bounded response-body detail when available.
    The body is consumed once, so this helper belongs on the error-reporting path.
    """
    import urllib.error

    if not isinstance(exc, urllib.error.HTTPError):
        return exc
    try:
        raw = exc.read().decode("utf-8", "replace").strip()
    except (OSError, ValueError, AttributeError):
        return exc                      # a body we cannot read is no worse than no body at all
    if not raw:
        return exc
    detail = raw
    try:
        parsed = json.loads(raw)
        # FastAPI puts the sentence in `detail`; ACE-Step's own envelope uses `error`. Anything
        # else falls back to the raw text rather than to a lie about the shape.
        if isinstance(parsed, dict):
            detail = str(parsed.get("detail") or parsed.get("error") or raw)
    except (ValueError, TypeError):
        pass
    return RuntimeError(f"{exc} — {detail[:400]}")


def run_job(job, url: str, device: str, payload: dict, queue, task_id: str = None) -> None:
    """Submit or reattach to a render, poll until it reaches a terminal state, and
    persist the result. Reattachment uses the stored task identifier after a server
    restart, avoiding a duplicate generation.
    """
    started = time.time()
    misses = 0
    resolved = False
    timeout_noted = False
    ambiguous_submission = False
    with _WATCHING_LOCK:
        _WATCHING.add(job.id)
    try:
        with job.lock:
            job.status = "running"
            job.started_at = started
            # `seen_at` from the first instant it is "running": the reaper reads it, and a
            # row that is running with no stamp at all is a ghost by definition.
            job.detail = {**(job.detail or {}), "device": device, "url": url,
                          "seen_at": started}
        jobs.emit(job, {"type": "acestep_start", "device": device})

        if task_id:
            logger.info(f"acestep: reattaching {job.id} to task {task_id} on {device}")
        else:
            try:
                with acestep.submission_slot(device) as generation:
                    with job.lock:
                        job.detail = {**(job.detail or {}), "backend_generation": generation,
                                      "submission_state": "submitting"}
                    # Persist the generation fence before the request can be interrupted.
                    _remember(job, "running", dict(job.detail or {}))
                    task_id = acestep.submit(url, payload)
                    with job.lock:
                        job.detail = {**(job.detail or {}), "task_id": task_id,
                                      "submission_state": "submitted"}
            except acestep.BackendUnavailable:
                with job.lock:
                    job.status = "queued"
                    job.started_at = 0.0
                    job.detail = {**(job.detail or {}), "submission_state": "not_submitted"}
                jobs.emit(job, {"type": "queued", "reason": "backend_transition"})
                queue.defer(job.id)
                return
            except Exception as exc:  # the request may have reached ACE-Step without a reply
                rejected = (isinstance(exc, acestep.SubmissionRejected)
                            or (isinstance(exc, urllib.error.HTTPError)
                                and 400 <= exc.code < 500))
                if rejected:
                    _finish_failed(job, str(_with_body(exc)))
                    resolved = True
                    return
                exc = _with_body(exc)
                ambiguous_submission = True
                with job.lock:
                    job.detail = {**(job.detail or {}), "submission_state": "ambiguous",
                                  "error": "submission outcome is unknown; no retry was sent"}
                    snapshot = dict(job.detail)
                _remember(job, "running", snapshot)
                jobs.emit(job, {"type": "warning", "message": snapshot["error"]})
                logger.warning(f"acestep submit {job.id} on {device}: outcome is ambiguous: {exc}")
                # There is no task id to poll. Retain the device reservation until this exact
                # child exits; never retry an ambiguous request or infer idleness from HTTP.
                while not _exit_info(job):
                    _beat(job)
                    time.sleep(POLL_SECONDS)
                info = _exit_info(job) or {}
                _finish_after_exit(job, device, info.get("expected", False),
                                   info.get("reason", "unexpected-exit"), info.get("returncode"))
                resolved = True
                return
        with job.lock:
            job.detail = {**(job.detail or {}), "task_id": task_id,
                          "submission_state": "submitted"}
            snapshot = dict(job.detail)
        # Persist the task ID immediately so restart recovery can reattach.
        _remember(job, "running", snapshot)
        jobs.emit(job, {"type": "acestep_submitted", "task_id": task_id, "device": device})

        while True:
            # Refresh the heartbeat so the stale-job reaper can detect abandoned watchers.
            _beat(job)
            # A watcher timeout is not proof that the backend stopped. Keep the reservation and
            # continue collecting until a terminal backend result or confirmed child exit.
            if time.time() - started > WATCH_SECONDS and misses == 0 and not timeout_noted:
                logger.warning(f"acestep watcher {job.id} on {device} exceeded {int(WATCH_SECONDS)}s")
                timeout_noted = True

            time.sleep(POLL_SECONDS)
            try:
                r = acestep.poll(url, task_id)
            except Exception as e:      # noqa: BLE001 — a transient poll failure is not the job
                misses += 1
                logger.debug(f"acestep poll {task_id} on {device} ({misses}): {e}")
                if _exit_info(job):
                    info = _exit_info(job) or {}
                    _finish_after_exit(job, device, info.get("expected", False),
                                       info.get("reason", "unexpected-exit"), info.get("returncode"))
                    resolved = True
                    return
                if misses == MAX_POLL_MISSES:
                    logger.warning(f"acestep poll {task_id} on {device}: backend is still owned; "
                                   "keeping the reservation until a result or confirmed exit")
                continue

            # A backend stats check disambiguates a synthetic RUNNING response for an
            # unknown task. Ignore unreachable stats so unsupported backends are unaffected.
            if not r.get("missing") and r["status"] == acestep.RUNNING and not r.get("audio"):
                st = acestep.stats(url)
                if st["reachable"] and (st["running"] + st["queued"]) == 0:
                    r["missing"] = True

            if r.get("missing"):
                misses += 1
                if _exit_info(job):
                    info = _exit_info(job) or {}
                    _finish_after_exit(job, device, info.get("expected", False),
                                       info.get("reason", "unexpected-exit"), info.get("returncode"))
                    resolved = True
                    return
                if misses == MAX_POLL_MISSES:
                    logger.warning(f"acestep task {task_id} on {device} is unrecognized; "
                                   "keeping the reservation until a terminal result or child exit")
                continue
            misses = 0                  # it answered: whatever that was, it was transient

            if r["status"] == acestep.RUNNING:
                if _exit_info(job):
                    info = _exit_info(job) or {}
                    _finish_after_exit(job, device, info.get("expected", False),
                                       info.get("reason", "unexpected-exit"), info.get("returncode"))
                    resolved = True
                    return
                if r.get("progress") is not None:
                    jobs.emit(job, {"type": "progress", "value": r["progress"]})
                continue

            if r["status"] == acestep.SUCCEEDED and r["audio"]:
                if job.cancel.is_set():
                    _finish_cancelled(job, "canceled after the backend finished; generated audio was not collected")
                    resolved = True
                    return
                with job.lock:
                    # The audio goes on the job BEFORE the status says done (2026-10-11): the pass that deletes
                    # unreferenced output reads both without this lock, and a done job with no audio yet would
                    # leave its new song looking like a file nothing refers to.
                    job.detail = {**(job.detail or {}), "audio": r["audio"]}
                    job.status = "done"
                    # Keep backend-rendered metadata separate from the submitted template.
                    # Empty results do not replace metadata captured by an earlier poll.
                    if r.get("song"):
                        job.detail["rendered"] = r["song"]
                    snapshot = dict(job.detail)
                # Persist the candidate metadata before returning the completed job.
                _remember(job, "done", snapshot)
                jobs.emit(job, {"type": "job_done", "audio": r["audio"]})
                resolved = True
                return

            # Unknown backend statuses are recorded verbatim in the failure message.
            error = r.get("error") or f"the backend reported status {r['status']}"
            if job.cancel.is_set():
                _finish_cancelled(job, "canceled after the backend reached a terminal result")
            else:
                _finish_failed(job, error)
            resolved = True
            return

    except Exception as e:              # noqa: BLE001 — see the module header
        e = _with_body(e)
        logger.error(f"acestep job {getattr(job, 'id', '?')} on {device}: {e}")
        try:
            with job.lock:
                job.detail = {**(job.detail or {}),
                              "error": "watcher lost certainty; retaining the device until child exit"}
            ambiguous_submission = True
        except Exception:               # noqa: BLE001 — reporting must not mask the `finally`
            logger.exception("failed to record ACE-Step watcher error")
        if ambiguous_submission and not resolved:
            while not _exit_info(job):
                _beat(job)
                time.sleep(POLL_SECONDS)
            info = _exit_info(job) or {}
            _finish_after_exit(job, device, info.get("expected", False),
                               info.get("reason", "unexpected-exit"), info.get("returncode"))
            resolved = True
    finally:
        with _WATCHING_LOCK:
            _WATCHING.discard(job.id)
        if resolved:
            queue.done(getattr(job, "id", None))
            # (2026-10-11) The song of a render canceled after the engine finished is written but
            # never recorded, and this is the moment the card goes idle: collect it, and any
            # other file nothing refers to. A no-op while another job is queued or running.
            acecands.reconcile_output(jobs)
