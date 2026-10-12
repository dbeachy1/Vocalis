"""Speech clip storage shared by Speech, Cleanup, Scenes, and Stems imports."""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

import enhance as enhance_mod
import scratch
import stems
import vault_fs
import yaml
from book_to_audio import safe_name
from loguru import logger
from tts_utils import ffprobe_duration, source_stat
from vault import VaultError

# What reading or writing a clip's YAML sidecar can raise short of a bug: OSError (unreadable,
# vanished or unwritable), ValueError (undecodable bytes), YAMLError (corrupt document or an
# unrepresentable value) and VaultError (locked vault). VaultAuthError is a BaseException and
# deliberately passes through these handlers.
_SIDECAR_ERRORS = (OSError, ValueError, yaml.YAMLError, VaultError)

PROVENANCE = {"uploaded", "playground", "stems", "cleaned", "scene"}


@dataclass
class SpeechConfig:
    """The user-managed clip directory shared by Speech and Cleanup."""
    training_dir: Path


class SourceSidecarUnreadable(Exception):
    """A corrupt clip sidecar that a writer must preserve rather than replace."""


def _source_meta_path(path: Path) -> Path:
    return path.with_name(path.name + ".yaml")


def _read_source_meta(path: Path, *, strict: bool = False) -> dict:
    sidecar = _source_meta_path(path)
    if not vault_fs.exists(sidecar):
        return {}
    try:
        value = yaml.safe_load(vault_fs.read_text(sidecar)) or {}
        return value if isinstance(value, dict) else {}
    except _SIDECAR_ERRORS as exc:
        logger.warning("speech clip sidecar unreadable — ignoring it (%s)", type(exc).__name__)
        if strict:
            raise SourceSidecarUnreadable(str(exc)) from exc
        return {}


def _write_source_meta(path: Path, metadata: dict) -> None:
    try:
        vault_fs.write_yaml_atomic(_source_meta_path(path), metadata)
    except _SIDECAR_ERRORS as exc:
        logger.warning("could not write speech clip sidecar (%s)", type(exc).__name__)


def _set_provenance(path: Path, provenance: str) -> None:
    if provenance in PROVENANCE:
        _write_source_meta(path, {**_read_source_meta(path), "provenance": provenance})


def _record_enhanced(path: Path, cached: Path, nfe: int, trim) -> None:
    try:
        metadata = _read_source_meta(path, strict=True)
    except SourceSidecarUnreadable:
        logger.warning("speech clip sidecar unreadable; keeping existing metadata")
        return
    identity = source_stat(path)
    identity_fields = ({"enhanced_size": identity[0], "enhanced_mtime": identity[1]}
                       if identity else {})
    _write_source_meta(path, {**metadata, "enhanced": str(cached),
                              "enhanced_nfe": int(nfe),
                              "enhanced_trim": int(trim) if trim else 0,
                              **identity_fields})


def duration_of(path, metadata: dict | None = None) -> tuple:
    """Reuse duration only when vault-aware size and modification time still match."""
    identity = source_stat(path)
    if identity is None:
        return 0.0, {}
    size, mtime = identity
    metadata = metadata or {}
    if (metadata.get("duration_s") is not None
            and metadata.get("duration_size") == size
            and int(metadata.get("duration_mtime") or -1) == mtime):
        return float(metadata["duration_s"]), {}
    duration = ffprobe_duration(path)
    return duration, {"duration_s": duration, "duration_size": size,
                      "duration_mtime": mtime}


def _source_row(path: Path) -> dict:
    stat = vault_fs.stat(path)
    if stat is None:
        raise FileNotFoundError(str(path))
    try:
        metadata = _read_source_meta(path, strict=True)
        readable = True
    except SourceSidecarUnreadable:
        metadata, readable = {}, False
    bandwidth, bandwidth_fields = enhance_mod.bandwidth_of(path, metadata)
    duration, duration_fields = duration_of(path, metadata)
    fresh = {**(bandwidth_fields or {}), **(duration_fields or {})}
    if fresh and readable:
        _write_source_meta(path, {**metadata, **fresh})

    enhanced = str(metadata.get("enhanced") or "")
    enhanced_size, enhanced_mtime = metadata.get("enhanced_size"), metadata.get("enhanced_mtime")
    identity = source_stat(path)
    current_enhanced = (enhanced_size is None or enhanced_mtime is None or identity is None
                        or (int(enhanced_size) == identity[0]
                            and int(enhanced_mtime) == identity[1]))
    return {
        "ref": path.name, "name": path.stem, "size": stat.size,
        "mtime": stat.mtime, "duration_s": duration,
        "bandwidth_hz": bandwidth, "provenance": metadata.get("provenance"),
        "cleaned_from": metadata.get("cleaned_from"),
        "cleanup": metadata.get("cleanup"),
        "band_limited": enhance_mod.is_band_limited(bandwidth),
        "enhanced_ready": bool(enhanced and current_enhanced and vault_fs.exists(enhanced)),
        "enhanced_nfe": metadata.get("enhanced_nfe"),
        "enhanced_trim": int(metadata.get("enhanced_trim") or 0),
    }


def list_sources(cfg: SpeechConfig) -> list:
    directory = Path(cfg.training_dir)
    if not vault_fs.is_dir(directory):
        return []
    rows = []
    for name in vault_fs.listdir(directory):
        path = directory / name
        if path.suffix.lower() in stems.AUDIO_EXTS and not vault_fs.is_dir(path):
            rows.append(_source_row(path))
    rows.sort(key=lambda row: row["mtime"], reverse=True)
    return rows


def source_path(cfg: SpeechConfig, ref: str):
    name = str(ref or "")
    if not name or Path(name).name != name:
        return None
    path = Path(cfg.training_dir) / name
    return path if vault_fs.exists(path) and path.suffix.lower() in stems.AUDIO_EXTS else None


def save_upload(cfg: SpeechConfig, filename: str, stream, overwrite: bool = False) -> dict:
    name = Path(str(filename or "")).name
    extension = Path(name).suffix.lower()
    if not name or extension not in stems.AUDIO_EXTS:
        raise ValueError(f"not an audio file: {filename!r} "
                         f"(accepted: {', '.join(sorted(stems.AUDIO_EXTS))})")
    directory = Path(cfg.training_dir)
    vault_fs.mkdir(directory)
    destination = directory / name
    if vault_fs.exists(destination) and not overwrite:
        raise FileExistsError(name)
    _set_provenance(destination, "uploaded")
    with scratch.file(scratch.scratch_root(), f"training-upload|{name}", extension) as temporary:
        with open(temporary, "wb") as output:
            shutil.copyfileobj(stream, output)
        vault_fs.from_scratch(temporary, destination)
    return _source_row(destination)


def import_clip(cfg: SpeechConfig, mp3: Path, display_name: str,
                overwrite: bool = False, provenance: str = None) -> dict:
    if not vault_fs.exists(mp3):
        raise ValueError("clip file not found")
    directory = Path(cfg.training_dir)
    vault_fs.mkdir(directory)
    destination = directory / f"{safe_name(display_name or Path(mp3).stem, 60)}.mp3"
    if vault_fs.exists(destination) and not overwrite:
        raise FileExistsError(destination.name)
    _set_provenance(destination, provenance)
    with scratch.file(scratch.scratch_root(), f"training-import|{destination.name}", ".mp3") as temporary:
        with vault_fs.open_read(mp3) as source, open(temporary, "wb") as output:
            shutil.copyfileobj(source, output)
        vault_fs.from_scratch(temporary, destination)
    return _source_row(destination)


def rename_source(cfg: SpeechConfig, ref: str, new_name: str) -> dict:
    path = source_path(cfg, ref)
    if path is None:
        raise ValueError(f"speech clip not found: {ref}")
    raw_name = str(new_name or "").strip()
    if not raw_name:
        raise ValueError("the name can't be empty")
    destination = path.with_name(safe_name(raw_name, 60) + path.suffix)
    if destination == path:
        return _source_row(path)
    source_meta = _source_meta_path(path)
    destination_meta = _source_meta_path(destination)
    if vault_fs.exists(destination) or vault_fs.exists(destination_meta):
        raise FileExistsError(destination.name)
    moved_meta = vault_fs.exists(source_meta)
    if moved_meta:
        vault_fs.rename(source_meta, destination_meta)
    try:
        vault_fs.rename(path, destination)
    except BaseException:
        if moved_meta:
            try:
                vault_fs.rename(destination_meta, source_meta)
            except BaseException as rollback_error:
                logger.error("could not restore Speech sidecar after a failed rename (%s)",
                             type(rollback_error).__name__)
        raise
    return _source_row(destination)


def delete_sources(cfg: SpeechConfig, refs: list) -> list:
    deleted = []
    for ref in refs:
        path = source_path(cfg, str(ref))
        if path is not None:
            vault_fs.unlink(path)
            vault_fs.unlink(_source_meta_path(path), missing_ok=True)
            deleted.append(str(ref))
    return deleted
