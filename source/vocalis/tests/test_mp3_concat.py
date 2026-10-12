"""The shared MP3 concat (6.0 §3.3) — and the five landmines it exists to hold in one place.

`concat_book_mp3` learned each of these separately and expensively. 6.0 adds a second caller
(an audio scene is a range of chat messages joined end to end), and the design's ruling is that
there must not be a second implementation:

> A second implementation will have four of the five, and the missing one will be silent.

"Silent" is the operative word and it is why these are asserted on the ARGV rather than on the
output file. Four of the five fail loudly the first time you run them — ffmpeg refuses, the test
goes red, you fix it. The fifth (the list landing on disk) produces a perfectly good MP3 and a
plaintext table of contents of the user's chat sitting in an output directory, and nothing
anywhere goes red. So it is watched at the filesystem, exactly as test_book_state.py watches it
for books.
"""
import subprocess
from pathlib import Path

import pytest

import book_state
import mp3_concat
from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)


def _have_ffmpeg():
    from shutil import which
    return which("ffmpeg") and which("ffprobe")


def _sine(path: Path, secs: float, freq: int = 440) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={secs}",
                    "-ac", "1", "-b:a", "96k", str(path), "-loglevel", "error"], check=True)
    return path


# ── the argv, asserted without ffmpeg ────────────────────────────────────────────────────

def _capture(monkeypatch):
    """Run concat_mp3 against a fake ffmpeg; return (argv, list_text)."""
    seen = {}

    def fake_run(argv, **kw):
        seen["argv"] = list(argv)
        seen["input"] = kw.get("input", "")
        # The caller writes the result through vault_fs.from_scratch, which needs the file
        # to exist. Nothing reads its contents.
        Path(argv[argv.index("-c") + 2]).write_bytes(b"\0")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(mp3_concat.subprocess, "run", fake_run)
    return seen


def test_the_argv_carries_every_ffmpeg_landmine(tmp_path, monkeypatch):
    """Landmines 1, 2 and 4 in one assertion set, because they are one mechanism: the list
    goes down `pipe:0`, which is what forces both `-protocol_whitelist file,pipe` and the
    `file:` prefix on every entry. Take any one of the three away and ffmpeg dies with
    "Impossible to open" — a failure whose message names neither the pipe nor the protocol."""
    seen = _capture(monkeypatch)
    srcs = [tmp_path / "a.mp3", tmp_path / "b.mp3"]
    for s in srcs:
        s.write_bytes(b"\0")

    mp3_concat.concat_mp3(srcs, tmp_path / "out.mp3", scratch_root=tmp_path / "scratch")

    argv = seen["argv"]
    assert argv[0] == "ffmpeg"
    assert argv[argv.index("-protocol_whitelist") + 1] == "file,pipe", (
        "the list arrives on a pipe and the entries are files — without BOTH protocols named, "
        "ffmpeg refuses the list it is being handed")
    assert "-i" in argv and argv[argv.index("-i") + 1] == "pipe:0", (
        "the concat list must be piped, never written to disk — 5.0 §8.1")
    assert argv[argv.index("-c") + 1] == "copy", (
        "a re-encode here would be lossy AND slow; every input is one profile by construction")

    lines = [ln for ln in seen["input"].splitlines() if ln.strip()]
    assert len(lines) == 2, f"one line per source, got {lines}"
    for ln in lines:
        assert ln.startswith("file 'file:"), (
            f"{ln!r} has no `file:` protocol prefix. The demuxer resolves each entry against "
            f"the protocol of the LIST, which is now `pipe`, so a bare path is opened as "
            f"pipe:/path/to/thing.mp3 and fails")


def test_the_sources_are_listed_in_the_order_given(tmp_path, monkeypatch):
    """A scene is a CONVERSATION. `sorted()` on hashed scratch names would be a plausible-
    looking way to build the list and would shuffle the messages, which is a bug you can only
    hear — the file plays, it is the right length, and the exchange makes no sense."""
    seen = _capture(monkeypatch)
    names = ["first.mp3", "second.mp3", "third.mp3"]
    for n in names:
        (tmp_path / n).write_bytes(b"\0")

    mp3_concat.concat_mp3([tmp_path / n for n in names], tmp_path / "out.mp3",
                          scratch_root=tmp_path / "scratch")

    lines = [ln for ln in seen["input"].splitlines() if ln.strip()]
    assert [Path(ln.split("file:", 1)[1].rstrip("'")).name for ln in lines] == names


def test_an_empty_list_raises_rather_than_writing_an_empty_file(tmp_path, monkeypatch):
    """ffmpeg with no inputs produces a zero-byte MP3 and exit 0 on some builds. A scene whose
    every message was unspeakable must fail loudly, not land a silent artifact in the library."""
    _capture(monkeypatch)
    with pytest.raises(FileNotFoundError):
        mp3_concat.concat_mp3([], tmp_path / "out.mp3", scratch_root=tmp_path / "scratch")


def test_a_failing_ffmpeg_raises_with_its_stderr(tmp_path, monkeypatch):
    def fake_run(argv, **kw):
        return subprocess.CompletedProcess(argv, 1, "", "Invalid data found when processing input")
    monkeypatch.setattr(mp3_concat.subprocess, "run", fake_run)
    (tmp_path / "a.mp3").write_bytes(b"\0")

    with pytest.raises(RuntimeError, match="Invalid data"):
        mp3_concat.concat_mp3([tmp_path / "a.mp3"], tmp_path / "out.mp3",
                              scratch_root=tmp_path / "scratch")


# ── landmine 3: the apostrophe ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,expect", [
    ("plain.mp3",          "'file:plain.mp3'"),
    ("Rock'n'Roll.mp3",    "'file:Rock'\\''n'\\''Roll.mp3'"),
])
def test_concat_quote_escapes_the_apostrophe(name, expect):
    """The demuxer wraps each name in single quotes, so a literal ' closes the string early and
    the rest of the filename becomes syntax. `'\\''` is the only spelling that survives."""
    assert mp3_concat.concat_quote(Path(name)) == expect


# ── landmine 5, and the real thing end to end ────────────────────────────────────────────

@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")
def test_it_really_joins_and_writes_no_list_file(tmp_path, monkeypatch):
    """The whole mechanism against real ffmpeg, plus the one landmine that fails SILENTLY.

    A concat list on disk is a machine-readable table of contents — of a book's chapters, or
    (6.0 §5.1) of who spoke in what order in a private chat. It used to be a real file whose
    unlink sat in a `finally`, so a kill mid-concat left it there indefinitely. Watched at the
    filesystem rather than in the source, so any future rewrite that puts it back under any
    name still fails this."""
    srcs = [_sine(tmp_path / "in" / "00_Intro.mp3", 1.0, 440),
            _sine(tmp_path / "in" / "01_Rock'n'Roll.mp3", 1.5, 660)]

    written = []
    real_write = Path.write_text
    monkeypatch.setattr(Path, "write_text",
                        lambda self, *a, **kw: (written.append(self.name),
                                                real_write(self, *a, **kw))[1])

    dest = mp3_concat.concat_mp3(srcs, tmp_path / "out" / "joined.mp3")

    assert dest.is_file() and dest.stat().st_size > 0
    assert written == [], f"the concat list was written to disk as {written}"
    from tts_utils import ffprobe_duration
    assert ffprobe_duration(dest) == pytest.approx(2.5, abs=0.3)


# ── and the reason the module exists at all ──────────────────────────────────────────────

def test_book_state_still_goes_through_the_shared_concat(tmp_path, monkeypatch):
    """🔴 THE LIFT, ASSERTED. §3.3's ruling is not "write a shared function", it is "have BOTH
    callers use it" — and the failure mode is not a crash, it is someone re-inlining ffmpeg
    into `concat_book_mp3` (or into the scene builder) and taking four of the five rules with
    them. Books keep their own tests for ordering and apostrophes; this one only cares that the
    ffmpeg half is reached through one door."""
    calls = []
    monkeypatch.setattr(mp3_concat, "concat_mp3",
                        lambda paths, dest, **kw: (calls.append((list(paths), dest)), dest)[1])

    mp3_dir = tmp_path / "mp3"
    mp3_dir.mkdir()
    for n in ("00_a.mp3", "01_b.mp3"):
        (mp3_dir / n).write_bytes(b"\0")

    out = book_state.concat_book_mp3(tmp_path, "mybook")

    assert len(calls) == 1, "concat_book_mp3 no longer delegates — see this test's docstring"
    paths, dest = calls[0]
    assert [p.name for p in paths] == ["00_a.mp3", "01_b.mp3"], "chapter order is the book's job"
    assert dest == out == tmp_path / "mybook_full.mp3"


# ── what a part contributes to a join (`contributed_s`) ──────────────────────────────────

def test_contributed_s_sums_the_packet_durations_and_skips_na(tmp_path, monkeypatch):
    """The parse, without ffmpeg: one `duration_time` per line, "N/A" ignored, and the argv asks
    ffprobe for PACKETS — never `format=duration`, which FFmpeg 8 trims for gapless metadata."""
    seen = {}

    def fake_run(argv, **kw):
        seen["argv"] = list(argv)
        return subprocess.CompletedProcess(argv, 0, "0.024000\n0.024000\nN/A\n\n0.026122\n", "")

    monkeypatch.setattr(mp3_concat.subprocess, "run", fake_run)
    p = tmp_path / "a.mp3"
    p.write_bytes(b"\0")
    assert mp3_concat.contributed_s(p, scratch_root=tmp_path / "scratch") == pytest.approx(0.074122)
    assert "packet=duration_time" in seen["argv"]
    assert not any("format=" in a for a in seen["argv"])


def test_contributed_s_falls_back_to_the_format_duration_and_says_so(tmp_path, monkeypatch):
    """ffprobe ran but gave no packets: a number still comes back (the format duration), and the
    fall-back is logged rather than silent."""
    from loguru import logger
    monkeypatch.setattr(mp3_concat.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 1, "", "boom"))
    import tts_utils
    monkeypatch.setattr(tts_utils, "ffprobe_duration", lambda p: 1.25)
    msgs = []
    sink = logger.add(lambda m: msgs.append(str(m)), level="WARNING")
    try:
        p = tmp_path / "a.mp3"
        p.write_bytes(b"\0")
        assert mp3_concat.contributed_s(p, scratch_root=tmp_path / "scratch") == 1.25
    finally:
        logger.remove(sink)
    assert any("no packet durations" in m and "1.250" in m for m in msgs), msgs


@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")
@pytest.mark.parametrize("rate,ch,frame", [(24000, 1, 576), (44100, 2, 1152)])
def test_contributed_s_is_the_join_length_on_mpeg2_and_mpeg1(tmp_path, rate, ch, frame):
    """MPEG-2 Layer III (576 samples a frame, the 24 kHz speech profile) and MPEG-1 (1152): the
    helper agrees with an independent packets x frame / rate count, and the sum of the parts is
    what a stream-copy join contains — the joined file's own probe is that sum less only its
    leading delay and end padding (FFmpeg 8 trims them, older builds do not: 0 to ~0.1 s).
    The per-file format probe is NOT asserted to equal anything: it is the figure that differs
    between builds, which is the bug."""
    from conftest import mp3_packet_length_s
    from tts_utils import ffprobe_duration
    parts = []
    for i, secs in enumerate((1.0, 0.7, 1.3)):
        p = tmp_path / f"p{i}.mp3"
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i",
                        f"sine=frequency={300 + 100 * i}:duration={secs}",
                        "-ac", str(ch), "-ar", str(rate), "-b:a", "96k", str(p),
                        "-loglevel", "error"], check=True)
        parts.append(p)
    lens = [mp3_concat.contributed_s(p, scratch_root=tmp_path / "scratch") for p in parts]
    for p, got in zip(parts, lens):
        assert got == pytest.approx(mp3_packet_length_s(p), abs=0.001)
        assert (got * rate / frame) == pytest.approx(round(got * rate / frame), abs=0.01), \
            "a whole number of frames"
    joined = mp3_concat.concat_mp3(parts, tmp_path / "joined.mp3",
                                   scratch_root=tmp_path / "scratch")
    file_s = ffprobe_duration(joined)
    assert sum(lens) - 0.12 <= file_s <= sum(lens) + 0.01, (
        f"joined file {file_s:.3f} s vs summed contributions {sum(lens):.3f} s")
