"""3.x: the tab-keyed voice_settings.yaml store (REFACTOR_VOICE_SETTINGS).

One file, one top-level section per tab — global/book/playground keyed by voice
filename, nomi by Nomi ID, sillytavern by character name. NO fallback between
tabs (a missing value is the chatterbox default), no runtime migration. Plus
the NomiSpeaker resolve() precedence (own entry -> chatterbox default) and the
carried-forward data-loss guard (corrupt file refuses writes).
"""
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import voice_utils                                          # noqa: E402
from nomi_speak import NomiSpeaker                          # noqa: E402


@pytest.fixture
def spath(tmp_path):
    return tmp_path / "voice_settings.yaml"


# ── layout: one top-level section per tab ───────────────────────────────────────

def test_sections_are_top_level_keyed_by_tab(spath):
    voice_utils.save_context_settings(spath, "v.wav", "book", {"cfg": 0.2})
    voice_utils.replace_section(spath, "nomi",
                                {"default_voice": "d.wav",
                                 "111": {"name": "TestNomi", "voice": "v.wav"}})
    raw = yaml.safe_load(spath.read_text(encoding="utf-8"))
    assert raw["book"]["v.wav"] == {"cfg": 0.2}
    assert raw["nomi"]["111"]["voice"] == "v.wav"
    assert raw["nomi"]["default_voice"] == "d.wav"


def test_contexts_are_independent_no_fallback(spath):
    voice_utils.save_context_settings(spath, "v.wav", "book", {"exaggeration": 1.5})
    assert voice_utils.get_context_settings(spath, "v.wav", "book")["exaggeration"] == 1.5
    # playground has no entry -> pure chatterbox defaults, NOT book's values
    pg = voice_utils.get_context_settings(spath, "v.wav", "playground")
    assert pg["exaggeration"] == voice_utils.CONTEXT_DEFAULTS["exaggeration"]
    assert voice_utils.get_context_section(spath, "v.wav", "playground") is None


def test_stale_turbo_key_ignored_per_context(spath):
    """turbo died app-wide (3.x): an incoming key is dropped and a stale stored
    one never leaks into the merged view."""
    voice_utils.save_context_settings(spath, "v.wav", "playground", {"turbo": True})
    assert "turbo" not in voice_utils.get_context_settings(spath, "v.wav", "playground")


def test_entity_sections_are_not_voice_contexts(spath):
    """nomi/sillytavern are entity-keyed sections with their own admin routes —
    the ?context= wire (and its save path) must reject them."""
    for ctx in ("nomi", "sillytavern", "global", "nope"):
        with pytest.raises(ValueError):
            voice_utils.save_context_settings(spath, "v.wav", ctx, {})
        with pytest.raises(ValueError):
            voice_utils.get_context_section(spath, "v.wav", ctx)


def test_get_section_rejects_unknown_and_defaults_empty(spath):
    with pytest.raises(ValueError):
        voice_utils.get_section(spath, "bogus")
    assert voice_utils.get_section(spath, "sillytavern") == {}   # no file yet


# ── flat wire shims (the /voices/<name>/settings contract) ─────────────────────

def test_flat_shim_roundtrip(spath):
    # `seed`/`engine` in the payload (pre-3.x clients) are ignored — never stored
    out = voice_utils.save_settings(
        spath, "v.wav", {"exaggeration": 1.1, "cfg": 0.4, "temperature": 0.9,
                         "seed": 3, "engine": "turbo"}, context="playground")
    assert "engine" not in out and "turbo" not in out and "seed" not in out
    got = voice_utils.get_settings(spath, "v.wav", "playground")
    assert got["exaggeration"] == 1.1 and "seed" not in got
    # book untouched
    assert voice_utils.get_settings(spath, "v.wav", "book")["exaggeration"] == 0.5


def test_flat_shim_defaults_when_unset(spath):
    got = voice_utils.get_settings(spath, "nobody.wav")
    assert "engine" not in got and got["exaggeration"] == 0.5
    assert got["advanced"] == voice_utils.DEFAULT_ADVANCED


def test_label_and_advanced_live_in_global_section(spath):
    voice_utils.save_settings(spath, "v.wav",
                              {"label": "Velvet", "advanced": {"min_p": 0.02},
                               "exaggeration": 0.7}, "book")
    raw = yaml.safe_load(spath.read_text(encoding="utf-8"))
    assert raw["global"]["v.wav"] == {"advanced": {"min_p": 0.02}, "label": "Velvet"}
    assert "label" not in raw["book"]["v.wav"]              # params only in the tab section
    assert voice_utils.get_labels(spath) == {"v.wav": "Velvet"}
    assert voice_utils.get_settings(spath, "v.wav", "playground")["advanced"] == {"min_p": 0.02}
    voice_utils.save_settings(spath, "v.wav", {"label": ""}, "book")   # clear = remove
    assert voice_utils.get_labels(spath) == {}


# ── NomiSpeaker: the `nomi` section, own-entry-or-default params ────────────────

def _mk_nomi(tmp_path, spath, entry=None, default_voice="v.wav"):
    (tmp_path / "voice_samples").mkdir(exist_ok=True)
    (tmp_path / "voice_samples" / "v.wav").write_bytes(b"RIFFfake")
    e = {"name": "TestNomi", "voice": "v.wav"}
    e.update(entry or {})
    voice_utils.replace_section(spath, "nomi", {"default_voice": default_voice, "1": e})
    return NomiSpeaker(spath, tmp_path / "voice_samples", tmp_path / "cache")


def test_nomi_own_entry_params_win(tmp_path, spath):
    cfg = _mk_nomi(tmp_path, spath,
                   entry={"exaggeration": 1.2, "cfg": 0.1}).resolve("1")
    assert cfg["exaggeration"] == 1.2 and cfg["cfg_weight"] == 0.1
    assert cfg["temperature"] == 0.8                        # unset -> chatterbox default


def test_nomi_unknown_id_gets_default_voice_and_defaults(tmp_path, spath):
    cfg = _mk_nomi(tmp_path, spath,
                   entry={"exaggeration": 1.2}).resolve("999", "Unknown")
    assert cfg["voice_filename"] == "v.wav"                 # default_voice
    assert cfg["exaggeration"] == 0.5                       # NOT TestNomi's 1.2 — no fallback
    assert cfg["narrate_actions"] is True


def test_nomi_name_match_for_group_chats(tmp_path, spath):
    cfg = _mk_nomi(tmp_path, spath, entry={"cfg": 0.3}).resolve("", "testnomi")
    assert cfg["cfg_weight"] == 0.3                         # matched by name, own params


def test_nomi_hot_reload_on_settings_save(tmp_path, spath):
    """A PUT-/nomi-style section replace is visible to /speak on the next
    request (reload_if_changed keys on the file's mtime)."""
    import os
    nomi = _mk_nomi(tmp_path, spath, entry={"exaggeration": 0.6})
    assert nomi.resolve("1")["exaggeration"] == 0.6
    voice_utils.replace_section(spath, "nomi",
                                {"default_voice": "v.wav",
                                 "1": {"name": "TestNomi", "voice": "v.wav", "exaggeration": 0.9}})
    st = spath.stat()
    os.utime(spath, (st.st_atime, st.st_mtime + 2))         # same-second saves still differ
    nomi.reload_if_changed()
    assert nomi.resolve("1")["exaggeration"] == 0.9


def test_nomi_entries_carry_no_seed(tmp_path, spath):
    """Rendering is seedless app-wide (3.x): resolve()/gen_kwargs never emit one,
    so cache keys stay byte-identical to the pre-3.x seed-0 format."""
    nomi = _mk_nomi(tmp_path, spath, entry={"exaggeration": 0.6})
    cfg = nomi.resolve("1")
    assert "seed" not in cfg
    assert "seed" not in nomi.gen_kwargs(cfg)


# ── data-loss guard: a corrupt settings file must not wipe every tab ────────────

def test_corrupt_settings_file_aborts_write_instead_of_wiping(spath):
    """A momentarily-unreadable voice_settings.yaml (hand-edit typo, encoding
    damage) plus any one save must RAISE, leaving the file intact — persisting
    from the empty map would wipe every tab's settings (review #62/#63)."""
    voice_utils.save_settings(spath, "keep.wav", {"exaggeration": 0.9, "label": "Keeper"}, "book")
    voice_utils.replace_section(spath, "nomi", {"default_voice": "keep.wav"})
    before = spath.read_text(encoding="utf-8")
    spath.write_text("this: is: not: valid: yaml: :\n  - [unclosed\n", encoding="utf-8")

    with pytest.raises(voice_utils.SettingsUnreadable):
        voice_utils.save_settings(spath, "new.wav", {"exaggeration": 0.5}, "playground")
    with pytest.raises(voice_utils.SettingsUnreadable):
        voice_utils.save_context_settings(spath, "new.wav", "book", {"cfg": 0.4})
    with pytest.raises(voice_utils.SettingsUnreadable):
        voice_utils.replace_section(spath, "sillytavern", {"default_voice": ""})
    # the corrupt file is untouched (not overwritten with an empty map)
    assert spath.read_text(encoding="utf-8") not in ("", before)

    # once the file is fixed, everything is still there (nothing was lost)
    spath.write_text(before, encoding="utf-8")
    assert voice_utils.get_labels(spath).get("keep.wav") == "Keeper"
    assert voice_utils.get_context_section(spath, "keep.wav", "book")["exaggeration"] == 0.9
    assert voice_utils.get_section(spath, "nomi")["default_voice"] == "keep.wav"
