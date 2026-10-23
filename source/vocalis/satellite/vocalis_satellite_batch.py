"""Batched inference and device-aware memory bounds for satellite rendering.

Batching shares model-weight reads across chunks. Preserve stock T3 semantics by zeroing the
CFG unconditional row before adding positional embeddings, embedding text before left padding,
and passing the attention mask directly to the transformer and speech head. Batch-of-one token
parity is the compatibility check. S3Gen uses stochastic decoding, so compare sample count and
RMS rather than waveform correlation.
"""
import threading
import time

import numpy as np
from loguru import logger

# Serialize capacity measurement and batch execution per device. Otherwise concurrent replicas
# can size from the same free-memory reading and collectively exceed the card's budget. Release
# the lock before yielding results so network consumption does not serialize later GPU work.
_PASS_LOCKS = {}
_PASS_LOCKS_MU = threading.Lock()


def _pass_lock(dev: str):
    with _PASS_LOCKS_MU:
        lk = _PASS_LOCKS.get(dev)
        if lk is None:
            lk = _PASS_LOCKS[dev] = threading.Lock()
        return lk

# 24 kHz over a 25 Hz speech-token rate. Keep aligned with the serial output length.
SAMPLES_PER_TOKEN = 960

# Upper bound for the capacity estimate. `batch_cap()` applies the stricter text-length and
# current-free-memory limits; both values are needed to bound work on the running card.
MAX_BATCH = 32

# Free-memory reserve for other processes sharing the device.
#
# 🔴 KEEP A FULL GIGABYTE BETWEEN THIS AND `VRAM_FLOOR_GB` (Doug, 2026-10-22). At 2.0 against a
# 1.5 floor, the half gigabyte between what a batch is planned to leave free and where the watchdog
# trips was all the room the desktop programs on a shared card had to grow into. On a 24 GB card that
# evening a batch of 17 tripped at 1.35 GB free and crawled at 1.05x realtime for over two minutes
# (S3Gen.inference cannot be interrupted), then a second batch tripped too. The floor went to 2.0
# because the card was already crawling at 1.35, and this went to 3.0 with it: a floor at or above
# the reserve would trip on a batch that used exactly what it was planned to use.
RESERVE_GB = 3.0

# ── KV-cache cost model ───────────────────────────────────────────────────────
#
# Approximate the KV-cache size from model dimensions and sequence positions:
#
#       2 (K and V) x layers x kv_heads x head_dim x bytes-per-element        <- per position
#       x  2N (CFG doubles every row)  x  (cond + text_tokens + 1 + steps)    <- positions
#
# For Chatterbox T3 this predicts 240 KiB per position. Measurements across batch sizes and text
# lengths were about 4% higher, so the estimate rounds up to 250 KiB.
#
# Memory grows approximately linearly with batch size when chunk lengths are held constant.
KIB_PER_KV_POSITION = 250.0

# Positions in the conditioning prefix (speaker embedding + perceiver-resampled prompt + emotion).
# Measured from `T3.prepare_conditioning`; a property of the voice, and stable across ours.
COND_POSITIONS = 34

# Text characters -> text tokens, and text characters -> decode steps. Both R² > 0.99 over the
# same 21 cells. These are what let the cost be computed from TEXT, at submit time, before a
# single token has been decoded.
TEXT_TOKENS_BASE, TEXT_TOKENS_PER_CHAR = 7.2, 0.5701
STEPS_BASE, STEPS_PER_CHAR = 24.4, 1.088

# The text-to-step estimate is approximate because punctuation and prose structure affect token
# counts. Each device learns a per-process ceiling from observed passes: a failed size lowers the
# ceiling by one chunk, and a successful pass at the ceiling raises it by one. Keep this adaptive
# limit in memory because available capacity changes with other device workloads.
_CEILING = {}                                   # device -> largest batch it may attempt
_LEARNED_MU = threading.Lock()


def batch_ceiling(device: str) -> int:
    """The largest batch this card may attempt, or 0 for "nothing has failed here yet"."""
    with _LEARNED_MU:
        return int(_CEILING.get(str(device), 0))


def note_batch_too_big(device: str, n: int) -> int:
    """A pass of `n` tripped: this card may not attempt `n` again until something lands. -1."""
    dev = str(device)
    with _LEARNED_MU:
        cur = _CEILING.get(dev)
        nxt = max(1, int(n) - 1)
        _CEILING[dev] = nxt if cur is None else min(int(cur), nxt)
        return _CEILING[dev]


def note_batch_ok(device: str, n: int) -> None:
    """A pass of `n` landed. If it was AT the ceiling, the card has earned one more chunk.

    Only at the ceiling: a small pass landing says nothing about a big one, and raising on every
    success is how the old multiplier climbed straight back into the same wall every few minutes.
    """
    dev = str(device)
    with _LEARNED_MU:
        cur = _CEILING.get(dev)
        if cur is not None and int(n) >= int(cur):
            _CEILING[dev] = int(n) + 1

# The CUDA allocator can retain fragmented blocks as the dynamic KV cache grows. Periodically
# release cached blocks with `DROP_EVERY`; `ALLOCATOR_FACTOR` provides additional sizing margin.
# `expandable_segments` is unsupported by the Windows PyTorch builds used by this application.
ALLOCATOR_FACTOR = 3.0

# Return cached allocator blocks to the driver every `DROP_EVERY` decode steps.
DROP_EVERY = 8

# `S3Gen.inference` is an opaque call without a cancellation hook, so bound each pass by speech-token count.
VOCODER_TOKEN_BUDGET = 2000
GB_PER_1K_VOCODER_TOKENS = 0.8

# Some Windows drivers satisfy GPU allocations from host memory instead of raising an OOM,
# causing extreme slowdown. The watchdog samples free VRAM during decode; the allocator cap
# below provides a hard limit. Keep the OOM path as a fallback on systems that do raise.
# 2.0 since 2026-10-22 (was 1.5): see `RESERVE_GB`, which must stay a gigabyte above it.
VRAM_FLOOR_GB = 2.0

# `mem_get_info` reports total free memory, not the largest contiguous allocation. Fragmentation
# can therefore trigger system-memory fallback while the reported free total remains high. Bound
# the PyTorch allocator with `set_per_process_memory_fraction` so it can raise an OOM before the
# driver spills to host memory; `render_batch_iter` then halves and retries.
#
# Size the allocator cap from free VRAM at load rather than total capacity. This is a backstop;
# `batch_cap` and `RESERVE_GB` remain the finer-grained batch limits.
#
# A cap set too tight may require an extra retry; a cap set too high can allow prolonged paging.
# Round down because the latter failure is more costly.
#
# The allocator cap addresses fragmentation-related paging that a total-free-memory threshold
# cannot detect. High GPU utilization alone is not a stall signal; compare PCIe and memory
# controller activity with a healthy pass before diagnosing paging.
# 3.0 since 2026-10-22 (was 2.0), with `RESERVE_GB`: at the watchdog's 2.0 floor, a cap leaving
# only 2.0 free would trip every time torch legitimately grew to its own cap.
PROCESS_VRAM_HEADROOM_GB = 3.0

# Per-card process-memory ceiling configured by the client. It expresses a limit on what this
# process may hold, not a target or reservation. Zero means uncapped; each card has its own cap.
_VRAM_CAP_GB = 0.0
_VRAM_CAP_MU = threading.Lock()


def set_vram_cap(gb, source: str = "") -> float:
    """Set the per-card ceiling on what this process may hold, in GB. 0 (or junk) is uncapped.

    Call `server.take_vram_cap` so the allocator is rebound as well. `source` identifies which
    request supplied the limit in change logs.
    """
    try:
        v = float(gb)
    except (TypeError, ValueError):
        v = 0.0
    if v != v or v < 0:                 # NaN, or a negative someone typed
        v = 0.0
    with _VRAM_CAP_MU:
        global _VRAM_CAP_GB
        changed = abs(v - _VRAM_CAP_GB) > 1e-6
        _VRAM_CAP_GB = v
    if changed:
        logger.info(f"VRAM cap {'lifted' if v <= 0 else f'set to {v:.1f} GB per card'}"
                    f"{f' (from {source})' if source else ''}")
    return v


def vram_cap_gb() -> float:
    with _VRAM_CAP_MU:
        return _VRAM_CAP_GB


def reserved_gb(device: str) -> float:
    """What torch already holds on that card, in GB — this PROCESS, not the card.

    Use `memory_reserved`: cached blocks are still unavailable to other processes even when
    they are not currently allocated to tensors.
    """
    torch = _torch()
    if not str(device or "").startswith("cuda") or not torch.cuda.is_available():
        return 0.0
    idx = 0
    if ":" in str(device):
        try:
            idx = int(str(device).split(":")[1])
        except ValueError:
            idx = 0
    try:
        return torch.cuda.memory_reserved(idx) / 1024 ** 3
    except Exception:                   # noqa: BLE001 — a diagnostic must never be the failure
        return 0.0


def spend_budget_gb(device: str) -> float:
    """GB this process may spend on `device` RIGHT NOW. `inf` when we cannot measure the card.

    Two independent limits, and they are not the same rule:

      * the CARD's free VRAM less `RESERVE_GB` — what protects a co-tenant that is already there,
        and the only limit this file had before 1.11.
      * the CAP less what this process already holds — a configured limit for future workloads
        that cannot be inferred from current free memory.

    Subtract `RESERVE_GB` from the hardware-free-memory budget only. Applying it to the configured
    cap as well would reduce the displayed ceiling; `bound_process_memory` enforces that ceiling.
    """
    free = free_gb(device)
    room = free if free == float("inf") else max(0.0, free - RESERVE_GB)
    cap = vram_cap_gb()
    if cap <= 0:
        return room
    left = max(0.0, cap - reserved_gb(device))
    return left if room == float("inf") else min(room, left)

# Sample on wall-clock time rather than decode-step count; a step can become very slow while
# paging, which would delay a step-based watchdog.
_WATCH_SECONDS = 0.5

# Compare decode-step latency with this pass's median to detect host-memory paging. The minimum
# threshold avoids treating ordinary short-step jitter as a stall; the VRAM floor remains a
# separate early-warning signal.
_PAGING_FACTOR = 20.0
_PAGING_MIN_STEP_S = 0.5
_BASELINE_STEPS = 12          # median of the first N intervals is this pass's "healthy"

# A separate monitor covers prefill, opaque S3Gen calls, and decode steps that do not return to
# the cancellation hook. It detects a stall on wall-clock time; cancellation takes effect at the
# next available instruction boundary, while the allocator cap prevents unbounded spill.
_MONITOR_SECONDS = 2.0


def _torch():
    import torch
    return torch


def is_cuda(device: str) -> bool:
    """True for real CUDA, False for ROCm — which reports itself as `cuda` in every API.

    `device.startswith("cuda")` is also true for ROCm devices. `torch.version.hip` distinguishes
    CUDA from ROCm.
    """
    torch = _torch()
    return bool(str(device or "").startswith("cuda")
                and torch.cuda.is_available()
                and getattr(torch.version, "hip", None) is None)


def s3gen_batching_ok(device: str) -> bool:
    """Batch T3 on all supported devices; batch S3Gen only on CUDA.

    T3 batching improves throughput on CUDA and ROCm. S3Gen batching showed negligible benefit on
    the tested ROCm stack, so keep that path disabled there. Evaluate support at runtime because
    kernel performance may change with later runtimes.
    """
    return is_cuda(device)


def _dev_idx(device: str):
    """CUDA ordinal for `device`, or None when this is not a card whose memory we can read."""
    try:
        if not str(device or "").startswith("cuda") or not _torch().cuda.is_available():
            return None
    except Exception:          # noqa: BLE001 — see `_reserved_gb`: this only feeds a statistic
        return None
    if ":" in str(device):
        try:
            return int(str(device).split(":")[1])
        except ValueError:
            return 0
    return 0


# Allocation statistics feed the adaptive cost model, not rendering correctness. Missing device
# context or unsupported statistics should therefore produce no measurement rather than fail a
# pass.

def _reserved_gb(idx, peak: bool = False):
    """Torch's reserved bytes on card `idx`, in GB — the live value, or the high-water mark.

    RESERVED rather than allocated: reserved is what the driver cannot hand to anything else,
    which is the quantity `free_gb` reports on the other side of the decision. Returns None when
    the question cannot be asked.
    """
    if idx is None:
        return None
    try:
        torch = _torch()
        fn = torch.cuda.max_memory_reserved if peak else torch.cuda.memory_reserved
        return float(fn(idx)) / 1024.0 ** 3
    except Exception:          # noqa: BLE001 — never fail a pass for the sake of a statistic
        return None


def _rebase_peak(idx) -> None:
    """Move the high-water mark to right now, so a pass measures ITSELF and not its residents."""
    if idx is None:
        return
    try:
        _torch().cuda.reset_peak_memory_stats(idx)
    except Exception:          # noqa: BLE001 — as above
        pass


#: Where "how much of this card is free, in total" comes from. October 10, 2026 (the Windows NVIDIA test machine): on
#: Windows PyTorch's `mem_get_info` does not see other programs. With another process holding
#: 4 GiB of the RTX 4090 it still reported 22,988 MiB free while NVML (what nvidia-smi prints)
#: went from 10,216 to 5,670 MiB free; the same gap appears inside the Docker Desktop satellite
#: container, so it comes from how Windows hands out GPU memory, not from Docker. Every
#: free-memory decision here (batch size, the allocator cap, the paging watchdog, the capacity
#: route) therefore asks `free_gb`, which asks the whole-card source below and falls back to
#: PyTorch's number only when that source cannot answer. `server.py` settles the source ONCE at
#: start (`set_whole_card_reader`); until then, and in a standalone satellite folder, it is the
#: readout module's NVML read.
_WHOLE_CARD_STANDALONE = "NVML, then PyTorch"
_WHOLE_CARD = {"fn": None, "source": _WHOLE_CARD_STANDALONE}
_WHOLE_CARD_WARNED = set()           # reader failures already logged, once each


def set_whole_card_reader(fn, source: str) -> None:
    """Install the whole-card reader `fn(device) -> (free_gb, total_gb)` (the package's
    `tts_utils.device_mem_gb`), or `None` for the standalone NVML-then-PyTorch source. `source`
    names it for the log. Called once, by `server.py`, at start."""
    _WHOLE_CARD["fn"] = fn
    _WHOLE_CARD["source"] = source or _WHOLE_CARD_STANDALONE


def whole_card_source() -> str:
    """Which source `free_gb` is using, for logs and tests."""
    return _WHOLE_CARD["source"]


def _device_index(device: str) -> int:
    """CUDA ordinal in a device string: `cuda:1` is 1; `cuda` or anything unparsable is 0."""
    if ":" in str(device):
        try:
            return int(str(device).split(":")[1])
        except ValueError:
            return 0
    return 0


def _whole_card_free_gb(torch, idx: int):
    """The whole-card free GB from the settled source, or `None` when it cannot say. Never raises:
    a reader that fails is logged once per error type and counts as "cannot say", so the caller
    falls through to PyTorch's own number."""
    try:
        fn = _WHOLE_CARD["fn"]
        if fn is not None:
            free, _total = fn(f"cuda:{idx}")
            return None if free is None else float(free)
        # Standalone: NVML (through the readout module), consulted only for a CUDA build of
        # PyTorch -- judged on the torch this module is using, so a stand-in torch in a test
        # never reaches a real driver.
        version = getattr(torch, "version", None)
        if not getattr(version, "cuda", None) or getattr(version, "hip", None) is not None:
            return None
        import vocalis_satellite_gpustats as gpustats
        # Memory only: this runs every half second inside the decode loop, and the sensors are
        # not part of the question.
        card = gpustats.whole_card(idx, torch_mod=torch, memory_only=True)
        if card is None or card.get("total_bytes") is None or card.get("used_bytes") is None:
            return None
        return (card["total_bytes"] - card["used_bytes"]) / 1024 ** 3
    except Exception as exc:                          # logged below; see the docstring
        key = type(exc).__name__
        if key not in _WHOLE_CARD_WARNED:
            _WHOLE_CARD_WARNED.add(key)
            logger.warning(f"whole-card free-memory read failed ({key}: {exc}) -- using "
                           f"PyTorch's number instead (source: {_WHOLE_CARD['source']}); this "
                           f"is logged once per error type")
        return None


def free_gb(device: str) -> float:
    """Free VRAM on the card RIGHT NOW, in GB, or `inf` when that is not a question we can ask.

    The whole card, not this process: something else being resident is exactly the case §5 is
    about. Whole card means the driver's view where it is available (see `_WHOLE_CARD`), and
    PyTorch's `mem_get_info` otherwise. A failure of the whole-card reader falls through to
    PyTorch's number, and if that cannot be read either the answer is `inf` ("this cannot be
    measured", the same as a CPU card): this never raises, because it is called from inside the
    decode loop's step hook, where a raise would abort the pass with an unrelated error. The
    failure is logged once per error type, naming the device.
    """
    torch = _torch()
    if not str(device or "").startswith("cuda") or not torch.cuda.is_available():
        return float("inf")
    idx = _device_index(device)
    whole = _whole_card_free_gb(torch, idx)
    if whole is not None:
        return whole
    try:
        free, _total = torch.cuda.mem_get_info(idx)
    except Exception as exc:                      # logged below; see the docstring
        key = ("mem_get_info", device, type(exc).__name__)
        if key not in _WHOLE_CARD_WARNED:
            _WHOLE_CARD_WARNED.add(key)
            logger.warning(f"{device}: torch.cuda.mem_get_info failed ({type(exc).__name__}: "
                           f"{exc}) -- free memory reads as unmeasurable (inf) until it answers; "
                           f"this is logged once per device and error type")
        return float("inf")
    return free / 1024 ** 3


def free_and_total_gb(device: str) -> tuple:
    """`(whole-card free GB, PyTorch's total GB)` for a CUDA card, as one pair.

    The two halves come from different places on purpose: free is the whole-card reading (what
    `free_gb` returns), but the total is PyTorch's own, because `set_per_process_memory_fraction`
    multiplies THAT total and the cap arithmetic has to stay in its units. The engine's load log
    line and `bound_process_memory` use this so both report the same free number."""
    torch = _torch()
    _torch_free, torch_total = torch.cuda.mem_get_info(_device_index(device))
    return free_gb(device), torch_total / 1024 ** 3


# Last allocator cap LOGGED per card, in GB, so a capacity request can say so only when the cap
# really moved (measured from the last line written, so slow drift still surfaces eventually).
# The below-resident warning is likewise once per (card, cap value).
_CAP_LOGGED_GB = {}
_CAP_WARNED = set()
CAP_LOG_STEP_GB = 0.1


def bound_process_memory(device: str, on_change_only: bool = False) -> float:
    """Cap what torch may hold on this card so the driver is never asked for the overflow.

    Returns the fraction applied, or 0.0 when this is not a card we can bound.

    This makes the PyTorch allocator refuse before the driver can satisfy an allocation from host
    memory. Called once per replica at load, after current device usage can be measured, and (since
    October 10, 2026) again on each capacity request for a card that has workers
    (`on_change_only=True`): free memory now comes from the whole-card reading, so a cap set while
    another program held memory would otherwise stay low after that program left, until Unload and
    Load. Free is the whole-card reading; the fraction still divides by PyTorch's own total, the
    total PyTorch applies the fraction to. On the capacity path the "capped at" line is logged only
    when the applied cap moved by `CAP_LOG_STEP_GB` or more since the last such line.
    """
    torch = _torch()
    if not is_cuda(device):
        # ROCm and CPU: there is no sysmem fallback to defeat, a real OOM is already raised, and
        # a cap here would only be a new way to fail a render that would have succeeded.
        return 0.0
    idx = _device_index(device)
    # October 10, 2026: the free-memory reading and torch's reserved figure are taken a few
    # milliseconds apart (on the capacity path, while renders may be running). An
    # `empty_cache()` landing between the two would pair a free figure that still counts the cache
    # as used with a reserved figure that no longer includes it, leaving the cap too tight until
    # the next request. So reserved is read before AND after the free-memory read, and the larger
    # wins: never a cap below what the card showed this process holding at the start.
    mine_before = torch.cuda.memory_reserved(idx) / 1024 ** 3
    free, total = free_and_total_gb(device)
    if total <= 0:
        return 0.0
    mine = max(mine_before, torch.cuda.memory_reserved(idx) / 1024 ** 3)   # what torch holds here
    allowed = mine + max(0.0, free - PROCESS_VRAM_HEADROOM_GB)
    # Apply the configured cap as a hard allocator limit. Do not lower it beneath the memory
    # already resident; a smaller fraction would only make the next allocation fail.
    want = vram_cap_gb()
    if want > 0:
        allowed = max(mine, min(allowed, want))
        if mine > want:
            warn_key = (str(device), round(want, 3))
            if warn_key not in _CAP_WARNED:
                _CAP_WARNED.add(warn_key)
                # No "Unload and load again" advice (October 10, 2026): the cap is reapplied on
                # each capacity request, so it takes hold as torch's memory comes back.
                logger.warning(f"{device}: the {want:.1f} GB cap is below the {mine:.1f} GB torch "
                               f"already holds here — capping at what is resident; the cap is "
                               f"reapplied on each capacity request")
    fraction = max(0.05, min(1.0, allowed / total))
    torch.cuda.set_per_process_memory_fraction(fraction, idx)
    previous = _CAP_LOGGED_GB.get(str(device))
    if on_change_only and previous is not None and abs(allowed - previous) < CAP_LOG_STEP_GB:
        return fraction
    _CAP_LOGGED_GB[str(device)] = allowed
    logger.info(f"{device}: torch capped at {allowed:.1f} GB of {total:.1f} GB "
                f"({fraction:.0%}){f' — configured cap {want:.1f} GB' if want > 0 else ''}"
                f"{f' (was {previous:.1f} GB)' if previous is not None else ''}"
                f" — past that it must fail rather than page to host RAM")
    return fraction


# `ALLOCATOR_FACTOR` is an initial allowance. Each card records observed reserved/live ratios from
# completed passes. Higher observed costs take effect immediately; lowering the charge requires
# `ALLOC_RATIO_MIN_SAMPLES` observations and respects `ALLOC_RATIO_FLOOR`. The watchdog, slow-step
# detector, allocator cap, and batch ceiling remain independent safeguards.
ALLOC_RATIO_FLOOR = 1.15
ALLOC_RATIO_WINDOW = 12          # passes of history a card keeps
ALLOC_RATIO_MIN_SAMPLES = 3      # …before a measured saving may lower the initial allowance

# A measured cost ratio does not prove that a larger batch will fit: allocator overhead can scale
# nonlinearly with batch size. `ALLOC_RATIO_MARGIN` covers observed sizes; `ALLOC_GROWTH_STEP` limits
# attempts beyond the largest completed batch. Each successful rung provides evidence for the next
# attempt, while a failed attempt lowers the ceiling.
ALLOC_RATIO_MARGIN = 1.15        # what the card charges over its own worst observation
ALLOC_GROWTH_STEP = 1.25         # …and how far past its largest LANDED pass it may reach
_ALLOC_RATIO = {}                # device -> [observed reserved/live ratios]
_ALLOC_LANDED = {}               # device -> largest n that has actually completed a pass
_ALLOC_RATIO_MU = threading.Lock()


def alloc_ratio(device: str) -> float:
    """What a pass on this card actually costs, as a multiple of the KV arithmetic.

    The worst of the recent window, because under-predicting risks a severe slowdown and
    over-predicting only costs throughput. Act on higher costs after one landed pass, while
    requiring three passes before lowering the initial allowance.
    """
    with _ALLOC_RATIO_MU:
        seen = list(_ALLOC_RATIO.get(str(device)) or ())
    if not seen:
        return ALLOCATOR_FACTOR
    measured = max(ALLOC_RATIO_FLOOR, max(seen) * ALLOC_RATIO_MARGIN)
    if len(seen) < ALLOC_RATIO_MIN_SAMPLES:
        return max(ALLOCATOR_FACTOR, measured)
    return measured


def landed_cap(device: str) -> int:
    """The largest batch this card may reach, given the largest one it has actually landed.

    0 means "nothing measured yet", i.e. no growth bound at all — a fresh process is sized by
    `batch_cap`'s VRAM budget exactly as it was before any of this existed.
    """
    with _ALLOC_RATIO_MU:
        landed = int(_ALLOC_LANDED.get(str(device)) or 0)
    if landed <= 0:
        return 0
    return max(landed + 1, int(landed * ALLOC_GROWTH_STEP))


def note_pass_cost(device: str, n: int, chars: int, reserved_gb: float) -> float:
    """Record what a landed pass of `n` chunks whose longest was `chars` really took.

    `reserved_gb` is the RESERVED high-water mark of the pass, not `allocated` — reserved is what
    the driver cannot give to anything else, and it is the quantity `free_gb` is measuring on the
    other side. Returns the card's ratio after the observation, for logging.
    """
    live = live_cost_gb(n, chars)
    if live <= 0 or reserved_gb <= 0:
        return alloc_ratio(device)
    dev = str(device)
    with _ALLOC_RATIO_MU:
        seen = _ALLOC_RATIO.setdefault(dev, [])
        seen.append(reserved_gb / live)
        del seen[:-ALLOC_RATIO_WINDOW]
        # The high-water mark of what has actually RUN here. Only landed passes reach this
        # function, so this is evidence rather than intention — see `landed_cap`.
        _ALLOC_LANDED[dev] = max(int(_ALLOC_LANDED.get(dev) or 0), max(1, int(n)))
    return alloc_ratio(device)


def live_cost_gb(n: int, chars: int) -> float:
    """The KV-cache arithmetic alone, with no allocator allowance. See `pass_cost_gb`."""
    n = max(1, int(n))
    chars = max(1, int(chars))
    ttok = TEXT_TOKENS_BASE + TEXT_TOKENS_PER_CHAR * chars
    steps = STEPS_BASE + STEPS_PER_CHAR * chars
    positions = 2 * n * (COND_POSITIONS + ttok + 1 + steps)
    return positions * KIB_PER_KV_POSITION / (1024.0 * 1024.0)


def pass_cost_gb(n: int, chars: int, ratio: float = None) -> float:
    """Return estimated free VRAM needed for a pass of `n` chunks.

    The estimate uses the longest text, KV-cache arithmetic, the learned allocator ratio, and configured
    reserves. If no measured ratio is available, use the initial allowance."""
    return live_cost_gb(n, chars) * (ALLOCATOR_FACTOR if ratio is None else float(ratio))


def batch_cap(device: str, wanted: int, texts=None, lengths=None) -> int:
    """Return the largest batch the card may attempt under current memory limits.

    The result respects available free VRAM, configured cap and reserve, text lengths, learned allocator
    cost, the largest completed batch, and the ceiling from failed attempts."""
    if wanted <= 1:
        return 1
    cap = min(int(wanted), MAX_BATCH)
    # Capacity is limited by both free VRAM and the configured per-card ceiling. The reserve leaves room
    # for other workloads sharing the device.
    budget = spend_budget_gb(device)
    if budget == float("inf"):
        return cap
    # No texts to size from — the caller only said how many. Fall back to the longest chunk
    # Vocalis can produce (`tts_utils.CHUNK_SIZE`), which is the pessimistic assumption and the
    # right one when the alternative is guessing low.
    #
    # `lengths` is the same question asked without the words: the model reads nothing from a
    # chunk but `len()`, so /satellite/capacity answers from character counts alone and the
    # book's text never crosses the wire to make a scheduling decision.
    if lengths is not None:
        longest = max((int(n) for n in list(lengths)[:cap]), default=400)
    else:
        longest = max((len(str(t)) for t in texts[:cap]), default=400) if texts else 400
    per_chunk = pass_cost_gb(1, longest, alloc_ratio(device))
    if per_chunk > 0:
        cap = min(cap, int(budget // per_chunk))
    # Do not exceed the configured growth step beyond the largest batch that completed on this card.
    reach = landed_cap(device)
    if reach:
        cap = min(cap, reach)
    # …and never a size this card has already failed at — see `batch_ceiling`. Held here rather
    # than applied by the caller so `/satellite/capacity` and `render_batch_iter` cannot disagree
    # about it, which is a bug this file has had once already.
    ceiling = batch_ceiling(device)
    if ceiling:
        cap = min(cap, ceiling)
    return max(1, cap)


def vocoder_slice(device: str, token_rows) -> int:
    """Return the number of token sequences that fit one S3Gen pass.

    Sizing uses `VOCODER_TOKEN_BUDGET` and current free VRAM. Return zero when even one row cannot fit;
    S3Gen has no per-step watchdog, so callers must check before invoking it."""
    rows = list(token_rows)
    longest = max((int(r.numel()) for r in rows), default=1) or 1
    budget_tokens = VOCODER_TOKEN_BUDGET
    # 1.11 — and the cap binds here too. The vocoder pass is the second-largest allocation this
    # file makes; capping the decode and not this one would leave the ceiling half-enforced.
    usable = spend_budget_gb(device)
    if usable != float("inf"):
        budget_tokens = min(budget_tokens,
                            int(usable / GB_PER_1K_VOCODER_TOKENS * 1000.0))
    return min(len(rows), budget_tokens // longest)


def text_tokens(model, text):
    """Exactly what `ChatterboxTTS.generate` does to one text, minus the CFG duplication."""
    import torch.nn.functional as F
    from chatterbox.tts import punc_norm
    t = model.tokenizer.text_to_tokens(punc_norm(text)).to(model.device)
    t = F.pad(t, (1, 0), value=model.t3.hp.start_text_token)
    t = F.pad(t, (0, 1), value=model.t3.hp.stop_text_token)
    return t[0]


def _finished_rows(predicted, finished, n, stop) -> dict:
    """Return completed rows keyed by their positions in the batch.

    Each row is trimmed at its own stop token. Preserve completed rows when a VRAM abort interrupts other
    rows; cancellation still discards the whole batch."""
    if not predicted:
        return {}
    torch = _torch()
    try:
        toks = torch.cat(predicted, dim=1)
        out = {}
        for i in range(n):
            if not bool(finished[i]):
                continue
            row = toks[i]
            hit = (row == stop).nonzero()
            if hit.numel():
                out[i] = row[:hit[0, 0]]
        return out
    except Exception:          # noqa: BLE001 — see the docstring: no salvage, never a new failure
        return {}


def batched_t3(t3, t3_cond, text_token_rows, *, max_new_tokens=1000, temperature=0.8,
               cfg_weight=0.5, repetition_penalty=1.2, min_p=0.05, top_p=1.0,
               cancel=None):
    """Run batched T3 decoding and return token rows plus the number of decode steps.

    The effective batch is `2N` for classifier-free guidance. The function runs under inference mode and
    checks cancellation or watchdog state between decode steps."""
    torch = _torch()
    with torch.inference_mode():
        return _batched_t3(t3, t3_cond, text_token_rows, max_new_tokens=max_new_tokens,
                           temperature=temperature, cfg_weight=cfg_weight,
                           repetition_penalty=repetition_penalty, min_p=min_p, top_p=top_p,
                           cancel=cancel)


def _batched_t3(t3, t3_cond, text_token_rows, *, max_new_tokens, temperature,
                cfg_weight, repetition_penalty, min_p, top_p, cancel):
    torch = _torch()
    from transformers.generation.logits_process import (MinPLogitsWarper,
                                                        RepetitionPenaltyLogitsProcessor,
                                                        TopPLogitsWarper)
    device = t3.device
    n = len(text_token_rows)
    lmax = max(r.numel() for r in text_token_rows)

    # ── embeddings, built the way prepare_input_embeds builds them ────────────────────────
    # See the module docstring, points 1 and 2. This is not a reimplementation for its own
    # sake: the stock helper cannot express "N different text lengths".
    cond_emb = t3.prepare_conditioning(t3_cond)               # (1, len_cond, dim)
    len_cond = cond_emb.size(1)
    dim = cond_emb.size(-1)
    learned = t3.hp.input_pos_emb == "learned"

    text_emb = torch.zeros((2 * n, lmax, dim), device=device, dtype=cond_emb.dtype)
    text_mask = torch.zeros((n, lmax), dtype=torch.long, device=device)
    for i, row in enumerate(text_token_rows):
        row = row.to(device).unsqueeze(0)                     # (1, len)
        e = t3.text_emb(row)
        cond_e = e + t3.text_pos_emb(row) if learned else e
        # CFG uncond: token embedding blanked, POSITIONS KEPT — exactly what
        # prepare_input_embeds does to row 1 of a batch of 2, and the order matters.
        z = torch.zeros_like(e)
        uncond_e = z + t3.text_pos_emb(row) if learned else z
        L = row.size(1)
        text_emb[i, lmax - L:] = cond_e[0]                    # LEFT pad
        text_emb[n + i, lmax - L:] = uncond_e[0]
        text_mask[i, lmax - L:] = 1

    speech_tokens = torch.full((2 * n, 1), t3.hp.start_speech_token,
                               dtype=torch.long, device=device)
    speech_emb = t3.speech_emb(speech_tokens)
    if learned:
        speech_emb = speech_emb + t3.speech_pos_emb(speech_tokens)
    embeds = torch.cat([cond_emb.expand(2 * n, -1, -1), text_emb, speech_emb], dim=1)

    # Use `t3.tfmr` and `t3.speech_head` directly. `patched_model` is initialized lazily by `T3.inference`
    # and may not exist on a newly loaded replica. The direct path uses the underlying model and speech
    # head while preserving the attention-mask handling implemented here.
    tfmr, speech_head = t3.tfmr, t3.speech_head
    bos = torch.full((2 * n, 1), t3.hp.start_speech_token, dtype=torch.long, device=device)
    bos_embed = t3.speech_emb(bos) + t3.speech_pos_emb.get_fixed_embedding(0)
    inputs_embeds = torch.cat([embeds, bos_embed], dim=1)

    rep_proc = RepetitionPenaltyLogitsProcessor(penalty=float(repetition_penalty))
    min_p_warp = MinPLogitsWarper(min_p=min_p)
    top_p_warp = TopPLogitsWarper(top_p=top_p)

    generated = bos[:n].clone()                               # (N, 1) — the cond half only
    predicted = []
    finished = torch.zeros(n, dtype=torch.bool, device=device)
    stop = t3.hp.stop_speech_token

    # See the module docstring, point 3.
    pre = torch.ones((2 * n, len_cond), dtype=torch.long, device=device)
    post = torch.ones((2 * n, inputs_embeds.size(1) - len_cond - lmax),
                      dtype=torch.long, device=device)
    mask = torch.cat([pre, text_mask.repeat(2, 1), post], dim=1)

    def step(embs, past_kv, attn):
        # Use the model output’s `last_hidden_state` and compute speech-head logits only for the final prefix
        # position. Earlier prefix positions are not consumed.
        #
        # `last_hidden_state` is the documented output after final normalization; indexing `hidden_states[-1]`
        # would rely on an implementation detail.
        out = tfmr(inputs_embeds=embs, attention_mask=attn, past_key_values=past_kv,
                   use_cache=True, return_dict=True)
        return speech_head(out.last_hidden_state[:, -1:, :]), out.past_key_values

    logits_all, past = step(inputs_embeds, None, mask)
    for i in range(max_new_tokens):
        # Cancellation aborts the complete batch because rows share a forward pass and cannot be removed
        # independently. A VRAM abort is different: rows that already reached their stop token remain valid, so
        # `BatchTooBig` carries them to the retry handler.
        if cancel is not None:
            # The abort hook retains `predicted` and `finished` state needed to identify completed rows.
            try:
                asked_to_stop = cancel()
            except BatchTooBig as exc:
                exc.rows = _finished_rows(predicted, finished, n, stop)
                raise
            if asked_to_stop:
                raise BatchCanceled()
        logits_step = logits_all[:, -1, :]
        cond, uncond = logits_step[:n], logits_step[n:]
        logits = cond + cfg_weight * (cond - uncond)          # (N, V)
        logits = rep_proc(generated, logits)
        if temperature != 1.0:
            logits = logits / temperature
        logits = min_p_warp(generated, logits)
        logits = top_p_warp(generated, logits)
        nxt = torch.multinomial(torch.softmax(logits, dim=-1), num_samples=1)   # (N, 1)
        # A finished sequence keeps emitting its stop token; it is trimmed at the end. Freezing
        # it rather than dropping it keeps every row's position aligned with the KV cache.
        nxt = torch.where(finished.unsqueeze(1), torch.full_like(nxt, stop), nxt)
        predicted.append(nxt)
        generated = torch.cat([generated, nxt], dim=1)
        finished |= (nxt.squeeze(1) == stop)
        if bool(finished.all()):
            break
        # Periodically release cached allocator blocks so the driver can reuse them. The dynamic KV cache grows
        # by concatenation, and freed blocks may not fit later allocations.
        #
        # `expandable_segments` is unsupported by the Windows PyTorch builds used by this application.
        if DROP_EVERY and (i + 1) % DROP_EVERY == 0:
            _drop_cache()
        emb = t3.speech_emb(nxt) + t3.speech_pos_emb.get_fixed_embedding(i + 1)
        emb = torch.cat([emb, emb], dim=0)                    # (2N, 1, dim)
        mask = torch.cat([mask, torch.ones((2 * n, 1), dtype=torch.long, device=device)], dim=1)
        logits_all, past = step(emb, past, mask)

    toks = torch.cat(predicted, dim=1)                        # (N, steps)
    rows = []
    for i in range(n):
        row = toks[i]
        hit = (row == stop).nonzero()
        rows.append(row[:hit[0, 0]] if hit.numel() else row)
    return rows, toks.shape[1]


class BatchCanceled(Exception):
    """Raised out of a batch that was canceled mid-decode. Nothing is returned."""


class BatchTooBig(Exception):
    """Signal that a batch reached the VRAM safety floor.

    The exception carries token rows that completed before the abort, keyed by their positions in the
    attempted batch. The caller can preserve those rows and retry unfinished work at a smaller size; this
    is separate from user cancellation."""

    def __init__(self, *args, rows=None, done=None):
        super().__init__(*args)
        self.rows = dict(rows or {})
        self.done = dict(done or {})


def _vram_watchdog(device, floor_gb, user_cancel, monitor=None, clock=None):
    """Return a decode-step hook that checks user cancellation and monitored free VRAM.

    Raise `BatchTooBig` at the safety floor, carrying rows that already reached their stop token. User
    cancellation raises the cancellation exception and does not salvage partial output."""
    # October 10, 2026: `clock` is injectable, so a test moves time by hand instead of patching
    # `time.monotonic` for the whole process. The default is the real monotonic clock.
    now_fn = clock if clock is not None else time.monotonic
    state = {"next": now_fn() + _WATCH_SECONDS, "prev": None,
             "samples": [], "baseline": None}

    def check():
        if user_cancel is not None and user_cancel():
            raise BatchCanceled()
        # The monitor thread has its own clock and sees the prefill and the vocoder too; reading
        # its verdict is an attribute load, so this can be done every single step.
        if monitor is not None and monitor.tripped:
            raise BatchTooBig(monitor.tripped)
        now = now_fn()

        # A decode step serviced through host memory can take much longer than the pass median. Use that relative
        # slowdown as a paging signal and abort before the next step; latency alone does not identify the cause.
        prev, state["prev"] = state["prev"], now
        if prev is not None:
            dt = now - prev
            if state["baseline"] is None:
                state["samples"].append(dt)
                if len(state["samples"]) >= _BASELINE_STEPS:
                    s = sorted(state["samples"])
                    state["baseline"] = s[len(s) // 2]
            elif dt > max(_PAGING_MIN_STEP_S, state["baseline"] * _PAGING_FACTOR):
                raise BatchTooBig(
                    f"a decode step on {device} took {dt:.2f}s against a median of "
                    f"{state['baseline'] * 1000:.0f}ms for this pass — possible GPU memory pressure")

        if now < state["next"]:
            return False
        # The step timer above measures the decode step, not this hook's own work. The free-memory
        # read below is the driver's answer (NVML) and can be slow; October 10, 2026: if that
        # time were left in, the NEXT interval would include it and a slow driver answer alone
        # would look like memory pressure (and halve a batch). So the step interval restarts when
        # the read returns. The next READ is likewise timed from when this one ended: scheduled
        # before it, a driver answer slower than the half-second interval would have every decode
        # step do a read. Both are stamped even when the read raises, so neither is skewed.
        try:
            low = free_gb(device) < floor_gb
        finally:
            ended = now_fn()
            state["prev"] = ended
            state["next"] = ended + _WATCH_SECONDS
        if low:
            raise BatchTooBig(f"free VRAM fell below {floor_gb} GB on {device}")
        return False

    return check


class _PassMonitor:
    """Monitor free VRAM on a separate thread for the duration of a generation pass.

    The monitor covers prefill and opaque vocoder calls as well as decode. `check()` raises the recorded
    VRAM abort at the next instruction boundary after monitoring ends or an opaque call returns."""

    def __init__(self, device, floor_gb):
        self.device = device
        self.floor_gb = floor_gb
        self.tripped = None                  # the message, once it has fired
        self.worst = float("inf")
        self._stop = threading.Event()
        self._thread = None

    def __enter__(self):
        if str(self.device or "").startswith("cuda"):
            self._thread = threading.Thread(target=self._run, daemon=True,
                                            name=f"vram-monitor-{self.device}")
            self._thread.start()
        return self

    def _run(self):
        while not self._stop.wait(_MONITOR_SECONDS):
            try:
                have = free_gb(self.device)
            except Exception:                # noqa: BLE001 — a monitor must never be the
                continue                     # thing that fails a render
            self.worst = min(self.worst, have)
            if have < self.floor_gb and self.tripped is None:
                self.tripped = (f"free VRAM fell to {have:.2f} GB on {self.device} "
                                f"(floor {self.floor_gb} GB)")
                logger.warning(
                    f"{self.device}: {self.tripped} — this pass is at risk of severe slowdown. "
                    f"Aborting at the first opportunity; if this line is "
                    f"followed by a long silence, the stall is inside S3Gen.inference, which "
                    f"cannot be interrupted.")

    def __exit__(self, *_exc):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        return False

    def check(self):
        """Raise the recorded monitor exception at an instruction boundary.

        Call after opaque operations that do not invoke the per-step watchdog hook."""
        if self.tripped:
            raise BatchTooBig(self.tripped)


def vocode_batched(model, token_rows):
    """Vocode token sequences and return one flattened float32 waveform per input row.

    The function is CUDA-only; callers split rows into memory-bounded passes before invoking it."""
    torch = _torch()
    from chatterbox.models.s3tokenizer import drop_invalid_tokens
    with torch.inference_mode():
        rows = []
        for r in token_rows:
            r = drop_invalid_tokens(r)
            rows.append(r[r < 6561].to(model.device))
        lens = [r.numel() for r in rows]
        lmax = max(lens) if lens else 0
        padded = torch.zeros((len(rows), lmax), dtype=torch.long, device=model.device)
        for i, r in enumerate(rows):
            padded[i, :r.numel()] = r
        lens_t = torch.LongTensor(lens).to(model.device)
        wavs, _ = model.s3gen.inference(speech_tokens=padded, ref_dict=model.conds.gen,
                                        speech_token_lens=lens_t)
        wavs = wavs.detach().cpu().numpy()
        out = []
        for i, n_tok in enumerate(lens):
            w = wavs[i][:n_tok * SAMPLES_PER_TOKEN]
            out.append(model.watermarker.apply_watermark(w, sample_rate=model.sr))
        return out


def vocode_one(model, speech_tokens):
    """The tail of `ChatterboxTTS.generate` for a single sequence — the ROCm path, and the
    fallback whenever S3Gen batching is off."""
    torch = _torch()
    from chatterbox.models.s3tokenizer import drop_invalid_tokens
    with torch.inference_mode():
        st = drop_invalid_tokens(speech_tokens)
        st = st[st < 6561].to(model.device)
        wav, _ = model.s3gen.inference(speech_tokens=st.unsqueeze(0) if st.dim() == 1 else st,
                                       ref_dict=model.conds.gen)
        wav = wav.squeeze(0).detach().cpu().numpy()
        return model.watermarker.apply_watermark(wav, sample_rate=model.sr)


def _is_oom(exc) -> bool:
    torch = _torch()
    oom = getattr(torch.cuda, "OutOfMemoryError", None)
    if oom is not None and isinstance(exc, oom):
        return True
    # ROCm and older torch raise a plain RuntimeError with the text in it.
    return isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower()


def render_batch(model, texts, *, device=None, exaggeration=0.5, cfg=0.5, temperature=0.8,
                 cancel=None):
    """Render input texts in order and return one flattened float32 mono waveform per text.

    The batch uses the configured voice, conditioning values, cancellation hook, and device memory limits.
    No output is returned for a user-canceled batch."""
    out = [None] * len(texts)
    for j, wav in render_batch_iter(model, texts, device=device, exaggeration=exaggeration,
                                    cfg=cfg, temperature=temperature, cancel=cancel):
        out[j] = wav
    return out


def render_batch_iter(model, texts, *, device=None, exaggeration=0.5, cfg=0.5,
                      temperature=0.8, cancel=None, more_available=False, held_out=None):
    """Render input texts in memory-bounded passes, yielding `(input_index, waveform)` as each pass completes.

    Preserve completed rows if a VRAM abort interrupts a pass, retry unfinished rows under a reduced ceiling,
    and hold a short remainder only when `more_available` is true. `held_out` receives held input indices."""
    dev = device or str(getattr(model, "device", "") or "")
    # Track pending row indices explicitly because completed rows returned by an aborted pass may be
    # noncontiguous.
    pending = list(range(len(texts)))
    while pending:
        # Hold a remainder only when the caller confirms more work is available; otherwise render it now so the
        # request cannot remain unfinished.
        if held_out is not None and more_available:
            room = max(1, batch_cap(dev, MAX_BATCH, [texts[j] for j in pending]))
            if len(pending) < room:
                held_out.extend(pending)
                return
        salvaged, group, wavs = [], [], None
        # Sizing and running are ONE critical section per card — see `_pass_lock`. Released
        # before the yields below, which go out over the wire.
        with _pass_lock(dev):
            # `batch_cap` already carries everything this card has taught us: the measured
            # allocator ratio, the walk-up from what has landed, and the ceiling from what has
            # failed. There is no second correction to apply on top of it.
            want = max(1, batch_cap(dev, len(pending), [texts[j] for j in pending]))
            while True:
                group = pending[:want]
                try:
                    wavs = _one_pass(model, [texts[j] for j in group], dev,
                                     exaggeration=exaggeration, cfg=cfg,
                                     temperature=temperature, cancel=cancel)
                    note_batch_ok(dev, len(group))
                    break
                except BatchTooBig as exc:
                    # The watchdog aborts before free VRAM reaches the driver’s paging regime.
                    _drop_cache()
                    # Preserve rows that already completed their stop token and avoid decoding them again after retry.
                    salvaged = [(group[pos], wav) for pos, wav
                                in sorted(_vocode_salvage(model, exc, dev).items())]
                    if not salvaged and want <= 1:
                        raise
                    # Record the failed batch size and reduce the ceiling by one so a later attempt does not immediately
                    # repeat the same failure.
                    ceiling = note_batch_too_big(dev, len(group))
                    if salvaged:
                        logger.warning(
                            f"batch too big for {dev} ({exc}): {len(salvaged)} of {len(group)} "
                            f"row(s) had already finished and are kept — re-sizing on what is "
                            f"left; this card will not attempt more than {ceiling} again "
                            f"until one lands")
                        break
                    want = max(1, want - 1)
                    logger.warning(f"batch too big for {dev} ({exc}): backing off to {want}, "
                                   f"retrying — this card will not attempt more than {ceiling} "
                                   f"again until one lands")
                except Exception as exc:                   # noqa: BLE001 — re-raised below
                    # Kept for Linux and for a box with the sysmem fallback policy switched off,
                    # where CUDA really does refuse. Nothing depends on reaching this.
                    if not _is_oom(exc) or want <= 1:
                        raise
                    _drop_cache()
                    want = max(1, want // 2)
                    logger.warning(f"batch OOM on {dev}: halving to {want} and retrying")
        if salvaged:
            kept = {j for j, _ in salvaged}
            pending = [j for j in pending if j not in kept]
            for j, wav in salvaged:
                yield j, wav
            continue
        for k, j in enumerate(group):
            yield j, wavs[k]
        pending = pending[len(group):]


def _vocode_salvage(model, exc, device) -> dict:
    """Vocode completed token rows carried by a VRAM-aborted pass.

    Return waveforms keyed by their original row positions; do not convert a user cancellation into partial output."""
    rows = getattr(exc, "rows", None) or {}
    if not rows:
        return {}
    _drop_cache()
    out = {}
    for i, tok in sorted(rows.items()):
        try:
            out[i] = np.asarray(vocode_one(model, tok), dtype=np.float32).reshape(-1)
        except Exception:      # noqa: BLE001 — see the docstring: keep what we have, do not raise
            break
    return out


def _drop_cache():
    torch = _torch()
    if hasattr(torch.cuda, "empty_cache"):
        torch.cuda.empty_cache()


def _one_pass(model, texts, device, *, exaggeration, cfg, temperature, cancel):
    """One T3 pass over `texts`, then vocoding — batched or not, per §6."""
    from chatterbox.models.t3.modules.cond_enc import T3Cond
    rows = [text_tokens(model, t) for t in texts]
    conds = model.conds
    t3_cond = conds.t3
    # `exaggeration` rides on the conditioning, exactly as ChatterboxTTS.generate does it.
    if float(exaggeration) != float(t3_cond.emotion_adv[0, 0, 0]):
        t3_cond = T3Cond(speaker_emb=t3_cond.speaker_emb,
                         cond_prompt_speech_tokens=t3_cond.cond_prompt_speech_tokens,
                         emotion_adv=float(exaggeration) * _torch().ones(1, 1, 1)).to(
                             device=model.device)
    # Measure this pass’s incremental reserved-memory high-water mark. Reset the peak before generation and
    # compare reserved memory, which is unavailable to other processes, with the free-memory values used by
    # the capacity model.
    idx = _dev_idx(device)
    _rebase_peak(idx)
    base_reserved = _reserved_gb(idx)
    # Monitor the complete pass, including prefill, decode, and the opaque S3Gen call. A separate thread
    # samples free VRAM while the decode hook cannot observe those phases.
    with _PassMonitor(device, VRAM_FLOOR_GB) as mon:
        # The decode runs behind the VRAM watchdog, not behind an OOM handler. See VRAM_FLOOR_GB.
        tok_rows, _steps = batched_t3(model.t3, t3_cond, rows, cfg_weight=cfg,
                                      temperature=temperature,
                                      cancel=_vram_watchdog(device, VRAM_FLOOR_GB, cancel, mon))
        # Release cached decode allocations before sizing and running the vocoder. The dynamic cache is released
        # to PyTorch’s allocator when decode returns, while capacity checks observe driver-free memory. This
        # cleanup is best-effort; `bound_process_memory` enforces the allocator limit.
        _drop_cache()

        # The vocoder has no per-step callback. Keep it inside the pass monitor so memory pressure during this
        # opaque call is observed and handled at the next instruction boundary.
        wavs = _vocode_rows(model, tok_rows, device)

        # The vocoder has no per-step callback, so this is the first instruction boundary after
        # it at which the thread's verdict can be acted on. Raising here still throws the pass
        # away, but `render_batch_iter` halves and retries rather than handing the next
        # submission to a card that is already paging.
        mon.check()
    # Only completed passes update the cost estimate. Failed or aborted work must not be treated as evidence
    # that the batch size fits.
    peak_reserved = _reserved_gb(idx, peak=True)
    if base_reserved is not None and peak_reserved is not None:
        note_pass_cost(device, len(texts),
                       max((len(str(t)) for t in texts), default=1),
                       max(0.0, peak_reserved - base_reserved))
    return [np.asarray(w, dtype=np.float32).reshape(-1) for w in wavs]


def _vocode_rows(model, tok_rows, device):
    """Vocode all token rows in as many S3Gen passes as available VRAM permits.

    Raise `BatchTooBig` if even one row exceeds the configured token/memory budget. The caller can then retry or route the chunk elsewhere."""
    per = vocoder_slice(device, tok_rows)
    if per < 1:
        # Not "vocode one at a time" — the card has said it cannot hold ONE. Refusing sends this
        # back to `render_batch_iter`, which halves and retries (or, at a batch of one, fails the
        # submission so Vocalis can rerender the chunk somewhere that can hold it). Proceeding is the
        # four-minute PCIe stall this exception exists to prevent.
        raise BatchTooBig(
            f"{device}: {free_gb(device):.2f} GB free cannot vocode one row of "
            f"{max((int(r.numel()) for r in tok_rows), default=0)} speech tokens")
    if len(tok_rows) <= 1 or not s3gen_batching_ok(device):
        return [vocode_one(model, r) for r in tok_rows]
    if per == 1:
        logger.warning(f"{device}: {free_gb(device):.2f} GB free and "
                       f"{max(int(r.numel()) for r in tok_rows)} speech tokens per row — "
                       f"vocoding one at a time instead of batching S3Gen")
        return [vocode_one(model, r) for r in tok_rows]
    out = []
    for k in range(0, len(tok_rows), per):
        group = tok_rows[k:k + per]
        out.extend(vocode_batched(model, group) if len(group) > 1
                   else [vocode_one(model, group[0])])
        # Between sub-passes there IS somewhere to stand and look, unlike inside one.
        _drop_cache()
    return out
