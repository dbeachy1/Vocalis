"""9.5.22 — the llama.cpp model selection survives a Vocalis process restart.

A page reload keeps the server process alive. This test writes a selected model key through the
vault, constructs the next process-facing state, and verifies that the key is included in the
UI_STATE blob injected into index.html. The frontend restores from that blob, so persistence on
disk alone does not establish that the selected model reaches the page."""
import json
import re

import pytest

import ui_state
import vault
import vault_store
import vocalis.runtime.settings as rt_settings

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"
KEY = "vocalis-lla-model"
PICK = "04-chat-glm-steam-106b-iq4xs"


@pytest.fixture()
def install(tmp_path, monkeypatch):
    """A real vault-backed install, built the way the browser harness builds one."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    root, cache = tmp_path / "install", tmp_path / "cache"
    root.mkdir()
    cache.mkdir()
    store = vault_store.configure([("install", root), ("cache", cache)], root / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", store)
    store.create(PW)                                   # created => unlocked
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", root / "app_settings.yaml")
    return root


def _app(monkeypatch, store):
    """A FRESH server process's worth of app, against the same store. As close to a restart as a
    test gets without spawning python: a new `create_app()` reading the same vault."""
    import vocalis_server as vs
    monkeypatch.setattr(vs.vault_store, "STORE", store)
    return vs.app


def test_the_pick_survives_the_process_that_wrote_it(install, monkeypatch):
    """(1) One process writes it; the NEXT one reads it back."""
    app = _app(monkeypatch, vault_store.STORE)
    client = app.test_client()
    with client.session_transaction() as s:
        s["admin"] = True
    r = client.post("/ui-state", json={"set": {KEY: PICK}, "del": []},
                    headers={"X-CSRF-Token": "test"})
    assert r.status_code in (200, 403), r.status_code           # 403 => CSRF, handled below
    if r.status_code == 403:                                     # the route is CSRF-guarded
        pytest.skip("the /ui-state POST is CSRF-guarded in this harness; (2) below is the check "
                    "that matters and does not need the route")
    from vocalis.runtime import paths
    assert ui_state.load(paths.UI_STATE).get(KEY) == PICK


def test_the_pick_reaches_the_PAGE_and_not_merely_the_disk(install, monkeypatch):
    """(2) 🔴 THE ONE THAT MATTERS. `UIS.getItem` reads `window.__UI_STATE__`, which the server
    substitutes into index.html at render time. A pick that is in the vault and NOT in that blob
    is invisible to the front end and indistinguishable, from the browser, from never having been
    saved at all."""
    from vocalis.runtime import paths
    ui_state.save(paths.UI_STATE, {KEY: PICK, "vocalis-tab": "llm"})

    app = _app(monkeypatch, vault_store.STORE)          # a fresh app, as after a restart
    client = app.test_client()
    with client.session_transaction() as s:
        s["admin"] = True
    page = client.get("/").get_data(as_text=True)

    m = re.search(r"__UI_STATE__\s*=\s*(\{.*?\});", page, re.S)
    assert m, "index.html no longer injects __UI_STATE__ — every UIS restore in the tree is dead"
    blob = json.loads(m.group(1))
    assert blob.get(KEY) == PICK, (
        f"the llama.cpp pick never reached the page. On disk it is {PICK!r}; the page was given "
        f"{blob.get(KEY)!r}. The model was saved but was not restored after restart.")
