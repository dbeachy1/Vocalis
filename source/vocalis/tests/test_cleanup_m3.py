"""Pure logic and orchestration tests for the trim scorer.

The model-quality path is evaluated separately. These tests exercise the NumPy bridge from VAD
and tagger output to keep/drop decisions, clip stitching, and cleanup orchestration: cache reuse,
graceful degradation, and stable rerun identity. The child model response is mocked, so importing
and running this suite does not require torch or host sensor access.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "cleanup"))

import cleanup           # noqa: E402
import trim_audio as tr  # noqa: E402


# ── VAD segments → the same frame mask the energy gate feeds mask_to_regions ──

def test_vad_segments_to_mask_marks_the_right_frames():
    mask = tr.vad_segments_to_mask([[0.0, 0.1], [0.2, 0.3]], n_frames=20, frame_ms=20.0)
    assert mask.shape == (20,)
    assert mask[:5].all() and not mask[5:10].any() and mask[10:15].all()


def test_vad_segments_to_mask_clamps_and_skips_garbage():
    # an out-of-range end is clamped (covers the file); non-numeric / short entries are skipped,
    # never fatal — a bad scorer line must not crash a 73-minute run.
    mask = tr.vad_segments_to_mask([[0.0, 999.0], "bad", [None, 1], [5]], n_frames=10, frame_ms=20.0)
    assert mask.all()


def test_vad_segments_to_mask_empty_and_degenerate():
    assert not tr.vad_segments_to_mask([], 5).any()
    assert tr.vad_segments_to_mask([[0, 1]], 0).size == 0


# ── tagger windows → one music/SFX score per region ──────────────────────────

def test_region_music_scores_aggregates_overlapping_windows():
    windows = [{"t": 0.0, "music_sfx": 0.1}, {"t": 1.0, "music_sfx": 0.8}, {"t": 2.0, "music_sfx": 0.9}]
    regions = [(50, 150)]                     # 1.0 s .. 3.0 s at 20 ms frames
    scores = tr.region_music_scores(regions, windows, agg_pct=50.0)
    assert scores[0] == pytest.approx(0.85, abs=0.02)   # median of {0.8, 0.9}


def test_region_music_scores_borrows_the_nearest_window_when_none_inside():
    windows = [{"t": 0.0, "music_sfx": 0.2}, {"t": 5.0, "music_sfx": 0.9}]
    regions = [(100, 101)]                    # 2.0 s .. 2.02 s — no window falls inside
    assert tr.region_music_scores(regions, windows)[0] == pytest.approx(0.2)  # nearest is t=0.0


def test_region_music_scores_no_windows_is_all_zero():
    assert tr.region_music_scores([(0, 10), (20, 30)], []) == [0.0, 0.0]


# ── the veto: a clean-but-musical region is dropped (the whole point of m3) ───

def test_music_veto_drops_a_clean_region_that_is_music():
    rms = np.array([-60.0, -20, -59])         # a clean region (gaps match the floor)
    floor = -60.0
    assert tr.score_regions(rms, [(0, 3)], floor, 6.0)[0].keep is True          # SNR-only: kept
    over = tr.score_regions(rms, [(0, 3)], floor, 6.0, music_scores=[0.8], music_veto=0.35)
    assert over[0].keep is False and over[0].music_sfx == pytest.approx(0.8)    # vetoed as music
    under = tr.score_regions(rms, [(0, 3)], floor, 6.0, music_scores=[0.2], music_veto=0.35)
    assert under[0].keep is True                                                # below the veto: kept


def test_region_music_sfx_defaults_to_zero():
    assert tr.Region(start_s=0, end_s=1, excess_db=0.0, keep=True).music_sfx == 0.0


def test_a_veto_of_one_is_exactly_no_veto():
    """🔴 THE EQUIVALENCE THE BROWSER'S "Save" NOW DEPENDS ON (7.3-m3).

    The Clean-up preview draws its timeline with `curVeto()`, which is **Infinity** until the clip
    has been scored — SNR-only, music never vetoes. Save used to send the slider's raw 0.35
    regardless, so the saved cut applied a veto that was never on screen and dropped regions the
    user had watched being kept. Both sides say that must be impossible: `clnKeep`'s "these mirror
    cleanup._build_scored so the preview and the saved cut agree", and `_build_scored`'s "kept
    identical between preview and cut so the timeline and the saved clip can never disagree".

    Infinity cannot make the trip — `JSON.stringify(Infinity)` is `null`, and `normalize_passes`
    turns that back into the 0.35 default (see `test_normalize_clamps_the_music_veto`, which pins
    the same clamp from the other direction). So the browser sends **1**, and this is the assertion
    that makes that substitution legitimate rather than a guess: the predicate is `music <=
    music_veto` and music/SFX is a probability, so a veto of 1 keeps everything Infinity would.

    ⚠️ If a future scorer can emit above 1.0, this test goes red and the browser needs a real
    sentinel instead — which is exactly the conversation that should happen before that ships.
    """
    rms = np.array([-60.0, -20, -59])
    floor = -60.0
    for music in (0.0, 0.35, 0.8, 1.0):
        inf_veto = tr.score_regions(rms, [(0, 3)], floor, 6.0,
                                    music_scores=[music], music_veto=float("inf"))
        one_veto = tr.score_regions(rms, [(0, 3)], floor, 6.0,
                                    music_scores=[music], music_veto=1.0)
        assert inf_veto[0].keep is one_veto[0].keep is True, (
            f"music={music}: veto=1 must keep exactly what veto=inf keeps "
            f"(inf kept {inf_veto[0].keep}, 1 kept {one_veto[0].keep})")

    # And it is the CLAMP that forces the substitution: the route cannot carry anything larger.
    assert cleanup.normalize_passes(
        {"trim": {"enabled": True, "music_veto": float("inf")}})["trim"]["music_veto"] == 1.0


def test_the_browser_sends_the_veto_it_previewed_with():
    """The other half of the fix above, pinned where it can actually regress: the front end.

    `music_veto:+veto.value` is the defect — it reads the slider directly instead of the value the
    timeline was drawn with. The correct source is `curVeto()`, clamped to 1 for the wire. This
    asserts the shape rather than the exact expression so that reformatting does not fail it, but
    a return to the raw slider does.

    🔴 8.3.2 — AND IT DID FAIL ON REFORMATTING, BOTH WAYS, BECAUSE BOTH HALVES WERE SUBSTRING
    TESTS AGAINST DENSE SPACING. Prettier writes `Math.min(curVeto(), 1)`, so the positive half
    went red against code that is exactly right; the negative half went SILENT, which is worse —
    a regression reintroducing the slider would now be written `music_veto: +veto.value` and
    sail straight past a check spelled without the space. Both are regexes now, whitespace-elastic
    between tokens and otherwise identical, which is what the paragraph above always claimed.
    """
    src = (Path(__file__).resolve().parent.parent
           / "src" / "webui" / "js" / "media" / "cleanup.js").read_text(encoding="utf-8")
    assert not re.search(r"music_veto\s*:\s*\+\s*veto\.value", src), (
        "Save is sending the raw slider again. On an unscored clip the preview uses curVeto() "
        "(Infinity), so this silently cuts with a music veto the user never saw.")
    assert re.search(r"Math\.min\(\s*curVeto\(\)\s*,\s*1\s*\)", src), (
        "the wire value must derive from curVeto() — Infinity JSON-encodes to null and "
        "normalize_passes turns that back into the 0.35 default.")


# ── the stitched single clip (§4): pauses become RVC's cut points ────────────

def test_stitch_clip_joins_chunks_with_a_silent_pause():
    a = np.ones(100, dtype=np.float32)
    b = np.ones(100, dtype=np.float32)
    out = tr.stitch_clip([a, b], sr=1000, pause_ms=100.0, fade_ms=0.0)
    assert len(out) == 300 and out.dtype == np.float32
    assert out[100:200].sum() == 0.0          # the 100-sample pause is digital silence


def test_stitch_clip_single_chunk_has_no_interior_pause():
    out = tr.stitch_clip([np.ones(100, dtype=np.float32)], sr=1000, pause_ms=100.0, fade_ms=0.0)
    assert len(out) == 100


def test_stitch_clip_fades_every_edge_click_free():
    out = tr.stitch_clip([np.ones(100, dtype=np.float32)], sr=1000, pause_ms=0.0, fade_ms=10.0)
    assert out[0] == pytest.approx(0.0) and out[-1] == pytest.approx(0.0)
    assert out[50] == pytest.approx(1.0)


def test_stitch_clip_empty():
    assert tr.stitch_clip([], sr=1000).size == 0


# ── passes: the music veto is validated, and it enters the identity ──────────

def test_normalize_clamps_the_music_veto():
    assert cleanup.normalize_passes({"trim": {"enabled": True, "music_veto": 1.9}})["trim"]["music_veto"] == 1.0
    assert cleanup.normalize_passes({"trim": {"enabled": True, "music_veto": -0.5}})["trim"]["music_veto"] == 0.0
    assert (cleanup.normalize_passes({"trim": {"enabled": True, "music_veto": "x"}})["trim"]["music_veto"]
            == cleanup.DEFAULT_MUSIC_VETO)                    # garbage → the ear-tuned default


def test_trim_identity_carries_the_veto_and_scorer_version():
    a = cleanup._passes_key({"trim": {"enabled": True, "max_excess_db": 6, "music_veto": 0.35}})
    b = cleanup._passes_key({"trim": {"enabled": True, "max_excess_db": 6, "music_veto": 0.50}})
    assert a != b                                             # a different veto is a different variant
    assert json.loads(a)["trim"]["v"] == cleanup.TRIM_SCORER_VERSION   # bumping the version regenerates


def test_default_preset_is_still_default_with_the_new_field():
    # the trim veto is on DEFAULT_PRESET but trim is OFF there, so the denoise-only default is
    # unchanged — one cleaned clip per source, §3.1.
    assert cleanup.is_default_preset(cleanup.DEFAULT_PRESET)
    assert cleanup.is_default_preset({"denoise": {"enabled": True, "wet": 1.0, "atten": 0.0}})


# ── _build_scored: VAD+tagger when scored, the SNR MVP when not ──────────────

def test_build_scored_uses_vad_and_vetoes_music_when_scored():
    rms = np.full(100, -30.0)                                 # every frame well above the floor
    scores = {"vad": {"segments": [[0.0, 0.6]]},
              "tagger": {"windows": [{"t": 0.0, "music_sfx": 0.9}, {"t": 0.4, "music_sfx": 0.85}]}}
    scored, tag = cleanup._build_scored(rms, -60.0, scores, float("inf"), music_veto=0.35)
    assert tag == "vad+tagger"
    assert len(scored) == 1 and scored[0].music_sfx > 0.35 and scored[0].keep is False


def test_build_scored_falls_back_to_snr_when_unscored():
    rms = np.array([-60.0, -20, -59, -45, -20, -46] * 20)
    scored, tag = cleanup._build_scored(rms, -60.0, None, float("inf"), float("inf"))
    assert tag == "snr"
    assert scored and all(r.music_sfx == 0.0 for r in scored)  # no music signal ⇒ veto is inert


# ── cleanup.py orchestration: cache-or-compute + graceful degradation ────────

def _scorer_cfg(tmp_path, monkeypatch):
    """A CleanupConfig whose isolated scorer, script and pinned model are materialized."""
    monkeypatch.setenv("VOCALIS_TRIM_VENV", str(tmp_path / "trim-venv"))
    monkeypatch.setenv("VOCALIS_TRIM_MODEL_ROOT", str(tmp_path / "models"))
    import engine_process   # the interpreter's layout is per-OS (Scripts/python.exe on Windows)
    py = engine_process.venv_python(tmp_path / "trim-venv")
    py.parent.mkdir(parents=True, exist_ok=True); py.write_text("#!/bin/sh\n")
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    cfg.trim_scorer_script.parent.mkdir(parents=True, exist_ok=True)
    cfg.trim_scorer_script.write_text("# child")
    cfg.trim_scorer_checkpoint.parent.mkdir(parents=True, exist_ok=True)
    cfg.trim_scorer_checkpoint.write_bytes(b"checkpoint")
    cfg.trim_scorer_labels.write_text("index,mid,display_name\n", encoding="utf-8")
    assert cfg.trim_scorer_available
    return cfg


_FAKE_SCORES = {"schema": "vocalis.trim_scores/1", "sr_in": 48000, "duration_s": 1.0,
                "vad": {"model": "silero-vad", "segments": [[0.0, 1.0]]},
                "tagger": {"model": "panns-cnn14", "hop_s": 1.0, "win_s": 1.0, "windows": []}}


def test_compute_scores_runs_the_child_once_then_serves_the_cache(tmp_path, monkeypatch):
    cfg = _scorer_cfg(tmp_path, monkeypatch)
    monkeypatch.setattr(cleanup, "scores_cache_path", lambda c, s: tmp_path / "scores.json")
    calls = {"n": 0}

    def fake_child(cfg, wav, out, cancel=None, on_line=None):
        calls["n"] += 1
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps(_FAKE_SCORES))
        return 0

    monkeypatch.setattr(cleanup, "_run_scorer_child", fake_child)
    src = tmp_path / "clip.wav"; src.write_bytes(b"RIFFfake")     # .wav ⇒ no decode step
    s1 = cleanup.compute_scores(cfg, src)
    assert s1 == _FAKE_SCORES and calls["n"] == 1
    s2 = cleanup.compute_scores(cfg, src)
    assert s2 == _FAKE_SCORES and calls["n"] == 1                 # cache hit — the child does NOT re-run
    assert cleanup.has_scores(cfg, src) is True                   # the cache the first run wrote is seen


def test_compute_scores_is_none_when_the_scorer_is_absent(tmp_path):
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)           # no venv ⇒ unavailable
    assert cfg.trim_scorer_available is False
    assert cleanup.compute_scores(cfg, tmp_path / "x.wav") is None


def test_compute_scores_degrades_when_the_child_fails(tmp_path, monkeypatch):
    cfg = _scorer_cfg(tmp_path, monkeypatch)
    monkeypatch.setattr(cleanup, "scores_cache_path", lambda c, s: tmp_path / "nope.json")
    monkeypatch.setattr(cleanup, "_run_scorer_child", lambda *a, **k: 1)   # non-zero exit
    src = tmp_path / "clip.wav"; src.write_bytes(b"x")
    assert cleanup.compute_scores(cfg, src) is None              # SNR-only fallback, never raises


def test_scores_cache_key_tracks_source_and_child_mtime(tmp_path, monkeypatch):
    cfg = _scorer_cfg(tmp_path, monkeypatch)
    src = tmp_path / "clip.wav"; src.write_bytes(b"a" * 10)
    p1 = cleanup.scores_cache_path(cfg, src)
    src.write_bytes(b"b" * 40)                                   # source changed ⇒ new key
    assert cleanup.scores_cache_path(cfg, src) != p1
    assert p1.suffix == ".json" and p1.parent.name == "trim_scores"


# ── analyze(): instant, honest about whether the music pass has run ──────────

def test_analyze_reports_scorer_fields_and_never_blocks(tmp_path, monkeypatch):
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)          # scorer unavailable on this box
    monkeypatch.setattr(tr, "_probe_sample_rate", lambda p: 16000)
    # 1 s of speech-level energy, then 1 s of near-silence, twice → clear energy-gate regions.
    sig = np.concatenate([np.full(16000, 0.3, np.float32), np.full(16000, 1e-4, np.float32)] * 2)
    monkeypatch.setattr(tr, "decode_mono", lambda p, sr: sig)
    # analyze must NOT run the child (it isn't available here anyway); assert it never even tries.
    monkeypatch.setattr(cleanup, "_run_scorer_child",
                        lambda *a, **k: pytest.fail("analyze must not run the scorer child"))
    out = cleanup.analyze(cfg, tmp_path / "clip.wav")
    assert out["scorer"] == "snr" and out["scorer_available"] is False and out["scored"] is False
    assert out["regions"] and all("music_sfx" in r and "excess_db" in r for r in out["regions"])
