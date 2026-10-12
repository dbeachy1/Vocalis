"""Persist ACE-Step songs and their rendered settings in the vault-backed library.

Candidates remain on the backend until a user saves them; saving is the point where Vocalis takes
ownership of the audio. The index records the template identity, submitted settings, and backend
rendered metadata separately so the library can restore what was requested and what was produced.
Audio and index records use `vault_fs` because lyrics, titles, and audio are user content.
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

MAX_NAME = 200
MAX_SONGS = 5000

_LOCK = threading.RLock()


class LibraryCorrupt(RuntimeError):
    """The index exists and is not a song library. Raised rather than healed — writing over it
    loses every row, so the corrupt file is preserved for diagnosis."""


@dataclass
class Song:
    id: str
    name: str
    template_id: str | None = None      # the FILTER (§4.5.3), never the source of truth
    caption: str = ""                   # what it was ACTUALLY rendered from
    lyrics: str = ""
    model: str = ""
    seed: int | None = None
    device: str = ""
    favorite: bool = False
    created_at: float = dc_field(default_factory=lambda: time.time())
    #: The §4.5.2 song identity as submitted, and the Advanced knobs as the user set them.
    #: `None` (not `{}`) on a row from before 8.0-m9 — see the header.
    template: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None
    #: Caption, lyrics, and metadata reported by the backend after rendering. The request fields
    #: above remain the basis for template comparison; this records the resulting render.
    #: `None` means the row predates this field; an empty dict means the backend returned no data.
    rendered: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "template_id": self.template_id,
                "caption": self.caption, "lyrics": self.lyrics, "model": self.model,
                "seed": self.seed, "device": self.device, "favorite": self.favorite,
                "created_at": self.created_at,
                "template": self.template, "settings": self.settings,
                "rendered": self.rendered}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Song:
        try:
            seed = int(d["seed"]) if d.get("seed") is not None else None
        except (TypeError, ValueError):
            seed = None
        # Preserve empty dictionaries: they mean settings were recorded with all defaults,
        # whereas None means the row predates settings capture.
        tpl, st = d.get("template"), d.get("settings")
        rend = d.get("rendered")
        return cls(id=str(d["id"]), name=str(d.get("name") or ""),
                   template_id=d.get("template_id") or None,
                   caption=str(d.get("caption") or ""), lyrics=str(d.get("lyrics") or ""),
                   model=str(d.get("model") or ""), seed=seed,
                   # Read both spellings for compatibility; writes use the US-English key.
                   device=str(d.get("device") or ""),
                   favorite=bool(d.get("favorite", d.get("favourite"))),
                   created_at=float(d.get("created_at") or 0.0),
                   template=tpl if isinstance(tpl, dict) else None,
                   settings=st if isinstance(st, dict) else None,
                   rendered=rend if isinstance(rend, dict) else None)


def _index() -> Path:
    return paths.ACE_LIBRARY


def _audio_dir() -> Path:
    return paths.ACE_LIBRARY_AUDIO


def audio_path(song_id: str) -> Path:
    """Where one song's FLAC lives. ⚠️ The id, not the name: a title is user text and would put
    slashes, quotes and unicode into a filename that the vault then has to route."""
    return _audio_dir() / f"{song_id}.flac"


def _read() -> list[Song]:
    p = _index()
    if not vault_fs.exists(p):
        return []
    try:
        data = json.loads(vault_fs.read_text(p))
    except ValueError as exc:
        raise LibraryCorrupt(f"{p.name}: not JSON ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("songs"), list):
        raise LibraryCorrupt(f"{p.name}: not a song library")
    return [Song.from_dict(d) for d in data["songs"] if isinstance(d, dict) and d.get("id")]


def _write(items: list[Song]) -> None:
    vault_fs.write_json_atomic(_index(), {"songs": [s.to_dict() for s in items]}, indent=2)


def list_songs(template_id: str | None = None) -> list[Song]:
    """Newest first. `template_id` narrows to the songs made from that template (§4.5.3)."""
    with _LOCK:
        items = sorted(_read(), key=lambda s: -s.created_at)
    if template_id:
        items = [s for s in items if s.template_id == template_id]
    return items


def save(audio_bytes: bytes, *, name: str, template_id: str | None = None, caption: str = "",
         lyrics: str = "", model: str = "", seed: int | None = None, device: str = "",
         template: dict | None = None, settings: dict | None = None,
         rendered: dict | None = None) -> Song:
    """Store a finished song, writing the audio before adding its index row.

    If interrupted between writes, this order leaves an unindexed file rather than a broken
    library entry whose audio is missing.
    """
    with _LOCK:
        items = _read()
        if len(items) >= MAX_SONGS:
            raise ValueError(f"the song library is full ({MAX_SONGS})")
        song = Song(id=uuid4().hex, name=str(name or "Untitled")[:MAX_NAME],
                    template_id=template_id or None, caption=caption, lyrics=lyrics,
                    model=model, seed=seed, device=device,
                    template=dict(template) if isinstance(template, dict) else None,
                    settings=dict(settings) if isinstance(settings, dict) else None,
                    rendered=dict(rendered) if isinstance(rendered, dict) else None)
        vault_fs.mkdir(_audio_dir())
        vault_fs.write_bytes(audio_path(song.id), audio_bytes)
        items.append(song)
        _write(items)
        return song


def update(song_id: str, **fields) -> Song | None:
    with _LOCK:
        items = _read()
        for s in items:
            if s.id == song_id:
                if "name" in fields:
                    s.name = str(fields["name"] or "")[:MAX_NAME]
                if "favorite" in fields:
                    s.favorite = bool(fields["favorite"])
                _write(items)
                return s
        return None


def delete(song_id: str) -> bool:
    """Remove the index row before deleting audio so interruption leaves only an orphan file."""
    with _LOCK:
        items = _read()
        kept = [s for s in items if s.id != song_id]
        if len(kept) == len(items):
            return False
        _write(kept)
        try:
            vault_fs.unlink(audio_path(song_id))
        except OSError:
            pass                      # an orphan file is findable; a missing song is not
        return True


def to_opus(flac_path: Path, bitrate: str = None) -> bytes:
    """Encode a stored song as Opus and return the bytes without leaving a durable copy.

    Use the shared Opus settings and decrypt the source through `vault_fs.child_input`; ffmpeg
    cannot read the encrypted vault file directly.
    """
    import subprocess

    import scratch as scratch_mod
    import vault_fs
    from tts_utils import OPUS_BITRATE

    root = scratch_mod.scratch_root()
    with vault_fs.child_input(flac_path, root) as src, \
            scratch_mod.file(root, f"ace_opus|{flac_path.name}", ".opus") as tmp:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-vn",
             "-c:a", "libopus", "-b:a", str(bitrate or OPUS_BITRATE), "-vbr", "on",
             "-application", "audio", str(tmp), "-loglevel", "warning"],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg could not encode {flac_path.name}: {r.stderr.strip()}")
        # Read the encoded bytes before the scratch context removes the temporary file.
        return tmp.read_bytes()
