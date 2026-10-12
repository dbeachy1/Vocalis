"""VoxCPM2 voice-design engine — load it, unload it, and generate through it.

VoxCPM2 manufactures a brand-new voice from a text description (design mode, no
reference audio). In Vocalis it is a CREATOR, never a renderer: it touches the app
once, at Create-a-voice time, to produce the clip that Chatterbox clones afterward;
the frozen clip, not the VoxCPM2 seed, defines the resulting voice.

The engine is a CHILD PROCESS in its own venv (scripts/voxcpm/worker.py), not an
import for three reasons:

  * Installing VoxCPM2 into Vocalis's venv could break Chatterbox. Keep the
    engine in its own environment.
  * Unload must actually free the VRAM. In-process, ~1.5 GB of ROCm runtime
    survives any unload (see /engine/restart); a child's death frees every byte.
  * Two VoxCPM2 instances as THREADS in one process crash on its internal tqdm
    (`tqdm has no attribute '_lock'`). Separate processes are the shape m2's
    two-at-once dual-GPU generation needs anyway — one Worker per card.

One Worker = one model on one device, serving requests serially over a line
protocol (stdout carries only VOXCPM_* lines; ROCm noise goes to stderr). Device
pinning rides the `device` param — proven to stick on both cards in parallel
(weights_on=cuda:N matched the request, POC dual_gpu_test).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from engine_process import NOISE_MARKERS, SETUP_HINT, kill_tree as _kill_tree, venv_python

logger = logging.getLogger(__name__)

# This is the model snapshot frozen in packaging/models/voxcpm2/model-file-lock.json.
# Runtime generation uses the mounted copy directly; it never resolves a Hub branch.
MODEL_REVISION = "32279effe8c19989596f05d353d1447f51d9e915"
MODEL_FILES = (
    "audiovae.pth", "config.json", "model.safetensors", "README.md",
    "special_tokens_map.json", "tokenization_voxcpm2.py", "tokenizer_config.json",
    "tokenizer.json",
)
DEFAULT_MODEL_DIR = Path("/models/vocalis/voxcpm2") / MODEL_REVISION
DEFAULT_VENV = Path("/opt/vocalis/venvs/voxcpm2")


class VoxcpmError(Exception):
    """The worker failed — to come up, to answer in time, or to generate."""


# An idle worker is not free: it burns a WHOLE CPU CORE, forever (4.8-m2e).
#
# A live HIP context can keep a userspace completion-queue poller active even while idle.
# Process exit releases both that CPU activity and the worker's VRAM; environment tuning
# did not remove the polling behavior on the supported ROCm stack.
#
# That makes "keep the model warm in VRAM but stop the spinning" impossible by
# construction: process death is the only reliable VRAM release on this stack (§9), so
# VRAM residency IS the live HIP context IS the pinned core — one resource, not three.
# Reaping the worker is therefore the only lever, and it frees the core and the ~10.4 GiB
# together. The idle timeout trades a bounded cold-start delay for reclaiming CPU and GPU
# resources after a design session is inactive.
IDLE_S_DEFAULT = 600.0


@dataclass
class VoxcpmConfig:
    python: Path        # the image-owned isolated VoxCPM2 venv, never Vocalis's
    script: Path        # scripts/voxcpm/worker.py
    model: str          # HF id or a local snapshot dir
    hf_home: str = ""   # where the ~2 GB weights cache lives; "" -> inherit the process env
    idle_s: float = 600.0   # reap a worker idle this long (0/negative disables) — see below

    @property
    def model_dir(self) -> Path:
        return Path(self.model)

    @property
    def model_missing_files(self) -> tuple[str, ...]:
        """Missing pieces of the one supported, pinned local snapshot."""
        if self.model_dir.name != MODEL_REVISION:
            return (f"snapshot directory named {MODEL_REVISION}",)
        if not self.model_dir.is_dir():
            return MODEL_FILES
        return tuple(name for name in MODEL_FILES if not (self.model_dir / name).is_file())

    @property
    def model_ready(self) -> bool:
        return not self.model_missing_files

    @property
    def available(self) -> bool:
        """True only when the isolated worker and complete pinned local model are present."""
        return self.python.is_file() and self.script.is_file() and self.model_ready

    @property
    def unavailable_reason(self) -> str:
        if not self.python.is_file():
            return "The isolated VoxCPM2 interpreter is missing from this image."
        if not self.script.is_file():
            return "The VoxCPM2 worker script is missing from this image."
        if not self.model_ready:
            return "The pinned VoxCPM2 model snapshot is incomplete (" + ", ".join(
                self.model_missing_files) + ")." + SETUP_HINT
        return ""


def resolve_config(app_settings: dict, base_dir: Path = None) -> VoxcpmConfig:
    """env var → app_settings.yaml `voxcpm:` → default. The same precedence as
    cleanup.resolve_config / kobold.resolve_config — one rule to remember."""
    s = (app_settings or {}).get("voxcpm")
    if not isinstance(s, dict):          # a hand-edited `voxcpm: "oops"` must not raise here
        s = {}
    root = Path(base_dir) if base_dir else Path(__file__).resolve().parent.parent

    def pick(env: str, key: str, default):
        return os.environ.get(env) or s.get(key) or default

    try:
        idle_s = float(pick("VOCALIS_VOXCPM_IDLE_S", "idle_s", IDLE_S_DEFAULT))
    except (TypeError, ValueError):      # a hand-edited `idle_s: soon` must not sink the engine
        idle_s = IDLE_S_DEFAULT

    return VoxcpmConfig(
        # The image owns this environment; no host-home fallback may make an absent engine
        # appear installed or allow startup to use an unrelated developer environment.
        python=venv_python(Path(pick("VOCALIS_VOXCPM_VENV", "venv", DEFAULT_VENV))),
        script=root / "scripts" / "voxcpm" / "worker.py",
        # The pinned model is an already-mounted snapshot directory, never a repository id or
        # floating branch. model_ready rejects paths that do not name the locked revision.
        model=str(pick("VOCALIS_VOXCPM_MODEL", "model", DEFAULT_MODEL_DIR)),
        hf_home=str(pick("VOCALIS_VOXCPM_HF_HOME", "hf_home", "")),
        idle_s=idle_s,
    )


class Worker:
    """One VoxCPM2 model, resident on one device, in its own process.

    Lifecycle: start() spawns and returns immediately (the load takes tens of seconds
    — model weights onto a card); wait_ready() blocks for the READY line; generate()
    is serial per worker (one card renders one clip at a time — parallelism is more
    WORKERS, not more threads); stop() ends it and frees everything it held.

    A worker also RETIRES on its own once nothing has used it for cfg.idle_s (see
    IDLE_S_DEFAULT above for why an idle one is expensive). Callers hold it across a
    request with reserve()/release() so the reaper can never land mid-generation.
    """

    def __init__(self, cfg: VoxcpmConfig, device: str):
        self.cfg = cfg
        self.device = device
        self.sample_rate = None
        self.proc = None
        self._ready = threading.Event()    # "something decisive happened" — see _ready_ok
        self._ready_ok = False             # True ONLY when the READY line actually arrived
        self._results = queue.Queue()
        self._stderr_tail = deque(maxlen=30)   # the diagnosis when a load dies
        self._req_lock = threading.Lock()
        self._req_id = 0
        # Idle bookkeeping, all under _idle_lock. `_holders` is a COUNT, not a flag: a
        # candidate holds its worker across generate AND the freeze that follows, and
        # nothing promises those nest one-deep forever.
        self._idle_lock = threading.Lock()
        self._holders = 0
        self._retired = False              # reaped — refuse new work, never un-retire
        self._last_used = time.monotonic()

    # ── lifecycle ──────────────────────────────────────────────────────────

    def start(self) -> None:
        if not self.cfg.model_ready:
            missing = ", ".join(self.cfg.model_missing_files)
            raise VoxcpmError(f"pinned VoxCPM2 model snapshot is unavailable: {missing}")
        env = dict(os.environ)
        env.setdefault("TQDM_DISABLE", "1")
        # A missed mount or incomplete snapshot must fail locally rather than fetch an
        # unpinned replacement while a user starts a voice-design job.
        env["HF_HUB_OFFLINE"] = "1"
        env["TRANSFORMERS_OFFLINE"] = "1"
        env["HF_DATASETS_OFFLINE"] = "1"
        env["HF_HUB_DISABLE_TELEMETRY"] = "1"
        if self.cfg.hf_home:
            env["HF_HOME"] = self.cfg.hf_home
        cmd = [str(self.cfg.python), str(self.cfg.script),
               "--device", self.device, "--model", self.cfg.model]
        kw = {}
        if os.name != "nt":
            kw["start_new_session"] = True     # own pgid — _kill_tree needs it
        logger.info(f"voxcpm: starting worker on {self.device} ({self.cfg.model})")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                     errors="replace", env=env, **kw)
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self):
        for raw in iter(self.proc.stdout.readline, ""):
            line = raw.strip()
            if line.startswith("VOXCPM_READY "):
                try:
                    d = json.loads(line[len("VOXCPM_READY "):])
                    self.sample_rate = int(d.get("sample_rate") or 0) or None
                except ValueError:
                    pass
                self._ready_ok = True
                self._ready.set()
            elif line.startswith("VOXCPM_RES "):
                try:
                    self._results.put(json.loads(line[len("VOXCPM_RES "):]))
                except ValueError:
                    self._results.put({"ok": False, "error": "unparseable worker response"})
        self.proc.stdout.close()
        self._ready.set()          # wake any waiter — alive() tells it what happened

    def _pump_stderr(self):
        # voxcpm's own prints and the ROCm noise land here; keep a filtered tail so a
        # dead load can say WHY instead of just "exited 1".
        for raw in iter(self.proc.stderr.readline, ""):
            line = raw.strip()
            if line and not any(n in line for n in NOISE_MARKERS):
                self._stderr_tail.append(line)
        self.proc.stderr.close()

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def ready(self) -> bool:
        return self.alive and self._ready_ok

    # ── idle reaping ───────────────────────────────────────────────────────

    def reserve(self) -> bool:
        """Claim this worker for one request. False when it's gone — retired by the
        reaper, or never/no-longer ready — and the caller must then load a fresh one
        rather than push work at a corpse. Pair with release() in a finally."""
        with self._idle_lock:
            if self._retired or not self.ready:
                return False
            self._holders += 1
            return True

    def release(self) -> None:
        """Done with it. Stamps last-use HERE, on release rather than on entry, so a
        long request restarts the idle clock from when it FINISHED."""
        with self._idle_lock:
            self._holders = max(0, self._holders - 1)
            self._last_used = time.monotonic()

    def retire_if_idle(self, idle_s: float) -> bool:
        """Atomically decide this worker is reapable and mark it so. True → the caller
        now owns it: drop it from the pool and stop() it.

        Marking and stopping are deliberately SPLIT. stop() takes up to ~8 s (EOF grace,
        then _kill_tree) and must not hold the lock a reserve() is waiting on; retiring
        first makes every subsequent reserve() fail immediately, so the window can't be
        raced into. A holder is never reaped — an in-flight generation can outlast
        idle_s and would otherwise look idle precisely because it's busy."""
        if idle_s <= 0:                    # reaping disabled — stay resident
            return False
        with self._idle_lock:
            if self._retired or self._holders:
                return False
            if time.monotonic() - self._last_used < idle_s:
                return False
            self._retired = True
            return True

    @property
    def idle_s(self) -> float:
        """Seconds since the last release — for logging/diagnosis, not for decisions."""
        with self._idle_lock:
            return time.monotonic() - self._last_used

    def wait_ready(self, timeout: float = 600.0) -> None:
        """Block until the model is on the card. Generous default: a cold box also
        downloads the ~2 GB snapshot on its first-ever load. Raises with the stderr
        tail when the worker died instead — that tail IS the diagnosis (wrong venv,
        v1 voxcpm, no such device).

        The event alone is NOT readiness: stdout EOF also sets it (to wake this
        waiter), and a worker that dies on load reaches EOF slightly BEFORE its exit
        code is reapable — so only the READY line itself (_ready_ok) counts, and a
        wake without it waits out the death to report rc + the stderr tail."""
        end = time.monotonic() + timeout
        while not self._ready.wait(timeout=0.5):
            if not self.alive:
                raise VoxcpmError(self._death_note())
            if time.monotonic() >= end:
                self.stop()
                raise VoxcpmError(f"VoxCPM2 did not come up within {timeout:.0f}s on {self.device}")
        if not self._ready_ok:
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            raise VoxcpmError(self._death_note())

    def _death_note(self) -> str:
        rc = self.proc.poll()
        tail = " | ".join(list(self._stderr_tail)[-5:]) or "no output"
        return f"VoxCPM2 worker exited (rc={rc}) — {tail}"

    def stop(self) -> None:
        """End the worker and free everything it held. stdin EOF is the polite way out;
        _kill_tree is for a worker mid-generation (or wedged), same discipline as every
        other GPU child."""
        if self.proc is None:
            return
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        for _ in range(30):                    # 3 s grace for a clean EOF exit
            if self.proc.poll() is not None:
                break
            time.sleep(0.1)
        if self.proc.poll() is None:
            _kill_tree(self.proc)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        logger.info(f"voxcpm: worker on {self.device} stopped")

    # ── generation ─────────────────────────────────────────────────────────

    def generate(self, text: str, out: Path, seed: int, cfg_value: float = 2.0,
                 steps: int = 30, timeout: float = 300.0) -> dict:
        """One clip. `text` arrives FINAL — description parenthetical already prepended
        (§4.2's prompt rules live with the caller, in one place). Serial per worker by
        lock, which is also the physical truth: one card generates one clip at a time.

        Returns the worker's result dict ({out, duration_s, compute_s}). Raises
        VoxcpmError on a dead worker, a generation error, or a timeout — and a timeout
        stops the worker rather than leaving a wedged model holding a card."""
        if self._retired:
            raise VoxcpmError("VoxCPM2 worker was unloaded while idle")
        if not self.ready:
            raise VoxcpmError("VoxCPM2 is not loaded")
        with self._req_lock:
            self._req_id += 1
            rid = self._req_id
            req = {"id": rid, "text": str(text), "out": str(out), "seed": int(seed),
                   "cfg_value": float(cfg_value), "steps": int(steps)}
            try:
                self.proc.stdin.write(json.dumps(req) + "\n")
                self.proc.stdin.flush()
            except OSError as exc:
                raise VoxcpmError(f"VoxCPM2 worker went away: {exc}") from exc
            end = time.monotonic() + timeout
            while True:
                left = end - time.monotonic()
                if left <= 0:
                    self.stop()
                    raise VoxcpmError(f"generation timed out after {timeout:.0f}s on {self.device}")
                try:
                    res = self._results.get(timeout=min(left, 0.5))
                except queue.Empty:
                    if not self.alive:
                        raise VoxcpmError(self._death_note())
                    continue
                if res.get("id") != rid:
                    continue               # a late answer to an abandoned request — drop it
                if not res.get("ok"):
                    raise VoxcpmError(str(res.get("error") or "generation failed"))
                with self._idle_lock:       # a generate() with no reserve() still counts as use
                    self._last_used = time.monotonic()
                return res
