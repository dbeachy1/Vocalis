"""Focused contract tests for the encrypted SillyTavern extension settings store."""

import json

import pytest

import ui_state
from vocalis.runtime import st_extension_settings as settings


def test_defaults_are_canonical_and_round_trip(tmp_path):
    defaults = settings.default_settings()
    assert defaults["schema_version"] == 1
    assert defaults["enabled"] is True
    assert defaults["immediate_send"] is True
    assert defaults["prompt"].strip()
    assert len(defaults["revision"]) == 64
    assert settings.decode(settings.encode(defaults)) == defaults

    saved = settings.save_settings({
        "schema_version": 1,
        "enabled": False,
        "immediate_send": False,
        "prompt": "Use U.S. spelling.",
    }, tmp_path / "ui_state.yaml")
    assert settings.load_settings(tmp_path / "ui_state.yaml") == saved


def test_editor_snapshot_includes_server_owned_defaults_without_changing_pair_snapshot():
    custom = settings.validate({
        "schema_version": 1,
        "enabled": False,
        "immediate_send": False,
        "prompt": "Custom prompt.",
    })
    editor = settings.editor_snapshot(custom)
    assert editor["prompt"] == "Custom prompt."
    assert editor["defaults"] == {
        "enabled": True,
        "immediate_send": True,
        "prompt": settings.DEFAULT_PROMPT,
    }
    assert "defaults" not in custom


def test_save_preserves_unrelated_ui_state_and_uses_one_encoded_key(tmp_path):
    path = tmp_path / "ui_state.yaml"
    ui_state.save(path, {"vocalis-sttab": "logs", "vocalis-pg-text": "preserve"})
    settings.save_settings({
        "schema_version": 1,
        "enabled": True,
        "immediate_send": True,
        "prompt": "A saved prompt.",
    }, path)
    state = ui_state.load(path)
    assert state["vocalis-sttab"] == "logs"
    assert state["vocalis-pg-text"] == "preserve"
    assert set(state) == {"vocalis-sttab", "vocalis-pg-text", settings.SETTINGS_KEY}
    encoded = json.loads(state[settings.SETTINGS_KEY])
    assert encoded["prompt"] == "A saved prompt."
    assert encoded["revision"] == settings.load_settings(path)["revision"]


def test_reset_persists_defaults_without_erasing_other_state(tmp_path):
    path = tmp_path / "ui_state.yaml"
    ui_state.save(path, {"vocalis-other": "keep"})
    restored = settings.reset_settings(path)
    assert settings.load_settings(path) == restored
    assert ui_state.load(path)["vocalis-other"] == "keep"


@pytest.mark.parametrize("payload", [
    None,
    [],
    {"schema_version": 1, "enabled": "yes", "immediate_send": True, "prompt": "x"},
    {"schema_version": 1, "enabled": True, "immediate_send": 1, "prompt": "x"},
    {"schema_version": 1, "enabled": True, "immediate_send": True, "prompt": "  "},
    {"schema_version": 1, "enabled": True, "immediate_send": True, "prompt": 7},
    {"schema_version": 1, "enabled": True, "immediate_send": True, "prompt": "x",
     "revision": "client-authored"},
    {"schema_version": 2, "enabled": True, "immediate_send": True, "prompt": "x"},
])
def test_write_validation_rejects_malformed_payloads(payload):
    with pytest.raises(settings.SettingsValidationError):
        settings.validate(payload)


def test_prompt_limit_is_utf8_bytes_and_read_corruption_uses_defaults(tmp_path):
    base = {"schema_version": 1, "enabled": True, "immediate_send": True}
    with pytest.raises(settings.SettingsValidationError):
        settings.validate({**base, "prompt": "é" * (settings.MAX_PROMPT_BYTES // 2 + 1)})

    path = tmp_path / "ui_state.yaml"
    ui_state.save(path, {settings.SETTINGS_KEY: "not-json"})
    assert settings.load_settings(path) == settings.default_settings()
