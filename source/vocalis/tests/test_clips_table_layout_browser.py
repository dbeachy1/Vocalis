"""Browser coverage for Clips table column sizing.

The markup can contain every expected cell while automatic table layout still wraps timestamps,
stacks action controls, or leaves excessive gaps. This spec measures the rendered table at a real
browser viewport, including readable action rows at narrower widths. An optional screenshot helps
diagnose geometry failures; the test skips when Chrome or Node.js is unavailable.
"""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import scenes
import vault
import vault_store
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "clips_table_layout_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"


def _chrome():
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


def _seed_scene(root: Path, stem: str, title: str, origin: str):
    """A scene is an MP3 plus a manifest.

The bytes are fake and are never decoded; this spec needs no ffmpeg dependency.

`created` carries a full timestamp because its rendered width is part of the layout check. A short
date would not reproduce the wrapping behavior.
"""
    (root / f"{stem}.mp3").write_bytes(b"ID3 fake audio, never decoded by this spec")
    entries = [{"mesid": 400 + i, "character": 'Test Character 1', "cache_key": f"k{i}",
                "offset_s": i * 4.7, "duration_s": 4.0, "text": "A line of dialogue."}
               for i in range(5)]
    scenes.write_manifest(root / f"{stem}.yaml", {
        # 🔴 `owner`, NOT `chat` — `clip_sources` builds the row's From column from the
        # manifest's OWNER field ("st:Test User"), and a fixture that set `chat` produced three
        # identical 44px cells and a precondition that failed honestly rather than a spec that
        # passed vacuously.
        "title": title, "source": "st", "owner": origin, "chat": "a chat", "gap_s": 0.7,
        "created": "2026-08-23T04:32:48", "total_duration_s": 960.0, "entries": entries})


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_clips_table_does_not_squeeze_the_date_or_the_buttons(tmp_path, monkeypatch):
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
    # Patch output to a temporary directory before loading the page so it cannot enumerate
    # existing book renders.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    out = tmp_path / "output"
    import book_to_audio
    import vocalis.web.clips as clips_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", out)

    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    # Measure the short row beside a long outlier: automatic table layout sizes a column from
    # its widest cell, so similar rows would hide the wasted space this regression check detects.
    for i, (title, origin) in enumerate((('Test User', 'Test User'),
                                         ("Sample Story One",
                                          "the very long evening chat with Test Character 2 about the "
                                          "lighthouse and the tide tables"),
                                         ("Sample Story Two", "a chat"))):
        _seed_scene(root, f"scene{i}_ab12cd3{i}", title, origin)

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    shot = os.environ.get("VOCALIS_LAYOUT_SHOT")
    try:
        cmd = [NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome()]
        if shot:
            cmd += ["--shot", shot]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, ("the Clips table layout failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # A floor as well as the names below: the name list catches one check being dropped, and
    # cannot catch an early return, because the names are near the top by construction.
    assert_spec_ran(r, SPEC)

    for named in ("precondition: the row carries a real set of controls",
                  "precondition: one row's From really is long enough",
                  "the Built timestamp stays on ONE line",
                  "the From column is CAPPED",
                  "IS ellipsized, with a title",
                  "the slack goes to Name",
                  "the action buttons fit on at most two lines"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
