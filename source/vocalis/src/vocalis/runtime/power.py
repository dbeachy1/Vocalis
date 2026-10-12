"""Sample CPU-package and GPU power continuously in this process.

Background sampling keeps the series complete when no browser is open or a tab is not polling.
Read hwmon directly; importing or initializing Torch would create GPU contexts during server
startup. These component readings are a lower bound on wall draw because they omit other system
loads and power-supply losses. History and peak values cover this process lifetime and reset on
restart.

Reject readings outside sensor or hardware limits before updating the peak. RAPL domains require
independent previous readings, and sensors without a published limit still need a broad sanity
ceiling so a malformed value cannot poison the process-lifetime maximum.
"""
import os
import threading
import time
from collections import deque

from loguru import logger

#: Four samples per second capture short CPU bursts while remaining inexpensive. GPU hwmon
#: values may update more slowly, but CPU RAPL energy counters support finer sampling. The header
#: redraws less frequently; extra samples improve rolling means and the peak.
SAMPLE_HZ = 4
SAMPLE_S = 1.0 / SAMPLE_HZ

#: Rolling windows matching load average. Trim history by elapsed time rather than sample count so
#: the retained duration is stable if the sampling rate changes.
WINDOWS_S = (60, 300, 900)

_LOCK = threading.Lock()
_HIST: deque = deque()            # (t_monotonic, watts) — trimmed to WINDOWS_S[-1]
_PARTS: dict = {}                 # the latest sample's components, for the tooltip
#: Peak sample and its CPU/GPU split, so an implausible maximum can be traced to its source.
_PEAK: dict = {"w": None, "t": None, "cpu_w": None, "gpu_w": None}
_STARTED: dict = {"t": None}
#: Previous RAPL counter for this sampler. Keep it separate from the strip's state so each reader
#: computes watts over its own elapsed interval.
_RAPL: dict = {}
_THREAD: list = []                # the sampler, if it is running (a list so `start` is idempotent)
#: How many times the schedule fell a whole tick behind — i.e. how often a sensor read blocked
#: long enough to matter. Zero on a healthy box; the thing to look at if the header ever flickers
#: again. A list so `_loop` can bump it without a `global`.
_STALLS = [0]
#: How many samples were thrown away because a sensor reported something its own hardware says is
#: impossible. Same job as `_STALLS`: the guard below is invisible when it works, and an invisible
#: guard is one nobody can tell was ever needed.
_BOGUS = [0]

_HWMONS: list = []                # amdgpu hwmon dirs, resolved once they exist
_HWMON_SCAN = [0.0]               # monotonic of the last glob — see `_amdgpu_hwmons`
_CAPS: dict = {}                  # hwmon dir -> the board power limit that card publishes, in W

#: How often to look again for a card that was not there last time. The list only ever GROWS.
HWMON_RESCAN_S = 10.0


def _amdgpu_hwmons() -> list:
    """Return the discovered AMD GPU hwmon directories. Rescan periodically until the list stops growing because drivers may publish cards at different times during startup. Include every hwmon card, even if it is outside the runtime's selected device list, so the total is not silently partial."""
    import glob
    now = time.monotonic()
    if _HWMONS and now - _HWMON_SCAN[0] < HWMON_RESCAN_S:
        return _HWMONS
    _HWMON_SCAN[0] = now
    found = []
    for h in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        try:
            if open(os.path.join(h, "name")).read().strip() == "amdgpu":
                found.append(h)
        except OSError:
            continue
    if len(found) > len(_HWMONS):
        _HWMONS[:] = found
    return _HWMONS


#: Board caps are sustained targets, not hard maximums. Allow headroom for documented GPU
#: transients while rejecting values far beyond plausible power. Sensors without a published cap
#: use `ABSURD_W` instead.
CAP_SLACK = 5.0

#: Sanity ceiling in watts for sensors without a published hardware limit. Keep it above plausible
#: CPU package power and GPU transients, but low enough to reject malformed sensor values.
ABSURD_W = 1500.0


def _card_cap_w(h):
    """Return the card's published sustained power limit in watts, or `None` when it publishes no limit.

    Cache a confirmed value or confirmed absence. Retry a transient read failure so one error does not disable the hardware-derived check for the rest of the process."""
    if h in _CAPS:
        return _CAPS[h]
    cap, absent = None, True
    for n in ("power1_cap_max", "power1_cap"):
        try:
            cap = int(open(os.path.join(h, n)).read().strip()) / 1e6          # µW → W
            break
        except FileNotFoundError:
            continue                          # this part genuinely does not publish that file
        except (OSError, ValueError):
            absent = False                    # it IS there and did not read — ask again later
            continue
    if cap is not None or absent:
        _CAPS[h] = cap
    return cap


def _gpu_w():
    """Return total GPU watts and an error description when a reading is implausible.

    Use the card's average or instantaneous reading, whichever is available. Skip cards with no readable sensor rather than counting them as zero. A published board cap is a sustained target and needs generous slack for real transients; cards without a cap use `ABSURD_W`. Discard the whole sample when a reading exceeds its bound so an invalid value cannot poison the process-lifetime peak."""
    total, seen = 0.0, False
    for h in _amdgpu_hwmons():
        for n in ("power1_average", "power1_input"):
            try:
                w = int(open(os.path.join(h, n)).read().strip()) / 1e6        # µW → W
            except (OSError, ValueError):
                continue
            cap = _card_cap_w(h)
            if cap is not None:
                if w > cap * CAP_SLACK:
                    return None, (f"{os.path.basename(h)}/{n} reported {round(w)} W, past the "
                                  f"{round(cap)} W board limit that card publishes for itself")
            elif w > ABSURD_W:
                return None, (f"{os.path.basename(h)}/{n} reported {round(w)} W and publishes no "
                              f"board limit of its own to check that against, so the "
                              f"{round(ABSURD_W)} W absurdity ceiling applies")
            total += w
            seen = True
            break
    return (total if seen else None), None


def _cpu_w():
    """Return CPU package watts and an error description when a reading is implausible.

    RAPL does not publish a package power limit, so use `ABSURD_W` as a sanity ceiling. The RAPL reader keeps independent previous-read state for this sampler."""
    from tts_utils import _cpu_power_w
    w = _cpu_power_w(state=_RAPL)
    if w is not None and w > ABSURD_W:
        return None, (f"the CPU package reported {round(w)} W from RAPL, past the "
                      f"{round(ABSURD_W)} W ceiling for a part that publishes no limit "
                      f"of its own — no x86 package draws this")
    return w, None


def sample_once():
    """Take one reading and fold it into the series. Returns recorded watts, or `None`.

    Drop the first RAPL sample because it has no previous energy counter. Discard the whole sample when any sensor reports an implausible value; a partial total would look valid while omitting a component."""
    cpu, cpu_liar = _cpu_w()
    gpu, gpu_liar = _gpu_w()
    liar = cpu_liar or gpu_liar
    if liar is not None:
        _BOGUS[0] += 1
        if _BOGUS[0] == 1 or _BOGUS[0] % 100 == 0:
            logger.warning(f"power sampler: {liar} — sample discarded (bogus read #{_BOGUS[0]})")
        return None
    if cpu is None and _RAPL:
        # RAPL is readable but had nothing to say this time: the priming read, or a counter
        # that wrapped. Either way the CPU's share is unknown for this second — skip it.
        # Truthiness of the dict, not one fixed key: `_cpu_power_w` keys its previous read by
        # DOMAIN PATH, and a box with any RAPL at all has more than one domain.
        return None
    if cpu is None and gpu is None:
        return None
    w = (cpu or 0.0) + (gpu or 0.0)
    now = time.monotonic()
    with _LOCK:
        _HIST.append((now, w))
        cutoff = now - WINDOWS_S[-1]
        while _HIST and _HIST[0][0] < cutoff:
            _HIST.popleft()
        _PARTS.update(cpu_w=cpu, gpu_w=gpu, gpus=len(_HWMONS))
        if _PEAK["w"] is None or w > _PEAK["w"]:
            _PEAK.update(w=w, t=now, cpu_w=cpu, gpu_w=gpu)
        if _STARTED["t"] is None:
            _STARTED["t"] = now
    return w


def snapshot():
    """What the header prints, or None on a box that can report nothing (every Windows one).

    None rather than a dict of nulls: the UI hides the whole line on a falsy block, the same way
    it hides the swap line where there is no swap, and a row of dashes in the header of a dev box
    forever would be worse than no row.

    `span_s` is the honest width of the averages — the age of the oldest sample still held. Until
    the sampler has been up fifteen minutes the third figure covers less than it claims to, and
    the tooltip says how much rather than the number pretending."""
    with _LOCK:
        if not _HIST:
            return None
        now = time.monotonic()
        sums = [0.0] * len(WINDOWS_S)
        counts = [0] * len(WINDOWS_S)
        # One pass, newest first: a sample inside the 1-minute window is inside all three, so the
        # walk can stop the moment it falls out of the widest one.
        for t, w in reversed(_HIST):
            age = now - t
            if age > WINDOWS_S[-1]:
                break
            for i, win in enumerate(WINDOWS_S):
                if age <= win:
                    sums[i] += w
                    counts[i] += 1
        avg = [round(sums[i] / counts[i]) if counts[i] else None
               for i in range(len(WINDOWS_S))]
        return {"w": round(_HIST[-1][1]),
                # The split, for the tooltip: a total is not readable without knowing what is
                # in it, and on a box where RAPL is locked down `cpu_w` is None and the figure
                # is the cards alone.
                "cpu_w": None if _PARTS.get("cpu_w") is None else round(_PARTS["cpu_w"]),
                "gpu_w": None if _PARTS.get("gpu_w") is None else round(_PARTS["gpu_w"]),
                "gpus": _PARTS.get("gpus") or 0,
                "avg": avg,
                "span_s": round(now - _HIST[0][0]),
                "peak_w": None if _PEAK["w"] is None else round(_PEAK["w"]),
                "peak_ago_s": None if _PEAK["t"] is None else round(now - _PEAK["t"]),
                # The peak's OWN split, not the latest sample's. The peak outlives every other
                # figure here by design, so it is the one that has to carry its provenance with
                # it — a bare maximum is exactly what made the 2,550 W reading unattributable.
                "peak_cpu_w": None if _PEAK["cpu_w"] is None else round(_PEAK["cpu_w"]),
                "peak_gpu_w": None if _PEAK["gpu_w"] is None else round(_PEAK["gpu_w"]),
                "since_s": round(now - _STARTED["t"]) if _STARTED["t"] is not None else 0,
                "n": len(_HIST)}


def _linuxish() -> bool:
    """Is there a /sys to read at all? The one condition that stops the sampler starting — see
    `start`. A separate function so the suite can drive the thread on a box that has none."""
    return os.path.isdir("/sys/class")


#: Set to stop the sampler. It exists for the suite — a daemon thread left running past the test
#: that started it would go on reading the REAL host's sensors under every test after it, at
#: whatever interval that test chose. In production nothing ever sets it.
_STOP = threading.Event()


def _loop(interval):
    """Sample on a fixed schedule without drift or catch-up bursts.

    If a sensor read blocks long enough to miss a full tick, resynchronize and drop missed samples. Repaying missed ticks back-to-back would overweight one moment in the rolling means. Catch exceptions so one unreadable sensor does not stop the sampler."""
    nxt = time.monotonic()
    announced = False
    while not _STOP.is_set():
        try:
            w = sample_once()
            # Log the first successful sample so the server log distinguishes a working sampler
            # from a header value that is correctly omitted due to unavailable sensors.
            if w is not None and not announced:
                announced = True
                logger.info(f"power sampler: first sample {round(w)} W "
                            f"(CPU {_PARTS.get('cpu_w')} + {_PARTS.get('gpus')} GPUs "
                            f"{None if _PARTS.get('gpu_w') is None else round(_PARTS['gpu_w'])})")
        except Exception:                                      # noqa: BLE001
            pass
        nxt += interval
        now = time.monotonic()
        if nxt < now - interval:      # a stalled read (or a swapping box) ate whole ticks: drop
            # Count and log stalls so the resynchronization behavior can be distinguished from
            # other causes of gaps in the sampled series.
            _STALLS[0] += 1
            if _STALLS[0] == 1 or _STALLS[0] % 100 == 0:
                logger.info(f"power sampler: sensor read stalled {now - nxt + interval:.2f}s past "
                            f"its slot, ticks dropped (stall #{_STALLS[0]})")
            nxt = now + interval      # `now + interval`, NOT `now` — resyncing to `now` leaves a
                                      # zero wait, i.e. one more immediate sample, which is the
                                      # burst again at length one. (The test caught that.)
        # `wait`, not `sleep`: a stop must not have to sit through the rest of an interval.
        _STOP.wait(max(0.0, nxt - now))


def start(interval=SAMPLE_S):
    """Start the sampler once. Returns its thread, or `None` when the platform has no sysfs sensor interface.

    Start from `main()`, not `create_app()`, so constructing test apps does not start host-sensor threads. A temporarily unreadable sensor does not prevent startup; later samples can succeed after permissions or driver state change."""
    if not _linuxish():
        return None
    with _LOCK:
        if _THREAD:
            return _THREAD[0]
        _STOP.clear()
        t = threading.Thread(target=_loop, args=(interval,), daemon=True, name="power-sampler")
        _THREAD.append(t)
    t.start()
    return t


def stop(timeout=2.0):
    """Stop the sampler and forget it. For the suite; production never calls it."""
    _STOP.set()
    with _LOCK:
        threads, _THREAD[:] = list(_THREAD), []
    for t in threads:
        t.join(timeout=timeout)
