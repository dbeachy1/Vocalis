"""`/books`, `/book/*`, `/output/*` — the Books tab and the audiobook renderer (5.1-P4.11).

Fifteen routes and the job runner behind them: upload a .docx/.epub into the library, inspect
its chapters, start a render, watch it over SSE, cancel it, then browse, download, concatenate,
regenerate a chapter of, or wipe what came out. `run_job` is the biggest thing in this package
and it is here rather than in `runtime/` because nothing else calls it — it drives the pool, the
GPU gate and the enhance scheduler for ONE domain, and a runtime module that only books uses is
a layer wearing a hat.

**`/output/*` is books, not system** (§4.3). `output_list`, `output_file` and `output_concat`
carry a prefix that reads like a sibling of `/system/stats`, but every one of them resolves
through `_book_dir` and operates on a rendered book's folder. The domain table had them filed
under system until the P4.10a closure measured `_book_dir`'s five callers and found them all
here. Classify by what the body does, not by the URL prefix.

**`/library` is NOT here**, and it sits in the middle of the block this module came out of. It
answers `book_state.scan_library(OUTPUT_DIR)` for the whole output tree — the Library tab, not
the Books tab — so a line-range extraction would have taken it along, and compiled.

🔴 **`OUTPUT_DIR` and `CHUNKS_ROOT` are `book_to_audio`'s, and every importer captures its own
binding.** They are deliberately not re-exported anywhere: a third name would be a third place
to remember. A test that redirects the output tree has to patch this module's binding as well as
`vocalis_server`'s while the playground still lives there (`tests/test_m6_e2e.py:1951` states the
same rule for `runtime/configs.py`).

🔴 **`kobold_render_conflict` is INJECTED, and it is the only thing this module takes.** The
conflict check is kobold code by body and books code by caller (§4.3 applied to a helper), so it
comes in as a callable rather than being imported.

⚠️ **5.1.1: THREE CLAIMS THAT USED TO BE IN THIS PARAGRAPH WERE FALSE, AND ALL THREE WENT STALE
SILENTLY.** It said (a) the function "stays in `vocalis_server`" — it has been `web/kobold.py`
since P4.13; (b) it cannot move "before ledger item 3.10 gives them an owner" — 3.10 closed at
P4.15; and (c) the server passes a lambda rather than the object because "a dozen tests stub
`vs._kobold_cfg` wholesale and a captured reference would freeze the pre-patch binding" — no test
stubs `vs._kobold_cfg` (all 17 sites target `web_kobold._kobold_cfg`), and a captured object sees
a later stub anyway, because the capture freezes which function runs and not what it reads. This
is the §11 "a claim in a doc is a HYPOTHESIS" pattern three times over in one paragraph.

⚠️ **`rt_jobs`, not `jobs`.** `book_jobs` binds a local `jobs = list(JOBS.values())`, which makes
the name local for that whole body — the P3.4/P4.10a shape exactly, and the reason this codebase
spells its runtime imports `rt_*` wherever the bare name is a plausible local.
"""
import json
import queue
import re
import threading
import time
import uuid
import unicodedata
from pathlib import Path

from flask import Blueprint, Response, abort, jsonify, request

import book_state
import enhance
import render_rate
import scratch
import vault_fs
import vault_store
from book_to_audio import (CHUNKS_ROOT, OUTPUT_DIR, books_root, finish_section,
                           parse_docx, start_section, safe_name)
from epub_parser import parse_epub
from loguru import logger
from render_rate import gpu_name as _gpu_name   # the rate cache's machine identity, one definition
from store_serve import send_store_file
from tts_utils import GenParams, ffprobe_duration, wav_to_mp3, wav_to_opus
from vault import VaultAuthError

from vocalis.runtime import configs
from vocalis.runtime import enhancement
from vocalis.runtime import gpu
from vocalis.runtime import jobs as rt_jobs
from vocalis.runtime import params as rt_params
from vocalis.runtime import paths
from vocalis.runtime import pool as rt_pool
from vocalis.runtime import voices as rt_voices
from vocalis.runtime.gpu import GPUS
from vocalis.runtime.jobs import JOBS, JOBS_LOCK, Job, emit, prune_jobs as _prune_jobs
from vocalis.runtime.params import as_bool as _b, as_float as _f
import voice_utils

BOOK_EXTS = (".docx", ".epub")

#: In-flight master conversions, keyed by book (7.5.27). Module level for the same reason the
#: swap-queue runner is: the work outlives its request. Small and bounded — one entry per book
#: the user has converted this process lifetime, holding a status dict and nothing heavy.
_CONVERT = {}
_CONVERT_LOCK = threading.Lock()


def parse_book(path):
    """Route a book file to the right parser by extension (§7)."""
    return parse_epub(path) if str(path).lower().endswith(".epub") else parse_docx(path)


def _book_file_name(name: str) -> str:
    """Sanitize an uploaded filename to a safe <stem><ext> inside books/, keeping
    only a .docx/.epub extension. Strips path separators/traversal."""
    p = Path(name or "")
    ext = p.suffix.lower()
    if ext not in BOOK_EXTS:
        ext = ".docx"
    stem = re.sub(r'[^\w.\- ]', '', p.stem).strip() or "book"
    return stem + ext


def _books_file(name: str) -> Path:
    """Resolve books/<name>, rejecting anything that escapes the books dir."""
    f = (paths.BOOKS_DIR / name).resolve()
    if paths.BOOKS_DIR.resolve() not in f.parents:
        abort(400)
    return f


def _book_dir(book: str) -> Path:
    """Resolve output/books/<book>, rejecting path traversal. STRICT child only: book="."
    resolves to the books root itself, and every caller (clear/regenerate/concat/file)
    operates on a specific book subfolder — allowing the root would let
    /book/clear/. rmtree every rendered book at once.

    🔴 5.3 MOVED THE ROOT, and that is the whole point of the move. This used to resolve
    `output/<book>`, which put books in the same namespace as `output/playground`,
    `output/stems` and `output/voiceswap` — live data stores whose names are cleartext by
    design. The strict-child check below does NOT catch that: `output/playground` is a
    perfectly ordinary strict child and sailed straight through, so
    `POST /book/clear/playground {"confirm": "playground"}` passed the confirm token (it must
    equal the book name, which it did), passed this guard, found the store really there, and
    would have `rmtree`'d the entire clip library.

    A reserved-name blacklist was the other candidate fix. This is better: a blacklist has to
    be kept in step with `vault.STRUCTURAL` forever, whereas one container directory means a
    book called `playground` is simply `output/books/playground` and collides with nothing.
    """
    root = books_root(OUTPUT_DIR)
    d = (root / book).resolve()
    if root.resolve() not in d.parents:
        abort(400)
    return d


def _book_out_name(stem: str, voice: str) -> str:
    """Library/output folder name for a book rendered with `voice`: appends the narrator
    in parentheses so the same book with different voices lands in separate folders
    (never overwriting). Model default (no voice) keeps the plain stem."""
    n = rt_voices.narrator_name(voice)
    return f"{stem} ({n})" if n else stem


def _other_book_renders(stem: str, exclude: str) -> list:
    """Existing render folders for book `stem` under a *different* narrator than the folder
    `exclude`, newest first. Each entry: {folder, narrator, voice} where `voice` is the exact
    sample filename recorded in that render's sidecar (or None for the model default). Used to
    warn before a second narrator forks a separate library entry instead of resuming."""
    out = []
    # 🔴 `iterdir()` hands back the names ON DISK, which in a vault are ciphertext — so
    # `d.name == stem` and `startswith(prefix)` matched nothing, and this returned [] for
    # every book. The fork warning it exists to raise simply never fired on an encrypted
    # install: a second narrator silently forked a separate library entry, which is the exact
    # outcome the warning was added to prevent. listdir() decrypts the names.
    prefix = f"{stem} ("
    for name in vault_fs.listdir(books_root(OUTPUT_DIR)):
        d = books_root(OUTPUT_DIR) / name
        if not vault_fs.is_dir(d) or name == exclude:
            continue
        if not (name == stem or name.startswith(prefix)):
            continue
        if not book_state._book_stems(d):                 # no chapter audio => not a real render
            continue
        sc = book_state.load_sidecar(d) or {}
        narrator = name[len(prefix):-1] if name.startswith(prefix) else "the model default voice"
        try:                                   # routed: rglob/stat both read encrypted names
            st = vault_fs.stat(d)
            mtime = max((s.mtime for s in (vault_fs.stat(f) for f in vault_fs.rglob(d, "*"))
                         if s is not None), default=(st.mtime if st is not None else 0))
        except OSError:
            mtime = 0
        out.append({"folder": name, "narrator": narrator, "voice": sc.get("voice"), "mtime": mtime})
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def _begin_regen_swap(job: Job):
    """Execute a regenerate's planned file moves. Runs under GPUS, immediately
    before the re-render — NOT in the request handler — so a regen queued for hours
    behind a book job doesn't leave the chapter invisible (missing from Output and
    silently absent from a concat) for the whole wait."""
    # Every path here is a chapter artifact under output/ — a vault tree — so all three
    # operations route. Unrouted, .exists() was False for a chapter that IS there, so the
    # swap never happened: the regen then rendered ON TOP of the only copy with no backup
    # taken, and _resolve_regen_backups had nothing to restore if it failed.
    for orig_s, bak_s in job.regen_swap:
        orig, bak = Path(orig_s), Path(bak_s)
        if vault_fs.exists(orig):
            try:
                vault_fs.rename(orig, bak)
                job.regen_backups.append((bak_s, orig_s))
            except OSError:
                vault_fs.unlink(orig, missing_ok=True)   # rename blocked — fall back to delete
    if job.regen_chunks:
        vault_fs.rmtree(job.regen_chunks)      # a chunk workspace — in the vault
    job.regen_swap = []


def _resolve_regen_backups(job: Job, success: bool):
    """Finish a regenerate's safe-swap. On success drop the backups; on failure or
    cancel restore the originals, so a regen never destroys the only copy of a
    chapter. 'Landed' on success (3.x, WAVs transient): the chapter's MP3 exists —
    a fresh WAV also counts (encode still in flight, or encode failed but the render
    is real; restoring a stale artifact next to a new render would silently serve
    pre-regen audio). A backup whose chapter shows NEITHER is restored (the render
    produced nothing, e.g. the section now has no synthesizable text)."""
    # Decide every entry BEFORE restoring anything: restoring the .wav backup first
    # would make the .mp3 entry's 'landed' check see the restored file and wrongly
    # discard its sibling backup.
    # Routed throughout — backups and chapters alike live under output/. Unrouted, EVERY
    # probe was False, which made this loop a no-op that silently discarded nothing and
    # restored nothing: a failed regen left the chapter deleted and its backup orphaned.
    decided = []
    for bak, orig in job.regen_backups:
        bak, orig = Path(bak), Path(orig)
        if not vault_fs.exists(bak):
            continue
        if orig.suffix == ".mp3":
            wav_sibling = orig.parent.parent / (orig.stem + ".wav")
            mp3_path    = orig
        else:
            wav_sibling = orig
            mp3_path    = orig.parent / "mp3" / (orig.stem + ".mp3")
        decided.append((bak, orig, vault_fs.exists(mp3_path) or vault_fs.exists(wav_sibling)))
    for bak, orig, landed in decided:
        if success and landed:
            vault_fs.unlink(bak, missing_ok=True)       # new render landed — discard backup
        else:
            vault_fs.mkdir(orig.parent)
            try:
                vault_fs.rename(bak, orig)              # restore the original chapter
            except OSError:
                logger.warning(f"could not restore regen backup {bak} -> {orig}")
    job.regen_backups = []


def _pending_chapter_wavs(out_dir: Path) -> list:
    """Return chapter working files that are still awaiting MP3 enhancement. The files themselves are the queue: completed files are removed, and interrupted renders resume from the remaining WAV or Opus files."""
    # Routed: out_dir is under output/. Path.glob matches CIPHERTEXT names in a vault, so this
    # returned [] for every chapter — the enhance pass's to-do list was empty on an encrypted
    # install, and "still has a WAV means not finished" silently became "nothing is pending".
    # 🔴 `.opus` TOO, SINCE 7.5.27 — AND LEAVING IT OUT SILENTLY EMPTIES THIS LIST. The
    # working file is the to-do list, so anything that changes a working file's EXTENSION
    # changes what this function can see. 🎚 Convert working files to Opus does exactly that:
    # Include Opus working files too; otherwise converting a stranded WAV hides it from enhancement.
    # pass's view — the pass would have run, found nothing pending, and reported success on a
    # book with 38 chapters still unenhanced.
    #
    # ⚠️ Enhancing from a converted working file is enhancing from 192k Opus rather than from
    # the original PCM. That is a real if small quality difference, and it is unavoidable once
    # the WAV is gone — which is one more reason the encode should happen at render time
    # instead of being deferred behind a GPU pass that can be interrupted.
    return sorted(Path(out_dir) / n
                  for ext in (".wav", ".opus")
                  for n in vault_fs.glob(out_dir, f"*{ext}")
                  if not n[:-len(ext)].endswith("_full") and not n.endswith(f".part{ext}"))


def _enhance_chapter(job: Job, wav: Path, chunks_base: Path, device: str,
                     n: int, total: int) -> None:
    """One chapter: enhance the WAV, encode it at 256k, then drop the transient material."""
    scratch = enhance.scratch_path(configs.enhance_cfg(), wav, tag=f"book|{job.id}")
    scratch.parent.mkdir(parents=True, exist_ok=True)
    emit(job, {"type": "log",
               "line": f"[{n + 1}/{total}] enhancing “{wav.stem}” on {device}…"})
    try:
        if not enhancement.enhance_one(job, wav, scratch, job.enhance_nfe, device, wav.name):
            return                       # canceled — the WAV stays; the next run finishes it
        # The MP3 keeps the CHAPTER's stem. The enhanced WAV is a scratch derivative with a
        # hash for a name, and naming a chapter after it would sever the sidecar ↔ disk ↔
        # regenerate chain that every one of those keys on.
        # 7.5.30 — Opus 192k. This used to be 256k MP3 (enhance.mp3_bitrate(True)); Opus at
        # 192k is both smaller and better, so the enhanced and plain paths now agree on one
        # format and one bitrate instead of branching.
        wav_to_opus(wav, audio=scratch)
    finally:
        scratch.unlink(missing_ok=True)  # plaintext must not outlive the stage (5.0 §8.3)
    # 🔴 ROUTED — and `missing_ok=True` is what hid this. A chapter WAV is in output/, so the
    # bare unlink found nothing, said nothing, and left it. Two consequences, the second worse
    # than the first: every enhanced book kept a redundant chapter WAV forever (~1.7 GB for a
    # ten-hour book), and because THE WAV ON DISK *IS* THE TO-DO LIST (_pending_chapter_wavs),
    # every later render of that book re-enhanced every chapter from scratch — hours of GPU,
    # repeated, to produce MP3s that were already there.
    vault_fs.unlink(wav, missing_ok=True)   # MP3 is safely down — the WAV was always transient
    vault_fs.rmtree(chunks_base / wav.stem)        # in the vault; shutil's matched nothing
    emit(job, {"type": "log", "line": f"[{n + 1}/{total}] ✓ {wav.stem} — full quality, 256 kbps"})


def _enhance_book(job: Job, out_dir: Path, chunks_base: Path) -> None:
    """Bandwidth-extend every rendered chapter, one card per chapter, in parallel.

    Chapters are INDEPENDENT files, which is the one condition under which spreading
    across cards actually buys anything (enhance.estimate_seconds is explicit that `cards`
    only helps when there are that many independent files to spread). It is also the
    difference between the ~1.4 hours quoted for a ten-hour book and the ~2.8 it would take
    on one card — so the ETA the user agreed to is only honest if we do this.

    A worker takes its next chapter only once it holds its card's lock, so a card busy
    with a training simply contributes nothing until it frees up, and the other card
    carries on. Nobody stalls waiting for a specific card.
    """
    wavs = _pending_chapter_wavs(out_dir)
    if not wavs:
        return
    cards = enhancement.enhance_cards()
    if not cards:                        # validated at /book/start; belt and braces
        raise RuntimeError(enhancement.enhance_unavailable_reason())
    audio_s = sum(ffprobe_duration(p) or 0 for p in wavs)
    use = min(len(cards), len(wavs))
    est = enhance.estimate_seconds(audio_s, job.enhance_nfe, cards=use, files=len(wavs))
    emit(job, {"type": "stage", "stage": "enhance"})
    emit(job, {"type": "log",
               "line": f"\n=== Enhancing {len(wavs)} chapter(s) — {audio_s / 3600:.1f}h of "
                       f"audio at {job.enhance_nfe} steps on {use} card(s) · "
                       f"{enhance.eta_note(est)} ==="})

    todo = queue.Queue()
    for i, p in enumerate(wavs):
        todo.put((i, p))
    errors = []

    def worker(device):
        while not job.cancel.is_set():
            try:
                i, wav = todo.get_nowait()
            except queue.Empty:
                return
            try:
                _enhance_chapter(job, wav, chunks_base, device, i, len(wavs))
            except Exception as exc:                       # noqa: BLE001
                # NOT wav.name: a chapter WAV is named `<NN>_<safe_name(title)>.wav`
                # (book_to_audio.py:176), so the filename IS the chapter title, and
                # logs/vocalis.log sits outside the vault. The ordinal says which one.
                logger.exception(f"enhancement failed for chapter {i + 1}/{len(wavs)}")
                errors.append(exc)
                return

    threads = [threading.Thread(target=worker, args=(d,), daemon=True,
                               name=f"enhance-{job.id}-{d}") for d in cards[:use]]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if errors:
        # The chapters that DID enhance keep their MP3s; the rest keep their WAVs and are
        # picked up by the next run. Nothing is half-written either way.
        raise errors[0]


def run_job(job: Job):
    stop_vram = threading.Event()
    out_dir = None
    grand = 0.0
    try:
        job.status = "running"
        job.started_at = time.time()
        emit(job, {"type": "job_start", "id": job.id, "docx": job.docx})

        sections = parse_book(Path(job.docx))
        if not sections:
            raise RuntimeError("No chapters/sections detected in the document.")
        job.sections = [{"index": s["index"], "title": s["title"],
                         "words": len(s["text"].split())} for s in sections]
        emit(job, {"type": "sections", "sections": job.sections})

        run_sections = sections
        if job.only_section is not None:            # regenerate a single chapter
            run_sections = [s for s in sections if s["index"] == job.only_section]
            if not run_sections:
                raise RuntimeError(f"section {job.only_section} not found")

        devices = rt_pool.resolve_devices(job.gpus)
        emit(job, {"type": "log",
                   "line": f"Devices: {','.join(devices)}  |  {rt_pool.worker_note(job.workers, devices)}"})

        docx_path   = Path(job.docx)
        out_dir     = books_root(OUTPUT_DIR) / (job.out_name or docx_path.stem)
        # 🔴 ROUTED — and this one was VISIBLE ON THE PLATTER. `Vault.mkdir` maps through
        # `_enc_name`; a bare `Path.mkdir` does not, so every render created the book's
        # directory under its REAL TITLE in cleartext, right beside the correctly-SIV-named
        # one the routed writes then made. `ls output/` on the deployed box showed exactly
        # that: an empty `Routing Test Book/` next to `4OHWhsRTBJZ…`. The book title is the
        # user's content and it was sitting in the clear — the precise disclosure 5.0 exists
        # to prevent — and the orphan is also a `vault: … SKIPPED` waiting to happen, because
        # its name will never decrypt.
        vault_fs.mkdir(out_dir)
        chunks_base = CHUNKS_ROOT / safe_name(job.out_name or docx_path.stem)
        job.output_dir = str(out_dir)

        params_dict = {"exaggeration": job.params.exaggeration, "cfg": job.params.cfg,
                       "temperature": job.params.temperature}
        voice_path = (paths.VOICE_SAMPLES / job.voice) if job.voice else None

        # Serialize actual GPU work: only one job/playground drives the pool at a
        # time, so get_pool can't rebuild (2x VRAM) mid-generation on another thread.
        # The wait is cancel-aware: a job queued behind a long render can still be
        # canceled — an unconditional `with GPUS:` would make its Cancel button
        # a no-op until the current holder finished, hours later.
        waited = False
        while not GPUS.acquire(timeout=0.5):
            if not waited:
                waited = True
                emit(job, {"type": "log", "line": "Waiting for the GPUs (another job is using them)…"})
            if job.cancel.is_set():
                job.status = "canceled"
                emit(job, {"type": "log", "line": "Job canceled while waiting for the GPUs."})
                emit(job, {"type": "canceled", "total_duration": 0, "output_dir": str(out_dir)})
                return
        try:
            # Sidecar init + VRAM ticker start ONLY once the job actually holds the
            # GPUs: doing them at enqueue time let a regen queued behind an
            # hours-long render immediately rewrite the RUNNING job's sidecar
            # (resetting live chapters to pending / clobbering voice+params), and
            # gave every queued job its own 1 Hz ticker doing identical reads.
            book_state.init_sidecar(out_dir, docx_path.name, job.voice, voice_path, params_dict,
                                    sections, source_docx_path=str(docx_path),
                                    enhance=job.enhance, enhance_nfe=job.enhance_nfe)
            threading.Thread(target=rt_jobs.vram_ticker, args=(job, stop_vram), daemon=True).start()
            encode_threads = []
            _begin_regen_swap(job)      # regen only: move the old chapter aside NOW, not at enqueue
            pool = rt_pool.get_pool(devices, job.workers)

            # ── The render measures itself (DESIGN §6 / render_rate.py) ──────────
            # No default, no table of other people's cards: characters finished over
            # WALL-CLOCK seconds, on this box, in this configuration. Until there is
            # enough of it to mean anything, the ETA is not a worse number — it is no
            # number, and the strip says "measuring".
            rate_key = render_rate.key_for(_gpu_name(), gpu.cuda_count(devices), job.workers)
            gen_chars = gen_secs = 0.0
            # The rate's clock. `gen_t0` arms on the first section that actually renders, so a
            # run that resumes twenty finished chapters first does not count that scan as
            # render time; `_render_t0` is where the loop began, which is the honest start of
            # the wall clock once anything real happens (resumed sections cost ~0 s).
            gen_t0 = None
            _render_t0 = time.monotonic()
            chars_left = sum(len(s["text"]) for s in run_sections)
            seed = render_rate.get(rate_key)      # measured on a PREVIOUS run of this box
            emit(job, {"type": "eta", "measured": bool(seed), "rate": seed,
                       "eta_s": render_rate.eta_seconds(chars_left, seed) if seed else None,
                       "chars_left": chars_left, "from": "previous runs" if seed else None})

            # 🔴 ONE SECTION OF LOOKAHEAD, so the shared queue never runs dry at a chapter
            # boundary. Rendering a section and only THEN queueing the next drains the pool to
            # empty every chapter, and a satellite that takes a whole chapter in one submission
            # (`batch_slice` is 32) leaves every other card idle until it comes back — measured
            # One-section lookahead let a satellite take the full chapter batch while local cards waited.
            # 32 GB cards sat at 3% busy for the entire chapter.
            #
            # 🔴 The fix is more work in the queue, NEVER a smaller slice for the satellite:
            # batching is what it is for. `WorkerPool._drain_batch_mates` already stops at a
            # foreign batch, so the queued next chapter feeds the one-at-a-time local workers
            # while staying out of the satellite's submission. See book_to_audio.start_section.
            # 🔴 TWO, NOT ONE, SINCE 7.3.16. One section of lookahead was enough while the drain
            # stopped dead at a section boundary — that boundary was itself the thing keeping the
            # next chapter out of a satellite's submission. 7.3.15 removed it deliberately (a
            # chapter tail was handing over six chunks to a card asking for thirty), which also
            # removed the accidental depth it was providing: with two sections queued and a
            # Two queued sections can still be consumed by one satellite batch, leaving local cards idle.

            #
            # `_trim_to_capacity` now refuses to take more than half of what it can see, which
            # makes idling impossible; this makes the half worth having. Queued chunks are text,
            # so depth is nearly free — the cost of being shallow is real and the cost of being
            # deep is not.
            LOOKAHEAD = 2
            queued, nxt = [], 0
            while True:
                # Top up BEFORE collecting, so the next chapter is already queued behind the
                # one we are about to wait on.
                while len(queued) <= LOOKAHEAD and nxt < len(run_sections):
                    _s = run_sections[nxt]
                    nxt += 1
                    queued.append((_s, start_section(
                        _s, pool, job.params, out_dir, chunks_base,
                        on_event=lambda ev: emit(job, ev), cancel=job.cancel)))
                if not queued:
                    break
                section, _handle = queued.pop(0)
                i = section["index"]
                if job.cancel.is_set():
                    job.status = "canceled"
                    emit(job, {"type": "log", "line": "Job canceled."})
                    break
                emit(job, {"type": "section_start", "chapter": i, "total": len(sections),
                           "title": section["title"]})
                out_path, dur, _nc, _nt = finish_section(_handle)
                # Only work that was actually DONE feeds the rate. A resumed chapter costs
                # no GPU and returns 0 chars; counting its zero seconds would inflate the
                # rate to infinity and quote the rest of the book as instant.
                #
                # ⚠️ WALL CLOCK SINCE THE FIRST REAL SECTION, not a sum of per-section timers.
                # Sections now OVERLAP — the next chapter renders while this one is collected —
                # so per-section intervals double-count the overlap and a sum of them reads the
                # pool as slower than it is. The rate wants characters per second of wall clock
                # for the whole pool, and that is exactly what this measures.
                if _nc and not job.cancel.is_set():
                    if gen_t0 is None:
                        gen_t0 = _render_t0
                    gen_chars += _nc
                    gen_secs = time.monotonic() - gen_t0
                chars_left = max(0, chars_left - len(section["text"]))
                live = (gen_chars / gen_secs) if render_rate.enough(gen_chars, gen_secs) else None
                emit(job, {"type": "eta", "measured": bool(live or seed),
                           "rate": live or seed, "chars_left": chars_left,
                           "eta_s": render_rate.eta_seconds(chars_left, live or seed),
                           "from": "this run" if live else ("previous runs" if seed else None)})
                # All four probes below are on `out_path`, a chapter WAV in output/ — a vault
                # tree. Bare .exists() answered False for every finished chapter, so on an
                # encrypted install a cancel looked like "produced nothing", the MP3 encode
                # never fired, and update_chapter never recorded the chapter as done.
                if job.cancel.is_set() and not vault_fs.exists(out_path):
                    # Cancel stops after the current chunk: generate_section skipped the
                    # remaining chunks and did NOT assemble a partial chapter. Don't emit a
                    # bogus "(?s)" section_done or fall through to job_done — end cleanly as
                    # canceled (the top-of-loop check never re-fires on the last section).
                    job.status = "canceled"
                    emit(job, {"type": "log", "line": "Job canceled — stopped after the current chunk."})
                    break
                if dur is not None and vault_fs.exists(out_path) and not job.enhance:
                    # Encode off the GPU critical path: ffmpeg is pure CPU and an
                    # hour-long chapter takes tens of seconds — inline it and the
                    # GPUs idle under GPUS between every section. All encodes
                    # are joined before finalize below.
                    #
                    # ENHANCING? Then this chapter's WAV stays put and is dealt with by
                    # _enhance_book() after the loop. Enhancement is a ~21 GB GPU child
                    # and cannot share a card with a render (DESIGN §6) — and this render
                    # owns every card until its last chapter is down. So the WAVs wait
                    # here: ~1.7 GB for a ten-hour book, which is the price of not idling
                    # both GPUs for the length of an audiobook.
                    def _encode(path=out_path, cdir=chunks_base / section["filename"]):
                        try:
                            wav_to_opus(path)
                            # The ENCODED chapter is the persistent artifact (3.x, Opus
                            # since 7.5.30): the WAV + this section's chunk workspace are
                            # transient — deleted only now, with the encode safely down.
                            vault_fs.unlink(path, missing_ok=True)   # in the vault, like cdir
                            vault_fs.rmtree(cdir)     # in the vault; shutil's matched nothing
                        except Exception as mp3_exc:   # keep WAV + chunks (retry material)
                            logger.exception(f"MP3 encode failed for {path.name}")
                            emit(job, {"type": "log", "line": f"MP3 encode failed "
                                       f"(WAV + chunks kept): {mp3_exc}"})
                    t = threading.Thread(target=_encode, daemon=True)
                    t.start()
                    encode_threads.append(t)
                # The encoder can remove the chapter WAV before this thread gets here.
                # On resume, an Opus-only chapter has no WAV at all. In either case
                # the encoded chapter is still complete and belongs in the sidecar.
                encoded = book_state.chapter_encoded(out_dir, out_path.stem)
                if encoded is not None or vault_fs.exists(out_path):
                    d = dur if dur is not None else book_state.mp3_duration(encoded or out_path)
                    book_state.update_chapter(out_dir, i, status="done", voice=job.voice,
                                              duration_s=round(d, 1) if d else None)
                emit(job, {"type": "section_done", "chapter": i, "title": section["title"],
                           "file": out_path.name, "duration": dur})
                if job.cancel.is_set():     # canceled as this chapter finished — it's recorded, now stop
                    job.status = "canceled"
                    emit(job, {"type": "log", "line": "Job canceled."})
                    break
            for t in encode_threads:    # every chapter's MP3 lands before finalize
                t.join()
            # Remember what this box did, even if the run was canceled: a canceled render
            # still rendered real chapters at a real speed, and that is exactly the evidence
            # the next estimate needs. Recorded under GPUS, i.e. before any enhance pass
            # — enhancement is not rendering and must not be averaged into a render rate.
            if render_rate.enough(gen_chars, gen_secs):
                render_rate.record(rate_key, gen_chars, gen_secs)
                emit(job, {"type": "log",
                           "line": f"This box renders at {gen_chars / gen_secs:.1f} chars/sec "
                                   f"({rate_key}) — remembered for the next estimate."})
        finally:
            GPUS.release()

        # The enhance pass runs with the GPUs RELEASED — every chapter is rendered, and
        # the cards this needs are the cards the render was holding.
        if job.enhance and job.status != "canceled":
            _enhance_book(job, out_dir, chunks_base)
            if job.cancel.is_set():
                job.status = "canceled"

        # Grand total = sum of every done chapter recorded in the sidecar.
        sc = book_state.load_sidecar(out_dir) or {}
        grand = sum(c.get("duration_s") or 0 for c in sc.get("chapters", []))
        book_state.finalize(out_dir, grand)
        # Resolve regen backups BEFORE the terminal status/event becomes observable,
        # so a client that sees "failed"/"done" also sees the restored/final files.
        if job.status == "canceled":
            _resolve_regen_backups(job, success=False)
            emit(job, {"type": "canceled", "total_duration": round(grand, 1),
                       "output_dir": str(out_dir)})
        else:
            _resolve_regen_backups(job, success=True)
            job.status = "done"
            emit(job, {"type": "job_done", "total_duration": round(grand, 1),
                       "output_dir": str(out_dir)})
    except VaultAuthError as exc:                              # BOUNDARY 2 of 5 — BY NAME
        vault_store.fail_job_on_vault_auth(job, exc, emit)
        _resolve_regen_backups(job, success=False)             # RESTORES a backup; destroys nothing
    except Exception as exc:                                   # noqa: BLE001
        _resolve_regen_backups(job, success=False)
        job.status = "failed"
        # Same split as voiceswap.StageFailed / voicetrain.TrainFailed: the child's output
        # and the chapter title reach the BROWSER via `.detail`, and never str(exc), which
        # is what the logger.exception below writes to logs/vocalis.log.
        detail = getattr(exc, "detail", "")
        job.error = f"{exc} — {detail}" if detail else str(exc)
        logger.exception(f"job {job.id} failed")
        emit(job, {"type": "error", "message": job.error})
    finally:
        stop_vram.set()
        _resolve_regen_backups(job, success=(job.status == "done"))   # idempotent safety net


def create_books_blueprint(kobold_render_conflict) -> Blueprint:
    """`kobold_render_conflict()` -> the 409 payload or None; see the module docstring for why
    it is the one injected dependency and why the server hands over a lambda."""
    bp = Blueprint("vocalis_books", __name__)

    @bp.route("/books")
    def books_list():
        """Uploaded source documents available to render (browse instead of typing a path).

        The names come back from `vault.listdir()`, which decrypts them — the TITLES are the user's
        and stay encrypted on disk; only the constant `books/` is structural. And the size is the
        LOGICAL one: a raw stat here would report the ciphertext size of every book in the library.
        """
        vault_fs.mkdir(paths.BOOKS_DIR)
        names = sorted((n for n in vault_fs.listdir(paths.BOOKS_DIR)
                        if Path(n).suffix.lower() in BOOK_EXTS), key=str.lower)
        out = []
        for n in names:
            st = vault_fs.stat(paths.BOOKS_DIR / n)
            out.append({"name": n, "size": st.size if st else 0})
        return jsonify(out)


    @bp.route("/books", methods=["POST"])
    def books_upload():
        """Upload a .docx/.epub into the books/ library."""
        if "file" not in request.files:
            return jsonify({"error": "no file uploaded (form field 'file')"}), 400
        f = request.files["file"]
        if Path(f.filename or "").suffix.lower() not in BOOK_EXTS:
            return jsonify({"error": "Only .docx or .epub are accepted."}), 400
        name = _book_file_name(f.filename)
        vault_fs.mkdir(paths.BOOKS_DIR)
        dst = paths.BOOKS_DIR / name
        overwrite = _b(request.form, "overwrite")
        if vault_fs.exists(dst) and not overwrite:
            return jsonify({"error": "exists", "name": name}), 409
        # 🔴 5.0-M6: `f.save(str(dst))` wrote THE WHOLE BOOK straight into books/, which is in the
        # vault — a plaintext manuscript in the encrypted store, and nothing anywhere would have
        # said so. Werkzeug's FileStorage can only save to a real path, so it saves to the SCRATCH
        # and the bytes come back through the cipher. The book is the one thing in this application
        # that is unambiguously the user's words.
        with scratch.file(configs.scratch_root(), f"book-upload|{name}",
                          Path(name).suffix or ".bin") as tmp:
            f.save(str(tmp))
            vault_fs.from_scratch(tmp, dst)
        st = vault_fs.stat(dst)
        return jsonify({"name": name, "size": st.size if st else 0})


    @bp.route("/books/<name>/inspect")
    def books_inspect(name):
        """Size + parsed chapters + total word/character count for a library book (shown on
        select).

        `chars` is what the Enhance ETA is built from: characters ÷ chars-per-audio-second
        gives the book's AUDIO length, and audio length × the per-step rate gives the hours of
        GPU the user is about to agree to. Words can't do that job — words vary in length and
        the measured constant is per character."""
        f = _books_file(name)
        if not vault_fs.exists(f):      # books/ is a vault tree — inspect 404'd for every book
            abort(404)
        try:
            sections = parse_book(f)
        except Exception as exc:                                   # noqa: BLE001
            return jsonify({"error": f"parse failed: {exc}"}), 400
        chapters = [{"index": s["index"], "title": s["title"],
                     "words": len(s["text"].split()), "chars": len(s["text"])}
                    for s in sections]
        # `f.stat()` was the NEXT unrouted call behind the .exists() one above — routing the guard
        # only moved the failure from a 404 to a 500. vault_fs.stat also returns the PLAINTEXT
        # size, which is the number this endpoint means; the physical size is the ciphertext's.
        _st = vault_fs.stat(f)
        return jsonify({"name": f.name, "size": _st.size if _st else 0, "path": str(f),
                        "chapters": chapters,
                        "words": sum(c["words"] for c in chapters),
                        "chars": sum(c["chars"] for c in chapters)})


    @bp.route("/books/<name>", methods=["DELETE"])
    def books_delete(name):
        """Remove a source document from the library (rendered audio in output/ is untouched)."""
        f = _books_file(name)
        if not vault_fs.exists(f):      # books/ is a vault tree — see book_clear (039a219)
            abort(404)
        vault_fs.unlink(f)
        return jsonify({"ok": True, "name": f.name})


    @bp.route("/book/parse", methods=["POST"])
    def book_parse():
        data = request.get_json(force=True) or {}
        path = Path(str(data.get("path", "")).strip('"'))
        # vault_fs.exists, NOT Path.exists — and it has to be this one, because the path is
        # user-supplied and may legitimately be EITHER. `books_inspect` hands the UI the books/
        # path of an uploaded book, which is inside the vault; a typed-in path to a .docx
        # elsewhere on the disk is not. vault_fs routes the first and plain-checks the second.
        if not vault_fs.exists(path):
            return jsonify({"error": f"File not found: {path}"}), 400
        if path.suffix.lower() not in BOOK_EXTS:
            return jsonify({"error": "Only .docx or .epub are accepted."}), 400
        try:
            sections = parse_book(path)
        except Exception as exc:                                   # noqa: BLE001
            return jsonify({"error": f"parse failed: {exc}"}), 400
        return jsonify({"path": str(path), "chapters": [
            {"index": s["index"], "title": s["title"],
             "words": len(s["text"].split()), "chars": len(s["text"])}
            for s in sections]})


    @bp.route("/book/start", methods=["POST"])
    def book_start():
        data = request.get_json(force=True) or {}
        path = Path(str(data.get("path", "")).strip('"'))
        # Routed for the same reason as /book/parse: an UPLOADED book lives in the books/ vault
        # tree, so a bare .exists() rejected every one of them — "Valid .docx or .epub path
        # required" for the exact path /books/<name>/inspect had just handed the UI. The book
        # pipeline, which is the application's main feature, could not start a render at all.
        if not vault_fs.exists(path) or path.suffix.lower() not in BOOK_EXTS:
            return jsonify({"error": "Valid .docx or .epub path required."}), 400
        voice = str(data.get("voice", "")).strip()
        # → a real clip inside voice_samples/, any audio extension; path-safe.
        voice = rt_voices.resolve_leaf(voice) if voice else ""

        # Each narrator renders into its own "<book> (Narrator)" folder, so voices never
        # overwrite. Resume is keyed on the narrator alone: re-selecting a voice picks its
        # existing folder back up (mid-book settings tweaks don't force a re-render).
        out_name = _book_out_name(path.stem, voice)

        err = rt_params.voice_file_error(voice)
        if err is not None:
            return err

        # This narrator has no render yet, but the book exists under a different one: warn
        # that a new voice forks a SEPARATE library entry rather than continuing the current
        # render. The client re-POSTs with confirm_new_narrator once the user says yes.
        # vault_fs.exists — encrypted, a bare check never sees an existing render, so every book
        # would look un-rendered and the "a new voice forks a separate entry" warning would fire on
        # every re-render under the SAME narrator. Also §4.10's class, also not inventoried.
        if (not vault_fs.exists(books_root(OUTPUT_DIR) / out_name)
                and not _b(data, "confirm_new_narrator")):
            others = _other_book_renders(path.stem, out_name)
            if others:
                prev = others[0]
                return jsonify({"error": "different_narrator", "book": path.stem,
                                "prev_narrator": prev["narrator"], "prev_voice": prev["voice"] or "",
                                "new_narrator": rt_voices.narrator_name(voice)
                                                or "the model default voice"}), 409
        voice_path = str(paths.VOICE_SAMPLES / voice) if voice else None
        try:
            params = GenParams(
                voice=voice_path,
                exaggeration=_f(data, "exaggeration", 0.5, lo=0, hi=3),
                cfg=_f(data, "cfg", 0.5, lo=0, hi=1),
                temperature=_f(data, "temperature", 0.8, lo=0, hi=3),
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        # Enhancement defaults on for a book and is validated before a long render starts — a book render is
        # hours long and the enhance pass is at the END of it, so a missing toolchain must not
        # be discovered after the GPUs have already been spent.
        enhance_on, nfe, err = rt_params.enhance_opts(data)
        if err is not None:
            return err

        # A book's enhance setting is a property of the BOOK, not of a render. Chapters 1-3
        # dull and 4-12 crisp is a worse audiobook than either one consistently — so once a
        # book has committed chapters to disk, its setting is fixed and a render that
        # disagrees is refused rather than quietly allowed to produce that. The client offers
        # to continue with the setting the book already has (or to clear it and start over);
        # there is deliberately no "confirm and mix anyway", because there is no good outcome
        # behind that button.
        locked = book_state.book_enhance_lock(books_root(OUTPUT_DIR) / out_name)
        if locked is not None and locked[0] != enhance_on:
            return jsonify({"error": "enhance_locked", "book": out_name,
                            "enhance": locked[0], "nfe": locked[1],
                            "rendered": book_state.rendered_chapters(
                                books_root(OUTPUT_DIR) / out_name)}), 409
        if locked is not None and locked[0]:
            nfe = enhance.validate_nfe(locked[1])    # the book's own step count wins on resume

        # LAST gate before the job exists, and the hook is the REQUEST, not the job thread —
        # same reasoning `GpuGate.claim_card` documents (runtime/gpu.py). A book render takes
        # every card for hours; if KoboldCpp is sitting on this box's VRAM, say so now, while a
        # click can still change it. `force` is the `comfyui_restart` idiom (web/comfyui.py):
        # 409 with a machine-readable reason, client re-sends with intent. Nothing new invented.
        if not _b(data, "force"):
            conflict = kobold_render_conflict()
            if conflict is not None:
                return jsonify(conflict), 409

        job = Job(
            id=uuid.uuid4().hex[:12],
            docx=str(path),
            voice=voice,
            params=params,
            # GPUs/workers are GLOBAL settings (⚙ Settings tab) — request-body values
            # are a leftover from when these lived per-render and are ignored (as is
            # `turbo`: the engine choice died app-wide in 3.x).
            gpus=rt_pool.default_devices(),      # satellites included — see pool.resolve_devices
            workers=rt_pool.default_workers(),
            enhance=enhance_on,
            enhance_nfe=nfe,
            out_name=out_name,
        )
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        return jsonify({"job_id": job.id})


    @bp.route("/book/status/<job_id>")
    def book_status(job_id):
        job = rt_jobs.job_or_404(job_id)
        # Chapters already done on disk (this run or a prior resume), from the sidecar —
        # the SSE ring may have evicted early section_done events on a long render, so a
        # reloading page needs this to repaint its chapter done-marks authoritatively.
        done = []
        if job.output_dir:
            sc = book_state.load_sidecar(job.output_dir) or {}
            done = [c.get("index") for c in sc.get("chapters", []) if c.get("status") == "done"]
        return jsonify({"id": job.id, "status": job.status, "error": job.error,
                        "docx": job.docx, "voice": job.voice, "workers": job.workers,
                        "gpus": job.gpus, "sections": job.sections,
                        "output_dir": job.output_dir,
                        # Resume-on-reload: everything a fresh page needs to reattach.
                        # started_at/now give real elapsed without trusting client clocks.
                        "started_at": job.started_at, "now": time.time(),
                        "kind": job.kind, "text": job.text,
                        "narrate_actions": job.narrate_actions, "clip": job.clip_ref,
                        # 4.1: a reloading page repaints the Enhance box, the cap box and the
                        # live duration counter from the JOB, never from localStorage — the
                        # server is the only thing that knows what is actually rendering.
                        "enhance": job.enhance, "nfe": job.enhance_nfe,
                        "cap60": job.cap60, "capped": job.cap_hit.is_set(),
                        "audio_s": round(job.audio_s, 1),
                        "only_section": job.only_section,
                        "canceling": job.cancel.is_set() and job.status in ("queued", "running"),
                        "done_sections": done,
                        # A job that renders no speech (a music job) has no speech parameters.
                        # October 12, 2026: this route answered 500 for one, and the Music tab
                        # asks it when it reattaches to a running music job.
                        "params": None if job.params is None else {
                            "exaggeration": job.params.exaggeration, "cfg": job.params.cfg,
                            "temperature": job.params.temperature}})


    @bp.route("/book/events/<job_id>")
    def book_events(job_id):
        job = rt_jobs.job_or_404(job_id)

        def stream():
            q = queue.Queue()
            with job.lock:
                backlog = list(job.events)
                job.subscribers.append(q)
            terminal = ("job_done", "error", "canceled")
            try:
                for ev in backlog:
                    yield f"data: {json.dumps(ev)}\n\n"
                    if ev["type"] in terminal:
                        return                 # job already finished — replay done, stop
                while True:
                    ev = q.get()
                    yield f"data: {json.dumps(ev)}\n\n"
                    if ev["type"] in terminal:
                        break
            finally:
                with job.lock:
                    if q in job.subscribers:
                        job.subscribers.remove(q)

        return Response(stream(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


    @bp.route("/book/cancel/<job_id>", methods=["POST"])
    def book_cancel(job_id):
        job = rt_jobs.job_or_404(job_id)
        first = not job.cancel.is_set()
        job.cancel.set()
        # Server-side acknowledgment in the live log: chunks ALREADY generating on the
        # GPUs can't be preempted mid-synthesis (up to workers x cards of them), so the
        # user must see that the cancel landed and what's draining — otherwise a minute
        # of in-flight stragglers reads as "cancel didn't work".
        if first and job.status in ("queued", "running"):
            # `job.workers` is a per-device DICT since 5.3-m3, so interpolating it rendered
            # "(up to {'cuda:0': 1, 'satellite-a:cuda:0': 3} per card)" into a message the user reads
            # at the one moment they are anxious about whether cancel worked. `worker_note`
            # exists for exactly this and already handles both shapes — it was written for the
            # job log line and this second site was missed. "per card" is also gone: with
            # per-device counts the total in flight is the number that means anything.
            in_flight = rt_pool.worker_note(job.workers, rt_pool.resolve_devices(job.gpus))
            emit(job, {"type": "log",
                       "line": "Cancel received — chunks already on the GPUs will finish "
                               f"(up to {in_flight} in flight); nothing new starts."})
        return jsonify({"ok": True, "status": job.status})


    @bp.route("/book/jobs")
    def book_jobs():
        with JOBS_LOCK:
            jobs = list(JOBS.values())
        labels = voice_utils.get_labels(paths.VOICE_SETTINGS)
        rows = []
        for j in jobs:
            row = {"id": j.id, "docx": Path(j.docx).name if j.docx else "", "status": j.status,
                   "kind": j.kind, "workers": j.workers, "gpus": j.gpus,
                   "output_dir": j.output_dir}
            if j.kind == "book":
                # `out_name` is assigned at registration, before output_dir exists.
                # It is the stable library reference throughout the render lifecycle.
                row["book"] = j.out_name
                row["voice"] = j.voice
                sc = book_state.load_sidecar(books_root(OUTPUT_DIR) / j.out_name) or {}
                row["display_name"], row["voice_label"] = book_state.presentation_name(
                    j.out_name, {"source_docx": Path(j.docx).name if j.docx else "",
                                 "voice": j.voice, **sc}, labels)
            rows.append(row)
        return jsonify(rows)


    @bp.route("/book/<book>/rename", methods=["POST"])
    def book_rename(book):
        """Set an explicit library title for an existing or registered live book."""
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not isinstance(data.get("name"), str):
            return jsonify({"error": "name must be a string"}), 400
        raw_name = data["name"]
        if any(unicodedata.category(ch) in ("Cc", "Cf") for ch in raw_name):
            return jsonify({"error": "name cannot contain control characters"}), 400
        name = raw_name.strip()
        if not name or len(name) > 512:
            return jsonify({"error": "name must be 1–512 characters and contain no control characters"}), 400

        d = _book_dir(book)
        with book_state._sidecar_lock(d):
            sidecar_exists = vault_fs.exists(book_state.sidecar_path(d))
            has_audio = bool(book_state._book_stems(d)) if vault_fs.exists(d) else False
            with JOBS_LOCK:
                registered_live_job = any(
                    j.kind == "book" and j.out_name == book and j.status in ("queued", "running")
                    for j in JOBS.values())
            if not (sidecar_exists or has_audio or registered_live_job):
                abort(404)
            try:
                sc = book_state._load_sidecar_unlocked(d, strict=True) or {}
                book_state._rename_book_unlocked(d, sc, name)
            except book_state.SidecarUnreadable:
                return jsonify({"error": "book metadata is unreadable"}), 409
            except OSError as exc:
                logger.warning("book rename failed (%s)", type(exc).__name__)
                return jsonify({"error": "book metadata could not be saved"}), 500
        logger.info("book rename completed")
        return jsonify({"book": book, "display_name": name})


    @bp.route("/output/<book>")
    def output_list(book):
        d = _book_dir(book)
        # Sidecar-only folders (render stopped before chapter 1 finished) are still
        # openable — the tab shows the book with no finished chapters yet.
        if not vault_fs.exists(d) or (not book_state._book_stems(d)   # output/ is a vault tree
                                      and not book_state.load_sidecar(d)):
            abort(404)
        return jsonify(book_state.scan_book(
            d, voice_labels=voice_utils.get_labels(paths.VOICE_SETTINGS)))


    @bp.route("/output/<book>/file/<path:fname>")
    def output_file(book, fname):
        d = _book_dir(book)
        # allow top-level (book_full.mp3, chapter.wav) and mp3/ subdir files
        candidate = (d / fname).resolve()
        # The containment check is pure path math and still holds; the EXISTENCE check is not, and
        # output/<book>/ is in the vault.
        if d.resolve() not in candidate.parents or not vault_fs.exists(candidate):
            abort(404)
        download = request.args.get("download") == "1"
        # send_store_file hand-rolls the 206 through vault.stream_range() — scrubbing to 01:12:30 of
        # a 90-minute audiobook decrypts one 64 KiB block, not ninety minutes of audio.
        if not download:
            return send_store_file(candidate)
        # `_enhanced` on the name the USER ends up with. It goes here rather than on the stem
        # on disk because a chapter's stem is a structural key — the sidecar, the chunk
        # workspace and the regenerate button all resolve through it — while the download
        # name is a user-facing download label. Keep the on-disk stem unchanged because sidecars, chunks, and regeneration resolve through it.
        # training WAV, whose on-disk name is a bare sha256 by design, §5.7.)
        name = candidate.name
        if (book_state.load_sidecar(d) or {}).get("enhance"):
            name = f"{candidate.stem}_enhanced{candidate.suffix}"
        return send_store_file(candidate, as_attachment=True, download_name=name)


    @bp.route("/output/<book>/audiobook/<filename>", methods=["DELETE"])
    def output_delete_audiobook(book, filename):
        # The only deletable exports are the book's own canonical full-audiobook names.
        # This leaf allowlist excludes chapter files, subdirectories, and traversal names.
        if (not book or "/" in book or "\\" in book or Path(book).name != book
                or not filename or Path(filename).name != filename
                or "/" in filename or "\\" in filename):
            abort(400)
        d = _book_dir(book)
        if d.name != book:
            abort(400)
        allowed = {f"{book}_full{ext}" for ext in book_state.FULL_EXTS}
        if filename not in allowed:
            abort(400)
        path = d / filename
        if not vault_fs.exists(path):
            abort(404)
        vault_fs.unlink(path)
        return jsonify({"deleted": filename})


    @bp.route("/output/<book>/concat", methods=["POST"])
    def output_concat(book):
        d = _book_dir(book)
        if not vault_fs.exists(d):      # output/ is a vault tree
            abort(404)
        # The build sources the chapter MASTERS first, then finished encoded chapters — see
        # concat_book. Rebuilding is always allowed and always re-runs: "Create single
        # audiobook" reported success without doing anything visible, because a stream copy of
        # the same chapters is deterministic and lands the same bytes. It was not a no-op; it
        # just could not produce anything different while MP3 was the only output it had.
        data = request.get_json(silent=True) or {}
        fmt = str(data.get("format") or "opus").lower()
        if fmt not in {"opus", "mp3", "aac"}:
            return jsonify({"error": f"unsupported audiobook format: {fmt}"}), 400
        bitrate = data.get("bitrate", 192)
        if isinstance(bitrate, bool) or not isinstance(bitrate, int) \
                or bitrate not in book_state.SINGLE_BOOK_BITRATES:
            return jsonify({"error": f"unsupported audiobook bitrate: {bitrate}"}), 400
        try:
            full = book_state.concat_book(d, book, fmt, f"{bitrate}k")
        except Exception as exc:                                   # noqa: BLE001
            return jsonify({"error": str(exc)}), 400
        # Routed, like books_inspect's — and for the third time in this file, the bare `.stat()`
        # was the call sitting BEHIND a routed `.exists()`. The concat itself had already
        # succeeded; only the line reporting its size failed, turning a finished job into a 500.
        # vault_fs.stat also gives the PLAINTEXT size, which is the number a download dialog means.
        _st = vault_fs.stat(full)
        # 🔴 SAY HOW MANY CHAPTERS WENT IN, AND WHAT THE BOOK'S OWN TOTAL IS. The modal used to
        # report only name/size/duration, and "11h45m of chapters became a 1h17m audiobook" is
        # invisible in that phrasing — it reads as a result, not as a warning. Both numbers, so
        # a mismatch is readable at a glance instead of discovered at the end of a long listen.
        info = book_state.scan_book(d)
        return jsonify({"file": full.name, "size": _st.size if _st else 0,
                        "duration_s": round(book_state.mp3_duration(full), 1),
                        "chapters": len(info["chapters"]),
                        "book_duration_s": info["total_duration_s"]})


    @bp.route("/book/<book>/convert", methods=["POST"])
    def book_convert(book):
        """Re-encode this book's WAV chapter masters to Opus 192k, in place. Body: {bitrate}.

        🔴 IT RUNS IN A THREAD AND REPORTS THROUGH `/book/<book>/convert/status`, because forty
        chapters of an eleven-hour book is minutes of ffmpeg. Done synchronously it would hold the
        request open past every sane timeout and look like a hang — the same trap `build_index`
        still sits in, where a deploy-time restart kills work nothing can see.

        🔴 AND IT HAS TO BE A ROUTE, NOT A SCRIPT. The book tree is encrypted at the application
        layer and the DEK lives in THIS process's memory. A standalone CLI is a different process
        with no key: it reads ciphertext filenames and reports an empty book, which is
        indistinguishable from the files being gone. Nothing outside this process can do it."""
        d = _book_dir(book)
        if not vault_fs.exists(d):
            abort(404)
        data = request.get_json(silent=True) or {}
        bitrate = str(data.get("bitrate") or "192k")
        with _CONVERT_LOCK:
            live = _CONVERT.get(book)
            if live and live.get("status") == "running":
                return jsonify({"error": "already converting this book"}), 409
            _CONVERT[book] = {"status": "running", "done": 0, "total": 0, "chapter": ""}

        def _run():
            def progress(i, total, name):
                with _CONVERT_LOCK:
                    _CONVERT[book].update({"done": i, "total": total, "chapter": name})
            try:
                out = book_state.convert_chapter_masters(d, bitrate=bitrate, progress=progress)
                with _CONVERT_LOCK:
                    _CONVERT[book] = {"status": "done", **out}
            except Exception as exc:                                   # noqa: BLE001
                logger.exception("book master conversion failed")
                with _CONVERT_LOCK:
                    _CONVERT[book] = {"status": "failed", "error": str(exc)}

        threading.Thread(target=_run, daemon=True).start()
        return jsonify({"started": True})


    @bp.route("/book/<book>/convert/status")
    def book_convert_status(book):
        with _CONVERT_LOCK:
            return jsonify(_CONVERT.get(book) or {"status": "idle"})


    @bp.route("/book/<book>/finish", methods=["POST"])
    def book_finish(book):
        """Give every unfinished chapter its encoded file. Body: {bitrate}.

        The exit from the zombie state: a chapter with a working file and no encoded file was
        un-playable as a chapter, un-reclaimable (it is the only copy), and had no action that
        would finish it. An Opus working copy is PROMOTED — renamed into mp3/, no re-encode,
        because it is already exactly what the encoder would produce. A WAV one is encoded.

        Threaded and polled like /convert, because a book of WAV chapters is minutes of ffmpeg;
        a book of Opus ones is seconds, since every chapter is a rename."""
        d = _book_dir(book)
        if not vault_fs.exists(d):
            abort(404)
        data = request.get_json(silent=True) or {}
        bitrate = str(data.get("bitrate") or "192k")
        with _CONVERT_LOCK:
            live = _CONVERT.get(book)
            if live and live.get("status") == "running":
                return jsonify({"error": "this book is already being worked on"}), 409
            _CONVERT[book] = {"status": "running", "done": 0, "total": 0, "chapter": ""}

        def _run():
            def progress(i, total, name):
                with _CONVERT_LOCK:
                    _CONVERT[book].update({"done": i, "total": total, "chapter": name})
            try:
                out = book_state.finish_chapters(d, bitrate=bitrate, progress=progress)
                with _CONVERT_LOCK:
                    _CONVERT[book] = {"status": "done", **out}
            except Exception as exc:                               # noqa: BLE001
                logger.exception("finishing chapters failed")
                with _CONVERT_LOCK:
                    _CONVERT[book] = {"status": "failed", "error": str(exc)}

        threading.Thread(target=_run, daemon=True).start()
        return jsonify({"started": True})


    @bp.route("/book/<book>/reclaim", methods=["POST"])
    def book_reclaim(book):
        """Delete chapter WAVs only when their MP3 copies exist. The lossless masters are large; reclaiming them preserves the playable MP3s and the full audiobook. WAVs without MP3 copies are retained."""
        d = _book_dir(book)
        if not vault_fs.exists(d):
            abort(404)
        data = request.get_json(silent=True) or {}
        return jsonify(book_state.reclaim_chapter_wavs(d, dry_run=_b(data, "dry_run", False)))


    @bp.route("/book/clear/<book>", methods=["POST"])
    def book_clear(book):
        """Guarded full wipe; requires `confirm == book`. This removes the entire book directory, including the concatenated audiobook. Use `/book/<book>/reclaim` to remove chapter WAVs while preserving playable exports."""
        data = request.get_json(force=True) or {}
        if str(data.get("confirm", "")) != book:
            return jsonify({"error": "confirm token must equal the book name"}), 400
        # ALL THREE of these route. `books` is a vault tree and so is `chunks`, so the plain
        # Path.exists() answered False for every book on an encrypted install — deleting a book
        # 404'd, always — and the two shutil.rmtree calls then matched nothing and swallowed it
        # under ignore_errors=True. The book text and its whole chunk workspace stayed.
        d = _book_dir(book)
        with book_state._sidecar_lock(d):
            if not vault_fs.exists(d):
                abort(404)
            vault_fs.rmtree(d)
            chunks = CHUNKS_ROOT / safe_name(book)
            vault_fs.rmtree(chunks)
        return jsonify({"ok": True, "cleared": book})


    @bp.route("/book/regenerate/<book>/<int:section>", methods=["POST"])
    def book_regenerate(book, section):
        """Force-regenerate one chapter: delete its WAV/MP3 + chunks, re-render just
        that section, update the sidecar. Runs as a normal (single-section) job."""
        d = _book_dir(book)
        sc = book_state.load_sidecar(d)
        if not sc:
            abort(404)
        docx = sc.get("source_docx_path")
        if not docx or not vault_fs.exists(Path(docx)):    # the source may be in books/ — routed
            return jsonify({"error": "original .docx path not recorded/available"}), 400
        ch = next((c for c in sc.get("chapters", []) if c["index"] == section), None)
        if ch is None:
            abort(404)

        # Validate params BEFORE planning any file moves, so a bad request can't leave
        # the chapter half-deleted.
        data = request.get_json(silent=True) or {}
        voice = str(data.get("voice", sc.get("voice") or "")).strip()
        # → a real clip inside voice_samples/, any audio extension; path-safe.
        voice = rt_voices.resolve_leaf(voice) if voice else ""
        err = rt_params.voice_file_error(voice)
        if err is not None:
            return err
        p = sc.get("params", {})
        try:
            params = GenParams(voice=str(paths.VOICE_SAMPLES / voice) if voice else None,
                               exaggeration=_f(data, "exaggeration", p.get("exaggeration", 0.5), lo=0, hi=3),
                               cfg=_f(data, "cfg", p.get("cfg", 0.5), lo=0, hi=1),
                               temperature=_f(data, "temperature", p.get("temperature", 0.8), lo=0, hi=3))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        workers = rt_pool.default_workers()   # global settings only — request gpus/workers are ignored

        # The chapter must come back the same KIND of audio it replaced: a re-rendered
        # chapter that skipped enhancement is one dull chapter in a crisp audiobook, which is
        # exactly the inconsistency the book-level lock exists to prevent. So this is read off
        # the book, never off the request — the Output tab's ↻ has no opinion to offer.
        enhance_on = bool(sc.get("enhance"))
        if enhance_on and not enhancement.enhance_available():
            return jsonify({"error": enhancement.enhance_unavailable_reason()}), 400

        # PLAN the safe-swap; the moves themselves run in run_job under GPUS, right
        # before the re-render. Moving the files here would make the chapter invisible
        # (gone from Output, silently missing from a concat) for however long this job
        # queues behind another render — and a crash while queued would orphan it.
        job = Job(id=uuid.uuid4().hex[:12], docx=docx, voice=voice, params=params,
                  gpus=rt_pool.default_devices(),
                  workers=workers, only_section=section, out_name=book,
                  enhance=enhance_on,
                  enhance_nfe=enhance.validate_nfe(sc.get("enhance_nfe")))
        job.regen_swap = [(str(f), str(f) + ".regenbak")
                          for f in (d / (ch["filename"] + ".wav"),
                                    d / "mp3" / (ch["filename"] + ".mp3"))]
        job.regen_chunks = str(CHUNKS_ROOT / safe_name(book) / ch["filename"])
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        return jsonify({"job_id": job.id, "section": section})

    return bp
