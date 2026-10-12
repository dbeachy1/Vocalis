"""Plan and verify moving unstable World Book entries to an at-depth position.

Prompt caches reuse tokens only up to the first differing token. Entries near the start of a
prompt can therefore invalidate the later context whenever activation changes. This helper
identifies entries that may vary, counts candidates without exposing their content, and offers
additional opt-ins for example-message and unstable constant entries.

The default selection is conservative. Constant entries can still vary because of probability,
cooldown, delay, trigger, character-filter, or inclusion-group rules, so those candidates require
an explicit opt-in. The transformation changes only `position`, `depth`, and a missing `role`;
`verify` checks all other document and entry data remains unchanged.
"""
from __future__ import annotations

import copy
from typing import Any

from . import worldbook as _wb

#: `world_info_position` (`world-info.js:856`). `depth` is used only when `position == 4`.
POS_BEFORE_CHAR = 0
POS_AFTER_CHAR = 1
POS_AN_TOP = 2
POS_AN_BOTTOM = 3
POS_AT_DEPTH = 4
POS_EM_TOP = 5
POS_EM_BOTTOM = 6
POS_OUTLET = 7

#: Positions inside the character definitions, near the start of the prompt. These are the
#: default candidates.
TOP_POSITIONS = (POS_BEFORE_CHAR, POS_AFTER_CHAR)

#: ALSO ABOVE THE WHOLE CHAT HISTORY, AND THE HANDOFF LEFT THEM OUT. Example messages are
#: assembled after the character definitions and before the history, so a flickering entry at
#: EMTop/EMBottom does the same damage as one at Before Char Defs. They are NOT in the default
#: rule - an entry parked there was placed there on purpose more often than one at position 0 -
#: but they are counted and offered, because silently skipping them would ship a fix that reports
#: success over a book it did not fix.
EXAMPLE_POSITIONS = (POS_EM_TOP, POS_EM_BOTTOM)

#: `world-info.js:4234` - `depth: { default: DEFAULT_DEPTH }`, and `DEFAULT_DEPTH` is 4 (`:97`).
DEFAULT_DEPTH = 4
#: `entryfields.ENTRY_FIELDS`' own bounds for `depth`, so the route cannot accept what the
#: per-entry editor would refuse one screen away.
MIN_DEPTH, MAX_DEPTH = 0, 9999

#: THE WHOLE WRITE SURFACE. `verify` asserts nothing outside this tuple changed, per entry, which
#: is what makes "it only moved them" a checked claim rather than a promise in a docstring.
WRITTEN_FIELDS = ("position", "depth", "role")


class DepthFixFailed(RuntimeError):
    """The rewritten book failed its own check, so it is thrown away rather than saved.

    Never raised by bad input - that is a 400 long before here. This means the transform did
    something the transform is not allowed to do, and the only safe response is to keep the
    revision that already existed.
    """


def _int(value: Any) -> int | None:
    """`value` as an int, or `None` - with `bool` excluded, which `isinstance(x, int)` is not.

    `isinstance(True, int)` is `True` in Python. A `position: true` in a hand-written book would
    read as position 1 (After Char Defs) and be silently rewritten. It reads as *unknown* instead,
    and an entry whose position we cannot name is one we leave alone.
    """
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def entry_position(entry: Any) -> int | None:
    """This entry's `position` as an int, or `None` when it is absent or not a number.

    `None` is NOT "position 0". The configured SillyTavern schema default is `atDepth`
    (`world-info.js:4220`), but books exported by other tools may carry neither value. Guessing
    would move entries on the strength of a default they did not declare, so an absent position is
    left exactly where it is.
    """
    return _int(entry.get("position")) if isinstance(entry, dict) else None


def _filters_by_character(entry: dict) -> bool:
    """Does this entry carry a non-empty character filter? `world-info.js:5009-5036`.

    Stored as one object, `{names: [...], tags: [...], isExclude: bool}` — never as the three
    flat `characterFilter*` fields, which are `excludeFromTemplate` and exist only for the
    editor's own widgets (`world-info.js:4247-4249`, `:1304-1320`). Reading the flat spelling
    here would find nothing in a book SillyTavern actually wrote.
    """
    f = entry.get("characterFilter")
    if not isinstance(f, dict):
        return False
    return any(isinstance(f.get(k), list) and f.get(k) for k in ("names", "tags"))


def flicker_reason(entry: Any) -> str | None:
    """Why this ALWAYS-INJECTED entry is not byte-stable turn to turn - or `None` if it is.

    Only meaningful for `constant` entries; a normal/vectorized one flickers by definition and
    never reaches here. Each branch corresponds to the configured fork's activation loop, cited
    in the module docstring. The returned text describes the condition in editor terms.

    🔴 The conditions cover every branch before `if (entry.constant)` in the configured
    activation loop. In addition to probability, delay, and cooldown, the set includes `triggers`,
    `characterFilter`, and `delayUntilRecursion` because each can suppress a constant entry.
    """
    if not isinstance(entry, dict):
        return None
    # Disabled first, exactly as the fork checks it first (`:4994`): a disabled entry is injected
    # by nothing, ever, so it contributes zero bytes on every single turn. That is *perfectly*
    # stable, and calling it a flicker would offer to move entries whose position is inert.
    if entry.get("disable") is True:
        return None
    # `useProbability` defaults to TRUE in the schema (`:4233`), so an absent one is not "off".
    uses = entry.get("useProbability")
    rolls = uses is None or bool(uses)
    probability = _int(entry.get("probability"))
    # ⚠️ ZERO IS THE `disable` CASE WEARING ANOTHER FIELD'S NAME, so it is answered before the
    # `< 100` branch. `verifyProbability` is `Math.random() * 100 <= entry.probability`
    # (`:5238-5242`), which at 0 is false on every roll `Math.random()` can produce bar one exact
    # zero - so the entry contributes nothing, every turn, and its position is as inert as a
    # disabled one's. Offering to move it would be the same lie by a different door.
    if rolls and probability is not None and probability <= 0:
        return None
    if rolls and probability is not None and probability < 100:
        return "triggers " + str(probability) + "% of the time"
    for field, phrase in (("cooldown", "has a cooldown"), ("delay", "has a delay"),
                          # `:5053-5061` - held back until the recursive scan, so on a turn with
                          # no recursion it is absent and on one with recursion it is present.
                          ("delayUntilRecursion", "waits for a recursive scan")):
        value = _int(entry.get(field))
        if value is not None and value > 0:
            return phrase
    # `:5000-5006` - a generation-type filter. An entry restricted to "normal" is gone from every
    # swipe, continue, impersonation and quiet prompt, which is most of what a long chat does.
    triggers = entry.get("triggers")
    if isinstance(triggers, list) and triggers:
        return "only fires on some generation types"
    # `:5009-5036` - and in a GROUP chat this rotates every single turn, because `getCharaFilename`
    # reads the speaking character and `group-chats.js` sets that per speaker.
    if _filters_by_character(entry):
        return "is filtered to certain characters"
    group = entry.get("group")
    if isinstance(group, str) and group.strip():
        return "is in an inclusion group"
    return None


def is_constant(entry: Any) -> bool:
    """`constant is True`, by identity - the `entry_mode` rule (9a.4) one module over.

    Deliberately NOT `entry.get("constant")`: `constant: 1` and `constant: "false"` are not what
    SillyTavern writes, and reading either as always-injected would leave a flickering entry at
    the top of the block while the count said it had been dealt with.
    """
    return isinstance(entry, dict) and entry.get("constant") is True


def plan(doc: Any, *, depth: int = DEFAULT_DEPTH, examples: bool = False,
         unstable: bool = False) -> dict:
    """What `apply_plan` would do to `doc`, as counts and container keys - nothing is written.

    COUNTS ONLY, NEVER CONTENT. Nothing in the returned dict carries an entry's text, its keywords
    or its title. The preview reports counts only, such as "47 entries, 31 will move".

    `examples` and `unstable` widen the rule, and both are `False` by default so the plain press
    of the button does exactly what the diagnosis specified and nothing more. The counts for what
    they WOULD add are always returned (`offer_examples`, `offer_unstable`) so the dialog can
    offer a tick that does not exist when it would do nothing.
    """
    entries = list(_wb.iter_entries(doc))
    move: list[Any] = []
    offer_examples = 0
    offer_unstable = 0
    reasons: dict[str, int] = {}
    by_position: dict[str, int] = {}
    left_stable = 0
    left_placed = 0
    left_at_depth = 0

    for ckey, entry in entries:
        position = entry_position(entry)
        by_position[str(position)] = by_position.get(str(position), 0) + 1

        if position == POS_AT_DEPTH:
            left_at_depth += 1
            continue
        in_top = position in TOP_POSITIONS
        in_examples = position in EXAMPLE_POSITIONS
        if not (in_top or in_examples):
            # 2, 3, 7, or a position we cannot name. The author's note is itself injected at a
            # depth, so its two positions are already near the end; Outlet entries are not
            # auto-injected at all. Both were placed deliberately, neither is this button's
            # business.
            left_placed += 1
            continue

        if is_constant(entry):
            reason = flicker_reason(entry)
            if reason is None:
                left_stable += 1                      # always injected and steady - leave it
                continue
            # Flickering constant. Counted whichever way the tick goes, so the dialog can say how
            # how many there are before the user decides.
            if in_examples and not examples:
                offer_examples += 1
                continue
            if not unstable:
                offer_unstable += 1
                reasons[reason] = reasons.get(reason, 0) + 1
                continue
            reasons[reason] = reasons.get(reason, 0) + 1
            move.append(ckey)
            continue

        # Normal, vectorized or disabled - every one of them conditional on something.
        if in_examples and not examples:
            offer_examples += 1
            continue
        move.append(ckey)

    return {
        "total": len(entries),
        "move": move,
        "moving": len(move),
        "leaving": len(entries) - len(move),
        "left_stable": left_stable,
        "left_at_depth": left_at_depth,
        "left_placed": left_placed,
        "offer_examples": offer_examples,
        "offer_unstable": offer_unstable,
        "reasons": reasons,
        "by_position": by_position,
        "depth": depth,
        "examples": bool(examples),
        "unstable": bool(unstable),
    }


def apply_plan(doc: dict, keys: list, depth: int) -> dict:
    """A NEW document with `keys` moved to `atDepth`/`depth`. `doc` is not mutated.

    `role` IS SET ONLY WHERE IT WAS MISSING, AND ONLY BECAUSE POSITION 4 IS THE ONE PLACE IT MEANS
    ANYTHING. `role` is consulted exclusively at `atDepth` (`script.js:505` /
    `entryfields.ROLE_OPTIONS`), so an entry arriving from position 0 has very often never had a
    meaningful one. `0` is the schema's own default (`world-info.js:4222`), so this writes what
    SillyTavern would have written - and an entry that already names a role keeps it.

    IT IS A `deepcopy`, AND THE SHALLOW VERSION MADE `verify` A DECORATION. Copying only the moved
    entries leaves every UNMOVED one as the same object in both documents - so `before` and
    `after` are literally the same dict there, `_without_writes(b) != _without_writes(a)` can
    never be true, and the one check that exists to catch "it touched something it may not touch"
    is blind on 5 of every 6 entries. A mutation test caught it: `after['entries']['1']['uid']=99`
    was reported as no change at all, because it had edited `before` too. Independent documents
    are what make the guard able to fail; the copy of a 110-entry book costs nothing next to that.
    """
    out = copy.deepcopy(doc)
    entries = out["entries"]
    for ckey in keys:
        entry = entries[ckey]
        entry["position"] = POS_AT_DEPTH
        entry["depth"] = depth
        if _int(entry.get("role")) is None:
            entry["role"] = 0
    return out


def _without_writes(entry: dict) -> dict:
    return {k: v for k, v in entry.items() if k not in WRITTEN_FIELDS}


def verify(before: dict, after: dict, keys: list, depth: int) -> None:
    """Refuse the rewrite unless it did exactly what it claims. Raises `DepthFixFailed`.

    THE CHECK IS "EVERYTHING ELSE IS BYTE-IDENTICAL", NOT "THE MOVED ONES LOOK RIGHT". A transform
    that also dropped a keyword list would pass every positive assertion anybody thinks to write;
    it cannot pass this one. Comparing the entries with `WRITTEN_FIELDS` removed catches a changed
    value AND a vanished key in the same expression, which is why it is a dict compare rather than
    a field-by-field walk that can only see the fields somebody remembered.

    🔴 **A GUARD THAT REFUSES A GOOD TRANSFORM IS AS BROKEN AS ONE THAT PASSES A BAD ONE**, and
    the first build did both. It read `entries` as "every value is an entry" while `iter_entries`
    — the function `plan` is built on — deliberately skips a value that is not a dict. A book with
    a stray `null` in there imports cleanly, previews cleanly, and then answered 500 *"the
    rewritten book failed its own check"* over a rewrite that was perfect: the junk was already
    there and the transform never touched it. Non-entries are held to the only rule that means
    anything for them — they must come out exactly as they went in.

    🔴 **AND `role` WAS THE ONE WRITTEN FIELD WHOSE VALUE NOTHING CHECKED.** `position` and
    `depth` are pinned to exact values on a moved entry; `role` was checked only for *being an
    int*, so a regression that flattened every moved entry's role to System passed. `apply_plan`'s
    rule is exact and so is this: an entry that named a role keeps that role, and one that did not
    gets the schema's own `0`.
    """
    if {k: v for k, v in before.items() if k != "entries"} != \
            {k: v for k, v in after.items() if k != "entries"}:
        raise DepthFixFailed("the document changed outside its entries")
    b, a = before.get("entries"), after.get("entries")
    if not isinstance(b, dict) or not isinstance(a, dict):
        raise DepthFixFailed("the entries are no longer a World Book's entries")
    if set(b) != set(a):
        raise DepthFixFailed(
            "the entry list changed: " + str(len(b)) + " entries in, " + str(len(a)) + " out")
    moved = set(map(str, keys))
    for ckey, entry_before in b.items():
        entry_after = a[ckey]
        if not isinstance(entry_before, dict):
            # Not an entry going in, so `iter_entries` never yielded it and `plan` never saw it.
            # The claim being checked is not "it is well formed" — it was not — but "the transform
            # left it alone", and that is a real assertion: a rewrite that helpfully replaced the
            # junk with an entry would fail here.
            if entry_before != entry_after:
                raise DepthFixFailed(
                    "entry " + str(ckey) + " was not an entry and was changed anyway")
            continue
        if not isinstance(entry_after, dict):
            raise DepthFixFailed("entry " + str(ckey) + " is no longer an entry")
        if entry_before.get("uid") != entry_after.get("uid"):
            raise DepthFixFailed("entry " + str(ckey) + " changed uid")
        if _without_writes(entry_before) != _without_writes(entry_after):
            raise DepthFixFailed(
                "entry " + str(ckey) + " changed a field this may not touch")
        if str(ckey) in moved:
            # 🔴 `_int`, NOT `!=`, ON BOTH OF THESE. `4.0 != 4` is False in Python, so a transform
            # that wrote a float where SillyTavern's schema says `number`-as-int would slide past
            # a bare compare — and a float `position` is one `entry.position === 4` away from an
            # entry that renders as At depth and is injected as Before Char Defs.
            if _int(entry_after.get("position")) != POS_AT_DEPTH:
                raise DepthFixFailed("entry " + str(ckey) + " was not moved to depth")
            if _int(entry_after.get("depth")) != depth:
                raise DepthFixFailed(
                    "entry " + str(ckey) + " did not take depth " + str(depth))
            want_role = _int(entry_before.get("role"))
            if want_role is None:
                if _int(entry_after.get("role")) != 0:
                    raise DepthFixFailed(
                        "entry " + str(ckey) + " did not take the default injection role")
            elif _int(entry_after.get("role")) != want_role:
                raise DepthFixFailed(
                    "entry " + str(ckey) + " had its injection role rewritten")
        else:
            for field in WRITTEN_FIELDS:
                if (field in entry_before) != (field in entry_after) or \
                        entry_before.get(field) != entry_after.get(field):
                    raise DepthFixFailed(
                        "entry " + str(ckey) + " was not in the plan but its "
                        + field + " changed")
