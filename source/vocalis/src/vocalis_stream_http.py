"""Expose streaming audio through a Flask Blueprint. POST endpoints issue short-lived one-time tokens; GET streams progressive MP3 from the shared worker pool or serves a completed cache hit. Tee encoded bytes into the cache and promote only after successful completion. Custom sources provide generators through one registry. Disconnects cancel the worker batch and ffmpeg process. CORS remains owned by the app-level rule."""
import os
import threading
import time
import uuid

from flask import Blueprint, abort, jsonify, request, send_file

import prerender as prerender_mod
import render_rate
import scene_build
import scratch
import vault_fs
from loguru import logger

from mp3_render import MP3_BITRATE, READ_BLOCK, Mp3Render, cache_hit   # noqa: F401 (re-exported)
from store_serve import send_store_file
from vocalis_streaming import StreamConfig

STREAM_TTL_S   = 120.0   # unclaimed tokens expire after this

# Cap concurrent LIVE streams. The register routes /speak/stream and /v1/audio/stream
# are unauthenticated (the extensions need them open), so without a cap a caller could
# open unlimited streams — each an ffmpeg process + pool batch + writer thread (fan-out
# DoS). 8 is far above real single-admin use (the web-UI playground streams too); a 9th
# gets 503 until a slot frees. Text length is deliberately NOT capped — the web UI
# streams long playground text legitimately. Cache HITS never take a slot.
MAX_CONCURRENT_STREAMS = int(os.environ.get("VOCALIS_MAX_STREAMS", "8"))
_stream_slots = threading.BoundedSemaphore(MAX_CONCURRENT_STREAMS)

# Items per /v1/audio/state request (5.4). The DoS bound on another unauthenticated route —
# each item costs a voice resolve and a stat() through the vault. Set ABOVE the 100 messages
# SillyTavern paints in one DOM update (`power_user.chat_truncation`, default 100) so the
# ordinary chat open is always ONE request; a client with truncation switched off chunks to
# this rather than sending one oversized batch. DESIGN_5_4_BUTTON_STATE §5.2.
MAX_STATE_ITEMS = 200

# Choose a bound well above ordinary scene ranges while rejecting accidental oversized requests.
MAX_SCENE_ITEMS = 5000

# Finished scene jobs kept for polling. Sibling of `runtime.jobs.JOBS_KEEP` (30) and of
# `voices._prune_design_jobs`; a build a page might still be polling must survive, and the
# manifest on disk is the durable record either way.
SCENE_JOBS_KEEP = 20

# Enhancement is a separate Clips action and uses one card, while scene rendering owns the pool. Only queued, rendering, and assembling scenes block another build.
ACTIVE_SCENE = ("queued", "rendering", "assembling")

# How many streams are on the wire RIGHT NOW. The semaphore cannot answer that
# (a BoundedSemaphore has no portable count), and 5.2's pre-render dispatcher
# needs it: speculative work may only start when nothing real is playing.
_live_lock  = threading.Lock()
_live_count = 0


# The state view must include live renders, not only queued pre-renders and cached audio, so the UI can distinguish playable audio from work that has not shipped a byte.
_live_keys = {}          # (cache_key, cache path) -> {"n": <renders in flight>, "shipped": bool}


def _live_begin(identity) -> None:
    if identity is None:
        return                                   # playground/web-UI streams are not cacheable
    with _live_lock:
        e = _live_keys.setdefault(identity, {"n": 0, "shipped": False})
        e["n"] += 1


def _live_shipped(identity) -> None:
    """The live path's equivalent of the pre-render governor's release: the first ENCODED
    block has left for the listener, so a click now plays through. Same rule, same moment —
    `stream_message` withheld everything until `required_buffer_s` was satisfied."""
    if identity is None:
        return
    with _live_lock:
        e = _live_keys.get(identity)
        if e is not None:
            e["shipped"] = True


def _live_end(identity) -> None:
    if identity is None:
        return
    with _live_lock:
        e = _live_keys.get(identity)
        if e is None:
            return
        e["n"] -= 1
        if e["n"] <= 0:
            _live_keys.pop(identity, None)


def live_state_of(identity):
    """`playable` / `rendering` for a key being rendered live, else None. Never raises."""
    with _live_lock:
        e = _live_keys.get(identity)
        if e is None:
            return None
        return "playable" if e["shipped"] else "rendering"


def _slot_taken():
    global _live_count
    with _live_lock:
        _live_count += 1


def _slot_freed():
    global _live_count
    with _live_lock:
        _live_count = max(0, _live_count - 1)


def live_stream_count() -> int:
    """Streams currently generating and shipping bytes. Cache hits are not counted
    — they take no slot, no ffmpeg and no pool batch. Nor are pre-render producers:
    they are bounded by the queue's own one-at-a-time rule, and counting them here
    would make the dispatcher's idle gate permanently false against itself."""
    with _live_lock:
        return _live_count


class StRequestError(Exception):
    """A /v1 request that cannot be resolved into a render, with the OpenAI-shaped
    body and status the route should answer with."""

    def __init__(self, message, type_="invalid_request_error", status=400):
        super().__init__(message)
        self.message, self.type, self.status = message, type_, status

    def response(self):
        return jsonify({"error": {"message": self.message, "type": self.type}}), self.status


def resolve_st_request(data: dict, *, nomi, st_registry, resolve_voice,
                       probe: bool = False) -> dict:
    """Parse a SillyTavern-shaped body into everything a render needs:
    {text, gen_kwargs, key, cpath, character, voice_src, force}.

    🔴 THE WHOLE OF 5.2 RIDES ON THIS BEING ONE FUNCTION. `/v1/audio/stream` and
    `/v1/audio/prerender` must derive byte-identical cache keys from the same body,
    or a pre-render can never be claimed: nothing errors, nothing logs, every
    message simply renders twice and the box just runs hot. So neither route knows
    how a key is made — they both ask here. See DESIGN_5_2_PRERENDER §4.4.

    `probe=True` (5.4's /v1/audio/state) suppresses this function's THREE side effects
    and changes nothing else — least of all the key, which is the whole point of asking
    here rather than reimplementing it read-only:

      1. the ST registry upsert — a passive glance at a chat must not register names;
      2. the cache directory mkdir — a chat load probes ~100 messages (ST paints
         `chat_truncation` in one go), and creating 100 encrypted directories for audio
         that may never exist is a write per message nobody asked for;
      3. the unresolvable-voice warnings — one per message, i.e. 100 lines per chat open
         describing a configuration problem that one render already reports.

    A probe is otherwise byte-identical, pinned by
    `test_probe_and_render_derive_the_same_key`. See DESIGN_5_4_BUTTON_STATE §5.3.

    Raises StRequestError; the caller answers with `.response()`.
    """
    text = str(data.get("input", "")).strip()
    if not text:
        raise StRequestError("'input' text is required")
    # Speak *action* spans by default; narrate_actions=false = dialogue only.
    from tts_utils import filter_actions
    text = filter_actions(text, bool(data.get("narrate_actions", True)))
    if not text:
        raise StRequestError("no speakable text (nothing with a letter or digit in it is left)")

    character = str(data.get("character", "")).strip()
    # Avatar disambiguates duplicate character names so voice lookup selects the intended registry entry.
    # ⚠️ OPTIONAL, AND ITS ABSENCE IS NOT AN ERROR. `/v1/audio/stream` is an open route with
    # callers that are not our extension, and an extension copy that has not been re-installed
    # sends no avatar. Both resolve by name exactly as they always did, which is right for the
    # overwhelmingly common case of one character per name.
    char_avatar = str(data.get("character_avatar", "")).strip()
    centry = None
    if character and st_registry is not None:
        if not probe:
            st_registry.upsert_seen([{"name": character, "avatar": char_avatar}]
                                    if char_avatar else [character])
        # A READ, and it decides the key.
        centry = st_registry.lookup(character, char_avatar)
    voice_name = str(data.get("voice", "")).strip()
    voice_src = "explicit"
    if not voice_name and centry and centry.get("voice"):
        voice_name, voice_src = centry["voice"], "character"
    if not voice_name and st_registry is not None and st_registry.default_voice:
        voice_name, voice_src = st_registry.default_voice, "st_default"
    if not voice_name:                       # backstop: the Nomi map's default
        nomi.reload_if_changed()
        voice_name = str(nomi.config.get("default_voice", "") or "")
        voice_src = "nomi_default"
    voice_ref = None
    if voice_name:
        if resolve_voice is None:
            raise StRequestError("voice selection unavailable", "server_error", 500)
        voice_ref = resolve_voice(voice_name)
        if voice_ref is None and voice_src == "explicit":
            raise StRequestError(f"unknown voice: {voice_name!r} — see GET /v1/audio/voices")
        if voice_ref is None and not probe:  # stale assignment / missing default:
            logger.warning(f"[sillytavern] {voice_src} voice {voice_name!r} does "
                           "not resolve — falling through")
    if voice_ref is None and not probe:
        logger.warning("[sillytavern] no voice resolvable — rendering with each "
                       "worker's LAST conditionals (nondeterministic; set a "
                       "default_voice or assign the character one)")

    def pick(key, default):
        if centry is not None and centry.get(key) not in (None, ""):
            return centry[key]
        return default
    gen_kwargs = {"voice": str(voice_ref) if voice_ref else None,
                  "exaggeration": float(pick("exaggeration", 0.5)),
                  "cfg": float(pick("cfg", 0.5)),
                  "temperature": float(pick("temperature", 0.8))}

    # MD5 cache via the SHARED NomiSpeaker protocol (same dir/eviction as
    # /speak): identical character+voice+params+text replays instantly.
    # None, not Path("") — the empty path IS `.`, and handing a directory to cache_key made
    # the key depend on that directory's mtime. See NomiSpeaker.cache_key.
    ccfg = {"voice": voice_ref,
            "voice_filename": voice_ref.name if voice_ref is not None else "",
            "exaggeration": gen_kwargs["exaggeration"],
            "cfg_weight": gen_kwargs["cfg"],
            "temperature": gen_kwargs["temperature"]}
    key = nomi.cache_key(ccfg, text)
    # The speaker that owns this entry's slice of the cache, and therefore its own 5,000-file
    # budget. An unnamed request (no `character` in the payload) shares one bucket — it has no
    # identity to give it a private one, and inventing one per request would defeat the cap.
    owner = f"st:{character}"
    cpath = nomi.cache_path(key, owner)
    if not probe:
        vault_fs.mkdir(cpath.parent)      # routed: a plain mkdir makes a CLEARTEXT-named dir
    return {"text": text, "gen_kwargs": gen_kwargs, "key": key, "cpath": cpath,
            "character": character, "character_avatar": char_avatar, "voice_src": voice_src,
            "voice_set": voice_ref is not None, "owner": owner,
            "force": bool(data.get("force", False))}


def _default_stream_config() -> StreamConfig:
    cfg = StreamConfig()
    for env, attr in (("VOCALIS_STREAM_RATE", "governor_rate"),
                      ("VOCALIS_BATCH_RATE", "batch_rate")):
        val = os.environ.get(env)
        if val:
            try:
                setattr(cfg, attr, float(val))
            except ValueError:
                logger.warning(f"{env}={val!r} is not a number — ignored")
    return cfg


def create_stream_blueprint(current_pool, nomi, stream_config_factory=_default_stream_config,
                            voice_dir=None, resolve_voice=None, st_registry=None,
                            render_active=None, model_ready=None,
                            output_dir=None, render_rate_key=None):
    """current_pool — vocalis_server.current_pool (auto-loads the default pool);
    nomi — the server's NomiSpeaker instance (voice map + MD5 cache);
    voice_dir — voice_samples/ dir, for the web-UI register route's explicit voices;
    resolve_voice — vocalis.runtime.voices.resolve_ref (stem -> Path), so the
    /v1 register route resolves voices EXACTLY like /v1/audio/speech;
    st_registry — StCharacterRegistry: the /v1 register's `character` key resolves
    voice+params through it (and auto-upserts unseen names);
    render_active / model_ready — 5.2's pre-render gate (gpu.GpuGate.render_active and
    pool.model_ready). Injected rather than imported: this module must not grow an edge
    into vocalis.runtime, and tests need to drive the gate directly. Both default to a
    permissive stub, which is what the /speak-only test apps want.

    6.0 adds two more injections, for the same reason and with the same rule:

    output_dir — a CALLABLE returning `book_to_audio.OUTPUT_DIR`, under which `output/scenes`
    lives. A callable rather than the path itself because OUTPUT_DIR is captured per importer
    and five test sites monkeypatch it; a value read at construction would freeze whichever
    binding happened to be live then. Defaults to reading it through the module at call time.

    6.3 REMOVED `enhance_scene` and `enhance_available`. A build lands the scene and stops;
    enhancing it is a verb on the Clips row (`POST /clips/scenes/<ref>/enhance`), where it claims
    ONE card through the GPU gate like the other five enhance callers. The injections existed
    only so this module could reach `runtime.enhancement` without importing it, and there is
    nothing left here to reach it for.

    render_rate_key — `() -> str`, the identity of THIS box's rendering configuration
    (`render_rate.key_for(gpu_name, cards, workers)`). Injected because building it needs
    `runtime.pool`'s device and worker resolution, which this module must not import. None ⇒
    `/v1/audio/scene/estimate` reports no build-time estimate at all, which is the same honest
    answer an unmeasured box gives — never a default with a disclaimer.

    """
    bp = Blueprint("vocalis_stream", __name__)
    registry, reg_lock = {}, threading.Lock()
    # 6.0 §3.1. Module-shaped exactly like `voices.py`'s `_DESIGN_JOBS`: a dict, a lock, and a
    # cap — not `runtime/jobs.JOBS`, whose `Job` is book/playground-shaped (docx, voice, params,
    # sections) and would be nine-tenths unused fields for a scene.
    scene_jobs, scene_lock = {}, threading.Lock()

    def scene_output_dir():
        import book_to_audio
        return output_dir() if output_dir is not None else book_to_audio.OUTPUT_DIR

    queue = prerender_mod.PrerenderQueue(
        current_pool, nomi,
        config_factory=stream_config_factory,
        gate=prerender_mod.make_gate(live_stream_count, render_active, model_ready))
    bp.prerender_queue = queue                   # test hook / server shutdown

    def _prune():
        # "live" entries are exempt: a long message can stream well past the TTL and
        # its token must survive for the documented post-completion re-GET (the
        # writer refreshes `created` and flips state to "done" when the tee lands).
        now = time.time()
        with reg_lock:
            for tok in [t for t, e in registry.items()
                        if now - e["created"] > STREAM_TTL_S and e["state"] != "live"]:
                del registry[tok]

    @bp.route("/speak/stream", methods=["POST"])
    def speak_stream_register():
        _prune()
        data = request.get_json(force=True, silent=True) or {}
        try:
            ctx = nomi.request_context(data)     # parse/resolve/key — SHARED with /speak
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        cached = cache_hit(ctx["cpath"]) and not ctx["force"]

        token = uuid.uuid4().hex
        with reg_lock:
            registry[token] = {**ctx, "gen_kwargs": nomi.gen_kwargs(ctx["cfg"]),
                               "created": time.time(), "state": "new"}
        logger.info(f"[{ctx['nomi_name']}] {ctx['key'][:8]}… stream registered "
                    f"({'HIT' if cached else 'MISS'}{'/FORCE' if ctx['force'] else ''})")
        resp = jsonify({"stream_url": f"/speak/stream/{token}",
                        "status_url": f"/speak/stream/{token}/status",
                        "cached": cached, "cache_key": ctx["key"]})
        resp.headers["X-Cache-Key"] = ctx["key"]
        return resp

    @bp.route("/webui/stream", methods=["POST"])
    def webui_stream_register():
        """Streaming register for the web UI's play points (Book-tab Audition and
        Playground Generate). Payload mirrors /playground/generate: {text, voice,
        exaggeration, cfg, temperature}; `turbo`/`gpus`/`seed` are accepted but
        IGNORED (turbo + seed died app-wide in 3.x; stale clients may still send
        them) — streaming always runs on the shared pool at INTERACTIVE priority.
        Ephemeral: no MD5 cache tee (playground text is unique).
        AUTH NOTE: deliberately NOT on the 2.x auth-guard exempt list — post-merge
        this route requires the login session cookie, which the same-origin web UI
        sends automatically. (See TODO_3x.md, web UI streaming.)"""
        _prune()
        data = request.get_json(force=True, silent=True) or {}
        text = str(data.get("text", "")).strip()
        if not text:
            return jsonify({"error": "empty text"}), 400
        # Same narrate-*actions* semantics as /playground/generate (default on).
        from tts_utils import filter_actions
        text = filter_actions(text, bool(data.get("narrate_actions", True)))
        if not text:
            return jsonify({"error": "no speakable text (nothing with a letter or "
                                     "digit in it is left)"}), 400
        vpath = None
        voice = str(data.get("voice", "")).strip()
        if voice:
            if voice_dir is None:
                return jsonify({"error": "voice selection unavailable"}), 400
            from pathlib import Path
            cand = Path(voice_dir) / Path(voice).name       # basename only: no traversal
            if not cand.suffix:
                cand = cand.with_suffix(".wav")
            if not cand.exists():
                return jsonify({"error": f"voice not found: {voice}"}), 400
            vpath = str(cand)

        def _num(key, default, lo, hi, cast=float):
            v = cast(data.get(key, default) or default)
            if not (lo <= v <= hi):
                raise ValueError(f"{key} out of range [{lo}, {hi}]")
            return v
        try:
            gen_kwargs = {"voice": vpath,
                          "exaggeration": _num("exaggeration", 0.5, 0, 3),
                          "cfg": _num("cfg", 0.5, 0, 1),
                          "temperature": _num("temperature", 0.8, 0, 3)}
        except (TypeError, ValueError) as exc:
            return jsonify({"error": str(exc)}), 400

        token = uuid.uuid4().hex
        with reg_lock:
            registry[token] = {"text": text, "gen_kwargs": gen_kwargs, "key": "",
                               "cpath": None, "force": False, "nomi_name": "webui",
                               "created": time.time(), "state": "new"}
        logger.info(f"[webui] stream registered ({len(text)} chars, "
                    f"voice={voice or 'default'})")
        return jsonify({"stream_url": f"/speak/stream/{token}",
                        "status_url": f"/speak/stream/{token}/status"})

    @bp.route("/v1/audio/stream", methods=["POST"])
    def v1_stream_register():
        """Register progressive MP3 streaming for the SillyTavern extension. The request mirrors /v1/audio/speech and adds character; model, response_format, and speed are accepted but ignored. Resolve voice from explicit input, character assignment, then configured default; use character settings or context defaults. Reuse the shared cache unless force requests a new render. The response source is cache, prerender, or render, and errors use the /v1 OpenAI response shape."""
        _prune()
        data = request.get_json(force=True, silent=True) or {}
        try:
            req = resolve_st_request(data, nomi=nomi, st_registry=st_registry,
                                     resolve_voice=resolve_voice)
        except StRequestError as exc:
            return exc.response()
        key, cpath, force = req["key"], req["cpath"], req["force"]
        cached = cache_hit(cpath) and not force

        entry = {"text": req["text"], "gen_kwargs": req["gen_kwargs"], "key": key,
                 "cpath": cpath, "force": force, "owner": req["owner"],
                 "nomi_name": req["character"] or "sillytavern",
                 # Marks this token as a speech render so the shared streamer applies the per-satellite `st_max_batch` limit.
                 "st_speech": True,
                 "created": time.time(), "state": "new"}
        if cached:
            source = "cache"
            queue.note_claim(key, attached=False, cpath=cpath)
        elif force:
            # A long-press (the extension's hold-to-re-render gesture) asks for a
            # DIFFERENT take of this exact text, so both of 5.2's shortcuts have to be
            # switched off for it. Attaching would hand back the speculative render of
            # the SAME text — precisely the take the user is trying to replace — and
            # because renders are unseeded, that IS the audio they already have: the
            # re-roll would appear to work and change nothing. So stand that
            # speculation down rather than race it to the same cache path, and preempt
            # any other job too. A forced click is the one case where the user is
            # certainly sitting there waiting.
            source = "render"
            queue.cancel(key)
            queue.preempt(except_key=key, except_cpath=cpath)
        else:
            # A speculative render of THIS text may already be in flight. Join it
            # rather than starting a second one — two renders of one message is the
            # regression 5.2 would otherwise ship. A click for any OTHER text
            # preempts the speculation instead: the user is waiting now.
            job = queue.attach(key, cpath)
            if job is not None:
                entry["attach_to"] = job
                source = "prerender"
            else:
                source = "render"
                queue.preempt(except_key=key, except_cpath=cpath)

        token = uuid.uuid4().hex
        with reg_lock:
            registry[token] = entry
        # No text preview, and no character/voice name: this fires on the SUCCESS path of
        # every SillyTavern stream, so it used to write 60 chars of each chat line — plus
        # who was speaking — into logs/vocalis.log. The cache key already identifies the
        # request uniquely for debugging, and it reveals nothing.
        logger.info(f"stream registered {key[:8]}… "
                    f"({'HIT' if cached else 'MISS'}{'/FORCE' if force else ''}, "
                    f"src={source}, {len(req['text'])} chars, "
                    f"voice={'set' if req['voice_set'] else 'NONE'} [{req['voice_src']}])")
        return jsonify({"stream_url": f"/speak/stream/{token}",
                        "status_url": f"/speak/stream/{token}/status",
                        "cached": cached, "cache_key": key, "source": source})

    @bp.route("/v1/audio/prerender", methods=["POST"])
    def v1_prerender_register():
        """Register speculative speech work using a request body byte-identical to /v1/audio/stream. force is accepted but ignored. Return cache_key, state, and queued; state is cached, playable, rendering, queued, or declined, where declined is not an error. Translate a running queue result through state_of so the client receives the rendering/playable vocabulary used by the audio-state endpoint."""
        data = request.get_json(force=True, silent=True) or {}
        try:
            req = resolve_st_request(data, nomi=nomi, st_registry=st_registry,
                                     resolve_voice=resolve_voice)
        except StRequestError as exc:
            return exc.response()
        state = queue.submit(req["key"], req["text"], req["gen_kwargs"], req["cpath"],
                             label=req["character"] or "sillytavern", owner=req["owner"])
        if state == "running":
            # The read-only twin, asked about the same key it just submitted: `playable` once
            # the governor has released a byte, `rendering` while it is still withholding.
            # The `or` is for the race where the job finishes between the two calls — the
            # honest fallback is the state it was in when `submit` looked.
            live, _ = queue.state_of(req["key"], req["cpath"])
            state = live or "rendering"
        return jsonify({"cache_key": req["key"], "state": state,
                        "queued": queue.queued_count()})

    @bp.route("/v1/audio/state", methods=["POST"])
    def v1_audio_state():
        """What the server HAS for these messages — read-only, batched (5.4).

        The SillyTavern extension colors each message's ▶ button from this: green cached,
        blue playable, yellow rendering/queued, orange nothing. Bodies are the same shape
        every other ST route takes, because the answer is only useful if it is about the
        key a click would actually look up.

        {"items": [{input, character, voice?, narrate_actions?}, …]}
          -> {"states": [{cache_key, state, detail}, …]}   — SAME ORDER, one per item

        state ∈ cached | playable | rendering | queued | none.

        🔴 STRICTLY READ-ONLY, and that is the whole reason this route exists instead of
        reusing /v1/audio/prerender. That route answers `cached` on a hit — which makes it
        look like a free probe — but on a MISS it queues a render. Pointing it at a chat
        load would speculatively render every message on screen (ST paints 100 at once by
        default), on a box the user may have wanted quiet. Nothing here submits, loads a
        model, touches the gate, or claims a hit.

        A bad item degrades to `none` with the reason in `detail` rather than failing the
        batch: one unspeakable message must not blank the colors of the other ninety-nine.

        DESIGN_5_4_BUTTON_STATE §5.2.
        """
        data = request.get_json(force=True, silent=True) or {}
        items = data.get("items")
        if not isinstance(items, list):
            return jsonify({"error": {"message": "'items' must be a list of request bodies",
                                      "type": "invalid_request_error"}}), 400
        if len(items) > MAX_STATE_ITEMS:
            # The DoS bound on an unauthenticated route, and deliberately above the 100 ST
            # paints in one go so the common case is always a single request. The client
            # chunks to it rather than relying on it (§6.1a).
            return jsonify({"error": {"message": f"at most {MAX_STATE_ITEMS} items per "
                                                 f"request ({len(items)} sent)",
                                      "type": "invalid_request_error"}}), 400
        states = []
        for item in items:
            if not isinstance(item, dict):
                states.append({"cache_key": None, "state": "none",
                               "detail": "not an object"})
                continue
            try:
                req = resolve_st_request(item, nomi=nomi, st_registry=st_registry,
                                         resolve_voice=resolve_voice, probe=True)
            except StRequestError as exc:
                states.append({"cache_key": None, "state": "none", "detail": exc.message})
                continue
            # Cache first, then the queue — the SAME order `submit` checks in, so the
            # color and the click can never disagree about which one wins.
            if cache_hit(req["cpath"]):
                states.append({"cache_key": req["key"], "state": "cached", "detail": None})
                continue
            # 🔴 Then LIVE renders, and only then the pre-render queue. Blue means "a render is
            # in progress and far enough along to play", and a render the user STARTED BY
            # CLICKING is the most visible one there is — but until 5.4-m4d this route could
            # only see the queue and the cache, so a click-started render reported `none`. The
            # button went orange while the audio played, which reads as "the server has nothing
            # for this" at the exact moment it has the most.
            identity = prerender_mod.request_identity(req["key"], req["cpath"])
            live = live_state_of(identity)
            if live is not None:
                states.append({"cache_key": req["key"], "state": live, "detail": "live"})
                continue
            state, detail = queue.state_of(req["key"], req["cpath"])
            states.append({"cache_key": req["key"], "state": state or "none",
                           "detail": detail})
        # No text preview, no character name, no per-item line: this route fires far more
        # often than any render route — once per chat open, per scroll-back and per poll —
        # so it is the LAST place a message preview belongs.
        return jsonify({"states": states})

    @bp.route("/v1/audio/prerender/cancel", methods=["POST"])
    def v1_prerender_cancel():
        """Drop speculative work whose reason to exist just went away: the message
        was swiped, deleted, or the chat changed. {cache_key} for one, {all: true}
        for every job this server has queued. Cancels running jobs too — the render
        aborts mid-chunk and its spool is discarded rather than promoted."""
        data = request.get_json(force=True, silent=True) or {}
        if data.get("all"):
            n = queue.cancel(None)
        else:
            key = str(data.get("cache_key", "")).strip()
            if not key:
                return jsonify({"error": {"message": "'cache_key' or 'all' is required",
                                          "type": "invalid_request_error"}}), 400
            n = queue.cancel(key)
        return jsonify({"canceled": n})

    @bp.route("/v1/audio/prerender/stats", methods=["GET"])
    def v1_prerender_stats():
        """The measurement surface. (hits + attached) / completed is the number that
        says whether pre-rendering was worth the GPU — see DESIGN_5_2_PRERENDER §5.
        Process-lifetime counters; they reset on restart, deliberately."""
        return jsonify(queue.stats())

    # ── 6.0: audio scenes ────────────────────────────────────────────────────────────────

    def _scene_or_404(job_id):
        with scene_lock:
            job = scene_jobs.get(job_id)
        if job is None:
            abort(404)
        return job

    def _scene_running_locked():
        """The build in flight, or None. 🔴 THE CALLER MUST ALREADY HOLD `scene_lock`.

        Split out so the one-at-a-time guard can test and claim in a SINGLE critical section —
        `scene_lock` is a plain Lock, so `_scene_running()` cannot be called from inside it.
        """
        for j in scene_jobs.values():
            if j.status in ACTIVE_SCENE:
                return j
        return None

    def _scene_running():
        """Read-only status view. ⚠️ Not the guard — see the POST route: by the time a caller
        acts on this answer another thread may have started a build."""
        with scene_lock:
            return _scene_running_locked()

    @bp.route("/v1/audio/scene", methods=["POST"])
    def v1_scene_create():
        """Accept title, optional owner/chat/source/gap_s, and an ordered items list whose entries use the shared speech request shape. Return 202 with job_id, item count, and skipped count; skip non-speakable items and reject concurrent builds with 409. Build the raw scene; enhancement is a separate Clips action. Use the shared resolver so message requests retain the same cache identity as streaming and prerender. Do not log user-supplied title or message content."""
        data = request.get_json(force=True, silent=True) or {}
        items = data.get("items")
        if not isinstance(items, list) or not items:
            return jsonify({"error": {"message": "'items' must be a non-empty list of "
                                                 "request bodies",
                                      "type": "invalid_request_error"}}), 400
        if len(items) > MAX_SCENE_ITEMS:
            # The bound accommodates long conversation ranges while rejecting unreasonable requests.
            return jsonify({"error": {"message": f"at most {MAX_SCENE_ITEMS} messages per "
                                                 f"scene ({len(items)} sent)",
                                      "type": "invalid_request_error"}}), 400
        title = str(data.get("title") or "").strip()
        if not title:
            # §5.1: the slug comes from the title, never from message content. With no title
            # there is nothing to name the file after that is safe to put in a filename.
            return jsonify({"error": {"message": "'title' is required — it names the scene, "
                                                 "and it is what the file is called",
                                      "type": "invalid_request_error"}}), 400
        # A FAST PATH ONLY — the authoritative check is under `scene_lock` below, next to the
        # registration. This one exists so an obviously-busy box answers 409 without first
        # resolving every message in the range, which for a long one is real work.
        busy = _scene_running()
        if busy is not None:
            return jsonify({"error": {"message": "a scene is already being built on this box",
                                      "type": "scene_busy", "job_id": busy.id}}), 409

        resolved, skipped = [], []
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                skipped.append({"i": i, "reason": "not an object"})
                continue
            try:
                req = resolve_st_request(item, nomi=nomi, st_registry=st_registry,
                                         resolve_voice=resolve_voice)
            except StRequestError as exc:
                skipped.append({"i": i, "mesid": item.get("mesid"), "reason": exc.message})
                continue
            # Carried, not derived: `mesid` is the manifest's hint for jumping back to the
            # message (§4). It is never the identity — that is `key`.
            req["mesid"] = item.get("mesid")
            resolved.append(req)
        if not resolved:
            return jsonify({"error": {"message": "nothing in that range had any speakable text",
                                      "type": "invalid_request_error"}}), 400

        job = scene_build.SceneJob(
            id=uuid.uuid4().hex[:12], title=title,
            owner=str(data.get("owner") or resolved[0]["owner"]),
            chat=str(data.get("chat") or ""),
            # §8: this route knows nothing about SillyTavern, and `source` is how a Nomi range
            # files into the same library without a second route to generalize later.
            source=str(data.get("source") or "st"),
            gap_s=scene_build.clamp_gap(data.get("gap_s", scene_build.DEFAULT_GAP_S)))
        # Enhancement is an explicit Clips action; scene creation stores the raw artifact and must not accept an ignored enhancement field.
        job.skipped = skipped
        with scene_lock:
            # Hold the check and registration in one critical section: message resolution happens before this point, so concurrent requests could otherwise both pass the earlier check and contend for the same pool.
            busy = _scene_running_locked()
            if busy is not None:
                return jsonify({"error": {"message": "a scene is already being built on this box",
                                          "type": "scene_busy", "job_id": busy.id}}), 409
            for finished in [j for j in scene_jobs.values()
                             if j.status in ("done", "failed", "canceled")][:-SCENE_JOBS_KEEP]:
                scene_jobs.pop(finished.id, None)
            scene_jobs[job.id] = job

        def _run():
            scene_build.build_scene(
                job, resolved, output_dir=scene_output_dir(),
                render_many=lambda group, cancel: scene_build.render_group_through_the_pool(
                    current_pool(), group, cancel, nomi=nomi,
                    config=stream_config_factory()),
                render_one=lambda item, cancel: scene_build.render_through_the_real_path(
                    current_pool(), item, cancel, nomi=nomi, config=stream_config_factory()),
                sample_rate=getattr(current_pool(), "sr", scene_build.DEFAULT_SR))

        try:
            threading.Thread(target=_run, daemon=True,
                             name=f"scene-{job.id}").start()
        except BaseException:                # no thread ⇒ no build ⇒ don't leave it "queued"
            with scene_lock:
                scene_jobs.pop(job.id, None)
            raise
        # Do not log the title, character names, or message text; those fields may contain user content. The generated job ID is sufficient for diagnostics.
        logger.info(f"scene build {job.id} started — {len(resolved)} messages, "
                    f"{len(skipped)} skipped, gap {job.gap_s}s")
        return jsonify({"job_id": job.id, "items": len(resolved),
                        "skipped": len(skipped)}), 202

    @bp.route("/v1/audio/scene/estimate", methods=["POST"])
    def v1_scene_estimate():
        """Estimate render wall time and resulting audio duration separately. Return total, cached, uncached, est_audio_s, and est_render_s. Use measured local render rates for uncached messages; derive cached duration from fixed-bitrate logical size through vault_fs. Return null for an unmeasured quantity rather than inventing a rate."""
        data = request.get_json(force=True, silent=True) or {}
        items = data.get("items")
        if not isinstance(items, list):
            return jsonify({"error": {"message": "'items' must be a list of request bodies",
                                      "type": "invalid_request_error"}}), 400
        if len(items) > MAX_SCENE_ITEMS:
            return jsonify({"error": {"message": f"at most {MAX_SCENE_ITEMS} messages per "
                                                 f"scene ({len(items)} sent)",
                                      "type": "invalid_request_error"}}), 400

        bits = int(str(MP3_BITRATE).rstrip("kK")) * 1000
        cached = uncached = skipped = 0
        cached_audio_s = cached_chars = uncached_chars = 0.0
        for item in items:
            if not isinstance(item, dict):
                skipped += 1
                continue
            try:
                # probe=True: an estimate is a passive glance. It must not register characters,
                # mkdir a cache shard per message, or warn once per unresolvable voice — the
                # same three side effects /v1/audio/state suppresses, for the same reason.
                req = resolve_st_request(item, nomi=nomi, st_registry=st_registry,
                                         resolve_voice=resolve_voice, probe=True)
            except StRequestError:
                skipped += 1                      # §9: counted, never silently dropped
                continue
            chars = len(req["text"])
            # 🔴 9.0.17: `cache_hit`, not bare existence — the estimate has to count exactly
            # what the BUILD will count. A stub too short to be audio is a miss to `scene_build`,
            # so counting it here as cached would have the bar say "3 were cached" about a range
            # the build then re-renders, and calibrate the speech rate against 0.02 s of nothing.
            st = vault_fs.stat(req["cpath"]) if cache_hit(req["cpath"]) else None
            if st is None:
                uncached += 1
                uncached_chars += chars
            else:
                cached += 1
                cached_chars += chars
                cached_audio_s += (st.size * 8.0) / bits
        n = cached + uncached
        gap_s = scene_build.clamp_gap(data.get("gap_s", scene_build.DEFAULT_GAP_S))
        gaps = max(0, n - 1) * gap_s

        # Characters per second of SPEECH, from this range's own cached entries.
        speech_rate = (cached_chars / cached_audio_s) if cached_audio_s > 0 else None
        est_audio_s = None
        if n and (uncached == 0 or speech_rate):
            est_audio_s = cached_audio_s + gaps + (
                (uncached_chars / speech_rate) if speech_rate else 0.0)

        # `None` all the way through when this box has never been measured — see the docstring.
        key = render_rate_key() if render_rate_key is not None else None
        rate = render_rate.get(key) if key else None
        est_render_s = None if rate is None else (uncached_chars / rate)
        return jsonify({
            "total": n, "cached": cached, "uncached": uncached, "skipped": skipped,
            "cached_audio_s": round(cached_audio_s, 1),
            "uncached_chars": int(uncached_chars),
            "gap_s": gap_s, "gap_total_s": round(gaps, 1),
            "speech_rate": round(speech_rate, 2) if speech_rate else None,
            "est_audio_s": round(est_audio_s, 1) if est_audio_s is not None else None,
            "render_rate": round(rate, 2) if rate else None,
            "est_render_s": round(est_render_s, 1) if est_render_s is not None else None,
        })

    @bp.route("/v1/audio/scene/<job_id>", methods=["GET"])
    def v1_scene_status(job_id):
        """Poll a build. Same shape as VoxCPM Generate (4.8-m2b), for the same reason: this
        takes minutes and the page must be able to show where it has got to.

        `ref` appears as soon as §3.5a step 1 lands — BEFORE `status` leaves "enhancing" — so
        the UI can offer the finished scene while the second pass is still running. A client
        that waits for "done" to show a play button throws that away."""
        return jsonify(_scene_or_404(job_id).as_dict())

    @bp.route("/v1/audio/scene/<job_id>/cancel", methods=["POST"])
    def v1_scene_cancel(job_id):
        """Stop a build.

        A cancel during the render or the concat is a real cancel — the partial concat is
        discarded, never promoted — but every message rendered so far stays in the speech cache,
        so re-running the same range resumes for free.

        6.3: there is no longer an enhance phase to cancel INTO. Canceling an enhancement is
        `POST /clips/scenes/enhance/<job_id>/cancel`, and it leaves the raw scene alone."""
        job = _scene_or_404(job_id)
        if job.status in ("done", "failed", "canceled"):
            return jsonify({"ok": True, "status": job.status})
        job.cancel.set()
        return jsonify({"ok": True, "status": job.status})

    @bp.route("/speak/stream/<token>/status", methods=["GET"])
    def speak_stream_status(token):
        """How a stream ended — the truncation check both clients run when playback
        stops: {"state": new|live|done|error|canceled|unknown, "error": str|null}.
        'done' = rendered to completion; 'error' = died mid-generation (playback was
        truncated); 'unknown' = token expired/never existed (can't verify)."""
        with reg_lock:
            entry = registry.get(token)
            if entry is None:
                return jsonify({"state": "unknown", "error": None})
            return jsonify({"state": entry["state"], "error": entry.get("error")})

    @bp.route("/speak/stream/<token>", methods=["GET"])
    def speak_stream_serve(token):
        _prune()
        with reg_lock:
            entry = registry.get(token)
            if entry is not None and entry["state"] == "new":
                entry["state"] = "live"
                claimed = True
            else:
                claimed = False
        if entry is None:
            return jsonify({"error": "unknown or expired stream token"}), 410

        cpath = entry["cpath"]                   # None for uncached (web-UI) streams
        # Cache hit: whole file, instantly. For a FORCE token the pre-existing file
        # is stale by definition — only serve once THIS token's regeneration has been
        # PROMOTED into the cache (atomic_replace landed), not merely when playback
        # finished. Keying on state=="done" let a re-GET in the window between "playback
        # done" and "new file promoted" serve the OLD audio (and a failed promote left it
        # 'done' forever); `promoted` flips only after promote_temp succeeds, so a re-GET
        # mid-regen falls through to 410 instead of serving stale.
        fresh_ok = (not entry["force"]) or entry.get("promoted", False)
        if cache_hit(cpath) and fresh_ok:
            with reg_lock:
                entry["state"] = "done"          # replays keep hitting this branch
            # The module-level `store_serve` import avoids a runtime import cycle and still routes cache hits through the vault-aware range-serving path.
            resp = send_store_file(cpath, mimetype="audio/mpeg")
            resp.headers["X-Cache-Key"] = entry["key"]
            return resp
        if not claimed:
            return jsonify({"error": "stream already started"}), 410

        # 5.2: this token JOINED a pre-render already in flight. No ffmpeg, no pool
        # batch, no cache tee — the producer owns all three. We follow its spool.
        job = entry.get("attach_to")
        if job is not None:
            return _serve_attached(token, entry, job)

        from tts_utils import GenParams, VocalisError
        params = GenParams(**entry["gen_kwargs"])   # the one true mapping (see register)
        try:
            pool = current_pool()               # auto-loads the default pool if cold
        except VocalisError as exc:
            with reg_lock:                      # un-burn the token: a transient
                if registry.get(token) is entry:  # unavailability must stay retryable
                    entry["state"] = "new"
            logger.warning(f"/speak/stream: model unavailable — {exc}")
            return jsonify({"error": f"model unavailable, try again: {exc}"}), 503

        # A custom source (playground) shares its Job's cancel Event, so BOTH paths —
        # the Stop button's /book/cancel POST and a client disconnect — stop the render.
        cancel = entry.get("cancel") or threading.Event()
        scfg = stream_config_factory()
        # Bound concurrent live streams. Cache HITS returned above never reach here, so
        # they don't consume a slot. Released in mp3_stream()'s finally (one per stream).
        if not _stream_slots.acquire(blocking=False):
            with reg_lock:                      # un-burn: retryable once a slot frees
                if registry.get(token) is entry:
                    entry["state"] = "new"
            logger.warning(f"/speak/stream at capacity ({MAX_CONCURRENT_STREAMS} "
                           "concurrent streams) — 503")
            return jsonify({"error": "server busy: too many concurrent streams, "
                                     "try again shortly"}), 503
        # Cache tee only for cacheable (Nomi/ST) streams; web-UI + playground streams
        # manage their own persistence. Since 3.x the tee captures the ENCODED MP3
        # bytes (in mp3_stream, as they ship) — the cached file is byte-identical to
        # what the listener heard, zero extra encode, ~4x smaller than the WAV cache.
        # 🔴 5.0-M6: THIS TEMP USED TO BE WRITTEN INSIDE THE CACHE DIRECTORY — i.e. inside the
        # vault. The tee writes the ENCODED MP3 frames to it in cleartext as they ship, so it is
        # the plaintext audio of every line a companion speaks, landing in the encrypted store.
        # It goes to the scratch; nomi.promote_temp() brings it back through the cipher.
        tmp = (scratch.scratch_root() / scratch.opaque_name(
                   f"speak-tee|{entry['key']}|{uuid.uuid4().hex}", ".mp3")
               if cpath is not None else None)
        if tmp is not None:
            tmp.parent.mkdir(parents=True, exist_ok=True)
        make = entry.get("make_stream")          # custom source (playground resume/bank)

        def on_finish(rstate, rerror):
            # Record how the stream ended — the /status truncation check reads this —
            # and always leave the "live" state so TTL pruning applies. Fires from the
            # writer thread's finally, exactly where it always did.
            with reg_lock:
                entry["state"], entry["error"] = rstate, rerror
                entry["created"] = time.time()   # status readable for a TTL window

        render = Mp3Render(pool, entry["text"], params, cancel=cancel, config=scfg,
                           make_stream=make, label="/speak/stream", on_finish=on_finish,
                           st_speech=bool(entry.get("st_speech")))
        try:
            render.start()                       # ffmpeg spawn: may fail (ffmpeg missing)
        except BaseException:                    # never started streaming — un-burn the token
            _stream_slots.release()
            with reg_lock:
                if registry.get(token) is entry:
                    entry["state"] = "new"
            raise
        _slot_taken()

        identity = prerender_mod.request_identity(entry["key"], entry["cpath"])
        _live_begin(identity)

        def mp3_stream():
            tee = open(tmp, "wb") if tmp is not None else None
            try:
                for block in render.blocks():
                    if tee is not None:
                        tee.write(block)
                    _live_shipped(identity)         # first block out == past the governor
                    yield block
            finally:
                render.close()                   # idempotent; blocks() already did it
                if tee is not None:
                    try:
                        tee.close()
                    except OSError:
                        pass
                # Promote AFTER the last encoded byte landed (ffmpeg EOF) — the writer
                # can't do this: it finishes before ffmpeg flushes its tail.
                if tmp is not None:
                    if render.promotable:
                        _promote_to_cache(entry, tmp, render.audio_s)
                    else:
                        tmp.unlink(missing_ok=True)
                # ⚠️ AFTER the promote, deliberately. Retiring the live entry first would open
                # a window in which the key is neither in flight nor yet in the cache, and a
                # poll landing in it would paint the button orange for a beat between blue and
                # green — the same stale-color lie in the other direction.
                _live_end(identity)
                _slot_freed()
                _stream_slots.release()          # free the concurrency slot (exactly once)

        headers = {"Cache-Control": "no-store"}
        if entry["key"]:
            headers["X-Cache-Key"] = entry["key"]
        from flask import Response
        return Response(mp3_stream(), mimetype="audio/mpeg", headers=headers)

    def _serve_attached(token, entry, job):
        """Serve a click that arrived while this text was ALREADY being pre-rendered:
        follow the producer's spool instead of starting a second render of the same
        message (DESIGN_5_2_PRERENDER §4.3).

        MP3 frames are self-contained, so a reader starting at byte 0 of a
        partially-written spool gets a valid progressive stream — the same property
        that lets the live path above tee to the cache. The listener therefore
        receives everything rendered so far AT WIRE SPEED and then follows the
        producer, which is the whole point: a click landing mid-render is faster than
        a cold one instead of twice as expensive.

        A follower takes a concurrency slot (it is a live stream, and the cap is the
        only bound on open connections) but never counts as a LIVE render — it is not
        generating anything, and counting it would make the pre-render dispatcher's
        idle gate false against its own producer."""
        if not _stream_slots.acquire(blocking=False):
            with reg_lock:
                if registry.get(token) is entry:
                    entry["state"] = "new"       # un-burn: retryable once a slot frees
            logger.warning(f"/speak/stream at capacity ({MAX_CONCURRENT_STREAMS} "
                           "concurrent streams) — 503")
            return jsonify({"error": "server busy: too many concurrent streams, "
                                     "try again shortly"}), 503

        def follow():
            try:
                for block in job.follow():
                    yield block
            finally:
                # The producer OUTLIVES its listener, deliberately (§4.3): the render
                # was going to happen regardless of this click, and killing it on a
                # detach would throw away work the next click wants. So there is no
                # cancel here — only the slot goes back.
                with reg_lock:
                    entry["state"] = job.state if job.state != "running" else "canceled"
                    entry["error"] = job.error
                    entry["created"] = time.time()
                _stream_slots.release()

        logger.info(f"stream attached {entry['key'][:8]}… to a pre-render in flight")
        headers = {"Cache-Control": "no-store", "X-Cache-Key": entry["key"]}
        from flask import Response
        return Response(follow(), mimetype="audio/mpeg", headers=headers)

    def _promote_to_cache(entry, tmp, audio_s):
        """Promote the incrementally-teed temp MP3 into the /speak MD5 cache (via
        the SHARED NomiSpeaker protocol), mark the token replayable, refresh TTL."""
        try:
            nomi.promote_temp(tmp, entry["key"], entry.get("owner"))
            with reg_lock:
                entry["state"] = "done"          # re-GETs now serve the fresh file
                entry["promoted"] = True         # FORCE tokens serve the cache only after THIS
                entry["created"] = time.time()   # fresh TTL for the replay window
            logger.info(f"[{entry['nomi_name']}] {entry['key'][:8]}… stream cached "
                        f"({audio_s:.1f}s)")
        except Exception:                        # noqa: BLE001 — tee must never kill anything
            logger.exception("/speak/stream cache promote failed")
            tmp.unlink(missing_ok=True)

    @bp.route("/webui/stream_player.js")
    def webui_stream_player_js():
        """The reusable stream-and-play helper for the web UI (see the file's
        header comment for usage). Served here so index.html can just
        <script src=\"/webui/stream_player.js\"> without a static route.

        📌 `no-cache` — store it, but revalidate before every use — set EXPLICITLY, matching the
        `/webui/js/` and `/webui/css/` trees (vocalis/web/ui.py). Left unset, this is the one asset
        on the page with no `Cache-Control` at all, and a validator with no directive means the
        browser applies HEURISTIC freshness: it invents a lifetime from `Last-Modified` and may
        serve this file for a while without asking. That is the stale-after-deploy failure the
        other route documents at length, arrived at by omission rather than by decision.
        """
        from pathlib import Path
        resp = send_file(Path(__file__).parent / "webui" / "vocalis_stream_player.js",
                         mimetype="application/javascript")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    def register_stream(entry: dict) -> str:
        """Server-side registration hook: enqueue a stream the built-in routes don't
        know how to build (the playground's resume/bank/finalize source, via
        entry["make_stream"](pool, cancel, cfg) and entry["cancel"]) and return its
        token. The entry rides the same registry / one-time-claim / TTL / /status
        machinery as every other stream; defaults below keep the GET handler's
        contract (no cache tee unless the entry sets cpath)."""
        _prune()
        token = uuid.uuid4().hex
        with reg_lock:
            registry[token] = {"text": "", "gen_kwargs": {}, "key": "", "cpath": None,
                               "force": False, "nomi_name": "custom",
                               "created": time.time(), "state": "new", **entry}
        return token

    bp.register_stream = register_stream         # used by vocalis_server's /playground/stream
    bp.vocalis_registry = registry               # test hook: inspect token states
    return bp
