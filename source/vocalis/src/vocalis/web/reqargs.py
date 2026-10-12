"""Query-string parsing that distinguishes ABSENT from PRESENT-AND-WRONG.

🔴 **SHARED PARSING KEEPS THE INPUT DISTINCTION CONSISTENT.** This module serves both
blueprints, so routes do not duplicate the rule or collapse an absent parameter and an invalid
one into the same value.

The bug it exists to stop:

    n = request.args.get("revision", type=int)

werkzeug returns `None` for BOTH "the caller did not ask for a revision" and "the caller asked
for `?revision=banana`". Downstream, `DocumentStore.revision(doc_id, None)` reads `None` as
"latest" — a sensible default for the first case and a silent substitution in the second. On a
read that hands back the wrong version of the document. On `POST …/entry` it is a WRITE: the new
revision is forked off latest instead of off the base the browser named, which is the same class
of harm as §1.1 (a change written from a base that is not the one it was computed against).

The shape is lifted from `wbedit_draft_put`, which is the one place in the codebase that already
got this right — it parses the revision out of the JSON body with an explicit
`try/except (TypeError, ValueError)` and answers 400.
"""
from __future__ import annotations

from flask import request


class BadArg(ValueError):
    """A query parameter was present and could not be read. Carries a message for the user.

    A `ValueError` so that any route already narrowing on `ValueError` keeps behaving sensibly,
    and so the wbedit blueprint's catch-all renders it as a 400 rather than a 500.
    """


def revision_arg(name: str = "revision") -> int | None:
    """`None` if the parameter is absent, an `int` if it parses, `BadArg` if it is present and not.

    ⚠️ **`None` STILL MEANS "LATEST", AND THAT IS DELIBERATE.** Absent is a real and common case:
    the Library opens a document without naming a revision, and `GET /export` documents its own
    "no default" rule separately. What changes is that the caller can no longer arrive at that
    default by *mistyping*.

    ⚠️ An empty string counts as present-and-wrong. `?revision=` is a truncated URL or a template
    that interpolated nothing, and both are far more likely to be a bug than a request for latest.
    """
    if name not in request.args:
        return None
    raw = request.args.get(name, "")
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise BadArg(f"{name} must be a whole number, not {raw[:32]!r}") from None
