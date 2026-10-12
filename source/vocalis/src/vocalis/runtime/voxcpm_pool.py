"""Manage resident VoxCPM2 worker processes, one per local device.

Each `voxcpm.Worker` runs in a separate environment and loads independently of Chatterbox.
Generation claims the device through `GPUS`; an idle worker holds model memory but does not own
an active GPU claim. The pool reaps idle workers because their persistent HIP contexts consume
CPU resources.
"""
import threading
import time

from loguru import logger

import voxcpm

from vocalis.runtime import configs
from vocalis.runtime import gpu
from vocalis.runtime import pool as chatterbox_pool
from vocalis.runtime import subsystems

REAP_TICK = 60.0             # how often to look; the timeout itself is voxcpm.idle_s


def usable_cards() -> list:
    """Every card VoxCPM2 may use, emptiest-first: the ⚙ Settings GPU selection, minus any a
    training holds (skipped, never fought over). A card here has no worker yet —
    `VoxcpmPool.ready_devices()` is the subset that does.

    A module function rather than a method: it asks what the SETTINGS and the GPUs allow, and
    the answer does not depend on what this pool currently holds.

    7.6: the selection is now per-subsystem, and this asks for `VOICECREATE` — the indented
    **Voices → Create a voice** tick — rather than the render pool's. Designing a voice is the
    one thing VoxCPM2 does, and it is a different claim on a card from a book render: a
    This separates the device permission for voice design from the render pool's permission.
    """
    return [d for d in gpu.cards_emptiest_first(
                chatterbox_pool.local_cuda_devices(subsystems.VOICECREATE))
            ]


class VoxcpmPool:
    """Owns the resident workers, their lock, and the in-flight-load count.

    Every method that touches `_workers` takes `_lock` itself, so no caller has to know the
    lock exists. That is the entire point of the wrap: the four consumers that used to open
    `with _vox_lock:` around their own dict access can no longer get it wrong, and there is one
    place to look when the next concurrency question comes up.
    """

    def __init__(self):
        self._workers = {}          # device -> voxcpm.Worker (0, 1, or 2 entries)
        self._lock = threading.Lock()
        # Count concurrent loads so one completion cannot clear the loading state while another
        # load is still running.
        self._loading_n = 0

    # ── what is loaded ───────────────────────────────────────────────────────

    def ready(self) -> bool:
        """At least one worker is up and serving."""
        with self._lock:
            return any(w.ready for w in self._workers.values())

    def ready_devices(self) -> list:
        """The cards with a ready worker, emptiest-first (the order a generation prefers)."""
        with self._lock:
            ready = [d for d, w in self._workers.items() if w.ready]
        return gpu.cards_emptiest_first(ready) if ready else []

    def ready_devices_sorted(self) -> list:
        """The same set, in plain name order — what /health reports, where a stable answer
        matters more than which card is emptiest this second."""
        with self._lock:
            return sorted(d for d, w in self._workers.items() if w.ready)

    def worker(self, device):
        """The Worker on `device`, or None. The caller may then act on it OUTSIDE the lock —
        `stop()` takes seconds, and holding the pool lock across it would stall /health."""
        with self._lock:
            return self._workers.get(device)

    def cold(self, devices) -> list:
        """Of `devices`, the ones with no worker at all."""
        with self._lock:
            return [d for d in devices if d not in self._workers]

    def own_pids(self) -> set:
        """The pids of the worker child processes. The foreign-engine scan subtracts these so
        it never counts our own children as somebody else's engine — injected rather than
        imported, so `runtime/procs.py` does not have to know this class exists."""
        pids = set()
        with self._lock:
            for w in self._workers.values():
                proc = getattr(w, "proc", None)
                if proc is not None and proc.pid:
                    pids.add(proc.pid)
        return pids

    def drop(self, device, w) -> bool:
        """Remove `device` iff it still holds exactly `w`. Returns whether it did.

        The identity check is load-bearing: between reading a worker and deciding it is dead,
        the reaper or another loader may have replaced it, and popping by key alone would
        evict the healthy replacement.
        """
        with self._lock:
            if self._workers.get(device) is w:
                self._workers.pop(device, None)
                return True
        return False

    # ── the in-flight-load count ─────────────────────────────────────────────

    def loading(self) -> bool:
        """True while ANY load is in flight. Read by /health and by /model/load's guard."""
        with self._lock:
            return self._loading_n > 0

    def loading_begin(self) -> None:
        with self._lock:
            self._loading_n += 1

    def loading_end(self) -> None:
        with self._lock:
            self._loading_n = max(0, self._loading_n - 1)

    def claim_load(self, cards) -> list:
        """Take the loading ticket if `cards` has anything missing and nothing is already
        loading. Returns the devices to load, or [] to leave it alone.

        Read the pool, compute missing devices, and take the load ticket under one lock so
        concurrent requests cannot schedule duplicate workers. Claim the ticket before starting
        the background thread to close the scheduling window before its first instruction.
        """
        with self._lock:
            missing = [d for d in cards if d not in self._workers]
            if not missing or self._loading_n > 0:
                return []
            self._loading_n += 1
            return missing

    # ── lifecycle ────────────────────────────────────────────────────────────

    def ensure(self, devices, on_log=None, owns_ticket: bool = True) -> list:
        """Load a worker on each of `devices` that doesn't already have one, and return the
        devices that ended up with a ready worker. SYNCHRONOUS — `load_bg` is the
        fire-and-forget wrapper; a design job calls this one directly so it can narrate the
        load into its own log (a reaped engine costs ~11 s and the user must see why).

        Per-card failure logs and is skipped — one card's OOM must not sink the other's
        worker; the caller then sees how many came up.

        `owns_ticket=False` says the CALLER already counted this load. `load_bg` passes it
        because the route that started the thread took the ticket, and counting the same load
        twice would leak the count and leave /health saying "loading" forever.
        """
        if owns_ticket:
            self.loading_begin()
        try:
            for device in devices:
                with self._lock:
                    if device in self._workers:   # already loaded (a re-load, or a race)
                        continue
                if on_log:
                    on_log(f"starting VoxCPM2 on {device}…")
                try:
                    w = voxcpm.Worker(configs.voxcpm_cfg(), device)
                    w.start()
                    w.wait_ready()
                except Exception as exc:                           # noqa: BLE001
                    logger.exception(f"voxcpm load failed on {device}: {exc}")
                    if on_log:
                        on_log(f"VoxCPM2 failed to start on {device}: {exc}")
                    continue
                with self._lock:
                    if device in self._workers:   # lost a race — never hold two on one card
                        w.stop()
                    else:
                        self._workers[device] = w
                        logger.info(f"voxcpm: ready on {device} (sr={w.sample_rate})")
        finally:
            if owns_ticket:
                self.loading_end()
        with self._lock:
            return [d for d in devices
                    if d in self._workers and self._workers[d].ready]

    def load_bg(self, devices) -> None:
        """Load in the background; the UI polls /health. The thread target for every path that
        kicks a load without waiting on it (/model/load, the post-cancel self-heal).

        The request claims the ticket in `claim_load`; this wrapper releases it after loading."""
        try:
            self.ensure(devices, owns_ticket=False)
        finally:
            self.loading_end()

    def stop(self) -> None:
        """Unload every worker. The dict is emptied under the lock and the children are killed
        outside it, because stop() takes seconds per worker."""
        with self._lock:
            workers, self._workers = list(self._workers.values()), {}
        for w in workers:
            w.stop()

    def reap_once(self, idle_s: float) -> list:
        """One reaper pass. Returns the devices it unloaded.

        Retire → drop → stop, in that order. `retire_if_idle()` marks the worker under its own
        lock so every later `reserve()` fails; then it leaves the pool; and only then do we pay
        `stop()`'s few seconds, with nothing able to be holding it by that point."""
        with self._lock:
            resident = list(self._workers.items())
        reaped = []
        for device, w in resident:
            if not w.retire_if_idle(idle_s):
                continue
            idle_for = w.idle_s
            self.drop(device, w)
            w.stop()
            reaped.append(device)
            logger.info(f"voxcpm: reaped the worker on {device} after "
                        f"{idle_for / 60:.1f} min idle — a core and its VRAM back")
        return reaped

    def reaper(self) -> None:
        """Unload workers nobody has used for cfg.idle_s. Vocalis's FIRST idle-unload, and it
        exists because on this ROCm stack an idle worker pins a whole CPU core for as long as
        it lives (the measurements are in voxcpm.IDLE_S_DEFAULT).

        Reaping is invisible to the user — the next Generate reloads on demand."""
        while True:
            time.sleep(REAP_TICK)
            try:
                self.reap_once(configs.voxcpm_cfg().idle_s)
            except Exception as exc:                               # noqa: BLE001
                logger.warning(f"voxcpm reaper: {exc}")   # never let the loop die


# The process-wide instance. Re-exported into `vocalis_server` as VOX rather than accessed as
# voxcpm_pool.VOX because no test rebinds either name — what matters is the object identity,
# and a second name for the same pool is exactly as correct. Same call the GPUS gate made.
VOX = VoxcpmPool()
