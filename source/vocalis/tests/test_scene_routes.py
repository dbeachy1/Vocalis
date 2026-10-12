"""`/v1/audio/scene` — the route half of 6.0 §3.1.

Generation is faked the way `test_stream_http.py` fakes it; ffmpeg is real, so these also prove
the concat. What is being asserted is the CONTRACT the SillyTavern extension codes against, and
one invariant that is not visible from either side:

🔴 **the scene route must derive the same cache key from the same message as `/v1/audio/stream`,
`/v1/audio/prerender` and `/v1/audio/state`.** That is the 5.4 landmine restated for a fourth
route. An item that differs by one field describes audio nothing will ever find, so the scene
renders everything from scratch, silently, and every button stays orange. There is no error to
see, which is exactly why it is pinned here.
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
import scene_build                                         # noqa: E402
import scenes                                              # noqa: E402
import vocalis_stream_http as vsh                          # noqa: E402
from nomi_speak import NomiSpeaker                         # noqa: E402
from st_characters import StCharacterRegistry              # noqa: E402

SR = 24000


class FakePool:
    sr = SR


def _mk_app(tmp_path, monkeypatch, *, render_rate_key=None):
    (tmp_path / "voice_samples").mkdir()
    (tmp_path / "voice_samples" / "v.wav").write_bytes(b"RIFFfake")
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text("nomi:\n  default_voice: v.wav\n", encoding="utf-8")
    nomi = NomiSpeaker(settings, tmp_path / "voice_samples", tmp_path / "cache")

    def fake_stream_message(pool, text, params, config=None, cancel=None, **kw):
        for _ in range(3):
            yield np.ones(8000, dtype=np.float32) * 0.1
    monkeypatch.setattr(mp3_render, "stream_message", fake_stream_message)

    vdir = tmp_path / "voice_samples"

    def resolve_voice(name):
        p = vdir / Path(name).name
        return p if p.exists() else None

    app = Flask(__name__)
    app.register_blueprint(vsh.create_stream_blueprint(
        lambda: FakePool(), nomi, voice_dir=vdir, resolve_voice=resolve_voice,
        st_registry=StCharacterRegistry(settings),
        output_dir=lambda: tmp_path / "output",
        render_rate_key=render_rate_key))
    return app.test_client(), nomi, tmp_path / "output"


def _items(n=3):
    return [{"input": f"line number {i}", "character": 'Test User', "mesid": 400 + i}
            for i in range(n)]


def _wait(client, job_id, timeout=30.0):
    """Poll to a terminal state. The build runs in a thread, as it does in production."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/v1/audio/scene/{job_id}").get_json()
        if body["status"] in ("done", "failed", "canceled"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"scene job never finished: {body}")


# ── the contract ─────────────────────────────────────────────────────────────────────────

def test_a_build_returns_202_and_a_job_id(tmp_path, monkeypatch):
    client, _nomi, out = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/scene", json={"title": "The ferry", "items": _items()})
    assert r.status_code == 202
    body = r.get_json()
    assert body["items"] == 3 and body["skipped"] == 0
    done = _wait(client, body["job_id"])
    assert done["status"] == "done" and done["ref"]
    assert (scenes.scenes_root(out) / f"{done['ref']}.mp3").is_file()


def test_the_scene_route_derives_THE_SAME_KEY_as_a_click(tmp_path, monkeypatch):
    """🔴 The 5.4 landmine, for a fourth route. Post one message to `/v1/audio/state` and the
    same bytes to `/v1/audio/scene`; the audio the scene renders must land where the probe says
    to look, or the buttons stay orange forever and nothing reports it."""
    client, nomi, _out = _mk_app(tmp_path, monkeypatch)
    item = {"input": "line number 0", "character": 'Test User'}

    probed = client.post("/v1/audio/state", json={"items": [item]}).get_json()
    key = probed["states"][0]["cache_key"]
    assert probed["states"][0]["state"] == "none"

    body = client.post("/v1/audio/scene",
                       json={"title": "The ferry", "items": [dict(item, mesid=1)]}).get_json()
    _wait(client, body["job_id"])

    after = client.post("/v1/audio/state", json={"items": [item]}).get_json()
    assert after["states"][0]["cache_key"] == key
    assert after["states"][0]["state"] == "cached", (
        "the scene rendered audio the probe cannot find — the two routes disagree about the key")


def test_building_a_scene_turns_the_range_green(tmp_path, monkeypatch):
    """§3.2's dividend, stated as the extension sees it: rendering PROMOTES into the ST cache,
    so 5.4's existing poll shows the progress for free and every button in the range ends
    cached."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    items = _items(3)
    body = client.post("/v1/audio/scene",
                       json={"title": "The ferry", "items": items}).get_json()
    _wait(client, body["job_id"])
    states = client.post("/v1/audio/state", json={"items": items}).get_json()["states"]
    assert [s["state"] for s in states] == ["cached"] * 3


def test_the_scene_keeps_each_speakers_SillyTavern_avatar(tmp_path, monkeypatch):
    """Scene entries preserve each speaker avatar, and the scene row reports distinct speakers with aligned avatar values."""
    client, _nomi, out = _mk_app(tmp_path, monkeypatch)
    items = [{"input": "one", "character": 'Test Character 1', "character_avatar": 'test-character-1.png',
              "mesid": 1},
             {"input": "two", "character": 'Test Character 2', "mesid": 2},
             {"input": "three", "character": 'Test Character 1', "character_avatar": 'test-character-1.png',
              "mesid": 3}]
    body = client.post("/v1/audio/scene", json={"title": 'Sample Scene', "items": items}).get_json()
    done = _wait(client, body["job_id"])
    meta = scenes.read_manifest(scenes.scenes_root(out) / f"{done['ref']}.yaml")
    assert [e["character_avatar"] for e in meta["entries"]] == ['test-character-1.png', "", 'test-character-1.png']
    row = scenes.list_scenes(scenes.scenes_root(out))[0]
    assert row["characters"] == ['Test Character 1', 'Test Character 2']
    assert row["character_avatars"] == ['test-character-1.png', ""]


# ── validation ───────────────────────────────────────────────────────────────────────────

def test_a_title_is_required(tmp_path, monkeypatch):
    """§5.1: the slug comes from the title. With no title there is nothing to name the file
    after that is safe to put in a filename."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/scene", json={"items": _items()})
    assert r.status_code == 400 and "title" in r.get_json()["error"]["message"]


@pytest.mark.parametrize("payload", [{}, {"items": []}, {"items": "nope"}])
def test_an_empty_range_is_a_400(tmp_path, monkeypatch, payload):
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/scene", json=dict(payload, title="x"))
    assert r.status_code == 400


def test_too_many_messages_is_refused(tmp_path, monkeypatch):
    """The DoS bound on an unauthenticated route — sibling of MAX_STATE_ITEMS."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    many = [{"input": "x", "character": "K"}] * (vsh.MAX_SCENE_ITEMS + 1)
    r = client.post("/v1/audio/scene", json={"title": "x", "items": many})
    assert r.status_code == 400 and "at most" in r.get_json()["error"]["message"]


def test_an_unspeakable_message_is_skipped_not_fatal(tmp_path, monkeypatch):
    """§9. `bodyFor()` returns null for system messages and ones that clean to nothing, and one
    of those in the middle of a 74-message range must not fail the build."""
    client, _nomi, out = _mk_app(tmp_path, monkeypatch)
    items = [{"input": "real line", "character": 'Test User', "mesid": 1},
             {"input": "   ", "character": 'Test User', "mesid": 2},
             {"input": "*shrugs*", "character": 'Test User', "mesid": 3,
              "narrate_actions": False},
             {"input": "another real line", "character": 'Test User', "mesid": 4}]
    body = client.post("/v1/audio/scene", json={"title": "The ferry", "items": items}).get_json()
    assert body["items"] == 2 and body["skipped"] == 2
    done = _wait(client, body["job_id"])
    assert done["status"] == "done"
    meta = scenes.read_manifest(scenes.scenes_root(out) / f"{done['ref']}.yaml")
    assert [s["mesid"] for s in meta["skipped"]] == [2, 3]


def test_a_range_with_nothing_speakable_at_all_is_a_400(tmp_path, monkeypatch):
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/scene",
                    json={"title": "x", "items": [{"input": "  ", "character": "K"}]})
    assert r.status_code == 400 and "speakable" in r.get_json()["error"]["message"]


# ── one at a time ────────────────────────────────────────────────────────────────────────

def test_a_second_build_is_refused_while_one_is_running(tmp_path, monkeypatch):
    """A second scene build is refused while the shared renderer is busy."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    slow = {"n": 0}
    real = scene_build.build_scene

    def slow_build(job, items, **kw):
        while slow["n"] == 0:
            time.sleep(0.01)
        return real(job, items, **kw)
    monkeypatch.setattr(scene_build, "build_scene", slow_build)

    first = client.post("/v1/audio/scene",
                        json={"title": "one", "items": _items()}).get_json()
    try:
        r = client.post("/v1/audio/scene", json={"title": "two", "items": _items()})
        assert r.status_code == 409
        assert r.get_json()["error"]["job_id"] == first["job_id"]
    finally:
        slow["n"] = 1
    _wait(client, first["job_id"])


def test_two_builds_racing_past_the_fast_path_still_leave_only_one(tmp_path, monkeypatch):
    """🔴 The test above only proves the FAST path: by the time its second POST lands, the first
    job is already registered. The guard's real window is elsewhere.

    A build is refused by a check near the top of the route, but registered near the bottom —
    and in between the route resolves EVERY message in the range, which is registry work and
    takes real time on a long one. Two POSTs arriving together (a double-click on Build, or a
    browser retry) could both pass the early check while neither had registered, and both would
    start. The cost is the exact thing the guard's own docstring forbids: two builds interleaving
    on ONE pool, both crawling, neither ETA meaning anything.

    So this pins A inside resolution — past the early check, before registration — and lets B
    run the whole route while A is in that window. Exactly one may start.
    """
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)

    hold = threading.Event()                     # any build that starts stays "in flight"

    def held_build(job, items, **kw):
        hold.wait(15)
        job.status = "done"
        return job
    monkeypatch.setattr(scene_build, "build_scene", held_build)

    in_resolve, release, first = threading.Event(), threading.Event(), {"seen": False}
    real_resolve = vsh.resolve_st_request

    def gated_resolve(item, **kw):
        if not first["seen"]:                    # only the very first item stalls
            first["seen"] = True
            in_resolve.set()
            release.wait(15)
        return real_resolve(item, **kw)
    monkeypatch.setattr(vsh, "resolve_st_request", gated_resolve)

    codes = {}

    def post_a():
        codes["a"] = client.post("/v1/audio/scene",
                                 json={"title": "A", "items": _items()}).status_code

    ta = threading.Thread(target=post_a, daemon=True)
    ta.start()
    assert in_resolve.wait(15), "A never reached resolution — the gate did not take"
    try:
        # A is past the early check and has NOT registered. B now runs the entire route.
        codes["b"] = client.post("/v1/audio/scene",
                                 json={"title": "B", "items": _items()}).status_code
    finally:
        release.set()
        ta.join(20)
        hold.set()

    assert sorted(codes.values()) == [202, 409], (
        f"both builds were allowed onto the pool: {codes}")


# ── status and cancel ────────────────────────────────────────────────────────────────────

def test_polling_an_unknown_job_is_a_404(tmp_path, monkeypatch):
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    assert client.get("/v1/audio/scene/nosuchjob").status_code == 404
    assert client.post("/v1/audio/scene/nosuchjob/cancel").status_code == 404


def test_canceling_a_finished_build_is_a_no_op(tmp_path, monkeypatch):
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    body = client.post("/v1/audio/scene",
                       json={"title": "The ferry", "items": _items()}).get_json()
    _wait(client, body["job_id"])
    r = client.post(f"/v1/audio/scene/{body['job_id']}/cancel")
    assert r.status_code == 200 and r.get_json()["status"] == "done"


def test_the_status_body_carries_no_chat_content(tmp_path, monkeypatch):
    """Status polling includes the title-derived reference but omits chat text and per-entry content."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    body = client.post("/v1/audio/scene",
                       json={"title": 'Test User and me', "chat": "the ferry trip",
                             "items": _items()}).get_json()
    done = _wait(client, body["job_id"])
    blob = repr(dict(done, ref=None))
    assert "line number" not in blob, "message text reached the poll"
    assert "ferry" not in blob, "the chat identifier reached the poll"
    assert 'Test User' not in blob, "a character name reached the poll"
    assert done["ref"].startswith("Test_User_and_me_"), "the ref is the title-derived filename"


# ── 6.3: the build lands ONE artifact and stops ──────────────────────────────────────────

def test_a_build_produces_exactly_one_scene_and_no_twin(tmp_path, monkeypatch):
    """Building a scene creates one raw scene and does not create an enhanced twin."""
    client, _nomi, out = _mk_app(tmp_path, monkeypatch)
    body = client.post("/v1/audio/scene",
                       json={"title": "The ferry", "items": _items()}).get_json()
    done = _wait(client, body["job_id"])

    assert done["status"] == "done" and done["ref"]
    rows = {r["ref"]: r for r in scenes.list_scenes(scenes.scenes_root(out))}
    assert set(rows) == {done["ref"]}, "a build must land exactly one artifact"
    assert rows[done["ref"]]["enhanced"] is False


def test_the_enhance_field_is_gone_from_both_sides_of_the_wire(tmp_path, monkeypatch):
    """Not defaulted to false — GONE. A field the server accepts and ignores is a worse lie than
    no field, and a reply field that is always null is one the client goes on branching on."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    r = client.post("/v1/audio/scene",
                    json={"title": "The ferry", "enhance": True, "items": _items()})
    assert r.status_code == 202
    body = r.get_json()
    assert "enhance" not in body and "enhance_unavailable" not in body
    done = _wait(client, body["job_id"])
    assert "enhanced_ref" not in done and "enhancing" not in done
    # And asking for it changed nothing: still one artifact.
    assert done["ref"] and done["status"] == "done"


def test_enhancing_is_no_longer_a_state_that_blocks_the_next_build(tmp_path, monkeypatch):
    """Enhancement work is independent of the build-state lock after its audio processing stage."""
    assert "enhancing" not in vsh.ACTIVE_SCENE
    assert vsh.ACTIVE_SCENE == ("queued", "rendering", "assembling")


# ── the estimate (§2.3) ──────────────────────────────────────────────────────────────────

def test_an_unmeasured_box_quotes_NO_build_time(tmp_path, monkeypatch):
    """When no render rate is measured, the estimate is absent instead of guessed."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)      # no render_rate_key injected
    body = client.post("/v1/audio/scene/estimate", json={"items": _items(3)}).get_json()
    assert body["render_rate"] is None
    assert body["est_render_s"] is None, "an unmeasured box must quote nothing, not a guess"
    assert body["total"] == 3 and body["uncached"] == 3 and body["cached"] == 0


def test_the_estimate_separates_build_time_from_scene_length(tmp_path, monkeypatch):
    """⚠️ Two different quantities in two different units. `render_rate` is characters per second
    of RENDER WALL CLOCK; the scene's length is speech duration. One number holding both would be
    wrong in whichever unit you read it as."""
    import render_rate
    monkeypatch.setattr(render_rate, "get", lambda key: 40.0)  # 40 chars/sec of wall clock
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch, render_rate_key=lambda: "fake|1c1w")
    items = _items(3)
    body = client.post("/v1/audio/scene/estimate", json={"items": items}).get_json()

    chars = sum(len(i["input"]) for i in items)
    assert body["uncached_chars"] == chars
    assert body["render_rate"] == 40.0
    assert body["est_render_s"] == pytest.approx(chars / 40.0, abs=0.2)
    # …and with NOTHING cached there is nothing to calibrate speech rate against, so the
    # LENGTH is unknown rather than quoted from a constant nobody measured.
    assert body["est_audio_s"] is None and body["speech_rate"] is None


def test_a_cached_range_costs_nothing_to_build_and_knows_its_length(tmp_path, monkeypatch):
    """A fully cached range reports its known duration and does not start rendering."""
    import render_rate
    monkeypatch.setattr(render_rate, "get", lambda key: 40.0)
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch, render_rate_key=lambda: "fake|1c1w")
    items = _items(3)
    _wait(client, client.post("/v1/audio/scene",
                              json={"title": "warm it", "items": items}).get_json()["job_id"])

    body = client.post("/v1/audio/scene/estimate", json={"items": items}).get_json()
    assert body["cached"] == 3 and body["uncached"] == 0
    assert body["est_render_s"] == 0.0, "an entirely cached range costs no render time"
    assert body["cached_audio_s"] > 0, "duration comes from the logical size at 96 kbps CBR"
    assert body["est_audio_s"] == pytest.approx(
        body["cached_audio_s"] + 2 * body["gap_s"], abs=0.2), "gaps are part of the length"


def test_the_estimate_reads_the_cache_without_writing_to_it(tmp_path, monkeypatch):
    """Estimating a scene reads cache metadata without creating or changing cache files."""
    client, nomi, _out = _mk_app(tmp_path, monkeypatch)
    before = sorted(p.name for p in (tmp_path / "cache").rglob("*")) if (
        tmp_path / "cache").exists() else []
    client.post("/v1/audio/scene/estimate", json={"items": _items(5)})
    after = sorted(p.name for p in (tmp_path / "cache").rglob("*")) if (
        tmp_path / "cache").exists() else []
    assert before == after, "the estimate created cache directories for audio nobody asked for"


def test_an_unspeakable_message_is_counted_in_the_estimate_too(tmp_path, monkeypatch):
    """§9 again: skipped, counted, never silently dropped — so the bar's "74 character
    messages" is the number that will actually be rendered."""
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    body = client.post("/v1/audio/scene/estimate",
                       json={"items": [{"input": "real", "character": "K"},
                                       {"input": "  ", "character": "K"}]}).get_json()
    assert body["total"] == 1 and body["skipped"] == 1


def test_the_estimate_is_bounded_like_the_build(tmp_path, monkeypatch):
    client, _nomi, _out = _mk_app(tmp_path, monkeypatch)
    many = [{"input": "x", "character": "K"}] * (vsh.MAX_SCENE_ITEMS + 1)
    assert client.post("/v1/audio/scene/estimate", json={"items": many}).status_code == 400


# ── §8: the route knows nothing about SillyTavern ────────────────────────────────────────

def test_a_nomi_range_builds_through_the_same_route(tmp_path, monkeypatch):
    """Nomi ranges use the shared scene-building route while retaining their owner metadata."""
    client, _nomi, out = _mk_app(tmp_path, monkeypatch)
    items = [{"input": f"a nomi line {i}", "mesid": i} for i in range(3)]
    r = client.post("/v1/audio/scene", json={"title": "A Nomi scene", "source": "nomi",
                                             "owner": 'nomi:Test User', "items": items})
    assert r.status_code == 202, r.get_json()
    done = _wait(client, r.get_json()["job_id"])
    assert done["status"] == "done", done
    mp3, y = scenes.scene_paths(scenes.scenes_root(out), done["ref"])
    assert mp3.is_file()
    meta = scenes.read_manifest(y)
    assert meta["source"] == "nomi" and meta["owner"] == 'nomi:Test User'
    assert len(meta["entries"]) == 3


def test_a_nomi_scene_and_an_st_scene_land_in_the_same_store(tmp_path, monkeypatch):
    """§8: "both file into the same library." One store, one Clips tab, no second vocabulary."""
    client, _nomi, out = _mk_app(tmp_path, monkeypatch)
    a = client.post("/v1/audio/scene", json={"title": "From ST", "items": _items(2)}).get_json()
    _wait(client, a["job_id"])
    b = client.post("/v1/audio/scene", json={
        "title": "From Nomi", "source": "nomi", "owner": 'nomi:Test User',
        "items": [{"input": "a nomi line", "mesid": 0}]}).get_json()
    _wait(client, b["job_id"])
    listed = scenes.list_scenes(scenes.scenes_root(out))
    assert {s["name"] for s in listed} == {"From ST", "From Nomi"}
