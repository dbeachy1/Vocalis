"""Encrypted storage for reusable Create-a-voice form templates.

Templates store the prompt, sample text, and quality steps. Loading a template populates the
form without starting generation. Language is not stored separately because its preset is already
represented by the resulting prompt and sample text.

The store is routed through the vault. Mutations read and write the complete file under one lock;
without an in-memory cache, a locked vault fails before any state can be overwritten. The list is
small enough that reading it for each mutation is inexpensive.
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

#: Bounds on what one template may hold. Not policy — a guard on a store that is read whole on
#: every mutation, so one pasted novel would make every save slow for good.
MAX_NAME = 120
MAX_TEXT = 20000
MAX_TEMPLATES = 500


class TemplateStoreCorrupt(RuntimeError):
    """The file exists but does not contain a template list; preserve it rather than overwrite it."""


# Mutations read and rewrite the complete file, so one lock prevents concurrent updates from
# overwriting each other.
_LOCK = threading.RLock()


@dataclass
class VoiceTemplate:
    """One saved Create-a-voice form.

    `used` is the count in the picker's option text. Its job is to answer "which of these thirty
    do I actually reach for", which name and date cannot — the same reason the instruction
    library carries one."""

    id: str
    name: str
    prompt: str = ""            # #vcPrompt — the description
    sample_text: str = ""       # #vcSample — the words it speaks
    steps: int = 30             # #vcSteps
    favorite: bool = False
    used: int = 0
    created_at: float = dc_field(default_factory=lambda: time.time())
    updated_at: float = dc_field(default_factory=lambda: time.time())

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "prompt": self.prompt,
                "sample_text": self.sample_text, "steps": self.steps,
                "favorite": self.favorite, "used": self.used,
                "created_at": self.created_at, "updated_at": self.updated_at}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VoiceTemplate:
        return cls(id=str(d["id"]), name=str(d.get("name") or ""),
                   prompt=str(d.get("prompt") or ""),
                   sample_text=str(d.get("sample_text") or ""),
                   steps=int(d.get("steps") or 30),
                   # 9.8 — `favourite` is the pre-sweep key. See acelib.from_dict.
                   favorite=bool(d.get("favorite", d.get("favourite"))),
                   used=int(d.get("used") or 0),
                   created_at=float(d.get("created_at") or 0.0),
                   updated_at=float(d.get("updated_at") or 0.0))


def _path() -> Path:
    """Resolve per call so changing the install root does not leave a stale cached path."""
    return paths.VOICE_TEMPLATES


def _read() -> list[VoiceTemplate]:
    """The list, or `[]` when it has never been written.

    An absent file means no templates have been saved. Corrupt data and a locked vault raise so
    those states are not mistaken for an empty library."""
    p = _path()
    if not vault_fs.exists(p):
        return []
    try:
        data = json.loads(vault_fs.read_text(p))
    except ValueError as exc:
        raise TemplateStoreCorrupt(f"{p.name}: not JSON ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("templates"), list):
        raise TemplateStoreCorrupt(f"{p.name}: not a voice-template library")
    out = []
    for d in data["templates"]:
        if isinstance(d, dict) and d.get("id"):
            out.append(VoiceTemplate.from_dict(d))
    return out


def _write(items: list[VoiceTemplate]) -> None:
    vault_fs.write_json_atomic(_path(), {"templates": [t.to_dict() for t in items]}, indent=2)


def list_templates() -> list[VoiceTemplate]:
    """Every template, FAVORITES FIRST then by name.

    The server returns favorites first and then sorts by name. The client may re-sort by name or
    creation date; favorite status does not filter the list or alter name comparison."""
    items = _read()
    items.sort(key=lambda t: (not t.favorite, t.name.lower(), t.created_at))
    return items


def get(tpl_id: str) -> VoiceTemplate:
    for t in _read():
        if t.id == tpl_id:
            return t
    raise KeyError(tpl_id)


def add(*, name: str, prompt: str = "", sample_text: str = "", steps: int = 30) -> VoiceTemplate:
    """Append a new template with a unique ID. Names need not be unique; editing uses a separate
    operation so saving another template never overwrites an existing one."""
    with _LOCK:
        items = _read()
        if len(items) >= MAX_TEMPLATES:
            raise ValueError(f"that is {MAX_TEMPLATES} templates — delete some first")
        t = VoiceTemplate(id=uuid4().hex[:12], name=name[:MAX_NAME],
                          prompt=prompt[:MAX_TEXT], sample_text=sample_text[:MAX_TEXT],
                          steps=int(steps))
        items.append(t)
        _write(items)
        return t


def update(tpl_id: str, **fields) -> VoiceTemplate:
    """Edit name / prompt / sample_text / steps / favorite. Unknown keys are REFUSED rather than
    ignored — a typo that silently does nothing is a bug report about the UI not saving."""
    allowed = {"name", "prompt", "sample_text", "steps", "favorite"}
    bad = set(fields) - allowed
    if bad:
        raise ValueError(f"not a template field: {sorted(bad)}")
    with _LOCK:
        items = _read()
        for t in items:
            if t.id == tpl_id:
                for k, v in fields.items():
                    if k == "steps":
                        v = int(v)
                    elif k == "favorite":
                        v = bool(v)
                    else:
                        v = str(v)[:(MAX_NAME if k == "name" else MAX_TEXT)]
                    setattr(t, k, v)
                t.updated_at = time.time()
                _write(items)
                return t
    raise KeyError(tpl_id)


def delete(tpl_id: str) -> None:
    with _LOCK:
        items = _read()
        kept = [t for t in items if t.id != tpl_id]
        if len(kept) == len(items):
            raise KeyError(tpl_id)
        _write(kept)


def note_used(tpl_id: str) -> None:
    """Bump the usage count. Silently does nothing for a template that has since been deleted —
    loading one and finding it gone is a race with another tab, not an error worth a dialog."""
    with _LOCK:
        items = _read()
        for t in items:
            if t.id == tpl_id:
                t.used += 1
                _write(items)
                return
