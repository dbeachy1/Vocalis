"""Tests model prompt construction for selected fields."""
from __future__ import annotations

import functools
import importlib.util
import json
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import formats, prompt, runner
from wbedit.backends.base import TransportError, profile
from wbedit.backends.kobold_chat import CHAT_PATH, KoboldChat
from wbedit.backends.mock import MockBackend
from wbedit.core.contract import BEGIN, END, NOCHANGE
from wbedit.core.job import Job
from wbedit.report.markdown import MarkdownReport

BASE = Path(__file__).resolve().parent.parent / "reference" / "wbedit-baseline"
BASELINE = BASE / "wb_batch_edit.py"
CARD = BASE / "prompts" / "Section-Editor.json"


@functools.lru_cache(maxsize=1)
def _baseline():
    name = "wb_batch_edit_baseline"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BASELINE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@functools.lru_cache(maxsize=1)
def card() -> dict:
    return json.loads(CARD.read_text(encoding="utf-8"))


def a_job(**kw) -> Job:
    meta = {"section": "Sample World Book 1", "keys": ["ledger"], "constant": False,
            "kind": "a lorebook entry", "note": ""}
    meta.update(kw.pop("meta", {}))
    return Job(rel=kw.pop("rel", "sample-world-book-1.json"), locator=("entries", 0, "content"),
               label=kw.pop("label", "Sample Entry 1"),
               original=kw.pop("original", "It records every debt."), meta=meta)


# ───────────────────────────────────────────────────────────── the card

def test_the_card_is_still_where_the_runtime_expects_it():
    """Checks that the card is still where the runtime expects it."""
    assert CARD.is_file(), f"{CARD} is gone — the system prompt cannot be built without it"


def test_the_system_prompt_is_both_card_fields_joined():
    """Checks that the system prompt is both card fields joined."""
    system, _shots = prompt.load(card())
    d = card().get("data", card())
    assert d["system_prompt"] in system
    assert d["description"] in system
    assert len(system) == len(d["system_prompt"]) + len(d["description"]) + 2


def test_five_few_shot_pairs_come_out_of_the_example_block():
    """The saved few-shot examples are included in the model prompt."""
    _system, shots = prompt.load(card())
    assert len(shots) == 5
    for s in shots:
        assert s["user"] and s["assistant"]
        assert not s["user"].startswith("{{user}}:"), "the speaker label leaked into the turn"


def test_the_card_loader_agrees_with_the_baselines(tmp_path):
    b = _baseline()
    theirs_system, theirs_shots = b.load_card(CARD)
    mine_system, mine_shots = prompt.load(card())
    assert mine_system == theirs_system
    assert mine_shots == theirs_shots


@pytest.mark.parametrize("bad", [
    {},                                              # nothing at all
    {"data": {"mes_example": "<START>\nno speaker"}},  # a block with no {{char}}:
    {"data": {"mes_example": "<START>\n{{char}}: only an answer"}},  # no user half
])
def test_a_malformed_example_block_is_skipped_not_guessed_at(bad):
    """A malformed pair is worse than a missing one: it teaches the model a shape we do not want
    back, and we would never see it — the reply would just be subtly wrong."""
    _system, shots = prompt.load(bad)
    assert shots == []


# ───────────────────────────────────────────────────────── the user message

def test_the_user_message_has_the_instruction_the_escape_the_context_and_the_field():
    msg = prompt.user_message(a_job(), "Rename the guild.")
    assert msg.startswith("INSTRUCTION\nRename the guild.")
    assert NOCHANGE in msg, "the escape hatch is missing — the model would echo unchanged fields"
    assert "CONTEXT (reference only, never edit or repeat this block)" in msg
    assert msg.endswith("FIELD\nIt records every debt.")


def test_I9_an_X_entry_gets_its_label_and_keys_like_any_other():
    """Checks that an x entry gets its label and keys like any other."""
    msg = prompt.user_message(a_job(label="X-the reveal"), "Rename the guild.")
    assert "Field: X-the reveal" in msg
    assert "Keys: ledger" in msg


def test_I11_nothing_but_this_field_is_in_the_message():
    """Checks that nothing but this field is in the message."""
    j = a_job(original="Only this text.")
    msg = prompt.user_message(j, "Rename the guild.")
    assert msg.count("Only this text.") == 1
    for stray in ("Test Character 1", "the upper wards", "It records every debt."):
        assert stray not in msg


def test_the_constant_and_note_lines_appear_only_when_they_apply():
    plain = prompt.user_message(a_job(), "x")
    assert "This entry is always in context." not in plain

    flagged = prompt.user_message(a_job(meta={"constant": True, "note": "A note."}), "x")
    assert "This entry is always in context." in flagged
    assert "A note." in flagged


def test_the_user_message_agrees_with_the_baselines():
    b = _baseline()
    j = a_job(meta={"constant": True, "note": "A note."})
    theirs = b.build_user_message(
        b.Job(path=Path("sample-world-book-1.json"), rel=j.rel, locator=j.locator, label=j.label,
              original=j.original, meta=dict(j.meta)),
        "Rename the guild.")
    assert prompt.user_message(j, "Rename the guild.") == theirs


def test_messages_are_system_then_alternating_pairs_then_the_request():
    system, shots = prompt.load(card())
    msgs = prompt.messages(system, shots, "THE REQUEST")
    assert msgs[0]["role"] == "system"
    assert [m["role"] for m in msgs[1:-1]] == ["user", "assistant"] * len(shots)
    assert msgs[-1] == {"role": "user", "content": "THE REQUEST"}


# ────────────────────────────────────────────────────────── the Kobold backend

class FakePost:
    def __init__(self, reply=None, raises=None):
        self.reply, self.raises, self.calls = reply, raises, []

    def __call__(self, path, body, timeout):
        self.calls.append((path, body, timeout))
        if self.raises:
            raise self.raises
        return self.reply


def ok(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


def test_the_request_goes_to_chat_completions_carrying_the_whole_sampler():
    post = FakePost(ok("hi"))
    KoboldChat(post, model="glm").complete([{"role": "user", "content": "x"}], profile())
    path, body, _timeout = post.calls[0]
    assert path == CHAT_PATH
    assert body["model"] == "glm"
    assert body["messages"] == [{"role": "user", "content": "x"}]
    for k, v in {"rep_pen": 1.0, "rep_pen_range": 0, "dry_multiplier": 0,
                 "xtc_probability": 0}.items():
        assert body[k] == v, f"I2: {k} must be sent explicitly — KoboldCpp defaults rep_pen to 1.1"


def test_a_transport_failure_carries_the_exception_not_the_request_body():
    """Checks that a transport failure carries the exception not the request body."""
    secret = "ZQX-CONTENT-SENTINEL-7714"
    post = FakePost(raises=OSError("connection refused"))
    with pytest.raises(TransportError) as exc:
        KoboldChat(post).complete([{"role": "user", "content": secret}], profile())
    assert secret not in str(exc.value)
    assert "connection refused" in str(exc.value)


@pytest.mark.parametrize("reply", [{}, {"choices": []}, {"choices": [{}]},
                                   {"choices": [{"message": {"content": None}}]}])
def test_a_200_with_the_wrong_shape_is_a_transport_error_so_the_runner_retries(reply):
    with pytest.raises(TransportError):
        KoboldChat(FakePost(reply)).complete([], profile())


def test_a_TransportError_from_the_transport_passes_straight_through():
    post = FakePost(raises=TransportError("HTTP 503"))
    with pytest.raises(TransportError, match="HTTP 503"):
        KoboldChat(post).complete([], profile())


# ──────────────────────────────────────────────────── one headless pass, end to end

SECTION = {
    "section_name": "Sample World Book 1",
    "entries": [
        {"keys": ["ledger"], "comment": "Sample Entry 1",
         "content": "Test Character 1 keeps the ledger, and has since the war."},
        {"keys": ["ward"], "comment": "X-the upper wards",
         "content": "Test Character 1 never goes there."},
        {"keys": ["rain"], "comment": "Weather", "content": "It rains most days."},
    ],
}


def test_a_whole_pass_runs_end_to_end_with_no_web_layer_and_no_model():
    """collect -> prompt -> runner -> report, which is the CLI-equivalent path §6 says must
    exist alongside the browser. Only the model is faked."""
    jobs = formats.collect(json.loads(json.dumps(SECTION)), rel="sample-world-book-1.json")
    assert len(jobs) == 3

    system, shots = prompt.load(card())
    backend = MockBackend()
    out: list[str] = []
    report = MarkdownReport(out.append, instruction="Rename Test Character 1 to Renamed Character 1.",
                            source="sample-world-book-1.json", clock=lambda: "STAMP")

    results = []
    for ev in runner.run(jobs, instruction="Rename Test Character 1 to Renamed Character 1.",
                         backend=backend, prompt=prompt.for_runner(system, shots),
                         sleep=lambda _s: None):
        report.feed(ev)
        if ev.kind == runner.FIELD_RESULT:
            results.append(ev)

    assert [e.result.status for e in results] == ["CHANGED", "CHANGED", "NOCHANGE"], \
        "the two entries naming Test Character 1 change; the weather entry does not"
    assert all(e.applied for e in results if e.result.status == "CHANGED")

    text = "".join(out)
    assert "Renamed Character 1 keeps the ledger" in text
    assert "- CHANGED: 2\n" in text and "- NOCHANGE: 1\n" in text

    # I9, at the end of the whole pipeline rather than at one function: the X entry is edited and
    # reported exactly like its neighbors.
    assert "X-the upper wards" in text
    assert "Renamed Character 1 never goes there." in text

    # I10, observed on the wire rather than asserted about the code.
    prefixes = {m[-1]["content"].split("\n\nIf the instruction")[0] for m, _s in backend.calls}
    assert len(prefixes) == 1

    # The card really is in front of the model on every call.
    assert all(m[0]["role"] == "system" and len(m) == 1 + 2 * len(shots) + 1
               for m, _s in backend.calls)


def test_the_end_to_end_pass_would_notice_if_the_mock_stopped_editing():
    """The control. Every assertion above survives a backend that changes nothing, unless
    something checks that work actually happened."""
    jobs = formats.collect(json.loads(json.dumps(SECTION)), rel="sample-world-book-1.json")
    system, shots = prompt.load(card())

    class Inert:
        def complete(self, messages, sampler):
            return NOCHANGE

    statuses = [ev.result.status for ev in runner.run(
        jobs, instruction="x", backend=Inert(), prompt=prompt.for_runner(system, shots),
        sleep=lambda _s: None) if ev.kind == runner.FIELD_RESULT]
    assert statuses == ["NOCHANGE"] * 3
