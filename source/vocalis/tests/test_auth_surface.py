"""Classify every URL-map rule by method into exactly one access posture: explicitly open, capability URL, pairing bearer, or authenticated session. Cover both authentication-enabled and disabled states, the query-token event stream, CORS preflight/implicit HEAD methods, and every path converter so new routes cannot escape classification."""
from __future__ import annotations

import logging

import pytest
import yaml
from werkzeug.security import generate_password_hash

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import auth as rt_auth
from vocalis.runtime import paths
from wbedit import doorbell, pairing

PW = "surface-test-pw"

# ── The buckets ────────────────────────────────────────────────────────────────

#: The rules that must answer with NO credential of any kind, forever, each with its reason.
#: (`/login` is two Rule objects — GET and POST — not one; §2's item C.)
OPEN = {
    ("/health", "GET"):         "extension pre-flight: 'locked' must be tellable from 'down'",
    ("/login", "GET"):          "self-evidently",
    ("/login", "POST"):         "self-evidently",
    ("/logout", "GET"):         "self-evidently",
    ("/vault/recover", "POST"): "gating recovery behind the credential it replaces is circular",
}

#: ✅ **7.2-m4 CLOSED THE TWO THAT WERE THE HOLE.** `POST /speak` and `POST /speak/stream` now
#: demand the **Nomi** bearer (`pairing.NOMI`) and have moved to `NOMI_BEARER` below. This dict
#: did its job exactly as designed: it listed them by name so that closing them produced a
#: FAILING TEST rather than silence, and that is the failure that drove this edit.
#:
#: 🔴 **THE TWO THAT REMAIN ARE NOT AN UNFINISHED JOB.** `/speak/stream/<token>` and its
#: `/status` sibling carry a `uuid.uuid4().hex` minted by the (now gated) registering POST —
#: **122 bits of unguessable secret, in the path**. The URL *is* the capability. Adding a bearer
#: would buy nothing (the caller already proved possession of a secret nobody else can produce)
#: and would break the media fetch, which cannot attach an `Authorization` header the way the
#: registering POST can. m6 §2.2 says it in terms: *"the audio is a genuine unguessable
#: capability URL and is not the exposure here. Do not fix it."*
#:
#: ⚠️ Still EXACT in both directions: a fifth `/speak` rule is silently open unless listed, and
#: fails here by name.
SPEAK_OPEN = {
    ("/speak/stream/<token>", "GET"):          "122-bit capability URL — the token IS the credential",
    ("/speak/stream/<token>/status", "GET"):   "122-bit capability URL — the token IS the credential",
}

#: Require a Nomi bearer on these generation and pairing routes because POST can trigger speech and register unknown character names in account settings.
NOMI_BEARER = {
    ("/speak", "POST"):         "Nomi bearer (7.2-m4) — unlimited TTS + register_unknown writes",
    ("/speak/stream", "POST"):  "Nomi bearer (7.2-m4) — same, and it mints a capability URL",
    # 🔴 THE TEST BUTTON'S PROBE IS GATED TOO, AND THAT IS THE POINT OF IT. It reports whether
    # the address and token are right, so it has to traverse the same gate a real /speak does —
    # an ungated ping would answer "paired" about a credential the real call would reject.
    ("/speak/ping", "GET"):     "Nomi bearer (7.2-m4b) — the Options page's Test button",
}

#: Converter → a value that satisfies it. Trap 4: `_probe_path` refuses converters not listed
#: here rather than leaving a literal `<…>` in the URL.
_CONVERTER_VALUES = {
    None: "x", "string": "x", "path": "x", "int": "1", "float": "1.5",
    "uuid": "00000000-0000-0000-0000-000000000000",
}


def _probe_path(rule) -> str:
    """The rule's URL with EVERY placeholder substituted — or a loud failure naming the one
    this table cannot satisfy, instead of a 404 blaming the wrong thing."""
    path = str(rule.rule)
    for arg in rule.arguments:
        conv = rule._converters[arg].__class__.__name__.replace("Converter", "").lower()
        conv = {"unicode": "string", "integer": "int"}.get(conv, conv)
        value = _CONVERTER_VALUES.get(conv if conv != "string" else "string")
        assert value is not None, (
            f"{rule.rule}: no substitution for converter {conv!r} on <{arg}> — "
            f"add it to _CONVERTER_VALUES so the probe hits the real rule")
        # Both spellings: `<conv:name>` and `<name>`.
        for form in (f"<{conv}:{arg}>", f"<{arg}>"):
            path = path.replace(form, value)
        # `<converter(args):name>` — none exist today; catch the leftover below either way.
    assert "<" not in path, f"{rule.rule}: unsubstituted placeholder left in {path!r}"
    return path


def _methods(rule):
    """The methods worth probing. HEAD is werkzeug's own; OPTIONS is the CORS preflight and is
    DELIBERATELY credential-free (trap 3) — asserted in its own test, never probed here."""
    return sorted(rule.methods - {"HEAD", "OPTIONS"})


def _bucket(rule, method):
    key = (str(rule.rule), method)
    if key in OPEN:
        return "open"
    if key in SPEAK_OPEN:
        return "speak-open"
    if key in NOMI_BEARER:
        return "nomi-bearer"
    p = str(rule.rule)
    if p == "/speak" or p.startswith("/speak/"):
        return "speak-unlisted"          # a NEW /speak rule: fails by name below
    if p.startswith("/pair/"):
        return "pair-bearer"
    if p.startswith("/v1/"):
        return "v1-bearer"
    return "session"


def _rules():
    out = []
    for rule in vs.app.url_map.iter_rules():
        for m in _methods(rule):
            out.append((rule, m))
    return out


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture
def store_paths(tmp_path, monkeypatch):
    """A throwaway token store, exactly as `test_pair_surface` pins it — the /v1 gate reads the
    pairing token through the same seam."""
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    yield tmp_path


@pytest.fixture
def auth_on(store_paths, monkeypatch):
    """Auth ENABLED — an admin password exists. The fixture-order dance is `test_auth.py`'s:
    undo the creds patch BEFORE reloading, so the globals end up clean for later tests."""
    f = store_paths / "admin_credentials.yaml"
    f.write_text(yaml.safe_dump({"username": "admin",
                                 "password_hash": generate_password_hash(PW)}),
                 encoding="utf-8")
    monkeypatch.setattr(rt_auth, "ADMIN_CREDS_FILE", f)
    vs._apply_admin_creds()
    assert rt_auth.auth_enabled()
    yield
    monkeypatch.undo()
    vs._apply_admin_creds()


@pytest.fixture
def auth_off(store_paths, monkeypatch):
    """Auth DISABLED — no admin password. The documented first-run posture, not an accident."""
    monkeypatch.setattr(rt_auth, "ADMIN_CREDS_FILE", store_paths / "no_such_file.yaml")
    vs._apply_admin_creds()
    assert not rt_auth.auth_enabled()
    yield
    monkeypatch.undo()
    vs._apply_admin_creds()


@pytest.fixture
def client():
    with vs.app.test_client() as c:
        yield c


# ── The map itself ─────────────────────────────────────────────────────────────

def test_the_map_is_not_empty_and_the_knowingly_open_list_is_exact():
    """A surface test over zero routes passes and proves nothing. And the /speak family must
    match SPEAK_OPEN in BOTH directions: a fifth rule would be silently open, and a missing one
    means the family was gated — either way, this is the test that names it."""
    rules = _rules()
    assert len(rules) > 200, f"only {len(rules)} rules — is the app fully registered?"
    speak = {(str(r.rule), m) for r, m in rules
             if str(r.rule) == "/speak" or str(r.rule).startswith("/speak/")}
    # 🔴 THE WHOLE FAMILY, split across the two dicts. Checking only SPEAK_OPEN would let a new
    # `/speak` rule be "accounted for" by being quietly added to NOMI_BEARER without anyone
    # proving it actually refuses — the union is what makes both dicts exhaustive.
    assert speak == set(SPEAK_OPEN) | set(NOMI_BEARER), (
        f"the /speak family changed: "
        f"{sorted(speak.symmetric_difference(set(SPEAK_OPEN) | set(NOMI_BEARER)))} — "
        f"a new route is OPEN until it is listed: put it in NOMI_BEARER (and gate it) or in "
        f"SPEAK_OPEN with a reason it may answer anonymously")
    # ⚠️ Disjoint, or a route could claim both and the loop below would only test the first.
    assert not (set(SPEAK_OPEN) & set(NOMI_BEARER))


# ── Auth ON — the deployment §4.2 actually creates ─────────────────────────────

def test_with_auth_ON_every_rule_is_gated_or_named_open(auth_on, client):
    """🔴 THE ONE THAT MATTERS. Anonymous requests: gated buckets must refuse; open buckets must
    pass the login gate (checked at the GATE, not by executing handlers — an open POST /speak
    would render audio, and this test must not have side effects)."""
    for rule, method in _rules():
        path = _probe_path(rule)
        bucket = _bucket(rule, method)
        assert bucket != "speak-unlisted", (
            f"{method} {rule.rule} is a NEW /speak route and would ship OPEN — add it to "
            f"SPEAK_OPEN with a reason (and a decision), or gate it")
        if bucket in ("open", "speak-open"):
            with vs.app.test_request_context(path, method=method):
                assert vs._require_login() is None, (
                    f"{method} {rule.rule} is in the OPEN list but the gate refused it")
        elif bucket == "nomi-bearer":
            # 🔴 CHECKED AT THE GATE, not by executing the handler — an ungated POST /speak
            # would render audio and burn a GPU inside the test suite. `_require_login`
            # returning a response IS the refusal.
            with vs.app.test_request_context(path, method=method):
                got = vs._require_login()
            assert got is not None and got[1] == 401, (
                f"{method} {rule.rule} must demand the Nomi bearer and did not "
                f"(gate returned {got!r}) — 7.2-m4")
        elif bucket == "pair-bearer":
            r = client.open(path, method=method)
            assert r.status_code == 401, (
                f"{method} {rule.rule} answered {r.status_code} with no bearer")
        elif bucket == "v1-bearer":
            r = client.open(path, method=method)
            assert r.status_code == 401, (
                f"{method} {rule.rule} answered {r.status_code} with no bearer — "
                f"the m6 gate is not covering it")
            body = r.get_json()
            assert isinstance(body.get("error"), dict) and body["error"].get("message") \
                and body["error"].get("type"), (
                    f"{method} {rule.rule}: the 401 must be OpenAI's error shape "
                    f"(§3.3) — clients parse it; got {body!r}")
        else:
            r = client.open(path, method=method)
            assert r.status_code == 401, (
                f"{method} {rule.rule} answered {r.status_code} to an anonymous caller")


def test_with_auth_ON_a_valid_bearer_passes_the_v1_gate(auth_on, client):
    """The other half — a gate that refuses everything would pass the sweep above."""
    tok = pairing.rotate()
    with vs.app.test_request_context("/v1/audio/voices",
                                     headers={"Authorization": f"Bearer {tok}"}):
        assert vs._require_login() is None, "a valid bearer was refused"
    r = client.get("/v1/audio/voices", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code != 401, "a valid bearer 401'd through the full stack"
    # Same rules as /pair/*: bearer scheme only, and a wrong token is a 401 that says nothing
    # about WHICH way it failed (unpaired vs wrong tells an attacker whether to bother).
    for header in (tok, f"Basic {tok}", f"Token {tok}"):
        assert client.get("/v1/audio/voices",
                          headers={"Authorization": header}).status_code == 401
    wrong = client.get("/v1/audio/voices",
                       headers={"Authorization": "Bearer not-it"}).get_json()
    pairing.clear()
    unpaired = client.get("/v1/audio/voices",
                          headers={"Authorization": "Bearer not-it"}).get_json()
    assert wrong == unpaired


def test_pair_stream_takes_its_credential_in_the_query_string(auth_on, client, monkeypatch):
    """🔴 Trap 2, declared. `/pair/stream` reads `?token=` because `EventSource` cannot set
    headers. The accept case is proven WITHOUT consuming the infinite SSE stream: `subscribe`
    is stubbed to refuse, so passing the gate lands on the 503 — past `_check_pairing`, no
    generator to hang the test client on."""
    tok = pairing.rotate()
    assert client.get("/pair/stream").status_code == 401
    assert client.get("/pair/stream?token=wrong").status_code == 401
    monkeypatch.setattr(doorbell, "subscribe", lambda: None)
    r = client.get(f"/pair/stream?token={tok}")
    assert r.status_code == 503, (
        f"expected 503 (past the gate, refused by MAX_STREAMS), got {r.status_code} — "
        f"the query-string credential path is broken")


def test_a_locked_vault_answers_LOCKED_on_v1_never_token_rejected(auth_on, client, monkeypatch):
    """§3.4 — a locked vault cannot verify a token (the token lives IN the vault), so the auth
    gate defers to the lock gate and the answer is the flat LOCKED body — never the OpenAI-shape
    'pairing token required'. The extension distinguishes on exactly this: 'not paired' shown
    for a locked vault sends the user to Generate, which ROTATES a working credential."""
    monkeypatch.setattr(rt_auth, "vault_locked", lambda: True)
    for headers in ({}, {"Authorization": "Bearer some-token"}):
        r = client.post("/v1/audio/state", headers=headers, json={"items": []})
        assert r.status_code == 401
        assert r.get_json() == rt_auth.LOCKED_BODY, (
            f"a locked vault must answer the LOCKED body on /v1/*, got {r.get_json()!r}")


def test_OPTIONS_is_carved_out_for_the_cors_preflight(auth_on, client):
    """Trap 3, declared rather than inherited: a browser never sends credentials on a preflight,
    so demanding one would make the gated families unreachable cross-origin — which is where
    their only legitimate callers live."""
    for path in ("/v1/audio/state", "/pair/ping", "/wbedit/pairing"):
        r = client.open(path, method="OPTIONS")
        assert r.status_code != 401, f"OPTIONS {path} was refused ({r.status_code})"


def test_vault_init_is_lock_exempt_but_session_required(auth_on, client):
    """m6 §7's posture, both halves. Anonymous: refused by the LOGIN gate (401) — that is the
    'session-required' half, and it is all that stands between a stranger and §7's brick on an
    install WITH a password. The lock-exempt half is `_require_unlocked`'s `/vault/` carve-out,
    which is what makes first-run init reachable at all."""
    r = client.post("/vault/init", json={"password": "x"})
    assert r.status_code == 401


# ── Auth OFF — the documented first-run posture (trap 1) ───────────────────────

def test_with_auth_OFF_the_gate_stands_down_everywhere_and_that_is_the_posture(auth_off, client):
    """🔴 With no admin password, `_require_login` returns before reading the path, so EVERY
    rule — all 266, including /v1/* and /wbedit/* — answers anyone on the LAN. That is the
    deliberate, boot-warned, pre-2.x first-run posture, asserted here so it can never become
    true SILENTLY. It is also §4.2's claim 0 in the negative: the two-instance rig MUST set
    admin passwords, or every claim it tests is vacuously green against a gate that stands
    down. Checked at the gate (no handler side effects), plus one full-dispatch sentinel."""
    for rule, method in _rules():
        with vs.app.test_request_context(_probe_path(rule), method=method):
            assert vs._require_login() is None, (
                f"{method} {rule.rule}: the auth-off posture changed — if that is deliberate, "
                f"this docstring and the README's first-run story both need rewriting")
    # The sentinel, full-dispatch: the exact route A.1 was written about. 200 here is what
    # claim 0 exists to rule out on the §4.2 instances.
    r = client.get("/wbedit/pairing")
    assert r.status_code == 200 and r.get_json()["paired"] is False


# ── The line three modules away that keeps the token off disk ──────────────────

def test_the_access_log_is_pinned_at_ERROR_because_a_bearer_rides_in_a_url():
    """⚠️ `/pair/stream`'s token is in the query string, and the ONLY thing keeping it out of
    the log file is `vocalis_server.py` pinning werkzeug's logger to ERROR at import. Nothing
    else marks that line as security-relevant, so the day someone raises it to debug a request,
    the live bearer lands on disk in cleartext, outside the vault. If you need werkzeug's
    access log, scrub `token=` from it first — then update this test."""
    assert logging.getLogger("werkzeug").level == logging.ERROR
