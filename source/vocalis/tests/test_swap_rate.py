"""Voice-swap estimates use measurements from the actual conversion path. Keep startup separate from per-audio compute time so estimates include fixed model-load cost without attributing another stage's work to the swap."""
import pytest

import swap_rate


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Never touch the real rate cache — and never READ it either: a test that passes because
    the dev box happens to have swapped a clip is not a test. Patch swap_rate's OWN cache_root
    binding (each module owns its own; memory: feedback_suite_must_not_read_the_host)."""
    monkeypatch.setattr(swap_rate, "cache_root", lambda: tmp_path)


TEST_GPU_KEY = swap_rate.key_for("AMD Radeon Graphics", "rmvpe")


def test_an_untimed_box_has_no_rate_at_all():
    """Not a default, not a constant with a disclaimer. None."""
    assert swap_rate.get(TEST_GPU_KEY) is None
    assert swap_rate.eta_seconds(3600, None) is None


def test_one_real_run_is_enough_to_measure_both_parameters():
    """A completed timing record stores startup and conversion separately. These sample measurements exercise the persisted rate and verify estimates for short clips and long books."""
    swap_rate.record(TEST_GPU_KEY, audio_s=225.6, compute_s=8.57, startup_s=15.43)
    startup, rate = swap_rate.get(TEST_GPU_KEY)
    assert startup == pytest.approx(15.43, abs=0.01)
    assert rate == pytest.approx(0.038, abs=0.001)         # ~26x faster than real time
    # A 4-minute song is under half a minute; a 15-minute speech clip under a minute...
    assert swap_rate.eta_seconds(225.6, (startup, rate)) == pytest.approx(24.0, abs=1.0)
    assert swap_rate.eta_seconds(900, (startup, rate)) == pytest.approx(50.0, abs=4.0)
    # ...and the "22-hour book" is 23 minutes. This assertion is the tombstone of chunking.
    assert swap_rate.eta_seconds(36000, (startup, rate)) / 60 == pytest.approx(23, abs=3)


def test_a_rate_needs_some_audio_behind_it():
    """A sub-10-second probe is dominated by the model load and by scheduling noise; its rate
    is not this card's rate. Same shape as render_rate's MIN_CHARS gate, for the same reason."""
    swap_rate.record(TEST_GPU_KEY, audio_s=2.0, compute_s=0.1, startup_s=15.4)
    assert swap_rate.get(TEST_GPU_KEY) is None, "2 seconds of audio is not a measurement"
    swap_rate.record(TEST_GPU_KEY, audio_s=225.6, compute_s=8.57, startup_s=15.4)
    assert swap_rate.get(TEST_GPU_KEY) is not None


def test_runs_accumulate_into_the_boxs_overall_rate():
    """Accumulated, not replaced: one unlucky run — a card throttling, another app stealing the
    GPU — must not be able to swing every estimate after it."""
    swap_rate.record(TEST_GPU_KEY, audio_s=100.0, compute_s=3.0, startup_s=15.0)    # 0.03 s/s
    swap_rate.record(TEST_GPU_KEY, audio_s=100.0, compute_s=5.0, startup_s=15.0)    # 0.05 s/s
    _startup, rate = swap_rate.get(TEST_GPU_KEY)
    assert rate == pytest.approx(8.0 / 200.0)       # 0.04 overall — not 0.03 and not 0.05


def test_the_f0_method_is_part_of_the_key():
    """f0 extraction is the expensive part of a swap: a rate measured at rmvpe says nothing
    about crepe or harvest, and neither says anything about another card."""
    swap_rate.record(swap_rate.key_for("AMD Radeon Graphics", "rmvpe"), 225.6, 8.57, 15.4)
    assert swap_rate.get(swap_rate.key_for("AMD Radeon Graphics", "rmvpe")) is not None
    assert swap_rate.get(swap_rate.key_for("AMD Radeon Graphics", "crepe")) is None
    assert swap_rate.get(swap_rate.key_for("NVIDIA GeForce RTX 4090", "rmvpe")) is None


def test_a_fused_measurement_is_refused():
    """`load_s=0` is the child saying it could not time the model load apart from the
    conversion, so compute_s STILL CONTAINS the load. Recording that would charge the load
    twice — once as startup, again inside the per-second rate. Half a measurement is not one."""
    assert swap_rate.parse_timing(
        "VOCALIS_TIMING audio_s=225.600 load_s=0.000 compute_s=24.000") is None


def test_the_timing_line_is_parsed_end_to_end():
    """The REAL path, no mocks (a 4.1 bug survived the whole suite because every test fed the
    checks a fixture that mocked out the one function the bug lived in): a raw child line goes
    through parse_timing, the derived startup is recorded, and get() reads it back."""
    t = swap_rate.parse_timing(
        "VOCALIS_TIMING audio_s=225.600 load_s=15.430 compute_s=8.570")
    assert t["audio_s"] == 225.6 and t["compute_s"] == 8.57 and t["load_s"] == 15.43
    # The parent derives startup from the PROCESS wall, not from load_s (load_s only proves the
    # measurement is usable). Here a 24 s wall over an 8.57 s conversion ⇒ 15.43 s of startup.
    swap_rate.record(TEST_GPU_KEY, t["audio_s"], t["compute_s"], startup_s=24.0 - t["compute_s"])
    assert swap_rate.get(TEST_GPU_KEY) is not None
    assert swap_rate.parse_timing("RVC: wrote /tmp/x.wav") is None
    assert swap_rate.parse_timing("VOCALIS_TIMING f0=rmvpe") is None   # non-numeric ⇒ dropped


def test_nonsense_is_never_recorded():
    swap_rate.record(TEST_GPU_KEY, 0, 0, 0)
    swap_rate.record(TEST_GPU_KEY, 225.6, 0, 15.4)          # no compute time — a canceled run
    swap_rate.record(TEST_GPU_KEY, 0, 8.57, 15.4)           # no audio — nothing was swapped
    assert swap_rate.get(TEST_GPU_KEY) is None


def test_the_cache_survives_a_restart(tmp_path, monkeypatch):
    """The point of writing it down: an estimate is there the moment the server comes back, not
    after it has re-timed itself."""
    swap_rate.record(TEST_GPU_KEY, 225.6, 8.57, 15.43)
    assert (tmp_path / "swap_rates.yaml").is_file()
    assert swap_rate.get(TEST_GPU_KEY) is not None           # re-read from disk, no in-memory state


def test_a_corrupt_cache_is_not_an_outage(tmp_path):
    (tmp_path / "swap_rates.yaml").write_text("{{{ not yaml", encoding="utf-8")
    assert swap_rate.get(TEST_GPU_KEY) is None               # ignored, not raised
