"""The instruction library, stored separately from document revisions.

    wbedit/instructions.json

The library preserves reusable instructions and recent run summaries. Each pass copies its
instruction at start, so later library edits cannot change an already-running pass.

🔴 **One library serves both character cards and worldbooks.** `kind` filters the shared list; it
does not partition the underlying records.

🔴 **The library is server-side, stored in the vault, and survives application restarts.**

## Why there is no in-memory cache, and why that IS I15

Every other section-shaped store in Vocalis keeps the map in memory and rewrites the whole section
on each change, which is what forces `st_characters.py`'s `_loaded` flag: read while the vault is
locked, get `{}`, write `{}` back, and the section is gone. This module sidesteps the whole class
by reading the file on every operation and writing it straight back. A locked vault then raises on
the READ, before anything is written — the failure is loud and nothing is lost, rather than
prevented by a flag that a future refactor can drop. A corrupt file behaves the same way: the read
raises, so the write cannot happen, and the file survives for hand repair.

The cost is one small read per mutation. This list is tens of entries, not thousands.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any

import vault_fs

from .documents import StoreCorrupt, _read_json
from .models import LIBRARY_LOCK, new_id, store_lock

FILENAME = "instructions.json"

#: How many runs are remembered per instruction. This is a DISPLAY bound, not retention: the
#: authoritative record of a run is the Pass itself, which is never pruned (§4). What is capped is
#: the "you have used this before, here is how it went" list on the picker, which nobody reads
#: past the recent few and which would otherwise grow without limit inside a file read on every
#: mutation.
MAX_RUNS = 20


@dataclass
class Instruction:
    """One reusable instruction, and how it has gone.

    ⚠️ `text` is the byte-frozen string a Pass copies (I10). The library holds the EDITABLE
    master; a Pass holds the frozen copy taken at the moment it started. Editing a library entry
    must never reach back into a pass that used it, or a report would describe an instruction that
    never ran — which is the same failure as a mutable `Job`.
    """

    id: str
    name: str
    text: str
    favorite: bool = False
    kind: str = ""                 # "" = both; otherwise one of models.KINDS, to filter the list
    created_at: float = dc_field(default_factory=lambda: time.time())
    updated_at: float = dc_field(default_factory=lambda: time.time())
    runs: list[dict[str, Any]] = dc_field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "text": self.text,
                "favorite": self.favorite, "kind": self.kind,
                "created_at": self.created_at, "updated_at": self.updated_at,
                "runs": list(self.runs)}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Instruction:
        return cls(id=str(d["id"]), name=str(d.get("name") or ""), text=str(d.get("text") or ""),
                   # 9.8 — `favourite` is the pre-sweep key. See acelib.from_dict.
                   favorite=bool(d.get("favorite", d.get("favourite"))),
                   kind=str(d.get("kind") or ""),
                   created_at=float(d.get("created_at") or 0.0),
                   updated_at=float(d.get("updated_at") or 0.0),
                   runs=list(d.get("runs") or []))


class InstructionLibrary:
    def __init__(self, root):
        self.root = Path(root)
        self.path = self.root / FILENAME

    def _lock(self):
        """🔴 **EVERY MUTATION HERE IS A READ-THE-WHOLE-FILE-MODIFY-WRITE-THE-WHOLE-FILE, AND THE
        REVIEW NAMES IT — 7.0 §3.4** (`library.py:137-139`, the pass worker thread racing a UI
        edit). The module note above explains why there is no in-memory cache; what it does not
        buy is mutual exclusion, and without it two writers landing together silently drop one.
        The library is the authoritative store for reusable instructions, so concurrent updates
        must not overwrite one another.

        ⚠️ One lock for the whole file, keyed on the root, because the file IS the unit — there is
        no per-instruction file to lock more finely. It takes no document lock and no document
        lock reaches it, so it cannot participate in a cycle.
        """
        return store_lock(self.root, LIBRARY_LOCK)

    def _read(self) -> list[Instruction]:
        """The file, or an empty list if it has never been written.

        🔴 A MISSING FILE AND AN UNREADABLE ONE ARE NOT THE SAME ANSWER. Absent means "no
        instructions yet" and is a fact. Locked or corrupt raises, because writing on top of
        either could destroy the library. An empty picker would also hide why an expected library
        is unavailable.
        """
        if not vault_fs.exists(self.path):
            return []
        data = _read_json(self.path)
        if not isinstance(data, dict) or not isinstance(data.get("instructions"), list):
            raise StoreCorrupt(f"{FILENAME}: not an instruction library")
        return [Instruction.from_dict(d) for d in data["instructions"]]

    def _write(self, items: list[Instruction]) -> None:
        vault_fs.write_json_atomic(self.path,
                                   {"instructions": [i.to_dict() for i in items]}, indent=2)

    # ── the list ─────────────────────────────────────────────────────────────

    def list(self, kind: str = "") -> list[Instruction]:
        """Favorites first, then most recently updated. `kind` filters; "" is everything.

        An entry tagged for one kind still shows on the other tab when it is a favorite? No — it
        is filtered out, deliberately. A filter that keeps showing the excluded kind would be
        ineffective.
        """
        items = self._read()
        if kind:
            items = [i for i in items if not i.kind or i.kind == kind]
        items.sort(key=lambda i: (not i.favorite, -i.updated_at))
        return items

    def get(self, ins_id: str) -> Instruction:
        for i in self._read():
            if i.id == ins_id:
                return i
        raise KeyError(ins_id)

    def add(self, *, name: str, text: str, kind: str = "",
            favorite: bool = False) -> Instruction:
        with self._lock():
            items = self._read()
            ins = Instruction(id=new_id(), name=name, text=text, kind=kind, favorite=favorite)
            items.append(ins)
            self._write(items)
            return ins

    def update(self, ins_id: str, **fields) -> Instruction:
        """Edit name / text / favorite / kind. Unknown keys are refused rather than ignored —
        a typo that silently does nothing is a bug report about the UI not saving."""
        allowed = {"name", "text", "favorite", "kind"}
        bad = set(fields) - allowed
        if bad:
            raise ValueError(f"not an instruction field: {sorted(bad)}")
        with self._lock():
            items = self._read()
            for i in items:
                if i.id == ins_id:
                    for k, v in fields.items():
                        setattr(i, k, v)
                    i.updated_at = time.time()
                    self._write(items)
                    return i
        raise KeyError(ins_id)

    def delete(self, ins_id: str) -> None:
        with self._lock():
            items = self._read()
            kept = [i for i in items if i.id != ins_id]
            if len(kept) == len(items):
                raise KeyError(ins_id)
            self._write(kept)

    def record_run(self, ins_id: str, *, doc_id: str, doc_name: str, pass_id: str,
                   tally: dict) -> None:
        """Attach a finished pass to the instruction that produced it.

        This is the half of §5 that makes the library worth more than a list of strings: the
        picker can show that this instruction changed 34 of 110 fields on the Blackwood book last
        Tuesday, which is the only evidence anyone has about whether it is any good.

        Silently does nothing for an instruction that has since been deleted — a pass outliving
        the library entry it came from is normal, and failing the pass's completion because of it
        would be the tail wagging the dog.
        """
        with self._lock():
            items = self._read()
            for i in items:
                if i.id == ins_id:
                    i.runs.append({"doc_id": doc_id, "doc_name": doc_name, "pass_id": pass_id,
                                   "when": time.time(), "tally": dict(tally)})
                    i.runs = i.runs[-MAX_RUNS:]
                    self._write(items)
                    return
