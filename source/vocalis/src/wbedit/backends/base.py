"""The backend seam, and the sampler block every backend must send.

A backend is one method: turn messages into the model's reply text. Everything else — retries,
validation, what a flag means — is the runner's, so a new backend cannot accidentally acquire a
policy.
"""
from __future__ import annotations

from typing import Any, Protocol


class TransportError(RuntimeError):
    """The model could not be reached, or answered something that was not a completion.

    🔴 ITS MESSAGE REACHES A REPORT AND MUST NEVER CARRY FIELD TEXT (I16). A backend that puts
    the request body into the exception — which is a natural thing to do when debugging a 400 —
    would put a worldbook entry into an error string, and error strings travel further than
    fields do. Raise it with a status code, a URL, an errno; never with `payload`.

    The runner defends the SSE side of this on its own (`Event.public()` collapses any
    non-contract reason to the bare word "transport"), but the report prints the reason verbatim,
    so the contract still has to hold here.
    """


class BackendRefused(RuntimeError):
    """The model service answered, and the answer means NO RETRY CAN HELP (11.1).

    A rejected API key (401/403), an account out of credit (402), a model id the provider does
    not know (404), a request it will not accept (400). Before 11.1 every backend was a local
    server that either answered or did not, so `TransportError` — retry three times, then FAIL the
    field — was the only failure there was. A hosted provider refusing the key would have spent
    three retries on EVERY field of a 110-field pass, each one a round trip to be told the same
    thing, and then reported 110 transport failures instead of the one fact that matters.

    🔴 **DELIBERATELY NOT A `TransportError` SUBCLASS.** The runner catches `TransportError` to
    retry; this must sail past that handler and end the pass, which is what `_run_pass`'s handler
    does with anything else. Its message is shown as the pass's failure reason.

    🔴 **ITS MESSAGE IS COMPOSED BY US, NEVER QUOTED FROM THE PROVIDER (I16).** A provider's error
    body is not ours to trust: a moderation refusal can carry the flagged input, and the flagged
    input is the field. The message names the provider, the status and what it means, and nothing
    that came over the wire beyond the status code.
    """


#: KoboldCpp sampler profile. Send repetition controls explicitly: its default `rep_pen` is 1.1,
#: which would alter mostly verbatim field edits. Provider parameter names are not interchangeable;
#: other engines use separate blocks in `backends/profiles.py`.
PROFILE: dict[str, Any] = {
    "temperature": 0.2,
    "top_k": 0,
    "top_p": 1,
    "typical": 1,
    "min_p": 0.05,
    "top_a": 0,
    "tfs": 1,
    "nsigma": 0,
    "max_tokens": 4096,
    "rep_pen": 1.0,
    "rep_pen_range": 0,
    "rep_pen_slope": 0,
    "presence_penalty": 0,
    "frequency_penalty": 0,
    "smoothing_factor": 0,
    "smoothing_curve": 1,
    "xtc_threshold": 0.1,
    "xtc_probability": 0,
    "dry_multiplier": 0,
    "stream": False,
    # KoboldCpp's built-in AutoGuess template can open an unclosed reasoning block for GLM-style
    # models. `reasoning_effort: "none"` prevents that local adapter behavior. Do not replace the
    # adapter to address this; custom template options are ignored unless Jinja mode is enabled.
    # Other backends ignore this unknown key, so it does not affect their requests.
    "reasoning_effort": "none",
}


def profile() -> dict[str, Any]:
    """A fresh copy of `PROFILE`.

    The runner halves `temperature` on a reparse retry, so it needs something it may write to.
    Handing out the module-level dict would let one retry lower the temperature for the whole
    rest of the pass — and for every later pass in the same process.
    """
    return dict(PROFILE)


class Backend(Protocol):
    """One call, one reply.

    Raises `TransportError` for anything the runner should retry. Everything else propagates:
    a bug in prompt assembly is not a flaky network and must not be papered over by three
    attempts and a FAILED row.
    """

    def complete(self, messages: list[dict[str, str]], sampler: dict[str, Any]) -> str:
        ...
