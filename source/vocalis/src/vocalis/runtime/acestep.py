"""Manage locally owned ACE-Step API children, one process per authorized card.

The typed `acestep.api_server` exposes the endpoints and request validation Vocalis needs; the
Gradio router has a smaller, permissive API surface. These services are separate from any
user-managed Gradio instance.

Each child is started on demand with a fixed visible device. Process, HTTP, and model readiness
are tracked separately so a child can start without loading a model.
"""
import concurrent.futures as cf
import atexit
import contextlib
import dataclasses
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from loguru import logger

from vocalis.runtime import settings, subsystems

#: Stable local instance names are used only in status and error responses.
ACESTEP_BASE_SERVICE = "acestep-api-gpu0"
ACESTEP_BASE_PORT = 7683
ACESTEP_PORT_STEP = 2
ACESTEP_INSTANCES_DEFAULT = 1     # one card is the ordinary case

STOP_WAIT_SECONDS = 10.0
KILL_WAIT_SECONDS = 5.0
SUBMISSION_WAIT_SECONDS = 35.0


class BackendUnavailable(RuntimeError):
    """A job could not be submitted because its owned backend is changing state."""


class SubmissionRejected(RuntimeError):
    """ACE-Step explicitly rejected a render before accepting it."""


class SubmissionUnknown(RuntimeError):
    """A request may have been accepted, but its task identifier was not returned."""


@dataclasses.dataclass
class _Backend:
    service: str
    url: str
    device: str
    process: subprocess.Popen | None = None
    generation: int = 0
    phase: str = "stopped"
    transition: str | None = None
    error: str | None = None
    ready: bool = False
    model_ready: bool | None = None
    submissions: int = 0
    exit_reported: int = 0
    lock: threading.RLock = dataclasses.field(default_factory=threading.RLock)
    condition: threading.Condition = dataclasses.field(init=False)
    lifecycle: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    model_lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    model_mutating: bool = False

    def __post_init__(self):
        self.condition = threading.Condition(self.lock)


_BACKENDS: dict[str, _Backend] = {}
_BACKENDS_LOCK = threading.Lock()
_STOP_ALL = threading.Event()


def _nth(i: int) -> tuple:
    """Return a stable local child id, loopback URL and container-visible device id."""
    svc = ACESTEP_BASE_SERVICE if i == 0 else f"acestep-api-gpu{i}"
    return svc, f"http://127.0.0.1:{ACESTEP_BASE_PORT + i * ACESTEP_PORT_STEP}", f"cuda:{i}"


def configured(app_settings: dict = None) -> list:
    """The configured (service, url, device) triples — same precedence as ComfyUI's:
    env var → app_settings.yaml `acestep:` → default."""
    s = (app_settings if app_settings is not None else settings.load_app_settings() or {}).get("acestep")
    if not isinstance(s, dict):        # a hand-edited `acestep: "oops"` must not raise here
        s = {}
    try:
        n = int(os.environ.get("VOCALIS_ACESTEP_INSTANCES") or s.get("instances")
                or ACESTEP_INSTANCES_DEFAULT)
    except (TypeError, ValueError):    # `instances: two` must not sink the button
        n = ACESTEP_INSTANCES_DEFAULT
    return [_nth(i) for i in range(max(0, n))]


def installed() -> list:
    """Return the configured local instances; their child processes are created on demand."""
    return configured()


def _backend(service: str = None, device: str = None) -> _Backend | None:
    for svc, url, dev in configured():
        if (service is None or service == svc) and (device is None or device == dev):
            with _BACKENDS_LOCK:
                return _BACKENDS.setdefault(dev, _Backend(svc, url, dev))
    return None


def _runtime_inputs() -> tuple[str, str, str]:
    """Resolve the isolated Python, source root and model root supplied by the image."""
    python = os.environ.get("VOCALIS_ACESTEP_PYTHON", "").strip()
    source = os.environ.get("VOCALIS_ACESTEP_SOURCE", "").strip()
    model_root = os.environ.get("VOCALIS_ACESTEP_MODEL_DIR", "").strip()
    if not python or not source or not model_root:
        raise RuntimeError("ACE-Step runtime paths are not configured")
    if not os.path.isabs(python) or not os.path.isfile(python):
        raise RuntimeError("ACE-Step Python executable is missing")
    if not os.path.isabs(source) or not os.path.isfile(os.path.join(source, "acestep", "api_server.py")):
        raise RuntimeError("ACE-Step source root is missing its typed API server")
    if not os.path.isabs(model_root):
        raise RuntimeError("ACE-Step model root must be an absolute path")
    return python, source, model_root


def _child_environment(device: str, index: int, model_root: str) -> dict:
    from engine_process import visible_device_index

    env = os.environ.copy()
    physical = visible_device_index(index)
    work = os.environ.get("VOCALIS_ACESTEP_STAGE_DIR", "/work/vocalis/acestep")
    env.update({
        "ACESTEP_DEVICE": "auto",
        "ACESTEP_LM_BACKEND": "pt",
        "ACESTEP_NO_INIT": "true",
        "ACESTEP_MODEL_ROOT": model_root,
        "ACESTEP_CHECKPOINTS_DIR": model_root,
        "ACESTEP_TMPDIR": work,
        "TMPDIR": work,
        "CUDA_VISIBLE_DEVICES": physical,
        "HIP_VISIBLE_DEVICES": physical,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
    })
    # The two settings below are what the standalone install's ACE-Step service has always set and
    # this child never did until October 11, 2026. `setdefault`, so a value put in the container's
    # environment still wins.
    #
    # ACESTEP_ROCM_DTYPE: on an AMD card the engine loads every model as 32-bit floats unless told
    # otherwise (its caution for AMD integrated graphics). That is twice the card memory of the
    # 16-bit format it picks by itself on NVIDIA. Measured on a 32 GB AMD card that day without
    # this: acestep-v15-xl-sft alone held 23.2 GB, and Extract, Replace and Complete of a
    # 35-second song ran out of memory in the audio encoder. The engine reads this variable only
    # when the card is AMD, so it changes nothing on NVIDIA.
    env.setdefault("ACESTEP_ROCM_DTYPE", "bfloat16")
    # ACESTEP_GENERATION_TIMEOUT: the engine gives up on a render after 600 seconds by default. A
    # long song at 50 steps on a large model can take longer than that on a slower card.
    env.setdefault("ACESTEP_GENERATION_TIMEOUT", "3600")
    return env


def _owned_group_exists(process: subprocess.Popen) -> bool:
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _signal_owned_group(process: subprocess.Popen, sig: int) -> None:
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def _report_exit(backend: _Backend, generation: int, *, expected: bool, reason: str,
                 returncode: int | None) -> None:
    """Notify ACE's existing watcher after the exact owned process group has exited."""
    with backend.condition:
        if generation <= backend.exit_reported:
            return
        backend.exit_reported = generation
    try:
        from vocalis.runtime import acerun
        acerun.backend_exited(backend.device, generation, expected=expected,
                              reason=reason, returncode=returncode)
    except (ImportError, AttributeError):
        # Startup/shutdown can occur before the ACE routes are imported.
        pass


def _observe_exit(backend: _Backend) -> None:
    with backend.condition:
        process = backend.process
        generation = backend.generation
        if process is None or process.poll() is None:
            return
        expected = backend.transition in {"stop", "restart", "unload", "feature-disabled", "shutdown"}
        reason = backend.transition or "unexpected-exit"
        returncode = process.returncode
        backend.phase = "stopped" if expected else "failed"
        backend.error = (None if expected else
                         f"ACE-Step child exited unexpectedly with status {returncode}")
        backend.ready = False
        backend.model_ready = None
        backend.process = None
        backend.transition = None
        backend.condition.notify_all()
    # Remove any descendants that stayed in the child-owned group after its leader exited.
    _signal_owned_group(process, signal.SIGKILL)
    _report_exit(backend, generation, expected=expected, reason=reason, returncode=returncode)


def process_generation(device: str) -> int:
    backend = _backend(device=device)
    if backend is None:
        return 0
    with backend.condition:
        return backend.generation


def owns_generation(device: str, generation: int) -> bool:
    """Whether this Vocalis process still owns the exact ACE child recorded by a job."""
    backend = _backend(device=device)
    if backend is None:
        return False
    _observe_exit(backend)
    with backend.condition:
        return (backend.generation == generation and backend.process is not None
                and backend.process.poll() is None)


def process_state(device: str) -> dict:
    backend = _backend(device=device)
    if backend is None:
        return {"state": "missing", "generation": 0, "error": "unknown ACE-Step device"}
    _observe_exit(backend)
    with backend.condition:
        process = backend.process
        state = backend.phase
        if process is not None and process.poll() is None and backend.ready:
            state = "active"
        return {"state": state, "generation": backend.generation,
                "error": backend.error, "returncode": process.returncode if process else None}


def can_dispatch(device: str) -> bool:
    if _STOP_ALL.is_set() or not any(dev == device for _svc, _url, dev in instances()):
        return False
    backend = _backend(device=device)
    if backend is None:
        return False
    _observe_exit(backend)
    with backend.condition:
        return (backend.process is not None and backend.process.poll() is None
                and backend.transition is None and not backend.model_mutating
                and backend.ready and backend.model_ready is True
                and loading_model(device) is None)


@contextlib.contextmanager
def submission_slot(device: str):
    """Fence one API submission against device authorization and lifecycle transitions."""
    backend = _backend(device=device)
    if backend is None or _STOP_ALL.is_set():
        raise BackendUnavailable("the ACE-Step backend is stopping or not configured")
    # Read authorization before taking the per-child condition lock.
    if not any(dev == device for _svc, _url, dev in instances()):
        raise BackendUnavailable(f"ACE-Step is no longer authorized on {device}")
    with backend.condition:
        if (backend.transition is not None or backend.process is None
                or backend.process.poll() is not None or backend.model_mutating
                or not backend.ready or backend.model_ready is not True
                or loading_model(device) is not None):
            raise BackendUnavailable(f"ACE-Step on {device} is not ready to accept a render")
        backend.submissions += 1
        generation = backend.generation
    try:
        yield generation
    finally:
        with backend.condition:
            backend.submissions -= 1
            backend.condition.notify_all()


def _start_locked(backend: _Backend) -> dict:
    _observe_exit(backend)
    with backend.condition:
        if backend.process is not None and backend.process.poll() is None:
            if backend.transition is not None or backend.phase == "stopping":
                return {"ok": False, "state": "stopping", "device": backend.device,
                        "error": backend.error or "the previous ACE-Step child has not exited"}
            return {"ok": True, "state": backend.phase, "device": backend.device}
        try:
            python, source, model_root = _runtime_inputs()
        except RuntimeError as exc:
            backend.error = str(exc)
            backend.phase = "failed"
            return {"ok": False, "state": "failed", "device": backend.device,
                    "error": backend.error}
        index = int(backend.device.split(":", 1)[1])
        backend.transition = "start"
        backend.phase = "starting"
        backend.ready = False
        backend.model_ready = None
        backend.error = None
    from vocalis.runtime import paths
    launcher = paths.CODE_DIR / "scripts" / "acestep" / "worker.py"
    command = [python, str(launcher), "--host", "127.0.0.1",
               "--port", backend.url.rsplit(":", 1)[1], "--no-init"]
    try:
        process = subprocess.Popen(command, cwd=source, env=_child_environment(
            backend.device, index, model_root), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            close_fds=True)
    except OSError as exc:
        with backend.condition:
            backend.transition = None
            backend.phase = "failed"
            backend.error = f"could not start ACE-Step on {backend.device}: {exc}"
        return {"ok": False, "state": "failed", "device": backend.device,
                "error": backend.error}
    with backend.condition:
        backend.process = process
        backend.generation += 1
        backend.phase = "starting"
        backend.transition = None
        backend.error = None
        backend.condition.notify_all()
    return {"ok": True, "state": "starting", "device": backend.device,
            "generation": backend.generation}


def start_instance(service: str = None, device: str = None) -> dict:
    if _STOP_ALL.is_set():
        return {"ok": False, "state": "stopping",
                "error": "an ACE-Step global lifecycle transition is in progress"}
    backend = _backend(service=service, device=device)
    if backend is None:
        return {"ok": False, "state": "missing", "error": "ACE-Step instance is not configured"}
    if not backend.lifecycle.acquire(blocking=False):
        return {"ok": False, "state": "busy", "device": backend.device,
                "error": "an ACE-Step lifecycle action is already in progress"}
    try:
        return _start_locked(backend)
    finally:
        backend.lifecycle.release()


def _stop_locked(backend: _Backend, reason: str) -> dict:
    # If the leader had already exited, classify that as unexpected before this explicit
    # request rather than retroactively labeling the loss as an intentional stop.
    _observe_exit(backend)
    with backend.condition:
        backend.transition = reason
        deadline = time.monotonic() + SUBMISSION_WAIT_SECONDS
        while backend.submissions:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                backend.phase = "stopping"
                backend.error = "ACE-Step submission did not settle; child exit is still pending"
                backend.condition.notify_all()
                return {"ok": False, "state": "busy", "device": backend.device,
                        "error": backend.error}
            backend.condition.wait(remaining)
        process = backend.process
        generation = backend.generation
        if process is None:
            backend.phase = "stopped"
            backend.ready = False
            backend.transition = None
            return {"ok": True, "state": "stopped", "device": backend.device,
                    "already_stopped": True}
        backend.phase = "stopping"
        backend.ready = False
        backend.model_ready = None
    try:
        if process.poll() is None:
            _signal_owned_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=STOP_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                _signal_owned_group(process, signal.SIGKILL)
                process.wait(timeout=KILL_WAIT_SECONDS)
        # The group leader has exited. Do not report success while an owned descendant remains.
        if _owned_group_exists(process):
            _signal_owned_group(process, signal.SIGKILL)
            deadline = time.monotonic() + KILL_WAIT_SECONDS
            while _owned_group_exists(process) and time.monotonic() < deadline:
                time.sleep(0.05)
        if _owned_group_exists(process):
            raise TimeoutError("owned process group is still present")
    except (OSError, subprocess.SubprocessError, TimeoutError) as exc:
        with backend.condition:
            backend.phase = "stopping"
            backend.error = f"could not confirm ACE-Step exit on {backend.device}: {exc}"
            backend.condition.notify_all()
        return {"ok": False, "state": "stopping", "device": backend.device,
                "error": backend.error, "generation": generation}
    returncode = process.returncode
    with backend.condition:
        backend.process = None
        backend.phase = "stopped"
        backend.transition = None
        backend.ready = False
        backend.model_ready = None
        backend.error = None
        backend.condition.notify_all()
    _report_exit(backend, generation, expected=True, reason=reason, returncode=returncode)
    return {"ok": True, "state": "stopped", "device": backend.device,
            "generation": generation, "returncode": returncode}


def stop_instance(service: str = None, device: str = None, *, reason: str = "stop") -> dict:
    backend = _backend(service=service, device=device)
    if backend is None:
        return {"ok": False, "state": "missing", "error": "ACE-Step instance is not configured"}
    if not backend.lifecycle.acquire(blocking=False):
        return {"ok": False, "state": "busy", "device": backend.device,
                "error": "an ACE-Step lifecycle action is already in progress"}
    try:
        return _stop_locked(backend, reason)
    finally:
        backend.lifecycle.release()


def restart_instance(service: str = None, device: str = None, *, reason: str = "restart") -> dict:
    backend = _backend(service=service, device=device)
    if backend is None:
        return {"ok": False, "state": "missing", "error": "ACE-Step instance is not configured"}
    if not backend.lifecycle.acquire(blocking=False):
        return {"ok": False, "state": "busy", "device": backend.device,
                "error": "an ACE-Step lifecycle action is already in progress"}
    try:
        stopped = _stop_locked(backend, reason)
        if not stopped["ok"]:
            return stopped
        return _start_locked(backend)
    finally:
        backend.lifecycle.release()


def start_all() -> list[dict]:
    return [start_instance(service=service) for service, _url, _device in installed()]


def stop_all(*, reason: str = "stop") -> list[dict]:
    _STOP_ALL.set()
    try:
        return [stop_instance(service=service, reason=reason)
                for service, _url, _device in installed()]
    finally:
        _STOP_ALL.clear()


def restart_all(*, reason: str = "restart") -> list[dict]:
    _STOP_ALL.set()
    try:
        return [restart_instance(service=service, reason=reason)
                for service, _url, _device in installed()]
    finally:
        _STOP_ALL.clear()


def _shutdown_owned() -> None:
    """Terminate only child groups created by this Vocalis process."""
    _STOP_ALL.set()
    with _BACKENDS_LOCK:
        backends = list(_BACKENDS.values())
    for backend in backends:
        if backend.process is None:
            continue
        if not backend.lifecycle.acquire(timeout=SUBMISSION_WAIT_SECONDS):
            logger.error(f"ACE-Step shutdown could not acquire lifecycle lock for {backend.device}")
            continue
        try:
            result = _stop_locked(backend, "shutdown")
            if not result.get("ok"):
                logger.error(f"ACE-Step shutdown did not confirm {backend.device} exit: "
                             f"{result.get('error')}")
        finally:
            backend.lifecycle.release()


atexit.register(_shutdown_owned)

_PREVIOUS_SIGTERM = signal.getsignal(signal.SIGTERM)


def _write_last_log_line(text: str, wait_s: float = 2.0) -> None:
    """Log one last line before an immediate exit and give it, and any line before it, a bounded time to be written.

    The main server's log sinks are queued (`enqueue=True` in tts_utils), so a line is on disk only after the
    writer thread has run; an `os._exit` straight after `logger.info` lost it six times out of six (measured
    October 11, 2026). `logger.complete()` waits for the queue. Both calls run on a helper thread that is joined for
    `wait_s`: if the stop signal interrupted the main thread inside a log call, logging from this thread would
    wait on the lock that call holds, and the stop must not wait with it."""
    def write():
        try:
            logger.info(text)
            logger.complete()
        except (RuntimeError, OSError, ValueError):         # a log sink in trouble must not block the stop
            pass

    helper = threading.Thread(target=write, name="vocalis-stop-log", daemon=True)
    helper.start()
    helper.join(wait_s)


def _terminate_owned_children(signum, frame, _exit=os._exit) -> None:
    """Stop child groups, then end the process at once with the usual stop-signal exit code.

    This used to raise SystemExit, which runs Python's normal shutdown. With a speech render in progress that
    shutdown aborts inside the C++ runtime ("terminate called without an active exception": native threads are
    still alive when their owners are torn down), and the container ended as killed, exit 137, after 4 seconds on
    the NVIDIA test machine and after Docker's full 10-second grace period on the AMD one (measured October 11, 2026;
    idle, the same stop exited 143 in 1 second). Nothing was lost in any of nine such stops, but it is an unclean end
    with no line in the log. The owned children are already stopped above and the stores are built to survive the
    process ending at any moment, so the normal shutdown has nothing left to do: write the last log line, wait a
    bounded moment for the log to reach disk, and exit. `_exit` is a parameter for the test."""
    _shutdown_owned()
    if callable(_PREVIOUS_SIGTERM):
        _PREVIOUS_SIGTERM(signum, frame)
        return
    _write_last_log_line("stop requested: owned engine processes are stopped; Vocalis is exiting")
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError, RuntimeError):         # closed or broken console, or a flush this signal interrupted ("reentrant call"): none may block the stop
            pass
    _exit(128 + signum)


if threading.current_thread() is threading.main_thread():
    signal.signal(signal.SIGTERM, _terminate_owned_children)


def mark_http_ready(url: str) -> None:
    for _service, configured_url, device in installed():
        if configured_url == url:
            backend = _backend(device=device)
            if backend is not None:
                with backend.condition:
                    if backend.process is not None and backend.process.poll() is None:
                        backend.ready = True
                        if backend.phase == "starting":
                            backend.phase = "active"
            return


def mark_model_ready(url: str, ready: bool | None) -> None:
    for _service, configured_url, device in installed():
        if configured_url == url:
            backend = _backend(device=device)
            if backend is not None:
                with backend.condition:
                    if backend.process is not None and backend.process.poll() is None:
                        backend.model_ready = ready
            return


def _begin_model_change(device: str) -> _Backend:
    backend = _backend(device=device)
    if backend is None or not backend.model_lock.acquire(blocking=False):
        raise BackendUnavailable(f"ACE-Step on {device} is already changing model state")
    with backend.condition:
        if (backend.transition is not None or backend.process is None
                or backend.process.poll() is not None):
            backend.model_lock.release()
            raise BackendUnavailable(f"ACE-Step on {device} is not running")
        backend.model_mutating = True
    return backend


def _end_model_change(backend: _Backend) -> None:
    with backend.condition:
        backend.model_mutating = False
        backend.condition.notify_all()
    backend.model_lock.release()


@contextlib.contextmanager
def model_change(device: str):
    """Serialize LoRA mutation against other model changes and render submission."""
    backend = _begin_model_change(device)
    try:
        yield
    finally:
        _end_model_change(backend)


def active_states(insts=None) -> dict:
    """Return owned child state independently of HTTP and model readiness."""
    insts = installed() if insts is None else list(insts)
    out = {}
    for service, _url, device in insts:
        backend = _backend(service=service)
        if backend is None:
            out[device] = "inactive"
            continue
        _observe_exit(backend)
        with backend.condition:
            out[device] = backend.phase
    return out


def instances() -> list:
    """Return installed ACE-Step services authorized for their configured devices."""
    rows = {str(d.get("id")): d for d in ((settings.load_app_settings() or {}).get("devices") or [])
            if isinstance(d, dict)}
    out = []
    for svc, url, dev in installed():
        cfg = rows.get(dev)
        if cfg is not None and not cfg.get("enabled", True):
            continue                   # the whole card is switched off
        if not subsystems.authorized(cfg or {}, subsystems.ACESTEP):
            continue
        out.append((svc, url, dev))
    return out


def control_available() -> bool:
    return bool(instances())


def active_count(states=None):
    """Count live owned children, preserving uncertainty during an unconfirmed stop."""
    st = active_states() if states is None else states
    if not st:
        return None
    if any(v == "stopping" for v in st.values()):
        return None
    return sum(1 for v in st.values() if v in {"active", "starting"})


def probe(url: str, timeout: float = 3.0) -> dict:
    """Query one backend health endpoint.

    `model_loaded` is `None` when the backend is unreachable, distinguishing an
    unknown state from a confirmed unloaded model.
    """
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/health", timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as e:
        logger.debug(f"acestep probe {url}: {e}")
        return {"up": False, "model_loaded": None, "model": None}
    mark_http_ready(url)
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        mark_model_ready(url, None)
        return {"up": True, "model_loaded": None, "model": None}
    model_loaded = bool(data.get("models_initialized"))
    mark_model_ready(url, model_loaded)
    return {"up": True,
            "model_loaded": model_loaded,
            "model": data.get("loaded_model") or None}


def probe_many(insts, timeout: float = 3.0) -> dict:
    """Probe all backend health endpoints concurrently and return results by URL.

    No cache is used because readiness can change while the status view is open.
    """
    urls = list(dict.fromkeys(u for _svc, u, _dev in insts))
    if not urls:
        return {}
    if len(urls) == 1:
        return {urls[0]: probe(urls[0], timeout)}
    with cf.ThreadPoolExecutor(max_workers=len(urls)) as ex:
        return dict(zip(urls, ex.map(lambda u: probe(u, timeout), urls)))


def _get(url: str, path: str, timeout: float = 10.0):
    """One wrapped GET. ACE-Step answers `{"data": …, "code": 200}`, so unwrap here rather than
    at every call site."""
    with urllib.request.urlopen(url.rstrip("/") + path, timeout=timeout) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    return body.get("data") if isinstance(body, dict) else None


def inventory(url: str) -> dict:
    """Return model and supported-task information from `/v1/model_inventory`.

    `/v1/models` lists only loaded models and cannot describe lazy backends.
    """
    try:
        data = _get(url, "/v1/model_inventory")
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as e:
        logger.debug(f"acestep inventory {url}: {e}")
        # Keep the result shape consistent even when inventory is unavailable.
        return {"models": [], "default": None, "reachable": False, "tasks": {}}
    if not isinstance(data, dict):
        return {"models": [], "default": None, "reachable": False, "tasks": {}}
    # Use backend-reported task support rather than inferring capabilities from
    # model names; the request model does not validate task types itself.
    tasks = {}
    for m in (data.get("models") or []):
        if m.get("name"):
            got = m.get("supported_task_types")
            tasks[m["name"]] = list(got) if isinstance(got, list) else []
    return {"models": [m.get("name") for m in (data.get("models") or []) if m.get("name")],
            "default": data.get("default_model"),
            "reachable": True, "tasks": tasks}


# The backend exposes LM formatting routes separately from full render submission.
# Keep their path variants and wrapped error handling explicit at this boundary.

#: Long enough to cover a cold 5 Hz LM load on a card that has nothing resident yet.
LM_TIMEOUT = 300.0


def _http_error_reason(exc) -> str:
    """The engine's own sentence from the body of an HTTP error answer, or `""`.

    The engine answers a refused request with JSON: `{"detail": "..."}` (its web framework's form)
    or `{"error": "..."}`. Anything else (no body, not JSON, no text field) gives `""` and the
    caller keeps the plain HTTP error."""
    try:
        got = json.loads(exc.read().decode("utf-8", "replace"))
    except (OSError, ValueError):
        return ""
    if not isinstance(got, dict):
        return ""
    for key in ("detail", "error", "message"):
        value = got.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _post_wrapped(url: str, path: str, body: dict, timeout: float):
    """POST JSON to one of the `_wrap_response` routes and return its `data`.

    Raises `RuntimeError` with the backend's own message on the in-body failure code — see the
    section header on why the HTTP status alone is not the answer.
    """
    data = json.dumps(body).encode()
    req = urllib.request.Request(url.rstrip("/") + path, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            got = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        # October 11, 2026: a LoRA path the engine refused came back to the page as "HTTP Error 400:
        # Bad Request", which says nothing. The engine's reason is in the body of that answer.
        reason = _http_error_reason(exc)
        if reason:
            raise RuntimeError(reason) from exc
        raise
    if not isinstance(got, dict):
        raise RuntimeError(f"{path} returned a non-object")
    if got.get("error") or int(got.get("code") or 200) >= 400:
        raise RuntimeError(str(got.get("error") or f"{path} failed with code {got.get('code')}"))
    out = got.get("data")
    if not isinstance(out, dict):
        raise RuntimeError(f"{path} returned no fields")
    return out


def _as_song(data: dict) -> dict:
    """Normalize model-generated metadata into the form field names.

    Accept both backend spellings for key and time signature, and omit empty values
    so absent model output does not erase user-entered fields.
    """
    pick = lambda *names: next((data[n] for n in names if data.get(n) not in (None, "")), None)
    out = {"caption": pick("caption"), "lyrics": pick("lyrics"), "bpm": pick("bpm"),
           "key_scale": pick("key_scale", "keyscale"),
           "time_signature": pick("time_signature", "timesignature"),
           "duration": pick("duration"),
           "vocal_language": pick("vocal_language", "language")}
    return {k: v for k, v in out.items() if v is not None}


def create_sample(url: str, *, query: str, instrumental: bool = False,
                  vocal_language: str = "unknown", temperature: float = 0.85,
                  timeout: float = LM_TIMEOUT) -> dict:
    """Ask the 5 Hz LM to write a song from a plain-language description. No render, no GPU diffusion.

    An EMPTY query is legitimate and means "surprise me" — upstream's own inference path sends the
    literal string `"NO USER INPUT"` for it (`llm_generation_inputs.py:119`), so this does the
    same rather than refusing.
    """
    return _as_song(_post_wrapped(url, "/v1/create_sample", {
        "query": str(query or "") or "NO USER INPUT",
        "instrumental": bool(instrumental),
        "vocal_language": str(vocal_language or "unknown"),
        "temperature": float(temperature)}, timeout))


def format_input(url: str, *, caption: str = "", lyrics: str = "", metadata: dict = None,
                 temperature: float = 0.85, timeout: float = LM_TIMEOUT) -> dict:
    """Format or enrich an existing caption and lyrics without starting a render.

    This exposes the backend formatting operation as a separate user action.
    """
    body = {"caption": str(caption or ""), "prompt": str(caption or ""),
            "lyrics": str(lyrics or ""), "temperature": float(temperature)}
    if metadata:
        # The backend reads metadata from `param_obj` and maps it to its format prompt.
        body["param_obj"] = dict(metadata)
    return _as_song(_post_wrapped(url, "/format_input", body, timeout))


# LoRA selection is backend state because each service is pinned to one device.
# These endpoints require an initialized model, as the model controls do.


def lora_status(url: str, timeout: float = 10.0) -> dict:
    """What adapter this backend is holding, if any.

    A backend that is down, or up with no model, is reported as "nothing loaded" rather than
    raising: the card row still has to render, and it is the row that offers to fix both.
    """
    try:
        data = _get(url, "/v1/lora/status", timeout=timeout)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as e:
        logger.debug(f"acestep lora status {url}: {e}")
        return {"loaded": False, "use_lora": False, "scale": 1.0, "reachable": False}
    if not isinstance(data, dict):
        return {"loaded": False, "use_lora": False, "scale": 1.0, "reachable": False}
    return {"loaded": bool(data.get("lora_loaded")),
            "use_lora": bool(data.get("use_lora")),
            "scale": float(data.get("lora_scale") or 1.0),
            "adapter_type": data.get("adapter_type"),
            "active_adapter": data.get("active_adapter"),
            "reachable": True}


def lora_load(url: str, path: str, *, adapter_name: str = "", timeout: float = 300.0) -> dict:
    """Attach an adapter. Generous timeout: this reads weights off disk."""
    body = {"lora_path": str(path or "")}
    if adapter_name:
        body["adapter_name"] = adapter_name
    return _post_wrapped(url, "/v1/lora/load", body, timeout)


def lora_unload(url: str, timeout: float = 60.0) -> dict:
    """Drop the adapter and go back to the base model.

    Unloading the adapter keeps the base model resident.
    """
    return _post_wrapped(url, "/v1/lora/unload", {}, timeout)


def lora_toggle(url: str, on: bool, timeout: float = 30.0) -> dict:
    """Use the loaded adapter, or ignore it without unloading it — an A/B without a reload."""
    return _post_wrapped(url, "/v1/lora/toggle", {"use_lora": bool(on)}, timeout)


def lora_scale(url: str, scale: float, *, adapter_name: str = "", timeout: float = 30.0) -> dict:
    """How strongly the adapter applies."""
    body = {"scale": float(scale)}
    if adapter_name:
        body["adapter_name"] = adapter_name
    return _post_wrapped(url, "/v1/lora/scale", body, timeout)


#: `/query_result`'s integer status. Text in the store, ints on the wire — mapped by
#: Queued/running map to 0, succeeded to 1, and other backend statuses to 2.
#: Value 2 means not succeeded; it does not prove a backend failure.
RUNNING, SUCCEEDED, FAILED = 0, 1, 2


def submit(url: str, payload: dict, timeout: float = 30.0) -> str:
    """POST one job to `/release_task` and return its task id.

    Use the typed API route so request fields are validated and mapped by the backend.
    """
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url.rstrip("/") + "/release_task", data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    if not isinstance(body, dict):
        raise SubmissionUnknown("release_task returned a non-object")
    if body.get("error"):
        raise SubmissionRejected(str(body["error"]))
    task_id = (body.get("data") or {}).get("task_id")
    if not task_id:
        raise SubmissionUnknown("release_task returned no task_id")
    return str(task_id)


_PROGRESS_PREFIX = re.compile(r"^\s*(?:\d{1,2}:\d{2}:\d{2}\s*\|\s*[A-Z]+\s*\|\s*)?(?:\[[\w.]+\]\s*)?")


def poll(url: str, task_id: str, timeout: float = 15.0) -> dict:
    """Ask `/query_result` about one job.

    The endpoint expects a POST body containing `task_id_list`.

    Returns `{"status": int, "audio": [paths], "error": str|None, "progress": float|None}`.
    """
    data = json.dumps({"task_id_list": [task_id]}).encode()
    req = urllib.request.Request(url.rstrip("/") + "/query_result", data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    rows = (body or {}).get("data") if isinstance(body, dict) else None
    if not rows:
        # An id the server has never heard of, or has already swept. Not an error in itself —
        # the caller decides, because "too early to know" and "gone" look identical here.
        # `missing` lets the caller distinguish an unknown task from an active render
        # and require repeated responses before deciding the task was lost.
        return {"status": RUNNING, "audio": [], "error": None, "progress": None, "missing": True}
    row = rows[0] if isinstance(rows[0], dict) else {}
    status = int(row.get("status", RUNNING))
    # Results are nested under `data`, with each output path under its song's `file` field. Ignore
    # empty file values, which represent successful tasks that produced no audio.
    items = _result_items(row)
    audio = [p for p in (_fs_path(it.get("file")) for it in items if isinstance(it, dict)) if p]
    if not audio:
        # The flat shapes, kept because they cost nothing and this is the seam where a version
        # difference would land silently rather than loudly.
        audio = [row["file"]] if row.get("file") else list(row.get("audio_paths") or [])
    # `status_message` is present on SUCCESS too ("…Success"), so it is only an error when the
    # status actually says so — otherwise a finished song would carry an error string.
    error = row.get("error")
    if not error and status == FAILED:
        error = next((it.get("status_message") for it in items
                      if isinstance(it, dict) and it.get("status_message")), None)
    if not error and status == FAILED and row.get("progress_text"):
        # 🔴 The backend's own reason often arrives ONLY here. 2026-10-09, M1 on the AMD test host:
        # a render refused by ACE's VRAM pre-flight came back as status 2 with an empty result and
        # "[generate_music] VRAM pre-flight failed: Insufficient free VRAM: need ~0.8 GB, only 0.1
        # GB available…" in progress_text, and the job said only "the backend reported status 2".
        # The child's own output is not kept (its log can carry lyrics), so this is the one place
        # the reason survives. Drop the "HH:MM:SS | LEVEL | [function] " log prefix.
        error = _PROGRESS_PREFIX.sub("", str(row["progress_text"])).strip() or None
    progress = row.get("progress")
    if progress is None:
        progress = next((it.get("progress") for it in items
                         if isinstance(it, dict) and it.get("progress") is not None), None)
    return {"status": status, "audio": audio, "error": error, "progress": progress,
            "song": _song_of(items)}


def stats(url: str, timeout: float = 5.0) -> dict:
    """Return backend-wide queued and running counts. `/query_result` may return a fabricated running row for an unknown task id, so it cannot reliably establish whether a reattached job still exists. `/v1/stats` reports backend state instead. If the route is unavailable, callers must leave job status unchanged because older backends may not implement it."""
    try:
        data = _get(url, "/v1/stats", timeout=timeout)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as e:
        logger.debug(f"acestep stats {url}: {e}")
        return {"reachable": False, "queued": 0, "running": 0, "total": 0}
    jobs_ = (data or {}).get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs_, dict):
        return {"reachable": False, "queued": 0, "running": 0, "total": 0}
    def n(k):
        try:
            return int(jobs_.get(k) or 0)
        except (TypeError, ValueError):
            return 0
    return {"reachable": True, "queued": n("queued"), "running": n("running"),
            "total": n("total")}


def _song_of(items: list) -> dict:
    """Return the caption, lyrics, and metadata that the model actually used, or `{}` when absent. Translate backend field names to the names used by templates in this function. Omit empty values so missing metadata does not overwrite user-entered text."""
    for it in items:
        if not isinstance(it, dict):
            continue
        metas = it.get("metas") if isinstance(it.get("metas"), dict) else {}
        out = {}
        for key, got in (("caption", it.get("prompt")), ("lyrics", it.get("lyrics")),
                         ("bpm", metas.get("bpm")), ("duration", metas.get("duration")),
                         ("key_scale", metas.get("keyscale")),
                         ("time_signature", metas.get("timesignature")),
                         ("genres", metas.get("genres"))):
            if got not in (None, ""):
                out[key] = got
        if out:
            return out
    return {}


def _result_items(row: dict) -> list:
    """Return per-song entries from a `/query_result` row. The `result` field may be a JSON string or an already decoded list/dict; accept both wire shapes to avoid silently treating successful renders as empty."""
    raw = row.get("result")
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return []
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            logger.warning(f"acestep: /query_result 'result' was an unparseable string: {raw[:200]!r}")
            return []
    if isinstance(raw, dict):
        return [raw]
    return raw if isinstance(raw, list) else []


def _fs_path(value):
    """The filesystem path out of whatever `file` holds.

    The backend may return an audio URL instead of a filesystem path. Extract the encoded `path`
    query value before passing it to `fetch_audio`, which constructs the request URL itself.
    """
    if not isinstance(value, str) or not value:
        return None
    if "path=" in value:
        got = urllib.parse.parse_qs(urllib.parse.urlparse(value).query).get("path") or []
        if got and got[0]:
            return got[0]
    return value


def fetch_audio(url: str, remote_path: str, timeout: float = 120.0) -> bytes:
    """Pull one finished song's bytes over `/v1/audio`.

    Fetch through the API instead of reading backend-local output paths. The
    caller can then store the audio through the application's vault layer.
    """
    q = urllib.parse.urlencode({"path": remote_path})
    with urllib.request.urlopen(url.rstrip("/") + "/v1/audio?" + q, timeout=timeout) as r:
        return r.read()


#: device -> the model name an init is currently loading. A card row shows "loading X…" from
#: this, because `/health` cannot distinguish "no model yet" from "a 19 GB model is 40 seconds
#: into arriving", and those look identical to a user staring at a dropdown that did nothing.
_LOADING = {}
_LOADING_LOCK = threading.Lock()


def loading_model(device: str):
    with _LOADING_LOCK:
        return _LOADING.get(device)


#: The browser writes the card's model dropdown here, per device, through `/ui-state`
#: (`js/ace/cards.js`'s `rememberModel`). One key per card, and the same string the dropdown shows.
CHOSEN_MODEL_KEY = "vocalis-ace-model-"


def chosen_model(device: str) -> str:
    """Return the model last selected for this card, or `""`. A backend can be running without a loaded model, so currently loaded state alone does not identify what should load next. Read the persisted selection for an empty backend, but do not swap a model that is already loaded without an explicit user action."""
    if not device:
        return ""
    try:
        import ui_state
        from vocalis.runtime import paths
        return str((ui_state.load(paths.UI_STATE) or {}).get(CHOSEN_MODEL_KEY + device, "") or "")
    except (ImportError, OSError) as e:
        # Let vault authentication failures propagate; only storage/import errors
        # should degrade to an empty selection.
        logger.debug(f"acestep chosen_model {device}: {e}")
        return ""


def start_init(url: str, device: str, model: str, *, busy_check=None) -> dict:
    """Ask a backend to load `model`, in the background.

    The request runs in a background thread because model loading can take minutes.
    Each service is pinned to one device and loads one model in slot 1.
    """
    try:
        backend = _begin_model_change(device)
    except BackendUnavailable as exc:
        return {"ok": False, "error": str(exc)}
    try:
        if busy_check is not None and busy_check():
            _end_model_change(backend)
            return {"ok": False, "error": f"ACE-Step on {device} is busy with a render"}
    except Exception as exc:
        _end_model_change(backend)
        return {"ok": False, "error": f"could not confirm ACE-Step queue state: {exc}"}
    with _LOADING_LOCK:
        if device in _LOADING:
            _end_model_change(backend)
            return {"ok": False, "error": f"ACE-Step on {device} is already loading a model"}
        _LOADING[device] = model
    with backend.condition:
        backend.model_ready = False

    def _run():
        payload = json.dumps({"model": model, "slot": 1}).encode()
        req = urllib.request.Request(url.rstrip("/") + "/v1/init", data=payload,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
        try:
            # Generous: xl-sft is 19 GB off a spinning-rust-backed array on a cold cache.
            with urllib.request.urlopen(req, timeout=1800) as r:
                body = json.loads(r.read().decode("utf-8", "replace"))
            if isinstance(body, dict) and body.get("error"):
                with backend.condition:
                    backend.model_ready = False
                logger.error(f"acestep init {device} -> {model}: {body['error']}")
            else:
                with backend.condition:
                    backend.model_ready = True
                logger.info(f"acestep init {device} -> {model}: done")
        except Exception as e:      # noqa: BLE001 — a failed load must not wedge the row forever
            with backend.condition:
                backend.model_ready = False
            logger.error(f"acestep init {device} -> {model}: {e}")
        finally:
            with _LOADING_LOCK:
                _LOADING.pop(device, None)
            _end_model_change(backend)

    try:
        threading.Thread(target=_run, name=f"acestep-init-{device}", daemon=True).start()
    except RuntimeError as exc:
        with _LOADING_LOCK:
            _LOADING.pop(device, None)
        _end_model_change(backend)
        return {"ok": False, "error": f"could not start model initialization: {exc}"}
    return {"ok": True, "device": device, "model": model, "loading": True}
