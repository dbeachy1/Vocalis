'st_characters.py — SillyTavern character -> voice/params registry (3.x).\n\nThe ST analog of the Nomi voice map: characters live in the `sillytavern`\nsection of voice_settings.yaml (keyed by CHARACTER name; each entry carries its\n`voice` assignment + params + last_seen, with a sibling `default_voice`) and\nvoices are ASSIGNED FROM THE VOCALIS WEB UI — the ST extension only ever sends\ncharacter names. A missing param is the chatterbox default: no fallback to any\nvoice-level or other-tab settings.\n\nHow Vocalis learns about characters (two paths, both automatic):\n  * POST /v1/st/characters  {"characters": ["Test Character"]} — the extension fires\n    this when a chat opens, so a character is assignable (and auditionable)\n    BEFORE its first narration. Open + CORS\'d like all of /v1/*.\n  * every /v1/audio/stream request carries `character`, and the register\n    auto-upserts unseen names — group-chat members appear organically.\n\nAdmin surface for the web UI\'s SillyTavern tab — same shape as GET/PUT /nomi,\nand login-gated automatically because /st/* is not on the auth guard\'s exempt\nlist:\n  * GET /st/characters  -> {"characters": {...}, "voice_options": [...]}\n  * PUT /st/characters  {"characters": {name: {voice, exaggeration, cfg,\n        temperature}}} — full-map replace, values sanitized (incoming `seed`/\n        `turbo` keys — pre-3.x clients — are silently dropped).\n\nEntry semantics: an auto-registered character is {"voice": "", "last_seen": d}\n— unassigned, so speech falls through to the default voice; its params are the\nchatterbox defaults until the admin sets them.\n\nPersistence goes through voice_utils (the shared settings lock + strict\nloader): a corrupt voice_settings.yaml REFUSES writes instead of being\noverwritten with the empty in-memory map — the file survives for hand repair.\n'
import threading
import time
from pathlib import Path

from flask import Blueprint, jsonify, request
from loguru import logger

import vault_fs
import voice_utils

MAX_CHARACTERS = 500
MAX_NAME_LEN = 64

# numeric param -> (default used by callers, min, max, cast)
PARAM_SPECS = {
    "exaggeration": (0.5, 0.0, 3.0, float),
    "cfg":          (0.5, 0.0, 1.0, float),
    "temperature":  (0.8, 0.0, 3.0, float),
}


def _clean_name(name) -> str:
    name = str(name or "").strip()[:MAX_NAME_LEN]
    # `default_voice` is the section's one reserved (non-entry) key — a
    # character by that name would corrupt the layout.
    return "" if name == "default_voice" else name


def _clean_avatar(avatar) -> str:
    """Return the avatar filename as a leaf value suitable for use in a settings key. The avatar filename is the stable character identity; never preserve directory components."""
    return Path(str(avatar or "").strip()).name[:MAX_NAME_LEN]


def _split_incoming(raw) -> tuple[str, str]:
    'Accept either `"Test Character"` (every pre-m5b client) or `{"name", "avatar"}`.\n\n    📌 The string form is not deprecated and is not going away: `/v1/audio/stream` carries a bare\n    `character` from callers that are not our extension, and an old extension copy that has not\n    been re-installed keeps working exactly as it did.\n    '
    if isinstance(raw, dict):
        return _clean_name(raw.get("name")), _clean_avatar(raw.get("avatar"))
    return _clean_name(raw), ""


class StCharacterRegistry:
    """The `sillytavern` section of voice_settings.yaml, memory-backed: reads
    go through the in-memory map (loaded once, kept in sync by every mutation);
    every write rewrites the section via voice_utils.replace_section (atomic,
    under the shared settings lock, refused on a corrupt file).

    🔴 THE LOAD IS LAZY BECAUSE THE SERVER BOOTS LOCKED. vocalis_server builds this
    at module scope (line ~7433), AFTER vault_store.configure — so on an encrypted
    install the constructor's read routes into the vault and raises VaultLocked, and
    an eager load crash-loops the whole server under `Restart=always`: it can never
    come up to serve the unlock page that would let anyone in. Boot must tolerate a
    locked vault; the read happens on first use, once a password is in RAM.

    `_loaded` is what makes that SAFE, and it is load-bearing: this map is the whole
    section on every write. Loading empty-because-locked and then persisting would
    rewrite `sillytavern` from {} and DESTROY every character's voice assignment plus
    default_voice — and it would fire on the auth-EXEMPT /v1 routes (chat open, every
    stream register), so a normal unlock followed by SillyTavern opening a chat is all
    it takes. Unloaded therefore means: serve reads as empty, NEVER persist."""

    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._chars = {}
        self._default = ""
        self._loaded = False
        self._load()                     # tolerates a locked vault; retried on first use

    def _load(self):
        """Read the section into memory. Sets `_loaded` only on a real read — a
        locked vault leaves it False so the retry happens and no write can fire."""
        try:
            sec = voice_utils.get_section(self.path, "sillytavern")
        except vault_fs.locked_exc():
            logger.info("st characters: vault locked — deferring load until unlock")
            return
        self._default = str(sec.get("default_voice", "") or "")
        self._chars = {str(k): v for k, v in sec.items() if isinstance(v, dict)}
        self._loaded = True

    def _ensure_loaded_locked(self):
        """Call under self._lock before touching the map. Cheap once loaded."""
        if not self._loaded:
            self._load()

    def _save_locked(self):
        """Persist the in-memory map as the whole `sillytavern` section.
        Raises voice_utils.SettingsUnreadable when the file is corrupt — the
        caller decides whether that's a 500 (admin PUT) or a logged skip
        (auto-upsert on the open stream routes)."""
        if not self._loaded:
            # Backstop: every caller checks first. Writing here would persist an
            # empty map over the user's real section (see the class docstring).
            raise RuntimeError("refusing to save the sillytavern section before it "
                               "has been read — this would wipe it")
        voice_utils.replace_section(self.path, "sillytavern",
                                    {"default_voice": self._default, **self._chars})

    @property
    def default_voice(self) -> str:
        """The SillyTavern default voice — the fallback for characters with no
        assignment ('' = unset). '' while the vault is still locked."""
        with self._lock:
            self._ensure_loaded_locked()
            return self._default

    def set_default(self, voice) -> str:
        with self._lock:
            self._ensure_loaded_locked()
            prev = self._default
            self._default = Path(str(voice or "")).name if voice else ""  # leaf only
            try:
                self._save_locked()
            except Exception:
                self._default = prev            # keep memory == disk on failure
                raise
            return self._default

    def upsert_seen(self, names) -> int:
        """Register names (idempotent; never touches existing assignments —
        only refreshes last_seen). Returns how many were NEW. Fires on the open
        routes (chat open, every stream register), so a corrupt settings file
        must not 500 the stream: the save is skipped with an error log and the
        registration lives on in memory only."""
        today = time.strftime("%Y-%m-%d")
        added = 0
        with self._lock:
            self._ensure_loaded_locked()
            for raw in names or []:
                name, avatar = _split_incoming(raw)
                if not name:
                    continue
                key, entry = self._resolve_locked(name, avatar)
                if entry is None:
                    if len(self._chars) >= MAX_CHARACTERS:
                        logger.warning(f"st characters full ({MAX_CHARACTERS}); "
                                       f"not registering {name!r}")
                        continue
                    row = {"voice": "", "last_seen": today}
                    if avatar:
                        row["avatar"] = avatar
                    if key != name:
                        row["name"] = name        # the key had to differ; keep the real name
                    self._chars[key] = row
                    added += 1
                    continue
                # When a legacy name-only entry is first matched to an avatar, bind the avatar to that existing entry. This preserves its assigned voice and settings instead of creating an unassigned duplicate.
                if avatar and not entry.get("avatar"):
                    entry["avatar"] = avatar
                entry["last_seen"] = today
            if added or names:
                if not self._loaded:
                    # Vault still locked (these routes are auth-EXEMPT, so they
                    # fire before anyone logs in). Same disposition as a corrupt
                    # file: memory-only, never a 500 on the stream.
                    logger.warning("st characters: vault locked — registration held "
                                   "in memory, not persisted")
                else:
                    try:
                        self._save_locked()
                    except voice_utils.SettingsUnreadable:
                        logger.error("voice_settings.yaml is corrupt — character "
                                     "registration not persisted (fix the file)")
        return added

    def _resolve_locked(self, name: str, avatar: str) -> tuple[str, dict | None]:
        """Return (key, entry_or_None) for a character while the caller holds the lock and the registry is loaded. Prefer an exact avatar match, otherwise adopt an unbound legacy name entry, otherwise create a distinct key for a same-name character with a different avatar. Preserve the display name on collision."""
        if avatar:
            for k, e in self._chars.items():
                if isinstance(e, dict) and e.get("avatar") == avatar:
                    return k, e
        entry = self._chars.get(name)
        if isinstance(entry, dict):
            if not entry.get("avatar") or not avatar or entry.get("avatar") == avatar:
                return name, entry
            # Taken, by someone else. Key off the avatar — unique by construction over there.
            key = _clean_name(Path(avatar).stem) or avatar
            return key, self._chars.get(key)
        return name, None

    def lookup(self, name, avatar=None) -> dict | None:
        """⚠️ `avatar` is optional and the name-only path is unchanged. A caller that does not know
        the avatar (an old extension, a direct `/v1/audio/stream` request) resolves exactly as it
        always has — which is right for the overwhelmingly common case of one character per name.
        """
        with self._lock:
            self._ensure_loaded_locked()
            _, entry = self._resolve_locked(_clean_name(name), _clean_avatar(avatar))
            return dict(entry) if isinstance(entry, dict) else None

    def all(self) -> dict:
        with self._lock:
            self._ensure_loaded_locked()
            return {k: dict(v) for k, v in self._chars.items()}

    def replace(self, characters: dict) -> dict:
        """Full-map replace (PUT semantics, like /nomi). Sanitizes every entry;
        raises ValueError on out-of-range params. Preserves last_seen from the
        existing entry when the caller doesn't send one."""
        clean = {}
        for raw_name, e in (characters or {}).items():
            name = _clean_name(raw_name)
            if not name:
                continue
            if not isinstance(e, dict):
                raise ValueError(f"character {name!r} must be an object")
            voice = str(e.get("voice", "") or "")
            row = {"voice": Path(voice).name if voice else ""}   # leaf only: no traversal
            for key, (_, lo, hi, cast) in PARAM_SPECS.items():
                if key in e and e[key] not in (None, ""):
                    v = cast(e[key])
                    if not (lo <= v <= hi):
                        raise ValueError(f"{name}: {key} out of range [{lo}, {hi}]")
                    row[key] = v
            with self._lock:
                self._ensure_loaded_locked()
                old = self._chars.get(name) or {}
            row["last_seen"] = str(e.get("last_seen") or old.get("last_seen")
                                   or time.strftime("%Y-%m-%d"))
            # Carry avatar and display name from the stored entry, never from the request, so stale client state cannot change the character identity.
            for carried in ("avatar", "name"):
                if old.get(carried):
                    row[carried] = old[carried]
            clean[name] = row
        if len(clean) > MAX_CHARACTERS:
            raise ValueError(f"too many characters (max {MAX_CHARACTERS})")
        with self._lock:
            self._ensure_loaded_locked()
            prev = self._chars
            self._chars = clean
            try:
                self._save_locked()
            except Exception:
                self._chars = prev              # keep memory == disk on failure
                raise
        return self.all()


def create_st_blueprint(registry: StCharacterRegistry, voice_options=None):
    """voice_options — vocalis.runtime.voices.options, so GET returns the same
    {name, stem} list the Nomi admin tab uses (the ST tab's voice dropdown)."""
    bp = Blueprint("vocalis_st", __name__)

    @bp.route("/v1/st/characters", methods=["POST"])
    def st_characters_seen():
        """The extension's character push (chat opened). Open route: /v1/* rides
        the auth exemption + CORS. Upsert-only — it can never change or delete
        an assignment, so exposure is bounded (LAN posture, same as /speak)."""
        data = request.get_json(force=True, silent=True) or {}
        names = data.get("characters")
        if not isinstance(names, list):
            return jsonify({"error": {"message": "'characters' must be a list of names",
                                      "type": "invalid_request_error"}}), 400
        added = registry.upsert_seen(names)
        if added:
            logger.info(f"[sillytavern] registered {added} new character(s)")
        return jsonify({"registered": added})

    def _full():
        out = {"characters": registry.all(), "default_voice": registry.default_voice}
        if voice_options is not None:
            out["voice_options"] = voice_options()
        return out

    @bp.route("/st/characters", methods=["GET"])
    def st_characters_get():
        """Full map + default voice for the web UI's SillyTavern tab
        (login-gated: /st/* is not auth-exempt)."""
        return jsonify(_full())

    @bp.route("/st/characters", methods=["PUT"])
    def st_characters_put():
        data = request.get_json(force=True, silent=True) or {}
        chars = data.get("characters")
        if not isinstance(chars, dict):
            return jsonify({"error": "characters must be an object of {name: {...}}"}), 400
        try:
            out = registry.replace(chars)
            if "default_voice" in data:
                registry.set_default(data["default_voice"])
        except (TypeError, ValueError) as exc:
            return jsonify({"error": str(exc)}), 400
        except voice_utils.SettingsUnreadable as exc:
            return jsonify({"error": f"voice_settings.yaml is corrupt — refusing to save, "
                                     f"which would wipe other tabs ({exc}). Fix the file."}), 500
        except Exception as exc:                              # noqa: BLE001
            logger.exception("failed to write voice_settings.yaml")
            return jsonify({"error": f"could not save voice_settings.yaml: {exc}"}), 500
        result = _full()
        result["characters"] = out
        return jsonify(result)

    bp.vocalis_st_registry = registry                          # test hook
    return bp
