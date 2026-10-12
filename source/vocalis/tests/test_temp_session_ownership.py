"""Temporary-session cleanup must remove only stale unowned directories. A live owner lock protects its session from the sweeper."""
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

import conftest


# The holder claims a lock exactly the way conftest does, announces it, and then blocks on stdin.
# Closing stdin ends it, which releases the lock through process death — the same path a crash
# takes, which is the path the whole design rests on.
_HOLDER = r"""
import sys
fh = open(sys.argv[1], "a+b")
try:
    import fcntl
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
except ImportError:
    import msvcrt
    fh.seek(0)
    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
print("LOCKED", flush=True)
sys.stdin.readline()
"""


def _dead_dir(root: Path, name: str) -> Path:
    """A session directory whose owner is gone: the lock file is there, nobody holds it."""
    d = root / name
    d.mkdir(parents=True)
    (d / conftest._LOCK_NAME).write_bytes(b"")
    (d / "profile-junk.bin").write_bytes(b"x" * 4096)
    return d


def test_a_dead_session_is_collected_at_age_zero(tmp_path, monkeypatch):
    """🔴 THE POINT OF THE REDESIGN: no waiting. The old sweep would have kept this for six hours.

    A crashed run is the common case, not the exotic one — `--timeout` kills a worker with
    `os._exit()`, and a developer hits Ctrl-C all day. Age could not distinguish those from a run
    that started thirty seconds ago, so it had to assume the worst about both.
    """
    monkeypatch.setattr(conftest, "_SESSIONS_ROOT", tmp_path)
    monkeypatch.setattr(conftest, "_MY_SESSION", None)
    d = _dead_dir(tmp_path, "s4242-abcdef")
    assert (time.time() - d.stat().st_mtime) < 5, "the fixture must be brand new for this to mean anything"

    assert conftest._owner_is_gone(d), "nobody holds this lock, so its owner is gone"
    assert conftest._sweep_dead_sessions() == 1
    assert not d.exists(), "a dead session's directory survived a sweep"


def test_a_live_session_is_left_alone_then_collected_when_it_dies(tmp_path, monkeypatch):
    """🔴 THE ARM THAT MAKES THE OTHER ONE SAFE, AND IT NEEDS A REAL PROCESS.

    Deleting a live run's temp directory is a far worse bug than leaving a dead one behind — it
    is why the six-hour window was chosen and why it was right to be conservative. The lock earns
    the right to be aggressive only if this holds.

    ⚠️ Note what is NOT mocked: a second interpreter takes a real OS lock, and the sweeper is the
    real one. `_take_lock` returning False is the entire load-bearing claim, and a fake would be
    asserting my own assumption back to me.
    """
    monkeypatch.setattr(conftest, "_SESSIONS_ROOT", tmp_path)
    monkeypatch.setattr(conftest, "_MY_SESSION", None)
    d = _dead_dir(tmp_path, "s9999-liveone")
    lock = d / conftest._LOCK_NAME

    holder = subprocess.Popen([sys.executable, "-c", _HOLDER, str(lock)],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "LOCKED", "the holder never took the lock"

        assert not conftest._owner_is_gone(d), (
            "a directory a LIVE process holds was reported as collectable - this is the bug that "
            "would delete a running suite's Chrome profile out from under it")
        assert conftest._sweep_dead_sessions() == 0
        assert d.exists() and lock.exists(), "the sweep deleted a live session's directory"
    finally:
        holder.stdin.close()                     # ends it; the OS releases the lock on exit
        holder.wait(timeout=20)

    # Same directory, same age, same everything — only the owner is gone. That difference alone
    # is what the sweeper reads, and it is a fact rather than an inference.
    assert conftest._owner_is_gone(d)
    assert conftest._sweep_dead_sessions() == 1
    assert not d.exists()


def test_a_session_dir_without_a_lock_yet_is_not_snatched(tmp_path, monkeypatch):
    """⚠️ THE RACE THE SCHEME CREATES, AND THE ONE PLACE AGE IS STILL THE RIGHT TOOL.

    `mkdtemp()` and `open(lock)` are two calls, so for a few microseconds a live session owns a
    directory with no claim in it. Sweeping on "no lock file means dead" would delete a starting
    run's directory. `_CLAIM_GRACE_S` covers the gap; the fixture below is younger than it.
    """
    monkeypatch.setattr(conftest, "_SESSIONS_ROOT", tmp_path)
    monkeypatch.setattr(conftest, "_MY_SESSION", None)
    fresh = tmp_path / "s1234-midcreation"
    fresh.mkdir()
    assert not conftest._owner_is_gone(fresh), "a session mid-creation was treated as debris"
    assert conftest._sweep_dead_sessions() == 0
    assert fresh.exists()

    # ...and abandoned debris from a run that died between the two calls does get collected.
    old = time.time() - conftest._CLAIM_GRACE_S - 60
    os.utime(fresh, (old, old))
    assert conftest._owner_is_gone(fresh)
    assert conftest._sweep_dead_sessions() == 1


def test_the_age_sweep_never_eats_the_sessions_root(tmp_path, monkeypatch):
    """🔴 THE FIX REINTRODUCING THE BUG IT FIXED. `vocalis-sessions` starts with `vocalis-`.

    Its mtime only moves when a session is created, so on a quiet box it goes stale while the
    sessions inside it are live — and `_sweep_stale_temp` would then rmtree a running suite's
    profiles, which is the exact outcome the age window exists to prevent. Two arms, because
    "nothing was deleted" would also pass on a sweeper that does nothing at all.
    """
    monkeypatch.setattr(conftest.tempfile, "gettempdir", lambda: str(tmp_path))
    old = time.time() - (conftest._SWEEP_AGE_H + 2) * 3600

    sessions = tmp_path / conftest._SESSIONS_ROOT.name
    (sessions / "s1-live").mkdir(parents=True)
    stale = tmp_path / "vocalis-cdp-whatever"
    stale.mkdir()
    for p in (sessions, stale):
        os.utime(p, (old, old))

    assert conftest._sweep_stale_temp() == 1, "the age sweep stopped collecting ordinary leftovers"
    assert not stale.exists(), "the stale profile should have gone"
    assert (sessions / "s1-live").exists(), (
        "the age sweep deleted the sessions root, taking every live session's temp dir with it")


def test_claiming_a_session_dir_yields_a_lock_no_other_process_can_take(tmp_path, monkeypatch):
    """⚠️ THE CLAIM ITSELF, SO THE SKIP BELOW CANNOT QUIETLY BECOME THE TEST.

    `test_this_very_session_...` skips when the claim did not happen, which is the right answer on
    a box whose %TEMP% is unwritable and the wrong way to find out the claim BROKE - a regression
    there would switch that test off rather than fail it. This one runs unconditionally against
    the real `_claim_session_dir`, so the end-to-end check is the only thing the skip can reach.

    📌 `_owner_is_gone` is asked about a directory THIS process holds, and both platforms refuse
    a second handle: Windows `msvcrt.locking` raises PermissionError, POSIX `flock` raises
    BlockingIOError, because a fresh `open()` is a new open file description either way. Measured
    on both Windows and POSIX; this prevents the sweeper from deleting its active owner.
    """
    monkeypatch.setattr(conftest, "_SESSIONS_ROOT", tmp_path)
    d, fh = conftest._claim_session_dir()
    assert d is not None and fh is not None, "the claim failed on a writable directory"
    try:
        assert d.parent == tmp_path and d.is_dir()
        assert (d / conftest._LOCK_NAME).exists(), "a claimed directory with no claim in it"
        assert not conftest._owner_is_gone(d), (
            "a directory THIS live process holds was reported collectable - the sweeper would "
            "delete the temp dir out from under the very run that made it")
        monkeypatch.setattr(conftest, "_MY_SESSION", None)   # drop the belt, leave the braces
        assert conftest._sweep_dead_sessions() == 0, "the lock alone must keep a live dir alive"
        assert d.exists()
    finally:
        fh.close()

    # And the moment the claim is released, the same directory is collectable at age zero.
    monkeypatch.setattr(conftest, "_MY_SESSION", None)
    assert conftest._owner_is_gone(d)
    assert conftest._sweep_dead_sessions() == 1
    assert not d.exists()

@pytest.mark.skipif(not os.environ.get("VOCALIS_SESSION_DIR"),
                    reason="this session could not claim a temp directory")
def test_this_very_session_points_its_subprocesses_at_an_owned_directory():
    """🔴 END TO END, ON THE RUN THAT IS HAPPENING RIGHT NOW.

    The 4.76 GB was Chrome profiles, and every one is made by a node spec calling `os.tmpdir()`,
    which reads TEMP/TMP (Windows) or TMPDIR. Redirecting those in conftest is what puts all 39
    specs inside an owned directory without editing 39 files — and it is invisible from any one
    spec, so nothing but this asserts it is actually in force.

    ⚠️ BOTH THE ASSERTION AND THE SKIP READ THE ENVIRONMENT, and the skip did not always. It
    was `_MY_SESSION is None and not PYTEST_XDIST_WORKER`, and a worker never claims - so on a
    box where the claim FAILED this test skipped standalone and went RED under xdist, from one
    condition, because the two processes disagree about a module global they do not share. The
    environment is the only thing they do share, and it is also exactly what a subprocess
    reads, so `VOCALIS_SESSION_DIR` is the honest thing to condition on in both places.
    """
    tmp = Path(os.environ.get("TEMP") or os.environ.get("TMPDIR") or "")
    assert tmp.parent.name == conftest._SESSIONS_ROOT.name, (
        f"subprocesses of this session would write to {tmp}, which is not inside an owned "
        f"session directory - node's os.tmpdir() lands there and nothing tracks it")
    assert (tmp / conftest._LOCK_NAME).exists(), (
        f"{tmp} has no {conftest._LOCK_NAME}, so the next run cannot tell whether it is live")
