"""Provide hosted LLM connectivity, model search, and chat transport for the worldbook editor. API keys arrive through configuration and are excluded from logs. Report retryable network/provider failures separately from refused credentials, credit, or model requests."""
from __future__ import annotations

import http.client
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

from loguru import logger

from wbedit.backends.base import BackendRefused, TransportError


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    base_url: str        # the chat path `/v1/chat/completions` is appended to this
    key_env: str         # env override for the key — the systemd/vocalis.env path, like llama's
    url_env: str         # env override for the base URL — how the suite points it at a fake


PROVIDERS: dict[str, Provider] = {
    "openrouter": Provider("openrouter", "OpenRouter", "https://openrouter.ai/api",
                           "VOCALIS_OPENROUTER_API_KEY", "VOCALIS_OPENROUTER_URL"),
    "featherless": Provider("featherless", "Featherless", "https://api.featherless.ai",
                            "VOCALIS_FEATHERLESS_API_KEY", "VOCALIS_FEATHERLESS_URL"),
}

#: The chat path, appended to `base_url`. OpenRouter's documented endpoint is
#: `https://openrouter.ai/api/v1/chat/completions` and Featherless's is
#: `https://api.featherless.ai/v1/chat/completions`, so both bases stop short of `/v1`.
CHAT_PATH = "/v1/chat/completions"

#: Connection attempts have a 30-second ceiling so the UI eventually reports an unavailable provider instead of waiting indefinitely.
CONNECT_TIMEOUT = 30.0

#: One search request. Shorter than Connect: a search is re-sent on the next keystroke anyway.
SEARCH_TIMEOUT = 20.0

#: How many rows a search returns. A list longer than this is a list nobody reads — the answer to
#: "too many" is a longer query, which is the whole point of search-then-click.
SEARCH_LIMIT = 50

#: OpenRouter's whole catalogue is fetched once and filtered here, so typing is not one upstream
#: request per keystroke. An hour: new models appear on the scale of days, and a stale hour costs
#: nothing but a missing brand-new id — which Replace Key or a restart refreshes.
OPENROUTER_CACHE_SECONDS = 3600.0

#: How long a 429 waits before the runner's own retry, when the provider gives no Retry-After.
#: Capped either way: a provider that says "come back in ten minutes" is not something a pass
#: should sit inside a socket for.
BUSY_WAIT_DEFAULT = 5.0
BUSY_WAIT_CAP = 30.0


@dataclass
class ApiConfig:
    provider: str
    base_url: str
    api_key: str = field(default="", repr=False)   # 🔴 repr=False — see the module docstring

    @property
    def label(self) -> str:
        return PROVIDERS[self.provider].label

    @property
    def host(self) -> str:
        return urllib.parse.urlparse(self.base_url).hostname or self.base_url


def resolve_config(provider: str, app_settings: dict, secrets: dict | None = None) -> ApiConfig:
    """env -> app_settings.yaml -> the provider's public default. The house idiom.

    `secrets` is voice_settings.yaml's `<provider>` section — the ENCRYPTED half, and the key is
    the only thing that comes from it. The base URL has a real default here (unlike llama.cpp's,
    whose URL is its enable gate): these are public services at fixed addresses, and the override
    exists only so the suite and the browser spec can point Vocalis at a fake.

    Raises KeyError on an unknown provider — a typo in a route is a bug, not a missing setting.
    """
    p = PROVIDERS[provider]
    block = app_settings.get("llm_api") if isinstance(app_settings, dict) else None
    mine = block.get(provider) if isinstance(block, dict) else None
    mine = mine if isinstance(mine, dict) else {}
    sec = secrets if isinstance(secrets, dict) else {}
    base = os.environ.get(p.url_env) or str(mine.get("url") or "") or p.base_url
    return ApiConfig(provider=provider, base_url=base.strip().rstrip("/"),
                     api_key=str(os.environ.get(p.key_env) or sec.get("api_key") or ""))


# ── the HTTP boundary ─────────────────────────────────────────────────────────

class ApiUnreachable(Exception):
    """No usable answer, and asking again may get one: the network, a timeout, a 5xx, a 429.

    `retry_after` is set on a 429 when the provider said how long to wait."""

    def __init__(self, message: str, retry_after: float | None = None, status: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after
        self.status = status


class ApiRefused(Exception):
    """The provider answered and said no: asking again will get the same answer.

    `str(exc)` is a sentence WE composed from the status code — safe to show anywhere, including a
    pass's failure reason. `detail` is the provider's own error message, trimmed, and is for the
    Connect and search routes ONLY: those carry no worldbook text, so the provider's wording is
    useful there. 🔴 The chat path never uses `detail` (I16 — see `chat_post`)."""

    def __init__(self, message: str, status: int, detail: str = ""):
        super().__init__(message)
        self.status = status
        self.detail = detail


def _provider_message(raw: bytes) -> str:
    """The `error.message` out of an OpenAI-shaped error body, trimmed. '' when there is none."""
    try:
        j = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return ""
    err = j.get("error") if isinstance(j, dict) else None
    msg = err.get("message") if isinstance(err, dict) else (err if isinstance(err, str) else "")
    if not msg and isinstance(j, dict):
        msg = j.get("message") or j.get("detail") or ""
    return str(msg or "")[:200]


#: Sent on every provider request — see `_request` for why it must be explicit.
USER_AGENT = "Vocalis"

#: What Cloudflare's bot filter answers with: "error code: 1010" as plain text, or an HTML page
#: saying the owner "has blocked access based on your browser's signature".
_BOT_BLOCK_MARKERS = (b"error code: 1010", b"browser's signature",
                      "browser\u2019s signature".encode("utf-8"))


def _is_bot_block(raw: bytes) -> bool:
    return any(m in raw for m in _BOT_BLOCK_MARKERS)


def _scrub(cfg: ApiConfig, text: str) -> str:
    """`text` with the key cut out of it — every string `_request` raises goes through here.

    🔴 **AN ERROR MESSAGE CAN CARRY THE WHOLE KEY.** `http.client`
    rejects a header value with an interior newline as `ValueError("Invalid header value
    b'Bearer <key>'")`, and that message went into `ApiUnreachable` and from there to the browser,
    the log, app_settings.yaml (`last_connect`) and a field's failure reason. The key route now
    refuses such a key, but an env var can still carry one, and a provider's own error body can
    echo a key back ("Incorrect API key provided: sk-…"). So the scrub is here, at the one place
    every provider message is born, rather than trusted to each caller.

    ⚠️ **MARK EVERY POSITION FIRST, REPLACE ONCE.** Replacing window by window
    destroyed the overlapping windows it had not yet matched and left up to 11 characters of key on
    each side of a break; and http.client quotes the key as a bytes REPR, where a newline is the two
    characters `\\n`, so the raw key never matched at all. Both forms are scanned, every 8-character
    window of each is marked wherever it occurs, and the marked runs are replaced in one pass.
    """
    k = cfg.api_key
    if not (k and text):
        return text
    forms = {k, k.encode("unicode_escape").decode("ascii", "replace")}
    w = min(8, len(k))
    hit = [False] * len(text)
    for form in forms:
        for i in range(0, len(form) - w + 1):
            piece = form[i:i + w]
            at = text.find(piece)
            while at != -1:
                for j in range(at, at + w):
                    hit[j] = True
                at = text.find(piece, at + 1)
    out, j = [], 0
    while j < len(text):
        if hit[j]:
            while j < len(text) and hit[j]:
                j += 1
            out.append("[key]")
        else:
            out.append(text[j])
            j += 1
    return "".join(out)


def _refusal(cfg: ApiConfig, code: int, detail: str) -> ApiRefused:
    label = cfg.label
    if code == 401:
        return ApiRefused(f"{label} rejected the API key (HTTP 401). Replace it on LLM ▸ API.",
                          code, detail)
    if code == 403:
        # HTTP 403 indicates that the request was refused, commonly for moderation or model-access reasons; invalid credentials use HTTP 401. Keep the message aligned with the status code.
        return ApiRefused(f"{label} refused this request (HTTP 403) — usually a moderation flag "
                          f"on the text, or a key without permission for this model.", code,
                          detail)
    if code == 402:
        return ApiRefused(f"{label} says the account is out of credit (HTTP 402).", code, detail)
    if code == 404:
        return ApiRefused(f"{label} does not know that model or address (HTTP 404).", code, detail)
    return ApiRefused(f"{label} refused the request (HTTP {code}).", code, detail)


def _retry_after(exc: urllib.error.HTTPError) -> float | None:
    try:
        v = exc.headers.get("Retry-After") if exc.headers else None
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _request(cfg: ApiConfig, path: str, body: Any = None, timeout: float = 30.0) -> Any:
    """One call to the provider. Returns parsed JSON; raises `ApiUnreachable` or `ApiRefused`.

    ⚠️ NO `Authorization` HEADER WITHOUT A KEY, rather than a `Bearer ` with nothing after it: an
    empty bearer is a malformed header some gateways answer with 400 instead of 401, and 401 is
    the one that says what is wrong.
    """
    url = cfg.base_url + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    req.add_header("Accept", "application/json")
    # Send the product name for provider attribution; do not include a user-specific URL.
    req.add_header("X-Title", "Vocalis")
    # Send the configured User-Agent because the provider edge may block urllib’s default agent before checking the API key. This is a request-level block, not an authentication failure.
    req.add_header("User-Agent", USER_AGENT)
    if cfg.api_key:
        # 🔴 A KEY NO HEADER CAN CARRY IS REFUSED HERE, WITH A FIXED SENTENCE — never handed to
        # http.client, whose error for it quotes the whole key. The key route
        # already refuses such a key; this covers an env var or a hand-edited settings file.
        if any(c.isspace() or not (33 <= ord(c) <= 126) for c in cfg.api_key):
            raise ApiRefused(f"The saved {cfg.label} key contains characters no request can "
                             f"carry (a space, a line break or a non-ASCII character). Replace it "
                             f"on LLM ▸ API.", 0)
        req.add_header("Authorization", f"Bearer {cfg.api_key}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        code = exc.code
        try:
            raw = exc.read()
        except (OSError, http.client.HTTPException):
            raw = b""
        if code == 429:
            raise ApiUnreachable(f"{cfg.label} is busy (HTTP 429)", _retry_after(exc), code) \
                from exc
        if code == 408 or code >= 500:
            raise ApiUnreachable(f"{cfg.label} answered HTTP {code}", status=code) from exc
        if code == 403 and _is_bot_block(raw):
            # The provider edge refused the request before checking credentials. Do not describe this status as an invalid API key.
            raise ApiRefused(f"{cfg.label}'s firewall blocked the request before the key was "
                             f"checked (HTTP 403, bot filter). This is a Vocalis problem, not "
                             f"your key.", code) from exc
        raise _refusal(cfg, code, _scrub(cfg, _provider_message(raw))) from exc
    except (OSError, ValueError, http.client.HTTPException) as exc:
        # OSError covers URLError, socket timeouts and TLS errors; ValueError a 200 whose body is
        # not JSON (and a header value http.client refuses). `HTTPError` is an OSError too, which
        # is why its clause is ABOVE this one.
        # 🔴 `http.client.HTTPException` IS NOT AN OSError: `IncompleteRead`,
        # `BadStatusLine` and `LineTooLong` — a connection dropped mid-body, far likelier over the
        # internet than on a LAN — escaped this clause, 500'd Connect and failed a pass with no
        # retry. They are "try again", so they are `ApiUnreachable`.
        # 🔴 `_scrub`: the exception text can carry the key — see its docstring.
        raise ApiUnreachable(_scrub(cfg, f"could not reach {cfg.host}: "
                                         f"{type(exc).__name__}: {exc}")) from exc


# ── Connect ───────────────────────────────────────────────────────────────────

def _money(v: Any) -> float | None:
    try:
        return None if v is None or isinstance(v, bool) else float(v)
    except (TypeError, ValueError):
        return None


def connect(cfg: ApiConfig) -> dict:
    """Validate the provider key and return a one-line status plus provider details. Raise ApiRefused for invalid credentials or exhausted credit and ApiUnreachable for timeouts or network failures; the route reports both without returning a 5xx."""
    if not cfg.api_key:
        raise ApiRefused(f"No {cfg.label} API key is saved.", 0)
    if cfg.provider == "openrouter":
        return _connect_openrouter(cfg)
    return _connect_featherless(cfg)


def _connect_openrouter(cfg: ApiConfig) -> dict:
    """Read this API key’s spending limit, remaining limit, and all-time usage from GET /v1/key. This endpoint does not expose account balance; present per-key usage and say explicitly when the key has no separate cap."""
    body = _request(cfg, "/v1/key", timeout=CONNECT_TIMEOUT)
    d = body.get("data") if isinstance(body, dict) else None
    d = d if isinstance(d, dict) else {}
    limit, left, used = _money(d.get("limit")), _money(d.get("limit_remaining")), _money(d.get("usage"))
    month = _money(d.get("usage_monthly"))
    parts = ["key OK"]
    if d.get("is_free_tier"):
        parts.append("free tier")
    if left is not None and limit is not None:
        parts.append(f"${left:.2f} left of this key's ${limit:.2f} limit")
    else:
        parts.append("no spending limit on this key (your account balance is not visible to it)")
    if month is not None:
        parts.append(f"this key has spent ${month:.2f} this month")
    if used is not None:
        parts.append(f"${used:.2f} in total")
    return {"ok": True, "message": " · ".join(parts),
            "detail": {"limit": limit, "limit_remaining": left, "usage": used,
                       "usage_monthly": month, "free_tier": bool(d.get("is_free_tier"))}}


#: Accept the provider’s known plan-field spellings because the plan response is undocumented and can vary. Log unknown key names rather than relying on one fixed shape.
_FL_PLAN_NAMES = ("plan", "plan_name", "name", "tier")
_FL_CONCURRENCY = ("concurrency", "concurrency_limit", "max_concurrency", "concurrent_units",
                   "units")


def _connect_featherless(cfg: ApiConfig) -> dict:
    """`GET /v1/plan`, falling back to a one-row plan-filtered model search when it 404s.

    🔴 `/v1/models` ALONE CANNOT VALIDATE A KEY: Featherless documents it as answering
    unauthenticated calls. It is only a fallback, and only if `/v1/plan` does not exist — a real
    401 from `/v1/plan` is a rejected key and is raised as one, never retried on another route.
    """
    try:
        body = _request(cfg, "/v1/plan", timeout=CONNECT_TIMEOUT)
    except ApiRefused as exc:
        if exc.status != 404:
            raise
        logger.info("llmapi: Featherless /v1/plan answered 404 — checking reachability via "
                    "/v1/models; the key itself cannot be verified this way")
        _request(cfg, "/v1/models?available_on_current_plan=true&per_page=1",
                 timeout=CONNECT_TIMEOUT)
        # 🔴 `/v1/models` does not prove the key is accepted. It answers unauthenticated calls, so a
        # 200 here proves the SERVICE answered, not that the key is good. `ok: False` paints it
        # as a warning rather than a ✓ — a check mark over an unchecked key is the stale-verdict
        # failure in another form.
        return {"ok": False, "message": "Featherless answered, but the key could not be checked "
                                        "(its plan route did not respond)", "detail": {}}
    d = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), dict) \
        else (body if isinstance(body, dict) else {})
    logger.info(f"llmapi: Featherless /v1/plan answered with keys {sorted(d)[:20]}")
    plan = next((str(d[k]) for k in _FL_PLAN_NAMES if isinstance(d.get(k), str) and d[k]), "")
    units = next((d[k] for k in _FL_CONCURRENCY
                  if isinstance(d.get(k), (int, float)) and not isinstance(d.get(k), bool)), None)
    parts = ["key OK"]
    if plan:
        parts.append(f"plan: {plan}")
    if units is not None:
        parts.append(f"{units:g} concurrency units")
    return {"ok": True, "message": " · ".join(parts),
            "detail": {"plan": plan, "concurrency": units}}


# ── search ────────────────────────────────────────────────────────────────────

#: (base_url, fetched_at, rows). One provider, one cache — OpenRouter's is the only one; the
#: Featherless catalogue is too large to hold and is searched upstream instead.
_OR_CACHE: dict[str, tuple[float, list[dict]]] = {}

#: The clock the cache ages against. A seam, so a test can age the cache without sleeping.
_now: Callable[[], float] = time.monotonic

#: What a 429 waits with. A seam for the same reason: the suite asserts the wait, never serves it.
_sleep: Callable[[float], None] = time.sleep


def forget(provider: str) -> None:
    """Drop any cached catalogue for `provider` — a key change must never search with a list
    fetched under the old key."""
    if provider == "openrouter":
        _OR_CACHE.clear()


def _per_million(v: Any) -> float | None:
    """OpenRouter prices are USD per TOKEN, as strings. The tab shows per million."""
    x = _money(v)
    return None if x is None else round(x * 1_000_000, 4)


def _or_row(m: dict) -> dict:
    pricing = m.get("pricing") if isinstance(m.get("pricing"), dict) else {}
    return {"id": str(m.get("id") or ""), "name": str(m.get("name") or ""),
            "context_length": m.get("context_length") if isinstance(m.get("context_length"), int)
            else None,
            "price_in": _per_million(pricing.get("prompt")),
            "price_out": _per_million(pricing.get("completion")),
            "supported_parameters": [str(x) for x in (m.get("supported_parameters") or [])
                                     if isinstance(x, str)]}


def _openrouter_catalogue(cfg: ApiConfig) -> list[dict]:
    hit = _OR_CACHE.get(cfg.base_url)
    if hit and _now() - hit[0] < OPENROUTER_CACHE_SECONDS:
        return hit[1]
    t0 = time.monotonic()
    body = _request(cfg, "/v1/models", timeout=SEARCH_TIMEOUT)
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list):
        raise ApiUnreachable(f"{cfg.label}'s model list was not a list")
    rows = [_or_row(m) for m in data if isinstance(m, dict) and m.get("id")]
    _OR_CACHE[cfg.base_url] = (_now(), rows)
    logger.info(f"llmapi: OpenRouter catalogue fetched — {len(rows)} models in "
                f"{time.monotonic() - t0:.1f}s, cached {OPENROUTER_CACHE_SECONDS:.0f}s")
    return rows


def _matches(terms: list[str], row: dict) -> bool:
    hay = f"{row['id']} {row['name']}".lower()
    return all(t in hay for t in terms)


def _fl_row(m: dict) -> dict:
    def num(k):
        v = m.get(k)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    return {"id": str(m.get("id") or ""), "name": str(m.get("name") or m.get("id") or ""),
            "model_class": str(m.get("model_class") or ""),
            "context_length": num("context_length"),
            "max_completion_tokens": num("max_completion_tokens"),
            "concurrency_cost": num("concurrency_cost")}


def search(cfg: ApiConfig, q: str, limit: int = SEARCH_LIMIT) -> list[dict]:
    """Return models matching every whitespace-separated query term in id or display name, case-insensitively. Rank ids beginning with the first term first. For Featherless, forward the query and request models available on the current plan."""
    q = " ".join(str(q or "").split())
    if not q:
        return []
    if cfg.provider == "openrouter":
        terms = q.lower().split()
        hits = [r for r in _openrouter_catalogue(cfg) if _matches(terms, r)]
        first = terms[0]
        hits.sort(key=lambda r: 0 if (r["id"].lower().split("/")[-1].startswith(first)
                                     or r["id"].lower().startswith(first)) else 1)
        return hits[:limit]
    qs = urllib.parse.urlencode({"q": q, "available_on_current_plan": "true",
                                 "per_page": str(limit)})
    body = _request(cfg, f"/v1/models?{qs}", timeout=SEARCH_TIMEOUT)
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list):
        raise ApiUnreachable(f"{cfg.label}'s model search did not return a list")
    return [_fl_row(m) for m in data if isinstance(m, dict) and m.get("id")][:limit]


# ── the editor's transport ────────────────────────────────────────────────────

def chat_post(cfg: ApiConfig) -> Callable:
    """`post(path, body, timeout)` for `ChatCompletions`, with every failure translated.

    - `ApiUnreachable` → `TransportError`: the runner retries it. On a 429 this waits first —
      Retry-After if given, else `BUSY_WAIT_DEFAULT`, capped — because the runner's own backoff
      (1.5 s, 3 s) is shorter than a concurrency slot takes to free.
    - `ApiRefused` → `BackendRefused`: the pass ends at once with the sentence `_refusal` built.

    🔴 **THE REFUSAL NEVER CARRIES THE PROVIDER'S WORDING (I16).** `ApiRefused.detail` is dropped
    here on purpose. A moderation refusal can quote the flagged input, the flagged input IS the
    field, and the pass's failure reason reaches the browser, the log and the Pass record.

    One log line per call — provider, model, seconds, HTTP outcome, and the token counts from
    `usage` — and never a byte of either body. The line also carries the running total for the pass
    (design §5): `resolve()` builds one transport per pass, so this closure's `totals` IS the pass.
    """
    totals = {"calls": 0, "prompt": 0, "completion": 0}

    def post(path: str, body: Any, timeout: float) -> Any:
        model = str((body or {}).get("model") or "") if isinstance(body, dict) else ""
        t0 = time.monotonic()
        try:
            reply = _request(cfg, path, body, timeout=timeout)
        except ApiUnreachable as exc:
            took = time.monotonic() - t0
            if exc.status == 429:
                wait = min(BUSY_WAIT_CAP, exc.retry_after if exc.retry_after is not None
                           else BUSY_WAIT_DEFAULT)
                logger.warning(f"llmapi: {cfg.label} {model} busy (429) after {took:.1f}s — "
                               f"waiting {wait:.0f}s before the retry")
                _sleep(max(0.0, wait))
            else:
                logger.warning(f"llmapi: {cfg.label} {model} failed after {took:.1f}s — {exc}")
            raise TransportError(str(exc)) from exc
        except ApiRefused as exc:
            logger.error(f"llmapi: {cfg.label} {model} refused (HTTP {exc.status}) — "
                         f"ending the pass")
            if exc.status == 404:
                raise BackendRefused(
                    f"{cfg.label} does not know the model {model!r} (HTTP 404). Pick another on "
                    f"LLM ▸ API.") from exc
            if exc.status == 400:
                raise BackendRefused(
                    f"{cfg.label} refused the request (HTTP 400). The model may not accept one "
                    f"of the settings Vocalis sends, or the field may be longer than its "
                    f"context.") from exc
            raise BackendRefused(str(exc)) from exc
        # 🔴 A REASONING-ONLY REPLY IS AN UNREADABLE REPLY, NOT A NETWORK FAULT.
        # OpenRouter answers `content: null` when a thinking model spends the whole budget
        # reasoning. `ChatCompletions` treats a non-string content as a transport fault — right for
        # KoboldCpp, and pinned by `test_wbedit_prompt.py`, so it is NOT changed there — which here
        # retried the same prompt blind and failed the field as "transport", a network fault that
        # never happened. Normalised to "" in THIS transport only, it takes the runner's
        # unreadable-reply path instead: hosted engines retry without an assistant prefill,
        # which some providers reject, then attempt salvage and finally FAILED as unparseable.
        # The call count is the same; the failure label no longer invents a network fault.
        try:
            msg = reply["choices"][0]["message"]
            if isinstance(msg, dict) and msg.get("content") is None:
                msg["content"] = ""
        except (KeyError, IndexError, TypeError):
            pass    # a malformed reply is ChatCompletions' to classify; nothing to normalise
        usage = reply.get("usage") if isinstance(reply, dict) else None
        usage = usage if isinstance(usage, dict) else {}
        totals["calls"] += 1
        for k, src in (("prompt", "prompt_tokens"), ("completion", "completion_tokens")):
            v = usage.get(src)
            if isinstance(v, int) and not isinstance(v, bool):
                totals[k] += v
        logger.info(f"llmapi: {cfg.label} {model} answered in {time.monotonic() - t0:.1f}s — "
                    f"prompt {usage.get('prompt_tokens', '?')} / completion "
                    f"{usage.get('completion_tokens', '?')} tokens; pass so far: "
                    f"{totals['calls']} calls, {totals['prompt']} / {totals['completion']}")
        return reply

    return post
