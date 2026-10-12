import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest


PACKAGING = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("build_main_app", PACKAGING / "build_main_app.py")
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)

CONTRACT = {"profiles": {"cuda": {}, "rocm": {}}}
IMAGE_ID = "sha256:" + "a" * 64


def _inputs(**overrides):
    inputs = {
        "schemaVersion": 1,
        "profile": "cuda",
        "sourceRevision": "b" * 40,
        "dependencyImage": {"reference": "vocalis-base:tag", "imageId": IMAGE_ID},
        "imageContexts": {name: {"reference": f"{name}:tag", "imageId": IMAGE_ID}
                          for name in helper.IMAGE_CONTEXTS},
    }
    inputs.update(overrides)
    return inputs


def _write(tmp_path, data):
    path = tmp_path / "inputs.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_valid_inputs_are_accepted(tmp_path):
    assert helper.validate_input_file(_write(tmp_path, _inputs()), CONTRACT)["profile"] == "cuda"


@pytest.mark.parametrize("overrides, message", [
    ({"profile": "metal"}, "cuda or rocm"),
    ({"sourceRevision": "abc123"}, "40-character"),
    ({"dependencyImage": {"reference": "vocalis-base:tag", "imageId": "a" * 64}}, "full sha256"),
    ({"dependencyImage": {"reference": "two words", "imageId": IMAGE_ID}}, "local image reference"),
])
def test_invalid_inputs_are_refused(tmp_path, overrides, message):
    with pytest.raises(SystemExit, match=message):
        helper.validate_input_file(_write(tmp_path, _inputs(**overrides)), CONTRACT)


def test_every_component_context_is_required(tmp_path):
    contexts = _inputs()["imageContexts"]
    contexts.pop("dfn-engine")
    with pytest.raises(SystemExit, match="Required component image contexts"):
        helper.validate_input_file(_write(tmp_path, _inputs(imageContexts=contexts)), CONTRACT)


REAL_CONTRACT = json.loads((PACKAGING / "main-app-build.json").read_text(encoding="utf-8"))


def _acquisition_files():
    spec = REAL_CONTRACT["modelAcquisition"]
    return spec, [*spec["codeFiles"], *spec["noticeFiles"]]


def test_every_model_acquisition_file_is_a_frozen_source_input_and_exists():
    spec, names = _acquisition_files()
    inputs = set(REAL_CONTRACT["sourceInputs"])
    for name in names:
        path = f"{spec['root']}/{name}"
        assert path in inputs, f"{path} must be listed in sourceInputs so the Git archive carries it"
        assert (PACKAGING.parent / path).is_file(), path
    assert len(names) == len(set(names))
    assert "model-acquisition" in REAL_CONTRACT["constructedContexts"]


def test_model_acquisition_context_layout_matches_what_the_dockerfile_copies(tmp_path):
    spec, _ = _acquisition_files()
    context_root = tmp_path / "inputs"
    context_root.mkdir()
    context = helper.prepare_model_acquisition_context(PACKAGING.parent, context_root, REAL_CONTRACT)

    built = {p.relative_to(context).as_posix() for p in context.rglob("*") if p.is_file()}
    assert built == {f"code/{n}" for n in spec["codeFiles"]} | {f"notices/{n}" for n in spec["noticeFiles"]}

    dockerfile = (PACKAGING / "main-cuda" / "Dockerfile.app").read_text(encoding="utf-8")
    name = spec["context"]
    assert f"COPY --from={name} /code/ /usr/share/vocalis-g1/models/" in dockerfile
    assert f"COPY --from={name} /notices/ /usr/share/licenses/vocalis-g1/models/" in dockerfile
    # The existing Chatterbox paths stay where tts_utils.py pins them.
    assert "/manifest.json /usr/share/vocalis-g1/chatterbox-model-manifest.json" in dockerfile
    # The copied fetcher must find its lock files beside itself with the layout the fetcher expects.
    fetcher = importlib.util.spec_from_file_location("fetch_models_in_context", context / "code" / "fetch_models.py")
    module = importlib.util.module_from_spec(fetcher)
    sys.modules["fetch_models_in_context"] = module
    fetcher.loader.exec_module(module)
    chatterbox = PACKAGING / "models" / "chatterbox" / "manifest.json"
    # LEADVOCAL_MODELS (October 11, 2026) is the destination of the Lead Vocal lock, so the fetcher reads it.
    image_env = re.findall(r"^\s+((?:VOCALIS|LEADVOCAL)_[A-Z_]+)=(\S+?)(?: \\)?$", dockerfile, re.MULTILINE)
    env = {variable: value.replace("/models/vocalis", str(tmp_path / "m"), 1) for variable, value in image_env}
    plan = module.build_plan(env, context / "code", chatterbox, str(tmp_path / "m"))
    # 45 single-URL files plus the two DeepFilterNet3 archive members; October 11, 2026: plus HTDemucs (1), the
    # nine Lead Vocal files and the eleven ACE-Step XL SFT files, plus (same day) the eleven XL Base files.
    assert len(plan) == 47 + 1 + 9 + 11 + 11


def test_a_model_acquisition_file_missing_from_the_frozen_tree_is_refused(tmp_path):
    spec, _ = _acquisition_files()
    git_root = tmp_path / "git"
    (git_root / spec["root"]).mkdir(parents=True)
    context_root = tmp_path / "inputs"
    context_root.mkdir()
    with pytest.raises(SystemExit, match="Expected regular build input"):
        helper.prepare_model_acquisition_context(git_root, context_root, REAL_CONTRACT)


# October 10, 2026 (design section 10, "Whole-card memory and readings on NVIDIA, and on AMD
# satellites", Packaging): the readout module is a fourth shared satellite module, and the NVIDIA
# profile installs the pinned nvidia-ml-py wheel from the `nvml` context.
SHARED_SATELLITE_MODULES = ("vocalis_stream_core.py", "vocalis_satellite_protocol.py",
                            "vocalis_torch_backend.py", "vocalis_satellite_gpustats.py")
NVML_WHEEL = "nvidia_ml_py-13.615.71-py3-none-any.whl"
NVML_SHA256 = "959bf4adf6fe1308e4bd739e722236b0d1ec8392e2cefad33ff70c311380b9b6"


def _dockerfile():
    return (PACKAGING / "main-cuda" / "Dockerfile.app").read_text(encoding="utf-8")


def test_every_shared_satellite_module_is_an_input_a_context_file_and_a_dockerfile_copy(tmp_path):
    dockerfile = _dockerfile()
    inputs = set(REAL_CONTRACT["sourceInputs"])
    for name in SHARED_SATELLITE_MODULES:
        assert f"source/vocalis/satellite/{name}" in inputs, name
        assert (PACKAGING.parent / "source/vocalis/satellite" / name).is_file(), name
        assert (f"COPY --from=vocalis-license /satellite/{name} /opt/vocalis/satellite/{name}"
                in dockerfile), name
    # The context builder copies exactly this set, no more and no less, into the license context.
    source = (PACKAGING / "build_main_app.py").read_text(encoding="utf-8")
    tuple_text = source.split("satellite = license_context / \"satellite\"", 1)[1].split(
        "copy_file(app_root", 1)[0]
    assert tuple(re.findall(r'"(vocalis_[a-z_]+\.py)"', tuple_text)) == SHARED_SATELLITE_MODULES


def test_nvml_inputs_are_frozen_source_inputs_and_the_context_matches_the_lock(tmp_path):
    spec = REAL_CONTRACT["nvmlContext"]
    inputs = set(REAL_CONTRACT["sourceInputs"])
    assert "nvml" in REAL_CONTRACT["constructedContexts"]
    assert sorted(spec["files"]) == sorted([NVML_WHEEL, "requirements.lock", "LICENSE-nvidia-ml-py.txt"])
    for name in spec["files"]:
        path = f"{spec['root']}/{name}"
        assert path in inputs, f"{path} must be listed in sourceInputs so the input hash covers it"
        assert (PACKAGING.parent / path).is_file(), path

    context_root = tmp_path / "inputs"
    context_root.mkdir()
    context = helper.prepare_nvml_context(PACKAGING.parent, context_root, REAL_CONTRACT)
    assert context.name == spec["context"]
    assert sorted(p.name for p in context.iterdir()) == sorted(spec["files"])
    # The copied wheel is the pinned one, and the lock names exactly it with its hash.
    assert helper.sha256_file(context / NVML_WHEEL) == NVML_SHA256
    lock = (context / "requirements.lock").read_text(encoding="utf-8")
    assert "nvidia-ml-py==13.615.71" in lock and f"--hash=sha256:{NVML_SHA256}" in lock
    assert (context / "LICENSE-nvidia-ml-py.txt").read_text(encoding="utf-8").startswith("nvidia-ml-py 13.615.71")


def test_a_missing_nvml_file_is_refused(tmp_path):
    git_root = tmp_path / "git"
    (git_root / REAL_CONTRACT["nvmlContext"]["root"]).mkdir(parents=True)
    context_root = tmp_path / "inputs"
    context_root.mkdir()
    with pytest.raises(SystemExit, match="Expected regular build input"):
        helper.prepare_nvml_context(git_root, context_root, REAL_CONTRACT)


def test_the_nvml_context_is_passed_to_the_build_as_a_named_context():
    # main() needs Docker; read its source for the one argument pair that brings the wheel in.
    import inspect
    assert "nvmlContext" in inspect.getsource(helper.main)
    assert "--build-context" in inspect.getsource(helper.main)
    assert "prepare_nvml_context(git_root, context_root, contract)" in inspect.getsource(helper.prepare_contexts)


def test_the_dockerfile_installs_nvml_for_the_nvidia_profile_only_and_offline():
    dockerfile = _dockerfile()
    install = dockerfile.index("RUN --mount=type=bind,from=nvml,target=/nvml,readonly")
    block = dockerfile[install:dockerfile.index("\n\n", install)]
    # Offline, hash-checked, no dependencies, into the primary environment, CUDA profile only.
    for flag in ("--no-index", "--no-deps", "--require-hashes", "--only-binary=:all:",
                 "--find-links=/nvml", "-r /nvml/requirements.lock", '"${APP_PRIMARY_PYTHON}" -m pip install'):
        assert flag in block, flag
    assert 'if [ "${APP_PROFILE}" = "cuda" ]; then' in block
    assert block.index('if [ "${APP_PROFILE}" = "cuda" ]') < block.index("pip install") < block.index("else")
    assert "install -D -m 0644 /nvml/LICENSE-nvidia-ml-py.txt /usr/share/licenses/vocalis-g1/" in block
    assert "index-url" not in block and "extra-index" not in block
    # Before the step that makes the application read-only.
    assert install < dockerfile.index("RUN chmod -R a-w /opt/vocalis/src")


def test_the_dockerfile_checks_the_imports_after_the_copies_and_before_read_only():
    dockerfile = _dockerfile()
    check = dockerfile.index("import vocalis_satellite_gpustats")
    assert dockerfile.index("COPY --from=vocalis-license /satellite/vocalis_satellite_gpustats.py") < check
    assert check < dockerfile.index("RUN chmod -R a-w /opt/vocalis/src")
    tail = dockerfile[check:dockerfile.index("\n\n", check)]
    assert 'sys.path.insert(0, "/opt/vocalis/satellite")' in dockerfile[check - 120:check]
    assert 'if [ "${APP_PROFILE}" = "cuda" ]; then' in tail and "import pynvml" in tail


def test_nvml_files_are_in_the_source_offer_allowlist_and_the_notice_lists_the_package():
    allowlist = json.loads((PACKAGING / "source-offer" / "allowlist.json").read_text(encoding="utf-8"))["files"]
    for name in ("LICENSE-nvidia-ml-py.txt", "README.md", NVML_WHEEL, "requirements.lock"):
        assert f"packaging/nvml/{name}" in allowlist, name
    assert allowlist == sorted(set(allowlist), key=lambda value: value.encode("utf-8"))
    notice = (PACKAGING / "licenses" / "NOTICE.md").read_text(encoding="utf-8")
    assert "nvidia-ml-py 13.615.71" in notice and "BSD 3-Clause" in notice and "NVIDIA Corporation" in notice


def _tar_with(tmp_path, name, *, kind=tarfile.REGTYPE):
    archive = tmp_path / "source.tar"
    with tarfile.open(archive, "w") as stream:
        member = tarfile.TarInfo(name)
        member.type = kind
        if kind == tarfile.SYMTYPE:
            member.linkname = "/etc/passwd"
            stream.addfile(member)
        else:
            member.size = 2
            stream.addfile(member, io.BytesIO(b"ok"))
    return archive


@pytest.mark.parametrize("name, kind", [
    ("../escape.txt", tarfile.REGTYPE),
    ("/absolute.txt", tarfile.REGTYPE),
    ("link", tarfile.SYMTYPE),
])
def test_unsafe_archive_entries_are_refused(tmp_path, name, kind):
    destination = tmp_path / "out"
    destination.mkdir()
    with pytest.raises(SystemExit, match="Unsafe or non-regular"):
        helper.extract_git_archive(_tar_with(tmp_path, name, kind=kind), destination)


def test_regular_archive_entries_are_extracted(tmp_path):
    destination = tmp_path / "out"
    destination.mkdir()
    helper.extract_git_archive(_tar_with(tmp_path, "packaging/file.txt"), destination)
    assert (destination / "packaging/file.txt").read_bytes() == b"ok"


# The leader stands in for the Docker CLI and the grandchild for the buildx
# plugin. Each reports readiness on stdout so the test never sleeps to sync.
_CACHE_LISTING = (
    "ID:\t\tabc\nReclaimable:\ttrue\nShared:\t\ttrue\nSize:\t\t9.2GB\n"
    "Description:\t[vocalis-app 10/57] COPY --from=acestep-engine /opt/venvs/acestep /opt/venvs/acestep\n\n"
    "ID:\t\tdef\nReclaimable:\ttrue\nShared:\t\tfalse\nSize:\t\t1.2GB\n\n"
    "Shared:\t\t193.7GB\nPrivate:\t10.86GB\nReclaimable:\t204.5GB\nTotal:\t\t204.5GB\n"
)


def test_the_build_cache_listing_is_kept_and_its_totals_are_one_line(tmp_path):
    asked = []

    def run(argv, timeout):
        asked.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=_CACHE_LISTING, stderr="")

    line = helper.record_build_cache("some-builder", tmp_path, "build-cache-before.txt", run=run)
    # Each record's own "Shared: true" and "Reclaimable: true" are not totals.
    assert line == "Shared: 193.7GB, Private: 10.86GB, Reclaimable: 204.5GB, Total: 204.5GB"
    assert (tmp_path / "build-cache-before.txt").read_text(encoding="utf-8") == _CACHE_LISTING
    assert asked[0][-5:] == ["buildx", "du", "--builder", "some-builder", "--verbose"]


@pytest.mark.parametrize("failure", [
    subprocess.CalledProcessError(1, ["docker"]),
    subprocess.TimeoutExpired(["docker"], 120),
    OSError("no docker"),
])
def test_a_build_cache_listing_that_cannot_be_read_never_fails_the_build(tmp_path, failure):
    def run(argv, timeout):
        raise failure

    line = helper.record_build_cache("some-builder", tmp_path, "build-cache-before.txt", run=run)
    assert line == f"not read ({type(failure).__name__})"
    assert not (tmp_path / "build-cache-before.txt").exists()


def test_cached_and_run_steps_are_counted_from_the_recipe_steps_only(tmp_path):
    log = tmp_path / "build.log"
    log.write_text(
        "#1 [internal] load build definition from Dockerfile.app\n#1 DONE 0.0s\n"
        "#26 [context voxcpm-source] load from client\n#26 DONE 0.2s\n"
        "#41 [vocalis-app  2/57] WORKDIR /opt/vocalis\n#41 CACHED\n"
        "#61 [vocalis-app  3/57] RUN set -eu\n#61 CACHED\n"
        "#69 [vocalis-app  5/57] COPY --from=voxcpm-engine /a /a\n#69 DONE 18.1s\n"
        # One step can report DONE more than once; it is still one step.
        "#74 [vocalis-app 10/57] COPY --from=acestep-engine /b /b\n#74 DONE 20.0s\n#74 DONE 41.5s\n"
        "#122 exporting to image\n#122 DONE 430.0s\n",
        encoding="utf-8")
    assert helper.cached_step_count(log) == {"cached": 2, "ran": 2}


def test_evidence_that_cannot_be_written_or_read_never_fails_the_build(tmp_path):
    # The listing was read but its file cannot be saved (the evidence folder is gone, a full disk): one line, no exception.
    def run(argv, timeout):
        return subprocess.CompletedProcess(argv, 0, stdout=_CACHE_LISTING, stderr="")

    line = helper.record_build_cache("some-builder", tmp_path / "missing-folder", "build-cache-after.txt", run=run)
    assert line.startswith("read but not saved (") and line.endswith("Error)")
    # A build log that cannot be read gives -1 for both counts; it runs after the build and must not lose its result.
    assert helper.cached_step_count(tmp_path / "no-such-build.log") == {"cached": -1, "ran": -1}


_GRANDCHILD = (
    "import signal, sys, time\n"
    "if sys.argv[1] == 'ignore': signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    "print('ready', flush=True)\n"
    "time.sleep(600)\n"
)
_LEADER = (
    "import signal, subprocess, sys, time\n"
    "mode = sys.argv[1]\n"
    "child = subprocess.Popen([sys.executable, '-c', sys.argv[2], mode], stdout=subprocess.PIPE, text=True)\n"
    "assert child.stdout.readline().strip() == 'ready'\n"
    "if mode == 'ignore': signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    "print(child.pid, flush=True)\n"
    "time.sleep(600)\n"
)


def _process_alive(pid):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = helper._kernel32()
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            assert kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        state = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except OSError:
        return False
    return state[state.rfind(")") + 2] not in "ZX"


def _kill_tree(leader):
    if leader.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(leader.pid), "/T", "/F"], capture_output=True)
    else:
        os.killpg(leader.pid, 9)
    leader.wait(timeout=10)


@pytest.mark.skipif(os.name == "nt", reason="Linux process-group teardown")
@pytest.mark.parametrize("mode, escalates", [("honor", False), ("ignore", True)])
def test_linux_timeout_teardown_removes_the_whole_owned_group(monkeypatch, mode, escalates):
    waits = []
    real_await = helper.await_linux_group_exit

    def short_await(pgid, leader_start, seconds):
        waits.append(seconds)
        return real_await(pgid, leader_start, min(seconds, 2))

    monkeypatch.setattr(helper, "await_linux_group_exit", short_await)
    leader = subprocess.Popen([sys.executable, "-c", _LEADER, mode, _GRANDCHILD],
                              stdout=subprocess.PIPE, start_new_session=True)
    try:
        grandchild = int(leader.stdout.readline())
        created = helper.process_creation_identity(leader.pid)
        assert helper.linux_group_members(leader.pid, created) == sorted([leader.pid, grandchild])

        record = helper.stop_build_process(leader, created, sys.executable)

        assert record["groupEmptyVerified"] is True
        assert record["escalatedToSigkill"] is escalates
        assert leader.returncode is not None
        assert not _process_alive(grandchild)
        assert helper.linux_group_members(leader.pid, created) == []
    finally:
        _kill_tree(leader)
        leader.stdout.close()


@pytest.mark.skipif(os.name == "nt", reason="Linux process-group teardown")
def test_linux_teardown_refuses_a_changed_leader_identity():
    leader = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"],
                              start_new_session=True)
    try:
        created = helper.process_creation_identity(leader.pid)
        with pytest.raises(SystemExit, match="creation identity changed"):
            helper.stop_build_process(leader, created + 1, sys.executable)
        assert leader.poll() is None
    finally:
        _kill_tree(leader)


@pytest.mark.skipif(os.name != "nt", reason="Windows process-tree teardown")
def test_windows_timeout_teardown_removes_the_docker_cli_tree():
    leader = subprocess.Popen([sys.executable, "-c", _LEADER, "honor", _GRANDCHILD],
                              stdout=subprocess.PIPE)
    try:
        grandchild = int(leader.stdout.readline())
        created = helper.process_creation_identity(leader.pid)

        record = helper.stop_build_process(leader, created, sys.executable)

        assert record["taskkillTree"] is True
        assert leader.returncode is not None
        assert not _process_alive(grandchild)
    finally:
        _kill_tree(leader)
        leader.stdout.close()


@pytest.mark.skipif(os.name != "nt", reason="Windows process-tree teardown")
def test_windows_teardown_refuses_a_changed_leader_identity():
    leader = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    try:
        created = helper.process_creation_identity(leader.pid)
        with pytest.raises(SystemExit, match="creation identity changed"):
            helper.stop_build_process(leader, created + 1, sys.executable)
        assert leader.poll() is None
    finally:
        _kill_tree(leader)
