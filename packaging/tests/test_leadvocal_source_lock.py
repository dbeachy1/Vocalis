"""Checks that the Lead Vocal engine's audio-separator derivation is one consistent record (October 12, 2026).
No Docker and no network: they read the tracked files in packaging/leadvocal.

Why this exists: `0.44.5+vocalis.1` shipped with upstream's `librosa.get_duration(filename=...)` in
`CommonSeparator.write_audio`. The locks pin librosa 1.0.0, which removed that keyword, so every save of a
separated stem raised TypeError. `0.44.5+vocalis.2` changes the call to `path=`. These tests hold in place that
- the patch carries the corrected call and the version the lock says;
- the patch file, the derived version, and the wheel hash are the same in the source lock, both requirements
  inputs, both hash locks, and the Dockerfile's version check, so a change to one without the others fails here
  and not in a half-hour image build;
- the profile hashes the source lock records are the hashes of the files that are actually tracked.
"""

import hashlib
import json
import re
from pathlib import Path

PACKAGING = Path(__file__).resolve().parents[1]
LEADVOCAL = PACKAGING / "leadvocal"

PATCH = (LEADVOCAL / "audio-separator.patch").read_bytes()
PATCH_TEXT = PATCH.decode("utf-8")
SOURCE_LOCK = json.loads((LEADVOCAL / "audio-separator-source.lock.json").read_text(encoding="utf-8"))
FILE_MANIFEST = json.loads((LEADVOCAL / "audio-separator-source-files.json").read_text(encoding="utf-8"))
DOCKERFILE = (LEADVOCAL / "Dockerfile").read_text(encoding="utf-8")

COMMON_SEPARATOR = "audio_separator/separator/common_separator.py"
OLD_CALL = "librosa.get_duration(filename=self.audio_file_path)"
NEW_CALL = "librosa.get_duration(path=self.audio_file_path)"


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _lock_entry(profile):
    """(version, [hashes]) of the audio-separator requirement in a profile's hash lock."""
    text = (LEADVOCAL / SOURCE_LOCK["profiles"][profile]["requirements_lock"]).read_text(encoding="utf-8")
    match = re.search(r"^audio-separator==(\S+) \\\n((?:\s+--hash=sha256:[0-9a-f]{64}(?: \\)?\n)+)", text, re.MULTILINE)
    assert match, f"{profile} lock has no audio-separator entry"
    return match.group(1), re.findall(r"sha256:([0-9a-f]{64})", match.group(2))


def _patch_hunks(path):
    """The '-' and '+' lines of the patch's section for one file."""
    section = re.search(r"^--- a/" + re.escape(path) + r"\n\+\+\+ b/" + re.escape(path) + r"\n(.*?)(?=^--- a/|\Z)",
                        PATCH_TEXT, re.MULTILINE | re.DOTALL)
    assert section, f"patch has no section for {path}"
    lines = section.group(1).splitlines()
    return ([l[1:] for l in lines if l.startswith("-")], [l[1:] for l in lines if l.startswith("+")])


def test_patch_replaces_the_removed_librosa_keyword_in_write_audio():
    removed, added = _patch_hunks(COMMON_SEPARATOR)
    assert [l.strip() for l in removed] == [f"duration_seconds = {OLD_CALL}"]
    assert [l.strip() for l in added] == [f"duration_seconds = {NEW_CALL}"]
    assert "filename=" not in NEW_CALL and "path=" in NEW_CALL


def test_patch_keeps_the_two_metadata_changes():
    removed, added = _patch_hunks("pyproject.toml")
    assert 'version = "0.44.5"' in removed
    assert any(re.fullmatch(r'version = "0\.44\.5\+vocalis\.\d+"', l) for l in added)
    assert 'diffq = { version = ">=0.2", platform = "!=win32" }' in removed
    assert not any(l.startswith("diffq") for l in added)


def test_patch_touches_only_the_files_the_lock_names():
    patched = re.findall(r"^\+\+\+ b/(\S+)$", PATCH_TEXT, re.MULTILINE)
    named = ["pyproject.toml"] + [row["path"] for row in SOURCE_LOCK["patch"]["runtime_source_files"]]
    assert sorted(patched) == sorted(named)
    assert SOURCE_LOCK["expected_result"]["runtime_source_changes"] == len(SOURCE_LOCK["patch"]["runtime_source_files"])


def test_source_lock_records_this_patch_and_the_changed_runtime_file():
    assert SOURCE_LOCK["patch"]["path"] == "audio-separator.patch"
    assert SOURCE_LOCK["patch"]["sha256"] == hashlib.sha256(PATCH).hexdigest()
    row, = SOURCE_LOCK["patch"]["runtime_source_files"]
    assert row["path"] == COMMON_SEPARATOR and row["lines_changed"] == 1
    manifest_row, = [r for r in FILE_MANIFEST["files"] if r["path"] == COMMON_SEPARATOR]
    assert row["upstream_sha256"] == manifest_row["sha256"]
    assert row["patched_sha256"] != row["upstream_sha256"]
    assert any(COMMON_SEPARATOR in change and "path=" in change for change in SOURCE_LOCK["patch"]["changes"])


def test_source_lock_package_manifest_hash_is_the_tracked_manifest():
    assert SOURCE_LOCK["source"]["package_file_manifest"] == "audio-separator-source-files.json"
    assert SOURCE_LOCK["source"]["package_file_manifest_sha256"] == _sha(LEADVOCAL / "audio-separator-source-files.json")


def test_derived_version_is_the_same_everywhere():
    version = SOURCE_LOCK["derived_version"]
    assert re.fullmatch(r"0\.44\.5\+vocalis\.\d+", version)
    assert f'+version = "{version}"' in PATCH_TEXT
    assert SOURCE_LOCK["patch"]["changes"][0] == f"tool.poetry.version: 0.44.5 -> {version}"
    assert SOURCE_LOCK["expected_result"]["filename"] == f"audio_separator-{version}-py3-none-any.whl"
    assert SOURCE_LOCK["build_proof"]["derived_wheel"]["filename"] == SOURCE_LOCK["expected_result"]["filename"]
    assert SOURCE_LOCK["build_proof"]["metadata_diff"]["derivedVersion"] == f"Version: {version}"
    assert f'importlib.metadata.version("audio-separator") == "{version}"' in DOCKERFILE
    for profile, extra in (("cuda", "gpu"), ("rocm", "cpu")):
        requirements_in = (LEADVOCAL / SOURCE_LOCK["profiles"][profile]["requirements_input"]).read_text(encoding="utf-8")
        assert f"audio-separator[{extra}]=={version}" in requirements_in.splitlines()
        assert _lock_entry(profile)[0] == version


def test_both_hash_locks_pin_the_derived_wheel_recorded_in_the_source_lock():
    wheel_sha = SOURCE_LOCK["build_proof"]["derived_wheel"]["sha256"]
    assert SOURCE_LOCK["build_proof"]["repeat_wheel_sha256"] == wheel_sha
    assert SOURCE_LOCK["build_proof"]["pep517_frontend_check"]["wheel_sha256"] == wheel_sha
    assert SOURCE_LOCK["build_proof"]["identical_independent_builds"] is True
    assert SOURCE_LOCK["build_proof"]["pep517_frontend_check"]["matches_backend_wheel"] is True
    for profile in ("cuda", "rocm"):
        assert _lock_entry(profile)[1] == [wheel_sha], profile


def test_profile_hashes_in_the_source_lock_are_the_tracked_files():
    for profile, record in SOURCE_LOCK["profiles"].items():
        assert record["requirements_input_sha256"] == _sha(LEADVOCAL / record["requirements_input"]), profile
        assert record["requirements_lock_sha256"] == _sha(LEADVOCAL / record["requirements_lock"]), profile
