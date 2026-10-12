#!/usr/bin/env python3
"""Run DeepFilterNet3 speech denoising on one audio file.

This child receives input and output paths from its caller and does not access the vault; the
caller owns staging and encryption. `--wet` mixes denoised audio with the original, while
`--wet-sweep` writes several mixes from one denoiser pass. CPU is the default so cleanup does not
compete with GPU generation or training. Install the isolated environment with
`scripts/cleanup/setup_dfn.sh` (Python 3.11).
"""
import argparse
import sys
import time
from pathlib import Path

import numpy as np

# The dry/wet mix + sweep naming are pure numpy and shared with the resemble PoC -- one copy,
# imported, never duplicated (the enhance-shim discipline: "two copies is how they drift").
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _mix import parse_levels, dry_wet_mix, wet_output_path  # noqa: E402

DFN_CONFIG = "config.ini"
DFN_CHECKPOINT = Path("checkpoints/model_120.ckpt.best")


def local_model_error(model_root: Path) -> str | None:
    """Return a useful local-input error without reading model weights or importing DFN."""
    for relative in (Path(DFN_CONFIG), DFN_CHECKPOINT):
        path = model_root / relative
        try:
            with path.open("rb"):
                pass
        except OSError:
            return f"required local DFN3 file is missing or unreadable: {path}"
    return None


def parse_atten(raw) -> float:
    """`--atten` to a non-negative dB cap, or 0.0 for "no cap / full strength".

    DeepFilterNet reads atten_lim_db as "attenuate by at most this many dB"; None/0 means
    denoise fully, which won the ear test. A negative value is a typo, not an intent (you
    cannot cap attenuation below zero), so it clamps to 0 rather than crash a long run.
    """
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, v)


def main() -> int:
    ap = argparse.ArgumentParser(description="Speech denoise, one file (DeepFilterNet3).")
    ap.add_argument("-i", "--input", required=True, help="Input audio (any ffmpeg-readable).")
    ap.add_argument("-o", "--output", required=True,
                    help="Output WAV. With --wet-sweep this is the BASE name; each level "
                         "writes <stem>.wetNNN<suffix>.")
    ap.add_argument("--wet", type=float, default=1.0,
                    help="Dry/wet strength for the single output: 1.0 = fully denoised "
                         "(the ear-test winner), 0.4 keeps 60%% of the original. Ignored "
                         "when --wet-sweep is given.")
    ap.add_argument("--wet-sweep", default="",
                    help="Comma list of strengths, e.g. 1.0,0.7,0.4 -- denoise ONCE and "
                         "write one mixed clip per level (the PoC A/B set, §7).")
    ap.add_argument("--atten", type=float, default=0.0,
                    help="DeepFilterNet attenuation cap in dB (its own gentleness knob): "
                         "0 = denoise fully (default; won the ear test). A positive value "
                         "leaves that many dB of background in.")
    ap.add_argument("--device", default="cpu",
                    help="Torch device. Default cpu -- DeepFilterNet3 is real-time++ on CPU, "
                         "so cleanup never fights a render/training for a GPU (design §2.2).")
    ap.add_argument("--model-dir", required=True,
                    help="Local DeepFilterNet3 directory containing config.ini and checkpoint.")
    a = ap.parse_args()

    src = Path(a.input)
    if not src.is_file():
        print(f"ERROR: input not found: {src}", file=sys.stderr)
        return 2

    model_root = Path(a.model_dir).expanduser()
    model_error = local_model_error(model_root)
    if model_error:
        print(f"ERROR: {model_error}", file=sys.stderr)
        return 2

    levels = parse_levels(a.wet_sweep) if a.wet_sweep else parse_levels(str(a.wet))
    if not levels:
        print(f"ERROR: no valid strength level in "
              f"{a.wet_sweep or a.wet!r}", file=sys.stderr)
        return 2
    atten = parse_atten(a.atten)

    try:
        import soundfile as sf
        import torch
        from df.enhance import init_df, enhance as df_enhance
    except Exception as e:  # pragma: no cover - install-time guidance
        print(f"ERROR: could not import DeepFilterNet ({e}).\n"
              f"Run scripts/cleanup/setup_dfn.sh first.", file=sys.stderr)
        return 2

    # Load the model FIRST and time it on its own, exactly as enhance_audio.py does: denoise
    # cost is startup + rate·audio_seconds, and the ONLY way to split the two from a single
    # run of any length is to time the model load separately. load_s=0 tells the parent the
    # pre-load was refused, so it records nothing rather than charge the load into the rate.
    load_s = 0.0
    model = df_state = None
    try:
        t0 = time.perf_counter()
        model, df_state, _ = init_df(model_base_dir=str(model_root), log_file=None)
        if a.device != "cpu":
            model = model.to(a.device)
        load_s = time.perf_counter() - t0
    except Exception as e:  # pragma: no cover - install/runtime guidance
        print(f"ERROR: could not load DeepFilterNet3 ({e}).", file=sys.stderr)
        return 2

    model_sr = int(df_state.sr())               # DeepFilterNet3 works at 48 kHz

    # Read the source, downmix to mono (the model is single-channel), and resample to the
    # model's rate with torch so the dry side of the mix is at the same rate as the wet side.
    x, sr = sf.read(str(src), dtype="float32", always_2d=True)
    wav = torch.from_numpy(x.mean(1))           # mono
    if sr != model_sr:
        import torchaudio
        wav = torchaudio.functional.resample(wav, sr, model_sr)
    audio_s = wav.shape[-1] / float(model_sr or 1)
    audio_in = wav.unsqueeze(0).to(a.device)    # DeepFilterNet wants (channels, samples)

    t0 = time.perf_counter()
    # atten_lim_db=None means "no cap" -- the fully-denoised path the ear test chose.
    out = df_enhance(model, df_state, audio_in, atten_lim_db=(atten or None))
    compute_s = time.perf_counter() - t0

    denoised = out.squeeze(0).detach().cpu().numpy().astype(np.float32)

    # Only pay for the original when a level actually blends it in. wet=1.0 reads nothing
    # from it (the mix short-circuits to the denoised signal untouched).
    orig = None
    if any(v < 1.0 for v in levels):
        orig = wav.detach().cpu().numpy().astype(np.float32)

    single = not a.wet_sweep
    written = []
    for v in levels:
        y = dry_wet_mix(orig if orig is not None else denoised, denoised, v)
        dst = Path(a.output) if single else wet_output_path(a.output, v)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + ".part")     # never leave a half-written WAV behind
        try:
            sf.write(str(tmp), y, model_sr, format="WAV", subtype="PCM_16")
            tmp.replace(dst)
        finally:
            tmp.unlink(missing_ok=True)
        written.append((v, dst, len(y) / float(model_sr)))

    # Machine-readable timing. Three numeric fields, matching enhance_audio.py's line so a
    # cleanup_rate parent parses it the same way (cleanup_rate.parse_timing float()s every
    # token -- nothing non-numeric may ride this line; "denoise" is on the human line below).
    print(f"VOCALIS_TIMING audio_s={audio_s:.3f} load_s={load_s:.3f} "
          f"compute_s={compute_s:.3f}")
    print(f"denoise(dfn3): {sr} Hz -> {model_sr} Hz | {audio_s:.1f}s in | "
          f"atten={atten:.1f} dB")
    for v, dst, dur in written:
        print(f"  wet={v:.2f}  {dur:.1f}s  {dst.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
