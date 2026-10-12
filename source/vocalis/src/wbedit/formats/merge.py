"""Three-way merge between a saved import base, the current document, and an incoming file.

The merge derives changes from full snapshots rather than storing a separate edited flag. Conflicts
are resolved in favor of the current document until a caller explicitly applies another choice.

**The whole rule, and it is five rows:**

===============  ================  ==============  ========
base vs mine     base vs theirs    verdict         writes
===============  ================  ==============  ========
same             same              `UNCHANGED`     mine
same             changed           `TAKE_THEIRS`   theirs
changed          same              `KEEP_MINE`     mine
changed          changed, equal    `AGREED`        mine
changed          changed, differ   `CONFLICT`      **mine**
===============  ================  ==============  ========

🔴 **A CONFLICT RESOLVES TO `mine`.** The merge cannot infer which side is correct, so it preserves
the current text and reports the conflict for an explicit caller decision.

🔴 **FIELD GRANULARITY, NEVER LINE GRANULARITY.** Conflicts are reported per field; the merge does
not insert diff markers into authored text or infer a resolution within a field.

⚠️ **PURE, AND IT STAYS THAT WAY.** Nothing here reads the store, mints a revision, or knows what
a `Proposal` is. Finding the base revision is the store's job and rendering the verdicts is the
web layer's; keeping the arithmetic separate from both is what makes it testable against
hand-built dicts rather than against a live library.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field as dc_field
from typing import Any, Iterable

from . import worldbook


class _Absent:
    """A field that is not present on one of the three sides.

    `None` is a valid field value meaning "inherit the global setting" for nullable fields. A
    distinct sentinel is required to represent a key absent from one side of the merge.
    """

    __slots__ = ()

    def __repr__(self) -> str:                              # pragma: no cover - debugging only
        return "<absent>"

    def __bool__(self) -> bool:
        return False


ABSENT = _Absent()

#: The verdict on one field. `UNCHANGED` is kept distinct from `AGREED` on purpose: both write
#: the same bytes, but "nobody touched it" and "we both made the same change" are different facts
#: about the import, and a summary that collapsed them could not say how much of the file was new.
UNCHANGED = "unchanged"
TAKE_THEIRS = "theirs"
KEEP_MINE = "mine"
AGREED = "agreed"
CONFLICT = "conflict"

#: Statuses distinguish additions, untouched omissions, changed omissions, and entries deleted in
#: the current document but changed in the incoming file. Destructive choices remain explicit.
ADDED = "added"
REMOVED = "removed"
REMOVED_EDITED = "removed_edited"
REMOVED_UPDATED = "removed_updated"
MINE_ONLY = "mine_only"
#: `CHANGED` means the merge writes something here; `SAME` means it leaves the current entry alone.
#: Both statuses are measured against the current document, not the saved base.
CHANGED = "changed"
SAME = "same"

#: How two entries were decided to be the same entry. See `_align`.
BY_UID = "uid"
BY_COMMENT = "comment"

#: Fields whose ORDER carries no meaning, compared as multisets so a reordered list is not
#: reported as an edit. SillyTavern scans keywords for a match; it does not care which one is
#: first, and a model handing the same keywords back in a different order would otherwise put
#: every entry in the book into the review pane.
#:
#: ⚠️ Comparison only. The value written is still the real list, in whichever side's order won,
#: so nothing here can reorder the winning side's keywords.
_ORDER_FREE = frozenset({"key", "keys", "keysecondary"})

#: Book-level keys the entry walk owns, so the document-field merge leaves them alone.
_ENTRY_CONTAINERS = frozenset({"entries"})


def _fold(value: Any) -> str:
    """Normalize a display string for equality comparisons.

    Same recipe as `store/documents._fold_name` — trim, NFC, casefold, in that order, because
    `casefold` on a decomposed string leaves it decomposed. Written out rather than imported:
    this module is pure, and reaching into the store to borrow four lines would make it not be.
    """
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFC", value.strip()).casefold()


def _uid_of(entry: Any) -> str:
    """An entry's `uid` as a comparison key, or `""` if it has none.

    Normalized through `int` because the same uid reaches us spelled both ways — a compiled book
    keys its `entries` dict by the STRING "18" while the entry inside carries the INT 18
    (`assemble.py:523`, `assemble.py:697`) — and `"18" != 18` would read one entry as two.

    ⚠️ `bool` is excluded before the `int` call. `True` is an `int` in Python and would normalize
    to the uid `"1"`, quietly making a garbage entry collide with a real one.
    """
    if not isinstance(entry, dict):
        return ""
    uid = entry.get("uid")
    if uid is None or isinstance(uid, bool):
        return ""
    try:
        return str(int(uid))
    except (TypeError, ValueError):
        return str(uid).strip()


def entry_label(entry: Any, container_key: Any = None) -> str:
    """What to call this entry in a review pane. Same order the editor already uses."""
    if not isinstance(entry, dict):
        return f"entry {container_key}"
    comment = entry.get("comment")
    if isinstance(comment, str) and comment.strip():
        return comment.strip()
    uid = _uid_of(entry)
    return f"uid {uid}" if uid else f"entry {container_key}"


def _same(a: Any, b: Any, *, field: str = "") -> bool:
    """Are these two field values the same? `ABSENT` is only ever equal to `ABSENT`."""
    if isinstance(a, _Absent) or isinstance(b, _Absent):
        return isinstance(a, _Absent) and isinstance(b, _Absent)
    if field in _ORDER_FREE and isinstance(a, list) and isinstance(b, list):
        return sorted(map(repr, a)) == sorted(map(repr, b))
    return a == b


@dataclass
class FieldMerge:
    """One field, the three values it has, and what the merge would do about it."""

    path: list[Any]
    verdict: str
    base: Any = ABSENT
    mine: Any = ABSENT
    theirs: Any = ABSENT
    resolved: Any = ABSENT

    @property
    def name(self) -> str:
        return ".".join(str(p) for p in self.path)

    def to_dict(self) -> dict[str, Any]:
        """JSON for the review pane. An absent side is OMITTED rather than sent as null — see
        `_Absent`: a `null` on the wire is indistinguishable from a deliberate null."""
        out: dict[str, Any] = {"path": list(self.path), "name": self.name,
                               "verdict": self.verdict}
        for key, value in (("base", self.base), ("mine", self.mine), ("theirs", self.theirs)):
            if not isinstance(value, _Absent):
                out[key] = value
        if isinstance(self.resolved, _Absent):
            out["remove"] = True
        else:
            out["resolved"] = self.resolved
        return out


def merge_field(path: list[Any], base: Any, mine: Any, theirs: Any) -> FieldMerge:
    """The table at the top of this module, for one field."""
    field = str(path[-1]) if path else ""
    mine_eq_theirs = _same(mine, theirs, field=field)
    base_eq_mine = _same(base, mine, field=field)
    base_eq_theirs = _same(base, theirs, field=field)

    if mine_eq_theirs:
        verdict, resolved = (UNCHANGED if base_eq_mine else AGREED), mine
    elif base_eq_mine:
        verdict, resolved = TAKE_THEIRS, theirs
    elif base_eq_theirs:
        verdict, resolved = KEEP_MINE, mine
    else:
        verdict, resolved = CONFLICT, mine      # 🔴 The current text stands until the user decides.
    return FieldMerge(path=list(path), verdict=verdict, base=base, mine=mine, theirs=theirs,
                      resolved=resolved)


def merge_mapping(base: Any, mine: Any, theirs: Any, *, prefix: Iterable[Any] = (),
                  skip: Iterable[str] = ()) -> list[FieldMerge]:
    """Every field of a flat-or-nested mapping, three ways. Recurses into dict-valued fields.

    🔴 **THE RECURSION IS WHAT MAKES CARDS FREE.** A V2 character card is a `data` wrapper around
    the fields that matter, so a merge that only looked one level deep would report an entire card
    as one conflicted `data` blob. Recursing means `data.description` and `data.personality` are
    separate verdicts, which gives card fields independent conflict decisions.

    ⚠️ **A LIST IS COMPARED WHOLE, INCLUDING `alternate_greetings`.** Changing greeting #2 reads as
    a change to the whole array, so a card whose greetings both sides touched is one conflict
    rather than three. That is the field-granularity line held deliberately; per-element identity
    inside an anonymous array is the guessing this module refuses to do.
    """
    skipped = frozenset(skip)
    sides = [d if isinstance(d, dict) else {} for d in (base, mine, theirs)]
    names: list[str] = []
    for side in sides:
        for key in side:
            if key not in names:
                names.append(str(key))

    out: list[FieldMerge] = []
    for name in names:
        path = [*prefix, name]
        # 🔴 **A DOTTED PATH, NOT A BARE KEY, BECAUSE THE CONTAINER IS NOT ALWAYS AT THE TOP.** A
        # worldbook keeps its entries at `entries`; a V2 character card keeps an embedded lorebook
        # at `data.character_book.entries`. Matching on the last component alone would also skip a
        # field somebody names `entries` three levels down for unrelated reasons, and matching only
        # at the top level would let the card's embedded book fall into the recursive field merge —
        # where entries are compared by CONTAINER KEY, which is the positional mis-pairing this
        # module's whole identity ladder exists to avoid.
        if ".".join(str(p) for p in path) in skipped:
            continue
        b, m, t = (side.get(name, ABSENT) for side in sides)
        present = [v for v in (b, m, t) if not isinstance(v, _Absent)]
        if present and all(isinstance(v, dict) for v in present):
            out.extend(merge_mapping(b, m, t, prefix=path, skip=skipped))
            continue
        out.append(merge_field(path, b, m, t))
    return out


@dataclass
class EntryMerge:
    """One worldbook entry, aligned across the three sides."""

    status: str
    label: str
    match: str = ""
    uid: str = ""
    fields: list[FieldMerge] = dc_field(default_factory=list)
    #: The container key on each side, so a later applier can address the entry it has to write.
    #: A string for a compiled book and an int for a section chunk file, carried through
    #: unchanged — `doc["entries"]["3"]` and `doc["entries"][3]` are different lookups.
    base_key: Any = None
    mine_key: Any = None
    theirs_key: Any = None
    #: The whole entry, for the statuses where there is no field table to show.
    entry: Any = ABSENT

    @property
    def conflicts(self) -> list[FieldMerge]:
        if self.status == REMOVED_EDITED:
            return []           # the conflict is the entry itself; `MergeResult` counts it
        return [f for f in self.fields if f.verdict == CONFLICT]

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": self.status, "label": self.label, "match": self.match,
                               "uid": self.uid,
                               "keys": {"base": self.base_key, "mine": self.mine_key,
                                        "theirs": self.theirs_key},
                               "fields": [f.to_dict() for f in self.fields]}
        if not isinstance(self.entry, _Absent):
            out["entry"] = self.entry
        return out


@dataclass
class MergeResult:
    """What an import would do to a document, computed before anything is written."""

    entries: list[EntryMerge] = dc_field(default_factory=list)
    doc_fields: list[FieldMerge] = dc_field(default_factory=list)
    #: True when the alignment had to fall off `uid` for most of the book — see `_align`.
    renumbered: bool = False
    #: Whether the entries container is the COMPILED (dict) shape rather than the list one.
    #:
    #: 🔴 **IT TRAVELS ON THE RESULT BECAUSE THE APPLIER CANNOT ALWAYS READ IT OFF THE DOCUMENT.**
    #: A card update that ADDS an embedded lorebook is a merge whose entries are all additions and
    #: whose container does not exist on `mine` at all — there is nothing there to measure. Asking
    #: the document was the first version and it raised on exactly that case.
    compiled: bool = True
    #: Where in the document `entries` live, as a path. A worldbook says `["entries"]`; a V2
    #: character card carrying an embedded lorebook says `["data", "character_book", "entries"]`.
    #:
    #: 🔴 **THE APPLIER READS THIS RATHER THAN ASSUMING `entries`**, which is what lets one merge
    #: engine serve both kinds. A card whose result carried worldbook's default would have its
    #: character fields merged correctly and its entries written to a key nothing reads.
    container: list[Any] = dc_field(default_factory=lambda: ["entries"])

    @property
    def conflicts(self) -> int:
        return (sum(len(e.conflicts) for e in self.entries)
                + sum(1 for e in self.entries if e.status == REMOVED_EDITED)
                + sum(1 for f in self.doc_fields if f.verdict == CONFLICT))

    @property
    def clean(self) -> bool:
        """No conflict requires an explicit resolution; changes may still be present."""
        return self.conflicts == 0

    def tally(self) -> dict[str, int]:
        """Counts per entry status, plus the conflict total. What a summary line is built from."""
        out = {k: 0 for k in (ADDED, REMOVED, REMOVED_EDITED, REMOVED_UPDATED, MINE_ONLY,
                              CHANGED, SAME)}
        for entry in self.entries:
            out[entry.status] = out.get(entry.status, 0) + 1
        out["conflicts"] = self.conflicts
        return out

    def to_dict(self) -> dict[str, Any]:
        return {"entries": [e.to_dict() for e in self.entries],
                "doc_fields": [f.to_dict() for f in self.doc_fields],
                "renumbered": self.renumbered,
                "container": list(self.container),
                "compiled": self.compiled,
                "tally": self.tally()}


def _index(doc: Any) -> tuple[list[tuple[Any, dict]], dict[str, int], dict[str, list[int]]]:
    """`(pairs, by_uid, by_comment)` for one side. Both indices hold POSITIONS into `pairs`.

    🔴 **A UID THAT IS NOT UNIQUE ON ITS OWN SIDE IS NOT AN IDENTITY, SO IT IS DROPPED FROM THE
    INDEX.** `assemble.py:284` asserts uniqueness for a book Vocalis builds, but this side may be
    a file a model wrote, and a file with two entries claiming uid 7 would otherwise have one of
    them silently win the lookup — putting one entry's text into another entry's history, which is
    the exact harm `import_from_file` refuses to risk on cards. A dropped uid falls through to the
    comment rung, which is honest about being weaker.
    """
    try:
        pairs = list(worldbook.iter_entries(doc))
    except ValueError:
        pairs = []

    first: dict[str, int] = {}
    dupes: set[str] = set()
    for pos, (_key, entry) in enumerate(pairs):
        uid = _uid_of(entry)
        if not uid:
            continue
        if uid in first:
            dupes.add(uid)
        else:
            first[uid] = pos
    by_uid = {u: p for u, p in first.items() if u not in dupes}

    by_comment: dict[str, list[int]] = {}
    for pos, (_key, entry) in enumerate(pairs):
        name = _fold(entry.get("comment"))
        if name:
            by_comment.setdefault(name, []).append(pos)
    return pairs, by_uid, by_comment


_SIDES = ("base", "mine", "theirs")


def _align(base: Any, mine: Any, theirs: Any) -> tuple[list[dict], bool]:
    """Decide which entries on each side are the same entry. Returns `(slots, renumbered)`.

    A slot is `{"base": pos|None, "mine": pos|None, "theirs": pos|None, "match": rung}`.

    Match by stable `uid` first. Use a unique `comment` title as a fallback when an incoming file
    regenerates entries and changes their numbering.

    ⚠️ **`match` REPORTS THE WEAKEST RUNG THE SLOT NEEDED, NEVER THE STRONGEST.** A slot whose
    `base`/`mine` pair came from a uid but whose `theirs` had to be found by title is a
    `BY_COMMENT` slot, because that title is what the whole three-way comparison now rests on.
    Reporting `BY_UID` there would tell the pane the pairing is stronger than it is.

    There is no similarity-based fallback: a weak match could merge one entry's text into another.
    Entries matching neither rung are reported separately as `ADDED` and `REMOVED`.

    `renumbered` is the tell that a file was rebuilt rather than edited, and it has TWO triggers —
    uid matching produced almost nothing, or it produced plenty and the titles under those uids
    disagree. It changes no verdict. It is what lets the pane say *"this file looks regenerated"*
    rather than present a 40-add/40-delete wall, or a wall of nonsense conflicts, as if either were
    the truth. See the comment above the computation for why the second trigger is the dangerous
    one.
    """
    indexed = {name: _index(doc) for name, doc in zip(_SIDES, (base, mine, theirs))}
    taken: dict[str, set[int]] = {name: set() for name in _SIDES}
    slots: list[dict] = []

    def claim(slot: dict) -> None:
        for name in _SIDES:
            if slot[name] is not None:
                taken[name].add(slot[name])
        slots.append(slot)

    def ordered(which: int) -> list[str]:
        """Return keys in first-seen order across all sides for deterministic slot ordering."""
        out: list[str] = []
        for name in _SIDES:
            for key in indexed[name][which]:
                if key not in out:
                    out.append(key)
        return out

    def title_of(name: str, pos: int) -> str:
        return _fold(indexed[name][0][pos][1].get("comment"))

    def only_free(name: str, title: str) -> int | None:
        """The one unclaimed entry on `name` carrying `title`, or None if there is not exactly one.

        UNIQUE ON ITS SIDE OR IT IS NOT A MATCH. Two entries sharing one title is exactly the
        ambiguity `AmbiguousName` refuses to guess through at the library level.
        """
        free = [p for p in indexed[name][2].get(title, []) if p not in taken[name]]
        return free[0] if len(free) == 1 else None

    # ── rung 1: uid ──────────────────────────────────────────────────────────────────────────
    for uid in ordered(1):
        slot: dict = {n: indexed[n][1].get(uid) for n in _SIDES}
        if sum(1 for n in _SIDES if slot[n] is not None) < 2:
            continue                                # one side only — not a match, try rung 2
        slot["match"] = BY_UID
        claim(slot)

    # 🔴 **MEASURED BEFORE RUNG 2 TOUCHES THE SLOTS, AND OVER `base`↔`theirs` ONLY.** The question
    # `renumbered` answers is "did the incoming file keep OUR numbering", so a slot that paired
    # `base` with `mine` — the two sides that are the same lineage and always agree on uids —
    # is evidence of nothing and must not be counted. Counting all rung-1 slots was the first
    # version and it read a fully renumbered file as perfectly matched.
    bridged = [s for s in slots if s["base"] is not None and s["theirs"] is not None]
    # ⚠️ **THE SECOND TRIGGER IS THE DANGEROUS ONE, AND IT IS WHY THIS IS NOT JUST A COUNT.** A
    # model that rebuilds the book from scratch may still number its entries 0..N — so every uid
    # "matches" while uid 3 is a different entry on each side. Rung 1 pairs them and the merge
    # then compares one entry's prose against another's. It is not silent (three-way disagreement
    # surfaces as a conflict rather than as a write) but a wall of conflicts is difficult to
    # resolve and gives no reason. The tell is cheap: a uid pairing whose
    # two sides carry DIFFERENT non-empty titles. One of those is a renamed entry, which is
    # ordinary; most of them is a renumbered file.
    disagreed = sum(1 for s in bridged
                    if title_of("base", s["base"]) and title_of("theirs", s["theirs"])
                    and title_of("base", s["base"]) != title_of("theirs", s["theirs"]))

    # ── rung 2a: fill the MISSING side of a slot rung 1 could only half-make ─────────────────
    #
    # 🔴 **WITHOUT THIS, RUNG 1 CLOSING A SLOT LOCKED RUNG 2 OUT OF IT — AND THAT IS THE WHOLE
    # RENUMBERED CASE.** `base` and `mine` are one lineage, so they share uids and pair every
    # time; a regenerated `theirs` shares none. The first version claimed the base+mine pair as
    # finished and then had nowhere to put the file's entry, so a book that merely got new uids
    # came out as delete-everything plus add-everything — the exact result the comment rung
    # exists to prevent. Two specs caught it (`..._matched_by_title_and_says_so`, and the
    # duplicate-uid one, which reaches the same hole by a different road).
    for slot in slots:
        # `mine` first: if the current side renamed the entry, its title is the one to look for. `base`'s stays
        # in the list behind it, so a rename on ONE side still finds the entry on the other.
        titles: list[str] = []
        for name in ("mine", "base", "theirs"):
            if slot[name] is None:
                continue
            title = title_of(name, slot[name])
            if title and title not in titles:
                titles.append(title)
        for name in _SIDES:
            if slot[name] is not None:
                continue
            for title in titles:
                pos = only_free(name, title)
                if pos is not None:
                    slot[name] = pos
                    taken[name].add(pos)
                    slot["match"] = BY_COMMENT
                    break

    # ── rung 2b: pair what is still loose, by title ──────────────────────────────────────────
    for title in ordered(2):
        slot = {n: None for n in _SIDES}
        hits = 0
        for name in _SIDES:
            pos = only_free(name, title)
            if pos is not None:
                slot[name] = pos
                hits += 1
        if hits < 2:
            continue
        slot["match"] = BY_COMMENT
        claim(slot)

    # ── whatever is left stands alone ────────────────────────────────────────────────────────
    for name in _SIDES:
        for pos in range(len(indexed[name][0])):
            if pos in taken[name]:
                continue
            slot = {n: None for n in _SIDES}
            slot[name] = pos
            slot["match"] = ""
            claim(slot)

    smaller = min(len(indexed["base"][0]), len(indexed["theirs"][0]))
    thin = bool(smaller and len(bridged) * 2 < smaller)
    return slots, bool(thin or disagreed * 2 > len(bridged))


def _shape(*sides: Any) -> bool:
    """Is the entries container a dict? The first side that HAS one decides.

    🔴 **`mine` is passed first, always.** The applier builds the current document, so a section chunk file
    whose head keeps `entries` as a list must not come back as a compiled dict because the incoming
    file happened to be one. The later sides are consulted only when the current side has no container to read —
    a card that is gaining an embedded lorebook from this very merge.
    """
    for side in sides:
        entries = side.get("entries") if isinstance(side, dict) else None
        if isinstance(entries, (dict, list)):
            return isinstance(entries, dict)
    return True


def _merge_entries(base: Any, mine: Any, theirs: Any) -> tuple[list[EntryMerge], bool]:
    """The entry half of a merge: `(entries, renumbered)`.

    Takes the documents that HOLD the entries, which is not always the document being
    merged: a worldbook holds them itself, and a V2 character card holds a whole lorebook
    at `data.character_book`. `worldbook.iter_entries` reads either container shape, so
    handing it the sub-document is all the generalization this needs.
    """
    out: list[EntryMerge] = []
    slots, renumbered = _align(base, mine, theirs)
    pairs = {name: _index(doc)[0]
             for name, doc in zip(_SIDES, (base, mine, theirs))}

    for slot in slots:
        sides = {}
        for name in _SIDES:
            pos = slot[name]
            sides[name] = (None, ABSENT) if pos is None else pairs[name][pos]
        (base_key, base_entry) = sides["base"]
        (mine_key, mine_entry) = sides["mine"]
        (theirs_key, theirs_entry) = sides["theirs"]
        has_base = not isinstance(base_entry, _Absent)
        has_mine = not isinstance(mine_entry, _Absent)
        has_theirs = not isinstance(theirs_entry, _Absent)

        shown, shown_key = ((mine_entry, mine_key) if has_mine else
                            (theirs_entry, theirs_key) if has_theirs else (base_entry, base_key))
        item = EntryMerge(status=SAME, label=entry_label(shown, shown_key),
                          match=slot.get("match", ""), uid=_uid_of(shown),
                          base_key=base_key, mine_key=mine_key, theirs_key=theirs_key)

        if not has_mine:
            # ⚠️ **THE FILE'S VERSION RIDES ALONG WHENEVER THERE IS ONE, NOT ONLY FOR AN ADD.** The
            # default for a deleted entry is to leave it deleted — but the pane can only offer
            # the other answer if it is holding the text to show, and `apply_merge` can only
            # honor a "keep" if the entry it would write is somewhere in the result. Carrying it
            # costs a reference; not carrying it makes the choice unofferable.
            if has_theirs:
                item.entry = theirs_entry
            if has_theirs and not has_base:
                item.status = ADDED             # new in the file and new to the lineage
            elif has_theirs and has_base:
                # 🔴 The current side deleted it and the file still has it; re-adding is not a merge.
                # `base` proves the entry was present before deletion, so putting it back because
                # the file still carries it would undo the current edit, which is the
                # one thing this feature exists to stop. It stays deleted either way; the two
                # statuses differ only in whether the tally has something to mention.
                changed_there = any(f.verdict != UNCHANGED
                                    for f in merge_mapping(base_entry, base_entry, theirs_entry))
                item.status = REMOVED_UPDATED if changed_there else REMOVED
            else:
                item.status = REMOVED           # gone from both live sides; already agreed
            out.append(item)
            continue

        if not has_theirs:
            if not has_base:
                item.status = MINE_ONLY         # Added on the current side after the last import.
            else:
                item.fields = merge_mapping(base_entry, mine_entry, mine_entry)
                edited = any(f.verdict != UNCHANGED for f in item.fields)
                item.status = REMOVED_EDITED if edited else REMOVED
            out.append(item)
            continue

        item.fields = merge_mapping(base_entry, mine_entry, theirs_entry)
        # 🔴 **`CHANGED` MEANS THE MERGE WRITES SOMETHING HERE, NOT THAT THE ENTRY DIFFERS FROM
        # `base`.** The first version asked whether any field's verdict was `UNCHANGED`, which
        # counts an entry only the current side changed — the file agreeing with `base` — as a change.
        # Nothing happens to that entry: every field resolves to its current values. Reporting
        # it puts a row in the review pane that says "no difference" on every line, and the pane's
        # purpose is to show what this import does.
        #
        # ⚠️ **A CONFLICT IS `CHANGED` EVEN THOUGH IT WRITES `mine`**, and that is not an
        # inconsistency — a decision the user must make is the one thing that must never be filtered
        # out of the list, and `resolved == mine` is exactly what a pending conflict looks like.
        touched = any(not _same(f.resolved, f.mine, field=str(f.path[-1])) for f in item.fields)
        conflicted = any(f.verdict == CONFLICT for f in item.fields)
        item.status = CHANGED if (touched or conflicted) else SAME
        out.append(item)

    return out, renumbered


def merge_worldbook(base: Any, mine: Any, theirs: Any) -> MergeResult:
    """Merge an incoming worldbook (`theirs`) into the head (`mine`), against `base`.

    `base` is the revision the PREVIOUS import landed as — not necessarily revision 0, which is
    what makes the second merge of a book correct. Finding it is the store's job, not this one's.

    ⚠️ **THE THREE SIDES MAY NOT BE THE SAME SHAPE.** A compiled ST book keys `entries` by string
    and spells the keyword field `key`; a section chunk file uses a list and `keys`
    (`worldbook.iter_entries` reads both). Entries are therefore aligned by IDENTITY and never by
    container key, and each side's own key rides on the slot so an applier can address the entry it
    has to write. An applier must build its output in `mine`'s shape.
    """
    result = MergeResult()
    result.doc_fields = merge_mapping(base, mine, theirs, skip=_ENTRY_CONTAINERS)
    result.entries, result.renumbered = _merge_entries(base, mine, theirs)
    result.compiled = _shape(mine, theirs, base)
    return result

#: Where a character card keeps an embedded lorebook. V2 wraps everything in `data`; V1 is flat,
#: and both spellings are excluded so neither falls into the recursive field merge.
_CARD_BOOK = ("data", "character_book")
_CARD_BOOK_V1 = ("character_book",)
_CARD_CONTAINERS = frozenset({"data.character_book.entries", "character_book.entries"})


def _at(doc: Any, path: Iterable[str]) -> Any:
    """`doc` walked down `path`, or `{}` where it does not resolve."""
    node = doc
    for key in path:
        if not isinstance(node, dict):
            return {}
        node = node.get(key)
    return node if isinstance(node, dict) else {}


def merge_card(base: Any, mine: Any, theirs: Any) -> MergeResult:
    """Merge an incoming character card (`theirs`) into the head (`mine`), against `base`.

    Cards use the same field-level `merge_mapping` rules as worldbooks. Nested fields such as
    `data.description` and `data.personality` receive independent verdicts.

    The caller identifies the target card. Display names are not unique identities, so this
    function never guesses which card an incoming file should update.

    Embedded `character_book` entries use the entry identity walk rather than a blob-level mapping,
    avoiding positional pairing when entry keys differ.
    """
    result = MergeResult(container=[*_CARD_BOOK, "entries"])
    result.doc_fields = merge_mapping(base, mine, theirs, skip=_CARD_CONTAINERS)

    # V2 first, for `detect.doc_kind`'s reason — a V1 card is the fallback shape, not the likely
    # one, and a document carrying both would be a V2 card with a stray key.
    for path in (_CARD_BOOK, _CARD_BOOK_V1):
        books = [_at(side, path) for side in (base, mine, theirs)]
        if not any(book.get("entries") is not None for book in books):
            continue
        result.container = [*path, "entries"]
        result.entries, result.renumbered = _merge_entries(*books)
        # `books` is (base, mine, theirs); `_shape` wants the current side first.
        result.compiled = _shape(books[1], books[2], books[0])
        break
    return result
