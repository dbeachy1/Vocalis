"""Resolve the worldbook editor's selected engine and its transport once at pass start. The badge and pass start read the same selection; the worker keeps the resolved engine so recorded model and transport cannot drift. KoboldCpp remains the default when no engine is selected. The badge's KoboldCpp path keeps its non-failing status response and must stay aligned with resolution behavior."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import kobold
import llama
import llmapi
from loguru import logger

from wbedit.backends.base import BackendRefused, TransportError, profile
from wbedit.backends import profiles

from vocalis.runtime import settings

# 🔴 THE MODULES, NOT THE FUNCTIONS — the rule `web/wbedit.py` states for `_kobold_cfg`. Each of
# these is a network or secrets boundary that tests stub wholesale; binding the function objects
# here would capture the real ones at import and every stub would miss this module.
import vocalis.web.kobold as _web_kobold
import vocalis.web.llama as _web_llama
import vocalis.web.llmapi as _web_llmapi

#: In the order the drop-down lists them — the LLM tab's sub-tab order, then the API providers.
ENGINES = ("llama", "kobold", "openrouter", "featherless")
LABELS = {"llama": "llama.cpp", "kobold": "KoboldCpp",
          "openrouter": "OpenRouter", "featherless": "Featherless"}
HOSTED = ("openrouter", "featherless")

#: What an unset or unrecognised `wbedit_engine` means: today's behavior, so nothing moves until
# The user selects another engine explicitly; an unset or invalid value falls back here and is logged.
DEFAULT = "kobold"

#: The per-request ceiling. KoboldCpp's 900 s is 7.0's number and is kept exactly. llama.cpp gets
#: the same: it is the same kind of box running the same kind of model. The hosted providers get
#: 300 s — a request that has not answered in five minutes from a datacenter is not coming back,
#: and the runner's retry is the better bet.
TIMEOUTS = {"kobold": 900.0, "llama": 900.0, "openrouter": 300.0, "featherless": 300.0}


class EngineUnavailable(Exception):
    """The selected engine cannot run a pass now. The message is shown as the engine badge warning and in the pass-start 503 response."""


@dataclass
class Engine:
    """Everything a pass needs from its engine, resolved ONCE at pass start."""
    id: str
    label: str
    model: str
    post: Callable[[str, Any, float], Any]
    sampler: dict
    timeout: float
    #: What `/wbedit/model` merges into its body — KoboldCpp's full `status()` answer, as before.
    status: dict


def chosen(app_settings: dict | None = None) -> str:
    """The engine id stored in app_settings.yaml, or `DEFAULT`."""
    s = settings.load_app_settings() if app_settings is None else app_settings
    v = str((s or {}).get("wbedit_engine") or "").strip().lower()
    if v and v not in ENGINES:
        logger.warning(f"llm_engine: unknown wbedit_engine {v!r} in app_settings.yaml — "
                       f"using {DEFAULT}")
    return v if v in ENGINES else DEFAULT


def kobold_post(cfg):
    """Adapt the Kobold transport to the backend retry contract.

    `KoboldChat.complete` retries `TransportError`, while `kobold._request` raises
    `KoboldUnreachable`. Translate that transport exception here so it is retryable and leave
    unrelated backend errors untouched. Keeping this adapter in the web layer avoids coupling
    `backends/` to server modules. Its module-level placement lets tests exercise the adapter
    production uses.

    Only the exception text is forwarded; it contains the URL and status, not response content
    (I16). `web/wbedit.py` continues to expose `kobold_post` for existing callers.
    """
    def post(path, body, timeout):
        try:
            return kobold._request(cfg, path, body, timeout)
        except kobold.KoboldUnreachable as exc:
            raise TransportError(str(exc)) from exc
    return post


def llama_post(cfg: llama.LlamaConfig, router_model: str = ""):
    """The llama.cpp twin of `kobold_post`, and it exists for the same reason: `llama._request`
    raises `LlamaUnreachable`, which is neither of the two types `ChatCompletions` converts, so
    without this a llama.cpp hiccup would skip the runner's retry and fail the whole pass.

    `LlamaAuthFailed` is the one that must NOT retry — a wrong key is wrong on every field — so it
    becomes `BackendRefused` and ends the pass with llama.py's own sentence, which names the URL
    and the fix and carries no field text.

    🔴 **`router_model`: THE MODEL IS RE-CHECKED BEFORE EVERY REQUEST, NOT ONLY AT PASS START.**
    `llama_model()` refuses to name an unloaded model when the pass opens, but
    a 110-field pass runs for many minutes. If the model is unloaded meanwhile — from the llama.cpp
    tab to free cards for a render, or by another client — the next request names it, and a router
    with `models_autoload` (its default) puts it back on the cards with no click. So in router
    mode each request first asks `/models` whether the model still holds VRAM (or sleeps, which is
    the router's own idle state for a model that was loaded), and ends the pass if it does not.
    One cheap GET per field, against a request that takes seconds.
    """
    def post(path, body, timeout):
        if router_model:
            try:
                rows = llama.list_models(cfg)
            except llama.LlamaAuthFailed as exc:
                raise BackendRefused(str(exc)) from exc
            except llama.LlamaUnreachable as exc:
                raise TransportError(str(exc)) from exc
            row = next((r for r in rows if r.get("id") == router_model), None)
            if not row or not (row.get("holds_vram") or row.get("status") == llama.STATUS_SLEEPING):
                logger.warning(f"llm_engine: {router_model!r} is no longer loaded on llama.cpp — "
                               f"ending the pass rather than let the router autoload it")
                raise BackendRefused(
                    f"The llama.cpp model {router_model!r} was unloaded during the pass. Load it "
                    f"again on LLM ▸ llama.cpp and run the remaining fields.")
        try:
            return llama._request(cfg, path, body, timeout)
        except llama.LlamaAuthFailed as exc:
            raise BackendRefused(str(exc)) from exc
        except llama.LlamaUnreachable as exc:
            raise TransportError(str(exc)) from exc
    return post


def llama_model(st: dict) -> str:
    """Return the model a pass will use from `llama.status()`, or raise `EngineUnavailable` when it cannot be selected safely. Fixed-model mode uses its sole model. Router mode uses the model holding VRAM, or a lone sleeping model that can wake on request. Refuse when none or multiple models make the choice ambiguous."""
    rows = [r for r in (st.get("models") or []) if isinstance(r, dict) and r.get("id")]
    if st.get("mode") != llama.ROUTER_ROLE:
        if not rows:
            raise EngineUnavailable("llama-server lists no model")
        return str(rows[0]["id"])
    held = [r["id"] for r in rows if r.get("holds_vram")]
    if not held:
        held = [r["id"] for r in rows if r.get("status") == llama.STATUS_SLEEPING]
    if not held:
        raise EngineUnavailable("no model is loaded on llama.cpp — load one on LLM ▸ llama.cpp")
    if len(held) > 1:
        raise EngineUnavailable(
            f"llama.cpp holds {len(held)} models ({', '.join(held)}) — unload all but the one "
            f"the editor should use")
    return str(held[0])


def _resolve_kobold() -> Engine:
    # 🔴 THE 7.0 CODE, MOVED — the exception list and both 503 sentences are exactly what
    # `wbedit_pass_start` carried, and the suite pins them there.
    try:
        cfg = _web_kobold._kobold_cfg()
        st = kobold.status(cfg)
        model = st.get("model") or ""
    except (kobold.KoboldUnreachable, OSError, ValueError, KeyError,
            AttributeError, TypeError) as exc:
        raise EngineUnavailable(f"kobold is not reachable: {exc}") from exc
    if not model:
        raise EngineUnavailable("no model is loaded")
    return Engine("kobold", LABELS["kobold"], model, kobold_post(cfg), profile(),
                  TIMEOUTS["kobold"], dict(st))


def _resolve_llama() -> Engine:
    cfg = _web_llama._llama_cfg()
    if not llama.configured(cfg):
        raise EngineUnavailable("llama.cpp has no URL — set it in ⚙ Settings ▸ llama.cpp")
    try:
        st = llama.status(cfg)
    except (llama.LlamaUnreachable, llama.LlamaAuthFailed) as exc:
        raise EngineUnavailable(f"llama.cpp is not reachable: {exc}") from exc
    model = llama_model(st)
    guard = model if st.get("mode") == llama.ROUTER_ROLE else ""   # a -m server cannot autoload
    return Engine("llama", LABELS["llama"], model, llama_post(cfg, guard),
                  profiles.for_engine("llama"),
                  TIMEOUTS["llama"], {"model": model, "mode": st.get("mode")})


def _resolve_hosted(engine: str) -> Engine:
    """No network: the key and the pick are both stored, and a Connect is not a precondition.
    A wrong key surfaces on the first request as `BackendRefused` and ends the pass at once."""
    label = LABELS[engine]
    cfg = _web_llmapi.api_cfg(engine)
    if not cfg.api_key:
        raise EngineUnavailable(f"{label} has no API key — add one on LLM ▸ API")
    model = _web_llmapi.picked_model(engine)
    if not model:
        raise EngineUnavailable(f"no {label} model is picked — choose one on LLM ▸ API")
    return Engine(engine, label, model, llmapi.chat_post(cfg), profiles.for_engine(engine),
                  TIMEOUTS[engine], {"model": model})


def resolve(engine: str | None = None) -> Engine:
    """The engine a pass would run on right now, fully resolved. Raises `EngineUnavailable`."""
    e = engine or chosen()
    if e == "kobold":
        return _resolve_kobold()
    if e == "llama":
        return _resolve_llama()
    return _resolve_hosted(e)


def usable() -> list[dict]:
    """Return engine availability for the drop-down without network probes. A running server is not a prerequisite; only missing configuration makes an option unusable."""
    out = []
    lcfg = _web_llama._llama_cfg()
    for e in ENGINES:
        reason = ""
        if e == "llama" and not llama.configured(lcfg):
            reason = "no URL — ⚙ Settings ▸ llama.cpp"
        elif e in HOSTED:
            if not _web_llmapi.api_cfg(e).api_key:
                reason = "no API key — LLM ▸ API"
            elif not _web_llmapi.picked_model(e):
                reason = "no model picked — LLM ▸ API"
        out.append({"id": e, "label": LABELS[e], "usable": not reason, "reason": reason})
    return out
