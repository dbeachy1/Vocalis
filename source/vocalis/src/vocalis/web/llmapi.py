"""Owns `/llm/api/*` provider settings and `/llm/engine`. API keys are stored in encrypted settings and reads expose only `key_set`; responses are assembled field by field. Connection checks return a verdict in a successful response so transport errors remain distinct from provider failures. Provider metadata and the selected worldbook engine are stored in app settings and remain readable while the vault is locked."""
from __future__ import annotations

import time

from flask import Blueprint, jsonify, request

import llmapi
import voice_utils
from loguru import logger
from vault import VaultLocked

from vocalis.runtime import auth
from vocalis.runtime import paths
from vocalis.runtime import settings

#: The fields of a search row that are kept with a pick. An allowlist, not the posted dict: the
#: browser sends the row back, and whatever it sends is not ours to write into app_settings.yaml
#: unfiltered.
_META_KEYS = ("name", "context_length", "price_in", "price_out", "supported_parameters",
              "model_class", "max_completion_tokens", "concurrency_cost")


def _secrets(provider: str) -> dict:
    """`<provider>` from the ROUTED settings file — {} while the vault is locked.

    Named exceptions, like `web/llama._llama_secrets`: a locked DEK, a corrupt file and a disk error
    are the three ways a stored secret legitimately reads as absent. A `ValueError` from a section
    name missing in `voice_utils.SECTIONS` is a BUG and is deliberately not caught.
    """
    if auth.vault_locked():
        return {}
    try:
        return voice_utils.get_section(paths.VOICE_SETTINGS, provider)
    except (VaultLocked, voice_utils.SettingsUnreadable, OSError):
        logger.exception(f"could not read the {provider} section of voice_settings.yaml")
        return {}


def api_cfg(provider: str) -> llmapi.ApiConfig:
    """The seam `llm_engine` and the routes resolve a provider through — tests stub this."""
    return llmapi.resolve_config(provider, settings.load_app_settings(), _secrets(provider))


def _block(s: dict, provider: str) -> dict:
    """`llm_api.<provider>` out of app settings, tolerant of a hand-edited `llm_api: "oops"`."""
    b = s.get("llm_api") if isinstance(s.get("llm_api"), dict) else {}
    mine = b.get(provider)
    return mine if isinstance(mine, dict) else {}


def picked_model(provider: str) -> str:
    return str(_block(settings.load_app_settings(), provider).get("model") or "")


def _save_block(provider: str, mutate) -> dict:
    """load → mutate `llm_api.<provider>` → save, inside `settings.APP_LOCK` (the 7.2-m4b rule:
    two overlapping PUTs must not revert each other)."""
    with settings.APP_LOCK:
        s = settings.load_app_settings()
        if not isinstance(s.get("llm_api"), dict):
            s["llm_api"] = {}
        mine = s["llm_api"].get(provider)
        if not isinstance(mine, dict):
            mine = {}
        mutate(mine)
        s["llm_api"][provider] = mine
        settings.save_app_settings(s)
        return dict(mine)


def _provider_view(provider: str, s: dict) -> dict:
    """What the tab paints for one provider. Built field by field — see the module docstring."""
    mine = _block(s, provider)
    meta = mine.get("model_meta") if isinstance(mine.get("model_meta"), dict) else {}
    last = mine.get("last_connect") if isinstance(mine.get("last_connect"), dict) else None
    return {"id": provider, "label": llmapi.PROVIDERS[provider].label,
            "key_set": bool(api_cfg(provider).api_key),
            "model": str(mine.get("model") or ""),
            "model_meta": {k: meta[k] for k in _META_KEYS if k in meta},
            "last_connect": ({"ok": bool(last.get("ok")), "message": str(last.get("message") or ""),
                              "at": float(last.get("at") or 0.0)} if last else None)}


def _unknown(provider: str):
    if provider in llmapi.PROVIDERS:
        return None
    return jsonify({"error": "unknown_provider",
                    "message": f"unknown provider {provider!r}"}), 404


def create_llmapi_blueprint() -> Blueprint:
    bp = Blueprint("vocalis_llmapi", __name__)

    @bp.get("/llm/api")
    def llm_api():
        """Both providers, as the API sub-tab paints them. No network."""
        s = settings.load_app_settings()
        return jsonify({"providers": [_provider_view(p, s) for p in llmapi.PROVIDERS]})

    @bp.put("/llm/api/<provider>/key")
    def llm_api_key(provider):
        """Save (`api_key` non-empty) or remove (`""`) a provider's key.

        A key change also forgets the last Connect verdict and any cached catalogue: both
        describe the OLD key, and "Connected · key OK" under a key nobody has checked is the one
        status line that must never be stale.
        """
        bad = _unknown(provider)
        if bad:
            return bad
        if auth.vault_locked():
            return jsonify({"error": "vault_locked",
                            "message": "The vault is locked — log in before saving an API key."}), 409
        data = request.get_json(silent=True) or {}
        if "api_key" not in data:
            return jsonify({"error": "api_key is required ('' removes the key)"}), 400
        key = str(data.get("api_key") or "").strip()
        # 🔴 PRINTABLE ASCII, NO SPACES. http.client refuses a header value with
        # a line break by raising an error that QUOTES THE WHOLE KEY; `llmapi._scrub` now cuts it
        # out, but a key no provider issues has no business being stored in the first place.
        if key and any(c.isspace() or not (33 <= ord(c) <= 126) for c in key):
            return jsonify({"error": "bad_key",
                            "message": "An API key cannot contain spaces, line breaks or "
                                       "non-ASCII characters — paste it again."}), 400
        sec = voice_utils.get_section(paths.VOICE_SETTINGS, provider)
        if key:
            sec["api_key"] = key
        else:
            sec.pop("api_key", None)
        voice_utils.replace_section(paths.VOICE_SETTINGS, provider, sec)
        def reset(m):
            m.pop("last_connect", None)
            m["key_gen"] = int(m.get("key_gen") or 0) + 1   # invalidates a Connect in flight
        _save_block(provider, reset)
        llmapi.forget(provider)
        # The fact, never the value — not even a prefix or a length.
        logger.info(f"llm api: {provider} key {'saved' if key else 'removed'}")
        return jsonify({"ok": True, "key_set": bool(api_cfg(provider).api_key)})

    @bp.post("/llm/api/<provider>/connect")
    def llm_api_connect(provider):
        """Check the key against the provider. ALWAYS 200 — a verdict, not a failure.

        The verdict is remembered (app_settings, no secret in it) so the tab can show "last
        checked" on the next visit without spending another ten seconds finding out.
        """
        bad = _unknown(provider)
        if bad:
            return bad
        # 🔴 THE VERDICT IS FOR THE KEY THAT WAS CHECKED. A Connect can take 30 s,
        # and a key saved meanwhile pops `last_connect` — then this verdict, about the OLD key,
        # would land after it and paint "✓ key OK" under a key nobody checked. The key route bumps
        # `key_gen` on every save or removal; the verdict is written only if it has not moved.
        # ⚠️ `gen` is read BEFORE the key: read after, a save landing between the two reads would
        # pair the old key with the new generation and keep the stale verdict.
        gen = int(_block(settings.load_app_settings(), provider).get("key_gen") or 0)
        cfg = api_cfg(provider)
        t0 = time.monotonic()
        try:
            res = llmapi.connect(cfg)
            ok, message, detail = bool(res["ok"]), res["message"], res.get("detail") or {}
        except llmapi.ApiRefused as exc:
            ok, message, detail = False, str(exc), {}
            if exc.detail:
                message = f"{message} {cfg.label} said: {exc.detail}"
        except llmapi.ApiUnreachable as exc:
            ok, message, detail = False, str(exc), {}
        took = time.monotonic() - t0
        logger.info(f"llm api: {provider} connect → {'ok' if ok else 'failed'} in {took:.1f}s "
                    f"({message})")
        verdict = {"ok": ok, "message": message, "at": time.time()}

        def keep(m):
            if int(m.get("key_gen") or 0) == gen:
                m["last_connect"] = verdict
            else:
                logger.info(f"llm api: {provider} key changed during Connect — verdict discarded")
        _save_block(provider, keep)
        return jsonify({**verdict, "detail": detail, "seconds": round(took, 2)})

    @bp.get("/llm/api/<provider>/models")
    def llm_api_models(provider):
        """Search. `?q=` is required and must be at least 2 characters — there is no browse."""
        bad = _unknown(provider)
        if bad:
            return bad
        q = " ".join(str(request.args.get("q") or "").split())
        if len(q) < 2:
            return jsonify({"models": [], "q": q})
        cfg = api_cfg(provider)
        if not cfg.api_key:
            return jsonify({"error": "no_key",
                            "message": f"Save a {cfg.label} API key first."}), 409
        t0 = time.monotonic()
        try:
            rows = llmapi.search(cfg, q)
        except llmapi.ApiRefused as exc:
            msg = f"{exc} {cfg.label} said: {exc.detail}" if exc.detail else str(exc)
            return jsonify({"error": "refused", "message": msg}), 502
        except llmapi.ApiUnreachable as exc:
            return jsonify({"error": "unreachable", "message": str(exc)}), 503
        logger.info(f"llm api: {provider} search {q!r} → {len(rows)} rows in "
                    f"{time.monotonic() - t0:.1f}s")
        return jsonify({"models": rows, "q": q})

    @bp.put("/llm/api/<provider>/model")
    def llm_api_model(provider):
        """Save the clicked model — its id, plus a snapshot of its search row so the tab can say
        what it is (context, price) without searching again. `id: ""` clears the pick."""
        bad = _unknown(provider)
        if bad:
            return bad
        data = request.get_json(silent=True) or {}
        mid = str(data.get("id") or "").strip()
        meta_in = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        meta = {}
        for k in _META_KEYS:
            v = meta_in.get(k)
            if k == "supported_parameters":
                if isinstance(v, list):
                    meta[k] = [str(x)[:64] for x in v if isinstance(x, str)][:64]
            elif k in ("name", "model_class"):
                if isinstance(v, str):
                    meta[k] = v[:200]
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                meta[k] = v

        def put(m):
            if mid:
                m["model"], m["model_meta"] = mid, meta
            else:
                m.pop("model", None)
                m.pop("model_meta", None)
        _save_block(provider, put)
        logger.info(f"llm api: {provider} model {'picked ' + repr(mid) if mid else 'cleared'}")
        s = settings.load_app_settings()
        return jsonify(_provider_view(provider, s))

    @bp.get("/llm/engine")
    def llm_engine_get():
        """Which engine the worldbook editor uses, and which could be chosen. No network — the
        badge (`/wbedit/model`) is what says whether the chosen one is up."""
        from vocalis.web import llm_engine
        return jsonify({"engine": llm_engine.chosen(), "engines": llm_engine.usable()})

    @bp.put("/llm/engine")
    def llm_engine_put():
        from vocalis.web import llm_engine
        e = str((request.get_json(silent=True) or {}).get("engine") or "").strip().lower()
        if e not in llm_engine.ENGINES:
            return jsonify({"error": "unknown_engine",
                            "message": f"unknown engine {e!r}"}), 400
        with settings.APP_LOCK:
            s = settings.load_app_settings()
            s["wbedit_engine"] = e
            settings.save_app_settings(s)
        logger.info(f"llm engine: the worldbook editor now uses {llm_engine.LABELS[e]}")
        return jsonify({"engine": e, "engines": llm_engine.usable()})

    return bp
