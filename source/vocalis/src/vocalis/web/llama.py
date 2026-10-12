"""Owns `/llama/*` routes for remote llama-server control. It delegates engine behavior to `src/llama.py` and does not read preset files or launch flags. Router and fixed-model modes are both valid; include mode in status rather than treating a fixed-model server as broken. Never echo raw 404 bodies because the HTTP client replaces the server's diagnostic."""
import threading
import time
import urllib.parse

from flask import Blueprint, jsonify, request

import llama
import voice_utils
from loguru import logger
from vault import VaultLocked

from vocalis.runtime import auth
from vocalis.runtime import paths
from vocalis.runtime import pool as rt_pool
from vocalis.runtime import settings


def _llama_secrets() -> dict:
    """The `llama` section of the ROUTED settings file — {} while the vault is locked.

    Deliberately NOT folded into `_llama_cfg`, for the reason `web/kobold.py`'s twin gives: tests
    stub `_llama_cfg` wholesale because it is the network boundary, so anything that reads it to
    answer "is a key stored?" gets a blank config and reports False. The stored-secret question is
    not the talk-to-llama-server question, and they need separate doors.
    """
    if auth.vault_locked():
        return {}
    try:
        return voice_utils.get_section(paths.VOICE_SETTINGS, "llama")
    except (VaultLocked, voice_utils.SettingsUnreadable, OSError):
        # NAMED, not blind (SPEC_5_0_M5 §2): the vault losing its DEK between the check above and
        # this line, a corrupt settings file, and a disk error are the three ways a READ of a
        # stored secret legitimately comes back empty. A ValueError from an unknown section name
        # is a BUG in this call and must not be swallowed into "no key set".
        logger.exception("could not read the llama section of voice_settings.yaml")
        return {}


def _llama_cfg() -> llama.LlamaConfig:
    """The API key comes from the ROUTED settings file, so it is encrypted at rest.

    ⚠️ While the vault is locked `_require_unlocked` 401s every path outside /health, /login,
    /logout and /vault/*, so a locked box answers ALL of these routes with the locked body before
    a view ever runs. Do not write a docstring here claiming reads "keep working" while locked —
    `web/kobold.py`'s did, and it sent a QA run hunting a state that cannot exist.
    """
    return llama.resolve_config(settings.load_app_settings(), _llama_secrets())


def _mode_or_none(cfg: llama.LlamaConfig):
    """('router'|'single'|None, error-or-''). Never raises — the mode is decoration on several
    routes and must not be able to fail one."""
    try:
        return llama.mode(cfg), ""
    except (llama.LlamaUnreachable, llama.LlamaAuthFailed) as exc:
        return None, str(exc)


def _watch_load(cfg: llama.LlamaConfig, name: str, timeout: float = 900.0,
                interval: float = 2.0) -> None:
    """Poll until `name` reports `loaded`, then log it. Runs in a thread; the browser polls
    `/llama/status` meanwhile.

    🔴 **THIS EXISTS BECAUSE `{"success": true}` MEANS STARTED.** `server_models::load()` spawns
    the child and returns; the model appears seconds to minutes later depending on the file. So
    the route answers "loading", never "loaded", and this is what turns the request into an
    observation.

    ⚠️ **NO ETA, AND NO DEFAULT WRITTEN FROM THIS.** 4.7 shipped an indeterminate "loading…" on
    purpose after 4.1's ETA came out 5x wrong, and the 18 s it eventually measured was a
    WARM-CACHE number that must never become a promise. Nothing here has been timed at all yet —
    m0's load half has not been run — so this deliberately records no duration.

    ⚠️ Unlike `_kobold_watch_load`, this does NOT swallow `LlamaUnreachable` as an expected
    mid-swap state. Kobold's listening socket belongs to the model child and drops for ~4.3 s on
    every swap; the router's belongs to the PARENT and should survive. **"Should" is from the
    architecture, not from a measurement** — if m0b shows otherwise, tolerate it here, and do not
    copy Kobold's tolerance in on the assumption it is needed.
    """
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        time.sleep(interval)
        try:
            if llama.is_loaded(cfg, name):
                logger.info(f"llama: {name!r} reported loaded")
                return
        except (llama.LlamaUnreachable, llama.LlamaAuthFailed):
            continue
    logger.warning(f"llama: {name!r} did not report loaded within {timeout:.0f}s")


def _require_router(cfg: llama.LlamaConfig):
    """(mode, error-response-or-None). The gate every write route runs FIRST.

    🔴 **THE MODE IS ESTABLISHED BEFORE THE CALL, NEVER INFERRED FROM ITS FAILURE.** A
    `llama-server -m …` has no `/models/load` route at all, and its 404 is indistinguishable from
    "no such model" because httplib overwrites the body (§2f.1). Asking `/props` first is the only
    way the tab can say WHICH of the two happened — and it lets a single-model server answer with
    a sentence about how to enable model management rather than an error about a missing file.
    """
    if not llama.configured(cfg):
        return None, (jsonify({"error": "llama_unconfigured",
                               "message": "No llama.cpp URL is set — add one in "
                                          "⚙ Settings ▸ llama.cpp."}), 503)
    try:
        mode = llama.mode(cfg)
    except llama.LlamaAuthFailed as exc:
        return None, (jsonify({"error": "llama_auth", "message": str(exc)}), 502)
    except llama.LlamaUnreachable as exc:
        return None, (jsonify({"error": "llama_unreachable", "message": str(exc),
                               "url": cfg.url}), 503)
    if mode != llama.ROUTER_ROLE:
        # 🔴 409, NOT 404 OR 501. It is a CONFLICT between what was asked and how the server was
        # started, and the response explains that router mode is required.
        # A 404 here would be the masked-body problem wearing a Vocalis badge.
        return None, (jsonify({
            "error": "llama_not_router",
            "message": "llama-server was started with a fixed model (-m), so it has no "
                       "model-management API. Start it with no model and a --models-preset "
                       "to load and unload from here."}), 409)
    return mode, None


def create_llama_blueprint() -> Blueprint:
    """Takes nothing, like `create_kobold_blueprint()` since 5.1-P4.18. `_llama_cfg` is the seam
    tests stub; there is no injected secrets function and no raising default to preserve."""
    bp = Blueprint("vocalis_llama", __name__)

    @bp.route("/llama/info")
    def llama_info():
        """Report whether a llama-server is configured, reachable, and in fixed-model or router mode. The response includes the URL tried so the operator can identify a configuration error; an unavailable server is a normal status, not a 500."""
        cfg = _llama_cfg()
        host = urllib.parse.urlparse(cfg.url).hostname or cfg.url if cfg.url else ""
        body = {"configured": llama.configured(cfg), "url": cfg.url, "host": host,
                "local": cfg.local, "api_key_set": bool(cfg.api_key)}
        ok, err = llama.available(cfg)
        body["available"] = ok
        if not ok:
            body["error"] = err
            return jsonify(body)
        mode, err = _mode_or_none(cfg)
        if mode is None:
            # /health answered but /props did not — the honest reading is an auth failure, since
            # /health is public and /props is the first authenticated call (§2c's ladder).
            body["available"] = False
            body["error"] = err
            return jsonify(body)
        body["mode"] = mode
        # Router-only, and READ rather than assumed: these are launch flags Vocalis does not get
        # to set, and a UI that silently assumes max_instances is 1 will be wrong on somebody's
        # box. With autoload on, a model can appear because SillyTavern asked for it (§6a).
        if mode == llama.ROUTER_ROLE:
            try:
                p = llama.props(cfg)
                body["max_instances"] = p.get("max_instances")
                body["models_autoload"] = bool(p.get("models_autoload"))
                body["build_info"] = p.get("build_info")
            except (llama.LlamaUnreachable, llama.LlamaAuthFailed):
                pass                       # decoration; the mode already succeeded
        return jsonify(body)

    @bp.route("/llama/models")
    def llama_models():
        """The model list. Works in BOTH modes — a single-model server lists the one it holds.

        `?reload=1` is NOT accepted here on purpose: it makes llama-server re-read its sources,
        which is real work, and this route is what the tab polls. A refresh belongs on a button,
        which is m1-5's problem, not a query param anyone can put on a poll.
        """
        cfg = _llama_cfg()
        if not llama.configured(cfg):
            return jsonify({"error": "llama_unconfigured",
                            "message": "No llama.cpp URL is set — add one in "
                                       "⚙ Settings ▸ llama.cpp."}), 503
        try:
            rows = llama.list_models(cfg)
        except llama.LlamaAuthFailed as exc:
            return jsonify({"error": "llama_auth", "message": str(exc), "url": cfg.url}), 502
        except llama.LlamaUnreachable as exc:
            return jsonify({"error": "llama_unreachable", "message": str(exc),
                            "url": cfg.url}), 503
        mode, _ = _mode_or_none(cfg)
        return jsonify({"models": rows, "local": cfg.local, "mode": mode})

    @bp.route("/llama/status")
    def llama_status():
        """What is loaded right now, and can this box see its memory?

        🔴 `loaded` MEANS HOLDING VRAM, NOT `is_running()`. `sleeping` is running — the router
        routes to it — and holds nothing, so a tab that read `running` would report a model on
        cards that are empty. `llama.status` already draws that line; do not re-widen it here.
        """
        cfg = _llama_cfg()
        if not llama.configured(cfg):
            return jsonify({"error": "llama_unconfigured",
                            "message": "No llama.cpp URL is set — add one in "
                                       "⚙ Settings ▸ llama.cpp."}), 503
        host = urllib.parse.urlparse(cfg.url).hostname or cfg.url
        body = {"local": cfg.local, "host": host, "url": cfg.url}
        try:
            st = llama.status(cfg)
        except llama.LlamaAuthFailed as exc:
            return jsonify({**body, "error": "llama_auth", "message": str(exc)}), 502
        except llama.LlamaUnreachable as exc:
            return jsonify({**body, "error": "llama_unreachable", "message": str(exc)}), 503
        body.update(st)
        if cfg.local:
            # ── the ticked-cards warning, per engine (9.3's, generalized at 9.5-m2) ──────
            # 🔴 GATED ON `cfg.local`, THE SAME GATE AND THE SAME REASON AS KoboldCpp's. A remote
            # llama-server loads onto hardware this box's cards are not part of, so "Vocalis has
            # cuda:0 ticked" is true and IRRELEVANT there — and a warning that fires about someone
            # else's cards is irrelevant.
            #
            # 📌 BOTH FACTS, AND THE POLICY IS DELIBERATELY NOT APPLIED HERE. The route says what
            # is ticked and whether the setting is on; the tab decides whether to open a dialog.
            # Folding them into one server-side boolean would leave the browser unable to NAME the
            # cards, which is the only part of the warning that is actionable.
            #

            # The condition is about local cards, not the engine, so the same warning applies to both.

            body["vocalis_gpus"] = rt_pool.enabled_local_cards()
            s_all = settings.load_app_settings()
            # Carried on the status poll rather than fetched at click time: the tab already polls
            # this, so the answer is never more than one poll stale, and the alternative is a
            # second round trip on the click that matters most.
            #
            # 🔴 `devices_warn_llm_loaded`, NOT A LLAMA KEY, and the same line as Kobold's
            # for the same reason (9.5.9). One condition — cards ticked while an LLM holds this
            # box — reached from either end, so it uses one shared switch.

            body["warn_gpus"] = bool(s_all.get("devices_warn_llm_loaded", True))
        else:
            # NO VRAM FIGURE, and deliberately not a 0 — `gpu.gpu_stats()` reads THIS box's
            # cards, and a remote engine's memory has no sensor here. Shipping a plausible 0.0
            # unguarded makes the tab say "holding 0 GB" about a box holding 51. A wrong number
            # outranks a missing one for damage: a blank invites a question, a zero answers it
            # falsely. Don't let a .get(..., 0) put it back.
            body["vram_measurable"] = False
        return jsonify(body)

    @bp.route("/llama/test", methods=["POST"])
    def llama_test():
        """Does the configured URL (+ key, if any) actually work? One call, one verdict.

        🔴 ALWAYS 200: this REPORTS a verdict, it does not fail. A 4xx makes the fetch throw and
        shows a transport error *about a diagnostic* instead of the diagnostic — the lesson
        `/kobold/test` learned in 4.7-m2.

        The verdicts are deliberately finer than Kobold's can be, because llama-server's errors
        are honest: a 401 really is a 401 here, where Kobold answers a wrong password with an
        empty list and a 200.
        """
        cfg = _llama_cfg()
        body = {"url": cfg.url, "local": cfg.local}
        if not llama.configured(cfg):
            return jsonify({**body, "ok": False, "reason": "unconfigured",
                            "message": "No llama.cpp URL is set."})
        ok, err = llama.available(cfg)
        if not ok:
            return jsonify({**body, "ok": False, "reason": "unreachable", "message": err})
        try:
            mode = llama.mode(cfg)
        except llama.LlamaAuthFailed as exc:
            return jsonify({**body, "ok": False, "reason": "bad_key", "message": str(exc)})
        except llama.LlamaUnreachable as exc:
            return jsonify({**body, "ok": False, "reason": "unreachable", "message": str(exc)})
        body["mode"] = mode
        try:
            rows = llama.list_models(cfg)
        except (llama.LlamaUnreachable, llama.LlamaAuthFailed) as exc:
            return jsonify({**body, "ok": False, "reason": "unreachable", "message": str(exc)})
        body["models"] = len(rows)
        if mode != llama.ROUTER_ROLE:
            # 🔴 ok: TRUE. This is a WORKING server, not a broken one — it is answering, it is
            # serving a model, and Vocalis can report on it. It simply cannot switch models,
            # which the message says without calling it a failure. Reporting `ok: false` here
            # would incorrectly classify a healthy fixed-model server as a failure.
            return jsonify({**body, "ok": True, "reason": "single_model",
                            "message": "llama-server is running with a fixed model (-m), so it "
                                       "has no model-management API. Start it with no model and "
                                       "a --models-preset to load and unload from here."})
        return jsonify({**body, "ok": True})

    @bp.route("/llama/load", methods=["POST"])
    def llama_load():
        """Ask llama-server to load a model. Answers **loading**, never loaded.

        🔴 `{"success": true}` FROM llama-server MEANS STARTED. `server_models::load()` spawns the
        child and returns before it is ready, so this route reports `loading: true` and starts a
        watcher; the browser polls `/llama/status`. Anything that read "loaded" off this response
        would be reporting the state from BEFORE the call — 4.7 measured that exact gap on
        KoboldCpp at t=0.01 s against a swap completing seconds later.

        ⚠️ The name is checked against the LIVE list first, so an unknown id is a clean 404 with a
        sentence rather than llama-server's masked "File Not Found". That is worth the extra round
        trip precisely because its own 404 cannot say which of three things went wrong.
        """
        cfg = _llama_cfg()
        mode, err = _require_router(cfg)
        if err:
            return err
        name = str((request.get_json(silent=True) or {}).get("model") or "")
        if not name:
            return jsonify({"error": "model is required"}), 400
        try:
            offered = [r["id"] for r in llama.list_models(cfg)]
        except llama.LlamaAuthFailed as exc:
            return jsonify({"error": "llama_auth", "message": str(exc)}), 502
        except llama.LlamaUnreachable as exc:
            return jsonify({"error": "llama_unreachable", "message": str(exc)}), 503
        if name not in offered:
            return jsonify({"error": "unknown_model",
                            "message": f"llama-server does not offer a model named {name!r}."}), 404
        try:
            llama.load(cfg, name)
        except llama.LlamaUnreachable as exc:
            return jsonify({"error": "llama_unreachable", "message": str(exc)}), 502
        threading.Thread(target=_watch_load, args=(cfg, name), daemon=True).start()
        # 🔴 NO ETA. Nothing about a llama.cpp load has been timed yet, and 4.1's invented one was
        # 5x wrong. The UI shows an indeterminate state and, where the server offers it, its OWN
        # progress fraction from /models/sse — a measurement rather than a guess.
        return jsonify({"ok": True, "loading": True, "model": name})

    @bp.route("/llama/unload", methods=["POST"])
    def llama_unload():
        """Unload a model and poll until the server reports it absent. Report whether it is gone, without a freed-memory estimate because no trustworthy measurement is available. If the timeout expires, `gone: false` is a status result rather than a request failure."""
        cfg = _llama_cfg()
        mode, err = _require_router(cfg)
        if err:
            return err
        name = str((request.get_json(silent=True) or {}).get("model") or "")
        if not name:
            return jsonify({"error": "model is required"}), 400
        try:
            llama.unload(cfg, name)
        except llama.LlamaUnreachable as exc:
            # 🟢 Readable, unlike load's: /models/unload answers 400, which httplib does not
            # survives the HTTP client and reaches the caller intact.
            return jsonify({"error": "llama_unreachable", "message": str(exc)}), 502
        gone, end = False, time.monotonic() + 60.0
        while time.monotonic() < end:
            time.sleep(1.0)
            try:
                if not llama.is_loaded(cfg, name):
                    gone = True
                    break
            except (llama.LlamaUnreachable, llama.LlamaAuthFailed):
                continue
        logger.info(f"llama: unloaded {name!r} (gone={gone})")
        return jsonify({"ok": True, "unloaded": gone, "model": name,
                        # Honest about what this box can and cannot see, and never a 0.0 —
                        # gpu.other_vram_gb() would answer a plausible zero for a remote engine.
                        "vram_measurable": bool(cfg.local)})

    return bp
