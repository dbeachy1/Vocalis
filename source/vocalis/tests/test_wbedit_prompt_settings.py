"""Tests prompt-setting validation and application."""
from __future__ import annotations

import json
import threading

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import kobold
import vault_fs
import vocalis_server as vs
import vocalis.web.kobold as web_kobold
import vocalis.web.wbedit as web_wbedit
from vocalis.runtime import paths
from wbedit.core.contract import BEGIN, END, NOCHANGE
from wbedit.prompt import assemble, settings

BOOK = {
    "name": "Sample World Book 1",
    "entries": {
        "0": {"uid": 0, "key": ["ledger"], "comment": "Sample Entry 1", "constant": False,
              "order": 100, "disable": False,
              "content": "Test Character 1 keeps the ledger of every debt in the lower wards."},
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


def _join_pass(pass_id, timeout=15.0):
    """Wait for a pass to end. The route starts its worker (named `wbedit-<pass id>`) before it
    answers 201, so joining that thread is the completion signal; a thread no longer listed has
    already ended."""
    for t in threading.enumerate():
        if t.name == f"wbedit-{pass_id}":
            t.join(timeout)
            assert not t.is_alive(), "the pass never finished"


@pytest.fixture
def card():
    return json.loads(vault_fs.read_text(web_wbedit.CARD_PATH))


# ── the store ────────────────────────────────────────────────────────────────

def test_with_nothing_saved_the_shipped_prompt_is_what_runs(tmp_path, card):
    p = settings.load(tmp_path / "wbedit", card)
    assert p["fingerprint"] == p["shipped_fingerprint"]
    assert p["system"] == p["shipped_system"] and p["shots"] == p["shipped_shots"]
    assert p["wrapper"] == assemble.DEFAULT_WRAPPER
    assert p["shots"], "the baseline card must still yield its few-shot pairs"


def test_an_edit_persists_and_wins(tmp_path, card):
    """*"those edits… should PERSIST across all messages."* A fresh read is a fresh process as
    far as this module is concerned — nothing is cached in memory."""
    root = tmp_path / "wbedit"
    settings.save(root, "MY PROMPT", [{"user": "u", "assistant": "a"}], "x {instruction} {field}")

    p = settings.load(root, card)
    assert p["fingerprint"] != p["shipped_fingerprint"]
    assert p["system"] == "MY PROMPT"
    assert p["shots"] == [{"user": "u", "assistant": "a"}]
    assert p["wrapper"] == "x {instruction} {field}"
    # …and the baseline is still reported, so Reset needs no second round trip.
    assert p["shipped_system"] and p["shipped_system"] != "MY PROMPT"


def test_reset_returns_to_the_card(tmp_path, card):
    root = tmp_path / "wbedit"
    settings.save(root, "MY PROMPT", [], assemble.DEFAULT_WRAPPER)
    assert settings.load(root, card)["system"] == "MY PROMPT"
    settings.reset(root)
    back = settings.load(root, card)
    assert back["fingerprint"] == back["shipped_fingerprint"]


def test_a_corrupt_saved_prompt_falls_back_rather_than_breaking_every_pass(tmp_path, card):
    """Checks that a corrupt saved prompt falls back rather than breaking every pass."""
    root = tmp_path / "wbedit"
    settings.save(root, "MY PROMPT", [], assemble.DEFAULT_WRAPPER)
    vault_fs.write_text(root / settings.PROMPT_FILE, "{not json")

    p = settings.load(root, card)
    assert p["system"] == p["shipped_system"]
    assert p["fingerprint"] == p["shipped_fingerprint"]


def test_the_fingerprint_moves_when_any_of_the_three_parts_does(tmp_path, card):
    """§6.4.1 — the record says WHICH prompt ran. A hash that ignored the pairs or the wrapper
    would report two materially different passes as the same one."""
    base = settings.fingerprint("s", [{"user": "u", "assistant": "a"}], "w")
    assert base != settings.fingerprint("s2", [{"user": "u", "assistant": "a"}], "w")
    assert base != settings.fingerprint("s", [], "w")
    assert base != settings.fingerprint("s", [{"user": "u", "assistant": "a"}], "w2")


# ── the wrapper, and the edit that would corrupt a pass silently ─────────────

def test_the_shipped_wrapper_still_produces_the_shape_the_contract_expects():
    """The runner splits on `FIELD\\n` and the parser looks for the sentinels. Those strings are
    a contract between three modules, so the default template has to keep satisfying it."""
    from wbedit.core.job import Job
    job = Job(rel="Sample World Book 1", locator=("a",), label="Sample Entry 1",
              original="He keeps the ledger.",
              meta={"section": "Sample World Book 1", "kind": "a worldbook entry", "keys": ["ledger"]})
    msg = assemble.user_message(job, "Rename him.")
    assert msg.startswith("INSTRUCTION\nRename him.")
    assert NOCHANGE in msg
    assert msg.split("FIELD\n", 1)[1] == "He keeps the ledger."


@pytest.mark.parametrize("bad,why", [
    ("no placeholders at all", "{instruction}"),
    ("{instruction} only", "{field}"),
    ("{field} only", "{instruction}"),
])
def test_a_wrapper_missing_a_required_placeholder_is_rejected(bad, why):
    msg = assemble.validate_wrapper(bad)
    assert msg and why in msg


def test_an_empty_wrapper_is_rejected():
    assert assemble.validate_wrapper("   ")


def test_a_good_wrapper_passes():
    assert assemble.validate_wrapper("Do {instruction} to {field} using {context} or {nochange}") == ""
    assert assemble.validate_wrapper(assemble.DEFAULT_WRAPPER) == ""
    # …and so does one carrying braces that are not tokens. Nothing is interpreted, so there is
    # nothing here that can be malformed — see the regression block at the end of this file.
    assert assemble.validate_wrapper("{{user}} stays {instruction} {field}") == ""


# ── the routes ───────────────────────────────────────────────────────────────

def test_the_route_reports_the_effective_prompt_and_the_default(client):
    b = client.get("/wbedit/prompt").get_json()
    assert b["fingerprint"] == b["shipped_fingerprint"]
    assert b["system"] and b["shots"] and b["wrapper"]
    assert b["shipped_wrapper"] == assemble.DEFAULT_WRAPPER


def test_saving_then_reading_back_round_trips(client):
    saved = client.put("/wbedit/prompt", json={
        "system": "MINE", "shots": [{"user": "u", "assistant": "a"}],
        "wrapper": "A {instruction} B {field}"}).get_json()
    assert saved["system"] == "MINE" and saved["fingerprint"] != saved["shipped_fingerprint"]
    assert client.get("/wbedit/prompt").get_json()["wrapper"] == "A {instruction} B {field}"


def test_a_wrapper_without_the_field_placeholder_is_refused(client):
    """Checks that a wrapper without the field placeholder is refused."""
    r = client.put("/wbedit/prompt", json={"system": "s", "shots": [],
                                           "wrapper": "just {instruction}"})
    assert r.status_code == 400
    assert "{field}" in r.get_json()["error"]
    # …and nothing was stored, so a refused save cannot half-apply.
    stock = client.get("/wbedit/prompt").get_json()
    assert stock["fingerprint"] == stock["shipped_fingerprint"]


def test_an_empty_system_prompt_is_refused(client):
    assert client.put("/wbedit/prompt", json={"system": "  ", "shots": []}).status_code == 400


def test_dropping_every_few_shot_pair_is_ALLOWED(client):
    """Permitted as a legitimate experiment. The pane warns that it may expose model reasoning,
    and Reset can undo the edit."""
    r = client.put("/wbedit/prompt", json={"system": "s", "shots": [],
                                           "wrapper": assemble.DEFAULT_WRAPPER})
    assert r.status_code == 200 and r.get_json()["shots"] == []


def test_reset_over_http(client):
    client.put("/wbedit/prompt", json={"system": "MINE", "shots": [],
                                       "wrapper": assemble.DEFAULT_WRAPPER})
    after = client.delete("/wbedit/prompt").get_json()
    assert after["fingerprint"] == after["shipped_fingerprint"]


def test_the_prompt_is_frozen_while_a_pass_runs(client, monkeypatch):
    """I10, restated for the prompt by §6.4.1. Accepting an edit mid-run would leave the pass
    already in flight using the old prefix while the record claims the new one."""
    run = web_wbedit._Run("d", "p")
    monkeypatch.setattr(web_wbedit, "_RUN", run)
    assert client.put("/wbedit/prompt", json={"system": "x", "shots": [],
                                              "wrapper": assemble.DEFAULT_WRAPPER}).status_code == 409
    assert client.delete("/wbedit/prompt").status_code == 409

    run.done = True
    assert client.put("/wbedit/prompt", json={"system": "x", "shots": [],
                                              "wrapper": assemble.DEFAULT_WRAPPER}).status_code == 200


# ── and it actually reaches the model ────────────────────────────────────────

def test_the_pass_really_sends_the_saved_prompt(client, monkeypatch):
    """Checks that the pass really sends the saved prompt."""
    seen = []
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="k", local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"model": "koboldcpp/test-model"})

    def fake_request(cfg, path, body=None, timeout=10.0):
        seen.append(body["messages"])
        return {"choices": [{"message": {"content": NOCHANGE}}]}

    monkeypatch.setattr(kobold, "_request", fake_request)

    client.put("/wbedit/prompt", json={
        "system": "SYSTEM-SENTINEL",
        "shots": [{"user": "SHOT-USER", "assistant": "SHOT-ASSISTANT"}],
        "wrapper": "WRAP-SENTINEL {instruction} >>> {field}"})

    doc_id = client.post("/wbedit/documents",
                         json={"document": BOOK, "name": "Sample World Book 1"}).get_json()["id"]
    p = client.post(f"/wbedit/documents/{doc_id}/pass",
                    json={"instruction": "Rename him."}).get_json()
    _join_pass(p["id"])

    assert seen, "the model was never called"
    msgs = seen[0]
    assert msgs[0] == {"role": "system", "content": "SYSTEM-SENTINEL"}
    assert msgs[1] == {"role": "user", "content": "SHOT-USER"}
    assert msgs[2] == {"role": "assistant", "content": "SHOT-ASSISTANT"}
    assert msgs[-1]["content"] == (
        "WRAP-SENTINEL Rename him. >>> Test Character 1 keeps the ledger of every debt in the "
        "lower wards.")


def test_the_log_records_which_prompt_ran(client, monkeypatch):
    """Checks that the log records which prompt ran."""
    monkeypatch.setattr(web_kobold, "_kobold_cfg",
                        lambda: kobold.KoboldConfig(url="https://x", adminpassword="k", local=True))
    monkeypatch.setattr(kobold, "status", lambda cfg: {"model": "koboldcpp/test-model"})
    monkeypatch.setattr(kobold, "_request",
                        lambda cfg, path, body=None, timeout=10.0: {
                            "choices": [{"message": {"content": NOCHANGE}}]})

    client.put("/wbedit/prompt", json={"system": "MINE", "shots": [],
                                       "wrapper": assemble.DEFAULT_WRAPPER})
    doc_id = client.post("/wbedit/documents",
                         json={"document": BOOK, "name": "Sample World Book 1"}).get_json()["id"]
    p = client.post(f"/wbedit/documents/{doc_id}/pass",
                    json={"instruction": "Rename him."}).get_json()
    _join_pass(p["id"])

    start = [r for r in client.get(f"/wbedit/documents/{doc_id}/log/0").get_json()["rows"]
              if r.get("event") == "pass.start"]
    assert start, "the run header was not written"
    assert start[0]["prompt"] == client.get("/wbedit/prompt").get_json()["fingerprint"], (
        "the fingerprint IS the record of which prompt ran — there is no separate flag")


# ── braces are ordinary characters ──────────────────────────────────────────
#
# 🔴 The wrapper was first rendered with `str.format()`, which gives `{{` and `}}` meaning. In a
# CHARACTER CARD EDITOR that is a trap with a silent failure mode: `{{user}}` and `{{char}}` are
# the likeliest things anyone would type into a prompt template, and `.format()` renders `{{user}}`
# as `{user}` without complaint. Worse, `validate_wrapper` also called `.format()`, so it agreed.

def test_a_wrapper_containing_double_braces_survives_verbatim():
    """`{{user}}` in the wrapper must reach the model as `{{user}}`."""
    from wbedit.core.job import Job
    job = Job(rel="B", locator=("a",), label="L", original="TEXT",
              meta={"section": "B", "kind": "a worldbook entry"})
    out = assemble.user_message(job, "do it", "Write {{user}} not the name. {instruction} :: {field}")
    assert "{{user}}" in out, "double braces were eaten — .format() semantics are back"
    assert out.endswith(":: TEXT")
    assert "do it" in out


def test_a_lone_brace_in_the_wrapper_does_not_explode():
    from wbedit.core.job import Job
    job = Job(rel="B", locator=("a",), label="L", original="TEXT", meta={"section": "B"})
    out = assemble.user_message(job, "i", "a { b } c {instruction} {field}")
    assert "a { b } c" in out
    assert assemble.validate_wrapper("a { b } c {instruction} {field}") == ""


def test_an_unknown_token_is_left_alone_rather_than_rejected():
    """With a literal swap there is nothing to reject: `{mystery}` is just text."""
    assert assemble.validate_wrapper("{instruction} {field} {mystery}") == ""


def test_field_text_containing_a_token_is_not_re_expanded():
    """Checks that field text containing a token is not re expanded."""
    from wbedit.core.job import Job
    job = Job(rel="B", locator=("a",), label="L",
              original="the literal {field} and {instruction} appear here",
              meta={"section": "B"})
    out = assemble.user_message(job, "INSTR", assemble.DEFAULT_WRAPPER)
    body = out.split("FIELD\n", 1)[1]
    assert body == "the literal {field} and {instruction} appear here"


# ── Prompt revisions ─────────────────────────────────────────────────────────

def test_every_save_mints_a_revision(tmp_path):
    """Checks that every save mints a revision."""
    assert settings.revisions(tmp_path) == []
    assert settings.save(tmp_path, "First.", [], "{field}") == 0
    assert settings.save(tmp_path, "Second.", [], "{field}") == 1
    assert settings.revisions(tmp_path) == [0, 1]
    assert settings.revision(tmp_path, 0)["system"] == "First."
    assert settings.revision(tmp_path, 1)["system"] == "Second."


def test_reset_records_what_it_is_about_to_throw_away(tmp_path):
    """Checks that reset records what it is about to throw away."""
    settings.save(tmp_path, "An hour of tuning.", [{"user": "u", "assistant": "a"}], "{field}")
    n = settings.reset(tmp_path)
    assert n == 1, "the reset did not record the prompt it destroyed"
    kept = settings.revision(tmp_path, n)
    assert kept["system"] == "An hour of tuning."
    assert kept["shots"] == [{"user": "u", "assistant": "a"}]
    assert "Reset" in kept["note"]


def test_resetting_with_nothing_tuned_records_nothing(tmp_path):
    """Checks that resetting with nothing tuned records nothing."""
    assert settings.reset(tmp_path) is None
    assert settings.revisions(tmp_path) == []


def test_the_effective_prompt_is_untouched_by_the_revision_log(tmp_path):
    """Checks that the effective prompt is untouched by the revision log."""
    settings.save(tmp_path, "In force.", [], "{field}")
    card = {"data": {"system_prompt": "shipped", "description": "", "mes_example": ""}}
    assert settings.load(tmp_path, card)["system"] == "In force."


def test_a_restore_appends_rather_than_rewinding(tmp_path):
    """Checks that a restore appends rather than rewinding."""
    settings.save(tmp_path, "Original.", [], "{field}")      # 0
    settings.save(tmp_path, "Experiment.", [], "{field}")    # 1
    old = settings.revision(tmp_path, 0)
    settings.save(tmp_path, old["system"], old["shots"], old["wrapper"],
                  note="restored from revision 0")
    assert settings.revisions(tmp_path) == [0, 1, 2], "history was rewound"
    assert settings.revision(tmp_path, 1)["system"] == "Experiment.", \
        "the experiment was deleted by restoring the prompt before it"
    card = {"data": {"system_prompt": "shipped", "description": "", "mes_example": ""}}
    assert settings.load(tmp_path, card)["system"] == "Original."


def test_a_corrupt_revision_is_a_stub_row_rather_than_a_gap(tmp_path):
    """Checks that a corrupt revision is a stub row rather than a gap."""
    settings.save(tmp_path, "Good.", [], "{field}")
    (tmp_path / settings.REV_DIR / "0000.json").write_text("{ not json", encoding="utf-8")
    rows = settings.revision_index(tmp_path)
    assert [r["n"] for r in rows] == [0]
    assert rows[0]["note"] == "unreadable"
    assert settings.revision(tmp_path, 0) is None


def test_the_index_carries_what_a_picker_needs_and_not_the_bodies(tmp_path):
    settings.save(tmp_path, "One.", [], "{field}", note="saved")
    rows = settings.revision_index(tmp_path)
    assert set(rows[0]) == {"n", "created_at", "note", "fingerprint"}
    assert rows[0]["created_at"] > 0 and rows[0]["fingerprint"]
