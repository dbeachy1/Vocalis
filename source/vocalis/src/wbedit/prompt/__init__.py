"""Prompt assembly: a Section-Editor card in, a message list out.

🔴 **THE CARD IS A RUNTIME DEPENDENCY, AND IT WILL LOOK LIKE A MISTAKE** (design §7). The system
prompt is built from `Section-Editor.json` and the few-shot pairs from splitting its
`mes_example` on `<START>`. That same card is imported into SillyTavern for interactive
single-field edits, so there is **exactly one definition of the output contract** and the two
paths cannot drift. If it ever needs cleaner separation, extract the contract to a template and
*generate* the card from it — do not fork them by hand.

🔴 **The few-shot pairs are part of the output contract.** They guide the model to follow the
sentinel format and reduce the chance that reasoning appears as field content.
"""
from __future__ import annotations

from . import assemble, settings
from .assemble import for_runner, messages, user_message
from .card_loader import load

__all__ = ["assemble", "for_runner", "load", "messages", "settings", "user_message"]
