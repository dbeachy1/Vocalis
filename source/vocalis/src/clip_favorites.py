"""Persistent favorites for Clips rows. Store entries by (kind, ref) through the vault-routed YAML layer; stale references are filtered when rows are listed."""
from __future__ import annotations

import threading
from pathlib import Path

from loguru import logger

FILENAME = "clip_favorites.yaml"

# Read the prior filename as a fallback so favorites saved by earlier releases remain visible.
LEGACY_FILENAME = "clip_favourites.yaml"

# A ceiling on a list that grows one click at a time. Far past any real use — it exists so a
# stuck client cannot fill the vault file, not because 5,000 favorites is a limit anyone meets.
MAX_FAVORITES = 5000

# 🔴 `toggle` is a read-modify-write of a WHOLE-FILE store, and the server is threaded
# (`make_server(..., threaded=True)`), so two stars clicked at once land on two threads.
#
# Without this lock: (a) both read the same set, both write their own superset, and the second
# write silently loses the first star while both tabs show it as set; (b) worse, both reach the
# writer, whose temp path is a FIXED `<dest>.part` on both arms (`vault_fs.write_yaml_atomic`,
# and `vault.open_write()` inside the vault) — so the two writers interleave in one temp file and
# one `atomic_replace` then finds it already gone. Outside a vault that yields unparseable YAML,
# which `load()` swallows as "nothing is favorited", losing every star. INSIDE a vault it yields
# a file that is a mix of two ciphertexts, and every later read raises `VaultAuthError` — which
# is a `BaseException` and deliberately NOT caught by `load()`, so the whole Clips tab dies and
# this project's own doctrine forbids repairing or deleting the file to get it back.
#
# One process is the only writer, so a module lock is the whole fix.
_MU = threading.Lock()


def path_for(install_root) -> Path:
    return Path(install_root) / FILENAME


def legacy_path_for(install_root) -> Path:
    """The 6.2-9.7 name. Read-only: nothing writes here again."""
    return Path(install_root) / LEGACY_FILENAME


def key(kind: str, ref: str) -> str:
    """`scene|ferry_ab12cd34`. One string, because YAML keys are strings and a tuple round-trips
    as a list — which then compares unequal to the tuple it came from, silently."""
    return f"{kind}|{ref}"


def load(install_root) -> set:
    """The favorited keys. `set()` when there is no file yet or it will not parse.

    Non-strict on purpose, the same way `ui_state.load` is: a parse error in a CONVENIENCE store
    degrades to "nothing is favorited" rather than breaking the tab. But `VaultAuthError` is a
    `BaseException` and sails straight through `except Exception` — a wrong key is not a corrupt
    file, and it must stop loudly.
    """
    import yaml

    import vault_fs
    p = path_for(install_root)
    if not vault_fs.exists(p):
        # 9.8: fall back to the pre-sweep name once. Not a copy — `save()` writes the new name,
        # so the first toggle after the upgrade migrates the whole set in one atomic write.
        legacy = legacy_path_for(install_root)
        if not vault_fs.exists(legacy):
            return set()
        logger.info(f"clip favorites: reading the pre-9.8 {LEGACY_FILENAME}")
        p = legacy
    try:
        data = yaml.safe_load(vault_fs.read_text(p))
    except Exception:                          # noqa: BLE001 — VaultAuthError is NOT caught
        logger.warning(f"clip favorites unreadable, starting from none: {p}")
        return set()
    if not isinstance(data, list):
        return set()
    return {str(k) for k in data if isinstance(k, (str, int)) and str(k)}


def save(install_root, keys) -> list:
    """Persist the whole set, sorted. Returns what was stored.

    🔴 `vault_fs.write_yaml_atomic`, never a bare `yaml.dump`. On a box with no vault this is a
    plain atomic write; inside a vault it is encrypted, and a missed WRITE here is SILENT — a
    plaintext file listing the names of every favorite scene, sitting in the encrypted store,
    looking perfect forever.
    """
    import vault_fs
    clean = sorted({str(k) for k in keys if str(k)})[:MAX_FAVORITES]
    with _MU:
        vault_fs.write_yaml_atomic(path_for(install_root), clean, sort_keys=False)
    return clean


def toggle(install_root, kind: str, ref: str) -> bool:
    """Star or un-star one row. Returns whether it is NOW a favorite.

    🔴 The whole read-modify-write is under `_MU` — see its comment. `save()` takes the same lock,
    which is why it is `RLock`-free by construction: the write below is done inline rather than
    through `save()` so there is exactly one acquisition and no re-entry.
    """
    k = key(kind, ref)
    with _MU:
        keys = load(install_root)
        on = k not in keys
        if on:
            if len(keys) >= MAX_FAVORITES:
                raise ValueError(f"at most {MAX_FAVORITES} favorites")
            keys.add(k)
        else:
            keys.discard(k)
        import vault_fs
        clean = sorted({str(x) for x in keys if str(x)})[:MAX_FAVORITES]
        vault_fs.write_yaml_atomic(path_for(install_root), clean, sort_keys=False)
    return on


def rekey(install_root, kind: str, old_ref: str, new_ref: str) -> bool:
    """Carry one row's star across a rename that MOVED its ref. True if an entry actually moved.

    🔴 A SCENE'S REF IS NOT STABLE, AND THIS STORE KEYS ON THE WHOLE REF. `scenes.scene_stem()` is
    `safe_name(title) + '_' + h[:8]`, so `rename_scene` moves both files and returns a NEW ref for
    the same audio — the H8 survives, the slug does not. Without this call the entry is left naming
    a row that no longer exists, `for_rows` drops it on the next read, and the star vanishes with no
    error at all. The only tell is that it was there a moment ago.

    ⚠️ THIS IS NOT THE STALE-ENTRY CASE THE MODULE DOCSTRING DESCRIBES, and `for_rows`' filtering is
    not a fix for it. A DELETED scene SHOULD lose its star — that is exactly why nothing cascades on
    delete. A RENAMED one is the same row wearing a new name and must keep it.

    🔴 IT IS ALL THREE KINDS, AND THIS PARAGRAPH USED TO SAY OTHERWISE. It claimed a playground
    ref was "identity-keyed" and that an upload's "is its filename", as though neither moved on a
    rename. Both move, for exactly the reason a scene's does: `playground_clips.rename_clip`
    rebuilds the stem from `safe_name(new_name)` and RETURNS a new `vdir/stem`, and
    `voicetrain.rename_source` renames the very file whose name IS the ref. All three kinds are
    starrable — `/clips/favorite` accepts every member of `clip_sources.KINDS` — so all three
    rename routes call this now.

    ⚠️ AND THE WRONG PARAGRAPH IS WHY IT STAYED BROKEN. 8.8.3 found this bug, fixed the scene half,
    and wrote a docstring certifying the other two safe; a reader checking whether the playground
    route needed the call found an authoritative "no" and stopped. A comment that answers a
    question wrongly is worse than no comment, because it ends the search.

    A row that was never starred moves nothing — this must never manufacture a favorite.
    """
    if not old_ref or not new_ref or old_ref == new_ref:
        return False
    old_k, new_k = key(kind, old_ref), key(kind, new_ref)
    with _MU:
        keys = load(install_root)
        if old_k not in keys:
            return False                        # not starred — there is nothing to carry
        keys.discard(old_k)
        keys.add(new_k)
        import vault_fs
        # One out, one in, so the count cannot grow and MAX_FAVORITES cannot bite here.
        clean = sorted({str(x) for x in keys if str(x)})[:MAX_FAVORITES]
        try:
            vault_fs.write_yaml_atomic(path_for(install_root), clean, sort_keys=False)
        except OSError as e:
            # The files have ALREADY moved on disk. Losing the star degrades to exactly the bug
            # this function exists to fix, which is survivable; reporting a completed rename as
            # failed because a convenience store would not write is not.
            logger.warning(f"clip favorites unwritable ({type(e).__name__}) — star not carried "
                           f"across the rename of {old_ref!r}")
            return False
    return True


def for_rows(install_root, rows: list) -> list:
    """Stamp `favorite` onto each row of a `clip_sources.list_items()` listing.

    Read once per listing rather than per row: the tab lists three stores at once and this is on
    the path of every open of it.
    """
    keys = load(install_root)
    for r in rows:
        r["favorite"] = key(r.get("kind"), r.get("ref")) in keys
    return rows
