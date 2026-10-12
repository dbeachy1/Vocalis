"""7.5.32 — measure concatenated audio with mixed sample rates.

The concat demuxer requires compatible stream parameters; the concat filter also needs per-input
resampling. A same-rate fixture misses both failure modes. This test creates 24 kHz WAV/MP3 and
48 kHz Opus inputs, then asserts the output duration to catch dropped chapters and rate errors.
Keep the fixture short because it invokes real encoders."""
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import book_state
import mp3_concat

FFMPEG = shutil.which("ffmpeg")
pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not installed")

#: Deliberately not round numbers, so an off-by-one chapter shows up in the total, and short
#: because the DURATION is the assertion — a longer fixture measures nothing extra.
#:
#: This test invokes real encoders, so keep its synthetic fixture short. The duration
#: tolerance catches the target failures without adding encoder work.
SECONDS = (1.5, 2.5, 3.5)


def _tone(path: Path, seconds: float, rate: int, codec: list):
    subprocess.run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={rate}:duration={seconds}",
         "-ac", "1", *codec, str(path)],
        check=True, capture_output=True)


def _duration(path: Path) -> float:
    r = subprocess.run(
        [shutil.which("ffprobe") or "ffprobe", "-v", "error", "-show_entries",
         "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True)
    return float(r.stdout.strip())


@pytest.fixture
def mixed_book(tmp_path):
    """A partially converted book: one Opus chapter (48 kHz) and WAV/MP3 chapters (24 kHz).

    This exercises the mixed-rate input contract."""
    d = tmp_path / "books" / "Mixed"
    (d / "mp3").mkdir(parents=True)
    _tone(d / "01 First.opus", SECONDS[0], 48000, ["-c:a", "libopus", "-b:a", "192k"])
    _tone(d / "02 Second.wav", SECONDS[1], 24000, ["-c:a", "pcm_s16le"])
    _tone(d / "mp3" / "03 Third.mp3", SECONDS[2], 24000, ["-c:a", "libmp3lame", "-b:a", "96k"])
    return d


def test_the_audiobook_is_as_long_as_the_chapters_it_was_built_from(mixed_book):
    """🔴 THE ASSERTION BOTH BUGS WOULD HAVE FAILED. Too short means chapters were dropped;
    too long means they were joined at the wrong rate. Only the duration catches both."""
    out = book_state.concat_book_opus(mixed_book, "Mixed")
    assert out.exists(), "no audiobook was produced"
    want = sum(SECONDS)
    got = _duration(out)
    assert abs(got - want) < 0.3, (
        f"the audiobook is {got:.1f}s from {want:.1f}s of chapters "
        f"({got / want:.2f}x) — chapters were dropped or joined at the wrong sample rate")


def test_the_result_is_really_opus_at_48k(mixed_book):
    """The container and the muxer have to agree, or players that are strict about it refuse
    a file that ffprobe reads happily."""
    out = book_state.concat_book_opus(mixed_book, "Mixed")
    r = subprocess.run(
        [shutil.which("ffprobe") or "ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,sample_rate", "-of", "csv=p=0", str(out)],
        capture_output=True, text=True)
    assert "opus" in r.stdout.lower(), r.stdout
    assert "48000" in r.stdout, r.stdout


@pytest.mark.parametrize(
    ("fmt", "extension", "codec", "container", "bitrate"),
    [("opus", ".opus", "opus", "ogg", 96),
     ("mp3", ".mp3", "mp3", "mp3", 160),
     ("aac", ".m4a", "aac", "mov", 128)],
)
def test_encoded_audiobooks_keep_the_complete_mixed_chapter_set(
        mixed_book, fmt, extension, codec, container, bitrate):
    """Every selected format re-encodes the master-first mixed set as mono at the chosen rate."""
    out = book_state.concat_book(mixed_book, "Mixed", fmt, f"{bitrate}k")
    assert out.suffix == extension
    assert abs(_duration(out) - sum(SECONDS)) < 0.3
    r = subprocess.run(
        [shutil.which("ffprobe") or "ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,channels,bit_rate", "-show_entries", "format=format_name",
         "-of", "default=nw=1", str(out)], capture_output=True, text=True)
    assert f"codec_name={codec}" in r.stdout, r.stdout
    assert f"format_name={container}" in r.stdout, r.stdout
    assert "channels=1" in r.stdout, r.stdout
    # MP3/AAC report their selected rates for this fixture. Opus uses VBR, so its average rate
    # can differ from the configured target on a short synthetic tone.
    if fmt != "opus":
        reported_bitrate = int(next(line.split("=", 1)[1] for line in r.stdout.splitlines()
                                    if line.startswith("bit_rate=")))
        assert abs(reported_bitrate - bitrate * 1000) <= 3000, r.stdout


def test_an_all_opus_book_stream_copies_and_keeps_its_length(tmp_path):
    """The stream-copy path, which is what a fully converted book takes on every rebuild.
    Same assertion — a stream copy that silently truncates is the first bug again."""
    d = tmp_path / "books" / "AllOpus"
    d.mkdir(parents=True)
    for i, secs in enumerate(SECONDS, 1):
        _tone(d / f"0{i} Ch.opus", secs, 48000, ["-c:a", "libopus", "-b:a", "192k"])
    out = book_state.concat_book_opus(d, "AllOpus")
    got = _duration(out)
    assert abs(got - sum(SECONDS)) < 0.3, f"{got:.1f}s from {sum(SECONDS):.1f}s of chapters"


def test_encoded_only_opus_chapters_concatenate_to_their_full_duration(tmp_path):
    """A reclaimed book has no masters; its finished Opus files in `mp3/` remain chapters."""
    d = tmp_path / "books" / "EncodedOnlyOpus"
    (d / "mp3").mkdir(parents=True)
    for i, secs in enumerate(SECONDS, 1):
        _tone(d / "mp3" / f"0{i} Ch.opus", secs, 48000,
              ["-c:a", "libopus", "-b:a", "192k"])

    out = book_state.concat_book_opus(d, "EncodedOnlyOpus")

    got = _duration(out)
    assert abs(got - sum(SECONDS)) < 0.3, (
        f"{got:.1f}s from {sum(SECONDS):.1f}s of encoded-only Opus chapters")


def test_a_plain_mp3_book_still_concatenates_to_its_own_length(tmp_path):
    """The unchanged stream-copy path for a pre-7.5.30 book, so this fix cannot regress it."""
    d = tmp_path / "books" / "OldBook"
    (d / "mp3").mkdir(parents=True)
    for i, secs in enumerate(SECONDS, 1):
        _tone(d / "mp3" / f"0{i} Ch.mp3", secs, 24000, ["-c:a", "libmp3lame", "-b:a", "96k"])
    out = book_state.concat_book_mp3(d, "OldBook")
    got = _duration(out)
    assert abs(got - sum(SECONDS)) < 0.3, f"{got:.1f}s from {sum(SECONDS):.1f}s of chapters"
