"""A peer that connects but never completes a TLS handshake must not block the accept loop or delay later clients."""
import io
import socket
import ssl
import threading
import time
import types
import urllib.error
import urllib.request

import pytest
from loguru import logger as _loguru_logger

import vocalis_server

pytest.importorskip("cryptography", reason="adhoc TLS cert needs cryptography")
from werkzeug.serving import generate_adhoc_ssl_context, make_server  # noqa: E402


def _app(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [b"ok"]


def _serve(patched: bool):
    """A real TLS server on a free port. Returns (port, server).

    `patched=True` goes through `build_server` — the SAME factory main() uses — rather
    than hand-assembling the override here. A harness that installs the accept path by
    hand can drift from what production actually wires (it did: for three weeks this file
    installed `get_request` alone, which was only half of it)."""
    if patched:
        srv = vocalis_server.build_server(_app, "127.0.0.1", 0,
                                          generate_adhoc_ssl_context())
    else:
        srv = make_server("127.0.0.1", 0, _app, threaded=True,
                          ssl_context=generate_adhoc_ssl_context())
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_port, srv


def _silent_peer(port):
    """Connect and say NOTHING — the whole attack surface, in three lines."""
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    return s                       # deliberately never sends a ClientHello


def _get(port, timeout=6):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return urllib.request.urlopen(f"https://127.0.0.1:{port}/", timeout=timeout,
                                  context=ctx).read()


def _teardown(srv, peers):
    """Close the peers FIRST. On the UNPATCHED server a stalled handshake only unblocks
    when its socket dies, and shutdown() waits for the accept loop to come back round —
    closing in the other order hangs teardown on the very bug under test. (The patched
    server no longer cares, but one ordering serves both.)"""
    for p in peers:
        try:
            p.close()
        except OSError:
            pass
    srv.shutdown()
    srv.server_close()


def test_stock_werkzeug_stalls():
    """Unpatched: one silent peer takes the whole server down. This is the bug."""
    port, srv = _serve(patched=False)
    assert _get(port) == b"ok"                      # healthy before

    peer = _silent_peer(port)
    try:
        with pytest.raises((urllib.error.URLError, TimeoutError, socket.timeout)):
            _get(port, timeout=4)                   # ← now dark, for everyone
    finally:
        _teardown(srv, [peer])


# 🔴 THE HANDSHAKE CLOCK MUST NOT BE TIGHTER THAN A REAL HANDSHAKE ON A LOADED BOX. This
# was 1.0 s and it flaked once in the 16-worker suite — `SSLEOFError`, raised
# by the GOOD client, not the silent peer: an adhoc 2048-bit RSA handshake competing with
# fifteen other workers can miss a one-second budget, and the server then kills a
# legitimate connection mid-handshake. Production's value is 10 s ("a LAN TLS handshake is
# milliseconds; 10 s is pure slack"). **If a test here ever flakes mid-handshake, cut the
# peer count or raise this — never assert on a tighter clock.**
#
# The clock now runs per-connection in a worker thread, so it no longer sets anyone
# else's waiting time — which is exactly what `< HANDSHAKE` asserts below: a fresh
# request completing in less than ONE clock while dawdlers are queued proves nobody
# waited on a stranger's handshake. (Under the serial accept path that took ≥ n × clock.)
HANDSHAKE = 3.0
STORM_PEERS = 5


def test_a_silent_peer_stalls_nobody(monkeypatch):
    """One dawdler: a fresh request must be served in well under one handshake clock —
    and the abandonment must be LOGGED with the peer's address, because that log line is
    the telemetry that names real-world dawdlers on the box."""
    monkeypatch.setattr(vocalis_server, "HANDSHAKE_TIMEOUT_S", HANDSHAKE)
    buf = io.StringIO()
    sink = _loguru_logger.add(buf, format="{message}", level="WARNING")
    port, srv = _serve(patched=True)
    peers = []
    try:
        assert _get(port) == b"ok"
        peers.append(_silent_peer(port))
        time.sleep(0.3)                              # let accept() take the dawdler first
        t0 = time.monotonic()
        assert _get(port, timeout=30) == b"ok"
        elapsed = time.monotonic() - t0
        assert elapsed < HANDSHAKE, (
            f"a fresh request waited {elapsed:.1f}s — it queued on a stranger's handshake "
            f"clock, so the accept loop is serializing handshakes again")
        # The dawdler dies on its own clock, and its obituary names it.
        deadline = time.monotonic() + HANDSHAKE + 5.0
        while time.monotonic() < deadline and "TLS handshake abandoned" not in buf.getvalue():
            time.sleep(0.2)
        assert "TLS handshake abandoned" in buf.getvalue(), (
            "the abandoned handshake was never logged — the production telemetry that "
            "identifies dawdlers is gone")
    finally:
        _loguru_logger.remove(sink)
        _teardown(srv, peers)


def test_a_storm_of_silent_peers_stalls_nobody(monkeypatch):
    """Five dawdlers AT ONCE: still under one clock for a legitimate client. Under the
    old serial accept this cost five clocks (measured shape of the 6-45 s stalls)."""
    monkeypatch.setattr(vocalis_server, "HANDSHAKE_TIMEOUT_S", HANDSHAKE)
    port, srv = _serve(patched=True)
    peers = []
    try:
        for _ in range(STORM_PEERS):
            peers.append(_silent_peer(port))
        time.sleep(0.3)
        t0 = time.monotonic()
        assert _get(port, timeout=30) == b"ok"
        elapsed = time.monotonic() - t0
        assert elapsed < HANDSHAKE, (
            f"a fresh request waited {elapsed:.1f}s behind {STORM_PEERS} dawdlers — "
            f"handshakes are serializing again")
        assert _get(port, timeout=30) == b"ok"       # and it STAYS up
    finally:
        _teardown(srv, peers)


def test_handshake_clock_is_shorter_than_the_socket_clock():
    """The handshake timeout must be shorter than the overall socket timeout so stalled handshakes are closed first."""
    assert vocalis_server.HANDSHAKE_TIMEOUT_S < vocalis_server.SOCKET_TIMEOUT_S
    assert vocalis_server.SOCKET_TIMEOUT_S >= 60.0


def test_wire_tls_accept_installs_both_halves():
    """The deferred accept and the worker-thread handshake are useless apart: sockets
    leave `get_request` un-handshaken, and only the handler knows to finish them. Any
    server carrying one half without the other is a wiring bug."""
    srv = make_server("127.0.0.1", 0, _app, threaded=True,
                      ssl_context=generate_adhoc_ssl_context())
    try:
        vocalis_server.wire_tls_accept(srv)
        assert srv.RequestHandlerClass is vocalis_server._TLSHandshakeHandler
        assert isinstance(srv.get_request, types.MethodType)
        assert srv.get_request.__func__ is vocalis_server._bounded_tls_accept
    finally:
        srv.server_close()
