"""Tests for packaging/ffmpeg/prepare_ffmpeg_contexts.py, the step that prepares the `ffmpeg-source` and
`ffmpeg-debs` build contexts from the publishers' downloads (October 11, 2026). No network: a stub downloader
stands in for the servers, and the tracked records are checked as files."""

import hashlib
import importlib.util
import json
import re
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1]


def _load(name, relative):
    spec = importlib.util.spec_from_file_location(name, PACKAGING / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prep = _load("prepare_ffmpeg_contexts", "ffmpeg/prepare_ffmpeg_contexts.py")
helper = _load("build_main_app_for_ffmpeg_contexts", "build_main_app.py")

CONTRACT = json.loads((PACKAGING / "ffmpeg" / "build-contract.json").read_text(encoding="utf-8"))
DOCKERFILE_APP = (PACKAGING / "main-cuda" / "Dockerfile.app").read_text(encoding="utf-8")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _fixture(tmp_path, *, tamper=None):
    """A contract and lock for stand-in files, plus a stub downloader that serves their bytes.
    `tamper` names a file name whose served bytes differ from the recorded ones."""
    served = {}
    source_bytes = b"stand-in ffmpeg source archive"
    served["https://ffmpeg.example/ffmpeg-8.0.1.tar.xz"] = source_bytes
    urls = {}
    lock_lines = ["# stand-in lock"]
    for index in range(9):
        name = f"lib{index}_1.0_amd64.deb"
        data = f"stand-in package {index}".encode()
        url = f"https://archive.example/pool/{name}"
        urls[name] = url
        served[url] = data
        lock_lines.append("\t".join([f"lib{index}", "1.0", "amd64", name, str(len(data)), _sha(data)]))
    contract = {"source": {"file": "ffmpeg_8.0.1.orig.tar.xz", "url": "https://ffmpeg.example/ffmpeg-8.0.1.tar.xz",
                           "bytes": len(source_bytes), "sha256": _sha(source_bytes)},
                "runtimePackageUrls": urls}
    contract_path = tmp_path / "contract.json"
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    lock_path = tmp_path / "native.lock"
    lock_path.write_text("\n".join(lock_lines) + "\n", encoding="utf-8")
    if tamper:
        for url in list(served):
            if url.endswith(tamper):
                served[url] = served[url] + b"!"
    requests = []

    def fetch(url, destination, limit):
        requests.append(url)
        destination.write_bytes(served[url])

    return contract_path, lock_path, fetch, requests


def test_prepares_both_contexts_and_verifies_every_file(tmp_path):
    contract_path, lock_path, fetch, requests = _fixture(tmp_path)
    output = tmp_path / "out"
    result = prep.prepare(output, contract_path=contract_path, lock_path=lock_path, fetch=fetch)
    assert (output / "ffmpeg-source" / "ffmpeg_8.0.1.orig.tar.xz").read_bytes() == b"stand-in ffmpeg source archive"
    assert len(list((output / "ffmpeg-debs").iterdir())) == 9
    assert len(result["files"]) == 10 and len(requests) == 10
    assert not list(output.rglob("*.partial"))


def test_a_changed_package_is_refused_and_nothing_is_left_behind(tmp_path):
    contract_path, lock_path, fetch, _ = _fixture(tmp_path, tamper="lib4_1.0_amd64.deb")
    output = tmp_path / "out"
    with pytest.raises(prep.ContextError, match="mismatch for lib4_1.0_amd64.deb"):
        prep.prepare(output, contract_path=contract_path, lock_path=lock_path, fetch=fetch)
    assert not output.exists()


def test_a_changed_source_archive_is_refused(tmp_path):
    contract_path, lock_path, fetch, requests = _fixture(tmp_path, tamper="ffmpeg-8.0.1.tar.xz")
    with pytest.raises(prep.ContextError, match="mismatch for ffmpeg_8.0.1.orig.tar.xz"):
        prep.prepare(tmp_path / "out", contract_path=contract_path, lock_path=lock_path, fetch=fetch)
    # The source archive is fetched first: a bad one stops the step before any package is downloaded.
    assert requests == ["https://ffmpeg.example/ffmpeg-8.0.1.tar.xz"]


def test_a_wrong_size_alone_is_refused(tmp_path):
    contract_path, lock_path, fetch, _ = _fixture(tmp_path)
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    contract["source"]["bytes"] += 1
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    with pytest.raises(prep.ContextError, match="Size mismatch"):
        prep.prepare(tmp_path / "out", contract_path=contract_path, lock_path=lock_path, fetch=fetch)


def test_an_existing_folder_with_content_is_refused(tmp_path):
    contract_path, lock_path, fetch, requests = _fixture(tmp_path)
    output = tmp_path / "out"
    output.mkdir()
    (output / "old.txt").write_text("x", encoding="utf-8")
    with pytest.raises(prep.ContextError, match="already has content"):
        prep.prepare(output, contract_path=contract_path, lock_path=lock_path, fetch=fetch)
    assert requests == []
    assert (output / "old.txt").exists()


def test_the_default_downloader_refuses_anything_but_https(tmp_path):
    with pytest.raises(prep.ContextError, match="https"):
        prep.default_fetch("http://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz", tmp_path / "x", 10)


def test_the_tracked_records_name_a_url_for_the_source_and_each_of_the_nine_packages():
    source = CONTRACT["source"]
    assert source["url"] == "https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz"
    assert source["file"] == "ffmpeg_8.0.1.orig.tar.xz"
    # The Dockerfile checks the same hash and file name that the step verifies.
    assert f"'{source['sha256']}' '/ffmpeg-source/{source['file']}'" in DOCKERFILE_APP
    rows = prep.read_runtime_lock(PACKAGING / "main-cuda" / "ffmpeg-native.lock")
    assert len(rows) == 9
    urls = CONTRACT["runtimePackageUrls"]
    assert set(urls) == {row["filename"] for row in rows}
    for name, url in urls.items():
        assert re.fullmatch(r"https://archive\.ubuntu\.com/ubuntu/pool/main/[a-z0-9]+/[a-z0-9.+-]+/" + re.escape(name), url), url


def test_the_record_files_carry_no_pointer_into_the_private_work_folder():
    assert ".codex" not in (PACKAGING / "ffmpeg" / "build-contract.json").read_text(encoding="utf-8")


def test_build_main_app_reads_a_named_folder_and_keeps_its_default():
    folder = Path("prepared")
    source, debs = helper.ffmpeg_input_paths(CONTRACT, Path("root"), folder)
    assert source == folder / "ffmpeg-source" / "ffmpeg_8.0.1.orig.tar.xz"
    assert debs == folder / "ffmpeg-debs"
    default_source, default_debs = helper.ffmpeg_input_paths(CONTRACT, Path("root"), None)
    assert default_source == Path("root") / helper.FFMPEG_SOURCE_DEFAULT
    assert default_debs == Path("root") / helper.FFMPEG_DEBS
    assert helper.FFMPEG_SOURCE_DEFAULT.endswith("/" + CONTRACT["source"]["file"])


def test_build_main_app_offers_the_folder_as_an_option():
    text = (PACKAGING / "build_main_app.py").read_text(encoding="utf-8")
    assert '"--ffmpeg-contexts"' in text
    assert "ffmpeg_contexts" in text.split("def prepare_contexts", 1)[1].split("def main", 1)[0]
