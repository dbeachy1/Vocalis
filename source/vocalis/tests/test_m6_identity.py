"""5.0-M6 — IDENTITY SURVIVES THE CIPHER. The twin test_m4_identity.py could not write.

M4 pinned the three hashes by hand and demanded they survive M5, M6 and M7 untouched. They
will — and they would have gone on passing while M6 destroyed the swap library anyway, because
**test_m4_identity cannot see a vault that does not exist yet.** It writes plaintext files,
hashes them, and asserts the number. Encrypt uploads/songs/ underneath it and it still passes,
byte for byte, while `song_hash` quietly md5s the CIPHERTEXT and hands back a different identity
for the same song.

So this is the test M4 asked for and could not write:

    a song INSIDE THE VAULT still hashes to its PLAINTEXT md5 — the same identity it had
    before the migration, so every entry in the user's library still cache-hits.

And its mirror image, which is just as load-bearing:

    an ACE-Step song under /ai-output is NOT ours. It is gocryptfs's, already plaintext to us,
    and a plain open() is CORRECT. Routing it into the vault would md5 a decrypt that never
    happened — and, far worse, would mean Vocalis writing into another application's library.

The definition of identity has not moved: it is `md5 of the song's plaintext`, and it always
was. Today open() happens to return the plaintext. After M6 it does not. That is the whole
change. See SPEC_5_0_M6 §4.
"""
import hashlib

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import enhance
import stems
import tts_utils
import vault
import vault_store

PW = "correct horse battery staple"
TEST_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1}

SONG = b"ID3\x04\x00" + b"not really an mp3, but the md5 does not care" * 500


@pytest.fixture
def box(tmp_path, monkeypatch):
    """An initialized, unlocked store over a real install root + cache root."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    (install / "uploads" / "songs").mkdir(parents=True)
    cache.mkdir(parents=True)
    s = vault_store.configure([("install", install), ("cache", cache)],
                              install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", s)
    s.create(PW)
    return s, install, cache


# ── 🔴 the one that would silently destroy the swap library ──────────────────

def test_a_song_in_the_vault_still_hashes_to_its_PLAINTEXT_md5(box):
    """🔴 THE KEYSTONE.

    The expected value is computed HERE, BY HAND, from the cleartext bytes — never read back
    from the code, and never from the file on disk (which is now ciphertext). So this test
    cannot agree with a mistake, and it cannot be satisfied by a `song_hash` that has quietly
    redefined itself.
    """
    store, install, _ = box
    v, logical = vault_store.route(install / "uploads" / "songs" / "track.mp3")

    expected = hashlib.md5(SONG).hexdigest()          # the identity, from the PLAINTEXT

    v.write_bytes(logical, SONG)
    song = install / "uploads" / "songs" / "track.mp3"

    # Otherwise this test proves nothing. The FILENAME is SIV-encrypted too, so the logical
    # path is not even ON disk — a plain open() of it does not read the wrong bytes, it fails
    # outright. And the bytes that ARE there hash to something else entirely.
    assert not song.exists(), "the logical path exists on disk — nothing was encrypted"
    phys = v._map(logical)                            # the private mapper, on purpose: the
    assert phys.exists()                             # point is to look at the PHYSICAL layout
    assert phys.read_bytes() != SONG
    assert hashlib.md5(phys.read_bytes()).hexdigest() != expected

    assert stems.song_hash(song) == expected


def test_an_ace_step_song_is_read_with_a_plain_open(box, tmp_path):
    """The mirror image. /ai-output is gocryptfs's: already plaintext to us, and we never
    write there. Its songs must be md5'd exactly as they always were."""
    ace = tmp_path / "ai-output" / "acestep"
    ace.mkdir(parents=True)
    song = ace / "generated.mp3"
    song.write_bytes(SONG)                            # plaintext, as gocryptfs hands it to us

    assert vault_store.route(song) is None            # NOT ours
    assert stems.song_hash(song) == hashlib.md5(SONG).hexdigest()


def test_song_id_returns_the_plaintext_identity_and_caches_it(box):
    """song_id() is the front door and the hash is its MISS path. Both must land on the
    plaintext identity, or the index memoizes a lie forever."""
    store, install, cache = box
    v, _ = vault_store.route(install / "uploads" / "songs" / "track.mp3")
    v.write_bytes("uploads/songs/track.mp3", SONG)
    song = install / "uploads" / "songs" / "track.mp3"

    class C:
        song_index = cache / "song_ids.yaml"

    expected = hashlib.md5(SONG).hexdigest()
    assert stems.song_id(C, song) == expected         # miss -> hash -> record
    assert stems.song_id(C, song) == expected         # hit -> served from the index


# ── the identity seam: LOGICAL size, never the size on disk ──────────────────

def test_source_stat_reports_the_PLAINTEXT_size_of_a_vault_file(box):
    """🔴 Ciphertext is BIGGER than plaintext (a 16-byte header + a 16-byte tag per 64 KiB
    block). If source_stat reported the size on disk, then EVERY cache keyed on it would miss
    at once, the moment the migration ran: the enhanced-audio cache (GPU-hours), the bandwidth
    cache, the clip durations, and M4's song index. One function, four caches.
    """
    store, install, _ = box
    v, logical = vault_store.route(install / "uploads" / "songs" / "track.mp3")
    v.write_bytes(logical, SONG)
    song = install / "uploads" / "songs" / "track.mp3"

    on_disk = v._map(logical).stat().st_size
    assert on_disk > len(SONG), "the fixture is not actually encrypted"

    size, mtime = tts_utils.source_stat(song)
    assert size == len(SONG), "source_stat reported the CIPHERTEXT size"
    # The mtime is the PHYSICAL one, deliberately: clear_cache is implemented as nothing BUT
    # an os.utime, so a stored mtime would go stale and silently make it a no-op.
    assert mtime == int(v._map(logical).stat().st_mtime)


def test_source_stat_of_a_path_we_do_not_own_is_unchanged(box, tmp_path):
    """An /ai-output song, the scratch, a log — stat'd exactly as before."""
    p = tmp_path / "elsewhere.mp3"
    p.write_bytes(SONG)
    assert vault_store.route(p) is None
    assert tts_utils.source_stat(p) == (len(SONG), int(p.stat().st_mtime))


def test_a_missing_vault_file_stats_as_None_not_as_an_error(box, install=None):
    """ABSENT ≠ CORRUPT, the semantic M2a paid most to get right. A file that is not there has
    nothing to destroy, and source_stat's contract is None."""
    store, install, _ = box
    assert tts_utils.source_stat(install / "uploads" / "songs" / "never_existed.mp3") is None


# ── the enhanced cache: the user has a full one, and it must still hit ───────────

def test_the_enhanced_cache_key_of_a_vault_file_is_its_PLAINTEXT_key(box):
    """`test_the_seam_did_not_move_the_cache_key` (test_enhance.py) pins the FORMULA and must
    keep passing untouched. This pins the thing that formula is fed under encryption.

    enhance.source_key is `f"{path}|{size}|{mtime}"` — so if source_stat handed it the
    ciphertext size, every entry in the user's enhanced cache would miss, and the entire cache
    would silently re-enhance at ~16 minutes a clip. The key is recomputed BY HAND here, from
    the plaintext length, for the same reason M4's pins are.
    """
    store, install, _ = box
    v, logical = vault_store.route(install / "voice_samples" / 'TestVoice.wav')
    v.write_bytes(logical, SONG)
    clip = install / "voice_samples" / 'TestVoice.wav'

    mtime = int(v._map(logical).stat().st_mtime)
    expected_ident = f"{clip.resolve()}|{len(SONG)}|{mtime}"                # PLAINTEXT size
    key = f"{expected_ident}|nfe=32|trim=0"
    expected = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24] + ".wav"

    assert enhance.cache_path(clip, 32, None).name == expected


# ── and it all still works with no vault at all ─────────────────────────────

def test_with_no_vault_the_identity_is_exactly_what_it_always_was(tmp_path, monkeypatch):
    """The un-migrated box — which is the user's, on the day this ships. Every seam routes to None
    and every number is bit-for-bit 4.x."""
    monkeypatch.setattr(vault_store, "STORE", None)
    song = tmp_path / "track.mp3"
    song.write_bytes(SONG)

    assert stems.song_hash(song) == hashlib.md5(SONG).hexdigest()
    assert tts_utils.source_stat(song) == (len(SONG), int(song.stat().st_mtime))
