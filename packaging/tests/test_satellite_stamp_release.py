"""Tests for packaging/satellite/stamp_release.py (design section 9, "Release stamping", October 10, 2026).

The stamp step fills the default-image marker lines of the satellite setup scripts. These tests run it against
the real scripts and against throwaway copies with a marker removed or repeated. Docker is a seam: without --release
a local reference (no registry host) is checked with one read-only `docker image inspect`, which the tests inject
(direct calls) or answer with a stand-in `docker` on PATH (command-line runs). With --release Docker is not called.
"""

from pathlib import Path
import importlib.util
import os
import subprocess
import sys

import pytest


SATELLITE = Path(__file__).resolve().parents[1] / "satellite"
SCRIPT = SATELLITE / "stamp_release.py"
CUDA = "registry.example.com/vocalis/vocalis-satellite-cuda@sha256:" + "a" * 64
ROCM = "registry.example.com/vocalis/vocalis-satellite-rocm@sha256:" + "b" * 64
LOCAL_CUDA = "vocalis-satellite-cuda@sha256:" + "c" * 64
LOCAL_ROCM = "vocalis-satellite-rocm@sha256:" + "d" * 64

SH_TEXT = (
    "#!/usr/bin/env bash\n"
    "set -euo pipefail\n"
    'DEFAULT_IMAGE_CUDA=""\n'
    'DEFAULT_IMAGE_ROCM=""\n'
    'echo "$DEFAULT_IMAGE_CUDA"\n'
)
PS1_TEXT = (
    "param()\r\n"
    "$DefaultImageCuda = ''\r\n"
    "Write-Output $DefaultImageCuda\r\n"
)


def _load():
    spec = importlib.util.spec_from_file_location("stamp_release", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _docker_on_path(tmp_path, answer=None, exit_code=0):
    """A stand-in docker that records each call and answers `image inspect` with `answer` (default: the sha256:...
    part of the reference it was asked about, i.e. a correct local image). Returns (env, log path)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "docker.log"
    # The stand-in is a Python file behind a launcher the platform can run by the bare name `docker`: a shell script
    # on Linux, `docker.cmd` on Windows. (October 10, 2026: a shell script alone is not found on Windows, where the
    # stamp step then asked the real Docker.)
    body = bin_dir / "docker_stand_in.py"
    body.write_text(
        "import sys\n"
        f"with open({str(log)!r}, 'a', encoding='utf-8', newline='\\n') as handle:\n"
        "    handle.write(' '.join(sys.argv[1:]) + '\\n')\n"
        f"print({answer!r} or sys.argv[-1].split('@', 1)[-1])\n"
        f"sys.exit({exit_code})\n",
        encoding="utf-8",
    )
    if os.name == "nt":
        (bin_dir / "docker.cmd").write_text(f'@"{sys.executable}" "{body}" %*\n', encoding="ascii", newline="\r\n")
    else:
        stub = bin_dir / "docker"
        stub.write_text(f"#!/bin/sh\nexec '{sys.executable}' '{body}' \"$@\"\n", encoding="utf-8")
        stub.chmod(0o755)
    return dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ.get("PATH", "")), log


def _run(source, out, *extra, cuda=CUDA, rocm=ROCM, env=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--cuda-image", cuda, "--rocm-image", rocm, "--out", str(out),
         "--source-dir", str(source), *extra],
        capture_output=True, text=True, timeout=30, env=env,
    )


def _source(tmp_path, sh=SH_TEXT, ps1=PS1_TEXT):
    source = tmp_path / "source"
    source.mkdir()
    (source / "satellite-setup.sh").write_bytes(sh.encode("ascii"))
    if ps1 is not None:
        (source / "satellite-setup.ps1").write_bytes(ps1.encode("ascii"))
    return source


def test_the_repository_script_carries_each_marker_exactly_once_and_no_default():
    text = (SATELLITE / "satellite-setup.sh").read_text(encoding="utf-8")
    lines = text.splitlines()
    assert lines.count('DEFAULT_IMAGE_CUDA=""') == 1
    assert lines.count('DEFAULT_IMAGE_ROCM=""') == 1
    # Near the top, as the stamp step and the other script's author rely on.
    assert lines.index('DEFAULT_IMAGE_CUDA=""') < 30
    assert "\r" not in text


def test_the_repository_powershell_script_carries_its_one_marker_exactly_once():
    lines = (SATELLITE / "satellite-setup.ps1").read_bytes().decode("ascii").splitlines()
    assert lines.count("$DefaultImageCuda = ''") == 1
    assert not [line for line in lines if line.startswith("$DefaultImageRocm")]


def test_stamping_fills_both_scripts_and_keeps_everything_else(tmp_path):
    source = _source(tmp_path)
    out = tmp_path / "out" / "deep"
    result = _run(source, out)
    assert result.returncode == 0, result.stdout + result.stderr
    sh = (out / "satellite-setup.sh").read_text(encoding="ascii")
    assert sh == SH_TEXT.replace('DEFAULT_IMAGE_CUDA=""', f'DEFAULT_IMAGE_CUDA="{CUDA}"').replace(
        'DEFAULT_IMAGE_ROCM=""', f'DEFAULT_IMAGE_ROCM="{ROCM}"')
    ps1 = (out / "satellite-setup.ps1").read_bytes().decode("ascii")
    # The CRLF line endings of the PowerShell script are kept. Windows is NVIDIA only: the ROCm image is not in it.
    assert ps1 == PS1_TEXT.replace("$DefaultImageCuda = ''", f"$DefaultImageCuda = '{CUDA}'")
    assert ROCM not in ps1
    assert "stamped" in result.stdout and CUDA in result.stdout
    # The sources are untouched.
    assert (source / "satellite-setup.sh").read_text(encoding="ascii") == SH_TEXT


def test_stamping_the_real_scripts_changes_only_the_marker_lines(tmp_path):
    out = tmp_path / "artifacts"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--cuda-image", CUDA, "--rocm-image", ROCM, "--out", str(out), "--release"],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    original = (SATELLITE / "satellite-setup.sh").read_text(encoding="utf-8").splitlines()
    stamped = (out / "satellite-setup.sh").read_text(encoding="utf-8").splitlines()
    assert len(original) == len(stamped)
    changed = [(a, b) for a, b in zip(original, stamped) if a != b]
    assert changed == [('DEFAULT_IMAGE_CUDA=""', f'DEFAULT_IMAGE_CUDA="{CUDA}"'),
                       ('DEFAULT_IMAGE_ROCM=""', f'DEFAULT_IMAGE_ROCM="{ROCM}"')]
    # The stamped script is still valid bash.
    syntax = subprocess.run(["bash", "-n", str(out / "satellite-setup.sh")], capture_output=True, text=True)
    assert syntax.returncode == 0, syntax.stderr
    # The real Windows script: only its one marker changes, and the ROCm image is not in it.
    original = (SATELLITE / "satellite-setup.ps1").read_bytes().decode("ascii").splitlines()
    stamped = (out / "satellite-setup.ps1").read_bytes().decode("ascii").splitlines()
    assert [(a, b) for a, b in zip(original, stamped) if a != b] == [("$DefaultImageCuda = ''", f"$DefaultImageCuda = '{CUDA}'")]
    assert len(original) == len(stamped) and ROCM not in "\n".join(stamped)


def test_the_powershell_script_is_required(tmp_path):
    source = _source(tmp_path, ps1=None)
    out = tmp_path / "out"
    result = _run(source, out)
    assert result.returncode == 1
    assert "satellite-setup.ps1 is missing" in result.stderr and "both setup scripts" in result.stderr
    # Nothing is written, not even the shell script that was fine.
    assert not out.exists()


@pytest.mark.parametrize("reference", [
    "no-digest-here",
    "name@sha256:" + "a" * 63,
    "name@sha256:" + "a" * 65,
    "name@sha256:" + "g" * 64,
    "name@sha256:" + "a" * 64 + "\n",
    "name with space@sha256:" + "a" * 64,
    "name$(touch x)@sha256:" + "a" * 64,
    'name"@sha256:' + "a" * 64,
])
def test_a_reference_that_breaks_the_digest_rule_is_refused_and_nothing_is_written(tmp_path, reference):
    source = _source(tmp_path)
    out = tmp_path / "out"
    env, log = _docker_on_path(tmp_path)
    result = _run(source, out, cuda=reference, env=env)
    assert result.returncode == 1
    assert "--cuda-image" in result.stderr
    assert not out.exists() and not log.exists()
    result = _run(source, out, rocm=reference, env=env)
    assert result.returncode == 1
    assert "--rocm-image" in result.stderr
    assert not out.exists() and not log.exists()


def test_a_correct_local_reference_is_accepted_without_release_after_one_inspect_each(tmp_path):
    source = _source(tmp_path)
    env, log = _docker_on_path(tmp_path)
    ok = _run(source, tmp_path / "local", cuda=LOCAL_CUDA, rocm=LOCAL_ROCM, env=env)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert f'DEFAULT_IMAGE_CUDA="{LOCAL_CUDA}"' in (tmp_path / "local" / "satellite-setup.sh").read_text(encoding="ascii")
    # Exactly the read-only inspect, once per local reference.
    assert log.read_text(encoding="utf-8").splitlines() == [
        f"image inspect --format {{{{.Id}}}} {LOCAL_CUDA}",
        f"image inspect --format {{{{.Id}}}} {LOCAL_ROCM}",
    ]


def test_a_local_reference_is_refused_with_release_and_docker_is_not_called(tmp_path):
    source = _source(tmp_path)
    env, log = _docker_on_path(tmp_path)
    refused = _run(source, tmp_path / "release", "--release", cuda=LOCAL_CUDA, rocm=LOCAL_ROCM, env=env)
    assert refused.returncode == 1
    assert "no registry host" in refused.stderr and "--cuda-image" in refused.stderr
    assert not (tmp_path / "release").exists()
    assert not log.exists()


def test_a_mistyped_local_image_id_is_refused(tmp_path):
    source = _source(tmp_path)
    out = tmp_path / "out"
    env, log = _docker_on_path(tmp_path, answer="sha256:" + "9" * 64)
    result = _run(source, out, cuda=LOCAL_CUDA, rocm=CUDA, env=env)
    assert result.returncode == 1
    assert f"the local image '{LOCAL_CUDA}' has ID 'sha256:{'9' * 64}', not 'sha256:{'c' * 64}'" in result.stderr
    assert "--cuda-image" in result.stderr
    assert not out.exists()
    assert len(log.read_text(encoding="utf-8").splitlines()) == 1  # CUDA is a registry reference: no call for it


def test_docker_that_cannot_be_asked_fails_clearly(tmp_path):
    source = _source(tmp_path)
    out = tmp_path / "out"
    env, log = _docker_on_path(tmp_path, answer="", exit_code=1)
    result = _run(source, out, cuda=LOCAL_CUDA, rocm=CUDA, env=env)
    assert result.returncode == 1
    assert "docker image inspect failed" in result.stderr and not out.exists()
    # And with no docker at all.
    env = dict(os.environ, PATH=str(tmp_path / "nowhere"))
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--cuda-image", LOCAL_CUDA, "--rocm-image", CUDA, "--out", str(out),
         "--source-dir", str(source)],
        capture_output=True, text=True, timeout=30, env=env,
    )
    assert result.returncode == 1 and "docker was not found on PATH" in result.stderr and not out.exists()


def test_registry_references_never_call_docker_with_or_without_release(tmp_path):
    source = _source(tmp_path)
    env, log = _docker_on_path(tmp_path)
    assert _run(source, tmp_path / "a", env=env).returncode == 0
    assert _run(source, tmp_path / "b", "--release", env=env).returncode == 0
    assert not log.exists()


def test_the_injected_docker_call_is_made_exactly_once_per_local_reference(tmp_path):
    module = _load()
    source = _source(tmp_path)
    asked = []

    def holds(reference):
        asked.append(reference)
        return reference[reference.index("@") + 1:]

    module.stamp(source, tmp_path / "out", LOCAL_CUDA, LOCAL_ROCM, False, inspect_image=holds)
    assert asked == [LOCAL_CUDA, LOCAL_ROCM]
    asked.clear()
    module.stamp(source, tmp_path / "out2", CUDA, LOCAL_ROCM, False, inspect_image=holds)
    assert asked == [LOCAL_ROCM]
    asked.clear()
    module.stamp(source, tmp_path / "out3", CUDA, ROCM, False, inspect_image=holds)
    module.stamp(source, tmp_path / "out4", CUDA, ROCM, True, inspect_image=holds)
    assert asked == []

    def wrong(reference):
        asked.append(reference)
        return "sha256:" + "0" * 64

    with pytest.raises(ValueError, match="has ID"):
        module.stamp(source, tmp_path / "out5", LOCAL_CUDA, LOCAL_ROCM, False, inspect_image=wrong)
    assert asked == [LOCAL_CUDA, LOCAL_ROCM]  # both are reported, each asked once
    assert not (tmp_path / "out5").exists()


def test_the_ids_are_compared_case_insensitively_against_the_digest(tmp_path):
    module = _load()
    source = _source(tmp_path)
    upper = "vocalis-satellite-cuda@sha256:" + "ABCDEF0123456789" * 4
    module.stamp(source, tmp_path / "out", upper, CUDA, False, inspect_image=lambda ref: "sha256:" + "abcdef0123456789" * 4)


@pytest.mark.parametrize("registry", [
    "localhost/vocalis-satellite-cuda",
    "localhost:5000/vocalis-satellite-cuda",
    "LOCALHOST:5000/vocalis-satellite-cuda",
    "127.0.0.1:5000/vocalis-satellite-cuda",
    "registry.localhost/vocalis-satellite-cuda",
    "[::1]:5000/vocalis-satellite-cuda",
])
def test_release_refuses_a_registry_on_this_machine(tmp_path, registry):
    source = _source(tmp_path)
    reference = registry + "@sha256:" + "e" * 64
    result = _run(source, tmp_path / "out", "--release", cuda=reference)
    assert result.returncode == 1
    assert "this machine" in result.stderr
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize("registry", ["ghcr.io/example/vocalis-satellite-cuda", "registry.example.com:5443/x/y"])
def test_release_accepts_a_published_registry(tmp_path, registry):
    source = _source(tmp_path)
    reference = registry + "@sha256:" + "e" * 64
    result = _run(source, tmp_path / "out", "--release", cuda=reference)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("which", ["cuda", "rocm"])
def test_a_missing_marker_stops_the_stamp(tmp_path, which):
    marker = f'DEFAULT_IMAGE_{which.upper()}=""\n'
    source = _source(tmp_path, sh=SH_TEXT.replace(marker, ""))
    out = tmp_path / "out"
    result = _run(source, out)
    assert result.returncode == 1
    assert f"DEFAULT_IMAGE_{which.upper()}" in result.stderr and "exactly once" in result.stderr and "0 times" in result.stderr
    assert not out.exists()


@pytest.mark.parametrize("which", ["cuda", "rocm"])
def test_a_repeated_marker_stops_the_stamp(tmp_path, which):
    marker = f'DEFAULT_IMAGE_{which.upper()}=""\n'
    source = _source(tmp_path, sh=SH_TEXT + marker)
    out = tmp_path / "out"
    result = _run(source, out)
    assert result.returncode == 1
    assert "exactly once" in result.stderr and "2 times" in result.stderr
    assert not out.exists()


def test_an_already_stamped_script_is_refused(tmp_path):
    stamped = SH_TEXT.replace('DEFAULT_IMAGE_CUDA=""', f'DEFAULT_IMAGE_CUDA="{CUDA}"')
    source = _source(tmp_path, sh=stamped)
    result = _run(source, tmp_path / "out")
    assert result.returncode == 1
    assert "DEFAULT_IMAGE_CUDA" in result.stderr


def test_a_missing_powershell_marker_stops_the_stamp_even_though_the_shell_script_was_fine(tmp_path):
    source = _source(tmp_path, ps1=PS1_TEXT.replace("$DefaultImageCuda = ''\r\n", ""))
    out = tmp_path / "out"
    result = _run(source, out)
    assert result.returncode == 1
    assert "DefaultImageCuda" in result.stderr and "0 times" in result.stderr
    # Nothing is written for either script when one of them fails.
    assert not out.exists()


def test_a_repeated_powershell_marker_stops_the_stamp(tmp_path):
    source = _source(tmp_path, ps1=PS1_TEXT + "$DefaultImageCuda = ''\r\n")
    out = tmp_path / "out"
    result = _run(source, out)
    assert result.returncode == 1
    assert "DefaultImageCuda" in result.stderr and "2 times" in result.stderr
    assert not out.exists()


def test_the_powershell_script_needs_no_rocm_marker_and_a_stray_one_is_left_alone(tmp_path):
    stray = PS1_TEXT + "$DefaultImageRocm = ''\r\n"
    source = _source(tmp_path, ps1=stray)
    out = tmp_path / "out"
    result = _run(source, out)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "$DefaultImageRocm = ''" in (out / "satellite-setup.ps1").read_bytes().decode("ascii")
    assert result.stdout.count("stamped ROCm") == 1  # for the .sh only


def test_the_shell_script_is_required(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "satellite-setup.ps1").write_bytes(PS1_TEXT.encode("ascii"))
    result = _run(source, tmp_path / "out")
    assert result.returncode == 1
    assert "satellite-setup.sh is missing" in result.stderr


def test_out_that_is_the_source_folder_is_refused_and_nothing_is_overwritten(tmp_path):
    source = _source(tmp_path)
    result = _run(source, source)
    assert result.returncode == 1
    assert "--out is the source folder" in result.stderr
    assert (source / "satellite-setup.sh").read_text(encoding="ascii") == SH_TEXT
    # The same folder reached another way (a dot-dot path through a sibling) is refused too.
    sibling = tmp_path / "sibling"
    sibling.mkdir()
    result = _run(source, sibling / ".." / "source")
    assert result.returncode == 1 and "--out is the source folder" in result.stderr
    assert (source / "satellite-setup.sh").read_text(encoding="ascii") == SH_TEXT
    assert (source / "satellite-setup.ps1").read_bytes().decode("ascii") == PS1_TEXT


def test_the_default_source_is_the_scripts_own_folder_and_out_there_is_refused(tmp_path):
    # Without --source-dir the source is the folder the stamp script lives in. This runs a COPY of the stamp script and
    # of both setup scripts in a throwaway folder, so a regressed guard would stamp the copies and never the
    # repository's own files (an earlier version of this test ran against the repository's folder).
    copy = tmp_path / "copy"
    copy.mkdir()
    for name in ("stamp_release.py", "satellite-setup.sh", "satellite-setup.ps1"):
        (copy / name).write_bytes((SATELLITE / name).read_bytes())
    before = {name: (copy / name).read_bytes() for name in ("satellite-setup.sh", "satellite-setup.ps1")}
    result = subprocess.run(
        [sys.executable, str(copy / "stamp_release.py"), "--cuda-image", CUDA, "--rocm-image", ROCM, "--out", str(copy)],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 1 and "--out is the source folder" in result.stderr
    assert {name: (copy / name).read_bytes() for name in before} == before
    # The same copy stamps into another folder, which proves the default source really is the copy's own folder.
    ok = subprocess.run(
        [sys.executable, str(copy / "stamp_release.py"), "--cuda-image", CUDA, "--rocm-image", ROCM,
         "--out", str(tmp_path / "out"), "--release"],
        capture_output=True, text=True, timeout=30,
    )
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert f'DEFAULT_IMAGE_CUDA="{CUDA}"' in (tmp_path / "out" / "satellite-setup.sh").read_text(encoding="utf-8")


def test_registry_host_rule_matches_build_installer():
    module = _load()
    assert module.registry_host("vocalis-main-app-cuda@sha256:" + "a" * 64) is None
    assert module.registry_host("library/name@sha256:" + "a" * 64) is None
    assert module.registry_host("localhost/name") == "localhost"
    assert module.registry_host("host.example/name") == "host.example"
    assert module.registry_host("host:5000/name") == "host:5000"
