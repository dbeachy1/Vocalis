"""`Job` and `Result` — the two records the loop moves between.

Extracted from `reference/wbedit-baseline/wb_batch_edit.py` (6.4-m1c). Pure data, no I/O, and
deliberately no `Path`.

🔴 THE BASELINE'S `path: Path` IS GONE, AND ITS ABSENCE IS I8. The CLI read a file, edited it and
wrote a sibling — `Job.path` was where to write back. In 6.4 a Document is immutable in the vault
and every accepted edit mints a Revision (§4), so a Job carrying a filesystem destination would
describe an operation this design does not have. A Job now says only WHICH FIELD, and the store
decides what a Revision is made of.

What survives is `rel`: the display name of the document a field came from. It is a report
heading and nothing else — no path arithmetic hangs off it any more.

⚠️ `meta` is context handed to the model and never edited. It is also the only free-form dict
here, which makes it the easy place to smuggle something; whatever goes in reaches a prompt.
"""
from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from typing import Any

#: `SKIPPED` is not in this tuple. Entries are processed uniformly; the former sealed-entry
#: exception no longer exists.
STATUSES = ("CHANGED", "NOCHANGE", "FAILED")


@dataclass(frozen=True)
class Job:
    """One field, addressed and captured. Frozen: a pass is defined by the fields it started
    with, and a collector that mutated a Job mid-run would make the report describe something
    that never ran."""

    rel: str              # display name of the source document — a report heading, nothing more
    locator: tuple        # walk into the loaded document to reach this string (§4.1)
    label: str            # human label for the report ("entry 12 — Test Character 1")
    original: str
    meta: dict[str, Any] = dc_field(default_factory=dict)


@dataclass
class Result:
    """What one field came back as. Mutable — `elapsed` is stamped after the attempt loop.

    🔴 `revised` is a PROPOSAL, never an application (§4). `Result(status="CHANGED")` means the
    model returned different text that survived the validators; whether it reaches a Revision is
    the review queue's decision and, for a flagged result, the user's. Anything that reads `revised`
    and writes it somewhere without passing through that gate has re-introduced the auto-apply
    this design exists to prevent.
    """

    job: Job
    status: str                       # one of STATUSES
    revised: str | None = None
    reason: str = ""
    notes: str = ""                   # the model's post-sentinel change list (I5)
    elapsed: float = 0.0
    flags: list[str] = dc_field(default_factory=list)
