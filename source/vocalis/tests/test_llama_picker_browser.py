"""Browser coverage for the llama.cpp model picker. The test checks visible controls and posted requests together, verifies selection persistence across navigation, and exercises confirmation when a loaded model must be replaced. It skips when Node or Chrome is unavailable."""
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from conftest import assert_spec_ran, bound_server

import llama
import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.web import llama as web_llama

SPEC = Path(__file__).parent / "llama_picker_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

ROUTER_PROPS = {"role": "router", "max_instances": 4, "models_autoload": True,
                "build_info": "b10625-0cc5b1495"}

# Ten models, because the whole point of the change is that ninety-seven of them must not be on
# screen. The ids are deliberately non-overlapping as substrings — with Greek letters, /eta/
# matches "beta", "theta" and "zeta", and the "no unselected model is named" assertion would pass
# for the wrong reason.
FILLER = ["mike-13b", "november-7b", "oscar-32b", "model-p-3b",
          "quebec-9b", "romeo-14b", "sierra-4b"]


def _models(loaded, sleeping, extra_loaded=(), loading=None):
    """The router's `GET /models` body. `meta` only for models that have RUN — the router merges
    the child's own `/v1/models` in, and there is nothing to merge for one that never started."""
    data = [
        {"id": loaded, "source": "preset",
         "status": {"value": "loaded", "args": ["llama-server"]},
         "meta": {"n_ctx": 8192, "n_ctx_train": 131072, "n_params": 24_000_000_000,
                  "size": 15 * 1073741824, "ftype": "IQ4_XS - 4.25 bpw"}},
        {"id": sleeping, "source": "preset",
         "status": {"value": "sleeping", "args": ["llama-server"]}},
        {"id": "model-c-24b", "source": "models_dir", "status": {"value": "unloaded"}},
    ]
    for name in FILLER:
        data.append({"id": name, "source": "models_dir", "status": {"value": "unloaded"}})
    for name in extra_loaded:
        for row in data:
            if row["id"] == name:
                row["status"] = {"value": "loaded", "args": ["llama-server"]}
                row["meta"] = {"n_ctx": 4096, "n_ctx_train": 32768}
    # The window between the POST and the child being ready. Reported, not skipped: `paintPicker`
    # hides BOTH buttons while anything is loading, because mid-flight neither verb is honest, and
    # a fixture that jumped straight to `loaded` would never exercise that branch.
    for row in data:
        if row["id"] == loading:
            row["status"] = {"value": "loading", "args": ["llama-server"]}
    return {"object": "list", "data": data}


class FakeRouter:
    """A llama-server router that REMEMBERS what it was asked to load and unload.

    ⚠️ It goes `loading` first and only reports `loaded` on a LATER poll, because that is what the
    real one does: `server_models::load()` spawns the child and returns, so `{"success": true}`
    means STARTED. A fake that flipped the row in the same call would hide the landmine the whole
    milestone is built around — and would also make the "Loading" the tab shows untestable.

    📌 It DOES eventually flip, unlike `LoadingLlama` in test_llama_routes.py, because the route's
    900 s watcher thread polls until it does. A fake that never flipped would leave that thread
    calling a monkeypatched stub after the test had torn it down.
    """

    def __init__(self):
        self.loaded = []
        self.unloaded = []
        self.resident = ["alpha-70b"]
        self._pending = None
        self._polls_left = 0

    def __call__(self, cfg, path, body=None, timeout=10.0, method=None):
        if path == "/health":
            return {"status": "ok"}
        if path == "/props":
            return dict(ROUTER_PROPS)
        if path == "/models/load":
            name = (body or {}).get("model")
            self.loaded.append(name)
            self._pending, self._polls_left = name, 2
            return {"success": True}
        if path == "/models/unload":
            name = (body or {}).get("model")
            self.unloaded.append(name)
            if name in self.resident:
                self.resident.remove(name)
            return {"success": True}
        if path.startswith("/models"):
            if self._pending and self._polls_left <= 0:
                self.resident.append(self._pending)
                self._pending = None
            elif self._pending:
                self._polls_left -= 1
            extra = [m for m in self.resident if m != "alpha-70b"]
            return _models("alpha-70b", "bravo-8b", extra_loaded=extra, loading=self._pending)
        raise AssertionError(f"unscripted {path!r}")


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


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_llama_model_picker_works_in_a_browser(tmp_path, monkeypatch):
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
    # 🔴 The suite must not read (or write) the developer's own app_settings.yaml.
    settings_file = install / "app_settings.yaml"
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", settings_file)

    # 🔴 The fixture provides distinct inventories independent of the host, and
    # the load dialog's warning is one of the things under test.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])
    monkeypatch.setattr(gpu_mod, "other_vram_gb", lambda: 12.5)
    rt_settings.save_app_settings({"devices": [{"id": "cuda:0", "enabled": True},
                                               {"id": "cuda:1", "enabled": True}],
                                   "devices_warn_llm_loaded": True})

    # `local=True` is the gate the ticked-cards warning hangs off — a remote llama-server is
    # silent by design, so a fixture that left it False would pass step 8 by never warning.
    fake = FakeRouter()
    monkeypatch.setattr(llama, "_request", fake)
    monkeypatch.setattr(web_llama, "_llama_cfg", lambda: llama.LlamaConfig(
        url="http://127.0.0.1:8080", api_key="", local=True))

    # 🔴 THE SCREENSHOT NOBODY COULD EVER LOOK AT. `tmp_path` is removed for a PASSING test
    # (`tmp_path_retention_policy = failed`), so this spec has been capturing a picture of the
    # panel and deleting it on every green run since 9.5-m2c. That is why m2b-5 — *"Verify in a
    # real browser and LOOK at a screenshot"* — stayed open through a milestone that had the
    # capture wired the whole time: the evidence existed for a few hundred milliseconds and was
    # never once seen. `VOCALIS_SHOT_DIR` puts it somewhere it survives.
    #
    # ⚠️ It stays in `tmp_path` by DEFAULT, so a normal run litters nothing and the retention
    # policy keeps doing its job. A geometry assertion can pass on a layout that looks wrong in
    # ways it does not describe, and the only fix for that is a human eye on the image.
    shot_dir = os.environ.get("VOCALIS_SHOT_DIR")
    shot = (Path(shot_dir) if shot_dir else tmp_path) / "llama-picker.png"
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)       # binds port 0: the number is never unowned
    port = srv.server_port
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        r = subprocess.run([NODE, str(SPEC), f"http://127.0.0.1:{port}/", _chrome(), str(shot)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
    finally:
        srv.shutdown()
        t.join(timeout=10)
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, (
        "the llama.cpp model picker failed in a real browser:\n"
        f"{r.stdout}\n{r.stderr}")

    # 🔴 THE OTHER LAYER. Step 7 opened the unload dialog and pressed Cancel; step 8 opened the
    # load dialog and pressed Continue. So EXACTLY ONE load and NO unload may have reached
    # llama-server. A dialog that renders perfectly and posts anyway is the failure this pair can
    # see and the DOM cannot.
    # Two loads, in order: the dialog choice, then the untouched select's fresh-browser fallback.
    # The second load proves the selection is remembered from the request, not only a change event.
    assert fake.loaded == ["model-c-24b", "model-p-3b"], (
        f"llama-server was asked to load {fake.loaded!r} — a confirm that posts anyway is not a "
        f"confirm, and a load that never happens is a button that does nothing:\n{r.stdout}")
    assert fake.unloaded == [], (
        f"Cancel still unloaded {fake.unloaded!r} — `modal()` resolves actions[0] on Esc and on "
        f"the backdrop, so a reordered actions array makes Cancel destructive:\n{r.stdout}")

    # A screenshot is written for a human to look at; its existence is what proves the capture
    # path ran, not what proves the layout is right. Only eyes do that.
    assert shot.exists() and shot.stat().st_size > 10_000, "no screenshot was captured"

    # 🔴 AND IT RAN TO THE END. The exit code cannot tell a pass from a spec that stopped checking
    # — an early return exits 0 and is merely SHORTER.
    assert_spec_ran(r, SPEC)
