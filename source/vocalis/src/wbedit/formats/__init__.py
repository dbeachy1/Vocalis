"""Format collectors: a loaded document in, a list of `Job` out.

🔴 **NOTHING HERE TOUCHES THE FILESYSTEM, AND THAT IS A DESIGN CHANGE FROM THE BASELINE.** The
CLI's `collect_jobs()` took a path, walked a directory with `rglob`, read and parsed each file,
and printed skips to stderr. All four of those belong to somebody else now: the store owns the
bytes (§5), the vault owns the reads, the caller owns the reporting, and `src/` may not do raw
I/O at all (§7.1). What is left is the part that was always the interesting one — turning a
parsed document into the fields a pass will edit.

`rel` is a display name for the report, not a path. It is still called `rel` because that is what
the report heading has always been keyed on.
"""
from __future__ import annotations

from typing import Any

from ..core.job import Job
from . import card as _card
from . import worldbook as _worldbook
from . import persona as _persona
from .detect import doc_kind

CARD_FIELDS_DEFAULT = _card.CARD_FIELDS_DEFAULT
#: m5d / §9a.21 — every field the EDITOR offers, as opposed to every field a PASS runs over.
CARD_FIELDS_ALL = _card.CARD_FIELDS_ALL


class UnsupportedDocument(ValueError):
    """The document is neither a character card nor a worldbook.

    🔴 It is raised, not printed and skipped. The baseline was a CLI walking a directory the user
    pointed at, so "that one wasn't a book, moving on" was right; here the caller has just handed
    us one document it chose deliberately, and swallowing that would import a file into the
    library that no pass can ever touch — visible only as an empty field list, days later.
    """


def collect(doc: Any, *, rel: str, field: str = "content",
            card_fields: tuple[str, ...] = CARD_FIELDS_DEFAULT,
            card_preselect: tuple[str, ...] | None = None,
            card_empty: bool = False, persona_empty: bool = False) -> list[Job]:
    """Every editable field in `doc`, in document order.

    🔴 **Card is detected FIRST** (§4.2) — a V2 card may embed a `character_book` with `entries`
    and would otherwise be collected as a worldbook, editing the embedded book and silently
    ignoring `description`, `personality`, `scenario` and the greetings.

    🔴 **Nothing is excluded by content.** No X-prefix check, no skip list, no
    `--include-sealed`. I9: *"X is not immune."* An entry is collected or it does not exist.

    `card_preselect` (m5d) is which of `card_fields` come TICKED; `None` means all of them, which
    is every caller that has not been taught the difference.

    🔴 **`card_empty` (7.4 / §9a.32) IS THE EDITOR'S SURFACE, NEVER A PASS'S.** True adds a row for
    each card field that is absent or blank so it can be typed into for the first time. The two
    routes that answer "what may the user see and save" — `GET /fields` and `POST /edit` — pass True
    and MUST agree; the pass routes leave it False, because an empty field gives the model nothing
    to rewrite and it will invent something anyway. See `card.jobs`.

    🔴 **`persona_empty` (§9a.11) IS THE SAME SWITCH FOR THE SAME REASON, AND IT IS SEPARATE ON
    PURPOSE.** Two flags rather than one `empty=`, because the two kinds do not have to move
    together and a single flag would make any future change to one silently change the other. The
    same pairing rule binds it: the two editor routes pass True and must agree, the pass routes
    leave it False. See `persona.jobs` for why the gap was worse for personas than for cards.
    """
    kind = doc_kind(doc)
    if kind == "persona":
        return _persona.jobs(doc, rel=rel, include_empty=persona_empty)
    if kind == "card":
        return _card.jobs(doc, rel=rel, fields=card_fields, preselect=card_preselect,
                          include_empty=card_empty)
    if kind == "worldbook":
        return _worldbook.jobs(doc, rel=rel, field=field)
    raise UnsupportedDocument(f"{rel}: not a worldbook, character card or persona")
