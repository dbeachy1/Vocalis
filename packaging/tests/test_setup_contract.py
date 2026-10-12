from pathlib import Path
import os
import re
import shutil
import socket
import subprocess

import pytest


PACKAGING = Path(__file__).resolve().parents[1]


def _ports():
    reserved = [socket.socket(), socket.socket()]
    try:
        for item in reserved:
            item.bind(("127.0.0.1", 0))
        return tuple(item.getsockname()[1] for item in reserved)
    finally:
        for item in reserved:
            item.close()


def _fake_docker(tmp_path):
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    docker_stub = stub_bin / "docker"
    docker_stub.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "printf '%s\\n' \"$*\" >> \"$DOCKER_STUB_LOG\"\n"
        "if [[ \"$1\" == info ]]; then\n"
        "  if [[ \"$*\" == *--format* ]]; then printf '{\"nvidia\":{}}\\n'; fi\n"
        "  exit 0\n"
        "fi\n"
        # `docker ps ...` prints FAKE_PS_OUTPUT: the README's legacy-unit guard asks Docker which containers are running.
        "if [[ \"$1\" == ps ]]; then printf '%s' \"${FAKE_PS_OUTPUT:-}\"; exit \"${FAKE_PS_EXIT:-0}\"; fi\n"
        # The Vocalis store paths each call sees in its environment (setup exports the validated ones before Compose runs).
        "if [[ -n \"${FAKE_ENV_LOG:-}\" && \" $* \" == *\" --project-name \"* ]]; then printf '%s|%s\\n' \"${VOCALIS_DATA_PATH-unset}\" \"${VOCALIS_CACHE_PATH-unset}\" >> \"$FAKE_ENV_LOG\"; fi\n"
        # `docker image inspect <ref>` succeeds only for a reference listed in FAKE_LOCAL_IMAGES
        # (space-separated), the stand-in for a locally built image; any other reference is absent.
        "if [[ \"$1\" == image && \"$2\" == inspect ]]; then\n"
        "  case \" ${FAKE_LOCAL_IMAGES:-} \" in\n"
        "    *\" $3 \"*) exit 0 ;;\n"
        "  esac\n"
        "  exit 1\n"
        "fi\n"
        "if [[ \"$1\" == compose ]]; then\n"
        "  case \" $* \" in\n"
        "    *\" pull \"*)\n"
        "      exit \"${FAKE_PULL_EXIT:-0}\"\n"
        "      ;;\n"
        # The model fetch: optionally snapshot what instance.env and the directory look like at that
        # moment (the --env-file's directory is the instance root), then block on a FIFO so a test can
        # signal setup mid-download, then exit with the requested status.
        "    *\" /usr/share/vocalis-g1/models/fetch_models.py \"*)\n"
        "      prev=''; envf=''\n"
        "      for a in \"$@\"; do [[ $prev == --env-file ]] && envf=$a; prev=$a; done\n"
        "      if [[ -n \"${FAKE_FETCH_SNAPSHOT:-}\" ]]; then\n"
        "        cp \"$(dirname \"$envf\")/instance.env\" \"$FAKE_FETCH_SNAPSHOT\"\n"
        "        ls -a \"$(dirname \"$envf\")\" > \"$FAKE_FETCH_SNAPSHOT.ls\"\n"
        "      fi\n"
        "      if [[ -n \"${FAKE_FETCH_BLOCK_FIFO:-}\" ]]; then printf started > \"$FAKE_FETCH_BLOCK_FIFO\"; sleep 120; fi\n"
        # A program the test supplies runs while the fetch "downloads" (a standalone unit started during the download).
        "      if [[ -n \"${FAKE_FETCH_HOOK:-}\" ]]; then \"$FAKE_FETCH_HOOK\"; fi\n"
        "      exit \"${FAKE_FETCH_EXIT:-0}\"\n"
        "      ;;\n"
        "    *\" /opt/taproom/provision-owner.mjs \"*)\n"
        # provision-owner.mjs writes config.yaml from the image template when it is missing (ensureImageConfig); the
        # stand-in does the same when the test names the file and its text.
        "      if [[ -n \"${FAKE_CONFIG_PATH:-}\" && ! -f \"$FAKE_CONFIG_PATH\" ]]; then printf '%s\\n' \"$FAKE_CONFIG_YAML\" > \"$FAKE_CONFIG_PATH\"; fi\n"
        "      if [[ \" $* \" == *\" --check \"* ]]; then\n"
        "        if [[ -n \"${FAKE_CHECK_EXIT:-}\" ]]; then exit \"$FAKE_CHECK_EXIT\"; fi\n"
        "        [[ -f \"$FAKE_OWNER_READY_FILE\" ]] && exit 0 || exit 1\n"
        "      fi\n"
        "      status=${FAKE_PROVISION_EXIT:-0}\n"
        "      if [[ $status == 0 ]]; then mkdir -p \"$(dirname \"$FAKE_OWNER_READY_FILE\")\"; touch \"$FAKE_OWNER_READY_FILE\"; fi\n"
        "      exit \"$status\"\n"
        "      ;;\n"
        "  esac\n"
        "  exit 0\n"
        "fi\n"
        "exit 64\n",
        encoding="utf-8",
    )
    docker_stub.chmod(0o755)
    docker_log = tmp_path / "docker.log"
    # setup.sh now keeps a per-user list of the instance roots it has used (under XDG_STATE_HOME or
    # $HOME/.local/state) and scans $HOME/.local/share/vocalis for instances (model reuse, October 9,
    # 2026): both are pointed into the test's temporary directory so no test touches the real home.
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    env = os.environ.copy()
    env.update({
        "PATH": os.pathsep.join((str(stub_bin), os.environ.get("PATH", ""))),
        "DOCKER_STUB_LOG": str(docker_log),
        "FAKE_OWNER_READY_FILE": str(tmp_path / "fake-owner-store" / "ready"),
        "DISPLAY": "",
        "WAYLAND_DISPLAY": "",
        "HOME": str(fake_home),
        "XDG_STATE_HOME": str(tmp_path / "state"),
    })
    return env, docker_log


def _run(env, *args, expected=0):
    result = subprocess.run(
        ["bash", str(PACKAGING / "setup.sh"), *map(str, args)],
        capture_output=True, text=True, timeout=30, env=env,
    )
    assert result.returncode == expected, result.stdout + result.stderr
    return result


def _use_owner_root(env, root):
    env["FAKE_OWNER_READY_FILE"] = str(root / "data" / "taproom" / "data" / "_storage" / "ready")


def _new_instance_args(root):
    vocalis_port, taproom_port = _ports()
    return [
        "--root", root, "--variant", "cuda",
        "--vocalis-image", "registry.example/vocalis@sha256:" + "a" * 64,
        "--taproom-image", "registry.example/taproom@sha256:" + "b" * 64,
        "--vocalis-port", vocalis_port, "--taproom-port", taproom_port,
    ]


def test_setup_rerun_and_update_keep_identity_and_fail_closed_on_missing_roots(tmp_path):
    if os.name != "posix" or not shutil.which("bash"):
        import pytest
        pytest.skip("the setup workflow is exercised in its Linux Bash runtime")

    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "instance root"
    _use_owner_root(env, instance_root)
    new_vocalis = "registry.example/vocalis@sha256:" + "c" * 64
    new_taproom = "registry.example/taproom@sha256:" + "d" * 64

    first_setup = _run(env, *_new_instance_args(instance_root))
    env_file = instance_root / "instance.env"
    saved = env_file.read_text(encoding="utf-8")
    instance_id = re.search(r"^INSTANCE_ID=(.+)$", saved, re.MULTILINE).group(1)
    assert saved.count("INSTANCE_ROOT='") == 1
    assert str(instance_root) in saved
    assert "VOCALIS_SESSION_COOKIE_NAME" not in saved
    assert "Pairing: PENDING" in first_setup.stdout
    vocalis_url = re.search(r"^VOCALIS_PUBLIC_URL=(.+)$", saved, re.MULTILINE).group(1)
    assert f"Vocalis bootstrap: {vocalis_url}/setup" in first_setup.stdout
    first_provision = [line for line in docker_log.read_text(encoding="utf-8").splitlines() if "/opt/taproom/provision-owner.mjs" in line]
    assert len(first_provision) == 1 and " --check " not in f" {first_provision[0]} "

    docker_log.write_text("", encoding="utf-8")
    rerun = _run(env, "--root", instance_root)
    # An already-initialized instance is past /setup: the plain Vocalis (login) URL is printed.
    assert f"Vocalis: {vocalis_url}\n" in rerun.stdout
    assert "/setup" not in rerun.stdout and "bootstrap" not in rerun.stdout
    rerun_log = docker_log.read_text(encoding="utf-8")
    rerun_provision = [line for line in rerun_log.splitlines() if "/opt/taproom/provision-owner.mjs" in line]
    assert len(rerun_provision) == 1 and " --check " in f" {rerun_provision[0]} "
    assert re.search(rf"--project-name vocalis-{re.escape(instance_id)}", rerun_log)

    _run(env, "--update", "--root", instance_root,
         "--vocalis-image", new_vocalis, "--taproom-image", new_taproom)
    updated = env_file.read_text(encoding="utf-8")
    assert re.search(rf"^INSTANCE_ID={re.escape(instance_id)}$", updated, re.MULTILINE)
    assert f"VOCALIS_IMAGE={new_vocalis}" in updated
    assert f"TAPROOM_IMAGE={new_taproom}" in updated
    assert (instance_root / "instance.env.previous").read_text(encoding="utf-8") == saved

    missing_cache = instance_root / "cache" / "vocalis"
    shutil.rmtree(missing_cache)
    _run(env, "--root", instance_root, expected=1)
    assert not missing_cache.exists(), "rerunning setup must not create a replacement cache root"


def test_empty_store_retries_after_cancelled_owner_provisioning(tmp_path):
    if os.name != "posix" or not shutil.which("bash"):
        import pytest
        pytest.skip("the setup workflow is exercised in its Linux Bash runtime")

    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_PROVISION_EXIT"] = "130"
    instance_root = tmp_path / "cancelled instance"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root), expected=130)
    owner_root = instance_root / "data" / "taproom" / "data"
    assert owner_root.is_dir() and not any(owner_root.iterdir())
    assert (instance_root / "instance.env").is_file()

    env["FAKE_PROVISION_EXIT"] = "0"
    docker_log.write_text("", encoding="utf-8")
    retry = _run(env, "--root", instance_root)
    calls = [line for line in docker_log.read_text(encoding="utf-8").splitlines() if "/opt/taproom/provision-owner.mjs" in line]
    assert len(calls) == 1 and " --check " not in f" {calls[0]} "
    assert "Pairing: PENDING" in retry.stdout
    assert any(" up -d --no-build --pull never" in f" {line} " for line in docker_log.read_text(encoding="utf-8").splitlines())


def test_nonempty_unverified_owner_store_is_preserved_and_not_reprovisioned(tmp_path):
    if os.name != "posix" or not shutil.which("bash"):
        import pytest
        pytest.skip("the setup workflow is exercised in its Linux Bash runtime")

    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_PROVISION_EXIT"] = "130"
    instance_root = tmp_path / "interrupted instance"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root), expected=130)
    owner_root = instance_root / "data" / "taproom" / "data"
    owner_root.mkdir(parents=True, exist_ok=True)
    damaged = owner_root / "partial-owner-record"
    damaged.write_text("interrupted fixture", encoding="utf-8")

    env["FAKE_CHECK_EXIT"] = "1"
    docker_log.write_text("", encoding="utf-8")
    result = _run(env, "--root", instance_root, expected=1)
    lines = docker_log.read_text(encoding="utf-8").splitlines()
    provision_calls = [line for line in lines if "/opt/taproom/provision-owner.mjs" in line]
    assert len(provision_calls) == 1 and " --check " in f" {provision_calls[0]} "
    assert "nonempty but owner verification failed" in result.stderr
    assert damaged.read_text(encoding="utf-8") == "interrupted fixture"
    assert not any(" up -d " in f" {line} " for line in lines)


FETCH_COMMAND = ("run --rm --no-deps --entrypoint /opt/python/3.12.15/bin/python3.12 vocalis "
                 "/usr/share/vocalis-g1/models/fetch_models.py")


def _require_bash():
    if os.name != "posix" or not shutil.which("bash"):
        import pytest
        pytest.skip("the setup workflow is exercised in its Linux Bash runtime")


def _log_lines(docker_log):
    return docker_log.read_text(encoding="utf-8").splitlines()


def _first(lines, needle):
    matches = [index for index, line in enumerate(lines) if needle in line]
    assert matches, f"{needle!r} not in docker log:\n" + "\n".join(lines)
    return matches[0]


def test_model_fetch_runs_before_owner_provisioning_on_a_new_instance_and_on_a_rerun(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "fetch order"
    _use_owner_root(env, instance_root)

    result = _run(env, *_new_instance_args(instance_root))
    lines = _log_lines(docker_log)
    fetches = [line for line in lines if "fetch_models.py" in line]
    assert len(fetches) == 1 and FETCH_COMMAND in fetches[0]
    assert "--env-file " + str(instance_root / "instance.env") in fetches[0]
    # After both writability checks, before the (interactive) owner provisioning and before compose up.
    assert (_first(lines, "Vocalis cannot write") < _first(lines, "Taproom cannot write")
            < _first(lines, "fetch_models.py") < _first(lines, "/opt/taproom/provision-owner.mjs")
            < _first(lines, " up -d --no-build --pull never"))
    assert "Model weights: every file is present and verified." in result.stdout
    assert result.stdout.index("Acquiring model weights") < result.stdout.index("Pairing: PENDING")

    # A plain rerun is the resume path: it fetches again, still ahead of the owner check.
    docker_log.write_text("", encoding="utf-8")
    _run(env, "--root", instance_root)
    lines = _log_lines(docker_log)
    assert len([line for line in lines if "fetch_models.py" in line]) == 1
    assert (_first(lines, "Taproom cannot write") < _first(lines, "fetch_models.py")
            < _first(lines, "/opt/taproom/provision-owner.mjs --check")
            < _first(lines, " up -d --no-build --pull never"))


def test_failed_fetch_on_a_new_instance_stops_before_provisioning_and_a_rerun_resumes(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_FETCH_EXIT"] = "1"
    instance_root = tmp_path / "fetch fails first"
    _use_owner_root(env, instance_root)

    failed = _run(env, *_new_instance_args(instance_root), expected=1)

    assert "Model download did not finish" in failed.stderr and "setup command again to resume" in failed.stderr
    lines = _log_lines(docker_log)
    assert not any("provision-owner.mjs" in line for line in lines)
    assert not any(" up -d " in f" {line} " for line in lines)
    owner_root = instance_root / "data" / "taproom" / "data"
    assert owner_root.is_dir() and not any(owner_root.iterdir()), "the owner store must stay empty"
    assert (instance_root / "instance.env").is_file()

    # The rerun takes the existing-instance path, fetches, then provisions the still-empty store.
    env["FAKE_FETCH_EXIT"] = "0"
    docker_log.write_text("", encoding="utf-8")
    resumed = _run(env, "--root", instance_root)
    lines = _log_lines(docker_log)
    assert _first(lines, "fetch_models.py") < _first(lines, "/opt/taproom/provision-owner.mjs")
    assert "Pairing: PENDING" in resumed.stdout
    # The owner was provisioned during this run, so the bootstrap page is still the right pointer.
    assert re.search(r"^Vocalis bootstrap: http://127\.0\.0\.1:\d+/setup$", resumed.stdout, re.MULTILINE)


def test_update_fetches_with_the_candidate_environment_before_it_replaces_instance_env(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update order"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    saved = (instance_root / "instance.env").read_text(encoding="utf-8")
    new_vocalis = "registry.example/vocalis@sha256:" + "e" * 64
    new_taproom = "registry.example/taproom@sha256:" + "f" * 64
    snapshot = tmp_path / "snapshot.env"
    env["FAKE_FETCH_SNAPSHOT"] = str(snapshot)
    docker_log.write_text("", encoding="utf-8")

    _run(env, "--update", "--root", instance_root, "--vocalis-image", new_vocalis, "--taproom-image", new_taproom)

    lines = _log_lines(docker_log)
    fetch_line = lines[_first(lines, "fetch_models.py")]
    assert FETCH_COMMAND in fetch_line
    assert re.search(r"--env-file .*/\.instance\.env\.update\.\d+ -f ", fetch_line), fetch_line
    assert _first(lines, " pull") < _first(lines, "fetch_models.py") < _first(lines, " up -d --no-build --pull never")
    # At fetch time instance.env still named the running images and the candidate existed.
    assert snapshot.read_text(encoding="utf-8") == saved
    assert re.search(r"\.instance\.env\.update\.\d+", (tmp_path / "snapshot.env.ls").read_text(encoding="utf-8"))
    # Afterwards the candidate was swapped in and nothing is left behind.
    assert f"VOCALIS_IMAGE={new_vocalis}" in (instance_root / "instance.env").read_text(encoding="utf-8")
    assert not list(instance_root.glob(".instance.env.update.*"))


def test_failed_fetch_during_update_keeps_instance_env_and_removes_the_candidate(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update fetch fails"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    saved = (instance_root / "instance.env").read_text(encoding="utf-8")
    env["FAKE_FETCH_EXIT"] = "1"
    docker_log.write_text("", encoding="utf-8")

    failed = _run(env, "--update", "--root", instance_root,
                  "--vocalis-image", "registry.example/vocalis@sha256:" + "e" * 64,
                  "--taproom-image", "registry.example/taproom@sha256:" + "f" * 64, expected=1)

    assert "The running instance and instance.env were not changed" in failed.stderr
    assert (instance_root / "instance.env").read_text(encoding="utf-8") == saved
    assert not (instance_root / "instance.env.previous").exists()
    assert not list(instance_root.glob(".instance.env.update.*")), "the candidate must be removed on failure"
    assert not any(" up -d " in f" {line} " for line in _log_lines(docker_log))


def test_candidate_is_removed_when_the_update_fails_before_the_fetch(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update pull fails"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    env["FAKE_PULL_EXIT"] = "1"

    _run(env, "--update", "--root", instance_root,
         "--vocalis-image", "registry.example/vocalis@sha256:" + "e" * 64,
         "--taproom-image", "registry.example/taproom@sha256:" + "f" * 64, expected=1)

    assert not list(instance_root.glob(".instance.env.update.*"))


def test_interrupting_setup_mid_download_removes_the_candidate(tmp_path):
    _require_bash()
    import signal

    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update interrupted"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    fifo = tmp_path / "fetch-started"
    os.mkfifo(fifo)
    env["FAKE_FETCH_BLOCK_FIFO"] = str(fifo)

    process = subprocess.Popen(
        ["bash", str(PACKAGING / "setup.sh"), "--update", "--root", str(instance_root),
         "--vocalis-image", "registry.example/vocalis@sha256:" + "e" * 64,
         "--taproom-image", "registry.example/taproom@sha256:" + "f" * 64],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    try:
        with open(fifo, encoding="utf-8") as started:  # blocks until the stub fetch is running
            assert started.read() == "started"
        assert len(list(instance_root.glob(".instance.env.update.*"))) == 1
        os.killpg(process.pid, signal.SIGTERM)  # what Ctrl-C or a closing terminal does to the group
        process.communicate(timeout=30)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()

    assert process.returncode == 143
    assert not list(instance_root.glob(".instance.env.update.*"))
    assert not (instance_root / "instance.env.previous").exists()


UPDATE_VOCALIS = "registry.example/vocalis@sha256:" + "e" * 64
UPDATE_TAPROOM = "registry.example/taproom@sha256:" + "f" * 64


def _update_args(root):
    return ["--update", "--root", root, "--vocalis-image", UPDATE_VOCALIS, "--taproom-image", UPDATE_TAPROOM]


def _provision_lines(lines):
    return [line for line in lines if "/opt/taproom/provision-owner.mjs" in line]


def test_update_over_an_unfinished_first_install_provisions_the_owner_before_starting(tmp_path):
    # Design section 5, Windows installer amendment 5: the first install left instance.env behind but
    # the owner prompt was cancelled (empty owner store), then --update runs. It used to start Taproom
    # with no owner at all.
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_PROVISION_EXIT"] = "130"
    instance_root = tmp_path / "unfinished then update"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root), expected=130)
    owner_root = instance_root / "data" / "taproom" / "data"
    assert owner_root.is_dir() and not any(owner_root.iterdir())

    env["FAKE_PROVISION_EXIT"] = "0"
    docker_log.write_text("", encoding="utf-8")
    result = _run(env, *_update_args(instance_root))

    lines = _log_lines(docker_log)
    provisions = _provision_lines(lines)
    assert len(provisions) == 1 and " --check " not in f" {provisions[0]} ", provisions
    # It runs on the swapped instance.env (not the update candidate), after the model fetch and before up.
    assert "--env-file " + str(instance_root / "instance.env") + " -f " in provisions[0]
    assert (_first(lines, "fetch_models.py") < _first(lines, "/opt/taproom/provision-owner.mjs")
            < _first(lines, " up -d --no-build --pull never"))
    assert f"VOCALIS_IMAGE={UPDATE_VOCALIS}" in (instance_root / "instance.env").read_text(encoding="utf-8")
    assert "Taproom owner store is empty: provisioning the owner." in result.stdout
    assert "Pairing: PENDING" in result.stdout
    assert re.search(r"^Vocalis bootstrap: http://127\.0\.0\.1:\d+/setup$", result.stdout, re.MULTILINE)
    assert not list(instance_root.glob(".instance.env.update.*"))


def test_update_failing_the_owner_provisioning_does_not_start_the_services(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_PROVISION_EXIT"] = "130"
    instance_root = tmp_path / "unfinished then update fails"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root), expected=130)
    docker_log.write_text("", encoding="utf-8")

    _run(env, *_update_args(instance_root), expected=130)

    assert not any(" up -d " in f" {line} " for line in _log_lines(docker_log))
    assert not list(instance_root.glob(".instance.env.update.*"))


def test_update_verifies_an_existing_owner_with_check_after_the_swap(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update checks owner"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    docker_log.write_text("", encoding="utf-8")

    result = _run(env, *_update_args(instance_root))

    lines = _log_lines(docker_log)
    provisions = _provision_lines(lines)
    assert len(provisions) == 1 and " --check " in f" {provisions[0]} ", provisions
    assert "--env-file " + str(instance_root / "instance.env") + " -f " in provisions[0]
    assert (_first(lines, "fetch_models.py") < _first(lines, "provision-owner.mjs --check")
            < _first(lines, " up -d --no-build --pull never"))
    assert "Taproom owner store has data: verifying the owner." in result.stdout
    assert "Pairing: PENDING" not in result.stdout and "bootstrap" not in result.stdout


def test_update_with_a_failing_owner_check_preserves_data_and_does_not_start(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update owner check fails"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    marker = instance_root / "data" / "taproom" / "data" / "keep-me"
    marker.write_text("owner data", encoding="utf-8")
    env["FAKE_CHECK_EXIT"] = "1"
    docker_log.write_text("", encoding="utf-8")

    failed = _run(env, *_update_args(instance_root), expected=1)

    assert "nonempty but owner verification failed" in failed.stderr
    assert marker.read_text(encoding="utf-8") == "owner data"
    lines = _log_lines(docker_log)
    provisions = _provision_lines(lines)
    assert len(provisions) == 1 and " --check " in f" {provisions[0]} "
    assert not any(" up -d " in f" {line} " for line in lines)


LOCAL_VOCALIS = "vocalis-main-app-cuda@sha256:" + "1" * 64
LOCAL_TAPROOM = "vocalis-g1-taproom@sha256:" + "2" * 64


def _pull_lines(lines):
    return [line for line in lines if re.search(r" pull( |$)", line)]


def _local_args(root):
    vocalis_port, taproom_port = _ports()
    return [
        "--root", root, "--variant", "cuda",
        "--vocalis-image", LOCAL_VOCALIS, "--taproom-image", LOCAL_TAPROOM,
        "--vocalis-port", vocalis_port, "--taproom-port", taproom_port,
    ]


def test_new_instance_pulls_nothing_when_both_images_are_local(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_LOCAL_IMAGES"] = f"{LOCAL_VOCALIS} {LOCAL_TAPROOM}"
    instance_root = tmp_path / "both local"
    _use_owner_root(env, instance_root)

    result = _run(env, *_local_args(instance_root))

    lines = _log_lines(docker_log)
    assert f"image inspect {LOCAL_VOCALIS}" in "\n".join(lines)
    assert f"image inspect {LOCAL_TAPROOM}" in "\n".join(lines)
    assert _pull_lines(lines) == []
    assert "Images found locally, not pulled: vocalis taproom" in result.stdout
    assert "No image pull needed." in result.stdout
    assert any(" up -d --no-build --pull never" in f" {line} " for line in lines)


def test_only_the_absent_service_is_pulled_on_a_new_instance_and_a_rerun(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_LOCAL_IMAGES"] = LOCAL_VOCALIS  # the Taproom image is not local
    instance_root = tmp_path / "one local"
    _use_owner_root(env, instance_root)

    result = _run(env, *_local_args(instance_root))
    pulls = _pull_lines(_log_lines(docker_log))
    assert len(pulls) == 1 and pulls[0].endswith(" pull taproom"), pulls
    assert "Images found locally, not pulled: vocalis" in result.stdout
    assert "Pulling images not present locally: taproom" in result.stdout

    docker_log.write_text("", encoding="utf-8")
    _run(env, "--root", instance_root)
    pulls = _pull_lines(_log_lines(docker_log))
    assert len(pulls) == 1 and pulls[0].endswith(" pull taproom"), pulls


def test_absent_images_are_pulled_one_service_at_a_time(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "none local"
    _use_owner_root(env, instance_root)

    result = _run(env, *_new_instance_args(instance_root))

    pulls = _pull_lines(_log_lines(docker_log))
    assert [line.rsplit(" ", 1)[1] for line in pulls] == ["vocalis", "taproom"], pulls
    assert "Images found locally" not in result.stdout
    assert "Pulling images not present locally: vocalis taproom" in result.stdout


def test_update_pulls_only_the_absent_service_using_the_new_references(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update one local"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    env["FAKE_LOCAL_IMAGES"] = UPDATE_TAPROOM  # inspected by the new reference, not the running one
    docker_log.write_text("", encoding="utf-8")

    result = _run(env, *_update_args(instance_root))

    lines = _log_lines(docker_log)
    assert f"image inspect {UPDATE_VOCALIS}" in "\n".join(lines)
    assert f"image inspect {UPDATE_TAPROOM}" in "\n".join(lines)
    pulls = _pull_lines(lines)
    assert len(pulls) == 1 and pulls[0].endswith(" pull vocalis"), pulls
    assert re.search(r"--env-file .*/\.instance\.env\.update\.\d+ -f ", pulls[0]), pulls[0]
    assert "Images found locally, not pulled: taproom" in result.stdout
    assert _first(lines, " pull vocalis") < _first(lines, "fetch_models.py")


def test_update_pulls_nothing_when_both_new_images_are_local(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update both local"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    env["FAKE_LOCAL_IMAGES"] = f"{UPDATE_VOCALIS} {UPDATE_TAPROOM}"
    docker_log.write_text("", encoding="utf-8")

    result = _run(env, *_update_args(instance_root))

    assert _pull_lines(_log_lines(docker_log)) == []
    assert "Images found locally, not pulled: vocalis taproom" in result.stdout
    assert "fetch_models.py" in "\n".join(_log_lines(docker_log))


def test_setup_sh_is_executable_in_git_so_a_linux_checkout_can_run_it():
    # Found October 9, 2026: the README says to run packaging/setup.sh, but Git stored it as 100644,
    # so on Linux it failed with "Permission denied" (earlier runs had gone through `bash setup.sh`).
    # The mode a clone gets is the one in the index, which a Windows checkout cannot show on disk.
    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    listed = subprocess.run(["git", "ls-files", "-s", "setup.sh"], cwd=PACKAGING,
                            capture_output=True, text=True, check=False)
    if listed.returncode != 0 or not listed.stdout:
        pytest.skip("not running from a Git checkout")
    assert listed.stdout.split()[0] == "100755"


# --- reusing model files already on this machine (October 9, 2026, later still) ------------------
# Design section 5: setup offers the fetch container other models folders as read-only bind mounts at
# /models-seed/<n> and names them in VOCALIS_MODEL_SEEDS. HOME and XDG_STATE_HOME point into tmp_path
# (see _fake_docker), so the list file and the default-parent scan never touch the real home.


def _roots_file(tmp_path):
    return tmp_path / "state" / "vocalis" / "instance-roots"


def _listed(tmp_path):
    return _roots_file(tmp_path).read_text(encoding="utf-8").splitlines()


def _other_instance(tmp_path, name, *, with_env=True):
    """A finished-looking instance: models/vocalis (and instance.env), as setup creates them."""
    root = tmp_path / name
    (root / "models" / "vocalis").mkdir(parents=True)
    if with_env:
        (root / "instance.env").write_text("INSTANCE_ID=vi-other\n", encoding="utf-8")
    return root.resolve()


def _fetch_line(docker_log):
    lines = _log_lines(docker_log)
    return lines[_first(lines, "fetch_models.py")]


def _mounts(fetch_line):
    """[(host path, n)] of every -v <host>:/models-seed/<n>:ro on the fetch command, in order."""
    return [(host, int(n)) for host, n in re.findall(r"-v (.+?):/models-seed/(\d+):ro", fetch_line)]


def test_without_seeds_the_fetch_command_is_unchanged_and_the_root_is_listed_once(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "plain"
    _use_owner_root(env, instance_root)

    result = _run(env, *_new_instance_args(instance_root))

    fetch = _fetch_line(docker_log)
    assert FETCH_COMMAND in fetch and "models-seed" not in fetch and "VOCALIS_MODEL_SEEDS" not in fetch
    assert "Model reuse: 0 local model folder(s) can supply missing files." in result.stdout
    # the own root is listed exactly once, as the canonical path, with a private file
    assert _listed(tmp_path) == [str(instance_root.resolve())]
    assert (_roots_file(tmp_path).stat().st_mode & 0o777) == 0o600
    # a rerun does not add it again (and, with nothing to change, does not rewrite the file)
    before = _roots_file(tmp_path).stat().st_mtime_ns
    _run(env, "--root", instance_root)
    assert _listed(tmp_path) == [str(instance_root.resolve())]
    assert _roots_file(tmp_path).stat().st_mtime_ns == before
    # nothing was written outside the test's directory by the list handling
    assert not list(_roots_file(tmp_path).parent.glob(".instance-roots.*"))


def test_stale_list_lines_are_dropped_and_unplugged_drive_lines_are_kept(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "lister"
    _use_owner_root(env, instance_root)
    alive = _other_instance(tmp_path, "alive")
    gone = tmp_path / "gone instance"  # its parent (tmp_path) exists, so the line is stale
    unplugged = "/nonexistent-drive-xyz/Vocalis/instance"  # its parent does not exist either
    _roots_file(tmp_path).parent.mkdir(parents=True)
    _roots_file(tmp_path).write_text(
        "\n".join([str(alive), str(gone), unplugged, "relative/path", str(alive), ""]), encoding="utf-8")

    result = _run(env, *_new_instance_args(instance_root))

    assert _listed(tmp_path) == [str(alive), unplugged, str(instance_root.resolve())]
    # the live earlier instance became a seed; the unplugged one was skipped for this run, with its reason
    assert _mounts(_fetch_line(docker_log)) == [(str(alive / "models" / "vocalis"), 1)]
    assert f"not using {unplugged} (list of earlier instances): it does not exist." in result.stdout


def test_an_unwritable_list_never_fails_setup(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "blocked list"
    _use_owner_root(env, instance_root)
    # a regular file where the list's directory should be: mkdir -p fails whatever user runs the test
    _roots_file(tmp_path).parent.parent.mkdir(parents=True)
    _roots_file(tmp_path).parent.write_text("in the way", encoding="utf-8")

    result = _run(env, *_new_instance_args(instance_root))

    assert "WARNING: cannot" in result.stderr and "instance-roots" in result.stderr
    assert "Model weights: every file is present and verified." in result.stdout
    assert _roots_file(tmp_path).parent.read_text(encoding="utf-8") == "in the way"
    assert any(" up -d --no-build --pull never" in f" {line} " for line in _log_lines(docker_log))


def test_a_missing_home_never_fails_setup(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env.pop("HOME")
    env.pop("XDG_STATE_HOME")
    instance_root = tmp_path / "no home"
    _use_owner_root(env, instance_root)

    result = _run(env, *_new_instance_args(instance_root))

    assert "WARNING: HOME is not set" in result.stderr
    assert FETCH_COMMAND in _fetch_line(docker_log)
    assert "Model weights: every file is present and verified." in result.stdout


def test_a_refused_run_is_never_listed(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "refused"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    shutil.rmtree(instance_root / "cache" / "vocalis")  # the required-path check now refuses the rerun
    env["XDG_STATE_HOME"] = str(tmp_path / "fresh state")

    _run(env, "--root", instance_root, expected=1)

    assert not (tmp_path / "fresh state").exists(), "a run that never reached the fetch must not list its root"


def test_explicit_seeds_come_first_and_reach_the_fetch_container_as_read_only_mounts(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "with seeds"
    _use_owner_root(env, instance_root)
    explicit_a = _other_instance(tmp_path, "explicit a")
    explicit_b = _other_instance(tmp_path, "explicit b")
    listed = _other_instance(tmp_path, "listed c")
    bare_models = tmp_path / "bare models dir"  # a models directory itself, not an instance root
    bare_models.mkdir()
    default_parent = Path(env["HOME"]) / ".local" / "share" / "vocalis"
    scanned = default_parent / "scanned"
    (scanned / "models" / "vocalis").mkdir(parents=True)
    (scanned / "instance.env").write_text("INSTANCE_ID=vi-scanned\n", encoding="utf-8")
    (default_parent / "no-env" / "models" / "vocalis").mkdir(parents=True)  # no instance.env: not offered
    _roots_file(tmp_path).parent.mkdir(parents=True)
    _roots_file(tmp_path).write_text(f"{listed}\n", encoding="utf-8")

    result = _run(env, *_new_instance_args(instance_root),
                  "--seed-models", explicit_b, "--seed-models", bare_models, "--seed-models", explicit_a)

    fetch = _fetch_line(docker_log)
    expected = [explicit_b / "models" / "vocalis", bare_models.resolve(), explicit_a / "models" / "vocalis",
                scanned.resolve() / "models" / "vocalis", listed / "models" / "vocalis"]
    assert _mounts(fetch) == [(str(path), n) for n, path in enumerate(expected, 1)], fetch
    assert " -e VOCALIS_MODEL_SEEDS=/models-seed/1:/models-seed/2:/models-seed/3:/models-seed/4:/models-seed/5 " in fetch + " "
    # the options sit before the service name, and the fetch itself is the unchanged command
    assert fetch.index("-v ") < fetch.index("--entrypoint /opt/python/3.12.15/bin/python3.12 vocalis /usr/share")
    assert "--no-deps -v " in fetch
    assert "Model reuse: 5 local model folder(s) can supply missing files." in result.stdout
    # the mapping is printed before the fetch starts
    for n, path in enumerate(expected, 1):
        assert result.stdout.index(f"/models-seed/{n} is {path}") < result.stdout.index("Acquiring model weights")
    assert "no-env" not in fetch


def test_only_eight_seeds_are_used_and_explicit_ones_are_never_dropped_by_the_cap(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "capped"
    _use_owner_root(env, instance_root)
    listed = [_other_instance(tmp_path, f"listed {i}") for i in range(5)]
    explicit = [_other_instance(tmp_path, f"explicit {i}") for i in range(5)]
    _roots_file(tmp_path).parent.mkdir(parents=True)
    _roots_file(tmp_path).write_text("".join(f"{root}\n" for root in listed), encoding="utf-8")
    args = [arg for root in explicit for arg in ("--seed-models", root)]

    result = _run(env, *_new_instance_args(instance_root), *args)

    mounts = _mounts(_fetch_line(docker_log))
    assert [host for host, _ in mounts] == [str(p / "models" / "vocalis") for p in [*explicit, *listed[:3]]]
    assert len(mounts) == 8
    for root in listed[3:]:
        assert f"not using {root} (list of earlier instances): more than 8 model folders were found." in result.stdout


def test_unsafe_missing_symlinked_and_own_candidates_are_skipped_with_their_reasons(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "picky"
    _use_owner_root(env, instance_root)
    real = _other_instance(tmp_path, "real target")
    link = tmp_path / "a link"
    try:
        os.symlink(real, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks")
    unsafe = {name: _other_instance(tmp_path, name) for name in ("has:colon", "has,comma", "has'apostrophe", "has\nnewline")}
    good = _other_instance(tmp_path, "good one")
    own = instance_root  # setup creates it; given before it exists is fine, the models folder check is on canonical path
    args = []
    for path in [tmp_path / "does not exist", link, *unsafe.values(), good, own, good]:
        args += ["--seed-models", path]

    result = _run(env, *_new_instance_args(instance_root), *args)

    assert _mounts(_fetch_line(docker_log)) == [(str(good / "models" / "vocalis"), 1)], "the duplicate of good is used once"
    out = result.stdout
    assert f"not using {tmp_path / 'does not exist'} (--seed-models): it does not exist." in out
    assert f"not using {link} (--seed-models): it is a symlink." in out
    assert out.count("its path has a colon, comma, apostrophe or line break.") == 4
    assert "that is this instance's own models folder." in out


def test_update_passes_the_seeds_with_the_candidate_environment_and_still_swaps_afterwards(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "update with seeds"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    other = _other_instance(tmp_path, "earlier install")
    docker_log.write_text("", encoding="utf-8")

    _run(env, *_update_args(instance_root), "--seed-models", other)

    lines = _log_lines(docker_log)
    fetch = lines[_first(lines, "fetch_models.py")]
    assert re.search(r"--env-file .*/\.instance\.env\.update\.\d+ -f ", fetch), fetch
    assert _mounts(fetch) == [(str(other / "models" / "vocalis"), 1)]
    assert "-e VOCALIS_MODEL_SEEDS=/models-seed/1 " in fetch
    assert _first(lines, " pull") < _first(lines, "fetch_models.py") < _first(lines, " up -d --no-build --pull never")
    assert f"VOCALIS_IMAGE={UPDATE_VOCALIS}" in (instance_root / "instance.env").read_text(encoding="utf-8")
    assert not list(instance_root.glob(".instance.env.update.*"))


def test_a_failed_seeded_fetch_still_stops_setup_with_the_resume_hint(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_FETCH_EXIT"] = "1"
    instance_root = tmp_path / "seeded failure"
    _use_owner_root(env, instance_root)
    other = _other_instance(tmp_path, "earlier install")

    failed = _run(env, *_new_instance_args(instance_root), "--seed-models", other, expected=1)

    assert "Model download did not finish" in failed.stderr
    assert not any("provision-owner.mjs" in line for line in _log_lines(docker_log))


def test_seed_models_requires_a_folder_and_the_help_names_it(tmp_path):
    _require_bash()
    env, _ = _fake_docker(tmp_path)
    missing = _run(env, "--seed-models", expected=1)
    assert "--seed-models requires a folder" in missing.stderr
    help_text = _run(env, "--help").stdout
    assert "--seed-models" in help_text


# --- --defer-start (design section 5, Windows installer, amendment 15, October 10, 2026) ---------------
# setup.ps1 always passes --defer-start: setup.sh does everything except the two `compose up -d` calls, and
# says the Windows launcher starts the services. Without the flag (Linux) nothing changes: every test above
# still asserts the `up` call.

STARTING_PHRASES = ("Setup started instance", "is running with its saved identity", "Updated instance")


def _up_calls(lines):
    return [line for line in lines if " up -d " in f" {line} "]


def test_defer_start_new_instance_does_everything_but_start_the_services(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "deferred new"
    _use_owner_root(env, instance_root)

    result = _run(env, *_new_instance_args(instance_root), "--defer-start")

    lines = _log_lines(docker_log)
    assert _up_calls(lines) == []
    # the rest of a first setup ran as usual, in the usual order
    assert (_first(lines, "Vocalis cannot write") < _first(lines, "Taproom cannot write") < _first(lines, "fetch_models.py")
            < _first(lines, "/opt/taproom/provision-owner.mjs"))
    assert (instance_root / "instance.env").is_file()
    assert "Windows launcher starts the services" in result.stdout
    for phrase in STARTING_PHRASES:
        assert phrase not in result.stdout, phrase
    # the bootstrap and pairing guidance is unchanged
    assert re.search(r"^Vocalis bootstrap: http://127\.0\.0\.1:\d+/setup$", result.stdout, re.MULTILINE)
    assert "Pairing: PENDING" in result.stdout


def test_defer_start_rerun_verifies_the_owner_and_does_not_start(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "deferred rerun"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    docker_log.write_text("", encoding="utf-8")

    result = _run(env, "--root", instance_root, "--defer-start")

    lines = _log_lines(docker_log)
    assert _up_calls(lines) == []
    assert len(_provision_lines(lines)) == 1 and " --check " in f" {_provision_lines(lines)[0]} "
    assert "fetch_models.py" in "\n".join(lines)
    assert "Windows launcher starts the services" in result.stdout
    for phrase in STARTING_PHRASES:
        assert phrase not in result.stdout, phrase
    assert "Pairing status was not changed or verified by this command." in result.stdout


def test_defer_start_update_still_swaps_instance_env_and_leaves_the_start_to_the_launcher(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    instance_root = tmp_path / "deferred update"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root))
    saved = (instance_root / "instance.env").read_text(encoding="utf-8")
    docker_log.write_text("", encoding="utf-8")

    result = _run(env, *_update_args(instance_root), "--defer-start")

    lines = _log_lines(docker_log)
    assert _up_calls(lines) == []
    # pull and fetch happened, the owner was checked after the swap, exactly as without the flag
    assert _first(lines, " pull") < _first(lines, "fetch_models.py") < _first(lines, "provision-owner.mjs --check")
    updated = (instance_root / "instance.env").read_text(encoding="utf-8")
    assert f"VOCALIS_IMAGE={UPDATE_VOCALIS}" in updated and f"TAPROOM_IMAGE={UPDATE_TAPROOM}" in updated
    assert (instance_root / "instance.env.previous").read_text(encoding="utf-8") == saved
    assert not list(instance_root.glob(".instance.env.update.*"))
    assert "Windows launcher starts the services" in result.stdout
    assert re.search(r"Prior settings are at .*instance\.env\.previous\.$", result.stdout, re.MULTILINE)
    for phrase in STARTING_PHRASES:
        assert phrase not in result.stdout, phrase


def test_defer_start_update_over_an_unfinished_first_install_still_provisions_the_owner(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_PROVISION_EXIT"] = "130"
    instance_root = tmp_path / "deferred unfinished"
    _use_owner_root(env, instance_root)
    _run(env, *_new_instance_args(instance_root), "--defer-start", expected=130)
    env["FAKE_PROVISION_EXIT"] = "0"
    docker_log.write_text("", encoding="utf-8")

    result = _run(env, *_update_args(instance_root), "--defer-start")

    lines = _log_lines(docker_log)
    provisions = _provision_lines(lines)
    assert len(provisions) == 1 and " --check " not in f" {provisions[0]} ", provisions
    assert _up_calls(lines) == []
    assert "Taproom owner store is empty: provisioning the owner." in result.stdout
    assert re.search(r"^Vocalis bootstrap: http://127\.0\.0\.1:\d+/setup$", result.stdout, re.MULTILINE)
    assert "Windows launcher starts the services" in result.stdout


def test_defer_start_failures_still_fail_and_still_start_nothing(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_FETCH_EXIT"] = "1"
    instance_root = tmp_path / "deferred fails"
    _use_owner_root(env, instance_root)

    failed = _run(env, *_new_instance_args(instance_root), "--defer-start", expected=1)

    assert "Model download did not finish" in failed.stderr
    assert _up_calls(_log_lines(docker_log)) == []
    assert "Windows launcher" not in failed.stdout  # it never claims the launcher will start a failed setup


def _xdg_open_stub(tmp_path, env):
    stub = tmp_path / "bin" / "xdg-open"
    stub.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$XDG_OPEN_LOG\"\n", encoding="utf-8")
    stub.chmod(0o755)
    env["XDG_OPEN_LOG"] = str(tmp_path / "xdg-open.log")
    env["DISPLAY"] = ":0"
    return tmp_path / "xdg-open.log"


def test_defer_start_never_opens_pages_that_nothing_listens_on_yet(tmp_path):
    # WSLg can give the distribution a display and xdg-open; the pages must open only after setup.ps1 has started
    # the services, so a deferred setup opens none. Without the flag a new instance still opens both.
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    opened = _xdg_open_stub(tmp_path, env)
    deferred_root = tmp_path / "deferred pages"
    _use_owner_root(env, deferred_root)
    _run(env, *_new_instance_args(deferred_root), "--defer-start")
    assert not opened.exists()

    normal_root = tmp_path / "normal pages"
    _use_owner_root(env, normal_root)
    _run(env, *_new_instance_args(normal_root))
    assert len(opened.read_text(encoding="utf-8").splitlines()) == 2


def test_the_help_names_defer_start_and_the_invariant_is_documented_beside_the_flag():
    text = (PACKAGING / "setup.sh").read_text(encoding="utf-8")
    usage = text[text.index("usage() {"):text.index("EOF\n}")]
    assert "--defer-start" in usage and "Windows" in usage
    flag = " ".join(re.sub(r"\n# ?", " ", text[text.index("# --defer-start (design section 5"):text.index("DEFER_START=0")]).split())
    assert "Invariant:" in flag and "models/" in flag and "file locks are not shared" in flag
    # the two starts go through one function that honors the flag, and nothing else calls `compose up`
    code = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    assert len([line for line in code if "compose up -d --no-build --pull never" in line]) == 1
    assert text.count("start_services\n") == 2


# ---------------------------------------------------------------------------------------------------------------------
# Switching a standalone install to Docker in place (design section 11, added October 10, 2026): linked responsibility
# folders (item 1), --existing-data (item 2), the owner rule, the recorded container paths (item 4), compose.local.yaml
# (item 9), --vocalis-url / --taproom-url (item 10), and what Compose renders (items 3, 4, 8). Linux only, like the rest.
# ---------------------------------------------------------------------------------------------------------------------

import contextlib
import json
import sys

SEVEN = ("data/vocalis", "data/taproom/data", "cache/vocalis", "models/vocalis", "work/vocalis", "logs/vocalis", "logs/taproom")


def _fresh(tmp_path, name="inst"):
    """A finished fresh instance (root without spaces, so a link may point inside it) and a cleared docker log."""
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    root = tmp_path / name
    _use_owner_root(env, root)
    _run(env, *_new_instance_args(root))
    docker_log.write_text("", encoding="utf-8")
    return env, docker_log, root


def _compose_calls(lines):
    """Calls of an instance's Compose project (the startup `compose version` probe is not one)."""
    return [line for line in lines if "--project-name" in line]


def _no_compose_start(lines):
    return not any(" up -d " in f" {line} " for line in lines)


def _set_env(root, key, value):
    path = root / "instance.env"
    text = path.read_text(encoding="utf-8")
    assert re.search(rf"^{key}=", text, re.MULTILINE), key
    path.write_text(re.sub(rf"^{key}=.*$", lambda _: f"{key}={value}", text, flags=re.MULTILINE), encoding="utf-8")


@pytest.mark.parametrize("relative", SEVEN)
def test_each_responsibility_path_may_be_a_link_to_a_real_directory(tmp_path, relative):
    env, docker_log, root = _fresh(tmp_path)
    target = (tmp_path / "external" / "store").resolve()
    target.parent.mkdir()
    shutil.move(str(root / relative), str(target))
    (root / relative).symlink_to(target, target_is_directory=True)

    result = _run(env, "--root", root)

    assert f"Linked folder: {relative} -> {target}" in result.stdout
    lines = _log_lines(docker_log)
    # The populated Taproom store is reached through a link and still counts as populated: it is verified, never
    # provisioned (a plain `find` on the bare link would list nothing and call it empty).
    provision = _provision_lines(lines)
    assert len(provision) == 1 and " --check " in f" {provision[0]} ", provision
    assert any(" up -d --no-build --pull never" in f" {line} " for line in lines)


def _link_to(root, relative, target):
    shutil.rmtree(root / relative)
    (root / relative).symlink_to(target)


def _make_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    return path


def _refused_link_cases(tmp_path):
    external = _make_dir(tmp_path / "external")
    a_file = tmp_path / "a-file"
    a_file.write_text("x", encoding="utf-8")
    loop_a, loop_b = tmp_path / "loop-a", tmp_path / "loop-b"
    loop_a.symlink_to(loop_b)
    loop_b.symlink_to(loop_a)
    spaced = _make_dir(tmp_path / "has space")
    return [
        ("dangling", lambda root: _link_to(root, "cache/vocalis", tmp_path / "nowhere"), "cache/vocalis", "does not lead to an existing directory"),
        ("to a file", lambda root: _link_to(root, "cache/vocalis", a_file), "cache/vocalis", "does not lead to an existing directory"),
        ("a loop", lambda root: _link_to(root, "cache/vocalis", loop_a), "cache/vocalis", "does not lead to an existing directory"),
        ("the filesystem root", lambda root: _link_to(root, "work/vocalis", "/"), "work/vocalis", "filesystem root"),
        ("the instance root", lambda root: _link_to(root, "work/vocalis", root), "work/vocalis", "the instance root or an ancestor"),
        ("above the instance root", lambda root: _link_to(root, "work/vocalis", root.parent), "work/vocalis", "the instance root or an ancestor"),
        ("inside another path's target", lambda root: (_make_dir(root / "models" / "vocalis" / "sub"), _link_to(root, "cache/vocalis", root / "models" / "vocalis" / "sub")),
         "cache/vocalis and models/vocalis", "the same folder, or one inside the other"),
        ("two paths, one folder", lambda root: (_link_to(root, "cache/vocalis", external), _link_to(root, "work/vocalis", external)),
         "cache/vocalis and work/vocalis", "the same folder, or one inside the other"),
        ("one inside the other", lambda root: (_make_dir(external / "inner"), _link_to(root, "cache/vocalis", external), _link_to(root, "work/vocalis", external / "inner")),
         "cache/vocalis and work/vocalis", "the same folder, or one inside the other"),
        ("a character outside the allowed set", lambda root: _link_to(root, "cache/vocalis", spaced), "cache/vocalis", "has a character outside"),
        ("a link where a parent belongs", lambda root: (shutil.move(str(root / "cache"), str(tmp_path / "moved-cache")), (root / "cache").symlink_to(tmp_path / "moved-cache")),
         "cache", "this parent is a link"),
        ("a link as data/taproom", lambda root: (shutil.move(str(root / "data" / "taproom"), str(tmp_path / "moved-taproom")), (root / "data" / "taproom").symlink_to(tmp_path / "moved-taproom")),
         "taproom", "this parent is a link"),
    ]


@pytest.mark.parametrize("index", range(12))
def test_each_link_refusal_names_the_path_and_changes_nothing(tmp_path, index):
    env, docker_log, root = _fresh(tmp_path)
    label, mutate, named, message = _refused_link_cases(tmp_path)[index]
    mutate(root)
    saved = (root / "instance.env").read_text(encoding="utf-8")

    result = _run(env, "--root", root, expected=1)

    assert message in result.stderr, (label, result.stderr)
    assert named in result.stderr, (label, result.stderr)
    assert not (tmp_path / "nowhere").exists(), "a dangling link must not be created into"
    lines = _log_lines(docker_log)
    assert _no_compose_start(lines) and not any("fetch_models.py" in line for line in lines), (label, lines)
    assert (root / "instance.env").read_text(encoding="utf-8") == saved


def test_a_missing_responsibility_path_of_an_existing_instance_is_still_an_error_not_a_new_folder(tmp_path):
    env, docker_log, root = _fresh(tmp_path)
    shutil.rmtree(root / "logs" / "taproom")
    result = _run(env, "--root", root, expected=1)
    assert "Required instance directory is missing" in result.stderr and str(root / "logs" / "taproom") in result.stderr
    assert not (root / "logs" / "taproom").exists()


# -- --existing-data ----------------------------------------------------------------------------------------------------

def _legacy_stores(tmp_path, *, vocalis_files=("admin_credentials.yaml", "vault_keys.yaml", "app_settings.yaml"), taproom="full"):
    base = tmp_path / "legacy"
    vocalis = _make_dir(base / "old-vocalis")
    for name in vocalis_files:
        (vocalis / name).write_text("fixture\n", encoding="utf-8")
    (vocalis / "voices").mkdir(exist_ok=True)
    data = _make_dir(base / "old-sillytavern" / "data")
    if taproom == "full":
        (data / "_storage").mkdir()
        (data / "cookie-secret.txt").write_text("fixture\n", encoding="utf-8")
    elif taproom == "no-storage":
        (data / "chats.txt").write_text("fixture\n", encoding="utf-8")
    cache = _make_dir(base / "cache.vocalis")
    (cache / "entry").write_text("fixture\n", encoding="utf-8")
    return vocalis, data, cache


def _adopt_root(tmp_path, name, vocalis, data, cache):
    root = tmp_path / name
    _make_dir(root / "data" / "taproom")
    _make_dir(root / "cache")
    (root / "data" / "vocalis").symlink_to(vocalis)
    (root / "data" / "taproom" / "data").symlink_to(data)
    (root / "cache" / "vocalis").symlink_to(cache)
    return root


def _adopt(tmp_path, *, name="adopted", **fixture):
    _require_bash()
    vocalis, data, cache = _legacy_stores(tmp_path, **fixture)
    root = _adopt_root(tmp_path, name, vocalis, data, cache)
    env, docker_log = _fake_docker(tmp_path)
    env["FAKE_OWNER_READY_FILE"] = str(data / "_storage" / "ready")
    if fixture.get("taproom", "full") == "full":
        (data / "_storage").mkdir(exist_ok=True)
        (data / "_storage" / "ready").write_text("ready\n", encoding="utf-8")
    return env, docker_log, root, (vocalis.resolve(), data.resolve(), cache.resolve())


def _adopt_args(root, *extra):
    return [*_new_instance_args(root), "--existing-data", *extra]


def _manifest(*folders):
    state = {}
    for folder in folders:
        for current, dirs, files in os.walk(folder):
            for name in dirs + files:
                path = Path(current) / name
                info = path.lstat()
                state[str(path)] = (info.st_mode, info.st_size, info.st_mtime_ns)
    return state


def _tree(root):
    names = []
    for current, dirs, files in os.walk(root):
        names.extend(str(Path(current, name).relative_to(root)) for name in dirs + files)
    return sorted(names)


def _fake_id(env, uid):
    """An `id` that reports another user ID, so every file the test made looks foreign-owned."""
    stub = Path(env["PATH"].split(os.pathsep)[0]) / "id"
    stub.write_text(f'#!/usr/bin/env bash\nif [[ "${{1:-}}" == -u ]]; then echo {uid}; else exec /usr/bin/id "$@"; fi\n', encoding="utf-8")
    stub.chmod(0o755)


def test_existing_data_adopts_linked_stores_in_place_and_records_what_it_needs(tmp_path):
    env, docker_log, root, (vocalis, data, cache) = _adopt(tmp_path)
    # the runbook's files are allowed in the root: a regular file each, owned by the user
    (root / "compose.local.yaml").write_text("services: {}\n", encoding="utf-8")
    (root / "data" / "taproom" / "mcp-servers.json").write_text("{}\n", encoding="utf-8")
    (root / "data" / "taproom" / "mcp-servers.json").chmod(0o600)
    env["FAKE_CONFIG_PATH"] = str(root / "data" / "taproom" / "config.yaml")
    env["FAKE_CONFIG_YAML"] = ("dataRoot: /data/taproom/data\nextensions:\n  enabled: true\n  models:\n"
                               "    embedding: Xenova/multi-qa-mpnet-base-cos-v1   # existing stores\n    embeddingRevision: x\n")
    before = _manifest(vocalis, data, cache)

    result = _run(env, *_adopt_args(root, "--vocalis-url", "https://myhost:7871", "--taproom-url", "https://myhost:8001"))

    saved = (root / "instance.env").read_text(encoding="utf-8")
    instance_id = re.search(r"^INSTANCE_ID=(.+)$", saved, re.MULTILINE).group(1)
    assert f"VOCALIS_DATA_PATH={vocalis}\n" in saved and f"VOCALIS_CACHE_PATH={cache}\n" in saved
    assert f"ADOPTED_PATHS='{vocalis}:{data}:{cache}'\n" in saved
    assert "VOCALIS_PUBLIC_URL=https://myhost:7871\n" in saved and "TAPROOM_PUBLIC_URL=https://myhost:8001\n" in saved
    assert "HOST_BIND=127.0.0.1\n" in saved
    assert (root / "instance.env").stat().st_mode & 0o777 == 0o600
    # the adopted stores were only read: no file added, removed, changed or re-timestamped
    assert _manifest(vocalis, data, cache) == before
    # the remaining responsibility folders were created as real folders
    for relative in ("models/vocalis", "work/vocalis/scratch", "work/vocalis/bulk", "logs/vocalis", "logs/taproom"):
        assert (root / relative).is_dir() and not (root / relative).is_symlink()

    lines = _log_lines(docker_log)
    provision = _provision_lines(lines)
    assert len(provision) == 1 and " --check --configPath /etc/taproom/config.yaml --dataRoot /data/taproom/data" in provision[0]
    assert all("--configPath /data/taproom/" not in line for line in lines)
    assert re.search(r"compose\.cuda\.yaml -f " + re.escape(str(root / "compose.local.yaml")) + r" ", lines[_first(lines, "fetch_models.py")] + " ")
    # the writability checks name the recorded Vocalis paths and Taproom's /etc/taproom and data folder
    assert f"sh {vocalis} {cache} /models/vocalis /work/vocalis /logs" in lines[_first(lines, "Vocalis cannot write")]
    assert "sh /etc/taproom /data/taproom/data /logs" in lines[_first(lines, "Taproom cannot write")]
    assert any(" up -d --no-build --pull never" in f" {line} " for line in lines)

    out = result.stdout
    assert f"Existing data adopted into instance {instance_id}" in out
    assert "Vocalis: https://myhost:7871\n" in out and "Taproom: https://myhost:8001\n" in out
    assert "bootstrap" not in out and "Pairing: PENDING" not in out and "Setup started" not in out and not re.search(r"/setup$", out, re.MULTILINE)
    assert "Log in with your existing passwords" in out
    assert "Taproom memory embedding model: Xenova/multi-qa-mpnet-base-cos-v1 (" in out
    # Switch-back removes the containers (a stopped one would still block the standalone unit's guard); stop/start are
    # offered only as a labelled pause, and the way back to Docker is a setup rerun.
    assert f"To switch back to the standalone install: docker compose -p vocalis-{instance_id} down\n" in out
    assert f"To return to Docker, run: " in out and f"--root {root}\n" in out
    assert (f"To pause Docker without switching back: docker compose -p vocalis-{instance_id} stop   "
            f"(resume with: docker compose -p vocalis-{instance_id} start)\n") in out
    assert out.index("In-use check (before adoption)") < out.index("Acquiring model weights")
    assert "In-use check (before the model fetch)" in out and "In-use check (before the services start)" in out

    # a plain rerun of the adopted instance is an ordinary rerun (and the original command may be repeated to resume)
    docker_log.write_text("", encoding="utf-8")
    rerun = _run(env, "--root", root)
    assert "Existing data adopted" not in rerun.stdout and "is running with its saved identity and roots" in rerun.stdout
    repeat = _run(env, "--root", root, "--existing-data", "--vocalis-url", "https://myhost:7871")
    assert "is running with its saved identity and roots" in repeat.stdout
    assert (root / "instance.env").read_text(encoding="utf-8") == saved
    assert _manifest(vocalis, data, cache) == before


def test_existing_data_closing_lines_say_so_when_a_store_was_empty(tmp_path):
    env, docker_log, root, stores = _adopt(tmp_path, vocalis_files=(), taproom="empty")
    shutil.rmtree(stores[0] / "voices")
    result = _run(env, *_adopt_args(root))
    lines = _log_lines(docker_log)
    provision = _provision_lines(lines)
    # an empty Taproom store is provisioned (the owner rule), never --check
    assert len(provision) == 1 and " --check " not in f" {provision[0]} " and "--configPath /etc/taproom/config.yaml" in provision[0]
    assert "Existing data adopted" in result.stdout and "Pairing: PENDING" not in result.stdout
    assert "Vocalis data folder was empty" in result.stdout and "owner was created just now" in result.stdout


def _adopt_refused(tmp_path, message, *, prepare=None, env_extra=None, args=(), **fixture):
    env, docker_log, root, stores = _adopt(tmp_path, **fixture)
    if prepare:
        prepare(root, *stores)
    env.update(env_extra or {})
    if env_extra and "FAKE_ID_UID" in env_extra:
        _fake_id(env, env_extra["FAKE_ID_UID"])
    tree = _tree(root)
    manifest = _manifest(*stores)
    result = _run(env, *_adopt_args(root, *args), expected=1)
    assert message in result.stderr, result.stderr
    assert not (root / "instance.env").exists(), "a refused adoption must not write instance.env"
    assert _tree(root) == tree, "a refused adoption must create nothing"
    assert _manifest(*stores) == manifest
    assert not _compose_calls(_log_lines(docker_log)), "nothing runs in Docker before the checks pass"
    return result, (env, root, stores)


def test_existing_data_refuses_anything_else_in_the_root(tmp_path):
    _adopt_refused(tmp_path / "a", "holds something setup does not know", prepare=lambda root, *_: (root / "notes.txt").write_text("x", encoding="utf-8"))
    _adopt_refused(tmp_path / "b", "holds something setup does not know", prepare=lambda root, *_: (root / "data" / "other").mkdir())
    _adopt_refused(tmp_path / "c", "holds something setup does not know", prepare=lambda root, *_: (root / "data" / "taproom" / "config.yaml").write_text("x", encoding="utf-8"))
    _adopt_refused(tmp_path / "d", "must be a regular file, not a link or folder",
                   prepare=lambda root, *_: (root / "data" / "taproom" / "mcp-servers.json").symlink_to(root / "compose.local.yaml"))
    _adopt_refused(tmp_path / "e", "must be a regular file, not a link or folder", prepare=lambda root, *_: (root / "compose.local.yaml").mkdir())
    _adopt_refused(tmp_path / "f", "must be a real folder", prepare=lambda root, *_: ((root / "models").symlink_to(tmp_path / "f")))


def test_existing_data_refuses_stores_that_are_not_what_they_claim(tmp_path):
    result, _ = _adopt_refused(tmp_path / "plain", "not an initialized encrypted Vocalis store", vocalis_files=())
    assert "plaintext" in result.stderr
    _adopt_refused(tmp_path / "half", "not an initialized encrypted Vocalis store", vocalis_files=("admin_credentials.yaml",))
    _adopt_refused(tmp_path / "nostorage", "has no _storage folder", taproom="no-storage")
    _adopt_refused(tmp_path / "dangling", "does not lead to an existing directory",
                   prepare=lambda root, vocalis, *_: (root / "data" / "vocalis").unlink() or (root / "data" / "vocalis").symlink_to(tmp_path / "dangling" / "nowhere"))


def test_existing_data_refuses_adopted_files_and_files_in_the_root_owned_by_someone_else(tmp_path):
    _require_bash()
    foreign = os.getuid() + 1
    result, _ = _adopt_refused(tmp_path / "stores", "is owned by uid", env_extra={"FAKE_ID_UID": str(foreign)})
    assert "becomes the service user" in result.stderr
    result, _ = _adopt_refused(tmp_path / "mcp", "is owned by uid", env_extra={"FAKE_ID_UID": str(foreign)},
                               prepare=lambda root, *_: (root / "data" / "taproom" / "mcp-servers.json").write_text("{}", encoding="utf-8"))
    assert "mcp-servers.json" in result.stderr


def test_an_instance_with_a_compose_local_yaml_includes_it_and_refuses_a_link_or_a_foreign_owner(tmp_path):
    env, docker_log, root = _fresh(tmp_path)
    local = root / "compose.local.yaml"
    local.write_text("services: {}\n", encoding="utf-8")
    result = _run(env, "--root", root)
    assert f"Using {local} as an additional Compose file." in result.stdout
    lines = _log_lines(docker_log)
    assert all(f"compose.cuda.yaml -f {local} " in f"{line} " for line in lines if line.startswith("compose --project-name"))
    assert any(line.startswith("compose --project-name") for line in lines)
    # without the file nothing changes (the other tests in this module)
    local.unlink()
    docker_log.write_text("", encoding="utf-8")
    _run(env, "--root", root)
    assert not any("compose.local.yaml" in line for line in _log_lines(docker_log))
    # a link, even to a good file
    elsewhere = tmp_path / "elsewhere.yaml"
    elsewhere.write_text("services: {}\n", encoding="utf-8")
    local.symlink_to(elsewhere)
    refused = _run(env, "--root", root, expected=1)
    assert "must be a regular file, not a link" in refused.stderr
    local.unlink()
    # a regular file that someone else owns
    local.write_text("services: {}\n", encoding="utf-8")
    _fake_id(env, os.getuid() + 1)
    refused = _run(env, "--root", root, expected=1)
    assert "compose.local.yaml is owned by uid" in refused.stderr


# -- the one-writer rule: the in-use check ------------------------------------------------------------------------------

@contextlib.contextmanager
def _running(tmp_path, as_name, script, cwd=None, extra=(), environ=None):
    """A real process of this user whose argv is `<as_name> <script>`: Python run through a symlink with that name
    (python3, node), so its command line is exactly what the standalone Vocalis and SillyTavern show."""
    bin_dir = _make_dir(tmp_path / "interpreters")
    link = bin_dir / as_name
    if not link.exists():
        link.symlink_to(sys.executable)
    script = Path(script)
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("import time\ntime.sleep(300)\n", encoding="utf-8")
    # With the working folder equal to the script's folder the program is given the bare file name, as `node server.js` is.
    given = script.name if cwd is not None and Path(cwd) == script.parent else str(script)
    process = subprocess.Popen([str(link), given, *extra], env={**os.environ, **(environ or {})},
                               cwd=str(cwd) if cwd else None, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    try:
        yield process
    finally:
        process.kill()
        process.wait()


def test_a_standalone_vocalis_or_sillytavern_on_the_adopted_data_blocks_adoption_with_its_pid_and_command(tmp_path):
    cases = {
        # (interpreter name, where the script is, working folder or None)
        "python script inside the Vocalis store": ("python3", lambda v, d, c: v / "vocalis_server.py", None),
        "python vocalis.py inside the cache": ("python3.12", lambda v, d, c: c / "vocalis.py", None),
        "python script elsewhere, working folder in the store": ("python3", lambda v, d, c: tmp_path / "code" / "vocalis.py", lambda v, d, c: v),
        "node server.js beside the Taproom data folder": ("node", lambda v, d, c: d.parent / "server.js", None),
        "node server.js with a relative path from the Taproom parent": ("nodejs", lambda v, d, c: d.parent / "server.js", lambda v, d, c: d.parent),
        "node server.js inside the Taproom data folder": ("node", lambda v, d, c: d / "server.js", None),
    }
    for index, (label, (name, script_of, cwd_of)) in enumerate(cases.items()):
        folder = tmp_path / f"case{index}"
        env, docker_log, root, (vocalis, data, cache) = _adopt(folder)
        with _running(folder, name, script_of(vocalis, data, cache), cwd_of(vocalis, data, cache) if cwd_of else None) as process:
            result = _run(env, *_adopt_args(root), expected=1)
        assert f"PID {process.pid}" in result.stderr, (label, result.stderr)
        assert script_of(vocalis, data, cache).name in result.stderr, (label, result.stderr)
        assert "Only one of the standalone install and Docker may run" in result.stderr and "systemctl --user disable --now" in result.stderr
        assert not (root / "instance.env").exists(), label
        assert not _compose_calls(_log_lines(docker_log)), label


def test_processes_that_are_not_the_standalone_applications_never_block(tmp_path):
    env, docker_log, root, (vocalis, data, cache) = _adopt(tmp_path)
    sleeper = subprocess.Popen(["bash", "-c", "exec sleep 300"], cwd=str(vocalis), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with _running(tmp_path, "python3", vocalis / "other_tool.py", vocalis), \
             _running(tmp_path, "node", tmp_path / "elsewhere" / "server.js"), \
             _running(tmp_path, "python3", tmp_path / "code" / "vocalis_server.py", tmp_path / "code"):
            result = _run(env, *_adopt_args(root))
    finally:
        sleeper.kill()
        sleeper.wait()
    # a shell or sleep in the folder, a Python script of another name, a Node server and a Vocalis whose script and working
    # folder are both elsewhere: none of them touches the adopted data
    assert "Existing data adopted" in result.stdout and "0 blocking" in result.stdout


def test_a_process_in_a_container_is_skipped_and_a_host_process_in_its_own_mount_namespace_is_not(tmp_path):
    # Containers' processes are owned by the same user (the service user is the setup user) and appear in /proc; they are
    # told apart by their root directory (`stat -L -c %d:%i /proc/<pid>/root` against `/`). An unprivileged test cannot
    # start a container, so `stat` is replaced by a stand-in that reports another root for one PID; every other call goes
    # to the real program, so the host-process side (the same device and inode as `/`) is real.
    env, docker_log, root, (vocalis, data, cache) = _adopt(tmp_path)
    stub = Path(env["PATH"].split(os.pathsep)[0]) / "stat"
    stub.write_text('#!/usr/bin/env bash\n'
                    'if [[ "$*" == *"/proc/${FAKE_CONTAINER_PID:-none}/root"* ]]; then echo "9999:9999"; exit 0; fi\n'
                    'exec /usr/bin/stat "$@"\n', encoding="utf-8")
    stub.chmod(0o755)
    with _running(tmp_path, "python3", vocalis / "vocalis_server.py") as process:
        env["FAKE_CONTAINER_PID"] = str(process.pid)
        result = _run(env, *_adopt_args(root))
        assert "0 blocking" in result.stdout and "Existing data adopted" in result.stdout
        del env["FAKE_CONTAINER_PID"]
        # the same process with the real `stat` (its root is this host's `/`) blocks
        second = _adopt_root(tmp_path, "second adoption", vocalis, data, cache)
        blocked = _run(env, *_adopt_args(second), expected=1)
    assert f"PID {process.pid}" in blocked.stderr
    # Other programs named server.js may run on the test machine (containers, other installs), so the tally is compared
    # between the two runs: this one process is the single difference in "in a container".
    skipped = [int(re.search(r"(\d+) skipped \(in a container\)", text).group(1)) for text in (result.stdout, blocked.stdout)]
    assert skipped[0] == skipped[1] + 1, skipped


def test_a_host_service_in_its_own_mount_namespace_still_blocks(tmp_path):
    # systemd PrivateTmp/ProtectHome give a unit a mount namespace of its own but not another root: the check must still
    # see it. An unprivileged test cannot make a namespace, so `readlink` reports a foreign /proc/<pid>/ns/mnt for the
    # process (what a hardened unit would show); the check must not look at it.
    env, docker_log, root, (vocalis, data, cache) = _adopt(tmp_path)
    stub = Path(env["PATH"].split(os.pathsep)[0]) / "readlink"
    stub.write_text('#!/usr/bin/env bash\n'
                    'if [[ "$*" == *"/proc/${FAKE_OTHER_NS_PID:-none}/ns/mnt"* ]]; then echo "mnt:[4026539999]"; exit 0; fi\n'
                    'exec /usr/bin/readlink "$@"\n', encoding="utf-8")
    stub.chmod(0o755)
    with _running(tmp_path, "python3", vocalis / "vocalis_server.py") as process:
        env["FAKE_OTHER_NS_PID"] = str(process.pid)
        blocked = _run(env, *_adopt_args(root), expected=1)
    assert f"PID {process.pid}" in blocked.stderr
    assert "ns/mnt" not in (PACKAGING / "setup.sh").read_text(encoding="utf-8").replace("# ", "").split("check_adopted_not_in_use() {")[1]


def test_arguments_and_the_vocalis_environment_inside_the_data_block_but_only_for_python_and_node_and_only_for_python_for_environ(tmp_path):
    cases = [
        # (label, interpreter, script outside the data, extra argv, environment, blocks?)
        ("python with an absolute argument in the store", "python3", ["ARG_VOCALIS"], {}, True),
        ("node with an absolute argument in the cache", "node", ["ARG_CACHE"], {}, True),
        ("python with VOCALIS_DATA_DIR in the store", "python3", [], {"VOCALIS_DATA_DIR": "ENV_VOCALIS"}, True),
        ("python with VOCALIS_CACHE_DIR in the cache", "python3", [], {"VOCALIS_CACHE_DIR": "ENV_CACHE"}, True),
        ("node with VOCALIS_DATA_DIR (environment counts for Python only)", "node", [], {"VOCALIS_DATA_DIR": "ENV_VOCALIS"}, False),
        ("python with VOCALIS_DATA_DIR elsewhere", "python3", [], {"VOCALIS_DATA_DIR": "ELSEWHERE"}, False),
        ("python with another variable pointing into the store", "python3", [], {"SOME_OTHER_DIR": "ENV_VOCALIS"}, False),
        ("python with a relative argument", "python3", ["entries/x"], {}, False),
    ]
    for index, (label, name, extra, environ, blocks) in enumerate(cases):
        folder = tmp_path / f"case{index}"
        env, docker_log, root, (vocalis, data, cache) = _adopt(folder)
        subst = {"ARG_VOCALIS": str(vocalis / "voices"), "ARG_CACHE": str(cache / "entry"), "ENV_VOCALIS": str(vocalis),
                 "ENV_CACHE": str(cache), "ELSEWHERE": str(folder / "elsewhere")}
        with _running(folder, name, folder / "code" / "tool.py", None, [subst.get(item, item) for item in extra],
                      {key: subst.get(value, value) for key, value in environ.items()}) as process:
            result = _run(env, *_adopt_args(root), expected=1 if blocks else 0)
        if blocks:
            assert f"PID {process.pid}" in result.stderr, (label, result.stderr)
        else:
            assert "0 blocking" in result.stdout, (label, result.stdout)


def test_the_blocking_list_uses_the_command_line_already_read():
    text = (PACKAGING / "setup.sh").read_text(encoding="utf-8")
    body = text[text.index("check_adopted_not_in_use() {"):text.index("if [[ -L \"$ENV_FILE\" ]]")]
    assert body.count("/cmdline") == 1, "the command line is read once (mapfile) and reused for the message"
    assert 'blocked+=("$pid: ${argv[*]} ($reason)")' in body


def test_the_in_use_check_covers_where_the_links_point_now_as_well_as_the_recorded_folders(tmp_path):
    env, docker_log, root, (vocalis, data, cache) = _adopted_instance(tmp_path)
    # a link moved after adoption: a program on the old (recorded) folder and one on the new folder both block
    moved = _make_dir(tmp_path / "moved-store")
    for name in ("admin_credentials.yaml", "vault_keys.yaml"):
        (moved / name).write_text("fixture\n", encoding="utf-8")
    (root / "data" / "vocalis").unlink()
    (root / "data" / "vocalis").symlink_to(moved)
    with _running(tmp_path, "python3", vocalis / "vocalis_server.py") as old_process:
        old = _run(env, "--root", root, expected=1)
    assert f"PID {old_process.pid}" in old.stderr
    with _running(tmp_path, "python3", moved / "vocalis_server.py") as new_process:
        new = _run(env, "--root", root, expected=1)
    assert f"PID {new_process.pid}" in new.stderr


def _adopted_instance(tmp_path):
    env, docker_log, root, stores = _adopt(tmp_path)
    _run(env, *_adopt_args(root))
    docker_log.write_text("", encoding="utf-8")
    return env, docker_log, root, stores


def test_the_in_use_check_repeats_on_a_rerun_and_on_update_before_the_fetch_and_the_start(tmp_path):
    env, docker_log, root, (vocalis, data, cache) = _adopted_instance(tmp_path)
    saved = (root / "instance.env").read_text(encoding="utf-8")
    with _running(tmp_path, "node", data.parent / "server.js") as process:
        rerun = _run(env, "--root", root, expected=1)
        assert f"PID {process.pid}" in rerun.stderr
        lines = _log_lines(docker_log)
        assert not any("fetch_models.py" in line for line in lines) and _no_compose_start(lines) and not _provision_lines(lines)
        docker_log.write_text("", encoding="utf-8")
        update = _run(env, *_update_args(root), expected=1)
        assert f"PID {process.pid}" in update.stderr
        lines = _log_lines(docker_log)
        assert not any("fetch_models.py" in line for line in lines) and _no_compose_start(lines)
    assert (root / "instance.env").read_text(encoding="utf-8") == saved
    assert not list(root.glob(".instance.env.update.*")) and not (root / "instance.env.previous").exists()
    # with the program stopped both go through, and the update names the new images
    docker_log.write_text("", encoding="utf-8")
    _run(env, "--root", root)
    _run(env, *_update_args(root))
    assert f"VOCALIS_IMAGE={UPDATE_VOCALIS}" in (root / "instance.env").read_text(encoding="utf-8")
    assert "ADOPTED_PATHS=" in (root / "instance.env").read_text(encoding="utf-8")


def test_the_in_use_check_runs_again_just_before_the_services_start(tmp_path):
    # A unit started while the (long) model download runs: the check before the fetch passed, the one before `compose up`
    # must still refuse. The fetch stand-in starts the program.
    env, docker_log, root, (vocalis, data, cache) = _adopted_instance(tmp_path)
    interpreters = _make_dir(tmp_path / "interpreters")
    (interpreters / "python3").symlink_to(sys.executable)
    script = vocalis / "vocalis_server.py"
    script.write_text("import time\ntime.sleep(300)\n", encoding="utf-8")
    pid_file = tmp_path / "hook.pid"
    hook = tmp_path / "hook.sh"
    hook.write_text(f'#!/usr/bin/env bash\nnohup "{interpreters / "python3"}" "{script}" </dev/null >/dev/null 2>&1 &\necho $! > "{pid_file}"\n'
                    'for i in $(seq 100); do grep -q vocalis_server /proc/$!/cmdline 2>/dev/null && break; sleep 0.05; done\n', encoding="utf-8")
    hook.chmod(0o755)
    env["FAKE_FETCH_HOOK"] = str(hook)
    try:
        result = _run(env, "--root", root, expected=1)
        pid = int(pid_file.read_text(encoding="utf-8"))
        assert f"PID {pid}" in result.stderr
        lines = _log_lines(docker_log)
        assert any("fetch_models.py" in line for line in lines) and _no_compose_start(lines)
        assert "In-use check (before the services start)" in result.stdout
    finally:
        if pid_file.exists():
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pid_file.read_text(encoding="utf-8")), 9)


def test_existing_data_flag_combinations(tmp_path):
    env, docker_log, root = _fresh(tmp_path)
    plain = _run(env, "--root", root, "--existing-data", expected=1)
    assert "applies to a new instance only" in plain.stderr
    update = _run(env, *_update_args(root), "--existing-data", expected=1)
    assert "cannot be combined with --update" in update.stderr
    (tmp_path / "other").mkdir()
    env2, _ = _fake_docker(tmp_path / "other")
    deferred = _run(env2, *_new_instance_args(tmp_path / "other root"), "--existing-data", "--defer-start", expected=1)
    assert "Linux" in deferred.stderr and not (tmp_path / "other root" / "instance.env").exists()
    helped = _run(env, "--help")
    assert "--existing-data" in helped.stdout and "--vocalis-url" in helped.stdout and "--taproom-url" in helped.stdout


# -- the owner rule -----------------------------------------------------------------------------------------------------

def test_the_owner_rule_provisions_only_an_empty_store_and_otherwise_checks(tmp_path):
    _require_bash()
    # fresh: unchanged (its store is empty), covered by the older tests too
    (tmp_path / "fresh").mkdir()
    env, docker_log = _fake_docker(tmp_path / "fresh")
    root = tmp_path / "fresh" / "inst"
    _use_owner_root(env, root)
    _run(env, *_new_instance_args(root))
    fresh = _provision_lines(_log_lines(docker_log))
    assert len(fresh) == 1 and " --check " not in f" {fresh[0]} "
    # a non-empty adopted store (reached through a link): --check only
    env, docker_log, root, stores = _adopt(tmp_path / "full")
    _run(env, *_adopt_args(root))
    populated = _provision_lines(_log_lines(docker_log))
    assert len(populated) == 1 and " --check " in f" {populated[0]} "
    # the same instance, after a failed --check, still refuses and starts nothing
    env["FAKE_CHECK_EXIT"] = "1"
    docker_log.write_text("", encoding="utf-8")
    failed = _run(env, "--root", root, expected=1)
    assert "nonempty but owner verification failed" in failed.stderr and _no_compose_start(_log_lines(docker_log))
    # an empty adopted store is provisioned
    env, docker_log, root, stores = _adopt(tmp_path / "empty", taproom="empty")
    _run(env, *_adopt_args(root))
    empty = _provision_lines(_log_lines(docker_log))
    assert len(empty) == 1 and " --check " not in f" {empty[0]} "


# -- recorded container paths (item 4) ----------------------------------------------------------------------------------

BAD_CONTAINER_PATHS = [
    "relative/path", "/", "/tmp", "/var", "/opt", "/opt/vocalis", "/usr/share/x", "/etc/x", "/bin", "/sbin/x", "/lib", "/lib64/x", "/proc/x",
    "/sys", "/dev/shm", "/run/x", "/models", "/models/vocalis", "/work/x", "/logs", "/data/taproom", "/data/taproom/data", "/home/vocalis",
    "/home/vocalis/.cache", "/home", "/data", "/has space", "/semi;colon", "/a/../b", "/a/./b", "/a//b", "/trailing/", "/quote'x",
]


@pytest.mark.parametrize("bad", BAD_CONTAINER_PATHS)
def test_a_bad_recorded_vocalis_path_is_refused_before_anything_runs(tmp_path, bad):
    env, docker_log, root = _fresh(tmp_path)
    _set_env(root, "VOCALIS_DATA_PATH", bad)
    result = _run(env, "--root", root, expected=1)
    assert "VOCALIS_DATA_PATH" in result.stderr
    assert not _compose_calls(_log_lines(docker_log))


def test_recorded_vocalis_paths_must_differ_and_not_nest_and_good_ones_work(tmp_path):
    env, docker_log, root = _fresh(tmp_path)
    for data, cache, message in (("/data/same", "/data/same", "must differ"), ("/data/a", "/data/a/b", "must not be nested"),
                                 ("/data/a/b", "/data/a", "must not be nested")):
        _set_env(root, "VOCALIS_DATA_PATH", data)
        _set_env(root, "VOCALIS_CACHE_PATH", cache)
        assert message in _run(env, "--root", root, expected=1).stderr
    for data, cache in (("/home/user/Vocalis", "/home/user/.cache/vocalis"), ("/tmp/x", "/var/lib/y"), ("/data/vocalis", "/cache/vocalis")):
        _set_env(root, "VOCALIS_DATA_PATH", data)
        _set_env(root, "VOCALIS_CACHE_PATH", cache)
        docker_log.write_text("", encoding="utf-8")
        _run(env, "--root", root)
        assert f"sh {data} {cache} /models/vocalis" in "\n".join(_log_lines(docker_log))


def test_an_instance_env_without_the_new_keys_keeps_working_on_the_default_paths(tmp_path):
    env, docker_log, root = _fresh(tmp_path)
    old = (root / "instance.env").read_text(encoding="utf-8")
    assert "VOCALIS_DATA_PATH=/data/vocalis\n" in old and "VOCALIS_CACHE_PATH=/cache/vocalis\n" in old  # a fresh instance records the defaults
    assert "ADOPTED_PATHS" not in old
    (root / "instance.env").write_text(re.sub(r"^VOCALIS_(DATA|CACHE)_PATH=.*\n", "", old, flags=re.MULTILINE), encoding="utf-8")
    result = _run(env, "--root", root)
    assert "sh /data/vocalis /cache/vocalis /models/vocalis /work/vocalis /logs" in "\n".join(_log_lines(docker_log))
    assert "is running with its saved identity and roots" in result.stdout
    assert "ADOPTED_PATHS" not in (root / "instance.env").read_text(encoding="utf-8")


def test_adopting_records_the_canonical_target_of_a_chain_of_links_and_keeps_the_default_for_a_real_folder(tmp_path):
    env, docker_log, root, (vocalis, data, cache) = _adopt(tmp_path)
    # the cache link points at a link that points at the folder: the recorded path is the final canonical folder
    chain = tmp_path / "chain-link"
    chain.symlink_to(cache)
    (root / "cache" / "vocalis").unlink()
    (root / "cache" / "vocalis").symlink_to(chain)
    _run(env, *_adopt_args(root))
    saved = (root / "instance.env").read_text(encoding="utf-8")
    assert f"VOCALIS_CACHE_PATH={cache}\n" in saved
    # a Vocalis store that is a real folder in the root keeps the default container path
    env, docker_log, root2, stores = _adopt(tmp_path / "real", name="real root")
    (root2 / "data" / "vocalis").unlink()
    shutil.copytree(stores[0], root2 / "data" / "vocalis")
    _run(env, *_adopt_args(root2))
    saved2 = (root2 / "instance.env").read_text(encoding="utf-8")
    assert "VOCALIS_DATA_PATH=/data/vocalis\n" in saved2 and f"VOCALIS_CACHE_PATH={stores[2]}\n" in saved2


# -- public addresses (item 10) -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("url", ["http://example.com", "http://localhost:8001", "http://127.0.0.1", "https://myhost/path", "https://myhost:7871/",
                                 "https://myhost:99999", "https://myhost:0", "ftp://myhost:1", "https://myhost:7871?x=1", "https://us er@myhost", "https://ke i",
                                 "https://myhost'x", "https://", "myhost:7871", "https://-myhost"])
def test_a_bad_public_address_is_refused_and_nothing_is_written(tmp_path, url):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    root = tmp_path / "bad url"
    _use_owner_root(env, root)
    for flag in ("--vocalis-url", "--taproom-url"):
        result = _run(env, *_new_instance_args(root), flag, url, expected=1)
        assert flag in result.stderr
        assert not (root / "instance.env").exists()
        assert not _compose_calls(_log_lines(docker_log))


def test_public_addresses_are_recorded_printed_and_fixed_for_an_existing_instance(tmp_path):
    _require_bash()
    env, docker_log = _fake_docker(tmp_path)
    root = tmp_path / "proxied"
    _use_owner_root(env, root)
    result = _run(env, *_new_instance_args(root), "--vocalis-url", "https://myhost.example:7871", "--taproom-url", "http://127.0.0.1:8001")
    saved = (root / "instance.env").read_text(encoding="utf-8")
    assert "VOCALIS_PUBLIC_URL=https://myhost.example:7871\n" in saved and "TAPROOM_PUBLIC_URL=http://127.0.0.1:8001\n" in saved
    assert "HOST_BIND=127.0.0.1\n" in saved
    assert "Vocalis bootstrap: https://myhost.example:7871/setup" in result.stdout and "Taproom: http://127.0.0.1:8001\n" in result.stdout
    _run(env, "--root", root, "--vocalis-url", "https://myhost.example:7871")
    changed = _run(env, "--root", root, "--vocalis-url", "https://other.example", expected=1)
    assert "fixed for an existing instance" in changed.stderr
    assert (root / "instance.env").read_text(encoding="utf-8") == saved


def test_a_rerun_may_repeat_the_recorded_image_flags_and_a_different_image_still_needs_update(tmp_path):
    # October 10, 2026: setup's own hint says "run the same setup command again to resume", but any image flag
    # on an existing instance was refused, so the command that created an instance could not resume it.
    _require_bash()
    env, _docker_log = _fake_docker(tmp_path)
    root = tmp_path / "resumed"
    _use_owner_root(env, root)
    args = _new_instance_args(root)
    _run(env, *args)
    saved = (root / "instance.env").read_text(encoding="utf-8")
    _run(env, *args)
    assert (root / "instance.env").read_text(encoding="utf-8") == saved
    other = "registry.example/taproom@sha256:" + "c" * 64
    changed = _run(env, "--root", root, "--taproom-image", other, expected=1)
    assert "Changing images on an existing instance requires --update." in changed.stderr
    changed = _run(env, "--root", root, "--vocalis-image", "registry.example/vocalis@sha256:" + "d" * 64, expected=1)
    assert "Changing images on an existing instance requires --update." in changed.stderr
    assert (root / "instance.env").read_text(encoding="utf-8") == saved


# -- what Compose renders (items 3, 4, 8, 9, 12) ------------------------------------------------------------------------

def _real_compose():
    docker = shutil.which("docker")
    if os.name != "posix" or not docker:
        pytest.skip("rendering needs the real Docker CLI on Linux")
    if subprocess.run([docker, "compose", "version"], capture_output=True, timeout=30).returncode != 0:
        pytest.skip("Docker Compose v2 is not available")
    return docker


def _render(tmp_path, env_lines=(), extra_files=()):
    docker = _real_compose()
    env_file = tmp_path / "instance.env"
    env_file.write_text("\n".join([
        "INSTANCE_ID=vi-contract0001", "GPU_VARIANT=cuda", "INSTANCE_ROOT='/srv/inst'", "HOST_BIND=127.0.0.1", "VOCALIS_PORT=18770", "TAPROOM_PORT=18771",
        "VOCALIS_PUBLIC_URL=http://127.0.0.1:18770", "TAPROOM_PUBLIC_URL=http://127.0.0.1:18771", "VOCALIS_UID=1000", "VOCALIS_GID=1000",
        "TAPROOM_UID=1000", "TAPROOM_GID=1000", "GPU_GID=0", "VOCALIS_IMAGE=registry.example/vocalis@sha256:" + "a" * 64,
        "TAPROOM_IMAGE=registry.example/taproom@sha256:" + "b" * 64, *env_lines, ""]), encoding="utf-8")
    command = [docker, "compose", "--project-name", "vocalis-vi-contract0001", "--env-file", str(env_file),
               "-f", str(PACKAGING / "compose.yaml"), "-f", str(PACKAGING / "compose.cuda.yaml")]
    for extra in extra_files:
        command += ["-f", str(extra)]
    environment = {key: value for key, value in os.environ.items() if not key.startswith(("COMPOSE_", "VOCALIS_", "TAPROOM_", "INSTANCE_"))}
    result = subprocess.run([*command, "config", "--format", "json"], capture_output=True, text=True, timeout=60, env=environment)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _hosts(service):
    hosts = service.get("extra_hosts") or {}
    if isinstance(hosts, list):
        hosts = dict(item.split(":", 1) if ":" in item else item.split("=", 1) for item in hosts)
    return hosts


def test_compose_renders_the_taproom_binds_host_gateway_and_default_vocalis_paths(tmp_path):
    config = _render(tmp_path)
    vocalis, taproom = config["services"]["vocalis"], config["services"]["taproom"]
    binds = {volume["target"]: volume for volume in taproom["volumes"]}
    assert set(binds) == {"/etc/taproom", "/data/taproom/data", "/logs"}
    assert binds["/etc/taproom"]["source"] == "/srv/inst/data/taproom" and binds["/data/taproom/data"]["source"] == "/srv/inst/data/taproom/data"
    assert all(volume["type"] == "bind" and volume["bind"]["create_host_path"] is False for volume in taproom["volumes"] + vocalis["volumes"])
    assert taproom["environment"]["TAPROOM_MCP_CONFIG"] == "/etc/taproom/mcp-servers.json"
    for service in (vocalis, taproom):
        assert _hosts(service) == {"host.docker.internal": "host-gateway"}
    # an instance.env without VOCALIS_DATA_PATH / VOCALIS_CACHE_PATH (every instance made before October 10, 2026)
    assert {volume["target"] for volume in vocalis["volumes"]} == {"/data/vocalis", "/cache/vocalis", "/models/vocalis", "/work/vocalis", "/logs"}
    assert vocalis["environment"]["VOCALIS_DATA_DIR"] == "/data/vocalis" and vocalis["environment"]["VOCALIS_CACHE_DIR"] == "/cache/vocalis"
    # Docker-only runtime caches are set by the image, not by Compose
    for name in ("HF_HOME", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE", "TORCH_HOME", "XDG_CACHE_HOME"):
        assert name not in vocalis["environment"]


def test_compose_binds_and_environment_follow_the_recorded_vocalis_paths(tmp_path):
    config = _render(tmp_path, ["VOCALIS_DATA_PATH=/home/user/Vocalis", "VOCALIS_CACHE_PATH=/home/user/.cache/vocalis"])
    vocalis = config["services"]["vocalis"]
    binds = {volume["target"]: volume["source"] for volume in vocalis["volumes"]}
    assert binds["/home/user/Vocalis"] == "/srv/inst/data/vocalis" and binds["/home/user/.cache/vocalis"] == "/srv/inst/cache/vocalis"
    assert "/data/vocalis" not in binds and "/cache/vocalis" not in binds
    assert vocalis["environment"]["VOCALIS_DATA_DIR"] == "/home/user/Vocalis"
    assert vocalis["environment"]["VOCALIS_CACHE_DIR"] == "/home/user/.cache/vocalis"


def test_compose_local_yaml_is_merged_after_the_variant_file(tmp_path):
    local = tmp_path / "compose.local.yaml"
    local.write_text('services:\n  vocalis:\n    extra_hosts:\n      - "myhost:host-gateway"\n    environment:\n      VOCALIS_LLAMA_LOCAL: "1"\n', encoding="utf-8")
    config = _render(tmp_path, extra_files=[local])
    vocalis = config["services"]["vocalis"]
    assert _hosts(vocalis) == {"host.docker.internal": "host-gateway", "myhost": "host-gateway"}
    assert vocalis["environment"]["VOCALIS_LLAMA_LOCAL"] == "1"


# -- the README's legacy-unit guard ---------------------------------------------------------------------------------------

def test_the_readmes_legacy_unit_guard_fails_closed_and_counts_a_container_in_any_state(tmp_path):
    _require_bash()
    readme = (PACKAGING / "README.md").read_text(encoding="utf-8")
    line = re.search(r"^ExecStartPre=(.+)$", readme, re.MULTILINE).group(1).replace("<id>", "vi-0123456789ab")
    assert "$" not in line and "%" not in line, "systemd expands $ and % in unit files"
    assert line.count("label=com.docker.compose.project=vocalis-vi-0123456789ab") == 2
    import shlex
    command = shlex.split(line)
    assert command[:2] == ["/bin/sh", "-c"]
    env, docker_log = _fake_docker(tmp_path)
    # a container exists (running or not: -a), the guard names the way out
    env["FAKE_PS_OUTPUT"] = "0123456789ab\n"
    refused = subprocess.run(command, capture_output=True, text=True, timeout=30, env=env)
    assert refused.returncode == 1 and "still has containers on this data" in refused.stderr
    assert "docker compose -p vocalis-vi-0123456789ab down" in refused.stderr and "systemctl --user disable" in refused.stderr
    assert "ps -aq --filter label=com.docker.compose.project=vocalis-vi-0123456789ab" in docker_log.read_text(encoding="utf-8")
    assert " ps -q " not in f" {docker_log.read_text(encoding='utf-8')} ", "-a is required: a stopped container still counts"
    # Docker itself cannot be asked (not running, not installed, no permission): fail closed
    env["FAKE_PS_OUTPUT"] = ""
    env["FAKE_PS_EXIT"] = "1"
    closed = subprocess.run(command, capture_output=True, text=True, timeout=30, env=env)
    assert closed.returncode == 1 and "Cannot ask Docker" in closed.stderr
    # no container and Docker answers: the unit may start
    env["FAKE_PS_EXIT"] = "0"
    allowed = subprocess.run(command, capture_output=True, text=True, timeout=30, env=env)
    assert allowed.returncode == 0 and allowed.stderr == ""


def test_a_stray_vocalis_path_in_the_environment_never_overrides_instance_env(tmp_path):
    # Compose gives the process environment precedence over --env-file; setup exports the validated values.
    env, docker_log, root = _fresh(tmp_path)
    old = (root / "instance.env").read_text(encoding="utf-8")
    (root / "instance.env").write_text(re.sub(r"^VOCALIS_(DATA|CACHE)_PATH=.*\n", "", old, flags=re.MULTILINE), encoding="utf-8")
    env_log = tmp_path / "env.log"
    env["FAKE_ENV_LOG"] = str(env_log)
    _run(env, "--root", root)
    # even with nothing inherited, the validated values (the defaults for an old instance.env) are what Compose sees
    assert set(env_log.read_text(encoding="utf-8").splitlines()) == {"/data/vocalis|/cache/vocalis"}
    env_log.write_text("", encoding="utf-8")
    env.update({"VOCALIS_DATA_PATH": "/stray/data", "VOCALIS_CACHE_PATH": "/stray/cache"})
    _run(env, "--root", root)
    seen = set(env_log.read_text(encoding="utf-8").splitlines())
    assert seen == {"/data/vocalis|/cache/vocalis"}, seen  # an old instance.env gets the defaults, not the stray values
    _set_env_added = (root / "instance.env").read_text(encoding="utf-8") + "VOCALIS_DATA_PATH=/data/mine\nVOCALIS_CACHE_PATH=/cache/mine\n"
    (root / "instance.env").write_text(_set_env_added, encoding="utf-8")
    env_log.write_text("", encoding="utf-8")
    _run(env, "--root", root)
    assert set(env_log.read_text(encoding="utf-8").splitlines()) == {"/data/mine|/cache/mine"}


def test_the_mcp_server_list_must_be_private_when_adopted_and_is_made_private_on_later_runs(tmp_path):
    mcp = lambda root, *_: (root / "data" / "taproom" / "mcp-servers.json")
    def loose(root, *stores):
        mcp(root).write_text("{}\n", encoding="utf-8")
        mcp(root).chmod(0o644)
    result, _ = _adopt_refused(tmp_path / "loose", "readable by others", prepare=loose)
    assert "chmod 600 '" in result.stderr and "mcp-servers.json" in result.stderr
    # mode 0640 (group read) is refused too; 0600 and 0400 are accepted
    def group(root, *stores):
        mcp(root).write_text("{}\n", encoding="utf-8")
        mcp(root).chmod(0o640)
    _adopt_refused(tmp_path / "group", "readable by others", prepare=group)
    env, docker_log, root, stores = _adopt(tmp_path / "private")
    mcp(root).write_text("{}\n", encoding="utf-8")
    mcp(root).chmod(0o400)
    _run(env, *_adopt_args(root))
    # a later run: an existing file with group/other bits is set to 0600 and the folder only gets a warning
    mcp(root).chmod(0o644)
    (root / "data" / "taproom").chmod(0o755)
    rerun = _run(env, "--root", root)
    assert oct(mcp(root).stat().st_mode & 0o777) == "0o600"
    assert f"MCP server list {mcp(root)} had mode 644" in rerun.stdout and "set to 600" in rerun.stdout
    assert f"WARNING: {root / 'data' / 'taproom'} has mode 755" in rerun.stderr
    assert oct((root / "data" / "taproom").stat().st_mode & 0o777) == "0o755", "the folder is only warned about"
    # nothing is said when the file is already private
    quiet = _run(env, "--root", root)
    assert "MCP server list" not in quiet.stdout


