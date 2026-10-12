"""Validate and assemble one frozen ACE engine context; this script does not build it."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path


PACKAGE = Path(__file__).resolve().parent
REPOSITORY = PACKAGE.parents[1]
INPUTS = PACKAGE / "inputs"
LOCKS = PACKAGE / "locks"
MATERIALS = json.loads((PACKAGE / "engine-build-inputs.json").read_text(encoding="utf-8"))
SOURCE_NAME = "ACE-Step-1.5-6d467e4b5081ccb0abf1ec1bf4fdf9051a2d34b0"
SOURCE_ARCHIVE_NAME = f"{SOURCE_NAME}.tar.gz"
EXPECTED_PACKAGES = set(MATERIALS["nativeAudio"]["testedAcePackages"])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require_hash(path: Path, expected: str) -> None:
    if not path.is_file():
        raise ValueError(f"required file is missing: {path}")
    actual = sha256(path)
    if actual != expected:
        raise ValueError(f"SHA-256 mismatch for {path}: {actual}")


def json_file(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def is_reparse_point(path: Path) -> bool:
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & 0x400)


def verify_source_tree(root: Path) -> dict:
    manifest_path = INPUTS / "source-tree-manifest.json"
    manifest = json_file(manifest_path)
    if not root.is_dir() or is_reparse_point(root):
        raise ValueError(f"source tree must be a real directory, not a link: {root}")
    expected_paths: set[str] = set()
    for row in manifest["files"]:
        relative = Path(row["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"unsafe source manifest path: {row['path']}")
        path = root / relative
        if is_reparse_point(path) or not path.is_file() or path.stat().st_size != row["bytes"] or sha256(path) != row["sha256"]:
            raise ValueError(f"source-tree entry mismatch: {row['path']}")
        expected_paths.add(relative.as_posix())
    actual_paths: set[str] = set()
    for path in root.rglob("*"):
        if is_reparse_point(path):
            raise ValueError(f"source tree contains a link/reparse point: {path.relative_to(root)}")
        if path.is_file():
            actual_paths.add(path.relative_to(root).as_posix())
    if actual_paths != expected_paths:
        raise ValueError("source tree contains missing or unmanifested files")
    tree_sha = hashlib.sha256(json.dumps(manifest["files"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if tree_sha != MATERIALS["upstream"]["sourceTreeSha256"]:
        raise ValueError("source-tree manifest digest differs from the frozen engine record")
    return {"fileCount": len(actual_paths), "treeSha256": tree_sha}


def verify_patches() -> dict[str, str]:
    observed: dict[str, str] = {}
    for name, expected in MATERIALS["upstream"]["patches"].items():
        source = PACKAGE / "local-model-root.patch" if name == "local-model-root.patch" else INPUTS / "patches" / name
        require_hash(source, expected)
        observed[name] = expected
    return observed


def verify_native_subset() -> tuple[bytes, list[str]]:
    shared = REPOSITORY / "packaging" / "main-cuda" / "ffmpeg-native.lock"
    require_hash(shared, MATERIALS["nativeAudio"]["sharedAuthoritySha256AtPromotion"])
    snapshot = PACKAGE / MATERIALS["nativeAudio"]["testedAceSubset"]
    require_hash(snapshot, MATERIALS["nativeAudio"]["testedAceSubsetSha256"])
    rows = [line for line in shared.read_bytes().splitlines(keepends=True)
            if line.strip() and not line.lstrip().startswith(b"#")]
    by_package = {line.split(b"\t", 1)[0].decode("ascii"): line for line in rows}
    if len(by_package) != len(rows) or set(by_package) != EXPECTED_PACKAGES | {"libsamplerate0"}:
        raise ValueError("shared audio lock no longer has the reviewed nine-package set")
    derived = [by_package[name] for name in sorted(EXPECTED_PACKAGES)]
    snapshot_rows = [line for line in snapshot.read_bytes().splitlines(keepends=True)
                     if line.strip() and not line.lstrip().startswith(b"#")]
    if snapshot_rows != derived:
        raise ValueError("ACE subset differs from the matching rows in the shared main audio lock")
    return snapshot.read_bytes(), sorted(EXPECTED_PACKAGES)


def profile_rows(profile: str) -> tuple[dict, Path, str]:
    config = MATERIALS["profiles"][profile]
    lock_path = PACKAGE / config["requirementsLock"]
    env_path = PACKAGE / config["environmentManifest"]
    require_hash(lock_path, config["requirementsLockSha256"])
    require_hash(env_path, config["environmentManifestSha256"])
    environment = json_file(env_path)
    rows = environment.get("wheels", environment.get("files"))
    if not isinstance(rows, list) or len(rows) != config["wheelCount"]:
        raise ValueError(f"{profile} wheel manifest count does not match the frozen build")
    if environment.get("requirementsLockSha256") not in (None, config["requirementsLockSha256"]):
        raise ValueError(f"{profile} environment points to a different requirements lock")
    return config, lock_path, profile


def verify_wheelhouse(wheelhouse: Path, rows: list[dict], common_manifest: dict) -> dict:
    files_dir = wheelhouse / "files"
    if not files_dir.is_dir():
        raise ValueError("wheelhouse must be the parent directory containing a files/ directory")
    expected = {row["filename"]: row for row in rows}
    actual = {path.name for path in files_dir.iterdir() if path.is_file()}
    if actual != set(expected) or any(path.is_dir() for path in files_dir.iterdir()):
        raise ValueError("wheelhouse file set differs from the exact selected profile")
    for name, row in expected.items():
        path = files_dir / name
        if path.stat().st_size != row["bytes"] or sha256(path) != row["sha256"]:
            raise ValueError(f"profile wheel mismatch: {name}")
    common_rows = common_manifest["files"]
    for row in common_rows:
        profile = expected.get(row["filename"])
        if not profile or profile["bytes"] != row["bytes"] or profile["sha256"] != row["sha256"]:
            raise ValueError(f"common wheel is not identical in the profile manifest: {row['filename']}")
    return {"wheelCount": len(expected), "wheelBytes": sum(row["bytes"] for row in rows),
            "commonWheelCount": len(common_rows)}


def verify_ffmpeg_artifacts(root: Path, manifest: dict) -> dict:
    entries = {row["path"]: row for row in manifest["entries"]}
    expected_files = {path for path, row in entries.items() if row["kind"] != "directory"}
    actual_files = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    if actual_files != expected_files:
        raise ValueError("FFmpeg output tree differs from its locked artifact manifest")
    for name in expected_files:
        row = entries[name]
        target = row.get("resolvedTarget", name)
        target_row = entries[target]
        path = root / Path(name)
        if path.stat().st_size != target_row["bytes"] or sha256(path) != target_row["sha256"]:
            raise ValueError(f"FFmpeg output artifact mismatch: {name}")
    return {"entryCount": len(entries), "fileCount": len(expected_files)}


def verify_debs(deb_dir: Path, lock_bytes: bytes) -> dict:
    rows = [line.decode("utf-8").split("\t") for line in lock_bytes.splitlines()
            if line.strip() and not line.lstrip().startswith(b"#")]
    expected = {row[3]: (int(row[4]), row[5]) for row in rows}
    actual = {path.name for path in deb_dir.iterdir() if path.is_file()}
    if actual != set(expected) or any(path.is_dir() for path in deb_dir.iterdir()):
        raise ValueError("native deb directory differs from the eight-package ACE subset")
    for name, (size, digest) in expected.items():
        path = deb_dir / name
        if path.stat().st_size != size or sha256(path) != digest:
            raise ValueError(f"native package archive mismatch: {name}")
    return {"packageCount": len(expected), "packageBytes": sum(size for size, _ in expected.values())}


def normalized_recipe_hash(path: Path, profile: str) -> str:
    content = path.read_bytes()
    content = content.replace(
        b"ARG ACE_SOURCE_TREE_SHA256=71e2fbd4c6e121999f33305fe7acfd7a34684277796c5bd50be4ba8b86b00e9b\n",
        b"ARG ACE_SOURCE_TREE_SHA256\n",
    )
    historical = MATERIALS["historicalSuccessfulBuildInputHashes"]
    original_rocm_env = historical["rocmEnvironmentManifestCrlfSha256"].encode("ascii")
    if profile == "cuda":
        content = content.replace(
            b"ARG ACE_REQUIREMENTS_SHA256=adf3f74303ce43f7f78df6914f36252d467b48c4661e5f7cc52b17c023109665\n",
            b"ARG ACE_REQUIREMENTS_SHA256=" + MATERIALS["profiles"]["rocm"]["requirementsLockSha256"].encode("ascii") + b"\n",
        )
        content = content.replace(
            b"ARG ACE_ENV_MANIFEST_SHA256=" + MATERIALS["profiles"]["cuda"]["environmentManifestSha256"].encode("ascii") + b"\n",
            b"ARG ACE_ENV_MANIFEST_SHA256=" + original_rocm_env + b"\n",
        )
    elif profile == "rocm":
        content = content.replace(
            b"ARG ACE_ENV_MANIFEST_SHA256=" + MATERIALS["profiles"]["rocm"]["environmentManifestSha256"].encode("ascii") + b"\n",
            b"ARG ACE_ENV_MANIFEST_SHA256=" + original_rocm_env + b"\n",
        )
    return hashlib.sha256(content).hexdigest()


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def prepare(profile: str, wheelhouse: Path, ffmpeg_artifacts: Path, ffmpeg_debs: Path,
            source_archive: Path, source_tree: Path, output: Path) -> dict:
    config, requirements_path, _ = profile_rows(profile)
    source_tree_info = verify_source_tree(source_tree)
    require_hash(source_archive, MATERIALS["upstream"]["archiveSha256"])
    require_hash(INPUTS / "ACE-Step-upstream-license.txt", MATERIALS["upstream"]["upstreamLicenseSha256"])
    require_hash(INPUTS / "source-tree-manifest.json", MATERIALS["upstream"]["sourceTreeManifestSha256"])
    require_hash(INPUTS / "common-wheelhouse-manifest.json", MATERIALS["wheelhouse"]["commonManifestSha256"])
    require_hash(INPUTS / "ffmpeg-output-artifact-manifest.json", MATERIALS["nativeAudio"]["ffmpegArtifactManifestSha256"])
    require_hash(INPUTS / "model-acquisition-verification.json", MATERIALS["models"]["acquisitionEvidenceSha256"])
    for name, digest in {
        "model-file-lock.json": MATERIALS["models"]["lockSha256"],
        "dwt1d-distribution.lock.json": "bec8338c20a276a73a5345b49eb4ea2163a02ba895bf1c79065b6da076dd9168",
    }.items():
        require_hash(INPUTS / name, digest)
    model_authority = PACKAGE / MATERIALS["models"]["lockPath"]
    require_hash(model_authority, MATERIALS["models"]["lockSha256"])
    if (INPUTS / "model-file-lock.json").read_bytes() != model_authority.read_bytes():
        raise ValueError("packaged model-lock snapshot differs from the canonical model lock")
    if normalized_recipe_hash(PACKAGE / config["dockerfile"], profile) != config["successfulRecipeSha256"]:
        raise ValueError(f"{profile} recipe differs from the successful frozen recipe outside documented defaults")
    patches = verify_patches()
    native_lock_bytes, native_packages = verify_native_subset()
    common_manifest = json_file(INPUTS / "common-wheelhouse-manifest.json")
    wheels = verify_wheelhouse(wheelhouse, json_file(PACKAGE / config["environmentManifest"]).get("wheels") or
                               json_file(PACKAGE / config["environmentManifest"]).get("files"), common_manifest)
    native = verify_debs(ffmpeg_debs, native_lock_bytes)
    ffmpeg_manifest = json_file(INPUTS / "ffmpeg-output-artifact-manifest.json")
    artifacts = verify_ffmpeg_artifacts(ffmpeg_artifacts, ffmpeg_manifest)
    if output.exists():
        raise ValueError(f"output already exists; preserve it and choose a new path: {output}")

    output.mkdir(parents=True, exist_ok=False)
    context = output / "context"
    context.mkdir(parents=True)
    copy_file(PACKAGE / config["dockerfile"], context / "Dockerfile")
    copy_file(PACKAGE / ".dockerignore", context / ".dockerignore")
    shutil.copytree(source_tree, context / "source" / SOURCE_NAME)
    shutil.copytree(INPUTS, context / "input")
    copy_file(source_archive, context / "input" / SOURCE_ARCHIVE_NAME)
    copy_file(PACKAGE / "local-model-root.patch", context / "input" / "patches" / "local-model-root.patch")
    copy_file(requirements_path, context / "input" / requirements_path.name)
    env_path = PACKAGE / config["environmentManifest"]
    copy_file(env_path, context / "input" / "environment-manifest.json")
    (context / "ffmpeg-native.lock").write_bytes(native_lock_bytes)
    shutil.copytree(ffmpeg_artifacts, context / "ffmpeg-artifacts")

    prepared = {
        "schemaVersion": 1,
        "profile": profile,
        "status": "context-prepared-not-built",
        "successfulImageId": config["successfulImageId"],
        "baseImageId": config["baseImageId"],
        "recipeSha256": sha256(context / "Dockerfile"),
        "requirementsLockSha256": sha256(context / "input" / requirements_path.name),
        "environmentManifestSha256": sha256(context / "input" / "environment-manifest.json"),
        "sourceArchive": {"bytes": source_archive.stat().st_size, "sha256": sha256(source_archive)},
        "sourceTree": source_tree_info,
        "patches": patches,
        "nativePackages": native_packages,
        "nativeLockSha256": sha256(context / "ffmpeg-native.lock"),
        "native": native,
        "ffmpegArtifacts": artifacts,
        "wheelhouse": wheels,
        "externalBuildContexts": {
            "ace-wheelhouse": str(wheelhouse.resolve()),
            "ffmpeg-debs": str(ffmpeg_debs.resolve()),
        },
    }
    prepared["contextFiles"] = {
        path.relative_to(context).as_posix(): {"bytes": path.stat().st_size, "sha256": sha256(path)}
        for path in sorted(context.rglob("*")) if path.is_file()
    }
    (output / "prepared-context.json").write_text(json.dumps(prepared, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return prepared


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("cuda", "rocm"), required=True)
    parser.add_argument("--wheelhouse", type=Path, required=True, help="parent directory containing files/ for the profile")
    parser.add_argument("--ffmpeg-artifacts", type=Path, required=True, help="verified FFmpeg output tree rooted at usr/")
    parser.add_argument("--ffmpeg-debs", type=Path, required=True, help="directory containing exactly the eight tested ACE runtime debs")
    parser.add_argument("--source-archive", type=Path, required=True, help="pinned upstream source archive; exact hash required")
    parser.add_argument("--source-tree", type=Path, required=True, help="patched source tree; every file must match the frozen manifest")
    parser.add_argument("--output", type=Path, required=True, help="new task-owned output directory; must not exist")
    args = parser.parse_args()
    try:
        result = prepare(args.profile, args.wheelhouse, args.ffmpeg_artifacts, args.ffmpeg_debs,
                         args.source_archive, args.source_tree, args.output.resolve())
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"context preparation failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps({key: result[key] for key in (
        "status", "profile", "recipeSha256", "requirementsLockSha256", "sourceTree", "nativeLockSha256", "native", "wheelhouse"
    )}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
