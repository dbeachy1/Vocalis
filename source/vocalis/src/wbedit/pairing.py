"""Bearer credentials for the SillyTavern extension and Nomi clients.

The SillyTavern token authenticates `/pair/*` and `/v1/*`; the Nomi token authenticates its
separate speech routes. These clients cannot rely on the UI session cookie for cross-origin
requests, so each channel uses an explicit bearer token. Tokens are independent: rotating one
revokes only that channel's previous value.

Tokens and their per-channel `minted_without_auth` flags are stored in the encrypted
`voice_settings.yaml` vault section. They are not stored in `app_settings.yaml` or derived from
the admin password. When a token was issued while admin authentication was disabled, the flag lets
startup revoke it after authentication is enabled; this requires the vault to be unlocked.

Verification uses constant-time comparison and fails closed when no token is configured. Paired
routes also require the vault to be open because they serve encrypted documents."""
from __future__ import annotations

import hmac
import secrets

import vault_fs  # noqa: F401  (imported for the locked-vault exception type at the call sites)
import voice_utils

from vocalis.runtime import paths

#: The settings section the SillyTavern token lives in. Added to `voice_utils.SECTIONS` alongside
#: `kobold`.
SECTION = "wbedit"
KEY = "pairing_token"

#: The Nomi client uses an independent token so revocation does not affect SillyTavern.
#: Both tokens share `wbedit` because `web/nomi.py::nomi_put` replaces the entire `nomi` section;
#: placing a token there would silently discard it on save. `wbedit` writers use read-modify-write
#: and do not return the section wholesale.
NOMI_SECTION = "wbedit"
NOMI_KEY = "nomi_pairing_token"

#: Each token shares the `wbedit` section but uses a separate flag, so rotating one channel cannot
#: alter the other channel's authentication-state record.
NOMI_MINTED_OPEN = "nomi_minted_without_auth"

#: Records whether this token was minted while admin authentication was disabled. Enabling
#: authentication does not otherwise rotate existing bearer tokens, so startup can use this flag
#: to revoke tokens issued under the open configuration.
MINTED_OPEN = "minted_without_auth"

#: Token entropy in bytes. `token_urlsafe` encodes this value for direct use in client settings.
#: Keep the 32-byte value to retain 256 bits of randomness.
TOKEN_BYTES = 32


class Channel:
    """One independently rotatable bearer credential backed by a vault section and key.

Each channel has its own token and `minted_without_auth` flag. The module-level functions below
remain delegates to the SillyTavern channel for existing callers; new callers can select
`ST` or `NOMI` explicitly."""

    def __init__(self, name: str, section: str, key: str, minted_key: str):
        self.name = name          #: for log lines and error messages — "sillytavern" / "nomi"
        self.section = section
        self.key = key
        #: ⚠️ Per-channel: ST and NOMI share the `wbedit` section, so ONE shared flag would
        #: let either rotation clobber the other's "was this minted on an open box?" state.
        self.minted_key = minted_key

    def _sec(self) -> dict:
        return voice_utils.get_section(paths.VOICE_SETTINGS, self.section)

    def get_token(self) -> str:
        """The current token, or `""` if none has been minted. Raises if the vault is locked."""
        v = self._sec().get(self.key)
        return v if isinstance(v, str) else ""

    def has_token(self) -> bool:
        return bool(self.get_token())

    def rotate(self) -> str:
        """Mint a fresh token, replacing any existing one, and return it.

        Replacing the stored value immediately revokes the previous token; requests presenting the
        old value fail on their next verification. There is no grace period."""
        sec = self._sec()
        sec[self.key] = secrets.token_urlsafe(TOKEN_BYTES)
        # See MINTED_OPEN. Deferred import: `runtime.auth` is a server module and this one is
        # imported by the pure-library tests, which have no app.
        # ⚠️ NAMED, NOT BLIND — `test_m5_boundaries.py` caps blind handlers in `src/` and it is AT
        # the cap; a bare `except Exception` here failed that guard, which is the guard working.
        # ImportError is the pure-library tests, which drive this module with no app at all;
        # AttributeError is a future `runtime.auth` that no longer offers the predicate. Anything
        # else is a real fault and must not be silently read as "this install has a password".
        try:
            from vocalis.runtime import auth
            open_install = not auth.auth_enabled()
        except (ImportError, AttributeError):
            open_install = False                             # no auth module -> not a server
        if open_install:
            sec[self.minted_key] = True
        else:
            sec.pop(self.minted_key, None)
        voice_utils.replace_section(paths.VOICE_SETTINGS, self.section, sec)
        return sec[self.key]

    def revoke_if_minted_open(self) -> bool:
        """Revoke a token issued while admin authentication was disabled, once authentication is enabled.

Returns `True` when a token was removed. Called after admin credentials load. Reading the recorded
flag requires the vault to be unlocked; vault errors propagate to the caller."""
        sec = self._sec()
        if not sec.get(self.minted_key):
            return False
        from vocalis.runtime import auth
        if not auth.auth_enabled():
            return False                                     # still open — nothing has changed
        sec.pop(self.key, None)
        sec.pop(self.minted_key, None)
        voice_utils.replace_section(paths.VOICE_SETTINGS, self.section, sec)
        return True

    def clear(self) -> None:
        """Forget the token entirely — unpair. Every paired request then fails closed."""
        sec = self._sec()
        sec.pop(self.key, None)
        voice_utils.replace_section(paths.VOICE_SETTINGS, self.section, sec)

    def verify(self, presented: str) -> bool:
        """Return whether `presented` matches the current token.

        Use `hmac.compare_digest` to avoid leaking matching-prefix length through timing. An
        empty or unconfigured token always fails, and verification checks only this channel's
        credential."""
        current = self.get_token()
        if not current or not presented:
            return False
        return hmac.compare_digest(current, presented)


#: The SillyTavern channel — `/pair/*` and `/v1/*`. Storage slot unchanged since 7.0-m2.
ST = Channel("sillytavern", SECTION, KEY, MINTED_OPEN)

#: The Nomi channel — `POST /speak` and `POST /speak/stream` (7.2-m4).
NOMI = Channel("nomi", NOMI_SECTION, NOMI_KEY, NOMI_MINTED_OPEN)


# ── Module-level API: the SillyTavern channel, unchanged ─────────────────────────────────────
# Compatibility delegates retained for existing SillyTavern call sites. New callers should
# select a channel explicitly (`ST` or `NOMI`).
get_token = ST.get_token
has_token = ST.has_token
rotate = ST.rotate
clear = ST.clear
verify = ST.verify
revoke_if_minted_open = ST.revoke_if_minted_open
