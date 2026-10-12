"""Read-only process scans for external engines and duplicate Vocalis roots.

`foreign_engines()` reports matching engine processes to the health header. `claim_root()` checks
whether another live Vocalis instance owns a data root before startup cleanup runs. Both scans
use `PROC_DIR`, which tests can override.

An unavailable `/proc`, unreadable marker, or unidentified process is an unknown result. Only a
positively identified live sibling blocks startup; treating uncertainty as a collision would
cause an outage. These helpers report state and never signal or terminate processes. Matching
requires `argv[0]` to be Python so a search command cannot count itself as an engine.
"""
import os
import time
from pathlib import Path

import scratch
from loguru import logger

from vocalis.runtime import paths
# The VoxCPM2 workers are children we started, so their pids are "ours" — importing the pool
# is what makes `_own_pids()` able to say so. voxcpm_pool imports nothing from this module.
from vocalis.runtime.voxcpm_pool import VOX


# Report matching engine processes that were not started by this server. This is a process-shape
# check, not per-process GPU accounting; the latter is not reliable on all supported stacks.
_FOREIGN_PATTERNS = {
    # The worker script by name, plus the isolated venv it must run from — a copy of
    # worker.py parked anywhere still runs on that interpreter (the m4g run used /tmp).
    "voxcpm": ("voxcpm/worker.py", "voxcpm-venv"),
    # Chatterbox loads IN-PROCESS, so there is no worker process to look for. What is
    # detectable is a CLI entry point, which loads a model as its whole reason to exist —
    # a shell render is the true analog of the shell-launched VoxCPM2 above.
    #
    # A server process alone does not establish that a model is loaded. Query that server's health
    # endpoint for model state instead of inferring it from process presence.
    "chatterbox": ("book_to_audio.py", "generate.py", "nomi_speak.py", "gradio_tts_app.py"),
}
PROC_DIR = "/proc"               # overridable so the scan is testable off a real box
_FOREIGN_TTL = 2.0               # /health is polled every 3 s PER TAB — scan once, share it
_foreign_cache = {"t": 0.0, "v": {}}

def _proc_pgrp(pid: int):
    """A process's pgid from /proc/<pid>/stat, or None. Parsed from the LAST ')' because
    comm sits in parentheses and may itself contain spaces or brackets."""
    try:
        with open(f"{PROC_DIR}/{pid}/stat") as f:
            after = f.read().rpartition(")")[2].split()
        return int(after[2])                      # state, ppid, PGRP
    except (OSError, ValueError, IndexError):
        return None


def _own_pids() -> set:
    """This server plus every VoxCPM2 worker it started — what a match must NOT be."""
    return {os.getpid()} | VOX.own_pids()


def foreign_engines() -> dict:
    """{'voxcpm': n, 'chatterbox': n} — processes of each engine's shape that aren't ours.

    Returns {} where /proc can't be read (the Windows dev box), which the UI reads as
    "nothing to say" rather than as "none running" — an empty finding and an unanswerable
    question must not look the same."""
    if not os.path.isdir(PROC_DIR):
        return {}
    now = time.monotonic()
    if now - _foreign_cache["t"] < _FOREIGN_TTL:
        return _foreign_cache["v"]
    own = _own_pids()
    counts = {k: 0 for k in _FOREIGN_PATTERNS}
    for entry in os.listdir(PROC_DIR):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid in own:
            continue
        try:
            with open(f"{PROC_DIR}/{entry}/cmdline", "rb") as f:
                argv = f.read().decode("utf-8", "replace").split("\0")
        except OSError:
            continue                              # exited mid-scan, or not ours to read
        # Require the process executable to be Python; a command that merely mentions a model
        # path must not count as a running engine.
        if not os.path.basename(argv[0] or "").startswith("python"):
            continue
        cmd = " ".join(argv)
        # Anything we spawned is ours: a direct child by ppid, and a worker's own
        # descendants by pgid (Worker uses start_new_session, so its pgid IS its pid).
        if _proc_pgrp(pid) in own:
            continue
        try:
            with open(f"{PROC_DIR}/{entry}/status") as f:
                ppid = next((int(ln.split()[1]) for ln in f if ln.startswith("PPid:")), None)
        except (OSError, ValueError, IndexError):
            ppid = None
        if ppid in own:
            continue
        for engine, needles in _FOREIGN_PATTERNS.items():
            if any(n in cmd for n in needles):
                counts[engine] += 1
                break
    _foreign_cache.update(t=now, v=counts)
    return counts

# Prevent two instances from sharing a data root. Shared rate stores can interleave writes, startup
# cleanup can remove another instance's active work, and vault-backed data can be misrouted.
# Check before cleanup. A marker records the owning install, enabling first-to-boot-wins behavior
# during simultaneous starts without reading another process's environment.
_INSTANCE_MARKER = scratch.INSTANCE_MARKER   # named in scratch.py — sweep() must skip it

def _pid_is_the_instance_at(pid: int, install: str):
    """True / False / None — is `pid` a live Vocalis SERVING THE INSTALL AT `install`?

    None (cannot tell) is a distinct answer the caller must honor, never folded into True.

    It checks the install path, not just the process name. Weaker checks produce false positives,
    and a false positive prevents startup:

      * "is pid N alive" — Linux recycles pids hard. A SIGKILLed instance leaves its marker
        behind, and the number is handed out again within hours.
      * "is pid N a vocalis_server.py" — that is TRUE of this instance's own predecessor during
        a restart. `systemctl restart` overlaps the two processes if the outgoing one is slow to
        exit, so the incoming one would find a live Vocalis holding the marker and refuse to
        start. An ordinary restart would take the service down.

    Two genuinely separate instances always run from different install roots (that is what makes
    them separate); a predecessor of mine always runs from MINE. So the install path is the
    thing that actually discriminates, and matching it against the RUNNING process's argv also
    settles the recycling case — a recycled pid is not serving that install.

    Reuses foreign_engines()'s argv[0] guard: the process must BE a python, not merely mention
    one.

    Compare normalized paths by equality, never by string prefix: one install directory may be
    a prefix of another. Derive the install from the process argv path."""
    try:
        with open(f"{PROC_DIR}/{pid}/cmdline", "rb") as f:
            argv = f.read().decode("utf-8", "replace").split("\0")
    except FileNotFoundError:
        return False                      # nothing there: the marker is stale, and that is fine
    except OSError:
        return None                       # exists but unreadable — NOT evidence of anything
    if not os.path.basename(argv[0] or "").startswith("python"):
        return False
    try:
        want = Path(install).resolve()
    except OSError:
        return False
    for a in argv:
        if not a.endswith("vocalis_server.py"):
            continue
        p = Path(a)
        # A RELATIVE argv resolves against OUR cwd, not the target process's, so it would be a
        # guess. This guard exits the process; a guess is not good enough to act on.
        if not p.is_absolute():
            continue
        try:
            if p.resolve().parent.parent == want:     # <install>/src/vocalis_server.py
                return True
        except OSError:
            continue
    return False


def claim_root(root: Path, label: str):
    """Claim `root` for this process. Returns None on success, or a message naming the sibling.

    Best-effort by design: a root we cannot create or write is not a collision, it is an
    unanswerable question, and it must not stop the boot."""
    mine = str(paths.BASE_DIR.resolve())
    try:
        root.mkdir(parents=True, exist_ok=True)
        marker = root / _INSTANCE_MARKER
        if marker.is_file():
            held_pid, held_install = None, ""
            try:
                pid_s, _, install_s = marker.read_text(encoding="utf-8").strip().partition(" ")
                held_pid, held_install = int(pid_s), install_s.strip()
            except (OSError, ValueError):
                held_pid = None           # unreadable/garbage — reclaim it, do not refuse
            # A marker for this install may belong to a predecessor during restart. Only a
            # positively identified process from a different install is a collision.
            if (held_pid is not None and held_install and held_install != mine
                    and _pid_is_the_instance_at(held_pid, held_install) is True):
                return (f"{label} root {root} is already in use by the Vocalis instance at "
                        f"{held_install} (pid {held_pid}). Two instances MUST NOT share it — the "
                        f"rate stores and chunk workspaces are read-modify-write, the startup "
                        f"sweep would delete that instance's scratch, and once encryption is "
                        f"enabled this is one instance writing into another's vault root. Give "
                        f"this instance its own path (VOCALIS_CACHE_DIR / VOCALIS_SCRATCH_DIR in "
                        f"the systemd unit) and start it again.")
        marker.write_text(f"{os.getpid()} {mine}\n", encoding="utf-8")
    except OSError as exc:
        logger.debug(f"instance marker for {label} not written ({exc}) — not treated as a collision")
    return None
