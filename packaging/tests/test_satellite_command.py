"""Tests for the `vocalis-satellite` command that packaging/satellite/satellite-setup.sh installs on Linux (design
section 9, "Linux: Docker is the daemon, and one command controls it", added October 11, 2026), with the stand-in
`docker` of test_satellite_setup_contract.py and a task-owned HOME.

Docker, a system service, is the daemon; the command is a short bash script written to ~/.local/bin by a successful
setup. These tests cover the file setup writes (mark, folder, container, mode 755), the kept copy of the setup script
and its replacement rule, every verb's exact `docker` call and one-line result, the logs options, `autostart` calling
the kept script, `certificate` and `--pem`, Docker not running, an unmarked file and a symbolic link left alone, an
unusable HOME, a command that belongs to another existing satellite, and `--remove` deleting only its own command.

They run the Bash script, so on Windows Python they are skipped; run them in a Linux container as the repository's other
contract tests are.
"""

from pathlib import Path
import json
import os
import shutil
import subprocess

import pytest

from test_satellite_setup_contract import (  # noqa: F401  (the stand-in Docker and the harness are shared)
    IMAGE, IMAGE2, SCRIPT, SECRET, Harness, _first_run, _require_bash, _stamped_copy,
)

MARK = "# vocalis-satellite: written by Vocalis satellite setup; setup replaces this file."
USAGE_WORDS = ("start", "stop", "restart", "status", "logs", "autostart", "certificate", "help")


@pytest.fixture
def h(tmp_path):
    _require_bash()
    return Harness(tmp_path)


def command_path(h):
    return h.home / ".local" / "bin" / "vocalis-satellite"


def container(h):
    return f"vocalis-satellite-{h.sat_id()}"


def cmd(h, *args, expected=0, env=None):
    """Runs the installed command; asserts its exit status; returns the CompletedProcess."""
    run_env = dict(h.env, **(env or {}))
    result = subprocess.run([str(command_path(h)), *[str(item) for item in args]], stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=60, env=run_env)
    assert result.returncode == expected, f"exit {result.returncode}\n--- stdout\n{result.stdout}\n--- stderr\n{result.stderr}"
    return result


def installed(h, *extra):
    """A first run, then forget Docker's calls so the next assertions see only the command's."""
    _first_run(h, *extra)
    h.forget_calls()


# ---------------------------------------------------------------------------------------------------------------
# What setup writes
# ---------------------------------------------------------------------------------------------------------------

def test_setup_writes_the_command_with_the_mark_the_folder_the_container_and_mode_755(h):
    assert not (h.home / ".local").exists()
    _first_run(h)
    path = command_path(h)
    assert path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o777 == 0o755
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "#!/usr/bin/env bash"
    assert lines[1] == MARK  # the literal mark, on the second line
    assert lines[2] == f"ROOT='{h.root}'" and lines[3] == f"CONTAINER='{container(h)}'"  # single-quoted assignments
    assert subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True).returncode == 0
    assert b"\r" not in path.read_bytes()
    assert not list(path.parent.glob(".vocalis-satellite.tmp.*"))


def test_setup_never_edits_path_or_a_shell_start_file(h):
    _first_run(h)
    assert sorted(item.name for item in h.home.iterdir()) == [".local"]  # no .bashrc, .profile or the like
    assert sorted(item.name for item in (h.home / ".local").iterdir()) == ["bin"]


def test_the_last_closing_line_names_the_command_or_its_full_path_when_it_is_not_on_path(h):
    result = _first_run(h)
    last = result.stdout.rstrip("\n").splitlines()[-1]
    assert last == (f"To run it: {command_path(h)} start | stop | status | logs   "
                    f"({command_path(h).parent} is not on your PATH; setup does not change it)")
    on_path = h.run(env={"PATH": f"{command_path(h).parent}{os.pathsep}{h.env['PATH']}"})
    assert on_path.stdout.rstrip("\n").splitlines()[-1] == "To run it: vocalis-satellite start | stop | status | logs"


def test_a_rerun_rewrites_its_own_command_the_same_way(h):
    _first_run(h)
    original = command_path(h).read_bytes()
    lines = original.decode("utf-8").splitlines(keepends=True)
    command_path(h).write_text("".join(lines[:4]) + "echo an old body\n", encoding="utf-8")  # still marked, still ours
    h.run()
    assert command_path(h).read_bytes() == original
    assert command_path(h).stat().st_mode & 0o777 == 0o755


# ---------------------------------------------------------------------------------------------------------------
# The kept setup script
# ---------------------------------------------------------------------------------------------------------------

def test_setup_keeps_a_copy_of_itself_and_the_command_uses_it(h):
    _first_run(h)
    kept = h.root / "satellite-setup.sh"
    assert kept.read_bytes() == SCRIPT.read_bytes() and kept.stat().st_mode & 0o777 == 0o755
    assert not list(h.root.glob(".satellite-setup.sh.tmp.*"))


def test_a_run_from_another_file_replaces_the_kept_copy_and_a_run_from_the_kept_copy_does_not(h, tmp_path):
    _first_run(h)
    kept = h.root / "satellite-setup.sh"
    stamped = _stamped_copy(tmp_path, cuda=IMAGE, rocm="registry.example/vocalis-satellite-rocm@sha256:" + "c" * 64)
    h.run(script=stamped)
    assert kept.read_bytes() == stamped.read_bytes() != SCRIPT.read_bytes()
    # Run from the kept copy itself: nothing is copied over it (and no temporary file is left).
    before = kept.stat()
    h.run(script=kept)
    assert kept.read_bytes() == stamped.read_bytes() and kept.stat().st_mtime_ns == before.st_mtime_ns
    assert not list(h.root.glob(".satellite-setup.sh.tmp.*"))
    # A run from the original file brings it back (an update from a newer download refreshes the kept copy).
    h.run()
    assert kept.read_bytes() == SCRIPT.read_bytes()


def test_a_script_that_is_not_a_regular_file_is_not_kept(h):
    _first_run(h)
    kept = h.root / "satellite-setup.sh"
    kept.write_text("# an older kept copy\n", encoding="utf-8")
    # `bash <(cat script)`: $0 is /dev/fd/NN, a pipe, so there is nothing to copy.
    result = subprocess.run(
        ["bash", "-c", 'script=$1; shift; bash <(cat "$script") "$@"', "_", str(SCRIPT), "--root", str(h.root), "--port", str(h.port)],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, env=h.env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert kept.read_text(encoding="utf-8") == "# an older kept copy\n"


# ---------------------------------------------------------------------------------------------------------------
# The verbs: each one's exact docker call and its one plain line
# ---------------------------------------------------------------------------------------------------------------

def test_start_runs_docker_start_and_says_so_in_one_line(h):
    installed(h)
    h.set_container(status="exited")
    result = cmd(h, "start")
    assert h.argvs() == [["start", container(h)]]
    assert result.stdout == f"Started the satellite (container {container(h)}).\n" and result.stderr == ""
    (state,) = h.container_state().values()
    assert state["status"] == "running"


def test_stop_runs_docker_stop_and_says_it_frees_the_cards_memory(h):
    installed(h)
    result = cmd(h, "stop")
    assert h.argvs() == [["stop", container(h)]]
    assert result.stdout == f"Stopped the satellite (container {container(h)}). This frees the card's memory at once.\n"
    (state,) = h.container_state().values()
    assert state["status"] == "exited"


def test_restart_runs_docker_restart(h):
    installed(h)
    result = cmd(h, "restart")
    assert h.argvs() == [["restart", container(h)]]
    assert result.stdout == f"Restarted the satellite (container {container(h)}).\n"


def test_status_shows_running_since_port_address_image_autostart_and_the_last_five_log_lines(h):
    installed(h)
    result = cmd(h, "status")
    # The settings come from the kept script's --show-plan (no Docker call); the state and the log from Docker.
    assert h.argvs() == [
        ["container", "inspect", "--format", "{{.State.Status}}|{{.State.StartedAt}}|{{.State.FinishedAt}}", container(h)],
        ["logs", "--tail", "5", container(h)],
    ]
    (state,) = h.container_state().values()
    out = result.stdout
    assert f"Satellite {h.env_file()['SATELLITE_NAME']} (container {container(h)}): running since {state['started_at']}" in out
    assert f"Port and address: {h.port}, https://192.168.1.50:{h.port}" in out
    assert f"Image:            {IMAGE}" in out
    assert "Autostart:        on (comes back after a restart if it was running; a satellite you stopped stays stopped)" in out
    assert "Last 5 log lines:" in out and "    LOG-TAIL-LINE one" in out


def test_status_of_a_stopped_satellite_and_of_one_with_autostart_off(h):
    installed(h, "--autostart", "off")
    cmd(h, "stop")
    out = cmd(h, "status").stdout
    assert "(container " in out and "stopped (state: exited, last stopped " in out
    assert "Autostart:        off (stays down until you start it; also not restarted if it crashes)" in out


def test_logs_follows_the_last_hundred_lines_by_default(h):
    installed(h)
    result = cmd(h, "logs")
    assert h.argvs() == [["logs", "--tail", "100", "-f", container(h)]]
    assert "LOG-TAIL-LINE" in result.stdout + result.stderr


@pytest.mark.parametrize("arguments,docker_call", [
    (["-n", "20"], ["logs", "--tail", "20", "-f"]),
    (["--no-follow"], ["logs", "--tail", "100"]),
    (["-n", "7", "--no-follow"], ["logs", "--tail", "7"]),
    (["--no-follow", "-n", "7"], ["logs", "--tail", "7"]),
])
def test_logs_options(h, arguments, docker_call):
    installed(h)
    cmd(h, "logs", *arguments)
    assert h.argvs() == [docker_call + [container(h)]]


@pytest.mark.parametrize("arguments,message", [
    (["-n"], "logs -n needs a number"),
    (["-n", "many"], "logs -n needs a number"),
    (["--tail"], "Unknown option for logs: --tail"),
])
def test_logs_with_bad_options_is_refused_before_any_docker_call(h, arguments, message):
    installed(h)
    result = cmd(h, "logs", *arguments, expected=1)
    assert message in result.stderr and h.argvs() == []


def test_autostart_runs_the_kept_setup_script_with_autostart(h):
    installed(h)
    result = cmd(h, "autostart", "off")
    # The kept script's small operation: one docker update, recorded in satellite.env.
    assert ["update", "--restart", "no", container(h)] in h.argvs()
    assert h.env_file()["AUTOSTART"] == "off" and "Start with Docker is now off" in result.stdout
    h.forget_calls()
    cmd(h, "autostart", "on")
    assert ["update", "--restart", "unless-stopped", container(h)] in h.argvs() and h.env_file()["AUTOSTART"] == "on"


def test_autostart_calls_the_kept_script_with_exactly_root_and_the_value(h):
    installed(h)
    kept = h.root / "satellite-setup.sh"
    kept.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$FAKE_DIR/kept-args"\n', encoding="utf-8")
    cmd(h, "autostart", "off")
    assert (h.fake / "kept-args").read_text(encoding="utf-8").splitlines() == ["--root", str(h.root), "--autostart", "off"]
    assert h.argvs() == []  # the command itself made no Docker call


@pytest.mark.parametrize("arguments", [[], ["maybe"]])
def test_autostart_needs_on_or_off(h, arguments):
    installed(h)
    result = cmd(h, "autostart", *arguments, expected=1)
    assert "Usage: vocalis-satellite autostart on|off" in result.stderr and h.argvs() == []


def test_certificate_gives_the_file_the_fingerprint_and_the_scp_line(h):
    installed(h)
    result = cmd(h, "certificate")
    certificate = h.root / "data" / "certs" / "cert.pem"
    user = subprocess.run(["id", "-un"], capture_output=True, text=True).stdout.strip()
    assert result.stdout.splitlines() == [
        f"Certificate file to upload in Vocalis: {certificate}",
        "Fingerprint (SHA-256): AA:BB:01",
        "To fetch it to the computer where your browser is, run this on that computer:",
        f"  scp {user}@192.168.1.50:{certificate} .",
        'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite\'s row. Then tick its card.',
    ]
    assert h.argvs() == []  # no Docker call: the fingerprint was recorded in satellite.env


def test_certificate_pem_prints_the_public_certificate_itself_and_nothing_else(h):
    installed(h)
    result = cmd(h, "certificate", "--pem")
    assert result.stdout == (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8") and result.stderr == ""
    assert "KEY" not in result.stdout.replace("fingerprint", "")  # (the stand-in's key file holds the word KEY)


def test_certificate_without_a_certificate_or_with_a_bad_option(h):
    installed(h)
    (h.root / "data" / "certs" / "cert.pem").unlink()
    assert "There is no certificate yet" in cmd(h, "certificate", expected=1).stderr
    assert "Usage: vocalis-satellite certificate [--pem]" in cmd(h, "certificate", "--nope", expected=1).stderr


def test_help_and_no_arguments_print_the_usage_and_an_unknown_verb_is_refused(h):
    installed(h)
    for arguments in (["help"], ["--help"], ["-h"], []):
        result = cmd(h, *arguments)
        assert all(word in result.stdout for word in USAGE_WORDS), arguments
    refused = cmd(h, "launch", expected=1)
    assert "vocalis-satellite start" in refused.stderr and refused.stdout == ""
    assert h.argvs() == []


def test_the_facts_come_from_the_kept_scripts_show_plan(h):
    installed(h)
    stub = h.root / "satellite-setup.sh"
    stub.write_text(
        '#!/usr/bin/env bash\n'
        'printf "%s\\n" "$@" > "$FAKE_DIR/plan-args"\n'
        'printf "%s\\n" SATELLITE=existing NAME=stubname PORT=1234 AUTOSTART=off IMAGE=stub/image@sha256:x '
        'ADDRESSES=9.9.9.9,8.8.8.8 CERTIFICATE_FILE="$FAKE_DIR/stub-cert.pem" FINGERPRINT=11:22:33\n', encoding="utf-8")
    (h.fake / "stub-cert.pem").write_text("-----STUB-----\n", encoding="utf-8")
    status = cmd(h, "status").stdout
    assert "Satellite stubname " in status and "Port and address: 1234, https://9.9.9.9:1234" in status
    assert "Image:            stub/image@sha256:x" in status and "Autostart:        off" in status
    assert (h.fake / "plan-args").read_text(encoding="utf-8").splitlines() == ["--show-plan", "--root", str(h.root)]
    certificate = cmd(h, "certificate").stdout
    assert f"{h.fake / 'stub-cert.pem'}" in certificate and "11:22:33" in certificate and "@9.9.9.9:" in certificate
    assert cmd(h, "certificate", "--pem").stdout == "-----STUB-----\n"


# ---------------------------------------------------------------------------------------------------------------
# When Docker is not running, or the satellite is gone
# ---------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("verb", [["start"], ["stop"], ["restart"], ["status"], ["logs", "--no-follow"]])
def test_docker_not_running_is_said_as_that_and_nothing_changes(h, verb):
    installed(h)
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.config(docker_down=True)
    result = cmd(h, *verb, expected=1)
    assert "Docker is not running, or this user may not use it" in result.stderr
    assert "Cannot connect" not in result.stdout
    h.config(docker_down=False)
    assert json.dumps(h.container_state(), sort_keys=True) == state_before


def test_a_deleted_satellite_folder_is_said_and_nothing_is_changed(h):
    installed(h)
    shutil.rmtree(h.root)
    for verb in (["start"], ["stop"], ["restart"], ["status"], ["logs"], ["certificate"], ["autostart", "off"]):
        result = cmd(h, *verb, expected=1)
        assert "The satellite is not set up" in result.stderr and "bash satellite-setup.sh" in result.stderr, verb
    assert h.argvs() == []
    assert len(h.container_state()) == 1  # the container is still there; the command did not touch it


def test_a_container_removed_by_hand_is_said_and_the_command_to_recreate_it_is_named(h):
    installed(h)
    stored = json.loads((h.fake / "state.json").read_text(encoding="utf-8"))
    stored["containers"] = {}
    (h.fake / "state.json").write_text(json.dumps(stored), encoding="utf-8")
    for verb in (["start"], ["stop"], ["restart"], ["status"]):
        result = cmd(h, *verb, expected=1)
        assert f"The satellite's container {container(h)} does not exist" in result.stderr, verb
        assert "Nothing was changed" in result.stderr and f"bash '{h.root}/satellite-setup.sh' --root '{h.root}'" in result.stderr
    assert h.container_state() == {}


# ---------------------------------------------------------------------------------------------------------------
# A file that is not ours, an unusable HOME, another satellite's command
# ---------------------------------------------------------------------------------------------------------------

def _docker_commands_line(h, sat):
    name = f"vocalis-satellite-{sat}"
    return f"To run it: docker start {name} | docker stop {name} | docker logs --tail 100 -f {name}"


def test_an_unmarked_file_at_the_path_is_left_alone_said_and_the_docker_commands_are_printed(h):
    command_path(h).parent.mkdir(parents=True)
    command_path(h).write_text("#!/bin/sh\necho mine\n", encoding="utf-8")
    result = _first_run(h)
    assert command_path(h).read_text(encoding="utf-8") == "#!/bin/sh\necho mine\n"
    assert "was not written by this setup" in result.stdout and "left alone" in result.stdout
    assert result.stdout.rstrip("\n").splitlines()[-1] == _docker_commands_line(h, h.sat_id())
    assert h.result()["EXIT_CODE"] == "0"
    # The mark has to be on the second line: a file with it elsewhere is not ours either.
    command_path(h).write_text(MARK + "\n#!/bin/sh\necho mine\n", encoding="utf-8")
    h.run()
    assert command_path(h).read_text(encoding="utf-8") == MARK + "\n#!/bin/sh\necho mine\n"


def test_a_symbolic_link_at_the_path_is_left_alone_even_when_it_points_at_a_marked_file(h):
    _first_run(h)
    real = h.tmp / "elsewhere"
    shutil.copyfile(command_path(h), real)
    command_path(h).unlink()
    command_path(h).symlink_to(real)
    before = real.read_bytes()
    result = h.run()
    assert command_path(h).is_symlink() and os.readlink(command_path(h)) == str(real) and real.read_bytes() == before
    assert "was not written by this setup" in result.stdout
    assert result.stdout.rstrip("\n").splitlines()[-1] == _docker_commands_line(h, h.sat_id())
    # A dangling link is the user's as well.
    command_path(h).unlink()
    command_path(h).symlink_to(h.tmp / "nowhere")
    h.run()
    assert command_path(h).is_symlink() and not (h.tmp / "nowhere").exists()


def test_home_unset_warns_still_succeeds_and_prints_the_docker_commands(h):
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, env={"HOME": ""})
    assert "WARNING: HOME is not set, so the vocalis-satellite command was not installed." in result.stderr
    assert result.stdout.rstrip("\n").splitlines()[-1] == _docker_commands_line(h, h.sat_id())
    assert h.result()["EXIT_CODE"] == "0" and not (h.home / ".local").exists()


def test_a_folder_that_cannot_be_made_warns_still_succeeds_and_prints_the_docker_commands(h):
    not_a_folder = h.tmp / "a-file"
    not_a_folder.write_text("x", encoding="utf-8")
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, env={"HOME": str(not_a_folder)})
    assert "cannot be made, so the vocalis-satellite command was not installed" in result.stderr
    assert result.stdout.rstrip("\n").splitlines()[-1] == _docker_commands_line(h, h.sat_id())
    assert h.result()["EXIT_CODE"] == "0" and not_a_folder.read_text(encoding="utf-8") == "x"


def _second_satellite(h, name="other"):
    other_root = Path(os.path.realpath(h.tmp)) / name
    port = h.port + 1
    h.run("--root", other_root, "--image", IMAGE, "--secret-file", h.secret_file, "--port", port, root=False)
    values = {}
    for line in (other_root / "satellite.env").read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        values[key] = value
    return other_root, values["SATELLITE_ID"]


def test_a_command_that_belongs_to_another_existing_satellite_is_left_alone(h):
    _first_run(h)
    ours = command_path(h).read_bytes()
    # A second setup, for another folder, by the same user.
    other_root = Path(os.path.realpath(h.tmp)) / "other"
    result = h.run("--root", other_root, "--image", IMAGE, "--secret-file", h.secret_file, "--port", h.port + 1, root=False)
    assert command_path(h).read_bytes() == ours  # still the first satellite's
    assert "belongs to another satellite" in result.stdout and str(h.root) in result.stdout and "which still exists" in result.stdout
    other_id = (other_root / "satellite.env").read_text(encoding="utf-8").split("SATELLITE_ID=")[1].splitlines()[0]
    assert result.stdout.rstrip("\n").splitlines()[-1] == _docker_commands_line(h, other_id)
    # The first satellite's folder is gone: its command is stale, and the new setup takes the path.
    shutil.rmtree(h.root)
    h.run("--root", other_root, root=False, auto_port=False)
    assert command_path(h).read_text(encoding="utf-8").splitlines()[2] == f"ROOT='{other_root}'"
    assert f"CONTAINER='vocalis-satellite-{other_id}'" in command_path(h).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------------------------------------------
# --remove
# ---------------------------------------------------------------------------------------------------------------

def test_remove_deletes_its_own_command_and_names_the_kept_script_as_the_way_back(h):
    _first_run(h)
    result = h.run("--remove")
    assert not command_path(h).exists()
    assert f"Removed the command {command_path(h)}." in result.stdout
    assert result.stdout.rstrip("\n").splitlines()[-2:] == [
        f"Log of this run: {h.result()['LOG_FILE']}",
        f"To bring the satellite back (nothing has to be paired again): bash {h.root}/satellite-setup.sh"]
    assert (h.root / "satellite-setup.sh").is_file()
    # The way back works: the same command brings the satellite back, and the command with it.
    subprocess.run(["bash", str(h.root / "satellite-setup.sh"), "--root", str(h.root), "--port", str(h.port)],
                   stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, env=h.env, check=True)
    assert command_path(h).is_file()


def test_remove_leaves_a_command_that_is_not_its_own(h):
    _first_run(h)
    other_root, _ = _second_satellite(h)
    ours = command_path(h).read_bytes()  # the first satellite's
    h.run("--root", other_root, "--remove", root=False, auto_port=False)
    assert command_path(h).read_bytes() == ours
    # A file that is not ours at all, and a symbolic link, are not deleted either.
    h.run("--remove")
    assert not command_path(h).exists()
    command_path(h).write_text("#!/bin/sh\necho mine\n", encoding="utf-8")
    h.run()
    h.run("--remove")
    assert command_path(h).read_text(encoding="utf-8") == "#!/bin/sh\necho mine\n"
    command_path(h).unlink()
    target = h.tmp / "target"
    target.write_text("keep\n", encoding="utf-8")
    command_path(h).symlink_to(target)
    h.run()
    h.run("--remove")
    assert command_path(h).is_symlink() and target.read_text(encoding="utf-8") == "keep\n"


def test_a_successful_autostart_run_of_the_kept_script_puts_the_command_back(h):
    _first_run(h)
    command_path(h).unlink()
    result = subprocess.run(["bash", str(h.root / "satellite-setup.sh"), "--root", str(h.root), "--autostart", "off"],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, env=dict(h.env))
    assert result.returncode == 0, result.stdout + result.stderr
    assert command_path(h).is_file()  # a successful run, of any kind, leaves the command in place
