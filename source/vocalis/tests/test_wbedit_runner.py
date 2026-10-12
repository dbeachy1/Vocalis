"""Tests pass execution, retries, result reporting, and cancellation."""
from __future__ import annotations

import json

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import runner
from wbedit.backends.base import TransportError, profile
from wbedit.core.contract import BEGIN, END, NOCHANGE
from wbedit.core.job import Job
from wbedit.report.markdown import MarkdownReport

# A body sentinel that could not plausibly arise anywhere else. §10 requires the containment test
# to grep produced artifacts for exactly this shape rather than to reason about the code.
SENTINEL = "ZQX-CONTENT-SENTINEL-7714"

INSTRUCTION = "Rename Test Character 1 to Renamed Character 1 wherever he appears."


def job(text: str, *, rel: str = "book.json", label: str = "entry 1", n: int = 1) -> Job:
    return Job(rel=rel, locator=("entries", str(n), "content"), label=label, original=text,
               meta={"kind": "worldbook entry"})


def prompt(j: Job, instruction: str) -> list[dict[str, str]]:
    """Stand-in for prompt assembly; includes the unchanged instruction and a FIELD-delimited value."""
    return [
        {"role": "system", "content": "You are a section editor."},
        {"role": "user", "content": f"INSTRUCTION\n{instruction}\n\nFIELD\n{j.original}"},
    ]


class Backend:
    """Replies from a script. Each element is either a string to return or an exception to raise."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls: list[tuple[list[dict[str, str]], dict]] = []

    def complete(self, messages, sampler):
        self.calls.append((messages, dict(sampler)))
        r = self.replies[min(len(self.calls) - 1, len(self.replies) - 1)]
        if isinstance(r, Exception):
            raise r
        return r


def block(text: str, notes: str = "") -> str:
    return f"{BEGIN}\n{text}\n{END}\n{notes}"


def drive(jobs, backend, **kw):
    return list(runner.run(jobs, instruction=INSTRUCTION, backend=backend, prompt=prompt,
                           sleep=lambda _s: None, **kw))


# ─────────────────────────────────────────────────────────── the stream itself

def test_the_event_stream_is_start_then_a_pair_per_field_then_finish():
    evs = drive([job("one"), job("two")], Backend(NOCHANGE))
    assert [e.kind for e in evs] == [
        runner.PASS_START,
        runner.FIELD_START, runner.FIELD_RESULT,
        runner.FIELD_START, runner.FIELD_RESULT,
        runner.PASS_FINISH,
    ]
    assert [e.seq for e in evs] == list(range(6)), "seq must be a dense, gapless ordering"
    assert evs[0].total == 2


def test_I12_a_field_finishes_before_the_next_one_starts():
    """Serial is the invariant, and the stream is where a consumer can see it. Interleaved
    starts would mean the report and the review queue have to order events themselves."""
    kinds = [e.kind for e in drive([job("a"), job("b"), job("c")], Backend(NOCHANGE))]
    depth = 0
    for k in kinds:
        if k == runner.FIELD_START:
            assert depth == 0, "a second field started while one was still in flight"
            depth += 1
        elif k == runner.FIELD_RESULT:
            depth -= 1
    assert depth == 0


# ─────────────────────────────────────────────────────────── I6, both paths

def test_I6_path_1_the_models_own_nochange_sentinel():
    evs = drive([job("untouched")], Backend(NOCHANGE))
    r = evs[-2].result
    assert r.status == "NOCHANGE" and r.revised is None


def test_I6_path_2_byte_identity_on_what_came_back():
    """Checks that path 2 byte identity on what came back."""
    evs = drive([job("untouched")], Backend(block("untouched", "Rewrote for clarity.")))
    r = evs[-2].result
    assert r.status == "NOCHANGE", "the byte-identity path did not fire"
    assert r.notes == "Rewrote for clarity."


# ─────────────────────────────────────────────────────────── I7, hold back

def test_I7_a_flagged_edit_is_held_back_and_the_original_is_untouched():
    original = "He arrived. He left.\n\nThen it rained."
    evs = drive([job(original)], Backend(block("He arrived.")))   # ratio + paragraph flags
    ev = evs[-2]
    assert ev.result.status == "CHANGED"
    assert ev.result.flags, "a two-thirds cut tripped no validator"
    assert ev.applied is False
    assert ev.result.job.original == original, "the runner mutated the original"


def test_I7_accept_flagged_applies_the_same_result():
    evs = drive([job("He arrived. He left.\n\nThen it rained.")], Backend(block("He arrived.")),
                accept_flagged=True)
    assert evs[-2].applied is True


def test_a_clean_edit_is_applied():
    evs = drive([job("Test Character 1 waited.")], Backend(block("Renamed Character 1 waited.")))
    assert evs[-2].result.flags == []
    assert evs[-2].applied is True


# Item 4 spans validation, review defaults, and materialization: accepted macro additions must
# produce an applied edit, not a pending proposal. These runner tests cover the full path.


def test_item4_inserting_a_macro_is_applied_not_held():
    evs = drive([job("Test User met her at a showing.")],
                Backend(block("{{user}} met her at a showing.")))
    res = evs[-2].result
    assert res.status == "CHANGED"
    assert res.flags == [], f"inserting a macro was flagged again: {res.flags}"
    assert evs[-2].applied is True, "the edit was held back — item 4, all over again"


def test_item4_the_pass_tally_reports_it_as_applied_rather_than_held():
    """Checks that item4 the pass tally reports it as applied rather than held."""
    evs = drive([job("Test User arrived."), job("Test User left.", n=2)],
                Backend(block("{{user}} arrived."), block("{{user}} left.")))
    tally = evs[-1].tally
    assert tally["CHANGED"] == 2
    assert tally["applied"] == 2, f"the tally still reports edits it did not apply: {tally}"
    assert tally["held"] == 0, f"held should be zero — this is item 4's symptom: {tally}"


def test_item4_a_field_without_his_name_still_comes_back_NOCHANGE():
    """The other half of what the real model did right: the untouched fields must not be rewritten
    into macros just because the instruction mentions one."""
    evs = drive([job("The counting room was cold.")], Backend(NOCHANGE))
    assert evs[-2].result.status == "NOCHANGE"
    assert evs[-2].applied is False, "a NOCHANGE is not an edit to apply"


def test_item4_losing_his_name_the_OTHER_way_is_still_flagged():
    """Checks that losing the local name through the alternate path is still flagged."""
    evs = drive([job("{{char}} greeted {{user}} warmly.")],
                Backend(block("Test Character 10 greeted Test User warmly.")))
    res = evs[-2].result
    assert any("dropped or altered" in f for f in res.flags), res.flags
    assert evs[-2].applied is False


def test_multiple_blocks_returns_a_body_AND_holds_it_back():
    """The first block is usually the intended one, so it is not thrown away — but applying half
    an answer without a human looking is exactly what the review queue is for."""
    raw = f"{BEGIN}\nfirst answer\n{END}\n{BEGIN}\nsecond answer\n{END}\n"
    evs = drive([job("first answer!")], Backend(raw))
    r = evs[-2].result
    assert r.status == "CHANGED" and r.revised == "first answer"
    assert "multiple blocks" in r.flags
    assert evs[-2].applied is False


# ─────────────────────────────────────────────────────────── retries

def test_a_transport_error_is_retried_and_can_succeed():
    b = Backend(TransportError("connection refused"), block("Renamed Character 1 waited."))
    evs = drive([job("Test Character 1 waited.")], b)
    assert len(b.calls) == 2
    assert evs[-2].result.status == "CHANGED"


def test_a_transport_error_that_never_clears_fails_the_field_not_the_pass():
    b = Backend(TransportError("connection refused"))
    evs = drive([job("a"), job("b")], b)
    assert len(b.calls) == 6, "3 attempts per field, and the second field must still run"
    assert [e.result.status for e in evs if e.kind == runner.FIELD_RESULT] == ["FAILED", "FAILED"]
    assert evs[-1].tally == {"FAILED": 2, "applied": 0, "held": 0}


def test_an_unreadable_reply_retries_then_fails_with_the_contracts_own_reason():
    b = Backend("I'm afraid I can't do that.")
    evs = drive([job("a")], b)
    assert len(b.calls) == 3
    assert evs[-2].result.status == "FAILED"
    assert evs[-2].result.reason == "sentinels missing"


def test_retries_are_configurable_and_zero_means_one_attempt():
    b = Backend(TransportError("nope"))
    drive([job("a")], b, retries=0)
    assert len(b.calls) == 1


# ─────────────────────────────────────────────────────────── I2 + I10, the sampler and the prompt

REP_PEN_INVARIANTS = {"rep_pen": 1.0, "rep_pen_range": 0, "dry_multiplier": 0, "xtc_probability": 0}


def test_I2_the_four_invariant_sampler_values_are_on_every_request_including_retries():
    """Checks that the four invariant sampler values are on every request including retries."""
    b = Backend("unreadable", "still unreadable", block("Renamed Character 1 waited."))
    drive([job("Test Character 1 waited.")], b)
    assert len(b.calls) == 3
    for _msgs, sampler in b.calls:
        for k, v in REP_PEN_INVARIANTS.items():
            assert sampler[k] == v, f"{k} was {sampler[k]!r} on a request, must be {v!r}"


def test_nothing_in_the_sampler_moves_on_a_reparse_retry_any_more():
    """Checks that nothing in the sampler moves on a reparse retry any more."""
    b = Backend("unreadable", "unreadable", "unreadable",     # field 1: three bad replies
                block("Renamed Character 1 waited."))                # field 2: fine
    drive([job("a"), job("Test Character 1 waited.")], b)
    base = profile()["temperature"]
    assert [s["temperature"] for _m, s in b.calls] == [base] * 4, \
        "a retry moved the temperature — measured to make the reply worse, not better"


def test_a_reparse_retry_prefills_the_opening_sentinel_and_it_does_not_leak_into_the_next_field():
    """Checks that a reparse retry prefills the opening sentinel and it does not leak into the next field."""
    b = Backend("unreadable", "unreadable", "unreadable",     # field 1: three bad replies
                block("Renamed Character 1 waited."))                # field 2: fine
    drive([job("a"), job("Test Character 1 waited.")], b)
    tails = [msgs[-1]["role"] for msgs, _s in b.calls]
    assert tails == ["user", "assistant", "assistant", "user"], \
        f"the prefill was not confined to retries: {tails}"
    assert b.calls[1][0][-1]["content"] == runner._PREFILL
    assert all(m["role"] != "assistant" or m["content"] != runner._PREFILL
               for m in b.calls[3][0][:-1] + [b.calls[3][0][-1]]), \
        "the prefill leaked into the first attempt of the next field"


def test_I10_the_instruction_is_byte_identical_in_every_request_of_a_pass():
    b = Backend(TransportError("x"), "unreadable", block("Renamed Character 1 waited."))
    drive([job("a"), job("b"), job("Test Character 1 waited.")], b)
    # Retries append the sentinel prefill as an assistant turn; keep the instruction byte-identical across attempts.
    users = [[m for m in msgs if m["role"] == "user"][-1] for msgs, _s in b.calls]
    seen = {u["content"].split("\n\nFIELD\n")[0] for u in users}
    assert seen == {f"INSTRUCTION\n{INSTRUCTION}"}, "the instruction varied within one pass"


def test_a_caller_supplied_sampler_is_used_and_not_mutated():
    s = profile()
    s["temperature"] = 0.9
    b = Backend("unreadable", "unreadable", "unreadable")
    drive([job("a")], b, sampler=s)
    assert s["temperature"] == 0.9, "the runner wrote through to the caller's sampler dict"
    assert [c[1]["temperature"] for c in b.calls] == [0.9, 0.9, 0.9]


# ─────────────────────────────────────────────────────────── I16, containment

def test_I16_no_public_frame_carries_a_body_a_note_or_a_reason_that_could_hold_one():
    """§10: grep every produced artifact for the fixture sentinel. This is the SSE side."""
    body = f"Test Character 1 guarded the {SENTINEL} ledger."
    revised = f"Renamed Character 1 guarded the {SENTINEL} ledger, closely."
    evs = drive([job(body)], Backend(block(revised, f"Tightened the {SENTINEL} clause.")))

    blob = json.dumps([e.public() for e in evs])
    assert SENTINEL not in blob, "document text reached a public frame"
    assert "notes" not in blob, "the model's prose about the field must not travel either"

    ev = [e for e in evs if e.kind == runner.FIELD_RESULT][0]
    assert ev.public()["status"] == "CHANGED"        # metadata still travels
    assert ev.result.revised == revised, "...and the body is still on the event for the report"


def test_I16_a_dropped_macro_does_not_publish_what_was_inside_it():
    """Checks that a dropped macro does not publish what was inside it."""
    body = f"Test Character 1 guarded the ledger. {{{{// {SENTINEL}}}}}"
    revised = "Renamed Character 1 guarded the ledger."          # the macro is gone: the check fires
    evs = drive([job(body)], Backend(block(revised)))

    flags = [f for e in evs if e.kind == runner.FIELD_RESULT for f in e.result.flags]
    assert any("macro/template tokens dropped" in f for f in flags), \
        "precondition: dropping the comment macro must still be flagged at all"
    assert SENTINEL not in json.dumps([e.public() for e in evs]), \
        "the contents of a dropped macro reached a public frame"
    assert any("{{//…}}" in f for f in flags), "...and the flag must still name what was lost"


def test_I16_a_leaked_context_header_does_not_publish_the_line_that_followed_it():
    """Checks that a leaked context header does not publish the line that followed it."""
    revised = f"CONTEXT (reference only) {SENTINEL}\n\nRenamed Character 1 guarded the ledger."
    evs = drive([job("Test Character 1 guarded the ledger.")], Backend(block(revised)))

    flags = [f for e in evs if e.kind == runner.FIELD_RESULT for f in e.result.flags]
    assert any("protocol text leaked" in f for f in flags), \
        "precondition: the leaked header must still be detected"
    assert SENTINEL not in json.dumps([e.public() for e in evs]), \
        "the text following a leaked protocol header reached a public frame"


def test_I16_a_transport_error_carrying_field_text_is_collapsed_in_public():
    """Checks that a transport error carrying field text is collapsed in public."""
    b = Backend(TransportError(f"400 on payload: {SENTINEL}"))
    evs = drive([job("a")], b)
    r = evs[-2]
    assert SENTINEL in r.result.reason, "precondition: the leak is in the raw reason"
    assert r.public()["reason"] == "transport"
    assert SENTINEL not in json.dumps(r.public())


@pytest.mark.parametrize("reason", ["nochange", "model refused", "sentinels missing",
                                    "multiple blocks", "unparseable"])
def test_the_contracts_own_reasons_travel_verbatim(reason):
    """They are a closed vocabulary of our own strings, so collapsing them would cost the UI
    real information for no privacy gain."""
    assert runner._public_reason(reason) == reason


# ─────────────────────────────────────────────────────────── the report subscriber

def build_report(jobs, backend, **kw):
    out: list[str] = []
    flushes = []
    rep = MarkdownReport(out.append, instruction=INSTRUCTION, source="book.json",
                         flush=lambda: flushes.append(len(out)), clock=lambda: "STAMP")
    for ev in runner.run(jobs, instruction=INSTRUCTION, backend=backend, prompt=prompt,
                         sleep=lambda _s: None, **kw):
        rep.feed(ev)
    return "".join(out), flushes


def test_the_report_carries_the_bodies_because_that_is_its_job():
    body = f"Test Character 1 guarded the {SENTINEL} ledger."
    revised = f"Renamed Character 1 guarded the {SENTINEL} ledger."
    text, _ = build_report([job(body)], Backend(block(revised)))
    assert "**BEFORE**" in text and "**AFTER**" in text
    assert body in text and revised in text
    assert "book.json :: entry 1" in text


def test_the_report_flushes_per_field_not_per_pass():
    """§5: a 35-minute pass must survive a restart with everything up to field N durable."""
    _text, flushes = build_report([job("a"), job("b"), job("c")], Backend(NOCHANGE))
    assert len(flushes) == 5, "expected header + one per field + summary"


def test_the_summary_counts_what_happened():
    b = Backend(block("Renamed Character 1 waited."))
    text, _ = build_report([job("Test Character 1 waited.")], b)
    assert "- CHANGED: 1\n" in text
    assert "- applied to output: 1\n" in text
    assert "flagged and held back" not in text, "nothing was held back — do not print a zero"


def test_a_held_back_edit_says_so_in_both_places():
    text, _ = build_report([job("He arrived. He left.\n\nThen it rained.")],
                           Backend(block("He arrived.")))
    assert "(held back)" in text
    assert "**FLAG:**" in text
    assert "- flagged and held back: 1\n" in text


def test_I3_the_report_fence_widens_past_a_fence_inside_the_content():
    """A worldbook entry describing a config file quotes fenced blocks, and a report whose own
    fence is shorter renders as garbage from that entry onward."""
    body = "before\n~~~~~~\ninner fence\n~~~~~~\nafter"
    text, _ = build_report([job(body)], Backend(block(body + " and more, materially longer.")))
    assert "\n~~~~~~~\n" in text, "the fence did not widen past the content's own"


# ──────────────────────────────── §3.1 — the seam, where the retry contract was broken

def test_the_real_transport_translates_kobold_unreachable_into_a_transport_error():
    """Checks that the real transport translates kobold unreachable into a transport error."""
    import kobold
    from vocalis.web.wbedit import kobold_post

    def boom(cfg, path, body, timeout):
        raise kobold.KoboldUnreachable("HTTP 503 from https://test-server.invalid:5001/v1/chat/completions")

    post = kobold_post(object())
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(kobold, "_request", boom)
        with pytest.raises(TransportError) as exc:
            post("/v1/chat/completions", {"messages": []}, 900.0)

    assert "503" in str(exc.value), "the reason must survive the translation"
    assert "chat/completions" in str(exc.value)


def test_a_kobold_outage_mid_pass_is_retried_rather_than_abandoning_the_remaining_fields():
    """Checks that a kobold outage mid pass is retried rather than abandoning the remaining fields."""
    import kobold
    from wbedit.backends.kobold_chat import KoboldChat
    from vocalis.web.wbedit import kobold_post

    calls = []

    def flaky(cfg, path, body, timeout):
        calls.append(path)
        if len(calls) == 1:
            raise kobold.KoboldUnreachable("connection refused")
        return {"choices": [{"message": {"content": block("Renamed Character 1 waited.")}}]}

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(kobold, "_request", flaky)
        backend = KoboldChat(kobold_post(object()), model="test")
        evs = drive([job("Test Character 1 waited.")], backend)

    assert len(calls) == 2, "the outage was not retried"
    assert evs[-2].result.status == "CHANGED", "the field failed instead of recovering"
    assert evs[-1].tally.get("FAILED", 0) == 0, "the pass was failed by a recoverable blip"
