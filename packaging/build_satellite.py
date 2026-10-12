#!/usr/bin/env python3
"""Build one local Vocalis satellite image (CUDA or ROCm) from its recorded dependency image.

    python packaging/build_satellite.py --variant cuda --tag 20261010

The command is the recorded way to build `vocalis-satellite-<variant>:<tag>` (design section 9,
"Satellite package: one command per operating system", October 10, 2026). It checks that the
dependency image on this machine is exactly the recorded one, builds without network from
packaging/satellite/Dockerfile, checks the dependency image again and prints the new image's ID as
the last line of standard output, after a `revision=<commit>` line. The image is built from the
working tree, so the build refuses when a file the build context admits differs from HEAD (unless
--allow-dirty, which appends -dirty) and labels the image org.opencontainers.image.revision. It never pushes or uploads anything (repository policy): publishing an
image is Doug's decision, not a build step.

Conventions follow packaging/build_main_app.py: the same builder and platform, the local tag (not
the ID) as the build base because BuildKit's docker driver treats an ID as a registry reference,
a bounded build whose process tree is stopped by the same exact-identity teardown, a refusal to
overwrite an existing output tag, and the build log kept under .codex/runtime-tests.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_main_app as main_build  # noqa: E402  (process teardown helpers; one copy of them)

ROOT = Path(__file__).resolve().parents[1]
DOCKER = shutil.which("docker")
DOCKERFILE = "packaging/satellite/Dockerfile"
BUILDER = "desktop-linux"
PLATFORM = "linux/amd64"
BUILD_TIMEOUT_SECONDS = 3600
LOG_ROOT = ROOT / ".codex" / "runtime-tests"
TAG_PATTERN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}")

# The two Chatterbox dependency images of the October 8, 2026 satellite images, by local tag and
# full image ID, with the interpreter folder each one's application environment lives in.
BASES = {
    "cuda": {
        "reference": "vocalis-g1-main-cuda-deps:20261008-vocalis-0.1.7.1",
        "imageId": "sha256:00c74576a8d14dd533a5f56d6289d132cc837f42911ee17831b962afe6d422e0",
        "venvBin": "/opt/venv/3.12/bin",
    },
    "rocm": {
        "reference": "vocalis-g1-main-rocm-app-deps:20261008-vocalis-0.1.7.1",
        "imageId": "sha256:8286bb78f73af7e8065bcf58c8e8022bee604f063e21f406149c7966b5a7d86a",
        "venvBin": "/opt/venv/chatterbox/bin",
    },
}


def local_image_id(reference: str) -> str | None:
    """The ID Docker holds for a local reference, or None when there is no such image."""
    result = subprocess.run([DOCKER, "image", "inspect", reference, "--format", "{{.Id}}"],
                            cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=60)
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def verify_base(variant: str, inspect=None) -> None:
    base = BASES[variant]
    found = (inspect or local_image_id)(base["reference"])
    if found != base["imageId"]:
        raise SystemExit(f"Dependency image {base['reference']} is {found or 'missing'} on this "
                         f"machine; the recorded image is {base['imageId']}. Refusing to build.")


def output_tag(variant: str, tag: str) -> str:
    if not TAG_PATTERN.fullmatch(tag):
        raise SystemExit(f"Not a usable image tag: {tag!r}")
    return f"vocalis-satellite-{variant}:{tag}"


def build_command(variant: str, tag: str, docker: str = "docker", builder: str = BUILDER,
                  revision: str = "unknown") -> list[str]:
    """The exact `docker buildx build` call. No push, no network, loaded into the local Docker."""
    base = BASES[variant]
    return [
        docker, "buildx", "build", "--builder", builder, "--platform", PLATFORM,
        "--network=none", "--load", "--progress=plain",
        "--file", DOCKERFILE,
        "--tag", output_tag(variant, tag),
        "--label", f"org.opencontainers.image.revision={revision}",
        "--label", f"com.vocalis.profile={variant}",
        "--label", f"com.vocalis.dependency-image-id={base['imageId']}",
        "--build-arg", f"BASE_IMAGE={base['reference']}",
        "--build-arg", f"GPU_TYPE={variant}",
        "--build-arg", f"VENV_BIN={base['venvBin']}",
        ".",
    ]


def run_git(args: list[str]) -> str:
    """Standard output of a git call in the repository (the injectable seam for the tests)."""
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=120)
    if result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def admitted_inputs() -> list[re.Pattern]:
    """The files the build context lets in, from Dockerfile.dockerignore ('!' lines naming files,
    where '*' does not cross a folder), plus the Dockerfile and the ignore file themselves."""
    ignore = ROOT / (DOCKERFILE + ".dockerignore")
    names = [line[1:].strip() for line in ignore.read_text(encoding="utf-8").splitlines()
             if line.startswith("!")]
    names = [n for n in names + [DOCKERFILE, DOCKERFILE + ".dockerignore"] if not n.endswith("/")]
    return [re.compile("".join("[^/]*" if part == "*" else re.escape(part)
                               for part in re.split(r"(\*)", name)) + r"\Z") for name in names]


def changed_inputs(git=None) -> list[str]:
    """Paths `git status` reports as changed (modified, staged, untracked, renamed) that the build
    context admits. A change to any of them means the image is not what HEAD says it is."""
    git = git or run_git
    entries = git(["status", "--porcelain", "-z", "-uall"]).split("\0")
    paths, i = [], 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        paths.append(entry[3:])
        if entry[0] in "RC" and i < len(entries):          # the original path follows a rename/copy
            paths.append(entries[i])
            i += 1
    patterns = admitted_inputs()
    return sorted({p for p in paths if any(pattern.match(p) for pattern in patterns)})


def source_revision(allow_dirty: bool, git=None) -> str:
    """The commit the working tree is built from, or SystemExit when build inputs differ from it.

    The image is built from the working tree, so a changed input would make the revision label a
    lie. --allow-dirty builds anyway and appends '-dirty' (only when an input really differs).
    """
    git = git or run_git
    revision = git(["rev-parse", "HEAD"]).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit(f"Cannot determine the source revision (git said {revision!r})")
    changed = changed_inputs(git)
    if changed and not allow_dirty:
        raise SystemExit("Refusing to build: these build inputs differ from HEAD "
                         f"({revision[:12]}): {', '.join(changed)}. Commit them, or pass --allow-dirty.")
    if changed:
        print(f"WARNING: building from a dirty tree; changed inputs: {', '.join(changed)}",
              file=sys.stderr)
        return revision + "-dirty"
    return revision


def run_build(argv: list[str], log_path: Path, timeout: int) -> int:
    """Run the build with its output in `log_path`; stop exactly this process tree on timeout."""
    with log_path.open("wb") as log:
        proc = subprocess.Popen(argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=(os.name != "nt"))
        created = main_build.process_creation_identity(proc.pid)
        try:
            return proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            teardown = main_build.stop_build_process(proc, created, argv[0])
            raise SystemExit(f"Build timed out after {timeout} s and was stopped ({teardown}); "
                             f"log: {log_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the CUDA or ROCm Vocalis satellite image.")
    parser.add_argument("--variant", required=True, choices=sorted(BASES))
    parser.add_argument("--tag", required=True, help="tag of the new image; it must not exist yet")
    parser.add_argument("--builder", default=BUILDER, help="existing Buildx builder on this machine")
    parser.add_argument("--timeout", type=int, default=BUILD_TIMEOUT_SECONDS)
    parser.add_argument("--allow-dirty", action="store_true",
                        help="build although a build input differs from HEAD; the revision label "
                             "then ends in -dirty")
    args = parser.parse_args(argv)
    if not DOCKER:
        raise SystemExit("Docker CLI was not found on PATH")
    if args.timeout < 60:
        raise SystemExit("Build timeout must be at least 60 seconds")
    tag = output_tag(args.variant, args.tag)
    verify_base(args.variant)
    if local_image_id(tag) is not None:
        raise SystemExit(f"Refusing to overwrite an existing output image tag: {tag}")
    revision = source_revision(args.allow_dirty)
    command = build_command(args.variant, args.tag, DOCKER, args.builder, revision)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = LOG_ROOT / f"satellite-{args.variant}-{stamp}.log"
    print(f"building {tag} from {BASES[args.variant]['reference']}; log: {log_path}", file=sys.stderr,
          flush=True)
    code = run_build(command, log_path, args.timeout)
    if code != 0:
        tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-25:])
        print(tail, file=sys.stderr)
        raise SystemExit(f"Build failed with exit code {code}; log: {log_path}")
    verify_base(args.variant)           # the base must not have been swapped under the build
    image_id = local_image_id(tag)
    if image_id is None:
        raise SystemExit(f"The build succeeded but {tag} is not a local image")
    print(f"built {tag}; log: {log_path}", file=sys.stderr)
    print(f"revision={revision}")
    print(image_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
