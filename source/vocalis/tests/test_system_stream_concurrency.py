"""Concurrent system-strip streams must not starve ordinary application requests. The test holds several streams while checking that other work still completes."""
from __future__ import annotations

import socket
import threading
import time
import urllib.error
import urllib.request

import pytest

from conftest import bound_server  # importing conftest is also the sys.path side effect

import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.web import system as web_system

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: Small enough to keep the test quick, large enough that "several held connections" is really
#: what is being exercised. The production number is 8; this proves the mechanism, not the literal.
CAP = 4


@pytest.fixture
def server(tmp_path, monkeypatch):
    """A real threaded HTTP server on a real port — the whole point of this file."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    store = vault_store.configure([("install", install), ("cache", cache)],
                                  install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", store)
    store.create(PW)
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    import vocalis_server as vs
    monkeypatch.setattr(vs.vault_store, "STORE", store)
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    # The suite must not read the host, and a fixed sample also keeps each frame small.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "strip_sample", lambda: {"gpus": [], "cpu": {"cores": 1},
                                                          "power": None, "ups": None, "temps": None})
    monkeypatch.setattr(web_system, "MAX_STRIP_STREAMS", CAP)
    # Frames often enough that a reader gets one immediately, slow enough not to flood the socket
    # while four of them are held open for the length of the test.
    monkeypatch.setattr(web_system, "STRIP_FRAME_S", 0.05)

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(30.0)
    srv = bound_server(vs.app)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}"
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)


def _open_stream(base):
    """A held SSE connection. Reads ONE chunk so the generator has certainly started, then leaves
    it open — the state a browser tab is in for hours."""
    r = urllib.request.urlopen(base + "/system/stream", timeout=10)
    r.read(1)                       # the response has begun; the slot is claimed and in use
    return r


def test_the_cap_holds_against_real_sockets_and_the_app_still_answers(server):
    held = []
    try:
        for i in range(CAP):
            held.append(_open_stream(server))
        assert web_system.strip_stream_count() == CAP, "the held connections did not all claim a slot"

        # 🔴 THE ONE THAT WOULD HAVE BEEN A PAGE-WIDE OUTAGE. Every slot is held by a blocked
        # thread; an ordinary request must still be served. If werkzeug cannot, the strip does not
        # fall back — the whole UI stops for every client.
        t0 = time.monotonic()
        with urllib.request.urlopen(server + "/health", timeout=10) as h:
            assert h.status == 200
            assert b"version" in h.read()
        served_in = time.monotonic() - t0
        assert served_in < 5.0, (
            f"an ordinary request took {served_in:.1f}s while {CAP} strip streams were held — "
            "held streams are starving the server, which makes this a page outage and not a "
            "strip that degraded")

        # And the next stream is refused rather than queued behind the others.
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(server + "/system/stream", timeout=10)
        assert e.value.code == 503
        assert b"too many streams" in e.value.read()
    finally:
        for r in held:
            r.close()

    # ⚠️ The release happens on the SERVER thread when the socket goes, not in this process, so it
    # is polled rather than asserted instantly — asserting immediately would be a race that fails
    # under load and reads as a flake.
    for _ in range(100):
        if web_system.strip_stream_count() == 0:
            break
        time.sleep(0.05)
    assert web_system.strip_stream_count() == 0, "closing the sockets did not give the slots back"


def test_a_closed_stream_readmits_the_next_client(server):
    """The cap is a ceiling on CONCURRENT streams, not a budget that runs out after `CAP` loads."""
    held = [_open_stream(server) for _ in range(CAP)]
    try:
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(server + "/system/stream", timeout=10)
        assert e.value.code == 503
    finally:
        held.pop().close()

    for _ in range(100):
        if web_system.strip_stream_count() < CAP:
            break
        time.sleep(0.05)

    try:
        again = _open_stream(server)
        again.close()
    except urllib.error.HTTPError as err:  # pragma: no cover - the failure this test exists for
        pytest.fail(f"a freed slot did not readmit the next client: HTTP {err.code}")
    finally:
        for r in held:
            r.close()
