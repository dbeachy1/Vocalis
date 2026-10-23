"""Process-wide Chatterbox worker pool shared by speech-rendering routes.

The pool cache is keyed by device and worker selection. A second pool would duplicate model
replicas and consume additional VRAM. Callers access readiness through functions because the
module owns mutable cache state; importing a boolean or re-exporting the cache would expose a
stale or independently patchable value.
"""
import threading

import torch
from loguru import logger

from tts_utils import VocalisError, WorkerPool, parse_devices

from vocalis.runtime import gpu as rt_gpu, settings, subsystems
from vocalis.runtime.gpu import GPUS

# ── Pool cache (rebuilt only when device/worker selection changes -> AC3) ──────

_pool = None
_pool_sig = None
_pool_lock = threading.Lock()
_model_loading = False       # True while a (re)load is in flight, so the UI can show "loading" vs "unloaded"


def _signature(devices, workers):
    """A hashable, STABLE identity for a pool configuration.

    Sort entries so equivalent selections produce the same signature and do not rebuild the pool
    or release replicas during an in-flight render.
    """
    if isinstance(workers, dict):
        return tuple(sorted((str(d), int(workers.get(str(d), 1))) for d in devices))
    return tuple(sorted((str(d), int(workers)) for d in devices))


def get_pool(devices: list, workers) -> WorkerPool:
    global _pool, _pool_sig, _model_loading
    sig = _signature(devices, workers)
    with _pool_lock:
        # Rebuild on selection change OR when a stall abort poisoned the pool — a
        # zombie worker thread may still hold a replica of the old one, and it must
        # never be re-dispatched.
        if _pool is None or _pool_sig != sig or getattr(_pool, "poisoned", False):
            # Flag the multi-minute load window: without this, /health reports
            # model_ready=false + model_loading=false mid-rebuild and the UI shows
            # "model unloaded" with a live Load button DURING a render — clicking
            # it would queue a pointless default-pool rebuild behind GPUS.
            _model_loading = True
            try:
                old, _pool = _pool, None    # drop old replicas before loading new
                if old is not None:
                    old.shutdown()          # stop its worker threads + free replicas, else the
                                            # old model's VRAM leaks and the reload doubles it
                # The streaming governor's measured per-device rates describe a POOL, not a
                # card: what a device achieves depends on how many other workers are competing
                # with it. Carrying observations from the old mix into a new one would plan the
                # buffer floor from a machine that no longer exists — the §3.3 mistake, made by
                # a stale measurement instead of a stale constant.
                from vocalis_streaming import reset_rates
                reset_rates()
                import gc
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                total = sum(n for _, n in sig)
                logger.info(f"building pool: {len(devices)} device(s), "
                            + ", ".join(f"{d}×{n}" for d, n in sig)
                            + f" = {total} replica(s)")
                # Every satellite is told its FULL plan before any worker is built (§3.5).
                # WorkerPool builds one worker at a time, and a per-worker load cannot express
                # a total — see satellites.apply_plan for the silent under-load that caused.
                # Declarative, so re-sending the same plan on every rebuild is a no-op.
                if any(not str(d).startswith("cuda") and str(d) != "cpu" for d in devices):
                    from vocalis.runtime import satellites as _sat
                    _sat.apply_plan(dict(sig))
                _pool = WorkerPool(devices, workers)
                _pool_sig = sig
                if any(not str(d).startswith("cuda") and str(d) != "cpu" for d in devices):
                    threading.Thread(target=_rejoin_watch, args=(_pool,), daemon=True,
                                     name="vocalis-satellite-rejoin").start()
            finally:
                _model_loading = False
        return _pool


# How often a pool with a missing satellite asks whether it is back. One health request per
# missing satellite per interval, and nothing at all while every satellite is in.
REJOIN_EVERY_S = 10.0


# A satellite that ANSWERS but whose card will not load (the desktop owner is gaming on it, the
# card is gone, a load error) is not asked every 10 s for the rest of the pool's life: each failed
# attempt doubles the wait, up to this. One that is simply off costs only a health request, so its
# retries stay at `REJOIN_EVERY_S`.
REJOIN_BACKOFF_MAX_S = 600.0


def _pool_live(pool) -> bool:
    # Read WITHOUT `_pool_lock`, as `model_ready()` does: `get_pool` holds that lock for a whole
    # pool build (minutes). A rebuild sets `_pool` to None first.
    return _pool is pool and not getattr(pool, "_shutdown_flag", False) \
        and not getattr(pool, "poisoned", False)


def _rejoin(name: str, pool, plan=None):
    """One attempt for satellite `name`. Returns `(reachable, wanted, added)`.

    Without `plan` (the watcher): only devices past their after-timeout wait; that satellite's
    full plan from the pool is declared first. With `plan` (⟳ Reconnect, which has just declared
    the SAVED plan itself): nothing is declared again, the wait is skipped, and a device the plan
    now asks zero of is left out, so ⟳ never puts back a card unticked since the pool was built."""
    from satellite_client import split_device
    from vocalis.runtime import satellites as _sat
    gone = pool.satellites_gone(include_waiting=plan is not None).get(name) or []
    wanted = [d for d in gone if plan is None or int(plan.get(d, 0)) > 0]
    if not wanted or not _sat.health(name).get("reachable"):
        return False if wanted else None, wanted, []
    if plan is None:
        # Checked again here, after the health round trip: an ⏏ Unload in between released the
        # satellite's replica, and declaring the plan now would load it back for nobody.
        if not _pool_live(pool):
            return None, wanted, []         # not a failed load: no backoff, no warning
        _sat.apply_plan({d: n for d, n in pool.worker_counts.items() if split_device(d)[0] == name})
    return True, wanted, [d for d in wanted if pool.rejoin(d, force=plan is not None)]


def rejoin_satellite(name: str, pool=None, plan=None) -> list:
    """Bring satellite `name`'s missing workers back into the live pool. Returns the devices added.

    Used by the pool's own watcher (`_rejoin_watch`) and by ⟳ Reconnect (`satellites.resync`, with
    the saved `plan` it has just declared), so a satellite that is restarted mid-render gets work
    again whether or not anyone has the Settings page open. A satellite still down returns []."""
    if pool is None:
        pool = _pool                    # see `_pool_live`: never wait out a pool build here
    if pool is None or not _pool_live(pool):
        return []
    return _rejoin(name, pool, plan)[2]


def _rejoin_watch(pool, wait=None, now=None):
    """While `pool` is the live pool, try every missing satellite each `REJOIN_EVERY_S`, backing
    off one that answers but will not load. `wait` and `now` are injectable for tests; the thread
    ends when the pool is replaced, shut down or poisoned. Logs on a change of state only."""
    import time
    wait = wait or time.sleep
    now = now or time.monotonic
    state = {}                          # name -> {"delay": s, "next": t, "failing": bool}
    while True:
        wait(REJOIN_EVERY_S)
        if not _pool_live(pool):
            return
        names = list(pool.satellites_gone())
        # A satellite no longer missing (⟳ put it back, or it is inside its after-timeout wait)
        # forgets its backoff: left in place, a later drop would sit out a stale wait of up to
        # REJOIN_BACKOFF_MAX_S before the first attempt, and "loaded again" would be logged.
        for name in [n for n in state if n not in names]:
            del state[name]
        for name in names:
            st = state.setdefault(name, {"delay": REJOIN_EVERY_S, "next": 0.0, "failing": False})
            if now() < st["next"]:
                continue
            try:
                reachable, wanted, added = _rejoin(name, pool)
            except Exception:                                   # noqa: BLE001 — the watcher must
                logger.exception(f"satellite {name!r}: rejoin attempt failed")  # outlive one failure
                reachable, wanted, added = True, [None], []
            if not reachable:
                st.update(delay=REJOIN_EVERY_S, next=0.0)       # off: cheap to keep asking
            elif len(added) < len(wanted):
                st["delay"] = min(st["delay"] * 2, REJOIN_BACKOFF_MAX_S) if st["failing"] \
                    else REJOIN_EVERY_S * 2
                st["next"] = now() + st["delay"]
                if not st["failing"]:
                    logger.warning(f"satellite {name!r} answers but its card did not load — "
                                   f"trying again, less often each time (up to every "
                                   f"{REJOIN_BACKOFF_MAX_S / 60:g} min)")
                st["failing"] = True
            else:
                if st["failing"]:
                    logger.info(f"satellite {name!r}: loaded again after earlier failures")
                state.pop(name, None)


def model_ready() -> bool:
    return _pool is not None


def prerender_model_ready() -> bool:
    """Whether a configured default pool can be built for a queued prerender.

    A non-empty device selection allows `current_pool()` to perform its normal lazy load. The
    dispatcher calls this gate repeatedly, so stale device settings or other lookup failures must
    hold the job rather than escape and stop pre-rendering.
    """
    if model_ready():
        return True
    try:
        devs = [str(d) for d in default_devices()]
        if not devs:
            return False
        return True
    except Exception:                                     # noqa: BLE001 — see the warning above
        logger.exception("prerender gate: could not read the device selection — holding")
        return False


def model_loading() -> bool:
    """A function, deliberately — see the module docstring. `/health` asks per request."""
    return _model_loading


def drop_pool():
    """Release the pool's model replicas and free their VRAM. Call under GPUS."""
    global _pool, _pool_sig
    with _pool_lock:
        pool, _pool, _pool_sig = _pool, None, None
    if pool is not None:
        pool.shutdown()          # stop the worker threads that hold the replicas, else
                                 # gc/empty_cache free nothing and the VRAM leaks
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _local_gpus_string(sub: str = subsystems.RENDER) -> str:
    """The SAVED Settings selection as a `--gpus`-shaped STRING ('all', 'cpu', or '0,1').

    This private helper answers which local CUDA cards may be used; it is distinct from
    `default_devices()`, which may include satellites:

        default_devices()      -> where a render runs (satellites included)
        local_cuda_devices()   -> which of THIS box's cards are ticked (never a satellite)

    and neither can be mistaken for the other. The `'cpu'` sentinel lives only in here.

    Read the per-device settings when available, applying the subsystem authorization filter.
    Satellite identifiers are excluded because `parse_devices` accepts only local device
    selectors. The legacy `gpus` setting remains the fallback for configurations without rows.
    """
    per = _device_settings()
    if per:
        idx = sorted(int(d.split(":")[1]) for d, c in per.items()
                     if c["enabled"] and subsystems.authorized(c, sub) and d.startswith("cuda:"))
        return ",".join(str(i) for i in idx) if idx else "cpu"
    return str(settings.load_app_settings().get("gpus", "all") or "all")


#: Workers assigned to each device. Kept as one constant because the satellite plan and render
#: rate key must use the same value.
WORKERS_PER_DEVICE = 1


def default_workers(sub: str = subsystems.RENDER):
    """Workers per device — always ONE, on every card, everywhere.

    One worker per device avoids loading duplicate model weights. Benchmarking showed that two
    concurrent single-item workers reduced aggregate throughput while consuming additional VRAM;
    batching provides concurrency while sharing weight traffic.

    It still returns the {device: count} DICT, and that shape is load-bearing even though every
    value is now 1: `render_rate._workers_key` puts the SATELLITE NAME in the key only for the
    dict form, so collapsing this to a bare `1` would make two different satellites share one
    measured rate — the exact bug that key exists to prevent, which this codebase has already
    hit once.

    Concurrency, which two workers did buy, is the job of batching instead: several chunks
    ride through ONE forward pass on shared weight traffic. See DESIGN_6_2_BATCHING.

    The scalar fallback supports configurations without a `devices:` list. An empty mapping
    would make `WorkerPool` reject the selection, so this and `default_devices()` preserve the
    same legacy fallback behavior.

    Use the same subsystem filter as `default_devices()` so the worker map and pool signature
    describe the same device set.
    """
    per = {d: WORKERS_PER_DEVICE for d, c in _device_settings().items()
           if c["enabled"] and subsystems.authorized(c, sub)}
    return per or WORKERS_PER_DEVICE


def _device_settings() -> dict:
    """{device: {"enabled": bool, "uses": dict}} from the `devices:` list.

    `uses` is the per-subsystem map. An absent or malformed value becomes `{}`, preserving the
    legacy behavior of `subsystems.authorized()`. Normalize on write rather than read so invalid
    saved values remain visible for correction. Legacy `workers` fields are ignored because the
    worker count is now fixed by `default_workers()`; the next save removes obsolete fields.
    """
    s = settings.load_app_settings()
    out = {}
    for raw in (s.get("devices") or []):
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        uses = raw.get("uses")
        out[str(raw["id"])] = {"enabled": bool(raw.get("enabled", True)),
                               "uses": uses if isinstance(uses, dict) else {}}
    return out


def local_card_permissions(indices=None) -> dict:
    """`{card_index: {subsystem: bool}}` for this box's LOCAL cards — what each may run.

    This shared predicate keeps card pickers consistent with server-side device authorization.
    An absent row retains the legacy behavior defined by `subsystems.authorized()`.

    Satellites are deliberately absent: this answers about THIS box's cards, the same scope as
    `local_cuda_devices()`, and a satellite is addressed by name rather than by index.

    `indices` comes from the caller so permission rows use the same device registry as the
    response being filtered.
    """
    per = _device_settings()
    if indices is None:
        indices = range(torch.cuda.device_count())
    out = {}
    for i in indices:
        cfg = per.get(f"cuda:{i}")
        enabled = True if cfg is None else bool(cfg["enabled"])
        out[int(i)] = {k: bool(enabled and subsystems.authorized(cfg or {}, k))
                       for k in subsystems.KEYS}
    return out


def migrate_device_settings(available: list) -> list:
    """Build the per-device list from the legacy `gpus` key.

    `gpus: "all"` → every available device enabled; `"cpu"` → the cpu pseudo-device; `"0,1"` →
    those two. Returns the list; the caller saves it. Existing `devices:` entries win, so this
    only ever fills gaps.

    Obsolete worker-count settings are not migrated; `default_workers()` now owns that policy.
    """
    s = settings.load_app_settings()
    existing = _device_settings()
    legacy_gpus = str(s.get("gpus", "all") or "all").strip().lower()

    def _is_local(dev: str) -> bool:
        return dev.startswith("cuda") or dev == "cpu"

    def _enabled(dev: str) -> bool:
        # Legacy selectors describe local devices only. A satellite requires explicit opt-in.
        if not _is_local(dev):
            return False
        if legacy_gpus == "all":
            return True
        if legacy_gpus == "cpu":
            return dev == "cpu"
        wanted = {x.strip() for x in legacy_gpus.split(",") if x.strip()}
        return dev.split(":")[-1] in wanted or dev in wanted

    out = []
    for dev in available:
        cur = existing.get(dev)
        row = {"id": dev, "enabled": cur["enabled"] if cur else _enabled(dev)}
        # Preserve subsystem permissions during migration; omitting them would broaden access.
        # Leave the key absent when there are no restrictions.
        if cur and cur.get("uses"):
            row["uses"] = dict(cur["uses"])
        out.append(row)
    return out


def default_devices(sub: str = subsystems.RENDER) -> list:
    """The device list a default pool is built from — the ENABLED entries of the per-device
    settings that are also AUTHORIZED for `sub`, satellites included, else the legacy `gpus`
    string through `parse_devices`.

    Separate from `local_cuda_devices()` rather than replacing it: that one answers which local
    cards may be used, as required by `voxcpm_pool.usable_cards()` and the enhancer. A satellite
    name is not meaningful to those callers, and `parse_devices` accepts only local selectors.

    The default subsystem preserves existing callers. A subsystem-specific selection can only
    narrow the enabled device set.

    If no device is authorized, rendering may fall back to CPU. Other subsystems use
    `local_cuda_devices()` and return an empty list when no CUDA device is allowed.
    """
    per = [d for d, c in _device_settings().items()
           if c["enabled"] and subsystems.authorized(c, sub)]
    return per if per else parse_devices(_local_gpus_string(sub))


def resolve_devices(spec) -> list:
    """The devices a submitted job actually renders on.

    Jobs should carry the resolved device list so satellite identifiers are preserved. A string
    remains supported for CLI callers that pass `--gpus` directly; `parse_devices` accepts only
    local selectors and cannot represent a satellite.
    """
    if isinstance(spec, (list, tuple)):
        devs = [str(d) for d in spec]
        return devs if devs else parse_devices(_local_gpus_string())
    # Treat blank as no devices. `None` remains unspecified and follows the CLI default.
    if spec is not None and not str(spec).strip():
        return []
    return parse_devices(spec)


def local_cuda_devices(sub: str = subsystems.RENDER) -> list:
    """The ticked cards on THIS box that may run `sub` — `['cuda:0', …]`, empty if none.
    No 'cpu' sentinel.

    An empty list means no local CUDA card is authorized for this subsystem. Callers that require
    a GPU must handle that refusal explicitly. Stale saved indices also resolve to no available
    local card rather than aborting the request.
    """
    try:
        return [d for d in parse_devices(_local_gpus_string(sub)) if str(d).startswith("cuda:")]
    except VocalisError as exc:
        logger.warning(f"⚙ Settings names a card this box no longer has ({exc}) — treating it "
                       f"as no local card. Re-save ⚙ Settings ▸ Devices to clear this.")
        return []


def enabled_local_cards() -> list:
    """This box's own cards that are TICKED in ⚙ Settings ▸ Devices — `[{'id','label'}]`.

    The top-level tick and nothing else, which is what makes this a different question from
    `local_cuda_devices()` and not a duplicate of it. That one answers "which cards may run
    ONE subsystem", and its per-subsystem narrowing is exactly wrong here: a card ticked but
    narrowed to speech alone is still a card Vocalis will put a model on, so it is still a card
    a co-tenant has to share. The caller (the KoboldCpp load warning, 9.3) is asking about the
    hardware, not about a feature.

    Use `migrate_device_settings()` to interpret legacy `gpus` values when no device rows exist.
    Migration is read-only here, matching the `/devices` GET behavior.

    The label is the card's real name from the registry, because "cuda:1" alone does not tell
    you which card you are about to have to share.
    """
    reg = rt_gpu.gpu_registry()
    if not reg:
        return []                                    # CPU-only box: nothing to warn about
    names = {f"cuda:{g['index']}": str(g["name"]) for g in reg}
    return [{"id": r["id"], "label": names.get(r["id"], r["id"])}
            for r in migrate_device_settings(list(names)) if r.get("enabled")]


def auto_device(sub: str):
    """Resolve a one-off job's `device: "auto"` for `sub` — `(device, refusal)`.

    Exactly one of the two is set. `("cuda:1", None)` means go; `(None, "…")` means stop and
    show that sentence to the user.

    Distinguish a host with no GPUs from one whose GPUs are all unauthorized for this subsystem.
    The former may use CPU; the latter must be refused rather than silently falling back to CPU.

    `gpu.pick_device()` cannot make that distinction — it sees one empty list — which is why it
    is not the thing routes should call.

    Only automatic fallback is refused. An explicit `device="cpu"` remains valid.
    """
    cards = local_cuda_devices(sub)
    if cards:
        return rt_gpu.pick_device(cards), None
    if not rt_gpu.gpu_stats():
        return "cpu", None                  # genuinely no card on this box
    label = next((s["label"] for s in subsystems.SUBSYSTEMS if s["key"] == sub), sub)
    return None, (f"No card is allowed to run “{label}”. Tick one for it under "
                  f"⚙ Settings ▸ Devices, or choose CPU deliberately.")


def worker_note(workers, devices) -> str:
    """Return a worker-count label for a job log line."""
    if not devices:                     # an enhance or cleanup job holds no pool at all
        return "0 worker(s)"
    if isinstance(workers, dict):
        n = sum(int(workers.get(str(d), 1)) for d in devices)
    else:
        n = int(workers or 1) * max(1, len(devices))
    return f"{n} worker(s)"


def preload_default_pool():
    """Warm the default pool (all cards, configured workers/card) so the first render
    doesn't pay the model-load wait. Runs in a background thread — under GPUS, so
    it can never race a just-started job into a mid-generation pool rebuild."""
    global _model_loading
    _model_loading = True
    try:
        with GPUS:
            get_pool(default_devices(), default_workers())
        logger.info("model preloaded — ready for the first render")
    except Exception as exc:                                   # noqa: BLE001
        logger.exception(f"model preload failed (will retry lazily on first job): {exc}")
    finally:
        _model_loading = False


def current_pool():
    """The single shared pool for interactive speech (Nomi /speak, SillyTavern):
    whatever pool is currently loaded (any device/worker config), or the default
    pool if none is loaded. Never REBUILDS an existing pool — a rebuild would drop
    replicas out from under an in-flight book render sharing it. Callers submit at
    INTERACTIVE priority so their chunks interleave with and outrank batch book
    chunks in the shared queue."""
    p = _pool
    if p is not None and not getattr(p, "poisoned", False):
        return p
    return get_pool(default_devices(), default_workers())
