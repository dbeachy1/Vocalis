"""vocalis/web/folders.py — the routes behind 8.9's virtual folders.

Five URLs over `folders.py`'s store, and they are deliberately dumb: every rule about names,
ids, caps, scopes and locking lives in the store, because ten listings reach this and a rule
enforced at the route is a rule the next caller can skip.

📌 `import folders` BELOW IS `src/folders.py`, NOT THIS FILE. Absolute imports mean a module
named `vocalis.web.folders` cannot shadow the top-level `folders` on `sys.path` — the same
arrangement `vocalis/web/stems.py` (`import stems`) and `vocalis/web/voices.py` already have.

🔴 NO AUTH DECORATORS HERE, AND THAT IS NOT AN OVERSIGHT. `_require_login` and
`_require_unlocked` are `app.before_request` gates (`vocalis_server.py:884-885`), so every rule
in every blueprint is gated by registration alone; `test_auth_surface` asserts exactly that,
rule by rule. Adding a local gate here would be a second, weaker copy of a thing that already
holds.

⚠️ THE VERBS ARE ABOUT LABELS AND NEVER ABOUT CONTENT. Nothing in this file can delete, move,
rename or even READ a song, a voice or a scene — the store holds no path. That is what makes
`DELETE /folders/<scope>/<fid>` a safe route to expose: the worst it can do is forget which
box something was in.
"""
from __future__ import annotations

from flask import Blueprint, jsonify, request

import folders
from vocalis.runtime import paths

# 🔴 A BOUND ON ONE REQUEST, WHICH THE STORE'S CAP DOES NOT PROVIDE. `MAX_ASSIGN_PER_SCOPE`
# bounds what ends up on disk; it does not bound the list a single POST may carry, and a JSON
# body is allowed up to 128 MB. This is the same gap `clip_favorites` had — a count cap read
# as if it were a size cap — caught here before it shipped rather than after.
MAX_REFS_PER_CALL = 5000


def create_folders_blueprint():
    bp = Blueprint("vocalis_folders", __name__)

    def _root():
        # Resolved per request, not captured: `paths.FOLDERS` is monkeypatched by the suite
        # (conftest `_pin_install_root`) and the blueprint is built once at import.
        return paths.FOLDERS.parent

    def _scope_or_400(scope):
        """`(scope, None)` or `(None, response)`. A closed set — see `folders.SCOPES`."""
        if scope not in folders.SCOPES:
            return None, (jsonify({"error": f"unknown list: {scope!r}"}), 400)
        return scope, None

    @bp.route("/folders/<scope>")
    def folders_list(scope):
        """This list's folders, in name order, and its assignment map.

        `{folders: [{id, name}, …], assign: {ref: folder_id}}`.

        The COUNTS are still not here: they depend on the rows the caller is showing, and the
        client already holds those. Counting from the assignment map would report stale
        entries — a `(12)` on a folder with four surviving items, wrong in the one direction
        that sends someone looking for what is missing. `folders.counts()` exists for a caller
        that has a listing in hand; this route does not.

        🔴 `assign` IS FOR THE PANEL WHOSE REF NO ROUTE CAN STAMP — see `folders.listing`. Voice
        Swap ▸ Sources merges five stores under refs the CLIENT composes (`stems/…`, `speech/…`,
        `pg/…`); `for_rows` never sees those strings, so the rows came back unfiled forever and
        `⇥ Move selected here` looked like a dead button. Reading it back is what makes the
        write visible. Every panel the server DOES key still uses `for_rows` and ignores this.
        """
        scope, bad = _scope_or_400(scope)
        if bad:
            return bad
        return jsonify(folders.listing(_root(), scope))

    @bp.route("/folders/<scope>", methods=["POST"])
    def folders_create(scope):
        """Make a folder. Body `{name}` → `{id, name}`."""
        scope, bad = _scope_or_400(scope)
        if bad:
            return bad
        name = str((request.get_json(silent=True) or {}).get("name", ""))
        if len(name) > folders.MAX_NAME_LEN * 4:
            # Rejected before the store sees it: `_norm_name` would truncate happily, and
            # silently accepting a 40 KB "name" as a 60-char one is the shape of surprise this
            # project keeps paying for. Generous multiple so trailing whitespace never 400s.
            return jsonify({"error": f"a folder name is at most {folders.MAX_NAME_LEN} characters"}), 400
        try:
            return jsonify(folders.create(_root(), scope, name))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except folders.FoldersUnreadable as exc:
            return jsonify({"error": f"the folders file will not parse, so nothing was written "
                                     f"(every other list's folders are still in it): {exc}"}), 500

    @bp.route("/folders/<scope>/<fid>", methods=["POST"])
    def folders_rename(scope, fid):
        """Rename a folder. Body `{name}` → `{id, name}`. No member moves — the id is the key."""
        scope, bad = _scope_or_400(scope)
        if bad:
            return bad
        name = str((request.get_json(silent=True) or {}).get("name", ""))
        if len(name) > folders.MAX_NAME_LEN * 4:
            return jsonify({"error": f"a folder name is at most {folders.MAX_NAME_LEN} characters"}), 400
        try:
            return jsonify(folders.rename(_root(), scope, fid, name))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except folders.FoldersUnreadable as exc:
            return jsonify({"error": f"the folders file will not parse, so nothing was written: {exc}"}), 500

    @bp.route("/folders/<scope>/<fid>", methods=["DELETE"])
    def folders_delete(scope, fid):
        """Remove a folder. Its members return to unfiled. `{deleted: bool}`.

        🔴 THE CLIENT'S CONFIRM MUST SAY THE CONTENTS ARE KEPT. This route cannot delete an
        item — it holds no path — but *"Delete folder 'Keepers' (12 items)?"* reads as
        delete-all to anyone who has used any other program, and being unable to do the
        frightening thing is no comfort to someone who thinks you just did.
        """
        scope, bad = _scope_or_400(scope)
        if bad:
            return bad
        try:
            return jsonify({"deleted": folders.delete(_root(), scope, fid)})
        except folders.FoldersUnreadable as exc:
            return jsonify({"error": f"the folders file will not parse, so nothing was written: {exc}"}), 500

    @bp.route("/folders/<scope>/assign", methods=["POST"])
    def folders_assign(scope):
        """Assign Library rows to a folder or return them to the unfiled section. Both the row action and drag-and-drop use this route; `folder: null` unfiles the selected rows."""
        scope, bad = _scope_or_400(scope)
        if bad:
            return bad
        body = request.get_json(silent=True) or {}
        refs = body.get("refs")
        if not isinstance(refs, list):
            return jsonify({"error": "`refs` must be a list"}), 400
        if len(refs) > MAX_REFS_PER_CALL:
            return jsonify({"error": f"at most {MAX_REFS_PER_CALL} rows in one move"}), 400
        fid = body.get("folder") or None
        try:
            moved = folders.assign(_root(), scope, refs, fid)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except folders.FoldersUnreadable as exc:
            return jsonify({"error": f"the folders file will not parse, so nothing was written: {exc}"}), 500
        return jsonify({"moved": moved, "folder": fid})

    return bp
