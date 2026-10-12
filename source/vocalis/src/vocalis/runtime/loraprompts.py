"""Parse, compose, and persist reusable LoRA prompt templates.

The identity block is prepended to every prompt, templates are copied before editing, and
the line-oriented text format is shared by upload, editing, and persistence.
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

MAX_NAME = 120
MAX_PROMPT = 4000
MAX_IDENTITY = 1000
MAX_PROMPTS = 500
MAX_TEMPLATES = 200

#: Seeded on first read so the picker has a generic editable starting point. Identity is
#: subject-specific and remains empty until the user provides it.
SEED_TEMPLATE_NAME = "Body — standard"
SEED_PROMPTS = (
    "# One prompt per line. Blank lines and #-comments are ignored.",
    "# The identity block is prepended to every line automatically - do not repeat it here.",
    "full body, standing, jeans and t-shirt, city street, day",
    "full body, walking, summer dress, park path, golden hour",
    "full body, seated on a stool, studio backdrop, soft key light",
    "three-quarter, arms crossed, leather jacket, alley, overcast",
    "three-quarter, leaning against a wall, knitwear, cafe interior, window light",
    "upper body, hands in pockets, coat, station platform, evening",
)


class TemplateStoreCorrupt(RuntimeError):
    """The file exists and is not a template list. Raised rather than healed — see lorasubj."""


_LOCK = threading.RLock()


def parse(text: str) -> list[str]:
    """Prompt lines out of a block of text. Blank lines and `#` comments dropped.

    `#` starts a comment only at the beginning of a line; mid-line hashes remain part of prompts.
    """
    out: list[str] = []
    for raw in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line[:MAX_PROMPT])
    return out[:MAX_PROMPTS]


def render(prompts) -> str:
    """The text form of a prompt list — the inverse of `parse` over the surviving lines.

    Same bytes in the textarea, in a downloaded `.txt`, and in the store, so the CLI runner and
    this screen never disagree about what a prompt set is.
    """
    return "\n".join(str(p).strip() for p in (prompts or []) if str(p).strip())


def compose(identity: str, prompt: str) -> str:
    """One final prompt: the identity block, then the varying part.

    Keep composition centralized so callers cannot omit or duplicate the identity block.
    """
    ident = (identity or "").strip().rstrip(",").strip()
    body = (prompt or "").strip()
    if not ident:
        return body
    if not body:
        return ident
    return f"{ident}, {body}"


def compose_all(identity: str, prompts) -> list[str]:
    """`compose` over the set. What Generate will actually queue."""
    return [compose(identity, p) for p in (prompts or [])]


@dataclass
class PromptTemplate:
    """A named, reusable prompt set. Global — it outlives the subject that created it."""

    id: str
    name: str
    prompts: list = dc_field(default_factory=list)
    #: Optional suggestion for a subject-specific identity block; applying a template does not
    #: overwrite the subject's existing value.
    identity: str = ""
    created_at: float = dc_field(default_factory=lambda: time.time())
    updated_at: float = dc_field(default_factory=lambda: time.time())

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "prompts": list(self.prompts or []),
                "identity": self.identity,
                "created_at": self.created_at, "updated_at": self.updated_at}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PromptTemplate:
        return cls(
            id=str(d.get("id") or uuid4().hex[:12]),
            name=str(d.get("name") or "")[:MAX_NAME],
            prompts=[str(p)[:MAX_PROMPT] for p in (d.get("prompts") or []) if isinstance(p, str)],
            identity=str(d.get("identity") or "")[:MAX_IDENTITY],
            created_at=float(d.get("created_at") or time.time()),
            updated_at=float(d.get("updated_at") or time.time()),
        )


def _path() -> Path:
    return paths.LORA_PROMPT_TEMPLATES


def _read() -> list[PromptTemplate]:
    p = _path()
    if not vault_fs.exists(p):
        return []
    try:
        data = json.loads(vault_fs.read_text(p))
    except json.JSONDecodeError as exc:
        raise TemplateStoreCorrupt(f"{p} is not valid JSON: {exc}") from exc
    items = data.get("templates") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise TemplateStoreCorrupt(f"{p} has no 'templates' list")
    return [PromptTemplate.from_dict(d) for d in items if isinstance(d, dict)]


def _write(items: list[PromptTemplate]) -> None:
    vault_fs.write_json_atomic(_path(), {"templates": [t.to_dict() for t in items]}, indent=2)


def list_templates() -> list[PromptTemplate]:
    """Every template, seeding the standard set on the FIRST read so the picker is never empty.

    Seed after the vault is available. The lock prevents concurrent first reads from creating
    duplicate templates.
    """
    with _LOCK:
        items = _read()
        if not items:
            items = [PromptTemplate(id=uuid4().hex[:12], name=SEED_TEMPLATE_NAME,
                                    prompts=list(SEED_PROMPTS))]
            _write(items)
        return items


def get(template_id: str) -> PromptTemplate | None:
    with _LOCK:
        return next((t for t in list_templates() if t.id == template_id), None)


def save(name: str, prompts, identity: str = "", template_id: str = "") -> PromptTemplate:
    """Create, or overwrite by id. Returns what was stored."""
    with _LOCK:
        items = list_templates()
        clean = [str(p).strip()[:MAX_PROMPT] for p in (prompts or []) if str(p).strip()][:MAX_PROMPTS]
        if template_id:
            for i, t in enumerate(items):
                if t.id == template_id:
                    t.name = (name or t.name).strip()[:MAX_NAME]
                    t.prompts = clean
                    t.identity = (identity or "")[:MAX_IDENTITY]
                    t.updated_at = time.time()
                    items[i] = t
                    _write(items)
                    return t
            raise KeyError(template_id)
        if len(items) >= MAX_TEMPLATES:
            raise ValueError(f"at most {MAX_TEMPLATES} templates")
        t = PromptTemplate(id=uuid4().hex[:12], name=(name or "").strip()[:MAX_NAME],
                           prompts=clean, identity=(identity or "")[:MAX_IDENTITY])
        items.append(t)
        _write(items)
        return t


def delete(template_id: str) -> bool:
    with _LOCK:
        items = list_templates()
        rest = [t for t in items if t.id != template_id]
        if len(rest) == len(items):
            return False
        _write(rest)
        return True


def apply_to(template_id: str) -> dict[str, Any]:
    """What opening a template into a subject yields: a COPY of its prompts.

    Return a copy so subject edits cannot mutate the shared template. The identity block is
    returned as a suggestion and does not replace the subject's current value.
    """
    t = get(template_id)
    if t is None:
        raise KeyError(template_id)
    return {"prompts": list(t.prompts), "suggested_identity": t.identity, "from_template": t.id}
