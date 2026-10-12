"""Own vault state, administrator credentials, and shared authentication checks.

Web routes live in `vocalis.web.auth`; other runtime modules use this module for vault, login,
credential-integrity, password, and CSRF state. Keep the Flask app outside this module: credential
application returns the session key for the caller to install. Credential read failures fail closed,
and vault storage is configured before any routed read.
"""
import hashlib
import os

import yaml
from loguru import logger
from werkzeug.security import check_password_hash, generate_password_hash

import vault_store
from tts_utils import atomic_replace

from vocalis.runtime import paths


# ── The vault store ───────────────────────────────────────────────────────────
# They share ONE keyfile and ONE DEK, and each keeps its OWN .vault_sentinel — so each proves
# independently that the keyfile belongs to IT. The cache root is registered as DERIVED, which
# relaxes exactly one case (a MISSING sentinel self-heals): `clear_cache` is a shipped feature,
# and a strict vault would turn `rm -rf ~/.cache/vocalis` into a permanent lockout of the whole
# store. SPEC_5_0_M6 §3.
# The root list is `vault_store.default_roots()`, not inlined here, so the OFFLINE MIGRATION
# (vault_migrate.py) walks the EXACT same stores the server encrypts — one definition, no drift
# (SPEC_5_0_M9 §7). It returns [("install", BASE_DIR), ("cache", cache_root())].
#
# 🔴 IT LIVES UP HERE, ABOVE THE FIRST ROUTED READ, AND THAT IS LOAD-BEARING. It used to sit
# ~1700 lines below, which put it AFTER `NOMI = NomiSpeaker(VOICE_SETTINGS, ...)` — and that
# constructor reads voice_settings.yaml. With no store configured yet, `route()` is inert by
# design, so the read fell through to a bare `Path.read_text()`.
#
# That was invisible for as long as the file's on-disk name was ciphertext: the cleartext path
# simply did not exist, `load_config` caught FileNotFoundError, and Nomi started with an empty
# config. The moment the name became STRUCTURAL the cleartext path DID exist — holding
# ciphertext — so the bare read got the raw bytes and died with UnicodeDecodeError at import,
# crash-looping the service before it could serve anything. Configure the store BEFORE anything
# can read through a seam, and import order stops being a correctness argument.
VAULT_KEYFILE = paths.DATA_DIR / "vault_keys.yaml"
STORE = vault_store.configure(vault_store.default_roots(), VAULT_KEYFILE)

# ── The vault (5.0-M5) ────────────────────────────────────────────────────────
# LOCKED at boot. Always. Two states that used to be one (design §5.1):
#
#   authenticated   a session cookie          SURVIVES a restart
#   unlocked        the DEK in this RAM       DOES NOT. Nothing in RAM does.
#
# Until the vault is INITIALIZED (no vault_keys.yaml) there is nothing to lock, and the lock
# gate is inert — Vocalis behaves exactly as it did in 4.x. That is not a soft-open: an
# uninitialized vault holds no key and guards no ciphertext. It is what lets 5.0 land on a
# box that has not migrated yet without bricking it.
#
# M6 registers the SECOND root: cache_root(). Vocalis's data lives in two places — the install
# root (output/, uploads/, voice_samples/, books/) and the OS cache dir (the enhanced audio, the
# render chunks, voiceswap_preview/, the rate stores, M4's song index). Design §7.7.1 ruled the
# cache is ENCRYPTED IN PLACE: it is full-band audio of the user's voices and the user's own
# unfiltered text, and "regenerable" was never the same claim as "not content".
#
LOCKED_BODY = {"error": "locked", "message": "Vocalis is locked. Log in to unlock."}


def vault_locked() -> bool:
    """True when the vault is initialized but its DEK is not in this process's RAM."""
    return STORE.is_initialized() and not STORE.is_unlocked()

ADMIN_CREDS_FILE = paths.DATA_DIR / "admin_credentials.yaml"


class CredentialsUnreadable(Exception):
    """admin_credentials.yaml exists but can't be parsed into a usable hash.

    This must NEVER be answered by degrading to "no password set". Doing so does not
    weaken auth, it DISABLES it: an empty hash makes auth_enabled() False, which makes
    `/` hand out a logged_in session to any visitor and lets an anonymous LAN caller POST
    themselves a new admin password. A corrupt file has to fail CLOSED."""


ADMIN_USER = "admin"
_ADMIN_HASH = ""
_CREDS_BROKEN = False        # tri-state: configured / deliberately-open / BROKEN

def _load_admin_creds() -> dict:
    """username + password_hash from admin_credentials.yaml.

    Returns {} only when the file is genuinely ABSENT — that is the deliberate,
    documented "open on the LAN" first-run state. A file that exists but is unreadable,
    or parses to something that is not a mapping, RAISES: those are the states that used
    to silently unauthenticate the whole app."""
    if not ADMIN_CREDS_FILE.is_file():
        return {}
    try:
        d = yaml.safe_load(ADMIN_CREDS_FILE.read_text(encoding="utf-8"))
    except Exception as exc:                                    # noqa: BLE001
        raise CredentialsUnreadable(f"admin_credentials.yaml is unparseable: {exc}") from exc
    if d is None:
        raise CredentialsUnreadable("admin_credentials.yaml is empty")
    if not isinstance(d, dict):
        raise CredentialsUnreadable(f"admin_credentials.yaml is not a mapping ({type(d).__name__})")
    if not str(d.get("password_hash") or ""):
        raise CredentialsUnreadable("admin_credentials.yaml has no password_hash")
    return d


def write_admin_creds(username: str, password: str) -> None:
    """Persist the credentials ATOMICALLY, and never world-readable, even briefly.

    The old writers did `write_text()` then `chmod(0o600)`. Two defects, and they compose
    with the loader:
      * NOT ATOMIC — a crash or a full disk mid-write leaves a TRUNCATED YAML, which is
        precisely the input that used to send _load_admin_creds down its fail-open path.
        The writer was manufacturing the trigger for the auth bypass.
      * chmod AFTER write — the file is created at 0666 & ~umask (the systemd unit sets no
        UMask), so it exists world-readable for a moment with the hash already in it, and
        anything that loses the race to chmod (it's wrapped in `except OSError: pass`)
        leaves it that way permanently.
    Write to a 0600 temp, then one atomic rename. The hash is never readable by anyone
    else, at any instant, and a torn write can never be observed."""
    doc = {"username": username, "password_hash": generate_password_hash(password)}
    ADMIN_CREDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = ADMIN_CREDS_FILE.with_suffix(".yaml.part")
    tmp.write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True), encoding="utf-8")
    try:
        tmp.chmod(0o600)                       # BEFORE the rename — no world-readable window
    except OSError:
        pass                                   # Windows/SMB: no POSIX modes to set
    atomic_replace(tmp, ADMIN_CREDS_FILE)


def apply_admin_creds() -> bytes:
    """(Re)load the YAML into memory and re-derive the session-signing key. Called at
    startup and after the gear writes new credentials, so a change takes effect live (no
    restart)."""
    global ADMIN_USER, _ADMIN_HASH, _CREDS_BROKEN
    try:
        d = _load_admin_creds()
        _CREDS_BROKEN = False
    except CredentialsUnreadable as exc:
        # Fail closed: gated routes remain enabled, but no password can authenticate until
        # the unreadable credential store is repaired.
        d, _CREDS_BROKEN = {}, True
        logger.error(f"ADMIN CREDENTIALS UNREADABLE — Vocalis is LOCKED, not open: {exc}")
        logger.error("Fix admin_credentials.yaml (or delete it to return to first-run) and restart.")
    ADMIN_USER  = str(d.get("username") or "admin")
    _ADMIN_HASH = str(d.get("password_hash") or "")
    # The signing key is derived from the password hash, so it rotates on a password
    # change and stays stable across restarts. With NO hash it used to fall back to
    # sha256("vocalis-session::open") — a world-known constant that anyone with the source
    # could use to forge a {"logged_in": true} cookie. There is no hash to key on in that
    # state, so use a fresh random key per boot instead: unforgeable, and it costs nothing
    # (an open server has no session worth preserving, and a broken one must not have one).
    # RETURNED, not assigned onto `app`: see the module docstring. The caller installs it.
    return (hashlib.sha256(("vocalis-session::" + _ADMIN_HASH).encode()).digest()
            if _ADMIN_HASH else os.urandom(32))


def auth_enabled() -> bool:
    """True when a login is REQUIRED. Note the `or _CREDS_BROKEN`: a credentials file we
    cannot read means auth is ON and unsatisfiable, never OFF."""
    return bool(_ADMIN_HASH) or _CREDS_BROKEN


def creds_broken() -> bool:
    return _CREDS_BROKEN


def password_ok(pw: str) -> bool:
    return (not _CREDS_BROKEN) and bool(_ADMIN_HASH) and check_password_hash(_ADMIN_HASH, pw or "")


def csrf_ok() -> bool:
    """True if the request carries the session's CSRF token in the X-CSRF-Token header.
    A cross-site page can't read the token (same-origin), so it can't forge the POST."""
    import secrets as _secrets
    from flask import request, session          # local, as in runtime/params.py
    tok = session.get("csrf")
    return bool(tok) and _secrets.compare_digest(str(request.headers.get("X-CSRF-Token", "")), str(tok))
