"""`create_app()` — the Phase 5 factory, and the three things it can break QUIETLY.

5.1-P5 moved ~470 lines of import-time app construction into one function. It changes no
behavior by design, which is exactly the problem: if the factory drops a step, almost nothing
else in the suite notices, because the rest of the suite asks about routes and this asks about
the app the routes are mounted on.

The three quiet ones, and each has a test below:

  * **The WSGI vault guard.** `VaultAuthError` subclasses BaseException, so Flask's
    `except Exception` never sees it and an `@app.errorhandler` for it is code that silently
    never runs. `_VaultAuthWSGI` wrapping `wsgi_app` is the only thing that catches it. Lose the
    wrap and a vault-auth failure becomes a dropped connection instead of a JSON 500.
  * **The CORS resource map.** flask-cors treats a pattern with NO regex characters as an
    EXACT-path match — which has bitten this project three times (`/health`, then
    `/speak/stream`'s preflight). Get it wrong and the Nomi extension and SillyTavern read as
    "server down" while every test that uses `test_client` keeps passing, because a test client
    sends no `Origin`. **So this is tested BEHAVIORALLY**, by sending one, rather than by
    asserting a dict: flask-cors does not expose its resource map on the app, and a dict
    assertion would not have caught the exact-vs-prefix bug anyway.
  * **`before_request` ordering.** It used to be implicit in the order the decorators appeared
    in the file. It is now three explicit calls, and swapping two of them is invisible except in
    the wording a locked-out user sees.
"""
import ast
import subprocess

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from flask import Flask


EXPECTED_BLUEPRINTS = {
    "vocalis_auth", "vocalis_books", "vocalis_bulk", "vocalis_cleanup", "vocalis_clips",
    "vocalis_comfyui", "vocalis_kobold", "vocalis_nomi", "vocalis_playground",
    # 8.0-m1b — `/acestep/*`, the music backends' unit control. Registered beside
    # `vocalis_comfyui` and shaped like it: both drive a neighboring systemd --user unit that
    # holds a card. The difference is that this one's units are gated by the ⚙ Settings ▸
    # Devices tick, because an ACE-Step backend is pinned to its card at unit start.
    "vocalis_acestep",
    "vocalis_speech", "vocalis_st", "vocalis_stems", "vocalis_stream", "vocalis_system",
    "vocalis_train", "vocalis_ui", "vocalis_voices", "vocalis_songs",
    # 9.5-m1 — `/llama/*`, llama.cpp's `llama-server`. Registered beside `vocalis_kobold`
    # because they are PEERS: two remote controls for two model hosts, shown as sibling
    # sub-tabs under one LLM tab. Neither blueprint imports the other, and the locality/TLS
    # policy they both need lives in `src/modelhost.py` rather than in either one — a second
    # copy of a locality policy is the failure `wbedit/backends/kobold_chat.py` names.
    # ⚠️ It is NOT modeled on `vocalis_acestep`/`vocalis_comfyui`: those drive a neighboring
    # systemd unit, and Vocalis never starts or stops llama-server. It only asks.
    "vocalis_llama",
    # 9.5-m3 - `/llm/holding`, the engine-agnostic "is anything on this box's cards" question.
    # A THIRD module that imports the other two rather than either importing the other: the
    # warning is about the CARDS, which do not care which process is holding them, so it cannot
    # live inside one engine's blueprint without that engine owning a question about its rival.
    "vocalis_llm",
    # 11.1 — LLM ▸ API (OpenRouter, Featherless) and `/llm/engine`, the editor's engine choice.
    "vocalis_llmapi",
    # 7.0 — the Character & Worldbook editor. Registered after `vocalis_kobold`, because a pass
    # resolves its transport to the model through that blueprint's `_kobold_cfg`.
    "vocalis_wbedit",
    # 7.0-m2p — `/pair/*`, the SillyTavern extension's channel. 🔴 A SEPARATE BLUEPRINT ON
    # PURPOSE: its bearer gate is a `before_request` on this object, so registering it is what
    # installs the gate. Folding these routes into `vocalis_wbedit` would put them behind the
    # session cookie the extension can never send, and folding the gate into `vocalis_wbedit`
    # would apply a bearer check to the tab's own routes. The two must not merge.
    "vocalis_pair",
    # 8.9 — `/folders/*`, the virtual folders over every listing. Its own blueprint because the
    # store spans TEN datasets owned by eight other blueprints; hanging the routes off any one of
    # them would make that one the owner of the other nine's filing. It injects nothing and reads
    # no config — `paths.FOLDERS` per request, so the suite's pin applies — which is why it is the
    # only `create_*_blueprint()` here that takes no argument at all.
    "vocalis_folders",
}


def test_the_module_level_app_is_a_real_flask_app_from_the_factory():
    assert isinstance(vs.app, Flask)
    assert callable(vs.create_app)


def test_the_wsgi_vault_guard_is_the_outermost_layer():
    """🔴 It cannot be an errorhandler — see the module docstring and `_VaultAuthWSGI`'s own."""
    assert isinstance(vs.app.wsgi_app, vs._VaultAuthWSGI), (
        "the VaultAuthError WSGI guard is gone — a vault-auth failure now escapes Flask "
        "entirely and the client gets a dropped connection instead of a 500")


def test_the_before_request_gates_run_in_the_documented_order():
    """Bootstrap, login, and vault gates run before the upload body-cap adjustment."""
    assert [f.__name__ for f in vs.app.before_request_funcs[None]] == [
        "_require_docker_bootstrap", "_require_login", "_require_unlocked",
        "_lift_body_cap_for_uploads"]


def test_the_vault_locked_errorhandler_is_registered():
    """VaultLocked IS an ordinary Exception, so unlike VaultAuthError a handler does fire —
    and it is what turns a mid-request lock into the same clean 401 the gate gives."""
    assert vs.VaultLocked in vs.app.error_handler_spec[None][None]


def test_every_blueprint_is_registered_exactly_once():
    assert set(vs.app.blueprints) == EXPECTED_BLUEPRINTS
    endpoints = [r.endpoint for r in vs.app.url_map.iter_rules()]
    dupes = {e for e in endpoints if endpoints.count(e) > 1}
    assert not dupes, f"registered twice: {sorted(dupes)}"


def test_excluded_execution_routes_are_not_registered():
    rules = {rule.rule for rule in vs.app.url_map.iter_rules()}
    assert not any(path.startswith(("/lora/", "/productions/", "/video/")) for path in rules)
    assert not {"/voiceswap/start", "/voiceswap/audition", "/voiceswap/library",
                "/voiceswap/voices", "/voices/rvc/import", "/train/start",
                "/train/trainings", "/train/jobs"} & rules


# ── CORS: behavioral, because the bug is exact-match-vs-prefix ──────────────

@pytest.mark.parametrize("path", ["/health", "/speak/stream", "/v1/audio/voices"])
def test_the_machine_endpoints_answer_cross_origin(path):
    """These three are called cross-origin by the Nomi extension and SillyTavern. `/health` is
    the exact-path one and `/speak/stream` is the prefix one — the two shapes that broke before.
    The status code is irrelevant (a locked box 401s, a GET on a POST route 405s); what matters
    is that flask-cors matched the resource and stamped the header."""
    r = vs.app.test_client().get(path, headers={"Origin": "https://probe.example"})
    assert r.headers.get("Access-Control-Allow-Origin") == "https://probe.example", (
        f"{path} lost its CORS resource — the browser will drop the response and the "
        f"extension will report the server as down")


def test_the_speak_preflight_is_answered():
    """The OPTIONS preflight specifically: this is the one that regressed when `/speak/stream`
    was written as a regex-free pattern and flask-cors read it as an exact path."""
    r = vs.app.test_client().options(
        "/speak/stream",
        headers={"Origin": "https://probe.example", "Access-Control-Request-Method": "POST"})
    assert r.status_code == 200
    assert r.headers.get("Access-Control-Allow-Origin") == "https://probe.example"


@pytest.mark.parametrize("path", ["/ui-state", "/settings/app", "/library"])
def test_the_mutating_ui_routes_are_NOT_cors_enabled(path):
    """The other direction, and it is a security property: an attacker's page must not be able
    to READ these responses. (It is not the CSRF defense — SESSION_COOKIE_SAMESITE is; see the
    long comment in create_app(). But losing it would still hand over the response bodies.)"""
    r = vs.app.test_client().get(path, headers={"Origin": "https://evil.example"})
    assert r.headers.get("Access-Control-Allow-Origin") is None, (
        f"{path} became CORS-enabled — an attacker page can now read its response body")


def test_session_cookie_samesite_is_lax():
    """THE CSRF defense for the ~100 mutating routes that carry no token check."""
    assert vs.app.config["SESSION_COOKIE_SAMESITE"] == "Lax"


def test_session_cookie_name_uses_legacy_default_when_unset(monkeypatch):
    monkeypatch.delenv("VOCALIS_SESSION_COOKIE_NAME", raising=False)
    app = Flask("cookie-default")
    vs._configure_session_cookie(app)
    assert app.config["SESSION_COOKIE_NAME"] == "session"


def test_session_cookie_name_is_configurable_for_an_instance(monkeypatch):
    monkeypatch.setenv("VOCALIS_SESSION_COOKIE_NAME", "vocalis-a1b2-session")
    app = Flask("cookie-instance")
    app.secret_key = "test-only"
    vs._configure_session_cookie(app)

    @app.get("/cookie")
    def issue_cookie():
        from flask import session

        session["authenticated"] = True
        return "ok"

    response = app.test_client().get("/cookie")
    assert response.status_code == 200
    assert any(value.startswith("vocalis-a1b2-session=") for key, value in response.headers if key.lower() == "set-cookie")


@pytest.mark.parametrize("name", ["", "bad;name", "has space", "x" * 65, "line\nbreak"])
def test_session_cookie_name_rejects_unsafe_values(monkeypatch, name):
    monkeypatch.setenv("VOCALIS_SESSION_COOKIE_NAME", name)
    with pytest.raises(ValueError, match="VOCALIS_SESSION_COOKIE_NAME"):
        vs._configure_session_cookie(Flask("cookie-invalid"))


# ── the factory is called exactly once, and that is load-bearing ─────────────

def _repo_py_files():
    """Every `.py` file this repository actually has — tracked, or untracked but not
    `.gitignore`d — never a bare `rglob` that walks into whatever happens to sit on disk.

    🔴 10.22 — A BARE `REPO_ROOT.rglob("*.py")` WALKED INTO NESTED GIT CHECKOUTS. `.codex/
    worktrees/*` holds seven nested worktree checkouts of THIS SAME REPO — gitignored
    (`.gitignore`'s `/.codex/` line), belonging to another tool, never touched from here — and
    each one still has its own `src/vocalis_server.py` calling `create_app()` once. A blind
    `rglob` skip-list of `{"venv", "__pycache__", ".git", "temp"}` has no entry for `.codex`, so
    it descended into all seven and counted eight call sites instead of one.

    `git ls-files --cached --others --exclude-standard` is the fix already established
    elsewhere in this suite for exactly this shape (`test_webui_types.py::_tracked_source_files`,
    written after `_tracked_source_files` itself learned this same lesson from `git ls-files`
    missing an unstaged file — the opposite direction of the same principle: scan what IS or
    WOULD BECOME part of the repository, never what merely sits on disk under it). A
    `.gitignore`d nested checkout is neither, so it is invisible to this listing by construction
    — no per-tool skip-list to keep in sync as new tools add new gitignored working copies.
    """
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    for line in listed.stdout.splitlines():
        line = line.strip()
        if not line.endswith(".py"):
            continue
        p = REPO_ROOT / line
        if p.is_file():
            yield p


def test_create_app_is_called_exactly_once_anywhere():
    """🔴 A SECOND CALL WOULD SILENTLY CORRUPT THE LIVE APP.

    Not for the reason recorded until 5.1.1, though. This docstring used to say a second call
    leaves `vs.STREAM_BP` aimed at a blueprint the live app does not serve from, so playground
    tokens would be minted into one registry and looked up in another. Measured: nothing outside
    `create_app()` ever read `vs.STREAM_BP` or `vs.ST_REGISTRY` — the blueprints take them as
    parameters — so that mechanism could not occur. Those three are locals now.

    The REAL coupling is that `web/auth.py` and `web/ui.py` keep their injected seams in MODULE
    globals (`global apply_admin_creds, store_startup_tasks` / `global kobold_secrets`), so
    building a second app repoints the FIRST app's auth and ui wiring at the second app's
    dependencies. Benign only because the two would be equivalent today.

    And it is still not isolation: the vault STORE is configured when `vocalis.runtime.auth` is
    imported, outside the factory, once per process. A fresh app is not a fresh world (§12.6).

    🔴 5.1.1 — THE SCAN WAS BLIND TWICE OVER. It read exactly `src/vocalis_server.py` despite
    being named `_in_src`, and it matched only a bare `create_app()` (`ast.Name`), so the
    realistic way this arrives — a test fixture writing `app = vs.create_app()` to get "a fresh
    app for isolation", which is the very temptation the docstring argues against — scored zero.
    Walk the whole repo and match the attribute form too."""
    calls = []
    for p in sorted(_repo_py_files()):
        try:
            tree = ast.parse(p.read_text(encoding="utf-8-sig"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for n in ast.walk(tree):
            if isinstance(n, ast.Call) and (getattr(n.func, "id", None) == "create_app"
                                            or getattr(n.func, "attr", None) == "create_app"):
                calls.append(f"{p.relative_to(REPO_ROOT).as_posix()}:{n.lineno}")

    assert len(calls) == 1, (
        f"create_app() is called at {calls} — read this test's docstring before adding another. "
        f"A second call, including `vs.create_app()` in a fixture, repoints the running app's "
        f"auth and ui seams at a different app's wiring.")
    assert calls[0].startswith("src/vocalis_server.py:"), \
        f"the one call moved out of vocalis_server: {calls[0]}"
