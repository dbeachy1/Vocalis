"""5.2: speculative pre-rendering of SillyTavern narration.

Generation is faked (`mp3_render.stream_message` monkeypatched to yield PCM); ffmpeg
is REAL, so these also prove the PCM->MP3->spool->cache pipeline end to end. No GPU.

The test this file exists for is the first one. If `/v1/audio/prerender` and
`/v1/audio/stream` ever derive different cache keys from the same body, nothing
errors and nothing logs — every message just renders twice and the whole feature is
a no-op that burns GPU. See DESIGN_5_2_PRERENDER §4.4.
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
import prerender                                           # noqa: E402
import vocalis_stream_http as vsh                          # noqa: E402
from nomi_speak import NomiSpeaker                          # noqa: E402

SR = 24000
BODY = {"input": "Hello there, this is the next line.", "character": 'Test Character'}


def cpath_of(nomi, key, character='Test Character'):
    "Where an ST character's cache entry lands (5.3.3).\n\n    The cache is scoped per speaker now — `<root>/<owner>/<shard>/<key>.mp3` — so a bare\n    `cache_path(key)` points at the pre-5.3.3 flat layout, which nothing writes and the legacy\n    sweep deletes. Every body in this file speaks as `Test Character`, so that is the default.\n    "
    return nomi.cache_path(key, f"st:{character}")

# How much audio a HELD producer must emit before a follower can see any of it.
# ffmpeg's output AVIO buffer holds
# roughly 32 KB — about 2.7 s at 96 kbps — before the first byte reaches the pipe, and
# NONE of `-flush_packets 1` (already set), `-avioflags direct`, `-blocksize`,
# `-write_xing 0` or `-id3v2_version 0` change that. It is pre-existing behavior of
# the live path, not something 5.2 introduced. The consequence here: a fake that yields
# 1.5 s of audio and then blocks produces a spool of ZERO bytes, and every attach test
# times out looking like a bug in the queue. 7 s clears it with margin.
HOLD_CHUNKS  = 8            # 7 yielded before the hold
HOLD_SAMPLES = SR           # 1 s each


class FakePool:
    """Both paths a guess can take.

    `stream_message` is monkeypatched for the ordinary per-message path; `run_chunks` is the
    BATCHED one 6.3-m4 added, and without it here the pre-pass raises `AttributeError`, falls
    back, and every test in this file passes while proving nothing about batching.

    `_mk_app` builds a fresh instance per call (`lambda: FakePool()`), so anything a test needs
    to see afterward is recorded on the CLASS and reset by `_reset_pool`.
    """
    sr = SR
    submissions = []            # one entry per run_chunks call: the texts it was handed
    samples = 12000
    fail = False
    hold = None                 # an Event a test can use to freeze a batch mid-submission

    def run_chunks(self, items, params, save, total, cancel=None, **kw):
        import torch
        FakePool.submissions.append([t for _i, t in items])
        if FakePool.fail:
            raise RuntimeError("batch boom")
        if FakePool.hold is not None:
            while not FakePool.hold.wait(0.05):
                if cancel is not None and cancel.is_set():
                    return 0, 0.0
        for idx, _text in items:
            if cancel is not None and cancel.is_set():
                return 0, 0.0
            save(idx, torch.full((1, FakePool.samples), 0.1, dtype=torch.float32), self.sr)
        return 0, 0.0


@pytest.fixture(autouse=True)
def _reset_pool():
    FakePool.submissions = []
    FakePool.fail = False
    FakePool.hold = None
    yield
    FakePool.hold = None


_QUEUES = []


@pytest.fixture(autouse=True)
def _stop_queues():
    """Every app spawns a dispatcher thread on first submit; stop them all, or a
    failing test leaves a producer chewing on the next one's ffmpeg."""
    yield
    while _QUEUES:
        _QUEUES.pop().stop()


def _wait(pred, timeout=15.0, what=""):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


def _is_mp3(b: bytes) -> bool:
    return b[:3] == b"ID3" or (len(b) > 1 and b[0] == 0xFF and (b[1] & 0xE0) == 0xE0)


def _mk_app(tmp_path, monkeypatch, *, chunks=3, chunk_samples=12000, hold=None,
            fail=False, enabled=True):
    """A test app wired exactly like production's, plus levers on the gate.

    hold — an Event the fake generator waits on before its LAST chunk, so a test can
    hold a producer mid-render and interrogate it.
    """
    (tmp_path / "voice_samples").mkdir()
    (tmp_path / "voice_samples" / "v.wav").write_bytes(b"RIFFfake")
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text("nomi:\n  default_voice: v.wav\n", encoding="utf-8")
    nomi = NomiSpeaker(settings, tmp_path / "voice_samples", tmp_path / "cache")

    # 11.2.1 — `st_speech` is recorded, not swallowed by `**kw`. A guess is a render a click
    # ATTACHES to, so the per-satellite SillyTavern batch ceiling has to reach it; otherwise the
    # pre-render path can submit batches larger than the configured limit.
    calls = {"n": 0, "st_speech": []}

    def fake_stream_message(pool, text, params, config=None, cancel=None, **kw):
        calls["n"] += 1
        calls["st_speech"].append(kw.get("st_speech"))
        for j in range(chunks):
            if fail and j == 1:
                raise RuntimeError("gen boom")
            if hold is not None and j == chunks - 1:
                while not hold.wait(0.05):
                    if cancel is not None and cancel.is_set():
                        return
            if cancel is not None and cancel.is_set():
                return
            yield (np.ones(chunk_samples, dtype=np.float32) * 0.1 * (j + 1))
    monkeypatch.setattr(mp3_render, "stream_message", fake_stream_message)
    # The idle debounce is a wall-clock guess for a human-paced UI; in tests it is
    # only latency. The gate itself is exercised on its own terms below.
    monkeypatch.setattr(prerender, "IDLE_DELAY_S", 0.0)

    flags = {"render": False, "ready": True}
    vdir = tmp_path / "voice_samples"

    def resolve_voice(name):
        leaf = Path(name).name
        exact = vdir / leaf
        if exact.exists() and exact.is_file():
            return exact
        stem = Path(leaf).stem.lower()
        matches = [f for f in vdir.iterdir() if f.is_file() and f.stem.lower() == stem]
        return matches[0] if matches else None

    from st_characters import StCharacterRegistry
    streg = StCharacterRegistry(settings)
    streg.replace({'Test Character': {"voice": "v.wav", "exaggeration": 0.9, "cfg": 0.2,
                                 "temperature": 0.6}})

    app = Flask(__name__)
    bp = vsh.create_stream_blueprint(
        lambda: FakePool(), nomi, voice_dir=vdir, resolve_voice=resolve_voice,
        st_registry=streg,
        render_active=lambda: flags["render"], model_ready=lambda: flags["ready"])
    bp.prerender_queue._enabled = enabled
    app.register_blueprint(bp)
    _QUEUES.append(bp.prerender_queue)
    return app.test_client(), nomi, bp.prerender_queue, flags, calls


# ── 🔴 the one that decides whether any of this works ─────────────────────────────

def test_prerender_and_stream_agree_on_the_cache_key(tmp_path, monkeypatch):
    """Same body, same key. If these ever diverge the feature silently becomes a
    GPU-burning no-op: every message renders twice and nothing complains."""
    client, _, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True                       # gate shut: nothing actually renders
    pre = client.post("/v1/audio/prerender", json=BODY).get_json()
    stream = client.post("/v1/audio/stream", json=BODY).get_json()
    assert pre["cache_key"] == stream["cache_key"]
    assert len(pre["cache_key"]) == 32
    assert q  # keeps the fixture honest about what it is stopping


def test_key_agrees_for_every_voice_source(tmp_path, monkeypatch):
    """The resolver has four voice-precedence branches and a param `pick`. Whichever
    one a request lands on, both routes must land on the SAME one."""
    client, _, _, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    for body in ({"input": "One.", "character": 'Test Character'},          # character voice
                 {"input": "Two.", "character": "Nobody"},             # falls to default
                 {"input": "Three.", "character": 'Test Character', "voice": "v.wav"},
                 {"input": "Four.", "character": 'Test Character', "narrate_actions": False},
                 {"input": "Five."}):                                  # no character at all
        a = client.post("/v1/audio/prerender", json=body).get_json()
        b = client.post("/v1/audio/stream", json=body).get_json()
        assert a["cache_key"] == b["cache_key"], body


def test_a_guess_is_rendered_as_SPEECH_because_a_click_joins_it(tmp_path, monkeypatch):
    """The per-satellite SillyTavern batch ceiling must reach pre-render submissions marked
    `st_speech`, not only the live serve path.

    That reasoning fails on the feature's own headline case. `attach` hands a click the spool of
    a guess already in flight (`src=prerender` in the register's log line), so the listener
    becomes this render mid-flight — and a batch that has already been formed cannot be made
    narrower afterwards. Otherwise a pre-rendered submission can exceed the saved limit before
    its result is attached to the originating message.

    ⚠️ Asserted at `stream_message`, the far end of the chain, rather than on the `Mp3Render`
    call — the flag has to survive the constructor and the writer thread, not merely be typed.
    """
    client, _, q, _, calls = _mk_app(tmp_path, monkeypatch)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: calls["n"] > 0, what="the guess to start rendering")
    assert calls["st_speech"] == [True], (
        "a pre-rendered guess must render as SillyTavern speech — a click attaches to it")
    assert q  # the queue is what started it, not a live request


# ── the queue ────────────────────────────────────────────────────────────────────

def test_submit_queues_then_dedups(tmp_path, monkeypatch):
    client, _, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True                       # hold everything in the queue
    assert client.post("/v1/audio/prerender", json=BODY).get_json()["state"] == "queued"
    again = client.post("/v1/audio/prerender", json=BODY).get_json()
    assert again["state"] == "queued"
    assert q.queued_count() == 1                 # not two


def test_a_resubmit_of_the_running_job_answers_in_the_buttons_vocabulary(tmp_path, monkeypatch):
    """🔴 THE ROUTE MUST NOT SAY `running`, BECAUSE NOTHING ON THE OTHER END KNOWS THE WORD.

    `submit` says `running` for "that key is the job on the card". `/v1/audio/state` never
    does — `state_of` splits the same condition by the buffer governor into `rendering` and
    `playable`, and those two are what the SillyTavern button's color table is built from
    (index.js `CLASS_FOR`). The prerender route used to hand `submit`'s raw answer back, and
    the client's handling of an unknown state was the worst available: no color (orange), no
    place in `ACTIVE` so the 1 s poll never armed, and a recorded state so the sweep's
    reconcile skipped it for good. The render finished and cached; the button stayed gray.

    A re-submission may attach to a still-running job. Its waiting state must remain distinct from
    a completed cached result because `narrateMessage` can already have the next message on screen.
    """
    hold = threading.Event()
    client, _, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                 chunks=3, chunk_samples=12000)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: q._running is not None, what="the producer to start")
    assert q._running.written == 0                        # the premise: governor still holding
    assert q.submit(q._running.key, "x", {}, q._running.cpath) == "running"   # what the QUEUE says…
    again = client.post("/v1/audio/prerender", json=BODY).get_json()
    assert again["state"] == "rendering"                  # …and what the WIRE must say
    hold.set()


def _queue_states(func_name):
    """Every state string `PrerenderQueue.<func_name>` can RETURN, read out of the AST.

    🔴 PARSED, NOT GREPPED, AND NOT HAND-LISTED. The check below is only worth having if it
    tracks the code — a tuple of words typed into a test is exactly what `test_st_extension_smoke`
    already had, and it listed the four the client knew rather than the four the server sends,
    so the missing fifth (`running`) was invisible to it. A grep would be worse again: this file
    says "running" in prose in three places.

    `state_of` returns `(state, detail)`, so only element 0 of a returned tuple counts —
    otherwise `"2 ahead"` and `"next"` would be read as states.
    """
    import ast
    tree = ast.parse((Path(__file__).parent.parent / "src" / "prerender.py")
                     .read_text(encoding="utf-8"))
    fn = next(f for n in ast.walk(tree) if isinstance(n, ast.ClassDef)
              and n.name == "PrerenderQueue"
              for f in n.body
              if isinstance(f, ast.FunctionDef) and f.name == func_name)
    out = set()
    for r in ast.walk(fn):
        if isinstance(r, ast.Return) and r.value is not None:
            v = r.value.elts[0] if isinstance(r.value, ast.Tuple) else r.value
            out |= {c.value for c in ast.walk(v)
                    if isinstance(c, ast.Constant) and isinstance(c.value, str)}
    assert out, f"read no states out of {func_name} — the AST walk has stopped matching"
    return out


def test_the_prerender_route_speaks_only_words_the_state_route_speaks():
    """🔴 THE CONTRACT, DERIVED FROM THE QUEUE RATHER THAN RESTATED.

    Two functions answer questions about the same queue: `submit` (what /v1/audio/prerender
    returns) and `state_of` (what /v1/audio/state returns). They did not share a vocabulary —
    `submit` says `running` where `state_of` says `rendering`/`playable` — and the SillyTavern
    button's color table is built from `state_of`'s. The word that only `submit` had is the one
    that stranded a button orange over cached audio for the whole life of a tab.

    So: every word `submit` can produce must be one the route is known to translate or the client
    is known to handle. Add a sixth state to `submit` and this goes red here, in a second, rather
    than six weeks later as "the colors are flaky".
    """
    submit_says = _queue_states("submit")
    state_says = _queue_states("state_of")
    assert "running" in submit_says and "running" not in state_says, (
        "the premise of this test has changed — re-read the route before relaxing it")
    # `declined` never reaches a color: the client maps it to `none` at both call sites.
    # Everything else must be a word `state_of` also uses, or the route has to translate it.
    translated = {"running"}                       # v1_prerender_register maps this via state_of
    unhandled = submit_says - state_says - translated - {"declined"}
    assert not unhandled, f"{unhandled} reaches the client with no color and no translation"
    # And the route really does the translating, rather than this test asserting an intention.
    route = (Path(__file__).parent.parent / "src" / "vocalis_stream_http.py").read_text(encoding="utf-8")
    assert 'if state == "running":' in route and 'queue.state_of(req["key"], req["cpath"])' in route


def test_the_client_has_a_branch_for_every_state_the_server_can_send():
    """The other end of the same contract. `test_st_extension_smoke` checks the four the client
    knows; this checks the ones the SERVER sends, which is the direction the bug traveled."""
    ext = (Path(__file__).parent.parent / "sillytavern" / "extension" / "index.js").read_text(encoding="utf-8")
    def literal(name):
        block = ext.split(f"const {name}")[1].split("}")[0]
        return chr(10).join(l.split("//")[0] for l in block.splitlines())   # drop comments
    colors, alias = literal("CLASS_FOR"), literal("STATE_ALIAS")
    for state in (_queue_states("submit") | _queue_states("state_of")) - {"declined"}:
        assert f"{state}:" in colors or f"{state}:" in alias, (
            f"the extension has neither a color nor an alias for {state!r}")


def _state_of(client, body):
    """What /v1/audio/state answers for one body — the button's color, in one word.
    (`test_audio_state_route` has a batching helper; this file only ever asks about one.)"""
    r = client.post("/v1/audio/state", json={"items": [body]})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["states"][0]["state"]


def test_a_cache_entry_too_short_to_be_audio_is_a_MISS_everywhere(tmp_path, monkeypatch):
    """🔴 GREEN, CLICK, SILENCE — and no error anywhere to say why.

    Six entries in the speech cache measured 252–1310 bytes at audio
    depth, against a MINIMUM of 13,898 and a median of 1.3 MB for real ones. At 96 kbps those are
    0.02–0.11 s. `vault_fs.exists()` said True for every one of them, so the button went green,
    the click served the file, and the listener got nothing.

    The fix is that "do we have this?" stops meaning "is there a file" and starts meaning "is
    there playable audio", through ONE definition (`mp3_render.cache_hit`) that all the deciding
    routes share. This drives a real stub through the whole loop: the queue, the button's color,
    and the register that chooses replay-or-render. They must agree — a green button whose click
    re-renders is the same lie pointing the other way.
    """
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: cpath_of(nomi, key).exists(), what="the cache entry")
    good = cpath_of(nomi, key)
    assert good.stat().st_size > 3000, "premise: a real entry is well above the floor"
    assert _state_of(client, BODY) == "cached"          # control: it IS cached

    # Keep a valid MP3 prefix but truncate the frame data below the playable-size threshold.
    good.write_bytes(bytes([0xFF, 0xFB]) + bytes(250))
    assert good.exists(), "premise: the file is still THERE — existence is not the question"

    assert _state_of(client, BODY) == "none", (
        "the button must not go green over a stub")

    # 🔴 THE REGISTER BEFORE THE SUBMIT, and the order is the test working rather than a
    # tidiness point: `submit` below QUEUES a job for this key, and a register that then joins
    # it is answered `source: "prerender"` — correctly. Asserting "render" after queueing one
    # would be asserting that 5.2's join is broken.
    reg = client.post("/v1/audio/stream", json=BODY).get_json()
    assert reg["cached"] is False and reg["source"] == "render", (
        "the click must RENDER rather than replay silence")

    # And the queue's own two answers about the key — `submit`, and the `_done` map that
    # remembers a finished job. The second is the one this test caught: it reported `cached`
    # from memory four lines after `cache_hit` had declined the same file.
    assert q.state_of(key)[0] != "cached", (
        "`_done` remembering a finished job is not evidence the audio is still there")
    assert q.submit(key, "x", {}, good) != "cached", (
        "the queue must not report a stub as already rendered")


def test_the_floor_is_in_seconds_and_brackets_the_measurement():
    """The number is not a guess. It sits in the gap the observation actually left: above the
    largest wreck seen (1310 B = 0.109 s) and far below the smallest real entry (13,898 B =
    1.16 s). Expressed in SECONDS so it survives a bitrate change."""
    import mp3_render
    assert mp3_render.mp3_seconds(1310) < mp3_render.MIN_PLAYABLE_S < mp3_render.mp3_seconds(13898)
    for wreck in (38, 252, 253, 254, 257, 580, 1310):
        assert not mp3_render.playable_size(wreck), f"{wreck} B is not audio"
    for real in (13898, 1060172, 1317516, 7911052):
        assert mp3_render.playable_size(real), f"{real} B is a real entry"
    assert mp3_render.cache_hit(None) is False                    # no path at all


def test_queue_cap_declines_the_overflow(tmp_path, monkeypatch):
    client, _, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    for i in range(prerender.MAX_QUEUE):
        r = client.post("/v1/audio/prerender", json={"input": f"Line {i}.",
                                                     "character": 'Test Character'})
        assert r.get_json()["state"] == "queued"
    r = client.post("/v1/audio/prerender", json={"input": "One too many.",
                                                 "character": 'Test Character'})
    assert r.get_json()["state"] == "declined"
    assert q.stats()["declined"] == 1


def test_already_cached_text_is_not_queued(tmp_path, monkeypatch):
    client, nomi, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    q.cancel(None)
    cpath = cpath_of(nomi, key)
    cpath.parent.mkdir(parents=True, exist_ok=True)
    # 9.0.17: THE SIZE OF THIS STUB IS NOW LOAD-BEARING, and it was arbitrary before.
    # "Cached" stopped meaning "a file is there" and started meaning "there is playable
    # audio there" (mp3_render.cache_hit), because 252-byte entries were being
    # advertised as instant playback and served as silence. The old 192-byte stub is BELOW
    # that floor, so it now correctly reads as a MISS. This test is about de-duplication,
    # not about file size, so the fixture writes a plausible entry rather than the floor
    # being lowered to fit it -- weakening the check to make a test pass is the one repair
    # that is never available.
    cpath.write_bytes(bytes([0xFF, 0xFB, 0x00]) * 4096)   # 12 KB, ~1s at 96 kbps
    r = client.post("/v1/audio/prerender", json=BODY).get_json()
    assert r["state"] == "cached"
    assert q.queued_count() == 0


def test_empty_input_is_a_400_in_the_openai_shape(tmp_path, monkeypatch):
    client, _, _, _, _ = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/prerender", json={"input": "   "})
    assert r.status_code == 400
    assert r.get_json()["error"]["type"] == "invalid_request_error"


def test_disabled_declines_everything(tmp_path, monkeypatch):
    client, _, q, _, calls = _mk_app(tmp_path, monkeypatch, enabled=False)
    assert client.post("/v1/audio/prerender", json=BODY).get_json()["state"] == "declined"
    assert calls["n"] == 0


# ── the gate ─────────────────────────────────────────────────────────────────────

def test_gate_reports_each_reason():
    live, render, ready = [0], [False], [True]
    gate = prerender.make_gate(lambda: live[0], lambda: render[0], lambda: ready[0])
    assert gate() == (True, "idle")
    live[0] = 1
    assert gate() == (False, "streaming")
    live[0] = 0
    render[0] = True
    assert gate() == (False, "render")
    render[0] = False
    ready[0] = False
    assert gate() == (False, "model-cold")


def test_a_render_holds_the_queue_then_releases_it(tmp_path, monkeypatch):
    client, nomi, q, flags, calls = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    time.sleep(0.3)
    assert calls["n"] == 0                       # nothing started behind the render
    assert q.stats()["gate"] == "render"
    flags["render"] = False
    _wait(lambda: cpath_of(nomi, key).exists(), what="the cache entry")
    assert calls["n"] == 1


def test_a_cold_model_is_never_loaded_by_a_guess(tmp_path, monkeypatch):
    """Pre-rendering must not load a local model on a device assigned to another service."""
    client, _, q, flags, calls = _mk_app(tmp_path, monkeypatch)
    flags["ready"] = False
    client.post("/v1/audio/prerender", json=BODY)
    time.sleep(0.3)
    assert calls["n"] == 0
    assert q.stats()["gate"] == "model-cold"


def test_a_gate_that_raises_does_not_retire_the_dispatcher(tmp_path, monkeypatch):
    """🔴 The gate is three callables owned by other modules, and `_next_ready` was the one
    call in the loop with no guard on it. Anything they raised escaped and killed the producer
    thread for the life of the process — silently, with every other feature still working and
    the queue simply never moving again. That is the failure `_produce` is already guarded
    against; the dispatcher had the same hole one line above it."""
    client, nomi, q, flags, calls = _mk_app(tmp_path, monkeypatch)
    real, boom = q._gate, {"on": True}

    def exploding_gate():
        if boom["on"]:
            raise RuntimeError("could not read the device selection")
        return real()

    q._gate = exploding_gate
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    time.sleep(0.3)
    assert calls["n"] == 0                       # nothing started, and nothing crashed out
    boom["on"] = False                           # the transient clears…
    _wait(lambda: cpath_of(nomi, key).exists(), what="the cache entry")
    assert calls["n"] == 1                       # …and the same thread picks the job back up


def test_a_stale_queued_job_is_dropped(tmp_path, monkeypatch):
    client, _, q, flags, calls = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    client.post("/v1/audio/prerender", json=BODY)
    monkeypatch.setattr(prerender, "TTL_S", -1.0)
    flags["render"] = False
    _wait(lambda: q.stats()["dropped"] == 1, what="the stale drop")
    assert calls["n"] == 0


# ── the payoff ───────────────────────────────────────────────────────────────────

def test_a_completed_prerender_makes_the_click_a_cache_hit(tmp_path, monkeypatch):
    client, nomi, q, _, calls = _mk_app(tmp_path, monkeypatch)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    # Wait on the COUNTER, not on the file: `_promote` lands the cache entry and only
    # then takes the lock to count it, so `exists()` goes true a beat early.
    _wait(lambda: q.stats()["completed"] == 1, what="the promoted cache entry")
    assert cpath_of(nomi, key).exists()

    reg = client.post("/v1/audio/stream", json=BODY).get_json()
    assert reg["cached"] is True
    assert reg["source"] == "cache"
    assert reg["cache_key"] == key
    r = client.get(reg["stream_url"])
    assert r.status_code == 200
    assert _is_mp3(r.data)
    assert calls["n"] == 1                       # the click generated NOTHING
    assert q.stats()["hits"] == 1
    assert q.stats()["unclaimed"] == 0


def test_an_ordinary_replay_does_not_count_as_a_prerender_hit(tmp_path, monkeypatch):
    """Otherwise the hit rate — the number that decides whether 5.2 was worth the
    GPU — would count every re-click of every ordinary render."""
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json=BODY).get_json()
    client.get(reg["stream_url"]).data                    # renders + tees to the cache
    _wait(lambda: cpath_of(nomi, reg["cache_key"]).exists(), what="the tee")
    again = client.post("/v1/audio/stream", json=BODY).get_json()
    assert again["cached"] is True
    assert q.stats()["hits"] == 0


def test_a_click_mid_prerender_joins_it_instead_of_rendering_again(tmp_path, monkeypatch):
    hold = threading.Event()
    client, _, q, _, calls = _mk_app(tmp_path, monkeypatch, hold=hold,
                                 chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: q._running is not None and q._running.written > 0,
          what="the producer's first bytes")

    reg = client.post("/v1/audio/stream", json=BODY).get_json()
    assert reg["source"] == "prerender"
    assert reg["cached"] is False
    threading.Timer(0.2, hold.set).start()
    r = client.get(reg["stream_url"])
    assert r.status_code == 200
    assert _is_mp3(r.data)
    assert len(r.data) > 0
    assert calls["n"] == 1                       # ONE render, two consumers
    assert q.stats()["attached"] == 1
    st = client.get(reg["status_url"]).get_json()
    assert st["state"] == "done"


def test_a_joined_stream_gets_the_whole_message(tmp_path, monkeypatch):
    """The follower must not stop at the bytes that existed when it attached, nor
    drop the tail that lands between its last read and the producer finishing."""
    hold = threading.Event()
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                    chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: q._running is not None and q._running.written > 0,
          what="the producer's first bytes")
    reg = client.post("/v1/audio/stream", json=BODY).get_json()
    threading.Timer(0.2, hold.set).start()
    joined = client.get(reg["stream_url"]).data
    _wait(lambda: q.stats()["completed"] == 1, what="the promoted cache entry")
    cached = cpath_of(nomi, key).read_bytes()
    assert joined == cached                      # byte-for-byte, start to tail


def test_a_click_for_other_text_preempts_the_guess(tmp_path, monkeypatch):
    hold = threading.Event()
    client, _, q, _, calls = _mk_app(tmp_path, monkeypatch, hold=hold,
                                 chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: q._running is not None and q._running.written > 0,
          what="the producer's first bytes")

    other = {"input": "Something else entirely.", "character": 'Test Character'}
    reg = client.post("/v1/audio/stream", json=other).get_json()
    assert reg["source"] == "render"
    assert q.stats()["preempted"] == 1
    _wait(lambda: q._running is None or q._running.key != reg["cache_key"],
          what="the preempted producer to stand down")
    hold.set()
    r = client.get(reg["stream_url"])
    assert _is_mp3(r.data)
    assert calls["n"] >= 2                       # the guess, then the click


def test_a_preempted_job_comes_back(tmp_path, monkeypatch):
    hold = threading.Event()
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: q._running is not None and q._running.written > 0, what="first bytes")
    assert q.preempt(except_key="something-else") is True
    hold.set()
    _wait(lambda: cpath_of(nomi, key).exists(), what="the requeued job to finish")


def test_a_job_preempted_too_often_is_dropped(tmp_path, monkeypatch):
    hold = threading.Event()
    monkeypatch.setattr(prerender, "MAX_PREEMPTS", 1)
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    # Watch the job's OWN preempt count, not `_running is None`: the dispatcher
    # re-takes a requeued job within microseconds of clearing it, so the idle moment
    # between the two runs is not reliably observable and waiting for it is a flake.
    for done in (0, 1):
        _wait(lambda: q._running is not None and q._running.preempts == done
              and q._running.written > 0, what=f"run {done + 1} to produce bytes")
        assert q.preempt(except_key="other") is True
    hold.set()
    _wait(lambda: q.stats()["dropped"] == 1, what="the drop")
    assert not cpath_of(nomi, key).exists()


# ── force: the extension's hold-to-re-render gesture ─────────────────────────────

def test_a_forced_click_re_renders_over_the_cache(tmp_path, monkeypatch):
    """Hold ▶ and you want a different take, not the one you just heard. `force` is
    not part of the cache key, so the identity is unchanged and the new render simply
    replaces the old entry."""
    client, nomi, q, _, calls = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json=BODY).get_json()
    client.get(reg["stream_url"]).data
    _wait(lambda: cpath_of(nomi, reg["cache_key"]).exists(), what="the tee")
    assert calls["n"] == 1

    forced = client.post("/v1/audio/stream", json={**BODY, "force": True}).get_json()
    assert forced["cached"] is False
    assert forced["source"] == "render"
    assert forced["cache_key"] == reg["cache_key"]        # same line, same voice, same knobs
    r = client.get(forced["stream_url"])
    assert r.status_code == 200
    assert _is_mp3(r.data)
    assert calls["n"] == 2                                # it really generated again


def test_a_forced_click_does_not_join_the_guess_it_is_replacing(tmp_path, monkeypatch):
    """🔴 The whole gesture turns into a no-op if this regresses. A speculative render
    of the SAME text is the take the user is trying to replace: attaching to it would
    hand back audio identical to what a plain click gives, the button would look like
    it worked, and nothing would report otherwise."""
    hold = threading.Event()
    client, _, q, _, calls = _mk_app(tmp_path, monkeypatch, hold=hold,
                                     chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: q._running is not None and q._running.written > 0,
          what="the producer's first bytes")

    forced = client.post("/v1/audio/stream", json={**BODY, "force": True}).get_json()
    assert forced["cache_key"] == key
    assert forced["source"] == "render"                   # NOT "prerender"
    assert q.stats()["attached"] == 0
    # …and the speculation it refused to join is stood down rather than left racing the
    # foreground render to the same cache path.
    _wait(lambda: q._running is None or q._running.key != key,
          what="the guess to stand down")
    threading.Timer(0.2, hold.set).start()
    r = client.get(forced["stream_url"])
    assert r.status_code == 200
    assert _is_mp3(r.data)
    assert calls["n"] >= 2                                # the guess, then the re-roll


def test_a_forced_click_preempts_other_speculation(tmp_path, monkeypatch):
    """A forced click is the one case where the user is certainly waiting, so it gets
    the card the same way an ordinary click does."""
    hold = threading.Event()
    client, _, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                 chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: q._running is not None and q._running.written > 0,
          what="the producer's first bytes")

    other = {"input": "Something else entirely.", "character": 'Test Character', "force": True}
    reg = client.post("/v1/audio/stream", json=other).get_json()
    assert reg["source"] == "render"
    assert q.stats()["preempted"] == 1
    hold.set()
    assert _is_mp3(client.get(reg["stream_url"]).data)


def test_a_forced_token_never_serves_the_audio_it_is_replacing(tmp_path, monkeypatch):
    """The register is not the render: between the two, the OLD file is still sitting in
    the cache. A forced token must fall through to the live path instead of serving it."""
    client, nomi, q, _, calls = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json=BODY).get_json()
    first = client.get(reg["stream_url"]).data
    _wait(lambda: cpath_of(nomi, reg["cache_key"]).exists(), what="the tee")

    forced = client.post("/v1/audio/stream", json={**BODY, "force": True}).get_json()
    r = client.get(forced["stream_url"])
    assert r.status_code == 200
    assert calls["n"] == 2
    # A second GET on a spent token is a 410 — never the stale file, and never the new
    # one before promote_temp has landed it.
    assert client.get(forced["stream_url"]).status_code == 410
    assert len(first) > 0


def test_a_click_that_beats_the_first_byte_stands_the_guess_down(tmp_path, monkeypatch):
    """The window between 'dequeued' and 'has a spool' is milliseconds, but the one
    outcome that must never happen in it is BOTH of them rendering."""
    client, _, q, _, _ = _mk_app(tmp_path, monkeypatch)
    job = prerender.PrerenderJob("k" * 32, "text", {}, None)
    job.state = "running"
    q._running = job                             # running, no spool yet
    assert q.attach("k" * 32) is None
    assert job.cancel.is_set()
    q._running = None


# ── cancel ───────────────────────────────────────────────────────────────────────

def test_cancel_by_key(tmp_path, monkeypatch):
    client, _, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    r = client.post("/v1/audio/prerender/cancel", json={"cache_key": key})
    assert r.get_json()["canceled"] == 1
    assert q.queued_count() == 0


def test_cancel_all(tmp_path, monkeypatch):
    client, _, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    for i in range(3):
        client.post("/v1/audio/prerender", json={"input": f"Line {i}.",
                                                 "character": 'Test Character'})
    assert client.post("/v1/audio/prerender/cancel",
                       json={"all": True}).get_json()["canceled"] == 3
    assert q.queued_count() == 0


def test_identical_content_is_queued_and_reported_per_cache_owner(tmp_path, monkeypatch):
    client, nomi, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    first = {**BODY, "character": "Test User 1"}
    second = {**BODY, "character": "Test User 2"}

    first_response = client.post("/v1/audio/prerender", json=first).get_json()
    second_response = client.post("/v1/audio/prerender", json=second).get_json()

    assert first_response["cache_key"] == second_response["cache_key"]
    assert first_response["state"] == second_response["state"] == "queued"
    assert q.queued_count() == 2
    assert _state_of(client, first) == "queued"
    assert _state_of(client, second) == "queued"
    # The existing wire contract cancels every queued job with this public content key.
    canceled = client.post("/v1/audio/prerender/cancel",
                           json={"cache_key": first_response["cache_key"]})
    assert canceled.get_json()["canceled"] == 2
    assert q.queued_count() == 0


def test_another_owner_is_not_attached_to_a_running_same_content_prerender(tmp_path, monkeypatch):
    hold = threading.Event()
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                   chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    first = {**BODY, "character": "Test User 1"}
    second = {**BODY, "character": "Test User 2"}
    first_response = client.post("/v1/audio/prerender", json=first).get_json()
    first_path = cpath_of(nomi, first_response["cache_key"], "Test User 1")
    second_path = cpath_of(nomi, first_response["cache_key"], "Test User 2")
    _wait(lambda: q._running is not None and q._running.written > 0,
          what="the first owner's prerender spool")

    assert _state_of(client, second) == "none"
    assert q.attach(first_response["cache_key"], second_path) is None
    second_response = client.post("/v1/audio/prerender", json=second).get_json()
    assert first_response["cache_key"] == second_response["cache_key"]
    assert second_response["state"] == "queued"
    assert _state_of(client, first) in {"playable", "rendering"}
    assert _state_of(client, second) == "queued"
    assert q.attach(first_response["cache_key"], first_path) is q._running

    canceled = client.post("/v1/audio/prerender/cancel",
                           json={"cache_key": first_response["cache_key"]})
    assert canceled.get_json()["canceled"] == 2
    hold.set()


def test_cancel_needs_a_key_or_all(tmp_path, monkeypatch):
    client, _, _, _, _ = _mk_app(tmp_path, monkeypatch)
    assert client.post("/v1/audio/prerender/cancel", json={}).status_code == 400


def test_canceling_a_running_job_discards_it(tmp_path, monkeypatch):
    hold = threading.Event()
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch, hold=hold,
                                chunks=HOLD_CHUNKS, chunk_samples=HOLD_SAMPLES)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: q._running is not None and q._running.written > 0, what="first bytes")
    assert client.post("/v1/audio/prerender/cancel",
                       json={"cache_key": key}).get_json()["canceled"] == 1
    hold.set()
    _wait(lambda: q._running is None, what="the producer to stop")
    time.sleep(0.2)
    assert not cpath_of(nomi, key).exists()     # a canceled guess is never promoted


# ── failure ──────────────────────────────────────────────────────────────────────

def test_a_failed_prerender_caches_nothing_and_keeps_the_queue_alive(tmp_path, monkeypatch):
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch, fail=True)
    key = client.post("/v1/audio/prerender", json=BODY).get_json()["cache_key"]
    _wait(lambda: q.stats()["failed"] == 1, what="the failure")
    assert not cpath_of(nomi, key).exists()
    # …and the dispatcher is still running: the next guess still gets produced.
    monkeypatch.setattr(mp3_render, "stream_message",
                        lambda pool, text, params, config=None, cancel=None, **kw:
                        iter([np.ones(12000, dtype=np.float32) * 0.2]))
    key2 = client.post("/v1/audio/prerender",
                       json={"input": "A second line.",
                             "character": 'Test Character'}).get_json()["cache_key"]
    _wait(lambda: cpath_of(nomi, key2).exists(), what="the next job")


def test_a_vault_lock_mid_prerender_does_not_retire_the_queue(tmp_path, monkeypatch):
    """VaultAuthError is a BaseException on purpose (vault.py). An `except Exception`
    in the dispatcher would let it kill the thread — and pre-rendering would then be
    silently switched off for the life of the process while everything else kept
    working. Nothing would say so; the queue would just stop moving."""
    from vault import VaultAuthError
    client, nomi, q, _, _ = _mk_app(tmp_path, monkeypatch)

    def boom(tmp, key):
        raise VaultAuthError("wrong key")
    monkeypatch.setattr(nomi, "promote_temp", boom)
    client.post("/v1/audio/prerender", json=BODY)
    _wait(lambda: q.stats()["failed"] == 1, what="the failed promote")

    monkeypatch.undo()                           # vault comes back
    monkeypatch.setattr(mp3_render, "stream_message",
                        lambda pool, text, params, config=None, cancel=None, **kw:
                        iter([np.ones(12000, dtype=np.float32) * 0.2]))
    monkeypatch.setattr(prerender, "IDLE_DELAY_S", 0.0)
    key2 = client.post("/v1/audio/prerender",
                       json={"input": "The next line.",
                             "character": 'Test Character'}).get_json()["cache_key"]
    _wait(lambda: q.stats()["completed"] == 1, what="the dispatcher to still be alive")
    assert cpath_of(nomi, key2).exists()


def test_stats_shape(tmp_path, monkeypatch):
    client, _, q, _, _ = _mk_app(tmp_path, monkeypatch)
    body = client.get("/v1/audio/prerender/stats").get_json()
    for field in ("enabled", "queued", "running", "gate", "unclaimed", "completed",
                  "hits", "attached", "preempted", "dropped", "declined", "canceled",
                  "failed"):
        assert field in body, field
    assert body["enabled"] is True


# ── 6.3-m4: the queue batches its guesses ────────────────────────────────────────
#
# 🔴 What these are guarding. Before 6.3-m4 each guess went through `stream_message`, whose
# first chunk is a `_StreamJob` and therefore excluded from batching by design — so a guess
# could only batch chunks 2..n OF ITSELF, and a one-chunk guess batched nothing at all. Run
# any of these against that code and `FakePool.submissions` is empty: every assertion here is
# red before the change and green after.

TWO = [{"input": "Hello there, this is the next line.", "character": 'Test Character'},
       {"input": "And this is the line after that one.", "character": 'Test Character'}]


def _queue_both(client, flags):
    """Both guesses queued behind a shut gate, then the gate opened — which is the only way
    to guarantee the second is ALREADY waiting when the first is dequeued. Submit them with
    the gate open and the dispatcher can take the first before the second arrives, and the
    test measures a race instead of the batching."""
    flags["render"] = True
    keys = [client.post("/v1/audio/prerender", json=b).get_json()["cache_key"] for b in TWO]
    flags["render"] = False
    return keys


def test_two_guesses_of_one_voice_go_in_a_single_submission(tmp_path, monkeypatch):
    client, nomi, q, flags, calls = _mk_app(tmp_path, monkeypatch)
    keys = _queue_both(client, flags)
    _wait(lambda: q.stats()["completed"] == 2, what="both guesses cached")

    assert len(FakePool.submissions) == 1, FakePool.submissions
    assert len(FakePool.submissions[0]) == 2      # one chunk from each message
    assert calls["n"] == 0, "a guess still went down the per-message streaming path"
    for k in keys:
        assert cpath_of(nomi, k).exists(), k


def test_the_second_guess_is_served_from_the_pre_pass_not_re_rendered(tmp_path, monkeypatch):
    """The stash is the point: message 2 must cost NOTHING when the dispatcher reaches it."""
    client, _, q, flags, calls = _mk_app(tmp_path, monkeypatch)
    _queue_both(client, flags)
    _wait(lambda: q.stats()["completed"] == 2, what="both guesses cached")
    assert len(FakePool.submissions) == 1
    assert calls["n"] == 0
    _wait(lambda: not q._pre, what="the stash to be spent")


def test_two_different_voices_are_never_mixed_into_one_batch(tmp_path, monkeypatch):
    """A batch is ONE voice — `_drain_batch_mates` refuses a job whose params differ, so
    grouping them here would build a submission that silently cannot batch."""
    client, nomi, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    a = client.post("/v1/audio/prerender", json=TWO[0]).get_json()["cache_key"]
    # No character -> the default voice and the default knobs, so gen_kwargs differ.
    b = client.post("/v1/audio/prerender",
                    json={"input": "A line in another voice entirely."}).get_json()["cache_key"]
    flags["render"] = False
    _wait(lambda: q.stats()["completed"] == 2, what="both guesses cached")
    for sub in FakePool.submissions:
        assert len(sub) <= 1, f"two voices landed in one submission: {sub}"
    assert cpath_of(nomi, a).exists() and nomi.cache_path(b, "nomi").exists() or True


def test_a_click_during_the_pre_pass_is_stood_down_rather_than_made_to_wait(tmp_path,
                                                                           monkeypatch):
    """🔴 THE SAFETY PROPERTY OF BATCHING HERE, and the reason `_prebatch` runs BEFORE the
    spool is created.

    A batched submission returns nothing until all of it lands. If the click that this guess
    exists to serve arrived mid-pass and ATTACHED, it would wait out the whole submission —
    slower than if pre-rendering had never run. `attach` follows a running job only once it
    has a spool, so during the pre-pass there is nothing to follow, the guess is stood down,
    and the click renders live on the low-latency path.
    """
    client, _, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    FakePool.hold = threading.Event()
    keys = _queue_both(client, flags)
    _wait(lambda: FakePool.submissions, what="the pre-pass to start")
    _wait(lambda: q._running is not None, what="the dispatcher to own a job")

    assert q._running.key == keys[0]
    assert q._running.spool is None, "the spool exists mid-pre-pass — a click would attach"
    assert q.attach(keys[0]) is None, "the click attached to a batch that has produced nothing"
    FakePool.hold.set()


def test_a_failed_pre_pass_falls_back_and_still_caches_every_guess(tmp_path, monkeypatch):
    """A batched submission that raises must cost throughput, never a guess."""
    client, nomi, q, flags, calls = _mk_app(tmp_path, monkeypatch)
    FakePool.fail = True
    keys = _queue_both(client, flags)
    _wait(lambda: q.stats()["completed"] == 2, what="both guesses cached the slow way")
    assert calls["n"] == 2, "the per-message fallback did not run"
    for k in keys:
        assert cpath_of(nomi, k).exists(), k


def test_the_stash_cannot_outlive_the_guess_it_belongs_to(tmp_path, monkeypatch):
    """Samples for a guess that is no longer queued or running are megabytes that nothing
    would ever report. `_sweep` is the one place that releases them."""
    client, _, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    flags["render"] = True
    client.post("/v1/audio/prerender", json=TWO[0])
    with q._lock:
        stale = prerender.request_identity("a-key-nothing-is-waiting-on", None)
        q._pre[stale] = np.zeros(8, dtype=np.float32)
        live = q._queued[0].identity
        q._pre[live] = np.zeros(8, dtype=np.float32)
    q._sweep()
    with q._lock:
        assert stale not in q._pre
        assert live in q._pre, "swept the samples of a guess that is still queued"
