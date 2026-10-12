"""Use local HTTP servers to exercise provider request paths, headers, and response parsing through the real browser-to-urllib path, rather than stubbing the client request. Route requests with the same URL overrides used by production. Fixtures model documented OpenRouter and Featherless model/key response shapes; Featherless does not publish its plan schema, so the plan fixture uses a synthetic field set and invented values. A hold gate blocks matching requests until released so browser tests can assert an in-flight spinner deterministically."""
from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wbedit.core.contract import BEGIN, END, NOCHANGE

GOOD_KEY = "sk-test-good-key-0123456789"

#: A sentence that must never escape into a pass's failure reason. The fake puts it in its error
#: bodies — the shape a moderation refusal quoting the flagged input would have (I16).
LEAK = "SENTINEL-PROVIDER-ERROR-TEXT"


def openrouter_catalogue() -> list[dict]:
    """Enough models that "list everything" would visibly be wrong (120), with a family whose ids
    share a prefix so ranking and multi-term matching have something to do."""
    rows = [
        {"id": "z-ai/glm-4.6", "name": "Z.AI: GLM 4.6", "context_length": 202752,
         "pricing": {"prompt": "0.0000006", "completion": "0.0000022"},
         "supported_parameters": ["temperature", "top_p", "min_p", "repetition_penalty",
                                  "max_tokens"]},
        {"id": "z-ai/glm-4.5-air", "name": "Z.AI: GLM 4.5 Air", "context_length": 131072,
         "pricing": {"prompt": "0.0000002", "completion": "0.0000011"},
         "supported_parameters": ["temperature", "top_p", "max_tokens"]},
        {"id": "thudm/glm-z1-32b", "name": "THUDM: GLM Z1 32B", "context_length": 32768,
         "pricing": {"prompt": "0.00000024", "completion": "0.00000024"}},
        # A model whose NAME mentions glm but whose id does not start with it — ranks below.
        {"id": "acme/fusion-8b", "name": "Acme Fusion (GLM-style)", "context_length": 8192,
         "pricing": {"prompt": "0", "completion": "0"}},
    ]
    for i in range(116):
        rows.append({"id": f"vendor{i % 9}/model-{i:03d}", "name": f"Vendor Model {i:03d}",
                     "context_length": 4096 * (1 + i % 8),
                     "pricing": {"prompt": "0.000001", "completion": "0.000002"}})
    return rows


def featherless_catalogue() -> list[dict]:
    """A plan-filterable catalogue: some rows are NOT on the plan, so the filter is observable."""
    rows = [
        {"id": "zai-org/GLM-4.6", "name": "GLM-4.6", "model_class": "glm4-355b",
         "context_length": 32768, "max_completion_tokens": 4096,
         "available_on_current_plan": True, "concurrency_cost": 4},
        {"id": "zai-org/GLM-4-32B-0414", "name": "GLM-4-32B-0414", "model_class": "glm4-32b",
         "context_length": 32768, "max_completion_tokens": 4096,
         "available_on_current_plan": True, "concurrency_cost": 2},
        {"id": "big-lab/GLM-Huge", "name": "GLM-Huge", "model_class": "huge-1t",
         "context_length": 16384, "available_on_current_plan": False, "concurrency_cost": 8},
    ]
    for i in range(300):
        rows.append({"id": f"org{i % 13}/Mistral-Nemo-ft-{i:03d}", "name": f"Nemo ft {i:03d}",
                     "model_class": "mistral-nemo-12b", "context_length": 16384,
                     "available_on_current_plan": True, "concurrency_cost": 1})
    return rows


def rename_reply(body: dict) -> dict:
    """The fake changes fields containing `Test Character 1` and returns `NOCHANGE` for all other fields."""
    field = body["messages"][-1]["content"].split("FIELD\n", 1)[-1]
    if 'Test Character 1' not in field:
        content = NOCHANGE
    else:
        out = field.replace('Test Character 1', 'Renamed Character 1')
        content = f"{BEGIN}\n{out}\n{END}\nRenamed the character."
    return {"id": "gen-1", "choices": [{"message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 321, "completion_tokens": 45}}


class FakeProvider:
    def __init__(self, kind: str, key: str = GOOD_KEY):
        assert kind in ("openrouter", "featherless")
        self.kind = kind
        self.key = key
        self.catalogue = openrouter_catalogue() if kind == "openrouter" \
            else featherless_catalogue()
        #: (method, path-with-query, Authorization header, parsed body) for every request.
        self.requests: list[tuple[str, str, str, object]] = []
        #: Queued `(status, body, headers)` answers for the NEXT chat requests, oldest first.
        self.chat_failures: list[tuple[int, dict, dict]] = []
        self.chat = rename_reply
        self.plan_status = 200
        #: OpenRouter's `GET /v1/key` record for this key — a test may replace it.
        self.key_record = {"limit": 10, "limit_remaining": 7.5, "usage": 2.5,
                           "is_free_tier": False}
        #: Substring of a path/query that makes the request block until `release()`.
        self.hold_on: str | None = None
        self._gate = threading.Event()
        self._srv: ThreadingHTTPServer | None = None

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self) -> "FakeProvider":
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):          # keep the suite's output clean
                pass

            def _send(self, status, body, headers=None):
                raw = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                fake._handle(self, "GET", None)

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                fake._handle(self, "POST", json.loads(raw.decode("utf-8")) if raw else None)

        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self._srv.daemon_threads = True
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        self._gate.set()
        if self._srv:
            self._srv.shutdown()
            self._srv.server_close()

    @property
    def url(self) -> str:
        """The base URL Vocalis is pointed at — stops short of `/v1`, like the real ones."""
        return f"http://127.0.0.1:{self._srv.server_address[1]}"

    def hold(self, match: str) -> None:
        """Block every request whose path contains `match` until `release()`."""
        self._gate.clear()
        self.hold_on = match

    def release(self) -> None:
        self.hold_on = None
        self._gate.set()

    def paths(self, prefix: str = "") -> list[str]:
        return [p for _m, p, _a, _b in self.requests if p.startswith(prefix)]

    # ── the API ──────────────────────────────────────────────────────────────
    def _authed(self, h) -> bool:
        return h.headers.get("Authorization") == f"Bearer {self.key}"

    def _handle(self, h, method, body):
        path = h.path
        # Featherless blocks Python-urllib's default user-agent before route handling. Both fakes model this so a user-agent regression fails the test.
        if (h.headers.get("User-Agent") or "").startswith("Python-urllib"):
            raw = b"error code: 1010\n"
            h.send_response(403)
            h.send_header("Content-Type", "text/plain")
            h.send_header("Content-Length", str(len(raw)))
            h.end_headers()
            h.wfile.write(raw)
            return
        if path == "/__release":
            self.release()
            return h._send(200, {"ok": True})
        self.requests.append((method, path, h.headers.get("Authorization") or "", body))
        if self.hold_on and self.hold_on in path:
            # Bounded, so a spec that dies before releasing cannot pin a server thread forever.
            self._gate.wait(timeout=60)
        u = urllib.parse.urlparse(path)
        qs = urllib.parse.parse_qs(u.query)
        bad = {"error": {"code": 401, "message": f"No auth credentials found {LEAK}"}}

        if u.path == "/v1/chat/completions" and method == "POST":
            if not self._authed(h):
                return h._send(401, bad)
            if self.chat_failures:
                status, err, headers = self.chat_failures.pop(0)
                return h._send(status, err, headers)
            return h._send(200, self.chat(body))

        if self.kind == "openrouter":
            if u.path == "/v1/key":
                if not self._authed(h):
                    return h._send(401, bad)
                return h._send(200, {"data": {"label": "sk-or-v1-abc...xyz", **self.key_record}})
            if u.path == "/v1/models":
                return h._send(200, {"data": self.catalogue})
        else:
            if u.path == "/v1/plan":
                if self.plan_status != 200:
                    return h._send(self.plan_status, {"error": "not found"})
                if not self._authed(h):
                    return h._send(401, bad)
                return h._send(200, {"id": "plan-test", "name": "Premium", "concurrency": 4,
                                     "api_access": True, "max_context_length": 32768,
                                     "max_model_size": 72})
            if u.path == "/v1/models":
                if h.headers.get("Authorization") and not self._authed(h):
                    return h._send(401, bad)
                q = (qs.get("q") or [""])[0].lower()
                per = int((qs.get("per_page") or ["100"])[0])
                on_plan = (qs.get("available_on_current_plan") or [""])[0] in ("true", "1")
                rows = [m for m in self.catalogue
                        if q in (m["id"] + " " + m["name"]).lower()
                        and (m["available_on_current_plan"] or not on_plan)]
                return h._send(200, {"data": rows[:per]})
        return h._send(404, {"error": {"message": f"no route {u.path}"}})
