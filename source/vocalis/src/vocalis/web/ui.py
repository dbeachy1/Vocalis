"""Owns `/`, `/ui-state`, `/settings/app`, and `/logs/tail`. Blueprint endpoint names are namespaced, including callers outside this module. UI assets are served only from the declared asset trees, and log-tail responses use byte cursors so clients receive incremental updates."""
import json
import os
import re
import secrets as _secrets
import threading
import time

from flask import Blueprint, Response, abort, jsonify, request, send_file, session
from loguru import logger

import ui_state
import voice_utils
from tts_utils import setup_logging
from wbedit import doorbell

from vocalis.runtime import auth
from vocalis.runtime import page
from vocalis.runtime import paths
from vocalis.runtime import pool as rt_pool
from vocalis.runtime import settings
from vocalis.runtime import st_extension_settings
from vocalis.runtime import subsystems
from vocalis.runtime.gpu import GPUS
from vocalis.runtime.params import as_bool as _b

# ── Live log tail (SillyTavern ▸ Logs sub-tab) ──────────────────────────────
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# A PEM certificate is a couple of kilobytes. Generous by three orders of magnitude and still
# nowhere near the 128 MB body cap, which is sized for audio (5.3-m2).
CERT_MAX_BYTES = 64 * 1024

# ── The type scale (7.2-m3), named here so the route, the GET clamp and the tests all
# ── read the same three numbers rather than three copies of them.
#
# 16px matches the browser default and is the baseline for the app's text scale. The setting
# lets users adjust application text without changing browser-wide zoom.
#
# ⚠️ 12 IS THE SAME FLOOR THE SENSOR ROW USES IN CSS (`max(0.75rem,12px)`). Keep them equal: if
# this floor drops below that one, the smallest text on the page stops scaling with the setting
# and silently pins, which reads as the slider being broken.
UI_FONT_PX_DEFAULT = 16
UI_FONT_PX_MIN = 12
UI_FONT_PX_MAX = 24


def _int_or(v, default: int) -> int:
    """A hand-edited `ui_font_px: large` must not 500 the whole settings GET."""
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _no_kobold_secrets() -> dict:
    """The pre-wiring value, and it returns {} rather than raising — see the module docstring
    for why this is the opposite call from `web/kobold.py`'s old raising default."""
    logger.warning("vocalis.web.ui.kobold_secrets was never wired: "
                   "/settings/app will report kobold_adminpassword_set=false")
    return {}


def _no_llama_secrets() -> dict:
    """The pre-wiring value for llama.cpp's optional API key. Same shape and same reasoning as
    `_no_kobold_secrets`: {} rather than raising, because an unwired seam must degrade to
    "no key stored" and not take the whole settings page down with it.

    ⚠️ The warning wording is deliberately mild, because for llama.cpp "no key" is the ORDINARY
    state — `--api-key` is optional and most instances run without one. A scary log line here
    would train the reader to ignore the one from `_no_kobold_secrets`, where a missing password
    genuinely disables loading.
    """
    logger.warning("vocalis.web.ui.llama_secrets was never wired: "
                   "/settings/app will report llama_api_key_set=false")
    return {}


# 🔴 MODULE LEVEL, not a closure over the factory argument — `web/bulk.py`'s rule, and the
# nested views below read it as a module global (the `global` in the factory prevents a closure
# cell, verified against the bytecode in P4.16).
kobold_secrets = _no_kobold_secrets
llama_secrets = _no_llama_secrets


def _stop_unauthorized_acestep() -> None:
    """Reconcile saved ACE-Step authorization with locally owned children."""
    try:
        from vocalis.web import acestep as web_ace_
        results = web_ace_.disable_unauthorized()
        for result in results:
            if result.get("ok"):
                logger.info(f"devices: ACE-Step on {result.get('device')} stopped after authorization changed")
            else:
                logger.warning(f"devices: ACE-Step on {result.get('device')} still requires cleanup: "
                               f"{result.get('error')}")
    except Exception as exc:  # noqa: BLE001 — settings save must not hide cleanup failures
        logger.warning(f"acestep reconcile: {exc}")


def _reconcile_satellites(want: dict) -> None:
    """Make the satellites hold what ⚙ Settings now asks for — unless a render is using them.

    🔴 The busy check is the same contract the local pool drop above keeps, and for the same
    reason: releasing a replica out from under an in-flight book would abort it. A save during a
    render therefore defers to the next pool build, which asks for the same thing — `apply_plan`
    names every known card explicitly now, so a deferred release still happens rather than being
    forgotten. The gate is held across the call because a load claims VRAM that a render starting
    in the meantime would expect to be free.
    """
    global _sat_applying, _sat_pending
    from vocalis.runtime import satellites as rt_sat_
    # October 10, 2026 — TWO HOLDERS OF THE GATE, TOLD APART. A second Save arriving while the first
    # Save's load (about 9 s) held the gate failed `acquire(timeout=0.1)` and was logged as "a
    # render holds the cards" and dropped: tick card 1, tick card 2 at once, and the satellite was
    # sent {cuda:0: 1, cuda:1: 0} and never the second card (seen on the Windows NVIDIA and AMD Linux test machines). A render's hold is
    # deferred to the next pool build, which reads the settings; ANOTHER SAVE's hold is a thing
    # this function can see for itself, so the newest plan is remembered and applied right after.
    with _SAT_LOCK:
        if _sat_applying:
            _sat_pending = want
            logger.info(f"devices changed while another settings change is still loading on the "
                        f"satellites — this one is applied right after it (latest wins): {want}")
            return
        _sat_applying = True
        _sat_pending = None
    finished = False          # set only under _SAT_LOCK together with clearing _sat_applying
    try:
        plan, follow_up = want, False
        while True:
            # The same gate rules for the first apply and the follow-up: a render holding the
            # cards defers to the next pool build, as it always has.
            if not GPUS.acquire(timeout=0.1):
                logger.info("devices changed while a render holds the cards — the satellites keep "
                            "their current replicas until it finishes, then the next pool build "
                            "applies this" + (" (the follow-up apply, too)" if follow_up else ""))
                break
            t0 = time.monotonic()
            try:
                rt_sat_.reconcile(plan)
                logger.info(f"satellite reconcile{' (follow-up)' if follow_up else ''}: applied "
                            f"{plan} in {(time.monotonic() - t0) * 1000:.0f} ms")
            except Exception:                                   # noqa: BLE001
                # SUPERSEDED (October 10, 2026): this spot used to read "No blind except here on
                # purpose: `apply_plan` already logs and swallows per satellite, so anything
                # reaching this frame is a real bug and should be seen, not counted." It is still
                # a bug when it gets here, and it is still seen (logged WITH its traceback), but
                # it may no longer end this thread: a pending newer plan has to be applied and
                # the busy flag has to be cleared, or every later Save would queue behind it.
                logger.exception(f"satellite reconcile{' (follow-up)' if follow_up else ''} "
                                 f"failed after {(time.monotonic() - t0) * 1000:.0f} ms "
                                 f"(plan {plan})")
            finally:
                GPUS.release()
            with _SAT_LOCK:
                pending, _sat_pending = _sat_pending, None
                if pending is None:
                    _sat_applying = False
                    finished = True
                    return
            # Not the captured `pending` if the file says otherwise: saves are not serialized, so
            # arrival order is not save order. The plan is derived from what is saved NOW.
            plan, follow_up = _latest_saved_plan(pending), True
            logger.info(f"satellite reconcile: applying the newest saved plan after the earlier "
                        f"change finished: {plan}")
    finally:
        if not finished:
            with _SAT_LOCK:
                _sat_applying = False
                _sat_pending = None


#: One satellite reconcile at a time owns the gate. `_sat_applying` is True from the moment a
#: reconcile starts until it has found nothing pending; `_sat_pending` is the newest plan that
#: arrived meanwhile (latest wins — several saves during one load collapse into one follow-up).
_SAT_LOCK = threading.Lock()
_sat_applying = False
_sat_pending = None


def _satellite_plan(rows) -> dict:
    """The replicas ⚙ Settings asks the satellites to hold: one per ticked card that may render.
    A satellite performs rendering only, so unticking the row OR its render permission removes
    it from the set."""
    from vocalis.runtime import satellites as rt_sat_
    return {d["id"]: rt_pool.WORKERS_PER_DEVICE for d in rows
            if isinstance(d, dict) and d.get("id") and rt_sat_.is_satellite_device(d["id"])
            and d.get("enabled") and subsystems.authorized(d, subsystems.RENDER)}


def _latest_saved_plan(fallback: dict) -> dict:
    """`_satellite_plan` of the devices saved right now; `fallback` when no device list is saved."""
    rows = settings.load_app_settings().get("devices")
    return _satellite_plan(rows) if isinstance(rows, list) else fallback


def create_ui_blueprint(secrets, llama_secrets_fn=None) -> Blueprint:
    """`secrets()` -> the `kobold` section of the routed settings file, or {} while the vault is
    locked. Injected rather than imported because no `web` module imports a sibling; see the
    module docstring.

    `llama_secrets_fn` is the same thing for llama.cpp's optional API key (9.5-m1). It is
    KEYWORD-OPTIONAL so that every existing caller — the server and a handful of tests that build
    this blueprint directly — keeps working unchanged; omitted, the module-level default reports
    "no key stored" and logs that it was never wired.

    ⚠️ TWO INJECTIONS, NOT ONE WIDENED INTO A DICT. They read different sections of the routed
    file for different engines, and collapsing them into one `secrets(section)` callable would
    hand this module the job of knowing which section belongs to which engine — which is exactly
    the knowledge `web/kobold.py` and `web/llama.py` each own about themselves.
    """
    global kobold_secrets, llama_secrets
    kobold_secrets = secrets
    if llama_secrets_fn is not None:
        llama_secrets = llama_secrets_fn
    bp = Blueprint("vocalis_ui", __name__)

    @bp.route("/")
    def index():
        session.permanent = True
        if not session.get("csrf"):
            session["csrf"] = _secrets.token_urlsafe(32)
        if not auth.auth_enabled():
            session["logged_in"] = True            # open UI -> treat the visitor as the admin
        # 5.0-M8: inject the UI state (tabs/selections/prose) into the page so the ~6 reads that run
        # at script-parse time have it synchronously — a GET-on-load would race them and flash stale
        # UI. This read is safe: the two before_request gates mean `/` only renders authenticated AND
        # unlocked, so the vault file always decrypts here. `<`/`>`/`&` are escaped so user prose can't
        # break out of the <script>, and {{UI_STATE}} is substituted LAST so injected text containing a
        # literal {{ADMIN_USER}} can't be re-expanded.
        ui_json = (json.dumps(ui_state.load(paths.UI_STATE))
                   .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
        # 9.0-m0: the page is assembled from its per-tab parts before substitution (TECH_DEBT #1).
        # 🔴 THE THREE REPLACEMENTS BELOW ARE UNCHANGED, AND THE ORDER STILL MATTERS. `page.assemble`
        # deliberately runs Jinja with VARIABLES DISABLED, so `{{...}}` reaches here exactly as it
        # sits in the file and this substitution is the only thing that expands it — read
        # `runtime/page.py`'s docstring before making these Jinja variables, because four `{{...}}`
        # in the page are literal text and one of them would otherwise leak the UI state into a
        # comment on every load.
        html = page.assemble() \
            .replace("{{CSRF}}", session["csrf"]).replace("{{ADMIN_USER}}", auth.ADMIN_USER) \
            .replace("{{UI_STATE}}", ui_json)
        resp = Response(html, mimetype="text/html")
        resp.headers["Cache-Control"] = "no-store"    # never cache the gated page, so logout sticks on refresh
        return resp

    #: The static trees under `src/webui/` that are served BY CALLER-SUPPLIED PATH, and the one
    #: suffix each may hand out. `js` is 7.1 §5's module graph; `css` is 7.3.19's stylesheet split.
    #:
    #: 🔴 ONE TABLE AND ONE GUARD, NOT A ROUTE EACH WITH ITS OWN COPY. The function below is a
    #: path-traversal check, and the failure mode of duplicating one is not that the copy is wrong
    #: on the day it is written — it is that the two drift, and the weaker one is the one nobody
    #: re-reads. Adding a tree here is a line of data; adding a second hand-written twin of the
    #: guard is how `/webui/css/..%2f..%2fetc%2fpasswd` eventually works on exactly one of them.
    #: `bundle` is 7.5.6's single-file build of the `js` tree (tools/build_webui.mjs), and it is
    #: what the PAGE loads. `js` stays served because the browser specs import module URLs directly
    #: and `test_webui_modules.py` proves every one of them is reachable — the bundle is an
    #: ADDITIONAL artifact, never a replacement for the sources.
    _ASSET_TREES = {"js": (".js", "application/javascript"),
                    "bundle": (".js", "application/javascript"),
                    "css": (".css", "text/css")}

    def _webui_asset(tree, rel):
        """Serve a relative asset only from its declared tree, or return 404. Resolve the path before checking that it remains under the tree root, and allow only the tree's expected suffixes. Use `no-cache` so stored assets are revalidated on each use; conditional requests return 304 without retransmitting the body. Query strings on the entry module do not version its relative imports, so freshness must apply to each asset."""
        suffix, mimetype = _ASSET_TREES[tree]
        root = (paths.WEBUI / tree).resolve()
        try:
            p = (root / rel).resolve()
        except (OSError, ValueError):            # a path the OS refuses to even resolve
            abort(404)
        if p.suffix != suffix or (p != root and root not in p.parents) or not p.is_file():
            abort(404)
        resp = send_file(p, mimetype=mimetype)   # conditional=True by default: ETag + 304
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @bp.route("/webui/js/<path:rel>")
    def webui_js(rel):
        """Serve an ES module from the retained web interface source tree."""
        return _webui_asset("js", rel)

    @bp.route("/webui/css/<path:rel>")
    def webui_css(rel):
        """The ten stylesheets `index.html` links (7.3.19). ONE route, not one per file.

        They were a single 886-line inline `<style>` block until the page hit its own size
        tripwire — see `tests/test_webui_css.py`, which holds the rule that keeps them honest:
        the link order in the page IS the cascade, because the split was cut from contiguous
        ranges of that block."""
        return _webui_asset("css", rel)

    @bp.route("/webui/bundle/<path:rel>")
    def webui_bundle(rel):
        """Build a single bundle from the JavaScript tree to reduce HTTP requests during page startup. Keep the individual modules served because browser specs import them directly. The bundle reduces request contention in the single-process server; it is not a replacement for the module tree."""
        return _webui_asset("bundle", rel)

    @bp.route("/ui-state", methods=["GET", "POST"])
    def ui_state_route():
        """The web UI's own state (5.0-M8): tabs, selections, and the Playground prose, moved out of
        the browser's localStorage and into the install vault.

        Both methods are gated by the two before_request hooks — authenticated AND unlocked — so a
        locked or anonymous caller never reaches here (they 401 / redirect to /login). The page load
        itself does NOT use GET: `index()` injects the blob directly (SPEC_5_0_M8 §4). GET exists for
        tests and any future in-place reload.

        🔴 POST IS A PER-KEY DELTA, NOT A WHOLE-BLOB PUT (8.0-m21). The PUT shape was the template
        amnesia: every open tab holds its own snapshot of the whole state and POSTs ALL of it, so a
        second window that booted before you picked a template ERASES the pick the moment it
        flushes anything — reproduced in tests/ace_draft_twotab_spec.mjs, tab B's tab-click flush
        nulling tab A's freshly flushed draft. A tab now sends only the keys IT changed
        ({set: {...}, del: [...]}), and the server merges. The legacy whole-dict shape is still
        accepted (a not-yet-reloaded page keeps working across the deploy); it is unambiguous
        because real state keys all start with "vocalis-" and the delta envelope's keys do not.
        """
        if request.method == "GET":
            return jsonify(ui_state.load(paths.UI_STATE))
        if not auth.csrf_ok():
            return jsonify({"error": "bad or missing CSRF token — reload the page and retry"}), 403
        data = request.get_json(force=True, silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "ui-state must be a JSON object"}), 400
        # sanitize() drops theme/vol and anything non-vocalis before it can reach the encrypted file.
        if ("set" in data or "del" in data) and not any(k.startswith("vocalis-") for k in data):
            set_map, del_list = data.get("set") or {}, data.get("del") or []
            if not isinstance(set_map, dict) or not isinstance(del_list, list):
                return jsonify({"error": "ui-state delta: 'set' must be an object, 'del' a list"}), 400
            return jsonify(ui_state.apply_delta(paths.UI_STATE, set_map, del_list))
        return jsonify(ui_state.save(paths.UI_STATE, data))

    @bp.route("/settings/sillytavern-extension", methods=["GET", "PUT", "DELETE"])
    def sillytavern_extension_settings():
        """The canonical Vocalis extension settings snapshot.

        GET is read-only. PUT and DELETE are session, unlocked-vault, and CSRF protected by the
        app gates plus this route's explicit mutation check. The prompt is never included in a
        diagnostic; only its computed revision crosses a log boundary.
        """
        if request.method == "GET":
            return jsonify(st_extension_settings.editor_snapshot(st_extension_settings.load_settings()))
        if not auth.csrf_ok():
            return jsonify({"error": "bad or missing CSRF token — reload the page and retry"}), 403
        if request.method == "PUT":
            body = request.get_json(silent=True)
            try:
                result = st_extension_settings.save_settings(body)
            except st_extension_settings.SettingsValidationError as exc:
                logger.info(f"st extension settings: rejected payload ({type(exc).__name__})")
                return jsonify({"error": str(exc)}), 400
            logger.info(f"st extension settings: saved schema={result['schema_version']} "
                        f"revision={result['revision'][:12]}")
        else:
            result = st_extension_settings.reset_settings()
            logger.info(f"st extension settings: reset schema={result['schema_version']} "
                        f"revision={result['revision'][:12]}")
        # The doorbell is deliberately an empty work notification. The extension refreshes the
        # settings through its authenticated read path; no prompt or other user content rides SSE.
        doorbell.ring()
        return jsonify(st_extension_settings.editor_snapshot(result))

    @bp.route("/settings/app", methods=["GET", "PUT"])
    def app_settings():
        """Machine-level UI prefs that should survive a page reload. Persisted to
        app_settings.yaml; behind the login guard like every other control-panel route.

        `workers_per_card` was removed in 5.4.1 — one worker per device is now a constant
        (`rt_pool.WORKERS_PER_DEVICE`), because a second worker on a card measured SLOWER than
        one. A PUT carrying the old key is accepted and ignored rather than rejected: the key
        is still sitting in every deployed app_settings.yaml, and a stale browser tab that
        PUTs it should not get a 400 for a field it was told about before the upgrade.
        """
        # 🔴 ONE CRITICAL SECTION ACROSS load → mutate → save (7.2-m4b). The server is
        # `threaded=True`, so two in-flight PUTs interleave: both load the same snapshot, both
        # save, and the first one's change is silently reverted by the second. That is a LOST
        # UPDATE, and a lock inside `save_app_settings` alone does not touch it — by then the
        # stale snapshot has already been read.
        #
        # ⚠️ FOUND BY THE SUITE, NOT BY REVIEW. 7.2-m3's text-size slider persists on `input`,
        # so one drag fired a PUT per step, fire-and-forget and overlapping. Two runs later the
        # browser spec died on the OTHER half of the same race — a FileNotFoundError from two
        # writers sharing one `.yaml.part` temp. `REVIEW_FINDINGS_3.0.md` had described exactly
        # this shape for `voice_utils` and noted that StCharacterRegistry got a lock for it;
        # app_settings never did.
        #
        # 📌 The GET is inside it too. It costs nothing uncontended and means a reader can never
        # observe the file mid-replace.
        with settings.APP_LOCK:
            s = settings.load_app_settings()
            if request.method == "PUT":
                data = request.get_json(silent=True) or {}
                if "gpus" in data:
                    g = str(data.get("gpus") or "all").strip().lower() or "all"
                    if not (g in ("all", "cpu") or re.fullmatch(r"\d+(,\d+)*", g)):
                        return jsonify({"error": "gpus must be 'all', 'cpu', or a comma list of card indices"}), 400
                    changed = g != str(s.get("gpus", "all") or "all")
                    s["gpus"] = g
                    # The pool only picks a change up at its next build — until then the old
                    # replicas sit on the old selection's VRAM. And it matters MORE here:
                    # rt_pool.current_pool() deliberately never rebuilds a resident pool, so without this
                    # drop a card change is a silent no-op — the old pool keeps serving every
                    # render, including Nomi and SillyTavern, until something unrelated happens to
                    # rebuild it. Meanwhile the ⚙ panel states "Applies to everything that renders".
                    # A saved GPU selection does not rebuild an already resident pool automatically.
                    # The old pool remains active until explicitly dropped or rebuilt.

                    # Idle -> drop now. Mid-render -> saved, applies at the next build; we do NOT
                    # yank replicas out from under an in-flight book.
                    if changed and rt_pool.model_ready() and GPUS.acquire(timeout=0.1):
                        try:
                            rt_pool.drop_pool()
                            logger.info(f"gpus changed → {g}: pool dropped, VRAM released; "
                                        "the next render loads on the new card(s)")
                        finally:
                            GPUS.release()
                if "log_ansi_colors" in data:
                    s["log_ansi_colors"] = _b(data, "log_ansi_colors", True)
                    # Re-arm the sinks live (append — never truncates); no restart needed.
                    setup_logging(paths.LOG_DIR / "vocalis.log",
                                  colorize_file=s["log_ansi_colors"])
                # Font size defaults to 16 px and clamps to 12–24 px. Keep the 12 px floor aligned with
# the sensor-row CSS floor. Clamping invalid or stale slider values preserves other settings
# in the same request, and the upper bound protects fixed-width controls.
                if "ui_font_px" in data:
                    try:
                        px = int(float(data.get("ui_font_px")))
                    except (TypeError, ValueError):
                        px = UI_FONT_PX_DEFAULT
                    s["ui_font_px"] = max(UI_FONT_PX_MIN, min(UI_FONT_PX_MAX, px))
                # One warning flag covers both device-enable and model-load actions when local GPU use conflicts.
# Keep legacy per-engine keys inert rather than migrating them; the shared warning remains authoritative.
                #
                # 🔴 DEFAULT TRUE, HERE AND ON THE READ. One value in both places or the
                # checkbox paints unticked over a server that is warning anyway: a confirm nobody
                # has found is a feature that does not exist. The box is how you turn it OFF.
                if "devices_warn_llm_loaded" in data:
                    s["devices_warn_llm_loaded"] = _b(data, "devices_warn_llm_loaded", True)
                # ── KoboldCpp (4.7-m1) ──
                # The YAML is nested (kobold: {url, adminpassword}) but this route writes flat keys,
                # so setdefault — and guard that it IS a dict first, since a hand-edited
                # `kobold: "oops"` makes the assignment raise. (settings.load_app_settings sets the same
                # defensive tone with its isinstance check.)
                # ⚠️ `kobold_warn_gpus` WAS ACCEPTED HERE UNTIL 9.5.9 AND IS NOT ANY MORE. The
                # ticked-cards warning KoboldCpp shows on load reads `devices_warn_llm_loaded`
                # above now — one control over one fact. Do not put a per-engine key back: a
                # second switch over the same condition is how one of the two ends up lying.
                if "kobold_url" in data or "kobold_adminpassword" in data:
                    if not isinstance(s.get("kobold"), dict):
                        s["kobold"] = {}
                if "kobold_url" in data:
                    s["kobold"]["url"] = str(data.get("kobold_url") or "").strip().rstrip("/")
                if "kobold_adminpassword" in data:
                    # OMITTED means untouched; "" means CLEAR. Two different things, and collapsing
                    # them is how editing the URL silently wipes the password. The `in data` test
                    # above is what keeps them apart — don't reduce this to a truthiness check.
                    #
                    # 🔴 THE PASSWORD GOES TO THE ROUTED FILE, never to app_settings.yaml. Writing a
                    # secret there put it in plaintext on disk permanently. Saving one requires an
                    # unlocked vault, which a logged-in admin always has.
                    if auth.vault_locked():
                        return jsonify({"error": "the vault is locked — log in before setting the "
                                                 "KoboldCpp admin password"}), 409
                    pw = str(data.get("kobold_adminpassword") or "")
                    sec = voice_utils.get_section(paths.VOICE_SETTINGS, "kobold")
                    if pw:
                        sec["adminpassword"] = pw
                    else:
                        sec.pop("adminpassword", None)
                    voice_utils.replace_section(paths.VOICE_SETTINGS, "kobold", sec)
                    s["kobold"].pop("adminpassword", None)     # never leave a copy behind
                # ── llama.cpp (9.5-m1) ──
                # Same nesting/setdefault dance as KoboldCpp above, and the same three rules:
                # the YAML is nested but this route writes flat keys; a hand-edited
                # `llama: "oops"` must not make the assignment raise; and the credential goes to
                # the ROUTED file, never to app_settings.yaml.
                # ⚠️ `llama_warn_gpus` is gone for the reason `kobold_warn_gpus` gives above:
                # `devices_warn_llm_loaded` is the one switch over the one condition (9.5.9).
                if "llama_url" in data or "llama_api_key" in data:
                    if not isinstance(s.get("llama"), dict):
                        s["llama"] = {}
                if "llama_url" in data:
                    # 🔴 NO DEFAULT SUBSTITUTED HERE, unlike Kobold's. An empty URL means NOT
                    # CONFIGURED, which is what disables the llama.cpp sub-tab — writing a
                    # plausible default on an empty save would light the tab up for a server
                    # nobody is running. See llama.resolve_config's own note.
                    s["llama"]["url"] = str(data.get("llama_url") or "").strip().rstrip("/")
                if "llama_api_key" in data:
                    # OMITTED means untouched; "" means CLEAR. Two different things, and
                    # collapsing them is how editing the URL silently wipes the key. The
                    # `in data` test above is what keeps them apart — do not reduce this to a
                    # truthiness check.
                    #
                    # ⚠️ CLEARING IS THE ORDINARY CASE HERE, not an emergency. llama-server's
                    # --api-key is optional and most instances have none, so an empty key is a
                    # perfectly good working configuration rather than a broken one. Kobold's
                    # equivalent disables loading; this one does not.
                    if auth.vault_locked():
                        return jsonify({"error": "the vault is locked — log in before setting "
                                                 "the llama.cpp API key"}), 409
                    key = str(data.get("llama_api_key") or "")
                    lsec = voice_utils.get_section(paths.VOICE_SETTINGS, "llama")
                    if key:
                        lsec["api_key"] = key
                    else:
                        lsec.pop("api_key", None)
                    voice_utils.replace_section(paths.VOICE_SETTINGS, "llama", lsec)
                    s["llama"].pop("api_key", None)            # never leave a copy behind
                settings.save_app_settings(s)
        kob = s.get("kobold") if isinstance(s.get("kobold"), dict) else {}
        lla = s.get("llama") if isinstance(s.get("llama"), dict) else {}
        # An explicit allowlist, NOT a filter — that is what makes this GET safe structurally
        # rather than incidentally, and it is exactly what it was guarding. `kobold_adminpassword_set`
        # is a BOOL; the value must never round-trip (it would land in the DOM, in every settings
        # fetch, and in whatever the browser decides to remember). The day someone "simplifies"
        # this to `return jsonify(s)`, the admin password ships to the browser.
        # The SET flag now reflects the routed file (and the env override), not app_settings —
        # that is where the secret lives. Still a BOOL: the value must never round-trip.
        return jsonify({"gpus": str(s.get("gpus", "all") or "all"),
                        "log_ansi_colors": bool(s.get("log_ansi_colors", True)),
                        # In the Docker package LOG_DIR is the CONTAINER's /logs, a path the user
                        # cannot open. The compose file binds it to `logs/vocalis` in the instance
                        # (data) folder chosen at setup, so that is what the page is told
                        # (release audit 2026-10-11, item 7). The in-page tail reads the real file
                        # (`logs_tail` below) and is unaffected.
                        "log_path": ("logs/vocalis/vocalis.log" if paths.docker_encrypted_mode()
                                     else str(paths.LOG_DIR / "vocalis.log")),
                        "log_path_in_data_folder": paths.docker_encrypted_mode(),
                        # Clamped on the way OUT as well as in, because a hand-edited
                        # app_settings.yaml never went through the PUT above.
                        "ui_font_px": max(UI_FONT_PX_MIN, min(UI_FONT_PX_MAX,
                                          _int_or(s.get("ui_font_px"), UI_FONT_PX_DEFAULT))),
                        "kobold_url": str(kob.get("url") or ""),
                        # ── the GPU-contention warning, BOTH directions (9.5.9) ──
                        # Absent reads as ON, the same default the PUT above writes. If these two
                        # ever disagree the checkbox paints unticked over a server that is warning
                        # anyway, and the setting looks broken rather than off.
                        #
                        # 🔴 THE ONLY WARNING KEY THIS ROUTE SERVES. `kobold_warn_gpus` and
                        # `llama_warn_gpus` were removed at 9.5.9 — both engines' load-side
                        # warning reads this one now, so serving them would be painting two
                        # controls that govern nothing.
                        "devices_warn_llm_loaded": bool(
                            s.get("devices_warn_llm_loaded", True)),
                        "kobold_adminpassword_set": bool(
                            os.environ.get("VOCALIS_KOBOLD_ADMINPASSWORD")
                            or kobold_secrets().get("adminpassword")),
                        # ── llama.cpp (9.5-m1) ──
                        # 🔴 `llama_api_key_set` IS A BOOL. The value must never round-trip: it
                        # would land in the DOM, in every settings fetch, and in whatever the
                        # browser decides to remember. This allowlist is what makes that
                        # structural rather than incidental — the day someone "simplifies" this
                        # to `return jsonify(s)`, both credentials ship to the browser.
                        # ⚠️ Test it with a key SET. Testing it unset proves an empty dict is
                        # empty, which is the vacuous version of this guard.
                        "llama_url": str(lla.get("url") or ""),
                        "llama_api_key_set": bool(
                            os.environ.get("VOCALIS_LLAMA_API_KEY")
                            or llama_secrets().get("api_key"))})

    @bp.route("/satellites", methods=["POST"])
    def satellites_add():
        """Define a satellite (5.3-m2): a cosmetic name and a URL.

        🔴 **The generated secret is in this response and in no other.** It is displayed once,
        for pasting into that machine's `setup.py`, and never served again — `snapshot()` reports
        a BOOL. A secret left on screen is a secret in a screenshot (§11.3), and one that
        round-trips on every settings fetch is a secret in the DOM.
        """
        from vocalis.runtime import satellites as rt_sat
        data = request.get_json(silent=True) or {}
        try:
            secret = rt_sat.add(data.get("name"), data.get("url"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"ok": True, "name": str(data.get("name") or "").strip().lower(),
                        "secret": secret})

    @bp.route("/satellites/<name>", methods=["PUT", "DELETE"])
    def satellites_edit(name):
        """Edit a satellite's URL, or forget it entirely.

        ⚠️ DELETE also prunes that satellite's rows out of `devices:`. A left-behind row is a
        checkbox for a machine Vocalis no longer knows how to reach — it would look configurable,
        count toward the pool's signature, and do nothing.
        """
        from satellite_client import split_device
        from vocalis.runtime import satellites as rt_sat
        if request.method == "DELETE":
            # Both writes under `settings.APP_LOCK` (2026-10-12): each is a read of the whole file
            # followed by a write of the whole file, so a save from another request landing
            # between the read and the write was undone.
            with settings.APP_LOCK:
                try:
                    rt_sat.remove(name)
                except ValueError as exc:
                    return jsonify({"error": str(exc)}), 404
                # 🔴 RE-READ after the removal. Holding a snapshot taken before it and writing this
                # back resurrects the satellite entry `remove()` just deleted — a read-modify-write
                # over the same file, where the later write silently undoes the earlier one.
                s = settings.load_app_settings()
                kept = [d for d in (s.get("devices") or [])
                        if not (isinstance(d, dict) and split_device(str(d.get("id") or ""))[0] == name)]
                if kept != (s.get("devices") or []):
                    s["devices"] = kept
                    settings.save_app_settings(s)
            return jsonify({"ok": True})
        data = request.get_json(silent=True) or {}
        try:
            # §17 — the VRAM cap is edited here rather than getting a route of its own: it is the
            # same kind of edit as the URL (a property of how we use that machine), and unlike the
            # secret it breaks nothing when it changes. `client_for` writes the new figure onto
            # the ONE client every caller shares, so the next probe carries it without a restart —
            # and the UI's `loadDevices({force:true})` immediately after this makes that probe
            # happen, which is why Save appears to take effect at once.
            # 11.2 — `st_max_batch` rides the same PUT for the same reason: it is a property of
            # how we use that machine. It needs no probe to take effect (the pool reads it through
            # `client_for`'s callable at dispatch, so the very next message honors it), but the
            # forced reload the UI does after Save is what puts the saved number back on screen.
            rt_sat.update(name, url=data.get("url"), vram_cap_gb=data.get("vram_cap_gb"),
                          st_max_batch=data.get("st_max_batch"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"ok": True})

    @bp.route("/satellites/<name>/secret", methods=["POST"])
    def satellites_regenerate(name):
        """Rotate the shared secret and show the new one once (§11.5).

        Its own route rather than a field on PUT: rotating breaks the link until the new secret
        is set on the satellite too, and that must never be a side effect of correcting a typo
        in a hostname.
        """
        from vocalis.runtime import satellites as rt_sat
        try:
            return jsonify({"ok": True, "secret": rt_sat.regenerate(name)})
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 404

    @bp.route("/satellites/<name>/cert", methods=["POST"])
    def satellites_cert(name):
        """Upload the satellite's public certificate and pin to it (§11.3).

        Public material — the private half never leaves the satellite — so this is an ordinary
        file under `certs/`, not a vault write. It is parsed as a certificate before it is
        stored: a "pin" that is not one would silently degrade to unpinned TLS, which against an
        active attacker on the LAN is barely better than plain HTTP, while the badge said pinned.

        ⚠️ **The PEM arrives as the raw request BODY, not as `request.files`.** Deliberate, and
        `test_upload_body_cap.py` is why: every route that reads `request.files` has to be exempt
        from the 128 MB body cap, because that path exists for streaming large uploads to disk.
        A certificate is two kilobytes of text. Taking it as multipart would buy a blanket
        exemption for a route that wants the opposite — the tight cap below.
        """
        from vocalis.runtime import satellites as rt_sat
        if rt_sat.entry(name) is None:
            return jsonify({"error": f"no satellite named {name!r} is configured"}), 404
        pem = request.get_data(cache=False) or b""
        if len(pem) > CERT_MAX_BYTES:
            return jsonify({"error": "that file is far too large to be a certificate"}), 413
        if not pem:
            return jsonify({"error": "no certificate uploaded"}), 400
        try:
            stored = rt_sat.save_cert(name, pem)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        # Return the certificate fingerprint so the operator can verify that the upload succeeded.



        return jsonify({"ok": True, "cert": stored, "fingerprint": rt_sat.fingerprint(pem),
                        **rt_sat.security(name)})

    @bp.route("/satellites/<name>/reconnect", methods=["POST"])
    def satellites_reconnect(name):
        """Reconnect a satellite using its saved device plan, even when the plan has not changed. `PUT /devices` reconciles only changed rows, so it cannot restore the same plan after a satellite restart. This route waits for the bounded resync result."""
        from vocalis.runtime import satellites as rt_sat
        if not rt_sat.entry(name):
            return jsonify({"error": f"no satellite named {name!r}"}), 404
        return jsonify(rt_sat.resync(name))

    @bp.route("/devices", methods=["GET", "PUT"])
    def devices_route():
        """Read and write one Settings row per local or satellite device, including its enable flag and worker count. A GET probes satellite health and is intended for page load rather than polling. An unreachable satellite is a normal state and does not make the route fail."""
        from vocalis.runtime import gpu as rt_gpu
        from vocalis.runtime import satellites as rt_sat

        s = settings.load_app_settings()
        saved = [d for d in (s.get("devices") or []) if isinstance(d, dict) and d.get("id")]

        if request.method == "PUT":
            data = request.get_json(silent=True) or {}
            rows = data.get("devices")
            if not isinstance(rows, list):
                return jsonify({"error": "'devices' must be a list"}), 400
            # 🔴 LOAD, CHANGE AND SAVE UNDER `settings.APP_LOCK`, as `PUT /settings/app` does. This
            # route read the file at the top of the function and wrote the WHOLE file back here
            # with no lock, so a save that landed in between was undone: tick the "warn me if an
            # LLM is loaded" box while a device save was in flight and the box's new value was
            # overwritten with the old one. Seen 2026-10-12 with 40 copies of
            # llm_tick_warn_browser_spec.mjs at once: every check green, then the setting wrong
            # in the file. The snapshot above is for GET; the one that is written is read here.
            with settings.APP_LOCK:
                s = settings.load_app_settings()
                saved = [d for d in (s.get("devices") or []) if isinstance(d, dict) and d.get("id")]
                out, seen = [], set()
                for raw in rows:
                    if not isinstance(raw, dict):
                        return jsonify({"error": "each device must be an object"}), 400
                    dev = str(raw.get("id") or "").strip()
                    if not dev or dev in seen:
                        return jsonify({"error": f"device id missing or duplicated: {dev!r}"}), 400
                    seen.add(dev)
                    # A `workers` field on the incoming row is IGNORED, not rejected (5.4.1). One
                    # worker per device is a constant now; a stale browser tab still sending the
                    # old field must not have its save refused over it.
                    row = {"id": dev, "enabled": _b(raw, "enabled", False)}
                    # 7.6 §4.4 — the per-subsystem map, normalized on the WRITE path: unknown keys
                    # dropped, keys this device cannot run dropped, values coerced to bool.
                    #
                    # ⚠️ A STALE TAB SENDING NO `uses` MUST NOT NARROW ANYTHING, and it does not:
                    # `clean_uses` answers `{}` for a missing map and the key is then omitted
                    # entirely, which `subsystems.authorized` reads as "everything allowed". The
                    # alternative — treating absent as "all false" — would let a browser left open
                    # across the upgrade silently switch every subsystem off on the next save.
                    docker_mode = paths.docker_encrypted_mode()
                    uses = subsystems.clean_uses(raw.get("uses"), dev, docker_mode=docker_mode)
                    # October 10, 2026 (in-place switch design, item 6): the keys Docker does not
                    # offer (training, swap, comfyui) are carried over exactly as stored, so a save
                    # here cannot erase what the standalone install wrote into the same
                    # `app_settings.yaml`. Only offered keys are ever changed by this route.
                    kept = subsystems.preserved_uses(
                        next((d.get("uses") for d in saved if d["id"] == dev), None),
                        docker_mode=docker_mode)
                    if kept:
                        logger.info(f"devices: {dev} keeps stored uses not offered here: {kept} "
                                    f"(offered keys written: {sorted(uses)})")
                        uses = {**uses, **kept}
                    # Release audit 2026-10-11, item 3: the GET below stops offering Stems on a
                    # satellite that does not report lead-vocal readiness, so the browser then sends no
                    # `stems` key for it. A stored choice must survive that (the satellite may simply be
                    # asleep), exactly as the legacy keys above do.
                    if (isinstance(raw.get("uses"), dict) and "stems" not in raw["uses"]
                            and rt_sat.is_satellite_device(dev)):
                        stored_uses = next((d.get("uses") for d in saved if d["id"] == dev), None)
                        if isinstance(stored_uses, dict) and "stems" in stored_uses:
                            uses = {**uses, "stems": bool(stored_uses["stems"])}
                            logger.info(f"devices: {dev} keeps its stored stems choice "
                                        f"({bool(stored_uses['stems'])}); the page did not send one")
                    if uses:
                        row["uses"] = uses
                    out.append(row)
                # Every row may be unticked: this releases satellite VRAM without stopping its service and
# allows CPU fallback. Warn explicitly when a render falls back to CPU.

                if out and not any(d["enabled"] for d in out):
                    logger.warning("devices: every card is unticked — renders will fall back to "
                                   "this machine's CPU until one is ticked again")
                changed = out != saved
                s["devices"] = out
                # Remove the retired setting with the rows that used it. Leaving a stale value in
                # live configuration would imply that the unsupported setting still applies.
                s.pop("workers_per_card", None)
                settings.save_app_settings(s)
            # Same contract as the `gpus` write above, and it matters for
            # the same reason: current_pool() never rebuilds a resident pool, so without this
            # drop a device change is a silent no-op — the old pool keeps serving every render,
            # including Nomi and SillyTavern, while the panel says it applies to everything.
            # Idle -> drop now and release the VRAM. Mid-render -> saved, applies at the next
            # build; we do NOT yank replicas out from under an in-flight book.
            if changed and rt_pool.model_ready() and GPUS.acquire(timeout=0.1):
                try:
                    rt_pool.drop_pool()
                    logger.info("devices changed: pool dropped, VRAM released; "
                                "the next render loads on the new selection")
                finally:
                    GPUS.release()
            if changed:                              # noqa: SIM102  (read as one decision)
                # 🔴 The satellite's VRAM is released (or claimed) NOW, not at the next render.
                # Reconcile asynchronously: loading a replica can take several seconds, and an
                # unreachable satellite can consume the connection timeout. Saving settings
                # should not wait for either operation; the panel refreshes its status separately.
                sat_rows = [d for d in out if rt_sat.is_satellite_device(d["id"])]
                if sat_rows:                      # no satellite rows, nothing to reconcile
                    # A satellite performs rendering only, so either disabling the row or its
                    # render permission must remove it from the desired replica set.
                    want = _satellite_plan(sat_rows)
                    threading.Thread(target=_reconcile_satellites, args=(want,), daemon=True,
                                     name="satellite-reconcile").start()
                # Device authorization applies to future ACE work, and revoked local children
                # must also stop. Keep that shutdown off the settings request because it may wait
                # for a submitted render's child to exit.
                threading.Thread(target=_stop_unauthorized_acestep, daemon=True,
                                 name="acestep-reconcile").start()
            saved = out

        local = [{"id": f"cuda:{g['index']}", "label": str(g["name"]),
                  "satellite": None, "reachable": True, "loaded": None}
                 for g in rt_gpu.gpu_registry()]
        if not local:
            # Mirrors parse_devices('all'), which falls back to ['cpu'] on a box with no card —
            # the Windows dev box. Offering cpu alongside real cards would only invite a
            # pointlessly slow render, so it appears ONLY when there is nothing else.
            local = [{"id": "cpu", "label": "CPU — no CUDA device",
                      "satellite": None, "reachable": True, "loaded": None}]
        snap = rt_sat.snapshot([d["id"] for d in saved])
        # The word "satellite" belongs in the label, never in the ID. `test-satellite:cuda:0` is
        # load-bearing: it must not start with `cuda` (that is what makes WorkerPool skip
        # set_device, the act_headroom_gb fit check and empty_cache for a remote worker, with
        # no edit to that tuned code), and `split_device` cuts on the FIRST colon — so an id of
        # `satellite:test-satellite:cuda:0` would resolve to satellite "satellite" and break routing
        # everywhere. The label was previously just `r["device"]`, which rendered as
        # "test-satellite:cuda:0 — cuda:0": redundant, and it never said the card was remote.
        rows = local + [{"id": r["id"], "label": f"satellite {r['satellite']}",
                         "satellite": r["satellite"],
                         "reachable": r["reachable"],
                         # What that card is actually holding right now, so the row can say when
                         # it does not match the number beside it. Local cards carry None: this
                         # box's replicas are the pool's business and nothing here was lying
                         # about them.
                         "loaded": r.get("loaded")} for r in snap["devices"]]

        lv_ready_by_sat = {s.get("name"): bool(s.get("leadvocal_ready"))
                           for s in snap["satellites"]}
        merged = {d["id"]: d for d in rt_pool.migrate_device_settings([r["id"] for r in rows])}
        for r in rows:
            m = merged.get(r["id"]) or {}
            r["enabled"] = bool(m.get("enabled", False))
            # 7.6 §4.4 — the indented per-subsystem ticks.
            #
            # 🔴 `capable` AND `uses` ARE DIFFERENT FACTS AND THE PANEL RENDERS ONLY THE FIRST.
            # `capable` is what this device CAN run — a satellite is a Chatterbox render box and
            # nothing else, so it gets one checkbox, not five with four permanently dead. An
            # unticked box says "you could, but I said no", which for VoxCPM2 on a satellite is a
            # promise the server cannot keep; that shape is this codebase's most-repeated defect
            # and it is not being added on purpose.
            #
            # `uses` is what the user ALLOWED, and an absent key means allowed — so a row that
            # has never been narrowed sends `{}` and the browser ticks everything. That is the
            # whole migration: nothing is rewritten until a save.
            docker_mode = paths.docker_encrypted_mode()
            # A satellite is offered Stems only when ITS OWN health says it can take the
            # lead-vocal separation (release audit 2026-10-11, item 3); a local card is not asked.
            sat_name = r.get("satellite")
            lv_ready = (bool(lv_ready_by_sat.get(sat_name)) if sat_name else None)
            r["capable"] = subsystems.capable(r["id"], docker_mode=docker_mode,
                                              leadvocal_ready=lv_ready)
            if sat_name and "stems" not in r["capable"] and "stems" in subsystems.capable(
                    r["id"], docker_mode=docker_mode):
                # debug, not info: the Devices panel re-reads this every 10 s.
                logger.debug(f"devices: {r['id']} is not offered Stems: satellite {sat_name!r} "
                             f"does not report lead-vocal readiness")
            visible_keys = set(subsystems.keys_for_mode(docker_mode))
            r["uses"] = {key: value for key, value in (m.get("uses") or {}).items()
                          if key in visible_keys}
        # The registry travels WITH the rows rather than being hardcoded in devices.js. The
        # Labels are tab names, and
        # two copies of a tab name is how the panel starts naming a button that has been renamed.
        return jsonify({"devices": rows, "satellites": snap["satellites"],
                        "subsystems": [dict(s) for s in subsystems.rows_for_mode(
                            paths.docker_encrypted_mode())]})

    @bp.route("/logs/tail")
    def logs_tail():
        """Byte-cursored tail of the rolling server log, for the SillyTavern ▸ Logs
        sub-tab's live view. Stateless: the client hands back the `cursor` we return,
        so each poll ships only what's new. The first call (cursor < 0) returns the
        last ~64 KB so the panel lands populated instead of dumping the whole 10 MB
        file. Survives loguru's 10 MB rotation — when the file is shorter than the
        cursor it was rotated out from under us, so we restart from the fresh file's
        tail and flag `rotated` for the client to clear its view. Login-gated like
        every /… route that isn't /v1 or /speak.

        The file sink keeps ANSI color escapes when log_ansi_colors is on; we strip
        them so the browser gets clean text (the client colors lines by level). We
        only ever advance the cursor through a trailing newline, so a poll can never
        split a UTF-8 char or an escape sequence across two reads."""
        path = paths.LOG_DIR / "vocalis.log"
        TAIL = 64 * 1024
        try:
            size = path.stat().st_size
        except OSError:
            return jsonify({"text": "", "cursor": -1, "missing": True})
        try:
            cursor = int(request.args.get("cursor", "-1"))
        except (TypeError, ValueError):
            cursor = -1
        rotated = cursor > size                       # file shrank -> rotated/truncated
        fresh = cursor < 0 or rotated                 # (re)start from the tail
        base = max(0, size - TAIL) if fresh else cursor
        with open(path, "rb") as f:
            f.seek(base)
            if fresh and base > 0:
                f.readline()                          # drop the partial first line
                base = f.tell()
            data = f.read()
        nl = data.rfind(b"\n")                         # advance only through whole lines
        if nl < 0:
            return jsonify({"text": "", "cursor": base, "rotated": rotated})
        chunk = data[:nl + 1]
        text = _ANSI_RE.sub("", chunk.decode("utf-8", "replace"))
        return jsonify({"text": text, "cursor": base + len(chunk), "rotated": rotated})

    return bp
