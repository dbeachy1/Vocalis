"""`/cleanup/*` — the Clean up tab (4.4): trim and denoise a clip into new clip(s).

`cleanup.py` owns the engine — the DeepFilterNet3 child, the trim scorer, the rate stores — and
these eight routes are the skin. The three background jobs (`_cleanup_score_job`,
`_cleanup_job`, and the preview reaper) live here because they are the tab's own lifecycle, not
the engine's.

**Why this is a separate blueprint from `web/train.py` and not part of it.** It operates
entirely on TRAINING clips — every route resolves its input through `speech_sources.source_path` —
so on the URL prefix alone it looks like a sub-tab of Training. It is not: the Bulk tab's
Clean-up mode runs the same engine on files that never touch the training pool, the trim scorer
is used by nothing in Training, and §12 of the 4.5 design has the two fanning out differently
(a CPU pool here, card-pinned workers there). Two tabs that share a *store* are not one domain.

⚠️ 4.4-m6/m6a: the trim scorer's tuning is a BEHAVIOR FREEZE. Nothing in this file changes the
numbers; the move is a relocation and the routes are byte-for-byte what they were.
"""
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

import cleanup
import scratch
import vault_fs
import speech_sources
from loguru import logger
from tts_utils import GenParams, ffprobe_duration

from store_serve import send_store_file
from vocalis.runtime import configs
from vocalis.runtime.jobs import JOBS, JOBS_LOCK, Job, emit, prune_jobs as _prune_jobs


def cleanup_preview_dir() -> Path:
    """Where the A/B snippets live: the SCRATCH, never `output/` (M10 §7.1).

    Module level, not a closure inside the factory, because `test_m6_e2e` asks it directly —
    "is this path in the scratch, and does the vault router refuse to claim it?" — which is the
    whole content of §7.1's decision. Same rule as `web/bulk.py`'s `bulk_cfg`: a name a test has
    to reach is a seam, and a seam cannot be a closure.

    A FUNCTION, not a constant: `scratch_root()` resolves fresh per use (env wins, then
    app_settings), so the suite can repoint it per test.
    """
    return configs.scratch_root() / scratch.CLEANUP_PREVIEW_SUBDIR


def create_cleanup_blueprint() -> Blueprint:
    """No injected state — see web/comfyui.py."""
    bp = Blueprint("vocalis_cleanup", __name__)


    def _passes_summary(passes: dict) -> str:
        """The derivation string a cleaned clip records and shows: 'trim@6 + denoise@1'."""
        p = cleanup.normalize_passes(passes)
        bits = []
        if p["trim"]["enabled"]:
            bits.append(f"trim@{p['trim']['max_excess_db']:g}")
        if p["denoise"]["enabled"]:
            d = p["denoise"]
            bits.append(f"denoise@{d['wet']:g}" + (f" atten{d['atten']:g}" if d["atten"] else ""))
        return " + ".join(bits) or "no-op"


    @bp.route("/cleanup/info")
    def cleanup_info():
        """What Clean up can do on THIS box: which passes are installed and the measured denoise
        rate (None until this box has timed one — the client turns None into 'no estimate yet',
        never a zero). The Speech tab reads this to show the ✨ Clean up action and an honest ETA."""
        cfg = configs.cleanup_cfg()
        fit = cleanup.measured()
        return jsonify({
            "trim_available": cfg.trim_available,
            "denoise_available": cfg.denoise_available,
            "denoise_unavailable_reason": cfg.denoise_unavailable_reason,
            # 4.4-m3: whether the torch Trim scorer (Silero VAD + PANNs tagger) is installed. When true,
            # the workspace offers the music/SFX veto slider and runs the async /cleanup/score pass;
            # when false, Trim degrades to the shipped SNR-only MVP (no music veto).
            "trim_scorer_available": cfg.trim_scorer_available,
            "trim_scorer_unavailable_reason": cfg.trim_scorer_unavailable_reason,
            "default": cleanup.DEFAULT_PRESET,
            "rate": ({"startup_s": round(fit[0], 3), "per_s": round(fit[1], 4)} if fit else None),
        })


    @bp.route("/cleanup/analyze", methods=["POST"])
    def cleanup_analyze():
        """Score a clip's speech regions for the Trim timeline, writing nothing. Body: {ref}.
        The client applies the threshold live, so this is one call per clip, not per slider tick."""
        cfg = configs.cleanup_cfg()
        if not cfg.trim_available:
            return jsonify({"error": "trim is unavailable on this box"}), 400
        ref = str((request.get_json(silent=True) or {}).get("ref", ""))
        p = speech_sources.source_path(configs.speech_cfg(), ref)
        if p is None:
            abort(404)
        try:
            return jsonify(cleanup.analyze(cfg, p))
        except Exception as exc:                       # noqa: BLE001 — surfaced to the client
            logger.exception("cleanup analyze failed")
            return jsonify({"error": f"could not analyze this clip: {exc}"}), 500


    def _cleanup_score_job(job: Job, src: Path) -> None:
        """Compute + cache the VAD+tagger scores for a clip (4.4-m3 §2.3) — the slow, once-per-clip
        child that analyze() reads from cache. A background job so the workspace never blocks on a 3-min
        CPU pass; it has a cancel and a log, no card to release. On success the client re-calls
        /cleanup/analyze, which now returns the upgraded (music/SFX-aware) timeline from cache."""
        try:
            job.status = "running"
            cfg = configs.cleanup_cfg()
            emit(job, {"type": "log",
                       "line": f"Detecting music / SFX in “{src.name}” (once per clip)…"})
            ok = cleanup.run_scorer(cfg, src, cancel=job.cancel,
                                    on_line=lambda line: emit(job, {"type": "log", "line": line}))
            if job.cancel.is_set():
                job.status = "canceled"
                return
            job.status = "done" if ok else "failed"
            if not ok:
                # The scorer's own error is in the job log above this line; the old text sent
                # users to scripts/cleanup/setup_trim.sh, which the Docker edition does not have.
                job.error = "could not score this clip; the job log has the scorer's own error"
        except Exception as exc:                       # noqa: BLE001 — surfaced to the client
            logger.exception("cleanup score failed")
            job.status, job.error = "failed", str(exc)
        finally:
            emit(job, {"type": "job_done", "status": job.status, "error": job.error})


    @bp.route("/cleanup/score", methods=["POST"])
    def cleanup_score():
        """Kick the async VAD+tagger scoring pass for a clip (4.4-m3). Body: {ref}. Returns a job_id
        the client drives on the shared /cleanup/<job_id> rails, then re-analyzes for the upgraded
        timeline. 400 when the scorer isn't installed (the client then stays on the SNR-only MVP)."""
        cfg = configs.cleanup_cfg()
        data = request.get_json(silent=True) or {}
        src = speech_sources.source_path(configs.speech_cfg(), str(data.get("ref", "")))
        if src is None:
            abort(404)
        if not cfg.trim_scorer_available:
            return jsonify({"error": f"the trim scorer is unavailable on this box: "
                                     f"{cfg.trim_scorer_unavailable_reason}"}), 400
        job = Job(id=uuid.uuid4().hex[:12], docx="", voice="",
                  params=GenParams(), gpus="", workers=0, kind="cleanup", status="queued",
                  clip_ref="")
        job.cleanup_refs = []
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        threading.Thread(target=_cleanup_score_job, args=(job, src), daemon=True).start()
        return jsonify({"job_id": job.id}), 202


    def _cleanup_job(job: Job, src: Path, base_stem: str, passes: dict) -> None:
        """Run the passes and stamp each output's sidecar (provenance 'cleaned' + derivation). The
        engine lands the audio atomically per take; this adds the store bookkeeping the Speech tab
        reads. No card to release — this is the whole reason cleanup has no finally-releases-a-card
        dance that enhancement needs."""
        try:
            job.status = "running"
            cfg = configs.cleanup_cfg()
            out_dir = configs.speech_cfg().training_dir
            on_line = lambda line: emit(job, {"type": "log", "line": line})   # noqa: E731
            on_stage = lambda s: emit(job, {"type": "log", "line": f"… {s}"})  # noqa: E731
            emit(job, {"type": "log",
                       "line": f"Cleaning “{src.name}” — {_passes_summary(passes)}."})
            outputs = cleanup.run_cleanup(cfg, src, passes, out_dir, base_stem,
                                          cancel=job.cancel, on_line=on_line, on_stage=on_stage)
            if job.cancel.is_set():
                job.status = "canceled"
                emit(job, {"type": "log", "line": "Canceled."})
                return
            if not outputs:
                job.status = "failed"
                job.error = ("trim dropped everything at this threshold — nothing was kept. "
                             "Loosen the threshold and try again.")
                return
            refs = []
            for o in outputs:
                dst = Path(o["path"])
                meta = {
                    "provenance": "cleaned",
                    "cleaned_from": src.name,
                    "cleanup": _passes_summary(passes),
                }
                # OMITTED, not None, when the source has no readable identity (M10 §4.2 C4). The key
                # exists to answer "already cleaned with these knobs?"; a recorded `None` is not an
                # answer of "no", it is two different clips both claiming the same non-identity, and
                # the first naive equality check would call them the same cleaning.
                h = cleanup.cleanup_hash(src, passes)
                if h is not None:
                    meta["cleanup_hash"] = h
                speech_sources._write_source_meta(dst, meta)
                refs.append(dst.name)
            job.cleanup_refs = refs
            job.clip_ref = refs[0] if refs else ""
            job.status = "done"
            emit(job, {"type": "log",
                       "line": f"✓ Cleaned — {len(refs)} clip{'' if len(refs) == 1 else 's'} "
                               f"added to the Speech tab."})
        except Exception as exc:                       # noqa: BLE001 — surfaced to the client
            logger.exception("cleanup failed")
            job.status, job.error = "failed", str(exc)
        finally:
            # "job_done" (not "done") so book_events treats it as terminal and CLOSES the SSE — this
            # job has no vram heartbeat, so a non-terminal final event would leave the stream blocked.
            emit(job, {"type": "job_done", "status": job.status, "error": job.error,
                       "refs": getattr(job, "cleanup_refs", [])})


    @bp.route("/cleanup/run", methods=["POST"])
    def cleanup_run():
        """Run the selected passes and land the cleaned clip(s) into the Speech tab. Body:
        {ref, trim:{enabled,max_excess_db}, denoise:{enabled,wet,atten}}."""
        cfg = configs.cleanup_cfg()
        data = request.get_json(silent=True) or {}
        src = speech_sources.source_path(configs.speech_cfg(), str(data.get("ref", "")))
        if src is None:
            abort(404)
        passes = cleanup.normalize_passes({"trim": data.get("trim") or {},
                                           "denoise": data.get("denoise") or {}})
        if not passes["trim"]["enabled"] and not passes["denoise"]["enabled"]:
            return jsonify({"error": "pick at least one pass — Trim, Denoise, or both"}), 400
        if passes["denoise"]["enabled"] and not cfg.denoise_available:
            return jsonify({"error": cfg.denoise_unavailable_reason}), 400
        if passes["trim"]["enabled"] and not cfg.trim_available:
            return jsonify({"error": "trim is unavailable on this box"}), 400
        job = Job(id=uuid.uuid4().hex[:12], docx="", voice="",
                  params=GenParams(), gpus="", workers=0, kind="cleanup", status="queued",
                  clip_ref="")
        job.cleanup_refs = []
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        threading.Thread(target=_cleanup_job, args=(job, src, src.stem, passes),
                         daemon=True).start()
        # ETA covers the denoise pass (trim is fast, decode-bound). Trim's take count is unknown
        # until it runs, so quote the simple denoise-only case (one model load) over the duration.
        dur = ffprobe_duration(src) or 0
        est = cleanup.estimate_seconds(dur, files=1) if passes["denoise"]["enabled"] else None
        return jsonify({"job_id": job.id, "est_s": round(est, 1) if est else None}), 202


    @bp.route("/cleanup/<job_id>")
    def cleanup_status(job_id):
        """Poll a Clean up run. `refs` is the list of new Speech-tab clips once it lands."""
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if job is None or job.kind != "cleanup":
            abort(404)
        events = list(job.events)
        line = next((e.get("line") for e in reversed(events) if e.get("type") == "log"), "")
        return jsonify({"status": job.status, "error": job.error,
                        "refs": getattr(job, "cleanup_refs", []), "line": line})


    @bp.route("/cleanup/<job_id>/cancel", methods=["POST"])
    def cleanup_cancel(job_id):
        """Stop a Clean up mid-flight. Outputs land atomically per take, so a cancel leaves
        whatever takes already finished and never a half-written clip."""
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if job is None or job.kind != "cleanup":
            abort(404)
        job.cancel.set()
        return jsonify({"ok": True})


    def _prune_cleanup_previews(keep_s: float = 3600.0) -> None:
        """Drop preview snippets older than an hour so the A/B scratch dir can't grow forever."""
        root = cleanup_preview_dir()
        if not root.exists():
            return
        cutoff = time.time() - keep_s
        for f in root.iterdir():
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink(missing_ok=True)
            except OSError:
                pass


    @bp.route("/cleanup/preview", methods=["POST"])
    def cleanup_preview():
        """Denoise a short snippet for an in-workspace A/B, committing nothing. Body:
        {ref, denoise:{wet,atten}, start_s, seconds}. Returns two opaque token URLs."""
        cfg = configs.cleanup_cfg()
        if not cfg.denoise_available:
            return jsonify({"error": cfg.denoise_unavailable_reason}), 400
        data = request.get_json(silent=True) or {}
        src = speech_sources.source_path(configs.speech_cfg(), str(data.get("ref", "")))
        if src is None:
            abort(404)
        den = cleanup.normalize_passes(
            {"denoise": {**(data.get("denoise") or {}), "enabled": True}})["denoise"]
        try:
            start_s = max(0.0, float(data.get("start_s") or 0))
            seconds = min(30.0, max(3.0, float(data.get("seconds") or 20)))
        except (TypeError, ValueError):
            start_s, seconds = 0.0, 20.0
        _prune_cleanup_previews()
        pdir = cleanup_preview_dir()
        pdir.mkdir(parents=True, exist_ok=True)        # the scratch: a plain mkdir is correct
        token = uuid.uuid4().hex[:12]
        orig = pdir / f"{token}.orig.wav"
        cleaned = pdir / f"{token}.cleaned.wav"
        # ffmpeg is a child with no DEK, and `src` is a training clip in the routed tree (§4.7).
        # Both OUTPUTS are scratch-side now, so only the input needs the seam.
        with vault_fs.child_input(src, configs.scratch_root()) as plain_src:
            r = subprocess.run(["ffmpeg", "-y", "-ss", f"{start_s:.2f}", "-t", f"{seconds:.2f}",
                                "-i", str(plain_src), "-ac", "1", str(orig), "-loglevel", "error"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0 or not orig.is_file():
            return jsonify({"error": "could not cut a preview snippet"}), 500
        rc = cleanup.run_denoise(cfg, orig, cleaned, wet=den["wet"], atten=den["atten"])
        if rc != 0 or not cleaned.is_file():
            return jsonify({"error": "the denoiser failed on the snippet"}), 500
        return jsonify({"orig": f"/cleanup/preview/{token}.orig.wav",
                        "cleaned": f"/cleanup/preview/{token}.cleaned.wav",
                        "seconds": round(seconds, 1)})


    @bp.route("/cleanup/preview/<name>")
    def cleanup_preview_audio(name):
        """Serve a preview snippet by its opaque token — leaf-only, .wav only, no traversal."""
        if not re.fullmatch(r"[0-9a-f]{12}\.(orig|cleaned)\.wav", name or ""):
            abort(404)
        p = cleanup_preview_dir() / name
        if not p.is_file():
            abort(404)
        # 8.6.5 — through the shared sender, which CAPS the range. This is scratch and
        # never routed, so it used to take a plain `send_file` and Werkzeug answered
        # `bytes=0-` with the whole file — a full-length song WAV holding one of the
        # browser's six sockets for its entire length. `send_store_file` caps the
        # unrouted branch too, so "never routed" is no longer a reason to opt out.
        return send_store_file(p, mimetype="audio/wav")

    return bp
