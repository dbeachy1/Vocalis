"""Tests HTTP transport behavior against a local stub server."""
from __future__ import annotations

import json
import threading

import pytest
from flask import Flask, Response, request

from conftest import REPO_ROOT, bound_server  # noqa: F401  (sys.path side effect)

from wbedit.backends.base import TransportError
from wbedit.backends.kobold_chat import CHAT_PATH, KoboldChat, urllib_post

#: A body sentinel that could not plausibly arise anywhere else — §10 requires containment to be
#: proved by grepping the produced artifact, not by reading the code.
SENTINEL = "ZQX-FIELD-SENTINEL-4417"

#: The bug involved a `.decode()` boundary. The stub uses multi-byte UTF-8 so the
#: transport's own `resp.read().decode("utf-8")` has something it could get wrong.
HARD = "Sample World Book 4 — polished, ambitious. She’d say “no”… Привет \U0001F600"


@pytest.fixture(scope="module")
def _stub_server():
    """Run a local Flask server that records request bodies for transport assertions."""
    app = Flask(__name__)
    seen: dict = {"requests": []}
    plan: dict = {"status": 200, "body": None, "raw": None}

    @app.post("/<path:_p>")
    def any_post(_p):
        seen["requests"].append({
            "path": request.path,
            "raw": request.get_data(),
            "headers": dict(request.headers),
        })
        if plan["raw"] is not None:
            return Response(plan["raw"], status=plan["status"],
                            content_type="application/json")
        return Response(json.dumps(plan["body"], ensure_ascii=False).encode("utf-8"),
                        status=plan["status"], content_type="application/json")

    srv = bound_server(app)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    seen["url"] = f"http://127.0.0.1:{srv.server_port}"
    seen["plan"] = plan
    try:
        yield seen
    finally:
        srv.shutdown()
        t.join(timeout=10)


@pytest.fixture
def stub(_stub_server):
    """A clean slate on the shared socket: no recorded requests, and a 200 with an empty plan."""
    _stub_server["requests"].clear()
    _stub_server["plan"].update({"status": 200, "body": None, "raw": None})
    return _stub_server


def _reply(text=HARD):
    return {"choices": [{"message": {"content": text}}]}


# ── the happy path, over a real socket ───────────────────────────────────────

def test_a_request_goes_out_as_utf8_json_and_the_reply_comes_back_decoded(stub):
    stub["plan"]["body"] = _reply()
    post = urllib_post(stub["url"])

    got = post(CHAT_PATH, {"model": "m", "messages": [{"role": "user", "content": HARD}]}, 10.0)
    assert got["choices"][0]["message"]["content"] == HARD

    sent = stub["requests"][0]
    assert sent["path"] == CHAT_PATH
    assert sent["headers"]["Content-Type"] == "application/json"
    # 🔴 The BYTES, not the parsed body: this transport is one of the two places in the system
    # where a code point becomes a byte, and the reported mojibake lived on exactly such a line.
    assert json.loads(sent["raw"].decode("utf-8"))["messages"][0]["content"] == HARD
    assert "—".encode("utf-8").decode("latin-1").encode("utf-8") not in sent["raw"], \
        "the request body left double-encoded"


def test_a_trailing_slash_on_the_base_url_does_not_double_up(stub):
    """`base_url.rstrip("/")` — a config with a trailing slash is the ordinary way to write one,
    and `//v1/chat/completions` is a 404 that reads as "Kobold is not running"."""
    stub["plan"]["body"] = _reply("ok")
    urllib_post(stub["url"] + "/")(CHAT_PATH, {"messages": []}, 10.0)
    assert stub["requests"][0]["path"] == CHAT_PATH


def test_an_api_key_becomes_a_bearer_and_no_key_means_no_header(stub):
    """KoboldCpp's `--password` is a bearer, and an unauthenticated `/api/v1/model` answers 200
    with a FAKE model name — so a dropped header is a wrong report, not an error."""
    stub["plan"]["body"] = _reply("ok")
    urllib_post(stub["url"], "s3cret")(CHAT_PATH, {"messages": []}, 10.0)
    assert stub["requests"][0]["headers"]["Authorization"] == "Bearer s3cret"

    urllib_post(stub["url"])(CHAT_PATH, {"messages": []}, 10.0)
    assert "Authorization" not in stub["requests"][1]["headers"]


def test_the_whole_backend_runs_on_it(stub):
    """The transport underneath a real `KoboldChat`, which is how the standalone path is wired.
    Nothing between them is stubbed."""
    stub["plan"]["body"] = _reply(HARD)
    backend = KoboldChat(urllib_post(stub["url"]), model="test-model")
    assert backend.complete([{"role": "user", "content": HARD}], {"temperature": 0.2}) == HARD
    sent = json.loads(stub["requests"][0]["raw"].decode("utf-8"))
    assert sent["model"] == "test-model" and sent["temperature"] == 0.2


# ── every failure it is required to translate ────────────────────────────────

def test_an_http_error_is_a_TransportError_carrying_the_STATUS_AND_NOTHING_ELSE(stub):
    """Checks that an http error is a transporterror carrying the status and nothing else."""
    stub["plan"]["status"] = 500
    stub["plan"]["raw"] = json.dumps({"error": f"failed while handling {SENTINEL}"}).encode()

    with pytest.raises(TransportError) as exc:
        urllib_post(stub["url"])(CHAT_PATH,
                                 {"messages": [{"role": "user", "content": SENTINEL}]}, 10.0)
    assert str(exc.value) == "HTTP 500"
    assert SENTINEL not in str(exc.value)
    assert SENTINEL not in repr(exc.value)


def test_a_4xx_is_the_same_shape(stub):
    stub["plan"]["status"] = 401
    stub["plan"]["raw"] = b'{"error": "unauthorized"}'
    with pytest.raises(TransportError) as exc:
        urllib_post(stub["url"])(CHAT_PATH, {"messages": []}, 10.0)
    assert str(exc.value) == "HTTP 401"


def test_a_200_that_is_not_json_is_a_TransportError_not_a_ValueError(stub):
    """Checks that a 200 that is not json is a transporterror not a valueerror."""
    stub["plan"]["raw"] = b"<html>gateway</html>"
    with pytest.raises(TransportError):
        urllib_post(stub["url"])(CHAT_PATH, {"messages": []}, 10.0)


def test_nothing_listening_is_a_TransportError(stub):
    """`URLError` is an `OSError`. This is what a Kobold that is not running looks like, and it
    is a common local-service failure."""
    srv = bound_server(Flask(__name__))
    dead = f"http://127.0.0.1:{srv.server_port}"
    srv.server_close()                     # the port is now closed, and nothing is listening

    with pytest.raises(TransportError):
        urllib_post(dead)(CHAT_PATH, {"messages": []}, 0.5)


def test_the_socket_timeout_is_honored_and_becomes_a_TransportError(stub):
    """Checks that the socket timeout is honored and becomes a transporterror."""
    release = threading.Event()
    app = Flask(__name__)

    @app.post("/<path:_p>")
    def slow(_p):
        release.wait(30)
        return Response(b"{}", content_type="application/json")

    srv = bound_server(app)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        with pytest.raises(TransportError):
            urllib_post(f"http://127.0.0.1:{srv.server_port}")(CHAT_PATH, {"messages": []}, 0.5)
    finally:
        release.set()
        srv.shutdown()
        t.join(timeout=10)


def test_a_transport_failure_never_carries_the_field(stub):
    """I16 on the other clause: `TransportError(f"{type(exc).__name__}: {exc}")`. `URLError`'s
    text carries a URL and an errno; it must never grow a body."""
    srv = bound_server(Flask(__name__))
    dead = f"http://127.0.0.1:{srv.server_port}"
    srv.server_close()

    with pytest.raises(TransportError) as exc:
        urllib_post(dead)(CHAT_PATH, {"messages": [{"role": "user", "content": SENTINEL}]}, 0.5)
    assert SENTINEL not in str(exc.value)
