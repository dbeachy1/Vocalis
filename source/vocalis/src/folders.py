"""Implement one-level virtual folders as labels over existing listings. Scope assignments by dataset so panels sharing a store share folders. Folder operations never move audio or other source files. Mutations use one locked read-modify-write, abort on unreadable state, and write only changed data through the vault-routed store. Stale assignments are ignored; scopes whose refs change on rename must call rekey()."""
from __future__ import annotations

import re
import secrets
import threading
from pathlib import Path

from loguru import logger

FILENAME = "folders.yaml"

# ── the scopes ───────────────────────────────────────────────────────────────────────────
#
# 🔴 A CLOSED SET, VALIDATED AT THE ROUTE. An open-ended scope string would let a stuck or hostile
# client grow this file one invented key at a time, and `for_rows` would never read any of them —
# the `ui_state` lesson (cap what you store, not just how many) applied to the KEY rather than the
# value. Adding a listing to the app means adding its name here, on purpose.
#
# 📌 Each name is the DATASET, not the panel. The comments name every panel that renders it, because
# that is the fact a future reader will get wrong.
SCOPES = (
    "train_sources",      # /train/sources     — Speech tab, Training ▸ sources, Voice Swap ▸ speech
    "voiceswap_songs",    # /voiceswap/songs   — Voice Swap ▸ Sources, Stems ▸ song picker
    "voices_rvc",         # /voiceswap/voices  — Training ▸ voices, Voice Swap ▸ voice half
    "voices_tts",         # /voices            — Voices tab
    "swap_library",       # /voiceswap/library — Voice Swap ▸ finished songs
    "stems_library",      # /stems/library     — Stems library
    "playground_clips",   # /playground/clips  — Playground library
    "scenes",             # scenes             — Clips ▸ scenes
    "acelib",             # ACE-Step library   — Music library
    "books",              # books              — Books library
)

# ── caps ─────────────────────────────────────────────────────────────────────────────────
#
# 🔴 A COUNT CAP IS NOT A SIZE CAP, AND `clip_favorites` SHIPPED WITH ONLY THE FIRST.
# Its `MAX_FAVORITES` bounded how MANY entries there were while a JSON body may be 128 MB, so one
# POST with a multi-megabyte ref wrote a multi-megabyte entry that every later read decrypted. Both
# dimensions are capped here from the start, on the name AND on the ref.
MAX_FOLDERS_PER_SCOPE = 200      # far past use; a bound on a list that grows one click at a time
MAX_NAME_LEN = 60                # a folder name is a label, not a document
MAX_REF_LEN = 256                # matches `vocalis/web/clips.py`'s bound on a clip ref
MAX_ASSIGN_PER_SCOPE = 20000     # one entry per filed item; a library is thousands, not millions

# When a scope uses refs that can change on rename, include it here so the rename-hook test verifies that its rename path calls rekey(). Add it when the rename behavior is added. Prefer immutable keys when the store contract permits them.
RENAME_MOVES_REF = (
    "scenes",            # scene_stem() = safe_name(title) + '_' + h[:8]
    "playground_clips",  # rename_clip() rebuilds the stem from safe_name(new_name)
    "train_sources",     # rename_source() is a pure file rename; the ref IS the filename
    "voices_rvc",        # rename_voice() moves weight, index and sidecar together
    "stems_library",     # set_ref() = safe_name(song) + '_' + h[:8]; the M4 migration re-forms it
)

_ID_RE = re.compile(r"^f_[0-9a-f]{8}$")

# 🔴 See the module docstring. Every mutator writes inline under this lock; none calls `save()`,
# so there is exactly one acquisition and no re-entry.
_MU = threading.Lock()


class FoldersUnreadable(Exception):
    """The store exists and will not parse.

    Twin of `stems.SongIndexUnreadable` and `voice_utils.SettingsUnreadable`, and it exists for the
    same reason: a MUTATION must abort rather than write one scope back over a file it could not
    read and erase every other scope's folders. READS degrade instead — an unreadable store means
    "no folders", which renders a flat list and is exactly what this feature is an overlay on.

    ⚠️ ABSENT ≠ CORRUPT. A missing file has nothing to destroy, so it reads as an empty document
    even when strict, and `create()` goes on to make it."""


def path_for(install_root) -> Path:
    return Path(install_root) / FILENAME


def _blank() -> dict:
    return {"folders": {}, "assign": {}}


def _clean(doc) -> dict:
    """Coerce whatever was on disk into the document shape, dropping anything malformed.

    🔴 SILENTLY DROPPING JUNK IS RIGHT HERE AND WRONG IN A MUTATOR. A reader that raised on one bad
    row would take a whole tab down over a label; a writer that dropped one would erase real
    folders. `load(strict=True)` is the writer's door.

    ⚠️ AND THAT DOOR IS NOT A COMPLETE GUARD — this paragraph used to claim it "raises before this
    ever runs", which was false: `_mutate` writes what `_clean` returns, so every drop below IS a
    drop on the way to disk. 8.9.14 closed the one case that could destroy another scope's data (an
    UNKNOWN scope key — see `load`). The rest are deliberately left silent because none is
    reachable through the app: `_norm_name` already caps a name at MAX_NAME_LEN and the route
    rejects anything longer than 4×, `assign` raises rather than truncating a ref past MAX_REF_LEN,
    and both caps below are enforced loudly at their own call sites first. They stay here as a
    last-resort coercion for a hand-edited file, not as a policy for one the app wrote."""
    if not isinstance(doc, dict):
        return _blank()
    folders, assign = {}, {}
    raw_f = doc.get("folders")
    if isinstance(raw_f, dict):
        for scope, rows in raw_f.items():
            if scope not in SCOPES or not isinstance(rows, list):
                continue
            keep = []
            for r in rows:
                if not isinstance(r, dict):
                    continue
                fid, name = str(r.get("id") or ""), str(r.get("name") or "")
                if _ID_RE.match(fid) and name:
                    keep.append({"id": fid, "name": name[:MAX_NAME_LEN]})
            if keep:
                folders[scope] = keep[:MAX_FOLDERS_PER_SCOPE]
    raw_a = doc.get("assign")
    if isinstance(raw_a, dict):
        for scope, m in raw_a.items():
            if scope not in SCOPES or not isinstance(m, dict):
                continue
            known = {f["id"] for f in folders.get(scope, ())}
            keep = {}
            for ref, fid in m.items():
                ref, fid = str(ref), str(fid)
                # 🔴 An assignment to a folder that no longer exists is not an error and is not
                # kept: deleting a folder returns its members to unfiled, and that is the ONE
                # place this store is allowed to forget something. Dropping it here means a
                # delete never has to rewrite the assignment map, which is the whole reason
                # `delete()` is a two-line function instead of a migration.
                if ref and len(ref) <= MAX_REF_LEN and fid in known:
                    keep[ref] = fid
            if keep:
                assign[scope] = dict(list(keep.items())[:MAX_ASSIGN_PER_SCOPE])
    return {"folders": folders, "assign": assign}


def load(install_root, *, strict: bool = False) -> dict:
    """The whole document, `{"folders": {...}, "assign": {...}}`.

    Non-strict on purpose for readers, the way `ui_state.load` and `clip_favorites.load` are: a
    parse error in a convenience store degrades to "no folders" rather than breaking the tab.

    🔴 `VaultAuthError` IS A `BaseException` AND SAILS THROUGH `except Exception` — deliberately. A
    wrong key is not a corrupt file, and it must stop loudly rather than present an empty library
    as the truth."""
    import yaml

    import vault_fs
    p = path_for(install_root)
    if not vault_fs.exists(p):
        return _blank()                          # absent ≠ corrupt, even when strict
    try:
        data = yaml.safe_load(vault_fs.read_text(p))
    except Exception as e:                       # noqa: BLE001 — VaultAuthError is NOT caught
        logger.warning(f"folders store unreadable ({type(e).__name__}) — treating as no folders")
        if strict:
            raise FoldersUnreadable(str(e)) from e
        return _blank()
    if data is None:
        return _blank()
    if not isinstance(data, dict):
        if strict:
            raise FoldersUnreadable(f"not a mapping ({type(data).__name__})")
        return _blank()
    # 🔴 THE WRITER'S DOOR HAS TO REFUSE A SCOPE THIS BUILD DOES NOT KNOW, OR TEN SCOPES SHARING
    # ONE FILE IS EXACTLY THE HAZARD IT WAS SUPPOSED TO AVOID.
    #
    # `_clean` DROPS an unknown scope's folders AND its assignments, silently — that is right for
    # a reader (degrade to "no folders" rather than break a tab) and catastrophic on the way back
    # to disk, because `_mutate` writes the cleaned document. So a single `✚ Folder` press in ANY
    # scope permanently erased every folder belonging to a scope this build had never heard of.
    # The abort in `_mutate` guards a file that will not PARSE; nothing guarded a file that parses
    # fine and says more than we understand.
    #
    # Reachable two ways, both ordinary: rolling back to a build with a shorter `SCOPES` while a
    # newer one's folders are on disk, and renaming a scope in a future release. Readers are
    # untouched — they still degrade — so this only ever refuses a WRITE, which is the one
    # operation that can destroy the data.
    if strict:
        raw_f = data.get("folders") if isinstance(data.get("folders"), dict) else {}
        raw_a = data.get("assign") if isinstance(data.get("assign"), dict) else {}
        unknown = sorted((set(raw_f) | set(raw_a)) - set(SCOPES))
        if unknown:
            raise FoldersUnreadable(
                f"holds lists this build does not know ({', '.join(unknown)}) — refusing to "
                f"write, because saving would erase them"
            )
    return _clean(data)


def save(install_root, doc) -> dict:
    """Persist the whole document. Returns what was stored.

    🔴 `vault_fs.write_yaml_atomic`, never a bare `yaml.dump` — see the module docstring. Callers
    inside this module do NOT use this (they write inline under `_MU`); it is here for tests and
    for a caller that already holds a complete document."""
    import vault_fs
    clean = _clean(doc)
    with _MU:
        vault_fs.write_yaml_atomic(path_for(install_root), clean, sort_keys=False)
    return clean


def _mutate(install_root, fn):
    """Read-modify-write the whole store under `_MU`, aborting if it could not be read, and
    writing ONLY if `fn` actually changed something.

    🔴 THE ABORT IS THE POINT. Ten scopes share this file, so writing after a failed read would
    take every other scope's folders with it. `stems._record` refuses the same way and for the same
    reason: a store you could not parse is not a store you may overwrite.

    🔴 AND THE NO-OP WRITE IS NOT TIDINESS — IT IS THE COMMON PATH. `rekey()` is called from a
    rename route on EVERY rename, and almost every renamed row is unfiled, so an unconditional
    write meant the ordinary case paid a full whole-file rewrite of a ten-scope store for nothing —
    and, worse, CREATED `folders.yaml` on an install that had never used a folder. `delete()` on an
    unknown id and `assign()` re-filing a row into the folder it is already in had the same shape.

    ⚠️ DECIDED BY COMPARISON, NEVER BY A FLAG FROM `fn`. A `changed` boolean returned by each
    mutator is a claim, and a mutator that edits the document while returning False loses the write
    silently — the failure mode is invisible and permanent. A comparison cannot be wrong, and a
    future mutator gets the behavior without knowing this rule exists. The compare is a small dict
    against a small dict; the write it skips is a YAML dump, an encrypt and an fsync.

    ⚠️ `fn` runs INSIDE the lock and must not call any other function in this module."""
    import copy

    import vault_fs
    with _MU:
        try:
            doc = load(install_root, strict=True)
        except FoldersUnreadable:
            logger.warning("folders store unreadable — NOT overwriting it (every other scope's "
                           "folders are still in there); this change is dropped")
            raise
        before = copy.deepcopy(doc)              # `load` already returned it cleaned
        out = fn(doc)
        after = _clean(doc)
        if after != before:
            vault_fs.write_yaml_atomic(path_for(install_root), after, sort_keys=False)
    return out


def _check_scope(scope: str) -> str:
    if scope not in SCOPES:
        raise ValueError(f"unknown scope: {scope!r}")
    return scope


def _norm_name(name) -> str:
    n = " ".join(str(name or "").split())        # collapse whitespace; a label has no newlines
    if not n:
        raise ValueError("a folder needs a name")
    return n[:MAX_NAME_LEN]


# ── folders ──────────────────────────────────────────────────────────────────────────────

def list_folders(install_root, scope: str) -> list:
    """This scope's folders, in NAME order — Explorer's order, and the one the UI renders.

    📌 Sorted here rather than in the client so all three panels over one dataset agree without
    three comparators. Case-insensitive so `demos` and `Demos` do not straddle `Keepers`."""
    return listing(install_root, scope)["folders"]


def listing(install_root, scope: str) -> dict:
    """`{"folders": [...name-ordered...], "assign": {ref: folder_id}}`, from ONE read.

    🔴 THE ASSIGNMENT MAP IS HERE FOR THE PANELS WHOSE REF THE SERVER CANNOT COMPUTE, and for
    nothing else. `for_rows` is still how a listing learns its folders, and it is still the only
    honest answer wherever the server holds the rows — it stamps only what it was handed, so a
    stale entry is invisible. But Voice Swap ▸ Sources is one panel over FIVE stores, and four of
    them reach it under a ref the CLIENT composes (`stems/…`, `speech/…`, `pg/…`); no route sees
    that string, so no route can stamp it. Those rows are filed under the composed ref and have to
    be read back under it, which needs the map itself.

    ⚠️ THIS IS NOT A SECOND OPINION ABOUT IDENTITY — it is the SAME opinion. The client sends the
    composed ref to `assign` and looks it up under the composed ref; nothing here re-derives what
    a row is. A panel whose rows the server DOES key must keep using `for_rows`; see
    `webui/js/media/voiceswap.js::vsSources`, which does both and says which is which per store.

    📌 Bounded by `MAX_ASSIGN_PER_SCOPE` (20 000 refs × ≤256 bytes), so the worst case is a few
    megabytes and the real case is a few hundred bytes."""
    _check_scope(scope)
    doc = load(install_root)
    rows = sorted(doc["folders"].get(scope, []), key=lambda r: r["name"].lower())
    return {"folders": rows, "assign": dict(doc["assign"].get(scope) or {})}


def create(install_root, scope: str, name: str) -> dict:
    """Make a folder. Returns `{"id", "name"}`. Raises `ValueError` on a bad or duplicate name."""
    _check_scope(scope)
    want = _norm_name(name)

    def go(doc):
        rows = doc["folders"].setdefault(scope, [])
        if any(r["name"].lower() == want.lower() for r in rows):
            raise ValueError(f"a folder called “{want}” already exists here")
        if len(rows) >= MAX_FOLDERS_PER_SCOPE:
            raise ValueError(f"at most {MAX_FOLDERS_PER_SCOPE} folders per list")
        # 🔴 AN ID, NOT THE NAME, IS WHAT AN ASSIGNMENT REFERENCES. Keying members on the name
        # would make a rename a rewrite of every one of its assignments — and a half-failed
        # rename would scatter its members back to unfiled. With an id a rename is one string.
        taken = {r["id"] for rr in doc["folders"].values() for r in rr}
        while True:
            fid = "f_" + secrets.token_hex(4)
            if fid not in taken:
                break
        row = {"id": fid, "name": want}
        rows.append(row)
        return dict(row)

    return _mutate(install_root, go)


def rename(install_root, scope: str, fid: str, name: str) -> dict:
    """Rename a folder. Returns `{"id", "name"}`; raises `ValueError` on a bad/duplicate name or an
    unknown id.

    📌 ONE STRING WRITE, AND NO MEMBER MOVES — which is the entire payoff of keying on the id."""
    _check_scope(scope)
    want = _norm_name(name)

    def go(doc):
        rows = doc["folders"].get(scope) or []
        hit = next((r for r in rows if r["id"] == fid), None)
        if hit is None:
            raise ValueError("no such folder")
        if any(r["name"].lower() == want.lower() and r["id"] != fid for r in rows):
            raise ValueError(f"a folder called “{want}” already exists here")
        hit["name"] = want
        return dict(hit)

    return _mutate(install_root, go)


def delete(install_root, scope: str, fid: str) -> bool:
    """Remove a folder. Its members return to UNFILED — nothing is deleted but the label.

    🔴 THE CONFIRM DIALOG MUST SAY SO IN THOSE WORDS. *"Delete folder 'Keepers' (12 items)?"* reads
    as delete-all to anyone who has used any other program, and this store cannot delete an item
    even if it wanted to — it holds no path.

    📌 The assignment map is not touched here. `_clean` drops rows pointing at a folder that no
    longer exists, so the members are unfiled by the same pass that persists this."""
    _check_scope(scope)

    def go(doc):
        rows = doc["folders"].get(scope) or []
        keep = [r for r in rows if r["id"] != fid]
        if len(keep) == len(rows):
            return False
        doc["folders"][scope] = keep
        return True

    return _mutate(install_root, go)


# ── membership ───────────────────────────────────────────────────────────────────────────

def assign(install_root, scope: str, refs, fid) -> int:
    """Assign refs to a folder or unassign them when fid is None or empty. Return the number moved. Unknown refs are accepted because this store does not read the underlying listings; stale assignments are ignored by for_rows."""
    _check_scope(scope)
    want = [str(r) for r in (refs or []) if str(r)]
    # 🔴 REFUSE LOUDLY; NEVER FILTER QUIETLY. Silently dropping an over-long ref and returning a
    # smaller `moved` is a partial success the caller cannot tell from a whole one — it learns
    # that two of its three rows moved, and nothing about which was refused or why. The other
    # bound on this same request (`MAX_REFS_PER_CALL`, at the route) is a 400, and two limits on
    # one call must not disagree about how they fail.
    if any(len(r) > MAX_REF_LEN for r in want):
        raise ValueError(f"a ref is at most {MAX_REF_LEN} characters")
    if not want:
        return 0

    def go(doc):
        m = doc["assign"].setdefault(scope, {})
        if not fid:
            return len([r for r in want if m.pop(r, None) is not None])
        known = {f["id"] for f in doc["folders"].get(scope, ())}
        if fid not in known:
            raise ValueError("no such folder")
        moved = 0
        for r in want:
            if m.get(r) != fid:
                if len(m) >= MAX_ASSIGN_PER_SCOPE and r not in m:
                    raise ValueError(f"at most {MAX_ASSIGN_PER_SCOPE} filed items per list")
                m[r] = fid
                moved += 1
        return moved

    return _mutate(install_root, go)


def rekey(install_root, scope: str, old_ref: str, new_ref: str) -> bool:
    """Carry one row's folder across a rename that MOVED its ref. True if an entry actually moved.

    🔴 FOUR SCOPES NEED THIS, AND THIS PARAGRAPH SAID TWO UNTIL IT WAS CHECKED.

      * `scenes` — `scene_stem()` is `safe_name(title) + '_' + h[:8]`, so the slug IS the display
        name and `rename_scene()` returns a new ref for the same audio.
      * `playground_clips` — identical shape. `playground_clips.rename_clip()` rebuilds the stem
        from `safe_name(new_name)` and RETURNS a new `vdir/stem`.
      * `train_sources` — `voicetrain.rename_source()` is "a pure, atomic file rename", and an
        upload's ref simply IS its filename.
      * `voices_rvc` — `rename_voice()` renames weight, index and provenance sidecar together, so
        the key IS the filename here too.

    ⚠️ THE FIRST DRAFT OF THIS LIST NAMED ONLY TWO, calling a playground ref "identity-keyed" and
    an upload's "its filename" as though neither moved. Both move. That was not a typo — it was the
    same wrong analysis that had already cost the star: `clip_favorites.rekey` shipped with the
    identical paragraph, the scene half was fixed on the strength of it, and a later reader
    checking whether the playground half needed the same call found a docstring saying no. **A
    comment that certifies something as safe is load-bearing, and the cost of getting it wrong is
    that the next person stops looking.** Re-derived from `rename_clip` and `rename_source`
    directly rather than from the neighboring store's prose.

    📌 PREFER STABLE KEYING WHERE A REF HAS AN IMMUTABLE PART. `scenes` and `playground_clips` both
    carry a terminal H8 plus an `_enhanced` marker, so keying on `(h8, enhanced)` makes them immune
    BY CONSTRUCTION and no hook can be forgotten. `train_sources` and `voices_rvc` have no such
    part and must use the hook, which is a standing obligation that fails silently — see below.

    ⚠️ PREFER STABLE KEYING OVER CALLING THIS. Where a ref has an immutable component, key on that
    and the scope is immune BY CONSTRUCTION — nothing can forget to call anything. Scenes qualify
    (`(h8, enhanced)`), which is why they are keyed that way and this is the fallback for the one
    scope with no immutable component. A hook is a standing obligation and forgetting it is silent.

    ⚠️ A row that was never filed moves nothing — this must never manufacture an assignment."""
    _check_scope(scope)
    if not old_ref or not new_ref or old_ref == new_ref:
        return False
    if len(new_ref) > MAX_REF_LEN:
        return False

    def go(doc):
        m = doc["assign"].get(scope) or {}
        fid = m.get(old_ref)
        if fid is None:
            return False                          # not filed — there is nothing to carry
        del m[old_ref]
        m[new_ref] = fid
        doc["assign"][scope] = m
        return True

    try:
        return _mutate(install_root, go)
    except FoldersUnreadable:
        # The rename on disk has ALREADY happened. Losing the label degrades to the bug this
        # function exists to prevent, which is survivable; reporting a completed rename as failed
        # because a convenience store would not parse is not.
        return False


def for_rows(install_root, scope: str, rows: list, ref_key: str = "ref") -> list:
    """Stamp `folder` (the folder id, or None) onto each row of a listing. Returns `rows`.

    Read once per listing rather than per row — this is on the path of every open of the tab.

    📌 THE ONLY READER, WHICH IS WHAT MAKES A STALE ASSIGNMENT HARMLESS: it stamps rows it was
    handed and never resurrects one, so an entry naming a deleted item is invisible."""
    _check_scope(scope)
    m = load(install_root)["assign"].get(scope) or {}
    for r in rows:
        # ⚠️ `str(row.get(k))` ALONE WOULD LOOK UP THE LITERAL STRING "None" for a row missing its
        # ref column — harmless until some listing produces a ref that really is `"None"`, and
        # then it misfiles by coincidence. Absent means unfiled, explicitly.
        ref = r.get(ref_key)
        r["folder"] = m.get(str(ref)) if ref is not None else None
    return rows


def counts(install_root, scope: str, rows: list, ref_key: str = "ref") -> dict:
    """`{folder_id: how many of THESE rows are in it}`.

    🔴 COUNTED FROM THE LISTING, NEVER FROM THE ASSIGNMENT MAP. The map holds stale entries by
    design, so a count taken from it would show `(12)` on a folder with four surviving items — a
    number that is wrong in the one direction that makes someone go looking for what is missing."""
    _check_scope(scope)
    m = load(install_root)["assign"].get(scope) or {}
    out = {}
    for r in rows:
        ref = r.get(ref_key)                     # see `for_rows` — absent means unfiled
        fid = m.get(str(ref)) if ref is not None else None
        if fid:
            out[fid] = out.get(fid, 0) + 1
    return out
