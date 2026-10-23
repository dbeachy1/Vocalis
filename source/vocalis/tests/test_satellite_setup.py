"""Provisioning a satellite: the shared secret and the TLS keypair.

Guards one real outage and one that was waiting to happen. Both present identically — the
satellite refuses to start with a message telling you to run the very script you just ran — so
neither is diagnosable from the symptom.

* **`setup.bat` must actually invoke `setup.py`.** Otherwise it can install the venv, verify CUDA,
  and pass the self-test without provisioning the secret or certificate required by `run.bat`.
* **Both sides must resolve the satellite's name the same way.** `server.py` looks up the secret
  under the name from `satellite.yaml`; if `setup.py` stores it under a different name, startup
  cannot find the credential.

Design: DESIGN_5_3_SATELLITES §11.2, §11.3.
"""
import contextlib
import importlib.util
import re
import socket
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT

SAT = REPO_ROOT / "satellite"
sys.path.insert(0, str(SAT))


def _load_setup():
    """satellite/setup.py, under a name that cannot collide with a packaging `setup`.

    ⚠️ Executing the module body has two side effects on the interpreter, and eight tests call
    this. Neither may outlive the call: it inserts `satellite/` into `sys.path` (measured: seven
    copies by the end of the module), and it reconfigures the REAL `sys.stdout` to
    `errors="replace"` — which would quietly turn an unrelated test's UnicodeEncodeError into a
    `?`, i.e. mask the exact defect this file exists to guard.
    """
    path_before = list(sys.path)
    errors_before = getattr(sys.stdout, "errors", None)
    spec = importlib.util.spec_from_file_location("satellite_setup", SAT / "setup.py")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path[:] = path_before
        if errors_before is not None and getattr(sys.stdout, "errors", None) != errors_before:
            with contextlib.suppress(Exception):        # pytest's capture may not reconfigure
                sys.stdout.reconfigure(errors=errors_before)
    return mod


def _fake_host(monkeypatch, setup, host="BOX", fqdn="box.example.test", addrs=None):
    """Pin every name lookup `_san_names` makes.

    The hostname, FQDN, and address list are injected so assertions cannot pass or fail based on
    the machine running the suite. The v6 address is included explicitly to exercise filtering.
    """
    addrs = [('192.0.2.182', False), ("fe80::1cb3:4d21:9f0a:2e7c", True)] if addrs is None \
        else addrs
    infos = [(socket.AF_INET6 if v6 else socket.AF_INET, socket.SOCK_STREAM, 6, "",
              ((a, 0, 0, 0) if v6 else (a, 0))) for a, v6 in addrs]
    monkeypatch.setattr(setup.socket, "gethostname", lambda: host)
    monkeypatch.setattr(setup.socket, "getfqdn", lambda *a: fqdn)
    monkeypatch.setattr(setup.socket, "getaddrinfo", lambda *a, **k: infos)


# ── setup.bat is a wrapper, and must wrap ────────────────────────────────────

def test_setup_bat_invokes_setup_py():
    """🔴 The one that fired. §11.3 promises setup.bat prompts for the secret and generates the
    certificate; it does neither itself, so if it does not call setup.py, nobody does."""
    bat = (SAT / "setup.bat").read_text(encoding="utf-8", errors="replace")
    assert re.search(r'"%PYTHON%"\s+"%HERE%setup\.py"', bat), (
        "satellite/setup.bat does not run setup.py — the venv installs, the self-test passes, "
        "and run.bat then dies for want of a shared secret.")


def test_setup_bat_provisions_before_the_selftest():
    """Ordering, not correctness: the paste takes seconds, the self-test's first run downloads
    3 GB of weights. Human first, then walk away.

    ⚠️ Match the INVOCATION, not the string. `bat.index("setup.py")` found offset 347 — the
    header comment "Arguments are passed straight through to setup.py" — while the real call is
    at 5407 and the self-test at 5887. Move the provisioning block after the self-test and the
    naive assertion still passed: it was comparing a comment against a command.
    """
    bat = (SAT / "setup.bat").read_text(encoding="utf-8", errors="replace")
    assert bat.index('"%HERE%setup.py"') < bat.index('"%HERE%selftest.py"')


def test_setup_bat_passes_its_arguments_through():
    """`setup.bat --name test-satellite --san test-satellite.lan` has to reach setup.py's argparse, or a
    non-default name can only be provisioned by hand."""
    bat = (SAT / "setup.bat").read_text(encoding="utf-8", errors="replace")
    assert re.search(r'"%HERE%setup\.py"\s+%\*', bat), (
        "setup.bat swallows its arguments — --name and --san never reach setup.py.")


# ── the name the secret is filed under ───────────────────────────────────────

def test_setup_and_server_read_the_same_config_file():
    setup = _load_setup()
    import server
    assert setup.CONFIG_FILE == server.CONFIG_FILE == setup.satpaths.CONFIG_FILE


def test_setup_and_server_share_the_fallback_name():
    """With no satellite.yaml both must land on 'satellite'. The keyring lookup is by name, so a
    disagreement is an empty credential store and a misleading error."""
    setup = _load_setup()
    if not setup.CONFIG_FILE.exists():          # a local satellite.yaml legitimately overrides
        assert setup.default_name() == "satellite", (
            "setup.py's default name changed — server.py's argparse default must change too.")
    import server
    assert server.load_config().get("name", "satellite") == setup.default_name()


def test_explicit_config_path_fails_closed_when_missing_or_not_a_mapping(tmp_path, monkeypatch):
    setup = _load_setup()
    import server

    config = tmp_path / "satellite.yaml"
    monkeypatch.setenv("VOCALIS_SATELLITE_CONFIG", str(config))
    monkeypatch.setattr(setup, "CONFIG_FILE", config)
    monkeypatch.setattr(server, "CONFIG_FILE", config)
    with pytest.raises(RuntimeError, match="file is missing"):
        server.load_config()
    with pytest.raises(RuntimeError, match="file is missing"):
        setup._config()

    config.write_text("[]\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="YAML mapping"):
        server.load_config()
    with pytest.raises(RuntimeError, match="YAML mapping"):
        setup._config()


def test_secret_file_precedes_environment_without_importing_keyring(tmp_path, monkeypatch):
    import builtins
    import server

    secret = b"\xa5" * server.proto.MASTER_BYTES
    path = tmp_path / "satellite-secret"
    path.write_text(secret.hex() + "\n", encoding="ascii")
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET_FILE", str(path))
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET", "not-a-valid-fallback")
    original_import = builtins.__import__

    def no_keyring(name, *args, **kwargs):
        if name == "keyring":
            raise AssertionError("the mounted secret must not fall through to keyring")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_keyring)
    assert server.load_master("test-satellite") == secret


@pytest.mark.parametrize("file_value", [None, "", "not-hex"])
def test_explicit_secret_file_errors_fail_closed_without_fallback(
        tmp_path, monkeypatch, file_value):
    import builtins
    import server

    path = tmp_path / "secret"
    if file_value is not None:
        path.write_text(file_value, encoding="ascii")
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET_FILE", str(path))
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET", "ab" * server.proto.MASTER_BYTES)
    original_import = builtins.__import__

    def no_keyring(name, *args, **kwargs):
        if name == "keyring":
            raise AssertionError("an explicit secret-file error must not fall back")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_keyring)
    with pytest.raises(SystemExit) as exc:
        server.load_master("test-satellite")
    assert "VOCALIS_SATELLITE_SECRET_FILE" in str(exc.value)
    assert "ab" * server.proto.MASTER_BYTES not in str(exc.value)


def test_blank_secret_file_path_fails_without_fallback(monkeypatch):
    import server

    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET_FILE", "  ")
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET", "ab" * server.proto.MASTER_BYTES)
    with pytest.raises(SystemExit, match="set but empty"):
        server.load_master("test-satellite")


def test_secret_environment_precedes_keyring(monkeypatch):
    import builtins
    import server

    secret = b"\x3c" * server.proto.MASTER_BYTES
    monkeypatch.delenv("VOCALIS_SATELLITE_SECRET_FILE", raising=False)
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET", secret.hex())
    original_import = builtins.__import__

    def no_keyring(name, *args, **kwargs):
        if name == "keyring":
            raise AssertionError("a valid environment secret must not import keyring")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_keyring)
    assert server.load_master("test-satellite") == secret


@pytest.mark.parametrize("raw_value", ["not-hex", "  "])
def test_invalid_nonempty_secret_environment_fails_without_keyring(monkeypatch, raw_value):
    import builtins
    import server

    monkeypatch.delenv("VOCALIS_SATELLITE_SECRET_FILE", raising=False)
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET", raw_value)
    original_import = builtins.__import__

    def no_keyring(name, *args, **kwargs):
        if name == "keyring":
            raise AssertionError("an invalid environment secret must not fall back")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_keyring)
    with pytest.raises(SystemExit, match="VOCALIS_SATELLITE_SECRET"):
        server.load_master("test-satellite")


def test_empty_secret_environment_uses_the_keyring_fallback(monkeypatch):
    import server

    secret = b"\x91" * server.proto.MASTER_BYTES
    monkeypatch.delenv("VOCALIS_SATELLITE_SECRET_FILE", raising=False)
    monkeypatch.setenv("VOCALIS_SATELLITE_SECRET", "")
    import types
    fake_keyring = types.SimpleNamespace(get_password=lambda service, name: secret.hex())
    monkeypatch.setitem(sys.modules, "keyring", fake_keyring)
    assert server.load_master("test-satellite") == secret


def test_keyring_remains_the_legacy_fallback(monkeypatch):
    import server

    secret = b"\x6d" * server.proto.MASTER_BYTES
    monkeypatch.delenv("VOCALIS_SATELLITE_SECRET_FILE", raising=False)
    monkeypatch.delenv("VOCALIS_SATELLITE_SECRET", raising=False)
    import types
    fake_keyring = types.SimpleNamespace(
        get_password=lambda service, name: secret.hex()
        if (service, name) == (server.KEYRING_SERVICE, "test-satellite") else None)
    monkeypatch.setitem(sys.modules, "keyring", fake_keyring)
    assert server.load_master("test-satellite") == secret


# ── the certificate has to name this box the way the OTHER box knows it ──────

def test_the_san_includes_the_real_fqdn(monkeypatch):
    """The mocked FQDN must be included alongside the short hostname and its `.lan` form so a
    certificate covers every name callers may resolve."""
    setup = _load_setup()
    _fake_host(monkeypatch, setup)
    names, _ips = setup._san_names([])
    assert "box.example.test" in names, (
        f"the certificate would not cover the FQDN other machines resolve: {names}")
    assert "box.lan" in names, "the .lan guess costs nothing and is deliberately kept"


def test_the_san_carries_no_ipv6(monkeypatch):
    """server.py binds 0.0.0.0, an IPv4 socket. A v6 SAN would certify an endpoint that never
    answers, and on Windows the candidates are a link-local address and a privacy-extension
    temporary one that rotates out from under a 10-year cert.

    The v6 address is INJECTED. Read from the real box on a v4-only LAN there is nothing to
    exclude, so this asserted precisely nothing.
    """
    setup = _load_setup()
    _fake_host(monkeypatch, setup)
    _names, ips = setup._san_names([])
    assert ips == ["127.0.0.1", '192.0.2.182'], ips
    assert all(":" not in ip for ip in ips), ips


def test_extra_sans_are_still_honored():
    setup = _load_setup()
    names, ips = setup._san_names(["vocalis.example", "192.0.2.9"])
    assert "vocalis.example" in names and "192.0.2.9" in ips


def test_print_urls_leads_with_the_ip_literal(tmp_path, capsys, monkeypatch):
    """The name form resolves to IPv6 first on a dual-stack LAN and the satellite is IPv4-only,
    so the literal is the one that connects without a wasted attempt.

    Host lookups are faked: on a box with no routable IPv4 the SAN is names-only and this used
    to fail red for a reason that has nothing to do with the code.
    """
    setup = _load_setup()
    _fake_host(monkeypatch, setup)
    monkeypatch.setattr(setup, "CERTS", tmp_path)
    setup.make_cert([])
    capsys.readouterr()
    setup.print_urls(7880)
    lines = [ln.strip() for ln in capsys.readouterr().out.splitlines()
             if ln.strip().startswith("https://")]
    assert lines, "print_urls offered nothing to paste into Vocalis"
    assert lines[0].startswith("https://192.0.2.") or lines[0].split("//")[1][0].isdigit(), lines
    assert all(":7880" in ln for ln in lines)
    assert not any("localhost" in ln or "127.0.0.1" in ln for ln in lines), (
        "loopback is useless to the machine running Vocalis and must not be offered")


def test_default_port_matches_the_servers():
    setup = _load_setup()
    server_src = (SAT / "server.py").read_text(encoding="utf-8", errors="replace")
    if not setup.CONFIG_FILE.exists():
        assert setup.default_port() == 7880
    assert 'cfg.get("port", 7880)' in server_src


def test_the_output_survives_a_narrow_codepage(tmp_path, monkeypatch, capsys):
    """When stdout is redirected, Python encodes with the selected code page; an unsupported
    character can raise after the key and certificate are written but before the upload URL prints.

    cp437 is the strict case: it cannot encode an em dash either, so this covers every
    non-ASCII character in the file, not just the ones that were there when it was written.
    """
    import io
    setup = _load_setup()
    monkeypatch.setattr(setup, "CERTS", tmp_path)
    buf = io.TextIOWrapper(io.BytesIO(), encoding="cp437", errors="strict", newline="")
    with contextlib.redirect_stdout(buf):
        setup.make_cert([])
        setup.print_urls(7880)
        buf.flush()


# ── the console the operator actually watches ────────────────────────────────

def _record(msg, level=20):
    import logging
    return logging.LogRecord("werkzeug", level, __file__, 1, msg, None, None)


def test_the_dev_server_banner_is_dropped():
    """Werkzeug emits the development warning and its `Running on` lines as one record. Drop that
    banner while retaining request logs; `main()` reports the listening address separately."""
    import server
    h = server._WerkzeugToLoguru()
    banner = ("\x1b[1m\x1b[31mWARNING: This is a development server. Do not use it in a "
              "production deployment. Use a production WSGI server instead.\x1b[0m\n"
              " * Running on https://127.0.0.1:7880")
    sent = []
    import loguru
    with_patch = loguru.logger.log
    try:
        loguru.logger.log = lambda lvl, m: sent.append((lvl, m))
        h.emit(_record(banner))
        assert sent == [], f"the banner still reaches the console: {sent}"
        h.emit(_record('192.0.2.182 - - [28/Jul/2026 17:51:04] "POST /satellite/load" 200 -'))
        assert len(sent) == 1 and "POST /satellite/load" in sent[0][1], (
            "a real request line must still be logged — this filter drops the banner, not the log")
    finally:
        loguru.logger.log = with_patch


# The record Werkzeug wrote on the final 12.0.0 satellite image on October 11, 2026 (file paths shortened), when
# Vocalis closed a connection while the satellite was writing to it. The traceback is text in the message.
_CLIENT_GONE_RECORD = """Error on request:
Traceback (most recent call last):
  File "/opt/venv/chatterbox/lib/python3.12/site-packages/werkzeug/serving.py", line 338, in execute
    write(data)
  File "/opt/python/3.12.15/lib/python3.12/ssl.py", line 1204, in send
    return self._sslobj.write(data)
           ^^^^^^^^^^^^^^^^^^^^^^^^
BrokenPipeError: [Errno 32] Broken pipe

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/opt/venv/chatterbox/lib/python3.12/site-packages/werkzeug/serving.py", line 374, in run_wsgi
    execute(self.server.app)
  File "/opt/venv/chatterbox/lib/python3.12/site-packages/werkzeug/serving.py", line 359, in execute
    data = self.rfile.read(10_000_000)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/opt/python/3.12.15/lib/python3.12/ssl.py", line 1128, in read
    return self._sslobj.read(len, buffer)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ssl.SSLError: [SSL: UNEXPECTED_EOF_WHILE_READING] unexpected eof while reading (_ssl.c:2580)
"""


def test_a_client_that_hangs_up_is_one_debug_line_not_an_error_traceback():
    """A client closing its connection mid-response is not a satellite error. Over TLS Werkzeug logged it as ERROR
    with a 30-line traceback, three times in two minutes of normal use, and `vocalis-satellite status` printed the
    tail of one. It becomes one debug line; every real error still goes out at error level."""
    import logging
    import loguru
    import server
    h = server._WerkzeugToLoguru()
    logged, debugged = [], []
    keep_log, keep_debug = loguru.logger.log, loguru.logger.debug
    try:
        loguru.logger.log = lambda lvl, m: logged.append((lvl, m))
        loguru.logger.debug = lambda m: debugged.append(m)

        h.emit(_record(_CLIENT_GONE_RECORD, logging.ERROR))
        h.emit(_record("Error on request:\nConnectionResetError: [Errno 104] Connection reset by peer", logging.ERROR))
        h.emit(_record("Error on request:\nssl.SSLEOFError: EOF occurred in violation of protocol", logging.ERROR))
        assert logged == [], f"a client hanging up still reaches the log as an error: {logged}"
        assert len(debugged) == 3 and all("closed its connection" in m for m in debugged)
        assert "Traceback" not in "".join(debugged), "the debug line is one line, not the traceback"

        # A failure that is the satellite's own still shouts, traceback and all.
        for real in ("Error on request:\nssl.SSLError: [SSL: CERTIFICATE_VERIFY_FAILED] bad certificate",
                     "Error on request:\nssl.SSLError: [SSL: WRONG_VERSION_NUMBER] wrong version number",
                     "Error on request:\nRuntimeError: something actually broke",
                     # a dropped connection mentioned outside a request error is not Werkzeug's noise
                     "BrokenPipeError while writing the reply"):
            logged.clear()
            h.emit(_record(real, logging.ERROR))
            assert logged == [("ERROR", real)], f"a real error was changed or lost: {real!r} -> {logged}"
        assert len(debugged) == 3
    finally:
        loguru.logger.log, loguru.logger.debug = keep_log, keep_debug


def test_satellite_and_main_server_agree_on_what_a_client_hang_up_looks_like():
    """The satellite cannot import the main server, so each holds its own copy of the two lists (what a client
    hang-up looks like in a Werkzeug record, and which TLS failures are never swallowed). They must stay equal."""
    import ast
    import server
    tree = ast.parse((REPO_ROOT / "src" / "vocalis_server.py").read_text(encoding="utf-8"))
    cls = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == "_DropClientDisconnects")
    main = {t.id: ast.literal_eval(n.value) for n in cls.body if isinstance(n, ast.Assign)
            for t in n.targets if isinstance(t, ast.Name) and t.id in ("_TEXT", "_KEEP")}
    assert server._WerkzeugToLoguru._CLIENT_GONE == main["_TEXT"]
    assert server._WerkzeugToLoguru._TLS_OURS == main["_KEEP"]


_START_LINE = "Vocalis satellite 2.1.2 starting: loading the speech libraries, which takes a few seconds"


def _satellite_source():
    return (REPO_ROOT / "satellite" / "server.py").read_text(encoding="utf-8")


def test_the_satellite_stops_at_once_when_asked_and_always_says_so_first(tmp_path):
    """The satellite is the first process of its container, and Linux delivers a stop signal to that process only if
    it handles it. It did not: every `docker stop` (the tray icon's Stop, `vocalis-satellite stop`) waited out
    Docker's 10 seconds and ended as a kill. It now handles the signal, always in this order: the "exiting" line, a
    line of sixty equal signs (the break before the next start), then an immediate exit 0. The two lines are written
    by hand, not through the logging library, so they are written even when the signal lands inside a log call."""
    import io
    import signal
    import time
    import server

    source = _satellite_source()
    install = source.index("    signal.signal(signal.SIGTERM, _stop_on_sigterm)")
    assert source.count("signal.signal(signal.SIGTERM, _stop_on_sigterm)") == 1
    assert source.rindex('if __name__ == "__main__":', 0, install) > 0, "only when run as the satellite, never on import"
    assert install < source.index("import torch"), (
        "installed before the slow imports: a stop during start-up must be obeyed too, not ignored for ten seconds")

    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "satellite.log").write_text("2026-10-11 17:36:42 | INFO    | listening on https://0.0.0.0:7880\n", encoding="utf-8")
    when = time.struct_time((2026, 10, 11, 17, 40, 0, 6, 284, 0))
    order = []
    console = io.StringIO()

    def fake_exit(code):
        order.append(("exit", code, (logs / "satellite.log").read_text(encoding="utf-8").splitlines()))

    server._stop_on_sigterm(signal.SIGTERM, None, _exit=fake_exit, log_dir=logs, now=when, console=console)

    assert len(order) == 1 and order[0][:2] == ("exit", 0)
    assert order[0][2] == ["2026-10-11 17:36:42 | INFO    | listening on https://0.0.0.0:7880",
                           "2026-10-11 17:40:00 | INFO    | stop requested: the satellite is exiting",
                           "2026-10-11 17:40:00 | INFO    | " + "=" * 60], "both lines are in the file BEFORE the exit"
    assert console.getvalue().splitlines() == ["17:40:00 | INFO    | stop requested: the satellite is exiting",
                                               "17:40:00 | INFO    | " + "=" * 60]

    # No log folder, a broken console: the stop still goes ahead.
    class Broken:
        def write(self, _text):
            raise ValueError("I/O operation on closed file")

        def flush(self):
            raise ValueError("I/O operation on closed file")

    exits = []
    server._stop_on_sigterm(signal.SIGTERM, None, _exit=exits.append, log_dir=tmp_path / "absent", console=Broken())
    assert exits == [0] and not (tmp_path / "absent").exists()


def test_a_start_is_in_the_log_at_once_with_the_version_and_every_run_is_set_off_by_one_break_line(tmp_path):
    """Loading the speech libraries takes seconds and the log is configured only after that, so a start showed
    nothing at first. The first line, with the version, is now written by hand before anything slow, in the log's own
    line format; main() then logs the full line with the satellite's name as its own first line. Runs are separated by
    one line of sixty equal signs: written by a stop that was asked for, or at the next start when the previous run
    ended without one (a crash or a kill), never twice."""
    import io
    import time
    import server

    source = _satellite_source()
    announce = source.index("    _announce_start(_STOP_LOG_DIR)")
    assert source.rindex('if __name__ == "__main__":', 0, announce) > 0, "only when run as the satellite, never on import"
    assert announce < source.index("import torch"), "before the slow imports, or it is not immediate"
    main = source[source.index("def main():"):]
    identity = main.index("logger.info(f\"Vocalis satellite {SATELLITE_VERSION} '{_NAME}' \"")
    assert main.index("_setup_logging(cfg)") < identity, "the log must be configured first"
    assert main.count("logger.info(f\"Vocalis satellite {SATELLITE_VERSION}") == 1
    for later in ("_log_gpu_visibility(_gpu_visibility)", "settle_whole_card_source()", "gpustats.start_background()", "listening on"):
        assert identity < main.index(later), f"the satellite's own line comes before {later!r}"
    assert f'SATELLITE_VERSION = "{server.SATELLITE_VERSION}"' in source and server.SATELLITE_VERSION in _START_LINE

    logs = tmp_path / "logs"
    logs.mkdir()
    log = logs / "satellite.log"
    when = time.struct_time((2026, 10, 11, 17, 36, 30, 6, 284, 0))
    start = "2026-10-11 17:36:30 | INFO    | " + _START_LINE
    brk = "2026-10-11 17:36:30 | INFO    | " + "=" * 60

    console = io.StringIO()
    server._announce_start(logs, now=when, console=console)                       # a first start: no earlier run
    assert log.read_text(encoding="utf-8").splitlines() == [start]
    assert console.getvalue() == "17:36:30 | INFO    | " + _START_LINE + "\n", "the console gets the line, never the break"

    with open(log, "a", encoding="utf-8") as handle:                             # that run is killed: no break line
        handle.write("2026-10-11 17:36:35 | INFO    | listening on https://0.0.0.0:7880\n")
    console = io.StringIO()
    server._announce_start(logs, now=when, console=console)
    assert log.read_text(encoding="utf-8").splitlines()[-2:] == [brk, start]
    assert console.getvalue() == "17:36:30 | INFO    | " + _START_LINE + "\n"

    with open(log, "a", encoding="utf-8") as handle:                             # this one is stopped properly
        handle.write("2026-10-11 17:40:00 | INFO    | stop requested: the satellite is exiting\n")
        handle.write("2026-10-11 17:40:00 | INFO    | " + "=" * 60 + "\n")
    before = log.read_text(encoding="utf-8").splitlines()
    server._announce_start(logs, now=when, console=io.StringIO())
    assert log.read_text(encoding="utf-8").splitlines() == before + [start], "no second break after a clean stop"

    # A missing log folder is not created and does not stop the start; main() reports it in its own words.
    server._announce_start(tmp_path / "absent", now=when, console=io.StringIO())
    assert not (tmp_path / "absent").exists()


def test_the_last_start_up_line_does_not_tell_a_container_to_close_a_window():
    """Started by run.bat the satellite has a console window and "close this window to stop" is right. In a container
    there is no window; the line names the ways it really is stopped."""
    import server

    native = server._how_to_stop_line(False)
    container = server._how_to_stop_line(True)
    assert native.startswith("close this window to stop")
    assert "window" not in container
    for way in ("Stop in the tray icon's menu", "`vocalis-satellite stop`", "`docker stop`"):
        assert way in container
    main = _satellite_source()[_satellite_source().index("def main():"):]
    assert 'logger.info(_how_to_stop_line(satpaths.configured("VOCALIS_SATELLITE_LOG_DIR")))' in main


def test_werkzeug_logs_once_not_twice():
    """The doubled `INFO:werkzeug:…` beside every request came from logging's last-resort
    handler, because nothing had ever configured this logger. One handler, no propagation.

    🔴 RESTORED afterward. `logging.getLogger("werkzeug")` is process-global, so without the
    teardown this test permanently rewired it for the rest of the pytest session — and
    `test_devices_browser.py` starts a REAL werkzeug server, whose request log then went into
    loguru with successful health polls silently dropped. Same class as the `sys.modules`
    `setdefault` leak 5.3 was already burned by.
    """
    import logging
    import server
    wl = logging.getLogger("werkzeug")
    before_handlers, before_propagate = list(wl.handlers), wl.propagate
    # 🔴 THE LEVEL LEAKED, AND IT LEAKED INTO A SECURITY ASSERTION. `_quiet_werkzeug` also does
    # `setLevel(logging.INFO)`, which this teardown did not put back — so for the rest of the
    # worker's session werkzeug sat at INFO, and
    # `test_auth_surface.py::test_the_access_log_is_pinned_at_ERROR_because_a_bearer_rides_in_a_url`
    # went red whenever xdist happened to schedule the two into the same process. That test is the
    # only thing standing between `/pair/stream`'s query-string bearer and the access log on disk,
    # so a flake there is not noise: it is a real check that intermittently reports a breach it
    # cannot see, and a green run that happens to schedule them apart proves nothing.
    #
    # ⚠️ Restored to what it WAS, not to ERROR — this file must not be the thing that asserts the
    # production pin, or the two tests would agree with each other rather than with the server.
    before_level = wl.level
    try:
        server._quiet_werkzeug()      # NOT _setup_logging: that calls loguru's global
        assert len(wl.handlers) == 1  # logger.remove(), which would unhook the whole session
        assert isinstance(wl.handlers[0], server._WerkzeugToLoguru)
        assert wl.propagate is False
    finally:
        wl.handlers[:] = before_handlers
        wl.propagate = before_propagate
        wl.setLevel(before_level)


def test_a_half_missing_keypair_still_asks_before_replacing(tmp_path, monkeypatch, capsys):
    """If either half of an existing keypair is missing, prompt before generating replacement
    files so a one-sided pair is not silently overwritten."""
    setup = _load_setup()
    _fake_host(monkeypatch, setup)
    monkeypatch.setattr(setup, "CERTS", tmp_path)
    setup.make_cert([])
    original = (tmp_path / "cert.pem").read_bytes()
    (tmp_path / "key.pem").unlink()                     # the half-missing pair
    capsys.readouterr()

    monkeypatch.setattr("builtins.input", lambda *a: "n")
    assert setup.make_cert([]) is False
    assert (tmp_path / "cert.pem").read_bytes() == original, (
        "declining the prompt still replaced the certificate")
    out = capsys.readouterr().out
    assert "key.pem is missing" in out, out


def test_setup_records_the_name_the_server_will_ask_for(tmp_path, monkeypatch, capsys):
    """Persist the configured satellite name so the server can retrieve the secret by the same
    name on startup."""
    import yaml
    setup = _load_setup()
    cfg = tmp_path / "satellite.yaml"
    monkeypatch.setattr(setup, "CONFIG_FILE", cfg)

    assert setup.save_name('test-satellite') is True
    assert yaml.safe_load(cfg.read_text(encoding="utf-8"))["name"] == 'test-satellite'
    assert setup.default_name() == 'test-satellite', "setup and server must agree on the name"
    assert setup.save_name('test-satellite') is False, "no rewrite when it already agrees"

    server_src = (SAT / "server.py").read_text(encoding="utf-8", errors="replace")
    assert 'cfg.get("name", "satellite")' in server_src, (
        "server.py stopped reading the name from satellite.yaml — save_name writes it there")


def test_no_non_ascii_can_reach_the_console(monkeypatch):
    """🔴 Source-level, because the by-hand version missed one for a week.

    `test_the_output_survives_a_narrow_codepage` pipes two functions through cp437; an em dash
    in argparse's `--name` help string sat outside both and survived. Every string LITERAL in
    setup.py is checked here instead — docstrings and comments are exempt, since neither is
    printed. cp437 is the strict case: it cannot encode an em dash or a box-drawing character.
    """
    import ast
    src = (SAT / "setup.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    docstrings = {id(d) for d in ast.walk(tree)
                  if isinstance(d, (ast.Module, ast.FunctionDef, ast.ClassDef))
                  and (d.body and isinstance(d.body[0], ast.Expr)
                       and isinstance(d.body[0].value, ast.Constant))
                  for d in [d.body[0].value]}
    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) \
                and id(node) not in docstrings:
            try:
                node.value.encode("cp437")
            except UnicodeEncodeError:
                bad.append((node.lineno, node.value[:60]))
    assert not bad, (f"setup.py has non-ASCII in a string that can be printed — it raises "
                     f"UnicodeEncodeError the moment stdout is a pipe: {bad}")


def test_setup_py_keyring_service_matches_the_server():
    """Same service string, or the secret is stored somewhere the server never looks."""
    setup = _load_setup()
    server_src = (SAT / "server.py").read_text(encoding="utf-8", errors="replace")
    assert setup.KEYRING_SERVICE == "vocalis-satellite"
    assert f'KEYRING_SERVICE = "{setup.KEYRING_SERVICE}"' in server_src


def test_the_successful_health_poll_is_not_on_the_console():
    """Suppress successful health polls so periodic checks do not obscure useful logs, while
    retaining rejected polls because they explain why the satellite is unavailable."""
    import loguru
    import server

    h = server._WerkzeugToLoguru()

    def _emit(msg):
        sent = []
        real_log, real_debug = loguru.logger.log, loguru.logger.debug
        try:
            loguru.logger.log = lambda lvl, m: sent.append(m)
            loguru.logger.debug = lambda m: None
            h.emit(_record(msg))
        finally:
            loguru.logger.log, loguru.logger.debug = real_log, real_debug
        return sent

    line = '192.0.2.182 - - [28/Jul/2026 20:23:33] "POST /satellite/{} HTTP/1.1" {} -'

    assert _emit(line.format("health", "200")) == [], "the 15-second poll still reaches the console"
    assert len(_emit(line.format("health", "401"))) == 1, (
        "a health poll that was REJECTED must still print — it is why the card went gray")
    assert len(_emit(line.format("render", "200"))) == 1, (
        "this drops the poll, not the log: a real request line must survive")


# ── the certificate function shared with the Docker provisioning tool (October 10, 2026) ─────

def _certificate_names(cert_p):
    """(IP strings, DNS names, common name) of a PEM certificate, read independently of setup.py."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    cert = x509.load_pem_x509_certificate(cert_p.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    cn = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    return ([str(i) for i in san.get_values_for_type(x509.IPAddress)],
            list(san.get_values_for_type(x509.DNSName)), cn)


def test_make_cert_still_certifies_exactly_what_san_names_computes(tmp_path, monkeypatch):
    """🔴 A native setup.bat user must get the same certificate names as before the factoring: the
    interactive path computes (names, ips) with `_san_names` and nothing else may be added or lost.
    The common name stays the first (sorted) name."""
    setup = _load_setup()
    _fake_host(monkeypatch, setup)
    monkeypatch.setattr(setup, "CERTS", tmp_path)
    expected_names, expected_ips = setup._san_names(["vocalis.example", "192.0.2.9"])
    setup.make_cert(["vocalis.example", "192.0.2.9"])
    ips, names, cn = _certificate_names(tmp_path / "cert.pem")
    assert names == expected_names, names
    assert ips == expected_ips, ips
    assert cn == expected_names[0]
    assert expected_names == sorted({"BOX", "box", "box.example.test", "box.lan", "localhost",
                                     "vocalis.example"}), expected_names


def test_build_certificate_asks_nothing_prints_nothing_and_uses_only_what_it_is_given(
        monkeypatch, capsys, tmp_path):
    """The Docker tool's certificate must carry the given addresses and nothing derived from the
    host (the container's own name and addresses are meaningless to a client)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    setup = _load_setup()
    _fake_host(monkeypatch, setup, host="THE-CONTAINER", fqdn="the-container.internal")

    def refuse(*a, **k):
        raise AssertionError("build_certificate must not ask anything")

    monkeypatch.setattr("builtins.input", refuse)
    key_pem, cert_pem = setup.build_certificate(["localhost", "satellite.lan"],
                                                ["127.0.0.1", "192.0.2.77"])
    assert capsys.readouterr().out == ""
    cert_p = tmp_path / "cert.pem"
    cert_p.write_bytes(cert_pem)
    ips, names, cn = _certificate_names(cert_p)
    assert (ips, names, cn) == (["127.0.0.1", "192.0.2.77"], ["localhost", "satellite.lan"],
                                "localhost")
    cert = x509.load_pem_x509_certificate(cert_pem)
    key = serialization.load_pem_private_key(key_pem, password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey) and key.curve.name == "secp256r1"
    lifetime = cert.not_valid_after_utc - cert.not_valid_before_utc
    assert lifetime.days == 365 * setup.CERT_YEARS + 1, "the ten-year lifetime changed"
    with pytest.raises(ValueError):
        setup.build_certificate([], ["127.0.0.1"])


def test_write_certificate_pair_replaces_both_files_and_leaves_no_temporaries(tmp_path, monkeypatch):
    setup = _load_setup()
    opened = []
    real_open = setup.os.open

    def spy(path, flags, mode=0o777, *args, **kwargs):
        opened.append((Path(setup.os.fspath(path)).name, flags, mode))
        return real_open(path, flags, mode, *args, **kwargs)

    monkeypatch.setattr(setup.os, "open", spy)
    cert_p, key_p = setup.write_certificate_pair(tmp_path, ["localhost"], ["127.0.0.1"])
    # Mode checked on every platform through the argument (Windows has no modes to read back):
    # the key is created 0600 and exclusively, never opened over an existing file.
    (_, key_flags, key_mode), = [c for c in opened if c[0] == "key.pem.new"]
    assert key_mode == 0o600 and key_flags & setup.os.O_EXCL
    monkeypatch.setattr(setup.os, "open", real_open)
    first = (cert_p.read_bytes(), key_p.read_bytes())
    setup.write_certificate_pair(tmp_path, ["localhost", "b.lan"], ["127.0.0.1", "192.0.2.5"])
    assert (cert_p.read_bytes(), key_p.read_bytes()) != first
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cert.pem", "key.pem"]
    ips, names, _cn = _certificate_names(cert_p)
    assert ips == ["127.0.0.1", "192.0.2.5"] and names == ["localhost", "b.lan"]
    if setup.os.name == "posix":                    # Windows has no modes to read back
        assert (key_p.stat().st_mode & 0o777) == 0o600


def _failing_second_rename(setup):
    """A rename that works for the first move (the certificate) and fails for the second (the key)."""
    calls = []

    def replace(src, dst):
        calls.append(Path(dst).name)
        if len(calls) == 2:
            raise OSError("injected: the key could not be moved into place")
        setup.os.replace(src, dst)

    return replace, calls


def test_a_failed_key_rename_puts_the_old_certificate_back_and_leaves_no_temporaries(tmp_path):
    setup = _load_setup()
    cert_p, key_p = setup.write_certificate_pair(tmp_path, ["localhost"], ["127.0.0.1"])
    old = (cert_p.read_bytes(), key_p.read_bytes())
    replace, calls = _failing_second_rename(setup)
    with pytest.raises(OSError, match="injected"):
        setup.write_certificate_pair(tmp_path, ["localhost", "b.lan"], ["127.0.0.1"], replace=replace)
    assert calls == ["cert.pem", "key.pem"], "the certificate moves first, then the key"
    assert (cert_p.read_bytes(), key_p.read_bytes()) == old, "the old pair must be what is on disk"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cert.pem", "key.pem"]


def test_a_failed_key_rename_with_no_previous_pair_leaves_nothing(tmp_path):
    setup = _load_setup()
    replace, _calls = _failing_second_rename(setup)
    with pytest.raises(OSError, match="injected"):
        setup.write_certificate_pair(tmp_path, ["localhost"], ["127.0.0.1"], replace=replace)
    assert list(tmp_path.iterdir()) == []


def test_a_failed_certificate_rename_leaves_the_old_pair_and_no_temporaries(tmp_path):
    setup = _load_setup()
    cert_p, key_p = setup.write_certificate_pair(tmp_path, ["localhost"], ["127.0.0.1"])
    old = (cert_p.read_bytes(), key_p.read_bytes())

    def replace(src, dst):
        raise OSError("injected: nothing can be renamed")

    with pytest.raises(OSError, match="injected"):
        setup.write_certificate_pair(tmp_path, ["localhost", "b.lan"], ["127.0.0.1"], replace=replace)
    assert (cert_p.read_bytes(), key_p.read_bytes()) == old
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cert.pem", "key.pem"]


@pytest.mark.parametrize("had_pair", [True, False])
def test_a_failed_certificate_write_leaves_no_key_temporary_and_the_old_pair(tmp_path, monkeypatch, had_pair):
    setup = _load_setup()
    old = None
    if had_pair:
        cert_p, key_p = setup.write_certificate_pair(tmp_path, ["localhost"], ["127.0.0.1"])
        old = (cert_p.read_bytes(), key_p.read_bytes())
    real = setup._write_new_file

    def failing(path, data, mode):
        if path.name == "cert.pem.new":
            raise OSError("injected: the certificate could not be written")
        real(path, data, mode)              # the key temporary IS written, then must be cleaned up

    monkeypatch.setattr(setup, "_write_new_file", failing)
    with pytest.raises(OSError, match="injected"):
        setup.write_certificate_pair(tmp_path, ["localhost", "b.lan"], ["127.0.0.1"])
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == (["cert.pem", "key.pem"] if had_pair else []), names
    if had_pair:
        assert (cert_p.read_bytes(), key_p.read_bytes()) == old


def test_a_stale_temporary_is_replaced_not_followed_or_trusted(tmp_path):
    setup = _load_setup()
    (tmp_path / "key.pem.new").write_bytes(b"stale key from a crashed run")
    (tmp_path / "cert.pem.new").write_bytes(b"stale certificate")
    cert_p, key_p = setup.write_certificate_pair(tmp_path, ["localhost"], ["127.0.0.1"])
    assert b"stale" not in cert_p.read_bytes() + key_p.read_bytes()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cert.pem", "key.pem"]


def test_the_native_closing_text_does_not_mention_a_load_button(tmp_path, monkeypatch, capsys):
    """The Settings page has no Load button: ticking a satellite's card loads it."""
    setup = _load_setup()
    _fake_host(monkeypatch, setup)
    monkeypatch.setattr(setup, "CERTS", tmp_path)
    monkeypatch.setattr(setup, "CONFIG_FILE", tmp_path / "satellite.yaml")
    setup.make_cert([])
    monkeypatch.setattr(sys, "argv", ["setup.py", "--skip-secret", "--skip-cert"])
    capsys.readouterr()
    setup.main()
    out = capsys.readouterr().out
    assert "press Load" not in out and "Load." not in out
    assert "they load as soon as you" in out and "tick them." in out


def test_certificate_helpers_report_the_same_fingerprint_and_addresses(tmp_path):
    import hashlib
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    setup = _load_setup()
    cert_p, _key_p = setup.write_certificate_pair(tmp_path, ["localhost", "x.lan"],
                                                  ["127.0.0.1", "192.0.2.5"])
    der = x509.load_pem_x509_certificate(cert_p.read_bytes()).public_bytes(
        serialization.Encoding.DER)
    digest = hashlib.sha256(der).hexdigest().upper()
    assert setup.certificate_fingerprint(cert_p) == ":".join(
        digest[i:i + 2] for i in range(0, len(digest), 2))
    assert setup.certificate_addresses(cert_p) == (["127.0.0.1", "192.0.2.5"],
                                                   ["localhost", "x.lan"])


def test_only_the_409_handshake_loses_its_red():
    """Werkzeug colors the access line itself, hardcoded in `serving.py`: any 4xx except
    404 is BOLD RED. In this protocol a `409` is not a failure — it is the content-addressed
    voice handshake asking for a sample the satellite has not got, immediately followed by the
    upload and a 200 — so the healthiest path in the design read as an error on the console.

    Only the 409 changes severity because this protocol uses it for the voice-sample handshake;
    preserve Werkzeug's normal severity and colors for every other status.
    """
    import loguru
    import server

    h = server._WerkzeugToLoguru()

    def _emit(msg):
        sent = []
        real = loguru.logger.log
        try:
            loguru.logger.log = lambda lvl, m: sent.append(m)
            h.emit(_record(msg))
        finally:
            loguru.logger.log = real
        return sent

    red = "\x1b[1m\x1b[31m"
    line = '192.0.2.182 - - [28/Jul/2026 19:37:56] "POST /satellite/{} HTTP/1.1" {} -'

    got = _emit(red + line.format("stream", "409") + "\x1b[0m")
    assert len(got) == 1 and "\x1b[" not in got[0], f"409 still arrives red: {got[0]!r}"
    assert '" 409 -' in got[0], "the line itself must survive"

    # ...and every other status keeps werkzeug's color, which is the half that got broken once.
    for code in ("500", "404", "401"):
        got = _emit(red + line.format("render", code) + "\x1b[0m")
        assert "\x1b[" in got[0], f"{code} lost its color — only 409 should"
