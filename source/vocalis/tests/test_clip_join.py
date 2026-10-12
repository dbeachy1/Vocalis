"""§7's Join — an ordered list of clips becomes one new scene (6.0-m2).

The interesting half is not the concat, it is the CODEC QUESTION that `mp3_concat.concat_mp3`
hands to this caller by name: a stream copy across inputs that disagree produces a file that
plays at the wrong speed from the second clip on, and ffmpeg does not reliably say so. Join is
precisely the verb that mixes profiles — a 96 kbps mono narration, its 256 kbps enhanced twin,
a 320 k stereo song, and an upload store that also holds wav/flac.

So most of this file drives REAL ffmpeg over REAL files with deliberately mismatched profiles
and then ffprobes the result. A mock would assert the branch was taken; only the real thing
asserts the output is playable at the right rate for its whole length.
"""
import subprocess
import sys
import threading
from pathlib import Path
from shutil import which

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import clip_join                                           # noqa: E402
import scenes                                              # noqa: E402


def _have_ffmpeg():
    return which("ffmpeg") and which("ffprobe")


needs_ffmpeg = pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")


def _tone(path: Path, secs=1.0, freq=440, *, rate=24000, ch=1, kbps=96):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={secs}",
                    "-ac", str(ch), "-ar", str(rate), "-b:a", f"{kbps}k",
                    str(path), "-loglevel", "error"], check=True)
    return path


def _probe(p: Path) -> dict:
    return clip_join.probe(p)


def _dur(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nokey=1:noprint_wrappers=1", str(p)],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


class _VtCfg:
    def __init__(self, d):
        self.training_dir = str(d)


def _job(**kw):
    kw.setdefault("id", "join0001")
    kw.setdefault("title", "Two takes")
    return clip_join.JoinJob(**kw)


# ── the profile decision, in isolation ───────────────────────────────────────────────────

def test_matching_profiles_are_stream_copied():
    p = {"codec": "mp3", "sample_rate": 24000, "channels": 1, "bit_rate": 96000}
    assert clip_join.profiles_agree([p, dict(p)])


def test_a_scene_and_its_enhanced_twin_still_stream_copy():
    """🔴 The single most likely thing anyone joins, and it must stay free. §3.5a keeps BOTH
    takes; they differ ONLY in bitrate, which MP3 handles per frame — a VBR file already does
    exactly this. Folding bitrate into the agreement test would force a full re-encode on the
    common case for no benefit."""
    raw = {"codec": "mp3", "sample_rate": 24000, "channels": 1, "bit_rate": 96000}
    enh = {"codec": "mp3", "sample_rate": 24000, "channels": 1, "bit_rate": 256000}
    assert clip_join.profiles_agree([raw, enh])


@pytest.mark.parametrize("other", [
    {"codec": "mp3", "sample_rate": 44100, "channels": 1, "bit_rate": 96000},   # rate
    {"codec": "mp3", "sample_rate": 24000, "channels": 2, "bit_rate": 96000},   # channels
    {"codec": "flac", "sample_rate": 24000, "channels": 1, "bit_rate": 96000},  # not mp3
    {"codec": "mp3", "sample_rate": None, "channels": 1, "bit_rate": 96000},    # unknown
])
def test_anything_that_breaks_playback_forces_a_reencode(other):
    base = {"codec": "mp3", "sample_rate": 24000, "channels": 1, "bit_rate": 96000}
    assert not clip_join.profiles_agree([base, other])


def test_an_unprobeable_input_is_treated_as_disagreeing():
    """An unknown profile is exactly the case where a stream copy is a gamble."""
    assert not clip_join.profiles_agree([{"codec": None, "sample_rate": None,
                                          "channels": None, "bit_rate": None}])


def test_the_reencode_target_is_the_best_of_the_inputs():
    """⚠️ Not the app's 96 kbps mono default. Joining a 320 k stereo song to a mono line and
    normalizing down would silently destroy the song — the user asked to join two things, not
    to degrade one."""
    t = clip_join.target_profile([
        {"sample_rate": 24000, "channels": 1, "bit_rate": 96000},
        {"sample_rate": 44100, "channels": 2, "bit_rate": 320000}])
    assert t == {"sample_rate": 44100, "channels": 2, "bitrate_k": 320}


def test_the_target_is_capped(tmp_path):
    t = clip_join.target_profile([{"sample_rate": 48000, "channels": 8, "bit_rate": 2_000_000}])
    assert t["channels"] == clip_join.MAX_CHANNELS
    assert t["bitrate_k"] == clip_join.MAX_BITRATE_K


# ── the real thing ───────────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_matching_clips_join_into_one_scene(tmp_path):
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "a.mp3", 1.0, 440)
    _tone(up / "b.mp3", 1.0, 660)
    vt = _VtCfg(up)

    job = _job(gap_s=0.5)
    clip_join.run_join(job, [{"kind": "upload", "ref": "a.mp3"},
                             {"kind": "upload", "ref": "b.mp3"}],
                       output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")

    assert job.status == "done", job.error
    assert job.ref and not job.reencoded          # same profile -> free path
    mp3, y = scenes.scene_paths(scenes.scenes_root(out), job.ref)
    assert mp3.exists()
    # 1.0 + 0.5 + 1.0, plus the per-file MP3 padding a concat always carries.
    assert 2.4 < _dur(mp3) < 2.9, _dur(mp3)


@needs_ffmpeg
def test_mismatched_clips_are_reencoded_and_still_play_end_to_end(tmp_path):
    """🔴 THE BUG §3.3 NAMES. Stream-copying a 44.1 kHz stereo clip after a 24 kHz mono one
    yields a file whose second half plays at the wrong rate — and whose DURATION is wrong, which
    is how this test catches it without listening. The re-encode branch must produce a file that
    is the sum of its parts."""
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "mono.mp3", 1.0, 440, rate=24000, ch=1, kbps=96)
    _tone(up / "stereo.mp3", 1.0, 660, rate=44100, ch=2, kbps=320)
    vt = _VtCfg(up)

    job = _job(gap_s=0.5)
    clip_join.run_join(job, [{"kind": "upload", "ref": "mono.mp3"},
                             {"kind": "upload", "ref": "stereo.mp3"}],
                       output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")

    assert job.status == "done", job.error
    assert job.reencoded is True
    mp3, _y = scenes.scene_paths(scenes.scenes_root(out), job.ref)
    got = _dur(mp3)
    assert 2.4 < got < 2.9, f"joined length is wrong ({got}) — the profiles did not reconcile"
    # And the output is ONE coherent profile, not a splice of two.
    prof = _probe(mp3)
    assert prof["codec"] == "mp3"
    assert prof["sample_rate"] == 44100 and prof["channels"] == 2


@needs_ffmpeg
def test_the_gap_silence_matches_the_output_profile_not_the_app_default(tmp_path):
    """🔴 `make_silence` defaults to 24 kHz mono. Splicing that into a 44.1 kHz stereo join is
    the exact failure its own comment warns about: the file plays at the wrong rate from the
    first gap onward. The duration is the tell."""
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "s1.mp3", 1.0, 440, rate=44100, ch=2, kbps=192)
    _tone(up / "s2.mp3", 1.0, 660, rate=48000, ch=2, kbps=192)
    vt = _VtCfg(up)

    job = _job(gap_s=1.0)
    clip_join.run_join(job, [{"kind": "upload", "ref": "s1.mp3"},
                             {"kind": "upload", "ref": "s2.mp3"}],
                       output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")
    assert job.status == "done", job.error
    mp3, _y = scenes.scene_paths(scenes.scenes_root(out), job.ref)
    got = _dur(mp3)
    assert 2.9 < got < 3.4, f"1s + 1s gap + 1s should be ~3s, got {got}"


@needs_ffmpeg
def test_the_manifest_gives_a_joined_scene_a_chapter_list(tmp_path):
    """§5's chapter list has to work on a joined scene exactly as on a built one — that is most
    of what makes a long file usable, and it falls out of the offsets."""
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "a.mp3", 1.0, 440)
    _tone(up / "b.mp3", 2.0, 660)
    vt = _VtCfg(up)

    job = _job(gap_s=0.5)
    clip_join.run_join(job, [{"kind": "upload", "ref": "a.mp3", "name": "first"},
                             {"kind": "upload", "ref": "b.mp3", "name": "second"}],
                       output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")
    _mp3, y = scenes.scene_paths(scenes.scenes_root(out), job.ref)
    meta = scenes.read_manifest(y)

    assert meta["source"] == "join" and meta["gap_s"] == 0.5
    offs = [e["offset_s"] for e in meta["entries"]]
    assert offs[0] == 0.0
    # second starts after the first clip PLUS the gap — both as whole MP3 frames, which is what
    # the join contains (a 0.5 s silence is ~0.504 s of frames), counted independently of the
    # build. The per-file format probe is not that on FFmpeg 8 (it trims gapless padding).
    from conftest import mp3_packet_length_s
    from scene_build import make_silence
    part0 = mp3_packet_length_s(up / "a.mp3")
    gap = mp3_packet_length_s(make_silence(tmp_path / "gap.mp3", 0.5))
    assert meta["entries"][0]["duration_s"] == pytest.approx(part0, abs=0.002)
    assert offs[1] == pytest.approx(part0 + gap, abs=0.002)
    # and the stored total is the finished file's own length, not the sum's arithmetic
    assert _dur(_mp3) == pytest.approx(meta["total_duration_s"], abs=0.06)
    assert [e["name"] for e in meta["entries"]] == ["first", "second"]
    # Each entry remembers WHICH store it came from — a joined scene is the one artifact whose
    # sources live in three different places.
    assert all(e["kind"] == "upload" for e in meta["entries"])


@needs_ffmpeg
def test_order_is_the_payloads_order_and_nothing_re_sorts_it(tmp_path):
    """§7: "default order is the order ticked, arrows fix the rest" — which makes ordering
    entirely the client's business. A server-side sort would silently undo every arrow press."""
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / 'sample-track.mp3', 1.0, 440)
    _tone(up / "apple.mp3", 2.0, 660)
    vt = _VtCfg(up)

    job = _job()
    clip_join.run_join(job, [{"kind": "upload", "ref": 'sample-track.mp3'},
                             {"kind": "upload", "ref": "apple.mp3"}],
                       output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")
    _mp3, y = scenes.scene_paths(scenes.scenes_root(out), job.ref)
    assert [e["ref"] for e in scenes.read_manifest(y)["entries"]] == ['sample-track.mp3', "apple.mp3"]


@needs_ffmpeg
def test_rejoining_the_same_clips_makes_a_SECOND_scene(tmp_path):
    """§1/§12: a scene is an artifact, not a render. `scene_hash` folds the creation timestamp
    in ON PURPOSE, so a re-join never lands on top of the first one."""
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "a.mp3", 1.0)
    vt = _VtCfg(up)
    items = [{"kind": "upload", "ref": "a.mp3"}]

    j1 = _job(id="j1")
    clip_join.run_join(j1, items, output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "s1")
    j2 = _job(id="j2")
    clip_join.run_join(j2, items, output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "s2")

    assert j1.ref and j2.ref and j1.ref != j2.ref
    assert len(scenes.list_scenes(scenes.scenes_root(out))) == 2


# ── failure and cancel ───────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_a_missing_clip_fails_the_join_by_name(tmp_path):
    """🔴 NAMED, not skipped. §9's rule about a skipped message applies with more force to the
    verb that has no cache to fall back on: a join is an explicit ordered list the user built by
    hand, and quietly dropping an item makes a file that is wrong in a way only listening finds."""
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "a.mp3", 1.0)
    vt = _VtCfg(up)

    job = _job()
    clip_join.run_join(job, [{"kind": "upload", "ref": "a.mp3"},
                             {"kind": "upload", "ref": "gone.mp3"}],
                       output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")
    assert job.status == "failed"
    assert "gone.mp3" in job.error
    # and nothing was written
    assert scenes.list_scenes(scenes.scenes_root(out)) == []


@needs_ffmpeg
def test_cancel_before_the_concat_writes_nothing(tmp_path):
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "a.mp3", 1.0)
    vt = _VtCfg(up)

    job = _job()
    job.cancel.set()
    clip_join.run_join(job, [{"kind": "upload", "ref": "a.mp3"}],
                       output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")
    assert job.status == "canceled"
    assert scenes.list_scenes(scenes.scenes_root(out)) == []


@needs_ffmpeg
def test_cancel_arriving_after_the_last_clip_resolves_still_stops_the_join(tmp_path):
    """The test above sets `cancel` before the run, so the resolve loop's very first check
    catches it. That was the only kind of cancel `run_join` could see.

    🔴 On the STREAM-COPY path there is no transcode loop, so once the last item is resolved the
    job stopped reading `cancel` entirely — and everything expensive is still ahead of it. Here
    the event arrives while the final clip is being probed, which is where a real cancel lands.
    """
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "a.mp3", 1.0)
    vt = _VtCfg(up)

    job = _job()
    real_probe = clip_join.probe

    def _probe_then_cancel(p):
        prof = real_probe(p)
        job.cancel.set()                     # the user hits Cancel mid-probe
        return prof

    clip_join.probe = _probe_then_cancel
    try:
        clip_join.run_join(job, [{"kind": "upload", "ref": "a.mp3"}],
                           output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")
    finally:
        clip_join.probe = real_probe

    assert job.status == "canceled"
    assert scenes.list_scenes(scenes.scenes_root(out)) == []


@needs_ffmpeg
def test_a_cancel_during_the_concat_takes_the_finished_file_back(tmp_path):
    """🔴 The concat is ONE subprocess and is not interrupted, so a cancel pressed while it runs
    arrives with the mp3 already landed in the store. §9: the partial is "discarded, never
    promoted" — which for this verb means actively removing it.

    Asserts the FILE is gone, not merely that `list_scenes` is empty: that listing is driven by
    manifests, so skipping the write alone would satisfy it while leaving orphaned audio in
    `output/scenes/` — sitting in the vault, counting against disk, belonging to no scene.
    """
    out = tmp_path / "output"
    up = tmp_path / "training"
    _tone(up / "a.mp3", 1.0)
    _tone(up / "b.mp3", 1.0)
    vt = _VtCfg(up)

    job = _job()
    real_concat = clip_join.mp3_concat.concat_mp3

    def _concat_then_cancel(paths, dest, **kw):
        p = real_concat(paths, dest, **kw)
        job.cancel.set()                     # Cancel pressed while ffmpeg was running
        return p

    clip_join.mp3_concat.concat_mp3 = _concat_then_cancel
    try:
        clip_join.run_join(job, [{"kind": "upload", "ref": "a.mp3"},
                                 {"kind": "upload", "ref": "b.mp3"}],
                           output_dir=out, vt_cfg=vt, scratch_root=tmp_path / "scratch")
    finally:
        clip_join.mp3_concat.concat_mp3 = real_concat

    assert job.status == "canceled"
    assert job.ref is None, "a canceled join must not hand the client a ref to play"
    sroot = scenes.scenes_root(out)
    left = sorted(p.name for p in Path(sroot).glob("*")) if Path(sroot).exists() else []
    assert left == [], f"a canceled join left files behind: {left}"


def test_an_empty_list_fails_rather_than_writing_an_empty_scene(tmp_path):
    job = _job()
    clip_join.run_join(job, [], output_dir=tmp_path / "output", vt_cfg=None,
                       scratch_root=tmp_path / "scratch")
    assert job.status == "failed" and job.error


def test_a_failure_before_the_work_starts_still_reaches_a_terminal_status(tmp_path, monkeypatch):
    """🔴 The wedge. `run_join` reports only through `job.status`, and `running()` reads
    "queued"/"probing"/"assembling" as a join in flight — which 409s every future join for the
    life of the process. So EVERY exit has to land on a terminal status, including a raise from
    the setup lines that look like plain assignments but touch the filesystem."""
    import scenes as scenes_mod
    monkeypatch.setattr(scenes_mod, "scenes_root",
                        lambda _out: (_ for _ in ()).throw(OSError("disk gone")))
    job = _job()
    clip_join.run_join(job, [{"kind": "upload", "ref": "a.mp3"}],
                       output_dir=tmp_path / "output", vt_cfg=None,
                       scratch_root=tmp_path / "scratch")
    assert job.status == "failed"
    assert "disk gone" in (job.error or "")


def test_a_second_join_is_refused_by_start_itself_not_by_a_prior_check(monkeypatch, tmp_path):
    """🔴 The guard has to hold the lock across BOTH the test and the registration.

    It used to be two steps in two places — the route called `running()`, and `start()` did the
    registering — so two POSTs could both find nothing in flight before either claimed the verb.
    Since the nonce fix the two joins no longer overwrite each other, which makes the symptom the
    pair of near-identical scenes this guard exists to prevent.

    Also asserts the refused join leaves NOTHING in `JOBS`: a phantom entry stuck at "queued"
    reads as in-flight forever and would 409 every join for the life of the process.
    """
    monkeypatch.setattr(clip_join, "JOBS", {})
    release = threading.Event()

    def _blocking(job, items, **kw):
        job.status = "assembling"
        release.wait(10)
        job.status = "done"
        return job

    monkeypatch.setattr(clip_join, "run_join", _blocking)
    args = dict(output_dir=tmp_path / "output", vt_cfg=None)
    first = clip_join.start("A", [{"kind": "upload", "ref": "a.mp3"}], **args)
    try:
        with pytest.raises(clip_join.JoinBusy) as caught:
            clip_join.start("B", [{"kind": "upload", "ref": "b.mp3"}], **args)
        assert caught.value.job.id == first.id, "the 409 must name the join actually running"
        assert list(clip_join.JOBS) == [first.id], "a refused join must not be registered"
    finally:
        release.set()


def test_running_only_reports_a_join_that_is_actually_in_flight(monkeypatch):
    monkeypatch.setattr(clip_join, "JOBS", {})
    for st in ("done", "failed", "canceled"):
        j = clip_join.JoinJob(id=f"j-{st}", title="x")
        j.status = st
        clip_join.JOBS[j.id] = j
    assert clip_join.running() is None, "a finished join must not 409 the next one"
    live = clip_join.JoinJob(id="live", title="x")
    live.status = "assembling"
    clip_join.JOBS["live"] = live
    assert clip_join.running() is live
