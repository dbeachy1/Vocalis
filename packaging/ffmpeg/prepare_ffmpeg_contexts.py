#!/usr/bin/env python3
"""Prepare the two FFmpeg build contexts (`ffmpeg-source` and `ffmpeg-debs`) in a folder you name.

`packaging/main-cuda/Dockerfile.app` builds FFmpeg 8.0.1 from two named build contexts:

  ffmpeg-source/ffmpeg_8.0.1.orig.tar.xz   the FFmpeg source release
  ffmpeg-debs/<nine .deb files>            the Ubuntu audio packages in main-cuda/ffmpeg-native.lock

This step downloads them from the publishers' addresses recorded in packaging/ffmpeg/build-contract.json
(FFmpeg's release server for the tarball, the Ubuntu archive for the packages) and checks every file's size
and SHA-256 against the records before it keeps the file. Any mismatch stops the step and leaves no
unchecked file behind. Nothing is signed off by trust in the server: the checks are the contract.

    python packaging/ffmpeg/prepare_ffmpeg_contexts.py --output <new folder>

then build with `python packaging/build_main_app.py ... --ffmpeg-contexts <that folder>`.

October 11, 2026. Before this step existed, the two contexts were copied from a private work folder; the
default of build_main_app.py (no --ffmpeg-contexts) is unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "packaging/ffmpeg/build-contract.json"
RUNTIME_LOCK_PATH = REPO_ROOT / "packaging/main-cuda/ffmpeg-native.lock"
SOURCE_CONTEXT = "ffmpeg-source"
DEBS_CONTEXT = "ffmpeg-debs"
CHUNK = 1024 * 1024
TIMEOUT_SECONDS = 120

Fetch = Callable[[str, Path, int], None]


class ContextError(Exception):
    """A file could not be fetched or did not match its record."""


def log(message: str) -> None:
    print(message, flush=True)


def read_runtime_lock(path: Path) -> list[dict[str, object]]:
    """The nine rows of ffmpeg-native.lock: package, version, architecture, file name, bytes, SHA-256."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 6:
            raise ContextError(f"Malformed runtime audio lock row: {line!r}")
        package, version, architecture, filename, byte_count, digest = fields
        rows.append({"package": package, "filename": filename, "bytes": int(byte_count), "sha256": digest})
    return rows


def default_fetch(url: str, destination: Path, limit: int) -> None:
    """Download an https URL to a file, refusing any other scheme and anything larger than `limit` bytes."""
    if not url.startswith("https://"):
        raise ContextError(f"Only https downloads are allowed: {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "vocalis-prepare-ffmpeg-contexts/1"})
    received = 0
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response, destination.open("wb") as output:
        while True:
            block = response.read(CHUNK)
            if not block:
                break
            received += len(block)
            if received > limit:
                raise ContextError(f"Download is larger than its recorded size ({limit} bytes): {url}")
            output.write(block)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_verified(url: str, final: Path, expected_bytes: int, expected_sha256: str, fetch: Fetch) -> dict[str, object]:
    """Download `url` beside `final`, verify size and SHA-256, and only then move it to its final name."""
    partial = final.with_name(final.name + ".partial")
    started = time.monotonic()
    try:
        fetch(url, partial, expected_bytes)
        size = partial.stat().st_size
        digest = sha256_file(partial)
        if size != expected_bytes:
            raise ContextError(f"Size mismatch for {final.name}: got {size}, recorded {expected_bytes} ({url})")
        if digest != expected_sha256:
            raise ContextError(f"SHA-256 mismatch for {final.name}: got {digest}, recorded {expected_sha256} ({url})")
        partial.replace(final)
    except ContextError as exc:
        log(f"REFUSED {final.name}: {exc}")
        raise
    except OSError as exc:
        # urllib's URLError and socket timeouts are OSErrors; say which file and address failed.
        log(f"FAILED {final.name}: {type(exc).__name__}: {exc} ({url})")
        if "CERTIFICATE_VERIFY_FAILED" in str(exc):
            # Seen October 11, 2026 on a Windows host whose certificate store still held the expired Let's
            # Encrypt "R3" intermediate: Python then rejected ffmpeg.org's chain while a browser and curl accepted it.
            # Certificate checking is not relaxed; run the step where the system certificates are current
            # (a Linux Python, for example `docker run --rm python:3.12-slim`).
            log("Hint: the system certificates on this machine rejected the server's certificate chain. "
                "Run this step from Linux or from a python container instead of turning verification off.")
        raise ContextError(f"Download failed for {final.name}: {type(exc).__name__}: {exc}") from exc
    finally:
        if partial.exists():
            partial.unlink()
    elapsed_ms = int((time.monotonic() - started) * 1000)
    log(f"OK {final.name}: {size} bytes, sha256 {digest}, {elapsed_ms} ms ({url})")
    return {"file": final.name, "bytes": size, "sha256": digest, "url": url}


def prepare(output: Path, *, contract_path: Path = CONTRACT_PATH, lock_path: Path = RUNTIME_LOCK_PATH,
            fetch: Fetch = default_fetch) -> dict[str, object]:
    """Create `output` with the two contexts. `output` must not exist or must be an empty folder."""
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    source = contract["source"]
    urls = contract["runtimePackageUrls"]
    rows = read_runtime_lock(lock_path)
    if len(rows) != 9:
        raise ContextError(f"The runtime audio lock must list exactly nine packages, found {len(rows)}")
    missing = sorted(row["filename"] for row in rows if row["filename"] not in urls)
    extra = sorted(set(urls) - {row["filename"] for row in rows})
    if missing or extra:
        raise ContextError(f"build-contract.json runtimePackageUrls differ from the lock (missing={missing}, extra={extra})")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ContextError(f"Refusing to use a folder that already has content: {output}")
    log(f"Preparing FFmpeg contexts in {output}: 1 source archive, {len(rows)} packages")
    started = time.monotonic()
    created = not output.exists()
    source_dir = output / SOURCE_CONTEXT
    debs_dir = output / DEBS_CONTEXT
    source_dir.mkdir(parents=True, exist_ok=True)
    debs_dir.mkdir()
    records = []
    try:
        records.append(fetch_verified(source["url"], source_dir / source["file"], int(source["bytes"]),
                                      source["sha256"], fetch))
        for row in rows:
            records.append(fetch_verified(urls[row["filename"]], debs_dir / str(row["filename"]),
                                          int(row["bytes"]), str(row["sha256"]), fetch))
    except ContextError:
        # Leave no half-prepared folder that a later build could mistake for verified inputs.
        shutil.rmtree(source_dir, ignore_errors=True)
        shutil.rmtree(debs_dir, ignore_errors=True)
        if created:
            shutil.rmtree(output, ignore_errors=True)
        log("Prepared nothing: the folder was cleaned up")
        raise
    elapsed_ms = int((time.monotonic() - started) * 1000)
    log(f"Prepared {len(records)} verified files in {elapsed_ms} ms")
    return {"output": str(output), "files": records, "elapsedMs": elapsed_ms}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--output", required=True, type=Path,
                        help="a new (or empty) folder that will hold ffmpeg-source/ and ffmpeg-debs/")
    args = parser.parse_args(argv)
    try:
        prepare(args.output.resolve())
    except ContextError as exc:
        print(f"prepare_ffmpeg_contexts failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
