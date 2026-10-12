"""Demucs separation used by the retained Stems workflow."""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

import scratch
import stems
from engine_process import visible_device_index
import vault_store
import vault_fs
from loguru import logger

EVENT_CAP = 5000
JOBS_KEEP = 30
STEMS_LOCK = threading.Lock()
DEMUCS_INTO = {
    "2stem": "vocals + instrumental",
    "4stem": "vocals / drums / bass / other",
    "vocals": "the vocal alone (the instrumental is computed and dropped)",
}


class StageFailed(RuntimeError):
    """A child stage failed; keep its detailed output in the authenticated job result."""

    def __init__(self, message: str, *, detail: str = ""):
        super().__init__(message)
        self.detail = detail


def emit(job, event: dict) -> None:
    """Append a job event and notify connected subscribers."""
    with job.lock:
        job.events.append(event)
        if len(job.events) > EVENT_CAP:
            del job.events[:len(job.events) - EVENT_CAP]
        for subscriber in job.subscribers:
            subscriber.put(event)


def _kill_tree(proc) -> None:
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


def _run_stage(job, command: list, env: dict | None = None) -> int:
    """Run one cancellable child in its own process group and stream its output."""
    options = {"start_new_session": True} if os.name != "nt" else {}
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env=env,
                            **options)
    last = [""]
    error = [""]

    def pump() -> None:
        last_carriage_return = 0.0
        for raw in iter(proc.stdout.readline, ""):
            for line in raw.replace("\r", "\n").split("\n"):
                line = line.strip()
                if not line:
                    continue
                last[0] = line
                if line.startswith(("ERROR", "error:")) or "Error" in line[:40]:
                    error[0] = line
                now = time.monotonic()
                if "\r" in raw and "\n" not in raw and now - last_carriage_return < 1.0:
                    continue
                if "\r" in raw:
                    last_carriage_return = now
                emit(job, {"type": "log", "line": line})
        proc.stdout.close()

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    while proc.poll() is None:
        if job.cancel.is_set():
            emit(job, {"type": "log", "line": f"Cancel — stopping {job.stage}…"})
            _kill_tree(proc)
            proc.wait()
            reader.join(timeout=5)
            return -1
        time.sleep(0.2)
    reader.join(timeout=5)
    job.last_line = error[0] or last[0]
    return proc.returncode


def _stage_ok(job, result: int, stage_name: str) -> bool:
    if result == -1 or job.cancel.is_set():
        job.status = "canceled"
        emit(job, {"type": "log", "line": "Canceled — no stem set was saved."})
        emit(job, {"type": "canceled"})
        return False
    if result != 0:
        raise StageFailed(f"{stage_name} failed (exit {result})", detail=job.last_line)
    return True


def _card_env(device: str) -> dict:
    env = dict(os.environ)
    if device.startswith("cuda:"):
        index = visible_device_index(device.split(":", 1)[1])
        env["HIP_VISIBLE_DEVICES"] = index
        env["CUDA_VISIBLE_DEVICES"] = index
    env.setdefault("MIOPEN_FIND_MODE", "FAST")
    return env


def ffprobe_duration(path) -> float:
    """Probe a plaintext work file for its duration, returning zero on probe failure."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        return round(float(result.stdout.strip()), 1) if result.returncode == 0 else 0.0
    # OSError: ffprobe missing or not executable. ValueError: no number on stdout (including a
    # UnicodeDecodeError). Anything else is a bug and must surface, not read as "0 seconds".
    except (OSError, ValueError) as exc:
        logger.warning("ffprobe duration unreadable, reporting 0.0 ({}: {})", type(exc).__name__, exc)
        return 0.0


def _created_at(previous: dict) -> str:
    return previous.get("created") or time.strftime("%Y-%m-%dT%H:%M:%S")


def get_stems(job, cfg, source, mode: str = "2stem", work: Path = None):
    """Reuse a suitable saved separation or create and commit a new one."""
    if source.kind == "stems":
        if not stems.has_base(source.d):
            raise RuntimeError(f"{source.name} has no vocal and instrumental base stems")
        job.stems_ref = source.d.name
        emit(job, {"type": "log", "line": f"Using saved stems for {source.name}."})
        return (stems.find_stem(source.d, "vocals"),
                stems.find_stem(source.d, "instrumental"), source.d.name)

    identity = stems.song_id(cfg, source.path)
    found = stems.find_by_hash(cfg, identity)
    if found is not None and stems.satisfies(found, mode):
        job.stems_ref = found.name
        emit(job, {"type": "log", "line": f"{source.name} is already split; reusing saved stems."})
        return (stems.find_stem(found, "vocals"),
                stems.find_stem(found, "instrumental"), found.name)

    work = Path(work or cfg.work_root / job.id)
    work.mkdir(parents=True, exist_ok=True)
    job.demucs = True
    emit(job, {"type": "log", "line": f"Demucs: splitting {source.name} into {DEMUCS_INTO.get(mode, mode)}…"})
    demucs_python = cfg.demucs_python
    if not demucs_python.is_file():
        raise RuntimeError(f"Stems Demucs interpreter is missing: {demucs_python}")
    # The child's environment is built once and used for both the weights check and the spawn, so
    # the path checked is the path the child reads. This precedes the decrypt/copy below: a job
    # that cannot run must not first leave the song's plaintext in the scratch.
    env = stems.demucs_child_env(_card_env(job.device))
    stems.require_demucs_model(env)

    routed = vault_store.route(source.path)
    if routed is not None:
        vault, logical = routed
        song = vault.decrypt_to_scratch(logical, work)
    else:
        song = work / scratch.opaque_name(str(source.path), Path(source.path).suffix)
        shutil.copyfile(source.path, song)
    result = _run_stage(job, stems.build_demucs_cmd(
        demucs_python, song, work, job.device, mode), env)
    output = stems.demucs_out_dir(work, song)
    missing = [name for name in stems.DEMUCS_RAW[mode] if not (output / name).exists()]
    if result == 0 and missing:
        raise RuntimeError(f"Demucs finished but stems are missing: {', '.join(missing)}")
    if not _stage_ok(job, result, "Demucs split"):
        return None, None, None

    produced = {"vocals.wav": output / "vocals.wav"}
    if mode == "2stem":
        produced["instrumental.wav"] = output / stems.LEGACY_INSTRUMENTAL
    elif mode == "4stem":
        for name in stems.SUM_PARTS:
            produced[name] = output / name
        instrumental = output / "instrumental.wav"
        emit(job, {"type": "log", "line": "ffmpeg: summing instrument stems…"})
        result = _run_stage(job, stems.build_sum_cmd([output / name for name in stems.SUM_PARTS],
                                                      instrumental))
        if result == 0 and not instrumental.exists():
            raise RuntimeError("ffmpeg produced no instrumental to combine")
        if not _stage_ok(job, result, "instrumental sum"):
            return None, None, None
        produced["instrumental.wav"] = instrumental

    duration = ffprobe_duration(produced["vocals.wav"])
    fresh = {stems.stem_key(name): Path(path) for name, path in produced.items()
             if stems.stem_key(name)}
    plan = stems.encode_plan(produced, work)
    for _key, wav, opus in plan:
        result = _run_stage(job, stems.build_encode_cmd(wav, opus))
        if result == -1 or job.cancel.is_set():
            if not _stage_ok(job, result, "stem encode"):
                return None, None, None
        if result != 0 or not opus.exists():
            emit(job, {"type": "log", "line": f"Could not encode {opus.name}; keeping the WAV."})
    produced = stems.encoded_produced(produced, plan)

    previous = stems.read_meta(found) if found is not None else {}
    destination = (found if found is not None and found.parent == Path(cfg.stems_dir)
                   else Path(cfg.stems_dir) / stems.set_ref(source.name, identity))
    metadata = {"h": identity, "source": "demucs", "song": source.name,
                "song_ref": source.ref, "song_h": identity,
                "model": stems.DEMUCS_MODEL, "device": job.device,
                "duration_s": duration, "created": _created_at(previous)}
    if previous.get("lead"):
        metadata["lead"] = previous["lead"]
    stems.commit(destination, produced, metadata)
    job.stems_ref = destination.name
    emit(job, {"type": "stems_saved", "ref": destination.name})
    vocals = fresh.get("vocals")
    instrumental = fresh.get("instrumental")
    return (vocals if vocals and vocals.exists() else stems.find_stem(destination, "vocals"),
            instrumental if instrumental and instrumental.exists()
            else stems.find_stem(destination, "instrumental"), destination.name)
