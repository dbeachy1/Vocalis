"""A pool worker's `RemoteModel` must send each request with the settings saved AT THAT MOMENT
(October 10, 2026).

Seen live: a render satellite on one machine, Vocalis on another. "New secret..." in Settings, the
new secret given to the satellite's setup, and afterwards Settings showed the satellite reachable
with its model loaded (`POST /satellite/load 200`) while every render failed with
`POST /satellite/stream 401` ("rejected our envelope"). `satellites.client_for` had built a new
client with the new secret for health, load and reconnect, but the worker's `RemoteModel` kept the
client it was built with and went on signing with the old secret. The same staleness applied to a
new pinned certificate and to an edited URL.

What is real here: `satellite_client` (the real `RemoteModel` through the real `remote_model`
factory, the real `SatelliteClient`, the real sealing), `vocalis.runtime.satellites` (real
`add`/`regenerate`/`save_cert`/`update`/`remove`/`client_for`) over a real settings file in a temp
folder. The only fake is the HTTP boundary (`requests.post`), standing in for the satellite: it
opens each envelope with the master it accepts and answers 401 when it cannot, exactly as the
satellite does, and it records which master opened every request.
"""
import datetime
import json
import threading

import pytest
import requests

import satellite_client as sc          # puts the satellite folder on sys.path, so this comes first
import vocalis_satellite_protocol as proto
from vocalis.runtime import satellites as sat
from vocalis.runtime import settings

NAME = "workstation"
URL = "https://workstation.invalid:7880"
PCM = b"\x00\x00" * 100                              # 100 samples of silence
OPS = ["stream", "render", "batch", "capacity"]
RENDER_OPS = ["stream", "render", "batch"]


class _Resp:
    """The parts of a `requests.Response` the client reads."""

    def __init__(self, status, blob):
        self.status_code = status
        self.content = blob
        self.headers = {"Content-Type": "application/octet-stream"}
        self.text = ""

    def iter_content(self, chunk_size=None):
        yield self.content

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeSatellite:
    """Stands in for `requests.post`. Knows which masters each base URL accepts."""

    def __init__(self):
        self.accepts = {}                  # base url -> {master bytes}
        self.log = []                      # one dict per request, in order
        self.overrides = {}                # path -> [(status, obj)] consumed first-in first-out
        self.on_request = None             # called with the record, after it is logged
        self.batch_trailer = {"status": "ok"}
        self.cancel_seen = threading.Event()

    def allow(self, base, master):
        self.accepts.setdefault(base, set()).add(bytes(master))

    def paths(self):
        return [r["path"] for r in self.log]

    def masters(self):
        return [r["master"] for r in self.log]

    def post(self, url, data=None, headers=None, timeout=None, verify=None, **kw):
        base, _, rest = url.partition("/satellite/")
        path = "/satellite/" + rest
        salt = bytes.fromhex(headers["X-Vocalis-Salt"])
        used, body = None, None
        for master in self.accepts.get(base, ()):
            try:
                body = proto.open_bytes(proto.derive_key(master, salt, proto.DIR_TO_SATELLITE), data)
                used = master
                break
            except proto.ProtocolError:
                continue
        try:
            parsed = json.loads(body.decode("utf-8")) if body is not None else None
        except ValueError:
            parsed = None                  # the voice upload is raw bytes
        rec = {"base": base, "path": path, "master": used.hex() if used else None,
               "verify": verify, "body": parsed}
        self.log.append(rec)
        if self.on_request is not None:
            self.on_request(rec)
        if used is None:
            return _Resp(401, b"")
        s2k = proto.derive_key(used, salt, proto.DIR_TO_SERVER)
        if self.overrides.get(path):
            status, obj = self.overrides[path].pop(0)
            return _Resp(status, proto.seal_bytes(s2k, json.dumps(obj).encode("utf-8")))
        return _Resp(200, self._reply(path, parsed, s2k))

    def _reply(self, path, body, s2k):
        if path == "/satellite/health":
            return proto.seal_bytes(s2k, json.dumps({
                "sr": 24000, "verbs": ["render", "stream"], "capabilities": ["batch_render"],
                "max_batch": 8, "workers": {"cuda:0": 1}, "satellite_version": "test"}).encode())
        if path == "/satellite/capacity":
            return proto.seal_bytes(s2k, json.dumps({"take": 3}).encode())
        if path == "/satellite/voice":
            return proto.seal_bytes(s2k, json.dumps({"ok": True}).encode())
        if path == "/satellite/cancel":
            self.cancel_seen.set()
            return proto.seal_bytes(s2k, json.dumps({"canceled": True}).encode())
        w = proto.SealedWriter(s2k)
        if path == "/satellite/render" and "chunks" not in (body or {}):
            return w.frame(json.dumps({"sr": 24000}).encode()) + w.frame(PCM) + w.end()
        out = b""
        if path == "/satellite/render":                          # a batch
            for c in body["chunks"]:
                out += w.frame(proto.TAG_HEADER + json.dumps(
                    {"id": c["id"], "samples": 100, "sr": 24000}).encode())
                out += w.frame(proto.TAG_AUDIO + PCM)
        else:                                                    # /satellite/stream
            out += w.frame(proto.TAG_HEADER + json.dumps({"sr": 24000}).encode())
            out += w.frame(proto.TAG_AUDIO + PCM)
        out += w.frame(proto.TAG_TRAILER + json.dumps(self.batch_trailer).encode())
        return out + w.end()


def _pem() -> bytes:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "workstation.invalid")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=30)).sign(key, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM)


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A real settings file and certificate folder in tmp_path, a satellite defined through the
    real `sat.add`, the fake satellite behind `requests.post`, and a `RemoteModel` built by the
    real factory (which calls health, as the pool does)."""
    monkeypatch.setattr(settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    monkeypatch.setattr(sat, "cert_dir", lambda: tmp_path / "certs")
    monkeypatch.setattr(sc, "ipv4_url", lambda url: url)         # the .invalid host has no DNS
    sat.forget()
    server = FakeSatellite()
    monkeypatch.setattr(requests, "post", server.post)
    secret = sat.add(NAME, URL)
    server.allow(URL, bytes.fromhex(secret))
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"RIFF-not-really-a-wav")
    w = type("World", (), {})()
    w.server, w.secret, w.tmp, w.voice = server, secret, tmp_path, voice
    w.model = sc.remote_model(f"{NAME}:cuda:0")
    w.server.log.clear()                                         # the factory's health call
    yield w
    sat.forget()


def _run(model, op, **kw):
    """One request of the named kind. Returns something comparable across the four."""
    if op == "stream":
        return len(list(model.stream("hello there", **kw)))
    if op == "render":
        return tuple(model.generate("hello there", **kw).shape)
    if op == "batch":
        return [cid for cid, _wav in model.generate_batch([("1", "hello there")], **kw)]
    return model.capacity([100])


EXPECT = {"stream": 1, "render": (1, 100), "batch": ["1"], "capacity": 3}


# -- the defect: a rotated secret ----------------------------------------------------------

@pytest.mark.parametrize("op", OPS)
def test_the_next_request_after_New_secret_is_sealed_with_the_NEW_master(world, op):
    """🔴 The defect itself. Before the fix the stream, the render and the batch failed with
    "rejected our envelope" (capacity answers 0 on any SatelliteError) because the worker went on
    signing with the secret it was built with."""
    old = world.secret
    assert _run(world.model, op) == EXPECT[op], "the old secret works until it is rotated"
    assert world.server.masters() == [old]

    new = sat.regenerate(NAME)                                   # the user presses "New secret..."
    world.server.accepts[URL] = {bytes.fromhex(new)}             # the satellite now has only the new one
    assert new != old
    world.server.log.clear()

    assert _run(world.model, op) == EXPECT[op], "the worker kept signing with the old secret"
    assert world.server.masters() == [new]


def test_rotation_is_logged_with_what_changed_and_never_the_secret(world):
    from loguru import logger
    lines = []
    sink = logger.add(lambda m: lines.append(str(m)), level="INFO")
    try:
        new = sat.regenerate(NAME)
        world.server.accepts[URL] = {bytes.fromhex(new)}
        _run(world.model, "render")
        _run(world.model, "render")
    finally:
        logger.remove(sink)
    changed = [ln for ln in lines if "settings changed since this worker's last request" in ln]
    assert len(changed) == 1, "logged once when the client changed, not once per request"
    assert "(secret)" in changed[0]
    assert not any(world.secret in ln or new in ln for ln in lines), "a secret reached the log"


# -- the same staleness for a new pin and a new URL ----------------------------------------------

@pytest.mark.parametrize("op", OPS)
def test_a_new_certificate_is_used_by_the_next_request(world, op):
    assert _run(world.model, op) == EXPECT[op]
    assert world.server.log[-1]["verify"] is True, "no pin yet: default verification"
    world.server.log.clear()

    pinned = sat.save_cert(NAME, _pem())
    expected_pin = str(world.tmp / "certs" / pinned)

    assert _run(world.model, op) == EXPECT[op]
    assert world.server.log[-1]["verify"] == expected_pin, "the worker kept the old (absent) pin"


@pytest.mark.parametrize("op", OPS)
def test_an_edited_url_is_used_by_the_next_request(world, op):
    new_url = "https://workstation2.invalid:7881"
    world.server.allow(new_url, bytes.fromhex(world.secret))
    assert _run(world.model, op) == EXPECT[op]
    assert world.server.log[-1]["base"] == URL
    world.server.log.clear()

    sat.update(NAME, url=new_url)

    assert _run(world.model, op) == EXPECT[op]
    assert {r["base"] for r in world.server.log} == {new_url}, "the worker kept posting to the old URL"


# -- one request stays on one client -------------------------------------------------------------

@pytest.mark.parametrize("op", RENDER_OPS)
def test_a_request_in_flight_keeps_its_client_for_the_retry_and_the_voice_upload(
        world, op, monkeypatch):
    """The satellite asks for the voice (409 need_voice); the secret is rotated while that first
    reply is on its way back. The voice upload and the retry belong to the request that started
    them, so they go out with the OLD secret (which the fake still accepts), and `client_for` is
    asked ONCE for the whole request. The NEXT request then uses the new secret."""
    old = world.secret
    path = "/satellite/stream" if op == "stream" else "/satellite/render"
    world.server.overrides[path] = [(409, {"need_voice": True})]
    rotated = {}

    def rotate_once(rec):
        if rec["path"] == path and not rotated:
            rotated["new"] = sat.regenerate(NAME)
            world.server.allow(URL, bytes.fromhex(rotated["new"]))
    world.server.on_request = rotate_once

    asked = []
    real = sat.client_for
    monkeypatch.setattr(sat, "client_for", lambda n: (asked.append(n), real(n))[1])

    assert _run(world.model, op, audio_prompt_path=str(world.voice)) == EXPECT[op]
    assert world.server.paths() == [path, "/satellite/voice", path]
    assert world.server.masters() == [old, old, old], "the retry or the voice upload switched clients"
    assert asked == [NAME], "client_for must be asked once per request, not once per attempt"

    world.server.log.clear()
    assert _run(world.model, op, audio_prompt_path=str(world.voice)) == EXPECT[op]
    assert set(world.server.masters()) == {rotated["new"]}, "the next request must use the new secret"
    assert asked == [NAME, NAME]


def test_a_cancel_goes_to_the_client_the_request_started_with(world):
    """A batch fails mid-reply (error trailer), which sends a cancel on a daemon thread. The secret
    was rotated while the batch was in flight; the cancel still reaches the satellite with the
    secret of the request it cancels."""
    old = world.secret
    world.server.batch_trailer = {"status": "error", "error": "boom"}

    rotated = {}

    def rotate_once(rec):
        if rec["path"] == "/satellite/render" and not rotated:
            rotated["new"] = sat.regenerate(NAME)
            world.server.allow(URL, bytes.fromhex(rotated["new"]))
    world.server.on_request = rotate_once

    with pytest.raises(sc.SatelliteError, match="boom"):
        list(world.model.generate_batch([("1", "hello there")]))
    assert world.server.cancel_seen.wait(10), "the cancel never reached the satellite"
    cancels = [r for r in world.server.log if r["path"] == "/satellite/cancel"]
    assert len(cancels) == 1
    assert rotated["new"] != old
    assert cancels[0]["master"] == old


def test_the_watcher_cancel_goes_to_the_client_the_request_started_with(world, monkeypatch):
    """The ■ button path: the local cancel Event is set, the watcher thread cancels remotely. The
    watcher is handed the request's client, not the worker's current one."""
    import tts_utils
    seen = []

    class Spy:
        name = NAME

        def cancel(self, request_id):
            seen.append(request_id)
            return True

    ev = threading.Event()
    ev.set()
    monkeypatch.setattr(tts_utils._GEN_CANCEL, "event", ev, raising=False)
    stop, watcher = world.model._cancel_bridge("rid-1", Spy())
    watcher.join(timeout=10)
    stop.set()
    assert seen == ["rid-1"], "the watcher must cancel through the client it was given"
    assert world.server.log == [], "and not through the worker's own current client"


# -- the satellite is gone while the worker still exists ---------------------------------------

@pytest.mark.parametrize("op", OPS)
def test_a_removed_satellite_fails_cleanly_and_sends_nothing(world, op):
    sat.remove(NAME)
    if op == "capacity":
        assert world.model.capacity([100]) == 0, "capacity answers 0 on any SatelliteError"
    else:
        with pytest.raises(sc.SatelliteError, match="no satellite named 'workstation'"):
            _run(world.model, op)
    assert world.server.log == [], "nothing may go out for a satellite that is no longer configured"


@pytest.mark.parametrize("op", RENDER_OPS)
def test_a_satellite_with_no_secret_fails_cleanly(world, op):
    s = settings.load_app_settings()
    s["satellites"][0]["secret"] = ""
    settings.save_app_settings(s)
    sat.forget()
    with pytest.raises(sc.SatelliteError, match="no shared secret"):
        _run(world.model, op)
    assert world.server.log == []


@pytest.mark.parametrize("op", RENDER_OPS)
def test_a_secret_that_is_not_hex_is_a_SatelliteError_not_a_crash(world, op):
    """`client_for` does `bytes.fromhex(secret)`; a hand-edited settings file must not kill the
    worker thread with a ValueError."""
    s = settings.load_app_settings()
    s["satellites"][0]["secret"] = "not-hex-at-all"
    settings.save_app_settings(s)
    sat.forget()
    with pytest.raises(sc.SatelliteError, match="could not build a client"):
        _run(world.model, op)
    assert world.server.log == []


# -- no change for a RemoteModel built without a registry --------------------------------------

def test_a_model_built_by_hand_uses_the_client_it_was_given():
    class C:
        name = "x"
    c = C()
    m = sc.RemoteModel(c, "cuda:0", 24000)
    assert m.current_client() is c


# -- the wording -------------------------------------------------------------------------------

EXPECTED_TAIL = ('The shared secret does not match. Press "New secret…" on this satellite\'s row '
                 'in Settings, then give the new secret to the satellite: its setup file with '
                 '--new-secret (Docker), or setup.py (source install).')


@pytest.mark.parametrize("verb", ["health", "stream", "render_batch"])
def test_the_401_message_tells_a_docker_user_what_to_do(world, verb):
    """`health` goes through `_post`; `stream` and `render_batch` through `_post_stream`. The
    client here holds a secret the fake satellite does not accept."""
    wrong = sc.SatelliteClient(NAME, URL, b"\x09" * 32)
    with pytest.raises(sc.SatelliteError) as exc:
        if verb == "health":
            wrong.health()
        elif verb == "stream":
            wrong.stream("rid", "hello", "")
        else:
            wrong.render_batch("rid", [{"id": "1", "text": "hello"}], "")
    assert str(exc.value) == f"satellite {NAME!r} rejected our envelope. {EXPECTED_TAIL}"
    assert "re-run setup.py there" not in str(exc.value)
