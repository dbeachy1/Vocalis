"""Browser coverage for SillyTavern character-list refresh while a chat is open. The test verifies the list updates without interrupting the active conversation."""
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import torch

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import tts_utils
from test_voices_player_browser import _chrome, NODE

SPEC = Path(__file__).parent / "st_characters_live_spec.mjs"
SR = 24000


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_character_appears_while_you_watch(tmp_path, monkeypatch):
    import vocalis.runtime.paths as rt_paths
    import vocalis_server as vs

    # One real voice so the inserted row's dropdown has something in it — an empty <select> is
    # indistinguishable from a row that never got wired.
    samples = tmp_path / "voice_samples"
    samples.mkdir()
    wav = (torch.sin(torch.linspace(0, 400, SR)) * 0.3).unsqueeze(0)
    tts_utils.save_wav_atomic(samples / "Narrator.wav", wav, SR)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", samples)

    # 🔴 THE REGISTRY IS BUILT AT IMPORT and captured the path it had THEN — conftest's
    # VOICE_SETTINGS pin repoints the constant, which this object has long since read. Left
    # alone, the POSTs below would register a test character into any voice_settings.yaml the host
    # was running. Repoint the instance, and empty it, so the spec starts from "no characters
    # yet" no matter what ran before it.
    reg = vs.app.blueprints["vocalis_st"].vocalis_st_registry
    monkeypatch.setattr(reg, "path", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(reg, "_chars", {})
    monkeypatch.setattr(reg, "_default", "")
    monkeypatch.setattr(reg, "_loaded", True)

    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=240)
    finally:
        srv.shutdown()
        t.join(timeout=10)

    assert r.returncode == 0, (
        "the SillyTavern character panel failed to refresh in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END. The exit code above cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. The floor is derived from the spec's own unconditional ok() calls, so there is no
    # constant here to go stale. See assert_spec_ran in conftest.py.
    assert_spec_ran(r, SPEC, floor=20)
    # The register is the source of truth the panel was polling — if it never saw the pushes,
    # a green spec would be meaningless.
    assert set(reg.all()) == {"Test Character 1", "Test Character 2", "Test Character 3", "Test Character 4"}, reg.all()
