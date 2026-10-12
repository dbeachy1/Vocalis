"""Tests for setup.sh's CONFIGURATION pass — the half that asks.

Setup creates the environment and installs the selected PyTorch wheel. Configuration
collects the remaining deployment choices before user data is added, because
`vault_migrate --enable` intentionally refuses to migrate a store that already
contains data.
TODO_5_0_SETUP_UX.md is the spec; README "After setup" is the prose half.

Everything here drives `--configure-only` inside a THROWAWAY install directory
with a throwaway $HOME, so no test can write into the real repo or the real
~/.cache. Two seams make the Linux-only branches reachable from any host:
`VOCALIS_SETUP_ASSUME_TTY` (answers from a pipe instead of a terminal) and
`VOCALIS_SETUP_OS`. Both are documented in setup.sh's header, for the same
reason `VOCALIS_ROCM_DIR` is: a branch that can only run on one machine is a
branch that rots.

Skip conditions and the PATH-stubbing helpers are shared with test_setup_sh.py.
🔴 Under PowerShell the whole file skips — run it via Bash (scripts/run_tests.sh).
"""
import os
import shutil
import subprocess
from pathlib import Path

from test_setup_sh import (BASH, SETUP_SH, _make_stub, _min_real_dirs,
                           _to_bash_path, pytestmark, run_plan)         # noqa: F401

ENTER = ""          # take whatever default the prompt offers


def _fake_install(tmp_path):
    """A throwaway install root holding a copy of setup.sh, plus a throwaway HOME."""
    install = tmp_path / "Vocalis"
    install.mkdir()
    shutil.copy2(SETUP_SH, install / "setup.sh")
    home = tmp_path / "home"
    home.mkdir()
    return install, home


def _fake_venv_python(install: Path, record: Path):
    """An executable stub at venv/bin/python that records how it was called.

    The pass runs set-admin-credentials.py and vault_migrate.py through
    `$VENV/bin/python`. Recording argv and the three path variables proves those
    tools receive this install's roots rather than another install's defaults.
    """
    p = install / "venv" / "bin" / "python"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "#!/bin/sh\n"
        "{\n"
        '  echo "ARGV: $*"\n'
        '  echo "VOCALIS_CACHE_DIR=${VOCALIS_CACHE_DIR:-}"\n'
        '  echo "VOCALIS_SCRATCH_DIR=${VOCALIS_SCRATCH_DIR:-}"\n'
        '  echo "VOCALIS_APPLIO_DIR=${VOCALIS_APPLIO_DIR:-}"\n'
        '} >> "' + _to_bash_path(record) + '"\n'
        "exit 0\n"
    )
    p.chmod(0o755)
    return p


def run_configure(tmp_path, answers, *, install=None, home=None, stubs=(),
                  setup_os="Darwin", assume_tty=True):
    """Drive `bash setup.sh --configure-only`, answering the prompts from a pipe.

    `setup_os` defaults to Darwin — the platform where BOTH Linux-only steps are
    correctly skipped — so a test that wants them has to say so out loud.

    ⚠️ HOW MANY ANSWERS. The prompt count is CONDITIONAL, so padding with extra
    ENTERs does not "just work" — a surplus is silently eaten by a later prompt
    and takes its default (that is how a test asking for port 7871 quietly got
    7870). Always: cache, scratch, applio. Then, only when the condition holds:
    overwrite? (a vocalis.env already exists) · admin login? (a venv/bin/python
    exists) · encryption? (that AND Linux) · unit? (Linux AND systemctl on PATH)
    · port (unit answered yes).

    Returns (returncode, stdout+stderr combined): the prompts go to stderr, so
    they can never be mistaken for the script's own reporting.
    """
    if install is None or home is None:
        install, home = _fake_install(tmp_path)

    stub_dir = tmp_path / "stubbin"
    stub_dir.mkdir(exist_ok=True)
    for name in stubs:
        _make_stub(stub_dir, name)

    env = {
        "PATH": ":".join([_to_bash_path(stub_dir), *_min_real_dirs()]),
        "HOME": _to_bash_path(home),
        "VOCALIS_SETUP_ASSUME_TTY": "1" if assume_tty else "0",
        "VOCALIS_SETUP_OS": setup_os,
        # bash.exe on Windows needs these to initialize.
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
        "TEMP": os.environ.get("TEMP", "/tmp"),
    }
    proc = subprocess.run(
        [BASH, "setup.sh", "--configure-only"],
        input="".join(a + "\n" for a in answers),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(install),
    )
    return proc.returncode, proc.stdout + proc.stderr


# --------------------------------------------------------------- the escape hatches

def test_the_pass_refuses_to_run_without_a_terminal(tmp_path):
    """🔴 THE HARD REQUIREMENT: it must never block an unattended install. With no
    tty it does not prompt — it says so and stops, rather than reading EOF as the
    answer to six questions."""
    rc, out = run_configure(tmp_path, [], assume_tty=False)
    assert rc != 0
    assert "not a tty" in out


def test_no_configure_leaves_the_install_plan_untouched(tmp_path):
    """--no-configure is the other escape hatch, and it must not disturb the wheel
    resolution it now sits beside."""
    rc, plan, out = run_plan(tmp_path, args=["--no-configure"], stubs=["nvidia-smi"])
    assert rc == 0, out
    assert plan["vendor"] == "cuda"


# --------------------------------------------------------------- the three paths

def test_all_defaults_write_no_vocalis_env(tmp_path):
    """A single install on default paths is CORRECT with no file at all. An
    all-defaults vocalis.env is one more thing to explain, and one more thing to
    drift."""
    install, home = _fake_install(tmp_path)
    rc, out = run_configure(tmp_path, [ENTER] * 8, install=install, home=home)
    assert rc == 0, out
    assert not (install / "vocalis.env").exists()
    assert "no vocalis.env is needed" in out


def test_custom_paths_are_written_to_vocalis_env(tmp_path):
    install, home = _fake_install(tmp_path)
    rc, out = run_configure(
        tmp_path, ["/mnt/fast/cache", "/mnt/crypt/scratch", "/mnt/big/Applio", *[ENTER] * 5],
        install=install, home=home)
    assert rc == 0, out
    env_text = (install / "vocalis.env").read_text(encoding="utf-8")
    assert "VOCALIS_CACHE_DIR=/mnt/fast/cache" in env_text
    assert "VOCALIS_SCRATCH_DIR=/mnt/crypt/scratch" in env_text
    assert "VOCALIS_APPLIO_DIR=/mnt/big/Applio" in env_text
    # systemd's EnvironmentFile does NO expansion, and neither does
    # load_env_file(), so a written $HOME or ~ stays literal and names a
    # directory that does not exist. Checked on the VALUES only — the file's own
    # comments are allowed to talk about the hazard.
    values = [ln.split("=", 1)[1] for ln in env_text.splitlines()
              if ln.startswith("VOCALIS_") and "=" in ln]
    assert values and all("$" not in v and "~" not in v for v in values), env_text


def test_an_existing_vocalis_env_is_not_clobbered_without_consent(tmp_path):
    """That file may be the only thing keeping two installs apart. Overwriting it
    because somebody re-ran setup would merge them."""
    install, home = _fake_install(tmp_path)
    (install / "vocalis.env").write_text("VOCALIS_CACHE_DIR=/keep/me\n", encoding="utf-8")
    rc, out = run_configure(
        tmp_path, ["/mnt/fast/cache", ENTER, ENTER, "n", *[ENTER] * 4],
        install=install, home=home)
    assert rc == 0, out
    assert (install / "vocalis.env").read_text(encoding="utf-8") == "VOCALIS_CACHE_DIR=/keep/me\n"


# --------------------------------------------------------------- the neighbor check

def test_a_second_install_on_the_box_gets_suffixed_defaults(tmp_path):
    """🔴 THE DEFAULT THAT BITES. Cache and Applio are keyed on $HOME, not on the
    install, so install #2 silently inherits install #1's. The marker is how a
    running server claims a root: procs.claim_root() writes "<pid> <install>"."""
    install = tmp_path / "Vocalis.encrypted"
    install.mkdir()
    shutil.copy2(SETUP_SH, install / "setup.sh")
    home = tmp_path / "home"
    (home / ".cache" / "vocalis").mkdir(parents=True)
    (home / ".cache" / "vocalis" / ".vocalis-instance").write_text(
        "4242 " + _to_bash_path(tmp_path / "OtherVocalis") + "\n", encoding="utf-8")

    # Linux: ~/.cache/vocalis is where the marker lives on the platform that has
    # this problem (macOS keeps its cache under ~/Library/Caches).
    rc, out = run_configure(tmp_path, [ENTER] * 8, install=install, home=home, setup_os="Linux")
    assert rc == 0, out
    assert "ANOTHER VOCALIS IS ALREADY ON THIS BOX" in out
    # The suffix names THIS install ("Vocalis.encrypted" -> "encrypted"), not "2".
    assert "vocalis-encrypted" in out, out
    # ...and taking the suffixed defaults has to produce a file, or the two
    # installs are still sharing everything.
    assert (install / "vocalis.env").exists()


def test_a_marker_naming_this_very_install_is_not_a_collision(tmp_path):
    """Its own predecessor mid-restart is the one case this must never flag — the
    same rule procs.claim_root() follows for the same reason."""
    install, home = _fake_install(tmp_path)
    (home / ".cache" / "vocalis").mkdir(parents=True)
    (home / ".cache" / "vocalis" / ".vocalis-instance").write_text(
        "4242 " + _to_bash_path(install) + "\n", encoding="utf-8")

    rc, out = run_configure(tmp_path, [ENTER] * 8, install=install, home=home, setup_os="Linux")
    assert rc == 0, out
    assert "ANOTHER VOCALIS IS ALREADY ON THIS BOX" not in out


# --------------------------------------------------------------- encryption

def test_encryption_is_not_offered_off_linux(tmp_path):
    """The guarantee rests on yama ptrace_scope, which macOS and Windows do not
    have switched on. Offering it there would look identical and defend less."""
    install, home = _fake_install(tmp_path)
    record = tmp_path / "calls.txt"
    _fake_venv_python(install, record)
    rc, out = run_configure(tmp_path, [ENTER] * 8, install=install, home=home, setup_os="Darwin")
    assert rc == 0, out
    assert "Linux only" in out
    # The admin-login step DOES run here (it is cross-platform), so the record
    # exists — what must be absent from it is vault_migrate.
    calls = record.read_text(encoding="utf-8") if record.exists() else ""
    assert "vault_migrate.py" not in calls, calls


def test_encryption_hands_vault_migrate_THIS_installs_roots(tmp_path):
    """Pass the selected install paths to `vault_migrate` so it cannot resolve paths from another
    installation's defaults."""
    install, home = _fake_install(tmp_path)
    record = tmp_path / "calls.txt"
    _fake_venv_python(install, record)

    rc, out = run_configure(
        tmp_path,
        ["/mnt/fast/cache", "/mnt/crypt/scratch", "/mnt/big/Applio",
         "n",            # admin login: skip
         "y",            # encryption: yes
         *[ENTER] * 4],
        install=install, home=home, setup_os="Linux")
    assert rc == 0, out

    calls = record.read_text(encoding="utf-8")
    assert "vault_migrate.py" in calls, calls
    assert "VOCALIS_CACHE_DIR=/mnt/fast/cache" in calls, calls
    assert "VOCALIS_SCRATCH_DIR=/mnt/crypt/scratch" in calls, calls
    assert "VOCALIS_APPLIO_DIR=/mnt/big/Applio" in calls, calls


def test_encryption_says_out_loud_that_it_cannot_be_revisited(tmp_path):
    """Silence is what made this decision for people. The prompt has to say the
    store is empty NOW and will not be after the first render — and that the key
    is printed once."""
    install, home = _fake_install(tmp_path)
    _fake_venv_python(install, tmp_path / "calls.txt")
    rc, out = run_configure(tmp_path, [ENTER] * 8, install=install, home=home, setup_os="Linux")
    assert rc == 0, out
    assert "EMPTY" in out
    assert "recovery key" in out.lower()


def test_encryption_defaults_to_no(tmp_path):
    """Enter must never switch on a one-way, data-at-rest feature."""
    install, home = _fake_install(tmp_path)
    record = tmp_path / "calls.txt"
    _fake_venv_python(install, record)
    rc, out = run_configure(tmp_path, [ENTER] * 8, install=install, home=home, setup_os="Linux")
    assert rc == 0, out
    calls = record.read_text(encoding="utf-8") if record.exists() else ""
    assert "vault_migrate.py" not in calls, calls


# --------------------------------------------------------------- the systemd unit

def test_the_emitted_unit_launches_vocalis_py_not_the_module(tmp_path):
    """Launching `src/vocalis_server.py` as `__main__` lets a later import execute the module a
    second time and configure a separate locked store. Generated units must use `vocalis.py`."""
    install, home = _fake_install(tmp_path)
    rc, out = run_configure(
        tmp_path, [ENTER, ENTER, ENTER, "y", "7871"],
        install=install, home=home, setup_os="Linux", stubs=["systemctl"])
    assert rc == 0, out
    unit = (install / "vocalis.service").read_text(encoding="utf-8")
    assert "vocalis.py" in unit
    assert "vocalis_server.py" not in unit, unit


def test_the_emitted_unit_carries_the_env_file_and_the_chosen_port(tmp_path):
    install, home = _fake_install(tmp_path)
    rc, out = run_configure(
        tmp_path, ["/mnt/fast/cache", ENTER, ENTER, "y", "7871"],
        install=install, home=home, setup_os="Linux", stubs=["systemctl"])
    assert rc == 0, out
    unit = (install / "vocalis.service").read_text(encoding="utf-8")
    assert "--port 7871" in unit
    # The leading '-' is what lets a default single install run with no file.
    assert "EnvironmentFile=-" + _to_bash_path(install) + "/vocalis.env" in unit, unit
    # Restart=on-failure would leave the "Free all VRAM" button's clean exit down.
    assert "Restart=always" in unit


def test_the_unit_is_written_but_never_installed(tmp_path):
    """Writing into ~/.config/systemd/user or running `systemctl enable` behind
    somebody's back is not setup's call. It emits a file and prints the commands."""
    install, home = _fake_install(tmp_path)
    rc, out = run_configure(
        tmp_path, [ENTER, ENTER, ENTER, "y", ENTER],
        install=install, home=home, setup_os="Linux", stubs=["systemctl"])
    assert rc == 0, out
    assert (install / "vocalis.service").exists()
    assert not (home / ".config" / "systemd" / "user" / "vocalis.service").exists()
    assert "systemctl --user enable" in out


def test_no_systemd_no_unit(tmp_path):
    """No systemctl on PATH — there is nothing to install a unit into, so it does
    not offer one."""
    install, home = _fake_install(tmp_path)
    rc, out = run_configure(tmp_path, [ENTER] * 8, install=install, home=home, setup_os="Linux")
    assert rc == 0, out
    assert not (install / "vocalis.service").exists()
    assert "no systemd here" in out
