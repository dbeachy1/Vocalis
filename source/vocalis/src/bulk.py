#!/usr/bin/env python3
"""One-shot lifecycle for the Bulk Enhance and Bulk Clean up modes. Uploads are staged per mode, processed by an injected engine, packaged as a downloadable ZIP, and then removed according to scratch cleanup. This module owns lifecycle and storage; callers provide the engine and device policy."""
from __future__ import annotations

import json
import os
import queue
import shutil
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

# The book-rails event fan-out (ring buffer for reconnect + live SSE subscribers). It
# works on anything with .lock/.events/.subscribers, which BulkJob has — one emit, shared
# with the swap/split/train jobs, so the SSE contract can never drift between them.
import scratch
from engine_process import ffprobe_duration
from vocalis.runtime.jobs import EVENT_CAP, JOBS_KEEP, emit

JOBS: dict = {}
JOBS_LOCK = threading.Lock()

# Keep one retained job ID per mode. The separate workspaces must not replace each other, and storage remains bounded to one completed batch for each mode.
_CURRENT_IDS: dict = {"enhance": "", "cleanup": ""}
_CURRENT_LOCK = threading.Lock()

# Enhance and Clean up use separate folders nested under `_staging`. Reapers and startup recovery skip this parent by name; any new cleanup walker must skip it too.
STAGING_DIR = "_staging"
MODES = ("enhance", "cleanup")


def _mode_or_die(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, not {mode!r}")
    return mode


# ── output format (design §5) ────────────────────────────────────────────────
# A dropdown, because the right answer depends on what the user does next. Output is MONO
# either way — resemble-enhance is a mono speech model and a denoise doesn't add a channel;
# a stereo container would only duplicate. 256k is the default for enhanced speech
# (MP3_BITRATE_ENHANCED): enhancement DOUBLES the band the encoder must pay for, so 256k is
# where the measured headroom (49.8 dB) lands. 128k is omitted on purpose — it measures the
# worst number in the table precisely because of that doubled band.
FORMATS = {
    "wav":      {"ext": "wav", "bitrate": None,   "label": "WAV (44.1 kHz mono)"},
    "mp3_256k": {"ext": "mp3", "bitrate": "256k", "label": "MP3 256 kbps"},
    "mp3_320k": {"ext": "mp3", "bitrate": "320k", "label": "MP3 320 kbps"},
    "mp3_192k": {"ext": "mp3", "bitrate": "192k", "label": "MP3 192 kbps"},
}
DEFAULT_FORMAT = "mp3_256k"
# Clean-up's default (design §12): match the source, because a denoise adds no bandwidth, so
# there is nothing to gain from a higher bitrate than the input carried. It is a per-file
# resolution (MP3 stays MP3 at its own bitrate; everything else lands as lossless WAV), so it
# is NOT a FORMATS key — the ext varies by input and the bitrate is probed at encode time.
SOURCE_FORMAT = "source"
SOURCE_LABEL = "Match source"


def resolve_format(raw, allow_source: bool = False) -> str:
    """Coerce a request's format to one we offer. Garbage → the default (256k), never a 500.
    `allow_source` lets Clean-up pass the special 'match source' sentinel; Enhance never can —
    matching a 24 kHz Chatterbox source's 96k would throw the enhancement straight away."""
    if raw == SOURCE_FORMAT and allow_source:
        return SOURCE_FORMAT
    return raw if raw in FORMATS else DEFAULT_FORMAT


def _out_stem(original: str) -> str:
    """The output filename's stem: the source's name with its extension dropped. Preserved
    so the ZIP maps back to the book — chapter01.mp3 → chapter01.<ext>."""
    return Path(str(original or "file")).stem or "file"


def source_ext(original: str) -> str:
    """Clean-up 'match source' output extension, from the source NAME alone (no probe): MP3
    stays MP3, everything else lands as lossless WAV — never inflate a lossy source to a
    bigger lossy encode a denoise gave it no reason to pay for."""
    return "mp3" if Path(str(original)).suffix.lower() == ".mp3" else "wav"


def _ext_for(fmt: str, original: str) -> str:
    return source_ext(original) if fmt == SOURCE_FORMAT else FORMATS[fmt]["ext"]


def source_bitrate(src) -> str:
    """The source MP3's own bitrate as an ffmpeg `-b:a` string, clamped to [96k, 320k]. A
    denoise adds no bandwidth, so we never encode ABOVE what the source carried; the clamp
    floors an oddball tiny input and caps at the house maximum. Unreadable → 256k."""
    import subprocess
    kbps = 256
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=bit_rate", "-of", "csv=p=0:nk=1", str(src)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30).stdout.strip().splitlines()
        if out and out[0].isdigit():
            kbps = int(int(out[0]) / 1000)
    except Exception:                                  # noqa: BLE001 — probe failure → the default
        pass
    return f"{max(96, min(320, kbps))}k"


def dedup_names(originals: list, fmt: str) -> list:
    """Output basenames for `originals` in the chosen format, de-duplicated with a numeric
    suffix so two inputs that reduce to the same name (a.mp3 + a.wav → a.mp3) can coexist
    in one flat ZIP. Order-preserving and deterministic — computed ONCE, before fan-out, so
    parallel workers never race to name their outputs. For 'match source' the extension is
    per-input (a name-only decision), so a mixed batch keeps each file's own container."""
    used, out = set(), []
    for name in originals:
        stem, ext = _out_stem(name), _ext_for(fmt, name)
        cand = f"{stem}.{ext}"
        n = 2
        while cand.lower() in used:
            cand = f"{stem} ({n}).{ext}"
            n += 1
        used.add(cand.lower())
        out.append(cand)
    return out


def land_output(processed_wav: Path, dst: Path, fmt: str, source=None) -> Path:
    """Land one processed WAV as the chosen output at `dst` (mono). WAV = MOVE the processed
    file into place (it IS the output, no re-encode); MP3 = encode at the chosen bitrate. For
    'match source', `dst`'s extension already decided the container (dedup_names); an MP3 target
    is encoded at the SOURCE's own bitrate (probed here — `source` must still exist on disk).

    The bitrate goes STRAIGHT to encode_mp3 — this deliberately bypasses enhance.mp3_bitrate(),
    which encodes the one fixed speech rule and has no user choice to honor."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if fmt == SOURCE_FORMAT:
        if dst.suffix.lower() == ".mp3":
            import playground_clips
            playground_clips.encode_mp3(processed_wav, dst, bitrate=source_bitrate(source))
        else:
            shutil.move(str(processed_wav), str(dst))
        return dst
    spec = FORMATS[fmt]
    if spec["bitrate"] is None:
        shutil.move(str(processed_wav), str(dst))      # the WAV is the output
    else:
        import playground_clips                        # local: keeps enhance's heavy chain lazy
        playground_clips.encode_mp3(processed_wav, dst, bitrate=spec["bitrate"])
    return dst


# Back-compat alias: the enhance engine only ever uses concrete formats, for which land_output
# and the old encode_output are identical.
def encode_output(processed_wav: Path, dst: Path, fmt: str) -> Path:
    return land_output(processed_wav, dst, fmt)


def format_label(fmt: str) -> str:
    return SOURCE_LABEL if fmt == SOURCE_FORMAT else FORMATS[fmt]["label"]


def decode_to_wav(src, dst) -> Path:
    """Decode any source to a mono WAV at `dst`, atomically. The DFN3 denoise child reads with
    soundfile, which can't read MP3/etc., so a bulk clean-up decodes each input first — the same
    step the book's denoise path takes. Done here (not via cleanup._decode_wav) so Bulk owns its
    own decode: the temp keeps a real `.wav` extension and `-f wav` is explicit, so ffmpeg always
    knows the output format from the name."""
    import subprocess
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.stem + ".part.wav")
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-f", "wav", str(tmp), "-loglevel", "error"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not tmp.is_file():
        Path(tmp).unlink(missing_ok=True)
        raise RuntimeError(f"could not decode {Path(src).name}: {(r.stderr or '').strip()[:200]}")
    os.replace(tmp, dst)
    return dst


# ── config ────────────────────────────────────────────────────────────────────

@dataclass
class BulkConfig:
    scratch_root: Path      # <scratch>/ — every batch lives under one dir here


def resolve_config(app_settings: dict = None, base_dir: Path = None) -> BulkConfig:
    """Select the Bulk scratch root. `VOCALIS_BULK_DIR` overrides the default `<scratch>/bulk` directory. The named subdirectory is skipped by startup scratch cleanup so recovery can adopt completed work before sweeping; batch lifetime follows the configured scratch root."""
    root = os.environ.get("VOCALIS_BULK_DIR")
    if not root:
        root = scratch.scratch_root(app_settings) / scratch.BULK_SUBDIR
    return BulkConfig(scratch_root=Path(root))


# ── the engine contract ─────────────────────────────────────────────────────
# The per-file work is INJECTED. An engine is any object with:
#
#   slots(job)            -> list of worker identities. One worker thread per slot. Enhance
#                            hands back the selected CUDA devices (one worker per card);
#                            Clean up hands back range(cpu_pool) (no card pinning). len()
#                            is how wide the fan-out runs.
#   process(job, src, dst, slot) -> Path | None
#                            Process ONE file: read `src`, write the finished output at
#                            EXACTLY `dst` (the caller pre-computed the de-duplicated name),
#                            return `dst`. Return None if canceled mid-file. Raise on a real
#                            failure — run_bulk_job aborts the whole batch and keeps nothing.
#                            The engine owns its own resource claim/release (a card, a CPU
#                            slot) and its own scratch teardown.


@dataclass
class BulkJob:
    id: str
    mode: str                       # "enhance" | "cleanup"
    fmt: str                        # a FORMATS key
    nfe: int = 0                    # enhance only (0 for cleanup)
    cards: list = field(default_factory=list)     # enhance: the selected CUDA devices
    inputs: list = field(default_factory=list)    # [(staged_path:str, original_name:str)] — set by the route
    total: int = 0
    done: int = 0
    audio_s: float = 0.0            # total input duration, for the up-front ETA
    status: str = "queued"          # queued|running|done|failed|canceled
    stage: str = ""                 # ""|processing|zipping
    error: str = None
    result_zip: str = ""            # path to result.zip once complete
    manifest: dict = field(default_factory=dict)
    started_at: float = 0.0
    events: list = field(default_factory=list)
    subscribers: list = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


def new_job(**kw) -> BulkJob:
    job = BulkJob(id=uuid.uuid4().hex[:12], **kw)
    with JOBS_LOCK:
        JOBS[job.id] = job
        finished = [j for j in JOBS.values() if j.status in ("done", "failed", "canceled")]
        for j in finished[:max(0, len(JOBS) - JOBS_KEEP)]:
            JOBS.pop(j.id, None)
    return job


def get_job(job_id: str):
    with JOBS_LOCK:
        return JOBS.get(job_id)


def live_job() -> "BulkJob":
    """The queued/running batch, if any — there is only ever meant to be one (a new upload
    replaces the last result, design §7). The start route rejects a second while one runs."""
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.status in ("queued", "running"):
                return j
    return None


def _set_current(job_id: str, mode: str):
    with _CURRENT_LOCK:
        _CURRENT_IDS[_mode_or_die(mode)] = job_id


def current_job(mode: str) -> "BulkJob":
    """THIS MODE's retained (completed) batch, or None. What its tab renders on load (§5b)."""
    with _CURRENT_LOCK:
        cid = _CURRENT_IDS.get(_mode_or_die(mode), "")
    j = get_job(cid) if cid else None
    return j if (j is not None and j.status == "done") else None


def manifest_of(job: "BulkJob") -> dict:
    """The last-batch summary the tab renders. Empty for a job that isn't a finished batch."""
    if job is None or job.status != "done" or not job.manifest:
        return {}
    m = dict(job.manifest)
    m["job_id"] = job.id
    m["has_result"] = bool(job.result_zip and Path(job.result_zip).is_file())
    return m


# ── persistence across restart + housekeeping (design §7, §8.3) ──────────────

DEFAULT_TTL_DAYS = 7


def _reconstruct(work: Path, manifest: dict) -> "BulkJob":
    """Rebuild a done BulkJob from a batch dir on disk (its id IS the dir name) and adopt it
    as the current batch. This is what makes "refresh and it's still there" survive a server
    RESTART — the in-memory JOBS registry is gone by then, so the manifest on disk is the
    source of truth."""
    job = BulkJob(
        id=work.name,
        mode=manifest.get("mode", "enhance"),
        fmt=manifest.get("format", DEFAULT_FORMAT),
        nfe=int(manifest.get("nfe") or 0),
        status="done",
        stage="",
        total=int(manifest.get("count", 0)),
        done=int(manifest.get("count", 0)),
        result_zip=str(work / "result.zip"),
        manifest=manifest,
        started_at=float(manifest.get("created", 0.0)),
    )
    with JOBS_LOCK:
        JOBS[job.id] = job
    _set_current(job.id, job.mode)
    return job


def startup_recover(cfg: BulkConfig, ttl_days: float = None) -> dict:
    """At startup: adopt the last completed batch PER MODE, reap crash-orphans and anything
    past its TTL. Returns {mode: manifest} for what was adopted. Idempotent; never raises.

    · A dir with result.zip + manifest.json is a COMPLETE batch — a candidate to adopt.
    · A dir without them is crash-orphaned (an in/ or out/ a killed run left behind) — reaped.
    · The NEWEST candidate PER MODE is kept (§5b: one batch each, so at most two); the rest go.
      This used to keep the single newest overall, which quietly deleted your Enhance ZIP on
      restart if a Clean-up batch happened to be newer.
    · A TTL (default 7 days, env VOCALIS_BULK_TTL_DAYS) drops a forgotten batch so Windows
      temp — which the OS never reclaims — doesn't grow one that outlives its welcome. On
      Unix /tmp clears on reboot and this rarely fires; it is the Windows safety net.
    """
    if ttl_days is None:
        try:
            ttl_days = float(os.environ.get("VOCALIS_BULK_TTL_DAYS") or DEFAULT_TTL_DAYS)
        except (TypeError, ValueError):
            ttl_days = DEFAULT_TTL_DAYS
    root = Path(cfg.scratch_root)
    try:
        if not root.exists():
            return None
        complete = []
        for d in root.iterdir():
            if not d.is_dir() or d.name == STAGING_DIR:
                continue                                     # staging is not a batch — never reap it
            zipf, manf = d / "result.zip", d / "manifest.json"
            if zipf.is_file() and manf.is_file():
                try:
                    complete.append((d, json.loads(manf.read_text(encoding="utf-8"))))
                except (OSError, ValueError):
                    shutil.rmtree(d, ignore_errors=True)     # unreadable manifest — not adoptable
            else:
                shutil.rmtree(d, ignore_errors=True)         # crash-orphaned in/out — reap
        if not complete:
            return {}
        complete.sort(key=lambda t: t[1].get("created", 0), reverse=True)
        adopted, seen = {}, set()
        for d, m in complete:
            mode = m.get("mode", "enhance")
            if mode not in MODES or mode in seen:
                shutil.rmtree(d, ignore_errors=True)         # superseded, or a mode we don't run
                continue
            seen.add(mode)                                   # newest per mode wins (§5b)
            if ttl_days and (time.time() - float(m.get("created", 0))) > ttl_days * 86400:
                shutil.rmtree(d, ignore_errors=True)         # forgotten past its TTL
                continue
            adopted[mode] = manifest_of(_reconstruct(d, m))
        return adopted
    except Exception:                                        # never block startup
        logger.exception("bulk startup recovery failed")
        return {}


# ── the lifecycle (engine-agnostic) ──────────────────────────────────────────

def _job_dir(cfg: BulkConfig, job_id: str) -> Path:
    return Path(cfg.scratch_root) / job_id


def clear_batches(cfg: BulkConfig, mode: str = None, keep: str = "") -> None:
    """Delete batch dirs under the scratch root. This is both the implicit reset (a new run
    wipes that mode's previous batch — design §7) and the explicit Clear.

    `mode=None` clears BOTH modes. `mode='enhance'` clears only Enhance's retained batch and
    LEAVES Clean up's alone (§5b) — without that, starting one batch would delete the other
    tab's ZIP out from under it, which is the shared-state bug in a new costume. Crash-orphans
    (dirs no mode is holding) go either way. `keep` is never deleted.

    NEVER touches the staging area (§5a) — those are the user's picked files, not a batch."""
    root = Path(cfg.scratch_root)
    if not root.exists():
        return
    protect = {keep} if keep else set()
    with _CURRENT_LOCK:
        if mode is not None:
            _mode_or_die(mode)
            protect |= {cid for m, cid in _CURRENT_IDS.items() if cid and m != mode}
    for d in root.iterdir():
        if d.is_dir() and d.name != STAGING_DIR and d.name not in protect:
            shutil.rmtree(d, ignore_errors=True)
    with _CURRENT_LOCK:
        for m, cid in list(_CURRENT_IDS.items()):
            if cid and cid not in protect:
                _CURRENT_IDS[m] = ""


# ── the staging area: pick now, run later (design §5a) ───────────────────────

def staging_dir(cfg: BulkConfig, mode: str) -> Path:
    """This MODE's staging folder. Enhance and Clean up never see each other's files (§5b)."""
    return Path(cfg.scratch_root) / STAGING_DIR / _mode_or_die(mode)


def _staged_path(cfg: BulkConfig, mode: str, name: str) -> Path:
    """Resolve a CLIENT-SUPPLIED name to a path inside the staging dir, or raise.

    `Path(name).name` strips any directory part, so '../../etc/passwd' collapses to 'passwd'
    — but we re-check the resolved parent anyway rather than trust that one line, because
    this name arrives straight off an HTTP request and a delete route is not the place to be
    clever. Empty/dot names are rejected outright."""
    base = Path(str(name or "")).name
    if not base or base in (".", ".."):
        raise ValueError("invalid name")
    root = staging_dir(cfg, mode)
    p = root / base
    if p.resolve().parent != root.resolve():
        raise ValueError("invalid name")
    return p


def staged_files(cfg: BulkConfig, mode: str) -> list:
    """What is staged FOR THIS MODE, newest LAST — the folder is the source of truth (that is
    the point: the tab repopulates from this on load, so a refresh, a new tab, or a server
    restart all show the same list). Sorted by mtime so the order matches the pick order."""
    root = staging_dir(cfg, mode)
    if not root.is_dir():
        return []
    out = []
    for p in root.iterdir():
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        out.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
    out.sort(key=lambda r: r["mtime"])
    return out


def stage_add(cfg: BulkConfig, mode: str, files: list) -> list:
    """Add uploaded `(filename, stream)` pairs to one mode's staging area and return the current staged-file list. Picks accumulate across requests; a repeated name replaces that staged file atomically."""
    root = staging_dir(cfg, mode)
    root.mkdir(parents=True, exist_ok=True)
    for filename, stream in files:
        try:
            dst = _staged_path(cfg, mode, filename)
        except ValueError:
            logger.warning(f"refusing to stage a file with a bad name: {filename!r}")
            continue
        tmp = dst.with_name(dst.name + ".part")               # atomic: a killed upload leaves no row
        try:
            with open(tmp, "wb") as f:
                shutil.copyfileobj(stream, f)
            os.replace(tmp, dst)
        finally:
            Path(tmp).unlink(missing_ok=True)
    return staged_files(cfg, mode)


def stage_remove(cfg: BulkConfig, mode: str, name: str) -> bool:
    """Delete ONE staged file from this mode. True if it was there. The row goes with it — the
    folder is the list, so there is no second place to keep in sync."""
    try:
        p = _staged_path(cfg, mode, name)
    except ValueError:
        return False
    try:
        p.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        logger.exception(f"could not remove the staged file {name!r}")
        return False


def stage_clear(cfg: BulkConfig, mode: str) -> int:
    """Remove all — empties THIS MODE's staging area (never the other's). How many went."""
    root = staging_dir(cfg, mode)
    if not root.is_dir():
        return 0
    n = 0
    for p in root.iterdir():
        if p.is_file():
            try:
                p.unlink()
                n += 1
            except OSError:
                logger.exception(f"could not remove the staged file {p.name!r}")
    return n


def copy_result_to_staging(cfg: BulkConfig, src_mode: str, dst_mode: str) -> list:
    """Copy a finished ZIP into another mode's staging area and return the new list. Replace the destination rather than merge; callers should confirm before replacing a nonempty workspace. Extract through the staged-path validator so archive names cannot escape the destination."""
    _mode_or_die(src_mode)
    _mode_or_die(dst_mode)
    job = current_job(src_mode)
    if job is None or not job.result_zip or not Path(job.result_zip).is_file():
        raise FileNotFoundError(f"no finished {src_mode} batch to copy")
    stage_clear(cfg, dst_mode)                               # replace, not merge
    root = staging_dir(cfg, dst_mode)
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(job.result_zip) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            try:
                dst = _staged_path(cfg, dst_mode, info.filename)
            except ValueError:
                logger.warning(f"refusing to extract a zip member with a bad name: "
                               f"{info.filename!r}")
                continue
            tmp = dst.with_name(dst.name + ".part")
            try:
                with z.open(info) as src_f, open(tmp, "wb") as f:
                    shutil.copyfileobj(src_f, f)
                os.replace(tmp, dst)
            finally:
                Path(tmp).unlink(missing_ok=True)
    return staged_files(cfg, dst_mode)


def stage_from_staging(cfg: BulkConfig, job: BulkJob) -> int:
    """Seed a batch from the staging area: COPY (never move) staged/* into <job>/in/ and record
    (staged_path, original_name), exactly as stage_uploads does from a multipart POST.

    A COPY, deliberately. run_bulk_job's §8 contract unlinks each input the moment its output is
    encoded — pointing job.inputs straight at the staging folder would make a run quietly EAT the
    user's picked files one by one. Copying keeps the job dir self-contained and leaves the list
    intact, so a batch can be re-run at a different bitrate without re-picking.

    Reads the staging area for the JOB's OWN mode (§5b) — never the other tab's files."""
    src = staged_files(cfg, job.mode)
    if not src:
        job.inputs, job.total = [], 0
        return 0
    in_dir = _job_dir(cfg, job.id) / "in"
    in_dir.mkdir(parents=True, exist_ok=True)
    root = staging_dir(cfg, job.mode)
    inputs = []
    for i, row in enumerate(src):
        orig = row["name"]
        dst = in_dir / f"{i:04d}__{orig}"
        shutil.copy2(root / orig, dst)
        inputs.append((str(dst), orig))
    job.inputs = inputs
    job.total = len(inputs)
    return len(inputs)


def stage_uploads(cfg: BulkConfig, job: BulkJob, files: list) -> int:
    """Copy the multipart uploads into <job>/in/ and record (staged_path, original_name) on
    the job. `files` is [(filename, stream), …]. On-disk names are indexed so two uploads
    named the same can't clobber each other; the ORIGINAL name is what the output is named
    after (design §5, filenames preserved). Returns how many landed."""
    in_dir = _job_dir(cfg, job.id) / "in"
    in_dir.mkdir(parents=True, exist_ok=True)
    inputs = []
    for i, (filename, stream) in enumerate(files):
        orig = Path(str(filename or f"file{i}")).name or f"file{i}"
        staged = in_dir / f"{i:04d}__{orig}"
        with open(staged, "wb") as f:
            shutil.copyfileobj(stream, f)
        inputs.append((str(staged), orig))
    job.inputs = inputs
    job.total = len(inputs)
    return len(inputs)


def run_bulk_job(job: BulkJob, cfg: BulkConfig, engine) -> None:
    """Drive one batch end to end on a daemon thread: fan the injected engine across its
    slots, ZIP the outputs, persist as the last batch, tear the transient material down.

    Cleanup contract (design §8):
      · per-file — a source's upload is unlinked the moment its output exists and encoded.
      · on completion — in/ and out/ go; the ZIP is the record.
      · on cancel/failure — the whole batch dir goes; a canceled batch produces no ZIP.
    """
    work = _job_dir(cfg, job.id)
    in_dir, out_dir = work / "in", work / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        job.status = "running"
        job.started_at = time.time()
        emit(job, {"type": "job_start", "id": job.id, "kind": "bulk", "mode": job.mode})

        if not job.inputs:
            raise RuntimeError("no input files were staged for this batch")

        # Name every output up front (deterministic, race-free) and enqueue the work.
        out_names = dedup_names([orig for _p, orig in job.inputs], job.fmt)
        job.stage = "processing"
        emit(job, {"type": "stage", "stage": "processing"})
        todo = queue.Queue()
        for i, (staged, orig) in enumerate(job.inputs):
            todo.put((i, Path(staged), orig, out_dir / out_names[i]))
        errors = []

        def worker(slot):
            while not job.cancel.is_set():
                try:
                    i, src, orig, dst = todo.get_nowait()
                except queue.Empty:
                    return
                try:
                    result = engine.process(job, src, dst, slot)
                    if result is None:              # canceled mid-file
                        return
                    src.unlink(missing_ok=True)     # per-file teardown, only after success (§8.1)
                    with job.lock:
                        job.done += 1
                        done = job.done
                    emit(job, {"type": "progress", "done": done, "total": job.total})
                    emit(job, {"type": "log",
                               "line": f"[{done}/{job.total}] ✓ {orig} → {dst.name}"})
                except Exception as exc:            # noqa: BLE001
                    logger.exception(f"bulk {job.mode} failed on {orig}")
                    errors.append(exc)
                    return

        slots = list(engine.slots(job))
        threads = [threading.Thread(target=worker, args=(s,), daemon=True,
                                    name=f"bulk-{job.id}-{s}") for s in slots]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        if job.cancel.is_set():
            job.status = "canceled"
            emit(job, {"type": "canceled"})
            shutil.rmtree(work, ignore_errors=True)
            return
        if errors:
            raise errors[0]

        produced = sorted(p for p in out_dir.iterdir() if p.is_file())
        if not produced:
            raise RuntimeError("the batch produced no output files")

        job.stage = "zipping"
        emit(job, {"type": "stage", "stage": "zipping"})
        result = work / "result.zip"
        with zipfile.ZipFile(result, "w", zipfile.ZIP_STORED) as z:   # MP3/WAV don't deflate
            for p in produced:
                z.write(p, p.name)

        manifest = {
            "mode": job.mode,
            "format": job.fmt,
            "format_label": format_label(job.fmt),
            "nfe": job.nfe if job.mode == "enhance" else None,
            "count": len(produced),
            "names": [p.name for p in produced],
            "size": result.stat().st_size,
            "created": time.time(),
        }
        (work / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        job.result_zip = str(result)
        job.manifest = manifest

        # On completion the transient material goes; the ZIP + manifest are the record (§8.2).
        shutil.rmtree(in_dir, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)

        job.status = "done"
        job.stage = ""
        _set_current(job.id, job.mode)                              # retained under ITS mode (§5b)
        emit(job, {"type": "job_done", **manifest})
    except Exception as exc:                                        # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        logger.exception(f"bulk job {job.id} failed")
        emit(job, {"type": "error", "message": str(exc)})
        shutil.rmtree(work, ignore_errors=True)                    # a failed batch keeps nothing
