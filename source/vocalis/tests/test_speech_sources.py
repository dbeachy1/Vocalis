"""Tests for retained Speech clip storage and shared source-preparation helpers."""
from __future__ import annotations

import contextlib
import os
import shutil
from pathlib import Path

import pytest
import yaml

import scratch
import speech_sources
import vault_fs


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    directory = tmp_path / "speech"
    directory.mkdir()
    scratch_root = tmp_path / "scratch"
    scratch_root.mkdir()

    monkeypatch.setattr(vault_fs, "exists", lambda path: Path(path).exists())
    monkeypatch.setattr(vault_fs, "mkdir", lambda path: Path(path).mkdir(parents=True, exist_ok=True))
    monkeypatch.setattr(vault_fs, "from_scratch", lambda src, dst: shutil.copyfile(src, dst))
    monkeypatch.setattr(vault_fs, "open_read", lambda path: open(path, "rb"))
    monkeypatch.setattr(vault_fs, "rename", lambda src, dst: Path(src).rename(dst))
    monkeypatch.setattr(vault_fs, "unlink", lambda path, missing_ok=False:
                        Path(path).unlink(missing_ok=missing_ok))
    monkeypatch.setattr(vault_fs, "write_yaml_atomic",
                        lambda path, value: Path(path).write_text(
                            yaml.safe_dump(value, sort_keys=False), encoding="utf-8"))
    monkeypatch.setattr(vault_fs, "read_text", lambda path: Path(path).read_text(encoding="utf-8"))

    @contextlib.contextmanager
    def temp_file(_root, label, suffix):
        path = scratch_root / f"{label.replace('|', '-')}{suffix}"
        try:
            yield path
        finally:
            path.unlink(missing_ok=True)

    monkeypatch.setattr(scratch, "scratch_root", lambda: scratch_root)
    monkeypatch.setattr(scratch, "file", temp_file)
    return speech_sources.SpeechConfig(directory)


def test_import_clip_copies_bytes_and_records_provenance(cfg, tmp_path, monkeypatch):
    source = tmp_path / "render.mp3"
    source.write_bytes(b"ID3sample")
    monkeypatch.setattr(speech_sources, "_source_row",
                        lambda path: {"ref": Path(path).name,
                                      "provenance": speech_sources._read_source_meta(path).get(
                                          "provenance")})

    row = speech_sources.import_clip(cfg, source, "Sample Scene", provenance="scene")
    destination = cfg.training_dir / "Sample_Scene.mp3"
    assert row == {"ref": destination.name, "provenance": "scene"}
    assert destination.read_bytes() == b"ID3sample"
    assert speech_sources._read_source_meta(destination)["provenance"] == "scene"
    assert source.read_bytes() == b"ID3sample"


def test_source_paths_are_flat_and_audio_only(cfg):
    source = cfg.training_dir / "Sample_Clip.mp3"
    source.write_bytes(b"ID3sample")
    (cfg.training_dir / "notes.txt").write_text("not audio", encoding="utf-8")

    assert speech_sources.source_path(cfg, "Sample_Clip.mp3") == source
    for ref in ("../Sample_Clip.mp3", "sub/Sample_Clip.mp3", "notes.txt", ""):
        assert speech_sources.source_path(cfg, ref) is None


def test_rename_and_delete_keep_sidecars_with_the_clip(cfg, monkeypatch):
    source = cfg.training_dir / "Old_Name.mp3"
    source.write_bytes(b"ID3sample")
    source.with_name(source.name + ".yaml").write_text(
        "provenance: uploaded\n", encoding="utf-8")
    monkeypatch.setattr(speech_sources, "_source_row", lambda path: {"ref": Path(path).name})

    renamed = speech_sources.rename_source(cfg, source.name, "New Name")
    destination = cfg.training_dir / "New_Name.mp3"
    sidecar = cfg.training_dir / "New_Name.mp3.yaml"
    assert renamed["ref"] == destination.name
    assert destination.read_bytes() == b"ID3sample"
    assert yaml.safe_load(sidecar.read_text(encoding="utf-8")) == {"provenance": "uploaded"}
    assert speech_sources.delete_sources(cfg, [destination.name, "../outside.mp3"]) == [
        destination.name]
    assert not destination.exists() and not sidecar.exists()


def test_rename_refuses_an_orphaned_destination_sidecar(cfg):
    source = cfg.training_dir / "Old_Name.mp3"
    source.write_bytes(b"ID3sample")
    source.with_name(source.name + ".yaml").write_text(
        "provenance: uploaded\n", encoding="utf-8")
    destination_sidecar = cfg.training_dir / "New_Name.mp3.yaml"
    destination_sidecar.write_text("provenance: scene\n", encoding="utf-8")

    with pytest.raises(FileExistsError):
        speech_sources.rename_source(cfg, source.name, "New Name")

    assert source.read_bytes() == b"ID3sample"
    assert yaml.safe_load(source.with_name(source.name + ".yaml").read_text(
        encoding="utf-8")) == {"provenance": "uploaded"}
    assert yaml.safe_load(destination_sidecar.read_text(encoding="utf-8")) == {
        "provenance": "scene"}


def test_audio_rename_failure_restores_the_original_sidecar(cfg, monkeypatch):
    source = cfg.training_dir / "Old_Name.mp3"
    source.write_bytes(b"ID3sample")
    source_sidecar = source.with_name(source.name + ".yaml")
    source_sidecar.write_text("provenance: uploaded\n", encoding="utf-8")
    real_rename = lambda src, dst: Path(src).rename(dst)

    def fail_audio_rename(src, dst):
        if Path(src) == source:
            raise OSError("injected audio rename failure")
        return real_rename(src, dst)

    monkeypatch.setattr(vault_fs, "rename", fail_audio_rename)
    with pytest.raises(OSError, match="injected audio rename failure"):
        speech_sources.rename_source(cfg, source.name, "New Name")

    assert source.read_bytes() == b"ID3sample"
    assert yaml.safe_load(source_sidecar.read_text(encoding="utf-8")) == {
        "provenance": "uploaded"}
    assert not (cfg.training_dir / "New_Name.mp3").exists()
    assert not (cfg.training_dir / "New_Name.mp3.yaml").exists()
