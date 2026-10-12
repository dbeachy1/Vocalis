#!/usr/bin/env python3
"""Copy embedded license/notice files only for wheel artifacts admitted by a hash lock."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath


PACKAGE_LINE = re.compile(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)")
HASH_LINE = re.compile(r"--hash=sha256:([0-9a-f]{64})")
NORMALIZE = re.compile(r"[-_.]+")
MAX_LICENSE_FILE = 2 * 1024 * 1024


def normalized(name: str) -> str:
    return NORMALIZE.sub("-", name).lower()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_lock(path: Path) -> dict[tuple[str, str], set[str]]:
    packages: dict[tuple[str, str], set[str]] = {}
    current: tuple[str, str] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        match = PACKAGE_LINE.match(line)
        if match:
            current = (normalized(match.group(1)), match.group(2))
            packages[current] = set()
        elif current:
            hash_match = HASH_LINE.search(line)
            if hash_match:
                packages[current].add(hash_match.group(1))
            elif line and not line[:1].isspace() and not line.startswith("#"):
                current = None
    if any(not hashes for hashes in packages.values()):
        raise ValueError(f"every locked distribution must have at least one hash: {path}")
    return packages


def wheel_identity(path: Path) -> tuple[str, str]:
    with zipfile.ZipFile(path) as archive:
        metadata_names = [
            name for name in archive.namelist()
            if name.endswith(".dist-info/METADATA") and len(PurePosixPath(name).parts) == 2
        ]
        if len(metadata_names) != 1:
            raise ValueError(f"expected one wheel METADATA file: {path.name}")
        metadata = archive.read(metadata_names[0]).decode("utf-8", "replace")
    fields: dict[str, str] = {}
    for line in metadata.splitlines():
        if not line or line[0].isspace():
            continue
        key, separator, value = line.partition(":")
        if separator and key in {"Name", "Version"}:
            fields[key] = value.strip()
    if set(fields) != {"Name", "Version"}:
        raise ValueError(f"missing Name/Version metadata: {path.name}")
    return normalized(fields["Name"]), fields["Version"]


def notice_members(archive: zipfile.ZipFile) -> list[str]:
    members = []
    for name in archive.namelist():
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"unsafe wheel member: {name}")
        if name.endswith("/") or ".dist-info" not in "/".join(path.parts[:-1]):
            continue
        leaf = path.name.lower()
        if "licenses" in path.parts or leaf.startswith(("license", "notice", "copying", "copyright")):
            info = archive.getinfo(name)
            if info.file_size > MAX_LICENSE_FILE:
                raise ValueError(f"license member exceeds size bound: {name}")
            members.append(name)
    return sorted(set(members))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", action="append", required=True, type=Path)
    parser.add_argument("--wheelhouse", action="append", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    expected: dict[tuple[str, str], set[str]] = {}
    for lock_path in args.lock:
        for key, hashes in load_lock(lock_path).items():
            expected.setdefault(key, set()).update(hashes)

    wheels = [wheel for root in args.wheelhouse for wheel in sorted(root.glob("*.whl"))]
    found: dict[tuple[str, str], list[tuple[Path, str]]] = {key: [] for key in expected}
    for wheel in wheels:
        identity = wheel_identity(wheel)
        if identity not in expected:
            continue
        digest = file_sha256(wheel)
        if digest in expected[identity]:
            found[identity].append((wheel, digest))

    missing = [key for key, rows in found.items() if not rows]
    if missing:
        raise SystemExit(f"no hash-locked wheel available for: {missing}")

    args.out.mkdir(parents=True, exist_ok=True)
    result = []
    for (name, version), rows in sorted(found.items()):
        for wheel, digest in rows:
            with zipfile.ZipFile(wheel) as archive:
                files = []
                for member in notice_members(archive):
                    data = archive.read(member)
                    target = args.out / f"{name}-{version}" / wheel.name / PurePosixPath(member)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    files.append({"path": target.relative_to(args.out).as_posix(), "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest()})
            result.append({"name": name, "version": version, "wheel": wheel.name,
                           "wheelSha256": digest, "licenseFiles": files})

    manifest = {"schemaVersion": 1, "purpose": "Embedded wheel license/notice members selected from hash-locked component graphs.",
                "distributions": result}
    (args.out / "notice-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    main()
