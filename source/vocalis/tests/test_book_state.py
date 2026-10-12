"""Tests for the per-book sidecar (book_state, 2.0-M5)."""
import subprocess
from pathlib import Path

import pytest

import book_state
from tts_utils import save_wav_sf   # portable WAV write (torchaudio.save unusable on ROCm)


def _sections(n=3):
    return [{"index": i, "title": f"Chapter {i+1}", "filename": f"{i:02d}_Chapter_{i+1}"}
            for i in range(n)]


def test_init_writes_sidecar_all_pending(tmp_path):
    data = book_state.init_sidecar(tmp_path, "book.docx", "V.wav", None,
                                   {"engine": "standard", "exaggeration": 0.5}, _sections(2))
    assert data["source_docx"] == "book.docx"
    assert data["voice"] == "V.wav"
    assert [c["status"] for c in data["chapters"]] == ["pending", "pending"]
    # round-trips from disk
    loaded = book_state.load_sidecar(tmp_path)
    assert loaded["voice"] == "V.wav" and len(loaded["chapters"]) == 2


def test_update_chapter_and_finalize(tmp_path):
    book_state.init_sidecar(tmp_path, "b.docx", "V.wav", None, {}, _sections(2))
    book_state.update_chapter(tmp_path, 0, status="done", voice="V.wav", duration_s=12.5)
    sc = book_state.load_sidecar(tmp_path)
    c0 = next(c for c in sc["chapters"] if c["index"] == 0)
    assert c0["status"] == "done" and c0["duration_s"] == 12.5
    book_state.finalize(tmp_path, 12.5)
    assert book_state.load_sidecar(tmp_path)["total_duration_s"] == 12.5


def test_init_preserves_done_chapters_on_rerun(tmp_path):
    book_state.init_sidecar(tmp_path, "b.docx", "V.wav", None, {}, _sections(2))
    book_state.update_chapter(tmp_path, 0, status="done", voice="V.wav", duration_s=9.0)
    # re-init (resume) must keep chapter 0's done record, reset the rest
    data = book_state.init_sidecar(tmp_path, "b.docx", "V.wav", None, {}, _sections(2))
    by = {c["index"]: c for c in data["chapters"]}
    assert by[0]["status"] == "done" and by[0]["duration_s"] == 9.0
    assert by[1]["status"] == "pending"


def test_load_missing_returns_none(tmp_path):
    assert book_state.load_sidecar(tmp_path) is None


def test_book_stems_natural_order_and_excludes_part(tmp_path):
    """Chapters order by numeric index (100 after 99, not lexical), and an
    in-progress '.part.wav' temp write is never surfaced as a phantom chapter."""
    import torch, torchaudio as ta
    for i in [0, 2, 9, 10, 99, 100, 101]:
        save_wav_sf(str(tmp_path / f"{i:02d}_ch.wav"), torch.zeros(1, 2400), 24000)
    save_wav_sf(str(tmp_path / "05_ch.part.wav"), torch.zeros(1, 2400), 24000)   # mid-write temp
    stems = book_state._book_stems(tmp_path)
    assert [int(s.split("_")[0]) for s in stems] == [0, 2, 9, 10, 99, 100, 101]
    assert not any(".part" in s for s in stems)


def test_scan_book_orders_chapters_over_100(tmp_path):
    import torch, torchaudio as ta
    for i in [9, 10, 100]:
        save_wav_sf(str(tmp_path / f"{i:02d}_ch.wav"), torch.zeros(1, 2400), 24000)
    rows = book_state.scan_book(tmp_path)["chapters"]
    assert [r["filename"] for r in rows] == ["09_ch", "10_ch", "100_ch"]


def test_scan_library_sidecar_with_empty_chapters_falls_back_to_disk(tmp_path):
    """A sidecar that exists but has no usable chapters list must not report a
    fully-present book as 0/N done — fall back to 'everything on disk is done'."""
    import torch, torchaudio as ta
    out = tmp_path / "output"; d = out / "emptysc"; d.mkdir(parents=True)
    for i in range(2):
        save_wav_sf(str(d / f"{i:02d}_ch.wav"), torch.zeros(1, 2400), 24000)
    book_state.write_sidecar(d, {"source_docx": "b.docx", "voice": "V.wav", "chapters": []})
    m = next(b for b in book_state.scan_library(out) if b["book"] == "emptysc")
    assert m["chapters"] == 2 and m["done"] == 2
    assert m["full_mp3"] is None and m["full_size"] is None


def test_scan_library_reports_real_done_count_with_sidecar(tmp_path):
    """A mid-render book (sidecar present, only some chapters marked done) must NOT
    report done == chapters."""
    import torch, torchaudio as ta
    out = tmp_path / "output"; d = out / "midbook"; d.mkdir(parents=True)
    for i in range(3):
        save_wav_sf(str(d / f"{i:02d}_Chapter_{i+1}.wav"), torch.zeros(1, 2400), 24000)
    book_state.init_sidecar(d, "b.docx", "V.wav", None, {}, _sections(3))
    book_state.update_chapter(d, 0, status="done", voice="V.wav", duration_s=1.0)
    m = next(b for b in book_state.scan_library(out) if b["book"] == "midbook")
    assert m["chapters"] == 3 and m["done"] == 1


@pytest.mark.parametrize("extension", [".opus", ".mp3", ".m4a"])
def test_scan_library_reports_complete_audiobook_name_and_size(tmp_path, extension):
    """The shelf exposes the existing complete file, preserving its real container and size."""
    out = tmp_path / "output"
    book = out / "library-book"
    book.mkdir(parents=True)
    (book / "00_Chapter.opus").write_bytes(b"chapter")
    full = book / f"library-book_full{extension}"
    full.write_bytes(b"complete audiobook")

    row = next(item for item in book_state.scan_library(out) if item["book"] == book.name)

    assert row["full_mp3"] == full.name
    assert row["full_size"] == full.stat().st_size
    assert row["full_audiobooks"] == [{"file": full.name, "size": full.stat().st_size}]


def test_scan_book_reports_all_completed_audiobook_formats_with_legacy_preference(tmp_path):
    book = tmp_path / "all-formats"
    book.mkdir()
    (book / "00_Chapter.opus").write_bytes(b"chapter")
    expected = []
    for ext, payload in ((".opus", b"opus"), (".mp3", b"mp3 data"), (".m4a", b"aac data")):
        path = book / f"{book.name}_full{ext}"
        path.write_bytes(payload)
        expected.append({"file": path.name, "size": len(payload)})

    output = book_state.scan_book(book)

    assert output["full_audiobooks"] == expected
    assert output["full_mp3"] == expected[0]["file"]
    assert output["full_size"] == expected[0]["size"]


def _have_ffmpeg():
    from shutil import which
    return which("ffmpeg") and which("ffprobe")


@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")
def test_concat_handles_apostrophe_in_filename(tmp_path):
    """A hand-copied chapter whose name has an apostrophe must not break the concat
    demuxer — the ' has to be escaped in the list file, or ffmpeg reads a bad path."""
    import torch, torchaudio as ta
    from tts_utils import wav_to_mp3
    for nm in ["00_Intro", "01_Rock'n'Roll"]:
        wav = tmp_path / f"{nm}.wav"
        save_wav_sf(str(wav), torch.zeros(1, 24000), 24000)
        wav_to_mp3(wav)
    full = book_state.concat_book_mp3(tmp_path, "mybook")
    assert full.exists() and book_state.mp3_duration(full) > 1.0


@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")
def test_concat_book_mp3_orders_and_sums(tmp_path):
    """AC12: concat produces one MP3 whose duration ~ the sum of chapter MP3s."""
    import torch, torchaudio as ta
    from tts_utils import wav_to_mp3
    mp3_dir = tmp_path / "mp3"; mp3_dir.mkdir()
    total = 0.0
    for i, secs in enumerate([1.0, 1.5]):
        wav = tmp_path / f"{i:02d}_ch.wav"
        save_wav_sf(str(wav), torch.zeros(1, int(24000 * secs)), 24000)
        wav_to_mp3(wav)                      # writes tmp_path/mp3/<stem>.mp3
        total += secs
    full = book_state.concat_book_mp3(tmp_path, "mybook")
    assert full.exists() and full.name == "mybook_full.mp3"
    dur = book_state.mp3_duration(full)
    assert abs(dur - total) < 0.5           # correctly-ordered concatenation, summed


# ── M2.5: never destroy on a failed read ─────────────────────────────────────

def test_init_refuses_to_rebuild_over_a_sidecar_it_could_not_read(tmp_path):
    """The M2.5 site. `except Exception → return None` read a CORRUPT sidecar as an ABSENT
    one, so init_sidecar rebuilt from {} — every finished chapter back to `pending`, its
    voice and duration gone, `created` and `total_duration_s` gone. The MP3s survive (a
    chapter is skipped because its MP3 exists, not because the sidecar says so), and
    everything the sidecar knew about them does not.

    A render must not begin by destroying the ledger of the render before it."""
    book_state.init_sidecar(tmp_path, "b.docx", "V.wav", None, {}, _sections(2))
    book_state.update_chapter(tmp_path, 0, status="done", voice="V.wav", duration_s=12.5)
    book_state.finalize(tmp_path, 12.5)

    p = book_state.sidecar_path(tmp_path)
    p.write_text("{{{ not yaml", encoding="utf-8")          # ENOSPC, EIO, a killed writer
    before = p.read_bytes()

    with pytest.raises(book_state.SidecarUnreadable):
        book_state.init_sidecar(tmp_path, "b.docx", "V.wav", None, {}, _sections(2))

    assert p.read_bytes() == before, "a sidecar we could not read must not be overwritten"


def test_init_still_creates_the_first_sidecar_of_a_book(tmp_path):
    """ABSENT ≠ CORRUPT. A book's FIRST render has no sidecar and nothing to destroy — the
    strict read returns None for a missing file, and the write goes through."""
    assert not book_state.sidecar_path(tmp_path).exists()
    data = book_state.init_sidecar(tmp_path, "b.docx", "V.wav", None, {}, _sections(2))
    assert [c["status"] for c in data["chapters"]] == ["pending", "pending"]


def test_reading_a_corrupt_sidecar_still_degrades(tmp_path):
    """Reads degrade; writes abort. The status route, the library scan and the enhance lock
    all read it, and a corrupt sidecar must leave them showing blanks — not 500."""
    book_state.init_sidecar(tmp_path, "b.docx", "V.wav", None, {}, _sections(2))
    book_state.sidecar_path(tmp_path).write_text("{{{ not yaml", encoding="utf-8")

    assert book_state.load_sidecar(tmp_path) is None        # non-strict: as before
    assert book_state.rendered_chapters(tmp_path) == 0
    assert book_state.book_enhance_lock(tmp_path) is None


# ── M3: the words never touch a mount (5.0 §8.1) ─────────────────────────────

@pytest.mark.skipif(not _have_ffmpeg(), reason="ffmpeg/ffprobe required")
def test_concat_writes_no_list_file(tmp_path, monkeypatch):
    """The concat list must never be written in the book output directory. It contains one path per
chapter and exposes the table of contents in plaintext; a process interrupted during concat
can leave such a file behind. A pipe keeps the list in memory regardless of its contents.

The test watches filesystem writes, so a future implementation that recreates the list under
another name still fails."""
    out_dir = tmp_path / "The Book"
    mp3_dir = out_dir / "mp3"
    mp3_dir.mkdir(parents=True)
    for i, title in enumerate(["01_The_Confession", "02_Rock'n'Roll"]):
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i",
                        f"sine=frequency={440 + i * 220}:duration=1",
                        "-b:a", "96k", str(mp3_dir / f"{title}.mp3"), "-loglevel", "error"],
                       check=True)

    written = []
    real_write = Path.write_text
    monkeypatch.setattr(Path, "write_text",
                        lambda self, *a, **kw: (written.append(self.name),
                                                real_write(self, *a, **kw))[1])

    full = book_state.concat_book_mp3(out_dir, "The_Book")

    assert full.is_file() and full.stat().st_size > 0
    assert not (out_dir / "_concat_list.txt").exists()
    assert written == [], f"the concat list was written to disk as {written}"
    # …and it still concatenated BOTH chapters, apostrophe and all
    assert book_state.mp3_duration(full) == pytest.approx(2.0, abs=0.3)
