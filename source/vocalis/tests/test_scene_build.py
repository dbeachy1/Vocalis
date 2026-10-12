"""Building one audio scene (6.0 §3) — the sequence, without a GPU.

`build_scene` takes its renderer and its enhancer as parameters precisely so this file can
exist: everything here drives the real code path, with the two GPU steps replaced by callables
that write a file. What is being tested is the ORDER and the BOOKKEEPING — which is where the
design's rulings live. §3.2 is about which path renders, §3.5a about when the scene becomes
playable, §9 about what survives a cancel and an eviction.
"""
import subprocess
import threading
from pathlib import Path
from shutil import which

import pytest

import scene_build
import scenes
from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)


def _have_ffmpeg():
    return which("ffmpeg") and which("ffprobe")


needs_ffmpeg = pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")


def _sine(path: Path, secs=1.0, freq=440):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={secs}",
                    "-ac", "1", "-ar", "24000", "-b:a", "96k", str(path), "-loglevel", "error"],
                   check=True)
    return path


def _job(**kw):
    kw.setdefault("id", "job0001")
    kw.setdefault("title", "The ferry")
    kw.setdefault("owner", 'st:Test User')
    return scene_build.SceneJob(**kw)


def _items(cache_dir: Path, n=3, *, exist=True, secs=1.0):
    """n resolved requests, of which the cache already holds all (or none)."""
    out = []
    for i in range(n):
        cpath = cache_dir / f"msg{i}.mp3"
        if exist:
            _sine(cpath, secs, 440 + i * 110)
        out.append({"key": f"key{i:04d}0000", "cpath": cpath, "text": f"line number {i}",
                    "gen_kwargs": {"voice": 'Test_Character_1.wav'}, "character": 'Test Character 1',
                    "owner": 'st:Test User', "mesid": 400 + i})
    return out


# ── the happy path, end to end ───────────────────────────────────────────────────────────

@needs_ffmpeg
def test_a_build_lands_the_scene_and_stops(tmp_path):
    """🔴 6.3. The build ends the moment the scene is a product — playable, downloadable, in the
    Clips tab — and does NOT go on to enhance it.

    That phase used to hold the one-at-a-time lock for the eight minutes a twenty-minute scene
    takes to enhance, with a complete scene already on disk the whole time, and the next build
    was refused 409 `scene_busy`. Enhancing is now a verb on the row. There is no `enhancing`
    status left to assert against, so the honest check is the terminal one: `done`, a `ref`, one
    artifact and no second one."""
    out = tmp_path / "output"
    job = _job()
    scene_build.build_scene(job, _items(tmp_path / "cache"), render_one=_never_renders,
                            output_dir=out, scratch_root=tmp_path / "scratch")

    assert job.status == "done" and job.ref
    sroot = scenes.scenes_root(out)
    assert (sroot / f"{job.ref}.mp3").is_file()
    stems = sorted(p.stem for p in Path(sroot).glob("*.mp3"))
    assert stems == [job.ref], f"a build must produce exactly one artifact: {stems}"
    assert not any("_enhanced" in st for st in stems)


def test_the_build_no_longer_takes_an_enhancer_at_all(tmp_path):
    """The parameter is GONE, not defaulted to None. A build that still accepted `enhance_fn`
    would keep the old wiring compiling on the day someone re-injected it, which is exactly how
    a reversed ruling comes back."""
    import inspect
    sig = inspect.signature(scene_build.build_scene).parameters
    assert "enhance_fn" not in sig
    assert not hasattr(scene_build, "_enhance_into_second_artifact"),         "the body moved to scene_enhance.py — two copies would drift"
    fields = scene_build.SceneJob.__dataclass_fields__
    assert "enhance" not in fields and "enhance_nfe" not in fields
    assert "enhanced_ref" not in fields


def _never_renders(item, cancel):
    raise AssertionError("every message was cached — nothing should have rendered")


@needs_ffmpeg
def test_the_scene_is_the_messages_joined_with_a_gap_between_them(tmp_path):
    """§3.4. Three one-second messages at 0.7 s apart, with the gap BETWEEN them — a leading
    pause reads as the file being slow to start.

    ⚠️ Asserted against the figure the build itself computed, not against 3 + 2×0.7. An MP3
    carries encoder delay and padding at each end, so a "one second" file is 44 whole frames
    (1.056 s) and a stream copy of N of them sums all N paddings — the concatenated total is
    REAL, it is just not the arithmetic. What must hold is that the scene is as long as the
    manifest says it is, because that number is what drives the chapter offsets and the library
    row.

    🔴 And the per-file probe is NOT the way to add the parts up. FFmpeg 8 trims gapless
    metadata when it probes one file (a "1 s" part reads 1.000 s, a 0.7 s gap 0.700 s: sum 4.400)
    while the join keeps every frame (decodes to ~4.648 s). The old Windows build did not trim,
    so this test only failed inside the image. The stored total is now the joined file's own
    probe, and the offsets are sums of packet lengths, checked here against an independent
    packet count (`conftest.mp3_packet_length_s`) that is the same on every build."""
    from conftest import mp3_packet_length_s
    out = tmp_path / "output"
    job = _job(gap_s=0.7)
    items = _items(tmp_path / "cache", 3, secs=1.0)
    scene_build.build_scene(job, items,
                            render_one=_never_renders, output_dir=out,
                            scratch_root=tmp_path / "scratch")
    assert job.status == "done" and job.ref
    from tts_utils import ffprobe_duration
    mp3 = scenes.scenes_root(out) / f"{job.ref}.mp3"
    dur = ffprobe_duration(mp3)
    meta = scenes.read_manifest(scenes.scenes_root(out) / f"{job.ref}.yaml")
    assert dur == pytest.approx(job.duration_s, abs=0.06), (
        "the file and the manifest disagree about how long the scene is")
    assert meta["total_duration_s"] == pytest.approx(dur, abs=0.06)
    assert dur == pytest.approx(3 + 2 * 0.7, abs=0.5), "and it is still ~3 s of speech + 2 gaps"

    # Per-part offsets are the sums of the parts' packet lengths (the gap is a whole number of
    # frames too: 0.7 s -> 0.768 s), not the nominal 1.0 / 0.7 arithmetic.
    gap = mp3_packet_length_s(scene_build.make_silence(tmp_path / "gap.mp3", 0.7))
    parts = [mp3_packet_length_s(i["cpath"]) for i in items]
    expect, at = [], 0.0
    for p in parts:
        expect.append(at)
        at += p + gap
    got = [e["offset_s"] for e in meta["entries"]]
    assert got == pytest.approx(expect, abs=0.002)
    assert [e["duration_s"] for e in meta["entries"]] == pytest.approx(parts, abs=0.002)
    # The last entry ends where the file ends, give or take the joined file's own leading delay
    # and end padding (~50 ms, trimmed on playback by FFmpeg 8 and not by older builds).
    assert dur == pytest.approx(got[-1] + parts[-1], abs=0.1)


@needs_ffmpeg
def test_the_manifest_is_the_chapter_list(tmp_path):
    """§5: per-entry offsets fall out of the build for free, and they are most of what makes a
    46-minute scene usable — click a line, jump to that message inside the audio."""
    out = tmp_path / "output"
    job = _job(gap_s=0.5)
    scene_build.build_scene(job, _items(tmp_path / "cache", 3, secs=1.0),
                            render_one=_never_renders, output_dir=out,
                            scratch_root=tmp_path / "scratch")
    meta = scenes.read_manifest(scenes.scenes_root(out) / f"{job.ref}.yaml")
    offsets = [e["offset_s"] for e in meta["entries"]]
    assert offsets[0] == 0.0
    # Each part's whole frames (~1.056 s) plus a 0.5 s gap that is ~0.504 s of frames, counted
    # independently of the build — see the join test above for why not the per-file probe.
    from conftest import mp3_packet_length_s
    part = mp3_packet_length_s(tmp_path / "cache" / "msg0.mp3")
    gap = mp3_packet_length_s(scene_build.make_silence(tmp_path / "gap.mp3", 0.5))
    assert offsets[1] == pytest.approx(part + gap, abs=0.002)
    assert offsets[2] == pytest.approx(2 * (part + gap), abs=0.004)
    assert [e["mesid"] for e in meta["entries"]] == [400, 401, 402]
    assert [e["cache_key"] for e in meta["entries"]] == ["key00000000", "key00010000",
                                                         "key00020000"]


@needs_ffmpeg
def test_the_identity_is_the_cache_key_never_the_mesid(tmp_path):
    """🔴 §4. `mesid` is an array index: it shifts when a message is deleted, and a swipe
    changes a message's text without changing it. It is recorded as a HINT for jumping back to
    the message and must never be the thing the manifest is keyed on."""
    out = tmp_path / "output"
    items = _items(tmp_path / "cache", 2)
    job = _job()
    scene_build.build_scene(job, items, render_one=_never_renders, output_dir=out,
                            scratch_root=tmp_path / "scratch")
    meta = scenes.read_manifest(scenes.scenes_root(out) / f"{job.ref}.yaml")
    for entry, item in zip(meta["entries"], items):
        assert entry["cache_key"] == item["key"]
        assert entry["mesid"] == item["mesid"]


# ── §3.2: what renders, and what costs nothing ───────────────────────────────────────────

@needs_ffmpeg
def test_only_the_uncached_messages_render(tmp_path):
    """Only missing cache entries are rendered; cached ranges are reused."""
    out = tmp_path / "output"
    cache = tmp_path / "cache"
    items = _items(cache, 3, exist=False)
    _sine(items[0]["cpath"])                       # one of the three is already cached

    rendered = []

    def render_one(item, cancel):
        rendered.append(item["key"])
        _sine(item["cpath"])                       # a real render promotes into the ST cache

    job = _job()
    scene_build.build_scene(job, items, render_one=render_one, output_dir=out,
                            scratch_root=tmp_path / "scratch")
    assert rendered == ["key00010000", "key00020000"]
    assert job.cached == 1 and job.done == 3


@needs_ffmpeg
def test_a_message_that_renders_to_nothing_is_skipped_and_REPORTED(tmp_path):
    """§9. `bodyFor()` already returns null for system messages and ones that clean to nothing,
    but a render can also come back empty. Either way it is counted and named in the manifest —
    a message that silently vanishes from a 46-minute file is a bug you find weeks later."""
    out = tmp_path / "output"
    items = _items(tmp_path / "cache", 3, exist=False)
    _sine(items[0]["cpath"])
    _sine(items[2]["cpath"])

    def render_one(item, cancel):
        return None                                # produced nothing promotable

    job = _job()
    scene_build.build_scene(job, items, render_one=render_one, output_dir=out,
                            scratch_root=tmp_path / "scratch")
    assert job.status == "done"
    assert [s["mesid"] for s in job.skipped] == [401]
    meta = scenes.read_manifest(scenes.scenes_root(out) / f"{job.ref}.yaml")
    assert [s["mesid"] for s in meta["skipped"]] == [401]
    assert len(meta["entries"]) == 2


def test_a_range_with_no_audio_at_all_fails_loudly(tmp_path):
    """Not an empty scene file. §9's ffmpeg rule applies to the whole build: books already
    degrade on a missing prober, a scene cannot."""
    items = _items(tmp_path / "cache", 2, exist=False)
    job = _job()
    scene_build.build_scene(job, items, render_one=lambda i, c: None,
                            output_dir=tmp_path / "output", scratch_root=tmp_path / "scratch")
    assert job.status == "failed" and "speakable" in job.error
    assert job.ref is None


# ── §9: cancel ───────────────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_cancel_during_the_render_leaves_no_scene_but_keeps_the_audio(tmp_path):
    """§9. The partial concat is discarded, never promoted — but everything rendered so far
    stays in the speech cache, so a re-run resumes for free."""
    out = tmp_path / "output"
    items = _items(tmp_path / "cache", 4, exist=False)
    job = _job()

    def render_one(item, cancel):
        _sine(item["cpath"])
        if item["mesid"] == 401:
            job.cancel.set()

    scene_build.build_scene(job, items, render_one=render_one, output_dir=out,
                            scratch_root=tmp_path / "scratch")
    assert job.status == "canceled" and job.ref is None
    assert not scenes.list_scenes(scenes.scenes_root(out))
    assert items[0]["cpath"].is_file() and items[1]["cpath"].is_file(), (
        "rendered audio must survive the cancel — that is what makes a re-run free")


@needs_ffmpeg
def test_a_cancel_during_the_CONCAT_takes_the_finished_scene_back(tmp_path):
    """🔴 The gap the test above does NOT cover, and the same one 6.0-m2a closed in
    `clip_join.run_join` — this is the function that verb was modeled on.

    The render loop reads `cancel` every iteration, and then nothing read it again between there
    and a finished scene. A cancel landing in that window produced the file anyway and the job
    reported `done` with a ref, because the code after the try-block sets `done` unconditionally.
    Small window — a stream-copy concat of an hour is ~2 s — but it is reached by a user who has
    watched a render for minutes and pressed Cancel, which is a likelier press than the join's.

    Asserts the FILE is gone rather than just that `list_scenes` is empty: that listing is driven
    by manifests, so merely skipping the manifest write would satisfy it while leaving orphaned
    audio in the vault, belonging to no scene and shown by nothing.
    """
    out = tmp_path / "output"
    items = _items(tmp_path / "cache", 3)
    job = _job()
    real_concat = scene_build.mp3_concat.concat_mp3

    def _concat_then_cancel(paths, dest, **kw):
        p = real_concat(paths, dest, **kw)
        job.cancel.set()                     # Cancel pressed while ffmpeg was running
        return p

    scene_build.mp3_concat.concat_mp3 = _concat_then_cancel
    try:
        scene_build.build_scene(job, items, render_one=_never_renders, output_dir=out,
                                scratch_root=tmp_path / "scratch")
    finally:
        scene_build.mp3_concat.concat_mp3 = real_concat

    assert job.status == "canceled", "a canceled build must not report done"
    assert job.ref is None, "a canceled build must not hand the UI a ref to play"
    sroot = Path(scenes.scenes_root(out))
    left = sorted(p.name for p in sroot.glob("*")) if sroot.exists() else []
    assert left == [], f"a canceled build left files behind: {left}"


# 6.3: `test_cancel_during_the_ENHANCE_is_not_a_failure` and
# `test_a_failed_enhance_still_leaves_the_scene` were here. Both asserted properties of a phase
# that no longer exists in a build, and both moved to `tests/test_scene_enhance.py` against the
# route that owns it now — where "the raw scene survives" is still exactly the rule.


# ── §9: eviction ─────────────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_an_eviction_mid_build_cannot_shorten_the_scene(tmp_path):
    """🔴 §9. The speech cache is 5,000 entries per owner and it EVICTS — a big scene plus
    ordinary chatting could turn one over while the build is still running. The build therefore
    holds its own references in the SCRATCH, materialized as each entry is collected, rather
    than looking them up again at assembly time. Simulated by deleting every cache entry after
    the last one is collected: the scene must still be the full length."""
    out = tmp_path / "output"
    items = _items(tmp_path / "cache", 3, exist=False)
    job = _job(gap_s=0.0)

    def render_one(item, cancel):
        _sine(item["cpath"])
        if item["mesid"] == 402:
            # The LRU turns over while the last message renders, taking the two OLDEST entries
            # — which is what an eviction actually looks like. (It cannot take the one being
            # written; that is the most recently touched.)
            for it in items[:2]:
                it["cpath"].unlink(missing_ok=True)

    scene_build.build_scene(job, items, render_one=render_one, output_dir=out,
                            scratch_root=tmp_path / "scratch")
    assert job.status == "done"
    from tts_utils import ffprobe_duration
    dur = ffprobe_duration(scenes.scenes_root(out) / f"{job.ref}.mp3")
    assert dur == pytest.approx(3.0, abs=0.3), (
        "the scene is short — the build re-read the cache at assembly time instead of holding "
        "its own scratch references")


# ── the gap ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("given,expect", [
    (0.7, 0.7), ("1.5", 1.5), (-3, 0.0), (999, scene_build.MAX_GAP_S),
    (None, scene_build.DEFAULT_GAP_S), ("banana", scene_build.DEFAULT_GAP_S),
])
def test_the_gap_is_clamped(given, expect):
    """The configured gap is clamped to the supported range."""
    assert scene_build.clamp_gap(given) == expect


@needs_ffmpeg
def test_the_gap_silence_matches_the_speech_profile(tmp_path):
    """🔴 The silence rides in the same `-c copy` concat as the messages, so if its sample rate
    or channel count differs the join is invalid — and ffmpeg does not reliably say so. The
    symptom is a scene whose second half plays at the wrong speed."""
    p = scene_build.make_silence(tmp_path / "gap.mp3", 0.7, sample_rate=24000)
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                        "stream=sample_rate,channels", "-of", "csv=p=0", str(p)],
                       capture_output=True, text=True, check=True)
    assert r.stdout.strip().startswith("24000,1")


def test_the_gap_goes_between_and_never_at_the_ends():
    assert scene_build.interleave_with_gap(["a", "b", "c"], "-") == ["a", "-", "b", "-", "c"]
    assert scene_build.interleave_with_gap(["a"], "-") == ["a"]


# ── the status shape ─────────────────────────────────────────────────────────────────────

def test_the_polled_status_carries_no_chat_content():
    """Polled job status includes progress metadata without chat text or character names."""
    job = _job(chat='Test User — sample trip')
    job.skipped = [{"mesid": 7, "reason": "no speakable text"}]
    d = job.as_dict()
    blob = repr(d)
    assert "ferry" not in blob and 'Test Character 1' not in blob
    assert d["skipped"] == 1                    # a COUNT, not the list
    assert set(d) >= {"job_id", "status", "total", "done", "cached", "ref"}
    # 6.3: not defaulted — GONE. A field that is always null and a flag that is always false are
    # two lies the extension would go on branching on.
    assert "enhanced_ref" not in d and "enhancing" not in d


def test_a_cancel_event_is_per_job():
    a, b = _job(id="a"), _job(id="b")
    a.cancel.set()
    assert not b.cancel.is_set()
    assert isinstance(b.lock, type(threading.Lock()))


# ── 6.2-m6: a scene build has to actually reach the batching ─────────────────────────────

def test_every_missing_message_goes_in_ONE_batched_submission(tmp_path):
    """🔴 THE POINT OF THE WHOLE CHANGE, and it is invisible from the outside.

    A scene build renders message by message through `Mp3Render` -> `stream_message`, whose
    first chunk is a `_StreamJob` — and `_worker_loop` excludes `_StreamJob` from batching by
    design. So only chunks 2..n of a SINGLE message could ever batch, and measured against
    realistic message lengths **69-80% of messages never produce two of those**. Books ran at
    16-32; scene builds ran at an effective batch size of about 1.3 and nothing said so.

    So the missing messages must be handed over TOGETHER, once — not once each.
    """
    out = tmp_path / "output"
    cache = tmp_path / "cache"
    items = _items(cache, n=6, exist=False)
    calls = []

    def render_many(group, cancel):
        calls.append([i["key"] for i in group])
        for i in group:                       # pretend the batch rendered them
            _sine(Path(i["cpath"]), 1.0)

    scene_build.build_scene(_job(), items, render_one=_never_renders, render_many=render_many,
                            output_dir=out, nomi=None, scratch_root=tmp_path / "s")
    assert len(calls) == 1, f"the messages were handed over in {len(calls)} goes, not one"
    assert calls[0] == [i["key"] for i in items], "not every missing message was submitted"


def test_the_batch_covers_only_what_is_MISSING(tmp_path):
    """A batch render requests only cache entries that are absent."""
    out = tmp_path / "output"
    cache = tmp_path / "cache"
    items = _items(cache, n=4, exist=False)
    _sine(Path(items[1]["cpath"]), 1.0)       # this one is already cached
    _sine(Path(items[2]["cpath"]), 1.0)
    seen = []

    def render_many(group, cancel):
        seen.extend(i["key"] for i in group)
        for i in group:
            _sine(Path(i["cpath"]), 1.0)

    scene_build.build_scene(_job(), items, render_one=_never_renders, render_many=render_many,
                            output_dir=out, nomi=None, scratch_root=tmp_path / "s")
    assert seen == [items[0]["key"], items[3]["key"]]


def test_a_message_the_batch_missed_still_renders_one_at_a_time(tmp_path):
    """🔴 The batched pass is an OPTIMIZATION, never a new way to fail. Whatever it does not
    produce is simply still missing when the existing per-message loop reaches it — which is
    slow, and slow beats a hole in a 46-minute file."""
    out = tmp_path / "output"
    cache = tmp_path / "cache"
    items = _items(cache, n=3, exist=False)
    fallback = []

    def render_many(group, cancel):
        _sine(Path(group[0]["cpath"]), 1.0)   # only the first one lands

    def render_one(item, cancel):
        fallback.append(item["key"])
        _sine(Path(item["cpath"]), 1.0)

    job = scene_build.build_scene(_job(), items, render_one=render_one, render_many=render_many,
                                  output_dir=out, nomi=None, scratch_root=tmp_path / "s")
    assert fallback == [items[1]["key"], items[2]["key"]]
    assert job.skipped == [], "a message the batch missed was reported as skipped, not retried"


def test_one_message_does_not_get_the_batched_path(tmp_path):
    """A batch of one is the serial path with extra steps — measured 0.98x in 6.2, so there is
    nothing to win and the tested path is the one that runs."""
    out = tmp_path / "output"
    cache = tmp_path / "cache"
    items = _items(cache, n=1, exist=False)
    calls = []
    scene_build.build_scene(_job(), items,
                            render_one=lambda i, c: (calls.append("one"),
                                                     _sine(Path(i["cpath"]), 1.0))[1],
                            render_many=lambda g, c: calls.append("many"),
                            output_dir=out, nomi=None, scratch_root=tmp_path / "s")
    assert calls == ["one"]


def test_two_characters_become_two_submissions_because_a_batch_is_one_voice():
    """🔴 Not an optimization — a legality. `_Batch` carries `params` and `_drain_batch_mates`
    refuses a job whose batch differs, so chunks of two different voices can never share a pass.
    Grouping here is what makes the submission valid; it is not something a future change can
    'simplify' into one call."""
    items = [{"key": "a", "gen_kwargs": {"voice": 'Test_Character_1.wav'}},
             {"key": "b", "gen_kwargs": {"voice": "Test_Character_2.wav"}},
             {"key": "c", "gen_kwargs": {"voice": 'Test_Character_1.wav'}}]
    groups = scene_build._by_params(items)
    assert len(groups) == 2, f"two voices produced {len(groups)} submission(s)"
    assert [[i["key"] for i in g] for _sig, g in groups] == [["a", "c"], ["b"]], (
        "order within a voice must be preserved — a scene is a sequence")


@needs_ffmpeg
def test_a_build_cannot_render_onto_a_card_an_enhancement_is_HOLDING(tmp_path, monkeypatch):
    """Scene builds and enhancements share GPU ownership, so a build cannot start on a card held by an enhancement."""
    from vocalis.runtime.gpu import GPUS

    # An enhancement holds one card, exactly as clips.py's route leaves it.
    device, why = GPUS.claim_card(["cuda:0"])
    assert device == "cuda:0", f"could not set the scene up: {why}"
    try:
        started = threading.Event()
        job = _job()
        # Nothing is cached, so the build must reach `render_one` — which is the first thing that
        # would touch a GPU, and therefore the thing the gate has to stand in front of.
        items = _items(tmp_path / "cache", n=1, exist=False)

        def render_one(item, cancel):
            started.set()

        def build():
            scene_build.build_scene(job, items, render_one=render_one,
                                    output_dir=tmp_path / "output", nomi=None,
                                    scratch_root=tmp_path / "scratch")

        t = threading.Thread(target=build, daemon=True)
        t.start()
        assert not started.wait(1.0), \
            "the build started rendering while an enhancement held a card — it never took the gate"
    finally:
        GPUS.release_card("cuda:0")

    # And once the card is given back, it proceeds.
    assert started.wait(10), "the build never resumed after the enhancement released the card"
    t.join(10)


def test_one_permanently_failed_chunk_does_not_discard_the_messages_that_finished(monkeypatch):
    """🔴 `collect()` raises when any chunk fails permanently. That RuntimeError used to escape
    `render_messages_in_one_batch`, so the per-message assembly below it never ran and EVERY
    complete message in the submission was thrown away — a 74-message scene losing 73 finished
    renders because of one chunk, then re-rendering all of them one at a time through the
    streaming path, giving back the whole 4.09x.

    The function's own docstring promised the opposite ("or None where the submission did not
    deliver every chunk of that message"); it was only ever true for cancels.

    Verified red: without the `except RuntimeError` the call below propagates and the assert
    never runs.
    """
    import torch
    import tts_utils

    class PartlyFailingPool:
        sr = 24000

        def run_chunks(self, items, params, save, total, cancel=None, **kw):
            for idx, _text in items:
                if idx == 1:                      # the one chunk that never lands
                    continue
                save(idx, torch.full((1, 240), 0.1, dtype=torch.float32), self.sr)
            raise RuntimeError("1 chunk(s) failed permanently after all retries. Failed: [1]")

    monkeypatch.setattr(tts_utils, "split_into_chunks", lambda t: [t])
    out = tts_utils.render_messages_in_one_batch(
        PartlyFailingPool(), ["message one", "message two", "message three"],
        tts_utils.GenParams())

    assert out[0] is not None and out[2] is not None, "finished messages were discarded"
    assert out[1] is None, "a message whose chunk never arrived must stay None, not be truncated"


def test_the_pool_gets_every_chunk_of_every_message_in_one_call(tmp_path):
    """`render_group_through_the_pool` is where the batching actually happens, so it is worth
    asserting on the submission itself rather than only on who called it.

    One `run_chunks` per voice, carrying every chunk of every message flattened — and the wavs
    reassembled back onto the right message, in order. Getting that map wrong would put one
    character's sentence in another's mouth, which is silent and unlistenable-to."""
    import torch

    class FakePool:
        sr = 24000

        def __init__(self):
            self.calls = []

        def run_chunks(self, items, params, save, total, **kw):
            self.calls.append([t for _i, t in items])
            for idx, text in items:
                # A distinct constant per chunk, so reassembly is checkable by value.
                save(idx, torch.full((1, 240), float(len(text)) / 1000.0), self.sr)
            return 0, 0.0

    promoted = {}

    class FakeNomi:
        def promote_temp(self, tmp, key, owner=None):
            promoted[key] = Path(tmp).read_bytes()
            Path(tmp).unlink(missing_ok=True)

    items = [{"key": "k0", "text": "First message here.", "owner": 'st:Test User',
              "gen_kwargs": {"voice": 'Test_Character_1.wav'}},
             {"key": "k1", "text": "Second message, rather longer than the first one is.",
              "owner": 'st:Test User', "gen_kwargs": {"voice": 'Test_Character_1.wav'}}]
    pool = FakePool()
    done = scene_build.render_group_through_the_pool(
        pool, items, threading.Event(), nomi=FakeNomi(), scratch_root=tmp_path / "s")

    assert len(pool.calls) == 1, f"{len(pool.calls)} submissions for one voice"
    assert pool.calls[0] == ["First message here.",
                             "Second message, rather longer than the first one is."]
    assert set(done) == {"k0", "k1"}, f"not every message was promoted: {done}"
    assert set(promoted) == {"k0", "k1"}
    for key, blob in promoted.items():
        assert blob[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3"), f"{key} is not an mp3"
        assert len(blob) > 100, f"{key} promoted an empty file"
