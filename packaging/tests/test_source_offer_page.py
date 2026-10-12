"""Tests for the "Source code for this build" page and archive builder (packaging/source-offer, October 11, 2026):
the third-party entry is a plain statement with a link to the license notices, and the builder can write its
output outside the work folder. The end-to-end test needs git (the Linux test container has none) and skips without it."""

import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1]
REPO = PACKAGING.parent
OFFER_DIR = PACKAGING / "source-offer"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, OFFER_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


builder = _load("build_source_offer")
verifier = _load("verify_source_context")
OFFER = json.loads((OFFER_DIR / "source-offer.json").read_text(encoding="utf-8"))
ALLOWLIST = json.loads((OFFER_DIR / "allowlist.json").read_text(encoding="utf-8"))

MANIFEST = {"archive": {"file": "vocalis-12.0.0-M1-source.zip", "sha256": "ab" * 32},
            "sourceRevision": "0123456789abcdef", "treeState": "clean"}


def _page(offer=OFFER):
    return builder.render_page(MANIFEST, offer).decode("utf-8")


def test_the_third_party_entry_is_a_plain_statement_not_a_pending_delivery():
    third = [m for m in OFFER["separateSourceMaterials"] if m["name"].startswith("Other third-party")]
    assert len(third) == 1
    entry = third[0]
    assert entry["status"] == "unmodified-third-party"
    assert "pending" not in json.dumps(OFFER).lower()
    assert "used unmodified" in entry["notes"]
    assert entry["archivePath"] == "packaging/licenses/NOTICE.md" and entry["servedFile"] == "NOTICE.md"
    assert entry["archivePath"] in ALLOWLIST["files"] and (REPO / entry["archivePath"]).is_file()


def test_the_page_says_so_and_links_the_notices_as_served():
    page = _page()
    assert "delivery pending" not in page and "pending" not in page.lower()
    assert "Other third-party open-source components" in page
    assert "used unmodified" in page
    assert '<a href="/source/NOTICE.md">NOTICE.md</a>' in page
    assert "<code>packaging/licenses/NOTICE.md</code>" in page


def test_the_ffmpeg_entry_links_the_official_tarball_with_its_checksum():
    page = _page()
    assert '<a href="https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz">FFmpeg 8.0.1 source archive</a>' in page
    assert "05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41" in page
    ffmpeg = [m for m in OFFER["separateSourceMaterials"] if m["name"].startswith("FFmpeg")][0]
    contract = json.loads((PACKAGING / "ffmpeg" / "build-contract.json").read_text(encoding="utf-8"))
    assert (ffmpeg["url"], ffmpeg["sha256"]) == (contract["source"]["url"], contract["source"]["sha256"])
    assert "Dockerfile.app" in ffmpeg["notes"] and "ffmpeg-native.lock" in ffmpeg["notes"]


def test_an_unknown_status_is_refused_instead_of_shown_as_something_else():
    offer = json.loads(json.dumps(OFFER))
    offer["separateSourceMaterials"][1]["status"] = "pending-recipient-accessible-delivery"
    with pytest.raises(ValueError, match="Unknown source material status"):
        _page(offer)


def test_the_output_folder_default_is_kept_and_the_new_option_is_bounded(tmp_path):
    roots = ALLOWLIST["roots"]
    codex = REPO / ".codex" / "somewhere"
    builder.check_output_location(codex.resolve(), roots, False)  # the default still works
    with pytest.raises(ValueError, match=r"--outside-codex"):
        builder.check_output_location((tmp_path / "out").resolve(), roots, False)
    builder.check_output_location((tmp_path / "out").resolve(), roots, True)
    for inside in ("packaging", "packaging/licenses/x", "source/taproom", "source/vocalis/sillytavern/extension/new"):
        with pytest.raises(ValueError, match="must not be inside the source roots"):
            builder.check_output_location((REPO / inside).resolve(), roots, True)
    # a sibling of a root with a similar name is fine
    builder.check_output_location((REPO / "packaging-output").resolve(), roots, True)


def test_the_option_is_offered_on_the_command_line():
    text = (OFFER_DIR / "build_source_offer.py").read_text(encoding="utf-8")
    assert '"--outside-codex"' in text and "outside_codex=args.outside_codex" in text


def test_the_archive_page_and_served_notice_are_built_and_verified_outside_the_work_folder():
    if shutil.which("git") is None:
        pytest.skip("the end-to-end build needs git (the Linux test container has none)")
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary).resolve() / "offer"
        result = builder.build_context(output, outside_codex=True)
        artifacts = output / "taproom-source" / "artifacts"
        payload = output / "taproom-source" / "payload"
        assert (artifacts / "NOTICE.md").read_bytes() == (REPO / "packaging/licenses/NOTICE.md").read_bytes()
        assert sorted(p.name for p in artifacts.iterdir()) == sorted(
            ["NOTICE.md", "index.html", "manifest.json", f"vocalis-{OFFER['productVersion']}-source.zip"])
        page = (artifacts / "index.html").read_text(encoding="utf-8")
        assert '/source/NOTICE.md' in page and "pending" not in page.lower()
        verified = verifier.verify(payload, artifacts)
        assert verified["servedFiles"] == ["NOTICE.md"]
        assert verified["filesVerified"] == result["selectedFileCount"] == len(ALLOWLIST["files"])
        # a second run into the same place is refused, as before
        with pytest.raises(FileExistsError):
            builder.build_context(output, outside_codex=True)
