"""Small process helpers shared by retained external speech engines."""
from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path

from loguru import logger

#: Appended to every "model files are missing" message a user can see. Setup downloads the cleared
#: weights and a rerun resumes (model acquisition by setup), so this is
#: the whole remedy; one wording keeps Chatterbox, VoxCPM2 and Enhance saying the same thing.
SETUP_HINT = " Run the Vocalis setup command again to download it."

NOISE_MARKERS = (
    "MIOpen(HIP): Warning", "/opt/amdgpu/share/libdrm/amdgpu.ids",
    "(null): No such file or directory", "pkg_resources is deprecated",
    "Refrain from using this package",
)


def venv_python(venv_dir, windows: bool = None) -> Path:
    """Resolve the platform-specific Python executable in an isolated venv."""
    directory = Path(venv_dir)
    if windows is None:
        windows = os.name == "nt"
    return (directory / "Scripts" / "python.exe" if windows
            else directory / "bin" / "python")


def visible_device_index(index, environ=None) -> str:
    """Translate this process's `cuda:N` index into the machine-wide index a child must be given.

    A child pinned with `HIP_VISIBLE_DEVICES=N` counts N from the machine's full device list,
    but this process may itself run with a visibility list — the ROCm startup hides integrated
    GPUs that way (2026-10-09: the AMD test host's Raphael iGPU enumerates as a third device). With
    `HIP_VISIBLE_DEVICES=1,2`, this process's cuda:0 is machine device 1, so passing the bare
    0 would hand the child the hidden iGPU. Without a visibility list the index is unchanged.
    """
    env = os.environ if environ is None else environ
    for name in ("HIP_VISIBLE_DEVICES", "CUDA_VISIBLE_DEVICES"):
        visible = env.get(name)
        if visible:
            entries = [entry.strip() for entry in visible.split(",") if entry.strip()]
            position = int(index)
            if not 0 <= position < len(entries):
                raise ValueError(f"cuda:{index} is outside {name}={visible}")
            return entries[position]
    return str(index)


def card_env(device: str) -> dict:
    """Pin a child process to the selected accelerator when one is specified."""
    env = dict(os.environ)
    if device.startswith("cuda:"):
        index = visible_device_index(device.split(":", 1)[1])
        env["HIP_VISIBLE_DEVICES"] = index
        env["CUDA_VISIBLE_DEVICES"] = index
    env.setdefault("MIOPEN_FIND_MODE", "FAST")
    warning_filter = "ignore:pkg_resources is deprecated:UserWarning"
    prior = env.get("PYTHONWARNINGS")
    env["PYTHONWARNINGS"] = f"{prior},{warning_filter}" if prior else warning_filter
    return env


def kill_tree(proc) -> None:
    """Terminate one owned child process group, allowing a short graceful exit."""
    if os.name != "nt":
        try:
            group = os.getpgid(proc.pid)
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            return
        for _ in range(50):
            if proc.poll() is not None:
                return
            time.sleep(0.1)
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        proc.kill()


def ffprobe_duration(path) -> float:
    """Probe duration through the vault's scratch-copy boundary."""
    import scratch
    import vault_fs

    with vault_fs.child_input(path, scratch.scratch_root()) as plaintext:
        try:
            result = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(plaintext)],
                capture_output=True, text=True, encoding="utf-8", errors="replace")
            return round(float(result.stdout.strip()), 1) if result.returncode == 0 else 0.0
        # OSError: ffprobe missing or not executable. ValueError: no number on stdout (including
        # a UnicodeDecodeError). Anything else is a bug and must surface, not read as "0 seconds".
        except (OSError, ValueError) as exc:
            logger.warning("ffprobe duration unreadable, reporting 0.0 ({}: {})", type(exc).__name__, exc)
            return 0.0
