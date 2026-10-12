"""Passes and their proposals — the durable half of a run.

On disk, under the document that owns them (so deleting a document takes its passes with it):

    documents/<doc_id>/passes/<pass_id>/meta.json      the Pass record
    documents/<doc_id>/passes/<pass_id>/prop/0001.json one Proposal, per field

🔴 **ONE FILE PER PROPOSAL, BECAUSE §5 SAYS FLUSH PER FIELD AND MEANS IT.** A 35-minute pass must
survive a restart with everything up to field N durable. The obvious alternative — one growing
`pass.json` rewritten after each field — makes every flush O(the whole pass), so the 110th field
rewrites a megabyte of proposals to record one, and the crash window grows with the run. A small
file per field is O(1) and the directory is the index.

🔴 **THE WRITE ORDER IS THE CRASH PLAN, AND IT IS DELIBERATELY THE WASTEFUL DIRECTION.** The
proposal is written first, the cursor advances second. A crash between them re-runs one field on
resume and overwrites its proposal with an identical one — one redundant model call, ~7 seconds.
The other order loses that field's proposal permanently while the cursor swears it was done, and
nothing downstream can tell.
"""
from __future__ import annotations

from pathlib import Path

import vault_fs

from .documents import DOCS_DIR, META, MissingDocument, _read_json
from .models import Pass, Proposal, is_id, new_id, store_lock

PASSES_DIR = "passes"
PROP_DIR = "prop"


class PassStore:
    """Passes under one root. Shares the root with `DocumentStore` — same tree, same routing."""

    def __init__(self, root):
        self.root = Path(root)

    # ── layout ───────────────────────────────────────────────────────────────

    def _passes(self, doc_id: str) -> Path:
        """🔴 THE SECOND DOOR ONTO A DOCUMENT'S PATH.

        `PassStore` builds this path directly instead of using `DocumentStore._dir`, and routes
        can reach it without a `DocumentStore` call. Validate the ID here too, using the shared
        `models.is_id` rule so both stores enforce the same path boundary.
        """
        if not is_id(doc_id):
            raise MissingDocument(f"{doc_id!r} is not a document id")
        return self.root / DOCS_DIR / doc_id / PASSES_DIR

    def _lock(self, doc_id: str):
        """🔴 Share the document lock with `DocumentStore`. Both stores can update the same tree,
        so locking only one store would leave the other path unsynchronized. `models.store_lock`
        uses `(root, doc_id)`, allowing separate store objects for the same directory to exclude
        each other.

        ⚠️ Lock by document, not pass. `record()` updates pass state while `materialize` reads the
        document's revisions, so operations on one document must serialize together.
        """
        if not is_id(doc_id):
            raise MissingDocument(f"{doc_id!r} is not a document id")
        return store_lock(self.root, doc_id)

    def _dir(self, doc_id: str, pass_id: str) -> Path:
        """⚠️ `pass_id` WAS CHECKED NOWHERE AT ALL — not here, not at any of the six routes.
        It is minted by `new_id()` exactly like a document id, and it lands in a path exactly
        like one, so it gets the same rule. `POST …/proposal/<i>/review` writes through this."""
        if not is_id(pass_id):
            raise MissingDocument(f"{pass_id!r} is not a pass id")
        return self._passes(doc_id) / pass_id

    def _meta(self, doc_id: str, pass_id: str) -> Path:
        return self._dir(doc_id, pass_id) / META

    def _prop(self, doc_id: str, pass_id: str, index: int) -> Path:
        return self._dir(doc_id, pass_id) / PROP_DIR / f"{index:04d}.json"

    # ── passes ───────────────────────────────────────────────────────────────

    def start(self, doc_id: str, *, revision: int, instruction: str, model: str,
              sampler: dict, selection: list, total: int, engine: str = "") -> Pass:
        """Open a pass. Durable before the first request goes out.

        🔴 **THE PASS RECORD IS WRITTEN BEFORE ANY FIELD IS SENT**, and that ordering is what
        makes `instruction` byte-frozen in fact rather than by convention (I10): the string every
        request is built from is on disk, unchanged, from before the first one. A pass whose
        instruction lived only in a request handler's local variable would be amendable by any
        later code path that happened to hold the same object.
        """
        p = Pass(id=new_id(), doc_id=doc_id, revision=revision, instruction=instruction,
                 model=model, engine=engine, sampler=dict(sampler),
                 selection=[list(s) for s in selection],
                 total=total)
        with self._lock(doc_id):
            self._write(p)
        return p

    def _write(self, p: Pass) -> None:
        vault_fs.write_json_atomic(self._meta(p.doc_id, p.id), p.to_dict(), indent=2)

    def get(self, doc_id: str, pass_id: str) -> Pass:
        path = self._meta(doc_id, pass_id)
        if not vault_fs.exists(path):
            raise MissingDocument(f"{doc_id}/{pass_id}")
        return Pass.from_dict(_read_json(path))

    def list_passes(self, doc_id: str) -> list[Pass]:
        """Every pass over this document, newest first. A corrupt one is skipped, not raised on —
        same argument as `DocumentStore.list_documents`: one bad record must not hide the rest."""
        d = self._passes(doc_id)
        if not vault_fs.exists(d):
            return []
        out: list[Pass] = []
        for child in vault_fs.listdir(d):
            try:
                out.append(Pass.from_dict(_read_json(d / child / META)))
            except (OSError, ValueError, KeyError, RuntimeError):
                continue
        out.sort(key=lambda p: p.created_at, reverse=True)
        return out

    def record(self, doc_id: str, pass_id: str, proposal: Proposal) -> Pass:
        """Persist one field's proposal, then advance the cursor. See the module note on order.

        Returns the updated Pass so a caller that is streaming does not have to re-read it.

        🔴 **READ-MODIFY-WRITE OF THE PASS RECORD, AND §3.3 MAKES THE RACE REACHABLE.** Two passes
        can be in flight over one document — the "one pass at a time" guarantee is a check-then-act
        with the lock dropped across a network round trip — and even within one pass, two fields
        finishing together both read `cursor` and `tally`, and the second write drops the first
        row. `cursor` is the RESUME POINT, so losing an increment makes a restart re-run fields
        whose proposals are already durable, and `tally` is what the report and the instruction
        library's "how did this go" history are built from.
        """
        with self._lock(doc_id):
            p = self.get(doc_id, pass_id)
            vault_fs.write_json_atomic(self._prop(doc_id, pass_id, proposal.index),
                                       proposal.to_dict())
            # Never backward: a resumed pass re-running field 34 must not move the cursor from
            # 110 back to 34 and re-run everything after it.
            p.cursor = max(p.cursor, proposal.index)
            p.tally[proposal.status] = p.tally.get(proposal.status, 0) + 1
            self._write(p)
            return p

    def finish(self, doc_id: str, pass_id: str, *, status: str = "done",
               tally: dict | None = None, error: str = "") -> Pass:
        """Close a pass.

        ⚠️ `tally` overwrites the running count when given. The runner's own PASS_FINISH tally is
        authoritative for a run that completed in one process; `record()`'s incremental count is
        what a resumed or interrupted pass has instead, and it is the one that would otherwise
        double-count a re-run field.
        """
        import time
        with self._lock(doc_id):
            p = self.get(doc_id, pass_id)
            p.status = status
            p.finished_at = time.time()
            p.error = error
            if tally is not None:
                p.tally = dict(tally)
            self._write(p)
            return p

    def delete(self, doc_id: str, pass_id: str) -> None:
        with self._lock(doc_id):
            d = self._dir(doc_id, pass_id)
            if not vault_fs.exists(d):
                raise MissingDocument(f"{doc_id}/{pass_id}")
            vault_fs.rmtree(d)

    # ── proposals ────────────────────────────────────────────────────────────

    def proposals(self, doc_id: str, pass_id: str) -> list[Proposal]:
        """Every proposal recorded so far, in field order.

        🔴 **THIS RETURNS BODIES.** It is the review queue's data and it must only ever reach the
        browser over the authenticated document route — never an SSE frame (I16). The progress
        stream says "row 34 is ready"; the browser then asks for row 34.
        """
        d = self._dir(doc_id, pass_id) / PROP_DIR
        if not vault_fs.exists(d):
            return []
        out: list[Proposal] = []
        for child in vault_fs.listdir(d):
            if not child.endswith(".json"):
                continue
            try:
                out.append(Proposal.from_dict(_read_json(d / child)))
            except (OSError, ValueError, KeyError, RuntimeError):
                continue
        out.sort(key=lambda p: p.index)
        return out

    def proposal(self, doc_id: str, pass_id: str, index: int) -> Proposal:
        path = self._prop(doc_id, pass_id, index)
        if not vault_fs.exists(path):
            raise MissingDocument(f"{doc_id}/{pass_id}#{index}")
        return Proposal.from_dict(_read_json(path))

    def review(self, doc_id: str, pass_id: str, index: int, review: str,
               edited: str | None = None) -> Proposal:
        """Record the user's decision about one proposal.

        🔴 **THIS NEVER TOUCHES A DOCUMENT.** Approving is not applying — it marks a row, and the
        content moves only when `DocumentStore.materialize` mints a revision from the marked rows
        (§4). Keeping the two apart is what makes the review queue, resume, per-entry retry and
        the one-entry preview all fall out of the same records instead of each needing its own.

        An edit implies approval: `review="edited"` with the text is the whole decision, and
        requiring a second call to approve it would leave a state where the user's own decision is
        recorded and excluded.

        ⚠️ Locked (§3.4): read the proposal, set the decision, write it back — with `record()`
        able to rewrite the same file on a resume, and `review_all` able to sweep it.
        """
        with self._lock(doc_id):
            p = self.proposal(doc_id, pass_id, index)
            p.review = review
            if edited is not None:
                p.edited = edited
                p.review = "edited"
            vault_fs.write_json_atomic(self._prop(doc_id, pass_id, index), p.to_dict())
            return p

    def review_all(self, doc_id: str, pass_id: str, review: str,
                   *, only_status: str = "CHANGED") -> int:
        """Bulk approve or reject. Returns how many rows moved.

        Restricted to CHANGED rows by default because the others have nothing to decide —
        "approve all" on a pass with 80 NOCHANGE rows must not turn 80 `none`s into 80 approvals
        that then apply nothing, which would make the count in the confirmation dialog a lie.

        ⚠️ **ONE LOCK FOR THE WHOLE SWEEP, not one per row.** Half-applied is the state that
        makes that same count a lie from the other direction, and it is the state a concurrent
        `review` of a single row would otherwise interleave into.
        """
        n = 0
        with self._lock(doc_id):
            for p in self.proposals(doc_id, pass_id):
                if only_status and p.status != only_status:
                    continue
                if p.review == review:
                    continue
                p.review = review
                vault_fs.write_json_atomic(self._prop(doc_id, pass_id, p.index), p.to_dict())
                n += 1
        return n
