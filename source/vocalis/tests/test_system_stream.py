"""The hardware strip uses one held system stream rather than issuing repeated requests. These tests pin the stream response and update cadence."""
from __future__ import annotations

import json

import pytest

import vocalis_server as vs
from vocalis.runtime import gpu
from vocalis.web import system as web_system


SAMPLE = {
    "gpus": [{"index": 0, "name": "Radeon Pro R9700", "total_gb": 32.0, "free_gb": 30.0,
              "used_gb": 2.0, "vocalis_gb": 1.0, "util_pct": 7, "temp_c": 41, "power_w": 33,
              "sclk_mhz": 0, "mclk_mhz": 96}],
    "cpu": {"pct": 3.5, "mhz": 3800, "power_w": 42, "temp_c": 38, "cores": 32,
            "mem_used_gb": 12.0, "mem_total_gb": 128.0, "mem_reclaimable_gb": 4.0,
            "swap_used_gb": 0.0, "swap_total_gb": 8.0, "mem_psi": None, "uptime_s": 900,
            "loadavg": [0.4, 0.5, 0.6]},
    "power": None,
    "ups": None,
    "temps": None,
}


@pytest.fixture
def client(monkeypatch):
    """A logged-in client, a fixed sample, and frames as fast as the loop can write them.

    ⚠️ `STRIP_FRAME_S` IS MONKEYPATCHED AND THAT IS NOT MERELY SPEED. At the real 0.25 s a test
    that wants three frames spends most of a second asleep inside a request thread, and the
    suite runs this file alongside everything else — the wall-clock is paid once per test.
    The interval is read from the module inside the generator, so patching it here reaches
    the running stream.
    """
    monkeypatch.setattr(web_system, "STRIP_FRAME_S", 0.001)
    monkeypatch.setattr(gpu, "strip_sample", lambda: SAMPLE)
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        with c.session_transaction() as sess:
            sess["logged_in"] = True
        yield c


def _frames(resp, n):
    """`n` SSE frames off a live stream, as decoded strings, WITHOUT draining it.

    The route writes one chunk per event, so one `next()` is one frame; a stricter reader would
    buffer on blank lines, but a chunk boundary that stopped matching an event boundary is itself
    something worth failing on.
    """
    it = iter(resp.response)
    return [next(it).decode("utf-8") for _ in range(n)]


# ── the stream itself ─────────────────────────────────────────────────────────

def test_the_stream_is_an_event_stream_that_tells_the_client_how_to_reconnect(client):
    r = client.get("/system/stream")
    try:
        assert r.status_code == 200
        assert r.mimetype == "text/event-stream"
        # 🔴 `no-transform` AND `X-Accel-Buffering: no`, not decoration: a proxy that buffers or
        # rewrites the body turns a live strip into a stall nobody can see from the browser.
        assert "no-cache" in r.headers["Cache-Control"]
        assert "no-transform" in r.headers["Cache-Control"]
        assert r.headers["X-Accel-Buffering"] == "no"
        first = _frames(r, 1)[0]
        # `retry:` is in the SSE spec rather than a library feature — it is what makes a tab that
        # froze under memory pressure and thawed come back on its own instead of going silent.
        assert first.startswith("retry: ")
        assert first.endswith("\n\n")
    finally:
        r.close()


def test_every_frame_carries_the_same_sample_the_poll_route_returns(client):
    r = client.get("/system/stream")
    try:
        got = _frames(r, 3)[1:]  # frame 0 is `retry:`
        assert len(got) == 2, "the stream stopped after one sample"
        for f in got:
            assert f.startswith("data: ") and f.endswith("\n\n")
            assert json.loads(f[len("data: "):]) == SAMPLE
    finally:
        r.close()
    # The point of the whole milestone: the SAME payload, one connection instead of four a second.
    assert client.get("/system/stats").get_json() == SAMPLE


# ── the gate ─────────────────────────────────────────────────────────────────

def test_the_stream_is_NOT_open_to_an_unauthenticated_caller(tmp_path, monkeypatch):
    """🔴 EVERY OTHER TEST IN THIS FILE LOGS IN, SO NONE OF THEM CAN SEE THIS.

    The `client` fixture sets `logged_in`, which makes the unauthenticated case structurally
    unobservable in all of them — and "the app-level `before_request` gates it" was reasoning
    rather than a measurement when this route was added.

    ⚠️ AUTH HAS TO BE TURNED ON FOR THE QUESTION TO MEAN ANYTHING, which is the trap the first
    version of this test fell into. `_require_login` returns immediately when
    `auth.auth_enabled()` is false, and an absent `admin_credentials.yaml` is the deliberate,
    documented "open on the LAN" first-run state — so with the ordinary fixture EVERY path answers
    200 and an assertion about gating would be measuring the fixture, not the route.

    🔴 IT MATTERS BECAUSE THE NEIGHBORING ROUTE IS DELIBERATELY OPEN. `/health` is on
    `_OPEN_PATHS` on purpose, so a locked Vocalis can still say it is locked, and
    `_require_unlocked` keeps its own path-based exempt list. A new `/system/*` path landing on
    either would publish this box's whole telemetry to anyone who can reach the port — card names,
    VRAM, temperatures, power draw, uptime, load — as a one-line mistake with no visible symptom.

    📌 `/system/stats` is asserted beside it: they carry the SAME payload, and a gate that covered
    one but not the other would be the worst of both.
    """
    from vocalis.runtime import auth as rt_auth
    from werkzeug.security import generate_password_hash
    import yaml as _yaml

    # ORDER IS LOAD-BEARING, exactly as tests/test_auth.py's `creds` fixture records: auth state
    # lives in process-wide globals, so the patch is undone FIRST and the real file reloaded
    # AFTER, or every later test in the run sees 401 on everything.
    f = tmp_path / "admin_credentials.yaml"
    f.write_text(_yaml.safe_dump({"username": "admin",
                                  "password_hash": generate_password_hash("hunter2")}),
                 encoding="utf-8")
    monkeypatch.setattr(rt_auth, "ADMIN_CREDS_FILE", f)
    try:
        vs._apply_admin_creds()
        assert rt_auth.auth_enabled(), "the fixture failed to turn auth on, so this proves nothing"
        monkeypatch.setattr(gpu, "strip_sample", lambda: SAMPLE)
        vs.app.config["TESTING"] = True
        with vs.app.test_client() as c:      # no session — nobody has logged in
            for path in ("/system/stream", "/system/stats"):
                r = c.get(path)
                try:
                    assert r.status_code != 200, (
                        f"{path} answered 200 with auth ON and no session — the box's telemetry "
                        "is readable by anyone who can reach the port")
                finally:
                    r.close()                # the stream is infinite if it ever DID answer
            # And `/health` is still open, because a locked Vocalis has to be able to say so.
            assert c.get("/health").status_code == 200, (
                "/health stopped answering unauthenticated — the extensions rely on it to tell "
                "'locked' apart from 'unreachable'")
    finally:
        monkeypatch.undo()                   # restore the REAL creds path first...
        vs._apply_admin_creds()              # ...then reload, so the globals end up clean


# ── the cap, and the slot ─────────────────────────────────────────────────────

def test_a_closed_stream_gives_its_slot_back(client):
    assert web_system.strip_stream_count() == 0
    r = client.get("/system/stream")
    _frames(r, 1)          # the generator has actually started
    assert web_system.strip_stream_count() == 1
    r.close()
    assert web_system.strip_stream_count() == 0, "the `finally` did not run — slots leak forever"


def test_past_the_cap_the_answer_is_a_503_that_says_the_number(client, monkeypatch):
    """⚠️ THE CLIENT IS NOT BROKEN BY THIS, and the 503 is how it knows. `EventSource` sets
    `readyState === CLOSED` on a non-SSE response and never retries, which is exactly the cue
    `js/sys/hwstrip.js` uses to fall back to polling `/system/stats`."""
    monkeypatch.setattr(web_system, "MAX_STRIP_STREAMS", 2)
    open_streams = []
    try:
        for _ in range(2):
            r = client.get("/system/stream")
            _frames(r, 1)
            open_streams.append(r)
        refused = client.get("/system/stream")
        assert refused.status_code == 503
        body = refused.get_json()
        assert body["error"] == "too many streams"
        assert body["max"] == 2
        # 🔴 AND THE REFUSAL DOES NOT COST A SLOT. `_strip_stream_open` returns False without
        # incrementing; if it did not, a burst of refusals would lock the channel permanently.
        assert web_system.strip_stream_count() == 2
    finally:
        for r in open_streams:
            r.close()
    assert web_system.strip_stream_count() == 0


def test_closing_one_stream_readmits_the_next_client(client, monkeypatch):
    """The cap is a ceiling on CONCURRENT streams, not a budget that runs out. A counter that
    only ever went up would pass every test above and close the channel after eight page loads."""
    monkeypatch.setattr(web_system, "MAX_STRIP_STREAMS", 1)
    a = client.get("/system/stream")
    _frames(a, 1)
    assert client.get("/system/stream").status_code == 503
    a.close()
    b = client.get("/system/stream")
    try:
        assert b.status_code == 200
        assert _frames(b, 1)[0].startswith("retry: ")
    finally:
        b.close()
