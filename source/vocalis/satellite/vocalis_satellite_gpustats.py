"""GPU telemetry for the standalone render satellite.

This module imports no Vocalis code so it can be deployed with the satellite
folder. NVML supplies whole-card readings; Windows PDH supplies this process's
per-adapter VRAM, including child workers. Optional dependencies degrade to
null or PyTorch-reserved readings. Device mapping uses UUIDs, and PDH instance
enumeration runs in the background so request-time sampling stays bounded.

The HTTP route is polled frequently, so dependency and state-change diagnostics
are logged once per condition rather than once per sample.

October 10, 2026: the same NVML reads are also offered to the main server and to the
satellite's memory decisions through `whole_card()`, because on Windows PyTorch's free-memory
number does not see other programs (the Windows NVIDIA test machine, RTX 4090: with another process holding 4 GiB,
`torch.cuda.mem_get_info` still reported 22,988 MiB free while NVML went from 10,216 to 5,670
MiB free). NVML is consulted only when PyTorch is a CUDA build, a failed start or card mapping
is retried no more often than once a minute, and no lock is held while fields are read.
"""
import os
import re
import threading
import time

from loguru import logger

# ── NVML (nvidia-ml-py) ───────────────────────────────────────────────────────

_NVML = None                        # the initialized pynvml module, once, or None
_NVML_UNAVAILABLE_LOGGED = False    # the "pip install" fix line prints once, not per request

#: What fixes either missing dependency — the same two packages, so one line covers both.
#: Windows advice only (the satellite's venv layout); see `_install_fix`.
_INSTALL_FIX = "venv\\Scripts\\pip install nvidia-ml-py pywin32"

#: Tests replace this; everything that decides "is it time to retry" reads `_clock()`.
_clock = time.monotonic

#: October 10, 2026: a failed start or a failed card mapping used to be retried on every call
#: (start) or kept for the life of the process (mapping). Both are now remembered and retried
#: no more often than this, because the main server reads these once a second per card.
RETRY_AFTER_S = 60.0

#: Held while NVML is started and while the UUID mapping is resolved, NEVER while a field is
#: read: a slow driver answer on one thread must not stall every other reader.
_INIT_LOCK = threading.Lock()
_NVML_RETRY_AT = None               # `_clock()` value before which a failed start is not retried

#: Not Windows means no pywin32 and no PDH can ever exist here, so neither is a "missing
#: package" worth a warning, and the `venv\Scripts` repair advice would be wrong. Replaced by
#: tests.
_IS_WINDOWS = os.name == "nt"


def _install_fix() -> str:
    """The repair advice appended to a missing-dependency warning: Windows only."""
    return f" Fix: {_INSTALL_FIX}" if _IS_WINDOWS else ""


def _torch_is_cuda_build(torch_mod=None) -> bool:
    """True when PyTorch is a CUDA build (not ROCm, not CPU-only). NVML is consulted only then, so
    the AMD images never try it and never log that the package is missing. A process with no
    torch at all is not a CUDA build either."""
    if torch_mod is None:
        try:
            import torch as torch_mod
        except ImportError:
            return False
    version = getattr(torch_mod, "version", None)
    return bool(getattr(version, "cuda", None)) and getattr(version, "hip", None) is None


def _nvml_module():
    """The imported, `nvmlInit()`-ed pynvml module, or `None` if PyTorch is not a CUDA build, it
    is not installed, or NVML could not start (no NVIDIA driver on this box). Cached on success:
    `nvmlInit()` runs exactly once. A failure is remembered and retried no more often than every
    `RETRY_AFTER_S` seconds, and logged once."""
    global _NVML, _NVML_UNAVAILABLE_LOGGED, _NVML_RETRY_AT
    if _NVML is not None:
        return _NVML
    if not _torch_is_cuda_build():
        return None
    with _INIT_LOCK:
        if _NVML is not None:
            return _NVML
        now = _clock()
        if _NVML_RETRY_AT is not None and now < _NVML_RETRY_AT:
            return None
        try:
            import pynvml
        except ImportError:
            _NVML_RETRY_AT = now + RETRY_AFTER_S
            if not _NVML_UNAVAILABLE_LOGGED:
                logger.warning(f"gpustats: nvidia-ml-py is not installed — GPU name, whole-card "
                               f"VRAM and sensor fields will read null; asking again in "
                               f"{RETRY_AFTER_S:.0f} s.{_install_fix()}")
                _NVML_UNAVAILABLE_LOGGED = True
            return None
        try:
            pynvml.nvmlInit()
        except pynvml.NVMLError as exc:                    # nvmlInit()'s whole failure surface —
            _NVML_RETRY_AT = now + RETRY_AFTER_S           # a box with the binding but no driver
            if not _NVML_UNAVAILABLE_LOGGED:
                logger.warning(f"gpustats: nvmlInit() failed ({exc}) — GPU name, whole-card VRAM "
                               f"and sensor fields will read null; asking again in "
                               f"{RETRY_AFTER_S:.0f} s.")  # raises exactly this, never anything else
                _NVML_UNAVAILABLE_LOGGED = True
            return None
        _NVML = pynvml
        _NVML_RETRY_AT = None
    logger.info("gpustats: NVML initialized")
    return _NVML


def _norm_uuid(u) -> str:
    """Lowercase, `GPU-` stripped. Torch's `str(props.uuid)` and NVML's `nvmlDeviceGetUUID` name
    the same physical card in the same hex, differing only by that prefix and letter case."""
    if isinstance(u, bytes):
        u = u.decode("ascii", "replace")
    return str(u).strip().lower().removeprefix("gpu-")


def resolve_cuda_to_nvml(cuda_uuids: list, nvml_uuids: list) -> dict:
    """`{cuda_idx: nvml_idx or None}` — matched by UUID (see the module docstring for why not
    PCI bus id or LUID: torch 2.6 exposes neither).

    UUIDs identify the same physical device across CUDA and NVML, whose index
    orders may differ. A single device on each side can be paired as a fallback
    when UUIDs are unavailable; otherwise unmatched devices map to `None`.
    """
    norm_nvml = [_norm_uuid(u) if u else None for u in nvml_uuids]
    out = {}
    for ci, cu in enumerate(cuda_uuids):
        ncu = _norm_uuid(cu) if cu else None
        match = None
        if ncu is not None:
            for ni, nu in enumerate(norm_nvml):
                if nu is not None and nu == ncu:
                    match = ni
                    break
        if match is None and len(cuda_uuids) == 1 and len(nvml_uuids) == 1:
            match = 0
        out[ci] = match
    return out


_MAPPING = None                      # {cuda_idx: nvml_idx or None}, resolved once and cached
_MAPPING_RETRY_AT = None             # `_clock()` value before which a failed mapping is not retried
_MAPPING_FAILURE_LOGGED = False      # the mapping failure line prints once, however many retries
_MAPPING_FALLBACK_LOGGED = set()     # cuda indices already logged as "no NVML match"
_HANDLE_WARNED = set()               # cuda indices already logged as "NVML handle unavailable"
_CARD_ACTIVE_LOGGED = set()          # cuda indices already logged as "reading through NVML"


def _resolve_mapping(torch_mod, nvml) -> dict:
    """Read every card's UUID off both APIs and hand the pair lists to `resolve_cuda_to_nvml`.

    A satellite does not hot-swap its cards while it runs, so this is resolved once (cached in
    `_MAPPING`) rather than repeated on every poll — matching the design's "resolved once,
    cached" and keeping this off the 4 Hz request path the same way PDH enumeration is.
    """
    cuda_count = torch_mod.cuda.device_count()
    cuda_uuids = []
    for i in range(cuda_count):
        try:
            cuda_uuids.append(str(torch_mod.cuda.get_device_properties(i).uuid))
        except (RuntimeError, AssertionError, AttributeError) as exc:
            # Invalid indices and unavailable CUDA devices use the first two exception types; a
            # torch build whose properties carry no `uuid` at all (added October 10, 2026, after
            # the main server began calling this) raises AttributeError.
            logger.warning(f"gpustats: cuda:{i} has no readable UUID ({exc}) — NVML fields "
                           f"remain unavailable")
            cuda_uuids.append(None)
    nvml_count = nvml.nvmlDeviceGetCount()
    nvml_uuids = []
    for i in range(nvml_count):
        try:
            nvml_uuids.append(nvml.nvmlDeviceGetUUID(nvml.nvmlDeviceGetHandleByIndex(i)))
        except nvml.NVMLError as exc:
            logger.warning(f"gpustats: NVML device {i} has no readable UUID ({exc})")
            nvml_uuids.append(None)
    mapping = resolve_cuda_to_nvml(cuda_uuids, nvml_uuids)
    logger.info(f"gpustats: cuda<->NVML mapping resolved: {mapping} "
                f"(cuda {cuda_count} card(s), NVML {nvml_count} card(s))")
    return mapping


def _mapping_for(torch_mod, nvml):
    """The cached `{cuda_idx: nvml_idx or None}` mapping, resolving it on first use; `None` while
    resolution has failed. A failure is remembered, logged once, and retried no more often than
    every `RETRY_AFTER_S` seconds (October 10, 2026; before, a failed mapping was kept for the
    life of the process, so one bad moment at start blanked every NVML field until restart)."""
    global _MAPPING, _MAPPING_RETRY_AT, _MAPPING_FAILURE_LOGGED
    mapping = _MAPPING
    if mapping is not None:
        return mapping
    with _INIT_LOCK:
        if _MAPPING is not None:
            return _MAPPING
        now = _clock()
        if _MAPPING_RETRY_AT is not None and now < _MAPPING_RETRY_AT:
            return None
        try:
            _MAPPING = _resolve_mapping(torch_mod, nvml)
        except (nvml.NVMLError, RuntimeError) as exc:
            # Every per-card read inside `_resolve_mapping` already narrows to `nvml.NVMLError`
            # or torch's `(RuntimeError, AssertionError, AttributeError)` and handles its own
            # failure; what can still reach here is `nvmlDeviceGetCount()` (NVML) or
            # `torch.cuda.device_count()` (RuntimeError).
            _MAPPING_RETRY_AT = now + RETRY_AFTER_S
            if not _MAPPING_FAILURE_LOGGED:
                _MAPPING_FAILURE_LOGGED = True
                logger.warning(f"gpustats: cuda<->NVML mapping failed ({exc}) — GPU fields stay "
                               f"unavailable; asking again in {RETRY_AFTER_S:.0f} s")
            return None
        _MAPPING_RETRY_AT = None
        return _MAPPING


def _handle_from_mapping(nvml, mapping, idx: int):
    """The NVML handle for PyTorch card `idx`, or `None` when there is none to read.

    `mapping` is `None` while resolution has failed (already logged, once, by `_mapping_for`).
    A card the mapping resolved to `None` has no UUID match (an unreadable UUID with several
    cards, or a MIG device): logged once per card as a warning, and it shows no sensor fields.
    """
    if mapping is None:
        return None
    nvml_idx = mapping.get(idx)
    if nvml_idx is None:
        if idx not in _MAPPING_FALLBACK_LOGGED:
            _MAPPING_FALLBACK_LOGGED.add(idx)
            logger.warning(f"gpustats: cuda:{idx} has no NVML match — GPU fields unavailable")
        return None
    try:
        handle = nvml.nvmlDeviceGetHandleByIndex(nvml_idx)
    except nvml.NVMLError as exc:
        if idx not in _HANDLE_WARNED:
            _HANDLE_WARNED.add(idx)
            logger.warning(f"gpustats: cuda:{idx} -> NVML {nvml_idx} handle unavailable "
                           f"({exc}) — falling back to torch for this card")
        return None
    if idx not in _CARD_ACTIVE_LOGGED:
        _CARD_ACTIVE_LOGGED.add(idx)
        logger.info(f"gpustats: cuda:{idx} reads through NVML device {nvml_idx}")
    return handle


#: NVML's memory-clock value may represent the transfer rate rather than the
#: physical clock. Infer a correction from the rated maximum: >=9500 uses ÷8,
#: >=5000 uses ÷4, and lower values use ÷1. This is only a heuristic because
#: NVML does not expose memory type; overlapping GDDR6/GDDR6X rates can be
#: ambiguous. If the maximum cannot be read, leave the field null instead of
#: reporting an unverified value.
_MCLK_DIVISOR = {}                   # {cuda_idx: divisor or None}, resolved once per card


def _resolve_mclk_divisor(nvml, handle, idx: int):
    """Resolve and cache the memory-clock correction for one card."""
    if idx in _MCLK_DIVISOR:
        return _MCLK_DIVISOR[idx]
    try:
        max_mhz = nvml.nvmlDeviceGetMaxClockInfo(handle, nvml.NVML_CLOCK_MEM)
    except nvml.NVMLError as exc:
        logger.warning(f"gpustats: cuda:{idx} max memory clock unavailable ({exc}) — mclk_mhz "
                       f"reads null for this card (the memory-class correction has nothing to "
                       f"infer a divisor from)")
        _MCLK_DIVISOR[idx] = None
        return None
    if max_mhz >= 9500:
        divisor, mem_class = 8, "GDDR6X/GDDR7"
    elif max_mhz >= 5000:
        divisor, mem_class = 4, "GDDR6"
    else:
        divisor, mem_class = 1, "HBM"
    _MCLK_DIVISOR[idx] = divisor
    # Label the NVML-reported maximum separately from the inferred physical clock.
    logger.info(f"gpustats: cuda:{idx} memory class {mem_class}: NVML's raw max memory figure "
                f"{max_mhz} ÷{divisor} → real max memory clock {round(max_mhz / divisor)} MHz")
    return divisor


_FIELD_WARNED = set()                # (cuda_idx, field name) already logged as unsupported


def _nvml_field(nvml, idx: int, field: str, fn):
    """One field, one try. `None` on any failure (a fanless card's `NVML_ERROR_NOT_SUPPORTED`
    for `fan_pct` must blank ONLY that field, never the whole card) — logged once per
    (card, field) rather than every 4 Hz poll, the same discipline as the "started/stopped"
    session log below.

    `nvml` is threaded in rather than closed over, purely so this can catch `nvml.NVMLError` —
    every field read here goes through NVML, so that is the whole failure surface, and reading
    the error class off the same object `fn`'s closure already holds is what lets a fake NVML
    module in tests carry an identical `NVMLError` attribute and be indistinguishable from the
    real pynvml here.
    """
    try:
        return fn()
    except nvml.NVMLError as exc:
        key = (idx, field)
        if key not in _FIELD_WARNED:
            _FIELD_WARNED.add(key)
            logger.warning(f"gpustats: cuda:{idx} {field} unavailable ({exc}) — reads null")
        return None


def _card_name(nvml, handle, idx: int):
    """The card's name as text, or `None`. Bytes (older bindings) are decoded."""
    name = _nvml_field(nvml, idx, "name", lambda: nvml.nvmlDeviceGetName(handle))
    return name.decode("ascii", "replace") if isinstance(name, bytes) else name


def _fill_memory_fields(entry: dict, nvml, handle, idx: int, raw: dict = None) -> None:
    """The memory half of §5.2's table: one NVML call. GB fields are 1 dp.

    `raw`, when given, also receives the memory read UNROUNDED as `total_bytes` / `used_bytes`
    (October 10, 2026: `whole_card()` feeds fit-checks and the allocator cap, which must not
    inherit a tenth of a gigabyte of rounding); `entry` is unchanged either way."""
    mem = _nvml_field(nvml, idx, "memory", lambda: nvml.nvmlDeviceGetMemoryInfo(handle))
    if mem is not None:
        entry["total_gb"] = round(mem.total / 1024 ** 3, 1)
        entry["used_gb"] = round(mem.used / 1024 ** 3, 1)
        entry["free_gb"] = round(mem.free / 1024 ** 3, 1)
        if raw is not None:
            raw["total_bytes"], raw["used_bytes"] = int(mem.total), int(mem.used)


def _fill_nvml_fields(entry: dict, nvml, handle, idx: int, raw: dict = None) -> None:
    """§5.2's table, one NVML call per field. GB fields are 1 dp; everything else is an int.
    Memory first (`_fill_memory_fields`), then the sensors."""
    _fill_memory_fields(entry, nvml, handle, idx, raw)
    util = _nvml_field(nvml, idx, "util_pct",
                       lambda: nvml.nvmlDeviceGetUtilizationRates(handle).gpu)
    entry["util_pct"] = int(util) if util is not None else None
    sclk = _nvml_field(nvml, idx, "sclk_mhz",
                       lambda: nvml.nvmlDeviceGetClockInfo(handle, nvml.NVML_CLOCK_SM))
    entry["sclk_mhz"] = int(sclk) if sclk is not None else None
    mclk_divisor = _resolve_mclk_divisor(nvml, handle, idx)
    if mclk_divisor is None:
        entry["mclk_mhz"] = None                # max clock unreadable — already logged, above
    else:
        mclk = _nvml_field(nvml, idx, "mclk_mhz",
                           lambda: nvml.nvmlDeviceGetClockInfo(handle, nvml.NVML_CLOCK_MEM))
        entry["mclk_mhz"] = round(mclk / mclk_divisor) if mclk is not None else None
    power_mw = _nvml_field(nvml, idx, "power_w", lambda: nvml.nvmlDeviceGetPowerUsage(handle))
    entry["power_w"] = round(power_mw / 1000) if power_mw is not None else None
    temp = _nvml_field(nvml, idx, "temp_c",
                       lambda: nvml.nvmlDeviceGetTemperature(handle, nvml.NVML_TEMPERATURE_GPU))
    entry["temp_c"] = int(temp) if temp is not None else None
    fan = _nvml_field(nvml, idx, "fan_pct", lambda: nvml.nvmlDeviceGetFanSpeed(handle))
    entry["fan_pct"] = int(fan) if fan is not None else None


# ── vocalis_gb via PDH (pywin32) ──────────────────────────────────────────────

_PDH = None
_PDH_UNAVAILABLE_LOGGED = False

#: Windows PDH per-process GPU memory counter instance format.
_INSTANCE_RE = re.compile(r"^pid_(\d+)_luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_(\d+)$")


def _pdh_failure_key(exc) -> tuple:
    """Return a stable key for deduplicating repeated PDH failures."""
    return (type(exc).__name__, getattr(exc, "winerror", None) or str(exc))


def _pdh_module():
    global _PDH, _PDH_UNAVAILABLE_LOGGED
    if _PDH is not None:
        return _PDH
    if not _IS_WINDOWS:
        # October 10, 2026: PDH is a Windows facility. On Linux (the Docker images) pywin32 can
        # never be installed, so its absence is not a fault to warn about, and the Windows repair
        # advice would be wrong. vocalis_gb uses torch.cuda.memory_reserved(), logged once by
        # `sample()` with its reason.
        return None
    try:
        import pywintypes
        import win32pdh
    except ImportError:
        if not _PDH_UNAVAILABLE_LOGGED:
            logger.warning(f"gpustats: pywin32 is not installed — vocalis_gb falls back to "
                           f"torch.cuda.memory_reserved(), which misses the CUDA context and "
                           f"cuBLAS/cuDNN workspaces held in this process. Fix: {_INSTALL_FIX}")
            _PDH_UNAVAILABLE_LOGGED = True
        return None
    # `win32pdh.error` already aliases `pywintypes.error` by pywin32's own convention (every
    # win32*-extension module does), but this pins it explicitly rather than trusting an
    # undocumented alias. Every `except pdh.error` below reads the class off the object this
    # function hands back — the same reason `_nvml_field` reads `nvml.NVMLError` off `nvml`
    # rather than a separately cached class — which is what lets the fake PDH module in tests
    # carry an identical `.error` attribute and be indistinguishable from the real win32pdh here.
    win32pdh.error = pywintypes.error
    _PDH = win32pdh
    return _PDH


def _own_pids() -> list:
    """Return this process and any resident lead-vocal worker PIDs."""
    pids = [os.getpid()]
    try:
        import vocalis_satellite_leadvocal as leadvocal
        pids.extend(leadvocal.worker_pids())
    except (ImportError, AttributeError) as exc:
        # ImportError: a satellite that never installed lead-vocal at all. AttributeError: an
        # older copy of this same module, from before `worker_pids()` existed. Either way this
        # process's own vocalis_gb is unaffected; only the worker's slice is missing from the sum.
        logger.debug(f"gpustats: could not read the lead-vocal worker PID ({exc}) — this "
                    f"process's own vocalis_gb is unaffected; only the worker's slice is "
                    f"missing from the sum")
    return pids


class PdhSampler:
    """Refresh per-process GPU memory readings outside the request path.

    `collect()` reads the open query under the same lock used when swapping or
    closing it, preventing a native use-after-close. Enumeration and recovery
    happen in the background. Repeated failures and unchanged refreshes produce
    one diagnostic per state rather than one message per polling request.
    """

    #: How often to re-enumerate while a polling session is active, even with no PID change —
    #: cheap insurance against a stale instance list outliving its usefulness.
    REFRESH_S = 5.0

    def __init__(self, pdh_loader=_pdh_module, pid_source=_own_pids):
        self._pdh_loader = pdh_loader
        self._pid_source = pid_source
        self._lock = threading.Lock()
        self._hquery = None
        self._counters = {}          # instance name -> (hcounter, pid, luid)
        self._enumerated_pids = None  # the PID set the CURRENT query was opened for
        self._last_enum_t = 0.0       # monotonic time of the last SUCCESSFUL enumeration
        self._last_attempt_t = 0.0    # monotonic time of the last enumeration attempt
        self._last_logged_instances = None   # the instance-name set the last INFO line reported,
                                              # or None before the first enumeration has logged
        self._last_failure_key = None   # `_pdh_failure_key(exc)` of the enumeration failure
                                         # last logged, or None while enumeration is healthy
        self._last_collect_failure = None  # the collect()-side failure key last logged, or None
        self._needs_reenum = False    # collect() sets this when a read goes bad; tick() (never
                                       # a request) is what actually re-enumerates for it

    def _log_enum_failure(self, exc, prefix: str) -> None:
        """Log one message per distinct enumeration failure."""
        key = _pdh_failure_key(exc)
        with self._lock:
            if self._last_failure_key == key:
                return
            self._last_failure_key = key
        logger.warning(f"gpustats: {prefix} ({exc}) — vocalis_gb falls back to "
                       f"torch.cuda.memory_reserved() until the next attempt")

    def _enumerate(self, reason: str) -> None:
        """Open a fresh query over whatever instances belong to our current PIDs, and swap it
        in for the old one. Never called from the request path — see the class docstring.

        Logs at INFO only when the matched instance set is new information — the first
        enumeration, or a set that differs from the last one logged; see the class docstring.
        A failure logs once per distinct reason (`_log_enum_failure`) and a return to health
        logs once more, rather than either repeating every attempt."""
        pdh = self._pdh_loader()
        if pdh is None:
            return
        with self._lock:
            self._last_attempt_t = time.monotonic()   # throttle failures as well as successful scans
        pids = set(self._pid_source())
        t0 = time.monotonic()
        try:
            # Refresh PDH's cached object list so newly-created process instances
            # are visible before counters are enumerated.
            pdh.EnumObjects(None, None, pdh.PERF_DETAIL_WIZARD, 1)
            _counter_names, instances = pdh.EnumObjectItems(
                None, None, "GPU Process Memory", pdh.PERF_DETAIL_WIZARD)
        except pdh.error as exc:
            self._log_enum_failure(exc, "PDH enumeration failed")
            return
        matches = {}
        for inst in instances:
            m = _INSTANCE_RE.match(inst)
            if m and int(m.group(1)) in pids:
                matches[inst] = (int(m.group(1)), m.group(2))     # (pid, luid)
        hquery = None
        try:
            hquery = pdh.OpenQuery()
            hcounters = {}
            for inst, (pid, luid) in matches.items():
                path = f"\\GPU Process Memory({inst})\\Dedicated Usage"
                hcounters[inst] = (pdh.AddCounter(hquery, path), pid, luid)
        except pdh.error as exc:
            if hquery is not None:
                try:
                    pdh.CloseQuery(hquery)
                except pdh.error as close_exc:
                    logger.warning(f"gpustats: closing incomplete PDH query failed ({close_exc})")
            self._log_enum_failure(exc, "PDH query setup failed")
            return
        instance_set = frozenset(hcounters.keys())
        with self._lock:
            old_query = self._hquery
            self._hquery, self._counters = hquery, hcounters
            self._enumerated_pids = frozenset(pids)
            self._last_enum_t = time.monotonic()
            prev_instances = self._last_logged_instances
            changed = prev_instances is None or instance_set != prev_instances
            if changed:
                self._last_logged_instances = instance_set
            recovered = self._last_failure_key is not None
            self._last_failure_key = None
            # Close under the same lock used by `collect()` so it cannot read a
            # query after it has been replaced.
            if old_query is not None:
                try:
                    pdh.CloseQuery(old_query)
                except pdh.error as exc:
                    # Best effort; an old handle leaking a few bytes is not worth failing the
                    # new query over.
                    logger.debug(f"gpustats: closing the previous PDH query failed ({exc})")
        if recovered:
            logger.info(f"gpustats: PDH enumeration recovered ({reason}) — {len(hcounters)} "
                        f"instance(s) for pid(s) {sorted(pids)} in {time.monotonic() - t0:.3f}s")
            return                    # the recovery line already said what this call found
        if not changed:
            return                    # same instances as last time — nothing new to say
        if prev_instances is None:
            logger.info(f"gpustats: PDH enumeration ({reason}) found {len(hcounters)} "
                        f"instance(s) for pid(s) {sorted(pids)} in {time.monotonic() - t0:.3f}s")
        else:
            logger.info(f"gpustats: PDH enumeration ({reason}) found {len(hcounters)} "
                        f"instance(s) for pid(s) {sorted(pids)} (was {len(prev_instances)}) "
                        f"in {time.monotonic() - t0:.3f}s")

    def tick(self, active: bool) -> None:
        """Refresh off-request when process membership changes or the query is stale.

        Failed attempts are throttled to `REFRESH_S`; collection failures request
        a new query here rather than reopening it on the request path.
        """
        if not active:
            return
        pdh = self._pdh_loader()
        if pdh is None:
            return
        pids = frozenset(self._pid_source())
        with self._lock:
            known = self._enumerated_pids
            last_attempt = self._last_attempt_t
            forced = self._needs_reenum
            if forced:
                self._needs_reenum = False
        if forced:
            self._enumerate("a request-path read failure asked for a re-enumeration")
        elif known is not None and pids != known:
            self._enumerate("PID set changed")
        elif time.monotonic() - last_attempt >= self.REFRESH_S:
            self._enumerate("first sample" if known is None else "periodic refresh")

    def collect(self) -> dict:
        """Collect readings from the existing query without enumerating instances.

        Returns `{instance: (bytes, pid, luid)}`; empty means PDH is unavailable
        or no query has been opened yet. The lock protects the query while PDH
        reads it, preventing background enumeration from closing it mid-collect.
        Failures mark the sampler for background re-enumeration.
        """
        pdh = self._pdh_loader()
        if pdh is None:
            return {}
        warn_msg = None       # logged AFTER the lock is released, so a slow sink never holds it
        recovered = False
        out = {}
        with self._lock:
            hquery, counters = self._hquery, self._counters
            if hquery is None or not counters:
                return {}
            try:
                pdh.CollectQueryData(hquery)
            except pdh.error as exc:
                key = ("collect", _pdh_failure_key(exc))
                if self._last_collect_failure != key:
                    self._last_collect_failure = key
                    warn_msg = (f"PDH collect failed ({exc}) — vocalis_gb falls back to "
                               f"torch.cuda.memory_reserved() for this sample; "
                               f"re-enumerating on the next tick")
                self._needs_reenum = True
                collected = False
            else:
                collected = True
            if collected:
                failed = []
                for inst, (hcounter, pid, luid) in counters.items():
                    try:
                        _fmt, val = pdh.GetFormattedCounterValue(hcounter, pdh.PDH_FMT_LARGE)
                        out[inst] = (int(val), pid, luid)
                    except pdh.error:
                        failed.append(inst)
                if failed:
                    key = ("read", tuple(sorted(failed)))
                    if self._last_collect_failure != key:
                        self._last_collect_failure = key
                        warn_msg = (f"PDH read failed for {', '.join(failed)} — "
                                   f"re-enumerating on the next tick")
                    self._needs_reenum = True
                elif self._last_collect_failure is not None:
                    self._last_collect_failure = None
                    recovered = True
        if warn_msg is not None:
            logger.warning(f"gpustats: {warn_msg}")
        if recovered:
            logger.info("gpustats: PDH reads recovered")
        return out


_PDH_SAMPLER = PdhSampler()
_VOCALIS_GB_FALLBACK_LOGGED = set()     # fallback reasons already logged (once each)


def _vocalis_gb_bytes(cuda_indices: list, readings: dict, memory_reserved_fn) -> tuple:
    """Return `{cuda_index: bytes}` plus a fallback reason, if needed.

    PDH readings can be attributed only when there is one CUDA device and one
    adapter LUID among this process's instances. Otherwise use per-device
    `memory_reserved()` values because no LUID-to-CUDA-index mapping is exposed.
    """
    def _reserved(i):
        # `memory_reserved_fn` is `torch.cuda.memory_reserved` in production, and `sample()`'s
        # own contract is "never raises" — this was the one call in the whole vocalis_gb
        # fallback ladder with no guard at all. `memory_reserved` reads `memory_stats(device=i)`,
        # a thin wrapper over the CUDA runtime, whose documented failure mode is RuntimeError.
        try:
            return memory_reserved_fn(i)
        except RuntimeError as exc:
            logger.warning(f"gpustats: cuda:{i} memory_reserved() unavailable ({exc}) — "
                           f"vocalis_gb reads null for this card")
            return None

    if not readings:
        return ({i: _reserved(i) for i in cuda_indices},
                "no PDH instances yet" if _IS_WINDOWS else "PDH is Windows-only")
    luids = {luid for _b, _p, luid in readings.values()}
    if len(luids) == 1 and len(cuda_indices) == 1:
        total = sum(b for b, _p, _l in readings.values())
        return ({cuda_indices[0]: total}, None)
    if len(luids) > 1:
        reason = f"{len(luids)} different LUIDs among this process's own PDH instances"
    else:
        reason = (f"{len(cuda_indices)} CUDA devices and no LUID-to-CUDA mapping exists on "
                 f"this stack (torch 2.6 exposes no LUID)")
    return ({i: _reserved(i) for i in cuda_indices}, reason)


# ── AMD cards: the package's own readers (October 10, 2026) ───────────────────

#: The main app's `tts_utils` module when the satellite settled on it as its whole-card source
#: (`set_package_readers`, called once by `server.py` at start), else None. NVML has no handle for
#: an AMD card, so before this an AMD satellite sent every card readout as null and the Vocalis
#: header showed its cards as "0.0 / 0.0 GB" with no name (the AMD Linux test machine, two Radeon AI PRO R9700, October
#: 10, 2026). The package's readers (AMD sysfs and hwmon) already answered inside that container:
#: memory 13.2 of 31.9 GB, busy 4 %, 45 C, 18 W, clocks 117/96 MHz, fan 20 %, six reads for a
#: card in 0.16 ms. A standalone satellite folder or a Windows source satellite has no such module
#: and keeps null fields.
_CARD_READERS = None
_READER_WARNED = set()               # (cuda_idx, field) already logged as unavailable
_READER_NAMES = {}                   # cuda_idx -> device name; a card's name never changes

_READER_FUNCTIONS = ("vram_used_total_sensor", "gpu_util_percent", "gpu_temp_c", "gpu_power_w",
                     "gpu_clocks_mhz", "gpu_fan_pct")


def set_package_readers(readers) -> bool:
    """Install the module that carries the package's card readers (`tts_utils`), or `None`.
    Returns whether the readers are in use; a module missing any of them is refused and logged
    (the fields then stay null, as on a standalone folder)."""
    global _CARD_READERS
    if readers is not None:
        missing = [n for n in _READER_FUNCTIONS if not callable(getattr(readers, n, None))]
        if missing:
            logger.warning(f"gpustats: the package readers are missing {missing} -- AMD card "
                           f"readouts stay unavailable")
            readers = None
    _CARD_READERS = readers
    return readers is not None


def _reader_value(idx: int, field: str, fn):
    """One reader, one try. `None` if it raises or answers `None`; either way logged once per
    (card, field), and never raised: a failing reader must not fail the verb."""
    try:
        value = fn()
    except Exception as exc:                      # logged below; see the docstring
        value = None
        why = f"raised {type(exc).__name__}: {exc}"
    else:
        why = "returned nothing"
    if value is None:
        _reader_warn_once(idx, field, why)
    return value


def _reader_warn_once(idx: int, field: str, why: str) -> None:
    if (idx, field) not in _READER_WARNED:
        _READER_WARNED.add((idx, field))
        logger.warning(f"gpustats: cuda:{idx} {field} {why} -- reads null")


def _fill_from_package_readers(entry: dict, idx: int, torch_mod) -> None:
    """Fill `entry` for an AMD card from the package's readers. Each field stands alone.

    Rounding is `vocalis.runtime.gpu.gpu_stats`'s: one decimal, free = total minus used.
    The name comes from `torch.cuda.get_device_name`, which reads the device properties and does
    NOT create a CUDA context (checked October 10, 2026 inside the satellite image on a Radeon
    AI PRO R9700: the property and name reads moved the card's VRAM by 0.1 MB, noise from other
    processes, while a one-element allocation on the same card added 202 MB). Cached per card.
    """
    r = _CARD_READERS
    name = _READER_NAMES.get(idx)
    if name is None:
        name = _reader_value(idx, "name", lambda: torch_mod.cuda.get_device_name(idx))
        if name is not None:
            _READER_NAMES[idx] = name = str(name)
    entry["name"] = name

    def memory_gb():
        # The system sensor ONLY (October 10, 2026). `vram_used_total` falls through to
        # `torch.cuda.mem_get_info` when the sensor is silent, which would create a CUDA context
        # on a card that holds no model and report PyTorch's number as the whole card's; this
        # module's rule is that sampling never creates a context. Silent sensor: null memory.
        sensor = r.vram_used_total_sensor(idx)
        if sensor is None:
            return None
        used, total = sensor
        return (round(total / 1024 ** 3, 1), round(used / 1024 ** 3, 1),
                round((total - used) / 1024 ** 3, 1))

    mem = _reader_value(idx, "memory", memory_gb)
    if mem is not None:
        entry["total_gb"], entry["used_gb"], entry["free_gb"] = mem
    for field, fn in (("util_pct", r.gpu_util_percent), ("temp_c", r.gpu_temp_c),
                      ("power_w", r.gpu_power_w), ("fan_pct", r.gpu_fan_pct)):
        entry[field] = _reader_value(idx, field, lambda fn=fn: _as_int(fn(idx)))
    # One call answers both clocks; either half may be None on its own.
    clocks = _reader_value(idx, "clocks", lambda: tuple(_as_int(c) for c in r.gpu_clocks_mhz(idx)))
    if clocks is not None and len(clocks) == 2:
        entry["sclk_mhz"], entry["mclk_mhz"] = clocks
        for field, v in (("sclk_mhz", clocks[0]), ("mclk_mhz", clocks[1])):
            if v is None:
                _reader_warn_once(idx, field, "returned nothing")


def _as_int(v):
    return None if v is None else int(v)


def _is_rocm(torch_mod) -> bool:
    return bool(getattr(getattr(torch_mod, "version", None), "hip", None))


def _one_gpu(idx: int, device: str, torch_mod, nvml, mapping, voc_bytes: dict) -> dict:
    """One `gpus[]` entry — every key always present, `None` for anything unreadable (§5.1).

    `mapping` is `None` while the cuda<->NVML mapping has failed (see `_mapping_for`)."""
    entry = {"index": idx, "device": device, "name": None,
             "total_gb": None, "used_gb": None, "free_gb": None, "vocalis_gb": None,
             "util_pct": None, "sclk_mhz": None, "mclk_mhz": None,
             "power_w": None, "temp_c": None, "fan_pct": None}

    handle = _handle_from_mapping(nvml, mapping, idx) if nvml is not None else None

    if handle is not None:
        entry["name"] = _card_name(nvml, handle, idx)
        _fill_nvml_fields(entry, nvml, handle, idx)
    elif _CARD_READERS is not None and _is_rocm(torch_mod):
        # An AMD card: NVML has no handle for it, but the package's own readers do (see
        # `_CARD_READERS`). NVIDIA cards with a handle never reach this branch.
        _fill_from_package_readers(entry, idx, torch_mod)
    # No handle: either NVML is entirely unavailable (already logged once, above), the mapping
    # failed (logged once by `_mapping_for`), or this specific card had no UUID match — the latter
    # is a per-card fact and `_handle_from_mapping` gave it its own once-only line.
    # PyTorch does not expose whether this particular GPU already owns a CUDA context.
    # `is_initialized()` is process-wide, and even `get_device_name()` calls
    # `get_device_properties()` which can trigger lazy CUDA initialization. Leave fields
    # that NVML could not supply empty rather than creating a context just to report them.

    voc_b = voc_bytes.get(idx)
    if voc_b is not None:
        voc_gb = round(voc_b / 1024 ** 3, 1)
        # The whole-card and per-process readings are sampled separately. Clamp
        # timing or rounding differences so the per-process value stays bounded.
        if entry["used_gb"] is not None:
            voc_gb = min(voc_gb, entry["used_gb"])
        entry["vocalis_gb"] = voc_gb
    return entry


def sample(engine) -> dict:
    """Return one telemetry entry per available device, leaving unreadable fields null.

    Sampling does not create a CUDA context just to collect telemetry.
    """
    import torch

    devices = engine.available_devices()
    if not devices:
        return {"gpus": []}
    indices = [int(d.split(":")[1]) for d in devices]

    nvml = _nvml_module()
    # `None` while the mapping has failed: it is retried (at most once a minute) rather than
    # kept as an all-`None` answer for the life of the process.
    mapping = _mapping_for(torch, nvml) if nvml is not None else None

    readings = _PDH_SAMPLER.collect()
    voc_bytes, reason = _vocalis_gb_bytes(
        indices, readings, lambda i: torch.cuda.memory_reserved(i))
    if reason is not None and reason not in _VOCALIS_GB_FALLBACK_LOGGED:
        _VOCALIS_GB_FALLBACK_LOGGED.add(reason)
        logger.info(f"gpustats: vocalis_gb via torch.cuda.memory_reserved() — {reason}")

    # Session transitions and once-only fallback diagnostics provide useful context
    # without emitting a log line for every high-frequency sample.
    gpus = [_one_gpu(i, d, torch, nvml, mapping, voc_bytes) for i, d in zip(indices, devices)]
    return {"gpus": gpus}


# ── one card, without an engine (October 10, 2026) ───────────────────────────

_CARD_CACHE = {}                     # cuda_idx -> (`_clock()` at the read, result dict)
_CARD_CACHE_MU = threading.Lock()    # guards the dict only, never an NVML call


def whole_card(cuda_index: int, max_age_s: float = 0.0, torch_mod=None,
               memory_only: bool = False):
    """One card's whole-card NVML fields for a PyTorch CUDA index, or `None` when NVML cannot
    answer for it. No satellite engine, no PDH, no sampling session needed: this is the entry
    point the main server's `tts_utils.vram_used_total` and sensor readers, and the satellite's
    free-memory decisions, share, so the NVML initialization, the UUID mapping and the
    per-field tolerance exist exactly once.

    Returns `{"name", "total_bytes", "used_bytes", "util_pct", "sclk_mhz", "mclk_mhz",
    "power_w", "temp_c", "fan_pct"}`: memory in bytes UNROUNDED (a fit-check must not inherit a
    tenth of a gigabyte of rounding), the rest in the units of the satellite's `gpus[]` entry.
    Each field is `None` on its own when the driver does not offer it (a fanless card blanks
    `fan_pct` only). `None` as the whole answer means: PyTorch is not a CUDA build (NVML is never
    consulted on ROCm or CPU, so the AMD images never log a missing package), NVML did not start
    or the card mapping failed (both retried at most once a minute), or this card has no UUID
    match (logged once per card). The caller then uses PyTorch's own number.

    `max_age_s` > 0 accepts a read at most that old: `gpu_stats` asks for a card's memory and
    then its five sensors a few milliseconds apart, and one NVML pass answers all six. 0 always
    reads. No lock is held across the NVML reads.

    `memory_only=True` is the cheap question "how full is this card" (the satellite's decode
    loop asks it every half second): it makes the memory call and reads the name, and none of
    the sensor calls, and returns `{"name", "total_bytes", "used_bytes"}` only. The failure,
    retry and no-match rules are identical for both modes. A fresh enough full read in the cache
    answers it too (it carries the same two numbers); a memory-only read is never cached, so it
    cannot stand in for a full one.
    """
    idx = int(cuda_index)
    if max_age_s > 0:
        with _CARD_CACHE_MU:
            hit = _CARD_CACHE.get(idx)
        if hit is not None and 0 <= _clock() - hit[0] <= max_age_s:
            cached = dict(hit[1])
            if memory_only:
                return {k: cached[k] for k in ("name", "total_bytes", "used_bytes")}
            return cached
    nvml = _nvml_module()
    if nvml is None:
        return None
    if torch_mod is None:
        import torch as torch_mod
    handle = _handle_from_mapping(nvml, _mapping_for(torch_mod, nvml), idx)
    if handle is None:
        return None
    if memory_only:
        raw = {}
        _fill_memory_fields({}, nvml, handle, idx, raw)
        return {"name": _card_name(nvml, handle, idx),
                "total_bytes": raw.get("total_bytes"), "used_bytes": raw.get("used_bytes")}
    entry, raw = {}, {}
    _fill_nvml_fields(entry, nvml, handle, idx, raw)
    out = {"name": _card_name(nvml, handle, idx),
           "total_bytes": raw.get("total_bytes"), "used_bytes": raw.get("used_bytes"),
           "util_pct": entry.get("util_pct"), "sclk_mhz": entry.get("sclk_mhz"),
           "mclk_mhz": entry.get("mclk_mhz"), "power_w": entry.get("power_w"),
           "temp_c": entry.get("temp_c"), "fan_pct": entry.get("fan_pct")}
    with _CARD_CACHE_MU:
        _CARD_CACHE[idx] = (_clock(), out)
    return dict(out)


# ── console noise: the session, not the poll (§5.4) ──────────────────────────

class PollTracker:
    """Log polling-session transitions per client instead of logging every request.

    A timer detects when polling stops because there may be no later request.
    Clock and tick are injectable for deterministic tests.
    """

    #: "No poll for this long" is what starts and stops a session — matches the header's own
    #: 3-second staleness rule (§6.2 of the design) so the two agree about what "still polling"
    #: means.
    STALE_AFTER_S = 3.0

    def __init__(self, clock=time.monotonic, log=logger):
        self._clock = clock
        self._log = log
        self._lock = threading.Lock()
        self._sessions = {}          # ip -> {"last": t, "count": n}

    def note_poll(self, ip: str) -> None:
        """Call on every SUCCESSFUL gpustats request. Cheap — one dict update, no I/O — so it
        costs nothing to call at 4 Hz; only a NEW session (none seen in the last `STALE_AFTER_S`)
        logs anything."""
        now = self._clock()
        with self._lock:
            s = self._sessions.get(ip)
            fresh = s is None or now - s["last"] >= self.STALE_AFTER_S
            if fresh:
                self._sessions[ip] = {"last": now, "count": 1}
            else:
                s["last"] = now
                s["count"] += 1
        if fresh:
            self._log.info(f"stats polling started — {ip}")

    def tick(self, now: float = None) -> None:
        """One check for sessions gone silent for `STALE_AFTER_S`. Called once a second by the
        background thread (`start_background`), or directly by a test with an injected `now`."""
        now = self._clock() if now is None else now
        stopped = []
        with self._lock:
            for ip, s in list(self._sessions.items()):
                if now - s["last"] >= self.STALE_AFTER_S:
                    stopped.append((ip, s["count"]))
                    del self._sessions[ip]
        for ip, count in stopped:
            self._log.info(f"stats polling stopped — {ip} (last poll {self.STALE_AFTER_S:.0f} s "
                           f"ago, {count} poll{'s' if count != 1 else ''})")

    def active(self) -> bool:
        """Is any client's session currently live? Read by `PdhSampler.tick()` — the PDH
        background refresh only needs to run while somebody is actually polling."""
        now = self._clock()
        with self._lock:
            return any(now - s["last"] < self.STALE_AFTER_S for s in self._sessions.values())


_POLL_TRACKER = PollTracker()


def note_poll(ip: str) -> None:
    """Called from `server.py`'s `/satellite/gpustats` route on every successful request."""
    _POLL_TRACKER.note_poll(ip)


_BACKGROUND = {"thread": None}


def start_background(interval_s: float = 1.0, sleep=time.sleep) -> None:
    """One shared 1 Hz daemon thread for both timers this module needs — the poll-session
    "stopped" detector and the PDH re-enumeration — so a satellite with gpustats support running
    gains exactly one extra thread, not two. Started once, from `server.main()`.

    Tests never call this: they drive `PollTracker.tick()` and `PdhSampler.tick()` directly with
    an injected clock/`now`, so nothing here needs a real sleep to be exercised — see both
    classes' docstrings.
    """
    if _BACKGROUND["thread"] is not None:
        return

    def _loop():
        while True:
            sleep(interval_s)
            try:
                active = _POLL_TRACKER.active()
                _POLL_TRACKER.tick()
                _PDH_SAMPLER.tick(active)
            except Exception as exc:                      # noqa: BLE001 — a dead housekeeping
                # thread means "stopped" never prints again and vocalis_gb goes stale forever,
                # neither of which is worth taking a render down over.
                logger.warning(f"gpustats: background tick failed ({exc})")

    t = threading.Thread(target=_loop, name="gpustats-housekeeping", daemon=True)
    _BACKGROUND["thread"] = t
    t.start()
    logger.info(f"gpustats: housekeeping thread started ({interval_s:.0f} s tick)")


if __name__ == "__main__":                                     # a one-shot smoke check by hand
    import json

    class _FakeEngine:
        @staticmethod
        def available_devices():
            import torch
            return [f"cuda:{i}" for i in range(torch.cuda.device_count())]

    print(json.dumps(sample(_FakeEngine()), indent=2))
