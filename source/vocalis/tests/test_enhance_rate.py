"""Enhancement estimates must come from measurements on the device that performs the work.

Startup cost and compute time are separate parameters: combining them would make estimates
unreliable when input durations differ. The tests cover missing measurements, the minimum audio
sample, accumulation across runs, and cache keys that include device and step count."""
import pytest
import yaml

import enhance_rate


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Never touch the real rate cache — and never READ it either: a test that passes
    because the dev box happens to have enhanced a clip is not a test."""
    monkeypatch.setattr(enhance_rate, "cache_root", lambda: tmp_path)


RADEON_KEY = enhance_rate.key_for("AMD Radeon Graphics", 32)


def test_an_untimed_box_has_no_rate_at_all():
    """Not a default, not a constant with a disclaimer. None."""
    assert enhance_rate.get(RADEON_KEY) is None
    assert enhance_rate.eta_seconds(3600, None) is None


def test_one_real_run_is_enough_to_measure_both_parameters():
    """The whole reason the child pre-loads the model and times it separately. If load and
    compute stayed fused in one wall-clock number, two parameters could only be regressed
    out of runs of DIFFERING lengths — and a user who only ever enhances hour-long training
    clips would never produce a short one, so would never get an estimate at all."""
    enhance_rate.record(RADEON_KEY, audio_s=120.0, compute_s=32.53, startup_s=5.87)
    startup, rate = enhance_rate.get(RADEON_KEY)
    assert startup == pytest.approx(5.87, abs=0.01)
    assert rate == pytest.approx(0.271, abs=0.001)
    # Example timing: 30 s of audio took about 14 s; an hour took about 16 min.
    assert enhance_rate.eta_seconds(30, (startup, rate)) == pytest.approx(14.0, abs=1.0)
    assert enhance_rate.eta_seconds(3600, (startup, rate)) / 60 == pytest.approx(16, abs=2)


def test_a_rate_needs_some_audio_behind_it():
    """A two-second probe is dominated by scheduling noise, and its rate is not this card's
    rate. Same shape as render_rate's MIN_CHARS gate, for the same reason."""
    enhance_rate.record(RADEON_KEY, audio_s=2.0, compute_s=0.6, startup_s=5.9)
    assert enhance_rate.get(RADEON_KEY) is None, "2 seconds of audio is not a measurement"
    enhance_rate.record(RADEON_KEY, audio_s=120.0, compute_s=32.5, startup_s=5.9)
    assert enhance_rate.get(RADEON_KEY) is not None


def test_runs_accumulate_into_the_boxs_overall_rate():
    """Accumulated, not replaced (render_rate's rule): one unlucky run — a card throttling,
    another app stealing the GPU — must not be able to swing every estimate after it."""
    enhance_rate.record(RADEON_KEY, audio_s=100.0, compute_s=20.0, startup_s=6.0)   # 0.20 s/s
    enhance_rate.record(RADEON_KEY, audio_s=100.0, compute_s=40.0, startup_s=6.0)   # 0.40 s/s
    _startup, rate = enhance_rate.get(RADEON_KEY)
    assert rate == pytest.approx(60.0 / 200.0)      # 0.30 overall — not 0.20 and not 0.40


def test_the_step_count_is_part_of_the_key():
    """nfe is a cost parameter: at 32 steps the per-second cost differs from 8. A rate measured at one setting does not describe another."""
    enhance_rate.record(enhance_rate.key_for("AMD Radeon Graphics", 32), 120.0, 32.5, 5.9)
    assert enhance_rate.get(enhance_rate.key_for("AMD Radeon Graphics", 32)) is not None
    assert enhance_rate.get(enhance_rate.key_for("AMD Radeon Graphics", 8)) is None
    assert enhance_rate.get(enhance_rate.key_for("NVIDIA GeForce RTX 4090", 32)) is None


def test_a_fused_measurement_is_refused():
    """`load_s=0` is the child saying its pre-load was refused, so compute_s STILL CONTAINS
    the model load. Recording that would inflate the per-second rate for every clip after
    it — the load would be charged twice for a book, once per chapter and again inside the
    rate. An unusable measurement is not a measurement."""
    assert enhance_rate.parse_timing(
        "VOCALIS_TIMING audio_s=120.000 load_s=0.000 compute_s=38.400 nfe=32") is None


def test_the_timing_line_is_parsed():
    t = enhance_rate.parse_timing(
        "VOCALIS_TIMING audio_s=120.000 load_s=5.870 compute_s=32.530 nfe=32")
    assert t["audio_s"] == 120.0 and t["compute_s"] == 32.53 and t["load_s"] == 5.87
    assert enhance_rate.parse_timing("32 steps, ~16 min") is None
    assert enhance_rate.parse_timing("VOCALIS_TIMING garbage") is None


def test_nonsense_is_never_recorded():
    enhance_rate.record(RADEON_KEY, 0, 0, 0)
    enhance_rate.record(RADEON_KEY, 120, 0, 5.9)          # no compute time — a canceled run
    enhance_rate.record(RADEON_KEY, 0, 32.5, 5.9)         # no audio — nothing was enhanced
    assert enhance_rate.get(RADEON_KEY) is None


def test_the_cache_survives_a_restart(tmp_path, monkeypatch):
    """The point of writing it down: an estimate is there the moment the server comes back,
    not after it has re-timed itself."""
    enhance_rate.record(RADEON_KEY, 120.0, 32.53, 5.87)
    assert (tmp_path / "enhance_rates.yaml").is_file()
    assert enhance_rate.get(RADEON_KEY) is not None       # re-read from disk, no in-memory state


def test_a_corrupt_cache_is_not_an_outage(tmp_path):
    (tmp_path / "enhance_rates.yaml").write_text("{{{ not yaml", encoding="utf-8")
    assert enhance_rate.get(RADEON_KEY) is None           # ignored, not raised


# ── M2.5: never destroy on a failed read ─────────────────────────────────────

def test_record_does_not_erase_the_history_it_could_not_read(tmp_path):
    """The M2.5 site. `_load()` returned {} on a bad parse and `record()` merged one key
    into that empty map and wrote it back — so ONE truncated write cost every OTHER card
    and step count the box had ever measured. The comment called this "ignoring" the
    corrupt cache. It was overwriting it.

    Ignoring it is what it does now: the run is not recorded, nothing on disk moves, and
    the enhancement it was measuring still succeeds."""
    p = tmp_path / "enhance_rates.yaml"
    enhance_rate.record(RADEON_KEY, 3600.0, 975.6, 5.9)          # an hour of audio, honestly timed
    assert enhance_rate.get(RADEON_KEY) is not None

    p.write_text("rates: [a list, not a map]", encoding="utf-8")    # the store goes corrupt
    corrupt = p.read_bytes()

    enhance_rate.record(enhance_rate.key_for("cpu", 8), 120.0, 60.0, 5.0)   # must not raise

    assert p.read_bytes() == corrupt, "one new timing must not overwrite the whole store"


def test_an_absent_store_is_not_a_corrupt_one(tmp_path):
    """ABSENT ≠ CORRUPT. A box that has never enhanced anything has nothing to destroy, so
    the very first record() must still land."""
    assert not (tmp_path / "enhance_rates.yaml").exists()
    enhance_rate.record(RADEON_KEY, 120.0, 32.53, 5.87)
    assert enhance_rate.get(RADEON_KEY) is not None


def test_concurrent_record_from_two_cards_loses_nothing(tmp_path):
    """record() is a READ-MODIFY-WRITE and the book calls it from one worker thread PER
    CARD (vocalis_server._enhance_book). Unlocked, two cards finishing a chapter together
    is a textbook lost update: both read the same totals, both add their run, and whichever
    writes second erases the other. atomic_replace makes the WRITE atomic and does exactly
    nothing for the read-modify-write around it.

    Every run must be counted. `runs` is the honest witness — it is a pure count, so any
    lost update shows up as a missing integer and no arithmetic can hide it."""
    import threading

    n = 24
    barrier = threading.Barrier(n)                 # make them collide on purpose

    def one():
        barrier.wait()
        enhance_rate.record(RADEON_KEY, 60.0, 16.0, 6.0)

    threads = [threading.Thread(target=one) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    rates = yaml.safe_load((tmp_path / "enhance_rates.yaml").read_text(encoding="utf-8"))
    assert rates["rates"][RADEON_KEY]["runs"] == n, "a concurrent record() was lost"
    assert rates["rates"][RADEON_KEY]["audio_s"] == pytest.approx(60.0 * n)


# ── the diagnostic must name the cause ─────────────────────────────────────

def test_no_venv_and_no_card_give_different_messages(monkeypatch):
    """The diagnostic must distinguish an unavailable runtime from a missing eligible device. When the
interpreter is present but no device is enabled, direct the operator to Settings and Devices;
reserve the setup instructions for an unavailable runtime."""
    from vocalis.runtime import configs, enhancement

    class _Cfg:
        available = True

    # ⚠️ No `enhance_cards` patch: `enhance_unavailable_reason()` branches ONLY on
    # `enhance_cfg().available`, so patching it here was decorative and read as if it drove the
    # branch. The route-level test below is the one that exercises "no card is ticked".
    monkeypatch.setattr(configs, "enhance_cfg", lambda: _Cfg())
    no_card = enhancement.enhance_unavailable_reason()
    assert "Settings" in no_card and "Devices" in no_card
    assert "setup.sh" not in no_card, "it must not send the user to an installer that is done"

    class _Missing:
        available = False
        # Mirrors EnhanceConfig.unavailable_reason for a missing interpreter: the runtime appends the
        # config's own reason, and the setup instruction lives in that reason, not in the runtime text.
        unavailable_reason = ("The isolated Enhance environment is not installed on this box; run "
                              "scripts/enhance/setup.sh once.")

    monkeypatch.setattr(configs, "enhance_cfg", lambda: _Missing())
    no_venv = enhancement.enhance_unavailable_reason()
    assert "setup.sh" in no_venv
    assert no_venv != no_card


def test_the_no_card_message_says_a_satellite_will_not_do(monkeypatch):
    """§5.1: the enhancer wants a whole card and ~21 GB of it, so it never runs on a satellite —
    it would evict the very rendering the satellite was added for. A user staring at a ticked
    satellite card needs to be told that directly."""
    from vocalis.runtime import configs, enhancement

    class _Cfg:
        available = True

    monkeypatch.setattr(configs, "enhance_cfg", lambda: _Cfg())
    assert "satellite" in enhancement.enhance_unavailable_reason().lower()


def test_the_playground_enhances_on_a_TICKED_card(monkeypatch):
    """🔴 It did not. `_pg_write_clip` called `gpu.pick_device()`, which enumerates every
    physical card on the box and knows nothing about ⚙ Settings — so with `cuda:1` unticked and
    kept for the LLM, the enhancer's ~21 GB child loaded onto `cuda:1`, chosen *because* it was
    empty, and empty precisely because the user had excluded it from the render that just
    finished. Every other enhance site (books, bulk, train, /playground/enhance) goes through
    `enhance_cards()`; this one was missed, and m4k then wrote the opposite promise into the
    panel: "they use this machine's own ticked cards".

    Asserted against `gpu.cards_emptiest_first`, which is where the choice is now made, rather
    than against a string — a revert to `pick_device()` shows up as `cuda:1`.
    """
    from vocalis.runtime import enhancement, gpu
    from vocalis.web import playground as web_playground

    free = {"cuda:0": 1.0, "cuda:1": 23.0}          # cuda:1 is emptier BECAUSE it is unticked
    monkeypatch.setattr(enhancement, "enhance_cards", lambda: ["cuda:0"])
    monkeypatch.setattr(gpu, "gpu_stats", lambda: [{"index": 0}, {"index": 1}])
    monkeypatch.setattr(gpu, "cards_emptiest_first",
                        lambda cards: sorted(cards, key=lambda d: -free.get(d, 0.0)))

    # The control: left to every card on the box, the emptiest is the UNTICKED one, so a revert
    # to the old choice shows up here as `cuda:1`.
    #
    # ⚠️ 7.6 gave `pick_device` a mandatory `candidates` argument, which is the same fix this
    # test guards generalized: it used to build its own list from `gpu_stats()` and could not be
    # told about ⚙ Settings at all. The list passed here is deliberately the UNFILTERED one —
    # this line is modeling the old behavior, not asking for the right answer.
    assert gpu.pick_device(["cuda:0", "cuda:1"]) == "cuda:1", \
        "the fixture must model an emptier UNTICKED card"
    # The compiled names, not the source text — a comment mentioning the old call must not
    # decide whether this passes.
    names = web_playground._pg_write_clip.__code__.co_names
    assert "pick_device" not in names, (
        "the post-render enhance is choosing a card without consulting the ⚙ Settings ticks")
    assert "enhance_cards" in names and "cards_emptiest_first" in names

    # …and the chosen card really is the ticked one.
    chosen = (gpu.cards_emptiest_first(enhancement.enhance_cards()) or ["cpu"])[0]
    assert chosen == "cuda:0"
