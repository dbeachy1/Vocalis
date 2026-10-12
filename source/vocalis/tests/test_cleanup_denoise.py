"""Pure logic tests for the speech-denoise child.

Model quality requires separate audio evaluation. These tests pin the dry/wet length handling,
unchanged output at wet=1.0, sweep validation and ordering, and shared install-shim imports.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "cleanup"))

import denoise_audio as dn  # noqa: E402


# ── the shared install shims resolve (no drift, no copy) ─────────────────────

def test_the_enhance_shims_are_imported_not_reinvented():
    """The deepspeed stub / numpy-2 patch / weights fetch live once, in enhance_audio.py,
    and denoise imports them. If this is None the cross-seam import broke — which would send
    denoise reaching for its own copy, the exact drift the sharing exists to prevent."""
    assert dn._shim_deepspeed is not None
    assert dn._patch_numpy2 is not None
    assert dn._weights_dir is not None


# ── --wet-sweep parsing ──────────────────────────────────────────────────────

@pytest.mark.parametrize("spec,want", [
    ("1.0,0.7,0.4", [1.0, 0.7, 0.4]),
    ("0.7",         [0.7]),
    ("1,1,0.5",     [1.0, 0.5]),          # de-duped, order kept — don't render 1.0 twice
    ("0.7 , 0.4 ",  [0.7, 0.4]),          # whitespace tolerated
    ("1.5,-0.2,0.5", [1.0, 0.0, 0.5]),    # clamped into [0,1], not dropped
    ("0.7,,x,0.4",  [0.7, 0.4]),          # empty / non-numeric tokens dropped, not fatal
    ("",            []),
    ("garbage",     []),
])
def test_parse_levels(spec, want):
    assert dn.parse_levels(spec) == want


def test_parse_levels_dedup_is_order_preserving():
    assert dn.parse_levels("0.4,1.0,0.4,0.7,1.0") == [0.4, 1.0, 0.7]


# ── the dry/wet mix ──────────────────────────────────────────────────────────

def test_full_wet_returns_the_denoised_signal_untouched():
    """wet=1.0 is the model output as-is: no truncation to the original's length, no
    resample round-trip. The fully-denoised clip must be exactly what came out of denoise()."""
    d = np.array([0.1, -0.2, 0.3, -0.4, 0.5], dtype=np.float32)
    orig = np.zeros(3, dtype=np.float32)                 # deliberately a different length
    out = dn.dry_wet_mix(orig, d, 1.0)
    assert np.array_equal(out, d)
    assert len(out) == len(d)                            # NOT clipped to the original


def test_mix_blends_and_stays_float32():
    d = np.array([1.0, 1.0, 1.0, 1.0], dtype=np.float32)
    o = np.array([0.0, 0.0, 0.0, 0.0], dtype=np.float32)
    out = dn.dry_wet_mix(o, d, 0.25)
    assert out.dtype == np.float32
    assert np.allclose(out, 0.25)                        # 0.25·1 + 0.75·0


def test_wet_zero_is_the_original():
    d = np.array([1.0, 1.0, 1.0], dtype=np.float32)
    o = np.array([0.2, 0.4, 0.6], dtype=np.float32)
    assert np.allclose(dn.dry_wet_mix(o, d, 0.0), o)


def test_mix_survives_a_length_mismatch():
    """The denoiser pads internally, so its output is not guaranteed to match a resample of
    the original to the sample. Aligning to the shorter length is what stops a raw `+` from
    raising two minutes into a real run; a few edge samples are inaudible."""
    d = np.arange(10, dtype=np.float32)
    o = np.arange(7, dtype=np.float32)
    out = dn.dry_wet_mix(o, d, 0.5)
    assert len(out) == 7                                 # min(10, 7)
    assert np.allclose(out, 0.5 * d[:7] + 0.5 * o[:7])


# ── sweep output naming ──────────────────────────────────────────────────────

@pytest.mark.parametrize("wet,name", [
    (1.0,  "out.wet100.wav"),
    (0.7,  "out.wet070.wav"),
    (0.4,  "out.wet040.wav"),
    (0.04, "out.wet004.wav"),
    (0.0,  "out.wet000.wav"),
])
def test_wet_output_path(wet, name):
    assert dn.wet_output_path(Path("/x/out.wav"), wet).name == name


def test_wet_output_path_keeps_the_directory_and_suffix():
    p = dn.wet_output_path(Path("/a/b/reading.denoised.wav"), 0.7)
    assert p.parent == Path("/a/b")
    assert p.suffix == ".wav"
    assert p.name == "reading.denoised.wet070.wav"


def test_sweep_names_are_distinct_and_sortable():
    """A three-digit tag keeps 1.00 / 0.70 / 0.40 apart and in listing order, so an A/B set
    never collides or shuffles."""
    base = Path("/x/o.wav")
    names = [dn.wet_output_path(base, v).name for v in dn.parse_levels("1.0,0.7,0.4")]
    assert len(set(names)) == 3
    assert names == sorted(names, reverse=True)          # wet100 > wet070 > wet040
