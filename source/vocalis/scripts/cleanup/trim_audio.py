#!/usr/bin/env python3
"""Select clean speech regions from one audio file.

This standalone CPU-capable child uses an energy gate to identify speech and compares each
region's inter-word noise floor with the file's quietest regions. `--sweep` tests several excess
thresholds; `--max-excess-db` selects one. Output is one WAV per contiguous kept take. The caller
owns scratch staging and any vault access. This SNR-based method detects broadband noise, not
music or sound effects; `trim_scores.py` provides those additional signals.
"""
import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

FRAME_MS = 20.0                 # analysis frame; ~20 ms is standard for speech energy
GLOBAL_FLOOR_PCT = 5.0          # the file's pristine quiet = a low percentile of ALL frames
REGION_GAP_PCT = 20.0           # a region's OWN background = a low percentile of ITS frames
SPEECH_MARGIN_DB = 12.0         # a frame is "active" if it sits this far above the global floor
MIN_REGION_S = 0.40             # drop blips shorter than this -- not a usable training take
MERGE_GAP_S = 0.30             # bridge inter-word silences shorter than this within a region
MAX_STITCH_GAP_S = 1.0          # kept regions closer than this join into one take; wider = split
CROSSFADE_MS = 20.0             # click-free joins when a take stitches across a dropped gap
SILENCE_GATE_DB = -120.0        # below this is DIGITAL silence (edited/padded), not background
_EPS = 1e-10

# 4.4-m3 (§2.3): a region's music/SFX score is this percentile of the tagger windows inside it --
# robust to one spurious window, but high for a stretch that is genuinely music/SFX.
MUSIC_AGG_PCT = 75.0
# 4.4-m3 (§4): the survivors are joined into ONE clip separated by this much silence, with tiny
# fades (NOT a hard crossfade) at each boundary. RVC slices training audio at silence, so these
# pauses become its cut points -- one stitched file trains as the many clean takes it contains.
STITCH_PAUSE_MS = 250.0
STITCH_FADE_MS = 12.0


# ── pure DSP / decision logic (numpy only — the part worth unit-testing) ──────

def parse_thresholds(spec: str) -> list:
    """A `--sweep` spec ("3,6,9,12") to an ordered list of dB thresholds. Non-numeric and
    empty tokens dropped (a typo must not crash a 90-minute run); de-duped, order kept."""
    out = []
    for tok in str(spec or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            v = float(tok)
        except ValueError:
            continue
        if v not in out:
            out.append(v)
    return out


def frame_rms_db(x: np.ndarray, sr: int, frame_ms: float = FRAME_MS) -> np.ndarray:
    """Per-frame RMS in dBFS, over non-overlapping `frame_ms` frames. The envelope every
    downstream measure reads. Silence floors at ~-200 dB via _EPS rather than -inf, so
    percentiles stay finite."""
    n = max(1, int(sr * frame_ms / 1000.0))
    frames = len(x) // n
    if frames < 1:
        return np.array([20 * np.log10(np.sqrt((x.astype(np.float64) ** 2).mean() + _EPS))]) \
            if len(x) else np.array([])
    trimmed = x[:frames * n].astype(np.float64).reshape(frames, n)
    rms = np.sqrt((trimmed ** 2).mean(axis=1))
    return 20 * np.log10(rms + _EPS)


def global_floor_db(rms_db: np.ndarray, pct: float = GLOBAL_FLOOR_PCT) -> float:
    """The file's pristine background: a low percentile of its real quiet frames.

    In a mostly-clean recording the quietest inter-word gaps ARE the clean baseline. Two
    outliers are excluded first: true digital-silence frames (edited/padded leading and
    trailing zeros, below SILENCE_GATE_DB) are dropped, because they carry no background to
    measure and a lone -200 dB frame drags even the 5th percentile down (percentile still
    interpolates against it); and a percentile rather than the min shrugs off the rest. If a
    file is nothing BUT digital silence, there is no real floor and we fall back to the raw
    percentile rather than invent one.
    """
    if rms_db.size == 0:
        return -120.0
    real = rms_db[rms_db > SILENCE_GATE_DB]
    src = real if real.size else rms_db
    return float(np.percentile(src, pct))


def speech_mask(rms_db: np.ndarray, floor_db: float,
                margin_db: float = SPEECH_MARGIN_DB) -> np.ndarray:
    """Frames carrying speech: those `margin_db` above the global floor. A plain energy gate
    (Silero VAD is the documented upgrade) — enough to bound the regions the scorer judges."""
    return rms_db > (floor_db + margin_db)


def mask_to_regions(mask: np.ndarray, frame_ms: float = FRAME_MS,
                    min_region_s: float = MIN_REGION_S,
                    merge_gap_s: float = MERGE_GAP_S) -> list:
    """Boolean speech mask → list of (start_frame, end_frame) regions (end exclusive).

    Short inter-word silences (< merge_gap_s) inside speech are bridged so one utterance is
    one region; regions shorter than min_region_s are dropped as unusable blips.
    """
    merge_frames = int(round(merge_gap_s * 1000.0 / frame_ms))
    min_frames = max(1, int(round(min_region_s * 1000.0 / frame_ms)))
    regions = []
    i, n = 0, len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i + 1
        while j < n:
            if mask[j]:
                j += 1
            else:
                # look ahead: a short gap inside speech is bridged, a long one ends the region
                k = j
                while k < n and not mask[k]:
                    k += 1
                if k - j <= merge_frames and k < n:
                    j = k
                else:
                    break
        if (j - i) >= min_frames:
            regions.append((i, j))
        i = j
    return regions


def region_noise_excess_db(region_rms_db: np.ndarray, floor_db: float,
                           gap_pct: float = REGION_GAP_PCT) -> float:
    """How much noisier THIS region's background is than the file's pristine quiet, in dB.

    A region's own background = a low percentile of its frames (its inter-word gaps). Clean
    region ⇒ its gaps ≈ the global floor ⇒ ~0. Speech-over-hiss ⇒ its gaps are lifted above
    the global floor ⇒ a positive excess. This is the whole cleanliness signal.
    """
    if region_rms_db.size == 0:
        return 0.0
    return float(np.percentile(region_rms_db, gap_pct)) - float(floor_db)


@dataclass
class Region:
    start_s: float
    end_s: float
    excess_db: float
    keep: bool
    music_sfx: float = 0.0      # 4.4-m3: aggregate PANNs music/SFX prob over the region, 0.0 when
                                # the torch scorer is absent (the SNR-only MVP path — no veto)

    @property
    def dur_s(self) -> float:
        return self.end_s - self.start_s


def score_regions(rms_db: np.ndarray, regions: list, floor_db: float,
                  max_excess_db: float, frame_ms: float = FRAME_MS,
                  music_scores: list = None, music_veto: float = float("inf")) -> list:
    """Attach a noise-excess score, an optional music/SFX score, and a keep/drop verdict to each
    (start_frame, end_frame).

    Kept iff BOTH hold: the region's background excess is within `max_excess_db` (the SNR-only MVP
    rule, §2.1 'when in doubt, drop it') AND its music/SFX score is within `music_veto` (the 4.4-m3
    tagger augment, §2.3 — the signal the noise floor is blind to). `music_scores`, when given, is
    one aggregate music/SFX probability per region, aligned with `regions`; absent (the MVP, no
    torch venv) every region reads 0.0, so the veto at any threshold ≥ 0 never fires and the
    SNR-only behavior is preserved exactly."""
    fs = frame_ms / 1000.0
    scored = []
    for i, (a, b) in enumerate(regions):
        excess = region_noise_excess_db(rms_db[a:b], floor_db)
        music = float(music_scores[i]) if music_scores is not None and i < len(music_scores) else 0.0
        keep = (excess <= max_excess_db) and (music <= music_veto)
        scored.append(Region(a * fs, b * fs, round(excess, 2), keep, round(music, 4)))
    return scored


# ── VAD segments + tagger windows → regions/scores (the 4.4-m3 §2.3 bridge) ───

def vad_segments_to_mask(segments: list, n_frames: int, frame_ms: float = FRAME_MS) -> np.ndarray:
    """A Silero-VAD segment list ([[start_s, end_s], ...], seconds) → a per-frame speech mask of
    length `n_frames`, on the same FRAME_MS grid the SNR envelope uses. So the trained speech
    boundaries feed mask_to_regions unchanged: gap-bridging and blip-drop are identical whether the
    mask came from the energy gate (the MVP) or from VAD (the m3 upgrade). Out-of-range segments
    are clamped, garbage entries skipped — a bad scorer line must not crash a long run."""
    n = max(0, int(n_frames))
    mask = np.zeros(n, dtype=bool)
    if n == 0:
        return mask
    fs = frame_ms / 1000.0
    for seg in segments or []:
        try:
            s0, s1 = float(seg[0]), float(seg[1])
        except (TypeError, ValueError, IndexError):
            continue
        a = max(0, min(n, int(round(s0 / fs))))
        b = max(0, min(n, int(round(s1 / fs))))
        if b > a:
            mask[a:b] = True
    return mask


def region_music_scores(regions: list, windows: list, frame_ms: float = FRAME_MS,
                        agg_pct: float = MUSIC_AGG_PCT) -> list:
    """One aggregate music/SFX probability per region, from the tagger windows that fall inside it.

    `regions` are (start_frame, end_frame); `windows` are the child's [{"t": sec, "music_sfx": p},
    ...]. A region's score is the `agg_pct` percentile of its overlapping windows' music_sfx —
    robust to a single spurious window, high for a genuinely musical stretch. A region no window
    covers (shorter than the hop, falling between window centers) borrows its NEAREST window, so a
    brief SFX blip is never scored 0 by an accident of the grid. All-zeros when there are no
    windows (⇒ the veto never fires — the SNR-only path)."""
    if not windows:
        return [0.0] * len(regions)
    ts = np.array([float(w.get("t", 0.0)) for w in windows], dtype=np.float64)
    ms = np.array([float(w.get("music_sfx", 0.0)) for w in windows], dtype=np.float64)
    fs = frame_ms / 1000.0
    out = []
    for (a, b) in regions:
        s0, s1 = a * fs, b * fs
        sel = ms[(ts >= s0) & (ts < s1)]
        if sel.size == 0:
            out.append(float(ms[int(np.argmin(np.abs(ts - (s0 + s1) / 2.0)))]))
        else:
            out.append(float(np.percentile(sel, agg_pct)))
    return out


def group_takes(regions: list, max_gap_s: float = MAX_STITCH_GAP_S) -> list:
    """Kept regions → takes. Consecutive kept regions separated by less than `max_gap_s`
    (only dropped silence between them) belong to one continuous take and are stitched; a
    wider gap — or a DROPPED noisy region between them — starts a new take, so we never
    splice across a real discontinuity (§2.1: distant takes make a bad training example)."""
    takes, cur = [], []
    prev_end = None
    prev_kept_adjacent = False
    for r in regions:
        if not r.keep:
            prev_kept_adjacent = False          # a dropped region breaks any run
            continue
        if (cur and prev_kept_adjacent and prev_end is not None
                and (r.start_s - prev_end) <= max_gap_s):
            cur.append(r)
        else:
            if cur:
                takes.append(cur)
            cur = [r]
        prev_end = r.end_s
        prev_kept_adjacent = True
    if cur:
        takes.append(cur)
    return takes


def summarize(regions: list) -> dict:
    """The §2.1 review, as numbers: minutes kept across N takes, minutes dropped across M
    flagged-noisy regions."""
    kept = [r for r in regions if r.keep]
    dropped = [r for r in regions if not r.keep]
    takes = group_takes(regions)
    return {
        "kept_s": sum(r.dur_s for r in kept),
        "dropped_s": sum(r.dur_s for r in dropped),
        "n_takes": len(takes),
        "n_dropped": len(dropped),
        "n_regions": len(regions),
    }


def stitch_clip(chunks: list, sr: int, pause_ms: float = STITCH_PAUSE_MS,
                fade_ms: float = STITCH_FADE_MS) -> np.ndarray:
    """Join kept-region chunks into ONE clip, each separated by `pause_ms` of silence, with a short
    fade at every edge (4.4-m3 §4).

    Unlike crossfade_concat — which BUTTS takes together click-free — this DELIBERATELY leaves a
    gap: RVC slices a training file at silence, so the inserted pauses become its cut points and one
    stitched clip trains as the many clean takes it contains (no 899-file explosion, no Frankenstein
    splice). Every chunk edge is faded, so the head, tail and each side of a pause are click-free."""
    chunks = [np.asarray(c, dtype=np.float32) for c in chunks if len(c)]
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    fade = max(0, int(sr * fade_ms / 1000.0))
    pause = np.zeros(max(0, int(sr * pause_ms / 1000.0)), dtype=np.float32)

    def _faded(c: np.ndarray) -> np.ndarray:
        c = c.copy()
        f = min(fade, len(c))
        if f > 0:
            c[:f] *= np.linspace(0.0, 1.0, f, dtype=np.float32)
            c[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32)
        return c

    out = [_faded(chunks[0])]
    for nxt in chunks[1:]:
        out.append(pause)
        out.append(_faded(nxt))
    return np.concatenate(out).astype(np.float32)


def crossfade_concat(chunks: list, sr: int, fade_ms: float = CROSSFADE_MS) -> np.ndarray:
    """Concatenate audio chunks with a short equal-power-ish linear crossfade at each join,
    so stitching two kept regions across a removed gap does not click. A single chunk is
    returned untouched."""
    chunks = [np.asarray(c, dtype=np.float32) for c in chunks if len(c)]
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    fade = max(1, int(sr * fade_ms / 1000.0))
    out = chunks[0]
    for nxt in chunks[1:]:
        f = min(fade, len(out), len(nxt))
        if f <= 0:
            out = np.concatenate([out, nxt])
            continue
        ramp = np.linspace(0.0, 1.0, f, dtype=np.float32)
        blended = out[-f:] * (1.0 - ramp) + nxt[:f] * ramp
        out = np.concatenate([out[:-f], blended, nxt[f:]])
    return out.astype(np.float32)


# ── ffmpeg decode (the one non-pure step) ────────────────────────────────────

def _probe_sample_rate(path: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate", "-of", "csv=p=0:nk=1", str(path)],
        capture_output=True, text=True, timeout=30)
    return int((out.stdout or "0").strip().splitlines()[0])


def decode_mono(path: Path, sr: int) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr),
         "-f", "f32le", "-"], capture_output=True, timeout=3600).stdout
    return np.frombuffer(raw, dtype=np.float32) if raw else np.zeros(0, dtype=np.float32)


def _fmt(sec: float) -> str:
    m, s = divmod(int(round(sec)), 60)
    return f"{m:d}:{s:02d}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Auto-curate clean speech from a noisy recording.")
    ap.add_argument("-i", "--input", required=True, help="Input audio (any ffmpeg-readable).")
    ap.add_argument("-o", "--output", default="",
                    help="Output base path; takes are written <base>.takeNN.wav. "
                         "Omitted or with --sweep, nothing is written (report only).")
    ap.add_argument("--max-excess-db", type=float, default=6.0,
                    help="Keep a region iff its background noise is within this many dB of "
                         "the file's cleanest background. Lower = more conservative (drop "
                         "more). The one tunable — pick it by ear with --sweep first.")
    ap.add_argument("--sweep", default="",
                    help="Comma list of thresholds, e.g. 3,6,9,12 — print minutes-kept for "
                         "each and write nothing, so you can pick a line before committing.")
    a = ap.parse_args()

    src = Path(a.input)
    if not src.is_file():
        print(f"ERROR: input not found: {src}", file=sys.stderr)
        return 2

    try:
        sr = _probe_sample_rate(src)
    except Exception as e:  # pragma: no cover - install/ffmpeg guidance
        print(f"ERROR: could not probe {src} ({e}). Is ffmpeg installed?", file=sys.stderr)
        return 2
    if sr <= 0:
        print(f"ERROR: no audio stream in {src}", file=sys.stderr)
        return 2

    x = decode_mono(src, sr)
    if x.size == 0:
        print(f"ERROR: decoded no audio from {src}", file=sys.stderr)
        return 2

    rms_db = frame_rms_db(x, sr)
    floor = global_floor_db(rms_db)
    regions = mask_to_regions(speech_mask(rms_db, floor))
    total_s = len(x) / float(sr)

    print(f"trim: {src.name} | {_fmt(total_s)} | {sr} Hz | "
          f"global floor {floor:.1f} dB | {len(regions)} speech regions")

    if not regions:
        print("  no speech regions found — nothing to trim.")
        return 0

    if a.sweep:
        thresholds = parse_thresholds(a.sweep)
        if not thresholds:
            print(f"ERROR: no valid threshold in {a.sweep!r}", file=sys.stderr)
            return 2
        print("\n  max-excess-db   kept        dropped     takes")
        for t in thresholds:
            s = summarize(score_regions(rms_db, regions, floor, t))
            print(f"  {t:>11.1f}    {_fmt(s['kept_s']):>6} ({s['n_takes']:>2} takes)  "
                  f"{_fmt(s['dropped_s']):>6} ({s['n_dropped']:>2})")
        print("\n  Pick a line, then re-run with --max-excess-db <n> -o <base> to write it.")
        return 0

    scored = score_regions(rms_db, regions, floor, a.max_excess_db)
    s = summarize(scored)
    print(f"\n  kept {_fmt(s['kept_s'])} across {s['n_takes']} takes · "
          f"dropped {_fmt(s['dropped_s'])} across {s['n_dropped']} noisy regions "
          f"(threshold {a.max_excess_db:.1f} dB)\n")
    for r in scored:
        mark = "keep" if r.keep else "DROP"
        print(f"  [{mark}] {_fmt(r.start_s)}–{_fmt(r.end_s)}  {r.dur_s:5.1f}s  "
              f"+{r.excess_db:5.1f} dB")

    if not a.output:
        print("\n  (report only — pass -o <base> to write the kept takes)")
        return 0

    import soundfile as sf
    takes = group_takes(scored)
    written = []
    for idx, take in enumerate(takes, 1):
        chunks = [x[int(r.start_s * sr):int(r.end_s * sr)] for r in take]
        audio = crossfade_concat(chunks, sr)
        dst = Path(f"{a.output}.take{idx:02d}.wav")
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + ".part")
        try:
            sf.write(str(tmp), audio, sr, format="WAV", subtype="PCM_16")
            tmp.replace(dst)
        finally:
            tmp.unlink(missing_ok=True)
        written.append((dst, len(audio) / float(sr)))
    print()
    for dst, dur in written:
        print(f"  wrote {_fmt(dur)}  {dst.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
