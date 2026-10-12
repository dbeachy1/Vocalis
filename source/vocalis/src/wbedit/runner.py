"""The pass loop — 6.4-m1c.

One instruction, applied to one field at a time, emitting an event per step. It does **no I/O of
its own** (design §7): the model arrives as a `Backend`, the prompt as a callable, the clock and
the sleep as arguments. Everything it learns, it says in an event; everything it needs, it is
handed. That is what lets the report, the SSE stream, the store and a test all be subscribers to
the same run rather than four copies of the loop.

🔴 **I12 — SERIAL, ONE REQUEST AT A TIME.** `run()` is a generator, so this is structural rather
than a promise: there is exactly one in-flight request per iteration and a consumer that stops
consuming stops the pass. One model is loaded; parallelism buys nothing here and would turn the
event stream into something that needs ordering.

🔴 **I16 — TWO CHANNELS, AND ONLY ONE OF THEM CARRIES BODIES.** `Event.result` holds the original
and revised field text because the report and the review queue exist to show exactly that.
`Event.public()` is the everything-else channel — SSE frames, log lines, error payloads — and it
is metadata only. The split lives HERE, on the event, rather than in each consumer, because a
consumer that forgets is a silent leak and there will be more consumers than this module.

🔴 **I7 — `applied` ON AN EVENT IS AN ASSESSMENT, NOT AN ACTION.** The runner never writes a
document. A flagged edit reports `applied=False` and its original survives; whether an unflagged
one reaches a Revision is still the store's call. Nothing here applies anything.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable, Iterator

from .backends.base import Backend, TransportError, profile as default_profile
from .core import contract
from .core.job import Job, Result
from .core.validate import validate

#: Reasons that may cross into a public frame verbatim: they are a closed vocabulary defined by
#: our own output contract, so none of them can contain a fragment of a document.
#:
#: 🔴 EVERYTHING ELSE IS COLLAPSED, and the one thing that produces "everything else" is a
#: transport failure, whose text is an exception message from a backend. `TransportError`'s
#: docstring forbids putting the payload in there — but a forbidden thing is not an impossible
#: thing, and I16 is not the invariant to enforce by asking nicely.
PUBLIC_REASONS = frozenset(contract.NO_FIELD_REASONS) | {"multiple blocks", "unparseable"}

#: The opening sentinel, handed to the model as the start of its own turn — ON A RETRY ONLY.
#:
#: 🔴 **Retry-only.** Always prefilling the opening sentinel can force an edit block when the
#: correct response is `<<<NOCHANGE>>>`; prefilling only `<<<` also harms valid edits. The retry
#: path runs only after a reply could not be parsed, which separates that recovery from a valid
#: decline.
#:
#: A retry is reached only when `contract.extract` could not read the reply. A valid
#: `<<<NOCHANGE>>>` does not retry or get overridden. The prefill therefore helps malformed
#: replies without forcing edits on fields the model should leave unchanged.
_PREFILL = contract.BEGIN + "\n"

#: A reply has to contain the WHOLE field, so the ceiling cannot be a constant.
#:
#: 🔴 4096 tokens is roughly 14 KB of prose, so any field larger than that could never round-trip
#: — the generation would hit the ceiling mid-field every single time, and `validate`'s
#: terminal-punctuation flag was the only hint. Card descriptions and long lorebook entries reach
#: that size.
#:
#: ⚠️ **THE FLOOR IS THE PROFILE'S OWN VALUE, DELIBERATELY.** §9a.13b warned that raising the
#: ceiling to fix a reasoning loop just buys a longer loop, and the measurements bore that out —
#: the one baseline run that hit `length` did so on a 1.4 KB field whose correct answer was ~400
#: tokens. So a short field keeps exactly the budget it has today and a runaway costs no more
#: than it does now; only a genuinely large field gets more.
_REPLY_CEILING = 20480
_CHARS_PER_TOKEN = 3.0
_REPLY_HEADROOM = 1.6


def _reply_budget(original: str, floor: int) -> int:
    """Tokens to allow for a reply that must carry `original` back, plus sentinels and notes."""
    need = int(len(original) / _CHARS_PER_TOKEN * _REPLY_HEADROOM) + 512
    return max(int(floor or 0), min(_REPLY_CEILING, need))


PASS_START = "pass.start"
FIELD_START = "field.start"
FIELD_RESULT = "field.result"
PASS_FINISH = "pass.finish"


def _public_reason(reason: str) -> str:
    if not reason:
        return ""
    if reason in PUBLIC_REASONS:
        return reason
    return "transport" if reason.startswith("transport") else "error"


@dataclass(frozen=True)
class Event:
    """One step of a pass.

    `result` is the only field that can hold document text, and `public()` is the only method
    that is safe to serialize anywhere other than the report or the review queue.
    """

    kind: str
    seq: int
    index: int = 0                    # 1-based field number within the pass
    total: int = 0
    rel: str = ""
    label: str = ""
    result: Result | None = None      # FIELD_RESULT only — HOLDS BODIES
    applied: bool = False             # FIELD_RESULT — would this qualify to reach a Revision
    tally: dict[str, int] = dc_field(default_factory=dict)   # PASS_FINISH

    def public(self) -> dict[str, Any]:
        """The I16-safe view: names, counts, timings, flags. Never a body, never a note.

        Labels and document names DO travel — I16 draws the line at bodies, and a progress line
        that cannot say which entry it is on is not a progress line. `notes` does not travel: it
        is the model's prose about the edit, written in the same breath as the field, and it has
        quoted the field before.
        """
        d: dict[str, Any] = {"kind": self.kind, "seq": self.seq}
        if self.total:
            d["total"] = self.total
        if self.index:
            d["index"] = self.index
        if self.rel:
            d["rel"] = self.rel
        if self.label:
            d["label"] = self.label
        if self.kind == FIELD_RESULT and self.result is not None:
            d["status"] = self.result.status
            d["flags"] = list(self.result.flags)
            d["elapsed"] = round(self.result.elapsed, 3)
            d["applied"] = self.applied
            reason = _public_reason(self.result.reason)
            if reason:
                d["reason"] = reason
        if self.kind == PASS_FINISH:
            d["tally"] = dict(self.tally)
        return d


def run(
    jobs: list[Job],
    *,
    instruction: str,
    backend: Backend,
    prompt: Callable[[Job, str], list[dict[str, str]]],
    sampler: dict[str, Any] | None = None,
    retries: int = 2,
    assistant_prefill: bool = True,
    min_ratio: float = 0.6,
    max_ratio: float = 1.75,
    accept_flagged: bool = False,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Iterator[Event]:
    """Run one instruction over `jobs`, yielding an `Event` per step.

    `prompt(job, instruction)` returns the whole message list. Assembling it — system prompt,
    few-shot pairs, the FIELD/INSTRUCTION block — belongs to `prompt/`, and injecting it keeps
    this loop testable without a card on disk.

    🔴 **I10 — the instruction is byte-frozen for the whole pass.** It is passed through to every
    call as the same object and this function never rewrites it. That is what makes 110
    independent edits one coherent pass, and it is also what keeps KoboldCpp's prefix cache warm
    so only the field itself is processed fresh. Amending it means a new pass; a UI that edits it
    mid-run has broken both properties at once.
    """
    base_sampler = dict(sampler) if sampler is not None else default_profile()
    seq = 0
    total = len(jobs)
    tally: dict[str, int] = {}
    applied_count = 0

    yield Event(PASS_START, seq, total=total)
    seq += 1

    for index, job in enumerate(jobs, 1):
        yield Event(FIELD_START, seq, index=index, total=total, rel=job.rel, label=job.label)
        seq += 1

        # A per-field copy: retries never change this field's sampler, and nothing leaks to the
        # next field — see backends.base.PROFILE.
        s = dict(base_sampler)
        s["max_tokens"] = _reply_budget(job.original, base_sampler.get("max_tokens", 4096))
        messages = prompt(job, instruction)
        t0 = now()
        res: Result | None = None
        #: Set after an unreadable reply — see `_PREFILL`. Never true on the first attempt.
        prefill = False

        for attempt in range(retries + 1):
            turns = messages + [{"role": "assistant", "content": _PREFILL}] if prefill else messages
            try:
                raw = backend.complete(turns, s)
            except TransportError as exc:
                if attempt == retries:
                    res = Result(job, "FAILED", reason=f"transport: {exc}")
                    break
                sleep(1.5 * (attempt + 1))
                continue

            # The model continues our turn, so the sentinel we supplied is part of the reply the
            # contract has to read — it just was not generated.
            #
            # ⚠️ **UNLESS IT WROTE ITS OWN.** Not every server continues a trailing assistant
            # turn, and a model handed `<<<BEGIN` sometimes restates it anyway. Prepending
            # blindly would then produce two opening sentinels, which `extract` reports as
            # `"multiple blocks"` — a flag that holds the row back for review. The retry would
            # be creating the very problem it was sent to fix.
            if prefill and contract.BEGIN not in raw:
                raw = _PREFILL + raw

            body, notes, reason = contract.extract(raw)

            if reason == "nochange":
                # NOCHANGE path 1 of 2 (I6): the model's own sentinel.
                res = Result(job, "NOCHANGE")
                break

            if body is None:
                if attempt < retries:
                    # 🔴 Prefill the opening sentinel and leave the sampler unchanged. Unreadable
                    # replies can contain complete fields with malformed wrapping; changing the
                    # temperature does not fix that contract error and can truncate otherwise
                    # usable output.
                    #
                    # ⚠️ Nothing in the sampler moves on a retry. The four I2 values
                    # were never ours to touch; `temperature` turns out not to have been either.
                    # Kobold and compatible local backends accept a trailing assistant turn.
                    # Some hosted models reject it as HTTP 400, so those engines retry the normal
                    # conversation and still continue through the remaining fields.
                    prefill = assistant_prefill
                    continue

                # 🔴 **After retries are spent, recover a plausible field for review.** A reply
                # that broke the wrapper can still contain the complete field.
                #
                # ⚠️ Salvage never bypasses a check. The recovered body falls through to the
                # byte-identity test and the full validator set below exactly as a well-formed
                # one does, and it arrives carrying a flag — so it is HELD FOR REVIEW and never
                # silently applied. I7 is intact: nothing here repairs the model's text, it only
                # decides where the field ended.
                body, notes, how = contract.salvage(raw, job.original, opener_supplied=prefill)
                if body is None:
                    res = Result(job, "FAILED", reason=reason or "unparseable")
                    break
                reason = f"salvaged: {how}"

            if body == job.original:
                # NOCHANGE path 2 of 2 (I6): byte identity on what came back. BOTH paths stay —
                # the model's own assessment that it changed nothing is not evidence that it did
                # not, and this one is evidence.
                res = Result(job, "NOCHANGE", notes=notes)
                break

            flags = validate(job.original, body, min_ratio, max_ratio)
            if reason:
                # "multiple blocks" — a body AND a reason. It becomes a flag so the result is
                # held back for review rather than quietly applying the first of two answers.
                flags.append(reason)
            res = Result(job, "CHANGED", revised=body, notes=notes, flags=flags)
            break

        assert res is not None, "the attempt loop must produce a Result on every path"
        res.elapsed = now() - t0

        applied = (res.status == "CHANGED" and res.revised is not None
                   and (not res.flags or accept_flagged))
        tally[res.status] = tally.get(res.status, 0) + 1
        if applied:
            applied_count += 1

        yield Event(FIELD_RESULT, seq, index=index, total=total, rel=job.rel, label=job.label,
                    result=res, applied=applied)
        seq += 1

    final = dict(tally)
    final["applied"] = applied_count
    final["held"] = tally.get("CHANGED", 0) - applied_count
    yield Event(PASS_FINISH, seq, total=total, tally=final)
