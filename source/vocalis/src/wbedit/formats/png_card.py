"""Character cards that arrive as a PNG — reading the card out, and writing one back.

🔴 **A CHARACTER CARD *IS* A PNG.** The JSON lives in the image's ancillary text chunks, and the
picture is the avatar. That is not an encoding detail: it is why §4.3 stores exactly ONE image
per character, why card export must go through `merge-attributes` (a bare `/create` with no image
writes ST's gray placeholder and answers 200), and why "import a card" means "import a picture
that happens to carry a document".

Two chunk conventions, and BOTH are in the wild:

  * `chara`   — base64 of the JSON, V1 and V2. Universal.
  * `ccv3`    — base64 of a Character Card V3 document. Newer, and when it is present it is the
                authoritative one, because a V3 writer mirrors a lossy V2 copy into `chara` for
                old readers. 🔴 **Prefer `ccv3`.** Reading `chara` off a V3 card silently drops
                whatever V3 added.

⚠️ **THIS MODULE PARSES PNG BY HAND, ON PURPOSE.** Pillow can read text chunks — but it is **not
a declared dependency** (`setup.sh` never installs it and nothing in `src/` imports it), and it
decodes the image to do it, and re-encoding on the way out would destroy
exactly what §4.3.1 warns about: an animated PNG survives a card edit in the fork because their
writer catches the decode failure and passes the ORIGINAL BYTES through, and foreign ancillary
chunks (ComfyUI generation metadata) do not survive a decode/encode round trip at all. A PNG is a
signature plus a sequence of length-prefixed chunks; walking it is thirty lines and it lets us
keep every byte we were given.

📌 Sizes, measured on the live install (§4.3): 8 cards, min 46 KB, p50 636 KB, p90 1.09 MB, max
1.25 MB. Plan for ~700 KB typical and low single-digit MB worst case.
"""
from __future__ import annotations

import base64
import binascii
import copy
import json
import math
import struct
from typing import Any, Iterator

from . import validate

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

#: In priority order. `ccv3` wins when both are present — see the module note.
CARD_KEYS = ("ccv3", "chara")


class NotAPng(ValueError):
    """The bytes are not a PNG at all."""


class NoCardInPng(ValueError):
    """A valid PNG with no character card in it.

    🔴 **DISTINCT FROM `NotAPng`, AND THE DIFFERENCE IS WHAT THE USER IS TOLD.** "That is not a
    PNG" and "that PNG has no character in it" are different mistakes with different fixes — the
    second can mean the user selected an avatar image instead of exporting the card from
    SillyTavern, and the message should make that distinction clear.
    """


def chunks(blob: bytes) -> Iterator[tuple[str, bytes]]:
    """Walk a PNG's chunks as `(type, data)`. No decoding, no validation beyond the framing.

    ⚠️ The CRC is read past, not checked. We are not a PNG validator, and refusing a card whose
    CRC is stale would refuse a file every other tool in the chain accepts.
    """
    if not blob.startswith(PNG_SIGNATURE):
        raise NotAPng("not a PNG (bad signature)")
    i = len(PNG_SIGNATURE)
    n = len(blob)
    while i + 8 <= n:
        (length,) = struct.unpack(">I", blob[i:i + 4])
        # 🔴 latin-1, NOT ascii-with-replace. `replace` maps any byte ≥ 0x80 to U+FFFD, which is
        # lossy — and `write_card` re-encodes this string to pass the chunk through, so a lossy
        # decode there became `UnicodeEncodeError` on EVERY export of that card, forever. latin-1
        # is the one codec that round-trips all 256 byte values 1:1. Chunk types are ASCII by
        # spec, so the comparisons below are unaffected; this is purely about surviving a file
        # that violates the spec rather than detonating on it.
        ctype = blob[i + 4:i + 8].decode("latin-1")
        start = i + 8
        end = start + length
        if end > n:
            break                       # truncated file — yield what was whole and stop
        yield ctype, blob[start:end]
        i = end + 4                     # skip the CRC
        if ctype == "IEND":
            break


def _text_pairs(blob: bytes) -> Iterator[tuple[str, bytes]]:
    """Every `tEXt` / `iTXt` keyword and its raw value.

    `zTXt` is deliberately absent: its value is zlib-compressed, no card writer in this chain
    produces one, and supporting a path nothing generates means shipping a decompressor that is
    never exercised — which is how a bomb gets in.
    """
    for ctype, data in chunks(blob):
        if ctype == "tEXt":
            key, _, value = data.partition(b"\x00")
            yield key.decode("latin-1", "replace"), value
        elif ctype == "iTXt":
            # keyword \0 compression_flag compression_method \0 lang \0 translated \0 text
            key, _, rest = data.partition(b"\x00")
            if len(rest) < 2:
                continue
            compressed = rest[0] == 1
            rest = rest[2:]
            for _ in range(2):          # language tag, translated keyword
                _, _, rest = rest.partition(b"\x00")
            if compressed:
                continue                # see the note above
            yield key.decode("latin-1", "replace"), rest


def read_card(blob: bytes) -> tuple[dict[str, Any], str]:
    """The card document inside a PNG, and which chunk key it came from.

    Raises `NotAPng` or `NoCardInPng`. Never returns a partially-decoded document: a card that
    base64-decodes but will not parse as JSON is a corrupt card, and filing it as an empty one
    would put a row in the Library that opens onto nothing.

    🔴 **AND NEVER RETURNS A DOCUMENT THE REST OF THE PRODUCT CANNOT HOLD**.
    This is the PNG door; `detect.doc_kind` is the JSON one. Both run the same pass
    (`formats/validate.py`), so a card cannot be safe by one route and lethal by the other.
    """
    found: dict[str, bytes] = {}
    for key, value in _text_pairs(blob):
        if key.lower() in CARD_KEYS and key.lower() not in found:
            found[key.lower()] = value

    for key in CARD_KEYS:
        if key not in found:
            continue
        try:
            raw = base64.b64decode(found[key], validate=False)
            doc = json.loads(raw.decode("utf-8"))
        except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
            # 🔴 The KEY and the exception TYPE, never the payload (I16). A JSON error quotes the
            # window it failed on, and that window is the character's description.
            raise NoCardInPng(
                f"the PNG's `{key}` chunk is not a readable character card "
                f"({type(exc).__name__})") from exc
        except RecursionError as exc:
            # 🔴 `RecursionError` is a `RuntimeError`, not a `ValueError`, so deeply nested JSON
            # bypasses the malformed-payload handler above. Return the same safe card error instead
            # of leaking a server error for excessive nesting.
            raise NoCardInPng(
                f"the PNG's `{key}` chunk is nested far too deeply to be a character card "
                f"({type(exc).__name__})") from exc
        if not isinstance(doc, dict):
            raise NoCardInPng(f"the PNG's `{key}` chunk is not a character card")
        try:
            validate.check_document(doc, what=f"the PNG's `{key}` chunk")
        except validate.InvalidDocument as exc:
            # Its message, not a generic one: it names the JSON path and the reason, which is the
            # difference between "re-export it from SillyTavern" and "no idea, try another file".
            raise NoCardInPng(str(exc)) from exc
        return doc, key

    raise NoCardInPng("that PNG carries no character card — export the CARD from SillyTavern "
                      "rather than saving the picture")


def focus_rect(doc: dict[str, Any]) -> dict[str, float]:
    """§4.3's `data.extensions.taproom_avatar_focus`, if the card carries one.

    Absent means "largest centered square", which is most cards — neither card on the
    `claudetest` login has one — so an empty dict is the normal answer and not a failure.
    """
    d = doc.get("data") if isinstance(doc.get("data"), dict) else doc
    ext = d.get("extensions") if isinstance(d, dict) else None
    rect = ext.get("taproom_avatar_focus") if isinstance(ext, dict) else None
    if not isinstance(rect, dict):
        return {}
    out = {}
    for k in ("x", "y", "w"):
        try:
            out[k] = float(rect[k])
        except (KeyError, TypeError, ValueError):
            return {}
    # Apply the same finite-number validation as the `/focus` route. Imported card metadata can
    # contain `Infinity` or `NaN`; emitting either as a JSON number would make the exported tEXt
    # chunk invalid. An unusable rectangle means "no rectangle," the normal default for most cards.
    if not all(math.isfinite(v) for v in out.values()):
        return {}
    if not (0.0 < out["w"] <= 1.0):
        return {}
    for k in ("x", "y"):
        out[k] = min(max(out[k], 0.0), 1.0 - out["w"])
    return out


def world_name(doc: dict[str, Any]) -> str:
    """§8.2 — `data.extensions.world`, the name of the card's PRIMARY lorebook.

    A card points at its book by NAME, because that is SillyTavern's format and we do not get to
    change it. Empty is the normal answer for a card with no book, not a failure.

    ⚠️ **This is the primary book only.** A character's *extra* lorebooks live in ST's own
    settings under `world_info.charLore` and are not on the card at all, so a filter built from
    this value alone cannot see them (§8.2). Do not describe it as "the card's worldbooks".

    Lives beside `focus_rect` and not in `formats/card.py` for the same reason that one does:
    `card.py` collects the fields a pass may EDIT, and neither of these is editable text — they
    are metadata about the card that the Library reads without opening a revision.
    """
    d = doc.get("data") if isinstance(doc.get("data"), dict) else doc
    ext = d.get("extensions") if isinstance(d, dict) else None
    name = ext.get("world") if isinstance(ext, dict) else None
    return name.strip() if isinstance(name, str) else ""


def with_world_name(doc: dict[str, Any], name: str) -> dict[str, Any]:
    """`doc` with `data.extensions.world` set to `name`. A COPY — the input is untouched.

    §8.2's other boundary. The link is held as a document **id**, so the name is resolved on the
    way out rather than stored: SillyTavern receives whatever the linked book is called *now*,
    not whatever it was called on the day the card was imported.

    🔴 **COPIES RATHER THAN MUTATES.** The dict handed in is a revision just read off disk, and
    exporting a document must never be able to edit it. `write_card` serializes whatever it is
    given without interpreting it, so an in-place write here would be indistinguishable from a
    real edit and would ride into the next revision that gets materialized.
    """
    out = copy.deepcopy(doc)
    d = out.get("data") if isinstance(out.get("data"), dict) else out
    if not isinstance(d, dict):
        return out
    ext = d.get("extensions")
    if not isinstance(ext, dict):
        ext = {}
        d["extensions"] = ext
    ext["world"] = name
    return out


#: §4.3 / m4o — the taproom fork's own field for the round-avatar focus rect. 🔴 THEIRS, NOT OURS:
#: `public/script.js:8056` declares it and `getAvatarThumbnailUrl` applies it to the thumbnail
#: endpoint, so a rect written here is one their UI reads. That is what makes this whole feature
#: non-destructive on both sides — nobody has to crop a file to change which square is the face.
FOCUS_FIELD = "taproom_avatar_focus"


def with_focus(doc: dict[str, Any], focus: dict[str, float] | None) -> dict[str, Any]:
    """`doc` with `data.extensions.taproom_avatar_focus` set, or REMOVED for an empty rect.

    m4o's boundary, and deliberately the same shape as `with_world_name` above: the rect lives in
    `Document.focus` because it describes the image rather than the text, and it is put back into
    the card on the way out. A copy, for that function's reason.

    🔴 **AN EMPTY RECT DELETES THE KEY RATHER THAN WRITING ZEROES.** Absent means "largest centered
    square" to both products; a rect of `{x:0,y:0,w:0}` means a zero-width window, and their
    `focusToParam` would happily serialize it into a thumbnail URL. "Back to default" has to be
    expressible, and this is how it is spelled on their side.
    """
    out = copy.deepcopy(doc)
    d = out.get("data") if isinstance(out.get("data"), dict) else out
    if not isinstance(d, dict):
        return out
    ext = d.get("extensions")
    if not isinstance(ext, dict):
        if not focus:
            return out                          # nothing to remove, nothing to add
        ext = {}
        d["extensions"] = ext
    if focus:
        ext[FOCUS_FIELD] = {k: float(focus[k]) for k in ("x", "y", "w")}
    else:
        ext.pop(FOCUS_FIELD, None)
    return out


def write_card(blob: bytes, doc: dict[str, Any]) -> bytes:
    """The same PNG with its card chunks replaced by `doc`. Every other byte survives.

    🔴 **EVERY OTHER CHUNK IS PASSED THROUGH UNTOUCHED**, which is the whole reason this module
    does not go near Pillow. An animated PNG (`acTL`/`fcTL`/`fdAT`) still animates, an ICC
    profile still applies, and ComfyUI's generation metadata is still there — none of which
    survives a decode and re-encode.

    Both keys are written when the source had both, so a V2-only reader still sees a card. The
    document is written to each, because our editor's document IS the truth (§1.2) and leaving a
    stale `chara` beside a fresh `ccv3` is exactly the drift `originalData` causes on the ST side.
    """
    payload = base64.b64encode(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
    # 🔴 FOLDED, because `written` is folded. Keeping the original spelling here meant a file
    # whose keyword is `Chara` never satisfied `present - written` (which holds `chara`), so the
    # payload was written a SECOND time as a new chunk — and again on every export→re-import
    # cycle after that, growing the file by the whole card each round trip. The spelling of a
    # chunk that already exists is preserved in the loop below, from its own bytes; `present` is
    # only ever consulted to invent a keyword that is NOT there, and lowercase is right for that.
    present = {k.lower() for k, _ in _text_pairs(blob) if k.lower() in CARD_KEYS}
    if not present:
        present = {"chara"}

    out = bytearray(PNG_SIGNATURE)
    written = set()
    closed = False

    def emit(ctype: str, data: bytes) -> None:
        raw = ctype.encode("latin-1")
        out.extend(struct.pack(">I", len(data)))
        out.extend(raw)
        out.extend(data)
        out.extend(struct.pack(">I", binascii.crc32(raw + data) & 0xFFFFFFFF))

    for ctype, data in chunks(blob):
        if ctype in ("tEXt", "iTXt"):
            key, _, _ = data.partition(b"\x00")
            name = key.decode("latin-1", "replace")
            if name.lower() in CARD_KEYS:
                # Replace in place, keeping the original keyword's spelling and position: some
                # readers look for `chara` and some for `Chara`, and moving a chunk after IDAT
                # is legal but has tripped readers that scan only the header.
                emit("tEXt", key + b"\x00" + payload)
                written.add(name.lower())
                continue
        if ctype == "IEND":
            for missing in sorted(present - written):
                emit("tEXt", missing.encode("latin-1") + b"\x00" + payload)
            emit("IEND", b"")
            closed = True
            break
        emit(ctype, data)

    # 🔴 NO `IEND` MEANS THE CARD WAS NEVER WRITTEN, BECAUSE THE BLOCK ABOVE IS THE ONLY PLACE
    # THAT WRITES IT. `chunks` stops early on a truncated file, so this loop can finish having
    # emitted a prefix and nothing else — and the old code returned that prefix. Exporting an
    # 8-byte stored avatar therefore answered 200 with a `filename=` header and a file holding
    # no card and no terminator: the one place in this codebase where success was reported for
    # discarded data. Loud is the only correct answer — falling back to bare JSON here would
    # drop the picture instead, which is C6a (§4.3.1) arriving by a different road.
    if not closed:
        raise NotAPng(
            "the stored picture is truncated (no IEND chunk) — its card cannot be written. "
            "Replace the picture with ⬆ Upload PNG, then export again.")
    return bytes(out)
