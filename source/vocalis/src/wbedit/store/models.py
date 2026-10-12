"""The four nouns of design §4, as records that survive a restart.

`core/job.py` holds what the LOOP moves between; this holds what the STORE keeps. They are
deliberately different shapes and the difference is the design: a `Job` is a field addressed for
one attempt and is thrown away when the pass ends, while a `Proposal` is the durable record of
what came back and what the user decided about it.

🔴 **PROPOSING AND APPLYING ARE SEPARATE, AND THIS FILE IS WHERE THAT BECOMES PERMANENT** (§4).
`Proposal.revised` is a suggestion sitting in a queue; nothing in this module writes it into a
document. Only `documents.materialize()` does, only from proposals whose `review` says so, and
only by minting a new Revision. A future convenience that reads `revised` and saves it has
re-introduced the auto-apply the whole design exists to prevent.

⚠️ Everything here round-trips through JSON, so the field types are JSON's: no tuples, no sets,
no `Path`. `Proposal.locator` is the one that bites — it is a tuple in memory (it addresses a
document, and `core/locator.py` walks tuples) and a list on disk. `from_dict` puts the tuple
back. The str-vs-int distinction inside it is load-bearing and JSON preserves it: a compiled
lorebook's `entries` is a dict keyed by the STRING "3", a section chunk's is a list indexed by
the INT 3, and `node[k]` means different things to each.
"""
from __future__ import annotations

import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field as dc_field
from typing import Any

#: What a document can be. Mirrors `formats/detect.py`'s answers — a new format means a new
#: collector there and a new member here, in that order. `persona` arrived that way (§8.3).
KINDS = ("worldbook", "card", "persona")

#: Where a document came from. `upload` is a file added to the Library; `st` is one the
#: extension pushed across (m2). It is recorded because export behaves differently — an `st`
#: document knows the name/avatar it came from and can overwrite it (§8).
#: Where a document came from. 🔴 `"new"` (7.0-m4z / §9a.19) is the first one Vocalis AUTHORS —
#: everything before it arrived from somewhere, swept in from SillyTavern or uploaded as a file.
#: It is a distinct value rather than a borrowed `"upload"` because nothing was uploaded, and a
#: Library row that says otherwise is a small lie that survives into every later diagnosis.
SOURCES = ("upload", "st", "new")

#: 🔴 A PASS IS A LONG-LIVED OBJECT AND `running` OUTLIVES THE PROCESS THAT SET IT. Vocalis can be
#: restarted mid-pass; the record on disk still says `running` and that is CORRECT — it is what
#: resume reads. Nothing may infer "a pass is in flight" from this field alone.
#:
#: 🔴 **A running pass must not remain running after restart (§9a.13a).** `_RUN` and `_RECENT` are
#: process-local, so they cannot advance the durable record after restart. Startup reconciliation
#: marks the pass interrupted while preserving its cursor and tally for resume.
#:
#: `interrupted` is the honest terminal value, minted by the startup reconcile. It keeps the
#: distinction the comment above is protecting — `cursor` and `tally` still say where the pass
#: got to, so it remains the resume point — while no longer asserting that something is running.
PASS_STATES = ("running", "done", "canceled", "failed", "interrupted")

#: What the user decided about one proposal.
#:
#: `none` is not a decision — it is the absence of anything to decide, and it belongs to NOCHANGE
#: and FAILED rows. Keeping it distinct from `rejected` matters at materialize time: a rejected
#: CHANGED row means "the model's answer was wrong", which is a fact worth keeping, while a
#: NOCHANGE row means the model correctly did nothing. Collapsing them would make the two
#: indistinguishable in the record a week later.
REVIEWS = ("pending", "approved", "rejected", "edited", "none")

#: `Revision.kind` — what minted a revision, for code that has to FIND one later rather than show
#: it. Only the events another feature needs to locate get a value; everything else stays `""`,
#: because a vocabulary that names every case is one every new call site has to be taught.
#:
#: 🔴 `REV_IMPORT` IS THE MERGE BASE (9.6). A three-way merge needs the revision the LAST import
#: landed as — not revision 0, which is what makes the second merge of a book correct.
REV_IMPORT = "import"
REVISION_KINDS = ("", REV_IMPORT)


def new_id() -> str:
    """A store id. Random, not derived from the name.

    🔴 **NOT A SLUG OF THE TITLE.** Inside the vault the filename is SIV-encrypted, so a title
    here would be safe — but this tree is shared by plaintext development and encrypted installs,
    and a directory named after a document would expose its title in listings. Random ids cost
    nothing:
    the display name lives inside the (routed) metadata file, which is where content belongs.
    """
    return secrets.token_hex(8)


#: What a store id may contain — see `is_id`. No dot and no separator of either kind, so no
#: arrangement of these characters can leave the directory an id is joined to. Length-capped
#: because an id also becomes a filename, and NTFS gives a path component 255.
_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


def is_id(value) -> bool:
    """Is `value` safe to join onto a store path?

    🔴 **IDS COME OFF THE URL AND BECOME PATH COMPONENTS.** Werkzeug's default converter
    excludes `/` but NOT `\\`, and on Windows `pathlib` treats a backslash as a separator — so
    `..%5C..%5Cevil` arrived as a live traversal. `DELETE` reached `vault_fs.rmtree`, which falls
    through to a bare `shutil.rmtree(ignore_errors=True)` for any path the vault does not route;
    a draft `PUT` was an arbitrary write by the same road.

    🔴 **IT LIVES HERE BECAUSE THERE IS MORE THAN ONE STORE.** The first version of this guard
    went into `DocumentStore._dir` alone — and `PassStore` builds `root / DOCS_DIR / doc_id /
    …` independently, beside it, so six routes walked straight past it and `pass_id` was checked
    nowhere at all. That is the same one-chokepoint-two-doors shape the bug itself had. Putting
    it next to `new_id` means the rule for making an id and the rule for trusting one are one
    line apart and cannot drift.

    ⚠️ Windows device names (`con`, `nul`, `prn`) pass. That is correct: ids are
    `secrets.token_hex(8)` so one can never be minted, and NTFS refuses such a directory anyway.
    Widening this to exclude them would be guarding a case that cannot arise, and every extra
    rule here is one more thing a future id format has to satisfy.
    """
    return isinstance(value, str) and _ID_RE.fullmatch(value) is not None


def _now() -> float:
    return time.time()


# ── mutual exclusion ─────────────────────────────────────────
#
# 🔴 Mutations update revision and metadata files with read-modify-write sequences. Concurrent
# edits could allocate the same revision number, while a save could overwrite `avatar_dirty=True`
# with stale metadata and lose an avatar update. Store mutations must therefore share a lock.
#
# `RevisionConflict` rejects a stale base revision, but two requests can still read the same
# `latest_on_disk`, pass that check, and allocate the same number. The shared lock serializes this
# read-modify-write.
#
# 🔴 **KEEP SHARED STORE RULES TOGETHER.** `DocumentStore` and `PassStore` build paths from the same
# IDs, so ID validation and locking must apply across both stores.
#
# 🔴 **KEYED ON THE ROOT AND THE ID, NEVER ON `self`.** `create_wbedit_blueprint` builds
# `DocumentStore(paths.WBEDIT_DIR)` PER REQUEST (`_docs()`), and `pair.py` builds four more, so a
# lock held on an instance is a lock held against nobody. Two stores on one root must be one
# lock; that is what the root half of the key buys, and it is what makes `DocumentStore` and
# `PassStore` — separate objects, same directory — exclude each other.
#
# ⚠️ **`threading.Lock` IS THE RIGHT PRIMITIVE BECAUSE THERE IS ONLY ONE PROCESS.** Vocalis
# serves through `make_server(..., threaded=True)` (`vocalis_server.py:1289`); every `Popen` in
# the tree is an audio child (`cleanup`, `enhance`, `voiceswap`, `voicetrain`, `voxcpm`,
# `mp3_render`) and not one of them touches `wbedit/`. If a second process ever writes this tree,
# this becomes a lie and the answer is a lock FILE, not a bigger `threading.Lock`.
#
# ⚠️ **RE-ENTRANT, AND NOT AS A CONVENIENCE.** `materialize` → `add_revision`, `put_avatar` →
# `put_asset` → `get`, `import_from_st` → `create` → `link_orphan_cards`: the store nests its own
# mutators several deep. A plain `Lock` would self-deadlock a request thread on the first of
# those, which is a worse outage than the race.

#: Not a document id — `_ID_RE` forbids `~`, so these can never collide with a real one.
DISMISSED_LOCK = "~dismissed"
LIBRARY_LOCK = "~instructions"
#: The shared prompt (`wbedit/prompt/settings.py`) uses the same revision read-modify-write as
#: `DocumentStore.add_revision`, but its store is global rather than per-document. This lock
#: prevents concurrent saves from allocating the same revision number.
PROMPT_LOCK = "~prompt"
#: 🔴 **THE ONE INVARIANT THAT IS NOT ABOUT A DOCUMENT.** "At most one document of a kind carries
#: a name" is library-wide, so a per-document lock cannot protect it. `import_from_file` must hold
#: the namespace lock across name lookup and document creation; otherwise concurrent imports can
#: create duplicate names and make later lookups ambiguous. The server is `threaded=True`, and
#: `POST /pair/documents` is a second import path.
#:
#: ⚠️ **GLOBAL IS THE RIGHT SHAPE HERE, WHICH IS UNLIKE EVERY OTHER LOCK ABOVE.** `store_lock`'s
#: own rule is "per document, never global", because serializing forty thumbnail builds behind one
#: another is latency bought for nothing. This one guards a NAMESPACE rather than a file, it is
#: taken only on the two import doors, and it is held for one small metadata scan plus one mint —
#: an operation a human triggers, not one the roster does forty times a second.
#:
#: 🔴 **LOCK ORDERING IS `import → worldbook → card → dismissed`.** This is taken FIRST and never
#: reached for while a document lock is held, so the graph stays acyclic.
IMPORT_LOCK = "~import"

_REGISTRY_MU = threading.Lock()

#: `key -> [RLock, waiters]`. 🔴 **REFERENCE-COUNTED SO IT CANNOT GROW WITHOUT BOUND.** A plain
#: `dict[key] = Lock()` never shrinks, and the id reaching it comes off a URL: a logged-in client
#: looping `PUT /wbedit/documents/<random>/draft` would mint an entry per request forever. The
#: count is raised UNDER `_REGISTRY_MU` BEFORE the lock is acquired and lowered after it is
#: released, so it is ≥ (holders + waiters) at every instant and zero means genuinely nobody —
#: which is the only moment the entry may be dropped.
_LOCKS: dict[tuple[str, str], list] = {}


def _root_key(root) -> str:
    """The registry's half-key for a store root.

    ⚠️ **LEXICAL, NOT `resolve()`.** This module's whole doctrine is that nothing here touches a
    disk before an unlock (I15), and `Path.resolve()` is a filesystem call. `abspath` +
    `normcase` is pure string work plus the cwd, and `normcase` is what makes `C:\\example\\x` and
    `c:\\example\\x` one key on Windows — where two different keys would mean two locks on one
    directory, i.e. no lock at all.

    ⚠️ The cost of being lexical: two paths that reach the same directory through a symlink or a
    substituted drive get two keys. Every caller in Vocalis passes `paths.WBEDIT_DIR`, one
    constant, so this cannot arise here — but a future caller that builds its own path must pass
    the same string, not merely an equivalent one.
    """
    return os.path.normcase(os.path.abspath(str(root)))


@contextmanager
def store_lock(root, name: str):
    """Hold the write lock for one document (or one whole-file store) under `root`.

    `name` is a document id, or `DISMISSED_LOCK` / `LIBRARY_LOCK` / `PROMPT_LOCK` /
    `IMPORT_LOCK` for the root-level stores and invariants that no single document owns.

    🔴 **PER DOCUMENT, NEVER GLOBAL.** A single store-wide lock would serialize the Library
    roster's forty concurrent thumbnail builds behind one another and put a pass's per-field
    flush in front of every unrelated edit — latency that would make the feature feel slow,
    bought for nothing, since two different documents cannot corrupt each other.

    🔴 **THE `finally` HAS NO `except`, AND THAT IS DELIBERATE.** `VaultAuthError` is a
    `BaseException` on purpose (`vault.py:58`) so it cannot be swallowed by a handler written for
    ordinary faults. A bare `finally` releases the lock and lets it straight through; adding
    `except Exception` here would both miss it and, on anything else, convert a store fault into
    a silent success. Nothing in this function catches anything.

    ⚠️ **LOCK ORDERING IS `import → worldbook → card → dismissed`, AND NOTHING MAY REVERSE
    IT.** `IMPORT_LOCK` sits above the whole graph and is taken only at the top of an import.
    `rename` and `delete` hold a BOOK's lock while `link_orphan_cards`/`_release_cards` take each
    affected CARD's, and `delete` then takes `DISMISSED_LOCK`. No path holds a card's lock and
    reaches for a book's — `resolve_worldbook` and `outbound` read without locking — so the graph
    is acyclic. A future writer that makes a card's mutation touch its book must take the book's
    lock FIRST or it has built a deadlock.
    """
    # 🔴 **THE REGISTRY REFUSES A KEY IT WAS NOT PROMISED, STRUCTURALLY.** `_LOCKS` grows one
    # entry per distinct name, and the name comes off a URL on nineteen routes. Both stores also
    # check `is_id` before building a path, so this is the same rule invoked a second time rather
    # than a second rule — it cannot drift, and it means no caller can be the one that forgot.
    # `ValueError`, not `MissingDocument`: that lives in `documents.py`, which imports THIS
    # module, and the stores translate it into their own 404 before it can reach a route.
    if not (is_id(name) or name in (DISMISSED_LOCK, LIBRARY_LOCK, PROMPT_LOCK, IMPORT_LOCK)):
        raise ValueError(f"not a lockable store key: {name!r}")
    key = (_root_key(root), name)
    with _REGISTRY_MU:
        entry = _LOCKS.get(key)
        if entry is None:
            entry = _LOCKS[key] = [threading.RLock(), 0]
        entry[1] += 1
        lock = entry[0]
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
        with _REGISTRY_MU:
            entry[1] -= 1
            # `is entry` rather than `in`: only the object we counted against may be dropped, so
            # a registry that was cleared under us cannot make this delete somebody else's lock.
            if entry[1] <= 0 and _LOCKS.get(key) is entry:
                del _LOCKS[key]


@dataclass
class Document:
    """An imported card or lorebook. The bytes as imported never change (I8) — this record is
    metadata ABOUT them, and the bytes themselves are revision 0.

    `latest` is derived from the revisions on disk, not authoritative here. It is carried on the
    record because the Library lists documents without opening them, and re-reading a directory
    per row to answer "how many revisions" is the kind of thing that is free at 8 documents and
    not at 200.
    """

    id: str
    kind: str                      # one of KINDS
    name: str                      # display name — user content, and it lives INSIDE the file
    source: str = "upload"         # one of SOURCES
    imported_at: float = dc_field(default_factory=_now)
    #: For an `st` document: the book name, or the card's avatar FILENAME (§4.3 — their de-facto
    #: primary key, stable under edits and NOT under renames). Empty for an upload.
    st_ref: str = ""
    latest: int = 0                # highest revision number
    #: §4.3 — `{x, y, w}` fractions from `data.extensions.taproom_avatar_focus`, if the card
    #: carried one. Absent means "largest centered square", which is most cards. Kept out of the
    #: revision because it describes the IMAGE, and the image is an Asset, not document text.
    focus: dict[str, float] = dc_field(default_factory=dict)
    #: §8.2, cards only — the card's PRIMARY lorebook, held as BOTH halves on purpose.
    #:
    #: `world_ref` is what the card said (`data.extensions.world`, a name). `world_id` is the
    #: `Document.id` of the book we matched it to, or empty when we hold no such book.
    #:
    #: 🔴 **THE FILTER MATCHES ON THE ID, WHICH IS WHY A RENAME CANNOT BREAK IT.** That is the
    #: whole point of §8.2: an id is stable under rename, so renaming a book costs the link
    #: nothing and no card has to be rewritten (which would mint a revision on a document nobody
    #: edited).
    #:
    #: 🔴 **AND `world_ref` IS WHY IMPORT ORDER DOES NOT MATTER.** A card imported BEFORE its book
    #: has nothing to resolve against, and if the name were discarded at that moment the link
    #: would be unrecoverable — the Library reads metadata only and must never open a revision
    #: body to answer "which book". Keeping the name lets `link_orphan_cards()` complete the link
    #: when the book arrives. Discarding it is a silent, permanent miss: the character simply
    #: never appears under its book and nothing anywhere says why.
    #:
    #: Kept out of the revision for `focus`'s reason — this is metadata ABOUT the card, and the
    #: card's own bytes (which still carry the name) never change.
    world_ref: str = ""
    world_id: str = ""
    #: 9.7.3 — Records an explicit user choice of this link.
    #:
    #: 🔴 **It separates "we hold no book" from "the user selected no book"; those are
    #: OPPOSITE INSTRUCTIONS.** Both are `world_id == ""`. Until this field there was no third
    #: value to tell them apart, which is why `outbound` left a card's `data.extensions.world`
    #: alone whenever the id was empty — blanking it would have deleted an association in the
    #: SillyTavern on the strength of our own missing record. That reasoning is still right for
    #: the import case and exactly wrong once the user has explicitly cleared the link, because then
    #: the missing record IS the instruction.
    #:
    #: 🔴 **AND IT IS THE ONLY THING THAT LETS A SEND CARRY THE LINK.** `st_write`'s header rule
    #: is that the world link is never written, on the grounds that "our name for a book is not
    #: SillyTavern's" and — its own words — *"Vocalis offers no way to edit the link, so there is
    #: never an edit to propagate"*. The second half of that stopped being true here. The link
    #: travels when, and only when, this flag says the value came from the user.
    #:
    #: ⚠️ **Cleared when it is no longer the user's answer**: a re-import from
    #: SillyTavern that states a different `world_ref` (their card is the authority on their
    #: card), and `_release_cards` when the linked book is deleted (the book leaving Vocalis
    #: is not an instruction to unlink it over there).
    world_set: bool = False
    #: m4o — the picture in the vault differs from SillyTavern because the user uploaded a new one
    #: here. It is a fact about the two stores having diverged, not about the image.
    #:
    #: 🔴 **IT EXISTS SO A SEND DOES NOT RE-UPLOAD ~700 KB EVERY TIME.** Pushing the avatar on
    #: every save would re-encode the card in SillyTavern on every save too — `writeCharacterData`
    #: runs the image through Jimp — so a picture that never changed would be quietly degraded by
    #: repeated round trips. This flag is what makes the image travel exactly when it is new.
    #:
    #: ⚠️ **Cleared only by a send that SUCCEEDED.** A failed one leaves it set so the next attempt
    #: still carries the picture; clearing on the attempt would lose it silently.
    avatar_dirty: bool = False
    #: 7.3.9 — SillyTavern's own stamp for the picture we are holding, as the extension reported it
    #: when it handed the bytes over. Opaque here: a card's is `date_added` (their `ctimeMs` on the
    #: character file, which moves whenever `/edit-avatar` rewrites it), and nothing on this side
    #: parses it — it is only ever compared for equality with the stamp of the file over there.
    #:
    #: 🔴 **IT EXISTS BECAUSE "DO I HAVE A PICTURE?" WAS THE WRONG QUESTION.** The sweep skips the
    #: ~700 KB fetch when Vocalis already holds a picture for the card, which was correct for the
    #: bug it was written for (a failed upload retrying) and silently wrong for the ordinary one:
    #: a user changes a character's image in SillyTavern and Vocalis keeps the old one,
    #: because every later press sees `created: false`, sees a picture, and skips. The only escape
    #: was deleting the Library row. This turns the question into "do I have the CURRENT one?".
    #:
    #: ⚠️ **EMPTY MEANS "WE DO NOT KNOW", AND IT MUST NOT MEAN "STALE".** Every document imported
    #: before this field existed has an empty one, as does any picture uploaded here by hand.
    #: The freshness test in `pair_import` therefore treats a mismatch as stale only when BOTH
    #: sides have a stamp to compare — see `avatar_dirty`, which guards the hand-uploaded case.
    avatar_ref: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "name": self.name, "source": self.source,
                "imported_at": self.imported_at, "st_ref": self.st_ref, "latest": self.latest,
                "focus": dict(self.focus), "world_ref": self.world_ref,
                "world_id": self.world_id, "world_set": self.world_set,
                "avatar_dirty": self.avatar_dirty,
                "avatar_ref": self.avatar_ref}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Document:
        return cls(id=str(d["id"]), kind=str(d["kind"]), name=str(d.get("name") or ""),
                   source=str(d.get("source") or "upload"),
                   imported_at=float(d.get("imported_at") or 0.0),
                   st_ref=str(d.get("st_ref") or ""), latest=int(d.get("latest") or 0),
                   focus=dict(d.get("focus") or {}),
                   world_ref=str(d.get("world_ref") or ""),
                   world_id=str(d.get("world_id") or ""),
                   # Absent on every record written before 9.7.3, and `False` is the right
                   # reading of absent: those links all came from an import, not an explicit edit.
                   world_set=bool(d.get("world_set")),
                   avatar_dirty=bool(d.get("avatar_dirty")),
                   avatar_ref=str(d.get("avatar_ref") or ""))


@dataclass
class Revision:
    """A materialized state of a Document. Revision 0 *is* the import.

    🔴 **A full snapshot, never a diff** (§4). A rollback selects an earlier state rather than
    reconstructing it,
    and there is no diff engine that can be wrong about what revision 3 contained. A book is a few
    hundred KB and thirty revisions is ~10 MB; that is the price and it is the right one.

    `from_revision` is what makes the rollback label honest — "revision 7 (from revision 3)".
    Rolling back mints a NEW revision whose content equals an old one; it never deletes history
    and never rewinds the numbering.
    """

    n: int
    content: dict[str, Any]        # the whole document, as JSON
    created_at: float = dc_field(default_factory=_now)
    note: str = ""                 # "import", "pass <id>", "hand edit", "rollback to 3"
    from_revision: int | None = None
    #: The pass this revision was materialized from, when it came from one. A hand edit leaves it
    #: empty. It is the link that lets the Editor say "this paragraph arrived in revision 4, from
    #: the pass whose instruction was …".
    pass_id: str = ""
    #: 🔴 **WHAT MINTED THIS REVISION, AS A VALUE RATHER THAN AS PROSE — 9.6.** `note` is free text
    #: written by several call sites and validated by nothing; it exists to be read in the
    #: revision picker, and rewording one is a display change nobody would think twice about. The
    #: merge base is `the newest revision that was an import`, so a merge that found its base by
    #: matching `note.startswith("re-imported")` would rest the correctness of every three-way
    #: comparison on a string somebody is free to improve. This field is the claim; the note stays
    #: the sentence.
    #:
    #: ⚠️ **EMPTY IS THE HONEST ANSWER FOR EVERY REVISION WRITTEN BEFORE THIS FIELD EXISTED**, and
    #: `merge_base` says what it does about those rather than pretending. Revision 0 is always an
    #: import whatever it says here (`Document.create` is the only thing that writes it), which is
    #: what makes the fallback safe rather than merely convenient.
    kind: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"n": self.n, "created_at": self.created_at, "note": self.note,
                "from_revision": self.from_revision, "pass_id": self.pass_id,
                "kind": self.kind, "content": self.content}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Revision:
        fr = d.get("from_revision")
        return cls(n=int(d["n"]), content=d.get("content") or {},
                   created_at=float(d.get("created_at") or 0.0), note=str(d.get("note") or ""),
                   from_revision=None if fr is None else int(fr),
                   pass_id=str(d.get("pass_id") or ""), kind=str(d.get("kind") or ""))


@dataclass
class Pass:
    """One instruction applied over one revision.

    🔴 **`instruction` IS BYTE-FROZEN FOR THE LIFE OF THE PASS (I10)** and this record is what
    freezes it. It is stored once, here, and every request in the pass is built from this string —
    which is what makes 110 independent edits one coherent pass, and what keeps KoboldCpp's prompt
    prefix stable so only the field itself is processed fresh. A UI that edits it mid-run has
    broken both properties at once. Amending it means a new Pass.

    🔴 **`model` IS RECORDED BECAUSE A PASS RUN UNDER ANOTHER MODEL IS NOT THE SAME PASS** (§3.1).
    It is the name `/api/v1/model` gave at the moment the pass started, not the name of a config.

    📌 **`engine` IS RECORDED FOR THE SAME REASON (11.1).** `llama`, `kobold`, `openrouter` or
    `featherless` — the same model name served by a local engine and by a hosted provider is not
    the same pass either. `""` on a pass recorded before 11.1, when KoboldCpp was the only engine.

    `cursor` is how many fields have been attempted. It is the resume point and it is advanced
    only after that field's proposal is durable, never before — see `passes.record()`.
    """

    id: str
    doc_id: str
    revision: int                  # which revision the pass ran against
    instruction: str
    model: str = ""
    engine: str = ""
    sampler: dict[str, Any] = dc_field(default_factory=dict)
    #: The locators selected for this pass, as lists (§6.2's checkboxes). Stored so a resume knows
    #: what the pass WAS, even if the document's field set has since changed underneath it.
    selection: list[list[Any]] = dc_field(default_factory=list)
    status: str = "running"        # one of PASS_STATES
    created_at: float = dc_field(default_factory=_now)
    finished_at: float = 0.0
    total: int = 0
    cursor: int = 0
    tally: dict[str, int] = dc_field(default_factory=dict)
    #: Set when `status == "failed"`. 🔴 I16 — a REASON, never a payload: it is written by the web
    #: layer from an exception it has already collapsed, and it reaches the UI.
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "doc_id": self.doc_id, "revision": self.revision,
                "instruction": self.instruction, "model": self.model, "engine": self.engine,
                "sampler": dict(self.sampler), "selection": [list(s) for s in self.selection],
                "status": self.status, "created_at": self.created_at,
                "finished_at": self.finished_at, "total": self.total, "cursor": self.cursor,
                "tally": dict(self.tally), "error": self.error}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Pass:
        return cls(id=str(d["id"]), doc_id=str(d["doc_id"]), revision=int(d.get("revision") or 0),
                   instruction=str(d.get("instruction") or ""), model=str(d.get("model") or ""),
                   engine=str(d.get("engine") or ""),
                   sampler=dict(d.get("sampler") or {}),
                   selection=[list(s) for s in (d.get("selection") or [])],
                   status=str(d.get("status") or "running"),
                   created_at=float(d.get("created_at") or 0.0),
                   finished_at=float(d.get("finished_at") or 0.0),
                   total=int(d.get("total") or 0), cursor=int(d.get("cursor") or 0),
                   tally=dict(d.get("tally") or {}), error=str(d.get("error") or ""))


@dataclass
class Proposal:
    """One field's result within a Pass, and the user's decision about it.

    🔴 **THIS RECORD HOLDS BODIES AND IS THEREFORE NOT SSE-SAFE (I16).** `original`, `revised` and
    `edited` are document text. The review queue fetches this over the authenticated document
    route precisely so it never has to travel in a progress frame — `runner.Event.public()` says
    "row 34 is ready, CHANGED, 2 flags" and the browser then asks for the body. Do not add a
    convenience that serializes a Proposal into an event.

    `review` defaults from the runner's own assessment rather than to `pending` for everything,
    and that is I7 rather than a shortcut: an unflagged CHANGED row is what `accept_flagged=False`
    already applies in the CLI, while a FLAGGED row is held back for a human. Defaulting all 110
    rows to `pending` would make the queue a hundred clicks of agreeing with the validators, and a
    queue nobody reads is worse than one that only stops you when something is wrong.
    """

    index: int                     # 1-based position within the pass
    locator: tuple
    label: str
    status: str                    # core.job.STATUSES — CHANGED | NOCHANGE | FAILED
    original: str = ""
    revised: str | None = None
    reason: str = ""
    notes: str = ""
    flags: list[str] = dc_field(default_factory=list)
    elapsed: float = 0.0
    review: str = "none"           # one of REVIEWS
    edited: str | None = None      # User's hand-edit, when `review == "edited"`
    rel: str = ""

    @property
    def text(self) -> str | None:
        """What materializing this proposal would write — the hand-edit if there is one.

        Returns None when there is nothing to apply, which is every case except an approved or
        edited CHANGED row. `documents.materialize()` reads exactly this, so the rule about what
        reaches a document is stated once.
        """
        if self.review == "edited" and self.edited is not None:
            return self.edited
        if self.review == "approved" and self.status == "CHANGED":
            return self.revised
        return None

    def to_dict(self) -> dict[str, Any]:
        return {"index": self.index, "locator": list(self.locator), "label": self.label,
                "status": self.status, "original": self.original, "revised": self.revised,
                "reason": self.reason, "notes": self.notes, "flags": list(self.flags),
                "elapsed": self.elapsed, "review": self.review, "edited": self.edited,
                "rel": self.rel}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Proposal:
        return cls(index=int(d["index"]), locator=tuple(d.get("locator") or ()),
                   label=str(d.get("label") or ""), status=str(d.get("status") or "FAILED"),
                   original=str(d.get("original") or ""), revised=d.get("revised"),
                   reason=str(d.get("reason") or ""), notes=str(d.get("notes") or ""),
                   flags=list(d.get("flags") or []), elapsed=float(d.get("elapsed") or 0.0),
                   review=str(d.get("review") or "none"), edited=d.get("edited"),
                   rel=str(d.get("rel") or ""))

    @classmethod
    def from_event(cls, ev: Any) -> Proposal:
        """Build the durable record from a `runner.FIELD_RESULT` event.

        The one place the loop's shape and the store's shape meet. `ev.applied` is the runner's
        assessment (unflagged CHANGED) and becomes the default review state; everything the runner
        does not know about — the hand-edit, the rejection — starts empty.
        """
        r = ev.result
        if r.status == "CHANGED":
            review = "approved" if ev.applied else "pending"
        else:
            review = "none"
        return cls(index=ev.index, locator=tuple(r.job.locator), label=r.job.label,
                   status=r.status, original=r.job.original, revised=r.revised,
                   reason=r.reason, notes=r.notes, flags=list(r.flags), elapsed=r.elapsed,
                   review=review, rel=r.job.rel)
