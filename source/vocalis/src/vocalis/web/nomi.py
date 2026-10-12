"""`/nomi/*` — the Nomi admin tab: the character→voice map and the default voice.

Three routes over `voice_settings.yaml`'s `nomi` section, plus the Chrome extension served as a
zip built on the fly (Chrome has offered no way to install an extension FROM a web page since
inline install died in 2018, so the zip plus drag-to-`chrome://extensions` is the whole install
story).

The speaker singleton itself is `runtime/nomi.py` — `/speak` in `web/speech.py` and
`create_stream_blueprint` both hold it, and a PUT here calls `load_config()` on that object so
the very next `/speak` reflects the edit.
"""
import io
import json
import zipfile
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

import voice_utils
from loguru import logger

from wbedit import pairing

from vocalis.runtime import auth
from vocalis.runtime import paths
from vocalis.runtime import voices as rt_voices
# Through the MODULE, never `from ... import NOMI`: the tests replace this
# singleton with a fixture speaker, and a direct import would give this file its
# own binding that the patch never reaches (5.1-P4.8; the rule §6.2 states).
from vocalis.runtime import nomi as rt_nomi

# The clamps the PUT applies to Nomi's three generation knobs. Here rather than in
# nomi_speak.py because they are a UI contract — what this route will accept — not a
# property of the speaker.
_NOMI_PARAM_RANGE = {"exaggeration": (0.0, 3.0), "cfg": (0.0, 1.0),
                     "temperature": (0.0, 3.0)}


def _nomi_section_view() -> dict:
    """{nomis, default_voice} from voice_settings.yaml's `nomi` section
    (default_voice is the one plain-string sibling of the id-keyed entries)."""
    sec = voice_utils.get_section(paths.VOICE_SETTINGS, "nomi")
    return {"nomis": {str(k): v for k, v in sec.items() if isinstance(v, dict)},
            "default_voice": str(sec.get("default_voice", "") or "")}


def create_nomi_blueprint() -> Blueprint:
    """No injected state — see web/comfyui.py."""
    bp = Blueprint("vocalis_nomi", __name__)

    @bp.route("/nomi/extension.zip")
    def nomi_extension_zip():
        """The Chrome extension, zipped on the fly from the repo source. Chrome offers
        no way to install an extension FROM a web page (inline install died in 2018;
        the Web Store is the only one-click path), so the Nomi tab pairs this download
        with Load-unpacked instructions. Entries sit under a folder prefix so unzipping
        always produces one clean directory."""
        import zipfile
        ext_dir = paths.CODE_DIR / "nomi" / "chrome_extension"
        if not (ext_dir / "manifest.json").exists():
            abort(404)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(ext_dir.rglob("*")):
                if f.is_file() and not f.name.startswith("."):
                    z.write(f, "vocalis-tts-for-nomi/" + f.relative_to(ext_dir).as_posix())
        buf.seek(0)
        try:
            ver = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8")).get("version", "")
        except Exception:
            ver = ""
        return send_file(buf, mimetype="application/zip", as_attachment=True,
                         download_name=f"vocalis-tts-for-nomi{('-' + ver) if ver else ''}.zip")


    # ── the Nomi pairing token (7.2-m4) ──────────────────────────────────────
    # This is the Vocalis-side token; the extension-side token lives in `nomi/chrome_extension`.

    #
    # 🔴 THREE ROUTES, MIRRORING `/wbedit/pairing` DELIBERATELY. Same shape, same verbs, same
    # `no-store`, same reasoning — because the next person to touch either should find one
    # pattern, not two. What is NOT shared is the token itself (`pairing.NOMI`, not
    # `pairing.ST`): two clients, two install paths, two independent rotations.
    #
    # ⚠️ These sit behind `_require_login` like every other non-`/speak` route, so a stranger
    # cannot read the credential they would need. That is the whole reason the gate on `/speak`
    # can be a bearer check and nothing more.

    def _nomi_pairing_body():
        return {"paired": pairing.NOMI.has_token(), "token": pairing.NOMI.get_token()}

    def _no_store(payload):
        # 🔴 Never cached. It is a credential in a response body.
        resp = jsonify(payload)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.get("/nomi/pairing")
    def nomi_pairing_get():
        """Return the Nomi token for the extension's Options page. This route requires an authenticated session and unlocked vault. The token is a secret and is returned only here."""
        if auth.vault_locked():
            return jsonify({"error": "the vault is locked — log in first"}), 423
        return _no_store(_nomi_pairing_body())

    @bp.post("/nomi/pairing/rotate")
    def nomi_pairing_rotate():
        """Mint a new Nomi token. 🔴 **This REVOKES the old one immediately** — Nomi narration
        stops until the new value is pasted into the extension, which is the point rather than a
        side effect. 📌 It does NOT touch the SillyTavern token; that isolation is the reason
        this is a second credential rather than a shared one."""
        if auth.vault_locked():
            return jsonify({"error": "the vault is locked — log in first"}), 423
        return _no_store({"paired": True, "token": pairing.NOMI.rotate()})

    @bp.delete("/nomi/pairing")
    def nomi_pairing_clear():
        """Unpair Nomi. Every `POST /speak` then fails closed — `Channel.verify` refuses an
        unconfigured install rather than waving it through, so clearing the token is a way to
        turn the channel OFF, not a way to reopen it."""
        if auth.vault_locked():
            return jsonify({"error": "the vault is locked — log in first"}), 423
        pairing.NOMI.clear()
        return _no_store({"paired": False, "token": ""})

    @bp.route("/nomi", methods=["GET"])
    def nomi_get():
        """Nomi voice map for the admin tab: {nomis, default_voice, voice_options}.
        voice_options lists ALL audio in voice_samples/ (wav + mp3 — Nomi refs
        include .mp3)."""
        out = _nomi_section_view()
        out["voice_options"] = rt_voices.options()
        return jsonify(out)


    @bp.route("/nomi", methods=["PUT"])
    def nomi_put():
        """Save the Nomi voice map: full-map replace of the `nomi` section in
        voice_settings.yaml (what you PUT is what's stored — the tab sends every
        row's name/voice/params/narrate_actions), then reload so /speak reflects it
        immediately. Voice values are sanitized to a leaf filename so a saved config
        can't point conditioning outside voice_samples/; params are range-checked."""
        data     = request.get_json(force=True, silent=True) or {}
        nomis_in = data.get("nomis")
        clean    = None
        if nomis_in is not None:
            if not isinstance(nomis_in, dict):
                return jsonify({"error": "nomis must be an object of {id: {name, voice}}"}), 400
            clean = {}
            for nid, e in nomis_in.items():
                if not isinstance(e, dict):
                    return jsonify({"error": f"nomi {nid!r} must be an object"}), 400
                voice = str(e.get("voice", "") or "")
                row = {"name": str(e.get("name", "")), "voice": Path(voice).name if voice else ""}
                for k, (lo, hi) in _NOMI_PARAM_RANGE.items():
                    if k in e and e[k] not in (None, ""):
                        try:
                            v = float(e[k])
                        except (TypeError, ValueError):
                            return jsonify({"error": f"nomi {nid!r}: {k} must be a number"}), 400
                        if not (lo <= v <= hi):
                            return jsonify({"error": f"nomi {nid!r}: {k} out of range "
                                                     f"[{lo}, {hi}]"}), 400
                        row[k] = v
                if e.get("narrate_actions") not in (None, ""):
                    row["narrate_actions"] = bool(e["narrate_actions"])
                clean[str(nid)] = row
        cur = _nomi_section_view()
        if clean is None:
            clean = cur["nomis"]                    # default_voice-only PUT
        default_voice = data.get("default_voice")
        default_voice = (Path(str(default_voice)).name if default_voice
                         else ("" if default_voice is not None else cur["default_voice"]))
        try:
            voice_utils.replace_section(paths.VOICE_SETTINGS, "nomi",
                                        {"default_voice": default_voice, **clean})
        except voice_utils.SettingsUnreadable as exc:
            return jsonify({"error": f"voice_settings.yaml is corrupt — refusing to save, "
                                     f"which would wipe other tabs ({exc}). Fix the file."}), 500
        except Exception as exc:                                    # noqa: BLE001
            logger.exception("failed to write voice_settings.yaml")
            return jsonify({"error": f"could not save voice_settings.yaml: {exc}"}), 500
        rt_nomi.NOMI.load_config()                                          # /speak reflects it now
        out = _nomi_section_view()
        out["voice_options"] = rt_voices.options()
        return jsonify(out)

    return bp
