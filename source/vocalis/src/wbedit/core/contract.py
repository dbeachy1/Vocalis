"""The output contract: what the model is allowed to say back, and how we read it.

Extracted verbatim in behavior from `reference/wbedit-baseline/wb_batch_edit.py` (6.4-m1b).
Pure — no I/O. The identity and containment suites pin the behavior of the baseline this came
from, so any change here that alters output is a bug until proven otherwise.

⚠️ Parsing remains pure and I/O-free. `extract()` uses regular expressions; `salvage()` also uses
stdlib `difflib` to determine whether an out-of-contract reply resembles the field it replaces.

🔴 THE SENTINELS ARE NOT CODE FENCES, AND THAT IS INVARIANT I3. Field values routinely contain
backticks and whole fenced blocks — a worldbook entry describing a config file, a card's example
dialogue quoting one. Any fence-based delimiter eventually collides with the content it is
supposed to delimit, and when it does the parse silently truncates a field mid-sentence. The
same reasoning drives the report's tilde fence, which widens itself against the content.

🔴 `<<<NOCHANGE>>>` EXISTS BECAUSE ECHOING IS THE RISKIEST THING WE CAN ASK FOR (I6). In a batch
pass most entries do not match the instruction. Asking the model to re-emit 600 tokens verbatim
to prove it changed nothing is the single highest-risk operation in the system — it is the exact
shape that rep-pen, DRY and XTC punish, and the damage is a quietly missing clause rather than
an error. There are two independent NOCHANGE paths and BOTH stay: this sentinel, and a
byte-identity check on the returned text done by the caller. The model's own assessment of
whether it changed anything is not evidence.
"""
from __future__ import annotations

import difflib
import re

BEGIN = "<<<BEGIN"
END = "END>>>"
NOCHANGE = "<<<NOCHANGE>>>"

#: Returned as the `reason` when the reply carries no usable field.
NO_FIELD_REASONS = ("nochange", "model refused", "sentinels missing")


#: A reasoning block the model closed by itself, at the very start of its reply.
#:
#: Some model adapters place a reasoning block at the beginning of visible content. Remove a
#: leading block only when it is closed; do not alter tags that occur within field text.
#:
#: ⚠️ Stripped ONLY at the start, and only when it is closed. An unterminated `<think>` means
#: the whole reply is reasoning and there is nothing to recover; a `<think>` in the middle of a
#: field is the field's own text and removing it would be an edit.
_THINK_RE = re.compile(r"\A\s*<think>.*?</think>\s*", re.DOTALL)


def without_think(raw: str) -> str:
    """`raw` with a leading closed `<think>…</think>` removed, stripped.

    Contract parsing must use this normalized text. A reasoning preamble would otherwise hide a
    leading `<<<NOCHANGE>>>` sentinel or be mistaken for field content during salvage.
    """
    return _THINK_RE.sub("", raw, count=1).strip()


def extract(raw: str) -> tuple[str | None, str, str]:
    """Parse one model reply into `(field_or_None, notes, reason)`.

    `field is None` means there is no usable output and the caller must retry or fail — it never
    means "the empty string". An empty field that survived the sentinels is a real (and flagged)
    result, which is a different thing from a reply we could not read.

    `notes` is the model's own post-sentinel change list, which is why I5 requires commentary to
    come AFTER the closing sentinel: anything inside gets pasted into SillyTavern.

    `reason` is non-empty for both failures and survivable oddities — `"multiple blocks"` returns
    a body AND a reason, because the first block is usually right and the caller should apply it
    only after a human has looked.
    """
    text = without_think(raw)
    if text.startswith(NOCHANGE) or text == NOCHANGE:
        return None, "", "nochange"

    i = text.find(BEGIN)
    j = text.find(END, i + 1) if i != -1 else -1

    # A complete delimited field is authoritative. Refusal phrases are checked only when there is
    # no block, because valid field text may contain those phrases.
    #
    # A well-formed block is the model doing exactly what was asked; nothing said around it
    # outranks that. The refusal checks now run only when there is no block to read.
    if i == -1 or j == -1:
        # The card's own refusals, which are part of the contract rather than failures: given
        # JSON it answers "JSON - paste the field value instead." and stops, which is I1
        # enforced from the model's side.
        if "Outside scope." in text or text.startswith("JSON -"):
            return None, "", "model refused"
        return None, "", "sentinels missing"

    body = text[i + len(BEGIN):j]
    # One newline of padding on each side is the model formatting its own block, not content.
    # Strip exactly one — a field that legitimately starts or ends with a blank line keeps it.
    if body.startswith("\n"):
        body = body[1:]
    if body.endswith("\n"):
        body = body[:-1]

    notes = text[j + len(END):].strip()

    # A second opening sentinel means the model emitted more than one candidate. Return the
    # first — it is usually the intended one — but say so, so a validator holds it back rather
    # than applying half an answer.
    if text.find(BEGIN, i + 1) != -1:
        return body, notes, "multiple blocks"
    return body, notes, ""


# --------------------------------------------------------------------------- salvage
#
# Salvage handles a reply that contains a plausible field but omits the delimiters. It never edits
# or repairs the reply; it locates a candidate field and returns a reason for review.
#
# 🔴 **SALVAGE IS RECOVERY, NEVER REPAIR — I7 STILL HOLDS.** Nothing here rewrites, reflows or
# corrects a single character of what the model said. It only decides WHERE the field stops and
# the commentary starts, and it hands the caller a reason so the result is flagged and held for
# review rather than applied. The runner asks for it only after every retry is spent; a reply
# that parses normally never reaches this code.

#: Markdown decoration a heading may be wearing. Stripped before the heading is matched so
#: `**Changes Made:**`, `### Changes`, and `Changes:` are all the same line.
_DECOR = " \t#*_>-—–:"

#: 🔴 **A CLOSED VOCABULARY, AND IT MUST STAY CLOSED.** These are the headings a model writes
#: when it stops emitting the field and starts describing its own edit. Widening this to
#: something like "any bold line" would let a heading that is genuinely PART of a card's
#: description truncate the field at that point — silently, and in the direction of data loss.
#: Every entry here is a phrase no lorebook entry would use as a standalone line.
_NOTE_HEADINGS = frozenset({
    "changes", "changes made", "change list", "changelog", "list of changes",
    "what changed", "what i changed", "what was changed", "changes summary",
    "summary", "summary of changes", "edits", "edits made", "notes on changes",
})

#: A salvaged body must still look like the field it came from. Below this share of the
#: original's length, the split is more likely to have cut the field in half than to have found
#: the commentary, so the whole reply is kept instead and the length flag can do its job.
#:
#: 🔴 IT IS ALSO THE PLAUSIBILITY FLOOR FOR A REPLY WITH NO SENTINEL AT ALL, AND THAT SECOND USE
#: IS THE LOAD-BEARING ONE. `test_an_unreadable_reply_retries_then_fails_with_the_contracts_own
#: _reason` drives the backend with `"I'm afraid I can't do that."` — 28 characters against a
#: 1.4 KB field. Without this floor, salvage called that a recovered field and turned a correct
#: FAILED into a CHANGED, destroying the very signal the row exists to carry. A refusal, an
#: apology and a stray error string are all short; a field is not.
#:
#: ⚠️ The floor applies ONLY where no sentinel was found. When the model wrote `<<<BEGIN` it has
#: declared that a field follows, and a short body after it is a genuine truncation worth
#: recovering — `validate`'s terminal-punctuation and length checks are what flag it. Absent
#: that declaration we are inferring, and an inference needs corroboration.
_MIN_SPLIT_SHARE = 0.5


#: How much of the original a sentinel-less reply must still look like, before we are willing to
#: call it a recovered field.
#:
#: 🔴 **THIS IS THE GUARD THAT KEEPS A REFUSAL FROM BECOMING AN EDIT, AND A LENGTH FLOOR CANNOT
#: DO IT.** `test_an_unreadable_reply_retries_then_fails_with_the_contracts_own_reason` edits a
#: ONE-CHARACTER field and gets back `"I'm afraid I can't do that."` — longer than the original,
#: so every size-based test passes it. What actually separates the two is that this job is
#: surgical: *"change only what the instruction asks for; every other character comes through
#: byte-identical"*. A real edit therefore shares most of its text with the field it replaces,
#: and an apology shares almost none.
#:
#: ⚠️ Set deliberately low. A reply that rewrites heavily is still a plausible edit and gets
#: through to be flagged by `validate`; the only thing this must catch is prose that is ABOUT
#: the request rather than an answer to it. Raising it would start binning real work, which is
#: the failure this whole rule exists to end.
_MIN_RESEMBLANCE = 0.4


def _resembles(original: str, reply: str) -> bool:
    """Does `reply` look like an edit OF `original`, rather than prose about it?

    `quick_ratio` compares character multisets — it is an upper bound on the real ratio and is
    cheap on the kilobyte-scale strings this sees. An upper bound is the right choice: it lets a
    borderline reply through to the validators, which is where a human is meant to judge it.
    """
    if not original.strip():
        return False
    return difflib.SequenceMatcher(None, original, reply).quick_ratio() >= _MIN_RESEMBLANCE


def _strip_heading(line: str) -> str:
    return line.strip().strip(_DECOR).strip().lower()


def _split_commentary(text: str, original: str) -> tuple[str, str]:
    """`(field, notes)` — find where the model stopped editing and started explaining.

    Returns `(text, "")` unchanged when no heading in the closed vocabulary is found, or when
    splitting there would leave a body too short to plausibly be the field.
    """
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if _strip_heading(line) not in _NOTE_HEADINGS:
            continue
        head = "\n".join(lines[:i]).rstrip()
        # ⚠️ A heading on line 0 means the whole reply is commentary — there is no field before
        # it, and returning "" would hand the caller an empty field that reads as a real result.
        if not head.strip():
            continue
        if original and len(head) < _MIN_SPLIT_SHARE * len(original):
            continue
        return head, "\n".join(lines[i:]).strip()
    return text, ""


def salvage(raw: str, original: str = "", *, opener_supplied: bool = False) -> tuple[str | None, str, str]:
    """Best-effort `(field, notes, how)` from a reply that broke the output contract.

    `how` is a short fixed phrase naming the recovery, for a flag. `field is None` means there
    was nothing recoverable and the caller should stand by its FAILED result.

    🔴 `how` AND EVERY STRING THIS RETURNS AS A REASON ARE A CLOSED VOCABULARY (I16). They reach
    the report and the SSE stream, which travel further than field text does. Never interpolate
    any part of `raw` into them.
    """
    # 🔴 THE SAME NORMALIZATION `extract` USES, AND OMITTING IT WAS A REAL BUG. Salvage sees only
    # replies `extract` could not read, so it is the last thing standing between a reasoning
    # preamble and review queue. Without this, `<think>…</think><<<NOCHANGE>>>` fell
    # through to the no-sentinel branch and the model's chain of thought was offered as the
    # proposed new field.
    text = without_think(raw)
    if not text:
        return None, "", ""

    # These are contract outcomes, not breakages — the model declined on purpose, and salvaging
    # one would invent a field where it deliberately declined to write one.
    if text.startswith(NOCHANGE) or "Outside scope." in text or text.startswith("JSON -"):
        return None, "", ""

    i, j = text.find(BEGIN), text.find(END)

    # The block opened and never closed: the classic max_tokens cliff, and everything after the
    # opening sentinel is field. `validate`'s terminal-punctuation check is what tells the user it
    # stopped mid-sentence, so nothing is trimmed here.
    if i != -1 and j == -1:
        body = text[i + len(BEGIN):]
        if body.startswith("\n"):
            body = body[1:]
        # 🔴 **WHOSE SENTINEL IS IT?** This branch trusts the opener without a resemblance check,
        # because the model writing `<<<BEGIN` is the model declaring that a field follows — and
        # a genuine truncation can be short, so a similarity gate here would bin real data.
        #
        # That justification evaporates when the RUNNER supplied the opener on a reparse retry
        # (`runner._PREFILL`): then nobody has declared anything, and a refusal or an error
        # string inherits a sentinel it never earned. Caught by
        # `test_an_unreadable_reply_retries_then_fails_with_the_contracts_own_reason`, where
        # `"I'm afraid I can't do that."` was promoted to a CHANGED proposal.
        if opener_supplied and original and not _resembles(original, body):
            return None, "", ""
        body, notes = _split_commentary(body, original)
        return (body, notes, "unterminated block") if body.strip() else (None, "", "")

    # The closing sentinel arrived without its opener — rarer, and the mirror image: everything
    # BEFORE the close is field, everything after is the change list.
    if i == -1 and j != -1:
        body = text[:j].rstrip()
        if body.endswith("\n"):
            body = body[:-1]
        notes = text[j + len(END):].strip()
        return (body, notes, "opening sentinel missing") if body.strip() else (None, "", "")

    # Neither sentinel — THE MEASURED CASE. The model answered the question and ignored the
    # wrapper entirely, so the reply is the field followed (usually) by a change list.
    if i == -1 and j == -1:
        # Nothing here declares a field, so the reply must look like one on its own merits.
        if original and not _resembles(original, text):
            return None, "", ""
        body, notes = _split_commentary(text, original)
        return (body, notes, "no sentinels") if body.strip() else (None, "", "")

    return None, "", ""
