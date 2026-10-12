"""Pure DSP tests for speech trimming and auto-curation.

Audio-quality evaluation is separate. These tests pin relative noise scoring, removal of short
blips, bridging of small gaps, separation across noisy regions, and click-free crossfades.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "cleanup"))

import trim_audio as tr  # noqa: E402


# ── --sweep parsing ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("spec,want", [
    ("3,6,9,12", [3.0, 6.0, 9.0, 12.0]),
    ("6",        [6.0]),
    ("3,3,6",    [3.0, 6.0]),          # de-duped, order kept
    ("-3,6",     [-3.0, 6.0]),         # negative is legal (tolerate cleaner-than-cleanest)
    ("3, ,x,6",  [3.0, 6.0]),          # blanks / garbage dropped, not fatal
    ("",         []),
])
def test_parse_thresholds(spec, want):
    assert tr.parse_thresholds(spec) == want


# ── frame energy ─────────────────────────────────────────────────────────────

def test_frame_rms_db_of_a_known_level():
    """A constant 0.1-amplitude signal is 0.1 RMS = -20 dBFS, per frame."""
    sr, x = 1000, np.full(100, 0.1, dtype=np.float32)     # 5 frames of 20 ms
    db = tr.frame_rms_db(x, sr, frame_ms=20.0)
    assert db.shape == (5,)
    assert np.allclose(db, -20.0, atol=0.01)


def test_frame_rms_db_of_silence_is_finite():
    """Digital-zero frames must floor, not go to -inf, or every percentile downstream breaks."""
    db = tr.frame_rms_db(np.zeros(100, dtype=np.float32), 1000, frame_ms=20.0)
    assert np.all(np.isfinite(db))
    assert np.all(db < -150)


def test_frame_rms_db_empty():
    assert tr.frame_rms_db(np.zeros(0, dtype=np.float32), 1000).size == 0


# ── the global floor ─────────────────────────────────────────────────────────

def test_global_floor_is_a_low_percentile_not_the_min():
    """The pristine background is the quiet gaps, but not the one dead-silent frame — a
    percentile ignores that outlier where a min would chase it to -200 dB."""
    rms = np.array([-200.0, -60, -58, -55, -50, -45, -40, -30, -20, -10])
    floor = tr.global_floor_db(rms, pct=5.0)
    assert -70 < floor < -55                              # near the quiet cluster, not -200


def test_global_floor_median_check():
    assert tr.global_floor_db(np.array([1.0, 2, 3, 4, 5]), pct=50.0) == pytest.approx(3.0)


# ── the cleanliness score (the §2.3 MVP idea) ────────────────────────────────

def test_clean_region_scores_near_zero_excess():
    """A region whose inter-word gaps match the file's pristine quiet is clean."""
    region = np.array([-60.0, -58, -20, -18, -59, -61])   # gaps ~-60, speech ~-19
    assert abs(tr.region_noise_excess_db(region, floor_db=-60.0)) < 2.0


def test_noisy_region_scores_a_positive_excess():
    """Speech-over-hiss: the region's gaps sit well ABOVE the global floor."""
    region = np.array([-45.0, -44, -20, -18, -46, -45])   # gaps ~-45, floor -60
    assert tr.region_noise_excess_db(region, floor_db=-60.0) > 12.0


def test_empty_region_is_zero_excess():
    assert tr.region_noise_excess_db(np.array([]), floor_db=-60.0) == 0.0


# ── mask → regions (bridge short gaps, drop short blips) ──────────────────────

def _m(bits):
    return np.array([b == 1 for b in bits], dtype=bool)


def test_regions_split_on_a_long_gap():
    regions = tr.mask_to_regions(_m([1, 1, 1, 0, 0, 0, 1, 1]),
                                 frame_ms=20.0, min_region_s=0.04, merge_gap_s=0.04)
    assert regions == [(0, 3), (6, 8)]


def test_short_inter_word_gap_is_bridged():
    """One frame of silence inside speech is a breath, not a region boundary."""
    regions = tr.mask_to_regions(_m([1, 1, 0, 1, 1]),
                                 frame_ms=20.0, min_region_s=0.04, merge_gap_s=0.04)
    assert regions == [(0, 5)]


def test_a_blip_shorter_than_the_minimum_is_dropped():
    regions = tr.mask_to_regions(_m([1, 0, 0, 0, 0]),
                                 frame_ms=20.0, min_region_s=0.04, merge_gap_s=0.04)
    assert regions == []


# ── scoring + verdict ────────────────────────────────────────────────────────

def test_score_regions_keeps_clean_drops_noisy():
    # frames: region A (clean, gaps -60) then region B (hissy, gaps -45)
    rms = np.array([-60.0, -20, -59,   -45, -20, -46])
    floor = -60.0
    scored = tr.score_regions(rms, [(0, 3), (3, 6)], floor, max_excess_db=6.0)
    assert scored[0].keep is True and scored[0].excess_db < 6.0
    assert scored[1].keep is False and scored[1].excess_db > 6.0
    assert scored[0].start_s == pytest.approx(0.0)
    assert scored[1].end_s == pytest.approx(6 * 0.02)


def test_threshold_moves_the_line():
    """Lower max-excess = more conservative = drops more. The one tunable, swept by ear."""
    rms = np.array([-52.0, -20, -53])                     # ~8 dB of excess over a -60 floor
    region = [(0, 3)]
    assert tr.score_regions(rms, region, -60.0, max_excess_db=6.0)[0].keep is False
    assert tr.score_regions(rms, region, -60.0, max_excess_db=12.0)[0].keep is True


# ── takes (never splice across a discontinuity) ──────────────────────────────

def _r(a, b, keep):
    return tr.Region(start_s=a, end_s=b, excess_db=0.0, keep=keep)


def test_adjacent_kept_regions_join_into_one_take():
    takes = tr.group_takes([_r(0, 1, True), _r(1.5, 2.5, True), _r(3, 4, True)], max_gap_s=1.0)
    assert len(takes) == 1 and len(takes[0]) == 3


def test_a_dropped_region_breaks_the_take():
    """The whole point: the noisy stretch between two clean ones is removed AND severs the
    take, so we never stitch across the discontinuity it marks."""
    takes = tr.group_takes([_r(0, 1, True), _r(1.2, 2.0, False), _r(2.1, 3, True)], max_gap_s=1.0)
    assert len(takes) == 2


def test_a_wide_gap_breaks_the_take():
    takes = tr.group_takes([_r(0, 1, True), _r(5, 6, True)], max_gap_s=1.0)
    assert len(takes) == 2


def test_summarize_counts_minutes_and_takes():
    regions = [_r(0, 30, True), _r(30.5, 60, True), _r(61, 90, False)]
    s = tr.summarize(regions)
    assert s["kept_s"] == pytest.approx(59.5)
    assert s["dropped_s"] == pytest.approx(29.0)
    assert s["n_takes"] == 1                               # the two kept join (0.5 s gap)
    assert s["n_dropped"] == 1


# ── click-free stitch ────────────────────────────────────────────────────────

def test_single_chunk_take_is_untouched():
    chunk = np.array([0.1, -0.2, 0.3], dtype=np.float32)
    assert np.array_equal(tr.crossfade_concat([chunk], sr=1000), chunk)


def test_crossfade_overlaps_by_the_fade_length():
    a = np.ones(100, dtype=np.float32)
    b = np.ones(100, dtype=np.float32)
    out = tr.crossfade_concat([a, b], sr=1000, fade_ms=20.0)      # fade = 20 samples
    assert len(out) == 180                                        # 100 + 100 - 20
    assert np.allclose(out, 1.0)                                  # constant across the join
    assert out.dtype == np.float32


def test_crossfade_is_bounded_no_click():
    rng = np.random.default_rng(0)
    a = rng.uniform(-1, 1, 500).astype(np.float32)
    b = rng.uniform(-1, 1, 500).astype(np.float32)
    out = tr.crossfade_concat([a, b], sr=1000, fade_ms=20.0)
    assert np.all(np.abs(out) <= 1.0 + 1e-6)                      # a linear blend cannot exceed the inputs
