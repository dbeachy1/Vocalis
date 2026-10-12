"""Persona document model and SillyTavern descriptor mapping.

🔴 **THERE IS NO PERSONA FILE IN SILLYTAVERN, SO WE DEFINE THE DOCUMENT.** Over there a persona is
two maps in `power_user` inside `data/<user>/settings.json`, keyed by avatar filename:
`power_user.personas` holds the display name and `power_user.persona_descriptions` holds the
descriptor. There is no `/api/personas`, no per-persona file, and nothing embedded in the PNG.
The extension flattens those two maps into the shape below before pushing it (§8.2a — one press
in Vocalis brings every persona, no control in SillyTavern's UI).

🔴 **`avatar` IS THE IDENTITY AND IT IS STABLE UNDER RENAME.** `renamePersona` writes only
`power_user.personas[avatarId]`, so the filename survives a display-name change — the same
property §8.2 leans on for worldbooks, and the reason the `st_ref` for a persona is its avatar
filename rather than its name.

⚠️ Persona descriptions are user-authored content and route into the vault under the same storage
and privacy rules as other document text.

⚠️ **`title` and `focus` are deleted, not blanked, when empty** (`personas.js:862`, `:559`).
Descriptors may contain only `description` and `position`, so fields are optional and absent differs
from `""`.
"""
from __future__ import annotations

import json
import re
from typing import Any

from ..core.job import Job

#: The marker that makes a persona detectable without being declared (§4.2 — type is detected,
#: never taken from the caller). Ours, not SillyTavern's: they have no file format to borrow.
SPEC = "vocalis_persona_v1"

#: The editable prose. 🔴 ONLY `description` and `title` — the rest of a descriptor (`position`,
#: `depth`, `role`, `lorebook`) is machinery: numbers, an enum and a book NAME. Handing a model a
#: field whose legal values are 0-4 invites it to write a sentence there, and a `lorebook` it
#: rewrote would dangle exactly like the §8.2 link this design exists to keep intact.
PERSONA_FIELDS_DEFAULT = ("description", "title")

PERSONA_KIND = {
    "description": "a persona's description of themselves — this is the USER, not a character",
    "title": "a persona's short title",
}


def jobs(doc: dict[str, Any], *, rel: str,
         fields: tuple[str, ...] = PERSONA_FIELDS_DEFAULT,
         include_empty: bool = False) -> list[Job]:
    """Every editable field of a persona, in `fields` order.

    Blank and missing fields are skipped identically — see the note about `title` being deleted
    rather than blanked — so a persona that has never had a title simply has one job.

    `include_empty` lets the UI expose absent fields as editable rows. This supports new personas
    and descriptors where SillyTavern omits an empty field.

    New personas begin without prose, so their fixed fields can be assigned directly by `set_at`;
    placeholder text is not needed.

    Empty fields are excluded by default and marked with `pass_default=False` plus `meta["empty"]`.
    The UI can allow direct editing while preventing model passes from inventing missing prose.
    """
    out: list[Job] = []
    for f in fields:
        v = doc.get(f)
        filled = isinstance(v, str) and v.strip()
        if not filled and not include_empty:
            continue
        # ⚠️ ABSENT or a blank STRING only, exactly as `card.jobs` has it. A key holding a dict or
        # a list is not an empty field, and a textarea over it would let a save replace a structure
        # with a string — `position`/`depth`/`role` are not in PERSONA_FIELDS_DEFAULT today, but
        # the rule must not depend on that staying true.
        if not filled and not (v is None or isinstance(v, str)):
            continue
        out.append(Job(rel=rel, locator=(f,), label=f, original=v if filled else "",
                       meta={"section": rel, "kind": PERSONA_KIND.get(f, f"a persona's {f}"),
                             "pass_default": bool(filled), "empty": not filled}))
    return out


def avatar_id(doc: dict[str, Any]) -> str:
    """The persona's stable identity — its avatar filename. `""` when absent."""
    v = doc.get("avatar")
    return v.strip() if isinstance(v, str) else ""


def lorebook_name(doc: dict[str, Any]) -> str:
    """The book this persona binds, BY NAME, because that is what SillyTavern stores.

    Mirrors `png_card.world_name` deliberately: the same `world_ref` → `world_id` resolution that
    links a card to its book (§8.2) works unchanged for a persona, so a persona shows up under the
    same worldbook filter and survives a rename in Vocalis for the same reason.

    📌 **Their delete path leaves these dangling** — renaming a worldbook migrates every persona's
    link, but deleting one clears only the scalar and the active persona (`world-info.js:4533`),
    so non-active personas keep a name pointing at nothing. That is SillyTavern's asymmetry, not
    ours. Surface it; never silently "repair" settings as a side effect of an import.
    """
    v = doc.get("lorebook")
    return v.strip() if isinstance(v, str) else ""


# ── 9.5.12 — a persona that arrives as a FILE ───────────────────────────────────────────
#
# SillyTavern stores personas as descriptor maps rather than files. Vocalis represents them as
# documents with a spec marker, so this parser supports importing and exporting that document form.
#
# 🔴 WHAT THIS DOES *NOT* DO IS WIDEN DETECTION. §4.2's rule is that the kind is detected and
# never declared, and `detect.doc_kind` keys a persona off the EXACT spec string because — as the
# note on `PERSONA_FIELDS_DEFAULT` above records — a persona has no field a card does not also
# have. Nothing here changes that. This converts a foreign file INTO a persona document, and the
# caller then puts the result through the ordinary funnel (`check_document`, then `doc_kind`),
# which answers "persona" because the marker is now on it. A file that is really a card is refused
# here rather than stamped, which is the whole reason `NotAPersona` exists.


class NotAPersona(ValueError):
    """This file is a document, but not this kind of one. The message reaches the user, so it says
    which tab the file belongs on rather than merely refusing."""


#: A name is a LABEL, not content — the identity is the avatar filename (§8.3). Capped to match
#: `MAX_NAME` on the web side so a hand-written file cannot file a 2 MB Library row title.
MAX_PERSONA_NAME = 200

#: The descriptor machinery, carried through when a hand-written file happens to set it. Numbers
#: and an enum: `position` (where the description is injected), `depth`, `role`. NOT prose, which
#: is why `PERSONA_FIELDS_DEFAULT` keeps them away from the editor and from a pass.
_MACHINERY = ("position", "depth", "role")

#: `# Sample Persona — User Persona` is a document title; the persona name is `Sample Persona`. Narrow
#: on purpose: only a trailing dash-separated segment that is literally about being a persona, and
#: only at the very end. Getting it wrong costs a rename, which is one control away.
_TITLE_SUFFIX = re.compile(r"[\s_-]*[—–-][\s_]*(?:the\s+|a\s+)?(?:user[\s_-]+)?persona\s*$", re.I)

#: The first ATX heading, which is where a hand-written persona document puts its subject's name.
_H1 = re.compile(r"^[ \t]{0,3}#{1,2}[ \t]+(.+?)[ \t]*#*[ \t]*$", re.M)


def _clean_name(value: Any, fallback: str = "") -> str:
    """A display name: the first candidate that still says something once trimmed, then capped.

    ⚠️ **THE FALLBACK HAS TO BE RE-TRIED *AFTER* THE TRIM, NOT ONLY WHEN THE HEADING IS ABSENT.**
    `# — User Persona` is a heading that is entirely document scaffolding: it is not empty, so a
    fallback keyed on emptiness never fires, and the trim then leaves nothing at all. Written the
    obvious way this raised "that file has no heading" at a file whose heading was right there.
    """
    for candidate in (value if isinstance(value, str) else "", fallback or ""):
        name = _TITLE_SUFFIX.sub("", candidate.strip()).strip()
        if name:
            return name[:MAX_PERSONA_NAME]
    return ""


def from_document(doc: Any, *, default_name: str = "") -> dict[str, Any]:
    """A parsed JSON document → a persona document, or `NotAPersona`.

    🔴 **OUR OWN EXPORT COMES BACK VERBATIM.** A file carrying `SPEC` is a persona this
    product wrote, and re-reading it must be lossless: `avatar`, `lorebook` and the descriptor
    numbers all survive, because that is what makes export → edit → import a round trip rather
    than a lossy copy. Every other shape is CONVERTED, and conversion is where the rules below
    apply.

    🔴 **`avatar` IS DROPPED FROM A FOREIGN FILE, AND THAT IS NOT TIDINESS.** The avatar
    filename is a persona's identity over there (§8.3) and `wbedit_new_persona`'s docstring spells
    out what inventing one costs: a ref that collides with an existing persona makes
    `writePersona` edit that descriptor — an unasked-for write — and a ref
    that collides with nothing points at a file which never existed. A stranger's file naming
    `sample.png` must not be able to reach into the install. The picture arrives the way a created
    persona's does, with `⬆ Upload PNG`, and the send assigns the real filename.

    ⚠️ **A card and a World Book are refused by name.** Both are plausible inputs to this pane,
    this pane, and both would survive being stamped with our marker: a card's `description` would
    become the persona's and its thirteen other fields would vanish silently, which is §4.2's
    detection-order failure arriving through a door that skips detection. The message names the
    tab that does want the file.
    """
    if isinstance(doc, list):
        raise NotAPersona("that is a World Book — import it on the World Books tab")
    if not isinstance(doc, dict):
        raise NotAPersona("that file holds no persona — expected an object with a name and a "
                          "description")
    if doc.get("spec") == SPEC:
        return dict(doc)
    if (str(doc.get("spec", "")).startswith("chara_card") or "first_mes" in doc
            or "mes_example" in doc or isinstance(doc.get("data"), dict)):
        raise NotAPersona("that is a character card — import it on the Character Cards tab")
    if "entries" in doc:
        raise NotAPersona("that is a World Book — import it on the World Books tab")

    out: dict[str, Any] = {"spec": SPEC, "name": _clean_name(doc.get("name"), default_name)}
    for field in ("description", "title", "lorebook"):
        v = doc.get(field)
        if isinstance(v, str) and v.strip():
            out[field] = v
    for field in _MACHINERY:
        v = doc.get(field)
        # `bool` is an `int` in Python, and `position: true` is not a position.
        if isinstance(v, int) and not isinstance(v, bool):
            out[field] = v
    if not out["name"] and "description" not in out:
        raise NotAPersona("nothing in that file looks like a persona — it has neither a name nor "
                          "a description")
    return out


def from_markdown(text: str, *, default_name: str = "") -> dict[str, Any]:
    """A Markdown or plain-text file → a persona document.

    🔴 **The whole file becomes the description, headings and all.** A file may have a
    `## Persona description (paste into SillyTavern's persona field)` section, and lifting only
    that one section would be the most useful thing to do right up until the file that does not
    have one — at which point the import reports success over a document it silently gutted.
    Trimming prose after import is straightforward; recovering text the import threw away is not.
    The UI reports that the whole file was imported, so the editor is where a user can trim it.

    The name is the first heading, because that is where a hand-written document puts its subject,
    and the filename stem when there is none.
    """
    body = text.strip()
    if not body:
        raise NotAPersona("that file is empty")
    heading = _H1.search(body)
    name = _clean_name(heading.group(1) if heading else "", default_name)
    if not name:
        raise NotAPersona("that file has no heading and its filename gives no name — rename the "
                          "file, or put a `# Name` line at the top")
    return {"spec": SPEC, "name": name, "description": body}


def from_upload(text: str, *, default_name: str = "") -> tuple[dict[str, Any], bool]:
    """One decoded upload → `(persona document, came_from_prose)`. JSON when it parses to one.

    ⚠️ **A SCALAR IS NOT THE JSON BRANCH.** `json.loads` accepts `42` and `"hello"`, so a plain
    text persona whose whole content is one quoted sentence would parse "successfully" and then be
    refused as an object that is not one. Only a dict or a list takes the JSON road; everything
    else is prose, which is what the file actually is.

    📌 **THE SECOND VALUE IS FOR THE TOAST, AND IT EARNS ITS AWKWARDNESS.** A prose import puts the
    WHOLE file in the description on purpose (see `from_markdown`), and a description is injected
    into every prompt over there. The success message must explain that trimming is the user's
    choice; otherwise a large persona may unexpectedly appear in the
    context window. The caller cannot re-derive it without parsing the file a second time.
    """
    # 🔴 THE BOM COMES OFF FIRST, AND IT IS NOT COSMETIC. Windows writes UTF-8 with a
    # byte-order mark by default — Notepad does, and so does PowerShell's `>` — and `str.strip()`
    # does not remove U+FEFF because it is not whitespace. `json.loads` RAISES on a leading one, so
    # a perfectly good persona JSON fell through to the prose branch and imported as a description
    # holding its own raw JSON: a cheerful 201 over nonsense. The Markdown road was quieter and
    # still wrong — `_H1` anchors at the start of a line, so a BOM meant no heading and the name
    # came from the filename instead. One strip, at the seam both roads cross.
    text = text.lstrip("\ufeff")
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, (dict, list)):
        return from_document(parsed, default_name=default_name), False
    return from_markdown(text, default_name=default_name), True
