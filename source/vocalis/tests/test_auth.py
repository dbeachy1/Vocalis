"""Authentication tests ensure missing or malformed administrator credentials fail closed. If loading credentials disables authentication, anonymous callers could reach protected routes and set a new administrator password; the tests pin that failure boundary."""
import os

import pytest
import yaml
from werkzeug.security import generate_password_hash

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import auth as rt_auth   # vault store + admin creds (5.1-P4.15)

PW = "hunter2"


@pytest.fixture
def creds(monkeypatch, tmp_path):
    """Point the server at a throwaway credentials file, then restore global auth state.

    ORDER IS LOAD-BEARING. Auth lives in module globals (_ADMIN_HASH, _CREDS_BROKEN,
    app.secret_key), which are process-wide, so a test that leaves them set breaks every
    later test in the run — 401 on everything. And a fixture's finalizer runs BEFORE the
    monkeypatch it depends on is undone, so calling _apply_admin_creds() here without
    undoing first would re-read the *tmp* file (often deliberately corrupt) and pin
    _CREDS_BROKEN=True globally. Undo the patch first, THEN reload from the real path."""
    f = tmp_path / "admin_credentials.yaml"
    monkeypatch.setattr(rt_auth, "ADMIN_CREDS_FILE", f)
    yield f
    monkeypatch.undo()               # restore the REAL creds path first...
    vs._apply_admin_creds()          # ...then reload from it, so globals end up clean


@pytest.fixture
def client():
    return vs.app.test_client()


def _write_valid(f, user="admin", pw=PW):
    f.write_text(yaml.safe_dump({"username": user, "password_hash": generate_password_hash(pw)}),
                 encoding="utf-8")


# ------------------------------------------------------- the three states

def test_absent_file_is_open_first_run(creds):
    """A MISSING file is the deliberate, documented 'open on the LAN' first-run state."""
    vs._apply_admin_creds()
    assert not rt_auth.auth_enabled()
    assert not rt_auth.creds_broken()


def test_valid_file_enables_auth(creds):
    _write_valid(creds)
    vs._apply_admin_creds()
    assert rt_auth.auth_enabled()
    assert not rt_auth.creds_broken()
    assert rt_auth.password_ok(PW)
    assert not rt_auth.password_ok("wrong")


@pytest.mark.parametrize("body,why", [
    ("username: admin\npassword_hash: [broken\n", "unparseable YAML"),
    ("just a bare string", "parses to a non-dict"),
    ("- a\n- list\n", "parses to a list"),
    ("", "empty file"),
    ("username: admin\n", "no password_hash key"),
    ("username: admin\npassword_hash: ''\n", "empty password_hash"),
])
def test_broken_file_fails_CLOSED_not_open(creds, body, why):
    """🔴 THE bug. Every one of these used to yield _ADMIN_HASH = "" => auth DISABLED.

    Two of them (non-dict, and missing password_hash) did it while logging NOTHING at all.
    """
    creds.write_text(body, encoding="utf-8")
    vs._apply_admin_creds()

    assert rt_auth.creds_broken(), why
    assert rt_auth.auth_enabled(), f"{why}: auth is OFF — the whole admin UI is unauthenticated"
    assert not rt_auth.password_ok(PW), f"{why}: a password opened a vault with no hash"
    assert not rt_auth.password_ok(""), why


def test_broken_file_locks_every_route(creds, client):
    """Fail-closed means UNSATISFIABLE, not merely 'gated': there is no hash, so no
    password — not even the real one — can get in until the file is fixed."""
    creds.write_text("password_hash: [broken\n", encoding="utf-8")
    vs._apply_admin_creds()

    assert client.get("/voices").status_code == 401
    assert client.post("/login", json={"username": "admin", "password": PW}).status_code == 401
    assert client.post("/login", json={"username": "admin", "password": ""}).status_code == 401


def test_broken_file_does_not_forge_a_session(creds, client):
    """`/` used to do `if not auth_enabled(): session["logged_in"] = True` — it did not skip
    the check, it GRANTED the cookie. A corrupt file must never reach that line."""
    creds.write_text("password_hash: [broken\n", encoding="utf-8")
    vs._apply_admin_creds()

    with client:
        client.get("/")
        from flask import session
        assert not session.get("logged_in"), "a corrupt credentials file forged an admin session"


def test_broken_file_does_not_expose_set_credentials(creds, client):
    """The takeover path: with auth 'off', an anonymous caller could POST a new admin
    password and own the box permanently."""
    creds.write_text("password_hash: [broken\n", encoding="utf-8")
    vs._apply_admin_creds()

    r = client.post("/admin/set-credentials", json={"username": "attacker", "password": "pwned"})
    assert r.status_code in (401, 403), "an anonymous caller could set the admin password"


# ------------------------------------------------------- the gate's redirect target

def test_an_unauthenticated_browser_navigation_redirects_to_the_login_page(creds, client):
    """The authentication gate must use the blueprint-qualified login endpoint when redirecting an unauthenticated browser navigation. A stale endpoint name raises BuildError and returns 500 instead of the login page; assert the redirect target as well as its status."""
    _write_valid(creds)
    vs._apply_admin_creds()

    r = client.get("/voices", headers={"Sec-Fetch-Mode": "navigate"})
    assert r.status_code == 302, "a browser navigation must be redirected, not 401'd"
    assert r.headers["Location"].endswith("/login"), \
        f"the gate redirected to {r.headers['Location']!r}, not the login page"


def test_the_gates_name_an_endpoint_that_actually_exists():
    """A guard on the guard, and on the OTHER gate too.

    The test above drives one of the two `url_for("…login_page")` sites through a request. This
    one asserts the name itself resolves, so a typo in either gate is caught without needing a
    request that reaches it — and it fails loudly if the blueprint is ever renamed."""
    with vs.app.test_request_context("/"):
        from flask import url_for
        assert url_for("vocalis_auth.login_page") == "/login"
    assert "vocalis_auth.login_page" in vs.app.view_functions, \
        "the auth blueprint is not registered under the name the before_request gates use"


@pytest.mark.parametrize("endpoint,path", [
    ("vocalis_auth.login_page", "/login"),   # named by BOTH before_request gates
    ("vocalis_ui.index", "/"),               # named by login_page's already-logged-in bounce
])
def test_every_endpoint_named_as_a_STRING_in_src_still_resolves(endpoint, path):
    """🔴 The refactor's one failure class that no AST audit can see.

    Registration qualifies endpoint names, so every route move can invalidate a `url_for` string
    — and a string is invisible to `test_no_undefined_names`, the writer census, the import graph
    and the route inventory alike. It has now happened twice, two phases apart, in two different
    modules: P4.16 moved `login_page` (breaking both `before_request` gates in `vocalis_server`)
    and P4.18 moved `index` (breaking `web/auth.py`, which that phase was not otherwise editing).

    These two are the endpoint-name strings that exist today, and each names a specific
    CONTRACT — which gate bounces where. `test_every_url_for_STRING_in_src_resolves` below
    covers the ones nobody has written yet."""
    with vs.app.test_request_context("/"):
        from flask import url_for
        assert url_for(endpoint) == path
    assert endpoint in vs.app.view_functions, f"{endpoint} is not registered"


def test_every_url_for_STRING_in_src_resolves():
    """🔴 5.1.1: the test above says *every* and is a hand-maintained list of TWO.

    Its justification — "these are the only endpoint-name strings in src/, grep is a four-line
    answer" — is a measurement of the day it was written, and the class it guards fired twice
    precisely because someone MOVED a route and a caller went stale. A third `url_for("…")`
    added anywhere in `src/` is uncovered by a parametrize list, and the failure it produces is
    a BuildError 500 where a redirect to the login page should be.

    So derive the list from the source instead of maintaining it: find every `url_for` call with
    a literal first argument and resolve it against the live url_map. The parametrized cases stay
    — they pin WHICH contract broke; this pins THAT one broke."""
    import ast

    sites = []
    for p in sorted((REPO_ROOT / "src").rglob("*.py")):
        if "__pycache__" in p.parts:
            continue
        for n in ast.walk(ast.parse(p.read_text(encoding="utf-8-sig"))):
            if (isinstance(n, ast.Call) and getattr(n.func, "id", None) == "url_for"
                    and n.args and isinstance(n.args[0], ast.Constant)
                    and isinstance(n.args[0].value, str)):
                sites.append((f"{p.relative_to(REPO_ROOT).as_posix()}:{n.lineno}",
                              n.args[0].value))

    assert sites, "the scan found no url_for strings at all -- it has stopped looking"
    bad = [(where, ep) for where, ep in sites if ep not in vs.app.view_functions]
    assert not bad, (
        f"these url_for() strings name endpoints that do not exist, so they raise BuildError "
        f"— a 500 where a redirect should be: {bad}")


# ------------------------------------------------------- the signing key

def test_secret_key_is_not_a_world_known_constant(creds):
    """With no hash, secret_key used to be sha256("vocalis-session::open") — a constant
    anyone with the source could derive, and forge a {"logged_in": true} cookie under."""
    import hashlib
    known = hashlib.sha256(b"vocalis-session::open").digest()

    vs._apply_admin_creds()                       # absent -> open
    assert vs.app.secret_key != known

    creds.write_text("password_hash: [broken\n", encoding="utf-8")
    vs._apply_admin_creds()                       # broken
    assert vs.app.secret_key != known


def test_secret_key_is_stable_when_configured_and_rotates_on_change(creds):
    """Sessions must survive a restart (same hash -> same key) but die on a password
    change (new hash -> new key)."""
    _write_valid(creds, pw="first")
    vs._apply_admin_creds()
    k1 = vs.app.secret_key
    vs._apply_admin_creds()
    assert vs.app.secret_key == k1, "a restart would log everyone out"

    _write_valid(creds, pw="second")
    vs._apply_admin_creds()
    assert vs.app.secret_key != k1, "an old session cookie survived a password change"


# ------------------------------------------------------- the writer

def test_write_admin_creds_is_atomic_and_never_world_readable(creds):
    """The writer manufactured the loader's trigger: a non-atomic write_text left a
    TRUNCATED yaml on a crash — exactly the input that used to disable auth."""
    rt_auth.write_admin_creds("admin", PW)

    assert creds.is_file()
    assert not list(creds.parent.glob("*.part")), "a .part file was orphaned"

    doc = yaml.safe_load(creds.read_text(encoding="utf-8"))
    assert doc["username"] == "admin"
    assert doc["password_hash"].startswith("scrypt:"), "docs said pbkdf2; werkzeug's default is scrypt"

    vs._apply_admin_creds()
    assert rt_auth.auth_enabled() and rt_auth.password_ok(PW)

    if os.name != "nt":                              # POSIX modes only
        assert creds.stat().st_mode & 0o077 == 0, "the hash is readable by other users"


def test_write_admin_creds_overwrite_keeps_file_valid(creds):
    rt_auth.write_admin_creds("admin", "old")
    rt_auth.write_admin_creds("admin", "new")
    vs._apply_admin_creds()
    assert rt_auth.password_ok("new")
    assert not rt_auth.password_ok("old")


# ------------------------------------------------------- CSRF: the SameSite floor

def test_session_cookie_is_samesite_lax(creds, client):
    """Use SameSite=Lax because only a small set of routes enforces explicit CSRF tokens, and CORS does not prevent simple cross-site requests from being sent. Lax preserves the session on top-level browser navigations that the login gate redirects; Strict would withhold it from those requests."""
    _write_valid(creds)
    vs._apply_admin_creds()

    r = client.post("/login", json={"username": "admin", "password": PW})
    assert r.status_code == 200, r.get_json()

    cookies = [v for k, v in r.headers if k.lower() == "set-cookie" and v.startswith("session=")]
    assert cookies, "POST /login set no session cookie"
    assert "SameSite=Lax" in cookies[0], (
        f"the session cookie has no SameSite attribute: {cookies[0].split('=', 1)[0]}... — "
        "cross-site POSTs will carry it on any browser that does not default to Lax "
        "(Firefox does not), which is a live CSRF against every unguarded mutating route")
    assert "HttpOnly" in cookies[0], "the session cookie lost HttpOnly"


def test_samesite_is_configured_not_incidental():
    """Belt and braces: assert the config key itself, so a future refactor that drops the
    line fails here loudly rather than only in the header assertion above."""
    assert vs.app.config.get("SESSION_COOKIE_SAMESITE") == "Lax"
