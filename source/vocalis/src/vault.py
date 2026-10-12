"""Own the data-encryption key and all cipher operations. Derive authentication and key-encryption keys from the password with Argon2id and HKDF; use the wrapped random 32-byte DEK to derive AES-GCM content, AES-SIV filename, unlock-sentinel, and scratch keys. Password changes rewrap the DEK without re-encrypting stored data. Other modules access user data through this API."""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import io
import os
import secrets
import shutil
import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator, NamedTuple

import yaml
from argon2.low_level import Type as _Argon2Type
from argon2.low_level import hash_secret_raw
from loguru import logger
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, AESSIV
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from tts_utils import atomic_replace, part_path

# --------------------------------------------------------------------------- errors


class VaultError(Exception):
    """Base for ordinary, catchable vault failures."""


class VaultLocked(VaultError):
    """A data method was called while the DEK is not in RAM. Distinct from a
    decrypt failure: nothing is wrong with the file, we just can't read it yet."""


class VaultAuthError(BaseException):
    """Authentication or integrity failure while decrypting vault data, including a wrong key, tampering, truncation, or corruption. This deliberately derives from `BaseException`: ordinary `except Exception` handlers must not turn unreadable data into an empty result and then delete or regenerate it. Let failures propagate to an explicit job boundary so no data is deleted. Thread entry points that cannot propagate to a request handler must handle this exception explicitly rather than dying silently."""


# --------------------------------------------------------------------------- format

MAGIC = b"VLT1"
FORMAT_VERSION = 1
HEADER_LEN = 16  # magic(4) | version(1) | reserved(3) | nonce_prefix(8)
NONCE_PREFIX_LEN = 8
BLOCK = 64 * 1024  # 65536 plaintext bytes per block
TAG = 16  # AES-GCM tag
CT_BLOCK = BLOCK + TAG  # 65552 ciphertext bytes per full block

# base64url of a SIV name; beyond this we use the long-name fallback (§3.5).
# The Linux limit is 255; 200 leaves room for the ".name" companion and ".part".
MAX_ENC_NAME = 200
LONG_PREFIX = "L"
LONG_SUFFIX = ".name"

SENTINEL_NAME = ".vault_sentinel"
SENTINEL_PLAINTEXT = b"vocalis-vault-sentinel-v1"

# open_write()'s in-flight temp. Named ONCE, here, because listdir() has to recognize it: a
# SIGKILL between the write and the atomic_replace leaves one behind, and an orphaned .part
# that listdir tried to DECRYPT used to raise VaultAuthError and take the whole directory with
# it. Encrypted names are base64url and never contain a '.', so this suffix is unambiguous.
PART_SUFFIX = ".part"

DEFAULT_KDF = {"algo": "argon2id", "memory_kib": 262144, "time_cost": 3, "parallelism": 4}

# These patterns match full logical paths, so every routed data subtree must have its own structural parent name. Changing a structural name after files exist can relocate data or make it unreachable.
# Structural names are constants in source and may remain visible. User-created filenames, titles, and content beneath them remain encrypted.
STRUCTURAL = (
    # install root (BASE_DIR)
    "output",
    "output/*/mp3",
    "output/*/wav",
    "output/books",            # The fixed book container name remains structural; title directories and media stay encrypted.
                               # Wildcard rules cover media beneath book-title directories without making the title structural.
    "output/playground",       # <voice-dir>/<stem>.mp3 inside it stays encrypted
    "output/scenes",           # Scene filenames and manifests stay encrypted beneath the structural container.
                               # Scene titles stay encrypted under the structural parent. Register the parent before writing the first entry; promoting an existing name relocates stored entries.
    "output/stems",            # <set-ref> carries the song name — encrypted
    "output/voiceswap",
    "uploads",
    "uploads/songs",           # the song's own filename — encrypted
    "uploads/stems",
    "voice_samples",           # <voice>.wav — encrypted
    "voice_models",            # Trained-voice files use this structural directory; registry filenames remain encrypted.
                               # The RVC registry now lives in this fixed structural directory; registry filenames remain encrypted.
    "voice_training",          # the source clips — the user's own recorded voice. Encrypted.
    "books",                   # <title>.epub — encrypted
    # The editor store contains character cards, lorebooks, revisions, and user-authored text. Its fixed root name must remain structural so repository ignore rules can match it; contents remain encrypted.
    "wbedit",                  # <doc-id>/… inside it stays encrypted
    # Voice candidates are durable user data and must be structurally addressable for repository ignore rules. Keep their filenames and contents encrypted.
    "voice_candidates",        # <token>.wav/.json inside it stays encrypted
    # cache root (cache_root())
    "chunks",
    "chunks/playground",       # <H>/ is a hash already, but it is not ours to assume
    "enhanced",
    "audio_cache",
    "voiceswap_preview",
    # These two routed entries are files at the install root. Keep their fixed names structural so repository ignore rules can match them, while their contents remain encrypted.
    # Encrypted names are unpredictable and cannot be covered by a useful ignore pattern. Structural applies to the name only; file contents remain encrypted at rest.
    "voice_settings.yaml",
    "ui_state.yaml",
    # Favorite references can contain scene-title slugs. Keep the fixed metadata filename structural so repository ignore rules can match it; contents remain encrypted.
    "clip_favorites.yaml",
    # Keep the legacy filename structural so upgraded installs can still read its encrypted contents and repository ignore rules can match it.
    "clip_favourites.yaml",
    # The server-side queue stores ordered scene references with title-derived slugs. Keep its fixed filename structural and its contents encrypted.
    "scene_enhance_queue.yaml",
    # Saved voice templates contain user-authored descriptions and sample text. Keep the fixed filename structural and the file contents encrypted.
    "voice_templates.json",
    # Saved song templates contain titles, lyrics, and captions. Keep the fixed filename structural and the file contents encrypted.
    "ace_templates.json",
    # Both the saved-song index and its audio directory need structural names so ignore rules can match them. Their contents and child filenames remain encrypted.
    "ace_library.json",
    "ace_library",
    # The candidate index needs a predictable structural name for repository ignore rules; titles and seed metadata remain encrypted.
    "ace_candidates.json",
    # Folder names and item references are user content. Keep only the fixed metadata filename structural; encrypt the contents.
    "folders.yaml",
    # The subject index and curated image directories contain identifying prompts, captions, and images. Keep fixed roots structural for ignore rules while encrypting their contents and child names.
    "lora_subjects.json",
    "lora_datasets",
    # Global prompt templates contain user-authored text. Keep the fixed metadata filename structural and encrypt its contents.
    "lora_prompt_templates.json",
    # Seed images identify training subjects and must remain encrypted.
    "lora_faces",
    # Generated originals are retained source images and must remain encrypted.
    "lora_generated",
    "lora_training",
    "lora_face_candidates",
    "lora_tests",
    "productions.json",
    "productions",
)

# Derive the root-level structural files from `STRUCTURAL` rather than maintaining a second list. File entries have suffixes; directory entries do not.
_ROOT = tuple(p for p in STRUCTURAL if "/" not in p)
STRUCTURAL_FILES = tuple(p for p in _ROOT if "." in p)
STRUCTURAL_DIRS = tuple(p for p in _ROOT if "." not in p)


class VaultStat(NamedTuple):
    size: int  # PLAINTEXT size, derived in O(1). Never the ciphertext size.
    mtime: float
    mtime_ns: int


# --------------------------------------------------------------------------- key math


def _hkdf(key: bytes, info: bytes, length: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=None, info=info).derive(bytes(key))


def _argon2(password: str, salt: bytes, kdf: dict) -> bytes:
    return hash_secret_raw(
        secret=password.encode("utf-8"),
        salt=salt,
        time_cost=int(kdf["time_cost"]),
        memory_cost=int(kdf["memory_kib"]),
        parallelism=int(kdf["parallelism"]),
        hash_len=32,
        type=_Argon2Type.ID,
    )


def _wrap(key: bytes, dek: bytes) -> bytes:
    """AES-256-GCM wrap of the DEK. Output is nonce(12) || ct+tag."""
    nonce = os.urandom(12)
    return nonce + AESGCM(bytes(key)).encrypt(nonce, bytes(dek), b"vocalis/wrap/v1")


def _unwrap(key: bytes, blob: bytes) -> bytes:
    try:
        return AESGCM(bytes(key)).decrypt(blob[:12], blob[12:], b"vocalis/wrap/v1")
    except (InvalidTag, ValueError) as e:
        raise VaultAuthError("could not unwrap the DEK — wrong key or damaged keyfile") from e


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


def _format_recovery_key(raw: bytes) -> str:
    """256 bits as grouped Base32 — BitLocker-style, hand-transcribable."""
    s = base64.b32encode(raw).decode("ascii").rstrip("=")
    return "-".join(s[i : i + 5] for i in range(0, len(s), 5))


def _parse_recovery_key(s: str) -> bytes:
    compact = "".join(ch for ch in s.upper() if ch.isalnum())
    pad = "=" * (-len(compact) % 8)
    try:
        return base64.b32decode(compact + pad)
    except Exception as e:
        raise VaultAuthError("recovery key is not valid Base32") from e


# --------------------------------------------------------------------------- content codec


def _header(nonce_prefix: bytes) -> bytes:
    h = MAGIC + bytes([FORMAT_VERSION]) + b"\x00\x00\x00" + nonce_prefix
    assert len(h) == HEADER_LEN
    return h


def _aad(header: bytes, index: int, final: bool) -> bytes:
    return header + struct.pack(">I", index) + (b"\x01" if final else b"\x00")


def _nonce(header: bytes, index: int) -> bytes:
    return header[HEADER_LEN - NONCE_PREFIX_LEN :] + struct.pack(">I", index)


def plaintext_len(ct_len: int) -> int:
    """The plaintext size of a vault file, from its ciphertext size alone. O(1), exact.

    Every block but the last holds exactly BLOCK plaintext bytes; the last holds the
    remainder in [0, BLOCK]; there is ALWAYS at least one block (a zero-byte file is one
    empty final block). That makes the block count unambiguous, hence this exact:

        N      = (ct - HEADER - TAG) // CT_BLOCK + 1
        pt_len = ct - HEADER - TAG * N

    This is why the header stores no length field. A stored length could not be
    authenticated at write time without buffering the whole file before sealing block 0,
    so it would be a lie an attacker could tell for free. Deriving it makes the lie
    structurally impossible, at the same cost.
    """
    if ct_len < HEADER_LEN + TAG:
        raise VaultAuthError(f"vault file is impossibly short ({ct_len} bytes) — truncated")
    return ct_len - HEADER_LEN - TAG * _block_count(ct_len)


def _block_count(ct_len: int) -> int:
    return (ct_len - HEADER_LEN - TAG) // CT_BLOCK + 1


class _BlockWriter(io.RawIOBase):
    """Encrypting writer. Seals a block only once at least one byte beyond it has
    arrived, so the final block is known to be final without buffering the whole file."""

    def __init__(self, fh: BinaryIO, k_content: bytes, on_close):
        self._fh = fh
        self._key = AESGCM(bytes(k_content))
        self._header = _header(os.urandom(NONCE_PREFIX_LEN))
        self._buf = bytearray()
        self._index = 0
        self._on_close = on_close
        self._failed = False
        fh.write(self._header)

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        b = bytes(data)
        self._buf += b
        while len(self._buf) > BLOCK:  # strictly > : proves a further block follows
            self._seal(bytes(self._buf[:BLOCK]), final=False)
            del self._buf[:BLOCK]
        return len(b)

    def _seal(self, pt: bytes, *, final: bool) -> None:
        ct = self._key.encrypt(_nonce(self._header, self._index), pt, _aad(self._header, self._index, final))
        self._fh.write(ct)
        self._index += 1

    def abort(self) -> None:
        """Discard the write. The destination is left untouched."""
        self._failed = True
        self.close()

    def close(self) -> None:
        if self.closed:
            return
        try:
            if not self._failed:
                self._seal(bytes(self._buf), final=True)  # always: even a 0-byte file
            self._fh.close()
        finally:
            io.RawIOBase.close(self)
            self._on_close(failed=self._failed)


class _BlockReader(io.RawIOBase):
    """Seekable, decrypting reader. Decrypts only the blocks a read actually touches."""

    def __init__(self, fh: BinaryIO, k_content: bytes, ct_len: int, label: str):
        self._fh = fh
        self._key = AESGCM(bytes(k_content))
        self._ct_len = ct_len
        self._label = label
        self._nblocks = _block_count(ct_len)
        self._len = plaintext_len(ct_len)
        self._pos = 0
        self._cache_idx = -1
        self._cache = b""
        self.blocks_read = 0  # test instrumentation: proves the O(1)-seek claim

        head = fh.read(HEADER_LEN)
        if len(head) != HEADER_LEN or head[:4] != MAGIC:
            raise VaultAuthError(f"not a vault file (bad magic): {label}")
        if head[4] != FORMAT_VERSION:
            raise VaultError(f"unsupported vault format version {head[4]}: {label}")
        self._header = head

        if self._len == 0:
            # An empty file has no bytes for a read to touch, so nothing would ever
            # authenticate it and read_bytes() would hand back b"" under ANY key --
            # a falsy result exactly where a VaultAuthError belongs, which is the whole
            # failure mode this module exists to prevent. Force the final block (16 bytes)
            # now. Empty sidecars and state files are real; this hole was reachable.
            self._block(0)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def _block(self, i: int) -> bytes:
        if i == self._cache_idx:
            return self._cache
        final = i == self._nblocks - 1
        # A full block is CT_BLOCK; the final one is whatever remains.
        start = HEADER_LEN + i * CT_BLOCK
        size = self._ct_len - start if final else CT_BLOCK
        self._fh.seek(start)
        ct = self._fh.read(size)
        try:
            pt = self._key.decrypt(_nonce(self._header, i), ct, _aad(self._header, i, final))
        except (InvalidTag, ValueError) as e:
            # Wrong key, tampering, truncation, reorder, or a transplanted block — all
            # land here, and all are indistinguishable from each other by design. What
            # matters is that this is NOT an Exception, so no caller deletes the file.
            raise VaultAuthError(f"authentication failed on block {i} of {self._label}") from e
        self._cache_idx, self._cache = i, pt
        self.blocks_read += 1
        return pt

    def readinto(self, b) -> int:
        if self._pos >= self._len:
            return 0
        n = min(len(b), self._len - self._pos)
        i = self._pos // BLOCK
        off = self._pos % BLOCK
        chunk = self._block(i)[off : off + n]
        b[: len(chunk)] = chunk
        self._pos += len(chunk)
        return len(chunk)

    def seek(self, pos: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._len}[whence]
        self._pos = max(0, base + pos)
        return self._pos

    def tell(self) -> int:
        return self._pos

    def close(self) -> None:
        if not self.closed:
            try:
                self._fh.close()
            finally:
                io.RawIOBase.close(self)


# --------------------------------------------------------------------------- the vault


class Vault:
    """The encrypted store rooted at `store_root`, keyed by `keyfile`.

    Every root is a constructor argument: this module never reads OUTPUT_DIR and never
    calls cache_root(). That is the established shape for pure-library modules here
    (playground_clips, stems) and it is what lets the tests drive it with a bare tmp_path.
    """

    def __init__(self, store_root, keyfile, *, structural=STRUCTURAL, derived=False):
        self.store_root = Path(store_root)
        self.keyfile = Path(keyfile)
        self.derived = bool(derived)
        for pat in structural:
            if any(c in PurePosixPath(pat).name for c in "*?["):
                raise VaultError(
                    f"structural pattern {pat!r} ends in a wildcard: that would leave every "
                    f"matching name in cleartext. The final component must be a literal."
                )
        self._structural = tuple(structural)
        self._dek: bytearray | None = None
        self._k_content: bytearray | None = None
        self._k_names: bytearray | None = None
        self._k_sentinel: bytearray | None = None
        self._k_scratch: bytearray | None = None
        self._siv: AESSIV | None = None

    # ---------------------------------------------------------------- lifecycle

    @classmethod
    def create(cls, store_root, keyfile, password: str, *, kdf: dict | None = None) -> tuple["Vault", str]:
        """Initialize a new store. Returns (vault, recovery_key).

        The recovery key is returned ONCE and never stored — only the wrap it produces is.
        """
        kdf = dict(kdf or DEFAULT_KDF)
        v = cls(store_root, keyfile)
        if v.keyfile.exists():
            raise VaultError(f"keyfile already exists: {v.keyfile}")

        dek = os.urandom(32)
        salt = os.urandom(16)
        master = _argon2(password, salt, kdf)
        recovery_raw = os.urandom(32)

        doc = {
            "version": 1,
            "kdf": {"algo": "argon2id", "salt": _b64e(salt), **{k: kdf[k] for k in ("memory_kib", "time_cost", "parallelism")}},
            "auth_verifier": _b64e(_hkdf(master, b"vocalis/auth/v1")),
            "wrap_password": _b64e(_wrap(_hkdf(master, b"vocalis/kek/v1"), dek)),
            "wrap_recovery": _b64e(_wrap(_hkdf(recovery_raw, b"vocalis/recovery/v1"), dek)),
        }
        v.store_root.mkdir(parents=True, exist_ok=True)
        v._write_keyfile(doc)
        v._install_dek(dek)
        v._write_sentinel()
        return v, _format_recovery_key(recovery_raw)

    def is_initialized(self) -> bool:
        return self.keyfile.exists()

    def is_unlocked(self) -> bool:
        return self._dek is not None

    def unlock_with_password(self, password: str) -> None:
        doc = self._read_keyfile()
        kdf = doc["kdf"]
        master = _argon2(password, _b64d(kdf["salt"]), kdf)
        if not secrets.compare_digest(_hkdf(master, b"vocalis/auth/v1"), _b64d(doc["auth_verifier"])):
            raise VaultAuthError("wrong password")
        self._finish_unlock(_unwrap(_hkdf(master, b"vocalis/kek/v1"), _b64d(doc["wrap_password"])))

    def unlock_with_recovery(self, recovery_key: str) -> None:
        doc = self._read_keyfile()
        raw = _parse_recovery_key(recovery_key)
        self._finish_unlock(_unwrap(_hkdf(raw, b"vocalis/recovery/v1"), _b64d(doc["wrap_recovery"])))

    def unlock_with_suk(self, suk: str) -> None:
        doc = self._read_keyfile()
        sess = doc.get("wrap_session")
        if not sess:
            raise VaultAuthError("no session wrap — log in with your password")
        if datetime.now(timezone.utc) > datetime.fromisoformat(sess["expires"]):
            self.revoke_suk()
            raise VaultAuthError("session unlock key has expired — log in with your password")
        self._finish_unlock(_unwrap(_hkdf(_b64d(suk), b"vocalis/suk/v1"), _b64d(sess["wrap"])))

    def issue_suk(self) -> str:
        """Mint a Session Unlock Key so a server restart can be re-unlocked silently.

        Safe: wrap_session is ciphertext under an unguessable random key that only ever
        lives in the browser's sessionStorage (RAM). It weakens nothing.
        """
        self._require_unlocked()
        suk = os.urandom(32)
        doc = self._read_keyfile()
        doc["wrap_session"] = {
            "wrap": _b64e(_wrap(_hkdf(suk, b"vocalis/suk/v1"), bytes(self._dek))),
            "expires": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
        }
        self._write_keyfile(doc)
        return _b64e(suk)

    def revoke_suk(self) -> None:
        doc = self._read_keyfile()
        if doc.pop("wrap_session", None) is not None:
            self._write_keyfile(doc)

    def change_password(self, old: str, new: str) -> None:
        """Re-wrap the DEK under a new password. Does NOT re-encrypt a byte of data."""
        doc = self._read_keyfile()
        kdf = doc["kdf"]
        master = _argon2(old, _b64d(kdf["salt"]), kdf)
        if not secrets.compare_digest(_hkdf(master, b"vocalis/auth/v1"), _b64d(doc["auth_verifier"])):
            raise VaultAuthError("wrong password")
        dek = _unwrap(_hkdf(master, b"vocalis/kek/v1"), _b64d(doc["wrap_password"]))

        salt = os.urandom(16)
        new_master = _argon2(new, salt, kdf)
        doc["kdf"] = {**kdf, "salt": _b64e(salt)}
        doc["auth_verifier"] = _b64e(_hkdf(new_master, b"vocalis/auth/v1"))
        doc["wrap_password"] = _b64e(_wrap(_hkdf(new_master, b"vocalis/kek/v1"), dek))
        doc.pop("wrap_session", None)  # a password change invalidates open sessions
        self._write_keyfile(doc)

    def set_password_unlocked(self, new: str) -> None:
        """Re-wrap the in-RAM DEK under a NEW password, WITHOUT presenting the old one.

        The recovery flow is "present the recovery key -> set a new password" (design §9.3),
        and the one thing a recovering user does not have is the OLD password -- so
        change_password() cannot serve it. M1 shipped only change_password(old, new), which
        means the recovery flow could not be built at all. This is that gap.

        Authority comes from being unlocked: the DEK is in RAM because unlock_with_recovery()
        just unwrapped it with the recovery key. That IS the proof, and it is the same proof
        design §9.3 relies on ("possession of the recovery key is itself sufficient").

        Re-encrypts nothing. Rewrites salt, auth_verifier and wrap_password; drops any open
        session wrap, because a password change invalidates open sessions.
        """
        self._require_unlocked()
        doc = self._read_keyfile()
        kdf = doc["kdf"]
        salt = os.urandom(16)
        master = _argon2(new, salt, kdf)
        doc["kdf"] = {**kdf, "salt": _b64e(salt)}
        doc["auth_verifier"] = _b64e(_hkdf(master, b"vocalis/auth/v1"))
        doc["wrap_password"] = _b64e(_wrap(_hkdf(master, b"vocalis/kek/v1"), bytes(self._dek)))
        doc.pop("wrap_session", None)
        self._write_keyfile(doc)

    def rotate_recovery(self) -> str:
        """Mint a NEW recovery key for the SAME DEK and REVOKE the old one. Returned ONCE.

        Until this existed, `wrap_recovery` was written exactly once — by `create()` — and never
        again, which made the recovery key the one credential in the system that could not be
        rotated. Neither `change_password` nor `set_password_unlocked` touches it, so changing the
        password did NOT revoke a recovery key that had leaked: it stayed a live master key to the
        data for the life of the vault. This is that gap.

        Authority comes from being unlocked, exactly as in `set_password_unlocked`: the DEK is in
        RAM, so the caller already has full access to every byte and can already change the
        password. Minting a recovery key grants strictly LESS than what they hold. It is not an
        escalation, which is why possession of the DEK is a sufficient bar. (The route above it
        demands the password again anyway — cheap, and it stops a hijacked open session from
        silently minting itself a permanent key.)

        Re-encrypts nothing and rewraps nothing else. In particular it does NOT drop
        `wrap_session`: the password and the DEK are both unchanged, so open sessions and any
        issued SUK stay valid. That is the deliberate difference from the two password paths,
        which drop it because the secret that minted those sessions is gone.

        ⚠️ Revocation is NOT retroactive across copies. Any backup holding an older
        `vault_keys.yaml` still carries the OLD `wrap_recovery`, and the old key still opens THAT
        copy forever. Rotating because a key leaked means the old keyfile backups have to go too.
        """
        self._require_unlocked()
        doc = self._read_keyfile()
        recovery_raw = os.urandom(32)
        doc["wrap_recovery"] = _b64e(_wrap(_hkdf(recovery_raw, b"vocalis/recovery/v1"), bytes(self._dek)))
        self._write_keyfile(doc)
        return _format_recovery_key(recovery_raw)

    def lock(self) -> None:
        for name in ("_dek", "_k_content", "_k_names", "_k_sentinel", "_k_scratch"):
            buf = getattr(self, name)
            if buf is not None:
                for i in range(len(buf)):  # best effort: CPython cannot guarantee no copy was made
                    buf[i] = 0
            setattr(self, name, None)
        self._siv = None

    # ---------------------------------------------------------------- keyfile / sentinel

    def _read_keyfile(self) -> dict:
        if not self.keyfile.exists():
            raise VaultError(f"vault is not initialized (no keyfile at {self.keyfile})")
        doc = yaml.safe_load(self.keyfile.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            raise VaultError(f"keyfile is malformed: {self.keyfile}")
        return doc

    def _write_keyfile(self, doc: dict) -> None:
        self.keyfile.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.keyfile.with_suffix(self.keyfile.suffix + ".part")
        tmp.write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True), encoding="utf-8")
        os.chmod(tmp, 0o600)  # chmod BEFORE the rename: never exists at the real path world-readable
        atomic_replace(tmp, self.keyfile)

    def _install_dek(self, dek: bytes) -> None:
        self._dek = bytearray(dek)
        self._k_content = bytearray(_hkdf(dek, b"vocalis/content/v1"))
        self._k_names = bytearray(_hkdf(dek, b"vocalis/names/v1", 64))  # 64B = AES-256-SIV
        self._k_sentinel = bytearray(_hkdf(dek, b"vocalis/sentinel/v1"))
        self._k_scratch = bytearray(_hkdf(dek, b"vocalis/scratch/v1"))
        self._siv = AESSIV(bytes(self._k_names))

    def _sentinel_path(self) -> Path:
        return self.store_root / SENTINEL_NAME

    def _write_sentinel(self) -> None:
        nonce = os.urandom(12)
        blob = nonce + AESGCM(bytes(self._k_sentinel)).encrypt(nonce, SENTINEL_PLAINTEXT, b"vocalis/sentinel/v1")
        self.store_root.mkdir(parents=True, exist_ok=True)
        tmp = self._sentinel_path().with_suffix(".part")
        tmp.write_bytes(blob)
        atomic_replace(tmp, self._sentinel_path())

    def _finish_unlock(self, dek: bytes) -> None:
        """Install the DEK, then PROVE it is the right one for this store before
        letting is_unlocked() return True.

        This is the guard against the disaster the sweep is about: a vault_keys.yaml
        restored from a backup that does not match this data store gives a correct
        password, a valid wrap, and the WRONG DEK. Every file would then look corrupt —
        and six modules answer a corrupt file by deleting it. So: verify a sentinel first,
        and refuse to open rather than hand out a key that makes the whole store look dead.

        The sentinel lives WITH THE DATA, not in the keyfile. A sentinel inside the keyfile
        would validate against its own DEK and catch exactly nothing. This is easy to get
        backward and the backward version is worthless.

        `derived=True` (the CACHE store — SPEC_5_0_M6 §3) relaxes exactly ONE case: a MISSING
        sentinel over existing content self-heals instead of refusing. It has to, because
        cache_root() is a cache and `clear_cache` is a shipped feature: delete it, let anything
        repopulate it, and a strict vault would see content-with-no-sentinel and refuse to open
        THE WHOLE STORE — including the install root that holds the actual data. A cleared cache
        would become a permanent lockout.

        Absence of evidence only. A sentinel that is PRESENT and FAILS is still fatal even when
        derived: that is not an absent proof, it is a positive one, and it says this cache was
        written under a different DEK. The recovery there is `rm -rf` on a CACHE, which costs GPU
        time and never data.
        """
        self._install_dek(dek)
        p = self._sentinel_path()
        if not p.exists():
            if self._store_has_content() and not self.derived:
                self.lock()
                raise VaultAuthError(
                    f"the store at {self.store_root} has content but no sentinel — refusing to "
                    f"unlock. Restore {SENTINEL_NAME}, or this key may not belong to this data."
                )
            if self.derived and self._store_has_content():
                logger.warning(
                    f"derived store {self.store_root} has content but no sentinel — writing a "
                    f"fresh one. If it was encrypted under a different key its files will now "
                    f"fail to authenticate INDIVIDUALLY (loudly, deleting nothing); clear the "
                    f"cache to reset it."
                )
            self._write_sentinel()  # first run against an empty store, or a derived store healing
            return
        blob = p.read_bytes()
        try:
            got = AESGCM(bytes(self._k_sentinel)).decrypt(blob[:12], blob[12:], b"vocalis/sentinel/v1")
        except (InvalidTag, ValueError) as e:
            self.lock()
            raise VaultAuthError(
                f"sentinel check FAILED for {self.store_root}: this key does not belong to this "
                f"data store. Refusing to unlock. (Nothing has been read, judged, or deleted.)"
            ) from e
        if got != SENTINEL_PLAINTEXT:
            self.lock()
            raise VaultAuthError("sentinel plaintext mismatch — refusing to unlock")

    def _store_has_content(self) -> bool:
        return any(p.name != SENTINEL_NAME for p in self.store_root.iterdir()) if self.store_root.exists() else False

    def _require_unlocked(self) -> None:
        if self._dek is None:
            raise VaultLocked("vault is locked — the DEK is not in RAM")

    # ---------------------------------------------------------------- name mapping

    def _is_structural(self, logical_dir: str) -> bool:
        return any(fnmatch.fnmatchcase(logical_dir, pat) for pat in self._structural)

    def _enc_name(self, name: str, parent: str) -> str:
        """AES-SIV. Deterministic (so a file can be found again) and bound to its parent
        (so chapter1.mp3 in two books does not encrypt identically)."""
        raw = self._siv.encrypt(name.encode("utf-8"), [parent.encode("utf-8")])
        enc = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
        if len(enc) > MAX_ENC_NAME:
            return LONG_PREFIX + hashlib.sha256(enc.encode("ascii")).hexdigest()[:32]
        return enc

    def _dec_name(self, enc: str, parent: str) -> str:
        """A name, or VaultAuthError.

        ⚠ Its ONE caller is `_logical_child`, and that caller CATCHES this and skips the entry
        rather than letting it stop the world — read its docstring before you change either.
        The raise is kept because "this name does not authenticate" is a real, distinct fact
        worth reporting up; what was wrong was treating it as proof of a bad key when the
        sentinel had already proved the opposite.
        """
        pad = "=" * (-len(enc) % 4)
        try:
            raw = base64.urlsafe_b64decode(enc + pad)
            return self._siv.decrypt(raw, [parent.encode("utf-8")]).decode("utf-8")
        except InvalidTag as e:
            raise VaultAuthError(f"filename authentication failed in {parent!r}: {enc}") from e
        except Exception as e:  # not base64, wrong length — a foreign file in our tree
            raise VaultAuthError(f"undecodable filename in {parent!r}: {enc}") from e

    def _long_companion(self, phys_dir: Path, enc: str) -> Path:
        return phys_dir / (enc + LONG_SUFFIX)

    def _map(self, logical) -> Path:
        """Logical path -> physical path. Structural components pass through in cleartext;
        every other component is SIV-encrypted under its logical parent."""
        self._require_unlocked()
        parts = PurePosixPath(str(logical).replace("\\", "/")).parts
        phys = self.store_root
        logical_so_far = ""
        for part in parts:
            nxt = f"{logical_so_far}/{part}" if logical_so_far else part
            if self._is_structural(nxt):
                phys = phys / part
            else:
                enc = self._enc_name(part, logical_so_far)
                if enc.startswith(LONG_PREFIX) and len(enc) == 33:
                    # long name: make sure the companion exists so listdir can reverse it
                    full = base64.urlsafe_b64encode(
                        self._siv.encrypt(part.encode("utf-8"), [logical_so_far.encode("utf-8")])
                    ).rstrip(b"=").decode("ascii")
                    comp = self._long_companion(phys, enc)
                    if not comp.exists():
                        phys.mkdir(parents=True, exist_ok=True)
                        comp.write_text(full, encoding="utf-8")
                phys = phys / enc
            logical_so_far = nxt
        return phys

    def _logical_child(self, logical_dir: str, phys_name: str, phys_dir: Path) -> str | None:
        """Resolve one physical directory entry to its logical name, or return `None` when the entry is not part of the vault. The unlock sentinel already verified the key, so an invalid encoded name is an unrelated or interrupted entry, not evidence of a wrong key. Skip it rather than failing every directory listing; log authentication failures because they may indicate tampering."""
        if phys_name.endswith(LONG_SUFFIX) or phys_name == SENTINEL_NAME:
            return None
        if phys_name.endswith(PART_SUFFIX):
            return None                       # open_write's temp — ours, in flight or orphaned
        child_logical = f"{logical_dir}/{phys_name}" if logical_dir else phys_name
        if self._is_structural(child_logical):
            return phys_name  # structural: on-disk name IS the logical name
        enc = phys_name
        if phys_name.startswith(LONG_PREFIX) and len(phys_name) == 33:
            comp = self._long_companion(phys_dir, phys_name)
            if not comp.exists():
                # unlink() drops the companion first, so a crash between the two leaves exactly
                # this. Unreachable-but-present, not a key failure.
                logger.error(f"vault: long-name companion missing for an entry in "
                             f"{logical_dir!r} — skipping it. It is not readable.")
                return None
            enc = comp.read_text(encoding="utf-8").strip()
        try:
            return self._dec_name(enc, logical_dir)
        except VaultAuthError as e:
            logger.error(f"vault: an entry in {logical_dir!r} is not ours and has been SKIPPED "
                         f"— {e}. The DEK is correct (the sentinel verified it at unlock); this "
                         f"is a foreign file, a crash leftover, or tampering.")
            return None

    # ---------------------------------------------------------------- structural migration

    def migrate_structural_names(self) -> list:
        """Move root entries whose fixed names are now structural and return the logical names moved. Promotion changes path mapping, so handle existing encrypted names before callers use the new mapping. The current format does not bind the filename into content authentication, and child names are bound to the unchanged logical parent, so a physical rename preserves decryptability without rewriting descendants. If the format later binds names, migration must decrypt and rewrite. The operation is idempotent and leaves both entries untouched when the target already exists."""
        moved = []
        for name in STRUCTURAL_FILES + STRUCTURAL_DIRS:
            if not self._is_structural(name):
                continue                     # not promoted in THIS vault's configuration
            new = self.store_root / name
            old = self.store_root / self._enc_name(name, "")
            if not old.exists():
                continue                     # already migrated, or never existed here
            if new.exists():
                logger.error(
                    f"vault: {name} exists BOTH as a structural name and under its old "
                    f"encrypted one ({old.name}). Not touching either — resolve by hand; the "
                    f"encrypted one is the pre-migration copy.")
                continue
            os.replace(old, new)
            # The long-name companion only exists past MAX_ENC_NAME (200) and these names are
            # nowhere near it, but a stale companion would make listdir report a phantom entry.
            (self.store_root / (old.name + LONG_SUFFIX)).unlink(missing_ok=True)
            moved.append(name)
            logger.info(f"vault: {name} migrated to its structural (cleartext) name — its "
                        f"CONTENTS remain encrypted")
        if moved:
            try:                             # make the renames durable (POSIX dir fsync)
                fd = os.open(str(self.store_root), os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            except OSError:
                pass
        return moved

    # ---------------------------------------------------------------- files

    def open_write(self, logical) -> BinaryIO:
        """Encrypting writer. Writes to a unique `<dest>.<token>.part` and atomically replaces
        on close. The token is load-bearing under concurrency — see `tts_utils.part_path`.

        Uses tts_utils.atomic_replace, not bare os.replace: on Windows os.replace raises
        PermissionError if a reader momentarily holds the destination open, and a UI poller
        very much does. This is load-bearing.
        """
        dest = self._map(logical)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # UNIQUE per writer, suffix still LAST so listdir SKIPS it — see _logical_child and
        # tts_utils.part_path. A shared temp here interleaves two ciphertexts into one file.
        tmp = part_path(dest, PART_SUFFIX)
        fh = open(tmp, "wb")

        def _finish(failed: bool) -> None:
            if failed:
                tmp.unlink(missing_ok=True)  # leave the previous file untouched
            else:
                atomic_replace(tmp, dest)

        return _BlockWriter(fh, bytes(self._k_content), _finish)

    def open_read(self, logical) -> BinaryIO:
        p = self._map(logical)
        if not p.exists():
            raise FileNotFoundError(f"no such vault file: {logical}")  # absent != corrupt
        raw = _BlockReader(open(p, "rb"), bytes(self._k_content), p.stat().st_size, str(logical))
        return io.BufferedReader(raw)

    def write_bytes(self, logical, data: bytes) -> None:
        w = self.open_write(logical)
        try:
            w.write(data)
        except BaseException:
            w.abort()
            raise
        w.close()

    def read_bytes(self, logical) -> bytes:
        with self.open_read(logical) as fh:
            return fh.read()

    def write_text(self, logical, s: str) -> None:
        self.write_bytes(logical, s.encode("utf-8"))

    def read_text(self, logical) -> str:
        return self.read_bytes(logical).decode("utf-8")

    def write_yaml(self, logical, obj) -> None:
        """PyYAML, matching the codebase exactly (safe_dump, sort_keys=False,
        allow_unicode=True). Do not switch to ruamel: nothing here imports it."""
        self.write_text(logical, yaml.safe_dump(obj, sort_keys=False, allow_unicode=True))

    def read_yaml(self, logical):
        """safe_load; a non-dict document reads as None, exactly like the sidecar readers.

        NOTE what this does NOT do: it does not catch. A VaultAuthError from a wrong key
        propagates — that is the entire point (see the class docstring). Only genuinely
        malformed *plaintext* YAML degrades to None.
        """
        d = yaml.safe_load(self.read_text(logical))
        return d if isinstance(d, dict) else None

    def stream_range_chunks(self, logical, start: int, end: int, chunk: int = BLOCK):
        """Plaintext bytes [start, end] INCLUSIVE, yielded in `chunk`-sized pieces — the
        generator form of stream_range, and what anything serving HTTP 206 must use.

        Identical decryption work (only the blocks the range overlaps), bounded memory.
        stream_range() hands back the whole range as ONE bytes object, which is harmless
        until the range IS the whole file — and `bytes=0-` is exactly that, and is what a
        browser sends as its FIRST request for any <audio>/<video> src. Serving a 200 MB
        audiobook that way allocated 200 MB per request: precisely the cost
        send_store_file's full-body path was written to avoid, coming back through the
        range door.
        """
        with self.open_read(logical) as fh:
            fh.seek(start)
            remaining = max(0, end - start + 1)
            while remaining > 0:
                buf = fh.read(min(chunk, remaining))
                if not buf:
                    # Intact files cannot get here: the caller's length comes from stat(),
                    # which is derived from the ciphertext size. Stop rather than spin.
                    break
                remaining -= len(buf)
                yield buf

    def stream_range(self, logical, start: int, end: int) -> bytes:
        """Plaintext bytes [start, end] INCLUSIVE — HTTP Range semantics.

        Decrypts only the blocks the range overlaps. This is what lets a browser seek in a
        90 MB audiobook without decrypting from byte zero on every Range request.

        MATERIALIZES the range. Prefer stream_range_chunks() for anything served over HTTP —
        see the note there about `bytes=0-`.
        """
        return b"".join(self.stream_range_chunks(logical, start, end))

    # ---------------------------------------------------------------- metadata / tree

    def exists(self, logical) -> bool:
        return self._map(logical).exists()

    def is_dir(self, logical) -> bool:
        """A directory is a logical path like any other — its NAME is encrypted unless it is
        structural, but its dir-ness is a fact about the physical inode either way.

        listdir() answers "what is in here" and cannot answer "is this a here at all", which
        is the question every library-listing loop opens with (`for d in root.iterdir(): if
        not d.is_dir(): continue`)."""
        return self._map(logical).is_dir()

    def stat(self, logical) -> VaultStat:
        """PLAINTEXT size (derived, O(1), no decryption) + the real filesystem mtime.

        The mtime is the physical file's, deliberately: nomi_speak's cache key, the
        clear_cache os.utime (which is implemented as nothing BUT an os.utime), and
        voice_settings.yaml's reload-poll all need an mtime that actually moves when the
        file is rewritten. A header-stored mtime would go stale and silently break all three.
        """
        st = self._map(logical).stat()
        return VaultStat(size=plaintext_len(st.st_size), mtime=st.st_mtime, mtime_ns=st.st_mtime_ns)

    def utime(self, logical, times=None, *, ns=None) -> None:
        """`ns=(atime_ns, mtime_ns)` is what the migration uses to restore a file's ORIGINAL
        mtime to the nanosecond (SPEC_5_0_M9 §5). The atomic replace in `open_write` stamps the
        ciphertext with *now*; every `(size, mtime)`-keyed cache in the app — enhance, bandwidth,
        clip durations, M4's song index, and SWAP IDENTITY — must survive the migration
        byte-for-byte, so M9 stamps it straight back. `os.utime` refuses both `times` and `ns`
        at once, hence the branch."""
        if ns is not None:
            os.utime(self._map(logical), ns=ns)
        else:
            os.utime(self._map(logical), times)

    def unlink(self, logical, missing_ok: bool = False) -> None:
        p = self._map(logical)
        if p.name.startswith(LONG_PREFIX) and len(p.name) == 33:
            self._long_companion(p.parent, p.name).unlink(missing_ok=True)
        p.unlink(missing_ok=missing_ok)

    def rename(self, src_logical, dst_logical) -> None:
        """Rename a FILE. 🔴 A DIRECTORY RENAME IS NOT POSSIBLE HERE AND MUST NOT BE ATTEMPTED.

        `_enc_name` binds every name to its logical PARENT as the SIV's associated data — that is
        deliberate and load-bearing (§3.6: it is what stops `chapter1.mp3` in two different books
        from encrypting to the same physical name). The cost is that a name is only valid in the
        directory it was written in.

        So moving a directory RE-PARENTS every file inside it, and not one of them decrypts under
        the new parent any more. Verified by doing it: assemble a stem set in `<dest>.part`, rename
        the folder to `<dest>`, and `listdir` comes back **empty** while every read raises
        FileNotFoundError. The files are still on disk. They are simply unnameable, forever.

        That is a data-loss bug of the worst kind — twenty minutes of Demucs lands as an empty set
        and the commit reports success — and the `.part`-directory-then-one-rename idiom, which is
        the CORRECT and idiomatic thing to do on a real filesystem, walks straight into it. It is
        used in this codebase. So the vault refuses, loudly, rather than leaving the trap open.

        (It would once have been loud by accident: an orphaned child raised VaultAuthError from
        listdir. It does not any more — a crash-orphaned `.part` must not look like a wrong key —
        so this guard is now the ONLY thing standing here.)

        **What to do instead:** write each file to its final logical path and make the last write
        the one that publishes the set — a sidecar, a marker, whatever the readers key on.
        `open_write` is already atomic per file.
        """
        src, dst = self._map(src_logical), self._map(dst_logical)
        if src.is_dir():
            raise VaultError(
                f"cannot rename a DIRECTORY inside the vault ({src_logical} -> {dst_logical}): "
                f"every name in it is encrypted against its parent, so the files would survive "
                f"the move and become permanently unreadable. Write to the final path and "
                f"publish with the last write instead.")
        dst.parent.mkdir(parents=True, exist_ok=True)
        atomic_replace(src, dst)
        if src.name.startswith(LONG_PREFIX) and len(src.name) == 33:
            self._long_companion(src.parent, src.name).unlink(missing_ok=True)

    def mkdir(self, logical, parents: bool = True, exist_ok: bool = True) -> None:
        self._map(logical).mkdir(parents=parents, exist_ok=exist_ok)

    def rmtree(self, logical) -> None:
        shutil.rmtree(self._map(logical), ignore_errors=True)

    def listdir(self, logical_dir="") -> list[str]:
        """LOGICAL names. Decrypts each entry; opens zero files.

        This is what replaces every glob("*_{h8}.mp3") the sweep says "dies" under
        encryption — and why no persistent name index is needed. An index would be a
        second source of truth that can go stale; the filesystem cannot.
        """
        self._require_unlocked()
        d = self._map(logical_dir) if str(logical_dir) else self.store_root
        if not d.exists():
            return []
        ld = str(logical_dir).replace("\\", "/").strip("/")
        out = []
        for entry in sorted(os.listdir(d)):
            name = self._logical_child(ld, entry, d)
            if name is not None:
                out.append(name)
        return out

    def iterdir(self, logical_dir="") -> Iterator[str]:
        yield from self.listdir(logical_dir)

    def glob(self, logical_dir, pattern: str) -> list[str]:
        return [n for n in self.listdir(logical_dir) if fnmatch.fnmatch(n, pattern)]

    # ---------------------------------------------------------------- scratch boundary

    def export_plaintext(self, logical) -> BinaryIO:
        """An explicitly user-initiated plaintext read (a download). Same bytes as
        open_read — this exists so the intent is greppable, and auditable."""
        return self.open_read(logical)

    def decrypt_to_scratch(self, logical, scratch_dir) -> Path:
        """Materialize plaintext for a CHILD PROCESS (ffmpeg, Demucs, RVC) that insists on
        a path. The ONLY sanctioned way plaintext reaches disk.

        The scratch name is OPAQUE — derived from a hash, never from the logical name —
        because the sweep found the words riding into child processes AS FILENAMES
        (SWEEP §4: chapter titles in _concat_list.txt, the Playground prompt as a clip
        filename, song titles as the Demucs input). The suffix is kept: ffmpeg and Demucs
        sniff format by extension.

        🔴 ONE FILE PER CALL, NOT PER SOURCE (October 9, 2026). The name used to be the hash of
        the logical path alone, so two jobs reading the same clip at once got the SAME scratch
        file: the second decrypt truncated it under the first job's ffmpeg, and whichever
        finished first deleted it (`child_input`) while the other was still reading. Live, four
        Clean up trims of one clip started together all decoded nothing and failed. A random
        part keeps the name opaque and makes every call's copy its own. Callers already use the
        returned path and never recompute it; the scratch sweep removes leftovers by directory,
        not by name.
        """
        scratch_dir = Path(scratch_dir)
        scratch_dir.mkdir(parents=True, exist_ok=True)
        lp = PurePosixPath(str(logical).replace("\\", "/"))
        key = f"{lp}|{secrets.token_hex(8)}"
        opaque = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16] + lp.suffix
        out = scratch_dir / opaque
        with self.open_read(logical) as src, open(out, "wb") as dst:
            shutil.copyfileobj(src, dst, length=BLOCK)
        return out

    def encrypt_from_scratch(self, path, logical) -> None:
        """The reverse seam: bring a child process's OUTPUT back into the vault.

        Design §6.3's sketch omits this, but children write as well as read — Demucs, RVC
        and every path-out ffmpeg call produce files that must come back in. Without it,
        M7 cannot land.
        """
        with open(path, "rb") as src:
            w = self.open_write(logical)
            try:
                shutil.copyfileobj(src, w, length=BLOCK)
            except BaseException:
                w.abort()
                raise
            w.close()
