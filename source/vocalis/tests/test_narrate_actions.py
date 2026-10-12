"""3.0: narrate-*actions* on the machine speech paths (2.x handoff).

filter_actions itself is unit-tested in test_playground_clips.py; these cover
the WIRING: Nomi request_context (the per-Nomi flag in the entry, default ON;
filtered text keys the cache — ON/OFF can never collide) and the /v1 + /webui
stream registers (request-body flag, default on).
"""
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from nomi_speak import NomiSpeaker                          # noqa: E402

ACTION_TEXT = "*leans closer* Hello there. *waves warmly*"


def _mk_nomi(tmp_path, per_nomi=None):
    (tmp_path / "voice_samples").mkdir(exist_ok=True)
    (tmp_path / "voice_samples" / "v.wav").write_bytes(b"RIFFfake")
    entry = {"name": "TestNomi", "voice": "v.wav"}
    entry.update(per_nomi or {})
    (tmp_path / "voice_settings.yaml").write_text(
        yaml.safe_dump({"nomi": {"default_voice": "v.wav", "1": entry}}), encoding="utf-8")
    return NomiSpeaker(tmp_path / "voice_settings.yaml", tmp_path / "voice_samples",
                       tmp_path / "cache")


def test_nomi_default_speaks_actions_without_asterisks(tmp_path):
    ctx = _mk_nomi(tmp_path).request_context({"nomi_id": "1", "text": ACTION_TEXT})
    assert ctx["text"] == "leans closer Hello there. waves warmly"
    assert "*" not in ctx["text"]


def test_nomi_per_nomi_off_narrates_dialogue_only(tmp_path):
    nomi = _mk_nomi(tmp_path, per_nomi={"narrate_actions": False})
    ctx = nomi.request_context({"nomi_id": "1", "text": ACTION_TEXT})
    assert ctx["text"] == "Hello there."


def test_nomi_on_off_get_different_cache_keys(tmp_path):
    on = _mk_nomi(tmp_path).request_context({"nomi_id": "1", "text": ACTION_TEXT})
    off = _mk_nomi(tmp_path, per_nomi={"narrate_actions": False}).request_context(
        {"nomi_id": "1", "text": ACTION_TEXT})
    assert on["key"] != off["key"]                          # filtered text keys the cache


def test_nomi_pure_action_message_off_raises(tmp_path):
    nomi = _mk_nomi(tmp_path, per_nomi={"narrate_actions": False})
    with pytest.raises(ValueError, match="no speakable text"):
        nomi.request_context({"nomi_id": "1", "text": "*waves silently*"})


# ── stream registers (uses the shared app factory from test_stream_http) ───────

from test_stream_http import _mk_app, _registry             # noqa: E402


def _reg_text(client, reg):
    return _registry(client)[reg.get_json()["stream_url"].rsplit("/", 1)[1]]["text"]


def test_v1_stream_filters_actions_default_on(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream", json={"input": ACTION_TEXT})
    assert _reg_text(client, reg) == "leans closer Hello there. waves warmly"


def test_v1_stream_narrate_actions_false(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream",
                      json={"input": ACTION_TEXT, "narrate_actions": False})
    assert _reg_text(client, reg) == "Hello there."
    r = client.post("/v1/audio/stream",
                    json={"input": "*only actions*", "narrate_actions": False})
    assert r.status_code == 400
    assert "no speakable text" in r.get_json()["error"]["message"]


def test_v1_stream_takes_a_scene_break_out(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/v1/audio/stream",
                      json={"input": "He left.\n\n***\n\n0900 the next morning\n\nShe woke."})
    assert _reg_text(client, reg) == "He left. 0900 the next morning. She woke."
    r = client.post("/v1/audio/stream", json={"input": "***"})
    assert r.status_code == 400
    assert "no speakable text" in r.get_json()["error"]["message"]


def test_webui_stream_filters_actions(tmp_path, monkeypatch):
    client, _, _ = _mk_app(tmp_path, monkeypatch)
    reg = client.post("/webui/stream", json={"text": ACTION_TEXT, "voice": "v"})
    assert _reg_text(client, reg) == "leans closer Hello there. waves warmly"
    reg = client.post("/webui/stream", json={"text": ACTION_TEXT, "voice": "v",
                                             "narrate_actions": False})
    assert _reg_text(client, reg) == "Hello there."
