"""Persistent settings for the system prompt, examples, and wrapper.

The shipped Section-Editor card provides the starting prompt. This module stores user edits in the
vault so they can be tuned without rebuilding the application.

🔴 **Few-shot pairs are part of the output contract.** The stored prompt includes them in its
fingerprint, and the UI can restore the shipped version after an edit.

🔴 **It routes.** The saved prompt is user-authored content and lives under the
`wbedit` tree like everything else — never a plain `open()`, never the scratch.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

import vault_fs

from .assemble import DEFAULT_WRAPPER
from .card_loader import load as load_card
from ..store.models import PROMPT_LOCK, store_lock

#: Beside the document store rather than in `voice_settings.yaml`: it is a multi-KB document with
#: its own edit lifecycle, not a knob, and the settings file is read on paths that must stay cheap.
PROMPT_FILE = "prompt.json"


def _path(root) -> Path:
    return Path(root) / PROMPT_FILE


def fingerprint(system: str, shots: list[dict[str, str]], wrapper: str = "") -> str:
    """A short, stable id for "which prompt ran this pass" (§6.4.1).

    🔴 **THE SHOTS ARE IN IT, NOT JUST THE SYSTEM TEXT.** Dropping a few-shot pair changes the
    model's behavior more than most edits to the prose does, and a hash that ignored them would
    report two materially different passes as having run under the same prompt.
    """
    h = hashlib.sha256()
    h.update(system.encode("utf-8"))
    for s in shots:
        h.update(b"\x00")
        h.update(s.get("user", "").encode("utf-8"))
        h.update(b"\x01")
        h.update(s.get("assistant", "").encode("utf-8"))
    h.update(b"\x02")
    h.update((wrapper or DEFAULT_WRAPPER).encode("utf-8"))
    return h.hexdigest()[:12]


def baseline(card: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """The starting point shipped with the code, before any user edits."""
    return load_card(card)


def load(root, card: dict[str, Any]) -> dict[str, Any]:
    """The EFFECTIVE prompt plus everything the pane and the report need.

    Returns `system`, `shots`, `wrapper`, `fingerprint`, and the shipped starting point as
    `shipped_system` / `shipped_shots` so the pane can offer a reset without a second round trip
    and can show what it is diverging from.

    🔴 **There is no `edited` flag.**
    It was also redundant — `fingerprint` identifies the prompt exactly, which is what the log
    record needs. "Would Reset change anything" is a comparison against `shipped_fingerprint`,
    not a property worth storing and keeping in sync.

    ⚠️ **A CORRUPT SAVED PROMPT FALLS BACK TO THE SHIPPED ONE RATHER THAN RAISING.** This value
    is on the path of every pass; a half-written file must not make the feature unusable.
    """
    d_system, d_shots = baseline(card)
    system, shots, wrapper = d_system, d_shots, DEFAULT_WRAPPER

    p = _path(root)
    if vault_fs.exists(p):
        try:
            saved = json.loads(vault_fs.read_text(p))
            if isinstance(saved, dict) and isinstance(saved.get("system"), str):
                raw = saved.get("shots")
                shots = [{"user": str(s.get("user", "")), "assistant": str(s.get("assistant", ""))}
                         for s in raw if isinstance(s, dict)] if isinstance(raw, list) else []
                system = saved["system"]
                if isinstance(saved.get("wrapper"), str) and saved["wrapper"].strip():
                    wrapper = saved["wrapper"]
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    return {"system": system, "shots": shots, "wrapper": wrapper,
            "fingerprint": fingerprint(system, shots, wrapper),
            "shipped_system": d_system, "shipped_shots": d_shots,
            "shipped_wrapper": DEFAULT_WRAPPER,
            "shipped_fingerprint": fingerprint(d_system, d_shots, DEFAULT_WRAPPER)}


def save(root, system: str, shots: list[dict[str, str]], wrapper: str = "",
         *, note: str = "saved") -> int:
    """Persist the current prompt AND mint a revision of it (§9a.12). Returns the revision number.

    Validation is still the caller's; this stores what it is given.

    🔴 **THE REVISION IS WRITTEN FIRST.** If the process dies between the two writes, the outcome is
    a recorded prompt that is not yet in effect — recoverable from the picker. The other order gives
    an effective prompt with no record of it, which is the loss this whole section exists to end.
    Same crash plan as `DocumentStore.create`, and for the same reason.

    🔴 **BOTH WRITES UNDER ONE LOCK (§3.3/§3.4).** Locking only `record` would fix the revision
    numbering and leave a worse bug behind: two tabs saving at once could mint 1 then 2, and then
    write the CURRENT file in the other order — leaving revision 2 as the latest in the picker
    while revision 1's text is what every pass actually uses. The crash plan above depends on the
    two writes being ordered; concurrency is the other way they come apart. `store_lock` is an
    `RLock`, so `record`'s own acquisition below nests without deadlocking.
    """
    with store_lock(root, PROMPT_LOCK):
        n = record(root, system, shots, wrapper, note=note)
        vault_fs.write_text(_path(root), json.dumps(
            {"system": system, "wrapper": wrapper or DEFAULT_WRAPPER,
             "shots": [{"user": s.get("user", ""), "assistant": s.get("assistant", "")}
                       for s in shots]},
            ensure_ascii=False, indent=1))
        return n


def reset(root, card: dict[str, Any] | None = None) -> int | None:
    """Back to the card. Deleting the file IS the reset — there is no "default" record to
    restore, so the baseline can change with the card and a reset still means today's card.

    🔴 **The prompt is recorded first (§9a.12).** The UI offers Reset during troubleshooting, so
    the effective value is minted as a revision before the file is removed. Reset is recoverable from the
    picker like every other write.

    ⚠️ `card` is optional ONLY so existing callers keep working; without it there is nothing to
    compare against and the recording still happens. Returns the revision number, or None when
    there was no tuned prompt to lose.

    🔴 Locked for the same reason `save` is: read-the-file / mint-a-revision / delete-the-file is a
    three-step sequence, and a concurrent `save` landing between the read and the unlink would be
    recorded as the prompt "in effect when Reset was pressed" while its own file was then deleted
    out from under it — the save reports a revision number that describes a prompt no longer in
    force, which is the reported-success-for-nothing shape this batch keeps finding.
    """
    with store_lock(root, PROMPT_LOCK):
        p = _path(root)
        if not vault_fs.exists(p):
            return None
        n = None
        try:
            saved = json.loads(vault_fs.read_text(p))
            if isinstance(saved, dict) and isinstance(saved.get("system"), str):
                raw = saved.get("shots")
                shots = [{"user": str(s.get("user", "")), "assistant": str(s.get("assistant", ""))}
                         for s in raw if isinstance(s, dict)] if isinstance(raw, list) else []
                n = record(root, saved["system"], shots, saved.get("wrapper") or "",
                           note="the prompt in effect when Reset was pressed")
        except (OSError, ValueError, TypeError, AttributeError):
            # ⚠️ A corrupt prompt file is not worth blocking the reset — the reset is what FIXES it.
            pass
        vault_fs.unlink(p, missing_ok=True)
        return n


# ── 7.0-m5a / §9a.12: the prompt gets revisions, for the reason the documents do ──────────────
#
# 🔴 **Reset preserves the previous effective prompt.** The earlier implementation overwrote or
# unlinked the active file without keeping a revision.
#
# The documents solved this in m1 and the answer is the same one: **every write mints a revision,
# and nothing is ever rewound.** Restoring an old prompt appends a NEW revision equal to it, exactly
# as `DocumentStore.rollback` does — history only grows, so a restore is never a second loss.
#
# 📌 `prompt.json` KEEPS ITS EXACT MEANING as the effective prompt, and every reader of it is
# unchanged. The revisions sit beside it; they are a log, not a new source of truth.
REV_DIR = "prompt-rev"


def _rev_dir(root) -> Path:
    return Path(root) / REV_DIR


def _rev(root, n: int) -> Path:
    return _rev_dir(root) / f"{n:04d}.json"


def revisions(root) -> list[int]:
    """Every revision number, ascending. The filesystem is the authority — same rule as documents:
    no index file to drift out of step with what is actually on disk."""
    d = _rev_dir(root)
    if not vault_fs.exists(d):
        return []
    out = []
    for p in vault_fs.listdir(d):
        stem = Path(str(p)).stem
        try:
            out.append(int(stem))
        except ValueError:
            continue
    return sorted(out)


def revision(root, n: int) -> dict[str, Any] | None:
    """One saved prompt, or None if it is missing or unreadable.

    ⚠️ None rather than raising, for the same reason `load` falls back: this sits behind a picker
    in a pane that must stay usable when one file of many is damaged.
    """
    p = _rev(root, int(n))
    if not vault_fs.exists(p):
        return None
    try:
        d = json.loads(vault_fs.read_text(p))
    except (OSError, ValueError, TypeError):
        return None
    return d if isinstance(d, dict) and isinstance(d.get("system"), str) else None


def revision_index(root) -> list[dict[str, Any]]:
    """`[{n, created_at, note, fingerprint}]`, ascending — what the picker renders.

    ⚠️ A corrupt revision yields a STUB ROW rather than disappearing. A gap in the numbering is
    a gap the UI should show; silently omitting it makes damage look like it never
    happened, which is the same failure `DocumentStore.revision_index` avoids.
    """
    out = []
    for n in revisions(root):
        d = revision(root, n)
        if d is None:
            out.append({"n": n, "created_at": 0.0, "note": "unreadable", "fingerprint": ""})
            continue
        out.append({"n": n, "created_at": float(d.get("created_at") or 0.0),
                    "note": str(d.get("note") or ""),
                    "fingerprint": fingerprint(d["system"], d.get("shots") or [],
                                               d.get("wrapper") or "")})
    return out


def record(root, system: str, shots: list[dict[str, str]], wrapper: str = "",
           *, note: str = "") -> int:
    """Append a revision and return its number. `n` comes from the filesystem, never a counter.

    🔴 **LOCKED, BECAUSE THIS IS THE SAME READ-MODIFY-WRITE `add_revision` IS** (§3.3/§3.4). Read
    the revision list, add one, write that file — with nothing in between stopping a second thread
    doing the identical thing on a `threaded=True` server. Both compute the same `n`, both write
    `_rev(root, n)`, and one of the two revisions is simply gone. It is *more* exposed than the
    document stores, not less: the prompt is ONE store for the whole install, so it does not even
    need two documents in play — two browser tabs with the prompt card open is enough, and the
    pane's own help text directs users here when a pass misbehaves.

    ⚠️ This was missed by the store-wide concurrency sweep because it lives in `prompt/` rather
    than `store/`, and every enumeration of "every mutation path" was drawn over `store/`. The
    lock registry is keyed on `(root, name)`, so `PROMPT_LOCK` here excludes correctly against
    itself across every `DocumentStore`/`PassStore` instance built per request.
    """
    with store_lock(root, PROMPT_LOCK):
        nums = revisions(root)
        n = (nums[-1] + 1) if nums else 0
        vault_fs.mkdir(_rev_dir(root))
        vault_fs.write_json_atomic(_rev(root, n), {
            "n": n, "created_at": time.time(), "note": note,
            "system": system, "wrapper": wrapper or DEFAULT_WRAPPER,
            "shots": [{"user": s.get("user", ""), "assistant": s.get("assistant", "")} for s in shots],
        }, indent=1)
        return n
