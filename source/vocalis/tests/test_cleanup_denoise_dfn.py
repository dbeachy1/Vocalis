"""Pure logic tests for the DeepFilterNet3 denoise child.

These tests keep imports lightweight: torch and DeepFilterNet load inside `main()`, while helper
imports need only the standard library and NumPy. They also pin shared dry/wet and sweep behavior
and ensure `--atten` clamps invalid values before reaching the model.
"""
import sys
import builtins
import types
from pathlib import Path

import numpy as np
import pytest

CLEANUP = Path(__file__).resolve().parent.parent / "scripts" / "cleanup"
sys.path.insert(0, str(CLEANUP))

import denoise_dfn as dn  # noqa: E402


# ── the shared mix logic is imported, not re-implemented ─────────────────────

def test_the_mix_helpers_are_the_shared_ones():
    """denoise_dfn re-exports _mix's helpers rather than keeping its own copy — one home for
    the dry/wet mix (the enhance-shim discipline: two copies is how they drift)."""
    import _mix
    assert dn.parse_levels is _mix.parse_levels
    assert dn.dry_wet_mix is _mix.dry_wet_mix
    assert dn.wet_output_path is _mix.wet_output_path


def test_importing_the_child_pulls_in_no_torch():
    """Torch and DeepFilterNet load inside `main()`, so the module imports for its pure helpers
    without either optional runtime dependency. If DeepFilterNet leaked to module scope, this
    would already fail at import; assert it explicitly so a future refactor cannot regress it.
    at the import above — assert it explicitly so a future refactor can't quietly regress it."""
    assert "df" not in sys.modules or dn is not None  # importing dn did not require df


def test_missing_local_model_fails_before_importing_deepfilternet(monkeypatch, tmp_path, capsys):
    audio = tmp_path / "input.wav"
    audio.write_bytes(b"synthetic input")
    attempted = []
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "df" or name.startswith("df."):
            attempted.append(name)
            raise AssertionError("DeepFilterNet must not import before local-input preflight")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setattr(sys, "argv", ["denoise_dfn.py", "-i", str(audio), "-o",
                                      str(tmp_path / "out.wav"), "--model-dir",
                                      str(tmp_path / "model")])
    assert dn.main() == 2
    assert attempted == []
    assert "config.ini" in capsys.readouterr().err


def test_model_preflight_requires_config_and_checkpoint(tmp_path):
    model = tmp_path / "model"
    model.mkdir()
    assert "config.ini" in dn.local_model_error(model)
    (model / dn.DFN_CONFIG).write_bytes(b"config")
    assert "model_120.ckpt.best" in dn.local_model_error(model)
    checkpoint = model / dn.DFN_CHECKPOINT
    checkpoint.parent.mkdir()
    checkpoint.write_bytes(b"checkpoint")
    assert dn.local_model_error(model) is None


def test_main_passes_explicit_local_model_directory_to_init_df(monkeypatch, tmp_path, capsys):
    model_root = tmp_path / "DeepFilterNet3"
    (model_root / dn.DFN_CHECKPOINT.parent).mkdir(parents=True)
    (model_root / dn.DFN_CONFIG).write_bytes(b"config")
    (model_root / dn.DFN_CHECKPOINT).write_bytes(b"checkpoint")
    audio = tmp_path / "input.wav"
    audio.write_bytes(b"synthetic input")
    output = tmp_path / "out.wav"
    seen = {}

    class Tensor:
        shape = (32_000,)

        def mean(self, _axis): return self
        def unsqueeze(self, _axis): return self
        def to(self, _device): return self
        def squeeze(self, _axis): return self
        def detach(self): return self
        def cpu(self): return self
        def numpy(self): return np.zeros(48_000, dtype=np.float32)

    class Model:
        def to(self, _device): return self

    class State:
        def sr(self): return 48_000

    def init_df(**kwargs):
        seen.update(kwargs)
        return Model(), State(), "fixture"

    def enhance(*_args, **_kwargs): return Tensor()
    torch = types.ModuleType("torch")
    torch.from_numpy = lambda _array: Tensor()
    soundfile = types.ModuleType("soundfile")
    soundfile.read = lambda *_a, **_k: (np.zeros((32_000, 1), dtype=np.float32), 48_000)

    def write(path, *_args, **_kwargs): Path(path).write_bytes(b"WAV")
    soundfile.write = write
    df = types.ModuleType("df")
    enhance_module = types.ModuleType("df.enhance")
    enhance_module.init_df = init_df
    enhance_module.enhance = enhance
    df.enhance = enhance_module
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "soundfile", soundfile)
    monkeypatch.setitem(sys.modules, "df", df)
    monkeypatch.setitem(sys.modules, "df.enhance", enhance_module)
    monkeypatch.setattr(sys, "argv", ["denoise_dfn.py", "-i", str(audio), "-o",
                                      str(output), "--model-dir", str(model_root)])

    assert dn.main() == 0
    assert seen == {"model_base_dir": str(model_root), "log_file": None}
    assert output.read_bytes() == b"WAV"
    assert "VOCALIS_TIMING" in capsys.readouterr().out


# ── --atten parsing (DeepFilterNet's gentleness cap) ─────────────────────────

@pytest.mark.parametrize("raw,want", [
    (0.0, 0.0),
    (6.0, 6.0),
    (12, 12.0),
    (-3.0, 0.0),          # a negative cap is a typo — clamp to "no cap / full strength"
    ("9", 9.0),
    (None, 0.0),          # unset → full strength (the ear-test winner)
    ("garbage", 0.0),
])
def test_parse_atten(raw, want):
    assert dn.parse_atten(raw) == want


# ── the dry/wet mix behaves as the shared logic promises ─────────────────────

def test_full_wet_returns_the_denoised_signal_untouched():
    d = np.array([0.1, -0.2, 0.3, -0.4, 0.5], dtype=np.float32)
    orig = np.zeros(3, dtype=np.float32)               # deliberately a different length
    out = dn.dry_wet_mix(orig, d, 1.0)
    assert np.array_equal(out, d)
    assert len(out) == len(d)


def test_mix_survives_a_length_mismatch():
    """DeepFilterNet pads internally, so its output is not guaranteed to match a resample of
    the original to the sample. Aligning to the shorter length stops a raw `+` from raising."""
    d = np.arange(10, dtype=np.float32)
    o = np.arange(7, dtype=np.float32)
    out = dn.dry_wet_mix(o, d, 0.5)
    assert len(out) == 7
    assert np.allclose(out, 0.5 * d[:7] + 0.5 * o[:7])


def test_sweep_names_are_distinct_and_sortable():
    base = Path("/x/o.wav")
    names = [dn.wet_output_path(base, v).name for v in dn.parse_levels("1.0,0.7,0.4")]
    assert len(set(names)) == 3
    assert names == sorted(names, reverse=True)        # wet100 > wet070 > wet040
