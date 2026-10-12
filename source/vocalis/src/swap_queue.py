#!/usr/bin/env python3
"""Persist ordered voice-swap jobs separately from running them. add() never starts work; the server-owned runner acts only when running is enabled. Stopping finishes the current job and preserves queued work. Load persisted queues stopped, reset interrupted jobs to pending, and require an explicit restart."""
import threading
import uuid
from pathlib import Path

import yaml
from loguru import logger

import vault_fs

# The request fields we persist per entry — exactly what the /voiceswap swap form sends, so a
# queued job is re-validated and launched through the SAME path an ad-hoc Convert takes. Stored
# RAW (not the resolved job): the source could vanish before it runs, and "auto" device must be
# re-resolved to the emptiest card at run time, not frozen at add time.
REQ_FIELDS = ("song", "voice", "pitch", "index_rate", "vocal_gain", "backing_gain",
              "rms_mix_rate", "clean_up", "device")


class SwapQueue:
    """An ordered list of swap requests + a run/stop flag, persisted to one YAML.

    Thread-safe: the server's runner thread and its request handlers both touch it. Every
    mutation saves, so the on-disk file is always the truth — a crash loses at most the
    in-flight job, never the list."""

    def __init__(self, path):
        self.path = Path(path)
        self.entries = []          # ordered; each a dict (see _new_entry)
        self.running = False       # the runner loops on this; NEVER persisted True (§5.3)
        self.lock = threading.RLock()
        self._load()

    # ── persistence ──────────────────────────────────────────────────────────
    def _load(self):
        with self.lock:
            self.running = False
            # 🔴 M10 §4.3 Q2 — vault_fs. The queue file lives in `output/`, a routed tree, so a
            # bare is_file() answers False once the vault is on and the queue LOADS EMPTY: every
            # pending swap silently forgotten, and the UI showing an empty list is
            # indistinguishable from a queue you had actually finished.
            if not vault_fs.exists(self.path):
                return
            try:
                data = yaml.safe_load(vault_fs.read_text(self.path)) or {}
            except Exception as e:                         # noqa: BLE001
                # A VaultAuthError is a BaseException and is NOT caught here: a wrong key is not
                # a corrupt queue, and degrading it to "starting empty" would answer it by
                # quietly discarding the user's pending work.
                logger.warning(f"swap queue unreadable — starting empty: {self.path} ({e})")
                return
            entries = data.get("entries") if isinstance(data, dict) else None
            for e in (entries or []):
                if not isinstance(e, dict) or "id" not in e:
                    continue
                # A job that was RUNNING when the process died: its swap is gone, so it goes
                # back to pending and ▶ Run re-runs it. done/failed keep their status.
                if e.get("status") == "running":
                    e["status"] = "pending"
                    e["job_id"] = ""
                self.entries.append(e)

    def _save(self):
        # The vault-aware atomic write keeps the temporary sibling encrypted with the queue.
        # sort_keys=False preserves each entry’s readable field order for diagnostics.
        try:
            vault_fs.mkdir(self.path.parent)
            vault_fs.write_yaml_atomic(self.path, {"entries": self.entries}, sort_keys=False)
        except Exception as e:                             # noqa: BLE001
            logger.warning(f"could not save swap queue: {self.path} ({e})")

    # ── operations ───────────────────────────────────────────────────────────
    @staticmethod
    def _new_entry(req: dict, label: str, kind: str, audio_s: float) -> dict:
        # Store only the fields the request ACTUALLY carried — never fill absentees with None,
        # or re-validation would parse None where it wanted a default and reject its own job.
        return {"id": uuid.uuid4().hex[:12],
                "req": {k: req[k] for k in REQ_FIELDS if k in req},
                "label": label, "kind": kind, "audio_s": float(audio_s or 0),
                "status": "pending", "job_id": "", "result": "", "error": ""}

    def add(self, req: dict, label: str, kind: str = "song", audio_s: float = 0.0) -> dict:
        """Append a pending job. Never starts anything (§5.1)."""
        with self.lock:
            e = self._new_entry(req, label, kind, audio_s)
            self.entries.append(e)
            self._save()
            return e

    def remove(self, entry_id: str) -> bool:
        with self.lock:
            n = len(self.entries)
            self.entries = [e for e in self.entries if e["id"] != entry_id]
            changed = len(self.entries) != n
            if changed:
                self._save()
            return changed

    def to_front(self, entry_id: str) -> bool:
        """↑ Next — jump one item to the front of the PENDING run order. It lands just after
        anything already running, so it is genuinely next (§5.5). Nobody wants to arrange ten
        items; they want one to jump the line."""
        with self.lock:
            idx = next((i for i, e in enumerate(self.entries) if e["id"] == entry_id), None)
            if idx is None or self.entries[idx].get("status") != "pending":
                return False
            e = self.entries.pop(idx)
            insert = 0
            while insert < len(self.entries) and self.entries[insert].get("status") == "running":
                insert += 1
            self.entries.insert(insert, e)
            self._save()
            return True

    def clear(self) -> int:
        """✕ Clear all — drop every PENDING/failed entry. A running job is left alone (it is
        finishing; Stop is how you halt the run). Returns how many were removed."""
        with self.lock:
            keep = [e for e in self.entries if e.get("status") == "running"]
            removed = len(self.entries) - len(keep)
            self.entries = keep
            if removed:
                self._save()
            return removed

    def list(self) -> list:
        with self.lock:
            return [dict(e) for e in self.entries]

    def next_pending(self):
        """The oldest pending entry — the run order (§6.2: oldest unfinished first)."""
        with self.lock:
            return next((dict(e) for e in self.entries if e.get("status") == "pending"), None)

    def has_pending(self) -> bool:
        with self.lock:
            return any(e.get("status") == "pending" for e in self.entries)

    def mark(self, entry_id: str, status: str, job_id: str = None,
             result: str = "", error: str = "") -> None:
        """Set an entry's status. `done` REMOVES it — the result is in the library now, and a
        drained queue is the point. `failed` stays visible (with its error) so you can see what
        went wrong and Remove or re-add it; the runner skips it and carries on."""
        with self.lock:
            if status == "done":
                self.entries = [e for e in self.entries if e["id"] != entry_id]
                self._save()
                return
            for e in self.entries:
                if e["id"] == entry_id:
                    e["status"] = status
                    if job_id is not None:
                        e["job_id"] = job_id
                    if result:
                        e["result"] = result
                    e["error"] = error
                    break
            self._save()

    def set_running(self, on: bool) -> None:
        with self.lock:
            self.running = bool(on)
