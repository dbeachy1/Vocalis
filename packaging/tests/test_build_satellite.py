"""Tests for packaging/build_satellite.py and the satellite image recipe it builds.

The satellite package: one command per operating system, item 1 (October 10, 2026). Docker is never run here: the command it would run is
asserted instead, and the recipe is checked as text. The real image builds are done by hand and
recorded with the release.
"""

import hashlib
import importlib.util
import re
import sys
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1]
REPO = PACKAGING.parent
_spec = importlib.util.spec_from_file_location("build_satellite", PACKAGING / "build_satellite.py")
build = importlib.util.module_from_spec(_spec)
sys.modules["build_satellite"] = build
_spec.loader.exec_module(build)

DOCKERFILE = (PACKAGING / "satellite" / "Dockerfile").read_text(encoding="utf-8")
IGNORE = (PACKAGING / "satellite" / "Dockerfile.dockerignore").read_text(encoding="utf-8")

CUDA_ID = "sha256:00c74576a8d14dd533a5f56d6289d132cc837f42911ee17831b962afe6d422e0"
ROCM_ID = "sha256:8286bb78f73af7e8065bcf58c8e8022bee604f063e21f406149c7966b5a7d86a"
REVISION = "0123456789abcdef0123456789abcdef01234567"


# --- the recorded bases ---------------------------------------------------------------------

def test_the_recorded_bases_are_the_october_8_chatterbox_dependency_images():
    assert build.BASES == {
        "cuda": {"reference": "vocalis-g1-main-cuda-deps:20261008-vocalis-0.1.7.1",
                 "imageId": CUDA_ID, "venvBin": "/opt/venv/3.12/bin"},
        "rocm": {"reference": "vocalis-g1-main-rocm-app-deps:20261008-vocalis-0.1.7.1",
                 "imageId": ROCM_ID, "venvBin": "/opt/venv/chatterbox/bin"},
    }


@pytest.mark.parametrize("variant", ["cuda", "rocm"])
def test_the_base_is_verified_by_id_before_building(variant):
    base = build.BASES[variant]
    asked = []

    def inspect(reference):
        asked.append(reference)
        return base["imageId"]

    build.verify_base(variant, inspect)
    assert asked == [base["reference"]]


@pytest.mark.parametrize("variant", ["cuda", "rocm"])
@pytest.mark.parametrize("found", [None, "sha256:" + "0" * 64, CUDA_ID.replace("00c7", "00c8")])
def test_a_missing_or_different_base_refuses(variant, found):
    if found in (CUDA_ID, ROCM_ID) and found == build.BASES[variant]["imageId"]:
        pytest.skip("that is the recorded ID")
    with pytest.raises(SystemExit, match="Refusing to build"):
        build.verify_base(variant, lambda reference: found)


def test_the_cuda_id_is_not_accepted_for_rocm_and_the_reverse():
    with pytest.raises(SystemExit):
        build.verify_base("rocm", lambda reference: CUDA_ID)
    with pytest.raises(SystemExit):
        build.verify_base("cuda", lambda reference: ROCM_ID)


# --- the command ----------------------------------------------------------------------------

@pytest.mark.parametrize("variant, venv", [("cuda", "/opt/venv/3.12/bin"),
                                           ("rocm", "/opt/venv/chatterbox/bin")])
def test_the_build_command_is_exact(variant, venv):
    base = build.BASES[variant]
    assert build.build_command(variant, "20261010", "docker", revision=REVISION) == [
        "docker", "buildx", "build", "--builder", "desktop-linux", "--platform", "linux/amd64",
        "--network=none", "--load", "--progress=plain",
        "--file", "packaging/satellite/Dockerfile",
        "--tag", f"vocalis-satellite-{variant}:20261010",
        "--label", f"org.opencontainers.image.revision={REVISION}",
        "--label", f"com.vocalis.profile={variant}",
        "--label", f"com.vocalis.dependency-image-id={base['imageId']}",
        "--build-arg", f"BASE_IMAGE={base['reference']}",
        "--build-arg", f"GPU_TYPE={variant}",
        "--build-arg", f"VENV_BIN={venv}",
        "."]


@pytest.mark.parametrize("variant", ["cuda", "rocm"])
def test_the_command_never_pushes_and_never_uses_the_network(variant):
    command = build.build_command(variant, "t")
    assert "--network=none" in command and "--load" in command
    assert not any("push" in part or "registry" in part for part in command)
    source = (PACKAGING / "build_satellite.py").read_text(encoding="utf-8")
    assert not re.search(r"""["']push["']|--push|type=registry|\bdocker\s+push\b""", source)


def test_the_base_is_passed_by_its_local_tag_not_its_id():
    """BuildKit's docker driver treats an image ID as a registry reference (build_main_app.py)."""
    for variant, base in build.BASES.items():
        command = build.build_command(variant, "t")
        assert f"BASE_IMAGE={base['reference']}" in command
        assert not any(part.startswith("BASE_IMAGE=sha256:") for part in command)


@pytest.mark.parametrize("tag", ["", "has space", "-leading-dash", "a/b", "x" * 129, "UP:colon"])
def test_a_bad_tag_is_refused(tag):
    with pytest.raises(SystemExit, match="Not a usable image tag"):
        build.output_tag("cuda", tag)


def test_the_output_names_follow_the_designed_pattern():
    assert build.output_tag("cuda", "20261010") == "vocalis-satellite-cuda:20261010"
    assert build.output_tag("rocm", "dev-coder2") == "vocalis-satellite-rocm:dev-coder2"


# --- main, with Docker stood in for -----------------------------------------------------------

class Docker:
    """Records the calls main makes and answers image inspections from a table."""

    def __init__(self, tmp_path, monkeypatch, images):
        self.images, self.builds = dict(images), []
        self.build_result = 0
        self.status = ""                    # what `git status --porcelain -z -uall` prints
        monkeypatch.setattr(build, "run_git", self.git)
        monkeypatch.setattr(build, "DOCKER", "docker")
        monkeypatch.setattr(build, "LOG_ROOT", tmp_path / "logs")
        monkeypatch.setattr(build, "local_image_id", lambda reference: self.images.get(reference))
        monkeypatch.setattr(build, "run_build", self.run_build)

    def git(self, args):
        if args[:1] == ["rev-parse"]:
            return REVISION + "\n"
        assert args == ["status", "--porcelain", "-z", "-uall"], args
        return self.status

    def run_build(self, argv, log_path, timeout):
        self.builds.append((argv, log_path, timeout))
        log_path.write_text("#1 building\n", encoding="utf-8")
        if self.build_result == 0:
            tag = argv[argv.index("--tag") + 1]
            self.images[tag] = "sha256:" + "a" * 64
        return self.build_result


@pytest.fixture
def docker(tmp_path, monkeypatch):
    return Docker(tmp_path, monkeypatch, {
        build.BASES["cuda"]["reference"]: CUDA_ID, build.BASES["rocm"]["reference"]: ROCM_ID})


@pytest.mark.parametrize("variant", ["cuda", "rocm"])
def test_main_builds_and_prints_the_new_image_id_last(docker, capsys, variant):
    assert build.main(["--variant", variant, "--tag", "t1"]) == 0
    captured = capsys.readouterr()
    assert captured.out == f"revision={REVISION}\nsha256:" + "a" * 64 + "\n"
    (argv, log_path, timeout), = docker.builds
    assert argv == build.build_command(variant, "t1", "docker", revision=REVISION)
    assert log_path.parent.name == "logs" and timeout == build.BUILD_TIMEOUT_SECONDS
    assert f"vocalis-satellite-{variant}:t1" in captured.err


@pytest.mark.parametrize("changed", [
    "packaging/satellite/satellite_admin.py", "packaging/satellite/Dockerfile",
    "packaging/satellite/Dockerfile.dockerignore", "packaging/models/fetch_models.py",
    "source/vocalis/satellite/server.py", "source/vocalis/src/tts_utils.py",
    "source/vocalis/src/engine_process.py", "source/vocalis/LICENSE",
    "packaging/models/chatterbox/manifest.json", "packaging/nvml/requirements.lock",
    "packaging/licenses/LGPL-2.1.txt", "packaging/licenses/GPL-3.0.txt", "packaging/licenses/rocm-notice-artifacts.json",
    "packaging/licenses/rocm/PyTorch-LICENSE.txt"])
@pytest.mark.parametrize("code", [" M", "M ", "??", "A "])
def test_a_changed_build_input_refuses_the_build_without_allow_dirty(docker, changed, code):
    docker.status = f"{code} {changed}\0"
    with pytest.raises(SystemExit, match="build inputs differ from HEAD") as refusal:
        build.main(["--variant", "cuda", "--tag", "t1"])
    assert changed in str(refusal.value) and "--allow-dirty" in str(refusal.value)
    assert docker.builds == []


@pytest.mark.parametrize("unrelated", [
    "README.md", "packaging/satellite/README.md", "packaging/satellite/satellite-setup.sh",
    "source/vocalis/src/vocalis_server.py", "source/vocalis/satellite/run.bat",
    "source/vocalis/satellite/sub/deep.py", "packaging/tests/test_build_satellite.py",
    "packaging/build_satellite.py", "notes/Design.md"])
def test_a_change_outside_the_build_context_does_not_block_or_dirty_the_build(docker, capsys, unrelated):
    docker.status = f" M {unrelated}\0"
    assert build.main(["--variant", "cuda", "--tag", "t1"]) == 0
    assert f"org.opencontainers.image.revision={REVISION}" in docker.builds[0][0]
    assert capsys.readouterr().out.startswith(f"revision={REVISION}\n")


def test_a_renamed_input_is_found_by_either_name(docker):
    docker.status = "R  packaging/elsewhere.txt\0packaging/models/fetch_models.py\0"
    with pytest.raises(SystemExit, match="fetch_models.py"):
        build.main(["--variant", "cuda", "--tag", "t1"])
    docker.status = "R  packaging/models/fetch_models.py\0packaging/elsewhere.txt\0"
    with pytest.raises(SystemExit, match="fetch_models.py"):
        build.main(["--variant", "cuda", "--tag", "t1"])


def test_allow_dirty_builds_and_labels_the_revision_dirty(docker, capsys):
    docker.status = " M packaging/satellite/satellite_admin.py\0?? source/vocalis/satellite/new.py\0"
    assert build.main(["--variant", "rocm", "--tag", "t1", "--allow-dirty"]) == 0
    argv = docker.builds[0][0]
    assert f"org.opencontainers.image.revision={REVISION}-dirty" in argv
    captured = capsys.readouterr()
    assert captured.out.splitlines()[0] == f"revision={REVISION}-dirty"
    assert "satellite_admin.py" in captured.err and "new.py" in captured.err


def test_allow_dirty_on_a_clean_tree_is_not_labeled_dirty(docker):
    assert build.main(["--variant", "rocm", "--tag", "t1", "--allow-dirty"]) == 0
    assert f"org.opencontainers.image.revision={REVISION}" in docker.builds[0][0]
    assert not any("-dirty" in part for part in docker.builds[0][0])


def test_the_revision_is_checked_before_any_build_and_a_bad_answer_refuses(docker, monkeypatch):
    monkeypatch.setattr(build, "run_git", lambda args: "not a commit\n")
    with pytest.raises(SystemExit, match="Cannot determine the source revision"):
        build.main(["--variant", "cuda", "--tag", "t1"])
    assert docker.builds == []


def test_the_default_git_runner_asks_git_in_the_repository(monkeypatch):
    seen = []

    class Result:
        returncode, stdout, stderr = 0, "out", ""

    monkeypatch.setattr(build.subprocess, "run", lambda argv, **kw: seen.append((argv, kw)) or Result)
    assert build.run_git(["rev-parse", "HEAD"]) == "out"
    assert seen[0][0] == ["git", "rev-parse", "HEAD"] and seen[0][1]["cwd"] == build.ROOT


def test_main_refuses_before_building_when_the_base_is_wrong(docker):
    docker.images[build.BASES["cuda"]["reference"]] = "sha256:" + "1" * 64
    with pytest.raises(SystemExit, match="Refusing to build"):
        build.main(["--variant", "cuda", "--tag", "t1"])
    assert docker.builds == []


def test_main_refuses_to_overwrite_an_existing_tag(docker):
    docker.images["vocalis-satellite-cuda:t1"] = "sha256:" + "b" * 64
    with pytest.raises(SystemExit, match="overwrite"):
        build.main(["--variant", "cuda", "--tag", "t1"])
    assert docker.builds == []


def test_a_failed_build_exits_with_the_log_and_prints_no_id(docker, capsys):
    docker.build_result = 1
    with pytest.raises(SystemExit, match="Build failed with exit code 1"):
        build.main(["--variant", "rocm", "--tag", "t1"])
    assert capsys.readouterr().out == ""


def test_a_base_swapped_during_the_build_is_caught(docker, monkeypatch):
    base = build.BASES["cuda"]["reference"]
    original = docker.run_build

    def swap(argv, log_path, timeout):
        code = original(argv, log_path, timeout)
        docker.images[base] = "sha256:" + "2" * 64
        return code

    monkeypatch.setattr(build, "run_build", swap)
    with pytest.raises(SystemExit, match="Refusing to build"):
        build.main(["--variant", "cuda", "--tag", "t1"])


def test_variant_and_tag_are_required(docker):
    with pytest.raises(SystemExit):
        build.main(["--variant", "cuda"])
    with pytest.raises(SystemExit):
        build.main(["--tag", "t1"])
    with pytest.raises(SystemExit):
        build.main(["--variant", "metal", "--tag", "t1"])


# --- the recipe -------------------------------------------------------------------------------

def _copies():
    return re.findall(r"^COPY --chown=0:0 (\S+) (\S+)$", DOCKERFILE, re.MULTILINE)


def test_the_recipe_takes_the_gpu_type_as_a_build_argument():
    assert re.search(r"^ARG GPU_TYPE$", DOCKERFILE, re.MULTILINE)
    assert re.search(r"^ARG BASE_IMAGE$", DOCKERFILE, re.MULTILINE)
    assert re.search(r"^ARG VENV_BIN=", DOCKERFILE, re.MULTILINE)


def test_the_recipe_installs_the_provisioning_tool_the_fetcher_and_the_missing_helper():
    copies = dict(_copies())
    assert copies["packaging/satellite/satellite_admin.py"] == "/opt/vocalis/satellite-admin/satellite_admin.py"
    assert copies["packaging/models/fetch_models.py"] == "/usr/share/vocalis-g1/models/fetch_models.py"
    assert copies["source/vocalis/src/engine_process.py"] == "/opt/vocalis/src/engine_process.py"
    assert copies["source/vocalis/src/tts_utils.py"] == "/opt/vocalis/src/tts_utils.py"
    # The fetcher is copied as it is: nothing rewrites it after the copy.
    for line in DOCKERFILE.splitlines():
        if "fetch_models.py" in line and not line.lstrip().startswith("#"):
            assert not re.search(r"\b(sed|awk|patch|tee|truncate|mv|cp)\b|>", line), line


def test_tts_utils_needs_engine_process_and_the_recipe_ships_it():
    """The break this repairs: tts_utils imports engine_process at module level."""
    source = (REPO / "source" / "vocalis" / "src" / "tts_utils.py").read_text(encoding="utf-8")
    assert re.search(r"^from engine_process import ", source, re.MULTILINE)
    assert (REPO / "source" / "vocalis" / "src" / "engine_process.py").is_file()


def test_nvidia_ml_py_is_installed_offline_with_hashes_for_cuda_only():
    installs = re.findall(r"pip install[^\n]*", DOCKERFILE)
    assert len(installs) == 1, "the recipe installs exactly one package, from the pinned wheel"
    step = DOCKERFILE[DOCKERFILE.index("RUN --mount=type=bind,source=packaging/nvml"):]
    step = step[:step.index("esac") + 4]
    assert "--no-index --no-deps --require-hashes --only-binary=:all:" in step
    assert "--find-links=/nvml -r /nvml/requirements.lock" in step
    cuda_branch = step[step.index("cuda)"):step.index("rocm)")]
    assert "pip install" in cuda_branch and "nvidia-ml-py-LICENSE.txt" in cuda_branch
    assert "pip install" not in step[step.index("rocm)"):]
    assert "/usr/share/licenses/vocalis-g1/" in cuda_branch
    assert 'GPU_TYPE must be cuda or rocm' in step


def test_the_recipe_stays_offline():
    assert not re.search(r"\b(curl|wget|apt-get|apt|git clone)\b", DOCKERFILE)
    assert "--index-url" not in DOCKERFILE and "--extra-index-url" not in DOCKERFILE
    assert "--network=none" in " ".join(build.build_command("cuda", "t"))


def test_the_pinned_wheel_matches_its_lock_and_its_license_is_in_the_context():
    nvml = PACKAGING / "nvml"
    lock = (nvml / "requirements.lock").read_text(encoding="utf-8")
    digest = re.search(r"--hash=sha256:([0-9a-f]{64})", lock).group(1)
    wheel = nvml / "nvidia_ml_py-13.615.71-py3-none-any.whl"
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == digest
    assert "nvidia-ml-py==13.615.71" in lock
    assert (nvml / "LICENSE-nvidia-ml-py.txt").is_file()


def test_the_import_check_covers_the_new_files():
    smoke = DOCKERFILE[DOCKERFILE.index("python - <<'PY'"):DOCKERFILE.index("\nPY\n")]
    assert "import tts_utils" in smoke and 'sys.path.insert(0, "/opt/vocalis/src")' in smoke
    assert "import pynvml" in smoke and 'os.environ["GPU_TYPE"] == "cuda"' in smoke
    assert "satellite_admin.py" in smoke and "fetch_models.py" in smoke
    assert "SATELLITE_IMPORT_SMOKE=PASS" in smoke


def test_everything_installed_stays_read_only():
    chmod = re.search(r"RUN chmod -R a-w ([^\\\n]+)", DOCKERFILE).group(1).split()
    assert chmod == ["/opt/vocalis/satellite", "/opt/vocalis/satellite-admin", "/opt/vocalis/src"]
    assert "chmod a-w /usr/share/vocalis-g1/models/fetch_models.py" in DOCKERFILE
    assert re.search(r"^USER \$\{VOCALIS_UID\}:\$\{VOCALIS_GID\}$", DOCKERFILE, re.MULTILINE)
    assert 'ENTRYPOINT ["python", "server.py"]' in DOCKERFILE


def test_the_ignore_file_admits_exactly_the_recipes_inputs():
    entries = {line[1:] for line in IGNORE.splitlines() if line.startswith("!")}
    assert IGNORE.splitlines()[0] == "**"
    assert entries == {
        "packaging/", "packaging/satellite/", "packaging/satellite/Dockerfile",
        "packaging/satellite/satellite_admin.py",
        "source/", "source/vocalis/", "source/vocalis/satellite/", "source/vocalis/satellite/*.py",
        "source/vocalis/src/", "source/vocalis/src/tts_utils.py", "source/vocalis/src/engine_process.py",
        "source/vocalis/LICENSE",
        "packaging/models/", "packaging/models/fetch_models.py", "packaging/models/chatterbox/",
        "packaging/models/chatterbox/manifest.json", "packaging/models/chatterbox/NOTICE.md",
        "packaging/nvml/", "packaging/nvml/nvidia_ml_py-13.615.71-py3-none-any.whl",
        "packaging/nvml/requirements.lock", "packaging/nvml/LICENSE-nvidia-ml-py.txt",
        # October 11, 2026: the LGPL-2.1 text, and the ROCm notices (AMD image) the recipe installs read-only.
        "packaging/licenses/", "packaging/licenses/LGPL-2.1.txt", "packaging/licenses/GPL-3.0.txt",
        "packaging/licenses/rocm-notice-artifacts.json", "packaging/licenses/rocm/", "packaging/licenses/rocm/*"}


def test_every_input_the_recipe_reads_is_admitted_and_exists():
    entries = {line[1:] for line in IGNORE.splitlines() if line.startswith("!")}
    files = []
    for source, _target in _copies():
        path = REPO / source.rstrip("/")
        assert path.exists(), source
        # A copied folder brings in only what the ignore file admits: the satellite's Python files.
        files += [path] if path.is_file() else sorted(path.glob("*.py"))
    nvml = re.search(r"source=(packaging/nvml)", DOCKERFILE).group(1)
    files += [REPO / nvml / name for name in
              ("nvidia_ml_py-13.615.71-py3-none-any.whl", "requirements.lock", "LICENSE-nvidia-ml-py.txt")]
    # The license mount (October 11, 2026): the LGPL-2.1 text, and the ROCm notice folder and record for the AMD image.
    licenses = re.search(r"source=(packaging/licenses),target=/lic", DOCKERFILE).group(1)
    files += [REPO / licenses / "LGPL-2.1.txt", REPO / licenses / "GPL-3.0.txt", REPO / licenses / "rocm-notice-artifacts.json"]
    files += sorted((REPO / licenses / "rocm").glob("*"))
    assert len(files) > 10
    for file in files:
        assert file.is_file(), file
        relative = file.relative_to(REPO).as_posix()
        folder = relative.rsplit("/", 1)[0]
        assert (relative in entries or (relative.endswith(".py") and f"{folder}/*.py" in entries)
                or (folder == "packaging/licenses/rocm" and f"{folder}/*" in entries)), relative
        # Every folder on the way down is admitted too, or the file is unreachable.
        parts = relative.split("/")[:-1]
        assert all("/".join(parts[:i]) + "/" in entries for i in range(1, len(parts) + 1)), relative
