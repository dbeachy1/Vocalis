"""Engine-specific sampler blocks for llama.cpp, OpenRouter, and Featherless.

KoboldCpp's separate block lives in `base.PROFILE`. Each provider receives only its own parameter
names because servers may ignore unknown keys. Repetition controls remain disabled for mostly
verbatim edits. The other providers leave reasoning behavior to their own defaults; KoboldCpp's
explicit `reasoning_effort` setting addresses its local chat-template behavior.
"""
from __future__ import annotations

from typing import Any

from .base import PROFILE as KOBOLD

#: llama.cpp `llama-server` parameter names and defaults.
#:
#: ⚠️ `repeat_last_n: 0`, NOT llama.cpp's default 64. The default penalty is already 1.0 (off), so
#: the window does nothing today; it is sent anyway so the block states the whole intent rather
#: than leaning on a default that another build may not share.
#: ⚠️ `top_n_sigma`, `tfs`, `top_a` and KoboldCpp's smoothing keys are ABSENT on purpose: llama.cpp
#: has no equivalent for the last three, and its `top_n_sigma` default (-1) is already off.
LLAMA: dict[str, Any] = {
    "temperature": 0.2,
    "top_k": 0,
    "top_p": 1,
    "typical_p": 1,
    "min_p": 0.05,
    "max_tokens": 4096,
    "repeat_penalty": 1.0,
    "repeat_last_n": 0,
    "presence_penalty": 0,
    "frequency_penalty": 0,
    "xtc_threshold": 0.1,
    "xtc_probability": 0,
    "dry_multiplier": 0,
    "stream": False,
}

#: OpenRouter parameter names and documented defaults.
#:
#: ⚠️ **OPENROUTER DROPS A PARAMETER THE ROUTED PROVIDER DOES NOT SUPPORT**, unless the request
#: sets `provider.require_parameters`. We do NOT set it: every penalty here is also its default,
#: so a dropped one changes nothing, and requiring them would exclude providers for no gain.
#: `min_p` is the one value that differs from a default and may be dropped by some providers —
#: the chosen model's `supported_parameters` is recorded on the API tab so that is visible.
OPENROUTER: dict[str, Any] = {
    "temperature": 0.2,
    "top_k": 0,
    "top_p": 1,
    "min_p": 0.05,
    "top_a": 0,
    "max_tokens": 4096,
    "repetition_penalty": 1.0,
    "presence_penalty": 0,
    "frequency_penalty": 0,
    "stream": False,
}

#: Featherless sampler parameters include `temperature`, `top_p`,
#: `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty`, `seed`,
#: `stop`.
#:
#: 🔴 **`top_k` IS ABSENT, NOT 0.** Featherless serves through a vLLM-style engine, where the
#: "off" value has been -1 and some versions REJECT 0 with a 400. Its default is off, so the only
#: safe way to say "off" to an engine whose spelling of off we have not measured is to not say
#: anything. Every other key here either matches its documented range or is its default.
FEATHERLESS: dict[str, Any] = {
    "temperature": 0.2,
    "top_p": 1,
    "min_p": 0.05,
    "max_tokens": 4096,
    "repetition_penalty": 1.0,
    "presence_penalty": 0,
    "frequency_penalty": 0,
    "stream": False,
}

#: Engine id → its block. The ids are the ones `wbedit_engine` stores in app_settings.yaml.
BY_ENGINE: dict[str, dict[str, Any]] = {
    "kobold": KOBOLD,
    "llama": LLAMA,
    "openrouter": OPENROUTER,
    "featherless": FEATHERLESS,
}


def for_engine(engine: str) -> dict[str, Any]:
    """A fresh copy of `engine`'s block — the runner writes `max_tokens` into its copy per field,
    and handing out the module-level dict would let that leak into every later pass (the same
    reason `base.profile()` copies). Raises KeyError on an unknown engine: a typo here is a bug
    in the caller, and falling back to KoboldCpp's keys would be exactly the silent-inert block
    this module exists to prevent."""
    return dict(BY_ENGINE[engine])
