#!/usr/bin/env python3
"""Extract speech and sound-event scores for the cleanup pipeline.

This one-shot child loads Silero VAD and PANNs CNN14 in its isolated environment, then writes raw
segments and per-window scores as JSON. The parent combines them with the in-process SNR score and
user-selected thresholds. Torch is imported in `main()` so the pure reduction helpers remain
importable without the model environment.
"""
import argparse
import csv
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

VAD_SR = 16000                  # Silero VAD's native rate
PANNS_SR = 32000                # PANNs CNN14's native rate
PANNS_CHECKPOINT_BYTES = 1_365_409_299
PANNS_LABELS_FILE = "class_labels_indices.csv"
PANNS_LABELS_HEADER = ["index", "mid", "display_name"]
PANNS_LABELS_COUNT = 527
PANNS_CHECKPOINT_FILE = "Cnn14_mAP=0.431.pth"
DEFAULT_HOP_S = 1.0             # tagger window stride; also the window length (non-overlapping)
_INFER_BATCH = 32               # windows per PANNs forward pass -- bounds CPU memory on long files

# AudioSet leaf-class name fragments that count as "music or a sound effect" -- the signal the
# noise-floor scorer cannot see. Substring, case-insensitive. Deliberately generous: a region is
# only DROPPED when this ALSO clears a threshold the ear picks in the §2.3 sweep, so a few loose
# matches here cost nothing; a MISS (real SFX not listed) is the expensive error. Tune by ear.
MUSIC_SFX_KEYWORDS = (
    "music", "instrument", "guitar", "piano", "drum", "violin", "cello", "trumpet",
    "saxophone", "flute", "clarinet", "banjo", "mandolin", "harp", "organ", "accordion",
    "synthesizer", "orchestra", "choir", "singing", "song", "melody", "harmony", "bass",
    "percussion", "cymbal", "gong", "bell", "chime",
    "sound effect", "explosion", "gunshot", "gunfire", "artillery", "machine gun",
    "fusillade", "boom", "bang", "crash", "smash", "glass", "alarm", "siren", "beep",
    "bleep", "whoosh", "swoosh", "whip", "engine", "vehicle", "motor", "helicopter",
    "aircraft", "thunder", "wind",
)
# Fragments that count as SPEECH -- the signal we want to KEEP. (Silero VAD is the primary
# speech gate; this tagger "speech" score is a corroborating second opinion for the review.)
SPEECH_KEYWORDS = ("speech", "narration", "conversation", "monologue")


# ── pure reduction helpers (numpy/stdlib only — the unit-testable part) ───────

def keyword_indices(labels: list, keywords) -> list:
    """Indices of `labels` whose (lowercased) name contains any of `keywords`. The bridge from
    527 flat AudioSet classes to the two scores we care about, kept pure so a fake label list
    tests it without torch."""
    kws = tuple(k.lower() for k in keywords)
    out = []
    for i, name in enumerate(labels):
        low = str(name).lower()
        if any(k in low for k in kws):
            out.append(i)
    return out


def reduce_window(probs: np.ndarray, music_idx: list, speech_idx: list,
                  labels: list, topk: int = 3) -> dict:
    """One window's 527 class probabilities → the compact record cleanup.py consumes: the peak
    music/SFX probability, the peak speech probability, and the top-k (label, prob) for review."""
    probs = np.asarray(probs, dtype=np.float64)
    music_sfx = float(probs[music_idx].max()) if music_idx else 0.0
    speech = float(probs[speech_idx].max()) if speech_idx else 0.0
    order = np.argsort(probs)[::-1][:max(0, topk)]
    top = [[str(labels[i]), round(float(probs[i]), 4)] for i in order]
    return {"speech": round(speech, 4), "music_sfx": round(music_sfx, 4), "top": top}


def window_starts(n_samples: int, win: int, hop: int) -> list:
    """Start sample indices of the non-overlapping (hop==win) analysis windows covering
    `n_samples`. A final partial window is included (padded by the caller) so the tail of the
    file is never silently dropped."""
    if n_samples <= 0 or win <= 0 or hop <= 0:
        return []
    starts = list(range(0, n_samples, hop))
    return starts or [0]


def local_model_input_error(checkpoint: Path, labels_path: Path) -> str | None:
    """Validate the two pinned local inputs before importing PANNs, which reads labels at import."""
    checkpoint = Path(checkpoint)
    labels_path = Path(labels_path)
    try:
        if not checkpoint.is_file():
            return f"Trim scorer checkpoint is missing: {checkpoint}"
        if checkpoint.stat().st_size != PANNS_CHECKPOINT_BYTES:
            return (f"Trim scorer checkpoint has an invalid size: {checkpoint} "
                    f"(expected {PANNS_CHECKPOINT_BYTES} bytes, got {checkpoint.stat().st_size})")
        with checkpoint.open("rb"):
            pass
    except OSError as exc:
        return f"Trim scorer checkpoint is unreadable: {checkpoint} ({exc})"

    if checkpoint.name != PANNS_CHECKPOINT_FILE or labels_path.name != PANNS_LABELS_FILE:
        return "Trim scorer inputs must use the pinned checkpoint and AudioSet label filenames."
    try:
        if checkpoint.parent.resolve() != labels_path.parent.resolve():
            return "Trim scorer checkpoint and AudioSet labels must share one model root."
        if not labels_path.is_file():
            return f"Trim scorer AudioSet labels are missing: {labels_path}"
        data = labels_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        return f"Trim scorer AudioSet labels are unreadable: {labels_path} ({exc})"

    try:
        rows = list(csv.reader(io.StringIO(data, newline=""), strict=True))
    except csv.Error as exc:
        return f"Trim scorer AudioSet labels are invalid: {labels_path} ({exc})"
    if not rows or rows[0] != PANNS_LABELS_HEADER:
        return (f"Trim scorer AudioSet labels have an incompatible header: {labels_path} "
                f"(expected index, mid, display_name)")
    if len(rows) != PANNS_LABELS_COUNT + 1:
        return (f"Trim scorer AudioSet labels have an invalid row count: {labels_path} "
                f"(expected {PANNS_LABELS_COUNT}, got {max(0, len(rows) - 1)})")
    for index, row in enumerate(rows[1:]):
        if len(row) != 3 or row[0] != str(index) or not row[1] or not row[2]:
            return f"Trim scorer AudioSet labels have an invalid row at index {index}: {labels_path}"
    return None


# ── the model work (torch — lives inside main so the helpers import bare) ─────

def _atomic_write_json(dst: Path, payload: dict) -> None:
    """Write JSON via .part → replace, so a crash never leaves a half-written scores file that a
    later run would read as complete."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    try:
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(dst)
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Score a recording for Trim: Silero VAD + PANNs tagger.")
    ap.add_argument("-i", "--input", required=True, help="Input audio (soundfile-readable WAV/FLAC).")
    ap.add_argument("-o", "--output", required=True, help="Output scores JSON path.")
    ap.add_argument("--checkpoint", required=True,
                    help="Path to the preinstalled PANNs CNN14 checkpoint; never downloaded here.")
    ap.add_argument("--labels", required=True,
                    help="Path to the preinstalled AudioSet class labels CSV in the same model root.")
    ap.add_argument("--hop-s", type=float, default=DEFAULT_HOP_S,
                    help="Tagger window stride in seconds (also the window length). Default 1.0.")
    ap.add_argument("--device", default="cpu",
                    help="Torch device. Default cpu — the scorer runs once per file and stays "
                         "off the cards, so it never fights a render/training for a GPU (§2.3).")
    a = ap.parse_args()

    src = Path(a.input)
    if not src.is_file():
        print(f"ERROR: input not found: {src}", file=sys.stderr)
        return 2
    checkpoint = Path(a.checkpoint)
    labels_path = Path(a.labels)
    input_error = local_model_input_error(checkpoint, labels_path)
    if input_error:
        print(f"ERROR: {input_error}", file=sys.stderr)
        return 2
    os.environ["VOCALIS_TRIM_MODEL_ROOT"] = str(checkpoint.parent.resolve())

    try:
        import soundfile as sf
        import torch
        import torchaudio
        from silero_vad import load_silero_vad, get_speech_timestamps
        from panns_inference import AudioTagging
        try:
            from panns_inference.config import labels as PANNS_LABELS
        except Exception:                                    # pragma: no cover - version drift
            from panns_inference import labels as PANNS_LABELS
    except Exception as e:                                   # pragma: no cover - install guidance
        print(f"ERROR: could not import the Trim scorer toolchain ({e}).\n"
              f"Run scripts/cleanup/setup_trim.sh first.", file=sys.stderr)
        return 2

    # Load both models FIRST and time it on its own, exactly as the denoise child does: cost is
    # startup + rate·audio_seconds, and timing the load separately is the only way to split them.
    load_s = 0.0
    try:
        t0 = time.perf_counter()
        vad = load_silero_vad()
        tagger = AudioTagging(checkpoint_path=str(checkpoint), device=a.device)
        load_s = time.perf_counter() - t0
    except Exception as e:                                   # pragma: no cover - runtime guidance
        print(f"ERROR: could not load the Trim scorer models ({e}).", file=sys.stderr)
        return 2

    # Read mono. soundfile can't read MP3 — the caller (cleanup.py) decodes to WAV first, the
    # same contract the denoise child relies on.
    x, sr_in = sf.read(str(src), dtype="float32", always_2d=True)
    mono = torch.from_numpy(x.mean(1))
    duration_s = float(mono.shape[-1]) / float(sr_in or 1)

    t0 = time.perf_counter()

    # ── Silero VAD → speech segments (seconds) ──
    wav16 = torchaudio.functional.resample(mono, sr_in, VAD_SR) if sr_in != VAD_SR else mono
    ts = get_speech_timestamps(wav16, vad, sampling_rate=VAD_SR, return_seconds=True)
    segments = [[round(float(t["start"]), 3), round(float(t["end"]), 3)] for t in ts]

    # ── PANNs tagger → per-window music/SFX + speech scores ──
    wav32 = torchaudio.functional.resample(mono, sr_in, PANNS_SR) if sr_in != PANNS_SR else mono
    audio = wav32.detach().cpu().numpy().astype(np.float32)
    win = max(1, int(round(a.hop_s * PANNS_SR)))
    starts = window_starts(len(audio), win, win)
    music_idx = keyword_indices(PANNS_LABELS, MUSIC_SFX_KEYWORDS)
    speech_idx = keyword_indices(PANNS_LABELS, SPEECH_KEYWORDS)

    windows = []
    for base in range(0, len(starts), _INFER_BATCH):
        chunk = starts[base:base + _INFER_BATCH]
        batch = np.zeros((len(chunk), win), dtype=np.float32)
        for r, s0 in enumerate(chunk):
            seg = audio[s0:s0 + win]
            batch[r, :len(seg)] = seg                        # last window zero-padded to win
        clipwise, _ = tagger.inference(batch)                # (N, 527)
        for r, s0 in enumerate(chunk):
            rec = reduce_window(clipwise[r], music_idx, speech_idx, PANNS_LABELS)
            rec["t"] = round(s0 / float(PANNS_SR), 3)
            windows.append(rec)

    compute_s = time.perf_counter() - t0

    payload = {
        "schema": "vocalis.trim_scores/1",
        "sr_in": int(sr_in),
        "duration_s": round(duration_s, 3),
        "vad": {"model": "silero-vad", "segments": segments},
        "tagger": {"model": "panns-cnn14", "hop_s": float(a.hop_s), "win_s": float(a.hop_s),
                   "windows": windows},
    }
    _atomic_write_json(Path(a.output), payload)

    # Machine-readable timing, same three fields the denoise child prints (cleanup_rate.parse_timing
    # float()s every token — nothing non-numeric may ride this line).
    print(f"VOCALIS_TIMING audio_s={duration_s:.3f} load_s={load_s:.3f} compute_s={compute_s:.3f}")
    print(f"trim-scores: {sr_in} Hz | {duration_s:.1f}s | {len(segments)} speech segments | "
          f"{len(windows)} tagger windows -> {Path(a.output).name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
