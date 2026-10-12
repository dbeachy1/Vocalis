"""Persist ACE-Step song templates in the vault-backed store.

A template contains song identity and source references, not render settings or
a per-job seed. References remain stable tokens and are resolved to temporary
paths only for dispatch. Mutations read and atomically rewrite the complete
list under one lock; reads from a locked vault propagate rather than appearing
as an empty library.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any
from uuid import uuid4

import vault_fs

from . import paths

#: Input bounds. The store is read and rewritten as a whole on each mutation.
MAX_NAME = 120
MAX_LYRICS = 8000
MAX_CAPTION = 2000
MAX_TEMPLATES = 500


class TemplateStoreCorrupt(RuntimeError):
    """The store exists but does not contain a valid template list."""


# Serialize whole-file read-modify-write operations to prevent lost updates.
_LOCK = threading.RLock()


@dataclass
class SongTemplate:
    """One saved song: the words and the musical identity, never the render settings."""

    id: str
    name: str                        # Display name.
    caption: str = ""                # "alternative metal, hard rock" — the style description
    global_caption: str = ""         # song-level caption for SFT-stems lego tasks
    lyrics: str = ""
    instrumental: bool = False
    bpm: int | None = None
    key_scale: str = ""
    time_signature: str = ""
    vocal_language: str = "en"
    duration: float | None = None    # seconds; None = let the model choose
    # Stable token resolved to a temporary backend path during dispatch.
    reference: str = ""
    # Mode-specific source token; `None` repaint_end means through the song's end.
    mode: str = "custom"
    source: str = ""
    repaint_start: float | None = None
    repaint_end: float | None = None
    cover_strength: float | None = None
    #: Track selections; Extract/Lego use one entry, Complete can use several.
    tracks: list = dc_field(default_factory=list)
    #: Original render seed and variance used by Retake mode; zero variance is a no-op.
    retake_seed: str = ""
    retake_variance: float | None = None
    #: Source description used to compute the flow-edit morph delta.
    edit_from_caption: str = ""
    edit_from_lyrics: str = ""
    favorite: bool = False
    used: int = 0                    # Number of times selected for rendering.
    created_at: float = dc_field(default_factory=lambda: time.time())
    updated_at: float = dc_field(default_factory=lambda: time.time())

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "caption": self.caption,
                "global_caption": self.global_caption, "lyrics": self.lyrics,
                "instrumental": self.instrumental, "bpm": self.bpm,
                "key_scale": self.key_scale, "time_signature": self.time_signature,
                "vocal_language": self.vocal_language, "duration": self.duration,
                "reference": self.reference, "mode": self.mode, "source": self.source,
                "repaint_start": self.repaint_start, "repaint_end": self.repaint_end,
                "cover_strength": self.cover_strength, "tracks": list(self.tracks or []),
                "retake_seed": self.retake_seed, "retake_variance": self.retake_variance,
                "edit_from_caption": self.edit_from_caption,
                "edit_from_lyrics": self.edit_from_lyrics,
                "favorite": self.favorite, "used": self.used,
                "created_at": self.created_at, "updated_at": self.updated_at}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SongTemplate:
        def _num(v, cast):
            # A hand-edited file must not take the whole picker down over one bad field.
            try:
                return cast(v) if v is not None and v != "" else None
            except (TypeError, ValueError):
                return None
        return cls(
            id=str(d["id"]), name=str(d.get("name") or ""),
            caption=str(d.get("caption") or ""),
            global_caption=str(d.get("global_caption") or ""),
            lyrics=str(d.get("lyrics") or ""),
            instrumental=bool(d.get("instrumental")),
            bpm=_num(d.get("bpm"), int),
            key_scale=str(d.get("key_scale") or ""),
            time_signature=str(d.get("time_signature") or ""),
            vocal_language=str(d.get("vocal_language") or "en"),
            duration=_num(d.get("duration"), float),
            reference=str(d.get("reference") or ""),
            mode=str(d.get("mode") or "custom"), source=str(d.get("source") or ""),
            repaint_start=_num(d.get("repaint_start"), float),
            repaint_end=_num(d.get("repaint_end"), float),
            cover_strength=_num(d.get("cover_strength"), float),
            tracks=[str(t) for t in (d.get("tracks") or []) if isinstance(t, (str, int))],
            retake_seed=str(d.get("retake_seed") or ""),
            retake_variance=_num(d.get("retake_variance"), float),
            edit_from_caption=str(d.get("edit_from_caption") or ""),
            edit_from_lyrics=str(d.get("edit_from_lyrics") or ""),
            # Accept the legacy spelling when reading older stored templates.
            favorite=bool(d.get("favorite", d.get("favourite"))),
            used=int(d.get("used") or 0),
            created_at=float(d.get("created_at") or 0.0),
            updated_at=float(d.get("updated_at") or 0.0))


def _path() -> Path:
    """Resolved per call, never pinned at import: the suite repoints the install root per test,
    and a module-level constant would freeze whichever root existed when this first loaded."""
    return paths.ACE_TEMPLATES


def _read() -> list[SongTemplate]:
    """Read the template list, returning empty only when the store does not exist.

    Corrupt data raises `TemplateStoreCorrupt`, and vault access errors propagate
    so a locked vault is not mistaken for an empty library.
    """
    p = _path()
    if not vault_fs.exists(p):
        return []
    try:
        data = json.loads(vault_fs.read_text(p))
    except ValueError as exc:
        raise TemplateStoreCorrupt(f"{p.name}: not JSON ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("templates"), list):
        raise TemplateStoreCorrupt(f"{p.name}: not a song-template library")
    return [SongTemplate.from_dict(d) for d in data["templates"]
            if isinstance(d, dict) and d.get("id")]


def _write(items: list[SongTemplate]) -> None:
    vault_fs.write_json_atomic(_path(), {"templates": [t.to_dict() for t in items]}, indent=2)


def list_templates() -> list[SongTemplate]:
    with _LOCK:
        return _read()


def save(fields: dict[str, Any], template_id: str | None = None) -> SongTemplate:
    """Create or update a template and return the stored row. Partial updates merge
    with the existing row; unknown IDs create a new row.
    """
    with _LOCK:
        items = _read()
        payload = dict(fields)
        # Clamp supplied text fields only; partial updates leave other fields intact.
        for key, cap in (("name", MAX_NAME), ("lyrics", MAX_LYRICS), ("caption", MAX_CAPTION)):
            if key in payload:
                payload[key] = str(payload[key] or "")[:cap]
        now = time.time()
        existing = next((t for t in items if t.id == template_id), None) if template_id else None
        if existing is not None:
            merged = {**existing.to_dict(), **payload,
                      "id": existing.id, "created_at": existing.created_at, "updated_at": now}
            out = SongTemplate.from_dict(merged)
            items = [out if t.id == out.id else t for t in items]
        else:
            if len(items) >= MAX_TEMPLATES:
                raise ValueError(f"the song-template library is full ({MAX_TEMPLATES})")
            payload.update({"id": str(uuid4()), "created_at": now, "updated_at": now})
            out = SongTemplate.from_dict(payload)
            items.append(out)
        _write(items)
        return out


def delete(template_id: str) -> bool:
    with _LOCK:
        items = _read()
        kept = [t for t in items if t.id != template_id]
        if len(kept) == len(items):
            return False
        _write(kept)
        return True


def set_favorite(template_id: str, on: bool) -> bool:
    with _LOCK:
        items = _read()
        for t in items:
            if t.id == template_id:
                t.favorite = bool(on)
                t.updated_at = time.time()
                _write(items)
                return True
        return False


def note_use(template_id: str) -> None:
    """Bump the use count. Deliberately silent on a missing id — this is called on the way into a
    render, and a template deleted in another tab must not fail the song."""
    with _LOCK:
        items = _read()
        for t in items:
            if t.id == template_id:
                t.used += 1
                t.updated_at = time.time()
                _write(items)
                return
