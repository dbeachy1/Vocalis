"""Regression checks for files Docker copies from the named source context."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from verify_source_context import canonical_json, verify


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class VerifySourceContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.payload = self.root / "payload"
        self.artifacts = self.root / "artifacts"
        self.payload.mkdir()
        self.artifacts.mkdir()
        self.offer = {
            "schemaVersion": 1,
            "product": "Vocalis",
            "productVersion": "12.0.0-M1",
            "componentLicenseScopes": [],
            "separateSourceMaterials": [],
        }
        self.write_payload("packaging/source-offer/source-offer.json", json.dumps(self.offer).encode())
        self.write_payload("README.md", b"Synthetic source fixture\n")
        allowlist = {
            "schemaVersion": 1,
            "roots": [],
            "files": ["README.md", "packaging/source-offer/allowlist.json", "packaging/source-offer/source-offer.json"],
        }
        self.write_payload("packaging/source-offer/allowlist.json", json.dumps(allowlist).encode())
        self.refresh_manifest_and_archive()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_payload(self, relative: str, content: bytes) -> None:
        path = self.payload / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def refresh_manifest_and_archive(self) -> None:
        paths = sorted(
            (path.relative_to(self.payload).as_posix() for path in self.payload.rglob("*") if path.is_file()),
            key=lambda value: value.encode("utf-8"),
        )
        files = []
        for relative in paths:
            data = (self.payload / relative).read_bytes()
            files.append({"path": relative, "size": len(data), "sha256": digest(data), "mode": 0o644})
        internal = {
            "schemaVersion": 1,
            "product": self.offer["product"],
            "productVersion": self.offer["productVersion"],
            "sourceRevision": "fixture-revision",
            "treeState": "clean",
            "selectedFileCount": len(files),
            "files": files,
            "componentLicenseScopes": self.offer["componentLicenseScopes"],
            "separateSourceMaterials": self.offer["separateSourceMaterials"],
        }
        archive_name = "vocalis-12.0.0-M1-source.zip"
        archive_path = self.artifacts / archive_name
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("SOURCE-MANIFEST.json", canonical_json(internal))
            for relative in paths:
                archive.writestr(relative, (self.payload / relative).read_bytes())
        archive_bytes = archive_path.read_bytes()
        manifest = {**internal, "archive": {"file": archive_name, "size": len(archive_bytes), "sha256": digest(archive_bytes)}}
        (self.artifacts / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        page = self.artifacts / "index.html"
        served = "".join(" /source/" + item["servedFile"] for item in self.offer["separateSourceMaterials"] if item.get("servedFile"))
        page.write_text(
            "Vocalis 12.0.0-M1 fixture-revision /source/" + archive_name + " " + digest(archive_bytes) + served,
            encoding="utf-8",
        )

    NOTICE_PATH = "packaging/licenses/NOTICE.md"

    def add_served_notice(self, notice: bytes = b"The notices", copy: bytes | None = b"The notices") -> None:
        """The offer names NOTICE.md as a file the page serves; `copy` is what sits beside the page (None: no copy)."""
        self.offer["separateSourceMaterials"] = [
            {"name": "Other third-party components", "status": "unmodified-third-party",
             "servedFile": "NOTICE.md", "archivePath": self.NOTICE_PATH}]
        self.write_payload("packaging/source-offer/source-offer.json", json.dumps(self.offer).encode())
        self.write_payload(self.NOTICE_PATH, notice)
        allowlist = {"schemaVersion": 1, "roots": [], "files": sorted(
            ["README.md", self.NOTICE_PATH, "packaging/source-offer/allowlist.json", "packaging/source-offer/source-offer.json"],
            key=lambda value: value.encode("utf-8"))}
        self.write_payload("packaging/source-offer/allowlist.json", json.dumps(allowlist).encode())
        self.refresh_manifest_and_archive()
        if copy is not None:
            (self.artifacts / "NOTICE.md").write_bytes(copy)

    def test_a_served_notice_that_matches_the_archive_copy_verifies(self) -> None:
        self.add_served_notice()
        result = verify(self.payload, self.artifacts)
        self.assertEqual(result["servedFiles"], ["NOTICE.md"])
        self.assertEqual(result["filesVerified"], 4)

    def test_a_served_notice_that_differs_from_the_archive_copy_is_rejected(self) -> None:
        self.add_served_notice(copy=b"Edited after the archive was made")
        with self.assertRaisesRegex(ValueError, "differs from packaging/licenses/NOTICE.md"):
            verify(self.payload, self.artifacts)

    def test_a_missing_served_notice_is_rejected(self) -> None:
        self.add_served_notice(copy=None)
        with self.assertRaisesRegex(ValueError, "artifact context"):
            verify(self.payload, self.artifacts)

    def test_an_unsafe_served_file_name_is_rejected(self) -> None:
        self.add_served_notice()
        self.offer["separateSourceMaterials"][0]["servedFile"] = "../NOTICE.md"
        self.write_payload("packaging/source-offer/source-offer.json", json.dumps(self.offer).encode())
        self.refresh_manifest_and_archive()
        with self.assertRaisesRegex(ValueError, "Unsafe served file name"):
            verify(self.payload, self.artifacts)

    def test_exact_payload_and_archive_verify(self) -> None:
        self.assertEqual(verify(self.payload, self.artifacts)["filesVerified"], 3)

    def test_extra_payload_file_is_rejected(self) -> None:
        (self.payload / "unlisted.txt").write_text("not in the archive", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "paths differ from manifest"):
            verify(self.payload, self.artifacts)

    def test_changed_selected_file_is_rejected(self) -> None:
        (self.payload / "README.md").write_text("changed after archive creation", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "payload mismatch"):
            verify(self.payload, self.artifacts)

    def test_omitted_selected_path_is_rejected_even_when_manifest_matches_payload(self) -> None:
        (self.payload / "README.md").unlink()
        self.refresh_manifest_and_archive()
        with self.assertRaisesRegex(ValueError, "embedded explicit allowlist"):
            verify(self.payload, self.artifacts)

    def test_missing_archive_is_rejected(self) -> None:
        (self.artifacts / "vocalis-12.0.0-M1-source.zip").unlink()
        with self.assertRaisesRegex(ValueError, "artifact context"):
            verify(self.payload, self.artifacts)

    def test_license_scope_must_be_included_in_source_payload(self) -> None:
        self.offer["componentLicenseScopes"] = [{"component": "fixture", "licenseFile": "omitted/LICENSE"}]
        self.write_payload("packaging/source-offer/source-offer.json", json.dumps(self.offer).encode())
        self.refresh_manifest_and_archive()
        with self.assertRaisesRegex(ValueError, "License scope file is not included"):
            verify(self.payload, self.artifacts)

    def test_symlink_escape_is_rejected_when_supported(self) -> None:
        outside = self.root / "outside.txt"
        outside.write_text("outside", encoding="utf-8")
        try:
            (self.payload / "escape.txt").symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable in this environment")
        with self.assertRaisesRegex(ValueError, "Symlink or reparse point"):
            verify(self.payload, self.artifacts)


if __name__ == "__main__":
    unittest.main()
