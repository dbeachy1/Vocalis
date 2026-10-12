"""`/kobold/*` — the KoboldCpp remote control (5.1-P4.13).

Six routes and five helpers. **Vocalis is a REMOTE CONTROL here**: it asks Kobold what it
offers and asks it to load. It never reads or writes `--admindir` except for the (local-only)
detail line. `src/kobold.py` is the engine; this is the thin skin over it.

🔴 **`cfg.local` gates four capabilities, and the gate is NEVER `loaded` or a VRAM number**
(DESIGN_4_7 §2b/§5). A remote Kobold's model sits on hardware this box never touches, so
unloading it frees nothing here — and `gpu.other_vram_gb()` answers a plausible 0.0 when it
cannot see the cards rather than erroring, which makes "remote" and "holding nothing" the same
number. **Config decides locality; measurement only ever decides how much.**

🔴 **`_kobold_render_conflict` lives here, and `/book/start` is its only caller.** That is §4.3
applied to a HELPER rather than a route: every line of its body is `_kobold_cfg` /
`kobold.status` / `kobold.reconcile` / `gpu.other_vram_gb`, so it is kobold code that books
merely calls. `vocalis_server` wires it into `create_books_blueprint` as a lambda over this
module's binding (5.1-P4.11 measured this; it is why item 3.10 never blocked either domain).

⚠️ **5.1.1: the lambda is NOT what keeps the `_kobold_cfg` stubs working** — this used to say it
was. Those stubs land on this module's global, and `_kobold_render_conflict` reads that global at
call time, so they work through a captured function object just as well. The lambda only matters
if something patches `_kobold_render_conflict` itself, which nothing does.

🔴 **`_kobold_secrets` LIVES HERE NOW, AND THIS MODULE TAKES NOTHING (5.1-P4.18).** It used to
be injected, on the stated grounds that reading the stored password goes through
`vault_locked()` → `STORE` — "the auth core, which cannot move until ledger item 3.10 gives
`_ADMIN_HASH`/`_CREDS_BROKEN` an owner object". **P4.15 closed item 3.10**, so that premise
expired and the function is an ordinary import away from anything: `auth.vault_locked()`,
`voice_utils`, `paths.VOICE_SETTINGS`. It is filed here rather than in `runtime/` for the reason
§4.3 gives and P4.11b applied to `_kobold_render_conflict`: **classify a helper by what its body
does.** Every line of it is the kobold section of the settings file. `/settings/app` — now
`web/ui.py` — is a foreign CALLER, exactly as `/book/start` is for the render conflict, and it
receives this as an injected lambda rather than importing a sibling blueprint (no `web` module
imports another; the server does the wiring, and Phase 5's `create_app()` is where that
consolidates). `runtime/configs.py` was reconsidered and rejected: it imports enhance/voxcpm and
drags torch, so putting a Kobold secret read there would make every reader of a config pay for a
GPU stack.

**And it is still deliberately NOT folded into `_kobold_cfg`, which is the whole reason it is a
separate function** — sharing a module changes nothing about that. An autouse fixture and a dozen
tests stub `_kobold_cfg` wholesale (it is the network boundary), so answering "is a password
stored?" through it would read a blank config and report False. The stored-secret question is not
the talk-to-Kobold question, and they need separate doors.
"""
import threading
import time
import urllib.parse

from flask import Blueprint, jsonify, request

import kobold
import voice_utils
from loguru import logger
from vault import VaultLocked

from vocalis.runtime import auth
from vocalis.runtime import gpu
from vocalis.runtime import paths
from vocalis.runtime import pool as rt_pool
from vocalis.runtime import settings


def _kobold_secrets() -> dict:
    """The `kobold` section of the ROUTED settings file — {} while the vault is locked.

    Deliberately NOT folded into `_kobold_cfg`: an autouse fixture and a dozen tests stub
    `_kobold_cfg` out wholesale (it is the network boundary), so anything that reads it to
    answer "is a password stored?" gets a blank config and reports False. The stored-secret
    question is not the talk-to-Kobold question, and they need separate doors.

    5.1-P4.18: moved here from `vocalis_server`, where it was the last piece of kobold left
    behind. Its stated blocker was ledger item 3.10, which P4.15 closed — see the module
    docstring. `/settings/app` still calls it, from `web/ui.py`, as an injected lambda.
    """
    if auth.vault_locked():
        return {}
    try:
        return voice_utils.get_section(paths.VOICE_SETTINGS, "kobold")
    except (VaultLocked, voice_utils.SettingsUnreadable, OSError):
        # NAMED, not blind (SPEC_5_0_M5 §2): the vault losing its DEK between the check above
        # and this line, a corrupt settings file, and a disk error are the three ways a READ
        # of a stored secret legitimately comes back empty. A ValueError from an unknown
        # section name is a BUG in this call and must not be swallowed into "no password set".
        logger.exception("could not read the kobold section of voice_settings.yaml")
        return {}


def _kobold_cfg() -> kobold.KoboldConfig:
    """Read the encrypted KoboldCpp admin password only after vault unlock. The non-secret URL, admin directory, and CA file live in app settings. HTTP requests are gated before this helper runs; its empty-password behavior is for non-HTTP callers that may outlive a lock."""
    return kobold.resolve_config(settings.load_app_settings(), _kobold_secrets())


def _kobold_render_conflict():
    """Return the 409 offer shown before a book render when a local KoboldCpp model holds cards the render needs. This is advisory: the user chooses whether to unload the model. Remote KoboldCpp does not affect local cards and must not trigger the offer; probe failures return no conflict so Kobold cannot block rendering."""
    try:
        cfg = _kobold_cfg()
        if not cfg.local:
            return None
        st = kobold.status(cfg)
        if not st.get("loaded"):
            return None
        model = st.get("model") or ""
        # Naming the config is a nicety on top of the offer, so it gets its own net: a
        # list_options that fails (or ties) must not swallow a conflict we already know is
        # real. reconcile() answers None rather than guessing, and the modal falls back to
        # the raw model string Kobold reported.
        config = None
        try:
            config = kobold.reconcile(cfg, model, kobold.list_configs(cfg)).get("config")
        except Exception:                        # noqa: BLE001
            pass
        vram = round(gpu.other_vram_gb(), 2)
        held = f"~{vram:g} GB" if vram > 0 else "the GPUs"
        return {"error": "kobold_loaded", "model": model, "config": config,
                "config_label": kobold.display_label(config) if config else None,
                "other_vram_gb": vram,
                # The sentence, not just the code: an unhandled 409 renders `message`, and
                # The code is for client branching; the message is for the operator.
                "message": f"KoboldCpp is holding {held} on this box's cards. "
                           f"Unload it first, or render anyway."}
    except Exception:                            # noqa: BLE001
        return None


def _kobold_configs_body(cfg: kobold.KoboldConfig) -> dict:
    names = kobold.list_configs(cfg)
    rows = []
    docker = paths.docker_encrypted_mode()
    readable_here = kobold.config_dir_readable(cfg) if cfg.local else None
    if cfg.local:
        logger.info(f"kobold: configs={len(names)} local=True admindir_readable_here={readable_here} "
                    f"docker={docker} (details {'read' if readable_here else 'not readable from here'}, "
                    f"model-file check {'off' if docker else 'on'})")
    for n in names:
        row = {"name": n, "label": kobold.display_label(n)}
        # LOCAL ONLY. Remote, the kcpps files are on the other box: reading here would either
        # raise on every row or read a coincidentally same-named local directory and
        # confidently describe THE WRONG BOX'S CONFIGS. Degrade deliberately to the filename
        # list_options already gave us.
        if cfg.local:
            # Release audit 2026-10-11, item 2: "local" means "on this MACHINE", but Vocalis
            # reads these files from wherever it RUNS. In the Docker image that is a container
            # that cannot see the host's folder, so every row used to read a red "not found" and
            # (when a folder did exist) a red "model file missing" for a host path. Say once,
            # neutrally, that the details are not readable from here.
            if not readable_here:
                row["detail"] = {"unreadable_here": True}
            else:
                row["detail"] = kobold.parse_kcpps(cfg, n, verify_model=not docker)
        rows.append(row)
    if cfg.local:
        # 5.x: every model_param points into /ai-models, which is slated to move into the
        # gocryptfs vault — and exists() on a routed/locked store answers False and NEVER
        # raises. All four configs would read "model missing" when the vault is merely
        # locked. If EVERY config's model vanished at once, that is not four deleted models.
        withmp = [r for r in rows if r.get("detail", {}).get("model_param")]
        if withmp and all(r["detail"].get("model_exists") is False for r in withmp):
            for r in withmp:
                r["detail"]["models_all_missing"] = True
    return {"configs": rows, "local": cfg.local}


def _kobold_record_load(name: str, model: str) -> None:
    """Persist the default and the config-to-model mapping only after the model is observed to load. For remote KoboldCpp, the observed mapping is a hint; local reconciliation prefers a fresh derivation."""
    # Read, change and write under `settings.APP_LOCK` (2026-10-12): this writes the whole file
    # back, so without the lock it undid any save that landed between its read and its write.
    with settings.APP_LOCK:
        s = settings.load_app_settings()
        if not isinstance(s.get("kobold"), dict):
            s["kobold"] = {}
        s["kobold"]["last_config"] = name
        if model:
            mm = s["kobold"].get("model_map")
            if not isinstance(mm, dict):
                mm = {}
            mm[name] = model
            s["kobold"]["model_map"] = mm
        settings.save_app_settings(s)
    logger.info(f"kobold: loaded {name!r} -> {model!r} (saved as the default)")


def _kobold_watch_load(cfg: kobold.KoboldConfig, name: str, timeout: float = 600.0,
                       interval: float = 2.0) -> None:
    """Poll until the model appears, then record it. Runs in a thread; the browser polls
    /kobold/status meanwhile.

    KoboldUnreachable is expected during a model swap: the supervisor replaces the child process
    that owns the listening socket. Retry refused connections until the bounded load timeout
    rather than treating this normal transition as a failed load.
    """
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        time.sleep(interval)
        try:
            st = kobold.status(cfg)
        except (kobold.KoboldUnreachable, kobold.KoboldAuthFailed):
            continue                       # mid-swap the listener is down; keep waiting
        if st.get("loaded") and st.get("model"):
            _kobold_record_load(name, st["model"])
            return
    logger.warning(f"kobold: {name!r} did not report a loaded model within {timeout:.0f}s — "
                   "not saving it as the default")


def create_kobold_blueprint() -> Blueprint:
    """Takes nothing as of 5.1-P4.18.

    It used to take `secrets()` and rebind it onto a module-level seam, because reading the
    stored password reached the auth core and the auth core could not move (ledger item 3.10).
    P4.15 closed that item, so `_kobold_secrets` is defined in this module now and the seam --
    the `_no_secrets_wired` raising default included -- is gone. Nothing ever stubbed it, so
    there is no patch target to preserve; `_kobold_cfg` remains the seam a dozen tests do stub,
    and it is untouched."""
    bp = Blueprint("vocalis_kobold", __name__)

    @bp.route("/kobold/info")
    def kobold_info():
        """Report whether KoboldCpp is configured and reachable, including the URL that was tried. An unavailable server is a normal status on a development machine, not a 500."""
        cfg = _kobold_cfg()
        ok, err = kobold.available(cfg)
        host = urllib.parse.urlparse(cfg.url).hostname or cfg.url
        body = {"available": ok, "url": cfg.url, "host": host, "local": cfg.local,
                "adminpassword_set": bool(cfg.adminpassword)}
        if not ok:
            body["error"] = err
            return jsonify(body)
        try:
            v = kobold.version(cfg)
            body["version"] = v.get("version")
            # Unauthenticated and honest — the cross-check that tells "wrong password" apart from
            # "no configs", which list_options answers identically ([] + 200).
            body["admin"] = v.get("admin")
            body["admin_on"] = bool(v.get("admin"))
            body["llm"] = bool(v.get("llm"))
        except kobold.KoboldUnreachable as exc:
            body["available"] = False
            body["error"] = str(exc)
        return jsonify(body)


    @bp.route("/kobold/configs")
    def kobold_configs():
        cfg = _kobold_cfg()
        try:
            body = _kobold_configs_body(cfg)
        except kobold.KoboldAuthFailed as exc:
            # NEVER render [] as "no configs found" — see kobold.list_configs.
            return jsonify({"error": "kobold_auth", "message": str(exc), "url": cfg.url}), 502
        except kobold.KoboldUnreachable as exc:
            return jsonify({"error": "kobold_unreachable", "message": str(exc), "url": cfg.url}), 503
        names = [r["name"] for r in body["configs"]]
        loaded_config = None
        try:
            st = kobold.status(cfg)
            if st.get("loaded"):
                loaded_config = kobold.reconcile(cfg, st["model"], names).get("config")
        except (kobold.KoboldUnreachable, kobold.KoboldAuthFailed):
            pass                        # the default just falls back to last_config, then the first
        body["default"] = kobold.pick_default(cfg, names, loaded_config)
        return jsonify(body)


    @bp.route("/kobold/status")
    def kobold_status():
        cfg = _kobold_cfg()
        # The app settings as SAVED, which is not the same object as `cfg` — `resolve_config`
        # folds in the env overrides and answers a KoboldConfig, and the warning is a UI
        # preference that has no business being a field on the connection config.
        s = settings.load_app_settings()
        host = urllib.parse.urlparse(cfg.url).hostname or cfg.url
        body = {"local": cfg.local, "host": host, "url": cfg.url}
        try:
            st = kobold.status(cfg)
        except kobold.KoboldAuthFailed as exc:
            return jsonify({**body, "error": "kobold_auth", "message": str(exc)}), 502
        except kobold.KoboldUnreachable as exc:
            return jsonify({**body, "error": "kobold_unreachable", "message": str(exc)}), 503
        body.update(st)
        if st.get("loaded"):
            try:
                names = kobold.list_configs(cfg)
            except (kobold.KoboldUnreachable, kobold.KoboldAuthFailed):
                names = []
            body.update(kobold.reconcile(cfg, st["model"], names))
        if cfg.local:
            # ── the ticked-cards warning (9.3) ──────────────────────────────────────────
            # 🔴 GATED ON `cfg.local`, THE SAME GATE AND THE SAME REASON AS
            # `_kobold_render_conflict` (§2b/§5). A remote KoboldCpp loads onto hardware this
            # box's cards are not part of, so "Vocalis has cuda:0 ticked" is true and
            # IRRELEVANT there — a warning that fires about someone else's cards is the
            # render conflict's fabricated-GB figure wearing the other hat, and a warning
            # unrelated warnings erode trust. Remote -> the key is absent and the
            # tab never asks the question.
            #
            # 📌 BOTH FACTS, and the POLICY is deliberately not applied here. The route says
            # what is ticked and whether the setting is on; the tab decides whether to open a
            # dialog. Folding them into one server-side boolean would leave the browser unable
            # to NAME the cards, which is the only part of the warning that is actionable.
            body["vocalis_gpus"] = rt_pool.enabled_local_cards()
            # Carried on the status poll rather than fetched from /settings/app at click time:
            # the tab already polls this every 4 s, so the answer is never more than one poll
            # stale, and the alternative is a second round trip on the click that matters most.
            #
            # 🔴 `devices_warn_llm_loaded`, NOT A KOBOLD KEY. Until 9.5.9 this read
            # `kobold.warn_gpus` — a second switch over the same condition as the Devices
            # checkbox, so turning one off silenced this direction while the other still said
            # warnings were on. Both engines read the shared device-warning setting, so one control governs both.

            body["warn_gpus"] = bool(s.get("devices_warn_llm_loaded", True))
            # The tab adds a LABEL to a number Vocalis already measures — it does not invent a
            # new estimate. Kobold shows up in the non-Vocalis ("other") share; so does ComfyUI,
            # and the two cannot be cleanly separated, which the UI says rather than guessing an
            # attribution. Never a file-size estimate: a sharded model_param undercounts by 15 GB
            # and this stack under-attributes ~20 GB anyway (see comfyui_vram_bytes).
            body["other_vram_gb"] = round(gpu.other_vram_gb(), 2)
        else:
            # NO VRAM FIGURE, and deliberately not a 0. gpu.gpu_stats() reads THIS box's cards; a
            # remote Kobold's 51 GB is on hardware Vocalis has no sensor for, and _other_vram_gb()
            # doesn't error — it returns a plausible ~0.0. Shipping that unguarded makes the tab
            # say "Kobold is holding 0 GB" about a box holding 51. A wrong number outranks a
            # missing one for damage: a blank invites a question, a zero answers it falsely.
            # Don't let a .get(..., 0) put it back.
            body["vram_measurable"] = False
        return jsonify(body)


    @bp.route("/kobold/load", methods=["POST"])
    def kobold_load():
        cfg = _kobold_cfg()
        name = str((request.get_json(silent=True) or {}).get("filename") or "")
        if not name:
            return jsonify({"error": "filename is required"}), 400
        ok, err = kobold.available(cfg)
        if not ok:
            return jsonify({"error": "kobold_unreachable",
                            "message": f"no KoboldCpp at {cfg.url} — {err}", "url": cfg.url}), 503
        if not cfg.adminpassword:
            return jsonify({"error": "kobold_auth",
                            "message": "no KoboldCpp admin password is set — add one in "
                                       "⚙ Settings ▸ KoboldCpp"}), 502
        try:
            # Only what Kobold itself offers. reload_config jails on the same list (:6862), so
            # this rejects early and with a better message rather than being silently ignored.
            names = kobold.list_configs(cfg)
        except kobold.KoboldAuthFailed as exc:
            return jsonify({"error": "kobold_auth", "message": str(exc)}), 502
        except kobold.KoboldUnreachable as exc:
            return jsonify({"error": "kobold_unreachable", "message": str(exc)}), 503
        if name not in names:
            return jsonify({"error": "unknown_config",
                            "message": f"KoboldCpp does not offer a config named {name!r}"}), 404
        try:
            kobold.load(cfg, name)
        except kobold.KoboldUnreachable as exc:
            return jsonify({"error": "kobold_unreachable", "message": str(exc)}), 502
        # {"success": true} means queued, not loaded. Report "loading" and let the watcher save
        # last_config after the model appears.
        # No ETA: a 40-55 GB load off the array takes real time and no run has been cleanly
        # timed yet, so the UI shows an indeterminate state rather than a guessed duration.
        threading.Thread(target=_kobold_watch_load, args=(cfg, name), daemon=True).start()
        return jsonify({"ok": True, "loading": True, "config": name})


    @bp.route("/kobold/unload", methods=["POST"])
    def kobold_unload():
        """Give the cards back: make Kobold's model child die and respawn.

        The supervisor's `unload_model` operation releases the model child without restarting the
        service, so no systemctl fallback is needed.

        The freed figure is measured whole-card before/after, not a self-report or file-size
        estimate. Remote devices have no sensor available to Vocalis, so no figure is reported.
        """
        cfg = _kobold_cfg()
        ok, err = kobold.available(cfg)
        if not ok:
            return jsonify({"error": "kobold_unreachable",
                            "message": f"no KoboldCpp at {cfg.url} — {err}", "url": cfg.url}), 503
        if not cfg.adminpassword:
            return jsonify({"error": "kobold_auth",
                            "message": "no KoboldCpp admin password is set — add one in "
                                       "⚙ Settings ▸ KoboldCpp"}), 502
        before = gpu.used_vram_gb_total() if cfg.local else None
        try:
            kobold.unload(cfg)
        except kobold.KoboldUnreachable as exc:
            return jsonify({"error": "kobold_unreachable", "message": str(exc)}), 502
        # {"success": true} means QUEUED. Measuring here would measure the state from BEFORE the
        # call — m0 clocked the response at t=0.01 s against an unload that completed at ~5.5 s.
        # So poll until the model actually reads as gone, THEN measure. And tolerate the listener
        # dropping while we wait: the socket belongs to the child being killed.
        gone, end = False, time.monotonic() + 60.0
        while time.monotonic() < end:
            time.sleep(1.0)
            try:
                if not kobold.status(cfg).get("loaded"):
                    gone = True
                    break
            except (kobold.KoboldUnreachable, kobold.KoboldAuthFailed):
                continue
        freed = None
        if cfg.local and before is not None:
            time.sleep(1.0)                       # the AMD VRAM sensor lags ~1-2 s behind a free
            after = gpu.used_vram_gb_total()
            if after is not None:
                freed = round(max(0.0, before - after), 2)
        logger.info(f"kobold: unloaded (freed {freed} GB)" if freed is not None
                    else "kobold: unloaded")
        return jsonify({"ok": True, "unloaded": gone, "freed_gb": freed,
                        "vram_measurable": bool(cfg.local)})


    @bp.route("/kobold/test", methods=["POST"])
    def kobold_test():
        """Check the configured URL and password in one request and return a verdict for the Settings panel. Always return 200 with the diagnostic result so an authentication failure is not confused with a transport failure."""
        cfg = _kobold_cfg()
        body = {"url": cfg.url, "local": cfg.local}
        ok, err = kobold.available(cfg)
        if not ok:
            return jsonify({**body, "ok": False, "reason": "unreachable", "message": err})
        try:
            v = kobold.version(cfg)
            body["version"] = v.get("version")
        except kobold.KoboldUnreachable as exc:
            return jsonify({**body, "ok": False, "reason": "unreachable", "message": str(exc)})
        if not cfg.adminpassword:
            return jsonify({**body, "ok": False, "reason": "no_password",
                            "message": "KoboldCpp is running, but no admin password is set here."})
        # `admin` comes from the UNAUTHENTICATED version probe, so it's honest — and it's the only
        # way to tell "wrong password" apart from "admin mode is off", which list_options reports
        # identically ([] + 200).
        if not v.get("admin"):
            return jsonify({**body, "ok": False, "reason": "admin_off",
                            "message": "KoboldCpp is running but admin mode is off — it was not "
                                       "started with --admin, so it cannot switch models."})
        try:
            names = kobold.list_configs(cfg)
        except kobold.KoboldAuthFailed:
            return jsonify({**body, "ok": False, "reason": "bad_password",
                            "message": "KoboldCpp rejected the admin password."})
        except kobold.KoboldUnreachable as exc:
            return jsonify({**body, "ok": False, "reason": "unreachable", "message": str(exc)})
        return jsonify({**body, "ok": True, "configs": len(names)})

    return bp
