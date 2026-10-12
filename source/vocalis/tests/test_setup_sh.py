"""Tests for setup.sh vendor detection and wheel selection.

These exercise the ONE piece of setup.sh with real branching logic — picking the
CUDA / ROCm / CPU PyTorch wheel — without installing anything. We drive the
script's `--dry-run` mode (resolve plan, print key=value, exit before venv) with:

  * a controlled PATH containing stub `nvidia-smi` / `rocminfo` executables, so
    "is this vendor's tool present?" is deterministic regardless of the host, and
  * VOCALIS_ROCM_DIR pointed at a temp path, so the `/opt/rocm` filesystem probe
    is deterministic too, regardless of the host's ROCm installation.

Skipped entirely where no POSIX `bash` is available. On Windows they run under
Git Bash, which is also suitable for a Windows smoke test.
"""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
SETUP_SH = REPO_ROOT / "setup.sh"

BASH = shutil.which("bash")

# These tests stub PATH to simulate each vendor's tools. That only works in a
# POSIX shell env: on Linux/macOS natively, or on Windows *inside* Git Bash
# (MSYSTEM set). When Git Bash is spawned from a native Windows parent (cmd /
# PowerShell → python → bash), msys re-munges PATH across the boundary and the
# stubbing is unreliable, so we skip there. setup.sh itself only runs on
# Linux/macOS; on Windows the project test runner invokes it through Git Bash.
_CAN_STUB_PATH = os.name != "nt" or bool(os.environ.get("MSYSTEM"))
pytestmark = pytest.mark.skipif(
    BASH is None or not _CAN_STUB_PATH,
    reason="needs a POSIX shell env (Linux/macOS, or Windows Git Bash via scripts/run_tests.sh)",
)


def _min_real_dirs():
    """Dirs holding the externals setup.sh needs on the --dry-run path (dirname,
    ls, env, sed). Derived from the KNOWN bash location, not an env-sensitive
    probe: coreutils live beside bash (Git's usr/bin on Windows; /usr/bin or /bin
    on Linux). Crucially this never includes Windows System32 — where both the
    WSL `bash.exe` and the real `nvidia-smi` live — so the stub PATH stays in
    full control of vendor detection."""
    bash_dir = _to_bash_path(Path(BASH).parent)  # e.g. Git's usr/bin -> /usr/bin
    dirs = []
    for d in (bash_dir, "/usr/bin", "/bin", "/usr/local/bin"):
        if d and d not in dirs:
            dirs.append(d)
    return dirs


def _to_bash_path(p) -> str:
    """A path bash can consume. On Git Bash a Windows 'C:\\x' path breaks a
    ':'-delimited PATH and can't be stat'd, so translate via cygpath; on Linux
    the path is already POSIX."""
    p = str(p)
    if shutil.which("cygpath"):
        out = subprocess.run(["cygpath", "-u", p], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    return p


def _vendor_tool_leaks_into_min_dirs():
    """True if a real nvidia-smi/rocminfo lives in a coreutils dir the stub PATH
    can't drop (for example, beside `ls` and `sed`). Then the
    'no vendor tools present' (cpu-fallback) case simply can't be simulated on this
    host and that one test must skip. On Windows, nvidia-smi is typically in System32, which is
    NOT in _min_real_dirs, so the cpu case is still exercised there.)"""
    real_dirs = set(_min_real_dirs())
    for tool in ("rocminfo", "nvidia-smi"):
        p = shutil.which(tool)
        if p and _to_bash_path(Path(p).parent) in real_dirs:
            return True
    return False


def _make_stub(bin_dir: Path, name: str):
    """Write an executable no-op stub so `command -v <name>` succeeds."""
    f = bin_dir / name
    f.write_text("#!/bin/sh\nexit 0\n")
    f.chmod(0o755)


def run_plan(tmp_path, *, args=(), stubs=(), rocm_dir=None, env_extra=None):
    """Run `bash setup.sh <args> --dry-run` under a controlled environment.

    Returns (returncode, parsed_plan_dict, raw_stdout).
    """
    stub_dir = tmp_path / "stubbin"
    stub_dir.mkdir(exist_ok=True)
    for name in stubs:
        _make_stub(stub_dir, name)

    # ROCm dir probe: default to a guaranteed-absent path unless the case wants
    # to simulate a present /opt/rocm.
    if rocm_dir is None:
        rocm_dir = str(tmp_path / "no_such_rocm")

    # bash splits PATH on ':' and reads POSIX paths — build both accordingly.
    path = ":".join([_to_bash_path(stub_dir), *_min_real_dirs()])
    env = {
        "PATH": path,
        "VOCALIS_ROCM_DIR": _to_bash_path(rocm_dir),
        # bash.exe on Windows needs these to initialize.
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
        "TEMP": os.environ.get("TEMP", "/tmp"),
    }
    if env_extra:
        env.update(env_extra)

    # Invoke by basename with cwd=repo so BASH_SOURCE resolves cleanly on both
    # POSIX and Git Bash (no backslash/drive-letter in the script path).
    proc = subprocess.run(
        [BASH, "setup.sh", *args, "--dry-run"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, cwd=str(REPO_ROOT),
    )
    plan = {}
    for line in proc.stdout.splitlines():
        if "=" in line and not line.startswith("-"):
            k, _, v = line.partition("=")
            plan[k.strip()] = v.strip()
    return proc.returncode, plan, proc.stdout


# --------------------------------------------------------------- auto-detection

def test_detects_cuda_when_nvidia_smi_present(tmp_path):
    rc, plan, out = run_plan(tmp_path, stubs=["nvidia-smi"])
    assert rc == 0, out
    assert plan["vendor"] == "cuda"
    assert "cu124" in plan["torch_index"]
    assert "2.6.0+cu124" in plan["torch_spec"]


def test_detects_rocm_via_rocminfo(tmp_path):
    rc, plan, out = run_plan(tmp_path, stubs=["rocminfo"])
    assert rc == 0, out
    assert plan["vendor"] == "rocm"
    assert "rocm7.2" in plan["torch_index"]
    # ROCm is intentionally unpinned — assert the
    # wheels are requested from the rocm index, not a specific hardcoded version
    # (which would only be comparing the script's constant to itself).
    assert "torch" in plan["torch_spec"] and "torchaudio" in plan["torch_spec"]


def test_detects_rocm_via_opt_rocm_dir(tmp_path):
    # No rocminfo on PATH, but the probed dir exists -> rocm.
    rocm = tmp_path / "opt_rocm"
    rocm.mkdir()
    rc, plan, out = run_plan(tmp_path, rocm_dir=str(rocm))
    assert rc == 0, out
    assert plan["vendor"] == "rocm"


def test_falls_back_to_cpu(tmp_path):
    if _vendor_tool_leaks_into_min_dirs():
        pytest.skip("host has a GPU vendor tool in a system bin dir — cpu fallback can't be isolated")
    # No nvidia-smi, no rocminfo, no /opt/rocm.
    rc, plan, out = run_plan(tmp_path)
    assert rc == 0, out
    assert plan["vendor"] == "cpu"
    assert plan["torch_index"].endswith("/whl/cpu")


# --------------------------------------------------------------- overrides / precedence

def test_explicit_vendor_flag_overrides_detection(tmp_path):
    # nvidia-smi is present, but --vendor rocm must win.
    rc, plan, out = run_plan(tmp_path, args=["--vendor", "rocm"], stubs=["nvidia-smi"])
    assert rc == 0, out
    assert plan["vendor"] == "rocm"


def test_cpu_shorthand_flag(tmp_path):
    rc, plan, out = run_plan(tmp_path, args=["--cpu"], stubs=["nvidia-smi"])
    assert rc == 0, out
    assert plan["vendor"] == "cpu"


def test_env_vendor_override(tmp_path):
    rc, plan, out = run_plan(tmp_path, stubs=["nvidia-smi"], env_extra={"VOCALIS_VENDOR": "cpu"})
    assert rc == 0, out
    assert plan["vendor"] == "cpu"


def test_torch_spec_override(tmp_path):
    rc, plan, out = run_plan(
        tmp_path, args=["--vendor", "rocm"],
        env_extra={"VOCALIS_TORCH_SPEC": "torch==9.9.9 torchaudio==9.9.9"},
    )
    assert rc == 0, out
    assert plan["torch_spec"] == "torch==9.9.9 torchaudio==9.9.9"


# --------------------------------------------------------------- validation

def test_invalid_vendor_rejected(tmp_path):
    rc, _plan, _out = run_plan(tmp_path, args=["--vendor", "bogus"])
    assert rc != 0


# ── setup.sh and setup.bat must not drift apart ─────────────────────────────
#
# They keep the SAME dependency list, BY HAND, in two files, in two languages. setup.sh's
# own comment says "Mirrors setup.bat exactly" — a promise nothing has ever checked. Drop a
# package from one side and the suite stays green; the break surfaces months later, on
# somebody else's platform, as a missing import.
#
# This is not hypothetical. The 5.0 branch adds cryptography + argon2-cffi to both, and a
# careless merge silently dropping one set is exactly the failure that branch flagged.

_REPO = Path(__file__).resolve().parent.parent


def _pip_deps(path: Path, continuation: str) -> set:
    """The quoted packages in the "remaining dependencies" pip block.

    Anchored on that step's echo line, NOT on the first `-m pip install` we see: setup.bat
    has TWO continuation blocks (torch, then the deps) and setup.sh has one, so "the first
    pip install" reads a different list out of each file. `continuation` is a backslash for
    sh, a caret for bat.
    """
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    deps, seen_marker, collecting = set(), False, False
    for line in lines:
        stripped = line.strip()
        if not seen_marker:
            seen_marker = "Installing remaining dependencies" in stripped
            continue
        if not collecting:
            if "-m pip install" in stripped and stripped.endswith(continuation):
                collecting = True
            continue
        deps.update(re.findall(r'"([^"]+)"', stripped))
        if not stripped.endswith(continuation):     # the last package carries no continuation
            break
    return deps


def test_setup_sh_and_bat_install_the_same_dependencies():
    sh = _pip_deps(_REPO / "setup.sh", "\\")
    bat = _pip_deps(_REPO / "setup.bat", "^")
    assert sh, "could not parse setup.sh's dependency list — has the file changed shape?"
    assert bat, "could not parse setup.bat's dependency list — has the file changed shape?"

    only_sh = sh - bat
    only_bat = bat - sh
    assert not only_sh, (
        f"setup.sh installs packages setup.bat does not: {sorted(only_sh)}. "
        f"The two lists are mirrored BY HAND — fix setup.bat.")
    assert not only_bat, (
        f"setup.bat installs packages setup.sh does not: {sorted(only_bat)}. "
        f"The two lists are mirrored BY HAND — fix setup.sh.")


def test_both_setups_install_the_enhance_toolchain():
    """Training REFUSES to run on band-limited audio, and Chatterbox output IS band-limited.
    So an install without the enhancer is a broken install — on BOTH platforms."""
    sh = (_REPO / "setup.sh").read_text(encoding="utf-8", errors="replace")
    bat = (_REPO / "setup.bat").read_text(encoding="utf-8", errors="replace")
    assert "scripts/enhance/setup.sh" in sh, "setup.sh does not install the enhancer"
    assert r"scripts\enhance\setup.bat" in bat, "setup.bat does not install the enhancer"


def test_the_enhancer_has_ONE_dependency_list():
    """The enhancer's own installers must not repeat the hand-mirroring mistake: its deps
    live in requirements.txt, which BOTH read. If someone inlines a package list into
    either script, this catches it."""
    d = _REPO / "scripts" / "enhance"
    assert (d / "requirements.txt").is_file()
    for script, cont in ((d / "setup.sh", "\\"), (d / "setup.bat", "^")):
        text = script.read_text(encoding="utf-8", errors="replace")
        assert "requirements.txt" in text, f"{script.name} does not read requirements.txt"
        assert not _pip_deps(script, cont), \
            f"{script.name} has inlined a package list — put it in requirements.txt"
