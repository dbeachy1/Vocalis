"""Typed editor metadata for SillyTavern worldbook-entry settings.

This table declares the supported setting surface, including labels, types, defaults, bounds, and
options. Settings are edited by hand through typed controls; they are not LLM `Job` fields and
never enter a model pass. `content` remains the prose field handled by the ordinary job list.

`st_write._worldbook_plan` sends the complete book through `saveWorldInfo`, so validated setting
edits use the existing write path. The conformance test compares this table with the configured
SillyTavern field definitions and detects new fields that have not been reviewed.
"""
from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from typing import Any

#: Group headings in editor display order. Identity and timing appear before less frequently used
#: settings.
GROUPS = ("identity", "timing", "injection", "budget", "matching",
          "recursion", "grouping", "sources", "misc")

GROUP_LABELS = {
    "identity": "Identity",
    "timing": "Timing",
    "injection": "Injection",
    "budget": "Budget",
    "matching": "Matching",
    "recursion": "Recursion",
    "grouping": "Inclusion group",
    "sources": "Additional matching sources",
    "misc": "Misc",
}

#: 🔴 THE TYPES, AND THE ONE THAT WILL BITE.
#:
#: `int?` and `bool?` are **TRI-STATE**, and conflating `None` with `0`/`False` is a data-loss bug
#: rather than a cosmetic one. `sticky: null` means *not set — inherit the global*; `sticky: 0`
#: means *explicitly none*. A widget that renders `null` as an empty number box and writes back `0`
#: rewrites every entry it touches across a whole book. Same shape as the `entry_mode` `is True` rule
#: (§9a.4): the falsy values are distinct and only an identity test keeps them so.
#:
#: `boolint` is the fork's own union and not an invention here — see `delayUntilRecursion`.
TYPES = ("string", "text", "bool", "bool?", "int", "int?", "enum", "enum?", "array", "boolint")

#: `caseSensitive`, `matchWholeWords` and `useGroupScoring` are rendered exactly as SillyTavern
#: renders them: a three-way select, because a checkbox cannot say "use global".
TRISTATE_BOOL_OPTIONS: tuple[tuple[Any, str], ...] = (
    (None, "Use global"), (True, "Yes"), (False, "No"))

#: `world_info_logic` — `world-info.js:34`. The option ORDER is SillyTavern's own (index.html:6944),
#: which is not the numeric order; keeping theirs means the list reads the same in both products.
LOGIC_OPTIONS: tuple[tuple[Any, str], ...] = (
    (0, "AND ANY"), (3, "AND ALL"), (1, "NOT ALL"), (2, "NOT ANY"))

#: `world_info_position` — `world-info.js:856`. 📌 **`position` PICKS THE BLOCK; `order` NEVER MOVES
#: AN ENTRY BETWEEN BLOCKS.** Their editor folds `role` into this one select (three "at Depth"
#: rows), because `role` only means anything at position 4. Here they stay two controls: the data
#: model has two keys, and a compound widget that writes two keys from one click is the kind of
#: thing that silently sets `role` on an entry that is not at depth.
POSITION_OPTIONS: tuple[tuple[Any, str], ...] = (
    (0, "Before character defs"), (1, "After character defs"),
    (5, "Before example messages"), (6, "After example messages"),
    (2, "Before author's note"), (3, "After author's note"),
    (4, "At depth"), (7, "Outlet"))

#: `extension_prompt_roles` — `script.js:505`. Only consulted when `position` is 4 (at depth).
ROLE_OPTIONS: tuple[tuple[Any, str], ...] = (
    (None, "Use default"), (0, "System"), (1, "User"), (2, "Assistant"))

#: `GENERATION_TYPE_TRIGGERS` — the six generation types an entry can be filtered to.
TRIGGER_VALUES = ("normal", "continue", "impersonate", "swipe", "regenerate", "quiet")


@dataclass(frozen=True)
class FieldSpec:
    """One editable setting on an entry.

    `label` and `tip` retain SillyTavern's own wording wherever available, so each control maps to
    the corresponding field in that editor.
    """

    name: str
    type: str
    label: str
    group: str
    tip: str = ""
    options: tuple[tuple[Any, str], ...] = ()
    min: int | None = None
    max: int | None = None
    placeholder: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "type": self.type, "label": self.label, "group": self.group,
                "tip": self.tip, "placeholder": self.placeholder,
                "min": self.min, "max": self.max,
                "options": [{"value": v, "label": lab} for v, lab in self.options]}


def _f(name: str, type_: str, label: str, group: str, **kw: Any) -> FieldSpec:
    return FieldSpec(name=name, type=type_, label=label, group=group, **kw)


#: 🔴 EVERY EDITABLE SETTING ON AN ENTRY, TYPED. `content` is NOT here — it is the prose field, it
#: is already the `<textarea>` every pass runs over, and giving it a second control in the settings
#: fold would mean two widgets writing one locator with no rule about which wins.
ENTRY_FIELDS: tuple[FieldSpec, ...] = (
    # ── identity ────────────────────────────────────────────────────────────
    _f("comment", "string", "Title / memo", "identity",
       tip="The entry's name. It is what the row is labeled with here and in SillyTavern.",
       placeholder="Entry title/memo"),
    _f("key", "array", "Primary keywords", "identity",
       tip="Comma separated. Keywords or regexes that activate this entry. "
           "A non-constant entry with no keywords can never fire.",
       placeholder="keyword, another keyword"),
    _f("keysecondary", "array", "Optional filter", "identity",
       tip="Secondary keywords, combined with the primary ones by Logic. Ignored if empty.",
       placeholder="ignored if empty"),

    # ── timing — nullable values must preserve the unset state ──────────────
    _f("sticky", "int?", "Sticky", "timing",
       tip="Sticky entries stay active for N messages after being triggered. "
           "Blank means not set; 0 means explicitly non-sticky.",
       min=0, max=999999, placeholder="Non-sticky"),
    _f("cooldown", "int?", "Cooldown", "timing",
       tip="Entries with a cooldown can't be activated for N messages after being triggered. "
           "Blank means not set; 0 means explicitly no cooldown.",
       min=0, max=999999, placeholder="No cooldown"),
    _f("delay", "int?", "Delay", "timing",
       tip="Entries with a delay can't be activated until there are N messages in the chat. "
           "Blank means not set; 0 means explicitly no delay.",
       min=0, max=999999, placeholder="No delay"),
    _f("delayUntilRecursion", "boolint", "Delay until recursion", "timing",
       tip="This entry can only be activated on recursive checking. Tick it for level 1, or give "
           "a level: only the smallest level matches first, and the next becomes eligible once "
           "nothing matches.",
       min=1, max=999999, placeholder="1"),

    # ── injection ───────────────────────────────────────────────────────────
    _f("constant", "bool", "Constant (🔵 always injected)", "injection",
       tip="Injected into every message regardless of keywords, and it costs its tokens every "
           "time."),
    _f("vectorized", "bool", "Vectorized (🔗)", "injection",
       tip="Activated by vector similarity rather than by keyword matching."),
    _f("disable", "bool", "Disabled (⛔)", "injection",
       tip="A disabled entry is injected by nothing, ever — the activation loop skips it before "
           "anything else is consulted. It is present, it has keywords, and it does nothing."),
    _f("position", "enum", "Position", "injection",
       tip="Which block of the prompt this entry lands in. Order never moves an entry between "
           "blocks.", options=POSITION_OPTIONS),
    _f("depth", "int", "Depth", "injection",
       tip="How many messages back the entry is inserted. Only used at position 'At depth'.",
       min=0, max=9999),
    _f("order", "int", "Order", "injection",
       tip="🔴 HIGHER WINS — entries are sorted descending and, when the World Info budget fills, "
           "everything remaining is DROPPED. A low order is how an entry silently stops "
           "appearing.", min=0, max=9999),
    _f("role", "enum?", "Role (at depth)", "injection",
       tip="Whose message the entry is injected as. Only consulted at position 'At depth'.",
       options=ROLE_OPTIONS),
    _f("outletName", "string", "Outlet name", "injection",
       tip="Entries at position 'Outlet' are not added automatically; they are collected and "
           "used via {{outlet::Name}} in the prompt.", placeholder="Outlet name"),

    # ── budget ──────────────────────────────────────────────────────────────
    _f("ignoreBudget", "bool", "Ignore budget", "budget",
       tip="Included regardless of budget constraints, assuming all other checks pass. A constant "
           "entry without this can be displaced by a firing sticky entry."),
    _f("useProbability", "bool", "Use probability", "budget",
       tip="Whether the trigger percentage below is applied at all."),
    _f("probability", "int", "Trigger %", "budget",
       tip="A percentage chance that a matched entry actually activates.", min=0, max=100),

    # ── matching ────────────────────────────────────────────────────────────
    _f("selective", "bool", "Selective", "matching",
       tip="Apply the optional filter (secondary keywords) using the logic below."),
    _f("selectiveLogic", "enum", "Logic", "matching",
       tip="How the primary and secondary keywords combine.", options=LOGIC_OPTIONS),
    _f("scanDepth", "int?", "Scan depth", "matching",
       tip="How many messages back to scan for this entry's keywords. Blank uses the global "
           "setting.", min=0, max=1000, placeholder="Use global setting"),
    _f("caseSensitive", "bool?", "Case-sensitive", "matching",
       tip="Blank uses the global setting.", options=TRISTATE_BOOL_OPTIONS),
    _f("matchWholeWords", "bool?", "Whole words", "matching",
       tip="Blank uses the global setting.", options=TRISTATE_BOOL_OPTIONS),

    # ── recursion ───────────────────────────────────────────────────────────
    _f("excludeRecursion", "bool", "Non-recursable", "recursion",
       tip="This entry will not be recursively activated by other entries."),
    _f("preventRecursion", "bool", "Prevent further recursion", "recursion",
       tip="This entry will not activate other entries recursively."),

    # ── inclusion group ─────────────────────────────────────────────────────
    _f("group", "string", "Inclusion group", "grouping",
       tip="Only one entry from a group is activated at a time when several are triggered. "
           "Supports several comma-separated groups.",
       placeholder="only one entry with the same label will be activated"),
    _f("groupOverride", "bool", "Prioritize", "grouping",
       tip="This entry is prioritized out of all selections in its group. If several are "
           "prioritized, the highest Order wins."),
    _f("groupWeight", "int", "Group weight", "grouping",
       tip="A relative likelihood of activation within the group.", min=1, max=999999,
       placeholder="100"),
    _f("useGroupScoring", "bool?", "Group scoring", "grouping",
       tip="Blank uses the global setting.", options=TRISTATE_BOOL_OPTIONS),

    # ── additional matching sources ─────────────────────────────────────────
    _f("matchCharacterDescription", "bool", "Character description", "sources"),
    _f("matchCharacterPersonality", "bool", "Character personality", "sources"),
    _f("matchScenario", "bool", "Scenario", "sources"),
    _f("matchPersonaDescription", "bool", "Persona description", "sources"),
    _f("matchCharacterDepthPrompt", "bool", "Character's note", "sources"),
    _f("matchCreatorNotes", "bool", "Creator's notes", "sources"),

    # ── misc ────────────────────────────────────────────────────────────────
    _f("triggers", "array", "Generation triggers", "misc",
       tip="Restrict this entry to certain generation types. Empty means all of them. "
           f"One or more of: {', '.join(TRIGGER_VALUES)}.",
       placeholder="empty = all"),
    _f("addMemo", "bool", "Add memo", "misc",
       tip="Include the title/memo as a comment when the entry is injected."),
    _f("automationId", "string", "Automation ID", "misc",
       tip="Can be used to automatically activate Quick Replies.", placeholder="( none )"),
)

BY_NAME: dict[str, FieldSpec] = {f.name: f for f in ENTRY_FIELDS}

#: 🔴 **DECLARED, NOT FORGOTTEN — AND THAT DISTINCTION IS THE ANTI-ROT RULE'S WHOLE MECHANISM.**
#: The conformance test fails on a fork field that appears in NEITHER table, so a name landing here
#: is an explicit decision rather than an unreviewed gap.
NOT_EDITABLE: dict[str, str] = {
    "content": "the prose field — it is the textarea every pass runs over, edited above",
    "characterFilter": "a nested {names, tags, isExclude} object over a character list, which "
                       "this editor does not hold; SillyTavern's own picker is the right place",
    "characterFilterNames": "part of `characterFilter` — see above",
    "characterFilterTags": "part of `characterFilter` — see above",
    "characterFilterExclude": "part of `characterFilter` — see above",
    "uid": "the entry's identity. `set_at` would happily renumber an entry out from under every "
           "locator pointing at it",
    "displayIndex": "SillyTavern's own row ordering, rewritten by their editor on every drag",
}


class BadValue(ValueError):
    """A typed edit whose value does not match its field's declared type."""


def _is_int(v: Any) -> bool:
    # 🔴 `isinstance(True, int)` IS `True` IN PYTHON, and a book carrying `"order": true` would
    # otherwise be accepted and then sort as 1. Every integer check in this module excludes bool.
    return isinstance(v, int) and not isinstance(v, bool)


def coerce(name: str, value: Any) -> Any:
    """Validate `value` against `name`'s declared type and return what should be written.

    🔴 **This is the guard between the browser and the stored book.** A `sticky` of `"12"` — a
    string, which is what an untyped `<input>` hands you — is accepted by SillyTavern's number
    parse today and by nothing tomorrow, and `set_at` writes whatever it is given. Nothing
    downstream re-checks, so a value that gets past here is in the revision, in the send, and in
    the file SillyTavern loads.

    Raises `BadValue` with a message naming the field; the web layer returns it as a 400.
    """
    spec = BY_NAME.get(name)
    if spec is None:
        raise BadValue(f"{name} is not an editable entry field")
    t = spec.type

    if t in ("string", "text"):
        if not isinstance(value, str):
            raise BadValue(f"{name} must be text")
        return value

    if t == "bool":
        if not isinstance(value, bool):
            raise BadValue(f"{name} must be true or false")
        return value

    if t == "bool?":
        if value is not None and not isinstance(value, bool):
            raise BadValue(f"{name} must be true, false, or null for 'use global'")
        return value

    if t in ("int", "int?"):
        if value is None:
            if t == "int":
                raise BadValue(f"{name} must be a number")
            return None
        if not _is_int(value):
            raise BadValue(f"{name} must be a whole number")
        if spec.min is not None and value < spec.min:
            raise BadValue(f"{name} must be at least {spec.min}")
        if spec.max is not None and value > spec.max:
            raise BadValue(f"{name} must be at most {spec.max}")
        return value

    if t in ("enum", "enum?"):
        allowed = [v for v, _ in spec.options]
        if value is None and t == "enum?":
            return None
        # An enum's values are ints; `True` must not pass as `1`.
        if isinstance(value, bool) or value not in allowed:
            names = ", ".join(str(v) for v in allowed)
            raise BadValue(f"{name} must be one of: {names}")
        return value

    if t == "array":
        if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
            raise BadValue(f"{name} must be a list of strings")
        if name == "triggers":
            bad = [x for x in value if x not in TRIGGER_VALUES]
            if bad:
                raise BadValue(f"{name}: unknown trigger(s) {', '.join(bad)} — expected "
                               f"{', '.join(TRIGGER_VALUES)}")
        return list(value)

    if t == "boolint":
        # The fork's own union (`world-info.js:3875-3893`): `false` is off, `true` is level 1, and
        # a number is that level. All three shapes are written by their editor and read by their
        # activation loop, so all three must survive a round-trip through ours.
        if isinstance(value, bool):
            return value
        if _is_int(value):
            if spec.min is not None and value < spec.min:
                raise BadValue(f"{name} level must be at least {spec.min}")
            if spec.max is not None and value > spec.max:
                raise BadValue(f"{name} level must be at most {spec.max}")
            return value
        raise BadValue(f"{name} must be true, false, or a recursion level")

    raise BadValue(f"{name} has an unknown field type {t!r}")   # pragma: no cover — TYPES guard


def spec_payload() -> list[dict[str, Any]]:
    """The whole table, wire-shaped, in draw order.

    Values do NOT travel with it. The browser already holds the revision it is editing, so sending
    each entry's 37 settings alongside would put the same bytes on the wire twice — and the second
    copy is the one that goes stale the moment anything is written.
    """
    return [f.to_dict() for f in ENTRY_FIELDS]


def group_payload() -> list[dict[str, str]]:
    return [{"key": g, "label": GROUP_LABELS[g]} for g in GROUPS]
