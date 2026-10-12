"""3.0-M3: /speak/stream HTTP endpoints (register + one-time progressive stream).

Generation is faked (stream_message monkeypatched to yield PCM chunks); ffmpeg is
real, so these tests also prove the PCM->MP3 pipe. No GPU.
"""
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import mp3_render                                          # noqa: E402
import vocalis_stream_http as vsh                          # noqa: E402


def _is_mp3(b: bytes) -> bool:
    """Encoded-MP3 sniff: ID3v2 header or an MPEG frame-sync byte pair. The cache
    stores the ffmpeg-encoded stream bytes since 3.x (was PCM WAV)."""
    return b[:3] == b"ID3" or (len(b) > 1 and b[0] == 0xFF and (b[1] & 0xE0) == 0xE0)
from nomi_speak import NomiSpeaker                         # noqa: E402
from tts_utils import VocalisError                         # noqa: E402

SR = 24000


class FakePool:
    sr = SR


def _mk_app(tmp_path, monkeypatch, chunks=3, chunk_samples=12000, fail_at=None,
            pool_error=False):
    (tmp_path / "voice_samples").mkdir()
    (tmp_path / "voice_samples" / "v.wav").write_bytes(b"RIFFfake")
    # ONE settings file (3.x): the nomi section holds the map/default; the ST
    # registry persists its characters into the sillytavern section below.
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text("nomi:\n  default_voice: v.wav\n", encoding="utf-8")
    nomi = NomiSpeaker(settings, tmp_path / "voice_samples", tmp_path / "cache")

    # 11.2 — `st_speech` is recorded, not just swallowed by `**kw`. It is the one argument here
    # that crosses three files to get this far (the register writes it onto the token's entry,
    # the serve path reads it back onto `Mp3Render`, `Mp3Render` passes it down), and a flag that
    # is dropped anywhere along that chain leaves the SillyTavern batch ceiling reading as a
    # setting that saves and does nothing.
    calls = {"n": 0, "st_speech": []}
    def fake_stream_message(pool, text, params, config=None, cancel=None, **kw):
        calls["n"] += 1
        calls["st_speech"].append(kw.get("st_speech"))
        for j in range(chunks):
            if fail_at is not None and j == fail_at:
                raise RuntimeError("gen boom")
            yield (np.ones(chunk_samples, dtype=np.float32) * 0.1 * (j + 1))
    # 5.2: generation moved out of the route and into mp3_render.Mp3Render, so the
    # fake belongs where the real one is now imported. Patching `vsh` still "worked"
    # in the sense that nothing errored — it just silently stopped being used, which
    # would have run every one of these tests against the real chatterbox pool.
    monkeypatch.setattr(mp3_render, "stream_message", fake_stream_message)

    def current_pool():
        if pool_error:
            raise VocalisError("no workers")
        return FakePool()

    # Mirror production's /v1 hooks (vocalis_server.py): stem resolver over
    # voice_samples/.
    vdir = tmp_path / "voice_samples"
    def resolve_voice(name):
        leaf = Path(name).name
        exact = vdir / leaf
        if exact.exists() and exact.is_file():
            return exact
        stem = Path(leaf).stem.lower()
        matches = [f for f in vdir.iterdir() if f.is_file() and f.stem.lower() == stem]
        return matches[0] if matches else None

    # ST character registry with one pre-assigned character (mirrors prod wiring)
    from st_characters import StCharacterRegistry
    streg = StCharacterRegistry(settings)
    streg.replace({'Test Character': {"voice": "v.wav", "exaggeration": 0.9, "cfg": 0.2,
                                 "temperature": 0.6, "seed": 42, "turbo": True}})   # stale keys: dropped

    app = Flask(__name__)
    # Mirror production's app-level CORS (vocalis_server.py): the r"/speak.*" and
    # r"/v1/*" regex rules own CORS for these routes; the blueprint carries none.
    from flask_cors import CORS
    CORS(app, resources={r"/speak.*": {"origins": "*"}, r"/v1/*": {"origins": "*"}},
         expose_headers=["X-Cache-Key"])
    app.register_blueprint(vsh.create_stream_blueprint(
        current_pool, nomi, voice_dir=tmp_path / "voice_samples",
        resolve_voice=resolve_voice, st_registry=streg))
    app.vocalis_st_registry = streg                            # test hook
    return app.test_client(), nomi, calls


def nomi_cpath(nomi, key, nomi_id="1"):
    """Where a Nomi's cache entry lands (5.3.3). The cache is scoped per speaker now, so a bare
    `cache_path(key)` points at the pre-5.3.3 flat layout that nothing writes."""
    return nomi.cache_path(key, f"nomi:{nomi_id}")


def st_cpath(nomi, key, character=""):
    """Same, for the /v1 SillyTavern path. These tests send no `character`, which is its own
    speaker — one shared bucket for requests that carry no identity."""
    return nomi.cache_path(key, f"st:{character}")


def _register(client, text="Hello streaming world.", force=False):
    r = client.post("/speak/stream", json={"nomi_id": "1", "nomi_name": "Test",
                                           "text": text, "force": force})
    return r


def test_post_registers_and_returns_url(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    r = _register(client)
    assert r.status_code == 200
    body = r.get_json()
    assert body["stream_url"].startswith("/speak/stream/")
    assert body["cached"] is False
    assert r.headers["X-Cache-Key"] == body["cache_key"]


def test_post_empty_text_400(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    r = client.post("/speak/stream", json={"nomi_id": "1", "text": "   "})
    assert r.status_code == 400


def test_get_streams_mp3(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    url = _register(client).get_json()["stream_url"]
    r = client.get(url)
    assert r.status_code == 200
    assert r.mimetype == "audio/mpeg"
    data = r.data
    assert len(data) > 1000
    assert data[:3] == b"ID3" or data[0] == 0xFF          # ID3 tag or bare frame sync


def test_cache_tee_then_cached_hit(tmp_path, monkeypatch):
    client, nomi, calls = _mk_app(tmp_path, monkeypatch)
    first = _register(client)
    key = first.get_json()["cache_key"]
    client.get(first.get_json()["stream_url"]).data       # consume the stream fully
    # tee runs in the writer thread; give it a beat
    cpath = nomi_cpath(nomi, key)
    for _ in range(50):
        if cpath.exists():
            break
        time.sleep(0.1)
    assert cpath.exists() and cpath.suffix == ".mp3" and _is_mp3(cpath.read_bytes())
    # replay: POST reports cached, GET serves the whole MP3 instantly
    again = _register(client)
    assert again.get_json()["cached"] is True
    r2 = client.get(again.get_json()["stream_url"])
    assert r2.mimetype == "audio/mpeg"
    assert _is_mp3(r2.data)
    assert calls["n"] == 1                                 # no second generation


def test_unknown_token_410(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    assert client.get("/speak/stream/deadbeef").status_code == 410


def test_custom_make_stream_source(tmp_path, monkeypatch):
    """bp.register_stream + entry['make_stream'] (the playground hook): a custom
    PCM source rides the same token/ffmpeg/status transport with its own cancel
    Event, the default stream_message is NOT used, and there is no cache tee."""
    client, _, calls = _mk_app(tmp_path, monkeypatch)
    bp = client.application.blueprints["vocalis_stream"]
    saw = {}

    def make(pool, cancel, cfg):
        def gen():
            saw["pool_sr"] = pool.sr
            yield np.ones(4800, dtype=np.float32) * 0.2
            yield np.ones(4800, dtype=np.float32) * 0.3
        return gen()

    cancel = threading.Event()
    tok = bp.register_stream({"nomi_name": "playground", "cancel": cancel,
                              "make_stream": make})
    r = client.get(f"/speak/stream/{tok}")
    assert r.status_code == 200 and r.mimetype == "audio/mpeg"
    assert len(r.data) > 200 and _is_mp3(r.data)
    assert saw["pool_sr"] == SR                       # the shared pool was handed in
    assert calls["n"] == 0                            # default source untouched
    st = client.get(f"/speak/stream/{tok}/status").get_json()
    assert st["state"] == "done" and st["error"] is None
    time.sleep(0.2)
    assert not list((tmp_path / "cache").rglob("*.mp3"))   # no tee for custom sources


def test_force_streams_even_when_cached(tmp_path, monkeypatch):
    client, nomi, _ = _mk_app(tmp_path, monkeypatch)
    first = _register(client)
    client.get(first.get_json()["stream_url"]).data
    key = first.get_json()["cache_key"]
    for _ in range(50):
        if nomi_cpath(nomi, key).exists():
            break
        time.sleep(0.1)
    forced = _register(client, force=True)
    assert forced.get_json()["cached"] is False
    r = client.get(forced.get_json()["stream_url"])
    assert r.mimetype == "audio/mpeg"                      # regenerated, not the WAV


def test_model_unavailable_503(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch, pool_error=True)
    url = _register(client).get_json()["stream_url"]
    assert client.get(url).status_code == 503


def test_midstream_failure_no_cache_tee(tmp_path, monkeypatch):
    client, nomi, _ = _mk_app(tmp_path, monkeypatch, fail_at=2)
    reg = _register(client)
    key = reg.get_json()["cache_key"]
    r = client.get(reg.get_json()["stream_url"])
    r.data                                                 # drain what arrived
    time.sleep(0.5)
    assert not nomi_cpath(nomi, key).exists()               # incomplete: never cached


def test_cors_preflight_and_response_headers(tmp_path, monkeypatch):
    """The extension POSTs cross-origin from nomi.ai: the preflight OPTIONS and
    the POST itself must both carry Access-Control-Allow-Origin. (Regression:
    the app-level r"/speak" rule does NOT cover /speak/stream — exact-path
    match — so the blueprint carries its own CORS.)"""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    pre = client.options("/speak/stream", headers={
        "Origin": "https://beta.nomi.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert pre.headers.get("Access-Control-Allow-Origin")
    r = client.post("/speak/stream",
                    json={"nomi_id": "1", "nomi_name": "T", "text": "hi there"},
                    headers={"Origin": "https://beta.nomi.ai"})
    acao = r.headers.getlist("Access-Control-Allow-Origin")
    assert len(acao) == 1                       # present, and never duplicated


def _registry(client):
    return client.application.blueprints["vocalis_stream"].vocalis_registry


def test_pool_unavailable_does_not_burn_token(tmp_path, monkeypatch):
    """Regression (review): a 503 must reset the one-time token to retryable."""
    client, _, _ = _mk_app(tmp_path, monkeypatch, pool_error=True)
    url = _register(client).get_json()["stream_url"]
    assert client.get(url).status_code == 503
    tok = url.rsplit("/", 1)[1]
    assert _registry(client)[tok]["state"] == "new"        # un-burned


def test_force_second_get_never_serves_stale(tmp_path, monkeypatch):
    """Regression (review): a re-GET during an in-flight FORCE regeneration must
    410, not serve the stale pre-existing cache file — INCLUDING the window where
    playback finished (state 'done') but the new file has not been PROMOTED yet.
    The serve gate keys on `promoted` (atomic_replace landed), not state=='done'."""
    client, nomi, _ = _mk_app(tmp_path, monkeypatch)
    # seed the cache with a completed render
    first = _register(client)
    client.get(first.get_json()["stream_url"]).data
    key = first.get_json()["cache_key"]
    for _ in range(50):
        if nomi_cpath(nomi, key).exists():
            break
        time.sleep(0.1)
    # register force; simulate GET #1 mid-regen by claiming the token
    forced = _register(client, force=True)
    tok = forced.get_json()["stream_url"].rsplit("/", 1)[1]
    _registry(client)[tok]["state"] = "live"
    r = client.get(forced.get_json()["stream_url"])
    assert r.status_code == 410                            # mid-regen: never the stale WAV
    # playback done but the new file has NOT promoted yet — must STILL not serve stale
    _registry(client)[tok]["state"] = "done"
    assert client.get(forced.get_json()["stream_url"]).status_code == 410
    # only once the tee is actually promoted does the re-GET serve the fresh file
    _registry(client)[tok]["promoted"] = True
    r2 = client.get(forced.get_json()["stream_url"])
    assert r2.status_code == 200 and _is_mp3(r2.data)


def test_prune_spares_live_tokens(tmp_path, monkeypatch):
    """Regression (review): TTL pruning must not delete tokens of streams that
    are still serving (>120s messages)."""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    url = _register(client).get_json()["stream_url"]
    tok = url.rsplit("/", 1)[1]
    reg = _registry(client)
    reg[tok]["state"] = "live"
    reg[tok]["created"] -= 10_000                          # ancient
    _register(client)                                      # any request runs _prune
    assert tok in reg                                      # live: spared
    reg[tok]["state"] = "done"
    _register(client)
    assert tok not in reg                                  # done + expired: pruned


# ── /webui/stream + /status (web-UI streaming + truncation check) ──────────────

def _register_webui(client, **over):
    body = {"text": "Audition me please.", "voice": "v.wav",
            "exaggeration": 0.6, "cfg": 0.4, "temperature": 0.9, "seed": 7,
            "turbo": True, "gpus": "0"}      # turbo/gpus/seed ignored (seed: stale clients)
    body.update(over)
    return client.post("/webui/stream", json=body)


def test_webui_stream_plays_and_reports_done(tmp_path, monkeypatch):
    client, nomi, _ = _mk_app(tmp_path, monkeypatch)
    reg = _register_webui(client)
    assert reg.status_code == 200
    body = reg.get_json()
    r = client.get(body["stream_url"])
    assert r.status_code == 200 and r.mimetype == "audio/mpeg"
    assert len(r.data) > 1000
    # ephemeral: nothing written into the MD5 cache (either format era)
    time.sleep(0.3)
    assert not list((tmp_path / "cache").rglob("*.mp3"))
    assert not list((tmp_path / "cache").rglob("*.wav"))
    # status: verified complete
    st = client.get(body["status_url"]).get_json()
    assert st["state"] == "done" and st["error"] is None


def test_webui_stream_unknown_voice_400(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    assert _register_webui(client, voice="nope.wav").status_code == 400


def test_webui_stream_bare_stem_resolves(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    assert _register_webui(client, voice="v").status_code == 200


def test_status_error_after_midstream_failure(tmp_path, monkeypatch):
    """The truncation check: a stream that dies mid-generation reports 'error'."""
    client, _, _ = _mk_app(tmp_path, monkeypatch, fail_at=2)
    body = _register_webui(client).get_json()
    client.get(body["stream_url"]).data                    # drain the broken stream
    for _ in range(50):
        st = client.get(body["status_url"]).get_json()
        if st["state"] != "live":
            break
        time.sleep(0.1)
    assert st["state"] == "error" and "boom" in (st["error"] or "")


def test_status_unknown_token(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    st = client.get("/speak/stream/deadbeef/status").get_json()
    assert st["state"] == "unknown"


def test_stream_player_js_served(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    r = client.get("/webui/stream_player.js")
    assert r.status_code == 200
    assert b"VocalisStreamPlayer" in r.data


# ── /v1/audio/stream (SillyTavern extension register, 3.0-M4) ──────────────────

def test_v1_stream_register_and_play(tmp_path, monkeypatch):
    client, nomi, calls = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json={"input": "Hello from ST.", "voice": "v"})
    assert reg.status_code == 200
    body = reg.get_json()
    assert body["stream_url"].startswith("/speak/stream/")
    assert body["cached"] is False
    r = client.get(body["stream_url"])
    assert r.status_code == 200 and r.mimetype == "audio/mpeg"
    assert len(r.data) > 1000
    st = client.get(body["status_url"]).get_json()
    assert st["state"] == "done" and st["error"] is None
    # CACHED like /speak (re-clicking a message is the common case): the tee
    # lands, and an identical re-register replays the whole WAV instantly.
    cpath = st_cpath(nomi, body["cache_key"])
    for _ in range(50):
        if cpath.exists():
            break
        time.sleep(0.1)
    assert cpath.exists()
    again = client.post("/v1/audio/stream", json={"input": "Hello from ST.", "voice": "v"})
    assert again.get_json()["cached"] is True
    r2 = client.get(again.get_json()["stream_url"])
    assert r2.mimetype == "audio/mpeg" and _is_mp3(r2.data)
    assert calls["n"] == 1                                 # no second generation


def test_only_the_sillytavern_register_marks_its_stream_as_st_speech(tmp_path, monkeypatch):
    """🔴 11.2 — THE JOIN, ASSERTED AT THE FAR END OF IT. `/speak/stream/<token>` serves Nomi, the
    web UI, the playground and SillyTavern from ONE function, so the only thing that can tell them
    apart down there is what the register wrote onto the entry. The SillyTavern batch ceiling keys
    on that flag, and a unit test of the pool cannot see whether anything sets it.

    The negative arms are the half that matters: Nomi speech and a web-UI audition are both
    INTERACTIVE and both stream, so a flag derived from the priority — or set in the shared serve
    path instead of the register — would look identical to this on the SillyTavern arm alone.
    """
    client, _, calls = _mk_app(tmp_path, monkeypatch)
    st = client.post("/v1/audio/stream", json={"input": "Hello from ST.", "voice": "v"}).get_json()
    client.get(st["stream_url"])
    assert calls["st_speech"] == [True], "a SillyTavern stream must carry the flag"

    client.get(_register(client, text="Hello from Nomi.").get_json()["stream_url"])
    client.get(_register_webui(client, text="Hello from the web UI.").get_json()["stream_url"])
    assert calls["st_speech"] == [True, False, False], \
        f"Nomi and the web UI must NOT be capped by a SillyTavern setting: {calls['st_speech']}"


def test_v1_stream_empty_input_400(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/stream", json={"input": "   "})
    assert r.status_code == 400
    assert r.get_json()["error"]["type"] == "invalid_request_error"   # OpenAI shape


def test_v1_stream_unknown_voice_400(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/stream", json={"input": "hi", "voice": "nope"})
    assert r.status_code == 400
    assert "unknown voice" in r.get_json()["error"]["message"]


def test_v1_stream_default_voice_is_concrete(tmp_path, monkeypatch):
    """No voice anywhere uses the Nomi map's default_voice, a concrete file. A None voice can
    inherit different worker state between chunks, so the route must resolve it before streaming."""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json={"input": "hi there"})
    assert reg.status_code == 200
    tok = reg.get_json()["stream_url"].rsplit("/", 1)[1]
    assert _registry(client)[tok]["gen_kwargs"]["voice"].endswith("v.wav")


def test_v1_stream_voice_mtime_bump_busts_cache(tmp_path, monkeypatch):
    """The Clear-cached button's mechanism: bumping the voice file's mtime
    re-keys every cached render for that voice, so an identical re-register
    goes back to MISS (fresh render) instead of replaying stale audio."""
    import os
    client, nomi, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json={"input": "bust me", "voice": "v"})
    client.get(reg.get_json()["stream_url"]).data          # render + tee
    cpath = nomi_cpath(nomi, reg.get_json()["cache_key"])
    for _ in range(50):
        if cpath.exists():
            break
        time.sleep(0.1)
    assert client.post("/v1/audio/stream",
                       json={"input": "bust me", "voice": "v"}).get_json()["cached"] is True
    vfile = tmp_path / "voice_samples" / "v.wav"
    st = vfile.stat()
    os.utime(vfile, (st.st_atime + 10, st.st_mtime + 10))  # the clear_cache route's move
    again = client.post("/v1/audio/stream", json={"input": "bust me", "voice": "v"})
    assert again.get_json()["cached"] is False             # re-keyed: fresh render
    assert again.get_json()["cache_key"] != reg.get_json()["cache_key"]


def test_v1_stream_st_default_beats_nomi_default(tmp_path, monkeypatch):
    """The SillyTavern tab's own default voice outranks the Nomi map's."""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    (tmp_path / "voice_samples" / "other.wav").write_bytes(b"RIFFfake")
    client.application.vocalis_st_registry.set_default("other.wav")
    reg = client.post("/v1/audio/stream", json={"input": "hi there"})
    tok = reg.get_json()["stream_url"].rsplit("/", 1)[1]
    assert _registry(client)[tok]["gen_kwargs"]["voice"].endswith("other.wav")


def test_v1_stream_voice_only_uses_chatterbox_defaults(tmp_path, monkeypatch):
    """No character (or an unassigned one) means chatterbox defaults — there is
    NO per-voice fallback anymore (settings are per-entity, 3.x refactor)."""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json={"input": "hi", "voice": "v"})
    gk = _registry(client)[reg.get_json()["stream_url"].rsplit("/", 1)[1]]["gen_kwargs"]
    assert gk["exaggeration"] == 0.5 and gk["cfg"] == 0.5 and gk["temperature"] == 0.8
    assert "seed" not in gk                       # seedless (3.x)
    assert gk["voice"].endswith("v.wav")


def test_v1_stream_character_assignment(tmp_path, monkeypatch):
    """A character with a server-side assignment gets its voice AND its own
    stored params (the only source of stream params besides the defaults)."""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream",
                      json={"input": "hi", "character": 'Test Character'})
    assert reg.status_code == 200
    gk = _registry(client)[reg.get_json()["stream_url"].rsplit("/", 1)[1]]["gen_kwargs"]
    assert gk["voice"].endswith("v.wav")
    assert gk["exaggeration"] == 0.9 and gk["cfg"] == 0.2       # character, not tuned
    assert gk["temperature"] == 0.6 and "seed" not in gk


def test_v1_stream_unknown_character_auto_registers(tmp_path, monkeypatch):
    """An unseen character name is upserted (assignable in the web UI later)
    and speaks with the CONCRETE default voice."""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream",
                      json={"input": "hi", "character": "Newcomer"})
    assert reg.status_code == 200
    tok = reg.get_json()["stream_url"].rsplit("/", 1)[1]
    assert _registry(client)[tok]["gen_kwargs"]["voice"].endswith("v.wav")
    entry = client.application.vocalis_st_registry.lookup("Newcomer")
    assert entry is not None and entry["voice"] == ""


def test_v1_stream_explicit_voice_beats_character(tmp_path, monkeypatch):
    """Explicit `voice` in the body wins over the character's assignment, but
    the character's stored params still apply."""
    client, nomi, _ = _mk_app(tmp_path, monkeypatch)
    (tmp_path / "voice_samples" / "other.wav").write_bytes(b"RIFFfake")
    reg = client.post("/v1/audio/stream",
                      json={"input": "hi", "character": 'Test Character', "voice": "other"})
    gk = _registry(client)[reg.get_json()["stream_url"].rsplit("/", 1)[1]]["gen_kwargs"]
    assert gk["voice"].endswith("other.wav")
    assert gk["exaggeration"] == 0.9                             # character params kept


def test_v1_stream_cors(tmp_path, monkeypatch):
    """The ST extension runs browser-side and POSTs cross-origin: preflight and
    POST must carry ACAO. Prod's r"/v1/*" IS a regex (the '*') so it
    prefix-matches deep paths — unlike the bare-string exact-match trap that
    bit /speak/stream and /health."""
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    pre = client.options("/v1/audio/stream", headers={
        "Origin": "https://app.example.invalid:8000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert pre.headers.get("Access-Control-Allow-Origin")
    r = client.post("/v1/audio/stream", json={"input": "hi"},
                    headers={"Origin": "https://app.example.invalid:8000"})
    acao = r.headers.getlist("Access-Control-Allow-Origin")
    assert len(acao) == 1


def test_concurrent_stream_cap_503s_and_recovers(tmp_path, monkeypatch):
    """Regression (review #46): concurrent live streams are bounded. At capacity a
    stream GET returns 503 with the token un-burned (retryable), and once a slot frees
    it serves again. Cache hits don't consume slots (they return before acquiring)."""
    import vocalis_stream_http as vsh
    client, nomi, _ = _mk_app(tmp_path, monkeypatch)
    # drain every stream slot (as if MAX concurrent streams are already live)
    held = 0
    while vsh._stream_slots.acquire(blocking=False):
        held += 1
    assert held >= 1
    try:
        reg = _register(client)
        r = client.get(reg.get_json()["stream_url"])
        assert r.status_code == 503                        # at capacity
        tok = reg.get_json()["stream_url"].rsplit("/", 1)[1]
        assert _registry(client)[tok]["state"] == "new"    # un-burned -> retryable
    finally:
        for _ in range(held):
            vsh._stream_slots.release()
    # slots free again: a fresh stream serves, and draining it releases its slot
    r2 = client.get(_register(client).get_json()["stream_url"])
    assert r2.status_code == 200
    r2.data                                                # exhaust -> mp3_stream finally releases
    for _ in range(vsh.MAX_CONCURRENT_STREAMS):             # all slots must be back
        assert vsh._stream_slots.acquire(blocking=False)
    for _ in range(vsh.MAX_CONCURRENT_STREAMS):
        vsh._stream_slots.release()
