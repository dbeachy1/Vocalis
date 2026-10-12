"""HTTP routes for song separation, stem-set storage, and Speech imports."""
import io
import re
import shutil
import threading
import time
import zipfile

from flask import Blueprint, abort, jsonify, request, send_file

import folders
import stems
import stemsplit
import vault_fs
import song_library
from store_serve import send_store_file

from vocalis.runtime import configs
from vocalis.runtime import gpu
from vocalis.runtime import jobs
from vocalis.runtime import paths
from vocalis.runtime import pool as rt_pool
from vocalis.runtime import subsystems
from vocalis.runtime.params import as_bool as _b

#: What the SPLIT CONTROL offers. Deliberately NOT `stems.MODE_STEMS`, which since 8.4 also
#: holds the internal `vocals` harvest mode — that one is how the lead chain runs its stage 1,
#: not something the button offers, and a request naming it would quietly produce a baseless
#: set nobody asked for. Two tables, because they answer two different questions.
SPLIT_MODES = ("2stem", "4stem", "lead")


def create_stems_blueprint() -> Blueprint:
    """No injected state — every dependency is a module both sides import (see web/comfyui.py)."""
    bp = Blueprint("vocalis_stems", __name__)

    def _ss_job_or_404(job_id):
        job = stemsplit.get_job(job_id)
        if job is None:
            abort(404)
        return job

    @bp.route("/stems/start", methods=["POST"])
    def stems_start():
        """Split a song into the store. Body: {song, mode: '2stem'|'4stem'|'lead', device,
        dereverb, dereverb_model, params}.

        "Cached" means the stored set ALREADY HOLDS what this mode promises — so a
        4-stem request against a 2-stem set really runs, instead of falsely reporting the
        song as already split (a set is keyed on its song, not on the mode, and a 4-stem
        split EXTENDS it).

        🔴 **`lead` IS NEVER CACHED, AND THAT IS THE POINT** (8.4 §6 R3). Re-running it is how
        you redo a bad detection — with the reverb left in, or with different thresholds — and
        the design's answer to "the first one came back dull" is precisely "clear the box and
        press Split again". A cached short-circuit would make that unreachable from the UI. It
        is cheap to re-run: stage 1 is a store hit, so no Demucs runs, and the set's identity is
        the SONG's, so `lead_solo.wav` is overwritten in place rather than forking a set."""
        data = request.get_json(force=True) or {}
        cfg = configs.ss_cfg()
        src = song_library.resolve_song(configs.song_cfg(), str(data.get("song", "")))
        if src is None or src.kind != "song":
            return jsonify({"error": "pick a song first (unknown or missing song ref)"}), 400
        mode = str(data.get("mode") or "2stem")
        if mode not in SPLIT_MODES:
            return jsonify({"error": "mode must be '2stem', '4stem' or 'lead'"}), 400
        # 8.6.2 — how many are still queued behind this one, so a satellite holding a warm
        # separator knows whether to keep it. Clamped rather than validated: a nonsense value
        # can only make the worker live one song too long, and the idle reaper ends that.
        try:
            queue_remaining = max(0, min(999, int(data.get("queue_remaining") or 0)))
        except (TypeError, ValueError):
            queue_remaining = 0
        device = str(data.get("device") or "auto").strip().lower()
        if device == "auto":
            device = ""                  # resolved after `found` — see the note at the call
        elif device != "cpu" and not re.fullmatch(r"cuda:\d+", device):
            return jsonify({"error": "device must be 'auto', 'cpu', or 'cuda:N'"}), 400
        h = stems.song_id(cfg, src.path)         # the front door (M4) — memoized, same number
        if stemsplit.live_h(h):
            return jsonify({"error": "this song is already being split"}), 409
        try:
            found = stems.find_by_hash(cfg, h)
        except stems.StemsSidecarUnreadable:
            # A set already matching this song's hash whose sidecar will not parse. Splitting
            # would run Demucs and commit the result over that very folder. Say so; a 500 here
            # would be honest but useless.
            return jsonify({"error": "a stem set for this song exists but its sidecar can't be "
                                     "read, so splitting again would overwrite it. Nothing was "
                                     "changed — check the set in the Stems tab."}), 409
        if mode != "lead" and found is not None and stems.satisfies(found, mode):
            return jsonify({"cached": True, "ref": found.name})
        # 🔴 7.6 — THE TICKED CARDS, NOT EVERY CARD ON THE BOX. `gpu.pick_device()` used to
        # take no argument and enumerate every physical device, so a card unticked in
        # ⚙ Settings still got split on — chosen *because* it was empty, and empty precisely
        # because it had been excluded from everything else. `playground.py:223` records the
        # identical bug being found and fixed for the enhancer; this call site and
            # The source resolver and the job use the same song identity and Stems store.
        #
        # `auto_device` also refuses rather than silently dropping to the CPU when cards exist
        # but none is authorized — a Demucs split crawling on the CPU with nothing naming the
        # An explicit `device: "cpu"` remains valid; automatic selection refuses when no authorized GPU is available.
        # untouched: choosing it deliberately stays legitimate.
        #
        # 🔴 8.4 MOVED THIS DOWN HERE, AND THE REASON IS THE REFUSAL. A lead extraction on an
        # already-split song runs NO DEMUCS — stage 1 is a store hit — and everything after it
        # is CPU by construction (§4). Resolving `auto` before `found` meant that job was
        # refused for want of a card it was never going to use. This is the first line at which
        # the answer to "will Demucs actually run?" exists.
        if not device:
            if mode == "lead" and found is not None and stems.satisfies(found, "vocals"):
                device = "cpu"
            else:
                device, refusal = rt_pool.auto_device(subsystems.STEMS)
                if refusal:
                    return jsonify({"error": refusal}), 400
        job = stemsplit.new_job(source_ref=src.ref, song_name=src.name, mode=mode,
                                device=device, h=h, queue_remaining=queue_remaining,
                                # 8.4 — the lead knobs. Ignored by the other two modes, and both
                                # are re-checked downstream: `params_from` clamps every
                                # threshold and `dereverb_model` is an allowlist, because these
                                # reach a DSP that decides what lands in a training set and a
                                # subprocess argument respectively.
                                dereverb=_b(data, "dereverb", True),
                                dereverb_model=str(data.get("dereverb_model") or ""),
                                params=data.get("params")
                                if isinstance(data.get("params"), dict) else {})
        threading.Thread(target=stemsplit.run_split_job, args=(job, cfg), daemon=True).start()
        return jsonify({"job_id": job.id})

    @bp.route("/stems/upload", methods=["POST"])
    def stems_upload():
        """Bring your own pre-split stem set — the "I already have clean stems" path (§7).
        Multipart: `name`, plus one or more `file` parts named after the stem they hold
        (vocals / instrumental / drums / bass / other; Demucs's no_vocals is understood).

        Skips Demucs permanently for that material: the set is a first-class swap source,
        consumed exactly as one we made.

        🔴 Its endpoint name is `vocalis_stems.stems_upload` now that it lives on a blueprint,
        and `_UPLOAD_ENDPOINTS` in vocalis_server holds that qualified spelling. Get it wrong
        and this route silently keeps the 128 MB global body cap — which passes every small
        test and 413s only a real stem set. `test_upload_body_cap.py` asserts every name in
        that frozenset resolves to a live endpoint, which is what makes the mistake loud."""
        files = [(f.filename, f.stream) for f in request.files.getlist("file") if f.filename]
        if not files:
            return jsonify({"error": "no files uploaded (form field 'file')"}), 400
        try:
            row = stemsplit.save_upload(configs.ss_cfg(), request.form.get("name", ""), files)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(row)

    @bp.route("/stems/status/<job_id>")
    def stems_status(job_id):
        """Everything a reloading page needs to reattach to a live split."""
        job = _ss_job_or_404(job_id)
        return jsonify({"id": job.id, "status": job.status, "stage": job.stage,
                        "error": job.error, "song": job.source_ref,
                        "song_name": job.song_name,
                        "mode": job.mode, "device": job.device, "result": job.result_ref,
                        # 8.4 — so a reloading page restores the de-reverb tickbox to what the
                        # RUNNING job was actually given, not to the checkbox's default.
                        "dereverb": job.dereverb,
                        "started_at": job.started_at, "now": time.time(),
                        "canceling": job.cancel.is_set()
                                      and job.status in ("queued", "running")})

    @bp.route("/stems/events/<job_id>")
    def stems_events(job_id):
        return jobs.job_sse(_ss_job_or_404(job_id))

    @bp.route("/stems/cancel/<job_id>", methods=["POST"])
    def stems_cancel(job_id):
        job = _ss_job_or_404(job_id)
        first = not job.cancel.is_set()
        job.cancel.set()
        if first and job.status in ("queued", "running"):
            stemsplit.emit(job, {"type": "log", "line": "Cancel received — stopping the split…"})
        return jsonify({"ok": True, "status": job.status})

    @bp.route("/stems/jobs")
    def stems_jobs():
        """Live/recent split jobs — the reload-reattach entry point."""
        # `live`, not `jobs`: this module imports `vocalis.runtime.jobs` under that name, and
        # a local of the same name shadows it. Harmless here (this function doesn't use the
        # module) but it is the exact shape that produced `pool = pool.current_pool()` in
        # P3.4 — an UnboundLocalError in /speak that 36 tests caught only after the fact.
        with stemsplit.JOBS_LOCK:
            live = list(stemsplit.JOBS.values())
        return jsonify([{"id": j.id, "status": j.status, "stage": j.stage,
                         "song": j.song_name, "mode": j.mode} for j in live])

    @bp.route("/stems/library")
    def stems_library():
        """Every stem set, from BOTH stores — uploads/stems/ (yours) and output/stems/
        (ours), badged by provenance. `swaps` is how many finished tracks borrow each
        set's instrumental, which is what the delete warning needs."""
        cfg = configs.ss_cfg()
        rows = stems.list_sets(cfg)
        # 8.9 — stamp each set's virtual folder. Scope `stems_library`, keyed on `ref`.
        # 🔴 NOT the same scope as Voice Swap ▸ Sources, even though a brought-in set appears in
        # both. They are not the same DATASET: this route lists every separation — yours and the
        # ones Demucs made — as a SET you can play, zip or delete, while Sources shows only the
        # `source == "uploaded"` subset, as one of five kinds of SOURCE, under a ref the client
        # composes (`stems/<ref>`). Different rows, different identity, different act. §2's
        # "duplicate data shares a scope" rule is about two views of ONE listing; this is a
        # filtered subset re-keyed into a union, which is §14's case, not §2's.
        return jsonify(folders.for_rows(paths.FOLDERS.parent, "stems_library", rows))

    @bp.route("/stems/library/<ref>/<stem>/audio")
    def stems_audio(ref, stem):
        """One stem WAV (Range-capable; ?download=1 for a named attachment —
        prefixed with the set so four downloads don't all land as vocals.wav)."""
        p = stems.stem_file(configs.ss_cfg(), ref, stem)
        if p is None:
            abort(404)
        download = request.args.get("download") == "1"
        return send_store_file(p, as_attachment=download,
                               download_name=f"{ref}__{p.name}" if download else None)

    @bp.route("/stems/library/<ref>/lead_spans")
    def stems_lead_spans(ref):
        """The set's `lead_spans.json` — 8.4-m2, §9.4's QA affordance.

        It rides in ⬇ All already, but a zip is the wrong shape for the question this file
        answers, which is asked WHILE looking at a bad result: *"why did this song give me
        eleven seconds?"* One click from the coverage line, and the answer is the span list.

        Not a stem, so not `stem_file`: it is JSON beside the audio, and `find_stem` refuses
        names that are not stems on purpose."""
        d = stems.find_dir(configs.ss_cfg(), ref)
        if d is None:
            abort(404)
        p = d / stems.LEAD_SPANS
        if not vault_fs.exists(p):
            abort(404)                      # a set that has never been through the lead mode
        download = request.args.get("download") == "1"
        return send_store_file(p, as_attachment=download,
                               download_name=f"{ref}__{stems.LEAD_SPANS}" if download else None)

    @bp.route("/stems/library/<ref>/zip")
    def stems_zip(ref):
        """⬇ All — the whole set in one file. This is the actual reason you asked for a
        4-stem split: five separate clicks is not "give me the stems"."""
        cfg = configs.ss_cfg()
        d = stems.find_dir(cfg, ref)
        if d is None:
            abort(404)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:    # WAVs don't deflate
            # `stem_files` covers the derived lead too (8.4). Its spans sidecar rides along
            # because a lead vocal without the record of where it was cut from — and by which
            # detector, de-reverbed or not — is the one file here whose provenance a trainer
            # will want months later, and §4b's "never mix wet and dry in one dataset" is only
            # checkable if it travels with the audio.
            files = stems.stem_files(d)
            spans = d / stems.LEAD_SPANS
            if stems.has_lead(d) and vault_fs.exists(spans):
                files.append(spans)
            for p in files:
                # 🔴 ROUTE THE READ. `z.write(p, ...)` opens the path with the OS, and after M6
                # that path does not exist — the stem's real filename is SIV-encrypted. So this
                # 500'd on every encrypted install while working perfectly on a plaintext one,
                # which is exactly how it survived the sweep: the bug is invisible until a vault
                # exists. Same door as send_store_file's Werkzeug warning, one floor down.
                # STREAMED, not read_bytes()'d — a 4-stem set of a real song is hundreds of MB
                # and the zip is already being held in RAM.
                st = vault_fs.stat(p)
                info = zipfile.ZipInfo(
                    f"{ref}/{p.name}",
                    date_time=time.localtime(st.mtime if st else time.time())[:6])
                info.compress_type = zipfile.ZIP_STORED
                with vault_fs.open_read(p) as src, z.open(info, "w") as dst:
                    shutil.copyfileobj(src, dst)
        buf.seek(0)
        return send_file(buf, mimetype="application/zip", as_attachment=True,
                         download_name=f"{ref}_stems.zip")

    @bp.route("/stems/library", methods=["DELETE"])
    def stems_library_delete():
        """Delete stem sets. Body: {refs: []}.

        Degrades gracefully by construction (§5): a swap's finished MP3 and its dry vocal
        are its OWN files and are not touched. All that disappears is the borrowed
        instrumental — and a re-split restores it."""
        refs = (request.get_json(silent=True) or {}).get("refs") or []
        deleted = stems.delete_sets(configs.ss_cfg(), [str(r) for r in refs])
        return jsonify({"deleted": deleted})

    return bp
