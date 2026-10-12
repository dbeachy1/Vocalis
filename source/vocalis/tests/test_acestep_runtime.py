"""ACE local-child lifecycle and readiness contracts, using mocked child processes only."""
import subprocess

import pytest

from conftest import REPO_ROOT  # noqa: F401
from vocalis.runtime import acestep, paths


CHILDREN = [
    ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0"),
    ("acestep-api-gpu1", "http://127.0.0.1:7685", "cuda:1"),
]


@pytest.fixture
def clean_manager(monkeypatch):
    acestep._BACKENDS.clear()
    acestep._STOP_ALL.clear()
    monkeypatch.setattr(acestep, "configured", lambda _settings=None: CHILDREN)
    monkeypatch.setattr(acestep, "instances", lambda: CHILDREN)
    monkeypatch.setattr(acestep, "_report_exit", lambda *args, **kwargs: None)
    yield
    for backend in list(acestep._BACKENDS.values()):
        backend.process = None
        backend.transition = None
        backend.phase = "stopped"
    acestep._BACKENDS.clear()
    acestep._STOP_ALL.clear()


class Child:
    pid = 473_281

    def __init__(self, *, timed_out=False):
        self.returncode = None
        self.timed_out = timed_out

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.timed_out:
            raise subprocess.TimeoutExpired("acestep.api_server", timeout)
        self.returncode = 0
        return 0


def test_start_uses_pinned_local_api_without_loading_a_model(clean_manager, monkeypatch):
    calls = []
    child = Child()
    monkeypatch.setattr(acestep, "_runtime_inputs", lambda: (
        "/opt/venvs/acestep/bin/python", "/opt/acestep", "/models/vocalis/acestep"))
    monkeypatch.setenv("VOCALIS_ACESTEP_STAGE_DIR", "/work/vocalis/acestep")
    monkeypatch.setattr(acestep.subprocess, "Popen", lambda cmd, **kw: (
        calls.append((cmd, kw)), child)[1])

    result = acestep.start_instance(device="cuda:0")

    assert result["ok"] and result["state"] == "starting"
    command, options = calls[0]
    assert command == ["/opt/venvs/acestep/bin/python",
                       str(paths.CODE_DIR / "scripts" / "acestep" / "worker.py"),
                       "--host", "127.0.0.1", "--port", "7683", "--no-init"]
    assert options["cwd"] == "/opt/acestep"
    assert options["start_new_session"] is True
    assert options["env"]["CUDA_VISIBLE_DEVICES"] == "0"
    assert options["env"]["HIP_VISIBLE_DEVICES"] == "0"
    assert options["env"]["ACESTEP_LM_BACKEND"] == "pt"
    assert options["env"]["ACESTEP_MODEL_ROOT"] == "/models/vocalis/acestep"
    assert options["env"]["ACESTEP_CHECKPOINTS_DIR"] == "/models/vocalis/acestep"


def test_child_gets_the_standalone_services_memory_and_time_settings(monkeypatch):
    """October 11, 2026: without ACESTEP_ROCM_DTYPE the engine loads at 32-bit on an AMD card, twice
    the memory. On a 32 GB AMD card Extract, Replace and Complete then ran out of memory."""
    monkeypatch.delenv("ACESTEP_ROCM_DTYPE", raising=False)
    monkeypatch.delenv("ACESTEP_GENERATION_TIMEOUT", raising=False)
    env = acestep._child_environment("cuda:0", 0, "/models/vocalis/acestep")
    assert env["ACESTEP_ROCM_DTYPE"] == "bfloat16"
    assert env["ACESTEP_GENERATION_TIMEOUT"] == "3600"

    # A value set on the container still wins.
    monkeypatch.setenv("ACESTEP_ROCM_DTYPE", "float32")
    monkeypatch.setenv("ACESTEP_GENERATION_TIMEOUT", "900")
    env = acestep._child_environment("cuda:0", 0, "/models/vocalis/acestep")
    assert env["ACESTEP_ROCM_DTYPE"] == "float32"
    assert env["ACESTEP_GENERATION_TIMEOUT"] == "900"


def test_refused_request_reports_the_engines_reason(monkeypatch):
    """October 11, 2026: a LoRA path the engine refused reached the page as "HTTP Error 400: Bad
    Request". The engine's sentence is in the body of that answer."""
    import io
    import urllib.error

    def refuse(body):
        def urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 400, "Bad Request", {}, io.BytesIO(body))
        return urlopen

    monkeypatch.setattr(acestep.urllib.request, "urlopen",
                        refuse(b'{"detail": "LoRA path not found: /models/x"}'))
    with pytest.raises(RuntimeError, match="LoRA path not found: /models/x"):
        acestep._post_wrapped("http://127.0.0.1:7683", "/v1/lora/load", {"lora_path": "/models/x"}, 5)

    # No usable body: the plain HTTP error is kept rather than replaced by an empty sentence.
    for body in (b"", b"not json", b'{"detail": [{"loc": ["body"]}]}'):
        monkeypatch.setattr(acestep.urllib.request, "urlopen", refuse(body))
        with pytest.raises(urllib.error.HTTPError):
            acestep._post_wrapped("http://127.0.0.1:7683", "/v1/lora/load", {}, 5)


def test_render_requires_http_and_model_readiness(clean_manager, monkeypatch):
    child = Child()
    monkeypatch.setattr(acestep, "_runtime_inputs", lambda: (
        "/opt/python", "/opt/acestep", "/models/vocalis/acestep"))
    monkeypatch.setattr(acestep.subprocess, "Popen", lambda *args, **kwargs: child)
    assert acestep.start_instance(device="cuda:0")["ok"]
    assert not acestep.can_dispatch("cuda:0")

    acestep.mark_http_ready("http://127.0.0.1:7683")
    acestep.mark_model_ready("http://127.0.0.1:7683", False)
    assert not acestep.can_dispatch("cuda:0")
    acestep.mark_model_ready("http://127.0.0.1:7683", True)

    with acestep.submission_slot("cuda:0") as generation:
        assert generation == 1
        assert not acestep.can_dispatch("cuda:1")


# The ACE runtime only runs in the Linux container; its SIGKILL escalation has no Windows signal.
@pytest.mark.skipif(not hasattr(__import__("signal"), "SIGKILL"), reason="POSIX-only kill escalation")
def test_uncertain_stop_retains_child_and_prevents_replacement(clean_manager, monkeypatch):
    child = Child(timed_out=True)
    starts = []
    monkeypatch.setattr(acestep, "_runtime_inputs", lambda: (
        "/opt/python", "/opt/acestep", "/models/vocalis/acestep"))
    monkeypatch.setattr(acestep.subprocess, "Popen", lambda *args, **kwargs: (
        starts.append(args[0]), child)[1])
    monkeypatch.setattr(acestep, "_signal_owned_group", lambda *args: None)
    monkeypatch.setattr(acestep, "_owned_group_exists", lambda process: True)

    assert acestep.start_instance(device="cuda:0")["ok"]
    result = acestep.stop_instance(device="cuda:0")
    retry = acestep.start_instance(device="cuda:0")

    assert result["ok"] is False and result["state"] == "stopping"
    assert retry["ok"] is False and retry["state"] == "stopping"
    assert len(starts) == 1
    assert acestep.process_state("cuda:0")["state"] == "stopping"


def test_missing_runtime_paths_fail_before_child_creation(clean_manager, monkeypatch):
    for name in ("VOCALIS_ACESTEP_PYTHON", "VOCALIS_ACESTEP_SOURCE",
                 "VOCALIS_ACESTEP_MODEL_DIR"):
        monkeypatch.delenv(name, raising=False)
    called = []
    monkeypatch.setattr(acestep.subprocess, "Popen", lambda *args, **kwargs: called.append(args))

    result = acestep.start_instance(device="cuda:0")

    assert result["ok"] is False and result["state"] == "failed"
    assert "paths are not configured" in result["error"]
    assert called == []


def test_a_stop_signal_stops_the_children_then_exits_at_once_without_pythons_shutdown(clean_manager, monkeypatch):
    """`docker stop` with a render in progress used to end as a kill (exit 137): the handler raised SystemExit and
    Python's normal shutdown aborted in the C++ runtime. The handler now stops the owned children, says so in the
    log, and ends the process itself with the stop signal's usual exit code."""
    import signal

    order = []
    monkeypatch.setattr(acestep, "_shutdown_owned", lambda: order.append("children stopped"))
    monkeypatch.setattr(acestep, "_PREVIOUS_SIGTERM", signal.SIG_DFL)
    lines, written_at_exit = [], []
    # A queued sink, as the server's real ones are (enqueue=True in tts_utils): the line must be written BEFORE the
    # exit, which a plain logger.info followed by os._exit did not achieve (lost six times out of six).
    sink = acestep.logger.add(lambda message: lines.append(str(message)), level="INFO", format="{message}",
                              enqueue=True)

    def fake_exit(code):
        written_at_exit.extend(lines)
        order.append(("exit", code))

    try:
        acestep._terminate_owned_children(signal.SIGTERM, None, _exit=fake_exit)
    finally:
        acestep.logger.remove(sink)

    assert order == ["children stopped", ("exit", 143)], "children first, then an immediate exit with 128 + SIGTERM"
    assert any("stop requested" in line and "exiting" in line for line in written_at_exit), (
        "the stop's log line is written before the process ends")


def test_a_log_that_cannot_be_written_does_not_hold_up_the_stop(clean_manager, monkeypatch):
    """If the stop signal lands while the main thread is inside a log call, logging again would wait on that call's
    lock. The last line is written from a helper thread with a bounded wait, so the exit still happens."""
    import signal
    import threading
    import time

    monkeypatch.setattr(acestep, "_shutdown_owned", lambda: None)
    monkeypatch.setattr(acestep, "_PREVIOUS_SIGTERM", signal.SIG_DFL)
    release = threading.Event()
    monkeypatch.setattr(acestep.logger, "info", lambda _text: release.wait(30))   # a log call that never returns
    exits = []
    started = time.monotonic()
    try:
        acestep._write_last_log_line("never written", wait_s=0.2)
        acestep._terminate_owned_children(signal.SIGTERM, None, _exit=exits.append)
    finally:
        release.set()
    assert exits == [143]
    assert time.monotonic() - started < 10, "the stop waited on the log instead of going ahead"


def test_a_stop_signal_still_defers_to_a_handler_that_was_installed_before(clean_manager, monkeypatch):
    import signal

    order = []
    monkeypatch.setattr(acestep, "_shutdown_owned", lambda: order.append("children stopped"))
    monkeypatch.setattr(acestep, "_PREVIOUS_SIGTERM", lambda signum, frame: order.append(("previous", signum)))

    acestep._terminate_owned_children(signal.SIGTERM, None, _exit=lambda code: order.append(("exit", code)))

    assert order == ["children stopped", ("previous", signal.SIGTERM)]
