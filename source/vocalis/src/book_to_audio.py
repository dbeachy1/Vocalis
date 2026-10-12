#!/usr/bin/env python3
"""
book_to_audio.py — Convert a Word novel (.docx) to an audiobook via Chatterbox TTS

Section structure (configurable via flags, defaults match standard fan-fiction layout):
  --part-style    "Heading 1"  = Part headings  (Part One, Part Two ...)
  --chapter-style "Heading 2"  = Chapter / Prologue / Epilogue headings
  Part Title  = Part subtitle  (appended to part heading)
  Title       = Chapter subtitle (appended to chapter heading)
  Everything else (Normal, New Scene, Text Message, Scene Intro Italics,
  Author's Note, List Paragraph, Centered ...) = body text, all spoken.

Table of Contents is detected by paragraph style (TOC 1, TOC 2 …) or by a
heading whose text is "Table of Contents" / "Contents", and is silently skipped.

Resume-safe: re-running picks up where it left off.
One mp3/<chapter>.mp3 (96 kbps mono) per chapter/section — the WAV master and the
chunk workspace are transient (3.x): deleted as soon as each section's MP3 lands.

Usage:
  scripts\\book_to_audio.bat  book.docx  --voice ref.wav
  scripts\\book_to_audio.bat  book.docx  --voice ref.wav  --out-dir D:\\Audiobooks\\MyBook
  scripts\\book_to_audio.bat  book.docx  --list-styles          <- inspect styles before first run
  scripts\\book_to_audio.bat  book.docx  --chapter-style "Paragraph 8"  <- custom chapter style
  scripts\\book_to_audio.bat  book.docx  --chapter-style "Paragraph 8" --part-style "Heading 1"
"""

import argparse
from loguru import logger
import io
import os
import re
import shutil
import sys
import time
from pathlib import Path

# ── python-docx guard ─────────────────────────────────────────────────────────
try:
    from docx import Document
except ImportError:
    logger.error("\nERROR: python-docx is not installed.")
    logger.info("Fix:   venv\\Scripts\\pip install python-docx\n")
    sys.exit(1)

# torch and torchaudio are lazy-imported inside main() so that --list-styles
# runs don't pay the multi-second PyTorch startup cost.

# Read book files directly through the vault-aware byte reader. Word permits reads while holding an exclusive write lock, so no plaintext temporary copy is needed.
# Both DOCX and EPUB parsers consume in-memory bytes. Keep this as the single file-read boundary so encrypted storage and plaintext-lifetime handling stay consistent.
def read_book_bytes(path: Path) -> bytes:
    """Read the book through the vault-aware filesystem. Both DOCX and EPUB parsers consume the returned bytes in memory, keeping this the single read boundary for book input. Propagate vault-authentication failures separately from ordinary permission errors."""
    import vault_fs
    try:
        return vault_fs.read_bytes(path)
    except PermissionError:
        raise SystemExit(
            f"\nERROR: Cannot read '{Path(path).name}'.\n"
            "Make sure the file exists and you have permission to read it.\n"
        )


def open_docx(path: Path) -> "Document":
    try:
        return Document(io.BytesIO(read_book_bytes(path)))
    except SystemExit:
        raise
    except Exception:
        raise SystemExit(
            f"\nERROR: '{Path(path).name}' could not be opened as a Word document.\n"
            "Make sure it is saved in .docx format (not the old .doc format).\n"
        )


# ── Config ────────────────────────────────────────────────────────────────────
import book_state                                                             # noqa: E402
import render_rate                                                            # noqa: E402
import vault_fs                                                               # noqa: E402
from tts_utils import (split_into_chunks, filter_actions, chunks_fingerprint,  # noqa: E402
                       is_truncated_wav, valid_or_remove,
                       wav_to_mp3, wav_to_opus, save_wav_atomic, load_wav, ffprobe_duration,
                       setup_logging, make_log_path, PRODUCT_NAME, VERSION, WorkerPool,
                       GenParams, parse_devices, describe_devices, VocalisError, cache_root)
from vocalis.runtime import paths

BASE_DIR    = paths.CODE_DIR                  # immutable code root
# Transient render scratch (book chunk WAVs + Playground resume workspaces) — a
# cache, so it lives in the OS cache dir, not the install root. Finished book audio
# (OUTPUT_DIR) and the Playground clip library (output/playground) stay put.
CHUNKS_ROOT = cache_root() / "chunks"
OUTPUT_DIR  = paths.DATA_DIR / "output"

# 5.3: rendered books live in output/books/<title>, not output/<title>.
#
# 🔴 A FUNCTION TAKING THE ROOT, not a module constant, and both halves of that matter.
# `OUTPUT_DIR` IS CAPTURED PER IMPORTER — `from book_to_audio import OUTPUT_DIR` binds a name in
# each module, and tests patch those bindings one by one (`monkeypatch.setattr(web_books,
# "OUTPUT_DIR", tmp)`). A module-level `BOOKS_DIR = OUTPUT_DIR / "books"` would be computed once
# at import from THIS module's binding, so every patched test would keep writing into the real
# install root. Passing the caller's own `OUTPUT_DIR` in keeps the existing patch points working
# untouched, while the subdirectory name stays defined in exactly one place.
BOOKS_SUBDIR = "books"


def books_root(output_dir) -> Path:
    """Return the dedicated `<output_dir>/books` directory for rendered audiobooks. Keeping books in a separate namespace prevents a book title from colliding with live stores such as clips or voices."""
    return Path(output_dir) / BOOKS_SUBDIR

# Default styles that start a new section (new output .wav file).
# Override via --part-style / --chapter-style flags.
DEFAULT_PART_STYLE    = "Heading 1"
DEFAULT_CHAPTER_STYLE = "Heading 2"
SECTION_BREAK_STYLES  = {DEFAULT_PART_STYLE.lower(), DEFAULT_CHAPTER_STYLE.lower()}

# Styles that are appended to the current heading (not a new section, not body)
# e.g.  Heading 2 "Chapter One"  +  Title "The One Where Everything Changes"
#   → spoken as:  "Chapter One: The One Where Everything Changes"
HEADING_CONTINUATION_STYLES = {"title", "part title", "subtitle"}

# Styles / prefixes that indicate Table of Contents entries → skip
TOC_STYLE_PREFIXES = ("toc",)
TOC_STYLE_EXACT    = {"table of contents", "toc heading"}

# Text pattern that identifies a TOC heading (even if styled as Heading 1/2)
TOC_TEXT_RE = re.compile(r'^(table\s+of\s+contents|contents)$', re.IGNORECASE)



# ── Helpers ───────────────────────────────────────────────────────────────────
def safe_name(text: str, max_len: int = 50) -> str:
    s = re.sub(r'[^\w\s-]', '', text).strip()
    s = re.sub(r'\s+', '_', s)
    return s[:max_len].rstrip('_') or "section"


def is_toc_style(style_lower: str, extra_toc_styles: set = None) -> bool:
    if extra_toc_styles and style_lower in extra_toc_styles:
        return True
    return (any(style_lower.startswith(p) for p in TOC_STYLE_PREFIXES)
            or style_lower in TOC_STYLE_EXACT)


# ── Style listing (--list-styles) ─────────────────────────────────────────────
def cmd_list_styles(docx_path: Path, section_break_styles: set = None,
                    extra_toc_styles: set = None):
    if section_break_styles is None:
        section_break_styles = SECTION_BREAK_STYLES
    doc = open_docx(docx_path)
    counts = {}
    for p in doc.paragraphs:
        if p.text.strip():
            counts[p.style.name] = counts.get(p.style.name, 0) + 1
    logger.info(f"\nParagraph styles in the document:\n")
    for style, count in sorted(counts.items(), key=lambda x: -x[1]):
        sl = style.lower()
        if sl in section_break_styles:
            tag = "  <- SECTION BREAK (new chapter/part)"
        elif sl in HEADING_CONTINUATION_STYLES:
            tag = "  <- HEADING CONTINUATION (appended to chapter title)"
        elif is_toc_style(sl, extra_toc_styles):
            tag = "  <- TOC (skipped)"
        else:
            tag = "  <- body text (spoken)"
        logger.info(f"  {count:5d}  {style}{tag}")


# ── Docx parser ───────────────────────────────────────────────────────────────
def parse_docx(docx_path: Path, section_break_styles: set = None,
               extra_toc_styles: set = None) -> list:
    """
    Returns a list of section dicts:
      { 'index': int, 'title': str, 'filename': str, 'text': str }
    """
    if section_break_styles is None:
        section_break_styles = SECTION_BREAK_STYLES
    doc = open_docx(docx_path)
    sections       = []
    current_title  = None   # None = front matter (pre-first-heading)
    current_body   = []
    in_toc         = False
    index          = 0

    def flush():
        nonlocal current_title, current_body, index
        body = "\n\n".join(current_body).strip()
        if not body and current_title is None:
            current_body = []
            return
        title     = current_title if current_title is not None else "Front Matter"
        # Add a period after the title so TTS pauses naturally before body text
        full_text = (title.rstrip('.') + ".\n\n" + body).strip() if body \
                    else title.rstrip('.') + "."
        sections.append({
            'index':    index,
            'title':    title,
            'filename': f"{index:02d}_{safe_name(title)}",
            'text':     full_text,
        })
        index          += 1
        current_title   = None
        current_body    = []

    for para in doc.paragraphs:
        raw   = para.text.strip()
        style = para.style.name
        sl    = style.lower()

        if not raw:
            continue

        # ── TOC paragraph styles → skip until next section-break heading ──
        if is_toc_style(sl, extra_toc_styles):
            in_toc = True   # only cleared when a section-break heading is seen
            continue

        # ── Section-break heading ─────────────────────────────────────────
        if sl in section_break_styles:
            if TOC_TEXT_RE.match(raw):
                # This heading IS the Table of Contents
                in_toc = True
                flush()   # save & reset accumulated state before entering TOC
                continue
            in_toc = False
            flush()
            current_title = raw

        # ── Heading continuation (chapter subtitle, part subtitle) ─────────
        elif sl in HEADING_CONTINUATION_STYLES:
            if in_toc:
                continue
            if current_title is not None:
                # Join with ": " so TTS reads "Chapter One: The Dragon's Lair"
                current_title = current_title + ": " + raw
            else:
                # Orphaned continuation before any heading → treat as body
                current_body.append(raw)

        # ── Body text (all other styles) ──────────────────────────────────
        else:
            if in_toc:
                continue
            current_body.append(raw)

    flush()
    return sections


# ── Audio generation for one section ─────────────────────────────────────────
def purge_truncated_chunks(section: dict, out_dir: Path, chunks_base: Path) -> int:
    """Delete any chunk WAVs that hit the hard cap, plus the section WAV if any were removed."""
    chunks_dir = chunks_base / section['filename']
    # Routed. Unrouted, exists() was False and glob() was [], so this returned 0 having
    # examined nothing — a chunk that hit the hard cap stayed banked and was reused as a
    # finished chunk on every subsequent render of that chapter, forever.
    if not vault_fs.exists(chunks_dir):
        return 0
    removed = 0
    for chunk_name in sorted(vault_fs.glob(chunks_dir, "chunk_*.wav")):
        chunk_wav = chunks_dir / chunk_name
        if is_truncated_wav(chunk_wav):
            # NOT section['filename'] — it is `<NN>_<safe_name(title)>`, so it IS the chapter
            # title, and logs/vocalis.log sits outside the vault. The index says which one.
            logger.info(f"  Purging truncated chunk: {chunk_wav.name} "
                        f"(chapter {section['filename'].split('_', 1)[0]})")
            vault_fs.unlink(chunk_wav)
            removed += 1
    if removed:
        for p in [
            out_dir / (section['filename'] + ".wav"),
            out_dir / "mp3" / (section['filename'] + ".mp3"),
        ]:
            vault_fs.unlink(p, missing_ok=True)
    return removed


def save_wav(path: Path, wav, sr: int):
    save_wav_atomic(path, wav, sr)      # shared crash-safe write (tts_utils)




#: Kept beside a chapter's banked chunks: `chunks_fingerprint` of the chunk list they were made for.
CHUNKS_MARK = "chunks.sha256"


def section_chunks(section: dict) -> list:
    """The pieces a chapter is spoken in.

    🔴 A BOOK NEVER NARRATES AN ASTERISK. Doug, 2026-10-12: "It's every single damn scene break in
    the book. That's when I hear it", and "audiobooks should ignore asterisks entirely and just
    not try to narrate them at all." The chapter text went to the chunker as written, so a "***"
    line reached Chatterbox inside a chunk, and its tokenizer has a token for "*": measured that
    day, the model spends a quarter to a half second voicing the marker, sometimes over a second,
    and the scene heading after it ran straight into the next paragraph.

    So the text goes through the same cleaner the chat and Playground paths use
    (`tts_utils.filter_actions`, speaking mode): every asterisk is dropped, a scene-break line
    ("***", "* * *", "---") becomes a paragraph break, and the paragraph beside it, such as
    "10 a.m. the next morning", ends as its own sentence.

    `stops="breaks"`: ONLY beside a scene break. Everywhere else a book's paragraphs are joined as
    they always were. A book made from a PDF has one paragraph per printed line, and ending a
    sentence at every one of those would break up every sentence in the book.
    """
    return split_into_chunks(filter_actions(section['text'], stops="breaks"))


def section_rendered(out_dir: Path, stem: str) -> bool:
    """An encoded chapter or lossless chapter WAV lets a resumed render skip GPU work."""
    return (book_state.chapter_encoded(out_dir, stem) is not None
            or vault_fs.exists(out_dir / f"{stem}.wav"))


def start_section(section: dict, pool: WorkerPool, params: GenParams, out_dir: Path, chunks_base: Path, on_event=None, cancel=None) -> dict:
    """Prepare a section and queue its chunks without waiting. This keeps shared workers supplied across chapter boundaries while preserving satellite batch boundaries. Return a handle for `finish_section`."""
    out_path = out_dir / (section['filename'] + ".wav")
    # Use the vault-aware rendered-section check when resuming. Bare filesystem existence checks do not recognize encrypted entries and can trigger unnecessary re-rendering.
    if section_rendered(out_dir, section['filename']):
        # already done; no new chars/time to report
        return {"done": (out_path, None, 0, 0.0)}

    # chunks_base is always derived from the docx stem, not the output dir,
    # so it stays stable even if --out-dir changes between runs.
    chunks_dir = chunks_base / section['filename']
    vault_fs.mkdir(chunks_dir)          # routed: a bare mkdir names the CHAPTER in cleartext

    chunks = section_chunks(section)
    total  = len(chunks)
    sr     = pool.sr

    if total == 0:
        logger.info(f"  (section has no synthesizable text — skipped)")
        return {"done": (out_path, None, 0, 0.0)}

    def cpath(i):
        return chunks_dir / f"chunk_{i:04d}.wav"

    def save_chunk(idx, wav, sr_):
        save_wav(cpath(idx), wav, sr_)

    # 🔴 BANKED CHUNKS ARE REUSED BY INDEX, SO THEY MUST BE FOR THIS CHUNK LIST. The count check
    # below only notices a chapter that got longer or shorter. A chapter whose text is cut
    # differently with the same count (an edited sentence, or the text cleaner above arriving
    # under a half-rendered chapter) kept its old audio at the old indexes, and the chapter was
    # stitched from sentences of both versions with nothing said. The mark holds the fingerprint
    # of the list the banked chunks were made for; no mark, or a different one, and they go.
    # A chunk folder from before 2026-10-12 has no mark, so a chapter that was part-way through
    # when this arrived is rendered again from its first chunk. Finished chapters are untouched.
    mark, want = chunks_dir / CHUNKS_MARK, chunks_fingerprint(chunks)
    try:
        have = vault_fs.read_text(mark).strip() if vault_fs.exists(mark) else None
    except (UnicodeDecodeError, ValueError):       # a damaged mark is a different one: render again
        have = None
    if have != want:
        banked = sorted(vault_fs.glob(chunks_dir, "chunk_*.wav"))
        if banked:
            logger.info(f"  ({len(banked)} banked chunk(s) removed: they were made for a different "
                        f"cut of this chapter's text, so the chapter is rendered again)")
            for name in banked:
                vault_fs.unlink(chunks_dir / name)
        vault_fs.write_text(mark, want)

    # Drop stale chunk files left by an earlier run with a different chunk count
    # (e.g. the .docx was edited or CHUNK_SIZE changed). They no longer match the
    # current text and would otherwise be silently concatenated or orphaned.
    # Routed: an empty glob here does not fail loudly, it just means "no stale chunks", so
    # an edited .docx left its old chunks banked and they were concatenated into the render.
    stale = [chunks_dir / n for n in sorted(vault_fs.glob(chunks_dir, "chunk_*.wav"))][total:]
    if stale:
        logger.info(f"  ({len(stale)} stale chunk(s) from a prior run removed — chunk count changed)")
        for p in stale:
            vault_fs.unlink(p)

    # Resume check, healing corrupt chunks (tts_utils.valid_or_remove — shared
    # with generate.py).
    done_idx = {i for i in range(total) if valid_or_remove(cpath(i))}
    if done_idx:
        logger.info(f"  ({len(done_idx)}/{total} chunks already done, resuming)")

    # Chunk-level dispatch across the pool. Workers finish out of order but each
    # writes its own indexed file, so the concat below stitches them in order.
    # SUBMITTED, not awaited: the wait is `finish_section`, so the caller can queue the next
    # chapter behind this one and keep every card fed past the boundary.
    missing = [(i, chunk) for i, chunk in enumerate(chunks) if i not in done_idx]
    batch = pool.submit_chunks(missing, params, save_chunk, total,
                               on_event=on_event, chapter=section['index'], cancel=cancel)
    return {"done": None, "section": section, "pool": pool, "params": params,
            "out_path": out_path, "batch": batch, "chunks": chunks, "total": total,
            "cpath": cpath, "save_chunk": save_chunk, "sr": sr,
            "on_event": on_event, "cancel": cancel}


def finish_section(h: dict) -> tuple:
    """Wait for a `start_section` handle's chunks, then assemble the section WAV.

    Returns `generate_section`'s tuple: (out_path, duration|None, new_chars, new_time)."""
    if h.get("done") is not None:
        return h["done"]
    section, pool, params = h["section"], h["pool"], h["params"]
    out_path, total, sr    = h["out_path"], h["total"], h["sr"]
    cpath, save_chunk      = h["cpath"], h["save_chunk"]
    chunks                 = h["chunks"]
    on_event, cancel       = h["on_event"], h["cancel"]

    new_chars, new_time = pool.collect_chunks(h["batch"])

    # Post-generation safety scan: catch any truncated chunks before concatenating.
    # Covers edge cases where generate_with_retry could not fix truncation inline.
    still_truncated = [i for i in range(total) if is_truncated_wav(cpath(i))]
    if still_truncated:
        logger.info(f"  Post-scan: {len(still_truncated)} truncated chunk(s) found — re-generating...")
        for i in still_truncated:
            # Use the vault-aware unlink for chunk files. Missing chunks are expected here because the retry below regenerates them; do not fail the whole book job on an already-absent entry.
            vault_fs.unlink(cpath(i), missing_ok=True)
        retry_items = [(i, chunks[i]) for i in still_truncated]
        nc, nt = pool.run_chunks(retry_items, params, save_chunk, total,
                                 on_event=on_event, chapter=section['index'], cancel=cancel)
        new_chars += nc
        new_time  += nt

    if cancel is not None and cancel.is_set():     # canceled mid-chapter — don't assemble a partial chapter
        return out_path, None, new_chars, new_time
    parts    = [load_wav(cpath(i))[0] for i in range(total)]
    combined = torch.cat(parts, dim=-1)
    save_wav(out_path, combined, sr)
    duration = combined.shape[-1] / sr

    # Chunks are left in place here; the CALLER deletes this section's chunk dir
    # (and this WAV) once the section's MP3 is safely encoded — never before, so
    # an interrupted encode still has its lossless material for the retry.
    return out_path, duration, new_chars, new_time


def generate_section(section: dict, pool: WorkerPool, params: GenParams, out_dir: Path, chunks_base: Path, on_event=None, cancel=None):
    """Render one section and wait for it — `start_section` then `finish_section`.

    ⚠️ SERIALIZES the pool at this section's boundary: nothing is queued behind these chunks,
    so every card goes idle as they drain. Right for a caller with nothing else to render (one
    chapter re-rendered on its own); wrong for a book, which should pipeline the two halves so
    the next chapter is already queued — see `start_section`.
    """
    return finish_section(start_section(section, pool, params, out_dir, chunks_base,
                                        on_event=on_event, cancel=cancel))


def total_mp3_duration(mp3_dir: Path) -> float | None:
    """Return total duration in seconds of all MP3s in mp3_dir, or None if ffprobe unavailable."""
    # Routed: output/<book>/mp3 is a vault tree, so the bare glob matched the CIPHERTEXT
    # names, found nothing, and this reported None — indistinguishable from "no ffprobe".
    mp3s = [mp3_dir / n for n in sorted(vault_fs.glob(mp3_dir, "*.mp3"))]
    if not mp3s:
        return None
    total = 0.0
    for mp3 in mp3s:
        try:
            total += ffprobe_duration(mp3) or 0.0     # shared probe (tts_utils)
        except FileNotFoundError:
            # ffprobe not installed / not on PATH — skip the duration report rather
            # than crash at the very end of an otherwise-successful run.
            logger.info("  (ffprobe not found — skipping total duration)")
            return None
    return total if total > 0 else None


def print_book_duration(out_dir: Path) -> None:
    """Print total MP3 duration for the book, if available."""
    secs = total_mp3_duration(out_dir / "mp3")
    if secs is None:
        return
    if secs >= 3600:
        bh, br = divmod(int(secs), 3600)
        logger.info(f"  Book     : {bh}h {br // 60}m total audio (all MP3s)")
    else:
        logger.info(f"  Book     : {int(secs) // 60}m total audio (all MP3s)")


# Do not estimate from a GPU-name lookup. Report an estimate only after measuring the selected device and worker configuration; `render_rate.py` stores those measurements.


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Convert a Word novel (.docx) to an audiobook via Chatterbox TTS",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("docx",  help="Path to the .docx file")
    parser.add_argument("--voice", metavar="REF.wav",
                        help="Reference audio for voice cloning (10 s WAV)")
    parser.add_argument("--out-dir", metavar="DIR",
                        help="Output folder (default: <docx name>_audiobook beside the docx)")
    parser.add_argument("--exaggeration", type=float, default=0.5,
                        metavar="0.25-2.0",
                        help="Emotional intensity / prosody range (standard model only, default 0.5). "
                             "Higher = more dramatic delivery; lower = flatter, more neutral.")
    parser.add_argument("--cfg",          type=float, default=0.5,
                        metavar="0.0-1.0",
                        help="CFG / pace weight (standard model only, default 0.5). "
                             "Higher = closer to reference voice pacing; lower = more free-form.")
    parser.add_argument("--temperature",  type=float, default=0.8,
                        help="Sampling temperature (default 0.8). "
                             "Higher = more varied output; lower = more deterministic.")
    parser.add_argument("--gpus", metavar="all|N,N|cpu", default="all",
                        help="Which GPUs to use: 'all' (default), a comma list of card "
                             "indices (e.g. 0,1), or 'cpu'.")
    parser.add_argument("--workers", type=int, default=1, metavar="N",
                        help="Concurrent generators (workers) per selected card (default 1). "
                             "Total pool = cards x workers. Raising this is measurably a LOSS: "
                             "two workers on one card gave 1.527x aggregate realtime where one "
                             "gave 1.604x, and cost ~3 GB more. The flag stays for experiments; "
                             "the web UI stopped offering it in 5.4.1.")
    parser.add_argument("--chapter-style", action="append", dest="chapter_styles",
                        metavar="STYLE",
                        help=f"Word style for chapter headings (repeatable; default: '{DEFAULT_CHAPTER_STYLE}')")
    parser.add_argument("--part-style",    action="append", dest="part_styles",
                        metavar="STYLE",
                        help=f"Word style for part headings (repeatable; default: '{DEFAULT_PART_STYLE}')")
    parser.add_argument("--toc-style", action="append", dest="toc_styles",
                        metavar="STYLE",
                        help="Word style to treat as TOC and skip (repeatable)")
    parser.add_argument("--list-styles",  action="store_true",
                        help="Print all paragraph styles in the doc and exit")
    parser.add_argument("--force-overwrite", action="store_true",
                        help="Delete and regenerate all existing WAVs, MP3s, and chunks (no manual cleanup needed)")
    args = parser.parse_args()
    paths.validate_runtime_roots()

    chapter_styles = args.chapter_styles or [DEFAULT_CHAPTER_STYLE]
    part_styles    = args.part_styles    or [DEFAULT_PART_STYLE]
    section_break_styles = {s.lower() for s in chapter_styles} | {s.lower() for s in part_styles}
    if section_break_styles != SECTION_BREAK_STYLES:
        logger.info(f"Section styles: parts={part_styles}  chapters={chapter_styles}")
    extra_toc_styles = {s.lower() for s in args.toc_styles} if args.toc_styles else None
    if extra_toc_styles:
        logger.info(f"TOC styles (skipped): {sorted(extra_toc_styles)}")

    # Install the vault router before any `vault_fs` call. The CLI must configure the process-wide store; otherwise routing is inert and writes can land in cleartext beneath a vault root.
    import vault_store
    store = vault_store.configure(vault_store.default_roots(), paths.DATA_DIR / "vault_keys.yaml")
    # `--list-styles` is allowed only when its input resolves outside every vault root. It reads styles without rendering or writing; a document inside a locked vault still requires an unlock key.
    exempt = args.list_styles and vault_store.route(Path(args.docx).resolve()) is None
    if store.is_initialized() and not store.is_unlocked() and not exempt:
        # Refuse UP FRONT rather than letting VaultLocked surface from somewhere deep in the
        # render. The chunk workspace lives under cache_root(), which is a vault root of its
        # own, so there is no --out-dir that makes this run safe: this process has no DEK and
        # cannot have one. A CLI password prompt is a design decision, not a bug fix.
        logger.error(
            "\nERROR: This Vocalis install is ENCRYPTED and this command has no key.\n"
            "\n"
            "  book_to_audio.py cannot render here: it would either fail to find your book\n"
            "  (its name on disk is ciphertext) or write the audiobook into the vault in the\n"
            "  CLEAR. Render from the web UI instead — it holds the key after you log in.\n")
        sys.exit(1)

    docx_path = Path(args.docx)
    # vault_fs, not Path — the same call and the same reasoning as /book/parse's (a97fea9):
    # the path is user-supplied and may legitimately be EITHER an uploaded book inside
    # books/ or a .docx anywhere else on the disk. vault_fs routes the first, plain-checks
    # the second. Bare, it rejected every book that had been uploaded through the UI.
    if not vault_fs.exists(docx_path):
        logger.error(f"\nERROR: File not found: {docx_path}\n")
        sys.exit(1)

    if args.list_styles:
        cmd_list_styles(docx_path, section_break_styles, extra_toc_styles)
        return

    setup_logging(make_log_path("book", docx_path.stem, paths.LOG_DIR))

    # ── Lazy-import PyTorch (skipped for --list-styles runs) ──────────────
    # (torchaudio no longer needed: WAV I/O goes through tts_utils.save_wav_sf /
    # load_wav, which use soundfile — torchaudio.save is unusable on the ROCm stack.)
    global torch
    import torch

    # ── Parse ─────────────────────────────────────────────────────────────
    logger.info(f"\nParsing the source document ...")     # not its NAME — that's the title
    sections = parse_docx(docx_path, section_break_styles, extra_toc_styles)

    if not sections:
        logger.error("\nERROR: No sections found. Run --list-styles to inspect the document.\n")
        sys.exit(1)

    total_words = sum(len(s['text'].split()) for s in sections)
    logger.info(f"Found {len(sections)} sections  |  {total_words:,} total words\n")
    for s in sections:
        words = len(s['text'].split())
        # The chapter TITLE used to be printed here — i.e. the whole table of contents
        # went into logs/, which lives outside the vault. Index + word count is what
        # actually diagnoses a bad parse; the titles are in the web UI, from book_state.
        logger.info(f"  [{s['index']:02d}]  {words:>6,} words")

    # ── Output dir ────────────────────────────────────────────────────────
    out_dir = Path(args.out_dir) if args.out_dir \
              else books_root(OUTPUT_DIR) / docx_path.stem
    # Routed, exactly as run_job's is: unrouted this named the BOOK'S TITLE in cleartext on
    # the platter. An `--out-dir` outside any store still lands on the plain arm unchanged.
    vault_fs.mkdir(out_dir)
    logger.info(f"{PRODUCT_NAME} v{VERSION} — book pipeline\n")
    logger.info(f"Output:  {out_dir.parent}{os.sep}…")     # the leaf dir IS the book title

    def _d(val, default): return f"{val}  (default)" if val == default else str(val)
    logger.info(f"Voice :  {args.voice or '(none)'}")
    logger.info(f"Exagg :  {_d(args.exaggeration, 0.5)}")
    logger.info(f"CFG   :  {_d(args.cfg,          0.5)}")
    logger.info(f"Temp  :  {_d(args.temperature,  0.8)}")

    # Chunks always keyed on the docx stem — stable even if --out-dir changes
    chunks_base = CHUNKS_ROOT / safe_name(docx_path.stem)

    # ── Resume check ──────────────────────────────────────────────────────
    if args.force_overwrite:
        todo       = sections
        done_count = 0
        logger.info("--force-overwrite: all existing WAVs, MP3s, and chunks will be deleted.")
    else:
        total_purged = 0
        for s in sections:
            n = purge_truncated_chunks(s, out_dir, chunks_base)
            if n:
                logger.info(f"  Found {n} truncated chunk(s) in ch {s['index']:02d} — will regenerate.")
                total_purged += n
        # Share the web job's resume predicate: encoded Opus or legacy MP3 chapters
        # and chapter WAVs are already rendered. All probes route through the vault.
        todo       = [s for s in sections if not section_rendered(out_dir, s['filename'])]
        done_count = len(sections) - len(todo)
        if done_count:
            logger.info(f"Resuming: {done_count}/{len(sections)} sections already complete.")
    if not todo:
        logger.info("\nAll sections already generated — nothing to do.")
        print_book_duration(out_dir)
        return

    if not args.voice:
        logger.warning("WARNING: No --voice specified. Output will use the model's default voice.\n")
    elif not vault_fs.exists(Path(args.voice)):   # voice_samples/ is a vault tree
        logger.error(f"\nERROR: Voice file not found: {args.voice}\n")
        sys.exit(1)

    if shutil.which("ffmpeg") is None:
        logger.error("\nERROR: ffmpeg not found in PATH — required for MP3 encoding.\n"
                     "Install ffmpeg and make sure it is on your PATH, then retry.\n")
        sys.exit(1)

    # ── Build the worker pool (loads one replica per worker) ──────────────
    devices       = parse_devices(args.gpus)
    total_workers = len(devices) * args.workers
    logger.info(f"Devices: {describe_devices(devices)}")
    logger.info(f"Workers: {args.workers} per card  ({total_workers} total)")

    # Do not present an unmeasured default as an ETA. Until a rate is measured for the selected device and worker configuration, report no estimate. `render_rate.py` stores measured rates.
    gpu        = render_rate.gpu_name()
    cards      = max(1, len([d for d in devices if str(d).startswith("cuda")]))
    rate_key   = render_rate.key_for(gpu, cards, args.workers)
    known_rate = render_rate.get(rate_key)
    todo_chars = sum(len(s['text']) for s in todo)

    if known_rate:
        est = render_rate.eta_seconds(todo_chars, known_rate)
        eh, rem = divmod(int(est), 3600)
        logger.info(f"Estimated time for {len(todo)} remaining sections: ~{eh}h {rem // 60}m")
        logger.info(f"  ({gpu} x{cards} — {known_rate:.1f} c/s, measured on this box; "
                    f"refines as chapters complete)\n")
    else:
        logger.info(f"Estimated time: not yet — this box has never been measured.")
        logger.info(f"  ({gpu} x{cards}, {args.workers} worker(s)/card — the estimate "
                    f"appears once ~{render_rate.MIN_CHARS:,} characters have rendered, and "
                    f"is remembered for next time.)\n")

    pool   = WorkerPool(devices, args.workers)
    params = GenParams(voice=args.voice, exaggeration=args.exaggeration,
                       cfg=args.cfg, temperature=args.temperature)

    # ── Generate ──────────────────────────────────────────────────────────
    total_audio_s  = 0.0
    total_new_chars = 0
    total_new_time  = 0.0      # summed WORKER time — a per-worker number, not an ETA
    gen_wall        = 0.0      # WALL clock spent generating — the only thing an ETA can use

    # 🔴 ONE SECTION OF LOOKAHEAD — the same fix as the web driver in vocalis/web/books.py.
    # Rendering a section and only THEN queueing the next drains the pool to empty at every
    # chapter boundary, and a satellite that takes a whole chapter in one submission leaves
    # every other card idle until it comes back. See `start_section`.
    LOOKAHEAD = 1
    queued, nxt = [], 0
    gen_t0    = None                 # arms on the first section that actually renders
    _loop_t0  = time.monotonic()

    def _queue_next(idx):
        """Delete-if-forced, then SUBMIT this section's chunks without waiting for them.

        The --force-overwrite delete moves here with the submit, a chapter earlier than it
        used to run. It only ever touches THIS section's own artifacts, so doing it while the
        previous chapter is still collecting changes nothing about what it removes.
        """
        s = todo[idx]
        if args.force_overwrite:
            wav_del  = out_dir / (s['filename'] + ".wav")
            mp3_del  = out_dir / "mp3" / (s['filename'] + ".mp3")
            cdir_del = chunks_base / s['filename']
            # Routed, all three: out_dir and chunks_base are both vault trees, so the plain
            # Path.exists() answered False for files that ARE there (encrypted name) and
            # --force-overwrite silently overwrote nothing.
            if vault_fs.exists(wav_del):  vault_fs.unlink(wav_del, missing_ok=True)
            if vault_fs.exists(mp3_del):  vault_fs.unlink(mp3_del, missing_ok=True)
            if vault_fs.exists(cdir_del): vault_fs.rmtree(cdir_del)
        return (idx, s, start_section(s, pool, params, out_dir, chunks_base))

    while True:
        # Top up BEFORE collecting, so the next chapter is already queued behind the one we
        # are about to wait on.
        while len(queued) <= LOOKAHEAD and nxt < len(todo):
            queued.append(_queue_next(nxt))
            nxt += 1
        if not queued:
            break
        run_idx, section, _handle = queued.pop(0)
        words  = len(section['text'].split())
        chunks = section_chunks(section)
        logger.info(f"\n{'='*65}")
        logger.info(f"[{section['index']+1}/{len(sections)}]  ch {section['index']:02d}")
        logger.info(f"  {words:,} words  |  {len(chunks)} chunks")
        # The ETA divides by WALL clock, not by total_new_time. total_new_time adds up each
        # chunk's own generation time across every worker, so on a two-card box it is about
        # twice the elapsed time — and this line used to quote the remaining book at twice
        # its real length. The user is waiting on the wall clock; only the wall clock
        # predicts it.
        if render_rate.enough(total_new_chars, gen_wall):
            overall_cps     = total_new_chars / gen_wall
            remaining_chars = sum(len(s['text']) for s in todo[run_idx:])
            eh, r           = divmod(int(remaining_chars / overall_cps), 3600)
            logger.info(f"  |  ETA ~{eh}h {r // 60}m  ({overall_cps:.1f} c/s, measured on this run)")
        elif total_new_chars:
            logger.info(f"  |  ETA: still measuring "
                        f"({total_new_chars:,}/{render_rate.MIN_CHARS:,} chars)")
        logger.info("\n")

        out_path, dur, new_chars, new_time = finish_section(_handle)
        total_new_chars += new_chars
        total_new_time  += new_time
        # A resumed section costs no GPU and returns 0 chars — counting its near-zero
        # seconds would send the measured rate to infinity.
        #
        # ⚠️ WALL CLOCK SINCE THE FIRST REAL SECTION, not a sum of per-section timers.
        # Sections OVERLAP now — the next chapter renders while this one is collected — so
        # per-section intervals double-count the overlap, and a sum of them reads the pool as
        # slower than it is. Characters over elapsed wall clock is what the ETA needs, and it
        # is the number this line has always been trying to be.
        if new_chars:
            if gen_t0 is None:
                gen_t0 = _loop_t0
            gen_wall = time.monotonic() - gen_t0

        if dur is not None:
            total_audio_s += dur
            logger.info(f"  [{out_path.name}]  "
                        f"{dur/60:.1f} min audio  generated in {new_time/60:.1f} min")
            if gen_wall > 0:
                logger.info(f"  Overall: {total_new_chars/gen_wall:.1f} c/s of wall clock"
                            f"  ({total_new_chars:,} chars in {gen_wall/60:.1f} min"
                            f"  — {total_new_time/gen_wall:.1f} workers busy on average)")
            # Opus is the preferred output for new chapters. Existing MP3 chapters remain valid and are not re-encoded; `chapter_encoded` recognizes both formats.
            mp3_path = book_state.chapter_encoded(out_path.parent, out_path.stem)
            try:
                if mp3_path is None:                  # routed: a bare exists() is always False,
                    mp3_path = wav_to_opus(out_path)      # so every chapter re-encoded
                    logger.info(f"  Encoded MP3: {mp3_path.name}")
                # The MP3 is the book's persistent artifact (96k mono is transparent
                # for this 24 kHz speech source); the WAV master and the chunk
                # workspace are transient — deleted the moment the MP3 is safely
                # down, so a finished book stops hoarding ~5x its listenable size.
                # Routed. `missing_ok=True` hid this exactly as it hid a97fea9's enhance
                # leak: the chapter WAV was never dropped, so every render kept its
                # lossless material forever.
                vault_fs.unlink(out_path, missing_ok=True)
                cdir = chunks_base / section['filename']
                if vault_fs.exists(cdir):         # routed — a plain .exists() said False
                    vault_fs.rmtree(cdir)         # and the workspace was kept forever
            except Exception as exc:           # encode failed: KEEP wav + chunks (retry material)
                logger.exception(f"  MP3 encode failed — keeping the WAV + chunks: {exc}")
        else:
            logger.info(f"\n  [{out_path.name}]  (already existed, skipped)")

    # ── Summary ───────────────────────────────────────────────────────────
    th, tr = divmod(int(total_audio_s), 3600)
    tm     = tr // 60
    # Chunk workspaces are cleaned per-section as each MP3 lands; what remains is
    # the (possibly empty) book dir itself, or chunks kept by a failed encode.
    try:
        # Routed: bare, exists() was False, so the empty chunk root was never pruned and
        # accumulated one directory per book rendered, forever.
        vault_fs.rmdir_if_empty(chunks_base)
    except OSError:
        pass

    logger.info(f"\n{'='*65}")
    logger.info(f"Audiobook complete!")
    logger.info(f"  Sections : {len(sections)}")
    if total_audio_s:
        logger.info(f"  Audio    : ~{th}h {tm}m of new audio generated")
    # Remember what this box actually did. The old advice here was "update CHARS_PER_SEC to
    # X for a better estimate next run" — a hand-edit nobody was ever going to make, and it
    # quoted the per-worker rate into a slot that was used as a whole-box one. Now the run
    # writes its own measurement and the next estimate reads it.
    if render_rate.enough(total_new_chars, gen_wall):
        render_rate.record(rate_key, total_new_chars, gen_wall)
        logger.info(f"  Rate     : {total_new_chars / gen_wall:.1f} c/s ({rate_key})"
                    f" — remembered; the next run estimates from it")
    logger.info(f"  Location : {out_dir}")
    print_book_duration(out_dir)


if __name__ == "__main__":
    try:
        main()
    except VocalisError as exc:        # bad --gpus / no loadable workers: clean exit
        logger.error(str(exc))
        sys.exit(1)
