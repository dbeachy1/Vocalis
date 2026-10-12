"""Shared fixtures and configuration for Vocalis tests."""
import getpass
import importlib
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

# Set native math-library thread limits before importing test modules. xdist already
# distributes tests across workers, so each library defaults to one thread; profiling
# runs may override these values through the environment.
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS",
           "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_v, "1")
# (nomi/src was here for the retired port-8765 nomi_server, deleted in 5.0-M2. The LIVE
#  Nomi path is src/nomi_speak.py + vocalis_server's /nomi routes — see test_nomi_admin.py.)

# Redirect cache access before test modules import. Modules keep separate imported
# bindings and some paths are captured at import time, so an autouse fixture is too late.
# Tests that need a different cache may still patch their own bindings.
_SESSION_START = __import__("time").time()
_SWEEP_AGE_H = 6
_SWEEP_PREFIX = "vocalis-"


#: Limit each startup sweep so old temporary directories cannot stall test startup.
_SWEEP_MAX = 250


# Each pytest session holds a nonblocking OS lock in its own temp directory. A startup
# sweep can remove that directory as soon as its process exits, including after a crash.
# The age sweep remains for legacy flat temp directories and standalone Node specs, which
# do not have a pytest session lock.
_SESSIONS_ROOT = Path(tempfile.gettempdir()) / "vocalis-sessions"
_LOCK_NAME = ".owner.lock"
#: The directory this session owns, and the OPEN FILE that proves it. `_MY_LOCK` is a module
#: global for one reason: closing it releases the claim, so it must outlive every function here
#: and live exactly as long as the process does.
_MY_SESSION = None
_MY_LOCK = None
#: A directory that exists without its lock file yet is a session mid-creation, not a corpse.
#: The window is microseconds; sixty seconds of grace makes that race impossible to lose.
_CLAIM_GRACE_S = 60


def _take_lock(fh) -> bool:
    """Exclusive and NON-BLOCKING. True means nobody else owns this directory.

    A byte-range lock on both platforms, so the answer comes from the OS rather than from a
    timestamp we wrote ourselves. Windows has no flock; `msvcrt.locking` takes one byte from the
    current position, and a region past EOF is legal to lock, so the file stays empty."""
    try:
        import fcntl
    except ImportError:                              # Windows
        import msvcrt
        try:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _claim_session_dir():
    """Make this session's temp directory and lock it. Returns (dir, open lock file), or
    (None, None) if anything at all goes wrong — housekeeping must never fail a run, and the
    fallback is simply the old flat behavior that the age sweep already handles."""
    try:
        _SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
        d = Path(tempfile.mkdtemp(dir=str(_SESSIONS_ROOT), prefix="s%d-" % os.getpid()))
        fh = open(d / _LOCK_NAME, "a+b")
    except OSError:
        return None, None
    if not _take_lock(fh):                           # cannot happen on a dir we just made
        fh.close()
        return None, None
    return d, fh


def _owner_is_gone(d: Path) -> bool:
    """True if no live process holds `d`. The point of the scheme is that this is a fact."""
    lock = d / _LOCK_NAME
    try:
        if not lock.exists():
            # No claim filed: either a session mid-creation, or debris from one that died
            # between mkdtemp and open(). Age tells those apart, which is all age is good for.
            import time
            return (time.time() - d.stat().st_mtime) > _CLAIM_GRACE_S
        fh = open(lock, "a+b")
    except OSError:
        return False                                 # cannot even open it -> assume live
    try:
        return _take_lock(fh)
    finally:
        fh.close()                                   # releases whatever we just took


def _sweep_dead_sessions(limit: int = _SWEEP_MAX) -> int:
    """Delete every session directory whose owner is gone. No age window, and none needed.

    Same contract as the sweeps below: never raises, never slow, best-effort."""
    import shutil
    gone = 0
    try:
        dirs = list(_SESSIONS_ROOT.iterdir())
    except OSError:
        return 0
    for d in dirs:
        if gone >= limit:
            break
        try:
            if not d.is_dir() or (_MY_SESSION is not None and d == _MY_SESSION):
                continue
            if not _owner_is_gone(d):
                continue                             # a live run owns it. Age is irrelevant.
        except OSError:
            continue
        shutil.rmtree(d, ignore_errors=True)
        if not d.exists():
            gone += 1
    return gone


def _sweep_stale_temp(limit: int = _SWEEP_MAX) -> int:
    """Remove up to `limit` of this suite's leftovers from the OS temp dir, older than
    `_SWEEP_AGE_H`. Returns how many went.

    Best-effort by construction: a directory another process still holds open just fails to
    delete and is left for the next run. Never raises — housekeeping must not be able to fail a
    test session, and it must not be able to slow one down either."""
    import shutil
    import time
    cutoff = time.time() - _SWEEP_AGE_H * 3600
    root = Path(tempfile.gettempdir())
    gone = 0
    try:
        names = list(root.iterdir())
    except OSError:
        return 0
    for d in names:
        if gone >= limit:
            break
        if not d.name.startswith(_SWEEP_PREFIX):
            continue
        # The sessions root is a container, not a temp run. Its mtime can be old while
        # locked session directories inside it are still active.
        if d.name == _SESSIONS_ROOT.name:
            continue
        try:
            if not d.is_dir() or d.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(d, ignore_errors=True)
        if not d.exists():
            gone += 1
    return gone


def _sweep_pytest_tmp(keep: int = 2) -> int:
    """Prune pytest's own retained run directories to the newest `keep` runs.

    Pytest does not retry directories that fail removal, so this bounded sweep keeps
    successful-run fixtures from accumulating while preserving the newest failures.
    """
    import shutil
    root = Path(tempfile.gettempdir()) / ("pytest-of-%s" % getpass.getuser())
    try:
        runs = [d for d in root.iterdir() if d.is_dir() and d.name.startswith("pytest-")]
    except OSError:
        return 0
    try:
        runs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
    except OSError:
        return 0
    # Retain the age guard as well as the count: an older pytest directory may belong
    # to a concurrent session that is still active.
    import time
    cutoff = time.time() - _SWEEP_AGE_H * 3600
    gone = 0
    for d in runs[keep:]:
        try:
            if d.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(d, ignore_errors=True)
        if not d.exists():
            gone += 1
    return gone


# Only the xdist controller claims a session and sweeps shared temp state; workers inherit
# its environment and must not race cleanup against one another.
if not os.environ.get("PYTEST_XDIST_WORKER"):
    _MY_SESSION, _MY_LOCK = _claim_session_dir()
    _sweep_dead_sessions()
    _sweep_stale_temp()
    _sweep_pytest_tmp()
    # Route subprocess temp files through the locked session directory. Python's
    # gettempdir() was already cached above, so pytest's own tmp_path stays under OS temp.
    if _MY_SESSION is not None:
        for _v in ("TEMP", "TMP", "TMPDIR"):
            os.environ[_v] = str(_MY_SESSION)
        # Workers do not own this module global; publish the shared session path in the
        # environment used by both workers and subprocesses.
        os.environ["VOCALIS_SESSION_DIR"] = str(_MY_SESSION)

_TEST_CACHE_DIR = tempfile.mkdtemp(prefix="vocalis-test-cache-")
os.environ["VOCALIS_CACHE_DIR"] = _TEST_CACHE_DIR

# Bulk upload staging and scratch cleanup use the install scratch root. Redirect it before
# tests import callers so no test can write to or sweep a live install's staged data.
_TEST_SCRATCH_DIR = tempfile.mkdtemp(prefix="vocalis-test-scratch-")
os.environ["VOCALIS_SCRATCH_DIR"] = _TEST_SCRATCH_DIR


import pytest


# Capture a separate faulthandler file per xdist worker at session start. Preserve an
# older file before opening the live one so a later clean run cannot erase prior evidence.
# Empty preserved files are meaningful: they distinguish external termination from a
# native fault. Clean runs remove only their own empty live file.
_CRASH_FILE = None
_CRASH_DIR = REPO_ROOT / "temp" / "crash"
_CRASH_KEEP_DAYS = 14           # preserved evidence is worth a fortnight; a killed run leaves 16


def _preserve_crash_file(path):
    """Move a leftover crash file aside, stamped with the death it recorded.

    Returns the new path, or None when there was nothing to keep. Never raises: instrumentation
    that can fail a run is worse than no instrumentation.
    """
    import time
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(path.stat().st_mtime))
    except OSError:
        return None                 # not there at all — the ordinary case, a clean previous run
    for n in range(100):
        suffix = "" if n == 0 else f".{n}"
        kept = path.with_name(f"{path.stem}-{stamp}{suffix}{path.suffix}")
        if kept.exists():
            continue                # same second, same worker: keep both rather than overwrite
        try:
            path.replace(kept)
        except OSError:
            return None
        return kept
    return None


def _prune_crash_files(d, now=None):
    """Bin preserved evidence older than _CRASH_KEEP_DAYS. Returns how many went.

    ⚠️ A PRESERVED NAME CARRIES A DASH AND A LIVE ONE DOES NOT, and both are swept — but the age
    is what makes the second one safe. A live `gw3.txt` can belong to a worker of a CONCURRENT
    suite (two runs on one box is not hypothetical; it happened while this was being written), and
    deleting one mid-run would destroy the very evidence this exists to keep. It cannot happen
    here: `--session-timeout=600` bounds a run at ten minutes, so a file whose mtime is a
    FORTNIGHT old cannot be one anybody is writing into. Without that arm a stale live-named file
    — `gw24.txt` from a `-n 32` era, sitting there since 08-17 — is reported at the end of every
    run forever, and a report that prints on every green run is one people learn to skip.
    """
    import time
    cut = (time.time() if now is None else now) - _CRASH_KEEP_DAYS * 86400
    gone = 0
    try:
        for p in d.glob("gw*.txt"):
            try:
                if p.stat().st_mtime < cut:
                    p.unlink()
                    gone += 1
            except OSError:
                pass
    except OSError:
        pass
    return gone


def _open_crash_file(d, worker, now=None):
    """This worker's crash file, with any predecessor's preserved first. The hook is this
    function plus `faulthandler.enable`, so a test can drive the whole decision without
    re-pointing the process's fault handler."""
    d.mkdir(parents=True, exist_ok=True)
    _preserve_crash_file(d / f"{worker}.txt")
    _prune_crash_files(d, now=now)
    return open(d / f"{worker}.txt", "w", buffering=1, encoding="utf-8")


def _report_crash_evidence(d):
    """🔴 SAY IT ON THE WAY OUT, on the controller, because nobody goes looking in `temp/`.

    Anything in this directory at the end of a run is a worker that did not reach its own
    clean-up: `gw3.txt` is one that died in THIS run, `gw3-<stamp>.txt` is one preserved from an
    earlier one. The old design left both entirely silent — the run printed one line naming
    whichever test was executing, and the file that could have explained it sat unread until the
    next run overwrote it.
    """
    try:
        left = sorted(p for p in d.glob("gw*.txt"))
    except OSError:
        return
    if not left:
        return
    try:
        where = d.relative_to(REPO_ROOT)
    except ValueError:
        where = d               # a test drives this against tmp_path; never let display raise
    print(f"[crash] {len(left)} crash-evidence file(s) in {where} — "
          f"a worker died and this is what it left:")
    for pth in left[:20]:
        try:
            size = pth.stat().st_size
        except OSError:
            continue
        why = ("  (EMPTY = killed from outside, NOT a fault — see conftest's crash block)"
               if size == 0 else "  (a C-level traceback, per thread)")
        print(f"[crash]   {pth.name} — {size} bytes{why}")


def pytest_sessionstart(session):
    global _CRASH_FILE
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    if not worker:
        return                      # a serial run keeps stderr, where it is visible already
    try:
        import faulthandler
        _CRASH_FILE = _open_crash_file(_CRASH_DIR, worker)
        faulthandler.enable(file=_CRASH_FILE, all_threads=True)
        _record_deliberate_exits(_CRASH_FILE)
    except Exception:               # instrumentation must never be able to fail a run
        _CRASH_FILE = None


def _record_deliberate_exits(crash_file) -> None:
    """Make `os._exit()` say who called it, in this worker's crash file, before it exits.

    An EMPTY crash file has meant "the worker vanished and nothing recorded why" seven times
    (2026-10-10 18:37, five on 2026-10-12 morning, and 2026-10-12 16:06 in a full run that lost
    gw7 during `test_soundfile_io`, with no Windows crash event for it either). faulthandler only
    writes on a native fault. The two ways a worker can end itself without one are pytest-timeout's
    thread method and product code that exits on purpose (`/engine/restart` does); both go through
    `os._exit`. After this, an empty file can only mean the process was ended from OUTSIDE.

    A clean run is unaffected: `pytest_sessionfinish` closes the file first, the write below then
    fails, and the exit goes ahead."""
    import traceback
    real_exit = os._exit

    def exit_with_evidence(code=0):
        try:
            crash_file.write(f"os._exit({code}) called by thread {threading.current_thread().name}:\n")
            traceback.print_stack(file=crash_file)
            crash_file.flush()
        except Exception:
            pass
        real_exit(code)

    os._exit = exit_with_evidence


def _report_leftover_temp() -> None:
    """Count Vocalis test temp directories remaining after this session.

    Startup cleanup handles leftovers from interrupted runs; this report shows what the
    current run leaves behind. It inspects names only, never file contents.
    """
    if os.environ.get("PYTEST_XDIST_WORKER"):
        return                                  # the controller speaks for the whole session
    # Exclude the sessions container itself; report only per-session directories created
    # during this run.
    try:
        root = Path(tempfile.gettempdir())
        left = sorted(d.name for d in root.iterdir()
                      if d.name.startswith(_SWEEP_PREFIX) and d.is_dir()
                      and d.name != _SESSIONS_ROOT.name
                      and d.stat().st_mtime >= _SESSION_START)
    except OSError:
        return
    # Everything a node spec failed to remove lands here, because TEMP points at it. Unlike the
    # count above, this one is not a warning: it is collected on the way out, and collected at
    # age zero by the next run if this run is killed before it gets there.
    mine = []
    if _MY_SESSION is not None:
        try:
            mine = [p.name for p in _MY_SESSION.iterdir() if p.name != _LOCK_NAME]
        except OSError:
            mine = []
    if left:
        print("\n[temp] %d unowned vocalis-* temp dir(s) left from this session: %s%s"
              % (len(left), ', '.join(left[:6]), ' ...' if len(left) > 6 else ''))
    else:
        print("\n[temp] clean - no unowned vocalis-* temp dirs left from this session.")
    if mine:
        print("[temp] %d item(s) in this session's own dir, collected on exit (%s%s)"
              % (len(mine), ', '.join(sorted(mine)[:4]), ' ...' if len(mine) > 4 else ''))


def _release_session_dir() -> None:
    """Drop the claim and bin this session's directory on the way out.

    ⚠️ THIS IS THE OPTIONAL HALF, AND SAYING SO IS THE POINT. Everything above is built on the
    assumption that this never runs — a killed run, a crashed worker, a `--timeout` kill and a
    power cut all skip it, and those are the runs a developer actually produces. It is here so
    the common case tidies up at once instead of waiting for the next session to notice; when it
    is skipped, the next `_sweep_dead_sessions()` collects the directory at age zero anyway.
    Never raises."""
    global _MY_LOCK
    if os.environ.get("PYTEST_XDIST_WORKER"):
        return                                       # the controller owns the claim
    try:
        if _MY_LOCK is not None:
            _MY_LOCK.close()                         # releases the byte-range lock
            _MY_LOCK = None
        if _MY_SESSION is not None:
            shutil.rmtree(_MY_SESSION, ignore_errors=True)
    except Exception:
        pass


def pytest_sessionfinish(session, exitstatus):
    """Bin the throwaway cache and scratch, then SAY whether anything was left behind.
    Best-effort — a leaked temp dir is litter, not a failure, and it must never be able to turn
    a green run red."""
    shutil.rmtree(_TEST_CACHE_DIR, ignore_errors=True)
    shutil.rmtree(_TEST_SCRATCH_DIR, ignore_errors=True)
    _report_leftover_temp()
    # Take loguru's sinks away before pytest closes the stream they write to. A request thread of
    # the last browser test's server can still be inside a 2 s probe of an ACE-Step that is not
    # there (a refused connection takes that long on Windows); it then logged into the closed
    # stream, and each worker ended a green run with "Logging error in Loguru Handler ...
    # ValueError: I/O operation on closed file" (six of them in a full run, 2026-10-12). Nothing
    # is being tested any more at this point, so there is nothing left for a log line to say.
    from loguru import logger
    logger.remove()             # with no argument this removes every sink and cannot raise
    if not os.environ.get("PYTEST_XDIST_WORKER"):
        # The controller runs last and speaks for the whole session, so this sees every file the
        # workers left — including the one belonging to a worker that died in this very run.
        _report_crash_evidence(_CRASH_DIR)
    _release_session_dir()
    if _CRASH_FILE is not None:
        # Reaching here means this worker exited normally, so nothing was written. Point the
        # handler back at stderr before closing the file under it — faulthandler holds the fd,
        # and a crash during interpreter shutdown would otherwise write into a closed one.
        try:
            import faulthandler
            faulthandler.enable(file=sys.stderr, all_threads=True)
            path = Path(_CRASH_FILE.name)
            _CRASH_FILE.close()
            if path.exists() and path.stat().st_size == 0:
                path.unlink()
        except Exception:
            pass


def make_fake_pool(n_workers=2, device="cpu"):
    """A WorkerPool with fake workers/models — no GPU, no real model load.
    Shared by test_pool.py and test_streaming.py (keep the single copy here)."""
    import threading
    from tts_utils import WorkerPool
    pool = WorkerPool.__new__(WorkerPool)
    pool.devices = [device]
    pool.workers = [{"id": i, "device": device} for i in range(n_workers)]
    pool._models = {i: object() for i in range(n_workers)}
    pool.sr      = 24000
    pool._lock   = threading.Lock()      # guards worker-drop mutation
    pool.poisoned = False
    pool._init_pool_state()              # shared-queue runtime state (workers start lazily)
    return pool


def mp3_packet_length_s(path) -> float:
    """What an MP3 contributes to a stream-copy join, counted a DIFFERENT way from
    `mp3_concat.contributed_s` (which sums per-packet `duration_time`): packet count x samples a
    frame / sample rate, with 1152 samples a frame for MPEG-1 (32 kHz and up) and 576 for
    MPEG-2 (24 kHz and down). Independent on purpose, so a test that compares the two proves
    the helper rather than restating it. Same for every ffmpeg build — gapless trimming never
    touches packet counts — which is what lets the offset tests pass on the old Windows
    ffmpeg and the image's 8.0.1 alike."""
    import subprocess
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets,sample_rate", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True)
    # csv field order follows ffprobe's own (sample_rate, nb_read_packets), not the request's.
    rate, packets = (int(x) for x in r.stdout.strip().split(","))
    return packets * (1152 if rate >= 32000 else 576) / rate


@pytest.fixture(autouse=True)
def _no_measured_rates_from_another_test():
    """The streaming governor's per-device rates are measured from live renders and held in a
    module-level store keyed on device name (5.3-m4). Every fake pool in this suite uses "cpu",
    so without this one test's fake 5x-realtime render sets the floor for the next test's
    governor assertion — which is a cross-test dependency that only shows up as a flake, and
    depends on thread timing at that. Reset before AND after, so a test that seeds rates
    deliberately still starts from a known state.
    """
    from vocalis_streaming import reset_rates
    reset_rates()
    yield
    reset_rates()


@pytest.fixture(autouse=True)
def _loguru_to_stdout():
    """Route loguru output to the live sys.stdout so pytest's capsys (which
    captures stdout) sees log messages. The sink is a callable resolving
    sys.stdout at write time, so it follows capsys's per-test replacement.
    Format is bare {message} so existing substring assertions still match."""
    import sys
    from loguru import logger
    sink_id = logger.add(lambda m: sys.stdout.write(m), format="{message}", level="DEBUG")
    yield
    try:
        logger.remove(sink_id)
    except ValueError:
        pass


@pytest.fixture(autouse=True)
def _no_local_kobold_unless_asked(monkeypatch):
    """Disable local Kobold conflict checks unless a test explicitly opts in.

    A remote or absent configuration must not trigger host service discovery. Tests that
    exercise the conflict response patch the configuration they need.
    """
    wk = sys.modules.get("vocalis.web.kobold")
    kob = sys.modules.get("kobold")
    if wk is not None and kob is not None:
        monkeypatch.setattr(wk, "_kobold_cfg",
                            lambda: kob.KoboldConfig(url="", adminpassword="", local=False))
    yield


@pytest.fixture(autouse=True)
def _no_enhance_unless_asked(monkeypatch):
    """Keep optional enhancement disabled unless a test explicitly enables it.

    Hardware-dependent defaults can launch heavyweight subprocesses and make results vary
    between environments.
    """
    # Patch only when already imported: importing the module here would load Torch and Flask
    # for unrelated unit tests. Tests using a blueprint without the server still get the gate.
    mod = sys.modules.get("vocalis.runtime.enhancement")
    if mod is not None:
        monkeypatch.setattr(mod, "enhance_available", lambda: False)


@pytest.fixture(autouse=True)
def _no_nvml_unless_asked(request, monkeypatch):
    """The NVIDIA driver library (`pynvml`) is unavailable in every test unless the test opts in.

    October 10, 2026. `tts_utils.vram_used_total`, the NVIDIA sensor readers and the satellite's
    free-memory decisions now consult NVML through `vocalis_satellite_gpustats`. On a machine
    with `nvidia-ml-py` and a real card that would make tests such as
    `test_gpu_fan.py::test_no_hwmon_dir_at_all_is_none` or
    `test_server.py::test_gpu_sensors_convert_units_and_survive_missing_files` read live driver
    values and fail, where on a machine without them they pass. Putting `None` in `sys.modules`
    makes `import pynvml` raise ImportError, which is exactly the "package not installed" state
    those tests were written against.

    HOW A TEST OPTS BACK IN:
      * with a stand-in (what the unit tests do): `monkeypatch.setitem(sys.modules, "pynvml",
        fake_nvml)`. It runs after this fixture, so it simply replaces the block for that test.
      * with the genuine package, for a live check on a card: `@pytest.mark.real_nvml`.

    The readout module also remembers a failed start and a failed card mapping for a minute, and
    keeps once-only log sets; and the satellite's batch module keeps the whole-card reader it was
    settled on and its own once-only sets. All of it is reset here for every test (restored
    afterwards), so a test's result never depends on which test ran before it. Only modules that
    are already imported are touched: one imported later starts clean anyway.
    """
    gs = sys.modules.get("vocalis_satellite_gpustats")
    if gs is not None:
        for name, fresh in (("_NVML", None), ("_NVML_UNAVAILABLE_LOGGED", False),
                            ("_NVML_RETRY_AT", None), ("_MAPPING", None),
                            ("_MAPPING_RETRY_AT", None), ("_MAPPING_FAILURE_LOGGED", False),
                            ("_MAPPING_FALLBACK_LOGGED", set()), ("_HANDLE_WARNED", set()),
                            ("_CARD_ACTIVE_LOGGED", set()), ("_CARD_CACHE", {}),
                            ("_FIELD_WARNED", set()), ("_MCLK_DIVISOR", {}),
                            ("_CARD_READERS", None), ("_READER_WARNED", set()),
                            ("_READER_NAMES", {})):
            if hasattr(gs, name):
                monkeypatch.setattr(gs, name, fresh)
    batch = sys.modules.get("vocalis_satellite_batch")
    if batch is not None and hasattr(batch, "_WHOLE_CARD"):
        monkeypatch.setitem(batch._WHOLE_CARD, "fn", None)
        monkeypatch.setitem(batch._WHOLE_CARD, "source", batch._WHOLE_CARD_STANDALONE)
        monkeypatch.setattr(batch, "_WHOLE_CARD_WARNED", set())
        monkeypatch.setattr(batch, "_CAP_LOGGED_GB", {})
        monkeypatch.setattr(batch, "_CAP_WARNED", set())
    tu = sys.modules.get("tts_utils")
    if tu is not None and hasattr(tu, "_NVML_CALL_WARNED"):
        monkeypatch.setattr(tu, "_NVML_CALL_WARNED", False)
    if request.node.get_closest_marker("real_nvml") is not None:
        yield
        return
    monkeypatch.setitem(sys.modules, "pynvml", None)
    yield


def _neutralize_integrated_gpu_probe():
    """Keep `hide_integrated_rocm_gpus` from running for real in the suite (October 10, 2026).

    Both servers call it at IMPORT time, before they import PyTorch. On an AMD Linux machine the
    real helper spawns a PyTorch child to classify the cards and may leave HIP_VISIBLE_DEVICES set
    in the test process, for every test that imports a server. So the module the servers import it
    from is loaded here, before any test module, with that one function replaced by one that
    decides "nothing to hide". The tests that exercise the real function with fakes
    (test_rocm_backend_startup.py) load their own copy of the helper file by path, which this does
    not touch; the real function stays reachable as `hide_integrated_rocm_gpus_real` on the
    module for any test that wants it.
    """
    mod = sys.modules.get("vocalis_torch_backend")
    if mod is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "vocalis_torch_backend", REPO_ROOT / "satellite" / "vocalis_torch_backend.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["vocalis_torch_backend"] = mod
        spec.loader.exec_module(mod)
    if not hasattr(mod, "hide_integrated_rocm_gpus_real"):
        mod.hide_integrated_rocm_gpus_real = mod.hide_integrated_rocm_gpus
        mod.hide_integrated_rocm_gpus = lambda *a, **k: {
            "action": "none", "reason": "not probed in the test suite"}


_neutralize_integrated_gpu_probe()


@pytest.fixture(autouse=True)
def _a_vault_never_leaks_out_of_the_test_that_built_it():
    """🔴 A VAULT IS PROCESS-WIDE, AND `monkeypatch` CANNOT RELIABLY PUT IT BACK.

    `vault_store.STORE` is a module GLOBAL, and `vault_store.configure()` ASSIGNS IT ITSELF. So
    the natural-looking fixture

        s = vault_store.configure(...)                     # STORE is already `s` after this line
        monkeypatch.setattr(vault_store, "STORE", s)       # ...so it records `s` as the ORIGINAL

    records `s` as the value to restore, and faithfully restores `s` on teardown — leaving an
    initialized, unlocked vault installed for every test in every file that runs afterward.
    Three fixtures were written that way (test_m6_e2e, test_m6_identity, test_m6_router), and one
    of them even says "configure() already set it; be explicit", which is the exact misreading.

    It cost nothing for as long as `route()` was the only thing that consulted STORE: no other
    test uses a path under the leaked tmp_path, so every lookup returned None anyway. Then M7 added
    the second consumer — `voicetrain.workspace_required()` asks `STORE.is_initialized()` — and six
    training tests in a file with no vault in it began refusing to launch, with an error about
    encrypted volumes. The bug was three files away and eight months old.

    So the class is closed HERE instead of being fixed three times: whatever STORE was before a
    test, it is again afterward. `sys.modules.get` rather than `import`, for the same reason
    `_no_enhance_unless_asked` does it — importing vault_store drags `cryptography` into every
    chunker unit test.
    """
    mod = sys.modules.get("vault_store")
    if mod is None:
        yield
        return
    before = mod.STORE
    yield
    mod.STORE = before


@pytest.fixture(autouse=True)
def _no_stale_strip_sample_between_tests():
    """🔴 `gpu._STRIP` IS A PROCESS-WIDE CACHE, AND TEN TEST FILES RESET IT BY HAND.

    `strip_sample()` holds one sample for `_STRIP_TTL` and shares it across every reader — that is
    the point of it, and it is right in production. In a suite it means a test that stubs
    `gpu_stats` and asks for a sample can be served the PREVIOUS test's fake instead of its own.

    ⚠️ THE HAND-RESETS ARE THE EVIDENCE, NOT THE FIX. Ten files carry
    `gpu_mod._STRIP.update(t=0.0, v=None)`, four of them with the comment *"no stale sample from
    another test"* — the hazard is known and has been handled one file at a time by convention, so
    a file that forgets the line inherits the residue silently. That is exactly the shape of the
    leaked-job flake fixed in `dedb016`: a real hazard, a real remedy, applied per-site instead of
    once. `test_server.py` had likewise drained ONE of the three job registries for years.

    📌 The existing per-file resets are left alone. They are now belt-and-braces rather than the
    only thing standing between a strip assertion and the previous test's numbers, and deleting
    ten lines to prove a point is churn with a nonzero chance of disturbing an ordering somebody
    relied on.
    """
    m = sys.modules.get("vocalis.runtime.gpu")
    # Only if it is ALREADY imported — importing it here would drag the GPU runtime into unit
    # tests that deliberately never touch it.
    if m is not None and isinstance(getattr(m, "_STRIP", None), dict):
        m._STRIP.update(t=0.0, v=None)
    yield


def job_registry_modules():
    """Every ALREADY-IMPORTED module of ours that owns a job registry, found by SIGNATURE.

    🔴 NOT A LIST OF NAMES, AND THAT IS THE POINT. This fixture used to recite three modules —
    `voiceswap`, `voicetrain`, `vocalis.runtime.jobs` — and the tree has eight. The residual
    browser flake that survived `dedb016` was `stemsplit.JOBS`: `ssResume()` polls `/stems/jobs`
    and then calls `switchTab('voicestudio')`, so one leaked split sends every later spec off its
    own tab and every rect it measures is 0x0. A recited list goes stale the next time someone
    adds a queue; the house signature does not.

    The signature is `JOBS` (a dict) with a `JOBS_LOCK` beside it, which every registry in this
    tree follows. Restricted to modules whose `__file__` is inside the repo, so a third-party
    module that happens to export `JOBS` is never touched.

    ⚠️ ALREADY-IMPORTED ONLY. Importing them here would drag the whole runtime into unit tests
    that deliberately never touch it — which is why test_job_registries.py imports the candidates
    itself rather than trusting whatever a given test happened to load.
    """
    found = []
    for m in list(sys.modules.values()):
        if m is None:
            continue
        try:
            jobs = getattr(m, "JOBS", None)
            if not isinstance(jobs, dict) or getattr(m, "JOBS_LOCK", None) is None:
                continue
            f = getattr(m, "__file__", None) or ""
        except Exception:
            continue
        if f and str(Path(f).resolve()).startswith(str(Path(REPO_ROOT).resolve())):
            found.append(m)
    return found


@pytest.fixture(autouse=True)
def _no_job_leaks_between_tests():
    """🔴 THE JOB REGISTRIES ARE MODULE-LEVEL DICTS, SO THEY OUTLIVE THE TEST THAT FILLED THEM.

    They are process-wide, and every xdist worker runs many tests in one process. A job left
    behind by one test is visible to every later test in that worker — including the browser
    specs, which load the WHOLE page.

    ⚠️ AND THE PAGE ACTS ON IT AT BOOT. `vsResume()`/`ssResume()` ask `/voiceswap/jobs`, and if
    anything is queued or running they reattach and call `switchTab('voicestudio')` — deliberately;
    main.js's own note says *"they STEAL THE TAB"*. So a leftover job makes a later spec load a page
    that navigates away from the tab the spec just opened, and every geometry check after that
    measures a panel inside a `display:none` section, where every rect is 0x0.

    🔴 THAT IS THE "GREEN IN ISOLATION, RED IN THE FULL SUITE" FLAKE, and it cost three sessions
    before a diagnostic printed `activeTab: voicestudio` while the spec was on Clips. It never was
    a timeout; the wait was correct and the thing it waited for had been navigated away from.

    📌 Cleared BEFORE each test, not after, so it also protects against whatever ran before this
    fixture existed — and so a test that deliberately leaves a job for its own later assertions is
    unaffected within its own body.
    """
    for m in job_registry_modules():
        m.JOBS.clear()
    yield


@pytest.fixture(autouse=True)
def _voice_settings_off_the_host(monkeypatch, tmp_path):
    """VOICE_SETTINGS points at a throwaway file for every test.

    THE SUITE MUST NOT WRITE THE HOST. VOICE_SAMPLES was already patched per-test wherever it
    mattered, but VOICE_SETTINGS — the repo-root voice_settings.yaml — was not, and it only
    stayed clean because nothing on the write path touched it. 4.8-m3 changed that: the label
    became a voice's IDENTITY, so every save now records one, and a test that saves a voice
    would otherwise scribble labels into the developer's real settings file (or, on remote host, into
    the live server's).

    Pinned here rather than in each test for the same reason enhance is (above): a test's
    behavior should be a property of the test, not of which file happened to be lying next to
    it. Tests that want to inspect the file still monkeypatch it themselves — they run after
    this and win.
    """
    # 5.1-P3.5: gated on the module that OWNS the constant, not on vocalis_server. Left keyed
    # on the server it would have kept firing for exactly the same set of tests today, and
    # silently stopped covering the first unit test that imports `paths` without it.
    p = sys.modules.get("vocalis.runtime.paths")
    if p is not None:
        monkeypatch.setattr(p, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")


@pytest.fixture(autouse=True)
def _the_rest_of_the_install_root_off_the_host(monkeypatch):
    """Pin install-root paths and derived state to a throwaway root for each test.

    Application settings, admin credentials, and vault state may be captured during module
    import, before fixtures run. Repoint both paths and their derived globals; configure the
    vault store against the temporary root, then let the outer vault fixture restore it.
    Create expected directories so code can safely enumerate an empty install. Tests that
    need another root may override these values themselves.
    """
    mod = sys.modules.get("vocalis_server")
    st = sys.modules.get("vocalis.runtime.settings")
    # Import the side-effect-free paths and settings modules so tests stay isolated when
    # run alone. Keep the server and auth modules lazy because importing them creates the
    # app or captures vault state.
    for _lazy in ("vocalis.runtime.paths", "vocalis.runtime.settings"):
        if _lazy not in sys.modules:
            try:
                importlib.import_module(_lazy)
            except ImportError:
                pass          # a suite that cannot import it has nothing to pin anyway
    pth = sys.modules.get("vocalis.runtime.paths")
    st = st or sys.modules.get("vocalis.runtime.settings")
    # Auth owns the vault and admin credential bindings; patch that module directly so
    # tests cannot read or write host state through a stale server alias.
    au = sys.modules.get("vocalis.runtime.auth")
    if mod is None and st is None and pth is None and au is None:
        yield
        return
    root = Path(tempfile.mkdtemp(prefix="vocalis-test-install-"))
    try:
        yield from _pin_install_root(monkeypatch, mod, st, pth, au, root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _pin_install_root(monkeypatch, mod, st, pth, au, root):
    for name in ("voice_samples", "books"):
        (root / name).mkdir(parents=True, exist_ok=True)
    if st is not None:
        monkeypatch.setattr(st, "APP_SETTINGS", root / "app_settings.yaml")
    if pth is not None:
        monkeypatch.setattr(pth, "DATA_DIR", root)
        monkeypatch.setattr(pth, "LOG_DIR", root / "logs")
        monkeypatch.setattr(pth, "SCRATCH_DIR", root / "work" / "scratch")
        monkeypatch.setattr(pth, "BULK_DIR", root / "work" / "scratch" / "bulk")
        monkeypatch.setattr(pth, "VOICE_SAMPLES", root / "voice_samples")
        monkeypatch.setattr(pth, "BOOKS_DIR", root / "books")
        monkeypatch.setattr(pth, "UI_STATE", root / "ui_state.yaml")
        # Voice settings also persist the KoboldCpp admin password, so keep them under
        # the temporary install root.
        monkeypatch.setattr(pth, "VOICE_SETTINGS", root / "voice_settings.yaml")
        # The editor store can contain complete lorebooks; keep it isolated with other
        # install-root data.
        monkeypatch.setattr(pth, "WBEDIT_DIR", root / "wbedit")
        # Keep append-only audition candidates in the test root so tests do not accumulate generated files in the install library.
        monkeypatch.setattr(pth, "VOICE_CANDIDATES", root / "voice_candidates")
        # Voice templates can contain user-written prose; redirect the store to the isolated test root.
        monkeypatch.setattr(pth, "VOICE_TEMPLATES", root / "voice_templates.json")
        # Song templates can contain lyrics; redirect the store to the isolated test root.
        monkeypatch.setattr(pth, "ACE_TEMPLATES", root / "ace_templates.json")
        # Folder assignments cover multiple listing and rename paths, so tests must write only to the isolated test root.
        monkeypatch.setattr(pth, "FOLDERS", root / "folders.yaml")
        # Enumerate DATA_DIR-rooted state paths so newly added stores remain isolated.
        # CLIP_FAVORITES and SCENE_ENHANCE_QUEUE are read-modify-write stores, and the audio directories hold generated files; tests must point each at the isolated test root.
        monkeypatch.setattr(pth, "CLIP_FAVORITES", root / "clip_favorites.yaml")
        # 11.2.7: the server-side enhancement queue — a read-modify-WRITE store like the stars.
        monkeypatch.setattr(pth, "SCENE_ENHANCE_QUEUE", root / "scene_enhance_queue.yaml")
        monkeypatch.setattr(pth, "ACE_CANDIDATES", root / "ace_candidates.json")
        monkeypatch.setattr(pth, "ACE_LIBRARY", root / "ace_library.json")
        monkeypatch.setattr(pth, "ACE_LIBRARY_AUDIO", root / "ace_library")
        # 9.0-m1 — LoRA Studio. `LORA_DATASETS` is a DIRECTORY of curated images, so it is
        # pinned for the same reason `ACE_LIBRARY_AUDIO` above is: unpinned, a Build in a
        # spec writes into the developer's real install and the test passes exactly once.
        monkeypatch.setattr(pth, "LORA_SUBJECTS", root / "lora_subjects.json")
        monkeypatch.setattr(pth, "LORA_DATASETS", root / "lora_datasets")
        monkeypatch.setattr(pth, "LORA_PROMPT_TEMPLATES", root / "lora_prompt_templates.json")
        monkeypatch.setattr(pth, "LORA_FACES", root / "lora_faces")
        monkeypatch.setattr(pth, "LORA_GENERATED", root / "lora_generated")
        monkeypatch.setattr(pth, "LORA_TRAINING", root / "lora_training")
        monkeypatch.setattr(pth, "LORA_FACE_CANDIDATES", root / "lora_face_candidates")
        monkeypatch.setattr(pth, "LORA_TESTS", root / "lora_tests")
        monkeypatch.setattr(pth, "PRODUCTIONS", root / "productions.json")
        monkeypatch.setattr(pth, "PRODUCTION_ASSETS", root / "productions")
    if au is None:
        if mod is not None:
            monkeypatch.setattr(mod.app, "secret_key", os.urandom(32))
        yield
        return
    monkeypatch.setattr(au, "VAULT_KEYFILE", root / "vault_keys.yaml")
    # The path AND the store import time already built from it (see above). NOT
    # monkeypatch.setattr around configure() — that records the value configure()
    # itself just assigned as the "original"; the fixture above owns the restore.
    vs = sys.modules.get("vault_store")
    if vs is not None:
        from tts_utils import cache_root
        store = vs.configure([("install", root), ("cache", cache_root())],
                             root / "vault_keys.yaml")
        # configure() updates vault_store.STORE, while auth keeps its own imported
        # binding for lock checks and routes. Patch both to use the temporary vault.
        monkeypatch.setattr(au, "STORE", store)
    # The path AND everything import time already derived from it (see above).
    monkeypatch.setattr(au, "ADMIN_CREDS_FILE", root / "admin_credentials.yaml")
    monkeypatch.setattr(au, "ADMIN_USER", "admin")
    monkeypatch.setattr(au, "_ADMIN_HASH", "")
    monkeypatch.setattr(au, "_CREDS_BROKEN", False)
    if mod is not None:
        monkeypatch.setattr(mod.app, "secret_key", os.urandom(32))
    yield


@pytest.fixture(autouse=True)
def _no_satellite_reconcile_outlives_its_test():
    """🔴 A TEST MUST NOT STILL BE RUNNING WHEN THE NEXT ONE STARTS.

    `PUT /devices` reconciles the satellites **off the request thread** — that is the feature
    (`web/ui.py`: a replica load is ~9 s and an unreachable satellite costs a connect timeout,
    neither of which a Save should wait for). The thread is a `daemon`, spawned per request and
    never joined, so `client.put(...)` returning does not mean it has finished. **It outlives
    the test that started it.**

    That is not merely untidy, because `_reconcile_satellites` **holds the GPU gate across the
    whole reconcile** and the next test's reconcile takes it with `GPUS.acquire(timeout=0.1)`.
    A leaked thread therefore makes the NEXT test take the "a render holds the cards" early
    return — its own monkeypatched `reconcile` is never called, and it fails claiming the thing
    it asked for never reached the satellite.

    ⚠️ **The leaked thread is slow for a reason that has nothing to do with the code under test:**
    every satellite fixture in the suite points at `https://<REMOTE_HOST>:7880`, and `<REMOTE_HOST>` does
    not resolve here, so `apply_plan` blocks in a real `getaddrinfo` before failing with
    `[Errno 11001]`. Whether that lookup outlasts 100 ms is a property of the DEVELOPER'S DNS,
    which is how a suite ends up green on one box and red on another over nothing.

    📌 **This is what the "green in isolation" tell looks like.** On  a full run failed
    `test_unticking_the_last_card_still_releases_the_satellite`, and the same file passed 48/48 on
    its own seconds later. The proof it was a leak and not that test's own doing is in its captured
    output: the test stubs `reconcile` with a function that touches no network, yet its capture
    window contains a real `apply_plan` dial to `<REMOTE_HOST>`. **A stub cannot emit that line** — it
    belonged to a different test whose thread was still running.

    Joining at teardown rather than making the fixture's own DNS faster, because the thread is the
    thing that leaks: any future test that PUTs a satellite row inherits the fix for free. Bounded,
    so a genuinely wedged reconcile fails its own test rather than hanging the suite.
    """
    import threading
    yield
    for t in threading.enumerate():
        if t.name == "satellite-reconcile" and t.is_alive():
            t.join(timeout=10)


def pytest_addoption(parser):
    parser.addoption(
        "--gpu", action="store_true", default=False,
        help="Force the GPU integration tests on, even with no card detected"
    )
    parser.addoption(
        "--no-gpu", action="store_true", default=False,
        help="Force the GPU integration tests off on a box that has a card"
    )
    # The live-model harness is opt-in because it needs a separately started local service and
    # can compete for accelerator resources. It verifies that edits preserve the requested text,
    # which unit tests cannot establish. For a loopback-only remote service, use SSH forwarding.
    parser.addoption(
        "--live-llm", action="store", default="", metavar="URL",
        help="Run the wbedit live-model tests against this KoboldCpp (e.g. https://127.0.0.1:5001)"
    )
    # Live credentials come from VOCALIS_LIVE_LLM_KEY or --live-llm-key; never commit a
    # default token. Unset remains empty so the live request fails with an authentication error.
    parser.addoption(
        "--live-llm-key", action="store",
        default=os.environ.get("VOCALIS_LIVE_LLM_KEY", ""), metavar="KEY",
        help="Bearer token for --live-llm (default: $VOCALIS_LIVE_LLM_KEY, else empty)"
    )


#: The whole `--live-llm` run, when it is asked for. 🔴 THE SUITE'S OWN `--session-timeout=150`
#: BOUNDS A ~95 s RUN OF UNIT TESTS and is right for that; the live harness is 17 tests against a
#: 106B model at tens of seconds per field, so under it the session ceiling fires long before the
#: harness finishes and the run is killed mid-evidence. An hour is generous against a measured
#: ~10 minutes and still bounds a wedge, which is the property that must not be given up.
_LIVE_SESSION_TIMEOUT_S = 3600.0


#: 🔴 THE WHOLE-TREE TRIPWIRES — `pytest -m gates`, and it is the run to do BEFORE a full suite.
#:
#: These four files do not test a feature. They assert invariants over the ENTIRE repository: the
#: suppression ratchets scan every source file, the byte scanner scans every source file, the line
#: ending check asks git what a fresh checkout would produce, and the extension stamp pins a
#: constant against `VERSION`. That makes them the only tests in this suite that a TARGETED run can
#: never include — they are not "about" the file you changed, so nothing you would think to select
#: contains them.
#:
#: 🔴 AND THAT IS PRECISELY WHY THEY KEEP BEING FOUND BY THE SLOWEST ROUTE AVAILABLE. Measured
#:  on a two-line change: the targeted specs ran green, the full suite (224s) came back
#: red on the extension stamp, and a later full suite (223s) came back red on the suppression
#: ratchet. **Both are in this list, and together they run in 14 seconds.** Two four-minute runs
#: bought what one fourteen-second run says outright.
#:
#: The sequence this exists to make cheap:
#:
#:     python -m pytest --no-gpu -m gates          # ~14s, the tripwires
#:     python -m pytest --no-gpu tests/test_x.py   # what you actually changed
#:     python -m pytest --no-gpu                   # ONCE, before the deploy
#:
#: ⚠️ MEMBERSHIP IS AUDITED, NOT TRUSTED. A registry nobody maintains is worse than none — see
#: `test_every_whole_tree_scanner_is_registered_as_a_gate` in test_webui_types.py, which greps for
#: the tree-walking idioms and fails if a file grew one without landing here.
#: 📌 `test_server_starts.py` reads `VERSION` too and is deliberately OUT: it boots the real server
#: in a subprocess, which is a smoke test rather than a static invariant, and it is slow.
GATE_FILES = frozenset({
    "test_ext_build_stamp.py",
    "test_source_bytes.py",
    "test_webui_size.py",
    "test_webui_types.py",
    # 10.22 — its `create_app()` census now lists files with `git ls-files` (so the gitignored
    # `.codex/worktrees/*` checkouts inside the repo are not counted as eight call sites), which
    # makes it a whole-tree scanner like the four above.
    "test_app_factory.py",
})


def pytest_collection_modifyitems(config, items):
    """Mark every test in `GATE_FILES` with `gates`, so the list lives in ONE place.

    ⚠️ A module-level `pytestmark` in each file would work and would drift: four files, four places
    to forget, and nothing that notices a fifth scanner appearing. Marking by filename here keeps
    the membership question answerable by reading one tuple.
    """
    for item in items:
        if Path(str(item.fspath)).name in GATE_FILES:
            item.add_marker(pytest.mark.gates)


def pytest_configure(config):
    """Lift the run-wide ceilings for `--live-llm`, and ONLY for it.

    `pytest.ini`'s ceilings and this live harness need different time budgets. `--timeout=60
    --session-timeout=150` are correct for the unit suite
    and impossible for `test_wbedit_live.py`, whose backend alone carries `timeout=900.0`. Because
    the live file is skipped by default, nothing ever executed the combination and the harness
    looked healthy while being unable to pass.

    The per-test half is fixed in the file itself (a `pytestmark` beats the command line). The
    session half cannot be — there is no per-file session ceiling — so it is lifted here, gated on
    the opt-in flag. **An ordinary run does not reach the branch below**, and the 150 s bound that
    makes a wedged run end by itself is untouched.

    ⚠️ Only ever RAISES. A run that explicitly asked for something larger keeps it.
    """
    config.addinivalue_line(
        "markers", "real_nvml: use the genuine pynvml (needs a card); see _no_nvml_unless_asked")
    if not config.getoption("--live-llm", default=""):
        return
    current = config.getoption("session_timeout", default=None)
    if current is None or current < _LIVE_SESSION_TIMEOUT_S:
        config.option.session_timeout = _LIVE_SESSION_TIMEOUT_S


#: Keep a free-VRAM margin above steady-state model use because loading has a larger transient. Lowering this threshold can terminate a worker and, with restarts disabled, abort the run.
_MIN_FREE_VRAM_GB = 8.0


def _render_hardware():
    """Return whether an available accelerator or satellite can run integration tests.

    Missing drivers, configuration, or hardware should skip these tests rather than fail
    collection. The check does not perform generation or contact a service.
    """
    busy = []
    try:
        import torch
        if torch.cuda.is_available() and torch.cuda.device_count() > 0:
            # Require free memory, not mere device presence, before starting heavy GPU tests.
            # Read the whole-card sensor so concurrent processes are included.
            sys.path.insert(0, str(REPO_ROOT / "src"))
            import tts_utils
            ready = []
            for i in range(torch.cuda.device_count()):
                free, total = tts_utils.device_mem_gb(f"cuda:{i}")
                if free is None:
                    continue
                (ready if free >= _MIN_FREE_VRAM_GB else busy).append(
                    f"cuda:{i} ({free:.1f} of {total:.1f} GB free)")
            if ready:
                return True, "local CUDA with room: " + ", ".join(ready)
            # Cards exist but every one is occupied — fall through to the satellite check, and
            # if that finds nothing the skip reason below names the numbers rather than saying
            # "no hardware" over a 4090 he can see in Task Manager.
    except Exception:                                   # noqa: BLE001 — see the docstring
        pass
    try:
        sys.path.insert(0, str(REPO_ROOT / "src"))
        from vocalis.runtime import pool
        sats = [str(d) for d in pool.default_devices()
                if not str(d).startswith("cuda") and str(d) != "cpu"]
        if sats:
            # ⚠️ Enabled, but NOT the whole story — see the skip text in `gpu_enabled`.
            return True, "satellite(s) in ⚙ Settings: " + ", ".join(sats)
    except Exception:                                   # noqa: BLE001
        pass
    if busy:
        # 🔴 SAY WHICH CARD AND HOW MUCH, or the skip reads as "this box has no GPU" over a 4090
        # sitting right there, and the next person "fixes" it by forcing `--gpu` into the ini.
        return False, (f"every local card is occupied ({'; '.join(busy)}) and no satellite is "
                       f"enabled — these tests need {_MIN_FREE_VRAM_GB:.0f} GB free to load a "
                       f"model without evicting whatever is already there")
    return False, ("no local CUDA device, and no satellite enabled in ⚙ Settings ▸ Devices")


@pytest.fixture(scope="session")
def gpu_enabled(request):
    """Run the GPU integration tests when this box can actually render. Session-scoped so the
    decision, and any skip, happens once.

    CPU is not a fallback, and that is measured rather than assumed: on the 4090 these ten
    take about three minutes end to end, and Chatterbox on CPU is roughly two orders of
    magnitude slower per chunk — a suite nobody would ever wait for, which is how it ends up
    permanently skipped again.
    """
    if request.config.getoption("--no-gpu"):
        pytest.skip("GPU integration tests disabled by --no-gpu")
    ok, why = _render_hardware()
    if request.config.getoption("--gpu"):
        return                                          # forced on, hardware or not
    if not ok:
        pytest.skip(f"GPU integration tests need real hardware — {why}. They are NOT run on "
                    f"CPU. Force with --gpu.")


@pytest.fixture(scope="session")
def voice():
    """Return a WAV fixture from the optional user-data voice_samples directory.

    No default voice is tracked. Skip accelerator tests when no suitable WAV is available.
    """
    d = REPO_ROOT / "voice_samples"
    found = sorted(d.glob("*.wav")) if d.is_dir() else []
    if not found:
        pytest.skip("no voice WAV on this host — voice_samples/ tracks only Fixture_full.mp3 "
                    "(an mp3, which this fixture's *.wav glob skips); the rest is user data")
    return str(found[0])


#: `<link rel="stylesheet" href="/webui/css/…">`, in the order the page writes them.
_CSS_LINK = re.compile(r'<link[^>]*rel="stylesheet"[^>]*href="/webui/css/([^"]+)"')


def page_css() -> str:
    """Every stylesheet `index.html` links, concatenated IN LINK ORDER.

    🔴 THE ORDER IS NOT A DETAIL, IT IS THE CASCADE. Until 7.3.19 this was one inline `<style>`
    block and a test that wanted the page's real CSS could regex it out in one go. The ten files
    that replaced it were cut from contiguous ranges of that block, so concatenating them in link
    order reproduces it exactly — and concatenating them in `sorted()` or `glob` order does not.
    A test that got that wrong would not fail; it would silently measure a page where the loser of
    an equal-specificity tie had won, which is the one class of CSS bug that looks like a design
    decision.

    ⚠️ THIS IS WHY THE HELPER IS SHARED. Three call sites in `test_strip_layout.py` each had their
    own copy of the old regex, and every one of them carried the same assertion that the CSS had
    not moved — three places to update, in a file whose whole subject is that measuring a HAND
    COPY of the page is what goes stale.
    """
    index = (REPO_ROOT / "src" / "webui" / "index.html").read_text(encoding="utf-8")
    names = _CSS_LINK.findall(index)
    assert names, (
        "index.html links no stylesheets from /webui/css/ - the page's CSS moved again and every "
        "test that measures real layout is now measuring an unstyled page. See "
        "tests/test_webui_css.py, which is the guard for exactly this.")
    root = REPO_ROOT / "src" / "webui" / "css"
    return "\n".join((root / n).read_text(encoding="utf-8") for n in names)


def page_markup() -> str:
    """The page's MARKUP, assembled from `index.html` plus its per-tab includes (9.0-m0).

    🔴 **ANY TEST THAT GREPS THE PAGE FOR AN ELEMENT WANTS THIS, NOT `index.html`.** TECH_DEBT #1
    split the page into partials under `src/webui/`, so the file is now a shell that `{% include %}`s
    its tabs. A test that reads the file and greps for a panel is reading a haystack the needle
    left — and the failure reads as "the element vanished", which sends the next person looking at
    the front end instead of at the test.

    ⚠️ **This is `page_html()`'s sibling, not its replacement.** Use this one when the subject is
    markup; use `page_html()` when the subject is the whole served document including CSS.

    📌 It returns what the server assembles *before* substitution, so `{{CSRF}}`, `{{ADMIN_USER}}`
    and `{{UI_STATE}}` are still present as literal placeholders — which is what the tests that
    assert on them expect.
    """
    from vocalis.runtime import page
    return page.assemble()


def page_html() -> str:
    """The page AS SERVED: `index.html` with its linked stylesheets inlined where the links are.

    🔴 ANY TEST THAT GREPS THE PAGE FOR A CSS RULE WANTS THIS, NOT `index.html`. Until 7.3.19 the
    page carried an 886-line inline `<style>`, so "read index.html" and "read the page's CSS" were
    the same act — and several tests did the former while meaning the latter. The split broke all
    of them at once, on rules that are still in the product and still correct.

    ⚠️ The tempting fixes are both silent: deleting the assertions, or relaxing them to look at one
    stylesheet. Reassembling the document keeps each check meaning exactly what it already meant.
    Links are replaced IN PLACE, so source order — which is the cascade — survives.

    📌 For CSS alone, use `page_css()`. This is for a test whose subject is the whole page.

    🔴 **9.0-m0: IT NOW STARTS FROM `page_markup()`, NOT FROM THE FILE — AND THAT IS THE SAME
    LESSON AGAIN.** The per-tab panels moved into `{% include %}` partials, so "read index.html"
    and "read the page's markup" have come apart exactly as "read index.html" and "read the page's
    CSS" did in 7.3.19. Reading the file here would have quietly dropped every extracted panel out
    of the served page this function claims to return.
    """
    index = page_markup()
    root = REPO_ROOT / "src" / "webui" / "css"

    def inline(m):
        return "<style>\n" + (root / m.group(1)).read_text(encoding="utf-8") + "</style>"

    return _CSS_LINK.sub(inline, index)


def make_test_docx(path: Path, *, num_chapters: int = 2) -> None:
    """Create a minimal DOCX with N Heading 2 chapters plus one body paragraph each."""
    from docx import Document
    doc = Document()
    for i in range(num_chapters):
        doc.add_heading(f"Chapter {i + 1}", level=2)
        doc.add_paragraph(f"This is chapter {i + 1}. Short body text for fast generation.")
    doc.save(str(path))


def make_test_epub(path: Path, *, num_chapters: int = 3) -> None:
    """Hand-build a minimal valid EPUB (mimetype + container + opf + nav/ncx +
    N XHTML chapters) so EPUB parsing is covered without a copyrighted book."""
    from zipfile import ZIP_STORED, ZipFile

    opf = ['''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">vocalis-test-epub</dc:identifier>
    <dc:title>Test EPUB Book</dc:title><dc:language>en</dc:language>
  </metadata><manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>''']
    nav = ["<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><body><nav epub:type=\"toc\"><ol>"]
    spine = []
    entries = {"mimetype": b"application/epub+zip",
               "META-INF/container.xml": b'''<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
 <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>'''}
    for i in range(num_chapters):
        member = f"OPS/chap_{i + 1}.xhtml"
        opf.append(f'<item id="chapter{i + 1}" href="chap_{i + 1}.xhtml" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="chapter{i + 1}"/>')
        nav.append(f'<li><a href="chap_{i + 1}.xhtml">Chapter {i + 1}</a></li>')
        entries[member] = (
            f"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><h1>Chapter {i + 1}</h1>"
            f"<p>This is the body of chapter {i + 1}. Short text for the test.</p>"
            "</body></html>"
        ).encode("utf-8")
    opf.append("</manifest><spine>" + "".join(spine) + "</spine></package>")
    entries["OPS/package.opf"] = "".join(opf).encode("utf-8")
    entries["OPS/nav.xhtml"] = ("".join(nav) + "</ol></nav></body></html>").encode("utf-8")
    with ZipFile(path, "w") as archive:
        archive.writestr("mimetype", entries.pop("mimetype"), compress_type=ZIP_STORED)
        for member, contents in entries.items():
            archive.writestr(member, contents)


# ── a locked vault, actually locked ──────────────────────────────────────────────

class VaultIsShut(Exception):
    """Stands in for `vault.VaultLocked` — see `lock_the_vault`."""


def lock_the_vault(monkeypatch) -> type:
    """Make EVERY `vault_fs` accessor raise, and teach `locked_exc()` to recognize it.

    **This fixture makes the locked-vault condition real.** A status-only assertion would pass
    without exercising the failure boundary unless every vault accessor raises during the request.

    Patching the WHOLE module rather than the one function a route happens to call today is the
    point: the regression these guard against is a route quietly growing a store read, and a
    fixture that stubbed only `listdir` would sail straight past a new `read_bytes`.

    ⚠️ **A PLAIN `Exception` SUBCLASS, NOT `vault.VaultAuthError`.** `VaultAuthError` is a
    `BaseException` on purpose (`src/vocalis/vault.py`) so that a blind `except Exception` cannot
    swallow a wrong passphrase; modeling *locked* with it would be modeling the wrong failure
    and would tempt a test into asserting that broad handlers should catch it. `VaultLocked` — the
    thing `locked_exc()` actually returns in production — is the ordinary kind, and this matches.

    Returns the exception class, so a caller can assert on it directly.
    """
    import vault_fs

    def shut(*a, **kw):
        raise VaultIsShut("the vault is locked")

    monkeypatch.setattr(vault_fs, "locked_exc", lambda: VaultIsShut)
    for name in ("exists", "is_dir", "stat", "utime", "listdir", "glob", "rglob", "read_bytes",
                 "read_text", "open_read", "write_bytes", "write_text", "write_yaml_atomic",
                 "write_json_atomic", "mkdir", "unlink", "rename", "rmtree", "rmdir_if_empty",
                 "to_scratch", "child_input", "from_scratch"):
        monkeypatch.setattr(vault_fs, name, shut)
    return VaultIsShut


# Keep the socket bound from port selection through server startup. Returning a free port
# number releases it before the server binds and races parallel browser workers.


def bound_server(app, *, threaded: bool = True, ssl_context=None):
    """Start a Werkzeug server on an OS-selected port while retaining its bound socket.

    Binding port zero avoids the free-port race between discovery and server startup.
    """
    from werkzeug.serving import make_server
    return make_server("127.0.0.1", 0, app, threaded=threaded, ssl_context=ssl_context)


# ── model weights that are (or are not) installed ────────────────────────────────────────
# Stems and Lead Vocal refuse to start a child unless every model file it would read is already on
# disk (nothing is ever downloaded). A test that fakes the child still has to pass that check, so
# it installs EMPTY stand-ins here; the check asks only for a regular file, never for contents.

def install_demucs_weights(monkeypatch, torch_home) -> Path:
    """Point the child's TORCH_HOME at `torch_home` and put a stand-in HTDemucs weight file where
    `torch.hub` would read it. Returns that path; delete it to test the "not installed" case."""
    import stems
    monkeypatch.setenv("TORCH_HOME", str(torch_home))
    path = stems.demucs_weight_path({"TORCH_HOME": str(torch_home)})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return path


def install_lead_models(model_dir, *models) -> list:
    """Put a stand-in for every file `audio-separator` reads to load `models` into `model_dir`
    (the default karaoke model plus every allowlisted de-reverb model when none are named)."""
    import leadvocal
    model_dir = Path(model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    models = models or (leadvocal.KARAOKE_MODEL, *leadvocal.DEREVERB_MODELS)
    made = []
    for name in leadvocal.model_files_needed(*models):
        (model_dir / name).write_bytes(b"")
        made.append(model_dir / name)
    return made


# ── a ComfyUI that is not there ──────────────────────────────────────────────────────────
# ⚠️ Imported HERE rather than at the top of the file: this module's header sets `sys.path` and
# thread limits in a deliberate order before anything heavy loads, and these four are only needed
# by the stub below.
import io
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer


# Exercise render dispatchers through the HTTP contract rather than patching their client:
# the stub validates submitted graphs/uploads and returns real images for downstream decoding.

def fake_png(color=(120, 90, 70), size=(1024, 1024)) -> bytes:
    """A REAL PNG, because half of this pipeline decodes what it is handed.

    🔴 A BYTE STRING THAT MERELY STARTS WITH THE PNG MAGIC IS NOT AN IMAGE, and the difference is
    load-bearing: `loraface.render` crops the chosen candidate to a square, flattens alpha and
    resamples it to 1024px, so a stub returning plausible-looking bytes dies there with
    `UnidentifiedImageError`. The generate path never decodes — it writes the bytes straight
    through — which is exactly how a fake this thin looks adequate for one path and is useless for
    the next one along.
    """
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


#: One valid PNG, for tests that just need bytes an image library will accept.
FAKE_PNG = fake_png()


class _ComfyHandler(BaseHTTPRequestHandler):
    """The four calls `runtime/flux2.py` makes, and nothing else."""

    graphs: dict = {}
    uploads: list = []

    def log_message(self, *a):          # the suite's output is not a web server log
        pass

    def _send(self, body: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj):
        self._send(json.dumps(obj).encode(), "application/json")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path.startswith("/upload/image"):
            m = re.search(rb'filename="([^"]+)"', body)
            assert m, "the seed face was uploaded without a filename"
            _ComfyHandler.uploads.append((m.group(1).decode(), len(body)))
            self._json({"name": m.group(1).decode(), "subfolder": ""})
            return
        if self.path.startswith("/prompt"):
            graph = json.loads(body)["prompt"]
            assert isinstance(graph, dict) and graph, "an empty graph reached the renderer"
            pid = f"pid{len(_ComfyHandler.graphs):03d}"
            _ComfyHandler.graphs[pid] = graph
            self._json({"prompt_id": pid})
            return
        self.send_error(404)

    def do_GET(self):
        if self.path.startswith("/history/"):
            pid = self.path.rsplit("/", 1)[-1]
            if pid not in _ComfyHandler.graphs:
                self._json({})                       # not started yet, as ComfyUI answers
                return
            self._json({pid: {
                "outputs": {"13": {"images": [
                    {"filename": f"{pid}.png", "subfolder": "", "type": "output"}]}},
                "status": {"completed": True, "status_str": "success"},
            }})
            return
        if self.path.startswith("/view"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fn = (q.get("filename") or [""])[0]
            assert fn.endswith(".png"), f"/view was asked for {fn!r}"
            # ⚠️ A DIFFERENT COLOR PER FILENAME, so "did the right image land here" is answerable,
            # and a genuine PNG because `loraface.render` decodes whatever Choose hands it. Not
            # square, so the crop-to-square step has something to actually do.
            n = sum(fn.encode())
            self._send(fake_png(color=(n % 251, (n * 7) % 251, (n * 13) % 251), size=(512, 640)),
                       "image/png")
            return
        self.send_error(404)


class FakeComfyUI:
    """The stub's URL, and a record of everything the renderer was actually sent."""

    def __init__(self, url):
        self.url = url

    @property
    def graphs(self) -> list:
        """Every graph submitted, in submission order."""
        return list(_ComfyHandler.graphs.values())

    @property
    def uploads(self) -> list:
        return list(_ComfyHandler.uploads)

    def seeds(self) -> list:
        return [g["7"]["inputs"]["seed"] for g in self.graphs]

    def prompts(self) -> list:
        return [g["4"]["inputs"]["text"] for g in self.graphs]


@pytest.fixture
def fake_comfyui(monkeypatch):
    """A ComfyUI on a real socket, wired in as the box's only instance.

    🔴 PORT 0 AND READ IT BACK, never a "find a free port" helper - the `bind(("127.0.0.1", 0))`
    TOCTOU race this repo carried in six copies is intermittent at every width, and binding the
    real server then asking it what it got cannot race anything. Same rule as `make_server` above.
    """
    from vocalis.runtime import comfyui as _rt_comfyui

    _ComfyHandler.graphs, _ComfyHandler.uploads = {}, []
    srv = HTTPServer(("127.0.0.1", 0), _ComfyHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    monkeypatch.setattr(_rt_comfyui, "comfyui_instances", lambda: [("comfyui.service", url)])
    try:
        yield FakeComfyUI(url)
    finally:
        srv.shutdown()


# Browser wrappers must verify a minimum assertion count; exit status alone can pass when a
# spec returns early or silently stops checking its expected behavior.

#: Below this, a derived floor is not a guard — see `assert_spec_ran`.
_MIN_MEANINGFUL_FLOOR = 5

#: What `ok()` prints. Every spec in this tree uses the same two-space form.
_OK_LINE = "  ok   "

_OK_CALL = re.compile(r"^\s*ok\(")
_BRANCH = (re.compile(r"^\s*(\}\s*)?(if|else if|else)\b"), re.compile(r"^\s*(for|while|do)\b"))


def unconditional_ok_sites(spec_path) -> int:
    """How many `ok()` calls in a spec are reached by construction — no `if`, `for` or `while`.

    This is the floor's whole trick: those calls MUST run, so their count is a true lower bound on
    what the spec emits, it needs no measured constant, and it rises on its own as the spec grows.
    Validated where the truth was known — `acestep_tab_browser_spec` derives 92 and emits 92.

    ⚠️ AN ENCLOSING FUNCTION IS NOT A BRANCH. Every spec wraps its body in one async try block, so
    counting functions as guards flags all 62 files and measures nothing — that was the first cut
    of this scanner and it was useless. Only branching changes whether a line runs.

    🔴 IT IS APPROXIMATE, AND THE ERROR IS ASYMMETRIC BY DESIGN. Brace depth is counted per line,
    so a `{` inside a template literal this has not noticed — the `in_template` toggle only flips on
    an odd backtick count — leaves a branch open forever and everything after it reads as guarded.
    Measured on `board_temp_browser_spec`: derived 0, really emits 41. So:

      · UNDER-count → the floor is merely conservative. Safe; weaker than it looks.
      · OVER-count  → the floor exceeds what the spec can emit, and the very next run fails loudly.

    🔴 AND A LOOP MAKES IT WILDLY CONSERVATIVE, NOT SLIGHTLY. An `ok()` inside a `for` is counted
    once here and runs once per iteration: `voices_folders_browser_spec` has 31 call sites and emits
    **114** assertions, because its whole assertion block repeats per entry of a hardcoded LISTS
    array. The direction is still safe — a loop can only make the real count LARGER than the site
    count, never smaller — so the floor stays a valid lower bound. But do not read a derived number
    as approximately the true one: on a looped spec it can be out by a factor of four, and the guard
    it installs is correspondingly weak. Measure those.

    Neither is silent, which is what makes a derived floor worth having at all. It is a RATCHET, not
    a measurement: when the derivation is too low to mean anything the caller is told to pass a
    measured `floor=`, and when it is too high the suite says so immediately.
    """
    stack, n, in_template = [], 0, False
    for line in Path(spec_path).read_text(encoding="utf-8").splitlines():
        if not in_template and line.strip().startswith("//"):
            continue
        if not in_template and _OK_CALL.match(line) and "branch" not in stack:
            n += 1
        if not in_template:
            depth = line.count("{") - line.count("}")
            if depth > 0:
                kind = "branch" if any(p.search(line) for p in _BRANCH) else "plain"
                stack.extend([kind] * depth)
            elif depth < 0:
                for _ in range(-depth):
                    if stack:
                        stack.pop()
        if line.count("`") % 2 == 1:
            in_template = not in_template
    return n


def assert_spec_ran(result, spec_path, *named, floor=None):
    """Assert a browser spec ran to the END, not merely that it exited 0.

    `floor=None` derives the minimum from the spec source. Pass an explicit `floor` only where the
    derivation is too low to mean anything — and MEASURE it when you do (set it absurdly high once
    and read the failure message) rather than guessing: a floor below the true count reads as a
    guard while permitting exactly the drift it exists to catch.

    🔴 IT REFUSES TO BE DECORATION. On a few specs the derivation lands at 0 or 1, where a derived
    floor would read exactly like a guard while asserting nothing. Vacuity hides in the INPUT, not in
    the assertion, so that case is an ERROR naming the file, not a quietly useless check.

    ⚠️ AND A LOW DERIVATION IS NOT EVIDENCE THAT THE SPEC IS CONDITIONAL. An earlier version of this
    note claimed `board_temp` had "all 41 of its ok() calls inside conditionals". Measured properly —
    walking back from each site for an enclosing `if`/`for` — it has ZERO. The 0 was this function's
    own brace-tracking artifact, restated as a fact about the spec. When the derivation refuses,
    that means THE DERIVATION FAILED HERE; it says nothing about the file, and a measured floor is
    the answer either way.
    """
    ran = result.stdout.count(_OK_LINE)
    if floor is None:
        floor = unconditional_ok_sites(spec_path)
        assert floor >= _MIN_MEANINGFUL_FLOOR, (
            f"{Path(spec_path).name}: only {floor} of its ok() calls are unconditional, so a derived "
            f"floor would assert nothing while looking exactly like a guard. Pass an explicit, "
            f"MEASURED floor= for this spec instead.")
    # Apply the minimum to explicit floors too, so callers cannot disable the assertion
    # count guard by passing a value below the meaningful threshold.
    assert floor >= _MIN_MEANINGFUL_FLOOR, (
        f"{Path(spec_path).name}: floor={floor} is below the meaningful minimum of "
        f"{_MIN_MEANINGFUL_FLOOR}. If this spec really emits fewer than that, say so out loud - a "
        f"number this low asserts nothing while looking like a guard.")
    assert ran >= floor, (
        f"{Path(spec_path).name} made only {ran} assertions, against a floor of {floor} - it did not "
        f"run to the end, and exiting 0 is precisely what that looks like:\n{result.stdout}")
    for name in named:
        assert name in result.stdout, f"the check {name!r} did not run:\n{result.stdout}"
