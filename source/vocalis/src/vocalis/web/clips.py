"""The Clips tab provides one library view for scene clips, Playground clips, and uploads. It combines existing stores rather than introducing another audio store; routes here own the user-facing operations and delegate storage rules to the runtime."""
from pathlib import Path

from flask import Blueprint, Response, abort, jsonify, request

import clip_favorites
import clip_join
import clip_sources
import folders
import scene_edit
import scene_enhance
import scene_enhance_queue
import scenes
import vault_fs
import zip_stream
from book_to_audio import OUTPUT_DIR
from store_serve import send_store_file
from vocalis.runtime import paths

# The longest a favorite's `ref` may be. A scene ref is `<slug>_<h8>` and the Playground and
# upload refs are comparably short, so this is far past anything real — it is the per-ENTRY
# bound that `clip_favorites.MAX_FAVORITES` (a bound on the COUNT) does not provide.
MAX_REF_LEN = 256


def create_clips_blueprint(vt_cfg=None):
    """`vt_cfg` is a CALLABLE (`configs.vt_cfg`), not a config.

    It resolves app settings, which change under a running server — Settings ▸ writes them —
    and the blueprint is built once at import. Passing the resolved object would pin whatever
    the training directory was at boot. None means "this install has no upload store wired",
    and the Clips tab simply shows the other two kinds (§7 degrades a kind at a time).
    """
    bp = Blueprint("vocalis_clips", __name__)

    def _root():
        # Resolved per request, not captured: OUTPUT_DIR is monkeypatched by tests and the
        # blueprint is built once at import.
        return scenes.scenes_root(OUTPUT_DIR)

    def _vt():
        if vt_cfg is None:
            return None
        try:
            return vt_cfg()
        except Exception:                    # noqa: BLE001 — an unconfigured store is not an outage
            return None

    @bp.route("/clips/scenes")
    def clips_scenes_list():
        """Every scene, newest first — the Clips tab's list.

        ⚠️ No `entries`. That field is the transcript (§5.1) and this is the route the tab calls
        on every open; the chapter list is fetched for one scene at a time, below."""
        return jsonify(scenes.list_scenes(_root()))

    @bp.route("/clips/items")
    def clips_items():
        """6.0-m2 §7 — scenes, Playground clips and uploads in ONE list, newest first.

        `?kinds=scene,playground` filters at the source rather than in the client: two of the
        three listings measure bandwidth and duration on anything they have not seen, and this
        route runs on every open of the tab.

        ⚠️ It does NOT replace `/clips/scenes`. That route is the scene store's own listing and
        carries scene-shaped fields (`gap_s`, `n_entries`, `raw_ref`) the m1 table renders; this
        one is the flattened catalog. Two callers, two shapes, and collapsing them would mean
        the scene rows losing columns to accommodate uploads.
        """
        raw = (request.args.get("kinds") or "").strip()
        kinds = [k for k in raw.split(",") if k in clip_sources.KINDS] if raw else None
        rows = clip_sources.list_items(OUTPUT_DIR, _vt(), kinds=kinds)
        # 6.2 — the star. Stamped here rather than carried by the three listings, because a
        # favorite is a property of the ROW and not of any of the three stores; see
        # `clip_favorites`'s docstring for why it is one file and not three sidecars.
        return jsonify(clip_favorites.for_rows(paths.CLIP_FAVORITES.parent, rows))

    @bp.route("/clips/favorite", methods=["POST"])
    def clips_favorite():
        """Star or un-star one row. Body: {kind, ref} → {favorite: bool}.

        A toggle rather than a PUT of the whole set: the client sends the row it clicked, so two
        tabs open on the tab cannot overwrite each other's stars with a stale list.
        """
        data = request.get_json(silent=True) or {}
        kind, ref = str(data.get("kind") or ""), str(data.get("ref") or "")
        if kind not in clip_sources.KINDS or not ref:
            return jsonify({"error": "a favorite needs a known `kind` and a `ref`"}), 400
        # 🔴 `MAX_FAVORITES` caps how MANY entries there are, not how big one is — so the
        # docstring's claim that it stops a stuck client filling the vault file was not true:
        # JSON bodies are allowed up to 128 MB, and one POST with a multi-megabyte ref wrote a
        # multi-megabyte entry that `for_rows` then decrypts on every open of the Clips tab.
        # `ui_state` caps value length for exactly this reason; the store modeled on it dropped
        # that half. A scene ref is `<slug>_<h8>` and the other two are comparably short.
        if len(ref) > MAX_REF_LEN:
            return jsonify({"error": f"a ref is at most {MAX_REF_LEN} characters"}), 400
        try:
            on = clip_favorites.toggle(paths.CLIP_FAVORITES.parent, kind, ref)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"kind": kind, "ref": ref, "favorite": on})

    @bp.route("/clips/join", methods=["POST"])
    def clips_join():
        """§7's one verb. Body: {title, gap_s?, items: [{kind, ref, name?}, …]} -> 202 {job_id}.

        The item ORDER is the payload's order — "default order is the order ticked, arrows fix
        the rest" makes ordering entirely the client's business, so this must not re-sort.
        """
        data = request.get_json(force=True, silent=True) or {}
        items = data.get("items")
        if not isinstance(items, list) or not items:
            return jsonify({"error": "'items' must be a non-empty ordered list"}), 400
        if len(items) > clip_join.MAX_JOIN_ITEMS:
            return jsonify({"error": f"a join is capped at {clip_join.MAX_JOIN_ITEMS} clips"}), 400
        bad = [it for it in items
               if not isinstance(it, dict) or it.get("kind") not in clip_sources.KINDS
               or not str(it.get("ref") or "")]
        if bad:
            return jsonify({"error": "every item needs a known `kind` and a `ref`"}), 400
        title = str(data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "a joined scene needs a name"}), 400

        # 🔴 The busy check is INSIDE `start()`, under the jobs lock, and not repeated here.
        # It used to be a `running()` call on this line — a test whose answer could go stale
        # before the next statement acted on it, so two near-simultaneous POSTs both started.
        # One guard, held across the test and the claim.
        try:
            job = clip_join.start(title, items, gap_s=data.get("gap_s"),
                                  output_dir=OUTPUT_DIR, vt_cfg=_vt())
        except clip_join.JoinBusy as busy:
            return jsonify({"error": {"message": "a join is already running",
                                      "job_id": busy.job.id}}), 409
        return jsonify(job.as_dict()), 202

    @bp.route("/clips/join/<job_id>")
    def clips_join_status(job_id):
        job = clip_join.JOBS.get(job_id)
        if job is None:
            abort(404)
        return jsonify(job.as_dict())

    @bp.route("/clips/join/<job_id>/cancel", methods=["POST"])
    def clips_join_cancel(job_id):
        job = clip_join.JOBS.get(job_id)
        if job is None:
            abort(404)
        job.cancel.set()
        return jsonify({"ok": True, "job_id": job_id})

    @bp.route("/clips/scenes/<ref>/manifest")
    def clips_scene_manifest(ref):
        """One scene's chapter list: `{mesid, character, offset_s, duration_s, text}` per entry.

        Those offsets are most of what makes a 46-minute scene usable — click a line, jump to
        that message inside the audio — and they fall out of the build for free (§5).

        This is the ONE route that ships conversation text, deliberately and on demand. It is
        also why the list route does not."""
        mp3, y = scenes.scene_paths(_root(), ref)
        if mp3 is None or not vault_fs.exists(mp3):
            abort(404)
        meta = scenes.read_manifest(y) or {}
        return jsonify({"ref": ref, "title": meta.get("title", ""),
                        "created": meta.get("created"), "gap_s": meta.get("gap_s"),
                        "enhanced": bool(meta.get("enhanced")),
                        "raw_ref": meta.get("raw_ref"),
                        "total_duration_s": meta.get("total_duration_s"),
                        "entries": meta.get("entries") or [],
                        "skipped": meta.get("skipped") or []})

    # ── 6.1-m1a — editing a scene ────────────────────────────────────────────────────────
    #
    # ⚠️ These two sit under `/clips/scenes/edit/…` while the verb is `/clips/scenes/<ref>/edit`,
    # which is the shape §7 specifies. They cannot collide: a scene ref is `<slug>_<h8>` and the
    # verb's last segment is the literal "edit", so no URL matches both — and Werkzeug prefers
    # the static segment anyway.
    @bp.route("/clips/scenes/edit/<job_id>")
    def clips_scene_edit_status(job_id):
        job = scene_edit.JOBS.get(job_id)
        if job is None:
            abort(404)
        return jsonify(job.as_dict())

    @bp.route("/clips/scenes/edit/<job_id>/cancel", methods=["POST"])
    def clips_scene_edit_cancel(job_id):
        job = scene_edit.JOBS.get(job_id)
        if job is None:
            abort(404)
        job.cancel.set()
        return jsonify({"ok": True, "job_id": job_id})

    @bp.route("/clips/scenes/<ref>/edit", methods=["POST"])
    def clips_scene_edit(ref):
        """§7's edit verb. Body: {title, gap_s?, ops:[{op, index, kind, ref, text?}, …]}.

        The ops are validated HERE, synchronously, against the source manifest — a bad index or
        an unknown kind comes back as a readable 400, rather than as a job that fails on a
        thread nobody is watching.
        """
        mp3, y = scenes.scene_paths(_root(), ref)
        if mp3 is None or not vault_fs.exists(mp3):
            abort(404)
        meta = scenes.read_manifest(y) or {}
        entries = meta.get("entries") or []

        # 🔴 §6 — edit the RAW scene, never an enhanced twin. A Playground replacement has not
        # been through the enhancer, so splicing it into a 256 kbps enhanced file drops an
        # unenhanced line into the middle of an enhanced one: audible, and a profile mismatch
        # besides. The UI steers the user to the raw twin; the server must not quietly do the wrong
        # thing if something else asks.
        if meta.get("enhanced"):
            return jsonify({"error": {
                "message": "that is the enhanced take — edit the raw scene and enhance the result",
                "raw_ref": meta.get("raw_ref")}}), 400

        data = request.get_json(force=True, silent=True) or {}
        title = str(data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "the edited scene needs a name"}), 400
        try:
            ops = scene_edit.normalize_ops(data.get("ops"), len(entries))
        except scene_edit.EditError as exc:
            return jsonify({"error": str(exc)}), 400
        # ⚠️ `is None` alone is not enough: `resolve` returns None only for a MALFORMED or
        # traversal ref, and hands back a perfectly good path for a clip that was deleted five
        # minutes ago. Both have to fail here — finding out after the 202 means a job the user watches
        # fail, for a reason that was knowable before it started.
        def _missing(o):
            p = clip_sources.resolve(OUTPUT_DIR, _vt(), o["kind"], o["ref"])
            return p is None or not vault_fs.exists(p)

        bad = [o for o in ops if _missing(o)]
        if bad:
            return jsonify({"error": f"{bad[0]['kind']} clip {bad[0]['ref']!r} is not there"}), 400

        # The busy check is INSIDE `start()`, under the jobs lock, and deliberately not repeated
        # here — see `clip_join`'s route for what happened when it was two steps.
        try:
            job = scene_edit.start(ref, title, ops, entries=entries, src_meta=meta,
                                   gap_s=data.get("gap_s", meta.get("gap_s")),
                                   output_dir=OUTPUT_DIR, vt_cfg=_vt())
        except scene_edit.EditBusy as busy:
            return jsonify({"error": {"message": "an edit is already running",
                                      "job_id": busy.job.id}}), 409
        return jsonify(job.as_dict()), 202

    # ── 11.2.7 — the enhancement QUEUE, on the server ────────────────────────────────────
    #
    # The enhancement ran on the server, but its waiting list and start loop lived in the browser tab;
    # the waiting list and the loop that started the next one lived in the browser tab. Both are
    # `scene_enhance_queue` now, and the tab only shows the list and sends changes to it.
    # `_start_enhance` is defined below; the lambda looks it up at call time.
    def _enhance_cards():
        from vocalis.runtime import enhancement
        return len(enhancement.enhance_cards())

    # The path is a CALLABLE, resolved on every use — this blueprint is built once, at import.
    queue = scene_enhance_queue.EnhanceQueue(
        lambda: paths.SCENE_ENHANCE_QUEUE, lambda ref: _start_enhance(ref), cards=_enhance_cards)
    scene_enhance_queue.CURRENT = queue
    bp.enhance_queue = queue            # reachable from tests without a module global

    # ── 6.3 — enhancing a scene, from its row ────────────────────────────────────────────
    #
    # ⚠️ The URL-collision note above applies verbatim: `/clips/scenes/enhance/<job_id>` and
    # `/clips/scenes/<ref>/enhance` cannot collide, because a scene ref is `<slug>_<h8>` and the
    # static segment wins in Werkzeug.
    @bp.route("/clips/scenes/enhance")
    def clips_scene_enhance_active():
        """Return active enhancement jobs and the server-owned queue. Keeping job state server-side lets a reloaded page or another tab recover progress and reach the cancel action."""
        with scene_enhance.JOBS_LOCK:
            jobs = [j for j in scene_enhance.JOBS.values() if j.status in scene_enhance.ACTIVE]
        # 11.2.7 — and the server-side queue beside them, so ONE poll tells the tab everything:
        # what is running, what is waiting, why the head has not started, and what was refused.
        return jsonify({"jobs": [j.as_dict() for j in jobs], "queue": queue.snapshot()})

    @bp.route("/clips/scenes/enhance/<job_id>")
    def clips_scene_enhance_status(job_id):
        job = scene_enhance.JOBS.get(job_id)
        if job is None:
            abort(404)
        return jsonify(job.as_dict())

    @bp.route("/clips/scenes/enhance/<job_id>/cancel", methods=["POST"])
    def clips_scene_enhance_cancel(job_id):
        job = scene_enhance.JOBS.get(job_id)
        if job is None:
            abort(404)
        job.cancel.set()
        return jsonify({"ok": True, "job_id": job_id})

    def _start_enhance(ref, nfe_raw=None):
        """Start scene enhancement and return `(body, code)`. The route and server-side queue share this function so both claim a card, measure duration, and deduplicate the same way. Return 404 for a missing scene so the queue can handle the result. Claim the card before starting the worker and release it if startup fails or the worker exits."""
        from vocalis.runtime import gpu
        from vocalis.runtime.gpu import GPUS
        from vocalis.runtime import enhancement

        import enhance

        if not enhancement.enhance_available():
            # Two different problems with two different fixes — "no venv" and "no card ticked" —
            # and `enhance_unavailable_reason` is what tells them apart. Do not collapse it.
            return {"error": enhancement.enhance_unavailable_reason()}, 400
        mp3, y = scenes.scene_paths(_root(), ref)
        if mp3 is None or not vault_fs.exists(mp3):      # ROUTED — output/ is a vault tree
            return {"error": "that scene is no longer there"}, 404
        meta = scenes.read_manifest(y) or {}
        # Use measured bandwidth rather than `meta["enhanced"]`: bookkeeping can remain set after
        # an interrupted run, while `enhance.is_band_limited(hz)` checks the audio on disk. Return
        # the measured bandwidth for a full-band scene so the caller can distinguish it from an
        # interrupted enhancement. Repeating the same `nfe` uses the raw scene's `created` and
        # `nonce` in `scenes.scene_hash`, so atomic output replaces the existing twin. The raw scene
        # is a separate stem and is not written by this path; a different `nfe` produces a new twin.
        # A FAST PATH ONLY — the authoritative test is inside `scene_enhance.start()`, under the
        # same lock that registers the job. This one answers the common case without paying for
        # the bandwidth probe below; it cannot be the guard, because its answer goes stale while
        # that probe runs. See `scene_enhance.start`'s red comment.
        busy = scene_enhance.running_for(ref)
        if busy is not None:
            return {"error": {"message": "this scene is already being enhanced",
                              "job_id": busy.id}}, 409

        # Measure before spending, with the THREE-way answer the Playground route uses: unknown,
        # full-band and band-limited are three different things to say and only one is "go".
        hz, _fresh = enhance.bandwidth_of(mp3, meta)
        if not hz:
            return {"error": "couldn't measure this scene — so there is no way to know "
                             "whether enhancing it would add anything, and nothing was "
                             "spent finding out."}, 409
        if not enhance.is_band_limited(hz):
            return {"error": "already full quality", "bandwidth_hz": hz}, 409

        nfe = enhance.validate_nfe(nfe_raw)
        # 🔴 11.2.7 — THE ESTIMATE IS WORKED OUT BEFORE THE CARD IS CLAIMED, NOT AFTER. It reads the
        # rate file (through the vault) and the manifest's duration, and either can raise. Between
        # `claim_card` and the `try` below, a raise LEAKED the card: one per press before, and one
        # every 30 s once the server-side queue began retrying a start that raised — until no card
        # was left for anything. Nothing about the estimate needs the card.
        est = enhance.estimate_seconds(meta.get("total_duration_s") or 0, nfe)
        # 🔴 §2.3's FIX. ONE card, claimed HERE, in the request — not on the thread. The scene
        # enhancer was the only enhancement in the codebase that never claimed one, so while a
        # scene enhanced, `GPUS.acquire()` saw an idle box and granted a Books or Playground
        # render every card, including the one holding the enhancer's model allocation. On a
        # constrained GPU this can cause out-of-memory failures or thrashing if left uncoordinated.
        device, why = GPUS.claim_card(gpu.cards_emptiest_first(enhancement.enhance_cards()),
                                      )
        if device is None:
            # Keep the machine-readable busy code separate from the user-facing sentence. Queue
            # handling retries these transient capacity refusals; terminal errors are not retried.
            return {"error": enhancement.ENHANCE_BUSY[why], "busy": why}, 409
        try:
            job = scene_enhance.start(ref, title=meta.get("title") or "", nfe=nfe, device=device,
                                      output_dir=OUTPUT_DIR, est_s=est or None)
        except scene_enhance.EnhanceBusy as exc:
            # The authoritative refusal: another request registered for this same scene while we
            # were measuring. Its card goes back — it never started anything.
            GPUS.release_card(device)
            return {"error": {"message": "this scene is already being enhanced",
                              "job_id": exc.job.id}}, 409
        except BaseException:              # no thread ⇒ no `finally` ⇒ the card is lost for the
            GPUS.release_card(device)      # life of the process. playground.py learned this one.
            raise
        # null where this box has never been timed — the client must not turn that into a 0.
        return {"job_id": job.id, "device": device,
                "est_s": round(est, 1) if est else None}, 202

    @bp.route("/clips/scenes/<ref>/enhance", methods=["POST"])
    def clips_scene_enhance(ref):
        """Start one enhancement now. Body: {nfe?}. See `_start_enhance`; the Clips tab itself
        goes through the queue (`/clips/scenes/enhance/queue`), and this stays for any caller that
        wants a direct start."""
        body, code = _start_enhance(ref, (request.get_json(silent=True) or {}).get("nfe"))
        if code == 404:
            abort(404)
        return jsonify(body), code

    @bp.route("/clips/scenes/enhance/queue", methods=["POST"])
    def clips_scene_enhance_queue():
        """Change the server-side queue (11.2.7) → its new state. Body is ONE of:
        {add:[ref,…]} · {remove:ref} · {clear:true} · {move:ref, before:ref|null} · {stop:true}.

        ⚠️ `add` refuses what is not a scene of ours (a malformed or traversal ref, a Playground
        clip, a deleted scene) here, synchronously, rather than queueing something that can only
        fail later on a thread nobody is watching.
        """
        data = request.get_json(silent=True) or {}
        canceled = 0
        if isinstance(data.get("add"), list):
            ok = []
            for r in data["add"][:scene_enhance_queue.MAX_QUEUE]:
                mp3, _y = scenes.scene_paths(_root(), str(r))
                if mp3 is not None and vault_fs.exists(mp3):
                    ok.append(str(r))
            if not ok:
                return jsonify({"error": "none of those are scenes that can be enhanced"}), 400
            queue.add(ok)
        elif isinstance(data.get("remove"), str):
            queue.remove(data["remove"])
        elif data.get("clear") is True:
            queue.clear()
        elif isinstance(data.get("move"), str):
            before = data.get("before")
            queue.move(data["move"], before if isinstance(before, str) else None)
        elif data.get("stop") is True:
            canceled = queue.stop_all()
        else:
            return jsonify({"error": "say what to do: add, remove, clear, move or stop"}), 400
        return jsonify({**queue.snapshot(), "canceled": canceled})

    @bp.route("/clips/scenes/<ref>/audio")
    def clips_scene_audio(ref):
        """Play or download one scene. `send_store_file` supports Range, which is what makes
        scrubbing through an hour of audio work in the browser."""
        mp3, _y = scenes.scene_paths(_root(), ref)
        if mp3 is None or not vault_fs.exists(mp3):
            abort(404)                   # ROUTED — see this module's docstring
        download = request.args.get("download") == "1"
        return send_store_file(mp3, as_attachment=download,
                               download_name=mp3.name if download else None)

    @bp.route("/clips/scenes/<ref>/rename", methods=["POST"])
    def clips_scene_rename(ref):
        """Rename a scene. Body: {name}. The H8 and the `_enhanced` marker are preserved — the
        marker is what §7.1's filter reads, so tidying a name must not merge two rows into one."""
        name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
        try:
            new_ref = scenes.rename_scene(_root(), ref, name)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if new_ref is None:
            abort(404)
        # 🔴 A RENAME MOVES THE REF, and the star is keyed on the whole ref. `scene_stem()` builds
        # it from the TITLE, so `rename_scene` hands back a new one for the same audio — and until
        # this line the favorite was left naming a row that no longer existed, which `for_rows`
        # then dropped in silence on the next listing. Shipped broken since 6.2.
        clip_favorites.rekey(paths.CLIP_FAVORITES.parent, clip_sources.SCENE, ref, new_ref)
        # 8.9 — and the FOLDER, on the same moving ref. Two small stores keyed the same way; a
        # rename must carry both or the scene drops out of its folder as silently as it used to
        # lose its star. `folders.RENAME_MOVES_REF` declares the hazard and
        # `tests/test_folders_rename_hooks.py` fails by name if this line goes missing.
        folders.rekey(paths.FOLDERS.parent, "scenes", ref, new_ref)
        return jsonify({"ok": True, "ref": new_ref})

    @bp.route("/clips/scenes", methods=["DELETE"])
    def clips_scenes_delete():
        """Single and multi-delete in one endpoint: {scenes: [ref, …]}.

        ⚠️ No cascade between a scene and its enhanced twin. §7.1's cleanup workflow is exactly
        "filter to not enhanced, select all, delete" — a cascade would take the enhanced ones
        with them, which is the opposite of what that filter is for."""
        body = request.get_json(silent=True) or {}
        deleted = scenes.delete_scenes(_root(), [str(r) for r in body.get("scenes") or []])
        return jsonify({"deleted": deleted})

    @bp.route("/clips/scenes/zip", methods=["POST"])
    def clips_scenes_zip():
        """⬇ Download selected — the whole selection as ONE archive.

        The body is the DELETE route's body, deliberately: "selected" has to mean the same set
        to both buttons. A ref that vanished between the page rendering and the click is
        SKIPPED rather than failing the download.

        It also accepts `scenes` form-encoded, and that is how the page sends it: a form submit
        is a NATIVE browser download, so the bytes go from here to disk without either side
        holding the archive. `fetch()` + a blob would buffer the whole selection in the tab, and
        a selection of scenes is measured in hours."""
        if request.is_json:
            refs = [str(r) for r in (request.get_json(silent=True) or {}).get("scenes") or []]
        else:
            refs = request.form.getlist("scenes")
        if not refs:
            return jsonify({"error": "nothing selected"}), 400

        root, used, items = _root(), set(), []
        for ref in refs:
            mp3, _y = scenes.scene_paths(root, ref)
            if mp3 is None or not vault_fs.exists(mp3):
                continue
            st = vault_fs.stat(mp3)
            items.append((zip_stream.unique_name(mp3.name, used), st.mtime if st else 0,
                          lambda p=mp3: vault_fs.open_read(p)))
        if not items:
            abort(404)                   # everything named is gone; an empty zip would lie

        n = len(items)
        return Response(zip_stream.stream(items), mimetype="application/zip", headers={
            "Content-Disposition": 'attachment; filename="{}"'.format(
                "vocalis-scene.zip" if n == 1 else f"vocalis-scenes-{n}.zip"),
            "Cache-Control": "no-store",
        })

    return bp
