#!/usr/bin/env python3
"""Run the resemble-enhance denoiser as a standalone child process.

Use this fallback when noise is diffuse or a clip is too short to trim. It reuses the existing
enhancement environment and runs only `inf.denoise()`; bandwidth extension remains a separate
operation. `--wet` mixes denoised audio with the original, and `--wet-sweep` creates several mixes
from one pass. The caller supplies opaque scratch paths and owns vault staging and encryption.
"""
import argparse
import sys
import time
from pathlib import Path

import numpy as np

# The three resemble-enhance install shims (deepspeed stub, numpy-2 fsolve patch, weights
# fetch) live ONCE, in enhance_audio.py, and are imported here rather than copied -- they
# are version-sensitive workarounds that "must not drift" (that file's docstring), and two
# copies is exactly how they would. denoise and enhance are the same package, same import
# stack, same weights checkpoint, so the shims are literally the same code. Importing this
# module runs only stdlib at its top level (soundfile/torch/resemble_enhance are imported
# inside its main()), so this is cheap and side-effect-free.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "enhance"))
try:
    from enhance_audio import _shim_deepspeed, _patch_numpy2, _weights_dir
except Exception:  # pragma: no cover - only if the enhance seam is missing entirely
    _shim_deepspeed = _patch_numpy2 = _weights_dir = None


# ── pure logic (no torch) — the part worth unit-testing on any box ────────────

def parse_levels(spec: str) -> list:
    """A `--wet-sweep` spec ("1.0,0.7,0.4") to an ordered list of clamped strengths.

    Clamped to [0, 1] because a mix weight outside that range is a typo, not an intent;
    de-duplicated preserving order so "1,1,0.5" does not denoise-mix the same level twice;
    empty/garbage tokens are dropped rather than crashing a 90-minute run at the write step.
    """
    out = []
    for tok in str(spec or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            v = float(tok)
        except ValueError:
            continue
        v = min(1.0, max(0.0, v))
        if v not in out:
            out.append(v)
    return out


def dry_wet_mix(orig: np.ndarray, denoised: np.ndarray, wet: float) -> np.ndarray:
    """`wet`·denoised + (1-`wet`)·original, at the denoiser's sample rate.

    `wet` >= 1.0 short-circuits to the denoised signal untouched -- no truncation, no
    resample round-trip, so the fully-denoised output is bit-for-bit what the model
    produced (the enhance path's output shape). Otherwise the two signals are aligned to
    the shorter length before mixing: the denoiser pads/reshapes internally, so `denoised`
    is not guaranteed to be exactly as long as a resample of `orig`, and a raw `+` on
    mismatched lengths would raise. A few samples of edge difference is inaudible; a
    ValueError mid-run is not.
    """
    if wet >= 1.0:
        return np.asarray(denoised, dtype=np.float32)
    o = np.asarray(orig, dtype=np.float32)
    d = np.asarray(denoised, dtype=np.float32)
    n = min(len(o), len(d))
    return (wet * d[:n] + (1.0 - wet) * o[:n]).astype(np.float32)


def wet_output_path(base: Path, wet: float) -> Path:
    """`out.wav` + level 0.7 -> `out.wet070.wav`. A stable, sortable, three-digit tag so a
    sweep's files line up in a directory listing and never collide (100 vs 070 vs 040)."""
    base = Path(base)
    return base.with_name(f"{base.stem}.wet{round(wet * 100):03d}{base.suffix}")


# ── the run (torch / resemble-enhance) ───────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Speech denoise, one file (resemble-enhance).")
    ap.add_argument("-i", "--input", required=True, help="Input audio (any ffmpeg-readable).")
    ap.add_argument("-o", "--output", required=True,
                    help="Output WAV. With --wet-sweep this is the BASE name; each level "
                         "writes <stem>.wetNNN<suffix>.")
    ap.add_argument("--wet", type=float, default=1.0,
                    help="Dry/wet strength for the single output: 1.0 = fully denoised, "
                         "0.4 keeps 60%% of the original. Ignored when --wet-sweep is given.")
    ap.add_argument("--wet-sweep", default="",
                    help="Comma list of strengths, e.g. 1.0,0.7,0.4 -- denoise ONCE and "
                         "write one mixed clip per level (the PoC A/B set, §7).")
    ap.add_argument("--device", default="cuda:0",
                    help="Torch device. Under ROCm the R9700s are cuda:0 / cuda:1.")
    a = ap.parse_args()

    src = Path(a.input)
    if not src.is_file():
        print(f"ERROR: input not found: {src}", file=sys.stderr)
        return 2

    levels = parse_levels(a.wet_sweep) if a.wet_sweep else parse_levels(str(a.wet))
    if not levels:
        print(f"ERROR: no valid strength level in "
              f"{a.wet_sweep or a.wet!r}", file=sys.stderr)
        return 2

    if _shim_deepspeed is None:
        print("ERROR: could not import the enhance seam "
              "(scripts/enhance/enhance_audio.py). Run scripts/enhance/setup.sh first.",
              file=sys.stderr)
        return 2

    _shim_deepspeed()

    try:
        import soundfile as sf
        import torch
        import torchaudio
        import resemble_enhance.enhancer.inference as inf
    except Exception as e:  # pragma: no cover - install-time guidance
        print(f"ERROR: could not import the enhance stack ({e}).\n"
              f"Run scripts/enhance/setup.sh first.", file=sys.stderr)
        return 2

    _patch_numpy2()                     # harmless for denoise; needed if ever chained to enhance
    run_dir = _weights_dir()

    x, sr = sf.read(str(src), dtype="float32", always_2d=True)
    wav = torch.from_numpy(x.mean(1))   # mono; the model is 1-D only
    audio_s = len(wav) / float(sr or 1)

    # Pre-load and time the model on its own, exactly as enhance_audio.py does: denoise cost
    # is startup + rate·audio_seconds, and load_enhancer is @cache'd so inf.denoise() below
    # reuses this instance. One run of any length then measures both terms -- which is what a
    # future cleanup_rate.py (design §5) will fold in. Guarded: if the library moves this,
    # denoise still runs, we just lose that run's timing.
    load_s = 0.0
    try:
        t0 = time.perf_counter()
        inf.load_enhancer(run_dir, a.device)
        load_s = time.perf_counter() - t0
    except Exception as e:              # noqa: BLE001 - timing is not the job
        print(f"(could not pre-load the denoiser for timing: {e})", file=sys.stderr)

    t0 = time.perf_counter()
    out, out_sr = inf.denoise(wav, sr, a.device, run_dir=run_dir)
    compute_s = time.perf_counter() - t0

    denoised = out.cpu().numpy().astype(np.float32)

    # Only pay for the original's resample when a level actually blends it in. wet=1.0
    # (the common case) reads nothing from the original at all.
    orig_rs = None
    if any(v < 1.0 for v in levels):
        orig_rs = torchaudio.functional.resample(wav, sr, out_sr).cpu().numpy().astype(np.float32)

    single = not a.wet_sweep
    written = []
    for v in levels:
        y = dry_wet_mix(orig_rs if orig_rs is not None else denoised, denoised, v)
        dst = Path(a.output) if single else wet_output_path(a.output, v)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + ".part")     # never leave a half-written WAV behind
        try:
            sf.write(str(tmp), y, out_sr, format="WAV", subtype="PCM_16")
            tmp.replace(dst)
        finally:
            tmp.unlink(missing_ok=True)
        written.append((v, dst, len(y) / float(out_sr)))

    # Machine-readable timing. The three numeric fields match enhance_audio.py's line
    # exactly, so a future cleanup_rate parent parses them the same way (enhance_rate.
    # parse_timing does float() on every token, so nothing non-numeric may ride this line --
    # there is no nfe because the denoiser has no step count; "denoise" is on the human line
    # below). load_s=0 means the pre-load was refused (compute_s then still holds the model
    # load) -- an unmeasured box says "no estimate", it does not guess.
    print(f"VOCALIS_TIMING audio_s={audio_s:.3f} load_s={load_s:.3f} "
          f"compute_s={compute_s:.3f}")
    print(f"denoise: {sr} Hz -> {out_sr} Hz | {audio_s:.1f}s in")
    for v, dst, dur in written:
        print(f"  wet={v:.2f}  {dur:.1f}s  {dst.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
