"""Tests for the "Lead vocals only" DSP (leadvocal.py — 8.4, DESIGN_8_4_LEAD_VOCAL.md §3.5 · §5 · §9.5).

The module is deliberately pure — no subprocess, no store, no model — so everything here runs on
numpy arrays this file builds itself, in well under a second, with nothing installed. The models
that FEED it (`scripts/leadvocal/detect.py`) and the job that DRIVES it (`stemsplit.py`) are
covered elsewhere; what is pinned here is the arithmetic, because the arithmetic is what decides
which seconds of a song end up in somebody's voice-training dataset.

Four things in here are the point of the file, and each one fails SILENTLY if it regresses — the
job still succeeds, the clip still plays, and the damage only shows up as a voice model that
learned the wrong thing:

  * 🔴 **`merge_gap_sec` must not bridge a gap that had backing in it** (§5). Bridged, a 0.2 s
    harmony is welded back into the training material in the one place this whole feature exists
    to remove it. The pair `test_a_breath_gap_is_bridged` /
    `test_a_gap_that_held_backing_is_never_bridged` is the most valuable thing in this module.
  * 🔴 **`align_dry`'s four branches** (§3.5). The spans are measured on the WET file and applied
    to the DRY one; a few hundred samples of drift is not an error you can hear, it is a slightly
    worse dataset forever. Two of the four measured models come back SHORT with zero lag, so
    "pad it" and "refuse it" are both correct answers to different inputs.
  * 🔴 **A bad knob must never fail a job** — `params_from` clamps, and never raises.
  * 🔴 **`thin` is an answer, not a crash** (§9.5). Under 15 s of usable lead is a real outcome
    for a real song and has to read as one.

📌 Two regression tests preserve important failure modes: `spans_json` must keep the span list
rather than overwrite it with the summarized count, and `envelope_db` must handle a signal shorter
than one frame. The `#:` notes above each test record the specific contract.

⚠️ Everything runs at SR = 8000 with a 256/64 frame, which is the DEFAULT 2048/512 geometry scaled
down by the same factor — 32 ms of window, 8 ms of hop, 125 frames a second. The align tests are
the exception and run at 44.1 kHz on purpose: `ALIGN_PAD_LIMIT_S` is a duration, and the measured
deficits it has to straddle (300 and 396 samples) only sit where they really sit at the real rate.
"""
import json
from pathlib import Path

import numpy as np
import pytest
from conftest import install_lead_models

import leadvocal as lv

SR = 8000                  # the analysis rate for everything but align_dry
SR_HI = 44100              # ...which needs the real one — see the module docstring
FRAME, HOP = 256, 64       # 2048/512 scaled to SR: 125 frames/sec
FPS = SR / HOP


def _p(**kw) -> lv.LeadParams:
    """Default params at the test geometry. Built directly rather than through `params_from`, so a
    test that wants an ILLEGAL value (an inverted gate, a zero guard) can have one."""
    return lv.LeadParams(frame_length=FRAME, hop_length=HOP, **kw)


def _mask(n: int, runs) -> np.ndarray:
    """A frame mask with True over each [a, b) run — the shape `keep_mask` hands `spans_from`."""
    m = np.zeros(n, dtype=bool)
    for a, b in runs:
        m[a:b] = True
    return m


def _tone(hz: float, n: int, sr: int = SR) -> np.ndarray:
    return np.sin(2.0 * np.pi * hz * np.arange(n) / sr).astype(np.float32)


# ── the synthetic song: solo and stacked passages ─────────────────────────
#
# The synthetic fixture follows the measurement generator but keeps only what a unit test can
# assert on: the lead is ONE frequency and the
# backing stack is ANOTHER, so "did any stacked material survive the cut" is answerable with an
# FFT rather than by ear. A noise floor is present throughout because a separated stem is never
# digitally silent where the singer is out — `lead_floor_db` has to reject a real floor, not −∞,
# which any threshold would reject.

SECTIONS = [("silent", 2.0), ("solo", 8.0), ("stacked", 6.0),
            ("solo", 8.0), ("silent", 1.5), ("solo", 4.5)]
LEAD_HZ, BACK_HZ = 220.0, 1500.0
SOLO_SPANS = [(2.0, 10.0), (16.0, 24.0), (25.5, 30.0)]
SONG_SEC = 30.0            # the fixture's full length — the last solo runs right to the end


def _edge_guards(i: int, want_a: float, want_b: float, p):
    """How much `spans_from` erodes each end of span `i` — zero at the song's own edges.

The guard keeps a harmony onset or tail out of the retained material, so it applies at interior
boundaries where backing vocals are present. At the first and last sample there is no adjacent
backing span to guard against."""
    return (0.0 if want_a <= 0.0 else p.guard_sec,
            0.0 if want_b >= SONG_SEC else p.guard_sec)


@pytest.fixture(scope="module")
def song():
    """`(vocal, backing)` — a stereo "vocals stem" and the karaoke model's "backing" answer.

    `vocal` is what stage 1 hands over: the lead THROUGH the choruses as well as the verses, with
    the stack on top of it. `backing` is what the detector returns: the stack alone. Both carry the
    same −58 dBFS hiss."""
    n = int(sum(d for _k, d in SECTIONS) * SR)
    lead_g, back_g = np.zeros(n, np.float32), np.zeros(n, np.float32)
    t = 0.0
    for kind, dur in SECTIONS:
        a, b = int(t * SR), int((t + dur) * SR)
        if kind in ("solo", "stacked"):
            lead_g[a:b] = 0.9
        if kind == "stacked":
            back_g[a:b] = 0.5
        t += dur
    lead, back = _tone(LEAD_HZ, n) * lead_g, _tone(BACK_HZ, n) * back_g
    rng = np.random.default_rng(7)          # seeded: the floor is part of the fixture, not luck
    floor = 10.0 ** (-58.0 / 20.0)

    def stereo(mono):
        hiss = (rng.normal(0.0, 1.0, (n, 2)) * floor).astype(np.float32)
        return (np.stack([mono, mono], axis=1) + hiss).astype(np.float32)

    return stereo(lead + back), stereo(back)


def _band_power(x: np.ndarray, lo: float, hi: float, sr: int = SR) -> float:
    """Energy between `lo` and `hi` Hz — how a test asks "is the other singer in here"."""
    mono = x.mean(axis=1) if x.ndim > 1 else x
    mag = np.abs(np.fft.rfft(mono))
    f = np.fft.rfftfreq(len(mono), 1.0 / sr)
    return float((mag[(f >= lo) & (f <= hi)] ** 2).sum())


# ── params_from: a knob is clamped, never trusted, and never fatal ───────────────────────────

def test_an_empty_or_absent_body_is_the_known_good_default():
    """`params_from` is fed a request body, and "no overrides" is by far its commonest input."""
    assert lv.params_from({}) == lv.LeadParams()
    assert lv.params_from(None) == lv.LeadParams()
    assert lv.params_from("not a dict at all") == lv.LeadParams()


def test_out_of_range_knobs_are_clamped_not_rejected():
    """§5's bounds are a CLAMP. Rejecting the request instead would fail a job over a slider that
    went one notch too far, when the value one notch back was going to work fine — and
    `min_span_sec: 0` really would emit ten thousand 8 ms spans."""
    p = lv.params_from({"backing_enter_db": 40.0, "lead_floor_db": -400.0,
                        "min_span_sec": 0.0, "guard_sec": 99.0, "peak_dbfs": -50.0})
    assert p.backing_enter_db == 0.0            # (-90, 0)
    assert p.lead_floor_db == -90.0
    assert p.min_span_sec == 0.1                # (0.1, 60)
    assert p.guard_sec == 2.0
    assert p.peak_dbfs == -12.0


@pytest.mark.parametrize("bad", ["", "abc", None, [], {}, float("nan"),
                                 float("inf"), float("-inf")])
def test_an_unparseable_knob_falls_back_to_the_default_rather_than_raising(bad):
    """🔴 A BAD NUMBER MUST NOT FAIL A JOB THAT WOULD OTHERWISE HAVE PRODUCED A USABLE CLIP.
    Everything here is something a UI or a hand-written curl can really send, and every one of
    them has to land on the known-good default with no exception in sight."""
    p = lv.params_from({"guard_sec": bad, "backing_enter_db": bad, "frame_length": bad})
    assert p == lv.LeadParams()


def test_inverted_hysteresis_is_forced_back_so_the_gate_cannot_chatter():
    """🔴 §5. `backing_exit_db` ABOVE `backing_enter_db` is not hysteresis, it is an inversion, and
    the Schmitt trigger stops behaving like one: every frame whose level falls in the band turns
    the gate ON (it is above `enter`) and then OFF again on the very next frame (it is below
    `exit`). Each of those flips is a span boundary, `min_span_sec` discards the 8 ms spans that
    result, and the song reports no solo passages at all — a total failure that looks exactly like
    a song with backing on every bar.

    `params_from` pulls `exit` back DOWN to `enter`, which is the safe degenerate case: a plain
    threshold, no hysteresis, no chatter. The assertion is on the CONSEQUENCE as well as on the
    field, because the field is only interesting for what it stops the gate doing."""
    p = lv.params_from({"backing_enter_db": -36.0, "backing_exit_db": -30.0})
    assert p.backing_enter_db == -36.0
    assert p.backing_exit_db == -36.0           # pulled down, not swapped and not rejected

    env = np.full(40, -33.0, dtype=np.float32)  # a level inside the inverted band
    raw = _p(backing_enter_db=-36.0, backing_exit_db=-30.0)      # as typed, uncorrected
    chatter = lv.backing_present(env, raw)
    assert chatter[0] and not chatter[1]                          # on, off, on, off…
    assert int(np.diff(chatter.astype(np.int8)).astype(bool).sum()) == len(env) - 1

    steady = lv.backing_present(env, _p(backing_enter_db=p.backing_enter_db,
                                        backing_exit_db=p.backing_exit_db))
    assert steady.all()                          # one state for the whole passage: no boundaries


def test_inverted_knobs_still_produce_the_solo_spans(song):
    """The other half of the same guarantee, end to end: a body with the two thresholds swapped —
    the likeliest way to invert them by hand — still cuts the song into its three solo passages.
    A knob nobody can validate must degrade, not fail."""
    vocal, backing = song
    p = lv.params_from({"backing_enter_db": -36.0, "backing_exit_db": -30.0,
                        "frame_length": FRAME, "hop_length": HOP})
    spans, _lead_db, _on = lv.analyze(vocal, backing, SR, p)
    assert len(spans) == len(SOLO_SPANS)
    for i, ((got_a, got_b), (want_a, want_b)) in enumerate(zip(spans, SOLO_SPANS)):
        ea, eb = _edge_guards(i, want_a, want_b, p)
        assert got_a == pytest.approx(want_a + ea, abs=0.05)
        assert got_b == pytest.approx(want_b - eb, abs=0.05)


def test_the_frame_geometry_comes_back_as_int_not_float():
    """`frame_length` and `hop_length` index numpy arrays and divide sample rates. A float that
    arrived as JSON has to stop being one here, not three call frames further in."""
    p = lv.params_from({"frame_length": 1024.0, "hop_length": 256.7})
    assert isinstance(p.frame_length, int) and p.frame_length == 1024
    assert isinstance(p.hop_length, int) and p.hop_length == 257     # rounded, not truncated
    assert isinstance(lv.LeadParams().frames_per_sec(44100), float)


def test_dereverb_is_a_bool_and_defaults_on():
    """De-reverb defaults on and can be disabled explicitly. Requests that omit the option keep the default."""
    assert lv.params_from({}).dereverb is True
    assert lv.params_from({"dereverb": False}).dereverb is False
    assert lv.params_from({"dereverb": 0}).dereverb is False        # coerced, not passed through
    assert lv.params_from({"dereverb": "yes"}).dereverb is True


# ── the envelope and the two gates ───────────────────────────────────────────────────────────

def test_the_envelope_is_measured_against_the_reference_not_the_signals_own_peak():
    """🔴 §5, AND IT IS WHY ONE THRESHOLD TRAVELS ACROSS SONGS. Both envelopes are referenced to
    the WET VOCAL's peak. Measured against its own peak instead, the backing signal — whose level
    is a different thing in every song — would quietly redefine `backing_enter_db` per song, and
    the sensitivity knob would mean nothing."""
    x = np.full(FRAME * 4, 0.1, dtype=np.float32)       # RMS 0.1 exactly
    assert lv.envelope_db(x, 1.0, _p()) == pytest.approx(-20.0, abs=0.01)
    assert lv.envelope_db(x, 0.1, _p()) == pytest.approx(0.0, abs=0.01)
    assert lv.envelope_db(x, 0.5, _p()) == pytest.approx(-13.98, abs=0.01)
    # …and a stereo signal is one question about content, so it folds to mono first (`to_mono`):
    st = np.stack([np.full(FRAME * 4, 0.2, np.float32), np.zeros(FRAME * 4, np.float32)], axis=1)
    assert lv.envelope_db(st, 1.0, _p()) == pytest.approx(-20.0, abs=0.01)


def test_a_silent_signal_and_a_zero_reference_are_finite():
    """Neither raises, and neither produces a NaN that would poison every comparison downstream
    into silently-False. A silent LEAD gives `peak_of` 0, which is the reference `analyze` then
    hands both envelopes — so this is the real all-silence input, not a contrived one."""
    quiet = np.zeros(FRAME * 8, dtype=np.float32)
    assert np.all(np.isfinite(lv.envelope_db(quiet, 1.0, _p())))
    assert np.all(lv.envelope_db(quiet, 1.0, _p()) < -150.0)
    assert np.all(np.isfinite(lv.envelope_db(quiet, 0.0, _p())))
    assert lv.peak_of(np.zeros(0, dtype=np.float32)) == 0.0
    assert lv.analyze(quiet, quiet, SR, _p())[0] == []       # no spans, no exception


#: A signal shorter than one frame must produce zero frames. Clamp `1 + ...` after computing
#: the first-frame offset; clamping before the addition yields one frame and indexes past input.
def test_a_signal_shorter_than_one_frame_has_no_frames():
    """A stem too short to fill one analysis window has zero frames, not one. The honest answer is
    an empty envelope (which yields no spans, and a `thin` set) rather than an IndexError three
    stages into a job that has already run Demucs and two separators."""
    tiny = np.full(FRAME // 2, 0.5, dtype=np.float32)
    assert lv.envelope_db(tiny, 0.5, _p()).size == 0


def test_the_backing_gate_hystereses():
    """🔴 THE HYSTERESIS IS THE WHOLE POINT OF HAVING TWO THRESHOLDS. Once backing is present it
    stays present until the envelope drops below `backing_exit_db` — sagging back into the gap
    between the two, which is what a harmony does between words, must NOT release the gate. A
    single threshold chatters across that gap on every breath, and each chatter is a span boundary
    that `min_span_sec` then throws good material away over.

    Asserted on an envelope built by hand: this is a state machine, and feeding it audio would
    test the RMS front-end at the same time."""
    p = _p(backing_enter_db=-30.0, backing_exit_db=-36.0)
    env = np.array([-50.0,     # quiet — absent
                    -50.0,
                    -28.0,     # over `enter` — present
                    -33.0,     # sagged into the gap — STAYS present
                    -33.0,
                    -40.0,     # under `exit` — gone
                    -40.0,
                    -31.0,     # in the gap from below — stays gone (needs `enter`, not `exit`)
                    -29.0],    # over `enter` again — present
                   dtype=np.float32)
    assert list(lv.backing_present(env, p)) == [False, False, True, True, True,
                                                False, False, False, True]


def test_the_backing_gate_starts_absent():
    """It opens in the ABSENT state, so a song that opens on a solo line is not thrown away for
    want of a leading transition — and a song that opens mid-harmony still latches on its first
    frame rather than needing a quiet one first."""
    p = _p()
    assert not lv.backing_present(np.array([-50.0, -50.0], dtype=np.float32), p).any()
    assert lv.backing_present(np.array([-10.0, -10.0], dtype=np.float32), p).all()
    assert lv.backing_present(np.zeros(0, dtype=np.float32), p).shape == (0,)


def test_a_kept_frame_needs_both_a_singing_lead_and_no_backing():
    """§5, and the second half is the one that is easy to lose. An instrumental passage that leaked
    into the vocals stem has NO backing over it, so it satisfies "nobody else is singing" perfectly
    — `lead_floor_db` is the only thing standing between that leakage and the training set."""
    p = _p(lead_floor_db=-40.0)
    lead_db = np.array([-10.0,     # singing, alone            → keep
                        -10.0,     # singing, over a harmony   → drop
                        -45.0,     # instrumental bleed, alone → drop (this is the floor's job)
                        -45.0],    # bleed under a harmony     → drop
                       dtype=np.float32)
    on = np.array([False, True, False, True])
    assert list(lv.keep_mask(lead_db, on, p)) == [True, False, False, False]
    # A ragged pair (the two envelopes can differ by a frame) truncates rather than raising:
    assert lv.keep_mask(lead_db, on[:2], p).shape == (2,)


# ── spans_from: merge, then erode, then drop ─────────────────────────────────────────────────

def test_a_breath_gap_is_bridged():
    """§5's `merge_gap_sec`: a phrase must not be chopped mid-word. The gap here is 0.2 s of the
    LEAD dropping below its floor with no backing anywhere near it — a breath — so the two runs
    become one span. Paired with the test below, which is the same geometry with a harmony in the
    gap; the two differ ONLY in the backing mask."""
    p = _p()
    keep = _mask(800, [(0, 350), (375, 700)])           # 2.8 s, a 0.2 s gap, 2.6 s
    no_backing = np.zeros(800, dtype=bool)
    # Starts at frame 0 — the START OF THE SONG — so 8.6.6 does not erode it: the guard is there
    # to keep a harmony's tail out, and there is no harmony before the first sample. The END is
    # interior (700 of 800) and is still guarded. The point of this test is the BRIDGE, and that
    # is untouched: one span, not two.
    assert lv.spans_from(keep, no_backing, SR, p) == [(0.0, 5.4)]


def test_a_gap_that_held_backing_is_never_bridged():
    """🔴 **THE MOST IMPORTANT ASSERTION IN THIS FILE** (§5, and `spans_from`'s own docstring).

    Same two runs, same 0.2 s gap — but this time the gap is a harmony rather than a breath. It is
    under `merge_gap_sec`, so a naive merge welds the two runs together and puts 0.2 s of BACKING
    VOCALS straight back into the training material, silently, in the one place this entire feature
    exists to prevent. Nothing downstream would catch it: the clip plays, the job succeeds, and the
    voice model learns two singers.

    (`scripts/cleanup/trim_audio.py`'s `group_takes` records the identical rule for its own
    reason — a dropped region breaks the run.)"""
    p = _p()
    keep = _mask(800, [(0, 350), (375, 700)])
    harmony = _mask(800, [(350, 375)])                  # …in the gap, and only in the gap
    # 0.0 rather than 0.2 for the same reason as the test above (8.6.6, the song's own edge).
    # 🔴 EVERYTHING THIS TEST IS ABOUT IS UNCHANGED: two spans, not one, and the harmony's 0.2 s
    # falls outside BOTH of them. The interior boundaries either side of the gap are still
    # guarded — 2.6 and 3.2 — which is precisely where the guard matters.
    assert lv.spans_from(keep, harmony, SR, p) == [(0.0, 2.6), (3.2, 5.4)]
    # one frame of backing anywhere in the gap is enough to refuse it:
    assert lv.spans_from(keep, _mask(800, [(360, 361)]), SR, p) == [(0.0, 2.6), (3.2, 5.4)]


def test_a_gap_wider_than_the_merge_window_is_left_alone():
    """The other half of the merge rule: `merge_gap_sec` is a BREATH, not a verse. A 0.4 s hole
    with nothing in it is still two phrases."""
    p = _p(merge_gap_sec=0.3)
    keep = _mask(900, [(0, 350), (400, 750)])           # 0.4 s apart
    assert len(lv.spans_from(keep, np.zeros(900, dtype=bool), SR, p)) == 2


def test_each_span_is_eroded_by_the_guard_at_both_ends():
    """§5's `guard_sec`, and it erodes INWARD at BOTH ends — a harmony's onset or its reverb tail
    must not be able to reach a clip edge, and either end can be adjacent to one."""
    p = _p(guard_sec=0.2)
    keep = _mask(1000, [(125, 875)])                    # 1.0 s → 7.0 s
    assert lv.spans_from(keep, np.zeros(1000, dtype=bool), SR, p) == [(1.2, 6.8)]
    assert lv.spans_from(keep, np.zeros(1000, dtype=bool), SR, _p(guard_sec=0.0)) == [(1.0, 7.0)]


def test_min_span_judges_the_eroded_span_not_the_one_that_was_found():
    """🔴 THE ORDER IS LOAD-BEARING: merge, then erode, then drop. A 2.2 s run with a 0.2 s guard
    at each end is 1.8 s of audio, which is under `min_span_sec` — so it must be DROPPED, not
    written. Dropping before eroding would ship 1.8 s clips from a 2.0 s floor, and every one of
    them would be a little shorter than the setting promises."""
    p = _p(guard_sec=0.2, min_span_sec=2.0)
    empty = np.zeros(400, dtype=bool)
    # ⚠️ BOTH RUNS START AT FRAME 25, NOT 0 — the fixture moved INWARD at 8.6.6. A run touching
    # the song's edge is no longer eroded there, so the old fixture (starting at 0) would have
    # been guarded at one end instead of two and this test would have quietly stopped exercising
    # its own property. Fixing the fixture keeps the assertion; relaxing it would have kept the
    # test green and thrown the guarantee away.
    assert lv.spans_from(_mask(400, [(25, 300)]), empty, SR, p) == []         # 2.2 s → 1.8 s: no
    kept = lv.spans_from(_mask(400, [(25, 338)]), empty, SR, p)               # 2.5 s → 2.1 s: yes
    assert len(kept) == 1 and kept[0][1] - kept[0][0] >= p.min_span_sec


def test_spans_come_back_sorted_and_non_overlapping_in_seconds():
    """What the caller cuts with, and what `lead_spans.json` publishes. Frames are an internal
    detail; seconds are the contract."""
    p = _p()
    keep = _mask(2000, [(0, 400), (700, 1100), (1400, 1900)])
    spans = lv.spans_from(keep, np.zeros(2000, dtype=bool), SR, p)
    assert len(spans) == 3
    assert spans == sorted(spans)
    assert all(isinstance(t, float) for s in spans for t in s)
    assert all(a < b for a, b in spans)
    assert all(spans[i][1] <= spans[i + 1][0] for i in range(len(spans) - 1))
    assert lv.spans_from(np.zeros(2000, dtype=bool), np.zeros(2000, dtype=bool), SR, p) == []


# ── align_dry: §3.5's guard, at the real sample rate ─────────────────────────────────────────

def _loud(seconds: float = 3.0, sr: int = SR_HI) -> np.ndarray:
    """A stereo signal `lag_of` can actually correlate: loud from the first sample, and non-
    periodic, so a shifted copy has exactly one correlation peak rather than one per cycle."""
    rng = np.random.default_rng(11)
    n = int(seconds * sr)
    env = 0.5 + 0.5 * np.abs(np.sin(2.0 * np.pi * 1.7 * np.arange(n) / sr))
    mono = (rng.normal(0.0, 0.3, n) * env).astype(np.float32)
    return np.stack([mono, mono * 0.9], axis=1).astype(np.float32)


def test_identical_lengths_and_no_lag_pass_the_dry_file_through():
    """The two of four measured models that came back exactly right (§3.5)."""
    wet = _loud()
    dry = (wet * 0.7).astype(np.float32)            # de-reverbed: same timing, less energy
    out, why = lv.align_dry(dry, wet, SR_HI)
    assert why is None
    assert np.array_equal(out, dry)


@pytest.mark.parametrize("short_by", [300, 396])
def test_a_few_hundred_samples_short_is_padded_not_discarded(short_by):
    """🔴 §3.5's MEASURED CASE, and the reason this branch exists at all. `UVR-DeEcho-DeReverb`
    came back 300 samples short and `UVR-De-Reverb-aufr33-jarredou` 396 — with a cross-correlation
    lag of ZERO in both cases. So the deficit is the last analysis block being dropped, not a
    shift: samples 0..n line up exactly, and the answer is to pad 7 ms of silence onto the tail,
    NOT to throw away a de-reverbed file (and with it §4b's entire benefit) over a truncation
    nobody can hear."""
    wet = _loud()
    dry = (wet[:-short_by] * 0.7).astype(np.float32)
    out, why = lv.align_dry(dry, wet, SR_HI)
    assert why is None
    assert out.shape == wet.shape                                   # padded to the wet length…
    assert np.array_equal(out[:-short_by], dry)                     # …with the audio untouched…
    assert not out[-short_by:].any()                                # …and silence on the end
    assert short_by <= int(lv.ALIGN_PAD_LIMIT_S * SR_HI)            # both are inside the limit


def test_a_dry_file_longer_than_its_input_is_trimmed():
    """Never observed, and safe precisely BECAUSE the lag is zero — the extra samples can only be
    at the end. Kept as a branch for the same reason the two below are."""
    wet = _loud()
    dry = np.concatenate([wet * 0.7, np.zeros((200, 2), dtype=np.float32)]).astype(np.float32)
    out, why = lv.align_dry(dry, wet, SR_HI)
    assert why is None and out.shape == wet.shape


def test_short_by_more_than_the_pad_limit_is_refused():
    """Past `ALIGN_PAD_LIMIT_S` we stop trusting the file: 50 ms is an order of magnitude above
    anything measured, so a deficit that large is not "the last block", it is something else.
    The caller then cuts the WET file instead — a song with its reverb still in it is a usable
    dataset; a song cut at the wrong places is not."""
    wet = _loud()
    dry = (wet[:-int(0.2 * SR_HI)] * 0.7).astype(np.float32)
    out, why = lv.align_dry(dry, wet, SR_HI)
    assert out is None
    assert "short" in why and "0.200s" in why       # the reason reaches `dereverb_skipped` (§6)


def test_a_real_lag_is_found_and_the_dry_file_is_refused():
    """🔴 THE FAILURE §3.5 EXISTS TO CATCH, AND IT IS SILENT. The spans are measured on the wet
    file and applied to the dry one, which is only sound while de-reverb is sample-aligned. Shift
    the dry file and every cut point moves; what you hear is not an error, it is a slightly worse
    dataset. So: prove `lag_of` really finds a shift this small, then prove `align_dry` refuses the
    file rather than cutting at the wrong places."""
    wet = _loud()
    dry = np.roll(wet * 0.7, 300, axis=0).astype(np.float32)
    assert abs(lv.lag_of(wet, dry, SR_HI)) == 300       # (the sign is the correlation's own)
    out, why = lv.align_dry(dry, wet, SR_HI)
    assert out is None
    assert "offset" in why and "300" in why


def test_no_dry_audio_at_all_is_refused():
    """A de-reverb child that wrote an empty file is not a zero-length success."""
    out, why = lv.align_dry(np.zeros((0, 2), dtype=np.float32), _loud(), SR_HI)
    assert out is None and "no audio" in why


def test_lag_of_reads_zero_on_input_it_cannot_measure():
    """🔴 AN UNMEASURABLE LAG MUST READ AS "NO EVIDENCE OF A SHIFT", NOT AS A LAG. The caller's
    response to a non-zero lag is to discard the de-reverbed audio, so a correlation peak found in
    the noise floor costs §4b's whole benefit on a file that was fine."""
    quiet = np.zeros((SR_HI * 2, 2), dtype=np.float32)
    assert lv.lag_of(quiet, quiet, SR_HI) == 0                  # nothing to correlate
    assert lv.lag_of(_loud(0.5), _loud(0.5), SR_HI) == 0        # under a second: not enough


# ── cut_join: what actually gets written ─────────────────────────────────────────────────────

def test_the_output_is_the_spans_plus_one_gap_between_each_pair():
    """The arithmetic exactly: `silence_sec` goes BETWEEN pieces — never before the first or after
    the last, which would be dead air at the head of every training file."""
    p = _p(silence_sec=2.0, fade_sec=0.02)
    x = np.full((SR * 10, 2), 0.5, dtype=np.float32)
    spans = [(1.0, 3.0), (5.0, 6.5)]
    out = lv.cut_join(x, SR, spans, p)
    want = int(2.0 * SR) + int(1.5 * SR) + int(p.silence_sec * SR)      # 2 pieces, ONE gap
    assert len(out) == want
    # …and the gap really is silence, in the middle, where the join is:
    assert not out[int(2.0 * SR):int(4.0 * SR)].any()
    three = lv.cut_join(x, SR, [(1.0, 3.0), (4.0, 6.0), (7.0, 9.0)], p)
    assert len(three) == 3 * int(2.0 * SR) + 2 * int(p.silence_sec * SR)
    assert len(lv.cut_join(x, SR, spans, _p(silence_sec=0.0))) == int(3.5 * SR)


def test_the_join_is_peak_normalized_to_the_target():
    """§5: −0.25 dBFS after the join. Asserted in dB with a tolerance rather than against the raw
    float, because the target is a level, not a magic number."""
    p = _p()
    for amplitude in (0.05, 0.5, 0.99):
        x = np.full((SR * 8, 2), amplitude, dtype=np.float32)
        out = lv.cut_join(x, SR, [(1.0, 4.0), (5.0, 7.0)], p)
        assert 20.0 * np.log10(np.abs(out).max()) == pytest.approx(p.peak_dbfs, abs=0.01)


def test_every_piece_is_faded_in_and_out():
    """§5's `fade_sec`: click prevention at every edge. A hard cut into a sustained note is an
    audible tick, and a dataset full of ticks teaches the model to make them."""
    p = _p(fade_sec=0.02, silence_sec=1.0)
    x = np.full((SR * 8, 2), 0.5, dtype=np.float32)
    out = lv.cut_join(x, SR, [(1.0, 4.0), (5.0, 7.0)], p)
    f = int(p.fade_sec * SR)
    assert abs(out[0]).max() == 0.0 and abs(out[-1]).max() == 0.0
    # a RAMP, not a step: half way up the fade the sample is half the plateau
    plateau = float(np.abs(out[f * 4]).max())
    assert float(np.abs(out[f // 2]).max()) == pytest.approx(plateau * 0.5, abs=0.05)
    assert float(np.abs(out[f - 1]).max()) == pytest.approx(plateau, abs=0.05)
    # and the second piece is faded too — the sample after the gap starts from zero
    gap_end = int(3.0 * SR) + int(p.silence_sec * SR)
    assert float(np.abs(out[gap_end]).max()) == pytest.approx(0.0, abs=1e-6)


def test_stereo_stays_stereo():
    """🔴 THE VOCAL STEM IS STEREO AND THIS IS EDITING MATERIAL, NOT A CONVENIENCE MIXDOWN. A
    downstream encode can fold it if it wants to; the file that gets written cannot un-fold."""
    p = _p()
    spans = [(1.0, 4.0), (5.0, 7.0)]
    st = np.stack([np.full(SR * 8, 0.5, np.float32), np.full(SR * 8, 0.2, np.float32)], axis=1)
    out = lv.cut_join(st, SR, spans, p)
    assert out.ndim == 2 and out.shape[1] == 2
    assert not np.array_equal(out[:, 0], out[:, 1])         # the channels are still different
    assert lv.cut_join(np.full(SR * 8, 0.5, np.float32), SR, spans, p).ndim == 1   # mono stays 1-D
    assert out.dtype == np.float32


def test_nothing_to_cut_gives_an_empty_array_of_the_right_shape():
    """A song with no solo passage in it is §9.5's `thin` answer, and it has to travel all the way
    to the writer as audio — an empty (0, 2) array — rather than as an exception."""
    p = _p()
    st = np.full((SR * 4, 2), 0.5, dtype=np.float32)
    assert lv.cut_join(st, SR, [], p).shape == (0, 2)
    assert lv.cut_join(np.zeros((0, 2), dtype=np.float32), SR, [(1.0, 2.0)], p).shape == (0, 2)
    assert lv.cut_join(np.full(SR * 4, 0.5, np.float32), SR, [], p).shape == (0,)
    assert lv.cut_join(st, SR, [(90.0, 95.0)], p).shape == (0, 2)     # entirely past the end


# ── what the job records ─────────────────────────────────────────────────────────────────────

def test_a_thin_set_is_flagged_not_failed():
    """🔴 §9.5: under `MIN_USEFUL_SEC` of kept audio is SUCCESS WITH A WARNING BADGE. "This song
    is unusable for training" is a real answer about a real song and must not look like a crash —
    the user's next move is a different song, not a bug report."""
    assert lv.MIN_USEFUL_SEC == 15.0
    assert lv.summarize([(0.0, 14.9)], 200.0)["thin"] is True
    assert lv.summarize([(0.0, 15.1)], 200.0)["thin"] is False
    assert lv.summarize([], 200.0) == {"spans": 0, "kept_sec": 0.0,
                                       "source_sec": 200.0, "thin": True}
    many = lv.summarize([(0.0, 8.0), (10.0, 18.0)], 200.0)          # 16 s across two spans
    assert many["spans"] == 2 and many["kept_sec"] == 16.0 and many["thin"] is False


def test_the_lead_block_records_which_dereverb_made_the_file():
    """🔴 §4b's rule — a singer's dataset must never mix wet and dry material — is only CHECKABLE
    because every set says which it is. So `dereverb` is the MODEL NAME when it ran and `False`
    when it did not, and "true" is never an answer: it would name a file's provenance without
    saying what made it."""
    p = lv.LeadParams()
    ran = lv.lead_block([(1.0, 20.0)], 200.0, detector="d", device="cpu",
                        dereverb=lv.DEREVERB_DEFAULT, params=p, built_at="2026-08-17T00:00:00Z")
    assert ran["dereverb"] == lv.DEREVERB_DEFAULT
    assert ran["detector"] == "d" and ran["device"] == "cpu"
    assert ran["params"] == lv.as_dict(p) and ran["kept_sec"] == 19.0
    assert "dereverb_skipped" not in ran                    # nothing was skipped: no key at all
    for did_not in (False, None, ""):
        off = lv.lead_block([], 200.0, detector="d", device="cpu", dereverb=did_not,
                            params=p, built_at="t")
        assert off["dereverb"] is False


def test_dereverb_skipped_says_why_when_the_dry_file_was_refused():
    """The other end of `align_dry`: when the guard fires, the set records the reason, so a dataset
    that quietly went back to wet material is visible rather than mysterious (§3.5, §6)."""
    block = lv.lead_block([(1.0, 20.0)], 200.0, detector="d", device="cpu", dereverb=False,
                          params=lv.LeadParams(), built_at="t",
                          dereverb_skipped="lag 300 samples")
    assert block["dereverb_skipped"] == "lag 300 samples"
    assert block["dereverb"] is False


def test_spans_json_round_trips_with_the_provenance_of_the_cut():
    """`lead_spans.json` is the file that makes a bad detection reviewable instead of mysterious
    (§9.4). Everything a reviewer needs to reproduce the call has to survive `json.loads`: which
    detector looked at the song, whether the audio was de-reverbed and by what, why it was not, and
    the exact knobs that drew the lines."""
    p = lv.LeadParams()
    doc = json.loads(lv.spans_json([(2.2, 9.8), (16.2, 23.8)], 211.0, p,
                                   detector=lv.detector_name(), dereverb=lv.DEREVERB_DEFAULT))
    assert doc["detector"] == lv.detector_name()
    assert doc["dereverb"] == lv.DEREVERB_DEFAULT and doc["dereverb_skipped"] is None
    assert doc["params"] == lv.as_dict(p)
    assert doc["kept_sec"] == 15.2 and doc["source_sec"] == 211.0 and doc["thin"] is False
    skipped = json.loads(lv.spans_json([], 211.0, p, detector="d", dereverb=False,
                                       dereverb_skipped="length mismatch"))
    assert skipped["dereverb"] is False and skipped["dereverb_skipped"] == "length mismatch"
    assert skipped["kept_sec"] == 0.0 and skipped["thin"] is True


#: `summarize(...)` returns `spans: len(spans)`. Expanding it after the `spans` key overwrites
#: the cut-point list, leaving `lead_spans.json` without start, end, and duration (§9.4).
def test_spans_json_carries_the_spans_it_is_named_for():
    """🔴 THE FILE IS CALLED `lead_spans.json` AND THE SPANS ARE WHAT IT IS FOR. §9.4: per-song
    threshold overrides persist in the `lead:` block precisely "since the whole point of
    `lead_spans.json` is being able to see and redo a bad call" — and you cannot see a bad call
    from a COUNT. Every entry has to carry its own duration too, rather than making the reader
    subtract two floats per span."""
    doc = json.loads(lv.spans_json([(2.2, 9.8), (16.2, 23.8)], 211.0, lv.LeadParams(),
                                   detector="d", dereverb=False))
    assert isinstance(doc["spans"], list), f"spans is {type(doc['spans']).__name__}: {doc['spans']}"
    assert [s["start"] for s in doc["spans"]] == [2.2, 16.2]
    assert [s["end"] for s in doc["spans"]] == [9.8, 23.8]
    assert [s["dur"] for s in doc["spans"]] == [7.6, 7.6]


# ── the command builders ─────────────────────────────────────────────────────────────────────

def test_the_decode_drops_video_streams():
    """`-vn`, and it is not decoration: a Demucs WAV can carry a cover image forwarded from the
    source, and without this the encode FAILS — which reads as "the stem is corrupt"."""
    cmd = lv.build_decode_cmd(Path("in.opus"), Path("out.wav"))
    assert "-vn" in cmd
    assert cmd[cmd.index("-i") + 1] == "in.opus"
    assert cmd[-1] == "out.wav" and cmd[0] == "ffmpeg"
    assert "pcm_s16le" in cmd                       # plaintext scratch WAV, native rate/channels


def test_the_detect_command_omits_the_stage_it_is_not_running():
    """Either separation can be skipped, and the child decides by the ABSENCE of the flag — so a
    `--dereverb-out` that leaks in when de-reverb is off costs a 190 s model run per song, and a
    stray `--karaoke-out` writes a file nobody asked for."""
    both = lv.build_detect_cmd("py", "detect.py", "in.wav", karaoke_out="k.wav",
                               dereverb_out="d.wav", model_dir="/models",
                               karaoke_model=lv.KARAOKE_MODEL,
                               dereverb_model=lv.DEREVERB_DEFAULT, device="cpu")
    assert "--karaoke-out" in both and "--dereverb-out" in both
    assert both[both.index("--karaoke-model") + 1] == lv.KARAOKE_MODEL
    assert both[both.index("--dereverb-model") + 1] == lv.DEREVERB_DEFAULT
    assert both[both.index("--model-dir") + 1] == "/models"

    no_dry = lv.build_detect_cmd("py", "detect.py", "in.wav", karaoke_out="k.wav")
    assert "--dereverb-out" not in no_dry and "--dereverb-model" not in no_dry
    assert "--karaoke-out" in no_dry

    no_kara = lv.build_detect_cmd("py", "detect.py", "in.wav", dereverb_out="d.wav")
    assert "--karaoke-out" not in no_kara and "--karaoke-model" not in no_kara
    assert "--dereverb-out" in no_kara

    assert "--model-dir" not in lv.build_detect_cmd("py", "detect.py", "in.wav")


def test_every_argv_element_is_a_string():
    """A `Path` in an argv list is a subprocess landmine — it works on this platform until the day
    something joins the list into a string, and it has to be a `str` before it leaves this module,
    not wherever the child is finally spawned."""
    cmd = lv.build_detect_cmd(Path("/venv/bin/python"), Path("/s/detect.py"), Path("/tmp/in.wav"),
                              karaoke_out=Path("/tmp/k.wav"), dereverb_out=Path("/tmp/d.wav"),
                              model_dir=Path("/models"), karaoke_model=lv.KARAOKE_MODEL,
                              dereverb_model=lv.DEREVERB_DEFAULT, device="cpu")
    assert all(isinstance(a, str) for a in cmd), [type(a).__name__ for a in cmd]
    assert all(isinstance(a, str) for a in lv.build_decode_cmd(Path("a.opus"), Path("b.wav")))


@pytest.mark.parametrize("asked", ["", None, "nope.pth", "../../etc/passwd", 0, [],
                                   "UVR-DeEcho-DeReverb", "  "])
def test_an_unrecognized_dereverb_model_becomes_the_default(asked):
    """🔴 §4c: THIS IS AN ALLOWLIST, NOT A PREFERENCE. The value reaches a subprocess argument and
    a model FILENAME, so "unrecognized" has to mean the default rather than "pass it along and
    see" — including the near-miss (the name without its extension), which is the one a human
    would type."""
    assert lv.dereverb_model(asked) == lv.DEREVERB_DEFAULT


@pytest.mark.parametrize("known", lv.DEREVERB_MODELS)
def test_every_installed_dereverb_model_is_selectable(known):
    """The list exists so an A/B on a real vocal is a request field rather than a code change
    (§4c) — every name `scripts/leadvocal/setup.sh` installs has to survive the check."""
    assert lv.dereverb_model(known) == known
    assert lv.dereverb_model(f"  {known}  ") == known       # whitespace from a form field


def test_the_detector_is_recorded_as_a_model_not_a_filename():
    """§6: the sidecar says what looked at the song, and a `.onnx` on the end reads as a path."""
    assert lv.detector_name() == "UVR_MDXNET_KARA_2"
    assert not Path(lv.detector_name()).suffix
    assert lv.KARAOKE_MODEL.endswith(".onnx")               # …the FILE keeps its extension


# ── end to end: the solo passages, and only the solo passages ────────────────────────────────

def test_the_solo_passages_are_what_survives(song):
    """🔴 THE WHOLE FEATURE, IN ONE TEST, WITH NO MODEL AND NO SUBPROCESS.

    A synthetic song with solo and stacked passages, passed through `analyze` and then
    `cut_join`: the spans land on the three solo sections (inset by `guard_sec` at each end), and
    what comes out is the lead's frequency with the backing stack's GONE — 60-odd dB below where it
    sits in the uncut stem, which is the difference between "we removed the harmonies" and "we
    trained on them".

    ⚠️ Synthetic input proves the ARITHMETIC, not the DETECTOR — a real karaoke model on real
    real singing is a separate detector measurement. This pins that given a correct backing
    answer, the edit does the right thing with it."""
    vocal, backing = song
    p = _p()
    spans, lead_db, on = lv.analyze(vocal, backing, SR, p)

    assert len(spans) == 3, spans
    for i, ((got_a, got_b), (want_a, want_b)) in enumerate(zip(spans, SOLO_SPANS)):
        ea, eb = _edge_guards(i, want_a, want_b, p)
        assert got_a == pytest.approx(want_a + ea, abs=0.05)
        assert got_b == pytest.approx(want_b - eb, abs=0.05)
    # no span may touch the chorus, from either side — that is what the guard buys:
    for a, b in spans:
        assert b <= 10.0 or a >= 16.0

    # the intermediates `lead_spans.json` publishes are real measurements, not placeholders:
    assert len(lead_db) == len(on)
    assert lead_db[int(4.0 * FPS)] > -20.0          # verse: she is singing
    assert lead_db[int(0.5 * FPS)] < -50.0          # intro: she is not
    assert on[int(12.0 * FPS)] and not on[int(4.0 * FPS)]

    out = lv.cut_join(vocal, SR, spans, p)
    kept = sum(b - a for a, b in spans)
    assert len(out) == pytest.approx((kept + 2 * p.silence_sec) * SR, rel=0.01)
    assert out.shape[1] == 2
    assert lv.summarize(spans, len(vocal) / SR)["thin"] is False     # ~19 s: a usable set

    # 🔴 and the assertion the feature exists for: no stacked material came through.
    before = _band_power(vocal, BACK_HZ - 20, BACK_HZ + 20) / _band_power(vocal, 200, 240)
    after = _band_power(out, BACK_HZ - 20, BACK_HZ + 20) / _band_power(out, 200, 240)
    assert 10.0 * np.log10(before) > -20.0          # the stack IS in the stem…
    assert 10.0 * np.log10(after) < -60.0           # …and it is not in what we kept


# ── §9.8: did the detector separate anything, or hand the lead back? ─────────

def test_a_backing_that_tracks_the_lead_too_tightly_is_reported():
    """🔴 "THIS SONG IS UNUSABLE FOR TRAINING" IS A REAL ANSWER AND ALSO A POSSIBLE LIE.

    §9.5 makes an empty result a success with a warning rather than an error, and that is right:
    a song stacked end to end genuinely has no solo lead in it. But a failed separation produces
    exactly the same empty result, and the span count cannot tell the two apart — so without this
    check Vocalis tells you to throw a good vocal away in the confident voice of a real answer.

    In an eight-song measured set, the seven that separated cleanly came back at
    correlation 0.00-0.44 with a 13-28 dB interquartile spread between the two envelopes, because
    real backing vocals come and go. The one that looked wrong came back at **0.97 with a spread
    of 0.2 dB** — the same shape, scaled.

    ⚠️ WHAT THIS TEST DOES NOT ASSERT: which of the two causes it was. The check reports the
    observation and asks for a listen; it names no cause, and neither does this."""
    rng = np.random.default_rng(11)
    lead = -20.0 + rng.normal(0, 6, 4000).astype(np.float32)
    # The failure: the same envelope, 4 dB down. Constant offset, near-perfect correlation.
    assert lv.detection_looks_unreliable(lead, lead - 4.0, _p())
    # A real separation: backing that moves independently and sits well below.
    genuine = -38.0 + rng.normal(0, 12, 4000).astype(np.float32)
    assert not lv.detection_looks_unreliable(lead, genuine, _p())


def test_the_reliability_check_never_fires_on_too_little_or_flat_material():
    """It is ADVISORY and must not become a source of false alarms. Too few voiced frames to
    judge, or an envelope with no variance to correlate, both answer "no opinion" rather than
    guessing — the same discipline `lag_of` uses when it cannot measure a lag."""
    p = _p()
    tiny = np.full(50, -20.0, dtype=np.float32)
    assert lv.detection_looks_unreliable(tiny, tiny - 4.0, p) == ""
    flat = np.full(4000, -20.0, dtype=np.float32)          # zero variance: corrcoef is nan
    assert lv.detection_looks_unreliable(flat, flat - 4.0, p) == ""
    # Below `lead_floor_db` is not "voiced", so a silent file has nothing to judge either.
    silent = np.full(4000, -80.0, dtype=np.float32)
    assert lv.detection_looks_unreliable(silent, silent - 4.0, p) == ""


def test_the_warning_rides_in_the_lead_block_only_when_it_fired():
    """Present only when it fired, so a set WITHOUT the key is a set the detector handled —
    rather than one made before the check existed being indistinguishable from one that passed."""
    p = _p()
    clean = lv.lead_block([(0.0, 5.0)], 60.0, detector="d", device="cpu", dereverb=False,
                          params=p, built_at="t")
    assert "detector_warning" not in clean
    warned = lv.lead_block([], 60.0, detector="d", device="cpu", dereverb=False, params=p,
                           built_at="t", detector_warning="it did not separate this song")
    assert warned["detector_warning"] == "it did not separate this song"
    assert warned["thin"] is True and warned["spans"] == 0


def test_the_warning_names_no_cause_and_asks_for_a_listen():
    """The warning reports the measured correlation and spread without claiming why separation was
unreliable. It asks the listener to review the audio and decide whether it is usable."""
    rng = np.random.default_rng(13)
    lead = -20.0 + rng.normal(0, 6, 4000).astype(np.float32)
    msg = lv.detection_looks_unreliable(lead, lead - 4.0, _p())
    assert msg
    assert "correlation" in msg and "spread" in msg          # the evidence is in it
    for verdict in ("did not separate", "failed", "unusable", "copy of the lead"):
        assert verdict not in msg, f"the observation asserts a cause it cannot know: {verdict!r}"
    assert "please check it" in lv.LEAD_WARNING              # …and the ask is to listen
    assert "may be unusable" in lv.LEAD_WARNING


# ── 8.5: joining several finished takes into one training clip ───────────────

def test_join_takes_puts_silence_between_and_not_at_the_ends():
    """🔴 THE SILENCE IS THE FEATURE. RVC slices a dataset at silence, so each gap becomes a cut
    point and one joined file trains as the many separate takes it contains — which is what lets
    a singer's dataset be eight songs handed over as a single clip. Leading or trailing silence
    would just be dead air in the corpus."""
    a = np.full(100, 0.5, dtype=np.float32)
    b = np.full(100, 0.25, dtype=np.float32)
    out = lv.join_takes([a, b], sr=1000, gap_sec=0.02)          # gap = 20 samples
    assert out.shape == (220,)                                   # 100 + 20 + 100
    assert np.abs(out[100:120]).max() == 0.0                     # the gap is digital silence
    assert out[0] != 0.0 and out[-1] != 0.0                      # …and the ends are not


def test_join_takes_normalizes_the_whole_clip_once():
    """Two songs mastered at different levels must not train as one loud singer and one quiet
    one. The peak of the JOINED file is what is set, not each take's — normalizing per take
    would erase the relative dynamics inside a take to fix a difference between takes."""
    out = lv.join_takes([np.full(100, 0.9, np.float32), np.full(100, 0.05, np.float32)],
                        sr=1000, gap_sec=0.0)
    peak_db = 20 * np.log10(float(np.abs(out).max()))
    assert peak_db == pytest.approx(-0.25, abs=0.05)
    assert float(np.abs(out[100:]).max()) < float(np.abs(out[:100]).max())   # ratio preserved


def test_join_takes_unifies_channels_to_the_widest():
    """A selection can mix a stereo lead with a mono one. Concatenate needs one shape, and the
    honest way to get it is to widen the mono take — narrowing the stereo one would throw away
    half of a take to satisfy a bookkeeping requirement."""
    out = lv.join_takes([np.full(50, 0.5, np.float32), np.full((50, 2), 0.5, np.float32)],
                        sr=1000, gap_sec=0.0)
    assert out.ndim == 2 and out.shape[1] == 2


def test_join_takes_survives_an_empty_selection_or_an_empty_take():
    out = lv.join_takes([], sr=1000)
    assert out.size == 0
    only = lv.join_takes([np.zeros(0, np.float32), np.full(100, 0.5, np.float32)], sr=1000,
                         gap_sec=0.02)
    assert only.shape == (100,), "an empty take must not contribute a gap of its own"


def test_the_join_decode_pins_the_sample_rate():
    """🔴 EVERY TAKE IS DECODED TO ONE RATE FIRST, AND IT IS NOT A DETAIL. A stored stem is Opus,
    Opus is a 48 kHz codec, and `lead_solo.wav` is written at whatever its source was — so a
    real selection genuinely mixes 44.1 and 48 kHz. Concatenating those without resampling
    yields audio that plays at the wrong speed, silently. This feature has already paid for that
    trap once (§3.5's rate note); the `-ar` is what stops it being re-armed."""
    cmd = lv.build_decode_at_cmd("in.opus", "out.wav", 44100)
    assert "-ar" in cmd and cmd[cmd.index("-ar") + 1] == "44100"
    assert "-vn" in cmd                                          # a cover image fails the encode
    assert all(isinstance(c, str) for c in cmd)


# ── 8.5: which device the separator child is allowed to find ─────────────────

def test_detect_env_hides_the_cards_for_cpu_and_pins_one_for_a_gpu():
    """🔴 THERE IS NO `device=` ARGUMENT ON `Separator` — it auto-detects, taking `torch_device`
    from what torch reports. So the environment is the only lever: you cannot ask it for a
    device, you can only change what it is able to find. Same mechanism `voiceswap._card_env`
    already uses for Demucs and RVC.

    🔴 `-1`, NOT `""` AND NOT UNSET, AND THE DIFFERENCE IS A CRASH. Unset means "all of them"
    to both runtimes, so it was never an option. The EMPTY STRING was, and it is wrong on a CUDA
    box: `CUDA_VISIBLE_DEVICES=""` leaves `torch.cuda.is_available()`
    **True** with `device_count() == 0`, so `audio-separator` — which asks torch exactly that —
    moves the model to `cuda` and the child dies inside cuDNN's init with "min() arg is an empty
    sequence". On ROCm, where `""` and `-1` agree (both False): this only
    ever fixes a case, it never changes one."""
    cpu = lv.detect_env({"PATH": "/x"}, "cpu")
    assert cpu["HIP_VISIBLE_DEVICES"] == "-1" and cpu["CUDA_VISIBLE_DEVICES"] == "-1"
    assert cpu["PATH"] == "/x", "the rest of the environment must survive"
    one = lv.detect_env({}, "cuda:1")
    assert one["HIP_VISIBLE_DEVICES"] == "1" and one["CUDA_VISIBLE_DEVICES"] == "1"
    assert lv.detect_env({}, "cuda")["HIP_VISIBLE_DEVICES"] == "0"   # bare `cuda` is card 0
    # ⚠️ THE BOX CONVENTION IS STATED, NOT INHERITED. `vocalis_server` setdefaults
    # MIOPEN_FIND_MODE before importing torch, so in the SERVER this value is already in
    # `os.environ` and the child would get it anyway — which is exactly what makes an inherited
    # setting easy to lose: it becomes a property of who imported what. `voiceswap._card_env` has
    # set it on its own child env since 4.2 for the same reason. Measured on gfx1201: 51.9 s
    # default vs 22.6 s FAST. No-op on CUDA.
    assert lv.detect_env({}, "cpu")["MIOPEN_FIND_MODE"] == "FAST"
    assert lv.detect_env({"MIOPEN_FIND_MODE": "NORMAL"}, "cpu")["MIOPEN_FIND_MODE"] == "NORMAL", (
        "setdefault, not assignment - an operator who sets it deliberately must win")


# ── the separator's model files must already be on disk (audio-separator downloads otherwise) ──

ROFORMER = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"
ROFORMER_YAML = "dereverb_mel_band_roformer_anvuew.yaml"


def test_model_files_needed_lists_what_each_architecture_reads():
    """MDX and VR models are described by two hash tables; Roformer (MDXC) ones by a YAML instead.
    All of them are found through the catalog. (audio-separator 0.44.5: `download_model_files`,
    `load_model_data_from_yaml`, `load_model_data_using_hash`.)"""
    assert lv.model_files_needed(lv.KARAOKE_MODEL) == [
        "download_checks.json", "UVR_MDXNET_KARA_2.onnx",
        "vr_model_data.json", "mdx_model_data.json"]
    assert lv.model_files_needed(ROFORMER) == ["download_checks.json", ROFORMER, ROFORMER_YAML]
    assert lv.model_files_needed() == ["download_checks.json"]
    assert lv.model_files_needed("", None) == ["download_checks.json"]


def test_model_files_needed_names_every_retained_model_once():
    got = lv.model_files_needed(lv.KARAOKE_MODEL, *lv.DEREVERB_MODELS)
    assert len(got) == len(set(got)), got
    for model in (lv.KARAOKE_MODEL, *lv.DEREVERB_MODELS):
        assert model in got
    assert got.count("download_checks.json") == 1
    # Both Roformer de-reverb models share one YAML; the other two are VR and need the tables.
    assert ROFORMER_YAML in got and "vr_model_data.json" in got and "mdx_model_data.json" in got


def test_require_models_names_the_missing_files_and_says_setup_fetches_them(tmp_path):
    """October 11, 2026: the licensing hold is lifted; setup downloads the files, so the message says
    they have not been downloaded and how to get them. No licence wording, no server path."""
    with pytest.raises(RuntimeError) as err:
        lv.require_models(tmp_path, lv.KARAOKE_MODEL)
    message = str(err.value)
    assert lv.KARAOKE_MODEL in message and "download_checks.json" in message
    assert "have not been downloaded yet" in message
    assert "Run setup again" in message and "Start menu > Repair setup" in message
    assert "licen" not in message.lower() and "edition" not in message.lower()
    assert str(tmp_path) not in message, "a server path must not reach the user"


def test_the_lock_setup_downloads_covers_every_file_the_product_can_ask_for():
    """packaging/models/leadvocal/model-file-lock.json must name every file `model_files_needed` can
    return for the karaoke model and every allowlisted de-reverb model, or a complete setup would still
    leave Lead Vocal reporting a missing file. (Lives beside the code that defines the list.)"""
    lock_path = (Path(__file__).resolve().parents[3] / "packaging" / "models" / "leadvocal"
                 / "model-file-lock.json")
    if not lock_path.is_file():                      # a checkout of the application source alone
        pytest.skip("the packaging lock is not in this checkout")
    locked = {entry["path"] for entry in json.loads(lock_path.read_text(encoding="utf-8"))["files"]}
    needed = set(lv.model_files_needed(lv.KARAOKE_MODEL, *lv.DEREVERB_MODELS))
    assert needed <= locked, f"not downloaded by setup: {sorted(needed - locked)}"
    assert locked <= needed, f"downloaded by setup but never read: {sorted(locked - needed)}"


def test_require_models_names_only_what_is_missing(tmp_path):
    install_lead_models(tmp_path, lv.KARAOKE_MODEL)
    (tmp_path / lv.KARAOKE_MODEL).unlink()
    with pytest.raises(RuntimeError) as err:
        lv.require_models(tmp_path, lv.KARAOKE_MODEL)
    message = str(err.value)
    assert lv.KARAOKE_MODEL in message
    assert "download_checks.json" not in message and "vr_model_data.json" not in message


def test_require_models_passes_when_every_file_is_there(tmp_path):
    install_lead_models(tmp_path)
    lv.require_models(tmp_path, lv.KARAOKE_MODEL, *lv.DEREVERB_MODELS)      # raises nothing
    assert lv.missing_model_files(tmp_path, lv.KARAOKE_MODEL, *lv.DEREVERB_MODELS) == []


def test_a_directory_with_a_models_name_is_not_the_model(tmp_path):
    """The library's own skip-the-download test is `os.path.isfile`, so this asks the same."""
    install_lead_models(tmp_path, lv.KARAOKE_MODEL)
    (tmp_path / lv.KARAOKE_MODEL).unlink()
    (tmp_path / lv.KARAOKE_MODEL).mkdir()
    assert lv.missing_model_files(tmp_path, lv.KARAOKE_MODEL) == [lv.KARAOKE_MODEL]


def test_no_model_dir_is_checked_where_the_child_defaults_to_look(tmp_path, monkeypatch):
    """`detect.py --model-dir` defaults to `~/leadvocal-models`; a config that names no
    directory must not be checked somewhere the child will not look."""
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert lv.missing_model_files(None, lv.KARAOKE_MODEL)
    install_lead_models(tmp_path / "leadvocal-models", lv.KARAOKE_MODEL)
    assert lv.missing_model_files(None, lv.KARAOKE_MODEL) == []


def _load_detect(name):
    """`scripts/leadvocal/detect.py` as a module, with a fake `audio_separator` it can import."""
    import importlib.util
    path = Path(__file__).resolve().parent.parent / "scripts" / "leadvocal" / "detect.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_separator_child_cannot_download_a_model_it_was_not_given(tmp_path, monkeypatch):
    """The parent's check is the guarantee; this is the backstop inside the child for a file the
    check did not foresee. The fake `Separator` behaves like the real one: `load_model` asks
    `download_file_if_not_exists` for each file, which fetches when the file is absent."""
    import sys
    import types
    fetched = []

    class FakeSeparator:
        def __init__(self, **kwargs):
            self.model_file_dir = kwargs["model_file_dir"]

        def download_file_if_not_exists(self, url, output_path):
            if not Path(output_path).is_file():
                fetched.append(url)                           # the real one would download here

        def load_model(self, model_filename):
            self.download_file_if_not_exists(
                "https://example.invalid/" + model_filename,
                str(Path(self.model_file_dir) / model_filename))
            self.model_instance = types.SimpleNamespace(primary_stem_name="Vocals")

    package = types.ModuleType("audio_separator")
    package.__path__ = []
    module = types.ModuleType("audio_separator.separator")
    module.Separator = FakeSeparator
    monkeypatch.setitem(sys.modules, "audio_separator", package)
    monkeypatch.setitem(sys.modules, "audio_separator.separator", module)

    detect = _load_detect("detect_backstop_test")
    monkeypatch.setattr(detect, "_pin_onnx_provider", lambda sep, device: None)
    models = tmp_path / "models"
    models.mkdir()

    with pytest.raises(RuntimeError) as err:
        detect._get_sep("m.onnx", tmp_path / "work", models, "cpu")
    assert "m.onnx is not installed" in str(err.value) and "Nothing was downloaded" in str(err.value)
    assert fetched == [], "the child tried to download a model"

    (models / "m.onnx").write_bytes(b"")                      # present: the load proceeds unchanged
    sep = detect._get_sep("m.onnx", tmp_path / "work", models, "cpu")
    assert sep.model_instance.primary_stem_name == "Vocals"
    assert fetched == []


def test_the_guard_never_erodes_the_songs_own_first_and_last_moments():
    """The guard erodes retained spans only at interior boundaries. The start and end of the song have no adjacent backing span, so those edges remain intact."""
    p = _p(guard_sec=0.2, min_span_sec=0.5)
    empty = np.zeros(400, dtype=bool)

    # The whole analyzed signal is one solo passage: nothing is eroded at either end.
    whole = lv.spans_from(_mask(400, [(0, 400)]), empty, SR, p)
    assert len(whole) == 1
    assert whole[0][0] == 0.0, "the song's first moment was eroded against nothing"
    assert whole[0][1] == pytest.approx(400 * p.hop_length / SR, abs=0.01), (
        "the song's last moment was eroded against nothing — this is the chopped ending")

    # An INTERIOR passage is still guarded at both ends, which is the whole point of the guard.
    inner = lv.spans_from(_mask(400, [(100, 300)]), empty, SR, p)
    assert len(inner) == 1
    fs = p.hop_length / SR
    assert inner[0][0] == pytest.approx(100 * fs + p.guard_sec, abs=0.001)
    assert inner[0][1] == pytest.approx(300 * fs - p.guard_sec, abs=0.001)

    # And a span that starts at the song's edge but ends inside it is guarded on ONE side only.
    half = lv.spans_from(_mask(400, [(0, 300)]), empty, SR, p)
    assert half[0][0] == 0.0
    assert half[0][1] == pytest.approx(300 * fs - p.guard_sec, abs=0.001)
