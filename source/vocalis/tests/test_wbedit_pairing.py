"""Tests World Book pairing and synchronization with SillyTavern."""
from __future__ import annotations

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import voice_utils
from vocalis.runtime import paths
from wbedit import pairing


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    return tmp_path


def test_there_is_no_token_until_one_is_minted(store):
    assert pairing.get_token() == ""
    assert pairing.has_token() is False


def test_rotating_mints_a_token_that_survives_a_reread(store):
    """It has to outlive a restart so it remains valid in the linked SillyTavern installation."""
    tok = pairing.rotate()
    assert len(tok) >= 40, "a 256-bit urlsafe token is ~43 characters"
    assert pairing.get_token() == tok and pairing.has_token() is True


def test_an_unpaired_vocalis_is_CLOSED_not_open(store):
    """Checks that an unpaired vocalis is closed not open."""
    assert pairing.verify("") is False
    assert pairing.verify("anything") is False
    assert pairing.verify(pairing.secrets.token_urlsafe(32)) is False


def test_verify_accepts_only_the_current_token(store):
    tok = pairing.rotate()
    assert pairing.verify(tok) is True
    assert pairing.verify(tok + "x") is False
    assert pairing.verify(tok[:-1]) is False
    assert pairing.verify("") is False


def test_rotation_revokes_the_previous_token_immediately(store):
    """Checks that rotation revokes the previous token immediately."""
    old = pairing.rotate()
    new = pairing.rotate()
    assert new != old
    assert pairing.verify(old) is False
    assert pairing.verify(new) is True


def test_clearing_unpairs_and_closes_the_door(store):
    tok = pairing.rotate()
    pairing.clear()
    assert pairing.has_token() is False
    assert pairing.verify(tok) is False


def test_verify_is_a_constant_time_comparison():
    """Checks that verify is a constant time comparison."""
    import inspect

    src = inspect.getsource(pairing.verify)
    # Everything after the closing triple-quote of the docstring — i.e. the code, only.
    body = src.split('"""')[-1]
    assert "compare_digest" in body, "the constant-time comparison is gone from the CODE"
    # ⚠️ Not a list of spellings to dodge — any bare equality on these two names is refused,
    # whatever the operator or the order. The old version pinned exactly two strings, so
    # `if current != presented: return False` sailed through it.
    import re
    assert not re.search(r"\b(current|presented)\b\s*[!=]=\s*\b(current|presented)\b", body), \
        "the token is compared with a bare equality operator"


def test_the_token_lands_in_the_vault_routed_settings_file_and_not_app_settings(store):
    """Checks that the token lands in the vault routed settings file and not app settings."""
    tok = pairing.rotate()
    assert voice_utils.get_section(paths.VOICE_SETTINGS, "wbedit")["pairing_token"] == tok


def test_the_wbedit_section_is_whitelisted():
    """`voice_utils` refuses an unknown section by design, so forgetting the whitelist entry
    turns every rotate into a ValueError at runtime rather than at import."""
    assert "wbedit" in voice_utils.SECTIONS


# ───────────────────────────── A.1 — a token minted while the server answered everyone

def test_a_token_minted_without_a_password_is_marked_as_published(store, monkeypatch):
    """Checks that a token minted without a password is marked as published."""
    from vocalis.runtime import auth
    monkeypatch.setattr(auth, "auth_enabled", lambda: False)
    pairing.rotate()
    assert voice_utils.get_section(paths.VOICE_SETTINGS, pairing.SECTION)[pairing.MINTED_OPEN]


def test_a_token_minted_with_a_password_carries_no_such_mark(store, monkeypatch):
    from vocalis.runtime import auth
    monkeypatch.setattr(auth, "auth_enabled", lambda: True)
    pairing.rotate()
    sec = voice_utils.get_section(paths.VOICE_SETTINGS, pairing.SECTION)
    assert pairing.MINTED_OPEN not in sec
    assert pairing.revoke_if_minted_open() is False, "an honest token must never be revoked"
    assert pairing.has_token() is True


def test_setting_a_password_revokes_a_token_that_was_published(store, monkeypatch):
    """Checks that setting a password revokes a token that was published."""
    from vocalis.runtime import auth
    monkeypatch.setattr(auth, "auth_enabled", lambda: False)
    published = pairing.rotate()
    assert pairing.verify(published) is True, "it works while the install is open"

    monkeypatch.setattr(auth, "auth_enabled", lambda: True)      # Authentication is enabled.
    assert pairing.revoke_if_minted_open() is True

    assert pairing.has_token() is False, "the published token survived a password being set"
    assert pairing.verify(published) is False, "the published token still authenticates"


def test_the_revocation_does_not_fire_while_the_install_is_still_open(store, monkeypatch):
    """Checks that the revocation does not fire while the install is still open."""
    from vocalis.runtime import auth
    monkeypatch.setattr(auth, "auth_enabled", lambda: False)
    tok = pairing.rotate()
    assert pairing.revoke_if_minted_open() is False
    assert pairing.verify(tok) is True


def test_the_revocation_is_idempotent(store, monkeypatch):
    """It runs on every unlock, not only the first."""
    from vocalis.runtime import auth
    monkeypatch.setattr(auth, "auth_enabled", lambda: False)
    pairing.rotate()
    monkeypatch.setattr(auth, "auth_enabled", lambda: True)
    assert pairing.revoke_if_minted_open() is True
    assert pairing.revoke_if_minted_open() is False, "it fired twice"

    fresh = pairing.rotate()                                     # re-paired, properly this time
    assert pairing.revoke_if_minted_open() is False, "it revoked a token minted under auth"
    assert pairing.verify(fresh) is True
