"""A second server on a live port must fail clearly, on both supported server implementations.

`HTTPServer` sets `allow_reuse_address = 1`, which Werkzeug inherits. On POSIX this permits reuse
after old connections enter TIME_WAIT but still rejects a live listener. On Windows, the same
option can allow a second process to bind an actively used port. The tests assert the platform
split and verify the refusal message for both Vocalis and the satellite.

🔴 **THE REPRODUCTION IS IN THE FILE, NOT IN A COMMENT ABOUT IT.**
`test_the_stock_socket_option_is_what_let_the_second_copy_in` asserts the raw platform behavior
both ways round, so if a future Windows or Python changes it, this says so rather than leaving the
fix as dead weight nobody dares remove — the shape `test_tls_accept_stall.py` uses, for the reason
it gives.

⚠️ **TWO PROGRAMS, TWO COPIES OF THE CLASS, ONE TEST FILE.** The satellite never imports Vocalis
(its header says why), so the fix cannot be shared as code. It can be shared as a test: every claim
below is made against BOTH, and a copy that drifts fails here.
"""
import os
import socket

import pytest

import vocalis_server as vs


def _app(environ, start_response):                      # a WSGI app that is never called
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [b"ok"]


def _satellite():
    """The satellite module, imported the way the other satellite tests import it."""
    import server
    return server


def _builders():
    """(name, build) for each program that binds a port. `build(host, port)` -> a live server."""
    return [
        ("vocalis", lambda host, port: vs.build_server(_app, host, port, None)),
        ("satellite", lambda host, port: _satellite()._ExclusiveServer(host, port, _app, ssl_context=None)),
    ]


def _errors(name):
    """The PortInUseError class the named program raises — they are separate classes."""
    return vs.PortInUseError if name == "vocalis" else _satellite().PortInUseError


@pytest.mark.parametrize("name", ["vocalis", "satellite"])
def test_a_second_server_on_a_live_port_refuses_to_start(name):
    """The whole bug, in three lines: bind, bind again, and the second one must not succeed."""
    build = dict(_builders())[name]
    srv = build("127.0.0.1", 0)
    port = srv.server_port
    try:
        with pytest.raises(_errors(name)) as excinfo:
            build("127.0.0.1", port)
    finally:
        srv.server_close()
    msg = str(excinfo.value)
    # 🔴 THE SENTENCE IS THE FIX. A second copy that dies with a traceback about a socket beats
    # one that sits there looking alive, but only just: what has to be on screen is which port,
    # that this copy did NOT start, and what to do instead.
    assert str(port) in msg, f"the error never names the port: {msg!r}"
    assert "NOT started" in msg or "HAS NOT STARTED" in msg, msg
    assert "--port" in msg, f"the error should offer the way out: {msg!r}"
    # 🔴 NOT AN OSError, AND THE TEST IS THE REASON THE CLASS IS NOT ONE. Werkzeug's
    # `BaseWSGIServer.__init__` catches every OSError out of the bind, prints the strerror and
    # `sys.exit(1)`s — so an OSError subclass never gets out of the constructor at all. The first
    # version of this fix was one, and every assertion above failed on a bare `SystemExit`.
    assert not isinstance(excinfo.value, OSError)


@pytest.mark.parametrize("name", ["vocalis", "satellite"])
def test_the_first_server_is_unharmed_and_the_port_frees_up(name):
    """A refusal must not stop the already-running copy.

    So: the live server still accepts after the failed second bind, and the port is bindable
    again immediately after it closes, preserving restart behavior when old connections remain in
    TIME_WAIT.
    """
    build = dict(_builders())[name]
    srv = build("127.0.0.1", 0)
    port = srv.server_port
    try:
        with pytest.raises(_errors(name)):
            build("127.0.0.1", port)
        with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
            assert c.getpeername()[1] == port           # the original listener still accepts
    finally:
        srv.server_close()
    again = build("127.0.0.1", port)                    # and it rebinds immediately afterward
    again.server_close()


@pytest.mark.parametrize("name", ["vocalis", "satellite"])
def test_the_exclusive_bind_is_windows_only(name):
    """The mechanism, named, and the platform split stated as an assertion rather than a comment.

    `allow_reuse_address = False` is what makes the bind exclusive. POSIX keeps werkzeug's stock
    flag on purpose: there it is what lets a service restart while old connections are still in
    TIME_WAIT, and a live listener already refuses a second bind without any help.
    """
    build = dict(_builders())[name]
    srv = build("127.0.0.1", 0)
    try:
        assert srv.allow_reuse_address is (os.name != "nt")
    finally:
        srv.server_close()


@pytest.mark.parametrize("name", ["vocalis", "satellite"])
def test_a_bind_failure_that_is_not_a_busy_port_is_not_dressed_up_as_one(name):
    """Errors unrelated to a busy port must remain Werkzeug errors, rather than being reported as
    another instance already running."""
    build = dict(_builders())[name]
    with pytest.raises((SystemExit, OSError)) as excinfo:
        build("203.0.113.7", 7870)                      # TEST-NET-3: not an address on this box
    assert not isinstance(excinfo.value, _errors(name))


def test_the_stock_socket_option_is_what_let_the_second_copy_in():
    """Assert the raw socket behavior on each platform.

    🔴 IT ASSERTS THE OPPOSITE THING ON EACH PLATFORM ON PURPOSE. Windows: SO_REUSEADDR really
    does hand a live listener's port to a second binder, which is the defect. POSIX: it does not,
    which is why the fix leaves POSIX's stock behavior alone.
    """
    first = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    first.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)    # what HTTPServer sets
    first.bind(("127.0.0.1", 0))
    first.listen(5)
    port = first.getsockname()[1]
    second = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    second.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        if os.name == "nt":
            second.bind(("127.0.0.1", port))            # no error — this IS the bug being fixed
        else:
            with pytest.raises(OSError):
                second.bind(("127.0.0.1", port))
    finally:
        first.close()
        second.close()


def test_the_satellite_binds_before_it_does_anything_else():
    """🔴 A COPY THAT CANNOT RUN MUST TOUCH NOTHING THAT BELONGS TO THE ONE THAT CAN.

    Two orderings, and both were wrong before this fix:

      · `main()` logged "listening on https://…:7880" and only THEN handed the port to
        `app.run()`, so the one line the second copy printed was a claim it had no evidence for —
        which is what made a dead process look like a healthy start;
      · and it ran the scratch sweep and started the idle reaper BEFORE binding, so a copy with
        nowhere to listen still reached into the running one's working directory. `STALE_AFTER_S`
        is 6 hours, so it could not have eaten a live job — but that is a margin, and the bind
        going first makes it a property.

    Asserted on the source order rather than by running `main()`, which loads models and takes a
    real port; what matters is that everything else comes after the thing that earns it.
    """
    text = open(_satellite().__file__, encoding="utf-8").read()
    main_at = text.index("def main():")
    bind_at = text.index("_ExclusiveServer(args.host, args.port, app", main_at)
    for what in ('logger.info(f"listening on', "leadvocal.sweep_stale()", "leadvocal.start_reaper()"):
        assert bind_at < text.index(what, main_at), (
            f"main() reaches {what!r} before it has bound the port — a second copy would do that "
            f"to the first one's install and only then discover it cannot run")
