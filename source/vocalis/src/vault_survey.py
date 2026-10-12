"""Inspect a store without changing it and report whether plaintext or encrypted files are present. Keep this helper independent from migration code so the server can safely check store state without importing mutating operations."""
from __future__ import annotations

import re
from pathlib import Path

import vault
import vault_store


# A long-name companion is precisely `L<32 hex>.name` (vault._enc_name → LONG_PREFIX + sha256[:32],
# then `<enc>.name`). A user file that merely ENDS in ".name" is NOT one and must still migrate,
# so the match is exact rather than a bare suffix test.
_LONG_COMPANION_RE = re.compile(r"^L[0-9a-f]{32}\.name$")


def is_vault_internal(name: str) -> bool:
    """True for a file the vault itself writes — never a user plaintext original: the sentinel,
    an in-flight-or-orphaned `.part` (open_write's temp), or a long-name companion."""
    return (name == vault.SENTINEL_NAME
            or name.endswith(vault.PART_SUFFIX)
            or _LONG_COMPANION_RE.match(name) is not None)


def is_ciphertext(path: Path) -> bool:
    """Already-encrypted? A vault file announces itself with the VLT1 magic at offset 0; a
    plaintext MP3/WAV/YAML/.pth does not. This is what makes a migration run resumable."""
    try:
        with open(path, "rb") as fh:
            return fh.read(len(vault.MAGIC)) == vault.MAGIC
    except OSError:
        return False


def physical_tops(v, root, top):
    """Yield each physical name that a routed top may occupy: its structural cleartext name and, when initialized, its SIV-encrypted name. Include both so a partial migration can be resumed or audited, and use the cleartext name when no DEK is available."""
    tops = [root / top]
    try:
        enc = Path(v._map(top))
    except vault.VaultLocked:
        return tops                                  # locked/uninitialized: nothing is encrypted yet
    if enc != tops[0]:
        tops.append(enc)
    return tops


def iter_routed_physical(store):
    """Yield (root_name, root, file) for every physical file under a ROUTED top, and nowhere else.

    🔴 THE ROOT IS NOT THE STORE. The install root IS the repo root — `.git/`, `venv/`, `src/`,
    `docs/` and thirty thousand files the vault has no opinion about. ROUTES names the six trees
    and two files it actually owns, so the walk can be scoped instead of filtered.

    Scoping rather than filtering is not just speed, though `rglob("*")` over a venv is ~15
    seconds of nothing: `find_cleartext` READ every one of those files looking for marker bytes,
    reported each Python source containing `text:` as a leak, and `_enable` treats leaks as fatal.
    A correct enable on a real install failed, loudly, after the vault was already written.

    Which physical names a top can wear is `physical_tops`' problem — and it is not the one
    obvious name. Read it before assuming `root / top` is the whole story."""
    for (name, root), v in zip(store.roots, store.vaults()):
        root = Path(root)
        if not root.exists():
            continue
        r = vault_store.ROUTES.get(name, {})
        for top in (*r.get("trees", ()), *r.get("files", ())):
            for t in physical_tops(v, root, top):
                if t.is_file():
                    yield (name, root, t)
                elif t.is_dir():
                    for p in sorted(t.rglob("*")):
                        if p.is_file():
                            yield (name, root, p)


def iter_plaintext_files(store) -> list[Path]:
    """SNAPSHOT every file the router owns, across all roots, as absolute paths.

    Uses `store.logical_of` (pure ROUTES math) rather than the module-level `route()`, because
    `route()` is inert until the vault is initialized and a --dry-run runs BEFORE `create()`.
    Enumerated FIRST, in full, then processed (SPEC §4.2): encrypting `output/My Book/...` creates
    a SIBLING `output/<siv>/...` dir under the same `output/`, and a live walk would descend into
    freshly-written ciphertext. Vault bookkeeping (sentinel/.part/companions) is filtered here so
    the count is honest; ciphertext-vs-plaintext is decided per file in `migrate_one`.

    ⚠️ THE PHYSICAL WALK IS WIDER THAN THIS LIST, DELIBERATELY. `iter_routed_physical` also
    descends the SIV-named form of every non-structural top, and `logical_of` — path arithmetic —
    calls those None. That subtraction is CORRECT here and must not be "fixed": a file sitting
    under an encrypted top is either already-migrated ciphertext (nothing to do) or a plaintext
    file whose logical name cannot be derived by arithmetic at all, which `migrate_one` could not
    move even if handed it. Catching that second case is `find_cleartext`'s job, and it is exactly
    why that function does NOT reuse this filter.
    """
    out: list[Path] = []
    for _name, root, p in iter_routed_physical(store):
        if is_vault_internal(p.name):
            continue
        if store.logical_of(p) is None:              # not a data path, or under a SIV top — see above
            continue
        out.append(p)
    return out


def existing_plaintext_data(store) -> list[Path]:
    """The files that make a store NOT-empty for the purpose of enabling encryption: routed data
    paths that are not already ciphertext. Non-empty result ⇒ creating a vault here would brick
    every one of them (`bad magic` on first read). The exact check `vault_migrate._enable` makes,
    named so the CLI and `POST /vault/init` cannot drift apart about what "empty" means."""
    return [p for p in iter_plaintext_files(store) if not is_ciphertext(p)]
