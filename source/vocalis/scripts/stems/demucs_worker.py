#!/usr/bin/env python3
"""Apply shared Torch startup policy, then delegate to Demucs.

Demucs itself runs unchanged. The one thing this file replaces is how its WAV stems are written,
and only when the installed torchaudio could not write them (see `install_wav_writer`).
"""
from __future__ import annotations

import importlib.util
import runpy
import sys
import wave
from pathlib import Path

SATELLITE_DIR = Path(__file__).resolve().parents[2] / "satellite"
sys.path.insert(0, str(SATELLITE_DIR))


def save_pcm16_wav(uri, src, sample_rate, channels_first=True, format=None, encoding=None,
                   bits_per_sample=None, **_ignored) -> None:
    """Write a float tensor as a 16-bit PCM WAV with the standard library.

    Takes the arguments Demucs passes to `torchaudio.save`. Vocalis always asks Demucs for its
    default output (16-bit signed WAV; `stems.build_demucs_cmd` passes no format flag), so that is
    the only form written here. Anything else is refused by name rather than written wrong.
    The scaling is the usual one for float to 16-bit: times 32768, rounded to the nearest step and
    clamped to the int16 range. (Rounded, not cut off: a bare cast to int16 drops the fraction
    toward zero, which doubles the quantization error and leaves a dead band around silence.)
    """
    import torch

    path = Path(str(uri))
    suffix = path.suffix.lower()
    if (format or suffix.lstrip(".")) != "wav" or encoding not in (None, "PCM_S") \
            or bits_per_sample not in (None, 16):
        raise RuntimeError(
            f"Stems can only write 16-bit WAV here (asked for {suffix or format}, "
            f"encoding {encoding}, {bits_per_sample} bits)")
    audio = src.detach().cpu()
    if audio.dim() == 1:
        audio = audio.unsqueeze(0)
    if not channels_first:
        audio = audio.t()
    channels = audio.shape[0]
    if audio.is_floating_point():
        audio = (audio.to(torch.float64) * 32768.0).round().clamp(-32768, 32767)
    frames = audio.to(torch.int16).t().contiguous().numpy().astype("<i2", copy=False)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(int(sample_rate))
        out.writeframes(frames.tobytes())


def needs_wav_writer() -> bool:
    """True when this torchaudio writes files through TorchCodec and TorchCodec is not installed.

    October 11, 2026: the first real Stems runs in the Docker images (NVIDIA on Windows, AMD on
    Linux) both split the whole song and then died writing the first stem: "TorchCodec is required
    for save_with_torchcodec". The images carry torchaudio 2.10, whose `save` hands everything to
    TorchCodec, and the stems environment has no TorchCodec. An older torchaudio (a standalone
    install) writes WAV itself and is left alone, as is any environment that does have TorchCodec.

    Both checks look for files only. Neither package is imported here, so this cannot change the
    order Torch is set up in before Demucs starts.
    """
    torchaudio_spec = importlib.util.find_spec("torchaudio")
    if torchaudio_spec is None or not torchaudio_spec.submodule_search_locations:
        return False
    routes_to_torchcodec = any((Path(folder) / "_torchcodec.py").is_file()
                               for folder in torchaudio_spec.submodule_search_locations)
    return routes_to_torchcodec and importlib.util.find_spec("torchcodec") is None


def install_wav_writer() -> bool:
    """Point `torchaudio.save` at `save_pcm16_wav` when torchaudio could not write. Demucs calls
    `torchaudio.save` by module attribute at write time, so replacing the attribute is enough."""
    if not needs_wav_writer():
        return False
    import torchaudio

    torchaudio.save = save_pcm16_wav
    print("[stems] torchaudio has no TorchCodec here; writing WAV stems directly", flush=True)
    return True


def main() -> None:
    """Configure the child process before the Demucs package imports Torch models."""
    import torch

    from vocalis_torch_backend import apply_rocm_miopen_policy

    apply_rocm_miopen_policy(torch)
    install_wav_writer()
    # run_module preserves the caller's CLI arguments and mirrors ``python -m demucs``.
    runpy.run_module("demucs", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
