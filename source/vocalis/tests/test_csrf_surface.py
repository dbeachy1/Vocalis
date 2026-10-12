"""Which routes carry a CSRF token check — pinned as a SET, not described in prose.

> DOCKER EDITION (superseding the legacy text below, which is kept as history): `_csrf_ok()` guards
> exactly SIX routes. The legacy app guarded five; the SillyTavern extension settings route was already
> the fifth, and `/vault/recover` is the sixth - commit 70ffe7a made it CSRF-checked in Docker encrypted
> mode ONLY. The "must never be added" argument below is therefore superseded for that mode: the login
> page mints a session token before anyone is logged in and ships it in its `csrf-token` meta tag, so
> the check does not lock anyone out. The unencrypted path stays token-free; the last test in this
> file pins that the check is gated on `docker_encrypted_mode()`.

`_csrf_ok()` guards exactly four routes. That number is load-bearing in both directions and it
has been written down in at least five places (the CORS block, test_auth's docstring, the design,
the testing plan, two handoffs) while being *asserted* nowhere. Prose does not fail a build.

It was three until `/vault/rotate-recovery` (recovery-key rotation) arrived. That one is a
textbook member of the set rather than an exception to it — mutating, reachable from the settings
panel, authenticated by the session cookie — which is exactly why the fifth slot had to be
opened by editing this file rather than by the route quietly not being scanned.

**Adding a sixth is a real risk.** `/vault/recover` is the one that keeps getting proposed, and it
must never be added: it is auth-open BECAUSE the caller has forgotten the password, so it has no
session, so it can carry no token. Demanding one would make recovery impossible in exactly the
emergency the recovery key exists for — a lockout with no way back in. Possession of the key is
its proof. A well-meaning "harden the vault routes" commit that sweeps it in alongside
/vault/init is the plausible way this happens, and it would look like an
improvement in review.

**Removing one is the other direction**, and quieter: the ~100 other mutating routes are defended
only by SESSION_COOKIE_SAMESITE (c2a2623), so a route that silently loses its token check loses a
layer without anything going red.

The set is read out of the AST rather than by grepping, so a call site that moves, is renamed, or
gains a decorator is still seen.
"""
import ast

import pytest

from conftest import REPO_ROOT

SRC = REPO_ROOT / "src"


def _src_trees():
    """Every module under src/, parsed — recursively, not just `vocalis_server.py`.

    🔴 This was pinned to that one file until 5.1, which was correct while all 161 routes
    lived in it. The 5.1 refactor moves them into `src/vocalis/web/*.py`, and a scan still
    pinned to the old path would walk a shrinking facade, find zero `_csrf_ok` calls, and
    satisfy `set() == set(GUARDED)`... no — it would fail *that* one, loudly. What it would do
    quietly is satisfy every `path not in _routes_calling_csrf_ok()` assertion below, which is
    the half that certifies `/vault/recover` never gained a token check. An empty scan says
    that about every route in the product.
    """
    return [ast.parse(p.read_text(encoding="utf-8-sig"), filename=str(p))
            for p in sorted(SRC.rglob("*.py")) if "__pycache__" not in p.parts]

# The six (Docker edition; five in the legacy app). Each is a MUTATING route reachable from the browser
# UI with a session cookie.
GUARDED = {
    "/vault/init":           "creates the vault — a forged one would re-key the store",
    "/vault/rotate-recovery": "mints a NEW recovery key and revokes the old one — a forged one "
                              "would silently hand an attacker a permanent master credential, "
                              "and invalidate the recovery key retained by the account owner. It also re-demands the "
                              "password, which the token does not replace: the token proves the "
                              "request came from our page, the password proves who is at it.",
    "/admin/set-credentials": "changes the password AND re-wraps the vault key",
    "/ui-state":             "writes account-local UI state",
    "/settings/sillytavern-extension": "writes the encrypted extension settings",
    "/vault/recover":        "DOCKER ENCRYPTED MODE ONLY (70ffe7a): spends the recovery key and sets a new "
                             "password. The check is conditional on `docker_encrypted_mode()` (see the "
                             "last test). The login page supplies the token from its meta tag, so a "
                             "locked-out user is not blocked by it.",
}

# 🔴 Named explicitly so the reason travels with the test, not just the omission.
# Docker edition: `/vault/recover` MOVED to GUARDED above (70ffe7a). Its entry here, which said "a check
# here would make recovery impossible", is superseded: the login page hands the caller a token. The
# set stays, empty, because the parametrized test below is the standing guard for any future route
# that is auth-open BECAUSE the caller has no session at all.
MUST_STAY_OPEN: dict = {}


def _is_csrf_call(n):
    """A call to the CSRF check, under either spelling.

    🔴 5.1-P4.15 moved the function to `vocalis/runtime/auth.py` and renamed it `csrf_ok`, so
    every call site became `auth.csrf_ok()` — an ast.Attribute, not an ast.Name. A scan still
    matching only the bare name would have found ZERO call sites. Both assertions below would
    have gone red (which is why they exist), but the failure mode being defended against is the
    quiet one: `test_the_auth_open_routes_never_gain_a_token_check` is SATISFIED by an empty
    scan, and an empty scan certifies /vault/recover as token-free by knowing nothing at all.
    Match both spellings so the check survives the function moving again."""
    if not isinstance(n, ast.Call):
        return False
    f = n.func
    if isinstance(f, ast.Name):                       # csrf_ok(...) / _csrf_ok(...)
        return f.id in ("csrf_ok", "_csrf_ok")
    if isinstance(f, ast.Attribute):                  # auth.csrf_ok(...)
        return f.attr in ("csrf_ok", "_csrf_ok")
    return False


def _routes_calling_csrf_ok():
    """{route path: handler name} for every view whose body calls _csrf_ok()."""
    found = {}
    for tree in _src_trees():
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not any(_is_csrf_call(n) for n in ast.walk(node)):
                continue
            # `.route` matches @app.route and @bp.route alike, so a view keeps being seen
            # after it moves onto a blueprint.
            for dec in node.decorator_list:
                if (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                        and dec.func.attr == "route" and dec.args
                        and isinstance(dec.args[0], ast.Constant)):
                    found[dec.args[0].value] = node.name
    return found


def test_exactly_these_six_routes_check_a_csrf_token():
    """The whole assertion. A diff here is a deliberate security decision or a mistake —
    never a detail, and never something to 'just update the expected set' for."""
    assert set(_routes_calling_csrf_ok()) == set(GUARDED), (
        "the CSRF-guarded route set changed — read this test's docstring before touching it")


def test_the_auth_open_routes_never_gain_a_token_check():
    # A loop and not a parametrize: MUST_STAY_OPEN is empty in the Docker edition, and an empty
    # parameter set would be reported as a SKIPPED test, which reads like a check that went missing.
    guarded = _routes_calling_csrf_ok()
    for path, why in sorted(MUST_STAY_OPEN.items()):
        assert path not in guarded, f"{path} must stay token-free: {why}"


def test_vault_recover_checks_the_token_only_in_docker_encrypted_mode():
    """The check on `/vault/recover` must be GATED on `paths.docker_encrypted_mode()`, not
    unconditional: outside the encrypted Docker profile the route keeps the legacy token-free
    behavior (no session, no token), and an unconditional `csrf_ok()` there is the lockout the
    superseded legacy rule warned about."""
    def calls_encrypted_mode(test):
        return any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                   and n.func.attr == "docker_encrypted_mode" for n in ast.walk(test))

    gated = []
    for tree in _src_trees():
        for fn in ast.walk(tree):
            if not (isinstance(fn, ast.FunctionDef) and fn.name == "vault_recover"):
                continue
            for node in ast.walk(fn):
                if isinstance(node, ast.If) and calls_encrypted_mode(node.test) \
                        and any(_is_csrf_call(n) for n in ast.walk(node.test)):
                    gated.append(fn.name)
    assert gated == ["vault_recover"], (
        "/vault/recover must call csrf_ok() only inside an `if` that also tests "
        f"docker_encrypted_mode(); found gated handlers: {gated}")


def test_the_ast_scan_actually_finds_the_call_sites():
    """A guard on the guard. If `_csrf_ok` were renamed or the views restructured, the scan would
    return nothing and the set test would pass vacuously against an empty set — reporting perfect
    health for an app with no CSRF checks at all. Assert the helper still exists too."""
    # A LITERAL, deliberately not len(GUARDED): the point is a second, INDEPENDENT witness to
    # the number. Deriving it from the set above would let both move together in one careless
    # edit, which is the failure this guard-on-the-guard exists to catch.
    assert len(_routes_calling_csrf_ok()) == 6

    assert any(isinstance(n, ast.FunctionDef) and n.name in ("csrf_ok", "_csrf_ok")
               for tree in _src_trees() for n in ast.walk(tree)), \
        "the CSRF check is gone — if it was renamed again, this whole test file is now blind"
