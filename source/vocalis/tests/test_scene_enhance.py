"""Tests for scene enhancement eligibility, twin creation, cancellation, progress, and shared GPU ownership."""
import sys
import threading
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import scene_enhance                                       # noqa: E402
import scenes                                              # noqa: E402
from vocalis.web.clips import create_clips_blueprint       # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    import book_to_audio
    import vocalis.web.clips as clips_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", tmp_path / "output")
    app = Flask(__name__)
    app.register_blueprint(create_clips_blueprint())
    return app.test_client()


@pytest.fixture
def root(tmp_path):
    r = scenes.scenes_root(tmp_path / "output")
    r.mkdir(parents=True, exist_ok=True)
    return r


@pytest.fixture(autouse=True)
def _clean_gate_and_jobs():
    """The gate and the job registry are module-level and shared. A leaked card would make the
    NEXT test's claim fail for a reason that has nothing to do with it."""
    from vocalis.runtime.gpu import GPUS
    scene_enhance.JOBS.clear()
    yield
    for d in list(getattr(GPUS, "_cards", ())):
        GPUS.release_card(d)
    scene_enhance.JOBS.clear()


def _mk(root: Path, stem: str, meta=None):
    (root / f"{stem}.mp3").write_bytes(b"ID3 fake audio")
    scenes.write_manifest(root / f"{stem}.yaml",
                          meta or {"title": "A scene", "entries": [], "total_duration_s": 60.0})
    return stem


@pytest.fixture
def enhanceable(monkeypatch):
    """A box that CAN enhance, with one card and a band-limited scene — so the four refusals
    below each fail for their own reason and not because the box is unavailable."""
    from vocalis.runtime import enhancement
    import enhance
    monkeypatch.setattr(enhancement, "enhance_available", lambda: True)
    monkeypatch.setattr(enhancement, "enhance_cards", lambda: ["cuda:0"])
    monkeypatch.setattr(enhance, "bandwidth_of", lambda mp3, meta: (11000, True))
    monkeypatch.setattr(enhance, "is_band_limited", lambda hz: True)
    monkeypatch.setattr(enhance, "estimate_seconds", lambda dur, nfe: 131.0 + 0.285 * dur)
    started = []
    monkeypatch.setattr(scene_enhance, "start",
                        lambda ref, **kw: started.append((ref, kw)) or scene_enhance.EnhanceJob(
                            id="job-1", src_ref=ref, device=kw.get("device", "")))
    return started


# ── the 202 ──────────────────────────────────────────────────────────────────────────────

def test_a_scene_can_be_enhanced_from_its_row(client, root, enhanceable):
    _mk(root, "ferry_ab12cd34")
    r = client.post("/clips/scenes/ferry_ab12cd34/enhance", json={})
    assert r.status_code == 202, r.get_json()
    body = r.get_json()
    assert body["job_id"] and body["device"] == "cuda:0"
    # 131 s of startup plus 0.285 compute-seconds per audio-second, on a 60 s scene.
    assert body["est_s"] == pytest.approx(148.1, abs=0.5)
    assert enhanceable[0][0] == "ferry_ab12cd34"


def test_an_untimed_box_says_null_and_never_zero(client, root, enhanceable, monkeypatch):
    """A 0 would render as "0 s" — an enhancement that takes eight minutes advertised as
    instant. `enhance_rate`'s rule: no measurement, no figure."""
    import enhance
    monkeypatch.setattr(enhance, "estimate_seconds", lambda dur, nfe: None)
    _mk(root, "ferry_ab12cd34")
    assert client.post("/clips/scenes/ferry_ab12cd34/enhance", json={}).get_json()["est_s"] is None


def test_an_estimate_that_raises_cannot_leak_the_card(client, root, enhanceable, monkeypatch):
    """11.2.7 — the estimate reads the rate file through the vault and can raise. It used to run
    AFTER the card was claimed and before the `try` that releases it, so a raise leaked the card —
    and the server-side queue retries a start that raises every 30 s, one leaked card each time."""
    import enhance
    from vocalis.runtime.gpu import GPUS

    def boom(dur, nfe):
        raise RuntimeError("rate file unreadable")
    monkeypatch.setattr(enhance, "estimate_seconds", boom)
    _mk(root, "ferry_ab12cd34")
    assert client.post("/clips/scenes/ferry_ab12cd34/enhance", json={}).status_code == 500
    assert not getattr(GPUS, "_cards", None), "no card is left claimed"


def test_a_missing_scene_is_a_404(client, root, enhanceable):
    assert client.post("/clips/scenes/nope_00000000/enhance", json={}).status_code == 404


# ── the refusals, four distinct messages ─────────────────────────────────────────────────

def test_an_unavailable_box_says_WHICH_of_the_two_reasons(client, root, monkeypatch):
    """The unavailable message distinguishes a missing environment from an unticked GPU."""
    from vocalis.runtime import enhancement
    monkeypatch.setattr(enhancement, "enhance_available", lambda: False)
    monkeypatch.setattr(enhancement.configs, "enhance_cfg",
                        lambda: type("C", (), {"available": True})())
    monkeypatch.setattr(enhancement, "enhance_cards", lambda: [])
    _mk(root, "ferry_ab12cd34")
    r = client.post("/clips/scenes/ferry_ab12cd34/enhance", json={})
    assert r.status_code == 400
    assert "Settings" in r.get_json()["error"], "it must name the checkbox, not the installer"


# 🔴 7.5.1 — THE TWO REFUSALS BELOW USED TO BE FLAG-BASED, AND BOTH ARE GONE.
#
# Eligibility uses measured audio bandwidth rather than the manifest flag or twin relationship.
# This keeps interrupted or stale metadata from hiding the retry control.

def test_enhancing_an_enhanced_take_is_ALLOWED_and_answered_by_a_measurement(
        client, root, enhanceable, monkeypatch):
    """An enhanced flag alone does not determine eligibility; the measured audio bandwidth does."""
    import enhance
    # ⚠️ BOTH, and the fixture is why: `enhanceable` pins `is_band_limited` to True so its own
    # refusals fail for their own reasons. Patching only `bandwidth_of` here leaves that stub
    # answering "band-limited" about 16 kHz audio, and the route starts a job — which is what this
    # test caught on its first run.
    monkeypatch.setattr(enhance, "bandwidth_of", lambda mp3, meta: (16_000, True))
    monkeypatch.setattr(enhance, "is_band_limited", lambda hz: False)
    _mk(root, "ferry_ff00ff00", {"title": "The ferry", "enhanced": True,
                                 "raw_ref": "ferry_ab12cd34", "entries": []})
    r = client.post("/clips/scenes/ferry_ff00ff00/enhance", json={})
    assert r.status_code == 409
    body = r.get_json()
    assert body["error"] == "already full quality"
    assert body["bandwidth_hz"] == 16_000, "the measurement IS the answer — it has to be in it"


def test_a_take_flagged_enhanced_that_is_NOT_full_band_enhances(client, root, enhanceable,
                                                                monkeypatch):
    """A take below full bandwidth remains eligible even when its manifest flag is set."""
    import enhance
    monkeypatch.setattr(enhance, "bandwidth_of", lambda mp3, meta: (8_000, True))
    _mk(root, "ferry_ff00ff00", {"title": "The ferry", "enhanced": True,
                                 "raw_ref": "ferry_ab12cd34", "entries": []})
    r = client.post("/clips/scenes/ferry_ff00ff00/enhance", json={})
    assert r.status_code == 202, r.get_json()


def test_a_scene_that_already_has_a_twin_can_be_enhanced_again(client, root, enhanceable):
    """A repeated enhancement replaces the existing twin rather than creating another identity."""
    _mk(root, "ferry_ab12cd34")
    _mk(root, "ferry_enhanced_99887766", {"title": "The ferry", "enhanced": True,
                                          "raw_ref": "ferry_ab12cd34", "entries": []})
    r = client.post("/clips/scenes/ferry_ab12cd34/enhance", json={})
    assert r.status_code == 202, r.get_json()


def test_an_unmeasurable_scene_is_refused_rather_than_guessed_at(client, root, enhanceable,
                                                                 monkeypatch):
    """🔴 Unknown and full-band are NOT the same answer. `is_band_limited` folds them together
    deliberately — a probe that failed is not a license to spend a card — but here the route is
    deciding what to TELL him, and "already full quality" about a file we could not read is
    simply false."""
    import enhance
    monkeypatch.setattr(enhance, "bandwidth_of", lambda mp3, meta: (None, True))
    _mk(root, "ferry_ab12cd34")
    r = client.post("/clips/scenes/ferry_ab12cd34/enhance", json={})
    assert r.status_code == 409
    assert "couldn't measure" in r.get_json()["error"]


def test_a_full_band_scene_is_refused_with_its_measurement(client, root, enhanceable,
                                                           monkeypatch):
    import enhance
    monkeypatch.setattr(enhance, "is_band_limited", lambda hz: False)
    _mk(root, "ferry_ab12cd34")
    r = client.post("/clips/scenes/ferry_ab12cd34/enhance", json={})
    assert r.status_code == 409
    assert r.get_json()["bandwidth_hz"] == 11000


def test_the_same_scene_cannot_be_enhanced_twice_at_once(client, root, enhanceable):
    """Per SCENE, not per box: two scenes on two cards is two child processes on two cards,
    which is what the book's own post-pass has always done. What must not happen is two writers
    racing for one twin path."""
    _mk(root, "ferry_ab12cd34")
    scene_enhance.JOBS["live"] = scene_enhance.EnhanceJob(id="live", src_ref="ferry_ab12cd34",
                                                          status="enhancing")
    r = client.post("/clips/scenes/ferry_ab12cd34/enhance", json={})
    assert r.status_code == 409
    assert r.get_json()["error"]["job_id"] == "live"


# ── 🔴 §2.3: the card ────────────────────────────────────────────────────────────────────

def test_the_card_is_claimed_for_the_life_of_the_job(client, root, monkeypatch):
    """🔴 THE TEST THE DEFECT NEVER HAD. `GpuGate.acquire()` consults `_render` and `_cards` and
    nothing else — not the voicetrain card locks — so an enhancement that does not `claim_card`
    is INVISIBLE to it and a render is granted every card while 21 GB of enhancer sits on one.

    Asserted from the gate's side rather than by inspecting the route, because the property that
    matters is "a render cannot start", not "a particular function was called".
    """
    from vocalis.runtime import enhancement
    from vocalis.runtime.gpu import GPUS
    import enhance

    monkeypatch.setattr(enhancement, "enhance_available", lambda: True)
    monkeypatch.setattr(enhancement, "enhance_cards", lambda: ["cuda:0"])
    monkeypatch.setattr(enhance, "bandwidth_of", lambda mp3, meta: (11000, True))
    monkeypatch.setattr(enhance, "is_band_limited", lambda hz: True)

    running, release = threading.Event(), threading.Event()

    def slow_enhance(job, src, dst, nfe, device, label):
        running.set()
        release.wait(10)
        return False                       # "canceled" — the shortest path out of the body

    monkeypatch.setattr(enhancement, "enhance_one", slow_enhance)
    monkeypatch.setattr(enhancement, "decode_to_wav", lambda src, dst: dst.write_bytes(b"RIFF"))

    assert GPUS.acquire(blocking=False), "a render could not start even before the enhancement"
    GPUS.release()

    _mk(root, "ferry_ab12cd34")
    r = client.post("/clips/scenes/ferry_ab12cd34/enhance", json={})
    assert r.status_code == 202, r.get_json()
    assert running.wait(10), "the job never started"

    assert "cuda:0" in GPUS._cards, "the card was never claimed"
    assert not GPUS.acquire(blocking=False), \
        "a RENDER was granted every card while an enhancement held one — §2.3's defect"

    release.set()
    for _ in range(200):
        if not GPUS._cards:
            break
        threading.Event().wait(0.05)
    assert "cuda:0" not in GPUS._cards, "the card was never released"
    assert GPUS.acquire(blocking=False), "a render must be possible again afterward"
    GPUS.release()


def test_a_thread_that_will_not_start_does_not_lose_the_card(client, root, monkeypatch):
    """🔴 No thread means no `finally`, and the card is then gone for the life of the process:
    no render could ever start again and no other enhancement could have it. A background
    tidy-up must not be able to take the whole app down with it."""
    from vocalis.runtime import enhancement
    from vocalis.runtime.gpu import GPUS
    import enhance

    monkeypatch.setattr(enhancement, "enhance_available", lambda: True)
    monkeypatch.setattr(enhancement, "enhance_cards", lambda: ["cuda:0"])
    monkeypatch.setattr(enhance, "bandwidth_of", lambda mp3, meta: (11000, True))
    monkeypatch.setattr(enhance, "is_band_limited", lambda hz: True)

    def no_thread(self):
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading.Thread, "start", no_thread)
    _mk(root, "ferry_ab12cd34")
    # The route re-raises; Flask's test client turns that into a 500. Either way what matters is
    # what the `except` around `Thread.start()` did on the way past.
    assert client.post("/clips/scenes/ferry_ab12cd34/enhance", json={}).status_code == 500
    assert "cuda:0" not in GPUS._cards, "the card was leaked by the thread-start failure"


# ── the twin's identity, which MOVED and must not have changed ───────────────────────────

def test_the_twin_carries_the_raw_scenes_nonce_and_points_back_at_it(tmp_path, monkeypatch):
    """🔴 §4.1's warning, made a test. The identity derivation looks like boilerplate and is not:

    * the RAW scene's `nonce` is carried across, not re-minted — otherwise the twins of two
      scenes built in the same second collide even though the raws did not;
    * `raw_ref` is the ONLY thing linking a twin to its source, and the Clips filter reads it;
    * `enhanced=True` and `nfe` are folded into the hash, so the pair can never race for a path;
    * it encodes at 256 kbps, not the 96 kbps speech profile.
    """
    from vocalis.runtime import enhancement
    import playground_clips

    out = tmp_path / "output"
    sroot = scenes.scenes_root(out)
    sroot.mkdir(parents=True, exist_ok=True)
    meta = {"title": "The ferry", "owner": "st:Test User", "gap_s": 0.7, "created": "2026-08-01T10:00:00",
            "nonce": "NONCE-FROM-THE-RAW-BUILD", "enhanced": False, "total_duration_s": 60.0,
            "entries": [{"cache_key": "k0"}, {"cache_key": "k1"}]}
    (sroot / "ferry_ab12cd34.mp3").write_bytes(b"ID3 raw")
    scenes.write_manifest(sroot / "ferry_ab12cd34.yaml", meta)

    monkeypatch.setattr(enhancement, "decode_to_wav", lambda src, dst: dst.write_bytes(b"RIFF"))
    monkeypatch.setattr(enhancement, "enhance_one",
                        lambda job, src, dst, nfe, device, label: dst.write_bytes(b"RIFFdone") or True)
    encoded = {}
    monkeypatch.setattr(playground_clips, "encode_mp3",
                        lambda src, dst, bitrate=None: (encoded.update({"bitrate": bitrate})
                                                        or dst.write_bytes(b"ID3 enhanced")))

    job = scene_enhance.EnhanceJob(id="j1", src_ref="ferry_ab12cd34", title="The ferry",
                                   nfe=32, device="cuda:0")
    scene_enhance.run_enhance(job, output_dir=out, scratch_root=tmp_path / "scratch")

    assert job.status == "done", job.error
    twin = scenes.read_manifest(sroot / f"{job.ref}.yaml")
    assert twin["raw_ref"] == "ferry_ab12cd34"
    assert twin["enhanced"] is True and twin["nfe"] == 32
    # ⚠️ This one only proves the twin's MANIFEST kept the field — it is copied from the raw's,
    # so it would survive even if the HASH were derived from a fresh nonce. The test below is the
    # one that pins the hash, and it is the one that goes red when the nonce is re-minted.
    assert twin["nonce"] == "NONCE-FROM-THE-RAW-BUILD"
    assert twin["entries"] == meta["entries"], "the twin keeps the chapter list"
    assert encoded["bitrate"] == "256k"
    assert job.ref != "ferry_ab12cd34" and "enhanced" in job.ref

    # And the RAW scene is untouched — it is a product, not an intermediate.
    assert (sroot / "ferry_ab12cd34.mp3").read_bytes() == b"ID3 raw"
    assert scenes.read_manifest(sroot / "ferry_ab12cd34.yaml")["enhanced"] is False


# ── 7.5.1: the twin's LENGTH is measured, and that is the difference between a number and a
#           claim ──────────────────────────────────────────────────────────────────────────

def _enhance_once(tmp_path, monkeypatch, *, probe, raw_duration=4440.0):
    """Run one enhancement with everything expensive faked, and hand back the twin's manifest.

    `probe` stands in for `ffprobe_duration` on the enhancer's OUTPUT — which is the subject of
    the whole fix: what actually came out, rather than what the raw scene said went in.
    """
    from vocalis.runtime import enhancement
    import playground_clips

    out = tmp_path / "output"
    sroot = scenes.scenes_root(out)
    sroot.mkdir(parents=True, exist_ok=True)
    meta = {"title": "Test Character 2", "owner": "", "gap_s": 0.0, "created": "2026-08-14T01:44:49",
            "nonce": "N1", "total_duration_s": raw_duration, "entries": [{"cache_key": "k0"}]}
    (sroot / "Test_Character_2_ab12cd34.mp3").write_bytes(b"ID3 raw")
    scenes.write_manifest(sroot / "Test_Character_2_ab12cd34.yaml", meta)

    monkeypatch.setattr(enhancement, "decode_to_wav", lambda src, dst: dst.write_bytes(b"RIFF"))
    monkeypatch.setattr(enhancement, "enhance_one",
                        lambda job, src, dst, nfe, device, label: dst.write_bytes(b"RIFFdone") or True)
    monkeypatch.setattr(playground_clips, "encode_mp3",
                        lambda src, dst, bitrate=None: dst.write_bytes(b"ID3 enhanced"))
    monkeypatch.setattr(scene_enhance, "ffprobe_duration", probe)

    job = scene_enhance.EnhanceJob(id="j1", src_ref="Test_Character_2_ab12cd34", title="Test Character 2",
                                   nfe=32, device="cuda:0")
    scene_enhance.run_enhance(job, output_dir=out, scratch_root=tmp_path / "scratch")
    assert job.status == "done", job.error
    return scenes.read_manifest(sroot / f"{job.ref}.yaml")


def test_the_twins_duration_is_MEASURED_not_inherited_from_the_raw(tmp_path, monkeypatch):
    """The enhanced twin duration is measured from its output audio."""
    twin = _enhance_once(tmp_path, monkeypatch, probe=lambda p: 4440.0)
    assert twin["total_duration_s"] == 4440.0

    # The one that matters: the enhancer's output is SHORT, and the twin must say so instead of
    # repeating the raw's 74 minutes.
    twin = _enhance_once(tmp_path, monkeypatch, probe=lambda p: 1200.0)
    assert twin["total_duration_s"] == 1200.0, (
        "the twin inherited the raw's length instead of measuring its own — this is exactly the "
        "bug: a 20-minute twin of a 74-minute scene, reported as 74 minutes")


def test_an_unmeasurable_twin_says_NOTHING_rather_than_repeating_the_raws_length(
        tmp_path, monkeypatch):
    """⚠️ A probe that fails must leave the field ABSENT, not fall back to the inherited value.

    `list_scenes` renders a missing duration as an empty Length cell, which is honest — "we do
    not know how long this is" — whereas the fallback is the original defect wearing a
    try/except. The same asymmetric-strictness rule `read_manifest` follows: a read degrades, but
    it degrades to *nothing*, never to a confident wrong answer.
    """
    def boom(p):
        raise OSError("ffprobe is not installed")

    twin = _enhance_once(tmp_path, monkeypatch, probe=boom)
    assert "total_duration_s" not in twin, (
        f"an unmeasurable twin kept a length of {twin.get('total_duration_s')!r} — inherited from "
        "the raw scene, which is the very thing this fix removes")


def test_the_hash_is_derived_the_same_way_the_build_used_to_derive_it(tmp_path, monkeypatch):
    """The move must not change WHERE the twin lands. Recomputed here from the manifest, exactly
    as `_enhance_into_second_artifact` did, and compared with what the module produced."""
    from vocalis.runtime import enhancement
    import playground_clips

    out = tmp_path / "output"
    sroot = scenes.scenes_root(out)
    sroot.mkdir(parents=True, exist_ok=True)
    meta = {"title": "The ferry", "owner": "st:Test User", "gap_s": 0.7,
            "created": "2026-08-01T10:00:00", "nonce": "N1", "total_duration_s": 60.0,
            "entries": [{"cache_key": "k0"}, {"cache_key": "k1"}]}
    (sroot / "ferry_ab12cd34.mp3").write_bytes(b"ID3 raw")
    scenes.write_manifest(sroot / "ferry_ab12cd34.yaml", meta)

    monkeypatch.setattr(enhancement, "decode_to_wav", lambda src, dst: dst.write_bytes(b"RIFF"))
    monkeypatch.setattr(enhancement, "enhance_one",
                        lambda *a, **k: a[2].write_bytes(b"RIFFdone") or True)
    monkeypatch.setattr(playground_clips, "encode_mp3",
                        lambda src, dst, bitrate=None: dst.write_bytes(b"ID3 enhanced"))

    job = scene_enhance.EnhanceJob(id="j1", src_ref="ferry_ab12cd34", title="The ferry",
                                   nfe=32, device="cuda:0")
    scene_enhance.run_enhance(job, output_dir=out, scratch_root=tmp_path / "scratch")

    expect_h = scenes.scene_hash(title="The ferry", owner="st:Test User", gap_s=0.7,
                                 cache_keys=["k0", "k1"], created="2026-08-01T10:00:00",
                                 nonce="N1", enhanced=True, nfe=32)
    assert job.ref == scenes.scene_stem("The ferry", expect_h, enhanced=True)


def test_a_failed_enhance_leaves_the_raw_scene_alone(tmp_path, monkeypatch):
    """Moved here from test_scene_build.py, where it guarded the build phase. The rule did not
    change: the raw scene is complete, playable and downloadable, and a second pass that throws
    must not take it — or its row — down."""
    from vocalis.runtime import enhancement

    out = tmp_path / "output"
    sroot = scenes.scenes_root(out)
    sroot.mkdir(parents=True, exist_ok=True)
    (sroot / "ferry_ab12cd34.mp3").write_bytes(b"ID3 raw")
    scenes.write_manifest(sroot / "ferry_ab12cd34.yaml", {"title": "The ferry", "entries": []})

    monkeypatch.setattr(enhancement, "decode_to_wav", lambda src, dst: dst.write_bytes(b"RIFF"))
    monkeypatch.setattr(enhancement, "enhance_one",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("the enhancer fell over")))
    job = scene_enhance.EnhanceJob(id="j1", src_ref="ferry_ab12cd34", device="cuda:0")
    scene_enhance.run_enhance(job, output_dir=out, scratch_root=tmp_path / "scratch")

    assert job.status == "failed" and "fell over" in job.error
    assert (sroot / "ferry_ab12cd34.mp3").read_bytes() == b"ID3 raw"
    assert job.ref is None


def test_a_cancel_AFTER_the_enhancer_finished_still_makes_no_twin(tmp_path, monkeypatch):
    """Cancellation after processing but before commit must not leave a twin."""
    from vocalis.runtime import enhancement
    import playground_clips

    out = tmp_path / "output"
    sroot = scenes.scenes_root(out)
    sroot.mkdir(parents=True, exist_ok=True)
    (sroot / "ferry_ab12cd34.mp3").write_bytes(b"ID3 raw")
    scenes.write_manifest(sroot / "ferry_ab12cd34.yaml", {"title": "The ferry", "entries": []})

    job = scene_enhance.EnhanceJob(id="j1", src_ref="ferry_ab12cd34", title="The ferry",
                                   device="cuda:0")

    def enhanced_then_canceled(job_, src, dst, nfe, device, label):
        dst.write_bytes(b"RIFFdone")
        job_.cancel.set()          # the click lands while the encode is about to start
        return True                # ...but the enhancer itself completed

    monkeypatch.setattr(enhancement, "decode_to_wav", lambda src, dst: dst.write_bytes(b"RIFF"))
    monkeypatch.setattr(enhancement, "enhance_one", enhanced_then_canceled)
    encoded = []
    monkeypatch.setattr(playground_clips, "encode_mp3",
                        lambda src, dst, bitrate=None: encoded.append(dst))

    scene_enhance.run_enhance(job, output_dir=out, scratch_root=tmp_path / "scratch")

    assert job.status == "canceled" and job.ref is None
    assert not encoded, "it encoded a twin for a job that had been canceled"
    assert list(sroot.glob("*enhanced*")) == [], "a canceled enhance left a twin behind"
    assert (sroot / "ferry_ab12cd34.mp3").read_bytes() == b"ID3 raw"


def test_a_canceled_enhance_is_not_a_failure(tmp_path, monkeypatch):
    """`enhance_one` returns False when the cancel event fires. Nothing was made, nothing was
    undone, and the raw scene stands — so the job says `canceled`, not `failed`."""
    from vocalis.runtime import enhancement

    out = tmp_path / "output"
    sroot = scenes.scenes_root(out)
    sroot.mkdir(parents=True, exist_ok=True)
    (sroot / "ferry_ab12cd34.mp3").write_bytes(b"ID3 raw")
    scenes.write_manifest(sroot / "ferry_ab12cd34.yaml", {"title": "The ferry", "entries": []})

    monkeypatch.setattr(enhancement, "decode_to_wav", lambda src, dst: dst.write_bytes(b"RIFF"))
    monkeypatch.setattr(enhancement, "enhance_one", lambda *a, **k: False)
    job = scene_enhance.EnhanceJob(id="j1", src_ref="ferry_ab12cd34", device="cuda:0")
    scene_enhance.run_enhance(job, output_dir=out, scratch_root=tmp_path / "scratch")

    assert job.status == "canceled" and job.ref is None
    assert (sroot / "ferry_ab12cd34.mp3").is_file()


# ── polling and canceling ───────────────────────────────────────────────────────────────

def test_the_status_and_cancel_pair_answer_by_job_id(client):
    job = scene_enhance.EnhanceJob(id="j9", src_ref="ferry_ab12cd34", status="enhancing")
    scene_enhance.JOBS["j9"] = job
    assert client.get("/clips/scenes/enhance/j9").get_json()["status"] == "enhancing"
    assert client.get("/clips/scenes/enhance/nope").status_code == 404
    assert client.post("/clips/scenes/enhance/j9/cancel", json={}).status_code == 200
    assert job.cancel.is_set()
    assert client.post("/clips/scenes/enhance/nope/cancel", json={}).status_code == 404


def test_the_two_url_shapes_cannot_collide(client, root, enhanceable):
    """⚠️ `/clips/scenes/enhance/<job_id>` and `/clips/scenes/<ref>/enhance` share a prefix. A
    scene ref is `<slug>_<h8>` and the static segment wins in Werkzeug — asserted rather than
    assumed, because the failure would be a poll that silently started an enhancement."""
    _mk(root, "enhance_ab12cd34")     # a scene whose slug is literally "enhance"
    assert client.get("/clips/scenes/enhance/ab12cd34").status_code == 404   # a poll, not a start
    assert client.post("/clips/scenes/enhance_ab12cd34/enhance", json={}).status_code == 202


# ── 9.2.1: the three figures a progress bar is made of ───────────────────────────────────
#
# The status response must expose progress fields that change during work; otherwise the row can
# only display a static "Enhancing…" message for the full job.


def test_the_status_carries_nothing_that_moves_until_the_enhancer_starts(client):
    """`elapsed_s` is None before `started` is stamped, and that is the client's signal to show a
    PHASE rather than a fraction. A zero would be a bar claiming to have begun."""
    job = scene_enhance.EnhanceJob(id="jbar", src_ref="ferry_ab12cd34", est_s=148.1)
    scene_enhance.JOBS["jbar"] = job
    d = job.as_dict()
    assert d["elapsed_s"] is None and d["phase"] is None and d["line"] is None
    assert d["est_s"] == 148.1


def test_the_status_ROUTE_reports_the_progress_fields(client):
    """Through the route, not off the dataclass: the client reads JSON, and a field `as_dict`
    computes but the route drops is a bar that never moves for a reason nothing on screen
    explains."""
    import time as _t
    job = scene_enhance.EnhanceJob(id="jbar", src_ref="ferry_ab12cd34", est_s=100.0,
                                   status="enhancing")
    job.phase = "encoding"
    job.started = _t.time() - 12
    scene_enhance.JOBS["jbar"] = job
    body = client.get("/clips/scenes/enhance/jbar").get_json()
    assert body["phase"] == "encoding"
    assert 11.0 <= body["elapsed_s"] <= 60.0, body
    assert body["est_s"] == 100.0


def test_the_last_line_is_the_enhancers_own_and_it_is_bounded(client):
    """The one line worth surfacing is the card-lock wait — a job that has not started because a
    training owns the card, which is otherwise indistinguishable from one that has stalled.

    ⚠️ Derived from `events`, which `emit()` already fills, rather than stored a second time; and
    truncated, because it reaches a table cell and a stray traceback line would wreck the row."""
    job = scene_enhance.EnhanceJob(id="jbar", src_ref="ferry_ab12cd34")
    scene_enhance.JOBS["jbar"] = job
    job.events.append({"type": "log", "line": "Waiting for cuda:1 (a training is using it)…"})
    job.events.append({"type": "vram", "used": 21.0})       # not a log line, and not the answer
    assert job.as_dict()["line"].startswith("Waiting for cuda:1")
    job.events.append({"type": "log", "line": "x" * 900})
    assert len(job.as_dict()["line"]) == 200


def test_run_enhance_stamps_each_phase_AS_IT_REACHES_IT(tmp_path, monkeypatch):
    """🔴 THE JOIN, and the only check here that could catch a phase set in the wrong place.

    `as_dict` reporting `phase` proves nothing about whether anything ever writes it. This drives
    the real `run_enhance` with the expensive parts faked and records `job.phase` INSIDE each
    fake — so it reads the value at the moment that step is running, not afterward.

    The order is the whole claim: decoding (the mp3 → wav the enhancer needs), enhancing (the
    only span `est_s` describes — hence `started` being stamped here and nowhere earlier), then
    encoding (tens of seconds on a long scene, and NOT part of the estimate).
    """
    from vocalis.runtime import enhancement
    import playground_clips

    out = tmp_path / "output"
    sroot = scenes.scenes_root(out)
    sroot.mkdir(parents=True, exist_ok=True)
    (sroot / "ferry_ab12cd34.mp3").write_bytes(b"ID3 raw")
    scenes.write_manifest(sroot / "ferry_ab12cd34.yaml",
                          {"title": "The ferry", "entries": [{"cache_key": "k0"}],
                           "total_duration_s": 60.0})

    seen = {}

    def _decode(src_p, dst_p):
        seen["decode"] = (job.phase, job.started)
        dst_p.write_bytes(b"RIFF")

    def _enhance(j, src_p, dst_p, nfe, device, label):
        seen["enhance"] = (j.phase, j.started)
        dst_p.write_bytes(b"RIFFdone")
        return True

    def _encode(src_p, dst_p, bitrate=None):
        seen["encode"] = (job.phase, job.started)
        dst_p.write_bytes(b"ID3 enhanced")

    monkeypatch.setattr(enhancement, "decode_to_wav", _decode)
    monkeypatch.setattr(enhancement, "enhance_one", _enhance)
    monkeypatch.setattr(playground_clips, "encode_mp3", _encode)
    monkeypatch.setattr(scene_enhance, "ffprobe_duration", lambda p: 60.0)

    job = scene_enhance.EnhanceJob(id="jphase", src_ref="ferry_ab12cd34", title="The ferry",
                                   nfe=32, device="cuda:0")
    scene_enhance.run_enhance(job, output_dir=out, scratch_root=tmp_path / "scratch")

    assert job.status == "done", job.error
    assert seen["decode"][0] == "decoding"
    assert seen["enhance"][0] == "enhancing"
    assert seen["encode"][0] == "encoding"
    # 🔴 The clock starts WITH the enhancer and not before it. `est_s` is model load plus
    # rate × audio-seconds, so measuring from the decode would put a fraction's numerator and
    # denominator on two different subjects.
    assert seen["decode"][1] is None, "nothing may be elapsing while the mp3 is being decoded"
    assert seen["enhance"][1] is not None and seen["encode"][1] is not None
    # And a finished job stops claiming to be in a phase — the row is gone by then, and a status
    # that still said "encoding" would leave anything reading it describing a job that has ended.
    assert job.as_dict()["phase"] is None


# ── 9.2.2: a running enhancement has to be visible to a page that did not start it ───────


def test_the_active_route_lists_what_is_running_and_nothing_else(client):
    """The active route exposes running enhancement jobs without unrelated scene content."""
    import time as _t
    running = scene_enhance.EnhanceJob(id="jrun", src_ref="ferry_ab12cd34", status="enhancing",
                                       est_s=100.0, device="cuda:0")
    running.phase = "enhancing"
    running.started = _t.time() - 5
    queued = scene_enhance.EnhanceJob(id="jq", src_ref="dusk_ab12cd35", status="queued")
    for j, s in ((running, "enhancing"), (queued, "queued"),
                 (scene_enhance.EnhanceJob(id="jdone", src_ref="old_ab12cd36",
                                           status="done"), "done"),
                 (scene_enhance.EnhanceJob(id="jcan", src_ref="can_ab12cd37",
                                           status="canceled"), "canceled")):
        j.status = s
        scene_enhance.JOBS[j.id] = j

    body = client.get("/clips/scenes/enhance").get_json()
    ids = {j["job_id"] for j in body["jobs"]}
    assert ids == {"jrun", "jq"}, body
    live = next(j for j in body["jobs"] if j["job_id"] == "jrun")
    # It carries everything the row needs to paint itself: the bar, the phase, and the id the ■
    # posts to. A list that named the jobs but not their progress would need a second round trip
    # per row before anything could be drawn.
    assert live["src_ref"] == "ferry_ab12cd34"
    assert live["est_s"] == 100.0 and live["elapsed_s"] >= 4.0
    assert live["phase"] == "enhancing"


def test_the_active_route_and_the_start_route_cannot_collide(client, root, enhanceable):
    """⚠️ `/clips/scenes/enhance` (this list) shares a prefix with `/clips/scenes/<ref>/enhance`
    (start one) and `/clips/scenes/enhance/<job_id>` (poll one). Asserted rather than assumed —
    the failure mode is a page that starts an enhancement when it meant to ask what was running.
    """
    _mk(root, "enhance_ab12cd34")     # a scene whose slug is literally "enhance"
    assert client.get("/clips/scenes/enhance").status_code == 200          # the list
    assert client.get("/clips/scenes/enhance/ab12cd34").status_code == 404  # a poll, not a start
    assert client.post("/clips/scenes/enhance_ab12cd34/enhance", json={}).status_code == 202
