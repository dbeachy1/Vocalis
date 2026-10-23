"""Cache invalidation and timeout behavior for `SatelliteClient` dialing.

Repeated failures against an unchanged hostname must not trigger repeated DNS lookups and log
messages. A read timeout means the address answered and must preserve the cached dial; a connect
failure may clear it so a changed address can be resolved. These cases use a literal test address,
stub DNS resolution, and monkeypatch `requests.post` so they never perform network I/O.

Two independent fixes, tested here without any real network or DNS lookup — `SatelliteClient`
is built with a literal-IP `url` (so `ipv4_url` short-circuits) and `requests.post` itself is
monkeypatched to raise the exact exception under test:

  (a) `dial_url()` logs a "dialing" line only when the resolved address differs from the last
      one it actually LOGGED for this client — not merely the last one cached — so repeated
      re-resolution to an UNCHANGED address (the ordinary "still down" case) logs once, while a
      genuine address change (DHCP) still logs.
  (b) a `requests.exceptions.ReadTimeout` — the address answered, only the read half expired —
      must not clear the dial cache the way a connect failure does.
"""
import pytest
import requests

import satellite_client as sc
from vocalis.runtime import satstats


def _client(url='https://test-satellite.invalid:7880'):
    return sc.SatelliteClient('test-satellite', url, b"\x00" * 32)


def test_repeated_connect_failures_to_an_unchanged_address_log_dialing_once(monkeypatch, capsys):
    """The 1 line/s flood this fix exists to stop: a satellite parked at the same address must
    log 'dialing' exactly once across many failed polls, not once per attempt."""
    monkeypatch.setattr(sc, "ipv4_url", lambda url: 'https://192.0.2.182:7880')

    def _boom(*_a, **_k):
        raise requests.exceptions.ConnectionError("connection refused")
    monkeypatch.setattr(requests, "post", _boom)

    client = _client()
    for _ in range(5):
        with pytest.raises(sc.SatelliteUnreachable):
            client._post("/satellite/gpustats", b"{}", 0.2, connect_s=0.2)

    out = capsys.readouterr().out
    assert out.count('dialing https://192.0.2.182:7880') == 1, out


def test_a_read_timeout_does_not_clear_the_dial_cache_or_re_log(monkeypatch, capsys):
    """The address answered — TCP connected — and only the READ half expired. That is not "the
    address moved": the cached dial must survive it, unlike a genuine connect failure."""
    monkeypatch.setattr(sc, "ipv4_url", lambda url: 'https://192.0.2.182:7880')

    def _timeout(*_a, **_k):
        raise requests.exceptions.ReadTimeout("timed out waiting for a reply")
    monkeypatch.setattr(requests, "post", _timeout)

    client = _client()
    with pytest.raises(sc.SatelliteUnreachable):
        client._post("/satellite/gpustats", b"{}", 0.2, connect_s=0.2)
    dial_after_first = client._dial
    assert dial_after_first == 'https://192.0.2.182:7880'

    with pytest.raises(sc.SatelliteUnreachable):
        client._post("/satellite/gpustats", b"{}", 0.2, connect_s=0.2)
    assert client._dial == dial_after_first, (
        "a read timeout must not clear the dial cache the render path shares")

    out = capsys.readouterr().out
    assert out.count("dialing") == 1, (
        "the second attempt reused the cached dial and must not have re-resolved or re-logged")


def test_an_address_change_still_re_resolves_and_logs(monkeypatch, capsys):
    """DHCP moving the box is exactly the case `_forget_dial()` exists for — a genuinely
    different resolved address must still log, even though the unchanged-address case above
    must not."""
    addr = {"v": 'https://192.0.2.182:7880'}
    monkeypatch.setattr(sc, "ipv4_url", lambda url: addr["v"])

    def _boom(*_a, **_k):
        raise requests.exceptions.ConnectionError("connection refused")
    monkeypatch.setattr(requests, "post", _boom)

    client = _client()
    with pytest.raises(sc.SatelliteUnreachable):
        client._post("/satellite/gpustats", b"{}", 0.2, connect_s=0.2)

    addr["v"] = "https://192.0.2.183:7880"          # the satellite's DHCP lease moved
    with pytest.raises(sc.SatelliteUnreachable):
        client._post("/satellite/gpustats", b"{}", 0.2, connect_s=0.2)

    out = capsys.readouterr().out
    assert out.count('dialing https://192.0.2.182:7880') == 1, out
    assert out.count("dialing https://192.0.2.183:7880") == 1, out


# ── the 4 Hz poller's own timeout must never be the ordinary CONNECT_TIMEOUT ──────────────────

def test_gpustats_pins_both_timeout_halves_under_poll_up_s(monkeypatch):
    """`SatelliteClient.gpustats()` uses `GPUSTATS_TIMEOUT` for both halves of its
    `requests.post` timeout are `GPUSTATS_TIMEOUT`, never the ordinary CONNECT_TIMEOUT pairing
    every other verb here uses, because `runtime/satstats.py` polls it at 4 Hz and a dead
    satellite has to fail inside a fraction of one poll interval rather than stalling its own
    poller behind a 5 s CONNECT_TIMEOUT. Captured off `requests.post`'s actual `timeout=` kwarg,
    not off an intermediate method, so a caller that dropped the `connect_s=` override (silently
    falling back to the shared CONNECT_TIMEOUT) is caught here rather than only showing up as a
    dead satellite blocking its own poller for 5 s at a time.

    Removing the `connect_s=GPUSTATS_TIMEOUT` override must make this test fail."""
    captured = {}

    def _fake_post(_url, data=None, headers=None, timeout=None, verify=None, **_kw):
        captured["timeout"] = timeout
        raise requests.exceptions.ConnectionError("simulated — never actually connects")
    monkeypatch.setattr(requests, "post", _fake_post)

    client = sc.SatelliteClient('test-satellite', 'https://192.0.2.182:7880', b"\x00" * 32)
    with pytest.raises(sc.SatelliteUnreachable):
        client.gpustats()

    assert captured["timeout"] == (sc.GPUSTATS_TIMEOUT, sc.GPUSTATS_TIMEOUT), captured
    connect_s, read_s = captured["timeout"]
    assert connect_s < satstats.POLL_UP_S, "the connect half must fail well inside one 4 Hz tick"
    assert read_s < satstats.POLL_UP_S, "the read half must fail well inside one 4 Hz tick"


class _BrokenStream:
    """A 200 reply whose body fails after the headers, the way `iter_content` reports it."""
    status_code = 200
    headers = {"Content-Type": "application/octet-stream"}

    def __init__(self, exc):
        self.exc = exc

    def iter_content(self, chunk_size=None):
        raise self.exc
        yield b""                                           # pragma: no cover — a generator

    def close(self):
        pass


@pytest.mark.parametrize("exc, kind", [
    # A read timeout mid-body: `iter_content` wraps urllib3's ReadTimeoutError in ConnectionError.
    (requests.exceptions.ConnectionError(__import__("urllib3").exceptions.ReadTimeoutError(
        None, None, "Read timed out.")), "SatelliteTimedOut"),
    (requests.exceptions.ChunkedEncodingError("Connection broken: peer closed"), "SatelliteUnreachable"),
], ids=["crawled-part-way", "stopped-part-way"])
def test_a_reply_that_fails_part_way_is_reported_as_the_satellite(monkeypatch, exc, kind):
    """2026-10-22: a satellite that stopped or crawled after its first frame raised a raw
    `requests` error, so the pool kept the worker and retried on it. It is now the same satellite
    error as a failure before the reply: dropped for a survivor, and taken back when it recovers
    (after the five-minute wait when it crawled)."""
    monkeypatch.setattr(sc, "ipv4_url", lambda url: 'https://192.0.2.182:7880')
    monkeypatch.setattr(requests, "post", lambda *a, **k: _BrokenStream(exc))
    status, frames = _client()._post_stream("/satellite/stream", b"{}", sc.READ_TIMEOUT)
    assert status == 200
    with pytest.raises(sc.SatelliteUnreachable) as caught:
        list(frames)
    assert type(caught.value).__name__ == kind


def test_a_plain_reply_that_times_out_after_its_headers_is_timed_out_and_keeps_the_address(
        monkeypatch):
    """`_post` is not streamed: `requests.post` reads the body itself, and a read timeout after
    the headers arrives as a ConnectionError wrapping urllib3's ReadTimeoutError. That is the
    satellite being slow, not gone: SatelliteTimedOut, and the dial cache is not thrown away."""
    import urllib3
    monkeypatch.setattr(sc, "ipv4_url", lambda url: 'https://192.0.2.182:7880')

    def post(*a, **k):
        raise requests.exceptions.ConnectionError(
            urllib3.exceptions.ReadTimeoutError(None, None, "Read timed out."))
    monkeypatch.setattr(requests, "post", post)
    client = _client()
    with pytest.raises(sc.SatelliteTimedOut):
        client._post("/satellite/render", b"{}", sc.READ_TIMEOUT)
    assert client._dial == 'https://192.0.2.182:7880', "a slow satellite keeps its address"
