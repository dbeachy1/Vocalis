"""Owns `/login`, `/logout`, `/vault/*`, and `/admin/set-credentials` routes. Vault state and gate predicates live in `vocalis.runtime.auth`; keeping route handlers separate lets other route domains use the shared predicates without importing this blueprint."""
import secrets as _secrets

from flask import Blueprint, Response, jsonify, redirect, request, session, url_for
from loguru import logger

import vault_survey
import voice_utils
from tts_utils import VERSION
from vault import VaultAuthError, VaultLocked

from vocalis.runtime import auth
from vocalis.runtime import paths
from vocalis.runtime import settings


def _not_wired(what: str, passes: str):
    def boom(*_a, **_kw):
        raise RuntimeError(
            f"vocalis.web.auth.{what} was never wired: call create_auth_blueprint() before "
            f"anything can log in or change a password (vocalis_server passes {passes})")
    return boom


# 🔴 MODULE LEVEL, not closures over the factory arguments — `web/bulk.py`'s rule, and
# `web/kobold.py` is the worked example: a name a test replaces is a seam, and a seam cannot be
# a closure. Nothing stubs either of these today, but the shape is the one the package uses and
# a nested route CAN see them, which a factory-local name only accidentally survives.
apply_admin_creds = _not_wired("apply_admin_creds", "`_apply_admin_creds`")
store_startup_tasks = _not_wired("store_startup_tasks", "`lambda: run_store_startup_tasks()`")


def _migrate_kobold_password():
    """Move a KoboldCpp admin password out of app_settings.yaml and into the routed file.

    app_settings.yaml is deliberately NOT in the vault — it has to be readable before unlock —
    and its exemption was justified in the M0 sweep as "no user content". 4.7 put an admin
    password in it and that justification went stale without anyone noticing: the secret has
    been sitting in plaintext on disk ever since, and it CANNOT be fixed by encrypting the
    file, because then nothing could read the rest of it while locked. So the secret moves and
    the exemption becomes true again.

    Runs at unlock because that is the only moment the DEK exists. Idempotent, and it never
    overwrites: a password already in the routed file wins, and the plaintext copy is deleted
    either way — leaving it behind is the whole bug.
    """
    try:
        # Read, change and write under `settings.APP_LOCK` (2026-10-12): this writes the whole
        # file back, so without the lock it undid any save that landed in between.
        with settings.APP_LOCK:
            s = settings.load_app_settings()
            kob = s.get("kobold") if isinstance(s.get("kobold"), dict) else {}
            pw = str(kob.get("adminpassword") or "")
            if not pw:
                return
            sec = voice_utils.get_section(paths.VOICE_SETTINGS, "kobold")
            if not sec.get("adminpassword"):
                sec["adminpassword"] = pw
                voice_utils.replace_section(paths.VOICE_SETTINGS, "kobold", sec)
            s["kobold"].pop("adminpassword", None)
            settings.save_app_settings(s)
        logger.info("kobold: admin password migrated out of app_settings.yaml (plaintext) "
                    "and into the encrypted voice_settings.yaml")
    except Exception as exc:                                   # noqa: BLE001
        logger.warning(f"kobold admin password migration failed: {exc}")


def create_auth_blueprint(apply_creds, startup_tasks) -> Blueprint:
    """`apply_creds()` reloads admin_credentials.yaml and installs the derived session key on
    the Flask app; `startup_tasks()` runs the boot repairs that need the DEK.

    Both are stored as MODULE-level names rather than closed over — see the module docstring for
    why each is injected, and why one is passed as an object and the other as a lambda."""
    global apply_admin_creds, store_startup_tasks
    apply_admin_creds = apply_creds
    store_startup_tasks = startup_tasks
    bp = Blueprint("vocalis_auth", __name__)

    @bp.route("/setup", methods=["GET"])
    def setup_page():
        """Serve only the credential/vault bootstrap form, without the normal UI shell."""
        if not paths.docker_encrypted_mode():
            return redirect(url_for("vocalis_ui.index"))
        if auth.STORE.is_initialized() and auth.auth_enabled() and not auth.creds_broken():
            if session.get("logged_in") and auth.STORE.is_unlocked():
                return redirect(url_for("vocalis_ui.index"))
            return redirect(url_for("vocalis_auth.login_page"))
        session.setdefault("csrf", _secrets.token_urlsafe(32))
        if auth.STORE.is_initialized():
            mode = "recovery"
        elif auth.creds_broken():
            mode = "credentials-error"
        elif auth.auth_enabled():
            mode = "existing-credentials"
        else:
            mode = "fresh"
        html = ((paths.WEBUI / "setup.html").read_text(encoding="utf-8")
                .replace("{{CSRF}}", session["csrf"])
                .replace("{{MODE}}", mode))
        resp = Response(html, mimetype="text/html")
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.route("/login", methods=["GET"])
    def login_page():
        """Serve the login page (or bounce to the app if already in / auth is off).

        🔴 "ALREADY IN" MEANS AUTHENTICATED **AND** UNLOCKED. Those are two things now (design
        §5.1) and this bounce used to test only the first, which made a restart with a live
        session an infinite redirect: the cookie is permanent and survives the restart, the DEK
        is RAM and does not, so `/` hits `_require_unlocked` -> `/login`, and `/login` saw
        `logged_in` and sent it straight back to `/`. ERR_TOO_MANY_REDIRECTS, and NO way to
        reach the one page that could fix it.

        Authenticated-but-locked is precisely who needs this page: `login_submit` is the only
        caller of `unlock_with_password` in the process, so typing the password HERE is the only
        thing that re-unlocks. Bouncing them away removed the sole route back in.
        """
        if not auth.auth_enabled() or (session.get("logged_in") and not auth.vault_locked()):
            # 🔴 QUALIFIED (5.1-P4.18): `/` moved to `web/ui.py`, so this is `vocalis_ui.index`.
            # P4.16a's string trap, second instance — and the one place it bites is a visitor who
            # is ALREADY logged in, i.e. the happy path. Covered by test_m5_vault_state.py::
            # test_authenticated_but_LOCKED_can_still_REACH_the_login_page's closing assertion.
            return redirect(url_for("vocalis_ui.index"))
        # The edition tag, server-rendered because this page makes no /health call (the main UI unhides
        # its own copy from pollReady instead). Constant markup, no caller-supplied text, so there is
        # nothing here to escape. Discloses nothing new either: /health already answers `initialized`
        # to an unauthenticated caller by design, so that a client can tell "locked" from "down".
        edition = ('<div class="edition">Encrypted Edition</div>'
                   if auth.STORE.is_initialized() else "")
        # Only an encrypted install has a `wrap_recovery` to spend, so only it gets the link —
        # same server-side test, same reason, as the edition tag. Offering it on a plain install
        # would lead to a 409 and imply a way back in that does not exist there (no vault, no
        # recovery key: `set-admin-credentials.sh` is genuinely the answer on that box).
        recovery = ('<a href="#" id="forgotLink">Forgot your password?</a>'
                    if auth.STORE.is_initialized() else "")
        html = ((paths.WEBUI / "login.html").read_text(encoding="utf-8")
                .replace("{{VERSION}}", VERSION).replace("{{EDITION}}", edition)
                .replace("{{RECOVERY}}", recovery))
        if paths.docker_encrypted_mode():
            session.setdefault("csrf", _secrets.token_urlsafe(32))
            html = html.replace("</head>",
                                f'<meta name="csrf-token" content="{session["csrf"]}"></head>',
                                1)
        resp = Response(html, mimetype="text/html")
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.route("/login", methods=["POST"])
    def login_submit():
        """Authenticate AND unlock. One password, two uses (SPEC_5_0_M5 §4.1).

        This is the only place in the process that holds the plaintext password, so it is the
        only place that can do both: check it against the werkzeug hash in admin_credentials.yaml
        (authentication — a cookie that survives restarts) and run it through argon2id -> KEK ->
        unwrap the DEK (unlocking — RAM, which does not).
        """
        if not auth.auth_enabled():
            return jsonify({"ok": True})
        logger.info(f"login: POST /login from {request.remote_addr}")
        data = request.get_json(silent=True) or request.form
        user = str(data.get("username", "")).strip()
        pw   = str(data.get("password", ""))
        if not (_secrets.compare_digest(user, auth.ADMIN_USER) and auth.password_ok(pw)):
            # Which of the two was wrong is deliberately not said (and the username is not echoed —
            # a password typed into the username box would land in this log).
            logger.warning(f"login: REJECTED (bad username or password) from {request.remote_addr}")
            return jsonify({"error": "Wrong username or password."}), 401

        session["logged_in"] = True
        session.permanent = True                     # ~31-day cookie, survives restarts
        out = {"ok": True, "initialized": auth.STORE.is_initialized()}
        if auth.STORE.is_initialized():
            try:
                auth.STORE.unlock_with_password(pw)
            except VaultAuthError as exc:
                # BY NAME. The password satisfied the login hash but not the vault — the two have
                # drifted apart (a keyfile restored from a backup that does not match this store
                # will do exactly this, and so will a half-finished password change). Say so, and
                # FAIL CLOSED: authenticated, still locked. Nothing has been read or deleted.
                logger.error(f"login: correct password, but the vault refused to unlock: {exc}")
                return jsonify({"error": "vault_unlock_failed", "message": str(exc)}), 401
            logger.info(f"login: authenticated AND vault unlocked from {request.remote_addr} — issuing a SUK")
            out["suk"] = auth.STORE.issue_suk()           # -> the browser's sessionStorage (RAM only)
            _migrate_kobold_password()               # needs the DEK — this is the only moment it exists
            store_startup_tasks()                    # boot deferred these; the vault is open now
        return jsonify(out)

    @bp.route("/logout")
    def logout():
        """Log out and lock the vault. This is the only route that may evict an unlocked DEK, and it is open to GET requests without a session cookie, so the warning log records the caller fingerprint to diagnose unexpected locks."""
        logger.warning(f"logout: GET /logout from {request.remote_addr} — locking the vault "
                       f"(was unlocked: {auth.STORE.is_unlocked()}, "
                       f"referer={request.headers.get('Referer', '-')}, "
                       f"ua={str(request.headers.get('User-Agent', '-'))[:80]})")
        auth.STORE.lock()
        session.clear()
        return redirect(url_for("vocalis_auth.login_page"))

    # ── The vault routes ──────────────────────────────────────────────────────

    @bp.route("/vault/init", methods=["POST"])
    def vault_init():
        """First run: create the store under the CURRENT admin password.

        Returns the recovery key ONCE. It is never stored — only the wrap it produces is (design
        §4.5) — so a caller that does not write it down has lost it, and with it the only path
        back in if the password is ever forgotten. There is deliberately no reset script (§9.3).

        🔴 ITS POSTURE, STATED (m6 §7 / 7.0 review A.5): **lock-exempt but session-required.**
        `_require_unlocked` passes everything under `/vault/`, so a locked vault does not stop
        this route; `_require_login` does — unless the install has no admin password, in which
        case it stops nothing. So the populated-store refusal below guards against a logged-in
        user's footgun on a configured install, and a stranger's on a fresh one.
        `test_auth_surface.py` asserts both halves.
        """
        if not auth.csrf_ok():
            return jsonify({"error": "bad or missing CSRF token — reload the page and retry"}), 403
        if auth.auth_enabled() and not session.get("logged_in"):
            return jsonify({"error": "not authorized"}), 403
        if auth.STORE.is_initialized():
            return jsonify({"error": "the vault is already initialized"}), 409
        # 🔴 m6 §7 — REFUSE A STORE THAT ALREADY HOLDS PLAINTEXT DATA, exactly as
        # `vault_migrate._enable` refuses ("Vocalis does NOT migrate existing data into the
        # vault" — encryption is an install-time choice, made on an EMPTY store). This route
        # used to check only `is_initialized()`, so it could create a vault OVER live plaintext:
        # every subsequent routed read then dies with `VAULT AUTHENTICATION FAILED … not a vault
        # file (bad magic)` — a bricked install the CLI was specifically written to refuse. Not
        # data loss (the vault layer refuses loudly and touches nothing), but recovery is moving
        # files aside by hand. One shared definition of "empty" — `vault_survey`, read-only —
        # so this check and the CLI's cannot drift apart.
        existing = vault_survey.existing_plaintext_data(auth.STORE)
        if existing:
            logger.warning(f"vault init REFUSED — the store already holds {len(existing)} "
                           f"plaintext data file(s); Vocalis does not migrate data into a vault")
            return jsonify({
                "error": "store_not_empty",
                "message": f"This install already holds {len(existing)} data file(s), and "
                           "Vocalis does NOT migrate existing data into the vault — encryption "
                           "is chosen at install time, on an empty store. Back up your Vocalis "
                           "folder, clear the data and cache, then retry — or enable encryption "
                           "on a fresh install.",
            }), 409
        pw = str((request.get_json(silent=True) or {}).get("password", ""))
        if not auth.password_ok(pw):
            return jsonify({"error": "wrong password"}), 401
        recovery = auth.STORE.create(pw)
        store_startup_tasks()
        logger.warning("the vault has been INITIALIZED — the recovery key was shown once and is not stored")
        return jsonify({"ok": True, "recovery_key": recovery, "suk": auth.STORE.issue_suk()})

    @bp.route("/vault/unlock-suk", methods=["POST"])
    def vault_unlock_suk():
        """Reopen the vault after a restart using the SUK held in the browser's sessionStorage. The SUK is not stored on disk; a successful redemption issues a fresh SUK."""
        suk = str((request.get_json(silent=True) or {}).get("suk", ""))
        if not suk:
            return jsonify({"error": "no suk"}), 400
        try:
            auth.STORE.unlock_with_suk(suk)
        except VaultAuthError as exc:                # BY NAME — expired, revoked, or simply wrong
            logger.warning(f"suk: redemption REJECTED from {request.remote_addr} — {exc}")
            return jsonify({"error": "suk_rejected", "message": str(exc)}), 401
        logger.info(f"suk: redeemed from {request.remote_addr} — vault unlocked, fresh SUK issued")
        return jsonify({"ok": True, "suk": auth.STORE.issue_suk()})   # a fresh one; no reuse

    @bp.route("/vault/recover", methods=["POST"])
    def vault_recover():
        """The recovery key is the SINGLE path back in, under all circumstances (design §9.3).

        Auth-open by necessity: whoever needs this has forgotten the password. Possession of the
        key is the proof — and no TOTP is demanded here even once TOTP exists, because requiring a
        code would risk total lockout in exactly the emergency the key exists for.

        One action, both problems: it restores DATA access (unwraps the DEK) and ACCOUNT access
        (sets a new password). Losing the key means losing both. One rule, not two.
        """
        if paths.docker_encrypted_mode() and not auth.csrf_ok():
            return jsonify({"error": "bad or missing CSRF token — reload the page and retry"}), 403
        data = request.get_json(silent=True) or {}
        key  = str(data.get("recovery_key", "")).strip()
        new  = str(data.get("new_password", ""))
        if not key or not new or (paths.docker_encrypted_mode() and not new.strip()):
            return jsonify({"error": "recovery_key and new_password are required"}), 400
        if not auth.STORE.is_initialized():
            return jsonify({"error": "the vault is not initialized"}), 409
        try:
            auth.STORE.unlock_with_recovery(key)
        except VaultAuthError as exc:                # BY NAME
            logger.error("vault recovery REFUSED — the recovery key did not unwrap the DEK")
            return jsonify({"error": "recovery_rejected", "message": str(exc)}), 401
        # Both halves, or the user can unlock but not log in. See SPEC_5_0_M5 §4.4.
        auth.STORE.set_password_unlocked(new)
        auth.write_admin_creds(auth.ADMIN_USER, new)
        apply_admin_creds()
        session["logged_in"] = True
        session.permanent = True
        store_startup_tasks()
        logger.warning("the vault was RECOVERED with the recovery key and the password was reset")
        return jsonify({"ok": True, "suk": auth.STORE.issue_suk()})

    @bp.route("/vault/rotate-recovery", methods=["POST"])
    def vault_rotate_recovery():
        """Mint a NEW recovery key, revoking the old one. Returns it ONCE.

        The counterpart to `/vault/recover`: that one spends the key, this one replaces it. Before
        this route the key minted at `/vault/init` was permanent — no password change touched
        `wrap_recovery` — so a key that had gone astray stayed a live master key to the data with
        no way to revoke it.

        🔴 THE PASSWORD IS DEMANDED AGAIN, and this route is the reason the bar is not just "logged
        in". Every other gate here is satisfied by an open session, but the thing being minted is a
        PERMANENT credential that outlives the session, survives every future password change, and
        is shown exactly once. An unattended tab is enough to steal one silently otherwise. Same
        check `/vault/init` and `/admin/set-credentials` make, for the same reason.

        Requires the vault UNLOCKED — the DEK has to be in RAM to be rewrapped. A logged-in session
        against a freshly restarted process has not unlocked yet, and that is a 409, not a failure.
        """
        if not auth.csrf_ok():
            return jsonify({"error": "bad or missing CSRF token — reload the page and retry"}), 403
        if auth.auth_enabled() and not session.get("logged_in"):
            return jsonify({"error": "not authorized"}), 403
        if not auth.STORE.is_initialized():
            return jsonify({"error": "the vault is not initialized"}), 409
        pw = str((request.get_json(silent=True) or {}).get("password", ""))
        if not auth.password_ok(pw):
            logger.warning(f"recovery-key rotation REFUSED from {request.remote_addr} — wrong password")
            return jsonify({"error": "wrong password"}), 401
        try:
            recovery = auth.STORE.rotate_recovery()
        except VaultLocked as exc:                     # BY NAME — DEK not in RAM, nothing to rewrap
            return jsonify({"error": "vault_locked", "message": str(exc)}), 409
        logger.warning("the recovery key was ROTATED — the PREVIOUS key no longer unwraps the DEK "
                       "(older keyfile BACKUPS still answer to it)")
        return jsonify({"ok": True, "recovery_key": recovery})

    # There is deliberately NO "lock without logging out" route. The ONLY thing that evicts the DEK
    # is the Log out button (/logout). Vocalis never locks on its own — not on idle, not on a failed
    # re-unlock, not on anything else. Only the logout route may evict the DEK.


    @bp.route("/admin/set-credentials", methods=["POST"])
    def admin_set_credentials():
        """Set or clear the admin login from the settings gear. Requires the session's CSRF
        token, and — once a password exists — a logged-in session (on first-run the open page
        already granted one). Writes admin_credentials.yaml and reloads it live, no restart."""
        if not auth.csrf_ok():
            return jsonify({"error": "bad or missing CSRF token — reload the page and retry"}), 403
        if auth.auth_enabled() and not session.get("logged_in"):
            return jsonify({"error": "not authorized"}), 403
        data = request.get_json(silent=True) or {}
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        if paths.docker_encrypted_mode() and not password.strip():
            return jsonify({"error": "a nonblank password is required in Docker mode"}), 400
        if not password:                                   # blank password clears the login
            # 🔴 NOT WHILE A VAULT EXISTS — this is the same brick `vault_migrate._enable` refuses
            # to build, reached through a different door. `login_submit` is the ONLY caller of
            # `unlock_with_password` in the process, and it returns early when `auth_enabled()` is
            # False. So clearing the login on an encrypted install leaves: every route 401ing
            # "locked", /login redirecting away because auth is off, and the only way back in a
            # hand-written POST /vault/recover that BURNS THE RECOVERY KEY to undo a settings click.
            # One password, two uses (SPEC_5_0_M5 §4.1) — you cannot delete half of it.
            if auth.STORE.is_initialized():
                return jsonify({
                    "error": "vault_needs_login",
                    "message": "This install is encrypted, and the login password is also the vault "
                               "password — clearing the login would leave a vault nothing can unlock. "
                               "Change the password instead, or turn encryption off first.",
                }), 409
            try:
                auth.ADMIN_CREDS_FILE.unlink(missing_ok=True)
            except OSError as exc:
                return jsonify({"error": f"could not clear credentials: {exc}"}), 500
            apply_admin_creds()
            return jsonify({"ok": True, "auth": False})
        if not username:
            return jsonify({"error": "username is required"}), 400

        # ONE PASSWORD, TWO STORES (SPEC_5_0_M5 §4.1). The same secret authenticates (the werkzeug
        # hash) and unlocks (argon2id -> KEK -> the DEK). Change one without the other and the
        # halves drift: the user can log in but not unlock, or unlock but not log in. Re-wrap the DEK
        # FIRST — it is the one that can legitimately refuse (a wrong current password) — and only
        # write the new login hash once it has succeeded.
        if auth.STORE.is_initialized():
            old = str(data.get("current_password", ""))
            if not auth.password_ok(old):
                return jsonify({"error": "the current password is required to change it"}), 401
            try:
                auth.STORE.change_password(old, password)
            except VaultAuthError as exc:                  # BY NAME
                logger.error(f"password change REFUSED by the vault: {exc}")
                return jsonify({"error": "vault_rejected", "message": str(exc)}), 401
        try:
            auth.write_admin_creds(username, password)
        except OSError as exc:
            return jsonify({"error": f"could not write credentials: {exc}"}), 500
        apply_admin_creds()
        session["logged_in"] = True                        # keep this browser signed in under the new creds
        session.permanent = True
        out = {"ok": True, "auth": True}
        if auth.STORE.is_unlocked():
            out["suk"] = auth.STORE.issue_suk()                 # change_password dropped the old session wrap
        return jsonify(out)

    return bp
