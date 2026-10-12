"""Browser coverage for the enhancement queue layout.

The queue markup can be correct while flex sizing makes its message or cards difficult to read.
This spec checks the rendered vertical list, alignment, scroll region, and removal controls with
a queue held in a representative busy state. The fixture avoids starting enhancement work, and an
optional screenshot helps diagnose geometry failures. The test skips when Chrome or Node.js is
unavailable.
"""
import json
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

# ⚠️ NO `REPO_ROOT` AND NO `# noqa`. Both were here at 9.5.6 and neither was earned: the file
# never mentions REPO_ROOT again, and importing conftest at all is what puts `src/` on sys.path
# for the five imports below — the side effect the suppression claimed to be protecting belongs
# to the module, not to that name. Left as it was, it pushed the tree-wide suppression ratchet
# and the F401 ceiling one over each, so `main` has been red on both since that commit.
from conftest import assert_spec_ran, bound_server

import scenes
import ui_state
import vault
import vault_store
import vocalis.runtime.settings as rt_settings

SPEC = Path(__file__).parent / "clips_queue_layout_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

# 🔴 FOURTEEN, BECAUSE THAT IS WHAT THE SCREENSHOT HELD AND BECAUSE FOUR WOULD CERTIFY THE BUG AS
# FIXED. The two defects here only exist above a threshold: pills wrap once they exceed the
# container's width, and a ten-row box only proves it scrolls when there are more than ten items.
# A short queue passes every check below on the markup that produced the screenshot.
QUEUED = 14


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


def _seed_scene(root: Path, stem: str, title: str):
    """A scene is an mp3 plus a manifest.

    ⚠️ The bytes are fake ON PURPOSE: nothing here plays or decodes anything, and `bandwidth_of` is
    patched out below precisely so this fixture does not need ffmpeg to reach the card claim.
    """
    (root / f"{stem}.mp3").write_bytes(b"ID3 fake audio, never decoded by this spec")
    entries = [{"mesid": 400 + i, "character": 'Test Character 1', "cache_key": f"k{i}",
                "offset_s": i * 4.7, "duration_s": 4.0, "text": "A line of dialogue."}
               for i in range(5)]
    scenes.write_manifest(root / f"{stem}.yaml", {
        "title": title, "source": "st", "owner": 'st:Test User', "chat": "a chat",
        "gap_s": 0.7, "created": "2026-08-23T04:32:48", "total_duration_s": 960.0,
        "entries": entries})


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_enhancement_queue_is_a_vertical_scrolling_list(tmp_path, monkeypatch):
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
    # 🔴 The suite must not read the host: OUTPUT_DIR unpatched is the repo's own `output/`, and
    # UI_STATE unpatched is the developer's own remembered tabs and queue.
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")
    from vocalis.runtime import paths
    monkeypatch.setattr(paths, "UI_STATE", install / "ui_state.json")

    out = tmp_path / "output"
    import book_to_audio
    import vocalis.web.clips as clips_mod
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(clips_mod, "OUTPUT_DIR", out)

    root = scenes.scenes_root(out)
    root.mkdir(parents=True, exist_ok=True)
    refs = []
    for i in range(QUEUED):
        # A scene name long enough to be worth ellipsizing on one of them, so `min-width:0` on the
        # name cell is exercised rather than assumed: without it a long name widens the flex row
        # and pushes that row's ✕ outside the box, which the spec checks for on EVERY row.
        title = ("The very long evening chapter about the lighthouse, the tide tables and what "
                 "Test Character 2 found under the stairs") if i == 5 else f"Scene number {i + 1}"
        stem = f"scene{i:02d}_ab12cd{i:02d}"
        _seed_scene(root, stem, title)
        refs.append(stem)

    # 🔴 SEEDED THROUGH ui-state, WHICH IS THE REAL RESTORE PATH. `scEnhRestore` reads
    # `vocalis-sc-enhq` on the tab's first successful load and validates every ref against the
    # scenes actually present — so this exercises the same code a reload does, rather than poking
    # module state the page would never be in.
    #
    # 🔴 AND THAT IS HOW 9.5.6 FOUND THE KEY BUG. Seeded as `sc-enhq` — the name the front end had
    # used since 8.2.4 — this restored NOTHING, because `ui_state.sanitize` keeps only keys
    # beginning `vocalis-` and had been dropping every flush of it at `/ui-state` for five
    # milestones. The promise "the queue survives a reload" was false the whole time and looked
    # true, because `UIS` answers reads out of its own in-memory copy. The rename is in
    # `scenes.js`; `test_ui_state.py` now fails on any front-end key the filter would discard.
    ui_state.save(paths.UI_STATE, {"vocalis-sc-enhq": json.dumps(refs)})

    # ── the three patches that hold the queue full — see the module docstring ──
    from vocalis.runtime import enhancement
    from vocalis.runtime.gpu import GPUS
    import enhance as enhance_mod

    monkeypatch.setattr(enhancement, "enhance_available", lambda: True)
    monkeypatch.setattr(enhancement, "enhance_cards", lambda: ["cuda:0"])
    # 8000 Hz is band-limited by any definition, so the route proceeds to the card claim. The
    # second element is `fresh`, which this route ignores.
    monkeypatch.setattr(enhance_mod, "bandwidth_of", lambda path, meta=None: (8000, False))
    # 🔴 THE ONE TRANSIENT REFUSAL ON THE ROUTE. `409 {busy: "cards"}` is what the client's queue
    # is built to WAIT on (it retries every 30 s); every other refusal it correctly treats as
    # terminal and drops the item. Patching the claim rather than the card list is what keeps the
    # rest of the route — including its own `ENHANCE_BUSY[why]` lookup — genuinely exercised.
    monkeypatch.setattr(GPUS, "claim_card", lambda *a, **k: (None, "cards"))

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    shot = os.environ.get("VOCALIS_QUEUE_SHOT")
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

    assert r.returncode == 0, ("the enhancement queue layout failed in a real browser:\n"
                               f"{r.stdout}\n{r.stderr}")

    # A floor as well as the names below: the name list catches one check being dropped, and
    # cannot catch an early return, because the names are near the top by construction.
    assert_spec_ran(r, SPEC)

    for named in ("there is no \"leave this tab open\" warning any more",
                  "precondition: enough items queued for wrapping to be possible",
                  "precondition: there is genuinely more content than fits",
                  "and so is the running/waiting count",
                  "every row starts at the SAME x",
                  "one row per line, top to bottom",
                  "the box is about ten rows tall",
                  "and the overflow SCROLLS rather than being clipped away",
                  "and they are in ONE column",
                  "no row pushes its ✕ outside the box",
                  "the queue box is its own width, not the whole panel",
                  "so the ✕ stays beside the name it removes",
                  "dropping row 4 on the top half of row 1 makes it first",
                  "a reorder, not a reshuffle"):
        assert named in r.stdout, f"the check {named!r} did not run:\n{r.stdout}"
