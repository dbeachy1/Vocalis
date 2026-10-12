"""Tests worldbook passes across supported engines, asserting provider requests, pass records, and default-engine behavior. Hosted providers use local HTTP fakes; llama.cpp is stubbed at its request seam."""
from __future__ import annotations

import threading

import pytest

import kobold
import llama
import llmapi
import vocalis_server as vs
import vocalis.runtime.settings as rt_settings
import vocalis.web.kobold as web_kobold
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from vocalis.web import llama as web_llama
from vocalis.web import llm_engine
from wbedit.backends import profiles
from wbedit.backends.base import PROFILE

from fake_llm_providers import GOOD_KEY, LEAK, FakeProvider

BOOK = {
    "name": 'Test World Book 1',
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": 'Test Entry 1', "constant": False,
              "order": 100, "disable": False,
              "content": 'Test Character 1 keeps the ledger of every debt in the lower wards.'},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "order": 100, "disable": False,
              "content": "The rains come off the estuary in the ninth month."},
    },
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    monkeypatch.setattr(llmapi, "_OR_CACHE", {})
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def kobold_forbidden(monkeypatch):
    """A KoboldCpp that fails the test if anything asks it anything — proof that choosing another
    engine really routes AWAY from it, at every one of the three call sites."""
    def nope(*a, **k):
        raise AssertionError("KoboldCpp was asked while another engine was chosen")
    monkeypatch.setattr(web_kobold, "_kobold_cfg", nope)
    monkeypatch.setattr(kobold, "status", nope)
    monkeypatch.setattr(kobold, "_request", nope)


def _choose(client, engine):
    assert client.put("/llm/engine", json={"engine": engine}).status_code == 200


def _import(c):
    r = c.post("/wbedit/documents", json={"document": BOOK, "name": 'Test World Book 1'})
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def _run(client, doc):
    r = client.post(f"/wbedit/documents/{doc['id']}/pass",
                    json={"instruction": 'Rename Test Character 1 to Renamed Character 1.'})
    return r


def _await(client, doc_id, pass_id, timeout=15.0):
    # Join the pass's own worker thread instead of polling the status over HTTP. The POST starts
    # the thread (named "wbedit-<pass id>") before it returns, so the thread is either still
    # alive here or already finished and gone from the list; once it has ended, `pstore.finish`
    # has run (or the failure path has), so ONE read of the record is the final state.
    # `timeout` is only the ceiling on a hang, and a hang fails loudly below.
    name = f"wbedit-{pass_id}"
    for t in [t for t in threading.enumerate() if t.name == name]:
        t.join(timeout)
        assert not t.is_alive(), "the pass never finished"
    body = client.get(f"/wbedit/pass/{doc_id}/{pass_id}").get_json()
    assert body["status"] in ("done", "failed", "canceled"), body["status"]
    return body


# ── the profiles ─────────────────────────────────────────────────────────────

def test_koboldcpp_keeps_its_own_block_byte_for_byte():
    assert profiles.for_engine("kobold") == PROFILE
    assert profiles.for_engine("kobold") is not PROFILE, "a shared dict would leak max_tokens"


@pytest.mark.parametrize("engine,penalty", [("llama", "repeat_penalty"),
                                            ("openrouter", "repetition_penalty"),
                                            ("featherless", "repetition_penalty")])
def test_each_new_engine_speaks_its_own_keys(engine, penalty):
    """9.5 §7a: a server silently IGNORES keys it does not recognise, so KoboldCpp's names in any
    other engine's block are inert. Each new block must carry its OWN penalty key, set off."""
    p = profiles.for_engine(engine)
    assert p[penalty] == 1.0 and p["temperature"] == 0.2 and p["stream"] is False
    assert not {"rep_pen", "rep_pen_range", "rep_pen_slope", "smoothing_factor", "nsigma",
                "typical", "tfs"} & set(p), f"{engine} carries KoboldCpp's key names"


@pytest.mark.parametrize("engine", ["llama", "openrouter", "featherless"])
def test_no_thinking_control_on_the_new_engines(engine):
    """New hosted engines omit reasoning controls that are specific to KoboldCpp."""
    assert not {"reasoning", "reasoning_effort", "chat_template_kwargs",
                "include_reasoning"} & set(profiles.for_engine(engine))
    assert PROFILE["reasoning_effort"] == "none"


def test_featherless_does_not_send_top_k():
    assert "top_k" not in profiles.for_engine("featherless")


# ── the choice ───────────────────────────────────────────────────────────────

def test_unset_and_nonsense_both_mean_koboldcpp():
    assert llm_engine.chosen({}) == "kobold"
    assert llm_engine.chosen({"wbedit_engine": "gpt-9"}) == "kobold"
    assert llm_engine.chosen({"wbedit_engine": "LLAMA"}) == "llama"


def test_an_unset_choice_still_runs_koboldcpp_and_records_it(client, monkeypatch):
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="k", local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"model": "koboldcpp/test-model"})
    sent = []

    def fake_request(cfg, path, body=None, timeout=10.0):
        sent.append((path, body, timeout))
        return {"choices": [{"message": {"content": "<<<NOCHANGE>>>"}}]}
    monkeypatch.setattr(kobold, "_request", fake_request)
    doc = _import(client)
    p = _run(client, doc).get_json()
    body = _await(client, doc["id"], p["id"])
    assert body["engine"] == "kobold" and body["model"] == "koboldcpp/test-model"
    assert sent and all(t == 900.0 for _p, _b, t in sent), "KoboldCpp's 900 s ceiling moved"
    assert sent[0][1]["reasoning_effort"] == "none" and sent[0][1]["rep_pen"] == 1.0
    m = client.get("/wbedit/model").get_json()
    assert m["engine"] == "kobold" and m["engine_label"] == "KoboldCpp"


# ── llama.cpp ────────────────────────────────────────────────────────────────

def _router(rows, mode="router"):
    st = {"mode": mode, "models": [{"id": i, "status": s, "holds_vram": s == "loaded"}
                                   for i, s in rows]}
    return st


def test_llama_uses_the_model_holding_vram():
    st = _router([("a", "unloaded"), ("b", "loaded"), ("c", "unloaded")])
    assert llm_engine.llama_model(st) == "b"


def test_llama_accepts_one_sleeping_model_when_nothing_is_held():
    assert llm_engine.llama_model(_router([("a", "unloaded"), ("z", "sleeping")])) == "z"


def test_llama_refuses_rather_than_AUTOLOADING_an_unloaded_model():
    """`models_autoload: true` is the router default: naming an unloaded model would LOAD it onto
    the cards with no click. With nothing loaded, the answer is a refusal, never a guess."""
    with pytest.raises(llm_engine.EngineUnavailable, match="no model is loaded"):
        llm_engine.llama_model(_router([("a", "unloaded"), ("b", "unloaded")]))


def test_llama_refuses_to_pick_between_two_resident_models():
    with pytest.raises(llm_engine.EngineUnavailable, match=r"holds 2 models \(a, b\)"):
        llm_engine.llama_model(_router([("a", "loaded"), ("b", "loaded")]))


def test_a_single_model_llama_server_uses_its_one_model():
    assert llm_engine.llama_model(_router([("only.gguf", "loaded")], mode="single")) == "only.gguf"


class FakeLlamaRouter:
    """`llama._request` for a router holding one model, answering chat like the fakes do."""

    def __init__(self, rows):
        self.rows = rows
        self.chat = []

    def __call__(self, cfg, path, body=None, timeout=10.0, method=None):
        if path == "/props":
            return {"role": "router", "max_instances": 1, "models_autoload": True}
        if path.startswith("/models"):
            return {"data": [{"id": i, "status": {"value": s}} for i, s in self.rows]}
        if path == "/v1/chat/completions":
            self.chat.append((body, timeout))
            from fake_llm_providers import rename_reply
            return rename_reply(body)
        raise AssertionError(f"unscripted {path!r}")


def test_a_pass_runs_on_llama_with_ITS_keys_and_the_loaded_model(client, monkeypatch,
                                                                    kobold_forbidden):
    fake = FakeLlamaRouter([("glm-a", "unloaded"), ("glm-b", "loaded")])
    monkeypatch.setattr(llama, "_request", fake)
    monkeypatch.setattr(web_llama, "_llama_cfg",
                        lambda: llama.LlamaConfig(url="http://127.0.0.1:8080", local=True))
    _choose(client, "llama")
    m = client.get("/wbedit/model").get_json()
    assert m == {**m, "loaded": True, "model": "glm-b", "engine": "llama",
                 "engine_label": "llama.cpp"}
    doc = _import(client)
    p = _run(client, doc).get_json()
    body = _await(client, doc["id"], p["id"])
    assert body["status"] == "done" and body["engine"] == "llama" and body["model"] == "glm-b"
    assert body["tally"]["CHANGED"] == 1
    sent, timeout = fake.chat[0]
    assert sent["model"] == "glm-b" and timeout == 900.0
    assert sent["repeat_penalty"] == 1.0 and sent["repeat_last_n"] == 0 and "rep_pen" not in sent


def test_llama_with_nothing_loaded_opens_no_pass_and_sends_no_chat(client, monkeypatch,
                                                                     kobold_forbidden):
    fake = FakeLlamaRouter([("glm-a", "unloaded")])
    monkeypatch.setattr(llama, "_request", fake)
    monkeypatch.setattr(web_llama, "_llama_cfg",
                        lambda: llama.LlamaConfig(url="http://127.0.0.1:8080", local=True))
    _choose(client, "llama")
    doc = _import(client)
    r = _run(client, doc)
    assert r.status_code == 503 and "no model is loaded on llama.cpp" in r.get_json()["error"]
    assert fake.chat == [] and client.get(f"/wbedit/documents/{doc['id']}").get_json()["passes"] == []


def test_a_rejected_llama_key_ends_the_pass_after_ONE_request(client, monkeypatch,
                                                                kobold_forbidden):
    fake = FakeLlamaRouter([("glm-b", "loaded")])
    calls = []

    def refusing(cfg, path, body=None, timeout=10.0, method=None):
        if path == "/v1/chat/completions":
            calls.append(path)
            raise llama.LlamaAuthFailed("llama-server rejected the API key (http://x).")
        return fake(cfg, path, body, timeout, method)
    monkeypatch.setattr(llama, "_request", refusing)
    monkeypatch.setattr(web_llama, "_llama_cfg",
                        lambda: llama.LlamaConfig(url="http://127.0.0.1:8080", local=True))
    _choose(client, "llama")
    doc = _import(client)
    body = _await(client, doc["id"], _run(client, doc).get_json()["id"])
    assert body["status"] == "failed" and "rejected the API key" in body["error"]
    assert len(calls) == 1, f"a wrong key was retried {len(calls)} times"


# ── the hosted providers ─────────────────────────────────────────────────────

@pytest.fixture(params=["openrouter", "featherless"])
def hosted(request, client, monkeypatch):
    kind = request.param
    f = FakeProvider(kind).start()
    env = llmapi.PROVIDERS[kind]
    monkeypatch.setenv(env.url_env, f.url)
    monkeypatch.delenv(env.key_env, raising=False)
    model = "z-ai/glm-4.6" if kind == "openrouter" else "zai-org/GLM-4.6"
    assert client.put(f"/llm/api/{kind}/key", json={"api_key": GOOD_KEY}).status_code == 200
    assert client.put(f"/llm/api/{kind}/model", json={"id": model}).status_code == 200
    _choose(client, kind)
    yield f, model
    f.stop()


def test_a_pass_runs_on_a_hosted_provider_end_to_end(client, hosted, kobold_forbidden):
    fake, model = hosted
    m = client.get("/wbedit/model").get_json()
    assert m["loaded"] is True and m["model"] == model and m["engine"] == fake.kind
    doc = _import(client)
    p = _run(client, doc).get_json()
    body = _await(client, doc["id"], p["id"])
    assert body["status"] == "done", body
    assert body["engine"] == fake.kind and body["model"] == model
    assert body["tally"]["CHANGED"] == 1 and body["tally"]["NOCHANGE"] == 1
    chats = [(a, b) for meth, path, a, b in fake.requests if path == "/v1/chat/completions"]
    assert len(chats) == 2
    auth, sent = chats[0]
    assert auth == f"Bearer {GOOD_KEY}" and sent["model"] == model
    assert sent["repetition_penalty"] == 1.0 and "rep_pen" not in sent
    assert ("top_k" in sent) == (fake.kind == "openrouter")
    # And the proposal made it back — the reply was actually READ, not just received.
    r = client.post(f"/wbedit/pass/{doc['id']}/{p['id']}/materialize")
    assert r.status_code == 201
    rev = client.get(f"/wbedit/documents/{doc['id']}/revision/1").get_json()
    assert rev["content"]["entries"]["0"]["content"].startswith('Renamed Character 1')


def test_a_refused_key_mid_pass_fails_once_with_our_words(client, hosted, kobold_forbidden):
    fake, _model = hosted
    fake.key = "sk-rotated-elsewhere"            # the saved key is now wrong
    doc = _import(client)
    body = _await(client, doc["id"], _run(client, doc).get_json()["id"])
    assert body["status"] == "failed" and "rejected the API key" in body["error"]
    assert LEAK not in body["error"]
    chats = [p for _m, p, _a, _b in fake.requests if p == "/v1/chat/completions"]
    assert len(chats) == 1, f"a refused key was sent {len(chats)} times"


def test_no_key_or_no_pick_is_a_503_before_any_request(client, monkeypatch, kobold_forbidden):
    f = FakeProvider("openrouter").start()
    try:
        monkeypatch.setenv("VOCALIS_OPENROUTER_URL", f.url)
        monkeypatch.delenv("VOCALIS_OPENROUTER_API_KEY", raising=False)
        _choose(client, "openrouter")
        doc = _import(client)
        r = _run(client, doc)
        assert r.status_code == 503 and "has no API key" in r.get_json()["error"]
        client.put("/llm/api/openrouter/key", json={"api_key": GOOD_KEY})
        r = _run(client, doc)
        assert r.status_code == 503 and "no OpenRouter model is picked" in r.get_json()["error"]
        m = client.get("/wbedit/model").get_json()
        assert m["loaded"] is False and "no OpenRouter model is picked" in m["error"]
        assert f.requests == []
    finally:
        f.stop()


def test_the_live_test_book_gives_a_checkable_answer(client, hosted, kobold_forbidden):
    """The six-entry synthetic worldbook produces three changed and three unchanged entries."""
    import json
    from pathlib import Path
    book = json.loads((Path(__file__).parent / "fixtures" / 'llm_api_synthetic_worldbook.json')
                      .read_text(encoding="utf-8"))
    r = client.post("/wbedit/documents", json={"document": book, "name": 'Sample Setting'})
    assert r.status_code == 201, r.get_json()
    doc = r.get_json()
    body = _await(client, doc["id"], _run(client, doc).get_json()["id"])
    assert body["status"] == "done", body
    assert body["tally"] == {**body["tally"], "CHANGED": 3, "NOCHANGE": 3}


# ── hosted-provider regressions ────────────────────────────────────────────

def test_llama_ends_the_pass_if_the_model_is_unloaded_MID_PASS(client, monkeypatch,
                                                              kobold_forbidden):
    """If the selected model unloads during a pass, stop before another field request can trigger an implicit reload."""
    fake = FakeLlamaRouter([("glm-b", "loaded")])

    def unloading(cfg, path, body=None, timeout=10.0, method=None):
        out = fake(cfg, path, body, timeout, method)
        if path == "/v1/chat/completions":
            fake.rows = [("glm-b", "unloaded")]      # The model unloads after the first field.
        return out
    monkeypatch.setattr(llama, "_request", unloading)
    monkeypatch.setattr(web_llama, "_llama_cfg",
                        lambda: llama.LlamaConfig(url="http://127.0.0.1:8080", local=True))
    _choose(client, "llama")
    doc = _import(client)
    body = _await(client, doc["id"], _run(client, doc).get_json()["id"])
    assert body["status"] == "failed" and "was unloaded during the pass" in body["error"]
    assert len(fake.chat) == 1, f"{len(fake.chat)} requests named an unloaded model"


def test_a_refused_request_closes_its_log_row():
    """A refused backend request closes the exchange row instead of leaving it in flight."""
    from wbedit.backends.base import BackendRefused
    from wbedit.backends.chat import NO_REPLY, ChatCompletions
    rows = []

    def refusing(path, body, timeout):
        raise BackendRefused("OpenRouter rejected the API key (HTTP 401).")
    with pytest.raises(BackendRefused):
        ChatCompletions(refusing, on_exchange=lambda b, r: rows.append(r)).complete([], {})
    assert rows == [None, NO_REPLY]


def test_a_null_reasoning_only_reply_is_unreadable_not_a_transport_fault(client, hosted):
    """Normalize a hosted response with `content: null` to an unreadable reply, leaving the KoboldCpp transport behavior unchanged."""
    from wbedit.backends.chat import ChatCompletions
    fake, model = hosted
    fake.chat = lambda body: {"choices": [{"message": {"content": None, "reasoning": "hm"}}]}
    cfg = llmapi.resolve_config(fake.kind, rt_settings.load_app_settings(),
                                {"api_key": GOOD_KEY})
    assert ChatCompletions(llmapi.chat_post(cfg), model=model).complete([], {}) == ""
