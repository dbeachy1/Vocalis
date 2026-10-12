"""Compatibility import for the shared chat-completions backend.

The transport is injected by the caller, which owns authentication and TLS configuration. This
module preserves the historical `KoboldChat` name as an alias of `ChatCompletions`.

So this module owns only what is genuinely its own: the chat-completions request shape, pulling
the reply out of it, and turning every failure into a `TransportError` that carries no field
text. `urllib_post()` is here for standalone use; Vocalis passes `kobold._request` instead.

🔴 **I18 — nothing leaves the machine** — for THIS engine. Kobold is local, and the URL comes
from the caller's already-validated config (`kobold.resolve_config` / `_is_local`). This module
deliberately does not re-implement that check: half a copy of somebody else's locality policy is
worse than none, because it looks like the policy is enforced here. ⚠️ 11.1 amended I18 for the
hosted providers — see `chat.py`'s header.

`KoboldChat` below is the same class object, not a subclass or copy, preserving compatibility for
existing imports.
"""
from __future__ import annotations

from .chat import CHAT_PATH, NO_REPLY, ChatCompletions, Exchange, Post, urllib_post

#: The same class object — see the module docstring. Not a subclass: `isinstance` and identity
#: both hold, so nothing that names it can drift from what the other engines run.
KoboldChat = ChatCompletions

__all__ = ["CHAT_PATH", "NO_REPLY", "ChatCompletions", "Exchange", "KoboldChat", "Post",
           "urllib_post"]
