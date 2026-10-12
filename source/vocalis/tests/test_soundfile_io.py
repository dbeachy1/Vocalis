"""Tests for the soundfile WAV I/O helpers (tts_utils.save_wav_sf / load_wav).

On the ROCm stack torchaudio.save routes through torchcodec (absent), so writes go
through soundfile instead. These verify the helper round-trips shape, sample rate,
and samples — and that it handles a BytesIO target and a bf16 tensor (autocast
output that numpy can't represent directly)."""
import io

import torch

from tts_utils import save_wav_sf, load_wav


def test_save_load_round_trips_mono(tmp_path):
    """(1, N) tensor -> WAV -> (1, N) tensor, sr preserved, samples close."""
    sr = 24000
    wav = torch.sin(torch.linspace(0, 6.28 * 40, sr)).unsqueeze(0)   # (1, N)
    p = tmp_path / "tone.wav"
    save_wav_sf(str(p), wav, sr)
    assert p.exists() and p.stat().st_size > 44          # more than a bare header

    loaded, got_sr = load_wav(p)
    assert got_sr == sr
    assert loaded.shape == (1, sr)                        # (channels, frames) preserved
    assert torch.allclose(loaded, wav, atol=1e-3)         # PCM_16 quantization tolerance


def test_save_to_bytesio_buffer():
    """save_wav_sf must accept a file-like buffer (HTTP streaming path)."""
    sr = 24000
    wav = torch.zeros(1, sr)
    buf = io.BytesIO()
    save_wav_sf(buf, wav, sr)
    assert buf.tell() > 44                                # bytes were written
    buf.seek(0)
    assert buf.read(4) == b"RIFF"                         # a real WAV container


def test_save_handles_bf16_tensor(tmp_path):
    """An autocast bf16 output tensor must save without a numpy dtype error
    (save_wav_sf casts to fp32 first)."""
    sr = 24000
    wav = torch.zeros(1, sr, dtype=torch.bfloat16)
    p = tmp_path / "bf16.wav"
    save_wav_sf(str(p), wav, sr)                          # must not raise
    loaded, got_sr = load_wav(p)
    assert got_sr == sr and loaded.shape == (1, sr)
