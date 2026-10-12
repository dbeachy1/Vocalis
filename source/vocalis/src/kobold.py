"""Control a KoboldCpp server without editing its configuration files.

Discover accepted configs through Kobold HTTP endpoints, load or unload models, and
reconcile the reported model with the selected config. Config names may include a subdirectory
prefix, and a successful load response means the operation is queued; poll status for completion.
"""

from __future__ import annotations

import json
import logging
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

# 9.5: the locality and TLS policies live here now, shared with `src/llama.py`. Stdlib-only,
# like this module — see modelhost's header for why there must be exactly one copy of each.
import modelhost

logger = logging.getLogger(__name__)

# Kobold appends these to every admin list; they are commands, not configs (koboldcpp.py
# :1490-1491). `unload_model` is the Unload button, not something to offer in a drop-down.
PSEUDO_CONFIGS = ("initial_model", "unload_model")

# File types accepted by KoboldCpp's admin list, including model files.
CONFIG_EXTS = (".kcpps", ".kcppt", ".gguf")

# The string /api/v1/model reports when the request didn't authenticate but Kobold answered
# 200 anyway (koboldcpp.py:6174). It is an auth failure wearing a success. NOT a model.
PROTECTED_SENTINEL = "koboldcpp/protected-model"

# Locality constants and policy live in modelhost; do not duplicate them here.


@dataclass
class KoboldConfig:
    url: str                  # the anchor — everything but the two local-only rows rides this
    adminpassword: str = ""   # "" -> writes are disabled; see available()/can_admin()
    local: bool = True        # is Kobold on THIS box? gates every capability that reads a
                              # local sensor or a local disk (§2b). Never inferred from VRAM.
    admindir: Path = None     # local-only: where the kcpps files actually are
    cafile: str = ""          # optional CA bundle for TLS verification
    last_config: str = ""     # written by a SUCCESSFUL load only
    model_map: dict = None    # learned {config -> reported model string}, §3a-bis

    def __post_init__(self):
        if self.model_map is None:
            self.model_map = {}


def _is_local(url: str, explicit=None) -> bool:
    """Delegate locality checks to the shared model-host policy."""
    return modelhost.is_local_url(url, explicit)


def resolve_config(app_settings: dict, secrets: dict | None = None) -> KoboldConfig:
    """Resolve URL and local-only settings from environment and application configuration.

    `secrets` is voice_settings.yaml's `kobold` section — the ENCRYPTED half. It is optional
    and defaults to none so that every pre-existing caller (and every test) still resolves
    url/local/admindir exactly as before; only the admin password reads from it."""
    s = app_settings.get("kobold")
    if not isinstance(s, dict):          # a hand-edited `kobold: "oops"` must not raise here
        s = {}

    # `secrets` is the `kobold` section of voice_settings.yaml — the ROUTED file. Only the
    # admin password comes from there; url/admindir/cafile are deployment config, carry no
    # secret, and must stay readable while the vault is locked so the tab can still render.
    sec = secrets if isinstance(secrets, dict) else {}

    def pick(env_key, settings_key, default=""):
        v = os.environ.get(env_key)
        if v is None:
            v = s.get(settings_key)
        return default if v is None else v

    # 🔴 NO BUILT-IN ADDRESS IN THE DOCKER IMAGE (release audit, 2026-10-11, item 8). 127.0.0.1
    # there is the container itself, so the old default made the tab open on "KoboldCpp isn't
    # answering at https://127.0.0.1:5001" for a server nobody ever pointed it at. An empty URL
    # is already a handled state (`_request` says "no URL configured"); the tab shows it as
    # "not set up yet". A non-Docker run keeps the default, which is right on one machine.
    from vocalis.runtime import paths
    default_url = "" if paths.docker_encrypted_mode() else "https://127.0.0.1:5001"
    url = str(pick("VOCALIS_KOBOLD_URL", "url", default_url)).strip().rstrip("/")

    explicit_local = os.environ.get("VOCALIS_KOBOLD_LOCAL")
    if explicit_local is not None:
        explicit_local = explicit_local.strip().lower() in ("1", "true", "yes", "on")
    elif "local" in s:
        explicit_local = bool(s.get("local"))
    local = _is_local(url, explicit_local)

    admindir = pick("VOCALIS_KOBOLD_ADMINDIR", "admindir", "")
    mm = s.get("model_map")
    return KoboldConfig(
        url=url,
        # Prefer the environment override; otherwise read the encrypted setting. With the vault
        # locked, no stored secret is available and admin writes remain disabled.
        adminpassword=str(os.environ.get("VOCALIS_KOBOLD_ADMINPASSWORD")
                          or sec.get("adminpassword") or ""),
        local=local,
        # Local-only, and only ever used for the detail line. Resolved even when remote so
        # the value round-trips through settings, but every READ of it is gated on `local`.
        admindir=Path(admindir) if admindir else (Path.home() / "koboldcpp" / "kcpps"),
        cafile=str(pick("VOCALIS_KOBOLD_CAFILE", "cafile", "")),
        last_config=str(s.get("last_config") or ""),
        model_map=dict(mm) if isinstance(mm, dict) else {},
    )


# ── the HTTP boundary (everything Kobold-facing goes through here) ────────────

def _ssl_context(cfg: KoboldConfig):
    """Delegate TLS verification policy to the shared model-host implementation."""
    return modelhost.ssl_context(cfg.cafile, cfg.local)


class KoboldUnreachable(Exception):
    """No Kobold answered. Distinct from 'answered, but said no' — the tab renders these
    differently and conflating them is how "can't see it" becomes "there's nothing there"."""


def _request(cfg: KoboldConfig, path: str, body=None, timeout: float = 10.0):
    """One call to Kobold's HTTP API. Returns parsed JSON.

    Always send the configured Bearer token, including on status reads. KoboldCpp may return
    a protected-model placeholder with HTTP 200 when authentication fails.
    """
    # Reject missing or scheme-less URLs with a configuration-specific error before urllib parses
    # the request.
    if not str(cfg.url or "").strip().lower().startswith(("http://", "https://")):
        raise KoboldUnreachable(
            "KoboldCpp has no URL configured — set it in Settings, or in app_settings.yaml's "
            "`kobold:` block.")
    url = f"{cfg.url}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data)
    if cfg.adminpassword:
        req.add_header("Authorization", f"Bearer {cfg.adminpassword}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context(cfg)) as resp:
            if resp.status != 200:
                raise KoboldUnreachable(f"HTTP {resp.status} from {url}")
            return json.loads(resp.read().decode("utf-8"))
    except KoboldUnreachable:
        raise
    except urllib.error.HTTPError as exc:
        raise KoboldUnreachable(f"HTTP {exc.code} from {url}") from exc
    except ssl.SSLError as exc:
        # Worth its own message: it means Kobold IS there and answering, which "unreachable"
        # does not convey, and the fix is a setting (cafile) rather than starting a service.
        raise KoboldUnreachable(
            f"TLS verification failed for {url} ({exc.reason if hasattr(exc, 'reason') else exc}) "
            f"— set kobold.cafile to the CA that signed its certificate") from exc
    except Exception as exc:                                   # noqa: BLE001
        raise KoboldUnreachable(f"{url}: {exc}") from exc


def version(cfg: KoboldConfig) -> dict:
    """/api/extra/version — the honest, UNAUTHENTICATED probe. Its `admin` field is the
    cross-check that tells an auth failure apart from an empty admin dir, because
    list_options answers `[]` to both (see list_configs)."""
    return _request(cfg, "/api/extra/version")


def available(cfg: KoboldConfig) -> tuple:
    """(is there a Kobold at cfg.url?, why not). Never raises — 'no Kobold' is a normal
    state on the dev box, not an error. Same shape as comfyui_control_available()."""
    try:
        v = version(cfg)
    except KoboldUnreachable as exc:
        return False, str(exc)
    if not isinstance(v, dict):
        return False, f"{cfg.url} answered, but not with KoboldCpp's version JSON"
    return True, ""


# ── configs: the list, and what it means ─────────────────────────────────────

def _stem(name: str) -> str:
    """Return the config filename without its parent directory or extension."""
    return Path(name).stem


def display_label(name: str) -> str:
    """What the drop-down shows: the filename, minus the extension, with any subdirectory
    prefix kept VISIBLE.

    Config names are opaque apart from their path and extension.

    The subdir prefix is load-bearing, not noise: list_options descends one level, so a
    stray backup folder makes every config appear TWICE, and the prefix is the only thing
    telling a live config from a stale copy. Hiding it turns Load into a coin flip.
    """
    parent = str(Path(name).parent)
    stem = _stem(name)
    return f"{parent}/{stem}" if parent not in (".", "") else stem


def sort_key(name: str) -> tuple:
    """By stem, then top-level before subfoldered. No other meaning is read into the name.

    Config filenames are opaque; do not infer favorites or priority from their characters.
    Sort by stem, then prefer a top-level file over a duplicate in a subdirectory so copied
    configs do not win based on KoboldCpp's scan order.
    """
    return (_stem(name).lower(), len(Path(name).parts))


class KoboldAuthFailed(Exception):
    """list_options returned []. See list_configs for why that isn't 'no configs'."""


def list_configs(cfg: KoboldConfig) -> list:
    """The drop-down's source of truth, asked of KOBOLD rather than of the directory.

    Why HTTP and not a dir scan: reload_config jails on `targetfile in allowed_files`
    (koboldcpp.py:6862), so whatever this call returns is BY DEFINITION what a load will
    accept — it cannot drift from disk. And it works when Kobold is on another host, which
    reading the directory would not.

    Raises `KoboldAuthFailed` for an empty response because KoboldCpp uses the same empty list
    for invalid credentials, disabled admin mode, a missing config directory, and no configs.
    """
    opts = _request(cfg, "/api/admin/list_options")
    if not isinstance(opts, list):
        raise KoboldUnreachable(f"list_options returned {type(opts).__name__}, expected a list")
    if not opts:
        raise KoboldAuthFailed(
            "KoboldCpp returned an empty admin list. That means the admin password is wrong, "
            "admin mode is off, or its --admindir is missing — it does NOT mean there are no "
            "configs (Kobold answers 200 with [] to all of those)."
        )
    names = [o for o in opts
             if o not in PSEUDO_CONFIGS and str(o).lower().endswith(CONFIG_EXTS)]
    return sorted(names, key=sort_key)


def kcpps_path(cfg: KoboldConfig, name: str):
    """Resolve a config name under --admindir, or None if it escapes.

    The names come from Kobold, not from a browser, so this is not a live traversal hole —
    but a name is a RELATIVE PATH that may contain '/', and `admindir / name` is one
    refactor away from being one. Check rather than trust.
    """
    root = Path(cfg.admindir).resolve()
    try:
        p = (root / name).resolve()
    except (OSError, ValueError):
        return None
    return p if root in p.parents else None


def config_dir_readable(cfg: KoboldConfig) -> bool:
    """Can THIS process see the folder the .kcpps files are in?

    False is normal and not a fault in a container: `VOCALIS_KOBOLD_LOCAL=1` says KoboldCpp is on
    this machine, but the machine is the host and `admindir` is read from inside the container,
    where that folder is not mounted (release audit, 2026-10-11, item 2). The route turns this
    into a neutral "not readable from here" instead of a red "not found" per config."""
    try:
        return Path(cfg.admindir).is_dir()
    except (OSError, ValueError, TypeError):
        return False


def parse_kcpps(cfg: KoboldConfig, name: str, *, verify_model: bool = True) -> dict:
    """The detail line: ctx / gpulayers / model / does the model exist.

    LOCAL ONLY, and the caller must have checked. Remote, these files are on the other box:
    a bare open() here either raises on every row or — far worse — reads a coincidentally
    same-named local directory and confidently shows THE WRONG BOX'S CONFIGS.

    `verify_model=False` skips the "does the model file exist" probe. In the Docker image the
    `model_param` is a HOST path this container cannot see, so the probe would answer a false
    "missing" for every config; the caller passes False there and the field stays absent.

    A corrupt kcpps returns {"error": ...} rather than raising: one bad file must not 500
    the whole tab.
    """
    p = kcpps_path(cfg, name)
    if p is None:
        return {"error": "config path escapes the admin dir"}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"error": "not found"}
    except (OSError, ValueError) as exc:
        return {"error": f"unreadable: {exc}"}
    if not isinstance(d, dict):
        return {"error": "not a kcpps object"}
    mp = d.get("model_param") or ""
    out = {"model_param": mp,
           "contextsize": d.get("contextsize"),
           "gpulayers": d.get("gpulayers"),
           "usevulkan": d.get("usevulkan")}
    if mp and verify_model:
        # 5.x landmine: on a routed/locked vault store this answers False and NEVER raises,
        # so all four configs would read "missing" when the vault is merely locked. The
        # caller (configs_detail) distinguishes not-there from can't-see-it; here we only
        # report the bit.
        out["model_exists"] = Path(mp).exists()
    return out


# ── status, and which config is loaded ───────────────────────────────────────

def sanitize_string(s: str) -> str:
    """Kobold's own sanitizer (koboldcpp.py:10609-10612). It STRIPS the offending
    characters rather than replacing them: 'Foo Bar' -> 'FooBar'."""
    return re.sub(r"[^\w\d\.\-_]", "", s)


def derive_model_name(model_param: str) -> str:
    """What /api/v1/model will report for a config with this model_param.

    Kobold builds it as (koboldcpp.py:11563-11566):
        friendlymodelname = "koboldcpp/" + sanitize_string(splitext(basename(model_param))[0])

    The derived name is an exact mapping; preserve any model shard suffix.
    """
    base = os.path.basename(str(model_param or "").replace("\\", "/"))
    return "koboldcpp/" + sanitize_string(os.path.splitext(base)[0])


def status(cfg: KoboldConfig) -> dict:
    """{"loaded": bool, "model": str|None}. `model` is the raw reported string."""
    m = _request(cfg, "/api/v1/model")
    res = (m or {}).get("result") if isinstance(m, dict) else None
    res = str(res) if res is not None else ""
    if res == PROTECTED_SENTINEL:
        # Not a model — an auth failure wearing a 200 (koboldcpp.py:6174).
        raise KoboldAuthFailed(
            "KoboldCpp answered with its protected-model placeholder — the admin password "
            "is not being accepted. (It returns this as a 200, not a 401.)")
    loaded = bool(res) and res.lower() != "inactive"
    return {"loaded": loaded, "model": res if loaded else None}


def reconcile(cfg: KoboldConfig, model: str, names: list) -> dict:
    """Name the config behind a loaded model. Returns {"config": name|None, "how": ...}.

    "Which config is loaded" is NOT directly observable: /api/v1/model reports the MODEL, and
    although Kobold's parent tracks the config filename (global_memory["current_model"]) it
    exposes it through no endpoint. So:

      * Vocalis loaded it     -> we know. Authoritative.
      * Local                 -> derive from each kcpps's model_param.
      * Remote                -> the learned X->Y map, recorded when WE loaded X and observed
                                 Y. Measurement, not inference, so it works either way — but
                                 it goes stale if a kcpps points to another gguf, which
                                 is why a fresh local derivation OUTRANKS it.
      * No hit, or a tie      -> say "loaded outside Vocalis" and show the raw string.

    Never guess a config onto a model Vocalis didn't load.
    """
    if not model:
        return {"config": None, "how": "none"}
    if cfg.local:
        hits = []
        for n in names:
            mp = parse_kcpps(cfg, n).get("model_param")
            if mp and derive_model_name(mp) == model:
                hits.append(n)
        if len(hits) == 1:
            return {"config": hits[0], "how": "derived"}
        if len(hits) > 1:
            # Duplicate configs can derive the same reported model name. Prefer a previously
            # observed config only when this process loaded it; otherwise preserve ambiguity.
            #
            # What breaks it is the one thing that outranks a derivation: we LOADED it, and
            # watched this exact string appear. That is a measurement of which config was
            # used, which is precisely what the derivation is only inferring.
            for name, seen in (cfg.model_map or {}).items():
                if seen == model and name in hits:
                    return {"config": name, "how": "learned", "candidates": hits}
            # Nobody loaded it through Vocalis, so there is genuinely nothing to choose on.
            # A tie is not a license to guess.
            return {"config": None, "how": "ambiguous", "candidates": hits}
    # Remote hosts do not expose model_param, so use the observed map only when local
    # derivation is unavailable.
    for name, seen in (cfg.model_map or {}).items():
        if seen == model and name in names:
            return {"config": name, "how": "learned"}
    return {"config": None, "how": "outside"}


def pick_default(cfg: KoboldConfig, names: list, loaded_config=None) -> str:
    """What the drop-down opens on: current loaded config, last successful choice, then first.

    1. a model is loaded and we can name its config -> that
    2. last_config (only ever written by a SUCCESSFUL load — a failed one must not poison it)
    3. first in the sorted list

    A last_config naming a renamed/deleted config falls through. Never an error, never an
    empty select.
    """
    if loaded_config and loaded_config in names:
        return loaded_config
    if cfg.last_config and cfg.last_config in names:
        return cfg.last_config
    return names[0] if names else ""


def load(cfg: KoboldConfig, name: str) -> dict:
    """POST reload_config. Returns Kobold's body.

    A successful response means the supervisor queued the operation, not that it completed.
    Poll `status()` before making decisions about the resulting model state.
    """
    return _request(cfg, "/api/admin/reload_config", body={"filename": name}, timeout=20.0)


def unload(cfg: KoboldConfig) -> dict:
    """Free Kobold's VRAM by unloading the model and letting the supervisor respawn.

    `unload_model` is a first-class pseudo-config that reload_config special-cases before
    the jail check (koboldcpp.py:6851-6855). Process death is the only thing that releases
    VRAM on this stack (see vocalis_server.py's note at the ComfyUI block).

    NOTE it also drops the HTTP listener for ~4.3s — the listening socket belongs to the
    model child itself, not the supervisor. The design used to claim the listener survives;
    it does not, and a live SillyTavern loses its connection, not merely its reply.
    """
    return _request(cfg, "/api/admin/reload_config", body={"filename": "unload_model"},
                    timeout=20.0)
