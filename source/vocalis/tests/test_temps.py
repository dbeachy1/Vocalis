"""Temperature discovery accepts known board labels and DIMM chip names. Disconnected sensors can publish an extreme numeric reading, so the fake hwmon fixtures verify that unsupported or out-of-range values are omitted without reading the host."""
import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import temps


@pytest.fixture(autouse=True)
def _no_resolved_sensors_from_another_test(monkeypatch):
    """`_SENSORS` is a module-level cache resolved once and deliberately never invalidated, which
    is right in production (a sensor cannot appear without a reboot) and poison across tests: the
    first test to resolve a fake tree would pin every later test to it. Cleared per test, and the
    glob is pointed at nothing by default so a test that forgets to build a tree gets None rather
    than the host's."""
    monkeypatch.setattr(temps, "_SENSORS", {})
    monkeypatch.setattr(temps, "HWMON_GLOB", "/nonexistent-hwmon-*")


def _hwmon(tmp_path, name, temps_map, monkeypatch):
    """Build a fake hwmon node: `{index: (label, millidegrees)}`, written as the kernel writes it."""
    d = tmp_path / "hwmon0"
    d.mkdir(exist_ok=True)
    (d / "name").write_text(name + "\n")
    for i, (label, milli) in temps_map.items():
        (d / f"temp{i}_label").write_text(label + "\n")
        (d / f"temp{i}_input").write_text(f"{milli}\n")
    monkeypatch.setattr(temps, "HWMON_GLOB", str(tmp_path / "hwmon*"))
    return d


def _reading(snap):
    """The temperatures alone. `warn` rides along in every payload — it is asserted on its own in
    `test_the_warning_thresholds_travel_with_the_reading`, and carrying it through every other
    expectation here would just make each one restate a constant it is not about."""
    return None if snap is None else {k: v for k, v in snap.items()
            if k not in ("warn", "dimms")}


def _dimms(tmp_path, monkeypatch, *readings, chip="spd5118", max_c=55000):
    """One fake hwmon node per populated DIMM. `readings` are millidegrees.

    🔴 NO `tempN_label` ANYWHERE IN HERE, and that is the fixture's whole point: a DDR5 SPD hub
    publishes a bare `temp1_input`, so the label allowlist that finds the board sensors cannot see
    these and the code has to find them by chip name instead. A fixture that helpfully added a
    "DIMM" label would test a code path the hardware never takes.
    """
    for i, milli in enumerate(readings):
        d = tmp_path / f"hwmon{20 + i}"
        d.mkdir(exist_ok=True)
        (d / "name").write_text(chip + "\n")
        (d / "temp1_input").write_text(f"{milli}\n")
        (d / "temp1_max").write_text(f"{max_c}\n")     # the module's OWN published limit
    monkeypatch.setattr(temps, "HWMON_GLOB", str(tmp_path / "hwmon*"))


#: Synthetic board readings, including the unconnected optional header.
SAMPLE_HWMON = {1: ("CPU", 41000), 2: ("CPU Package", 52000), 3: ("Motherboard", 37000),
       4: ("T_Sensor", -60000), 5: ("VRM", 54000)}


def test_it_reads_the_board_and_the_vrm(tmp_path, monkeypatch):
    _hwmon(tmp_path, "asusec", SAMPLE_HWMON, monkeypatch)
    assert _reading(temps.snapshot()) == {"mb": 37, "vrm": 54}


def test_an_unconnected_thermistor_is_never_printed(tmp_path, monkeypatch):
    """🔴 THE ONE. −60 °C is a NUMBER, not an error, so nothing upstream of this rejects it.

    Two independent guards have to hold, because either alone is one board away from being wrong:
    the label allowlist (T_Sensor is not a thing we print) and the sane band (a disconnected sensor
    wearing an accepted label still cannot get through).
    """
    _hwmon(tmp_path, "asusec", SAMPLE_HWMON, monkeypatch)
    snap = _reading(temps.snapshot())
    assert -60 not in snap.values(), f"the unconnected header reached the UI: {snap}"
    assert set(snap) == {"mb", "vrm"}, "only the two board sensors are printed"

    # The same reading wearing an accepted label — the allowlist cannot help here, only the band.
    monkeypatch.setattr(temps, "_SENSORS", {})
    _hwmon(tmp_path, "asusec", {3: ("Motherboard", -60000), 5: ("VRM", 54000)}, monkeypatch)
    assert _reading(temps.snapshot()) == {"vrm": 54}, "an out-of-band reading must drop, not print"


@pytest.mark.parametrize("milli, why", [
    (-60000, "an unconnected thermistor"),
    (-1000, "just below freezing — no board in a running box is there"),
    (126000, "past the upper bound"),
    (4294967, "an uninitialized u32, the classic sensor-garbage value"),
])
def test_a_reading_outside_the_sane_band_is_dropped(tmp_path, monkeypatch, milli, why):
    _hwmon(tmp_path, "asusec", {3: ("Motherboard", milli)}, monkeypatch)
    assert temps.snapshot() is None, f"{why} was printed as a temperature"


def test_a_box_with_no_board_sensor_says_nothing(tmp_path, monkeypatch):
    """Every Windows dev box, and every Linux box whose SuperIO has no driver. The header draws
    nothing at all rather than a row of dashes — the same rule the UPS line follows."""
    assert temps.snapshot() is None, "a box with no hwmon at all must answer None"

    # A box WITH hwmon nodes, none of which is a board sensor: the GPU's own, and the CPU's.
    _hwmon(tmp_path, "amdgpu", {1: ("edge", 41000), 2: ("junction", 43000)}, monkeypatch)
    assert temps.snapshot() is None, (
        "labels this module does not recognize must produce nothing — a GPU edge temperature is "
        "not a motherboard temperature, and guessing is how a wrong number gets a confident label")


def test_nct6775_style_raw_labels_are_refused(tmp_path, monkeypatch):
    """⚠️ DELIBERATE, NOT AN OVERSIGHT. `SYSTIN`/`AUXTIN` are raw thermistor channels whose mapping
    to physical places is board-specific and undocumented, so printing one as "Motherboard" would
    be a guess presented as a fact. A box with that chip gets no readout, which is honest."""
    _hwmon(tmp_path, "nct6798", {1: ("SYSTIN", 35000), 2: ("AUXTIN0", 41000)}, monkeypatch)
    assert temps.snapshot() is None


def test_a_partial_answer_is_still_an_answer(tmp_path, monkeypatch):
    """A board that publishes one of the two gets one figure. Refusing both because one is missing
    would hide a reading that is perfectly good."""
    _hwmon(tmp_path, "asusec", {3: ("Motherboard", 37000)}, monkeypatch)
    assert _reading(temps.snapshot()) == {"mb": 37}


def test_a_sensor_that_vanishes_at_runtime_drops_out_rather_than_crashing(tmp_path, monkeypatch):
    """The path is resolved once and cached; the file behind it can still go away on a driver
    unload. `snapshot` must answer for whatever is left, not raise into `/system/stats`."""
    d = _hwmon(tmp_path, "asusec", SAMPLE_HWMON, monkeypatch)
    assert _reading(temps.snapshot()) == {"mb": 37, "vrm": 54}
    (d / "temp3_input").unlink()
    assert _reading(temps.snapshot()) == {"vrm": 54}
    (d / "temp5_input").unlink()
    assert temps.snapshot() is None


def test_the_lookup_is_cached_but_never_cached_empty(tmp_path, monkeypatch):
    """🔴 THE BOOT ORDER TRAP, and the reason this is asserted rather than assumed: `asus_ec_sensors`
    can publish its node AFTER Vocalis starts, and a negative result cached at boot would keep the
    readout dark until the next restart. `power.py` and `ups.py` both document the same trap; this
    proves it for the one that is read on demand.
    """
    assert temps.snapshot() is None                 # nothing there yet — must not poison the cache
    _hwmon(tmp_path, "asusec", SAMPLE_HWMON, monkeypatch)
    assert _reading(temps.snapshot()) == {"mb": 37, "vrm": 54}, (
        "the empty result was cached — a sensor that appears after boot would never be found")

    # And once found it IS cached: the resolved path is reused rather than re-globbed.
    assert set(temps._SENSORS) == {"mb", "vrm"}


def test_the_first_hwmon_node_wins_a_duplicate_label(tmp_path, monkeypatch):
    """Two chips publishing "Motherboard" is not a case this can adjudicate, so it takes the first
    and is stable about it — rather than letting glob order silently decide per boot."""
    for i, milli in ((0, 37000), (1, 44000)):
        d = tmp_path / f"hwmon{i}"
        d.mkdir()
        (d / "name").write_text("asusec\n")
        (d / "temp3_label").write_text("Motherboard\n")
        (d / "temp3_input").write_text(f"{milli}\n")
    monkeypatch.setattr(temps, "HWMON_GLOB", str(tmp_path / "hwmon*"))
    assert _reading(temps.snapshot()) == {"mb": 37}


def test_the_warning_thresholds_travel_with_the_reading(tmp_path, monkeypatch):
    """⚠️ THE THRESHOLD HAS ONE HOME, and it is this module — the same rule the UPS line follows by
    sending `warn_pct`. A literal typed into hwstrip.js is a copy, and a copy drifts."""
    _hwmon(tmp_path, "asusec", SAMPLE_HWMON, monkeypatch)
    snap = temps.snapshot()
    assert snap["warn"] == temps.WARN_C
    assert snap["warn"]["mb"] < snap["warn"]["vrm"], (
        "the VRM runs hotter than the board by design — thresholds that did not reflect that "
        "would light the wrong one first")


# ── the DIMMs ────────────────────────────────────────────────────────────────────────────────
#
# 🔴 A DIFFERENT DISCOVERY PATH ENTIRELY, and the tests below exist because of it. The board
# sensors are found by LABEL; a DDR5 module publishes a bare `temp1_input` with no label at all,
# so it is found by CHIP NAME. The fixtures use two `spd5118` nodes and the published `temp1_max`,
# which supplies the module warning threshold instead of an invented constant.


def test_it_reads_the_dimms(tmp_path, monkeypatch):
    _dimms(tmp_path, monkeypatch, 42200, 42800)
    assert _reading(temps.snapshot()) == {"ram": 43}


def test_the_hottest_dimm_wins_never_the_average(tmp_path, monkeypatch):
    """🔴 THE ONE DECISION IN THE DIMM PATH, and an average is the wrong answer for a reason worth
    keeping: two healthy sticks at 42 next to one at 80 average to 55 — a number that looks like a
    warm machine rather than a module in trouble, and that gets less alarming the more RAM you add.
    The maximum is the only summary that stays true as sticks are added.
    """
    _dimms(tmp_path, monkeypatch, 42000, 42000, 80000)
    snap = temps.snapshot()
    assert snap["ram"] == 80, f"the hot module was averaged away: {snap}"
    assert snap["dimms"] == 3, "the tooltip needs to say what the figure is the hottest OF"


def test_the_dimm_publishes_its_own_warning_threshold(tmp_path, monkeypatch):
    """⚠️ NOT `WARN_C`. The board figures get a threshold chosen in this repo because nothing on
    the board publishes one; a DIMM does, right beside the reading, and a number invented here
    would be a guess standing next to the manufacturer's actual answer."""
    _dimms(tmp_path, monkeypatch, 42000, max_c=55000)
    assert temps.snapshot()["warn"]["ram"] == 55
    assert "ram" not in temps.WARN_C, (
        "the RAM threshold must not be hardcoded — it comes off the module's own temp1_max")

    # A different kit says a different number, and the payload follows it rather than the constant.
    monkeypatch.setattr(temps, "_SENSORS", {})
    _dimms(tmp_path, monkeypatch, 42000, max_c=70000)
    assert temps.snapshot()["warn"]["ram"] == 70


def test_a_dimm_that_publishes_no_limit_falls_back(tmp_path, monkeypatch):
    _dimms(tmp_path, monkeypatch, 42000)
    (tmp_path / "hwmon20" / "temp1_max").unlink()
    assert temps.snapshot()["warn"]["ram"] == temps.RAM_WARN_DEFAULT


def test_ddr4_era_sensors_count_too(tmp_path, monkeypatch):
    """`jc42` is the DDR4 on-DIMM sensor. Same provenance argument as `spd5118`: the driver binds
    to exactly one kind of thing, so the chip name IS the label here."""
    _dimms(tmp_path, monkeypatch, 39000, chip="jc42")
    assert _reading(temps.snapshot()) == {"ram": 39}


def test_an_absurd_dimm_reading_is_dropped_like_any_other(tmp_path, monkeypatch):
    """The sane band is not a board-sensor rule, it is a sensor rule. A DIMM reporting -60 °C is
    as unprintable as a disconnected thermistor doing it."""
    _dimms(tmp_path, monkeypatch, -60000, 42000)
    assert _reading(temps.snapshot()) == {"ram": 42}, "the bad module must drop, not win the max"


def test_the_board_and_the_dimms_are_independent(tmp_path, monkeypatch):
    """Two chips, two discovery paths, and a box can have either without the other — a machine
    with no ASUS EC still has RAM sensors, and the row must render for one of them alone."""
    _hwmon(tmp_path, "asusec", SAMPLE_HWMON, monkeypatch)
    assert _reading(temps.snapshot()) == {"mb": 37, "vrm": 54}, "board alone"

    monkeypatch.setattr(temps, "_SENSORS", {})
    _dimms(tmp_path, monkeypatch, 42800)
    assert _reading(temps.snapshot()) == {"mb": 37, "vrm": 54, "ram": 43}, "both together"


def test_hwmon_reports_all_three(tmp_path, monkeypatch):
    """The whole payload, as the header will receive it on the real box."""
    _hwmon(tmp_path, "asusec", SAMPLE_HWMON, monkeypatch)
    _dimms(tmp_path, monkeypatch, 42200, 42800)
    snap = temps.snapshot()
    assert _reading(snap) == {"mb": 37, "vrm": 54, "ram": 43}
    assert snap["dimms"] == 2
    assert snap["warn"] == {"mb": 60, "vrm": 95, "ram": 55}
