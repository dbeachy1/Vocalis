"""Exercise `/speak` and `/speak/stream` with valid and invalid Nomi bearer tokens.

The pool is stubbed so requests test authorization without rendering audio. This complements the URL-map check by proving a valid token reaches the handler, not only that anonymous access is refused.
"""
import pytest

import vocalis_server as vs
from vocalis.runtime import nomi as rt_nomi
from vocalis.runtime import paths
from wbedit import pairing


@pytest.fixture
def paired(tmp_path, monkeypatch):
    """An unlocked install with a freshly minted Nomi token. Returns the token."""
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    # The module-level NOMI singleton was built at import with the REAL settings path, and a
    # request for an unknown Nomi (BODY's id "1") registers it there — so without this a full run
    # left `nomi: '1': name: Test` in source/vocalis/voice_settings.yaml. Patch the attribute on
    # the singleton rather than replacing it: /speak reads `rt_nomi.NOMI`, but the stream blueprint
    # captured the same object at app creation, so only the shared instance covers both routes.
    monkeypatch.setattr(rt_nomi.NOMI, "settings_yaml", paths.VOICE_SETTINGS)
    monkeypatch.setattr(rt_nomi.NOMI, "config", {})
    monkeypatch.setattr(rt_nomi.NOMI, "mtime", 0.0)
    # The gate consults the vault-locked predicate before it looks at the header — a locked vault
    # falls through to the LOCKED body, which is a different 401 and a different meaning.
    monkeypatch.setattr(vs.auth, "vault_locked", lambda: False)
    monkeypatch.setattr(vs.auth, "auth_enabled", lambda: True)
    return pairing.NOMI.rotate()


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


BODY = {"nomi_id": "1", "nomi_name": "Test", "text": "hello"}


@pytest.mark.parametrize("path", ["/speak", "/speak/stream"])
def test_no_header_is_refused(client, paired, path):
    r = client.post(path, json=BODY)
    assert r.status_code == 401, r.data[:200]


@pytest.mark.parametrize("path", ["/speak", "/speak/stream"])
def test_the_wrong_token_is_refused(client, paired, path):
    r = client.post(path, json=BODY, headers={"Authorization": "Bearer not-the-token"})
    assert r.status_code == 401


@pytest.mark.parametrize("path", ["/speak", "/speak/stream"])
def test_the_sillytavern_token_is_refused(client, paired, path):
    """SillyTavern and Nomi use separate bearer tokens; a valid token from one channel must not authorize the other.
    """
    st = pairing.ST.rotate()
    r = client.post(path, json=BODY, headers={"Authorization": f"Bearer {st}"})
    assert r.status_code == 401


@pytest.mark.parametrize("path", ["/speak", "/speak/stream"])
def test_a_malformed_scheme_is_refused(client, paired, path):
    """`Basic <token>` and a bare token both fail: the scheme is checked, not just the value."""
    for header in (f"Basic {paired}", paired, f"bearer{paired}"):
        r = client.post(path, json=BODY, headers={"Authorization": header})
        assert r.status_code == 401, header


@pytest.mark.parametrize("path", ["/speak", "/speak/stream"])
def test_the_right_token_passes_the_gate(client, paired, path, monkeypatch):
    """A valid Nomi token must pass the gate for every supported authorization-scheme casing. The stubbed pool may fail after the request reaches the handler.
    """
    for scheme in ("Bearer", "bearer", "BEARER"):
        r = client.post(path, json=BODY,
                        headers={"Authorization": f"{scheme} {paired}"})
        assert r.status_code != 401, (
            f"a VALID token was refused with {scheme!r} — the extension would be unable to "
            f"pair no matter what the user pasted ({r.data[:200]!r})")


def test_a_locked_vault_says_locked_not_unpaired(client, paired, monkeypatch):
    """A locked vault cannot verify the stored token. Preserve the distinct locked response so clients do not mistake it for an invalid pairing.
    """
    monkeypatch.setattr(vs.auth, "vault_locked", lambda: True)
    r = client.post("/speak", json=BODY, headers={"Authorization": f"Bearer {paired}"})
    assert r.status_code == 401
    assert b"lock" in r.data.lower(), r.data[:300]


# ── the Test button's probe (7.2-m4b) ────────────────────────────────────────

def test_the_ping_needs_the_token(client, paired):
    """If the probe answered without a credential it would report "paired" about a token the
    real `/speak` would reject — a Test button that lies is worse than none."""
    assert client.get("/speak/ping").status_code == 401
    assert client.get("/speak/ping",
                      headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_the_ping_accepts_the_nomi_token_and_says_nothing_else(client, paired):
    """The ping accepts a valid Nomi token and returns only the paired status, without exposing install details.
    """
    r = client.get("/speak/ping", headers={"Authorization": f"Bearer {paired}"})
    assert r.status_code == 200, r.data[:200]
    assert r.get_json() == {"paired": True}


def test_the_ping_survives_its_cors_preflight(client, paired):
    """The extension sends an `Authorization` header, so verify the preflight permits the ping route. Flask-CORS treats a literal path as an exact match; a regex such as `/speak.*` is needed to cover it.
    """
    r = client.options("/speak/ping", headers={
        "Origin": "chrome-extension://abcdefghijklmnop",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    })
    assert r.status_code < 400, r.status_code
    assert r.headers.get("Access-Control-Allow-Origin"), dict(r.headers)


def test_the_ping_refuses_the_sillytavern_token(client, paired):
    st = pairing.ST.rotate()
    assert client.get("/speak/ping",
                      headers={"Authorization": f"Bearer {st}"}).status_code == 401


def test_the_ping_renders_nothing(client, paired, monkeypatch):
    """The ping must not create audio, cache entries, or cards. Fail if it touches the speaker.
    """
    import vocalis.runtime.nomi as rt_nomi

    def _boom(*a, **k):                                  # pragma: no cover - must never run
        raise AssertionError("the ping touched the speaker")

    monkeypatch.setattr(rt_nomi.NOMI, "request_context", _boom, raising=False)
    r = client.get("/speak/ping", headers={"Authorization": f"Bearer {paired}"})
    assert r.status_code == 200


def test_the_capability_urls_do_not_demand_a_bearer():
    """Stream URLs carry an unguessable token and are fetched by media clients that cannot add a bearer header. Keep those capability routes open while excluding the POST and base stream routes.
    """
    assert vs._speak_is_capability_url("/speak/stream/abc123")
    assert vs._speak_is_capability_url("/speak/stream/abc123/status")
    # ⚠️ And the gated pair must NOT match it — an over-broad prefix here would silently reopen
    # the hole this milestone closed.
    assert not vs._speak_is_capability_url("/speak")
    assert not vs._speak_is_capability_url("/speak/stream")
