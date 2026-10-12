"""Build the one user message a field gets, and the message list around it.

🔴 **I11 — NO PER-ENTRY CONTEXT AND NO NEIGHBORING ENTRIES.** The context block below is
metadata *about* the field — its section, its label, its keys, whether it is always in context —
and never the text of another entry. Neighboring prose is exactly what the model blends in by
accident, and varying context invalidates KoboldCpp's prefix cache on every call, so it costs
~1,300 tokens of re-prefill per field to make the output worse.

🔴 **I10 — everything before `FIELD` is byte-identical across a pass except the context block**,
and the instruction itself never varies. Shared reference material — name tables, canonical
characterization, tone exemplars — belongs *in the instruction*, which is where §6.4's one
earned finding lives: naming a subject's oblique forms ("the firm", "the office", "the practice")
took a field from 0/5 updated to 5/5. That is a property of the instruction, not of this module,
and it is the reason I10 is worth its cost.
"""
from __future__ import annotations

import re

from ..core.contract import NOCHANGE
from ..core.job import Job


#: Vocalis's instructions sent with the user-provided instruction. This wrapper is saved and
#: editable with the prompt settings.
#:
#: 🔴 **`{instruction}` AND `{field}` ARE LOAD-BEARING AND THEIR ABSENCE IS SILENT.** A template
#: without `{field}` sends the model no text to edit, and it will cheerfully answer anyway — every
#: field comes back plausible and wrong. `validate_wrapper` refuses that at the route, because by
#: the time it shows up in the output it looks like a model problem.
DEFAULT_WRAPPER = (
    "INSTRUCTION\n"
    "{instruction}\n\n"
    "If the instruction does not apply to this field at all, emit exactly "
    "{nochange} and nothing else. Do not echo an unchanged field.\n\n"
    "CONTEXT (reference only, never edit or repeat this block)\n"
    "{context}\n\n"
    "FIELD\n"
    "{field}"
)

#: The two whose absence corrupts a pass rather than merely changing it.
REQUIRED_WRAPPER_FIELDS = ("{instruction}", "{field}")

#: Exactly the four tokens, matched whole. Anything else in braces is ordinary text.
_TOKEN_RE = re.compile(r"\{(?:instruction|nochange|context|field)\}")


def validate_wrapper(template: str) -> str:
    """`""` if the template is usable, else why not. Route-facing, so it explains itself."""
    if not isinstance(template, str) or not template.strip():
        return "the template cannot be empty"
    missing = [f for f in REQUIRED_WRAPPER_FIELDS if f not in template]
    if missing:
        return ("the template must contain " + " and ".join(missing)
                + " — without them the model is asked to edit text it was never sent, "
                  "and it will answer anyway")
    # 🔴 NOTHING ELSE IS VALIDATED, BECAUSE NOTHING ELSE IS INTERPRETED. See `user_message`:
    # substitution is a literal token swap, so an unknown `{foo}` and a stray `{` are ordinary
    # characters and reach the model as typed. There is nothing left here that can raise.
    return ""


def context_block(job: Job) -> str:
    """The metadata block — what this field IS, never the text of another field (I11)."""
    ctx = [f"Source: {job.meta['section']}",
           f"You are editing {job.meta.get('kind', 'a text field')}."]
    if job.meta.get("note"):
        ctx.append(job.meta["note"])
    ctx.append(f"Field: {job.label}")
    if job.meta.get("keys"):
        ctx.append("Keys: " + ", ".join(job.meta["keys"]))
    if job.meta.get("constant"):
        ctx.append("This entry is always in context.")
    return "\n".join(ctx)


def user_message(job: Job, instruction: str, template: str = "") -> str:
    """The instruction, the NOCHANGE escape, a metadata context block, then the field.

    🔴 **EVERY JOB GETS ITS LABEL AND KEYS — AN `X` ENTRY INCLUDED.** Withholding them was the old
    sealed path, and it gave the model *less* to work with on exactly the entries whose
    consistency matters most, which is backward. I9.

    `template` is the saved wrapper (§6.4.1); empty means `DEFAULT_WRAPPER`, so every existing
    caller and every test that does not care is unaffected.

    🔴 **A LITERAL TOKEN SWAP, NEVER `str.format()`, AND THAT IS NOT A STYLE CHOICE.** `.format()`
    gives `{{` and `}}` meaning — so a wrapper containing `{{user}}` would silently render as
    `{user}`, and a stray `{` would raise mid-pass. This application is a CHARACTER CARD EDITOR:
    `{{user}}` and `{{char}}` are the likeliest things anyone would ever type into a prompt
    template, and the failure was silent in the worst way (the validator passed it, because the
    validator called `.format()` too). Braces are now ordinary characters everywhere in this file.

    🔴 **ONE PASS, NOT FOUR REPLACES.** Sequential `.replace()` calls would rescan text already
    substituted, so a card whose prose contains the literal string `{field}` would have it
    expanded by a later token's pass. One regex sweep with a lookup cannot re-enter.
    """
    values = {"{instruction}": instruction.strip(), "{nochange}": NOCHANGE,
              "{context}": context_block(job), "{field}": job.original}
    return _TOKEN_RE.sub(lambda m: values[m.group(0)], template or DEFAULT_WRAPPER)


def messages(system: str, shots: list[dict[str, str]], user: str) -> list[dict[str, str]]:
    """System, then the few-shot pairs as alternating turns, then the real request.

    The pairs go in as actual conversation turns rather than being folded into the system prompt:
    that is the shape SillyTavern sends for the same card, and matching it is what keeps the two
    paths from drifting (§7).
    """
    msgs = [{"role": "system", "content": system}]
    for s in shots:
        msgs.append({"role": "user", "content": s["user"]})
        msgs.append({"role": "assistant", "content": s["assistant"]})
    msgs.append({"role": "user", "content": user})
    return msgs


def for_runner(system: str, shots: list[dict[str, str]], template: str = ""):
    """Adapt to the `prompt(job, instruction)` callable `runner.run()` expects.

    The runner takes prompt assembly as an argument precisely so it never needs to know a card
    exists; this is the one-line bridge, kept here so the knowledge stays on this side.
    """
    def build(job: Job, instruction: str) -> list[dict[str, str]]:
        return messages(system, shots, user_message(job, instruction, template))
    return build
