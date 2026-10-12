"""One pass over an untrusted document, run at the door.

🔴 **REJECT INVALID DOCUMENTS BEFORE THEY ARE STORED.** Otherwise an import can succeed while
later routes fail to read the row:

  * ~500 levels of nesting: `json.loads` accepts to depth 16919 and `copy.deepcopy` dies at 498,
    so export, send, edit and rollback all 500 forever while DELETE is the only thing that works.
  * a lone surrogate (`"\\ud800"`): `json.dumps(...).encode("utf-8")` raises inside the store's
    atomic write, which leaves the document's directory made and a `.part` beside it, and
    answers 500 with no message.
  * `Infinity` / `NaN`: they survive `json.loads`, are written into a revision, and come back out
    of `json.dumps` as bare `Infinity` — which is not JSON, so the card we hand back cannot be
    parsed by SillyTavern or by us. (`focus_rect` guards its own three floats; nothing guarded
    the other several hundred.)
  * `{"entries": "hello"}`: `doc_kind` said "worldbook", the import succeeded, and every
    `/fields`, `/edit` and `/pass` on that row 500ed on `iter_entries`.

The validation pass checks finite floats, bounded depth, and the shape of `entries`.

🔴 **IT IS A CHOKEPOINT ONLY IF EVERY DOOR OPENS ONTO IT.** The codebase's documented dominant
failure mode is a guard at one entrance and a second path that builds the same thing beside it
(id validation went into `DocumentStore._dir` while `PassStore` assembled the same path itself,
and six routes walked past it). There are four ways a document gets built from bytes nobody in
this process wrote, and all four are wired to this module:

  1. `POST /wbedit/documents` with a JSON file or body  → `detect.doc_kind()`      → here
  2. `POST /wbedit/documents` with a card PNG           → `png_card.read_card()`   → here
                                                        → then `doc_kind()`        → here again
  3. `POST /pair/documents` (the SillyTavern extension) → `detect.doc_kind()`      → here
  4. `POST /wbedit/assemble` (section chunks)           → `assemble.assemble()`    → here

⚠️ **THE WALK IS ITERATIVE, AND THAT IS NOT A STYLE PREFERENCE.** A recursive checker meets a
600-deep document by raising `RecursionError` — which is a `RuntimeError`, not a `ValueError`, so
it sails past every `except ValueError` between here and the route and becomes the exact 500 this
module exists to prevent. The guard must not be breakable by the thing it guards against.

📌 **NOT `core/validate.py`.** That one validates a MODEL'S REPLY against the field it was asked
to edit (length ratios, leaked protocol text, dropped macros) and its answer is a list of flags on
work we asked for. This one validates a DOCUMENT arriving from outside the process, and its answer
is yes or no. Same word, opposite ends of the pipeline; neither imports the other.

⚠️ **NO CONTENT IN ANY MESSAGE (I16).** These strings reach the browser and the log. They carry
the JSON *path* and the reason — never the value, never a window of the text around it. A JSON
parse error quotes the window it failed on, and that window is a character's description; the
same rule applies here, for the same reason.
"""
from __future__ import annotations

import math
from typing import Any

#: How deep a document may nest before we refuse it.
#:
#: 🔴 **MEASURED AGAINST WHAT BREAKS, NOT AGAINST WHAT LOOKS TIDY.** `copy.deepcopy` — which
#: `documents.py` runs on every revision it materializes and `png_card.with_world_name` runs on
#: every export — dies at depth **498** on this interpreter. Real documents are nowhere near it:
#: a V2 card is 4 deep, a compiled lorebook 3, a section chunk 3, and the deepest thing in the
#: wild is a third-party `extensions` blob at perhaps a dozen.
#:
#: 64 is therefore ~5× the deepest legitimate document and ~8× under the depth that actually
#: kills a consumer. The headroom below the failure point is deliberate: `deepcopy`'s 498 is
#: measured from an EMPTY stack, and the real call is 40-odd Flask/Jinja frames in, so the true
#: ceiling moves with the caller and a bound set just under it would be a bound that holds in
#: tests and not in production.
MAX_DEPTH = 64


class InvalidDocument(ValueError):
    """The document parsed, and it still cannot be stored or edited.

    🔴 **Distinct from "that is not a character card."**
    `png_card.NoCardInPng` exists for the same reason one line over: "that PNG has no character in
    it" and "that card has a broken character in it" are different mistakes with different fixes.

    A `ValueError`, because that is what every caller between here and the route already catches
    for "the bytes were wrong".
    """


def _describe(path: list[Any]) -> str:
    """A JSON path for the message — `data.extensions.world`, `entries.3.content`.

    Keys and indices only. That is the same line `read_card` draws (I16: the KEY and the exception
    type, never the payload), so a message can identify the invalid field without putting document
    text in a log.

    ⚠️ **ELIDED IN THE MIDDLE**, because the one path that is always long is the one a depth
    failure produces — long repeated paths add little beyond their first and last segments.
    """
    parts = [str(p) for p in path]
    if not parts:
        return "the document"
    if len(parts) > 8:
        parts = parts[:4] + ["…"] + parts[-3:]
    return ".".join(parts)


def check_document(doc: Any, *, what: str = "the document") -> None:
    """Raise `InvalidDocument` if `doc` cannot be safely stored, edited and written back.

    Three properties make a document safe to store, edit, and write back:

      * **bounded depth** (4.2) — nothing a `deepcopy` or a recursive encoder can drown in.
      * **finite floats** (4.8, the rest of it) — `Infinity`/`NaN` are not JSON and must not
        reach a revision, because everything downstream re-emits them into a file some other
        program has to read.
      * **encodable text** (4.6) — a lone surrogate cannot be UTF-8 encoded, so the store's write
        dies *after* it has made the directory.

    ⚠️ **THE FOURTH — the shape of `entries` (4.3) — IS IN `detect.doc_kind` AND NOT HERE**, and
    deliberately. It is a question about what a document *is*, not about whether it is safe: a
    card whose embedded `character_book.entries` is not a list is a perfectly ordinary card that
    `card.jobs` already skips, and refusing the import would turn a working card into a rejected
    one. Only a document being *classified as a worldbook* on the strength of its `entries` has
    to have a real collection there.

    The check is one pass over the parsed structure and makes no copies.
    """
    # (node, depth, path) — an explicit stack, never the interpreter's. See the module note.
    stack: list[tuple[Any, int, list[Any]]] = [(doc, 1, [])]
    while stack:
        node, depth, path = stack.pop()
        if depth > MAX_DEPTH:
            raise InvalidDocument(
                f"{what} nests more than {MAX_DEPTH} levels deep at {_describe(path)} — "
                "that is far past anything SillyTavern produces, and deeper than this "
                "editor can copy without failing")
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(k, str):
                    _check_text(k, what, path + [k])
                stack.append((v, depth + 1, path + [k]))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                stack.append((v, depth + 1, path + [i]))
        elif isinstance(node, str):
            _check_text(node, what, path)
        elif isinstance(node, float) and not math.isfinite(node):
            # `bool` is an `int` and `int` is exact, so only `float` can be here. `json.loads`
            # produces these from the bare `Infinity`/`NaN` tokens Python accepts and nothing
            # else does — and from `1e400`, which is a perfectly ordinary-looking literal.
            raise InvalidDocument(
                f"{what} holds {node} at {_describe(path)} — Infinity and NaN are not JSON, "
                "and a document carrying one cannot be exported to SillyTavern")


def _check_text(s: str, what: str, path: list[Any]) -> None:
    """Reject a string that cannot be UTF-8 encoded — 4.6.

    ⚠️ **THE TEST IS THE ENCODE ITSELF, NOT A RANGE CHECK**, because the encode is the operation
    that will fail later: `vault_fs.write_json_atomic` ends in `write_text(..., encoding="utf-8")`
    and Python's JSON decoder already re-pairs legitimate surrogate PAIRS into astral characters
    on the way in. What is left over here is genuinely unpaired, and there is no repair for it
    that does not silently change document text.
    """
    try:
        s.encode("utf-8")
    except UnicodeEncodeError as exc:
        # 🔴 The code point, not the string. `U+D800` is an invalid sequence, not document prose.
        bad = s[exc.start:exc.start + 1]
        raise InvalidDocument(
            f"{what} contains an unpaired surrogate (U+{ord(bad):04X}) at "
            f"{_describe(path)} — it is not valid text and cannot be saved. Re-export the "
            "document from SillyTavern rather than editing it by hand.") from exc
