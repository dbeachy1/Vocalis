"""Prepare uploaded voice clips for training with optional trim and denoise passes. Trimming detects clean speech and stitches retained spans; denoising runs DeepFilterNet as a CPU child process. Either pass may run alone or in sequence, and results are new clips that never overwrite the source. Use opaque hash-derived scratch names and keep vault decryption and encryption in this caller."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from loguru import logger

# Reuse voiceswap's process-group kill, ROCm-noise filter and ffprobe wrapper rather than grow
# a second set — the same choice enhance.py made. (We do NOT need _card_env: cleanup is CPU.)
from engine_process import NOISE_MARKERS, SETUP_HINT, ffprobe_duration, kill_tree as _kill_tree, venv_python

# The denoise cost is MEASURED on the box that does it, never hardcoded — its own rate store,
# a sibling of enhance_rate.py (design §5).
import cleanup_rate
import vault_fs

# eta text is one behavior across the app: reuse enhance's rather than re-decide what
# "no estimate yet" sounds like.
from enhance import eta_str, eta_note, NO_ESTIMATE  # noqa: F401  (re-exported for the server)

# The trim DSP is pure and lives with the child scripts; run its functions in-process.
_CLEANUP_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts" / "cleanup"
if str(_CLEANUP_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_CLEANUP_SCRIPTS))


# Version the Trim scorer algorithm and stitched-clip output identity. Bumping this value regenerates cached clips; raw score cache entries remain keyed to the child script mtime.
TRIM_SCORER_VERSION = 1

# Drop a region when its aggregate music/SFX score exceeds this threshold, even if the noise floor looks clean. The slider is inert when the Trim scorer is unavailable; missing scores are treated as 0.0.
DEFAULT_MUSIC_VETO = 0.35

# The default noise-excess limit is measured in dB. A loose threshold retains clean speech while the music/SFX veto handles music; lower it to remove noisier speech or raise it toward 30 dB to keep all VAD speech.
DEFAULT_MAX_EXCESS_DB = 24.0


# ── the single default Clean up preset (§3.1) ────────────────────────────────
#
# Denoise at full strength (the ear-test winner, §2.2), no trim. This is what "one cleaned clip
# per source" means: the default is the always-applicable pass that leaves length untouched and
# just cleans. Trim is the opt-in (a single stitched clip of the clean speech, §2.1/§4), which is a
# NON-default cleaning and therefore a named variant.
DEFAULT_PRESET = {
    "trim": {"enabled": False, "max_excess_db": DEFAULT_MAX_EXCESS_DB, "music_veto": DEFAULT_MUSIC_VETO},
    "denoise": {"enabled": True, "wet": 1.0, "atten": 0.0},
}

# Analysis decodes at this rate for responsiveness: the noise-floor-excess scorer reads a 20 ms
# frame's ENERGY, which a moderate downsample does not move, so a live timeline is a few seconds
# instead of a gigabyte of 48 kHz audio. The saved cut re-decodes at the SOURCE rate to keep the
# kept audio full quality — verdicts differ only at the borderline, which the human review (§2.1)
# is there to catch.
ANALYSIS_DECODE_HZ = 16000

# These environments are image-owned in the Docker package; setup and development
# overrides use the explicit VOCALIS_DFN_VENV and VOCALIS_TRIM_VENV settings.
DEFAULT_DFN_VENV = Path("/opt/vocalis/venvs/dfn")
DEFAULT_DFN_MODEL_ROOT = Path("/models/vocalis/cleanup/dfn3")
DFN_CONFIG = "config.ini"
DFN_CHECKPOINT = Path("checkpoints/model_120.ckpt.best")
DEFAULT_TRIM_VENV = Path("/opt/vocalis/venvs/trim")
DEFAULT_TRIM_MODEL_ROOT = Path("/models/vocalis/trim")
TRIM_PANNS_CHECKPOINT = "Cnn14_mAP=0.431.pth"


@dataclass
class CleanupConfig:
    denoise_python: Path        # the ISOLATED DeepFilterNet venv (~/dfn-venv), never Vocalis's
    denoise_script: Path        # scripts/cleanup/denoise_dfn.py
    trim_script: Path           # scripts/cleanup/trim_audio.py (run in-process)
    scratch: Path               # where plaintext may briefly exist (5.0 §8.3)
    denoise_model_root: Path = DEFAULT_DFN_MODEL_ROOT
    # The optional Trim scorer uses Silero VAD and a PANNs tagger in its own environment. Without it, Trim falls back to the in-process SNR-only path. Defaults preserve existing CleanupConfig construction.
    trim_scorer_python: Path = None   # ~/trim-venv/bin/python (torch)
    trim_scorer_script: Path = None   # scripts/cleanup/trim_scores.py (path in, scores JSON out)
    trim_model_root: Path = DEFAULT_TRIM_MODEL_ROOT

    @property
    def trim_scorer_checkpoint(self) -> Path:
        return Path(self.trim_model_root) / TRIM_PANNS_CHECKPOINT

    @property
    def trim_scorer_labels(self) -> Path:
        return Path(self.trim_model_root) / "class_labels_indices.csv"

    @property
    def denoise_available(self) -> bool:
        """Whether the isolated child, script, and selected local DFN3 files are ready."""
        if not self.denoise_python.is_file() or not self.denoise_script.is_file():
            return False
        for relative in (Path(DFN_CONFIG), DFN_CHECKPOINT):
            path = Path(self.denoise_model_root) / relative
            try:
                with path.open("rb"):
                    pass
            except OSError:
                return False
        return True

    @property
    def denoise_unavailable_reason(self) -> str:
        """Why `denoise_available` is False, in words a user can act on; "" when it is True.

        One authority for every route that refuses a denoise. The environment and script are part
        of the image, so their absence is a broken image. The DeepFilterNet3 weights are downloaded
        by setup (Doug, October 9, 2026), so missing weights
        mean setup has not finished, and running it again is the remedy. Until October 9, 2026 this
        still said the weights were held for their licence, which was no longer true. The earlier
        messages told users to run scripts/cleanup/setup*.sh, which the Docker edition does not have."""
        if self.denoise_available:
            return ""
        if not self.denoise_python.is_file() or not self.denoise_script.is_file():
            return "The DeepFilterNet3 cleanup environment is missing from this image."
        return "DeepFilterNet3 cleanup needs its model, which is not installed." + SETUP_HINT

    @property
    def trim_available(self) -> bool:
        """Trim runs in-process on the server's own venv (numpy + soundfile + ffmpeg), so the
        script file being present is the whole check."""
        return self.trim_script.is_file()

    @property
    def trim_scorer_available(self) -> bool:
        return self.trim_scorer_unavailable_reason is None

    @property
    def trim_scorer_unavailable_reason(self) -> str | None:
        if not self.trim_scorer_python or not Path(self.trim_scorer_python).is_file():
            return "Trim scorer environment is unavailable."
        if not self.trim_scorer_script or not Path(self.trim_scorer_script).is_file():
            return "Trim scorer script is missing."
        if not self.trim_scorer_checkpoint.is_file():
            return f"Trim scorer model is missing: {self.trim_scorer_checkpoint}"
        try:
            with self.trim_scorer_checkpoint.open("rb"):
                pass
        except OSError as exc:
            return f"Trim scorer model is unreadable: {self.trim_scorer_checkpoint} ({exc})"
        if not self.trim_scorer_labels.is_file():
            return f"Trim scorer AudioSet labels are missing: {self.trim_scorer_labels}"
        try:
            with self.trim_scorer_labels.open("rb"):
                pass
        except OSError as exc:
            return f"Trim scorer AudioSet labels are unreadable: {self.trim_scorer_labels} ({exc})"
        return None

    @property
    def available(self) -> bool:
        return self.denoise_available or self.trim_available


def resolve_config(app_settings: dict, base_dir: Path = None) -> CleanupConfig:
    """env var → app_settings.yaml `cleanup:` → default. The same precedence as
    enhance.resolve_config / voiceswap.resolve_config — one rule to remember."""
    s = (app_settings or {}).get("cleanup") or {}
    root = Path(base_dir) if base_dir else Path(__file__).resolve().parent.parent

    def pick(env: str, key: str, default):
        return Path(os.environ.get(env) or s.get(key) or default)

    return CleanupConfig(
        # venv_python: a Windows venv has no bin/ at all (Scripts/python.exe instead) — see
        # voiceswap.venv_python for why this used to resolve a path that never existed there.
        denoise_python=venv_python(pick("VOCALIS_DFN_VENV", "denoise_venv", DEFAULT_DFN_VENV)),
        denoise_script=root / "scripts" / "cleanup" / "denoise_dfn.py",
        denoise_model_root=pick("VOCALIS_DFN_MODEL_ROOT", "denoise_model_root",
                                DEFAULT_DFN_MODEL_ROOT),
        trim_script=root / "scripts" / "cleanup" / "trim_audio.py",
        trim_scorer_python=venv_python(pick("VOCALIS_TRIM_VENV", "trim_venv", DEFAULT_TRIM_VENV)),
        trim_scorer_script=root / "scripts" / "cleanup" / "trim_scores.py",
        trim_model_root=pick("VOCALIS_TRIM_MODEL_ROOT", "trim_model_root", DEFAULT_TRIM_MODEL_ROOT),
        # Use the shared scratch-root configuration for cleanup work. A separate setting could send decrypted training audio to ordinary storage while startup cleanup watches another directory.
        scratch=_scratch_root_for(app_settings),
    )


def _scratch_root_for(app_settings: dict) -> Path:
    import scratch
    return scratch.scratch_root(app_settings)


# ── passes: validate, hash, name ─────────────────────────────────────────────

def normalize_passes(passes: dict) -> dict:
    """Coerce a request's passes into the canonical, clamped shape used for BOTH hashing and
    execution — so the identity of a cleaning and the cleaning itself can never disagree.

    A wet mix outside [0, 1] is a typo; a negative atten cap is a typo; a non-number is a probe.
    None of them deserves a 500 mid-run, so each clamps to a sane value rather than raising.
    """
    p = passes or {}
    t = p.get("trim") or {}
    d = p.get("denoise") or {}

    def _f(v, default):
        try:
            return float(v)
        except (TypeError, ValueError):
            return float(default)

    return {
        "trim": {
            "enabled": bool(t.get("enabled")),
            "max_excess_db": round(_f(t.get("max_excess_db"),
                                      DEFAULT_PRESET["trim"]["max_excess_db"]), 2),
            # The music/SFX veto is a probability clamped to [0, 1]; invalid values fall back instead of failing the request.
            "music_veto": round(min(1.0, max(0.0, _f(t.get("music_veto"),
                                    DEFAULT_PRESET["trim"]["music_veto"]))), 3),
        },
        "denoise": {
            "enabled": bool(d.get("enabled")),
            "wet": round(min(1.0, max(0.0, _f(d.get("wet"),
                                             DEFAULT_PRESET["denoise"]["wet"]))), 3),
            "atten": round(max(0.0, _f(d.get("atten"),
                                       DEFAULT_PRESET["denoise"]["atten"])), 2),
        },
    }


def is_default_preset(passes: dict) -> bool:
    """True when the (normalized) passes are exactly the default Clean up preset — which decides
    whether the output gets a plain `<stem>.cleaned.wav` name (one per source) or a tagged
    variant name (§3.1)."""
    return normalize_passes(passes) == normalize_passes(DEFAULT_PRESET)


def _passes_key(passes: dict) -> str:
    """A stable, canonical string of the EFFECTIVE settings — a disabled pass contributes
    nothing, so 'denoise@1.0 with trim off' and 'denoise@1.0' hash alike."""
    p = normalize_passes(passes)
    eff = {}
    if p["trim"]["enabled"]:
        # Include both thresholds and the scorer version in the trim identity so changed settings create a distinct variant and new scorer behavior invalidates stale results.
        eff["trim"] = {"excess": p["trim"]["max_excess_db"], "veto": p["trim"]["music_veto"],
                       "v": TRIM_SCORER_VERSION}
    if p["denoise"]["enabled"]:
        eff["denoise"] = {"wet": p["denoise"]["wet"], "atten": p["denoise"]["atten"]}
    return json.dumps(eff, sort_keys=True)


def settings_tag(passes: dict) -> str:
    """A short filename discriminator from the SETTINGS only (not the source) — so re-cleaning a
    re-saved source with the same knobs overwrites the same variant, and two sources with the
    same knobs never collide (their stems already differ)."""
    return hashlib.sha256(_passes_key(passes).encode("utf-8")).hexdigest()[:6]


def cleanup_hash(src, passes: dict) -> str:
    """The full deterministic identity of a cleaning: the SOURCE (path + size + mtime) and the
    effective settings. Recorded on the output's sidecar so 're-open Clean up on an unchanged
    clip with the same knobs' can be answered 'already done' — the enhance.cache_path discipline
    (§5)."""
    from tts_utils import source_stat
    p = Path(src)
    # 🔴 M10 §4.2 C4 — source_stat, and the `except OSError: ident = str(p)` it replaces was a
    # BUG, not a safety net. `src` is `voice_training/<name>`, a routed tree: encrypted, a bare
    # p.stat() raises every time and the fallback drops BOTH size and mtime from the identity.
    # The identity then says nothing but the path — so a clip you RE-RECORDED at the same name
    # hashes identically to the old one and Clean up answers "already done", serving the
    # cleaning of audio you replaced. That is the `stems_id` `or ""` collision M2.5 fixed.
    #
    # A source we cannot stat has NO identity, so it gets none: the caller must not record an
    # "already cleaned" claim it cannot stand behind. An identity is not a question you may
    # answer with a shrug.
    st = source_stat(p)
    if st is None:
        return None
    key = f"{p.resolve()}|{st[0]}|{int(st[1])}|{_passes_key(passes)}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def output_stem(base_stem: str, passes: dict, take_idx: int = None) -> str:
    """The deterministic stem for a cleaned output clip.

    `<stem>.cleaned` for the default preset; `<stem>.cleaned.<tag>` for a variant; `.takeNN`
    appended when trim yields more than one take. `base_stem` is run through safe_name so no odd
    character from the source name reaches a new file.
    """
    from book_to_audio import safe_name
    stem = f"{safe_name(base_stem)}.cleaned"
    if not is_default_preset(passes):
        stem += f".{settings_tag(passes)}"
    if take_idx is not None:
        stem += f".take{take_idx:02d}"
    return stem


def scratch_path(cfg: CleanupConfig, src, tag: str = "", suffix: str = ".wav") -> Path:
    """An OPAQUE scratch path for `src`. NEVER derived from the source's name — matches
    enhance.scratch_path / vault.decrypt_to_scratch (sha256(...)[:16] + suffix)."""
    key = f"{src}|{tag}".encode("utf-8")
    return Path(cfg.scratch) / (hashlib.sha256(key).hexdigest()[:16] + suffix)


# The optional VAD and music/SFX scorer improves speech boundaries and identifies regions the energy gate cannot classify. Cache its per-window results so analysis can reuse them; without the optional environment, Trim falls back to SNR-only behavior.

def scores_cache_path(cfg: CleanupConfig, src) -> Path:
    """Where a source's cached VAD+tagger scores live, or **None when the source has no readable
    identity** and must therefore not be cached at all.

    Keyed on the source identity (path + size + mtime) AND the child-script mtime, so touching
    the file or editing the scorer invalidates it — but NOT on TRIM_SCORER_VERSION (that governs
    the downstream combine/output, which does not change the raw scores). Under cache_root() —
    documented regenerable, safe to wipe, and routed as of M10 R1: these scores say where in the
    user's own recording someone is SPEAKING and how confidently, second by second, which is
    transcript-shaped description of a private clip. "Regenerable" was never the same claim as
    "not content" (design §7.7.1)."""
    from tts_utils import cache_root, source_stat
    p = Path(src)
    # 🔴 M10 §4.2 C5 — source_stat is THE identity seam, and the `except OSError: ident = str(p)`
    # that used to sit here was a bug, not a safety net. `src` is a store path: encrypted, a bare
    # p.stat() raised, the fallback fabricated an identity with NO size and NO mtime, and every
    # version of that file then shared one cache key — the exact shape of the `stems_id` `or ""`
    # collision M2.5 fixed. It would have served one clip's scores for a different clip.
    #
    # None, not a fabricated key: an identity is not a question you may answer with a shrug, and
    # the honest answer for a source we cannot identify is to NOT CACHE rather than to invent a
    # name for it. Both callers read None as "no cache" and simply re-score, which is the same
    # cost the old fallback was pretending to avoid.
    st = source_stat(p)
    if st is None:
        return None
    ident = f"{p.resolve()}|{st[0]}|{int(st[1])}"
    try:
        scr_mtime = int(Path(cfg.trim_scorer_script).stat().st_mtime)
    except (OSError, TypeError):
        scr_mtime = 0
    key = f"{ident}|{scr_mtime}"
    return cache_root() / "trim_scores" / (hashlib.sha256(key.encode("utf-8")).hexdigest()[:24] + ".json")


def has_scores(cfg: CleanupConfig, src) -> bool:
    """True when this source already has cached scores — lets analyze() upgrade the timeline
    instantly and tells the client whether the (slow) /cleanup/score pass is still needed."""
    if not cfg.trim_scorer_available:
        return False
    cache = scores_cache_path(cfg, src)      # None ⇒ no identity ⇒ nothing could have been cached
    # vault_fs.exists: trim_scores/ is routed as of R1, so a bare is_file() answers False for
    # every cached score and the (slow) scorer pass would be declared "still needed" forever.
    return bool(cache is not None and vault_fs.exists(cache))


def build_trim_scorer_cmd(cfg: CleanupConfig, wav, out_json) -> list:
    return [str(cfg.trim_scorer_python), str(cfg.trim_scorer_script),
            "-i", str(wav), "-o", str(out_json), "--checkpoint",
            str(cfg.trim_scorer_checkpoint), "--labels", str(cfg.trim_scorer_labels),
            "--device", "cpu"]


def _run_scorer_child(cfg: CleanupConfig, wav, out_json, cancel: threading.Event = None,
                      on_line=None) -> int:
    """Run the one-shot Trim scorer child. Same Popen/pump/kill discipline as run_denoise: a pump
    thread drains stdout, the machine-readable VOCALIS_TIMING line is swallowed, ROCm/MIOpen noise
    is filtered. Returns the exit code, or -1 if canceled."""
    cmd = build_trim_scorer_cmd(cfg, wav, out_json)
    kw = {}
    if os.name != "nt":
        kw["start_new_session"] = True
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", **kw)

    def _pump():
        for raw in iter(proc.stdout.readline, ""):
            line = raw.strip()
            if line.startswith("VOCALIS_TIMING "):
                continue
            if line and not any(n in line for n in NOISE_MARKERS) and on_line:
                on_line(line)
        proc.stdout.close()

    th = threading.Thread(target=_pump, daemon=True)
    th.start()
    while proc.poll() is None:
        if cancel is not None and cancel.is_set():
            _kill_tree(proc)
            proc.wait()
            th.join(timeout=5)
            return -1
        time.sleep(0.2)
    th.join(timeout=5)
    return proc.returncode


def compute_scores(cfg: CleanupConfig, src, cancel: threading.Event = None,
                   on_line=None) -> dict:
    """The scorer child's VAD+tagger scores for `src`, cached per source identity. Returns the
    parsed JSON, or None when the scorer venv is absent (Trim degrades to the SNR MVP) or the child
    fails / is canceled. NEVER raises — a scorer failure must degrade, not break Clean up."""
    if not cfg.trim_scorer_available:
        return None
    cache = scores_cache_path(cfg, src)          # None ⇒ unidentifiable source ⇒ do not cache
    try:
        if cache is not None and vault_fs.exists(cache):
            return json.loads(vault_fs.read_text(cache))
    except (OSError, ValueError):
        pass                                    # a corrupt cache just re-scores
                                                # (a VaultAuthError is neither, and passes)
    scratch_made = []
    # A per-call part in every tag (October 9, 2026): two jobs scoring the same clip at once used to
    # share these files, so one deleted or overwrote the other's. See vault.decrypt_to_scratch.
    run = uuid.uuid4().hex
    out = scratch_path(cfg, src, tag=f"trimscore-out|{run}", suffix=".json")
    scratch_made.append(out)
    try:
        # Never pass a vault path directly to the scorer subprocess: it has no DEK and would read ciphertext. Decode to job-owned scratch first so failures remain visible instead of silently degrading Trim.
        srcp = Path(src)
        with vault_fs.child_input(src, cfg.scratch) as plain:
            if Path(plain).suffix.lower() in (".wav", ".flac"):
                wav = plain
            else:
                wav = scratch_path(cfg, src, tag=f"trimscore-src|{run}")
                _decode_wav(plain, wav)
                scratch_made.append(wav)
            rc = _run_scorer_child(cfg, wav, out, cancel, on_line)
        if rc != 0 or not Path(out).is_file():
            if rc not in (0, -1):
                logger.warning(f"trim scorer exited {rc} on {srcp.name} — SNR-only fallback")
            return None
        payload = json.loads(Path(out).read_text(encoding="utf-8"))   # scratch: a plain read
        if cache is not None:
            try:
                # vault_fs.write_text — trim_scores/ is routed (R1), and its vault arm is
                # atomic via vault.open_write()'s own .part + atomic_replace, which is the job
                # _atomic_write_text was doing. NOT write_yaml_atomic: this is JSON, and the
                # reader above is json.loads.
                vault_fs.write_text(cache, json.dumps(payload))
            except OSError:
                logger.warning("could not cache trim scores (continuing)")
        return payload
    except Exception:                           # noqa: BLE001 — a scorer failure must degrade
        logger.exception("trim scorer failed — falling back to the SNR-only MVP")
        return None
    finally:
        for p in scratch_made:
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass


def run_scorer(cfg: CleanupConfig, src, cancel: threading.Event = None, on_line=None) -> bool:
    """Compute + cache the VAD+tagger scores (the slow once-per-file child). True on success. The
    async /cleanup/score job calls this so analyze() can stay instant."""
    return compute_scores(cfg, src, cancel=cancel, on_line=on_line) is not None


# ── analysis (the live trim timeline) ────────────────────────────────────────

def _build_scored(rms_db, floor, scores, max_excess_db, music_veto):
    """The shared reduction both analyze() and the trim pass use: the SNR envelope (+ floor) and the
    optional child `scores` → (scored Regions, scorer tag). WITH scores the regions come from VAD
    and each carries a music/SFX aggregate; WITHOUT (no venv / it failed) the energy-gate SNR MVP.
    Kept identical between preview and cut so the timeline and the saved clip can never disagree."""
    import trim_audio as tr
    if scores and (scores.get("vad") or {}).get("segments") is not None:
        mask = tr.vad_segments_to_mask(scores["vad"]["segments"], len(rms_db))
        regions = tr.mask_to_regions(mask)
        music = tr.region_music_scores(regions, (scores.get("tagger") or {}).get("windows") or [])
        scorer = "vad+tagger"
    else:
        regions = tr.mask_to_regions(tr.speech_mask(rms_db, floor))
        music = None
        scorer = "snr"
    scored = tr.score_regions(rms_db, regions, floor, max_excess_db,
                              music_scores=music, music_veto=music_veto)
    return scored, scorer


def analyze(cfg: CleanupConfig, src) -> dict:
    """Score the source's speech regions for the Trim workspace, WITHOUT writing anything.

    Returns every region with its noise-excess in dB AND its music/SFX probability; the client
    applies BOTH thresholds live (kept iff excess ≤ noise AND music_sfx ≤ veto), so moving either
    slider needs no round-trip. Decoded at ANALYSIS_DECODE_HZ for responsiveness. This call is
    INSTANT: it uses cached VAD+tagger scores when present, but never runs the slow child itself —
    the async /cleanup/score job does that. `scorer` is "vad+tagger" once scored, else "snr";
    `scored` says whether the music/SFX pass has run; `scorer_available` whether it CAN.
    """
    import trim_audio as tr
    src = Path(src)
    avail = cfg.trim_scorer_available
    # 🔴 M10 §4.2 C2 — ONE child_input at the TOP of the entry point, not one per ffmpeg call.
    # `src` is `voice_training/<name>`, a routed tree, and `_probe_sample_rate` / `decode_mono`
    # both shell out to ffmpeg, which has no DEK. Unrouted this does not raise: ffmpeg fails,
    # decode_mono returns an empty array, and analyze reports a 0-second clip with no regions —
    # a clip that looks silent rather than a call that looks broken (§3.1).
    #
    # 🔴 IDENTITY STAYS ON `src`, BYTES COME FROM `plain`. has_scores/compute_scores key the
    # score cache on the SOURCE identity; handing them the decrypted scratch copy would key it
    # on a file whose mtime is "just now", so every call would miss and re-run the slow child
    # forever. The two arguments are not interchangeable and that is the whole subtlety here.
    with vault_fs.child_input(src, cfg.scratch) as plain:
        sr = tr._probe_sample_rate(plain)
        dsr = min(sr, ANALYSIS_DECODE_HZ) if sr > 0 else ANALYSIS_DECODE_HZ
        x = tr.decode_mono(plain, dsr)
    if x.size == 0:
        return {"total_s": 0.0, "sr": sr, "floor_db": None, "regions": [],
                "scorer": "snr", "scorer_available": avail, "scored": False}
    rms_db = tr.frame_rms_db(x, dsr)
    floor = tr.global_floor_db(rms_db)
    scores = compute_scores(cfg, src) if has_scores(cfg, src) else None   # cache read only — no child
    # A permissive threshold keeps every region so each carries its measured excess AND music
    # score; the verdict is the client's to make with its two sliders.
    scored, scorer = _build_scored(rms_db, floor, scores, float("inf"), float("inf"))
    return {
        "total_s": round(len(x) / float(dsr), 3),
        "sr": sr,
        "floor_db": round(float(floor), 2),
        "scorer": scorer,
        "scorer_available": avail,
        "scored": scorer == "vad+tagger",
        "regions": [{"start_s": round(r.start_s, 3), "end_s": round(r.end_s, 3),
                     "excess_db": r.excess_db, "music_sfx": r.music_sfx} for r in scored],
    }


# ── the denoise child (path in, path out) ────────────────────────────────────

def build_denoise_cmd(cfg: CleanupConfig, src, dst, wet: float = 1.0,
                      atten: float = 0.0, device: str = "cpu") -> list:
    """The DeepFilterNet child. Path in, path out — it knows nothing about the vault, exactly
    like scripts/enhance/enhance_audio.py. The CALLER owns decrypt/encrypt."""
    cmd = [str(cfg.denoise_python), str(cfg.denoise_script),
           "-i", str(src), "-o", str(dst),
           "--wet", str(float(wet)), "--device", device,
           "--model-dir", str(cfg.denoise_model_root)]
    if atten and float(atten) > 0:
        cmd += ["--atten", str(float(atten))]
    return cmd


def run_denoise(cfg: CleanupConfig, src, dst, wet: float = 1.0, atten: float = 0.0,
                device: str = "cpu", cancel: threading.Event = None, on_line=None) -> int:
    """Run the denoiser as a child process. Exit code, or -1 for 'killed by cancel'.

    THE ONLY PLACE THE DENOISER IS RUN. Same discipline as enhance.run_enhance: a pump thread
    reads the child's output a line at a time, the machine-readable timing line is consumed (not
    shown) to teach this box its own speed (cleanup_rate), ROCm/MIOpen noise is filtered, and a
    clean run records its own timing. The child writes ATOMICALLY (.part → replace), so a kill
    can never leave a half-written WAV where `dst` is.
    """
    cmd = build_denoise_cmd(cfg, src, dst, wet, atten, device)
    kw = {}
    if os.name != "nt":
        kw["start_new_session"] = True          # own pgid — _kill_tree needs it
    started = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", **kw)
    timing = {}

    def _pump():
        for raw in iter(proc.stdout.readline, ""):
            line = raw.strip()
            t = cleanup_rate.parse_timing(line)
            if t is not None:
                timing.update(t)
                continue
            if line.startswith("VOCALIS_TIMING "):
                continue                        # unusable measurement — still not log output
            if line and not any(n in line for n in NOISE_MARKERS) and on_line:
                on_line(line)
        proc.stdout.close()

    th = threading.Thread(target=_pump, daemon=True)
    th.start()
    while proc.poll() is None:
        if cancel is not None and cancel.is_set():
            _kill_tree(proc)
            proc.wait()
            th.join(timeout=5)
            return -1
        time.sleep(0.2)
    th.join(timeout=5)
    rc = proc.returncode
    # The run measures itself — only a clean one. `startup` is everything that did not scale with
    # the audio (spawn, imports, the model load, the WAV write) = wall - compute.
    if rc == 0 and timing:
        wall = time.monotonic() - started
        startup = wall - timing["compute_s"]
        if startup >= 0:
            key_dev = "cpu" if str(device).startswith("cpu") else "cuda"
            try:
                cleanup_rate.record(cleanup_rate.key_for(device=key_dev),
                                    timing["audio_s"], timing["compute_s"], startup)
            except Exception:                   # noqa: BLE001 — a rate cache is not the job
                logger.exception("could not record the cleanup rate")
    return rc


# ── the trim pass (in-process) ───────────────────────────────────────────────

def _write_wav(dst: Path, audio: np.ndarray, sr: int) -> None:
    """Atomically write a mono PCM_16 WAV — never leave a half-written file behind."""
    import soundfile as sf
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    try:
        sf.write(str(tmp), audio, sr, format="WAV", subtype="PCM_16")
        os.replace(tmp, dst)
    finally:
        tmp.unlink(missing_ok=True)


def _decode_wav(src, dst) -> None:
    """Decode any source to a mono WAV via ffmpeg, atomically.

    The denoise child reads with soundfile, which CANNOT read MP3 — and imported training clips
    are MP3 (voicetrain.import_clip encodes to it). So a denoise-only pass decodes the source to
    a scratch WAV first, exactly as enhance decodes MP3→WAV before its child. (The trim path
    already decodes via ffmpeg, so its take WAVs are fine.)"""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    # The temp keeps a real .wav extension and -f wav is explicit: ffmpeg infers the OUTPUT format
    # from the name, and a bare `.part` suffix (the atomic-write idiom used elsewhere here) makes it
    # refuse to muxer-init at all. Belt and braces — either alone would do.
    tmp = dst.with_name(dst.stem + ".part.wav")
    r = subprocess.run(["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-f", "wav", str(tmp),
                        "-loglevel", "error"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not tmp.is_file():
        Path(tmp).unlink(missing_ok=True)
        raise RuntimeError(f"could not decode {Path(src).name}: {(r.stderr or '').strip()[:200]}")
    os.replace(tmp, dst)


def _trim_to_scratch(cfg: CleanupConfig, src, max_excess_db: float, music_veto: float,
                     cancel: threading.Event = None, on_line=None) -> list:
    """Trim `src` and write the survivors as ONE stitched clip to an opaque scratch WAV (§4).

    Returns [(1, scratch_path)] at the SOURCE sample rate — the full-quality cut, unlike analyze()'s
    downsampled preview — or [] when trim dropped everything. The clean regions (VAD when the scorer
    is available, else the energy gate) are joined into a SINGLE clip separated by short silences, so
    RVC re-slices at the pauses instead of getting one Frankenstein WAV or 900 take files. Uses the
    scores cached by analyze()/score when present; otherwise pays for the child here (this runs in a
    background job with its own progress + cancel).
    """
    import trim_audio as tr
    src = Path(src)
    # C2, same seam and same split as analyze(): ffmpeg reads `plain`, the score cache keys on
    # `src`. At the SOURCE sample rate here — this is the full-quality cut, not a preview.
    with vault_fs.child_input(src, cfg.scratch) as plain:
        sr = tr._probe_sample_rate(plain)
        x = tr.decode_mono(plain, sr)
    # October 9, 2026: an empty decode used to return [] here, which the job reported as "trim
    # dropped everything at this threshold — loosen it", sending the user after a slider that could
    # never help. A file that does not decode is an error with its own message.
    if x.size == 0:
        raise RuntimeError(f"could not decode {src.name} for trimming (sample rate {sr} Hz, no audio "
                           "came back from ffmpeg)")
    rms_db = tr.frame_rms_db(x, sr)
    floor = tr.global_floor_db(rms_db)
    scores = compute_scores(cfg, src, cancel=cancel, on_line=on_line)
    if cancel is not None and cancel.is_set():
        return []
    scored, scorer = _build_scored(rms_db, floor, scores, max_excess_db, music_veto)
    kept = [r for r in scored if r.keep]
    if not kept:
        # Say what was found and why each region went, so "loosen the threshold" is advice the user
        # can check against the numbers rather than a guess.
        if on_line:
            found = "; ".join(f"{r.start_s:.1f}-{r.end_s:.1f}s noise +{r.excess_db:.1f} dB"
                              + (f" music/SFX {r.music_sfx:.2f}" if r.music_sfx is not None else "")
                              for r in scored[:8]) or "no speech regions"
            on_line(f"trim: {len(x) / float(sr):.1f}s decoded at {sr} Hz, scorer {scorer}; nothing within "
                    f"noise {max_excess_db:g} dB and music/SFX {music_veto:g}: {found}")
        return []
    chunks = [x[int(r.start_s * sr):int(r.end_s * sr)] for r in kept]
    audio = tr.stitch_clip(chunks, sr)
    # Per-call, not per-settings: two trims of one clip at the same threshold would share it.
    dst = scratch_path(cfg, src, tag=f"trim|{max_excess_db}|{music_veto}|{TRIM_SCORER_VERSION}|{uuid.uuid4().hex}")
    _write_wav(dst, audio, sr)
    if on_line:
        kept_s = sum(r.dur_s for r in kept)
        on_line(f"trim: kept {kept_s:.0f}s across {len(kept)} segment(s) → one clip")
    return [(1, dst)]


# ── the whole Clean up run ───────────────────────────────────────────────────

def _land(src_path: Path, dst: Path) -> None:
    """Move a completed scratch WAV into the routed store, encrypting it on write. `from_scratch` consumes the source, so callers must pass only job-owned scratch files and track them for cleanup."""
    import vault_fs
    dst = Path(dst)
    vault_fs.mkdir(dst.parent)
    vault_fs.from_scratch(src_path, dst)


def run_cleanup(cfg: CleanupConfig, src, passes: dict, out_dir, base_stem: str,
                device: str = "cpu", cancel: threading.Event = None,
                on_line=None, on_stage=None) -> list:
    """Run the selected passes and land the cleaned clip(s) into `out_dir`.

    Returns a list of {path, ref, take, dur_s} — one per output clip — or [] if trim dropped
    everything. The caller (the server route) owns writing each output's sidecar (provenance
    "cleaned" + derivation) and any store bookkeeping; this function only produces audio.

    Order is TRIM → DENOISE (§2, §10.4): cut the dirty stretches first, then denoise the real
    survivors. Denoise never runs on already-enhanced audio (that is a separate axis, §6).
    """
    passes = normalize_passes(passes)
    trim, den = passes["trim"], passes["denoise"]
    if not trim["enabled"] and not den["enabled"]:
        raise ValueError("nothing to do — enable trim, denoise, or both")

    out_dir = Path(out_dir)
    scratch_made = []           # every scratch WAV we create, removed in the finally
    try:
        # 1. TRIM → takes in scratch, or the whole clip as the single (denoise-only) take.
        if trim["enabled"]:
            if on_stage:
                on_stage("trim")
            takes = _trim_to_scratch(cfg, src, trim["max_excess_db"], trim["music_veto"],
                                     cancel, on_line)
            scratch_made += [p for _, p in takes]
            if not takes:
                return []
        else:
            # Denoise-only: the child reads WAV (soundfile can't do MP3), so decode the source
            # to an opaque scratch WAV first. Trim off + denoise off was already rejected above,
            # so denoise is always enabled here.
            #
            # 🔴 ROUTE THE DECODE. `_decode_wav` shells out to ffmpeg, which has no DEK, and
            # `src` is `voice_training/<name>` — a routed tree, so on an encrypted install the
            # logical path is not on the platter and ffmpeg dies "No such file or directory".
            # The TRIM branch above survives only because `_trim_to_scratch` opens its own
            # child_input; this branch is the one that never got one. Same seam, same C2 rule
            # as `analyze()` — see the long note there.
            #
            # IDENTITY STAYS ON `src`: scratch_path keys the opaque name on the SOURCE, not on
            # the decrypted copy, exactly as analyze()'s score cache does.
            wav = scratch_path(cfg, src, tag=f"den-src|{uuid.uuid4().hex}")
            with vault_fs.child_input(src, cfg.scratch) as plain:
                _decode_wav(plain, wav)
            scratch_made.append(wav)
            takes = [(1, wav)]
        multi = len(takes) > 1

        # 2. DENOISE each take (child) if enabled; otherwise the trim take IS the output.
        outputs = []
        for idx, take_path in takes:
            if cancel is not None and cancel.is_set():
                return outputs
            stem = output_stem(base_stem, passes, take_idx=idx if multi else None)
            dst = out_dir / f"{stem}.wav"
            if den["enabled"]:
                if on_stage:
                    on_stage(f"denoise take {idx}" if multi else "denoise")
                tmp = scratch_path(cfg, take_path, tag=f"den|{stem}|{uuid.uuid4().hex}")
                scratch_made.append(tmp)
                rc = run_denoise(cfg, take_path, tmp, den["wet"], den["atten"],
                                 device=device, cancel=cancel, on_line=on_line)
                if rc == -1:                    # canceled mid-denoise
                    return outputs
                if rc != 0:
                    raise RuntimeError(f"denoise failed (exit {rc}) on take {idx}")
                landing = tmp
            else:
                landing = take_path             # trim-only: the cut take is the output
            # 🔴 M10 §4.2 C6 — PROBE BEFORE LANDING, and this is the one the document warns
            # "works today ONLY because C1 is broken". ffprobe_duration used to run on `dst`,
            # i.e. on the file already in the store: that worked while C1 wrote it in cleartext,
            # and the moment C1 is fixed ffprobe — a CHILD with no DEK — gets ciphertext and
            # every cleaned clip reports a duration of 0. Fixing the leak silently breaks the
            # probe unless they move together, which is why §9 sequences them as one step.
            #
            # The scratch take is byte-identical to what lands (from_scratch encrypts, it does
            # not transcode), so probing it first is the same measurement, taken while the bytes
            # are still legible to a child process. It must happen BEFORE _land: from_scratch
            # removes its source.
            dur = ffprobe_duration(landing)
            _land(landing, dst)
            outputs.append({"path": dst, "ref": dst.name,
                            "take": idx if multi else None,
                            "dur_s": dur})
        return outputs
    finally:
        for p in scratch_made:
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                logger.warning(f"could not remove cleanup scratch: {p}")


# ── ETA (measured, never guessed) ────────────────────────────────────────────

def measured(device: str = "cpu"):
    """This box's measured (startup_s, seconds_per_audio_second) for the denoise pass, or None
    before it has ever been timed here. None is the honest answer; the caller renders it."""
    key_dev = "cpu" if str(device).startswith("cpu") else "cuda"
    return cleanup_rate.get(cleanup_rate.key_for(device=key_dev))


def estimate_seconds(audio_seconds: float, files: int = 1, device: str = "cpu"):
    """Wall-clock seconds for the denoise pass on THIS box, or None if it has not been timed
    yet. `files` is how many takes get denoised (each pays the model load). Trim's own cost is
    a fast, decode-bound pass and is not separately estimated."""
    return cleanup_rate.eta_seconds(audio_seconds, measured(device), files=files)
