"""A stub model, so the whole pipeline can be exercised with no server and no GPU.

Ported from the baseline's `--mock`. It is deliberately dumb: one substitution, and
`<<<NOCHANGE>>>` for anything that does not contain the trigger. That combination exercises both
NOCHANGE paths (I6), the sentinel parse, and the apply/hold-back split without pretending to be
an editor.
"""
from __future__ import annotations

from typing import Any

from ..core.contract import BEGIN, END, NOCHANGE

TRIGGER = "Test Character 1"
REPLACEMENT = "Renamed Character 1"


class MockBackend:
    """Applies a trivial rename. Records every request, which is what the I10 test reads."""

    def __init__(self, trigger: str = TRIGGER, replacement: str = REPLACEMENT):
        self.trigger = trigger
        self.replacement = replacement
        self.calls: list[tuple[list[dict[str, str]], dict[str, Any]]] = []

    def complete(self, messages: list[dict[str, str]], sampler: dict[str, Any]) -> str:
        self.calls.append((messages, dict(sampler)))
        user = messages[-1]["content"]
        # The baseline split on the "FIELD\n" header its prompt builder emits. Falling back to the
        # whole message keeps the mock usable with a stub prompt builder in tests.
        field = user.split("FIELD\n", 1)[1] if "FIELD\n" in user else user
        if self.trigger not in field:
            return NOCHANGE
        return (f"{BEGIN}\n{field.replace(self.trigger, self.replacement)}\n{END}\n"
                f"Name substituted.")
