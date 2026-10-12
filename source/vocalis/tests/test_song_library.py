"""Focused tests for the retained song shelf shared by ACE-Step and Stems."""
from __future__ import annotations

import contextlib
import io
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

import scratch
import song_library
import stems
import vault_fs


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    songs = tmp_path / "uploads"
    acestep = tmp_path / "acestep"
    acelib = tmp_path / "acelib"
    for directory in (songs, acestep, acelib):
        directory.mkdir()

    monkeypatch.setattr(vault_fs, "exists", lambda path: Path(path).exists())
    monkeypatch.setattr(vault_fs, "is_dir", lambda path: Path(path).is_dir())
    monkeypatch.setattr(vault_fs, "listdir", lambda path: os.listdir(path))
    monkeypatch.setattr(vault_fs, "stat", lambda path: _stat(Path(path)))
    monkeypatch.setattr(vault_fs, "read_text", lambda path: Path(path).read_text(encoding="utf-8"))
    monkeypatch.setattr(vault_fs, "write_yaml_atomic",
                        lambda path, value: Path(path).write_text(
                            yaml.safe_dump(value, sort_keys=False), encoding="utf-8"))
    monkeypatch.setattr(vault_fs, "mkdir", lambda path: Path(path).mkdir(parents=True, exist_ok=True))
    monkeypatch.setattr(vault_fs, "from_scratch", lambda src, dst: shutil.copyfile(src, dst))
    monkeypatch.setattr(vault_fs, "unlink", lambda path, missing_ok=False:
                        Path(path).unlink(missing_ok=missing_ok))

    scratch_root = tmp_path / "scratch"
    scratch_root.mkdir()

    @contextlib.contextmanager
    def temp_file(_root, label, suffix):
        path = scratch_root / f"{label.replace('|', '-')}{suffix}"
        try:
            yield path
        finally:
            path.unlink(missing_ok=True)

    monkeypatch.setattr(scratch, "scratch_root", lambda: scratch_root)
    monkeypatch.setattr(scratch, "file", temp_file)
    monkeypatch.setattr(stems, "record_song_id", lambda *_args: None)

    return song_library.SongConfig(songs, acestep, acelib, tmp_path / "cache" / "song_ids.yaml")


def _stat(path: Path):
    try:
        value = path.stat()
    except FileNotFoundError:
        return None
    return SimpleNamespace(size=value.st_size, mtime=value.st_mtime)


def test_song_sources_list_titles_favorites_and_order(cfg, monkeypatch):
    first = cfg.songs_dir / "first.mp3"
    second = cfg.acestep_dir / "second.wav"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    (first.with_suffix(".yaml")).write_text("title: First title\nfavorite: true\n", encoding="utf-8")
    os.utime(first, (10, 10))
    os.utime(second, (20, 20))
    monkeypatch.setattr(song_library, "_acelib_rows", lambda _cfg: [])

    rows = song_library.list_songs(cfg)
    assert [(row["ref"], row["name"], row["favorite"]) for row in rows] == [
        ("acestep/second.wav", "second", False),
        ("uploads/first.mp3", "First title", True),
    ]


def test_song_path_and_resolve_reject_nonleaf_references(cfg):
    source = cfg.songs_dir / "Sample_Track.mp3"
    source.write_bytes(b"audio")
    (source.with_suffix(".yaml")).write_text("title: Sample Track\n", encoding="utf-8")

    assert song_library.song_path(cfg, "uploads/Sample_Track.mp3") == source
    resolved = song_library.resolve_song(cfg, "uploads/Sample_Track.mp3")
    assert (resolved.kind, resolved.name, resolved.path) == ("song", "Sample Track", source)
    for ref in ("uploads/../Sample_Track.mp3", "uploads/sub/file.mp3", "other/Sample_Track.mp3"):
        assert song_library.song_path(cfg, ref) is None
        assert song_library.resolve_song(cfg, ref) is None


def test_upload_uses_content_identity_and_favorite_updates_sidecar(cfg):
    row = song_library.save_upload(cfg, "A Sample Track.mp3", io.BytesIO(b"audio-bytes"))
    path = song_library.song_path(cfg, row["ref"])
    assert path is not None and path.read_bytes() == b"audio-bytes"
    assert path.name.startswith("A_Sample_Track_")

    second = song_library.save_upload(cfg, "A Sample Track.mp3", io.BytesIO(b"audio-bytes"))
    assert second["ref"] == row["ref"]
    assert song_library.set_song_favorite(cfg, row["ref"], True) is True
    assert song_library.list_songs(cfg)[0]["favorite"] is True
