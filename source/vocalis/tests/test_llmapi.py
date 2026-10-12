"""LLM API routes in `src/llmapi.py`.

Driven against `fake_llm_providers.FakeProvider`, a real HTTP server, through the same base-URL
override production honours — so the path, the header, the query string and the response parse
are all on the wire and all under test (the fake's header says why a stubbed `_request` is not
enough).

The tests cover write-only key storage, search-based model selection, and Connect status handling
through the `/llm/api/*` and `/llm/engine` routes."""
from __future__ import annotations

import ast
import socket
from pathlib import Path

import pytest

from conftest import REPO_ROOT

import llmapi
import voice_utils
import vocalis_server as vs
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import paths
from wbedit.backends.base import BackendRefused, TransportError

from fake_llm_providers import GOOD_KEY, LEAK, FakeProvider


@pytest.fixture
def settings_file(monkeypatch, tmp_path):
    p = tmp_path / "app_settings.yaml"
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", p)
    return p


@pytest.fixture
def client(settings_file):
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    """The OpenRouter catalogue cache is module state; one test's catalogue must not answer the
    next test's search."""
    monkeypatch.setattr(llmapi, "_OR_CACHE", {})


@pytest.fixture
def openrouter(monkeypatch):
    f = FakeProvider("openrouter").start()
    monkeypatch.setenv("VOCALIS_OPENROUTER_URL", f.url)
    monkeypatch.delenv("VOCALIS_OPENROUTER_API_KEY", raising=False)
    yield f
    f.stop()


@pytest.fixture
def featherless(monkeypatch):
    f = FakeProvider("featherless").start()
    monkeypatch.setenv("VOCALIS_FEATHERLESS_URL", f.url)
    monkeypatch.delenv("VOCALIS_FEATHERLESS_API_KEY", raising=False)
    yield f
    f.stop()


def _cfg(fake, key=GOOD_KEY):
    return llmapi.ApiConfig(provider=fake.kind, base_url=fake.url, api_key=key)


# ── config ───────────────────────────────────────────────────────────────────

def test_the_key_comes_from_the_encrypted_section_and_env_wins(monkeypatch):
    monkeypatch.delenv("VOCALIS_OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("VOCALIS_OPENROUTER_URL", raising=False)
    cfg = llmapi.resolve_config("openrouter", {}, {"api_key": "from-vault"})
    assert cfg.api_key == "from-vault" and cfg.base_url == "https://openrouter.ai/api"
    monkeypatch.setenv("VOCALIS_OPENROUTER_API_KEY", "from-env")
    assert llmapi.resolve_config("openrouter", {}, {"api_key": "from-vault"}).api_key == "from-env"


def test_an_app_settings_copy_of_the_key_is_IGNORED(monkeypatch):
    """A key in app_settings.yaml would be a key in plaintext. Only the routed section counts."""
    monkeypatch.delenv("VOCALIS_FEATHERLESS_API_KEY", raising=False)
    s = {"llm_api": {"featherless": {"api_key": "plaintext-oops"}}}
    assert llmapi.resolve_config("featherless", s, {}).api_key == ""


def test_the_config_repr_never_prints_the_key():
    cfg = llmapi.ApiConfig("openrouter", "https://x", api_key="sk-very-secret")
    assert "sk-very-secret" not in repr(cfg)


def test_both_secret_sections_are_allowlisted():
    """9.5-m1's defect (a): a section missing here raises ValueError on the FIRST READ of a stored
    key — after it has been saved. Read both through the real allowlist."""
    for p in ("openrouter", "featherless"):
        assert voice_utils.get_section(paths.VOICE_SETTINGS, p) == {}


# ── connect ──────────────────────────────────────────────────────────────────

def test_openrouter_connect_reports_the_keys_own_credit(openrouter):
    res = llmapi.connect(_cfg(openrouter))
    assert res["ok"] and "$7.50 left of this key's $10.00 limit" in res["message"]
    assert "$2.50 in total" in res["message"]


def test_a_key_with_no_limit_never_reads_as_a_balance(openrouter):
    """When a key has no limit, do not present total account usage as an available balance. Label the
key's monthly spend and total usage explicitly."""
    openrouter.key_record = {"limit": None, "limit_remaining": None, "usage": 51.64,
                             "usage_monthly": 3.2, "is_free_tier": False}
    msg = llmapi.connect(_cfg(openrouter))["message"]
    assert "account balance is not visible" in msg
    assert "this key has spent $3.20 this month" in msg and "$51.64 in total" in msg
    assert "used" not in msg
    assert openrouter.requests[-1][1] == "/v1/key"
    assert openrouter.requests[-1][2] == f"Bearer {GOOD_KEY}"


def test_a_bad_key_is_a_refusal_naming_the_fix(openrouter):
    with pytest.raises(llmapi.ApiRefused) as e:
        llmapi.connect(_cfg(openrouter, key="sk-wrong"))
    assert e.value.status == 401 and "rejected the API key" in str(e.value)


def test_a_timeout_is_unreachable_not_refused(openrouter, monkeypatch):
    def boom(*a, **k):
        raise socket.timeout("timed out")
    monkeypatch.setattr(llmapi.urllib.request, "urlopen", boom)
    with pytest.raises(llmapi.ApiUnreachable) as e:
        llmapi.connect(_cfg(openrouter))
    assert "timed out" in str(e.value)


def test_every_request_names_itself_or_featherless_bans_it(featherless):
    """The fake Featherless endpoint rejects urllib's default user agent, matching the provider's
    request policy."""
    assert llmapi.connect(_cfg(featherless))["ok"]


def test_a_bot_block_is_never_reported_as_a_bad_key(featherless, monkeypatch):
    monkeypatch.setattr(llmapi, "USER_AGENT", "Python-urllib/3.10")
    with pytest.raises(llmapi.ApiRefused) as e:
        llmapi.connect(_cfg(featherless))
    assert "firewall blocked the request before the key was checked" in str(e.value)
    assert "rejected the API key" not in str(e.value)


def test_featherless_connect_reads_the_plan(featherless):
    res = llmapi.connect(_cfg(featherless))
    assert res["ok"] and "Premium" in res["message"] and "4 concurrency units" in res["message"]


def test_featherless_falls_back_ONLY_when_the_plan_route_is_missing(featherless):
    featherless.plan_status = 404
    res = llmapi.connect(_cfg(featherless))
    # The /v1/models route answers unauthenticated calls, so this path proves the service
    # answered, NOT that the key is good — it must never paint a ✓.
    assert res["ok"] is False and "key could not be checked" in res["message"]
    assert any(p.startswith("/v1/models?") for p in featherless.paths())


def test_featherless_bad_key_on_the_plan_route_is_NOT_retried_elsewhere(featherless):
    """/v1/models answers unauthenticated calls, so falling back on a 401 could report a wrong
    key as fine. Only a 404 falls back."""
    with pytest.raises(llmapi.ApiRefused):
        llmapi.connect(_cfg(featherless, key="sk-wrong"))
    assert featherless.paths("/v1/models") == []


# ── search ───────────────────────────────────────────────────────────────────

def test_openrouter_search_ranks_id_prefix_matches_first_and_caps_rows(openrouter):
    rows = llmapi.search(_cfg(openrouter), "glm")
    ids = [r["id"] for r in rows]
    assert ids[:3] == ["z-ai/glm-4.6", "z-ai/glm-4.5-air", "thudm/glm-z1-32b"]
    assert "acme/fusion-8b" in ids and ids.index("acme/fusion-8b") == 3   # name match, ranked last
    assert rows[0]["price_in"] == 0.6 and rows[0]["price_out"] == 2.2
    assert len(llmapi.search(_cfg(openrouter), "model")) == llmapi.SEARCH_LIMIT


def test_every_term_must_match(openrouter):
    assert [r["id"] for r in llmapi.search(_cfg(openrouter), "glm air")] == ["z-ai/glm-4.5-air"]


def test_the_openrouter_catalogue_is_fetched_once_then_aged_out(openrouter, monkeypatch):
    t = [1000.0]
    monkeypatch.setattr(llmapi, "_now", lambda: t[0])
    cfg = _cfg(openrouter)
    llmapi.search(cfg, "glm")
    llmapi.search(cfg, "vendor")
    assert len(openrouter.paths("/v1/models")) == 1, "a keystroke is not an upstream request"
    t[0] += llmapi.OPENROUTER_CACHE_SECONDS + 1
    llmapi.search(cfg, "glm")
    assert len(openrouter.paths("/v1/models")) == 2


def test_featherless_search_goes_upstream_with_the_plan_filter(featherless):
    rows = llmapi.search(_cfg(featherless), "GLM")
    ids = [r["id"] for r in rows]
    assert "big-lab/GLM-Huge" not in ids, "a model the plan cannot run was offered"
    assert ids == ["zai-org/GLM-4.6", "zai-org/GLM-4-32B-0414"]
    q = featherless.paths("/v1/models?")[-1]
    assert "q=GLM" in q and "available_on_current_plan=true" in q and "per_page=50" in q


def test_an_empty_query_asks_nobody(openrouter):
    assert llmapi.search(_cfg(openrouter), "   ") == []
    assert openrouter.requests == []


# ── the pass transport ───────────────────────────────────────────────────────

def _chat(fake, key=GOOD_KEY):
    return llmapi.chat_post(_cfg(fake, key))("/v1/chat/completions", {
        "model": "z-ai/glm-4.6", "messages": [{"role": "user", "content": "FIELD\nhello"}]}, 30.0)


def test_a_refused_key_ends_the_pass_WITHOUT_the_providers_words(openrouter):
    """I16: the provider's error body is not ours to trust — the fake's carries a sentinel, the
    shape of a moderation refusal quoting the flagged input."""
    with pytest.raises(BackendRefused) as e:
        _chat(openrouter, key="sk-wrong")
    assert "rejected the API key" in str(e.value) and LEAK not in str(e.value)
    assert not isinstance(e.value, TransportError), "a refusal must not be retried"


def test_out_of_credit_and_unknown_model_are_refusals_too(openrouter):
    openrouter.chat_failures = [(402, {"error": {"message": LEAK}}, {}),
                                (404, {"error": {"message": LEAK}}, {}),
                                (400, {"error": {"message": LEAK}}, {})]
    for want in ("out of credit", "does not know the model 'z-ai/glm-4.6'", "HTTP 400"):
        with pytest.raises(BackendRefused) as e:
            _chat(openrouter)
        assert want in str(e.value) and LEAK not in str(e.value)


def test_a_429_waits_retry_after_capped_then_retries(featherless, monkeypatch):
    waited = []
    monkeypatch.setattr(llmapi, "_sleep", waited.append)
    featherless.chat_failures = [(429, {"error": "busy"}, {"Retry-After": "7"}),
                                 (429, {"error": "busy"}, {"Retry-After": "999"}),
                                 (429, {"error": "busy"}, {})]
    for _ in range(3):
        with pytest.raises(TransportError):
            _chat(featherless)
    assert waited == [7.0, llmapi.BUSY_WAIT_CAP, llmapi.BUSY_WAIT_DEFAULT]


def test_a_5xx_is_a_transport_error_the_runner_retries(openrouter):
    openrouter.chat_failures = [(503, {"error": "down"}, {})]
    with pytest.raises(TransportError):
        _chat(openrouter)
    assert _chat(openrouter)["choices"][0]["message"]["content"]


# ── routes: the key is write-only ────────────────────────────────────────────

def test_the_key_never_comes_back_asserted_with_one_SET(client, openrouter, settings_file):
    r = client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
    assert r.status_code == 200 and r.get_json() == {"ok": True, "key_set": True}
    body = client.get("/llm/api").get_data(as_text=True)
    assert GOOD_KEY not in body
    view = {p["id"]: p for p in client.get("/llm/api").get_json()["providers"]}
    assert view["openrouter"]["key_set"] is True and view["featherless"]["key_set"] is False
    assert not settings_file.exists() or GOOD_KEY not in settings_file.read_text(encoding="utf-8")
    assert voice_utils.get_section(paths.VOICE_SETTINGS, "openrouter")["api_key"] == GOOD_KEY


def test_an_empty_key_removes_it_and_a_missing_one_is_a_400(client, openrouter):
    client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
    assert client.put("/llm/api/openrouter/key", json={}).status_code == 400
    client.put("/llm/api/openrouter/key", json={"api_key": ""})
    view = {p["id"]: p for p in client.get("/llm/api").get_json()["providers"]}
    assert view["openrouter"]["key_set"] is False


def test_an_unknown_provider_is_a_404(client):
    assert client.put("/llm/api/nope/key", json={"api_key": "x"}).status_code == 404
    assert client.get("/llm/api/nope/models?q=ab").status_code == 404


# ── routes: connect ──────────────────────────────────────────────────────────

def test_connect_is_ALWAYS_200_and_is_remembered(client, openrouter):
    client.put("/llm/api/openrouter/key", json={"api_key": "sk-wrong"})
    r = client.post("/llm/api/openrouter/connect")
    assert r.status_code == 200 and r.get_json()["ok"] is False
    assert "rejected the API key" in r.get_json()["message"]
    client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
    view = {p["id"]: p for p in client.get("/llm/api").get_json()["providers"]}
    assert view["openrouter"]["last_connect"] is None, "a verdict about the OLD key survived"
    r = client.post("/llm/api/openrouter/connect")
    assert r.status_code == 200 and r.get_json()["ok"] is True
    view = {p["id"]: p for p in client.get("/llm/api").get_json()["providers"]}
    assert view["openrouter"]["last_connect"]["ok"] is True
    assert "key OK" in view["openrouter"]["last_connect"]["message"]


# ── routes: search and pick ──────────────────────────────────────────────────

def test_there_is_no_browse_only_search(client, openrouter):
    client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
    assert client.get("/llm/api/openrouter/models").get_json()["models"] == []
    assert client.get("/llm/api/openrouter/models?q=g").get_json()["models"] == []
    assert openrouter.requests == [], "a one-character query reached the provider"
    rows = client.get("/llm/api/openrouter/models?q=glm").get_json()["models"]
    assert rows[0]["id"] == "z-ai/glm-4.6"


def test_search_without_a_key_says_so(client, openrouter):
    r = client.get("/llm/api/openrouter/models?q=glm")
    assert r.status_code == 409 and "API key" in r.get_json()["message"]


def test_a_pick_keeps_only_allowlisted_facts(client, openrouter, settings_file):
    r = client.put("/llm/api/openrouter/model", json={
        "id": "z-ai/glm-4.6",
        "meta": {"name": "GLM 4.6", "context_length": 202752, "price_in": 0.6,
                 "supported_parameters": ["min_p"], "evil": "<script>", "price_out": "NaN"}})
    view = r.get_json()
    assert view["model"] == "z-ai/glm-4.6"
    assert view["model_meta"] == {"name": "GLM 4.6", "context_length": 202752, "price_in": 0.6,
                                  "supported_parameters": ["min_p"]}
    assert "<script>" not in settings_file.read_text(encoding="utf-8")
    assert client.put("/llm/api/openrouter/model", json={"id": ""}).get_json()["model"] == ""


# ── routes: the engine choice ────────────────────────────────────────────────

def test_the_engine_defaults_to_kobold_and_greys_out_what_is_missing(client, monkeypatch):
    import llama
    from vocalis.web import llama as web_llama
    monkeypatch.setattr(web_llama, "_llama_cfg", lambda: llama.LlamaConfig(url=""))
    j = client.get("/llm/engine").get_json()
    assert j["engine"] == "kobold"
    by = {e["id"]: e for e in j["engines"]}
    assert [e["id"] for e in j["engines"]] == ["llama", "kobold", "openrouter", "featherless"]
    assert by["kobold"]["usable"] and not by["llama"]["usable"]
    assert "no API key" in by["openrouter"]["reason"]


def test_a_provider_is_usable_only_with_a_key_AND_a_pick(client, openrouter):
    client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
    by = {e["id"]: e for e in client.get("/llm/engine").get_json()["engines"]}
    assert "no model picked" in by["openrouter"]["reason"]
    client.put("/llm/api/openrouter/model", json={"id": "z-ai/glm-4.6"})
    by = {e["id"]: e for e in client.get("/llm/engine").get_json()["engines"]}
    assert by["openrouter"]["usable"] is True


def test_the_engine_put_saves_and_rejects_nonsense(client, settings_file):
    assert client.put("/llm/engine", json={"engine": "gpt-9"}).status_code == 400
    assert client.put("/llm/engine", json={"engine": "openrouter"}).get_json()["engine"] == \
        "openrouter"
    assert rt_settings.load_app_settings()["wbedit_engine"] == "openrouter"


# ── the amended I18: who may talk to a hosted provider ───────────────────────

def test_only_the_editor_path_imports_llmapi():
    """I18 as amended in 11.1: nothing leaves the machine unless a hosted provider is selected as
    the worldbook editor's engine. So exactly two modules may import the provider client — the
    API tab's routes and the editor's engine selector. Parsed, never grepped: a docstring that
    mentions `import llmapi` is prose, not an import."""
    src = Path(REPO_ROOT) / "src"
    importers = set()
    for py in src.rglob("*.py"):
        if "__pycache__" in py.parts:
            continue
        tree = ast.parse(py.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            if "llmapi" in names:
                importers.add(py.relative_to(src).as_posix())
    assert importers == {"vocalis/web/llmapi.py", "vocalis/web/llm_engine.py"}, importers


# ── hosted-provider regressions ────────────────────────────────────────────

def _no_slice_of(key: str, text: str, n: int = 4) -> bool:
    """True when no n-character slice of `key` (plain or backslash-escaped) is in `text`.
    The second review pass: a check for one long substring passed while ten characters of the key
    were still sitting in the message."""
    forms = {key, key.encode("unicode_escape").decode("ascii")}
    return not any(f[i:i + n] in text for f in forms for i in range(len(f) - n + 1)
                   if f[i:i + n].strip() and f[i:i + n] not in ("\\n", "Bear"))


def test_a_key_no_header_can_carry_is_refused_with_a_fixed_sentence(openrouter):
    """Reject a key containing line breaks before the HTTP client can include the key in an error message."""
    key = 'TEST_ONLY_TOKEN_LINE_ONE\nTEST_ONLY_TOKEN_LINE_TWO'
    with pytest.raises(llmapi.ApiRefused) as e:
        llmapi.connect(_cfg(openrouter, key=key))
    assert "contains characters no request can carry" in str(e.value)
    assert _no_slice_of(key, str(e.value)), str(e.value)
    assert openrouter.requests == [], "the malformed key was sent"


def test_the_scrub_leaves_no_slice_of_the_key_in_either_form():
    """Scrub both plain and escaped key forms, including partial fragments around a line break."""
    key = 'TEST_ONLY_TOKEN_LINE_ONE\nTEST_ONLY_TOKEN_LINE_TWO'
    cfg = llmapi.ApiConfig("openrouter", "https://x", api_key=key)
    escaped = key.encode("unicode_escape").decode("ascii")
    for text in (f"Invalid header value b'Bearer {escaped}'", f"echo: {key} end",
                 f"Incorrect API key provided: {key[:14]}****"):
        out = llmapi._scrub(cfg, text)
        assert "[key]" in out and _no_slice_of(key, out), out


def test_a_provider_echoing_part_of_the_key_is_scrubbed():
    cfg = llmapi.ApiConfig("openrouter", "https://x", api_key="sk-or-v1-abcdefghijklmnopqrstuvwxyz")
    msg = llmapi._scrub(cfg, "Incorrect API key provided: sk-or-v1-abcdefg****")
    assert "abcdefg" not in msg and "[key]" in msg


def test_the_key_route_refuses_a_key_with_whitespace_or_line_breaks(client, openrouter):
    for bad in ("sk-a b", "sk-a\nb", "sk-\u00e9"):
        r = client.put("/llm/api/openrouter/key", json={"api_key": bad})
        assert r.status_code == 400 and "cannot contain" in r.get_json()["message"]
    view = {p["id"]: p for p in client.get("/llm/api").get_json()["providers"]}
    assert view["openrouter"]["key_set"] is False


def test_a_403_is_never_called_a_bad_key(openrouter):
    """An HTTP 403 can indicate a moderation refusal; do not label it as an invalid key."""
    openrouter.chat_failures = [(403, {"error": {"message": LEAK}}, {})]
    with pytest.raises(BackendRefused) as e:
        _chat(openrouter)
    assert "HTTP 403" in str(e.value) and "rejected the API key" not in str(e.value)
    assert LEAK not in str(e.value)


def test_a_dropped_connection_is_retryable_and_connect_still_answers_200(client, openrouter,
                                                                       monkeypatch):
    """Handle an incomplete HTTP response as a transport failure and return a failed Connect verdict rather than a server error."""
    import http.client

    def dropped(*a, **k):
        raise http.client.IncompleteRead(b"partial")
    monkeypatch.setattr(llmapi.urllib.request, "urlopen", dropped)
    with pytest.raises(TransportError):
        _chat(openrouter)
    client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
    r = client.post("/llm/api/openrouter/connect")
    assert r.status_code == 200 and r.get_json()["ok"] is False
    assert "IncompleteRead" in r.get_json()["message"]


def test_a_verdict_about_a_replaced_key_is_discarded(client, openrouter, monkeypatch):
    """Discard a Connect result if the API key changes while the request is in flight."""
    from vocalis.web import llmapi as web_llmapi
    client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
    real = llmapi.connect

    def slow_connect(cfg):
        res = real(cfg)
        # The key changes WHILE this Connect is out — what the key route does on a save.
        web_llmapi._save_block("openrouter",
                               lambda m: m.__setitem__("key_gen", int(m.get("key_gen") or 0) + 1))
        return res
    monkeypatch.setattr(llmapi, "connect", slow_connect)
    assert client.post("/llm/api/openrouter/connect").get_json()["ok"] is True
    view = {p["id"]: p for p in client.get("/llm/api").get_json()["providers"]}
    assert view["openrouter"]["last_connect"] is None, "a verdict about the old key was kept"
