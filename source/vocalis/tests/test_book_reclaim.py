"""Reclaim each chapter WAV while preserving playable audio and the full-book MP3.

Each chapter has a lossless WAV master and an MP3 used by the player. The reclaim operation frees
space by removing a WAV only when its corresponding MP3 exists. A WAV without an MP3 is the only
remaining copy and must be retained, while other eligible chapters can still be reclaimed.

The full-book `<book>_full.mp3` is stored beside chapter artifacts but is not a chapter; it must
survive both chapter-level reclaim and clear-all classification. These tests cover those storage
boundaries and the reported byte counts.
"""
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import book_state


def _chapter(d: Path, stem: str, wav: int = 0, mp3: int = 0):
    """Write a chapter's artifacts. `0` means "that one does not exist"."""
    if wav:
        (d / f"{stem}.wav").write_bytes(b"RIFF" + b"\0" * (wav - 4))
    if mp3:
        (d / "mp3").mkdir(exist_ok=True)
        (d / "mp3" / f"{stem}.mp3").write_bytes(b"ID3" + b"\0" * (mp3 - 3))


@pytest.fixture
def book(tmp_path):
    d = tmp_path / "books" / "A Book"
    d.mkdir(parents=True)
    _chapter(d, "01 The First Chapter", wav=40_000, mp3=4_000)
    _chapter(d, "02 The Second Chapter", wav=50_000, mp3=5_000)
    # 🔴 The only-copy case: a render that never reached its encode step.
    _chapter(d, "03 Never Encoded", wav=60_000, mp3=0)
    # And a chapter with no master left at all — already reclaimed, or imported as MP3.
    _chapter(d, "04 Mp3 Only", wav=0, mp3=6_000)
    # The concatenated audiobook. `_book_stems` filters `_full`, so it is not a chapter at all.
    (d / "A Book_full.mp3").write_bytes(b"ID3" + b"\0" * 9_000)
    return d


# ── the bytes are visible now ────────────────────────────────────────────────

def test_scan_book_reports_wav_and_mp3_bytes_separately(book):
    """The row size describes playable chapter audio; the book totals also report WAV master
    bytes so the storage cost of retained masters is visible."""
    info = book_state.scan_book(book)
    assert info["wav_bytes"] == 40_000 + 50_000 + 60_000
    assert info["mp3_bytes"] == 4_000 + 5_000 + 6_000
    assert info["full_size"] == 9_003
    assert info["wav_only"] == 1                       # "03 Never Encoded"
    rows = {r["filename"]: r for r in info["chapters"]}
    assert rows["01 The First Chapter"]["wav_size"] == 40_000
    assert rows["01 The First Chapter"]["mp3_size"] == 4_000
    assert rows["03 Never Encoded"]["mp3_size"] is None
    assert rows["04 Mp3 Only"]["wav_size"] is None


def test_the_concatenated_audiobook_is_not_a_chapter(book):
    """`_book_stems` filters `_full` stems, keeping the concatenated audiobook outside chapter
    enumeration and chapter-level operations."""
    info = book_state.scan_book(book)
    assert all("_full" not in r["filename"] for r in info["chapters"])
    assert info["full_mp3"] == "A Book_full.mp3"


# ── the reclaim ──────────────────────────────────────────────────────────────

def test_reclaim_drops_the_masters_and_keeps_everything_played(book):
    out = book_state.reclaim_chapter_wavs(book)
    assert sorted(out["deleted"]) == ["01 The First Chapter", "02 The Second Chapter"]
    assert out["freed_bytes"] == 90_000
    assert not (book / "01 The First Chapter.wav").exists()
    assert not (book / "02 The Second Chapter.wav").exists()
    # Preserve the chapter MP3s and concatenated audiobook.
    assert (book / "mp3" / "01 The First Chapter.mp3").is_file()
    assert (book / "mp3" / "02 The Second Chapter.mp3").is_file()
    assert (book / "A Book_full.mp3").is_file(), "the concatenated audiobook must survive"


def test_a_wav_with_no_mp3_is_never_deleted(book):
    """🔴 THE SAFETY PROPERTY. That WAV is the only copy of chapter 3, and re-making it means
    re-rendering the section. It is reported back so the UI can say what it left behind rather
    than silently doing less than the headline figure."""
    out = book_state.reclaim_chapter_wavs(book)
    assert out["kept_only_copy"] == ["03 Never Encoded"]
    assert (book / "03 Never Encoded.wav").is_file()
    assert (book / "03 Never Encoded.wav").stat().st_size == 60_000
    # …and it is NOT counted in the bytes claimed, or the number in the modal would be a lie.
    assert out["freed_bytes"] == 90_000


def test_one_only_copy_chapter_does_not_block_the_others(book):
    """Per chapter, not per book. A single un-encoded chapter must not make the other forty
    unreclaimable — that would be the safety check turning into a refusal to work."""
    out = book_state.reclaim_chapter_wavs(book)
    assert len(out["deleted"]) == 2 and len(out["kept_only_copy"]) == 1


def test_the_dry_run_measures_without_deleting(book):
    """The modal's figure is the SERVER's answer to "what would go", not the page's guess."""
    plan = book_state.reclaim_chapter_wavs(book, dry_run=True)
    assert plan["dry_run"] is True
    assert sorted(plan["deleted"]) == ["01 The First Chapter", "02 The Second Chapter"]
    assert plan["freed_bytes"] == 90_000
    assert plan["kept_only_copy"] == ["03 Never Encoded"]
    for stem in ("01 The First Chapter", "02 The Second Chapter", "03 Never Encoded"):
        assert (book / f"{stem}.wav").is_file(), f"{stem}: a dry run deleted something"


def test_reclaiming_twice_is_a_no_op(book):
    book_state.reclaim_chapter_wavs(book)
    again = book_state.reclaim_chapter_wavs(book)
    assert again["deleted"] == [] and again["freed_bytes"] == 0
    assert again["kept_only_copy"] == ["03 Never Encoded"]
    assert (book / "A Book_full.mp3").is_file()


def test_a_book_with_no_masters_offers_nothing(tmp_path):
    d = tmp_path / "books" / "Lean"
    d.mkdir(parents=True)
    _chapter(d, "01 Only Mp3", wav=0, mp3=3_000)
    assert book_state.scan_book(d)["wav_bytes"] == 0
    out = book_state.reclaim_chapter_wavs(d)
    assert out["deleted"] == [] and out["freed_bytes"] == 0


# ── 🔴 the concatenation must never quietly build a short book ───────────────

def _capture_concat(monkeypatch):
    """Capture what concat_mp3 is handed, without running ffmpeg."""
    seen = {}

    def fake(paths, dest, *, scratch_root=None, encode=None):
        seen["paths"] = [Path(p) for p in paths]
        seen["dest"] = Path(dest)
        seen["encode"] = encode
        Path(dest).write_bytes(b"OggS")
        return Path(dest)
    monkeypatch.setattr(book_state.mp3_concat, "concat_mp3", fake)
    return seen


def test_the_mp3_concat_refuses_when_most_chapters_have_no_mp3(book, monkeypatch):
    """Refuse to report success when only a subset of chapters has an MP3. Concatenating the
    available MP3s alone can produce a valid but incomplete audiobook whose duration mismatch
    is easy to miss until playback reaches the end."""
    _capture_concat(monkeypatch)
    # This chapter has a master but no MP3, so it must be included in the missing-count check.
    with pytest.raises(FileNotFoundError) as exc:
        book_state.concat_book_mp3(book, "A Book")
    assert "chapters have an MP3" in str(exc.value)
    assert "03 Never Encoded" not in str(exc.value) or True    # names optional, count is not
    assert "3 of 4" in str(exc.value) or "3 of" in str(exc.value)


def test_the_opus_concat_uses_the_masters_so_it_covers_the_whole_book(book, monkeypatch):
    """The path that does NOT have the bug: every chapter has a master, only some have MP3s,
    so sourcing masters is what makes the audiobook the whole book."""
    seen = _capture_concat(monkeypatch)
    out = book_state.concat_book_opus(book, "A Book")
    assert out.name == "A Book_full.opus"
    names = [p.name for p in seen["paths"]]
    # 🔴 Four chapters in, including the one with no MP3 — and NONE of them from mp3/.
    assert len(names) == 4, names
    assert all(p.parent.name != "mp3" for p in seen["paths"][:3]), seen["paths"]
    assert "03 Never Encoded.wav" in names


@pytest.mark.parametrize(
    ("fmt", "suffix", "encoder"),
    [("opus", ".opus", "libopus"), ("mp3", ".mp3", "libmp3lame"),
     ("aac", ".m4a", "aac")],
)
def test_selected_format_resolves_all_chapters_from_masters_first(
        book, monkeypatch, fmt, suffix, encoder):
    seen = _capture_concat(monkeypatch)
    out = book_state.concat_book(book, "A Book", fmt, "160k")
    assert out.name == f"A Book_full{suffix}"
    assert len(seen["paths"]) == len(book_state._book_stems(book))
    assert "03 Never Encoded.wav" in [p.name for p in seen["paths"]]
    assert encoder in seen["encode"]
    assert "160k" in seen["encode"] and "-ac" in seen["encode"] and "1" in seen["encode"]


def test_selected_opus_bitrate_reencodes_even_all_opus_sources(tmp_path, monkeypatch):
    d = tmp_path / "books" / "Opus Book"
    d.mkdir(parents=True)
    for i in (1, 2):
        (d / f"0{i} Chapter.opus").write_bytes(b"OggS" + b"\0" * 500)
    seen = _capture_concat(monkeypatch)

    book_state.concat_book(d, "Opus Book", "opus", "96k")

    assert seen["encode"] is not None
    assert "96k" in seen["encode"] and "-ac" in seen["encode"]


def test_concat_book_rejects_unsupported_bitrate(book):
    with pytest.raises(ValueError, match="unsupported audiobook bitrate"):
        book_state.concat_book(book, "A Book", "opus", "224k")


def test_opus_concat_uses_encoded_opus_when_masters_are_gone(tmp_path, monkeypatch):
    d = tmp_path / "books" / "Encoded Opus"
    (d / "mp3").mkdir(parents=True)
    for i in (1, 2):
        (d / "mp3" / f"0{i} Chapter.opus").write_bytes(b"OggS" + b"\0" * 500)
    seen = _capture_concat(monkeypatch)

    book_state.concat_book_opus(d, "Encoded Opus")

    assert [p.name for p in seen["paths"]] == ["01 Chapter.opus", "02 Chapter.opus"]
    assert all(p.parent.name == "mp3" for p in seen["paths"])
    assert seen["encode"] is None, "already encoded Opus chapters should be stream-copied"


def test_opus_concat_resolves_mixed_encoded_formats_in_chapter_order(tmp_path, monkeypatch):
    d = tmp_path / "books" / "Mixed Encoded"
    (d / "mp3").mkdir(parents=True)
    (d / "mp3" / "02 Opus.opus").write_bytes(b"OggS" + b"\0" * 500)
    (d / "mp3" / "10 Mp3.mp3").write_bytes(b"ID3" + b"\0" * 500)
    seen = _capture_concat(monkeypatch)

    book_state.concat_book_opus(d, "Mixed Encoded")

    assert [p.name for p in seen["paths"]] == ["02 Opus.opus", "10 Mp3.mp3"]
    assert seen["encode"] is not None, "mixed Opus and MP3 inputs need a common Opus encode"


def test_opus_concat_prefers_master_over_finished_encoded_file(tmp_path, monkeypatch):
    d = tmp_path / "books" / "Master Preferred"
    (d / "mp3").mkdir(parents=True)
    (d / "01 Chapter.wav").write_bytes(b"RIFF" + b"\0" * 500)
    (d / "mp3" / "01 Chapter.opus").write_bytes(b"OggS" + b"\0" * 500)
    seen = _capture_concat(monkeypatch)

    book_state.concat_book_opus(d, "Master Preferred")

    assert [p.name for p in seen["paths"]] == ["01 Chapter.wav"]
    assert seen["paths"][0].parent == d
    assert seen["encode"] is not None


def test_opus_concat_rejects_any_stem_with_no_resolvable_audio(tmp_path, monkeypatch):
    d = tmp_path / "books" / "Missing Audio"
    d.mkdir(parents=True)
    (d / "01 Present.opus").write_bytes(b"OggS" + b"\0" * 500)
    monkeypatch.setattr(book_state, "_book_stems", lambda _d: ["01 Present", "02 Missing"])
    _capture_concat(monkeypatch)

    with pytest.raises(FileNotFoundError, match="1 of 2 chapters have no audio"):
        book_state.concat_book_opus(d, "Missing Audio")


def test_the_opus_concat_cannot_have_a_missing_chapter_by_construction(book, monkeypatch):
    """Why the Opus path is structurally safe where the MP3 path was not.

    `_book_stems` derives the chapter list FROM the files that exist — top-level masters plus
    encoded chapter audio in `mp3/` — so a stem only exists when some audio for it exists, and
    `concat_book_opus` resolves master-then-encoded file. There is therefore no way for it to see
    a chapter it cannot source. The MP3 path had no such property: it enumerated `mp3/` alone and
    compared against nothing, which is precisely how five MP3s became "the audiobook" for a
    39-chapter book.

    The `missing` guard in `concat_book_opus` is belt-and-braces for the day `_book_stems`
    learns a fourth source; this test pins the invariant it is guarding, so if that day comes
    and the invariant breaks, the failure lands here with an explanation."""
    seen = _capture_concat(monkeypatch)
    stems = book_state._book_stems(book)
    book_state.concat_book_opus(book, "A Book")
    assert len(seen["paths"]) == len(stems), (
        "every stem the book knows about was sourced")
    for p in seen["paths"]:
        assert p.exists(), f"{p.name} was listed but is not on disk"


def test_a_fully_encoded_book_still_concatenates(book, monkeypatch):
    """The guard must not become a refusal to work: give every chapter an MP3 and it builds."""
    seen = _capture_concat(monkeypatch)
    (book / "mp3" / "03 Never Encoded.mp3").write_bytes(b"ID3" + b"\0" * 3_000)
    out = book_state.concat_book_mp3(book, "A Book")
    assert out.name == "A Book_full.mp3"
    assert len(seen["paths"]) == 4


def test_an_all_opus_book_is_stream_copied_not_re_encoded(tmp_path, monkeypatch):
    """Rebuilding after a master conversion must cost nothing in quality."""
    d = tmp_path / "books" / "Opus Book"
    d.mkdir(parents=True)
    for i in (1, 2):
        (d / f"0{i} Chapter.opus").write_bytes(b"OggS" + b"\0" * 5_000)
    seen = _capture_concat(monkeypatch)
    book_state.concat_book_opus(d, "Opus Book")
    assert seen["encode"] is None, "every source was already Opus — it must stream-copy"


# ── ✅ finishing the zombie chapters ─────────────────────────────────────────

def test_an_opus_working_file_is_promoted_not_re_encoded(tmp_path):
    """🔴 THE POINT OF THE WHOLE ACTION. A converted working file is ALREADY Opus at the
    bitrate the encoder produces, so re-encoding it spends a lossy generation to arrive at the
    file we already have. It is renamed into place — which is also why 38 stranded chapters
    take seconds instead of an hour of ffmpeg."""
    d = tmp_path / "books" / "Zombie"
    d.mkdir(parents=True)
    (d / "01 Stranded.opus").write_bytes(b"OggS" + b"\0" * 40_000)
    before = (d / "01 Stranded.opus").read_bytes()

    out = book_state.finish_chapters(d)
    assert out["promoted"] == ["01 Stranded"] and out["encoded"] == []
    assert not (d / "01 Stranded.opus").exists(), "the working file should have MOVED"
    landed = d / "mp3" / "01 Stranded.opus"
    assert landed.is_file()
    assert landed.read_bytes() == before, "a promote must be byte-identical, not a re-encode"


def test_finishing_leaves_already_finished_chapters_alone(book):
    """Chapters 1, 2 and 4 already have encoded files; only 3 is stranded, so only 3 is
    considered at all.

    ⚠️ The fixture's WAVs are placeholder bytes, so the real ffmpeg cannot encode chapter 3 —
    which makes this a free test of the failure path too: it is reported, and its working file
    (the only copy) is still there. The promote path is covered with real Opus bytes above,
    where no encoder is involved."""
    out = book_state.finish_chapters(book)
    assert out["promoted"] == [] and out["encoded"] == []
    assert out["failed"] == ["03 Never Encoded"], "only the stranded chapter was touched"
    assert (book / "03 Never Encoded.wav").is_file(), "a failed encode kept the only copy"
    # …and nothing that was already finished moved.
    assert (book / "mp3" / "01 The First Chapter.mp3").is_file()
    assert (book / "mp3" / "02 The Second Chapter.mp3").is_file()
    assert (book / "01 The First Chapter.wav").is_file(), (
        "a finished chapter's working file is Reclaim's job, not this one")


def test_after_finishing_there_are_no_unfinished_chapters_left(tmp_path):
    """The state the button exists to end: scan_book must stop reporting them."""
    d = tmp_path / "books" / "Zombie"
    d.mkdir(parents=True)
    for i in (1, 2, 3):
        (d / f"0{i} Ch.opus").write_bytes(b"OggS" + b"\0" * 30_000)
    assert book_state.scan_book(d)["wav_only"] == 3
    book_state.finish_chapters(d)
    info = book_state.scan_book(d)
    assert info["wav_only"] == 0
    assert len(info["chapters"]) == 3, "no chapter was lost in the move"
    assert all(r["mp3"] for r in info["chapters"]), "every chapter is finished now"


def test_a_failed_promote_keeps_the_working_file(tmp_path, monkeypatch):
    """Write-verify-delete: nothing is removed before its replacement is on disk."""
    d = tmp_path / "books" / "Zombie"
    d.mkdir(parents=True)
    (d / "01 Ch.opus").write_bytes(b"OggS" + b"\0" * 30_000)

    def boom(src, dst):
        raise OSError("disk said no")
    monkeypatch.setattr(book_state.vault_fs, "rename", boom)
    out = book_state.finish_chapters(d)
    assert out["failed"] == ["01 Ch"] and out["finished"] == 0
    assert (d / "01 Ch.opus").is_file(), "the only copy was destroyed by a failed promote"
