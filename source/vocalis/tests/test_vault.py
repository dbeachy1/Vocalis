"""Tests for src/vault.py — Vocalis 5.0-M1, the encryption primitive.

The ship gate from SPEC_5_0_M1 §8. The tests that matter most are the ones
guarding DATA LOSS, not the ones guarding secrecy: SWEEP §2 found that under encryption a
wrong key is indistinguishable from a corrupt file, and six modules answer a corrupt file
by deleting and regenerating it. Tests 6-9 and 10-14 are that guarantee.

KDF params here are deliberately weak (8 MiB / t=1 / p=1 -> ~4 ms) so the suite stays fast.
They are persisted in the keyfile, so this needs no env var and no production code path.
"""
import base64
import io
import os

import pytest
import soundfile as sf
import numpy as np
import yaml

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vault
from vault import Vault, VaultAuthError, VaultError, VaultLocked

PW = "correct horse battery staple"
TEST_KDF = {"algo": "argon2id", "memory_kib": 8192, "time_cost": 1, "parallelism": 1}


@pytest.fixture
def store(tmp_path):
    """An initialized, unlocked vault. Roots are plain args — no monkeypatching needed,
    which is the whole point of the pure-library shape."""
    v, rk = Vault.create(tmp_path / "store", tmp_path / "vault_keys.yaml", PW, kdf=TEST_KDF)
    v.recovery_key = rk
    return v


def _second_vault(tmp_path, name="store"):
    return Vault(tmp_path / name, tmp_path / "vault_keys.yaml")


SIZES = [0, 1, 15, 16, 17, 65535, 65536, 65537, 131071, 131072, 131073, 1024 * 1024]


# ------------------------------------------------------------------ 1-5: the codec

@pytest.mark.parametrize("n", SIZES)
def test_roundtrip_sizes(store, n):
    data = os.urandom(n)
    store.write_bytes("f.bin", data)
    assert store.read_bytes("f.bin") == data


@pytest.mark.parametrize("n", SIZES)
def test_stat_size_is_plaintext_size(store, n):
    """stat() reports the PLAINTEXT size, derived in O(1) from the ciphertext size with no
    decryption. The whole reason the header carries no length field (SPEC §3.3)."""
    store.write_bytes("f.bin", os.urandom(n))
    assert store.stat("f.bin").size == n


def test_range_seeks(store):
    data = bytes(i % 251 for i in range(300_000))  # ~4.6 blocks
    store.write_bytes("a.bin", data)
    for start, end in [
        (0, 0),                    # 1 byte
        (10, 99),                  # within one block
        (65_000, 66_000),          # spanning a block boundary
        (60_000, 200_000),         # spanning three blocks
        (299_000, 299_999),        # to EOF
        (0, 299_999),              # everything
    ]:
        assert store.stream_range("a.bin", start, end) == data[start:end + 1], (start, end)


def test_range_reads_only_touched_blocks(store):
    """The O(1)-seek claim, actually measured: reading inside block 40 of a 100-block file
    must decrypt ONE block, not 41. This is the property that makes a browser seeking in a
    90 MB audiobook cheap instead of quadratic."""
    store.write_bytes("big.bin", os.urandom(100 * vault.BLOCK))
    fh = store.open_read("big.bin")
    raw = fh.raw
    fh.seek(40 * vault.BLOCK + 100)
    fh.read(100)
    assert raw.blocks_read == 1
    fh.close()


def test_seekable_reader_feeds_soundfile(store):
    """The M6 seam: chatterbox/soundfile need a seekable file-like, not a path."""
    wav = np.sin(np.linspace(0, 100, 24000)).astype("float32")
    buf = io.BytesIO()
    sf.write(buf, wav, 24000, format="WAV")
    store.write_bytes("voice.wav", buf.getvalue())

    with store.open_read("voice.wav") as fh:
        got, sr = sf.read(fh)
    assert sr == 24000
    assert len(got) == len(wav)
    assert np.allclose(got, wav, atol=1e-4)


# ------------------------------------------------- 6-9: 🔴 the data-loss guarantees

@pytest.mark.parametrize("n", [0, 100, 200_000])
def test_wrong_key_raises_VaultAuthError(store, tmp_path, n):
    """A file written under key A, read under key B must RAISE — never return falsy.

    n=0 is not padding: an empty file has no bytes for a read to touch, so it is the one
    case where a reader can hand back b"" having authenticated nothing at all. It did,
    once. Keep it here.
    """
    store.write_bytes("secret.bin", os.urandom(n))
    other, _ = Vault.create(tmp_path / "store2", tmp_path / "keys2.yaml", PW, kdf=TEST_KDF)

    # Same ciphertext, different DEK. (This is the CONTENT failure in isolation; the
    # sentinel that stops you ever getting here is tests 8/9.)
    raw = store._map("secret.bin").read_bytes()
    with open(other.store_root / "x.bin", "wb") as fh:
        fh.write(raw)
    with pytest.raises(VaultAuthError):
        with open(other.store_root / "x.bin", "rb") as fh:
            vault._BlockReader(fh, bytes(other._k_content), len(raw), "x.bin").read()


def test_VaultAuthError_is_not_an_Exception(store):
    """🔴 THE most important assertion in M1.

    VaultAuthError deliberately does NOT subclass Exception, so that the six
    `except Exception: return {}` sites the sweep found CANNOT swallow it and go on to
    delete the file they failed to read. Data loss is the dominant hazard; a loudly hung
    job beats silently deleted chunks.

    If someone "fixes" vault.py to make this a normal Exception, this test fails and tells
    them why. That is its job.
    """
    assert not issubclass(VaultAuthError, Exception)
    assert not issubclass(VaultAuthError, (OSError, ValueError, KeyError))
    assert issubclass(VaultAuthError, BaseException)


def test_the_swallowers_cannot_swallow_it(store, tmp_path):
    """The real-world proof: reproduce the exact idiom from the six modules the sweep
    named (`except Exception: return {}` -> caller deletes) and show it does NOT catch."""
    store.write_bytes("clip.yaml", b"")
    phys = store._map("clip.yaml")
    phys.write_bytes(b"VLT1\x01\x00\x00\x00" + os.urandom(24))  # a file we cannot authenticate

    deleted = []

    def read_meta_like_stems_does():
        try:
            return store.read_yaml("clip.yaml")
        except Exception:            # <- playground_clips.py:252, stems.py:151, book_state.py:78
            deleted.append("clip.yaml")   # <- and then the caller regenerates/overwrites
            return {}

    with pytest.raises(VaultAuthError):
        read_meta_like_stems_does()
    assert deleted == [], "the swallower caught it — a wrong key would now destroy user data"


def test_wrong_password_refuses_unlock(store, tmp_path):
    v = _second_vault(tmp_path)
    with pytest.raises(VaultAuthError):
        v.unlock_with_password("not the password")
    assert not v.is_unlocked(), "no key may be handed out after a failed unlock"


def test_sentinel_mismatch_refuses_unlock(tmp_path):
    """🔴 The backup-restore disaster, in one test.

    A vault_keys.yaml restored from a backup that does not match this data store yields a
    CORRECT password, a VALID wrap, and the WRONG DEK. Every file then looks corrupt — and
    six modules answer a corrupt file by deleting it. The sentinel must catch this at
    unlock, before a single file is judged.
    """
    store_a = tmp_path / "data"
    v, _ = Vault.create(store_a, tmp_path / "keys_a.yaml", PW, kdf=TEST_KDF)
    v.write_bytes("book/ch1.mp3", b"eighteen hours of rendering")

    # A different vault -- same password, different DEK.
    Vault.create(tmp_path / "elsewhere", tmp_path / "keys_b.yaml", PW, kdf=TEST_KDF)

    wrong = Vault(store_a, tmp_path / "keys_b.yaml")          # right data, WRONG keyfile
    with pytest.raises(VaultAuthError):
        wrong.unlock_with_password(PW)                        # the password is CORRECT
    assert not wrong.is_unlocked()

    # And nothing was touched: the real vault still reads every byte.
    v2 = Vault(store_a, tmp_path / "keys_a.yaml")
    v2.unlock_with_password(PW)
    assert v2.read_bytes("book/ch1.mp3") == b"eighteen hours of rendering"


# --------------------------------------------- 10-14: tamper / truncate / transplant

def _corrupt(store, logical, fn):
    p = store._map(logical)
    p.write_bytes(fn(p.read_bytes()))


def test_truncation_detected(store):
    store.write_bytes("f.bin", os.urandom(200_000))
    _corrupt(store, "f.bin", lambda b: b[:-1])
    with pytest.raises(VaultAuthError):
        store.read_bytes("f.bin")


def test_whole_block_truncation_detected(store):
    store.write_bytes("f.bin", os.urandom(200_000))
    _corrupt(store, "f.bin", lambda b: b[: -vault.CT_BLOCK])
    with pytest.raises(VaultAuthError):
        store.read_bytes("f.bin")


def test_extension_detected(store):
    store.write_bytes("f.bin", os.urandom(1000))
    _corrupt(store, "f.bin", lambda b: b + os.urandom(64))
    with pytest.raises(VaultAuthError):
        store.read_bytes("f.bin")


def test_body_tamper_detected(store):
    store.write_bytes("f.bin", os.urandom(1000))
    _corrupt(store, "f.bin", lambda b: b[:50] + bytes([b[50] ^ 0x01]) + b[51:])
    with pytest.raises(VaultAuthError):
        store.read_bytes("f.bin")


def test_header_tamper_detected(store):
    """The header is cleartext but AUTHENTICATED — it is in every block's AAD."""
    store.write_bytes("f.bin", os.urandom(1000))
    _corrupt(store, "f.bin", lambda b: b[:10] + bytes([b[10] ^ 0xFF]) + b[11:])  # nonce_prefix
    with pytest.raises(VaultAuthError):
        store.read_bytes("f.bin")


def test_bad_magic_detected(store):
    store.write_bytes("f.bin", b"hello")
    _corrupt(store, "f.bin", lambda b: b"XXXX" + b[4:])
    with pytest.raises(VaultAuthError):
        store.read_bytes("f.bin")


def test_cross_file_block_transplant_rejected(store):
    """Same key, same offset, different file. The per-file nonce prefix lives in both the
    nonce and the AAD, so a transplanted block cannot authenticate."""
    a, b = os.urandom(200_000), os.urandom(200_000)
    store.write_bytes("a.bin", a)
    store.write_bytes("b.bin", b)
    pa, pb = store._map("a.bin"), store._map("b.bin")
    ba, bb = pa.read_bytes(), pb.read_bytes()
    lo, hi = vault.HEADER_LEN, vault.HEADER_LEN + vault.CT_BLOCK      # block 0
    pb.write_bytes(bb[:lo] + ba[lo:hi] + bb[hi:])
    with pytest.raises(VaultAuthError):
        store.read_bytes("b.bin")


def test_block_reorder_rejected(store):
    """The block index is in both the nonce and the AAD."""
    store.write_bytes("f.bin", os.urandom(200_000))
    p = store._map("f.bin")
    raw = p.read_bytes()
    h, cb = vault.HEADER_LEN, vault.CT_BLOCK
    b0, b1 = raw[h:h + cb], raw[h + cb:h + 2 * cb]
    p.write_bytes(raw[:h] + b1 + b0 + raw[h + 2 * cb:])
    with pytest.raises(VaultAuthError):
        store.read_bytes("f.bin")


# ------------------------------------------------------------------ 15-19: names

def test_names_deterministic_and_parent_bound(store):
    store.write_bytes("books/novel.txt", b"x")
    store.write_bytes("stems/novel.txt", b"y")
    n1 = store._map("books/novel.txt").name
    n2 = store._map("stems/novel.txt").name
    assert n1 == store._map("books/novel.txt").name, "must be deterministic — else nothing is findable"
    assert n1 != n2, "same name under two parents must not encrypt identically (design 6.2 detail 2)"


def test_listdir_returns_logical_names_and_disk_leaks_nothing(store):
    names = ["Chapter 1 — Sample Chapter.mp3", "Ünïcødé ✨.wav", "plain.yaml"]
    for n in names:
        store.write_bytes(f"books/{n}", b"data")
    assert sorted(store.listdir("books")) == sorted(names)

    on_disk = [p.name for p in (store.store_root / "books").iterdir()]
    for n in names:
        for token in ("Chapter", "Sample Chapter", "Ünïcødé", "plain", ".mp3", ".wav", ".yaml"):
            assert not any(token in d for d in on_disk), f"{token!r} leaked into a filename"


def test_glob_over_logical_names(store):
    """The pattern the sweep says 'dies' under encryption. It does not — listdir gives
    back logical names, so fnmatch works and no name index is needed (SPEC §3.7)."""
    for n in ["song_a1b2c3d4.mp3", "song_deadbeef.mp3", "notes.yaml", "take.wav"]:
        store.write_bytes(f"playground/{n}", b"d")
    assert sorted(store.glob("playground", "*.mp3")) == ["song_a1b2c3d4.mp3", "song_deadbeef.mp3"]
    assert store.glob("playground", "*_a1b2c3d4.mp3") == ["song_a1b2c3d4.mp3"]
    assert store.glob("playground", "*.wav") == ["take.wav"]


def test_long_name_fallback(store):
    """A 240-char chapter title overflows base64(SIV(name)) past the 255-byte Linux limit."""
    long_name = ("Sample Chapter With A Deliberately Long Synthetic Title " * 5)[:240] + ".mp3"
    assert len(long_name) > vault.MAX_ENC_NAME
    store.write_bytes(f"books/{long_name}", b"content")

    assert store.read_bytes(f"books/{long_name}") == b"content"
    assert store.listdir("books") == [long_name]

    entries = [p.name for p in (store.store_root / "books").iterdir()]
    assert any(e.endswith(vault.LONG_SUFFIX) for e in entries), "companion file missing"
    assert all(len(e) <= 255 for e in entries), "a name overflowed the filesystem limit"

    store.unlink(f"books/{long_name}")
    assert store.listdir("books") == []
    assert list((store.store_root / "books").iterdir()) == [], "companion was orphaned"


def test_structural_stays_cleartext_but_private_does_not(store):
    store.write_bytes("output/Test Book One/mp3/01 - Sample Chapter.mp3", b"audio")

    assert (store.store_root / "output").is_dir(), "structural dirs stay navigable"
    book_dirs = [p.name for p in (store.store_root / "output").iterdir()]
    assert book_dirs and "Test Book One" not in book_dirs, "the book title leaked into the path"

    inner = store.store_root / "output" / book_dirs[0]
    assert (inner / "mp3").is_dir(), "output/*/mp3 is structural"
    assert "01 - Sample Chapter.mp3" not in [p.name for p in (inner / "mp3").iterdir()]
    assert store.read_bytes("output/Test Book One/mp3/01 - Sample Chapter.mp3") == b"audio"


def test_a_book_named_output_does_not_collide(store):
    """The trap in 'structural dirs stay cleartext': done by NAME, a book actually named
    'output' would collide with the real output/ directory. Structural-ness is decided by
    the full logical path, so output/output is private and encrypted (SPEC §3.6)."""
    store.write_bytes("output/output/mp3/ch1.mp3", b"tricky")
    store.write_bytes("output/normal/mp3/ch1.mp3", b"ordinary")

    kids = [p.name for p in (store.store_root / "output").iterdir()]
    assert "output" not in kids, "a book named 'output' was left in cleartext and collided"
    assert len(kids) == 2
    assert store.read_bytes("output/output/mp3/ch1.mp3") == b"tricky"
    assert store.read_bytes("output/normal/mp3/ch1.mp3") == b"ordinary"


def test_structural_pattern_ending_in_wildcard_is_rejected(tmp_path):
    """'output/*' would make every book title structural — i.e. plaintext. Fail loudly."""
    with pytest.raises(VaultError, match="wildcard"):
        Vault(tmp_path / "s", tmp_path / "k.yaml", structural=("output", "output/*"))


# ------------------------------------------------------------------ 20-22: key lifecycle

def test_password_change_preserves_data(store, tmp_path):
    """The hard requirement: a password change re-wraps the DEK and re-encrypts NOTHING."""
    store.write_bytes("books/a.txt", b"before")
    store.write_bytes("output/b/mp3/c.mp3", b"audio")
    before = store._map("books/a.txt").read_bytes()

    store.change_password(PW, "a brand new password")

    v = _second_vault(tmp_path)
    with pytest.raises(VaultAuthError):
        v.unlock_with_password(PW)
    v.unlock_with_password("a brand new password")
    assert v.read_bytes("books/a.txt") == b"before"
    assert v.read_bytes("output/b/mp3/c.mp3") == b"audio"
    assert store._map("books/a.txt").read_bytes() == before, "data was re-encrypted — it must not be"


def test_recovery_unwrap(store, tmp_path):
    store.write_bytes("books/a.txt", b"payload")
    v = _second_vault(tmp_path)
    v.unlock_with_recovery(store.recovery_key)
    assert v.read_bytes("books/a.txt") == b"payload"


def test_recovery_key_is_transcribable(store):
    rk = store.recovery_key
    assert "-" in rk and all(len(g) <= 5 for g in rk.split("-"))
    assert set(rk.replace("-", "")) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")


def test_wrong_recovery_key_rejected(store, tmp_path):
    v = _second_vault(tmp_path)
    bogus = vault._format_recovery_key(os.urandom(32))
    with pytest.raises(VaultAuthError):
        v.unlock_with_recovery(bogus)
    assert not v.is_unlocked()


# ------------------------------------------------------------------ recovery-key rotation

def test_rotate_recovery_revokes_the_old_key(store, tmp_path):
    """The point of the feature. Before it existed `wrap_recovery` was written once by create()
    and never again, so a leaked recovery key stayed a live master key for the life of the vault
    — no password change touched it."""
    store.write_bytes("books/a.txt", b"payload")
    old = store.recovery_key

    new = store.rotate_recovery()
    assert new != old

    v = _second_vault(tmp_path)
    with pytest.raises(VaultAuthError):
        v.unlock_with_recovery(old)
    assert not v.is_unlocked(), "a rejected old key must leave the store locked"

    v2 = _second_vault(tmp_path)
    v2.unlock_with_recovery(new)
    assert v2.read_bytes("books/a.txt") == b"payload"


def test_rotate_recovery_is_transcribable(store):
    """Same BitLocker-style grouping as the minted-at-init key — it gets written on paper."""
    rk = store.rotate_recovery()
    assert "-" in rk and all(len(g) <= 5 for g in rk.split("-"))
    assert set(rk.replace("-", "")) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")


def test_rotate_recovery_touches_neither_password_nor_data(store, tmp_path):
    """Rotation rewraps ONE slot. It must not re-encrypt a byte, and it must not disturb the
    password wrap — the failure mode being guarded is "rotated my recovery key, now I can't
    log in"."""
    store.write_bytes("books/a.txt", b"before")
    before = store._map("books/a.txt").read_bytes()

    store.rotate_recovery()

    v = _second_vault(tmp_path)
    v.unlock_with_password(PW)
    assert v.read_bytes("books/a.txt") == b"before"
    assert store._map("books/a.txt").read_bytes() == before, "data was re-encrypted — it must not be"


def test_rotate_recovery_keeps_open_sessions(store, tmp_path):
    """The deliberate difference from change_password/set_password_unlocked, which both drop
    `wrap_session` because the secret that minted those sessions is gone. Here the password and
    the DEK are both unchanged, so an issued SUK is still good — rotating a recovery key must
    not sign the user out of SillyTavern."""
    store.write_bytes("books/a.txt", b"payload")
    suk = store.issue_suk()

    store.rotate_recovery()

    v = _second_vault(tmp_path)
    v.unlock_with_suk(suk)
    assert v.read_bytes("books/a.txt") == b"payload"


def test_rotate_recovery_requires_unlocked(tmp_path):
    """Authority IS the DEK being in RAM. With no DEK there is nothing to rewrap, and the
    keyfile must be left exactly as it was rather than half-written."""
    v, _ = Vault.create(tmp_path / "store", tmp_path / "vault_keys.yaml", PW, kdf=TEST_KDF)
    v.lock()
    before = (tmp_path / "vault_keys.yaml").read_text(encoding="utf-8")
    with pytest.raises(VaultLocked):
        v.rotate_recovery()
    assert (tmp_path / "vault_keys.yaml").read_text(encoding="utf-8") == before


def test_rotate_recovery_twice_revokes_the_intermediate(store, tmp_path):
    """Only the newest key survives — rotation replaces the slot, it does not add one."""
    first = store.rotate_recovery()
    second = store.rotate_recovery()
    v = _second_vault(tmp_path)
    with pytest.raises(VaultAuthError):
        v.unlock_with_recovery(first)
    _second_vault(tmp_path).unlock_with_recovery(second)


def test_suk_roundtrip(store, tmp_path):
    """A server restart must not silently kill Nomi/SillyTavern audio."""
    store.write_bytes("books/a.txt", b"payload")
    suk = store.issue_suk()

    v = _second_vault(tmp_path)          # a "restarted" server: nothing in RAM
    assert not v.is_unlocked()
    v.unlock_with_suk(suk)
    assert v.read_bytes("books/a.txt") == b"payload"


def test_suk_revoked_and_expired(store, tmp_path):
    suk = store.issue_suk()
    store.revoke_suk()
    v = _second_vault(tmp_path)
    with pytest.raises(VaultAuthError):
        v.unlock_with_suk(suk)

    suk2 = store.issue_suk()
    doc = yaml.safe_load(store.keyfile.read_text(encoding="utf-8"))
    doc["wrap_session"]["expires"] = "2020-01-01T00:00:00+00:00"
    store.keyfile.write_text(yaml.safe_dump(doc), encoding="utf-8")
    v2 = _second_vault(tmp_path)
    with pytest.raises(VaultAuthError):
        v2.unlock_with_suk(suk2)


def test_password_change_invalidates_sessions(store, tmp_path):
    suk = store.issue_suk()
    store.change_password(PW, "new one")
    v = _second_vault(tmp_path)
    with pytest.raises(VaultAuthError):
        v.unlock_with_suk(suk)


def test_keyfile_never_holds_the_dek(store):
    """The invariant: the DEK exists wrapped on disk and unwrapped in RAM. Nowhere else."""
    raw = store.keyfile.read_bytes()
    assert bytes(store._dek) not in raw
    assert base64.b64encode(bytes(store._dek)) not in raw
    for k in (store._k_content, store._k_names, store._k_sentinel):
        assert bytes(k) not in raw


# ------------------------------------------------------------------ 23-26: misc

def test_atomic_write_leaves_no_partial_and_does_not_clobber(store):
    store.write_bytes("f.bin", b"original")
    w = store.open_write("f.bin")
    w.write(b"a failed render")
    w.abort()

    assert store.read_bytes("f.bin") == b"original", "an aborted write clobbered the good file"
    parent = store._map("f.bin").parent
    assert not any(p.name.endswith(".part") for p in parent.iterdir()), "a .part file was orphaned"


def test_scratch_roundtrip_with_opaque_name(store, tmp_path):
    """decrypt_to_scratch is the only sanctioned way plaintext reaches disk — and the
    scratch name must NOT carry the words (SWEEP §4: the prompt rode into Applio as a
    filename, chapter titles into ffmpeg's concat list)."""
    scratch = tmp_path / "scratch"
    store.write_bytes("books/Test Book Two.mp3", b"audio bytes")

    p = store.decrypt_to_scratch("books/Test Book Two.mp3", scratch)
    assert p.read_bytes() == b"audio bytes"
    assert p.suffix == ".mp3", "children sniff format by extension — keep the suffix"
    assert "Test" not in p.name and "Book" not in p.name and "Two" not in p.name, "the title rode into scratch"

    store.encrypt_from_scratch(p, "books/back.mp3")
    assert store.read_bytes("books/back.mp3") == b"audio bytes"


def test_two_scratch_copies_of_one_file_are_independent(store, tmp_path):
    """October 9, 2026: the scratch name was the hash of the logical path alone, so two jobs on
    the same clip shared ONE plaintext file and the first to finish deleted it under the other
    (four simultaneous Clean up trims of one clip all decoded nothing). Each call gets its own."""
    scratch = tmp_path / "scratch"
    store.write_bytes("voice_training/clip.mp3", b"audio bytes")

    first = store.decrypt_to_scratch("voice_training/clip.mp3", scratch)
    second = store.decrypt_to_scratch("voice_training/clip.mp3", scratch)

    assert first != second
    assert first.suffix == second.suffix == ".mp3"
    first.unlink()                                   # the first job finishes and cleans up
    assert second.read_bytes() == b"audio bytes", "one job's cleanup removed another job's input"


def test_locked_vault_raises_never_returns_empty(store):
    """A locked vault must not look like an empty one — that is how you get 'all your
    characters are gone' rendered over intact data (SWEEP §2, voice_utils)."""
    store.write_bytes("books/a.txt", b"x")
    store.lock()
    assert not store.is_unlocked()

    for call in (
        lambda: store.read_bytes("books/a.txt"),
        lambda: store.write_bytes("books/b.txt", b"y"),
        lambda: store.listdir("books"),
        lambda: store.exists("books/a.txt"),
        lambda: store.stat("books/a.txt"),
        lambda: store.unlink("books/a.txt"),
        lambda: store.glob("books", "*.txt"),
        lambda: store.stream_range("books/a.txt", 0, 1),
    ):
        with pytest.raises(VaultLocked):
            call()


def test_lock_zeroizes(store):
    store.lock()
    assert store._dek is None and store._k_content is None and store._siv is None


def test_empty_file(store):
    store.write_bytes("empty.bin", b"")
    assert store.exists("empty.bin")
    assert store.read_bytes("empty.bin") == b""
    assert store.stat("empty.bin").size == 0
    store._map("empty.bin").write_bytes(b"")     # truncate to nothing on disk
    with pytest.raises(VaultAuthError):
        store.read_bytes("empty.bin")


def test_yaml_roundtrip(store):
    meta = {"text": "the user's words", "voice": 'TestVoice', "favorite": True, "params": {"cfg": 0.5}}
    store.write_yaml("playground/clip.yaml", meta)
    assert store.read_yaml("playground/clip.yaml") == meta


def test_missing_file_is_FileNotFound_not_AuthError(store):
    """Absent must be structurally distinct from corrupt — that distinction is the whole
    reason a caller can safely regenerate a missing file but must never delete a bad one."""
    with pytest.raises(FileNotFoundError):
        store.read_bytes("books/nope.txt")
    assert not store.exists("books/nope.txt")


def test_rename_and_rmtree(store):
    store.write_bytes("books/a.txt", b"x")
    store.rename("books/a.txt", "books/b.txt")
    assert store.listdir("books") == ["b.txt"]
    assert store.read_bytes("books/b.txt") == b"x"
    store.rmtree("books")
    assert store.listdir("books") == []


def test_create_refuses_to_overwrite_an_existing_keyfile(tmp_path):
    Vault.create(tmp_path / "s", tmp_path / "k.yaml", PW, kdf=TEST_KDF)
    with pytest.raises(VaultError):
        Vault.create(tmp_path / "s", tmp_path / "k.yaml", PW, kdf=TEST_KDF)
