"""The chat-completions backend every engine uses — KoboldCpp, llama.cpp, OpenRouter, Featherless.

🔴 **THE TRANSPORT IS INJECTED, AND THAT IS NOT CEREMONY.** `src/kobold.py` already solved this
badly-shaped problem once — it builds the SSL context for a self-signed local cert, and it
**always sends the `Authorization` bearer, including on status reads**, because an
unauthenticated `/api/v1/model` can return the placeholder name `koboldcpp/protected-model` when
authentication is required. Re-deriving any of that here would produce a second copy that
drifts, and the copy that drifts is the one that silently reports the wrong model into a report
that is supposed to record which model a pass ran under (§3.1). The same holds for llama.cpp
(`llama._request`) and the hosted providers (`llmapi.chat_post`): each engine brings its own.

So this module owns only what is genuinely its own: the chat-completions request shape, pulling
the reply out of it, and turning every failure into a `TransportError` that carries no field
text. `urllib_post()` is here for standalone use.

🔴 **THE SAMPLER BLOCK IS THE CALLER'S, PER ENGINE** (`backends/profiles.py`). This class splats
whatever it is handed into the body; it must never grow a default of its own, or one engine's
keys end up silently ignored by another (base.py's note on `PROFILE`).

⚠️ Provider locality is enforced by the engine selector (`DESIGN_11_1 §6`). This module does not
enforce locality either way — half a copy of somebody
else's policy is worse than none — the engine selector in `vocalis/web/llm_engine.py` decides.
"""
from __future__ import annotations

import json
from typing import Any, Callable

from .base import BackendRefused, TransportError

#: `post(path, body, timeout) -> parsed JSON`. Vocalis binds one per engine — see
#: `vocalis/web/llm_engine.py`: `kobold._request`, `llama._request`, or `llmapi.chat_post`.
Post = Callable[[str, Any, float], Any]

#: `on_exchange(request_body, reply_text)`. Both verbatim — the point of the log is that it is
#: what was actually sent and actually received, not a reconstruction of either.
Exchange = Callable[[Any, str], None]

CHAT_PATH = "/v1/chat/completions"

#: What closes a log row whose request went out and got nothing back.
#:
#: 🔴 **EVERY OPENED ROW MUST BE CLOSED, ON EVERY PATH.** The runner retries a transport failure
#: up to three times, calling `complete()` afresh each time — so without this, each failed attempt
#: left a row stuck at `reply: None` forever. The live window then showed exchanges permanently
#: "in flight", the row count stopped matching the field count, and each unfinished row used a
#: `_LOG_KEEP` slot.
#:
#: ⚠️ The failed attempts are NOT folded into the retry that succeeds. Three requests really were
#: sent, and a window whose whole purpose is showing what was actually sent must say so — they
#: each just need an outcome.
#:
#: 🔴 A FIXED STRING, NEVER THE EXCEPTION (I16). The reply half of a row is rendered verbatim and
#: reaches the same places field text does; a transport message can carry a URL or a status line
#: and has no business there.
NO_REPLY = "(no reply — the request failed in transport)"


class ChatCompletions:
    """One field per call, no streaming (§3: `stream` is False in the profile).

    `model` is the name sent in the request body. KoboldCpp ignores it — one model is loaded —
    but it goes in the report, so `status()`'s answer is what belongs here, not `"local"`, on any
    path where the real name is available. For llama.cpp's router and the hosted providers
    (11.1) it is not decoration: it selects the model that answers.

    ⚠️ Until 11.1 this class was `KoboldChat` in `kobold_chat.py`. Nothing in it was ever
    KoboldCpp-specific — the transport is injected and the sampler block is the caller's — so it
    moved here unchanged and `kobold_chat.KoboldChat` is the same class under its old name.
    """

    def __init__(self, post: Post, *, model: str = "local", timeout: float = 600.0,
                 on_exchange: Exchange | None = None):
        self._post = post
        self.model = model
        self.timeout = timeout
        #: §6.4.3 — called with the EXACT body sent and the EXACT reply string, for the log
        #: window. Optional and inert when absent, so the standalone/CLI path and
        #: every test that does not care are unaffected.
        self._on_exchange = on_exchange

    def _log(self, body: Any, reply: str | None) -> None:
        """Fire `on_exchange`, and never let it break a pass.

        🔴 A LOGGING FAULT MUST NEVER FAIL A PASS. Losing one log row is a cosmetic loss; losing
        a 35-minute pass is not. Named exceptions rather than a blind handler —
        `tests/test_m5_boundaries.py` caps those in `src/` and it is AT the cap, which is why
        this is one helper called twice rather than two copies of the same handler.
        """
        if self._on_exchange is None:
            return
        try:
            self._on_exchange(body, reply)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError):
            pass

    def complete(self, messages: list[dict[str, str]], sampler: dict[str, Any]) -> str:
        body = {"model": self.model, "messages": messages, **sampler}
        # 🔴 **LOG IT BEFORE THE CALL, NOT AFTER (§9a.13).** `self._post` below blocks for as
        # long as the model takes. Everything needed for the exchange record is already
        # assembled in `body` on the line above, and it remains in this local variable for the
        # entire wait while the live-log window shows that no exchange has completed. A `None`
        # reply means the request is in flight; the row is closed in place when it lands.
        self._log(body, None)
        try:
            reply = self._post(CHAT_PATH, body, self.timeout)
        except (TransportError, BackendRefused):
            # 🔴 BackendRefused TOO: a refused key or out-of-credit account ends
            # the pass, and without this its row stayed at `reply: None` — the live window showed
            # that exchange in flight forever, the exact state NO_REPLY exists to prevent.
            self._log(body, NO_REPLY)
            raise
        except (OSError, ValueError) as exc:
            # 🔴 NARROW ON PURPOSE, AND `except Exception` HERE WAS A BUG. `Backend`'s docstring
            # promises that anything which is not a transport failure PROPAGATES — a broken prompt
            # builder is not a flaky network, and laundering it into a TransportError buys it three
            # retries and a tidy FAILED row instead of a traceback. OSError covers URLError, socket
            # timeouts and ssl errors; ValueError covers a JSON body that will not parse.
            #
            # 🔴 The exception's own text, never the body. Interpolating `body` would put a
            # worldbook entry into a string that reaches the report and the logs (I16).
            self._log(body, NO_REPLY)
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc

        try:
            content = reply["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            # A 200 with the wrong shape is a transport failure, not a model failure: retrying is
            # the right response, and the runner's retry is what gets it.
            self._log(body, NO_REPLY)
            raise TransportError(f"unexpected response shape: {type(exc).__name__}") from exc
        if not isinstance(content, str):
            self._log(body, NO_REPLY)
            raise TransportError(f"reply content was {type(content).__name__}, not a string")

        # Closes the row opened before the POST — same `body`, now with its reply.
        self._log(body, content)
        return content


def urllib_post(base_url: str, api_key: str | None = None, *, context=None) -> Post:
    """A plain `post` for standalone use — the CLI-equivalent path, and tests against a fake.

    Vocalis does NOT use this: it passes an engine's own transport (`kobold._request` and
    friends) bound to a resolved config, which
    already carries the bearer and the CA file for the local self-signed cert.
    """
    import urllib.error
    import urllib.request

    def post(path: str, body: Any, timeout: float) -> Any:
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(base_url.rstrip("/") + path, data=data,
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            # The status line only — an error BODY from a server we do not control could echo the
            # request back at us, and that request contains the field.
            raise TransportError(f"HTTP {exc.code}") from exc
        except (OSError, ValueError) as exc:
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc

    return post
