"""Read motherboard, VRM, and DIMM temperatures for the system header.

Chip temperatures are exposed elsewhere. These readings help show whether the board and voltage
regulators are dissipating heat under sustained load. Labels are allowlisted and readings are
range-checked so an unconnected thermistor or unknown sensor is not presented as a valid value.
Read on demand: board temperatures change slowly and have no rolling peak or history to maintain.
"""
import glob
import os

#: Module-level so tests can point this lookup at a fake hwmon tree instead of reading the host.
HWMON_GLOB = "/sys/class/hwmon/hwmon*"

#: Exact driver labels mapped to the keys consumed by the UI. This allowlist excludes unknown
#: sensors such as an unconnected thermistor.
WANT = {"Motherboard": "mb", "VRM": "vrm"}

#: DIMM sensors have no labels on supported drivers, so identify them by known SPD-hub chip
#: names. Unlike board sensors with ambiguous labels, these chip names identify the measurement.
DIMM_CHIPS = ("spd5118", "jc42")

#: Plausible temperature range in °C; reject values outside the range before displaying them.
MIN_C, MAX_C = 0.0, 125.0

#: Amber above this, per sensor, in °C — and the two are different numbers because the two parts
#: are different parts. Sent to the UI rather than typed into `hwstrip.js` for the reason the UPS
#: line already established: a threshold with two homes has one that drifts.
#:
#: Warning thresholds in °C. Board and VRM values use separate limits because they describe
#: different components. The board threshold is advisory; the VRM threshold stays below typical
#: throttling temperatures while allowing ordinary sustained loads. DIMM warnings use the limit
#: published by the module when available.
WARN_C = {"mb": 60, "vrm": 95}

#: Fallback DIMM warning threshold in °C when a module does not publish `temp1_max`.
RAM_WARN_DEFAULT = 55

#: key -> the `tempN_input` path that answers it. Resolved once, and NOT cached empty: at boot
#: this can easily run before `asus_ec_sensors` has published its hwmon node, and a negative
#: result cached then would keep the readout dark until the next restart (the same trap
#: `ups.py::_ups_name` and `power.py::_amdgpu_hwmons` both document).
_SENSORS: dict = {}


def _find() -> dict:
    """`{key: path}` for each wanted sensor label found, or `{}`.

    Match the exact driver label rather than an index or chip name. Sensor indexes vary across
    driver versions, and chip names do not identify motherboard and VRM placement reliably.
    """
    if _SENSORS:
        return _SENSORS
    found = {}
    for h in sorted(glob.glob(HWMON_GLOB)):
        for lf in sorted(glob.glob(os.path.join(h, "temp*_label"))):
            try:
                label = open(lf).read().strip()
            except OSError:
                continue
            key = WANT.get(label)
            # `not in found` — first hwmon node wins, so a second chip publishing the same label
            # cannot silently replace the one already answering.
            if key and key not in found:
                found[key] = lf[: -len("_label")] + "_input"
    _SENSORS.update(found)
    return found


def _dimm_c():
    """Return the hottest populated DIMM and its own warning threshold.

    The maximum remains meaningful as modules are added, and keeping the reading paired with its
    module's threshold matters for mixed memory kits.
    """
    best = (None, None)
    for h in sorted(glob.glob(HWMON_GLOB)):
        try:
            if open(os.path.join(h, "name")).read().strip() not in DIMM_CHIPS:
                continue
        except OSError:
            continue
        c = _read_c(os.path.join(h, "temp1_input"))
        if c is None:
            continue
        warn = _read_c(os.path.join(h, "temp1_max")) or RAM_WARN_DEFAULT
        if best[0] is None or c > best[0]:
            best = (c, warn)
    return best


def _dimm_count():
    """How many DIMMs answered — for the tooltip, so "43 °C" says what it is the hottest OF."""
    n = 0
    for h in sorted(glob.glob(HWMON_GLOB)):
        try:
            if open(os.path.join(h, "name")).read().strip() in DIMM_CHIPS:
                n += 1
        except OSError:
            continue
    return n


def _read_c(path):
    """Millidegrees from sysfs as °C, or None — including for a reading outside the sane band.

    ⚠️ None covers "the file went away" and "the sensor is lying" identically, because the caller's
    response to both is the same: do not print this one. A disconnected thermistor is not a
    degraded reading to be shown with a caveat, it is an absence wearing a number.
    """
    try:
        c = int(open(path).read().strip()) / 1000.0
    except (OSError, ValueError):
        return None
    if not (MIN_C <= c <= MAX_C):
        return None
    return round(c)


def snapshot():
    """`{"mb": 37, "vrm": 54}` — whichever of the two this box can answer — or None.

    None on every box with no board sensor at all, which is every Windows dev box and every
    machine whose SuperIO has no driver. The header draws nothing at all in that case rather than
    a row of dashes, which is the same rule the UPS line follows and for the same reason: this
    page has to look finished on a box that simply does not have the hardware.

    A partial answer IS returned — a board that publishes `Motherboard` but no `VRM` gets one
    figure. Refusing both because one is missing would hide a reading that is perfectly good.

    `warn` rides along for the same reason `ups.snapshot` sends `warn_pct`: the thresholds have
    one home, and it is not the stylesheet's language.
    """
    out, warn = {}, dict(WARN_C)
    for key, path in _find().items():
        c = _read_c(path)
        if c is not None:
            out[key] = c
    ram, ram_warn = _dimm_c()
    if ram is not None:
        out["ram"] = ram
        out["dimms"] = _dimm_count()      # for the tooltip: what the figure is the hottest OF
        warn["ram"] = ram_warn            # the module's own limit, not one invented here
    if not out:
        return None
    out["warn"] = warn
    return out
