"""Store LoRA subjects, image provenance, curation state, and built datasets.

Subject metadata, generated images, and datasets use routed encrypted storage, including
filenames. Keep image provenance through reconciliation and Build so results can be traced
to their prompts, workflow, and seed face. Mutations read the current store before writing;
do not cache an empty result from a locked vault.
"""
from __future__ import annotations

import json
import re
import shutil
import threading
import time
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any
from uuid import uuid4

import vault_fs

from . import paths

#: Bounds on one subject. Not policy — a guard on a store that is read whole on every mutation, so
#: one pasted novel does not make every save slow for good.
MAX_NAME = 120
MAX_PROMPT = 4000
MAX_CAPTION = 4000
MAX_SUBJECTS = 200
MAX_IMAGES = 5000
#: Maximum stored length for an imported image's original filename.
MAX_ORIGINAL_NAME = 200

#: The caption that rides beside each kept image. §4.5: *"Captions default to the generating prompt
#: — correct for generated datasets, and the reason no captioning model is needed."*
CAPTION_SUFFIX = ".txt"

#: Image source determines whether the stored prompt already includes the subject identity:
#: generated prompts do, while imported images receive it when Build writes captions.
SOURCE_GENERATED = "generated"
SOURCE_IMPORTED = "imported"


class SubjectStoreCorrupt(RuntimeError):
    """The subject store is malformed; raise rather than overwrite existing data."""


class BuildRefused(RuntimeError):
    """Build was asked to write a dataset it should not write. Carries why, for the UI."""


# ONE lock for the whole file, because the file IS the unit: every mutation is a
# read-modify-write of the entire list, and two writers landing together silently drop one.
_LOCK = threading.RLock()

#: A subject id has to be safe as a DIRECTORY NAME, because the dataset tree is keyed on it. Ids
#: are generated (uuid4 hex), never user-supplied, so this is a belt-and-braces assertion rather
#: than sanitization of hostile input — but it is checked at the one place that joins a path,
#: because "the id is always clean" is exactly the assumption that stops being true later.
_SAFE_ID = re.compile(r"\A[0-9a-f]{8,32}\Z")


@dataclass
class GeneratedImage:
    """One rendered candidate, with everything needed to explain it later.

    `path` points to the original ComfyUI output. Curation is non-destructive; Build copies
    selected images into the dataset.
    """

    id: str
    path: str                        # absolute path in the generation output tree
    seed: str = ""                   # provenance (§3)
    prompt: str = ""                 # provenance, AND the default caption (§4.5)
    workflow: str = ""               # which graph produced it
    from_face: str = ""              # which seed face it came from
    caption: str = ""                # empty means "use `prompt`" — see `caption_for`
    keep: bool = True                # Curate's toggle; §4.5's "43 of 50 kept"
    #: Defaults to generated so records created before source tracking keep their meaning.
    source: str = SOURCE_GENERATED
    #: Original filename for imported images, or empty when unavailable. Provenance is not used
    #: as training caption text.
    original_name: str = ""
    created_at: float = dc_field(default_factory=lambda: time.time())

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "path": self.path, "seed": self.seed, "prompt": self.prompt,
                "workflow": self.workflow, "from_face": self.from_face,
                "caption": self.caption, "keep": bool(self.keep), "source": self.source,
                "original_name": self.original_name,
                "created_at": self.created_at}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> GeneratedImage:
        return cls(
            id=str(d.get("id") or uuid4().hex[:12]),
            path=str(d.get("path") or ""),
            seed=str(d.get("seed") or ""),
            prompt=str(d.get("prompt") or "")[:MAX_PROMPT],
            workflow=str(d.get("workflow") or ""),
            from_face=str(d.get("from_face") or ""),
            caption=str(d.get("caption") or "")[:MAX_CAPTION],
            # Missing `keep` defaults to true so older or partial records do not silently exclude
            # an image from training.
            keep=bool(d.get("keep", True)),
            # Only the two known source values affect caption composition; normalize other values.
            source=(SOURCE_IMPORTED if str(d.get("source") or "") == SOURCE_IMPORTED
                    else SOURCE_GENERATED),
            # Older records and generated images have no original upload filename.
            original_name=str(d.get("original_name") or "")[:MAX_ORIGINAL_NAME],
            created_at=float(d.get("created_at") or time.time()),
        )

    def caption_for(self) -> str:
        """The caption this image ships with: its own, else the prompt that generated it (§4.5).

        Imported captions contain only the varying text; `build()` adds subject identity.
        """
        return (self.caption or self.prompt or "").strip()


@dataclass
class Subject:
    """One person the LoRA will learn. §3's noun, with the fields that hang off it."""

    id: str
    name: str                                    # the trigger word
    face: str = ""                               # the seed face, as a stored asset name
    #: Subject-specific description prepended to prompts and captions during composition.
    identity: str = ""
    prompts: list = dc_field(default_factory=list)
    images: list = dc_field(default_factory=list)   # list[GeneratedImage]
    runs: list = dc_field(default_factory=list)
    created_at: float = dc_field(default_factory=lambda: time.time())
    updated_at: float = dc_field(default_factory=lambda: time.time())

    def kept(self) -> list:
        return [im for im in self.images if im.keep]

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "face": self.face, "identity": self.identity,
                "prompts": list(self.prompts or []),
                "images": [im.to_dict() for im in self.images],
                "runs": list(self.runs or []),
                "created_at": self.created_at, "updated_at": self.updated_at}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Subject:
        raw = d.get("images")
        images = [GeneratedImage.from_dict(x) for x in raw if isinstance(x, dict)] \
            if isinstance(raw, list) else []
        return cls(
            id=str(d.get("id") or uuid4().hex[:12]),
            name=str(d.get("name") or "")[:MAX_NAME],
            face=str(d.get("face") or ""),
            identity=str(d.get("identity") or "")[:MAX_PROMPT],
            prompts=[str(p)[:MAX_PROMPT] for p in (d.get("prompts") or []) if isinstance(p, str)],
            images=images,
            runs=list(d.get("runs") or []),
            created_at=float(d.get("created_at") or time.time()),
            updated_at=float(d.get("updated_at") or time.time()),
        )


def _path() -> Path:
    return paths.LORA_SUBJECTS


def _read() -> list[Subject]:
    """Every subject, or `[]` when the file does not exist yet.

    A missing file means "none yet" and is a fact. Corrupt raises. A locked vault also raises,
    from `vault_fs.read_text`, and that is the point — see the module docstring.
    """
    p = _path()
    if not vault_fs.exists(p):
        return []
    try:
        data = json.loads(vault_fs.read_text(p))
    except json.JSONDecodeError as exc:
        raise SubjectStoreCorrupt(f"{p} is not valid JSON: {exc}") from exc
    items = data.get("subjects") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise SubjectStoreCorrupt(f"{p} has no 'subjects' list")
    return [Subject.from_dict(d) for d in items if isinstance(d, dict)]


def _write(items: list[Subject]) -> None:
    vault_fs.write_json_atomic(_path(), {"subjects": [s.to_dict() for s in items]}, indent=2)


def list_subjects() -> list[Subject]:
    with _LOCK:
        return _read()


def get(subject_id: str) -> Subject | None:
    with _LOCK:
        return next((s for s in _read() if s.id == subject_id), None)


def create(name: str) -> Subject:
    with _LOCK:
        items = _read()
        if len(items) >= MAX_SUBJECTS:
            raise ValueError(f"at most {MAX_SUBJECTS} subjects")
        s = Subject(id=uuid4().hex[:12], name=(name or "").strip()[:MAX_NAME])
        items.append(s)
        _write(items)
        return s


def save(subject: Subject) -> Subject:
    """Replace one subject wholesale. Raises if it is not there — a save that silently becomes an
    insert is how a delete race turns into a resurrected row."""
    with _LOCK:
        items = _read()
        for i, s in enumerate(items):
            if s.id == subject.id:
                subject.updated_at = time.time()
                items[i] = subject
                _write(items)
                return subject
        raise KeyError(subject.id)


def delete(subject_id: str) -> bool:
    with _LOCK:
        items = _read()
        rest = [s for s in items if s.id != subject_id]
        if len(rest) == len(items):
            return False
        _write(rest)
        return True


def set_caption(subject_id: str, image_id: str, caption: str) -> str:
    """Store the varying caption text and return it. Build adds the current identity block.

    An empty caption is meaningful: it leaves only the identity block in the built caption.
    """
    with _LOCK:
        items = _read()
        s = next((x for x in items if x.id == subject_id), None)
        if s is None:
            raise KeyError(subject_id)
        im = next((x for x in s.images if x.id == image_id), None)
        if im is None:
            raise KeyError(image_id)
        im.caption = (caption or "").strip()[:MAX_CAPTION]
        s.updated_at = time.time()
        _write(items)
        return im.caption


def set_keep(subject_id: str, image_ids: list, keep: bool) -> int:
    """Curate's toggle, applied to N images at once (click, space, shift+click range all land here).

    Returns how many actually changed, so the UI can report "43 of 50 kept" from the store rather
    than from its own idea of what it just did.
    """
    with _LOCK:
        items = _read()
        s = next((x for x in items if x.id == subject_id), None)
        if s is None:
            raise KeyError(subject_id)
        wanted = set(image_ids or [])
        n = 0
        for im in s.images:
            if im.id in wanted and bool(im.keep) != bool(keep):
                im.keep = bool(keep)
                n += 1
        if n:
            s.updated_at = time.time()
            _write(items)
        return n


#: A generated image's filename, `p<prompt index>_<seq>.png` — see `loragen.GenJob.filename`.
_GEN_NAME = re.compile(r"^p(\d{3})_(\d{2})\.png$")


def reconcile_images(subject_id: str) -> int:
    """Register on-disk images missing from the subject store; return the count added.

    The directory is authoritative so resumed runs are included. Reconciliation is add-only:
    missing files do not erase curation state, and ids derived from filenames make repeat passes
    idempotent.
    """
    from . import flux2
    from .loragen import out_dir
    from .loraimport import is_imported_name, read_original
    from .loraprompts import compose
    with _LOCK:
        items = _read()
        s = next((x for x in items if x.id == subject_id), None)
        if s is None:
            raise KeyError(subject_id)
        d = out_dir(subject_id)
        if not vault_fs.exists(d):
            return 0
        known = {im.id for im in s.images}
        known |= {Path(im.path).name.rsplit(".", 1)[0] for im in s.images if im.path}
        added = 0
        for name in sorted(vault_fs.glob(d, "*.png")):
            img_id = name.rsplit(".", 1)[0]
            if img_id in known:
                continue
            # Imported filenames use a distinct pattern from generated images, allowing both
            # sources to share this directory without id collisions.
            if is_imported_name(name):
                # Imported images have no generation prompt, workflow, or seed face. Keep the
                # original filename as separate provenance and tolerate missing sidecars.
                s.images.append(GeneratedImage(id=img_id, path=str(d / name),
                                               source=SOURCE_IMPORTED,
                                               original_name=read_original(d, name)))
                added += 1
                continue
            m = _GEN_NAME.match(name)
            idx = int(m.group(1)) if m else -1
            raw = s.prompts[idx] if 0 <= idx < len(s.prompts) else ""
            # Preserve the composed prompt and workflow/face references used to generate the image.
            s.images.append(GeneratedImage(id=img_id, path=str(d / name),
                                           prompt=compose(s.identity, raw)[:MAX_PROMPT],
                                           workflow=flux2.GRAPH_PATH.name, from_face=s.face))
            added += 1
        if added:
            s.updated_at = time.time()
            _write(items)
        return added


def dataset_dir(subject_id: str) -> Path:
    """Where this subject's built dataset lives. Routed, therefore encrypted (module docstring)."""
    if not _SAFE_ID.match(subject_id or ""):
        # Checked at the one place that joins a path. Ids are generated, so this should be
        # unreachable — which is exactly why it is asserted rather than assumed.
        raise ValueError(f"unsafe subject id for a directory name: {subject_id!r}")
    return paths.LORA_DATASETS / subject_id


def dataset_size(subject_id: str) -> int:
    """How many images a subject's BUILT dataset holds, read from disk.

    Count dataset images on disk because training consumes that directory. Exclude caption sidecars,
    which share image stems but are not training images.
    """
    try:
        names = vault_fs.glob(dataset_dir(subject_id), "*")
    except (OSError, ValueError):
        return 0
    return sum(1 for n in names if not n.lower().endswith(CAPTION_SUFFIX))


def caption_for_dataset(subject: Subject, im: GeneratedImage) -> str:
    """Return the caption written beside an image, with the current identity block.

    Generated prompts already include identity when registered. Use them unchanged when no
    caption override exists; otherwise compose the identity with the current caption. Imported
    images always compose identity at Build time so edits apply on rebuild.
    """
    from .loraprompts import compose

    if im.source == SOURCE_GENERATED and not (im.caption or "").strip():
        # The one case where the text already carries the block. Untouched, or it appears twice.
        return im.caption_for()
    return compose(subject.identity, im.caption_for())


def build(subject_id: str) -> dict[str, Any]:
    """Write every kept image and caption into the routed dataset directory.

    Copy image bytes without re-encoding to preserve embedded metadata. Keep source images
    untouched, write the new dataset before sweeping stale output, and return a per-build report.
    """
    with _LOCK:
        # Include images from a generation that completed since the store was last read.
        reconcile_images(subject_id)
        s = get(subject_id)
        if s is None:
            raise KeyError(subject_id)

        kept = s.kept()
        if not kept:
            # A dataset of zero images trains into nothing and takes hours to prove it.
            raise BuildRefused("nothing is kept - curate at least one image before building")

        out = dataset_dir(s.id)
        vault_fs.mkdir(out)

        written: list[str] = []
        missing: list[str] = []
        for n, im in enumerate(kept, 1):
            src = Path(im.path)
            # Use `vault_fs` for routed generation paths; direct filesystem checks see encrypted
            # names and would incorrectly report every source as missing.
            if not vault_fs.exists(src):
                # The generation tree is not ours and images can be swept from under us. Report
                # it; do not abort a build that is otherwise fine, and do not write a caption for
                # an image that is not there.
                missing.append(im.path)
                continue
            stem = f"{n:04d}_{im.id}"
            dst = out / f"{stem}{src.suffix.lower()}"
            # Still a byte-for-byte copy — `read_bytes` decrypts on the way in and
            # `write_bytes` re-encrypts on the way out, and neither touches the pixels.
            # The no-re-encode rule is about IMAGE codecs, not about the vault.
            vault_fs.write_bytes(dst, vault_fs.read_bytes(src))
            # `caption_for_dataset` handles the generated/imported identity-block distinction.
            vault_fs.write_text(out / f"{stem}{CAPTION_SUFFIX}", caption_for_dataset(s, im))
            written.append(dst.name)

        _sweep(out, keep={*written, *(f"{Path(w).stem}{CAPTION_SUFFIX}" for w in written)})

        return {"subject": s.id, "name": s.name, "dir": str(out),
                "images": len(written), "captions": len(written),
                "missing": missing, "kept_total": len(kept)}


def _sweep(out: Path, keep: set) -> int:
    """Delete files from a previous build that this build did not write; return the count removed.

    `vault_fs.glob()` returns names relative to `out`; join each name to that directory before
    deleting it.
    """
    gone = 0
    for name in vault_fs.glob(out, "*"):
        if name not in keep:
            vault_fs.unlink(out / name, missing_ok=True)
            gone += 1
    return gone
