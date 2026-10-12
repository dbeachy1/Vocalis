"""Route filesystem operations through the vault when a path belongs to an encrypted store, otherwise preserve ordinary pathlib behavior. Apply routing to every read, write, listing, rename, and delete. A missed read fails loudly; a missed write can expose plaintext. Do not catch vault authentication errors here. Paths outside owned stores, scratch, and logs use the documented plain-filesystem behavior."""
from __future__ import annotations

import contextlib
import fnmatch
import json
import shutil
from pathlib import Path
from typing import NamedTuple


class Stat(NamedTuple):
    size: int      # 🔴 the PLAINTEXT size, derived in O(1). NEVER the size on disk.
    mtime: float   # the real filesystem mtime — clear_cache is implemented as nothing BUT an
                   # os.utime, so this has to be a number that actually moves (vault.Vault.stat)


def _r(p):
    """The router. DEFERRED, and it must be: `vault` does `from tts_utils import
    atomic_replace`, so a module-level `import vault_store` in anything tts_utils imports is a
    circular import. Deferring here means this module is safe to import from ANYWHERE, which
    is the only way it can be the one place the branch is written."""
    import vault_store
    return vault_store.route(p)


def locked_exc():
    """The `VaultLocked` class, for callers that must TOLERATE a locked vault rather than
    fail — `except vault_fs.locked_exc():`.

    Deferred for the same reason `_r` is, and it returns `()` (which matches nothing) when
    vault is unimportable: the pure-library tests drive these readers with a bare tmp_path and
    no vault at all, and must keep raising normally.

    🔴 IT LIVES HERE BECAUSE IT HAS MORE THAN ONE CALLER, and the callers are exactly the
    modules that read a store file BEFORE anything has unlocked — nomi_speak and st_characters,
    both of which read voice_settings.yaml from a constructor that runs at import time. Each
    had grown its own private copy of this; the second one was written by copying the first,
    which is how a five-line import guard becomes a thing you have to fix twice.
    """
    try:
        from vault import VaultLocked
        return VaultLocked
    except Exception:                                         # noqa: BLE001
        return ()


def auth_exc():
    """Return the `VaultAuthError` class for thread entry points that must handle it explicitly. Do not use this as permission to swallow authentication failures in ordinary code; the exception remains outside `Exception`. The deferred import avoids a circular dependency, and an unavailable vault module returns an empty exception tuple for pure-library use."""
    try:
        from vault import VaultAuthError
        return VaultAuthError
    except Exception:                                         # noqa: BLE001
        return ()


# ── existence & shape ────────────────────────────────────────────────────────

def exists(p) -> bool:
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.exists(logical)
    return Path(p).exists()


def is_dir(p) -> bool:
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.is_dir(logical)
    return Path(p).is_dir()


def stat(p):
    """`Stat(size, mtime)`, or None if it is not there. **The size is the PLAINTEXT size.**

    Absent is not an error here: every caller already wrapped `p.stat()` in a try, because a
    library listing races the delete button.

    🔴 Use this anywhere a size or an mtime is SHOWN or SORTED. `tts_utils.source_stat` is the
    identity seam and int()s the mtime for use in a cache KEY — right there, wrong for a
    sort, which needs the sub-second float it started with. Both read the vault's logical stat;
    they differ only in what they round."""
    r = _r(p)
    if r is not None:
        v, logical = r
        try:
            st = v.stat(logical)
        except OSError:
            return None
        return Stat(int(st.size), float(st.mtime))
    try:
        st = Path(p).stat()
    except OSError:
        return None
    return Stat(int(st.st_size), float(st.st_mtime))


def utime(p, times=None, *, ns=None) -> None:
    """Bump (or set) a file's mtime. `os.utime`, routed.

    🔴 IT IS HERE BECAUSE `clear_cache` IS IMPLEMENTED AS NOTHING BUT AN os.utime, and that
    is not an implementation detail — it is the whole mechanism. The Nomi/SillyTavern render
    cache keys on the voice file's mtime, so bumping it re-keys every cached render at once;
    there is no way to enumerate the one-way hashes and no need to. Unrouted, the bump lands
    on a path that is not on disk, `/voices/<name>/clear_cache` raises FileNotFoundError, and
    every stale render survives a button whose entire job was to invalidate them.

    `vault.Vault.stat` already promises the mtime is the PHYSICAL file's for exactly this
    reason — "a header-stored mtime would go stale and silently break all three." This is the
    write end of that promise."""
    r = _r(p)
    if r is not None:
        v, logical = r
        v.utime(logical, times, ns=ns)
        return
    import os
    os.utime(Path(p), times, ns=ns) if ns is not None else os.utime(Path(p), times)


def listdir(p) -> list:
    """LOGICAL child names, sorted. `[]` for a directory that is not there — which is what
    every caller's `if not root.exists(): return []` already wanted.

    In the vault this decrypts each entry name and opens ZERO files, which is why no persistent
    name index is needed (SPEC_5_0_M1 §9.2): the filesystem is the index, and it cannot go
    stale the way a second copy of the truth can."""
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.listdir(logical)
    d = Path(p)
    if not d.is_dir():
        return []
    return sorted(e.name for e in d.iterdir())


def glob(p, pattern: str) -> list:
    """Names in `p` matching `pattern`. NOT paths — names, because that is the only thing a
    vault directory can hand back without lying about where the bytes are.

    This is what every `d.glob("*_{h8}.mp3")` in the sweep becomes. The sweep said those "die"
    under encryption; they do not, because listdir returns LOGICAL names and fnmatch works on
    them exactly as before."""
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.glob(logical, pattern)
    d = Path(p)
    if not d.is_dir():
        return []
    return sorted(e.name for e in d.iterdir() if fnmatch.fnmatch(e.name, pattern))


def rglob(p, pattern: str) -> list:
    """`Path.rglob`'s replacement: matching descendants of `p`, at any depth, as LOGICAL paths.

    Unlike `glob` this returns paths rather than names, because a name alone cannot say which
    subdirectory a match came from — and a logical path is exactly what every other function in
    this module accepts, so `unlink(x)` / `rename(x, y)` on a result just works.

    🔴 THE REASON THIS EXISTS. `Path.rglob` matches the pattern against the names ON DISK, and
    in a vault those are ciphertext — `OUTPUT_DIR.rglob("*.regenbak")` matched NOTHING on an
    encrypted install, no matter how many backups were sitting there. A sweep built on it
    reports a clean tree forever, which is the most dangerous way for a sweep to fail. There is
    no bare-Path fallback shortcut here: the unencrypted branch walks the same way so both
    branches return the same shape, in the same order.
    """
    out, stack = [], [Path(p)]
    while stack:
        d = stack.pop()
        for name in listdir(d):
            child = d / name
            if is_dir(child):
                stack.append(child)
            elif fnmatch.fnmatch(name, pattern):
                out.append(child)
    return sorted(out)


# ── reads ────────────────────────────────────────────────────────────────────

def read_bytes(p) -> bytes:
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.read_bytes(logical)
    return Path(p).read_bytes()


def read_text(p, encoding: str = "utf-8") -> str:
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.read_text(logical)
    return Path(p).read_text(encoding=encoding)


def open_read(p):
    """A SEEKABLE, LAZY reader. The vault decrypts only the blocks a read actually touches, so
    `sf.info()` on a 30 MB chapter WAV still costs one 64 KiB block, and an HTTP Range is O(the
    range) rather than O(the file)."""
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.open_read(logical)
    return open(Path(p), "rb")


# ── writes ───────────────────────────────────────────────────────────────────
#
# 🔴 THE SILENT HALF. Everything below must be routed at every call site, because getting it
# wrong writes CLEARTEXT INTO THE VAULT and raises nothing. tests/test_m6_e2e.py's grep is the
# only thing in the project that can catch it.

def write_bytes(p, data: bytes) -> None:
    r = _r(p)
    if r is not None:
        v, logical = r
        v.write_bytes(logical, data)
        return
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


def write_text(p, s: str, encoding: str = "utf-8") -> None:
    r = _r(p)
    if r is not None:
        v, logical = r
        v.write_text(logical, s)
        return
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding=encoding)


def write_yaml_atomic(p, obj, *, sort_keys: bool = False) -> None:
    """Persist YAML atomically both inside and outside the vault. Use a .part file plus replacement on the plain filesystem and the vault writer’s atomic replacement when routed. Preserve sort_keys so existing files are not reformatted unnecessarily."""
    import yaml
    from tts_utils import atomic_replace, part_path
    s = yaml.safe_dump(obj, sort_keys=sort_keys, allow_unicode=True)
    r = _r(p)
    if r is not None:
        v, logical = r
        v.write_text(logical, s)        # not write_yaml(): it hardcodes sort_keys=False
        return
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = part_path(p)                  # UNIQUE per writer — a shared temp interleaves, see part_path
    tmp.write_text(s, encoding="utf-8")
    atomic_replace(tmp, p)


def write_json_atomic(p, obj, *, indent: int | None = None) -> None:
    """Persist JSON atomically on both filesystem paths. Outside the vault, use a temporary sibling and atomic replacement; inside it, use the vault writer. Keep indentation optional for human-readable files."""
    from tts_utils import atomic_replace, part_path
    s = json.dumps(obj, indent=indent, ensure_ascii=False)
    # Encode before touching the filesystem so invalid text fails without leaving partial output.
    #
    # `ensure_ascii=False` means `json.dumps` happily returns a `str` holding a lone surrogate —
    # `"\ud800"` round-trips through `json.loads` and is not representable in UTF-8. The encode
    # then failed further down, INSIDE the write: after `mkdir`, after the `.part` had been
    # created, and (on the vault arm) after the writer was open. Every one of those left an
    # orphan directory and a stray `.part` behind, and the caller saw a bare 500.
    #
    # ⚠️ THE FIX IS HERE RATHER THAN AT THE ROUTES, AND THAT IS THE POINT. The review found this
    # on the import path; measuring the rest turned up `/edit`, `/entry`, `/rename` and
    # `PUT /draft` doing exactly the same thing. Guarding five routes would have been the
    # one-chokepoint-two-doors failure this whole batch is about — every writer goes through
    # here, so here is where "if it cannot be written, nothing is created" belongs.
    #
    # `UnicodeEncodeError` is a `ValueError`, so callers that already narrow on `ValueError` keep
    # working and the blueprint errorhandler renders it as a 400 rather than a 500.
    data = s.encode("utf-8")
    r = _r(p)
    if r is not None:
        v, logical = r
        v.write_text(logical, s)        # the vault's own .part + atomic_replace on close
        return
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = part_path(p)                  # UNIQUE per writer — a shared temp interleaves, see part_path
    tmp.write_bytes(data)               # already encoded above; do not re-encode and re-risk it
    atomic_replace(tmp, p)


# ── tree ─────────────────────────────────────────────────────────────────────

def mkdir(p) -> None:
    r = _r(p)
    if r is not None:
        v, logical = r
        v.mkdir(logical)
        return
    Path(p).mkdir(parents=True, exist_ok=True)


def unlink(p, missing_ok: bool = False) -> None:
    r = _r(p)
    if r is not None:
        v, logical = r
        v.unlink(logical, missing_ok=missing_ok)
        return
    Path(p).unlink(missing_ok=missing_ok)


def rename(src, dst) -> None:
    """Both sides route, and they must route the SAME WAY. A rename that crossed the vault
    boundary would be a decrypt-and-copy, not a rename — so it is refused rather than silently
    written in cleartext (or silently encrypted) at the far end. Nothing in this app renames
    across a store boundary; if something ever does, it will say so here instead of leaking."""
    rs, rd = _r(src), _r(dst)
    if (rs is None) != (rd is None):
        raise ValueError(f"rename crosses the vault boundary: {src} -> {dst}")
    if rs is not None:
        (vs, src_logical), (vd, dst_logical) = rs, rd
        if vs is not vd:
            raise ValueError(f"rename crosses two vaults: {src} -> {dst}")
        vs.rename(src_logical, dst_logical)
        return
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(src).rename(dst)


def rmtree(p) -> None:
    r = _r(p)
    if r is not None:
        v, logical = r
        v.rmtree(logical)
        return
    shutil.rmtree(Path(p), ignore_errors=True)


def rmdir_if_empty(p) -> None:
    """Prune a directory once its last child is gone. Never an error: a dir that is not empty,
    or not there, is simply left alone (the callers all wrap this in a try today)."""
    try:
        if exists(p) and not listdir(p):
            rmtree(p)
    except OSError:
        pass


# Child processes cannot read the vault. Materialize plaintext input under the owned scratch root, or pipe data when it need not be written at rest.

def to_scratch(p, scratch_dir):
    """Materialize vault-routed input for a child process and return its scratch path. Paths outside the vault are returned unchanged because they are already plaintext and may not be owned by the caller. Do not assume the returned path is safe to delete; use `child_input` when ownership must be tracked."""
    r = _r(p)
    if r is not None:
        v, logical = r
        return v.decrypt_to_scratch(logical, scratch_dir)
    return Path(p)


@contextlib.contextmanager
def child_input(p, scratch_dir):
    """Yield a plaintext path a child process can open, then delete it on exit only if this helper created it. Paths outside the vault are returned unchanged; deleting one unconditionally could remove a user file that Vocalis does not own."""
    src = to_scratch(p, scratch_dir)
    try:
        yield src
    finally:
        if Path(src) != Path(p):          # we decrypted it — so it is ours to remove
            Path(src).unlink(missing_ok=True)


def from_scratch(tmp, dst) -> None:
    """Move a child output into its destination, encrypting when the destination is vault-owned and using a cross-filesystem-safe atomic move otherwise. The scratch file is temporary and must not be exposed at the destination before the transfer completes."""
    from tts_utils import move_into_place
    r = _r(dst)
    if r is not None:
        v, logical = r
        v.encrypt_from_scratch(tmp, logical)
        Path(tmp).unlink(missing_ok=True)
        return
    move_into_place(tmp, dst)
