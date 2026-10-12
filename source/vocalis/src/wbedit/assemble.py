"""Assemble a compiled worldbook from section chunks.

The pure assembler expands entries from chunk defaults, validates the result, and reports token
budget estimates. It accepts parsed documents; file discovery, parsing, and error handling belong
to the caller. Chunk files are sorted by filename before assigning identifiers so upload order
cannot change compiled output.

🔴 **IT IS NOT A CONCATENATOR.** Three jobs, and the third is the prize:

1. **Expand** — chunk entries are lightweight; each is overlaid onto the full ~40-field ST entry
   set from `DEFAULTS`, `keys` is aliased to `key`, the build-only fields are dropped, and `uid`
   and `displayIndex` are assigned sequentially.
2. **Validate** — errors abort, warnings do not. 🔴 **Keep that split.** An entry that can never
   fire is a defect; a noisy key is a judgment call.
3. **Budget analysis** — constant footprint, and worst-case concurrency: for every key, what it
   drags in *plus* every constant, with inclusion groups counted as their largest member rather
   than their sum. That is a genuine "will this book work in context" preflight, and in the CLI
   it scrolls past in a terminal. In the UI it is a headline.

🔴 **THIS MODULE DOES NO I/O, LIKE EVERY OTHER MODULE UNDER `wbedit/` EXCEPT `store/`.** The CLI
globbed a directory, read each file and `sys.exit`-ed on a bad one; all three belong to the
caller now. `assemble()` takes a list of `(filename, parsed_document)` and returns a result. That
is the same change `formats/` went through in 6.4-m1c, for the same reason (§7.1).

🔴 **FILENAME ORDER IS LOAD-BEARING AND A BROWSER WILL NOT PRESERVE IT.** The script does
`sorted(glob("sections/*.json"))`, so the `A_`/`B_`/…/`X_` prefixes determine uid assignment.
A multi-file upload arrives in arbitrary order, so `assemble()` sorts by filename itself —
exactly as the script does. Skip it and uids shuffle between builds, producing a gratuitous diff
against SillyTavern that is invisible when wrong and cheap to get right.

📌 Section prefixes do not change processing: every chunk is expanded, validated, and reported
the same way.
"""
from __future__ import annotations

import copy
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field as dc_field
from typing import Any

from .formats import depthfix as _depthfix
from .formats import merge as _merge_mod
from .formats import validate as _validate
from .formats import worldbook as _worldbook

#: Baseline build defaults. Keep these aligned with the source builder; changing a value alters
#: the compiled book.
FALLBACK_CONFIG: dict[str, Any] = {
    "world_name": "",
    "out": "lorebook-full.json",
    "chars_per_token": 4.0,
    "constant_token_budget": 1300,
    "wi_budget_tokens": 12096,
    "limits": {"constant": 1000, "standard": 900, "character": 1800, "mechanics": 1700},
    "noisy_keys": [],
    "warn_unprotected_constants": True,
}

DEFAULTS: dict[str, Any] = {
    "key": [], "keysecondary": [], "comment": "", "content": "", "constant": False,
    "vectorized": False, "selective": True, "selectiveLogic": 0, "addMemo": True,
    "order": 20, "position": 0, "disable": False, "ignoreBudget": False,
    "excludeRecursion": False, "preventRecursion": False, "delayUntilRecursion": False,
    "probability": 100, "useProbability": True, "depth": 4, "group": "",
    "groupOverride": False, "groupWeight": 100, "scanDepth": None, "caseSensitive": None,
    "matchWholeWords": None, "useGroupScoring": None, "automationId": "", "role": None,
    "sticky": 0, "cooldown": 0, "delay": 0, "matchPersonaDescription": False,
    "matchCharacterDescription": False, "matchCharacterPersonality": False,
    "matchCharacterDepthPrompt": False, "matchScenario": False, "matchCreatorNotes": False,
    "triggers": [], "outletName": "",
}

#: A new entry defaults to at-depth placement. This is separate from `DEFAULTS`, which fills
#: omitted values in existing section chunks during assembly.
NEW_ENTRY_POSITION = _depthfix.POS_AT_DEPTH
NEW_ENTRY_DEPTH = _depthfix.DEFAULT_DEPTH

#: Consumed by the build, never emitted into the lorebook.
BUILD_ONLY = {"id", "class", "keys", "notes"}
KNOWN_CHUNK_KEYS = set(DEFAULTS) | BUILD_ONLY | {"uid", "displayIndex"}
VALID_CLASSES = {"constant", "standard", "character", "mechanics"}

CONFIG_NAME = "build-config.json"


class AssemblyFailed(ValueError):
    """The chunks cannot be assembled into a book.

    Carries `.errors` — the list `validate()` produced. 🔴 **An error ABORTS.** The CLI exits;
    here the caller must not fall back to writing the book anyway, because "a book with three
    entries that can never fire" is precisely the failure this validator exists to catch and it
    is invisible in SillyTavern until a scene silently lacks its lore.
    """

    def __init__(self, errors: list[str]):
        super().__init__(f"{len(errors)} error(s)")
        self.errors = list(errors)


@dataclass
class Report:
    """What an assembly produced, as data rather than as printed lines.

    The CLI's `report()` wrote 45 lines to a terminal. In the UI the budget numbers are a
    headline (§6.5), so they travel as numbers — a consumer that has to regex a paragraph to
    find the worst-case token count is one refactor from showing the wrong one.
    """

    entries: int = 0
    sections: list[dict[str, Any]] = dc_field(default_factory=list)
    errors: list[str] = dc_field(default_factory=list)
    warnings: list[str] = dc_field(default_factory=list)
    constant_tokens: float = 0.0
    constant_budget: float = 0.0
    worst_key: str = ""
    worst_tokens: float = 0.0
    wi_budget: float = 0.0
    world_name: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"entries": self.entries, "sections": list(self.sections),
                "errors": list(self.errors), "warnings": list(self.warnings),
                "constant_tokens": round(self.constant_tokens, 1),
                "constant_budget": self.constant_budget,
                "worst_key": self.worst_key, "worst_tokens": round(self.worst_tokens, 1),
                "wi_budget": self.wi_budget, "world_name": self.world_name}


#: Every config value that is used as a NUMBER downstream, and what it is used for. 🔴 A wrong
#: type in any of these is a raw `TypeError` out of `validate()` — see `_check_config`.
_NUMERIC_CONFIG = {
    "chars_per_token": "characters per token",
    "constant_token_budget": "the constant token budget",
    "wi_budget_tokens": "the World Info token budget",
}


def _number(v: Any) -> bool:
    """A real, finite number — and `True`/`False` are neither, whatever `isinstance` says."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _check_config(user: Any) -> None:
    """Refuse a `build-config.json` that would detonate somewhere inside `validate()` — 4.4.

    🔴 **SEVEN SHAPES, ALL OF THEM ONE UPLOADED FILE, ALL OF THEM A 500.** The route catches
    `AssemblyFailed` and nothing else, so every one of these left the process as an unhandled
    exception with no message: `chars_per_token: 0` → `ZeroDivisionError`; `chars_per_token:
    "four"` → `TypeError`; `limits: "none"` → `AttributeError` on `.get`; `limits: {"standard":
    "900"}` → `TypeError` comparing `int > str`; `noisy_keys: 5` → `TypeError` (not iterable);
    `constant_token_budget: "lots"` and `wi_budget_tokens: null` → `TypeError` on `>`.

    ⚠️ **AND `noisy_keys: "ledger"` IS IN HERE FOR THE OPPOSITE REASON.** A string is iterable, so
    it did not crash — it silently made every LETTER a high-frequency key and buried the report in
    warnings about `'l'`, `'e'`, `'d'`. A quiet wrong answer on the supplied config file is worse
    than the crashes because the caller receives no indication that it was misread.
    """
    if user is None:
        return
    if not isinstance(user, dict):
        raise AssemblyFailed([f"{CONFIG_NAME} is a {type(user).__name__}, not a JSON object"])
    for key, what in _NUMERIC_CONFIG.items():
        if key in user and not _number(user[key]):
            raise AssemblyFailed([f"{CONFIG_NAME}: `{key}` ({what}) must be a number"])
    if "chars_per_token" in user and user["chars_per_token"] <= 0:
        raise AssemblyFailed([f"{CONFIG_NAME}: `chars_per_token` must be greater than zero — "
                              "it is what every token count is divided by"])
    if "limits" in user:
        limits = user["limits"]
        if not isinstance(limits, dict):
            raise AssemblyFailed([f"{CONFIG_NAME}: `limits` must be an object of "
                                  f"class -> character ceiling, not a {type(limits).__name__}"])
        for name, v in limits.items():
            if not _number(v):
                raise AssemblyFailed([f"{CONFIG_NAME}: `limits.{name}` must be a number"])
    if "noisy_keys" in user and not isinstance(user["noisy_keys"], list):
        raise AssemblyFailed([f"{CONFIG_NAME}: `noisy_keys` must be a list of keys, not a "
                              f"{type(user['noisy_keys']).__name__}"])


def merge_config(user: Any) -> dict[str, Any]:
    """`build-config.json` over the fallback. Unknown keys are ignored, as in the baseline.

    Raises `AssemblyFailed` for a config whose values are the wrong TYPE — see `_check_config`.
    Unknown KEYS are still ignored, which is the baseline's behavior and a different question:
    a key we do not know about cannot break anything, and a value of the wrong type breaks
    everything.
    """
    _check_config(user)
    cfg = copy.deepcopy(FALLBACK_CONFIG)
    if isinstance(user, dict):
        for k, v in user.items():
            if k == "limits" and isinstance(v, dict):
                cfg["limits"].update(v)
            elif k in cfg:
                cfg[k] = v
    cfg["noisy_keys"] = {str(k).lower().strip() for k in cfg["noisy_keys"]}
    return cfg


def expand(raw: dict, uid: int, fname: str, warnings: list[str]) -> dict:
    """One lightweight chunk entry -> a full SillyTavern entry.

    Starts from `DEFAULTS` and overlays everything the chunk sets, so any ST field is reachable
    from a chunk file. An unrecognized key is WARNED about and passed through, never dropped —
    a silent drop is how a typo becomes a field that quietly stopped working.
    """
    unknown = set(raw) - KNOWN_CHUNK_KEYS
    if unknown:
        label = raw.get("id") or raw.get("comment") or f"uid {uid}"
        warnings.append(f"{label} [{fname}]: unrecognized field(s) "
                        f"{', '.join(sorted(unknown))} — typo? Passed through unchanged.")

    entry = dict(DEFAULTS)
    for k, v in raw.items():
        if k in BUILD_ONLY:
            continue
        entry[k] = v
    if "keys" in raw:
        entry["key"] = raw["keys"]          # the chunk-schema alias for ST's `key`
    entry["uid"] = uid
    entry["displayIndex"] = uid
    return entry


def classify(raw: dict, entry: dict) -> str:
    """The entry's class. An explicit `class` wins — and is returned VERBATIM even when invalid,
    so `validate()` flags it rather than the heuristic silently covering for a typo."""
    declared = raw.get("class")
    if declared is not None:
        return declared
    if entry["constant"]:
        return "constant"
    if entry["sticky"]:
        return "character"
    return "standard"


def validate(entries: list[dict], meta: list[dict], cfg: dict,
             strict: bool = False) -> tuple[list[str], list[str], str, float]:
    """(errors, warnings, worst_key, worst_tokens). Ported from the baseline, logic unchanged."""
    errors: list[str] = []
    warnings: list[str] = []
    cpt = cfg["chars_per_token"]

    for e, m in zip(entries, meta):
        label = m["label"]
        if not str(e["content"]).strip():
            errors.append(f"{label}: empty content")
        if not e["constant"] and not e["key"]:
            errors.append(f"{label}: non-constant entry with no keys — it can never fire")
        if e["constant"] and e["key"]:
            warnings.append(f"{label}: constant entry also has keys (keys are ignored)")
        if e["constant"] and not e["ignoreBudget"] and cfg["warn_unprotected_constants"]:
            warnings.append(f"{label}: constant without ignoreBudget — a firing sticky entry "
                            "can displace it, since sticky sorts ahead of order at budget time")
        if m["class"] not in VALID_CLASSES:
            warnings.append(f"{label}: unknown class '{m['class']}' — expected one of "
                            f"{', '.join(sorted(VALID_CLASSES))}")
        if e["group"] and e["groupWeight"] == DEFAULTS["groupWeight"]:
            warnings.append(f"{label}: in group '{e['group']}' but groupWeight left at default "
                            "— all members equally likely")

    ids = [m["ident"] for m in meta if m["ident"]]
    for name, n in Counter(ids).items():
        if n > 1:
            errors.append(f"duplicate entry id '{name}' appears {n} times")

    anon = [m["label"] for m in meta if not m["ident"]]
    if anon:
        errors.append(f"{len(anon)} entry/entries have neither `id` nor `comment` and cannot be "
                      f"identified: {', '.join(anon[:4])}" + ("..." if len(anon) > 4 else ""))

    if len({e["uid"] for e in entries}) != len(entries):
        errors.append("uid collision — build logic fault")

    # 🔴 Build the key-to-entry maps once. Re-scanning and normalizing each entry for every key
    # is quadratic in entries × keys; reusing these maps avoids repeated work on uploads up to the
    # route's 32 MB limit.
    #
    # ⚠️ `key_map` counts a key ONCE PER OCCURRENCE and `firing_by_key` once per ENTRY, and the
    # difference is deliberate: an entry that lists the same key twice really does have it twice
    # in its own list (which is what the "fires N entries" warning is reading), but it can still
    # only fire once, and counting its content twice would report a book as over budget when it
    # cannot be.
    key_map = defaultdict(list)
    firing_by_key: dict[str, list[dict]] = defaultdict(list)
    for e, m in zip(entries, meta):
        seen: set[str] = set()
        for k in e["key"]:
            norm = str(k).lower().strip()
            key_map[norm].append(m["label"])
            if norm not in seen:
                seen.add(norm)
                firing_by_key[norm].append(e)
    for k, owners in sorted(key_map.items()):
        if len(owners) >= 4:
            warnings.append(f"key '{k}' fires {len(owners)} entries at once: "
                            + ", ".join(owners[:4]) + ("..." if len(owners) > 4 else ""))
        if k in cfg["noisy_keys"]:
            warnings.append(f"key '{k}' is high-frequency — it will fire on nearly every message "
                            f"({', '.join(owners)}). Consider a distinctive phrase or make the "
                            "entry constant.")

    for e, m in zip(entries, meta):
        n = len(str(e["content"]))
        if n > m["limit"]:
            warnings.append(f"{m['label']}: {n} chars exceeds {m['limit_source']} ceiling "
                            f"of {m['limit']}")

    const_chars = sum(len(str(e["content"])) for e in entries if e["constant"])
    const_tokens = const_chars / cpt
    if const_tokens > cfg["constant_token_budget"]:
        msg = (f"constant footprint ~{const_tokens:.0f} tokens exceeds budget of "
               f"{cfg['constant_token_budget']}")
        (errors if strict else warnings).append(msg)

    # 🔴 WORST-CASE CONCURRENCY — the real prize (§6.5). Entries sharing an inclusion group only
    # fire one at a time, so a group counts as its LARGEST member rather than the sum of its
    # members; summing them would report a book as over budget when it never can be.
    worst_key, worst_tokens = "", 0.0
    for k, firing in firing_by_key.items():
        grouped, ungrouped = defaultdict(list), []
        for e in firing:
            (grouped[e["group"]] if e["group"] else ungrouped).append(e)
        chars = sum(len(str(e["content"])) for e in ungrouped)
        for members in grouped.values():
            chars += max(len(str(e["content"])) for e in members)
        total = (const_chars + chars) / cpt
        if total > worst_tokens:
            worst_key, worst_tokens = k, total

    if worst_key and worst_tokens > cfg["wi_budget_tokens"]:
        errors.append(f"worst-case concurrency ~{worst_tokens:.0f} tokens on key '{worst_key}' "
                      f"exceeds WI budget of {cfg['wi_budget_tokens']}")
    elif worst_key and worst_tokens > cfg["wi_budget_tokens"] * 0.6:
        warnings.append(f"worst-case concurrency ~{worst_tokens:.0f} tokens on key '{worst_key}' "
                        f"is over 60% of the {cfg['wi_budget_tokens']} token WI budget")

    return errors, warnings, worst_key, worst_tokens


def is_section_chunk(doc: Any) -> bool:
    """Does this parsed document look like a section chunk (§4.2)?

    `entries` is a LIST here and a DICT in a compiled book — that one difference is the whole
    test, and it is why a chunk cannot be mistaken for the thing it compiles into.
    """
    return (isinstance(doc, dict) and isinstance(doc.get("entries"), list)
            and ("section" in doc or "section_name" in doc or "entry_limit" in doc))


#: Chunk fields the build ITERATES. Not a list is `TypeError: 'int' object is not iterable`,
#: raised from inside `validate()` where nothing catches it.
_ENTRY_LISTS = ("keys", "key")

#: Chunk fields the build uses as a DICTIONARY KEY or a `Counter` member. A list or a dict here
#: is `TypeError: unhashable type`, from `grouped[e["group"]]`, `m["class"] not in VALID_CLASSES`
#: and `Counter(ids)` respectively.
#:
#: ⚠️ **The test is hashability, not `isinstance(str)`.**
#: A chunk that writes `"id": 1` or `"group": 3` builds correctly today — `label` is f-stringed
#: and `Counter` is happy — so demanding a string here would refuse a file that has always
#: worked, in the name of fixing crashes. Only the shapes that actually detonate are refused.
_ENTRY_HASHABLE = ("id", "comment", "class", "group")


def _check_entry(raw: dict, fname: str, uid: int) -> None:
    """Refuse a chunk entry whose fields are a shape the build cannot survive — 4.4's family.

    🔴 **FIVE MORE 500s IN THE SAME FAMILY AS THE SEVEN CONFIG ONES**, found while fixing those:
    the review counted the shapes in `build-config.json` and these are the same failure one file
    over, in the section chunks themselves. Every one of them answered 500 with no message, from
    an upload that is a legal multipart POST of valid JSON.
    """
    where = raw.get("id") or raw.get("comment") or f"uid {uid}"
    where = where if isinstance(where, str) else f"uid {uid}"
    for field in _ENTRY_LISTS:
        if field in raw and not isinstance(raw[field], list):
            raise AssemblyFailed([f"{where} [{fname}]: `{field}` must be a list of keywords, "
                                  f"not a {type(raw[field]).__name__}"])
    for field in _ENTRY_HASHABLE:
        if isinstance(raw.get(field), (list, dict, set)):
            raise AssemblyFailed([f"{where} [{fname}]: `{field}` must be a single value, "
                                  f"not a {type(raw[field]).__name__}"])


def assemble(files: list[tuple[str, Any]], *, config: Any = None,
             strict: bool = False) -> tuple[dict, Report]:
    """Section chunks in, a compiled worldbook and a report out.

    `files` is `[(filename, parsed_document)]` in any order — 🔴 **THIS FUNCTION SORTS THEM.**
    The `A_`/`B_`/…/`X_` prefixes determine uid assignment, a browser's multi-file upload arrives
    in whatever order it likes, and a shuffled uid set produces a gratuitous diff against
    SillyTavern on every rebuild.

    A `build-config.json` among the files is picked out and used; passing `config` explicitly
    overrides it. Raises `AssemblyFailed` when validation produces errors — the book is NOT
    written on an error, exactly as the CLI aborts.

    🔴 **MALFORMED UPLOADS USE `AssemblyFailed`.**
    The route returns its `.errors` to the caller. Unexpected programming and I/O exceptions
    remain visible rather than being disguised as validation failures.
    """
    try:
        return _assemble(files, config=config, strict=strict)
    except AssemblyFailed:
        # Ours, already carrying `.errors` and a message the pane can render. Re-raised FIRST
        # because it is a `ValueError` and would otherwise be re-wrapped by the clause below into
        # a generic message, losing the specific one it was raised with.
        raise
    except (TypeError, AttributeError, ValueError, KeyError, IndexError,
            ZeroDivisionError, OverflowError) as exc:
        # 🔴 A NAMED TUPLE, NEVER `except Exception`. A blind catch is how a decrypt failure
        # becomes "the file is empty" three layers up — the finding `VaultAuthError`'s
        # `BaseException` base exists to stop — and `tests/test_m5_boundaries.py` counts blind
        # handlers precisely so the next one has to be argued for. This module does no I/O, so
        # nothing it can raise is a vault error; the list is exactly what a wrongly-shaped
        # document produces.
        #
        # ⚠️ THIS IS A NET, NOT A SUBSTITUTE FOR THE CHECKS ABOVE. Anything that lands here is a
        # shape nobody enumerated, and the honest message says so — a specific one belongs in
        # `_check_config` or `_check_entry` the moment it is identified.
        raise AssemblyFailed([f"the uploaded files could not be assembled "
                              f"({type(exc).__name__}) — one of them is not the shape a "
                              f"worldbook section chunk has"]) from exc


def _assemble(files: list[tuple[str, Any]], *, config: Any = None,
              strict: bool = False) -> tuple[dict, Report]:
    """`assemble()` with its exception guarantee removed. Call that one."""
    cfg_doc = config
    chunks: list[tuple[str, Any]] = []
    for name, doc in files:
        base = str(name).replace("\\", "/").rsplit("/", 1)[-1]
        # 🔴 THE SAME PASS THE OTHER THREE IMPORT DOORS RUN (`formats/validate.py`). This one is
        # a door in its own right: the compiled book goes straight to `DocumentStore.create`, so
        # a lone surrogate in one section chunk is the identical 4.6 failure — a 500, a directory
        # made, a `.part` left behind — arriving by a route that never touches `doc_kind`.
        try:
            _validate.check_document(doc, what=base or "an uploaded file")
        except _validate.InvalidDocument as exc:
            raise AssemblyFailed([str(exc)]) from exc
        if base == CONFIG_NAME:
            if cfg_doc is None:
                cfg_doc = doc
            continue
        chunks.append((base, doc))

    cfg = merge_config(cfg_doc)
    chunks.sort(key=lambda pair: pair[0])       # 🔴 filename order — see the docstring

    entries: list[dict] = []
    meta: list[dict] = []
    warnings: list[str] = []
    sections: list[dict] = []
    uid = 0

    for fname, sec in chunks:
        if not is_section_chunk(sec):
            raise AssemblyFailed([f"{fname}: not a worldbook section chunk "
                                  "(no `entries` list)"])
        sec_limit = sec.get("entry_limit")
        if sec_limit is not None and not _number(sec_limit):
            # It becomes `m["limit"]` and is compared against a character count; a string one is
            # `TypeError: '>' not supported between instances of 'int' and 'str'`, from a file
            # whose only sin is quoting a number.
            raise AssemblyFailed([f"{fname}: `entry_limit` must be a number, not a "
                                  f"{type(sec_limit).__name__}"])
        n_before = len(entries)
        for raw in sec["entries"]:
            if not isinstance(raw, dict):
                raise AssemblyFailed([f"{fname}: an entry is not an object"])
            _check_entry(raw, fname, uid)
            entry = expand(raw, uid, fname, warnings)
            cls = classify(raw, entry)
            if sec_limit:
                limit, limit_source = sec_limit, "section entry_limit"
            else:
                limit = cfg["limits"].get(cls, cfg["limits"]["standard"])
                limit_source = cls
            ident = raw.get("id") or entry["comment"]
            meta.append({"ident": ident, "label": ident or f"uid {uid} [{fname}]",
                         "class": cls, "limit": limit, "limit_source": limit_source,
                         "file": fname})
            entries.append(entry)
            uid += 1
        sections.append({"file": fname, "section": sec.get("section", ""),
                         "name": sec.get("section_name", ""),
                         "entries": len(entries) - n_before})

    errors, more, worst_key, worst_tokens = validate(entries, meta, cfg, strict)
    warnings.extend(more)

    report = Report(entries=len(entries), sections=sections, errors=errors, warnings=warnings,
                    constant_tokens=sum(len(str(e["content"])) for e in entries
                                        if e["constant"]) / cfg["chars_per_token"],
                    constant_budget=cfg["constant_token_budget"], worst_key=worst_key,
                    worst_tokens=worst_tokens, wi_budget=cfg["wi_budget_tokens"],
                    world_name=str(cfg.get("world_name") or ""))
    if errors:
        raise AssemblyFailed(errors)

    # The compiled shape: `entries` keyed by uid AS A STRING. 🔴 JS reorders integer-like string
    # keys ascending on every parse (contract §8.1), so this dict's order is not ours to control
    # and must not be relied on — the uid inside each entry is the authority.
    book = {"entries": {str(e["uid"]): e for e in entries}}
    return book, report


#: 7.0-m4z / §9a.19 — the text a brand-new entry is born with.
#:
#: 🔴 **IT CANNOT BE BLANK, AND THAT IS NOT A COSMETIC CHOICE.** `formats.worldbook.jobs()` skips
#: any entry whose `content` does not `strip()` to something — deliberately, so a 110-row report is
#: not padded with entries that were always empty. An entry created with `""` would therefore be
#: written to disk correctly, mint a revision correctly, and then be **invisible in the editor**:
#: created, unreachable, and impossible to fill in from the UI that just made it.
NEW_ENTRY_TEXT = "(new entry — replace this text)"


#: SillyTavern's own default `order` for an entry created in their editor
#: (`public/scripts/world-info.js:4219`, and `DEFAULT_WEIGHT` at `:98`).
ST_DEFAULT_ORDER = 100


def order_for_new_entry(entries: Any) -> int:
    """The `order` a new entry should be born with: **the one its neighbors already use.**

    🔴 **`DEFAULTS["order"]` is 20 and is not suitable here.** That value is the
    assembler's chunk default: a book compiled from
    chunks gives every entry the same order, so they are uniform and nothing outranks anything.
    m4z then reused `new_entry()` for ✚ Add entry on **imported** books — where every existing
    entry carries SillyTavern's 100 — and the new entry silently landed at a fifth of everyone
    else's priority.

    That is not cosmetic. `sortFn` is `(a, b) => b.order - a.order` (`world-info.js:89`), the scan
    walks entries in that descending order, and when the World Info token budget fills, everything
    remaining is dropped (`:5212`). A new entry with too-low priority can therefore disappear
    silently when the budget is reached.

    A new entry should use the order already common in the book.

    ⚠️ **THE MODE, NOT THE MAX.** A new entry should read as an ordinary member of this book, not
    outrank a constant its author deliberately put on top. 📌 Ties break HIGH, because the two
    failure directions are not symmetric: too high is visible in the prompt and the user can lower it,
    too low vanishes at budget and looks like the entry never fired.
    """
    orders: list[int] = []
    for e in (entries.values() if isinstance(entries, dict) else (entries or [])):
        if not isinstance(e, dict):
            continue
        v = e.get("order")
        # `isinstance(v, bool)` is excluded on purpose — `True` is an `int` in Python and a
        # hand-edited book carrying `"order": true` would otherwise vote for an order of 1.
        if isinstance(v, int) and not isinstance(v, bool):
            orders.append(v)
    if not orders:
        return ST_DEFAULT_ORDER
    counts = Counter(orders)
    top = max(counts.values())
    return max(o for o, n in counts.items() if n == top)


def new_entry(uid: int, *, comment: str = "", content: str = NEW_ENTRY_TEXT,
              order: int | None = None) -> dict:
    """A complete SillyTavern entry, ready to be dropped into a compiled book's `entries`.

    🔴 **EVERY KEY IN `DEFAULTS`, NOT THE FIVE WE HAPPEN TO USE.** SillyTavern's own editor writes
    the full set, and an entry missing `probability` or `selectiveLogic` is one that reads back with
    `undefined` where their UI expects a number — the same class of bug §10's round-trip rule
    exists to prevent. `DEFAULTS` is already the canonical set for `expand()`, so it is the set here.

    `order` overrides `DEFAULTS["order"]`; pass `order_for_new_entry(book["entries"])`. ⚠️ `None`
    keeps the assembler's 20 so `expand()`'s contract is untouched — the caller adding to a real
    book is the one that must decide, because it is the only one holding the book.

    🔴 **BORN AT DEPTH, NEVER AT THE TOP OF THE PROMPT** — `NEW_ENTRY_POSITION`. `DEFAULTS`
    says position 0, which is inside the character definitions: the entry then flickers at the very
    front of the prompt and invalidates the KV cache for everything below it on every turn it
    changes. Placing a new entry at depth avoids invalidating the cached prompt prefix when it
    changes.

    ⚠️ **THIS REACHES ⬆ IMPORT ENTRY, AND ONLY WHERE THE FILE IS SILENT.** `adopt_entry` copies the
    incoming `position` over the top whenever the file HAS one, so §10's round-trip rule is
    untouched; what moves is the entry that named no position at all — which is what SillyTavern's
    own schema now fills with `atDepth` (`world-info.js:4220`).

    ⚠️ `displayIndex` is set by the caller, which is the only place that knows how many entries the
    book already has.
    """
    e = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULTS.items()}
    e["uid"] = int(uid)
    e["comment"] = str(comment)
    e["content"] = str(content)
    e["position"] = NEW_ENTRY_POSITION
    e["depth"] = NEW_ENTRY_DEPTH
    if order is not None:
        e["order"] = int(order)
    return e


def next_uid(entries: Any) -> int:
    """The first uid no entry in this book is using: **max + 1, never `len(entries)`.**

    🔴 **THE COUNT COLLIDES AND THE COLLISION IS SILENT.** Deleting an entry in SillyTavern leaves
    a gap, so a count-based id lands on a live entry — the new text overwrites an existing entry inside
    the document the feature exists to grow, with nothing anywhere saying so.

    ⚠️ **THE CONTAINER KEY IS A FALLBACK FOR THE `uid` FIELD, NOT THE OTHER WAY ROUND.** A book
    hand-edited into `{"3": {"content": …}}` with no `uid` inside still occupies 3, and reading only
    the field would hand 0 back for the whole book. Both are consulted, in that order.

    📌 Lifted out of `POST /wbedit/documents/<id>/entry` when ⬆ Import entry became its second
    caller (7.3.20). It was already the one piece of that route that corrupts data when it is
    wrong, and this codebase's own note applies: *a fix that lives in one call site is a fix that
    the next call site does not get.*
    """
    uids: list[int] = []
    pairs = entries.items() if isinstance(entries, dict) else enumerate(entries or [])
    for key, entry in pairs:
        uid = entry.get("uid") if isinstance(entry, dict) else None
        for cand in (uid, key):
            try:
                uids.append(int(cand))
                break
            except (TypeError, ValueError):
                continue
    return (max(uids) + 1) if uids else 0


def adopt_entry(raw: Any, uid: int, *, order: int, display_index: int) -> dict:
    """An entry from OUTSIDE this book, made safe to drop into its `entries` under `uid`.

    🔴 **The file's own `uid` is never honored.** An
    entry written by a model carries whatever uid it was thinking of — 18 is the example — and
    dropping it in at 18 either collides with a live entry or leaves the container key and the
    `uid` field disagreeing, which is `iter_entries`/`set_at` addressing two different rows. So
    `uid` and the container key are the BOOK's answer (`next_uid`), and the incoming one is
    reported rather than used.

    ⚠️ **EVERY OTHER KEY SURVIVES VERBATIM**, including ones this codebase has never heard of
    (`outletName`, `triggers`, `matchCreatorNotes`) even when they are absent from `DEFAULTS`.
    §10's round-trip rule: what SillyTavern wrote, SillyTavern gets back. `new_entry` underneath
    supplies the full `DEFAULTS` set, so an entry that omits `probability` or `selectiveLogic`
    still reaches their editor complete rather than as `undefined`.

    The four that are normalized, and why each one is not paranoia:

      * `key` — a section chunk spells it `keys`, and a hand-written one may be a bare string.
        Left alone, an entry with only `keys` is keyless to SillyTavern: stored, shown, never
        fired (`fires_by_keyword`).
      * `order` — kept when it is a real `int`, otherwise the book's common mode.
        `"order": "68"` is not a number to `sortFn`.
      * `content` — blank or non-string becomes `NEW_ENTRY_TEXT`, because `worldbook.jobs()` skips
        an entry whose content does not strip, and the entry would import "successfully" and then
        be invisible in the editor.
      * `comment` — the row title in the editor and in their UI; an entry with none would render
        as a blank line in the list.
    """
    src = raw if isinstance(raw, dict) else {}
    comment = src.get("comment")
    content = src.get("content")
    e = new_entry(
        uid,
        comment=comment.strip() if isinstance(comment, str) and comment.strip() else f"entry {uid}",
        content=content if isinstance(content, str) and content.strip() else NEW_ENTRY_TEXT,
    )
    for k, v in src.items():
        if k not in ("uid", "displayIndex", "keys", "comment", "content"):
            e[k] = v
    keys = src.get("key")
    if keys is None:
        keys = src.get("keys")
    if isinstance(keys, str):
        keys = [keys]
    e["key"] = [str(k) for k in keys if str(k).strip()] if isinstance(keys, list) else []
    got = src.get("order")
    e["order"] = got if isinstance(got, int) and not isinstance(got, bool) else int(order)
    e["uid"] = int(uid)
    e["displayIndex"] = int(display_index)
    return e


# ── applying a three-way merge (9.6) ─────────────────────────────────────────────────────────
#
# 🔴 **IT LIVES HERE BECAUSE `next_uid` AND `adopt_entry` DO.** An entry arriving from an imported
# file needs a uid this book is not already using, its `key`/`keys` spelling normalized, and the
# full `DEFAULTS` set filled in — all three of which are already solved above, each with a comment
# recording the bug that made it necessary. A second copy of that logic inside `formats/merge.py`
# would be a second copy of `next_uid`'s "max + 1, never len()" rule, and the copy that drifts is
# the one nobody is testing that week.
#
# ⚠️ **AND `formats/merge.py` CANNOT IMPORT THIS FILE**: this one imports `formats.depthfix` and
# `formats.validate`, so the edge has to run downward. The merge module stays pure arithmetic with
# no knowledge of how a book is built; this is where the answer becomes a document.

#: A review-pane choice that overrides the merge's automatic resolution.
PICK_MINE = "mine"
PICK_THEIRS = "theirs"
#: The third conflict choice lets a user combine the current and incoming values before applying
#: the merge.
PICK_EDITED = "edited"
KEEP_ENTRY = "keep"
DROP_ENTRY = "drop"


def _merge_pick(field: Any, pick: Any, edited: Any = None) -> Any:
    """The value to write for one field: the user's choice if supplied, else the merge result.

    ⚠️ **`edited` IS CONSULTED ONLY WHEN THE PICK SAYS SO**, never as "a text was supplied, use it".
    The two maps arrive from a browser as separate form fields; a stale `field_edits` entry left
    behind by a radio the user switched away from would otherwise silently win over the selected button
    actually see.
    """
    if pick == PICK_EDITED:
        return edited
    if pick == PICK_THEIRS:
        return field.theirs
    if pick == PICK_MINE:
        return field.mine
    return field.resolved


def _merge_assign(node: dict, path: list, value: Any) -> None:
    """Write `value` at `path`, making intermediate dicts on the way.

    ⚠️ Unlike `core.locator.set_at`, this one CREATES what is missing. The locator walk addresses
    a field that is known to exist in the document it came from; a merge writes fields that exist
    only on the incoming side, so `data.creator_notes` can have no `data` to land in yet.
    """
    for k in path[:-1]:
        nxt = node.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            node[k] = nxt
        node = nxt
    node[path[-1]] = value


def _merge_drop(node: dict, path: list) -> None:
    """Remove whatever is at `path`. A path that does not resolve is already absent."""
    for k in path[:-1]:
        node = node.get(k)
        if not isinstance(node, dict):
            return
    node.pop(path[-1], None)


def apply_merge(mine: Any, result: Any, *, field_choices: Any = None,
                entry_choices: Any = None, field_edits: Any = None) -> dict:
    """Build the merged document from `mine` and a `formats.merge.MergeResult`.

    🔴 **THE OUTPUT IS BUILT FROM `mine`, NEVER FROM `theirs`, AND THAT IS §10's ROUND-TRIP RULE
    RATHER THAN A PREFERENCE.** Every key this codebase has never heard of — `outletName`,
    `triggers`, `matchCreatorNotes`, whatever SillyTavern adds next — survives an import today
    because nothing rebuilds an entry from a known field list. A merge that assembled its output
    from the merge result alone would silently drop exactly those keys, since the result only
    describes fields at least one side declared. So: deep-copy the current document, then write the
    resolved values over the top.

    ⚠️ **ENTRY ORDER IS `mine`'S.** Existing entries keep their positions and container keys;
    entries the file adds go on the end. Reordering the current book to match the file would make
    the revision comparison harder to review.

    `field_choices` addresses one field as `"<i>:<dotted path>"`, where `<i>` is the entry's index
    in `result.entries` and `"doc"` addresses the document-level fields — `{"3:content": "theirs"}`.
    `entry_choices` addresses a whole entry as `"<i>"`, with `"keep"` or `"drop"`. `field_edits`
    uses the same addresses as `field_choices` and supplies the text for a field whose pick is
    `"edited"`. All three are OVERRIDES: anything not named takes the verdict the merge computed,
    so an empty dict is the safe default rather than an empty document.

    ⚠️ **THE INDEX IS ONLY STABLE AGAINST THE SAME THREE INPUTS**, which is what makes the caller's
    `require_head=True` load-bearing rather than belt-and-braces: a head that moved under the pane
    invalidates every key in these dicts, and the revision guard is what stops that from landing.
    """
    picks = dict(field_choices or {})
    entry_picks = dict(entry_choices or {})
    edits = dict(field_edits or {})
    absent = _merge_mod._Absent
    out = copy.deepcopy(mine) if isinstance(mine, dict) else {}

    for f in result.doc_fields:
        value = _merge_pick(f, picks.get(f"doc:{f.name}"), edits.get(f"doc:{f.name}"))
        if isinstance(value, absent):
            _merge_drop(out, list(f.path))
        else:
            _merge_assign(out, list(f.path), value)

    # 🔴 **THE ENTRIES ARE WHEREVER THE RESULT SAYS THEY ARE.** A worldbook holds them at
    # `entries`; a character card holds a whole lorebook at `data.character_book`. `container` is
    # the path INCLUDING the final `entries`, so the node holding them is one step up — and for a
    # card with no embedded book that node does not exist, which is not an error and must not
    # become one by having this method invent it.
    container = [str(p) for p in (getattr(result, "container", None) or ["entries"])]
    holder = out
    for key in container[:-1]:
        nxt = holder.get(key)
        if not isinstance(nxt, dict):
            # 🔴 **CREATED ONLY WHEN THERE IS SOMETHING TO PUT IN IT.** A card update that ADDS an
            # embedded lorebook is a merge whose entries are all additions and whose container does
            # not exist in the current document; creating it only when additions exist avoids
            # raising on a card that is gaining its first embedded lorebook.
            #
            # ⚠️ **AND NEVER OTHERWISE.** Giving a card that never had a `character_book` an empty
            # one would modify a document even though the merge has no entries to add.
            if not result.entries:
                return out
            nxt = {}
            holder[key] = nxt
        holder = nxt

    source = holder
    # 🔴 THE SHAPE COMES FROM THE RESULT, NOT FROM THE DOCUMENT — see `MergeResult.compiled`.
    # `is_compiled(source)` was the first version and it cannot answer for a container this merge
    # is creating: there is nothing there yet to be a dict or a list.
    compiled = bool(getattr(result, "compiled", True))
    by_mine_key = {item.mine_key: (i, item) for i, item in enumerate(result.entries)
                   if item.mine_key is not None}

    try:
        here = list(_worldbook.iter_entries(source)) if isinstance(source, dict) else []
    except ValueError:
        here = []                   # no container yet — this merge is the thing creating it

    kept: list[tuple[Any, dict]] = []
    for key, entry in here:
        found = by_mine_key.get(key)
        if found is None:
            # Not in the result at all. Cannot happen for a result built from this document, and
            # KEEPING it is the only safe answer if it ever does: dropping an entry because the
            # bookkeeping lost track of it is the one outcome with no undo.
            kept.append((key, copy.deepcopy(entry)))
            continue
        i, item = found
        pick = entry_picks.get(str(i))
        # 🔴 **OMISSION IS NOT DELETION.** An update file is often a partial export, and a local
        # entry can also have arrived through an earlier merge. Treating every entry absent from
        # `theirs` as deleted made the next merge erase exactly the additions this feature is
        # meant to protect. Keep the current entry unless the user explicitly chooses `drop` in
        # the review UI; a merge must never make absence in the incoming file destructive.
        drop = pick == DROP_ENTRY if pick is not None else False
        if drop:
            continue
        merged = copy.deepcopy(entry)
        for f in item.fields:
            value = _merge_pick(f, picks.get(f"{i}:{f.name}"), edits.get(f"{i}:{f.name}"))
            if isinstance(value, absent):
                _merge_drop(merged, list(f.path))
            else:
                _merge_assign(merged, list(f.path), value)
        kept.append((key, merged))

    # An entry the file has and the current document lacks. `ADDED` lands by default; an entry
    # removed from the current document but still present in the file lands only when the user
    # explicitly chooses keep, because the default is to preserve the deletion.
    incoming = []
    for i, item in enumerate(result.entries):
        if item.mine_key is not None or isinstance(item.entry, absent):
            continue
        pick = entry_picks.get(str(i))
        wanted = (item.status == _merge_mod.ADDED) if pick is None else (pick == KEEP_ENTRY)
        if wanted:
            incoming.append(item.entry)

    if compiled:
        entries: Any = {str(key): entry for key, entry in kept}
    else:
        entries = [entry for _key, entry in kept]
    # §9a.22 — computed ONCE, from the book as it stood, so a file of thirty entries cannot drag
    # the mode it is being measured against.
    order = order_for_new_entry(entries)
    for raw in incoming:
        # 🔴 INSIDE THE LOOP, against the GROWING container — `next_uid`'s own rule. Hoisting it
        # would hand one uid to every incoming entry and collapse them into one key.
        uid = next_uid(entries)
        entry = adopt_entry(raw, uid, order=order, display_index=len(entries))
        if compiled:
            entries[str(uid)] = entry
        else:
            entries.append(entry)

    holder[container[-1]] = entries
    return out
