"""Run lead-vocal separation in the satellite's isolated worker environment.

The child process and model setup match local lead-vocal processing while
keeping the satellite install self-contained. Input audio is staged in a
per-request directory under the satellite home because the separator requires
filesystem paths. Cleanup runs on normal completion and stale directories are
swept at startup after an interrupted process. The router checks device memory
before dispatch; the local check handles resource changes between routing and
execution.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from loguru import logger

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vocalis_satellite_paths as satpaths  # noqa: E402

#: Per-request scratch under the satellite home; removed when processing ends.
WORK_ROOT = satpaths.LEADVOCAL_WORK_DIR

#: Standalone child script, kept in sync with `scripts/leadvocal/detect.py`.
DETECT_SCRIPT = HERE / "leadvocal_detect.py"

#: Measured peak VRAM for the configured separation chain. The router makes
#: placement decisions; this threshold protects against memory changes before dispatch.
REQUIRED_VRAM_GB = 1.9

#: Anything older than this in `WORK_ROOT` belongs to a process that is gone. Generous, because
#: a legitimately long separation on a CPU-only satellite is minutes, not hours.
STALE_AFTER_S = 6 * 3600

_RUNNING = {}                                   # request_id -> Popen, for /satellite/cancel
_LOCK = threading.Lock()

#: Release the resident worker after this idle interval if the queue does not
#: explicitly request reuse or shutdown.
IDLE_RELEASE_S = 300

_WORKER = {"proc": None, "device": None, "work": None, "last": 0.0}
_WORKER_LOCK = threading.RLock()


class LeadVocalError(Exception):
    """The chain is unavailable on this satellite; the caller may fall back locally."""


# ── where the toolchain is ───────────────────────────────────────────────────

def _cfg_path(cfg: dict, key: str, default: Path):
    v = (cfg or {}).get(key)
    return Path(str(v)).expanduser() if v else default


def venv_python(cfg: dict = None) -> Path:
    """The leadvocal venv's interpreter. `scripts/leadvocal/setup.sh` builds it; on Windows the
    same layout puts the interpreter under `Scripts\\` rather than `bin/`."""
    base = _cfg_path(cfg, "leadvocal_venv", Path.home() / "leadvocal-venv")
    win = base / "Scripts" / "python.exe"
    return win if win.exists() else base / "bin" / "python"


def models_dir(cfg: dict = None) -> Path:
    return _cfg_path(cfg, "leadvocal_models", Path.home() / "leadvocal-models")


def installed(cfg: dict = None) -> bool:
    """Whether this satellite can take lead-vocal work at all.

    Missing optional dependencies are an expected state on a satellite. The
    router can use this result to select local processing instead.
    """
    return venv_python(cfg).exists() and DETECT_SCRIPT.exists()


def script_sha(cfg: dict = None) -> str:
    """sha256 of the child this satellite would actually run, first 16 hex chars.

    Newline normalization keeps the digest stable when the standalone copy is
    transferred between Windows and Unix checkouts.
    """
    if not DETECT_SCRIPT.exists():
        return ""
    return hashlib.sha256(
        DETECT_SCRIPT.read_bytes().replace(b"\r\n", b"\n")).hexdigest()[:16]


# ── the device lever ─────────────────────────────────────────────────────────

def detect_env(base_env: dict, device: str) -> dict:
    """The child's environment, with the GPU pinned to one card or hidden entirely.

    This stays local because the satellite package must run without a Vocalis
    checkout. Tests compare it with `src/leadvocal.detect_env`.

    `audio-separator` selects devices from runtime visibility variables rather
    than a device argument. Set both visibility variables explicitly; an empty
    value can be interpreted as all devices.
    """
    env = dict(base_env)
    if str(device).startswith("cuda"):
        idx = str(device).split(":", 1)[1] if ":" in str(device) else "0"
        env["HIP_VISIBLE_DEVICES"] = idx
        env["CUDA_VISIBLE_DEVICES"] = idx
    else:
        # `-1` hides all CUDA and ROCm devices; an empty value may expose them.
        env["HIP_VISIBLE_DEVICES"] = "-1"
        env["CUDA_VISIBLE_DEVICES"] = "-1"
    # Keep the local and satellite device environments behaviorally aligned.
    env.setdefault("MIOPEN_FIND_MODE", "FAST")
    return env


# ── scratch hygiene ──────────────────────────────────────────────────────────

def sweep_stale(now: float = None) -> int:
    """Remove request directories left behind by a process that was killed. Returns the count.

    Called at startup to remove request directories left by interrupted processes.
    """
    if not WORK_ROOT.exists():
        return 0
    now = time.time() if now is None else now
    gone = 0
    for d in WORK_ROOT.iterdir():
        try:
            if d.is_dir() and now - d.stat().st_mtime > STALE_AFTER_S:
                shutil.rmtree(d, ignore_errors=True)
                gone += 1
        except OSError:                                       # racing another sweep; not ours
            continue
    if gone:
        logger.info(f"leadvocal: swept {gone} stale scratch director"
                    f"{'y' if gone == 1 else 'ies'} from a previous run")
    return gone


# ── cancel ───────────────────────────────────────────────────────────────────

def cancel(request_id: str) -> bool:
    """Kill the child running under `request_id`. True if there was one.

    The request identifier selects the child registered for cancellation.
    """
    with _LOCK:
        proc = _RUNNING.get(str(request_id))
    if proc is None:
        return False
    try:
        proc.kill()
    except OSError:                                            # already gone
        return False
    logger.info(f"{request_id}: lead-vocal child killed on request")
    return True


def running() -> int:
    with _LOCK:
        return len(_RUNNING)


# ── the resident worker ──────────────────────────────────────────────────────
#
# Keep one isolated child warm across a queue to avoid repeated process startup,
# CUDA context creation, and model loading. The worker owns its separate venv,
# so commands are sent over stdin. Serialize jobs because the worker and its
# device resources are shared and the child protocol has one stdin stream.


def _worker_stop(why: str = "") -> None:
    """Drop the warm child and its VRAM. Safe to call when there is none."""
    with _WORKER_LOCK:
        proc, work = _WORKER["proc"], _WORKER["work"]
        _WORKER.update(proc=None, device=None, work=None, last=0.0)
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=10)
    except Exception:                                          # noqa: BLE001 — it is going away
        try:
            proc.kill()
        except OSError:
            pass
    shutil.rmtree(work, ignore_errors=True) if work else None
    logger.info(f"leadvocal: warm worker released{' — ' + why if why else ''}")


def _worker_start(device: str, cfg: dict):
    """Spawn the resident child and wait for it to say it is ready."""
    work = WORK_ROOT / f"worker-{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)
    cmd = [str(venv_python(cfg)), str(DETECT_SCRIPT), "--serve", "--work-dir", str(work),
           "--model-dir", str(models_dir(cfg)), "--device", str(device)]
    proc = subprocess.Popen(cmd, env=detect_env(os.environ, device),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
                            bufsize=1)
    while True:
        line = proc.stdout.readline()
        if not line:
            out = ""
            try:
                out = proc.stdout.read() or ""
            except Exception:                                  # noqa: BLE001
                pass
            shutil.rmtree(work, ignore_errors=True)
            raise LeadVocalError(f"the separator worker died before it was ready: {out[-300:]}")
        if "serve: ready" in line:
            break
    _WORKER.update(proc=proc, device=str(device), work=work, last=time.time())
    logger.info(f"leadvocal: warm worker up on {device}")
    return proc


def _worker_for(device: str, cfg: dict):
    """The worker for `device`, started if there is none and replaced if the card changed."""
    with _WORKER_LOCK:
        proc = _WORKER["proc"]
        if proc is not None and proc.poll() is not None:
            logger.warning("leadvocal: the warm worker had exited — starting a new one")
            _worker_stop("it had exited")
            proc = None
        if proc is not None and _WORKER["device"] != str(device):
            _worker_stop(f"the card changed to {device}")
            proc = None
        return proc if proc is not None else _worker_start(device, cfg)


def _reap_idle() -> None:
    """Give the VRAM back if nobody has used the worker for a while. See `IDLE_RELEASE_S`."""
    with _WORKER_LOCK:
        if _WORKER["proc"] is None:
            return
        idle = time.time() - (_WORKER["last"] or 0)
        if idle < IDLE_RELEASE_S:
            return
    _worker_stop(f"idle for {idle / 60:.0f} min")


def start_reaper() -> None:
    """One daemon thread, started with the server. Cheap: a poll every 30 s that usually
    finds nothing."""
    def _loop():
        while True:
            time.sleep(30)
            try:
                _reap_idle()
            except Exception as exc:                           # noqa: BLE001 — a reaper that
                # dies leaves VRAM pinned for ever, which is the thing it exists to prevent.
                logger.warning(f"leadvocal: idle reaper stumbled ({exc})")

    threading.Thread(target=_loop, name="leadvocal-reaper", daemon=True).start()


def warm() -> dict:
    """What `/satellite/health` reports about the warm worker."""
    with _WORKER_LOCK:
        return {"loaded": _WORKER["proc"] is not None, "device": _WORKER["device"],
                "idle_s": round(time.time() - _WORKER["last"], 1) if _WORKER["last"] else None}


def worker_pids() -> list:
    """The lead-vocal warm worker's PID, as a list — empty when there is none resident.

    The GPU process inventory includes this child because it owns the separator
    models and their device memory. Read the process reference without acquiring
    `_WORKER_LOCK`: that lock spans a full job, while this function runs on the
    telemetry polling path. The process reference is a single dictionary lookup;
    the PID is fixed for the lifetime of the `Popen` object, and `poll()` does
    not wait. The lock remains responsible for starting and replacing workers.
    """
    proc = _WORKER["proc"]
    return [proc.pid] if proc is not None and proc.poll() is None else []


# ── the run ──────────────────────────────────────────────────────────────────

def _run_on_worker(job: dict, device: str, cfg: dict, request_id: str) -> str:
    """Hand one job to the resident child and wait for its reply. Returns its log text.

    The lock spans each request because stdin/stdout form a single-line
    request/reply protocol. A worker that exits mid-request is restarted once;
    further failures are returned to the caller rather than retried indefinitely.
    """
    with _WORKER_LOCK:
        for attempt in (1, 2):
            proc = _worker_for(device, cfg)
            with _LOCK:
                _RUNNING[request_id] = proc
            try:
                proc.stdin.write(json.dumps(job) + "\n")
                proc.stdin.flush()
                lines = []
                while True:
                    line = proc.stdout.readline()
                    if not line:
                        raise BrokenPipeError("the separator worker closed its pipe")
                    line = line.rstrip("\r\n")
                    if line.startswith("{"):
                        reply = json.loads(line)
                        break
                    lines.append(line)
            except (BrokenPipeError, OSError, ValueError) as exc:
                _worker_stop(f"it stopped answering ({type(exc).__name__})")
                if attempt == 2:
                    raise LeadVocalError(f"the separator worker died mid-job: {exc}") from exc
                logger.warning(f"{request_id}: worker died, starting a fresh one and retrying")
                continue
            finally:
                with _LOCK:
                    _RUNNING.pop(request_id, None)
            _WORKER["last"] = time.time()
            if not reply.get("ok"):
                raise LeadVocalError(str(reply.get("error") or "the separator refused the job"))
            return "\n".join(lines + [f"[leadvocal] device_used {reply.get('device_used', '')}"])
    raise LeadVocalError("the separator worker could not be started")


def _child_device(out: str) -> str:
    """What the child SAID it got, off its own `[leadvocal] …: torch on cuda:0` lines.

    The child reports the device it actually used. The separator and ONNX
    detector can select devices independently, so this may differ from the
    requested device.
    """
    seen = []
    for line in (out or "").splitlines():
        if "[leadvocal]" in line and "torch on" in line:
            tail = line.split("torch on", 1)[1].strip()
            dev = tail.split(",", 1)[0].strip()
            if dev and dev not in seen:
                seen.append(dev)
    return ", ".join(seen)


def run(wav: bytes, *, device: str, dereverb: bool, karaoke_model: str, dereverb_model: str,
        request_id: str = "", cfg: dict = None, free_gb=None, keep_warm: bool = False) -> tuple:
    """Separate `wav` here. Returns `(outputs, info)`.

    `outputs` maps `"backing"` (always) and `"dry"` (when `dereverb`) to WAV bytes. `info`
    carries what the run learned — the device the child actually used, the child's stdout, and
    the wall clock — none of which is guessed at from this side.

    `keep_warm` lets the caller retain the model between queued jobs. The idle
    reaper still releases an abandoned worker after `IDLE_RELEASE_S`.

    Raises `LeadVocalError` when the toolchain is unavailable, device memory is
    insufficient, or the child cannot complete the request. The caller can then
    route the work to a local device.
    """
    cfg = cfg or {}
    request_id = str(request_id or uuid.uuid4().hex)
    if not installed(cfg):
        raise LeadVocalError(f"the lead-vocal venv is not installed here: {venv_python(cfg)}")
    if not wav:
        raise LeadVocalError("no audio was sent")

    # Recheck the router's memory estimate immediately before dispatch; device
    # usage may change between routing and execution.
    if free_gb is not None and str(device).startswith("cuda"):
        have = free_gb(device)
        if have < REQUIRED_VRAM_GB:
            raise LeadVocalError(
                f"{device} has {have:.1f} GB free; {REQUIRED_VRAM_GB} GB is required "
                f"for this chain")

    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    work = WORK_ROOT / request_id
    work.mkdir(parents=True, exist_ok=True)
    src = work / "vocals_wet.wav"
    backing_p, dry_p = work / "backing.wav", work / "dry.wav"
    started = time.time()
    try:
        src.write_bytes(wav)
        logger.info(f"{request_id}: lead-vocal separation starting on {device} "
                    f"({len(wav) / 1024 ** 2:.1f} MB in, dereverb={bool(dereverb)}, "
                    f"keep_warm={bool(keep_warm)})")
        job = {"input": str(src), "karaoke_out": str(backing_p),
               "karaoke_model": karaoke_model or "",
               "dereverb_out": str(dry_p) if dereverb else None,
               "dereverb_model": dereverb_model or ""}
        out = _run_on_worker(job, device, cfg, request_id)
        if not backing_p.exists():
            raise LeadVocalError("the child exited cleanly but wrote no backing stem")

        outputs = {"backing": backing_p.read_bytes()}
        if dereverb and dry_p.exists():
            outputs["dry"] = dry_p.read_bytes()
        info = {"device_used": _child_device(out), "took_s": round(time.time() - started, 1),
                "log": out or "", "script_sha": script_sha(cfg)}
        logger.info(f"{request_id}: lead-vocal separation done in {info['took_s']}s on "
                    f"{info['device_used'] or 'an unreported device'} — "
                    f"{', '.join(f'{k} {len(v) / 1024 ** 2:.1f} MB' for k, v in outputs.items())}")
        return outputs, info
    finally:
        # Every ending except a kill, which `sweep_stale()` covers at the next startup.
        shutil.rmtree(work, ignore_errors=True)
        # Release the resident child even when processing fails or is canceled.
        if not keep_warm:
            _worker_stop("the queue said this was the last one")


if __name__ == "__main__":                                     # a one-shot smoke check by hand
    print(json.dumps({"installed": installed(), "python": str(venv_python()),
                      "models": str(models_dir()), "script_sha": script_sha(),
                      "swept": sweep_stale()}, indent=2))
    sys.exit(0)
