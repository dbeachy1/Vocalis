"""Build cached roster thumbnails from card-image bytes.

The crop is applied before downscaling so the thumbnail retains detail. Cache identity includes
source metadata, crop focus, and output size; changing any input produces a different asset. The
original card is never rewritten, preserving animation and embedded metadata. Animated sources use
their first frame in the static thumbnail. This module performs no file I/O; the store owns asset
paths and vault access.
"""
from __future__ import annotations

import hashlib
import io
from typing import Any

#: Stored square edge length in pixels. The larger image remains sharp on high-DPI displays.
THUMB_PX = 96

#: 🔴 THE PREFIX IS PART OF THE CONTRACT. `DocumentStore` globs `thumb-*.webp` to sweep the
#: superseded ones, so anything else living under this name would be deleted by a rect edit.
PREFIX = "thumb-"
SUFFIX = ".webp"


class ThumbFailed(Exception):
    """The image could not be decoded or re-encoded.

    The caller can fall back to the original avatar and apply the crop in the browser.
    """


def key(size: int, mtime: float, focus: Any, px: int = THUMB_PX) -> str:
    """The cache identity of one thumbnail: **both inputs, plus the output size.**

    Source size and modification time match the avatar route's file identity. Focus and output
    size are included because either can change the rendered pixels without changing the source.
    Returns a stable hexadecimal cache key.
    """
    f = focus if isinstance(focus, dict) else {}
    # Rounded before hashing: the rect arrives from a browser drag as a float, and a value that
    # differs in the fifteenth decimal is the same crop. Without this, a re-serialized meta.json
    # could rebuild every thumbnail in the library for no visible change.
    rect = tuple(round(float(f.get(k, 0.0) or 0.0), 6) for k in ("x", "y", "w"))
    raw = f"{size}:{int(mtime * 1000)}:{rect[0]}:{rect[1]}:{rect[2]}:{px}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def asset_name(k: str) -> str:
    return f"{PREFIX}{k}{SUFFIX}"


def crop_box(w: int, h: int, focus: Any) -> tuple[int, int, int, int]:
    """The source rectangle the circle shows, in pixels — the same math `wbFitFace` does.

    Clamp stale or out-of-range focus metadata to the source bounds so the thumbnail matches the
    browser fallback and cannot request pixels outside the image.
    """
    f = focus if isinstance(focus, dict) else {}
    try:
        fw = float(f.get("w") or 0.0)
    except (TypeError, ValueError):
        fw = 0.0
    if fw > 0:
        side = fw * w
        sx = float(f.get("x") or 0.0) * w
        sy = float(f.get("y") or 0.0) * h
    else:
        side = min(w, h)                      # the largest centered square
        sx = (w - side) / 2
        sy = (h - side) / 2
    side = max(1.0, min(side, float(w), float(h)))
    sx = max(0.0, min(sx, w - side))
    sy = max(0.0, min(sy, h - side))
    left, top = int(round(sx)), int(round(sy))
    edge = max(1, int(round(side)))
    # Rounding can push the far edge one pixel past the image; pull the origin back rather than
    # shrinking the square, so the crop stays the shape the circle expects.
    left = min(left, w - edge)
    top = min(top, h - edge)
    return left, top, left + edge, top + edge


def render(blob: bytes, focus: Any, px: int = THUMB_PX) -> bytes:
    """`card.png` bytes in, a square WebP of the circle's content out.

    Raises `ThumbFailed` for anything Pillow objects to — a corrupt file, an unsupported format, a
    decompression bomb. The caller degrades to the full image; nothing here is worth a 500.
    """
    try:
        from PIL import Image
    except ImportError as exc:                # pragma: no cover — Pillow is a declared dependency
        # Keep the fallback specific to a missing dependency. Other Pillow failures are handled
        # per image below and should remain visible as thumbnail errors.
        raise ThumbFailed(f"Pillow is not available: {exc}") from exc

    try:
        with Image.open(io.BytesIO(blob)) as im:
            im.load()                         # decode now, inside the guard
            box = crop_box(im.width, im.height, focus)
            cut = im.crop(box)
            # RGBA is kept — a card cut out of its background must not gain a black square, and
            # WebP carries alpha. Palette and grayscale are converted because `resize` on a
            # palette image resamples the INDICES, which produces confetti.
            if cut.mode not in ("RGB", "RGBA"):
                cut = cut.convert("RGBA" if "A" in cut.getbands() or cut.mode == "P" else "RGB")
            if cut.width != px:
                cut = cut.resize((px, px), Image.LANCZOS)
            out = io.BytesIO()
            cut.save(out, format="WEBP", quality=82, method=4)
            return out.getvalue()
    except ThumbFailed:                       # pragma: no cover — defensive
        raise
    except Exception as exc:
        raise ThumbFailed(f"could not build a thumbnail: {type(exc).__name__}: {exc}") from exc
