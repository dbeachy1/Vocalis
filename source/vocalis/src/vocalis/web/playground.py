"""`/playground/*` — the Playground tab: generate, stream, bank, enhance, keep (5.1-P4.12).

Fifteen routes and twelve helpers, and it is the only domain in the app with **two ways to
render the same text**. `POST /playground/generate` runs `run_playground_job` on a daemon
thread and the browser polls; `POST /playground/stream` hands the transport layer a generator
and the browser hears chunk 0 while chunk 7 is still on a GPU. They are not variants — they
produce the SAME clip, keyed on the same `clip_h`, into the same workspace, and either can
resume what the other banked.

**`clip_h` is the identity, and the workspace on disk is the ledger.** A chunk that finished is
a file in `CHUNKS_ROOT/playground/<h>/`; there is no in-memory list of what is done. That is
what lets a reload, a Stop, a cap, or a switch between the two render paths all resume from the
same place — and it is why `AudioMeter` counts the gapless PREFIX from chunk 0 rather than the
files present. Chunks finish out of order across workers; a clip is a prefix of the text, never
a set of islands.

🔴 **`stream_bp` is INJECTED, and §6.5 is the whole reason this module exists in this shape.**
`playground_stream` calls `STREAM_BP.register_stream({...})` to mint a token the transport layer
serves. `STREAM_BP` is built in `vocalis_server` from `vocalis_stream_http.create_stream_blueprint`
*after* the playground code used to sit — the old call only worked because it was inside a
function body, 3,100 lines from the construction. A module-scope import here would be a genuine
forward reference. It arrives as a factory argument instead, so the ordering is expressed by the
registration line rather than by luck. **Nothing type-checks this: it fails at runtime on
`/playground/stream` or not at all.**

🔴 **`CAP_SECONDS` is `runtime/jobs.py`'s, not this module's.** The cap is enforced here
(`_pg_cap_check`) and REPORTED by `/enhance/info`, which §4.3 files under system — two readers
on opposite sides of this split. Read through the module (`rt_rt_jobs.CAP_SECONDS`) so the six test
sites that rebind it to 2.0/3.0 reach both.

**What is NOT here.** `/enhance/info` and `/render/rate` sit inside the block this came out of
and are **system** routes by §4.3 — a box-capability report and a measured render rate, neither
of them about a clip. Both stay. `enhance_one` and the card scheduler are
`runtime/enhancement.py`; the clip library's own file/sidecar vocabulary is `playground_clips.py`.

⚠️ **`rt_jobs`/`rt_pool`/`rt_params`/`rt_voices`, never the bare names.** Same convention as
`web/books.py`: each of those is a plausible local in a route body, and a local makes the name
local for the WHOLE body, so a module call earlier in it reads the unassigned local
(P3.4, P4.10a). `_playground_stream_gen` binds `pool` as a parameter, which is precisely the
collision `rt_pool` exists to prevent.
"""
import hashlib
import io
import re
import threading
import time
import uuid
from pathlib import Path

from flask import Blueprint, Response, abort, jsonify, request, send_file

import clip_favorites
import folders
import clip_sources
import enhance
import playground_clips
import scratch
import torch
import vault_fs
import vault_store
import voice_utils
import zip_stream
from book_to_audio import CHUNKS_ROOT, OUTPUT_DIR, safe_name
from loguru import logger
from store_serve import send_capped_bytes, send_store_file
from tts_utils import GenParams, ffprobe_duration, save_wav_atomic, save_wav_sf

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
from vault import VaultAuthError


# ── ⬇ Download selected ───────────────────────────────────────────────────────
# 6.0 §7.1: the sink, the chunk size, the DOS epoch and the streaming loop are `zip_stream.py`
# now. The Clips tab needs the identical button for scenes, and this machinery holds four
# separately-learned rules — streaming rather than buffering, ROUTED reads, ZIP_STORED, and the
# 1980 floor — of which a second copy would get three right. Same argument as `mp3_concat`, and
# the same shape of fix. What stays here is which files, and what to call them.

def _partial_wav_reader(h: str):
    """A partial's 'story so far' as a readable WAV, built when the archive reaches it and not
    before — the same audio `/playground/partials/<h>/audio` serves. Deliberately lazy: this one
    IS materialized in memory (it is assembled from chunk WAVs, there is no file to stream), so
    building every selected partial up front would defeat the streaming above."""
    wav, sr = playground_clips.prefix_wav(CHUNKS_ROOT, h)
    buf = io.BytesIO()
    save_wav_sf(buf, wav, sr)
    buf.seek(0)
    return buf


class AudioMeter:
    """Seconds of CONTIGUOUS banked audio — what the clip would hold if we stopped now.

    Chunks finish out of order across workers, so the number that matters is the gapless
    prefix from chunk 0, not how many files are on disk: a clip is a PREFIX of the text,
    never a set of islands. Counting files would let the 60-minute cap fire on 55 minutes
    of audio plus a chunk from further down the page.

    A resumed render seeds this from the chunks already on disk (`seed`), reading their
    headers rather than assuming — a resume can have GAPS in it (chunks 0, 1 and 3, with 2
    still missing), so there is no "prefix length" to take on trust. Every chunk carries
    its own duration and the prefix falls out of the set.
    """

    def __init__(self):
        self._dur = {}

    def add(self, i: int, seconds: float):
        self._dur[int(i)] = float(seconds or 0)

    def seed(self, ws: Path, have) -> "AudioMeter":
        for i in have:
            self.add(i, playground_clips.chunk_seconds(ws, i))
        return self

    @property
    def chunks(self) -> int:
        n = 0
        while n in self._dur:
            n += 1
        return n

    @property
    def seconds(self) -> float:
        return sum(self._dur[k] for k in range(self.chunks))


def _clip_ref_for(voice: str, text: str, h: str, enhanced: bool = False) -> str:
    """'<voice-dir>/<stem>' for a clip: narrator name (model default -> 'default')
    through safe_name, then the first-words + H8 stem (DESIGN_2.3 §1.2). An
    EXISTING clip with this identity wins — found by its `_<H8>` suffix, so a
    user-renamed clip is overwritten in place instead of duplicated. A custom name
    given to the PARTIAL (rename_partial → pending.yaml `name`) also wins over the
    text-derived stem, so a renamed in-flight render finishes under its name.

    `enhanced` adds the visible `_enhanced` marker. It never has to disambiguate — H
    already carries the enhance state (playground_clips.clip_hash), so the two takes are
    different clips before the name is even built. This is so you can SEE which is which
    in a flat library, not so the library works."""
    vdir = safe_name(rt_voices.narrator_name(voice) or "default", 60)
    existing = playground_clips.find_ref_by_hash(OUTPUT_DIR / "playground", vdir, h)
    if existing:
        return existing
    m = playground_clips.read_pending(playground_clips.workspace(CHUNKS_ROOT, h)) or {}
    custom = safe_name(str(m.get("name") or ""), 30)
    if custom and custom != "section":         # safe_name's empty fallback
        return f"{vdir}/{playground_clips.stem_for(custom, h, enhanced)}"
    return f"{vdir}/{playground_clips.clip_stem(text, h, enhanced)}"


def _pg_pending(job: Job, total: int) -> dict:
    """The workspace manifest — everything a resume, a library row, or a reloading page
    needs to recognize this render."""
    return {"voice": job.voice, "exaggeration": job.params.exaggeration,
            "cfg": job.params.cfg, "temperature": job.params.temperature,
            "narrate_actions": job.narrate_actions,
            "enhance": job.enhance, "nfe": job.enhance_nfe,
            "text": job.text, "total": total}


def _pg_write_clip(job: Job, ws: Path, sr: int, upto: int):
    """Concat the first `upto` banked chunks into the library clip (MP3 + YAML sidecar).
    Returns (ref, duration_s), or (None, None) if a cancel landed mid-enhance.

    THE SHARED TAIL OF BOTH PLAYGROUND PATHS — the batch job and the stream. They wrote
    the same two artifacts from two copies of the same code, and the enhance post-pass has
    to land in exactly one place or the two paths quietly diverge on bitrate, on the
    `_enhanced` marker, or on what the sidecar records.

    `upto` is less than the chunk count when the 60-minute cap stopped the render early.
    That is a FINISHED clip — the audio we deliberately chose to make — not a partial, and
    nothing here treats it as one.
    """
    from tts_utils import valid_or_remove, load_wav

    def cpath(i):
        return ws / f"chunk_{i:04d}.wav"

    still = [i for i in range(upto) if not valid_or_remove(cpath(i))]
    if still:
        raise RuntimeError(f"generation incomplete — {len(still)} chunk(s) could not be produced")
    combined = torch.cat([load_wav(str(cpath(i)))[0] for i in range(upto)], dim=-1)
    duration = round(combined.shape[-1] / sr, 1)

    # `_full.wav` is CHILD-PROCESS INPUT — the enhancer runs in its own venv under
    # subprocess.Popen and the MP3 encode is ffmpeg — and a child cannot go through the
    # Python router. So it must be REAL PLAINTEXT ON DISK, which means the SCRATCH (the
    # plaintext boundary, 5.0 §8.3), not the workspace.
    #
    # It used to be written into `ws` with the non-routing writer, which was both halves
    # wrong at once: the write missed the vault, AND the plaintext path it aimed at does not
    # exist (the real workspace dir has an encrypted name), so it ENOENT'd before any child
    # ran. Routing it instead would have been the OTHER wrong fix — a correctly-encrypted
    # file whose name the enhancer subprocess still could not open.
    full_wav = scratch.path_for(configs.scratch_root(), ws / "_full.wav", tag=f"pgfull|{job.id}")
    full_wav.parent.mkdir(parents=True, exist_ok=True)
    save_wav_sf(str(full_wav), combined, sr)

    # Enhancement reads the lossless WAV and the MP3 encode happens LAST (DESIGN §5.5):
    #     Chatterbox → WAV → ENHANCER → WAV → MP3
    # One lossy step, at the end. Feed a generative model MP3 and you teach it to
    # reconstruct MP3 artifacts.
    # `enh` (was `scratch`) — the local SHADOWED the scratch module, which is why the
    # plaintext boundary was unreachable from this function in the first place.
    audio, enh = full_wav, None
    try:
        if job.enhance:
            est = enhance.estimate_seconds(duration, job.enhance_nfe)
            emit(job, {"type": "log",
                       "line": f"Enhancing the finished clip — {job.enhance_nfe} steps, "
                               f"{enhance.eta_note(est)}. (What you heard live is the raw "
                               f"render; the clip that gets saved is the enhanced one.)"})
            cfg = configs.enhance_cfg()
            enh = enhance.scratch_path(cfg, full_wav, tag=f"pg|{job.id}")
            enh.parent.mkdir(parents=True, exist_ok=True)
            # 🔴 The emptiest of the TICKED cards, not the emptiest card on the box.
            # `gpu.pick_device()` enumerates every physical device and knows nothing about
            # ⚙ Settings, so with `cuda:1` unticked and kept for the LLM, this line put the
            # enhancer's ~21 GB child on `cuda:1` — chosen *because* it was empty, and empty
            # precisely because the user had excluded it from the render that just finished.
            # Every other enhance site goes through `enhance_cards()` (books, bulk, train, and
            # the /playground/enhance route below); this one was missed, and m4k then wrote the
            # opposite promise into the panel: "they use this machine's own ticked cards".
            device = (gpu.cards_emptiest_first(enhancement.enhance_cards()) or ["cpu"])[0]
            if not str(device).startswith("cuda:"):
                raise RuntimeError(enhancement.enhance_unavailable_reason())
            if not enhancement.enhance_one(job, full_wav, enh, job.enhance_nfe, device, "the clip"):
                return None, None               # canceled mid-enhance — chunks are kept
            audio = enh

        ref = _clip_ref_for(job.voice, job.text, job.clip_h, job.enhance)
        mp3_path, yaml_path = playground_clips.clip_paths(OUTPUT_DIR / "playground", ref)
        playground_clips.encode_mp3(audio, mp3_path, enhance.mp3_bitrate(job.enhance))
    finally:
        # BOTH plaintext intermediates, on every exit path — success, raise, or the
        # canceled-mid-enhance `return` above (5.0 §8.3). `full_wav` is a full plaintext
        # render of the user's prose; leaving it behind is the leak this boundary exists
        # to prevent, and the early return means a `with` further up would not have covered
        # the enhanced one anyway.
        if enh is not None:
            enh.unlink(missing_ok=True)
        full_wav.unlink(missing_ok=True)

    carried = playground_clips.read_pending(ws) or {}      # user-set name/favorite survive
    playground_clips.write_clip_yaml(yaml_path, {
        "voice": job.voice, "exaggeration": job.params.exaggeration, "cfg": job.params.cfg,
        "temperature": job.params.temperature,
        "narrate_actions": job.narrate_actions,
        "enhanced": job.enhance,
        **({"nfe": job.enhance_nfe} if job.enhance else {}),
        **({"capped": True} if job.cap_hit.is_set() else {}),
        "text": job.text, "duration_s": duration,
        **({"name": str(carried["name"])} if carried.get("name") else {}),
        **({"favorite": True} if carried.get("favorite") else {}),
    })
    # 🔴 COMPLETING A RENDER MOVES THE ROW'S REF, SO IT NEEDS THE SAME HOOK A RENAME DOES.
    # A partial's ref is its WORKSPACE HASH (`playground_clips.list_partials` returns `d.name`,
    # i.e. `job.clip_h`); a finished clip's is `<vdir>/<stem>` from `_clip_ref_for` above. Both
    # are rows in the SAME `playground_clips` scope and both are stamped by one `for_rows` call,
    # and partials are tickable and filable end to end — so without this, filing a partial and
    # letting it finish drops the assignment on the floor: `for_rows` never stamps the new ref,
    # `_clean` later collects the dead one, the folder count falls by one, and nothing errors.
    # That is exactly the silent unfiling `RENAME_MOVES_REF` exists to make impossible, and it
    # is invisible to `test_folders_rename_hooks.py`, which only checks that a scope is NAMED by
    # some `rekey` call — this scope already is, at the rename route below.
    #
    # ⚠️ The ★ was already carried, but by DATA (`carried["favorite"]` into the clip sidecar
    # above), and that asymmetry is what hid this: the favorite rides across on its own and the
    # folder had no such ride.
    folders.rekey(paths.FOLDERS.parent, "playground_clips", job.clip_h, ref)
    # vault_fs.rmtree, NOT shutil's: `ws` is the PLAINTEXT workspace path and the real
    # directory has an encrypted name, so shutil.rmtree(ignore_errors=True) matched nothing
    # and swallowed the miss. Every finished playground render leaked its whole chunk
    # workspace — the user's prose, chunk by chunk — into the cache, forever.
    vault_fs.rmtree(ws)                         # finished — the clip is the record now
    job.clip_ref = ref
    return ref, duration


def _pg_cap_check(job: Job, meter: AudioMeter, complete: bool) -> bool:
    """Has the 60-minute cap just fired? Called at each CHUNK BOUNDARY, holding the
    caller's save lock — a chunk already on the GPU is never abandoned half-synthesized.

    Fires once, and freezes the clip at the contiguous prefix."""
    if complete or not job.cap60 or job.cap_hit.is_set():
        return False
    if meter.seconds < rt_jobs.CAP_SECONDS:
        return False
    job.cap_upto = meter.chunks
    job.cap_hit.set()
    return True


def _pg_past_the_cap(job: Job, i: int) -> bool:
    """Is chunk `i` beyond a cap that has already fired? Then it is not part of the clip
    and must NOT be written to the workspace.

    This is what makes the cap safe, not merely tidy. The cap finalizes IMMEDIATELY — it
    does not wait for the chunks still on the GPUs, because up to workers×cards of them
    are mid-synthesis and cannot be preempted. So finalize (concat → enhance → encode →
    rmtree the workspace) runs while those stragglers are still landing, and a straggler
    that banked into a workspace being deleted would blow up inside a pool worker with a
    FileNotFoundError — save_wav_sf does not recreate its parent directory.

    Dropping them is not a loss: they are text past the point the user asked us to stop.

    Callers MUST hold the same save lock that _pg_cap_check sets cap_upto under, or this
    can read a half-set cap.
    """
    return job.cap_hit.is_set() and i >= job.cap_upto


def _playground_live_h(h: str) -> bool:
    """True if a playground job for this exact identity is queued/running. With
    seedless identity every re-Generate of the same inputs maps to the SAME H —
    two concurrent renders would write the same workspace's chunk files over each
    other, so the endpoints 409 instead (the UI says 'already rendering')."""
    with JOBS_LOCK:
        return any(j.kind == "playground" and j.clip_h == h
                   and j.status in ("queued", "running") for j in JOBS.values())


def run_playground_job(job: Job):
    """Playground render on the job rails (2.3-M2): chunks land in a resumable disk
    workspace (chunks/playground/<H>/ + pending.yaml), then concat -> MP3 (96 kbps
    mono, the app standard) + YAML sidecar into output/playground/<voice>/. Cancel or
    crash keeps the workspace so a later matching request resumes at the first missing
    chunk; only a FINISHED clip ever appears in the library."""
    stop_vram = threading.Event()
    ws = playground_clips.workspace(CHUNKS_ROOT, job.clip_h)
    try:
        job.status = "running"
        job.started_at = time.time()
        emit(job, {"type": "job_start", "id": job.id, "kind": "playground"})

        from tts_utils import split_into_chunks, valid_or_remove, filter_actions
        # The model never sees asterisks: they're alien tokens to Chatterbox and
        # destabilize the wrapped span (words skipped/mangled). The ORIGINAL text is
        # what gets stored/displayed; only synthesis sees the filtered form.
        chunks = split_into_chunks(filter_actions(job.text, job.narrate_actions))
        total = len(chunks)
        playground_clips.write_pending(ws, _pg_pending(job, total))
        devices = rt_pool.resolve_devices(job.gpus)
        # Naming the devices is the whole point of this line now: the failure it would have
        # made obvious (a satellite render quietly running on the CPU) was invisible because
        # nothing ever said where the work went.
        emit(job, {"type": "log", "line": f"{total} chunk(s), {len(job.text)} chars · "
                   f"{rt_pool.worker_note(job.workers, devices)} · {','.join(devices)}"})

        # Same cancel-aware GPUS wait as book jobs: queued behind a render, the
        # Cancel button still works instead of blocking until the holder finishes.
        waited = False
        while not GPUS.acquire(timeout=0.5):
            if not waited:
                waited = True
                emit(job, {"type": "log", "line": "Waiting for the GPUs (another job is using them)…"})
            if job.cancel.is_set():
                job.status = "canceled"
                emit(job, {"type": "canceled"})
                return
        try:
            threading.Thread(target=rt_jobs.vram_ticker, args=(job, stop_vram), daemon=True).start()
            pool = rt_pool.get_pool(devices, job.workers)

            def cpath(i):
                return ws / f"chunk_{i:04d}.wav"

            done_idx = {i for i in range(total) if valid_or_remove(cpath(i))}
            if done_idx:
                emit(job, {"type": "log",
                           "line": f"({len(done_idx)}/{total} chunks already on disk, resuming)"})
            save_lock = threading.Lock()
            meter = AudioMeter().seed(ws, done_idx)
            banked = set(done_idx)

            def save(i, wav, sr):
                with save_lock:
                    if _pg_past_the_cap(job, i):
                        return               # text past where the user asked us to stop
                    # save_wav_atomic, NOT save_wav_sf: the workspace is in the vault (the
                    # `chunks` tree of the cache root), and only the _atomic one routes.
                    # save_wav_sf hands libsndfile a filename, and the plaintext one is not
                    # on disk — the real workspace dir has an ENCRYPTED name — so every
                    # audition on an encrypted install died at chunk_0000 with ENOENT.
                    save_wav_atomic(cpath(i), wav, sr)
                    banked.add(i)
                    meter.add(i, wav.shape[-1] / float(sr))
                    job.audio_s = meter.seconds
                    hit = _pg_cap_check(job, meter, complete=len(banked) >= total)
                emit(job, {"type": "audio", "seconds": round(job.audio_s, 1)})
                if hit:
                    emit(job, {"type": "log",
                               "line": f"60-minute cap reached — stopping at the chunk boundary "
                                       f"and saving the clip ({job.audio_s / 60:.0f} min)."})
                    job.cancel.set()          # stops new chunks; in-flight ones still land

            missing = [(i, c) for i, c in enumerate(chunks) if i not in done_idx]
            if missing:
                pool.run_chunks(missing, job.params, save, total,
                                on_event=lambda ev: emit(job, ev), chapter=0, cancel=job.cancel)
        finally:
            GPUS.release()

        # A cap is not a cancel: it produced exactly the clip that was asked for. Only a
        # cancel with no cap behind it abandons the render (keeping the chunks to resume).
        if job.cancel.is_set() and not job.cap_hit.is_set():
            job.status = "canceled"
            emit(job, {"type": "log",
                       "line": "Canceled — progress kept; the same settings resume here."})
            emit(job, {"type": "canceled"})
            return

        upto = job.cap_upto if job.cap_hit.is_set() else total
        ref, duration = _pg_write_clip(job, ws, pool.sr, upto)
        if ref is None:                            # canceled during the enhance post-pass
            job.status = "canceled"
            emit(job, {"type": "canceled"})
            return
        job.status = "done"
        emit(job, {"type": "job_done", "clip": ref, "duration_s": duration})
    except VaultAuthError as exc:                              # BOUNDARY 2 of 5 — BY NAME
        vault_store.fail_job_on_vault_auth(job, exc, emit)
    except Exception as exc:                                   # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        logger.exception(f"playground job {job.id} failed")
        emit(job, {"type": "error", "message": str(exc)})
    finally:
        stop_vram.set()


def _make_playground_stream(job: Job, chunks: list):
    """make_stream(pool, cancel, cfg) factory for the transport layer: closes over
    the Job + the FULL text's deterministic chunk split (identity = job.clip_h)."""
    def make(pool, cancel, scfg):
        return _playground_stream_gen(job, chunks, pool, cancel, scfg)
    return make


def _playground_stream_gen(job: Job, chunks: list, pool, cancel, scfg):
    """Yield float32 mono PCM for a complete Playground clip. Replay banked chunks from disk first, then render the live tail with global chunk indices so workspace names remain aligned. Continue banking the stream as it is consumed."""
    from tts_utils import valid_or_remove, load_wav
    from vocalis_streaming import stream_message
    ws = playground_clips.workspace(CHUNKS_ROOT, job.clip_h)
    total = len(chunks)

    def cpath(i):
        return ws / f"chunk_{i:04d}.wav"

    fin_lock = threading.Lock()
    fin = {"started": False, "thread": None, "error": None, "upto": total}

    def finalize():
        """Write the library clip — the same artifacts, from the same code, as the batch
        path (_pg_write_clip). Owns its own error reporting: it can outlive the generator
        (a listener who walked away), so nobody else is guaranteed to be around to report
        for it. The ENHANCE post-pass runs in here too, which is why it may take minutes
        after the last chunk lands and why it must not block a pool worker."""
        try:
            ref, duration = _pg_write_clip(job, ws, pool.sr, fin["upto"])
            if ref is None:                                    # canceled mid-enhance
                job.status = "canceled"
                emit(job, {"type": "log",
                           "line": "Stopped during enhancement — the render is kept; "
                                   "the same settings resume here."})
                emit(job, {"type": "canceled"})
                return
            job.status = "done"
            emit(job, {"type": "job_done", "clip": ref, "duration_s": duration})
        except VaultAuthError as exc:                          # BOUNDARY 5 of 5 — BY NAME
            # The pg-finalize-<job.id> daemon thread (b1d6e00). It reads and writes the clip
            # sidecar via playground_clips, so it IS a vault path — and it can OUTLIVE the
            # generator, so nobody else is guaranteed to be around to report for it. Miss this
            # one and a wrong key kills the thread silently, mid-write, with no error anywhere.
            # The docs elsewhere still say there are four boundaries. There are five.
            fin["error"] = exc
            vault_store.fail_job_on_vault_auth(job, exc, emit)
        except Exception as exc:                               # noqa: BLE001
            fin["error"] = exc
            job.status = "failed"
            job.error = str(exc)
            logger.exception(f"playground stream {job.id} finalize failed")
            emit(job, {"type": "error", "message": str(exc)})

    def start_finalize(upto: int = None):
        """Run finalize exactly once, on its own thread — off the pool worker that
        banks the last chunk (it must not hold a GPU worker for a multi-minute
        concat + enhance + encode) and off the generator (whose pace the browser
        dictates). `upto` is the 60-minute cap's chunk count; the full total otherwise."""
        with fin_lock:
            if fin["started"]:
                return
            fin["started"] = True
            if upto:
                fin["upto"] = upto
            fin["thread"] = threading.Thread(target=finalize, daemon=True,
                                             name=f"pg-finalize-{job.id}")
        fin["thread"].start()

    def finalize_started():
        with fin_lock:
            return fin["started"]

    try:
        job.status = "running"
        job.started_at = time.time()
        emit(job, {"type": "job_start", "id": job.id, "kind": "playground"})
        playground_clips.write_pending(ws, _pg_pending(job, total))
        emit(job, {"type": "log",
                   "line": f"{total} chunk(s), {len(job.text)} chars · streaming"
                           + (f" · enhance on ({job.enhance_nfe} steps, as a post-pass "
                              f"once the render finishes)" if job.enhance else "")})

        prefix = 0
        while prefix < total and valid_or_remove(cpath(prefix)):
            prefix += 1
        # Resume lead-in: replay only the LAST few already-banked chunks for continuity,
        # then render the rest live. Do NOT re-stream the whole prefix — a large one
        # (e.g. 94 chunks / ~29 min) pumped to the browser before rendering left the
        # GPUs idle for minutes with the user hearing nothing (playback was held until
        # a 28-min seek point buffered). The finished clip still concatenates ALL chunks
        # from disk below, so the skipped middle is never lost — it's already rendered.
        LEAD_IN_CHUNKS = 2
        lead_start = max(0, prefix - LEAD_IN_CHUNKS)
        if prefix:
            emit(job, {"type": "log",
                       "line": f"({prefix}/{total} chunks already rendered — replaying the last "
                               f"{prefix - lead_start} for context, then rendering from chunk {prefix + 1})"})
        for i in range(lead_start, prefix):
            if cancel.is_set():
                break
            w, _sr = load_wav(str(cpath(i)))
            yield w.squeeze(0).float().cpu().numpy()

        meter = AudioMeter().seed(ws, range(prefix))
        job.audio_s = meter.seconds
        emit(job, {"type": "audio", "seconds": round(job.audio_s, 1)})

        if prefix < total and not cancel.is_set():
            save_lock = threading.Lock()
            banked = set(range(prefix))            # the resumed prefix is already on disk

            def bank(i, wav):
                with save_lock:
                    if _pg_past_the_cap(job, i):
                        # The cap already fired and finalize is away — this workspace is
                        # being concatenated and deleted RIGHT NOW. Writing into it would
                        # blow up in this pool worker.
                        return
                    save_wav_atomic(cpath(i), wav, pool.sr)   # routes; save_wav_sf does not
                    banked.add(i)
                    meter.add(i, wav.shape[-1] / float(pool.sr))
                    job.audio_s = meter.seconds
                    complete = len(banked) >= total
                    hit = _pg_cap_check(job, meter, complete)
                emit(job, {"type": "audio", "seconds": round(job.audio_s, 1)})
                if hit:
                    emit(job, {"type": "log",
                               "line": f"60-minute cap reached ({job.audio_s / 60:.0f} min) — "
                                       f"stopping here and saving the clip. This is a finished "
                                       f"clip, not a canceled one."})
                    # Finalize BEFORE canceling: the tail below treats "canceled with no
                    # finalize away" as an abandoned render, and this is the opposite —
                    # a complete clip of exactly the audio that was asked for.
                    start_finalize(job.cap_upto)
                    cancel.set()          # no new chunks; ones on the GPUs still land and are unused
                # Last chunk on disk = the render is over. Finalize NOW, on its own
                # thread, instead of waiting for the browser to finish listening.
                elif complete and not cancel.is_set():
                    start_finalize()

            yield from stream_message(pool, "", job.params, config=scfg, cancel=cancel,
                                      on_event=lambda ev: emit(job, ev),
                                      chunks=chunks[prefix:], chunk_base=prefix,
                                      on_chunk=bank)

        # A Stop that lands before the last chunk banked means no clip (progress is
        # kept for resume). One that lands after it does not un-render the take —
        # the finalize is already away, and burying a finished clip under a
        # 'canceled' would throw away hours of GPU time. The 60-minute cap sets
        # `cancel` too, and it has already started its finalize for exactly that reason.
        if cancel.is_set() and not finalize_started():
            job.status = "canceled"
            emit(job, {"type": "log",
                       "line": "Stopped — progress kept; the same settings resume here."})
            emit(job, {"type": "canceled"})
            return

        # Usually already running (or done) from the banking hook. The resume-only
        # path banks nothing — every chunk was on disk when we started — so there
        # was no hook to fire it, and it starts here instead.
        start_finalize()
        fin["thread"].join()        # the stream never ends before the clip exists
        if fin["error"] is not None:
            raise fin["error"]
    except GeneratorExit:
        # The consumer vanished mid-yield (Stop button aborts the fetch; tab closed).
        # If the render already finished, the finalize is away on its own thread and
        # the clip is the outcome — only PLAYBACK ended early. Don't call that a cancel.
        if not finalize_started():
            job.status = "canceled"
            emit(job, {"type": "log",
                       "line": "Stopped — progress kept; the same settings resume here."})
            emit(job, {"type": "canceled"})
        raise
    except VaultAuthError as exc:                              # BOUNDARY 4 of 5 — BY NAME
        # A streaming Response's generator is iterated by the WSGI server AFTER wsgi_app has
        # already returned, so _VaultAuthWSGI (boundary 1) is off the stack by then and CANNOT
        # see this. Every streaming generator has to catch its own. That is the whole reason
        # the stream loops are a separate boundary rather than a special case of boundary 1.
        if exc is not fin["error"]:                # finalize() reports its own failures
            vault_store.fail_job_on_vault_auth(job, exc, emit)
        raise
    except Exception as exc:                                   # noqa: BLE001
        if exc is not fin["error"]:                # finalize() reports its own failures
            job.status = "failed"
            job.error = str(exc)
            logger.exception(f"playground stream {job.id} failed")
            emit(job, {"type": "error", "message": str(exc)})
        raise


def _enhance_clip_job(job: Job, root: Path, ref: str, meta: dict, nfe: int,
                      device: str) -> None:
    """Enhance a stored clip and REPLACE it with the full-band version. Holds ONE card —
    `device`, claimed by the caller from GPUS, released here — for its whole life.

    EVERYTHING is inside the try. The card is released in the finally, so a line that runs
    ahead of it — resolving a path, making a directory — would, if it threw, leak that card
    for the life of the process: no render could ever start again, and the card could never
    be handed to another enhancement. A background tidy-up must not be able to take the
    whole app down with it.
    """
    src = dst = None
    try:
        job.status = "running"
        mp3, y = playground_clips.clip_paths(root, ref)
        cfg = configs.enhance_cfg()
        src = enhance.scratch_path(cfg, mp3, tag=f"pgenh-src|{job.id}")
        dst = enhance.scratch_path(cfg, mp3, tag=f"pgenh-out|{job.id}")
        src.parent.mkdir(parents=True, exist_ok=True)
        # The clip's identity CHANGES: enhancement is one of clip_hash's inputs, so the
        # enhanced take is a different H under a `_enhanced` stem. Recomputed from the
        # sidecar's inputs, never patched onto the old hash — otherwise a later
        # un-enhanced render of the same text would land on this file and overwrite it.
        h = playground_clips.clip_hash(
            meta.get("voice", ""), float(meta.get("exaggeration") or 0.5),
            float(meta.get("cfg") or 0.5), float(meta.get("temperature") or 0.8),
            str(meta.get("text", "")), bool(meta.get("narrate_actions", True)),
            enhanced=True, nfe=nfe)
        # Keep the user's words, take the new hash. clip_stem would rebuild the stem from
        # the TEXT and silently undo any rename the clip has had.
        words = playground_clips._STEM_RE.sub("", mp3.stem)
        new_stem = playground_clips.stem_for(words, h, enhanced=True)
        new_mp3 = mp3.with_name(new_stem + ".mp3")
        new_y = mp3.with_name(new_stem + ".yaml")

        emit(job, {"type": "log", "line": f"Decoding “{mp3.name}”…"})
        # ffmpeg has no DEK and `mp3` is in output/playground, routed (§4.10).
        with vault_fs.child_input(mp3, src.parent) as plain_mp3:
            enhancement.decode_to_wav(plain_mp3, src)
        dur = ffprobe_duration(src) or 0           # the scratch decode, legible to ffprobe
        est = enhance.estimate_seconds(dur, nfe)
        # The card is named because two of these can now be running at once, and "which one
        # is on which card" is the first thing you want from the GPU strip when they are.
        emit(job, {"type": "log",
                   "line": f"Enhancing on {device} — {nfe} steps, {enhance.eta_note(est)}. "
                           f"The result replaces this clip."})
        if not enhancement.enhance_one(job, src, dst, nfe, device, mp3.name):
            job.status = "canceled"
            return

        playground_clips.encode_mp3(dst, new_mp3, bitrate=enhance.mp3_bitrate(True))
        new_meta = dict(meta)
        # `dur` is the scratch source's duration, measured while it was legible; ffprobe
        # cannot read new_mp3 once output/playground is encrypted (§4.10, same as §4.5).
        new_meta.update({"enhanced": True, "nfe": nfe, "duration_s": round(dur, 2)})
        # The cached bandwidth belongs to the OLD audio. Leave it and list_clips would
        # trust it (it is keyed on size+mtime, which have both changed — but only drop it
        # here and the answer can never be stale even for a moment).
        for k in ("bandwidth_hz", "bandwidth_size", "bandwidth_mtime"):
            new_meta.pop(k, None)
        playground_clips.write_clip_yaml(new_y, new_meta)

        # Only now is the raw take expendable — the enhanced one is on disk, encoded and
        # described. Same order as every other replace in the app: write, then remove.
        if new_mp3 != mp3:
            # §4.10 — vault_fs.unlink on output/playground. A raw unlink here does NOT raise
            # (missing_ok swallows it); it silently leaves the superseded raw take on disk
            # beside its replacement, so the library grows a duplicate per enhancement.
            vault_fs.unlink(mp3, missing_ok=True)
            vault_fs.unlink(y, missing_ok=True)
        job.clip_ref = f"{mp3.parent.name}/{new_stem}"
        job.status = "done"
        emit(job, {"type": "log", "line": f"✓ Full-band — saved as {new_mp3.name}"})
    except VaultAuthError as exc:                  # BOUNDARY 2 of 5 — BY NAME
        vault_store.fail_job_on_vault_auth(job, exc, emit)
    except Exception as exc:                       # noqa: BLE001 — surfaced to the client
        logger.exception("playground clip enhancement failed")
        detail = getattr(exc, "detail", "")        # the clip's name — browser, not the log
        job.status = "failed"
        job.error = f"{exc} — {detail}" if detail else str(exc)
    finally:
        for p in (src, dst):                       # plaintext must not outlive the job
            if p is not None:
                p.unlink(missing_ok=True)          # SCRATCH, not the library: plaintext must not outlive the job
        GPUS.release_card(device)
        emit(job, {"type": "done", "status": job.status, "error": job.error,
                   "ref": job.clip_ref})


def _enhance_partial_job(job: "Job", h: str, meta: dict, nfe: int, device: str) -> None:
    """Enhance a partial render's banked prefix into a new library clip without changing the resumable partial. Reusing the same source prefix and settings is idempotent."""
    src = dst = None
    try:
        job.status = "running"
        wav, sr = playground_clips.prefix_wav(CHUNKS_ROOT, h)
        if wav is None:
            raise RuntimeError("this partial has no playable audio banked yet")
        ws = playground_clips.workspace(CHUNKS_ROOT, h)
        # 🔴 M10 §4.5 — vault_fs.exists. CHUNKS_ROOT is cache_root()/chunks, routed, so a bare
        # .exists() leaves `count` at 0 while `prefix_wav` above — already converted — has just
        # returned real audio. The two disagree, and nothing notices: the log says "0 chunks",
        # and worse, `count` goes into snap_h below, so the snapshot gets an identity derived
        # from a chunk count that is a lie. Two different partials both snapshot at "0" and
        # collide on one clip.
        count = 0                                  # contiguous banked chunks (the playable prefix)
        while vault_fs.exists(ws / f"chunk_{count:04d}.wav"):
            count += 1
        cfg = configs.enhance_cfg()
        src = enhance.scratch_path(cfg, ws / "prefix.wav", tag=f"pgpart-src|{job.id}")
        dst = enhance.scratch_path(cfg, ws / "prefix.wav", tag=f"pgpart-out|{job.id}")
        src.parent.mkdir(parents=True, exist_ok=True)
        save_wav_sf(str(src), wav, sr)
        dur = ffprobe_duration(src) or 0

        # An identity that can NEVER equal a completed render's clip_hash (full text) — so
        # continuing the render later lands a SEPARATE clip rather than clobbering this one.
        snap_h = hashlib.sha256(f"partial-enh|{h}|{count}".encode()).hexdigest()[:12]
        vdir = safe_name(rt_voices.narrator_name(meta.get("voice") or "") or "default", 60)
        base = (safe_name(str(meta.get("name") or "")[:30], 30)
                or safe_name(str(meta.get("text", ""))[:30], 30) or f"clip_{h[:8]}")
        stem = playground_clips.stem_for(f"{base} (so far)", snap_h, enhanced=True)
        ref = f"{vdir}/{stem}"
        mp3, y = playground_clips.clip_paths(OUTPUT_DIR / "playground", ref)

        est = enhance.estimate_seconds(dur, nfe)
        emit(job, {"type": "log",
                   "line": f"Enhancing the story so far — {count} chunk"
                           f"{'' if count == 1 else 's'} — on {device}, {nfe} steps, "
                           f"{enhance.eta_note(est)}. It lands as a NEW clip; the partial is "
                           f"untouched and can still be continued."})
        if not enhancement.enhance_one(job, src, dst, nfe, device, "the partial"):
            job.status = "canceled"
            return

        vault_fs.mkdir(mp3.parent)                 # output/playground is routed
        playground_clips.encode_mp3(dst, mp3, bitrate=enhance.mp3_bitrate(True))
        carried = playground_clips.read_pending(ws) or {}       # a user-set name/favorite survive
        playground_clips.write_clip_yaml(y, {
            "voice": meta.get("voice", ""),
            "exaggeration": meta.get("exaggeration"), "cfg": meta.get("cfg"),
            "temperature": meta.get("temperature"),
            "narrate_actions": bool(meta.get("narrate_actions", True)),
            "enhanced": True, "nfe": nfe,
            "text": meta.get("text", ""),
            # ffprobe cannot read the landed mp3 once output/playground is encrypted (§4.5).
            # `dur` is the scratch source's duration, measured above while it was legible, and
            # for a straight encode it is the same number.
            "duration_s": round(dur, 2),
            # This clip is a snapshot of a partial, not a full render — recorded so nothing
            # ever mistakes it for the completed take.
            "partial_snapshot": True, "partial_of": h, "prefix_chunks": count,
            **({"favorite": True} if carried.get("favorite") else {}),
        })
        job.clip_ref = ref
        job.status = "done"
        emit(job, {"type": "log",
                   "line": f"✓ Full-band — saved as {mp3.name}. The partial is untouched."})
    except Exception as exc:                       # noqa: BLE001 — surfaced to the client
        logger.exception("partial enhancement failed")
        job.status, job.error = "failed", str(exc)
    finally:
        for p in (src, dst):                       # plaintext must not outlive the job
            if p is not None:
                p.unlink(missing_ok=True)
        GPUS.release_card(device)
        emit(job, {"type": "done", "status": job.status, "error": job.error,
                   "ref": job.clip_ref})


def create_playground_blueprint(stream_bp) -> Blueprint:
    """`stream_bp` is `vocalis_server`'s `STREAM_BP` — see the module docstring (§6.5). It is a
    parameter rather than an import because it is constructed after this module loads, and
    `/playground/stream` is the only route that touches it."""
    bp = Blueprint("vocalis_playground", __name__)

    @bp.route("/playground/generate", methods=["POST"])
    def playground_generate():
        """Launch a Playground render as a JOB on the book rails (2.3-M2): SSE progress,
        chunk-granular cancel, resumable disk workspace, and a persistent MP3+YAML clip in
        the library. Seedless (3.x): Generate ALWAYS renders a fresh take and atomically
        OVERWRITES the clip at this identity — 'play the existing take instead' is a UI
        affordance, not a server short-circuit. An interrupted render's workspace at the
        same H resumes at the first missing chunk."""
        if "file" in request.files:
            f = request.files["file"]
            if Path(f.filename or "").suffix.lower() not in (".txt", ".md"):
                return jsonify({"error": "Playground accepts pasted text or .txt/.md only "
                                         "(.docx belongs to the Book pipeline)."}), 400
            raw = f.read()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:          # legacy Word/Notepad export — cp1252 dashes/quotes
                text = raw.decode("cp1252", errors="replace")
            form = request.form
        else:
            form = request.get_json(force=True) or {}
            text = str(form.get("text", ""))
        if not text.strip():
            return jsonify({"error": "empty text"}), 400
        narrate_actions = _b(form, "narrate_actions", True)   # speak *action* spans (default on)

        from tts_utils import split_into_chunks, filter_actions
        if not split_into_chunks(filter_actions(text, narrate_actions)):
            return jsonify({"error": "no synthesizable text"
                            + (" — the text is all *actions* and action narration is off"
                               if not narrate_actions and "*" in text else "")}), 400

        voice = str(form.get("voice", "")).strip()
        voice = rt_voices.resolve_leaf(voice) if voice else ""    # → real clip inside voice_samples/, any audio ext; path-safe
        err = rt_params.voice_file_error(voice)
        if err is not None:
            return err
        try:
            exaggeration = _f(form, "exaggeration", 0.5, lo=0, hi=3)
            cfg          = _f(form, "cfg", 0.5, lo=0, hi=1)
            temperature  = _f(form, "temperature", 0.8, lo=0, hi=3)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        # GPUs/workers come from the GLOBAL settings only (⚙ Settings tab) — request-body
        # values are a leftover from when these lived on the Book tab and are ignored
        # (as is `turbo`: the engine choice died app-wide in 3.x).
        # 🔴 default_devices(), NOT default_gpus(): the latter answers "which of THIS box's
        # cards may be used" and drops satellites, so a satellite-only selection resolved to
        # 'cpu' and the audition incorrectly rebuilt the pool onto a CPU device; see
        # pool.resolve_devices.
        gpus, workers = rt_pool.default_devices(), rt_pool.default_workers()
        enhanced, nfe, err = rt_params.enhance_opts(form)
        if err is not None:
            return err

        h = playground_clips.clip_hash(voice, exaggeration, cfg, temperature,
                                       text, narrate_actions, enhanced, nfe)
        if _playground_live_h(h):
            return jsonify({"error": "these exact inputs are already rendering"}), 409

        job = Job(
            id=uuid.uuid4().hex[:12],
            docx="",
            voice=voice,
            params=GenParams(voice=str(paths.VOICE_SAMPLES / voice) if voice else None,
                             exaggeration=exaggeration, cfg=cfg, temperature=temperature),
            gpus=gpus,
            workers=workers,
            kind="playground",
            text=text,
            narrate_actions=narrate_actions,
            enhance=enhanced,
            enhance_nfe=nfe,
            cap60=_b(form, "cap60", False),
            clip_h=h,
        )
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        threading.Thread(target=run_playground_job, args=(job,), daemon=True).start()
        logger.info(f"playground job {job.id} → voice={voice or '(model default)'} · exag={exaggeration} "
                    f"cfg={cfg} temp={temperature} · gpus={','.join(gpus)} · "
                    f"enhance={enhanced}{f'/{nfe}' if enhanced else ''} · "
                    f"{len(text)} chars · H={h}")
        return jsonify({"job_id": job.id}), 202


    @bp.route("/playground/stream", methods=["POST"])
    def playground_stream():
        """Playground Generate, streaming (3.x): registers a one-time progressive-MP3
        stream that REPLAYS any banked chunks (resume), token-streams the first live
        chunk (audio in seconds), banks every finished chunk WAV to the same
        chunks/playground/<H>/ workspace as the batch path (Stop/crash resumes at the
        first missing chunk), and on completion writes the SAME library clip the batch
        path would (MP3 96k mono + YAML). Seedless identity, same as the batch endpoint:
        Generate ALWAYS renders and the finished take atomically overwrites the clip at
        this H (playing an existing take is the UI's affordance). Rides the shared pool
        at INTERACTIVE priority — it interleaves with a running book render instead of
        queueing behind it. JSON only; response: {job_id, stream_url, status_url}."""
        form = request.get_json(force=True, silent=True) or {}
        text = str(form.get("text", ""))
        if not text.strip():
            return jsonify({"error": "empty text"}), 400
        narrate_actions = _b(form, "narrate_actions", True)

        from tts_utils import split_into_chunks, filter_actions
        chunks = split_into_chunks(filter_actions(text, narrate_actions))
        if not chunks:
            return jsonify({"error": "no synthesizable text"
                            + (" — the text is all *actions* and action narration is off"
                               if not narrate_actions and "*" in text else "")}), 400

        voice = str(form.get("voice", "")).strip()
        voice = rt_voices.resolve_leaf(voice) if voice else ""    # → real clip inside voice_samples/, any audio ext; path-safe
        err = rt_params.voice_file_error(voice)
        if err is not None:
            return err
        try:
            exaggeration = _f(form, "exaggeration", 0.5, lo=0, hi=3)
            cfg          = _f(form, "cfg", 0.5, lo=0, hi=1)
            temperature  = _f(form, "temperature", 0.8, lo=0, hi=3)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        enhanced, nfe, err = rt_params.enhance_opts(form)
        if err is not None:
            return err

        h = playground_clips.clip_hash(voice, exaggeration, cfg, temperature,
                                       text, narrate_actions, enhanced, nfe)
        if _playground_live_h(h):
            return jsonify({"error": "these exact inputs are already rendering"}), 409

        job = Job(
            id=uuid.uuid4().hex[:12],
            docx="",
            voice=voice,
            params=GenParams(voice=str(paths.VOICE_SAMPLES / voice) if voice else None,
                             exaggeration=exaggeration, cfg=cfg, temperature=temperature),
            gpus=rt_pool.default_devices(),          # satellites included — see resolve_devices
            workers=rt_pool.default_workers(),
            kind="playground",
            text=text,
            narrate_actions=narrate_actions,
            enhance=enhanced,
            enhance_nfe=nfe,
            cap60=_b(form, "cap60", False),
            clip_h=h,
        )
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        token = stream_bp.register_stream({
            "nomi_name": "playground",
            "cancel": job.cancel,           # /book/cancel + client disconnect both stop it
            "gen_kwargs": {"voice": job.params.voice, "exaggeration": exaggeration,
                           "cfg": cfg, "temperature": temperature},
            "make_stream": _make_playground_stream(job, chunks),
        })
        # resume_s: seconds of already-banked audio this stream will REPLAY before
        # rendering live — the player uses it to start ~a minute behind the resume
        # point instead of from 0:00.
        resume_s = playground_clips.banked_prefix_seconds(
            playground_clips.workspace(CHUNKS_ROOT, h))
        logger.info(f"playground stream {job.id} → voice={voice or '(model default)'} · "
                    f"exag={exaggeration} cfg={cfg} temp={temperature} · "
                    f"{len(text)} chars / {len(chunks)} chunk(s) · H={h}"
                    + (f" · resume {resume_s:.0f}s banked" if resume_s else ""))
        return jsonify({"job_id": job.id, "resume_s": resume_s,
                        "stream_url": f"/speak/stream/{token}",
                        "status_url": f"/speak/stream/{token}/status"}), 202


    @bp.route("/playground/cap", methods=["POST"])
    def playground_cap():
        """Turn the 60-minute cap on or off DURING a render. Body: {job_id, cap}.

        The one setting that is live. Everything else about a render is fixed at Generate
        (it is part of the clip's identity), but the cap is not an input to the audio — it is
        a decision about how much of it to make, and the moment you want to make that decision
        is usually ten minutes in, when you realize the text is longer than you thought and you
        want to go to bed.

        Ticking it takes effect at the next CHUNK boundary, so a render already past 60 minutes
        stops at the next chunk rather than pretending it can undo what it has made. The client
        is told the current figure so it can say exactly that before you commit."""
        data = request.get_json(force=True, silent=True) or {}
        job = rt_jobs.job_or_404(str(data.get("job_id", "")))
        if job.kind != "playground":
            return jsonify({"error": "not a Playground render"}), 400
        if job.status not in ("queued", "running"):
            return jsonify({"error": "that render has already finished"}), 409
        job.cap60 = _b(data, "cap")
        emit(job, {"type": "log", "line": (
            f"60-minute cap ON — this render stops at the first chunk boundary past 60 minutes "
            f"and saves what it has as a finished clip. ({job.audio_s / 60:.0f} min so far.)"
            if job.cap60 else
            "60-minute cap OFF — this render will run to the end of the text.")})
        return jsonify({"ok": True, "cap": job.cap60, "audio_s": round(job.audio_s, 1)})


    @bp.route("/playground/clips")
    def playground_clips_list():
        """Finished clips + interrupted partial renders in one list. A workspace being
        rendered RIGHT NOW is not 'interrupted' — the live log covers it — so live jobs'
        workspaces are hidden until they finish or stop."""
        clips = playground_clips.list_clips(OUTPUT_DIR / "playground")
        # Display: the voice's COSMETIC label wins wherever one is set. Identity/
        # refs still key on the exact filename (sidecar `voice`) — this only fixes
        # what the Voice column shows.
        labels = voice_utils.get_labels(paths.VOICE_SETTINGS)
        for c in clips:
            c["kind"] = "clip"
            if labels.get(c.get("voice")):
                c["voice_label"] = labels[c["voice"]]
        with JOBS_LOCK:
            live = {j.clip_h for j in JOBS.values()
                    if j.kind == "playground" and j.status in ("queued", "running")}
        partials = [p for p in playground_clips.list_partials(CHUNKS_ROOT)
                    if p["ref"] not in live]
        for p in partials:
            p["voice_label"] = (labels.get(p["voice"])
                                or safe_name(rt_voices.narrator_name(p["voice"]) or "default", 60))
        # 8.9 — stamp each row's virtual folder. Scope `playground_clips`; the ref is the
        # clip's own `vdir/stem`, the same key `/playground/clips/<ref>/...` takes.
        # ⚠️ PARTIALS ARE STAMPED TOO. They are rows in this list and they can be ticked — but a
        # partial does NOT keep its ref when it finishes (this comment claimed it did until
        # 8.9.14, and it was wrong). A partial's ref is its workspace hash; the finished clip's
        # is `<vdir>/<stem>`. `_render_one` therefore calls `folders.rekey` on completion, the
        # same way the rename route below does, and that is what stops the silent unfile.
        rows = folders.for_rows(paths.FOLDERS.parent, "playground_clips", clips + partials)
        return jsonify(rows)


    @bp.route("/playground/partials/<h>/audio")
    def playground_partial_audio(h):
        """Stream an interrupted render's contiguous prefix (chunk 0 up to the first
        gap) as one WAV — 'the story so far'. Chunks beyond a gap would jump-cut
        mid-sentence, so they are not played."""
        if not re.fullmatch(r"[0-9a-f]{12}", h):
            abort(404)
        ws = playground_clips.workspace(CHUNKS_ROOT, h)
        wav, sr = playground_clips.prefix_wav(CHUNKS_ROOT, h)
        if wav is None:
            abort(404)
        buf = io.BytesIO()
        save_wav_sf(buf, wav, sr)
        buf.seek(0)
        download = request.args.get("download") == "1"
        if download:
            # Download name from the text, like finished clips — never the raw hash.
            m = playground_clips._read_yaml(ws / playground_clips.PENDING_NAME) or {}
            stem = safe_name(str(m.get("text", ""))[:120], 30) or f"clip_{h[:8]}"
            return send_file(buf, mimetype="audio/wav", as_attachment=True,
                             download_name=f"{stem}_partial.wav")
        # 8.6.5 — the shared bytes sender, so a library clip cannot pin a socket either.
        return send_capped_bytes(buf.getvalue(), mimetype="audio/wav")


    @bp.route("/playground/clips/<path:ref>/audio")
    def playground_clip_audio(ref):
        # 🔴 CAUGHT LIVE ON THE DEPLOYED BOX: every clip in the library 404'd. output/ is a vault
        # tree, so the bare .exists() was False for a clip that had JUST been rendered and was
        # listed on the page. `send_store_file` below routes — only the guard in front of it did
        # not, so the fix is one call, and the symptom was "the whole Playground library is mute".
        mp3, _y = playground_clips.clip_paths(OUTPUT_DIR / "playground", ref)
        if mp3 is None or not vault_fs.exists(mp3):
            abort(404)
        download = request.args.get("download") == "1"
        return send_store_file(mp3, as_attachment=download,    # Range support for scrubbing
                              download_name=mp3.name if download else None)


    @bp.route("/playground/clips/<path:ref>/rename", methods=["POST"])
    def playground_clip_rename(ref):
        """Rename a clip's display name (both files move to '<name>_<H8>'). The H8
        identity suffix is preserved, so a re-render of the same inputs still
        overwrites the renamed clip. Body: {name}."""
        name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
        try:
            new_ref = playground_clips.rename_clip(OUTPUT_DIR / "playground", ref, name)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if new_ref is None:
            abort(404)
        # 🔴 A RENAME MOVES THE REF, and the star is keyed on the WHOLE ref. `rename_clip` rebuilds
        # the stem from `safe_name(name)` and hands back `vdir/<new stem>` for the same audio, so
        # without this line the favorite is left naming a row that no longer exists and `for_rows`
        # drops it in silence on the next listing. Identical to the scene bug fixed in 8.8.3 — and
        # `rekey`'s own docstring used to certify this kind as not needing the call, which is why
        # the scene half was fixed and this one was not. Shipped broken since 6.2.
        clip_favorites.rekey(paths.CLIP_FAVORITES.parent, clip_sources.PLAYGROUND, ref, new_ref)
        # 8.9 — and the FOLDER, for the same reason and by the same mechanism. Two small stores
        # keyed on the same moving ref; a rename has to carry both or the row drops out of its
        # folder as silently as it used to lose its star.
        folders.rekey(paths.FOLDERS.parent, "playground_clips", ref, new_ref)
        # 🔴 AND AGAIN UNDER THE COMPOSED REF — this clip is a row in TWO scopes. Voice Swap ▸
        # Sources merges five stores into one list and composes the refs it owns itself, so a
        # Playground clip appears there as `pg/<vdir>/<stem>` in the `voiceswap_songs` scope
        # (see `vsSources` in js/media/voiceswap.js). That second assignment is keyed on a string
        # no `playground_clips` rekey can reach, so a rename left the Voice Swap row filed under
        # a dead ref and `for_rows` dropped it in silence.
        folders.rekey(paths.FOLDERS.parent, "voiceswap_songs", "pg/" + ref, "pg/" + new_ref)
        return jsonify({"ok": True, "ref": new_ref})


    @bp.route("/playground/clips/<path:ref>/favorite", methods=["POST"])
    def playground_clip_favorite(ref):
        """Toggle a clip's ★ (sidecar `favorite`). Body: {favorite: bool}."""
        fav = bool((request.get_json(silent=True) or {}).get("favorite"))
        stored = playground_clips.set_clip_favorite(OUTPUT_DIR / "playground", ref, fav)
        if stored is None:
            abort(404)
        return jsonify({"ok": True, "favorite": stored})


    @bp.route("/playground/partials/<h>/favorite", methods=["POST"])
    def playground_partial_favorite(h):
        """Toggle a partial's ★ (manifest `favorite` — carried into the finished
        clip's sidecar on completion). Body: {favorite: bool}."""
        fav = bool((request.get_json(silent=True) or {}).get("favorite"))
        stored = playground_clips.set_partial_favorite(CHUNKS_ROOT, h, fav)
        if stored is None:
            abort(404)
        return jsonify({"ok": True, "favorite": stored})


    @bp.route("/playground/partials/<h>/rename", methods=["POST"])
    def playground_partial_rename(h):
        """Rename an interrupted render: the name lives in its pending.yaml, shows in
        the library row, and becomes the finished clip's stem when the render
        completes. Body: {name}."""
        name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
        try:
            stored = playground_clips.rename_partial(CHUNKS_ROOT, h, name)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if stored is None:
            abort(404)
        return jsonify({"ok": True, "name": stored})


    @bp.route("/playground/partials/<h>/enhance", methods=["POST"])
    def playground_partial_enhance(h):
        """Enhance the banked prefix of a partial into a new clip; keep the partial resumable. The body supplies the enhancement settings."""
        if not re.fullmatch(r"[0-9a-f]{12}", h):
            abort(404)
        if not enhancement.enhance_available():
            return jsonify({"error": enhancement.enhance_unavailable_reason()}), 400
        ws = playground_clips.workspace(CHUNKS_ROOT, h)
        # M10 §4.5 — vault_fs.exists, or this 409s "no banked audio yet" for EVERY partial and the
        # whole feature is unreachable: the button is there, the audio is there, the answer is no.
        if not vault_fs.exists(ws / "chunk_0000.wav"):
            return jsonify({"error": "this partial has no banked audio yet — nothing to enhance"}), 409
        meta = playground_clips.read_pending(ws) or {}
        nfe = enhance.validate_nfe((request.get_json(silent=True) or {}).get("nfe"))
        # ONE card, emptiest-first, not busy with a training — the same claim /clips/<ref>/enhance
        # makes. The worker's finally releases it.
        device, why = GPUS.claim_card(gpu.cards_emptiest_first(enhancement.enhance_cards()),
                                      )
        if device is None:
            return jsonify({"error": enhancement.ENHANCE_BUSY[why]}), 409
        job = Job(id=uuid.uuid4().hex[:12], docx="", voice=str(meta.get("voice") or ""),
                  params=GenParams(), gpus="", workers=0, kind="enhance",
                  status="queued", enhance=True, enhance_nfe=nfe, clip_ref="")
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        try:
            threading.Thread(target=_enhance_partial_job, args=(job, h, meta, nfe, device),
                             daemon=True).start()
        except BaseException:               # no thread ⇒ no finally ⇒ the card would be lost for good
            GPUS.release_card(device)
            raise
        est = enhance.estimate_seconds(playground_clips.banked_prefix_seconds(ws) or 0, nfe)
        return jsonify({"job_id": job.id, "est_s": round(est, 1) if est else None}), 202


    @bp.route("/playground/clips/<path:ref>/enhance", methods=["POST"])
    def playground_clip_enhance(ref):
        """Bandwidth-extend a clip that is ALREADY in the library, replacing it. Body: {nfe}.

        Why it exists: a clip goes to Voice Training as its MP3, and training must enhance any
        band-limited source it is given — band-limited audio collapses the run. That result is
        cached on (path, size, mtime), so training the same pool file twice is free, but SENDING
        the clip again mints a new mtime and pays for the whole enhancement a second time.
        Enhance it once, here, and every send after that is already full-band: prep measures it,
        finds nothing to do, and starts the run immediately.

        The source is the stored MP3 — a Playground render's WAV is transient and is long gone.
        That is not a new compromise: /train/import already hands training exactly this MP3, so
        this changes WHEN the enhancer sees it, not WHAT it sees.

        Refuses when the clip is already full-band, because that is a MEASUREMENT (DESIGN §5.1)
        and it is the same answer for a clip we enhanced and for a genuine 48 kHz upload we
        didn't. Neither has anything to gain.
        """
        if not enhancement.enhance_available():
            return jsonify({"error": enhancement.enhance_unavailable_reason()}), 400
        root = OUTPUT_DIR / "playground"
        mp3, y = playground_clips.clip_paths(root, ref)
        if mp3 is None or not vault_fs.exists(mp3):    # output/ is a vault tree
            abort(404)
        # STRICT. _enhance_clip_job writes a NEW sidecar from this map and then unlinks the
        # original mp3 + yaml — so an unreadable sidecar read as {} would replace the clip with
        # one that has forgotten its own text, voice and knobs. It survives today only because
        # the `text` gate below happens to reject {} as well, and its message — "no sidecar" —
        # is a lie about a clip whose sidecar is right there and merely corrupt. A destroy that
        # is guarded by a coincidence is not guarded, and the user deserves a true error.
        try:
            meta = playground_clips._read_yaml(y, strict=True) or {}
        except playground_clips.ClipSidecarUnreadable:
            return jsonify({"error": "this clip's sidecar is corrupt — it can't be read, so "
                                     "enhancing would replace the clip with one that has "
                                     "forgotten its own text and settings. Nothing was "
                                     "changed."}), 409
        if not meta.get("text"):
            return jsonify({"error": "this clip has no recorded inputs (no sidecar), so its "
                                     "enhanced identity can't be derived. Re-render it with "
                                     "Enhance ticked instead."}), 400
        hz, _fresh = enhance.bandwidth_of(mp3, meta)
        # Unknown and full-band are NOT the same answer, even though is_band_limited folds them
        # together (deliberately — "a probe that failed is not a license to act", and it is
        # deciding whether to SPEND a GPU). Here it is deciding what to TELL the user, and
        # "already full-band" about a file we could not read is simply false.
        if not hz:
            return jsonify({"error": "couldn't measure this clip — so there is no way to know "
                                     "whether enhancing it would add anything, and nothing was "
                                     "spent finding out."}), 409
        if not enhance.is_band_limited(hz):
            return jsonify({"error": "already full quality", "bandwidth_hz": hz}), 409

        nfe = enhance.validate_nfe((request.get_json(silent=True) or {}).get("nfe"))
        # ONE card, not all of them. The enhancer wants ~21 GB and can't share a card with a
        # render (which holds every card for its whole life) or with a training (hours) — but
        # two enhancements on two cards are just two child processes on two cards, which is
        # what the book's own post-pass has always done. Claiming here rather than queueing
        # keeps the endpoint's promise: a background tidy-up never leaves the user waiting in
        # silence for a job they are not watching.
        device, why = GPUS.claim_card(gpu.cards_emptiest_first(enhancement.enhance_cards()),
                                      )
        if device is None:
            return jsonify({"error": enhancement.ENHANCE_BUSY[why]}), 409
        # An enhance job renders nothing, so it names no devices — `gpus` stays empty and
        # `resolve_devices` is never asked about it; the card this enhancement got is in its
        # log, where the user is.
        job = Job(id=uuid.uuid4().hex[:12], docx="", voice=str(meta.get("voice") or ""),
                  params=GenParams(), gpus="", workers=0, kind="enhance",
                  status="queued", enhance=True, enhance_nfe=nfe, clip_ref=ref)
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        try:
            threading.Thread(target=_enhance_clip_job, args=(job, root, ref, meta, nfe, device),
                             daemon=True).start()
        except BaseException:          # the thread's finally is what frees the card — no thread,
            GPUS.release_card(device)  # no finally, and the card would be lost for good
            raise
        est = enhance.estimate_seconds(meta.get("duration_s") or 0, nfe)
        # null when this box has never been timed — the client must not turn that into a 0.
        return jsonify({"job_id": job.id,
                        "est_s": round(est, 1) if est else None}), 202


    @bp.route("/playground/enhance/<job_id>")
    def playground_enhance_status(job_id):
        """Poll a library-clip enhancement. `ref` is the NEW ref once it lands (the clip's
        identity changes with it), which is what the row has to re-point at."""
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if job is None or job.kind != "enhance":
            abort(404)
        events = list(job.events)          # snapshot — the worker is appending to it right now
        line = next((e.get("line") for e in reversed(events) if e.get("type") == "log"), "")
        return jsonify({"status": job.status, "error": job.error,
                        "ref": job.clip_ref, "line": line})


    @bp.route("/playground/enhance/<job_id>/cancel", methods=["POST"])
    def playground_enhance_cancel(job_id):
        """Stop an enhancement mid-flight. The clip is untouched until the enhanced file is
        safely on disk, so a cancel can never leave a half-clip: it leaves the original."""
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if job is None or job.kind != "enhance":
            abort(404)
        job.cancel.set()
        return jsonify({"ok": True})


    @bp.route("/playground/clips", methods=["DELETE"])
    def playground_clips_delete():
        """Single and multi-delete in one endpoint: {clips: [ref, …], partials: [H, …]}."""
        body = request.get_json(silent=True) or {}
        deleted = playground_clips.delete_clips(OUTPUT_DIR / "playground",
                                                [str(r) for r in body.get("clips") or []])
        deleted += playground_clips.delete_partials(CHUNKS_ROOT,
                                                    [str(h) for h in body.get("partials") or []])
        return jsonify({"deleted": deleted})


    @bp.route("/playground/clips/zip", methods=["POST"])
    def playground_clips_zip():
        """Download selected complete clips and partials as one archive. Skip references that disappeared after selection. Use a native form download so the browser does not buffer a multi-hour render archive in a JavaScript blob. Store MP3 entries without DEFLATE because they are already compressed."""
        if request.is_json:
            body = request.get_json(silent=True) or {}
            refs = [str(r) for r in body.get("clips") or []]
            hs   = [str(h) for h in body.get("partials") or []]
        else:
            refs = request.form.getlist("clips")
            hs   = request.form.getlist("partials")
        if not refs and not hs:
            return jsonify({"error": "nothing selected"}), 400

        root  = OUTPUT_DIR / "playground"
        used  = set()
        items = []                       # (name-in-zip, mtime, open() -> readable)

        def _unique(stem: str) -> str:
            return zip_stream.unique_name(stem, used)

        for ref in refs:
            mp3, _y = playground_clips.clip_paths(root, ref)
            if mp3 is None or not vault_fs.exists(mp3):
                continue
            st = vault_fs.stat(mp3)
            items.append((_unique(mp3.name), st.mtime if st else 0,
                          lambda p=mp3: vault_fs.open_read(p)))

        for h in hs:
            if not re.fullmatch(r"[0-9a-f]{12}", h):
                continue
            ws = playground_clips.workspace(CHUNKS_ROOT, h)
            if not vault_fs.exists(ws / "chunk_0000.wav"):
                continue                 # nothing banked yet — prefix_wav would return None
            m = playground_clips._read_yaml(ws / playground_clips.PENDING_NAME) or {}
            stem = safe_name(str(m.get("text", ""))[:120], 30) or f"clip_{h[:8]}"
            dstat = vault_fs.stat(ws)
            items.append((_unique(f"{stem}_partial.wav"), dstat.mtime if dstat else 0,
                          lambda k=h: _partial_wav_reader(k)))

        if not items:
            abort(404)                   # everything named is gone; an empty zip would lie

        n = len(items)
        return Response(zip_stream.stream(items), mimetype="application/zip", headers={
            "Content-Disposition": 'attachment; filename="{}"'.format(
                "playground-clip.zip" if n == 1 else f"playground-clips-{n}.zip"),
            "Cache-Control": "no-store",
        })

    return bp
