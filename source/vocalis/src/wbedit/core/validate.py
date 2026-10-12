"""The flag set — pure functions, no I/O, no dependencies beyond `re`.

Extracted verbatim in behavior from `reference/wbedit-baseline/wb_batch_edit.py` (6.4-m1b).

🔴 VALIDATORS HOLD BACK. THEY NEVER REPAIR (I7). A flag means *look at this*, not *fix this*.
A flagged edit is not applied and the original survives; in 6.4 it goes to the review queue with
its flags attached for review. **Never add auto-correction here.** The whole design exists
because a model that quietly rewrites text is the failure mode — a validator that quietly
rewrites the model's text is the same failure wearing a different hat.

🔴 KEEP THIS MODULE PURE. It is the part most worth unit-testing and the most dangerous place
for a side effect. No logging, no file access, no clock, no config lookup. Everything it needs
arrives as an argument.

Each check below fires on a real observed failure, not a hypothetical:
  * length ratio      — a truncated generation, or a model that "summarized" instead of editing
  * paragraph count   — a reflow that collapses stanzas into prose
  * terminal punct    — a mid-sentence stop, the classic max_tokens cliff
  * macro tokens      — `{{char}}`, `{{user}}`, `<START>` rewritten or DROPPED; these are
                        machinery, and a book that lost one is broken at runtime.
                        🔴 Adding one is NOT a finding — see the note at the check.
  * bracket counts    — `[bracket notes]` are structural in some books
  * protocol leak     — the model echoing our own scaffolding into the field
"""
from __future__ import annotations

import re
from collections import Counter

#: Template machinery that must survive an edit byte-for-byte, in the same multiset.
TOKEN_RE = re.compile(r"\{\{[^}]+\}\}|<START>")

#: Our own scaffolding. A line equal to one of these inside the returned field means the model
#: pasted the prompt back at us.
LEAK_LINES = ("FIELD", "INSTRUCTION", "<<<BEGIN", "END>>>", "<<<NOCHANGE>>>")

#: Prefix of the context block header, matched separately because it carries a trailing phrase.
#: 🔴 A PREFIX, NOT A CONSTANT LINE. Whatever follows it in the model's output is arbitrary text,
#: so a line matched by this must never be echoed into a flag — see the check at the bottom of
#: `validate`; the check below keeps matched text out of the emitted flag.
CONTEXT_LEAK_PREFIX = "CONTEXT (reference only"

#: A macro whose name is a bare identifier is machinery by construction — it cannot hold a
#: sentence — so `{{char}}` may be named outright in a flag. The length bound stops an
#: identifier-shaped blob riding along.
_BARE_MACRO_RE = re.compile(r"\{\{[A-Za-z_][A-Za-z0-9_.-]{0,31}\}\}\Z")

#: `{{setvar::…}}`, `{{getvar::…}}`, `{{random::…}}` — the command is ours to name, the argument
#: is content to preserve.
_PREFIXED_MACRO_RE = re.compile(r"\{\{([A-Za-z_][A-Za-z0-9_.-]{0,31})::")

#: SillyTavern's comment macro. Its entire contents are free text by definition.
_COMMENT_MACRO_RE = re.compile(r"\{\{\s*//")

#: Terminal punctuation. A field that ended on one of these and comes back not ending on one is
#: the signature of a generation that stopped early.
TERMINAL = ".!?]\"'"


def paragraphs(text: str) -> int:
    """Blank-line-separated blocks. Blank means blank-ish — a line of spaces still separates."""
    return len([b for b in re.split(r"\n\s*\n", text.strip()) if b.strip()])


def token_shape(token: str) -> str:
    """Reduce a macro token to something that names the machinery without carrying the payload.

    🔴 THE FLAG LIST TRAVELS FURTHER THAN THE FIELD DOES. `Event.public()` puts `flags` on the SSE
    stream, whose stated invariant is *never a body, never a note* (I16), so anything this function
    returns is on the wire. The span itself is not: `{{// sample plot note}}` and
    `{{setvar::sample value}}` are ordinary lorebook content that happen to be macro-shaped.

    What survives is the part that is machinery — a bare macro name, or a command prefix — because
    that is the part the flag exists to report. `{{char}}` went missing is the finding; *what the
    comment said* never was. The full text is still on the event for the report, and still in the
    review diff, both of which stay inside the vault.
    """
    if token == "<START>":
        return token
    if _BARE_MACRO_RE.match(token):
        return token
    if _COMMENT_MACRO_RE.match(token):
        return "{{//…}}"
    m = _PREFIXED_MACRO_RE.match(token)
    if m:
        return "{{" + m.group(1) + "::…}}"
    return "{{…}}"


def validate(original: str, revised: str, lo: float, hi: float) -> list[str]:
    """Return a list of human-readable flags. Empty means nothing looked wrong.

    `lo`/`hi` bound `len(revised) / len(original)`. They are deliberately wide (0.6–1.75 in the
    baseline): this is a tripwire for a generation that fell over, not a style check. A pass that
    legitimately shortens every entry will trip it, allowing the user to review the pattern and
    accept flagged edits together.
    """
    flags: list[str] = []

    # Empty output is terminal — every check below would be measuring nothing against something.
    if not revised.strip():
        flags.append("empty output")
        return flags

    ratio = len(revised) / max(len(original), 1)
    if ratio < lo or ratio > hi:
        flags.append(f"length ratio {ratio:.2f} outside [{lo}, {hi}]")

    pb, pa = paragraphs(original), paragraphs(revised)
    if pb != pa:
        flags.append(f"paragraph count {pb} -> {pa}")

    # Only meaningful when the original ended cleanly: a field that never ended on punctuation
    # (a list, a fragment, a table row) must not be flagged for still not doing so.
    if original.rstrip()[-1:] in TERMINAL and revised.rstrip()[-1:] not in TERMINAL:
        flags.append("output does not end on terminal punctuation — likely truncated")

    # 🔴 **LOST OR MANGLED, NOT MERELY ADDED — AND THAT DISTINCTION IS THE WHOLE POINT (item 4).**
    #
    # This check ignores added macros. A replacement such as `{{user}}` can be an intentional
    # edit; additions do not break the original runtime contract and remain visible in review.
    #
    # The danger this check exists for is a book that is BROKEN AT RUNTIME, and that comes from a
    # macro going missing or being rewritten — `{{char}}` dropped, `<START>` mangled. A macro the
    # edit ADDED cannot break anything at runtime, it is plainly visible in the review diff, and
    # inserting `{{user}}` is a first-class operation in a character-card editor rather than an
    # accident. So a pure addition is not a finding; anything lost or altered still is.
    #
    # ⚠️ Counted as a MULTISET, so `{{user}}` appearing twice where it appeared three times is
    # still a loss. Using a set here would hide exactly the deletion this is meant to catch.
    before, after = Counter(TOKEN_RE.findall(original)), Counter(TOKEN_RE.findall(revised))
    lost = before - after
    if lost:
        # 🔴 SHAPES AND COUNTS, NEVER THE SPANS (2.2). This line used to interpolate the dropped
        # tokens verbatim, and `Event.public()` puts `flags` on the SSE stream — so a lorebook
        # entry holding `{{// a private plot note}}` published it the moment the model dropped it.
        # `token_shape` keeps the diagnostic (which macro, how many) and drops the payload.
        shapes = Counter(token_shape(t) for t in lost.elements())
        summary = ", ".join(f"{n}×{s}" for s, n in sorted(shapes.items()))
        flags.append(f"macro/template tokens dropped or altered ({sum(shapes.values())}): {summary}")

    if original.count("[") != revised.count("[") or original.count("]") != revised.count("]"):
        flags.append("bracket-note count changed")

    for line in revised.splitlines():
        s = line.strip()
        if s in LEAK_LINES:
            # `s` is bounded here — the condition is equality against our OWN protocol strings, so
            # `s` IS one of `LEAK_LINES` and carries nothing else. That is what makes echoing it
            # safe, and it is the only branch where that argument holds.
            flags.append(f"protocol text leaked into field: {s!r}")
            break
        if s.startswith(CONTEXT_LEAK_PREFIX):
            # 🔴 NEVER `s` IN THIS BRANCH, AND THE OLD CODE DID EXACTLY THAT (2.2, second half).
            # These two conditions used to share one `flags.append(f"...{s!r}")` under a comment
            # claiming `s` was "bounded to our OWN protocol strings by the condition above". True
            # of equality; FALSE of a prefix. `CONTEXT_LEAK_PREFIX` exists precisely because that
            # header "carries a trailing phrase" — so `s` is our scaffolding followed by whatever
            # the model appended, which reached the SSE stream. Report the constant we matched,
            # never the line that matched it.
            flags.append(f"protocol text leaked into field: {CONTEXT_LEAK_PREFIX!r}…")
            break

    return flags
