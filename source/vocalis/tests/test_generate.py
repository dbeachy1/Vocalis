"""
Integration tests for generate.py — they need a LOCAL card, not just any render hardware.

Each test invokes generate.py as a subprocess (the real entry point) with a short text so
generation takes only a few seconds.

🔴 A satellite does not count HERE, unlike everywhere else `gpu_enabled` is used, and the
difference is a real limitation rather than caution. These shell out to `generate.py`, whose
`--gpus` goes through `parse_devices`, which understands only 'all' / 'cpu' / an index list —
it cannot name `test-satellite:cuda:0` (see `pool.resolve_devices`, which exists because that exact
mangling sent a Playground render to the CPU with the satellite idle and nothing saying the
word "cpu"). So on a satellite-only box these would not fail; they would quietly run on the
CPU, which is the outcome this test guards against. Skip honestly instead. Lifting this means
teaching the CLI a device LIST, not widening the gate.

"""
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT


def _has_local_cuda() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available() and torch.cuda.device_count() > 0)
    except Exception:                                   # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(
    not _has_local_cuda(),
    reason="generate.py cannot be pointed at a satellite (--gpus goes through parse_devices), "
           "so with no local card these would silently run on CPU")

SRC    = REPO_ROOT / "src"
PYTHON = sys.executable


def run_generate(args: list, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PYTHON, str(SRC / "generate.py")] + args,
        cwd=str(SRC), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )


def test_inline_text_produces_wav_and_mp3(gpu_enabled, tmp_path, voice):
    """Inline text → WAV + MP3, clean exit."""
    out_wav    = tmp_path / "out.wav"
    chunks_dir = tmp_path / "chunks"

    result = run_generate([
        "Hello, world.",
        "-o",            str(out_wav),
        "--voice",       voice,
        "--chunks-dir",  str(chunks_dir),
    ])
    assert result.returncode == 0, result.stderr

    assert out_wav.exists(), "Output WAV not created"
    assert out_wav.stat().st_size > 1000, "WAV suspiciously small"

    mp3_path = tmp_path / "mp3" / "out.mp3"
    assert mp3_path.exists(), "MP3 not created"
    assert mp3_path.stat().st_size > 500, "MP3 suspiciously small"


def test_file_input(gpu_enabled, tmp_path, voice):
    """--file input works the same as inline text."""
    txt_file   = tmp_path / "script.txt"
    out_wav    = tmp_path / "file_out.wav"
    chunks_dir = tmp_path / "chunks"

    txt_file.write_text("The quick brown fox jumps over the lazy dog.", encoding="utf-8")

    result = run_generate([
        "--file",       str(txt_file),
        "-o",           str(out_wav),
        "--voice",      voice,
        "--chunks-dir", str(chunks_dir),
    ])
    assert result.returncode == 0, result.stderr
    assert out_wav.exists()
    assert out_wav.stat().st_size > 1000


def test_chunks_kept_by_default(gpu_enabled, tmp_path, voice):
    """Chunk files are kept after concatenation by default."""
    out_wav    = tmp_path / "kept.wav"
    chunks_dir = tmp_path / "kept_chunks"

    result = run_generate([
        "Short text.",
        "-o",            str(out_wav),
        "--voice",       voice,
        "--chunks-dir",  str(chunks_dir),
    ])
    assert result.returncode == 0, result.stderr
    assert out_wav.exists()
    chunk_files = list(chunks_dir.glob("chunk_*.wav"))
    assert len(chunk_files) > 0, "Chunk files were deleted despite default keep behavior"


def test_delete_chunks_flag(gpu_enabled, tmp_path, voice):
    """--delete-chunks removes chunk files after concatenation."""
    out_wav    = tmp_path / "out.wav"
    chunks_dir = tmp_path / "del_chunks"

    result = run_generate([
        "Short text.",
        "-o",             str(out_wav),
        "--voice",        voice,
        "--chunks-dir",   str(chunks_dir),
        "--delete-chunks",
    ])
    assert result.returncode == 0, result.stderr
    assert out_wav.exists()
    assert not chunks_dir.exists(), "Chunk dir should be deleted with --delete-chunks"


def test_resume_skips_existing_chunks(gpu_enabled, tmp_path, voice):
    """
    Pre-populate chunk_0000.wav with a silent WAV.
    With only 1-chunk text, generate.py should skip all generation,
    concatenate the pre-existing chunk, and produce the output WAV.
    """
    import torch
    from tts_utils import save_wav_sf

    out_wav    = tmp_path / "resumed.wav"
    chunks_dir = tmp_path / "resume_chunks"
    chunks_dir.mkdir()

    # Create a silent 0.5-second WAV as the pre-existing chunk
    sr       = 24000
    fake_wav = torch.zeros(1, sr // 2)
    chunk0   = chunks_dir / "chunk_0000.wav"
    save_wav_sf(str(chunk0), fake_wav, sr)
    mtime_before = chunk0.stat().st_mtime

    result = run_generate([
        "Hello.",                 # short enough to be exactly 1 chunk
        "-o",            str(out_wav),
        "--voice",       voice,
        "--chunks-dir",  str(chunks_dir),
                                  # chunks kept by default — no flag needed
    ])
    assert result.returncode == 0, result.stderr
    assert out_wav.exists(), "Output WAV not produced after resume"

    # The pre-existing chunk must not have been touched
    assert chunk0.stat().st_mtime == mtime_before, "Chunk 0 was overwritten — resume broken"

    # output should mention resuming (loguru logs to stderr)
    assert "resume" in (result.stdout + result.stderr).lower(), \
        "Expected resume message in output"
