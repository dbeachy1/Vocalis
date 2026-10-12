"""Device isolation and factory-call contract for the standalone VoxCPM worker."""
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


WORKER_PATH = Path(__file__).parents[1] / "scripts" / "voxcpm" / "worker.py"
_SPEC = importlib.util.spec_from_file_location("voxcpm_worker_under_test", WORKER_PATH)
worker = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(worker)


def test_model_factory_runs_after_selecting_device_and_uses_pinned_signature(monkeypatch, tmp_path):
    seen = {}
    selections = []
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: True, set_device=selections.append)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    for name in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
        monkeypatch.setenv(name, "inherited-visible-set")

    class VoxCPM:
        @staticmethod
        def from_pretrained(model, *, load_denoiser, optimize):
            seen.update(model=model, load_denoiser=load_denoiser, optimize=optimize)
            seen["selected_device"] = selections[-1]
            seen["visibility"] = tuple(os.environ[name] for name in (
                "CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"))
            return "loaded"

    fake_package = ModuleType("voxcpm")
    fake_package.VoxCPM = VoxCPM
    monkeypatch.setitem(sys.modules, "voxcpm", fake_package)

    assert worker._load_model(tmp_path, True, "cuda:3") == "loaded"
    assert seen == {
        "model": str(tmp_path),
        "load_denoiser": False,
        "optimize": True,
        "selected_device": 3,
        "visibility": ("inherited-visible-set",) * 3,
    }


def test_cpu_debug_mode_hides_accelerators_before_factory_import(monkeypatch, tmp_path):
    seen = []

    class VoxCPM:
        @staticmethod
        def from_pretrained(model, *, load_denoiser, optimize):
            seen.extend(os.environ[name] for name in (
                "CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"))
            return object()

    fake_package = ModuleType("voxcpm")
    fake_package.VoxCPM = VoxCPM
    monkeypatch.setitem(sys.modules, "voxcpm", fake_package)

    worker._load_model(tmp_path, False, "cpu")
    assert seen == ["", "", ""]


def test_gpu_request_fails_if_runtime_has_no_visible_gpu(monkeypatch, tmp_path):
    fake_torch = ModuleType("torch")
    fake_torch.cuda = SimpleNamespace(is_available=lambda: False, set_device=lambda _index: None)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.delitem(sys.modules, "voxcpm", raising=False)

    with pytest.raises(RuntimeError, match="requested VoxCPM device cuda:2"):
        worker._load_model(tmp_path, False, "cuda:2")
    assert "voxcpm" not in sys.modules


@pytest.mark.parametrize("device", ["cuda", "cuda:-1", "cuda:01", "mps:0", "gpu:2"])
def test_invalid_device_fails_before_importing_factory(monkeypatch, tmp_path, device):
    monkeypatch.delitem(sys.modules, "voxcpm", raising=False)
    with pytest.raises(ValueError, match="device must be cuda:N or cpu"):
        worker._load_model(tmp_path, False, device)
    assert "voxcpm" not in sys.modules


def test_generation_seeds_each_request_before_calling_pinned_signature():
    events = []
    current_seed = None

    class StrictModel:
        def generate(self, *, text, cfg_value, inference_timesteps):
            events.append(("generate", current_seed, text, cfg_value, inference_timesteps))
            return (text, current_seed)

    def manual_seed(seed):
        nonlocal current_seed
        current_seed = seed
        events.append(("seed", seed))

    torch_stub = SimpleNamespace(manual_seed=manual_seed)
    model = StrictModel()
    first = worker._generate_request(
        model, {"seed": 17, "text": "first", "cfg_value": 2.5, "steps": 23}, torch_stub)
    second = worker._generate_request(
        model, {"seed": 91, "text": "second", "cfg_value": 1.5, "steps": 11}, torch_stub)

    assert first == ("first", 17)
    assert second == ("second", 91)
    assert events == [
        ("seed", 17), ("generate", 17, "first", 2.5, 23),
        ("seed", 91), ("generate", 91, "second", 1.5, 11),
    ]
