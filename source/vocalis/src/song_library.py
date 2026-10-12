"""Retained song shelf shared by ACE-Step and Stems."""
from __future__ import annotations

import re
import shutil
import os
from dataclasses import dataclass
from pathlib import Path

import yaml
from loguru import logger

import scratch
import stems
import vault_fs
from book_to_audio import safe_name
from vault import VaultError

# What reading a song's YAML sidecar can raise short of a bug: OSError (unreadable or vanished),
# ValueError (undecodable bytes), YAMLError (corrupt document) and VaultError (locked vault).
# VaultAuthError is a BaseException and deliberately passes through these handlers.
_SIDECAR_ERRORS = (OSError, ValueError, yaml.YAMLError, VaultError)

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"}
_SONG_RE = re.compile(r"(acestep|uploads|acelib)/([^/\\]+)\Z")


@dataclass
class SongConfig:
    """Paths used by the retained song shelf and Stems source picker."""
    songs_dir: Path
    acestep_dir: Path
    acelib_dir: Path | None
    song_index: Path


@dataclass
class SongSource:
    """Resolved song identity used by Stems splitting."""
    kind: str
    ref: str
    name: str
    path: Path


def resolve_config(app_settings: dict, base_dir: Path, cache_dir: Path) -> SongConfig:
    """Resolve existing song path settings with environment precedence."""
    settings = (app_settings or {}).get("voiceswap") or {}

    def pick(env_key: str, settings_key: str, default: Path) -> Path:
        return Path(os.environ.get(env_key) or settings.get(settings_key) or default)

    from vocalis.runtime import paths
    return SongConfig(
        songs_dir=pick("VOCALIS_SONGS_DIR", "songs_dir", Path(base_dir) / "uploads" / "songs"),
        acestep_dir=pick("VOCALIS_ACESTEP_DIR", "acestep_dir", Path("/ai-output/acestep")),
        acelib_dir=Path(paths.ACE_LIBRARY_AUDIO),
        song_index=Path(cache_dir) / "song_ids.yaml",
    )


def _song_row(path: Path, source: str) -> dict:
    st = vault_fs.stat(path)
    title, favorite = None, False
    sidecar = path.with_suffix(".yaml")
    if vault_fs.exists(sidecar):
        try:
            data = yaml.safe_load(vault_fs.read_text(sidecar))
            if isinstance(data, dict):
                title, favorite = data.get("title"), bool(data.get("favorite"))
        except _SIDECAR_ERRORS as exc:
            logger.warning("song sidecar {} unreadable, showing the file name ({})", sidecar.name, type(exc).__name__)
            title = None
    return {"ref": f"{source}/{path.name}", "name": str(title or path.stem),
            "source": source, "size": st.size if st else 0,
            "mtime": st.mtime if st else 0, "favorite": favorite}


def _acelib_index():
    try:
        from vocalis.runtime import acelib
        return {song.id: song for song in acelib.list_songs()}
    except BaseException:  # locked vault errors are not all Exception subclasses
        return None


def _acelib_rows(cfg: SongConfig) -> list:
    if cfg.acelib_dir is None:
        return []
    directory = Path(cfg.acelib_dir)
    metadata = _acelib_index()
    if metadata is None or not vault_fs.is_dir(directory):
        return []
    rows = []
    for name in vault_fs.listdir(directory):
        path = directory / name
        song = metadata.get(path.stem)
        if song is None or path.suffix.lower() not in AUDIO_EXTS or vault_fs.is_dir(path):
            continue
        stat = vault_fs.stat(path)
        rows.append({"ref": f"acelib/{path.name}", "name": song.name,
                     "source": "acelib", "size": stat.size if stat else 0,
                     "mtime": stat.mtime if stat else song.created_at,
                     "seed": song.seed, "favorite": bool(song.favorite)})
    return rows


def list_songs(cfg: SongConfig) -> list:
    """List uploaded, ACE-Step, and indexed ACE library songs newest first."""
    rows = []
    for directory, source in ((cfg.songs_dir, "uploads"), (cfg.acestep_dir, "acestep")):
        directory = Path(directory)
        if not vault_fs.is_dir(directory):
            continue
        for name in vault_fs.listdir(directory):
            path = directory / name
            if path.suffix.lower() in AUDIO_EXTS and not vault_fs.is_dir(path):
                rows.append(_song_row(path, source))
    rows.extend(_acelib_rows(cfg))
    rows.sort(key=lambda row: row["mtime"], reverse=True)
    return rows


def song_path(cfg: SongConfig, ref: str):
    """Resolve a flat song reference without permitting path traversal."""
    match = _SONG_RE.fullmatch(str(ref or ""))
    if not match:
        return None
    source, name = match.groups()
    base = (getattr(cfg, "acelib_dir", None) if source == "acelib" else
            cfg.acestep_dir if source == "acestep" else cfg.songs_dir)
    if base is None:
        return None
    path = Path(base) / name
    return path if vault_fs.exists(path) and path.suffix.lower() in AUDIO_EXTS else None


def resolve_song(cfg: SongConfig, ref: str):
    """Resolve a retained song reference to the Stems source contract."""
    path = song_path(cfg, ref)
    if path is None:
        return None
    if ref.startswith("acelib/"):
        index = _acelib_index()
        song = index.get(path.stem) if index else None
        name = song.name if song else path.stem
    else:
        name = _song_row(path, "")["name"]
    return SongSource(kind="song", ref=ref, name=name, path=path)


def save_upload(cfg: SongConfig, filename: str, stream) -> dict:
    """Store an uploaded song by a stable content-derived name."""
    name = Path(str(filename or "")).name
    extension = Path(name).suffix.lower()
    if not name or extension not in AUDIO_EXTS:
        raise ValueError(f"not an audio file: {filename!r} "
                         f"(accepted: {', '.join(sorted(AUDIO_EXTS))})")
    directory = Path(cfg.songs_dir)
    vault_fs.mkdir(directory)
    with scratch.file(scratch.scratch_root(), f"song-upload|{name}", extension) as temporary:
        with open(temporary, "wb") as output:
            shutil.copyfileobj(stream, output)
        digest = stems.song_hash(temporary)
        destination = directory / f"{safe_name(Path(name).stem, 48)}_{digest[:8]}{extension}"
        if not vault_fs.exists(destination):
            vault_fs.from_scratch(temporary, destination)
        stems.record_song_id(cfg, destination, digest)
    return _song_row(destination, "uploads")


def set_song_favorite(cfg: SongConfig, ref: str, favorite: bool):
    path = song_path(cfg, ref)
    if path is None:
        return None
    value = bool(favorite)
    if ref.startswith("acelib/"):
        from vocalis.runtime import acelib
        song = acelib.update(path.stem, favorite=value)
        return None if song is None else bool(song.favorite)
    sidecar = path.with_suffix(".yaml")
    try:
        metadata = yaml.safe_load(vault_fs.read_text(sidecar)) or {} if vault_fs.exists(sidecar) else {}
    except _SIDECAR_ERRORS as exc:
        logger.warning("song sidecar {} unreadable, starting a fresh one ({})", sidecar.name, type(exc).__name__)
        metadata = {}
    metadata["favorite"] = value
    vault_fs.write_yaml_atomic(sidecar, metadata)
    return value
