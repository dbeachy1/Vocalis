"""Tests request and response shapes used by model backends."""
from __future__ import annotations

import inspect
import json
import time

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import runner
from wbedit.backends.mock import MockBackend
from wbedit.core import contract
from wbedit.core.contract import BEGIN, END, NOCHANGE
from wbedit.core.job import Job

INSTRUCTION = ("Rename the character Test Character 1 to Renamed Character 1. Change every reference to "
               "that character, including oblique ones such as 'the Character 1'. Change nothing else.")

ORIGINAL = "Test Character 1 waited by the ledger until the counting room had emptied."
EDITED = ORIGINAL.replace("Test Character 1", "Renamed Character 1")

#: Where the token ceiling lands in the two truncation shapes. Shared between the double that
#: emits them and the assertion that pins what came back, so the two cannot drift apart.
PARTIAL = "Renamed Character 1 waited by the ledger until the counting room had em"
TRUNCATED = "Renamed Character 1 waited by the ledger until the counting room had emp"

#: Repeated reasoning text can exhaust the configured 4096-token response budget.
OVERTHINKING = "Actually, I think I'm overthinking this"


# ────────────────────────────────────────── the wiring (copied from test_wbedit_runner.py)

def job(text: str = ORIGINAL, *, rel: str = "book.json", label: str = "entry 1", n: int = 1) -> Job:
    return Job(rel=rel, locator=("entries", str(n), "content"), label=label, original=text,
               meta={"kind": "worldbook entry"})


def prompt(j: Job, instruction: str) -> list[dict[str, str]]:
    """Stands in for `prompt/assemble.py`. Shaped like the real one: the instruction verbatim,
    then the field under a FIELD header."""
    return [
        {"role": "system", "content": "You are a section editor."},
        {"role": "user", "content": f"INSTRUCTION\n{instruction}\n\nFIELD\n{j.original}"},
    ]


def drive(jobs, backend, **kw):
    """`sleep` is stubbed so the RETRY BACKOFF costs nothing. A double's own sleep is left alone —
    that is the thing under test in `SlowBackend`."""
    return list(runner.run(jobs, instruction=INSTRUCTION, backend=backend, prompt=prompt,
                           sleep=lambda _s: None, **kw))


def result_of(evs):
    return [e for e in evs if e.kind == runner.FIELD_RESULT][0]


def flagged(res, needle: str) -> bool:
    """Checks that flagged."""
    return any(needle in f for f in res.flags)


# ────────────────────────────────────────── the reasoning filler

#: Beats of plausible deliberation, generated into a wall of text rather than pasted: 4,000 words
#: of prose in a source file is unreadable, and the SIZE is the point rather than the wording.
_BEATS = (
    "The instruction is to rename the character Test Character 1 to Renamed Character 1.",
    "First I should find every reference to that character in the field.",
    "There is a direct reference in the first clause, which is straightforward.",
    "But the instruction also mentions oblique references such as 'the Character 1'.",
    "Does the phrase 'the ledger' count as an oblique reference to the character?",
    "No, the ledger is an object; the character merely keeps it, so it stays.",
    "The generic label ends in Character 1, so 'the Character 1' is its oblique form.",
    "Let me re-read the instruction to be certain about what must not change.",
    "It says to change nothing else, so punctuation and paragraph breaks stay.",
    "I should be careful not to reflow the text or normalize any whitespace.",
    "The card also says commentary goes after the closing sentinel, not inside.",
    "So the body between the sentinels is the field value and nothing besides.",
    "Wait, should I preserve the trailing period? Yes, it is part of the field.",
    "I will emit the opening sentinel, then the edited field, then the closing one.",
)


def reasoning_filler(n_words: int = 4000) -> str:
    """Checks that reasoning filler."""
    out: list[str] = []
    n = 0
    i = 0
    while n < n_words:
        line = _BEATS[i % len(_BEATS)]
        if i % 7 == 6:
            line = f"{OVERTHINKING}. {line}"
        out.append(line)
        n += len(line.split())
        i += 1
    return "\n".join(out)


REASONING = reasoning_filler()


def test_the_filler_really_is_the_size_the_real_failure_was():
    """Checks that the filler really is the size the real failure was."""
    assert len(REASONING.split()) >= 4000, "the reasoning block is no longer budget-sized"
    assert REASONING.count(OVERTHINKING) >= 5, \
        "the repeated-reasoning fixture no longer contains enough repetitions"
    assert len(REASONING) > 300 * len(ORIGINAL), "the size disparity is the point; it is gone"


# ────────────────────────────────────────── the doubles

class _Double:
    """Base for the shapes below: records every call, exactly as `MockBackend` does, so a test can
    assert how many generations a doomed reply was paid for."""

    def __init__(self):
        self.calls: list[tuple[list[dict[str, str]], dict]] = []

    def reply(self) -> str:                                     # pragma: no cover — abstract
        raise NotImplementedError

    def complete(self, messages, sampler):
        self.calls.append((messages, dict(sampler)))
        return self.reply()


class ReasoningNeverClosesBackend(_Double):
    """Simulate a response that spends its token budget reasoning and ends before the closing sentinel."""

    def reply(self):
        return f"<think>\n{REASONING}\n</think>\n{BEGIN}\n{PARTIAL}"


class ReasoningOnlyBackend(_Double):
    """Tests reasoningonlybackend behavior."""

    def reply(self):
        return f"<think>\n{REASONING}\n{OVERTHINKING}. Let me start over and consider the"


class ThinkTagBackend(_Double):
    """Tests thinktagbackend behavior."""

    def reply(self):
        return (f"<think>\nThe field names Test Character 1 once. Rename it and change nothing else.\n"
                f"{OVERTHINKING}. It is a single substitution.\n</think>\n"
                f"{BEGIN}\n{EDITED}\n{END}\nRenamed the character; nothing else touched.")


class FakeClock:
    """The clock `runner.run` reads through its `now` argument. It only moves when a test says so."""

    def __init__(self):
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class SlowBackend(_Double):
    """A reply that takes `seconds` of the injected clock's time to arrive. Nothing really sleeps:
    the wait is `clock.advance(seconds)`, and the runner is handed the same clock as its `now`."""

    def __init__(self, clock: FakeClock, seconds: float = 0.05, reply_text: str | None = None):
        super().__init__()
        self.clock = clock
        self.seconds = seconds
        self.reply_text = (reply_text if reply_text is not None
                           else f"{BEGIN}\n{EDITED}\n{END}\nDone.")

    def reply(self):
        self.clock.advance(self.seconds)
        return self.reply_text


class TruncatedMidSentenceBackend(_Double):
    """Tests truncatedmidsentencebackend behavior."""

    def reply(self):
        return f"{BEGIN}\n{TRUNCATED}"


class ReasoningMentionsRefusalBackend(_Double):
    """Tests reasoningmentionsrefusalbackend behavior."""

    def reply(self):
        return (f'<think>\nThe card says to answer "Outside scope." when the request is not a '
                f"single-field edit. This one is a rename inside one field, so that does not "
                f"apply and I should perform the edit.\n</think>\n"
                f"{BEGIN}\n{EDITED}\n{END}\nRenamed the character.")


class ThinkThenNochangeBackend(_Double):
    """Tests thinkthennochangebackend behavior."""

    def reply(self):
        return (f"<think>\nThis field never mentions Test Character 1, so there is nothing to "
                f"rename here.\n</think>\n{NOCHANGE}")


# ═════════════════════════════════════════ 1. `extract()` — the contract, shape by shape
#
# ⚠️ Every test in this section is about `extract()` ALONE. Salvage is a second, later chance that
# only the runner takes, and only after every retry is spent — so a defect pinned here is still a
# defect even where the runner goes on to recover from it. `extract()` is also what the store,
# the CLI path and any future consumer see.


def test_a_reply_that_reasons_forever_and_never_closes_yields_no_body_at_all():
    """§9a.13b step 3: no closing sentinel, so `extract` returns no field. The 23 KB the model
    actually produced — reasoning AND the partial answer — comes back as `("", "")`."""
    raw = ReasoningNeverClosesBackend().reply()
    assert len(raw) > 15000, "precondition: this is a genuinely budget-sized reply"
    assert BEGIN in raw and END not in raw, "precondition: opened but never closed"

    assert contract.extract(raw) == (None, "", "sentinels missing")


def test_extract_alone_discards_the_partial_field_inside_an_unclosed_block():
    """Checks that extract alone discards the partial field inside an unclosed block."""
    raw = ReasoningNeverClosesBackend().reply()
    assert PARTIAL in raw, "precondition: a real partial edit is in the reply"
    assert contract.extract(raw) == (None, "", "sentinels missing")


def test_never_opening_and_never_closing_are_the_SAME_reason_and_cannot_be_told_apart():
    """Checks that never opening and never closing are the same reason and cannot be told apart."""
    never_closed = contract.extract(ReasoningNeverClosesBackend().reply())
    never_opened = contract.extract(ReasoningOnlyBackend().reply())
    # TODO(9a.13b): this is the defect — the reason must name the token ceiling
    assert never_closed == never_opened == (None, "", "sentinels missing")


def test_a_closed_think_block_before_a_clean_answer_is_discarded_and_the_body_survives():
    """Checks that a closed think block before a clean answer is discarded and the body survives."""
    body, notes, reason = contract.extract(ThinkTagBackend().reply())
    assert body == EDITED, "the answer was damaged by the reasoning that preceded it"
    assert reason == ""
    assert "<think>" not in body and OVERTHINKING not in body, "reasoning leaked into the field"
    assert "<think>" not in notes and OVERTHINKING not in notes, "reasoning leaked into the notes"
    assert notes == "Renamed the character; nothing else touched."


def test_reasoning_that_merely_QUOTES_the_refusal_phrase_still_yields_the_perfect_answer():
    """Checks that reasoning that merely quotes the refusal phrase still yields the perfect answer."""
    raw = ReasoningMentionsRefusalBackend().reply()
    assert f"{BEGIN}\n{EDITED}\n{END}" in raw, "precondition: the answer itself is perfect"
    body, _notes, reason = contract.extract(raw)
    assert (body, reason) == (EDITED, ""), "a quoted refusal phrase still ate the real answer"


def test_reasoning_before_a_correct_NOCHANGE_is_recognized_as_a_NOCHANGE():
    """Checks that reasoning before a correct nochange is recognized as a nochange."""
    assert contract.extract(ThinkThenNochangeBackend().reply()) == (None, "", "nochange")


# ═════════════════════════════════════════ 2. `salvage()` — the second chance, and its blind spots


def test_salvage_recovers_the_partial_field_from_an_unterminated_block():
    """Checks that salvage recovers the partial field from an unterminated block."""
    body, notes, how = contract.salvage(ReasoningNeverClosesBackend().reply(), ORIGINAL)
    assert body == PARTIAL, "the reasoning above the sentinel was not excluded cleanly"
    assert notes == ""
    assert how == "unterminated block"


def test_salvage_declines_a_reply_that_is_all_reasoning_and_no_answer():
    """Checks that salvage declines a reply that is all reasoning and no answer."""
    assert contract.salvage(ReasoningOnlyBackend().reply(), ORIGINAL) == (None, "", "")


def test_salvage_is_never_reached_for_a_reply_extract_can_now_read():
    """Checks that salvage is never reached for a reply extract can now read."""
    raw = ReasoningMentionsRefusalBackend().reply()
    assert f"{BEGIN}\n{EDITED}\n{END}" in raw, "precondition: a perfect block is sitting in there"
    assert contract.extract(raw)[0] == EDITED, "extract must handle this without salvage"
    assert contract.salvage(raw, ORIGINAL) == (None, "", "")


def test_salvage_declines_a_correct_decline_instead_of_proposing_the_reasoning():
    """Checks that salvage declines a correct decline instead of proposing the reasoning."""
    raw = ThinkThenNochangeBackend().reply()
    assert contract.salvage(raw, ORIGINAL) == (None, "", ""), \
        "salvage proposed something for a reply whose answer was 'change nothing'"
    # The two reasoning traces that must not become a field's proposed value.
    assert NOCHANGE in raw and "<think>" in raw, "precondition: both are present in the reply"


def test_salvage_is_never_consulted_for_a_reply_that_parses_normally():
    """Checks that salvage is never consulted for a reply that parses normally."""
    assert contract.salvage(ThinkTagBackend().reply(), ORIGINAL) == (None, "", "")


# ═════════════════════════════════════════ 3. the runner, end to end on each shape


@pytest.mark.parametrize("double,recovered", [(ReasoningNeverClosesBackend, PARTIAL),
                                              (TruncatedMidSentenceBackend, TRUNCATED)])
def test_a_truncated_answer_is_recovered_flagged_and_held_for_review(double, recovered):
    """Recovered text is flagged for review and is never applied automatically. Different truncation causes can require different follow-up actions."""
    evs = drive([job()], double())
    ev = result_of(evs)
    assert ev.result.status == "CHANGED"
    assert ev.result.revised == recovered
    assert flagged(ev.result, "salvaged"), f"nothing marked it as recovered: {ev.result.flags}"
    assert flagged(ev.result, "truncated"), "the terminal-punctuation check did not fire"
    assert ev.applied is False, "🔴 salvaged text was applied without review — I7"
    assert evs[-1].tally == {"CHANGED": 1, "applied": 0, "held": 1}


def test_a_salvaged_result_carries_its_marker_only_in_the_flags_and_not_in_the_reason():
    """Checks that a salvaged result carries its marker only in the flags and not in the reason."""
    res = result_of(drive([job()], TruncatedMidSentenceBackend())).result
    assert res.reason == "", "a salvaged result now sets a reason — update the consumers"
    assert flagged(res, "salvaged: unterminated block")


def test_a_reply_that_is_all_reasoning_fails_the_field_and_leaves_no_trace_anywhere():
    """A reasoning-only response is rejected, and the failure does not place private field text in persistent output."""
    b = ReasoningOnlyBackend()
    res = result_of(drive([job()], b)).result
    assert len(b.calls) == 3, "3 attempts — the default `retries=2` plus the first"
    assert (res.status, res.reason, res.revised) == ("FAILED", "sentinels missing", None)
    assert res.notes == "" and res.flags == []
    # TODO(9a.13b): this is the defect — the reason must distinguish a ceiling from a bad parse
    blob = json.dumps({"reason": res.reason, "notes": res.notes, "flags": res.flags})
    assert OVERTHINKING not in blob, "nothing the model said reaches the Result"


def test_a_reasoned_answer_is_applied_exactly_like_an_unreasoned_one():
    """Checks that a reasoned answer is applied exactly like an unreasoned one."""
    evs = drive([job()], ThinkTagBackend())
    ev = result_of(evs)
    assert ev.result.status == "CHANGED"
    assert ev.result.revised == EDITED
    assert ev.result.flags == [], f"a reasoned reply was flagged: {ev.result.flags}"
    assert ev.result.notes == "Renamed the character; nothing else touched."
    assert ev.applied is True
    assert evs[-1].tally == {"CHANGED": 1, "applied": 1, "held": 0}


def test_a_reasoned_perfect_edit_is_applied_on_the_first_attempt():
    """A valid edit embedded in a reasoning response is recovered on the first attempt without retrying."""
    b = ReasoningMentionsRefusalBackend()
    ev = result_of(drive([job()], b))
    assert len(b.calls) == 1, "a reply that was right first time was re-asked"
    assert (ev.result.status, ev.result.revised) == ("CHANGED", EDITED)
    assert ev.result.flags == [], f"a clean reasoned edit was flagged: {ev.result.flags}"
    assert ev.applied is True


def test_a_reasoned_correct_decline_is_reported_as_a_NOCHANGE():
    """A decline wrapped in reasoning remains a `NOCHANGE`; the runner must not propose the reasoning as field content."""
    evs = drive([job(), job(n=2)], ThinkThenNochangeBackend())
    ev = result_of(evs)
    assert evs[-1].tally == {"NOCHANGE": 2, "applied": 0, "held": 0}
    assert ev.result.status == "NOCHANGE"
    assert ev.result.revised is None, "a decline must not carry a proposed body"
    assert ev.applied is False


# ═════════════════════════════════════════ 4. time — nothing here is instant


#: How long `SlowBackend` stalls on the injected clock.
#:
#: SUPERSEDED HISTORY (kept as the reason these tests no longer sleep): 🔴 **`sleep(t)` DOES NOT
#: GUARANTEE `monotonic()` MOVED BY `t` ON WINDOWS, AND THIS FILE CAUGHT IT ON ITS SECOND RUN.**
#: `time.sleep(0.05)` measured 0.0460s — the two clocks disagree by up to the ~15.6 ms system timer
#: granularity, so `assert elapsed >= SLOW` was a coin flip on Windows, and the assertion had to be
#: loosened to 70 % of the wait. `runner.run` takes its clock as `now`, so the tests now hand it a
#: `FakeClock` that `SlowBackend` advances by exactly `SLOW` per reply: no real time passes, and the
#: elapsed stamp can be asserted exactly instead of by a tolerance.
SLOW = 0.05


def test_a_slow_reply_is_simply_waited_out_and_the_wait_is_recorded():
    """Checks that a slow reply is simply waited out and the wait is recorded."""
    clock = FakeClock()
    b = SlowBackend(clock, seconds=SLOW)
    res = result_of(drive([job()], b, now=clock)).result

    assert res.status == "CHANGED"
    assert res.elapsed == pytest.approx(SLOW), \
        f"the elapsed stamp did not observe the wait: {res.elapsed}"
    assert clock() == pytest.approx(SLOW)


def test_a_reply_that_needs_salvaging_still_costs_the_full_wait_THREE_TIMES_first():
    """Checks that a reply that needs salvaging still costs the full wait three times first."""
    clock = FakeClock()
    b = SlowBackend(clock, seconds=SLOW, reply_text=f"{BEGIN}\n{TRUNCATED}")
    res = result_of(drive([job()], b, now=clock)).result

    assert len(b.calls) == 3
    assert res.status == "CHANGED" and res.revised == TRUNCATED, "salvage did not fire at all"
    # TODO: Do not retry a reply that hit the token ceiling; it cannot produce a complete field.
    assert clock() == pytest.approx(3 * SLOW), \
        f"three doomed generations were not actually paid for: {clock():.3f}s"
    assert res.elapsed == pytest.approx(3 * SLOW)


def test_nothing_in_the_runner_bounds_how_long_a_single_field_may_take():
    """Checks that nothing in the runner bounds how long a single field may take."""
    params = set(inspect.signature(runner.run).parameters)
    assert not (params & {"timeout", "deadline", "budget", "max_seconds", "max_tokens"}), \
        "a wall-clock bound was added — update this test and §9a.13b"
    assert {"retries", "now", "sleep"} <= params, "the shape this test describes has changed"


# ═════════════════════════════════════════ 5. I16 — what survives into a public frame


def test_a_failed_field_says_why_in_the_public_frame_and_says_nothing_else():
    """Checks that a failed field says why in the public frame and says nothing else."""
    frame = result_of(drive([job()], ReasoningOnlyBackend())).public()
    assert frame["status"] == "FAILED"
    assert frame["reason"] == "sentinels missing"
    blob = json.dumps(frame)
    for leak in (OVERTHINKING, "Test Character 1", "counting room", "<think>", "the ledger"):
        assert leak not in blob, f"I16: {leak!r} reached a public frame"


def test_a_salvaged_body_stays_off_the_public_frame_exactly_like_a_parsed_one():
    """Checks that a salvaged body stays off the public frame exactly like a parsed one."""
    ev = result_of(drive([job()], ReasoningNeverClosesBackend()))
    assert ev.result.revised == PARTIAL, "precondition: there IS a body to leak"
    blob = json.dumps(ev.public())
    for leak in ("Renamed Character 1", "counting room", OVERTHINKING, "<think>"):
        assert leak not in blob, f"I16: {leak!r} reached a public frame via salvage"
    assert "salvaged: unterminated block" in blob, \
        "the flag is a closed-vocabulary string and SHOULD travel — the UI needs it"


def test_the_reasoning_body_salvaged_from_a_decline_also_stays_off_the_frame():
    """The worst body in this file — a `<think>` block — must still not travel. Same rule, and the
    branch most likely to be forgotten because the body is not really field text at all."""
    ev = result_of(drive([job()], ThinkThenNochangeBackend()))
    blob = json.dumps(ev.public())
    assert "<think>" not in blob and "Test Character 1" not in blob
    assert "notes" not in blob, "the model's prose about the field must not travel either"


# ═════════════════════════════════════════ 6. the mock's blind spot, recorded in the suite


#: Fields chosen to hit both of `MockBackend`'s branches and both NOCHANGE paths.
_MOCK_CORPUS = (
    "Test Character 1 waited by the ledger.",
    "The rains come off the estuary in the ninth month.",
    "{{char}} watched {{user}} cross the room. Test Character 1 said nothing.",
    "Test Character 1.\n\nTest Character 1.\n\nTest Character 1.",
    "```\nledger:\n  owed: 40\n```\n\nTest Character 1 keeps the book.",
    "",
)


@pytest.mark.parametrize("text", _MOCK_CORPUS)
def test_the_mock_ALWAYS_closes_its_sentinel_which_is_why_this_file_exists(text):
    """Checks that the mock always closes its sentinel which is why this file exists."""
    raw = MockBackend().complete(prompt(job(text), INSTRUCTION), {})
    _body, _notes, reason = contract.extract(raw)

    if raw.startswith(NOCHANGE):
        assert reason == "nochange"
        return
    assert raw.startswith(BEGIN), "the mock's only other branch is a full block"
    assert END in raw, "🔴 the mock emitted an unclosed sentinel — see this file's docstring"
    assert reason == "", f"the mock produced an unparseable reply: {reason}"


def test_the_mock_never_thinks_never_stalls_and_never_needs_salvaging():
    """The properties of the double that made §9a.13, §9a.13a and §9a.13b invisible, pinned
    together so the claim in the design doc has a test behind it rather than only prose."""
    b = MockBackend()
    t0 = time.monotonic()
    evs = drive([job()], b)
    wall = time.monotonic() - t0

    raw = b.complete(prompt(job(), INSTRUCTION), {})
    assert "<think>" not in raw and OVERTHINKING not in raw, "the mock does not reason"
    assert raw.rstrip().endswith("Name substituted."), "the mock never stops mid-sentence"
    assert wall < 0.5, "the mock is instant — the real model is ~26s per field (§9a.13)"
    assert result_of(evs).result.status == "CHANGED"
    assert result_of(evs).result.flags == [], "the mock never produces anything to flag"
    assert len(b.calls) == 2, "one call for the pass, one for the direct probe above — no retries"
