"""Song-source routes shared by Stems and ACE-Step library management."""
import re

from flask import Blueprint, abort, jsonify, request

import folders
import vault_fs
import song_library
from store_serve import send_store_file
from vocalis.runtime import configs
from vocalis.runtime import paths
from vocalis.runtime.params import as_bool as _b


def create_song_library_blueprint() -> Blueprint:
    """Register the song shelf used by retained Stems workflows."""
    bp = Blueprint("vocalis_songs", __name__)

    @bp.route("/voiceswap/songs")
    def song_sources():
        rows = song_library.list_songs(configs.song_cfg())
        return jsonify(folders.for_rows(paths.FOLDERS.parent, "voiceswap_songs", rows))

    @bp.route("/voiceswap/songs", methods=["POST"])
    def upload_song():
        if "file" not in request.files:
            return jsonify({"error": "no file uploaded (form field 'file')"}), 400
        f = request.files["file"]
        try:
            row = song_library.save_upload(configs.song_cfg(), f.filename, f.stream)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(row)

    @bp.route("/voiceswap/songs/<source>/<fname>/audio")
    def song_audio(source, fname):
        p = song_library.song_path(configs.song_cfg(), f"{source}/{fname}")
        if p is None:
            abort(404)
        return send_store_file(p)

    @bp.route("/voiceswap/songs", methods=["DELETE"])
    def delete_uploaded_songs():
        cfg = configs.song_cfg()
        refs = (request.get_json(silent=True) or {}).get("refs") or []
        names = []
        for ref in refs:
            match = re.fullmatch(r"uploads/([^/\\]+)", str(ref))
            if not match:
                return jsonify({"error": "only uploaded songs can be deleted here"}), 400
            names.append((str(ref), match.group(1)))
        deleted = []
        for ref, name in names:
            p = cfg.songs_dir / name
            if vault_fs.exists(p) and p.suffix.lower() in song_library.AUDIO_EXTS:
                vault_fs.unlink(p)
                deleted.append(ref)
        return jsonify({"deleted": deleted})

    @bp.route("/voiceswap/songs/<source>/<fname>/favorite", methods=["POST"])
    def favorite_song(source, fname):
        ref = f"{source}/{fname}"
        stored = song_library.set_song_favorite(
            configs.song_cfg(), ref, _b(request.get_json(silent=True) or {}, "favorite"))
        if stored is None:
            return jsonify({"error": "song not found"}), 404
        return jsonify({"favorite": stored})

    return bp
