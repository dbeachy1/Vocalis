"""Exercise the ACE-Step tab in a real browser with a stubbed backend. HTTP route tests cannot verify module-load click wiring, so this spec presses the controls and asserts their effects. Stub only runtime/acestep's external HTTP calls; retain the real queue, job registry, routes, browser modules, and audio proxy. Skip when Chrome or Node is unavailable."""
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest

from conftest import REPO_ROOT, assert_spec_ran, bound_server  # noqa: F401  (sys.path side effect)

import vault
import vault_store
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import acestep as rt_ace

SPEC = Path(__file__).parent / "acestep_tab_browser_spec.mjs"
NODE = shutil.which("node")

TEST_KDF = {"algo": "argon2id", "memory_kib": 8, "time_cost": 1, "parallelism": 1}
PW = "correct horse battery staple"

#: Use two synthetic backends to verify per-card fan-out; one backend cannot expose a broken multi-card dispatch.
STUB_INSTALLED = [
    ("acestep-api.service", "http://127.0.0.1:7683", "cuda:0"),
    ("acestep-api-gpu1.service", "http://127.0.0.1:7685", "cuda:1"),
]

#: ⚠️ DIFFERENT MODELS PER CARD, because that is the point of per-card selection and it changes
#: the payload (turbo → 8 steps + DCW on, xl-base → 50 steps; October 11, 2026: card 2 holds xl-base, the model the
#: publisher lists for Extract, Replace and Complete, so the page leaves those modes enabled). A stub answering the same
#: model twice would let a client that ignores the card's model pass.
STUB_MODELS = {"http://127.0.0.1:7683": "acestep-v15-turbo",
               "http://127.0.0.1:7685": "acestep-v15-xl-base"}

#: 🔴 A REAL, DECODABLE OGG/OPUS — not b"not audio". The candidate row builds an <audio> whose src
#: is the proxy route, and a browser that cannot decode the body sets `error` on the element
#: rather than failing the fetch, so a sentinel fixture would satisfy every byte-count assertion
#: while the one thing that matters (a user can hear it) is false.
def _tone_bytes(tmp_path, seconds=2):
    ff = shutil.which("ffmpeg")
    if ff is None:
        pytest.skip("ffmpeg is not installed")
    out = tmp_path / "tone.flac"
    subprocess.run([ff, "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"sine=frequency=440:duration={seconds}",
                    "-c:a", "flac", str(out)], check=True, timeout=60, capture_output=True)
    return out.read_bytes()


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


def _start_owned_children(monkeypatch):
    """Give the stub cards what the Docker runtime requires of a card that can take work.

    The legacy runtime asked systemd whether a unit existed and counted live units; the Docker one
    owns a child process per card and `can_dispatch()` / `submission_slot()` refuse a card unless
    that child is running, HTTP-ready AND model-ready under the current generation. So the stub
    cards are started through the real lifecycle (`start_instance`) with only the process launch
    faked, then marked ready exactly as the health probe and the model loader would.

    ⚠️ `rt_ace.subprocess` is REPLACED with a copy that has a fake `Popen`; patching
    `subprocess.Popen` itself would also break the `subprocess.run` that launches Node below.
    """
    import types

    class _Child:
        pid = 941_219
        returncode = None

        def poll(self):
            return self.returncode

    monkeypatch.setattr(rt_ace, "configured", lambda _settings=None: list(STUB_INSTALLED))
    monkeypatch.setattr(rt_ace, "_BACKENDS", {})
    monkeypatch.setattr(rt_ace, "_STOP_ALL", threading.Event())
    monkeypatch.setattr(rt_ace, "_runtime_inputs", lambda: (
        "/opt/python", "/opt/acestep", "/models/vocalis/acestep"))
    monkeypatch.setattr(rt_ace, "subprocess", types.SimpleNamespace(
        **{**vars(subprocess), "Popen": lambda *args, **kwargs: _Child()}))
    for service, url, _device in STUB_INSTALLED:
        result = rt_ace.start_instance(service=service)
        assert result["ok"], result
        rt_ace.mark_http_ready(url)
        rt_ace.mark_model_ready(url, True)


@pytest.mark.timeout(300)
@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_acestep_tab_generates_and_keeps_a_song_in_a_real_browser(tmp_path, monkeypatch):
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
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", install / "app_settings.yaml")

    # The two stores this tab writes through, inside the test vault rather than the developer's.
    from vocalis.runtime import paths as rt_paths
    monkeypatch.setattr(rt_paths, "ACE_TEMPLATES", install / "ace_templates.json")
    # Redirect the candidate registry into the test install root. An unisolated spec could load stale candidates or write generated state into the checkout.
    monkeypatch.setattr(rt_paths, "ACE_CANDIDATES", install / "ace_candidates.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", install / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", install / "ace_library")

    # 🔴 THE SUITE MUST NOT READ THE HOST — including its systemd and its cards.
    import vocalis.runtime.gpu as gpu_mod
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [{"index": 0, "name": "R9700"},
                                                          {"index": 1, "name": "R9700"}])
    monkeypatch.setattr(gpu_mod, "gpu_stats", lambda: [])
    _start_owned_children(monkeypatch)
    # The spec presses Load and confirms. The real `start_init` flips that card to model-not-ready and
    # POSTs `/v1/init` to a port nothing listens on, which fails and leaves the card un-dispatchable
    # for every later step. Stub it at its HTTP boundary as an accepted load that leaves the (already
    # ready) model in place, and keep the calls so the route's request can be asserted.
    init_calls = []

    def fake_start_init(url, device, model, *, busy_check=None):
        init_calls.append((url, device, model))
        return {"ok": True, "device": device, "model": model, "loading": True}

    monkeypatch.setattr(rt_ace, "start_init", fake_start_init)
    monkeypatch.setattr(rt_ace, "probe", lambda url, timeout=3.0: {
        "up": True, "model_loaded": True, "model": STUB_MODELS[url]})
    monkeypatch.setattr(rt_ace, "inventory", lambda url: {
        "reachable": True, "models": ["acestep-v15-turbo", "acestep-v15-xl-sft", "acestep-v15-xl-base"],
        "default": None,
        # This inventory shape warms `_TASKS_BY_URL` so generation uses the same capability gate as the production path.
        # October 11, 2026: xl-sft is reported with all seven tasks, exactly as the engine does (its config.json is the
        # one xl-base ships); the server narrows it to the publisher's four, which the spec asserts on the page.
        "tasks": {"acestep-v15-turbo": ["text2music", "repaint", "cover", "cover-nofsq"],
                  "acestep-v15-xl-sft": ["text2music", "repaint", "cover", "cover-nofsq",
                                         "extract", "lego", "complete"],
                  "acestep-v15-xl-base": ["text2music", "repaint", "cover", "cover-nofsq",
                                          "extract", "lego", "complete"]},
        "loaded": STUB_MODELS[url]})

    # ── the generation itself, faked at the HTTP seam ────────────────────────────────────────
    # ⚠️ submit/poll/fetch_audio ONLY. Everything between them — AceQueue, the worker thread,
    # acerun's finally, the job registry, the proxy route — is the real code, because that is
    # what this spec is for.
    tone = _tone_bytes(tmp_path)
    submitted = {}

    def fake_submit(url, payload):
        tid = f"task-{len(submitted)}"
        submitted[tid] = {"url": url, "payload": payload, "at": time.time()}
        return tid

    def fake_poll(url, task_id):
        # Done almost immediately: this spec is about the tab, not about waiting.
        if time.time() - submitted[task_id]["at"] < 1.0:
            return {"status": rt_ace.RUNNING, "audio": [], "progress": 0.4}
        return {"status": rt_ace.SUCCEEDED, "audio": [f"/tmp/{task_id}.flac"], "progress": 1.0}

    monkeypatch.setattr(rt_ace, "submit", fake_submit)
    monkeypatch.setattr(rt_ace, "poll", fake_poll)
    monkeypatch.setattr(rt_ace, "fetch_audio", lambda url, path: tone)

    # 🔴 A CLEAN QUEUE **AND** A CLEAN JOB REGISTRY, and the second one is the part that bit.
    # Both are process-wide by design (see the note on QUEUE in web/acestep.py), and an xdist
    # worker runs many FILES in one process — so `test_acestep_routes.py` landing on this worker
    # first leaves its ACE-Step jobs in `jobs.JOBS`, the tray renders them too, and
    # "one candidate per card" counts three. Which files share a worker changes from run to run,
    # so the failure is INTERMITTENT: it passed on the very next identical run, which is exactly
    # how a cross-file dependency disguises itself as flakiness.
    # ⚠️ Filtered on `kind`, never a wholesale clear: other kinds of job in this registry belong
    # to whatever else is mid-flight, and taking them out would be this test breaking its
    # neighbors instead of the other way round.
    from vocalis.runtime import jobs as jobs_mod
    from vocalis.web import acestep as web_ace
    web_ace.QUEUE._pending.clear()
    web_ace.QUEUE._inflight.clear()
    # The capability/model caches are process-wide and URL-keyed, and stub URLs are shared with
    # test_acestep_routes.py on the same xdist worker — a stale turbo-only tasks map would
    # capability-filter this spec's generate. Same hygiene as the queue above.
    web_ace._TASKS_BY_URL.clear()
    web_ace._MODEL_BY_URL.clear()
    with jobs_mod.JOBS_LOCK:
        for k in [k for k, v in jobs_mod.JOBS.items() if getattr(v, "kind", "") == "acestep"]:
            jobs_mod.JOBS.pop(k, None)

    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    srv = bound_server(vs.app)
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
        socket.setdefaulttimeout(old_timeout)

    assert r.returncode == 0, (
        "the ACE-Step tab failed in a real browser:\n" f"{r.stdout}\n{r.stderr}")

    # 🔴 A SPEC THAT SILENTLY STOPPED CHECKING EXITS 0 AS HAPPILY AS ONE THAT PASSED, and until
    # 9.0.12 this file's ONLY check on the browser half was that exit code. An early `return`, a
    # renamed selector or a deleted block would have made the run SHORTER and still green.
    # `test_ace_folders_browser.py` names its assertions for exactly this reason; the same guard is
    # applied here in the two forms that stay cheap to keep honest:
    #
    #   * a FLOOR on how many assertions ran, which is what catches an early return - the failure
    #     mode a name list cannot see, because the names it checks are the ones near the top;
    #   * the NAMES of the load-bearing few, which is what catches one check being quietly dropped.
    #
    # ⚠️ THE FLOOR IS DELIBERATELY NOT A CENSUS. This spec makes 92 assertions and pinning every
    # one by name would turn each ordinary edit into a bookkeeping chore, which is how a guard gets
    # deleted rather than satisfied. It is a ratchet on COUNT plus a short list of the checks whose
    # disappearance would matter most - raise the floor when the spec grows, never lower it.
    #
    # 🔴 92 IS MEASURED, NOT COUNTED OFF THE SOURCE. The first cut of this guard said 79, read
    # from `grep -c '^  ok('` - which silently missed every call site indented differently and would
    # have let thirteen assertions vanish without a word. The number came out of a real run instead,
    # by raising the floor absurdly high once and reading it off the failure message; source count
    # and emitted count then agreed at 92, which is also what proves no `ok()` here sits behind a
    # branch that did not execute. ⚠️ A FLOOR SET BELOW THE TRUE COUNT IS THE ONE FAILURE MODE THIS
    # CANNOT SURVIVE - it reads as a guard and permits exactly the drift it was written to catch.
    # 🔴 ONE IMPLEMENTATION OF THIS CHECK, NOT TWO. This was hand-written here before
    # `assert_spec_ran` existed - same floor, same named checks, its own copy of the counting. Two
    # copies drift, and the meta-test in test_spec_guards.py could not see this one as a guard at
    # all, so the file read as unguarded in exactly the census written to find unguarded files.
    assert_spec_ran(
        r,
        SPEC,
        "pressing the ACE-Step tab button opens its panel",
        "one press produced one candidate per card",
        "both candidates finish and offer an <audio> to listen to",
        # 9.0.12 - the tray shares ONE grid rule with the library, so it shares its failure mode;
        # the library got regression cover and this list had none.
        "a finished candidate's actions reach the right edge of their own cell too",
        "and stops being a candidate, rather than living in both lists at once",
        floor=92,
    )

    # 🔴 AND THE SERVER SIDE AGREES. The browser said it saw two candidates; this proves two
    # payloads really reached the (stubbed) backends, one per card, with that card's model — so a
    # passing spec cannot mean "the tray rendered something plausible".
    assert len(submitted) == 2, f"expected one submission per card, got {len(submitted)}"
    by_url = {v["url"]: v["payload"] for v in submitted.values()}
    assert set(by_url) == set(STUB_MODELS), "a card was skipped or one got both songs"
    assert by_url["http://127.0.0.1:7683"]["inference_steps"] == 8      # turbo
    assert by_url["http://127.0.0.1:7685"]["inference_steps"] == 50     # xl-base
    seeds = {p["seed"] for p in by_url.values()}
    assert len(seeds) == 2, f"both cards were handed the same seed: {seeds}"
    # The confirmed Load reached the runtime's init (stubbed above), for a real model in the inventory.
    assert init_calls, "the confirmed Load never reached acestep.start_init"
    assert all(model in {*STUB_MODELS.values(), "acestep-v15-xl-sft"} for _url, _device, model in init_calls), init_calls
