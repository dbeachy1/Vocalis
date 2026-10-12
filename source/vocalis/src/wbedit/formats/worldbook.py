"""Worldbooks: the compiled ST lorebook and the pre-compile section chunk file.

The two differ in exactly two ways and are otherwise the same document:

  * compiled ST  — `{entries: {"0": {...}}}`, `entries` a **dict**, key field named `key`
  * section file — `{section, section_name, entry_limit, notes, entries: [...]}`, `entries` a
    **list**, key field named `keys`

Both reach the same locator walk, so the difference dies here rather than propagating.
"""
from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any, Iterator

from ..core.job import Job

#: Entries are processed uniformly regardless of their label or prefix. Review visibility is a
#: UI choice; it does not change which entries a pass reads or updates.
ENTRY_KIND = "a lorebook entry"

#: An entry's injection mode, in one word.
#:
#: SillyTavern classifies entries as constant, vectorized, or normal, with `disable` orthogonal to
#: those modes. Check `disable` first because disabled entries never activate.
MODES = ("disabled", "constant", "vectorized", "normal")


def entry_mode(entry: Any) -> str:
    """Which of `MODES` this worldbook entry is in. Unknown/garbage reads as `"normal"`."""
    if not isinstance(entry, dict):
        return "normal"
    if entry.get("disable") is True:
        return "disabled"
    if entry.get("constant") is True:
        return "constant"
    if entry.get("vectorized") is True:
        return "vectorized"
    return "normal"


def fires_by_keyword(entry: Any) -> bool:
    """Does SillyTavern activate this entry ONLY on a keyword match? (§9a.29a)

    Read straight off `entry_mode` above so there is one answer to "what kind of entry is this":
      * `constant`   — injected every time; keys are ignored (their own editor says so).
      * `vectorized` — activated by the vectors extension through `getExternallyActivated`,
                       which runs BEFORE the keyless skip. It fires on similarity, not keys.
      * `disabled`   — never activates at all, so a missing key changes nothing.
      * `normal`     — the only one that reaches the key scan. ← True

    ⚠️ `sticky` is deliberately NOT an exemption. `isSticky` is
    `timedEffects.isEffectActive('sticky', entry)` — a RUNTIME state that is only true for an
    entry which has ALREADY fired and is serving out its duration. An entry with `sticky: N`
    and no keys has no way to fire the first time, so it is exactly as inert as a plain keyless
    normal entry; exempting it here would wave through the thing this predicate exists to catch.
    """
    return entry_mode(entry) == "normal"


def entry_keys(entry: Any) -> list:
    """The activation keywords, under either spelling. A compiled ST book says `key`; a section
    chunk file says `keys` (`assemble.py:218` aliases one to the other on the way in)."""
    if not isinstance(entry, dict):
        return []
    keys = entry.get("keys") or entry.get("key") or []
    return [k for k in keys if str(k).strip()] if isinstance(keys, list) else []


def inert_entries(doc: Any) -> list[dict]:
    """Every entry SillyTavern will silently never fire: `normal`, with no keywords.

    Returns `{"label", "entry"}` per offender, in document order — the LABEL so the refusal can
    name what to fix (a 110-entry book refused with "no" is a refusal nobody can act on), and the
    ENTRY locator so the editor can mark the exact rows rather than string-matching on a
    `comment` that is neither unique nor required.

    🔴 Verified against the configured fork (`public/scripts/world-info.js`): the
    `has no keys defined, skipped` branch sits AFTER the `constant` and `isSticky` activations
    and after the `@@activate` decorator and `getExternallyActivated` branches, so exactly the
    entries `fires_by_keyword` calls True are the ones it can reach.
    """
    out: list[dict] = []
    try:
        pairs = list(iter_entries(doc))
    except ValueError:
        return out                                   # not a worldbook — not this rule's business
    compiled = is_compiled(doc)
    for ckey, entry in pairs:
        if fires_by_keyword(entry) and not entry_keys(entry):
            out.append({
                "label": str(entry.get("comment") or entry.get("uid") or f"entry {ckey}"),
                # Matches `Job.meta["entry"]` exactly — the same list the editor already holds
                # per field, so the client compares locators and never labels.
                "entry": ["entries", ckey] if compiled else [ckey],
            })
    return out


def _stem(rel: str) -> str:
    """`"chapters/03 Guilds.json"` -> `"03 Guilds"`. A display name, not a path: `rel` may carry
    either separator depending on what imported it, and neither is touched on disk."""
    return PurePosixPath(rel.replace("\\", "/")).stem


def iter_entries(doc: Any) -> Iterator[tuple[Any, dict]]:
    """Yield `(container_key, entry)` for both shapes.

    The container key is a **string** for a compiled book and an **int** for a section file, and
    it is carried through into the locator unchanged — `doc["entries"]["3"]` and
    `doc["entries"][3]` are different lookups and only one of them is right per format.
    """
    entries = doc.get("entries") if isinstance(doc, dict) else doc
    if isinstance(entries, dict):                       # compiled ST lorebook
        for k, v in entries.items():
            if isinstance(v, dict):
                yield k, v
    elif isinstance(entries, list):                     # section chunk file
        for i, v in enumerate(entries):
            if isinstance(v, dict):
                yield i, v
    else:
        raise ValueError("no 'entries' list or dict found")


def entries_for_import(doc: Any) -> list[dict]:
    """The entries in a file being imported into a book.

    Three shapes reach this, and refusing two of them would be refusing the same data on a
    technicality:

      * `{"entries": {"18": {...}}}` — a compiled book holding one entry.
      * `{"entries": [ ... ]}` — the section-chunk spelling, or a model that chose a list.
      * `{"uid": 18, "key": [...], "content": "..."}` — the bare entry, no container.

    ⚠️ **THE BARE SHAPE IS RECOGNIZED BY ITS FIELDS, NOT BY ELIMINATION.** "A dict that is not a
    book must be an entry" would accept a character card, an instruction library, `{}` — anything —
    and drop it into a World Book as one entry whose text is the placeholder. The four names
    below are the ones an entry cannot be useful without; a document holding none of them is not
    an entry and is refused at the door with a message that says what was expected.

    📌 Returns `[]` rather than raising. The caller turns that into one 400 with a useful message;
    there is nothing here worth distinguishing between "no `entries` key" and
    "`entries` was a string" — both mean *that file is not an entry*.
    """
    try:
        found = [e for _key, e in iter_entries(doc)]
    except ValueError:
        found = []
    if found:
        return found
    if isinstance(doc, dict) and any(k in doc for k in ("content", "comment", "key", "keys")):
        return [doc]
    return []


def is_compiled(doc: Any) -> bool:
    """Is this the COMPILED SillyTavern shape — `{entries: {"0": {...}}}`, a dict?

    🔴 **The typed settings surface is available only for compiled books.**
    The 38-field schema those widgets are built from is SillyTavern's, and only a compiled book
    has it. A section chunk uses the authoring shape: `entries` is a LIST, the key field is
    named `keys` rather than `key`, and it carries build-only fields (`id`, `class`, `notes`) that
    `expand()` consumes and never emits. Offering the ST widget set over a chunk would write
    `key` beside its `keys`, and `assemble.expand` aliases `keys` over `key` — so an edited value
    would be silently overwritten at build time,
    with no error anywhere.
    """
    return isinstance(doc, dict) and isinstance(doc.get("entries"), dict)


def jobs(doc: Any, *, rel: str, field: str = "content") -> list[Job]:
    """Every entry whose `field` holds non-blank text, in document order.

    A blank or missing field is not an edit target — there is nothing to send and nothing to
    validate a reply against. It is skipped silently and deliberately: a "failed" row for an entry
    that was always empty is noise in a 110-row report.
    """
    listed = isinstance(doc, list)
    compiled = is_compiled(doc)
    section = _stem(rel) if listed else str(
        doc.get("section_name") or doc.get("section") or _stem(rel))
    out: list[Job] = []
    for ckey, entry in iter_entries(doc):
        original = entry.get(field)
        if not isinstance(original, str) or not original.strip():
            continue
        label = str(entry.get("comment") or entry.get("uid") or f"{_stem(rel)}#{ckey}")
        keys = entry.get("keys") or entry.get("key") or []
        loc: tuple = (ckey, field) if listed else ("entries", ckey, field)
        out.append(Job(
            rel=rel, locator=loc, label=label, original=original,
            meta={
                "section": str(section),
                "keys": [str(k) for k in keys] if isinstance(keys, list) else [],
                "constant": bool(entry.get("constant", False)),
                "mode": entry_mode(entry),
                "kind": ENTRY_KIND,
                "note": "",
                # m5g / §9a.26 — WHERE THE ENTRY ITSELF LIVES, so the editor can address its
                # settings without inferring them from `locator[:-1]`. That inference is right for
                # every worldbook job and wrong for a card's own fields (`("data","description")`
                # would yield `("data",)`), and a rule that is right by coincidence is one refactor
                # from writing `sticky` into the top of a character card.
                "entry": list(loc[:-1]) if compiled else None,
                # 🔴 Passive marker for keyless normal entries. The save refusal only fires on an
                # explicit save; an entry that arrived keyless is just as inert and may otherwise
                # appear valid in the book.
                #
                # 🔴 COMPUTED FROM THE ONE PREDICATE, HERE, NOT RE-DERIVED ON THE WIRE OR IN THE
                # BROWSER. `keys` below is the raw list and does not drop blank strings, so a
                # client-side `!keys.length` would call `key: [""]` keyed and disagree with the
                # route that refuses it — which is §9a.29a's "lift one definition rather than grow
                # a second that can disagree", in the exact place it would have grown.
                "inert": fires_by_keyword(entry) and not entry_keys(entry),
            },
        ))
    return out
