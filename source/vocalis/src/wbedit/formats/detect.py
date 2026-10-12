"""Which format this is. Type is detected, never declared (§4.2)."""
from __future__ import annotations

from typing import Any

from . import persona as _persona
from .validate import InvalidDocument, check_document


def doc_kind(doc: Any) -> str | None:
    """`"card"`, `"worldbook"`, `"persona"`, or None.

    🔴 **CARDS ARE CHECKED FIRST, AND THE ORDER IS THE WHOLE FUNCTION.** A V2 character card may
    embed a `character_book`, which has `entries` — so a worldbook-first reading matches a card,
    collects only the embedded lorebook, and silently drops `description`, `personality`,
    `scenario`, `first_mes` and `mes_example`. The pass then reports a tidy success over a third
    of the fields it should have edited.

    Validation is enforced here because every import path passes through this function. Invalid
    documents are refused before a row is created, rather than failing later when a route reads it.

    ⚠️ **AN UNSAFE DOCUMENT ANSWERS `None` RATHER THAN RAISING**, and that is a decision about
    blast radius rather than about taste. Both callers already treat `None` as "400, not a
    character card or worldbook" and both catch a NARROW tuple around this call, so raising here
    would be a 500 on the `/pair/*` blueprint — the exact outcome being fixed. Callers that want
    the *reason* (a better message than "not a character card or worldbook") should call
    `validate.check_document` themselves and let it raise; it is idempotent and cheap.
    """
    if isinstance(doc, list):
        return "worldbook" if _safe(doc) else None
    if not isinstance(doc, dict):
        return None
    if not _safe(doc):
        return None
    # 🔴 PERSONA BEFORE CARD, for the same reason card comes before worldbook. A persona carries
    # `description`, and the flat-V1-card branch at the bottom matches on `description`. It is
    # checked by an EXACT spec string rather than by shape because a persona has no field a card
    # does not also have — shape alone cannot tell them apart (§8.3).
    if doc.get("spec") == _persona.SPEC:
        return "persona"
    if str(doc.get("spec", "")).startswith("chara_card"):
        return "card"
    inner = doc.get("data")
    if isinstance(inner, dict) and ("description" in inner or "first_mes" in inner):
        return "card"
    if "entries" in doc:
        # 🔴 **A COLLECTION, NOT MERELY THE KEY**. `{"entries": "hello"}` was
        # filed as a worldbook, answered 201, and then 500ed on every `/fields`, `/edit` and
        # `/pass` for the life of the row, because `worldbook.iter_entries` raises on anything
        # that is neither a list nor a dict. Nothing but DELETE worked on it again.
        #
        # ⚠️ Checked HERE and not in `validate.check_document`, because it is a question about
        # what the document IS. A card carrying a `character_book` whose `entries` is not a list
        # is an ordinary card that `card.jobs` already skips over; rejecting the import would
        # break a document that works today.
        return "worldbook" if isinstance(doc["entries"], (dict, list)) else None
    if "description" in doc and "first_mes" in doc:       # V1 card — flat, no `data` wrapper
        return "card"
    return None


def _safe(doc: Any) -> bool:
    """Did `doc` pass validation? See `doc_kind`'s note on why this is a
    boolean here rather than the exception `validate` actually raises."""
    try:
        check_document(doc)
    except InvalidDocument:
        return False
    return True


def display_name(doc: Any, kind: str, fallback: str) -> str:
    """A human name for the Library row. The document's own, when it has one.

    🔴 **One helper for both import paths** — a browser upload and a push from
    SillyTavern (§8.1) — and the same card arriving by either route must not end up with two
    different names in the Library. This is `focus_rect`'s reasoning one field over: the moment a
    second caller re-derives a value the first one already derives, the two answers start to
    differ and nothing says which is right.

    `fallback` is the caller's context — an upload's filename stem, or the ST key — and is used
    only when the document names itself nothing at all.
    """
    if not isinstance(doc, dict):
        return fallback or "untitled"
    if kind == "card":
        d = doc.get("data") if isinstance(doc.get("data"), dict) else doc
        n = d.get("name") if isinstance(d, dict) else None
        if isinstance(n, str) and n.strip():
            return n.strip()
    n = doc.get("name")
    if isinstance(n, str) and n.strip():
        return n.strip()
    if kind == "persona":
        # A persona with no display name still HAS an identity, and it is more use in the Library
        # than the caller's context: `sample.png` supplies a filename, `untitled` does not.
        av = _persona.avatar_id(doc)
        if av:
            return av
    return fallback or "untitled"
