"""Tests for voice ingest + per-voice settings (voice_utils, 2.0-M6)."""
from shutil import which

import pytest

import voice_utils
from tts_utils import save_wav_sf, load_wav   # portable WAV I/O (torchaudio.save unusable on ROCm)


def _have_ffmpeg():
    return which("ffmpeg")


# ── per-voice settings (no ffmpeg needed) ─────────────────────────────────────

def test_get_settings_defaults_for_unknown_voice(tmp_path):
    s = voice_utils.get_settings(tmp_path / "voice_settings.yaml", "Nope.wav")
    assert "engine" not in s and s["exaggeration"] == 0.5   # engine left the wire (3.x)
    assert "advanced" in s and s["advanced"]["top_k"] == 1000


def test_save_and_reload_settings_merges(tmp_path):
    sp = tmp_path / "voice_settings.yaml"
    voice_utils.save_settings(sp, "Narrator_2.wav", {"exaggeration": 0.7, "engine": "turbo"})   # engine: stale key, ignored
    s = voice_utils.get_settings(sp, "Narrator_2.wav")
    assert s["exaggeration"] == 0.7 and "engine" not in s
    assert s["cfg"] == 0.5           # untouched default preserved
    # a second voice keeps its own entry
    voice_utils.save_settings(sp, "Other.wav", {"temperature": 0.9})
    assert voice_utils.get_settings(sp, "Narrator_2.wav")["exaggeration"] == 0.7
    assert voice_utils.get_settings(sp, "Other.wav")["temperature"] == 0.9


# ── AC11: transcode + peak-normalize to -1 dBFS ───────────────────────────────

@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg required")
def test_transcode_normalize_reaches_minus1_dbfs(tmp_path):
    import torch
    # input WAV peaked at 0.5 == -6.02 dBFS
    src = tmp_path / "in.wav"
    sig = torch.zeros(1, 24000); sig[0, ::2] = 0.5
    save_wav_sf(str(src), sig, 24000)
    assert voice_utils.peak_dbfs(src) < -5.0        # quiet input

    dst = tmp_path / "out.wav"
    voice_utils.transcode_normalize(src, dst)
    peak = voice_utils.peak_dbfs(dst)
    assert abs(peak - (-1.0)) < 0.3, f"expected ~-1 dBFS, got {peak}"


@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg required")
def test_transcode_normalize_outputs_wav(tmp_path):
    import torch
    src = tmp_path / "in.wav"
    save_wav_sf(str(src), torch.zeros(1, 12000) + 0.3, 24000)
    dst = tmp_path / "out.wav"
    voice_utils.transcode_normalize(src, dst)
    assert load_wav(dst)[0].shape[-1] > 0        # a valid, decodable WAV
