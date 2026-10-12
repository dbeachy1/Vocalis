"""The read-only `/llama/*` routes distinguish four service states: not configured, configured but
down, rejected credentials, and a reachable single-model server without a management API.

The HTTP boundary is mocked so these route tests never depend on a live llama-server. The
`/health` probe remains unauthenticated, while `/props` is the first authenticated request; the
response ladder uses that distinction to separate a transport failure from a bad key."""
import pytest

import llama
import vocalis_server as vs
from vocalis.web import llama as web_llama


ROUTER_PROPS = {"role": "router", "max_instances": 4, "models_autoload": True,
                "build_info": "b10625-0cc5b1495"}
SINGLE_PROPS = {"model_path": "/ai-models/Some-Model.gguf", "total_slots": 1}

MODELS = {"object": "list", "data": [
    {"id": "alpha", "status": {"value": "loaded", "args": ["llama-server"]},
     "source": "preset", "meta": {"n_ctx": 8192, "n_ctx_train": 131072}},
    {"id": "beta", "status": {"value": "sleeping", "args": ["llama-server"]}, "source": "preset"},
]}


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


class FakeLlama:
    """A scripted llama-server. `props` decides the mode; `fail` injects an exception.

    🔴 **`/health` IS PUBLIC AND DOES NOT FAIL WITH `fail`, AND THAT IS NOT A CONVENIENCE — IT IS
    THE BEHAVIOR BEING MODELED.** llama-server exempts `/health` and `/v1/health` from the API
    key check (`server.cpp:233`, `server-http.cpp:197-204`), and that exemption is the ONLY reason
    the two-step ladder in `/llama/info` can tell "down" from "wrong key": health answers without
    a credential, then `/props` is the first authenticated call. A fake that 401s `/health` makes
    every auth failure look like a transport failure — which is exactly what this file's first
    version did, and `test_test_reports_a_bad_key_distinctly` caught it.

    ⚠️ So use `fail_health` for a server that is genuinely DOWN, and `fail` for one that is up and
    refusing. Conflating them here would quietly delete the distinction the routes exist to keep.
    """

    def __init__(self, props=None, models=None, fail=None, fail_health=None):
        self.props = props if props is not None else dict(ROUTER_PROPS)
        self.models = models if models is not None else MODELS
        self.fail = fail
        self.fail_health = fail_health
        self.calls = []

    def __call__(self, cfg, path, body=None, timeout=10.0, method=None):
        self.calls.append(path)
        if path == "/health":
            if self.fail_health is not None:
                raise self.fail_health
            return {"status": "ok"}
        if self.fail is not None:
            raise self.fail
        if path == "/props":
            return dict(self.props)
        if path.startswith("/models"):
            return self.models
        raise AssertionError(f"unscripted {path!r}")


def wire(monkeypatch, fake, *, url="http://127.0.0.1:8080", key="", local=True):
    monkeypatch.setattr(llama, "_request", fake)
    monkeypatch.setattr(web_llama, "_llama_cfg",
                        lambda: llama.LlamaConfig(url=url, api_key=key, local=local))
    return fake


# ── /llama/info ──────────────────────────────────────────────────────────────

def test_info_reports_configured_and_available_SEPARATELY(client, monkeypatch):
    """🔴 TWO FIELDS, NOT ONE "unavailable". They have different fixes."""
    wire(monkeypatch, FakeLlama())
    j = client.get("/llama/info").get_json()
    assert j["configured"] is True and j["available"] is True and j["mode"] == "router"


def test_info_on_an_unset_url_is_a_200_saying_not_configured(client, monkeypatch):
    """Never a 5xx: "no llama.cpp" is the DEFAULT state on any box, not an error."""
    wire(monkeypatch, FakeLlama(), url="")
    r = client.get("/llama/info")
    assert r.status_code == 200
    j = r.get_json()
    assert j["configured"] is False and j["available"] is False


def test_info_names_the_URL_it_tried(client, monkeypatch):
    """The URL is the first thing to check, so the tab should name the attempted endpoint rather than only saying that no server was found."""
    wire(monkeypatch, FakeLlama(fail_health=llama.LlamaUnreachable("connection refused")),
         url="http://llama.example.invalid:9099")
    j = client.get("/llama/info").get_json()
    assert j["available"] is False and j["url"] == "http://llama.example.invalid:9099"
    # ...and still CONFIGURED. Down is not unconfigured, and the sub-tab stays enabled.
    assert j["configured"] is True


def test_info_reports_the_router_flags_it_does_not_control(client, monkeypatch):
    """`--models-max` and `--models-autoload` are launch flags. With autoload on, a model can be
    loaded because SillyTavern asked for it, with no click in Vocalis at all — so the tab must
    READ these rather than assume them."""
    wire(monkeypatch, FakeLlama())
    j = client.get("/llama/info").get_json()
    assert j["max_instances"] == 4 and j["models_autoload"] is True


def test_info_says_single_when_props_has_no_role(client, monkeypatch):
    wire(monkeypatch, FakeLlama(props=dict(SINGLE_PROPS)))
    assert client.get("/llama/info").get_json()["mode"] == "single"


def test_info_never_returns_the_api_key_only_a_bool(client, monkeypatch):
    wire(monkeypatch, FakeLlama(), key="sk-secret-value")
    r = client.get("/llama/info")
    assert "sk-secret-value" not in r.get_data(as_text=True)
    assert r.get_json()["api_key_set"] is True


# ── /llama/models ────────────────────────────────────────────────────────────

def test_models_lists_both_and_marks_only_the_loaded_one_as_holding(client, monkeypatch):
    wire(monkeypatch, FakeLlama())
    rows = {r["id"]: r for r in client.get("/llama/models").get_json()["models"]}
    assert rows["alpha"]["holds_vram"] is True
    # 🔴 `beta` is SLEEPING: running, routable, and holding nothing.
    assert rows["beta"]["running"] is True and rows["beta"]["holds_vram"] is False


def test_models_unconfigured_is_503_with_a_code_to_branch_on(client, monkeypatch):
    wire(monkeypatch, FakeLlama(), url="")
    r = client.get("/llama/models")
    assert r.status_code == 503
    assert r.get_json()["error"] == "llama_unconfigured"


def test_models_auth_failure_is_502_and_carries_the_sentence(client, monkeypatch):
    """The response needs both a stable error code for clients and a useful message for operators. Keeping the message is part of the route contract."""
    wire(monkeypatch, FakeLlama(fail=llama.LlamaAuthFailed("rejected the API key")))
    r = client.get("/llama/models")
    assert r.status_code == 502
    j = r.get_json()
    assert j["error"] == "llama_auth" and "API key" in j["message"]


def test_models_unreachable_is_503(client, monkeypatch):
    wire(monkeypatch, FakeLlama(fail=llama.LlamaUnreachable("refused")))
    r = client.get("/llama/models")
    assert r.status_code == 503 and r.get_json()["error"] == "llama_unreachable"


def test_models_never_sends_reload_on_a_plain_GET(client, monkeypatch):
    """`?reload=1` makes the server re-read its sources. This route is what the tab POLLS."""
    f = wire(monkeypatch, FakeLlama())
    client.get("/llama/models")
    assert all("reload" not in c for c in f.calls), f.calls


# ── /llama/status ────────────────────────────────────────────────────────────

def test_status_loaded_means_holding_vram(client, monkeypatch):
    wire(monkeypatch, FakeLlama())
    j = client.get("/llama/status").get_json()
    assert j["loaded"] is True and "beta" in j["running"]


def test_status_with_only_a_sleeping_model_is_NOT_loaded(client, monkeypatch):
    """The headline bool the render-conflict offer will read at m3. A sleeping model holds
    nothing, so offering to unload it would buy nothing and cost a live chat."""
    only_sleeping = {"object": "list",
                     "data": [{"id": "beta", "status": {"value": "sleeping"}}]}
    wire(monkeypatch, FakeLlama(models=only_sleeping))
    j = client.get("/llama/status").get_json()
    assert j["running"] == ["beta"]
    assert j["loaded"] is False


def test_status_remote_reports_NO_vram_figure_and_not_a_zero(client, monkeypatch):
    """🔴 A WRONG NUMBER OUTRANKS A MISSING ONE FOR DAMAGE. `gpu.other_vram_gb()` answers a
    plausible 0.0 when it cannot see the cards rather than erroring, so shipping it unguarded
    makes the tab say "holding 0 GB" about a box holding 51. A blank invites a question; a zero
    answers it falsely."""
    wire(monkeypatch, FakeLlama(), local=False)
    j = client.get("/llama/status").get_json()
    assert j["vram_measurable"] is False
    assert "other_vram_gb" not in j


def test_status_local_omits_the_not_measurable_flag(client, monkeypatch):
    wire(monkeypatch, FakeLlama(), local=True)
    assert "vram_measurable" not in client.get("/llama/status").get_json()


# ── /llama/test ──────────────────────────────────────────────────────────────

def test_test_is_ALWAYS_200_even_when_it_reports_a_failure(client, monkeypatch):
    """🔴 IT REPORTS A VERDICT, IT DOES NOT FAIL. A 4xx makes the fetch throw and shows a
    transport error *about a diagnostic* instead of the diagnostic — 4.7-m2's lesson."""
    wire(monkeypatch, FakeLlama(fail_health=llama.LlamaUnreachable("refused")))
    r = client.post("/llama/test")
    assert r.status_code == 200
    assert r.get_json()["ok"] is False and r.get_json()["reason"] == "unreachable"


def test_test_reports_a_bad_key_distinctly(client, monkeypatch):
    wire(monkeypatch, FakeLlama(fail=llama.LlamaAuthFailed("rejected")), key="wrong")
    j = client.post("/llama/test").get_json()
    assert j["ok"] is False and j["reason"] == "bad_key"


def test_a_single_model_server_is_ok_TRUE(client, monkeypatch):
    """A `llama-server -m …` can be reachable and serve its model while lacking model-management support. Report it as healthy and explain how to enable load/unload instead of treating it as a failure."""
    wire(monkeypatch, FakeLlama(props=dict(SINGLE_PROPS)))
    j = client.post("/llama/test").get_json()
    assert j["ok"] is True
    assert j["reason"] == "single_model"
    assert "--models-preset" in j["message"]


def test_test_on_an_unset_url_says_unconfigured_not_unreachable(client, monkeypatch):
    wire(monkeypatch, FakeLlama(), url="")
    j = client.post("/llama/test").get_json()
    assert j["ok"] is False and j["reason"] == "unconfigured"


def test_a_healthy_router_is_ok_with_a_model_count(client, monkeypatch):
    wire(monkeypatch, FakeLlama())
    j = client.post("/llama/test").get_json()
    assert j["ok"] is True and j["models"] == 2 and j["mode"] == "router"


# ── /llama/load and /llama/unload (m2) ───────────────────────────────────────

class LoadingLlama(FakeLlama):
    """A router that RECORDS load/unload calls and can flip a model's state on demand.

    🔴 It answers `{"success": true}` immediately and does NOT change the model's status — which
    is what the real one does (`server_models::load()` spawns the child and returns). A fake that
    flipped the row to `loaded` in the same call would make the watcher untestable and would hide
    the entire landmine this milestone is about.
    """

    def __init__(self, **kw):
        super().__init__(**kw)
        self.loaded = []
        self.unloaded = []

    def __call__(self, cfg, path, body=None, timeout=10.0, method=None):
        if path == "/models/load":
            self.loaded.append((body or {}).get("model"))
            self.calls.append(path)
            return {"success": True}
        if path == "/models/unload":
            self.unloaded.append((body or {}).get("model"))
            self.calls.append(path)
            # Model is gone from the list from here on, so the route's poll terminates.
            self.models = {"object": "list", "data": []}
            return {"success": True}
        return super().__call__(cfg, path, body, timeout, method)


def test_load_answers_LOADING_never_loaded(client, monkeypatch):
    """🔴 THE LANDMINE. llama-server's `{"success":true}` means STARTED — the child is spawned and
    the call returns. A route that answered "loaded" would be reporting the state from BEFORE the
    request, which is the gap 4.7 measured on KoboldCpp at t=0.01 s."""
    f = wire(monkeypatch, LoadingLlama())
    j = client.post("/llama/load", json={"model": "alpha"}).get_json()
    assert j["loading"] is True
    assert "loaded" not in j
    assert f.loaded == ["alpha"]


def test_load_rejects_a_model_the_server_does_not_offer(client, monkeypatch):
    """Checked against the LIVE list rather than posted blind, because llama-server's own 404 is
    masked to "File Not Found" and cannot say which of three things went wrong (§2f.1)."""
    f = wire(monkeypatch, LoadingLlama())
    r = client.post("/llama/load", json={"model": "nope"})
    assert r.status_code == 404
    assert r.get_json()["error"] == "unknown_model"
    assert "nope" in r.get_json()["message"]
    # 🔴 AND NOTHING WAS POSTED. A pre-check that still fires the request is not a pre-check.
    assert f.loaded == []


def test_load_on_a_single_model_server_is_409_with_the_fix(client, monkeypatch):
    """🔴 409, NOT 404. It is a conflict between what was asked and how the server was started,
    and it is fixable in one launch flag — so the body says so. A 404 here would be llama-server's
    masked body wearing a Vocalis badge."""
    f = wire(monkeypatch, LoadingLlama(props=dict(SINGLE_PROPS)))
    r = client.post("/llama/load", json={"model": "alpha"})
    assert r.status_code == 409
    assert r.get_json()["error"] == "llama_not_router"
    assert "--models-preset" in r.get_json()["message"]
    assert f.loaded == [], "a single-model server must never be POSTed a load"


def test_unload_on_a_single_model_server_is_also_409(client, monkeypatch):
    f = wire(monkeypatch, LoadingLlama(props=dict(SINGLE_PROPS)))
    assert client.post("/llama/unload", json={"model": "alpha"}).status_code == 409
    assert f.unloaded == []


def test_load_unconfigured_is_503_and_posts_nothing(client, monkeypatch):
    f = wire(monkeypatch, LoadingLlama(), url="")
    r = client.post("/llama/load", json={"model": "alpha"})
    assert r.status_code == 503 and r.get_json()["error"] == "llama_unconfigured"
    assert f.loaded == []


def test_load_without_a_model_name_is_a_400(client, monkeypatch):
    f = wire(monkeypatch, LoadingLlama())
    assert client.post("/llama/load", json={}).status_code == 400
    assert f.loaded == []


def test_unload_polls_until_the_model_is_actually_gone(client, monkeypatch):
    """The route reports what it OBSERVED, not what llama-server claimed. `{"success":true}` is
    the same START-not-DONE promise on this side too."""
    f = wire(monkeypatch, LoadingLlama())
    j = client.post("/llama/unload", json={"model": "alpha"}).get_json()
    assert f.unloaded == ["alpha"]
    assert j["unloaded"] is True


def test_unload_reports_NO_freed_vram_figure(client, monkeypatch):
    """🔴 DELIBERATELY ABSENT, NOT MISSING. Kobold's route reports a freed figure because 4.7-m0
    MEASURED one on the real box (53.97 -> 0.11 GB). Nothing equivalent has been measured for
    llama.cpp — m0's load half has not run — and a number nobody has watched is exactly the
    invented constant `feedback_never_ship_an_untimed_constant` exists to stop. The route says
    WHETHER it went, which is observable, and nothing about how much."""
    wire(monkeypatch, LoadingLlama())
    j = client.post("/llama/unload", json={"model": "alpha"}).get_json()
    assert "freed_gb" not in j
    assert j["vram_measurable"] is True


def test_unload_remote_says_vram_is_not_measurable(client, monkeypatch):
    wire(monkeypatch, LoadingLlama(), local=False)
    j = client.post("/llama/unload", json={"model": "alpha"}).get_json()
    assert j["vram_measurable"] is False


def test_a_bad_key_blocks_the_write_routes_before_they_post(client, monkeypatch):
    """The mode gate runs FIRST, so an auth failure is reported as one — and, more importantly,
    nothing is sent to a server that has already refused us."""
    f = wire(monkeypatch, LoadingLlama(fail=llama.LlamaAuthFailed("rejected the API key")))
    r = client.post("/llama/load", json={"model": "alpha"})
    assert r.status_code == 502 and r.get_json()["error"] == "llama_auth"
    assert f.loaded == []
