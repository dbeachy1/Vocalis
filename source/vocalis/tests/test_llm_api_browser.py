"""11.1 — LLM ▸ API and the editor-engine drop-down, driven in a REAL headless browser.

The spec (`llm_api_browser_spec.mjs`) asserts what the page SHOWED; this file asserts what actually
happened on the other side of it — what the fake providers received, what landed in the encrypted
section, and what landed in app_settings.yaml. A DOM check alone is satisfied by an optimistic
render; the two layers disagreeing is what localizes a fault.

🔴 **THE SPINNER IS CHECKED ON A REQUEST THAT CANNOT HAVE ANSWERED YET.** The fake OpenRouter
holds `/v1/key` until the spec calls `/__release`, and the fake Featherless holds the query `hold`
the same way — so R6's spinner and the stale-search guard are both asserted against a request that
is provably in flight, never against a guess about timing.

Skipped, never failed, when Chrome or node is absent.
"""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import assert_spec_ran, bound_server

import llama
import llmapi
import vault
import vault_store
import voice_utils
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import paths
from vocalis.web import llama as web_llama

from fake_llm_providers import GOOD_KEY, FakeProvider
from test_llama_picker_browser import _chrome

SPEC = Path(__file__).parent / "llm_api_browser_spec.mjs"
NODE = shutil.which("node")
TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_api_tab_works_in_a_browser(tmp_path, monkeypatch):
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
    settings_file = install / "app_settings.yaml"
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings_file)
    monkeypatch.setattr(llmapi, "_OR_CACHE", {})
    # llama.cpp unconfigured, deliberately: the drop-down must grey it out with its reason, and no
    # probe may reach for a llama-server that is not there.
    monkeypatch.setattr(web_llama, "_llama_cfg", lambda: llama.LlamaConfig(url=""))

    orf, flf = FakeProvider("openrouter").start(), FakeProvider("featherless").start()
    orf.hold("/v1/key")                # released by the spec, AFTER it has seen the spinner
    flf.hold("q=hold")                 # the slow search the newer one must not be overwritten by
    for f in (orf, flf):
        env = llmapi.PROVIDERS[f.kind]
        monkeypatch.setenv(env.url_env, f.url)
        monkeypatch.delenv(env.key_env, raising=False)

    shot_dir = os.environ.get("VOCALIS_SHOT_DIR")
    shot = (Path(shot_dir) if shot_dir else tmp_path) / "llm-api.png"
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{srv.server_port}/", _chrome(),
                            str(shot), orf.url, flf.url, GOOD_KEY],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)
        orf.stop()
        flf.stop()

    assert r.returncode == 0, f"LLM ▸ API failed in a real browser:\n{r.stdout}\n{r.stderr}"

    # ── the other layer ──────────────────────────────────────────────────────
    # The key reached the ENCRYPTED section, and the provider, and nowhere else.
    for p in ("openrouter", "featherless"):
        assert voice_utils.get_section(paths.VOICE_SETTINGS, p).get("api_key") == GOOD_KEY
    saved = settings_file.read_text(encoding="utf-8")
    assert GOOD_KEY not in saved, "the key was written to app_settings.yaml in plaintext"
    s = rt_settings.load_app_settings()
    assert s["llm_api"]["openrouter"]["model"] == "z-ai/glm-4.6"
    assert s["llm_api"]["openrouter"]["last_connect"]["ok"] is True
    assert s["wbedit_engine"] == "openrouter"
    # Exactly ONE Connect reached OpenRouter — the disabled button cannot stack a second — and it
    # carried the key the way the provider documents.
    keys = [(a) for m, p, a, b in orf.requests if p == "/v1/key"]
    assert keys == [f"Bearer {GOOD_KEY}"], keys
    # The OpenRouter catalogue was fetched once for the whole session of typing and clicking.
    assert len(orf.paths("/v1/models")) == 1, orf.paths("/v1/models")
    # Featherless searched upstream, plan-filtered, and never with a one-letter query.
    fq = flf.paths("/v1/models?")
    assert fq and all("available_on_current_plan=true" in q for q in fq), fq

    assert shot.exists() and shot.stat().st_size > 10_000, "no screenshot was captured"
    assert_spec_ran(r, SPEC)
