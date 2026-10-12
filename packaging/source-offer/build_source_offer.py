#!/usr/bin/env python3
"""Create a deterministic Taproom source archive and its required build context."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import html
import json
import re
import shutil
import stat
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
ALLOWLIST_PATH = SCRIPT_DIR / "allowlist.json"
OFFER_PATH = SCRIPT_DIR / "source-offer.json"
CONTEXT_DOCKERIGNORE = "*\n!Dockerfile\n"
FORBIDDEN_PARTS = {".git", ".codex", "node_modules", "__pycache__", ".pytest_cache", ".venv", "venv"}
FORBIDDEN_SUFFIXES = {".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".onnx", ".onnx_data"}


def _personal_paths() -> tuple[bytes, ...]:
    """Development-machine paths that must never ship: the folder that holds this checkout (and so every
    sibling project and probe folder in it), and the profile folder of whoever runs the build. Both are read
    from this machine rather than written here. October 10, 2026: the earlier list spelled out one project
    folder and a user name, so lock-file comments naming this checkout's own folder passed, and the list
    itself shipped the user name in the archive it guards."""
    user = getpass.getuser().encode()
    paths = []
    for folder in (REPO_ROOT.parent, Path.home()):
        text = str(folder).encode()
        paths += [text + b"\\", text.replace(b"\\", b"/") + b"/"]
    return tuple(paths) + (b"/home/" + user + b"/",)


FORBIDDEN_TEXT = _personal_paths()


def run_git(*args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(REPO_ROOT), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    ).stdout


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")


def normalized_path(value: str) -> PurePosixPath:
    if not value or "\\" in value or "\x00" in value or "\n" in value or "\r" in value:
        raise ValueError(f"Invalid allowlist path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"Unsafe allowlist path: {value!r}")
    if any(part.casefold() in FORBIDDEN_PARTS for part in path.parts):
        raise ValueError(f"Excluded path is present in source allowlist: {value}")
    if path.suffix.casefold() in FORBIDDEN_SUFFIXES:
        raise ValueError(f"Model-weight extension is forbidden: {value}")
    return path


def selected_file_inventory(roots: list[str]) -> list[str]:
    raw = run_git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", *roots)
    paths = [entry.decode("utf-8") for entry in raw.split(b"\0") if entry]
    return sorted(paths, key=lambda value: value.encode("utf-8"))


def validate_sources(root: Path, paths: list[str]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for relative in paths:
        rel = normalized_path(relative)
        candidate = root.joinpath(*rel.parts)
        cursor = root
        for part in rel.parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ValueError(f"Symlink is not allowed in source archive: {relative}")
        if not candidate.is_file():
            raise ValueError(f"Allowlisted source file is missing: {relative}")
        data = candidate.read_bytes()
        lowered = data.lower()
        for forbidden in FORBIDDEN_TEXT:
            if forbidden.lower() in lowered:
                raise ValueError(f"Personal development path found in source file: {relative}")
        mode = stat.S_IMODE(candidate.stat().st_mode)
        records.append({"path": relative, "sha256": sha256(data), "size": len(data), "mode": mode})
    return records


def source_version(offer: dict[str, object]) -> str:
    value = offer.get("productVersion")
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z][A-Za-z0-9.-]*)?", value):
        raise ValueError("source-offer.json must declare a semantic productVersion")
    return value


def render_page(manifest: dict[str, object], offer: dict[str, object]) -> bytes:
    archive = manifest["archive"]
    scopes = offer["componentLicenseScopes"]
    materials = offer["separateSourceMaterials"]
    rows = "\n".join(
        "<li><strong>{}</strong>: {}. See <code>{}</code> in the source archive.</li>".format(
            html.escape(str(item["component"])),
            html.escape(str(item["license"])),
            html.escape(str(item["licenseFile"])),
        )
        for item in scopes
    )
    source_rows = []
    for item in materials:
        title = html.escape(str(item["name"]))
        status = str(item["status"])
        notes = html.escape(str(item.get("notes", "")))
        if status == "available-upstream":
            url = html.escape(str(item["url"]), quote=True)
            checksum = html.escape(str(item["sha256"]))
            source_rows.append(f'<li><a href="{url}">{title}</a> (SHA-256 <code>{checksum}</code>). {notes}</li>')
        elif status == "unmodified-third-party":
            # October 11, 2026: replaces the "delivery pending" entry. The third-party open-source components are used
            # unmodified; the license notices say where each one's source is published. The notices file is served
            # beside this page (servedFile) and is also in the archive (archivePath).
            served = html.escape(str(item["servedFile"]), quote=True)
            archived = html.escape(str(item["archivePath"]))
            source_rows.append(
                f'<li><strong>{title}.</strong> {notes} Read the list: <a href="/source/{served}">{html.escape(str(item["servedFile"]))}</a> '
                f"(in the source archive: <code>{archived}</code>, with the component records beside it).</li>"
            )
        else:
            raise ValueError(f"Unknown source material status: {status!r}")
    materials_html = "\n".join(source_rows)
    tree_description = "clean source snapshot" if manifest["treeState"] == "clean" else "dirty development snapshot"
    page = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Source code for this build</title>
</head>
<body>
  <main>
    <h1>Source code for this build</h1>
    <p>{html.escape(str(offer['product']))} {html.escape(source_version(offer))}</p>
    <p>Source revision: <code>{html.escape(str(manifest['sourceRevision']))}</code>
       ({html.escape(tree_description)}; see the file manifest for exact input hashes).</p>
    <p><a href="/source/{html.escape(str(archive['file']), quote=True)}" download>Download the matching source archive</a></p>
    <p>Archive SHA-256: <code>{html.escape(str(archive['sha256']))}</code></p>
    <h2>Component license scopes</h2>
    <ul>{rows}</ul>
    <p>The archive contains the exact selected source inputs, license files, notices and build/configuration inputs listed in its manifest. The root Apache-2.0 license does not replace the component licenses.</p>
    <h2>Additional source materials</h2>
    <ul>{materials_html}</ul>
  </main>
</body>
</html>
"""
    return page.encode("utf-8")


def check_output_location(output: Path, roots: list[str], outside_codex: bool) -> None:
    """The default (kept) is an output folder under this checkout's ignored .codex folder. With `outside_codex`
    the caller may name any new folder, except one inside the checkout's own source roots: files written there
    would turn up as unlisted source files in the next inventory."""
    codex_root = (REPO_ROOT / ".codex").resolve()
    if output.is_relative_to(codex_root):
        print(f"source-offer output {output}: under the ignored .codex folder (default)", file=sys.stderr)
        return
    if not outside_codex:
        raise ValueError("Output must be under this checkout's ignored .codex directory "
                         "(or pass --outside-codex to name a folder elsewhere)")
    for root in roots:
        selected = (REPO_ROOT / root).resolve()
        if output == selected or output.is_relative_to(selected):
            raise ValueError(f"Output must not be inside the source roots the archive is built from: {root}")
    print(f"source-offer output {output}: outside .codex, allowed by --outside-codex", file=sys.stderr)


def build_context(output: Path, outside_codex: bool = False) -> dict[str, object]:
    allowlist = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    offer = json.loads(OFFER_PATH.read_text(encoding="utf-8"))
    check_output_location(output, allowlist.get("roots", []) if isinstance(allowlist.get("roots"), list) else [], outside_codex)
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite source-offer output: {output}")
    if allowlist.get("schemaVersion") != 1 or offer.get("schemaVersion") != 1:
        raise ValueError("Unsupported source-offer metadata schema")
    roots = allowlist.get("roots")
    paths = allowlist.get("files")
    if not isinstance(roots, list) or not all(isinstance(item, str) for item in roots):
        raise ValueError("Allowlist roots must be a string list")
    if not isinstance(paths, list) or not all(isinstance(item, str) for item in paths):
        raise ValueError("Allowlist files must be a string list")
    normalized = [str(normalized_path(item)) for item in paths]
    if normalized != paths or paths != sorted(set(paths), key=lambda value: value.encode("utf-8")):
        raise ValueError("Allowlist paths must be normalized, unique and bytewise sorted")
    actual = selected_file_inventory(roots)
    if actual != paths:
        missing = sorted(set(paths) - set(actual))
        unlisted = sorted(set(actual) - set(paths))
        raise ValueError(f"Source allowlist is stale (missing={len(missing)}, unlisted={len(unlisted)})")
    records = validate_sources(REPO_ROOT, paths)
    revision = run_git("rev-parse", "HEAD").decode("ascii").strip()
    dirty = run_git("status", "--porcelain", "--untracked-files=normal", "--", *roots)
    manifest_base: dict[str, object] = {
        "schemaVersion": 1,
        "product": offer["product"],
        "productVersion": source_version(offer),
        "sourceRevision": revision,
        "treeState": "dirty development snapshot" if dirty else "clean",
        "selectedFileCount": len(records),
        "files": records,
        "componentLicenseScopes": offer["componentLicenseScopes"],
        "separateSourceMaterials": offer["separateSourceMaterials"],
    }
    output.mkdir(parents=True)
    named = output / "taproom-source"
    build = output / "build"
    payload = named / "payload"
    artifacts = named / "artifacts"
    payload.mkdir(parents=True)
    artifacts.mkdir()
    build.mkdir()

    for record in records:
        relative = str(record["path"])
        destination = payload.joinpath(*PurePosixPath(relative).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO_ROOT / relative, destination)

    version = source_version(offer)
    archive_name = f"vocalis-{version}-source.zip"
    archive_path = artifacts / archive_name
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
        info = zipfile.ZipInfo("SOURCE-MANIFEST.json", date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        archive.writestr(info, json_bytes(manifest_base))
        for record in records:
            relative = str(record["path"])
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            mode = int(record["mode"])
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, (payload / relative).read_bytes())
    archive_bytes = archive_path.read_bytes()
    manifest = dict(manifest_base)
    manifest["archive"] = {"file": archive_name, "sha256": sha256(archive_bytes), "size": len(archive_bytes)}
    (artifacts / "manifest.json").write_bytes(json_bytes(manifest))
    (artifacts / "index.html").write_bytes(render_page(manifest, offer))
    for item in offer["separateSourceMaterials"]:
        if item.get("servedFile"):
            # The page links this file at /source/<servedFile>; it is the payload's own copy, byte for byte.
            shutil.copyfile(payload.joinpath(*PurePosixPath(str(item["archivePath"])).parts), artifacts / str(item["servedFile"]))
            print(f"source-offer page serves {item['servedFile']} (copy of {item['archivePath']}, "
                  f"{(artifacts / str(item['servedFile'])).stat().st_size} bytes)", file=sys.stderr)
    shutil.copyfile(payload / "packaging/taproom/Dockerfile", build / "Dockerfile")
    (build / ".dockerignore").write_text(CONTEXT_DOCKERIGNORE, encoding="ascii", newline="\n")
    verify = {
        "sourceRevision": revision,
        "selectedFileCount": len(records),
        "archiveSha256": sha256(archive_bytes),
        "archiveSize": len(archive_bytes),
        "allowlistSha256": sha256(ALLOWLIST_PATH.read_bytes()),
        "sourceOfferMetadataSha256": sha256(OFFER_PATH.read_bytes()),
    }
    (output / "context-record.json").write_bytes(json_bytes(verify))
    return {**verify, "output": str(output), "archive": str(archive_path), "manifest": str(artifacts / "manifest.json")}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path,
                        help="A fresh output directory; by default it must be under this checkout's ignored .codex folder")
    parser.add_argument("--outside-codex", action="store_true",
                        help="Allow the output directory to be anywhere that is not inside the archive's own source roots")
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else REPO_ROOT / args.output
    try:
        result = build_context(output.resolve(), outside_codex=args.outside_codex)
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"source-offer build failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
