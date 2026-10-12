"""SillyTavern / OpenAI-compatible speech endpoint (2.1-M5).

No GPU: current_pool().speak is faked to return a silent wav tensor, so these
exercise the request contract, voice resolution, and wav/mp3 encoding without a
real model.
"""
import shutil

import pytest
import torch

import tts_utils
import vocalis_server
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.pool as rt_pool


@pytest.fixture
def client():
    with vocalis_server.app.test_client() as c:
        yield c


class _FakePool:
    """Stand-in for the shared WorkerPool: records speak() calls, returns silence."""
    def __init__(self, frames=2400):
        self.calls = []
        self.frames = frames

    def speak(self, text, params, priority=None, stall_timeout_s=None):
        self.calls.append({"text": text, "params": params, "priority": priority})
        return torch.zeros(1, self.frames), 24000


@pytest.fixture
def fake_pool(monkeypatch):
    pool = _FakePool()
    monkeypatch.setattr(rt_pool, "current_pool", lambda: pool)
    return pool


@pytest.fixture
def voice_dir(tmp_path, monkeypatch):
    d = tmp_path / "voice_samples"
    d.mkdir()
    (d / "testvoice.wav").write_bytes(b"RIFF")     # content irrelevant — speak is faked
    (d / "othervoice.mp3").write_bytes(b"ID3")
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", d)
    return d


def test_voices_lists_all_audio_stems(client, voice_dir):
    r = client.get("/v1/audio/voices")
    assert r.status_code == 200
    voices = r.get_json()["voices"]
    assert "testvoice" in voices and "othervoice" in voices          # wav AND mp3, by stem


def test_speech_empty_input_400(client, fake_pool):
    r = client.post("/v1/audio/speech", json={"input": "   ", "voice": "testvoice"})
    assert r.status_code == 400
    assert not fake_pool.calls                              # never reached the pool


def test_speech_unknown_voice_400(client, fake_pool, voice_dir):
    r = client.post("/v1/audio/speech", json={"input": "hello", "voice": "nobody"})
    assert r.status_code == 400
    assert "unknown voice" in r.get_json()["error"]["message"]


def test_speech_returns_wav(client, fake_pool, voice_dir):
    r = client.post("/v1/audio/speech",
                    json={"input": "Hello there.", "voice": "testvoice", "response_format": "wav"})
    assert r.status_code == 200
    assert r.content_type.startswith("audio/wav")
    assert len(r.data) > 44                                 # more than a bare WAV header
    assert fake_pool.calls[0]["text"] == "Hello there."
    assert fake_pool.calls[0]["priority"] == tts_utils.INTERACTIVE   # interactive, not batch


def test_speech_resolves_voice_by_stem(client, fake_pool, voice_dir):
    """A voice given by stem ('testvoice') resolves to testvoice.wav and is passed to speak."""
    r = client.post("/v1/audio/speech", json={"input": "hi", "voice": "testvoice"})
    assert r.status_code == 200
    assert fake_pool.calls[0]["params"].voice.endswith("testvoice.wav")


def test_speech_uses_chatterbox_defaults(client, fake_pool, voice_dir):
    """This OpenAI-shaped route carries no character and no knobs — params are
    the chatterbox defaults (3.x: no per-voice fallback; ST settings are
    per-character on the streaming path)."""
    client.post("/v1/audio/speech", json={"input": "hi", "voice": "testvoice"})
    p = fake_pool.calls[0]["params"]
    assert (p.exaggeration, p.cfg, p.temperature) == (0.5, 0.5, 0.8)


def test_speech_default_voice_when_none(client, fake_pool, voice_dir):
    """No voice → model default (params.voice is None); still generates."""
    r = client.post("/v1/audio/speech", json={"input": "hi"})
    assert r.status_code == 200
    assert fake_pool.calls[0]["params"].voice is None


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not on PATH")
def test_speech_returns_mp3(client, fake_pool, voice_dir):
    r = client.post("/v1/audio/speech",
                    json={"input": "Hello.", "voice": "testvoice", "response_format": "mp3"})
    assert r.status_code == 200
    assert r.content_type.startswith("audio/mpeg")
    assert len(r.data) > 100
