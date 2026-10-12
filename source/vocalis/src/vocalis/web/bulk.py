"""`/bulk/*` — the Bulk tab (4.5, DESIGN_4_5_BULK_ENHANCE.md).

One tab, one lifecycle, two modes. `bulk.py` (top-level `src/`) owns the lifecycle — stage →
fan-out → ZIP → persist → sweep — and knows nothing about GPUs; the per-file ENGINE is
injected, and the two engines are what this module contributes on top of the routes. Design §3
asks for a thin skin and this is it, plus the two things a skin cannot be thin about: which
cards an enhance batch may use, and how a worker yields a card to an arriving render.

⚠️ **`import bulk` here is the top-level engine module, not this one.** Python 3 imports are
absolute, so `vocalis.web.bulk` and `bulk` are unrelated names that happen to be spelled the
same. Confusing to read, correct to run — and renaming either would be worse: the engine's name
is in a design doc and thirteen test files, and every other blueprint in this package is named
after the URL prefix it serves.

**`bulk_cfg` is NOT here — it is `runtime/configs.py`.** P4.5 put it at module level in this
file, on the reasoning that only these routes read it. `run_store_startup_tasks` also calls it,
to re-adopt the last completed batch across a restart, and moving it broke the boot path (see
P4.5a). The engines stay at module level because a name a test replaces is a seam and a seam
cannot be a closure; the route-local helpers (`_bulk_job_or_404`, `_bulk_mode_or_404`) have no
such claim and stay inside the factory.
"""
import os
import shutil
import threading
import time
import zipfile
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

import bulk
import cleanup
import enhance
from tts_utils import ffprobe_duration

from vocalis.runtime import configs
from vocalis.runtime import enhancement
from vocalis.runtime import gpu
from vocalis.runtime import jobs
from vocalis.runtime.jobs import emit


class _BulkEnhanceEngine:
    """Bulk Enhance's per-file engine: bandwidth-extend one file on one card, encode to the
    chosen format. One worker per SELECTED card (design §6) — enhancement-class, not
    render-class: it claims ONE card per file and releases between files, so a render that
    arrives mid-batch preempts (claim_card refuses while a render holds or waits, and the
    workers simply stop taking new files until it is done, then resume). It never calls
    GPUS.acquire(), which would seize every card for the whole batch."""

    def __init__(self, nfe: int, cards: list, fmt: str):
        self.nfe, self.cards, self.fmt = nfe, cards, fmt

    def slots(self, job) -> list:
        return list(self.cards)

    def process(self, job, src: Path, dst: Path, device: str):
        # Wait for THIS card, yielding to renders. claim_card's busy= already excludes a
        # training-held card, so by the time we hold it, only enhance_one's own card_lock
        # (belt-and-braces against a training that starts in the microsecond after) remains.
        told = ""
        while not job.cancel.is_set():
            got, why = gpu.GPUS.claim_card([device])
            if got is not None:
                break
            if why != told:                       # narrate the reason once, not 2x/second
                told = why
                emit(job, {"type": "log",
                           "line": f"{src.name}: waiting — {enhancement.ENHANCE_BUSY[why]}"})
            job.cancel.wait(0.5)                   # interruptible sleep
        else:
            return None                            # canceled while waiting
        try:
            scratch = enhance.scratch_path(configs.enhance_cfg(), src, tag=f"bulk|{job.id}")
            scratch.parent.mkdir(parents=True, exist_ok=True)
            try:
                if not enhancement.enhance_one(job, src, scratch, self.nfe, device, src.name):
                    return None                    # canceled inside the child
                return bulk.encode_output(scratch, dst, self.fmt)
            finally:
                scratch.unlink(missing_ok=True)    # plaintext must not outlive the stage (5.0 §8.3)
        finally:
            gpu.GPUS.release_card(device)


class _BulkCleanupEngine:
    """Bulk Clean up's per-file engine: DeepFilterNet3 denoise one file on the CPU, encode to
    the chosen format. NO card pinning (design §12) — the fan-out is a CPU worker pool, so a
    bulk clean-up contends with nothing (renders, trainings) and can run straight through a
    render night. Denoise-only, one-in/one-out. The DFN3 child reads with soundfile, which
    can't read MP3, so each file is decoded to a scratch WAV first (as the book's denoise path
    does), denoised, then encoded to the target."""

    def __init__(self, fmt: str):
        self.fmt = fmt

    def slots(self, job) -> list:
        # min(N_files, cpu-2). DFN3 is CPU real-time++, so more workers buy throughput until
        # the cores run out; leave 2 for the box (and never fewer than one worker).
        n = max(1, min(job.total, (os.cpu_count() or 3) - 2))
        return list(range(n))

    def process(self, job, src: Path, dst: Path, slot):
        cfg = configs.cleanup_cfg()
        wav_in = cleanup.scratch_path(cfg, src, tag=f"bulkin|{job.id}")
        cleaned = cleanup.scratch_path(cfg, src, tag=f"bulkout|{job.id}")
        try:
            # run_denoise polls the cancel event and kills its child, but the ffmpeg decode and
            # encode either side of it are blocking subprocess.run calls that don't. Check between
            # the steps so a Cancel doesn't sit through a transcode of a file it has already
            # abandoned — worth a few seconds per in-flight file on a big chapter.
            if job.cancel.is_set():
                return None
            bulk.decode_to_wav(src, wav_in)               # any source → mono WAV (DFN3 needs WAV)
            if job.cancel.is_set():
                return None
            rc = cleanup.run_denoise(cfg, wav_in, cleaned, cancel=job.cancel,
                                     on_line=lambda line: emit(job, {"type": "log", "line": line}))
            if rc == -1 or job.cancel.is_set():
                return None                               # canceled inside the child
            if rc != 0 or not cleaned.is_file():
                raise RuntimeError(f"clean up failed on {src.name} (exit {rc})")
            return bulk.land_output(cleaned, dst, self.fmt, source=src)
        finally:
            wav_in.unlink(missing_ok=True)                # plaintext must not outlive the stage
            cleaned.unlink(missing_ok=True)


def _bulk_enhance_cards(request_form):
    """Resolve the enhance batch's card list from the GPU picker. Returns (cards, error_json,
    status) — cards is None on error. The picker (§6) sends the ticked subset; absent → all
    eligible; an explicit selection matching none is a 400 (the user meant to narrow it)."""
    eligible = enhancement.enhance_cards()          # the ⚙ Settings pool ∩ CUDA
    if not eligible:
        return None, {"error": enhancement.enhance_unavailable_reason()}, 400
    sel = (request_form.get("cards") or "").strip()
    if sel:
        want = {c.strip().split(":")[-1] for c in sel.split(",") if c.strip()}
        chosen = [d for d in eligible if str(gpu.card_index(d)) in want]
        if not chosen:
            return None, {"error": "none of the selected GPUs are eligible for enhancement — "
                                   "pick at least one, or check ⚙ Settings"}, 400
    else:
        chosen = eligible
    return gpu.cards_emptiest_first(chosen), None, 200


def create_bulk_blueprint() -> Blueprint:
    """No injected state — see web/comfyui.py. The engines above are constructed per batch and
    handed to `bulk.run_bulk_job`, which is injection in the direction that was always intended:
    the lifecycle takes the GPU policy, not the other way round."""
    bp = Blueprint("vocalis_bulk", __name__)

    def _bulk_job_or_404(job_id):
        job = bulk.get_job(job_id)
        if job is None:
            abort(404)
        return job

    def _bulk_mode_or_404(mode):
        """Every per-mode route funnels through here: an unknown mode is a 404, never a
        KeyError and never a silent fall-through to the other tab's files."""
        return mode if mode in bulk.MODES else None

    @bp.route("/bulk/<mode>", methods=["POST"])
    def bulk_start(mode):
        """Start a batch. `mode` ∈ enhance|cleanup. Multipart: one or more `file` parts, plus
        `format`, and (enhance) `nfe` + `cards`. Stages the uploads, spawns the fan-out, 202
        {job_id}. A new upload is the implicit reset — it wipes the previous last batch first
        (design §7). One batch at a time (across both modes): a second start while one runs
        is 409."""
        if mode not in ("enhance", "cleanup"):
            return jsonify({"error": "mode must be 'enhance' or 'cleanup'"}), 404
        if bulk.live_job() is not None:
            return jsonify({"error": "a batch is already running — wait for it or "
                                     "cancel it first"}), 409

        # The TAB stages its files as they're picked and posts none here (§5a). A direct API
        # caller can still POST them inline, so both paths stay live: multipart wins when present.
        cfg = configs.bulk_cfg()
        files = [(f.filename, f.stream) for f in request.files.getlist("file") if f.filename]
        if not files and not bulk.staged_files(cfg, mode):
            return jsonify({"error": "no files staged — pick some files first"}), 400
        if mode == "enhance":
            if not enhancement.enhance_available():
                return jsonify({"error": enhancement.enhance_unavailable_reason()}), 400
            fmt = bulk.resolve_format(request.form.get("format"))
            nfe = enhance.validate_nfe(request.form.get("nfe"))
            cards, err, code = _bulk_enhance_cards(request.form)
            if err:
                return jsonify(err), code
            engine = _BulkEnhanceEngine(nfe, cards, fmt)
        else:
            ccfg = configs.cleanup_cfg()
            if not ccfg.denoise_available:
                return jsonify({"error": ccfg.denoise_unavailable_reason}), 400
            # 'match source' is Clean-up's default: a denoise adds no bandwidth, so don't inflate.
            fmt = bulk.resolve_format(request.form.get("format") or bulk.SOURCE_FORMAT,
                                      allow_source=True)
            nfe, cards = 0, []
            engine = _BulkCleanupEngine(fmt)

        # Implicit reset — wipes THIS mode's previous batch, leaves the other tab's alone (§5b).
        bulk.clear_batches(cfg, mode=mode)
        job = bulk.new_job(mode=mode, fmt=fmt, nfe=nfe, cards=cards)
        try:
            if files:
                bulk.stage_uploads(cfg, job, files)      # direct API caller: inline multipart
            else:
                bulk.stage_from_staging(cfg, job)        # the tab: run what's staged (§5a)
        except OSError as exc:
            shutil.rmtree(cfg.scratch_root / job.id, ignore_errors=True)
            return jsonify({"error": f"could not stage uploads: {exc}"}), 500
        job.audio_s = sum(ffprobe_duration(p) or 0 for p, _o in job.inputs)
        if mode == "enhance":
            est = enhance.estimate_seconds(job.audio_s, nfe, cards=min(len(cards), job.total),
                                           files=job.total)
        else:
            est = cleanup.estimate_seconds(job.audio_s, files=job.total, device="cpu")
        try:
            threading.Thread(target=bulk.run_bulk_job, args=(job, cfg, engine),
                             daemon=True, name=f"bulk-{job.id}").start()
        except BaseException:
            shutil.rmtree(cfg.scratch_root / job.id, ignore_errors=True)
            raise
        return jsonify({"job_id": job.id, "total": job.total,
                        "est_s": round(est, 1) if est else None,
                        "eta": enhance.eta_note(est)}), 202

    @bp.route("/bulk/events/<job_id>")
    def bulk_events(job_id):
        return jobs.job_sse(_bulk_job_or_404(job_id))

    @bp.route("/bulk/status/<job_id>")
    def bulk_status(job_id):
        """Everything a reloading page needs to reattach to a live batch or repaint a done one."""
        job = _bulk_job_or_404(job_id)
        return jsonify({"id": job.id, "status": job.status, "stage": job.stage,
                        "mode": job.mode, "format": job.fmt, "nfe": job.nfe,
                        "done": job.done, "total": job.total, "error": job.error,
                        "started_at": job.started_at, "now": time.time(),
                        "manifest": bulk.manifest_of(job),
                        "canceling": job.cancel.is_set()
                                      and job.status in ("queued", "running")})

    @bp.route("/bulk/cancel/<job_id>", methods=["POST"])
    def bulk_cancel(job_id):
        job = _bulk_job_or_404(job_id)
        first = not job.cancel.is_set()
        job.cancel.set()
        if first and job.status in ("queued", "running"):
            bulk.emit(job, {"type": "log", "line": "Cancel received — stopping the batch…"})
        return jsonify({"ok": True, "status": job.status})

    @bp.route("/bulk/stage/<mode>", methods=["GET"])
    def bulk_stage_list(mode):
        """What's staged FOR THIS MODE. The tab calls this ON LOAD — reading the folder is what
        makes a refresh (or a new tab, or a server restart) show the files you picked (§5a)."""
        if not _bulk_mode_or_404(mode):
            return jsonify({"error": "unknown mode"}), 404
        return jsonify(bulk.staged_files(configs.bulk_cfg(), mode))

    @bp.route("/bulk/stage/<mode>", methods=["POST"])
    def bulk_stage_add(mode):
        """Stage files as they're picked, into THIS MODE's area (§5b). Multipart `file` parts.
        Picks ACCUMULATE; a re-picked name overwrites its staged copy. Returns the new list."""
        if not _bulk_mode_or_404(mode):
            return jsonify({"error": "unknown mode"}), 404
        files = [(f.filename, f.stream) for f in request.files.getlist("file") if f.filename]
        if not files:
            return jsonify({"error": "no files uploaded (form field 'file')"}), 400
        if bulk.live_job() is not None:
            return jsonify({"error": "a batch is running — wait for it or cancel it first"}), 409
        try:
            return jsonify(bulk.stage_add(configs.bulk_cfg(), mode, files))
        except OSError as exc:
            return jsonify({"error": f"could not stage the files: {exc}"}), 500

    @bp.route("/bulk/stage/<mode>/remove", methods=["POST"])
    def bulk_stage_remove(mode):
        """Remove ONE staged file (the red ✕) — deletes it and returns this mode's new list."""
        if not _bulk_mode_or_404(mode):
            return jsonify({"error": "unknown mode"}), 404
        if bulk.live_job() is not None:
            return jsonify({"error": "a batch is running — wait for it or cancel it first"}), 409
        name = (request.get_json(silent=True) or {}).get("name") or request.form.get("name") or ""
        cfg = configs.bulk_cfg()
        if not bulk.stage_remove(cfg, mode, name):
            return jsonify({"error": "not staged", "files": bulk.staged_files(cfg, mode)}), 404
        return jsonify(bulk.staged_files(cfg, mode))

    @bp.route("/bulk/stage/<mode>/clear", methods=["POST"])
    def bulk_stage_clear(mode):
        """Remove all — empties THIS MODE's staging area, never the other's."""
        if not _bulk_mode_or_404(mode):
            return jsonify({"error": "unknown mode"}), 404
        if bulk.live_job() is not None:
            return jsonify({"error": "a batch is running — wait for it or cancel it first"}), 409
        cfg = configs.bulk_cfg()
        return jsonify({"removed": bulk.stage_clear(cfg, mode),
                        "files": bulk.staged_files(cfg, mode)})

    @bp.route("/bulk/handoff/cleanup-to-enhance", methods=["POST"])
    def bulk_handoff_cleanup_to_enhance():
        """Copy the finished Clean-up batch's OUTPUTS into Enhance's staging area (§5c).

        Spelled out rather than parameterized as /<src>/<dst> on purpose: the chain is one-way
        by design (4.4 §6 — "denoise never runs on already-enhanced audio"), so there is exactly
        one sanctioned pairing and the URL says which. REPLACES what Enhance had staged; the tab
        confirms first when that list isn't empty."""
        if bulk.live_job() is not None:
            return jsonify({"error": "a batch is running — wait for it or cancel it first"}), 409
        cfg = configs.bulk_cfg()
        try:
            files = bulk.copy_result_to_staging(cfg, "cleanup", "enhance")
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), 404
        except (OSError, zipfile.BadZipFile) as exc:
            return jsonify({"error": f"could not copy the batch: {exc}"}), 500
        return jsonify({"files": files, "count": len(files)})

    @bp.route("/bulk/info")
    def bulk_info():
        """What the setup panel needs before an upload: whether enhancement is available on this
        box, and the eligible cards to draw the GPU picker from (⚙ Settings pool ∩ CUDA, §6)."""
        names = {g["index"]: g["name"] for g in gpu.gpu_registry()}
        cards = [{"index": gpu.card_index(d), "name": names.get(gpu.card_index(d), str(d))}
                 for d in enhancement.enhance_cards()]
        ccfg = configs.cleanup_cfg()
        denoise_ok = ccfg.denoise_available
        available = enhancement.enhance_available()
        return jsonify({"available": available,
                        "message": "" if available else enhancement.enhance_unavailable_reason(),
                        "cards": cards,
                        "cleanup_available": denoise_ok,
                        "cleanup_message": "" if denoise_ok else ccfg.denoise_unavailable_reason})

    @bp.route("/bulk/jobs")
    def bulk_jobs():
        """Live/recent batches — the reload-reattach entry point (only ever one is live)."""
        # `live`, not `jobs`: this module imports vocalis.runtime.jobs under that name. See the
        # same note in web/stems.py — it is P3.4's `pool = pool.current_pool()` shape.
        with bulk.JOBS_LOCK:
            live = list(bulk.JOBS.values())
        return jsonify([{"id": j.id, "status": j.status, "stage": j.stage,
                         "mode": j.mode, "done": j.done, "total": j.total} for j in live])

    @bp.route("/bulk/current/<mode>")
    def bulk_current(mode):
        """THIS MODE's persisted last-batch manifest (or {}) — what its tab renders on load
        (§5b)."""
        if not _bulk_mode_or_404(mode):
            return jsonify({"error": "unknown mode"}), 404
        return jsonify(bulk.manifest_of(bulk.current_job(mode)))

    @bp.route("/bulk/download/<mode>")
    def bulk_download(mode):
        """Serve THIS MODE's last result.zip. Re-download is free — no reprocessing."""
        if not _bulk_mode_or_404(mode):
            abort(404)
        job = bulk.current_job(mode)
        if job is None or not job.result_zip or not Path(job.result_zip).is_file():
            abort(404)
        stamp = time.strftime("%Y%m%d-%H%M",
                              time.localtime(job.manifest.get("created") or time.time()))
        return send_file(job.result_zip, mimetype="application/zip", as_attachment=True,
                         download_name=f"bulk-{job.mode}-{stamp}.zip")

    @bp.route("/bulk/reset/<mode>", methods=["POST"])
    def bulk_reset(mode):
        """Explicit Clear — delete THIS MODE's batch dir and repaint empty (§7). The other
        mode's retained batch is untouched."""
        if not _bulk_mode_or_404(mode):
            return jsonify({"error": "unknown mode"}), 404
        bulk.clear_batches(configs.bulk_cfg(), mode=mode)
        return jsonify({"ok": True})

    return bp
