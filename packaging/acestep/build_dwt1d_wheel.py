"""Build the pinned Vocalis DWT1D subset as a pure-Python wheel.

The builder copies only the source files listed in the source lock, writes the
derived runtime version and wheel metadata, and records every wheel member in
RECORD. It never installs or imports the upstream mixed-provenance wheel.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import zipfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "dwt1d-source"
SOURCE_LOCK = HERE / "dwt1d-source-artifact.lock.json"
DERIVATION = HERE / "dwt1d-derivation.md"
DIST_NAME = "pytorch-wavelets"
DIST_VERSION = "1.3.0+vocalis.dwt1d.1"
WHEEL_NAME = "pytorch_wavelets-1.3.0+vocalis.dwt1d.1-py3-none-any.whl"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record_digest(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={encoded.decode('ascii')}"


def wheel_metadata() -> bytes:
    content = "\n".join(
        (
            "Metadata-Version: 2.4",
            f"Name: {DIST_NAME}",
            f"Version: {DIST_VERSION}",
            "Summary: Vocalis DWT1D subset derived from pytorch-wavelets 1.3.0",
            "License-Expression: MIT",
            "License-File: licenses/LICENSE",
            "Requires-Python: >=3.8",
            "Requires-Dist: numpy",
            "Requires-Dist: PyWavelets",
            "Requires-Dist: torch",
            "Project-URL: Upstream, https://github.com/fbcotter/pytorch_wavelets",
            "",
            "This distribution contains only the licensed DWT1D transform code.",
            "See licenses/DERIVATION.md for the exact allowlist and changes.",
            "",
        )
    )
    return content.encode("utf-8")


def zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    return info


def build(output_dir: Path) -> Path:
    source_lock = json.loads(SOURCE_LOCK.read_text(encoding="utf-8"))
    expected = source_lock["included_files"]
    package_root = SOURCE / "pytorch_wavelets"
    actual_paths = {p.relative_to(package_root).as_posix() for p in package_root.rglob("*") if p.is_file()}
    if actual_paths != set(expected):
        raise ValueError(f"source allowlist mismatch: expected={sorted(expected)}, actual={sorted(actual_paths)}")

    members: dict[str, bytes] = {}
    for relative, expected_hash in expected.items():
        source_path = package_root / Path(relative)
        source_bytes = source_path.read_bytes()
        if digest(source_bytes) != expected_hash:
            raise ValueError(f"source hash mismatch: {relative}")
        wheel_bytes = source_bytes
        if relative == "_version.py":
            wheel_bytes = b"__version__ = '1.3.0+vocalis.dwt1d.1'\n"
        members[f"pytorch_wavelets/{relative}"] = wheel_bytes

    dist_info = "pytorch_wavelets-1.3.0+vocalis.dwt1d.1.dist-info"
    members[f"{dist_info}/METADATA"] = wheel_metadata()
    members[f"{dist_info}/WHEEL"] = (
        "Wheel-Version: 1.0\nGenerator: vocalis-dwt1d-wheel-builder\n"
        "Root-Is-Purelib: true\nTag: py3-none-any\n"
    ).encode("utf-8")
    members[f"{dist_info}/licenses/LICENSE"] = (package_root / "LICENSE").read_bytes()
    members[f"{dist_info}/licenses/DERIVATION.md"] = DERIVATION.read_bytes()

    record_name = f"{dist_info}/RECORD"
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    for name in sorted(members):
        content = members[name]
        writer.writerow((name, record_digest(content), len(content)))
    writer.writerow((record_name, "", ""))
    members[record_name] = output.getvalue().encode("utf-8")

    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / WHEEL_NAME
    with zipfile.ZipFile(destination, "w") as archive:
        for name in sorted(members):
            archive.writestr(zip_info(name), members[name])

    with zipfile.ZipFile(destination) as archive:
        names = set(archive.namelist())
        expected_names = set(members)
        if names != expected_names:
            raise ValueError(f"wheel content mismatch: {names ^ expected_names}")
        record_rows = list(csv.reader(io.StringIO(archive.read(record_name).decode("utf-8"))))
        if {row[0] for row in record_rows} != names:
            raise ValueError("wheel RECORD does not cover every member")
        for member, encoded, size in record_rows:
            content = archive.read(member)
            if member == record_name:
                if encoded or size:
                    raise ValueError("RECORD must have an empty self-hash")
            elif encoded != record_digest(content) or int(size) != len(content):
                raise ValueError(f"wheel RECORD mismatch: {member}")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    path = build(args.output_dir.resolve())
    data = path.read_bytes()
    print(json.dumps({"path": str(path), "bytes": len(data), "sha256": digest(data)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
