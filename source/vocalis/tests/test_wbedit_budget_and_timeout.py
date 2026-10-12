"""Tests per-field response budgets and backend timeout handling."""
from __future__ import annotations

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import runner
from wbedit.backends.base import TransportError, profile
from wbedit.backends.kobold_chat import CHAT_PATH, NO_REPLY, KoboldChat
from wbedit.core.contract import NOCHANGE
from wbedit.core.job import Job

INSTRUCTION = "Rename Test Character 1 to Renamed Character 1 wherever he appears."


def job(text: str, *, n: int = 1) -> Job:
    return Job(rel="book.json", locator=("entries", str(n), "content"),
               label=f"entry {n}", original=text, meta={"kind": "worldbook entry"})


def prompt(j: Job, instruction: str) -> list[dict[str, str]]:
    return [{"role": "system", "content": "You are a section editor."},
            {"role": "user", "content": f"INSTRUCTION\n{instruction}\n\nFIELD\n{j.original}"}]


class Recorder:
    """A backend that answers NOCHANGE and keeps every sampler block it was handed."""

    def __init__(self):
        self.samplers: list[dict] = []

    def complete(self, messages, sampler):
        self.samplers.append(dict(sampler))
        return NOCHANGE


# ── the budget itself ────────────────────────────────────────────────────────

def test_a_short_field_keeps_the_profiles_own_max_tokens_exactly():
    """Checks that a short field keeps the profiles own max tokens exactly."""
    assert runner._reply_budget("a short sentence.", 4096) == 4096
    assert runner._reply_budget("", 4096) == 4096


def test_a_field_too_large_to_round_trip_at_the_floor_is_given_more():
    """Checks that a field too large to round trip at the floor is given more."""
    big = "x" * 40_000
    assert runner._reply_budget(big, 4096) > 4096
    # It has to be enough to carry the field back, not merely more than the floor: at
    # ~3 chars/token the field alone is ~13,300 tokens before sentinels or a change note.
    assert runner._reply_budget(big, 4096) >= len(big) / runner._CHARS_PER_TOKEN


def test_the_budget_never_exceeds_the_ceiling_however_big_the_field():
    """A 500 KB paste must not ask KoboldCpp for a million tokens. The ceiling is what stops one
    pathological field turning into an unbounded generation."""
    assert runner._reply_budget("x" * 5_000_000, 4096) == runner._REPLY_CEILING
    assert runner._reply_budget("x" * 500_000, 0) == runner._REPLY_CEILING


def test_the_budget_only_ever_grows_with_the_field():
    """Monotonic, or a slightly longer field could be given a slightly smaller allowance — a
    truncation that would look like a model fault and be reproducible on exactly one entry."""
    sizes = [0, 1_000, 10_000, 30_000, 60_000, 200_000]
    budgets = [runner._reply_budget("x" * n, 4096) for n in sizes]
    assert budgets == sorted(budgets)


def test_the_headroom_is_real_and_not_a_rounding_error():
    """Checks that the headroom is real and not a rounding error."""
    field = "x" * 30_000                        # below the ceiling, so the headroom is visible
    naive = len(field) / runner._CHARS_PER_TOKEN
    assert runner._reply_budget(field, 0) >= naive * 1.5


def test_the_ceiling_starts_biting_before_the_headroom_runs_out():
    """Checks that the ceiling starts biting before the headroom runs out."""
    assert runner._reply_budget("x" * 37_000, 0) < runner._REPLY_CEILING
    assert runner._reply_budget("x" * 38_000, 0) == runner._REPLY_CEILING
    doomed = int(runner._REPLY_CEILING * runner._CHARS_PER_TOKEN) + 10_000
    assert runner._reply_budget("x" * doomed, 0) * runner._CHARS_PER_TOKEN < doomed


def test_a_missing_or_zero_floor_does_not_raise_and_does_not_win():
    """The floor comes off a sampler block that a caller assembled. `None` reaches this as
    `int(floor or 0)`; it must behave as "no floor", never as a crash mid-pass."""
    assert runner._reply_budget("hello", None) == 512 + int(5 / runner._CHARS_PER_TOKEN * 1.6)
    assert runner._reply_budget("hello", 0) == runner._reply_budget("hello", None)


def test_a_floor_above_the_computed_need_still_wins():
    """A profile that asks for more than the estimate keeps it — this function raises a budget,
    it never lowers one."""
    assert runner._reply_budget("short", 8192) == 8192


# ── and what the backend actually receives ───────────────────────────────────

def test_each_field_is_budgeted_SEPARATELY_within_one_pass():
    """Checks that each field is budgeted separately within one pass."""
    b = Recorder()
    list(runner.run([job("a small field.", n=1), job("y" * 40_000, n=2)],
                    instruction=INSTRUCTION, backend=b, prompt=prompt, sleep=lambda _s: None))
    assert len(b.samplers) == 2
    assert b.samplers[0]["max_tokens"] == profile()["max_tokens"]
    assert b.samplers[1]["max_tokens"] > b.samplers[0]["max_tokens"], \
        "both fields were given the same budget — the estimate is not per-field"


def test_the_budget_does_not_leak_into_the_next_field(monkeypatch):
    """Checks that the budget does not leak into the next field."""
    b = Recorder()
    list(runner.run([job("y" * 40_000, n=1), job("a small field.", n=2)],
                    instruction=INSTRUCTION, backend=b, prompt=prompt, sleep=lambda _s: None))
    assert b.samplers[1]["max_tokens"] == profile()["max_tokens"], \
        "the large field's budget leaked into the next one"


def test_a_caller_supplied_sampler_is_not_mutated_by_the_budget():
    """The caller's dict is `prompt.settings`' resolved profile in production, and it is reused
    across passes in the same process."""
    mine = dict(profile())
    before = dict(mine)
    list(runner.run([job("y" * 40_000)], instruction=INSTRUCTION, backend=Recorder(),
                    prompt=prompt, sampler=mine, sleep=lambda _s: None))
    assert mine == before, "runner.run wrote into the sampler it was handed"


def test_everything_else_in_the_profile_reaches_the_backend_untouched():
    """Checks that everything else in the profile reaches the backend untouched."""
    b = Recorder()
    list(runner.run([job("y" * 40_000)], instruction=INSTRUCTION, backend=b, prompt=prompt,
                    sleep=lambda _s: None))
    got, expected = b.samplers[0], profile()
    assert set(got) == set(expected)
    for k in expected:
        if k != "max_tokens":
            assert got[k] == expected[k], f"{k} was changed on the way to the backend"


# ── the only wall-clock ceiling in the system ────────────────────────────────

def test_the_backends_timeout_is_the_number_handed_to_the_transport():
    """Checks that the backends timeout is the number handed to the transport."""
    seen = []

    def post(path, body, timeout):
        seen.append((path, timeout))
        return {"choices": [{"message": {"content": "hi"}}]}

    KoboldChat(post, timeout=42.0).complete([{"role": "user", "content": "x"}], {})
    assert seen == [(CHAT_PATH, 42.0)]


def test_the_default_timeout_is_ten_minutes_not_the_socket_default():
    """Checks that the default timeout is ten minutes not the socket default."""
    seen = []
    KoboldChat(lambda path, body, timeout: seen.append(timeout) or
               {"choices": [{"message": {"content": "hi"}}]}).complete([], {})
    assert seen == [600.0]
    assert KoboldChat(lambda *a: None).timeout == 600.0


def test_a_timeout_becomes_a_TransportError_so_the_runner_can_retry_it():
    """Checks that a timeout becomes `TransportError` so the runner can retry it."""
    def post(path, body, timeout):
        raise TimeoutError("timed out")

    with pytest.raises(TransportError):
        KoboldChat(post).complete([{"role": "user", "content": "x"}], {})


def test_a_timeout_closes_the_log_row_it_opened():
    """Checks that a timeout closes the log row it opened."""
    rows = []

    def post(path, body, timeout):
        raise TimeoutError("timed out")

    with pytest.raises(TransportError):
        KoboldChat(post, on_exchange=lambda b, r: rows.append(r)).complete([], {})
    assert rows == [None, NO_REPLY]


def test_a_timed_out_field_is_retried_and_then_FAILS_without_ending_the_pass():
    """Checks that a timed out field is retried and then fails without ending the pass."""
    calls = []

    class Timeouts:
        def complete(self, messages, sampler):
            calls.append(sampler["max_tokens"])
            if len(calls) <= 3:
                raise TransportError("TimeoutError: timed out")
            return NOCHANGE

    evs = list(runner.run([job("first field."), job("second field.")],
                          instruction=INSTRUCTION, backend=Timeouts(), prompt=prompt,
                          sleep=lambda _s: None))
    results = [e.result for e in evs if e.kind == runner.FIELD_RESULT]
    assert len(calls) == 4, "the retry did not run three attempts on the first field"
    assert results[0].status == "FAILED" and results[0].reason.startswith("transport")
    assert results[1].status == "NOCHANGE", "the pass abandoned the field after the timeout"
