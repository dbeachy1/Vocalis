"""Owns `/productions/*` routes and delegates persistence and derivation to `vocalis.runtime.production`. All store access is vault-routed. A locked vault returns 423; corrupt data returns 409 so the UI can report it without overwriting the file."""
from __future__ import annotations

from flask import Blueprint, Response, jsonify, request
from loguru import logger

import vault_fs

import threading

import voiceswap

from vocalis.runtime import acelib, comfyui, configs, peaks, production, shotrender
from vocalis.runtime.shotrender import RenderNotAvailable


def create_productions_blueprint() -> Blueprint:
    bp = Blueprint("vocalis_productions", __name__)

    def _guard(fn):
        def inner(*a, **kw):
            try:
                return fn(*a, **kw)
            except production.ProductionStoreCorrupt as exc:
                # 409, not 500: "your file is there and I will not write on top of it" is a state
                # the operator can address and must be told about, not a server fault.
                logger.error(f"productions: {exc}")
                return jsonify({"error": str(exc), "corrupt": True}), 409
            except vault_fs.locked_exc():
                return jsonify({"error": "the vault is locked"}), 423
        inner.__name__ = fn.__name__
        return inner

    def _master_id(p):
        """The master's identity right now, or "" if it cannot be read."""
        src = production.master_path(p.master_ref)
        st = vault_fs.stat(src) if src is not None else None
        return production.master_identity(st.size, st.mtime) if st else ""

    @bp.get("/productions")
    @_guard
    def list_productions():
        return jsonify({"productions": [p.as_dict() for p in production.list_productions()]})

    @bp.post("/productions")
    @_guard
    def create_production():
        """Create a production from a Library row, not an upload. Validate `master_ref` against the library before storing it; supported references are `acelib/<id>` and `swaplib/<ref>`. The legacy `song_id` field still maps to an ACE-Step library reference."""
        body = request.get_json(silent=True) or {}
        ref = str(body.get("master_ref") or "")
        if not ref and body.get("song_id"):
            ref = f"acelib/{body.get('song_id')}"

        # The default name comes from the row, so it names WHICH audio: a swap is `song → voice`,
        # which is also how the picker labels it.
        if ref.startswith("swaplib/"):
            swap_ref = ref[len("swaplib/"):]
            row = next((r for r in voiceswap.list_swaps(configs.vs_cfg().library_dir)
                        if r["ref"] == swap_ref), None)
            if row is None:
                return jsonify({"error": "no such swap in the library"}), 404
            name = f"{row['song']} → {row['voice']}" if row.get("voice") else str(row.get("song") or "")
        else:
            song_id = ref[len("acelib/"):] if ref.startswith("acelib/") else ""
            song = next((s for s in acelib.list_songs() if s.id == song_id), None)
            if song is None:
                return jsonify({"error": "no such song in the library"}), 404
            name = song.name

        src = production.master_path(ref)
        st = vault_fs.stat(src) if src is not None else None
        if st is None:
            return jsonify({"error": "that song's audio is missing"}), 404

        p = production.create(
            name=str(body.get("name") or name or "untitled"),
            master_ref=ref,
            master_id=production.master_identity(st.size, st.mtime),
            subject_id=str(body.get("subject_id") or ""),
        )
        return jsonify(p.as_dict())

    @bp.get("/productions/<production_id>")
    @_guard
    def get_production(production_id):
        p = production.get(production_id)
        if p is None:
            return jsonify({"error": "no such production"}), 404
        # 🔴 RECONCILED ON READ. §8b step 1: a re-timed vocal invalidates every shot, and the one
        # moment that must be true is when somebody opens the screen and sees the statuses.
        report = production.reconcile_master(production_id, _master_id(p))
        p = production.get(production_id)
        return jsonify(p.as_dict() | {"master": report})

    @bp.delete("/productions/<production_id>")
    @_guard
    def delete_production(production_id):
        return jsonify({"deleted": production.delete(production_id)})

    @bp.post("/productions/<production_id>/shots")
    @_guard
    def add_shot(production_id):
        body = request.get_json(silent=True) or {}
        try:
            s = production.add_shot(production_id, float(body.get("in_s") or 0.0),
                                    float(body.get("out_s") or 0.0))
        except (TypeError, ValueError):
            return jsonify({"error": "in_s and out_s must be numbers"}), 400
        return jsonify(s.as_dict())

    @bp.post("/productions/<production_id>/shots/<shot_id>")
    @_guard
    def update_shot(production_id, shot_id):
        body = request.get_json(silent=True) or {}
        # 📌 `length` is not in this list and never will be: it is derived from the timecodes.
        allowed = {k: v for k, v in body.items()
                   if k in ("in_s", "out_s", "still", "prompt", "status")}
        s = production.update_shot(production_id, shot_id, **allowed)
        if s is None:
            return jsonify({"error": "no such shot"}), 404
        return jsonify(s.as_dict())

    @bp.delete("/productions/<production_id>/shots/<shot_id>")
    @_guard
    def delete_shot(production_id, shot_id):
        return jsonify({"deleted": production.delete_shot(production_id, shot_id)})

    @bp.get("/productions/<production_id>/coverage")
    @_guard
    def coverage(production_id):
        p = production.get(production_id)
        if p is None:
            return jsonify({"error": "no such production"}), 404
        return jsonify(production.coverage(p, float(request.args.get("master_len_s") or 0.0)))

    @bp.get("/productions/<production_id>/peaks")
    @_guard
    def get_peaks(production_id):
        """The amplitude envelope for the timeline.

        🔴 **`ETag` IS THE KEY AND `Cache-Control` IS `no-cache`, NEVER A LONG `max-age`.**
        `wbedit_thumb` documents this trap in full and it applies here unchanged: "the key is the
        content" is true of the **ETag** and false of the **URL**. This URL is `/peaks` whatever
        the bucket count is, so a fresh-by-`max-age` browser cache goes on drawing the old
        envelope at the new width, with the server holding the right answer the whole time.

        `no-cache` does not mean "do not store": the browser keeps the bytes and revalidates, so a
        repeat load is a conditional request answered by a bodiless 304.

        ⚠️ **THE BUCKET COUNT IS CLAMPED BEFORE THE KEY IS TAKEN**, so the key always describes the
        shape actually rendered. `peaks.render` deliberately does not clamp — see its comment.
        """
        p = production.get(production_id)
        if p is None:
            return jsonify({"error": "no such production"}), 404

        buckets = peaks.clamp_buckets(request.args.get("buckets"))
        blob, key = production.envelope(p, buckets)

        # An empty key means there was nothing to cache (no master, no ffmpeg, a failed decode).
        # It degrades to a flat rule rather than an error: boundaries are numbers, not pixels.
        if not key:
            resp = Response(blob, mimetype="application/json")
            resp.headers["Cache-Control"] = "no-store"
            return resp

        etag = f'"{production_id}-p-{key}"'
        if request.headers.get("If-None-Match") == etag:
            resp = Response(status=304)
        else:
            resp = Response(blob, mimetype="application/json")
        resp.headers["ETag"] = etag
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @bp.post("/productions/<production_id>/shots/<shot_id>/slice")
    @_guard
    def cut_slice(production_id, shot_id):
        """Cut this shot's audio out of the master.

        ⚠️ A POST, not a GET, because it does work: it spawns ffmpeg and writes into the vault.
        A GET that costs a re-encode is one browser prefetch away from cutting twenty shots
        nobody asked for.
        """
        p = production.get(production_id)
        if p is None:
            return jsonify({"error": "no such production"}), 404
        ordered = sorted(p.shots, key=lambda s: s.in_s)
        idx = next((i for i, s in enumerate(ordered) if s.id == shot_id), None)
        if idx is None:
            return jsonify({"error": "no such shot"}), 404
        try:
            out = production.cut_slice(p, ordered[idx], idx)
        except production.SliceFailed as exc:
            # 422, not 500: a statement about THIS shot, not about the server. It must not read
            # as an outage in a log, and the rest of the shot list is fine.
            return jsonify({"error": str(exc)}), 422
        production.sweep_slices(p)
        return jsonify({"name": out.name, "length": ordered[idx].length})

    # ── 9.0-m9: the render queue ───────────────────────────────────────────────

    def _render_devices():
        """One entry per card, derived from configured backends rather than a fixed device list."""
        # 🔴 AUTHORIZED, NOT MERELY INSTALLED. This enumerated every installed unit, so a card
        # unticked in ⚙ Settings ▸ Devices went on receiving shot renders — while stems, swaps,
        # training, render and enhance all honored the same tick.
        #
        # ⚠️ **THE `cuda:0` FALLBACK STAYS, AND ONLY FOR "NO UNITS AT ALL".** I removed it
        # first, reasoning that dispatching to card 0 when every card is forbidden is the
        # opposite of the tick — which is true, and is why the forbidden case returns `[]`
        # below. But a box with no ComfyUI units installed is not a box whose cards were
        # forbidden, and this queue does not run on ComfyUI at all: its dispatcher is LongCat.
        # Collapsing the two left the queue with no device on any dev box, so no job could
        # ever reach a terminal state. `test_render_routes` caught it.
        if not comfyui.comfyui_instances():
            return ["cuda:0"]
        return [d for _s, _u, d in comfyui.authorized_instances()]

    def _render_dispatch(*, job, segment, prev_state):
        """The renderer is not implemented. Raise explicitly so the job records a clear failure;
        returning success without output would incorrectly mark the segment complete."""
        raise RenderNotAvailable(
            "LongCat is not installed on this host, so no segment can be rendered yet")

    def _render_worker(job):
        """One thread per shot. The queue is not a thread pool: `run_one` is synchronous and this
        is what makes it concurrent, so the queue stays testable without threads at all."""
        threading.Thread(target=_RENDER.run_one, args=(job,), daemon=True).start()

    # 🔴 `run_job` IS WHAT MAKES A COMPLETION PUMP REACH A WORKER. `pump_jobs` only MARKS a
    # job running and leases its card; the two route call sites below then hand each returned job
    # to `_render_worker`. The completion path called the counting wrapper `pump()` and threw the
    # list away, so on every finish the next shot was set to `running`, had its GPU leased, and
    # was dispatched by nobody. It could not self-heal: a later pump skips it because it is no
    # longer pending, and its card is no longer free. Injected rather than spawned inside the
    # queue so `test_shotrender` keeps driving it with no threads at all.
    def _render_progress(job):
        """Called after every segment, and after the last one — where the store learns what
        was built.

        🔴 `on_progress` EXISTED ON THE QUEUE AND NOTHING EVER PASSED IT, which is why
        `Shot.rendered_against` was never written by anything in `src/` and stale detection
        could not fire. The queue is deliberately ignorant of the production store — that is
        what keeps it testable without one — so the write-back belongs HERE, in the one place
        that can see both.

        ⚠️ ONLY ON A COMPLETE SHOT. A part-rendered shot has not been built against anything
        yet, and blessing it would make `reconcile_master` skip it on the next master change.
        """
        if job.done >= job.total and job.state != "canceled":
            production.mark_rendered(job.production_id, job.shot_id)

    _RENDER = shotrender.RenderQueue(
        dispatch=lambda **kw: _render_dispatch(**kw),
        devices=_render_devices,
        run_job=_render_worker,
        on_progress=_render_progress,
    )

    @bp.post("/productions/<production_id>/shots/<shot_id>/render")
    @_guard
    def render_shot(production_id, shot_id):
        p = production.get(production_id)
        if p is None:
            return jsonify({"error": "no such production"}), 404
        ordered = sorted(p.shots, key=lambda s: s.in_s)
        idx = next((i for i, s in enumerate(ordered) if s.id == shot_id), None)
        if idx is None:
            return jsonify({"error": "no such shot"}), 404
        try:
            job = _RENDER.submit(production_id, shot_id, idx, ordered[idx].length)
        except shotrender.RenderRefused as exc:
            return jsonify({"error": str(exc)}), 409
        for started in _RENDER.pump_jobs():
            _render_worker(started)
        return jsonify(job.as_dict())

    @bp.get("/productions/render")
    @_guard
    def render_status():
        """What the shot list polls. Pumping from the READ is what makes a stall self-heal —
        8.0-m22/m23 were all bugs of that family."""
        for started in _RENDER.pump_jobs():
            _render_worker(started)
        return jsonify(_RENDER.snapshot())

    @bp.post("/productions/render/stop")
    @_guard
    def render_stop():
        body = request.get_json(silent=True) or {}
        job_id = body.get("job_id")
        if job_id:
            return jsonify({"canceled": 1 if _RENDER.cancel(str(job_id)) else 0})
        return jsonify({"canceled": _RENDER.cancel_all()})

    return bp
