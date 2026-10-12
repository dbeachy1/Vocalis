"""`/v1/*` and `/speak` — the two integration endpoints nothing in our own UI calls.

SillyTavern drives `/v1/audio/speech` as an "OpenAI-compatible" TTS source; Nomi drives
`/speak`. Both render one whole response per request off the shared Chatterbox pool at
INTERACTIVE priority, so a book render never blocks live speech.

**Whole-file responses, not streaming, and that is not a shortcut.** ST splits a message into
paragraphs itself, requests them sequentially and plays in order, so a file per request already
gives the streaming experience with no reorder buffer to get wrong on either side.

⚠️ These two are the reason `runtime/voices.py` exists. `/v1/audio/voices` and `/speak` both
resolve a name through the voice registry, and neither is in the Voices tab's domain.
"""
import io
import subprocess

import numpy as np
from flask import Blueprint, jsonify, request, send_file

import vault_fs
import voice_utils
from loguru import logger
from store_serve import send_store_file
from tts_utils import INTERACTIVE, GenParams, VocalisError, save_wav_sf

from vocalis.runtime import params
from vocalis.runtime import pool as rt_pool
from vocalis.runtime import voices as rt_voices
# Through the MODULE, never `from ... import NOMI`: the tests replace this
# singleton with a fixture speaker, and a direct import would give this file its
# own binding that the patch never reaches (5.1-P4.8; the rule §6.2 states).
from vocalis.runtime import nomi as rt_nomi


def _wav_to_mp3_bytes(wav, sr) -> bytes:
    """Encode a wav tensor to mono 96 kbps MP3 bytes via ffmpeg. PIPED — pipe:0 → pipe:1.

    EVERY SillyTavern voice response used to round-trip through the OS temp dir: a WAV
    written out, ffmpeg run over it, an MP3 read back, both deleted. Every line of every
    chat, spoken aloud, landing as a plaintext file outside everything 5.0 encrypts — and
    the function ALREADY HAD the audio in memory and ALREADY WANTED bytes back. It needed no
    disk at all, in either direction. This is the case the design had in mind when it said a
    pipe is always acceptable: nothing lands at rest, so there is nothing to protect.

    The template is `vocalis_stream_http.py`'s live encoder, which has been doing exactly
    this since 3.x. We feed raw s16le rather than a WAV container because there is no
    container to write: the tensor IS the samples, and ffmpeg is told the rate and channel
    count on the command line instead of reading them out of a 44-byte header we would have
    had to synthesize."""
    import numpy as np
    arr = wav.detach().float().cpu().numpy()
    ch = 1
    if arr.ndim == 2:                                  # (channels, frames) → interleaved
        ch = arr.shape[0]
        arr = arr.T
    pcm = np.clip(arr.reshape(-1), -1.0, 1.0)
    raw = (pcm * 32767.0).astype("<i2").tobytes()
    r = subprocess.run(
        # The INPUT's channel count is declared honestly and the OUTPUT is forced to mono —
        # the same downmix `save_wav_sf` + `-ac 1` did. Declaring the input mono when it is
        # not would not downmix it, it would interleave two channels into one at double
        # speed. (Chatterbox is mono today; this must not become a trap when it isn't.)
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "s16le", "-ar", str(int(sr)), "-ac", str(ch), "-i", "pipe:0",
         "-ac", "1", "-f", "mp3", "-b:a", "96k", "pipe:1"],
        input=raw, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"mp3 encode failed: "
                           f"{r.stderr.decode('utf-8', 'replace').strip()}")
    return r.stdout


def create_speech_blueprint() -> Blueprint:
    """No injected state — see web/comfyui.py."""
    bp = Blueprint("vocalis_speech", __name__)

    @bp.route("/v1/audio/voices")
    def st_voices():
        """Voice list for OpenAI-compatible clients. NB: SillyTavern's OpenAI-compatible
        TTS provider does NOT call this (its voice list is typed manually in ST) — the
        names typed there must match these stems. Exposed for completeness/other clients."""
        return jsonify({"voices": [o["stem"] for o in rt_voices.options()]})


    @bp.route("/v1/audio/speech", methods=["POST"])
    def st_speech():
        """OpenAI-compatible TTS: {model, input, voice, response_format, speed}. Runs the
        text through the shared pool (chunks fan across cards, INTERACTIVE priority) and
        returns whole-file audio/wav or audio/mpeg. No cache (chat lines are unique)."""
        data = request.get_json(force=True, silent=True) or {}
        text = str(data.get("input", "")).strip()
        if not text:
            return jsonify({"error": {"message": "'input' text is required",
                                      "type": "invalid_request_error"}}), 400
        # Speak *action* spans by default; narrate_actions=false narrates the
        # dialogue only. (ST's own TTS settings may strip asterisks client-side
        # first — then this is a no-op.)
        from tts_utils import filter_actions
        text = filter_actions(text, bool(data.get("narrate_actions", True)))
        if not text:
            return jsonify({"error": {"message": "no speakable text (nothing with a letter "
                                                 "or digit in it is left)",
                                      "type": "invalid_request_error"}}), 400
        fmt = str(data.get("response_format", "wav")).lower()
        if fmt not in ("wav", "mp3"):
            fmt = "mp3" if fmt == "mpeg" else "wav"          # we serve wav + mp3; default wav
        voice_name = str(data.get("voice", "")).strip()
        voice_ref  = rt_voices.resolve_ref(voice_name)
        if voice_name and voice_ref is None:
            return jsonify({"error": {"message": f"unknown voice: {voice_name!r} — see GET /v1/audio/voices",
                                      "type": "invalid_request_error"}}), 400

        # Chatterbox defaults: this OpenAI-shaped route carries no character (ST
        # settings are per-CHARACTER now) and sends no knobs — no fallback to any
        # tab's tuned values. The extension's real path is /v1/audio/stream.
        d = voice_utils.CONTEXT_DEFAULTS
        params = GenParams(voice=str(voice_ref) if voice_ref else None,
                           exaggeration=float(d["exaggeration"]),
                           cfg=float(d["cfg"]),
                           temperature=float(d["temperature"]))
        try:
            wav, sr = rt_pool.current_pool().speak(text, params, priority=INTERACTIVE)
        except Exception as exc:                                    # OOM / failed chunk / stall
            logger.exception("SillyTavern /v1/audio/speech generation failed")
            return jsonify({"error": {"message": str(exc), "type": "server_error"}}), 500
        if wav is None:
            return jsonify({"error": {"message": "no synthesizable text",
                                      "type": "invalid_request_error"}}), 400
        if fmt == "mp3":
            try:
                body, mimetype = _wav_to_mp3_bytes(wav, sr), "audio/mpeg"
            except Exception as exc:                                # noqa: BLE001
                logger.exception("mp3 encode failed")
                return jsonify({"error": {"message": f"mp3 encode failed: {exc}",
                                          "type": "server_error"}}), 500
        else:
            buf = io.BytesIO()
            save_wav_sf(buf, wav, sr)
            buf.seek(0)
            body, mimetype = buf.read(), "audio/wav"
        return send_file(io.BytesIO(body), mimetype=mimetype, download_name=f"speech.{fmt}")


    @bp.get("/speak/ping")
    def speak_ping():
        """Check whether the Nomi extension address and token are valid without rendering audio. A ping must not occupy a GPU, write a cache entry, or register a character. It returns only whether the token was accepted and remains behind the normal login and vault gates."""
        return jsonify({"paired": True})

    @bp.route("/speak", methods=["POST"])
    def speak():
        # Request parsing / voice resolution / cache keying / the GenParams mapping and
        # the cache write all live on NomiSpeaker, SHARED with /speak/stream — the two
        # endpoints feed one MD5 cache and must never drift (see nomi_speak.py).
        data = request.get_json(force=True, silent=True) or {}
        try:
            ctx = rt_nomi.NOMI.request_context(data)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        key, cpath, force = ctx["key"], ctx["cpath"], ctx["force"]

        exists = vault_fs.exists(cpath)
        hit   = exists and not force
        label = "FORCE" if (force and exists) else ("HIT" if hit else "MISS")
        logger.info(f"[{ctx['nomi_name']}] {key[:8]}… {label}")
        if hit:
            # 5.0-M6: the MD5 audio cache is in the CACHE VAULT. cpath.read_bytes() is a
            # FileNotFoundError there, and the BytesIO gave no Range support anyway.
            resp = send_store_file(cpath, mimetype="audio/mpeg")
            resp.headers["X-Cache-Key"] = key
            return resp

        params = GenParams(**rt_nomi.NOMI.gen_kwargs(ctx["cfg"]))
        try:
            pool = rt_pool.current_pool()                     # auto-loads the default pool if unloaded
        except VocalisError as exc:                   # no workers loadable — genuine "can't serve"
            logger.warning(f"Nomi /speak: model unavailable — {exc}")
            return jsonify({"error": f"model unavailable, try again: {exc}"}), 503
        try:
            wav, sr = pool.speak(ctx["text"], params, priority=INTERACTIVE)
        except Exception as exc:                       # OOM / failed chunk / stall
            logger.exception("Nomi /speak generation failed")
            return jsonify({"error": str(exc)}), 500
        if wav is None:
            return jsonify({"error": "no synthesizable text"}), 400

        # `owner` scopes both the path and the eviction to this Nomi — without it the write
        # lands in the flat legacy tree and the cap is global again.
        rt_nomi.NOMI.store_wav(key, wav, sr, ctx["owner"])      # 96k mono MP3, atomic promote + evict

        resp = send_store_file(cpath, mimetype="audio/mpeg")
        resp.headers["X-Cache-Key"] = key
        return resp

    return bp
