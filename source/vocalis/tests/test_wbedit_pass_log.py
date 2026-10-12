"""Tests pass-event logging and public status output."""
from __future__ import annotations

import json
import threading

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import kobold
import vocalis_server as vs
import vocalis.web.kobold as web_kobold
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.core.contract import BEGIN, END, NOCHANGE

BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False,
              "content": "Test Character 1 keeps the ledger of every debt in the lower wards."},
        "1": {"uid": 1, "key": ["weather"], "comment": "Weather", "constant": False,
              "order": 100, "disable": False,
              "content": "The rains come off the estuary in the ninth month."},
    },
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    monkeypatch.setattr(web_wbedit, "_RUN", None)
    monkeypatch.setattr(web_wbedit, "_RECENT", {})
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def kobold_up(monkeypatch):
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="k",
                                                    local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"model": "koboldcpp/test-model"})

    def fake_request(cfg, path, body=None, timeout=10.0):
        field = body["messages"][-1]["content"].split("FIELD\n", 1)[1]
        if "Test Character 1" not in field:
            return {"choices": [{"message": {"content": NOCHANGE}}]}
        out = field.replace("Test Character 1", "Renamed Character 1")
        return {"choices": [{"message": {
            "content": f"{BEGIN}\n{out}\n{END}\nRenamed the character."}}]}

    monkeypatch.setattr(kobold, "_request", fake_request)


def _run(client, doc_id, instruction="Rename Test Character 1 to Renamed Character 1."):
    r = client.post(f"/wbedit/documents/{doc_id}/pass", json={"instruction": instruction})
    assert r.status_code == 201, r.get_json()
    pass_id = r.get_json()["id"]
    # The route starts the worker (named `wbedit-<pass id>`) before it answers 201, so joining it
    # is the completion signal; a thread no longer listed has already ended.
    for t in threading.enumerate():
        if t.name == f"wbedit-{pass_id}":
            t.join(15.0)
            assert not t.is_alive(), "the pass never finished"
    body = client.get(f"/wbedit/pass/{doc_id}/{pass_id}").get_json()
    assert body["status"] in ("done", "failed", "canceled"), "the pass never finished"
    return pass_id


@pytest.fixture
def ran(client, kobold_up):
    doc_id = client.post("/wbedit/documents",
                         json={"document": BOOK, "name": "Sample World Book 1"}).get_json()["id"]
    return doc_id, _run(client, doc_id)


# ── what the window shows ────────────────────────────────────────────────────

def test_the_log_records_one_exchange_per_field(client, ran):
    doc_id, pass_id = ran
    body = client.get(f"/wbedit/pass/{doc_id}/{pass_id}/log").get_json()
    assert body["available"] is True
    assert body["running"] is False
    assert body["dropped"] == 0
    assert len(body["exchanges"]) == 2, "two ticked fields, two model calls"
    assert [x["n"] for x in body["exchanges"]] == [1, 2]


def test_the_log_carries_the_hidden_system_prompt_and_few_shots(client, ran):
    """Checks that the log carries the hidden system prompt and few shots."""
    doc_id, pass_id = ran
    first = client.get(f"/wbedit/pass/{doc_id}/{pass_id}/log").get_json()["exchanges"][0]
    roles = [m["role"] for m in first["request"]["messages"]]

    assert roles[0] == "system", "the system prompt is not in the log"
    assert first["request"]["messages"][0]["content"].strip(), "the system prompt is empty"
    # The five few-shot pairs (§7) are user/assistant turns BEFORE the real one. Their presence is
    # what distinguishes a real transcript from a reconstruction of the last message.
    assert roles.count("user") >= 2 and roles.count("assistant") >= 1, (
        f"the few-shot pairs are missing from the log: {roles}")
    assert roles[-1] == "user", "the field being edited must be the last message"


def test_the_log_carries_the_reply_verbatim(client, ran):
    doc_id, pass_id = ran
    xs = client.get(f"/wbedit/pass/{doc_id}/{pass_id}/log").get_json()["exchanges"]
    replies = [x["reply"] for x in xs]
    assert any(BEGIN in r and END in r for r in replies), "the changed field's reply is not shown"
    assert any(r.strip() == NOCHANGE for r in replies), (
        "a NOCHANGE reply must appear too — 'the model returned nothing' and 'we never sent it' "
        "are the two cases this window exists to tell apart")


def test_the_log_carries_the_sampler_block(client, ran):
    """I2 — repetition penalties OFF. If they ever come back on, this window shows
    it, so the sampler has to be in the record rather than assumed."""
    doc_id, pass_id = ran
    req = client.get(f"/wbedit/pass/{doc_id}/{pass_id}/log").get_json()["exchanges"][0]["request"]
    assert req["rep_pen"] == 1.0 and req["rep_pen_range"] == 0
    assert req["dry_multiplier"] == 0 and req["xtc_probability"] == 0


def test_the_field_text_actually_sent_is_in_the_log(client, ran):
    """Item 4's diagnostic. 'The model returned NOCHANGE' and 'the field was never sent' look
    identical from outside, and this is what separates them."""
    doc_id, pass_id = ran
    xs = client.get(f"/wbedit/pass/{doc_id}/{pass_id}/log").get_json()["exchanges"]
    sent = "\n".join(x["request"]["messages"][-1]["content"] for x in xs)
    assert "Test Character 1 keeps the ledger" in sent
    assert "The rains come off the estuary" in sent


def test_hosted_malformed_reply_does_not_prefill_and_abandon_later_fields(client, monkeypatch):
    """A hosted model can reject assistant-prefill turns; the next field must still run."""
    import llmapi
    from vocalis.web import llm_engine

    cfg = llmapi.ApiConfig("openrouter", "https://provider.invalid", "test-key")
    engine = llm_engine.Engine(
        "openrouter", "OpenRouter", "anthropic/claude-opus-4.6", llmapi.chat_post(cfg),
        llm_engine.profiles.for_engine("openrouter"), llm_engine.TIMEOUTS["openrouter"],
        {"model": "anthropic/claude-opus-4.6"})
    monkeypatch.setattr(llm_engine, "chosen", lambda: "openrouter")
    monkeypatch.setattr(llm_engine, "resolve", lambda _engine=None: engine)
    requests = []

    def http_request(_cfg, _path, body, timeout=30.0):
        del timeout
        messages = body["messages"]
        requests.append(messages)
        if messages[-1]["role"] == "assistant":
            raise llmapi.ApiRefused("OpenRouter refused the request (HTTP 400).", 400)
        content = messages[-1]["content"]
        field = content.split("FIELD\n", 1)[1]
        if "Test Character 1" in field:
            if sum(1 for m in requests if m[-1]["role"] == "user" and
                   "Test Character 1" in m[-1]["content"]) == 1:
                reply = field.replace("Test Character 1", "Renamed Character 1")
            else:
                revised = field.replace("Test Character 1", "Renamed Character 1")
                reply = f"{BEGIN}\n{revised}\n{END}"
        else:
            reply = NOCHANGE
        return {"choices": [{"message": {"content": reply}}]}

    monkeypatch.setattr(llmapi, "_request", http_request)
    doc_id = client.post("/wbedit/documents",
                         json={"document": BOOK, "name": "Sample World Book 1"}).get_json()["id"]
    pass_id = _run(client, doc_id)
    status = client.get(f"/wbedit/pass/{doc_id}/{pass_id}").get_json()

    assert status["status"] == "done", status
    assert [p["status"] for p in status["proposals"]] == ["CHANGED", "NOCHANGE"]
    assert len(requests) == 3, "one malformed reply, its retry, and the following field"
    assert all(messages[-1]["role"] == "user" for messages in requests), \
        "the hosted model received an assistant prefill it rejects with HTTP 400"
    assert any("The rains come off the estuary" in messages[-1]["content"]
               for messages in requests), "the later field was abandoned"


# ── the boundary it must not cross ───────────────────────────────────────────

def test_the_sse_stream_still_carries_no_field_text(client, ran):
    """Checks that the sse stream still carries no field text."""
    doc_id, pass_id = ran
    stream = client.get(f"/wbedit/pass/{doc_id}/{pass_id}/events").get_data(as_text=True)
    assert "Test Character 1 keeps the ledger" not in stream
    assert BEGIN not in stream


def test_an_unknown_pass_reports_unavailable_rather_than_empty(client, ran):
    """An empty window and a forgotten pass look the same and mean opposite things — one says
    'nothing was sent', which would be a bug report about the wrong thing."""
    doc_id, _ = ran
    body = client.get(f"/wbedit/pass/{doc_id}/nosuchpass/log").get_json()
    assert body["available"] is False and body["exchanges"] == []


def test_the_log_is_bounded_and_says_when_it_dropped_rows(monkeypatch):
    """Checks that the log is bounded and says when it dropped rows."""
    monkeypatch.setattr(web_wbedit, "_LOG_KEEP", 3)
    run = web_wbedit._Run("d", "p")
    for i in range(5):
        run.log_exchange({"messages": [{"role": "user", "content": f"field {i}"}]}, f"reply {i}")

    assert len(run.exchanges) == 3
    assert run.dropped == 2
    assert [x["n"] for x in run.exchanges] == [3, 4, 5], (
        "the numbering must keep counting through a drop, or the window implies rows 1-3 "
        "are the ones on screen")


def test_a_logging_failure_never_fails_the_pass():
    """Checks that a logging failure never fails the pass."""
    from wbedit.backends.kobold_chat import KoboldChat

    calls = []

    def boom(body, reply):
        calls.append((body, reply))
        raise ValueError("the log exploded")

    backend = KoboldChat(lambda path, body, timeout: {"choices": [{"message": {"content": "hi"}}]},
                         on_exchange=boom)
    assert backend.complete([{"role": "user", "content": "x"}], {}) == "hi"

    assert len(calls) == 2, f"on_exchange fired {len(calls)} times, not twice (open, then close)"
    assert calls[0][1] is None, "the row opened before the POST did not arrive with reply=None"
    assert calls[1][1] == "hi", "the row was not closed with the reply the model actually sent"
    assert calls[0][0] is calls[1][0], \
        "the close carried a different body object — the window would show two rows, not one"


# ── persisted, per VERSION (§6.4.3) ──────────────────────────────────────────
#
# Persist each pass log with its revision, append repeated runs for that revision, and expose the
# full log when the revision is selected.

def test_the_saved_log_survives_the_run_leaving_memory(client, ran):
    """Checks that the saved log survives the run leaving memory."""
    doc_id, pass_id = ran
    web_wbedit._RUN = None
    web_wbedit._RECENT.clear()

    assert client.get(f"/wbedit/pass/{doc_id}/{pass_id}/log").get_json()["available"] is False
    rows = client.get(f"/wbedit/documents/{doc_id}/log/0").get_json()["rows"]
    assert [r for r in rows if r.get("event") == "pass.start"], "the run header was not saved"
    assert len([r for r in rows if "reply" in r]) == 2, "the exchanges were not saved"


def test_several_runs_on_one_version_append_to_the_same_log(client, ran, kobold_up):
    """Checks that several runs on one version append to the same log."""
    doc_id, _ = ran
    _run(client, doc_id, "Second attempt at the same thing.")

    rows = client.get(f"/wbedit/documents/{doc_id}/log/0").get_json()["rows"]
    starts = [r for r in rows if r.get("event") == "pass.start"]
    assert len(starts) == 2, "the second run did not append to the same version's log"
    assert starts[1]["instruction"] == "Second attempt at the same thing."
    assert len({r["pass_id"] for r in rows}) == 2, "both runs must be distinguishable"


def test_the_log_switches_by_itself_at_the_next_version(client, ran, kobold_up):
    """Checks that the log switches by itself at the next version."""
    doc_id, pass_id = ran
    assert client.post(f"/wbedit/pass/{doc_id}/{pass_id}/materialize").status_code == 201
    _run(client, doc_id, "Now on revision 1.")

    zero = client.get(f"/wbedit/documents/{doc_id}/log/0").get_json()["rows"]
    one = client.get(f"/wbedit/documents/{doc_id}/log/1").get_json()["rows"]
    assert [r["instruction"] for r in zero if r.get("event") == "pass.start"] == [
        "Rename Test Character 1 to Renamed Character 1."]
    assert [r["instruction"] for r in one if r.get("event") == "pass.start"] == [
        "Now on revision 1."]


def test_a_version_with_no_pass_has_an_empty_log_not_an_error(client):
    """A hand edit mints a revision without touching the model. The window must say so rather
    than 404 — an error there reads as "the log is broken", not "nothing was sent"."""
    doc_id = client.post("/wbedit/documents",
                         json={"document": BOOK, "name": "Sample World Book 1"}).get_json()["id"]
    r = client.get(f"/wbedit/documents/{doc_id}/log/0")
    assert r.status_code == 200 and r.get_json()["rows"] == []


def test_a_corrupt_row_is_skipped_rather_than_breaking_the_viewer(tmp_path):
    """A half-written line from a killed process must not make the window that would explain the
    failure unopenable."""
    from wbedit.store import DocumentStore
    store = DocumentStore(tmp_path / "wbedit")
    doc = store.create(BOOK, name="Sample World Book 1", kind="worldbook", source="upload")
    store.append_log(doc.id, 0, [{"pass_id": "a", "reply": "one"}])
    import vault_fs
    p = store._log(doc.id, 0)
    vault_fs.write_text(p, vault_fs.read_text(p) + '{"broken": \n')
    store.append_log(doc.id, 0, [{"pass_id": "a", "reply": "two"}])

    rows = store.read_log(doc.id, 0)
    assert [r["reply"] for r in rows] == ["one", "two"]


def test_deleting_the_document_takes_its_logs_with_it(tmp_path):
    """The log is card prose. "Delete removes it from Vocalis" has to mean this too."""
    from wbedit.store import DocumentStore
    store = DocumentStore(tmp_path / "wbedit")
    doc = store.create(BOOK, name="Sample World Book 1", kind="worldbook", source="upload")
    store.append_log(doc.id, 0, [{"pass_id": "a", "request": {"messages": []}, "reply": "x"}])
    assert store.read_log(doc.id, 0)

    store.delete(doc.id)
    import vault_fs
    assert not vault_fs.exists(store._dir(doc.id)), "the document directory outlived the delete"
