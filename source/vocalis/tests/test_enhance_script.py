"""Local snapshot preflight for the isolated Resemble Enhance child."""
import importlib.util
import sys
import types
from pathlib import Path

import pytest


SCRIPT = (Path(__file__).resolve().parent.parent / "scripts" / "enhance" /
          "enhance_audio.py")
SPEC = importlib.util.spec_from_file_location("enhance_audio", SCRIPT)
enhance_audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(enhance_audio)


def _snapshot(tmp_path):
    run_dir = tmp_path / enhance_audio._MODEL_REVISION / "enhancer_stage2"
    for name in enhance_audio._MODEL_FILES:
        path = run_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fixture")
    return run_dir


def test_local_loader_guard_rechecks_files_without_upstream_download(tmp_path):
    run_dir = _snapshot(tmp_path)
    inference = types.ModuleType("fake_enhance_inference")
    exec("def load_enhancer(run_dir):\n    return download(run_dir)\n", inference.__dict__)

    def upstream_download(*_args):
        pytest.fail("upstream downloader was called")

    inference.download = upstream_download
    enhance_audio._local_model_loader(inference, run_dir)

    assert inference.load_enhancer(run_dir) == run_dir
    (run_dir / "hparams.yaml").unlink()
    with pytest.raises(enhance_audio.ModelUnavailableError, match="hparams.yaml"):
        inference.load_enhancer(run_dir)
    with pytest.raises(enhance_audio.ModelUnavailableError, match="outside the pinned snapshot"):
        inference.load_enhancer(tmp_path / "other")


def test_cli_reports_missing_snapshot_before_importing_engine(tmp_path, monkeypatch, capsys):
    source = tmp_path / "input.wav"
    source.write_bytes(b"audio")
    missing = tmp_path / enhance_audio._MODEL_REVISION / "enhancer_stage2"
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "-i", str(source), "-o",
                                      str(tmp_path / "out.wav"), "--model-dir", str(missing)])

    assert enhance_audio.main() == 3
    assert "pinned Resemble Enhance snapshot is incomplete" in capsys.readouterr().err
