#!/usr/bin/env python3
"""Stamp the default image references into the satellite setup scripts (design section 9, "Release stamping",
October 10, 2026).

    python packaging/satellite/stamp_release.py --cuda-image REF --rocm-image REF --out DIR [--release]

The copies of satellite-setup.sh and satellite-setup.ps1 in the repository carry no default image and require
--image. A release step runs this to write stamped copies into DIR (normally artifacts/satellite/<commit>/):

  satellite-setup.sh    the two marker lines  DEFAULT_IMAGE_CUDA=""  and  DEFAULT_IMAGE_ROCM=""
  satellite-setup.ps1   the one marker line  $DefaultImageCuda = ''  (Windows supports NVIDIA only, so the
                        ROCm image is not written there). Both files are required: a release must not ship
                        without the Windows file.

Every reference must be name@sha256:<64 hex digits>, the digest rule of setup.sh's validate_digest_ref and
packaging/windows/build-installer.ps1. With --release each must also name a registry host that is not this machine,
the release rule of build-installer.ps1 (Get-ImageRegistryHost / Get-PublishedReferenceProblem); Docker is not
called. Without --release a reference with no registry host (a locally built image, which answers to
<name>@sha256:<image id>) must be the image the local Docker holds under that ID: the stamp step runs the read-only
`docker image inspect --format '{{.Id}}' <reference>` once per such reference and requires the answer to equal the
reference's sha256:... part, as build-installer.ps1 does (a mistyped local ID would otherwise make every first run
fail at the pull). If Docker cannot be asked the stamp fails. A marker line that is missing, or that appears more
than once, stops the stamp, and so does an --out folder that is the source folder (it would overwrite the
repository's own copies). Nothing is written until every check has passed.

This never pushes anything (repository policy: no image is published without Doug's word); the only Docker call is the
read-only inspect above.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

# The same rule as validate_digest_ref in packaging/setup.sh and $DigestReferencePattern in build-installer.ps1.
DIGEST_REFERENCE = re.compile(r"[^\s]+@sha256:[a-fA-F0-9]{64}")
# Stricter than the digest rule, for the sake of the stamp itself: the reference is written between quotes into a
# shell script and a PowerShell script, so anything that either could interpret ($, a backtick, a quote, a
# backslash, a control character) is refused. Real references are made of these characters only (the brackets
# are for a registry given as an IPv6 literal, which a release then refuses as a local one).
SAFE_REFERENCE = re.compile(r"[A-Za-z0-9._:/@\[\]-]+")

# (file name, [(which image, marker line, template of the stamped line)]); both files are required. The Windows script supports
# NVIDIA only (Docker Desktop cannot give an AMD card to a container), so it carries one marker, for CUDA, and the
# ROCm image is never written to it (correction of October 10, 2026).
SCRIPTS = (
    (
        "satellite-setup.sh",
        (
            ("cuda", 'DEFAULT_IMAGE_CUDA=""', "DEFAULT_IMAGE_CUDA=\"{ref}\""),
            ("rocm", 'DEFAULT_IMAGE_ROCM=""', "DEFAULT_IMAGE_ROCM=\"{ref}\""),
        ),
    ),
    (
        "satellite-setup.ps1",
        (("cuda", "$DefaultImageCuda = ''", "$DefaultImageCuda = '{ref}'"),),
    ),
)


def registry_host(reference: str) -> str | None:
    """Docker's rule: the part before the first '/' is a registry host only when it is 'localhost' or contains
    '.' or ':'. None for a reference with no registry host (a locally built image)."""
    at = reference.find("@")
    name = reference if at < 0 else reference[:at]
    slash = name.find("/")
    if slash < 1:
        return None
    first = name[:slash]
    if first == "localhost" or "." in first or ":" in first:
        return first
    return None


def published_reference_problem(reference: str) -> str | None:
    """None when the reference is acceptable for a release; otherwise what is wrong with it."""
    host = registry_host(reference)
    if not host:
        return f"'{reference}' has no registry host (a locally built image); a release needs an image reference on a registry."
    name = re.sub(r":\d+$", "", host).lower()
    if name == "localhost" or name.endswith(".localhost") or name == "127.0.0.1" or name == "[::1]":
        return f"'{reference}' names a registry on this machine ({host}); a release needs an image reference on a published registry."
    return None


def reference_problem(label: str, reference: str, release: bool) -> str | None:
    if not DIGEST_REFERENCE.fullmatch(reference):
        return f"{label} must be name@sha256:<64 hex digits> (the same rule as setup.sh); got '{reference}'."
    if not SAFE_REFERENCE.fullmatch(reference):
        return f"{label} '{reference}' contains a character that is not allowed in an image reference here (letters, digits, '.', '_', ':', '/', '-', '[', ']' and the '@' before the digest)."
    if release:
        problem = published_reference_problem(reference)
        if problem:
            return f"{label}: {problem}"
    return None


def stamp_bytes(name: str, data: bytes, replacements: list[tuple[str, str]]) -> bytes:
    """Replaces each marker line (the whole line, nothing else on it) exactly once. The line ending is kept."""
    for marker, stamped in replacements:
        pattern = re.compile(rb"(?m)^" + re.escape(marker.encode("ascii")) + rb"(?=\r?$)")
        found = pattern.findall(data)
        if len(found) != 1:
            raise ValueError(
                f"{name}: the marker line {marker!r} must appear exactly once, and it appears {len(found)} times."
            )
        data = pattern.sub(lambda _match, text=stamped.encode("ascii"): text, data)
    return data


def docker_image_id(reference: str) -> str:
    """The ID the local Docker holds under `reference`: the read-only `docker image inspect --format '{{.Id}}'`.
    Raises ValueError with a clear message when Docker cannot be asked."""
    docker = shutil.which("docker")
    if not docker:
        raise ValueError(f"'{reference}' is a local image reference, so Docker is needed to check it, and docker was not found on PATH.")
    try:
        result = subprocess.run(
            [docker, "image", "inspect", "--format", "{{.Id}}", reference],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f"Docker could not be asked about '{reference}': {error}") from error
    if result.returncode != 0:
        raise ValueError(f"docker image inspect failed for '{reference}': {(result.stderr or result.stdout).strip()}")
    return result.stdout.strip()


def local_reference_problem(label: str, reference: str, inspect_image: Callable[[str], str]) -> str | None:
    """For a reference with no registry host: the local Docker must hold exactly that image under that ID."""
    expected = reference[reference.index("@") + 1:].lower()
    try:
        found = inspect_image(reference)
    except ValueError as error:
        return f"{label}: {error}"
    print(f"{label}: local reference {reference}: Docker holds ID '{found}', expected '{expected}'.")
    if found.strip().lower() != expected:
        return f"{label}: the local image '{reference}' has ID '{found}', not '{expected}' (a mistyped ID would make every first run fail at the pull)."
    return None


def stamp(
    source_dir: Path,
    out_dir: Path,
    cuda_image: str,
    rocm_image: str,
    release: bool,
    inspect_image: Callable[[str], str] = docker_image_id,
) -> list[Path]:
    labelled = (("--cuda-image", cuda_image), ("--rocm-image", rocm_image))
    problems = [problem for problem in (reference_problem(label, ref, release) for label, ref in labelled) if problem]
    if problems:
        raise ValueError("\n".join(problems))
    # Without --release a local reference (no registry host) must be the image the local Docker holds under that ID.
    # With --release the registry-host rule above is the whole check and Docker is not called.
    if not release:
        problems = [
            problem
            for problem in (
                local_reference_problem(label, ref, inspect_image) for label, ref in labelled if registry_host(ref) is None
            )
            if problem
        ]
        if problems:
            raise ValueError("\n".join(problems))

    if out_dir.resolve() == source_dir.resolve():
        raise ValueError(f"--out is the source folder ({source_dir}); that would overwrite the repository's own unstamped copies. Choose another folder.")

    stamped: list[tuple[Path, bytes, Path, list[str]]] = []
    images = {"cuda": cuda_image, "rocm": rocm_image}
    for file_name, markers in SCRIPTS:
        source = source_dir / file_name
        if not source.is_file():
            # Both files are required: a release must not ship without the Windows file.
            raise ValueError(f"{source} is missing; there is nothing to stamp, and a release needs both setup scripts.")
        replacements = [(marker, template.format(ref=images[which])) for which, marker, template in markers]
        stamped.append((source, stamp_bytes(file_name, source.read_bytes(), replacements), out_dir / file_name, [which for which, _, _ in markers]))

    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for source, data, target, which_images in stamped:
        target.write_bytes(data)
        shutil.copymode(source, target)
        for which in which_images:
            print(f"{target.name}: stamped {'CUDA' if which == 'cuda' else 'ROCm'} {images[which]}")
        print(f"{target.name}: written to {target} ({len(data)} bytes).")
        written.append(target)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--cuda-image", required=True, help="the NVIDIA satellite image, name@sha256:<64 hex>")
    parser.add_argument("--rocm-image", required=True, help="the AMD satellite image, name@sha256:<64 hex>")
    parser.add_argument("--out", required=True, type=Path, help="the folder the stamped copies are written to")
    parser.add_argument(
        "--release",
        action="store_true",
        help="require a registry host that is not this machine (a published image), as build-installer.ps1 does",
    )
    # A seam for the tests: where the unstamped scripts are read from. The default is this file's own folder.
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).resolve().parent, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    print(f"Stamping from {args.source_dir} into {args.out} (release={args.release}).")
    try:
        written = stamp(args.source_dir, args.out, args.cuda_image, args.rocm_image, args.release)
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"Done: {len(written)} file(s) stamped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
