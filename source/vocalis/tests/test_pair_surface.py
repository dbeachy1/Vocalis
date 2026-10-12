"""Walk the live URL map and require every `/pair/*` route to pass the pairing-token gate.

These cross-origin extension routes cannot rely on the session cookie, so the blueprint-level `before_request` check is their authorization boundary. Enumerating the registered routes ensures new endpoints inherit the guard.
"""
from __future__ import annotations

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import paths
from vocalis.web.pair import PREFIX
from wbedit import pairing


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


def _pair_rules():
    """Every rule under the prefix, with the methods worth probing (HEAD/OPTIONS are Werkzeug's
    own and OPTIONS is deliberately let through for the CORS preflight)."""
    out = []
    for rule in vs.app.url_map.iter_rules():
        if not str(rule.rule).startswith(PREFIX + "/"):
            continue
        for m in sorted(rule.methods - {"HEAD", "OPTIONS"}):
            out.append((str(rule.rule), m))
    return out


def test_the_family_is_not_empty():
    """A surface test over zero routes passes and proves nothing — the same failure mode
    `test_csrf_surface` records for a scan pinned at a path that stopped holding routes."""
    assert _pair_rules(), "no /pair/* routes found — is the blueprint registered?"


def test_every_pair_route_refuses_a_request_with_no_token(client):
    """Check every registered pairing route so new routes are covered by the bearer-token gate.
    """
    pairing.rotate()                    # a paired install — the refusal must not depend on that
    for path, method in _pair_rules():
        r = client.open(path.replace("<doc_id>", "x"), method=method)
        assert r.status_code == 401, f"{method} {path} answered {r.status_code} with no token"


def test_every_pair_route_refuses_a_wrong_token(client):
    pairing.rotate()
    bad = {"Authorization": "Bearer not-the-token"}
    for path, method in _pair_rules():
        r = client.open(path.replace("<doc_id>", "x"), method=method, headers=bad)
        assert r.status_code == 401, f"{method} {path} accepted a wrong token"


def test_every_pair_route_refuses_when_NOTHING_is_paired(client):
    """An unpaired install must reject requests even when the caller supplies an arbitrary bearer value.
    """
    for path, method in _pair_rules():
        r = client.open(path.replace("<doc_id>", "x"), method=method,
                        headers={"Authorization": "Bearer anything"})
        assert r.status_code == 401, f"{method} {path} answered on an UNPAIRED install"


def test_a_correct_token_gets_through(client):
    """The other half — a gate that refuses everything is also wrong, and would pass every
    assertion above."""
    tok = pairing.rotate()
    r = client.get("/pair/ping", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200 and r.get_json()["paired"] is True


def test_the_scheme_must_be_bearer(client):
    tok = pairing.rotate()
    for header in (tok, f"Basic {tok}", f"Token {tok}", f"bearer{tok}"):
        r = client.get("/pair/ping", headers={"Authorization": header})
        assert r.status_code == 401, f"accepted {header!r}"
    # …and the spelling of the scheme itself is not case-sensitive, per RFC 7235.
    assert client.get("/pair/ping", headers={"Authorization": f"BEARER {tok}"}).status_code == 200


def test_a_401_says_nothing_about_which_way_it_failed(client):
    """Telling an unauthenticated caller whether the install is unpaired or merely presented the
    wrong token tells it whether the install is worth attacking."""
    unpaired = client.get("/pair/ping", headers={"Authorization": "Bearer x"}).get_json()
    pairing.rotate()
    wrong = client.get("/pair/ping", headers={"Authorization": "Bearer x"}).get_json()
    assert unpaired == wrong


def test_the_admin_side_round_trips_and_never_caches_the_secret(client):
    """Verify the admin view reports pairing state, rotates tokens, and marks credential responses `no-store`.
    """
    first = client.get("/wbedit/pairing")
    assert first.get_json() == {"paired": False, "token": ""}
    assert first.headers["Cache-Control"] == "no-store"

    minted = client.post("/wbedit/pairing/rotate")
    tok = minted.get_json()["token"]
    assert tok and minted.headers["Cache-Control"] == "no-store"
    assert client.get("/wbedit/pairing").get_json() == {"paired": True, "token": tok}
    assert client.get("/pair/ping", headers={"Authorization": f"Bearer {tok}"}).status_code == 200

    again = client.post("/wbedit/pairing/rotate").get_json()["token"]
    assert again != tok
    assert client.get("/pair/ping",
                      headers={"Authorization": f"Bearer {tok}"}).status_code == 401, \
        "rotating did not revoke the old token"

    client.delete("/wbedit/pairing")
    assert client.get("/wbedit/pairing").get_json()["paired"] is False
    assert client.get("/pair/ping", headers={"Authorization": f"Bearer {again}"}).status_code == 401


def test_the_ping_leaks_nothing_about_the_install(client):
    """A version string or a document count here is free reconnaissance for anyone holding a
    token they should not have."""
    tok = pairing.rotate()
    body = client.get("/pair/ping", headers={"Authorization": f"Bearer {tok}"}).get_json()
    assert body == {"paired": True}
