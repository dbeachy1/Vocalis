"""Import an existing image dataset into the LoRA Studio curation workflow.

Imports share the generated-image directory but use a distinct filename pattern to avoid
collisions. Preserve aspect ratio and framing, scaling only images above the configured edge
limit; convert to PNG because the curation index scans PNG files.
"""
from __future__ import annotations

import io
import json
import re
from pathlib import Path
from uuid import uuid4

import vault_fs

#: The id prefix that marks an imported image, and the reason it is `i_` rather than anything
#: containing a digit: `lorasubj._GEN_NAME` anchors on `p` followed by three digits, so any name
#: starting with a letter other than `p` is structurally unable to collide.
IMPORT_PREFIX = "i_"

#: Twelve hex characters, matching `uuid4().hex[:12]` — the same width `GeneratedImage.from_dict`
#: already uses when it has to invent an id.
IMPORT_ID_HEX = 12

IMPORT_SUFFIX = ".png"

#: `^i_[0-9a-f]{12}\.png$`. Used by `lorasubj.reconcile_images()` to tell an imported file from a
#: generated one when it meets it on disk for the first time.
IMPORTED_NAME = re.compile(r"^i_[0-9a-f]{" + str(IMPORT_ID_HEX) + r"}\.png$")

#: Per-image provenance stored beside each imported PNG. Directory reconciliation can recover
#: imported files independently of process state, and one sidecar per image avoids a shared
#: manifest write racing across concurrent imports. Sidecars use a non-PNG suffix so image
#: listings that glob `*.png` do not expose them.
SIDECAR_SUFFIX = ".json"

#: A decompression-bomb ceiling, the same number and the same reason as `loraface.MAX_PIXELS`:
#: Pillow's own default warns near 89 Mpx, and decoding something larger holds well over a
#: gigabyte of RGBA in the server process.
MAX_PIXELS = 64_000_000

#: The long edge after normalization. See the module docstring — this preserves aspect ratio and
#: therefore framing, which is the thing the design protects; it is not a crop. 2048 is twice the
#: `quality` preset's 1024 training resolution, so it leaves headroom for a higher-res preset
#: without storing anything a trainer would use.
MAX_EDGE = 2048

#: Below this on the short edge an image cannot contribute to a 512 or 1024 training run without
#: being upscaled into mush. A favicon, a chat avatar or a thumbnail scraped from a page lands
#: here, and the report says so rather than letting it quietly weaken the set.
MIN_EDGE = 256

#: Bounds on one import call. Neither is policy — §6 says 50 images is the sweet spot and 100 is
#: past the point of diminishing returns, so 500 is a guard against a whole photo library being
#: dragged in by accident, not a considered maximum.
MAX_FILES = 500
MAX_BYTES = 64 * 1024 * 1024


class ImportRejected(RuntimeError):
    """One file is not usable as a dataset image. Carries why, for the screen to show.

    Carries a per-file rejection reason so one invalid upload does not hide other results.
    """


def new_name() -> str:
    """A fresh imported filename. Unique, and structurally unable to collide with `_GEN_NAME`."""
    return f"{IMPORT_PREFIX}{uuid4().hex[:IMPORT_ID_HEX]}{IMPORT_SUFFIX}"


def is_imported_name(name: str) -> bool:
    """Whether a filename in the generation tree was written by this module."""
    return bool(IMPORTED_NAME.match(str(name)))


def sidecar_name(image_name: str) -> str:
    """The provenance sidecar's filename for an imported image. Same stem, `.json` instead."""
    return Path(str(image_name)).stem + SIDECAR_SUFFIX


def read_original(directory, image_name: str) -> str:
    """The name this image was uploaded under, or `""` if that is not knowable (10.0-m5).

    Missing or malformed provenance returns `""` so it cannot prevent image reconciliation.
    Vault lock errors are also treated as unknown metadata; write paths still propagate them.
    """
    from .lorasubj import MAX_ORIGINAL_NAME

    p = Path(directory) / sidecar_name(image_name)
    try:
        if not vault_fs.exists(p):
            return ""
        raw = json.loads(vault_fs.read_bytes(p).decode("utf-8"))
    # The vault lock exception derives from BaseException, so handle it separately.
    except vault_fs.locked_exc():
        return ""
    except (OSError, ValueError, UnicodeDecodeError):
        return ""
    if not isinstance(raw, dict):
        return ""
    return str(raw.get("original") or "")[:MAX_ORIGINAL_NAME]


def normalize(blob: bytes) -> bytes:
    """Upload bytes in, an RGB PNG out, framing preserved.

    Raises `ImportRejected` for anything Pillow objects to, so the screen can say what happened.

    Preserve framing and aspect ratio; scale only when the long edge exceeds `MAX_EDGE`.
    """
    if not blob:
        raise ImportRejected("the file is empty")
    if len(blob) > MAX_BYTES:
        raise ImportRejected(
            f"the file is {len(blob) // (1024 * 1024)} MB, over the {MAX_BYTES // (1024 * 1024)} MB limit")

    try:
        from PIL import Image
    except ImportError as exc:                # pragma: no cover — Pillow is a declared dependency
        raise ImportRejected(f"Pillow is not available: {exc}") from exc

    try:
        with Image.open(io.BytesIO(blob)) as im:
            if im.width * im.height > MAX_PIXELS:
                raise ImportRejected(
                    f"that image is {im.width}x{im.height}, which is too large to process")
            im.load()
            if min(im.width, im.height) < MIN_EDGE:
                raise ImportRejected(
                    f"that image is {im.width}x{im.height}; the short edge must be at least "
                    f"{MIN_EDGE}px to be worth training on")

            # Convert palette images before resizing so Pillow resamples pixel colors, not indices.
            out_im = im
            if out_im.mode != "RGB":
                # RGB, not RGBA: the trainer wants three channels. Alpha is flattened onto white
                # rather than dropped, so a cut-out PNG does not arrive with black behind it.
                if "A" in out_im.getbands():
                    bg = Image.new("RGB", out_im.size, (255, 255, 255))
                    rgba = out_im.convert("RGBA")
                    bg.paste(rgba, mask=rgba.split()[-1])
                    out_im = bg
                else:
                    out_im = out_im.convert("RGB")

            long_edge = max(out_im.width, out_im.height)
            if long_edge > MAX_EDGE:
                scale = MAX_EDGE / long_edge
                # `round`, and a floor of 1, so a panorama cannot scale its short edge to zero.
                size = (max(1, round(out_im.width * scale)), max(1, round(out_im.height * scale)))
                out_im = out_im.resize(size, Image.LANCZOS)

            buf = io.BytesIO()
            out_im.save(buf, format="PNG", optimize=True)
            return buf.getvalue()
    except ImportRejected:
        raise
    # Translate expected decoder/input failures to per-file validation errors; unexpected
    # exceptions remain visible as implementation failures.
    except (OSError, ValueError, TypeError, SyntaxError, MemoryError,
            Image.DecompressionBombError) as exc:
        raise ImportRejected(f"could not read that image: {type(exc).__name__}: {exc}") from exc


def put(subject_id: str, files) -> dict:
    """Normalize and store many images for a subject, then register them.

    `files` is a sequence of `(display_name, blob)`. Returns a report:

        {"subject": id, "written": [names], "rejected": [{"name", "why"}], "added": n}

    Normalize each file independently and report every accepted or rejected upload. Reconcile
    once after the batch to avoid repeated whole-store updates.
    """
    from .loragen import out_dir
    from .lorasubj import MAX_ORIGINAL_NAME, get as _get_subject, reconcile_images

    if _get_subject(subject_id) is None:
        raise KeyError(subject_id)

    items = list(files or [])
    if not items:
        raise ImportRejected("no files were uploaded")
    if len(items) > MAX_FILES:
        raise ImportRejected(f"{len(items)} files at once is over the limit of {MAX_FILES}")

    d = out_dir(subject_id)
    vault_fs.mkdir(d)

    written: list[str] = []
    rejected: list[dict] = []
    for display, blob in items:
        label = Path(str(display or "")).name or "(unnamed)"
        try:
            png = normalize(blob)
        except ImportRejected as exc:
            rejected.append({"name": label, "why": str(exc)})
            continue
        name = new_name()
        vault_fs.write_bytes(d / name, png)
        # Write provenance after the image so a failed image write cannot leave an orphan sidecar.
        # The sidecar is routed through the encrypted store because it contains the source filename.
        vault_fs.write_bytes(d / sidecar_name(name),
                             json.dumps({"original": label[:MAX_ORIGINAL_NAME]}).encode("utf-8"))
        written.append(name)

    added = reconcile_images(subject_id) if written else 0
    return {"subject": subject_id, "written": written, "rejected": rejected, "added": added}
