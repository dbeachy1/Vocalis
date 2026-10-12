#!/usr/bin/env python3
"""Run voice-swap jobs through three stages: obtain shared stems, convert vocals with RVC, and mix the result with the instrumental. Keep the dry swapped vocal as an editable library artifact; store results by content and settings identity. Execute external stages in the isolated environment, serialize jobs, stream progress, and terminate child process groups on cancellation."""
import contextlib
import datetime
import hashlib
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

import scratch
from contextlib import ExitStack

import stems
import swap_rate
import vault_fs
import vault_store
from vault import VaultAuthError       # 5.0-M5 boundary 2 of 5 — caught BY NAME below
from book_to_audio import safe_name
from render_rate import gpu_name as _gpu_name   # a machine identity for the rate cache, not a
                                                # table of assumed speeds (see swap_rate.key_for)
from stems import DEMUCS_MODEL          # re-exported: stemsplit + the tests read it here

DEFAULT_STEMS_VENV = Path("/opt/vocalis/venvs/stems")
from tts_utils import move_into_place   # EXDEV-safe: the workdir may be on another mount
from tts_utils import source_stat       # THE identity seam (5.0 §7.7.2) — one answer, shared

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"}
F0_METHOD = "rmvpe"                    # PoC-proven; fixed, not a UI knob

# RVC applies envelope matching only when `rms_mix_rate` differs from 1. Use the WebUI default blend of 0.25 so the converted vocal follows the source dynamics without clamping them; `vocal_gain` adjusts overall level, not the envelope.
RMS_MIX_DEFAULT = 0.25
MP3_BITRATE = "320k"                   # music, stereo — NOT the 96k mono speech encode
# A SPEECH swap (4.3) has no backing to mix, so it does not use MP3_BITRATE. It uses the
# speech encode: mono @ 96k — enhance.mp3_bitrate()'s PLAIN rule (§4). This module cannot
# import enhance (enhance imports US, and voiceswap is deliberately torch-free), so the
# value is duplicated and PINNED to enhance.MP3_BITRATE_PLAIN by a test — one rule, checked.
SPEECH_MP3_BITRATE = "96k"
PREVIEW_SECONDS = 15                   # audition excerpt length
PREVIEW_KEEP = 20                      # newest previews kept; older ones pruned
# Known-benign ROCm chatter every torch child prints on this box (PoC report:
# cosmetic / workspace-probe warnings). Kept out of the user-facing live log —
# three lines of "No such file or directory" read as a failure when they aren't.
NOISE_MARKERS = ("MIOpen(HIP): Warning", "/opt/amdgpu/share/libdrm/amdgpu.ids",
                 # The SAME libdrm probe, but some builds print the path as a null pointer,
                 # so the marker above never matches and three lines of "No such file or
                 # directory" land in the user's log. They cost us a bug report: an enhance
                 # run that worked perfectly (19,982 Hz of real content, measured) looked
                 # like it had crashed. Matched as the WHOLE literal, never on a bare "No
                 # such file or directory" — a genuine missing file NAMES the file, and
                 # swallowing that class of error is how a real failure goes silent.
                 "(null): No such file or directory",
                 # belt and braces for the pkg_resources deprecation below: PYTHONWARNINGS
                 # already stops the child emitting it, but a child that ignores the env
                 # (or a future dependency that re-raises it) must not reach the job log.
                 "pkg_resources is deprecated", "Refrain from using this package")


def venv_python(venv_dir, windows: bool = None) -> Path:
    """The interpreter inside an ISOLATED venv (VoxCPM2's ~/voxcpm-venv, DeepFilterNet's
    ~/dfn-venv, the Trim scorer's ~/trim-venv, …), portably. A POSIX venv lays out
    `bin/python`; a Windows venv lays out `Scripts/python.exe` — there is no `bin/` at all,
    so the old hardcoded `/ "bin" / "python"` in voxcpm, cleanup and enhance's
    resolve_config resolved a path that never existed on Windows, and the engine's
    `available` check silently came back False. One helper, one platform check, every
    resolve_config() calls it.

    `windows` defaults to this box's real os.name and exists so a test can exercise BOTH
    branches on one host. Monkeypatching os.name itself does not work for that here: this
    pathlib re-derives WindowsPath/PosixPath from os.name on every `Path(...)` construction,
    and instantiating the concrete class for the OTHER platform raises `NotImplementedError:
    cannot instantiate 'PosixPath' on your system` (measured on this Windows box) — the
    branch never even runs. The injected flag picks which literal segments to append while
    `venv_dir` stays the real, current-OS Path the caller already had, so nothing needs the
    other platform's concrete class at all."""
    venv_dir = Path(venv_dir)
    if windows is None:
        windows = os.name == "nt"
    return venv_dir / "Scripts" / "python.exe" if windows else venv_dir / "bin" / "python"


_REF_RE = re.compile(r"[^/\\]+\Z")     # library refs are flat stems — no traversal
_SONG_RE = re.compile(r"(acestep|uploads|acelib)/([^/\\]+)\Z")   # "<source>/<filename>"
_STEMS_RE = re.compile(r"stems/([^/\\]+)\Z")              # "stems/<set-ref>"
_SPEECH_RE = re.compile(r"speech/([^/\\]+)\Z")            # "speech/<training-clip>" (4.3)
# "pg/<voice-dir>/<stem>" (7.5.26) — a Playground clip, converted WHERE IT LIES.
#
# 🔴 THE INNER PART CARRIES A SLASH, so this cannot be `([^/\\]+)` like the three above: a
# playground ref is `<voice-dir>/<stem>` and always has one. That also means this pattern alone
# does NOT establish safety — `.+` will happily match `../../etc/passwd`. It is not asked to:
# `pg_path` hands the tail to `playground_clips.clip_paths`, which does the shape check AND the
# containment check against the library root, and that is the ONE validator for this ref. A second
# regex here would be a second opinion about traversal, and two of those is how they drift.
_PG_RE = re.compile(r"pg/(.+)\Z", re.S)

EVENT_CAP = 5000
JOBS_KEEP = 30
JOBS = {}
JOBS_LOCK = threading.Lock()
# One swap at a time: each stage is a GPU-hungry child process; concurrent
# swaps would fight for VRAM with each other (and with book renders).
SWAP_LOCK = threading.Lock()


def _now() -> str:
    return datetime.datetime.now().replace(microsecond=0).isoformat()


# ── config ────────────────────────────────────────────────────────────────────

@dataclass
class SwapConfig:
    """Resolve pipeline locations from environment variables and app_settings.yaml. Keep each path configurable and avoid embedding an installation-specific virtual-environment path in source."""
    venv: Path             # the isolated voiceswap venv root
    rvc_dir: Path          # RVC voice registry (*.pth + same-stem *.index)
    acestep_dir: Path      # ACE-Step song outputs (the pre-8.0 sidecar dir, kept for old files)
    songs_dir: Path        # uploaded songs — uploads/songs/ at the INSTALL ROOT (M4,
                           # Uploaded songs use the vault-routed install-root store. Keep externally generated songs in the legacy read-only source path for compatibility.
    stems_dir: Path        # stem sets WE made: output/stems/
    stem_uploads_dir: Path  # stem sets YOU brought: uploads/stems/
    library_dir: Path      # finished swaps: output/voiceswap/
    work_root: Path        # transient per-job workdirs — IN THE SCRATCH (5.0 §8.2)
    preview_dir: Path      # audition excerpts (regenerable, count-pruned) — a CACHE, not
                           # Previews are reusable, count-pruned cache entries rather than transient scratch files; keep them in the vault-routed cache.
    scripts_dir: Path      # scripts/voiceswap/ (rvc_infer.py lives here)
    song_index: Path = None  # the song-hash memo (5.0 M4) — see stems.song_id. In the CACHE,
                           # The song-hash index is regenerable cache data. If absent, re-hash on demand; it must not cause a job to fail. Keep it outside the install vault because some source songs remain external.
    training_dir: Path = None
    # Playground sources are converted in place rather than copied into the training-clip store, avoiding an unnecessary duplicate.
    playground_dir: Path = None
    # Store the job queue under the persistent output root so pending jobs survive service restarts; do not place it in the disposable OS cache.
    queue_file: Path = None
    # Use the saved ACE-Step library as the source for library rows. Keep it distinct from the legacy output directory; read titles and favorites from the library index.
    acelib_dir: Path = None
    demucs_venv: Path = None

    @property
    def python(self) -> Path:
        if os.name == "nt":
            return self.venv / "Scripts" / "python.exe"
        return self.venv / "bin" / "python"

    @property
    def demucs_python(self) -> Path:
        """Interpreter for the retained Stems Demucs runtime, separate from RVC."""
        if self.demucs_venv is None:
            raise RuntimeError("Demucs environment is not configured")
        return venv_python(self.demucs_venv)


def _acelib_audio_dir() -> Path:
    """Where the 8.0 ACE-Step library keeps its FLACs — read from the paths module AT CALL
    TIME, so a test that monkeypatches `vocalis.runtime.paths.ACE_LIBRARY_AUDIO` reaches this
    consumer too. Local import: this module predates the vocalis package and stays import-light."""
    from vocalis.runtime import paths as rt_paths
    return Path(rt_paths.ACE_LIBRARY_AUDIO)


def resolve_config(app_settings: dict, base_dir: Path, output_dir: Path,
                   cache_dir: Path) -> SwapConfig:
    s = app_settings.get("voiceswap") or {}
    stems_settings = app_settings.get("stems") or {}

    def pick(env_key, settings_key, default):
        return Path(os.environ.get(env_key) or s.get(settings_key) or default)

    root = Path(base_dir)
    return SwapConfig(
        venv=pick("VOICESWAP_VENV", "venv", Path.home() / "voiceswap-venv"),
        # The trained-voice registry defaults to the install root; `migrate_voices` handles the legacy source directory below.
        rvc_dir=pick("VOCALIS_RVC_DIR", "rvc_dir", root / "voice_models"),
        acestep_dir=pick("VOCALIS_ACESTEP_DIR", "acestep_dir", "/ai-output/acestep"),
        # NOT `root / "ace_library"` re-derived by hand: the paths module is the single source
        # of truth for where the 8.0 library lives, and a monkeypatched test path must reach
        # both consumers or a divergence is silent (the speech-cache lesson).
        acelib_dir=_acelib_audio_dir(),
        demucs_venv=Path(os.environ.get("VOCALIS_STEMS_VENV")
                         or stems_settings.get("venv") or DEFAULT_STEMS_VENV),
        # Resolve uploaded-song and stem paths from environment or settings before using defaults, so machine-specific locations remain configuration rather than source literals.
        songs_dir=pick("VOCALIS_SONGS_DIR", "songs_dir", root / "uploads" / "songs"),
        stem_uploads_dir=pick("VOCALIS_STEM_UPLOADS_DIR", "stem_uploads_dir",
                              root / "uploads" / "stems"),
        stems_dir=Path(output_dir) / "stems",
        library_dir=Path(output_dir) / "voiceswap",
        # Keep transient swap workdirs under the owned scratch root. They contain plaintext source audio, stems, and the dry converted vocal; the scratch owner handles cleanup.
        # Audition previews are reusable cache entries, not transient workdirs. Keep them in the vault-routed cache and prune them by count.
        work_root=scratch.scratch_root(app_settings) / "voiceswap",
        # NOT scratch: previews are KEPT (count-pruned, replayable in the UI), so they are a
        # cache of user audio and M6/M7 encrypts them where they lie.
        preview_dir=Path(cache_dir) / "voiceswap_preview",
        scripts_dir=Path(base_dir) / "scripts" / "voiceswap",
        song_index=Path(cache_dir) / "song_ids.yaml",
        # Mirror voicetrain.resolve_config EXACTLY (same env key, settings key, default) so a
        # speech source names the same file both tabs see. enhance.py's note calls the two
        # resolutions "deliberately identical"; this is the third that must stay in step.
        training_dir=pick("VOCALIS_TRAINING_DIR", "training_dir", root / "voice_training"),
        # 7.5.26 — the Playground's own clip library, derived from output_dir exactly as
        # `vocalis/web/playground.py` derives it (`OUTPUT_DIR / "playground"`). Same tree, one
        # copy: a `pg/` swap reads the very file the Playground tab plays.
        playground_dir=Path(output_dir) / "playground",
        # A SIBLING of the library (not inside it — list_swaps globs *.yaml there), under
        # output/ so it outlives a restart (§5.3).
        queue_file=Path(output_dir) / "voiceswap_queue.yaml",
    )


# ── voices & songs (the two pickers) ─────────────────────────────────────────

def read_voice_meta(rvc_dir, stem: str) -> dict:
    """The provenance sidecar voicetrain writes on deploy: which training, which
    epoch. Absent for a .pth you dropped in by hand — that's fine, it just means
    "brought your own", which is itself worth showing."""
    p = Path(rvc_dir) / f"{stem}.yaml"
    if not vault_fs.exists(p):
        return {}
    try:
        return yaml.safe_load(vault_fs.read_text(p)) or {}
    except Exception:                                          # noqa: BLE001
        logger.warning(f"rvc voice sidecar unreadable — ignoring it: …{stem[-4:]}.yaml")
        return {}


def list_voices(rvc_dir) -> list:
    """RVC voices: every .pth in the registry, with its same-stem .index when
    present, and its provenance sidecar when we deployed it. Mirrors the
    voice_samples scan — the filesystem is the registry."""
    d = Path(rvc_dir)
    out = []
    for nm in sorted(vault_fs.glob(d, "*.pth"), key=str.lower):
        p = d / nm
        idx = p.with_suffix(".index")
        st = vault_fs.stat(p)                     # LOGICAL: a .pth is ~750 bytes bigger encrypted
        meta = read_voice_meta(d, p.stem)
        out.append({"name": p.stem, "pth": p.name,
                    "index": idx.name if vault_fs.exists(idx) else None,
                    "size": st.size if st else 0, "mtime": st.mtime if st else 0,
                    # provenance (None ⇒ not trained here: a .pth someone dropped in)
                    "training": meta.get("training"), "epoch": meta.get("epoch"),
                    "step": meta.get("step"),
                    "deployed_at": meta.get("deployed_at"),
                    "favorite": bool(meta.get("favorite"))})
    return out


# ── migration: the registry used to live with the public model weights ───────

LEGACY_RVC_DIR = Path("/ai-models/rvc")


def migrate_voices(cfg) -> list:
    """Move a legacy trained-voice registry into the install root without overwriting conflicting destination files. Leave the source untouched on conflict and skip migration when configuration explicitly retains the legacy location. Transfer bytes through scratch and the vault-aware writer when crossing into an encrypted store."""
    import vault_fs
    dest = Path(cfg.rvc_dir)
    if dest == LEGACY_RVC_DIR or not LEGACY_RVC_DIR.is_dir():
        return []
    stems = sorted({p.stem for p in LEGACY_RVC_DIR.glob("*.pth")})   # legacy dir: never ours
    if not stems:
        return []

    moved = []
    vault_fs.mkdir(dest)
    for stem in stems:
        srcs = voice_files(LEGACY_RVC_DIR, stem)
        clash = [s for s in srcs if vault_fs.exists(dest / s.name)]
        if clash:
            logger.warning(f"voices: “{stem}” already exists in {dest} — leaving the copy "
                           f"in {LEGACY_RVC_DIR} alone. Delete one of them by hand.")
            continue
        for s in srcs:
            # Copy legacy registry files through the vault-aware writer. The source and destination may be on different filesystems, and the destination may be encrypted.
            vault_fs.from_scratch(s, dest / s.name)
        moved.append(stem)
        logger.info(f"voices: moved “{stem}” out of {LEGACY_RVC_DIR} into {dest}")
    return moved


def voice_files(rvc_dir, name: str) -> list:
    """The files that ARE one voice: the weight, its index, its sidecar."""
    d = Path(rvc_dir)
    leaf = Path(str(name or "")).name
    if not leaf or leaf != str(name or "") or not vault_fs.exists(d / f"{leaf}.pth"):
        return []
    return [d / f"{leaf}{ext}" for ext in (".pth", ".index", ".yaml")
            if vault_fs.exists(d / f"{leaf}{ext}")]


def delete_voice(rvc_dir, name: str) -> list:
    """Remove a voice from the registry (7g).

    Nothing in Vocalis could do this. /voiceswap/voices was GET-only, so a voice,
    once deployed, was permanent short of an SSH `rm` — and with 7b deploying ~20
    candidate checkpoints per training, that would have meant every experiment was
    forever. Checkpoint-picking without pruning just fills the registry with junk.

    The training workspace is NOT touched: this deletes the deployed copy, and the
    checkpoint it came from is still in logs/<training>/ to redeploy."""
    files = voice_files(rvc_dir, name)
    if not files:
        raise ValueError(f"no such voice in the registry: {name}")
    for f in files:
        vault_fs.unlink(f, missing_ok=True)
    return [f.name for f in files]


def rename_voice(rvc_dir, name: str, new_name: str) -> dict:
    """Rename a deployed voice by moving its weight, index, and sidecar together. Preserving the sidecar keeps training provenance attached to the renamed voice."""
    d = Path(rvc_dir)
    files = voice_files(d, name)
    if not files:
        raise ValueError(f"no such voice in the registry: {name}")
    stem = safe_name(str(new_name or "").strip(), 60) if str(new_name or "").strip() else ""
    if not stem:
        raise ValueError("the name can't be empty")
    if stem == name:
        return {"name": stem}
    if vault_fs.exists(d / f"{stem}.pth"):
        raise FileExistsError(stem)
    for f in files:
        vault_fs.rename(f, d / f"{stem}{f.suffix}")   # FILE renames — the name re-encrypts
    return {"name": stem}


# ── import a brought-your-own voice (4.6, DESIGN_4_6_IMPORT_VOICE.md) ─────────

class VoiceValidationError(ValueError):
    """An uploaded .pth that isn't a safe, valid RVC model — surfaced as a 400 with a plain
    reason, so a hostile or wrong file is rejected AT UPLOAD, not deep inside a later swap."""


def _norm_sr(sr) -> int:
    """RVC stores the sample rate as 40000, '40k' or '40000'. Normalize to int Hz, 0 if junk."""
    if isinstance(sr, bool):
        return 0
    if isinstance(sr, (int, float)):
        return int(sr)
    s = str(sr).strip().lower()
    if s.endswith("k"):
        try:
            return int(float(s[:-1]) * 1000)
        except ValueError:
            return 0
    try:
        return int(s)
    except ValueError:
        return 0


def validate_rvc_pth(path) -> dict:
    """Safe-load and structurally validate an RVC .pth (4.6 §4). Returns the model's
    {sr, f0, version, epoch, author} on success; raises VoiceValidationError on failure.

    SAFE FIRST. A .pth is a Python pickle, so `torch.load` on an untrusted one can execute
    arbitrary code. We load with weights_only=True — which cannot run code — and if the file
    won't load THAT way we REJECT it, never falling back to an unsafe load. An upload feature
    is the wrong place to assume trust, even for the user's own file.

    CORRECT SECOND. Confirm the RVC-v2 generator shape: the `weight` state dict, the `config`,
    and the `sr`/`f0`/`version` keys, with sr ∈ {32k, 40k, 48k}. Present and sane → accept;
    absent → a plain "that isn't an RVC voice model" at upload, not a cryptic mid-swap crash."""
    import torch                                          # the main venv has it (Chatterbox)
    try:
        ck = torch.load(str(path), map_location="cpu", weights_only=True)
    except Exception as exc:                              # noqa: BLE001 — any load failure = reject
        raise VoiceValidationError(
            "couldn't safely load this file — a .pth is a pickle and only weights-only loading "
            "is allowed, so it must be corrupt or not a PyTorch model.") from exc
    if not isinstance(ck, dict):
        raise VoiceValidationError("that isn't an RVC voice model (expected a checkpoint dict).")
    missing = [k for k in ("weight", "config", "sr", "f0", "version") if k not in ck]
    if missing:
        raise VoiceValidationError(
            f"that isn't an RVC voice model — it's missing {', '.join(missing)}.")
    sr = _norm_sr(ck.get("sr"))
    if sr not in (32000, 40000, 48000):
        raise VoiceValidationError(
            f"unexpected sample rate ({ck.get('sr')!r}) — RVC voice models are 32k, 40k or 48k.")
    return {"sr": sr, "f0": bool(ck.get("f0")), "version": str(ck.get("version")),
            "epoch": ck.get("epoch"), "author": (ck.get("author") or None)}


def import_voice(rvc_dir, name: str, pth_stream, index_stream=None, replace: bool = False) -> dict:
    """Stage and safely validate an uploaded RVC checkpoint before storing it as <name>.pth and an optional same-name index. Raise VoiceValidationError for invalid models, FileExistsError for an occupied name without replacement, and ValueError for an empty name. Imported models have no training provenance; replacement must remove stale provenance and any index that does not match the new checkpoint. Use scratch for validation and vault-aware storage for the final files."""
    d = Path(rvc_dir)
    vault_fs.mkdir(d)
    raw = str(name or "").strip()
    if not raw:                                          # safe_name('') falls back to 'section' —
        raise ValueError("the name can't be empty")     # check BEFORE it, as rename_voice does
    stem = safe_name(raw, 60)
    dest_pth = d / f"{stem}.pth"
    if vault_fs.exists(dest_pth) and not replace:
        raise FileExistsError(stem)

    root = scratch.scratch_root()
    with scratch.file(root, f"rvc-import|{stem}", ".pth") as tmp:
        with open(tmp, "wb") as f:                        # the scratch is plaintext BY DESIGN
            shutil.copyfileobj(pth_stream, f)
        info = validate_rvc_pth(tmp)                      # raises on a bad/hostile file
        with contextlib.ExitStack() as stack:
            idx_tmp = None
            if index_stream is not None:
                idx_tmp = stack.enter_context(
                    scratch.file(root, f"rvc-import-idx|{stem}", ".index"))
                with open(idx_tmp, "wb") as f:
                    shutil.copyfileobj(index_stream, f)
            # Land: the weight, then the index. from_scratch REMOVES its source (§10.1), which
            # is what we want for a staging temp — and it is why the .index must be staged
            # BEFORE the .pth lands, so a failure writing it cannot leave the registry holding
            # new weights beside a stale index that no longer matches them.
            vault_fs.from_scratch(tmp, dest_pth)
            vault_fs.unlink(d / f"{stem}.yaml", missing_ok=True)   # an import has no provenance
            has_index = False
            if idx_tmp is not None:
                vault_fs.from_scratch(idx_tmp, d / f"{stem}.index")
                has_index = True
            elif replace:
                # old index no longer matches new weights
                vault_fs.unlink(d / f"{stem}.index", missing_ok=True)
    logger.info(f"imported RVC voice “{stem}” ({info['version']}, {info['sr']} Hz, "
                f"index={'yes' if has_index else 'no'})")
    return {"name": stem, "index": has_index, "provenance": None,
            "sr": info["sr"], "f0": info["f0"], "version": info["version"]}


def add_index(rvc_dir, name: str, index_stream) -> dict:
    """Add or replace the same-stem index for an existing voice. Index identity is part of swap identity, so existing cached renders remain separate from renders made after the index changes."""
    d = Path(rvc_dir)
    leaf = Path(str(name or "")).name
    # vault_fs.exists, not is_file(): encrypted, a bare is_file() is False for every voice in
    # the registry, so this raises "no such voice" for a voice the panel is displaying.
    if not leaf or leaf != str(name or "") or not vault_fs.exists(d / f"{leaf}.pth"):
        raise ValueError(f"no such voice in the registry: {name}")
    # Same as import_voice: the staging temp is scratch-side, never a cleartext `.addidx-*`
    # sibling inside the registry, and from_scratch does the crossing (and the removal).
    with scratch.file(scratch.scratch_root(), f"rvc-addidx|{leaf}", ".index") as tmp:
        with open(tmp, "wb") as f:
            shutil.copyfileobj(index_stream, f)
        vault_fs.from_scratch(tmp, d / f"{leaf}.index")
    logger.info(f"added index to RVC voice “{leaf}”")
    return {"name": leaf, "index": True}


def _song_row(p: Path, source: str) -> dict:
    """One song-picker row. A `<stem>.yaml` sidecar (the ace-step-ui fork will
    write these) supplies a human title; otherwise the filename stands in."""
    # Use the vault-aware logical stat for uploaded songs; external legacy songs are not routed and use their filesystem metadata.
    st = vault_fs.stat(p)
    title, fav = None, False              # `fav` is main's gold favorites (4.2-m0e)
    side = p.with_suffix(".yaml")
    if vault_fs.exists(side):
        try:
            d = yaml.safe_load(vault_fs.read_text(side))
            if isinstance(d, dict):
                title = d.get("title")
                fav = bool(d.get("favorite"))
        except Exception:
            logger.warning(f"song sidecar unreadable — using filename: …{p.suffix}")
    return {"ref": f"{source}/{p.name}", "name": str(title or p.stem),
            "source": source,
            "size": st.size if st else 0, "mtime": st.mtime if st else 0,
            "favorite": fav}


def _acelib_index():
    """The 8.0 song library's index as {id: Song}, or None when it cannot be read.

    🔴 `except BaseException`, DELIBERATELY: a locked vault raises VaultAuthError, which does
    not inherit Exception (vault.py:58 — read it before "fixing" this). A locked vault must
    cost the picker its library rows, never kill the whole picker — and it must never fall
    back to showing hex-id filenames as titles, which is what returning {} here would do.
    None means "could not read", and every caller skips the library entirely on it."""
    try:
        from vocalis.runtime import acelib
        return {s.id: s for s in acelib.list_songs()}
    except BaseException:                  # noqa: BLE001 — VaultAuthError is not an Exception
        return None


def _acelib_rows(cfg: SwapConfig) -> list:
    """Return ACE-Step library entries that have a matching library-index record. Read names and favorites from that index so the picker and library show the same metadata; omit unindexed files."""
    if cfg.acelib_dir is None:             # a direct-construction test cfg without acelib_dir
        return []
    d = Path(cfg.acelib_dir)
    meta = _acelib_index()
    if meta is None or not vault_fs.is_dir(d):
        return []
    out = []
    for nm in vault_fs.listdir(d):
        p = d / nm
        song = meta.get(p.stem)
        if song is None or p.suffix.lower() not in AUDIO_EXTS or vault_fs.is_dir(p):
            continue
        st = vault_fs.stat(p)
        # Include the seed in each song-library row. Retakes can share a title and similar file metadata, so the seed distinguishes which render the user selects.
        out.append({"ref": f"acelib/{p.name}", "name": song.name, "source": "acelib",
                    "size": st.size if st else 0,
                    "mtime": st.mtime if st else song.created_at,
                    "seed": song.seed,
                    "favorite": bool(song.favorite)})
    return out


def list_songs(cfg: SwapConfig) -> list:
    """Song picker rows: uploads + ACE-Step outputs + the 8.0 song library, newest first."""
    out = []
    for d, source in ((cfg.songs_dir, "uploads"), (cfg.acestep_dir, "acestep")):
        d = Path(d)
        if not vault_fs.is_dir(d):
            continue
        for nm in vault_fs.listdir(d):
            p = d / nm
            if p.suffix.lower() in AUDIO_EXTS and not vault_fs.is_dir(p):
                out.append(_song_row(p, source))
    out.extend(_acelib_rows(cfg))
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def song_path(cfg: SwapConfig, ref: str):
    """Resolve a song ref ('acestep/<file>' | 'uploads/<file>') to its path, or
    None for a malformed/traversal ref or a missing file."""
    m = _SONG_RE.fullmatch(str(ref or ""))
    if not m:
        return None
    # 🔴 `getattr`, NOT a dict literal over cfg attributes. This function is duck-typed: the
    # Stems routes hand it a StemConfig, and a dict literal evaluates EVERY value eagerly — so
    # `cfg.acelib_dir` raised AttributeError for a plain `acestep/` ref and 500'd the whole
    # Stems tab (11 red tests, one shipped defect). speech_path and pg_path already short-
    # circuit before touching their optional fields; this is the same manners.
    if m.group(1) == "acelib":
        base = getattr(cfg, "acelib_dir", None)
    else:
        base = cfg.acestep_dir if m.group(1) == "acestep" else cfg.songs_dir
    if base is None:
        return None                       # a direct-construction test cfg without acelib_dir
    p = Path(base) / m.group(2)
    return p if vault_fs.exists(p) and p.suffix.lower() in AUDIO_EXTS else None


def speech_path(cfg: SwapConfig, ref: str):
    """Resolve a speech ref ('speech/<clip>') to its file in the training-clip store, or
    None for a malformed/traversal ref, an unconfigured store, or a missing file.

    A 'speech/' clip is the SAME file Voice Training reads — one store, two consumers (§2).
    So the swap picker's speech rows come straight from /train/sources, and this turns the
    ref one of them carries back into a path."""
    m = _SPEECH_RE.fullmatch(str(ref or ""))
    if not m or cfg.training_dir is None:
        return None
    name = m.group(1)
    if Path(name).name != name:              # belt-and-braces with the regex ('..' → '')
        return None
    p = Path(cfg.training_dir) / name
    # Routed: training_dir is voice_training/ — the user's own recorded voice, and a vault
    # tree since the router learned about it. A bare is_file() there is always False, so
    # EVERY speech ref resolved to None: "keep the speech" silently had no speech to keep,
    # and the swap ran as if the user had never chosen one.
    return p if vault_fs.exists(p) and p.suffix.lower() in AUDIO_EXTS else None


def pg_path(cfg: SwapConfig, ref: str):
    """Resolve a Playground ref to its MP3, or return None for malformed or traversal refs, an unconfigured library, or a missing clip. Delegate path containment checks to clip_paths after validating the ref shape."""
    m = _PG_RE.fullmatch(str(ref or ""))
    if not m or cfg.playground_dir is None:
        return None
    # ⚠️ IMPORTED HERE, NOT AT MODULE LEVEL — `playground_clips` imports `enhance`, and `enhance`
    # imports four names back out of THIS module (`NOISE_MARKERS`, `_card_env`, `_kill_tree`,
    # `ffprobe_duration`). A top-level import is an ImportError on a partially initialized module,
    # i.e. the server does not start at all. Deferring it is what lets `clip_paths` stay the one
    # validator for this ref instead of the check being copied over here to dodge the cycle.
    import playground_clips
    mp3, _yaml = playground_clips.clip_paths(cfg.playground_dir, m.group(1))
    if mp3 is None:
        return None
    # A PARTIAL has no MP3 on disk — its audio is still banked chunks in a workspace — so it is
    # not convertible in place and must fail HERE, as "that clip isn't there", rather than
    # halfway down the job. The Playground row does not offer ⇄ on a partial for the same reason.
    return mp3 if vault_fs.exists(mp3) else None


def song_title(p: Path) -> str:
    """Display name for a song file: sidecar title when present, else the stem."""
    return _song_row(Path(p), "")["name"]


def save_upload(cfg: SwapConfig, filename: str, stream, overwrite: bool = False) -> dict:
    """Store an uploaded song using a content-hash suffix. Re-uploading identical content is a no-op; distinct files with the same original name remain distinguishable. Keep the overwrite parameter for compatibility, but preserve the training-clip pool’s separate name-conflict contract."""
    name = Path(str(filename or "")).name            # basename only — no traversal
    ext = Path(name).suffix.lower()
    if not name or ext not in AUDIO_EXTS:
        raise ValueError(f"not an audio file: {filename!r} "
                         f"(accepted: {', '.join(sorted(AUDIO_EXTS))})")
    d = Path(cfg.songs_dir)
    vault_fs.mkdir(d)
    # Write upload data to scratch, hash it there, and send the completed file through the vault-aware writer. Do not create plaintext temporary files inside a vault-routed directory.
    with scratch.file(scratch.scratch_root(), f"song-upload|{name}", ext) as tmp:
        with open(tmp, "wb") as f:
            shutil.copyfileobj(stream, f)
        h = stems.song_hash(tmp)                     # the FULL 32 hex — all of it, this time
        dest = d / f"{safe_name(Path(name).stem, 48)}_{h[:8]}{ext}"
        if not vault_fs.exists(dest):                # byte-identical re-upload: a no-op
            vault_fs.from_scratch(tmp, dest)
        # REMEMBER THE OTHER 24 HEX (M4). We have just hashed this song; the 8 in the filename
        # cannot answer "what is this song?" and every later asker used to re-read the whole
        # file to find out. An uploaded song is now hashed exactly once, ever.
        stems.record_song_id(cfg, dest, h)
    return _song_row(dest, "uploads")


# ── the swap's source: a song, or a stem set ─────────────────────────────────
# A stem set is a first-class object, not a child of a song (§3) — an uploaded pair
# may have no mix file at all. So it is selectable in the swap picker in its own
# right, and a swap consumes it IDENTICALLY to one Demucs made for us: provenance is
# a sidecar field, not a code path.

@dataclass
class Source:
    kind: str                     # "song" | "stems" | "speech"
    ref: str                      # the picker ref, verbatim
    name: str                     # display name
    path: Path = None             # the song / speech file  (kind == "song" | "speech")
    d: Path = None                # the stem-set folder      (kind == "stems")


def resolve_source(cfg: SwapConfig, ref: str):
    """'acestep/<f>' | 'uploads/<f>' | 'stems/<set-ref>' | 'speech/<clip>' → Source, or
    None for a malformed/traversal ref or a source that isn't there.

    A SPEECH source is a spoken clip from the training-clip store (§3). It shares one voice
    picker, one audition and one output library with songs; what differs is the SHAPE of the
    job — no stems, no remix — and that is set here by `kind`."""
    ref = str(ref or "")
    m = _STEMS_RE.fullmatch(ref)
    if m:
        d = stems.find_dir(cfg, m.group(1))
        if d is None:
            return None
        meta = stems.read_meta(d)
        return Source(kind="stems", ref=ref, name=meta.get("song") or d.name, d=d)
    if _SPEECH_RE.fullmatch(ref):
        p = speech_path(cfg, ref)
        return None if p is None else Source(kind="speech", ref=ref, name=p.stem, path=p)
    # A Playground clip is SPEECH (7.5.26) — one stage, no Demucs, no remix. `kind` is the only
    # thing the job branches on (`is_speech = src.kind == "speech"`), so saying so here is the
    # whole integration: the ETA, the single numbered stage, the mono 96k encode and the "no
    # backing" arm all follow, and none of them learn a fourth kind.
    if _PG_RE.fullmatch(ref):
        p = pg_path(cfg, ref)
        return None if p is None else Source(kind="speech", ref=ref, name=p.stem, path=p)
    p = song_path(cfg, ref)
    if p is None:
        return None
    if ref.startswith("acelib/"):
        # The filename is a uuid hex; the TITLE lives in the library index. Falling through to
        # song_title would name the job — and the finished swap's library row — after the hex.
        idx = _acelib_index()
        song = idx.get(p.stem) if idx else None
        return Source(kind="song", ref=ref, name=song.name if song else p.stem, path=p)
    return Source(kind="song", ref=ref, name=song_title(p), path=p)


def stems_id(cfg: SwapConfig, src: Source) -> str:
    """Return the identity of the audio being converted for the first component of the swap key. Use the song content hash, stem-set identity, or speech-clip content hash according to source kind. Require readable stem metadata; never substitute an empty identity for an unreadable sidecar."""
    if src.kind == "stems":
        return str(stems.read_meta(src.d, strict=True).get("h") or "")
    # stems.song_id, NOT stems.song_hash: this is reached from /voiceswap/probe, i.e. from
    # EVERY NUDGE OF THE PITCH SLIDER, and song_hash reads the whole song (M4). Same number.
    return stems.song_id(cfg, src.path)


# ── identity ─────────────────────────────────────────────────────────────────

def swap_hash(source_id: str, voice_pth: Path, pitch: int, index_rate: float,
              vocal_gain: float, backing_gain: float,
              rms_mix_rate: float = RMS_MIX_DEFAULT,
              kind: str = "song", cleanup: bool = False) -> str:
    """Hash the effective inputs that determine a swap: audio identity, voice checkpoint identity, optional index size and mtime, and output-affecting settings. Include speech kind and cleanup settings for speech sources while preserving the existing song key format. Use vault-aware logical file metadata so encryption does not change identity; device choice is not part of the key."""
    from tts_utils import source_stat
    st = source_stat(voice_pth)                # THE IDENTITY SEAM — never voice_pth.stat()
    if st is None:
        # It used to be a bare voice_pth.stat(), so a missing .pth raised — LOUDLY, and that is
        # correct. source_stat answers "gone" with None, and defaulting that to (0, 0) would give
        # every missing voice the SAME identity: two of them collide on one swap_hash and one
        # swap's MP3 os.replace()s the other's. That is not a hypothetical — it is exactly the bug
        # M2.5 fixed in stems_id, which fabricated "" as a corrupt set's identity.
        raise FileNotFoundError(f"voice model is missing: {voice_pth.name}")
    size, mtime = st
    # None here is not an error: a voice with no index is a supported, distinct configuration.
    # `source_stat` int()s the mtime, so this string is BYTE-IDENTICAL to main's on an
    # un-migrated box — which is the whole constraint. Change it and the library re-renders.
    ist = source_stat(voice_pth.with_suffix(".index"))
    key = (f"{source_id}|{voice_pth.stem}|{size}|{mtime}|"
           f"{pitch}|{index_rate:.6g}|{vocal_gain:.6g}|{backing_gain:.6g}|{F0_METHOD}"
           f"|rms{rms_mix_rate:.6g}"
           f"|idx{f'{ist[0]}:{ist[1]}' if ist else 'noindex'}")
    if kind != "song":
        key += f"|kind{kind}|clean{1 if cleanup else 0}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


# ── result library (mirrors playground_clips) ────────────────────────────────

def result_stem(song_name: str, voice_name: str, h: str) -> str:
    return f"{safe_name(song_name, 40)}__{safe_name(voice_name, 24)}_{h[:8]}"


def result_paths(library_dir, ref: str):
    """(mp3, yaml) for a library ref (a flat stem), or (None, None) for a
    malformed/traversal ref."""
    root = Path(library_dir)
    ref = str(ref or "")
    if not _REF_RE.fullmatch(ref) or ref.strip(".") == "":   # no separators, no "."/".."
        return None, None
    p = root / ref
    return p.with_suffix(".mp3"), p.with_suffix(".yaml")


def vocal_path(library_dir, ref: str):
    """The DRY swapped vocal beside the finished track — the target voice singing with
    no backing (§5). WAV, because this is editing material and a lossy re-encode of it
    would be vandalism. None for a malformed ref.

    It's the only new file a swap stores. The instrumental deliberately isn't here: it
    belongs to the SONG, it's in the stems store, and copying it per-swap would put one
    identical instrumental on disk per voice you tried."""
    mp3, _y = result_paths(library_dir, ref)
    return None if mp3 is None else mp3.with_name(mp3.stem + "_vocal.wav")


def find_ref_by_hash(library_dir, h: str):
    """Existing result ref for identity H, by its `_<H8>` stem suffix — the
    instant-replay path for a repeat request with identical params."""
    d = Path(library_dir)
    if not vault_fs.is_dir(d):
        return None
    for nm in sorted(vault_fs.glob(d, f"*_{h[:8]}.mp3")):
        f = d / nm
        return f.stem
    return None


def _read_yaml(p: Path):
    try:
        d = yaml.safe_load(vault_fs.read_text(p))
        return d if isinstance(d, dict) else None
    except Exception:
        logger.exception(f"swap sidecar unreadable — skipping: …_{p.stem.rsplit('_', 1)[-1]}")
        return None


def write_sidecar(yaml_path: Path, meta: dict) -> dict:
    meta = dict(meta)
    meta.setdefault("created", _now())
    # A RE-RENDER MUST NOT UN-STAR A TRACK. Every other field here is derived from the job
    # and is safe to overwrite; `favorite` is the one thing on this sidecar the user decided
    # themselves, so it survives a rewrite of everything around it.
    prior = _read_yaml(yaml_path) if vault_fs.exists(yaml_path) else None
    if prior and prior.get("favorite"):
        meta["favorite"] = True
    return _merge_yaml(yaml_path, meta, replace=True)


# Store favorites in the sidecar for the song, voice, or finished swap so a favorite is deleted with its subject and does not require a separate index.
# Keep favorites out of regenerable caches. A favorite is user-selected metadata, not a derivable property.
# Do not include favorites in `swap_hash`; they do not change the audio identity and must not cause a re-render.

def _merge_yaml(p: Path, updates: dict, replace: bool = False) -> dict:
    """Atomically merge updates into an existing YAML sidecar while preserving other fields; with replace=True, write the supplied document as the complete sidecar. Use vault-aware reads and writes so sidecars remain encrypted and existing metadata is not lost when routed files are not visible through raw pathlib."""
    meta = {} if replace else ((_read_yaml(p) or {}) if vault_fs.exists(p) else {})
    meta.update(updates)
    vault_fs.write_yaml_atomic(p, meta)      # a crash mid-write must not eat the sidecar
    return meta


def set_song_favorite(cfg: SwapConfig, ref: str, fav: bool):
    """Set the favorite flag for a song. For a library entry, update the shared ACE-Step index so the library tab and swap picker show the same value; use a sidecar for other song sources."""
    p = song_path(cfg, ref)                  # validates the ref and guards traversal
    if p is None:
        return None
    if str(ref).startswith("acelib/"):
        from vocalis.runtime import acelib
        song = acelib.update(p.stem, favorite=bool(fav))
        return None if song is None else bool(song.favorite)
    return bool(_merge_yaml(p.with_suffix(".yaml"), {"favorite": bool(fav)})["favorite"])


def set_voice_favorite(rvc_dir, name: str, fav: bool):
    """★ a voice. None if there is no such .pth in the registry.

    Writes the SIDECAR, never the weight. Landmine: swap_hash() folds the .pth's st_size and
    st_mtime into every swap's identity, so touching the .pth itself — even to rewrite it
    byte-identically — would orphan every swap ever made with that voice."""
    if not voice_files(rvc_dir, name):       # validates the name and guards traversal
        return None
    p = Path(rvc_dir) / f"{Path(name).name}.yaml"
    return bool(_merge_yaml(p, {"favorite": bool(fav)})["favorite"])


def set_swap_favorite(library_dir, ref: str, fav: bool):
    """★ a finished swap. None if the ref is malformed or the track is gone.

    `vault_fs.exists`, not `.is_file()`: the swap's MP3 is in `output/voiceswap/`, so under the
    vault its plaintext name is not on the platter and a raw `is_file()` says "gone" about every
    track in the library. The star would then quietly do nothing, for everything, forever."""
    mp3, side = result_paths(library_dir, ref)
    if mp3 is None or not vault_fs.exists(mp3):
        return None
    return bool(_merge_yaml(side, {"favorite": bool(fav)})["favorite"])


def list_swaps(library_dir) -> list:
    """Return finished MP3 and YAML pairs for the library. Resolve ACE-Step metadata through the library index when needed; a locked vault or deleted source contributes no seed metadata."""
    d = Path(library_dir)
    out = []
    idx = None
    for ynm in sorted(vault_fs.glob(d, "*.yaml")):
        y = d / ynm
        mp3 = y.with_suffix(".mp3")
        if not vault_fs.exists(mp3):
            continue                       # half-written / half-deleted pair
        meta = _read_yaml(y) or {}
        st = vault_fs.stat(mp3)            # LOGICAL — a raw stat is the ciphertext size
        vocal = vocal_path(d, mp3.stem)
        sref = str(meta.get("song_ref") or "")
        seed = None
        if sref.startswith("acelib/"):
            if idx is None:
                idx = _acelib_index() or {}
            song = idx.get(Path(sref[len("acelib/"):]).stem)
            seed = song.seed if song is not None else None
        out.append({"ref": mp3.stem, "seed": seed,
                    "song": meta.get("song", ""), "song_ref": meta.get("song_ref", ""),
                    # 8.9 — THE GROUP KEY, COMPUTED ONCE AND ON THE SERVER. The library renders one
                    # card per SONG, not per swap (`vsGroups`), so a virtual folder is a property of
                    # the GROUP — and the group needs one definition of its identity, not two that
                    # can drift. The client's `vsKey()` is the same fallback chain and
                    # `test_voiceswap.py` pins the two to agree.
                    #
                    # 📌 `song_h` FIRST, and it is why folders work here at all: it is the song's
                    # CONTENT HASH, so a re-run of the same song lands in the same group and
                    # inherits its folder with no action. Filing the group beats filing rows.
                    # ⚠️ The chain ends at the display NAME for pre-M4 sidecars carrying neither
                    # field. Those groups are exactly as stable as the grouping already is — folders
                    # inherit that property rather than introducing a weaker one.
                    "gkey": (meta.get("song_h") or meta.get("stems_ref")
                             or meta.get("song", "")),
                    # 4.3: song | speech — badges the row and drives the Songs|Speech filter
                    # (§4). Pre-4.3 sidecars have no kind and are all songs, so default there.
                    "kind": meta.get("kind", "song"), "cleanup": bool(meta.get("cleanup")),
                    # M4: what the swap was made FROM, so the library's Stems view can
                    # group by song and show one instrumental under several vocals.
                    # Pre-M4 sidecars have neither; the UI falls back to the song name.
                    "song_h": meta.get("song_h"), "stems_ref": meta.get("stems_ref"),
                    "voice": meta.get("voice", ""),
                    "pitch": meta.get("pitch"), "index_rate": meta.get("index_rate"),
                    "rms_mix_rate": meta.get("rms_mix_rate"),
                    "vocal_gain": meta.get("vocal_gain"), "backing_gain": meta.get("backing_gain"),
                    "device": meta.get("device"),
                    "duration_s": meta.get("duration_s"),
                    "created": meta.get("created"),
                    "created_ts": st.mtime if st else 0,
                    "size": st.size if st else 0,
                    "vocal": bool(vocal and vault_fs.exists(vocal)),
                    "vocal_size": (vault_fs.stat(vocal).size
                                   if vocal and vault_fs.exists(vocal) else 0),
                    "favorite": bool(meta.get("favorite"))})
    out.sort(key=lambda r: r["created_ts"], reverse=True)
    return out


def delete_swaps(library_dir, refs: list) -> list:
    """Delete results (mp3 + yaml + the dry vocal). Unknown/malformed refs are
    skipped."""
    deleted = []
    for ref in refs:
        mp3, y = result_paths(library_dir, str(ref))
        if mp3 is None:
            continue
        wav = vocal_path(library_dir, str(ref))
        existed = vault_fs.exists(mp3) or vault_fs.exists(y)
        vault_fs.unlink(mp3, missing_ok=True)
        vault_fs.unlink(y, missing_ok=True)
        vault_fs.unlink(wav, missing_ok=True)
        if existed:
            deleted.append(str(ref))
    return deleted


# ── jobs ─────────────────────────────────────────────────────────────────────

@dataclass
class SwapJob:
    id: str
    source_ref: str                 # 'acestep/<f>' | 'uploads/<f>' | 'stems/<set>' | 'speech/<clip>'
    song_name: str
    voice: str                      # voice stem (registry name)
    pitch: int
    index_rate: float
    vocal_gain: float
    backing_gain: float
    device: str                     # resolved "cuda:N" | "cpu" (never "auto" here)
    h: str
    rms_mix_rate: float = RMS_MIX_DEFAULT   # volume envelope — see RMS_MIX_DEFAULT
    kind: str = "song"              # "song" | "stems" | "speech" (§3) — sets the job SHAPE
    cleanup: bool = True            # speech only: isolate the voice with Demucs first (§3.2)
    preview: bool = False           # audition: 15 s excerpt, no library entry
    status: str = "queued"          # queued|running|done|failed|canceled
    stage: str = ""                 # ""|clean|stems|convert|remix|encode
    error: str = None
    result_ref: str = ""
    stems_ref: str = ""             # the set stage 1 resolved to (§5) — sidecar + UI
    demucs: bool = False            # did stage 1 actually have to RUN Demucs?
    started_at: float = 0.0
    last_line: str = ""             # most recent child-output line — error context
    events: list = field(default_factory=list)
    subscribers: list = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


def new_job(**kw) -> SwapJob:
    job = SwapJob(id=uuid.uuid4().hex[:12], **kw)
    with JOBS_LOCK:
        JOBS[job.id] = job
        finished = [j for j in JOBS.values() if j.status in ("done", "failed", "canceled")]
        for j in finished[:max(0, len(JOBS) - JOBS_KEEP)]:
            JOBS.pop(j.id, None)
    return job


def get_job(job_id: str):
    with JOBS_LOCK:
        return JOBS.get(job_id)


def live_h(h: str) -> bool:
    """True if a swap for this exact identity is queued/running — two would
    write the same workdir and library file over each other, so the start
    endpoint 409s instead."""
    with JOBS_LOCK:
        return any(j.h == h and j.status in ("queued", "running") for j in JOBS.values())


class StageFailed(RuntimeError):
    """A child stage (Demucs / ffmpeg / RVC) exited non-zero.

    `str(exc)` is a SAFE summary — stage name and exit code — because that is what
    logger.exception() writes into logs/vocalis.log, which lives outside the vault.
    `.detail` carries the child's own last output line, which contains full filesystem
    paths (⇒ song titles and voice names). It goes to the browser, and nowhere else."""

    def __init__(self, message: str, *, detail: str = ""):
        super().__init__(message)
        self.detail = detail


def emit(job: SwapJob, ev: dict):
    """Book-rails event fan-out: ring buffer for reconnect replay + live SSE
    subscribers. (No high-frequency event types here, so everything buffers.)"""
    with job.lock:
        job.events.append(ev)
        if len(job.events) > EVENT_CAP:
            del job.events[:len(job.events) - EVENT_CAP]
        for q in job.subscribers:
            q.put(ev)


# ── stage commands (pure builders — unit-testable without a subprocess) ──────

# pyworld (a dependency of rvc-python) imports pkg_resources at import time, so
# setuptools >= 81 emits a deprecation UserWarning on EVERY RVC invocation. It is
# third-party, it is purely cosmetic, and the two "real" fixes are both worse than the
# problem: patching pyworld means editing a site-packages file that any reinstall
# silently reverts, and pinning setuptools < 81 in the voiceswap venv means holding a
# working RVC stack hostage to a log line. So: silence exactly that one warning in the
# child, and nothing else. Any genuinely new warning still gets through.
#
# NB PYTHONWARNINGS is COLON-separated (action:message:category:module:line), so the
# message filter must not contain a colon — the full text runs "...as an API. See
# https://setuptools..." and that URL's colon would corrupt the filter. The prefix
# below is the longest colon-free part, and warnings matches the message by prefix.
_QUIET_PKG_RESOURCES = "ignore:pkg_resources is deprecated:UserWarning"


def _card_env(device: str) -> dict:
    """Pin a job to one card via the visibility env vars (works under ROCm and
    CUDA alike): children then see a single device, addressed as cuda:0."""
    env = dict(os.environ)
    if device.startswith("cuda:"):
        idx = device.split(":", 1)[1]
        env["HIP_VISIBLE_DEVICES"] = idx
        env["CUDA_VISIBLE_DEVICES"] = idx
    env.setdefault("MIOPEN_FIND_MODE", "FAST")     # box convention (PoC report)
    prior = env.get("PYTHONWARNINGS")              # never clobber an operator's setting
    env["PYTHONWARNINGS"] = (f"{prior},{_QUIET_PKG_RESOURCES}" if prior
                             else _QUIET_PKG_RESOURCES)
    return env


def build_convert_cmd(cfg: SwapConfig, vocals: Path, swapped: Path,
                      pth: Path, index, pitch: int, index_rate: float,
                      device: str, rms_mix_rate: float = RMS_MIX_DEFAULT) -> list:
    cmd = [str(cfg.python), str(cfg.scripts_dir / "rvc_infer.py"),
           "-i", str(vocals), "-o", str(swapped), "-m", str(pth)]
    if index:
        cmd += ["--index", str(index)]
    cmd += ["--pitch", str(pitch), "--index-rate", f"{index_rate:.6g}",
            "--rms-mix-rate", f"{rms_mix_rate:.6g}",
            "--f0-method", F0_METHOD,
            # _card_env made the chosen card the only visible one.
            "--device", "cpu" if device == "cpu" else "cuda:0"]
    return cmd


def build_slice_cmd(src: Path, out_wav: Path, start: float,
                    seconds: int = PREVIEW_SECONDS) -> list:
    """Build a fast-seek command that cuts an audition excerpt from stored stems and outputs PCM for the RVC conversion and remix stages. Reuse stored stems so changing audition settings does not rerun source separation."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-ss", f"{start:.1f}", "-t", str(seconds), "-i", str(src),
            "-c:a", "pcm_s16le", str(out_wav)]


def preview_start(duration: float) -> float:
    """Where the audition excerpt begins: a quarter into the song (past the
    intro, usually into sung material), clamped so the excerpt fits."""
    if duration <= 0:
        return 0.0
    return max(0.0, min(duration * 0.25, duration - PREVIEW_SECONDS))


def preview_path(cfg: SwapConfig, h: str):
    """The audition MP3 for identity H, or None for a malformed hash. Keyed on
    the same identity as the full swap, so a repeat audition is served as-is."""
    if not re.fullmatch(r"[0-9a-f]{12}", str(h or "")):
        return None
    return cfg.preview_dir / f"{h}.mp3"


def _prune_previews(d: Path, keep: int = PREVIEW_KEEP):
    files = sorted((d / n for n in vault_fs.glob(d, "*.mp3")),
                   key=lambda p: (vault_fs.stat(p).mtime if vault_fs.stat(p) else 0),
                   reverse=True)
    for f in files[keep:]:
        vault_fs.unlink(f, missing_ok=True)


def build_remix_cmd(swapped: Path, backing: Path, out_mp3: Path,
                    vocal_gain: float, backing_gain: float) -> list:
    # RVC returns a mono vocal while the instrumental is stereo. Upmix the vocal before `amix`, which otherwise chooses the smallest common channel layout and can downmix the backing. Keep `normalize=0` to avoid the filter’s default per-input attenuation.
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(swapped), "-i", str(backing),
            "-filter_complex",
            f"[0:a]volume={vocal_gain:.6g},aformat=channel_layouts=stereo[v];"
            f"[1:a]volume={backing_gain:.6g}[b];"
            f"[v][b]amix=inputs=2:duration=longest:normalize=0[out]",
            "-map", "[out]", "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, str(out_mp3)]


def build_speech_encode_cmd(swapped: Path, out_mp3: Path) -> list:
    """Finish a SPEECH swap (§4). There is no backing to mix — the converted voice IS the
    output — so it is encoded straight to the SPEECH rule: MONO @ 96k (SPEECH_MP3_BITRATE,
    which is enhance.mp3_bitrate()'s PLAIN value), never the 320k stereo the remix uses for
    music. `-ac 1` because RVC's output is one voice; keeping it mono halves the file for no
    audible loss on speech."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(swapped), "-ac", "1",
            "-c:a", "libmp3lame", "-b:a", SPEECH_MP3_BITRATE, str(out_mp3)]


def build_decode_wav_cmd(src: Path, out_wav: Path) -> list:
    """Decode a whole speech clip to PCM WAV. RVC must be fed a WAV: the song path always
    hands it a WAV vocal stem, and rvc_infer's MIOpen warm-up reads its input with
    scipy.io.wavfile, which is WAV-only — give it an mp3 and the warm-up silently skips, the
    ~3.9 s kernel-select cost lands in compute_s, and the measured rate is poisoned
    (Landmine 2). Used only on the NO-clean-up speech path; the clean-up path's Demucs vocal
    is already a WAV."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(src), "-c:a", "pcm_s16le", str(out_wav)]


def build_excerpt_cmd(src_mp3: Path, out_mp3: Path, start: float,
                      seconds: int = PREVIEW_SECONDS) -> list:
    """Cut the audition excerpt straight out of an ALREADY-FINISHED track.

    `-ss` goes AFTER `-i` here, unlike build_slice_cmd. Before `-i` it is a fast seek that
    lands on the nearest frame, and "nearest" is not the same instant in two MP3s whose frames
    were laid out by different encodes. After `-i`, ffmpeg decodes and discards — sample-
    accurate, and it costs milliseconds on a four-minute file. Two auditions of the same song
    have to start at the same instant or they cannot be compared, and comparing is the whole
    job of the button.

    Re-encoded, NOT `-c copy`. A stream copy can only cut on frame boundaries, so it would
    hand back a bit more than `seconds` of audio, starting a bit before `start`. The encode is
    instant at this length and gives exactly the excerpt asked for."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(src_mp3), "-ss", f"{start:.3f}", "-t", str(seconds),
            "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, str(out_mp3)]


def ffprobe_duration(path) -> float:
    """Return the track duration rounded to 0.1 seconds, or 0.0 when unreadable. Route vault-backed inputs through child_input before invoking ffprobe; callers treat failure as missing display metadata, not as a job failure."""
    import scratch as scratch_mod
    import vault_fs
    with vault_fs.child_input(path, scratch_mod.scratch_root()) as plain:
        return _ffprobe_duration(plain)


def _ffprobe_duration(path) -> float:
    """`ffprobe_duration`'s body, on a path a CHILD PROCESS CAN OPEN. Never call it with a
    store path — that is what the wrapper above is for."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        return round(float(r.stdout.strip()), 1) if r.returncode == 0 else 0.0
    except Exception:
        return 0.0


def duration_of(path, meta: dict = None) -> tuple:
    """Return cached (duration_s, fields_to_persist) for a file. Probe unchanged files only once, cache by vault-aware size and mtime, and leave fields_to_persist empty on a cache hit so listings perform no redundant writes."""
    p = Path(path)
    st = source_stat(p)                      # the seam, not p.stat()
    if st is None:
        return 0.0, {}                       # gone/unreadable: the prober's own answer
    size, mtime = st

    m = meta or {}
    if (m.get("duration_s") is not None
            and m.get("duration_size") == size
            and int(m.get("duration_mtime") or -1) == mtime):
        return float(m["duration_s"]), {}    # cache hit — no subprocess, no audio touched

    dur = ffprobe_duration(p)
    return dur, {"duration_s": dur, "duration_size": size, "duration_mtime": mtime}


# ── stage runner ─────────────────────────────────────────────────────────────

def _kill_tree(proc):
    """Kill the child's whole process group. Demucs forks multiprocessing
    workers; killing only the parent orphans them holding GPU VRAM (the
    critical lesson from the training PoC). SIGTERM first, SIGKILL after a
    grace period. Windows (dev only): plain kill."""
    if os.name != "nt":
        try:
            pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            return
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            return
        for _ in range(50):                    # 5 s grace
            if proc.poll() is not None:
                return
            time.sleep(0.1)
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        proc.kill()


def _run_stage(job: SwapJob, cmd: list, env: dict = None, cwd=None,
               timing: dict = None) -> int:
    """Run one stage as a child process (its own session/process group),
    streaming its output into the job's event log, honoring cancel.
    Returns the exit code; -1 signals 'killed by cancel'.
    `env` carries the _card_env device pinning; `cwd` is for tools that must
    run from their install dir (Applio's core.py resolves logs/ relatively).
    `timing`, if given, is filled from the child's machine-readable VOCALIS_TIMING
    line (swap_rate) — consumed HERE and never shown, exactly as enhance.py does:
    it is how this box learns its own swap speed, not log output for the user."""
    kw = {}
    if os.name != "nt":
        kw["start_new_session"] = True         # own pgid — _kill_tree needs it
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace",
                            env=env, cwd=str(cwd) if cwd else None, **kw)

    last = [""]                                # most recent line — error context
    err = [""]                                 # last explicit ERROR line — better context

    def _pump():
        # Progress bars (demucs tqdm) rewrite one line with \r — emit at most
        # ~1/s of those so the SSE log shows progress without drowning in it.
        last_cr = 0.0
        for raw in iter(proc.stdout.readline, ""):
            for piece in raw.replace("\r", "\n").split("\n"):
                piece = piece.strip()
                if not piece:
                    continue
                if timing is not None:
                    t = swap_rate.parse_timing(piece)
                    if t is not None:
                        timing.update(t)
                        continue               # machine-readable — learned, never shown
                    if piece.startswith("VOCALIS_TIMING "):
                        continue               # unusable measurement — still not log output
                if any(n in piece for n in NOISE_MARKERS):
                    continue                   # known-benign ROCm chatter — server log only
                last[0] = piece
                if piece.startswith(("ERROR", "error:")) or "Error" in piece[:40]:
                    err[0] = piece
                now = time.monotonic()
                if "\r" in raw and "\n" not in raw and now - last_cr < 1.0:
                    continue
                if "\r" in raw:
                    last_cr = now
                emit(job, {"type": "log", "line": piece})
        proc.stdout.close()

    t = threading.Thread(target=_pump, daemon=True)
    t.start()
    while proc.poll() is None:
        if job.cancel.is_set():
            emit(job, {"type": "log", "line": f"Cancel — stopping {job.stage}…"})
            _kill_tree(proc)
            proc.wait()
            t.join(timeout=5)
            return -1
        time.sleep(0.2)
    t.join(timeout=5)
    job.last_line = err[0] or last[0]
    return proc.returncode


# ── stage 1: get the stems (§5) ──────────────────────────────────────────────
# Shared by the swap chain and by the Stems tab's split job (stemsplit.py calls
# straight into this): they were always the same Demucs run writing to two different
# places, and now they're the same Demucs run writing to one.
#
# The caller must already hold SWAP_LOCK — this shells out to a GPU-hungry child, and
# taking the lock here would nest it under the swap's own acquisition and deadlock.

#: What each mode is called in the job log. `vocals` is 8.4's harvest mode: the same Demucs
#: run as 2-stem, with only the vocal kept (§6.4).
_DEMUCS_INTO = {
    "2stem": "vocals + instrumental",
    "4stem": "vocals / drums / bass / other",
    "vocals": "the vocal alone (the instrumental is computed and dropped)",
}


def get_stems(job, cfg: SwapConfig, src: Source, mode: str = "2stem", work: Path = None):
    """Resolve `src` to (vocals, instrumental, set-ref) — running Demucs ONLY if the
    store hasn't got what's asked for.

        uploads/stems/  hit? → use it, skip Demucs
        output/stems/   hit? → use it, skip Demucs
        miss                 → Demucs INTO output/stems/, then use it

    Returns (None, None, None) if the job was canceled mid-Demucs (the _stage_ok
    contract: it has already set the status and emitted).

    A stem set is returned STRAIGHT OUT OF THE LIBRARY — not copied into the job's
    scratch dir. That's deliberate: the reason Demucs used to run twice per song is
    that stage 1's output lived in a workdir that got rmtree'd at the end of the job."""
    if src.kind == "stems":
        if not stems.has_base(src.d):
            raise RuntimeError(
                f"“{src.name}” has no vocal to convert — a stem set needs both a vocals "
                f"and an instrumental stem to be swappable")
        job.stems_ref = src.d.name
        emit(job, {"type": "log",
                   "line": f"Using the stems of “{src.name}” — no split needed."})
        # 🔴 RESOLVED, NOT CONSTRUCTED (7.5.25). A set holds `vocals.opus` or `vocals.wav`
        # depending on when it was made, and `has_base` above has just agreed there IS a
        # vocal — building the path by hand would hand back one that does not exist and fail
        # at the RVC stage, minutes later, for a set the picker called swappable.
        return (stems.find_stem(src.d, "vocals"), stems.find_stem(src.d, "instrumental"),
                src.d.name)

    h = stems.song_id(cfg, src.path)
    found = stems.find_by_hash(cfg, h)
    if found is not None and stems.satisfies(found, mode):
        job.stems_ref = found.name
        emit(job, {"type": "log",
                   "line": f"“{src.name}” is already split — reusing the stored stems, "
                           f"skipping Demucs."})
        return (stems.find_stem(found, "vocals"), stems.find_stem(found, "instrumental"),
                found.name)

    work = Path(work or cfg.work_root / job.id)
    work.mkdir(parents=True, exist_ok=True)
    env = _card_env(job.device)
    job.demucs = True
    emit(job, {"type": "log",
               "line": f"Demucs: splitting “{src.name}” into {_DEMUCS_INTO.get(mode, mode)}…"})

    demucs_python = cfg.demucs_python
    if not demucs_python.is_file():
        raise RuntimeError(f"Stems Demucs interpreter is missing: {demucs_python}")
    # No route starts a swap in this edition, but this is a second Demucs spawn site, so it gets
    # the same weights check as `stem_engine.get_stems`: Demucs downloads absent weights itself.
    # October 11, 2026: the child's TORCH_HOME is the models folder setup downloaded the weights into
    # (stems.demucs_child_env); `env` is rebuilt once here and used for both the check and the spawn.
    env = stems.demucs_child_env(env)
    stems.require_demucs_model(env)

    # Pass Demucs an opaque copy with the original suffix so it can identify the format. This keeps user-provided song titles out of child-process paths and echoed output.
    # Create the copy only when separation is needed. Decrypt vault-routed sources into owned scratch; external sources are already plaintext but still receive an opaque filename.
    r = vault_store.route(src.path)
    if r is not None:
        v, logical = r
        song = v.decrypt_to_scratch(logical, work)      # same sha256[:16] + suffix construction
    else:
        song = work / scratch.opaque_name(str(src.path), Path(src.path).suffix)
        shutil.copyfile(src.path, song)                 # gocryptfs's, or an un-migrated box

    rc = _run_stage(job, stems.build_demucs_cmd(demucs_python, song, work,
                                                job.device, mode), env)
    out = stems.demucs_out_dir(work, song)
    missing = [s for s in stems.DEMUCS_RAW[mode] if not (out / s).exists()]
    if rc == 0 and missing:
        raise RuntimeError(f"Demucs finished but stems are missing: {', '.join(missing)}")
    if not _stage_ok(job, rc, "Demucs split"):
        return None, None, None

    # Demucs's own names → ours. In 2-stem it hands back `no_vocals.wav`; in 4-stem it
    # hands back no instrumental at all, so we sum the three parts into one (§5 — every
    # set carries a 2-stem base, which is what makes ANY set swappable).
    produced = {"vocals.wav": out / "vocals.wav"}
    if mode == "vocals":
        # 🔴 8.4 §6.4 — THE INSTRUMENTAL IS COMPUTED AND THEN NOT HARVESTED. Demucs wrote
        # `no_vocals.wav` into the scratch a few lines ago and it goes with the workdir. The
        # reason is not disk: the lead this set exists for is about to be CUT — every stacked
        # passage removed — so a full-length instrumental sitting beside it is a pair that can
        # only mislead. Every player, every zip and every future reader would treat them as a
        # matched set, and they are not one.
        #
        # ⚠️ THIS DROPS WHAT *THIS RUN* MADE, NOT WHAT THE SET ALREADY HAS. If the song was
        # 2- or 4-split before, its instrumental is on disk and stays there — commit() extends
        # a set, it never replaces one, and this mode adds but never deletes (§6 R4).
        pass
    elif mode == "2stem":
        produced["instrumental.wav"] = out / stems.LEGACY_INSTRUMENTAL
    else:
        for s in stems.SUM_PARTS:
            produced[s] = out / s
        inst = out / "instrumental.wav"
        emit(job, {"type": "log",
                   "line": "ffmpeg: summing drums + bass + other into the instrumental…"})
        rc = _run_stage(job, stems.build_sum_cmd([out / p for p in stems.SUM_PARTS], inst))
        if rc == 0 and not inst.exists():
            raise RuntimeError("ffmpeg produced no instrumental to mix over")
        if not _stage_ok(job, rc, "instrumental sum"):
            return None, None, None
        produced["instrumental.wav"] = inst

    duration = ffprobe_duration(produced["vocals.wav"])       # before commit moves it

    # Convert the fresh WAV before storing the stem as Opus. This avoids an unnecessary lossy encode/decode round trip within the same job; later jobs may use the stored Opus.
    fresh = {stems.stem_key(n): Path(p) for n, p in produced.items() if stems.stem_key(n)}

    plan = stems.encode_plan(produced, work)
    if plan:
        emit(job, {"type": "log",
                   "line": f"ffmpeg: encoding {len(plan)} stem"
                           f"{'' if len(plan) == 1 else 's'} to Opus {stems.STEM_BITRATE}…"})
        for _key, wav, opus in plan:
            rc = _run_stage(job, stems.build_encode_cmd(wav, opus))
            if rc == -1 or job.cancel.is_set():
                if not _stage_ok(job, rc, "stem encode"):
                    return None, None, None
            if rc != 0 or not opus.exists():
                emit(job, {"type": "log",
                           "line": f"Could not encode {opus.name} — keeping the WAV for "
                                   f"this stem. The set is fine; it just takes more disk."})
        produced = stems.encoded_produced(produced, plan)

    prev_meta = stems.read_meta(found) if found is not None else {}
    # Extend the set in place when it exists (a 4-stem split of an already-2-stem song),
    # otherwise name it after the song — never inside uploads/, which is yours, not ours.
    dest = (found if found is not None and found.parent == Path(cfg.stems_dir)
            else Path(cfg.stems_dir) / stems.set_ref(src.name, h))
    meta = {
        "h": h, "source": "demucs", "song": src.name, "song_ref": src.ref, "song_h": h,
        "model": stems.DEMUCS_MODEL, "device": job.device, "duration_s": duration,
        "created": prev_meta.get("created") or _now(),
    }
    # 🔴 8.4 — CARRY THE `lead:` BLOCK FORWARD. commit() writes a FRESH sidecar, so anything
    # not named in this dict is erased. A song given a lead extraction and later swapped (which
    # runs a 2-stem split to get the instrumental it never had) would otherwise lose the
    # provenance of a file still sitting in the folder — which stem was cut, by which detector,
    # de-reverbed or not. §4b's "never mix wet and dry material in one singer's dataset" is
    # only checkable while that block survives.
    if prev_meta.get("lead"):
        meta["lead"] = prev_meta["lead"]
    stems.commit(dest, produced, meta)
    job.stems_ref = dest.name
    emit(job, {"type": "stems_saved", "ref": dest.name})
    # The work-dir WAVs (see `fresh`), falling back to the stored file if one is somehow gone —
    # a set committed and then swept between these two lines is not worth a crash.
    return (fresh.get("vocals") if fresh.get("vocals", Path("")).exists()
            else stems.find_stem(dest, "vocals"),
            fresh.get("instrumental") if fresh.get("instrumental", Path("")).exists()
            else stems.find_stem(dest, "instrumental"),
            dest.name)


# ── the job ──────────────────────────────────────────────────────────────────

def _record_swap_rate(timing: dict, convert_wall: float) -> None:
    """Fold this conversion into the box's measured swap rate (swap_rate.py).

    The convert stage IS the whole rvc_infer.py process, so `convert_wall` is the child's
    wall clock and `startup = wall - compute_s` — everything that did not scale with the
    audio (spawn, imports, the model load, the WAV write). NOT `load_s`: that only proves the
    measurement is usable; the real startup is what the parent stopwatch saw. AUDITIONS count
    too: a 15 s preview is the same child at the same settings, and they are frequent, so the
    box learns fast. Never fatal — a rate cache is not the job, and a swap that produced audio
    must not fail because its stopwatch didn't."""
    if not timing:
        return                                  # child couldn't time itself — no measurement
    startup = convert_wall - timing["compute_s"]
    if startup < 0:
        return                                  # clock skew / a warm-up race — don't poison it
    try:
        swap_rate.record(swap_rate.key_for(_gpu_name(), F0_METHOD),
                         timing["audio_s"], timing["compute_s"], startup)
    except Exception:                           # noqa: BLE001 — a rate cache is not the job
        logger.exception("could not record the swap rate")


def _fmt_eta(secs: float) -> str:
    """A swap ETA as a short human string: seconds under a minute and a half, minutes above."""
    secs = int(round(secs))
    if secs < 90:
        return f"{secs} s"
    m, s = divmod(secs, 60)
    return f"{m} min {s} s" if s else f"{m} min"


def _emit_swap_eta(job: SwapJob, vocals: Path) -> None:
    """Emit one pre-conversion line using the measured wall-clock rate for this audio and configuration, or state that no estimate is available yet."""
    try:
        fit = swap_rate.get(swap_rate.key_for(_gpu_name(), F0_METHOD))
    except Exception:                           # noqa: BLE001 — an ETA is never the job
        return
    if not fit:
        emit(job, {"type": "log", "line":
                   "No time estimate yet — this box hasn't been timed at these settings. This "
                   "run will time it; the next will have a number."})
        return
    eta = swap_rate.eta_seconds(ffprobe_duration(vocals), fit)
    if eta and eta > 0:
        emit(job, {"type": "log",
                   "line": f"Estimated ~{_fmt_eta(eta)} at this box's measured swap rate."})


def queue_eta(audio_s: float):
    """Return the measured wall-clock estimate for a swap of the given audio duration, or None until the configuration has timing data. Use the same rate as ad-hoc swaps so per-job and queue totals stay consistent."""
    try:
        fit = swap_rate.get(swap_rate.key_for(_gpu_name(), F0_METHOD))
    except Exception:                           # noqa: BLE001 — an ETA is never load-bearing
        return None
    if not fit or not audio_s:
        return None
    return swap_rate.eta_seconds(float(audio_s), fit)


def source_audio_s(cfg: SwapConfig, src: Source) -> float:
    """How much audio a swap of `src` will convert — for the queue's ETA. A stem set carries
    its duration in its meta; a song/speech file is probed. 0.0 when it can't be read (the ETA
    then just says 'not timed', which is honest)."""
    if src.kind == "stems":
        return float(stems.read_meta(src.d).get("duration_s") or 0)
    return ffprobe_duration(src.path) if src.path else 0.0


def run_swap_job(job: SwapJob, cfg: SwapConfig):
    """The full chain, on the book-job rails. Runs in a daemon thread."""
    work = cfg.work_root / job.id
    try:
        job.status = "running"
        job.started_at = time.time()
        emit(job, {"type": "job_start", "id": job.id, "kind": "voiceswap"})

        if not cfg.python.exists():
            raise RuntimeError(
                f"voiceswap venv python not found: {cfg.python} — run "
                f"scripts/voiceswap/setup.sh on the server (or set VOICESWAP_VENV)")

        # One swap at a time — cancel-aware wait, like playground vs the GPU gate.
        waited = False
        while not SWAP_LOCK.acquire(timeout=0.5):
            if not waited:
                waited = True
                emit(job, {"type": "log", "line": "Waiting for the previous swap to finish…"})
            if job.cancel.is_set():
                job.status = "canceled"
                emit(job, {"type": "canceled"})
                return
        # `stack` holds every plaintext this job decrypts into its workdir — the voice model,
        # its index, the stems — and wipes each one when the existing `finally` closes it,
        # whether the job finishes, raises or is canceled. `work` is the scratch (M3), so the
        # workdir's teardown is the backstop and scratch.sweep() at startup is its backstop.
        #
        # Closed in the `finally` rather than held by a `with`, because that `finally` already
        # exists to release SWAP_LOCK and this body must stay exactly where it is.
        stack = ExitStack()
        try:
            src = resolve_source(cfg, job.source_ref)
            if src is None:
                raise RuntimeError(f"the source is gone: {job.source_ref}")
            pth = Path(cfg.rvc_dir) / f"{job.voice}.pth"
            index = pth.with_suffix(".index")
            work.mkdir(parents=True, exist_ok=True)
            env = _card_env(job.device)

            # Decrypt the voice model and optional index once into the job workdir. The external RVC process opens these files directly; keeping them in the owned `ExitStack` avoids per-call decryption and removes them when the job exits.
            pth = stack.enter_context(vault_fs.child_input(pth, work))
            index = (stack.enter_context(vault_fs.child_input(index, work))
                     if vault_fs.exists(index) else None)

            # The SHAPE of the job is set by the source (§3). A song has stems and a remix; a
            # speech clip has neither — it is one conversion, optionally preceded by a clean-up
            # split (§3.2). Those two facts (kind, clean-up) drive the stage count and every
            # branch below.
            is_speech = src.kind == "speech"
            cleanup = bool(job.cleanup) if is_speech else False
            total = (2 if cleanup else 1) if is_speech else 3

            def stage(n, name, line):
                job.stage = name
                emit(job, {"type": "stage", "stage": name, "n": n, "total": total})
                emit(job, {"type": "log", "line": line})

            # Log the exact settings passed to the child before each audition or render. Speech conversions omit remix gains and report cleanup state because they do not mix a backing track.
            if is_speech:
                emit(job, {"type": "log", "line":
                           f"Settings → voice “{job.voice}” · pitch {job.pitch:+d} semitones · "
                           f"index-rate {job.index_rate:.6g} · volume-env {job.rms_mix_rate:.6g} · "
                           f"clean-up {'on' if cleanup else 'off'} · f0 {F0_METHOD} · {job.device}"})
            else:
                emit(job, {"type": "log", "line":
                           f"Settings → voice “{job.voice}” · pitch {job.pitch:+d} semitones · "
                           f"index-rate {job.index_rate:.6g} · volume-env {job.rms_mix_rate:.6g} · "
                           f"vocal-gain {job.vocal_gain:.6g} · backing-gain {job.backing_gain:.6g} · "
                           f"f0 {F0_METHOD} · {job.device}"})

            # ── stage 1: the audio to convert ────────────────────────────────────────────
            # song / stems: the vocal stem (Demucs only if the store hasn't got it). speech +
            # clean-up: the SAME 2-stem split, kept for its vocal (§3.2) and cached in the stems
            # store, so converting the clip to three voices cleans it once. speech, no clean-up:
            # the clip itself — RVC takes it whole (a full convert decodes it to WAV below).
            backing = None
            if is_speech and not cleanup:
                vocals = src.path
            elif is_speech:
                stage(1, "clean", f"[1/{total}] Cleaning up “{job.song_name}” — "
                                  f"isolating the voice with Demucs…")
                vocals, _b, _ref = get_stems(job, cfg, src, "2stem", work)
                if vocals is None:
                    return                              # canceled inside — already reported
            else:
                stage(1, "stems", f"[1/{total}] Stems for “{job.song_name}”…")
                vocals, backing, _ref = get_stems(job, cfg, src, "2stem", work)
                if vocals is None:
                    return

            # Materialize vocals and an optional backing track only after the job shape is resolved. `child_input` handles both vault and scratch paths, avoids copying files already in this workdir, and removes only plaintext files it owns.
            vocals = stack.enter_context(vault_fs.child_input(vocals, work))
            if backing is not None:
                backing = stack.enter_context(vault_fs.child_input(backing, work))

            if job.preview:
                # Audition: RVC 15 seconds of the convert source. Demucs is not in this path at
                # all once the source has been split once (§5); for speech-no-clean-up the slice
                # is cut straight from the clip.
                #
                # THE START OFFSET IS COMPUTED HERE, FROM THE CONVERT SOURCE, FOR EVERY AUDITION
                # — including the cut-from-a-finished-render one below. That is what makes two
                # auditions of the same source COMPARABLE: same file, same preview_start(), same
                # timestamp, to the sample. Deriving it from the finished MP3's own duration
                # instead would drift by up to ffprobe's 0.1 s rounding, which is enough to
                # start one clip mid-syllable and the other on the beat — and A/B-ing settings
                # is the entire job of this button.
                start = preview_start(ffprobe_duration(vocals))
                at = f"{int(start // 60)}:{int(start % 60):02d}"

                # ALREADY RENDERED IN FULL? Cut the excerpt out of the finished track instead
                # of re-running RVC. Same identity ⇒ the same audio by construction (that is
                # what `h` means), so this is not an approximation of the audition — it IS the
                # audition, arrived at for free. No GPU, no model load, no queue: it lands
                # while you are still letting go of the mouse. (build_excerpt_cmd cuts an mp3,
                # whichever encode — song or speech — produced it.)
                done = find_ref_by_hash(cfg.library_dir, job.h)
                if done:
                    mp3, _side = result_paths(cfg.library_dir, done)
                    emit(job, {"type": "log",
                               "line": f"Audition: this exact swap is already rendered — "
                                       f"cutting {PREVIEW_SECONDS} s out of it at {at} "
                                       f"(no GPU needed)…"})
                    out = preview_path(cfg, job.h)
                    # 🔴 THE SIBLING-BRANCH MISS. The GPU path below does exactly this and
                    # does it routed (`vault_fs.mkdir(cfg.preview_dir)`); this branch — taken
                    # when the swap is ALREADY rendered, i.e. the common one — was left bare,
                    # so an audition cut from a finished swap wrote its preview MP3 into the
                    # routed voiceswap_preview/ cache IN CLEARTEXT, under a cleartext name.
                    # Silent, permanent, and it is user audio. Routing the branch you are
                    # looking at is not routing the operation.
                    vault_fs.mkdir(cfg.preview_dir)
                    part = work / "preview.part.mp3"
                    # ffmpeg is a CHILD and `mp3` is a library path: it needs plaintext.
                    with vault_fs.child_input(mp3, work) as src_mp3:
                        rc = _run_stage(job, build_excerpt_cmd(src_mp3, part, start))
                    if rc == 0 and (not part.exists() or not part.stat().st_size):
                        raise RuntimeError("ffmpeg produced no audition excerpt")
                    if not _stage_ok(job, rc, "audition excerpt"):
                        return
                    vault_fs.from_scratch(part, out)      # scratch -> store, encrypting
                    _prune_previews(cfg.preview_dir)
                    job.status = "done"
                    job.stage = ""
                    emit(job, {"type": "job_done", "preview": True, "h": job.h,
                               "duration_s": ffprobe_duration(out)})
                    return

                what = "clip" if is_speech else "stored stems"
                emit(job, {"type": "log",
                           "line": f"Audition: slicing {PREVIEW_SECONDS} s of the {what} at {at}…"})
                if is_speech:
                    # One excerpt: the voice being converted. build_slice_cmd decodes whatever
                    # the clip is (mp3/wav/…) into a PCM WAV, so RVC gets a WAV either way.
                    ex = work / "speech_excerpt.wav"
                    rc = _run_stage(job, build_slice_cmd(vocals, ex, start), env)
                    if rc == 0 and not ex.exists():
                        raise RuntimeError("ffmpeg produced no excerpt to audition")
                    if not _stage_ok(job, rc, "excerpt cut"):
                        return
                    vocals = ex
                else:
                    cuts = []
                    for name, whole in (("vocals", vocals), ("backing", backing)):
                        ex = work / f"{name}_excerpt.wav"
                        rc = _run_stage(job, build_slice_cmd(whole, ex, start), env)
                        if rc == 0 and not ex.exists():
                            raise RuntimeError(f"ffmpeg produced no {name} excerpt to audition")
                        if not _stage_ok(job, rc, "excerpt cut"):
                            return
                        cuts.append(ex)
                    vocals, backing = cuts

            # 🔴 RVC MUST BE FED A WAV (Landmine 2 — rvc_infer's MIOpen warm-up reads its input
            # with scipy.io.wavfile, which is WAV-only; hand it anything else and the warm-up
            # silently skips, the ~3.9 s kernel-select cost lands in compute_s, and the measured
            # swap rate is poisoned). TWO things can now arrive here as something else:
            #
            #   · a speech clip with no clean-up — it is whatever he uploaded (mp3/flac/…);
            #   · since 7.5.25, a VOCAL STEM STORED AS OPUS, from the song path or the
            #     clean-up split. That is the new one, and it is why this test is on the
            #     SUFFIX rather than on `is_speech`: written the old way it read "speech is
            #     the compressed case", which stopped being true the moment the stem store
            #     did. Nothing would have raised — RVC would just have quietly lost its
            #     warm-up on every song swap.
            #
            # Full convert only: an audition has already sliced a PCM WAV excerpt out of
            # whatever the source was, a few lines up.
            #
            # 🔴 THE SPEECH ARM IS AN `or`, NOT A CASE OF THE SUFFIX TEST, AND COLLAPSING THE TWO
            # IS A SILENT REGRESSION — caught by test_speech_no_cleanup_skips_demucs_and_decodes_
            # to_wav, which watches for the decode by name. Written as the suffix test ALONE, a
            # speech clip that is already `.wav` skips the decode entirely, on the assumption that
            # ".wav means PCM WAV that RVC can read". It does not: `.wav` is a container, an
            # uploaded clip is whatever his recorder wrote (float32, 8-bit, ADPCM, an odd sample
            # rate), and the old unconditional decode was NORMALIZING all of that, not merely
            # changing the extension. The suffix test adds the Opus stem; it does not replace the
            # rule that was already there.
            if not job.preview and ((is_speech and not cleanup)
                                    or Path(vocals).suffix.lower() != ".wav"):
                dec = work / "convert_source.wav"
                emit(job, {"type": "log",
                           "line": f"Preparing the {'clip' if is_speech else 'vocal'} "
                                   f"(decoding {Path(vocals).suffix.lstrip('.') or 'audio'} "
                                   f"to WAV)…"})
                rc = _run_stage(job, build_decode_wav_cmd(vocals, dec))
                if rc == 0 and not dec.exists():
                    raise RuntimeError("ffmpeg produced no decoded audio to convert")
                if not _stage_ok(job, rc, "decode"):
                    return
                vocals = dec

            _emit_swap_eta(job, vocals)          # honest estimate, or "not timed yet" — never a guess
            _cn = total if is_speech else 2      # convert is the LAST numbered stage for speech
            stage(_cn, "convert",
                  f"[{_cn}/{total}] RVC: converting the "
                  f"{'voice' if is_speech else 'vocal'} to “{job.voice}”…")
            swapped = work / "vocals_swapped.wav"
            timing = {}                          # filled from the child's VOCALIS_TIMING line
            t_convert = time.monotonic()
            rc = _run_stage(job, build_convert_cmd(
                # `index` is ALREADY None-or-plaintext — child_input resolved it above, so
                # main's `index if index.exists() else None` cannot come along: it would
                # AttributeError on the None arm, i.e. on every voice without an index.
                cfg, vocals, swapped, pth, index,      # both already plaintext, in the scratch
                job.pitch, job.index_rate, job.device, job.rms_mix_rate), env,
                timing=timing)
            convert_wall = time.monotonic() - t_convert
            if rc == 0 and not swapped.exists():
                raise RuntimeError("RVC finished but produced no output file")
            if not _stage_ok(job, rc, "RVC conversion"):
                return
            # The box just timed itself on the real code path — record it (auditions included).
            _record_swap_rate(timing, convert_wall)

            # Finish: a song is remixed over its backing; speech has no backing, so the
            # converted voice IS the output and is encoded straight to the speech rule (§4).
            # Neither is a numbered stage for speech ("1–2 stages" per §2) — it's instant here.
            part = work / "result.part.mp3"
            if is_speech:
                emit(job, {"type": "log",
                           "line": "Encoding the converted voice (speech: mono, 96 kbps)…"})
                rc = _run_stage(job, build_speech_encode_cmd(swapped, part))
                if rc == 0 and (not part.exists() or not part.stat().st_size):
                    raise RuntimeError("ffmpeg produced no speech output")
                if not _stage_ok(job, rc, "speech encode"):
                    return
            else:
                stage(3, "remix", "[3/3] ffmpeg: remixing the swapped vocal over the instrumental…")
                rc = _run_stage(job, build_remix_cmd(swapped, backing, part,
                                                     job.vocal_gain, job.backing_gain))
                if rc == 0 and (not part.exists() or not part.stat().st_size):
                    raise RuntimeError("ffmpeg remix produced no output")
                if not _stage_ok(job, rc, "ffmpeg remix"):
                    return

            if job.preview:
                # Audition result → the preview cache (count-pruned, regenerable).
                out = preview_path(cfg, job.h)
                vault_fs.mkdir(cfg.preview_dir)
                vault_fs.from_scratch(part, out)   # voiceswap_preview/ is a CACHE, but it is
                _prune_previews(cfg.preview_dir)   # user audio: encrypted in place (design 7.7)
                job.status = "done"
                job.stage = ""
                emit(job, {"type": "job_done", "preview": True, "h": job.h,
                           "duration_s": ffprobe_duration(out)})
                return

            ref = find_ref_by_hash(cfg.library_dir, job.h) or \
                result_stem(job.song_name, job.voice, job.h)
            mp3, side = result_paths(cfg.library_dir, ref)
            vault_fs.mkdir(cfg.library_dir)
            # Atomic into the library — the mp3 must never appear half-written.
            #
            # move_into_place, not os.replace: BOTH of these cross OUT of the job's workdir
            # and into the library, and os.replace cannot cross a filesystem (EXDEV). The
            # workdir and the library live on one mount today and 5.0 §8.2 deliberately puts
            # the scratch on its own boot-ephemeral volume — at which point these two lines
            # become a hard errno-18 at the LAST step of a ten-minute job, with the GPU
            # already spent and the workdir's `finally` about to delete the result.
            # from_scratch, not move_into_place: BOTH of these cross out of the scratch and
            # into the LIBRARY, which is in the vault. It still handles the EXDEV the comment
            # above is about — that is its plain arm — but the destination is encrypted now.
            vault_fs.from_scratch(part, mp3)
            # The dry vocal moves in beside it instead of dying with the workdir (§5). For
            # speech it is the lossless master of the very same audio the mp3 holds — a
            # "give me the WAV" download, which for a spoken clip is worth keeping.
            vault_fs.from_scratch(swapped, vocal_path(cfg.library_dir, ref))

            # The MP3 is in the vault now, so ffprobe cannot open it — and `part` (the same
            # bytes, in the scratch) has just been consumed. Probe the swapped vocal we still
            # hold? No: the remix is what the user gets. Decrypt it back for the one probe.
            with vault_fs.child_input(mp3, work) as plain_mp3:
                duration = ffprobe_duration(plain_mp3)
            # song_h / stems_ref group the library's SONG Stems view: one instrumental, several
            # swapped vocals. Speech is a separate category (the Songs|Speech filter, §4) and
            # has no backing to group by, so it records neither — even when clean-up did put its
            # isolated vocal in the stems store (that is a cache, not this swap's identity).
            set_dir = (stems.find_dir(cfg, job.stems_ref)
                       if job.stems_ref and not is_speech else None)
            write_sidecar(side, {
                "song": job.song_name, "song_ref": job.source_ref,
                "song_h": stems.read_meta(set_dir).get("song_h") if set_dir else None,
                "stems_ref": "" if is_speech else job.stems_ref,
                "voice": job.voice, "pitch": job.pitch, "index_rate": job.index_rate,
                "rms_mix_rate": job.rms_mix_rate,
                "vocal_gain": job.vocal_gain, "backing_gain": job.backing_gain,
                "device": job.device, "f0_method": F0_METHOD,
                # kind badges the row (song|speech, §4); cleanup is part of the speech identity.
                "kind": src.kind, "cleanup": cleanup,
                "duration_s": duration,
            })
            job.result_ref = ref
            job.status = "done"
            job.stage = ""
            emit(job, {"type": "job_done", "ref": ref, "duration_s": duration})
        finally:
            # The decrypted voice model, its index and the stems die here — success, failure or
            # cancel. Plaintext must not outlive the stage that needed it (5.0 §8.3).
            stack.close()
            SWAP_LOCK.release()
    except VaultAuthError as exc:                              # BOUNDARY 2 of 5 — BY NAME
        vault_store.fail_job_on_vault_auth(job, exc, emit)
    except Exception as exc:                                   # noqa: BLE001
        job.status = "failed"
        # The child's output goes to the BROWSER (job.error / the SSE error event) but is
        # kept out of str(exc), so the logger.exception below writes only the safe summary.
        detail = getattr(exc, "detail", "")
        job.error = f"{exc}: {detail}" if detail else str(exc)
        logger.exception(f"voiceswap job {job.id} failed")
        emit(job, {"type": "error", "message": job.error})
    finally:
        job.stage = "" if job.status == "done" else job.stage
        # The workdir is scratch — the STEMS are not in it any more, they're in the
        # store, which is the whole point of M4.
        shutil.rmtree(work, ignore_errors=True)


def _stage_ok(job: SwapJob, rc: int, what: str) -> bool:
    """Common stage epilogue: False ends the job as canceled; a nonzero exit
    raises (→ failed) with the child's last output line as context."""
    if rc == -1 or job.cancel.is_set():
        job.status = "canceled"
        emit(job, {"type": "log", "line": "Canceled — nothing was saved to the library."})
        emit(job, {"type": "canceled"})
        return False
    if rc != 0:
        # job.last_line is the CHILD's output (Demucs/ffmpeg/RVC) and carries full
        # filesystem paths — i.e. song titles and voice names. The USER must still see it
        # (it's the whole diagnosis, and the browser is an authenticated channel showing
        # them their own data), but it must NOT ride the exception's str() into loguru,
        # which is what logger.exception below would write to logs/vocalis.log.
        # So: safe summary in the message, child output in `.detail`.
        raise StageFailed(f"{what} failed (exit {rc})", detail=job.last_line)
    return True
