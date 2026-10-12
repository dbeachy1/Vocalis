"""
Chatterbox TTS - Command-line generation tool

Usage examples:
  scripts\\generate.bat --file chapter01.txt -o chapter01.wav --voice my_voice.wav
  scripts\\generate.bat "Short inline text." -o test.wav
  scripts\\generate.bat --file script.txt -o out.wav --delete-chunks
  scripts\\generate.bat --help

Long files are split at sentence boundaries into ~400-char chunks.
Each chunk is saved as a numbered .wav in a work folder beside the output.
If the script is interrupted, re-running it skips already-completed chunks
and picks up where it left off (resume). At the end all chunks are kept
by default (pass --delete-chunks to remove them after concatenation).
"""
import argparse
from loguru import logger
import sys
import shutil
from pathlib import Path

import torch

from tts_utils import (split_into_chunks, filter_actions, chunks_fingerprint,
                       is_truncated_wav, valid_or_remove,
                       wav_to_mp3, save_wav_sf, save_wav_atomic, load_wav, wav_frames_sr,
                       setup_logging, make_log_path, PRODUCT_NAME, VERSION, WorkerPool,
                       GenParams, parse_devices, describe_devices, VocalisError)
import vault_fs
from vocalis.runtime import paths


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Chatterbox TTS — generate speech from text or a file",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("text", nargs="?", help="Inline text to synthesize (quote it)")
    source.add_argument("--file", "-f", metavar="TEXT_FILE",
                        help="Plain-text file to synthesize")

    parser.add_argument("-o", "--output", default="output.wav",
                        help="Final output WAV (default: output.wav)")
    parser.add_argument("--voice", metavar="REF.wav",
                        help="Reference audio for voice cloning (10 s WAV recommended)")
    parser.add_argument("--exaggeration", type=float, default=0.5,
                        metavar="0.25-2.0",
                        help="Emotional intensity / prosody range (standard model only, default 0.5). "
                             "Higher = more dramatic delivery; lower = flatter, more neutral.")
    parser.add_argument("--cfg", type=float, default=0.5,
                        metavar="0.0-1.0",
                        help="CFG / pace weight (standard model only, default 0.5). "
                             "Higher = closer to reference voice pacing; lower = more free-form.")
    parser.add_argument("--temperature", type=float, default=0.8,
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
    parser.add_argument("--delete-chunks", action="store_true",
                        help="Delete chunk .wav files after concatenation (default is to keep them)")
    parser.add_argument("--force", action="store_true",
                        help="Delete any existing chunks and regenerate from scratch (disables resume)")
    parser.add_argument("--chunks-dir", metavar="DIR",
                        help="Where to save chunk files (default: <output>_chunks/)")

    args = parser.parse_args()

    # -----------------------------------------------------------------------
    # Output path + logging (set up before any output so the log captures it all)
    # Default output and resumable chunks live under the configured data root. Explicit paths
    # remain available for one-off command-line runs.
    # -----------------------------------------------------------------------
    data_dir    = paths.DATA_DIR
    output_path = data_dir / "output" / args.output if args.output == "output.wav" \
                  else Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    setup_logging(make_log_path("generate", output_path.stem, paths.LOG_DIR))
    chunks_dir  = Path(args.chunks_dir) if args.chunks_dir \
                  else data_dir / "chunks" / output_path.stem

    logger.info(f"{PRODUCT_NAME} v{VERSION} — generate\n")

    # -----------------------------------------------------------------------
    # Load and chunk the text
    # -----------------------------------------------------------------------
    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            raw_text = f.read()
        logger.info(f"Input  : {args.file}  ({len(raw_text):,} chars)")
    else:
        raw_text = args.text

    # Asterisks are never narrated and a scene-break line ("***", "---") is a pause, not text:
    # the same cleaner as the book renderer (book_to_audio.section_chunks has the measurements).
    chunks = split_into_chunks(filter_actions(raw_text, stops="breaks"))
    total  = len(chunks)
    if total == 0:
        logger.info("\nNo text to synthesize — input was empty or whitespace only.")
        return
    logger.info(f"Chunks : {total}")

    def _d(val, default): return f"{val}  (default)" if val == default else str(val)
    logger.info(f"Voice  : {args.voice or '(none)'}")
    logger.info(f"Exagg  : {_d(args.exaggeration, 0.5)}")
    logger.info(f"CFG    : {_d(args.cfg,          0.5)}")
    logger.info(f"Temp   : {_d(args.temperature,  0.8)}")

    if args.force and chunks_dir.exists():
        shutil.rmtree(chunks_dir)
        logger.info("Force  : existing chunks deleted — regenerating from scratch")
    chunks_dir.mkdir(parents=True, exist_ok=True)

    def chunk_path(i: int) -> Path:
        return chunks_dir / f"chunk_{i:04d}.wav"

    # Banked chunks are reused by index, so they must be for THIS chunk list: same rule, and the
    # same mark file, as book_to_audio.start_section. A folder with no mark (made before
    # 2026-10-12) or a different one is rendered again from its first chunk.
    # Routed through vault_fs like the book renderer's: the chunk folder may be inside the vault.
    mark, want = chunks_dir / "chunks.sha256", chunks_fingerprint(chunks)
    try:
        have = vault_fs.read_text(mark).strip() if vault_fs.exists(mark) else None
    except (UnicodeDecodeError, ValueError):       # a damaged mark is a different one: render again
        have = None
    if have != want:
        banked = sorted(vault_fs.glob(chunks_dir, "chunk_*.wav"))
        if banked:
            logger.info(f"Resume : {len(banked)} banked chunk(s) removed — they were made for a "
                        f"different cut of this text")
            for name in banked:
                vault_fs.unlink(chunks_dir / name)
        vault_fs.write_text(mark, want)

    # Check for existing chunks (resume support), healing any corrupt ones
    # (tts_utils.valid_or_remove — shared with the book pipeline).
    done_idx = {i for i in range(total) if valid_or_remove(chunk_path(i))}
    if done_idx:
        logger.info(f"Resume : {len(done_idx)}/{total} chunks already exist, skipping them.\n")

    # -----------------------------------------------------------------------
    # Device selection + worker pool (built lazily — a fully-resumed run that
    # needs no generation never loads a model). Both the generation pass and the
    # post-scan share the same pool via ensure_pool().
    # -----------------------------------------------------------------------
    devices       = parse_devices(args.gpus)
    total_workers = len(devices) * args.workers
    sample_rate   = None
    pool          = None
    params        = GenParams(voice=args.voice, exaggeration=args.exaggeration,
                              cfg=args.cfg, temperature=args.temperature)

    def ensure_pool():
        nonlocal pool, sample_rate
        if pool is None:
            logger.info(f"Device : {describe_devices(devices)}")
            logger.info(f"Workers: {args.workers} per card  ({total_workers} total)")
            pool        = WorkerPool(devices, args.workers)
            sample_rate = pool.sr
        return pool

    def save_chunk(idx, wav, sr_):
        save_wav_atomic(chunk_path(idx), wav, sr_)

    # -----------------------------------------------------------------------
    # Generate missing chunks across the pool (indexed files → ordered concat)
    # -----------------------------------------------------------------------
    total_new_chars = 0
    total_new_time  = 0.0

    missing = [(i, chunk) for i, chunk in enumerate(chunks) if i not in done_idx]
    if missing:
        ensure_pool()
        nc, nt = pool.run_chunks(missing, params, save_chunk, total)
        total_new_chars += nc
        total_new_time  += nt
    else:
        logger.info("Model  : skipped (all chunks already generated)\n")

    # Sample rate from an existing chunk if the pool was never built (full resume)
    if sample_rate is None:
        for i in range(total):
            if chunk_path(i).exists():
                sample_rate = wav_frames_sr(chunk_path(i))[1]
                break

    # -----------------------------------------------------------------------
    # Post-generation safety scan: regenerate any chunk that hit the 1000-token
    # cap before concatenating, so truncated audio never reaches the final file.
    # Catches both freshly-generated and pre-existing (resumed) truncated chunks.
    # -----------------------------------------------------------------------
    still_truncated = [i for i in range(total) if is_truncated_wav(chunk_path(i))]
    if still_truncated:
        logger.info(f"\nPost-scan: {len(still_truncated)} truncated chunk(s) found — re-generating...")
        ensure_pool()
        for i in still_truncated:
            chunk_path(i).unlink()
        retry_items = [(i, chunks[i]) for i in still_truncated]
        nc, nt = pool.run_chunks(retry_items, params, save_chunk, total)
        total_new_chars += nc
        total_new_time  += nt

    # -----------------------------------------------------------------------
    # Concatenate all chunks into the final output
    # -----------------------------------------------------------------------
    logger.info(f"\nConcatenating {total} chunks → {args.output}")
    parts = []
    for i in range(total):
        wav, sr = load_wav(chunk_path(i))
        parts.append(wav)
        if sample_rate is None:
            sample_rate = sr

    combined = torch.cat(parts, dim=-1)
    save_wav_sf(str(output_path), combined, sample_rate)
    audio_s = combined.shape[-1] / sample_rate
    logger.info(f"Saved  : {output_path}  ({audio_s:.1f} s)")
    if total_new_time > 0:
        logger.info(f"Speed  : {total_new_chars / total_new_time:.1f} c/s  "
                    f"({total_new_chars:,} chars in {total_new_time:.1f}s generating)")
    try:
        logger.info(f"MP3    : {wav_to_mp3(output_path)}")
    except Exception as exc:                                   # WAV already saved; MP3 is a bonus
        logger.exception(f"MP3    : encode failed — {exc}")

    # -----------------------------------------------------------------------
    if args.delete_chunks:
        shutil.rmtree(chunks_dir)
        logger.info("Chunks : deleted")
    else:
        logger.info(f"Chunks : kept in {chunks_dir}")


if __name__ == "__main__":
    try:
        main()
    except VocalisError as exc:        # bad --gpus / no loadable workers: clean exit
        logger.error(str(exc))
        sys.exit(1)
