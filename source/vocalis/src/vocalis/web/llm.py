"""`/llm/holding` reports whether a local LLM currently holds GPU memory. The device-enable warning is checked at the setting change, so callers do not need to repeat it before every feature action. Probes are engine-agnostic and gated by local configuration. Sleeping llama.cpp models do not count as holding memory. Probe failures return an empty holding list so this advisory route cannot block the action."""
from flask import Blueprint, jsonify

import kobold
import llama
from loguru import logger

from vault import VaultLocked

from vocalis.runtime import gpu
from vocalis.web import kobold as web_kobold
from vocalis.web import llama as web_llama

# Every way ASKING can legitimately fail: the engine is down, refusing, or the settings that name
# it are unreadable. NAMED, never a blind `except Exception` — a probe that raises AttributeError
# is a BUG in this file, and swallowing it would report "nothing is holding the cards" forever
# while the warning silently stopped existing. The ratchet in test_m5_boundaries.py is about
# exactly that failure mode, and the answer is to name them, not to raise the ceiling.
_ASK_FAILED = (llama.LlamaUnreachable, llama.LlamaAuthFailed,
               kobold.KoboldUnreachable, kobold.KoboldAuthFailed,
               VaultLocked, OSError, ValueError, KeyError, TypeError)


def _llama_holding():
    """[{engine, model}] for every llama.cpp model actually holding VRAM on this box."""
    cfg = web_llama._llama_cfg()
    if not llama.configured(cfg) or not cfg.local:
        return []
    return [{"engine": "llama.cpp", "model": r["id"]}
            for r in llama.list_models(cfg) if r.get("holds_vram")]


def _kobold_holding():
    """[{engine, model}] for KoboldCpp, which holds at most one.

    `kobold.status()`'s `loaded` is already the VRAM question for this engine — KoboldCpp has no
    sleeping state and no multi-model mode, so there is nothing here to widen or narrow.
    """
    cfg = web_kobold._kobold_cfg()
    if not cfg.local:
        return []
    st = kobold.status(cfg)
    if not st.get("loaded"):
        return []
    return [{"engine": "KoboldCpp", "model": st.get("model") or ""}]


# Order is display order in the dialog and nothing else depends on it. A third engine is a fourth
# line here plus its own `_x_holding()` — no other file changes, which is the point of the shape.
_PROBES = (_llama_holding, _kobold_holding)


def create_llm_blueprint() -> Blueprint:
    bp = Blueprint("vocalis_llm", __name__)

    @bp.route("/llm/holding")
    def llm_holding():
        """What is on this box's cards, across every engine. Never fails.

        🔴 EACH PROBE IS ISOLATED. One engine being down, unconfigured or misconfigured must not
        hide what the OTHER one is holding — a single try/except around the loop would turn a
        KoboldCpp timeout into "llama.cpp is holding nothing", which is a wrong answer rather than
        a missing one, and the whole warning would silently stop existing.
        """
        holding = []
        for probe in _PROBES:
            try:
                holding.extend(probe())
            except _ASK_FAILED:
                # Logged, never raised: the caller is a checkbox and the answer is advisory, so a
                # warning that can break the action it decorates is worse than one that is absent.
                logger.opt(exception=True).debug(f"{probe.__name__} could not be asked")
        # 🔴 NO VRAM FIGURE WHEN THERE IS NOTHING TO MEASURE. `gpu.other_vram_gb()` answers a
        # plausible 0.0 rather than erroring when it cannot see the cards, so reporting it
        # unconditionally would let "0.0 GB" mean both "nothing loaded" and "cannot tell".
        body = {"holding": holding}
        if holding:
            body["other_vram_gb"] = round(gpu.other_vram_gb(), 2)
        return jsonify(body)

    return bp
