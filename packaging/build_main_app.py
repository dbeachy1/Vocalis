#!/usr/bin/env python3
"""Build one local Vocalis app image from exact, recorded component images."""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import time
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "packaging/main-app-build.json"
DOCKER = shutil.which("docker")
BUILD_TIMEOUT_SECONDS = 3600
MAX_BUILD_TIMEOUT_SECONDS = 10800
FFMPEG_DEBS = ".codex/packaging-probes/main-cuda-ffmpeg-20261008/debs"
# Where the FFmpeg source archive is found under --artifact-root when --ffmpeg-contexts is not given (the
# default is unchanged). October 11, 2026: packaging/ffmpeg/build-contract.json no longer carries this path,
# so a reader of the tracked files is not pointed into a private work folder; the step that prepares the two
# contexts from the publishers' downloads is packaging/ffmpeg/prepare_ffmpeg_contexts.py.
FFMPEG_SOURCE_DEFAULT = ".codex/redistribution-sources/ffmpeg-7_8.0.1-3ubuntu2/ffmpeg_8.0.1.orig.tar.xz"
IMAGE_CONTEXTS = (
    "voxcpm-engine",
    "enhance-engine",
    "trim-engine",
    "stems-engine",
    "leadvocal-engine",
    "acestep-engine",
    "dfn-engine",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checked(argv: list[str], *, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=ROOT, check=True, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)


def inspect_image(reference: str) -> dict[str, object]:
    assert DOCKER
    result = checked([DOCKER, "image", "inspect", reference])
    rows = json.loads(result.stdout)
    if len(rows) != 1:
        raise SystemExit(f"Image reference did not resolve to one local image: {reference}")
    return rows[0]


def record_build_cache(builder: str, evidence: Path, name: str, run=None) -> str:
    """Write the builder's cache listing to the evidence folder and return its totals as one line.

    (2026-10-11) Rebuilds that should take seconds took 8 to 11 minutes on one machine because the
    engine copy layers were no longer in the cache, and nothing recorded what the cache held before
    each build. With a listing taken before and after every build, the next slow build can be
    compared with the build before it: the records that are in that build's "after" file and
    missing from this build's "before" file were removed in between. Never fails the build: a
    listing that cannot be read is reported in the returned line.
    """
    run = run or checked
    try:
        listing = run([DOCKER, "buildx", "du", "--builder", builder, "--verbose"], timeout=120).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        return f"not read ({type(exc).__name__})"
    try:
        (evidence / name).write_text(listing, encoding="utf-8")
    except OSError as exc:
        # The listing is evidence only: a full disk here must not stop a build, or lose a finished one's result file.
        return f"read but not saved ({type(exc).__name__})"
    # The totals close the listing ("Shared:  193.7GB"); every record above them has its own
    # "Shared: true" and "Reclaimable: true" lines, which are not totals.
    totals = [" ".join(line.split()) for line in listing.splitlines()
              if line.startswith(("Shared:", "Private:", "Reclaimable:", "Total:"))
              and line.split(":", 1)[1].strip() not in ("true", "false")]
    return ", ".join(totals) or "listing has no totals"


def cached_step_count(log_path: Path) -> dict[str, int]:
    """How many of the recipe's own steps came from the cache and how many ran, read from the plain
    build log. Only numbered stage steps count ("#41 [vocalis-app  2/57] WORKDIR ..."); loading a
    context or the build definition is not a step of the recipe. Both counts are -1 when the log
    cannot be read: this runs after the build has ended and must not lose its result file."""
    stage_steps: set[str] = set()
    cached: set[str] = set()
    ran: set[str] = set()
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"cached": -1, "ran": -1}
    for line in text.splitlines():
        step, _, rest = line.partition(" ")
        if not step.startswith("#"):
            continue
        if rest.startswith("[") and "/" in rest.split("]", 1)[0] and not rest.startswith(("[internal]", "[context ")):
            stage_steps.add(step)
        elif rest == "CACHED":
            cached.add(step)
        elif rest.startswith("DONE "):
            ran.add(step)
    return {"cached": len(cached & stage_steps), "ran": len((ran - cached) & stage_steps)}


def assert_image_reference_matches(info: dict[str, object], reference: str, image_id: str) -> None:
    if info.get("Id") != image_id:
        raise SystemExit(f"Immutable image identity mismatch for {reference}: {info.get('Id')}")
    names = set(info.get("RepoTags") or []) | set(info.get("RepoDigests") or [])
    if reference not in names:
        raise SystemExit(f"Image reference is not a local tag or digest: {reference}")


def validate_input_file(path: Path, contract: dict[str, object]) -> dict[str, object]:
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"Build inputs must be a regular JSON file: {path}")
    try:
        inputs = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read build inputs JSON: {exc}") from exc
    if not isinstance(inputs, dict) or inputs.get("schemaVersion") != 1:
        raise SystemExit("Unsupported main-app build inputs schema")
    if inputs.get("profile") not in contract["profiles"]:
        raise SystemExit("Build profile must be cuda or rocm")
    if not isinstance(inputs.get("sourceRevision"), str) or len(inputs["sourceRevision"]) != 40:
        raise SystemExit("sourceRevision must be a full 40-character Git commit")
    dependency = inputs.get("dependencyImage")
    components = inputs.get("imageContexts")
    if not isinstance(dependency, dict) or not isinstance(components, dict):
        raise SystemExit("dependencyImage and imageContexts are required")
    if set(components) != set(IMAGE_CONTEXTS):
        raise SystemExit(f"Required component image contexts are {list(IMAGE_CONTEXTS)}")
    for name, record in [("dependencyImage", dependency), *components.items()]:
        if not isinstance(record, dict):
            raise SystemExit(f"{name} must contain reference and imageId")
        reference, image_id = record.get("reference"), record.get("imageId")
        if not isinstance(reference, str) or not reference or any(c.isspace() for c in reference):
            raise SystemExit(f"{name}.reference must be a local image reference")
        if not isinstance(image_id, str) or not image_id.startswith("sha256:") or len(image_id) != 71:
            raise SystemExit(f"{name}.imageId must be the full sha256 image ID")
    return inputs


def locked_runtime_rows(lock_path: Path, expected_packages: list[str]) -> list[dict[str, object]]:
    rows = []
    for line in lock_path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 6:
            raise SystemExit(f"Malformed runtime audio lock row: {line!r}")
        package, version, architecture, filename, byte_count, digest = fields
        rows.append({"package": package, "version": version, "architecture": architecture,
                     "filename": filename, "bytes": int(byte_count), "sha256": digest})
    expected = set(expected_packages)
    if len(expected) != len(expected_packages) or len(rows) != len(expected) or {r["package"] for r in rows} != expected:
        raise SystemExit("The shared main app native lock must remain the exact nine-package audio set")
    return rows


def extract_git_archive(archive_path: Path, destination: Path) -> None:
    root = destination.resolve(strict=True)
    with tarfile.open(archive_path, "r:") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                raise SystemExit(f"Unsafe or non-regular source archive entry: {member.name!r}")
            target = destination.joinpath(*name.parts).resolve()
            if target != root and root not in target.parents:
                raise SystemExit(f"Source archive entry escapes the frozen context: {member.name!r}")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(f"Cannot read Git archive entry: {member.name!r}")
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o777)


def copy_file(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise SystemExit(f"Expected regular build input: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def _kernel32():
    """Return kernel32 with pointer-safe signatures for process identity calls."""
    if os.name != "nt":
        raise RuntimeError("kernel32 is only available on Windows")
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    return kernel32


def filetime_creation_time(pid: int) -> int:
    if os.name != "nt":
        raise RuntimeError("FILETIME is only used for a Windows Docker CLI process")
    from ctypes import wintypes

    kernel32 = _kernel32()
    process = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(
            process, ctypes.byref(created), ctypes.byref(exited),
            ctypes.byref(kernel), ctypes.byref(user)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        kernel32.CloseHandle(process)


def linux_process_start_ticks(pid: int) -> int:
    """Return field 22 from procfs stat, which distinguishes PID reuse."""
    stat = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    closing_paren = stat.rfind(")")
    if closing_paren < 0:
        raise RuntimeError("Malformed Linux process stat record")
    fields_after_comm = stat[closing_paren + 1:].split()
    if len(fields_after_comm) <= 19:
        raise RuntimeError("Linux process stat record is missing its start-time field")
    return int(fields_after_comm[19])


def process_creation_identity(pid: int) -> int:
    """Return an OS-native creation identity for an exact live process."""
    return filetime_creation_time(pid) if os.name == "nt" else linux_process_start_ticks(pid)


def process_executable_path(pid: int) -> str:
    if os.name == "nt":
        from ctypes import wintypes

        kernel32 = _kernel32()
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(buffer))
            if not kernel32.QueryFullProcessImageNameW(
                handle, 0, buffer, ctypes.byref(length)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            return str(Path(buffer.value).resolve())
        finally:
            kernel32.CloseHandle(handle)
    return str(Path(f"/proc/{pid}/exe").resolve(strict=True))


def verify_build_process_identity(pid: int, created: int, executable: str) -> None:
    if os.path.normcase(process_executable_path(pid)) != os.path.normcase(str(Path(executable).resolve())):
        raise SystemExit("Docker CLI executable identity changed; refusing timeout cleanup")
    if process_creation_identity(pid) != created:
        raise SystemExit("Docker CLI creation identity changed; refusing timeout cleanup")


def linux_group_members(pgid: int, leader_start: int) -> list[int]:
    """Return live (non-zombie) members of an owned process group.

    The helper starts the Docker CLI with start_new_session, so the CLI is the
    group leader and the buildx plugin and any helpers it spawns inherit its
    group. Members that started before the leader cannot be ours.
    """
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text(encoding="ascii")
        except OSError:
            continue  # exited between listing and reading
        fields = stat[stat.rfind(")") + 1:].split()
        state, member_pgid, start = fields[0], int(fields[2]), int(fields[19])
        if member_pgid == pgid and state not in ("Z", "X") and start >= leader_start:
            members.append(int(entry.name))
    return sorted(members)


def await_linux_group_exit(pgid: int, leader_start: int, seconds: float) -> list[int]:
    # Bounded teardown wait: Linux gives no exit notification for grandchildren,
    # so recheck /proc briefly until the group is empty or the deadline passes.
    deadline = time.monotonic() + seconds
    while True:
        remaining = linux_group_members(pgid, leader_start)
        if not remaining or time.monotonic() >= deadline:
            return remaining
        time.sleep(0.2)


def stop_linux_process_group(proc: subprocess.Popen[bytes], created: int,
                             executable: str) -> dict[str, object]:
    # The leader is our unreaped child, so its PID (and therefore the group ID)
    # cannot be reused while we work; do not poll()/wait() it until the whole
    # group is proven empty, or a reused PID could make us signal a stranger.
    if proc.returncode is not None:
        raise SystemExit("Build leader was already reaped; refusing to signal a possibly reused group ID")
    pgid = proc.pid
    stat = Path(f"/proc/{pgid}/stat").read_text(encoding="ascii")
    if stat[stat.rfind(")") + 1:].split()[0] != "Z":
        verify_build_process_identity(pgid, created, executable)
    members = linux_group_members(pgid, created)
    record: dict[str, object] = {"processGroup": pgid, "membersAtTimeout": members,
                                 "escalatedToSigkill": False}
    if members:
        os.killpg(pgid, signal.SIGTERM)
        remaining = await_linux_group_exit(pgid, created, 20)
        if remaining:
            record.update(escalatedToSigkill=True, membersAfterSigterm=remaining)
            os.killpg(pgid, signal.SIGKILL)
            remaining = await_linux_group_exit(pgid, created, 10)
        if remaining:
            raise SystemExit(f"Owned build process group {pgid} still has live members: {remaining}")
    proc.wait(timeout=10)
    record.update(groupEmptyVerified=True, leaderExitCode=proc.returncode)
    return record


def stop_build_process(proc: subprocess.Popen[bytes], created: int,
                       executable: str) -> dict[str, object]:
    """Stop only the exact Docker CLI process tree this helper started."""
    if os.name != "nt":
        return stop_linux_process_group(proc, created, executable)
    if proc.poll() is not None:
        return {"leaderExitCode": proc.returncode, "alreadyExited": True}
    verify_build_process_identity(proc.pid, created, executable)
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                   check=True, capture_output=True, timeout=30)
    proc.wait(timeout=30)
    return {"taskkillTree": True, "leaderExitCode": proc.returncode}


def prepare_model_acquisition_context(git_root: Path, context_root: Path,
                                      contract: dict[str, object]) -> Path:
    """Build the context that carries the setup-time model fetcher into the image.

    code/ holds fetch_models.py and the lock files in the packaging/models layout (the fetcher
    finds its locks beside itself); notices/ holds each model's tracked NOTICE/licence text.
    Both lists come from the build contract, and every file must also be a frozen sourceInput:
    copy_file refuses anything the Git archive did not extract.
    """
    spec = contract["modelAcquisition"]
    context = context_root / spec["context"]
    context.mkdir()
    source = git_root / spec["root"]
    for group, names in (("code", spec["codeFiles"]), ("notices", spec["noticeFiles"])):
        for name in names:
            copy_file(source / name, context / group / name)
    return context


def prepare_nvml_context(git_root: Path, context_root: Path,
                         contract: dict[str, object]) -> Path:
    """Build the `nvml` context: the pinned nvidia-ml-py wheel, its hash lock and its license text.

    October 10, 2026 (design section 10, "Whole-card memory and readings on NVIDIA", Packaging).
    Dockerfile.app installs the wheel from this context for the CUDA profile only, with no index
    (`--no-index --no-deps --require-hashes`), so the build stays offline. The context is built for
    both profiles so the recipe has one shape; the ROCm profile never reads it. Every file must
    also be a frozen sourceInput: copy_file refuses anything the Git archive did not extract.
    """
    spec = contract["nvmlContext"]
    context = context_root / spec["context"]
    context.mkdir()
    source = git_root / spec["root"]
    for name in spec["files"]:
        copy_file(source / name, context / name)
    return context


def ffmpeg_input_paths(archive_contract: dict[str, object], artifact_root: Path,
                       ffmpeg_contexts: Path | None) -> tuple[Path, Path]:
    """Where the FFmpeg archive and the audio packages are read from: the prepared contexts folder when one
    is given, otherwise the unchanged default locations under `artifact_root`."""
    if ffmpeg_contexts is None:
        return artifact_root / FFMPEG_SOURCE_DEFAULT, artifact_root / FFMPEG_DEBS
    return (ffmpeg_contexts / "ffmpeg-source" / archive_contract["source"]["file"],
            ffmpeg_contexts / "ffmpeg-debs")


def prepare_contexts(revision: str, evidence: Path, contract: dict[str, object],
                     runtime_rows: list[dict[str, object]],
                     artifact_root: Path,
                     ffmpeg_contexts: Path | None = None) -> tuple[Path, Path, dict[str, object]]:
    """Freeze the source tree and every named build context under `evidence`.

    `ffmpeg_contexts`, when given, is a folder made by packaging/ffmpeg/prepare_ffmpeg_contexts.py holding
    ffmpeg-source/ and ffmpeg-debs/; the FFmpeg archive and the nine audio packages are then read from it
    instead of from `artifact_root`. Every file is verified against the tracked records either way.
    """
    context_root = evidence / "inputs"
    context_root.mkdir()
    git_root = context_root / "source-tree"
    git_root.mkdir()
    archive_path = evidence / "source-inputs.tar"
    source_paths = contract["sourceInputs"]
    with archive_path.open("wb") as archive:
        proc = subprocess.run(["git", "archive", "--format=tar", revision, *source_paths],
                             cwd=ROOT, check=True, stdout=archive, stderr=subprocess.PIPE,
                             timeout=120)
    extract_git_archive(archive_path, git_root)

    docker_context = context_root / "docker-context"
    docker_context.mkdir()
    source_base = git_root
    for relative in (contract["recipe"], contract["dockerignore"],
                     "packaging/main-cuda/ffmpeg-build.lock",
                     "packaging/main-cuda/ffmpeg-native.lock"):
        copy_file(source_base / relative, docker_context / Path(relative).name)

    archive_contract = json.loads((git_root / "packaging/ffmpeg/build-contract.json").read_text(encoding="utf-8"))
    ffmpeg_source, deb_root = ffmpeg_input_paths(archive_contract, artifact_root, ffmpeg_contexts)
    print(f"FFmpeg inputs: source {ffmpeg_source}, packages {deb_root}", flush=True)
    if ffmpeg_source.is_symlink() or not ffmpeg_source.is_file():
        raise SystemExit(f"Missing exact FFmpeg source input: {ffmpeg_source}")
    if sha256_file(ffmpeg_source) != archive_contract["source"]["sha256"]:
        raise SystemExit("FFmpeg source hash does not match the tracked build contract")
    ffmpeg_source_context = context_root / "ffmpeg-source"
    ffmpeg_source_context.mkdir()
    copy_file(ffmpeg_source, ffmpeg_source_context / ffmpeg_source.name)

    deb_context = context_root / "ffmpeg-debs"
    deb_context.mkdir()
    for row in runtime_rows:
        source = deb_root / row["filename"]
        if source.is_symlink() or not source.is_file() or source.stat().st_size != row["bytes"]:
            raise SystemExit(f"Missing or wrong-sized locked audio package: {source}")
        if sha256_file(source) != row["sha256"]:
            raise SystemExit(f"Locked audio package hash mismatch: {row['filename']}")
        copy_file(source, deb_context / row["filename"])
    if {path.name for path in deb_context.iterdir()} != {row["filename"] for row in runtime_rows}:
        raise SystemExit("Prepared audio runtime context differs from the nine-package lock")

    model_context = context_root / "chatterbox-assets"
    model_context.mkdir()
    for name in ("manifest.json", "NOTICE.md"):
        copy_file(git_root / "packaging/models/chatterbox" / name, model_context / name)

    prepare_model_acquisition_context(git_root, context_root, contract)
    prepare_nvml_context(git_root, context_root, contract)

    license_context = context_root / "vocalis-license"
    license_context.mkdir()
    app_root = git_root / "source/vocalis"
    copy_file(app_root / "LICENSE", license_context / "LICENSE")
    copy_file(app_root / "vocalis.py", license_context / "vocalis.py")
    satellite = license_context / "satellite"
    # October 10, 2026 (design section 10, "Whole-card memory and readings"): the main image also
    # carries vocalis_satellite_gpustats.py, the one owner of NVML handling, so nothing is written twice.
    for name in ("vocalis_stream_core.py", "vocalis_satellite_protocol.py", "vocalis_torch_backend.py",
                 "vocalis_satellite_gpustats.py"):
        copy_file(app_root / "satellite" / name, satellite / name)

    context_files = sorted(
        item for item in context_root.rglob("*") if item.is_file()
    )
    context_manifest = [{"path": item.relative_to(context_root).as_posix(),
                         "bytes": item.stat().st_size, "sha256": sha256_file(item)}
                        for item in context_files]
    snapshot = {
        "sourceRevision": revision,
        "gitArchive": {"path": archive_path.name, "bytes": archive_path.stat().st_size,
                       "sha256": sha256_file(archive_path), "sourceInputs": source_paths},
        "dockerContext": [item["path"] for item in context_manifest
                          if item["path"].startswith("docker-context/")],
        "runtimeAudioPackages": runtime_rows,
        "ffmpegSource": {"path": f"ffmpeg-source/{ffmpeg_source.name}",
                         "bytes": ffmpeg_source.stat().st_size,
                         "sha256": sha256_file(ffmpeg_source)},
        "files": context_manifest,
    }
    return context_root, git_root, snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the shared CUDA/ROCm Vocalis app image.")
    parser.add_argument("--inputs", required=True, type=Path,
                        help="JSON with profile, sourceRevision, dependencyImage and all seven imageContexts")
    parser.add_argument("--tag", help="Optional new output tag; it must not already exist")
    parser.add_argument("--builder", help="Existing Buildx builder for this host; defaults to the contract value")
    parser.add_argument("--timeout", type=int, default=BUILD_TIMEOUT_SECONDS)
    parser.add_argument("--artifact-root", type=Path, default=ROOT,
                        help="Directory holding the acquired FFmpeg source archive and locked "
                             "audio .debs at their recorded relative paths; defaults to this checkout")
    parser.add_argument("--ffmpeg-contexts", type=Path, default=None,
                        help="Folder made by packaging/ffmpeg/prepare_ffmpeg_contexts.py (holds ffmpeg-source/ "
                             "and ffmpeg-debs/); when given, the FFmpeg archive and audio packages are read "
                             "from it instead of from --artifact-root")
    parser.add_argument("--evidence-root", type=Path, default=ROOT / ".codex/runtime-tests",
                        help="Existing directory for the per-build evidence and frozen contexts")
    args = parser.parse_args()
    if args.timeout < 60 or args.timeout > MAX_BUILD_TIMEOUT_SECONDS:
        raise SystemExit(f"Build timeout must be between 60 and {MAX_BUILD_TIMEOUT_SECONDS} seconds")
    options = [("--artifact-root", args.artifact_root), ("--evidence-root", args.evidence_root)]
    if args.ffmpeg_contexts is not None:
        options.append(("--ffmpeg-contexts", args.ffmpeg_contexts))
    for option, value in options:
        if value.is_symlink() or not value.is_dir():
            raise SystemExit(f"{option} must be an existing real directory: {value}")
    artifact_root = args.artifact_root.resolve(strict=True)
    ffmpeg_contexts = args.ffmpeg_contexts.resolve(strict=True) if args.ffmpeg_contexts is not None else None
    evidence_root = args.evidence_root.resolve(strict=True)
    if not DOCKER:
        raise SystemExit("Docker CLI was not found on PATH")
    if args.inputs.is_absolute():
        input_path = args.inputs
    else:
        input_path = ROOT / args.inputs
    if input_path.is_symlink():
        raise SystemExit("The build-input manifest cannot be a symlink")
    inputs_path = input_path.resolve(strict=True)
    if ROOT not in inputs_path.parents:
        raise SystemExit("The build-input manifest must be inside the project root")

    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    inputs = validate_input_file(inputs_path, contract)
    builder = args.builder or contract["builder"]
    if not isinstance(builder, str) or not builder or any(c.isspace() for c in builder):
        raise SystemExit("Builder must name an existing local Buildx builder")
    revision = inputs["sourceRevision"]
    current_head = checked(["git", "rev-parse", "HEAD"]).stdout.strip()
    if revision != current_head:
        raise SystemExit("Build sourceRevision must match current HEAD; freeze/check out the requested revision first")
    image_rows = {"dependencyImage": inputs["dependencyImage"], **inputs["imageContexts"]}
    inspected_images = {}
    for name, record in image_rows.items():
        inspected = inspect_image(record["reference"])
        assert_image_reference_matches(inspected, record["reference"], record["imageId"])
        inspected_images[name] = inspected
    base_user = inspected_images["dependencyImage"].get("Config", {}).get("User", "")
    if base_user not in ("", "root", "0"):
        raise SystemExit("Clean dependency base must begin as root for the assembly layer")

    runtime_rows = locked_runtime_rows(ROOT / "packaging/main-cuda/ffmpeg-native.lock",
                                       contract["runtimePackages"])
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    evidence = evidence_root / f"main-app-{inputs['profile']}-{now}"
    evidence.mkdir(parents=True, exist_ok=False)
    context_root, git_root, snapshot = prepare_contexts(revision, evidence, contract,
                                                        runtime_rows, artifact_root, ffmpeg_contexts)
    input_snapshot = {
        **inputs,
        "inputManifest": str(inputs_path.relative_to(ROOT)),
        "inputManifestSha256": sha256_file(inputs_path),
        "buildxBuilder": builder,
        "resolvedImages": {
            name: {"reference": record["reference"], "imageId": record["imageId"],
                   "created": inspected_images[name]["Created"],
                   "sizeBytes": inspected_images[name].get("Size")}
            for name, record in image_rows.items()
        },
        "componentPaths": contract["imageContexts"],
    }
    snapshot["resolvedBuildInputs"] = input_snapshot
    snapshot_path = evidence / "frozen-input-manifest.json"
    snapshot_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")

    profile = inputs["profile"]
    output_tag = args.tag or f"vocalis-main-app-{profile}:{revision[:12]}-{now}"
    try:
        inspect_image(output_tag)
    except subprocess.CalledProcessError:
        pass
    else:
        raise SystemExit(f"Refusing to overwrite an existing output image tag: {output_tag}")

    checked([DOCKER, "buildx", "inspect", builder], timeout=30)
    app_context = context_root / "docker-context"
    profile_python = contract["profiles"][profile]["primaryPython"]
    build_args = [
        DOCKER, "buildx", "build", "--builder", builder,
        "--platform", contract["platform"], "--load", "--progress=plain",
        "--file", str(app_context / Path(contract["recipe"]).name),
        "--tag", output_tag,
        "--metadata-file", str(evidence / "build-metadata.json"),
        "--label", f"org.opencontainers.image.revision={revision}",
        "--label", f"com.vocalis.profile={profile}",
        "--label", f"com.vocalis.dependency-image-id={inputs['dependencyImage']['imageId']}",
        # BuildKit's docker driver treats a config ID as a registry reference
        # in both FROM and docker-image:// contexts. Keep using the inspected
        # local tag here; the frozen manifest and labels retain the full ID.
        "--build-arg", f"DEPENDENCY_IMAGE={inputs['dependencyImage']['reference']}",
        "--build-arg", f"APP_PROFILE={profile}",
        "--build-arg", f"APP_PRIMARY_PYTHON={profile_python}",
    ]
    for name in IMAGE_CONTEXTS:
        record = inputs["imageContexts"][name]
        build_args.extend(["--label", f"com.vocalis.component.{name}-image-id={record['imageId']}"])
        build_args.extend(["--build-context", f"{name}=docker-image://{record['reference']}"])
    directories = contract["directoryContexts"]
    for name, relative in directories.items():
        build_args.extend(["--build-context", f"{name}={git_root / relative}"])
    acquisition = contract["modelAcquisition"]["context"]
    build_args.extend([
        "--build-context", f"{acquisition}={context_root / acquisition}",
        "--build-context", f"{contract['nvmlContext']['context']}={context_root / contract['nvmlContext']['context']}",
        "--build-context", f"vocalis-license={context_root / 'vocalis-license'}",
        "--build-context", f"ffmpeg-source={context_root / 'ffmpeg-source'}",
        "--build-context", f"ffmpeg-debs={context_root / 'ffmpeg-debs'}",
        str(app_context),
    ])
    owner = {
        "owner": "packaging/build_main_app.py invocation",
        "profile": profile,
        "builder": builder,
        "sourceRevision": revision,
        "imageIdInputs": input_snapshot["resolvedImages"],
        "inputManifest": str(snapshot_path),
        "inputManifestSha256": sha256_file(snapshot_path),
        "tag": output_tag,
        "argv": build_args,
        "startedUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "timeoutSeconds": args.timeout,
        "stopCondition": "Build exits or its recorded timeout; verify and stop only this Docker CLI process tree, then confirm process exit.",
    }
    owner_path = evidence / "build-owner.json"
    owner["buildCacheBefore"] = record_build_cache(builder, evidence, "build-cache-before.txt")
    print(f"Build cache before: {owner['buildCacheBefore']}", flush=True)
    with (evidence / "build.log").open("wb") as log:
        proc = subprocess.Popen(build_args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=(os.name != "nt"))
        created = process_creation_identity(proc.pid)
        owner.update(pid=proc.pid, executable=DOCKER, creationIdentity=created,
                     creationIdentityKind="windows-filetime-100ns" if os.name == "nt" else "linux-proc-start-ticks")
        owner_path.write_text(json.dumps(owner, indent=2) + "\n", encoding="utf-8")
        print(evidence, flush=True)
        try:
            exit_code = proc.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            teardown = stop_build_process(proc, created, DOCKER)
            owner.update(exitCode=proc.returncode, timedOut=True, teardown=teardown,
                         finishedUtc=dt.datetime.now(dt.timezone.utc).isoformat())
            (evidence / "build-result.json").write_text(json.dumps(owner, indent=2) + "\n", encoding="utf-8")
            raise SystemExit("Bounded app image build timed out; see retained build evidence")

    owner.update(exitCode=exit_code, processExitVerified=proc.poll() is not None,
                 finishedUtc=dt.datetime.now(dt.timezone.utc).isoformat(),
                 steps=cached_step_count(evidence / "build.log"),
                 buildCacheAfter=record_build_cache(builder, evidence, "build-cache-after.txt"))
    print(f"Build cache after: {owner['buildCacheAfter']}; steps from the cache {owner['steps']['cached']}, "
          f"steps that ran {owner['steps']['ran']}", flush=True)
    if exit_code == 0:
        built = inspect_image(output_tag)
        labels = built.get("Config", {}).get("Labels", {}) or {}
        if labels.get("org.opencontainers.image.revision") != revision or labels.get("com.vocalis.profile") != profile:
            raise SystemExit("Built app image labels do not match the frozen source/profile")
        for name, record in image_rows.items():
            assert_image_reference_matches(inspect_image(record["reference"]), record["reference"],
                                           record["imageId"])
        owner.update(imageId=built["Id"], imageCreated=built["Created"])
    (evidence / "build-result.json").write_text(json.dumps(owner, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: owner[key] for key in ("profile", "exitCode", "imageId", "tag") if key in owner}))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
