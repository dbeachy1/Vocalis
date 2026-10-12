"""9.5-m1 — the llama.cpp engine.

Everything here runs on the Windows dev box with NO llama-server, which is the point: the API is
mocked at the HTTP boundary and no test may depend on a real one.

Fixtures follow the router response contract; exact field names and error text are wire behavior.
The fixture uses synthetic models and a no-load request path that the browser consumes.
The contract pins specific field names such as `models_dir`
rather than `dir`, and the generic `File Not Found` for a 404.
fixture invented to match the matcher proves only that the matcher matches itself.
"""
import json
import socket
import urllib.error

import pytest

import llama
import modelhost


# ── fixtures, shaped from the real router's answers ──────────────────────────

ROUTER_PROPS = {"role": "router", "max_instances": 1, "models_autoload": False,
                "model_alias": "llama-server", "model_path": "none",
                "build_info": "b10625-0cc5b1495"}

#: A single-model server answers the loaded model's own props and carries NO `role` key. That
#: absence is the entire mode probe, so it is asserted rather than assumed.
SINGLE_PROPS = {"model_alias": "/ai-models/Some-Model-IQ4_XS.gguf",
                "model_path": "/ai-models/Some-Model-IQ4_XS.gguf",
                "model_ftype": "IQ4_XS - 4.25 bpw", "total_slots": 1,
                "endpoint_slots": True, "endpoint_metrics": True, "endpoint_props": False}

MODELS = {"object": "list", "data": [
    {"id": "Qwen3-0.6B-Q4_0", "aliases": [], "tags": [], "object": "model",
     "owned_by": "llamacpp", "source": "models_dir", "can_remove": False,
     "status": {"value": "unloaded",
                "args": ["llama-server", "--alias", "Qwen3-0.6B-Q4_0", "--n-gpu-layers", "0"],
                "preset": "[Qwen3-0.6B-Q4_0]\nn-gpu-layers = 0\n"},
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}},
    {"id": "gemma-3-270m-Q8_0", "aliases": [], "tags": [], "object": "model",
     "owned_by": "llamacpp", "source": "models_dir", "can_remove": False,
     "status": {"value": "loaded", "args": ["llama-server"]},
     "meta": {"n_ctx": 38912, "n_ctx_train": 131072, "n_params": 110468824832,
              "size": 60796861440, "ftype": "IQ4_XS - 4.25 bpw"},
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}},
]}


def cfg(**kw):
    kw.setdefault("url", "http://127.0.0.1:8080")
    return llama.LlamaConfig(**kw)


@pytest.fixture
def wire(monkeypatch):
    """Record every request and answer from a scripted table. The RECORDING is the point: three
    tests below assert on the headers, which is the only way to prove the key rides along."""
    sent = []

    def fake(c, path, body=None, timeout=10.0, method=None):
        sent.append({"path": path, "body": body, "key": c.api_key})
        if path == "/health":
            return {"status": "ok"}
        if path == "/props":
            return dict(ROUTER_PROPS)
        if path.startswith("/models"):
            return json.loads(json.dumps(MODELS))
        raise AssertionError(f"unscripted path {path!r}")

    monkeypatch.setattr(llama, "_request", fake)
    return sent


# ── config resolution ────────────────────────────────────────────────────────

def test_the_url_has_NO_default(monkeypatch):
    """🔴 THE ONE PLACE THIS DELIBERATELY DIFFERS FROM `kobold.resolve_config`, AND IT IS LOAD
    BEARING. Kobold defaults to https://127.0.0.1:5001, which is right for it because its sub-tab
    gates on the admin password instead. Here the URL IS the gate (§4c), so a default would make
    `configured()` true on every box on earth and light up a sub-tab for a server nobody runs."""
    monkeypatch.delenv("VOCALIS_LLAMA_URL", raising=False)
    c = llama.resolve_config({})
    assert c.url == ""
    assert llama.configured(c) is False


def test_configured_is_the_URL_not_the_credential(monkeypatch):
    """A working llama-server needs no key: `--api-key` is optional and this configuration runs without one.
    Gating the sub-tab on a credential would disable an engine that works perfectly."""
    monkeypatch.delenv("VOCALIS_LLAMA_URL", raising=False)
    monkeypatch.delenv("VOCALIS_LLAMA_API_KEY", raising=False)
    c = llama.resolve_config({"llama": {"url": "http://127.0.0.1:8080"}})
    assert c.api_key == ""
    assert llama.configured(c) is True


def test_env_beats_settings_and_the_trailing_slash_goes(monkeypatch):
    monkeypatch.setenv("VOCALIS_LLAMA_URL", "http://llama.example.invalid:9099/")
    c = llama.resolve_config({"llama": {"url": "http://127.0.0.1:8080"}})
    assert c.url == "http://llama.example.invalid:9099"


def test_the_key_comes_from_the_ROUTED_section_not_app_settings(monkeypatch):
    """The credential lives in the encrypted file. A key in app_settings.yaml is a key in the
    wrong file and must NOT be honored — otherwise the plaintext copy silently becomes live."""
    monkeypatch.delenv("VOCALIS_LLAMA_API_KEY", raising=False)
    c = llama.resolve_config({"llama": {"url": "http://x:1", "api_key": "PLAINTEXT"}},
                             {"api_key": "sk-routed"})
    assert c.api_key == "sk-routed"


def test_a_hand_edited_scalar_does_not_raise(monkeypatch):
    monkeypatch.delenv("VOCALIS_LLAMA_URL", raising=False)
    assert llama.resolve_config({"llama": "oops"}).url == ""


def test_local_uses_the_shared_policy_including_the_hostname_branch(monkeypatch):
    """`local` gates every VRAM claim. It comes from `modelhost`, which `kobold` also uses — one
    implementation, so the two engines cannot drift into disagreeing about the same host."""
    monkeypatch.delenv("VOCALIS_LLAMA_LOCAL", raising=False)
    assert llama.resolve_config({"llama": {"url": "http://127.0.0.1:8080"}}).local is True
    assert llama.resolve_config(
        {"llama": {"url": f"http://{socket.gethostname()}:8080"}}).local is True
    assert llama.resolve_config({"llama": {"url": "http://some-other-box.example:8080"}}).local is False
    # The explicit override is the escape hatch for a container or a reverse proxy.
    assert llama.resolve_config(
        {"llama": {"url": "http://some-other-box:8080", "local": True}}).local is True


def test_llama_and_kobold_share_ONE_locality_implementation():
    """🔴 THE ANTI-DRIFT ASSERTION. Two engines answering "is this host mine?" differently is how
    a remote box gets treated as local and a credential goes onto a LAN hop. Both delegate to
    `modelhost.is_local_url`, and this pins that they agree on the same inputs."""
    import kobold
    for url in ("http://127.0.0.1:1", f"http://{socket.gethostname()}:1", "http://elsewhere:1"):
        assert kobold._is_local(url) is modelhost.is_local_url(url), url


# ── the state machine, and the one that holds no VRAM ────────────────────────

@pytest.mark.parametrize("status, running, vram", [
    ("loaded", True, True),
    # 🔴 THE LANDMINE. `sleeping` is routable and is_running() -- and holds NOTHING, because
    # --sleep-idle-seconds unloads the model and its KV cache. Painting it as loaded reports a
    # model sitting on cards that are empty.
    ("sleeping", True, False),
    ("loading", True, False),
    ("unloaded", False, False),
    ("downloading", False, False),
    ("downloaded", False, False),
])
def test_running_and_holds_vram_are_DIFFERENT_questions(status, running, vram):
    assert (status in llama.RUNNING_STATUSES) is running
    assert llama.holds_vram(status) is vram


# ── the HTTP boundary ────────────────────────────────────────────────────────

def test_an_unset_url_says_NOT_CONFIGURED_rather_than_ValueError():
    """An empty URL reaches urllib as an unknown URL type unless the caller handles it first.

    Convert this configuration error into an actionable not-configured message before the broad
    connection-error handler turns it into an unhelpful reachability failure.
    """
    with pytest.raises(llama.LlamaUnreachable) as e:
        llama._request(llama.LlamaConfig(url=""), "/health")
    assert "no URL configured" in str(e.value)


def _http_error(code):
    def raise_it(*a, **kw):
        raise urllib.error.HTTPError("http://x/y", code, "boom", {}, None)
    return raise_it


def test_a_401_is_its_own_exception_with_an_actionable_message(monkeypatch):
    """Unlike KoboldCpp — which reports a wrong password as a 200 with an empty list,
    indistinguishable from four other states — llama-server says 401 when it means 401."""
    monkeypatch.setattr(llama.urllib.request, "urlopen", _http_error(401))
    with pytest.raises(llama.LlamaAuthFailed) as e:
        llama._request(cfg(api_key="wrong"), "/props")
    assert "API key" in str(e.value)


def test_a_404_names_ALL_THREE_causes_and_never_quotes_the_server(monkeypatch):
    """The HTTP client replaces the server's 404 body with a generic file-not-found message.

    Unknown model, wrong URL, and a non-router endpoint therefore need an actionable shared
    response that does not imply a local file is missing.
    """
    monkeypatch.setattr(llama.urllib.request, "urlopen", _http_error(404))
    with pytest.raises(llama.LlamaUnreachable) as e:
        llama._request(cfg(), "/models/load", body={"model": "x"})
    msg = str(e.value)
    assert llama.MASKED_404_MESSAGE not in msg, "the masked body must not be quoted at the user"
    assert "not one it offers" in msg and "URL is wrong" in msg and "-m" in msg


def test_the_key_rides_on_EVERY_call_including_status_reads(wire):
    """One header, and it removes a whole class of "why is this 401 only sometimes". The same
    reasoning as `kobold._request` sending its Bearer unconditionally."""
    c = cfg(api_key="sk-abc")
    llama.health(c)
    llama.props(c)
    llama.list_models(c)
    assert [s["key"] for s in wire] == ["sk-abc"] * 3


# ── mode, and why it is asked of /props ──────────────────────────────────────

def test_router_mode_is_read_from_the_role_key(wire):
    assert llama.mode(cfg()) == "router"


def test_a_single_model_server_has_NO_role_key(monkeypatch):
    monkeypatch.setattr(llama, "_request",
                        lambda c, p, body=None, timeout=10.0, method=None: dict(SINGLE_PROPS))
    assert llama.mode(cfg()) == "single"


def test_available_is_false_and_never_raises_when_unconfigured():
    ok, why = llama.available(llama.LlamaConfig(url=""))
    assert ok is False and "no llama.cpp URL" in why


# ── the model list ───────────────────────────────────────────────────────────

def test_rows_carry_the_fields_the_tab_renders(wire):
    rows = llama.list_models(cfg())
    by_id = {r["id"]: r for r in rows}
    loaded = by_id["gemma-3-270m-Q8_0"]
    assert loaded["status"] == "loaded" and loaded["running"] and loaded["holds_vram"]
    assert loaded["meta"]["n_ctx"] == 38912 and loaded["meta"]["n_ctx_train"] == 131072
    unloaded = by_id["Qwen3-0.6B-Q4_0"]
    assert unloaded["holds_vram"] is False
    # 📌 OBSERVED, not guessed: the router GENERATES a preset section for --models-dir entries, so
    # the detail line works with no preset file in existence and works remotely.
    assert unloaded["source"] == "models_dir"
    assert unloaded["preset"].startswith("[Qwen3-0.6B-Q4_0]")
    assert unloaded["args"][0] == "llama-server"


def test_a_crashed_load_is_distinguishable_from_never_asked(monkeypatch):
    """`is_failed()` is UNLOADED *with* a non-zero exit code (server-models.h:101-103). Without
    the flag a model that crashed on load reads exactly like one nobody wanted."""
    # ⚠️ NOT named `body`: the stub's own parameter is `body`, and a lambda closing over a name
    # its parameter shadows returns the PARAMETER (None) rather than the fixture. Caught by this
    # test failing on its first run, which is the cheapest possible place to catch it.
    crashed = {"object": "list", "data": [
        {"id": "boom", "status": {"value": "unloaded", "failed": True, "exit_code": 1}}]}
    monkeypatch.setattr(llama, "_request",
                        lambda c, p, body=None, timeout=10.0, method=None: crashed)
    r = llama.list_models(cfg())[0]
    assert r["failed"] is True and r["exit_code"] == 1 and r["holds_vram"] is False


def test_the_list_is_sorted_by_id_and_by_NOTHING_ELSE(wire):
    """The ID is a preset section name or filename and is data. Sort by ID alone; do not infer meaning
    from filename contents."""
    assert [r["id"] for r in llama.list_models(cfg())] == ["gemma-3-270m-Q8_0", "Qwen3-0.6B-Q4_0"]


def test_a_non_list_data_is_an_error_not_an_empty_tab(monkeypatch):
    monkeypatch.setattr(llama, "_request",
                        lambda c, p, body=None, timeout=10.0, method=None: {"data": "nope"})
    with pytest.raises(llama.LlamaUnreachable):
        llama.list_models(cfg())


def test_reload_is_only_sent_when_asked(wire):
    """`?reload=1` makes the server re-read its sources — real work. The status poll runs every
    few seconds and must stay cheap, so it must never carry it."""
    llama.list_models(cfg())
    llama.list_models(cfg(), reload=True)
    assert [s["path"] for s in wire] == ["/models", "/models?reload=1"]


# ── status ───────────────────────────────────────────────────────────────────

def test_loaded_means_holding_vram_not_merely_running(monkeypatch):
    """The headline bool the tab and the render-conflict offer both read. A sleeping model would
    make `running` true while the cards are empty."""
    body = {"object": "list", "data": [{"id": "z", "status": {"value": "sleeping"}}]}

    def fake(c, path, body_=None, timeout=10.0, method=None, **kw):
        return dict(ROUTER_PROPS) if path == "/props" else body
    monkeypatch.setattr(llama, "_request", fake)
    st = llama.status(cfg())
    assert st["running"] == ["z"]
    assert st["loaded"] is False


def test_status_reports_the_router_flags_it_does_not_control(wire):
    """`max_instances` and `models_autoload` are LAUNCH flags. A UI that silently assumes 1 will
    be wrong on somebody's box — and with autoload on, a model can appear because SillyTavern
    asked for it, with no click in Vocalis at all."""
    st = llama.status(cfg())
    assert st["max_instances"] == 1 and st["models_autoload"] is False


# ── load / unload / is_loaded (m2) ───────────────────────────────────────────

def test_load_and_unload_post_the_model_by_name(wire):
    llama.load(cfg(), "alpha")
    llama.unload(cfg(), "alpha")
    assert [(s["path"], s["body"]) for s in wire] == [
        ("/models/load", {"model": "alpha"}),
        ("/models/unload", {"model": "alpha"}),
    ]


@pytest.mark.parametrize("status, ready", [
    ("loaded", True),
    # 🔴 BOTH OF THESE ARE `is_running()` AND NEITHER IS READY. `loading` is precisely the state
    # the watcher is waiting to LEAVE, so accepting it would declare victory on the first poll
    # after the request — the request that has not finished yet. `sleeping` is routable and holds
    # nothing, so accepting it would report a model onto cards that are empty.
    ("loading", False),
    ("sleeping", False),
    ("unloaded", False),
])
def test_is_loaded_accepts_ONLY_loaded(monkeypatch, status, ready):
    body = {"object": "list", "data": [{"id": "alpha", "status": {"value": status}}]}
    monkeypatch.setattr(llama, "_request",
                        lambda c, p, body_=None, timeout=10.0, method=None, **kw: body)
    assert llama.is_loaded(cfg(), "alpha") is ready


def test_is_loaded_is_false_for_a_model_that_is_not_listed(wire):
    assert llama.is_loaded(cfg(), "no-such-model") is False


# ── p8 / m3: the KV-cache probe ──────────────────────────────────────────────
#
# 🔴 THE DESIGN ROW'S GATE IS WRONG AND THESE TESTS ARE WHERE THAT IS RECORDED. It says to read
# `endpoint_slots` / `endpoint_metrics` off `/props` and hide the panel when they are absent.
# The supported `/props` response omits both fields —
# its whole key set is build_info, cors_proxy_enabled, default_generation_settings, max_instances,
# model_alias, model_path, models_autoload, role, ui_settings. A panel gated that way would be
# hidden despite a working router and look like a panel working as designed, which is the
# worst failure available to a feature whose contract is "hide rather than show it broken".
#
# The two 400 bodies below are quoted from that box, not invented.

def test_the_slots_probe_addresses_the_model_because_router_mode_demands_it(wire, monkeypatch):
    """Bare `/slots` on a router answers 400 `model name is missing from the request`."""
    monkeypatch.setattr(llama, "_request",
                        lambda c, path, **kw: [{"n_prompt_tokens_cache": 512, "n_ctx": 8192}]
                        if path.startswith("/slots?model=") else pytest.fail(f"bare {path}"))
    assert llama.kv_cache(cfg(), "alpha-70b") == {"n_prompt_tokens_cache": 512, "n_ctx": 8192}


def test_the_model_name_is_url_quoted(monkeypatch):
    seen = []

    def fake(c, path, **kw):
        seen.append(path)
        return []

    monkeypatch.setattr(llama, "_request", fake)
    llama.kv_cache(cfg(), "chat/glm steam")
    assert seen == ["/slots?model=chat/glm%20steam"] or seen == ["/slots?model=chat%2Fglm%20steam"], seen


@pytest.mark.parametrize("boom", [
    llama.LlamaUnreachable("HTTP 400 from http://x/slots"),   # `model is not loaded` — not a fault
    llama.LlamaUnreachable("HTTP 400 from http://x/slots"),   # `model name is missing`
    llama.LlamaAuthFailed("bad key"),
    llama.LlamaUnreachable("down"),
])
def test_every_failure_is_nothing_to_show_never_an_error(boom, monkeypatch):
    """🔴 `{}` IS THE ONLY FAILURE MODE. This is a decoration on a status panel; a decoration that
    can turn a working tab into an error card is worse than no decoration. `model is not loaded`
    in particular is the NORMAL state of a router with nothing resident."""
    def fake(c, path, **kw):
        raise boom

    monkeypatch.setattr(llama, "_request", fake)
    assert llama.kv_cache(cfg(), "alpha-70b") == {}


def test_a_blank_name_never_reaches_the_wire(monkeypatch):
    monkeypatch.setattr(llama, "_request",
                        lambda c, path, **kw: pytest.fail("asked with no model name"))
    assert llama.kv_cache(cfg(), "") == {}
    assert llama.kv_cache(cfg(), "   ") == {}


def test_only_the_allowlisted_numbers_come_back_and_the_PROMPT_never_does(monkeypatch):
    """🔴 A SLOT CARRIES USER-AUTHORED PROMPT TEXT. An allowlist rather than passthrough,
    for the reason `wbedit/backends/base.py` gives one directory over: user-authored content has no business
    in a status panel, and it travels further than anyone expects once it is in one."""
    monkeypatch.setattr(llama, "_request", lambda c, path, **kw: [{
        "n_prompt_tokens_cache": 4096,
        "n_ctx": 32768,
        "prompt": "Test User's synthetic worldbook entry text",
        "next_token": {"logits": [1, 2, 3]},
        "id_task": 7,
    }])
    out = llama.kv_cache(cfg(), "alpha-70b")
    assert out == {"n_prompt_tokens_cache": 4096, "n_ctx": 32768}
    # NOT `any("prompt" in k)` - that substring is inside the legitimate
    # `n_prompt_tokens_cache`, and the first draft of this test failed on its own success.
    assert "prompt" not in out and "next_token" not in out and "id_task" not in out
    assert "Test User" not in json.dumps(out)


def test_a_bool_is_not_a_count(monkeypatch):
    """`isinstance(True, int)` is True in Python, and `n_past: true` is not a token count."""
    monkeypatch.setattr(llama, "_request",
                        lambda c, path, **kw: [{"n_past": True, "n_ctx": 4096}])
    assert llama.kv_cache(cfg(), "a") == {"n_ctx": 4096}


def test_an_empty_or_shapeless_body_is_nothing_to_show(monkeypatch):
    for body in ([], {}, [{}], [None], "not json at all", [{"unrelated": 1}]):
        monkeypatch.setattr(llama, "_request", lambda c, path, _b=body, **kw: _b)
        assert llama.kv_cache(cfg(), "a") == {}, body


def test_an_object_body_is_accepted_as_well_as_a_list(monkeypatch):
    """Never measured against a real body, so the parse takes both shapes rather than betting on
    one. The module's own KV_FIELDS note says to tighten this once someone has looked at one."""
    monkeypatch.setattr(llama, "_request", lambda c, path, **kw: {"n_prompt_tokens_cache": 1})
    assert llama.kv_cache(cfg(), "a") == {"n_prompt_tokens_cache": 1}
