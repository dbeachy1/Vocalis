#!/usr/bin/env python3
"""Fetch the public model weights Vocalis needs into /models/vocalis (stdlib only).

setup.sh runs this once per setup/update as a one-shot container of the Vocalis image
(its service user, its /models/vocalis mount); no service, daemon or runtime downloader
is involved. The image is the single authority for which files it needs: it carries this
script, the tracked lock files it reads (the same relative layout as packaging/models/),
and the Chatterbox manifest that tts_utils.py pins by hash. The locks are read as they are;
their status/releaseReady fields are ignored. Design: docs/Vocalis-12.0-Implementation-Design.md
section 5, "Model acquisition by setup".

Rules this script enforces:
- destinations come from the image's own VOCALIS_*_MODEL_* environment values (and LEADVOCAL_MODELS,
  the directory the Lead Vocal feature itself reads), and a revision named in one of those paths
  must equal the lock's revision;
- lock paths must be relative with no ".." and no symlinked component under /models/vocalis;
- an exclusive lock file keeps two setup runs from colliding;
- every URL and every redirect hop must be HTTPS; the idle timeout applies to each read;
- a file already present at the right size and hash is skipped; a present file that does
  not match is never deleted or overwritten, it is reported and the run exits non-zero;
- each download goes to a dot-prefixed temporary name, is verified (size, then SHA-256 or
  the Git blob SHA-1), and only then renamed into place; an interrupted file restarts from
  zero on the next run. On the first failed download the run stops (a dead network would
  otherwise wait out every remaining file) and exits non-zero; finished files are kept.
- (October 9, 2026) a lock may be archive-backed (DeepFilterNet3, whose publisher offers the
  weights only inside one zip): the archive is downloaded only when a member is missing, once,
  to a dot-prefixed temporary name in the destination, verified by size and SHA-256 and never
  renamed into place; only the missing members are read by exact name and written through the
  same checks as a normal download; the archive temporary is deleted on success and failure.
- (October 9, 2026) within one run, a retry after a dropped connection, an idle timeout or a short
  read resumes the file (an archive too) instead of starting over: it asks the same lock URL for
  "Range: bytes=<bytes already in the temporary>-" (the redirect chain and the HTTPS-only rule apply
  to every hop as usual) and appends when the final answer is 206 with a Content-Range whose start is
  the held byte count and whose total is the locked size. Any other answer (200, a mismatched or
  missing Content-Range, 416) discards the partial temporary and restarts that file from zero in the
  same attempt, without using up a retry. The size and hash check at the end covers the whole file.
  Found live: Zenodo dropped the 1.4 GB Trim checkpoint at 1.1 GB and each from-zero retry crawled.
- (October 9, 2026, later) across runs too: a run that stops mid-transfer (last retry failed, Ctrl+C,
  the container killed by a Docker Desktop restart, which happened twice in live testing) leaves the
  partial temporary, and the next run resumes it with the same Range rules. A leftover is kept only
  when it is a regular file named for a still-missing file (or the archive of a missing member) and
  holds more than zero and fewer than the locked bytes; every other leftover is swept. A partial
  that fails verification is deleted, so a damaged one costs one restart, never a bad install.
- (October 9, 2026, later still) reuse of model files already on this machine. setup.sh may mount
  other models folders read-only at /models-seed/<n> and list them, colon-separated, in
  VOCALIS_MODEL_SEEDS. Only entries that match /models-seed/<number> and are real directories are
  used. For each file that is still missing, the seeds are probed in order for the same path below
  the models root (lstat and size only; every component must be a real directory and the file a
  regular file of the locked size). A match is copied through the same exclusive temporary file,
  size and hash check and rename as a download, and a kept partial for that file is discarded first.
  Any trouble on the seed side (permission, I/O error, a path that changed, a wrong hash) makes that
  seed unusable for that file: it is reported once and the next seed, then the publisher, is tried.
  Seeds are never written, nothing is hard-linked (the mounts differ and each instance keeps its own
  files), and a mismatching file in the destination is still never touched. The hash check stays the
  only authority. With no seeds the run is exactly as before.
Nothing outside the models root is ever written.
"""

from __future__ import annotations

import contextlib
import hashlib
import http.client
import json
import os
import re
import shutil
import stat
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path

MODELS_ROOT = "/models/vocalis"
CHATTERBOX_MANIFEST = "/usr/share/vocalis-g1/chatterbox-model-manifest.json"
LOCK_NAME = ".vocalis-fetch.lock"
TEMP_PREFIX = ".vocalis-fetch-"
TEMP_SUFFIX = ".part"
SPARE_BYTES = 1024 ** 3
IDLE_TIMEOUT_SECONDS = 60.0  # per read, not per file: the largest file is 4.8 GB
ATTEMPTS = 3
CHUNK_BYTES = 1024 * 1024
USER_AGENT = "vocalis-model-fetch/1"
CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)")  # the only form a 206 for "Range: bytes=N-" may use
SEEDS_VARIABLE = "VOCALIS_MODEL_SEEDS"  # colon-separated /models-seed/<n> entries, set by setup.sh
SEED_ENTRY = re.compile(r"/models-seed/[0-9]+")  # the only form an entry may take

# Hash fields that hold a SHA-256 whatever the lock calls them, and the Git blob SHA-1 fields.
SHA256_FIELDS = ("sha256", "lfsSha256", "sha256Observed", "observedSha256")
SHA1_FIELDS = ("gitBlobSha1", "publisherGitBlobSha1")
HASH_OBJECTS = ("expectedHash", "expectedContentId")
SHA256_ALGORITHMS = ("sha256", "sha256-lfs")
SHA1_ALGORITHMS = ("git-blob-sha1",)
TRIM_LABELS_NAME = "class_labels_indices.csv"  # the name cleanup.py reads


class Refusal(Exception):
    """A configuration, lock or filesystem problem that makes the run unsafe."""


class DownloadError(Exception):
    """A transfer that did not produce the locked file."""


@dataclass(frozen=True)
class Archive:
    """A zip the publisher offers the files inside of. It is fetched to a temporary name only."""
    model: str
    directory: Path  # the models' destination directory; the temporary archive lives here
    rel: str  # file name taken from the archive URL; the temporary is .vocalis-fetch-<rel>.part
    url: str
    size: int
    algorithm: str  # always "sha256"
    digest: str

    @property
    def path(self) -> Path:
        # Where a normal download would be renamed to; an archive is never renamed into place.
        return self.directory / self.rel


@dataclass(frozen=True)
class Item:
    model: str
    directory: Path  # destination directory the lock path is relative to
    rel: str  # POSIX lock path
    url: str  # for an archive member, the archive's URL (informational; the archive is what is fetched)
    size: int
    algorithm: str  # "sha256" or "git-blob-sha1"
    digest: str
    archive: Archive | None = None
    member: str = ""  # exact name of the file inside the archive

    @property
    def path(self) -> Path:
        return self.directory.joinpath(*self.rel.split("/"))


def say(message: str) -> None:
    print(message, flush=True)


def human(count: int) -> str:
    if count >= 10 ** 9:
        return f"{count / 10 ** 9:.1f} GB"
    if count >= 10 ** 6:
        return f"{count / 10 ** 6:.1f} MB"
    return f"{count} bytes"


# --- reading the locks -------------------------------------------------------------------


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Refusal(f"cannot read lock file {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise Refusal(f"lock file {path} is not a JSON object")
    return data


def env_directory(env, name: str, models_root: str) -> Path:
    value = env.get(name)
    if not value:
        raise Refusal(f"{name} is not set; this script runs inside the Vocalis image")
    path = Path(value)
    root = Path(models_root)
    if not path.is_absolute() or ".." in path.parts or root not in path.parents:
        raise Refusal(f"{name}={value} is not a directory under {models_root}")
    return path


def require_revision(variable: str, directory: Path, revision) -> None:
    if not isinstance(revision, str) or directory.name != revision:
        raise Refusal(f"{variable} names revision {directory.name!r} but its lock is for {revision!r}; "
                      "the image and its model locks disagree")


def lock_path_text(text, model: str) -> str:
    if not isinstance(text, str) or "\\" in text or any(part in ("", ".", "..") for part in text.split("/")):
        raise Refusal(f"{model}: lock path {text!r} is absolute or contains '..'; refusing it")
    return text


def expected_digest(entry: dict, where: str):
    """Pick SHA-256 when any SHA-256 field exists under any lock field name, else the Git blob SHA-1."""
    sha256, sha1 = set(), set()
    for field in SHA256_FIELDS:
        if entry.get(field):
            sha256.add(str(entry[field]).lower())
    for field in SHA1_FIELDS:
        if entry.get(field):
            sha1.add(str(entry[field]).lower())
    for field in HASH_OBJECTS:
        record = entry.get(field)
        if isinstance(record, dict) and record.get("value"):
            algorithm = str(record.get("algorithm", "")).lower()
            if algorithm in SHA256_ALGORITHMS:
                sha256.add(str(record["value"]).lower())
            elif algorithm in SHA1_ALGORITHMS:
                sha1.add(str(record["value"]).lower())
            else:
                raise Refusal(f"{where}: unknown hash algorithm {algorithm!r}")
    if len(sha256) > 1 or len(sha1) > 1:
        raise Refusal(f"{where}: the lock records conflicting hashes")
    if sha256:
        (digest,) = sha256
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise Refusal(f"{where}: malformed SHA-256 {digest!r}")
        return "sha256", digest
    if sha1:
        (digest,) = sha1
        if len(digest) != 40 or any(c not in "0123456789abcdef" for c in digest):
            raise Refusal(f"{where}: malformed Git blob SHA-1 {digest!r}")
        return "git-blob-sha1", digest
    raise Refusal(f"{where}: the lock records no SHA-256 or Git blob SHA-1")


def make_item(model: str, directory: Path, entry: dict, *, rel=None, url=None) -> Item:
    rel = lock_path_text(rel if rel is not None else entry.get("path"), model)
    where = f"{model}/{rel}"
    url = url if url is not None else entry.get("url")
    if not isinstance(url, str) or not url.lower().startswith("https://"):
        raise Refusal(f"{where}: only HTTPS URLs are allowed, got {url!r}")
    size = entry.get("bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise Refusal(f"{where}: missing or invalid byte count")
    algorithm, digest = expected_digest(entry, where)
    return Item(model, directory, rel, url, size, algorithm, digest)


def make_archive_items(model: str, directory: Path, lock: dict) -> list[Item]:
    """The members of an archive-backed lock (archive {url, bytes, sha256}, members [...]) as Items.

    Each member is classified, hashed and installed like any other file; the archive only supplies
    the bytes. The member name is a lookup key into the zip and is never used as a write path.
    """
    spec = lock.get("archive")
    if not isinstance(spec, dict):
        raise Refusal(f"{model}: the lock has no archive section")
    url = spec.get("url")
    if not isinstance(url, str) or not url.lower().startswith("https://"):
        raise Refusal(f"{model}: only HTTPS URLs are allowed, got {url!r}")
    name = lock_path_text(urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1], model)
    size = spec.get("bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise Refusal(f"{model}/{name}: missing or invalid archive byte count")
    algorithm, digest = expected_digest(spec, f"{model}/{name}")
    if algorithm != "sha256":
        raise Refusal(f"{model}/{name}: the archive must be locked by SHA-256")
    archive = Archive(model, directory, name, url, size, algorithm, digest)
    members = lock.get("members")
    if not isinstance(members, list) or not members:
        raise Refusal(f"{model}: the lock has no members")
    items = []
    for entry in members:
        member = entry.get("member") if isinstance(entry, dict) else None
        if not isinstance(member, str) or not member:
            raise Refusal(f"{model}: a lock member has no archive member name")
        item = make_item(model, directory, entry, url=url)
        items.append(Item(model, directory, item.rel, url, item.size, item.algorithm, item.digest, archive, member))
    return items


def build_plan(env, locks_dir: Path, chatterbox_manifest: Path, models_root: str) -> list[Item]:
    """Every file to install, in model order, with all lock/environment refusals applied."""
    plan: list[Item] = []

    manifest = read_json(chatterbox_manifest)
    directory = env_directory(env, "VOCALIS_CHATTERBOX_MODEL_DIR", models_root)
    require_revision("VOCALIS_CHATTERBOX_MODEL_DIR", directory, manifest.get("revision"))
    plan += [make_item("chatterbox", directory, e) for e in manifest.get("files", [])]

    lock = read_json(locks_dir / "voxcpm2" / "model-file-lock.json")
    directory = env_directory(env, "VOCALIS_VOXCPM_MODEL", models_root)
    require_revision("VOCALIS_VOXCPM_MODEL", directory, lock.get("model", {}).get("revision"))
    plan += [make_item("voxcpm2", directory, e) for e in lock.get("selection", {}).get("files", [])]

    # The environment names <revision>/enhancer_stage2 and the lock paths already begin with
    # enhancer_stage2/, so the destination is the parent: the directory is not doubled.
    lock = read_json(locks_dir / "enhance" / "model-files.lock.json")
    stage = env_directory(env, "VOCALIS_ENHANCE_MODEL_DIR", models_root)
    if stage.name != "enhancer_stage2":
        raise Refusal(f"VOCALIS_ENHANCE_MODEL_DIR must end in enhancer_stage2, got {stage.name!r}")
    require_revision("VOCALIS_ENHANCE_MODEL_DIR", stage.parent, lock.get("model", {}).get("revision"))
    plan += [make_item("enhance", stage.parent, e) for e in lock.get("selection", {}).get("files", [])]

    directory = env_directory(env, "VOCALIS_TRIM_MODEL_ROOT", models_root)
    lock = read_json(locks_dir / "trim" / "model-files.lock.json")
    plan += [make_item("trim", directory, e) for e in lock.get("files", [])]
    labels = read_json(locks_dir / "trim" / "class-labels.lock.json")
    plan.append(make_item("trim", directory, labels, rel=TRIM_LABELS_NAME, url=labels.get("source")))

    lock = read_json(locks_dir / "acestep" / "model-file-lock.json")
    directory = env_directory(env, "VOCALIS_ACESTEP_MODEL_DIR", models_root)
    plan += [make_item("acestep", directory, e) for e in lock.get("selection", {}).get("files", [])]

    # DeepFilterNet3 (October 9, 2026): the one archive-backed lock. Its path carries no revision,
    # so the revision-mismatch refusal does not apply to it.
    lock = read_json(locks_dir / "dfn3" / "model-file-lock.json")
    directory = env_directory(env, "VOCALIS_DFN_MODEL_ROOT", models_root)
    plan += make_archive_items("dfn3", directory, lock)

    # HTDemucs and the Lead Vocal set (October 11, 2026; Doug lifted the earlier licensing hold on the
    # same footing as every other model: setup downloads from the publisher, nothing is shipped).
    # Stems: VOCALIS_STEMS_MODEL_ROOT is also the TORCH_HOME the application gives the Demucs child,
    # and the lock path hub/checkpoints/<file> is where torch.hub looks, so Demucs finds the file and
    # never downloads. Lead Vocal: LEADVOCAL_MODELS is the very variable the application and the
    # audio-separator child read as their model directory (one authority, no second name for it).
    lock = read_json(locks_dir / "stems" / "model-file-lock.json")
    directory = env_directory(env, "VOCALIS_STEMS_MODEL_ROOT", models_root)
    plan += [make_item("stems", directory, e) for e in lock.get("files", [])]

    lock = read_json(locks_dir / "leadvocal" / "model-file-lock.json")
    directory = env_directory(env, "LEADVOCAL_MODELS", models_root)
    plan += [make_item("leadvocal", directory, e) for e in lock.get("files", [])]

    seen = set()
    for item in plan:
        if item.path in seen:
            raise Refusal(f"{item.model}: {item.path} is named twice by the locks")
        seen.add(item.path)
        check_no_symlinks(Path(models_root), item.path)
    return plan


def check_no_symlinks(root: Path, target: Path) -> None:
    """Refuse when any existing component between the models root and target is a symlink."""
    current = root
    for part in target.relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise Refusal(f"{current} is a symlink; refusing to write through it")
        if not current.exists():
            return
        if current != target and not current.is_dir():
            raise Refusal(f"{current} exists but is not a directory")


# --- hashing and downloading -------------------------------------------------------------


def new_hasher(item: Item):
    if item.algorithm == "sha256":
        return hashlib.sha256()
    # Git blob object id: sha1(b"blob <size>\0" + content)
    return hashlib.sha1(b"blob %d\0" % item.size)


def hash_file(item: Item) -> str:
    hasher = new_hasher(item)
    with item.path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
            hasher.update(block)
    return hasher.hexdigest()


class HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith("https://"):
            raise Refusal(f"refusing a redirect to a non-HTTPS URL: {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def make_opener(https_handler=None):
    """The transport seam: tests pass an SSL-free https_handler, setup uses the default one."""
    handlers = [HttpsOnlyRedirects()]
    if https_handler is not None:
        handlers.append(https_handler)
    return urllib.request.build_opener(*handlers)


def temporary_path(final: Path) -> Path:
    return final.with_name(TEMP_PREFIX + final.name + TEMP_SUFFIX)


def prepare_destination(models_root: Path, final: Path) -> Path:
    """Symlink-check the destination, create its directory, check again; returns the temporary name."""
    check_no_symlinks(models_root, final)
    final.parent.mkdir(parents=True, exist_ok=True)
    check_no_symlinks(models_root, final)
    return temporary_path(final)


def write_verified(item, read, temporary: Path, *, install: bool, resume_at: int = 0,
                   keep_partial: bool = False) -> None:
    """Stream read() into an exclusive no-follow temporary file, verify size then hash, then (when
    install) rename it into place. One path for a normal download and for an archive member; the
    temporary is removed on any failure. install=False keeps it on success (the archive case).

    resume_at > 0 (October 9, 2026): the temporary already holds that many bytes from an earlier
    attempt of this run. It is reopened without following links, its size must still be resume_at,
    its bytes are re-hashed so the digest covers the whole file, and read() supplies the rest.
    keep_partial: when the transfer stops short for any reason (read() raised, the stream ended
    short, Ctrl+C) with some bytes on disk, leave the temporary for the next attempt or the next run
    to resume. A file that reached the locked length but is wrong (oversize, hash mismatch) is never
    kept, and neither is one this call could not open as the expected partial (written is 0)."""
    final = item.path
    hasher = new_hasher(item)
    written = 0

    try:
        if resume_at:
            flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            try:
                descriptor = os.open(temporary, flags)
            except OSError as exc:
                raise DownloadError(f"cannot reopen the partial file {temporary.name} to resume it: {exc}") from exc
        else:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            descriptor = os.open(temporary, flags, 0o644)
        with os.fdopen(descriptor, "r+b" if resume_at else "wb") as stream:
            if resume_at:
                held = os.fstat(stream.fileno())
                if not stat.S_ISREG(held.st_mode) or held.st_size != resume_at:
                    raise DownloadError(f"the partial file {temporary.name} is {held.st_size} bytes, "
                                        f"expected {resume_at}; not resuming it")
                for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
                    hasher.update(block)
                    written += len(block)
                stream.seek(0, os.SEEK_END)
            for block in iter(lambda: read(CHUNK_BYTES), b""):
                written += len(block)
                if written > item.size:
                    raise DownloadError(f"longer than the locked {item.size} bytes")
                hasher.update(block)
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        if written != item.size:
            raise DownloadError(f"truncated: received {written} of {item.size} bytes")
        if hasher.hexdigest() != item.digest:
            raise DownloadError(f"{item.algorithm} mismatch: got {hasher.hexdigest()}")
        if install:
            if os.path.lexists(final):
                raise Refusal(f"{final} appeared during the download; leaving it untouched")
            os.replace(temporary, final)
    except BaseException:
        # Short of the locked length means the transfer stopped, not that the bytes are wrong: the
        # final check of a later attempt covers them. At or past it, the content itself failed.
        if not (keep_partial and 0 < written < item.size):
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)
        raise


def range_answer(response) -> tuple[int, int] | None:
    """(start, total) from the response's Content-Range, or None when it is absent or not 'bytes a-b/total'."""
    header = response.headers.get("Content-Range") if getattr(response, "headers", None) is not None else None
    match = CONTENT_RANGE.fullmatch(header.strip()) if header else None
    return (int(match.group(1)), int(match.group(3))) if match else None


def discard_partial(temporary: Path) -> None:
    with contextlib.suppress(FileNotFoundError):
        os.unlink(temporary)


def download_once(item, opener, models_root: Path, *, install: bool = True, held: int = 0) -> None:
    """Fetch item.url into its temporary name; an Archive (install=False) is left there, verified.

    held > 0 means an earlier attempt of this run left that many bytes in the temporary: ask for the
    rest with a Range request. Anything but a 206 whose Content-Range starts at held and totals the
    locked size discards the partial file and fetches from zero in this same attempt (a 200 is
    simply used as the whole body; a wrong 206 or a 416 is asked again without Range)."""
    temporary = prepare_destination(models_root, item.path)
    name = f"{item.model}/{item.rel}"
    while True:
        headers = {"User-Agent": USER_AGENT}
        if held:
            headers["Range"] = f"bytes={held}-"
        request = urllib.request.Request(item.url, headers=headers)
        try:
            response_context = opener.open(request, timeout=IDLE_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as exc:
            if not (held and exc.code == 416):
                raise
            exc.close()
            say(f"  {name}: HTTP 416 for the range request at {held} of {item.size} bytes; restarting from zero")
            discard_partial(temporary)
            held = 0
            continue
        with response_context as response:
            if not response.geturl().lower().startswith("https://"):
                raise Refusal(f"refusing a response from a non-HTTPS URL: {response.geturl()}")
            status = getattr(response, "status", 200)
            if held:
                answer = range_answer(response)
                if status == 206 and answer == (held, item.size):
                    say(f"  resuming {name} at {held} of {item.size} bytes")
                    write_verified(item, response.read, temporary, install=install, resume_at=held,
                                   keep_partial=True)
                    return
                say(f"  {name}: the range request at {held} of {item.size} bytes was answered HTTP {status} "
                    f"(Content-Range {answer}); restarting from zero")
                discard_partial(temporary)
                if status != 200:
                    held = 0
                    continue
                # A 200 carries the whole file: use this very response from zero.
            elif status != 200:
                raise DownloadError(f"HTTP status {status}")
            write_verified(item, response.read, temporary, install=install, keep_partial=True)
            return


def extract_members(archive: Archive, items: list[Item], archive_file: Path, models_root: Path) -> None:
    """Install the missing members of a verified archive.

    Only the named members are read, by exact name; the archive is never iterated for writing, so no
    other member, path or link can be created. The recorded size is checked before streaming. A
    member that fails its hash inside an archive that passed its own hash means the lock is wrong,
    so it is reported as such and not retried.
    """
    where = f"{archive.model}/{archive.rel}"
    try:
        with zipfile.ZipFile(archive_file) as bundle:
            for item in items:
                try:
                    info = bundle.getinfo(item.member)
                except KeyError as exc:
                    raise DownloadError(f"{where}: the archive has no member {item.member!r}") from exc
                if info.file_size != item.size:
                    raise DownloadError(f"{where}: member {item.member!r} is {info.file_size} bytes, "
                                        f"the lock says {item.size}")
                say(f"  extracting {item.model}/{item.rel} ({human(item.size)})")
                temporary = prepare_destination(models_root, item.path)
                with bundle.open(info) as source:
                    try:
                        write_verified(item, source.read, temporary, install=True)
                    except DownloadError as exc:
                        raise DownloadError(f"{where}: member {item.member!r} failed its lock inside the "
                                            f"verified archive ({exc}); the lock is wrong, not retrying") from exc
    except (zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error, NotImplementedError) as exc:
        raise DownloadError(f"{where}: cannot read the archive ({type(exc).__name__}: {exc})") from exc


def install_from_archive(archive: Archive, items: list[Item], opener, models_root: Path, sleep,
                         held: int = 0) -> None:
    """Download the archive once (retries and HTTPS rules as for any file), then extract items. A
    download that stops mid-transfer leaves its partial for the next run; once the archive is
    whole, its temporary is deleted whatever extraction does."""
    archive_file = temporary_path(archive.path)
    download(archive, opener, models_root, sleep, install=False, held=held)
    try:
        extract_members(archive, items, archive_file, models_root)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(archive_file)


def partial_size(temporary: Path) -> int:
    """Bytes a failed attempt left in the temporary (0 when none, or when it is not a plain file)."""
    try:
        info = os.lstat(temporary)
    except FileNotFoundError:
        return 0
    if not stat.S_ISREG(info.st_mode):
        os.unlink(temporary)  # not something this script wrote; never resumed, never followed
        return 0
    return info.st_size


def download(item, opener, models_root: Path, sleep, *, install: bool = True, held: int = 0) -> None:
    """Up to ATTEMPTS tries. A try that fails mid-transfer leaves its bytes in the temporary and the next
    try resumes there (October 9, 2026). held > 0: an earlier run left that many bytes, so the first try
    resumes too. When every try fails, a partial write_verified kept stays for the next run; a Refusal
    removes it."""
    temporary = temporary_path(item.path)
    try:
        for attempt in range(1, ATTEMPTS + 1):
            try:
                return download_once(item, opener, models_root, install=install, held=held)
            except Refusal:
                raise
            except (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError,
                    ssl.SSLError, DownloadError) as exc:
                permanent = (isinstance(exc, urllib.error.HTTPError) and 400 <= exc.code < 500
                             and exc.code not in (408, 429))
                if permanent or attempt == ATTEMPTS:
                    raise DownloadError(f"{item.model}/{item.rel}: {exc}") from exc
                held = partial_size(temporary)
                if held >= item.size:
                    discard_partial(temporary)  # nothing left to ask for; a full-length bad file cannot be resumed
                    held = 0
                kept = f"; {held} bytes kept" if held else ""
                say(f"  attempt {attempt} of {ATTEMPTS} failed ({exc}); retrying{kept}")
                sleep(5 * attempt)
    except Refusal:
        discard_partial(temporary)
        raise


# --- local copies (October 9, 2026, later still) -----------------------------------------------


class SeedUnusable(Exception):
    """A local copy that cannot be used for this file; the next source is tried."""


def seed_roots(value: str, is_dir=None) -> list[Path]:
    """The seed directories VOCALIS_MODEL_SEEDS names, in order. Only /models-seed/<number> entries that
    are real (not symlinked) directories are kept; every other entry is reported and ignored."""
    if is_dir is None:
        def is_dir(path):
            return os.path.isdir(path) and not os.path.islink(path)
    roots: list[Path] = []
    for entry in value.split(":"):
        if not entry:
            continue
        if not SEED_ENTRY.fullmatch(entry):
            say(f"ignoring {SEEDS_VARIABLE} entry {entry!r}: it is not /models-seed/<number>")
        elif not is_dir(entry):
            say(f"ignoring {SEEDS_VARIABLE} entry {entry}: it is not a directory")
        elif Path(entry) not in roots:
            roots.append(Path(entry))
    return roots


def seed_probe(seed: Path, relative: Path, size: int) -> tuple[Path | None, str]:
    """(file, '') when seed/relative is a regular file of exactly `size` bytes reached only through real
    directories (lstat; nothing is followed), else (None, why). An empty reason means the file is simply
    not there, which is the ordinary case and is not reported."""
    parts = relative.parts
    current = seed
    try:
        for part in parts[:-1]:
            current = current / part
            mode = os.lstat(current).st_mode
            if stat.S_ISLNK(mode):
                return None, f"{current} is a symlink"
            if not stat.S_ISDIR(mode):
                return None, f"{current} is not a directory"
        current = current / parts[-1]
        info = os.lstat(current)
    except FileNotFoundError:
        return None, ""
    except OSError as exc:
        return None, f"{current} cannot be read ({exc})"
    if stat.S_ISLNK(info.st_mode):
        return None, f"{current} is a symlink"
    if not stat.S_ISREG(info.st_mode):
        return None, f"{current} is not a regular file"
    if info.st_size != size:
        return None, f"{current} is {info.st_size} bytes, expected {size}"
    return current, ""


def seed_candidates(item: Item, root: Path, seeds: list[Path]) -> list[Path]:
    """The seeds, in order, that hold a plausible copy of item (probe only: no read, no hash)."""
    relative = item.path.relative_to(root)
    found = []
    for seed in seeds:
        file, reason = seed_probe(seed, relative, item.size)
        if file is not None:
            found.append(seed)
        elif reason:
            say(f"  seed {seed}: {item.model}/{item.rel}: {reason}; not used")
    return found


def seed_reader(stream):
    """read() for write_verified over a seed file: a read error is the seed's fault, not the target's."""
    def read(size):
        try:
            return stream.read(size)
        except OSError as exc:
            raise SeedUnusable(f"read error: {exc}") from exc
    return read


def copy_from_seeds(item: Item, candidates: list[Path], root: Path) -> bool:
    """Install item from the first usable seed; False when none is. Each seed file goes through the same
    exclusive no-follow temporary, size and hash check and rename as a download (nothing is kept on
    failure or Ctrl+C). Anything wrong on the seed side makes that seed unusable for this file; errors
    writing the target (a full disk, say) are not caught here and fail the run as they do for a download."""
    name = f"{item.model}/{item.rel}"
    relative = item.path.relative_to(root)
    for seed in candidates:
        file, reason = seed_probe(seed, relative, item.size)  # again: the probe was a while ago
        if file is None:
            say(f"  {name}: the local copy under {seed} is no longer usable ({reason or 'it is gone'}); "
                "trying the next source")
            continue
        temporary = prepare_destination(root, item.path)
        discard_partial(temporary)  # a kept partial for a file that is being copied is of no use
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        try:
            descriptor = os.open(file, flags)
        except OSError as exc:
            say(f"  {name}: cannot open the local copy {file} ({exc}); trying the next source")
            continue
        with os.fdopen(descriptor, "rb") as stream:
            try:
                held = os.fstat(stream.fileno())
                if not stat.S_ISREG(held.st_mode) or held.st_size != item.size:
                    raise SeedUnusable(f"it is {held.st_size} bytes or not a regular file, expected {item.size}")
                write_verified(item, seed_reader(stream), temporary, install=True)
            except (SeedUnusable, DownloadError) as exc:
                say(f"  {name}: the local copy {file} is not usable ({exc}); trying the next source")
                continue
        say(f"  {name}: copied from the local copy {file}")
        return True
    return False


# --- filesystem state --------------------------------------------------------------------


@contextlib.contextmanager
def exclusive_lock(path: Path):
    import fcntl  # imported here so the module also loads on a non-POSIX test host

    try:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError as exc:
        raise Refusal(f"cannot open the lock file {path}: {exc}") from exc
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Refusal("another model fetch is already running; wait for it to finish") from exc
        yield
    finally:
        os.close(descriptor)


def resumable_size(temporary: Path, size: int) -> int:
    """Bytes held by a partial download an earlier run left, or 0 when it is not one to resume: it must
    be a regular file (lstat; never followed) holding more than zero and fewer than the locked bytes."""
    try:
        info = os.lstat(temporary)
    except FileNotFoundError:
        return 0
    return info.st_size if stat.S_ISREG(info.st_mode) and 0 < info.st_size < size else 0


def sweep_leftovers(plan: list[Item], wanted: dict[Path, int]) -> tuple[int, dict[Path, int]]:
    """Remove this script's leftover temporaries from earlier runs, except a resumable partial.

    wanted maps the temporary name of each still-missing file (or archive) to its locked size. A
    leftover under one of those names that is a regular file (lstat; never followed) holding more than
    zero and fewer than the locked bytes is kept for resuming. Returns (removed, {temporary: bytes kept})."""
    removed = 0
    kept: dict[Path, int] = {}
    directories = {item.path.parent for item in plan} | {i.archive.path.parent for i in plan if i.archive}
    for directory in sorted(directories):
        if not directory.is_dir():
            continue
        for entry in sorted(directory.iterdir()):
            if not (entry.name.startswith(TEMP_PREFIX) and entry.name.endswith(TEMP_SUFFIX)):
                continue
            if stat.S_ISDIR(os.lstat(entry).st_mode):
                continue
            size = resumable_size(entry, wanted.get(entry, 0))
            if size:
                say(f"keeping the partial download {entry} ({human(size)} of {human(wanted[entry])}) to resume it")
                kept[entry] = size
                continue
            say(f"removing leftover temporary file {entry}")
            entry.unlink()
            removed += 1
    return removed, kept


def classify(item: Item) -> tuple[str, str]:
    """('present'|'missing'|'mismatch', reason). A mismatch is never touched."""
    path = item.path
    if not os.path.lexists(path):
        return "missing", ""
    if path.is_symlink() or not path.is_file():
        return "mismatch", "not a regular file"
    size = path.stat().st_size
    if size != item.size:
        return "mismatch", f"{size} bytes, expected {item.size}"
    if hash_file(item) != item.digest:
        return "mismatch", f"{item.algorithm} differs from the lock"
    return "present", ""


# --- the run -----------------------------------------------------------------------------


def run(env=None, *, models_root: str = MODELS_ROOT, locks_dir=None, chatterbox_manifest=CHATTERBOX_MANIFEST,
        opener=None, sleep=time.sleep, disk_free=lambda path: shutil.disk_usage(path).free, seeds=None) -> int:
    """seeds: a test seam. None reads VOCALIS_MODEL_SEEDS from env (only /models-seed/<number> entries that
    are real directories are used); a list of directories is used as given."""
    env = os.environ if env is None else env
    locks_dir = Path(__file__).resolve().parent if locks_dir is None else Path(locks_dir)
    opener = make_opener() if opener is None else opener
    seeds = seed_roots(env.get(SEEDS_VARIABLE) or "") if seeds is None else [Path(seed) for seed in seeds]
    started = time.monotonic()
    try:
        plan = build_plan(env, locks_dir, Path(chatterbox_manifest), models_root)
        root = Path(models_root)
        if not root.is_dir():
            raise Refusal(f"{models_root} is not a directory; the models mount is missing")
        with exclusive_lock(root / LOCK_NAME):
            return fetch(plan, root, opener, sleep, disk_free, started, seeds)
    except Refusal as exc:
        print(f"ERROR: model fetch refused: {exc}", file=sys.stderr, flush=True)
        return 1


def fetch(plan: list[Item], root: Path, opener, sleep, disk_free, started: float, seeds=()) -> int:
    say(f"Model weights for {root}: {len(plan)} files, {human(sum(i.size for i in plan))} in all.")
    if seeds:
        say("Local model folders searched for missing files, in order: " + ", ".join(str(seed) for seed in seeds) + ".")
    say("Checking files already installed (this re-reads them and can take several minutes)...")
    models = list(dict.fromkeys(item.model for item in plan))
    missing: dict[str, list[Item]] = {}
    mismatches: list[tuple[Item, str]] = []
    wanted: dict[Path, int] = {}  # temporary name of each still-missing file or archive -> locked size
    seeded: dict[Path, list[Path]] = {}  # missing file -> the seeds that hold a plausible copy (probe only)
    present = 0
    total = extracted = to_copy = 0
    for model in models:
        items = [item for item in plan if item.model == model]
        missing[model] = []
        for item in items:
            state, reason = classify(item)
            if state == "missing":
                missing[model].append(item)
                if seeds:
                    found = seed_candidates(item, root, seeds)
                    if found:
                        seeded[item.path] = found
            elif state == "mismatch":
                mismatches.append((item, reason))
            else:
                present += 1
        # A file with a plausible local copy is copied, not downloaded, so it is left out of `wanted`
        # (a kept partial for it is swept) and out of the download numbers. If the copy turns out
        # unusable it falls back to the publisher from zero.
        copying = [i for i in missing[model] if i.path in seeded]
        fetching = [i for i in missing[model] if i.path not in seeded]
        # An archive-backed model downloads its archive once (when any member still needs the publisher)
        # and then extracts those members; the extracted bytes need space but are not downloaded.
        plain = [i for i in fetching if i.archive is None]
        archives = list(dict.fromkeys(i.archive for i in fetching if i.archive))
        todo = 0
        for source in [*plain, *archives]:
            temporary = temporary_path(source.path)
            wanted[temporary] = source.size
            todo += source.size - resumable_size(temporary, source.size)
        extracted += sum(i.size for i in fetching if i.archive)
        copy_bytes = sum(i.size for i in copying)
        to_copy += copy_bytes
        total += todo
        copy_text = f"{len(copying)} to copy from local copies ({human(copy_bytes)}), " if seeds else ""
        if archives:
            say(f"{model}: {len(items)} files, {human(sum(i.size for i in items))}; {copy_text}"
                f"{len(fetching)} to install from an archive download ({human(todo)})")
        else:
            say(f"{model}: {len(items)} files, {human(sum(i.size for i in items))}; {copy_text}"
                f"{len(fetching)} to download ({human(todo)})")
    # Only after classification is it known which files are still missing, so only now can a partial
    # from an earlier run be told apart from a stale leftover.
    removed, held = sweep_leftovers(plan, wanted)
    if seeds:
        say(f"Still to copy from local copies: {human(to_copy)}.")
    say(f"Still to download: {human(total)}.")
    if total or to_copy or extracted:
        # Copied and extracted bytes land in the destination as well; the archive and downloads count once.
        free = disk_free(root)
        if free < total + extracted + to_copy + SPARE_BYTES:
            to_extract = f" and {human(extracted)} to extract" if extracted else ""
            to_copy_text = f" and {human(to_copy)} to copy" if to_copy else ""
            raise Refusal(f"not enough free space in {root}: {human(total)} to download{to_extract}{to_copy_text} "
                          f"plus 1 GiB spare needed, {human(free)} free")

    downloaded = copied = 0
    failure = None
    for model in models:
        if not missing[model]:
            continue
        try:
            remaining = []
            for item in missing[model]:
                if item.path in seeded:
                    say(f"  copying {model}/{item.rel} ({human(item.size)}) from a local copy")
                    if copy_from_seeds(item, seeded[item.path], root):
                        copied += 1
                        continue
                    say(f"  {model}/{item.rel}: no local copy was usable; downloading it")
                remaining.append(item)
            for item in remaining:
                if item.archive is None:
                    say(f"  downloading {model}/{item.rel} ({human(item.size)})")
                    download(item, opener, root, sleep, held=held.get(temporary_path(item.path), 0))
                    downloaded += 1
            for archive in dict.fromkeys(i.archive for i in remaining if i.archive):
                members = [i for i in remaining if i.archive == archive]
                say(f"  downloading {model}/{archive.rel} ({human(archive.size)}) for {len(members)} files")
                install_from_archive(archive, members, opener, root, sleep,
                                     held=held.get(temporary_path(archive.path), 0))
                downloaded += len(members)
        except DownloadError as exc:
            failure = exc
            break
        say(f"{model}: complete")
    elapsed = round(time.monotonic() - started)
    for item, reason in mismatches:
        say(f"MISMATCH {item.path}: {reason}; left untouched")
    copied_text = f", {copied} copied from local copies" if seeds else ""
    if failure is not None:
        say(f"Model fetch FAILED after {downloaded} downloads{copied_text} in {elapsed} s: {failure}. "
            "Finished files and any partial download are kept; run setup again to resume.")
        return 1
    if mismatches:
        say(f"Model fetch INCOMPLETE: {len(mismatches)} existing files do not match their locks and were not "
            "changed. Move or delete them yourself, then run setup again.")
        return 1
    say(f"Model fetch complete: {len(plan)} files verified ({present} already present, {downloaded} "
        f"downloaded{copied_text}, {removed} leftover temporary files removed) in {elapsed} s.")
    return 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        print("usage: fetch_models.py (no arguments; destinations come from the image environment)",
              file=sys.stderr)
        return 2
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
