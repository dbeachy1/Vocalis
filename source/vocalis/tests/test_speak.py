"""Unified-server Nomi /speak (2.1-M2): voice-map config + MD5 cache on the shared
pool. No GPU — current_pool().speak is faked; the settings file / voice_samples /
cache are redirected to tmp_path. The Nomi map is the `nomi` section of
voice_settings.yaml (3.x).
"""
import pytest
import torch
import yaml

import vocalis_server
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.nomi as rt_nomi
import vocalis.runtime.pool as rt_pool
from tts_utils import VocalisError
from nomi_speak import NomiSpeaker


@pytest.fixture
def client():
    with vocalis_server.app.test_client() as c:
        yield c


class _FakePool:
    def __init__(self):
        self.n = 0

    def speak(self, text, params, priority=None, stall_timeout_s=None):
        self.n += 1
        return torch.zeros(1, 2400), 24000


def _write_settings(path, nomi_section):
    path.write_text(yaml.safe_dump({"nomi": nomi_section}), encoding="utf-8")


@pytest.fixture
def nomi_env(tmp_path, monkeypatch):
    vs = tmp_path / "voice_samples"; vs.mkdir()
    (vs / "testvoice.wav").write_bytes(b"x")
    settings = tmp_path / "voice_settings.yaml"
    _write_settings(settings, {"default_voice": "testvoice.wav",
                               "111": {"name": "TestVoice", "voice": "testvoice.wav"}})
    speaker = NomiSpeaker(settings, vs, tmp_path / "audio_cache")
    monkeypatch.setattr(rt_nomi, "NOMI", speaker)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", vs)
    pool = _FakePool()
    monkeypatch.setattr(rt_pool, "current_pool", lambda: pool)
    return speaker, pool


def test_speak_empty_text_400(client, nomi_env):
    r = client.post("/speak", json={"nomi_id": "111", "text": "   "})
    assert r.status_code == 400


def test_speak_miss_then_hit(client, nomi_env):
    _, pool = nomi_env
    payload = {"nomi_id": "111", "nomi_name": "TestVoice", "text": "Hello there."}
    r1 = client.post("/speak", json=payload)
    assert r1.status_code == 200 and r1.content_type.startswith("audio/mpeg")   # MP3 cache since 3.x
    key1 = r1.headers.get("X-Cache-Key")
    assert key1 and pool.n == 1
    r2 = client.post("/speak", json=payload)
    assert r2.status_code == 200
    assert r2.headers.get("X-Cache-Key") == key1
    assert pool.n == 1                          # second identical request served from cache


def test_speak_force_regenerates(client, nomi_env):
    _, pool = nomi_env
    payload = {"nomi_id": "111", "nomi_name": "TestVoice", "text": "Force me."}
    client.post("/speak", json=payload)
    assert pool.n == 1
    client.post("/speak", json={**payload, "force": True})
    assert pool.n == 2                          # force bypassed the cache


def test_speak_503_when_model_unavailable(client, nomi_env, monkeypatch):
    def boom():
        raise VocalisError("no workers could be loaded")
    monkeypatch.setattr(rt_pool, "current_pool", boom)
    r = client.post("/speak", json={"nomi_id": "111", "text": "unique 503 probe zzz"})
    assert r.status_code == 503


# ── NomiSpeaker unit ──────────────────────────────────────────────────────────

def _mk_speaker(tmp_path, nomi_section):
    vs = tmp_path / "vs"; vs.mkdir(exist_ok=True)
    settings = tmp_path / "voice_settings.yaml"
    _write_settings(settings, nomi_section)
    return NomiSpeaker(settings, vs, tmp_path / "cache")


def test_resolve_unknown_falls_back_to_default(tmp_path):
    sp = _mk_speaker(tmp_path, {"default_voice": "d.wav",
                                "1": {"name": "A", "voice": "a.wav"}})
    assert sp.resolve("999", "Unknown")["voice_filename"] == "d.wav"
    assert sp.resolve("1", "A")["voice_filename"] == "a.wav"
    assert sp.resolve("", "a")["voice_filename"] == "a.wav"     # group-chat name fallback


def test_resolve_params_own_entry_or_chatterbox_default(tmp_path):
    sp = _mk_speaker(tmp_path, {"default_voice": "d.wav",
                                "1": {"name": "A", "voice": "a.wav",
                                      "exaggeration": 0.75, "cfg": 0.3}})
    cfg = sp.resolve("1")
    assert cfg["exaggeration"] == 0.75 and cfg["cfg_weight"] == 0.3
    assert cfg["temperature"] == 0.8                        # unset -> chatterbox default
    # unknown Nomi: default voice, pure defaults (no fallback to 1's tuning)
    cfg = sp.resolve("2")
    assert cfg["voice_filename"] == "d.wav" and cfg["exaggeration"] == 0.5


def test_missing_settings_file_resolves_to_nothing(tmp_path):
    vs = tmp_path / "vs"; vs.mkdir()
    sp = NomiSpeaker(tmp_path / "voice_settings.yaml", vs, tmp_path / "cache")
    cfg = sp.resolve("1", "A")
    assert cfg["voice_filename"] == "" and cfg["exaggeration"] == 0.5


def test_cache_key_changes_with_text(tmp_path):
    sp = _mk_speaker(tmp_path, {"default_voice": "d.wav"})
    cfg = sp.resolve("x", "")
    assert sp.cache_key(cfg, "hello") != sp.cache_key(cfg, "world")
