#!/usr/bin/env python3
"""Analyze a vocal track for intervals containing only the lead and prepare the corresponding audio edit. The separation model supplies detection spans; its audio is discarded. De-reverb output is retained for training, so cut only after processing the full wet signal."""
import hashlib
import json
import math
import subprocess
from dataclasses import asdict, dataclass, replace
from pathlib import Path

import numpy as np
from loguru import logger

#: Below this much kept audio a set is flagged `thin` rather than failed (§9.5). "This song is
#: unusable for training" is a real answer and must not look like a crash.
MIN_USEFUL_SEC = 15.0

#: The karaoke detector is used only to identify candidate spans; its separated audio is discarded. Select it for useful detection behavior rather than fidelity or a speed ranking.
KARAOKE_MODEL = "UVR_MDXNET_KARA_2.onnx"

#: This is an allowlist, not a ranking. The values are passed to a child process and used to select model files, so reject names outside this list. Keep order as the default preference; do not infer model quality from synthetic or nonrepresentative inputs.
DEREVERB_MODELS = [
    "UVR-DeEcho-DeReverb.pth",                                    # 3.7× realtime, the default
    "UVR-De-Reverb-aufr33-jarredou.pth",                          # 8.5×, changed the fixture least
    "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",         # 1.14×, highest published SDR
    "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt",   # 1.12×, gentler
]
DEREVERB_DEFAULT = DEREVERB_MODELS[0]


def dereverb_model(name) -> str:
    """A requested de-reverb model → one of `DEREVERB_MODELS`, falling back to the default.

    Same contract as `params_from`: a knob arriving from a request body is clamped, never
    trusted and never fatal. Unlike a threshold it is also a PATH FRAGMENT handed to a child
    process, so "unrecognized" has to mean the default rather than "pass it along and see"."""
    n = str(name or "").strip()
    return n if n in DEREVERB_MODELS else DEREVERB_DEFAULT


def detector_name() -> str:
    """What the `lead:` block records as the detector — the model, without its extension, so
    the sidecar reads as a model name rather than a filename (§6)."""
    return Path(KARAOKE_MODEL).stem


# ── the model files a run reads — present, or the job does not start ─────────────────────────
#
# 🔴 `audio-separator` DOWNLOADS whichever of these is absent (separator.py `download_file_if_not_
# exists`, from github.com), and it has no offline switch. Ordinary operation must never fetch a
# model (setup downloads every file listed here from its publisher, size- and hash-checked:
# packaging/models/leadvocal/model-file-lock.json; October 11, 2026, when the earlier licensing hold
# was lifted), so the parent checks that every file the library would read is already there and
# fails the job BEFORE any child starts. Keep the lock in step with `model_files_needed`: a file this
# function can ask for must be in the lock, or the check fails after a complete setup. Nothing here trusts the child's own caution: the child
# is only ever started once this has said yes. The file list was read from audio-separator 0.44.5
# (`list_supported_model_files`, `download_model_files`, `load_model_data_using_hash`).

#: Read for EVERY model: the catalog that `download_model_files` searches for the filename.
SEPARATOR_CATALOG = "download_checks.json"

#: Read for the MDX and VR models only: the per-model parameters, found by the model file's MD5.
HASH_LOOKUP_FILES = ("vr_model_data.json", "mdx_model_data.json")

#: The MDXC (Roformer) models are described by a YAML beside the checkpoint instead, and
#: the two hash tables above are not read for them. Both retained Roformer de-reverb models
#: share one YAML (audio-separator models.json `roformer_download_list`).
MODEL_CONFIG_FILES = {
    "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt": "dereverb_mel_band_roformer_anvuew.yaml",
    "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt":
        "dereverb_mel_band_roformer_anvuew.yaml",
}

#: What the child's `--model-dir` defaults to (`scripts/leadvocal/detect.py`) when the caller
#: passes none, so a bare config is checked where the child would actually look.
DEFAULT_MODEL_DIR_NAME = "leadvocal-models"


def model_files_needed(*models) -> list:
    """Every file name `audio-separator` reads from the model directory to load `models`, once
    each and in a stable order. An unlisted model is treated like the MDX/VR kind, which is the
    case that needs the most files."""
    need = [SEPARATOR_CATALOG]
    for model in models:
        if not model:
            continue
        need.append(str(model))
        config = MODEL_CONFIG_FILES.get(str(model))
        need.extend([config] if config else HASH_LOOKUP_FILES)
    return list(dict.fromkeys(need))


def missing_model_files(model_dir, *models) -> list:
    """The names from `model_files_needed` that are not a regular file in `model_dir`. The
    library's own test before it downloads is `os.path.isfile`, so this asks the same question."""
    root = Path(model_dir) if model_dir else Path.home() / DEFAULT_MODEL_DIR_NAME
    return [name for name in model_files_needed(*models) if not (root / name).is_file()]


def require_models(model_dir, *models) -> None:
    """Raise RuntimeError, naming what is missing, unless every file `models` needs is present.

    Call this immediately before a separator child would be spawned. The message is what the job
    shows the user, so it says what is absent and how to get it (setup fetches it); the directory
    goes to the log only, because it is a server path."""
    root = Path(model_dir) if model_dir else Path.home() / DEFAULT_MODEL_DIR_NAME
    missing = missing_model_files(root, *models)
    if not missing:
        logger.info(f"lead-vocal models present in {root}: "
                    f"{', '.join(model_files_needed(*models))}")
        return
    logger.warning(f"lead-vocal models missing in {root}: {', '.join(missing)} — "
                   f"refusing to start the separator, nothing is downloaded")
    raise RuntimeError(
        f"Lead Vocal needs model files that have not been downloaded yet: {', '.join(missing)}. "
        f"Run setup again to fetch them; on Windows that is Start menu > Repair setup.")


#: The de-reverb output may be slightly shorter than its input with no measurable lag. Pad small length differences up to this limit; larger differences are not trusted. The bound is far below a shift that could move a cut audibly.
ALIGN_PAD_LIMIT_S = 0.05

#: How much audio `lag_of` correlates over, and how far it searches. A lag big enough to matter is
#: a lag this window finds; a longer window costs an FFT for nothing.
LAG_WINDOW_S = 8.0
LAG_SEARCH_S = 0.05


@dataclass(frozen=True)
class LeadParams:
    """§5. Every dB is **relative to the wet vocal stem's peak**, so one threshold travels across
    songs mastered at different levels — and BOTH envelopes are measured against that same
    reference. The backing signal's own peak is a moving target that would quietly redefine
    `backing_enter_db` on every song."""

    backing_enter_db: float = -30.0     # above this, backing is present. THE sensitivity knob
    backing_exit_db: float = -36.0      # below this it is gone; the gap is hysteresis, so the
                                        # gate does not chatter on a breath
    lead_floor_db: float = -40.0        # below this she is not singing — rejects instrumental
                                        # bleed that leaked into the vocals stem
    guard_sec: float = 0.20             # erode each kept span inward, so a harmony's onset/tail
                                        # cannot bleed into a clip edge
    min_span_sec: float = 2.0           # shorter than this is not usable training material
    merge_gap_sec: float = 0.30         # bridge a breath so a phrase is not chopped mid-word
    fade_sec: float = 0.02              # click prevention at every edge
    silence_sec: float = 2.0            # inserted between spans in the output
    frame_length: int = 2048            # ≈ 11.6 ms resolution at 44.1 kHz
    hop_length: int = 512
    peak_dbfs: float = -0.25            # post-join normalization target
    dereverb: bool = True               # §4b — enabled by default and overridable per request

    def frames_per_sec(self, sr: int) -> float:
        return sr / float(self.hop_length)


#: Bounds for anything arriving from a request body. A threshold is a knob, not an injection
#: point, and a `min_span_sec` of 0 would emit ten thousand 11 ms spans.
_LIMITS = {
    "backing_enter_db": (-90.0, 0.0), "backing_exit_db": (-90.0, 0.0),
    "lead_floor_db": (-90.0, 0.0), "guard_sec": (0.0, 2.0), "min_span_sec": (0.1, 60.0),
    "merge_gap_sec": (0.0, 5.0), "fade_sec": (0.0, 0.5), "silence_sec": (0.0, 10.0),
    "frame_length": (256, 16384), "hop_length": (64, 4096), "peak_dbfs": (-12.0, 0.0),
}


def params_from(d) -> LeadParams:
    """Parse and clamp a request body into LeadParams. Invalid overrides fall back to known-good defaults. Keep backing_exit_db at or below backing_enter_db so the Schmitt trigger retains hysteresis instead of chattering and fragmenting spans."""
    out = {}
    src = d if isinstance(d, dict) else {}
    for k, (lo, hi) in _LIMITS.items():
        if k not in src or src[k] is None:
            continue
        try:
            v = float(src[k])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(v):
            continue
        v = max(lo, min(hi, v))
        out[k] = int(round(v)) if k in ("frame_length", "hop_length") else v
    if "dereverb" in src:
        out["dereverb"] = bool(src["dereverb"])
    p = replace(LeadParams(), **out)
    if p.backing_exit_db > p.backing_enter_db:
        p = replace(p, backing_exit_db=p.backing_enter_db)
    return p


def as_dict(p: LeadParams) -> dict:
    return asdict(p)


# ── the analysis (pure numpy — this is the part that decides what gets trained on) ────────────

def to_mono(x) -> np.ndarray:
    """(n, ch) or (n,) → (n,). Detection is a question about *content*, and a harmony panned hard
    left is no less a harmony."""
    a = np.asarray(x, dtype=np.float32)
    return a.mean(axis=1) if a.ndim > 1 else a


def peak_of(x) -> float:
    """The reference every dB in this module is measured against."""
    a = np.abs(to_mono(x))
    return float(a.max()) if a.size else 0.0


def envelope_db(x, ref_peak: float, p: LeadParams) -> np.ndarray:
    """Compute frame-wise RMS levels in dB relative to ref_peak. Use a strided index for one file at a time; avoid materializing a full frame-by-sample matrix for large inputs."""
    y = to_mono(x)
    # The `max` must wrap the complete frame-count expression. A signal shorter than one frame has zero frames; clamping the division before adding the initial frame incorrectly produced one and indexed past the input. Keep the zero-frame guard reachable.
    n = max(0, 1 + (len(y) - p.frame_length) // p.hop_length)
    if n <= 0 or ref_peak <= 0.0:
        return np.zeros(n, dtype=np.float32)
    idx = np.arange(p.frame_length)[None, :] + p.hop_length * np.arange(n)[:, None]
    rms = np.sqrt((y[idx].astype(np.float64) ** 2).mean(axis=1) + 1e-20)
    return (20.0 * np.log10(rms / ref_peak + 1e-12)).astype(np.float32)


def backing_present(backing_db, p: LeadParams) -> np.ndarray:
    """Schmitt trigger over the backing envelope: present above `backing_enter_db`, gone below
    `backing_exit_db`.

    The hysteresis gap is the whole point. A single threshold chatters across it on every breath
    and consonant, and each chatter becomes a span boundary — which `min_span_sec` then discards,
    quietly costing good material. Starts in the "absent" state so a song that opens on a solo
    line is not thrown away for want of a leading transition."""
    b = np.asarray(backing_db, dtype=np.float32)
    on = np.zeros(len(b), dtype=bool)
    state = False
    for i in range(len(b)):
        state = (b[i] >= p.backing_exit_db) if state else (b[i] >= p.backing_enter_db)
        on[i] = state
    return on


def keep_mask(lead_db, backing_on, p: LeadParams) -> np.ndarray:
    """The frames worth keeping: she is singing AND nobody else is.

    `lead_floor_db` is what stops an instrumental passage that leaked into the vocals stem from
    being "kept" purely because no backing was detected in it — silence with no harmony over it
    satisfies the second half of the test perfectly well."""
    ldb = np.asarray(lead_db, dtype=np.float32)
    n = min(len(ldb), len(backing_on))
    return (ldb[:n] >= p.lead_floor_db) & ~np.asarray(backing_on[:n], dtype=bool)


def _runs(mask) -> list:
    """Contiguous True runs of `mask`, as [start, end) frame indices."""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return []
    d = np.diff(np.concatenate(([0], m.view(np.int8), [0])))
    return [[int(a), int(b)] for a, b in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1))]


def spans_from(keep, backing_on, sr: int, p: LeadParams) -> list:
    """keep-mask → the final [(start_sec, end_sec)] to cut. Merge, then erode, then drop.

    🔴 **THE MERGE REFUSES TO BRIDGE A GAP THAT HAD BACKING IN IT.** `merge_gap_sec` exists so a
    phrase is not chopped mid-word across a breath — a gap where the LEAD fell below its floor. A
    gap where BACKING was present is a harmony, and bridging one puts backing vocals straight back
    into the training material, silently, in the one place this entire feature exists to prevent.
    The check is two lines and it is the most important thing in this file.
    (`scripts/cleanup/trim_audio.py`'s `group_takes` records the same rule for a different reason:
    a dropped region breaks the run.)

    Order is load-bearing. Merging BEFORE eroding means an interior bridged gap is not guarded —
    correct, because we just established that gap held no harmony. Eroding before dropping means
    `min_span_sec` judges what will actually be written, not what was found."""
    on = np.asarray(backing_on, dtype=bool)
    fs = p.hop_length / float(sr)                 # seconds per frame step
    merged = []
    for s in _runs(keep):
        if merged:
            gap_a, gap_b = merged[-1][1], s[0]
            if (gap_b - gap_a) * fs <= p.merge_gap_sec and not on[gap_a:gap_b].any():
                merged[-1][1] = s[1]
                continue
        merged.append(s)

    # Apply the guard only at interior span boundaries, where adjacent backing can bleed into the kept audio. The first span starts at the beginning of the song and the last ends at its end, so those outer edges need no erosion. Compare against the analyzed frame count so the rule is independent of hop size and sample rate.
    n = len(np.asarray(keep, dtype=bool))
    out = []
    for a, b in merged:
        t0 = a * fs + (0.0 if a <= 0 else p.guard_sec)
        t1 = b * fs - (0.0 if b >= n else p.guard_sec)
        if t1 - t0 >= p.min_span_sec:
            out.append((round(float(t0), 3), round(float(t1), 3)))
    return out


#: Flag detection as unreliable when the backing and lead envelopes track each other closely and their level difference has little variation. This can indicate failed separation or continuous backing; the signal alone cannot distinguish those causes, so report the observation without choosing one.
DETECTOR_ECHO_CORR = 0.90
DETECTOR_ECHO_IQR_DB = 3.0


#: Use one advisory sentence for both the job log and library row. It asks the listener to review uncertain spans without asserting that detection failed or that the song is unusable.
LEAD_WARNING = "this song may be unusable for training — please check it"


def detection_looks_unreliable(lead_db, backing_db, p: LeadParams) -> str:
    """Return an empty string when detection appears sound, otherwise a short statement of the observed signal. Envelope correlation cannot distinguish a failed separator from a song with continuous backing, so describe the observation rather than asserting its cause. This is advisory; preserve and write the spans found."""
    l = np.asarray(lead_db, dtype=np.float64)
    b = np.asarray(backing_db, dtype=np.float64)
    n = min(len(l), len(b))
    if n < 200:
        return ""
    voiced = l[:n] >= p.lead_floor_db          # silence correlates for reasons of its own
    if int(voiced.sum()) < 200:
        return ""
    l, b = l[:n][voiced], b[:n][voiced]
    if float(l.std()) < 1e-6 or float(b.std()) < 1e-6:
        return ""
    corr = float(np.corrcoef(l, b)[0, 1])
    gap = l - b
    iqr = float(np.subtract(*np.percentile(gap, [75, 25])))
    if corr >= DETECTOR_ECHO_CORR and iqr <= DETECTOR_ECHO_IQR_DB:
        return (f"the backing the detector found tracks the lead almost exactly "
                f"(correlation {corr:.2f}, spread {iqr:.1f} dB)")
    return ""


def analyze(lead_wav, backing_wav, sr: int, p: LeadParams) -> tuple:
    """The whole of stage 4 in one call: two signals in, `(spans, lead_db, backing_on)` out.

    Both envelopes are referenced to the LEAD's peak — see `LeadParams`. Returning the
    intermediates is deliberate: they are what `lead_spans.json` needs to explain a bad call, and
    what a test asserts against when a threshold is questioned."""
    ref = peak_of(lead_wav)
    lead_db = envelope_db(lead_wav, ref, p)
    backing_db = envelope_db(backing_wav, ref, p)
    n = min(len(lead_db), len(backing_db))
    on = backing_present(backing_db[:n], p)
    return spans_from(keep_mask(lead_db[:n], on, p), on, sr, p), lead_db, on


# ── the edit ──────────────────────────────────────────────────────────────────────────────────

def lag_of(a, b, sr: int, window_s: float = LAG_WINDOW_S,
           search_s: float = LAG_SEARCH_S) -> int:
    """Sample offset between `a` and `b`, by cross-correlation over one loud window — **as a
    magnitude and a zero/non-zero answer, not as a signed direction.**

    ⚠️ The sign is the correlation's, not an "offset of b relative to a": `lag_of(x, roll(x,
    300))` answers `-300`. Nothing depends on which way it points — `align_dry` tests `lag != 0`
    and the number only ever reaches a `dereverb_skipped` provenance string — but the docstring
    claimed a direction it does not deliver, so it now claims what it does.

    Measured on a LOUD stretch on purpose: correlating across a passage that is mostly noise floor
    finds a lag in the noise, confidently and wrongly. Returns 0 for degenerate input — an
    unmeasurable lag must read as "no evidence of a shift", because the caller's response to a
    non-zero lag is to discard the de-reverbed audio."""
    x, y = to_mono(a), to_mono(b)
    m = min(len(x), len(y))
    if m < sr:
        return 0
    x, y = x[:m], y[:m]
    peak = float(np.abs(x).max())
    if peak <= 0.0:
        return 0
    start = int(np.argmax(np.abs(x) > 0.05 * peak))
    w = min(int(window_s * sr), m - start)
    if w < sr // 2:
        return 0
    x, y = x[start:start + w].astype(np.float64), y[start:start + w].astype(np.float64)
    k = max(1, int(search_s * sr))
    fx = np.fft.rfft(x, 2 * w)
    fy = np.fft.rfft(y, 2 * w)
    cc = np.fft.irfft(fx * np.conj(fy))
    cand = np.concatenate([cc[:k], cc[-k:]])
    lags = np.concatenate([np.arange(k), np.arange(-k, 0)])
    return int(lags[int(np.argmax(cand))])


def align_dry(dry, wet, sr: int) -> tuple:
    """Return aligned dry audio or None with a reason. Detection spans measured on the wet signal can be applied to de-reverbed audio only when sample alignment is verified. Pad a short dry tail when the cross-correlation shows no shift; reject audio when a non-zero lag makes the spans unsafe."""
    d = np.asarray(dry, dtype=np.float32)
    w = np.asarray(wet, dtype=np.float32)
    if d.size == 0:
        return None, "de-reverb produced no audio"
    lag = lag_of(w, d, sr)
    if lag != 0:
        return None, f"de-reverb output is offset by {lag} samples"
    delta = len(w) - len(d)
    if delta == 0:
        return d, None
    if delta < 0:
        # LONGER than the input. Never observed; trimming is safe because the lag is zero, so the
        # extra samples are at the end.
        return d[:len(w)], None
    if delta > int(ALIGN_PAD_LIMIT_S * sr):
        return None, f"de-reverb output is {delta} samples short ({delta / sr:.3f}s)"
    pad = ((0, delta), (0, 0)) if d.ndim > 1 else (0, delta)
    return np.pad(d, pad, mode="constant"), None


def cut_join(x, sr: int, spans: list, p: LeadParams) -> np.ndarray:
    """The spans, sliced out of `x`, faded, and joined with `silence_sec` between them.

    The inserted silence is not padding — it is how the file trains. RVC slices a dataset at
    silence, so each gap becomes a cut point and one joined clip trains as the many clean takes it
    contains. That is `trim_audio.stitch_clip`'s argument, and it holds here for the same reason.

    Channels are preserved. The vocal stem is stereo and this is editing material, not a
    convenience mixdown — a downstream MP3 encode can fold it if it wants to."""
    a = np.asarray(x, dtype=np.float32)
    if not spans or a.size == 0:
        return np.zeros((0, a.shape[1]) if a.ndim > 1 else 0, dtype=np.float32)
    n = len(a)
    fade = max(0, int(p.fade_sec * sr))
    gap_shape = (max(0, int(p.silence_sec * sr)),) + ((a.shape[1],) if a.ndim > 1 else ())
    gap = np.zeros(gap_shape, dtype=np.float32)

    pieces = []
    for t0, t1 in spans:
        i0, i1 = max(0, int(round(t0 * sr))), min(n, int(round(t1 * sr)))
        if i1 <= i0:
            continue
        c = a[i0:i1].copy()
        f = min(fade, len(c) // 2)
        if f > 0:
            up = np.linspace(0.0, 1.0, f, dtype=np.float32)
            c[:f] *= up if c.ndim == 1 else up[:, None]
            c[-f:] *= up[::-1] if c.ndim == 1 else up[::-1, None]
        if pieces:
            pieces.append(gap)
        pieces.append(c)
    if not pieces:
        return np.zeros((0, a.shape[1]) if a.ndim > 1 else 0, dtype=np.float32)

    out = np.concatenate(pieces).astype(np.float32)
    peak = float(np.abs(out).max())
    if peak > 0.0:
        out *= (10.0 ** (p.peak_dbfs / 20.0)) / peak
    return out


# ── what the job records ──────────────────────────────────────────────────────────────────────

def summarize(spans: list, source_sec: float) -> dict:
    kept = float(sum(b - a for a, b in spans))
    return {"spans": len(spans), "kept_sec": round(kept, 2),
            "source_sec": round(float(source_sec), 2),
            "thin": kept < MIN_USEFUL_SEC}


def lead_block(spans: list, source_sec: float, *, detector: str, device: str,
               dereverb, params: LeadParams, built_at: str,
               dereverb_skipped: str = "", detector_warning: str = "") -> dict:
    """The `lead:` block for `stems.yaml` (§6).

    `dereverb` is the MODEL NAME when it ran and `False` when it did not — a set's provenance has
    to answer "what made this file", and 🔴 §4b's rule that a singer's dataset must never mix wet
    and dry material is only checkable if every set says which it is."""
    out = {"built_at": built_at, "detector": detector, "device": device,
           "dereverb": dereverb or False, "params": as_dict(params),
           **summarize(spans, source_sec)}
    if dereverb_skipped:
        out["dereverb_skipped"] = dereverb_skipped
    if detector_warning:
        # §9.8. Present ONLY when it fired, so a set that does not carry the key is a set the
        # detector handled — rather than one made before the check existed and one it passed
        # being indistinguishable.
        out["detector_warning"] = detector_warning
    return out


def spans_json(spans: list, source_sec: float, p: LeadParams, *, detector: str,
               dereverb, dereverb_skipped: str = "") -> str:
    """`lead_spans.json` — the provenance file that makes a bad detection reviewable instead of
    mysterious. It is the whole point of being able to see and redo a bad call (§9.4)."""
    # Unpack `summarize()` before the explicit `spans` list. The summary provides the count; the list must remain the timestamp records. Duplicate dictionary keys silently keep the later value, so reversing this order would replace the records with an integer.
    return json.dumps({
        **summarize(spans, source_sec),
        "spans": [{"start": a, "end": b, "dur": round(b - a, 3)} for a, b in spans],
        "detector": detector, "dereverb": dereverb or False,
        "dereverb_skipped": dereverb_skipped or None,
        "params": as_dict(p),
    }, indent=2)


# ── command builders (run by stemsplit, never here) ───────────────────────────────────────────

def build_decode_cmd(src, out_wav) -> list:
    """Any stored stem → plaintext WAV in the scratch, at its native rate and channel count.

    A stem is Opus since 7.5.25 and WAV before it, and the models take a file path. `-vn` because
    a Demucs WAV can carry a cover image forwarded from the source, which fails the encode."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(src), "-vn", "-c:a", "pcm_s16le", str(out_wav)]


def build_resample_cmd(src, out_wav, sr: int) -> list:
    """Build a command that resamples a child output to the source sample rate. Stored Opus stems may decode at a different rate from the original, so normalize rates before comparing envelopes frame by frame."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(src), "-vn", "-ar", str(int(sr)), "-c:a", "pcm_s16le", str(out_wav)]


def build_detect_cmd(python, script, src, *, karaoke_out=None, dereverb_out=None,
                     model_dir=None, karaoke_model: str = "", dereverb_model: str = "",
                     device: str = "cpu") -> list:
    """The child invocation (`scripts/leadvocal/detect.py`).

    ONE child does both separations because they share a 1.6 GB venv and a model cache, and
    paying process startup and an import of torch twice for a job that runs once per song is
    waste. Either output may be omitted; the child then skips that stage."""
    cmd = [str(python), str(script), "-i", str(src), "--device", str(device)]
    if karaoke_out is not None:
        cmd += ["--karaoke-out", str(karaoke_out)]
        if karaoke_model:
            cmd += ["--karaoke-model", str(karaoke_model)]
    if dereverb_out is not None:
        cmd += ["--dereverb-out", str(dereverb_out)]
        if dereverb_model:
            cmd += ["--dereverb-model", str(dereverb_model)]
    if model_dir is not None:
        cmd += ["--model-dir", str(model_dir)]
    return cmd


def detect_env(base_env: dict, device: str) -> dict:
    """Build the child environment with either one GPU visible or all GPUs hidden. `audio-separator` does not accept an explicit device argument; it selects from what PyTorch and ONNX Runtime expose. Pin visibility to the requested device so the child does not choose a different card. The PyTorch de-reverb stage and ONNX detector may use different providers, so report the devices actually selected rather than inferring them from the parent."""
    env = dict(base_env)
    if str(device).startswith("cuda"):
        idx = str(device).split(":", 1)[1] if ":" in str(device) else "0"
        # The parent's cuda:N is relative to its own visibility list (see visible_device_index).
        from engine_process import visible_device_index
        idx = visible_device_index(idx, base_env)
        env["HIP_VISIBLE_DEVICES"] = idx
        env["CUDA_VISIBLE_DEVICES"] = idx
    else:
        # Use `-1` to hide GPUs from both runtimes. An empty visibility value can leave PyTorch reporting CUDA as available while exposing zero devices, causing a child to attempt GPU initialization with no visible card. An unset value exposes all cards rather than selecting CPU.
        env["HIP_VISIBLE_DEVICES"] = "-1"
        env["CUDA_VISIBLE_DEVICES"] = "-1"
    # Box convention, stated rather than inherited — `voiceswap._card_env` has set it explicitly
    # since 4.2 for the same reason. It IS already in `os.environ` here, because
    # `vocalis_server.py` setdefaults it before importing torch (measured there: 51.9 s default vs
    # 22.6 s FAST on gfx1201, and the searched-vs-heuristic gap is nil on this stack anyway) — but
    # relying on that makes this child's environment a property of who imported the server, and
    # `detect_env` is also reachable from a CLI run of scripts/leadvocal/detect.py. `setdefault`,
    # so an operator who sets it deliberately still wins. No-op on CUDA.
    env.setdefault("MIOPEN_FIND_MODE", "FAST")
    return env


def join_takes(clips: list, sr: int, gap_sec: float = 2.0, peak_dbfs: float = -0.25):
    """Several finished clips → ONE, with `gap_sec` of digital silence between them.

    🔴 **THE SILENCE IS THE FEATURE, NOT PADDING** — the same argument `cut_join` makes one
    function up, for the same downstream reason: **RVC slices a dataset at silence**, so each gap
    becomes a cut point and one joined file trains as the many separate takes it contains. That
    is what lets a singer's dataset be assembled from eight songs and handed over as a single
    clip. (`trim_audio.stitch_clip` records the identical rule.)

    Every input must already be at `sr` — resampling is the caller's job, and deliberately so:
    a stored stem is Opus, Opus is a 48 kHz codec, and joining a 48 kHz clip to a 44.1 kHz one
    without resampling yields audio that plays at the wrong speed. Silently. That trap has
    already been paid for once in this feature (§3.5's rate note) and it is not being re-armed
    here — the caller decodes everything to one rate through ffmpeg first.

    Channel counts are unified to the WIDEST input, because concatenate needs one shape and
    dropping a channel to satisfy it would throw away half of a stereo take."""
    arrays = [np.asarray(c, dtype=np.float32) for c in clips if np.asarray(c).size]
    if not arrays:
        return np.zeros(0, dtype=np.float32)
    ch = max((a.shape[1] if a.ndim > 1 else 1) for a in arrays)
    fixed = []
    for a in arrays:
        if ch > 1:
            a = np.repeat(a[:, None], ch, axis=1) if a.ndim == 1 else a
            if a.shape[1] < ch:
                a = np.repeat(a[:, :1], ch, axis=1)
        elif a.ndim > 1:
            a = a.mean(axis=1)
        fixed.append(a.astype(np.float32))
    gap_shape = (max(0, int(gap_sec * sr)),) + ((ch,) if ch > 1 else ())
    gap = np.zeros(gap_shape, dtype=np.float32)
    pieces = []
    for a in fixed:
        if pieces:
            pieces.append(gap)
        pieces.append(a)
    out = np.concatenate(pieces).astype(np.float32)
    peak = float(np.abs(out).max())
    if peak > 0.0:
        out *= (10.0 ** (peak_dbfs / 20.0)) / peak
    return out


def build_decode_at_cmd(src, out_wav, sr: int) -> list:
    """Any stored clip → plaintext WAV at EXACTLY `sr`. The joiner's input gate."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(src), "-vn", "-ar", str(int(sr)), "-c:a", "pcm_s16le", str(out_wav)]


def ffprobe_channels(path) -> int:
    """Channel count of an audio file, or 2 when it cannot be determined. Only used for logging —
    the cut reads the array's own shape, which cannot disagree with itself."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=channels", "-of", "csv=p=0:nk=1", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        return int((out.stdout or "").strip().splitlines()[0])
    # Catch only the expected ffprobe failures: missing executable or unreadable file (`OSError`), timeout (`SubprocessError`), empty output (`IndexError`), and nonnumeric output (`ValueError`). Do not catch `Exception`; that could hide `VaultAuthError` and turn an authentication failure into a misleading channel count.
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return 2


def read_wav(path) -> tuple:
    """`(samples, sr)` from a plaintext scratch WAV. Kept here so the job never imports soundfile
    directly and the tests have one seam to fake."""
    import soundfile as sf
    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    return data, int(sr)


def write_wav(path, x, sr: int) -> Path:
    """PCM_16 at the source rate — §5. **WAV, not Opus, and deliberately against the store's
    current rule.** The chain is already `vocals.opus` → decode → cut → training MP3; storing the
    lead as Opus inserts a SECOND lossy generation into the one file in this system that is a
    model's training input rather than something an ear plays back. ~10 MB is the price."""
    import soundfile as sf
    p = Path(path)
    sf.write(str(p), np.asarray(x, dtype=np.float32), int(sr), subtype="PCM_16")
    return p


# Try already-probed satellites with sufficient free VRAM first, then rotate among eligible local cards, and fall back to CPU. This keeps the route responsive to current capacity without assuming the remote device is always available.

#: The de-reverb model requires 1.9 GB at peak; its fixed-size segments make the requirement independent of song duration. Do not add another implicit margin: the same requirement is enforced by the satellite and checked by `tests/test_satellite_leadvocal.py`.
REQUIRED_VRAM_GB = 1.9


def route_lead(configured, *, satellites=(), local_cards=(), cursor: int = 0,
               required_gb: float = REQUIRED_VRAM_GB) -> tuple:
    """Choose a device for lead-vocal separation and return (device, reason). Use already-probed satellite candidates first, then rotate among local cards, then fall back to CPU. Honor an explicit leadvocal_device override without second-guessing it."""
    want = str(configured or "auto").strip() or "auto"
    if want != "auto":
        return want, f"leadvocal_device is set to {want}"

    for s in satellites:
        if not s.get("ok"):
            continue
        free = s.get("free_gb")
        if free is None:                    # a satellite that cannot answer is not a candidate
            continue
        if float(free) >= float(required_gb):
            return str(s["device"]), (f"{s['device']} has {float(free):.1f} GB free, over the "
                                      f"{required_gb} GB this chain needs — and it is ~3.5x "
                                      f"faster than a card here")

    cards = [str(c) for c in local_cards]
    if cards:
        pick = cards[int(cursor) % len(cards)]
        return pick, f"no satellite had room — taking {pick} of {len(cards)} here in turn"
    return "cpu", "no card is available — running on the CPU"


def satellite_candidates(devices, probe) -> list:
    """Convert configured satellite device names into route_lead candidates by querying free VRAM. A failed probe makes that device unavailable and allows routing to continue on local cards or CPU."""
    out = []
    for dev in devices:
        try:
            d = probe(dev) or {}
            out.append({"device": dev, "free_gb": d.get("free_gb"),
                        "ok": bool(d.get("ok", True)), "note": d.get("note", "")})
        except Exception as exc:                                # noqa: BLE001
            out.append({"device": dev, "free_gb": None, "ok": False, "note": str(exc)})
    return out


def detect_script_sha(script) -> str:
    """Return the first 16 hex characters of the detector script SHA-256, or an empty string if the file is missing. Normalize newlines before hashing so identical scripts copied across operating systems produce the same drift-check value."""
    try:
        return hashlib.sha256(
            Path(script).read_bytes().replace(b"\r\n", b"\n")).hexdigest()[:16]
    except OSError:
        return ""
