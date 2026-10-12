#!/usr/bin/env python3
"""Provide offline vault lifecycle commands; the server must not import this utility. Enable encryption only for an empty store, disable only when no encrypted data remains, and keep verification read-only. When migration helpers are invoked, retain plaintext originals until ciphertext has been written, synchronized, and verified; then remove the original."""

from __future__ import annotations

import argparse
import getpass
import os
import re
import shutil
import sys
from pathlib import Path

# Run as `python src/vault_migrate.py`: the script's own dir (src/) is sys.path[0], so `import
# vault` already works. Belt-and-braces for any other invocation, mirror vocalis_server.py:42.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import vault            # noqa: E402
import vault_store      # noqa: E402
# 🔴 7.0-m6 §7 — the READ-ONLY detection helpers moved to `vault_survey.py`, one definition for
# this CLI and for `POST /vault/init`, which used to check only `is_initialized()` and could
# therefore build exactly the brick `_enable` refuses. The aliases below keep this module's
# internal callers and the tests (`vault_migrate.iter_plaintext_files`,
# `vault_migrate.is_vault_internal`) meaning what they always meant. The MUTATING machinery
# stays HERE — vault_survey must never grow a write.
from vault_survey import (existing_plaintext_data, is_vault_internal,      # noqa: E402,F401
                          iter_plaintext_files)
from vault_survey import is_ciphertext as _is_ciphertext                   # noqa: E402
from vault_survey import iter_routed_physical as _iter_routed_physical    # noqa: E402
from vault_survey import physical_tops as _physical_tops                  # noqa: E402,F401


class MigrationError(Exception):
    """A file did not round-trip after encryption. The plaintext original is PRESERVED and the
    run stops — never delete on the strength of a write we could not verify."""


class Stats:
    def __init__(self) -> None:
        self.migrated = 0        # files freshly encrypted this run
        self.already = 0         # skipped: already ciphertext (a resume)
        self.bytes = 0           # plaintext bytes encrypted this run

    def __str__(self) -> str:
        mb = self.bytes / (1024 * 1024)
        return (f"{self.migrated} file(s) encrypted ({mb:.1f} MiB plaintext), "
                f"{self.already} already ciphertext")


def round_trips(v, logical, plaintext_path: Path) -> bool:
    """Decrypt the ciphertext and compare it, block by block, to the plaintext original. GCM has
    already authenticated the content; this proves it also DECODES to the exact bytes we started
    with before we delete the only plaintext copy."""
    with v.open_read(logical) as dec, open(plaintext_path, "rb") as orig:
        while True:
            a = dec.read(vault.BLOCK)
            b = orig.read(vault.BLOCK)
            if a != b:
                return False
            if not a:
                return True


def _fsync(path: Path, *, is_dir: bool = False) -> None:
    """Best-effort flush file and directory metadata before reporting a durable replacement. Skip directory fsync where the platform does not support it."""
    if is_dir and os.name != "posix":
        return
    try:
        fd = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def migrate_one(store, physical_path, *, stats: Stats) -> str:
    """Encrypt one plaintext file in place. Returns 'migrated' | 'already' | 'skipped'.

    🔴🔴 The two rules that govern the whole milestone live here: PRESERVE THE MTIME (§5), and
    VERIFY BEFORE DELETE (§4.1). Neither is optional and both are silent when wrong."""
    p = Path(physical_path)
    if is_vault_internal(p.name):
        return "skipped"
    r = store.logical_of(p)
    if r is None:
        return "skipped"
    v, logical = r

    st = os.stat(p)                              # capture mtime/atime BEFORE any read touches atime
    if _is_ciphertext(p):
        stats.already += 1
        return "already"

    if v._map(logical) == p:
        # 🔴 A STRUCTURAL NAME: THE SOURCE AND THE DESTINATION ARE THE SAME PATH. The plain
        # branch below cannot handle this and is not safe if it tries — it verifies by
        # RE-READING `p` (which is the ciphertext by then, so the check fails) and then
        # `os.unlink(p)`s "the plaintext original", which would DELETE THE CIPHERTEXT IT JUST
        # WROTE. Today it fails closed rather than destroying anything, because the verify
        # raises first; that is luck, not design, and this branch is the design.
        #
        # Reachable for real, not hypothetically: voice_settings.yaml and ui_state.yaml are
        # structural (their names must stay ignorable by git), and on an unmigrated box they
        # sit in plaintext at exactly the path their ciphertext has to land on.
        #
        # So the plaintext is snapshotted to THE SCRATCH — the one place plaintext may touch
        # disk (M3) — and that copy, not `p`, is both the encryption source and the thing the
        # round-trip is checked against. If the check fails the snapshot goes back to `p`, so
        # the promise the plain branch makes ("the plaintext original is PRESERVED") still
        # holds here.
        import scratch as scratch_mod
        with scratch_mod.file(scratch_mod.scratch_root(), f"premigrate|{logical}", ".bin") as tmp:
            shutil.copyfile(p, tmp)
            v.encrypt_from_scratch(str(tmp), logical)
            _fsync(p)
            _fsync(p.parent, is_dir=True)
            v.utime(logical, ns=(st.st_atime_ns, st.st_mtime_ns))
            if not round_trips(v, logical, tmp):
                shutil.copyfile(tmp, p)          # put the plaintext back before anyone panics
                raise MigrationError(
                    f"{logical}: the ciphertext did not decrypt back to the plaintext — the "
                    f"plaintext original has been RESTORED in place and the run has stopped. "
                    f"This is a bug, not a wrong key; nothing was deleted.")
        # No unlink: `p` already holds the ciphertext, and the plaintext copy was the scratch
        # file the context manager just removed.
        stats.migrated += 1
        stats.bytes += st.st_size
        return "migrated"

    v.encrypt_from_scratch(str(p), logical)      # plaintext at p → .part → atomic replace at SIV name
    dest = v._map(logical)                        # the physical ciphertext path — the migration is the
    _fsync(dest)                                  #   vault's intimate counterpart, so it reaches for it
    _fsync(dest.parent, is_dir=True)             # flush both: the plaintext is still the only good copy

    # 🔴🔴 restore the ORIGINAL mtime to the nanosecond — else every (size, mtime)-keyed cache
    # (enhance, bandwidth, durations, M4's song index, swap identity) silently re-derives (§5).
    v.utime(logical, ns=(st.st_atime_ns, st.st_mtime_ns))

    if not round_trips(v, logical, p):
        raise MigrationError(
            f"{logical}: the ciphertext did not decrypt back to the plaintext — the plaintext "
            f"original is PRESERVED and the run has stopped. This is a bug, not a wrong key; "
            f"nothing was deleted.")

    os.unlink(p)                                 # only now is the plaintext safe to drop
    stats.migrated += 1
    stats.bytes += st.st_size
    return "migrated"


def encrypt_tree(store, *, on_file=None) -> Stats:
    """Walk the snapshot and encrypt every plaintext file. Requires an UNLOCKED store."""
    stats = Stats()
    files = iter_plaintext_files(store)
    for p in files:
        result = migrate_one(store, p, stats=stats)
        if on_file is not None:
            on_file(p, result)
    _prune_empty_plaintext_dirs(store)
    return stats


def _prune_empty_plaintext_dirs(store) -> None:
    """Best-effort tidy: after the files move to their SIV siblings, the plaintext-named
    directories they lived in are empty. Remove empties bottom-up. A non-empty dir raises and is
    left alone, so this can never remove data; an expected-but-empty tree dir the app recreates
    on its next write."""
    for _name, root in store.roots:
        root = Path(root)
        if not root.exists():
            continue
        for d in sorted(root.rglob("*"), reverse=True):
            if d.is_dir():
                try:
                    d.rmdir()                    # only succeeds if empty
                except OSError:
                    pass


def _walk_logical(v, logical_dir=""):
    """Yield every logical file path under a vault, decrypting names as it descends.

    🔴 This is the ONLY correct way to read an encrypted store back. You cannot feed a physical
    SIV name to `logical_of` — that does path arithmetic, not decryption, and hands the SIV name
    straight back to `_map`, which re-encrypts it to a DIFFERENT path. And it is not only the
    loose files (voice_settings.yaml, song_ids.yaml …) whose NAME is SIV-encrypted: every
    variable path component is. `v.listdir` decrypts each entry and steps over the sentinel,
    companions and foreign plaintext for us."""
    for name in v.listdir(logical_dir):
        child = f"{logical_dir}/{name}" if logical_dir else name
        if v.is_dir(child):
            yield from _walk_logical(v, child)
        else:
            yield child


def _routed_tops(store, name) -> list[str]:
    """The top-level logical entries a root actually owns — its ROUTES trees + files.

    🔴 A VAULT ROOT IS NOT A VAULT. The install root IS the repo root: `.git/`, `src/`, `venv/`,
    `README.md`, thirty thousand files of which the vault owns six subtrees and two files. Walking
    from `""` hands every one of those to `listdir`, which cannot decrypt them (they are not SIV
    names) and logs each as "not ours and has been SKIPPED … foreign file, crash leftover, or
    TAMPERING". Enabling on a real install therefore produced a screenful of tampering alarms
    about README.md and venv — every one of them false, and loud enough to bury a true one.
    """
    r = vault_store.ROUTES.get(name, {})
    return [*r.get("trees", ()), *r.get("files", ())]


def verify_all(store, *, on_file=None) -> tuple[int, list[str]]:
    """Decrypt every encrypted file end-to-end (GCM authenticates the content; the sentinel
    already authenticated the key at unlock). Traverses each vault by LOGICAL name, starting at
    the ROUTED tops rather than the root — see `_routed_tops`. Changes nothing.
    Returns (checked, failures)."""
    checked, failures = 0, []
    for (name, _root), v in zip(store.roots, store.vaults()):
        logicals = []
        for top in _routed_tops(store, name):
            try:
                logicals.extend(_walk_logical(v, top) if v.is_dir(top) else [top] if v.exists(top) else [])
            except (OSError, FileNotFoundError):
                continue                              # a store this install has never written to
        for logical in logicals:
            checked += 1
            try:
                with v.open_read(logical) as fh:
                    while fh.read(vault.BLOCK):
                        pass
                if on_file is not None:
                    on_file(logical, "ok")
            except BaseException as exc:         # VaultAuthError is a BaseException — see it too
                failures.append(f"{logical}: {exc}")
                if on_file is not None:
                    on_file(logical, "FAILED")
    return checked, failures


def find_cleartext(store, *, allow=()) -> list[str]:
    """Grep the physical platter for recognizable plaintext — the ONLY instrument that catches a
    file the walk missed (a missed write is silent; SPEC §8). Header markers at offset 0, text
    markers anywhere. `allow` names the files that are cleartext BY DESIGN.

    🔴 SCOPED TO THE ROUTED PATHS by `_iter_routed_physical` — so the grep and the migration agree
    on what the store even IS. It used to `rglob("*")` the whole root, and the install root is the
    REPO root: it read all of `venv/`, `.git/`, `src/` and `docs/`, reported every Python file
    containing `text:` or `title:` as a leak, and took ~15 seconds and thousands of lines to do it.
    `_enable` treats a non-empty result as fatal, so a perfectly correct enable on a real install
    reported "🔴 UNEXPECTED state" and exited 1 — after the vault had already been created. Nothing
    outside a routed tree is ours to call a leak.

    🔴 AND THE SCOPE IS THE WHOLE ALLOW-LIST — there is deliberately no second `store.logical_of()`
    filter here. There used to be one, marked "belt and braces — the scope already excludes it",
    and on a MIGRATED store it was the blind spot itself: `logical_of` is path ARITHMETIC, so a
    file under a top whose name is SIV-encrypted (`trim_scores`, the cache `*.yaml`s — routed, but
    not structural) resolves to None and was skipped as "not ours". A planted plaintext leak under
    the encrypted `trim_scores` went unreported while a byte-identical one under `enhanced/` was
    caught. This function exists to see what the logical walk cannot; a logical filter on top of it
    can only subtract from that."""
    allow = set(allow) | {vault.SENTINEL_NAME, "vault_keys.yaml"}
    magic = (b"RIFF", b"ID3", b"\xff\xfb", b"PK\x03\x04")
    text = (b"favorite:", b"created:", b"text:", b"voice:", b"title:")
    hits = []
    for _name, root, p in _iter_routed_physical(store):
        if p.name in allow or is_vault_internal(p.name):
            continue
        blob = p.read_bytes()
        found = [m for m in magic if blob.startswith(m)]
        found += [m for m in text if m in blob]
        if found:
            hits.append(f"{p.relative_to(root)} contains {found}")
    return hits


def rollback_create(store, keyfile) -> None:
    """Undo a `create()` that the operator aborted before the walk began. An initialized box
    whose files are still plaintext is a BROKEN box — the live `route()` reads plaintext as
    ciphertext and fails — so if setup aborts, delete the keyfile + every sentinel to restore the
    clean, un-migrated 4.x state (`is_initialized()` → False → `route()` inert again). (§4)"""
    Path(keyfile).unlink(missing_ok=True)
    for _name, root in store.roots:
        (Path(root) / vault.SENTINEL_NAME).unlink(missing_ok=True)


def create_and_confirm(store, keyfile, password, confirm_fn) -> str | None:
    """Initialize the vault and make the operator prove they recorded the recovery key BEFORE a
    single file is encrypted. Returns the recovery key on success, or None if `confirm_fn` refused
    (in which case the half-initialized vault has been rolled back). `confirm_fn(recovery) -> bool`
    is injected so the interactive prompt can be stubbed in tests."""
    for _name, root in store.roots:              # Create each store root before writing its initialization sentinel; rollback or cache cleanup may have removed it.
        Path(root).mkdir(parents=True, exist_ok=True)   # cache_root() — create()'s sentinel write needs it
    recovery = store.create(password)            # writes keyfile + each root's sentinel; DEK in RAM
    if confirm_fn(recovery):
        return recovery
    rollback_create(store, keyfile)
    return None


# --------------------------------------------------------------------------- the interactive CLI

def _ask_yes(question: str) -> bool:
    return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")


def _show_roots(store, keyfile, env_path=None, env_applied=None) -> None:
    """Print the stores this run will operate on, BEFORE it operates on them.

    🔴 THIS EXISTS BECAUSE `cache_root()` IS KEYED ON $HOME, NOT ON THE INSTALL ROOT. A box
    running two Vocalis installs keeps them apart entirely through three `Environment=` lines in
    the systemd unit (VOCALIS_CACHE_DIR, VOCALIS_SCRATCH_DIR, VOCALIS_APPLIO_DIR) — and **a
    shell does not inherit those**. So running this tool from a plain SSH session in install B
    resolves the cache to install A's, and every message it prints afterward is about the wrong
    instance: "this store already holds 241 data files", naming files that belong to the OTHER
    Vocalis — whose own advice is then "CLEAR the data + cache", i.e. destroy a live install.

    Printing the resolved paths is what makes that visible in the one second before it matters.
    """
    if env_applied:
        print(f"\nLoaded {len(env_applied)} setting(s) from {env_path}:")
        for name in sorted(env_applied):
            print(f"    {name}={env_applied[name]}")
    print("\nStores this run will operate on:")
    for name, root in store.roots:
        print(f"    {name:<8} {root}")
    print(f"    keyfile  {keyfile}")
    if not os.environ.get("VOCALIS_CACHE_DIR"):
        print("")
        print("🟠 $VOCALIS_CACHE_DIR is NOT set, so the cache above is the $HOME default.")
        print("   If this box runs more than one Vocalis, that is very likely the WRONG one —")
        print("   the per-instance values live in the systemd unit, and a shell does not")
        print("   inherit them. Check the paths above against THIS install before continuing:")
        print("       systemctl --user show -p Environment <your-vocalis-unit>")
        if env_path is None:
            print("")
            print("   The durable fix is a vocalis.env file in the install root, read BOTH")
            print("   by systemd (EnvironmentFile=) and by this tool — one source, no drift.")
            print("   Copy vocalis.env.example to vocalis.env. See DEPLOYMENT.md.")
    print("")


def _preflight(assume_yes: bool) -> bool:
    """The gates that no code can check for us (SPEC §2). Ask, and record the answer."""
    if assume_yes:
        return True
    print("\n=== M9 migration — pre-flight ===")
    print("This ENCRYPTS your real data in place. It is irreversible without the backup below.\n")
    if not _ask_yes("Gate Zero: have you cloned the whole Vocalis tree + ~/.cache/vocalis + "
                    "~/Applio/logs to somewhere OFF the boot drive? (SPEC_5_0_M6 §7)"):
        print("Stop. Take the clone first — it is the rollback point.")
        return False
    if not _ask_yes("Is THIS install's Vocalis service STOPPED? (a running server races "
                    "migrate_voices and reads the half-migrated state)"):
        print("Stop this install's service first — note that a box with two Vocalis installs "
              "has two units, and stopping the wrong one changes nothing here.")
        return False
    return True


def _norm_recovery(s: str) -> str:
    return re.sub(r"[\s-]", "", s).upper()


def _interactive_confirm_recovery(recovery: str) -> bool:
    print("\n" + "=" * 70)
    print("  YOUR RECOVERY KEY — shown ONCE, never stored, never shown again:")
    print("\n      " + recovery + "\n")
    print("  Write it on paper and store it safely, separate from this machine.")
    print("  It is shared with the SillyTavern fork (one sheet, two wrapped DEKs).")
    print("  Losing BOTH this and your password loses the data forever.")
    print("=" * 70)
    while True:
        typed = input("\nType the recovery key back to confirm you recorded it "
                      "(or 'abort'): ").strip()
        if typed.lower() == "abort":
            return False
        if _norm_recovery(typed) == _norm_recovery(recovery):
            print("Confirmed.")
            return True
        print("That does not match. Try again, or type 'abort'.")


def _admin_creds_path(store) -> Path:
    """`admin_credentials.yaml` in THIS store's install root — deliberately NOT routed, because
    it is what you log in WITH and must be readable while the vault is locked.

    Asked of the STORE, not of `default_roots()`: the store is what `--keyfile` and the suite
    both repoint, and a credentials check that reads a different install than the one being
    enabled is worse than no check — it would pass on the strength of some other box's login."""
    return Path(store.roots[0][1]) / "admin_credentials.yaml"


def _read_admin_creds(store) -> dict:
    """admin_credentials.yaml as a dict, or {} when absent/unreadable/malformed."""
    import yaml
    p = _admin_creds_path(store)
    if not p.is_file():
        return {}
    try:
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except Exception:                            # noqa: BLE001 — unreadable == not configured
        return {}
    return data if isinstance(data, dict) else {}


def _admin_password_hash(store):
    """The stored werkzeug hash, or None when no admin login is configured."""
    h = _read_admin_creds(store).get("password_hash")
    return str(h) if h else None


def _admin_username(store):
    """The stored admin username, so the password prompt can name the account it means."""
    u = _read_admin_creds(store).get("username")
    return str(u) if u else None


def _get_new_password() -> str:
    """Prompt once for the install’s existing administrator password and verify it against the configured credential hash. This utility does not set or change the administrator password."""
    while True:
        pw = getpass.getpass("This install's ADMIN password (it is also the vault password): ")
        if pw:
            return pw
        print("Empty password — try again.")


def _print_file(p: Path, result: str) -> None:
    mark = {"migrated": "enc ", "already": "skip", "ok": "ok  ", "FAILED": "FAIL"}.get(result, "    ")
    print(f"  [{mark}] {p}")


def _dry_run(store) -> int:
    files = iter_plaintext_files(store)
    plaintext = [p for p in files if not _is_ciphertext(p)]
    total = sum(p.stat().st_size for p in plaintext)
    per_root: dict[str, int] = {}
    for _name, root in store.roots:
        root = Path(root)
        n = sum(1 for p in plaintext if str(p).startswith(str(root)))
        per_root[str(root)] = n
    print("\n=== DRY RUN — nothing will be written ===")
    for root, n in per_root.items():
        print(f"  {n:>6} plaintext file(s) under {root}")
    print(f"\n  {len(plaintext)} file(s), {total / (1024 * 1024):.1f} MiB of plaintext would be "
          f"encrypted.")
    return 0


def _verify(store) -> int:
    if not store.is_initialized():
        print("Not initialized — nothing to verify. Run the migration first.")
        return 1
    store.unlock_with_password(getpass.getpass("Vault password: "))
    checked, failures = verify_all(store, on_file=_print_file)
    if failures:
        print(f"\n🔴 {len(failures)} file(s) FAILED to decrypt:")
        for f in failures:
            print(f"    {f}")
        return 1
    print(f"\n✅ {checked} file(s) decrypt cleanly.")
    return 0


def _any_ciphertext(store) -> bool:
    """True if any store root holds an encrypted file. Reads the raw VLT1 header — needs no unlock.
    Used to refuse a `--disable` that would orphan encrypted data."""
    for _name, root in store.roots:
        root = Path(root)
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if p.is_file() and not is_vault_internal(p.name) and _is_ciphertext(p):
                return True
    return False


def _enable(store, keyfile, assume_yes: bool) -> int:
    """Enable encryption only for an empty store and require the vault password to match the administrator credential. Refuse populated stores; existing data is not migrated by this command."""
    if store.is_initialized():
        print("Encryption is already ON here (a vault exists). Nothing to do.")
        return 0
    if not _preflight(assume_yes):
        return 1

    existing = existing_plaintext_data(store)        # ONE definition — /vault/init runs the same
    if existing:
        print(f"\n🔴 REFUSING — this store already holds {len(existing)} data file(s), and Vocalis "
              f"does NOT migrate existing data into the vault.\n"
              f"    Encryption is chosen at INSTALL TIME, on an empty store. Back up your Vocalis "
              f"folder, CLEAR the data + cache, then re-run (SPEC_5_0_M9 §1.5) — or enable on a fresh "
              f"install.\n"
              f"    e.g. " + ", ".join(str(p) for p in existing[:4]))
        return 1

    # 🔴 REFUSE WITHOUT AN ADMIN LOGIN, or this produces an install that can never be unlocked.
    # `login_submit` is the ONLY thing in the process that calls `unlock_with_password` — one
    # password, two uses (SPEC_5_0_M5 §4.1) — and it returns early when `auth_enabled()` is
    # False. So a vault with no admin_credentials.yaml means: every route 401s "locked", the
    # login page redirects away because auth is off, and the single way in is a hand-written
    # POST to /vault/recover that BURNS THE RECOVERY KEY on day one to fix a setup mistake.
    #
    # Refusing is the same discipline as the populated-store refusal below: the tool must not be
    # able to produce a state the app cannot get out of. Not skippable with --yes; --yes skips
    # interactive confirmations, never a safety gate.
    admin_hash = _admin_password_hash(store)
    if not admin_hash:
        print("")
        print("🔴 REFUSING — no admin login is set on this install, and an encrypted Vocalis")
        print("   with no login can never be unlocked.")
        print("   The login password IS the vault password (one password, two uses): logging in")
        print("   is the only thing that unwraps the DEK.")
        print("   Set it first, then re-run this:")
        print("       python scripts/set-admin-credentials.py")
        print(f"   (expected at {_admin_creds_path(store)})")
        return 1

    # 🔴 AND IT MUST BE THE **SAME** PASSWORD. Authentication and unlocking are checked against
    # two different things — a werkzeug hash in admin_credentials.yaml, and argon2id -> KEK ->
    # the wrapped DEK — and nothing keeps them in step but this. Let them differ here and the
    # failure arrives later, at the login screen, as "correct password, but the vault refused to
    # unlock": authenticated, still locked, fail-closed and baffling. Catching it now costs one
    # comparison; catching it then costs the recovery key.
    from werkzeug.security import check_password_hash
    print("")
    print("Vocalis has ONE password. The admin login you already set is also what unlocks the")
    print(f"vault — logging in is what unwraps the key. Enter it below as '{_admin_username(store) or 'admin'}';")
    print("this does NOT set or change your login, it only checks you have the right one.")
    while True:
        pw = _get_new_password()
        if check_password_hash(admin_hash, pw):
            break
        print("")
        print("🔴 That is not this install's ADMIN password.")
        print("   The vault password and the admin login password must be the same one — the")
        print("   login is what unlocks the vault. Use your admin password, or change it first")
        print("   with scripts/set-admin-credentials.py.")
        print("")

    recovery = create_and_confirm(store, keyfile, pw, _interactive_confirm_recovery)
    if recovery is None:
        print("\nAborted before anything was written — the vault was rolled back. Plaintext, untouched.")
        return 1

    encrypt_tree(store)          # empty store -> a no-op; a defensive sweep that wipes no data

    checked, failures = verify_all(store)
    leaks = find_cleartext(store, allow=("app_settings.yaml", "admin_credentials.yaml"))
    if failures or leaks:
        # 🔴 SAY WHAT STATE THE BOX IS IN. These checks run AFTER create() — the keyfile and every
        # sentinel are already on disk and encryption is ON. Reporting only "UNEXPECTED state" and
        # exiting 1 reads as "the enable failed", so the natural next move is to run it again,
        # which then says a vault already exists. This is a report about CONTENT, not about
        # whether the vault was built.
        print("")
        print(f"⚠️  Encryption IS ON — the vault was created and the keyfile is at {keyfile}.")
        print("   These are the post-enable content checks, and they found something:")
        for f in failures[:40]:
            print(f"    verify FAILED: {f}")
        for lk in leaks[:40]:
            print(f"    cleartext:     {lk}")
        if len(failures) + len(leaks) > 80:
            print(f"    … and {len(failures) + len(leaks) - 80} more")
        print("")
        print("   Do NOT re-run this tool — it will only tell you a vault already exists. Inspect,")
        print("   or wipe the store and start over (encryption is an install-time choice).")
        return 1

    print("\n✅ Encryption is ON. Everything Vocalis writes from now on is encrypted at rest.")
    print("   Keep the recovery key safe and off the box. Before you trust it, do the bare-metal "
          "restore drill BOTH ways — password AND recovery key (SPEC_5_0_M9 §9).")
    return 0


def _disable(store, keyfile, assume_yes: bool) -> int:
    """Disable encryption only when no encrypted data remains. Refuse otherwise because the utility does not decrypt data in place; removing the keys would make ciphertext inaccessible."""
    if not store.is_initialized():
        print("Encryption is already OFF here (no vault).")
        return 0
    if _any_ciphertext(store):
        print("\n🔴 REFUSING — this store still holds ENCRYPTED files. Turning encryption off would "
              "orphan them (there is no in-place decrypt; we don't migrate).\n"
              "    Clear the encrypted data first (you are wiping anyway), then disable.")
        return 1
    if not assume_yes and not _ask_yes(
            "Turn encryption OFF? Removes the vault keyfile + sentinels; the store returns to "
            "plaintext mode."):
        print("Left unchanged.")
        return 1
    rollback_create(store, keyfile)          # removes the keyfile + each root's sentinel
    if store.is_initialized():
        print("🔴 could not remove the keyfile — encryption is still ON.")
        return 1
    print("✅ Encryption is OFF. The box is back in plaintext mode (route() is inert again).")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Enable/disable Vocalis encryption at INSTALL TIME (5.0-M9). No migration.")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--disable", action="store_true",
                      help="turn encryption OFF (only while the store holds no encrypted data)")
    mode.add_argument("--dry-run", action="store_true", help="preview data present + whether enable "
                                                            "is allowed")
    mode.add_argument("--verify", action="store_true", help="decrypt every ciphertext file; "
                                                            "change nothing")
    ap.add_argument("--keyfile", type=Path, default=None,
                    help="vault_keys.yaml location (default: <install root>/vault_keys.yaml)")
    ap.add_argument("--yes", action="store_true",
                    help="skip the interactive pre-flight confirmations (for automation)")
    args = ap.parse_args(argv)

    # BEFORE default_roots(), which calls cache_root(), which reads $VOCALIS_CACHE_DIR. A shell
    # does not inherit the unit's Environment= lines; vocalis.env is the one file both systemd
    # (EnvironmentFile=) and this tool read, so they cannot drift. See tts_utils.load_env_file.
    from tts_utils import load_env_file
    env_path, env_applied = load_env_file(Path(__file__).resolve().parent.parent)

    roots = vault_store.default_roots()
    keyfile = args.keyfile or (roots[0][1] / "vault_keys.yaml")
    store = vault_store.configure(roots, keyfile)

    _show_roots(store, keyfile, env_path, env_applied)

    if args.dry_run:
        return _dry_run(store)
    if args.verify:
        return _verify(store)
    if args.disable:
        return _disable(store, keyfile, args.yes)
    return _enable(store, keyfile, args.yes)


if __name__ == "__main__":
    raise SystemExit(main())
