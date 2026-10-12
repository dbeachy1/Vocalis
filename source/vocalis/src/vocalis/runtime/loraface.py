"""Normalize seed-face uploads for the LoRA training workflow.

The seed face is cropped to a centered square and resized to 1024 pixels. This transform
is specific to the conditioning image; dataset images preserve their original framing and
metadata during staging. Stored faces use the encrypted `lora_faces` tree.
"""
from __future__ import annotations

import io
from pathlib import Path

import vault_fs

from . import paths

#: §4.2: *"crops to square, resizes to 1024"*. The number is the requirement, not a guess.
FACE_PX = 1024

#: PNG, not WebP. A thumbnail is a derived accelerator and WebP is right for it; the seed face is
#: an INPUT to a training pipeline, gets read by ComfyUI and by the trainer, and a lossy step at
#: the top of a chain that produces ~72 images is exactly the "soft seed face" §4.2 warns about.
FACE_SUFFIX = ".png"

#: A decompression-bomb ceiling. Pillow's own default warns at ~89 Mpx and this is a hard stop
#: well above any real photo — a 12,000×12,000 upload is not a face, and decoding it to crop out
#: a 1024 square would hold ~1.7 GB of RGBA in the server process.
MAX_PIXELS = 64_000_000


class FaceRejected(RuntimeError):
    """The upload cannot be used as a seed face; carries a user-facing reason."""


def face_path(subject_id: str) -> Path:
    """Where this subject's seed face lives. Routed, so both bytes and filename are claimed."""
    from .lorasubj import dataset_dir  # reuses its id-safety check, which is the point
    dataset_dir(subject_id)            # raises ValueError on an id unsafe as a filename
    return paths.LORA_FACES / f"{subject_id}{FACE_SUFFIX}"


def square_box(w: int, h: int) -> tuple[int, int, int, int]:
    """The largest centered square in a `w`×`h` image.

    Center the crop so portrait images retain both face and chin. The caller displays the
    result and may let the user retry with a different source image.
    """
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return (left, top, left + side, top + side)


def render(blob: bytes, px: int = FACE_PX) -> bytes:
    """Upload bytes in, a `px`×`px` PNG out.

    Raises `FaceRejected` for anything Pillow objects to, so the screen can say what happened.
    """
    try:
        from PIL import Image
    except ImportError as exc:                # pragma: no cover — Pillow is a declared dependency
        raise FaceRejected(f"Pillow is not available: {exc}") from exc

    try:
        with Image.open(io.BytesIO(blob)) as im:
            if im.width * im.height > MAX_PIXELS:
                raise FaceRejected(
                    f"that image is {im.width}x{im.height}, which is too large to process")
            im.load()
            cut = im.crop(square_box(im.width, im.height))
            # Convert palette images first; Pillow otherwise resamples palette indices.
            if cut.mode != "RGB":
                # RGB, not RGBA: a seed face is a photograph and the trainer wants three channels.
                # Alpha is flattened onto white rather than dropped, so a cut-out PNG does not
                # arrive with black where its background was.
                if "A" in cut.getbands():
                    bg = Image.new("RGB", cut.size, (255, 255, 255))
                    bg.paste(cut.convert("RGBA"), mask=cut.convert("RGBA").split()[-1])
                    cut = bg
                else:
                    cut = cut.convert("RGB")
            if cut.width != px:
                cut = cut.resize((px, px), Image.LANCZOS)
            out = io.BytesIO()
            cut.save(out, format="PNG", optimize=True)
            return out.getvalue()
    except FaceRejected:
        raise
    except Exception as exc:
        raise FaceRejected(f"could not read that image: {type(exc).__name__}: {exc}") from exc


def put(subject_id: str, blob: bytes) -> dict:
    """Store the seed face for a subject. Returns what the screen needs to show.

    Validate and render before writing so a rejected upload does not replace the current face.
    """
    out = render(blob)
    p = face_path(subject_id)
    vault_fs.mkdir(paths.LORA_FACES)
    vault_fs.write_bytes(p, out)

    # Keep the subject record synchronized for both uploads and generated candidates.
    from .lorasubj import get as _get_subject, save as _save_subject

    s = _get_subject(subject_id)
    if s is not None:
        s.face = f"{subject_id}{FACE_SUFFIX}"
        _save_subject(s)
    return {"subject": subject_id, "px": FACE_PX, "bytes": len(out)}


def get(subject_id: str) -> bytes | None:
    """The stored face, or None. `None` is "no face yet", which is a fact rather than a fault."""
    p = face_path(subject_id)
    return vault_fs.read_bytes(p) if vault_fs.exists(p) else None


def clear(subject_id: str) -> bool:
    p = face_path(subject_id)
    if not vault_fs.exists(p):
        return False
    vault_fs.unlink(p, missing_ok=True)
    return True
