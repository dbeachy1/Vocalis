"""Vocalis 5.0-M5 — the lock/unlock state machine and the 401 locked contract.

The ship gate from SPEC_5_0_M5 §8:

    restart -> LOCKED · SUK -> silent re-unlock · recovery key -> restores access ·
    wrong password -> fails CLOSED, and says so

The property that matters most here is the one design §5.1 calls the single most important
operational consequence of the whole project: `authenticated` and `unlocked` are now TWO
things. A session cookie survives a restart. A DEK does not. Nothing in RAM does.
"""
import importlib

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault
import vault_store
import vocalis_server as vs
from vocalis.runtime import auth as rt_auth   # vault store + admin creds (5.1-P4.15)
from vault import VaultAuthError

PW  = "correct horse battery staple"
NEW = "a different password entirely"

# argon2 at the production 256 MiB costs ~0.11 s per unlock; these tests unlock a lot.
TEST_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1}


@pytest.fixture
def vault_box(tmp_path, monkeypatch):
    """A server whose vault is initialized under PW, rooted in tmp_path, and LOCKED —
    exactly the state a fresh process is in after a restart."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    store = vault_store.VaultStore([("install", tmp_path / "store")], tmp_path / "vault_keys.yaml")
    recovery = store.create(PW)
    store.lock()                                   # a restart: the DEK does not survive it

    monkeypatch.setattr(rt_auth, "STORE", store)
    # M6: THE SEAMS DO NOT REACH THE STORE THROUGH `vs`. They call vault_store.route(), which
    # reads vault_store.STORE — so `rt_auth.STORE` and `vault_store.STORE` are two NAMES for what
    # production guarantees is one object (configure() sets the module global and hands the
    # server the same instance). Only a test can drive them apart, and one that patched just
    # `vs` would leave every seam routing to None: the vault would look live while quietly
    # reading and writing PLAINTEXT. Patch both, always.
    monkeypatch.setattr(vault_store, "STORE", store)
    monkeypatch.setattr(rt_auth, "ADMIN_USER", "admin")
    monkeypatch.setattr(rt_auth, "_ADMIN_HASH", vs.generate_password_hash(PW))
    monkeypatch.setattr(rt_auth, "_CREDS_BROKEN", False)
    monkeypatch.setattr(rt_auth, "ADMIN_CREDS_FILE", tmp_path / "admin_credentials.yaml")
    vs.app.secret_key = "test-key-not-derived-from-anything"
    vs.app.config["TESTING"] = True
    store.recovery_key = recovery
    return store


@pytest.fixture
def client(vault_box):
    with vs.app.test_client() as c:
        yield c


def _login(client, pw=PW):
    return client.post("/login", json={"username": "admin", "password": pw})


def _restart(monkeypatch, box):
    """A RESTART, modeled honestly: a brand-new process over the same keyfile and the same
    data. Nothing in RAM survives it — but `wrap_session` is on DISK, so the SUK still works.
    That gap IS the design (§5.1), and it is what the SUK exists to bridge.

    This is NOT `box.lock()`. An explicit lock/logout REVOKES the session wrap (design §5.4),
    so faking a restart with it would test the exact opposite of what the SUK is for — which
    is how the first draft of these tests managed to "prove" that silent re-unlock was broken.
    """
    fresh = vault_store.VaultStore(box.roots, box.keyfile)
    monkeypatch.setattr(rt_auth, "STORE", fresh)
    monkeypatch.setattr(vault_store, "STORE", fresh)   # both names — see the vault_box fixture
    return fresh


# ── the state machine ─────────────────────────────────────────────────────────

def test_a_fresh_process_is_locked(vault_box):
    """Boot is LOCKED. Cold. Always. There is no way around this that does not put a key
    on disk, and the accepted contract is that it is the feature, not the bug."""
    assert vault_box.is_initialized()
    assert not vault_box.is_unlocked()
    assert rt_auth.vault_locked()


def test_health_is_open_when_locked_and_says_so(client):
    """/health must NEVER 401 — it is the one thing a locked Vocalis still answers, and it
    is how the Nomi and SillyTavern extensions know to say "locked" instead of hammering a
    path that will never succeed. It is also how a still-open tab learns to re-send its SUK."""
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["locked"] is True
    assert r.get_json()["initialized"] is True


def test_login_authenticates_and_unlocks(client, vault_box):
    r = _login(client)
    assert r.status_code == 200
    assert vault_box.is_unlocked()
    assert r.get_json()["suk"]                      # minted for a silent re-unlock later
    assert client.get("/health").get_json()["locked"] is False


def test_wrong_password_fails_closed_and_says_so(client, vault_box):
    r = _login(client, "not the password")
    assert r.status_code == 401
    assert "Wrong username or password" in r.get_json()["error"]
    assert not vault_box.is_unlocked()             # still LOCKED. Fails closed.


def test_logout_locks_and_zeroes_the_dek(client, vault_box):
    _login(client)
    assert vault_box.is_unlocked()
    client.get("/logout")
    assert not vault_box.is_unlocked()             # the DEK is gone, not just the cookie


# ── the SUK: silent re-unlock across a restart (design §5.4) ──────────────────

def test_suk_re_unlocks_silently_after_a_restart(client, vault_box, monkeypatch):
    """Without this, every "Free all VRAM" and every deploy would kill Nomi and ST audio
    until the user logs in again."""
    suk = _login(client).get_json()["suk"]
    fresh = _restart(monkeypatch, vault_box)       # the restart: a cold process, no DEK
    assert rt_auth.vault_locked()

    r = client.post("/vault/unlock-suk", json={"suk": suk})
    assert r.status_code == 200
    assert fresh.is_unlocked()
    assert r.get_json()["suk"] != suk              # a FRESH one — no reuse


def test_a_garbage_suk_is_refused_and_leaves_it_locked(client, vault_box):
    _login(client)
    vault_box.lock()
    r = client.post("/vault/unlock-suk", json={"suk": "bm90IGEgcmVhbCBzdWsK"})
    assert r.status_code == 401
    assert not vault_box.is_unlocked()


def test_logout_revokes_the_suk(client, vault_box):
    """Close the browser -> the SUK is gone -> the password is required. Exactly right."""
    suk = _login(client).get_json()["suk"]
    client.get("/logout")                          # revokes wrap_session AND locks
    r = client.post("/vault/unlock-suk", json={"suk": suk})
    assert r.status_code == 401
    assert not vault_box.is_unlocked()


# ── recovery: the single path back in (design §9.3) ──────────────────────────

def test_the_recovery_key_restores_access_and_sets_a_new_password(client, vault_box):
    """One action, both problems: it restores DATA access (unwraps the DEK) and ACCOUNT
    access (sets a new password). Losing the key loses both. One rule, not two."""
    vault_box.lock()
    r = client.post("/vault/recover",
                    json={"recovery_key": vault_box.recovery_key, "new_password": NEW})
    assert r.status_code == 200
    assert vault_box.is_unlocked()

    # and BOTH halves moved: the new password now logs in AND unlocks.
    vault_box.lock()
    assert _login(client, NEW).status_code == 200
    assert vault_box.is_unlocked()


def test_recovery_is_reachable_without_a_session(client, vault_box):
    """Whoever needs this has FORGOTTEN the password, so a login is the one thing they
    cannot produce. The recovery key IS its authentication."""
    vault_box.lock()
    r = client.post("/vault/recover",
                    json={"recovery_key": vault_box.recovery_key, "new_password": NEW})
    assert r.status_code == 200                    # never logged in, and it still worked


def test_a_wrong_recovery_key_is_refused(client, vault_box):
    vault_box.lock()
    r = client.post("/vault/recover",
                    json={"recovery_key": "AAAAA-BBBBB-CCCCC-DDDDD", "new_password": NEW})
    assert r.status_code == 401
    assert not vault_box.is_unlocked()


def test_the_old_password_dies_with_the_recovery(client, vault_box):
    vault_box.lock()
    client.post("/vault/recover",
                json={"recovery_key": vault_box.recovery_key, "new_password": NEW})
    vault_box.lock()
    with pytest.raises(VaultAuthError):
        vault_box.unlock_with_password(PW)


# ── change password: ONE password, TWO stores ────────────────────────────────

def test_change_password_moves_BOTH_the_login_hash_and_the_dek_wrap(client, vault_box):
    """The same secret authenticates (werkzeug) and unlocks (argon2 -> KEK -> DEK). Move one
    without the other and the halves drift: the user can log in but not unlock, or unlock but not
    log in. This test fails if either half is forgotten."""
    _login(client)
    with client.session_transaction() as s:
        s["csrf"] = "tok"
    r = client.post("/admin/set-credentials",
                    json={"username": "admin", "password": NEW, "current_password": PW},
                    headers={"X-CSRF-Token": "tok"})
    assert r.status_code == 200

    vault_box.lock()
    vault_box.unlock_with_password(NEW)            # the DEK wrap moved
    assert vs.check_password_hash(rt_auth._ADMIN_HASH, NEW)   # and so did the login hash


def test_clearing_the_login_is_REFUSED_while_a_vault_exists(client, vault_box):
    """The same brick `vault_migrate._enable` refuses to build (c01e7f1), reached through the
    settings gear instead. `login_submit` is the only caller of `unlock_with_password`, and it
    returns early when auth is off — so an encrypted install with no login can never be
    unlocked, and the only way back in burns the recovery key to undo a settings click."""
    _login(client)
    with client.session_transaction() as s:
        s["csrf"] = "tok"

    r = client.post("/admin/set-credentials",
                    json={"username": "admin", "password": ""},      # blank == clear the login
                    headers={"X-CSRF-Token": "tok"})

    assert r.status_code == 409
    assert r.get_json()["error"] == "vault_needs_login"
    assert rt_auth.auth_enabled(), "the login was cleared anyway — the vault is now unopenable"
    vault_box.lock()
    vault_box.unlock_with_password(PW)                # and the vault still opens with it


def test_change_password_needs_the_current_one(client, vault_box):
    _login(client)
    with client.session_transaction() as s:
        s["csrf"] = "tok"
    r = client.post("/admin/set-credentials",
                    json={"username": "admin", "password": NEW, "current_password": "wrong"},
                    headers={"X-CSRF-Token": "tok"})
    assert r.status_code == 401
    vault_box.lock()
    vault_box.unlock_with_password(PW)             # unchanged — the refusal changed nothing


def test_authenticated_but_LOCKED_can_still_REACH_the_login_page(client, vault_box):
    """An authenticated session cookie can survive a restart while the in-memory data-encryption key does not. A locked session must reach the login page to unlock, rather than redirecting between the app and login."""
    _login(client)                                 # authenticated AND unlocked
    vault_box.lock()                               # the restart: cookie lives, DEK doesn't

    r = client.get("/login", headers={"Sec-Fetch-Mode": "navigate"})
    assert r.status_code == 200, "the login page bounced a locked session — this is the loop"

    r = client.get("/", headers={"Sec-Fetch-Mode": "navigate"})
    assert r.status_code == 302 and "/login" in r.headers["Location"]

    # and typing the password there really is the way out
    assert _login(client).status_code == 200
    r = client.get("/login", headers={"Sec-Fetch-Mode": "navigate"})
    assert r.status_code == 302, "unlocked now — the bounce to the app should be back"
    assert "/login" not in r.headers["Location"]


def test_renaming_the_admin_retires_the_old_username_and_keeps_the_vault(client, vault_box):
    """The username is the ONE field of this form nothing asserted on: every other
    set-credentials test posts `username: "admin"` and changes only the password, so "the
    settings gear can rename the account" was believed, never shown.

    A rename cannot travel alone — a blank password means "clear the login", which a vault
    refuses (409, above), so renaming means re-submitting the SAME password and thus re-wrapping
    the DEK under it. That is harmless by design but it is not a no-op: it rewrites the salt,
    the verifier and the wrap. So the rename has to leave BOTH halves working, not just the
    half it was aiming at.
    """
    _login(client)
    with client.session_transaction() as s:
        s["csrf"] = "tok"

    r = client.post("/admin/set-credentials",
                    json={"username": 'test-admin', "password": PW, "current_password": PW},
                    headers={"X-CSRF-Token": "tok"})
    assert r.status_code == 200

    assert rt_auth.ADMIN_USER == 'test-admin'                 # reloaded live, no restart
    assert _login(client).status_code == 401, "the retired username still logs in"
    assert client.post("/login", json={"username": 'test-admin', "password": PW}).status_code == 200

    vault_box.lock()
    vault_box.unlock_with_password(PW)             # the password's half did not move with it


# ── the 401 locked contract (design §5.3) ────────────────────────────────────

@pytest.mark.parametrize("path,method", [
    ("/speak", "POST"),                            # Nomi — OPEN today
    ("/v1/audio/speech", "POST"),                  # SillyTavern — OPEN today
    ("/v1/audio/voices", "GET"),                   # the voice-list metadata leak
])
def test_the_machine_endpoints_401_when_locked(client, path, method):
    """THE deliberate behavioral change. A locked Vocalis serves NO audio to ANYONE.

    It also closes three holes that have nothing to do with encryption: the {cached:...}
    confirmation oracle, the voice-list / ST-character metadata leaks, and the generation
    oracle (anyone on the LAN could burn the R9700s and make the cloned voice say anything).
    """
    r = client.open(path, method=method, json={"text": "hello"})
    assert r.status_code == 401
    assert r.get_json()["error"] == "locked"


def test_the_locked_gate_lifts_once_unlocked(client, vault_box):
    """⚠️ Since 7.0-m6 `/v1/*` ALSO demands the pairing bearer, so 'not 401' needs a token —
    minted through the session-gated admin route, exactly as a real user pairs. LOCKED, the
    auth gate defers (the token lives IN the vault and cannot be verified), so the first 401
    is the lock gate's; unlocked WITH the bearer, both gates pass, which is precisely 'the
    locked gate lifted'."""
    assert client.get("/v1/audio/voices").status_code == 401
    _login(client)
    tok = client.post("/wbedit/pairing/rotate").get_json()["token"]
    assert client.get("/v1/audio/voices",
                      headers={"Authorization": f"Bearer {tok}"}).status_code != 401


def test_an_authenticated_session_is_still_locked_after_a_restart(client, vault_box, monkeypatch):
    """The whole of design §5.1 in one test. The cookie survives; the DEK does not."""
    _login(client)
    _restart(monkeypatch, vault_box)               # RAM is gone. The cookie is not.
    r = client.get("/v1/audio/voices")             # still authenticated...
    assert r.status_code == 401                    # ...and still refused, because it is LOCKED
    assert r.get_json()["error"] == "locked"


# ── dev unlock (design §5.5) ─────────────────────────────────────────────────

def test_dev_passphrase_unlocks_at_boot_and_health_says_so(vault_box, monkeypatch):
    """Not a bypass, not a second key, not a weaker code path: it runs the identical
    argon2id -> KEK -> unwrap that a login runs. It is LOUD, and it says so on /health."""
    monkeypatch.setenv(vault_store.DEV_ENV, PW)
    assert vault_box.dev_unlock() is True
    assert vault_box.is_unlocked()
    with vs.app.test_client() as c:
        assert c.get("/health").get_json()["dev_unlock"] is True


def test_a_wrong_dev_passphrase_raises_and_stays_locked(vault_box, monkeypatch):
    monkeypatch.setenv(vault_store.DEV_ENV, "not the password")
    with pytest.raises(VaultAuthError):
        vault_box.dev_unlock()
    assert not vault_box.is_unlocked()             # fails CLOSED, loudly


def test_no_dev_passphrase_means_no_dev_unlock(vault_box, monkeypatch):
    monkeypatch.delenv(vault_store.DEV_ENV, raising=False)
    assert vault_box.dev_unlock() is False
    assert not vault_box.is_unlocked()


# ── the gate is INERT until the vault exists ─────────────────────────────────

def test_an_uninitialized_vault_locks_nothing(tmp_path, monkeypatch):
    """5.0 has to be able to land on a box that has not migrated yet. An uninitialized vault
    holds no key and guards no ciphertext, so there is nothing to lock — and the 782 tests
    that predate M5 must keep passing, which they only do because of this."""
    store = vault_store.VaultStore([("install", tmp_path / "store")], tmp_path / "vault_keys.yaml")
    monkeypatch.setattr(rt_auth, "STORE", store)
    assert not store.is_initialized()
    assert not rt_auth.vault_locked()
    with vs.app.test_client() as c:
        assert c.get("/health").get_json()["locked"] is False


# ── the sentinel still guards the backup-restore disaster (M1 §5.4) ──────────

def test_a_keyfile_from_another_store_still_refuses_to_unlock(tmp_path, monkeypatch):
    """The disaster the sentinel exists for: a vault_keys.yaml restored from a backup that
    does not match THIS data store gives a correct password, a valid unwrap, and the WRONG
    DEK. Every file then looks corrupt — and six modules used to answer that by deleting it.

    M5 must not have broken this, so: prove it through the STORE, not just through Vault."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    a = vault_store.VaultStore([("install", tmp_path / "a")], tmp_path / "keys_a.yaml")
    a.create(PW)
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "real_data.mp3").write_bytes(b"Test User's only copy")

    # b's data, a's keyfile: right password, valid wrap, wrong DEK.
    b = vault_store.VaultStore([("install", tmp_path / "b")], tmp_path / "keys_a.yaml")
    with pytest.raises(VaultAuthError):
        b.unlock_with_password(PW)
    assert not b.is_unlocked()                     # refused to open rather than hand out a bad key
    assert (tmp_path / "b" / "real_data.mp3").read_bytes() == b"Test User's only copy"


# ── /vault/rotate-recovery: minting a NEW key while logged in ────────────────
#
# Driven at the ROUTE, not just the store. TESTING_PLAN_5_0 §685 records that /vault/recover
# shipped with store-level coverage only and a route-level hole; this is the same feature's
# other half, so it gets the gate the first one didn't.

def _csrf(client):
    with client.session_transaction() as s:
        s["csrf"] = "tok"
    return {"X-CSRF-Token": "tok"}


def test_rotate_recovery_mints_a_new_key_and_kills_the_old(client, vault_box):
    vault_box.unlock_with_password(PW)             # logged in ⇒ unlocked, as in production
    _login(client)
    old = vault_box.recovery_key

    r = client.post("/vault/rotate-recovery", json={"password": PW}, headers=_csrf(client))
    assert r.status_code == 200
    new = r.get_json()["recovery_key"]
    assert new and new != old

    vault_box.lock()
    with pytest.raises(VaultAuthError):
        vault_box.unlock_with_recovery(old)
    vault_box.unlock_with_recovery(new)             # the new one is live


def test_rotate_recovery_demands_the_password_again(client, vault_box):
    """🔴 A logged-in session is NOT enough. The thing being minted is a permanent credential
    that outlives the session and survives every future password change — an unattended tab
    must not be able to mint one silently."""
    vault_box.unlock_with_password(PW)
    _login(client)
    old = vault_box.recovery_key

    r = client.post("/vault/rotate-recovery", json={"password": "not the password"},
                    headers=_csrf(client))
    assert r.status_code == 401

    vault_box.lock()
    vault_box.unlock_with_recovery(old)             # untouched by the refused call


def test_rotate_recovery_needs_a_login(client, vault_box):
    """401, not the route's own 403: `/vault/rotate-recovery` is NOT in `_OPEN_PATHS`, so the
    app-level `_require_login` gate turns an unauthenticated caller away before the route runs
    at all. The in-route check stays as the second lock — it is what answers if the path is ever
    added to that set, the way `/vault/recover` is."""
    vault_box.unlock_with_password(PW)
    r = client.post("/vault/rotate-recovery", json={"password": PW}, headers=_csrf(client))
    assert r.status_code == 401


def test_rotate_recovery_needs_csrf(client, vault_box):
    vault_box.unlock_with_password(PW)
    _login(client)
    r = client.post("/vault/rotate-recovery", json={"password": PW})   # no token
    assert r.status_code == 403


def test_rotate_recovery_on_a_locked_vault_is_a_409(client, vault_box, monkeypatch):
    """Authenticated but LOCKED is a real state (design §5.1): the cookie survives a restart,
    the DEK does not. There is no DEK to rewrap, and that is not a crash.

    It has to be modeled with `_restart`, NOT by skipping the login — logging in is what
    unlocks the vault, so `_login` alone can never produce this state. And the route really is
    reachable here: `_require_unlocked` exempts everything under `/vault/`, so the 409 comes
    from the route rather than from the locked gate's 401."""
    _login(client)                                  # a cookie that will outlive the process
    _restart(monkeypatch, vault_box)                # fresh store, nothing in RAM
    r = client.post("/vault/rotate-recovery", json={"password": PW}, headers=_csrf(client))
    assert r.status_code == 409
    assert r.get_json()["error"] == "vault_locked"
