"""Tests for packaging/models/fetch_models.py, the setup-time model fetcher.

No live network: the transport is an SSL-free urllib HTTPS handler injected through
fetch_models.make_opener, so the real redirect guard, size/hash verification, retries and
atomic rename all run. Everything happens in tmp dirs with fake environment values.
"""

import contextlib
import email.message
import hashlib
import http.client
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
import urllib.response
import zipfile
from pathlib import Path

import pytest


PACKAGING = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("fetch_models", PACKAGING / "models" / "fetch_models.py")
fm = importlib.util.module_from_spec(_spec)
sys.modules["fetch_models"] = fm  # dataclasses resolves string annotations through sys.modules
_spec.loader.exec_module(fm)


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def blob(body):
    return hashlib.sha1(b"blob %d\0" % len(body) + body).hexdigest()


def make_zip(members, compression=zipfile.ZIP_DEFLATED):
    """A zip of {archive member name: bytes}; names are used as given (no normalization)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as bundle:
        for name, body in members.items():
            bundle.writestr(zipfile.ZipInfo(name), body, compress_type=compression)
    return buffer.getvalue()


class FakeHttps(urllib.request.HTTPSHandler):
    """Serves routes {url: (status, headers, body)} without sockets or TLS."""

    def __init__(self, routes):
        super().__init__()
        self.routes = routes
        self.requested = []

    def https_open(self, request):
        url = request.full_url
        self.requested.append(url)
        if url not in self.routes:
            raise urllib.error.URLError(f"no route for {url}")
        status, headers, body = self.routes[url]
        message = email.message.Message()
        for key, value in headers.items():
            message[key] = value
        response = urllib.response.addinfourl(io.BytesIO(body), message, url, status)
        response.msg = http.client.responses.get(status, "")
        return response


class DroppingBody(io.BytesIO):
    """A body that delivers `fail_after` bytes and then raises like a dropped connection."""

    def __init__(self, data, fail_after):
        super().__init__(data)
        self.fail_after = fail_after

    def read(self, size=-1):
        if self.tell() >= self.fail_after:
            raise ConnectionResetError("connection dropped")
        room = self.fail_after - self.tell()
        return super().read(room if size is None or size < 0 else min(size, room))


class RangeHttps(FakeHttps):
    """A range-capable server for one URL (`target`) whose answers can be cut short or misbehave.

    cuts: per request to the target, in order, how many body bytes that answer delivers before the
    transfer fails (None or exhausted = the whole body). drop: "short" ends the stream cleanly early
    (a truncation), "reset" raises ConnectionResetError. ranged: how a Range request is answered:
    "206" correctly, "ignore" (a plain 200 with the whole file), "bad-start", "bad-total",
    "no-header" (a 206 with a wrong or missing Content-Range), "416", or "corrupt" (a correct 206
    whose bytes are wrong). seen records (url, Range header) for every request, redirects included."""

    def __init__(self, routes, target, *, cuts=(), drop="short", ranged="206"):
        super().__init__(routes)
        self.target, self.cuts, self.drop, self.ranged = target, list(cuts), drop, ranged
        self.seen = []
        self.sent = []  # body bytes the target answers actually carried, before any cut

    def https_open(self, request):
        url = request.full_url
        range_header = request.get_header("Range")
        self.seen.append((url, range_header))
        if url != self.target:
            return super().https_open(request)
        self.requested.append(url)
        status, headers, body = self.routes[url]
        headers, total = dict(headers), len(body)
        if range_header:
            start = int(re.fullmatch(r"bytes=(\d+)-", range_header).group(1))
            if self.ranged == "416":
                raise urllib.error.HTTPError(url, 416, "Range Not Satisfiable", email.message.Message(), io.BytesIO())
            if self.ranged != "ignore":
                status, body = 206, body[start:]
                if self.ranged == "corrupt":
                    body = b"X" * len(body)
                content_range = {"bad-start": f"bytes 0-{total - 1}/{total}",
                                 "bad-total": f"bytes {start}-{total - 1}/{total + 1}"}.get(
                                     self.ranged, f"bytes {start}-{total - 1}/{total}")
                if self.ranged != "no-header":
                    headers["Content-Range"] = content_range
        self.sent.append(len(body))
        cut = self.cuts.pop(0) if self.cuts else None
        message = email.message.Message()
        for key, value in headers.items():
            message[key] = value
        if cut is None:
            stream = io.BytesIO(body)
        elif self.drop == "short":
            stream = io.BytesIO(body[:cut])
        else:
            stream = DroppingBody(body, cut)
        response = urllib.response.addinfourl(stream, message, url, status)
        response.msg = http.client.responses.get(status, "")
        return response


class World:
    """A tiny stand-in for the image: synthetic locks, a manifest, an environment and a server."""

    def __init__(self, tmp_path):
        self.root = tmp_path / "models"
        self.root.mkdir()
        self.locks = tmp_path / "locks"
        self.manifest = tmp_path / "chatterbox-model-manifest.json"
        self.routes = {}
        self.bodies = {}  # relative install path -> expected bytes
        self.env = {
            "VOCALIS_CHATTERBOX_MODEL_DIR": str(self.root / "chatterbox" / "cbrev"),
            "VOCALIS_VOXCPM_MODEL": str(self.root / "voxcpm2" / "vxrev"),
            "VOCALIS_ENHANCE_MODEL_DIR": str(self.root / "enhance" / "enrev" / "enhancer_stage2"),
            "VOCALIS_TRIM_MODEL_ROOT": str(self.root / "trim"),
            "VOCALIS_ACESTEP_MODEL_DIR": str(self.root / "acestep"),
            "VOCALIS_DFN_MODEL_ROOT": str(self.root / "cleanup" / "dfn3"),
            "VOCALIS_STEMS_MODEL_ROOT": str(self.root / "stems"),
            "LEADVOCAL_MODELS": str(self.root / "leadvocal"),
        }
        self.handler = None
        self.free = 10 ** 12

        def serve(name, body):
            url = f"https://hf.example/{name}"
            self.routes[url] = (200, {}, body)
            return url

        cb = [(n, f"chatterbox {n}".encode() * 5) for n in ("ve.safetensors", "conds.pt")]
        self.write_json(self.manifest, {"revision": "cbrev", "files": [
            {"path": n, "bytes": len(b), "sha256": sha256(b), "url": serve("cb/" + n, b)} for n, b in cb]})
        self.expect("chatterbox/cbrev", cb)

        big, small = b"vox weights " * 7, b'{"vox": true}'
        vox = [
            {"path": "model.safetensors", "bytes": len(big), "gitBlobSha1": blob(big), "lfsSha256": sha256(big),
             "expectedContentId": {"algorithm": "sha256-lfs", "value": sha256(big)}, "url": serve("vx/m", big)},
            {"path": "config.json", "bytes": len(small), "gitBlobSha1": blob(small), "lfsSha256": None,
             "expectedContentId": {"algorithm": "git-blob-sha1", "value": blob(small)}, "url": serve("vx/c", small)},
        ]
        self.write_json(self.locks / "voxcpm2" / "model-file-lock.json", {
            "status": "ignored", "model": {"revision": "vxrev"}, "selection": {"files": vox}})
        self.expect("voxcpm2/vxrev", [("model.safetensors", big), ("config.json", small)])

        hp, latest = b"hparams: 1\n", b"default"
        enh = [
            {"path": "enhancer_stage2/hparams.yaml", "bytes": len(hp), "publisherGitBlobSha1": blob(hp),
             "sha256Observed": sha256(hp), "url": serve("en/h", hp)},
            {"path": "enhancer_stage2/ds/G/latest", "bytes": len(latest), "publisherGitBlobSha1": blob(latest),
             "sha256Observed": sha256(latest), "url": serve("en/l", latest)},
        ]
        self.write_json(self.locks / "enhance" / "model-files.lock.json", {
            "releaseReady": False, "model": {"revision": "enrev"}, "selection": {"files": enh}})
        self.expect("enhance/enrev", [("enhancer_stage2/hparams.yaml", hp), ("enhancer_stage2/ds/G/latest", latest)])

        pth, csv = b"panns checkpoint " * 9, b"index,mid,display_name\n"
        self.write_json(self.locks / "trim" / "model-files.lock.json", {"files": [
            {"path": "Cnn14_mAP=0.431.pth", "bytes": len(pth), "publisherChecksum": "md5:00",
             "observedSha256": sha256(pth), "url": serve("trim/p", pth)}]})
        self.write_json(self.locks / "trim" / "class-labels.lock.json", {
            "source": serve("trim/c", csv), "bytes": len(csv), "observedSha256": sha256(csv)})
        self.expect("trim", [("Cnn14_mAP=0.431.pth", pth), ("class_labels_indices.csv", csv)])

        a1, a2 = b'{"ace": 1}', b"ace vae weights " * 4
        ace = [
            {"path": "acestep-v15-turbo/config.json", "bytes": len(a1),
             "expectedHash": {"algorithm": "git-blob-sha1", "value": blob(a1)}, "url": serve("ac/1", a1)},
            {"path": "vae/diffusion_pytorch_model.safetensors", "bytes": len(a2),
             "expectedHash": {"algorithm": "sha256", "value": sha256(a2)}, "url": serve("ac/2", a2)},
        ]
        self.write_json(self.locks / "acestep" / "model-file-lock.json", {"selection": {"files": ace}})
        self.expect("acestep", [("acestep-v15-turbo/config.json", a1), ("vae/diffusion_pytorch_model.safetensors", a2)])

        # DeepFilterNet3: one archive carrying the two wanted members (plus a README that no lock names).
        self.dfn_config, self.dfn_checkpoint = b"[df]\nsr = 48000\n", b"dfn3 checkpoint " * 12
        self.dfn_zip = make_zip({
            "DeepFilterNet3/": b"", "DeepFilterNet3/config.ini": self.dfn_config,
            "DeepFilterNet3/checkpoints/model_120.ckpt.best": self.dfn_checkpoint,
            "DeepFilterNet3/README.md": b"not locked"})
        self.dfn_url = "https://raw.example/DeepFilterNet/rev/models/DeepFilterNet3.zip"
        self.set_dfn_archive(self.dfn_zip)
        self.expect("cleanup/dfn3", [("config.ini", self.dfn_config),
                                     ("checkpoints/model_120.ckpt.best", self.dfn_checkpoint)])

        # HTDemucs (one file, under the torch-home layout) and the Lead Vocal set (two of its nine files).
        weight = b"htdemucs weights " * 6
        self.write_json(self.locks / "stems" / "model-file-lock.json", {"files": [
            {"path": "hub/checkpoints/955717e8-8726e21a.th", "bytes": len(weight), "sha256": sha256(weight),
             "url": serve("st/w", weight)}], "provenance": {"redistributionResolved": False}})
        self.expect("stems", [("hub/checkpoints/955717e8-8726e21a.th", weight)])
        catalog, kara = b'{"mdx_download_list": {}}', b"karaoke onnx " * 5
        self.write_json(self.locks / "leadvocal" / "model-file-lock.json", {"files": [
            {"path": "download_checks.json", "bytes": len(catalog), "sha256": sha256(catalog),
             "url": serve("lv/c", catalog)},
            {"path": "UVR_MDXNET_KARA_2.onnx", "bytes": len(kara), "sha256": sha256(kara),
             "url": serve("lv/k", kara)}], "provenance": {"redistributionResolved": False}})
        self.expect("leadvocal", [("download_checks.json", catalog), ("UVR_MDXNET_KARA_2.onnx", kara)])

    def set_dfn_archive(self, archive, *, served=None, members=None):
        """Point the dfn3 lock at `archive` (its size/hash are taken from it) and serve `served` (default
        the same bytes); members overrides the lock's member list."""
        self.routes[self.dfn_url] = (200, {}, archive if served is None else served)
        if members is None:
            members = [
                {"member": "DeepFilterNet3/config.ini", "path": "config.ini", "bytes": len(self.dfn_config),
                 "sha256": sha256(self.dfn_config), "crc32": "00000000"},
                {"member": "DeepFilterNet3/checkpoints/model_120.ckpt.best", "path": "checkpoints/model_120.ckpt.best",
                 "bytes": len(self.dfn_checkpoint), "sha256": sha256(self.dfn_checkpoint), "crc32": "00000000"}]
        self.write_json(self.locks / "dfn3" / "model-file-lock.json", {
            "revision": "rev", "archive": {"url": self.dfn_url, "bytes": len(archive), "sha256": sha256(archive)},
            "members": members, "provenance": {"redistributionResolved": False}})

    def dfn_root(self):
        return self.root / "cleanup" / "dfn3"

    def dfn_member(self, name):
        return next(m for m in json.loads((self.locks / "dfn3" / "model-file-lock.json").read_text())["members"]
                    if m["member"] == name)

    def space_needed(self):
        """Download plus extraction: every installed byte, plus the archive that is fetched and discarded."""
        return sum(len(b) for b in self.bodies.values()) + len(self.dfn_zip)

    @staticmethod
    def write_json(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def expect(self, directory, files):
        for name, body in files:
            self.bodies[f"{directory}/{name}"] = body

    def run(self, **overrides):
        self.handler = FakeHttps(self.routes)
        options = dict(
            env=self.env, models_root=str(self.root), locks_dir=self.locks, chatterbox_manifest=self.manifest,
            opener=fm.make_opener(self.handler), sleep=lambda seconds: None, disk_free=lambda path: self.free)
        options.update(overrides)
        return fm.run(**options)

    def installed(self, relative):
        return self.root / relative

    def leftovers(self):
        return [p for p in self.root.rglob("*") if p.name.startswith(fm.TEMP_PREFIX)]

    def edit_lock(self, relative, edit):
        path = self.locks / relative
        data = json.loads(path.read_text(encoding="utf-8"))
        edit(data)
        path.write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture(autouse=True)
def lock_on_this_host(monkeypatch):
    if os.name != "posix":  # fcntl exists only on the Linux hosts the lock is written for
        @contextlib.contextmanager
        def no_lock(path):
            yield
        monkeypatch.setattr(fm, "exclusive_lock", no_lock)


@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


def assert_fully_installed(world):
    for relative, body in world.bodies.items():
        assert world.installed(relative).read_bytes() == body, relative
    assert world.leftovers() == []


def test_fresh_fetch_installs_every_file_and_reports_progress(world, capsys):
    assert world.run() == 0
    assert_fully_installed(world)
    out = capsys.readouterr().out
    for model in ("chatterbox", "voxcpm2", "enhance", "trim", "acestep", "dfn3", "stems", "leadvocal"):
        assert re.search(rf"^{model}: complete$", out, re.MULTILINE), out
    assert "Model fetch complete: 15 files verified (0 already present, 15 downloaded" in out
    assert "Still to download:" in out


def test_rerun_skips_verified_files_and_downloads_nothing(world, capsys):
    assert world.run() == 0
    capsys.readouterr()
    assert world.run() == 0
    assert world.handler.requested == []
    assert "15 already present, 0 downloaded" in capsys.readouterr().out


def test_enhance_destination_is_the_parent_so_stage_directory_is_not_doubled(world):
    assert world.run() == 0
    stage = world.root / "enhance" / "enrev" / "enhancer_stage2"
    assert (stage / "hparams.yaml").is_file() and (stage / "ds" / "G" / "latest").is_file()
    assert not (stage / "enhancer_stage2").exists()
    assert not (world.root / "enhance" / "enrev" / "enhancer_stage2" / "enhancer_stage2").exists()


def test_trim_labels_are_saved_under_the_name_cleanup_reads(world):
    assert world.run() == 0
    assert (world.root / "trim" / "class_labels_indices.csv").read_bytes() == b"index,mid,display_name\n"
    assert not (world.root / "trim" / "class-labels.lock.json").exists()


@pytest.mark.parametrize("wrong", [b"x" * 7 * 12, b"short"], ids=["same-size-wrong-hash", "wrong-size"])
def test_mismatching_existing_file_is_kept_reported_and_fails_the_run(world, capsys, wrong):
    victim = world.installed("voxcpm2/vxrev/model.safetensors")
    victim.parent.mkdir(parents=True)
    victim.write_bytes(wrong)

    assert world.run() == 1

    assert victim.read_bytes() == wrong, "a mismatching file must never be deleted or overwritten"
    out = capsys.readouterr().out
    assert f"MISMATCH {victim}" in out and "INCOMPLETE" in out
    # Everything else still installed.
    for relative, body in world.bodies.items():
        if relative != "voxcpm2/vxrev/model.safetensors":
            assert world.installed(relative).read_bytes() == body
    assert "https://hf.example/vx/m" not in world.handler.requested


def test_files_not_named_in_a_lock_are_ignored(world):
    extra = world.installed("voxcpm2/vxrev/extra.bin")
    extra.parent.mkdir(parents=True)
    extra.write_bytes(b"user file")
    assert world.run() == 0
    assert extra.read_bytes() == b"user file"


def test_truncated_download_is_retried_then_fails_keeping_only_the_partial_for_the_next_run(world, capsys):
    url = "https://hf.example/vx/m"
    status, headers, body = world.routes[url]
    world.routes[url] = (status, headers, body[:-3])

    assert world.run() == 1

    assert not world.installed("voxcpm2/vxrev/model.safetensors").exists()
    partial = world.installed("voxcpm2/vxrev") / (fm.TEMP_PREFIX + "model.safetensors" + fm.TEMP_SUFFIX)
    assert world.leftovers() == [partial] and partial.read_bytes() == body[:-3]
    assert world.handler.requested.count(url) == fm.ATTEMPTS
    out = capsys.readouterr().out
    assert "FAILED" in out and "truncated" in out
    # The run stops at the first failed download: later models were not attempted.
    assert not any(u.startswith("https://hf.example/en/") for u in world.handler.requested)


def test_a_failed_attempt_is_retried_and_a_later_good_attempt_installs(world):
    url = "https://hf.example/vx/m"
    good = world.routes[url]
    served = iter([(good[0], good[1], good[2][:5]), good])

    class Flaky(FakeHttps):
        def https_open(self, request):
            if request.full_url == url:
                self.routes[url] = next(served)
            return super().https_open(request)

    world.run(opener=fm.make_opener(Flaky(world.routes)))
    assert_fully_installed(world)


def test_wrong_content_with_the_right_size_fails_the_hash(world, capsys):
    url = "https://hf.example/ac/2"
    status, headers, body = world.routes[url]
    world.routes[url] = (status, headers, b"X" * len(body))
    assert world.run() == 1
    assert "sha256 mismatch" in capsys.readouterr().out
    assert not world.installed("acestep/vae/diffusion_pytorch_model.safetensors").exists()


def test_git_blob_hash_matches_git_and_wrong_blob_content_fails(world, capsys):
    assert blob(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"  # git hash-object of "hello\n"
    assert blob(b"") == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    url = "https://hf.example/ac/1"
    status, headers, body = world.routes[url]
    world.routes[url] = (status, headers, b"X" * len(body))
    assert world.run() == 1
    assert "git-blob-sha1 mismatch" in capsys.readouterr().out


@pytest.mark.parametrize("entry, expected", [
    ({"sha256": "a" * 64}, ("sha256", "a" * 64)),
    ({"lfsSha256": "b" * 64, "gitBlobSha1": "c" * 40}, ("sha256", "b" * 64)),
    ({"sha256Observed": "d" * 64, "publisherGitBlobSha1": "c" * 40}, ("sha256", "d" * 64)),
    ({"observedSha256": "e" * 64}, ("sha256", "e" * 64)),
    ({"expectedHash": {"algorithm": "sha256", "value": "f" * 64}}, ("sha256", "f" * 64)),
    ({"expectedContentId": {"algorithm": "sha256-lfs", "value": "1" * 64}, "gitBlobSha1": "2" * 40},
     ("sha256", "1" * 64)),
    ({"expectedHash": {"algorithm": "git-blob-sha1", "value": "3" * 40}}, ("git-blob-sha1", "3" * 40)),
    ({"gitBlobSha1": "4" * 40, "lfsSha256": None}, ("git-blob-sha1", "4" * 40)),
    ({"publisherGitBlobSha1": "5" * 40}, ("git-blob-sha1", "5" * 40)),
])
def test_hash_selection_prefers_sha256_under_any_field_name(entry, expected):
    assert fm.expected_digest(entry, "x") == expected


@pytest.mark.parametrize("entry", [
    {}, {"publisherChecksum": "md5:" + "0" * 32},
    {"sha256": "a" * 64, "lfsSha256": "b" * 64},
    {"expectedHash": {"algorithm": "md5", "value": "0" * 32}},
    {"sha256": "short"},
])
def test_unusable_hash_records_are_refused(entry):
    with pytest.raises(fm.Refusal):
        fm.expected_digest(entry, "x")


def test_http_url_in_a_lock_is_refused_before_any_request(world, capsys):
    world.edit_lock("acestep/model-file-lock.json",
                    lambda d: d["selection"]["files"][0].update(url="http://hf.example/ac/1"))
    assert world.run() == 1
    assert world.handler.requested == []
    assert "only HTTPS" in capsys.readouterr().err


def test_redirect_to_http_is_refused_and_nothing_is_installed_from_it(world, capsys):
    url = "https://hf.example/ac/1"
    world.routes[url] = (302, {"Location": "http://cdn.example/plain"}, b"")
    world.routes["http://cdn.example/plain"] = (200, {}, b'{"ace": 1}')
    assert world.run() == 1
    assert "http://cdn.example/plain" not in world.handler.requested
    assert "non-HTTPS" in capsys.readouterr().err
    assert not world.installed("acestep/acestep-v15-turbo/config.json").exists()
    assert world.leftovers() == []


def test_redirect_to_another_https_host_is_followed(world):
    url = "https://hf.example/ac/1"
    body = world.routes[url][2]
    world.routes[url] = (302, {"Location": "https://cdn.example/signed?x=1"}, b"")
    world.routes["https://cdn.example/signed?x=1"] = (200, {}, body)
    assert world.run() == 0
    assert_fully_installed(world)
    assert "https://cdn.example/signed?x=1" in world.handler.requested


def test_permanent_http_error_is_not_retried(world, capsys):
    url = "https://hf.example/en/h"
    world.routes[url] = (404, {}, b"missing")
    assert world.run() == 1
    assert world.handler.requested.count(url) == 1
    assert "404" in capsys.readouterr().out


def test_symlinked_destination_component_is_refused(world, tmp_path, capsys):
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        os.symlink(outside, world.root / "voxcpm2", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks")
    assert world.run() == 1
    assert list(outside.iterdir()) == []
    assert world.handler.requested == []
    err = capsys.readouterr().err
    assert "symlink" in err and str(world.root / "voxcpm2") in err


def test_symlinked_file_is_refused(world, tmp_path, capsys):
    target = tmp_path / "elsewhere.bin"
    target.write_bytes(b"data")
    link = world.installed("trim/Cnn14_mAP=0.431.pth")
    link.parent.mkdir(parents=True)
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks")
    assert world.run() == 1
    assert target.read_bytes() == b"data"
    assert "symlink" in capsys.readouterr().err


@pytest.mark.parametrize("bad", ["../escape.bin", "/etc/escape.bin", "a/../../b", "a//b", "a\\b"])
def test_absolute_or_dotdot_lock_paths_are_refused(world, capsys, bad):
    world.edit_lock("acestep/model-file-lock.json", lambda d: d["selection"]["files"][0].update(path=bad))
    assert world.run() == 1
    assert world.handler.requested == []
    err = capsys.readouterr().err
    assert repr(bad) in err and "refused" in err
    assert not (world.root.parent / "escape.bin").exists()


def test_only_its_own_leftover_temporary_files_are_removed(world, capsys):
    stage = world.root / "enhance" / "enrev" / "enhancer_stage2"
    stage.mkdir(parents=True)
    own = stage / (fm.TEMP_PREFIX + "hparams.yaml" + fm.TEMP_SUFFIX)
    own.write_bytes(b"half a download")
    foreign_part = stage / ".someone-else.part"
    foreign_part.write_bytes(b"not ours")
    plain = stage / "notes.txt"
    plain.write_bytes(b"not ours either")

    assert world.run() == 0

    assert not own.exists()
    assert foreign_part.read_bytes() == b"not ours" and plain.read_bytes() == b"not ours either"
    assert "removing leftover temporary file" in capsys.readouterr().out
    assert_fully_installed(world)


@pytest.mark.parametrize("variable, wrong", [
    ("VOCALIS_VOXCPM_MODEL", "voxcpm2/other"),
    ("VOCALIS_CHATTERBOX_MODEL_DIR", "chatterbox/other"),
    ("VOCALIS_ENHANCE_MODEL_DIR", "enhance/other/enhancer_stage2"),
])
def test_revision_mismatch_between_environment_and_lock_is_refused(world, capsys, variable, wrong):
    world.env[variable] = str(world.root / wrong)
    assert world.run() == 1
    assert world.handler.requested == []
    assert variable in capsys.readouterr().err


@pytest.mark.parametrize("variable", ["VOCALIS_VOXCPM_MODEL", "VOCALIS_TRIM_MODEL_ROOT", "VOCALIS_DFN_MODEL_ROOT",
                                      "VOCALIS_STEMS_MODEL_ROOT", "LEADVOCAL_MODELS"])
def test_environment_paths_must_be_set_and_inside_the_models_root(world, tmp_path, capsys, variable):
    world.env[variable] = str(tmp_path / "elsewhere" / "vxrev")
    assert world.run() == 1
    assert "not a directory under" in capsys.readouterr().err
    del world.env[variable]
    assert world.run() == 1
    assert "is not set" in capsys.readouterr().err


def test_stems_and_lead_vocal_files_land_where_their_features_read_them(world):
    """October 11, 2026: HTDemucs under the torch-home layout, the Lead Vocal set in LEADVOCAL_MODELS."""
    assert world.run() == 0
    weight = world.root / "stems" / "hub" / "checkpoints" / "955717e8-8726e21a.th"
    assert weight.read_bytes() == world.bodies["stems/hub/checkpoints/955717e8-8726e21a.th"]
    for name in ("download_checks.json", "UVR_MDXNET_KARA_2.onnx"):
        assert (world.root / "leadvocal" / name).is_file(), name


def test_a_stems_file_that_is_not_the_locked_one_is_kept_and_reported(world, capsys):
    """A present file that differs from the lock is never overwritten (setup's rule for every model)."""
    weight = world.root / "stems" / "hub" / "checkpoints" / "955717e8-8726e21a.th"
    weight.parent.mkdir(parents=True)
    weight.write_bytes(b"someone else's file")
    assert world.run() == 1
    assert weight.read_bytes() == b"someone else's file"
    assert "MISMATCH" in capsys.readouterr().out


def test_insufficient_space_refuses_before_downloading(world, capsys):
    world.free = world.space_needed() + fm.SPARE_BYTES - 1
    assert world.run() == 1
    assert world.handler.requested == []
    err = capsys.readouterr().err
    assert "not enough free space" in err and "1 GiB" in err


def test_space_is_enough_at_exactly_the_total_plus_one_gib(world):
    world.free = world.space_needed() + fm.SPARE_BYTES
    assert world.run() == 0


def test_a_nothing_to_download_rerun_does_not_need_free_space(world):
    assert world.run() == 0
    world.free = 0
    assert world.run() == 0


@pytest.mark.skipif(os.name != "posix", reason="flock exists on the Linux setup hosts")
def test_a_second_fetch_is_refused_while_the_lock_is_held(world, capsys):
    import fcntl

    descriptor = os.open(world.root / fm.LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        assert world.run() == 1
    finally:
        os.close(descriptor)
    assert world.handler.requested == []
    assert "already running" in capsys.readouterr().err
    assert world.run() == 0  # the lock is released with the holder


def test_missing_models_mount_is_refused(world, capsys):
    world.root.rmdir()
    assert world.run() == 1
    assert "models mount is missing" in capsys.readouterr().err


def test_arguments_are_rejected():
    assert fm.main(["--anything"]) == 2


def _dockerfile_env():
    text = (PACKAGING / "main-cuda" / "Dockerfile.app").read_text(encoding="utf-8")
    # LEADVOCAL_MODELS (October 11, 2026) is the one non-VOCALIS_ name the fetcher reads: it is the
    # directory the Lead Vocal feature itself uses, so the lock's destination is that same variable.
    return dict(re.findall(r"^\s+((?:VOCALIS|LEADVOCAL)_[A-Z_]+)=(\S+?)(?: \\)?$", text, re.MULTILINE))


STEMS_BYTES = 84_141_911
ACESTEP_XL_SFT_BYTES = 19_953_387_374  # acestep-v15-xl-sft, 11 files (added October 11, 2026)
ACESTEP_XL_BASE_BYTES = 19_953_388_010  # acestep-v15-xl-base, 11 files (added the same day: Extract, Replace,
#                                        Complete run only on it)
ACESTEP_XL_BYTES = ACESTEP_XL_SFT_BYTES + ACESTEP_XL_BASE_BYTES  # both XL models
LEADVOCAL_BYTES = 2_161_630_143


def test_the_real_locks_and_the_images_environment_produce_the_designed_plan(tmp_path):
    root = tmp_path / "models"
    env = {name: value.replace("/models/vocalis", str(root), 1) for name, value in _dockerfile_env().items()}
    plan = fm.build_plan(env, PACKAGING / "models", PACKAGING / "models" / "chatterbox" / "manifest.json",
                         str(root))

    counts = {}
    for item in plan:
        counts[item.model] = counts.get(item.model, 0) + 1
        assert item.url.startswith("https://")
    assert counts == {"chatterbox": 5, "voxcpm2": 8, "enhance": 3, "trim": 2, "acestep": 49, "dfn3": 2,
                      "stems": 1, "leadvocal": 9}
    # 20,323,393,650 bytes from the single-URL locks plus the 8,716,140 installed bytes of the two
    # DeepFilterNet3 members (config.ini 2,067 and model_120.ckpt.best 8,714,073); October 11, 2026:
    # plus HTDemucs (84,141,911), the nine Lead Vocal files (2,161,630,143) and the eleven ACE-Step XL SFT
    # files (19,953,387,374) and the eleven ACE-Step XL Base files (19,953,388,010).
    everything_else = 8_716_140 + STEMS_BYTES + LEADVOCAL_BYTES + ACESTEP_XL_BYTES
    assert sum(item.size for item in plan) == 20_323_393_650 + everything_else
    assert sum(item.size for item in plan if item.model not in ("dfn3", "stems", "leadvocal")) == (
        20_323_393_650 + ACESTEP_XL_BYTES)

    by_path = {item.path: item for item in plan}
    chatterbox = root / "chatterbox" / "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18"
    assert by_path[chatterbox / "t3_cfg.safetensors"].algorithm == "sha256"
    assert (root / "voxcpm2" / "32279effe8c19989596f05d353d1447f51d9e915" / "model.safetensors") in by_path
    stage = root / "enhance" / "f35e879924e339228db2e9752185a21ef8ffeb3e" / "enhancer_stage2"
    assert stage / "ds" / "G" / "default" / "mp_rank_00_model_states.pt" in by_path
    assert all(p.parts.count("enhancer_stage2") <= 1 for p in by_path)
    assert root / "trim" / "Cnn14_mAP=0.431.pth" in by_path and root / "trim" / "class_labels_indices.csv" in by_path
    assert root / "acestep" / "acestep-5Hz-lm-1.7B" / "added_tokens.json" in by_path
    # The hash rule: SHA-256 wherever the lock has one, Git blob SHA-1 otherwise.
    algorithms = {(item.model, item.algorithm) for item in plan}
    assert ("voxcpm2", "git-blob-sha1") in algorithms and ("voxcpm2", "sha256") in algorithms
    assert ("acestep", "git-blob-sha1") in algorithms and ("trim", "sha256") in algorithms

    # DeepFilterNet3 (October 9, 2026): both members come from the one pinned publisher archive.
    dfn = [item for item in plan if item.model == "dfn3"]
    dfn_root = root / "cleanup" / "dfn3"
    assert {item.path for item in dfn} == {dfn_root / "config.ini", dfn_root / "checkpoints" / "model_120.ckpt.best"}
    assert {item.member for item in dfn} == {"DeepFilterNet3/config.ini", "DeepFilterNet3/checkpoints/model_120.ckpt.best"}
    assert {item.size for item in dfn} == {2_067, 8_714_073} and {item.algorithm for item in dfn} == {"sha256"}
    (archive,) = {item.archive for item in dfn}
    assert archive.url == ("https://raw.githubusercontent.com/Rikorose/DeepFilterNet/"
                           "d375b2d8309e0935d165700c91da9de862a99c31/models/DeepFilterNet3.zip")
    assert (archive.size, archive.digest) == (7_986_207, "49c52edc8947ae1f9bf50d81530beaf3a2c3245aeaf34b6f31ff535cd22284d2")
    assert archive.rel == "DeepFilterNet3.zip" and archive.directory == dfn_root

    # ACE-Step XL SFT (October 11, 2026): the larger music model, in the same destination as turbo, so
    # the engine's model menu (a scan of that folder) offers it and Extract, Replace and Complete can run.
    xl = {item.rel: item for item in plan if item.model == "acestep" and item.rel.startswith("acestep-v15-xl-sft/")}
    assert len(xl) == 11 and sum(item.size for item in xl.values()) == ACESTEP_XL_SFT_BYTES
    assert all(item.directory == root / "acestep" for item in xl.values())
    shards = [item for rel, item in xl.items() if "/model-0000" in rel]
    assert len(shards) == 4 and {item.algorithm for item in shards} == {"sha256"}
    assert all("/ACE-Step/acestep-v15-xl-sft/resolve/d06de46b4622f781cf07f4a013a67d591ca52819/" in item.url
               for item in xl.values())
    assert "acestep-v15-xl-sft/config.json" in xl and "acestep-v15-xl-sft/model.safetensors.index.json" in xl

    # ACE-Step XL Base (October 11, 2026): the model the publisher lists for ALL tasks ("All (extract, lego,
    # complete)"); the music page sends Extract, Replace and Complete only to it. Same destination as the others.
    base = {item.rel: item for item in plan
            if item.model == "acestep" and item.rel.startswith("acestep-v15-xl-base/")}
    assert len(base) == 11 and sum(item.size for item in base.values()) == ACESTEP_XL_BASE_BYTES
    assert all(item.directory == root / "acestep" for item in base.values())
    base_shards = [item for rel, item in base.items() if "/model-0000" in rel]
    assert len(base_shards) == 4 and {item.algorithm for item in base_shards} == {"sha256"}
    assert all("/ACE-Step/acestep-v15-xl-base/resolve/220c1166efbdd9583eafcb12eb160594bbfcb241/" in item.url
               for item in base.values())
    assert "acestep-v15-xl-base/config.json" in base and "acestep-v15-xl-base/model.safetensors.index.json" in base
    # Every file of both XL repositories except .gitattributes: the same eleven names in each.
    assert {rel.split("/", 1)[1] for rel in base} == {rel.split("/", 1)[1] for rel in xl}

    # HTDemucs (October 11, 2026): one file, from the address Demucs 4.0.1 itself uses, placed where
    # torch.hub reads it for a child whose TORCH_HOME is VOCALIS_STEMS_MODEL_ROOT.
    (weight,) = [item for item in plan if item.model == "stems"]
    assert weight.path == root / "stems" / "hub" / "checkpoints" / "955717e8-8726e21a.th"
    assert weight.url == "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th"
    assert (weight.size, weight.algorithm) == (STEMS_BYTES, "sha256")
    assert weight.digest.startswith("8726e21a"), "torch.hub checks the hash prefix named in the file name"

    # Lead Vocal (October 11, 2026): the destination is LEADVOCAL_MODELS; every file the product can ask
    # for is in the lock, over HTTPS, and the three JSON files are pinned to a commit rather than 'main'.
    lead = {item.rel: item for item in plan if item.model == "leadvocal"}
    assert all(item.directory == root / "leadvocal" for item in lead.values())
    assert set(lead) == {
        "download_checks.json", "vr_model_data.json", "mdx_model_data.json", "UVR_MDXNET_KARA_2.onnx",
        "UVR-DeEcho-DeReverb.pth", "UVR-De-Reverb-aufr33-jarredou.pth",
        "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
        "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt",
        "dereverb_mel_band_roformer_anvuew.yaml"}
    assert {item.algorithm for item in lead.values()} == {"sha256"}
    for name in ("download_checks.json", "vr_model_data.json", "mdx_model_data.json"):
        assert "/TRvlvr/application_data/3826b05b570dbd4fbedbc807758803b35348ba1b/" in lead[name].url, name
        assert "/main/" not in lead[name].url, name


def test_the_real_plan_reports_the_archive_as_the_download_and_the_members_as_the_install(tmp_path, monkeypatch, capsys):
    """'To download' counts the archive once; the space check adds the extracted members."""
    root = tmp_path / "models"
    root.mkdir()
    env = {name: value.replace("/models/vocalis", str(root), 1) for name, value in _dockerfile_env().items()}
    plan = fm.build_plan(env, PACKAGING / "models", PACKAGING / "models" / "chatterbox" / "manifest.json", str(root))
    monkeypatch.setattr(fm, "human", str)  # exact byte counts instead of rounded ones

    with pytest.raises(fm.Refusal, match="not enough free space"):
        fm.fetch(plan, root, None, None, lambda path: 0, 0.0)

    out = capsys.readouterr().out
    assert f"{len(plan)} files, {20_323_393_650 + 8_716_140 + STEMS_BYTES + LEADVOCAL_BYTES + ACESTEP_XL_BYTES} in all" in out
    assert "dfn3: 2 files, 8716140; 2 to install from an archive download (7986207)" in out
    assert f"Still to download: {20_323_393_650 + 7_986_207 + STEMS_BYTES + LEADVOCAL_BYTES + ACESTEP_XL_BYTES}." in out
    assert f"stems: 1 files, {STEMS_BYTES}; 1 to download ({STEMS_BYTES})" in out
    assert f"leadvocal: 9 files, {LEADVOCAL_BYTES}; 9 to download ({LEADVOCAL_BYTES})" in out


# --- DeepFilterNet3: the archive-backed lock (October 9, 2026) ------------------------------


def dfn_files(world):
    root = world.dfn_root()
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()) if root.exists() else []


def test_dfn3_fresh_fetch_installs_both_members_from_one_archive_download(world, capsys):
    assert world.run() == 0
    assert_fully_installed(world)
    assert world.handler.requested.count(world.dfn_url) == 1
    # Only the two locked members exist: not the archive, not its other members, no temporary.
    assert dfn_files(world) == ["checkpoints/model_120.ckpt.best", "config.ini"]
    out = capsys.readouterr().out
    assert "dfn3: 2 files" in out and "2 to install from an archive download" in out
    assert re.search(r"^dfn3: complete$", out, re.MULTILINE), out


def test_dfn3_archive_exists_only_as_a_dot_prefixed_temporary_and_is_never_renamed_into_place(world, monkeypatch):
    seen = {}
    real = fm.extract_members

    def spy(archive, items, archive_file, models_root):
        seen.update(name=archive_file.name, parent=archive_file.parent, size=archive_file.stat().st_size)
        return real(archive, items, archive_file, models_root)

    monkeypatch.setattr(fm, "extract_members", spy)
    assert world.run() == 0
    assert seen == {"name": ".vocalis-fetch-DeepFilterNet3.zip.part", "parent": world.dfn_root(),
                    "size": len(world.dfn_zip)}
    assert not (world.dfn_root() / "DeepFilterNet3.zip").exists() and world.leftovers() == []


def test_dfn3_extra_and_path_traversing_members_are_never_written(world, tmp_path):
    hostile = make_zip({
        "DeepFilterNet3/config.ini": world.dfn_config,
        "DeepFilterNet3/checkpoints/model_120.ckpt.best": world.dfn_checkpoint,
        "../escape.txt": b"x", "/absolute.txt": b"x", "DeepFilterNet3/../../escape2.txt": b"x",
        "DeepFilterNet3/extra.bin": b"x", "DeepFilterNet3/checkpoints/extra.bin": b"x"})
    world.set_dfn_archive(hostile)  # its own fixture lock, naming only the two members
    assert world.run() == 0
    assert dfn_files(world) == ["checkpoints/model_120.ckpt.best", "config.ini"]
    for stray in ("escape.txt", "escape2.txt", "absolute.txt", "extra.bin"):
        assert not list(tmp_path.rglob(stray)), stray
    assert world.leftovers() == []


def test_dfn3_archive_hash_mismatch_is_retried_then_fails_and_installs_nothing(world, capsys):
    world.set_dfn_archive(world.dfn_zip, served=b"X" * len(world.dfn_zip))  # right size, wrong content
    assert world.run() == 1
    assert world.handler.requested.count(world.dfn_url) == fm.ATTEMPTS
    assert "sha256 mismatch" in capsys.readouterr().out
    assert dfn_files(world) == [] and world.leftovers() == []


def test_dfn3_member_hash_mismatch_inside_a_verified_archive_is_not_retried(world, capsys):
    world.edit_lock("dfn3/model-file-lock.json", lambda d: d["members"][1].update(sha256="0" * 64))
    assert world.run() == 1
    assert world.handler.requested.count(world.dfn_url) == 1, "the lock is wrong; downloading again cannot fix it"
    out = capsys.readouterr().out
    assert "the lock is wrong, not retrying" in out and "FAILED" in out
    assert dfn_files(world) == ["config.ini"], "the valid sibling extracted first is kept; the bad member is not"
    assert world.leftovers() == []


def test_dfn3_both_members_present_downloads_no_archive(world, capsys):
    assert world.run() == 0
    del world.routes[world.dfn_url]  # a request for it would now fail, and requested would show it
    capsys.readouterr()
    assert world.run() == 0
    assert world.dfn_url not in world.handler.requested
    assert "dfn3: 2 files" in capsys.readouterr().out


def test_dfn3_one_present_one_missing_writes_only_the_missing_member(world, capsys):
    config = world.dfn_root() / "config.ini"
    config.parent.mkdir(parents=True)
    config.write_bytes(world.dfn_config)
    before = (config.stat().st_ino, config.stat().st_mtime_ns)
    assert world.run() == 0
    assert (config.stat().st_ino, config.stat().st_mtime_ns) == before
    assert (world.dfn_root() / "checkpoints" / "model_120.ckpt.best").read_bytes() == world.dfn_checkpoint
    assert world.handler.requested.count(world.dfn_url) == 1
    assert "dfn3: 2 files" in capsys.readouterr().out and world.leftovers() == []


def test_dfn3_one_mismatched_one_missing_keeps_the_mismatch_and_installs_the_sibling(world, capsys):
    config = world.dfn_root() / "config.ini"
    config.parent.mkdir(parents=True)
    config.write_bytes(b"[df]\nsr = 16000\n")  # a user's own edit: wrong content, kept
    assert world.run() == 1
    assert config.read_bytes() == b"[df]\nsr = 16000\n"
    assert (world.dfn_root() / "checkpoints" / "model_120.ckpt.best").read_bytes() == world.dfn_checkpoint
    out = capsys.readouterr().out
    assert f"MISMATCH {config}" in out and "INCOMPLETE" in out
    assert world.leftovers() == []


def test_dfn3_a_full_length_leftover_archive_temporary_is_swept_not_resumed(world, capsys):
    leftover = world.dfn_root() / (fm.TEMP_PREFIX + "DeepFilterNet3.zip" + fm.TEMP_SUFFIX)
    leftover.parent.mkdir(parents=True)
    leftover.write_bytes(b"x" * len(world.dfn_zip))  # as long as the lock: nothing left to ask for
    assert world.run() == 0
    assert "removing leftover temporary file" in capsys.readouterr().out
    assert dfn_files(world) == ["checkpoints/model_120.ckpt.best", "config.ini"] and world.leftovers() == []


def test_dfn3_space_is_the_archive_plus_the_missing_members(world, capsys):
    assert world.run() == 0
    config, checkpoint = world.dfn_root() / "config.ini", world.dfn_root() / "checkpoints" / "model_120.ckpt.best"
    config.unlink()
    checkpoint.unlink()
    members = len(world.dfn_config) + len(world.dfn_checkpoint)
    need = len(world.dfn_zip) + members

    world.free = need + fm.SPARE_BYTES - 1
    assert world.run() == 1 and world.handler.requested == []
    err = capsys.readouterr().err
    assert "not enough free space" in err and "to extract" in err
    world.free = members + fm.SPARE_BYTES  # the members alone would fit: the archive must be counted too
    assert world.run() == 1 and world.handler.requested == []
    world.free = need + fm.SPARE_BYTES
    assert world.run() == 0 and world.handler.requested == [world.dfn_url]

    checkpoint.unlink()  # only one member missing: the archive plus that member
    world.free = len(world.dfn_zip) + len(world.dfn_checkpoint) + fm.SPARE_BYTES - 1
    assert world.run() == 1
    world.free = len(world.dfn_zip) + len(world.dfn_checkpoint) + fm.SPARE_BYTES
    assert world.run() == 0


def test_dfn3_a_file_that_is_not_a_zip_fails_cleanly(world, capsys):
    world.set_dfn_archive(b"this is not a zip file " * 5)  # the lock hashes it, so it passes verification
    assert world.run() == 1
    assert "cannot read the archive (BadZipFile" in capsys.readouterr().out
    assert dfn_files(world) == [] and world.leftovers() == []


def test_dfn3_a_member_absent_from_the_archive_fails_cleanly(world, capsys):
    world.set_dfn_archive(make_zip({"DeepFilterNet3/config.ini": world.dfn_config}))
    assert world.run() == 1
    assert "has no member 'DeepFilterNet3/checkpoints/model_120.ckpt.best'" in capsys.readouterr().out
    assert dfn_files(world) == ["config.ini"] and world.leftovers() == []


def test_dfn3_a_member_whose_recorded_size_differs_from_the_lock_is_refused_before_streaming(world, capsys):
    world.set_dfn_archive(make_zip({"DeepFilterNet3/config.ini": world.dfn_config,
                                    "DeepFilterNet3/checkpoints/model_120.ckpt.best": b"short"}))
    assert world.run() == 1
    assert f"is 5 bytes, the lock says {len(world.dfn_checkpoint)}" in capsys.readouterr().out
    assert dfn_files(world) == ["config.ini"] and world.leftovers() == []


def test_dfn3_a_corrupt_member_fails_its_crc_cleanly(world, capsys):
    stored = make_zip({"DeepFilterNet3/config.ini": world.dfn_config,
                       "DeepFilterNet3/checkpoints/model_120.ckpt.best": world.dfn_checkpoint}, zipfile.ZIP_STORED)
    at = stored.index(world.dfn_checkpoint)
    corrupt = stored[:at] + bytes([stored[at] ^ 0xFF]) + stored[at + 1:]
    world.set_dfn_archive(corrupt)  # the archive hash is of the corrupt bytes, so only the member CRC catches it
    assert world.run() == 1
    assert "cannot read the archive (BadZipFile" in capsys.readouterr().out
    assert dfn_files(world) == ["config.ini"] and world.leftovers() == []


@pytest.mark.parametrize("edit, message", [
    (lambda d: d["archive"].update(url="http://raw.example/x/DeepFilterNet3.zip"), "only HTTPS"),
    (lambda d: d["archive"].update(url="https://raw.example/x/"), "refusing it"),
    (lambda d: d["archive"].pop("sha256"), "no SHA-256"),
    (lambda d: d["archive"].update(sha256=None, gitBlobSha1="a" * 40), "locked by SHA-256"),
    (lambda d: d["archive"].update(bytes=-1), "byte count"),
    (lambda d: d.update(members=[]), "no members"),
    (lambda d: d["members"][0].pop("member"), "archive member name"),
    (lambda d: d["members"][0].update(path="../escape"), "refusing it"),
    (lambda d: d["members"][1].update(path="config.ini"), "named twice"),
    (lambda d: d.pop("archive"), "no archive section"),
], ids=["http-url", "no-file-name", "no-hash", "git-blob-only", "bad-bytes", "no-members", "no-member-name",
        "dotdot-path", "duplicate-path", "no-archive"])
def test_dfn3_malformed_locks_are_refused_before_any_request(world, capsys, edit, message):
    world.edit_lock("dfn3/model-file-lock.json", edit)
    assert world.run() == 1
    assert world.handler.requested == []
    assert message in capsys.readouterr().err


def test_dfn3_symlinked_destination_component_is_refused(world, tmp_path, capsys):
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        os.symlink(outside, world.root / "cleanup", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks")
    assert world.run() == 1
    assert list(outside.iterdir()) == [] and world.handler.requested == []
    assert "symlink" in capsys.readouterr().err


# --- resuming a dropped download within a run (October 9, 2026) ------------------------------
# Real trigger: Zenodo dropped the 1.4 GB Trim checkpoint at 1,113,796,844 of 1,365,409,299 bytes
# and every from-zero retry crawled. The Trim checkpoint is the file used here too.

TRIM_URL = "https://hf.example/trim/p"
TRIM_INSTALLED = "trim/Cnn14_mAP=0.431.pth"
TRIM_BODY = b"panns checkpoint " * 9


def resumable_run(world, handler):
    return world.run(opener=fm.make_opener(handler))


def ranges_for(handler, url):
    return [rng for seen_url, rng in handler.seen if seen_url == url]


@pytest.mark.parametrize("drop", ["short", "reset"], ids=["truncated-stream", "dropped-connection"])
def test_resume_after_a_cut_first_attempt_requests_only_the_missing_range_and_appends(world, capsys, drop):
    handler = RangeHttps(world.routes, TRIM_URL, cuts=[100], drop=drop)

    assert resumable_run(world, handler) == 0

    assert_fully_installed(world)
    assert ranges_for(handler, TRIM_URL) == [None, "bytes=100-"], "the second request asks only for what is missing"
    assert handler.sent == [len(TRIM_BODY), len(TRIM_BODY) - 100], "the resumed answer carries only the remaining bytes"
    out = capsys.readouterr().out
    assert f"resuming trim/Cnn14_mAP=0.431.pth at 100 of {len(TRIM_BODY)} bytes" in out
    assert out.count("failed") == 1 and "100 bytes kept" in out
    assert "Model fetch complete: 15 files verified" in out


def test_a_resumed_file_that_is_cut_again_resumes_again_from_the_new_length(world):
    handler = RangeHttps(world.routes, TRIM_URL, cuts=[40, 30], drop="reset")
    assert resumable_run(world, handler) == 0
    assert_fully_installed(world)
    assert ranges_for(handler, TRIM_URL) == [None, "bytes=40-", "bytes=70-"]


def test_a_server_that_ignores_range_restarts_the_file_from_zero_in_the_same_attempt(world, capsys):
    handler = RangeHttps(world.routes, TRIM_URL, cuts=[100], ranged="ignore")

    assert resumable_run(world, handler) == 0

    assert_fully_installed(world)
    assert ranges_for(handler, TRIM_URL) == [None, "bytes=100-"], "the 200 body is used; no third request"
    out = capsys.readouterr().out
    assert "answered HTTP 200" in out and "restarting from zero" in out
    assert "resuming trim" not in out
    assert out.count("failed") == 1, "restarting from zero did not use up a retry"


@pytest.mark.parametrize("ranged", ["bad-start", "bad-total", "no-header", "416"])
def test_a_wrong_or_refused_range_answer_discards_the_partial_file_and_restarts_without_range(world, capsys, ranged):
    handler = RangeHttps(world.routes, TRIM_URL, cuts=[100], ranged=ranged)

    assert resumable_run(world, handler) == 0

    assert_fully_installed(world)
    assert ranges_for(handler, TRIM_URL) == [None, "bytes=100-", None], "asked again from zero in the same attempt"
    out = capsys.readouterr().out
    assert "restarting from zero" in out and "resuming trim" not in out
    assert out.count("failed") == 1, "restarting from zero did not use up a retry"


def test_resume_follows_the_redirect_chain_and_keeps_the_range_on_every_hop(world, capsys):
    cdn = "https://cdn.example/signed?x=1"
    world.routes[cdn] = (200, {}, TRIM_BODY)
    world.routes[TRIM_URL] = (302, {"Location": cdn}, b"")
    handler = RangeHttps(world.routes, cdn, cuts=[100], drop="reset")

    assert resumable_run(world, handler) == 0

    assert_fully_installed(world)
    hops = [hop for hop in handler.seen if hop[0] in (TRIM_URL, cdn)]
    assert hops == [(TRIM_URL, None), (cdn, None), (TRIM_URL, "bytes=100-"), (cdn, "bytes=100-")]
    assert f"resuming trim/Cnn14_mAP=0.431.pth at 100 of {len(TRIM_BODY)} bytes" in capsys.readouterr().out


def test_resume_still_refuses_a_redirect_to_http_and_leaves_no_partial_file(world, capsys):
    class DowngradesOnResume(RangeHttps):
        """The first trip through the lock URL redirects to the CDN over HTTPS; the resume trip redirects to http."""

        def https_open(self, request):
            if request.full_url == TRIM_URL and request.get_header("Range"):
                self.routes[TRIM_URL] = (302, {"Location": "http://cdn.example/plain"}, b"")
            return super().https_open(request)

    cdn = "https://cdn.example/signed"
    world.routes[cdn] = (200, {}, TRIM_BODY)
    world.routes[TRIM_URL] = (302, {"Location": cdn}, b"")
    world.routes["http://cdn.example/plain"] = (200, {}, TRIM_BODY)
    handler = DowngradesOnResume(world.routes, cdn, cuts=[100], drop="reset")

    assert resumable_run(world, handler) == 1

    assert "http://cdn.example/plain" not in [url for url, _ in handler.seen]
    assert "non-HTTPS" in capsys.readouterr().err
    assert not world.installed(TRIM_INSTALLED).exists() and world.leftovers() == []


def test_the_dfn3_archive_temporary_is_resumed_too(world, capsys):
    handler = RangeHttps(world.routes, world.dfn_url, cuts=[100], drop="reset")

    assert resumable_run(world, handler) == 0

    assert_fully_installed(world)
    assert ranges_for(handler, world.dfn_url) == [None, "bytes=100-"], "one archive, fetched in two pieces"
    assert handler.sent == [len(world.dfn_zip), len(world.dfn_zip) - 100]
    assert dfn_files(world) == ["checkpoints/model_120.ckpt.best", "config.ini"] and world.leftovers() == []
    out = capsys.readouterr().out
    assert f"resuming dfn3/DeepFilterNet3.zip at 100 of {len(world.dfn_zip)} bytes" in out
    assert re.search(r"^dfn3: complete$", out, re.MULTILINE), out


def test_a_resumed_file_with_a_wrong_hash_is_rejected_then_fetched_again_from_zero(world, capsys):
    handler = RangeHttps(world.routes, TRIM_URL, cuts=[100], ranged="corrupt")

    assert resumable_run(world, handler) == 0

    assert world.installed(TRIM_INSTALLED).read_bytes() == TRIM_BODY, "the corrupt join was never installed"
    assert ranges_for(handler, TRIM_URL) == [None, "bytes=100-", None], "attempt 3 starts from zero"
    out = capsys.readouterr().out
    assert "sha256 mismatch" in out and out.count("failed") == 2
    assert world.leftovers() == []


def test_a_resumed_file_that_never_verifies_fails_the_run_and_installs_nothing(world, capsys):
    handler = RangeHttps(world.routes, TRIM_URL, cuts=[100, None, 100], ranged="corrupt")

    assert resumable_run(world, handler) == 1

    assert ranges_for(handler, TRIM_URL) == [None, "bytes=100-", None]
    assert "sha256 mismatch" in capsys.readouterr().out
    assert not world.installed(TRIM_INSTALLED).exists()
    assert [p.read_bytes() for p in world.leftovers()] == [TRIM_BODY[:100]], "only the last attempt's cut partial is kept"


def test_the_retry_count_is_unchanged_when_every_attempt_is_cut(world, capsys):
    handler = RangeHttps(world.routes, TRIM_URL, cuts=[10, 10, 10, 10], drop="reset")

    assert resumable_run(world, handler) == 1

    assert ranges_for(handler, TRIM_URL) == [None, "bytes=10-", "bytes=20-"], "three attempts in all"
    out = capsys.readouterr().out
    assert "FAILED" in out and "connection dropped" in out
    assert not world.installed(TRIM_INSTALLED).exists()
    assert [p.read_bytes() for p in world.leftovers()] == [TRIM_BODY[:30]], "the partial is kept for the next run"


# --- resuming across runs (October 9, 2026, later) -------------------------------------------
# Real trigger: Docker Desktop restarted its engine twice mid-download and the next run started the
# same multi-gigabyte file over.

TRIM_PARTIAL = fm.TEMP_PREFIX + "Cnn14_mAP=0.431.pth" + fm.TEMP_SUFFIX


def plant_trim_partial(world, data):
    partial = world.installed("trim") / TRIM_PARTIAL
    partial.parent.mkdir(parents=True, exist_ok=True)
    partial.write_bytes(data)
    return partial


def test_a_partial_left_by_an_earlier_run_is_resumed_by_the_next(world, capsys):
    plant_trim_partial(world, TRIM_BODY[:60])
    handler = RangeHttps(world.routes, TRIM_URL)

    assert resumable_run(world, handler) == 0

    assert_fully_installed(world)
    assert ranges_for(handler, TRIM_URL) == ["bytes=60-"], "only the missing bytes are asked for"
    out = capsys.readouterr().out
    assert "keeping the partial download" in out
    assert f"resuming {TRIM_INSTALLED} at 60 of {len(TRIM_BODY)} bytes" in out
    assert "0 leftover temporary files removed" in out


def test_a_run_whose_every_attempt_is_cut_is_finished_by_the_next_run(world):
    first = RangeHttps(world.routes, TRIM_URL, cuts=[10, 10, 10], drop="reset")
    assert resumable_run(world, first) == 1
    second = RangeHttps(world.routes, TRIM_URL)

    assert resumable_run(world, second) == 0

    assert_fully_installed(world)
    assert ranges_for(second, TRIM_URL) == ["bytes=30-"]


def test_still_to_download_and_the_space_check_count_only_the_bytes_not_yet_held(world, capsys):
    plant_trim_partial(world, TRIM_BODY[:60])
    world.free = world.space_needed() - 60 + fm.SPARE_BYTES  # enough only because 60 bytes are held

    assert world.run() == 0

    out = capsys.readouterr().out
    trim = [b for k, b in world.bodies.items() if k.startswith("trim/")]
    total = sum(len(b) for b in trim)
    assert f"trim: 2 files, {total} bytes; 2 to download ({total - 60} bytes)" in out
    assert_fully_installed(world)


def test_a_resumed_partial_with_wrong_bytes_is_rejected_then_fetched_again_from_zero(world, capsys):
    plant_trim_partial(world, b"Z" * 60)  # damaged, for example by a power cut
    handler = RangeHttps(world.routes, TRIM_URL)

    assert resumable_run(world, handler) == 0

    assert world.installed(TRIM_INSTALLED).read_bytes() == TRIM_BODY
    assert ranges_for(handler, TRIM_URL) == ["bytes=60-", None]
    assert "sha256 mismatch" in capsys.readouterr().out and world.leftovers() == []


def test_a_partial_dfn3_archive_from_an_earlier_run_is_resumed(world, capsys):
    leftover = world.dfn_root() / (fm.TEMP_PREFIX + "DeepFilterNet3.zip" + fm.TEMP_SUFFIX)
    leftover.parent.mkdir(parents=True)
    leftover.write_bytes(world.dfn_zip[:100])
    handler = RangeHttps(world.routes, world.dfn_url)

    assert resumable_run(world, handler) == 0

    assert ranges_for(handler, world.dfn_url) == ["bytes=100-"]
    assert dfn_files(world) == ["checkpoints/model_120.ckpt.best", "config.ini"] and world.leftovers() == []
    assert "keeping the partial download" in capsys.readouterr().out


@pytest.mark.parametrize("why", ["file-present", "too-long", "empty"])
def test_a_leftover_that_is_not_a_resumable_partial_is_swept(world, capsys, why):
    if why == "file-present":
        assert world.run() == 0  # everything installed, Trim included
        partial = plant_trim_partial(world, TRIM_BODY[:60])
    else:
        partial = plant_trim_partial(world, TRIM_BODY + b"!" if why == "too-long" else b"")
    capsys.readouterr()
    handler = RangeHttps(world.routes, TRIM_URL)

    assert resumable_run(world, handler) == 0

    assert not partial.exists() and "removing leftover temporary file" in capsys.readouterr().out
    assert ranges_for(handler, TRIM_URL) == ([] if why == "file-present" else [None])
    assert_fully_installed(world)


def test_a_symlink_named_like_a_partial_is_swept_and_never_followed(world, tmp_path):
    target = tmp_path / "elsewhere.bin"
    target.write_bytes(TRIM_BODY[:60])
    world.installed("trim").mkdir(parents=True)
    link = world.installed("trim") / TRIM_PARTIAL
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks")
    handler = RangeHttps(world.routes, TRIM_URL)

    assert resumable_run(world, handler) == 0

    assert not os.path.lexists(link) and target.read_bytes() == TRIM_BODY[:60]
    assert ranges_for(handler, TRIM_URL) == [None]
    assert_fully_installed(world)


class InterruptedBody(io.BytesIO):
    """Delivers `stop_after` bytes, then raises KeyboardInterrupt the way Ctrl+C lands mid-read."""

    def __init__(self, data, stop_after):
        super().__init__(data)
        self.stop_after = stop_after

    def read(self, size=-1):
        if self.tell() >= self.stop_after:
            raise KeyboardInterrupt
        return super().read(min(size, self.stop_after - self.tell()) if size and size > 0 else self.stop_after)


def test_ctrl_c_mid_transfer_keeps_the_partial(world):
    class CtrlC(RangeHttps):
        def https_open(self, request):
            response = super().https_open(request)
            if request.full_url == TRIM_URL:
                response.fp = InterruptedBody(TRIM_BODY, 50)
                response.read = response.fp.read
            return response

    with pytest.raises(KeyboardInterrupt):
        resumable_run(world, CtrlC(world.routes, TRIM_URL))

    assert [p.read_bytes() for p in world.leftovers()] == [TRIM_BODY[:50]]


# --- reusing model files already on this machine (October 9, 2026, later still) ---------------
# Real trigger: Doug, "Why do we keep having to re-download these models over and over?" A new data
# folder on a machine that already holds a verified set (a reinstall into another folder, a second
# instance, a test install) copies from the local set instead of downloading 62.5 GB again.


def make_seed(world, tmp_path, name, *, only=None):
    """A seed models folder with the same layout as the destination, holding every file the world
    expects (or just those whose relative path starts with one of `only`)."""
    seed = tmp_path / name
    for relative, body in world.bodies.items():
        if only is None or any(relative.startswith(prefix) for prefix in only):
            target = seed / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
    return seed


def tree_snapshot(top):
    """Everything under top: directories, file bytes and modification times; to prove nothing was written."""
    return sorted((p.relative_to(top).as_posix(), p.is_dir(), None if p.is_dir() else p.read_bytes(),
                   p.stat().st_mtime_ns) for p in [top, *top.rglob("*")])


def test_a_missing_file_is_copied_from_a_seed_without_any_request(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1")

    assert world.run(seeds=[seed]) == 0

    assert_fully_installed(world)
    assert world.handler.requested == [], "everything came from the seed: no request at all"
    out = capsys.readouterr().out
    assert "Model fetch complete: 15 files verified (0 already present, 0 downloaded, 15 copied from local copies" in out
    assert "Still to copy from local copies:" in out and "Still to download: 0 bytes." in out
    assert re.search(r"^dfn3: complete$", out, re.MULTILINE), out
    # copied, not linked: the installed file is its own file
    assert not os.path.samefile(world.installed(TRIM_INSTALLED), seed / TRIM_INSTALLED)


def test_copy_and_download_bytes_are_reported_separately_per_model(world, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(fm, "human", str)  # exact byte counts instead of rounded ones
    seed = make_seed(world, tmp_path, "seed1", only=("trim/", "acestep/"))

    assert world.run(seeds=[seed]) == 0

    out = capsys.readouterr().out
    trim = sum(len(b) for k, b in world.bodies.items() if k.startswith("trim/"))
    ace = sum(len(b) for k, b in world.bodies.items() if k.startswith("acestep/"))
    vox = sum(len(b) for k, b in world.bodies.items() if k.startswith("voxcpm2/"))
    assert f"trim: 2 files, {trim}; 2 to copy from local copies ({trim}), 0 to download (0)" in out
    assert f"acestep: 2 files, {ace}; 2 to copy from local copies ({ace}), 0 to download (0)" in out
    assert f"voxcpm2: 2 files, {vox}; 0 to copy from local copies (0), 2 to download ({vox})" in out
    assert f"Still to copy from local copies: {trim + ace}." in out
    assert "Model fetch complete: 15 files verified (0 already present, 11 downloaded, 4 copied from local copies" in out
    assert "https://hf.example/trim/p" not in world.handler.requested
    assert "https://hf.example/vx/m" in world.handler.requested
    assert_fully_installed(world)


def test_the_space_check_covers_copy_download_and_extraction_bytes(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1", only=("trim/",))
    # the destination ends up holding every locked byte, plus the archive that is fetched and discarded
    need = world.space_needed()

    world.free = need + fm.SPARE_BYTES - 1
    assert world.run(seeds=[seed]) == 1
    err = capsys.readouterr().err
    assert "not enough free space" in err and "to copy" in err and "to extract" in err
    assert world.handler.requested == [] and not world.installed(TRIM_INSTALLED).exists()

    world.free = need + fm.SPARE_BYTES
    assert world.run(seeds=[seed]) == 0


def test_the_space_check_runs_when_only_copying_and_nothing_is_downloaded(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1")
    # DFN3 members come from the seed too, so no archive is fetched: copy bytes are every locked byte
    copy_only = sum(len(b) for b in world.bodies.values())

    world.free = copy_only + fm.SPARE_BYTES - 1
    assert world.run(seeds=[seed]) == 1
    assert "not enough free space" in capsys.readouterr().err
    assert world.handler.requested == [] and world.leftovers() == []

    world.free = copy_only + fm.SPARE_BYTES
    assert world.run(seeds=[seed]) == 0


def test_with_no_seeds_the_run_is_exactly_as_before(world, capsys):
    assert world.run(seeds=[]) == 0
    out = capsys.readouterr().out
    assert "local cop" not in out and "copied" not in out and "Local model folders" not in out
    assert "Model fetch complete: 15 files verified (0 already present, 15 downloaded, 0 leftover temporary files removed)" in out
    assert "2 to download (" in out and "Still to download:" in out


@pytest.mark.parametrize("flaw", ["wrong-hash", "wrong-size", "open-denied", "read-error"])
def test_an_unusable_seed_file_is_skipped_then_the_next_seed_is_used(world, tmp_path, capsys, monkeypatch, flaw):
    first = make_seed(world, tmp_path, "seed1")
    second = make_seed(world, tmp_path, "seed2")
    bad = first / TRIM_INSTALLED
    if flaw == "wrong-hash":
        bad.write_bytes(b"Z" * len(TRIM_BODY))
    elif flaw == "wrong-size":
        bad.write_bytes(TRIM_BODY[:-1])
    elif flaw == "open-denied":
        real_open = os.open

        def deny(path, *args, **kwargs):
            if Path(path) == bad:
                raise PermissionError(13, "Permission denied")
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr(fm.os, "open", deny)
    else:
        real_open, real_fdopen = os.open, os.fdopen
        bad_descriptors = set()

        class Unreadable:
            """The seed file as a failing disk shows it: it opens, then the first read fails."""
            def __init__(self, real):
                self.real = real
            def __enter__(self):
                return self
            def __exit__(self, *exc):
                self.real.close()
            def fileno(self):
                return self.real.fileno()
            def read(self, size=-1):
                raise OSError(5, "Input/output error")

        def remembering_open(path, *args, **kwargs):
            descriptor = real_open(path, *args, **kwargs)
            if Path(path) == bad:
                bad_descriptors.add(descriptor)
            return descriptor

        def fdopen(descriptor, *args, **kwargs):
            stream = real_fdopen(descriptor, *args, **kwargs)
            if descriptor in bad_descriptors:
                bad_descriptors.discard(descriptor)  # descriptor numbers are reused once the file is closed
                return Unreadable(stream)
            return stream

        monkeypatch.setattr(fm.os, "open", remembering_open)
        monkeypatch.setattr(fm.os, "fdopen", fdopen)

    assert world.run(seeds=[first, second]) == 0

    assert_fully_installed(world)
    assert world.handler.requested == [], "the second seed supplied it: the publisher was not asked"
    out = capsys.readouterr().out
    assert f"copied from the local copy {second / TRIM_INSTALLED}" in out
    if flaw == "wrong-size":
        assert f"seed {first}: trim/Cnn14_mAP=0.431.pth" in out and "bytes, expected" in out
    else:
        assert f"the local copy {bad}" in out and "trying the next source" in out
    if flaw == "wrong-hash":
        assert "sha256 mismatch" in out
    if flaw == "read-error":
        assert "read error" in out


@pytest.mark.parametrize("flaw", ["wrong-hash", "wrong-size"])
def test_when_no_seed_is_usable_the_publisher_is_used_from_zero(world, tmp_path, capsys, flaw):
    seed = make_seed(world, tmp_path, "seed1")
    (seed / TRIM_INSTALLED).write_bytes(b"Z" * len(TRIM_BODY) if flaw == "wrong-hash" else b"short")

    assert world.run(seeds=[seed]) == 0

    assert_fully_installed(world)
    assert world.handler.requested == ["https://hf.example/trim/p"]
    out = capsys.readouterr().out
    if flaw == "wrong-hash":
        assert "no local copy was usable; downloading it" in out
    assert "1 downloaded, 14 copied from local copies" in out


def test_a_wrong_seed_file_is_never_taken_even_when_it_is_the_only_source_and_the_publisher_is_down(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1", only=("trim/",))
    (seed / TRIM_INSTALLED).write_bytes(b"Z" * len(TRIM_BODY))
    world.routes[TRIM_URL] = (404, {}, b"missing")

    assert world.run(seeds=[seed]) == 1

    assert not world.installed(TRIM_INSTALLED).exists() and world.leftovers() == []
    assert "FAILED" in capsys.readouterr().out


def test_a_symlinked_seed_component_is_refused_and_never_followed(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1")
    real = make_seed(world, tmp_path, "real-copy", only=("trim/",))
    shutil.rmtree(seed / "trim")
    try:
        os.symlink(real / "trim", seed / "trim", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks")

    assert world.run(seeds=[seed]) == 0

    assert_fully_installed(world)
    assert world.handler.requested == ["https://hf.example/trim/p", "https://hf.example/trim/c"]
    assert "is a symlink; not used" in capsys.readouterr().out


def test_a_symlinked_seed_file_is_refused_and_never_followed(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1")
    elsewhere = tmp_path / "elsewhere.bin"
    elsewhere.write_bytes(TRIM_BODY)  # the right bytes: the link is refused for being a link, not for its content
    (seed / TRIM_INSTALLED).unlink()
    try:
        os.symlink(elsewhere, seed / TRIM_INSTALLED)
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks")

    assert world.run(seeds=[seed]) == 0

    assert_fully_installed(world)
    assert world.handler.requested == [TRIM_URL], "the link was refused: the publisher supplied the file"
    assert "is a symlink; not used" in capsys.readouterr().out and elsewhere.read_bytes() == TRIM_BODY


@pytest.mark.parametrize("swap", ["different-size", "symlink"])
def test_a_seed_path_that_changes_between_the_probe_and_the_open_is_not_used(world, tmp_path, capsys, monkeypatch, swap):
    seed = make_seed(world, tmp_path, "seed1")
    victim = seed / TRIM_INSTALLED
    elsewhere = tmp_path / "elsewhere.bin"
    elsewhere.write_bytes(TRIM_BODY)
    real = fm.seed_candidates

    def probe_then_swap(item, root, seeds):
        found = real(item, root, seeds)
        if item.path.name == "Cnn14_mAP=0.431.pth":
            victim.unlink()
            if swap == "different-size":
                victim.write_bytes(TRIM_BODY + b"!")
            else:
                try:
                    os.symlink(elsewhere, victim)
                except (OSError, NotImplementedError):
                    pytest.skip("this host cannot create symlinks")
        return found

    monkeypatch.setattr(fm, "seed_candidates", probe_then_swap)

    assert world.run(seeds=[seed]) == 0

    assert_fully_installed(world)
    assert world.handler.requested == [TRIM_URL]
    assert "is no longer usable" in capsys.readouterr().out
    assert elsewhere.read_bytes() == TRIM_BODY


def test_seeds_are_never_written(world, tmp_path):
    seed = make_seed(world, tmp_path, "seed1")
    (seed / TRIM_INSTALLED).write_bytes(b"Z" * len(TRIM_BODY))  # a bad file the run must also leave alone
    (seed / "stray.txt").write_bytes(b"not in any lock")
    before = tree_snapshot(seed)

    assert world.run(seeds=[seed]) == 0

    assert tree_snapshot(seed) == before
    assert not (world.root / "stray.txt").exists()


def test_the_first_listed_seed_that_works_is_the_one_used(world, tmp_path, capsys):
    first = make_seed(world, tmp_path, "seed1", only=("trim/",))
    second = make_seed(world, tmp_path, "seed2", only=("trim/",))

    assert world.run(seeds=[second, first]) == 0
    out = capsys.readouterr().out
    assert f"copied from the local copy {second / TRIM_INSTALLED}" in out and str(first / TRIM_INSTALLED) not in out

    world.installed(TRIM_INSTALLED).unlink()
    assert world.run(seeds=[first, second]) == 0
    out = capsys.readouterr().out
    assert f"copied from the local copy {first / TRIM_INSTALLED}" in out and str(second / TRIM_INSTALLED) not in out


def test_a_kept_partial_is_discarded_when_the_file_is_copied_from_a_seed(world, tmp_path, capsys):
    partial = plant_trim_partial(world, TRIM_BODY[:60])
    seed = make_seed(world, tmp_path, "seed1")

    assert world.run(seeds=[seed]) == 0

    assert not partial.exists() and world.leftovers() == []
    assert world.handler.requested == []
    out = capsys.readouterr().out
    assert "removing leftover temporary file" in out and "keeping the partial download" not in out
    assert_fully_installed(world)


def test_a_kept_partial_is_still_resumed_when_no_seed_holds_the_file(world, tmp_path):
    plant_trim_partial(world, TRIM_BODY[:60])
    seed = make_seed(world, tmp_path, "seed1", only=("acestep/",))
    handler = RangeHttps(world.routes, TRIM_URL)

    assert world.run(seeds=[seed], opener=fm.make_opener(handler)) == 0

    assert ranges_for(handler, TRIM_URL) == ["bytes=60-"]
    assert_fully_installed(world)


def test_dfn3_members_both_in_a_seed_download_no_archive_and_delete_a_kept_archive_partial(world, tmp_path, capsys):
    leftover = world.dfn_root() / (fm.TEMP_PREFIX + "DeepFilterNet3.zip" + fm.TEMP_SUFFIX)
    leftover.parent.mkdir(parents=True)
    leftover.write_bytes(world.dfn_zip[:100])
    seed = make_seed(world, tmp_path, "seed1", only=("cleanup/",))
    del world.routes[world.dfn_url]  # a request for the archive would now fail

    assert world.run(seeds=[seed]) == 0

    assert world.dfn_url not in world.handler.requested
    assert dfn_files(world) == ["checkpoints/model_120.ckpt.best", "config.ini"] and world.leftovers() == []
    out = capsys.readouterr().out
    assert "removing leftover temporary file" in out and "keeping the partial download" not in out
    assert "2 to copy from local copies" in out and "0 to install from an archive" not in out


def test_dfn3_one_member_from_a_seed_and_the_other_from_the_archive(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1", only=("cleanup/dfn3/config.ini",))

    assert world.run(seeds=[seed]) == 0

    assert world.handler.requested.count(world.dfn_url) == 1
    assert (world.dfn_root() / "config.ini").read_bytes() == world.dfn_config
    assert (world.dfn_root() / "checkpoints" / "model_120.ckpt.best").read_bytes() == world.dfn_checkpoint
    assert world.leftovers() == []
    out = capsys.readouterr().out
    assert "dfn3: 2 files" in out and "1 to copy from local copies" in out and "1 to install from an archive download" in out


def test_dfn3_a_bad_seed_member_falls_back_to_the_archive(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1", only=("cleanup/",))
    (seed / "cleanup" / "dfn3" / "config.ini").write_bytes(b"x" * len(world.dfn_config))

    assert world.run(seeds=[seed]) == 0

    assert world.handler.requested.count(world.dfn_url) == 1
    assert (world.dfn_root() / "config.ini").read_bytes() == world.dfn_config
    assert (world.dfn_root() / "checkpoints" / "model_120.ckpt.best").read_bytes() == world.dfn_checkpoint
    assert world.leftovers() == []
    assert "no local copy was usable; downloading it" in capsys.readouterr().out


def test_a_mismatching_destination_file_is_still_never_replaced_from_a_seed(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1")
    victim = world.installed(TRIM_INSTALLED)
    victim.parent.mkdir(parents=True)
    victim.write_bytes(b"a file the user changed")

    assert world.run(seeds=[seed]) == 1

    assert victim.read_bytes() == b"a file the user changed"
    assert f"MISMATCH {victim}" in capsys.readouterr().out


def test_ctrl_c_during_a_seed_copy_leaves_no_temporary_file(world, tmp_path, monkeypatch):
    seed = make_seed(world, tmp_path, "seed1", only=("trim/",))

    def interrupted(stream):
        first = []

        def read(size):
            if first:
                raise KeyboardInterrupt
            first.append(1)
            return stream.read(10)  # some bytes reach the temporary before the interrupt lands

        return read

    monkeypatch.setattr(fm, "seed_reader", interrupted)
    with pytest.raises(KeyboardInterrupt):
        world.run(seeds=[seed])

    assert world.leftovers() == [], "a copy keeps no partial file: only downloads are resumable"
    assert not world.installed(TRIM_INSTALLED).exists()


def test_seed_entries_must_be_models_seed_numbers_that_are_real_directories():
    everything_is_a_directory = lambda path: True
    parsed = fm.seed_roots("/models-seed/1:/models-seed/2:/models-seed/1::/etc:/models-seed/x:/models-seed/3/../1:"
                           "/models-seed/12:models-seed/4", everything_is_a_directory)
    assert parsed == [Path("/models-seed/1"), Path("/models-seed/2"), Path("/models-seed/12")]
    assert fm.seed_roots("", everything_is_a_directory) == []
    assert fm.seed_roots("/models-seed/5", lambda path: False) == []


def test_the_environment_variable_only_honors_models_seed_paths(world, tmp_path, capsys):
    seed = make_seed(world, tmp_path, "seed1")
    world.env[fm.SEEDS_VARIABLE] = str(seed)  # a real directory, but not /models-seed/<n>

    assert world.run() == 0

    assert "ignoring VOCALIS_MODEL_SEEDS entry" in capsys.readouterr().out
    assert_fully_installed(world)
    assert world.handler.requested.count(TRIM_URL) == 1, "nothing was copied: the entry was not a /models-seed/<n> path"