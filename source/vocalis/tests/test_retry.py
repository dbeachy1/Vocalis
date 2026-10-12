"""Tests for truncation retry and truncated-chunk purge logic."""
import torch
import pytest
from pathlib import Path

import tts_utils
from tts_utils import generate_with_retry, is_truncated_wav, save_wav_sf, _TOKEN_CAP, _S3_TOKEN_RATE

FAKE_SR       = 24000
TRUNC_SAMPLES = int(_TOKEN_CAP / _S3_TOKEN_RATE * FAKE_SR)  # 960000 = exactly 40 s


def _short_wav():
    return torch.zeros(1, FAKE_SR)   # 1 second — not truncated


def _trunc_wav():
    return torch.zeros(1, TRUNC_SAMPLES)  # 40 seconds — at hard cap


def _wav_at_tokens(tokens: int) -> torch.Tensor:
    samples = int(tokens / _S3_TOKEN_RATE * FAKE_SR)
    return torch.zeros(1, samples)


# ── is_truncated_wav unit tests ───────────────────────────────────────────────

def test_is_truncated_wav_at_cap(tmp_path):
    """Exactly 1000 tokens → truncated."""
    p = tmp_path / "trunc.wav"
    save_wav_sf(str(p), _wav_at_tokens(_TOKEN_CAP), FAKE_SR)
    assert is_truncated_wav(p) is True


def test_is_truncated_wav_one_under_cap(tmp_path):
    """999 tokens → not truncated (boundary: old -0.1s threshold falsely flagged this)."""
    p = tmp_path / "near.wav"
    save_wav_sf(str(p), _wav_at_tokens(_TOKEN_CAP - 1), FAKE_SR)
    assert is_truncated_wav(p) is False


def test_is_truncated_wav_short(tmp_path):
    """1-second clip → not truncated."""
    p = tmp_path / "short.wav"
    save_wav_sf(str(p), _short_wav(), FAKE_SR)
    assert is_truncated_wav(p) is False


def test_is_truncated_wav_missing_file(tmp_path):
    """Missing file → False (no exception raised)."""
    assert is_truncated_wav(tmp_path / "nonexistent.wav") is False


# ── generate_with_retry unit tests ────────────────────────────────────────────

def test_no_retry_when_not_truncated(monkeypatch):
    """No retry when the first generation succeeds without truncation."""
    calls = []

    def mock_generate_timed(chunk, fn, sr, label="", out=None):
        calls.append(chunk)
        return _short_wav(), len(chunk), 0.5, False

    monkeypatch.setattr(tts_utils, 'generate_timed', mock_generate_timed)
    wav, chars, dt, truncated = generate_with_retry(
        "Hello world.", lambda c: (lambda: None), FAKE_SR)

    assert not truncated
    assert len(calls) == 1


def test_retry_splits_and_regenerates(monkeypatch):
    """On truncation, re-splits and retries; returns concatenated non-truncated audio."""
    calls = []

    def mock_generate_timed(chunk, fn, sr, label="", out=None):
        calls.append(chunk)
        if len(calls) == 1:
            return _trunc_wav(), len(chunk), 16.0, True  # first call: truncated
        return _short_wav(), len(chunk), 0.5, False       # sub-chunks: fine

    monkeypatch.setattr(tts_utils, 'generate_timed', mock_generate_timed)

    text = "First sentence here. Second sentence also here."
    wav, chars, dt, truncated = generate_with_retry(
        text, lambda c: (lambda: None), FAKE_SR)

    assert not truncated
    assert len(calls) > 1
    assert wav.shape[-1] > 0


def test_retry_indivisible_succeeds_on_scratch_retry(monkeypatch):
    """Indivisible chunk that truncates on first attempt succeeds on scratch retry."""
    calls = []

    def mock_generate_timed(chunk, fn, sr, label="", out=None):
        calls.append(chunk)
        if len(calls) == 1:
            return _trunc_wav(), len(chunk), 16.0, True   # first attempt: truncated
        return _short_wav(), len(chunk), 8.0, False        # scratch retry: success

    monkeypatch.setattr(tts_utils, 'generate_timed', mock_generate_timed)

    wav, chars, dt, truncated = generate_with_retry(
        "Supercalifragilistic", lambda c: (lambda: None), FAKE_SR)

    assert not truncated           # scratch retry succeeded
    assert len(calls) == 2        # first attempt + one scratch retry


def test_retry_returns_truncated_if_indivisible_and_scratch_retry_fails(monkeypatch):
    """If the chunk is indivisible and both attempts truncate, accepts the truncation."""
    calls = []

    def mock_generate_timed(chunk, fn, sr, label="", out=None):
        calls.append(chunk)
        return _trunc_wav(), len(chunk), 16.0, True  # always truncated

    monkeypatch.setattr(tts_utils, 'generate_timed', mock_generate_timed)

    wav, chars, dt, truncated = generate_with_retry(
        "Supercalifragilistic", lambda c: (lambda: None), FAKE_SR)

    assert truncated               # both attempts failed — accepted
    assert len(calls) == 2        # first attempt + one scratch retry


# ── purge_truncated_chunks tests ──────────────────────────────────────────────

def test_purge_removes_truncated_chunk_and_section_wav(tmp_path):
    """Truncated chunk and section WAV are both deleted; valid chunk is kept."""
    from book_to_audio import purge_truncated_chunks

    section     = {'filename': 'ch_001', 'title': 'Chapter 1'}
    out_dir     = tmp_path / "out";   out_dir.mkdir()
    chunks_base = tmp_path / "chunks"
    chunks_dir  = chunks_base / "ch_001"; chunks_dir.mkdir(parents=True)

    trunc_chunk = chunks_dir / "chunk_0000.wav"
    good_chunk  = chunks_dir / "chunk_0001.wav"
    section_wav = out_dir    / "ch_001.wav"

    save_wav_sf(str(trunc_chunk), _trunc_wav(),  FAKE_SR)
    save_wav_sf(str(good_chunk),  _short_wav(),  FAKE_SR)
    save_wav_sf(str(section_wav), _short_wav(),  FAKE_SR)

    n = purge_truncated_chunks(section, out_dir, chunks_base)

    assert n == 1
    assert not trunc_chunk.exists()
    assert     good_chunk.exists()
    assert not section_wav.exists()


def test_purge_keeps_valid_chunks_and_section_wav(tmp_path):
    """No files are touched when no truncation is detected."""
    from book_to_audio import purge_truncated_chunks

    section     = {'filename': 'ch_002', 'title': 'Chapter 2'}
    out_dir     = tmp_path / "out";   out_dir.mkdir()
    chunks_base = tmp_path / "chunks"
    chunks_dir  = chunks_base / "ch_002"; chunks_dir.mkdir(parents=True)

    good_chunk  = chunks_dir / "chunk_0000.wav"
    section_wav = out_dir    / "ch_002.wav"

    save_wav_sf(str(good_chunk),  _short_wav(), FAKE_SR)
    save_wav_sf(str(section_wav), _short_wav(), FAKE_SR)

    n = purge_truncated_chunks(section, out_dir, chunks_base)

    assert n == 0
    assert good_chunk.exists()
    assert section_wav.exists()


def test_purge_no_op_when_chunks_dir_missing(tmp_path):
    """purge_truncated_chunks is a no-op when no chunks dir exists yet."""
    from book_to_audio import purge_truncated_chunks

    section     = {'filename': 'ch_003', 'title': 'Chapter 3'}
    out_dir     = tmp_path / "out";   out_dir.mkdir()
    chunks_base = tmp_path / "chunks"  # does not exist

    n = purge_truncated_chunks(section, out_dir, chunks_base)
    assert n == 0
