"""Control configured ComfyUI services and report their runtime state.

This process-wide integration supports service controls, health reporting, and model
load decisions. GPU and system-memory measurements live in `runtime.gpu` so callers
can query them without importing service-control code.
"""
import json
import os
import subprocess
import time
import urllib.request

from loguru import logger

from vocalis.runtime import settings


# ComfyUI's process-local free-memory endpoint does not release cached VRAM on some ROCm
# stacks; restarting its systemd unit does. Control is therefore per service instance.
# The default is one instance. `instances: N` generates numbered service/port pairs;
# explicit `services` and `urls` lists override that count and are paired by position.
COMFYUI_READY_TIMEOUT = float(os.environ.get("VOCALIS_COMFYUI_READY_TIMEOUT", "60"))
COMFYUI_MIN_FREE_GB   = 0.1     # below this ComfyUI holds ~nothing worth a restart -> UI disables the button
COMFYUI_INSTANCES_DEFAULT = 1   # one GPU is the ordinary case — see above
COMFYUI_BASE_SERVICE = "comfyui.service"
COMFYUI_BASE_PORT    = 8189

_COMFYUI_AVAIL = None           # cached [(service, url)] that exist on this box


def _comfyui_nth(i: int) -> tuple:
    """Return the generated service and loopback URL for instance index `i`."""
    svc = COMFYUI_BASE_SERVICE if i == 0 else f"comfyui-gpu{i}.service"
    return svc, f"http://127.0.0.1:{COMFYUI_BASE_PORT + i * 100}"


def comfyui_configured(app_settings: dict = None) -> list:
    """The configured (service, url) pairs. Precedence is the house rule — env var →
    app_settings.yaml `comfyui:` → default — applied to the explicit lists first, and only
    falling back to the generated `instances:` count when neither names them."""
    s = (app_settings if app_settings is not None else settings.load_app_settings() or {}).get("comfyui")
    if not isinstance(s, dict):          # a hand-edited `comfyui: "oops"` must not raise here
        s = {}

    def listy(env: str, key: str):
        """A comma string (env or YAML scalar) or a real YAML list — both are natural to
        write, and a config file that only accepts one of them invites a silent miss."""
        raw = os.environ.get(env) or s.get(key)
        if raw is None:
            return None
        items = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
        return [str(x).strip().rstrip("/") for x in items if str(x).strip()] or None

    services, urls = listy("VOCALIS_COMFYUI_SERVICE", "services"), listy("VOCALIS_COMFYUI_URL", "urls")
    if services or urls:
        # Explicit lists win outright. Zipping truncates to the shorter, which is the safe
        # failure: a half-configured pair controls the instances it can fully address.
        return list(zip(services or [], urls or []))
    try:
        n = int(os.environ.get("VOCALIS_COMFYUI_INSTANCES") or s.get("instances")
                or COMFYUI_INSTANCES_DEFAULT)
    except (TypeError, ValueError):      # `instances: two` must not sink the button
        n = COMFYUI_INSTANCES_DEFAULT
    return [_comfyui_nth(i) for i in range(max(0, n))]


def comfyui_instances() -> list:
    """The (service, url) pairs this box can actually restart: configured AND the systemd
    --user unit exists. Cached — the answer can't change without a Vocalis restart (unit
    install/removal is rare, and a stale 'yes' just yields a clear error from the restart
    call anyway)."""
    global _COMFYUI_AVAIL
    if _COMFYUI_AVAIL is None:
        pairs = comfyui_configured()
        try:
            r = subprocess.run(
                ["systemctl", "--user", "list-unit-files"] + [s for s, _ in pairs],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
            )
            _COMFYUI_AVAIL = ([(s, u) for s, u in pairs if s in r.stdout]
                              if r.returncode == 0 else [])
        except (OSError, subprocess.SubprocessError):
            _COMFYUI_AVAIL = []             # no systemctl (e.g. dev on Windows) -> hide it
    return _COMFYUI_AVAIL


def comfyui_control_available() -> bool:
    return bool(comfyui_instances())


def comfyui_active_count():
    """How many configured instances systemd currently has RUNNING, or None if that
    can't be established. This is the unit state, not HTTP reachability, and the two are
    not interchangeable: a ComfyUI that is up but still warming its ROCm context answers
    nothing on :8189 for ~30 s, so `up` (see comfyui_vram_bytes) would call it stopped and
    the button would offer to Start something already started. `is-active` knows.

    One call for every unit — `is-active` prints one state per unit in argument order and
    exits non-zero unless ALL are active, so the exit code is useless here and the lines
    are what we read."""
    insts = comfyui_instances()
    if not insts:
        return None
    try:
        r = subprocess.run(["systemctl", "--user", "is-active"] + [s for s, _ in insts],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    states = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
    if len(states) != len(insts):
        return None                          # couldn't line the answers up with the units
    return sum(1 for s in states if s == "active")


def _comfyui_get(path: str, url: str, timeout: float = 3.0):
    """GET one instance's HTTP API on loopback (no Caddy/TLS — Vocalis is on the box).
    Returns parsed JSON, or None if unreachable / non-200 / bad JSON ('can't tell')."""
    try:
        with urllib.request.urlopen(f"{url}{path}", timeout=timeout) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except Exception:                        # noqa: BLE001
        return None


def comfyui_vram_bytes():
    """Sum over every instance of its own per-device `torch_vram_total` (its
    torch-allocator footprint). None if NO instance is reachable; an unreachable
    instance among reachable ones contributes 0. This allocator-reported total is a lower
    bound because some backend allocations are visible only in whole-card usage; the UI's
    freeable estimate also considers non-Vocalis whole-card usage."""
    total, seen = 0, False
    for _svc, url in comfyui_instances():
        stats = _comfyui_get("/api/system_stats", url)
        if not isinstance(stats, dict):
            continue
        seen = True
        try:
            total += sum(int(d.get("torch_vram_total", 0)) for d in stats.get("devices", []))
        except Exception:                    # noqa: BLE001
            pass
    return total if seen else None


def authorized_instances() -> list:
    """Installed instances authorized for their corresponding local GPU.

    Assign each device index before applying the live Settings filter; enumerating after
    filtering would map a surviving service to the wrong card. Unlike installed-unit
    discovery, authorization is not cached because Settings can change at runtime.
    """
    from vocalis.runtime import subsystems

    # Preserve an empty result when installed instances are all disabled; callers choose
    # their own fallback behavior for an empty authorized-device list.
    rows = {str(d.get("id")): d
            for d in ((settings.load_app_settings() or {}).get("devices") or [])
            if isinstance(d, dict)}
    out = []
    for i, (svc, url) in enumerate(comfyui_instances()):
        dev = f"cuda:{i}"
        cfg = rows.get(dev)
        if cfg is not None and not cfg.get("enabled", True):
            continue                     # the whole card is switched off
        if not subsystems.authorized(cfg or {}, subsystems.COMFYUI):
            continue                     # the card is on, but not for this
        out.append((svc, url, dev))
    return out


def comfyui_queue_busy():
    """(running, pending) job counts summed across instances if ANY currently has work,
    else None. None also means 'unreachable / can't tell' — so callers only WARN when
    it's positively busy."""
    running = pending = 0
    for _svc, url in comfyui_instances():
        q = _comfyui_get("/api/queue", url)
        if isinstance(q, dict):
            running += len(q.get("queue_running") or [])
            pending += len(q.get("queue_pending") or [])
    return (running, pending) if (running or pending) else None


def comfyui_wait_ready(timeout: float):
    """Poll every instance's /api/system_stats until ALL answer (serviceable again) or
    timeout. Returns (ready, waited_s). ROCm cold init is ~10-30 s — this is what keeps
    the button's spinner honest instead of reporting 'ready' the instant the processes
    are spawned. The instances warm up concurrently, so the wall is the slowest one,
    not the sum."""
    start = time.monotonic()
    left = {url for _svc, url in comfyui_instances()}
    while True:
        for url in list(left):
            if _comfyui_get("/api/system_stats", url, timeout=2.0) is not None:
                left.discard(url)
        waited = time.monotonic() - start
        if not left:
            return True, waited
        if waited >= timeout:
            return False, waited
        time.sleep(1.0)
