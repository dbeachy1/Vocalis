"""Persist state for a server-side batch of candidate voice generations.

The browser observes and controls the run, while the server owns its progress so it survives page
reloads. `src/swap_queue.py` uses the same separation between arranging work, starting it, and
persisting state.

`src/swap_queue.py` is the same problem already solved and this module copies its two rules
rather than re-deciding them:

  1. **Arranging a run and starting it are different operations.** A batch of 100 that starts
     the instant a number is typed is a batch you cannot arrange before committing the GPUs.
  2. `running` is never persisted as true. An interrupted batch loads stopped with its progress
     intact, and requires an explicit start to continue.

WHAT THIS MODULE IS NOT
-----------------------
It holds no threads, no GPU, and no Flask. It is the state and the persistence, and nothing
else — the runner lives in `web/voices.py`, where the round it repeats already lived. Same split
`swap_queue` makes, and for the same reason: the thing that knows how to launch work and the
thing that survives a restart have different lifetimes, and merging them is how one of them ends
up importing Flask.

The file includes the run description and sample text. It is written atomically through
`vault_fs.write_yaml_atomic` under the routed candidate store, keeping user-authored text encrypted
at rest and avoiding partial state files.
"""
import threading
import time
from pathlib import Path

import yaml
from loguru import logger

import vault_fs

# Maximum candidates per batch. This bounds accidental requests that could generate a large amount
# of audio and require manual cleanup.
MAX_BATCH = 500

# The log is a coarse narration for the morning, not a transcript. Bounded because it is
# persisted on every round and an unbounded list would grow a YAML file all night.
_LOG_KEEP = 300


class VoiceBatch:
    """One batch: how many candidates were asked for, how many exist, and the form that made
    them. Thread-safe — the runner thread and the request handlers both touch it, and every
    mutation saves, so the file on disk is always the truth.

    There is exactly ONE batch, deliberately. A queue of batches would be a queue of things
    competing for the same two cards, which is a scheduler; "run this description a hundred
    times" is the whole feature and a second one can wait until the first is done."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.running = False        # the runner loops on this; NEVER persisted True
        self.stopping = False       # stop requested; the round in flight is canceled
        self.total = 0              # candidates asked for; 0 = no batch has ever been armed
        self.done = 0               # candidates actually produced and stored
        self.failed = 0             # rounds that produced nothing
        self.prompt = ""
        self.sample_text = ""
        self.steps = 30
        self.cfg = 2.0
        self.spent_s = 0.0          # seconds actually spent running — the ETA's denominator
        self.started = 0.0          # when the current run began (0 when not running)
        self.error = ""
        self.log = []
        self._load()

    # ── persistence ──────────────────────────────────────────────────────────
    def _load(self):
        with self.lock:
            self.running = False
            self.stopping = False
            # vault_fs, not a bare `is_file()`: the file is in a routed tree, so on an encrypted
            # install its name on disk is ciphertext and a plain existence check answers False —
            # the batch would silently load EMPTY and a morning's progress would read as "no
            # batch was ever run", which is indistinguishable from having finished one.
            if not vault_fs.exists(self.path):
                return
            try:
                data = yaml.safe_load(vault_fs.read_text(self.path)) or {}
            except (OSError, ValueError, yaml.YAMLError) as e:
                # NAMED, not a blind `except Exception` — the only things "this file is not a
                # batch" can legitimately mean are: it would not read (OSError), it is not UTF-8
                # (UnicodeDecodeError ⊂ ValueError), or it is not YAML.
                #
                # Keep the exception list narrow: a locked vault is an access error, not a missing
                # batch, and must propagate to the caller.
                logger.warning(f"voice batch unreadable — starting empty: {self.path} ({e})")
                return
            if not isinstance(data, dict):
                return
            self.total = max(0, int(data.get("total") or 0))
            self.done = max(0, int(data.get("done") or 0))
            self.failed = max(0, int(data.get("failed") or 0))
            self.prompt = str(data.get("prompt") or "")
            self.sample_text = str(data.get("sample_text") or "")
            self.steps = int(data.get("steps") or 30)
            self.cfg = float(data.get("cfg") or 2.0)
            self.spent_s = float(data.get("spent_s") or 0.0)
            self.error = str(data.get("error") or "")
            got = data.get("log")
            self.log = [str(x) for x in got][-_LOG_KEEP:] if isinstance(got, list) else []
            # `running` is never persisted, so a process restart cannot resume work unattended.
            # Record the interruption for the next browser session.
            if self.done < self.total:
                self._append_log("interrupted — Vocalis restarted. Press ▶ to carry on.")

    def _save(self):
        """Caller holds the lock. Atomic on both arms; `running` is never among the keys."""
        try:
            vault_fs.mkdir(self.path.parent)
            vault_fs.write_yaml_atomic(self.path, {
                "total": self.total, "done": self.done, "failed": self.failed,
                "prompt": self.prompt, "sample_text": self.sample_text,
                "steps": self.steps, "cfg": self.cfg, "spent_s": round(self.spent_s, 1),
                "error": self.error, "log": self.log[-_LOG_KEEP:],
            }, sort_keys=False)
        except (OSError, yaml.YAMLError) as e:
            # Named for the same reason `_load`'s is. A save failure must not sink the round that
            # just produced a candidate — the clip is already in the store — but a VaultLocked
            # here is a real fault and belongs to the caller, not to a log line.
            logger.warning(f"could not save the voice batch: {self.path} ({e})")

    # ── operations ───────────────────────────────────────────────────────────
    def arm(self, count: int, prompt: str, sample_text: str, steps: int, cfg: float) -> None:
        """Set up a fresh run. Does NOT start it — that is `set_running(True)`, and keeping the
        two apart is swap_queue §5.1's rule, not a style preference.

        Arming resets progress and the log because a new description starts a new run. Previously
        generated candidates remain in the tray; a new batch appends to that list."""
        with self.lock:
            # Capture the previous progress before resetting it so the new log can explain what
            # was discarded.
            was_done, was_total = self.done, self.total
            self.total = max(1, min(MAX_BATCH, int(count)))
            self.done = 0
            self.failed = 0
            self.prompt = str(prompt or "")
            self.sample_text = str(sample_text or "")
            self.steps = int(steps)
            self.cfg = float(cfg)
            self.spent_s = 0.0
            self.error = ""
            self.log = []
            self._append_log(f"batch armed: {self.total} candidates")
            if was_total and 0 < was_done < was_total:
                self._append_log(
                    f"a previous run's progress ({was_done} of {was_total}) was discarded — "
                    "this is a fresh batch. The candidates it already made are kept. "
                    "▶ Carry on would have continued it instead")
            self._save()

    def arm_and_run(self, count: int, prompt: str, sample_text: str, steps: int,
                    cfg: float) -> bool:
        """Arm a fresh run and mark it running, ATOMICALLY. False when one is already going.

        The operation must be atomic. A route that read `status()`, decided nobody
        was running, and then called `arm()` has a window between the two — and `arm()` RESETS
        progress. Two tabs, or one double-click, and a batch 60 candidates in is zeroed to 0/100
        with two runner threads on it, both counting into the same total. The check and the
        transition have to be one operation under one lock, which is what this is."""
        with self.lock:
            if self.running:
                return False
            self.arm(count, prompt, sample_text, steps, cfg)   # RLock — reentrant, by design
            self.set_running(True)
            return True

    def clear(self) -> bool:
        """Throw the batch away entirely, back to `idle`. False while one is running.

        A stopped run retains its original form, so clearing it gives the caller a way to discard
        that state before arranging different work. Generated candidates remain in the tray;
        clearing a run only removes its batch state."""
        with self.lock:
            if self.running:
                return False
            self.total = 0
            self.done = 0
            self.failed = 0
            self.spent_s = 0.0
            self.started = 0.0
            self.error = ""
            self.log = []
            self._save()
            return True

    def resume(self) -> bool:
        """Mark a stopped run with work left as running, atomically. False when it cannot be —
        already going, never armed, or already finished. Same race as `arm_and_run`, minus the
        reset: two resumes would put two runner threads on one batch."""
        with self.lock:
            if self.running or not self.total or self.done >= self.total:
                return False
            self.set_running(True)
            return True

    def _accrue(self) -> None:
        """Caller holds the lock. Move the time since `started` into `spent_s` and re-stamp.

        Accrue time before each round is saved so `spent_s` and `done` describe the same completed
        work after a restart. An unclean exit can then lose timing data only for the in-flight round.
        """
        if self.running and self.started:
            now = time.monotonic()
            self.spent_s += max(0.0, now - self.started)
            self.started = now

    def set_running(self, on: bool) -> None:
        """Start or stop the run. Stopping is a REQUEST — the runner finishes or cancels the
        round in flight and then halts, which is what makes stop lossless: whatever that round
        already stored is already in the list."""
        with self.lock:
            if on:
                self.running = True
                self.stopping = False
                self.error = ""
                self.started = time.monotonic()
            else:
                self._accrue()          # the tail since the last round
                self.running = False
                self.stopping = False
                self.started = 0.0
                self._save()

    def request_stop(self) -> None:
        """Ask the runner to stop. Separate from `set_running(False)` because the runner is the
        only thing allowed to declare itself stopped — a handler that flipped `running` off
        directly would leave a live round writing into a batch that believes it has halted."""
        with self.lock:
            if self.running:
                self.stopping = True
                self._append_log("stopping — finishing the round in flight… "
                                 "(■ again cancels it now)")

    def note_round(self, made: int, errors, canceled: bool = False,
                   seconds: float | None = None) -> None:
        """One round finished: `made` candidates landed, `errors` is what went wrong (if
        anything). A canceled round (the second ■ press) is not a failed round — counting
        it would put "1 round produced nothing" on a run whose only sin was being stopped hard.
        A candidate that landed before the cancel still counts; the cancel only excuses the
        empty case. Saves, so a crash costs at most the round in flight."""
        with self.lock:
            # Accrue before updating progress so elapsed time and completed work are saved together.
            self._accrue()
            if made:
                self.done += int(made)
            elif not canceled:
                self.failed += 1
            # Record successful rounds too, including elapsed time, so persisted progress and the
            # ETA have visible evidence from completed work.
            if made and seconds is not None:
                each = seconds / made
                self._append_log(
                    f"round done: {made} candidate{'' if made == 1 else 's'} in "
                    f"{seconds:.0f}s ({each:.0f}s each) — {self.done} of {self.total}")
            for e in (errors or []):
                self._append_log(f"round failed: {e}")
            self._save()

    def add_log(self, msg: str) -> None:
        with self.lock:
            self._append_log(msg)
            self._save()

    def _append_log(self, msg: str) -> None:
        """Caller holds the lock. No timestamp: this is read as a narrative in the morning, and
        `spent_s` already answers "how long did it take".

        Keep the first line when trimming so a long run retains its initial armed/resumed context."""
        self.log.append(str(msg))
        if len(self.log) > _LOG_KEEP:
            self.log[:] = self.log[:1] + self.log[-(_LOG_KEEP - 1):]

    def fail(self, message: str) -> None:
        """The run could not continue — no GPU at all, or a round that raised. Recorded rather
        than logged and forgotten, because the morning question is always 'why did it stop'."""
        with self.lock:
            self.error = str(message)
            self._append_log(f"stopped: {message}")
            self._save()

    # ── read ─────────────────────────────────────────────────────────────────
    def remaining(self) -> int:
        with self.lock:
            return max(0, self.total - self.done)

    def status(self) -> str:
        """`idle` (never armed) / `running` / `stopping` / `stopped` (armed, work left, not
        running — includes both 'paused' and 'interrupted by a restart') / `done`."""
        with self.lock:
            if not self.total:
                return "idle"
            if self.running:
                return "stopping" if self.stopping else "running"
            return "done" if self.done >= self.total else "stopped"

    def snapshot(self) -> dict:
        """What the UI polls. `eta_s` is None until a round has actually finished — a guess
        made from zero samples is worse than an honest blank, especially here, where the first
        round of a cold batch pays an ~11 s model load the other forty-nine do not."""
        with self.lock:
            spent = self.spent_s + (max(0.0, time.monotonic() - self.started)
                                    if self.running and self.started else 0.0)
            eta = None
            if self.done and self.done < self.total and spent > 0:
                eta = round((spent / self.done) * (self.total - self.done))
            return {"status": self.status(), "total": self.total, "done": self.done,
                    "failed": self.failed, "remaining": max(0, self.total - self.done),
                    "prompt": self.prompt, "sample_text": self.sample_text,
                    "steps": self.steps, "spent_s": round(spent, 1), "eta_s": eta,
                    "error": self.error, "log": list(self.log)}
