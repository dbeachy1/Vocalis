"""The markdown report, as an event subscriber (6.4-m1c).

Ported from the baseline's `Reporter`, which wrote one block per entry as the run proceeded so
the file could be tailed live. That discipline is kept and is now load-bearing for more than
tailing: §5 requires a 35-minute pass to survive a restart with everything up to field N durable,
so this flushes per field, never per pass.

🔴 THE FENCE IS TILDES AND WIDENS AGAINST THE CONTENT — I3, the same reasoning as the output
sentinels. Field values routinely contain backticks and whole fenced blocks (an entry describing
a config file, a card quoting example dialogue). A fixed ``` fence collides with the content it
delimits, and the failure is a report that renders as garbage from the middle of one entry
onward — exactly where you are trying to read.
"""
from __future__ import annotations

import difflib
import re
import time
from typing import Callable

from ..runner import FIELD_RESULT, PASS_FINISH, PASS_START, Event


def fence(*texts: str) -> str:
    """A tilde fence guaranteed longer than any fence inside the content."""
    n = 4
    for t in texts:
        for m in re.findall(r"^\s*(~{3,})", t, re.M):
            n = max(n, len(m) + 1)
    return "~" * n


def diff(a: str, b: str, label: str) -> str:
    return "\n".join(difflib.unified_diff(
        a.splitlines(), b.splitlines(),
        fromfile=f"{label} (before)", tofile=f"{label} (after)", n=1, lineterm="",
    ))


def _stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


class MarkdownReport:
    """Feed it every `Event` from `runner.run()`; it writes the report the baseline wrote.

    `write` takes a string. `flush` is called after each entry block — pass the real thing, since
    "written as the run proceeds" is a promise about crash survival, not about formatting.
    """

    def __init__(self, write: Callable[[str], None], *, instruction: str, source: str,
                 flush: Callable[[], None] | None = None,
                 clock: Callable[[], str] = _stamp):
        self._write = write
        self._flush = flush or (lambda: None)
        self._clock = clock
        self.instruction = instruction
        self.source = source

    def feed(self, ev: Event) -> None:
        if ev.kind == PASS_START:
            self._header(ev)
        elif ev.kind == FIELD_RESULT:
            self._entry(ev)
        elif ev.kind == PASS_FINISH:
            self._summary(ev)

    # ------------------------------------------------------------------ sections

    def _header(self, ev: Event) -> None:
        f = fence(self.instruction)
        self._write(
            "# Worldbook batch edit — report\n\n"
            f"Started {self._clock()}  \n"
            f"Source: `{self.source}`  \n"
            f"Fields to consider: {ev.total}\n\n"
            "Written as the run proceeds — safe to tail. Summary is at the bottom.\n\n"
            f"## Instruction\n\n{f}\n{self.instruction.strip()}\n{f}\n\n---\n\n## Entries\n\n"
        )
        self._flush()

    def _entry(self, ev: Event) -> None:
        r = ev.result
        assert r is not None, "a field.result event without a result"
        j = r.job
        mark = "APPLIED" if ev.applied else ("held back" if r.status == "CHANGED" else "—")
        self._write(f"### {j.rel} :: {j.label}\n\n")
        self._write(f"- status: **{r.status}** ({mark})\n")
        self._write(f"- kind: {j.meta.get('kind', 'field')}\n")
        if r.reason:
            self._write(f"- reason: {r.reason}\n")
        for fl in r.flags:
            self._write(f"- **FLAG:** {fl}\n")
        if r.notes:
            self._write(f"- model notes: {r.notes}\n")

        if r.status == "CHANGED" and r.revised is not None:
            fb = fence(j.original, r.revised)
            self._write(f"\n**BEFORE**\n\n{fb}\n{j.original}\n{fb}\n")
            self._write(f"\n**AFTER**\n\n{fb}\n{r.revised}\n{fb}\n")
            d = diff(j.original, r.revised, j.label).rstrip()
            if d:
                fd = fence(d)
                self._write(f"\n<details><summary>changed lines only</summary>\n\n"
                            f"{fd}diff\n{d}\n{fd}\n\n</details>\n")
        self._write("\n---\n\n")
        self._flush()

    def _summary(self, ev: Event) -> None:
        t = ev.tally
        self._write("## Summary\n\n")
        for k in sorted(k for k in t if k not in ("applied", "held")):
            self._write(f"- {k}: {t[k]}\n")
        self._write(f"- applied to output: {t.get('applied', 0)}\n")
        if t.get("held"):
            self._write(f"- flagged and held back: {t['held']}\n")
        self._write(f"\nFinished {self._clock()}\n")
        self._flush()
