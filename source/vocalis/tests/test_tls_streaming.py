"""A streaming response must reach the client frame by frame over TLS. Buffering the full body would delay updates to the system strip."""
import socket
import ssl
import threading
import time

import pytest

import vocalis_server
# werkzeug imports cryptography INSIDE generate_adhoc_ssl_context, never at module level,
# so this name is safe to import at the top and the skip below still guards the CALL.
# Written this way to need no `noqa: E402` — the suppression ratchets count directives,
# and buying one for an import that can simply move is the wrong trade.
from werkzeug.serving import generate_adhoc_ssl_context

pytest.importorskip("cryptography", reason="adhoc TLS cert needs cryptography")

#: Five chunks, 200 ms apart. Long enough that a buffered body is unmistakable, short enough that
#: the whole file costs about a second.
CHUNKS = 5
GAP_S = 0.2

#: A buffered response delivers everything at once, so its spread is bounded by the network, i.e.
#: microseconds on loopback. A streamed one cannot be tighter than (CHUNKS-1) * GAP_S = 800 ms.
#: 300 ms sits far from both, and it is a SPREAD rather than a latency — a loaded box stretches
#: every arrival together and leaves the spread intact, which is what keeps this off the flake
#: list under sixteen workers.
MIN_STREAMED_SPREAD_S = 0.3
MAX_BUFFERED_SPREAD_S = 0.1


def _streaming_app(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/event-stream"),
                              ("Cache-Control", "no-cache"),
                              ("X-Accel-Buffering", "no")])

    def gen():
        for i in range(CHUNKS):
            yield f"data: frame {i}\n\n".encode()
            time.sleep(GAP_S)

    return gen()


def _buffered_app(environ, start_response):
    """The same bytes, produced all at once — the control arm."""
    time.sleep(GAP_S * CHUNKS)
    body = b"".join(f"data: frame {i}\n\n".encode() for i in range(CHUNKS))
    start_response("200 OK", [("Content-Type", "text/event-stream"),
                              ("Content-Length", str(len(body)))])
    return [body]


def _serve(app):
    srv = vocalis_server.build_server(app, "127.0.0.1", 0, generate_adhoc_ssl_context())
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t


def _frame_arrival_times(port):
    """Open the stream over TLS and record when each frame's bytes actually land.

    Raw sockets rather than urllib: `urlopen().read()` on a chunked body can coalesce, and the
    question here is precisely WHEN bytes arrive. The certificate is adhoc and self-signed, so
    verification is off — this is testing framing, not trust.
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    raw = socket.create_connection(("127.0.0.1", port), timeout=15)
    sock = ctx.wrap_socket(raw, server_hostname="127.0.0.1")
    try:
        sock.sendall(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n"
                     b"Connection: close\r\n\r\n")
        sock.settimeout(15)
        arrivals, seen, buf = [], 0, b""
        deadline = time.time() + 15
        while seen < CHUNKS and time.time() < deadline:
            try:
                data = sock.recv(4096)
            except socket.timeout:
                break
            if not data:
                break
            buf += data
            # Count only complete frames, and time each one at the moment its bytes landed.
            complete = buf.count(b"\n\n")
            # The header block ends in a blank line too; discount it once it is present.
            if b"HTTP/1." in buf:
                complete -= 1
            while seen < complete:
                arrivals.append(time.time())
                seen += 1
        return arrivals
    finally:
        sock.close()


def _spread(arrivals):
    return (arrivals[-1] - arrivals[0]) if len(arrivals) >= 2 else 0.0


@pytest.mark.timeout(120)
def test_a_streaming_body_arrives_frame_by_frame_over_tls():
    srv, t = _serve(_streaming_app)
    try:
        arrivals = _frame_arrival_times(srv.server_port)
    finally:
        srv.shutdown()
        t.join(timeout=10)

    assert len(arrivals) >= 3, (
        f"only {len(arrivals)} frame(s) came back over TLS out of {CHUNKS}. The strip's "
        "EventSource needs a body that keeps arriving; if this is 0 or 1 the connection is being "
        "closed or the generator is not being iterated at all."
    )
    assert _spread(arrivals) >= MIN_STREAMED_SPREAD_S, (
        f"the frames arrived within {_spread(arrivals):.3f}s of each other, which means the TLS "
        f"layer BUFFERED the body and released it in one go — they were written {GAP_S}s apart.\n"
        "  On a loaded HTTPS listener, that can freeze the system strip until STALL_MS fires after 3s "
        "and the page silently falls back to the 4 Hz poll the milestone replaced.\n"
        "  Nothing else in the suite can see this: every other test of /system/stream uses "
        "Flask's test client, which returns the generator's output as a value and never "
        "touches a socket."
    )


@pytest.mark.timeout(120)
def test_the_measurement_can_tell_a_buffered_body_apart():
    """🔴 The vacuity guard. Identical bytes, produced all at once, must collapse the spread."""
    srv, t = _serve(_buffered_app)
    try:
        arrivals = _frame_arrival_times(srv.server_port)
    finally:
        srv.shutdown()
        t.join(timeout=10)

    assert len(arrivals) >= 3, f"the control arm returned only {len(arrivals)} frame(s)"
    assert _spread(arrivals) <= MAX_BUFFERED_SPREAD_S, (
        f"the control arm spread over {_spread(arrivals):.3f}s, but it writes everything in one "
        "body — so this measurement cannot distinguish streamed from buffered, and the test "
        "above proves nothing. Fix the measurement, not the threshold."
    )
