"""Browser test for the Voices tab's shared audio player.

Markup assertions and Flask response tests cannot prove that browser media loads, seeks, and plays. This spec checks those behaviors through Chrome DevTools Protocol without npm dependencies.

Requires Node and Chrome; skips when either is unavailable."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import torch

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import tts_utils
import vault
import vault_fs
import vault_store
import vocalis.runtime.paths as rt_paths

SPEC = Path(__file__).parent / "voices_player_browser_spec.mjs"
NODE = shutil.which("node")

# Same cheap KDF the other vault tests use — argon2id at production settings would add seconds
# to a test whose point is entirely elsewhere.
TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"
SR = 24000


def _chrome() -> str | None:
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in ("chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(c)
        if found:
            return found
    for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              "/usr/bin/google-chrome", "/usr/bin/chromium"):
        if Path(c).exists():
            return c
    return None


# 🔴 Worker-banded, NOT bind-to-0 — the old local version released the port before Chrome
# could take it, and that race is what stopped the suite going wider than 12 workers.


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
# BOTH transports. The deployed box serves TLS and installs a custom bounded-handshake accept
# path (_bounded_tls_accept), and a streamed body is written to that socket in many small
# writes rather than one — so "works on plain HTTP" is not evidence that it works where it
# actually runs. `adhoc` needs cryptography, which the vault already depends on.
@pytest.mark.parametrize("tls", [False, True], ids=["http", "https"])
def test_the_voices_player_actually_plays_in_a_browser(tmp_path, monkeypatch, tls):
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    store = vault_store.configure([("install", install), ("cache", cache)],
                                  install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", store)
    store.create(PW)                                  # created => unlocked
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    import vocalis_server as vs
    monkeypatch.setattr(vs.vault_store, "STORE", store)

    # Two real, decodable WAVs through the vault — the spec needs a genuine duration, and a
    # second row to prove the one player MOVES rather than multiplying.
    #
    # 🔴 THE FIRST ONE IS MULTI-MEGABYTE ON PURPOSE. A 1-second sample is ~48 KB, which is
    # SMALLER than one 64 KB vault block, so the ranged reader yields it in a single chunk and
    # the multi-chunk streaming path — every real voice in the library — is never executed.
    # A fixture that small passes while the thing users actually click is broken.
    samples = install / "voice_samples"
    vault_fs.mkdir(samples)
    for name, seconds in (("Test Voice 1.wav", 140), ("Test Voice 2.wav", 1)):
        wav = (torch.sin(torch.linspace(0, 400 * seconds, SR * seconds)) * 0.3).unsqueeze(0)
        tts_utils.save_wav_atomic(samples / name, wav, SR)
    big = vault_fs.stat(samples / "Test Voice 1.wav").size
    assert big > 4 * 1024 * 1024, f"the fixture must span many 64 KB blocks, got {big} bytes"
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", samples)
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", install / "voice_settings.yaml")

    # Production sets this before building the server, and it reaches every ACCEPTED socket —
    # which is the whole point of it (see _bounded_tls_accept). A harness without it is not
    # serving under the same rules as the box.
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    # 🔴 THE PORT IS NEVER A NUMBER IN FLIGHT. `bound_server` binds port 0, so the OS picks the
    # number WHILE BINDING it and it is never in circulation unowned; `srv.server_port` reads it
    # back afterward. The alternative — ask for a free port, close the socket, then bind that
    # integer — has a gap in which anything on the machine can take the number, and the browser
    # then talks to a stranger. This file used to hand-roll `make_server` purely because
    # `bound_server` took no `ssl_context`; it does now, and this is the one harness serving TLS.
    srv = bound_server(vs.app, ssl_context="adhoc" if tls else None)
    port = srv.server_port
    if tls:
        # BOTH halves of the production accept path — the no-I/O accept and the
        # worker-thread handshake. Installing only `get_request` would hand the default
        # handler sockets it does not know to handshake.
        vs.wire_tls_accept(srv)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    scheme = "https" if tls else "http"
    try:
        r = subprocess.run([NODE, str(SPEC), f"{scheme}://127.0.0.1:{port}/",
                            _chrome(), "Test Voice 1.wav"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, (
        "the Voices player failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 AND IT RAN TO THE END. The exit code above cannot tell a pass from a spec that stopped
    # checking - an early return, a renamed selector or a deleted block exits 0 and is merely
    # SHORTER. The floor is derived from the spec's own unconditional ok() calls, so there is no
    # constant here to go stale. See assert_spec_ran in conftest.py.
    # ⚠️ THE FLOOR IS THE UNCONDITIONAL COUNT, NOT THE 21 THIS SPEC EMITTED WHEN MEASURED.
    # 16 of its assertions sit behind a branch, so a slower box or a loaded run can emit
    # fewer and still be entirely correct. A floor pinned to a good run's number would fail
    # intermittently, which would make the guard fail on valid runs and resemble the flakes this
    # work removed. The floor must hold on the WORST run, not the observed one.
    assert_spec_ran(r, SPEC, floor=5)
