"""6.1-m1a — editing a scene by stitching it. DESIGN_6_1_SCENE_EDITING.md §9's ten tests.

That section was written UP FRONT, before the code, for a stated reason: 6.0 shipped four defects
past a green suite and every one of them was a guarantee stated in prose with no code keeping it.
So most of this file drives REAL ffmpeg over REAL mp3s and then DECODES the result, rather than
asserting that the right functions were called with the right arguments — which is what the join
tests did, and what caught the mono-gap bug when nothing else could.

🔴 Two of these are shaped deliberately and must not be "simplified":

- the cancel test proves itself by ALSO running against a neutered check (`_no_cancel`), because
  a cancel test that passes against code which cannot cancel is exactly how the 6.0-m2a defect
  survived review;
- the 409 test is a RACE, not a sequence: request A is pinned mid-work while B runs end to end.
  A sequence passes whether the guard is atomic or not.
"""
import subprocess
import threading
from pathlib import Path
from shutil import which

import pytest

from conftest import REPO_ROOT, mp3_packet_length_s  # noqa: F401  (sys.path side effect)

import clip_join
import scene_edit
import scenes


def _have_ffmpeg():
    return which("ffmpeg") and which("ffprobe")


needs_ffmpeg = pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")

GAP = 0.7


def _tone(path: Path, secs: float, *, freq=440, rate=24000, ch=1, kbps=96):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"sine=frequency={freq}:duration={secs}:sample_rate={rate}",
         "-ac", str(ch), "-b:a", f"{kbps}k", str(path)],
        check=True, capture_output=True, timeout=120)
    return path


def _dur(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True, timeout=60)
    return float(r.stdout.strip())


def _probe_ch_rate(path: Path):
    p = clip_join.probe(path)
    return p["channels"], p["sample_rate"]


def _pg(out: Path, ref: str, secs: float, **kw) -> Path:
    """A real Playground clip at `output/playground/<vdir>/<stem>.mp3`, which is where
    `clip_sources.resolve` looks. Seeding it anywhere else makes every edit fail at resolve,
    which is a fixture bug that reads exactly like a code bug."""
    p = out / "playground" / f"{ref}.mp3"
    p.parent.mkdir(parents=True, exist_ok=True)
    return _tone(p, secs, **kw)


def _seed(tmp_path: Path, *, n=4, each=2.0, rate=24000, ch=1) -> tuple:
    """A scene of `n` messages with a real MP3 behind it, built the way a build builds it:
    speech, gap, speech, gap, … and a manifest whose offsets describe exactly that, in the
    packet lengths the join really contains (`conftest.mp3_packet_length_s`) — not the nominal
    seconds, and not the per-file format probe, which FFmpeg 8 trims."""
    out = tmp_path / "output"
    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)

    parts, entries, offset = [], [], 0.0
    gap = _tone(tmp_path / "gap.mp3", GAP, freq=1, rate=rate, ch=ch)
    gap_len = mp3_packet_length_s(gap)
    for i in range(n):
        p = _tone(tmp_path / f"m{i}.mp3", each, freq=300 + 100 * i, rate=rate, ch=ch)
        plen = mp3_packet_length_s(p)
        if i:
            parts.append(gap)
        parts.append(p)
        entries.append({"mesid": 400 + i, "character": 'Test Character 1', "cache_key": f"k{i}",
                        "offset_s": round(offset, 3), "duration_s": round(plen, 3),
                        "text": f"line number {i}"})
        offset += plen + gap_len
    total = offset - gap_len

    listing = tmp_path / "list.txt"
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    mp3 = root / "the_scene_ab12cd34.mp3"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(listing), "-c", "copy", str(mp3)],
                   check=True, capture_output=True, timeout=120)
    scenes.write_manifest(root / "the_scene_ab12cd34.yaml", {
        "title": "The scene", "source": "st", "chat": "a chat", "created": scenes.now(),
        "gap_s": GAP, "total_duration_s": round(total, 2), "entries": entries})
    return out, root, entries


def _apply(out, entries, ops, tmp_path, *, title="Edited", gap_s=GAP, job=None):
    """Run one edit to completion on THIS thread — the threading is `start()`'s job and is tested
    separately, and a background thread here would make every failure a timeout."""
    job = job or scene_edit.EditJob(id="t" + str(len(ops)), title=title,
                                    src_ref="the_scene_ab12cd34", gap_s=gap_s)
    meta = scenes.read_manifest(scenes.scenes_root(out) / "the_scene_ab12cd34.yaml")
    scene_edit.run_edit(job, entries, scene_edit.normalize_ops(ops, len(entries)),
                        output_dir=out, src_meta=meta,
                        scratch_root=tmp_path / "scratch")
    return job


# ── the plan, which needs no ffmpeg ───────────────────────────────────────────────────────────

def test_untouched_entries_coalesce_into_one_piece():
    """🔴 The difference between 5 ffmpeg calls and 75 on a 74-message scene."""
    entries = [{"offset_s": i} for i in range(8)]
    ops = scene_edit.normalize_ops(
        [{"op": "replace", "index": 3, "kind": "playground", "ref": "v/a"}], len(entries))
    pieces = scene_edit.coalesce(scene_edit.plan_units(entries, ops))
    assert pieces == [("cut", 0, 2), ("clip", ops[0]), ("cut", 4, 7)]


def test_two_ops_do_not_shift_each_other():
    """§6 — ops are keyed to ORIGINAL indices. If the second op were applied to a list the first
    had already changed, it would land on whatever moved into that slot."""
    entries = [{"offset_s": i} for i in range(6)]
    ops = scene_edit.normalize_ops([
        {"op": "insert_after", "index": 1, "kind": "playground", "ref": "v/ins"},
        {"op": "replace", "index": 4, "kind": "playground", "ref": "v/rep"},
    ], len(entries))
    pieces = scene_edit.coalesce(scene_edit.plan_units(entries, ops))
    kinds = [p[0] for p in pieces]
    assert kinds == ["cut", "clip", "cut", "clip", "cut"]
    assert pieces[0] == ("cut", 0, 1) and pieces[2] == ("cut", 2, 3) and pieces[4] == ("cut", 5, 5)
    # The replacement is still entry 4's, not entry 5's.
    assert pieces[3][1]["ref"] == "v/rep" and pieces[3][1]["index"] == 4


def test_an_insert_at_either_end_is_an_ordinary_piece():
    entries = [{"offset_s": i} for i in range(3)]
    ops = scene_edit.normalize_ops([
        {"op": "insert_before", "index": 0, "kind": "playground", "ref": "v/intro"},
        {"op": "insert_after", "index": 2, "kind": "playground", "ref": "v/outro"},
    ], len(entries))
    pieces = scene_edit.coalesce(scene_edit.plan_units(entries, ops))
    assert [p[0] for p in pieces] == ["clip", "cut", "clip"]


@pytest.mark.parametrize("ops, why", [
    ([], "there are no edits"),
    ([{"op": "reverse", "index": 0, "kind": "playground", "ref": "v/a"}], "unknown edit"),
    ([{"op": "replace", "index": 9, "kind": "playground", "ref": "v/a"}], "out of range"),
    ([{"op": "replace", "index": 0, "kind": "nope", "ref": "v/a"}], "unknown kind"),
    ([{"op": "replace", "index": 0, "kind": "playground", "ref": ""}], "no ref"),
    ([{"op": "replace", "index": 0, "kind": "playground", "ref": "v/a"},
      {"op": "replace", "index": 0, "kind": "playground", "ref": "v/b"}], "replaced twice"),
])
def test_a_bad_plan_is_refused_by_name(ops, why):
    with pytest.raises(scene_edit.EditError):
        scene_edit.normalize_ops(ops, 4)


# ── the stitch, decoded ───────────────────────────────────────────────────────────────────────

@needs_ffmpeg
def test_1_the_result_decodes_to_the_length_the_manifest_claims(tmp_path):
    """§9.1 — real duration ≈ sum of the pieces plus the gaps. THE check that caught 6.0-m2's
    mono gap, because a wrong-profile splice plays at the wrong speed and nothing else notices."""
    out, root, entries = _seed(tmp_path)
    _pg(out, "v/new", 3.0)
    job = _apply(out, entries,
                 [{"op": "replace", "index": 1, "kind": "playground", "ref": "v/new"}],
                 tmp_path)
    assert job.status == "done", job.error
    mp3, _y = scenes.scene_paths(root, job.ref)
    assert abs(_dur(mp3) - job.duration_s) < 0.25, (
        f"decoded {_dur(mp3):.3f}s but the manifest claims {job.duration_s:.3f}s")


@needs_ffmpeg
def test_3_an_insert_at_the_ends_makes_exactly_one_gap(tmp_path):
    """§9.3 — never a leading or trailing pause. `interleave_with_gap` encodes that rule and this
    is the check that it is still the rule after the pieces are built a different way."""
    out, root, entries = _seed(tmp_path, n=2, each=2.0)
    _pg(out, "v/intro", 1.0)
    job = _apply(out, entries,
                 [{"op": "insert_before", "index": 0, "kind": "playground", "ref": "v/intro"}],
                 tmp_path)
    assert job.status == "done", job.error
    mp3, _y = scenes.scene_paths(root, job.ref)
    # intro(1) + gap + [m0(2) + gap + m1(2)] = 1 + .7 + 4.7 = 6.4 nominal, with ONE new gap, not
    # two. In whole frames that is ~6.67 s (each gap is ~0.768 s), less ~50 ms the joined file
    # trims on FFmpeg 8; a second gap at the front would add another ~0.77 s.
    want = (mp3_packet_length_s(out / "playground" / "v" / "intro.mp3")
            + mp3_packet_length_s(tmp_path / "m0.mp3") + mp3_packet_length_s(tmp_path / "m1.mp3")
            + 2 * mp3_packet_length_s(tmp_path / "gap.mp3"))
    assert _dur(mp3) == pytest.approx(want, abs=0.15), (
        f"got {_dur(mp3):.3f}s, expected ~{want:.3f}s — a gap at the front would be "
        f"{want + 0.77:.3f}s")


@needs_ffmpeg
def test_5_the_new_offsets_are_where_the_audio_actually_is(tmp_path):
    """§9.5 — probe, do not trust the arithmetic that produced them. A stale offset sends him to
    the wrong line, which is the one thing the Chapters list exists to get right."""
    out, root, entries = _seed(tmp_path, n=4)
    _pg(out, "v/new", 5.0)
    job = _apply(out, entries,
                 [{"op": "replace", "index": 1, "kind": "playground", "ref": "v/new"}],
                 tmp_path)
    assert job.status == "done", job.error
    mp3, y = scenes.scene_paths(root, job.ref)
    meta = scenes.read_manifest(y)
    got = [e["offset_s"] for e in meta["entries"]]
    # m0(2) gap m1'(5) gap m2(2) gap m3(2) — in whole MP3 frames, counted independently of the
    # edit (a 0.7 s gap is ~0.768 s of frames, so the nominal 2.7 / 8.4 / 11.1 are ~0.07 s per
    # gap short; the slices are frame-boundary stream copies, hence ~a frame of slack).
    m, new = mp3_packet_length_s(tmp_path / "m0.mp3"), mp3_packet_length_s(
        out / "playground" / "v" / "new.mp3")
    gap = mp3_packet_length_s(tmp_path / "gap.mp3")
    assert got[0] == pytest.approx(0.0, abs=0.05)
    assert got[1] == pytest.approx(m + gap, abs=0.05)
    assert got[2] == pytest.approx(m + gap + new + gap, abs=0.08)
    assert got[3] == pytest.approx(m + gap + new + gap + m + gap, abs=0.1)
    # And the file really is that long, so the offsets are inside it: the stored total is its
    # own probe, and the last entry ends where the file ends (give or take the joined file's
    # leading delay and end padding, ~50 ms on FFmpeg 8, none trimmed on older builds).
    assert _dur(mp3) == pytest.approx(job.duration_s, abs=0.06)
    assert _dur(mp3) == pytest.approx(got[3] + m, abs=0.15)


@needs_ffmpeg
def test_6_an_inserted_entry_has_no_mesid_and_no_cache_key(tmp_path):
    """§9.6 — an inserted line is not a chat message and must not pretend to be one."""
    out, root, entries = _seed(tmp_path, n=3)
    _pg(out, "v/ins", 1.5)
    job = _apply(out, entries,
                 [{"op": "insert_after", "index": 0, "kind": "playground", "ref": "v/ins",
                   "text": "a line he wrote himself"}],
                 tmp_path)
    assert job.status == "done", job.error
    _mp3, y = scenes.scene_paths(root, job.ref)
    meta = scenes.read_manifest(y)
    ins = [e for e in meta["entries"] if e.get("inserted")]
    assert len(ins) == 1
    assert ins[0]["mesid"] is None and "cache_key" not in ins[0]
    assert ins[0]["text"] == "a line he wrote himself"
    assert ins[0]["source_clip"] == {"kind": "playground", "ref": "v/ins"}
    # A replaced entry keeps its mesid — there IS still a message to jump back to — but stops
    # claiming a cache key that no longer describes its audio.
    job2 = _apply(out, entries,
                  [{"op": "replace", "index": 2, "kind": "playground", "ref": "v/ins"}],
                  tmp_path, title="Edited two")
    _m2, y2 = scenes.scene_paths(root, job2.ref)
    rep = scenes.read_manifest(y2)["entries"][2]
    assert rep["mesid"] == 402 and "cache_key" not in rep
    assert rep["replaced_with"] == {"kind": "playground", "ref": "v/ins"}


@needs_ffmpeg
def test_7_the_original_scene_is_byte_identical_afterwards(tmp_path):
    """§9.7 — the entire value of an edit feature is that a bad replacement costs nothing."""
    out, root, entries = _seed(tmp_path)
    src, srcy = scenes.scene_paths(root, "the_scene_ab12cd34")
    before, beforey = src.read_bytes(), srcy.read_bytes()
    _pg(out, "v/new", 3.0)
    job = _apply(out, entries,
                 [{"op": "replace", "index": 0, "kind": "playground", "ref": "v/new"}],
                 tmp_path)
    assert job.status == "done", job.error
    assert src.read_bytes() == before and srcy.read_bytes() == beforey
    assert job.ref != "the_scene_ab12cd34"


@needs_ffmpeg
def test_8_two_applies_of_the_same_edit_make_two_scenes(tmp_path):
    """§9.8 — the nonce. An edit takes about a second, so without it two edits of one scene hash
    identically inside the same second and the second silently destroys the first. That bug was
    found and fixed in 6.0-m2; this is the third module that must not reintroduce it."""
    out, root, entries = _seed(tmp_path, n=2, each=1.0)
    _pg(out, "v/new", 1.0)
    ops = [{"op": "replace", "index": 0, "kind": "playground", "ref": "v/new"}]
    a = _apply(out, entries, ops, tmp_path)
    b = _apply(out, entries, ops, tmp_path)
    assert a.status == "done" and b.status == "done"
    assert a.ref != b.ref, "the second edit landed on the first"
    for ref in (a.ref, b.ref):
        mp3, y = scenes.scene_paths(root, ref)
        assert mp3.exists() and y.exists()


@needs_ffmpeg
def test_2_a_stereo_44k_scene_gets_a_stereo_44k_gap(tmp_path):
    """§9.2 — assert the OUTPUT's channel count, not the call arguments.

    🔴 This is 6.0-m2's `cl=mono` defect in its second home. `make_silence` was mono-only, which
    no scene build could notice because they are all mono — and then Join met a stereo selection
    and spliced a mono gap between stereo sources. §4.2 warns it is likelier here, because a
    scene may have been rendered by a satellite at another rate while the app default is 24 kHz
    mono."""
    out, root, entries = _seed(tmp_path, n=3, each=1.5, rate=44100, ch=2)
    _pg(out, "v/new", 1.5, rate=44100, ch=2)
    # 🔴 A TWO-SECOND gap, not the scene's 0.7 — and the number is measured, not chosen for
    # roundness. A wrong-profile gap costs time in PROPORTION to its length, while the frame-snap
    # error of the cuts is fixed, so a short gap buries the defect in the noise. The fixture uses
    # a representative measured value:
    #   gap 0.7 → correct 0.063s out, mono-24k gap 0.271s out   (a 0.3 tolerance passes BOTH)
    #   gap 2.0 → correct 0.075s out, mono-24k gap 0.493s out   (0.2 separates them cleanly)
    # The first version of this test used 0.7 with a 0.3 tolerance and was green against the
    # neutered code, which is the whole failure mode §9 was written to prevent.
    job = _apply(out, entries,
                 [{"op": "replace", "index": 1, "kind": "playground", "ref": "v/new"}],
                 tmp_path, gap_s=2.0)
    assert job.status == "done", job.error
    mp3, _y = scenes.scene_paths(root, job.ref)
    ch, rate = _probe_ch_rate(mp3)
    # ⚠️ Necessary but nowhere near sufficient: ffprobe reports the FIRST frame's parameters, and
    # the first frame is a piece of the original scene either way. This passes against the bug.
    assert (ch, rate) == (2, 44100), f"the edited scene came out {ch}ch @ {rate}"
    # THE check. A mono gap spliced into a stereo file does not error — it plays for the wrong
    # length, which is only visible by decoding.
    assert abs(_dur(mp3) - job.duration_s) < 0.2, (
        f"decoded {_dur(mp3):.3f}s vs {job.duration_s:.3f}s claimed — the gap is the wrong shape")


@needs_ffmpeg
def test_a_clip_at_another_profile_is_transcoded_but_the_scene_is_not(tmp_path):
    """§4.3 — only the INCOMING clip is ever re-encoded. The scene is never re-encoded; that is
    the whole economy of this feature."""
    out, root, entries = _seed(tmp_path, n=3, each=1.5)          # 24 kHz mono
    _pg(out, "v/new", 1.5, rate=44100, ch=2, kbps=256)   # an enhanced-looking clip
    job = _apply(out, entries,
                 [{"op": "replace", "index": 1, "kind": "playground", "ref": "v/new"}],
                 tmp_path)
    assert job.status == "done", job.error
    mp3, _y = scenes.scene_paths(root, job.ref)
    assert _probe_ch_rate(mp3) == (1, 24000), "the SCENE was re-encoded — it must not be"
    assert abs(_dur(mp3) - job.duration_s) < 0.3


# ── cancel and the one-at-a-time guard ────────────────────────────────────────────────────────

@needs_ffmpeg
def test_9_cancel_mid_apply_leaves_nothing_behind(tmp_path):
    """§9.9 — no orphan mp3, no manifest, and the job says `canceled`, not `done`.

    🔴 Proven by ALSO running it against a neutered check. 6.0-m2a's cancel test passed against
    code that could not cancel, because it only ever asserted the status the job reported. Here
    the same scenario, with the post-concat check removed, must produce a scene — otherwise this
    test is measuring nothing."""
    out, root, entries = _seed(tmp_path, n=3, each=1.0)
    _pg(out, "v/new", 1.0)
    ops = [{"op": "replace", "index": 1, "kind": "playground", "ref": "v/new"}]

    job = scene_edit.EditJob(id="cancelme", title="Canceled", src_ref="the_scene_ab12cd34",
                             gap_s=GAP)
    job.cancel.set()                      # pressed before the concat lands
    before = {p.name for p in root.iterdir()}
    _apply(out, entries, ops, tmp_path, job=job)
    assert job.status == "canceled", f"reported {job.status}"
    assert job.ref is None
    assert {p.name for p in root.iterdir()} == before, "a canceled edit left an artifact behind"


@needs_ffmpeg
def test_9b_the_cancel_test_would_fail_against_code_that_ignores_cancel(tmp_path, monkeypatch):
    """The other half of §9.9: prove the check above is not vacuous.

    With `cancel.is_set()` forced False — i.e. exactly the code that ships if someone deletes
    those two checks — the same scenario must produce a finished scene. If this test ever starts
    passing for the wrong reason, the one above has stopped testing anything."""
    out, root, entries = _seed(tmp_path, n=3, each=1.0)
    _pg(out, "v/new", 1.0)

    class _NeverCanceled(threading.Event):
        def is_set(self):
            return False

    job = scene_edit.EditJob(id="neutered", title="Neutered", src_ref="the_scene_ab12cd34",
                             gap_s=GAP)
    job.cancel = _NeverCanceled()
    job.cancel.set()
    _apply(out, entries,
           [{"op": "replace", "index": 1, "kind": "playground", "ref": "v/new"}],
           tmp_path, job=job)
    assert job.status == "done" and job.ref, (
        "a job whose cancel check is neutered still did not finish — the cancel test above "
        "proves nothing")
    mp3, _y = scenes.scene_paths(root, job.ref)
    assert mp3.exists()


@needs_ffmpeg
def test_10_a_second_apply_while_one_runs_is_a_409_tested_as_a_race(tmp_path):
    """§9.10 — a RACE, not a sequence.

    🔴 A sequence (start A, wait, start B) passes whether the guard is atomic or not, which is
    the shape that let the join's check-then-act version through. Here A is PINNED inside
    `run_edit` and B is fired while it is still registered, which is the window a double-click
    or a browser POST retry actually lands in."""
    out, _root, entries = _seed(tmp_path, n=2, each=1.0)
    _pg(out, "v/new", 1.0)
    scene_edit.JOBS.clear()
    ops = [{"op": "replace", "index": 0, "kind": "playground", "ref": "v/new"}]

    released = threading.Event()
    in_cut = threading.Event()
    real_cut = scene_edit.cut

    def _slow_cut(*a, **kw):
        in_cut.set()                      # A is now genuinely inside its own work
        released.wait(10)                 # hold the first edit there
        return real_cut(*a, **kw)

    meta = scenes.read_manifest(scenes.scenes_root(out) / "the_scene_ab12cd34.yaml")
    try:
        scene_edit.cut = _slow_cut
        a = scene_edit.start("the_scene_ab12cd34", "A", scene_edit.normalize_ops(ops, len(entries)),
                             entries=entries, src_meta=meta, output_dir=out)
        # Wait until A is genuinely pinned inside `run_edit` (its cut has begun).
        assert in_cut.wait(10), "A never reached its first cut"
        with pytest.raises(scene_edit.EditBusy) as busy:
            scene_edit.start("the_scene_ab12cd34", "B",
                             scene_edit.normalize_ops(ops, len(entries)),
                             entries=entries, src_meta=meta, output_dir=out)
        assert busy.value.job.id == a.id     # the 409 carries the job so the client can reattach
    finally:
        released.set()
        scene_edit.cut = real_cut
        # `start` names the worker `edit-<job id>`; joining it is the completion signal. If it is
        # no longer listed, it has already ended.
        for t in threading.enumerate():
            if t.name == f"edit-{a.id}":
                t.join(20)
                assert not t.is_alive(), "A's edit never finished"
    assert a.status == "done", a.error
    # And the verb is free again once it finishes.
    assert scene_edit.running() is None
