"""Turn the Section-Editor card into a system prompt and few-shot pairs.

Takes a **parsed** card, not a path: reading it is the caller's job (§7.1 — `src/` does no raw
I/O), and the tab has to be able to show and override the system prompt anyway (§6.4.1), which
means something above this already holds the object.
"""
from __future__ import annotations

import re
from typing import Any

#: SillyTavern's own example-dialogue separator. It is the card's format, not ours.
START = "<START>"

_CHAR_RE = re.compile(r"\{\{char\}\}:")
_USER_PREFIX_RE = re.compile(r"^\{\{user\}\}:\s*")


def load(card: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """`(system_prompt, few_shot_pairs)` from a V2 (or flat V1) character card.

    The system prompt is `system_prompt` followed by `description`, blank-line joined — the card
    splits the contract across both fields and SillyTavern concatenates them the same way, so
    reading only one silently drops half the output contract.

    A `<START>` block with no `{{char}}:` speaker is skipped rather than guessed at: a malformed
    pair is worse than a missing one, because it teaches the model a shape we do not want back.
    """
    d = card.get("data", card) if isinstance(card, dict) else {}
    system = "\n\n".join(x for x in (d.get("system_prompt", ""), d.get("description", "")) if x)

    shots: list[dict[str, str]] = []
    for block in (d.get("mes_example", "") or "").split(START):
        block = block.strip()
        if not block:
            continue
        m = _CHAR_RE.search(block)
        if not m:
            continue
        user = _USER_PREFIX_RE.sub("", block[:m.start()].strip()).strip()
        assistant = block[m.end():].strip()
        if user and assistant:
            shots.append({"user": user, "assistant": assistant})
    return system, shots
