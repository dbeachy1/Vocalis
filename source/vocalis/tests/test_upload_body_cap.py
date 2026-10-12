"""The upload endpoints' exemption from the global body cap.

`MAX_CONTENT_LENGTH` limits buffered JSON routes such as `/speak` and `/v1/*`. Upload routes
stream files to disk and must not inherit that cap.

Under Flask 3.1, setting `request.max_content_length = None` falls back to the configured limit
because the getter treats `None` as unset. The tests use a control and an exempt endpoint so a
case where both return 413 fails.
"""
import io

import flask
import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import auth as rt_auth   # vault store + admin creds (5.1-P4.15)

SMALL_CAP = 2048                 # the "global" cap for these tests
BODY = b"x" * (64 * 1024)        # comfortably over it, comfortably under any real limit

# A route in _UPLOAD_ENDPOINTS that reads request.files (so the body is parsed, which is where a
# 413 fires) and then bails on a missing field WITHOUT touching the disk — the point here is the
# cap, not the import, and a test that lands files would be testing two things at once.
UPLOAD_URL = "/stems/upload"   # was /voices/rvc/<name>/index; RVC import is not in the Docker edition


@pytest.fixture
def open_client(monkeypatch):
    """Auth off, so the request reaches the endpoint. No vault, so nothing is locked."""
    monkeypatch.setattr(rt_auth, "_ADMIN_HASH", "")
    monkeypatch.setattr(rt_auth, "_CREDS_BROKEN", False)
    monkeypatch.setitem(vs.app.config, "MAX_CONTENT_LENGTH", SMALL_CAP)
    vs.app.secret_key = "test-key-not-derived-from-anything"
    with vs.app.test_client() as c:
        yield c


def _post_big(client):
    # 'bogus', not 'file': the handler parses the body (413 territory), finds no `file` part
    # and returns 400 without writing anything.
    return client.post(UPLOAD_URL, content_type="multipart/form-data",
                       data={"bogus": (io.BytesIO(BODY), "big.bin")})


def test_an_upload_endpoint_accepts_a_body_over_the_global_cap(open_client):
    """The whole point of the exemption. 400 means the body was PARSED and the handler ran."""
    r = _post_big(open_client)

    assert r.status_code != 413, (
        "the upload endpoint is still bound by MAX_CONTENT_LENGTH — the cap lift is a no-op")
    assert r.status_code == 400
    assert "no files uploaded" in r.get_json()["error"]


def test_the_SAME_body_is_413d_when_the_endpoint_is_not_exempt(open_client, monkeypatch):
    """The control, and it is what makes the test above mean something.

    Same route, same body, same cap — the only difference is membership of _UPLOAD_ENDPOINTS.
    Without this, a test asserting 'not 413' would also pass if the global cap were simply
    missing, which is the opposite bug and a far worse one (an anon OOM on /speak)."""
    monkeypatch.setattr(vs, "_UPLOAD_ENDPOINTS", frozenset())

    assert _post_big(open_client).status_code == 413


def test_the_lifted_cap_is_a_number_and_it_is_generous(open_client):
    """The upload exception must remain an explicit numeric limit large enough for intended model-index files."""
    assert isinstance(vs.UPLOAD_BODY_CAP, int)
    assert vs.UPLOAD_BODY_CAP >= 2 * 1024 * 1024 * 1024


def test_None_CANNOT_express_unlimited_per_request():
    """The trap itself, pinned — this is third-party behavior, so it gets an explicit test.

    If a future Flask makes `None` mean "no limit" per-request this fails, and whoever sees it
    should read _lift_body_cap_for_uploads before 'simplifying' it back. Until then, assigning
    None there is not a tidier way to say the same thing: it is a silent no-op."""
    with vs.app.test_request_context("/"):
        flask.request.max_content_length = None

        assert flask.request.max_content_length == vs.app.config["MAX_CONTENT_LENGTH"], \
            "None now means unlimited — re-read _lift_body_cap_for_uploads()"


def test_every_name_in_UPLOAD_ENDPOINTS_IS_a_real_endpoint():
    """Every exempt view name must match an endpoint registered on the app.

    `_UPLOAD_ENDPOINTS` is a frozenset of VIEW-FUNCTION NAMES matched against
    `request.endpoint`. Move a view into a Flask blueprint and its endpoint gains the
    blueprint's prefix — `bulk_start` becomes `vocalis_bulk.bulk_start` — so the set stops
    matching, the 128 MB global cap silently reapplies, and a legitimate upload 413s. Nothing
    raises. Every other test in this file drives ONE endpoint, so eight of the nine could stop
    being exempt without a single failure.

    Blueprint routes include the blueprint prefix in `request.endpoint`; this full-set check
    catches stale unqualified names even when individual route tests pass.
    """
    known = {r.endpoint for r in vs.app.url_map.iter_rules()}
    missing = sorted(n for n in vs._UPLOAD_ENDPOINTS if n not in known)
    assert not missing, (
        f"these names are exempt from the body cap but are not endpoints on the app: "
        f"{missing}. If a view moved into a blueprint, its endpoint is now "
        f"'<blueprint>.<view>' — put THAT in _UPLOAD_ENDPOINTS. Until then the 128 MB cap "
        f"applies to it again and a real upload gets a 413 with nothing in the log.")


def test_every_route_that_READS_request_files_is_exempt():
    """Find multipart upload routes that are missing from the exemption set.

    Checking every listed name cannot detect a route that was never listed. Discover route
    functions that access `request.files`, then resolve their registered endpoint names through
    `url_map` so the result includes the blueprint prefix Flask actually uses.
    """
    import ast

    readers = set()
    for p in sorted((REPO_ROOT / "src").rglob("*.py")):
        if "__pycache__" in p.parts:
            continue
        for fn in [n for n in ast.walk(ast.parse(p.read_text(encoding="utf-8-sig")))
                   if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            reads_files = any(isinstance(a, ast.Attribute) and a.attr == "files"
                              and getattr(a.value, "id", "") == "request"
                              for a in ast.walk(fn))
            is_route = any(isinstance(d, ast.Call) and getattr(d.func, "attr", "") == "route"
                           for d in fn.decorator_list)
            if reads_files and is_route:
                readers.add(fn.name)

    assert readers, "found no request.files routes at all -- the scan itself is broken"

    by_view = {r.endpoint.rsplit(".", 1)[-1]: r.endpoint for r in vs.app.url_map.iter_rules()}
    unlisted = sorted(by_view.get(v, v) for v in readers
                      if by_view.get(v, v) not in vs._UPLOAD_ENDPOINTS)
    assert not unlisted, (
        f"these routes read request.files but are NOT exempt from the body cap, so a real "
        f"upload 413s at MAX_CONTENT_LENGTH with nothing in the log: {unlisted}")
