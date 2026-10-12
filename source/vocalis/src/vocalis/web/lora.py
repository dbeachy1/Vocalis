"""Owns the `/lora/*` HTTP surface for subject management, curation, and generation. Store rules live in `vocalis.runtime.lorasubj`; handlers translate store failures into actionable responses. A locked vault returns 423, while corrupt data returns 409 without being overwritten."""
from __future__ import annotations

import contextlib
import threading

from flask import Blueprint, Response, jsonify, request
from loguru import logger

import vault_fs

from vocalis.runtime import (comfyui, flux2, gpu, loracands, loraface, loragen,
                             loraimport, loraprompts, lorapublish, loratest, loratrain,
                             lorasubj)


def create_lora_blueprint() -> Blueprint:
    bp = Blueprint("vocalis_lora", __name__)

    def _guard(fn):
        """Translate store failures into UI responses. Corrupt subject or template data returns 409 and is never silently replaced; a locked vault returns 423. Validation and missing-subject failures keep their specific client status codes."""
        def inner(*a, **kw):
            try:
                return fn(*a, **kw)
            except (lorasubj.SubjectStoreCorrupt, loraprompts.TemplateStoreCorrupt) as exc:
                logger.error(f"lora: subject store corrupt - {exc}")
                return jsonify({"error": str(exc), "corrupt": True}), 409
            except lorasubj.BuildRefused as exc:
                return jsonify({"error": str(exc)}), 400
            except KeyError as exc:
                return jsonify({"error": f"no such subject: {exc}"}), 404
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            except vault_fs.locked_exc():
                # 🔴 CAUGHT BY CLASS, NOT BY `except Exception` + isinstance. The first draft of
                # this used a blind catch plus a lint-ignore for it, which was both a new suppression
                # and unnecessary: `locked_exc()` EXISTS to be used exactly this way — its own
                # docstring says `except vault_fs.locked_exc():` — and it returns `()` when vault
                # is unimportable, so the pure-library tests keep raising normally.
                #
                # ⚠️ The difference is not cosmetic. A blind catch here would also swallow a real
                # telling the operator to unlock a vault when the actual failure is corrupt data.
                return jsonify({"error": "vault is locked", "locked": True}), 423
        inner.__name__ = fn.__name__
        return inner

    @bp.get("/lora/subjects")
    @_guard
    def lora_subjects():
        """The landing page's list. Counts come from the STORE, never from the client's tally.

        📌 Reconciles first, so "50 images" is true the moment a run finishes rather than only
        after someone opens Curate. On-demand route, not a polled one - `lora.js:43` fetches it
        when the screen is shown, so a glob per subject here costs nothing.
        """
        out = []
        for s in lorasubj.list_subjects():
            lorasubj.reconcile_images(s.id)
        for s in lorasubj.list_subjects():
            # 10.0-m3 — how many of the images were IMPORTED rather than generated.
            #
            # 🔴 A COUNT, NOT A FLAG, AND BUILDING m1 IS WHAT SETTLED THAT. Design §7.3 assumed
            # "an imported subject" is a kind of subject, and proposed hiding Face, Prompts and
            # Generate for one. It is not a kind of subject: `source` is a property of each IMAGE,
            # and a subject can hold both — importing ten reference photos into a set of forty
            # generated ones is the mixed case `test_a_mixed_set_captions_each_image_by_its_own_
            # source` exists for. Gating screens on it would have blocked the workflow this
            # release just built. So the provenance is SHOWN and nothing is hidden.
            imported = sum(1 for im in s.images
                           if im.source == lorasubj.SOURCE_IMPORTED)
            out.append({"id": s.id, "name": s.name, "face": s.face,
                        "images": len(s.images), "kept": len(s.kept()),
                        "imported": imported,
                        "runs": len(s.runs), "updated_at": s.updated_at})
        return jsonify({"subjects": out})

    @bp.post("/lora/subjects")
    @_guard
    def lora_create():
        name = (request.get_json(silent=True) or {}).get("name") or ""
        if not name.strip():
            return jsonify({"error": "a subject needs a trigger word"}), 400
        return jsonify(lorasubj.create(name).to_dict())

    @bp.get("/lora/subjects/<subject_id>")
    @_guard
    def lora_get(subject_id):
        """One subject, with any images that have landed on disk since it was last read.

        🔴 THIS IS WHAT CURATE LOADS, so the reconcile has to happen here or the grid renders
        empty over a full generation directory - see `lorasubj.reconcile_images`.
        """
        if lorasubj.get(subject_id) is not None:
            lorasubj.reconcile_images(subject_id)
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404
        # 🔴 `dataset` IS HOW MANY IMAGES THE BUILT DATASET HOLDS, READ FROM DISK. Train's own
        # header carried an element for it (`#loraTrainDataset`) that NOTHING in `src/` ever wrote,
        # so it read "—" for ever - on the one screen that refuses to start with an empty dataset
        # and answers 400 "this subject has no built dataset yet". The number the refusal is made
        # of was never shown to the person who has to act on it.
        # ⚠️ ON THE SINGLE-SUBJECT GET ONLY, NEVER ON THE LIST. `dataset_size` globs the routed
        # dataset directory; one glob when a subject is opened is nothing, and one per row on a
        # list of twenty subjects is a directory walk per paint.
        return jsonify(s.to_dict() | {"dataset": lorasubj.dataset_size(subject_id)})

    @bp.delete("/lora/subjects/<subject_id>")
    @_guard
    def lora_delete(subject_id):
        if not lorasubj.delete(subject_id):
            return jsonify({"error": "no such subject"}), 404
        return jsonify({"ok": True})

    @bp.post("/lora/subjects/<subject_id>/keep")
    @_guard
    def lora_keep(subject_id):
        """Curate's toggle. One shape for click, space and shift+click range — they differ only in
        how many ids the client sends, which is why there is no per-gesture route."""
        body = request.get_json(silent=True) or {}
        ids = body.get("ids")
        if not isinstance(ids, list) or not ids:
            return jsonify({"error": "ids must be a non-empty list"}), 400
        changed = lorasubj.set_keep(subject_id, ids, bool(body.get("keep", True)))
        s = lorasubj.get(subject_id)
        # 📌 The counter comes back from the store rather than being incremented client-side.
        # A UI that counts its own clicks drifts the moment one request fails.
        return jsonify({"changed": changed, "kept": len(s.kept()), "total": len(s.images)})

    @bp.post("/lora/subjects/<subject_id>/build")
    @_guard
    def lora_build(subject_id):
        """§4.5: Build reports what it wrote. The report is the response, not a log line."""
        return jsonify(lorasubj.build(subject_id))

    # ── 9.0-m2: prompts and the global template store ──────────────────────────

    @bp.get("/lora/templates")
    @_guard
    def lora_templates():
        """The picker. Seeded on first read, so it is never empty (requirements §4.3)."""
        return jsonify({"templates": [t.to_dict() for t in loraprompts.list_templates()]})

    @bp.post("/lora/templates")
    @_guard
    def lora_template_save():
        """Save, or Save as… — the same route, distinguished by whether an id is sent."""
        b = request.get_json(silent=True) or {}
        name = (b.get("name") or "").strip()
        if not name:
            return jsonify({"error": "a template needs a name"}), 400
        # 🔴 PARSED, NOT SPLIT. The client sends the textarea verbatim and the SERVER decides
        # what a prompt line is, so the file, the box and the store cannot disagree about
        # comments or blank lines - which is what keeps the CLI runner working on the same data.
        prompts = loraprompts.parse(b.get("text") or "") if "text" in b else (b.get("prompts") or [])
        return jsonify(loraprompts.save(name, prompts, b.get("identity") or "",
                                        b.get("id") or "").to_dict())

    @bp.delete("/lora/templates/<template_id>")
    @_guard
    def lora_template_delete(template_id):
        if not loraprompts.delete(template_id):
            return jsonify({"error": "no such template"}), 404
        return jsonify({"ok": True})

    @bp.get("/lora/templates/<template_id>/open")
    @_guard
    def lora_template_open(template_id):
        """Opening a template into a subject. Returns a COPY of its prompts (§4.3)."""
        out = loraprompts.apply_to(template_id)
        out["text"] = loraprompts.render(out["prompts"])
        return jsonify(out)

    @bp.get("/lora/subjects/<subject_id>/prompts.txt")
    @_guard
    def lora_prompts_download(subject_id):
        """Download — plain `.txt`, one prompt per line."""
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404
        # ⚠️ The identity block is NOT baked into the download. Same format in, out and on disk
        # (§4.3) - and a file whose lines already carried identity would double it on re-upload,
        # which renders fine and trains worse.
        return Response(loraprompts.render(s.prompts), mimetype="text/plain")

    @bp.post("/lora/subjects/<subject_id>/prompts")
    @_guard
    def lora_prompts_save(subject_id):
        """The screen's save: the identity block and the prompt set, together."""
        b = request.get_json(silent=True) or {}
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404
        s.prompts = loraprompts.parse(b.get("text") or "")
        s.identity = (b.get("identity") or "").strip()[:loraprompts.MAX_IDENTITY]
        lorasubj.save(s)
        # 📌 The COMPOSED set comes back so the screen shows what will actually be rendered,
        # rather than the user's lines plus a promise that identity gets prepended somewhere.
        return jsonify({"prompts": s.prompts, "identity": s.identity,
                        "composed": loraprompts.compose_all(s.identity, s.prompts),
                        "count": len(s.prompts)})

    # ── 9.0-m3: the seed face ──────────────────────────────────────────────────

    @bp.post("/lora/subjects/<subject_id>/face")
    @_guard
    def lora_face_put(subject_id):
        """Upload a seed face. The runtime crops it square, resizes it to 1024 pixels, and stores it. Invalid image input returns 400 with the reason."""
        if lorasubj.get(subject_id) is None:
            return jsonify({"error": "no such subject"}), 404
        f = request.files.get("file")
        if f is None:
            return jsonify({"error": "no file was uploaded"}), 400
        try:
            # ⚠️ `.read()` once, into memory. The renderer needs the whole thing anyway (Pillow
            # decodes from a buffer) and streaming it to disk first would mean a rejected upload
            # had already written somewhere.
            out = loraface.put(subject_id, f.read())
        except loraface.FaceRejected as exc:
            return jsonify({"error": str(exc)}), 400
        # 📌 `loraface.put()` records the face on the subject itself. This route used to do it
        # here, which meant the OTHER way in — choosing a generated candidate — stored the bytes
        # and left `subject.face` empty. One writer, in the place both paths pass through.
        return jsonify(out)

    @bp.get("/lora/subjects/<subject_id>/face.png")
    @_guard
    def lora_face_get(subject_id):
        """Serve the current seed face with `no-cache`. The URL remains stable when a face is replaced, so a long-lived browser cache could show an old image while generation uses the new one."""
        blob = loraface.get(subject_id)
        if blob is None:
            return jsonify({"error": "no face yet"}), 404
        resp = Response(blob, mimetype="image/png")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @bp.delete("/lora/subjects/<subject_id>/face")
    @_guard
    def lora_face_clear(subject_id):
        cleared = loraface.clear(subject_id)
        s = lorasubj.get(subject_id)
        if s is not None and s.face:
            s.face = ""
            lorasubj.save(s)
        return jsonify({"cleared": cleared})

    # ── 10.0-m1: importing a dataset you already have ──────────────────────────

    @bp.put("/lora/subjects/<subject_id>/identity")
    @_guard
    def lora_identity_save(subject_id):
        """Save the identity block ALONE.

        🔴 **SEPARATE FROM `/prompts` BECAUSE THAT ONE WRITES BOTH FIELDS.**
        `lora_prompts_save` does `s.prompts = parse(b.get("text") or "")`, so a screen that posted
        only an identity block to it would silently wipe the prompt set. That is harmless for an
        imported subject, which has no prompts — and it is exactly the kind of "harmless today"
        coupling that becomes data loss the first time someone imports extra images into a subject
        that was generated. One field, one writer.
        """
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404
        b = request.get_json(silent=True) or {}
        s.identity = (b.get("identity") or "").strip()[:loraprompts.MAX_IDENTITY]
        lorasubj.save(s)
        return jsonify({"identity": s.identity})

    @bp.post("/lora/subjects/<subject_id>/import")
    @_guard
    def lora_import(subject_id):
        """Import many images straight into the generation tree, then register them.

        🔴 **A REJECTED FILE IS PART OF A 200, NOT A 400.** Fifty files dragged from a folder will
        contain a `Thumbs.db` or a stray `.txt`, and failing the batch on one of them makes the
        feature unusable at the size it is designed for. `runtime/loraimport.put()` judges each
        file alone and the report names every refusal with its reason, so the screen can say "47
        imported, 3 refused" — the 400s below are for a request that was malformed as a whole.

        ⚠️ **`.read()` per file, into memory, deliberately.** Pillow decodes from a buffer anyway
        and `MAX_BYTES` bounds each one; streaming to disk first would mean a rejected file had
        already been written somewhere that nothing sweeps.
        """
        if lorasubj.get(subject_id) is None:
            return jsonify({"error": "no such subject"}), 404
        files = request.files.getlist("file")
        if not files:
            return jsonify({"error": "no files were uploaded"}), 400
        try:
            out = loraimport.put(subject_id, [(f.filename, f.read()) for f in files])
        except loraimport.ImportRejected as exc:
            return jsonify({"error": str(exc)}), 400
        logger.info(f"lora import: subject {subject_id} took {len(out['written'])} images, "
                    f"refused {len(out['rejected'])}")
        return jsonify(out)

    @bp.put("/lora/subjects/<subject_id>/images/<image_id>/caption")
    @_guard
    def lora_caption_save(subject_id, image_id):
        """One image's caption — the VARYING part, not the finished text (10.0-m2).

        📌 The composed result comes back so the screen can show what will actually be written,
        rather than the typed words plus a promise that the identity block gets prepended
        somewhere. Same reasoning as `/prompts` returning `composed`.
        """
        if lorasubj.get(subject_id) is None:
            return jsonify({"error": "no such subject"}), 404
        b = request.get_json(silent=True) or {}
        try:
            stored = lorasubj.set_caption(subject_id, image_id, b.get("caption") or "")
        except KeyError:
            return jsonify({"error": "no such image"}), 404
        # ⚠️ RE-READ AFTER THE WRITE. Composing from the subject fetched before `set_caption`
        # would report what the caption USED to be — the class of bug this file already guards
        # against by having every counter come from the store's own answer.
        fresh = lorasubj.get(subject_id)
        im = next((x for x in fresh.images if x.id == image_id), None)
        return jsonify({"caption": stored,
                        "composed": lorasubj.caption_for_dataset(fresh, im) if im else ""})

    # ── 9.0-m4: Generate ───────────────────────────────────────────────────────

    def _gen_backends():
        """`[(service, url, device)]` for the run, derived — never written down.

        🔴 **NO PORT LITERAL, EVER.** `comfyui_instances()` generates the (service, url) pairs
        from `instances: N` and defaults to 1, so a box with one ComfyUI is configured by saying
        nothing. Hardcoding `:8189`/`:8289` here would silently address nothing on
        a single-instance box, or on one whose ports were moved — and the failure is a run that
        dispatches into the void rather than an error.

        ⚠️ The device for instance *i* is `cuda:i`, which matches how the units are launched:
        `comfyui.service` -> card 0, `comfyui-gpu1.service` -> card 1 (the second hard-sets
        `HIP_VISIBLE_DEVICES=1`). The ORDER of `comfyui_instances()` is therefore load-bearing,
        not incidental.
        """
        # 🔴 AUTHORIZED, NOT MERELY INSTALLED. This enumerated every installed unit, so a card
        # unticked in ⚙ Settings ▸ Devices went on receiving LoRA work. `authorized_instances`
        # assigns `cuda:i` BEFORE filtering, so the survivors keep their real card numbers.
        return comfyui.authorized_instances()

    def _gen_render(job, device, url):
        """Submit one image to ComfyUI, fetch its result, and write it into the routed output store. ComfyUI has no vault DEK, so the face and result cross the boundary through its upload and view APIs rather than filesystem paths."""
        out = loragen.out_dir(job.subject) / job.filename
        try:
            face = loraface.face_path(job.subject)
            if not vault_fs.exists(face):
                raise flux2.GraphFailed("this subject has no seed face")

            # One upload per subject per run would be enough, but ComfyUI overwrites by name and
            # the cost is a single small PUT against minutes of sampling. Simpler beats clever.
            stored = flux2.upload_image(url, f"vocalis-face-{job.subject}.png",
                                        vault_fs.read_bytes(face))
            graph = flux2.build(_GEN_GRAPH, face_name=stored, prompt=job.prompt, seed=flux2.seed_for(job.id),
                                prefix=f"vocalis-lora/{job.subject}")
            pid = flux2.submit(url, graph)
            images = flux2.wait_for_images(url, pid)
            vault_fs.mkdir(out.parent)
            vault_fs.write_bytes(out, flux2.fetch_image(url, images[0]))
        except (flux2.GraphFailed, OSError) as exc:
            logger.error(f"lora generate: {job.id} on {device} failed - {exc}")
            _GEN.landed(job.id, ok=False)
            return
        # 🔴 `landed()` MUST RUN ON EVERY PATH, AND THE `except` ABOVE IS TOO NARROW TO PROMISE IT.
        # A locked vault raises `VaultLocked`, which is an `Exception` but not an `OSError`; a MAC
        # failure raises `VaultAuthError`, which is not even an `Exception`; ComfyUI answering 200
        # with non-JSON raises `ValueError`; a revised graph raises `KeyError` out of `flux2.build`.
        # None of those matched, so the worker thread died silently without landing the job —
        # `done + failed` never reached `total`, `finished()` stayed False for ever, `_release_cards`
        # never ran, and every later generate answered 409 "a generation is already running" with
        # the progress bar frozen and `error` empty. Only a restart cleared it.
        #
        # ⚠️ `BaseException` DELIBERATELY, and re-raised. `VaultAuthError` does not inherit from
        # `Exception` precisely so it sails through blanket handlers (`vault.py` says so in terms),
        # and this is a daemon thread — swallowing it would lose the diagnosis. The job is landed
        # so the RUN can end; the exception still propagates.
        except BaseException:
            logger.exception(f"lora generate: {job.id} on {device} died unhandled")
            _GEN.landed(job.id, ok=False)
            raise
        logger.info(f"lora generate: {job.id} -> {out.name} on {device}")
        _GEN.landed(job.id, ok=True)

    def _gen_dispatch(job, device, url):
        """Hand a render to a worker thread and return immediately. The queue calls dispatch while holding its lock; waiting for ComfyUI here would block start and stop requests. The worker reports completion through the run state, and sibling runners use the same asynchronous pattern."""
        threading.Thread(target=_gen_render, args=(job, device, url),
                         name=f"lora-gen-{job.id[:8]}", daemon=True).start()

    #: Loaded once. 📌 A graph re-read per image would let an edit land mid-run, so half a
    #: contact sheet would come from one graph and half from another with nothing to say so.
    _GEN_GRAPH = flux2.load_graph()

    #: One run per process. `GenerateRun.start` refuses a second rather than queueing it.
    _GEN = loragen.GenerateRun(dispatch=_gen_dispatch, backends=_gen_backends)

    @bp.post("/lora/subjects/<subject_id>/generate")
    @_guard
    def lora_generate(subject_id):
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404
        if not s.prompts:
            return jsonify({"error": "this subject has no prompts yet"}), 400
        per = (request.get_json(silent=True) or {}).get("per_prompt") or 1
        # The COMPOSED prompts, not the raw lines: identity is prepended once, here, by the same
        # function the Prompts screen previews with. Two composition sites would drift.
        composed = loraprompts.compose_all(s.identity, s.prompts)
        try:
            st = _GEN.start(subject_id, composed, per)
        except loragen.GenerateRefused as exc:
            # 409, not 400: "the cards are busy" and "a run is already going" are both states that
            # resolve on their own, which is a different thing from a malformed request.
            return jsonify({"error": str(exc)}), 409
        return jsonify(_GEN.snapshot() | {"cards": st.cards})

    @bp.get("/lora/generate/options")
    @_guard
    def lora_generate_options():
        """What the Generate screen needs to state a cost.

        🔴 THE RATE IS SERVED, NOT WRITTEN INTO THE PAGE. A duration typed into markup
        drifts from the measurement it claims to be, and nothing would notice — which is
        the whole reason the other three screens show nothing rather than something stale.
        """
        return jsonify({
            "s_per_image": flux2.MEASURED_S_PER_IMAGE,
            "cards": len(_gen_backends()),
            "measured": "896x1152, 20 steps",
        })

    @bp.get("/lora/generate")
    @_guard
    def lora_generate_status():
        """What the progress bar polls. Cheap and derived — no stored progress to go stale."""
        return jsonify(_GEN.snapshot())

    @bp.post("/lora/generate/stop")
    @_guard
    def lora_generate_stop():
        """§4.4: *"Stop is real: it cancels the ComfyUI queue and keeps what exists."*

        Keeping what exists is free — the landed images are files and nothing removes them. What
        matters is that the cards come back even though the run did not finish.
        """
        _GEN.cancel()
        return jsonify(_GEN.snapshot())

    @bp.get("/lora/subjects/<subject_id>/generated")
    @_guard
    def lora_generated_list(subject_id):
        """The contact sheet's file list — read from DISK, not from run state.

        📌 Same reason `plan()` reads the directory: a RESUMED run already has images that this
        process never saw land, and a list built from the current run would show an empty sheet
        for work that is already done. The directory is the truth.
        """
        d = loragen.out_dir(subject_id)
        names = sorted(vault_fs.glob(d, "*.png")) if vault_fs.exists(d) else []
        return jsonify({"images": names, "count": len(names)})

    @bp.get("/lora/subjects/<subject_id>/generated/<name>")
    @_guard
    def lora_generated_image(subject_id, name):
        """One generated image.

        🔴 THE NAME IS MATCHED AGAINST THE DIRECTORY LISTING, NEVER JOINED TO A PATH. Joining
        caller-supplied text to a directory is the traversal bug this codebase already has one
        hand-written guard for; comparing against what `glob` actually returned cannot escape
        the directory at all, because a name that is not in the listing is simply absent.
        """
        d = loragen.out_dir(subject_id)
        if not vault_fs.exists(d) or name not in set(vault_fs.glob(d, "*.png")):
            return jsonify({"error": "no such image"}), 404
        resp = Response(vault_fs.read_bytes(d / name), mimetype="image/png")
        # A generated image never changes under its name — the plan derives the name from the
        # position, and a re-run SKIPS a file that exists rather than replacing it.
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    # ── 9.0-m5: Train ──────────────────────────────────────────────────────────

    #: One training per process. `stop`/`alive` come from `voicetrain`'s proven scope machinery.
    #
    # ⚠️ LOOKED UP AT CALL TIME, NOT BOUND HERE. `launch=loratrain.launch_real` captures the
    # function object when the blueprint is built, so a test that patches the module attribute
    # afterward patches nothing and silently exercises the real launcher — which can start a
    # long training from
    # a unit test. An injected seam that cannot actually be swapped is decoration.
    _TRAIN = loratrain.TrainRun(
        launch=lambda **kw: loratrain.launch_real(**kw),
        stop=lambda pid, unit: loratrain.stop_real(pid, unit),
        alive=lambda pid, unit: loratrain.alive_real(pid, unit),
    )

    def _train_cfg(s, body):
        """The resolved config for a subject, from the form body.

        📌 `overrides` is passed straight through from the request precisely so the pins in
        `loratrain.PINNED` are guarding real client input rather than a Python signature.
        """
        return loratrain.resolve(
            dataset_dir=lorasubj.dataset_dir(s.id),
            output_dir=_TRAIN.output_dir(s.id),
            name=f"{s.name}-{body.get('preset', loratrain.DEFAULT_PRESET)}",
            preset=body.get("preset", loratrain.DEFAULT_PRESET),
            steps=body.get("steps"),
            rank=body.get("rank", 16),
            lr=body.get("lr", 1e-4),
            overrides=body.get("overrides") or {},
        )

    @bp.get("/lora/train/options")
    @_guard
    def lora_train_options():
        """What the screen needs to draw itself: the measured presets, and the locked keys WITH
        the reason each one is locked.

        🔴 THE REASONS ARE SERVED, NOT HARD-CODED IN THE PAGE. `show YAML` is the safety
        mechanism, and a mechanism whose explanations live in a second file drifts from the pins
        it is explaining — at which point the screen is confidently annotating the wrong keys.
        """
        return jsonify({
            "presets": [{"key": p.key, "label": p.label, "resolution": p.resolution,
                         "steps": p.steps, "s_per_it": p.s_per_it, "vram_gib": p.vram_gib,
                         "seconds": p.seconds()} for p in loratrain.PRESETS.values()],
            "default": loratrain.DEFAULT_PRESET,
            "locked": [{"key": pin.path[-1], "value": pin.value, "why": pin.why}
                       for pin in loratrain.PINNED],
            "omitted": list(loratrain.OMITTED),
            "available": loratrain.launcher_available(),
        })

    @bp.post("/lora/subjects/<subject_id>/train/preview")
    @_guard
    def lora_train_preview(subject_id):
        """The resolved YAML, before launch. This IS `show YAML` from the requirements."""
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404
        body = request.get_json(silent=True) or {}
        return jsonify({"yaml": loratrain.to_yaml(_train_cfg(s, body))})

    @bp.post("/lora/subjects/<subject_id>/train")
    @_guard
    def lora_train_start(subject_id):
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404

        images = lorasubj.dataset_size(subject_id)
        if not images:
            return jsonify({"error": "this subject has no built dataset yet - Curate, then Build"}), 400

        if not loratrain.launcher_available():
            # An honest 501 rather than a launch that fails four minutes later inside a subprocess.
            return jsonify({"error": "ai-toolkit is not installed on this host"}), 501

        # 🔴 REFUSED WHILE ComfyUI IS UP, NOT AUTO-STOPPED. Training peaks at 27.42 GiB of 31.86
        # on card 0, so a ComfyUI holding VRAM makes it OOM. The tempting move is to stop ComfyUI
        # here automatically — but `/comfyui/stop` deliberately REFUSES when a render is in
        # flight, and a training that stopped it as a side effect would walk straight through
        # that guard and destroy the render. So this refuses and says which button to press:
        # the user's own click goes through the existing guard, which is where it belongs.
        # ⚠️ `comfyui_active_count()` RETURNS None RATHER THAN RAISING — it catches its own
        # `OSError`/`SubprocessError` and returns None for "cannot establish". Wrapping it in a
        # blind `except Exception` was dead weight around a function that does not throw, and it
        # cost three suppression ratchets to notice. None means unknown, and unknown is treated
        # as "not in the way": a box with no systemd must not be blocked from training by a probe
        # that cannot answer.
        active = comfyui.comfyui_active_count()
        if active:
            return jsonify({
                "error": "ComfyUI is running and training needs the whole card "
                         f"({loratrain.PRESETS[loratrain.DEFAULT_PRESET].vram_gib} GiB peak of "
                         "31.86). Stop it from the header, then start the training.",
                "comfyui_running": active,
            }), 409

        body = request.get_json(silent=True) or {}
        cfg = _train_cfg(s, body)

        # ⚠️ BOTH CARDS, FOR THE WHOLE RUN. Unlike Generate — which takes one card per instance
        # and hands work out dynamically — a training is model-parallel across both and holds
        # them for hours. The lease is what makes `/comfyui/stop`'s guard see it.
        # 🔴 AUTHORIZED, NOT MERELY INSTALLED — see `_gen_backends`. A training holds both
        # cards for hours; an unticked one must not be among them.
        #
        # ⚠️ **"NO UNITS INSTALLED" AND "EVERY CARD UNTICKED" ARE DIFFERENT ANSWERS**, and the
        # first draft of this collapsed them. Unlike the render queue — whose dispatcher is
        # LongCat and which therefore keeps a `cuda:0` fallback — a training genuinely runs
        # through ai-toolkit on the cards ComfyUI is configured for, so with no units the old
        # `or ["cuda:0"]` was a guess. It stays, because that is the behavior every existing
        # single-card install has and a review is not the place to change it; what must NOT
        # happen is falling back to card 0 when the user has explicitly forbidden every card.
        if not comfyui.comfyui_instances():
            devices = ["cuda:0"]
        else:
            devices = [d for _s, _u, d in comfyui.authorized_instances()]
            if not devices:
                return jsonify({"error": "no card is authorized for LoRA Studio - tick one "
                                         "under Settings > Devices"}), 409
        # 🔴 THE ANSWER IS ACTED ON, AND ALL-OR-NOTHING. This discarded the bool, so a
        # training started on cards a generation or a render already held — model-parallel
        # across both, for hours — and the `finally` below then handed back THEIR leases.
        # A training is the most expensive thing on the box to double-book, so a partial
        # claim is rolled back rather than run on whatever it managed to get.
        label = f"lora-train:{s.name}"
        claimed = []
        for d in devices:
            if not gpu.GPUS.claim_external(d, label):
                for got in claimed:
                    gpu.GPUS.release_external(got, label)
                return jsonify({"error": "the cards are busy - a render, a generation or "
                                         "another training holds them"}), 409
            claimed.append(d)

        # 🔴 `finally`, NOT `except Exception`. A LEASE LEAKED BY A FAILED START MAKES ComfyUI
        # UNSTOPPABLE FOR EVER: the lease is exactly what `/comfyui/stop` refuses on, so a claim
        # that outlives its run turns a transient failure into a permanent one that survives until
        # someone restarts Vocalis.
        #
        # ⚠️ AND `except Exception` WOULD NOT HAVE CAUGHT THE MOST LIKELY CASE. `start()` writes
        # the config through `vault_fs`, which raises the vault's locked error — and that is a
        # **BaseException**, deliberately, so ordinary handlers cannot swallow it. The first draft
        # here released the lease on `Exception` and would have leaked it on precisely the failure
        # this app has most of: a locked vault.
        started = False
        try:
            # 🔴 THE RESOLVED PRESET, NOT THE BODY'S. `resolve()` silently falls back to the
            # default for an unknown key, so echoing what the client sent would report a preset
            # that did not run — which is worse than the empty string this replaces.
            st = _TRAIN.start(subject_id, s.name, cfg, devices,
                              preset=loratrain.resolved_preset(body.get("preset")))
            started = True
        except loratrain.TrainRefused as exc:
            return jsonify({"error": str(exc)}), 409
        finally:
            if not started:
                # ⚠️ BY LABEL. This was the one release in this file that did not filter,
                # unlike the two below — so a failed training start also freed a live
                # Generate run's `lora:<subject>` leases.
                for d in devices:
                    gpu.GPUS.release_external(d, label)
        return jsonify(st)

    @bp.get("/lora/train")
    @_guard
    def lora_train_status():
        """What the progress line polls. Releases the cards when the run has ended — reconciled
        on READ for the same reason the run state is: a 9.6-hour job outlives any watcher."""
        st = _TRAIN.snapshot()
        # 🔴 ONLY ONCE A RUN HAS ACTUALLY EXISTED. `running` is False for the whole window between
        # the claim in `lora_train_start` and `_TRAIN.start()` returning — and that window is long:
        # it writes the routed config, stages 40-80 images out of the vault, and blocks in
        # `communicate(timeout=300)`. Any concurrent poll in that window — a second tab, a reload,
        # `openTrain()`'s unconditional `pollTrain()` — released both cards out from under a
        # training that then ran for hours holding 27 GiB with no lease, so `render_active()`
        # reported the box idle and `/comfyui/stop` could not see it. A poller must never release
        # a lease a writer has taken but not yet published.
        # 📌 `subject_id` IS THE "a run has been published" FLAG — `TrainState` defaults it to `""`
        # and only `start()` sets it, at the same moment it sets `running`. Gating on it is what
        # distinguishes "the run has ended" from "the run has not begun yet".
        if not st["running"] and st["subject_id"]:
            for d, holder in list(gpu.GPUS.external().items()):
                if holder.startswith("lora-train:"):
                    gpu.GPUS.release_external(d, holder)
        return jsonify(st)

    @bp.post("/lora/train/stop")
    @_guard
    def lora_train_stop():
        """Cancel the run and hand the cards back.

        🔴 THE RELEASE IS IN A `finally`, BECAUSE IT MUST NOT DEPEND ON THE STOP SUCCEEDING.
        `cancel()` reaches `voicetrain.stop_train`, which runs `systemctl` and signals a process
        group — both of which can fail, and a failure there is exactly when the cards are most
        likely to be stuck. Releasing only on the happy path means the one case that needs the
        release is the one that does not get it, and a held lease makes `/comfyui/stop` refuse
        for ever afterward.

        ⚠️ Stopping is still best-effort by design: if the kill genuinely failed, the training
        may still be running. That is why the answer is the SNAPSHOT rather than `{"ok": true}` —
        `alive()` is re-read on every status poll, so a survivor reappears as running instead of
        being papered over here.
        """
        try:
            return jsonify(_TRAIN.cancel())
        finally:
            for d, holder in list(gpu.GPUS.external().items()):
                if holder.startswith("lora-train:"):
                    gpu.GPUS.release_external(d)

    @bp.get("/lora/subjects/<subject_id>/train/log")
    @_guard
    def lora_train_log(subject_id):
        """The log's tail, for `open log`.

        ⚠️ TAIL ONLY, never the whole file: a 2,000-step run with a timer block per step makes a
        log of tens of MB and this would otherwise ship all of it to a browser.
        """
        if not lorasubj.get(subject_id):
            return jsonify({"error": "no such subject"}), 404
        path = _TRAIN.log_path(subject_id)
        st = vault_fs.stat(path)
        if st is None:
            return jsonify({"text": "", "size": 0})
        try:
            with vault_fs.open_read(path) as fh:
                if st.size > loratrain.TAIL_BYTES:
                    fh.seek(st.size - loratrain.TAIL_BYTES)
                blob = fh.read()
        except OSError as exc:
            return jsonify({"error": str(exc)}), 500
        return jsonify({"text": blob.decode("utf-8", "replace"), "size": st.size})

    # ── 9.0-m7: face candidates ────────────────────────────────────────────────

    #: The txt2img graph, loaded once. Same reasoning as `_GEN_GRAPH`.
    _CAND_GRAPH = flux2.load_txt2img_graph()

    def _cand_dispatch(*, prompt, seed):
        """One candidate image's BYTES. Raises `flux2.GraphFailed` if nothing came back.

        ⚠️ Returns bytes rather than writing, so the store decides the filename and the routing —
        the same split `peaks.py` keeps against its cache.
        """
        backends = _gen_backends()
        if not backends:
            raise flux2.GraphFailed("no ComfyUI backend is configured")
        _svc, url, _device = backends[0]
        g = flux2.build_txt2img(_CAND_GRAPH, prompt=prompt, seed=seed,
                                prefix="vocalis-lora/candidates")
        pid = flux2.submit(url, g)
        images = flux2.wait_for_images(url, pid)
        return flux2.fetch_image(url, images[0])

    _CANDS = loracands.Candidates(dispatch=lambda **kw: _cand_dispatch(**kw),
                                  devices=lambda: [d for _s, _u, d in _gen_backends()])

    @bp.post("/lora/subjects/<subject_id>/face/candidates")
    @_guard
    def lora_face_candidates_start(subject_id):
        if lorasubj.get(subject_id) is None:
            return jsonify({"error": "no such subject"}), 404
        body = request.get_json(silent=True) or {}
        try:
            st = _CANDS.start(subject_id, body.get("prompt") or "",
                              body.get("count") or loracands.DEFAULT_COUNT)
        except loracands.CandidatesRefused as exc:
            return jsonify({"error": str(exc)}), 409
        return jsonify(st)

    @bp.get("/lora/subjects/<subject_id>/face/candidates")
    @_guard
    def lora_face_candidates_list(subject_id):
        return jsonify({"candidates": loracands.list_candidates(subject_id),
                        "run": _CANDS.snapshot(),
                        "default_prompt": loracands.DEFAULT_PROMPT})

    @bp.get("/lora/subjects/<subject_id>/face/candidates/<name>")
    @_guard
    def lora_face_candidate_image(subject_id, name):
        """One candidate's bytes.

        🔴 THE NAME IS MATCHED AGAINST THE LISTING, NEVER JOINED TO A PATH — the same guard the
        generated-image route keeps. A name that is not in what `glob` returned is simply absent,
        so there is no traversal to defend against.
        """
        if name not in loracands.list_candidates(subject_id):
            return jsonify({"error": "no such candidate"}), 404
        blob = vault_fs.read_bytes(loracands.candidates_dir(subject_id) / name)
        resp = Response(blob, mimetype="image/png")
        # A candidate never changes under its name: a re-run overwrites cand-00 with a new image,
        # so `no-cache` (revalidate) rather than a long max-age.
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @bp.post("/lora/subjects/<subject_id>/face/candidates/<name>/choose")
    @_guard
    def lora_face_candidate_choose(subject_id, name):
        try:
            return jsonify(loracands.choose(subject_id, name))
        except loracands.CandidatesRefused as exc:
            return jsonify({"error": str(exc)}), 404

    @bp.post("/lora/subjects/<subject_id>/face/candidates/stop")
    @_guard
    def lora_face_candidates_stop(subject_id):
        return jsonify(_CANDS.cancel())

    @bp.delete("/lora/subjects/<subject_id>/face/candidates")
    @_guard
    def lora_face_candidates_sweep(subject_id):
        return jsonify({"deleted": loracands.sweep(subject_id)})

    # ── 9.0-m6: does the LoRA do anything ──────────────────────────────────────

    _TEST_GRAPH = flux2.load_lora_test_graph()

    def _test_dispatch(*, lora, prompt, seed, strength):
        backends = _gen_backends()
        if not backends:
            raise flux2.GraphFailed("no ComfyUI backend is configured")
        _svc, url, _device = backends[0]
        g = flux2.build_lora_test(_TEST_GRAPH, lora=lora, prompt=prompt, seed=seed,
                                  strength=strength, prefix="vocalis-lora/test")
        pid = flux2.submit(url, g)
        images = flux2.wait_for_images(url, pid)
        return flux2.fetch_image(url, images[0])

    @contextlib.contextmanager
    def _test_lend(subject_id, lora):
        """Carry a model out of the vault to ComfyUI, for this run only — or do nothing at all if
        the pick was one of ComfyUI's own.

        🔴 **THE SERVER DECIDES WHICH, NOT THE BROWSER.** The obvious alternative is a marker in
        the option value (`trained:<name>`), and it would be a protocol living in two files that
        agree until someone edits one. The question "is this one of THIS subject's trained models"
        is answerable here, from the vault, with no help from the client — so it is answered here.
        """
        for name, src in loratrain.trained_models(subject_id):
            if name == lora:
                with lorapublish.lent(src) as lent_name:
                    yield lent_name
                return
        yield lora

    _TEST = loratest.LoraTest(dispatch=lambda **kw: _test_dispatch(**kw),
                              devices=lambda: [d for _s, _u, d in _gen_backends()],
                              lend=_test_lend)

    @bp.get("/lora/test/loras")
    @_guard
    def lora_test_loras():
        """What ComfyUI will accept for `lora_name`.

        🔴 ASKED OF ComfyUI, NEVER GUESSED FROM A DIRECTORY LISTING. The validation run found the
        unet path had moved under the graph; the same drift applies here, and a name this app
        invented would fail inside a loader with a TypeError that says nothing about filenames.
        """
        backends = _gen_backends()
        if not backends:
            return jsonify({"loras": [], "error": "no ComfyUI backend is configured"})
        _svc, url, _device = backends[0]
        try:
            return jsonify({"loras": flux2.list_loras(url)})
        except (flux2.GraphFailed, OSError) as exc:
            return jsonify({"loras": [], "error": str(exc)})

    @bp.post("/lora/subjects/<subject_id>/test")
    @_guard
    def lora_test_start(subject_id):
        s = lorasubj.get(subject_id)
        if s is None:
            return jsonify({"error": "no such subject"}), 404
        b = request.get_json(silent=True) or {}
        try:
            st = _TEST.start(subject_id, b.get("lora") or "", b.get("prompt") or "",
                             int(b.get("seed") or 12345),
                             b.get("strengths") or loratest.DEFAULT_STRENGTHS)
        except loratest.TestRefused as exc:
            return jsonify({"error": str(exc)}), 409
        except (TypeError, ValueError):
            return jsonify({"error": "seed and strengths must be numbers"}), 400
        return jsonify(st)

    @bp.get("/lora/subjects/<subject_id>/test")
    @_guard
    def lora_test_status(subject_id):
        """📌 `trained` is served from the STATUS route rather than from `/lora/test/loras`,
        because that route is global and this list is per subject: another subject's model is
        nothing this screen should offer, and the vault is the only place it exists."""
        return jsonify({"images": loratest.list_images(subject_id), "run": _TEST.snapshot(),
                        "trained": [name for name, _p in loratrain.trained_models(subject_id)],
                        "can_publish": lorapublish.available()})

    @bp.get("/lora/subjects/<subject_id>/test/<name>")
    @_guard
    def lora_test_image(subject_id, name):
        if name not in loratest.list_images(subject_id):
            return jsonify({"error": "no such image"}), 404
        resp = Response(vault_fs.read_bytes(loratest.test_dir(subject_id) / name),
                        mimetype="image/png")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @bp.post("/lora/test/stop")
    @_guard
    def lora_test_stop():
        return jsonify(_TEST.cancel())

    @bp.delete("/lora/subjects/<subject_id>/test")
    @_guard
    def lora_test_sweep(subject_id):
        return jsonify({"deleted": loratest.sweep(subject_id)})

    return bp
