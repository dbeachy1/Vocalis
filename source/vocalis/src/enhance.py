"""Extend speech bandwidth before training. Chatterbox output is limited to 24 kHz, leaving a silent high-frequency range for higher-rate training targets; enhancement adds synthetic high-frequency content. The external enhancer reads and writes real files, so plaintext uses an opaque hash-derived name under the configured scratch directory and never the OS temp directory or dataset tree."""
from __future__ import annotations

import errno
import hashlib
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from loguru import logger

# voiceswap does not import us, so this is not a cycle. Reusing its ffprobe wrapper,
# card pinning, process-group kill and ROCm-noise filter rather than growing a second
# set: there is one way to ask "how long is this file", and one way to run a GPU child.
from engine_process import (NOISE_MARKERS, SETUP_HINT, card_env as _card_env,
                            ffprobe_duration, kill_tree as _kill_tree, venv_python)

# THE IDENTITY SEAM (5.0 §7.7.2) — see the block above source_key(). Its body lives in
# tts_utils since M4 so that `stems` can reach it too without an import cycle; this is still
# the name the M6/M7 brief repoints, and re-exporting it is what keeps that true.
from tts_utils import source_stat

# What this box actually enhances at. The store is the sibling of render_rate.py, and
# `_gpu_name` is render_rate's — one definition of "which card is this", shared by both
# rate stores, so the two can never key on the box differently.
import enhance_rate
import scratch as scratch_mod          # `scratch` is an EnhanceConfig field name — don't shadow it
from render_rate import gpu_name as _gpu_name

# The default balances high-frequency coherence against runtime; higher step counts did not improve perceived quality enough to justify their cost.
NFE_CHOICES = (8, 16, 32)
NFE_DEFAULT = 32

# Enhancement timing is measured per device and configuration in `enhance_rate.py`; do not hardcode a machine-specific throughput estimate.

# The enhancer resamples to its own rate; this is what comes out, always.
OUTPUT_SAMPLE_RATE = 44100

# The Docker image owns this isolated runtime; explicit settings can redirect it
# for development or a supported package layout.
DEFAULT_ENHANCE_VENV = Path("/opt/vocalis/venvs/enhance")

# Runtime uses this frozen publisher snapshot directly; it never resolves a Hub branch.
ENHANCE_MODEL_REVISION = "f35e879924e339228db2e9752185a21ef8ffeb3e"
ENHANCE_MODEL_FILES = (
    "hparams.yaml",
    "ds/G/latest",
    "ds/G/default/mp_rank_00_model_states.pt",
)
DEFAULT_ENHANCE_MODEL_DIR = (
    Path("/models/vocalis/enhance") / ENHANCE_MODEL_REVISION / "enhancer_stage2"
)

# Speech MP3 bitrates. The whole point of enhancement is content in 11-22 kHz, so the
# encode must not throw it straight back away.
#
# Measured as how far below the signal the encoder's error sits — higher is cleaner
# (DESIGN §7). Read these as RELATIVE headroom, not absolutes: raw SNR understates a
# perceptual codec, which hides its error under the masking threshold.
#
#   un-enhanced (24 kHz mono, →11 kHz):  96k = 37.9 dB · 128k = 46.1 · 192k = 51.2
#   enhanced    (44.1 kHz mono, →22 kHz):        128k = 32.8 dB · 192k = 41.9 · 256k = 49.8
#
# 96k stays right for un-enhanced Chatterbox: there is nothing above 11 kHz to lose, and
# per Hz per channel it is DENSER than the 320k we use for music (8.7 vs 8.0 bits/s/Hz).
#
# 256k — not 192k — for enhanced speech. ENHANCEMENT DOUBLES THE BANDWIDTH THE ENCODER
# MUST PAY FOR, so the same bitrate stretches half as far: 128k collapses to 32.8 dB, the
# worst number in the whole table. This is the correction that matters, and it is why the
# first pass at this file said 192k: that number was written before the measurement.
MP3_BITRATE_PLAIN    = "96k"
MP3_BITRATE_ENHANCED = "256k"


def mp3_bitrate(enhanced: bool) -> str:
    """The one rule for encoding SPEECH. (Music is voiceswap.MP3_BITRATE — 320k STEREO,
    a different question with a different answer; never route it through here.)"""
    return MP3_BITRATE_ENHANCED if enhanced else MP3_BITRATE_PLAIN


class EnhanceFailed(RuntimeError):
    """The enhancer exited non-zero. Twin of voiceswap.StageFailed / voicetrain.TrainFailed,
    and it exists for the same reason.

    `str(exc)` is a SAFE summary — what failed, and the exit code — because that is what
    logger.exception() writes into logs/vocalis.log, outside the vault. `.detail` carries
    the LABEL, and every label this app passes is user prose: a book chapter's WAV is named
    `<NN>_<safe_name(title)>` (book_to_audio.py:176) and a Playground clip's MP3 is named
    from the PROMPT (playground_clips.clip_stem). Browser only."""

    def __init__(self, message: str, *, detail: str = ""):
        super().__init__(message)
        self.detail = detail


@dataclass
class EnhanceConfig:
    python: Path        # the ISOLATED enhance venv (never Vocalis's own — torch clashes)
    script: Path        # scripts/enhance/enhance_audio.py
    scratch: Path       # where plaintext may briefly exist (5.0 §8.3)
    model_dir: Path = DEFAULT_ENHANCE_MODEL_DIR  # the pinned enhancer_stage2 run directory

    @property
    def model_missing_files(self) -> tuple[str, ...]:
        """Missing files from the one supported local model snapshot."""
        if (self.model_dir.name != "enhancer_stage2"
                or self.model_dir.parent.name != ENHANCE_MODEL_REVISION):
            return (f"directory for pinned snapshot {ENHANCE_MODEL_REVISION}",)
        if not self.model_dir.is_dir():
            return ENHANCE_MODEL_FILES
        return tuple(name for name in ENHANCE_MODEL_FILES
                     if not (self.model_dir / name).is_file())

    @property
    def model_ready(self) -> bool:
        return not self.model_missing_files

    @property
    def toolchain_available(self) -> bool:
        return self.python.is_file() and self.script.is_file()

    @property
    def available(self) -> bool:
        """True only when the isolated toolchain and pinned local model are present."""
        return self.toolchain_available and self.model_ready

    @property
    def unavailable_reason(self) -> str:
        if not self.python.is_file():
            # The Docker edition bakes this environment into the image; there is nothing to install.
            return "The isolated Enhance environment is missing from this image."
        if not self.script.is_file():
            return "The Enhance child script is missing from this image."
        if not self.model_ready:
            # Setup downloads the weights (design section 5, "Model acquisition by setup"), so a
            # rerun is the fix, and it resumes rather than starting over.
            return "The pinned Resemble Enhance model snapshot is incomplete (" + ", ".join(
                self.model_missing_files) + ")." + SETUP_HINT
        return ""


def resolve_config(app_settings: dict, base_dir: Path = None) -> EnhanceConfig:
    """env var → app_settings.yaml `enhance:` → default. Same precedence as
    voicetrain.resolve_config and voiceswap.resolve_config; deliberately identical so
    there is one rule to remember."""
    s = (app_settings or {}).get("enhance") or {}
    root = Path(base_dir) if base_dir else Path(__file__).resolve().parent.parent

    def pick(env: str, key: str, default):
        return Path(os.environ.get(env) or s.get(key) or default)

    return EnhanceConfig(
        # venv_python: scripts/enhance/setup.bat builds this venv on Windows, where the
        # interpreter is Scripts\python.exe — a hardcoded bin/python read it as not installed.
        python=venv_python(pick("VOCALIS_ENHANCE_VENV", "venv", DEFAULT_ENHANCE_VENV)),
        script=root / "scripts" / "enhance" / "enhance_audio.py",
        model_dir=pick("VOCALIS_ENHANCE_MODEL_DIR", "model_dir", DEFAULT_ENHANCE_MODEL_DIR),
        # M3 gave VOCALIS_SCRATCH_DIR a real owner (scratch.py, 5.0 §8.3). This resolves it
        # through that owner rather than re-deriving it, so there is ONE definition of where
        # plaintext may land — 4.1 wrote its own to this design's contract before the code
        # existed, which was exactly right, and the way to keep two things agreeing forever
        # is to make them one thing.
        scratch=Path(os.environ.get(scratch_mod.ENV_VAR) or s.get("scratch")
                     or scratch_mod.scratch_root(app_settings)),
    )


def scratch_path(cfg: EnhanceConfig, src: Path, tag: str = "", suffix: str = ".wav") -> Path:
    """Return an opaque hash-derived scratch path for a source file. Include the suffix and a tag so intermediate and final outputs from the same source remain distinct. Keep the naming construction aligned with vault.decrypt_to_scratch."""
    return scratch_mod.path_for(cfg.scratch, src, tag, suffix)


# `source_stat` is implemented in `tts_utils` so this module and other callers can share the identity helper without an import cycle.


def source_key(p) -> str:
    """The stable identity of a source file: logical path + logical size + logical mtime.

    A file that cannot be stat'd falls back to its path alone — the same answer the inline
    version gave, so a cache entry minted before this seam existed still resolves."""
    p = Path(p)
    st = source_stat(p)
    if st is None:
        return str(p)
    return f"{p.resolve()}|{st[0]}|{st[1]}"


def cache_path(src: Path, nfe: int = NFE_DEFAULT, trim_s=None) -> Path:
    """Where the enhanced version of `src` lives once we have made it — or would live.

    ENHANCEMENT IS CACHED BECAUSE IT IS DETERMINISTIC. An hour of audio is ~16 minutes of
    GPU at 32 steps (measured — the 95 minutes this docstring used to claim was the same
    bad constant that quoted an 8-hour book), and prep WIPES _datasets/ on every run
    (voicetrain.py: shutil.rmtree(dd)) — so without a cache, retraining the same voice
    three times to tune epochs would re-derive byte-identical WAVs three times and burn
    the better part of a GPU-hour doing it. Pay once per clip, not once per training run.
    Cheaper than it looked is still not free, and the cache costs nothing to keep.

    The key covers everything the output actually depends on: the source's identity
    (path + size + mtime), the trim ffmpeg applies BEFORE the enhancer ever sees the
    audio, and the step count. Change any one and you get a different file — never a
    stale one.

    The name is opaque, like every other thing we put on disk (5.0 §8.3). A Playground
    clip is named after the user's PROMPT (playground_clips.clip_stem), so a cache keyed
    on the source's NAME would quietly copy that text into yet another plaintext
    filename.

    Lives under cache_root(), which is documented as regenerable and safe to delete: the
    worst a wipe costs is re-enhancing.
    """
    from tts_utils import cache_root          # local: avoids a heavy import at module load

    # Keep the cache key stable so existing cache entries remain addressable.
    key = f"{source_key(src)}|nfe={int(nfe)}|trim={int(trim_s) if trim_s else 0}"
    return cache_root() / "enhanced" / (hashlib.sha256(key.encode("utf-8")).hexdigest()[:24] + ".wav")


def store_cache(tmp: Path, dst: Path) -> None:
    """Atomically store a completed enhanced WAV. The child writes only to scratch; this function is the single store boundary and uses vault-aware storage when the destination is routed. Handle cross-filesystem scratch by copying to a temporary destination before replacement so readers never observe a partial WAV."""
    import vault_fs      # local: avoids a heavy import at module load

    vault_fs.from_scratch(Path(tmp), Path(dst))


def build_enhance_cmd(cfg: EnhanceConfig, src: Path, dst: Path,
                      nfe: int = NFE_DEFAULT, device: str = "cuda:0") -> list:
    """The child process. Path in, path out — it knows nothing about the vault, exactly
    like scripts/voiceswap/rvc_infer.py. The CALLER owns decrypt/encrypt."""
    return [str(cfg.python), str(cfg.script),
            "-i", str(src), "-o", str(dst),
            "--model-dir", str(cfg.model_dir),
            "--nfe", str(int(nfe)),
            # _card_env() made the chosen card the only visible one, so it is cuda:0
            # to the child regardless of which physical card we picked.
            "--device", "cpu" if device == "cpu" else "cuda:0"]


def run_enhance(cfg: EnhanceConfig, src: Path, dst: Path, nfe: int = NFE_DEFAULT,
                device: str = "cuda:0", cancel: threading.Event = None,
                on_line=None) -> int:
    """Run the external enhancer and return its exit code, or -1 when canceled. This is the shared entry point for caller logging, card pinning, cancellation, and child-output filtering. Route source files through child_input before passing them to the isolated child; require destinations to be caller-owned scratch paths. Store completed output separately."""
    import scratch as scratch_mod
    import vault_fs
    with vault_fs.child_input(src, scratch_mod.scratch_root()) as plain_src:
        return _run_enhance(cfg, plain_src, dst, nfe, device, cancel, on_line)


def _run_enhance(cfg: EnhanceConfig, src: Path, dst: Path, nfe: int, device: str,
                 cancel: threading.Event, on_line) -> int:
    """`run_enhance`'s body, on a path the CHILD CAN OPEN. Never call it with a store path."""
    cmd = build_enhance_cmd(cfg, src, dst, nfe, device)
    kw = {}
    if os.name != "nt":
        kw["start_new_session"] = True          # own pgid — _kill_tree needs it
    started = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace",
                            env=_card_env(device), **kw)
    timing = {}

    def _pump():
        for raw in iter(proc.stdout.readline, ""):
            line = raw.strip()
            # The child's machine-readable timing line: consumed here, never shown. It is
            # how this box learns its own speed (enhance_rate.py) — it is not log output.
            t = enhance_rate.parse_timing(line)
            if t is not None:
                timing.update(t)
                continue
            if line.startswith("VOCALIS_TIMING "):
                continue                        # unusable measurement — still not log output
            # Known-benign ROCm/MIOpen chatter every torch child on this box prints.
            # Three lines of "No such file or directory" read as a failure when they
            # are not, so they stay in the server log and out of the user's.
            if line and not any(n in line for n in NOISE_MARKERS) and on_line:
                on_line(line)
        proc.stdout.close()

    t = threading.Thread(target=_pump, daemon=True)
    t.start()
    while proc.poll() is None:
        if cancel is not None and cancel.is_set():
            _kill_tree(proc)
            proc.wait()
            t.join(timeout=5)
            return -1
        time.sleep(0.2)
    t.join(timeout=5)
    rc = proc.returncode
    # THE RUN MEASURES ITSELF. Only a clean one: a canceled or failed enhancement did not
    # do the work its numbers would describe. `startup` is everything that did not scale
    # with the audio — spawn, imports, weights, the model load, the WAV write — which is
    # exactly (wall - compute), and is the term the book pays once per chapter.
    if rc == 0 and timing:
        wall = time.monotonic() - started
        startup = wall - timing["compute_s"]
        if startup >= 0:
            try:
                enhance_rate.record(enhance_rate.key_for(_gpu_name(), nfe),
                                    timing["audio_s"], timing["compute_s"], startup)
            except Exception:                   # noqa: BLE001 — a rate cache is not the job
                logger.exception("could not record the enhance rate")
    return rc


def measured(nfe: int = NFE_DEFAULT):
    """Return measured (startup_seconds, seconds_per_audio_second) for the selected step count, or None until this configuration has timing data."""
    return enhance_rate.get(enhance_rate.key_for(_gpu_name(), nfe))


def estimate_seconds(audio_seconds: float, nfe: int = NFE_DEFAULT, cards: int = 1,
                     files: int = 1):
    """Estimate wall-clock enhancement time in seconds, or return None until the selected device and settings have been measured. Account for each separate child invocation and spread independent files across available cards."""
    return enhance_rate.eta_seconds(audio_seconds, measured(nfe), cards=cards, files=files)


def eta_str(seconds: float) -> str:
    """A duration a human reads without doing arithmetic.

    Every ETA used to be printed as `~{est:.0f} min`, which was fine while the rate was
    overstated by 5x and became "~0 min" the moment it wasn't — and "~0 min" reads either
    as "instant" or as a bug. It is neither: it is fifteen seconds.
    """
    s = max(0.0, float(seconds))
    if s < 90:
        return f"{s:.0f}s"
    if s < 3600:
        return f"{s / 60:.0f} min"
    return f"{s / 3600:.1f} h"          # a book-length wait belongs in hours


NO_ESTIMATE = ("no estimate yet — this box has not been timed at these settings. "
               "This run is being timed, and the next one will have a number")


def eta_note(seconds) -> str:
    """'~16 min', or the honest sentence when this box has never been timed.

    Every ETA the user reads goes through here, so there is exactly one place that decides
    what "we don't know yet" sounds like — and no call site can quietly paper over a None
    with a zero, which would print "~0s" and read as "instant".
    """
    return f"~{eta_str(seconds)}" if seconds else NO_ESTIMATE


def validate_nfe(raw, default: int = NFE_DEFAULT) -> int:
    """Coerce a request's nfe to one of the offered choices. Anything else is a
    typo or a probe; neither deserves a 500."""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return n if n in NFE_CHOICES else default


# ── is this audio band-limited? ──────────────────────────────────────────────
#
# We MEASURE this rather than track it, because the question that matters is not
# "did we enhance this?" but "is this band-limited?" — and those come apart:
#
#   * a real 48 kHz recording was never enhanced, and must NOT be (it is already
#     full-band; running it through the enhancer would only degrade it). A
#     provenance flag gets this case wrong.
#   * an already-enhanced clip must not be enhanced twice.
#   * a renamed / re-uploaded / pre-4.1 file has no provenance to read.
#
# One rule answers all of them. The RESULT is cached in the caller's sidecar
# (keyed on size+mtime) so a library listing never re-measures — the measurement is
# the source of truth, the sidecar is only ever a cache.

# The 14 kHz threshold separates common codec low-pass behavior from clearly band-limited material while avoiding a boundary near either cluster.
FULL_BAND_HZ = 14000
_REF_LO, _REF_HI = 1000, 4000      # the band every speech signal has energy in
_FLOOR_DB = -40.0                  # "real content" = within 40 dB of that reference


def probe_offset(duration_s: float, probe_seconds: float = 5.0) -> float:
    """Where to take the probe window from: a quarter in, past any lead-in — but never
    past the end of the file.

    This clamp is load-bearing. Seek beyond a short clip's end and ffmpeg decodes
    nothing, measure_bandwidth returns 0 ("unknown"), and is_band_limited says "no" —
    so a short, band-limited clip would silently never be enhanced. Caught by the very
    first test that used a real 30-second file.
    """
    d = float(duration_s or 0)
    if d <= probe_seconds:
        return 0.0
    return min(d * 0.25, d - probe_seconds)


def measure_bandwidth(path, probe_seconds: float = 5.0, offset_s: float = None) -> int:
    """Measure the highest frequency with real audio content, in Hz. Decrypt routed input once to scratch for the probes. Return zero when a probe cannot read the file; callers treat zero as unknown, not as evidence of bandwidth limitation. Skip decoding when the sample rate alone proves the Nyquist limit."""
    import scratch as scratch_mod
    import vault_fs
    with vault_fs.child_input(path, scratch_mod.scratch_root()) as plain:
        return _measure_bandwidth(plain, probe_seconds, offset_s)


def _measure_bandwidth(path, probe_seconds: float, offset_s) -> int:
    """`measure_bandwidth`'s body, on a path a CHILD PROCESS CAN OPEN. Never call it with a
    store path — that is what the wrapper above is for."""
    sr = _probe_sample_rate(path)
    if sr <= 0:
        return 0
    nyquist = sr // 2
    if nyquist <= FULL_BAND_HZ:
        return nyquist                     # settled by arithmetic; no decode

    if offset_s is None:
        offset_s = probe_offset(ffprobe_duration(path), probe_seconds)
    x = _decode_window(path, sr, probe_seconds, offset_s)
    if x is None or x.size < 8192:
        return 0

    n = 8192
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::n // 2]
    rms_db = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-10)
    loud = rms_db > (rms_db.max() - 25)    # ignore silence: it has no spectrum to read
    if not loud.any():
        return 0

    power = (np.abs(np.fft.rfft(frames[loud] * np.hanning(n), axis=1)) ** 2).mean(0)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    with np.errstate(divide="ignore"):
        db = 10 * np.log10(power + 1e-20)

    ref = db[(freqs >= _REF_LO) & (freqs < _REF_HI)].mean()
    real = np.flatnonzero(db > ref + _FLOOR_DB)
    return int(freqs[real[-1]]) if real.size else 0


def is_band_limited(bandwidth_hz) -> bool:
    """True ⇒ this file needs enhancing before it is safe to train on.

    Unknown (0/None) is NOT band-limited: we refuse to spend 95 minutes of GPU on a
    guess. A probe that failed is a probe that failed, not a license to act.
    """
    try:
        hz = int(bandwidth_hz or 0)
    except (TypeError, ValueError):
        return False
    return 0 < hz < FULL_BAND_HZ


def bandwidth_of(path, meta: dict = None) -> tuple:
    """Return cached (bandwidth_hz, fields_to_persist) values for a file. Reuse a measurement while the file identity (size and modification time) is unchanged. Cache the measured frequency, not the bandwidth-limited verdict, so threshold changes do not stale the measurement."""
    p = Path(path)
    st = source_stat(p)                            # the identity seam, not p.stat()
    if st is None:
        return 0, {}
    size, mtime = st

    m = meta or {}
    if (m.get("bandwidth_hz") is not None
            and m.get("bandwidth_size") == size
            and int(m.get("bandwidth_mtime") or -1) == mtime):
        return int(m["bandwidth_hz"]), {}          # cache hit — the audio is not touched

    hz = measure_bandwidth(p)
    return hz, {"bandwidth_hz": hz,
                "bandwidth_size": size,
                "bandwidth_mtime": mtime}


def _probe_sample_rate(path) -> int:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate", "-of", "csv=p=0:nk=1", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        return int((out.stdout or "0").strip().splitlines()[0])
    except Exception as e:
        # NOT {path}: a Playground clip's stem IS the user's prompt, a book chapter's is its
        # title, and this runs on the request thread of both listing routes. The failure is
        # worth logging; the words are not. logs/vocalis.log sits outside the vault.
        logger.warning(f"could not probe sample rate — treating as unknown ({type(e).__name__})")
        return 0


def _decode_window(path, sr: int, seconds: float, offset_s: float = None):
    """A window from the MIDDLE by default: the head of a render is often a lead-in,
    and silence carries no spectrum to measure."""
    cmd = ["ffmpeg", "-v", "error"]
    if offset_s is not None and offset_s > 0:
        cmd += ["-ss", f"{offset_s:.2f}"]      # before -i = fast seek
    cmd += ["-t", f"{seconds:.2f}", "-i", str(path),
            "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    try:
        raw = subprocess.run(cmd, capture_output=True, timeout=60).stdout
        return np.frombuffer(raw, dtype=np.float32) if raw else None
    except Exception as e:
        logger.warning(f"could not decode a probe window ({type(e).__name__})")   # not {path}
        return None
