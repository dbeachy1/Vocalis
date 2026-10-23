"""The satellite registry: what satellites exist, and how to reach them.

Defined in `app_settings.yaml` alongside per-device worker settings. Each configured satellite
adds a virtual device to the device list:

    satellites:
      - name: remote
        url: https://satellite.example:7880
        cert: certs/satellite.pem     # the pinned public certificate
        secret: <64 hex chars>        # this pair's master; see the warning below

⚠️ **The secret lives in `app_settings.yaml`, which is deliberately unencrypted.** That is
consistent with existing practice rather than an oversight — the file already holds Kobold's
admin password as of 4.7 and is written 0600 for exactly that reason (`settings.save_app_settings`).
It cannot go in the vault without a bootstrap problem: the registry is read to decide which
devices exist, which happens before anything is unlocked. The mitigation is the file mode, and
the fact that the secret is useless without also reaching the satellite's TLS endpoint.

**Device naming is load-bearing.** A satellite card is `<satellite>:<device>` — for example,
`remote:cuda:0` — which does not start with `cuda`. That makes `WorkerPool`'s `is_cuda` branch skip
`torch.cuda.set_device`, the `act_headroom_gb` fit check and `empty_cache` for remote workers,
with no edit to that tuned code at all. See DESIGN_5_3_SATELLITES §3.2.
"""
import functools
import re
import threading

from loguru import logger

from vocalis.runtime import paths, settings

_clients = {}
_lock = threading.Lock()


def configured() -> list:
    """Every satellite entry from settings, normalized. Never raises — a broken entry is
    skipped with a warning, because this is read on the Settings page and a malformed URL must
    not take the page down."""
    out = []
    for raw in (settings.load_app_settings().get("satellites") or []):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        url = str(raw.get("url") or "").strip()
        if not name or not url:
            # Do not log the raw entry: it may contain the shared secret and logs are served
            # through the application UI. Omit that field from the diagnostic context.
            logger.warning(f"satellite entry missing name or url — skipped: "
                           f"{ {k: v for k, v in raw.items() if k != 'secret'} !r}")
            continue
        out.append({"name": name, "url": url,
                    "cert": str(raw.get("cert") or "").strip() or None,
                    "secret": str(raw.get("secret") or "").strip() or None,
                    # §17 — the per-card VRAM ceiling, in GB. 0 is uncapped and is the default.
                    # Normalized HERE so a hand-edited `vram_cap_gb: "eight"` cannot reach the
                    # wire: this file is read on every /devices GET and must never raise.
                    "vram_cap_gb": _cap_or_zero(raw.get("vram_cap_gb")),
                    # Maximum SillyTavern speech chunks per satellite batch. The default of one
                    # avoids delaying playback until every row in a larger batch has decoded.
                    # Normalize here so malformed settings never reach the request path.
                    "st_max_batch": _st_batch_or_one(raw.get("st_max_batch"))})
    return out


def _cap_or_zero(v) -> float:
    """Return a VRAM cap in GB, or 0.0 for no cap. Never raises; see `configured`.

    The 1024 GB ceiling rejects implausible settings; it is not a hardware measurement. The cap
    is configured before Vocalis connects to the satellite.
    """
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if f != f or f <= 0:                    # NaN, negative, or an explicit 0
        return 0.0
    return round(min(f, 1024.0), 2)


def _st_batch_or_one(v) -> int:
    """The SillyTavern batch ceiling for one satellite, as an int of 1..64. Never raises — see
    `configured`.

    Invalid or missing settings default to one chunk, the conservative value for playback latency.
    The upper bound matches `RemoteModel.batch_slice` so this setting cannot exceed the satellite's
    own limit.
    """
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return 1
    return max(1, min(n, 64))


def entry(name: str):
    for e in configured():
        if e["name"] == name:
            return e
    return None


def cert_dir():
    """Where pinned satellite certificates live.

    Keep the path segment literal so the router audit can verify the allowed store root from the
    AST. Pinned certificates are configuration and belong beside `app_settings.yaml`.
    """
    return paths.DATA_DIR / "certs"


def _resolve_cert(cert):
    """A configured cert is a FILENAME under `certs/`; an absolute path is honored as given.

    Public material either way — the private half never leaves the satellite (§6) — so this is
    a plain existence check, not a vault read.
    """
    if not cert:
        return None
    from pathlib import Path as _P
    p = _P(cert)
    if p.is_absolute():
        if p.exists():
            return str(p)
    else:
        local = cert_dir() / p.name      # basename only: a configured '../..' is not a path here
        if local.exists():
            return str(local)
    # Report a missing pin as a domain error so callers can handle it without leaking an
    # unhandled filesystem exception into the render path.
    from satellite_client import SatelliteError
    raise SatelliteError(f"the pinned certificate {cert!r} is not in {cert_dir()} — re-upload "
                         f"it from the satellite (Settings > Satellites > Upload certificate).")


def client_for(name: str):
    """A cached `SatelliteClient`. Cached because it holds the master secret and the pin, not
    because building one is expensive."""
    from satellite_client import SatelliteClient, SatelliteError

    with _lock:
        cached = _clients.get(name)
    e = entry(name)
    if e is None:
        raise SatelliteError(f"no satellite named {name!r} is configured")
    if not e["secret"]:
        raise SatelliteError(
            f"satellite {name!r} has no shared secret. Define it in Settings — Vocalis "
            f"generates one and shows it once for pasting into the satellite's setup.")
    # The VRAM cap and batch limit are passed as callbacks so each request reads the current
    # value rather than one captured when the client was built.
    # October 10, 2026 — CORRECTED. This comment used to say pool workers keep their clients for
    # their lifetime. They no longer do: a `RemoteModel` built by `satellite_client.remote_model`
    # calls `client_for(name)` at the start of every request (`RemoteModel.current_client`), so
    # a rotated secret, a new pin or an edited URL (which change `sig` below and build a new
    # client here) reach the pool's next render without an untick/tick or a restart. Before that
    # the worker kept the client it was built with and, after "New secret...", sent every stream
    # with the old secret: `POST /satellite/stream 401` while health and load (which ask here)
    # were fine.
    sig = (e["url"], e["cert"], e["secret"])
    if cached is not None and cached[0] == sig:
        return cached[1]

    cert = _resolve_cert(e["cert"])
    client = SatelliteClient(name, e["url"], bytes.fromhex(e["secret"]), cert=cert,
                             vram_cap_gb=lambda: (entry(name) or {}).get("vram_cap_gb") or 0.0,
                             # Read the setting for each request; workers retain this client.
                             st_max_batch=lambda: (entry(name) or {}).get("st_max_batch") or 1)
    if not client.is_verified:
        # Warn, do not refuse: a plain-http URL is a supported (if discouraged) configuration
        # and the payload is sealed regardless. A pin that FAILS is a different matter and is
        # raised inside the client — that one is never downgraded to a warning.
        logger.warning(f"satellite {name!r}: {client.security_note()}")
    with _lock:
        _clients[name] = (sig, client)
    return client


def forget(name: str = None) -> None:
    """Drop cached clients so an edited URL/cert/secret takes effect without a restart."""
    with _lock:
        if name is None:
            _clients.clear()
        else:
            _clients.pop(name, None)


def health(name: str) -> dict:
    """Return satellite liveness for Settings without raising on expected connection failures."""
    from satellite_client import SatelliteError
    try:
        h = dict(client_for(name).health())
        h["reachable"] = True
        return h
    except SatelliteError as exc:
        return {"reachable": False, "error": str(exc), "devices": [], "ready": False}
    except Exception as exc:                              # noqa: BLE001
        logger.exception(f"satellite {name!r} health check failed unexpectedly")
        return {"reachable": False, "error": str(exc), "devices": [], "ready": False}


def _health_devices(h: dict) -> list:
    """The cards a health payload says the satellite HAS.

    Prefer `available_devices`; `devices` lists only cards with resident replicas. The fallback
    supports older satellite versions that predate `available_devices`.
    """
    got = h.get("available_devices")
    if got is None:
        got = h.get("devices")
    return list(got or [])


def discovered_devices() -> list:
    """`satellite-a:cuda:0`-style names for every reachable satellite, for the Settings checkboxes.

    Unreachable satellites contribute nothing here; the UI still lists them (grayed) from
    `configured()`, so a sleeping desktop does not make its cards silently vanish.
    """
    from satellite_client import device_name
    out = []
    for e in configured():
        h = health(e["name"])
        for d in _health_devices(h):
            out.append(device_name(e["name"], d))
    return out


_NAME_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}$")


def _settings_transaction(fn):
    """Run `fn` holding `settings.APP_LOCK`, so its read of `app_settings.yaml` and the write
    that follows are one step.

    2026-10-12: `add`, `update`, `regenerate` and `remove` each read the satellite list, changed
    it and wrote the WHOLE file back through `_save` with no lock. A save from another request
    that landed between the read and the write was undone (the device rows, the warning switch,
    a second satellite edit). Same rule as `PUT /settings/app`; the lock is re-entrant, so the
    route that already holds it can call these.
    """
    @functools.wraps(fn)
    def locked(*args, **kwargs):
        with settings.APP_LOCK:
            return fn(*args, **kwargs)
    return locked


def _save(entries: list) -> None:
    with settings.APP_LOCK:
        s = settings.load_app_settings()
        s["satellites"] = entries
        settings.save_app_settings(s)
    forget()


@_settings_transaction
def add(name: str, url: str) -> str:
    """Define a satellite and return its fresh master secret as hex — the ONLY time it is
    returned. Displayed once for pasting into the satellite's `setup.py`; a secret that stays
    on screen is a secret in a screenshot (§11.3).

    Names use `[a-z0-9][a-z0-9_-]*` and cannot contain the device separator. Names beginning
    with `cuda` or equal to `cpu` are reserved to avoid collisions with local device identifiers.
    """
    # satellite_client owns the sys.path insert for the shared protocol file (its module
    # docstring explains why it is one file and not a vendored copy). Importing it first is
    # what makes the protocol importable here at all.
    from satellite_client import DEVICE_SEP                      # noqa: F401
    import vocalis_satellite_protocol as proto

    name = str(name or "").strip().lower()
    url = str(url or "").strip().rstrip("/")
    if not _NAME_RE.match(name) or DEVICE_SEP in name:
        raise ValueError("a satellite name is 1-32 characters of a-z, 0-9, dash or underscore")
    if name.startswith("cuda") or name == "cpu":
        raise ValueError(f"{name!r} would collide with a local device name — pick another")
    if not url.startswith(("http://", "https://")):
        raise ValueError("the URL must start with http:// or https://")
    entries = [dict(e) for e in configured()]
    if any(e["name"] == name for e in entries):
        raise ValueError(f"a satellite named {name!r} already exists")
    secret = proto.new_master().hex()
    entries.append({"name": name, "url": url, "cert": None, "secret": secret})
    _save(entries)
    logger.info(f"satellite {name!r} defined at {url} — a new shared secret was generated")
    return secret


@_settings_transaction
def update(name: str, url: str = None, cert: str = None, vram_cap_gb=None,
           st_max_batch=None) -> None:
    """Edit the reachable half of an entry. The secret is NOT editable here — rotating one is
    `regenerate`, which is an explicit act with an explicit warning, not a side effect of
    correcting a typo in a hostname.

    `vram_cap_gb` is rejected when invalid rather than silently normalized to "uncapped". Reads
    tolerate malformed settings, but a write should report invalid input instead of weakening
    the requested cap.

    `st_max_batch` is also validated on write. Empty means one chunk, which selects serial
    processing; there is no unlimited setting.
    """
    entries = [dict(e) for e in configured()]
    for e in entries:
        if e["name"] == name:
            if url is not None:
                u = str(url).strip().rstrip("/")
                if not u.startswith(("http://", "https://")):
                    raise ValueError("the URL must start with http:// or https://")
                e["url"] = u
            if cert is not None:
                e["cert"] = str(cert).strip() or None
            if vram_cap_gb is not None:
                raw = str(vram_cap_gb).strip()
                if raw == "":
                    e["vram_cap_gb"] = 0.0                  # cleared the box = no cap
                else:
                    try:
                        f = float(raw)
                    except ValueError:
                        raise ValueError("the VRAM cap must be a number of GB, or empty for none")
                    if f != f or f < 0:
                        raise ValueError("the VRAM cap cannot be negative")
                    if f > 1024:
                        raise ValueError("that VRAM cap is larger than any card that exists")
                    e["vram_cap_gb"] = round(f, 2)
                # Log the configured value; the satellite logs the limit it receives, making
                # configuration and enforcement observable on both sides of the connection.
                logger.info(f"satellite {name!r}: VRAM cap "
                            + ("lifted — it may take the whole card" if not e["vram_cap_gb"]
                               else f"set to {e['vram_cap_gb']:.1f} GB per card"))
            if st_max_batch is not None:
                raw = str(st_max_batch).strip()
                if raw == "":
                    e["st_max_batch"] = 1                   # cleared the box = one at a time
                else:
                    try:
                        n = int(float(raw))
                    except ValueError:
                        raise ValueError("the SillyTavern max batch size must be a whole number "
                                         "of chunks, or empty for one at a time")
                    if n < 1:
                        raise ValueError("the SillyTavern max batch size cannot be less than 1 "
                                         "— 1 means one chunk at a time")
                    if n > 64:
                        raise ValueError("the SillyTavern max batch size cannot be more than 64")
                    e["st_max_batch"] = n
                # Pair the configured limit with the render log's batch size for diagnostics.
                logger.info(f"satellite {name!r}: SillyTavern speech batches "
                            + ("one chunk at a time" if e["st_max_batch"] <= 1
                               else f"up to {e['st_max_batch']} chunks"))
            _save(entries)
            return
    raise ValueError(f"no satellite named {name!r} is configured")


@_settings_transaction
def regenerate(name: str) -> str:
    """Rotate the shared secret, returning the new one once. The satellite stops working until
    the new secret is pasted into it — §11.5 — which is why this is a deliberate button and not
    something `update` does quietly."""
    import vocalis_satellite_protocol as proto

    entries = [dict(e) for e in configured()]
    for e in entries:
        if e["name"] == name:
            e["secret"] = proto.new_master().hex()
            _save(entries)
            logger.warning(f"satellite {name!r}: shared secret rotated — it will not answer "
                           "until the new secret is set on that machine too")
            return e["secret"]
    raise ValueError(f"no satellite named {name!r} is configured")


@_settings_transaction
def remove(name: str) -> None:
    """Forget a satellite. Its cards vanish from the device rows; the saved `devices:` entries
    for them are pruned by the caller, since a stale row for a satellite that no longer exists
    would be a checkbox that does nothing.

    October 10, 2026: the pinned certificate file `save_cert` wrote is deleted with it. Before this
    it stayed in `certs/` forever, and a satellite added later under the same name found a stale
    file on disk. Only a regular file DIRECTLY inside `cert_dir()` is ever deleted (a hand-edited
    `cert` that points anywhere else is left alone, as is a symlink), and only when no remaining
    entry pins the same file. A failure to delete is logged and does not fail the removal.
    The cached client is dropped by `_save` (`forget()` for every name), so the caller needs
    no `forget(name)` of its own."""
    old = entry(name)
    entries = [e for e in configured() if e["name"] != name]
    _save(entries)
    logger.info(f"satellite {name!r} removed")
    if old is None:
        return
    victim = _cert_file_in_cert_dir(old.get("cert"))
    if victim is None:
        return
    if any(_cert_file_in_cert_dir(e.get("cert")) == victim for e in entries):
        logger.info(f"satellite {name!r}: certificate file {victim.name} kept — another "
                    f"satellite is pinned to it")
        return
    try:
        victim.unlink()
    except FileNotFoundError:
        return                                     # already gone: nothing to clean up
    except OSError as exc:
        logger.warning(f"satellite {name!r}: could not delete its pinned certificate "
                       f"{victim.name} ({type(exc).__name__}: {exc}) — the satellite is removed; "
                       f"the file can be deleted by hand from {cert_dir()}")
        return
    logger.info(f"satellite {name!r}: deleted its pinned certificate file {victim.name}")


def _cert_file_in_cert_dir(cert):
    """The certificate file a configured `cert` names, as a `Path`, only if it is a regular file
    directly inside `cert_dir()`; otherwise None.

    Resolved the way `_resolve_cert` resolves it (a bare name means `certs/<basename>`, an absolute
    path is taken as given) but never raising and never leaving the folder: a path elsewhere, a
    symlink, a directory, or a name that does not exist is None."""
    if not cert:
        return None
    from pathlib import Path as _P
    p = _P(cert)
    candidate = p if p.is_absolute() else cert_dir() / p.name
    try:
        if candidate.is_symlink() or not candidate.is_file():
            return None
        if candidate.parent.resolve() != cert_dir().resolve():
            return None
        return candidate.parent.resolve() / candidate.name
    except OSError:
        return None


def save_cert(name: str, pem: bytes) -> str:
    """Store a satellite's public certificate under `certs/` and pin the entry to it.

    The public certificate is stored as an ordinary file; its private key remains on the
    satellite. Validate the input before writing so an invalid pin cannot be treated as verified.
    """
    from cryptography import x509

    from cryptography.hazmat.primitives.serialization import Encoding

    try:
        cert = x509.load_pem_x509_certificate(pem)
    except Exception as exc:                                   # noqa: BLE001
        raise ValueError(f"that file is not a PEM certificate: {exc}")
    d = cert_dir()
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{name}.pem"
    # Store only the parsed certificate. The parser accepts the first certificate block and may
    # ignore trailing data; serializing the parsed object prevents bundled keys or extra
    # certificates from being written while the UI displays a single fingerprint.
    path.write_bytes(cert.public_bytes(Encoding.PEM))
    update(name, cert=path.name)
    logger.info(f"satellite {name!r}: pinned to {path.name}")
    return path.name


def fingerprint(pem: bytes) -> str:
    """AA:BB:… — the same SHA-256 the satellite's `setup.py` prints when it makes the file.

    It exists to be COMPARED. §11.3 tells the operator to check the two against each other, and
    until now Vocalis showed nothing to check against, which made that instruction unfollowable.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    fp = x509.load_pem_x509_certificate(pem).fingerprint(hashes.SHA256()).hex()
    return ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)).upper()


def security(name: str) -> dict:
    """How protected the link to this satellite actually is — for the badge beside its row.

    🔴 Derived from the client, never from the URL string. "It starts with https" is exactly the
    claim that must not be made: unpinned self-signed TLS is barely better than plain HTTP
    against an active attacker, and a UI that renders it as secure is worse than one that says
    nothing (§6).
    """
    try:
        c = client_for(name)
        return {"verified": bool(c.is_verified), "note": c.security_note()}
    except Exception as exc:                                   # noqa: BLE001
        return {"verified": False, "note": str(exc)}


def is_satellite_device(device) -> bool:
    """`satellite-a:cuda:0` yes, `cuda:0`/`cpu` no. Re-exported here so a caller asking about a DEVICE
    does not have to import the client module to find out."""
    from satellite_client import is_remote
    return is_remote(device)


def _known_satellite_devices() -> list:
    """Every satellite card Vocalis has a saved ⚙ Settings row for — `satellite-a:cuda:0`, … .

    The Settings rows, not a health probe: this has to answer for a satellite that is asleep,
    and what it is used for is deciding what to ASK for, not what is resident.
    """
    from satellite_client import is_remote
    rows = settings.load_app_settings().get("devices") or []
    return [str(r["id"]) for r in rows
            if isinstance(r, dict) and r.get("id") and is_remote(str(r["id"]))]


def reconcile(counts: dict) -> dict:
    """Make every configured satellite hold exactly what ⚙ Settings asks for — including none.

    Called when the Devices panel is saved so remote VRAM changes take effect immediately rather
    than waiting for the next render.

    Every known card gets an explicit count, so unticking one is a request for zero rather than
    silence — see `apply_plan`. Slow (a replica load is ~9 s, and an unreachable satellite costs
    a connect timeout), so callers run it off the request thread.
    """
    plan = dict(counts or {})
    for dev in _known_satellite_devices():
        plan.setdefault(dev, 0)
    return apply_plan(plan)


def apply_plan(counts: dict) -> dict:
    """Declare each satellite's replica plan ONCE, before the pool builds its workers.

    `remote_model()` is called once per worker slot; loading there would create only the first
    replica. `Engine.load` accepts a declarative total, so this function sends the complete plan
    once before workers are built. Unreachable satellites are skipped, matching local device
    load behavior. Returns `{satellite: {device: loaded}}` for logging.
    """
    from satellite_client import SatelliteError, split_device

    plans = {}
    for dev, n in (counts or {}).items():
        sat, local = split_device(str(dev))
        if sat is not None:
            plans.setdefault(sat, {})[local] = int(n)
    # The plan is declarative: omit no known card, because omission does not release its replica.
    # Include explicit zero counts so the remote worker set matches saved Settings exactly.
    for dev in _known_satellite_devices():
        sat, local = split_device(dev)
        if sat is not None and sat in plans:
            plans[sat].setdefault(local, 0)
    out = {}
    for sat, plan in plans.items():
        try:
            out[sat] = client_for(sat).load(plan)
            logger.info(f"satellite {sat!r}: plan {plan} -> loaded {out[sat]}")
        except SatelliteError as exc:
            logger.warning(f"satellite {sat!r} could not load {plan}: {exc} — "
                           "its cards are skipped and the render stays on this box")
        except Exception as exc:                                # noqa: BLE001
            logger.exception(f"satellite {sat!r} load failed unexpectedly: {exc}")
    return out


_reload_lock = threading.Lock()


def reload(name: str) -> bool:
    """A satellite answered "no model loaded" — re-declare its FULL replica plan.

    A restarted satellite has no replicas while the local pool still holds clients for it. Reload
    the full declarative plan from Settings; reloading one worker at a time would reset the total
    and could trim replicas used by other workers. Serialize reloads because concurrent calls to
    `Engine.load` can each observe zero replicas and load duplicates.
    """
    from satellite_client import SatelliteError, split_device
    from vocalis.runtime import pool as rt_pool

    with _reload_lock:
        try:
            if client_for(name).health().get("ready"):
                return True                     # another thread got here first
        except SatelliteError as exc:
            logger.warning(f"satellite {name!r} is not answering, so it cannot be reloaded: {exc}")
            return False

        counts = rt_pool.default_workers()
        if not isinstance(counts, dict):
            counts = {d: int(counts or 1) for d in rt_pool.default_devices()}
        plan = {d: n for d, n in counts.items() if split_device(str(d))[0] == name}
        if not plan:
            logger.warning(f"satellite {name!r} reported no model, and no device of its is "
                           f"enabled in Settings — nothing to reload")
            return False

        logger.warning(f"satellite {name!r} has no model loaded — it was restarted. "
                       f"Re-declaring its plan {plan}.")
        apply_plan(plan)
        try:
            return bool(client_for(name).health().get("ready"))
        except SatelliteError:
            return False


def resync(name: str) -> dict:
    """⟳ Reconnect: push this satellite's FULL saved plan at it, changed or not.

    Push the complete saved plan even when health reports ready: a ready satellite can still have
    a different replica count than Settings. This is distinct from `reload()`, which only handles
    a no-model response and would return early for a partially loaded plan.

    **The whole box, not one card**, even though the button sits on a card row. `Engine.load` is
    declarative per satellite and `apply_plan` gives every card it knows about an explicit count,
    so sending one card's number would zero that satellite's other cards.

    A row that is unticked asks for **0**, not for silence — the same rule `apply_plan` documents.
    That makes Reconnect a way to release VRAM a satellite is holding from before a settings
    change, not only a way to claim it.

    Returns `{"plan": …, "loaded": …, "reachable": bool}` — `loaded` read back from health, so
    the answer is what the satellite says it has and never what we hoped it would do.
    """
    from satellite_client import split_device
    from vocalis.runtime import pool as rt_pool

    plan = {}
    for r in settings.load_app_settings().get("devices") or []:
        if not isinstance(r, dict) or not r.get("id"):
            continue
        dev = str(r["id"])
        if split_device(dev)[0] != name:
            continue
        # One worker per enabled card, zero for an unticked one — and the ZERO is what
        # releases that card's VRAM on the other machine (Engine.load is declarative).
        # Never `r.get("workers")`: 5.4.1 stopped honoring that field and a saved 2 would
        # otherwise still reach the satellite from here, which is the whole class of bug
        # where a setting is removed in one place and quietly keeps working in another.
        plan[dev] = rt_pool.WORKERS_PER_DEVICE if r.get("enabled") else 0
    if not plan:
        # Never reached, so nothing here knows what cards it has. Not an error: it is the state
        # every satellite starts in, and `snapshot` renders it as the box being down.
        logger.info(f"satellite {name!r}: reconnect found no device rows to apply yet")
        h = health(name)
        return {"plan": {}, "loaded": {}, "reachable": bool(h.get("reachable"))}

    logger.info(f"satellite {name!r}: reconnect is declaring {plan}")
    apply_plan(plan)
    # 🔴 AND PUT ITS WORKERS BACK INTO THE LIVE POOL (2026-10-22). Loading the model on the
    # satellite was all this did, so after a mid-render restart ⟳ showed the satellite loaded and online
    # while the render never gave it another chunk: its worker had left the pool for good.
    rejoined = rt_pool.rejoin_satellite(name, plan=plan)
    h = health(name)
    return {"plan": plan, "reachable": bool(h.get("reachable")),
            "loaded": dict(h.get("workers") or {}), "rejoined": rejoined}


def unload_all() -> None:
    """Release every satellite's replicas — the remote half of ⏏ Unload.

    Not called from `drop_pool()`: that path can run while `GPUS` is held, and an unreachable
    satellite would block the settings save for its connection timeout. Pool rebuilds re-send the
    declarative plan; explicit Unload owns release-on-demand behavior.
    """
    from satellite_client import SatelliteError
    for e in configured():
        try:
            n = client_for(e["name"]).unload()
            logger.info(f"satellite {e['name']!r}: released {n} replica(s)")
        except SatelliteError as exc:
            logger.info(f"satellite {e['name']!r} not unloaded: {exc}")
        except Exception as exc:                                # noqa: BLE001
            logger.exception(f"satellite {e['name']!r} unload failed unexpectedly: {exc}")


def snapshot(remembered: list = None) -> dict:
    """Everything the ⚙ Settings page needs about satellites, on ONE health probe each.

    Returns `{"satellites": [{name, url, reachable, error, ready, loading}],
              "devices":    [{id, satellite, device, reachable}]}`.

    One function rather than a status call and a device call because each probe is a real
    network round trip to a machine that is usually asleep — two of them means paying the
    connect timeout twice to learn the same thing.

    An unreachable satellite still contributes rows from `remembered`, the ids already saved in
    `devices:`. A satellite never reached contributes no rows because its devices are unknown.
    This preserves saved worker settings while the remote host is offline.
    """
    from satellite_client import device_name, split_device
    remembered = list(remembered or [])
    sats, devs = [], []
    for e in configured():
        name = e["name"]
        h = health(name)
        sats.append({"name": name, "url": e["url"],
                     "reachable": bool(h.get("reachable")),
                     "error": str(h.get("error") or ""),
                     "ready": bool(h.get("ready")), "loading": bool(h.get("loading")),
                     # The satellite's own claim that it can take the lead-vocal separation that
                     # follows a stems job. Absent (older satellite, or unreachable) reads False.
                     "leadvocal_ready": bool(h.get("leadvocal_ready")),
                     "cert": e["cert"] or "",
                     # A BOOL, never the value. The secret is returned exactly once, at
                     # generation; anything that re-serves it puts it in the DOM and in every
                     # settings fetch the browser decides to remember.
                     "secret_set": bool(e["secret"]),
                     "version": str(h.get("satellite_version") or ""),
                     "sr": h.get("sr"),
                     # Show both the configured cap and the satellite's reported cap. `None`
                     # means unavailable or unsupported; zero means explicitly uncapped.
                     "vram_cap_gb": e["vram_cap_gb"],
                     # Enforced locally by the pool, so it has no satellite-reported counterpart.
                     "st_max_batch": e["st_max_batch"],
                     "vram_cap_live": (float(h.get("vram_cap_gb") or 0.0)
                                       if h.get("reachable") and "vram_cap_gb" in h else None),
                     "vram_reserved_gb": (h.get("vram_reserved_gb") or {}
                                          if h.get("reachable") else None),
                     **security(name)})
        live = [device_name(name, d) for d in _health_devices(h)]
        known = sorted(d for d in remembered
                       if split_device(d)[0] == name and d not in live)
        # Report the satellite's actual worker count beside the saved plan. Use `None` while
        # unreachable because the loaded count is unknown, not zero.
        wk = h.get("workers") or {}
        for dev in live + known:
            local = split_device(dev)[1]
            devs.append({"id": dev, "satellite": name,
                         "device": local,
                         "reachable": bool(h.get("reachable")) and dev in live,
                         "loaded": (int(wk.get(local, 0) or 0)
                                    if h.get("reachable") else None)})
    return {"satellites": sats, "devices": devs}
