"""Own process-wide vault roots, the in-memory data-encryption key, authentication state, and routing between absolute filesystem paths and logical vault paths. The vault starts locked after process restart; browser authentication can persist independently from whether the key is unlocked."""

from __future__ import annotations

import os
import threading
from pathlib import Path

from loguru import logger

import vault
from vault import VaultAuthError, VaultError, VaultLocked  # noqa: F401  (re-exported: the seams catch these BY NAME)

DEV_ENV = "VOCALIS_DEV_PASSPHRASE"


# --------------------------------------------------------------------------- the routes
#
# 🔴 CONTAINMENT IS NOT ENOUGH, AND THE OBVIOUS ROUTER WOULD ENCRYPT THE REPO.
#
# The install root IS the repo root (vocalis_server.BASE_DIR) — it holds src/, scripts/,
# .git/, logs/ and work/scratch. A router that answered "is it under a root?" would claim:
#
#   src/, scripts/   -> encrypts the code, including the enhance script a FOREIGN VENV execs
#   .git/            -> destroys the repository
#   logs/            -> logs must stay readable while the vault is LOCKED; that is what you
#                       debug a locked server with (design §7)
#   work/scratch     -> the scratch is THE ONE PLACE PLAINTEXT MAY TOUCH DISK (M3), and its
#                       default root is BASE_DIR/work/scratch. Encrypting it would encrypt the
#                       destination decrypt_to_scratch writes TO. A circular absurdity.
#
# So a path is in a vault only if it is under a root AND under one of that root's DATA
# subtrees (or is one of its named loose files). Everything else routes to None = "not ours,
# use a plain open()".
#
# The vault's own default is ENCRYPT ("forgetting to register a dir leaks nothing" —
# vault.py:115). THE ROUTER'S DEFAULT IS THE OPPOSITE, on purpose, because its failure modes
# are not symmetric: wrongly DISCLAIMING a path leaks (bounded, and the sweep enumerates every
# data dir); wrongly CLAIMING one bricks the app and destroys the repo.
#
# The price of an allow-list is that it can rot into a silent leak. tests/test_m6_router.py
# pays it: it enumerates the REAL config objects and asserts every data path the app can
# actually write routes to a vault — so a store added in 5.1 fails a test instead of leaking.
ROUTES = {
    "install": {
        # The trained-voice registry and source training clips contain user-created assets that cannot be re-downloaded. Route both through the install vault; an omitted route can leave writes in plaintext without an error.
        # The document store contains imported cards, lorebooks, revisions, and edit proposals with user-authored text. Keep the full store inside the vault.
        # Voice candidates contain generated audio and user-provided descriptions. They persist for later audition, so treat them as durable user data.
        # The audio library contains saved generated songs. Route it through the vault because the files are large and not safely reproducible.
        # Curated LoRA datasets include subject images, captions, and identifying directory names. Encrypt both file contents and path metadata.
        "trees": ("output", "uploads", "voice_samples", "books", "voice_models", "voice_training",
                  "wbedit", "voice_candidates", "ace_library", "lora_datasets",
                  # Seed images identify training subjects, and generated dataset images inherit that association. Keep them in the vault.
                  "lora_faces",
                  # Generated source images retained before dataset curation.
                  "lora_generated",
                  # Training logs and checkpoints can identify the dataset subject; keep the entire run workspace in the vault.
                  "lora_training", "lora_face_candidates", "lora_tests",
                  # Production slices, peak envelopes, and still images are derived from vault content.
                  "productions"),
        # The following fixed-name files are routed through the vault because their contents can include user-authored text, selected library items, or identifying names:
        # `voice_settings.yaml`: voice parameters, Nomi identifiers, and character names. Its fixed filename remains visible; its contents do not.
        # `ui_state.yaml`: current selections and recent Playground text.
        # `clip_favorites.yaml`: favorite references can contain scene slugs derived from user-chosen titles.
        # `voice_templates.json`, `ace_templates.json`, and `ace_candidates.json`: voice descriptions, sample text, song titles and lyrics, or candidate metadata.
        # `folders.yaml`: folder names and item references reveal how a user organized the library.
        # `lora_subjects.json`: subject trigger words, prompts, seeds, and captions.
        # `scene_enhance_queue.yaml`: ordered scene references whose slugs derive from titles.
        # `productions.json`: source, subject, and per-shot descriptions.
        # Keep settings and credential files readable while the vault is locked; they configure or unlock it.
        # Keep the legacy `clip_favourites.yaml` filename routed for reads so older encrypted entries remain accessible.
        "files": ("voice_settings.yaml", "ui_state.yaml", "clip_favorites.yaml",
                  "clip_favourites.yaml", "scene_enhance_queue.yaml",
                  "voice_templates.json", "ace_templates.json",
                  "ace_library.json", "ace_candidates.json", "folders.yaml",
                  "lora_subjects.json", "lora_prompt_templates.json",
                  # Production metadata includes the source, subject, and per-shot descriptions.
                  "productions.json"),
        "derived": False,
    },
    "cache": {
        # trim_scores/ (M10 R1) is 4.4's per-source VAD + tagger output — where in the user's own
        # recording someone is SPEAKING, at what confidence, second by second. It is a
        # transcript-shaped description of a private clip, so "regenerable" is again not the
        # same claim as "not content" (§7.7.1 already settled that for the cache as a whole).
        "trees": ("chunks", "enhanced", "audio_cache", "voiceswap_preview", "trim_scores"),
        # cleanup_rates.yaml / swap_rates.yaml (M10 R2/R3) are throughput measurements: their
        # keys carry NO user content, so routing them buys consistency rather than privacy.
        # Routed anyway, deliberately — the argument for leaving them out ("this one is
        # harmless") is precisely the argument that let this allow-list rot twice. An entry
        # costs nothing; the judgment call it replaces is what costs.
        "files": ("song_ids.yaml", "enhance_rates.yaml", "render_rates.yaml",
                  "cleanup_rates.yaml", "swap_rates.yaml"),
        # SPEC_5_0_M6 §3: a CACHE whose sentinel is missing self-heals rather than refusing.
        # `clear_cache` is a shipped feature, and a strict vault would turn it into a permanent
        # lockout of the whole store — including the install root that holds the real data.
        "derived": True,
    },
}


def fail_job_on_vault_auth(job, exc, emit=None) -> None:
    """What EVERY job thread does at BOUNDARY 2 of 5 (SPEC_5_0_M5 §6). One shape, one place,
    so that "each boundary catches it" and "each boundary does the right thing" are the same
    fact rather than two facts that can drift.

    A VaultAuthError means a file did not authenticate: a wrong DEK, tampering, truncation, or
    genuine corruption — and they are INDISTINGUISHABLE from each other by construction. That
    is what a MAC is. Under encryption, "corrupt file" and "wrong key" become the same event,
    and this codebase's historic answer to a corrupt file was to DELETE AND REGENERATE it —
    every banked chunk of a resumable render, the good stems, an 18-hour training run.

    So the entire job of this function is: STOP, LOUDLY, AND TOUCH NOTHING.

    Fail the job. Say so. Delete nothing, quarantine nothing, "repair" nothing, regenerate
    nothing. A hung or failed job is recoverable. Deleted chunks are not. That is the whole
    trade, and it is why VaultAuthError is not an Exception in the first place.
    """
    job.status = "failed"
    job.error = f"a file failed vault authentication — {exc}"
    logger.critical(f"job {getattr(job, 'id', '?')}: VAULT AUTHENTICATION FAILED — {exc}")
    logger.critical("The job is STOPPED. Nothing has been deleted, regenerated, or repaired.")
    if emit is not None:
        emit(job, {"type": "error", "message": job.error})


# --------------------------------------------------------------------------- the singleton
#
# It lives HERE, not in vocalis_server, and that is forced rather than chosen: tts_utils holds
# THE IDENTITY SEAM (source_stat) and stems holds the song hash, and neither can import the
# Flask app — vocalis_server imports THEM. So the one thing every seam needs to reach has to
# sit at the bottom of the import graph, and the server configures it at startup.
STORE: "VaultStore | None" = None


def configure(roots, keyfile) -> "VaultStore":
    """Install the process-wide store. Called once, by the server, at import."""
    global STORE
    if STORE is not None:
        # Reconfiguration is expected only in tests that install fresh temporary roots. In a server process it creates split store references: callers may check unlock state on one store while file operations use another.
        logger.warning(f"vault_store.configure() called AGAIN in this process — replacing the "
                       f"router's store (old store unlocked: {STORE.is_unlocked()})")
    STORE = VaultStore(roots, keyfile)
    return STORE


def default_roots():
    """THE ONE definition of which stores Vocalis owns — shared by the server (`configure()`
    at startup) and the offline migration (`vault_migrate.py`), so the two can NEVER walk
    different roots. If they did, the migration would either miss a store (a leak) or encrypt
    one the app reads plaintext (a brick). The subtrees are already pinned by
    `tests/test_m6_router.py`; the ROOT LIST is what this closes (SPEC_5_0_M9 §7).

    `install` is the durable data root. `cache_root()` is resolved at call time so the server,
    tests, and migration use the same configured cache mount.
    """
    from tts_utils import cache_root
    from vocalis.runtime import paths
    base = paths.DATA_DIR
    return [("install", base), ("cache", cache_root())]


def route(abs_path):
    """Return (Vault, logical_path) for an owned path, or None for a path that must use ordinary filesystem access. Before initialization, routing is inert and preserves plaintext behavior. Once initialized, route even while locked so access raises VaultLocked instead of writing plaintext into an encrypted store. Defer imports to avoid the tts_utils/vault dependency cycle."""
    s = STORE
    if s is None or not s.is_initialized():
        return None
    return s.logical_of(abs_path)


class VaultStore:
    """Coordinate roots under one keyfile and DEK while keeping a sentinel in each root to detect a mismatched keyfile or restored store."""

    def __init__(self, roots, keyfile):
        self._roots = [(str(name), Path(p)) for name, p in roots]
        self.keyfile = Path(keyfile)
        self._vaults = [vault.Vault(p, self.keyfile,
                                    derived=bool(ROUTES.get(name, {}).get("derived")))
                        for name, p in self._roots]
        self._dev_unlocked = False
        self._mu = threading.Lock()

    # ---------------------------------------------------------------- the path router

    def logical_of(self, abs_path):
        """Resolve an absolute path to its logical vault path, or None when the path is not owned. Non-owned paths such as configured external libraries use ordinary reads; scratch and logs follow their explicit routing rules. Resolve symlinks before checking ownership."""
        p = Path(abs_path).resolve()
        for (name, root), v in zip(self._roots, self._vaults):
            try:
                rel = p.relative_to(root.resolve())
            except ValueError:
                continue                      # not under this root — try the next
            r = ROUTES.get(name)
            if r is None:
                return None
            rel = rel.as_posix()
            # The bare tree dir routes too ("output" -> listdir, "uploads/songs" -> mkdir):
            # a directory is a logical path like any other.
            if rel in r["files"] or rel.split("/", 1)[0] in r["trees"]:
                return v, rel
            # Inside the root but NOT a data path: src/, .git/, logs/, work/scratch,
            # app_settings.yaml, admin_credentials.yaml, vault_keys.yaml. Not ours.
            return None
        return None

    # ---------------------------------------------------------------- state

    def is_initialized(self) -> bool:
        return self.keyfile.exists()

    def is_unlocked(self) -> bool:
        return bool(self._vaults) and all(v.is_unlocked() for v in self._vaults)

    def is_dev_unlocked(self) -> bool:
        return self._dev_unlocked

    def vaults(self):
        return list(self._vaults)

    @property
    def roots(self):
        return list(self._roots)

    # ---------------------------------------------------------------- lifecycle

    def create(self, password: str) -> str:
        """Initialize the store. Returns the recovery key — ONCE. It is never stored, only
        the wrap it produces is (design §4.5), so a caller that loses it has lost it."""
        with self._mu:
            if self.is_initialized():
                raise VaultError("the vault is already initialized")
            first_root = self._roots[0][1]
            v, recovery = vault.Vault.create(first_root, self.keyfile, password)
            self._vaults[0] = v
            # Any further root shares the keyfile, so it unlocks rather than creates. An empty
            # store gets its sentinel written here, on its first unlock.
            for i in range(1, len(self._vaults)):
                self._vaults[i].unlock_with_password(password)
            return recovery

    def unlock_with_password(self, password: str) -> None:
        self._unlock_all(lambda v: v.unlock_with_password(password))

    def unlock_with_recovery(self, recovery_key: str) -> None:
        self._unlock_all(lambda v: v.unlock_with_recovery(recovery_key))

    def unlock_with_suk(self, suk: str) -> None:
        self._unlock_all(lambda v: v.unlock_with_suk(suk))

    def _unlock_all(self, unlock) -> None:
        """Unlock every configured root or none. If a re-unlock fails while all roots are already unlocked, preserve the live DEK; on a partial unlock, undo the partial state before returning the failure."""
        with self._mu:
            already_open = self.is_unlocked()
            try:
                for v in self._vaults:
                    unlock(v)
            except BaseException:
                if not already_open:      # undo a partial unlock; never evict a working DEK
                    logger.warning("vault: unlock FAILED — undoing the partial unlock; "
                                   "the vault stays LOCKED")
                    self._lock_unguarded()
                else:
                    logger.info("vault: a rejected key hit an already-open store — "
                                "the working DEK is untouched")
                raise
            if not already_open:
                logger.info("vault: UNLOCKED — the DEK is in RAM")
            # HERE, not in the callers: this is the one choke point every unlock path funnels
            # through (password, recovery key, and SUK alike), so the migration cannot be
            # reached by a route that forgot to call it. Needs the DEK, which is why it cannot
            # run at startup on an encrypted box.
            #
            # A failed migration must NEVER cost someone their login — the data is still there
            # under its old name and the next unlock retries — so OSError is caught and logged
            # rather than raised through unlock.
            for v in self._vaults:
                try:
                    v.migrate_structural_names()
                except OSError:
                    logger.exception("structural-name migration failed — the store is intact "
                                     "and the next unlock will retry")

    def issue_suk(self) -> str:
        """Mint a Session Unlock Key so a server restart re-unlocks silently (design §5.4).

        Safe: `wrap_session` is ciphertext under an unguessable random key that only ever
        lives in the browser's sessionStorage — RAM, never disk. It weakens nothing.
        """
        with self._mu:
            return self._vaults[0].issue_suk()

    def change_password(self, old: str, new: str) -> None:
        """Re-wrap the DEK under a new password. Re-encrypts NOT ONE BYTE of data — that is
        the entire reason for the two-layer key design.

        Only the first vault touches the keyfile: they all share it, and re-wrapping the same
        DEK N times would just be the last write winning.
        """
        with self._mu:
            self._vaults[0].change_password(old, new)

    def set_password_unlocked(self, new: str) -> None:
        """The recovery flow's second half: a new password, without the old one (§9.3)."""
        with self._mu:
            self._vaults[0].set_password_unlocked(new)

    def rotate_recovery(self) -> str:
        """A NEW recovery key for the same DEK; the OLD one stops unwrapping. Returned ONCE.

        Only the first vault touches the keyfile — they all share it, so rewrapping the same DEK
        N times would just be the last write winning (see `change_password`).
        """
        with self._mu:
            return self._vaults[0].rotate_recovery()

    def revoke_suk(self) -> None:
        with self._mu:
            self._vaults[0].revoke_suk()

    def lock(self) -> None:
        """Zero the DEK and drop the session wrap. The request gate rejects new work while in-flight operations finish using their own references."""
        with self._mu:
            try:
                if self.is_initialized():
                    self._vaults[0].revoke_suk()
            except VaultError:
                pass                      # a keyfile we cannot read is not a reason to stay unlocked
            logger.info("vault: LOCKED — the DEK is zeroed and the session wrap is revoked")
            self._lock_unguarded()

    def _lock_unguarded(self) -> None:
        for v in self._vaults:
            v.lock()
        self._dev_unlocked = False

    # ---------------------------------------------------------------- dev unlock

    def dev_unlock(self) -> bool:
        """Read VOCALIS_DEV_PASSPHRASE and run the same Argon2id, key derivation, and unwrap flow as interactive login. Emit a boot warning and expose dev_unlock status through health; this is a development convenience, not a weaker cryptographic path."""
        pw = os.environ.get(DEV_ENV)
        if not pw or not self.is_initialized():
            return False
        self.unlock_with_password(pw)     # a wrong one raises VaultAuthError -- loudly, and stays locked
        self._dev_unlocked = True
        logger.warning(f"*** {DEV_ENV} IS SET — the vault was unlocked at boot WITHOUT a login. ***")
        logger.warning("*** Development unlock must not be enabled in production. ***")
        return True
