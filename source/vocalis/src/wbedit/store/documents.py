"""The document store — documents, their revisions, and materializing one from a pass.

On disk, under the routed `wbedit/` tree (design §5):

    documents/<doc_id>/meta.json          the Document record
    documents/<doc_id>/rev/0000.json      revision 0 — the import, i.e. the bytes as imported
    documents/<doc_id>/rev/0001.json      ...
    documents/<doc_id>/passes/<pass_id>/  see passes.py

The Library is built by listing `documents/`; there is no separately rewritten index that could
become inconsistent with stored documents. Construction stores the root path but does not access
the vault, because the application can start before unlock. Vault errors propagate from reads so
an unreadable library is not represented as an empty one.
"""
from __future__ import annotations

import copy
import json
import unicodedata
from pathlib import Path
from typing import Any, Iterable, Sequence

import vault_fs

from .. import thumbs
from ..core.locator import set_at
from ..formats import png_card
from .models import (DISMISSED_LOCK, IMPORT_LOCK, REV_IMPORT, Document, Proposal, Revision,
                     is_id, new_id, store_lock)

META = "meta.json"
REV_DIR = "rev"
ASSET_DIR = "assets"
DOCS_DIR = "documents"

#: Model interaction log stored with the document so it follows the document lifecycle and vault
#: routing instead of residing in plaintext scratch.
LOG_DIR = "log"

#: The pending-edit scratchpad (§9a.15). One per document, beside `meta.json`, never inside a
#: revision — it is not content and must not be mistaken for any.
DRAFT = "draft.json"

#: External references dismissed from the library. Imports continue to include all source items;
#: this list prevents dismissed items from reappearing and supports explicit restoration.
DISMISSED = "dismissed.json"

#: External references permanently removed from the recycle bin. Keep this separate from
#: `DISMISSED`: imports must continue to decline purged items, while the recycle bin must omit them.
#: Updates to both records are performed under `DISMISSED_LOCK` so interruption cannot leave an
#: item active in neither list.
DISMISSED_FOREVER = "dismissed_forever.json"

#: Maximum serialized model-log size per document revision.
LOG_MAX = 8 * 1024 * 1024

#: Canonical filename for a document avatar, shared by upload and SillyTavern push paths.
AVATAR = "card.png"


class MissingDocument(KeyError):
    """No such document, or no such revision of one."""


def _fold_name(name) -> str:
    """One display name, reduced to the key two names are the same book under. 9.4.

    Trim, NFC, casefold - in that order, because `casefold` on a decomposed string leaves it
    decomposed. Used on BOTH sides of every comparison in `find_by_name`, so a stored name and an
    incoming filename are always reduced by the same function rather than by two expressions that
    look alike.
    """
    if not isinstance(name, str):
        return ""
    return unicodedata.normalize("NFC", name.strip()).casefold()


class AmbiguousName(ValueError):
    """A file import matched more than one document with that name, so it refuses to guess.

    Import refuses to choose when multiple documents share the incoming name. Applying a revision
    to an arbitrary match could silently attach edits to the wrong document lineage.
    """

    def __init__(self, kind: str, name: str, count: int):
        self.kind, self.name, self.count = kind, name, count
        super().__init__(
            f"{count} documents here are already called \"{name}\" - rename or remove one so "
            f"this import can land on the right one")


class RevisionConflict(RuntimeError):
    """An edit was built on a revision that is no longer the latest.

    Edits and pass materialization rebuild from `base_revision`; if that base is stale, creating a
    new head would discard intervening revisions. Callers reject stale edits with this conflict.
    Explicit rollback remains valid because it creates a new revision from the requested older
    base instead of rewinding history.
    """

    def __init__(self, doc_id: str, base: int, latest: int):
        self.doc_id, self.base, self.latest = doc_id, base, latest
        super().__init__(
            f"{doc_id}: this edit was made against revision {base}, but the document is now at "
            f"revision {latest}. Reload to see the current version.")


class StoreCorrupt(RuntimeError):
    """A record on disk would not parse.

    Corrupt records are left intact for diagnosis. Replacing unreadable data with a default would
    destroy both the content and the evidence needed to recover it.
    """


#: Retry transient Windows sharing violations when opening a file replaced concurrently. Parse
#: errors are not retried because they indicate invalid content rather than a temporary lock.
_READ_RETRIES = 10
_READ_DELAY_S = 0.05


def _read_json(p: Path) -> Any:
    import json
    import time
    for i in range(_READ_RETRIES):
        try:
            text = vault_fs.read_text(p)
            break
        except PermissionError:
            # Preserve the final error; callers must not treat a failed read as an empty record.
            if i == _READ_RETRIES - 1:
                raise
            time.sleep(_READ_DELAY_S)
    try:
        return json.loads(text)
    except ValueError as exc:
        # Include the path but not the body; parser errors can embed private document content.
        raise StoreCorrupt(f"{p.name}: not valid JSON") from exc


def stamp_of(size: int, mtime: float) -> str:
    """The identity of a stored asset's BYTES, as a short string: `(size, mtime)` in hex.

    ⚠️ **NOT A CONTENT HASH, AND §4.3.1 IS WHY ONE WOULD BE A TRAP.** SillyTavern re-encodes on
    every card edit, so identical pixels come back as different bytes; and hashing 700 KB per
    roster row would decrypt megabytes to answer a question a `stat` already answers. This says
    "is it the same FILE", which is the only question a cache is asking.
    """
    return f"{size:x}-{int(mtime * 1000):x}"


class DocumentStore:
    """Documents and revisions under one root.

    The root is injected rather than read from `vocalis.runtime.paths`, so a test gets a real
    store on a temp directory instead of a mock, and so `wbedit` stays extractable (§7). The web
    layer is the one place that knows the root is `paths.WBEDIT_DIR`.
    """

    def __init__(self, root):
        self.root = Path(root)

    # ── layout ───────────────────────────────────────────────────────────────

    def _docs(self) -> Path:
        return self.root / DOCS_DIR

    def _dir(self, doc_id: str) -> Path:
        """The document's directory — and the ONE place a store id is checked before it becomes
        a path.

        🔴 **`doc_id` COMES STRAIGHT OFF THE URL, ON NINETEEN ROUTES.** Werkzeug's default
        converter excludes `/` but NOT `\\`, and on Windows `pathlib` treats a backslash as a
        separator — so `DELETE /wbedit/documents/..%5C..%5Cevil` resolved to a directory outside
        the store entirely, and `vault_fs.rmtree` falls through to a bare
        `shutil.rmtree(ignore_errors=True)` for any path the vault does not route. `PUT .../draft`
        was an arbitrary write by the same road. It needed a logged-in session — `/wbedit/*` is
        not in the exemption list at `vocalis_server.py:435` — but a session is not a license to
        leave the filesystem open.

        🔴 **CHECKED HERE, NOT AT THE ROUTES.** Nineteen routes cannot each remember to do this,
        and the twentieth is the one that would forget. Every path in this store is built from
        `_dir`, so this is the chokepoint — the same argument `pair.py` makes for gating on the
        blueprint rather than on each route. The rest of the codebase already guards traversal
        this way (`test_bulk.py:447`, `test_clip_sources.py:188`, `test_scenes.py:134` all
        parametrize `a\\b`); wbedit was the outlier.

        ⚠️ **`MissingDocument`, not a distinct error.** The routes turn it into a 404, which is
        the right answer to a probe: it confirms nothing about what does or does not exist.

        ⚠️ **THE RULE ITSELF LIVES IN `models.is_id`, NOT HERE.** It was here first, and that was
        wrong: `PassStore` builds `root / DOCS_DIR / doc_id / …` independently, beside this
        method, so six routes walked past a guard that looked like a chokepoint and was not.
        One rule, next to `new_id`, shared by both stores.
        """
        if not is_id(doc_id):
            raise MissingDocument(f"{doc_id!r} is not a document id")
        return self._docs() / doc_id

    def _lock(self, doc_id: str):
        """The write lock for one document. See `models.store_lock`.

        🔴 **HELD ACROSS THE WHOLE READ-MODIFY-WRITE, INCLUDING THE REVISION-NUMBER
        ALLOCATION.** A lock around only the write would still let two threads read `[0..4]`,
        both compute `n=5`, and then take turns overwriting `rev/0005.json` — tidier, equally
        destructive. The read is half the operation.

        ⚠️ **READS DO NOT TAKE IT.** `get`, `revision`, `revisions`, `list_documents` and
        `revision_index` stay lock-free deliberately: this excludes WRITERS from writers, and
        promoting it to a full reader/writer scheme would serialize the Library roster behind
        every save while buying nothing a reader did not already have to tolerate (a listing is a
        point-in-time answer either way).

        `is_id` first, so a bad id is the store's own 404 rather than the registry's `ValueError`
        — and so a probe cannot pump entries into `_LOCKS`.
        """
        if not is_id(doc_id):
            raise MissingDocument(f"{doc_id!r} is not a document id")
        return store_lock(self.root, doc_id)

    def _meta(self, doc_id: str) -> Path:
        return self._dir(doc_id) / META

    def _rev(self, doc_id: str, n: int) -> Path:
        return self._dir(doc_id) / REV_DIR / f"{n:04d}.json"

    # ── documents ────────────────────────────────────────────────────────────

    def list_documents(self) -> list[Document]:
        """Every document, newest import first.

        A directory whose `meta.json` will not parse is skipped rather than raised on: one
        corrupt document must not make the Library unopenable, which would take every OTHER
        document with it. The corruption still raises the moment that one is opened.
        """
        docs = self._docs()
        if not vault_fs.exists(docs):
            return []
        out: list[Document] = []
        # 🔴 `listdir` returns NAMES, not paths — in the vault a path is the only thing it could
        # not honestly hand back, since the bytes live under a ciphertext name. Join against the
        # parent; `Path(child)` alone is a RELATIVE path that resolves against the process cwd.
        for child in vault_fs.listdir(docs):
            p = docs / child
            if not vault_fs.is_dir(p):
                continue
            try:
                out.append(Document.from_dict(_read_json(p / META)))
            except (StoreCorrupt, OSError, KeyError):
                continue
        out.sort(key=lambda d: d.imported_at, reverse=True)
        return out

    def get(self, doc_id: str) -> Document:
        p = self._meta(doc_id)
        if not vault_fs.exists(p):
            raise MissingDocument(doc_id)
        return Document.from_dict(_read_json(p))

    def _write_meta(self, doc: Document) -> None:
        vault_fs.write_json_atomic(self._meta(doc.id), doc.to_dict(), indent=2)

    def resolve_worldbook(self, name: str) -> str:
        """The `Document.id` of the worldbook called `name`, or `""` if we hold no such book.

        §8.2 — a card names its book, and a name is not a key. This is the one place that
        translation happens, so there is one answer to it.

        Matched case-insensitively on the stripped name: a book named "sample book" and a
        card that says "Sample Book" are the same book to this lookup, and the failure of
        an exact match here is SILENT — the character just never appears under its book. Two books
        differing only in case is pathological; newest-imported wins, because `list_documents()`
        is newest-first.
        """
        key = name.strip().casefold()
        if not key:
            return ""
        for d in self.list_documents():
            if d.kind == "worldbook" and d.name.strip().casefold() == key:
                return d.id
        return ""

    def link_orphan_cards(self, book: Document) -> int:
        """Link every card that named `book` but was imported before it existed. Returns the count.

        This makes import order irrelevant: when the book arrives after a card, the card's saved
        name can be resolved then. The method also runs after rename so cards can attach to a book
        whose display name now matches their stored reference.

        **Idempotent**, and only ever fills an EMPTY `world_id`: a card already linked to another
        book is left alone, so re-running this can never steal a link.

        🔴 **EACH CARD IS RE-READ UNDER ITS OWN LOCK, NOT WRITTEN FROM THE LISTING** (§3.4). The
        record `list_documents()` handed back was read before the loop and is a snapshot: writing
        it back whole would carry a stale `avatar_dirty`, `name` or `focus` over whatever a
        concurrent `put_avatar` or `rename` had since stored — the metadata clobber the finding
        describes, caused by the very method that repairs a link. The filter is re-tested against
        the fresh record for the same reason: a card that acquired a `world_id` while we were
        looking elsewhere must not have it stolen.

        ⚠️ Lock order is BOOK then CARD, and the caller already holds the book's — see
        `models.store_lock`.
        """
        if book.kind != "worldbook":
            return 0
        key = book.name.strip().casefold()
        if not key:
            return 0
        n = 0
        for d in self.list_documents():
            if d.kind != "card" or d.world_id or d.world_ref.strip().casefold() != key:
                continue
            try:
                with self._lock(d.id):
                    fresh = self.get(d.id)
                    if (fresh.kind != "card" or fresh.world_id
                            or fresh.world_ref.strip().casefold() != key):
                        continue
                    fresh.world_id = book.id
                    self._write_meta(fresh)
            except (MissingDocument, StoreCorrupt, OSError):
                # One unwritable or vanished card must not sink an import that has already
                # succeeded — the same posture `list_documents()` takes on a corrupt row two
                # methods up. This is idempotent, so the next import or rename of this book picks
                # the card back up.
                continue
            n += 1
        return n

    def create(self, content: dict, *, name: str, kind: str, source: str = "upload",
               st_ref: str = "", focus: dict | None = None,
               world_ref: str = "") -> Document:
        """Import a document: mint an id, write revision 0, write the metadata.

        🔴 **REVISION 0 IS WRITTEN BEFORE THE METADATA, AND THE ORDER IS THE CRASH PLAN.** A
        document whose `meta.json` exists but whose revision 0 does not is a library row that
        opens onto nothing; the reverse is an orphaned directory that `list_documents()` skips
        and a later import never collides with (the id is random). Both are recoverable; only one
        is visible, and it is the one we avoid.

        `kind` is passed in rather than detected here: the caller has already run
        `formats.detect` to decide whether it can collect fields at all, and detecting twice is
        how two answers to one question start to differ.
        """
        doc = Document(id=new_id(), kind=kind, name=name, source=source, st_ref=st_ref,
                       latest=0, focus=dict(focus or {}), world_ref=world_ref,
                       world_id=self.resolve_worldbook(world_ref) if kind == "card" else "")
        # ⚠️ Uncontended by construction — nobody else knows this id yet — and taken anyway. "Every
        # mutator locks" is a rule a reviewer can check in one pass; "every mutator except the one
        # whose id is fresh" is a rule the next writer has to re-derive, and this method already
        # goes on to touch OTHER documents below.
        with self._lock(doc.id):
            vault_fs.write_json_atomic(
                self._rev(doc.id, 0),
                Revision(n=0, content=content, note="import", kind=REV_IMPORT).to_dict())
            self._write_meta(doc)
            # Maintain worldbook links here so every creation path applies the same reconciliation.
            if doc.kind == "worldbook":
                self.link_orphan_cards(doc)
        return doc

    def find_by_st_ref(self, kind: str, st_ref: str) -> Document | None:
        """The document a SillyTavern key already maps to, or None. §8.1 — `st_ref` is THEIR key.

        🔴 **MATCHED EXACTLY, AND THAT IS DELIBERATELY UNLIKE `resolve_worldbook` TWO METHODS UP.**
        That one case-folds, because it matches a card's *claim* about a book's name against a
        book's *display name* — two strings a human typed, which should be the same thing. This
        one matches SillyTavern's own key against the copy of it we stored, and the two failure
        directions are not symmetric: too strict costs a duplicate Library row, while too loose
        MERGES TWO GENUINELY DIFFERENT ST DOCUMENTS INTO ONE and starts overwriting one with the
        other. Their books are files on a case-sensitive filesystem, so "Sample Book" and
        "sample book" really are two books, and we do not get to decide otherwise.

        Scoped to `source == "st"` as well as to `kind`: an uploaded document is a separate
        lineage, and a push from ST must never silently land on top of it. Cards and books are kept
        apart because a card's key is an avatar filename and a
        book's is a book name — nothing stops those colliding.
        """
        key = st_ref.strip()
        if not key:
            return None
        for d in self.list_documents():
            if d.kind == kind and d.source == "st" and d.st_ref.strip() == key:
                return d
        return None

    def find_by_name(self, kind: str, name: str) -> list["Document"]:
        """Every document of `kind` already carrying this display name. 9.4.

        CASE-FOLDED, LIKE `resolve_worldbook` AND UNLIKE `find_by_st_ref`. That split is the same
        one `find_by_st_ref` argues for and it lands on the other side here: this matches a name a
        human typed against a name a human typed, where "Sample Book" and "sample book" are the same
        book to everyone except a filesystem. `find_by_st_ref` matches SillyTavern's own key,
        where folding would MERGE two genuinely different documents.

        NOT SCOPED BY `source`, AND THAT IS THE ASK. A book swept in from SillyTavern and the same
        book re-imported from a file are one Library document; preserving separate lineages would
        create duplicate rows.

        Returns a LIST rather than a first match: one is the normal case, zero means create, and
        more than one is a state the caller must refuse rather than resolve (`AmbiguousName`). A
        `Document | None` signature cannot express the third and would silently pick.

        🔴 **NFC FIRST, BECAUSE `casefold` FOLDS CASE AND NOTHING ELSE.** "Café"
        typed as one precomposed `é` and "Café" typed as `e` + a combining acute are the same five
        glyphs on screen and two different strings to Python: length 4 against length 5, and
        `casefold()` does not close that. Without this, a name that round-trips through anything
        which decomposes lands a SECOND row that is indistinguishable from the first in the
        roster, that this method can never match again, and that never trips `AmbiguousName`
        either — because only one row matches, so the refusal that exists to catch a duplicate
        does not fire on the one duplicate a human cannot see.
        """
        key = _fold_name(name)
        if not key:
            return []                     # a blank name matches nothing, never everything
        return [d for d in self.list_documents()
                if d.kind == kind and _fold_name(d.name) == key]

    def _revise_existing(self, existing: "Document", content: dict, *, kind: str, note: str,
                         focus: dict | None, world_ref: str) -> tuple["Document", bool]:
        """Mint the next revision on a document an import matched. Returns `(document, changed)`.

        ONE LOCK FOR THE WHOLE SEQUENCE, not one per call inside it (3.4). This mints a revision
        and THEN rewrites the record it just wrote; a lock taken per-method would open a window
        between them in which a concurrent save reads the record and puts it back without the
        focus and world link written here. Re-entrant, so `add_revision` below takes the same lock
        again for free.

        SHARED BY BOTH IMPORT DOORS, and it was extracted at the moment there were two. The ST
        sweep (`import_from_st`) and the file import (`import_from_file`) differ in how they FIND
        the document - their key - and in nothing else. Two copies of this body would be two
        copies of the unchanged-document rule, the lock ordering and the `world_id` guard, and the
        copy that drifts is the one nobody is testing that week.
        """
        with self._lock(existing.id):
            # AN UNCHANGED DOCUMENT MINTS NOTHING, AND THIS IS LOAD-BEARING NOW THAT THE IMPORT
            # is a bulk sweep a user can repeat. Every press would otherwise stamp a revision on
            # every book and every card whether or not a word changed, and after three presses
            # the history available for rollback is ninety
            # identical entries. Same rule `materialize` states for an empty pass: a history full
            # of no-ops is a history nobody reads. Compared against the LATEST revision, because
            # that is what a re-import supersedes.
            try:
                if self.revision(existing.id).content == content:
                    # 🔴 RE-READ, NEVER THE SNAPSHOT THE CALLER MATCHED ON.
                    # `existing` came from a lookup before this lock. Re-read its current revision
                    # under the lock so the response does not publish a stale revision number;
                    # `get` costs one metadata read.
                    return self.get(existing.id), False
            except (MissingDocument, StoreCorrupt):
                pass                # unreadable latest - fall through and write a good one

            # `add_revision` re-reads the record and rewrites `latest`, so every metadata change
            # below has to happen after it or be clobbered by it.
            # 🔴 `kind` IS STAMPED HERE RATHER THAN BY THE THREE CALLERS, FOR THE REASON THIS
            # HELPER EXISTS AT ALL. Its own docstring: two copies of this body would be two copies
            # of the unchanged-document rule and the lock ordering, "and the copy that drifts is
            # the one nobody is testing that week". A merge base that one import door stamps and
            # another forgets is that failure with a silent symptom — the merge would then run
            # against a base older than the last import and report changes from the previous
            # import as local edits.
            self.add_revision(existing.id, content, note=note, kind=REV_IMPORT)
            doc = self.get(existing.id)
            if kind == "card":
                doc.focus = dict(focus or {})   # derived from the content just replaced
                new_ref = world_ref.strip()
                # RE-RESOLVED ONLY WHEN THE CARD ACTUALLY NAMES A DIFFERENT BOOK, AND THAT GUARD
                # IS LOAD-BEARING. Re-resolving unconditionally destroys the exact link 8.2
                # exists to protect: a book renamed HERE keeps the card's `world_ref` at the old
                # name, so resolving it again finds nothing and blanks a `world_id` that was
                # correct. The link is held by id precisely so a rename cannot break it - and
                # this is the one place a rename could sneak in and break it anyway.
                if new_ref != doc.world_ref.strip():
                    doc.world_ref = new_ref
                    doc.world_id = self.resolve_worldbook(new_ref)
                    # The incoming card is authoritative when it reports a changed link. Clear the
                    # local override so a prior explicit edit does not reapply over the new value.
                    doc.world_set = False
            self._write_meta(doc)
            if doc.kind == "worldbook":
                # Idempotent, and not a no-op: a card naming this book may have arrived between
                # the two imports, and this is the moment it should attach.
                self.link_orphan_cards(doc)
        return doc, True

    def import_from_file(self, content: dict, *, kind: str, name: str,
                         focus: dict | None = None, st_ref: str = "",
                         world_ref: str = "") -> tuple["Document", bool, bool]:
        """Import a document from a file. Returns `(document, created, changed)`.

        ⚠️ **`st_ref` IS THE IDENTITY THE FILE CLAIMS, NOT ONE WE TRUST** — personas only, 9.5.13.
        See `_import_persona_file`, which decides what may be done with a claim.

        Worldbooks match by normalized display name because a file has no stable external key.
        `find_by_name` refuses ambiguous matches. Cards are not matched by display name because
        their SillyTavern identity is the avatar filename.

        THE PRE-IMPORT REVISION IS THE UNDO. Landing on an existing document is not destructive:
        revisions 0..N stay in the picker and `rollback` reaches every one of them. That is what
        makes "apply it over the top" safe to do without asking.

        Worldbook matching differs from card matching:

          * A worldbook's name is its identity here and in SillyTavern. A card links to its
            book by NAME (`world_ref`), and `resolve_worldbook` two methods up already matches
            books on the case-folded name. Matching a book by name is the key this codebase
            uses everywhere else, not a new one invented for this door.
          * A card's identity there is its avatar filename, never its display name. Two
            genuinely different characters can share one - which is exactly why `find_by_st_ref`
            exists, and why the roster has a disambiguation affordance (`wbDupName`) for the
            state where two rows carry one name. Merging on a card's name would put one
            character's text into another character's history.

        """
        if kind == "persona":
            return self._import_persona_file(content, name=name, st_ref=st_ref)
        if kind != "worldbook":
            return self.create(content, name=name, kind=kind, source="upload",
                               focus=focus, world_ref=world_ref), True, True
        # Serialize lookup and creation across the library. Without this lock, simultaneous imports
        # of a new name could both observe no match and create ambiguous duplicate rows.
        #
        # ⚠️ `IMPORT_LOCK` IS GLOBAL AND EVERYTHING ELSE HERE IS PER DOCUMENT, because the
        # invariant is about the LIBRARY rather than about a file. It is taken first, never
        # reached for while a document lock is held, and held across one metadata scan plus one
        # mint. See `models.IMPORT_LOCK` for the ordering rule.
        with store_lock(self.root, IMPORT_LOCK):
            matches = self.find_by_name(kind, name)
            if len(matches) > 1:
                raise AmbiguousName(kind, name, len(matches))
            if not matches:
                return self.create(content, name=name, kind=kind, source="upload",
                                   focus=focus, world_ref=world_ref), True, True
            # Held here for the reason `import_from_st` records one method down: the lock belongs
            # to the mutator, not only to the helper, and it is re-entrant.
            with self._lock(matches[0].id):
                doc, changed = self._revise_existing(matches[0], content, kind=kind,
                                                     note="re-imported from a file",
                                                     focus=focus, world_ref=world_ref)
                return doc, False, changed

    def _import_persona_file(self, content: dict, *, name: str,
                             st_ref: str) -> tuple["Document", bool, bool]:
        """Import a persona file without trusting its claimed avatar filename.

        A persona's SillyTavern identity is its avatar filename, but file content is not evidence
        that the file belongs to an existing persona. A matching `st_ref` is accepted only when
        the store already has a SillyTavern-sourced row for it; that row receives a new revision.
        Otherwise the `avatar` claim is removed and the file becomes an unlinked document whose
        first send creates a new persona. `Document.st_ref` remains the sole stored identity.
        """
        with store_lock(self.root, IMPORT_LOCK):
            owner = self.find_by_st_ref("persona", st_ref) if st_ref.strip() else None
            if owner is None:
                body = {k: v for k, v in content.items() if k != "avatar"}
                return self.create(body, name=name, kind="persona", source="upload"), True, True
            # The document lock is taken HERE, not delegated — `import_from_st` records why.
            with self._lock(owner.id):
                doc, changed = self._revise_existing(owner, content, kind="persona",
                                                     note="re-imported from a file",
                                                     focus=None, world_ref="")
                return doc, False, changed

    def import_from_st(self, content: dict, *, kind: str, st_ref: str, name: str,
                       focus: dict | None = None,
                       world_ref: str = "") -> tuple[Document, bool]:
        """Import a document pushed from SillyTavern. Returns `(document, created)`.

        `st_ref` identifies the external document. A repeated push revises the matching row and
        preserves its revision history; a new reference creates a row. The Library display name is
        not replaced by an incoming push. Rebuilt books without a stable relationship use the
        separate assembly path and create a new document.
        """
        # Serialize the lookup-and-create decision across the library so concurrent pushes cannot
        # create duplicate rows for one `st_ref`. The per-document lock also spans revision and
        # metadata updates; it is re-entrant because `_revise_existing` uses the same lock.
        with store_lock(self.root, IMPORT_LOCK):
            existing = self.find_by_st_ref(kind, st_ref)
            if existing is None:
                return self.create(content, name=name, kind=kind, source="st", st_ref=st_ref,
                                   focus=focus, world_ref=world_ref), True
            with self._lock(existing.id):
                doc, _changed = self._revise_existing(existing, content, kind=kind,
                                                      note="re-imported from SillyTavern",
                                                      focus=focus, world_ref=world_ref)
                return doc, False

    def outbound(self, doc: Document, content: dict) -> dict:
        """Return a copy of card content with current metadata applied at the export boundary.

        Resolve `world_id` to the current book name and restore `Document.focus`. Missing linked
        books are left unchanged unless `world_set` explicitly records an unlink. An empty focus
        uses the centered default. The input revision is never mutated.
        """
        if doc.kind != "card":
            return content
        out = content
        if doc.world_id:
            try:
                out = png_card.with_world_name(out, self.get(doc.world_id).name)
            except (MissingDocument, StoreCorrupt):
                # NARROW, and caught rather than raised: the book being gone is a fact about a
                # DIFFERENT document and must not turn this card's export into a 404 or a 500.
                pass
        elif doc.world_set and png_card.world_name(out):
            # ⚠️ **ONLY WHEN THERE IS SOMETHING TO BLANK.** `with_world_name` will happily CREATE
            # an `extensions` block, which is right when there is a name to write and wrong when
            # there is not: pressing *— no world book —* on a card that never named one would
            # otherwise grow a field on its first round trip, which is exactly what
            # `test_an_unlinked_card_exports_exactly_as_it_arrived` forbids. The SEND still says
            # `""` in that case (`world_out`): exports preserve the input shape while sends apply
            # an explicit unlink.
            out = png_card.with_world_name(out, "")
        return png_card.with_focus(out, doc.focus)

    def world_out(self, doc: Document) -> str | None:
        """Return the SillyTavern world-link value, or `None` when no write is intended.

        Unedited imported links return `None`. An explicit unlink returns an empty string. For a
        selected book, return its SillyTavern `st_ref`, falling back to its local name when it has
        never been pushed. This differs from `outbound`, which builds an export using local names.
        """
        if doc.kind != "card" or not doc.world_set:
            return None
        if not doc.world_id:
            return ""
        try:
            book = self.get(doc.world_id)
        except (MissingDocument, StoreCorrupt):
            # The book went between the record being written and this read. Say nothing rather
            # than "no book": an unreadable record is not an instruction to unlink the card.
            return None
        return book.st_ref.strip() or book.name.strip()

    def set_world(self, doc_id: str, book_id: str) -> Document:
        """Point this card at a worldbook Vocalis holds, or explicitly clear the association.

        Write both `world_id` and `world_ref`: orphan-link reconciliation uses the name to resolve
        links after imports and renames. This metadata-only change does not mint a content revision.

        ⚠️ **THE TARGET IS CHECKED TO BE A WORLDBOOK BEFORE ANYTHING IS WRITTEN.** A `book_id`
        naming a card, a persona, or a document that is already gone raises rather than filing a
        `world_id` that points at something which is not a book — a dangling id is the state
        `delete`'s own docstring calls worse than no link at all. That check is a plain read: the
        lock here is the CARD's, so a book deleted in the window between the check and the write
        can still leave a dead id behind. That is the same narrow race `wbedit_document` already
        catches on the read side and `world_out` answers `None` for: it shows as *(not in
        Vocalis)* and is repaired by picking again, which is why it is worth no more than this.
        """
        want = str(book_id or "").strip()
        name = ""
        if want:
            book = self.get(want)               # MissingDocument if it is gone — a 404, correctly
            if book.kind != "worldbook":
                raise ValueError("that document is not a world book")
            name = book.name
        with self._lock(doc_id):
            doc = self.get(doc_id)              # 🔴 read first — never persist from nothing
            if doc.kind != "card":
                raise ValueError("only a character card has a world book")
            doc.world_id = want
        # `world_ref` records the name associated with the selected `world_id`.
            doc.world_ref = name
            doc.world_set = True
            self._write_meta(doc)
        return doc

    def set_focus(self, doc_id: str, focus: dict[str, float] | None) -> Document:
        """m4o — which square of the picture is the face. `None` or `{}` means the centered square.

        🔴 **NO REVISION IS MINTED, AND THAT IS THE ESTABLISHED RULE HERE, NOT A SHORTCUT.** The
        focus rect describes the IMAGE, and the image is an Asset rather than document text —
        `Document.focus`'s own comment has said so since §4.3. It reaches SillyTavern the way the
        world name does: injected at the boundary by the export/send path, exactly as
        `_with_current_world` injects `data.extensions.world`. Minting a revision per drag would
        also fill revision history with entries for a control still being adjusted.

        ⚠️ It does NOT set `avatar_dirty`. The picture has not changed — only the window onto it —
        and the rect travels as a card field, which costs a few bytes rather than 700 KB.
        """
        with self._lock(doc_id):
            doc = self.get(doc_id)
            doc.focus = {k: float(focus[k]) for k in ("x", "y", "w")} if focus else {}
            self._write_meta(doc)
        return doc

    def put_avatar(self, doc_id: str, blob: bytes, *, ref: str = "",
                   dirty: bool = True) -> Document:
        """m4o — replace the stored picture, and record that SillyTavern's copy is now behind.

        🔴 **STORED VERBATIM, LIKE EVERY OTHER WRITE OF THIS ASSET.** Nothing here decodes the
        image and nothing here may start to (§4.3): an animated PNG must survive and so must
        foreign ancillary chunks. The caller checks the PNG signature and that is the whole of
        the validation.

        `ref` is SillyTavern's stamp for the bytes being handed over — see `Document.avatar_ref`.
        The Library's own upload button passes none, which is correct: a picture chosen here
        did not come from a file over there, so we hold no stamp for it and must not invent one.

        🔴 **`dirty=False` IS FOR A PICTURE ARRIVING *FROM* SILLYTAVERN, AND IT IS NOT A TUNING
        KNOB.** `avatar_dirty` means "our copy is ahead of theirs"; setting it for bytes we just
        received from them would queue a send that pushes their own picture back at them. The ST
        import path (`/pair/documents/<id>/avatar`) has always avoided this by calling `put_asset`
        directly and skipping this method entirely — which also skipped `drop_thumbnails`, so a
        replaced face left its old crops behind. The flag is a parameter now so that path can have
        the housekeeping without the lie.

        🔴 **IDENTICAL BYTES ARE NOT A CHANGE, AND SAYING SO IS LOAD-BEARING NOW.** 7.3.9 lets the
        sweep re-fetch a picture on a stamp it cannot fully trust (a card file's `ctimeMs` moves
        for reasons other than the image), so the same bytes WILL arrive again. Taking the old
        path for them would set `avatar_dirty` — and `avatar_dirty` means "SillyTavern is behind",
        which would make the next send push a re-encode of the unchanged picture back through
        their Jimp round trip. That is the exact degradation `avatar_dirty`'s comment says the flag
        exists to prevent, arriving through the door opened to fix a different bug.

        ⚠️ The stamp is still recorded on that path. It is the whole point: the re-fetch happened
        BECAUSE we had no stamp or a stale one, and leaving it unwritten means re-fetching forever.
        """
        # 🔴 THE `avatar_dirty` WRITE IS THE FINDING'S OWN WORKED EXAMPLE (§3.4). Read the record,
        # set the flag, write the whole record back — with a concurrent `rename` or `set_focus`
        # doing the same, the second writer restores `avatar_dirty=False` and the new picture is
        # never carried to SillyTavern. Silent, and precisely the loss the flag exists to prevent.
        # The lock spans the asset write too, so a `drop_thumbnails` cannot land between a
        # concurrent `thumbnail()` build and its sweep.
        with self._lock(doc_id):
            same = self.has_asset(doc_id, AVATAR) and self.asset(doc_id, AVATAR) == blob
            if not same:
                self.put_asset(doc_id, AVATAR, blob)
                # m4p / §9a.10 — the old face's crops are dead the instant the picture is replaced.
                # The key would have caught it anyway (mtime moved), so this is hygiene rather than
                # correctness: it stops crops of a character's PREVIOUS portrait sitting in the
                # store until something happens to read the row again.
                self.drop_thumbnails(doc_id)
            doc = self.get(doc_id)
            if dirty and not same:
                doc.avatar_dirty = True
            doc.avatar_ref = str(ref or "")
            self._write_meta(doc)
        return doc

    def clear_avatar_dirty(self, doc_id: str) -> None:
        """A send carried the picture and SillyTavern accepted it. See `Document.avatar_dirty` —
        only a SUCCESS clears this, so a failed send still carries the image next time."""
        try:
            with self._lock(doc_id):
                doc = self.get(doc_id)
                if doc.avatar_dirty:
                    doc.avatar_dirty = False
                    self._write_meta(doc)
        except (MissingDocument, StoreCorrupt):
            return                              # deleted under us; nothing to record

    def adopt_st_ref(self, doc_id: str, ref: str) -> None:
        """Store the key returned after SillyTavern creates this document.

        `_card_plan` chooses create or update from whether `st_ref` is empty, so recording the
        returned key makes subsequent sends update the created document.

        ⚠️ **ONLY ONTO AN EMPTY `st_ref`.** An existing key is SillyTavern's own identity for a
        document we swept from it (§8.1), and overwriting it would repoint a whole history at a
        different file on their disk. A report naming a ref for a document that already has one is
        a bug or a stale run, and the right response is to keep what we know.

        `source` remains unchanged: this card came from a file (or was authored in Vocalis).
        `find_by_st_ref`
        filters on `source == "st"`, so leaving it alone also keeps a later sweep from folding this
        document's history into the freshly-created character's.
        """
        key = (ref or "").strip()
        if not key:
            return
        try:
            with self._lock(doc_id):
                doc = self.get(doc_id)
                if doc.st_ref.strip():
                    return
                doc.st_ref = key
                self._write_meta(doc)
        except (MissingDocument, StoreCorrupt):
            return                              # deleted under us; nothing to record

    def rename(self, doc_id: str, name: str) -> Document:
        with self._lock(doc_id):
            doc = self.get(doc_id)              # 🔴 read first — never persist from nothing
            doc.name = name
            self._write_meta(doc)
            # A rename can complete a link that import could not — see `link_orphan_cards`. It
            # can never BREAK one: existing links are held by id, which is the whole of §8.2.
            if doc.kind == "worldbook":
                self.link_orphan_cards(doc)
        return doc

    def delete(self, doc_id: str) -> None:
        """Remove a document and everything under it — revisions, passes, proposals.

        Deletion is permanent; the store has no soft-delete or trash behavior.

        🔴 **DELETING A WORLDBOOK RELEASES THE CARDS THAT POINTED AT IT (§8.2).** Left alone, each
        one keeps an id that resolves to nothing, and a dangling id is worse than no link at all:
        the card is not in the book's filter (the book is gone from the dropdown), and it is not
        in `— not associated —` either, because that asks for an EMPTY `world_id` and this one is
        merely dead. The character becomes reachable only through "All worldbooks", with nothing
        anywhere saying why — and re-importing the same book does not bring it back, because
        `link_orphan_cards` refuses to touch a card that already claims a link.

        ⚠️ **`world_ref` SURVIVES, and that is the point** — it is what the card itself says, and
        keeping it means re-importing the book relinks the card automatically. Clearing both would
        turn a recoverable state into a permanent one.

        ⚠️ **The release runs WITHOUT reading the document being deleted.** Checking `kind` first
        would mean `get()`, and `get()` raises on an unreadable record — which would make a
        corrupt document undeletable, taking away the one action that recovers from it. Matching
        on the id needs no such read and is exact anyway: only a worldbook can be on the far end
        of a `world_id`, so a card's id matches nothing and the pass is a no-op.
        """
        # ⚠️ THE LOCK SPANS THE WHOLE REMOVAL, and the ordering it establishes is the one
        # `models.store_lock` documents: this document, then each released CARD, then the
        # dismissed list. Nothing in the store takes them the other way round.
        with self._lock(doc_id):
            if not vault_fs.exists(self._dir(doc_id)):
                raise MissingDocument(doc_id)
            # §8.2b — remember the ST identity BEFORE the tree goes, or there is nothing left to
            # remember it by. Read defensively: a corrupt record must stay deletable (see above),
            # so a document we cannot parse is simply deleted without being dismissed.
            try:
                ref = self.get(doc_id).st_ref
            except (MissingDocument, StoreCorrupt, OSError, ValueError):
                ref = ""
            self._release_cards(doc_id)
            vault_fs.rmtree(self._dir(doc_id))
            # 🔴 `rmtree` IS `ignore_errors=True` ON BOTH ARMS, SO IT CANNOT REPORT A PARTIAL
            # REMOVAL. On Windows a file another thread holds open — one of the forty concurrent
            # /thumb and /avatar GETs the roster fires is enough — is skipped silently and its
            # parent rmdir fails. The old code then returned normally and the route answered
            # {"ok": true} while `documents/<id>/` survived holding revisions and possibly the
            # card PNG. Nothing could see it afterward (`list_documents` skips a directory with
            # no meta.json) and nothing sweeps it, so the user's content stayed on disk forever,
            # invisible — the exact opposite of what the paragraph at the top of this docstring
            # promises. Checked here rather than inside `vault_fs`, where `ignore_errors` is right
            # for its other callers.
            #
            # ⚠️ INSIDE THE LOCK, so the emptiness this asserts is a fact and not a snapshot: a
            # concurrent writer on this document cannot recreate the tree between the `rmtree` and
            # the check and turn a real partial removal into a reported success.
            if vault_fs.exists(self._dir(doc_id)):
                raise StoreCorrupt(
                    f"{doc_id}: could not be fully deleted — something still holds a file open. "
                    "Close any other Vocalis tab and try again.")
            # ⚠️ AFTER the check, never before: dismissing a document that is still on disk would
            # decline the SillyTavern re-push that puts a visible row back, turning a retryable
            # failure into a document that is neither gone nor reachable.
            if ref:
                self.dismiss(ref)

    # ── §8.2b dismissed ST documents ─────────────────────────────────────────

    def _dismissed_path(self) -> Path:
        return self.root / DISMISSED

    def _read_dismissed(self) -> list[str]:
        """The list, or a raised `OSError` if it could not be READ. The distinction this makes is
        the whole point: "the file says nothing is dismissed" and "I could not find out" are the
        same value and must not be the same answer to a writer. See `dismiss`.

        Content that parses to the wrong shape still degrades to `[]` — that is corruption, not
        an unknown, and the safe reading of a corrupt file is the recoverable one.
        """
        p = self._dismissed_path()
        if not vault_fs.exists(p):
            return []
        raw = json.loads(vault_fs.read_text(p))          # OSError propagates, ValueError below
        return [str(x) for x in raw] if isinstance(raw, list) else []

    def dismissed(self) -> list[str]:
        """Every deleted `st_ref`, oldest first. Never raises — a corrupt file means
        "nothing is dismissed", which is the safe failure: the next import brings documents
        back, which is recoverable. The opposite failure silently hides them."""
        try:
            return self._read_dismissed()
        except (OSError, ValueError):
            return []

    def _forever_path(self) -> Path:
        return self.root / DISMISSED_FOREVER

    def _read_forever(self) -> list[str]:
        """The purged list, or a raised `OSError` if it could not be READ — the same distinction
        `_read_dismissed` makes, and for the same reason: a read-modify-write must not treat "I
        could not find out" as "it is empty"."""
        p = self._forever_path()
        if not vault_fs.exists(p):
            return []
        raw = json.loads(vault_fs.read_text(p))          # OSError propagates, ValueError below
        return [str(x) for x in raw] if isinstance(raw, list) else []

    def dismissed_forever(self) -> list[str]:
        """Every `st_ref` purged from the bin. Never raises.

        ⚠️ The safe failure is `[]`: a corrupt file may allow a later import to restore an item,
        which is recoverable. Treating a corrupt file as "everything is purged" would hide items.
        """
        try:
            return self._read_forever()
        except (OSError, ValueError):
            return []

    def is_dismissed(self, st_ref: str) -> bool:
        # Exact match, like `find_by_st_ref` and unlike `resolve_worldbook`. SillyTavern keys are
        # case-sensitive; folding could dismiss two distinct documents.
        #
        # 🔴 BOTH LISTS (9.7.0). A purged ref is MORE dismissed, not less — the whole point of
        # ✕ Delete permanently is that the import never brings it back — so the decline has to read
        # both files. This is the one line that makes the second file a store rather than a graveyard.
        if not st_ref:
            return False
        return st_ref in set(self.dismissed()) or st_ref in set(self.dismissed_forever())

    def dismiss(self, st_ref: str) -> None:
        """Add one `st_ref` to the list. 🔴 **READ FAILURES ABORT; THEY DO NOT TRUNCATE.**

        A read failure aborts this read-modify-write. Treating an unreadable file as empty could
        overwrite prior dismissals and allow them to return on a later import. Propagate the error
        so the caller can retry without losing the existing list. `DISMISSED_LOCK` also prevents
        concurrent updates from dropping one another; the file is store-wide rather than owned by
        a single document.
        """
        with store_lock(self.root, DISMISSED_LOCK):
            refs = self._read_dismissed()
            if st_ref in refs:
                return
            refs.append(st_ref)
            # Atomic, like every other writer in this module. `write_text` here was a bare
            # truncate-then-write on an un-migrated install, contradicting the comment at the top
            # of the file that every writer stages to a temp sibling.
            vault_fs.write_json_atomic(self._dismissed_path(), refs, indent=1)

    def restore(self, st_ref: str = "") -> int:
        """Undismiss one ref, or every ref when called with none. Returns how many were freed."""
        # ⚠️ `dismissed()` (not `_read_dismissed`) is deliberate here, and it is safe in a way
        # `dismiss` was not: a read failure yields `[]`, `keep` is then also empty, the length
        # test short-circuits, and nothing is written. Restoring is the recoverable direction —
        # answering "freed nothing" to a caller who can press the button again costs nothing.
        with store_lock(self.root, DISMISSED_LOCK):
            refs = self.dismissed()
            keep = [] if not st_ref else [r for r in refs if r != st_ref]
            if len(keep) == len(refs):
                return 0
            vault_fs.write_json_atomic(self._dismissed_path(), keep, indent=1)
            return len(refs) - len(keep)

    def purge(self, st_ref: str) -> bool:
        """✕ Delete permanently — take one ref OUT of the bin while keeping it declined for ever.

        🔴 **NOTHING FURTHER IS DESTROYED.** The document and every revision went at the delete;
        a bin row is SillyTavern's own key and nothing else. What this costs is the `Undelete`
        button — after it, the only way back is to re-create the document in SillyTavern under a
        new key, or to edit the store by hand. The confirm in the Library says exactly that.

        🔴 **APPEND TO `forever` FIRST, THEN REMOVE FROM `dismissed`.** Both writes are atomic and
        both are under one lock, so an interruption between them can only leave the ref in BOTH
        lists — which reads as "still dismissed, still in the bin", i.e. the state before the press.
        The other order would leave it in neither on a crash: silently undismissed, and the next
        ⟳ Import would bring back a document that was just deleted twice.

        ⚠️ `_read_*` (not the swallowing `dismissed()`/`dismissed_forever()`) on both reads, for the
        reason `dismiss` records at length: a transient read failure answering `[]` here would write
        a one-element `forever` over every previous purge, and un-decline the lot.

        Returns True when the ref really was in the bin; False leaves both files untouched.
        """
        with store_lock(self.root, DISMISSED_LOCK):
            refs = self._read_dismissed()
            if st_ref not in refs:
                return False
            forever = self._read_forever()
            if st_ref not in forever:
                forever.append(st_ref)
                vault_fs.write_json_atomic(self._forever_path(), forever, indent=1)
            vault_fs.write_json_atomic(self._dismissed_path(), [r for r in refs if r != st_ref], indent=1)
            return True

    def _release_cards(self, book_id: str) -> int:
        """Clear `world_id` on every card linked to `book_id`, keeping `world_ref`. See `delete`.

        🔴 **RE-READ UNDER EACH CARD'S OWN LOCK, exactly as `link_orphan_cards` does** — the
        record from the listing is a snapshot, and writing it back whole would carry a stale
        `avatar_dirty` or `name` over a concurrent `put_avatar` or `rename` (§3.4). The link is
        re-tested against the fresh record so a card that has since been relinked to a DIFFERENT
        book is left alone.

        Clear `world_set` with `world_id`. The flag authorizes a send to write an explicit unlink;
        leaving it set after deleting the book would make `world_out` return `""` and remove the
        association from the remote card. Deleting a Library row is not an instruction about the
        remote store. `world_ref` survives so re-importing the book can relink the card.
        """
        n = 0
        for d in self.list_documents():
            if d.kind != "card" or d.world_id != book_id:
                continue
            try:
                with self._lock(d.id):
                    fresh = self.get(d.id)
                    if fresh.kind != "card" or fresh.world_id != book_id:
                        continue
                    fresh.world_id = ""
                    fresh.world_set = False
                    self._write_meta(fresh)
            except (MissingDocument, StoreCorrupt, OSError):
                continue                       # same posture as `link_orphan_cards`
            n += 1
        return n

    # ── revisions ────────────────────────────────────────────────────────────

    def revisions(self, doc_id: str) -> list[int]:
        """Every revision number that exists, ascending. The filesystem is the authority."""
        d = self._dir(doc_id) / REV_DIR
        if not vault_fs.exists(d):
            return []
        out = []
        for child in vault_fs.listdir(d):
            stem = Path(child).stem
            if stem.isdigit():
                out.append(int(stem))
        return sorted(out)

    def revision_index(self, doc_id: str) -> list[dict]:
        """Return revision labels in ascending order with creation time and lineage metadata.

        `created_at` comes from the revision contents, not the file mtime. Re-encryption or other
        storage maintenance can rewrite files without changing when the revisions were created.

        ⚠️ **THE COST IS ONE FULL READ PER REVISION**, because `created_at` lives inside the JSON
        with the content. Thirty revisions of a large book is a few hundred milliseconds, paid once
        when the editor opens. If this becomes costly, add a sidecar index written by
        `add_revision`; do not derive timestamps from file metadata.

        A revision that will not parse is SKIPPED rather than raising: one corrupt file must not
        make the whole picker unopenable; `revision()` reports the error if that item is selected.
        """
        out: list[dict] = []
        for n in self.revisions(doc_id):
            try:
                r = Revision.from_dict(_read_json(self._rev(doc_id, n)))
            # `StoreCorrupt` is what `_read_json` raises for unparseable JSON — the specific one,
            # and the reason `ValueError` alone silently did not catch it.
            except (OSError, StoreCorrupt, ValueError, KeyError, TypeError):
                out.append({"n": n, "created_at": None, "note": "", "from_revision": None})
                continue
            # 🔴 `pass_id` IS HOW THE BROWSER KNOWS A PASS HAS ALREADY BEEN APPLIED (§9a.16).
            # Restoring a review queue after a refresh has to skip passes that already became a
            # revision, or it would offer the same changes again and a second Apply would mint a
            # duplicate revision.
            out.append({"n": r.n, "created_at": r.created_at, "note": r.note,
                        "from_revision": r.from_revision, "pass_id": r.pass_id,
                        # 9.6 — the picker marks which revisions were imports, because that is the
                        # lineage a merge is measured against and the user should be able to see it.
                        "kind": r.kind})
        return out

    #: Notes the three import doors wrote before `Revision.kind` existed (9.6). Matched only by
    #: `merge_base`'s fallback, and never written by anything: new revisions carry the field.
    _LEGACY_IMPORT_NOTES = ("import", "re-imported")

    def add_merged_revision(self, doc_id: str, content: dict, *, note: str,
                            from_revision: int) -> Revision:
        """Mint the result of a merge, and mark it as the new reconciliation point.

        🔴 A merge result is an import baseline for the next incoming file. Minting it with an
        empty `kind` would leave `merge_base`
        pointing at the import BEFORE this one, so the following merge would re-report every
        change this one settled as an edit of the current document.

        ⚠️ **AND IT KEEPS THE `kind` VOCABULARY INSIDE THE STORE.** The web layer decides what a
        merge IS; it does not get to decide how the store labels one. `_revise_existing` stamps
        its own for the same reason one method up.

        `require_head` is not optional here and is not belt-and-braces: the choices being applied
        were made against the revision the browser was looking at, and a head that moved under it
        invalidates every one of them by index. See `RevisionConflict`.
        """
        return self.add_revision(doc_id, content, note=note, from_revision=from_revision,
                                 kind=REV_IMPORT, require_head=True)

    def merge_base(self, doc_id: str) -> Revision:
        """Return the newest imported revision as the comparison base for an incoming file.

        New revisions use `kind`; legacy notes are recognized for histories created before that
        field existed. Revision 0 is the fallback when no import marker is available. An older
        base can report extra conflicts, but cannot silently hide edits.
        """
        # ⚠️ **NEWEST FIRST, AND THAT IS A COST DECISION RATHER THAN A STYLE ONE.** `created_at`
        # and `kind` live inside the revision file next to its whole content, so every candidate
        # examined is a full read of a book — the cost `revision_index` records for the picker.
        # Walking down from the head stops at the first match, which is the head itself or near it
        # in every normal case; walking up would read the entire history to reach the same answer.
        for n in reversed(self.revisions(doc_id)):
            try:
                rev = Revision.from_dict(_read_json(self._rev(doc_id, n)))
            except (OSError, StoreCorrupt, ValueError, KeyError, TypeError):
                continue                    # unreadable — `revision_index` skips these too
            if rev.kind == REV_IMPORT or rev.note.strip().casefold().startswith(
                    self._LEGACY_IMPORT_NOTES):
                return rev
        # Nothing claimed to be an import — a document whose revision 0 was written before this
        # field and whose note was later reworded. `revision` raises `MissingDocument` if even
        # that is gone, which is the honest answer: there is no lineage to merge against.
        return self.revision(doc_id, 0)

    def revision(self, doc_id: str, n: int | None = None) -> Revision:
        """One revision; `None` means the latest."""
        if n is None:
            n = self.get(doc_id).latest
        p = self._rev(doc_id, n)
        if not vault_fs.exists(p):
            raise MissingDocument(f"{doc_id}@{n}")
        return Revision.from_dict(_read_json(p))

    def latest_on_disk(self, doc_id: str) -> int:
        """The highest revision number actually present, which is what `add_revision` will build
        on. Read from the filesystem for the same reason `add_revision` numbers from it: after a
        crash between the revision write and the metadata write, `doc.latest` is the stale one,
        and a conflict check that trusted it would wave through the very edit it exists to stop.
        """
        existing = self.revisions(doc_id)
        return max(existing) if existing else 0

    def _require_latest(self, doc_id: str, base_revision: int) -> None:
        """Guard for the two methods that rebuild the head from a base. See `RevisionConflict`."""
        latest = self.latest_on_disk(doc_id)
        if base_revision != latest:
            raise RevisionConflict(doc_id, base_revision, latest)

    def add_revision(self, doc_id: str, content: dict, *, note: str,
                     from_revision: int | None = None, pass_id: str = "", kind: str = "",
                     require_head: bool = False) -> Revision:
        """Mint revision N+1; all content writes pass through this method.

        `from_revision` records lineage but does not validate the current head. `require_head`
        opts into that check for callers that must reject stale edits; rollback intentionally
        builds from an older revision. Validate and allocate under the document lock, and choose
        N from the files on disk so a crash-stale metadata value cannot reuse a revision number.
        After the revision is durable, carry forward only drafts stamped against its parent.
        """
        with self._lock(doc_id):
            doc = self.get(doc_id)              # raises if absent — never write into nothing
            if require_head:
                self._require_latest(doc_id, from_revision if from_revision is not None else -1)
            existing = self.revisions(doc_id)
            n = (max(existing) if existing else 0) + 1
            rev = Revision(n=n, content=content, note=note, from_revision=from_revision,
                           pass_id=pass_id, kind=kind)
            vault_fs.write_json_atomic(self._rev(doc_id, n), rev.to_dict())
            doc.latest = n
            self._write_meta(doc)
            # `n - 1` is the head this revision was built on, i.e. the bytes the user was looking
            # at. A draft stamped at anything else is one `drafts()` already refuses to serve, and
            # carrying it would resurrect edits against a base they were never typed over.
            self._carry_drafts(doc_id, n - 1, n)
            return rev

    def rollback(self, doc_id: str, n: int) -> Revision:
        """Roll back to revision `n` by minting a NEW revision whose content equals it.

        Rollback preserves all existing history and records the source number in `from_revision`.

        ⚠️ The lock spans the read of `n` as well as the mint, so the content that becomes the new
        head is the content revision `n` held at the moment the decision was taken.
        """
        with self._lock(doc_id):
            old = self.revision(doc_id, n)
            return self.add_revision(doc_id, copy.deepcopy(old.content),
                                     note=f"rollback to revision {n}", from_revision=n)

    # ── materialize ──────────────────────────────────────────────────────────

    def materialize(self, doc_id: str, base_revision: int, proposals: Iterable[Proposal],
                    *, pass_id: str = "", note: str = "") -> Revision | None:
        """Apply the accepted proposals to `base_revision` and mint the next revision.

        Returns None when nothing was accepted — an empty pass must not mint a revision identical
        to its parent, because a history full of no-op entries is a history nobody reads.

        🔴 Work on a deep copy because `core/locator.set_at` mutates in place. This keeps stored
        revisions immutable when callers share a loaded revision object.

        Apply `Proposal.text`: it contains the approved or edited value, while `None` marks a
        rejected proposal and is skipped.

        🔴 **`_require_latest` AND THE MINT ARE ONE OPERATION — §1.1 IS ONLY HONEST UNDER A LOCK
        (§3.4).** The conflict check reads `latest_on_disk` and `add_revision` allocates from it;
        with the lock dropped in between, two Applies landing together both read latest=4, both
        pass the check, and both mint revision 5. Optimistic concurrency needs a serialization
        point to be optimistic ABOUT, and this is it.
        """
        with self._lock(doc_id):
            self._require_latest(doc_id, base_revision)
            base = self.revision(doc_id, base_revision)
            content = copy.deepcopy(base.content)
            applied = 0
            for p in proposals:
                text = p.text
                if text is None:
                    continue
                try:
                    set_at(content, p.locator, text)
                except (KeyError, IndexError, TypeError) as exc:
                    # The document's shape changed under a pass — possible only if a revision was
                    # minted between the pass starting and being reviewed. Loud: silently dropping
                    # the field would report "applied" for an edit that never landed.
                    raise MissingDocument(
                        f"{doc_id}: locator {p.locator} no longer addresses this "
                        f"document") from exc
                applied += 1
            if not applied:
                return None
            return self.add_revision(doc_id, content, note=note or f"pass {pass_id}".strip(),
                                     from_revision=base_revision, pass_id=pass_id)

    def apply_edits(self, doc_id: str, base_revision: int,
                    edits: Iterable[tuple[tuple, Any]], *, note: str = "") -> Revision | None:
        """Write typed values at locators and mint the next revision — 7.0-m5g / §9a.26.

        The sibling of `materialize`, for the half of this product that has nothing to do with the
        model. Same copy-then-write policy, same "nothing applied means no revision" rule.

        🔴 **IT EXISTS BECAUSE A `Proposal` CANNOT CARRY `None`, AND `None` IS A VALUE HERE.**
        `materialize` skips a proposal whose `.text` is None — correct there, where None means
        "this row was rejected, apply nothing". But `sticky` is TRI-STATE: `null` is *not set*,
        `0` is *explicitly none*, and they behave differently in SillyTavern. Routing a settings
        edit through a Proposal would make "put this back to not-set" a silent no-op — the save
        would report success, mint a revision, and leave the old value in place. `Proposal` is
        also documented as holding document TEXT (I16), and a boolean is not that.

        `edits` is `[(locator, value)]` and the values are already validated:
        `formats.entryfields.coerce` is the type guard, and it runs at the route so a bad value is
        a 400 rather than a half-written revision.

        🔴 **THIS IS THE ONE MINT THAT CLEARS THE DRAFT INSTEAD OF KEEPING IT (§1.2).**
        `add_revision` carries pending typing onto the new revision, because every other minting
        path leaves it unsaved and the user still wants it. Here the pending text IS what was just
        saved, so carrying it forward would restore edits already inside the revision — harmless
        looking, because the text matches, until a rollback makes the draft silently
        re-applies them over the older bytes.

        ⚠️ **CLEARED HERE, UNDER THE SAME LOCK AS THE MINT, NOT BY THE ROUTE AFTERWARD.** The
        route's own `clear_drafts` call is now redundant (and harmless — it is idempotent). Doing
        it inside the lock closes the window where a crash between the two left the draft carried
        onto a revision that already contains it, and it means a save from ANY client ends clean,
        including one whose tab closes on the response.

        ⚠️ **Only when a revision was actually minted.** "Nothing changed" returns None without
        minting, and wiping the user's pending edits on a no-op save would be the discard button
        firing by accident.
        """
        with self._lock(doc_id):
            self._require_latest(doc_id, base_revision)
            base = self.revision(doc_id, base_revision)
            content = copy.deepcopy(base.content)
            applied = 0
            for locator, value in edits:
                try:
                    set_at(content, tuple(locator), value)
                except (KeyError, IndexError, TypeError) as exc:
                    raise MissingDocument(
                        f"{doc_id}: locator {tuple(locator)} does not address this "
                        f"document") from exc
                applied += 1
            if not applied:
                return None
            rev = self.add_revision(doc_id, content, note=note or "hand edit",
                                    from_revision=base_revision)
            self.clear_drafts(doc_id)
            return rev

    # ── the model log (7.0 §6.4.3) ───────────────────────────────────────────

    def _log(self, doc_id: str, n: int) -> Path:
        return self._dir(doc_id) / LOG_DIR / f"{n:04d}.jsonl"

    def log_revision(self, doc_id: str) -> int:
        """Which version's log a run happening RIGHT NOW belongs to — the current latest."""
        return self.get(doc_id).latest

    def append_log(self, doc_id: str, n: int, records: Iterable[dict]) -> None:
        """Append JSONL rows to version `n`'s log.

        🔴 **READ-MODIFY-WRITE, NOT AN APPEND HANDLE, BECAUSE THE VAULT HAS NO APPEND.** A routed
        write replaces the whole logical file — there is no `open(..., "a")` that survives the
        cipher. One exchange therefore costs a re-write, which is fine against a model call that
        takes seconds. 🔴 **Do not "optimize" this into a plain `open()`**: that would drop
        cleartext card prose into the encrypted store, silently, which is precisely the failure
        `vault_fs`'s own header warns about.

        🔴 **A LOG WRITE MUST NEVER FAIL A PASS.** The caller already holds a valid reply. Losing
        a diagnostic row is cosmetic; losing a 35-minute pass to a logging fault is not.

        ⚠️ **LOCKED LIKE EVERY OTHER READ-MODIFY-WRITE (§3.4).** Without it, two exchanges
        finishing together both read the file, both append their own rows to the same old text,
        and the second write drops the first pair — in the file that exists so a failure can be
        explained afterward. The hold is short (one read, one write) and never spans a model
        call, so it cannot delay a pass.
        """
        rows = [json.dumps(r, ensure_ascii=False) for r in records]
        if not rows:
            return
        p = self._log(doc_id, n)
        with self._lock(doc_id):
            try:
                old = vault_fs.read_text(p) if vault_fs.exists(p) else ""
            except (OSError, ValueError):
                old = ""
            blob = old + "\n".join(rows) + "\n"
            try:
                if len(blob.encode("utf-8")) > LOG_MAX:
                    # A version's log is bounded by the number of passes before the next revision,
                    # so this is a runaway guard, not a rotation policy. Drop the oldest entries
                    # to retain the most recent attempts.
                    keep = blob.encode("utf-8")[-LOG_MAX:].decode("utf-8", "ignore")
                    blob = keep[keep.index("\n") + 1:] if "\n" in keep else keep
                vault_fs.write_text(p, blob)
            except (OSError, ValueError):
                pass

    def read_log(self, doc_id: str, n: int, limit: int = 2000) -> list[dict]:
        """Version `n`'s log, oldest-first. Never raises on a bad row.

        ⚠️ **A CORRUPT LINE IS SKIPPED, NOT FATAL.** This is a diagnostic file; a half-written row
        from a killed process must not make the window that explains the failure unopenable.
        """
        p = self._log(doc_id, n)
        if not vault_fs.exists(p):
            return []
        try:
            text = vault_fs.read_text(p)
        except (OSError, ValueError):
            return []
        out = []
        for line in text.splitlines()[-max(1, limit):]:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                out.append(row)
        return out

    # ── assets (7.0 §4.3) ────────────────────────────────────────────────────
    #
    # 🔴 AN AVATAR IS USER CONTENT. A character's face is exactly what an encrypted-at-rest
    # product encrypts, so it routes like everything else — there is no "it's just an image"
    # exemption. It lands under the same routed `wbedit/` tree as the revisions.

    def _assets(self, doc_id: str) -> Path:
        return self._dir(doc_id) / ASSET_DIR

    def put_asset(self, doc_id: str, name: str, blob: bytes) -> int:
        """Store a binary belonging to this document. Returns its size.

        `name` is ours, not the user's — `card.png` today. It is never taken from an upload's
        filename: that string is attacker-controlled in the general case and a path separator in
        it would escape the document's directory.
        """
        if "/" in name or "\\" in name or name.startswith("."):
            raise ValueError(f"not an asset name: {name!r}")
        with self._lock(doc_id):
            self.get(doc_id)                 # 🔴 read first — never write into nothing
            vault_fs.write_bytes(self._assets(doc_id) / name, blob)
        return len(blob)

    def asset(self, doc_id: str, name: str) -> bytes:
        p = self._assets(doc_id) / name
        if not vault_fs.exists(p):
            raise MissingDocument(f"{doc_id}/{name}")
        return vault_fs.read_bytes(p)

    def has_asset(self, doc_id: str, name: str) -> bool:
        return vault_fs.exists(self._assets(doc_id) / name)

    # ── the roster thumbnail cache (7.0-m4p / §9a.10) ────────────────────────

    def thumbnail(self, doc_id: str, *, px: int = thumbs.THUMB_PX) -> tuple[bytes, str]:
        """`(webp_bytes, cache_key)` for this card's roster face, built on first ask.

        🔴 **Both inputs are in the key.**
        `(size, mtime)` of the stored PNG and the focus rect from `meta.json`. A rect edit mints no
        revision and does not set `avatar_dirty`, so nothing else in this system would ever notice
        it moved — and the failure of missing it is silent, which is the worst kind: the roster
        goes on showing the old crop of a picture that is otherwise correct.

        🔴 **THE KEY IS THE FILENAME, so existence IS validity.** No sidecar, no timestamp
        comparison, no second source of truth that can disagree with the first. The superseded
        files are swept on write rather than left to accumulate — this is an encrypted store and a
        drawer full of old portrait crops is not neutral data to leave behind.

        Raises `MissingDocument` when there is no picture, and `thumbs.ThumbFailed` when the image
        cannot be decoded. Neither is a 500: the route degrades to the full avatar (§9a.10).

        ⚠️ **THE CACHE HIT IS DELIBERATELY OUTSIDE THE LOCK.** A Library roster fires forty of
        these at once; they are forty DIFFERENT documents, so per-document locking never
        serializes them — but the hit path is a pure read of a file whose NAME is its validity, so
        there is nothing for a lock to protect. Only the build takes it, which also stops a
        concurrent `put_avatar`'s `drop_thumbnails` landing between this build and its sweep and
        leaving a crop of the replaced portrait behind.
        """
        size, mtime = self.asset_stat(doc_id, AVATAR)     # MissingDocument → the caller 404s
        doc = self.get(doc_id)
        k = thumbs.key(size, mtime, doc.focus, px)
        name = thumbs.asset_name(k)
        p = self._assets(doc_id) / name
        if vault_fs.exists(p):
            try:
                return vault_fs.read_bytes(p), k
            except OSError:
                # Deleted under us, or a torn write from a previous run. Rebuilding is always
                # correct here — the source is untouched and the output is a pure function of it.
                pass

        with self._lock(doc_id):
            blob = thumbs.render(self.asset(doc_id, AVATAR), doc.focus, px)
            self.put_asset(doc_id, name, blob)
            # ⚠️ SWEEP AFTER THE WRITE, NEVER BEFORE. A crash between a delete and a write would
            # leave the row with no cached face and a source that is fine — recoverable, but it
            # would also mean a window where a concurrent reader finds nothing and rebuilds
            # needlessly. Writing first means the new file is always the one that exists.
            self._sweep_thumbnails(doc_id, keep=name)
        return blob, k

    def _sweep_thumbnails(self, doc_id: str, *, keep: str = "") -> int:
        """Delete this document's cached crops, optionally sparing one. Returns how many went.

        🔴 **`vault_fs.glob` RETURNS NAMES, NOT PATHS, AND THE FIRST DRAFT OF THIS PASSED THEM
        STRAIGHT TO `unlink`.** Its own docstring says so — a vault directory *cannot* hand back a
        path without lying about where the bytes are. A bare name resolves against the process's
        working directory, so the sweep silently deleted nothing (the `missing_ok=True` swallowed
        it) and, in the one case where the server happened to be running beside a file of the same
        name, would have deleted the wrong one. Joined to the asset directory here, in the single
        place that does it.

        ⚠️ **TAKES NO LOCK, BECAUSE BOTH CALLERS ALREADY HOLD IT** (`thumbnail` and
        `drop_thumbnails`), and it is private for exactly that reason: a third caller reaching it
        directly would be sweeping while a build is mid-flight.
        """
        n = 0
        root = self._assets(doc_id)
        for name in vault_fs.glob(root, f"{thumbs.PREFIX}*{thumbs.SUFFIX}"):
            if name == keep:
                continue
            vault_fs.unlink(root / name, missing_ok=True)
            n += 1
        return n

    def drop_thumbnails(self, doc_id: str) -> int:
        """Forget every cached face for this document. Returns how many went.

        Not needed for correctness — the key changes when either input does, so a stale file is
        never served — but a replaced avatar leaves its predecessor's crop on disk until the next
        read sweeps it, and `put_avatar` is exactly the moment we know it is dead.
        """
        with self._lock(doc_id):
            return self._sweep_thumbnails(doc_id)

    def face_stamps(self, doc: Document, *, px: int = thumbs.THUMB_PX) -> tuple[str, str]:
        """`(avatar_at, thumb_at)` for one roster row, from ONE `stat`. `("", "")` with no picture.

        The roster thumbnail needs its own version stamp. `/avatar` can use `avatar_at`, but the
        roster points at `/thumb`; without a changing URL, the browser can keep showing its cached
        image after an upload.

        The thumbnail key includes focus because the inputs can change independently: `set_focus`
        does not touch the PNG or its `(size, mtime)` stamp, even though it changes the crop.

        This is also the string used to build the ETag. Keeping the URL version and conditional
        response validator aligned prevents a changed image from being answered with a stale 304.
        """
        try:
            size, mtime = self.asset_stat(doc.id, AVATAR)
        except MissingDocument:
            return "", ""
        return stamp_of(size, mtime), thumbs.key(size, mtime, doc.focus, px)

    def asset_stamp(self, doc_id: str, name: str) -> str:
        """`"<size>-<mtime-ms>"` in hex for an asset, or `""` when it does not exist.

        🔴 **THE URL'S CACHE KEY AND THE ETAG ARE THE SAME STRING, BUILT HERE ONCE.** A stamp that
        can disagree with the tag is worse than no stamp: the URL would change while the
        conditional request kept answering 304, or the reverse. `stamp_of` is the only formatter.

        ⚠️ **AND IT IS A `stat`, NOT A READ.** A card PNG is ~700 KB at p50 and the roster asks per
        row; the whole point of `asset_stat` is that the vault answers this without decrypting.
        The roster already spent exactly this call answering "is there a picture at all".
        """
        try:
            return stamp_of(*self.asset_stat(doc_id, name))
        except MissingDocument:
            return ""

    def asset_stat(self, doc_id: str, name: str) -> tuple[int, float]:
        """`(size, mtime)` for an asset, WITHOUT decrypting it. Raises `MissingDocument`.

        This exists so the avatar route can answer a conditional request from a stat alone.
        A card PNG is ~700 KB at p50 (§4.3) and a Library roster asks for one per row, so
        reading every one back through the vault to compute an ETag would decrypt megabytes in
        order to send `304 Not Modified` — the exact work the 304 exists to avoid.
        """
        st = vault_fs.stat(self._assets(doc_id) / name)
        if st is None:                       # absent, or deleted under us mid-listing
            raise MissingDocument(f"{doc_id}/{name}")
        return int(st.size), float(st.mtime)

    # ── pending edits (7.0 §9a.15) ───────────────────────────────────────────
    #
    # Pending text is a scratchpad, separate from revisions and ignored by passes, exports, and
    # sends. Each draft records its base revision; it is available only while that revision is
    # current and is carried forward only when the next revision was built from that base.

    def _draft(self, doc_id: str) -> Path:
        return self._dir(doc_id) / DRAFT

    def put_draft(self, doc_id: str, revision: int, locator: Sequence, text: str) -> int:
        """Record one field's pending text. Returns how many fields are now pending.

        Passing text equal to nothing pending is the caller's business — an unchanged field is
        removed rather than stored, so a field edited and then put back never leaves a draft
        behind to be restored over identical content.
        """
        # Verify the document before writing so a stale tab cannot recreate a deleted directory.
        # Lock the read-modify-write to avoid dropping another field's concurrent draft update.
        with self._lock(doc_id):
            self.get(doc_id)
            cur = self._read_draft(doc_id)
            if cur.get("revision") != revision:
                cur = {"revision": revision, "fields": {}}
            # Match the browser's compact `JSON.stringify(locator)` representation.
            key = json.dumps(list(locator), ensure_ascii=False, separators=(",", ":"))
            if text is None:
                cur["fields"].pop(key, None)
            else:
                cur["fields"][key] = text
            if cur["fields"]:
                vault_fs.write_json_atomic(self._draft(doc_id), cur, indent=2)
            else:
                self.clear_drafts(doc_id)
            return len(cur["fields"])

    def _read_draft(self, doc_id: str) -> dict:
        p = self._draft(doc_id)
        if not vault_fs.exists(p):
            return {"revision": -1, "fields": {}}
        try:
            d = json.loads(vault_fs.read_text(p))
        except (OSError, ValueError):
            # A corrupt scratchpad is not worth failing an open over — it is unsaved text, and
            # the document itself is untouched. Start a fresh one.
            return {"revision": -1, "fields": {}}
        if not isinstance(d, dict) or not isinstance(d.get("fields"), dict):
            return {"revision": -1, "fields": {}}
        return {"revision": int(d.get("revision", -1)), "fields": d["fields"]}

    def drafts(self, doc_id: str, revision: int) -> dict[str, str]:
        """Pending text for `revision`, as `{locator_json: text}`. Empty if it is for another."""
        d = self._read_draft(doc_id)
        return dict(d["fields"]) if d["revision"] == revision else {}

    def draft_count(self, doc_id: str) -> int:
        """Count all pending fields for the Library marker, including stale-base drafts.

        Unlike `drafts()`, this count is not filtered by revision. Check existence first so rows
        without drafts require only a stat rather than a read and decrypt.
        """
        if not vault_fs.exists(self._draft(doc_id)):
            return 0
        return len(self._read_draft(doc_id)["fields"])

    def clear_drafts(self, doc_id: str) -> None:
        """Throw the pending state away.

        Two callers, and they are not the same thing. `apply_edits` calls it because the pending
        text has BECOME the revision; `DELETE /wbedit/documents/<id>/draft` calls it because the
        user pressed `↺ Discard` and wants the typing gone. Every other minting path carries the
        draft forward instead — see `add_revision`.
        """
        with self._lock(doc_id):
            p = self._draft(doc_id)
            if vault_fs.exists(p):
                vault_fs.unlink(p)

    def _carry_drafts(self, doc_id: str, from_revision: int, to_revision: int) -> int:
        """Restamp pending typing from one revision onto the next. Returns how many fields moved.

        This helper has one caller, `add_revision`, so every revision-minting path applies the same
        draft policy. It carries a draft only when its stored base matches `from_revision`.

        Rewrite only the revision stamp; locator keys retain the browser's compact JSON format.
        """
        if from_revision == to_revision:
            return 0
        with self._lock(doc_id):
            self.get(doc_id)        # 🔴 read first — never write into nothing, as `put_draft` does
            cur = self._read_draft(doc_id)
            if cur["revision"] != from_revision or not cur["fields"]:
                return 0
            cur["revision"] = to_revision
            vault_fs.write_json_atomic(self._draft(doc_id), cur, indent=2)
            return len(cur["fields"])
