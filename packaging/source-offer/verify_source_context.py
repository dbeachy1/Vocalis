#!/usr/bin/env python3
"""Verify the named source context, its deterministic ZIP and generated page."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path, PurePosixPath


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_inventory(root: Path) -> set[str]:
    """Return every regular file beneath a context root, rejecting links and escapes."""
    if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()):
        raise ValueError("Source context root must not be a symlink or reparse point")
    root = root.resolve(strict=True)
    paths: set[str] = set()
    for directory, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        base = Path(directory)
        for name in [*dirnames, *filenames]:
            item = base / name
            if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
                raise ValueError(f"Symlink or reparse point is not allowed in source context: {item.relative_to(root).as_posix()}")
            resolved = item.resolve(strict=True)
            if not resolved.is_relative_to(root):
                raise ValueError(f"Source context path escapes its root: {item.relative_to(root).as_posix()}")
        for name in filenames:
            item = base / name
            if not item.is_file():
                raise ValueError(f"Non-regular file in source context: {item.relative_to(root).as_posix()}")
            paths.add(item.relative_to(root).as_posix())
    return paths


def verify(payload: Path, artifacts: Path) -> dict[str, object]:
    payload_inventory = checked_inventory(payload)
    artifacts_inventory = checked_inventory(artifacts)
    allowlist = json.loads((payload / "packaging/source-offer/allowlist.json").read_text(encoding="utf-8"))
    offer = json.loads((payload / "packaging/source-offer/source-offer.json").read_text(encoding="utf-8"))
    manifest = json.loads((artifacts / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("productVersion") != offer.get("productVersion"):
        raise ValueError("Unsupported source manifest")
    expected_archive = f"vocalis-{offer['productVersion']}-source.zip"
    archive_record = manifest.get("archive")
    if (not isinstance(archive_record, dict)
        or Path(archive_record.get("file", "")).name != archive_record.get("file")
        or archive_record.get("file") != expected_archive):
        raise ValueError("Unsafe archive identity")
    # October 11, 2026: a source material may name a file the page serves beside itself (the license notices); it
    # must be a plain file name, and it is a byte-for-byte copy of the same file in the archive (checked below).
    served_files = {}
    for material in offer.get("separateSourceMaterials", []):
        if isinstance(material, dict) and material.get("servedFile"):
            served = material["servedFile"]
            if not isinstance(served, str) or Path(served).name != served or served in {"index.html", "manifest.json"}:
                raise ValueError(f"Unsafe served file name: {served!r}")
            served_files[served] = material.get("archivePath")
    expected_artifacts = {"index.html", "manifest.json", archive_record["file"], *served_files}
    if artifacts_inventory != expected_artifacts:
        raise ValueError("Generated artifact context does not match the source manifest")
    archive_path = artifacts / archive_record["file"]
    archive_bytes = archive_path.read_bytes()
    if len(archive_bytes) != archive_record.get("size") or sha256(archive_bytes) != archive_record.get("sha256"):
        raise ValueError("Source archive identity mismatch")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) != manifest.get("selectedFileCount"):
        raise ValueError("Invalid source file inventory")
    expected_paths = [entry.get("path") for entry in files]
    if expected_paths != sorted(set(expected_paths), key=lambda name: name.encode("utf-8")):
        raise ValueError("Source file inventory is not uniquely sorted")
    if allowlist.get("schemaVersion") != 1 or expected_paths != allowlist.get("files"):
        raise ValueError("Source manifest differs from its embedded explicit allowlist")
    if set(expected_paths) != payload_inventory:
        missing = sorted(set(expected_paths) - payload_inventory)
        extra = sorted(payload_inventory - set(expected_paths))
        raise ValueError(f"Named-context paths differ from manifest (missing={len(missing)}, extra={len(extra)})")
    expected_zip_paths = ["SOURCE-MANIFEST.json", *expected_paths]
    internal = {key: value for key, value in manifest.items() if key != "archive"}
    if (manifest.get("componentLicenseScopes") != offer.get("componentLicenseScopes")
        or manifest.get("separateSourceMaterials") != offer.get("separateSourceMaterials")):
        raise ValueError("Manifest licensing/source materials differ from the frozen offer metadata")
    for scope in offer.get("componentLicenseScopes", []):
        license_file = scope.get("licenseFile") if isinstance(scope, dict) else None
        if not isinstance(license_file, str) or license_file not in expected_paths:
            raise ValueError(f"License scope file is not included in the source offer: {license_file!r}")
    with zipfile.ZipFile(archive_path, "r") as archive:
        names = archive.namelist()
        if names != expected_zip_paths:
            raise ValueError("Archive entries do not match the frozen file inventory")
        if archive.read("SOURCE-MANIFEST.json") != canonical_json(internal):
            raise ValueError("Embedded source manifest differs from the external manifest")
        for entry in files:
            relative = entry["path"]
            parsed = PurePosixPath(relative)
            if parsed.is_absolute() or any(part in {"", ".", ".."} for part in parsed.parts) or "\\" in relative:
                raise ValueError(f"Unsafe archive path: {relative}")
            payload_file = payload.joinpath(*parsed.parts)
            data = payload_file.read_bytes()
            if len(data) != entry["size"] or sha256(data) != entry["sha256"]:
                raise ValueError(f"Named-context payload mismatch: {relative}")
            archived = archive.read(relative)
            if len(archived) != entry["size"] or sha256(archived) != entry["sha256"]:
                raise ValueError(f"Source ZIP member mismatch: {relative}")
    for served, archived in served_files.items():
        if archived not in expected_paths:
            raise ValueError(f"Served file {served} names an archive path that is not in the source offer: {archived!r}")
        if (artifacts / served).read_bytes() != payload.joinpath(*PurePosixPath(archived).parts).read_bytes():
            raise ValueError(f"Served file {served} differs from {archived} in the source archive")
    page = (artifacts / "index.html").read_text(encoding="utf-8")
    if (f"{offer['product']} {offer['productVersion']}" not in page
        or manifest["sourceRevision"] not in page
        or f"/source/{archive_record['file']}" not in page
        or archive_record["sha256"] not in page
        or any(f"/source/{served}" not in page for served in served_files)):
        raise ValueError("Source page does not correspond to the manifest")
    return {"filesVerified": len(files), "archiveSha256": archive_record["sha256"], "sourceRevision": manifest["sourceRevision"],
            "servedFiles": sorted(served_files)}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verify_source_context.py PAYLOAD_DIR ARTIFACT_DIR")
    print(json.dumps(verify(Path(sys.argv[1]), Path(sys.argv[2])), sort_keys=True))
