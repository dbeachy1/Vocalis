"""Speech source preparation shared by Stems, Clips, Playground, and Cleanup.

The retained `/train/*` paths import, list, enhance, rename, and join audio sources. They do not
launch RVC training jobs.
"""
import re
import subprocess
import threading
import uuid
from pathlib import Path

import yaml
from flask import Blueprint, abort, jsonify, request

import clip_favorites
import clip_sources
import enhance
import folders
import leadvocal                    # 8.5 — the joiner for /train/import_stems_joined
import playground_clips
import scenes                       # 7.5 — /train/import_scene resolves and names through it
import scratch
import stems
import vault_fs
import speech_sources
from book_to_audio import CHUNKS_ROOT, OUTPUT_DIR
from loguru import logger
from store_serve import send_store_file
from tts_utils import GenParams, ffprobe_duration, save_wav_sf, wav_to_mp3

from vocalis.runtime import configs
from vocalis.runtime import paths
from vocalis.runtime import enhancement
from vocalis.runtime import gpu as rt_gpu
from vocalis.runtime.gpu import GPUS
from vocalis.runtime.jobs import JOBS, JOBS_LOCK, Job, emit, prune_jobs as _prune_jobs
from vocalis.runtime.params import as_bool as _b


#: What 🎓 may send to the training pool, and the caption each one gets. Two entries, because
#: two stems are voices: the wet vocal Demucs isolated, and the lead 8.4 cut out of it. The
#: other four slots in `stems.STEM_NAMES` are instruments, and a corpus for learning a SINGER
#: has no use for the drums under her.
_TRAIN_STEMS = {"vocals": "vocals", "lead_solo": "lead vocal"}

#: 8.5 — joining a SELECTION of stem sets into one training clip.
#: `JOIN_SR` is the rate every take is decoded to before concatenation. 44.1 kHz because it is
#: what Demucs writes and what `audio-separator` answers at; a stored stem may well be 48 kHz
#: (Opus is a 48 kHz codec) and mixing the two without resampling plays at the wrong speed.
#: `JOIN_GAP_SEC` is silence BETWEEN takes and it is load-bearing — RVC slices a dataset at
#: silence, so the gap is what makes one file train as many separate takes.
#: `MAX_JOIN_SETS` bounds a request body, not the workflow: ten songs is the stated use case and
#: forty is already more audio than RVC wants.
def decode_take(src, dst, sr: int) -> bool:
    """One take → a plaintext WAV at exactly `sr`. True if it landed.

    A named function rather than an inline `subprocess.run`, and that is for the tests: patching
    `subprocess.run` reaches the MODULE OBJECT, which every other caller in the process shares —
    so a spec that faked ffmpeg here would silently fake it for `wav_to_mp3`, for Demucs, for
    anything. One seam, owned by this module, is patchable without that blast radius.

    🔴 The subprocess stays on THIS side of the boundary on purpose. `leadvocal.py` says of
    itself that it runs no subprocess and touches no store — it takes arrays and builds command
    lines, and somebody else runs them. That is what makes its arithmetic unit-testable without
    ffmpeg on the box, and it is not worth spending for one convenience."""
    # 🔴 `encoding="utf-8", errors="replace"`, NOT bare `text=True`. Bare text mode decodes the
    # child's output with the LOCALE codec — cp1252 on Windows — and ffmpeg emits bytes that are
    # not valid in it, so reading its stderr raises UnicodeDecodeError and this route 500s on a
    # decode that actually succeeded. `voiceswap._run_stage` has always done it this way; I did
    # not, and the same trap bit twice more tonight (detect.py died PRINTING its success, and a
    # benchmark died READING a child). One of them is enough to make it a rule.
    r = subprocess.run(leadvocal.build_decode_at_cmd(src, dst, sr),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode == 0 and Path(dst).exists()


JOIN_SR = 44_100
JOIN_GAP_SEC = 2.0
MAX_JOIN_SETS = 40


def create_train_blueprint() -> Blueprint:
    """Register Speech source preparation and shared clip cleanup routes."""
    bp = Blueprint("vocalis_train", __name__)

    @bp.route("/train/sources")
    def train_sources():
        """Training clips in the repository, with durations (the 60-min checkbox
        and the ETA both key off duration)."""
        rows = speech_sources.list_sources(configs.speech_cfg())
        # 8.9 — stamp each clip's virtual folder. Scope `train_sources`, keyed on `ref`.
        # ⚠️ THREE PANELS render this one dataset (Speech tab, Training ▸ sources, and the Voice
        # Swap picker's speech half), which is exactly why the scope is the DATA and not the panel:
        # filing a clip in one and finding it unfiled in another would read as data loss.
        # 🔴 And the ref IS the filename, so `folders.RENAME_MOVES_REF` lists this scope and the
        # rename route below carries the assignment across.
        return jsonify(folders.for_rows(paths.FOLDERS.parent, "train_sources", rows))


    @bp.route("/train/sources", methods=["POST"])
    def train_source_upload():
        """Upload a training clip (multipart field 'file'). 409 on a name
        collision unless `overwrite` — the songs-upload contract."""
        if "file" not in request.files:
            return jsonify({"error": "no file uploaded (form field 'file')"}), 400
        f = request.files["file"]
        try:
            row = speech_sources.save_upload(configs.speech_cfg(), f.filename, f.stream,
                                         overwrite=_b(request.form, "overwrite"))
        except FileExistsError as exc:
            return jsonify({"error": "exists", "name": str(exc)}), 409
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(row)


    @bp.route("/train/sources/<fname>/audio")
    def train_source_audio(fname):
        """A training clip itself (source_path re-validates — leaf refs only).

        `?download=1` saves it. The route has always served the audio, but nothing in the UI
        linked to it, so the ONLY downloadable thing on a clip row was the ⬇ enhanced button —
        which fetches the enhancer's OUTPUT, and only exists for the minority of clips that
        have been enhanced. The clip you actually uploaded had no way out of the app."""
        p = speech_sources.source_path(configs.speech_cfg(), fname)
        if p is None:
            abort(404)
        # main's ?download=1 (4.2-m0e), through 5.x's vault-aware sender: `send_file` would open the
        # plaintext path, which under the vault is not on the platter. send_store_file keeps the
        # Range support the player needs and decrypts only the bytes the range asks for.
        download = request.args.get("download") == "1"
        return send_store_file(p, as_attachment=download,
                               download_name=p.name if download else None)


    @bp.route("/train/sources/<fname>/enhanced")
    def train_source_enhanced(fname):
        """Download a training clip's ENHANCED audio — the 44.1 kHz WAV the enhancer made,
        available the moment enhancement finishes rather than when the training ends.

        That gap is the point. Enhancement is the first hour or two of a run that may go on
        for eighteen, and the enhanced audio is finished, useful material in its own right —
        it should not be hostage to a training that might yet be stopped, nor to whether the
        resulting voice turns out any good.

        The file itself lives in the enhanced-audio cache under a sha256 name (§5.7 — opaque,
        so a Playground clip's prompt text can never leak into a fresh plaintext filename),
        which means it cannot be found BY source. voicetrain writes the pointer onto the
        clip's sidecar as it goes, and this reads it back."""
        p = speech_sources.source_path(configs.speech_cfg(), fname)
        if p is None:
            abort(404)
        meta = speech_sources._read_source_meta(p)
        enh = Path(str(meta.get("enhanced") or ""))
        # It lives in cache_root()/enhanced — the CACHE VAULT — so `enh.is_file()` is a question
        # about a path that does not exist once the vault is on.
        if not str(meta.get("enhanced")) or not vault_fs.exists(enh):
            return jsonify({"error": "no enhanced audio for this clip yet — it is made the "
                                     "first time a training preps it"}), 404
        return send_store_file(enh, as_attachment=True,
                               download_name=f"{p.stem}_enhanced.wav")


    def _enhance_source_job(job: Job, src: Path, nfe: int, device: str) -> None:
        """Enhance a training clip KEEPING BOTH (§10.4 decision B): the original is untouched and a
        full-band copy is cached beside it, its pointer recorded on the clip's sidecar — exactly
        what dataset prep does, but on demand rather than as an invisible side effect of a run.

        Same card discipline as _enhance_clip_job: everything inside the try, the card released in
        the finally, so a tidy-up can never leak a card and wedge the app."""
        tmp = None
        try:
            job.status = "running"
            cfg = configs.enhance_cfg()
            cached = enhance.cache_path(src, nfe)  # opaque, keep-both (no source name leaks)
            # 🔴 M10 §4.4 — vault_fs.exists. cache_path() is cache_root()/enhanced/…, a routed tree,
            # so a bare is_file() answers False for a copy that is right there and this job
            # RE-ENHANCES EVERY TIME: minutes of GPU burned per click, silently, with the UI
            # reporting a normal success each time.
            if vault_fs.exists(cached):  # already made at these steps — just point at it
                speech_sources._record_enhanced(src, cached, nfe, 0)
                job.clip_ref = src.name
                job.status = "done"
                emit(job, {"type": "log",
                           "line": "✓ A full-band copy already existed — ready to download."})
                return
            tmp = enhance.scratch_path(cfg, src, tag=f"srcenh|{job.id}")
            tmp.parent.mkdir(parents=True, exist_ok=True)
            emit(job, {"type": "log", "line": f"Decoding “{src.name}”…"})
            # ffmpeg is a child with no DEK and `src` is a training clip in the routed tree.
            with vault_fs.child_input(src, tmp.parent) as plain_src:
                enhancement.decode_to_wav(plain_src, tmp)
            dur = ffprobe_duration(tmp) or 0  # the scratch decode — legible to ffprobe
            est = enhance.estimate_seconds(dur, nfe)
            emit(job, {"type": "log",
                       "line": f"Enhancing on {device} — {nfe} steps, {enhance.eta_note(est)}. "
                               f"The original is kept; this makes a full-band copy beside it."})
            # 🔴 THE PLAINTEXT → STORE BOUNDARY, and this job went around it. `enhance_one` runs the
            # enhancer child, which can only write a real file to a real path — pointed at `cached`
            # it wrote FULL-BAND AUDIO OF THE USER'S VOICE straight into the encrypted cache in
            # cleartext, `.part` and all. That is the exact seam enhance.store_cache exists to close
            # (enhance.py:273), and the correct shape is already in-tree at speech_sources.py:1823.
            # The child now writes to the scratch and store_cache is the only thing that lands it.
            with scratch.file(configs.scratch_root(), f"srcenh-out|{job.id}", ".wav") as enh:
                if not enhancement.enhance_one(job, tmp, enh, nfe, device, src.name):
                    job.status = "canceled"
                    return
                enhance.store_cache(enh, cached)            # scratch → the cache, encrypted, atomic
            speech_sources._record_enhanced(src, cached, nfe, 0)
            job.clip_ref = src.name
            job.status = "done"
            emit(job, {"type": "log",
                       "line": "✓ Full-band copy ready — download it from the clip's row."})
        except Exception as exc:                            # noqa: BLE001 — surfaced to the client
            logger.exception("training-clip enhancement failed")
            job.status, job.error = "failed", str(exc)
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)                 # plaintext must not outlive the job
            GPUS.release_card(device)
            # "job_done" so book_events closes the SSE (this job has no vram heartbeat to keep it
            # alive, and a non-terminal final event would leave the stream blocked).
            emit(job, {"type": "job_done", "status": job.status, "error": job.error,
                       "ref": job.clip_ref})


    @bp.route("/train/sources/<fname>/enhance", methods=["POST"])
    def train_source_enhance(fname):
        """Explicitly enhance a TRAINING clip, keeping both (§10.3). Body: {nfe}.

        Enhancement used to happen only as an invisible side effect of running training prep, which
        is why the badge 'enhanced copy ready' appeared out of nowhere days later (§10.1). This makes
        it a thing you do on purpose. The result is a cached full-band WAV + a sidecar pointer — the
        same artifact prep makes, reused free by the next run. Refuses a clip that is already
        full-band (a MEASUREMENT, §10.5): a real 48 kHz upload and one we enhanced read alike, and
        neither has anything to gain. Reuses the enhance job's poll/cancel/SSE via kind='enhance'."""
        if not enhancement.enhance_available():
            return jsonify({"error": enhancement.enhance_unavailable_reason()}), 400
        src = speech_sources.source_path(configs.speech_cfg(), fname)
        if src is None:
            abort(404)
        meta = speech_sources._read_source_meta(src)
        hz, _fresh = enhance.bandwidth_of(src, meta)
        if not hz:
            return jsonify({"error": "couldn't measure this clip — so there's no way to know "
                                     "whether enhancing it would add anything, and nothing was "
                                     "spent finding out."}), 409
        if not enhance.is_band_limited(hz):
            return jsonify({"error": "already full quality", "bandwidth_hz": hz}), 409
        nfe = enhance.validate_nfe((request.get_json(silent=True) or {}).get("nfe"))
        device, why = GPUS.claim_card(rt_gpu.cards_emptiest_first(enhancement.enhance_cards()),
                                      )
        if device is None:
            return jsonify({"error": enhancement.ENHANCE_BUSY[why]}), 409
        job = Job(id=uuid.uuid4().hex[:12], docx="", voice="",
                  params=GenParams(), gpus="", workers=0, kind="enhance", status="queued",
                  enhance=True, enhance_nfe=nfe, clip_ref=fname)
        with JOBS_LOCK:
            JOBS[job.id] = job
            _prune_jobs()
        try:
            threading.Thread(target=_enhance_source_job, args=(job, src, nfe, device),
                             daemon=True).start()
        except BaseException:  # no thread ⇒ no finally ⇒ the card would be lost for good
            GPUS.release_card(device)
            raise
        est = enhance.estimate_seconds(ffprobe_duration(src) or 0, nfe)
        return jsonify({"job_id": job.id, "est_s": round(est, 1) if est else None}), 202


    @bp.route("/train/sources/rename", methods=["POST"])
    def train_source_rename():
        """Rename a training clip in place (7f). Body: {ref, name}. A collision
        refuses (409) rather than overwriting — clobbering a different clip is the one
        outcome a rename must never produce."""
        data = request.get_json(force=True) or {}
        try:
            row = speech_sources.rename_source(configs.speech_cfg(), str(data.get("ref", "")),
                                           data.get("name"))
        except FileExistsError as exc:
            return jsonify({"error": f"a speech clip called “{exc}” already exists"}), 409
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        # 🔴 AN UPLOAD'S REF *IS* ITS FILENAME, so a rename moves it and the star does not follow.
        # `rename_source` renames the file and returns the NEW row; the favorite is still keyed on
        # the old name, and `for_rows` drops it in silence on the next listing. Same class and same
        # silence as the scene bug fixed in 8.8.3, and missed for the same reason — `rekey`'s
        # docstring claimed this kind did not need it. Shipped broken since 6.2.
        clip_favorites.rekey(paths.CLIP_FAVORITES.parent, clip_sources.UPLOAD,
                              str(data.get("ref", "")), str(row.get("ref") or ""))
        # 8.9 — and the FOLDER, off the same two values. An upload's ref simply IS its filename
        # and `speech_sources.rename_source` is "a pure, atomic file rename", so the assignment moves
        # with it or is lost in silence. Guarded by tests/test_folders_rename_hooks.py.
        folders.rekey(paths.FOLDERS.parent, "train_sources",
                      str(data.get("ref", "")), str(row.get("ref") or ""))
        # 🔴 AND AGAIN UNDER THE COMPOSED REF, BECAUSE THIS CLIP IS A ROW IN TWO SCOPES.
        # Voice Swap ▸ Sources merges five stores into one list and composes the refs it owns
        # itself — a speech clip appears there as `speech/<filename>` in the `voiceswap_songs`
        # scope (see `vsSources` in js/media/voiceswap.js). That is a SECOND assignment, keyed
        # on a string no `train_sources` rekey can reach, so renaming the clip left the Voice
        # Swap row filed under a ref that no longer exists and `for_rows` dropped it in silence
        # — the same silent unfiling this call exists to prevent, one scope over.
        folders.rekey(paths.FOLDERS.parent, "voiceswap_songs",
                      "speech/" + str(data.get("ref", "")), "speech/" + str(row.get("ref") or ""))
        return jsonify(row)


    @bp.route("/train/sources", methods=["DELETE"])
    def train_source_delete():
        """Remove training clips from the repository. Body: {refs: []}."""
        refs = (request.get_json(silent=True) or {}).get("refs") or []
        return jsonify({"deleted": speech_sources.delete_sources(configs.speech_cfg(), [str(r) for r in refs])})


    @bp.route("/train/import", methods=["POST"])
    def train_import():
        """'Send to Voice Training' (Playground library): copy a clip's audio into the
        training repository under its display name. Body: {clip: ref, overwrite}.
        409 on collision — the upload contract.

        `ref` is EITHER a finished clip ("<voice-dir>/<stem>", which always has a slash)
        OR an interrupted render's bare 12-hex workspace hash, so the two shapes can't
        collide. A partial imports its contiguous banked prefix — exactly the audio its
        row plays, and exactly the duration the UI gated the 🎓 button on. Length, not
        doneness, is what makes a clip trainable: a long partial is a fine dataset.
        """
        data = request.get_json(force=True) or {}
        ref, overwrite = str(data.get("clip", "")), _b(data, "overwrite")
        try:
            if re.fullmatch(r"[0-9a-f]{12}", ref):                 # an interrupted render
                wav, sr = playground_clips.prefix_wav(CHUNKS_ROOT, ref)
                if wav is None:
                    return jsonify({"error": "clip not found"}), 404
                meta = playground_clips._read_yaml(
                    playground_clips.workspace(CHUNKS_ROOT, ref)
                    / playground_clips.PENDING_NAME) or {}
                name = str(meta.get("name")
                           or str(meta.get("text", ""))[:48].rstrip() or ref)
                # The repo holds files, not chunk dirs: bank the prefix to a scratch WAV and
                # encode it, then hand voicetrain the same (mp3, name) a finished clip gives.
                # Scratch, not the OS temp dir: this is the audio of an interrupted PLAYGROUND
                # render, and `name` above is derived from the user's own text (5.0 §8).
                with scratch.directory(configs.scratch_root(), f"import-prefix|{ref}") as td:
                    wav_path = td / "prefix.wav"
                    save_wav_sf(str(wav_path), wav, sr)
                    row = speech_sources.import_clip(configs.speech_cfg(), wav_to_mp3(wav_path), name,
                                                 overwrite=overwrite, provenance="playground")
            else:
                mp3, side = playground_clips.clip_paths(OUTPUT_DIR / "playground", ref)
                if mp3 is None or not vault_fs.exists(mp3):    # output/ is a vault tree
                    return jsonify({"error": "clip not found"}), 404
                name = None
                try:
                    # Routed — and this is the pattern the plan warns about: the
                    # `vault_fs.exists(mp3)` guard three lines up was fixed and the read BEHIND
                    # it was not. The `except Exception: pass` below swallowed the
                    # FileNotFoundError, so the clip imported silently under the wrong name
                    # (mp3.stem) instead of the one the user gave it.
                    meta = yaml.safe_load(vault_fs.read_text(side)) or {}
                    name = meta.get("name")
                except Exception:                                  # noqa: BLE001
                    pass
                row = speech_sources.import_clip(configs.speech_cfg(), mp3, str(name or mp3.stem),
                                             overwrite=overwrite, provenance="playground")
        except FileExistsError as exc:
            return jsonify({"error": "exists", "name": str(exc)}), 409
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(row)


    @bp.route("/train/import_scene", methods=["POST"])
    def train_import_scene():
        """Import a SillyTavern Scene Clips row into Voice Training. The audio is already in a readable local store, so this route resolves the scene reference directly instead of downloading and uploading it through the browser. Each store keeps its own resolver and traversal checks."""
        data = request.get_json(force=True) or {}
        ref, overwrite = str(data.get("ref", "")), _b(data, "overwrite")
        # `scene_paths` is the store's OWN resolver and is where the traversal check lives — it
        # returns (None, None) for anything with a directory part in it. Note it returns a
        # NON-EMPTY tuple in that case, so unpack rather than testing the pair for truthiness
        # (the trap `clip_sources.resolve` records for the playground resolver).
        mp3, y = scenes.scene_paths(scenes.scenes_root(OUTPUT_DIR), ref)
        if mp3 is None or not vault_fs.exists(mp3):    # ROUTED — output/ is a vault tree
            return jsonify({"error": "scene not found"}), 404
        # The name the Clips row shows, from the one function that derives it (scenes.display_name)
        # — see its docstring for why this is not re-derived here. A manifest that cannot be read
        # is not fatal: the stem still names the scene, which is what the row falls back to too.
        name = scenes.display_name(scenes.read_manifest(y) or {}, mp3.stem)
        try:
            row = speech_sources.import_clip(configs.speech_cfg(), mp3, name,
                                         overwrite=overwrite, provenance="scene")
        except FileExistsError as exc:
            return jsonify({"error": "exists", "name": str(exc)}), 409
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(row)


    @bp.route("/train/import_stem", methods=["POST"])
    def train_import_stem():
        """Send a stem set's lead vocal to the training pool, defaulting to `vocals` for existing callers. `lead_solo` selects the isolated lead. Encode the WAV as an MP3 for the pool and keep the existing overwrite conflict response."""
        data = request.get_json(force=True) or {}
        cfg = configs.ss_cfg()
        ref, overwrite = str(data.get("ref", "")), _b(data, "overwrite")
        # 🔴 THE ALLOWLIST IS `_TRAIN_STEMS`, NOT `stem_key`. `stem_key` answers for every
        # DEMUCS SLOT — vocals, instrumental, drums, bass, other — plus the derived lead, and
        # this route is a door into a VOICE-TRAINING corpus. Passing its answer straight through
        # let `{"stem": "drums"}` import the drum track as `<song> — vocals`, badged
        # `provenance: "stems"`, under the exact name a genuine vocal import wants — so the real
        # 🎓 afterward 409s against a clip that misrepresents itself, and nothing in a list of
        # refs and durations would ever say so. Traversal-safe was never the whole question.
        stem = stems.stem_key(data.get("stem") or "vocals")
        if stem not in _TRAIN_STEMS:
            stem = "vocals"                  # every pre-8.4 caller, and anything unrecognized
        label = _TRAIN_STEMS[stem]
        wav = stems.stem_file(cfg, ref, stem)
        if wav is None:
            return jsonify({"error": f"no {label} stem in that set"}), 404
        d = stems.find_dir(cfg, ref)
        name = f"{stems.read_meta(d).get('song') or Path(ref).stem} — {label}"
        try:
            # Encode in scratch: wav_to_mp3 writes beside its input, and the split folder is a
            # library, not a scratch space. This copies a plaintext vocals.wav OUT of the store,
            # so it is a scratch boundary by definition and must not go to the OS temp dir
            # (5.0 §8). The name stays `vocals.wav` INSIDE the opaque directory — the folder is
            # the hash, and Demucs/ffmpeg still get a filename they can sniff.
            with scratch.directory(configs.scratch_root(), f"import-stem|{ref}") as td:
                tmp = td / f"{stem}.wav"
                # 🔴 ROUTED. The comment above says this "copies a plaintext vocals.wav OUT of
                # the store" — and under encryption there is nothing plaintext to copy: shutil
                # read the ciphertext path, which is not on disk, so importing a stem as a
                # training clip could not work at all. `write_bytes` rather than `to_scratch`
                # because the destination name matters here (Demucs/ffmpeg sniff by extension)
                # and to_scratch picks an opaque one of its own.
                tmp.write_bytes(vault_fs.read_bytes(wav))
                row = speech_sources.import_clip(configs.speech_cfg(), wav_to_mp3(tmp), name,
                                             overwrite=overwrite, provenance="stems")
        except FileExistsError as exc:
            return jsonify({"error": "exists", "name": str(exc)}), 409
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(row)


    @bp.route("/train/import_stems_joined", methods=["POST"])
    def train_import_stems_joined():
        """Join selected stem-set leads into one training clip. Inputs are resampled to a common rate before concatenation, and silence between clips preserves RVC segmentation. A set uses its lead stem when available and otherwise its wet vocal."""
        data = request.get_json(force=True) or {}
        cfg = configs.ss_cfg()
        refs = [str(r) for r in (data.get("refs") or [])][:MAX_JOIN_SETS]
        if not refs:
            return jsonify({"error": "no stem sets selected"}), 400
        overwrite = _b(data, "overwrite")
        try:
            gap = float(data.get("gap_sec", JOIN_GAP_SEC))
        except (TypeError, ValueError):
            gap = JOIN_GAP_SEC
        gap = max(0.0, min(10.0, gap))

        picked, missing = [], []
        for ref in refs:
            d = stems.find_dir(cfg, ref)
            # The lead if the set has one, else the wet vocal — the single button's rule.
            src = (stems.find_stem(d, "lead_solo") or stems.find_stem(d, "vocals")) if d else None
            if src is None:
                missing.append(ref)
                continue
            picked.append((ref, d, src))
        if not picked:
            return jsonify({"error": "none of those sets has a vocal to send"}), 404

        first = stems.read_meta(picked[0][1]).get("song") or Path(picked[0][0]).stem
        name = str(data.get("name") or "").strip() or (
            f"{first} +{len(picked) - 1} more" if len(picked) > 1 else first)
        name = f"{name} — lead vocals"
        try:
            with scratch.directory(configs.scratch_root(), f"join-stems|{len(picked)}") as td:
                takes = []
                for i, (_ref, _d, src) in enumerate(picked):
                    wav = td / f"take{i:02d}.wav"
                    # ROUTED, then normalized: `child_input` materializes plaintext out of the
                    # vault, `decode_take` puts every take on one rate.
                    with vault_fs.child_input(src, td) as plain:
                        ok = decode_take(plain, wav, JOIN_SR)
                    if not ok:
                        return jsonify({"error": f"could not decode the vocal of {_ref}"}), 500
                    x, _sr = leadvocal.read_wav(wav)
                    takes.append(x)
                joined = td / "joined.wav"
                leadvocal.write_wav(joined, leadvocal.join_takes(takes, JOIN_SR, gap), JOIN_SR)
                row = speech_sources.import_clip(configs.speech_cfg(), wav_to_mp3(joined), name,
                                             overwrite=overwrite, provenance="stems")
        except FileExistsError as exc:
            return jsonify({"error": "exists", "name": str(exc)}), 409
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        row["joined"] = len(picked)
        # Named, not silently dropped: a set that contributed nothing must be visible, or a
        # nine-song clip quietly becomes an eight-song one.
        row["skipped"] = missing
        return jsonify(row)


    return bp
