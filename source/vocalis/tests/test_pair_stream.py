"""Tests for the pairing event stream. The stream broadcasts availability only; `/pair/poll` remains the single-winner claim route."""
from __future__ import annotations

import queue

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import paths
from wbedit import doorbell, pairing, push, sweep

TOKEN = "t" * 32


def _reset_the_module_globals():
    """Restore every module-level queue and result field touched by these tests before and after each case."""
    doorbell.reset()
    sweep._requested = False
    sweep._requested_at = 0.0
    sweep._seen_at = 0.0
    sweep._started_at = 0.0
    sweep._result = None
    push._job = None
    push._job_at = 0.0
    push._running = None
    push._started_at = 0.0
    push._result = None


@pytest.fixture(autouse=True)
def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    _reset_the_module_globals()
    yield
    _reset_the_module_globals()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(pairing, "verify", lambda t: t == TOKEN)
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


def _open(client, token=TOKEN):
    """Open the stream and return the werkzeug response, unconsumed.

    ⚠️ The body is an INFINITE generator. Every reader below takes a bounded number of chunks and
    then closes it — iterating to exhaustion hangs the suite, which is what `--timeout=60` is
    there to turn into a stack trace rather than a wedged run.
    """
    return client.get(f"/pair/stream?token={token}")


def _chunks(resp, n):
    it = resp.response
    out = []
    for chunk in it:
        out.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        if len(out) >= n:
            break
    return out


# ───────────────────────────────────────────── the gate

def test_the_stream_takes_its_token_from_the_query_string(client):
    """EventSource cannot set request headers, so the stream authenticates with the pairing token in its query string."""
    r = _open(client)
    assert r.status_code == 200
    assert r.mimetype == "text/event-stream"
    r.close()


def test_a_wrong_token_is_401_like_every_other_rule_in_the_family(client):
    assert _open(client, "wrong").status_code == 401
    assert client.get("/pair/stream").status_code == 401, "no token at all is the same answer"


def test_a_rejected_stream_never_logs_the_token(client, monkeypatch):
    """🔴 THE TOKEN IS IN THE URL, SO THE 401 LOG LINE IS WHERE IT WOULD LAND ON DISK.

    `_check_pairing` logs `request.path`, which in Werkzeug is the path ALONE — the query string is
    on `request.query_string` / `request.full_path`. Someone "improving" that line to `full_path`
    writes a near-miss pairing token into the log, which is the precise failure the existing
    comment there was written against (the fork's own `b7350db26`). Asserted on the emitted record
    rather than by reading the source, because only the record is what reaches the disk."""
    seen = []
    from loguru import logger
    sink = logger.add(lambda m: seen.append(str(m)), level="INFO")
    try:
        assert _open(client, "nearmiss-" + "t" * 24).status_code == 401
    finally:
        logger.remove(sink)
    joined = "\n".join(seen)
    assert "/pair/stream" in joined, "the rejection must still be logged"
    assert "nearmiss" not in joined, "the token reached the log"
    assert "token=" not in joined, "the query string reached the log"


# ───────────────────────────────────────────── the frames

def test_the_stream_opens_with_a_retry_and_a_hello(client):
    """`retry:` is the client's automatic reconnect interval and it is in the SSE spec, not a
    library feature — which is what makes a frozen-then-thawed tab self-healing rather than
    permanently silent."""
    r = _open(client)
    try:
        head = "".join(_chunks(r, 2))
        assert head.startswith("retry:")
        assert "event: hello" in head
    finally:
        r.close()


def test_ringing_the_doorbell_wakes_an_open_stream(client):
    """The whole feature, at the wire: a job comes into existence and the tab is told at once
    rather than up to five minutes later when a throttled timer next fires."""
    r = _open(client)
    try:
        _chunks(r, 2)                       # retry + hello
        sweep.request()
        frame = _chunks(r, 1)[0]
        assert frame == "event: work\ndata: {}\n\n"
    finally:
        r.close()


def test_the_frame_never_carries_a_job(client):
    """Broadcast frames signal availability only; `/pair/poll` claims the job so multiple tabs cannot perform the same write."""
    r = _open(client)
    try:
        _chunks(r, 2)
        push.request("doc-abc", 3, kind="card", name='Test Character')
        frame = _chunks(r, 1)[0]
        assert frame == "event: work\ndata: {}\n\n"
        for leak in ("doc-abc", 'Test Character', "card", '"revision"'):
            assert leak not in frame, f"the frame carried {leak!r} — it must carry nothing"
    finally:
        r.close()


def test_a_silent_stream_still_writes_a_keepalive(client, monkeypatch):
    """🔴 THE KEEPALIVE IS HOW A CLOSED TAB IS DISCOVERED, not merely how a proxy is kept happy.

    A generator blocked in `Queue.get()` never learns the browser went away, because it is not
    writing. This comment line is the write that raises when the socket is gone, unwinds the
    generator and runs its `finally` — without it every closed tab leaks a server thread and
    `doorbell.count()` is permanently wrong."""
    monkeypatch.setattr(doorbell, "KEEPALIVE_S", 0.05)
    r = _open(client)
    try:
        _chunks(r, 2)
        assert _chunks(r, 1)[0] == ": keepalive\n\n"
    finally:
        r.close()


# ───────────────────────────────────────────── the registry

def test_the_registry_is_capped_and_says_so(client, monkeypatch):
    """⚠️ EACH OPEN STREAM IS A SERVER THREAD — Vocalis serves through `make_server(threaded=True)`,
    so a long-lived response is not a coroutine. An uncapped registry is an unbounded thread pool
    driven by whoever holds the token. A refused client is not broken: it falls back to polling,
    which is why that path is being kept."""
    monkeypatch.setattr(doorbell, "MAX_STREAMS", 2)
    open_ones = [_open(client), _open(client)]
    try:
        for r in open_ones:
            _chunks(r, 1)
        refused = _open(client)
        assert refused.status_code == 503
        assert refused.get_json()["max"] == 2
    finally:
        for r in open_ones:
            r.close()


def test_a_ring_with_nobody_listening_is_not_an_error():
    """The ordinary state of an install with no SillyTavern tab open. `request()` must not depend
    on anyone being there — the flag is still set and the poll path still collects it."""
    assert doorbell.ring() == 0
    sweep.request()
    assert sweep.status()["pending"] is True


def test_a_second_ring_before_the_first_is_collected_does_not_queue_two():
    """The queue is an EDGE, not a mailbox (`maxsize=1`). Ten rings while a tab is mid-sweep must
    collapse into one "go and look", not ten redundant polls behind it."""
    sub = doorbell.subscribe()
    assert sub is not None
    _sid, q = sub
    doorbell.ring()
    doorbell.ring()
    doorbell.ring()
    assert q.qsize() == 1
    q.get_nowait()
    with pytest.raises(queue.Empty):
        q.get_nowait()


# ───────────────────────────────────────────── liveness

def test_an_open_stream_is_connected_without_any_poll():
    """🔴 LIVENESS BECOMES A FACT. Vocalis is the server on this connection, so "is a tab
    listening" stops being inferred from how recently one polled."""
    assert sweep.status()["connected"] is False
    sub = doorbell.subscribe()
    assert sweep.status()["connected"] is True
    doorbell.unsubscribe(sub[0])
    assert sweep.status()["connected"] is False


def test_the_poll_window_STILL_answers_for_an_extension_that_has_not_reloaded():
    """The liveness window keeps a recently deployed extension recognized while the browser has not reloaded it to open a stream."""
    assert doorbell.count() == 0
    sweep.note_poll()
    assert sweep.status()["connected"] is True, \
        "an extension that polls but does not stream must still read as connected"


def test_closing_the_stream_deregisters_it(client):
    """⚠️ A MISSED `unsubscribe` MAKES VOCALIS CONFIDENTLY WRONG about the one thing this channel
    exists to know — and wrong in the direction that keeps a stale tab looking alive forever."""
    r = _open(client)
    _chunks(r, 1)
    assert doorbell.count() == 1
    r.close()
    assert doorbell.count() == 0
