"""The document store (design §4, §5) — the first part of `wbedit` that touches disk.

Everything above this package is pure: the runner does no I/O, the collectors take a parsed
document rather than a path, and the prompt layer takes a loaded card. That was not tidiness —
it confines document persistence to one package boundary, simplifying the audit of routing and
encryption behavior.

🔴 **EVERY WRITE GOES THROUGH `vault_fs`, AND THE TREE IS ROUTED** as `install`/`wbedit` in
`vault_store.ROUTES`. A bare `open()` or `Path.write_text()` here would write cleartext INSIDE an
encrypted install and raise nothing — the silent half (`vault_fs`'s own module note), at the
worst possible scale, because a revision is a whole lorebook.
"""
from __future__ import annotations

from .documents import (AVATAR, AmbiguousName, DocumentStore, MissingDocument,
                        RevisionConflict, StoreCorrupt)
from .library import Instruction, InstructionLibrary
from .models import Document, Pass, Proposal, Revision
from .passes import PassStore

__all__ = ["AVATAR", "AmbiguousName", "Document", "DocumentStore", "Instruction",
           "InstructionLibrary", "MissingDocument", "Pass", "PassStore", "Proposal", "Revision",
           "RevisionConflict", "StoreCorrupt"]
