"""`tts_utils.gpu_fan_pct` and its integration into `gpu.gpu_stats()`.

Report fan duty cycle as a percentage for both hwmon and NVML devices. The hwmon path reuses the
existing cached directory and integer-reader helpers; fake hwmon fixtures verify conversion and
missing-file behavior."""
import torch

import tts_utils as tu
from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)
from vocalis.runtime import gpu as gpu_mod


def _hwmon(tmp_path, **files):
    """A fake hwmon dir holding whatever value files are given, one per keyword."""
    d = tmp_path / "hwmon0"
    d.mkdir(exist_ok=True)
    for name, value in files.items():
        (d / name).write_text(f"{value}\n")
    return d


def test_fifty_one_of_two_fifty_five_is_twenty_percent(tmp_path, monkeypatch):
    d = _hwmon(tmp_path, pwm1=51, pwm1_max=255)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: str(d))
    assert tu.gpu_fan_pct(0) == 20


def test_a_missing_pwm1_is_none(tmp_path, monkeypatch):
    d = _hwmon(tmp_path, pwm1_max=255)      # pwm1 itself is absent
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: str(d))
    assert tu.gpu_fan_pct(0) is None


def test_a_zero_pwm1_max_is_none_not_a_division_by_zero(tmp_path, monkeypatch):
    d = _hwmon(tmp_path, pwm1=51, pwm1_max=0)
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: str(d))
    assert tu.gpu_fan_pct(0) is None


def test_no_hwmon_dir_at_all_is_none(monkeypatch):
    """Non-AMD / non-Linux — the Windows dev box. Callers omit the field rather than a blank."""
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)
    assert tu.gpu_fan_pct(0) is None


def test_fan_pct_is_clamped_zero_to_one_hundred(tmp_path, monkeypatch):
    """A sensor read that rounds past either end of the range must not print an impossible
    percent — the same defensive clamp `_hwmon_int`'s other callers rely on their own math for."""
    d = _hwmon(tmp_path, pwm1=260, pwm1_max=255)     # a hair over 100% if left unclamped
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: str(d))
    assert tu.gpu_fan_pct(0) == 100


def test_gpu_stats_carries_fan_pct(tmp_path, monkeypatch):
    """The strip's actual read path: `gpu.gpu_stats()` must surface the same figure per card,
    right alongside `sclk_mhz`/`mclk_mhz` — the fields `_hwmon_int` already reads through this
    same cached dir."""
    d = _hwmon(tmp_path, pwm1=51, pwm1_max=255)
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 1)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda i: "AMD Radeon AI PRO R9700")
    monkeypatch.setattr(tu, "vram_used_total", lambda i: (6 * 2**30, 32 * 2**30))
    monkeypatch.setattr(tu, "proc_vram_bytes", lambda i: None)
    monkeypatch.setattr(torch.cuda, "memory_reserved", lambda i: 0)
    for name in ("gpu_util_percent", "gpu_temp_c", "gpu_power_w"):
        monkeypatch.setattr(tu, name, lambda i: None)
    monkeypatch.setattr(tu, "gpu_clocks_mhz", lambda i: (None, None))
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: str(d))

    g = gpu_mod.gpu_stats()[0]
    assert g["fan_pct"] == 20


def test_gpu_stats_omits_nothing_when_the_card_has_no_fan_sensor(monkeypatch):
    """A card (or a box) with no `pwm1` file at all gets `None`, same as every other optional
    sensor here — never a missing key and never a fabricated 0."""
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 1)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda i: "AMD Radeon AI PRO R9700")
    monkeypatch.setattr(tu, "vram_used_total", lambda i: (6 * 2**30, 32 * 2**30))
    monkeypatch.setattr(tu, "proc_vram_bytes", lambda i: None)
    monkeypatch.setattr(torch.cuda, "memory_reserved", lambda i: 0)
    for name in ("gpu_util_percent", "gpu_temp_c", "gpu_power_w"):
        monkeypatch.setattr(tu, name, lambda i: None)
    monkeypatch.setattr(tu, "gpu_clocks_mhz", lambda i: (None, None))
    monkeypatch.setattr(tu, "_hwmon_dir", lambda dev: None)

    g = gpu_mod.gpu_stats()[0]
    assert "fan_pct" in g
    assert g["fan_pct"] is None
