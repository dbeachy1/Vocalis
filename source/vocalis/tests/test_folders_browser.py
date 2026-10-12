"""8.9 — virtual folders, driven in a REAL headless browser.

WHY, when `test_folders.py` covers the store, `test_folders_routes.py` covers the five routes and
`voices_ui_smoke.mjs` covers the renderer: because every one of those can be green while the page
is visibly broken. The smoke runs `renderVoiceList` in a bare `vm` with a stubbed `$` and NO CSS,
so it cannot see a folder row painted to zero height, a `✕` wrapped onto its own line, or a filing
that renders correctly and never reaches the server.

🔴 THE CHECK THIS FILE CARRIES IS PERSISTENCE ACROSS A RELOAD. A folder kept in the page's own
state passes every other assertion in the spec — it renders, it opens, it counts — and is gone the
moment he refreshes. Surviving a reload is the entire reason the store is server-side, and no
unit test can observe it.

📌 AND THE SECOND IS LAYOUT. `getBoundingClientRect()` is the only way to assert that the folder
name ellipses while the count and the buttons stay on the row — this project's recorded rule is
that a label never wraps, and the culprit is always a cell that was not `flex:0`. A class-name
assertion cannot see it; that is exactly how the 8.8.2 invisible-disclosure bug shipped.

Skipped, never failed, when Chrome or node is absent — a dev box without them must not turn the
suite red.
"""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import torch

# 📌 `bound_server` ALONE, AND NO SUPPRESSION. The neighboring browser drivers import
# `REPO_ROOT` too, purely for conftest's `sys.path` side effect, and then need a lint
# suppression for the unused name. Importing only the thing this file actually CALLS gets the
# same side effect — it is the module import that does it — with nothing to suppress.
from conftest import assert_spec_ran, bound_server

import tts_utils
import vault
import vault_fs
import vault_store
import vocalis.runtime.paths as rt_paths

SPEC = Path(__file__).parent / "folders_browser_spec.mjs"
NODE = shutil.which("node")

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


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_folder_survives_a_reload_and_deleting_it_keeps_the_voice(tmp_path, monkeypatch):
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

    # Two voices, so "the child opened under ITS folder" is a real claim rather than the only
    # row there was. Short on purpose — nothing here plays anything, and the streaming path is
    # `test_voices_player_browser`'s job.
    samples = install / "voice_samples"
    vault_fs.mkdir(samples)
    for name in ('Test_Voice_1.wav', 'Test_Voice_2.wav'):
        wav = (torch.sin(torch.linspace(0, 400, SR)) * 0.3).unsqueeze(0)
        tts_utils.save_wav_atomic(samples / name, wav, SR)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", samples)
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", install / "voice_settings.yaml")
    # 🔴 THE FOLDERS FILE IS AN INSTALL FILE, so it must land in the TEMP install or this test
    # writes a folder into the developer's own Vocalis — and nothing prunes it. `conftest` pins
    # `paths.FOLDERS` already; this is the same pin against the vault-backed install root this
    # test builds, which conftest's `tmp_path` root is not.
    monkeypatch.setattr(rt_paths, "FOLDERS", install / "folders.yaml")

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, ("virtual folders failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # 🔴 A FLOOR AS WELL AS THE NAMES ABOVE, BECAUSE THEY CATCH DIFFERENT THINGS. The name
    # list catches one check being dropped; it cannot catch an EARLY RETURN, because the names it
    # checks are near the top by construction and a spec that dies two thirds through still
    # satisfies every one. Derived from the spec's own unconditional ok() calls - no constant
    # here to go stale. See assert_spec_ran in conftest.py.
    # ⚠️ THE FLOOR IS THE UNCONDITIONAL COUNT, NOT THE 23 THIS SPEC EMITTED WHEN MEASURED.
    # 8 of its assertions sit behind a branch, so a slower box or a loaded run can emit
    # fewer and still be entirely correct. A floor pinned to a good run's number would fail
    # intermittently. A fixed count from a fast run would fail on slower or loaded runs; the floor
    # must hold on the worst run, not only the observed one.
    assert_spec_ran(r, SPEC, floor=15)

    # 🔴 A SPEC THAT SILENTLY STOPPED CHECKING EXITS 0 AS HAPPILY AS ONE THAT PASSED. Naming the
    # assertions here is what makes an early `return` or a renamed selector show up as a failure
    # rather than as a shorter, still-green run.
    for named in ("the ✚ Folder button exists",
                  "the folder is created server-side",
                  "the folder renders as a row in the list",
                  "the folder row has a real height",
                  "the folder row is ONE line tall",
                  "the actions stay INSIDE the row",
                  "reaches the SERVER",
                  "SURVIVES a reload",
                  "and it still counts the voice filed into it",
                  "IMMEDIATELY followed by a voice row",
                  "painted BELOW its folder",
                  "and the VOICE is still listed",
                  "no uncaught page errors"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
