#!/usr/bin/env python3
"""Drive Applio training through its CLI: prepare audio, preprocess, extract features, train, build the index, and register the resulting model. Run the long training process in a detached systemd scope when available so it can survive a Vocalis restart; persist enough state to reattach, report progress, and resume from checkpoints. Cancellation stops the scope, preserving checkpoints for a later resume. Serialize training jobs while allowing compatible work on another card."""
import bisect
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from loguru import logger

# Aliased to keep `enhance_mod.` explicit at every call site — this module has an
# `enhance_nfe` field and an enhance STAGE, and a bare `enhance.` reads ambiguously
# between the two. (Card pinning now lives inside enhance.run_enhance, so voiceswap's
# _card_env is no longer needed here.)
import enhance as enhance_mod
import scratch
import vault_fs
import vault_store
from vault import VaultAuthError       # vault authentication errors are handled below
from book_to_audio import safe_name
from enhance import EnhanceConfig
from voiceswap import (AUDIO_EXTS, NOISE_MARKERS, _run_stage, duration_of, emit,
                       ffprobe_duration, list_voices, _now)

# Applio training defaults
SAMPLE_RATE      = 40000
VOCODER          = "HiFi-GAN"        # matches the pretraineds already on disk
EMBEDDER         = "contentvec"
CUT_PREPROCESS   = "Automatic"
INCLUDE_MUTES    = 2
# Save candidates every five epochs. This bounds how far a saved checkpoint can be from the best epoch while keeping the latest resumable generator/discriminator pair separate from candidate voices.
SAVE_EVERY_EPOCH = 5

# GAN training can diverge when the discriminator wins: generator gradients stop improving and the mel loss can settle on a worse plateau. Detect this from the smoothed mel-loss curve; the running minimum cannot show a sustained regression. Without a signal, training can continue writing worse checkpoints after collapse.
DIVERGENCE_RATIO  = 1.25   # smoothed loss this far above the best…
DIVERGENCE_EPOCHS = 5      # …for this many consecutive epochs ⇒ it is not coming back
DIVERGENCE_MIN_EPOCH = 8   # epoch 1-2 are wild by nature; do not shoot a healthy start

# Use a 60-epoch no-new-best interval as advice, not an automatic stop. RVC loss improves in uneven steps, so a fixed interval can include a continuing gradual decline. The UI reports the plateau and leaves the decision to the operator.
PLATEAU_EPOCHS = 60
PLATEAU_MIN_EPOCH = 40     # never call it early: a slow start is not a plateau
BATCH_SIZE       = 8
INDEX_ALGORITHM  = "Auto"
CPU_CORES        = 12
F0_METHODS       = ("rmvpe", "crepe", "crepe-tiny", "fcpe")
F0_DEFAULT       = "rmvpe"
EPOCHS_DEFAULT   = 200

TRIM_SECONDS       = 3600            # "only use the first 60 minutes"
CACHE_GPU_MAX_MIN  = 60.0            # cache_data_in_gpu=False above this
SOFT_MIN_MINUTES   = 10.0            # under this: warn, never block
# ETA model: the PoC measured ~48 s/epoch on a 9-minute dataset (epoch 1 ≈ 130 s
# with the one-time MIOpen warmup); s/epoch scales ~linearly with dataset length.
POC_EPOCH_S   = 48.0
POC_MINUTES   = 9.0
WARMUP_EXTRA_S = 82.0                # epoch-1 surcharge (130 − 48)

STATE_FILE = "vocalis_train.json"    # in logs/<name>/ — the reattach anchor
LOG_FILE   = "vocalis_train.log"     # the detached train's tee'd output
# Persist a concise outcome record so the UI can explain why a run ended after transient log output is no longer available.
OUTCOME_FILE = "vocalis_outcome.json"

_NAME_RE   = re.compile(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,47}\Z")
_WEIGHT_RE = r"_(\d+)e_(\d+)s\.pth\Z"
_EPOCH_RE  = re.compile(r"\bepoch=(\d+)\b")
_SPEED_RE  = re.compile(r"training_speed=([\d:]+)")
_STEP_RE   = re.compile(r"\bstep=(\d+)\b")
# `lowest_value=0.3184 (epoch 137 and step 3973)` — the best loss SO FAR and, more
# usefully, WHERE it happened. Applio has been printing this all along and we parsed
# only `epoch` out of the line and dropped the rest on the floor (7b②).
_LOSS_RE   = re.compile(r"lowest_value=([\d.]+)(?:\s*\(epoch (\d+) and step (\d+)\))?")

EVENT_CAP = 5000
JOBS_KEEP = 30
JOBS = {}
JOBS_LOCK = threading.Lock()


class TrainFailed(RuntimeError):
    """A training run exited early. Twin of voiceswap.StageFailed.

    `str(exc)` is a SAFE summary (epoch counters) — that is what logger.exception writes
    into logs/vocalis.log, outside the vault. `.detail` carries the child's last output
    line and the model-dir path, both of which spell the VOICE NAME. Browser only."""

    def __init__(self, message: str, *, detail: str = ""):
        super().__init__(message)
        self.detail = detail

# ── one training PER CARD, not one training total (7a) ───────────────────────
# The ETA model is 48 s/epoch on a 9-minute dataset, scaling linearly with dataset
# length — so the "40–60 minutes is optimal" advice we give, at the default 200
# epochs, is a 13–18 HOUR job. A single global lock meant two proper voices ran
# back to back: 26–36 hours, which does not fit in a night. On two cards they run
# concurrently and it does.
#
# The engine was already multi-job shaped: JOBS is a dict, every job records its own
# pgid/scope, every training has its own Applio log dir and state file, reattach()
# already returns a LIST, and the GPU pin is already per-job. The single global
# TRAIN_LOCK was the ONLY serializer. It is now one lock per card.
_CARD_LOCKS = {}
_CARD_LOCKS_GUARD = threading.Lock()


def card_lock(gpu: int) -> threading.Lock:
    with _CARD_LOCKS_GUARD:
        return _CARD_LOCKS.setdefault(int(gpu), threading.Lock())


# ── config ────────────────────────────────────────────────────────────────────

@dataclass
class TrainConfig:
    """Resolve training paths from environment variables, then app_settings.yaml, then platform defaults. Keep all paths configurable; do not bake an installation path into source."""
    applio_dir: Path       # Applio checkout: core.py, .venv/, logs/
    rvc_dir: Path          # RVC voice registry (deploy target; swap picker scans it)
    training_dir: Path     # source-clip repository — bulky user media on the share
    # Bandwidth extension lives in its OWN venv (resemble-enhance pins torch 2.1.1
    # against our 2.13) so it gets its own config, resolved alongside ours rather than
    # separately — there is one place to look for "where does a toolchain live".
    enhance: EnhanceConfig = None

    @property
    def python(self) -> Path:
        if os.name == "nt":
            return self.applio_dir / ".venv" / "Scripts" / "python.exe"
        return self.applio_dir / ".venv" / "bin" / "python"

    @property
    def logs_dir(self) -> Path:
        return self.applio_dir / "logs"

    def model_dir(self, name: str) -> Path:
        return self.logs_dir / name

    def dataset_dir(self, name: str) -> Path:
        # Prepared datasets keep living beside the sources (not the cache dir):
        # "Start over" re-preprocesses from here even after a cache wipe.
        return self.training_dir / "_datasets" / name


def dataset_wavs(cfg: TrainConfig, name: str) -> list:
    """Return one prepared WAV per selected clip. Keep clips separate so the trainer slices within a coherent source instead of across concatenated boundaries. Use vault_fs logical listings so counting encrypted files does not open or decrypt their contents."""
    d = cfg.dataset_dir(name)
    return sorted(d / nm for nm in vault_fs.glob(d, "*.wav"))


def dataset_minutes(cfg: TrainConfig, name: str) -> float:
    """Length is a property of the DATASET, not of any one clip (R5) — the ETA, the
    10-minute minimum and the GPU-cache cutoff all key off this sum.

    `ffprobe_duration` routes at its own door (voiceswap), so this reads the vault. It pays a
    decrypt-to-scratch per WAV — up to ~317 MB for a full 60-minute dataset — and it is paid
    ONCE, at the launch of a job that is about to spend thirteen hours on a GPU. Not worth a
    sidecar: `_datasets/` is rewritten by every prep, so a cache keyed to it would be cold
    exactly as often as it was warm."""
    return round(sum(ffprobe_duration(p) for p in dataset_wavs(cfg, name)) / 60, 1)


INSTALL_ROOT = Path(__file__).resolve().parent.parent


def resolve_config(app_settings: dict, base_dir: Path = None) -> TrainConfig:
    s = app_settings.get("voiceswap") or {}
    root = Path(base_dir or INSTALL_ROOT)

    def pick(env_key, settings_key, default):
        return Path(os.environ.get(env_key) or s.get(settings_key) or default)

    return TrainConfig(
        applio_dir=pick("VOCALIS_APPLIO_DIR", "applio_dir", Path.home() / "Applio"),
        # Keep the trained-voice registry with other irreplaceable application assets so it can be backed up independently of downloadable model weights.
        rvc_dir=pick("VOCALIS_RVC_DIR", "rvc_dir", root / "voice_models"),
        # Keep user-managed training clips under the install root, separate from generated media. Vocalis may read generated media for supported imports but does not write there.
        training_dir=pick("VOCALIS_TRAINING_DIR", "training_dir",
                          root / "voice_training"),
        enhance=enhance_mod.resolve_config(app_settings, root),
    )


def clean_name(raw: str) -> str:
    """Voice name → filesystem-safe model name (it becomes a directory under
    Applio logs/ AND the registry file stem). Whitespace collapses to _ ;
    anything else suspicious is rejected outright."""
    name = re.sub(r"\s+", "_", str(raw or "").strip())
    if not _NAME_RE.fullmatch(name) or name.strip(".") == "" or ".." in name:
        raise ValueError(
            "voice name must be 1–48 characters: letters, digits, . _ - "
            "(it becomes the model's file name)")
    return name


# Applio writes its experiment workspace directly, outside the application vault. The application cannot transparently encrypt those child-process writes, and copying checkpoints into the vault would race active writes and repeatedly copy large resume state. Require an in-tree sentinel before training so a missing encrypted mount fails closed. The sentinel proves that the configured mount is present; it does not independently prove the filesystem is encrypted.
WORKSPACE_SENTINEL = ".vocalis_encrypted"


def workspace_encrypted(cfg: TrainConfig) -> bool:
    """Is Applio's workspace on the encrypted volume the operator set up? A plain `is_file`,
    NOT `vault_fs.exists`: `logs_dir` is outside every root, so it never routes — and asking
    the router would be asking the wrong question anyway. The question is about the MOUNT."""
    return (Path(cfg.logs_dir) / WORKSPACE_SENTINEL).is_file()


def workspace_required(cfg: TrainConfig) -> bool:
    """Do we ENFORCE it? Only on a box that encrypts anything at all.

    INERT until the vault is initialized — the same rule as `vault_store.route()`, and for the
    same reason. An un-migrated box, a dev box and the entire test suite keep every store in
    cleartext BY DESIGN, and refusing to train on them would be a regression that protects
    nothing. The day the vault exists, so does this."""
    s = vault_store.STORE
    return s is not None and s.is_initialized()


def check_workspace(cfg: TrainConfig) -> None:
    """Refuse to launch a training that would write the user's voice to the platter in the
    clear. Raises; `run_train_job` fails the job like any other, having changed nothing."""
    if not workspace_required(cfg) or workspace_encrypted(cfg):
        return
    # Distinguish a workspace path that does not exist from an existing but unmounted volume. The first is a configuration error that mounting cannot fix; the second is the mount failure this guard detects. Report the correct cause so the operator can take the right action.
    if not Path(cfg.logs_dir).exists():
        cause = (f"That path does not exist, so this is a CONFIGURATION error and not a mount "
                 f"one — no amount of mounting will fix it. VOCALIS_APPLIO_DIR (or "
                 f"app_settings.yaml voiceswap.applio_dir) names {cfg.applio_dir}, and there is "
                 f"no Applio checkout there. Point it at the one that is installed.")
    else:
        cause = ("The usual cause is that the volume simply is not mounted — mount it and start "
                 "the training again.")
    raise RuntimeError(
        f"the training workspace is NOT on the encrypted volume, so this run would write about "
        f"5 GB in cleartext — your recorded voice, sliced up, and every checkpoint — and nothing "
        f"would ever say so. Refusing to start. Nothing has been changed.\n\n"
        f"    workspace:  {cfg.logs_dir}\n"
        f"    expected:   a mounted encrypted volume holding {WORKSPACE_SENTINEL}\n\n"
        f"{cause} See DESIGN_5_0_ENCRYPTION §8.6 for the one-time setup.")


# ── source clips (upload repository + playground imports) ───────────────────

def _source_meta_path(p: Path) -> Path:
    """`<clip>.mp3` and `<clip>.wav` have separate sidecars. Use the full filename, including extension, so two clips with the same stem do not share metadata."""
    return p.with_name(p.name + ".yaml")


class SourceSidecarUnreadable(Exception):
    """A training clip's sidecar exists but will not parse. Writers must ABORT on this,
    never persist from an empty map.

    Same shape, same reason as playground_clips.ClipSidecarUnreadable — but the loss here
    is worse. The sidecar's `enhanced` field is the ONLY pointer to the cache entry, which
    is named by a hash of the source and therefore cannot be found BY source (see
    _record_enhanced). Overwrite it and the enhanced WAV is still on disk, still costing
    317 MB an hour, and permanently unreachable — while the next prep re-spends the
    GPU-hour deriving a byte-identical file."""


def _read_source_meta(p: Path, *, strict: bool = False) -> dict:
    """strict=True (the WRITE paths) raises SourceSidecarUnreadable on a corrupt file
    instead of returning {}: an empty map is a fine basis for a READ (the row shows
    blanks) and a catastrophic basis for a WRITE.

    An ABSENT file is not corrupt — it returns {} even when strict, because there is
    nothing there to destroy."""
    q = _source_meta_path(p)
    if not vault_fs.exists(q):
        return {}
    try:
        return yaml.safe_load(vault_fs.read_text(q)) or {}
    except Exception as e:
        # The path is the CLIP's name, and a clip carried in from the Playground is named
        # after the user's prompt (playground_clips.clip_stem). Log the failure, not the
        # words — logs/vocalis.log sits outside the vault.
        logger.warning(f"training-clip sidecar unreadable — ignoring it ({type(e).__name__})")
        if strict:
            raise SourceSidecarUnreadable(str(e)) from e
        return {}


def _write_source_meta(p: Path, meta: dict) -> None:
    """Write source metadata atomically through the vault-aware YAML writer so temporary files do not expose plaintext inside a routed store."""
    try:
        vault_fs.write_yaml_atomic(_source_meta_path(p), meta)
    except Exception as e:                                     # noqa: BLE001
        # A cache that cannot be written is a slow listing, not a broken one.
        logger.warning(f"could not write training-clip sidecar ({type(e).__name__})")


# Allowed provenance values populate the Speech tab badge and are stored on the clip sidecar. Keep import paths synchronized with this set; unknown values are ignored.
PROVENANCE = {"uploaded", "playground", "stems", "cleaned",   # output of the cleanup tool
              "scene"}                                        # vocals extracted from a scene clip


def _set_provenance(src: Path, provenance: str) -> None:
    """Stamp a clip's origin on its sidecar. An unknown value is ignored rather than
    stored — a badge nobody defined is worse than no badge."""
    if provenance not in PROVENANCE:
        return
    _write_source_meta(src, {**_read_source_meta(src), "provenance": provenance})


def _record_enhanced(src: Path, cached: Path, nfe: int, trim) -> None:
    """Record the cache path and source identity on the clip sidecar. The cache uses an opaque hashed path, so the sidecar provides the link needed for the UI to offer the enhanced file. Store size and modification time so replacement audio under the same filename does not reuse a stale enhancement."""
    try:
        meta = _read_source_meta(src, strict=True)
    except SourceSidecarUnreadable:
        # We cannot merge into a file we could not read, and overwriting it would destroy
        # whatever it still holds. Losing the pointer costs a re-enhance; overwriting the
        # sidecar costs the clip's metadata AND still orphans the cache entry. Refuse.
        # The enhancement itself succeeded and the dataset WAV is already written — a
        # failed bookkeeping write must not fail the training run.
        logger.warning("training-clip sidecar unreadable — NOT recording the enhanced "
                       "pointer over it (the clip keeps whatever it has)")
        return
    # enhance.source_stat, not src.stat(): this identity must agree with the one
    # enhance.cache_path keys on, or the sidecar says "ready" about an entry the cache
    # cannot find. One seam, one answer (5.0 §7.7.2).
    st = enhance_mod.source_stat(src)
    ident = {"enhanced_size": st[0], "enhanced_mtime": st[1]} if st else {}
    _write_source_meta(src, {**meta, "enhanced": str(cached),
                             "enhanced_nfe": int(nfe),
                             "enhanced_trim": int(trim) if trim else 0, **ident})


def _source_row(p: Path) -> dict:
    """Build one source row for the UI, including measured bandwidth and duration. Reuse sidecar measurements for unchanged files and avoid audio probes when cached values remain valid."""
    # LOGICAL, not p.stat(): the size is SHOWN in the pool listing, and a raw stat under the
    # vault is the CIPHERTEXT size — every clip would read ~750 bytes heavier than it is. The
    # mtime is what the listing SORTS on, so it needs the sub-second float, which is exactly
    # what vault_fs.stat keeps and `source_stat` (the cache-KEY seam) int()s away.
    st = vault_fs.stat(p)
    if st is None:
        raise FileNotFoundError(str(p))        # what p.stat() did; every caller already races a delete
    # A LISTING MUST NOT BE A WRITE PATH FOR A FILE IT COULD NOT READ. 4.1 gave this row a
    # cache write (the bandwidth measurement), so merely ENTERING the Voice Training tab
    # overwrote every corrupt sidecar with three bandwidth fields — destroying `enhanced`,
    # the only pointer to a cache entry that cannot be enumerated back to its source. The
    # WAV survives, unreachable, and the next prep re-spends the GPU-hour.
    #
    # Measure and DISPLAY either way; persist only over a sidecar we actually read.
    try:
        meta = _read_source_meta(p, strict=True)
        readable = True
    except SourceSidecarUnreadable:
        meta, readable = {}, False
    hz, fresh = enhance_mod.bandwidth_of(p, meta)
    # Read duration and bandwidth from the same sidecar so listing clips avoids a separate ffprobe process per clip. Persist refreshed metadata only when the existing sidecar was readable.
    dur, fresh_dur = duration_of(p, meta)
    fresh = {**(fresh or {}), **(fresh_dur or {})}
    if fresh and readable:
        _write_source_meta(p, {**meta, **fresh})
    # The enhanced WAV lives in a cache, which is documented as safe to wipe — so the
    # pointer is checked, not trusted. A stale one just means the button is not offered.
    enh = str(meta.get("enhanced") or "")
    # The pointer resolving is not enough: enhance.cache_path keys on (path, size, mtime), so
    # a clip REPLACED under the same name still points at a real WAV of the old audio. Only an
    # identity match means "this cache entry is for this file". Sidecars written before the
    # identity was recorded have no size/mtime to check — trust the pointer, as we did then,
    # and the next prep rewrites them properly rather than re-enhancing an hour of audio.
    e_size, e_mtime = meta.get("enhanced_size"), meta.get("enhanced_mtime")
    ident = enhance_mod.source_stat(p)      # the seam, so this agrees with cache_path
    fresh_enh = (e_size is None or e_mtime is None or ident is None
                 or (int(e_size) == ident[0] and int(e_mtime) == ident[1]))
    return {"ref": p.name, "name": p.stem, "size": st.size,
            "mtime": st.mtime, "duration_s": dur,
            "bandwidth_hz": hz,
            # Where it came from (§2) — "uploaded" | "playground" | "stems", or None
            # for a clip that predates 4.3. The Speech tab turns this into a badge.
            "provenance": meta.get("provenance"),
            # 4.4: a cleaned clip records what it was derived from and how, for the row's
            # "Cleaned up" badge tooltip. None on every non-cleaned clip.
            "cleaned_from": meta.get("cleaned_from"),
            "cleanup": meta.get("cleanup"),
            "band_limited": enhance_mod.is_band_limited(hz),
            # `enh` points into cache_root()/enhanced — the CACHE vault. Its plaintext name is
            # not on disk, so a bare Path.is_file() answers False for every entry we have and
            # the "download the enhanced WAV" button would simply never appear again.
            "enhanced_ready": bool(enh and fresh_enh and vault_fs.exists(enh)),
            "enhanced_nfe": meta.get("enhanced_nfe"),
            # The trim the cached WAV was built at. `band_limited` describes the SOURCE and
            # never changes — enhancement writes a separate cached WAV and never touches the
            # MP3 — so it cannot answer "will this cost GPU time?". Only (nfe, trim) matching
            # what this run will ask for can, and the UI has to be able to see it.
            "enhanced_trim": int(meta.get("enhanced_trim") or 0)}


def prep_plan(srcs: list, trim60: bool, nfe: int, rows: dict = None) -> list:
    """Build the single per-source plan shared by the prep estimate and execution loop. Include budget trimming, bandwidth status, and whether enhanced audio is already cached. Band-limited describes the source; cached describes whether work will consume GPU time."""
    budget = float(TRIM_SECONDS) if trim60 else None
    rows = rows if rows is not None else {}
    plan = []
    for src in srcs:
        row = rows.get(src) or _source_row(src)
        duration = row["duration_s"] or 0
        trim, skip = None, False
        if budget is not None:
            if budget <= 1:
                skip = True                       # the dataset budget is already full
            elif duration == 0 or duration > budget:
                trim = int(budget)
        limited = bool(row["band_limited"])
        plan.append({
            "src": src,
            "name": src.name,
            "trim": trim,
            "skip": skip,
            "duration_s": duration,
            # What the enhancer actually reads: ffmpeg trims BEFORE it ever sees the audio.
            "audio_s": 0.0 if skip else float(trim if trim else duration),
            "band_limited": limited,
            # vault_fs.exists, not .is_file(): the cache entry lives in the CACHE vault, where
            # its plaintext name is not on disk. A bare is_file() answers False for every entry
            # that exists — so the plan would report "0 reused", the banner would quote sixteen
            # minutes of GPU per clip, and prep would then find the cache and spend none of it.
            # The banner lying in the OTHER direction is what prep_plan was written to stop.
            "cached": bool(limited and not skip
                           and vault_fs.exists(enhance_mod.cache_path(src, nfe, trim))),
        })
        if budget is not None and not skip:
            budget -= float(trim if trim else duration)
    return plan


def prep_cost(plan: list, nfe: int) -> dict:
    """Estimate the preparation work for a plan. `eta_s` is zero when every band-limited clip can reuse a cached enhancement."""
    todo = [r for r in plan if r["band_limited"] and not r["cached"] and not r["skip"]]
    reused = [r for r in plan if r["band_limited"] and r["cached"]]
    audio_s = sum(r["audio_s"] for r in todo)
    return {
        "todo": len(todo),
        "reused": len(reused),
        "full_band": sum(1 for r in plan if not r["band_limited"] and not r["skip"]),
        "audio_s": audio_s,
        # Prep enhances one clip at a time, so each one pays the model load — `files=`.
        "eta_s": (enhance_mod.estimate_seconds(audio_s, nfe, files=len(todo))
                  if todo else 0.0),
    }


def list_sources(cfg: TrainConfig) -> list:
    """Training clips in the repository, newest first, with real durations
    (the UI's 60-min checkbox and ETA both key off duration)."""
    d = Path(cfg.training_dir)
    out = []
    if not vault_fs.is_dir(d):
        return out
    # The vault returns logical names, including directories. Filter by audio suffix and directory status before presenting training clips.
    for nm in vault_fs.listdir(d):
        p = d / nm
        if p.suffix.lower() in AUDIO_EXTS and not vault_fs.is_dir(p):
            out.append(_source_row(p))
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def source_path(cfg: TrainConfig, ref: str):
    """Resolve a source ref (a bare filename) or None — traversal-safe."""
    name = str(ref or "")
    if not name or Path(name).name != name:
        return None
    p = Path(cfg.training_dir) / name
    return p if vault_fs.exists(p) and p.suffix.lower() in AUDIO_EXTS else None


def save_upload(cfg: TrainConfig, filename: str, stream, overwrite: bool = False) -> dict:
    """Store an uploaded training clip. Raise ValueError for an invalid name or type and FileExistsError for an existing name unless replacement was requested. Stage upload bytes in scratch and use from_scratch to store them; preserve the replace confirmation contract for user-named dataset entries."""
    name = Path(str(filename or "")).name
    ext = Path(name).suffix.lower()
    if not name or ext not in AUDIO_EXTS:
        raise ValueError(f"not an audio file: {filename!r} "
                         f"(accepted: {', '.join(sorted(AUDIO_EXTS))})")
    d = Path(cfg.training_dir)
    vault_fs.mkdir(d)
    dest = d / name
    if vault_fs.exists(dest) and not overwrite:
        raise FileExistsError(name)
    # 9.7.4 — before the bytes, for `import_clip`'s reason: the row is visible the moment the
    # audio lands, so a badge written afterward has a window in which the clip reads as having
    # no known origin. Same order on both import doors, because they are the same hazard.
    _set_provenance(dest, "uploaded")
    # The scratch key is HASHED (scratch.opaque_name), so the clip's name — which for a
    # Playground export is the user's prompt — never lands as a filename.
    with scratch.file(scratch.scratch_root(), f"training-upload|{name}", ext) as tmp:
        with open(tmp, "wb") as f:
            shutil.copyfileobj(stream, f)
        vault_fs.from_scratch(tmp, dest)
    return _source_row(dest)


def import_clip(cfg: TrainConfig, mp3: Path, display_name: str,
                overwrite: bool = False, provenance: str = None) -> dict:
    """Copy an existing Playground or stem-split clip into the training pool under its display name and provenance. Read through the vault-aware source path, stage in scratch, then write through the vault-aware destination path. Preserve the same name-conflict behavior as an upload."""
    if not vault_fs.exists(mp3):
        raise ValueError("clip file not found")
    d = Path(cfg.training_dir)
    vault_fs.mkdir(d)
    dest = d / f"{safe_name(display_name or Path(mp3).stem, 60)}.mp3"
    if vault_fs.exists(dest) and not overwrite:
        raise FileExistsError(dest.name)
    # 🔴 THE BADGE IS STAMPED BEFORE THE AUDIO LANDS, AND THE ORDER IS THE WHOLE FIX (9.7.4).
    # `list_sources` enumerates AUDIO_EXTS, so a clip becomes visible to `/train/sources` the
    # instant `from_scratch` completes — and the sidecar carrying `provenance` was written after
    # it. Any reader inside that window gets a complete-looking row whose origin is `null`, which
    # is indistinguishable from a pre-4.3 clip whose origin we genuinely do not know. Writing the
    # sidecar first closes it: a reader that can see the mp3 can always see the badge.
    #
    # ⚠️ SAFE IN THE OTHER DIRECTION because the sidecar alone is INVISIBLE. Its path is derived
    # from the destination name (`<clip>.mp3.yaml`), `list_sources` filters on the audio suffix,
    # and `_read_source_meta` returns `{}` for an absent file — so a `from_scratch` that then
    # fails leaves an orphan nothing enumerates, which is strictly better than a visible row that
    # lies about where it came from.
    _set_provenance(dest, provenance)
    with scratch.file(scratch.scratch_root(), f"training-import|{dest.name}", ".mp3") as tmp:
        # Streamed, not read_bytes(): an imported clip is up to an hour of audio, and
        # `open_read` decrypts only the blocks each read actually touches.
        with vault_fs.open_read(mp3) as src, open(tmp, "wb") as f:
            shutil.copyfileobj(src, f)
        vault_fs.from_scratch(tmp, dest)
    return _source_row(dest)


def rename_source(cfg: TrainConfig, ref: str, new_name: str) -> dict:
    """Rename a training clip in place (7f — the playground has this; the pool
    didn't). A pure, atomic file rename: never delete-and-recreate.

    Renaming a clip a training has ALREADY used is safe. Prep copies the audio
    into _datasets/<model>/ at launch, so from that moment the training depends on
    the copy, not on the source file's name. Nothing to re-point.

    Collisions refuse rather than overwrite: the whole point of a rename is that
    you're keeping the audio, so quietly clobbering a different clip with it would
    be the one outcome nobody wants."""
    p = source_path(cfg, ref)
    if p is None:
        raise ValueError(f"training clip not found: {ref}")
    raw = str(new_name or "").strip()
    # Validate the raw name before `safe_name()`: an empty value otherwise becomes the fallback `section.mp3` and silently renames the clip.
    if not raw:
        raise ValueError("the name can't be empty")
    stem = safe_name(raw, 60)
    dest = p.with_name(stem + p.suffix)
    if dest == p:
        return _source_row(p)
    if vault_fs.exists(dest):
        raise FileExistsError(dest.name)
    # A FILE rename, and inside ONE directory. Both of those matter: `vault.rename()` refuses a
    # DIRECTORY outright (a name is SIV-bound to its logical parent, so re-parenting a folder
    # orphans every child in it), and it refuses to cross the vault boundary. Neither applies
    # here — the name simply re-encrypts under the same parent.
    vault_fs.rename(p, dest)
    return _source_row(dest)


def delete_sources(cfg: TrainConfig, refs: list) -> list:
    deleted = []
    for ref in refs:
        p = source_path(cfg, str(ref))
        if p is not None:
            vault_fs.unlink(p)
            # The sidecar goes with it. It holds the clip's measured bandwidth, its duration
            # and the path of its enhanced WAV — metadata about a recording the user has just
            # asked us to delete, and there is nothing left that will ever read it again.
            vault_fs.unlink(_source_meta_path(p), missing_ok=True)
            deleted.append(str(ref))
    return deleted


# ── ETA model ────────────────────────────────────────────────────────────────

def epoch_seconds(dataset_minutes: float, observed_s: float = None) -> float:
    """Best current s/epoch: the live observed speed once epochs report,
    else the PoC formula scaled by dataset length."""
    if observed_s:
        return observed_s
    minutes = dataset_minutes if dataset_minutes and dataset_minutes > 0 else POC_MINUTES
    return POC_EPOCH_S * minutes / POC_MINUTES


def eta_seconds(epochs_left: int, dataset_minutes: float,
                observed_s: float = None, warmed: bool = True) -> float:
    s = max(0, epochs_left) * epoch_seconds(dataset_minutes, observed_s)
    if not warmed:
        s += WARMUP_EXTRA_S                    # one-time MIOpen warmup on epoch 1
    return round(s)


# ── stage command builders (the PoC's verbatim forms) ────────────────────────

def build_prep_cmd(src: Path, dataset_wav: Path, trim_s: int = None) -> list:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning", "-i", str(src)]
    if trim_s:
        cmd += ["-t", str(int(trim_s))]        # output option = accurate trim
    cmd += ["-ar", str(44100), "-ac", "1", str(dataset_wav)]
    return cmd


def build_preprocess_cmd(cfg: TrainConfig, name: str, dataset_dir: Path) -> list:
    return [str(cfg.python), "core.py", "preprocess",
            "--model_name", name, "--dataset_path", str(dataset_dir),
            "--sample_rate", str(SAMPLE_RATE), "--cpu_cores", str(CPU_CORES),
            "--cut_preprocess", CUT_PREPROCESS]


def build_extract_cmd(cfg: TrainConfig, name: str, gpu: int, f0_method: str) -> list:
    return [str(cfg.python), "core.py", "extract",
            "--model_name", name, "--f0_method", f0_method,
            "--sample_rate", str(SAMPLE_RATE), "--gpu", str(gpu),
            "--include_mutes", str(INCLUDE_MUTES),
            "--embedder_model", EMBEDDER, "--cpu_cores", str(CPU_CORES)]


def build_train_cmd(cfg: TrainConfig, name: str, epochs: int, gpu: int,
                    cache_gpu: bool) -> list:
    return [str(cfg.python), "core.py", "train",
            "--model_name", name, "--sample_rate", str(SAMPLE_RATE),
            "--vocoder", VOCODER, "--total_epoch", str(epochs),
            "--batch_size", str(BATCH_SIZE), "--gpu", str(gpu),
            "--save_every_epoch", str(SAVE_EVERY_EPOCH),
            # Keep only the latest generator/discriminator pair because Resume uses that pair; older resume pairs add storage without enabling another continuation. Preserve candidate weights because they are separate deployable voices that users may audition.
            "--save_only_latest", "True", "--save_every_weights", "True",
            "--pretrained", "True", "--overtraining_detector", "False",
            "--cache_data_in_gpu", "True" if cache_gpu else "False",
            "--index_algorithm", INDEX_ALGORITHM]


def build_index_cmd(cfg: TrainConfig, name: str) -> list:
    return [str(cfg.python), "core.py", "index",
            "--model_name", name, "--index_algorithm", INDEX_ALGORITHM]


def find_index(cfg: TrainConfig, name: str):
    """This training's faiss index, or None. `<name>.index` is what core.py writes; the glob
    is a fallback for a run whose index was made under some other name."""
    d = cfg.model_dir(name)
    p = d / f"{name}.index"
    return p if p.is_file() else next(iter(sorted(d.glob("*.index"))), None)


def build_index(cfg: TrainConfig, name: str):
    """Build and return the FAISS index from extracted features, or None when features are unavailable. Index creation is independent of training checkpoints and does not resume or modify the training run."""
    d = cfg.model_dir(name)
    if not (d / "extracted").is_dir():
        logger.warning(f"no extracted features for “{name}” — cannot build its faiss index")
        return None
    logger.info(f"building the faiss index for “{name}” (a minute or two, CPU)…")
    try:
        r = subprocess.run(build_index_cmd(cfg, name), cwd=str(cfg.applio_dir),
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError as exc:                                   # noqa: BLE001 — Applio not there
        logger.warning(f"could not run the index build for “{name}”: {exc}")
        return None
    if r.returncode != 0:
        logger.warning(f"index build failed for “{name}” (rc={r.returncode}): "
                       f"{(r.stderr or r.stdout or '').strip()[-400:]}")
        return None
    idx = find_index(cfg, name)
    logger.info(f"faiss index for “{name}”: {idx}")
    return idx


# ── progress parsing ─────────────────────────────────────────────────────────

def parse_epoch_line(line: str):
    """Parse Applio's per-epoch report:
    `name | epoch=12 | step=348 | time=01:27:09 | training_speed=0:00:48 |
     lowest_value=23.671 (epoch 5 and step 140)`
    → {"epoch", "speed_s", "step", "lowest", "best_epoch", "best_step"} (any of the
    last four may be None), or None for any other line. (tqdm step bars share the
    stream via \\r — callers key off epoch= only.)

    `lowest_value` is the best loss SEEN SO FAR, not this epoch's loss, so the curve
    it traces is a descending staircase — which is exactly the plateau signal you
    want: when it stops stepping down, more epochs are buying nothing. And
    `(epoch N and step S)` names the epoch that achieved it, which is the single
    most useful number for choosing WHICH checkpoint to deploy (7b)."""
    m = _EPOCH_RE.search(line)
    if not m or "|" not in line:
        return None
    speed = None
    ms = _SPEED_RE.search(line)
    if ms:
        speed = 0
        for part in ms.group(1).split(":"):
            speed = speed * 60 + int(part)
    step = int(_STEP_RE.search(line).group(1)) if _STEP_RE.search(line) else None
    lowest = best_epoch = best_step = None
    ml = _LOSS_RE.search(line)
    if ml:
        try:
            lowest = float(ml.group(1))
        except ValueError:
            lowest = None
        if ml.group(2):
            best_epoch, best_step = int(ml.group(2)), int(ml.group(3))
    return {"epoch": int(m.group(1)), "speed_s": speed, "step": step,
            "lowest": lowest, "best_epoch": best_epoch, "best_step": best_step}


# ── training workspace inspection (filesystem = source of truth) ────────────

def latest_weight(cfg: TrainConfig, name: str):
    """Newest deployable weight `<name>_<E>e_<S>s.pth` in logs/<name>/ (highest
    epoch, then step), or None."""
    d = cfg.model_dir(name)
    rx = re.compile(re.escape(name) + _WEIGHT_RE)
    best, best_key = None, (-1, -1)
    if not d.is_dir():
        return None
    for p in d.glob("*.pth"):
        m = rx.fullmatch(p.name)
        if m:
            key = (int(m.group(1)), int(m.group(2)))
            if key > best_key:
                best, best_key = p, key
    return best


def weight_epoch(path) -> int:
    m = re.search(_WEIGHT_RE, str(path or ""))
    return int(m.group(1)) if m else 0


def list_weights(cfg: TrainConfig, name: str) -> list:
    """Return all deployable checkpoints in `logs/<name>/`, ordered by epoch. Training saves candidate weights at the configured interval so the operator can audition and choose a checkpoint."""
    d = cfg.model_dir(name)
    rx = re.compile(re.escape(name) + _WEIGHT_RE)
    out = []
    if not d.is_dir():
        return out
    for p in d.glob("*.pth"):
        m = rx.fullmatch(p.name)
        if m:
            # 🔴 GLOB-THEN-STAT IS A RACE, AND A DELETE IS EXACTLY WHAT LOSES IT. The Storage
            # pane re-reads `/train/disk` the moment a prune returns, and the browser polls it
            # while the DELETE is still unlinking — so a name that existed at glob time is gone
            # a microsecond later and `p.stat()` raises FileNotFoundError out of a GET. It was
            # latent until `orphan_deploys` began walking every workspace on every summary,
            # which is what turned a narrow window into one the suite hits on most runs.
            # A checkpoint that vanished mid-scan is simply not a checkpoint any more.
            try:
                st = p.stat()
            except OSError:
                continue
            out.append({"file": p.name, "epoch": int(m.group(1)),
                        "step": int(m.group(2)), "size": st.st_size,
                        "mtime": st.st_mtime})
    out.sort(key=lambda r: (r["epoch"], r["step"]))
    return out


def weight_path(cfg: TrainConfig, name: str, epoch: int):
    """The checkpoint for a specific epoch (the newest, if several share it)."""
    rows = [w for w in list_weights(cfg, name) if w["epoch"] == int(epoch)]
    return cfg.model_dir(name) / rows[-1]["file"] if rows else None


def _digest(fh, limit: int = None) -> str:
    """SHA-256 of `fh`, or of its first `limit` bytes."""
    h = hashlib.sha256()
    left = limit
    while left is None or left > 0:
        blk = fh.read(1 << 20 if left is None else min(1 << 20, left))
        if not blk:
            break
        h.update(blk)
        if left is not None:
            left -= len(blk)
    return h.hexdigest()


#: Narrow on the first mebibyte before reading a whole checkpoint. An RVC weight is ~55 MB and a
#: workspace holds a hundred of them, so a full hash of every same-size candidate is 5.8 GB of
#: reads to answer one question. Two distinct checkpoints diverge in their first tensors, so this
#: cuts the candidate set to one or none; the full compare then confirms it.
_HEAD = 1 << 20

#: Key the cache by registry path rather than the config object; request handlers may construct a fresh config for each request.
#: Do not key by the candidate inventory. Pruning changes that inventory, and a stale cached name is harmless because results are matched against files that still exist.
_ORPHAN_CACHE = {}


def orphan_deploys(cfg: TrainConfig) -> dict:
    """Match registry voices without provenance sidecars to training checkpoints by content hash. Include the registry voice name and epoch; use file size only as a prefilter. If the vault is locked or the registry cannot be read, report provenance as unknown rather than as no deployed voices. Cache against name, size, and mtime so later deployments invalidate the result."""
    # A LOCKED vault is tolerated and nothing else is. `vault_fs.locked_exc()` is the class the
    # readers that must survive a locked store catch by name; a bare `except Exception` here would
    # also swallow a wrong-key decrypt, which is precisely what `VaultAuthError` being a
    # BaseException exists to prevent (vault.py:58) — and the answer would silently become "no
    # voice was deployed from this training", i.e. sweep everything.
    locked = vault_fs.locked_exc()
    tolerate = (OSError, locked) if locked else (OSError,)
    try:
        voices = list_voices(cfg.rvc_dir)
    except tolerate:
        return {}
    orphans = [v for v in voices if not v.get("training")]
    if not orphans:
        return {}
    key = (str(cfg.rvc_dir), tuple(sorted((v["name"], v["size"], v["mtime"]) for v in voices)))
    hit = _ORPHAN_CACHE.get(key[0])
    if hit and hit[0] == key[1]:
        return hit[1]
    # 🔴 THE WORKSPACES ARE ENUMERATED HERE RATHER THAN VIA `list_trainings`, AND THAT IS NOT A
    # SHORTCUT — it is the fix for a RecursionError. `list_trainings` calls `deployed_from`, which
    # calls this, which called `list_trainings`. The cycle blew the stack on the first request the
    # browser spec made, three frames deep in `pathlib`, and the traceback names `vault_fs.exists`
    # rather than anything in this module. Only `list_weights` is needed here, and it touches the
    # registry not at all, so the loop cannot re-form.
    by_size = {}
    logs = cfg.logs_dir
    for d in (sorted(logs.iterdir()) if logs.is_dir() else []):
        if not d.is_dir() or d.name.lower().startswith("mute"):
            continue
        for w in list_weights(cfg, d.name):
            by_size.setdefault(w["size"], []).append(
                (d.name, w["epoch"], cfg.model_dir(d.name) / w["file"]))
    out = {}
    for v in orphans:
        cands = by_size.get(v["size"])
        if not cands:
            continue
        vp = cfg.rvc_dir / v["pth"]
        try:
            with vault_fs.open_read(vp) as fh:
                vhead = _digest(fh, _HEAD)
        except tolerate as exc:                        # locked vault, or the file went away
            logger.debug(f"orphan provenance: cannot read {v['name']}: {exc}")
            continue
        vfull = None
        for tname, ep, p in cands:
            try:
                with open(p, "rb") as fh:
                    if _digest(fh, _HEAD) != vhead:
                        continue
                if v["size"] > _HEAD:
                    if vfull is None:
                        with vault_fs.open_read(vp) as fh:
                            vfull = _digest(fh)
                    with open(p, "rb") as fh:
                        if _digest(fh) != vfull:
                            continue
            except tolerate:
                continue
            out.setdefault(tname, []).append((int(ep), v["name"]))
            break
    if len(_ORPHAN_CACHE) > 8:                         # one registry in production; many in tests
        _ORPHAN_CACHE.clear()
    _ORPHAN_CACHE[key[0]] = (key[1], out)
    return out


def deployed_epochs(cfg: TrainConfig, name: str) -> set:
    """Return the epochs from training `name` that have registry voices, using provenance sidecars rather than filenames. A deployed voice may be renamed, so the sidecar remains authoritative. Use the legacy `orphan_deploys` fallback for voices deployed before sidecars existed; see its contract before changing this path because it protects the checkpoint currently in use."""
    out = set()
    for v in list_voices(cfg.rvc_dir):
        if v.get("training") == name and v.get("epoch"):
            out.add(int(v["epoch"]))
    return out | {ep for ep, _ in orphan_deploys(cfg).get(name, [])}


def delete_weights(cfg: TrainConfig, name: str, epochs) -> dict:
    """Delete candidate checkpoints of one training. Returns {deleted, freed, kept}.

    🔴 WHY THIS IS SAFE, AND IT IS THE ONE FACT THE WHOLE FEATURE RESTS ON. A 200-epoch run banks
    a full deployable weight every SAVE_EVERY_EPOCH epochs — ~40 candidate voices, gigabytes of
    them, and you keep one. Deleting the rest is safe because `deploy_model` COPIES the weight
    into the registry (`_copy`, not a hardlink, deliberately: swap_hash() folds the file's size
    and mtime into every swap's identity). So a deployed voice is fully independent of this
    directory, exactly as `delete_training`'s docstring already relies on.

    What you lose by pruning a candidate is the ability to deploy THAT EPOCH later without
    retraining. Nothing else — not the deployed voice, not the loss curve, not Resume.

    🔴 THE TWO REFUSALS ARE COPIED FROM `delete_training` AND BOTH ARE LOAD-BEARING.

    A LIVE training is still writing into this directory, so deleting from under it is worse than
    it sounds. And "live" has two sources of truth, only one of which is in memory: `live_name()`
    asks JOBS, which a restarted Vocalis rebuilds from the state files — and `reattach()` SKIPS a
    state file it cannot read. So a state file that exists and will not parse is not a license to
    delete; it is the one case where we cannot answer the question the guard exists to ask, and on
    the other side of the answer is an eighteen-hour run. Refuse, say so, let a human look.

    ⚠️ EPOCHS ARE NAMED EXPLICITLY BY THE CALLER — there is no "delete everything except the best"
    here, and that is deliberate. A sweep that picks for you is one bad heuristic away from
    deleting the checkpoint you were about to audition, and the caller (the Review pane) is the
    only place that knows what the human is looking at.

    ⚠️ AND ONLY FILES `list_weights` ALREADY VOUCHED FOR ARE TOUCHED. The epochs are matched
    against its rows rather than turned into a path, so nothing here can be talked into unlinking
    an arbitrary file by a crafted request.
    """
    name = clean_name(name)
    if live_name(name):
        raise RuntimeError(f"training '{name}' is running — cancel it first")
    try:
        read_state(cfg, name, strict=True)
    except TrainStateUnreadable as exc:
        raise RuntimeError(
            f"training '{name}' has a state file that cannot be read, so there is no way to know "
            f"whether it is still running — and reattach() would have skipped it after a restart, "
            f"which is exactly when this looks safe and is not. Nothing was deleted. Check "
            f"{STATE_FILE} in its log directory ({exc})") from exc

    want = {int(e) for e in (epochs or [])}
    if not want:
        raise ValueError("no epochs given")
    rows = list_weights(cfg, name)
    known = {r["epoch"] for r in rows}
    unknown = sorted(want - known)
    if unknown:
        raise ValueError(f"training '{name}' has no checkpoint for epoch(s) {unknown}")

    d = cfg.model_dir(name)
    deleted, freed = [], 0
    for r in rows:
        if r["epoch"] not in want:
            continue
        f = d / r["file"]
        try:
            # ⚠️ st_nlink, not st_size. A file with another link alive frees NOTHING when this one
            # goes, and reporting its size as reclaimed would be a lie the user cannot check.
            # Weights are copied so this is normally 1 — but `deploy_model` hardlinks the INDEX on
            # a non-vault box, and the day someone links a weight too, this stays honest.
            st = f.stat()
            f.unlink()
            deleted.append({"epoch": r["epoch"], "file": r["file"], "size": r["size"]})
            freed += r["size"] if st.st_nlink <= 1 else 0
        except FileNotFoundError:
            continue                      # already gone; not an error worth failing the batch for
    logger.info(f"pruned {len(deleted)} checkpoint(s) from '{name}', freed {freed} bytes")
    return {"deleted": deleted, "freed": freed, "kept": list_weights(cfg, name)}


# Classify workspace artifacts by their current dependencies and recovery cost so the UI can show what can be rebuilt from available files. Keep candidate deletion in the Prune flow, which can account for the deployed checkpoint.

DISK_CLASSES = [
    {"key": "dataset", "label": "Prepared dataset", "vault": True,
     "what": "your clip selection, copied and encrypted — what preprocess re-slices from",
     "upstream": None, "stage": None, "needed_for": ["preprocess"],
     "cost": "the ability to re-slice this training without picking its clips again"},
    {"key": "sliced", "label": "Sliced audio (40 kHz)", "dirs": ["sliced_audios"],
     "what": "your voice, cut into short takes — the trainer reads these every epoch",
     "upstream": "dataset", "stage": "preprocess", "needed_for": ["train", "resume"],
     "cost": "training and Resume"},
    # The 16 kHz slice is no longer needed after feature extraction. Set `free_when` so the storage view reports it as reclaimable when its downstream features exist, even if its original dataset is unavailable.
    {"key": "sliced16k", "label": "Sliced audio (16 kHz)", "dirs": ["sliced_audios_16k"],
     "what": "a downsampled copy the extract stage reads — and nothing else does",
     "upstream": "dataset", "stage": "preprocess", "needed_for": ["extract"],
     "free_when": "features",
     "cost": "nothing at all, unless you later re-extract features"},
    {"key": "features", "label": "Extracted features", "dirs": ["extracted", "f0", "f0_voiced"],
     "what": "pitch + embeddings — the trainer's other input, and what the index is built from",
     "upstream": "sliced16k", "stage": "extract", "needed_for": ["train", "resume", "index"],
     "cost": "training, Resume, and rebuilding the voice index"},
    {"key": "index", "label": "Voice index", "globs": ["*.index"],
     "what": "the faiss index that makes the Index-rate knob do something",
     "upstream": "features", "stage": "index", "needed_for": ["swap"],
     "cost": "nothing already deployed — a registry voice got its own copy"},
    {"key": "resume", "label": "Resume pair (G_/D_)", "globs": ["G_*.pth", "D_*.pth"],
     "what": "the generator + discriminator state Resume continues from",
     "upstream": None, "stage": None, "needed_for": ["resume"],
     "cost": "Resume. This run could then only be started over, not continued"},
    {"key": "eval", "label": "Loss curve", "dirs": ["eval"],
     "what": "the per-epoch scalars Review ▾ plots to show you where the run flattened",
     "upstream": None, "stage": None, "needed_for": ["curve"],
     "cost": "the curve — you would be picking checkpoints by epoch number alone"},
    {"key": "weights", "label": "Candidate checkpoints", "weights": True, "prune": True,
     "what": "one deployable voice every {save_every} epochs — pick per epoch in Prune",
     "upstream": None, "stage": None, "needed_for": ["deploy"],
     "cost": "the ability to deploy that epoch later without retraining"},
]

_DISK_BY_KEY = {c["key"]: c for c in DISK_CLASSES}


def _tree_bytes(p) -> tuple:
    """`(bytes, files)` under `p`. Applio's workspace, so never routed.

    `os.scandir` rather than `rglob`: `sliced_audios/` is ~8,700 files for a one-hour dataset and
    the summary walks six of those, so the difference between one syscall per entry and three is
    the difference between a pane that opens and a pane you wait on."""
    total = files = 0
    stack = [Path(p)]
    while stack:
        try:
            with os.scandir(stack.pop()) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(Path(e.path))
                            continue
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    files += 1
                    # st_nlink, for delete_weights' reason: a file with another link still alive
                    # frees nothing when this one goes, and reporting its size as reclaimable is a
                    # lie the user cannot check.
                    total += st.st_size if st.st_nlink <= 1 else 0
        except OSError:
            continue
    return total, files


def _vault_tree_bytes(p) -> tuple:
    """`(bytes, files)` under a VAULT path — plaintext sizes, and it opens no files.

    `vault_fs.stat` promises the logical size, which is the only number worth showing: the pane
    is answering "how much of my voice is in here", not "how many bytes of ciphertext"."""
    total = files = 0
    if not vault_fs.is_dir(p):
        return 0, 0
    for q in vault_fs.rglob(p, "*"):
        st = vault_fs.stat(q)
        if st is None or vault_fs.is_dir(q):
            continue
        total += st.size
        files += 1
    return total, files


def _class_paths(cfg: TrainConfig, name: str, spec: dict) -> list:
    """The concrete paths one artifact class covers, for `name`. Nothing here turns a request
    into a path: the class specs are a fixed table in this module and `name` has already been
    through `clean_name`, so a crafted request cannot reach outside the workspace."""
    d = cfg.model_dir(name)
    if spec.get("vault"):
        return [cfg.dataset_dir(name)]
    if spec.get("weights"):
        return [d / w["file"] for w in list_weights(cfg, name)]
    out = [d / sub for sub in spec.get("dirs", [])]
    for pat in spec.get("globs", []):
        out += sorted(d.glob(pat))
    return out


def training_disk(cfg: TrainConfig, name: str) -> dict:
    """Every artifact class of one training, with its size and what deleting it would cost.

    `other` is the remainder — config.json, filelist.txt, model_info.json, vocalis_train.log — and
    it exists so the rows SUM TO THE DIRECTORY. A breakdown whose parts do not add up to the total
    is how a storage pane quietly stops being believed, and this one is answering a question that
    started with "I don't know why I've got 15 gigabytes"."""
    name = clean_name(name)
    d = cfg.model_dir(name)
    rows, seen = [], 0
    for spec in DISK_CLASSES:
        size = files = 0
        for p in _class_paths(cfg, name, spec):
            if spec.get("vault"):
                b, n = _vault_tree_bytes(p)
            elif p.is_dir():
                b, n = _tree_bytes(p)
            else:
                try:
                    st = p.stat()
                    b, n = (st.st_size if st.st_nlink <= 1 else 0), 1
                except OSError:
                    b = n = 0
            size += b
            files += n
        if not spec.get("vault"):
            seen += size
        rows.append({k: spec[k] for k in ("key", "label", "upstream", "stage", "needed_for")}
                    | {"what": spec["what"].format(save_every=SAVE_EVERY_EPOCH),
                       "cost": spec["cost"], "size": size, "files": files,
                       "prune": bool(spec.get("prune")), "vault": bool(spec.get("vault"))})
    have = {r["key"]: r["size"] > 0 for r in rows}
    for r in rows:
        up = r["upstream"]
        # Regenerable means the ONE stage that makes it can run right now. Not "recursively
        # rebuildable in principle" — a chain you would have to walk back three stages is a
        # different offer, and the row would be overselling it.
        r["regen"] = bool(up and have.get(up)) if r["stage"] else False
        r["present"] = have[r["key"]]
        # Nothing on this box reads it any more — the stage it feeds has already produced its
        # output. That outranks rebuildability in the UI, because it means the delete is free
        # whether or not it could ever be remade.
        fw = _DISK_BY_KEY[r["key"]].get("free_when")
        r["free"] = bool(fw and have.get(fw))
    total, _ = _tree_bytes(d)
    rows.append({"key": "other", "label": "Run files", "what": "config.json, filelist.txt, the "
                 "training log — kilobytes, and the run is not readable without them",
                 "cost": "the record of how this run was configured", "size": max(0, total - seen),
                 "files": 0, "upstream": None, "stage": None, "needed_for": [], "regen": False,
                 "present": True, "prune": False, "vault": False, "free": False})
    return {"name": name, "total": total, "rows": rows,
            "dataset": next(r["size"] for r in rows if r["key"] == "dataset"),
            # The headline the pane leads with, because it is the only capability whose loss is
            # permanent: Resume needs all three of these and says so on every row that carries it.
            "can_resume": all(have[k] for k in ("resume", "sliced", "features")),
            "live": live_name(name), "save_every": SAVE_EVERY_EPOCH,
            "deployed": sorted(deployed_epochs(cfg, name)),
            "deployed_names": deployed_from(cfg, name),
            # Include per-epoch size and modification time in the same response. The storage pane can present a current training separately from older candidate checkpoints without making another request for each workspace.
            "weights": [{"epoch": w["epoch"], "size": w["size"], "mtime": w["mtime"]}
                        for w in list_weights(cfg, name)]}


def disk_summary(cfg: TrainConfig) -> dict:
    """Return each training workspace breakdown and a grand total for the storage pane. Gather the comparison in one request rather than one request per training."""
    out = [training_disk(cfg, t["name"]) for t in list_trainings(cfg)]
    per = {}
    for t in out:
        for r in t["rows"]:
            per[r["key"]] = per.get(r["key"], 0) + r["size"]
    return {"trainings": out, "total": sum(t["total"] for t in out),
            "dataset_total": sum(t["dataset"] for t in out), "by_class": per,
            # The yardstick the pane measures an unfinished run against. Served rather than
            # hardcoded in the JS: it is the same constant the trainer is launched with, and two
            # copies of it would disagree the day one moves.
            "epochs_default": EPOCHS_DEFAULT, "save_every": SAVE_EVERY_EPOCH,
            "root": str(cfg.logs_dir)}


def delete_artifacts(cfg: TrainConfig, name: str, keys) -> dict:
    """Delete named artifact classes of one training. Returns {deleted, freed, disk}.

    🔴 THE TWO REFUSALS ARE `delete_weights`' AND THEY ARE HERE FOR THE SAME REASON, ONLY MORE SO.
    A live training is writing into `sliced_audios/` and `extracted/` the entire time it runs, so
    deleting a class from under it does not lose a candidate you could re-deploy later — it kills
    the run. And "live" still has two sources of truth, one of them in memory: a state file that
    EXISTS and will not PARSE is the case where we cannot answer the question, and reattach() would
    already have skipped it after a restart, which is exactly when this looks safe and is not.

    ⚠️ `weights` IS REFUSED BY NAME rather than silently ignored. It appears in the pane so the
    sizes add up; the delete lives in Prune, where all forty epochs are enumerated and the deployed
    ones marked. Accepting it here would route past the one dialog built to stop a blind sweep."""
    name = clean_name(name)
    if live_name(name):
        raise RuntimeError(f"training '{name}' is running — cancel it first")
    try:
        read_state(cfg, name, strict=True)
    except TrainStateUnreadable as exc:
        raise RuntimeError(
            f"training '{name}' has a state file that cannot be read, so there is no way to know "
            f"whether it is still running — and reattach() would have skipped it after a restart, "
            f"which is exactly when this looks safe and is not. Nothing was deleted. Check "
            f"{STATE_FILE} in its log directory ({exc})") from exc

    want = [str(k) for k in (keys or [])]
    if not want:
        raise ValueError("no artifact classes given")
    unknown = [k for k in want if k not in _DISK_BY_KEY]
    if unknown:
        raise ValueError(f"unknown artifact class(es): {', '.join(sorted(unknown))}")
    if "weights" in want:
        raise ValueError("candidate checkpoints are deleted per epoch in Prune, not as a class — "
                         "that dialog lists every epoch with its size and marks the deployed ones")

    before = training_disk(cfg, name)
    sizes = {r["key"]: r["size"] for r in before["rows"]}
    deleted, freed = [], 0
    for key in want:
        spec = _DISK_BY_KEY[key]
        for p in _class_paths(cfg, name, spec):
            if spec.get("vault"):
                vault_fs.rmtree(p)
            elif p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                try:
                    p.unlink()
                except OSError:
                    continue
        deleted.append({"key": key, "label": spec["label"], "size": sizes.get(key, 0)})
        freed += sizes.get(key, 0)
    logger.info(f"deleted {', '.join(d['key'] for d in deleted)} from training '{name}', "
                f"freed {freed} bytes")
    return {"deleted": deleted, "freed": freed, "disk": training_disk(cfg, name)}


# ── the REAL loss curve: Applio's TensorBoard event files ────────────────────
# Applio writes proper per-epoch scalars into logs/<name>/eval/ — loss/g/mel (the
# mel-reconstruction loss, the convergence signal that actually matters), loss/g/total,
# and loss_avg_50/* (a 50-step moving average). We read them straight out of the
# tfevents files, because the alternative signal — `lowest_value` from the log line —
# is a running MINIMUM: it can never rise, so it flattens the moment progress gets
# bumpy, long before the model has converged. Betting an 18-hour run on that would be
# a mistake, and picking a checkpoint from it doubly so.
#
# Parsed by hand rather than by importing TensorBoard: it's a 100-line protobuf subset,
# and pulling a whole TB stack into the TTS server (or shelling out to Applio's venv on
# every chart refresh) to read four floats per epoch would be absurd.
#
# tfevents = TFRecord: [uint64 len][uint32 crc][payload][uint32 crc], payload = Event.
#   Event  { double wall_time = 1; int64 step = 2; Summary summary = 5; }
#   Summary{ repeated Value value = 1; }
#   Value  { string tag = 1; float simple_value = 2; }

def _pb_fields(buf: bytes):
    """Walk a protobuf message: yields (field_number, wire_type, value)."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _pb_varint(buf, i)
        if key is None:
            return
        fn, wt = key >> 3, key & 7
        if wt == 0:                                   # varint
            v, i = _pb_varint(buf, i)
            if v is None:
                return
            yield fn, wt, v
        elif wt == 1:                                 # 64-bit
            yield fn, wt, buf[i:i + 8]
            i += 8
        elif wt == 2:                                 # length-delimited
            ln, i = _pb_varint(buf, i)
            if ln is None or i + ln > n:
                return
            yield fn, wt, buf[i:i + ln]
            i += ln
        elif wt == 5:                                 # 32-bit
            yield fn, wt, buf[i:i + 4]
            i += 4
        else:                                         # groups — TF never emits them
            return


def _pb_varint(buf: bytes, i: int):
    val, shift = 0, 0
    while i < len(buf):
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, i
        shift += 7
        if shift > 63:
            return None, i
    return None, i


def read_tb_scalars(event_dir) -> dict:
    """{tag: [(step, value), …]} from every tfevents file in a directory, step-sorted.
    Empty (never raises) if the directory, the files or the format aren't what we
    expect — a missing curve degrades to the log fallback, it doesn't break Deploy."""
    import struct
    out = {}
    d = Path(event_dir)
    if not d.is_dir():
        return out
    for f in sorted(d.glob("events.out.tfevents.*")):
        try:
            data = f.read_bytes()
        except OSError:
            continue
        i, n = 0, len(data)
        while i + 12 <= n:
            ln = int.from_bytes(data[i:i + 8], "little")
            i += 12                                   # length + its masked CRC
            if ln <= 0 or i + ln + 4 > n:
                break
            payload, i = data[i:i + ln], i + ln + 4   # payload + its masked CRC
            step = summary = None
            for fn, wt, v in _pb_fields(payload):
                if fn == 2 and wt == 0:
                    step = v
                elif fn == 5 and wt == 2:
                    summary = v
            if summary is None or step is None:
                continue                              # e.g. the file_version record
            for fn, wt, val in _pb_fields(summary):
                if fn != 1 or wt != 2:
                    continue
                tag = value = None
                for f2, w2, v2 in _pb_fields(val):
                    if f2 == 1 and w2 == 2:
                        tag = v2.decode("utf-8", "replace")
                    elif f2 == 2 and w2 == 5 and len(v2) == 4:
                        value = struct.unpack("<f", v2)[0]
                if tag and value is not None and value == value:      # drop NaN
                    out.setdefault(tag, []).append((int(step), float(value)))
    for t in out:
        out[t].sort()
    return out


# Preference order. loss/g/mel is the mel-reconstruction loss — how close the generated
# audio is to the target — which is the one that tracks "does this sound like them yet".
# loss/g/total is the fallback if a future Applio renames it.
LOSS_TAGS   = ("loss/g/mel", "loss/g/total")
SMOOTH_TAGS = ("loss_avg_50/g/mel", "loss_avg_50/g/total")


def _steps_per_epoch(cfg: TrainConfig, name: str, steps: list) -> int:
    """Steps per epoch, for turning TB's step axis into the epoch axis the UI (and
    the checkpoint filenames) speak. The log states both numbers outright; failing
    that, TB emits one point per epoch, so the step delta IS the answer."""
    log = cfg.model_dir(name) / LOG_FILE
    if log.is_file():
        try:
            for line in reversed(re.split(r"[\r\n]+", log.read_text(
                    encoding="utf-8", errors="replace"))):
                info = parse_epoch_line(line)
                if info and info["step"] and info["epoch"]:
                    return max(1, round(info["step"] / info["epoch"]))
        except OSError:
            pass
    deltas = sorted(b - a for a, b in zip(steps, steps[1:]) if b > a)
    return deltas[len(deltas) // 2] if deltas else 1        # median delta


def _smooth_at(steps: list, values: list, step: int, spe: int):
    """Return the latest smoothed loss sample inside the epoch interval (step - spe, step], or None when no sample falls there. Raw and smoothed series use different step grids, so exact matching drops most epochs. Use backward-only samples because the loss average is trailing; a later sample belongs to the next epoch."""
    i = bisect.bisect_right(steps, step) - 1
    if i < 0 or step - steps[i] >= spe:
        return None
    return values[i]


def loss_curve(cfg: TrainConfig, name: str) -> dict:
    """The training's loss history — the real one, from TensorBoard, with the log's
    `lowest_value` staircase as the fallback.

    Returns {curve: [{epoch, step, loss, smooth}], best_epoch, best_step, best_loss,
    source}. `best` is the minimum of the SMOOTHED series where there is one: the raw
    loss is noisy enough that its argmin is often just a lucky epoch, and deploying a
    lucky epoch is not the same as deploying a converged one."""
    tb = read_tb_scalars(cfg.model_dir(name) / "eval")
    raw = next((tb[t] for t in LOSS_TAGS if tb.get(t)), None)
    if raw:
        smooth = next((tb[t] for t in SMOOTH_TAGS if tb.get(t)), None) or []
        spe = _steps_per_epoch(cfg, name, [s for s, _ in raw])
        # read_tb_scalars sorts by step, which is what makes the bisect in _smooth_at valid.
        sm_steps = [s for s, _ in smooth]
        sm_vals = [v for _, v in smooth]
        curve = []
        for s, v in raw:
            sv = _smooth_at(sm_steps, sm_vals, s, spe)
            curve.append({"epoch": max(1, round(s / spe)), "step": s,
                          "loss": round(v, 4),
                          "smooth": None if sv is None else round(sv, 4)})
        # Plateau detection reads off the smoothed series when we have one.
        pool = [(p["smooth"], p) for p in curve if p["smooth"] is not None] \
            or [(p["loss"], p) for p in curve]
        best_v, best_p = min(pool, key=lambda x: x[0])
        return {"curve": curve, "best_epoch": best_p["epoch"], "best_step": best_p["step"],
                "best_loss": best_v, "source": "tensorboard"}
    return _loss_curve_from_log(cfg, name)


_EMPTY_CURVE = {"curve": [], "best_epoch": None, "best_loss": None,
                "best_step": None, "source": "none"}


def _loss_curve_from_log(cfg: TrainConfig, name: str) -> dict:
    """Fallback: the `lowest_value` staircase from the tee log, for a training with no
    TensorBoard events (a very early run, or a workspace whose eval/ was cleaned).

    It's a RUNNING MINIMUM, so it can only fall or stay flat — which makes it a weak
    convergence signal and a poor basis for picking a checkpoint. Used only when the
    real curve isn't there, and the UI says which one it's showing."""
    log = cfg.model_dir(name) / LOG_FILE
    points, best_epoch, best_loss, best_step = [], None, None, None
    if not log.is_file():
        return dict(_EMPTY_CURVE)
    try:
        text = log.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return dict(_EMPTY_CURVE)
    for line in re.split(r"[\r\n]+", text):
        info = parse_epoch_line(line)
        if not info or info["lowest"] is None:
            continue
        points.append({"epoch": info["epoch"], "step": info["step"],
                       "loss": info["lowest"], "smooth": None})
        if info["best_epoch"] is not None:
            best_epoch, best_step = info["best_epoch"], info["best_step"]
            best_loss = info["lowest"]
    # A resume re-walks epochs it already did; keep the LAST reading of each.
    dedup = {p["epoch"]: p for p in points}
    if not dedup:
        return dict(_EMPTY_CURVE)
    return {"curve": [dedup[e] for e in sorted(dedup)], "best_epoch": best_epoch,
            "best_loss": best_loss, "best_step": best_step, "source": "log"}


def _last_logged_epoch(model_dir: Path) -> int:
    """Last epoch= seen in the training log's final 64 KB (0 when none)."""
    log = model_dir / LOG_FILE
    if not log.is_file():
        return 0
    try:
        with open(log, "rb") as f:
            f.seek(max(0, log.stat().st_size - 65536))
            tail = f.read().decode("utf-8", errors="replace")
    except OSError:
        return 0
    last = 0
    for line in re.split(r"[\r\n]+", tail):
        info = parse_epoch_line(line)
        if info:
            last = info["epoch"]
    return last


def list_trainings(cfg: TrainConfig) -> list:
    """Every training workspace under Applio logs/ (skipping Applio's own
    `mute` reference folders), with progress + registry-deploy status — the
    Existing-trainings panel's rows."""
    out = []
    logs = cfg.logs_dir
    if not logs.is_dir():
        return out
    for d in sorted(logs.iterdir(), key=lambda p: p.name.lower()):
        if not d.is_dir() or d.name.lower().startswith("mute"):
            continue
        has_ckpt = any(d.glob("G_*.pth"))
        w = latest_weight(cfg, d.name)
        if not has_ckpt and w is None and not (d / "config.json").exists() \
                and not (d / STATE_FILE).exists():
            continue                            # not a training workspace
        # Epoch reached = the max of the newest weight's epoch and the last
        # logged epoch (weights only land every SAVE_EVERY_EPOCH).
        reached = max(weight_epoch(w), _last_logged_epoch(d))
        st = read_state(cfg, d.name)
        # Use sidecar provenance to identify deployed voices; renaming a registry voice must not erase its training origin.
        deployed = deployed_from(cfg, d.name)
        out.append({
            "name": d.name,
            "epoch": reached,
            "has_checkpoint": has_ckpt,
            "has_weight": w is not None,
            "has_index": (d / f"{d.name}.index").exists() or any(d.glob("*.index")),
            "weights": list_weights(cfg, d.name),
            "deployed": bool(deployed),
            "deployed_names": deployed,
            "live": live_name(d.name),
            # Interrupted: the trainer died (a Vocalis restart before 7c, an OOM,
            # a reboot) without finishing. Checkpoints are intact — Resume works.
            "interrupted": st.get("status") == "interrupted",
            # The requested total epoch count must survive a completed run so Resume can offer the original target instead of a page-level default. Use the outcome record after the live state file is cleared; zero means the requested total is unknown.
            "total_epoch": int(st.get("total_epoch")
                               or read_outcome(cfg, d.name).get("requested") or 0),
            "mtime": d.stat().st_mtime,
        })
    return out


def delete_training(cfg: TrainConfig, name: str):
    """Delete a training workspace (checkpoints, weights, dataset). The
    registry copy in rvc_dir — if deployed — is deliberately untouched: it's a
    usable voice now, not scratch. Refuses while that training is live.

    "Live" has TWO sources of truth and only one of them is in memory. `live_name()` asks
    JOBS, which a restarted Vocalis rebuilds from the state files — and reattach() skips a
    state file it cannot read. So a state file that EXISTS and will not PARSE is not a
    license to delete: it is the one case where we cannot answer the question this guard
    exists to ask, and the thing on the other side of the answer is an eighteen-hour run.
    Refuse, say so, and let a human look at it."""
    name = clean_name(name)
    if live_name(name):
        raise RuntimeError(f"training '{name}' is running — cancel it first")
    try:
        read_state(cfg, name, strict=True)
    except TrainStateUnreadable as exc:
        raise RuntimeError(
            f"training '{name}' has a state file that cannot be read, so there is no way "
            f"to know whether it is still running — and reattach() would have skipped it "
            f"after a restart, which is exactly when this looks safe and is not. Nothing "
            f"was deleted. Check {STATE_FILE} in its log directory ({exc})") from exc
    shutil.rmtree(cfg.model_dir(name), ignore_errors=True)   # Applio's workspace — never routed
    vault_fs.rmtree(cfg.dataset_dir(name))                   # ours, and encrypted


def deployed_from(cfg: TrainConfig, name: str) -> list:
    """Return registry voice names produced by training `name`, using provenance sidecars so renaming a voice does not erase its origin. Include the bare `<name>.pth` form for deployments created before epoch suffixes were added."""
    voices = list_voices(cfg.rvc_dir)
    out = [v["name"] for v in voices if v.get("training") == name]
    # Compare the listed registry names directly. A filesystem existence check may treat differently cased names as the same file and return the wrong deployment match.
    if name not in out and any(v["name"] == name for v in voices):
        out.append(name)
    for _, vname in orphan_deploys(cfg).get(name, []):
        if vname not in out:
            out.append(vname)
    return out


def registry_stem(name: str, epoch: int) -> str:
    """Derive a registry filename from the checkpoint identity. Epoch-suffixed files allow multiple deployed checkpoints from one training to coexist. Keep support for the legacy unsuffixed `<name>.pth` form when reading existing deployments."""
    return f"{name}_{int(epoch)}e"


def deploy_model(cfg: TrainConfig, name: str, epoch: int = None) -> dict:
    """Copy ONE checkpoint + the index into the RVC registry as <name>_<N>e.pth /
    <name>_<N>e.index, plus a .yaml sidecar recording which training and which
    epoch produced it (the registry is a flat directory of .pth files, so without
    the sidecar a voice's provenance is unknowable — see 7g).

    `epoch` picks the checkpoint; omitted, the newest is used (what the end of a
    training does). Atomic; re-deploying the same epoch overwrites itself, which is
    a no-op in practice. The swap picker sees the voice on its next scan — the
    filesystem is the registry."""
    w = weight_path(cfg, name, epoch) if epoch is not None else latest_weight(cfg, name)
    if w is None:
        raise RuntimeError(
            f"no trained weight found in {cfg.model_dir(name)}"
            + (f" for epoch {epoch}" if epoch is not None else "")
            + f" — expected {name}_<epochs>e_<steps>s.pth")
    d = cfg.model_dir(name)
    # Build the voice index during deployment when it is missing. The index is produced at the end of training, so an earlier candidate checkpoint may not have one; without it, the downstream retrieval blend is silently disabled. The index can be built from already-extracted features without changing or resuming the training. The training workspace is outside the application vault, so access it there directly; route only the registry destination through the vault.
    idx = find_index(cfg, name)
    built = False
    if idx is None:
        idx = build_index(cfg, name)
        built = idx is not None
    vault_fs.mkdir(cfg.rvc_dir)
    ep = weight_epoch(w)
    stem = registry_stem(name, ep)

    def _copy(src: Path, dest: Path):
        """Applio's workspace → the registry. **A PLAINTEXT → STORE BOUNDARY**, and the last
        one in the application.

        🔴 NOT `vault_fs.from_scratch(src, dest)`, however much it looks like the right seam.
        `from_scratch` REMOVES its source — it is built for a temp file that has served its
        purpose — and `src` here is APPLIO'S OWN CHECKPOINT: one of the ~20 candidates the
        Deploy dropdown will offer again next week, and, if it is the newest, half of what
        Resume needs. Handing it to from_scratch would deploy the voice and DELETE it from the
        training in the same breath, and the row would still say "deployed" afterward.
        So: copy into the scratch, and let from_scratch eat the COPY."""
        with scratch.file(scratch.scratch_root(), f"deploy|{dest.name}", dest.suffix) as tmp:
            shutil.copyfile(src, tmp)
            vault_fs.from_scratch(tmp, dest)

    def _link(src: Path, dest: Path):
        """Link an index into the registry when it is outside the vault, falling back to a copy when hardlinks are unavailable. For a vault-routed destination, copy through scratch and encrypt on write. Hardlinks share plaintext bytes and cannot be used for per-file encrypted storage. Multiple checkpoints from one training share the same index, so the unencrypted path avoids duplicate copies while the encrypted path preserves the vault boundary."""
        if vault_store.route(dest) is None:
            # When the registry is outside the vault, hardlink the index instead of copying it for every deployed checkpoint from one training. It is the same large file for each epoch. If linking across filesystems is unavailable, copy it; retain the `.index` naming convention expected by `list_voices`.
            tmp = dest.with_name(dest.name + ".part")
            tmp.unlink(missing_ok=True)
            try:
                os.link(src, tmp)
            except OSError:                  # different filesystem, or no hardlink support
                shutil.copyfile(src, tmp)
            os.replace(tmp, dest)
            return
        with scratch.file(scratch.scratch_root(), f"deploy-index|{dest.name}",
                          dest.suffix) as tmp:
            shutil.copyfile(src, tmp)         # Applio's own file, plaintext, staged
            vault_fs.from_scratch(tmp, dest)  # ...and encrypted on the way in

    # The WEIGHT is copied, not linked: swap_hash() folds its st_size and st_mtime into every
    # swap's identity, and that is not a semantic to change in passing. The index is not part
    # of that identity, which is why linking it is safe.
    _copy(w, cfg.rvc_dir / f"{stem}.pth")
    if idx is not None:
        _link(idx, cfg.rvc_dir / f"{stem}.index")
    write_voice_meta(cfg.rvc_dir, stem, {
        "training": name, "epoch": ep, "step": int(re.search(_WEIGHT_RE, w.name).group(2)),
        "checkpoint": w.name, "deployed_at": time.time(),
    })
    return {"pth": f"{stem}.pth", "index": f"{stem}.index" if idx else None,
            "index_built": built, "name": stem, "epoch": ep}


def write_voice_meta(rvc_dir: Path, stem: str, meta: dict):
    """Write provenance beside a deployed voice. The sidecar follows rename and is removed on delete. `rvc_dir` is the registry directory; route writes through `vault_fs` when it is inside the install vault."""
    vault_fs.write_yaml_atomic(Path(rvc_dir) / f"{stem}.yaml", meta)


# ── detach state (the reattach anchor) ───────────────────────────────────────

def state_path(cfg: TrainConfig, name: str) -> Path:
    return cfg.model_dir(name) / STATE_FILE


def write_state(cfg: TrainConfig, name: str, data: dict):
    p = state_path(cfg, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.part")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def outcome_path(cfg: TrainConfig, name: str) -> Path:
    return cfg.model_dir(name) / OUTCOME_FILE


def write_outcome(cfg: TrainConfig, name: str, **fields) -> None:
    """Record WHY a run ended, next to the run. Best-effort: the checkpoints are already on
    disk and usable, so a failed write here costs an explanation, never a voice.

    Same directory and the same plain write as `write_state` above, deliberately — two files
    with one lifetime that were written two different ways would be the drift, not the
    consistency.
    """
    try:
        p = outcome_path(cfg, name)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".json.part")
        tmp.write_text(json.dumps({"at": time.time(), **fields}, indent=1), encoding="utf-8")
        os.replace(tmp, p)
    except OSError as exc:
        logger.warning(f"voicetrain: could not record the outcome for {name}: {exc}")


def read_outcome(cfg: TrainConfig, name: str) -> dict:
    """The recorded reason, or {} — including for every run that finished before this existed."""
    try:
        return json.loads(outcome_path(cfg, name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


class TrainStateUnreadable(Exception):
    """A training's detach-state file exists and will not parse. delete_training must
    ABORT on this.

    The state file is how a training survives a Vocalis restart: reattach() reads it, finds
    the process, and puts the run back into JOBS. `live_name()` — the ONLY thing standing
    between `delete_training` and an rmtree — asks JOBS, and JOBS is in memory. So an
    unreadable state file means reattach() skipped it (:2063), JOBS never learned about it,
    live_name() answers False about a trainer that is on a card RIGHT NOW, and eighteen
    hours of checkpoints go under shutil.rmtree while it is still writing them."""


def read_state(cfg: TrainConfig, name: str, *, strict: bool = False) -> dict:
    """strict=True (delete_training) raises TrainStateUnreadable rather than returning {}.

    ABSENT is not corrupt — a training that was never detached has no state file, and that
    is the normal case, not a failure. It returns {} under both."""
    p = state_path(cfg, name)
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError) as exc:
        if strict:
            raise TrainStateUnreadable(f"{type(exc).__name__}") from exc
        return {}


def clear_state(cfg: TrainConfig, name: str):
    state_path(cfg, name).unlink(missing_ok=True)


def mark_interrupted(cfg: TrainConfig, name: str, state: dict, epoch: int):
    """A training whose process is gone but whose run never finished. NOT failed:
    the checkpoints are intact and Resume continues from the last one. The state
    file stays, restamped — it's what makes the Trainings row say so out loud
    instead of the run just vanishing (or worse, still claiming to be running)."""
    write_state(cfg, name, {**state, "status": "interrupted", "epoch": int(epoch),
                            "interrupted_at": time.time()})


def _pgid_alive(pgid: int) -> bool:
    if os.name == "nt" or not pgid:
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                             # alive, someone else's — treat as live
    except OSError:
        return False


def _kill_group(pgid: int):
    """Terminate the whole training process group with TERM, then KILL after a grace period so child workers do not retain GPU resources. On platforms without process-group signaling, fall back to the single process id as best effort."""
    if not pgid:
        return
    killpg = getattr(os, "killpg", None)
    if killpg is None:
        try:
            os.kill(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        return
    try:
        killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        return
    for _ in range(100):                        # 10 s grace — workers unwind
        if not _pgid_alive(pgid):
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass


# The trainer runs in a transient systemd scope, a sibling cgroup of the service. Restarting the service therefore leaves training alive.
# The scope keeps only the long-running trainer outside the service cgroup. Short-lived Demucs and ffmpeg children stay in the service cgroup and are cleaned up on restart.

SCOPE_PREFIX = "vocalis-train-"
_SCOPE_PROBE = None                             # None = not probed yet


def scope_unit(name: str, job_id: str) -> str:
    """The transient scope for ONE launch. The job-id suffix keeps a relaunch
    (Resume / Start over) from colliding with a scope systemd hasn't reaped yet."""
    return f"{SCOPE_PREFIX}{name}-{str(job_id)[:6]}"


def systemd_scope_available() -> bool:
    """Return whether systemd scopes are available. When unavailable, use the existing detached-process fallback and report that the job cannot receive scope-based restart survival."""
    global _SCOPE_PROBE
    if _SCOPE_PROBE is None:
        _SCOPE_PROBE = False
        if os.name != "nt" and shutil.which("systemd-run"):
            try:
                _SCOPE_PROBE = subprocess.run(
                    ["systemd-run", "--user", "--scope", "--quiet", "true"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=15).returncode == 0
            except (OSError, subprocess.SubprocessError):
                _SCOPE_PROBE = False
        if not _SCOPE_PROBE:
            logger.warning("voicetrain: no `systemd-run --user --scope` here — a "
                           "training will NOT survive a Vocalis restart on this box")
    return _SCOPE_PROBE


def build_launch_cmd(cfg: TrainConfig, name: str, epochs: int, gpu: int,
                     cache_gpu: bool, unit: str = "") -> list:
    """The train command, wrapped in its own systemd scope when we have one."""
    cmd = build_train_cmd(cfg, name, epochs, gpu, cache_gpu)
    if not unit:
        return cmd
    return ["systemd-run", "--user", "--scope", "--quiet", f"--unit={unit}",
            "--collect", "--"] + cmd


def _scope_active(unit: str) -> bool:
    if not unit or os.name == "nt":
        return False
    try:
        r = subprocess.run(["systemctl", "--user", "is-active", f"{unit}.scope"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=15)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.stdout.decode("utf-8", "replace").strip() in ("active", "activating")


def train_alive(pgid: int, unit: str = "") -> bool:
    """Is the training tree still up? The scope is authoritative when there is one
    — it outlives us, and after a Vocalis restart the pgid we recorded may belong
    to a systemd-run that is long gone. The pgid is the fallback (and the only
    answer on a dev box)."""
    return _scope_active(unit) or _pgid_alive(pgid)


def stop_train(pgid: int, unit: str = ""):
    """Stop a training. Stopping the SCOPE kills its whole cgroup, so no spawn
    worker can be orphaned still holding VRAM — the PoC's hard-won lesson, now
    enforced by the kernel instead of by us walking a process group."""
    if unit and _scope_active(unit):
        try:
            subprocess.run(["systemctl", "--user", "stop", f"{unit}.scope"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=90)
        except (OSError, subprocess.SubprocessError):
            pass
        for _ in range(100):                    # 10 s — then fall through to the
            if not train_alive(pgid, unit):     # process group, belt and braces
                return
            time.sleep(0.1)
    _kill_group(pgid)


# ── jobs ─────────────────────────────────────────────────────────────────────

@dataclass
class TrainJob:
    id: str
    name: str
    epochs: int
    gpu: int
    f0_method: str = F0_DEFAULT
    source_ref: str = ""            # empty for resume/reattach
    sources: list = field(default_factory=list)   # the picked clips (§6) — a POOL
    trim60: bool = True
    # Bandwidth extension has NO on/off switch here, deliberately (DESIGN §5.4): training
    # on band-limited audio collapses the run, so an option whose only outcome is a dead
    # run is not an option, it is a trap. Anything band-limited is enhanced; anything
    # already full-band is left alone. Only the step count is a choice.
    enhance_nfe: int = enhance_mod.NFE_DEFAULT
    mode: str = "new"               # new|restart|resume|reattach
    # The epoch an explicit Resume picked up from; -1 until the first epoch reports.
    # plateau_check() restarts its staleness window here — see the `since` argument
    # there. Only a user-driven "resume" earns this: a "reattach" is Vocalis
    # reconnecting to a run that never stopped, and nobody overruled anything.
    resume_from: int = -1
    dataset_minutes: float = 0.0
    cache_gpu: bool = True
    status: str = "queued"          # queued|running|done|failed|canceled|diverged
    diverged: dict = None           # the evidence, when the discriminator won
    plateaued: dict = None          # the evidence, when it simply finished learning
    stage: str = ""                 # prep|preprocess|extract|train|index|deploy
    error: str = None
    epoch: int = 0                  # last epoch seen
    speed_s: float = None           # observed s/epoch (EMA)
    pgid: int = 0
    scope: str = ""                 # systemd scope unit — the training's own cgroup
    started_at: float = 0.0
    last_line: str = ""
    # the loss staircase (7b②) — the plateau is what picks your checkpoint
    curve: list = field(default_factory=list)
    best_epoch: int = None
    best_loss: float = None
    events: list = field(default_factory=list)
    subscribers: list = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


def new_job(**kw) -> TrainJob:
    job = TrainJob(id=uuid.uuid4().hex[:12], **kw)
    with JOBS_LOCK:
        JOBS[job.id] = job
        finished = [j for j in JOBS.values() if j.status in ("done", "failed", "canceled")]
        for j in finished[:max(0, len(JOBS) - JOBS_KEEP)]:
            JOBS.pop(j.id, None)
    return job


def get_job(job_id: str):
    with JOBS_LOCK:
        return JOBS.get(job_id)


def live_name(name: str) -> bool:
    with JOBS_LOCK:
        return any(j.name == name and j.status in ("queued", "running")
                   for j in JOBS.values())


def any_live() -> bool:
    with JOBS_LOCK:
        return any(j.status in ("queued", "running") for j in JOBS.values())


def live_jobs() -> list:
    with JOBS_LOCK:
        return [j for j in JOBS.values() if j.status in ("queued", "running")]


def live_on_gpu(gpu: int):
    """The training occupying a card, or None. One per card: a training owns its
    GPU for hours, so a second one on the same card would just crawl."""
    return next((j for j in live_jobs() if j.gpu == int(gpu)), None)


def job_eta(job: TrainJob) -> float:
    return eta_seconds(job.epochs - job.epoch, job.dataset_minutes,
                       job.speed_s, warmed=job.epoch > 0)


def _stage_ok(job: TrainJob, rc: int, what: str, cfg: TrainConfig = None) -> bool:
    """Epilogue for the non-detached stages: cancel ends the job (checkpoints
    and the dataset are kept), a nonzero exit raises with the child's last
    output line as context.

    `trained` rides on the canceled event so the UI can stop offering Resume for a run
    that never got as far as writing a weight. These stages (prep, enhance, preprocess,
    extract) come BEFORE the trainer — but a resumed run has checkpoints from last time,
    so the answer is a question for the filesystem, not for the stage name.

    Raises TrainFailed, not RuntimeError. `job.last_line` is the CHILD's stdout, and for
    ffmpeg that contains its `-i` path — a training clip carried in from the Playground is
    named after the user's PROMPT (playground_clips.clip_stem). Putting it in `str(exc)`
    puts it in the traceback that logger.exception writes to logs/vocalis.log, defeating
    the job.id-only message run_train_job carefully scrubbed. Safe summary in the message;
    child output in `.detail`, which goes to the browser and nowhere else."""
    if rc == -1 or job.cancel.is_set():
        job.status = "canceled"
        trained = bool(cfg and latest_weight(cfg, job.name))
        emit(job, {"type": "log", "line": "Canceled — nothing else was changed."})
        emit(job, {"type": "canceled", "trained": trained})
        return False
    if rc != 0:
        raise TrainFailed(f"{what} failed (exit {rc})", detail=job.last_line or "")
    return True


def _prep_one(job: TrainJob, cfg: TrainConfig, src: Path, out: Path,
              trim, band_limited: bool) -> bool:
    """Prepare one source clip as a dataset WAV; return False when the job is canceled or fails. External tools read and write scratch copies because source, output, and enhanced cache paths are vault-routed. Remove plaintext scratch files on success, failure, and cancellation, and use opaque names so user-provided clip names do not reach child processes."""
    work = scratch.scratch_root()
    cached = enhance_mod.cache_path(src, job.enhance_nfe, trim)

    def _land(plain: Path) -> None:
        """A finished plaintext WAV in the scratch → the dataset, encrypted, atomically. The
        ONE door into `_datasets/`, so there is one line to get right instead of three."""
        vault_fs.from_scratch(plain, out)

    if not band_limited:
        with vault_fs.child_input(src, work) as s, \
                scratch.file(work, f"dataset|{job.id}|{out.name}", ".wav") as ds:
            rc = _run_stage(job, build_prep_cmd(s, ds, trim))
            if rc == 0 and not ds.exists():
                raise TrainFailed("ffmpeg produced no WAV for a source clip",
                                  detail=f"the clip was “{src.name}”")
            if not _stage_ok(job, rc, "dataset prep", cfg):
                return False
            _land(ds)
        return True

    # Already enhanced this exact clip, at this trim, at these steps? Then it is sixteen
    # minutes of GPU we do not spend again. prep wipes _datasets/ every run, so without
    # this, every retrain re-derives a byte-identical WAV from scratch.
    if vault_fs.exists(cached):
        emit(job, {"type": "log",
                   "line": f"   “{src.name}” — already enhanced, reusing it (no GPU)."})
        _record_enhanced(src, cached, job.enhance_nfe, trim)
        # CACHE vault → INSTALL vault: a decrypt and an encrypt, not a copy.
        #
        # 🔴 And NOT the tempting one-liner `from_scratch(to_scratch(cached), out)`. Outside a
        # vault — an un-migrated box, which is every box today — `to_scratch` hands back
        # `cached` ITSELF rather than a copy, and `from_scratch` REMOVES its source. That line
        # would MOVE the cache entry into the dataset and destroy it, and the next prep would
        # re-spend the GPU-hour it was built to save. `child_input` is the seam that knows the
        # difference: it removes only what it made.
        with vault_fs.child_input(cached, work) as c, \
                scratch.file(work, f"dataset|{job.id}|{out.name}", ".wav") as ds:
            shutil.copyfile(c, ds)
            _land(ds)
        return True

    tmp = enhance_mod.scratch_path(cfg.enhance, src, tag=f"prep|{job.id}")
    # Write enhanced output to scratch, then let `enhance.store_cache` place it in the cache through the vault-aware path.
    enh = enhance_mod.scratch_path(cfg.enhance, src, tag=f"enhanced|{job.id}")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    try:
        with vault_fs.child_input(src, work) as s:
            rc = _run_stage(job, build_prep_cmd(s, tmp, trim))
        if rc == 0 and not tmp.exists():
            # The clip's NAME is the user's prompt when it came in from the Playground, so
            # it rides `.detail` to the browser and stays out of str(exc) → the log.
            raise TrainFailed("ffmpeg produced no WAV for a source clip",
                              detail=f"the clip was “{src.name}”")
        if not _stage_ok(job, rc, "dataset prep", cfg):
            return False

        est = enhance_mod.estimate_seconds(ffprobe_duration(tmp), job.enhance_nfe)
        emit(job, {"type": "log",
                   "line": f"   enhancing “{src.name}” — {job.enhance_nfe} steps, "
                           f"{enhance_mod.eta_note(est)}…"})
        rc = enhance_mod.run_enhance(
            cfg.enhance, tmp, enh, job.enhance_nfe, f"cuda:{job.gpu}",
            cancel=job.cancel,
            on_line=lambda line: emit(job, {"type": "log", "line": line}))
        if rc == 0 and not enh.is_file():
            raise TrainFailed("the enhancer produced no WAV for a source clip",
                              detail=f"the clip was “{src.name}”")
        if not _stage_ok(job, rc, "enhance", cfg):
            return False

        # Copy the enhanced scratch file to the dataset scratch file before `store_cache` consumes it. The cache write encrypts and removes its scratch source; reading the cached path as plaintext would fail.
        with scratch.file(work, f"dataset|{job.id}|{out.name}", ".wav") as ds:
            shutil.copyfile(enh, ds)
            enhance_mod.store_cache(enh, cached)     # scratch → the cache, encrypted, atomic
            _record_enhanced(src, cached, job.enhance_nfe, trim)
            _land(ds)                                # scratch → the dataset, encrypted, atomic
        return True
    finally:
        # plaintext must not outlive the stage — including the enhancer's output, which on
        # a cancel or a failed land is the only other place it exists
        tmp.unlink(missing_ok=True)
        enh.unlink(missing_ok=True)


# ── the detached train stage ─────────────────────────────────────────────────

def launch_train(job: TrainJob, cfg: TrainConfig) -> tuple:
    """Start `core.py train` detached, in its OWN systemd scope (7c): own cgroup,
    own session, output appended to the tee log, state file written for reattach.
    Returns (proc, log_offset)."""
    d = cfg.model_dir(job.name)
    d.mkdir(parents=True, exist_ok=True)
    log = d / LOG_FILE
    offset = log.stat().st_size if log.exists() else 0
    job.scope = scope_unit(job.name, job.id) if systemd_scope_available() else ""
    cmd = build_launch_cmd(cfg, job.name, job.epochs, job.gpu, job.cache_gpu,
                           job.scope)
    kw = {}
    if os.name != "nt":
        kw["start_new_session"] = True
    banner = (f"\n=== vocalis train launch {_now()} — {job.epochs} epochs, "
              f"gpu {job.gpu}"
              + (f", scope {job.scope}.scope (survives a Vocalis restart)"
                 if job.scope else
                 " — NO systemd scope: this training dies with the server")
              + " ===\n")
    with open(log, "ab") as f:
        f.write(banner.encode("utf-8"))
        f.flush()
        offset = f.tell()
        proc = subprocess_popen(cmd, stdout=f, cwd=cfg.applio_dir, **kw)
    try:
        job.pgid = os.getpgid(proc.pid) if os.name != "nt" else proc.pid
    except ProcessLookupError:
        job.pgid = proc.pid
    write_state(cfg, job.name, {
        "name": job.name, "job_id": job.id, "pid": proc.pid, "pgid": job.pgid,
        "scope": job.scope,
        "total_epoch": job.epochs, "gpu": job.gpu, "f0_method": job.f0_method,
        "dataset_minutes": job.dataset_minutes, "cache_data_in_gpu": job.cache_gpu,
        "source": job.source_ref, "sources": job_sources(job),
        "started_at": job.started_at or time.time(),
        "log": str(cfg.model_dir(job.name) / LOG_FILE),
    })
    return proc, offset


def subprocess_popen(cmd, stdout, cwd, **kw):
    """Thin seam so tests can fake the detached launch without a real child."""
    return subprocess.Popen(cmd, stdout=stdout, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, cwd=str(cwd), **kw)


def divergence_check(cfg: TrainConfig, name: str, epoch: int) -> dict:
    """Return divergence evidence when smoothed mel loss stays above the configured multiple of its best value for the configured number of consecutive epochs. Ignore isolated spikes; the raw curve is too noisy for this check."""
    lc = loss_curve(cfg, name)
    curve = lc.get("curve") or []
    best = lc.get("best_loss")
    if not curve or best is None or best <= 0 or epoch < DIVERGENCE_MIN_EPOCH:
        return {}

    # The smoothed series is the signal; the raw one is far too noisy to judge on.
    smooth = [(p["epoch"], p["smooth"]) for p in curve if p.get("smooth") is not None]
    if not smooth:
        return {}

    # One value per epoch (the last sample in it), newest last.
    by_epoch = {}
    for e, v in smooth:
        by_epoch[e] = v
    epochs = sorted(by_epoch)
    recent = [by_epoch[e] for e in epochs[-DIVERGENCE_EPOCHS:]]
    if len(recent) < DIVERGENCE_EPOCHS:
        return {}

    limit = best * DIVERGENCE_RATIO
    if not all(v > limit for v in recent):
        return {}

    return {"best_loss": round(best, 3),
            "best_epoch": lc.get("best_epoch"),
            "current_loss": round(recent[-1], 3),
            "ratio": round(recent[-1] / best, 2),
            "epochs": DIVERGENCE_EPOCHS}


def plateau_check(cfg: TrainConfig, name: str, epoch: int, since: int = 0) -> dict:
    """Return plateau evidence when smoothed loss has not established a new best within the configured interval. This differs from divergence, which requires sustained loss regression. A plateau is advisory and does not stop training.

        `since` is the epoch an explicit Resume started from. It resets the trigger interval while the evidence continues to report staleness from the true best epoch, preventing an immediate repeat of the prior stop.
    """
    if epoch < PLATEAU_MIN_EPOCH:
        return {}
    lc = loss_curve(cfg, name)
    best_e, best_v = lc.get("best_epoch"), lc.get("best_loss")
    if not best_e or best_v is None:
        return {}
    if epoch - max(int(best_e), int(since or 0)) < PLATEAU_EPOCHS:
        return {}
    return {"best_epoch": int(best_e), "best_loss": round(best_v, 3),
            "stale_epochs": epoch - int(best_e)}


def follow_train(job: TrainJob, cfg: TrainConfig, proc=None, offset: int = 0):
    """Tail the tee log while the training tree lives: parse epoch= lines into
    progress events, honor cancel (group kill), and decide the outcome when
    the tree exits. `proc` is None on reattach — aliveness then comes from the
    state file's pgid. Returns 'done' | 'canceled' | 'failed'."""
    log = cfg.model_dir(job.name) / LOG_FILE
    buf = ""
    last_plain = 0.0
    diverged = {}          # set once, by handle(); acted on by the loop below
    plateaued = {}         # likewise — but this one is SUCCESS, not failure

    def handle(piece: str):
        nonlocal last_plain
        piece = piece.strip()
        if not piece or any(n in piece for n in NOISE_MARKERS):
            return
        job.last_line = piece
        info = parse_epoch_line(piece)
        if info:
            job.epoch = info["epoch"]
            if job.mode == "resume" and job.resume_from < 0:
                job.resume_from = max(0, info["epoch"] - 1)
            if info["speed_s"]:
                job.speed_s = (info["speed_s"] if job.speed_s is None
                               else round(0.5 * job.speed_s + 0.5 * info["speed_s"], 1))
            if info["lowest"] is not None:
                # The chart itself is drawn from the REAL TensorBoard curve, refreshed
                # from /train/weights. This is just the headline number for the log line.
                job.best_loss = info["lowest"]
                if info["best_epoch"] is not None:
                    job.best_epoch = info["best_epoch"]
            emit(job, {"type": "epoch", "epoch": job.epoch, "total": job.epochs,
                       "speed_s": job.speed_s, "eta_s": job_eta(job),
                       "step": info["step"], "lowest": info["lowest"],
                       "best_epoch": job.best_epoch})
            eta = job_eta(job)
            emit(job, {"type": "log",
                       "line": f"epoch {job.epoch}/{job.epochs}"
                               + (f" — {job.speed_s:.0f}s/epoch" if job.speed_s else "")
                               + f" · ~{int(eta // 3600)}h {int(eta % 3600 // 60):02d}m left"
                               # "best loss 16.94 @ epoch 71" is engineer-speak, and the
                               # number is meaningless on its own — it is only comparable
                               # against THIS run. What a human wants from this line is
                               # WHICH EPOCH to keep.
                               + (f" · closest so far: epoch {job.best_epoch}"
                                  + (f" ({job.best_loss:g})" if job.best_loss is not None
                                     else "")
                                  if job.best_epoch else "")})

            # Check divergence once per epoch while the run is healthy. Report it once, keep training, and retain the flag so completion cannot auto-deploy a collapsed run.
            if not diverged:
                try:
                    d = divergence_check(cfg, job.name, job.epoch)
                except Exception as e:               # noqa: BLE001
                    # A guard that crashes the run it was meant to protect is worse than
                    # no guard. Log it and keep training.
                    logger.warning(f"divergence check failed (training continues): {e}")
                    d = {}
                if d:
                    # ⚠️ SET FIRST, THEN SPEAK — the `not diverged` guard above is what makes this
                    # fire exactly once. `divergence_check` is not called again after this, so
                    # there is no repeat and no second flag is needed.
                    diverged.update(d)
                    job.diverged = dict(diverged)
                    best_e = d.get("best_epoch")
                    near = ((SAVE_EVERY_EPOCH * round(best_e / SAVE_EVERY_EPOCH)
                             or SAVE_EVERY_EPOCH) if best_e else None)
                    emit(job, {"type": "log",
                               "line": f"⛔ DIVERGED — the mel loss has sat {d['ratio']}x above its "
                                       f"best ({d['current_loss']:g} vs {d['best_loss']:g}) for "
                                       f"{d['epochs']} epochs running. The discriminator has won and "
                                       f"further epochs only make it worse — stop it when you are "
                                       f"ready"
                                       + (f"; the best model this run produced was around epoch "
                                          f"{best_e}, so deploy the checkpoint nearest it (~{near}e)."
                                          if best_e else ".")})
                    emit(job, {"type": "diverged", **diverged})

            # A plateau is advisory; keep training until the operator stops it.
            if not diverged and not plateaued:
                try:
                    p = plateau_check(cfg, job.name, job.epoch,
                                      since=max(0, job.resume_from))
                except Exception as e:              # noqa: BLE001
                    logger.warning(f"plateau check failed (training continues): {e}")
                    p = {}
                if p:
                    # ⚠️ SET FIRST, THEN SPEAK — the `not plateaued` guard above is what makes this
                    # fire exactly once. `plateau_check` is not called again after this, so there
                    # is no repeat and no need for a second flag.
                    plateaued.update(p)
                    job.plateaued = dict(plateaued)
                    left_h = (job.epochs - job.epoch) * (job.speed_s or 0) / 3600
                    emit(job, {"type": "log",
                               "line": f"◆ No new best in {p['stale_epochs']} epochs "
                                       f"(best was {p['best_loss']:g} at epoch "
                                       f"{p['best_epoch']}). It keeps training — stop it here if "
                                       f"that checkpoint is good enough"
                                       + (f"; ~{left_h:.1f}h left." if left_h >= 0.5 else ".")})
                    emit(job, {"type": "plateaued", **plateaued})
        else:
            now = time.monotonic()
            if now - last_plain >= 1.0:          # tqdm \r chatter — ~1/s is plenty
                last_plain = now
                emit(job, {"type": "log", "line": piece})

    def drain(f):
        nonlocal buf
        chunk = f.read()
        if not chunk:
            return False
        buf += chunk.decode("utf-8", errors="replace")
        pieces = re.split(r"[\r\n]", buf)
        buf = pieces.pop()                       # keep the trailing partial line
        for piece in pieces:
            handle(piece)
        return True

    def alive() -> bool:
        """Return whether the detached trainer is alive. Prefer the systemd scope when one is known; otherwise use the launch process or, after reattachment, the recorded process group."""
        if proc is not None and proc.poll() is None:
            return True
        if job.scope:
            return _scope_active(job.scope)
        return False if proc is not None else _pgid_alive(job.pgid)

    # The tee log exists from launch; on reattach it might briefly not (crash
    # between mkdir and launch) — treat that as dead-with-no-progress below.
    f = open(log, "rb") if log.exists() else None
    try:
        if f is not None:
            f.seek(offset if proc is not None else max(0, log.stat().st_size - 65536))
            if proc is None:
                # Reattach: seed progress from the recent history, silently.
                tail = f.read().decode("utf-8", errors="replace")
                for line in re.split(r"[\r\n]+", tail):
                    info = parse_epoch_line(line)
                    if info:
                        job.epoch = info["epoch"]
                        if info["speed_s"]:
                            job.speed_s = float(info["speed_s"])
                # The curve comes from the WHOLE log, not the 64 KB tail — a restart
                # must not amputate the loss history the user is reading the plateau off.
                hist = loss_curve(cfg, job.name)
                job.curve = hist["curve"]
                job.best_epoch, job.best_loss = hist["best_epoch"], hist["best_loss"]
                if job.epoch:
                    emit(job, {"type": "epoch", "epoch": job.epoch, "total": job.epochs,
                               "speed_s": job.speed_s, "eta_s": job_eta(job),
                               "lowest": job.best_loss, "best_epoch": job.best_epoch})
        while True:
            if job.cancel.is_set():
                emit(job, {"type": "log",
                           "line": "Cancel — stopping the training"
                                   + (f" scope ({job.scope}.scope)" if job.scope
                                      else " process group")
                                   + " (checkpoints are kept)…"})
                stop_train(job.pgid, job.scope)
                if proc is not None:
                    try:
                        proc.wait(timeout=15)
                    except Exception:            # noqa: BLE001
                        pass
                if f is not None:
                    drain(f)
                return "canceled"
            got = drain(f) if f is not None else False

            if not alive():
                if f is not None:
                    drain(f)
                    if buf.strip():
                        handle(buf)
                rc = proc.returncode if proc is not None else None
                w = latest_weight(cfg, job.name)
                finished = job.epoch >= job.epochs or weight_epoch(w) >= job.epochs
                if finished and rc in (None, 0):
                    return "done"
                return "failed"
            if not got:
                time.sleep(0.5)
    finally:
        if f is not None:
            f.close()


# ── the job ──────────────────────────────────────────────────────────────────

def job_sources(job: TrainJob) -> list:
    """Return the clips selected for a job. Prefer the source pool; use `source_ref` for older single-clip job records."""
    return list(job.sources) if job.sources else ([job.source_ref] if job.source_ref else [])


def plan_stages(job: TrainJob, cfg: TrainConfig) -> list:
    if job.mode in ("resume", "reattach"):
        return ["train", "index", "deploy"]
    stages = ["preprocess", "extract", "train", "index", "deploy"]
    # A restart may reuse the already-prepared dataset when no new clips were
    # picked; a new training always preps from its selection.
    if job_sources(job) or not dataset_wavs(cfg, job.name):
        stages.insert(0, "prep")
    return stages


def run_train_job(job: TrainJob, cfg: TrainConfig):
    """Run the training pipeline in a daemon thread, serializing jobs per card and clearing state only after the trainer has exited."""
    try:
        job.status = "running"
        job.started_at = job.started_at or time.time()
        emit(job, {"type": "job_start", "id": job.id, "kind": "voicetrain",
                   "name": job.name})
        if not cfg.python.exists():
            raise RuntimeError(
                f"Applio venv python not found: {cfg.python} — is Applio installed? "
                f"(set VOCALIS_APPLIO_DIR or app_settings.yaml voiceswap: applio_dir)")
        # 🔴 And is Applio's workspace on the encrypted volume? Asked HERE, before the card
        # lock: there is no sense queueing behind an eighteen-hour run only to refuse.
        #
        # A reattach is exempt, and must be: that training is already on a card. Refusing it
        # would fail a job that is running perfectly well, and `run_train_job`'s `finally`
        # would then clear the very state file `reattach` needs to find it again — so Vocalis
        # would lose track of a live trainer instead of protecting anything.
        if job.mode != "reattach":
            check_workspace(cfg)
        lock = card_lock(job.gpu)
        waited = False
        while not lock.acquire(timeout=0.5):
            if not waited:
                waited = True
                emit(job, {"type": "log",
                           "line": f"Waiting for the training already running on "
                                   f"GPU {job.gpu} to finish…"})
            if job.cancel.is_set():
                job.status = "canceled"
                emit(job, {"type": "canceled"})
                return
        try:
            _pipeline(job, cfg)
        finally:
            lock.release()
    except VaultAuthError as exc:                              # BOUNDARY 2 of 5 — BY NAME
        # Handle vault authentication errors before the broad exception path. A wrong key is not corrupt state; fail the job and preserve its files.
        vault_store.fail_job_on_vault_auth(job, exc, emit)
    except Exception as exc:                                   # noqa: BLE001
        job.status = "failed"
        detail = getattr(exc, "detail", "")
        job.error = f"{exc} — {detail}" if detail else str(exc)
        # NOT job.name: that is the VOICE NAME, and this line goes to logs/vocalis.log,
        # which sits outside the vault. The job id identifies the run just as well.
        logger.exception(f"voicetrain job {job.id} failed")
        emit(job, {"type": "error", "message": job.error})
    finally:
        # Keep the state file while the detached trainer is alive. Reattachment and deletion protection depend on this anchor, even if the request job fails or ends.
        # Clear it only after a terminal job state and confirmation that the trainer is no longer running.
        if job.status in ("done", "failed", "canceled") \
                and not train_alive(job.pgid, job.scope):
            clear_state(cfg, job.name)


def _pipeline(job: TrainJob, cfg: TrainConfig):
    name = job.name
    stages = plan_stages(job, cfg)
    total = len(stages)

    def stage(sname, line):
        job.stage = sname
        emit(job, {"type": "stage", "stage": sname,
                   "n": stages.index(sname) + 1, "total": total})
        emit(job, {"type": "log", "line": f"[{stages.index(sname) + 1}/{total}] {line}"})

    if job.mode == "restart":
        emit(job, {"type": "log",
                   "line": f"Start over: deleting the previous “{name}” training workspace…"})
        shutil.rmtree(cfg.model_dir(name), ignore_errors=True)

    if "prep" in stages:
        refs = job_sources(job)
        srcs = []
        for ref in refs:
            p = source_path(cfg, ref)
            if p is None:
                raise RuntimeError(f"training clip not found: {ref}")
            srcs.append(p)
        if not srcs:
            raise RuntimeError("pick at least one training clip")
        # The 60-minute cap is a budget over the WHOLE dataset (R5), not per clip:
        # five 12-minute song vocals are a 60-minute dataset, and trimming each of
        # them to 60 minutes would trim nothing at all.
        dd = cfg.dataset_dir(name)
        vault_fs.rmtree(dd)                        # a fresh prep REPLACES the dataset
        vault_fs.mkdir(dd)
        budget = float(TRIM_SECONDS) if job.trim60 else None

        # Band-limited audio lacks high-frequency content that a higher-rate model may learn as a discriminator shortcut. Enhance band-limited clips before training; leave full-band clips unchanged.
        plan = prep_plan(srcs, job.trim60, job.enhance_nfe)
        limited = [r for r in plan if r["band_limited"]]
        if limited and not cfg.enhance.available:
            raise RuntimeError(
                f"{len(limited)} of {len(srcs)} clip(s) are standard quality and must be "
                f"enhanced before they can be trained on — training on audio without its "
                f"high end collapses the discriminator. The enhancer is not installed on "
                f"this box: run scripts/enhance/setup.sh once, then start the training "
                f"again.")

        stage("prep", f"ffmpeg: converting {len(srcs)} clip{'s' if len(srcs) > 1 else ''} "
                      f"to mono WAV"
                      + (" — first 60 minutes of audio in total" if budget else "") + "…")
        # Announce the GPU time this run will ACTUALLY spend. A band-limited clip whose
        # enhanced WAV is already cached costs nothing, and quoting its sixteen minutes
        # anyway is a promise the very next line breaks with "reusing it (no GPU)".
        cost = prep_cost(plan, job.enhance_nfe)
        if cost["todo"]:
            note = ""
            if cost["reused"]:
                note += f" {cost['reused']} already enhanced — reused, no GPU."
            if cost["full_band"]:
                note += f" {cost['full_band']} already full quality — used as-is."
            emit(job, {"type": "log",
                       "line": f"{cost['todo']} of {len(srcs)} clip"
                               f"{'s' if cost['todo'] > 1 else ''} standard quality and "
                               f"will be enhanced first "
                               f"({enhance_mod.eta_note(cost['eta_s'])})." + note})

        for i, r in enumerate(plan):
            src, trim = r["src"], r["trim"]
            if r["skip"]:
                emit(job, {"type": "log",
                           "line": f"— skipping “{src.name}”: the 60-minute dataset "
                                   f"budget is already full."})
                continue
            # POSITIONAL, never the source's name (5.0 §8.1). A Playground clip is named
            # safe_name(the user's PROMPT), and "Send to Voice Training" carries such a clip
            # straight in here — where Applio then enumerates this directory, randomly and
            # repeatedly, FOR EIGHTEEN HOURS. The words arrived at the child-process boundary
            # as filenames. Nothing reads these names back: dataset_wavs() only globs and
            # counts, and the trainer does not care what a clip is called. So the fix is the
            # whole fix, and it costs one line.
            #
            # {i:03d}, not {i:02d}: dataset_wavs() sorts LEXICALLY, so with two digits a
            # hundredth clip would sort between 10 and 11. Order does not change what gets
            # trained, but "why is the dataset shuffled" is not a mystery worth leaving.
            out = dd / f"{i:03d}.wav"
            emit(job, {"type": "log",
                       "line": f"— “{src.name}”"
                               + (f" (first {trim // 60} min)" if trim else "")})
            # _prep_one re-checks the cache itself rather than trusting r["cached"]: the
            # plan is an ESTIMATE made seconds ago, and the filesystem is the source of
            # truth at the moment of use.
            if not _prep_one(job, cfg, src, out, trim, r["band_limited"]):
                return

    # A REATTACH MUST NOT TOUCH THE DATASET. It is following a trainer that has been running
    # for hours; the clips it was built from are of no interest, and the progress it needs
    # comes from the tee log (see _smooth_at's caller and the "seed progress from the recent
    # history" note). Worse, this ran BEFORE the `mode == "reattach"` branch below, so at boot
    # — when the vault is still LOCKED — `dataset_wavs()` raised straight out of _pipeline and
    # failed the job for a training that was mid-epoch and perfectly healthy. `job.dataset_minutes`
    # is carried across in the state file instead (reattach(), :2611), so the ETA survives too.
    if job.mode != "reattach" and dataset_wavs(cfg, name):
        job.dataset_minutes = dataset_minutes(cfg, name)
    if job.dataset_minutes and job.mode != "reattach":
        n = len(dataset_wavs(cfg, name))
        job.cache_gpu = job.dataset_minutes <= CACHE_GPU_MAX_MIN
        per = epoch_seconds(job.dataset_minutes)
        eta = eta_seconds(job.epochs, job.dataset_minutes, warmed=False)
        emit(job, {"type": "log",
                   "line": f"Dataset: {n} clip{'s' if n > 1 else ''}, "
                           f"{job.dataset_minutes:g} min total → "
                           f"cache_data_in_gpu={'True' if job.cache_gpu else 'False (big dataset — protects VRAM)'}"
                           f" · est ~{per:.0f}s/epoch · ~{eta / 3600:.1f}h for {job.epochs} epochs"})
        if job.dataset_minutes < SOFT_MIN_MINUTES:
            emit(job, {"type": "log",
                       "line": f"⚠ {job.dataset_minutes:g} minutes of audio in total — under the "
                               f"{SOFT_MIN_MINUTES:g}-minute minimum. It will train, but the voice "
                               f"may sound thin; 40–60 minutes works far better. Tick more clips "
                               f"to build the dataset up."})

    if "preprocess" in stages:
        stage("preprocess", "Applio: slicing the dataset (preprocess, CPU)…")
        # Applio reads the temporary dataset directory only during preprocessing. The training process uses the slices in its workspace, so Resume does not need the source dataset.
        # Copy vault-routed dataset WAVs to scratch for preprocessing with opaque positional filenames; do not expose source clip names in plaintext paths.
        with scratch.directory(scratch.scratch_root(), f"dataset|{name}|{job.id}") as dsdir:
            for p in dataset_wavs(cfg, name):
                with vault_fs.open_read(p) as r, open(dsdir / p.name, "wb") as f:
                    shutil.copyfileobj(r, f)
            rc = _run_stage(job, build_preprocess_cmd(cfg, name, dsdir), cwd=cfg.applio_dir)
        if not _stage_ok(job, rc, "preprocess", cfg):
            return

    if "extract" in stages:
        stage("extract", f"Applio: extracting pitch + embeddings (GPU {job.gpu})…")
        if not _stage_ok(job, _run_stage(job, build_extract_cmd(cfg, name, job.gpu, job.f0_method),
                                         cwd=cfg.applio_dir), "feature extract", cfg):
            return

    proc, offset = None, 0
    if job.mode == "reattach":
        job.stage = "train"
        emit(job, {"type": "stage", "stage": "train", "n": 1, "total": total})
        emit(job, {"type": "log",
                   "line": f"Re-attached to the running training of “{name}” "
                           + (f"({job.scope}.scope, pgid {job.pgid})" if job.scope
                              else f"(pgid {job.pgid})")
                           + " — following its log…"})
    else:
        safe = systemd_scope_available()
        stage("train", f"Applio: training “{name}” — {job.epochs} epochs on GPU {job.gpu} "
                       + ("(detached in its own systemd scope: survives page reloads "
                          "AND a Vocalis restart)…" if safe else
                          "(detached — but this box has no systemd scope, so a Vocalis "
                          "restart WILL kill it)…")
                       + (" Resuming from the latest checkpoint." if job.mode == "resume" else ""))
        proc, offset = launch_train(job, cfg)

    outcome = follow_train(job, cfg, proc, offset)
    # The divergence flag remains authoritative through completion. A collapsed run must not auto-deploy its latest, potentially worst, checkpoint.
    if outcome != "canceled" and job.diverged:
        outcome = "diverged"
    if outcome == "canceled":
        job.status = "canceled"
        # Even here it is the filesystem that decides: a run stopped inside its first epoch
        # has been "training" and still has no weight to resume from.
        trained = latest_weight(cfg, name) is not None

        # A stopped run with a checkpoint still needs its dataset-derived index for deployment. Build the index only when a weight was banked; do not auto-deploy, so the operator can choose a checkpoint.
        # Keep this logic in the canceled branch so it executes before the return. Scope branch tests to this branch to avoid matching unreachable code.
        if trained and "index" in stages:
            stage("index", "Applio: building the faiss index "
                           "(the checkpoints it banked still need it)…")
            _stage_ok(job, _run_stage(job, build_index_cmd(cfg, name),
                                      cwd=cfg.applio_dir), "index build", cfg)
        write_outcome(cfg, name, outcome="stopped", epoch=job.epoch, requested=job.epochs)
        emit(job, {"type": "log",
                   "line": (f"Stopped at epoch {job.epoch} of {job.epochs}. The "
                            f"{job.epoch // SAVE_EVERY_EPOCH} checkpoints it banked are yours "
                            f"to audition — open Deploy and pick one. Resume carries on from "
                            f"where it stopped."
                            if trained else
                            f"Training stopped at epoch {job.epoch}/{job.epochs} — no "
                            f"checkpoint was written yet, so there is nothing to resume.")})
        emit(job, {"type": "canceled", "trained": trained})
        return
    if outcome == "diverged":
        # NOT a failure, and not a crash: the checkpoints from BEFORE the collapse are
        # good and are exactly what the user came for. The faiss index is built from the
        # DATASET, not the weights, so it is still valid for them — build it.
        #
        # But do NOT deploy. Deploy takes the LATEST weight, which after a collapse is
        # precisely the worst one this run produced.
        job.status = "diverged"
        write_outcome(cfg, name, outcome="diverged", epoch=job.epoch, requested=job.epochs,
                      **(job.diverged or {}))     # `diverged` is a declared field; it is None or a dict
        if "index" in stages:
            stage("index", "Applio: building the faiss index "
                           "(the pre-collapse checkpoints still need it)…")
            _stage_ok(job, _run_stage(job, build_index_cmd(cfg, name),
                                      cwd=cfg.applio_dir), "index build", cfg)
        emit(job, {"type": "log",
                   "line": "Nothing was deployed — the newest checkpoint is the worst "
                           "one. Open Deploy and pick a checkpoint from before the "
                           "collapse; it recommends the one nearest the best epoch."})
        return
    if outcome != "done":
        # Same split as voiceswap.StageFailed: the child's last line and the model path
        # both carry the VOICE NAME, so they go to the browser via `.detail` — never into
        # str(exc), which is what logger.exception writes to logs/vocalis.log.
        raise TrainFailed(
            f"training exited early at epoch {job.epoch}/{job.epochs}",
            detail=(f"last output: {job.last_line} " if job.last_line else "")
                   + f"(full log: {cfg.model_dir(name) / LOG_FILE})")
    # Persist the actual completed epoch and the requested count. Plateau completion can end before the requested count, and this outcome record remains available after transient log output is gone.
    write_outcome(cfg, name, outcome="converged" if job.plateaued else "finished",
                  epoch=job.epoch, requested=job.epochs, **(job.plateaued or {}))
    if job.plateaued:
        emit(job, {"type": "log",
                   "line": f"Training complete — {job.epoch} of {job.epochs} epochs. It "
                           f"flattened out along the way: no improvement for "
                           f"{job.plateaued['stale_epochs']} epochs, best at epoch "
                           f"{job.plateaued['best_epoch']}. Press Resume to train it further."})
    else:
        emit(job, {"type": "log", "line": f"Training complete — {job.epoch} epochs."})

    if "index" in stages:
        stage("index", "Applio: building the faiss index…")
        if not _stage_ok(job, _run_stage(job, build_index_cmd(cfg, name),
                                         cwd=cfg.applio_dir), "index build", cfg):
            return

    stage("deploy", "Copying the model into the voice registry…")
    info = deploy_model(cfg, name)
    emit(job, {"type": "log",
               "line": f"“{name}” registered — weight from epoch {info['epoch']}"
                       + (", with index" if info["index"] else ", NO index (timbre match will be weaker)")
                       + ". It's ready in the Voice Swap picker."})
    job.status = "done"
    job.stage = ""
    emit(job, {"type": "job_done", "name": name, "epoch": info["epoch"],
               "deployed": info})


# ── boot reattach ────────────────────────────────────────────────────────────

def reattach(cfg: TrainConfig) -> list:
    """Find persisted training jobs at startup. Reattach to live trainers, finish indexing and deployment for jobs that exited successfully, and mark dead unfinished jobs interrupted so their checkpoints can be resumed. Return the names of jobs that are live or finishable."""
    out = []
    logs = cfg.logs_dir
    if not logs.is_dir():
        return out
    # Say it once, at boot, and say it loudly. If the encrypted volume did not come back up
    # with the machine, `logs` is a BARE MOUNTPOINT: an empty directory, no state files, so
    # this loop finds nothing and reattach reports a clean "no trainings" — which is exactly
    # what it would report if there genuinely were none. The one place that distinction can be
    # drawn is here, before the loop that cannot draw it.
    if workspace_required(cfg) and not workspace_encrypted(cfg):
        logger.critical(f"voicetrain: the training workspace is NOT on the encrypted volume "
                        f"({logs}). New trainings are BLOCKED until it is mounted. If a "
                        f"training seems to have vanished, this is why — its files are on the "
                        f"volume, not here.")
    for d in sorted(logs.iterdir()):
        sp = d / STATE_FILE
        if not d.is_dir() or not sp.exists():
            continue
        try:
            state = json.loads(sp.read_text(encoding="utf-8"))
        except Exception:                                      # noqa: BLE001
            logger.warning(f"voicetrain: unreadable state file, skipping: {sp}")
            continue
        name = str(state.get("name") or d.name)
        if live_name(name) or state.get("status") == "interrupted":
            continue                            # already ours / already recorded
        pgid, unit = int(state.get("pgid") or 0), str(state.get("scope") or "")
        epochs = int(state.get("total_epoch") or EPOCHS_DEFAULT)
        if not train_alive(pgid, unit):
            reached = max(_last_logged_epoch(d), weight_epoch(latest_weight(cfg, name)))
            if reached < epochs:
                mark_interrupted(cfg, name, state, reached)
                logger.warning(
                    f"voicetrain: training '{name}' is NOT running (pgid {pgid}"
                    + (f", scope {unit}.scope" if unit else ", no scope")
                    + f") — interrupted at epoch {reached}/{epochs}; its "
                      f"checkpoints are intact, Resume continues from there")
                continue
            # dead but complete: fall through and let the job finish index+deploy
        job = new_job(name=name, epochs=epochs,
                      gpu=int(state.get("gpu") or 0),
                      f0_method=str(state.get("f0_method") or F0_DEFAULT),
                      source_ref=str(state.get("source") or ""),
                      sources=[str(s) for s in (state.get("sources") or [])],
                      mode="reattach")
        job.dataset_minutes = float(state.get("dataset_minutes") or 0)
        job.cache_gpu = bool(state.get("cache_data_in_gpu", True))
        job.pgid, job.scope = pgid, unit
        job.started_at = float(state.get("started_at") or time.time())
        threading.Thread(target=run_train_job, args=(job, cfg), daemon=True).start()
        logger.info(f"voicetrain: re-attached to training '{name}' (pgid {pgid}"
                    + (f", scope {unit}.scope)" if unit else ")"))
        out.append(name)
    return out
