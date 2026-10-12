"""A render estimate is available only after enough work has been measured.

These tests cover rate accumulation, configuration-specific keys, cache failure behavior, and
ETA calculation so an unreadable or unrelated estimate cannot mislead the caller.
"""
import pytest

import render_rate


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Keep rate-cache reads and writes inside this test's temporary directory."""
    monkeypatch.setattr(render_rate, "cache_root", lambda: tmp_path)


def test_an_unmeasured_box_has_no_rate_at_all():
    """Not a default, not a guess with a disclaimer. None. The caller must show nothing."""
    assert render_rate.get(render_rate.key_for("NVIDIA GeForce RTX 4090", 1, 2)) is None


def test_a_rate_appears_only_once_there_is_enough_behind_it():
    """The first chunk on each worker pays for model warm-up, so a rate from 200 characters
    is noise wearing a number's clothes. MIN_CHARS/MIN_SECONDS is the gate."""
    key = render_rate.key_for("AMD Radeon Graphics", 2, 1)

    render_rate.record(key, 200, 8)                 # a chapter heading
    assert render_rate.get(key) is None, "a rate from 200 chars must not be quoted"

    render_rate.record(key, 4000, 100)              # a real chapter
    rate = render_rate.get(key)
    assert rate == pytest.approx(4200 / 108, rel=0.01)


def test_the_rate_is_the_overall_rate_across_everything_the_box_has_rendered():
    """Accumulate counts and elapsed time so one short or atypical run cannot dominate the rate."""
    key = render_rate.key_for("cpu", 0, 1)
    render_rate.record(key, 10000, 200)             # 50 c/s
    render_rate.record(key, 10000, 400)             # 25 c/s
    assert render_rate.get(key) == pytest.approx(20000 / 600)   # 33.3, not 25 and not 37.5


def test_a_different_configuration_is_a_different_measurement():
    """Two cards render a book roughly twice as fast as one of them does. A rate measured
    on one config says NOTHING about another — which is the whole bug: a GPU name cannot
    know how many of it there are, and gpu_profiles.yaml was keyed on nothing else."""
    one = render_rate.key_for("AMD Radeon Graphics", 1, 1)
    two = render_rate.key_for("AMD Radeon Graphics", 2, 1)
    assert one != two

    render_rate.record(two, 10000, 200)
    assert render_rate.get(two) is not None
    assert render_rate.get(one) is None, "one card must not inherit two cards' speed"


def test_eta_is_none_without_a_rate():
    """No rate ⇒ no ETA. The UI must be able to distinguish 'no idea' from 'zero'."""
    assert render_rate.eta_seconds(50000, None) is None
    assert render_rate.eta_seconds(50000, 0) is None
    assert render_rate.eta_seconds(50000, 25) == pytest.approx(2000)


def test_a_corrupt_cache_is_not_an_outage(tmp_path):
    """It lives under cache_root(), which is documented as safe to delete. The worst a bad
    file may cost is a missing estimate — never a failed render.

    M2.5 changed the SECOND half of this test, and the change is the point. It used to
    assert that record() rewrote the corrupt file and produced a working rate — which is a
    tidy way of saying it OVERWROTE it. The intent above survives untouched (no raise, no
    failed render); what dies is the idea that "recovering" from a file you could not read
    means writing over it."""
    p = tmp_path / "render_rates.yaml"
    p.write_text("{{{ not yaml", encoding="utf-8")
    before = p.read_bytes()
    key = render_rate.key_for("cpu", 0, 1)

    assert render_rate.get(key) is None                  # a read degrades: no estimate
    render_rate.record(key, 5000, 100)                   # must not raise: no failed render

    assert p.read_bytes() == before, "record() overwrote a rate store it could not read"
    assert render_rate.get(key) is None, "and it must still say it has no rate"


def test_record_does_not_erase_the_history_it_could_not_read(tmp_path):
    """A malformed cache must not overwrite measurements for other configurations."""
    p = tmp_path / "render_rates.yaml"
    key = render_rate.key_for("AMD Radeon Graphics", 2, 1)
    render_rate.record(key, 100_000, 1000)               # a recorded sample history
    assert render_rate.get(key) == pytest.approx(100)

    p.write_text("rates: [this is a list, not a map]", encoding="utf-8")   # goes corrupt
    corrupt = p.read_bytes()

    render_rate.record(render_rate.key_for("cpu", 0, 1), 5000, 100)

    assert p.read_bytes() == corrupt, "one new timing must not overwrite the whole store"


def test_an_absent_store_is_not_a_corrupt_one(tmp_path):
    """ABSENT ≠ CORRUPT. A box that has never rendered has nothing to destroy, so the
    first record() must still land — the strict read returns {} for a missing file."""
    assert not (tmp_path / "render_rates.yaml").exists()
    key = render_rate.key_for("cpu", 0, 1)
    render_rate.record(key, 5000, 100)
    assert render_rate.get(key) == pytest.approx(50)


def test_zero_time_never_becomes_an_infinite_rate():
    """A resumed chapter costs no GPU and returns 0 chars. Counting its ~0 seconds would
    send the rate to infinity and quote the rest of the book as instant."""
    key = render_rate.key_for("cpu", 0, 1)
    render_rate.record(key, 0, 0)
    render_rate.record(key, 5000, 0)
    assert render_rate.get(key) is None


# ── the per-device worker dict (5.3) ─────────────────────────────────────────

def test_a_per_device_dict_does_not_explode():
    """Accept per-device worker counts wherever callers build a render-rate key."""
    assert render_rate.key_for("AMD Radeon Graphics", 2, {"cuda:0": 1, "cuda:1": 1})


def test_a_uniform_dict_keeps_the_pre_5_3_key_byte_for_byte():
    """So the rate a box measured before the upgrade is still its rate afterward. A key that
    merely 'looks equivalent' would silently discard every measurement ever taken here."""
    assert (render_rate.key_for("AMD Radeon Graphics", 2, {"cuda:0": 2, "cuda:1": 2})
            == render_rate.key_for("AMD Radeon Graphics", 2, 2))


def test_a_satellite_makes_it_a_different_configuration():
    """Adding another machine's card changes what the pool renders at, so it must not inherit
    the rate measured without it — that is the whole reason this key exists."""
    local = render_rate.key_for("AMD Radeon Graphics", 2, {"cuda:0": 1, "cuda:1": 1})
    mixed = render_rate.key_for("AMD Radeon Graphics", 2,
                                {"cuda:0": 1, "cuda:1": 1, 'test-satellite:cuda:0': 3})
    assert local != mixed


def test_a_non_uniform_config_cannot_collide_with_a_uniform_one_of_the_same_total():
    """1+3 across two cards is not 2+2 across two cards, and quoting one's rate for the other
    is exactly the 'reusing a number that no longer applies' this module refuses to do."""
    assert (render_rate.key_for("AMD Radeon Graphics", 2, {"cuda:0": 1, "cuda:1": 3})
            != render_rate.key_for("AMD Radeon Graphics", 2, {"cuda:0": 2, "cuda:1": 2}))


def test_the_dict_key_is_stable_under_ordering():
    """dict ordering follows insertion, and the settings file's order is not guaranteed. An
    unstable key would re-measure at random."""
    assert (render_rate.key_for("cpu", 2, {"cuda:1": 3, "cuda:0": 1})
            == render_rate.key_for("cpu", 2, {"cuda:0": 1, "cuda:1": 3}))


def test_an_empty_dict_falls_back_to_one():
    assert render_rate.key_for("cpu", 0, {}) == render_rate.key_for("cpu", 0, 1)


def test_two_different_satellites_do_not_share_a_key():
    """Include the satellite identity so separate remote devices cannot share a measured rate."""
    a = render_rate.key_for("AMD Radeon Graphics", 0, {'test-satellite:cuda:0': 1})
    b = render_rate.key_for("AMD Radeon Graphics", 0, {"otherbox:cuda:0": 1})
    assert a != b


def test_adding_a_second_satellite_card_changes_the_key():
    one = render_rate.key_for("AMD Radeon Graphics", 0, {'test-satellite:cuda:0': 1})
    two = render_rate.key_for("AMD Radeon Graphics", 0,
                              {'test-satellite:cuda:0': 1, 'test-satellite:cuda:1': 1})
    assert one != two


def test_a_local_only_config_never_grows_the_satellite_suffix():
    """The pre-5.3 key must survive byte for byte on a box that has no satellites, or every
    measurement ever taken there is silently discarded on upgrade."""
    assert render_rate.key_for("AMD Radeon Graphics", 2, {"cuda:0": 1, "cuda:1": 1}) \
        == "AMD Radeon Graphics|2c1w"


def test_the_local_device_rule_matches_split_device():
    """`render_rate` deliberately does not import the satellite stack — `book_to_audio.py`
    reaches it standalone — so the rule is restated there. This is what keeps the copy honest."""
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent.parent / "satellite"))
    from satellite_client import is_remote

    for d in ("cuda:0", "cuda:1", "cpu", 'test-satellite:cuda:0', "otherbox:cuda:3"):
        assert render_rate._is_local_device(d) is (not is_remote(d)), d
