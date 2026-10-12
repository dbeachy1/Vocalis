"""The Clean up denoise pass is TIMED on the box that will do it, or it has no ETA.

The sibling of test_enhance_rate.py, same rule (design §5). Denoise has no step count and is
CPU by design, so the key is just model+device — but the measure-don't-guess discipline is
identical: one real run yields both startup and per-second rate, an untimed box says nothing,
and a fused measurement (load_s=0) is refused rather than allowed to inflate every later ETA.
"""
import pytest

import cleanup_rate


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Never touch — or read — the real rate cache: a test that passes because the dev box
    happens to have denoised a clip is not a test."""
    monkeypatch.setattr(cleanup_rate, "cache_root", lambda: tmp_path)


CPU = cleanup_rate.key_for()


def test_an_untimed_box_has_no_rate_at_all():
    assert cleanup_rate.get(CPU) is None
    assert cleanup_rate.eta_seconds(3600, None) is None


def test_one_real_run_measures_both_parameters():
    cleanup_rate.record(CPU, audio_s=120.0, compute_s=48.0, startup_s=3.5)
    startup, rate = cleanup_rate.get(CPU)
    assert startup == pytest.approx(3.5, abs=0.01)
    assert rate == pytest.approx(0.40, abs=0.001)          # 48 / 120
    assert cleanup_rate.eta_seconds(120, (startup, rate)) == pytest.approx(51.5, abs=1.0)


def test_a_rate_needs_some_audio_behind_it():
    cleanup_rate.record(CPU, audio_s=2.0, compute_s=0.8, startup_s=3.4)
    assert cleanup_rate.get(CPU) is None, "2 seconds is not a measurement"
    cleanup_rate.record(CPU, audio_s=120.0, compute_s=48.0, startup_s=3.4)
    assert cleanup_rate.get(CPU) is not None


def test_runs_accumulate_into_the_overall_rate():
    cleanup_rate.record(CPU, audio_s=100.0, compute_s=30.0, startup_s=3.0)   # 0.30 s/s
    cleanup_rate.record(CPU, audio_s=100.0, compute_s=50.0, startup_s=3.0)   # 0.50 s/s
    _startup, rate = cleanup_rate.get(CPU)
    assert rate == pytest.approx(80.0 / 200.0)             # 0.40 overall


def test_the_device_is_part_of_the_key():
    """A denoise timed on the CPU says nothing about one forced onto a card, and vice versa."""
    cleanup_rate.record(cleanup_rate.key_for(device="cpu"), 120.0, 48.0, 3.5)
    assert cleanup_rate.get(cleanup_rate.key_for(device="cpu")) is not None
    assert cleanup_rate.get(cleanup_rate.key_for(device="cuda")) is None


def test_a_fused_measurement_is_refused():
    """load_s=0 means the child's pre-load was refused, so compute_s STILL contains the model
    load. Recording it would charge the load twice for a multi-take run."""
    assert cleanup_rate.parse_timing(
        "VOCALIS_TIMING audio_s=120.000 load_s=0.000 compute_s=52.400") is None


def test_the_timing_line_is_parsed():
    t = cleanup_rate.parse_timing(
        "VOCALIS_TIMING audio_s=120.000 load_s=3.500 compute_s=48.000")
    assert t["audio_s"] == 120.0 and t["compute_s"] == 48.0 and t["load_s"] == 3.5
    assert cleanup_rate.parse_timing("denoise(dfn3): 44100 Hz -> 48000 Hz") is None
    assert cleanup_rate.parse_timing("VOCALIS_TIMING garbage") is None


def test_eta_charges_the_model_load_once_per_take():
    """Each denoised take pays the model load again (files=takes), exactly as the book pays it
    once per chapter in enhance_rate."""
    fit = (3.5, 0.40)
    one = cleanup_rate.eta_seconds(120, fit, files=1)
    three = cleanup_rate.eta_seconds(120, fit, files=3)
    assert three - one == pytest.approx(2 * 3.5, abs=0.01)   # two extra model loads


def test_nonsense_is_never_recorded():
    cleanup_rate.record(CPU, 0, 0, 0)
    cleanup_rate.record(CPU, 120, 0, 3.5)          # no compute — a canceled run
    cleanup_rate.record(CPU, 0, 48.0, 3.5)         # no audio — nothing was denoised
    assert cleanup_rate.get(CPU) is None


def test_the_cache_survives_a_restart(tmp_path):
    cleanup_rate.record(CPU, 120.0, 48.0, 3.5)
    assert (tmp_path / "cleanup_rates.yaml").is_file()
    assert cleanup_rate.get(CPU) is not None        # re-read from disk


def test_a_corrupt_cache_is_not_an_outage(tmp_path):
    (tmp_path / "cleanup_rates.yaml").write_text("{{{ not yaml", encoding="utf-8")
    assert cleanup_rate.get(CPU) is None
