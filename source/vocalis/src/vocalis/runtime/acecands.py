"""Persist the candidates tray index across server restarts.

Candidate audio remains in the backend's output folder; this store keeps only the metadata and
remote path needed to list and retrieve it. Saving to the library is what makes audio durable. A
backend restart can remove cached audio while its index row remains, so playback reports the
unavailable resource rather than silently hiding the row.

Mutations read the current routed file before writing. Vault and corruption errors propagate
rather than being mistaken for an empty store.

The engine has no delete call and writes every song into its output folder, so this store also
owns removing those files (2026-10-11; before that nothing ever did, and a two-day-old test install
held a dozen). A song's file is read again only through its candidate record (the tray's player and
Save, which stores a separate copy), so a file goes as soon as nothing refers to it: no remembered
candidate, no record in the undo bin, no job in the registry. Two paths do it. `_write` deletes the
files of records that leave the store for good, right then. `reconcile_output` sweeps up whatever
no record ever named (a canceled render's song, candidates from before this existed), but only when
no ACE-Step job is queued or running, because a running job's file exists before its record does.
A finished candidate used as a Remix/Repaint source is staged as a copy (`acestage._stage_candidate`),
so a new job never refers to the engine's file.
"""
import json
import os
import stat
import threading

import vault_fs
from loguru import logger
from vault import VaultAuthError, VaultLocked

from vocalis.runtime import acestage, paths

_LOCK = threading.RLock()

#: How many finished candidates to keep. They are cheap (a few hundred bytes each) but the tray
#: is a working surface, not an archive — the Library is the archive. Oldest are dropped first.
MAX_REMEMBERED = 60


class CandidateStoreCorrupt(RuntimeError):
    """The file exists and is not a candidate list. Never raised for a missing file."""


def _path():
    return paths.ACE_CANDIDATES


# The recycle bin shares this file and its routing, locking, and validation rules with candidates.
def _read_raw() -> dict:
    """The whole file as `{"candidates": [...], "bin": [...]}`, or two empties when it has never
    been written.

    A missing file means nothing has been remembered. Corrupt data and vault access errors
    propagate so an unreadable store is not presented as an empty tray.
    """
    p = _path()
    if not vault_fs.exists(p):
        return {"candidates": [], "bin": []}
    try:
        data = json.loads(vault_fs.read_text(p))
    except ValueError as exc:
        raise CandidateStoreCorrupt(f"{p.name}: not JSON ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("candidates"), list):
        raise CandidateStoreCorrupt(f"{p.name}: not a candidate list")
    def rows(v):
        return [c for c in v if isinstance(c, dict) and c.get("id")] if isinstance(v, list) else []

    # Files created before the undo bin existed omit this key; treat that as an empty bin.
    return {"candidates": rows(data["candidates"]), "bin": rows(data.get("bin"))}


def _read() -> list:
    return _read_raw()["candidates"]


def _write(items: list, bin_rows=None) -> None:
    """Write the candidates, and the bin when the caller has an opinion about it.

    `bin_rows=None` means "leave it unchanged," which differs from `[]`. Every existing
    caller writes candidates only, and a default of `[]` would have each of them silently empty
    the recycle bin — the single most obvious way to ship an Undo button that is empty exactly
    when it is needed.

    Every caller holds `_LOCK` and has just read the store, so the read for `before` cannot see a
    different file. It exists to learn which records this write removes (see `_release`).
    """
    before = _read_raw()
    keep = before["bin"] if bin_rows is None else bin_rows
    items, keep = items[-MAX_REMEMBERED:], keep[-MAX_REMEMBERED:]
    vault_fs.write_json_atomic(_path(), {"candidates": items, "bin": keep}, indent=2)
    # After the write, never before: a failed write leaves every record, so every file stays. A
    # crash between the two leaves files no record names, which `reconcile_output` collects.
    _release(before, items + keep)


def _audio_names(audio) -> set:
    """The file names a `detail["audio"]` value points at: the last part of each path the engine
    reported (a list of its own absolute paths, possibly in either slash style).

    Names, not paths, on purpose. Engine names are generated and never repeat, and comparing the
    last part keeps a file when the engine's view of the folder differs from ours (a link in the
    stage root, a mount) — wrongly keeping a file is the safe mistake here.
    """
    if isinstance(audio, str):
        audio = [audio]
    if not isinstance(audio, (list, tuple)):
        return set()
    names = {str(p).replace("\\", "/").rsplit("/", 1)[-1] for p in audio if p}
    return names - {"", ".", ".."}


def _record_names(rows) -> set:
    names = set()
    for rec in rows:
        detail = rec.get("detail") if isinstance(rec, dict) else None
        if isinstance(detail, dict):
            names |= _audio_names(detail.get("audio"))
    return names


def _job_state(jobs_mod) -> tuple:
    """(file names the ACE-Step jobs in the registry refer to, whether one is queued or running).

    A job that finished refers to its file whether or not its record was ever stored (the store may
    have been locked when it finished), and the tray plays from the job. Read without any lock,
    as the rest of this tree reads the registry: `detail` is only ever replaced, never edited.

    "Active" means able to cause a write, not merely marked running: a row restored after a
    restart whose child is gone stays "running" for the life of the process (see
    `acerun.can_still_produce_output`) and would otherwise stop every later pass.
    """
    from vocalis.runtime import acerun
    names, active = set(), False
    for job in list(jobs_mod.JOBS.values()):
        if getattr(job, "kind", "") != "acestep":
            continue
        active = active or (job.status in ("queued", "running")
                            and acerun.can_still_produce_output(job))
        names |= _audio_names((job.detail or {}).get("audio"))
    return names, active


def _release(before: dict, after_rows: list) -> None:
    """Delete the files of records that were in the store before a write and are not after it.

    Rule 1 of the module header: a record leaving for good (pushed out by the limit, an undo bin
    replaced or emptied by a newer discard, a record dropped without the bin) takes its files
    with it. Moving a record between the candidates and the bin keeps it, so a discard stays
    undoable. A file some job in the registry still refers to is kept; the pass after the job goes
    collects it.
    """
    if acestage.output_dir() is None:
        return
    gone = _record_names(before["candidates"] + before["bin"]) - _record_names(after_rows)
    if gone:
        from vocalis.runtime import jobs
        _delete_files(gone - _job_state(jobs)[0])


def _delete_files(names) -> int:
    """Delete these plain files from the engine's output folder. Returns how many went.

    Only a regular file directly inside the folder's real path is ever removed: the target is built
    as that real path plus one bare name, and `lstat` does not follow a link, so a link (to a file
    or a folder), a sub-folder or anything else is left alone. One warning per file that cannot be
    removed; one info line when something was removed. Counts only, never names — the names are
    engine-generated and say nothing useful.
    """
    out = acestage.output_dir()
    if out is None:
        return 0
    real_out = os.path.realpath(out)
    removed = 0
    for name in sorted(names):
        if name in ("", ".", "..") or "/" in name or "\\" in name or ":" in name:
            continue                  # ":" too: on Windows "C:name" joined to a folder is a path on drive C
        target = os.path.join(real_out, name)
        try:
            if not stat.S_ISREG(os.lstat(target).st_mode):
                continue
            os.unlink(target)
            removed += 1
        except FileNotFoundError:
            continue                  # already gone: the outcome we wanted
        except OSError as exc:
            logger.warning("ACE-Step output: could not remove a file no candidate refers to "
                           f"({exc.strerror or type(exc).__name__})")
    if removed:
        try:
            with os.scandir(real_out) as entries:
                kept = sum(1 for e in entries if e.is_file(follow_symlinks=False))
        except OSError as exc:
            logger.warning("ACE-Step output: could not count the files left "
                           f"({exc.strerror or type(exc).__name__})")
            kept = 0
        logger.info(f"ACE-Step output: removed {removed} file(s) no candidate refers to, "
                    f"kept {kept}")
    return removed


def reconcile_output(jobs_mod) -> int:
    """Delete every plain file in the engine's output folder that nothing refers to. Returns how
    many went.

    Rule 2 of the module header. Run at start-up once the store has been read, and after a job
    finishes or a candidate is discarded. Does nothing while any ACE-Step job is queued or running
    (a running job's file exists before its record does), when the engine is not known to share the
    folder (`acestage.output_dir`), or when the store cannot be read: a locked vault or a corrupt
    file must never look like "no candidates", so nothing is deleted and the log says why.
    """
    if acestage.output_dir() is None or _job_state(jobs_mod)[1]:
        return 0
    with _LOCK:
        try:
            doc = _read_raw()
        except (VaultAuthError, VaultLocked, CandidateStoreCorrupt, OSError) as exc:
            logger.warning("ACE-Step output: nothing removed, the candidate store could not be "
                           f"read ({type(exc).__name__}: {exc})")
            return 0
        live, active = _job_state(jobs_mod)
        if active:                    # a job was queued while the store was being read
            return 0
        keep = _record_names(doc["candidates"] + doc["bin"]) | live
        out = acestage.output_dir()
        if out is None:
            return 0
        try:
            with os.scandir(out) as entries:
                stray = [e.name for e in entries
                         if e.is_file(follow_symlinks=False) and e.name not in keep]
        except OSError as exc:
            logger.warning("ACE-Step output: nothing removed, the folder could not be listed "
                           f"({exc.strerror or type(exc).__name__})")
            return 0
        return _delete_files(stray)


def load_all() -> list:
    with _LOCK:
        return _read()


def remember(job_id: str, status: str, started_at: float, detail: dict) -> None:
    """Record one finished candidate. Replaces any existing record for the same id.

    Called from the worker's completion path, so it must not raise into it — a store that
    cannot be written must not also lose the song that was just made. The caller logs; this
    returns quietly.
    """
    with _LOCK:
        items = [c for c in _read() if c.get("id") != job_id]
        items.append({"id": job_id, "status": status, "started_at": started_at,
                      "detail": dict(detail or {})})
        _write(items)


def forget(job_id: str) -> bool:
    """Drop one record INTO THE BIN. True if it was there — Discard is the only caller.

    The bin is replaced, never appended to: one slot, holding whatever the LAST discard removed.
    The records the bin held before leave for good, and `_write` deletes their files.
    """
    with _LOCK:
        items = _read()
        gone = [c for c in items if c.get("id") == job_id]
        if not gone:
            return False
        _write([c for c in items if c.get("id") != job_id], bin_rows=gone)
        return True


def drop(job_id: str) -> bool:
    """Remove one record and DO NOT put it in the bin. True if it was there.

    Unlike `forget()`, this does not replace the undo bin. Canceling a queued job is not a discard
    and must not consume the candidate saved for undo. Remove the record as well, or it would
    rehydrate as a queued job after restart. A record dropped here that had output loses its file
    (`_write`): nothing can undo this.
    """
    with _LOCK:
        items = _read()
        keep = [c for c in items if c.get("id") != job_id]
        if len(keep) == len(items):
            return False
        _write(keep)
        return True


def forget_many(job_ids) -> list:
    """Drop several records as ONE undoable action. Returns the ones that were there.

    This writes the whole set to the single undo slot in one operation. Calling `forget()` once per
    row would replace the slot each time, leaving only the final record recoverable.
    """
    want = set(job_ids or ())
    with _LOCK:
        items = _read()
        gone = [c for c in items if c.get("id") in want]
        if not gone:
            return []
        _write([c for c in items if c.get("id") not in want], bin_rows=gone)
        return gone


def forget_all() -> int:
    """Discard everything remembered, as ONE undoable action."""
    with _LOCK:
        items = _read()
        _write([], bin_rows=items)
        return len(items)


def bin_size() -> int:
    """How many records Undo would put back. 0 when there is nothing to undo."""
    with _LOCK:
        return len(_read_raw()["bin"])


def undo() -> list:
    """Put the binned records back and empty the bin. Returns what was restored.

    The bin is emptied on success so the same action cannot be undone twice.
    `remember()` already replaces by id, so a restored candidate that somehow still existed
    collapses rather than doubling — but the bin is cleared regardless, because "undo" names one
    action and there is only ever one to reverse.
    """
    with _LOCK:
        doc = _read_raw()
        rows = doc["bin"]
        if not rows:
            return []
        have = {c.get("id") for c in doc["candidates"]}
        merged = doc["candidates"] + [c for c in rows if c.get("id") not in have]
        _write(merged, bin_rows=[])
        return rows


def rehydrate(jobs_mod) -> int:
    """Put remembered candidates back into the live job registry. Returns how many were added.

    Rehydrate first so persisted candidates sort as the oldest. `/acestep/jobs` orders by creation,
    i.e. dict
    insertion order reversed, so anything inserted here lands BELOW songs made this session —
    which is what "these are from before" should look like.

    Never overwrite a live job. A render in flight is authoritative; a record on
    disk is a snapshot of one that finished.
    """
    return sum(1 for rec in load_all() if rehydrate_one(jobs_mod, rec))


def rehydrate_one(jobs_mod, rec: dict) -> bool:
    """Put ONE stored record back into the live registry. False if absent, malformed or present.

    Shared by startup rehydration and undo so both paths reconstruct a job with the same fields.
    """
    jid = rec.get("id")
    if not jid or jid in jobs_mod.JOBS:
        return False
    try:
        j = jobs_mod.Job(id=jid, docx="", voice="", params=None, gpus="", workers=1)
    except Exception as exc:      # noqa: BLE001 — a shape change here must not kill the tab
        logger.warning(f"acecands: cannot rebuild job {jid}: {exc}")
        return False
    j.kind = "acestep"
    j.status = rec.get("status") or "done"
    j.started_at = float(rec.get("started_at") or 0.0)
    j.detail = dict(rec.get("detail") or {})
    jobs_mod.JOBS[jid] = j
    return True
