"""Control llama.cpp servers over HTTP without modifying their models, launch flags, or presets. Distinguish router mode from a single-model server using /props; API keys are optional, and a successful load response means the model started loading, not that loading finished."""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

# 9.5: the locality and TLS policies are shared with `src/kobold.py`. Do NOT re-derive either
# here — modelhost's header has the argument, and it is the one `wbedit/backends/kobold_chat.py`
# already made: half a copy of a locality policy is worse than none.
import modelhost

logger = logging.getLogger(__name__)

#: `GET /props` carries this only in router mode (`server-models.cpp`, `get_router_props`). A
#: single-model server answers the loaded model's own props, with no `role` key at all.
ROUTER_ROLE = "router"

#: `server-models.h:32-60`. Every status a model can report.
STATUS_DOWNLOADING = "downloading"
STATUS_DOWNLOADED = "downloaded"
STATUS_UNLOADED = "unloaded"
STATUS_LOADING = "loading"
STATUS_LOADED = "loaded"
STATUS_SLEEPING = "sleeping"

#: 🔴 `is_running()` in llama.cpp's own terms (`server-models.h:93-95`) — the router will route
#: to any of these. **`sleeping` is in here and it holds NO VRAM**, which is why nothing in
#: Vocalis may infer memory from a status word. See `holds_vram()`.
RUNNING_STATUSES = frozenset({STATUS_LOADED, STATUS_LOADING, STATUS_SLEEPING})

#: so the routes can report a useful error instead of echoing the generic response.
MASKED_404_MESSAGE = "File Not Found"


@dataclass
class LlamaConfig:
    url: str = ""          # the anchor. "" means NOT CONFIGURED — that is the tab's whole gate.
    api_key: str = ""      # OPTIONAL. "" is a perfectly good working config, unlike Kobold's.
    local: bool = True     # is llama-server on THIS box? gates every VRAM claim. Never from VRAM.
    cafile: str = ""       # Optional CA bundle used to verify the server certificate.


def resolve_config(app_settings: dict, secrets: dict | None = None) -> LlamaConfig:
    """env -> app_settings.yaml -> unset. The house idiom, same shape as `kobold.resolve_config`.

    `secrets` is voice_settings.yaml's `llama` section — the ENCRYPTED half, and the API key is
    the only thing that comes from it. url/local/cafile are deployment config, carry no secret,
    and must stay readable while the vault is locked or the tab cannot render at all.

    🔴 **THE URL HAS NO DEFAULT, AND THAT IS THE DESIGN (§4c).** Kobold's `resolve_config`
    defaults to `https://127.0.0.1:5001`, which is right for it — its sub-tab gates on the admin
    password instead, so a default URL gates nothing. Here the URL *is* the gate: a default would
    make `llama.url is set` true on every box on earth and light up a sub-tab for a server nobody
    is running. Unset means unset.
    """
    s = app_settings.get("llama")
    if not isinstance(s, dict):        # a hand-edited `llama: "oops"` must not raise here
        s = {}
    sec = secrets if isinstance(secrets, dict) else {}

    def pick(env_key, settings_key, default=""):
        v = os.environ.get(env_key)
        if v is None:
            v = s.get(settings_key)
        return default if v is None else v

    url = str(pick("VOCALIS_LLAMA_URL", "url", "")).strip().rstrip("/")

    explicit_local = os.environ.get("VOCALIS_LLAMA_LOCAL")
    if explicit_local is not None:
        explicit_local = explicit_local.strip().lower() in ("1", "true", "yes", "on")
    elif "local" in s:
        explicit_local = bool(s.get("local"))

    return LlamaConfig(
        url=url,
        # 🔴 NOT from app_settings, for the reason 4.7 established for Kobold's password: a
        # secret readable while the vault is locked is a secret sitting in plaintext. The env
        # var still wins (the systemd/vocalis.env path).
        api_key=str(os.environ.get("VOCALIS_LLAMA_API_KEY") or sec.get("api_key") or ""),
        local=modelhost.is_local_url(url, explicit_local),
        cafile=str(pick("VOCALIS_LLAMA_CAFILE", "cafile", "")),
    )


def configured(cfg: LlamaConfig) -> bool:
    """Return whether management is configured. A URL is required; an API key is optional for llama-server. This reports configuration only, not reachability, so a configured but unavailable server remains distinguishable from a missing URL."""
    return bool(str(cfg.url or "").strip())


# ── the HTTP boundary (everything llama-server-facing goes through here) ──────

class LlamaUnreachable(Exception):
    """No llama-server answered. Distinct from 'answered, but said no' — the tab renders these
    differently, and conflating them is how "can't see it" becomes "there's nothing there"."""


class LlamaAuthFailed(Exception):
    """llama-server answered 401. Unlike KoboldCpp — which reports a wrong password as a 200 with
    an empty list, indistinguishable from four other states — this one is unambiguous, so it gets
    its own type and a message that can actually name the cause."""


class LlamaNotRouter(Exception):
    """Raised when the server is running in single-model mode and does not expose router management routes. This is a valid read-only destination, not a server failure."""


def _request(cfg: LlamaConfig, path: str, body=None, timeout: float = 10.0,
             method: str | None = None):
    """Send one HTTP request and return parsed JSON. Include the configured key on every request. Router load failures that arrive as 404 are ambiguous because the server may replace the detailed body with a generic not-found response; report that ambiguity instead of presenting it as a missing local file."""
    # Reject scheme-less URLs with a clear configuration error before calling urllib.
    if not str(cfg.url or "").strip().lower().startswith(("http://", "https://")):
        raise LlamaUnreachable(
            "llama.cpp has no URL configured — set it in ⚙ Settings ▸ llama.cpp, or in "
            "app_settings.yaml's `llama:` block.")
    url = f"{cfg.url}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if cfg.api_key:
        req.add_header("Authorization", f"Bearer {cfg.api_key}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    ctx = modelhost.ssl_context(cfg.cafile, cfg.local)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            if resp.status != 200:
                raise LlamaUnreachable(f"HTTP {resp.status} from {url}")
            return json.loads(resp.read().decode("utf-8"))
    except (LlamaUnreachable, LlamaAuthFailed, LlamaNotRouter):
        raise
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise LlamaAuthFailed(
                f"llama-server rejected the API key ({url}). Check ⚙ Settings ▸ llama.cpp — or "
                f"clear the key if the server was started without --api-key.") from exc
        if exc.code == 404:
            # See the docstring. The body is a generic placeholder; do not quote it.
            raise LlamaUnreachable(
                f"llama-server answered 404 for {path}. That means one of three things and it "
                f"does not say which: the model name is not one it offers, the URL is wrong, or "
                f"it was started with a fixed model (-m) and has no model-management routes.") \
                from exc
        raise LlamaUnreachable(f"HTTP {exc.code} from {url}") from exc
    except (OSError, ValueError) as exc:
        # put a client bug behind a message that incorrectly reports a server failure.
        raise LlamaUnreachable(f"{url}: {exc}") from exc


def health(cfg: LlamaConfig) -> dict:
    """`GET /health` — the honest, ALWAYS-UNAUTHENTICATED probe.

    🔴 It is public even when `--api-key` is set (`server.cpp:233`, and `server-http.cpp:197-204`
    lists exactly `/health`, `/v1/health` and the embedded UI assets). So it answers "is anything
    listening" without needing a credential to be correct first — which is what makes the two-step
    ladder in `info()` able to tell "down" from "wrong key"."""
    return _request(cfg, "/health", timeout=5.0)


def props(cfg: LlamaConfig) -> dict:
    """Read /props to determine the server mode. Router responses include role=router; single-model responses omit the role key."""
    return _request(cfg, "/props")


def mode(cfg: LlamaConfig) -> str:
    """'router' | 'single'. Raises rather than guessing.

    🔴 EVERY DECISION ABOUT WHETHER LOAD/UNLOAD EXIST GOES THROUGH HERE, and none of them may be
    made by probing `/models/load` and reading the answer — that route's 404 is masked (see
    `_request`) and cannot distinguish "not a router" from "no such model". Ask `/props`."""
    p = props(cfg)
    if not isinstance(p, dict):
        raise LlamaUnreachable(f"{cfg.url}/props answered with {type(p).__name__}, not an object")
    return ROUTER_ROLE if p.get("role") == ROUTER_ROLE else "single"


def available(cfg: LlamaConfig) -> tuple:
    """(is there a llama-server at cfg.url?, why not). Never raises — 'no llama-server' is a
    normal state on a dev box, not an error. Same shape as `kobold.available`."""
    if not configured(cfg):
        return False, "no llama.cpp URL is configured"
    try:
        h = health(cfg)
    except (LlamaUnreachable, LlamaAuthFailed) as exc:
        return False, str(exc)
    if not isinstance(h, dict) or "status" not in h:
        return False, f"{cfg.url} answered, but not with llama-server's /health JSON"
    return True, ""


# ── the model list ────────────────────────────────────────────────────────────

def holds_vram(status: str) -> bool:
    """Is a model in this state actually occupying the cards?

    🔴 **`sleeping` IS THE WHOLE REASON THIS FUNCTION EXISTS.** With `--sleep-idle-seconds`, a
    model that has been idle is unloaded from memory — KV cache included — and reloaded on the
    next task. It still reports as running, the router still routes to it, and it holds NOTHING.
    So `is_running()` and "is on the cards" are different questions and only this one is about
    memory.

    ⚠️ Even a True here is a statement about STATE, never a quantity. Every GB figure Vocalis
    prints is measured off the cards (`gpu.other_vram_gb`), because a remote engine's memory has
    no sensor this box can read and the measurement answers a plausible 0.0 rather than erroring.
    """
    return status == STATUS_LOADED


def _row(m: dict) -> dict:
    """Reduce one /models entry to fields used by the UI. The router may provide generated status arguments and preset data for models loaded from the configured models directory; do not depend on local preset files."""
    status = m.get("status") if isinstance(m.get("status"), dict) else {}
    value = str(status.get("value") or "")
    row = {
        "id": str(m.get("id") or ""),
        "aliases": [str(a) for a in (m.get("aliases") or []) if a],
        "tags": [str(t) for t in (m.get("tags") or []) if t],
        "status": value,
        "running": value in RUNNING_STATUSES,
        "holds_vram": holds_vram(value),
        "source": str(m.get("source") or ""),
        # `is_failed()` is UNLOADED *with* a non-zero exit code (server-models.h:101-103) — a
        # crashed load, which reads identically to "nobody asked for it" unless we say so.
        "failed": bool(status.get("failed")),
        "args": [str(a) for a in (status.get("args") or [])],
    }
    if status.get("exit_code") is not None:
        row["exit_code"] = status.get("exit_code")
    if status.get("preset"):
        row["preset"] = str(status.get("preset"))
    if isinstance(status.get("progress"), dict):
        row["progress"] = status["progress"]
    # Merged in from the child's own /v1/models once it is running — n_ctx as LOADED vs
    # n_ctx_train, n_params, on-disk size, ftype. Absent while unloaded, which is honest.
    if isinstance(m.get("meta"), dict):
        row["meta"] = m["meta"]
    arch = m.get("architecture")
    if isinstance(arch, dict) and arch.get("input_modalities"):
        row["input_modalities"] = [str(x) for x in arch["input_modalities"]]
    return row


def list_models(cfg: LlamaConfig, reload: bool = False) -> list:
    """`GET /models`. The drop-down's source of truth, asked of llama-server rather than of disk.

    Works in BOTH modes: a router lists everything its sources offer, a single-model server lists
    the one model it was started with. The caller decides what to do with that; this does not
    pretend a single-model server is empty.

    `reload=True` sends `?reload=1`, which re-reads the sources — how a hand-edited preset file
    gets picked up. Never sent on a poll: it makes the server do real work, and a status poll
    running every few seconds must stay cheap.

    ⚠️ An empty list here is genuinely empty, unlike KoboldCpp's `[]` (which also means wrong
    password / admin off / missing dir). llama-server says 401 when it means 401.
    """
    path = "/models?reload=1" if reload else "/models"
    body = _request(cfg, path, timeout=30.0 if reload else 10.0)
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list):
        raise LlamaUnreachable(
            f"/models answered {type(data).__name__}, expected a list under `data`")
    rows = [_row(m) for m in data if isinstance(m, dict)]
    # Sort by id only. Treat ids as opaque names and do not infer meaning from their ordering.
    rows.sort(key=lambda r: r["id"].lower())
    return rows


def status(cfg: LlamaConfig) -> dict:
    """What is loaded right now: `{"loaded": bool, "models": [...], "mode": "router"|"single"}`.

    One `/props` (for the mode) and one `/models` (for the list). `loaded` means at least one
    model is **holding VRAM** — deliberately not `running`, because `sleeping` is running and
    holds nothing, and this bool is what the render-conflict offer and the tab's headline read.
    """
    m = mode(cfg)
    rows = list_models(cfg)
    out = {"mode": m, "models": rows,
           "loaded": any(r["holds_vram"] for r in rows),
           "running": [r["id"] for r in rows if r["running"]]}
    if m == ROUTER_ROLE:
        try:
            p = props(cfg)
            # Launch flags Vocalis does NOT get to set and must therefore not assume. A UI that
            # silently assumes max_instances is 1 will be wrong on somebody's box — and with
            # autoload on, a model can appear because SillyTavern asked for it, with no click
            # here at all (§6a). That is why the model list is live state, never a record of
            # what Vocalis did.
            out["max_instances"] = p.get("max_instances")
            out["models_autoload"] = bool(p.get("models_autoload"))
        except (LlamaUnreachable, LlamaAuthFailed):
            pass                      # the mode already succeeded; these are decoration
    return out


# Model load and unload

def load(cfg: LlamaConfig, name: str) -> dict:
    """`POST /models/load`. Returns llama-server's body.

    🔴 **`{"success": true}` MEANS STARTED, NOT READY**, and that is the same landmine 4.7
    measured on KoboldCpp's queued `reload_config` (response at t=0.01 s against a swap that
    completed seconds later). Read from source at `0cc5b1495`: `server_models::load()` spawns the
    child, sets its status to `loading`, and RETURNS — the handler answers immediately. So
    anything that reads state (or VRAM) off this response is reading the state from BEFORE the
    call. Poll `list_models()` until the id reports `loaded`.

    ⚠️ A 404 here is ambiguous by construction — see `_request`. It can mean the model is not one
    llama-server offers, OR that this is a single-model server with no such route at all. The
    route layer establishes the mode from `/props` FIRST so it can say which; do not try to infer
    it from this call's failure.
    """
    return _request(cfg, "/models/load", body={"model": name}, timeout=20.0)


def unload(cfg: LlamaConfig, name: str) -> dict:
    """Request model unload and return the server response. Unload errors use a readable 400 response, unlike ambiguous 404 errors from the load route. Model shutdown can take up to the configured stop timeout before forced termination."""
    return _request(cfg, "/models/unload", body={"model": name}, timeout=20.0)


#: The `/slots` allowlist excludes prompt text and prevents unexpected fields from appearing in status panels or logs. Because the current response shape has not been verified with a resident model, parse defensively: keep only known numeric fields and ignore absent fields.
KV_FIELDS = ("n_prompt_tokens_cache", "n_ctx", "n_past", "n_decoded", "n_prompt_tokens")


def kv_cache(cfg: LlamaConfig, name: str) -> dict:
    """Return prompt-cache figures for a model, or an empty mapping when the status endpoint is unavailable, unsupported, or returns invalid data. This is decorative status and must not turn a working tab into an error. Pass the model identifier to /slots in both router and single-model modes."""
    if not str(name or "").strip():
        return {}
    try:
        body = _request(cfg, "/slots?model=" + urllib.parse.quote(str(name)), timeout=5.0)
    except (LlamaUnreachable, LlamaAuthFailed, LlamaNotRouter):
        return {}
    # `/slots` answers a LIST of slot objects. Take the first that carries any number we asked
    # for; a server that answers an object instead is accepted too rather than dropped.
    rows = body if isinstance(body, list) else [body] if isinstance(body, dict) else []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out = {k: row[k] for k in KV_FIELDS
               if isinstance(row.get(k), int) and not isinstance(row.get(k), bool)}
        if out:
            return out
    return {}


def is_loaded(cfg: LlamaConfig, name: str) -> bool:
    """Has `name` actually reached `loaded`? The watcher's predicate.

    🔴 `loaded`, NOT `is_running()`. `loading` is running and is precisely the state we are
    waiting to LEAVE; `sleeping` is running and holds nothing. A watcher that accepted either
    would declare victory at t=0 on the first poll after the request.
    """
    for r in list_models(cfg):
        if r["id"] == name:
            return r["holds_vram"]
    return False
