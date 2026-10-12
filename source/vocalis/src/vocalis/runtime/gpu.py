"""`GpuGate` — who owns the cards.

Moved out of `vocalis_server.py` in 5.1-P3. Eight feature domains acquire this object: books,
playground, voice design, enhance, bulk, train, settings and the model-load routes. It is the
arbitration point between render-class work (which takes every card) and enhancement-class work
(which takes exactly one), so it can never belong to any one feature — which is precisely why it
sat in the server module with no better home.

It depends on nothing but `threading` and `time`, and never did. Nothing had to be untangled to
move it; it was only ever here because there was nowhere else.
"""
import threading
import time


class GpuGate:
    """Who owns the cards.

    A RENDER owns every card: get_pool puts a replica on each one and run_chunks dispatches
    to all of them for the whole job, so two renders at once would drive get_pool into
    rebuilding the pool (2x VRAM) underneath a job that is mid-generation. Renders are
    therefore exclusive — of each other, and of everything else here. (Nomi is a separate
    server with its own request-level replica pool.)

    A background ENHANCEMENT owns exactly ONE card: run_enhance pins its child process to
    it with _card_env, and wants ~21 GB of it — which is why it can't share a card with a
    render, but CAN run beside another enhancement on a different card.

    That difference is the whole point of this class. Until 4.1-M16 both went through one
    global lock, so the second enhancement on a two-card box was refused while a card sat
    idle — and refused with "the GPUs are busy with a render" when the only thing running
    was the first enhancement. voicetrain hit the same wall and made the same fix, one
    level down: it replaced its global TRAIN_LOCK with one lock per card.

    A render WAITING for the cards also stands new enhancements down. Without that, a
    trickle of 16-minute enhancements could keep an interactive render queued indefinitely.
    An enhancement is a background tidy-up; it yields to the thing the user is watching.
    """

    def __init__(self):
        self._cv = threading.Condition()
        self._render = False          # a render holds every card
        self._waiting = 0             # renders queued for them
        self._cards = set()           # cards claimed by running enhancements
        # 9.0-m4 — THE THIRD CLASS: work this process DISPATCHES that EXECUTES ELSEWHERE.
        # ComfyUI is a separate process, so its VRAM is invisible to everything above. A
        # generation run holds real memory on a real card and this class could not see it.
        # 🔴 IT LIVES HERE RATHER THAN IN A LOCK BESIDE THIS ONE. A lock the arbiter cannot
        # see IS the bug; a second one does not fix it, it just moves where the collision
        # happens. `{device: label}` so the strip can say WHAT is holding the card.
        self._external = {}

    # ── renders ──
    # Same acquire()/release() signature the single GPUS had, so the cancel-aware
    # `while not acquire(timeout=0.5)` loops in run_job and the playground job are unchanged
    # — except that they now also wait out any running enhancement, which they must: a
    # render needs the card the enhancer is holding 21 GB of.
    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        end = None if (timeout is None or timeout < 0) else time.monotonic() + timeout
        with self._cv:
            self._waiting += 1                  # visible to claim_card the moment we queue
            try:
                # `self._external` is in this condition for the same reason `self._cards`
                # is: a render puts a replica on EVERY card, so it cannot start while another
                # process holds one. Leaving it out would let a render rebuild the pool into
                # VRAM that ComfyUI is already using — which OOMs the render, the generation,
                # or both, and reads as an unrelated CUDA failure.
                while self._render or self._cards or self._external:
                    if not blocking:
                        return False
                    left = None if end is None else end - time.monotonic()
                    if left is not None and left <= 0:
                        return False
                    self._cv.wait(left)
                self._render = True
                return True
            finally:
                self._waiting -= 1

    def release(self) -> None:
        with self._cv:
            self._render = False
            self._cv.notify_all()

    # ── background enhancements ──
    def claim_card(self, cards: list, busy=None) -> tuple:
        """Take one card for an enhancement. `cards` is the candidate list IN PREFERENCE
        ORDER; `busy(device)` reports a card held by something we don't track (a training).

        Returns (device, reason). device is None when it can't have one, and `reason` is
        why — 'render', 'render_waiting' or 'cards' — because those are three different
        things to tell the user and the old lock could only say the first one.

        The claim is what closes the double-book window: a card is spoken for HERE, in the
        request, not when the job thread finally reaches _enhance_one a few milliseconds
        later. Two E clicks in the same instant would otherwise both see the same idle card.
        """
        with self._cv:
            if self._render:
                return None, "render"
            if self._waiting:
                return None, "render_waiting"
            for d in cards:
                # `_external` joins `_cards` here: an enhancement wants ~21 GB of one card,
                # and a card a ComfyUI generation is mid-run on does not have it spare.
                if d not in self._cards and d not in self._external and not (busy and busy(d)):
                    self._cards.add(d)
                    return d, ""
            return None, "cards"

    def release_card(self, device: str) -> None:
        with self._cv:
            self._cards.discard(device)
            self._cv.notify_all()

    # ── dispatched work, running in another process (9.0-m4) ──
    def claim_external(self, device: str, label: str) -> bool:
        """Hold `device` on behalf of a job this process dispatched but does not run.

        Returns False when the card is already spoken for — by a render, by an enhancement, or
        by another external run. The caller queues rather than proceeding; two generations on
        one card is the double-book this exists to prevent.

        ⚠️ **A render in flight or QUEUED refuses this**, matching `claim_card`. A render is
        the thing the user is watching a spinner for; a dataset generation is a background job
        that can wait its turn, and letting it jump the queue is the mistake `claim_card`
        already refuses to make.
        """
        with self._cv:
            if self._render or self._waiting:
                return False
            if device in self._cards or device in self._external:
                return False
            self._external[device] = label or "external"
            return True

    def release_external(self, device: str, label: str | None = None) -> bool:
        """Give the card back. 🔴 MUST run on cancel and on failure, not only on success —
        a lease leaked by a crashed run makes the card look permanently busy to every other
        class here, and nothing would ever reclaim it.

        🔴 **PASS THE LABEL YOU CLAIMED WITH, AND THIS BECOMES OWNER-CHECKED.** Four of the five
        claim sites discarded `claim_external`'s bool and proceeded anyway; each then released on
        the way out, popping the lease of whichever run actually held the card. The observable
        damage is not the bookkeeping — it is that `/comfyui/stop`'s guard reads `external()` and
        then sees an idle box, so a click kills a live generation mid-run, and `GpuGate.acquire()`
        stops blocking and rebuilds a pool into VRAM ComfyUI still holds. The caller must verify
        the claim result and release with the same label.

        ⚠️ **THE OWNER CHECK IS THE FLOOR, NOT THE FIX.** A caller that ignores the claim result
        is still wrong — it double-books the card with real work. This only stops that mistake
        from also corrupting the lease table for everyone else.

        📌 Returns True when a lease was actually given back, False when there was nothing to give
        back or it belonged to someone else. It reports rather than logs on purpose: this module's
        docstring states it depends on nothing but `threading` and `time`, and a guard is not worth
        making that false. The callers that care log it themselves.
        """
        with self._cv:
            held = self._external.get(device)
            if held is None:
                return False
            if label is not None and held != label:
                return False
            self._external.pop(device, None)
            self._cv.notify_all()
            return True

    def external(self) -> dict:
        """`{device: label}` for the hardware strip. Read-only; claims nothing."""
        with self._cv:
            return dict(self._external)

    def enhancing(self) -> int:
        with self._cv:
            return len(self._cards)

    def render_active(self) -> bool:
        """Is anything render-class holding, or queued for, the cards? Read-only —
        it claims nothing and blocks nobody.

        5.2's pre-render gate asks this: speculative narration may only start when
        the box has nothing real to do. `_waiting` counts, deliberately — a render
        that is queued for the cards is a render the user is already watching a
        spinner for, and letting a guess jump in front of it is the same mistake
        `claim_card` refuses to make one method up."""
        with self._cv:
            # 9.0-m4: external work counts. 5.2's pre-render gate asks this before starting
            # speculative narration, and 'the box has nothing real to do' is false while a
            # LoRA generation is running on a card, even though it is another process doing it.
            return bool(self._render or self._waiting or self._external)

    # `with GPUS:` — the render sense, uninterruptible. Only for the short, unqueueable
    # holders (the preload); a job that a user can cancel uses the acquire loop instead.
    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_exc):
        self.release()


GPUS = GpuGate()

# ── Device registry / VRAM telemetry ──────────────────────────────────────────
#
# 5.1-P3.2. Unlike the gate above, these names ARE rebound by tests -- gpu_stats 9x,
# _cards_emptiest_first 4x, gpu_registry 2x, _card_training 1x. So vocalis_server calls
# them through the MODULE (gpu.gpu_stats()) rather than binding its own names, and the
# tests patch them here. One patch target, no pair of names that can drift apart.

import torch


# The header's power line. Imported for `strip_sample` alone — this module reads no sensor of
# its own from it, and `power` deliberately imports no torch (see its own 🔴 note on cold start).
from vocalis.runtime import power
# The header's UPS line — wall draw, from the meter the box is plugged into rather than from
# any sensor inside it. Same deal as `power`: imported for `strip_sample` and nothing else.
from vocalis.runtime import ups
# The board and VRM temperatures. Same deal again — and unlike the two above it holds no state
# at all, so there is nothing to start and nothing that can go stale.
from vocalis.runtime import temps
# Remote GPU statistics share the strip; the sampler owns network polling so request handlers
# never perform a network call.
from vocalis.runtime import satstats


def gpu_registry() -> list:
    return [{"index": i, "name": torch.cuda.get_device_name(i)}
            for i in range(torch.cuda.device_count())]


def gpu_stats() -> list:
    """Per-card memory and utilization for the UI strip.

    `used_gb` is whole-card usage. `vocalis_gb` uses DRM process accounting for Vocalis and
    its workers, falling back to PyTorch accounting where DRM data is unavailable. Whole-card
    and process samples can race, so clamp the process value to the total usage.
    """
    from tts_utils import (vram_used_total, proc_vram_bytes, gpu_util_percent,
                           gpu_temp_c, gpu_power_w, gpu_clocks_mhz, gpu_fan_pct)
    out = []
    for i in range(torch.cuda.device_count()):
        # October 10, 2026: the clocks are read first on purpose. On an NVIDIA card that is the
        # full NVML pass (memory and every sensor); `vram_used_total` and the sensors below then
        # reuse it, so a card costs one pass per poll rather than a memory read plus a pass.
        sclk, mclk = gpu_clocks_mhz(i)
        used, total = vram_used_total(i)
        voc = proc_vram_bytes(i)
        if voc is None:
            voc = torch.cuda.memory_reserved(i)
        # The whole-card sensor and the fdinfo read are separate syscalls a beat apart, so
        # an allocation landing between them could put Vocalis's share above the whole-card
        # figure and drive `other` negative. The UI clamps, but the API must not emit an
        # incoherent pair — /gpus/stats asserts used_gb >= vocalis_gb.
        voc = min(voc, used)
        # Every sensor is None where it doesn't exist (non-AMD / non-Linux — the
        # Windows dev box) and the UI omits that field rather than showing a blank.
        out.append({"index": i, "name": torch.cuda.get_device_name(i),
                    "total_gb":   round(total / 2**30, 1),
                    "free_gb":    round((total - used) / 2**30, 1),
                    "used_gb":    round(used / 2**30, 1),
                    "vocalis_gb": round(voc / 2**30, 1),
                    "util_pct":   gpu_util_percent(i),
                    "temp_c":     gpu_temp_c(i),
                    "power_w":    gpu_power_w(i),
                    "sclk_mhz":   sclk,                    # core clock (0 = clock-gated, i.e. idle)
                    "mclk_mhz":   mclk,                    # VRAM clock
                    # 10.21 — fan duty cycle in percent, right after mclk (hwstrip.js's slot
                    # order follows this). None where the sensor doesn't exist, same as every
                    # other field here.
                    "fan_pct":    gpu_fan_pct(i)})
    return out


_STRIP_LOCK = threading.Lock()
_STRIP: dict = {"t": 0.0, "v": None}
_STRIP_TTL = 0.12          # s — under the UI's 250 ms sample, so every sample it takes is fresh


def strip_sample() -> dict:
    """Return one shared hardware sample for GPU cards and CPU metrics.

    CPU load and power are deltas between reads. Sharing one short-lived sample across
    browser and job-event readers preserves the measurement interval and avoids duplicate
    sensor reads.

    ⚠️ `power` and `ups` are the TWO parts of this that are not read here. Both come off
    background samplers (runtime/power.py at 4 Hz, runtime/ups.py at 0.2 Hz) rather than being
    sampled per request — power because its averages and its peak have to cover the stretches
    when nobody is looking, which is when the box does most of its work, and UPS because
    reading it forks `upsc` and this function runs on every poll of every open tab. This just
    hands over whatever each last saw. `power` is None where nothing on the box can report
    watts; `ups` is None on any box without a UPS feeding it, which is most of them.

    ⚠️ `temps` IS read here, and that is not an inconsistency with the two above — it is the
    absence of the reason they are not. Neither a series nor a subprocess: two sysfs reads with
    no peak and no mean to accumulate, on a sensor whose subject is a lump of PCB. The 0.12 s
    hold above is already tighter than anything a board temperature does. `temps.py`'s closing
    note has the whole argument.

    🔴 10.21 — `satstats.watch()` IS CALLED UNCONDITIONALLY, EVEN ON A CACHE HIT. "Watched"
    means "something just read the strip", not "the strip was just recomputed" — a tab sitting
    behind this function's 0.12 s TTL is still a reader, and `satstats`'s per-satellite threads
    decide whether to poll their satellite at all off exactly that signal (§6.1 of
    DESIGN_10_21_FAN_AND_SATELLITE_STRIP.md: no polls when nobody has read the strip in the
    last 2 s). `satstats.snapshot()` itself never touches the network — it only hands back the
    last GOOD reading each background thread already took — so this function keeps its own
    "never a network call" rule intact."""
    from tts_utils import cpu_stats
    satstats.watch()
    with _STRIP_LOCK:
        now = time.monotonic()
        if _STRIP["v"] is None or now - _STRIP["t"] >= _STRIP_TTL:
            _STRIP.update(t=now, v={"gpus": gpu_stats(), "cpu": cpu_stats(),
                                    "power": power.snapshot(), "ups": ups.snapshot(),
                                    "temps": temps.snapshot(),
                                    # Always a list, possibly empty, never omitted — the UI's
                                    # strip signature keys off this field's presence rather
                                    # than a None check.
                                    "satellites": satstats.snapshot()})
        return _STRIP["v"]


def card_index(device) -> int:
    return int(str(device).split(":")[1])


def cards_emptiest_first(devices: list) -> list:
    """`devices` in the order a new GPU job should prefer them: most free VRAM first, via
    the whole-card sensor (so it sees co-tenants — a training, ACE-Step, ComfyUI — and not
    just what torch reserved). Near-ties (within 0.5 GB) go to the HIGHEST-numbered card:
    card 0 is what everything else on the box grabs by default, so leave it free within
    reason (same convention as training's default-highest-card)."""
    free = {g["index"]: (g.get("free_gb") or 0) for g in gpu_stats()}
    rest, out = list(devices), []
    while rest:
        best = max(free.get(card_index(d), 0.0) for d in rest)
        tied = [d for d in rest if free.get(card_index(d), 0.0) >= best - 0.5]
        pick = max(tied, key=card_index)
        out.append(pick)
        rest.remove(pick)
    return out


def pick_device(candidates: list) -> str:
    """Return the emptiest authorized candidate, or `"cpu"` when none are supplied.

    Callers pass the current Settings-authorized devices. This selects a device but does not
    claim it; workloads with concurrent consumers must use the GPU gate. An empty list means
    no candidate was authorized, which callers must distinguish from missing hardware.
    """
    if not candidates:
        return "cpu"
    return cards_emptiest_first(list(candidates))[0]


# Reasons an enhancement cannot acquire a card: render activity, queued render work, or other
# card consumers.

# ── What the OTHER tenants are holding ────────────────────────────────────────
# Shared memory aggregates stay here because both ComfyUI controls and model-loading routes use
# the GPU accounting, without requiring model routes to import service-control code.

def used_ram_gb():
    """System RAM in use (GiB), or None where it can't be read — the before/after
    instrument for what stopping ComfyUI hands back. 4.8-m4f: this is the number the
    stop is actually shopping for — an image-training run wants ~60 GB of system RAM,
    and ComfyUI is the biggest thing on the box holding any.

    `_cpu_mem` rather than the public `cpu_stats()` on purpose: cpu_stats() also samples
    /proc/stat, and that sample is a DELTA against the last one — reading it here would
    shorten the strip's next 1 Hz interval and dent the CPU% it draws. This needs one
    number and must not disturb the instrument next to it."""
    from tts_utils import _cpu_mem
    mem = _cpu_mem()
    return mem[0] if mem else None


def other_vram_gb():
    """Estimated non-Vocalis VRAM: whole-card usage minus this process's device usage.

    This is an upper bound on memory a ComfyUI restart may free because process accounting
    can undercount backend allocations. Returns zero when no devices are available.
    """
    try:
        return sum(max(0.0, g["used_gb"] - g["vocalis_gb"]) for g in gpu_stats())
    except Exception:                        # noqa: BLE001
        return 0.0


def used_vram_gb_total():
    """Whole-card `used_gb` summed across cards, or None if unmeasurable — the
    before/after instrument for the restart's measured freed-GB report."""
    try:
        return sum(g["used_gb"] for g in gpu_stats())
    except Exception:                        # noqa: BLE001
        return None

# ── Shared with more than one blueprint (5.1-P4.10a) ─────────────────────────

def cuda_count(devices) -> int:
    return len([d for d in devices if str(d).startswith("cuda")])
