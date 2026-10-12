"""The packaged Chatterbox loader accepts only the pinned local artifact set."""

import hashlib
import json
import sys
import types

import pytest

import tts_utils


REVISION = "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18"
FILES = {
    "ve.safetensors": b"voice encoder",
    "t3_cfg.safetensors": b"text model",
    "s3gen.safetensors": b"audio generator",
    "conds.pt": b"conditionals",
    "tokenizer.json": b"tokenizer",
}


def _model_fixture(tmp_path, monkeypatch):
    model_dir = tmp_path / REVISION
    model_dir.mkdir()
    files = []
    for name, payload in FILES.items():
        (model_dir / name).write_bytes(payload)
        files.append({
            "path": name,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })
    manifest = {
        "schema_version": 1,
        "repository": "ResembleAI/chatterbox",
        "revision": REVISION,
        "files": files,
    }
    manifest_path = tmp_path / "chatterbox-model-manifest.json"
    manifest_bytes = json.dumps(manifest).encode("utf-8")
    manifest_path.write_bytes(manifest_bytes)
    monkeypatch.setattr(tts_utils, "_CHATTERBOX_MODEL_MANIFEST_PATH", manifest_path)
    monkeypatch.setattr(
        tts_utils,
        "_CHATTERBOX_MODEL_MANIFEST_SHA256",
        hashlib.sha256(manifest_bytes).hexdigest(),
    )
    return model_dir, manifest_path


def _fake_chatterbox(monkeypatch):
    calls = []

    class FakeChatterboxTTS:
        @classmethod
        def from_local(cls, path, *, device):
            calls.append(("local", path, device))
            return "local-model"

        @classmethod
        def from_pretrained(cls, *, device):
            calls.append(("pretrained", device))
            return "remote-model"

    package = types.ModuleType("chatterbox")
    package.__path__ = []
    tts_module = types.ModuleType("chatterbox.tts")
    tts_module.ChatterboxTTS = FakeChatterboxTTS
    package.tts = tts_module
    monkeypatch.setitem(sys.modules, "chatterbox", package)
    monkeypatch.setitem(sys.modules, "chatterbox.tts", tts_module)
    monkeypatch.setattr(tts_utils, "_install_cancel_hook", lambda: None)
    return calls


def test_verifies_exact_local_artifacts_before_loading(tmp_path, monkeypatch):
    model_dir, _ = _model_fixture(tmp_path, monkeypatch)
    monkeypatch.setenv("VOCALIS_CHATTERBOX_MODEL_DIR", str(model_dir))
    monkeypatch.delenv("VOCALIS_REQUIRE_VAULT", raising=False)
    calls = _fake_chatterbox(monkeypatch)

    assert tts_utils.load_model("cuda:0") == "local-model"
    assert calls == [("local", model_dir, "cuda:0")]


def test_missing_frozen_manifest_fails_without_pretrained_fallback(tmp_path, monkeypatch):
    model_dir, manifest_path = _model_fixture(tmp_path, monkeypatch)
    manifest_path.unlink()
    monkeypatch.setenv("VOCALIS_CHATTERBOX_MODEL_DIR", str(model_dir))
    calls = _fake_chatterbox(monkeypatch)

    with pytest.raises(tts_utils.VocalisError, match="manifest is unavailable"):
        tts_utils.load_model("cuda:0")
    assert calls == []


def test_changed_manifest_fails_without_pretrained_fallback(tmp_path, monkeypatch):
    model_dir, manifest_path = _model_fixture(tmp_path, monkeypatch)
    manifest_path.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("VOCALIS_CHATTERBOX_MODEL_DIR", str(model_dir))
    calls = _fake_chatterbox(monkeypatch)

    with pytest.raises(tts_utils.VocalisError, match="manifest failed its SHA-256"):
        tts_utils.load_model("cuda:0")
    assert calls == []


def test_modified_model_artifact_fails_without_pretrained_fallback(tmp_path, monkeypatch):
    model_dir, _ = _model_fixture(tmp_path, monkeypatch)
    (model_dir / "ve.safetensors").write_bytes(b"changed")
    monkeypatch.setenv("VOCALIS_CHATTERBOX_MODEL_DIR", str(model_dir))
    calls = _fake_chatterbox(monkeypatch)

    with pytest.raises(tts_utils.VocalisError, match="failed integrity verification"):
        tts_utils.load_model("cuda:0")
    assert calls == []


def test_packaged_runtime_requires_local_model_configuration(monkeypatch):
    monkeypatch.delenv("VOCALIS_CHATTERBOX_MODEL_DIR", raising=False)
    monkeypatch.setenv("VOCALIS_REQUIRE_VAULT", "1")
    calls = _fake_chatterbox(monkeypatch)

    with pytest.raises(tts_utils.VocalisError, match="requires VOCALIS_CHATTERBOX_MODEL_DIR"):
        tts_utils.load_model("cuda:0")
    assert calls == []


def test_legacy_mode_keeps_upstream_pretrained_loader(monkeypatch):
    monkeypatch.delenv("VOCALIS_CHATTERBOX_MODEL_DIR", raising=False)
    monkeypatch.delenv("VOCALIS_REQUIRE_VAULT", raising=False)
    calls = _fake_chatterbox(monkeypatch)

    assert tts_utils.load_model("cuda:0") == "remote-model"
    assert calls == [("pretrained", "cuda:0")]
