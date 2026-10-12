"""Nomi uses a bearer token distinct from the SillyTavern pairing token.

The speak endpoints authenticate Nomi requests and may register unknown identities in settings, so both access and that persisted write require the Nomi-specific token. Keep its token and minted-open state in a separate settings section: the Nomi voice-map save replaces its entire section.

Route availability is covered by `test_auth_surface.py`; these tests cover channel isolation and storage behavior.
"""
import pytest

import voice_utils
from vocalis.runtime import paths
from wbedit import pairing


@pytest.fixture(autouse=True)
def _settings(tmp_path, monkeypatch):
    """A real settings file per test — these all read and write it."""
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    yield


# ── the two channels are genuinely independent ───────────────────────────────

def test_the_two_tokens_are_different_values():
    st, nomi = pairing.ST.rotate(), pairing.NOMI.rotate()
    assert st and nomi and st != nomi


def test_rotating_nomi_leaves_sillytavern_working():
    """🔴 THE ENTIRE REASON THIS IS A SECOND TOKEN. If one rotation revoked both, then revoking a
    leaked Nomi credential would also stop SillyTavern narration — and a revocation nobody can
    afford to perform is a revocation that does not happen."""
    st = pairing.ST.rotate()
    pairing.NOMI.rotate()
    assert pairing.ST.verify(st), "rotating Nomi revoked the SillyTavern token"


def test_rotating_sillytavern_leaves_nomi_working():
    nomi = pairing.NOMI.rotate()
    pairing.ST.rotate()
    assert pairing.NOMI.verify(nomi), "rotating SillyTavern revoked the Nomi token"


def test_each_channel_refuses_the_other_channels_token():
    """⚠️ NO CROSS-ACCEPTANCE, EVER. A "try the other token too" fallback would quietly merge the
    channels back into one and undo every isolation guarantee above. Pasting the SillyTavern token
    into the Nomi extension must fail exactly like pasting nothing."""
    st, nomi = pairing.ST.rotate(), pairing.NOMI.rotate()
    assert not pairing.NOMI.verify(st)
    assert not pairing.ST.verify(nomi)


def test_clearing_one_leaves_the_other():
    st = pairing.ST.rotate()
    pairing.NOMI.rotate()
    pairing.NOMI.clear()
    assert not pairing.NOMI.has_token()
    assert pairing.ST.verify(st)


# ── the storage trap that was caught before it shipped ───────────────────────

def test_the_token_is_not_stored_in_the_nomi_section():
    """The Nomi token belongs in its own settings section. The `nomi` voice-map save replaces that entire section from the request body, so storing the token beside `default_voice` would silently erase it. This assertion protects the separate storage boundary.
    """
    assert pairing.NOMI_SECTION != "nomi"
    pairing.NOMI.rotate()
    sec = voice_utils.get_section(paths.VOICE_SETTINGS, "nomi")
    assert not any("token" in str(k) for k in sec), sec


def test_saving_the_nomi_voice_map_does_not_destroy_the_token():
    """The behavioral half of the test above — the actual full-map replace, run for real."""
    token = pairing.NOMI.rotate()
    voice_utils.replace_section(paths.VOICE_SETTINGS, "nomi",
                                {"default_voice": "x.wav", "1234": {"name": "A", "voice": ""}})
    assert pairing.NOMI.verify(token), "saving the Nomi tab unpaired the extension"


def test_the_minted_open_flags_do_not_collide():
    """⚠️ BOTH TOKENS LIVE IN ONE SECTION, so a single shared `minted_without_auth` key would let
    either rotation clobber the other's state — and `revoke_if_minted_open` would then unpair the
    wrong client at boot."""
    assert pairing.MINTED_OPEN != pairing.NOMI_MINTED_OPEN
    assert pairing.ST.minted_key != pairing.NOMI.minted_key


# ── the shared verify contract, restated for the new channel ─────────────────

def test_an_unpaired_install_is_closed_not_open():
    """Without a token, Nomi requests are refused. Treating an uninitialized channel as an authentication bypass would leave the speak endpoints open.
    """
    assert not pairing.NOMI.has_token()
    assert not pairing.NOMI.verify("")
    assert not pairing.NOMI.verify("anything")


def test_the_token_is_long_enough_to_not_need_rate_limiting():
    """32 url-safe bytes. ⚠️ Do not shorten it to be "easier to type" — it is copied, never
    typed."""
    assert len(pairing.NOMI.rotate()) >= 40


def test_verify_observes_the_channels_own_get_token(monkeypatch):
    """Each channel's `verify` method must read through its own `get_token` accessor. Patching the module-level accessor must not affect either channel, and a test must not pass merely because both the fake and stored values happen to be empty.
    """
    monkeypatch.setattr(pairing.ST, "get_token", lambda: "patched-value")
    assert pairing.ST.verify("patched-value")
    assert pairing.verify("patched-value"), (
        "module-level verify() no longer observes ST.get_token — a monkeypatch of the channel "
        "would silently reach nothing")
    monkeypatch.setattr(pairing.NOMI, "get_token", lambda: "nomi-patched")
    assert pairing.NOMI.verify("nomi-patched")
    assert not pairing.NOMI.verify("patched-value"), "the channels observed each other"


def test_the_module_level_api_still_means_sillytavern():
    """The `Channel` extraction kept `pairing.verify` etc. as delegates to ST, because
    `vocalis_server`, `web/pair.py` and `web/wbedit.py` all call them. If that ever silently
    re-pointed at NOMI, every SillyTavern install would unpair at once."""
    st = pairing.rotate()
    assert pairing.get_token() == st == pairing.ST.get_token()
    assert pairing.verify(st) and not pairing.NOMI.verify(st)
