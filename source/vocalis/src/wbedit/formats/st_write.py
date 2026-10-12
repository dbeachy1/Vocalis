"""Build explicit write plans for the SillyTavern browser extension.

The extension performs writes from the authenticated page, while this module owns payload
selection. Worldbooks use `saveWorldInfo`, existing cards use `merge-attributes`, new cards use
`import`, and personas update their descriptor fields. Each plan contains only supported edits and
reports deliberately omitted data.

────────────────────────────────────────────────────────────────────────────────────────────────
🔴 THE THREE WRITE PATHS, AND WHY EACH IS THE ONLY ONE
────────────────────────────────────────────────────────────────────────────────────────────────

**A worldbook goes through `context.saveWorldInfo(name, book, true)`.** It is the fork's own
front-end path, it invalidates their cache, and `immediately=true` returns the server's verdict
instead of a debounce's optimism. The compiled shape (`entries` a **dict** keyed by uid-as-string)
is what a ST world file is; a section CHUNK file (`entries` a **list**) is a Vocalis pre-compile
format that SillyTavern has never heard of, so it is refused here rather than written as a book
that loads empty.

**A card goes through `/api/characters/merge-attributes`, and NOTHING ELSE.**
- `/api/characters/edit` runs `charaFormatData` **on the way in** (their `characters.js:1291`),
  whose `if (data.world)` block stamps the linked World Book over whatever the request carried.
  Anything we send is silently replaced. It also needs the full form, so a partial edit blanks
  every field we did not know to send.
- `/api/characters/create` writes a **gray placeholder face**. It is not an update path.
- `merge-attributes` runs no `charaFormatData` — it deep-merges into the raw PNG chunk and writes
  (`mergeCharacterUpdate`, `:1473`). It is the only endpoint that lets us change five fields and
  leave the other forty alone.

**…AND A CARD SILLYTAVERN HAS NEVER SEEN GOES THROUGH `/api/characters/import` INSTEAD.**
`merge-attributes` addresses an avatar FILENAME, so a card with no `st_ref` — imported here as
JSON, or authored here — had nothing to address and was refused outright. Their `/import` is the
endpoint behind their own drag-and-drop: multipart `avatar` + `file_type`, `importFromJson` at
`characters.js:1042` for a V2 card, and it answers `{file_name}` which is the avatar filename
minus `.png`. **That answer is recorded as `st_ref`** (`DocumentStore.adopt_st_ref`), so later
sends use the ordinary merge path.
🔴 It writes `DEFAULT_AVATAR_PATH` — the placeholder face — so a card with an image is followed by
`/edit-avatar`, which re-embeds the current card data into the new image.

**A persona is two entries in `power_user`**, mutated in memory and committed with
`saveSettingsDebounced()` — exactly what the fork's own persona editor does. There is no persona
file and no `/api/personas`. ⚠️ We touch ONLY the keys we own: a descriptor also carries
`connections`, `position`, `depth`, `role` and `lorebook`, none of which Vocalis edits and all of
which a wholesale replacement would destroy.

────────────────────────────────────────────────────────────────────────────────────────────────
🔴 WHAT IS DELIBERATELY NOT WRITTEN, WHICH IS THE PART TO READ TWICE
────────────────────────────────────────────────────────────────────────────────────────────────

**A MIRRORED `character_book` IS NEVER SENT.** A card whose `data.extensions.world` is non-empty
carries a copy of a standalone World Book. Sending that stale copy through `merge-attributes` could
overwrite newer data; the standalone book is managed as its own Library document.
🔴 The test is `data.extensions.world`, NEVER `character_book.name`, which is wrong in both
directions — see the long note in `formats/card.py`.

**THE WORLD LINK IS OMITTED UNLESS IT WAS EDITED HERE.** `data.extensions.world` refers to a
SillyTavern book name, which may differ from the Library's local display name. An imported link is
left untouched; an explicit local edit is resolved to the linked book's SillyTavern key before it
is included in the payload.

`plan(world=...)` receives `DocumentStore.world_out(doc)`: `None` means the imported link was not
edited, while a string is the resolved SillyTavern reference chosen by the user. An empty string
explicitly clears the link, matching SillyTavern's representation of no primary book.

**ONLY EDITABLE FIELDS ARE SENT.** The allow-list is `card.CARD_KIND`, matching fields exposed by
`collect()`. This avoids overwriting SillyTavern values from a stale imported snapshot.

────────────────────────────────────────────────────────────────────────────────────────────────
📌 ARRAYS ARE REPLACED, NOT MERGED
────────────────────────────────────────────────────────────────────────────────────────────────

In this fork's `deepMerge` (`src/util.js:536`), `isObject` at `:532` is
`item && typeof item === 'object' && !Array.isArray(item)`, so an array value falls to the `else`
branch and is assigned **wholesale**. `alternate_greetings`, `tags` and `character_book.entries`
all replace cleanly in one request.

🔴 **Arrays replace wholesale in this fork's `deepMerge`.** No preliminary unset request is needed,
so the payload cannot leave an embedded lorebook cleared if a follow-up write fails.
"""
from __future__ import annotations

from typing import Any

from . import card as card_fmt
from . import persona as persona_fmt
from . import png_card

#: Card fields a send may write, derived from the editor's `card.CARD_KIND` allow-list.
CARD_WRITE_FIELDS = tuple(card_fmt.CARD_KIND)

#: The persona descriptor keys a send may write — exactly what `persona.jobs` offers.
PERSONA_WRITE_FIELDS = tuple(persona_fmt.PERSONA_FIELDS_DEFAULT)

#: 🔴 The card fields that ALSO exist as flat V1 aliases, and must be written at both levels.
#: This is `readFromV2`'s own `fieldMappings` (`characters.js:659`) intersected with what we are
#: allowed to write. It is not "the ones that look scalar": `creator_notes`, `system_prompt`,
#: `post_history_instructions` and `alternate_greetings` have no V1 alias at all, and inventing
#: top-level keys for them puts junk in the PNG chunk that nothing reads.
V1_ALIASED = tuple(f for f in CARD_WRITE_FIELDS if f in {
    "description", "personality", "scenario", "first_mes", "mes_example"})

#: Taproom's round-avatar focus rectangle field, imported to keep the payload key consistent.
FOCUS_FIELD = png_card.FOCUS_FIELD

#: Their `characters.js:1440`. The ONLY way `merge-attributes` can express a DELETION: `deepMerge`
#: has no vocabulary for "remove this key", so a value of this string is swapped for an `_.unset`
#: by `processUnsetSentinels` after the merge.
#:
#: 🔴 **USED FOR EXACTLY ONE THING — clearing a stale focus rect** (see `_card_plan`). It is not
#: the array-replacement workaround the fork's reply prescribed; arrays already replace wholesale
#: (§4.2a.1), and the two-request unset-then-set dance that would need is a data-loss hazard.
#: Here it rides in the same single request as everything else, so it cannot half-happen.
UNSET_SENTINEL = "__@@UNSET@@__"


class Unsendable(Exception):
    """This document cannot be written into SillyTavern; the message describes the shape issue.

    ⚠️ The message is OURS — a fact about the document's shape or our own record of it. It never
    quotes content, and there is no path here that could: nothing in this module reads a field's
    text.
    """


def plan(doc: Any, content: Any, *, st_ref: str = "", name: str = "",
         avatar: bool = False, has_avatar: bool = False, world: str | None = None) -> dict:
    """The write instruction for one document revision.

    `st_ref` is SillyTavern's own key — a book's NAME or an avatar FILENAME — and `name` is the
    Library row's name, used only as the target name for a book that has never been in SillyTavern
    (an assembled one, §6.5). Both are passed in rather than read off `doc` so this stays a pure
    function over plain values and the tests do not need a store.

    `world` is `DocumentStore.world_out(doc)`. `None` means the imported link was not edited and
    is omitted from the payload. A string is an explicit selection; `""` clears the link.
    Passed in rather than read off `content` for `st_ref`'s reason: the store resolves it, this
    stays a pure function, and `""` has to be distinguishable from "absent", which a dict lookup
    on the content could not do.

    Returns `{"kind", "target", "dropped": [...], ...}` plus one payload key per kind. `dropped`
    is a list of PLAIN ENGLISH phrases the UI shows verbatim — the honest half of a send that did
    not carry everything.
    """
    kind = getattr(doc, "kind", "") or (doc.get("kind", "") if isinstance(doc, dict) else "")
    if kind == "worldbook":
        return _worldbook_plan(content, st_ref=st_ref, name=name)
    if kind == "card":
        return _card_plan(content, st_ref=st_ref, avatar=avatar, name=name,
                          has_avatar=has_avatar, world_out=world)
    if kind == "persona":
        return _persona_plan(content, st_ref=st_ref, name=name, avatar=avatar,
                             has_avatar=has_avatar)
    raise Unsendable(f"a {kind or 'document'} cannot be sent to SillyTavern")


def _worldbook_plan(content: Any, *, st_ref: str, name: str) -> dict:
    """`saveWorldInfo(target, book, true)`.

    🔴 **A SECTION CHUNK FILE IS REFUSED.** Its `entries` is a list and its key field is `keys`;
    SillyTavern's loader wants a dict keyed by uid with a `key` field, and handed the list shape
    it produces a world that saves cleanly and fires nothing. §6.5 exists precisely so chunks are
    assembled into a compiled book first, and this is the message that says so.
    """
    if not isinstance(content, dict) or not isinstance(content.get("entries"), dict):
        raise Unsendable(
            "this is a section chunk file, not a compiled World Book — assemble it first, "
            "then send the assembled book")

    # `saveWorldInfo` replaces the target book. Refuse an empty payload rather than silently
    # deleting all entries. The caller can show this refusal before starting the write.
    if not content["entries"]:
        raise Unsendable(
            "this World Book has no entries — sending it would REPLACE the book in SillyTavern "
            "with an empty one. Add an entry first, or delete the book over there yourself if "
            "that is what you meant")

    # The name it already has over there, or — for a book assembled here that SillyTavern has
    # never seen — the Library row's name. `saveWorldInfo` creates one under a name it does not
    # know, so this is a real path and not a fallback that fails later.
    target = (st_ref or name or "").strip()
    if not target:
        raise Unsendable("this book has no name to save under")
    return {"kind": "worldbook", "target": target, "book": content, "dropped": []}


def _card_plan(content: Any, *, st_ref: str, avatar: bool = False, name: str = "",
               has_avatar: bool = False, world_out: str | None = None) -> dict:
    """Build the `merge-attributes` body: `{avatar, <V1 aliases>, data: {...}}`.

    V2 text is written under `data` and mirrored to V1 aliases only for fields SillyTavern maps
    between formats. Keeping both copies equal avoids its sensitive mismatch warning. V2-only
    fields remain nested, and `avatar` is included because the endpoint merges the full request
    body into the card.
    """
    if not isinstance(content, dict):
        raise Unsendable("this card is not a JSON object")
    target = (st_ref or "").strip()
    if not target:
        # No stored SillyTavern reference means this is a new card. Import the complete document;
        # merge-only safeguards for stale linked data apply only to existing cards. `has_avatar`
        # says whether to upload a supplied image after import, unlike `avatar`, which tracks a
        # changed image on an existing card.
        return {"kind": "card", "create": True, "target": "", "dropped": [],
                "name": str(name or "").strip(), "card": content, "avatar": bool(has_avatar)}
    if not target.lower().endswith(".png"):
        # Their `merge-attributes` joins this straight onto the characters directory. A ref that
        # is not a PNG filename is our own record being wrong, and it is better to say so than to
        # let their path handling decide what it meant.
        raise Unsendable("this card's SillyTavern reference is not a PNG filename")

    nested = content.get("data") if isinstance(content.get("data"), dict) else None
    d = nested if nested is not None else content

    flat: dict[str, Any] = {}
    for f in CARD_WRITE_FIELDS:
        if f in d:
            flat[f] = d[f]

    dropped: list[str] = []
    ext = d.get("extensions")
    world = str(ext.get("world") or "").strip() if isinstance(ext, dict) else ""

    # The focus rectangle is the one display field allowed out of `extensions`. Other extension
    # values are omitted because their world link belongs to SillyTavern's namespace and a stored
    # copy may be stale. Taproom consumes this display field when building the thumbnail URL, so an explicit focus edit must
    # be sent with the card.
    #
    # A cleared rect uses the endpoint's unset sentinel. Build one extensions mapping so the focus
    # setting and an explicitly edited world link can be sent together.
    extras: dict[str, Any] = {}
    if isinstance(ext, dict):
        if FOCUS_FIELD in ext:
            extras[FOCUS_FIELD] = ext[FOCUS_FIELD]
        elif avatar:
            # A new picture with no rect uses the centered square. The sentinel removes a prior
            # rectangle that describes the replaced image.
            extras[FOCUS_FIELD] = UNSET_SENTINEL
    # The store resolves an explicit local world-link edit to the linked book's SillyTavern key.
    #
    # ⚠️ `""` IS THE PAYLOAD, NOT THE SENTINEL. SillyTavern spells "no primary lorebook" as an
    # empty `extensions.world` — it is what their own editor writes — so `deepMerge` assigning
    # `""` says exactly the right thing. `UNSET_SENTINEL` would delete the key, which their card
    # format does not require and which no path on their side produces.
    if world_out is not None:
        extras["world"] = world_out
    if extras:
        flat["extensions"] = extras
    book = d.get("character_book")
    if isinstance(book, dict) and isinstance(book.get("entries"), list):
        # The content may have a blank link after an explicit unlink. Keep the mirrored-book
        # omission in that case; unlinking the card does not modify the standalone book.
        if world:
            # 🔴 The mirror. Landing it via merge-attributes is the DELAYED loss described at the
            # top of this file — worse than a visible refusal, because it reports success.
            dropped.append(f"the lorebook mirrored from the World Book “{world}” — "
                           "edit that book in the Library instead")
        elif world_out == "":
            # After unlinking there is no associated book to name in this explanation.
            dropped.append("the lorebook still mirrored into this card from the World Book you "
                           "unlinked — that book is still in the Library, unchanged")
        else:
            flat["character_book"] = book

    if not flat:
        raise Unsendable("this revision has none of the fields a send can write")

    if nested is None:
        # 🔴 A V1 CARD GETS NO `data` KEY. It has no `spec`, so `getCharaCardV2` sends it through
        # `convertToV2` — which builds `data` from the flat fields and would overwrite anything we
        # put there anyway. Writing a half-populated `data` onto a V1 card leaves a block that is
        # authoritative-looking, unread, and one `spec` field away from shadowing the real values.
        merge = {"avatar": target, **flat}
    else:
        # `data` carries everything; the top level carries only what `readFromV2` maps back down.
        aliases = {f: v for f, v in flat.items() if f in V1_ALIASED}
        merge = {"avatar": target, **aliases, "data": flat}
    # Fetch `/edit-avatar` only when `Document.avatar_dirty` says the image changed. Re-uploading
    # unchanged images would repeatedly re-encode them in Jimp.
    return {"kind": "card", "target": target, "dropped": dropped, "merge": merge,
            "avatar": bool(avatar)}


def _persona_plan(content: Any, *, st_ref: str, name: str = "", avatar: bool = False,
                  has_avatar: bool = False) -> dict:
    """Update only the persona descriptor's editable prose fields.

    The display name is not sent. `title: None` instructs the extension to remove an empty title,
    matching SillyTavern's descriptor format.
    """
    if not isinstance(content, dict):
        raise Unsendable("this persona is not a JSON object")
    # Use only the store's SillyTavern reference as identity. A document's `avatar` field is file
    # content and cannot safely select an existing persona to overwrite.
    # `st_ref` is recorded only after SillyTavern confirms a filename. Documents without a
    # reference therefore take the create path below instead of inferring identity from content.
    target = (st_ref or "").strip()
    if not target:
        # Let SillyTavern choose and check the new avatar filename. The extension returns it so
        # the store can link subsequent updates without guessing at an existing persona identity.
        #
        # A create uses an empty title to omit it from the new descriptor. `has_avatar` controls
        # initial image upload; `avatar` instead tracks a changed image on an existing persona.
        return {"kind": "persona", "create": True, "target": "", "dropped": [],
                "name": str(name or content.get("name") or "").strip(),
                "persona": {f: (content.get(f) if isinstance(content.get(f), str) else "")
                            for f in PERSONA_WRITE_FIELDS},
                "avatar": bool(has_avatar)}

    fields: dict[str, Any] = {}
    for f in PERSONA_WRITE_FIELDS:
        v = content.get(f)
        if isinstance(v, str) and v.strip():
            fields[f] = v
        elif f == "title":
            fields[f] = None            # delete, per the note above
    if not any(isinstance(v, str) for v in fields.values()):
        raise Unsendable("this revision has none of the fields a send can write")
    # On an existing persona, upload the image only when it differs from the stored reference.
    return {"kind": "persona", "target": target, "dropped": [], "persona": fields,
            "avatar": bool(avatar)}
