"""Verify the shared opt-in ROCm policy and its retained process entrypoints."""

import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "satellite" / "vocalis_torch_backend.py"


def _load_helper():
    spec = importlib.util.spec_from_file_location("vocalis_torch_backend_test", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("setting", "hip_version", "expected_change"),
    [
        ("1", "7.14.1", True),
        ("0", "7.14.1", False),
        (None, "7.14.1", False),
        ("1", None, False),
    ],
    ids=("rocm-enabled", "rocm-disabled", "rocm-unset", "cuda"),
)
def test_rocm_miopen_policy_is_opt_in_and_vendor_scoped(setting, hip_version, expected_change):
    helper = _load_helper()
    cudnn = SimpleNamespace(enabled=True)
    torch = SimpleNamespace(
        version=SimpleNamespace(hip=hip_version),
        backends=SimpleNamespace(cudnn=cudnn),
    )
    environment = {} if setting is None else {"VOCALIS_ROCM_DISABLE_MIOPEN": setting}

    changed = helper.apply_rocm_miopen_policy(torch, environment)

    assert changed is expected_change
    assert cudnn.enabled is (not expected_change)


def _position(tree, predicate):
    return next(index for index, node in enumerate(tree.body) if predicate(node))


def _import_position(tree, name):
    return _position(tree, lambda node: isinstance(node, (ast.Import, ast.ImportFrom)) and (
        isinstance(node, ast.Import) and any(alias.name == name for alias in node.names)
        or isinstance(node, ast.ImportFrom) and node.module == name
    ))


def test_retained_process_entrypoints_apply_policy_before_model_initialization():
    server = ast.parse((ROOT / "src" / "vocalis_server.py").read_text(encoding="utf-8"))
    assert _import_position(server, "torch") < _position(
        server, lambda n: isinstance(n, ast.Expr) and "apply_rocm_miopen_policy" in ast.dump(n)
    ) < _import_position(server, "book_to_audio")

    satellite = ast.parse((ROOT / "satellite" / "server.py").read_text(encoding="utf-8"))
    assert _import_position(satellite, "torch") < _position(
        satellite, lambda n: isinstance(n, ast.Expr) and "apply_rocm_miopen_policy" in ast.dump(n)
    ) < _import_position(satellite, "vocalis_satellite_engine")

    cases = [
        (ROOT / "scripts" / "voxcpm" / "worker.py", "_load_model", "voxcpm"),
        (ROOT / "scripts" / "enhance" / "enhance_audio.py", "main", "resemble_enhance.enhancer.inference"),
        (ROOT / "scripts" / "leadvocal" / "detect.py", "main", "_separate_primary"),
        (ROOT / "scripts" / "stems" / "demucs_worker.py", "main", "runpy.run_module"),
        (ROOT / "scripts" / "acestep" / "worker.py", "main", "runpy.run_module"),
    ]
    for path, function_name, next_operation in cases:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and node.name == function_name)
        nodes = list(ast.walk(function))
        torch_import = min(node.lineno for node in nodes
                           if isinstance(node, ast.Import)
                           and any(alias.name == "torch" for alias in node.names))
        policy_call = min(node.lineno for node in nodes
                          if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                          and node.func.id == "apply_rocm_miopen_policy")
        if next_operation == "_separate_primary":
            operation = min(node.lineno for node in nodes
                            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                            and node.func.id == next_operation)
        elif next_operation == "runpy.run_module":
            operation = min(node.lineno for node in nodes
                            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                            and node.func.attr == "run_module"
                            and isinstance(node.func.value, ast.Name)
                            and node.func.value.id == "runpy")
        else:
            operation = min(node.lineno for node in nodes
                            if (isinstance(node, ast.ImportFrom) and node.module == next_operation)
                            or (isinstance(node, ast.Import) and any(
                                alias.name == next_operation for alias in node.names)))
        assert torch_import < policy_call < operation, path


def test_voxcpm_worker_applies_policy_before_factory_import(monkeypatch, tmp_path):
    import importlib.util
    import os
    import sys
    from types import ModuleType

    worker_path = ROOT / "scripts" / "voxcpm" / "worker.py"
    spec = importlib.util.spec_from_file_location("voxcpm_policy_worker_test", worker_path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    cudnn = SimpleNamespace(enabled=True)
    fake_torch = ModuleType("torch")
    fake_torch.version = SimpleNamespace(hip="7.14.1")
    fake_torch.backends = SimpleNamespace(cudnn=cudnn)
    fake_torch.cuda = SimpleNamespace(is_available=lambda: True, set_device=lambda _index: None)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("VOCALIS_ROCM_DISABLE_MIOPEN", "1")

    class VoxCPM:
        @staticmethod
        def from_pretrained(model, *, load_denoiser, optimize):
            assert cudnn.enabled is False
            return "loaded"

    fake_package = ModuleType("voxcpm")
    fake_package.VoxCPM = VoxCPM
    monkeypatch.setitem(sys.modules, "voxcpm", fake_package)

    assert worker._load_model(tmp_path, False, "cuda:0") == "loaded"
    assert os.environ["VOCALIS_ROCM_DISABLE_MIOPEN"] == "1"


def test_demucs_launcher_applies_policy_before_delegating_cli(monkeypatch):
    import importlib.util
    import sys
    from types import ModuleType

    launcher_path = ROOT / "scripts" / "stems" / "demucs_worker.py"
    spec = importlib.util.spec_from_file_location("demucs_worker_policy_test", launcher_path)
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)

    cudnn = SimpleNamespace(enabled=True)
    fake_torch = ModuleType("torch")
    fake_torch.version = SimpleNamespace(hip="7.14.1")
    fake_torch.backends = SimpleNamespace(cudnn=cudnn)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("VOCALIS_ROCM_DISABLE_MIOPEN", "1")

    original_argv = sys.argv[:]
    sys.argv[:] = [str(launcher_path), "--two-stems=vocals", "-n", "htdemucs"]
    delegated = {}

    def run_module(module_name, *, run_name, alter_sys):
        delegated.update(module=module_name, run_name=run_name, alter_sys=alter_sys,
                         arguments=sys.argv[1:], policy_enabled=cudnn.enabled)

    monkeypatch.setattr(launcher.runpy, "run_module", run_module)
    try:
        launcher.main()
    finally:
        sys.argv[:] = original_argv

    assert delegated == {
        "module": "demucs", "run_name": "__main__", "alter_sys": True,
        "arguments": ["--two-stems=vocals", "-n", "htdemucs"], "policy_enabled": False,
    }


def _load_demucs_launcher(name):
    launcher_path = ROOT / "scripts" / "stems" / "demucs_worker.py"
    spec = importlib.util.spec_from_file_location(name, launcher_path)
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    return launcher


def test_demucs_launcher_writes_wav_itself_only_when_torchaudio_cannot(monkeypatch, tmp_path):
    """October 11, 2026: torchaudio 2.10 in the Docker images writes files only through TorchCodec,
    which the stems environment does not have, so every split died at its first stem."""
    launcher = _load_demucs_launcher("demucs_worker_writer_choice_test")
    new_torchaudio = tmp_path / "new" / "torchaudio"
    new_torchaudio.mkdir(parents=True)
    (new_torchaudio / "_torchcodec.py").write_text("", encoding="utf-8")
    old_torchaudio = tmp_path / "old" / "torchaudio"
    old_torchaudio.mkdir(parents=True)

    def specs(torchaudio_folder, torchcodec_installed):
        def find_spec(name):
            if name == "torchaudio":
                return SimpleNamespace(submodule_search_locations=[str(torchaudio_folder)])
            if name == "torchcodec":
                return SimpleNamespace() if torchcodec_installed else None
            raise AssertionError(name)
        return find_spec

    monkeypatch.setattr(launcher.importlib.util, "find_spec", specs(new_torchaudio, False))
    assert launcher.needs_wav_writer() is True
    monkeypatch.setattr(launcher.importlib.util, "find_spec", specs(new_torchaudio, True))
    assert launcher.needs_wav_writer() is False
    monkeypatch.setattr(launcher.importlib.util, "find_spec", specs(old_torchaudio, False))
    assert launcher.needs_wav_writer() is False
    monkeypatch.setattr(launcher.importlib.util, "find_spec", lambda name: None)
    assert launcher.needs_wav_writer() is False


def test_demucs_launcher_wav_writer_round_trip(tmp_path):
    import wave

    torch = pytest.importorskip("torch")
    launcher = _load_demucs_launcher("demucs_worker_writer_test")
    # Two channels, four frames; includes full scale both ways and a value past it.
    audio = torch.tensor([[0.0, 0.5, -1.0, 1.5], [0.25, -0.5, 1.0, -0.25]])
    out = tmp_path / "vocals.wav"
    # The exact call Demucs makes for its default output.
    launcher.save_pcm16_wav(str(out), audio, sample_rate=44100, encoding="PCM_S",
                            bits_per_sample=16)
    with wave.open(str(out), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) \
            == (2, 2, 44100, 4)
        frames = wav.readframes(4)
    samples = [int.from_bytes(frames[i:i + 2], "little", signed=True)
               for i in range(0, len(frames), 2)]
    # Interleaved left, right; 1.0 and 1.5 both clamp to the top of the int16 range.
    assert samples == [0, 8192, 16384, -16384, -32768, 32767, 32767, -8192]

    # A value between two steps goes to the nearest one, not toward zero (1.6384 steps -> 2).
    fine = tmp_path / "fine.wav"
    launcher.save_pcm16_wav(str(fine), torch.tensor([[0.00005, -0.00005, 0.00001]]),
                            sample_rate=44100, encoding="PCM_S", bits_per_sample=16)
    with wave.open(str(fine), "rb") as wav:
        assert wav.getnchannels() == 1
        frames = wav.readframes(3)
    assert [int.from_bytes(frames[i:i + 2], "little", signed=True) for i in (0, 2, 4)] == [2, -2, 0]

    with pytest.raises(RuntimeError, match="16-bit WAV"):
        launcher.save_pcm16_wav(str(tmp_path / "x.wav"), audio, sample_rate=44100,
                                encoding="PCM_F", bits_per_sample=32)
    with pytest.raises(RuntimeError, match="16-bit WAV"):
        launcher.save_pcm16_wav(str(tmp_path / "x.flac"), audio, sample_rate=44100)


def test_acestep_launcher_applies_policy_and_preserves_module_cli(monkeypatch, tmp_path):
    import importlib.util
    import os
    import sys
    from types import ModuleType

    launcher_path = ROOT / "scripts" / "acestep" / "worker.py"
    spec = importlib.util.spec_from_file_location("acestep_policy_worker_test", launcher_path)
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)

    cudnn = SimpleNamespace(enabled=True)
    fake_torch = ModuleType("torch")
    fake_torch.version = SimpleNamespace(hip="7.14.1")
    fake_torch.backends = SimpleNamespace(cudnn=cudnn)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setenv("VOCALIS_ROCM_DISABLE_MIOPEN", "1")
    monkeypatch.chdir(tmp_path)

    original_argv = sys.argv[:]
    original_path = sys.path[:]
    args = ["--host", "127.0.0.1", "--port", "7683", "--no-init"]
    sys.argv[:] = [str(launcher_path), *args]
    delegated = {}

    def run_module(module_name, *, run_name, alter_sys):
        delegated.update(
            module=module_name,
            run_name=run_name,
            alter_sys=alter_sys,
            arguments=sys.argv[1:],
            cwd=os.getcwd(),
            source_on_path=str(tmp_path) in sys.path,
            policy_enabled=cudnn.enabled,
        )

    monkeypatch.setattr(launcher.runpy, "run_module", run_module)
    try:
        launcher.main()
        assert sys.argv == [str(launcher_path), *args]
        assert sys.path == original_path
    finally:
        sys.argv[:] = original_argv

    assert delegated == {
        "module": "acestep.api_server", "run_name": "__main__", "alter_sys": True,
        "arguments": args, "cwd": str(tmp_path), "source_on_path": True,
        "policy_enabled": False,
    }


def _probe(stdout, returncode=0):
    def run(argv, **kwargs):
        assert kwargs["timeout"] > 0
        return SimpleNamespace(returncode=returncode, stdout=stdout)
    return run


@pytest.mark.parametrize(
    ("report", "expected_visible", "reason"),
    [
        ('{"hip": true, "integrated": [false, false, true]}', "0,1", None),
        ('{"hip": true, "integrated": [true, false, false]}', "1,2", None),
        ('{"hip": true, "integrated": [false, false]}', None, "no integrated GPU"),
        ('{"hip": true, "integrated": [true]}', None, "only integrated GPUs present"),
        ('{"hip": false, "integrated": []}', None, "no integrated GPU"),
    ],
    ids=("igpu-last", "igpu-first", "discrete-only", "igpu-only", "cuda"),
)
def test_integrated_rocm_gpus_are_hidden_before_torch(report, expected_visible, reason):
    helper = _load_helper()
    environment = {}

    decision = helper.hide_integrated_rocm_gpus(environment, run=_probe(report), kfd_present=True)

    assert environment.get("HIP_VISIBLE_DEVICES") == expected_visible
    if reason:
        assert decision == {"action": "none", "reason": reason}


@pytest.mark.parametrize("name", ["HIP_VISIBLE_DEVICES", "CUDA_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"])
def test_explicit_device_visibility_is_never_overridden(name):
    helper = _load_helper()
    environment = {name: "1"}

    def run(*args, **kwargs):
        raise AssertionError("probe must not run when visibility is explicit")

    decision = helper.hide_integrated_rocm_gpus(environment, run=run, kfd_present=True)

    assert environment == {name: "1"}
    assert decision["action"] == "none"


def test_failed_or_absent_probe_leaves_visibility_unchanged():
    helper = _load_helper()
    for decision, environment in (
        (helper.hide_integrated_rocm_gpus(env := {}, run=_probe("", returncode=1), kfd_present=True), env),
        (helper.hide_integrated_rocm_gpus(env2 := {}, run=_probe("not json"), kfd_present=True), env2),
        (helper.hide_integrated_rocm_gpus(env3 := {}, run=_probe("{}"), kfd_present=False), env3),
    ):
        assert decision["action"] == "none"
        assert "HIP_VISIBLE_DEVICES" not in environment


def test_server_hides_integrated_gpus_before_importing_torch():
    server = ast.parse((ROOT / "src" / "vocalis_server.py").read_text(encoding="utf-8"))
    hide = _position(server, lambda n: "hide_integrated_rocm_gpus" in ast.dump(n)
                     and isinstance(n, ast.Assign))
    assert hide < _import_position(server, "torch")


@pytest.mark.parametrize(
    ("visible", "logical", "machine"),
    [(None, "0", "0"), ("0,1", "1", "1"), ("1,2", "0", "1"), ("1,2", "1", "2")],
)
def test_child_card_pins_use_machine_device_numbers(monkeypatch, visible, logical, machine):
    import engine_process
    import leadvocal
    import stem_engine
    from vocalis.runtime import acestep

    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    if visible is None:
        monkeypatch.delenv("HIP_VISIBLE_DEVICES", raising=False)
    else:
        monkeypatch.setenv("HIP_VISIBLE_DEVICES", visible)
    import os

    for env in (engine_process.card_env(f"cuda:{logical}"),
                stem_engine._card_env(f"cuda:{logical}"),
                leadvocal.detect_env(dict(os.environ), f"cuda:{logical}"),
                acestep._child_environment(f"cuda:{logical}", int(logical), "/models/vocalis/acestep")):
        assert env["HIP_VISIBLE_DEVICES"] == machine
        assert env["CUDA_VISIBLE_DEVICES"] == machine


def test_child_card_pin_outside_the_visible_list_is_refused(monkeypatch):
    import engine_process

    monkeypatch.setenv("HIP_VISIBLE_DEVICES", "0,1")
    with pytest.raises(ValueError, match="outside HIP_VISIBLE_DEVICES"):
        engine_process.card_env("cuda:2")
