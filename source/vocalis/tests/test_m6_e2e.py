"""End-to-end checks that application writes stay encrypted at rest.

Vault routing is inert until initialized and unlocked, so ordinary route tests can pass without
exercising the encrypted store. These tests initialize a vault, run representative render and
file workflows, and inspect the physical tree for plaintext signatures. Expected-file checks
ensure a clean result cannot pass on an empty tree.

The scan covers recognizable audio, archive, YAML, and text markers (SPEC_5_0_M6 §7)."""
import inspect
import io
import json
import shutil
from pathlib import Path

import pytest
import torch

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import tts_utils
import book_state
import vault
import vault_fs
import vault_store

# 🔴 AT MODULE LEVEL, AND IT MUST BE. `vocalis_server` calls `vault_store.configure()` at import
# (`:1857`), pointing STORE at the REAL install root. Imported lazily inside a test it would run
# AFTER `box` built its vault, silently replace it, and route the test's writes at the user's own
# repo. Under the full suite `test_server.py` imports it during collection so the hazard hides;
# running THIS FILE ALONE is where it bites — which is exactly how someone debugs a leak.
import vocalis_server as vs
from vocalis.runtime import auth as rt_auth   # vault store + admin creds (5.1-P4.15)
import store_serve                     # 5.1-P4.12: vocalis_server no longer re-exports these
from vocalis.runtime import voices as rt_voices
from vocalis.web import voices as web_voices
from vocalis.web import playground as web_playground   # its own OUTPUT_DIR copy (the §6.2 hazard)
from vocalis.web import books as web_books
import vocalis.runtime.configs as rt_configs
import vocalis.runtime.paths as rt_paths
from vocalis.runtime import voice_templates as rt_voice_templates

PW = "correct horse battery staple"
TEST_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1}

FAKE_SR = 24000
_CHUNK_LEN = 2400

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")


# 🔴 A FILE FORMAT ANNOUNCES ITSELF AT OFFSET ZERO, AND THAT IS THE ONLY PLACE WE LOOK.
#
# These are matched with startswith(), never scanned across the file, and that is not tidiness —
# it is the difference between a working instrument and one nobody believes.
#
# Ciphertext is indistinguishable from random bytes. An MP3 frame sync is TWO bytes (\xff\xfb),
# so it is expected to occur about 1.5 times BY CHANCE in any 96 KB of random data. Scanning
# whole files for it, the old way, produced 311 false positives in 400 — MEASURED, not reasoned
# about. Even a 64-byte window still hit 2 in 400. At offset 0 it is 1 in 65,536.
#
# The failure mode being avoided is specific and nasty: a random red in the one test whose whole
# message is "YOUR AUDIO IS ON THE PLATTER IN CLEARTEXT" sends someone hunting a leak that was
# never there — and the second time it cries wolf, they stop believing it. Then the real one
# lands. A header lives at the head. Look at the head.
MAGIC_MARKERS = (
    b"RIFF",                                # a WAV, written by soundfile
    b"ID3", b"\xff\xfb",                    # an MP3, written by ffmpeg (tagged, or a bare frame)
    b"PK\x03\x04",                          # a torch .pth — the trained voice registry
)

# Scanned across the WHOLE file, which these are long enough to survive: the shortest is 5 bytes,
# so b"text:" arising by chance in a megabyte of ciphertext is about a one-in-a-million event.
# This is the half that catches a leaked SIDECAR and the user's own prose — and prose is the
# thing this project exists to protect.
TEXT_MARKERS = (
    b"favorite:", b"created:", b"text:", b"voice:",   # our sidecars
    b"Sentence number",                               # the user's own words
    b"the trained voice",                             # ...and the .pth's payload in these tests
    # 🔴 THE JSON HALF, and its absence was itself a hole in this instrument. Every marker above
    # is YAML-shaped — `key:` with the colon touching the key. 4.8's voice sidecar is JSON, where
    # the same key serializes as `"favorite": true`: the quote sits between the name and the
    # colon, so NONE of the markers above match it. A leaked `<stem>.voice.json` — holding the ★,
    # the origin, and for a designed voice the PROMPT THE USER TYPED — would have sat in the
    # store while this test reported the tree clean. Quoted keys are 8+ bytes, so a chance hit in
    # ciphertext is ~1 in 2^64; the offset-0 reasoning above does not need to apply.
    b'"origin"', b'"favorite"', b'"backfilled"', b'"sample_text"',
    # 🔴 7.0's document store, added with the commit that first writes it. Every marker above was
    # added AFTER the store it names existed — voice_models/ is the record of what that costs —
    # and this tree is the densest in user content the product has: a revision is a whole
    # lorebook or character card, and a proposal holds the before AND after of one field.
    b'"from_revision"', b'"instructions"', b'"revised"',
)


def assert_no_cleartext(root, *, allow=(), expect_files=1):
    """Walk the PHYSICAL store and fail on anything recognizable.

    🔴 THIS IS THE ONLY INSTRUMENT THAT CAN SEE A MISSED WRITE. A site nobody routed does not
    raise: it writes plaintext into the vault under its logical name, listdir steps over it, the
    app behaves perfectly, and nothing anywhere ever says so. Every other test in this milestone
    would stay green over a store that is 100% cleartext.

    `allow` names files that are cleartext BY DESIGN — the sentinel, the keyfile. Everything
    else in a vault root is user data and must be unreadable without the DEK.

    `expect_files` is the guard against the way this test would otherwise LIE: a grep for
    cleartext over an EMPTY tree passes, beautifully, forever. If the render is ever refactored
    to write somewhere else, this must fail loudly rather than congratulate us on the silence.
    """
    checked, offenders = 0, []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name in allow:
            continue
        checked += 1
        blob = p.read_bytes()
        hit = [m for m in MAGIC_MARKERS if blob.startswith(m)]     # offset 0 ONLY — see above
        hit += [m for m in TEXT_MARKERS if m in blob]
        if hit:
            offenders.append(f"{p.relative_to(root)} contains {hit}")
    assert not offenders, (
        "PLAINTEXT FOUND INSIDE THE VAULT — one of these sites is not routed:\n  "
        + "\n  ".join(offenders))
    assert checked >= expect_files, (
        f"{root.name}: only {checked} file(s) to check (wanted >= {expect_files}) — this test "
        f"proves NOTHING if the render did not actually write here")


@pytest.fixture
def box(tmp_path, monkeypatch):
    """An initialized, UNLOCKED store over a real install root + cache root.

    ⚠ This installs a vault PROCESS-WIDE — `vault_store.configure()` assigns the module global —
    and the `monkeypatch.setattr` below cannot undo that (it runs after configure, so it records
    the vault as the "original"). conftest's `_a_vault_never_leaks_out_of_the_test_that_built_it`
    is what puts STORE back. Read that fixture before writing another one of these: the leak was
    invisible for months and then surfaced, three files away, as six voice-training tests
    refusing to launch over an unencrypted volume."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    s = vault_store.configure([("install", install), ("cache", cache)],
                              install / "vault_keys.yaml")
    monkeypatch.setattr(vault_store, "STORE", s)
    s.create(PW)
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))
    return s, install, cache


class _FakePool:
    """generate_section's pool contract, with no model: each chunk's amplitude marks its index."""
    sr = FAKE_SR

    def run_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
        for index, _text in reversed(items):        # out of order, on purpose
            save(index, torch.full((1, _CHUNK_LEN), 0.1 * (index + 1)), self.sr)
        return 0, 0.0

    # 7.1 split the pool contract into submit + collect (WorkerPool.submit_chunks) so a book
    # can queue the next chapter behind the current one. Expressed through `run_chunks` so the
    # subclass below, which overrides only that, keeps working.
    def submit_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
        if not items:
            return None
        return self.run_chunks(items, params, save, total,
                               on_event=on_event, chapter=chapter, cancel=cancel)

    def collect_chunks(self, batch, stall_timeout_s=None):
        return batch if batch is not None else (0, 0.0)


def _section():
    from tts_utils import split_into_chunks
    text = " ".join(f"Sentence number {i} lives in this test section here." for i in range(40))
    chunks = split_into_chunks(text)
    assert len(chunks) >= 4
    return {"index": 0, "title": "Ch", "filename": "00_Ch", "text": text}, len(chunks)


def test_a_book_render_through_an_open_vault_leaves_no_cleartext(box):
    """🔴 THE GATE. A real render — chunk bank, resume check, concat, section WAV — with the
    vault OPEN, and then we go and LOOK at the bytes.

    The chunk store is the hard half. It lives in cache_root()/chunks, it is written by
    soundfile (which takes a path), read back by torchaudio (which takes a path), and
    validated by valid_or_remove (which does a RAW open() and then hands the same path to
    libsndfile). Every one of those is a third-party library holding a filename, and none of
    them has ever heard of the vault.
    """
    import book_to_audio
    store, install, cache = box
    book_to_audio.torch = torch

    section, total = _section()
    out_dir = install / "output" / "TestBook"
    chunks_base = cache / "chunks"

    out_path, dur, _nc, _nt = book_to_audio.generate_section(
        section, _FakePool(), tts_utils.GenParams(), out_dir, chunks_base)

    # It still WORKS: the section reads back, in index order, through the vault.
    assert dur > 0
    combined, sr = tts_utils.load_wav(str(out_path))
    assert sr == FAKE_SR
    assert combined.shape[-1] == total * _CHUNK_LEN
    for k in range(total):
        seg = combined[0, k * _CHUNK_LEN:(k + 1) * _CHUNK_LEN]
        assert abs(seg.mean().item() - 0.1 * (k + 1)) < 0.02, f"segment {k} out of order"

    # ...and NOTHING it wrote is readable. The section WAV is one file; the chunk bank is one
    # per chunk — so if either root comes up short, the render stopped writing there.
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME},
                        expect_files=1)
    assert_no_cleartext(cache, allow={vault.SENTINEL_NAME}, expect_files=total)


def test_a_voice_sample_reaches_chatterbox_as_PLAINTEXT_in_the_scratch(box, tmp_path, monkeypatch):
    """Chatterbox opens `audio_prompt_path` itself, so the vault cannot mediate that library-owned read. The stored path is unavailable after encryption; decrypt the sample into scratch and pass that path to Chatterbox."""
    store, install, _ = box
    scratch = tmp_path / "scratch"
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(scratch))

    v, logical = vault_store.route(install / "voice_samples" / 'TestVoice.wav')
    v.write_bytes(logical, b"RIFF....WAVEfmt this is Kate's voice")
    voice = install / "voice_samples" / 'TestVoice.wav'

    assert not voice.exists(), "the logical path is on disk — chatterbox could have read it"

    handed_to_chatterbox = tts_utils.voice_for_model(str(voice))

    p = Path(handed_to_chatterbox)
    assert p.parent == scratch, "the voice was not decrypted into the scratch"
    assert p.read_bytes() == b"RIFF....WAVEfmt this is Kate's voice"   # PLAINTEXT, for the library
    assert 'TestVoice' not in p.name, "the voice's NAME rode into the filesystem with it"


def test_the_voice_is_decrypted_ONCE_not_once_per_chunk(box, tmp_path, monkeypatch):
    """🔴 NOT AN OPTIMIZATION. _worker_loop rebuilds make_generate_fn ONCE PER CHUNK, so a
    decrypt done in there decrypts the same sample three hundred times for a book — on every
    card, while holding the GPU."""
    store, install, _ = box
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(tmp_path / "scratch"))
    tts_utils._VOICE_SCRATCH.clear()

    v, logical = vault_store.route(install / "voice_samples" / 'TestVoice.wav')
    v.write_bytes(logical, b"RIFF....WAVEfmt voice")
    voice = str(install / "voice_samples" / 'TestVoice.wav')

    calls = []
    real = vault.Vault.decrypt_to_scratch
    monkeypatch.setattr(vault.Vault, "decrypt_to_scratch",
                        lambda self, lg, d: (calls.append(lg), real(self, lg, d))[1])

    first = tts_utils.voice_for_model(voice)
    for _ in range(50):                                  # 50 chunks of a render
        assert tts_utils.voice_for_model(voice) == first
    assert len(calls) == 1, f"decrypted {len(calls)} times — once per chunk, not once per voice"


def test_a_re_recorded_voice_invalidates_the_memo(box, tmp_path, monkeypatch):
    """The memo is keyed on the vault's LOGICAL mtime. Voice ingest rewrites the file, and
    clear_cache is implemented as nothing BUT an os.utime — both move it. Cache it on the name
    alone and a re-recorded voice would render as the OLD one, forever."""
    import os as _os
    store, install, _ = box
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(tmp_path / "scratch"))
    tts_utils._VOICE_SCRATCH.clear()

    v, logical = vault_store.route(install / "voice_samples" / 'TestVoice.wav')
    v.write_bytes(logical, b"RIFF....WAVEfmt the first take")
    voice = str(install / "voice_samples" / 'TestVoice.wav')
    first = tts_utils.voice_for_model(voice)
    assert Path(first).read_bytes().endswith(b"the first take")

    v.write_bytes(logical, b"RIFF....WAVEfmt the SECOND take")
    _os.utime(v._map(logical), (12345, 12345))           # a re-record moves the mtime
    again = tts_utils.voice_for_model(voice)
    assert Path(again).read_bytes().endswith(b"the SECOND take"), "the memo served a stale voice"


def test_a_voice_outside_the_vault_is_handed_straight_through(tmp_path, monkeypatch):
    """The un-migrated box. A no-op until the day the vault is initialized."""
    monkeypatch.setattr(vault_store, "STORE", None)
    p = tmp_path / 'TestVoice.wav'
    p.write_bytes(b"RIFF")
    assert tts_utils.voice_for_model(str(p)) == str(p)


@pytest.mark.parametrize("no_voice", [None, ""])
def test_NO_voice_reaches_chatterbox_as_None_not_a_TypeError(box, no_voice):
    """🔴 "No voice" is a real render, and it is not a path.

    `audio_prompt_path=None` is how chatterbox is told to use its OWN default voice, and
    /playground/generate deliberately allows it — it builds `GenParams(voice=... if voice
    else None)` and logs `voice=(model default)`. Handing that None to the router made
    `Path(None)` raise `TypeError: ... not 'NoneType'` at chunk 0, on every retry, on every
    worker. Caught driving the deployed encrypted install: a voiceless Playground render
    failed with exactly that, where 4.x had rendered fine.

    ONLY encrypted installs could hit it — with no vault, `route()` returns None before it
    ever touches the path, which is why the suite was green while the box was broken. So this
    test asserts against `box`, an INITIALIZED store: without the guard it raises here.
    """
    assert tts_utils.voice_for_model(no_voice) is no_voice


def test_a_resumed_render_re_reads_its_banked_chunks_through_the_vault(box):
    """The resume path is where a wrong turn DELETES data rather than merely leaking it.

    valid_or_remove does TWO reads of the same chunk — a raw open() to prove the OS will hand
    us the bytes, then libsndfile to ask whether those bytes are a WAV — and it UNLINKS on the
    second one. Route only the first and 8 KiB of ciphertext reads back perfectly happily,
    libsndfile says "not a WAV", and every banked chunk of the render is deleted.
    """
    import book_to_audio
    store, install, cache = box
    book_to_audio.torch = torch

    section, total = _section()
    out_dir = install / "output" / "TestBook"
    chunks_base = cache / "chunks"

    out_path, _d, _c, _t = book_to_audio.generate_section(
        section, _FakePool(), tts_utils.GenParams(), out_dir, chunks_base)

    # Drop the section WAV, keeping the chunk bank — which is EXACTLY what an interrupted
    # render leaves behind, and the only state in which the chunk-level resume runs at all.
    # Without this the second call now short-circuits one level higher, on generate_section's
    # "already done?" probe: that probe used to be a bare `.exists()` on a vault path, so it
    # was always False and every resumed render fell through to here. It is routed as of the
    # writer-census sweep, so the test has to set up the state it means to exercise instead
    # of arriving at it through a bug.
    vault_fs.unlink(out_path, missing_ok=True)

    # Render it AGAIN over the same chunk bank. Every chunk is already banked, so a correct
    # resume regenerates none of them — and a broken one deletes them all.
    class _PoolThatMustNotBeAsked(_FakePool):
        def run_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
            assert not items, (
                f"the resume check did not see {len(items)} banked chunk(s) through the vault "
                f"— on the real path valid_or_remove would have DELETED them")
            return 0, 0.0

    out_path, dur, _nc, _nt = book_to_audio.generate_section(
        section, _PoolThatMustNotBeAsked(), tts_utils.GenParams(), out_dir, chunks_base)
    assert dur > 0


def test_the_post_scan_can_DELETE_a_truncated_chunk_through_the_vault(box):
    """A truncated chunk is identified through routed reads, but its logical path and parent directory do not exist on disk under encrypted storage. Cleanup must use the vault-aware unlink operation before rerendering; otherwise a successful chapter can fail during post-scan. This test truncates one chunk and verifies the retry produces a readable section."""
    import book_to_audio
    store, install, cache = box
    book_to_audio.torch = torch

    section, total = _section()
    out_dir = install / "output" / "TestBook"
    chunks_base = cache / "chunks"

    # 40 s at FAKE_SR: 40 * _S3_TOKEN_RATE = 1000 tokens, which is the cap `is_truncated_wav`
    # tests for. Derived from the constants rather than pasted, so retuning either one retunes
    # the fixture instead of quietly making this test render an ordinary chunk.
    trunc_len = int(FAKE_SR * tts_utils._TOKEN_CAP / tts_utils._S3_TOKEN_RATE)

    class _PoolThatTruncatesChunk1Once(_FakePool):
        def __init__(self):
            self.seen = []

        def run_chunks(self, items, params, save, total, on_event=None, chapter=None, cancel=None):
            for index, _text in items:
                n = trunc_len if (index == 1 and index not in self.seen) else _CHUNK_LEN
                self.seen.append(index)
                save(index, torch.full((1, n), 0.1 * (index + 1)), self.sr)
            return 0, 0.0

    pool = _PoolThatTruncatesChunk1Once()
    out_path, dur, _nc, _nt = book_to_audio.generate_section(
        section, pool, tts_utils.GenParams(), out_dir, chunks_base)

    assert pool.seen.count(1) == 2, (
        f"chunk 1 was rendered {pool.seen.count(1)} time(s) — the post-scan never re-rendered "
        f"the truncated chunk, so this test is not exercising the path it is named for")
    assert dur > 0
    combined, sr = tts_utils.load_wav(str(out_path))
    assert combined.shape[-1] == total * _CHUNK_LEN, (
        "the truncated chunk reached the section WAV — the delete-and-retry did not take")

    # And the bank it deleted through is still ciphertext end to end.
    assert_no_cleartext(cache, expect_files=total)


# ── the Playground clip library ──────────────────────────────────────────────
#
# The clips are the store the USER actually browses: output/playground/<voice>/<stem>.mp3 plus
# a sidecar holding the full prompt. The stem IS safe_name(the prompt), so the words are in the
# FILENAME as well as the file — and the mp3 is produced by ffmpeg, a child process that cannot
# import vault and used to write its .part.mp3 straight into the store.


@pytest.fixture
def clip_box(box, tmp_path, monkeypatch):
    """The box, plus a scratch — encode_mp3 needs somewhere for ffmpeg to work."""
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(tmp_path / "scratch"))
    return box


def _a_real_wav(path, seconds=0.5):
    """A genuine WAV, written THROUGH the vault (save_wav_atomic routes)."""
    wav = torch.sin(torch.linspace(0, 240, int(FAKE_SR * seconds))).unsqueeze(0) * 0.3
    tts_utils.save_wav_atomic(Path(path), wav, FAKE_SR)


@needs_ffmpeg
def test_a_playground_clip_through_an_open_vault_leaves_no_cleartext(clip_box):
    """🔴 THE GATE FOR THE CLIP LIBRARY — and for `encode_mp3`, the SECOND plaintext→store
    boundary (SPEC_5_0_M6 §6).

    Unlike `enhance.store_cache`, this one was never a single swappable function: ffmpeg took a
    path in and wrote a path OUT, and that path was inside output/playground/. Nothing about
    that fails when the store is encrypted. The clip encodes, lands, lists, and PLAYS — and it
    is sitting on the platter in cleartext, with the user's prompt as its filename.

    The only thing that can see it is the grep.
    """
    import playground_clips
    store, install, cache = clip_box

    src = cache / "chunks" / "playground" / "0123456789ab" / "_full.wav"
    _a_real_wav(src)

    h = playground_clips.clip_hash('TestVoice', 0.5, 0.5, 0.8, "Sentence number one.")
    root = install / "output" / "playground"
    mp3 = root / 'TestVoice' / (playground_clips.clip_stem("Sentence number one.", h) + ".mp3")

    playground_clips.encode_mp3(src, mp3)
    playground_clips.write_clip_yaml(mp3.with_suffix(".yaml"), {
        "voice": 'TestVoice', "text": "Sentence number one.", "favorite": True})

    # The logical path is NOT on disk — the filename is SIV-encrypted too, so the prompt that
    # names the file never reaches the platter either.
    assert not mp3.exists(), "the clip's plaintext path is on disk"

    # It still WORKS end to end, through the cipher.
    clips = playground_clips.list_clips(root)
    assert len(clips) == 1, "the clip did not come back out of the vault"
    assert clips[0]["text"] == "Sentence number one."
    assert clips[0]["favorite"] is True
    assert playground_clips.find_ref_by_hash(root, 'TestVoice', h) == clips[0]["ref"]

    # ...and it is a REAL MP3 when you decrypt it.
    import vault_fs
    assert vault_fs.read_bytes(mp3)[:2] in (b"ID", b"\xff\xfb"), "not an MP3 after decryption"

    # 🔴 AND NOTHING IT WROTE IS READABLE.
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


@needs_ffmpeg
def test_ffmpeg_never_sees_the_store_and_never_writes_to_it(clip_box, tmp_path):
    """The child-process boundary itself. ffmpeg gets a path in the SCRATCH, and writes a path
    in the SCRATCH — it is never handed a store path in either direction, because it could not
    open one (the plaintext name does not exist) and must not create one (that write is the
    silent one).

    Pinned by watching the actual argv, not by trusting the code to have meant well.
    """
    import subprocess

    import playground_clips
    store, install, cache = clip_box
    scratch = tmp_path / "scratch"

    src = cache / "chunks" / "playground" / "0123456789ab" / "_full.wav"
    _a_real_wav(src)
    mp3 = install / "output" / "playground" / 'TestVoice' / "secret_prompt_ab12cd34.mp3"

    seen = []
    real_run = subprocess.run

    def _spy(cmd, *a, **kw):
        seen.append(list(cmd))
        return real_run(cmd, *a, **kw)

    import playground_clips as pc
    monkey = pytest.MonkeyPatch()
    monkey.setattr(subprocess, "run", _spy)
    try:
        pc.encode_mp3(src, mp3)
    finally:
        monkey.undo()

    assert seen, "ffmpeg never ran"
    argv = seen[0]
    paths = [a for a in argv if a.endswith((".wav", ".mp3"))]
    assert paths, "no file paths in the ffmpeg command"
    for a in paths:
        assert Path(a).parent == scratch, f"ffmpeg was handed a path outside the scratch: {a}"
        assert "secret_prompt" not in a, "the user's PROMPT rode into the child as a filename"


@needs_ffmpeg
def test_the_library_shows_the_PLAINTEXT_size_not_the_ciphertext_size(clip_box):
    """🔴 The one that would have been wrong on every clip, in the UI, forever, silently.

    `list_clips` read a raw `mp3.stat()`. Inside the vault that is the size ON DISK: a 16-byte
    header plus a 16-byte GCM tag for every 64 KiB block. Nothing fails. No test goes red. The
    number is just wrong, on every row, and it is the only place the user is ever told how big
    their clip is.

    This test is worth nothing unless the two sizes genuinely DIFFER — so it asserts that too,
    rather than passing quietly on a coincidence.
    """
    import vault_fs

    import playground_clips
    store, install, cache = clip_box

    src = cache / "chunks" / "playground" / "0123456789ab" / "_full.wav"
    _a_real_wav(src, seconds=2.0)
    root = install / "output" / "playground"
    mp3 = root / 'TestVoice' / "hello_ab12cd34.mp3"
    playground_clips.encode_mp3(src, mp3)
    playground_clips.write_clip_yaml(mp3.with_suffix(".yaml"), {"voice": 'TestVoice', "text": "hi"})

    plaintext_len = len(vault_fs.read_bytes(mp3))
    v, logical = vault_store.route(mp3)
    ciphertext_len = v._map(logical).stat().st_size

    assert ciphertext_len > plaintext_len, (
        "ciphertext is not larger than plaintext here — this test cannot tell the two apart, "
        "so it would pass even with the bug present")

    row = playground_clips.list_clips(root)[0]
    assert row["size"] == plaintext_len, (
        f"the library is reporting the CIPHERTEXT size ({row['size']} vs {plaintext_len})")


@needs_ffmpeg
def test_renaming_a_clip_in_the_vault_moves_it_without_re_encrypting_the_audio(clip_box):
    """A rename re-encrypts the NAME (SIV, bound to the parent dir) and moves nothing else. The
    H8 identity suffix survives, so a re-render of the same inputs still OVERWRITES this clip
    rather than spawning a duplicate — which is the whole contract of seedless identity."""
    import playground_clips
    store, install, cache = clip_box

    src = cache / "chunks" / "playground" / "0123456789ab" / "_full.wav"
    _a_real_wav(src)
    root = install / "output" / "playground"
    h = playground_clips.clip_hash('TestVoice', 0.5, 0.5, 0.8, "the old name")
    mp3 = root / 'TestVoice' / (playground_clips.clip_stem("the old name", h) + ".mp3")
    playground_clips.encode_mp3(src, mp3)
    playground_clips.write_clip_yaml(mp3.with_suffix(".yaml"), {"voice": 'TestVoice', "text": "x"})
    before = playground_clips.list_clips(root)[0]["size"]

    ref = playground_clips.find_ref_by_hash(root, 'TestVoice', h)
    new_ref = playground_clips.rename_clip(root, ref, "A Brand New Name")

    assert playground_clips.find_ref_by_hash(root, 'TestVoice', h) == new_ref, (
        "the identity suffix did not survive the rename — a re-render would duplicate the clip")
    rows = playground_clips.list_clips(root)
    assert len(rows) == 1 and rows[0]["name"] == "A Brand New Name"
    assert rows[0]["size"] == before, "the audio was rewritten by a rename"
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


# ── a stray file must not look like a wrong key ──────────────────────────────


@pytest.fixture
def one_clip(box):
    """A vault with one real clip in it, and the physical dir that holds it."""
    import vault_fs
    store, install, cache = box
    root = install / "output" / "playground"
    mp3 = root / 'TestVoice' / "hello_ab12cd34.mp3"
    vault_fs.write_bytes(mp3, b"ID3 the audio")
    vault_fs.write_yaml_atomic(mp3.with_suffix(".yaml"), {"voice": 'TestVoice', "text": "hi"})
    v, logical = vault_store.route(root / 'TestVoice')
    return root, v._map(logical)


@pytest.mark.parametrize("label,make_stray", [
    ("an orphaned .part from a SIGKILL mid-write",
     lambda d: next(p for p in d.iterdir() if p.is_file()).with_suffix(".part")
     .write_bytes(b"half a write")),
    ("Thumbs.db, put there by Windows",
     lambda d: (d / "Thumbs.db").write_bytes(b"\x00")),
    ("an UNROUTED WRITE — a seam somebody missed",
     lambda d: (d / "leaked_clip.mp3").write_bytes(b"ID3 plaintext")),
])
def test_one_stray_file_does_not_brick_the_library_or_cry_wrong_key(one_clip, label, make_stray):
    """🔴 ONE STRAY BYTE USED TO TAKE OUT THE WHOLE DIRECTORY — and blame the encryption key.

    listdir() decrypts every entry name it finds. A name that would not decrypt raised
    VaultAuthError, which in this system does not mean "odd file". It means THE DEK IS WRONG:
    it is a BaseException so that nothing can swallow it, and M5 routes it to a handler that
    kills the job and logs VAULT AUTHENTICATION FAILED.

    So a power cut during a render — which orphans a `.part`, by construction, because a
    `finally` does not run — would have left the user with a Playground library that refused to
    open and incorrectly report a key failure even though the key is valid.

    The sentinel already proved the DEK is correct before the vault would open at all. An entry
    we cannot name is therefore not a key failure; it is a file that is not ours. It is skipped,
    and loudly logged.
    """
    import playground_clips
    root, physdir = one_clip
    make_stray(physdir)

    rows = playground_clips.list_clips(root)     # must not raise
    assert len(rows) == 1, f"the real clip was lost when we added: {label}"
    assert rows[0]["text"] == "hi"
    assert playground_clips.find_ref_by_hash(root, 'TestVoice', "ab12cd34") is not None


def test_a_stray_file_is_skipped_but_never_deleted(one_clip):
    """Skipping is not tidying. We do not own it, so we do not touch it — the same rule that
    keeps us out of /ai-output. (And if it IS tampering, destroying the evidence is the last
    thing we should do.)"""
    import playground_clips
    root, physdir = one_clip
    stray = physdir / "Thumbs.db"
    stray.write_bytes(b"\x00")

    playground_clips.list_clips(root)
    assert stray.exists(), "the vault deleted a file that was not its own"


def test_the_GREP_is_what_catches_an_unrouted_write_now_that_listdir_stays_quiet(box, one_clip):
    """🔴 THE OTHER HALF OF THE TRADE ABOVE, AND IT MUST BE PAID.

    Skipping an entry we cannot name is right — a power cut must not look like a broken key.
    But it costs something real, and here is the invoice: **an unrouted write no longer raises.**
    It lands in the store under its cleartext logical name, `listdir` steps over it, the library
    lists correctly, the app behaves perfectly, and the user's audio is on the platter in the
    clear. There is now NOTHING in the running system that will ever tell anyone.

    So the grep is not a nice-to-have any more. It is the only instrument left, and this test
    exists to prove it still works — because a `assert_no_cleartext` that cannot fail is worth
    less than nothing: it is a green light wired to no sensor.
    """
    store, install, cache = box
    root, physdir = one_clip

    # exactly what a missed seam does: writes the plaintext at the LOGICAL path
    (physdir / "leaked_clip.mp3").write_bytes(b"ID3\x04 the user's actual audio")

    with pytest.raises(AssertionError, match="PLAINTEXT FOUND INSIDE THE VAULT"):
        assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME},
                            expect_files=1)


# ── the enhance / ffmpeg cluster ─────────────────────────────────────────────


@needs_ffmpeg
def test_wav_to_mp3_reads_and_writes_through_the_vault(clip_box):
    """🔴 The book's MP3 encoder — ffmpeg, path IN and path OUT, and it wrote its `.part.mp3`
    into `output/<book>/mp3/`. The read failing is loud; the WRITE is the silent one, and it
    would have put the whole audiobook on the platter in cleartext."""
    store, install, cache = clip_box

    wav = install / "output" / "TestBook" / "01_Chapter.wav"
    _a_real_wav(wav, seconds=1.0)

    mp3 = tts_utils.wav_to_mp3(wav)

    assert mp3 == install / "output" / "TestBook" / "mp3" / "01_Chapter.mp3"
    assert not mp3.exists(), "the chapter MP3's plaintext path is on disk"

    import vault_fs
    assert vault_fs.read_bytes(mp3)[:2] in (b"ID", b"\xff\xfb"), "not an MP3 after decryption"
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


@needs_ffmpeg
def test_measure_bandwidth_still_measures_a_file_inside_the_vault(clip_box):
    """🔴 THE QUIET ONE. All three children under measure_bandwidth (ffprobe ×2, ffmpeg) take a
    PATH, and every one of them answers failure with a ZERO — by design, with a warning that
    says nothing is wrong.

    And 0 is not "band-limited", it is "unknown": `is_band_limited(0)` is False. So an unrouted
    measure_bandwidth marks the ENTIRE library full-quality, the enhance-before-training gate
    waves every band-limited clip through, and Applio trains on audio with no high end — which
    is the exact discriminator collapse this feature exists to prevent. No error. No red test.
    A worse voice, weeks later.

    A 24 kHz WAV is band-limited by ARITHMETIC (Nyquist), so a correct read returns 12000 and a
    failed one returns 0. The two are trivially distinguishable — which is the only reason this
    test can tell you anything.
    """
    import enhance
    store, install, cache = clip_box

    wav = install / "output" / "TestBook" / "01_Chapter.wav"
    _a_real_wav(wav, seconds=1.0)          # FAKE_SR = 24000 -> nyquist 12000

    hz = enhance.measure_bandwidth(wav)
    assert hz == FAKE_SR // 2, (
        f"bandwidth came back {hz} for a file in the vault — 0 means the children could not "
        f"open it, and 0 reads as FULL QUALITY everywhere downstream")
    assert enhance.is_band_limited(hz), "a 24 kHz clip must still read as band-limited"


def test_store_cache_encrypts_the_enhanced_audio(clip_box, tmp_path):
    """`enhance.store_cache` — the FIRST plaintext→store boundary, and the one that always had
    a door. The enhancer is a child in a foreign venv: it writes a real file to a real path in
    the scratch, and this is the only thing that puts those bytes into the cache. The cache is
    the crown jewels — full-band audio of the user's own voice, ~317 MB an hour."""
    import vault_fs

    import enhance
    store, install, cache = clip_box

    tmp = tmp_path / "enhanced.wav"
    tmp.write_bytes(b"RIFF....WAVEfmt the user's enhanced voice")
    dst = cache / "enhanced" / "abc123.wav"

    enhance.store_cache(tmp, dst)

    assert not dst.exists(), "the enhanced WAV's plaintext path is on disk"
    assert vault_fs.read_bytes(dst) == b"RIFF....WAVEfmt the user's enhanced voice"
    assert not tmp.exists(), "the plaintext scratch copy outlived the stage"
    assert_no_cleartext(cache, allow={vault.SENTINEL_NAME}, expect_files=1)


# ── the settings store and the Nomi cache ────────────────────────────────────


def test_voice_settings_yaml_is_encrypted_and_BOTH_readers_still_read_it(clip_box):
    """🔴 TWO INDEPENDENT READERS, and routing only one is worse than routing neither.

    `voice_utils._load_all` is one. `nomi_speak.load_config` is the other, and it does NOT go
    through it (sweep/voices_st.md:250). Route voice_utils alone and Nomi keeps reading the
    encrypted file with a plain read_text, fails to parse it, and falls back to "no Nomis
    configured" — logging a warning that says the YAML is malformed. Every Nomi silently loses
    its voice, and the log blames the file.

    The file is user content: per-voice knobs, Nomi IDs, ST CHARACTER NAMES.
    """
    import voice_utils
    store, install, _ = clip_box
    p = install / "voice_settings.yaml"

    voice_utils._save_all(p, {"nomi": {"12345": {"voice": 'TestVoice.wav', "exaggeration": 0.7}},
                              "global": {'TestVoice.wav': {"cfg": 0.4}}})

    # 🔴 ITS NAME IS STRUCTURAL NOW, SO "the path does not exist" IS NO LONGER THE PROOF.
    # The name is deliberately cleartext (the install root is a git repo as well as a vault
    # root, and an unpredictable ciphertext name cannot be .gitignored). Assert on the BYTES
    # instead, which is the stronger claim and the one that actually matters here.
    assert p.is_file(), "the structural name should be right there in the clear"
    raw = p.read_bytes()
    assert b"Kate.wav" not in raw and b"12345" not in raw, (
        "voice_settings.yaml's CONTENTS are in plaintext on the platter")

    # reader 1
    assert voice_utils._load_all(p)["nomi"]["12345"]["voice"] == 'TestVoice.wav'

    # reader 2 — the one that would have failed silently
    import nomi_speak
    sp = nomi_speak.NomiSpeaker(p, install / "voice_samples", install / "audio_cache")
    assert sp.config.get("12345", {}).get("voice") == 'TestVoice.wav', (
        "nomi_speak could not read the encrypted settings — every Nomi just lost its voice")

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


@needs_ffmpeg
def test_the_nomi_audio_cache_is_encrypted_and_evicts_through_the_vault(clip_box):
    """The Nomi cache is the audio of everything the user's companions have ever said. Its two
    ffmpeg temps used to be written INSIDE the cache directory — i.e. inside the vault.

    `evict()` is the other half: it used to `rglob` the cache, which a vault directory cannot
    answer (the names on disk are ciphertext), and it `stat()`s each entry to sort by age."""
    import nomi_speak
    store, install, cache = clip_box

    sp = nomi_speak.NomiSpeaker(install / "voice_settings.yaml", install / "voice_samples",
                                cache / "audio_cache", max_cached_files=2)

    # Scoped to a speaker (5.3.3), which is also the deeper tree: `<root>/<owner>/<shard>/<key>`
    # is THREE ciphertext levels through the vault where this used to be two.
    owner = 'st:Test Character'
    wav = torch.sin(torch.linspace(0, 240, FAKE_SR // 2)).unsqueeze(0) * 0.3
    for k in ("aa11", "bb22", "cc33"):
        sp.store_wav(k, wav, FAKE_SR, owner)

    import vault_fs
    live = [k for k in ("aa11", "bb22", "cc33") if vault_fs.exists(sp.cache_path(k, owner))]
    assert len(live) == 2, f"eviction did not run through the vault — {len(live)} entries left"
    assert vault_fs.read_bytes(sp.cache_path(live[-1], owner))[:2] in (b"ID", b"\xff\xfb")

    assert_no_cleartext(cache, allow={vault.SENTINEL_NAME}, expect_files=2)


# ── 4.8's voice provenance sidecars (M10 §3a.2) ──────────────────────────────


def _a_voice_in_the_vault(install, stem='OtherVoice'):
    """A clip in the encrypted voice_samples/, plus its path. RIFF header on purpose: it is one
    of the offset-0 magic markers, so a leak of the CLIP fails the grep too."""
    voices = install / "voice_samples"
    vault_fs.mkdir(voices)
    voice = voices / f"{stem}.wav"
    vault_fs.write_bytes(voice, b"RIFF" + b"\x00" * 4096)
    return voice


def test_a_voice_sidecar_is_encrypted_and_still_reads_ITS_STAR_back(box):
    """Sidecar reads and writes must use vault-aware access. An unrouted JSON write leaks plaintext, while checking the encrypted logical path with `is_file()` reports it missing and silently loses provenance and favorite metadata. The test verifies the sidecar remains readable without cleartext storage."""
    _store, install, _cache = box
    voice = _a_voice_in_the_vault(install)

    rt_voices.write_sidecar_or_raise(voice, {
        "origin": "created", "favorite": True, "created": 1_700_000_000.0,
        # the user's own words, and a designed voice really does keep them here
        "sample_text": "Sentence number 7 lives in this test section here."})

    assert not rt_voices.prov_path(voice).exists(), (
        "the sidecar's PLAINTEXT path is on disk — the write did not go through the vault")

    side = rt_voices.read_sidecar(voice)
    assert side.get("origin") == "created", "the sidecar did not read back — the ★ and the origin are gone"
    assert side.get("favorite") is True
    # 🔴 THE WHOLE DICT, DELIBERATELY. `meta()` is what `GET /voices` spreads into every row,
    # so a key added here reaches every voice picker in the product — an exact comparison is what
    # forces that to be a decision rather than a side effect. 8.7 added the three cleaning fields;
    # they are False/"" for a voice nothing has cleaned, which is what this one is.
    assert rt_voices.meta(voice) == {"origin": "created", "favorite": True,
                                     "dereverbed": False, "enhanced": False, "cleaned_from": "",
                                     "added": 1_700_000_000.0, "added_exact": True}

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


def test_a_sidecar_less_voice_still_dates_from_its_REAL_mtime_through_the_vault(box):
    """The other half of the same defect, and 🟠 rather than 🔴 only because no bytes leak.

    `_voice_added` falls back to the clip's mtime for a voice with no sidecar — and a bare
    `voice.stat()` inside an encrypted `voice_samples/` raises FileNotFoundError, which its own
    `except OSError` swallows into 0.0. Every sidecar-less voice would date to the epoch, and
    the Voices tab sorts by add-date BY DEFAULT: the list comes back in silently arbitrary
    order, looking exactly like a list that is merely sorted differently than you remembered.

    `voices_favorite` reads the same mtime and does NOT catch OSError, so there the same bare
    stat is a 500 on every ★ of an un-stamped voice.
    """
    _store, install, _cache = box
    voice = _a_voice_in_the_vault(install, stem="Unstamped")

    assert rt_voices.read_sidecar(voice) == {}, "this voice is supposed to have no sidecar"

    added, exact = rt_voices.added_at(voice, {})
    assert exact is False, "an mtime is an inferred date and must never be reported as a fact"
    assert added == pytest.approx(vault_fs.stat(voice).mtime), (
        f"dated {added} — a sidecar-less voice fell back to the epoch, so the default "
        f"'recently added' sort is arbitrary")


def test_the_backfill_script_can_see_voices_inside_the_vault_at_all(box):
    """🔴 IT WOULD HAVE STAMPED NOTHING AND EXITED 0.

    `scripts/backfill-voice-sidecars.py` is the documented way a hand-dropped clip ever gets a
    sidecar — `_voice_origin` says so, and the server deliberately does not stamp from the read
    path. Walking the store with `iterdir()` hands back SIV-ciphertext names, whose suffixes are
    not in AUDIO_EXTS, so the loop matches zero files: "0 stamped, 0 skipped", exit 0, on a
    folder full of voices. A tool that reports success over an empty result set is the §2 shape
    exactly.
    """
    import importlib.util
    _store, install, _cache = box
    voice = _a_voice_in_the_vault(install, stem="Handdropped")

    spec = importlib.util.spec_from_file_location(
        "backfill_voice_sidecars", REPO_ROOT / "scripts" / "backfill-voice-sidecars.py")
    backfill = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backfill)

    counts = backfill.backfill(voice.parent)
    assert counts["stamped"] == 1, f"the script could not see the voices at all: {counts}"

    side = rt_voices.read_sidecar(voice)
    assert side.get("origin") == "uploaded" and side.get("backfilled") is True
    assert side.get("created", 0) > 0, "stamped with an epoch date — it never saw the real mtime"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


def test_freezing_a_DESIGNED_voice_does_not_leave_the_clip_in_cleartext(box, monkeypatch, tmp_path):
    """Uploaded and design-frozen voices use different creation paths, but both must store encrypted audio. Plaintext may be used in scratch between those paths and the durable vault. The round trip is checked by value because copying ciphertext into `from_scratch` could encrypt it twice without producing a cleartext match."""
    _store, install, _cache = box
    scratch_root = tmp_path / "scratch"
    scratch_root.mkdir()
    monkeypatch.setattr(rt_configs, "scratch_root", lambda: scratch_root)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", install / "voice_samples")
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", install / "voice_settings.yaml")
    monkeypatch.setattr(rt_paths, "VOICE_CANDIDATES", install / "voice_candidates")

    # Put the candidate there the way a generate does: write plaintext in the scratch, then
    # cross the seam. Writing it straight into the store with a bare open() would test a file
    # shape the application never produces.
    token = "0" * 32
    clip = b"RIFF" + bytes(range(256)) * 16          # not all zeroes — a cipher of zeroes is a
    tmp_clip = scratch_root / "raw.wav"              # weak thing to compare against
    tmp_clip.write_bytes(clip)
    vault_fs.mkdir(rt_paths.VOICE_CANDIDATES)
    vault_fs.from_scratch(tmp_clip, rt_paths.VOICE_CANDIDATES / f"{token}.wav")
    assert not (rt_paths.VOICE_CANDIDATES / f"{token}.wav").exists(), (
        "the candidate's PLAINTEXT path is on disk — the audition store is not routed, which is "
        "the silent leak vault_store.ROUTES's voice_models/ comment describes")

    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        r = c.post("/voices/design/save", json={"token": token, "name": 'OtherVoice'})
    assert r.status_code == 200, r.get_data(as_text=True)

    saved = rt_paths.VOICE_SAMPLES / r.get_json()["name"]
    assert not saved.exists(), "the voice's PLAINTEXT path is on disk — the freeze bypassed the vault"
    # 🔴 BY VALUE, not by prefix. `startswith(b"RIFF")` was enough when the source was plaintext;
    # it is not enough now, because a double-encrypted clip fails this line while passing every
    # structural check in the file.
    assert vault_fs.read_bytes(saved) == clip, (
        "the saved voice is not the candidate's audio — the save path copied CIPHERTEXT into "
        "from_scratch, which encrypted it again: it saves fine, lists fine, and plays as noise")
    assert r.get_json()["size"] == len(clip), "size is not the PLAINTEXT size the user is shown"

    assert vault_fs.exists(rt_paths.VOICE_CANDIDATES / f"{token}.wav"), (
        "the audition candidate was consumed — from_scratch removes its source, and under §18.5 "
        "a candidate lives until the user deletes it, however many voices he saves from it")

    # 3 files: the two vault_keys/sentinel this helper already allows, plus the candidate.
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=3)


def test_the_NEVER_OVERWRITE_rule_survives_encryption(box, monkeypatch):
    """🔴 SILENT DATA LOSS — and both guards against it failed the same way.

    §14.9.1 is "ONE RULE — NEVER OVERWRITE", enforced by `_voice_name_conflict` walking
    `_voice_files()`. That walk was `VOICE_SAMPLES.iterdir()`: ciphertext names, no audio
    suffix, empty list, no conflict ever found. `_unique_wav_name`'s `.exists()` — the second
    guard — answered False for the same reason and handed back the same filename. So saving a
    second voice called "TestVoice" would 200, resolve to TestVoice.wav, and REPLACE the first one, in
    the one store that cannot be regenerated.
    """
    _store, install, _cache = box
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", install / "voice_samples")
    monkeypatch.setattr(rt_paths, "VOICE_SETTINGS", install / "voice_settings.yaml")

    vault_fs.mkdir(rt_paths.VOICE_SAMPLES)
    vault_fs.write_bytes(rt_paths.VOICE_SAMPLES / "TestVoice.wav", b"RIFF" + b"\x00" * 2048)
    vs.voice_utils.set_label(rt_paths.VOICE_SETTINGS, "TestVoice.wav", "TestVoice")

    assert [p.name for p in rt_voices.files()] == ["TestVoice.wav"], (
        "the Voices tab is EMPTY inside the vault — and an empty list is what defeats the "
        "overwrite guard, not just what the user sees")

    hit = rt_voices.name_conflict("testvoice")           # case-insensitive by rule
    assert hit is not None, "the never-overwrite rule did not fire — the next save destroys this voice"
    assert hit[1].name == "TestVoice.wav"

    assert rt_voices.unique_wav_name("TestVoice") != "TestVoice.wav", (
        "the second guard handed back the live voice's own filename")


# ── §4.1 importing a brought-your-own RVC voice (M10 step 1) ─────────────────


def _fake_rvc_pth(path):
    """A checkpoint `validate_rvc_pth` accepts. torch.save writes a ZIP, so its `PK\\x03\\x04`
    magic is one of the offset-0 markers — a plaintext landing fails the grep."""
    torch.save({"weight": {"x": torch.zeros(4)}, "config": [1, 2, 3],
                "sr": 40000, "f0": 1, "version": "v2", "epoch": 200}, str(path))
    return path


def test_importing_an_RVC_VOICE_leaves_no_plaintext_checkpoint(box, tmp_path):
    """🔴🔴 §4.1 — "THE WORST ITEM IN THIS DOCUMENT", and the store you cannot rebuild.

    `voice_models/` is 13–18 GPU-HOURS per voice with no re-download. `import_voice` was fully
    raw — `open(tmp,"wb")`, `os.replace`, `dest_pth.exists()` — and staged through
    `.import-<uuid>.pth` INSIDE the registry, so a 150 MB plaintext checkpoint landed in the
    encrypted store and looked perfect forever. `migrate_voices` was that same write in 4.2;
    4.6 reintroduced it in the same directory three months later, which is §10.6: a file that
    is 56 `vault_fs` calls deep still grew a raw one.

    The staging temp must be scratch-side — `validate_rvc_pth` safe-loads a pickle and needs a
    real path — and `from_scratch` is the only crossing back in.
    """
    import voiceswap
    _store, install, _cache = box
    rvc = install / "voice_models"

    src = _fake_rvc_pth(tmp_path / "upload.pth")
    with open(src, "rb") as f:
        got = voiceswap.import_voice(rvc, "SampleVoice", f, index_stream=io.BytesIO(b"INDEXBLOB" * 64))

    assert got["name"] == "SampleVoice" and got["index"] is True and got["sr"] == 40000

    assert not (rvc / "SampleVoice.pth").exists(), (
        "the checkpoint's PLAINTEXT path is on disk — the import bypassed the vault")
    assert vault_fs.read_bytes(rvc / "SampleVoice.pth").startswith(b"PK\x03\x04"), (
        "the checkpoint did not survive the round trip")
    assert vault_fs.read_bytes(rvc / "SampleVoice.index").startswith(b"INDEXBLOB")

    # The registry's own reader must agree — it was already routed, and half a conversion
    # (write raw, read routed) is how a voice goes missing rather than loudly failing.
    listed = voiceswap.list_voices(rvc)
    assert [v["name"] for v in listed] == ["SampleVoice"]
    assert listed[0]["index"] == "SampleVoice.index" and listed[0]["size"] > 0

    strays = [p.name for p in rvc.iterdir() if p.name.startswith((".import-", ".addidx-"))]
    assert not strays, f"a cleartext staging temp was left inside the registry: {strays}"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


def test_a_REJECTED_import_keeps_nothing_and_leaves_the_registry_untouched(box, tmp_path):
    """Validation happens in the scratch, so a hostile or corrupt .pth must leave the store
    exactly as it was — and must not leave its staging temp behind either, in the scratch or
    in the registry. `scratch.file` deletes on the way out of the `with` on every path."""
    import voiceswap
    import scratch as scratch_mod
    _store, install, _cache = box
    rvc = install / "voice_models"

    def scratch_files():
        return {p for p in scratch_mod.scratch_root().rglob("*") if p.is_file()}

    # 🔴 What THIS import leaves, not what the whole PROCESS has left. The scratch root is
    # shared and boot-ephemeral: a pre-render spool lives there until the 120 s sweep or the
    # next startup (prerender.py's docstring says so), so `assert not any files` was really
    # asserting "no other test has used the scratch yet" — true only while this file happened
    # to sort before test_prerender, and a false failure the moment anything sorts ahead of it.
    already_there = scratch_files()

    good = _fake_rvc_pth(tmp_path / "good.pth")
    with open(good, "rb") as f:
        voiceswap.import_voice(rvc, "Keeper", f)
    before = vault_fs.read_bytes(rvc / "Keeper.pth")

    with pytest.raises(voiceswap.VoiceValidationError):
        voiceswap.import_voice(rvc, "Keeper", io.BytesIO(b"not a pickle at all"), replace=True)

    assert vault_fs.read_bytes(rvc / "Keeper.pth") == before, (
        "a REJECTED import destroyed the voice it was replacing")
    assert vault_fs.listdir(rvc) == ["Keeper.pth"]

    leftovers = sorted(p.name for p in scratch_files() - already_there)
    assert not leftovers, f"the staging temp outlived the failed import: {leftovers}"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


def test_add_index_finds_a_voice_that_is_ONLY_visible_through_the_vault(box, tmp_path):
    """`add_index` gated on `(d / f"{leaf}.pth").is_file()` — False for every voice once the
    registry is encrypted, so it raised "no such voice in the registry" for a voice the panel
    was displaying at that moment. §10.2: exists/is_file answer WRONG rather than raising."""
    import voiceswap
    _store, install, _cache = box
    rvc = install / "voice_models"

    with open(_fake_rvc_pth(tmp_path / "v.pth"), "rb") as f:
        voiceswap.import_voice(rvc, "TestVoice", f)
    assert voiceswap.list_voices(rvc)[0]["index"] is None

    got = voiceswap.add_index(rvc, "TestVoice", io.BytesIO(b"INDEXBLOB" * 64))
    assert got == {"name": "TestVoice", "index": True}
    assert voiceswap.list_voices(rvc)[0]["index"] == "TestVoice.index"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


# ── §8's SHIP GATE: the surfaces M10 converted, driven with the vault ON ─────


def test_the_SWAP_QUEUE_survives_a_restart_and_names_no_song_in_cleartext(box, monkeypatch):
    """The swap queue contains song and voice names, so its temporary and final files must use routed storage. Reloading a queue from the same path must retain pending jobs rather than silently returning an empty queue."""
    import swap_queue
    _store, install, _cache = box
    qpath = install / "output" / "voiceswap_queue.yaml"

    q = swap_queue.SwapQueue(qpath)
    q.add({"song": 'Sample Track.mp3', "voice": "SampleVoice", "pitch": 0},
          label='Sample Track', kind="song")
    assert len(q.entries) == 1

    assert not qpath.exists(), "the queue's PLAINTEXT path is on disk — _save bypassed the vault"
    assert not list((install / "output").glob("*.part")), (
        "a cleartext .part sibling was left inside the routed output tree")

    again = swap_queue.SwapQueue(qpath)             # ← the restart
    assert len(again.entries) == 1, "the queue came up EMPTY — every pending swap forgotten"
    assert again.entries[0]["req"]["song"] == 'Sample Track.mp3'
    assert again.entries[0]["status"] == "pending"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


def test_a_CLEANED_CLIP_lands_encrypted_and_still_reports_its_duration(box, monkeypatch, tmp_path):
    """`_land` stores cleaned clips in the vault, where a child process without the DEK cannot probe the ciphertext. Measure duration from the decrypted scratch file before landing, then verify the encrypted clip and its duration through the routed interface. This test drives the landing/probe seam without running the denoiser."""
    import cleanup
    from tts_utils import save_wav_sf
    from voiceswap import ffprobe_duration
    _store, install, _cache = box
    scratch_root = tmp_path / "scratch"
    scratch_root.mkdir()

    take = scratch_root / "take.wav"                       # a scratch take, as run_cleanup makes
    save_wav_sf(str(take), torch.zeros(1, FAKE_SR), FAKE_SR)     # 1.0 s of silence
    dst = install / "voice_training" / "clip.cleaned.wav"

    dur = ffprobe_duration(take)                           # C6: probe BEFORE landing
    cleanup._land(take, dst)

    assert not dst.exists(), "the cleaned clip's PLAINTEXT path is on disk — _land bypassed the vault"
    assert vault_fs.read_bytes(dst).startswith(b"RIFF"), "the clip did not survive the round trip"
    assert not take.exists(), "from_scratch is a MOVE — the scratch take should be consumed"
    assert not list((install / "voice_training").glob("*.part")), (
        "a cleartext .part sibling was left inside the routed training tree")

    assert dur is not None and 0.8 < dur < 1.2, (
        f"the duration probe read {dur} — C6 must measure the scratch take, not the landed file")

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


def test_a_cleaned_clips_IDENTITY_still_changes_when_the_source_does(box, monkeypatch, tmp_path):
    """Cleanup identity must reflect the source size and modification time. If a routed stat falls back to the path alone, replacing audio at the same path can be mistaken for an already processed clip."""
    import cleanup
    _store, install, _cache = box
    src = install / "voice_training" / "take.wav"
    vault_fs.mkdir(src.parent)
    vault_fs.write_bytes(src, b"RIFF" + bytes(4096))

    h1 = cleanup.cleanup_hash(src, cleanup.DEFAULT_PRESET)
    assert h1 is not None and len(h1) == 16, "an encrypted source lost its identity entirely"

    vault_fs.write_bytes(src, b"RIFF" + bytes([1]) * 9000)   # re-recorded, same name
    h2 = cleanup.cleanup_hash(src, cleanup.DEFAULT_PRESET)
    assert h2 != h1, (
        "the identity did not change when the audio did — Clean up will serve the cleaning of "
        "a clip that no longer exists")


def test_the_cleanup_preview_snippets_are_in_the_SCRATCH_not_the_store(box, monkeypatch, tmp_path):
    """Preview snippets are temporary decrypted A/B audio with a one-hour lifetime. Keep them in scratch rather than the persistent output vault so they are discarded without mixing them with user renders."""
    import scratch as scratch_mod
    from vocalis.web import cleanup as web_cleanup
    _store, install, _cache = box
    scratch_root = tmp_path / "scratch"
    scratch_root.mkdir()
    monkeypatch.setattr(rt_configs, "scratch_root", lambda: scratch_root)

    pdir = web_cleanup.cleanup_preview_dir()
    assert scratch_root in pdir.parents, f"previews are not in the scratch: {pdir}"
    assert vault_store.route(pdir) is None, (
        "the router CLAIMS the preview dir — §7.1 moved it precisely so it would not")

    # ...and the startup sweep is allowed to take them, unlike bulk/.
    #
    # 🔴 CANDIDATES_SUBDIR USED TO BE IN THIS COMPANY AND IS NOT ANY MORE (7.0-m7). Its exemption
    # bought a `systemctl restart` for a thing that LIVED there under a 6 h TTL; §18.5 retired the
    # TTL and the candidates moved into `voice_candidates/` in the vault, so all that is left in
    # the scratch dir is the freeze debris of a run in flight. Asserted against `sweep`'s actual
    # default rather than a restated list, so this cannot pass while the default drifts.
    assert scratch_mod.CLEANUP_PREVIEW_SUBDIR not in (
        scratch_mod.BULK_SUBDIR, scratch_mod.INSTANCE_MARKER)
    kept = inspect.signature(scratch_mod.sweep).parameters["keep"].default
    assert scratch_mod.CANDIDATES_SUBDIR not in kept, (
        "the audition work area is exempt from the startup sweep again — it holds nothing "
        "durable now, so the only thing an exemption preserves is the plaintext debris of a run "
        "that was SIGKILLed mid-freeze, which is exactly what the sweep is for")
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "abc123abc123.orig.wav").write_bytes(b"RIFF" + bytes(64))
    scratch_mod.sweep(scratch_root)
    assert not pdir.exists(), (
        "the sweep spared the preview dir — a snippet promises nothing beyond the click that "
        "made it, and exempting it would keep plaintext audio across a restart for no reason")


# ── the RVC voice registry (main's 4.2-m0a moved it under us) ────────────────


def test_a_voice_model_in_the_vault_keeps_its_swap_identity(box, tmp_path):
    """🔴🔴 THE ONE THAT WOULD SILENTLY RE-RENDER THE SWAP LIBRARY.

    `swap_hash()` folds the voice .pth's SIZE and MTIME into the identity of every swap ever
    rendered — deliberately, so a RETRAINED .pth under the same name re-renders instead of
    serving the old voice's take. Encrypt the .pth and its size on disk changes. Every stored
    swap becomes unreachable by identity, silently re-renders, and Demucs re-runs across the lot.

    It used to be gocryptfs's problem, and gocryptfs solved it for free by being a transparent
    MOUNTPOINT: Vocalis stat'd the mount and saw the plaintext size. 4.2-m0a moved the registry
    into the install root and that escape hatch went with it. vault.py has no mountpoint.

    The fix is the identity seam, and the proof is this: the SAME .pth, hashed inside the vault
    and outside it, must give the SAME swap identity. Nothing is recorded anywhere to make that
    true — vault.plaintext_len derives it from the ciphertext length, exactly.
    """
    import voiceswap
    store, install, _ = box

    pth_bytes = b"PK\x03\x04" + b"the trained voice, 13-18 GPU hours" * 500

    # (1) the SAME bytes, as a plain file OUTSIDE any vault root
    plain = tmp_path / "outside" / 'testvoice.pth'
    plain.parent.mkdir(parents=True)
    plain.write_bytes(pth_bytes)
    import os as _os
    _os.utime(plain, (1_700_000_000, 1_700_000_000))
    id_plain = voiceswap.swap_hash("song1", plain, 0, 0.5, 1.0, 1.0)

    # (2) the same bytes INSIDE the vault, same mtime
    import vault_fs
    vaulted = install / "voice_models" / 'testvoice.pth'
    vault_fs.write_bytes(vaulted, pth_bytes)
    v, logical = vault_store.route(vaulted)
    _os.utime(v._map(logical), (1_700_000_000, 1_700_000_000))

    # the ciphertext really is a different size — otherwise this test proves nothing
    assert v._map(logical).stat().st_size != len(pth_bytes), (
        "the ciphertext is the same size as the plaintext here, so this test cannot tell the "
        "broken version from the fixed one")

    id_vaulted = voiceswap.swap_hash("song1", vaulted, 0, 0.5, 1.0, 1.0)

    assert id_vaulted == id_plain, (
        "the voice model's swap identity MOVED when it was encrypted — every stored swap in the "
        "library just became unreachable, and Demucs is about to re-run across all of them")


def test_a_missing_voice_model_still_raises_rather_than_hashing_to_nothing(box):
    """source_stat answers "gone" with None. Defaulting that to (0, 0) would give every missing
    voice the SAME identity — two of them collide on one swap_hash and one swap's MP3
    os.replace()s the other's. That is not hypothetical: it is the bug M2.5 fixed in stems_id,
    which fabricated "" as a corrupt set's identity. It used to raise. It still raises."""
    import voiceswap
    store, install, _ = box
    with pytest.raises(FileNotFoundError):
        voiceswap.swap_hash("song1", install / "voice_models" / "gone.pth", 0, 0.5, 1.0, 1.0)


def test_migrate_voices_does_not_deposit_plaintext_pth_into_the_store(box, tmp_path, monkeypatch):
    """Startup migration moves legacy RVC models from `/ai-models/rvc` into the vault. A direct filesystem move across that boundary would leave plaintext bytes under encrypted storage; migration must read the source and write through the vault-aware path, including during unattended restore or rebuild."""
    import vault_fs

    import voiceswap
    store, install, _ = box

    legacy = tmp_path / "ai-models" / "rvc"
    legacy.mkdir(parents=True)
    (legacy / 'testvoice.pth').write_bytes(b"PK\x03\x04 the trained voice")
    (legacy / 'testvoice.index').write_bytes(b"the faiss index")
    monkeypatch.setattr(voiceswap, "LEGACY_RVC_DIR", legacy)

    cfg = type("C", (), {"rvc_dir": install / "voice_models"})()
    moved = voiceswap.migrate_voices(cfg)

    assert moved == ['testvoice']
    assert not (legacy / 'testvoice.pth').exists(), "the plaintext original was left behind"
    assert vault_fs.read_bytes(install / "voice_models" / 'testvoice.pth') == b"PK\x03\x04 the trained voice"
    assert not (install / "voice_models" / 'testvoice.pth').exists(), "the .pth is on disk in cleartext"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


# ── serving a file back OUT of the vault: the hand-rolled 206 ────────────────


def test_the_206_range_path_serves_PLAINTEXT_and_only_decrypts_the_range(box, monkeypatch):
    """🔴 WERKZEUG DOES 100% OF THE RANGE HANDLING TODAY, BY OPENING THE PATH.

    After M6 that path does not exist, so every audio route in the app would 404 on a file
    sitting right there. The sweep feared worse and was right to: hand Werkzeug the CIPHERTEXT
    and it ranges over it happily and serves the browser noise — with a 206, and no error
    anywhere.

    So the 206 is hand-rolled through `vault.stream_range()`, which decrypts ONLY the blocks the
    range touches. This test pins both halves: the bytes are the PLAINTEXT ones, and a range
    request does not drag the whole file through the cipher — the second is what keeps scrubbing
    a 90-minute audiobook cheap, and it is the entire reason stream_range exists.
    """
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)   # rt_auth.STORE and vault_store.STORE — BOTH

    body = bytes(range(256)) * 400                        # 102,400 bytes, every byte known
    clip = install / "output" / "playground" / 'TestVoice' / "hi_ab12cd34.mp3"
    import vault_fs
    vault_fs.write_bytes(clip, body)

    v, logical = vault_store.route(clip)
    reads = []
    # The seam is stream_range_CHUNKS: the 206 streams the range rather than materializing it
    # (see test_a_whole_file_range_streams_instead_of_materializing). What this pins is
    # unchanged — that the bytes came out of the vault's ranged reader, decrypting only the
    # blocks the range touches, and not out of Werkzeug ranging over ciphertext.
    real_chunks = vault.Vault.stream_range_chunks
    monkeypatch.setattr(vault.Vault, "stream_range_chunks",
                        lambda self, lg, s, e, *a, **k: (reads.append((s, e)),
                                                         real_chunks(self, lg, s, e, *a, **k))[1])

    with vs.app.test_request_context(headers={"Range": "bytes=1000-1099"}):
        resp = store_serve.send_store_file(clip, mimetype="audio/mpeg")

    assert resp.status_code == 206
    assert resp.headers["Content-Range"] == f"bytes 1000-1099/{len(body)}"
    assert resp.headers["Accept-Ranges"] == "bytes"
    assert resp.get_data() == body[1000:1100], "the 206 served the wrong bytes"
    assert reads == [(1000, 1099)], "the range was not served through the vault's ranged reader"


def test_the_voices_audio_route_serves_a_complete_body_through_the_full_stack(box, monkeypatch):
    """The WHOLE Flask stack, not just send_store_file.

    Every other range test here calls send_store_file inside a request context and reads the
    bytes straight back. That skips finalize_request, every after_request, and the WSGI
    hand-off — and a STREAMED body is exactly where those differ. Get it wrong and the browser
    receives a player with zero duration that never plays, while every in-process assertion in
    this file still passes.
    """
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)

    import vault_fs
    samples = install / "voice_samples"
    vault_fs.mkdir(samples)
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", samples)
    body = bytes(range(256)) * 400
    vault_fs.write_bytes(samples / "probe.wav", body)

    c = vs.app.test_client()
    # `bytes=0-` is the browser's first request for any media src, and it covers the whole file
    # — so this is BOTH "the clip arrives in one response" and "ranges are supported". The two
    # are not alternatives: honoring Range is what makes the element seekable, and serving it
    # without ranges (M10d) left a player that played fine and refused to scrub.
    r = c.get("/voices/probe.wav/audio", headers={"Range": "bytes=0-"})
    assert r.status_code in (200, 206), f"the audio route answered {r.status_code}"
    assert r.headers.get("Accept-Ranges") == "bytes", (
        "🔴 without Accept-Ranges Chrome treats the clip as non-seekable: seekable ends at 0 "
        "and every currentTime write is discarded, so the scrub bar snaps back")
    assert r.get_data() == body, "the body that reached the client was not the whole file"

    full = c.get("/voices/probe.wav/audio")            # no Range: the 200 path
    assert full.status_code == 200
    assert full.get_data() == body


def test_a_streamed_range_survives_the_request_context_being_popped(box, monkeypatch):
    """A WSGI server iterates the response body AFTER Flask has popped the request context.

    get_data() inside the context proves the BYTES are right; it does not prove they still
    arrive once the context is gone — and a generator that opens the vault handle lazily does
    its open() at iteration time, i.e. out there. Get this wrong and the endpoint 200s with an
    empty or truncated body: the browser shows a player and simply never plays.
    """
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)

    body = bytes(range(256)) * 400
    clip = install / "output" / "playground" / 'TestVoice' / "hi_ab12cd34.mp3"
    import vault_fs
    vault_fs.write_bytes(clip, body)

    with vs.app.test_request_context(headers={"Range": "bytes=0-"}):
        resp = store_serve.send_store_file(clip, mimetype="audio/mpeg")
    # context popped — now iterate exactly as the WSGI server does
    assert b"".join(resp.iter_encoded()) == body, \
        "the streamed range did not survive the request context being popped"


def test_a_whole_file_range_streams_instead_of_materializing(box, monkeypatch):
    """`bytes=0-` is what a browser sends as its FIRST request for any <audio> src, and it
    resolves to a range covering the WHOLE file.

    Served through stream_range() — one bytes object — that allocated the entire plaintext on
    every media request: exactly the cost send_store_file's full-body path was written to
    avoid ("these are audiobooks"), reintroduced through the range door on the most common
    request shape there is. So the 206 must STREAM, and the materializing helper must not be
    what an HTTP range goes through.
    """
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)

    body = bytes(range(256)) * 400
    clip = install / "output" / "playground" / 'TestVoice' / "hi_ab12cd34.mp3"
    import vault_fs
    vault_fs.write_bytes(clip, body)

    monkeypatch.setattr(vault.Vault, "stream_range",
                        lambda *a, **k: pytest.fail("a 206 must not materialize the range"))

    with vs.app.test_request_context(headers={"Range": "bytes=0-"}):
        resp = store_serve.send_store_file(clip, mimetype="audio/mpeg")

    assert resp.status_code == 206
    assert resp.is_streamed, "the whole-file range was materialized instead of streamed"
    assert resp.headers["Content-Range"] == f"bytes 0-{len(body) - 1}/{len(body)}"
    assert resp.headers["Content-Length"] == str(len(body))
    assert resp.get_data() == body, "streaming it changed the bytes"


def test_a_suffix_range_serves_the_END_of_the_file_not_a_negative_offset(box, monkeypatch):
    """`bytes=-500` means THE LAST 500 BYTES. Read it as a negative offset and you serve the
    wrong end of the file — a browser asking for the tail of an MP3 gets the head, and the
    duration it computes from it is nonsense."""
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)

    body = bytes(range(256)) * 400
    clip = install / "output" / "playground" / 'TestVoice' / "hi_ab12cd34.mp3"
    import vault_fs
    vault_fs.write_bytes(clip, body)

    with vs.app.test_request_context(headers={"Range": "bytes=-500"}):
        resp = store_serve.send_store_file(clip)
    assert resp.status_code == 206
    assert resp.get_data() == body[-500:], "a suffix range served the wrong end of the file"


def test_the_full_body_path_streams_the_plaintext(box, monkeypatch):
    """No Range header — the whole file, decrypted, streamed. NOT materialized: these are
    audiobooks, and a BytesIO(read_bytes()) here is a 200 MB allocation per request."""
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)

    body = b"ID3\x04" + bytes(range(256)) * 100
    clip = install / "output" / "playground" / 'TestVoice' / "hi_ab12cd34.mp3"
    import vault_fs
    vault_fs.write_bytes(clip, body)

    with vs.app.test_request_context():
        resp = store_serve.send_store_file(clip, mimetype="audio/mpeg")
    assert resp.status_code == 200
    assert resp.headers["Accept-Ranges"] == "bytes"     # without it Chrome will not seek AT ALL
    assert int(resp.headers["Content-Length"]) == len(body)
    assert resp.get_data() == body


def test_a_file_we_do_not_own_still_goes_to_the_real_send_file(box, monkeypatch, tmp_path):
    """An /ai-output song, or any box that has not migrated. Werkzeug keeps doing exactly what it
    has always done, Range and all."""
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)

    outside = tmp_path / "acestep" / "song.mp3"
    outside.parent.mkdir(parents=True)
    outside.write_bytes(b"ID3 a song that is NOT ours")
    assert vault_store.route(outside) is None

    with vs.app.test_request_context():
        resp = store_serve.send_store_file(outside)
    assert resp.status_code == 200
    # send_file hands back a direct_passthrough response (it streams the fd) — which is itself
    # the proof this went to Werkzeug and not down the vault arm.
    assert resp.direct_passthrough
    resp.direct_passthrough = False
    assert b"NOT ours" in resp.get_data()


def test_uploading_a_book_does_not_put_the_manuscript_in_the_store_in_cleartext(box, tmp_path,
                                                                                monkeypatch):
    """🔴 `f.save(str(dst))` wrote THE WHOLE BOOK straight into books/, which is in the vault.

    A plaintext manuscript sitting in the encrypted store, and nothing anywhere would have said
    so — the upload succeeds, the book lists, it renders. The book is the one artifact in this
    application that is unambiguously, entirely, the user's own words. It is what the project is
    FOR.

    Werkzeug's FileStorage can only save to a real path, so it saves to the SCRATCH and the bytes
    come back through the cipher.
    """
    import io as _io

    import vault_fs

    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)
    monkeypatch.setattr(rt_paths, "BOOKS_DIR", install / "books")
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(tmp_path / "scratch"))

    manuscript = b"PK\x03\x04" + b"Sentence number one, and it is the user's own prose." * 50
    client = vs.app.test_client()
    with client.session_transaction() as sess:
        sess["logged_in"] = True
    r = client.post("/books", data={"file": (_io.BytesIO(manuscript), "My Novel.epub")},
                    content_type="multipart/form-data")

    assert r.status_code == 200, r.get_data(as_text=True)
    dst = install / "books" / "My Novel.epub"
    assert not dst.exists(), "the manuscript's plaintext path is on disk"
    assert vault_fs.read_bytes(dst) == manuscript, "the book did not survive the round trip"

    # the listing still reads it back — decrypted name, LOGICAL size
    rows = client.get("/books").get_json()
    assert rows == [{"name": "My Novel.epub", "size": len(manuscript)}], (
        f"the listing is wrong — a raw stat would report the CIPHERTEXT size here: {rows}")

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


def test_a_canceled_render_keeps_the_users_text_encrypted_in_its_manifest(clip_box):
    """pending.yaml holds the user's FULL ORIGINAL TEXT for a canceled render, kept on purpose
    and with no TTL — it is what a resume resumes FROM, and it is why SPEC_5_0_M6 §3 refuses to
    "just wipe the cache" on a sentinel miss. Derived is not disposable.

    It lives in the CACHE vault, so this is also the test that the second root is really wired
    up and is not quietly writing plaintext beside the encrypted one.
    """
    import playground_clips
    store, install, cache = clip_box

    ws = playground_clips.workspace(cache / "chunks", "0123456789ab")
    playground_clips.write_pending(ws, {"text": "Sentence number seven.", "voice": 'TestVoice',
                                        "total": 4})
    _a_real_wav(ws / "chunk_0000.wav")

    assert playground_clips.read_pending(ws)["text"] == "Sentence number seven."
    rows = playground_clips.list_partials(cache / "chunks")
    assert len(rows) == 1 and rows[0]["text"] == "Sentence number seven."
    assert rows[0]["done"] == 1 and rows[0]["prefix"] == 1
    assert rows[0]["duration_s"] > 0, "the banked chunk's header did not read through the vault"

    assert_no_cleartext(cache, allow={vault.SENTINEL_NAME}, expect_files=2)


# ── M7: voice training — the pool, the dataset, and Applio's workspace ───────
#
# The training track holds the user's OWN RECORDED VOICE, and it is the only track with a store
# on BOTH sides of a foreign child: the clips and the prepared dataset are ours (and encrypted),
# while Applio's workspace is not ours at all. So it is also the one place where "route it" is
# not the whole answer — see the workspace tests at the bottom.


class _Stop(Exception):
    """Cut the pipeline off at the train stage: everything past it belongs to Applio."""


@pytest.fixture
def train_box(box, tmp_path, monkeypatch):
    """The box, a scratch, and a TrainConfig whose stores are INSIDE the install vault.

    🔴 `training_dir` and `rvc_dir` MUST be under the install root or none of this tests anything:
    a TrainConfig pointing at a bare tmp_path routes to None, and every assertion below would
    pass, greenly, over a store that is 100% cleartext. That is the exact trap this file exists
    for, and the fixture is where it would be sprung."""
    import voicetrain
    _store, install, _cache = box
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(tmp_path / "scratch"))
    cfg = voicetrain.TrainConfig(
        applio_dir=tmp_path / "Applio",           # NOT ours: outside every root, never routed
        rvc_dir=install / "voice_models",         # ours, and in the vault
        training_dir=install / "voice_training",  # ours, and in the vault
    )
    cfg.python.parent.mkdir(parents=True, exist_ok=True)
    cfg.python.write_bytes(b"")
    cfg.logs_dir.mkdir(parents=True, exist_ok=True)
    # Without the sentinel the guard fires and every test below would be testing the guard
    # instead of the thing it came for.
    (cfg.logs_dir / voicetrain.WORKSPACE_SENTINEL).write_text("on the encrypted volume")
    return cfg, install


def _wav_bytes(seconds=0.4, sr=44100):
    """A real WAV, as bytes — what an upload actually arrives as."""
    import io

    import numpy as np
    import soundfile as sf
    buf = io.BytesIO()
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    sf.write(buf, (0.3 * np.sin(2 * np.pi * 220 * t)).astype("float32"), sr, format="WAV")
    return buf.getvalue()


def test_uploading_a_training_clip_leaves_no_cleartext(train_box):
    """🔴 The user's own recorded voice, arriving over HTTP.

    The `.part` used to be written INSIDE `training_dir` — a whole uploaded recording, cleartext,
    inside the vault, for as long as the upload took, and left there permanently by any crash
    mid-upload. Nothing about that raises. It is the silent write, and the grep is the only thing
    in the project that can see it."""
    import io

    import vault_fs

    import voicetrain
    cfg, install = train_box
    raw = _wav_bytes()

    row = voicetrain.save_upload(cfg, "Test User singing.wav", io.BytesIO(raw))

    assert row["name"] == "Test User singing"
    assert row["size"] == len(raw), "the row shows the CIPHERTEXT size, not the audio's"
    assert not (cfg.training_dir / "Test User singing.wav").exists(), \
        "the clip is on the platter under its own name, in cleartext"
    assert vault_fs.read_bytes(cfg.training_dir / "Test User singing.wav") == raw
    assert [r["ref"] for r in voicetrain.list_sources(cfg)] == ["Test User singing.wav"]

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


@needs_ffmpeg
def test_ffprobe_duration_reads_a_clip_INSIDE_the_vault(train_box):
    """🔴 THE QUIET ONE. It poisons a sidecar instead of failing.

    ffprobe is a child, so inside the vault the path it is handed does not exist — and
    `ffprobe_duration` answers failure with **0.0**, deliberately, because a duration is display
    metadata and is never worth failing a job over. That contract is right, and it is what makes
    this invisible.

    `duration_of` then PERSISTS the zero, keyed to the clip's real (size, mtime) — so it is now a
    cache HIT and will never be re-probed. And `prep_plan` reads a 0-second clip as "longer than
    the budget": it trims it to the full 3600 s, spends the entire 60-minute dataset budget on it,
    and SILENTLY SKIPS EVERY OTHER CLIP in the selection. A five-clip dataset trains as one, and
    the log says nothing at all."""
    import io

    import voicetrain
    cfg, _install = train_box

    voicetrain.save_upload(cfg, "clip.wav", io.BytesIO(_wav_bytes(seconds=0.4)))
    row = voicetrain.list_sources(cfg)[0]

    assert row["duration_s"] > 0, (
        "a clip inside the vault probed as 0.0 seconds — that zero is now cached on its sidecar, "
        "and prep will trim it to 60 minutes and skip every other clip in the dataset")
    assert 0.3 < row["duration_s"] < 0.5

    # and it is cached, so a second listing spawns no child at all
    assert voicetrain._read_source_meta(cfg.training_dir / "clip.wav")["duration_s"] == row["duration_s"]


@needs_ffmpeg
def test_prep_writes_the_dataset_ENCRYPTED_and_ffmpeg_never_sees_the_store(train_box):
    """FFmpeg cannot read the encrypted source tree directly. Prepare the clip and dataset in scratch, then use `from_scratch` to write encrypted output. The test checks that the stored dataset is readable through the vault and the child process receives only a scratch path."""
    import io
    import os

    import vault_fs

    import voicetrain
    cfg, install = train_box

    voicetrain.save_upload(cfg, "clip.wav", io.BytesIO(_wav_bytes(seconds=0.4)))
    src = cfg.training_dir / "clip.wav"
    out = cfg.dataset_dir('TestVoice') / "000.wav"
    vault_fs.mkdir(cfg.dataset_dir('TestVoice'))
    job = voicetrain.TrainJob(id="j1", name='TestVoice', epochs=1, gpu=0)

    assert voicetrain._prep_one(job, cfg, src, out, None, band_limited=False)

    assert vault_fs.exists(out), "prep produced no dataset WAV at all"
    assert not out.exists(), "the dataset WAV is on the platter in cleartext"
    assert vault_fs.read_bytes(out).startswith(b"RIFF"), "the dataset WAV did not decrypt to audio"
    assert [p.name for p in voicetrain.dataset_wavs(cfg, 'TestVoice')] == ["000.wav"]

    # plaintext must not outlive the stage that needed it (5.0 §8.3)
    left = [p for p in Path(os.environ["VOCALIS_SCRATCH_DIR"]).rglob("*") if p.is_file()]
    assert not left, f"prep left plaintext audio in the scratch: {left}"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=2)


def test_the_dataset_reaches_APPLIO_as_plaintext_in_the_scratch_and_is_then_swept(train_box,
                                                                                 monkeypatch):
    """Applio's `preprocess` takes a DIRECTORY and slices every audio file in it. It is a foreign
    child and cannot import vault, so what it is handed must be plaintext — and must not be
    `_datasets/`.

    🔴 AND IT IS HANDED ONE FOR THE LENGTH OF ONE CPU STAGE, not for the eighteen hours the design
    assumed. Verified against Applio itself rather than reasoned about: `--dataset_path` is a
    parameter of `run_preprocess_script` and of nothing else, and the trainer reads
    `logs/<name>/sliced_audios` instead (Applio `rvc/train/train.py:102`). That is what lets the
    decrypted copy live in a `scratch.directory()` that is rmtree'd on the way out — and it is
    why a Resume, which skips preprocess entirely, never needs the dataset decrypted at all.

    The names carried across are POSITIONAL (`000.wav`), so the plaintext copy leaks nothing even
    when a clip came in from the Playground named after the user's prompt."""
    import vault_fs

    import voicetrain
    cfg, _install = train_box

    vault_fs.mkdir(cfg.dataset_dir('TestVoice'))
    vault_fs.write_bytes(cfg.dataset_dir('TestVoice') / "000.wav", _wav_bytes())
    vault_fs.write_bytes(cfg.dataset_dir('TestVoice') / "001.wav", _wav_bytes())

    seen = {}

    def fake_stage(job, cmd, env=None, cwd=None):
        if "--dataset_path" not in cmd:
            return 0                                     # extract: reads logs/<name>/, not us
        d = Path(cmd[cmd.index("--dataset_path") + 1])
        seen["dir"] = d
        seen["names"] = sorted(p.name for p in d.iterdir())
        seen["bytes"] = (d / "000.wav").read_bytes()     # a PLAIN read — what Applio actually does
        return 0

    def no_train(job, cfg):
        raise _Stop()

    monkeypatch.setattr(voicetrain, "_run_stage", fake_stage)
    monkeypatch.setattr(voicetrain, "launch_train", no_train)

    job = voicetrain.TrainJob(id="j2", name='TestVoice', epochs=1, gpu=0, mode="restart")
    with pytest.raises(_Stop):
        voicetrain._pipeline(job, cfg)

    assert seen["names"] == ["000.wav", "001.wav"], "Applio was not given the dataset"
    assert seen["bytes"] == _wav_bytes(), "Applio was handed CIPHERTEXT — it would train on noise"
    assert seen["dir"] != cfg.dataset_dir('TestVoice'), "Applio was pointed straight at the store"
    assert not seen["dir"].exists(), "the plaintext dataset copy outlived the stage that needed it"


def test_deploy_encrypts_the_checkpoint_and_does_NOT_consume_APPLIOS_copy(train_box):
    """🔴 THE TRAP INSIDE THE OBVIOUS FIX.

    `deploy_model` copies a checkpoint out of Applio's workspace (plaintext, not ours) into
    `voice_models/` (ours, encrypted). That is a plaintext→store boundary, so `vault_fs.from_scratch`
    is precisely the seam it wants — and it is the wrong call, because **from_scratch REMOVES ITS
    SOURCE.** It is built for a temp file that has done its job. Applio's checkpoint is not one:
    it is one of the ~20 candidates the Deploy dropdown will offer again next week, and if it is
    the newest it is half of what Resume needs. The one-liner deploys the voice and DELETES it
    from the training in the same breath — and the row goes on saying "deployed" afterward.

    So the copy goes to the scratch, and from_scratch eats the copy."""
    import vault_fs

    import voiceswap
    import voicetrain
    cfg, install = train_box

    d = cfg.model_dir('TestVoice')
    d.mkdir(parents=True)
    pth = d / 'TestVoice_75e_13800s.pth'
    pth.write_bytes(b"PK\x03\x04" + b"the trained voice, 13-18 GPU hours" * 200)
    (d / 'TestVoice.index').write_bytes(b"the faiss index" * 100)

    info = voicetrain.deploy_model(cfg, 'TestVoice')
    assert info == {"pth": 'TestVoice_75e.pth', "index": 'TestVoice_75e.index',
                    "name": 'TestVoice_75e', "epoch": 75,
                    # main's 4.2-m0h: the index already existed here, so nothing was built
                    "index_built": False}

    # 🔴 APPLIO'S COPY IS STILL THERE. Deploying is not moving.
    assert pth.is_file(), "deploy DELETED Applio's checkpoint — 13-18 GPU-hours, and Resume with it"
    assert (d / 'TestVoice.index').is_file(), "deploy consumed Applio's index"

    # ...and the registry's copy is encrypted, and still reads back as the same voice
    assert vault_fs.read_bytes(cfg.rvc_dir / 'TestVoice_75e.pth') == pth.read_bytes()
    assert not (cfg.rvc_dir / 'TestVoice_75e.pth').exists(), "the .pth is in the registry in cleartext"

    voices = voiceswap.list_voices(cfg.rvc_dir)
    assert [v["name"] for v in voices] == ['TestVoice_75e']
    assert voices[0]["training"] == 'TestVoice' and voices[0]["epoch"] == 75, "the sidecar did not route"
    assert voices[0]["size"] == pth.stat().st_size, "the registry lists the CIPHERTEXT size"

    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=3)


# ── Applio's workspace: the one store the router CANNOT reach ────────────────


def test_a_training_REFUSES_to_launch_onto_an_unencrypted_workspace(train_box):
    """🔴🔴 THE SILENT WRITE THAT NEEDS NO BUG AND NO ATTACKER — IT NEEDS A REBOOT.

    `~/Applio/logs/<name>/` holds ~4.9 GB per training: 2.3 GB of the user's voice sliced into
    WAVs, the 1.3 GB G_/D_ resume pair, ~880 MB of candidate checkpoints. It is OUTSIDE BASE_DIR
    so the router cannot claim it, and APPLIO writes nearly all of it so `vault.py` cannot encrypt
    it in place. It is covered by the encrypted VOLUME it sits on — which is a filesystem fact,
    not an application one.

    And an unmounted volume leaves a BARE MOUNTPOINT: an ordinary empty directory on the ordinary
    disk. Applio writes all 4.9 GB of cleartext into it, and every observable thing about the run
    is perfect — the epochs tick, the chart draws, the checkpoint deploys, the voice works.
    Nothing inside the application can see it.

    So the application does not try to see it. It refuses to start."""
    import voicetrain
    cfg, _install = train_box

    (cfg.logs_dir / voicetrain.WORKSPACE_SENTINEL).unlink()   # the volume did not come back up

    assert not voicetrain.workspace_encrypted(cfg)
    assert voicetrain.workspace_required(cfg), "the vault is open, so this MUST be enforced"
    with pytest.raises(RuntimeError, match="NOT on the encrypted volume"):
        voicetrain.check_workspace(cfg)

    job = voicetrain.TrainJob(id="j3", name='TestVoice', epochs=1, gpu=0)
    voicetrain.run_train_job(job, cfg)

    assert job.status == "failed"
    assert "cleartext" in job.error
    assert not list(cfg.logs_dir.iterdir()), "the refused job wrote into the workspace anyway"


def test_the_workspace_check_is_INERT_without_a_vault(tmp_path, monkeypatch):
    """The same inertness rule as `vault_store.route()`, for the same reason: on a box that has
    not migrated, NOTHING is encrypted — not the clips, not the dataset, not the registry. So
    demanding an encrypted Applio workspace there would protect nothing while blocking everything,
    including every existing user and this entire test suite. The day the vault exists, so does
    the check."""
    import voicetrain
    monkeypatch.setattr(vault_store, "STORE", None)
    cfg = voicetrain.TrainConfig(applio_dir=tmp_path / "Applio",
                                 rvc_dir=tmp_path / "rvc",
                                 training_dir=tmp_path / "training")
    cfg.logs_dir.mkdir(parents=True)

    assert not voicetrain.workspace_encrypted(cfg)    # no sentinel…
    assert not voicetrain.workspace_required(cfg)     # …and none demanded
    voicetrain.check_workspace(cfg)                   # so this does not raise


# ── M8: the web UI's own state (tabs, selections, the Playground prose) ──────────
#
# M8 moves the UI's state out of the browser's localStorage and into the install vault. The prose
# in `vocalis-pg-text` is the user's own words, and moving it off the client is the whole point —
# so the one thing that can prove it landed encrypted is, again, the grep.


def test_ui_state_is_encrypted_and_reads_back(box):
    """🔴 THE GATE FOR M8. Save the UI state through the real module with the vault OPEN, then go
    and look at the bytes: the Playground prose must not be on the platter, and the plaintext path
    must not exist (the filename is SIV-encrypted too). And `sanitize` must drop the device-local
    theme/vol so they never reach the encrypted file in the first place."""
    import ui_state
    store, install, _ = box
    p = install / "ui_state.yaml"

    stored = ui_state.save(p, {
        "vocalis-tab": "playground",
        "vocalis-pg-text": "Sentence number one, and it is the user's own prose.",
        "vocalis-pg-voice": 'TestVoice.wav',
        "vocalis-vt-sel": "[\"a.wav\",\"b.wav\"]",
        "vocalis-theme": "dark",     # device-local — must NEVER be persisted server-side
        "vocalis-vol": "0.5",        # device-local — same
        "not-ours": "x",             # no vocalis- prefix — dropped
    })

    # the write filter kept only the account-local keys
    assert "vocalis-theme" not in stored and "vocalis-vol" not in stored and "not-ours" not in stored
    assert stored["vocalis-tab"] == "playground"

    # The NAME is structural (cleartext) so that .gitignore can name it — the install root is
    # a git repo as well as a vault root. The CONTENTS are what must not be readable, and the
    # prose is checked for explicitly below.
    assert p.is_file(), "the structural name should be right there in the clear"

    # it still reads back, through the vault
    got = ui_state.load(p)
    assert got["vocalis-pg-text"] == "Sentence number one, and it is the user's own prose."
    assert got["vocalis-vt-sel"] == "[\"a.wav\",\"b.wav\"]"

    # 🔴 and NOTHING it wrote is readable — not the prose ("Sentence number"), not the key names
    # ("text:"). Either would trip assert_no_cleartext if a write were unrouted.
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


def test_ui_state_endpoint_round_trips_through_the_vault_and_filters(box, monkeypatch):
    """The HTTP surface, end to end through the cipher: POST saves, GET returns, the device-local
    theme/vol are filtered out, and a missing CSRF token is refused. `send`ing through the real
    endpoint proves the wiring (the injection is tested separately by index() at page render)."""
    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)
    monkeypatch.setattr(rt_paths, "UI_STATE", install / "ui_state.yaml")

    client = vs.app.test_client()
    with client.session_transaction() as sess:
        sess["logged_in"] = True
        sess["csrf"] = "tok"

    # no CSRF header -> refused, and nothing is written
    r = client.post("/ui-state", json={"vocalis-tab": "x"})
    assert r.status_code == 403

    r = client.post("/ui-state", json={
        "vocalis-tab": "playground",
        "vocalis-pg-text": "Sentence number two.",
        "vocalis-theme": "dark",     # filtered
        "vocalis-vol": "0.3",        # filtered
    }, headers={"X-CSRF-Token": "tok"})
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert "vocalis-theme" not in body and "vocalis-vol" not in body

    # GET returns the stored blob…
    got = client.get("/ui-state").get_json()
    assert got["vocalis-pg-text"] == "Sentence number two."
    assert got["vocalis-tab"] == "playground"

    # …and it is encrypted at rest. The NAME is structural (so .gitignore can name it — the
    # install root is a git repo too); `assert_no_cleartext` is what proves the BYTES, and it
    # is the assertion that was always doing the real work here.
    assert (install / "ui_state.yaml").is_file()
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=1)


def test_ui_state_is_INERT_without_a_vault(tmp_path, monkeypatch):
    """The un-migrated box: no vault, so ui_state.yaml is a plain YAML file, bit-for-bit 4.x. The
    same inertness that lets M6/M7/M8 ship before M9's migration without bricking the user's box."""
    import ui_state
    monkeypatch.setattr(vault_store, "STORE", None)
    p = tmp_path / "ui_state.yaml"

    ui_state.save(p, {"vocalis-tab": "book", "vocalis-theme": "dark"})
    assert p.exists(), "with no vault this is a plain file on disk"
    assert ui_state.load(p) == {"vocalis-tab": "book"}     # theme filtered even here


def test_index_injects_the_ui_state_and_escapes_it(box, monkeypatch):
    """🔴 THE LOAD PATH, and its one sharp edge. The page carries the state so the parse-time reads
    have it synchronously — but that state is the USER'S PROSE, and injecting it into a <script>
    naively is a self-XSS: prose containing </script> would close the tag. So `<`/`>`/`&` are
    escaped to \\uXXXX. This pins both: the placeholder is gone, and raw markup does not survive."""
    import ui_state

    import vocalis_server as vs
    store, install, _ = box
    monkeypatch.setattr(vs.vault_store, "STORE", store)
    monkeypatch.setattr(rt_paths, "UI_STATE", install / "ui_state.yaml")
    ui_state.save(install / "ui_state.yaml",
                  {"vocalis-tab": "playground",
                   "vocalis-pg-text": "hello <script>alert(1)</script> & goodbye"})

    client = vs.app.test_client()
    with client.session_transaction() as sess:
        sess["logged_in"] = True
    html = client.get("/").get_data(as_text=True)

    assert "{{UI_STATE}}" not in html, "the placeholder was not substituted"
    assert "window.__UI_STATE__=" in html
    # the prose's markup is escaped, so it cannot break out of the injection <script>
    assert "<script>alert(1)</script>" not in html
    assert "\\u003cscript\\u003ealert(1)\\u003c/script\\u003e" in html


def test_the_stems_zip_reads_through_the_vault_and_not_off_the_platter(box, monkeypatch):
    """The archive route must read each stem through the vault: the encrypted logical filename is absent, while a ciphertext file could otherwise be returned as a successful archive. Verify the archive contains plaintext audio bytes obtained through routed reads."""
    import zipfile

    import stems

    store, install, cache = box
    monkeypatch.setattr(rt_paths, "BASE_DIR", install)
    # BOTH bindings. `OUTPUT_DIR` belongs to book_to_audio and every importer captures its own
    # copy, so patching vocalis_server's reaches only vocalis_server. `ss_cfg()` moved to
    # vocalis.runtime.configs in 5.1-P4.2 and reads ITS copy — leave that one alone and the zip
    # route resolves the library under the developer's real output/ tree and 404s. This is the
    # `from X import name` hazard in §6.2, and the reason paths.py deliberately does NOT
    # re-export OUTPUT_DIR: a third name would make it three places to remember, not one.
    monkeypatch.setattr(vs, "OUTPUT_DIR", install / "output")
    monkeypatch.setattr(rt_configs, "OUTPUT_DIR", install / "output")
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))
    vs.app.secret_key = "test-key-not-derived-from-anything"
    vs.app.config["TESTING"] = True

    ref = stems.set_ref("Routing Test Song", "29d93dd9")
    d = install / "output" / "stems" / ref
    vault_fs.mkdir(d)
    payloads = {"vocals.wav": b"RIFF" + b"v" * 500,
                "instrumental.wav": b"RIFF" + b"i" * 700}
    for name, data in payloads.items():
        vault_fs.write_bytes(d / name, data)
    stems.write_meta(d, {"h": "29d93dd9" * 4, "song": "Routing Test Song", "mode": "2stem"})

    # The premise. If this ever starts passing, the store stopped encrypting names and this
    # test is measuring nothing.
    assert not (d / "vocals.wav").exists(), "the logical name is on disk — is the vault on?"

    with vs.app.test_client() as c:
        r = c.get(f"/stems/library/{ref}/zip")
    assert r.status_code == 200, f"the zip route failed with {r.status_code}"

    z = zipfile.ZipFile(io.BytesIO(r.data))
    assert sorted(i.filename for i in z.infolist()) == [f"{ref}/instrumental.wav",
                                                        f"{ref}/vocals.wav"]
    for name, data in payloads.items():
        # PLAINTEXT out. A zip full of `VLT1` blobs would also be a 200.
        assert z.read(f"{ref}/{name}") == data


def test_denoise_only_cleanup_hands_the_child_a_path_that_EXISTS(box, tmp_path, monkeypatch):
    """Trim and denoise-only cleanup use different input paths. Trim prepares a child-readable scratch input; denoise-only must do the same before `_decode_wav` invokes FFmpeg. Assert the child receives an existing scratch path, since a plaintext store would not expose this boundary."""
    import cleanup

    store, install, cache = box
    scratch = tmp_path / "cleanup-scratch"
    scratch.mkdir()

    src = install / "voice_training" / "clip.wav"
    vault_fs.mkdir(src.parent)
    vault_fs.write_bytes(src, b"RIFF" + b"\0" * 400)
    assert not src.exists(), "the logical name is on disk — is the vault on?"

    seen = {}

    def fake_decode(s, dst):
        seen["path"] = Path(s)
        seen["existed"] = Path(s).exists()
        Path(dst).write_bytes(b"RIFF" + b"\0" * 400)

    def fake_denoise(cfg, src_, dst, wet=1.0, atten=0.0, device="cpu", cancel=None, on_line=None):
        Path(dst).write_bytes(b"RIFF" + b"\0" * 400)
        return 0

    monkeypatch.setattr(cleanup, "_decode_wav", fake_decode)
    monkeypatch.setattr(cleanup, "run_denoise", fake_denoise)

    cfg = cleanup.CleanupConfig(denoise_python=tmp_path / "dfn" / "python",
                                denoise_script=tmp_path / "dfn" / "denoise.py",
                                trim_script=tmp_path / "trim.py",
                                scratch=scratch)
    cleanup.run_cleanup(cfg, src, {"trim": {"enabled": False},
                                   "denoise": {"enabled": True, "wet": 1.0, "atten": 0.0}},
                        install / "voice_training", "clip")

    assert seen.get("existed"), (
        f"the child was handed {seen.get('path')}, which is not on disk — the decode is unrouted")


def test_the_playground_clips_zip_streams_through_the_vault(box, monkeypatch):
    """The clip archive must read through the vault and stream after Flask has torn down the request context. The generator must retain a valid vault reader across yields; a buffered response test would not cover that lifetime contract."""
    import zipfile

    import playground_clips

    store, install, cache = box
    monkeypatch.setattr(rt_paths, "BASE_DIR", install)
    monkeypatch.setattr(vs, "OUTPUT_DIR", install / "output")
    monkeypatch.setattr(web_playground, "OUTPUT_DIR", install / "output")
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))
    vs.app.secret_key = "test-key-not-derived-from-anything"
    vs.app.config["TESTING"] = True

    root = install / "output" / "playground"
    h = playground_clips.clip_hash('TestVoice', 0.5, 0.5, 0.8, "Sentence number one.")
    stem = playground_clips.clip_stem("Sentence number one.", h)
    mp3 = root / 'TestVoice' / (stem + ".mp3")
    vault_fs.mkdir(mp3.parent)
    payload = b"ID3" + b"\x00" * 64 + b"audio bytes that are not ciphertext"
    vault_fs.write_bytes(mp3, payload)
    playground_clips.write_clip_yaml(mp3.with_suffix(".yaml"), {
        "voice": 'TestVoice', "text": "Sentence number one.", "created": "2026-07-31T00:00:00"})

    # The premise, as in the stems test: if the logical name is readable the vault is off and
    # this test is measuring nothing.
    assert not mp3.exists(), "the logical name is on disk — is the vault on?"

    with vs.app.test_client() as c:
        r = c.post("/playground/clips/zip", data={"clips": [f"TestVoice/{stem}"]})
    assert r.status_code == 200, f"the zip route failed with {r.status_code}"

    z = zipfile.ZipFile(io.BytesIO(r.data))
    assert [i.filename for i in z.infolist()] == [f"{stem}.mp3"]
    assert z.read(f"{stem}.mp3") == payload      # PLAINTEXT out — a zip of VLT1 blobs is a 200 too


# ───────────────────────────────────────────────────── 7.0 — the wbedit document store

def test_the_wbedit_document_store_leaves_no_cleartext_in_the_vault(box):
    """🔴 THE GATE FOR 7.0's STORE, and the only instrument that can see a missed write here.

    Every other test of this store passes over a tree that is 100% cleartext: the store reads
    back what it wrote, the revisions round-trip, the review queue works. A site nobody routed
    does not raise — it writes plaintext under its logical name, `listdir` steps over it, and
    nothing anywhere ever says so. 5.0's own record is that this happened twice (voice_models/,
    voice_training/), both times to a store that arrived under an existing root.

    The blast radius here is the worst in the product. A Revision is a whole imported lorebook or
    character card — the user's own prose — and a Proposal holds two copies of a field.
    """
    from wbedit.store import DocumentStore, InstructionLibrary, PassStore
    from wbedit.store.models import Proposal

    store, install, cache = box
    root = install / "wbedit"
    docs, passes, library = DocumentStore(root), PassStore(root), InstructionLibrary(root)

    # A sentinel that could only have come out of THIS document. §10's containment test uses the
    # same trick; here it is aimed at the platter rather than at the logs.
    SENTINEL = "Vermilion Antiquary of Thistlewade"
    book = {"entries": {"0": {"uid": 0, "key": ["antiquary"], "comment": "The Antiquary",
                              "content": f"{SENTINEL} keeps a shop nobody can find twice."}}}

    doc = docs.create(book, name=SENTINEL, kind="worldbook")
    ins = library.add(name="Rename", text=f"Rename {SENTINEL} to something else.")
    p = passes.start(doc.id, revision=0, instruction=ins.text, model="m", sampler={},
                     selection=[["entries", "0", "content"]], total=1)
    passes.record(doc.id, p.id, Proposal(
        index=1, locator=("entries", "0", "content"), label="The Antiquary", status="CHANGED",
        original=f"{SENTINEL} keeps a shop nobody can find twice.",
        revised="The Gilded Antiquary keeps a shop nobody can find twice.", review="approved"))
    passes.finish(doc.id, p.id, tally={"CHANGED": 1})
    rev = docs.materialize(doc.id, 0, passes.proposals(doc.id, p.id), pass_id=p.id)

    # The premise. If the logical path is readable the vault is off and this test measures
    # nothing — the same guard the stems and clips tests carry.
    assert not (root / "documents" / doc.id / "meta.json").exists(), \
        "the logical name is on disk — is the vault on?"

    # It still WORKS through the seam: the store is not merely silent, it is correct.
    assert rev is not None and rev.n == 1
    assert docs.revision(doc.id, 0).content == book, "revision 0 is not the import (I8)"
    assert SENTINEL not in json.dumps(docs.revision(doc.id, 1).content)
    assert docs.get(doc.id).name == SENTINEL
    assert [i.name for i in library.list()] == ["Rename"]

    # ...and now go and LOOK at the bytes.
    assert_no_cleartext(install, allow={"vault_keys.yaml", vault.SENTINEL_NAME}, expect_files=5)

    probe = SENTINEL.encode("utf-8")
    leaked = [str(f.relative_to(install)) for f in sorted(install.rglob("*"))
              if f.is_file() and probe in f.read_bytes()]
    assert not leaked, (
        "THE DOCUMENT'S OWN TEXT IS ON THE PLATTER IN CLEARTEXT — a write in wbedit/store is "
        f"not routed through vault_fs:\n  " + "\n  ".join(leaked))


def test_the_template_store_is_ROUTED_so_it_is_encrypted(box, monkeypatch):
    """The file holds a description and a sample text per entry — the user's own prose, the same
    content class as a wbedit instruction. An unrouted write here is the silent-cleartext failure
    the M6 census exists to prevent."""
    import vault_store as vs_mod
    _store, install, _cache = box
    monkeypatch.setattr(rt_paths, "VOICE_TEMPLATES", install / "voice_templates.json")
    assert vs_mod.route(rt_paths.VOICE_TEMPLATES) is not None, (
        "the router does not claim voice_templates.json — add it to ROUTES['install']['files']")
    rt_voice_templates.add(name="Secret", prompt="a warm voice", sample_text="hello there")
    # 🔴 THE NAME IS READABLE AND THE CONTENTS ARE NOT, and asserting the first as if it were the
    # second is the misreading vault.py warns about in capitals. `voice_templates.json` is in
    # `vault.STRUCTURAL` **so that a .gitignore line can match it** — the install root is a git
    # repo, and an encrypted name there is an unmatchable blob. What must never be on the platter
    # is the PROSE.
    assert rt_paths.VOICE_TEMPLATES.is_file(), (
        "the template library got a ciphertext name — no .gitignore pattern can match one, and "
        "the install root is a git repo")
    raw = rt_paths.VOICE_TEMPLATES.read_bytes()
    assert b"a warm voice" not in raw and b"hello there" not in raw and b"Secret" not in raw, (
        "the template library's CONTENTS are in cleartext on disk — the write bypassed the vault")
    assert rt_voice_templates.list_templates()[0].prompt == "a warm voice"


def test_the_SONG_template_store_is_ROUTED_so_the_lyrics_are_encrypted(box, monkeypatch):
    """8.0-m3 §4.5.2. The same check as its neighbor above, for the store that holds LYRICS.

    🔴 GREPPING THE BYTES IS THE ONLY THING THAT PROVES THIS. A store added to the paths module
    and to neither routing list still works perfectly — it saves, it lists, every route spec is
    green — and it writes the user's words to the platter in the clear inside an install whose whole
    purpose is that they are not. `vault.py`'s own comment names the mechanism: "a human keeps
    having to remember two lists at once."
    """
    import vault_store as vs_mod
    from vocalis.runtime import acetemplates as rt_acetemplates
    _store, install, _cache = box
    monkeypatch.setattr(rt_paths, "ACE_TEMPLATES", install / "ace_templates.json")
    assert vs_mod.route(rt_paths.ACE_TEMPLATES) is not None, (
        "the router does not claim ace_templates.json — add it to ROUTES['install']['files']")
    rt_acetemplates.save({"name": 'Sample Track One',
                          "caption": "sample genre, hard rock, 85 bpm",
                          "lyrics": "[verse]\nsample verse line one"})
    # Same reading as above: the NAME is readable on purpose, so a .gitignore line can match it
    # in an install root that is a git repo. What must never be on the platter is the PROSE.
    assert rt_paths.ACE_TEMPLATES.is_file(), (
        "the song library got a ciphertext name — no .gitignore pattern can match one, and the "
        "install root is a git repo")
    raw = rt_paths.ACE_TEMPLATES.read_bytes()
    for secret in (b"Sample Track One", b"sample genre", b"sample verse line one"):
        assert secret not in raw, (
            f"{secret!r} is in cleartext on disk — the song store's write bypassed the vault")
    assert rt_acetemplates.list_templates()[0].lyrics.endswith("sample verse line one")


def test_the_SONG_LIBRARY_is_ROUTED_so_the_audio_is_encrypted(box, monkeypatch):
    """8.0-m3f §4.5.3. The index AND the FLAC, because they leak different things.

    🔴 THE AUDIO IS THE POINT HERE. A template is prose; a library entry is the finished song —
    the thing the whole tab exists to make. An unrouted tree would put the user's music on the platter
    in the clear inside an install whose purpose is that it is not, and it would look perfect: the
    library lists, the songs play, every route spec is green.
    """
    import vault_store as vs_mod
    from vocalis.runtime import acelib as rt_acelib
    _store, install, _cache = box
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY", install / "ace_library.json")
    monkeypatch.setattr(rt_paths, "ACE_LIBRARY_AUDIO", install / "ace_library")
    assert vs_mod.route(rt_paths.ACE_LIBRARY) is not None, "the index is not routed"
    assert vs_mod.route(rt_paths.ACE_LIBRARY_AUDIO) is not None, "the audio tree is not routed"

    # A recognizable "song": not real FLAC, but the bytes are what the assertion is about.
    tune = b"RIFFsecret-melody-bytes-that-must-not-be-on-the-platter"
    song = rt_acelib.save(tune, name='Sample Track One', caption="sample genre",
                          lyrics="[verse]\nsample verse line one", model="acestep-v15-turbo")

    # The NAMES stay readable so .gitignore can match them; the CONTENTS must not be.
    assert rt_paths.ACE_LIBRARY.is_file() and rt_paths.ACE_LIBRARY_AUDIO.is_dir(), (
        "the library got a ciphertext name — no .gitignore pattern can match one, and the "
        "install root is a git repo")
    raw_index = rt_paths.ACE_LIBRARY.read_bytes()
    for secret in (b"Sample Track One", b"sample genre", b"sample verse line one"):
        assert secret not in raw_index, f"{secret!r} is in cleartext in the library index"

    # 🔴 AND THE AUDIO ITSELF. Every file under the tree, not just the one we think we wrote —
    # the filename is encrypted, so naming it would be assuming the layout this is checking.
    on_disk = [f for f in rt_paths.ACE_LIBRARY_AUDIO.rglob("*") if f.is_file()]
    assert on_disk, "the song was indexed but no audio reached the disk at all"
    for f in on_disk:
        assert tune not in f.read_bytes(), (
            f"the SONG'S OWN BYTES are in cleartext at {f.name} — acelib.save bypassed the vault")

    assert rt_acelib.list_songs()[0].name == 'Sample Track One'


def test_completed_audiobook_inventory_and_delete_use_encrypted_vault_logical_sizes(
        box, monkeypatch):
    """Full-export inventory reports plaintext sizes and DELETE removes only one vaulted file."""
    store, install, _cache = box
    monkeypatch.setattr(rt_paths, "BASE_DIR", install)
    monkeypatch.setattr(web_books, "OUTPUT_DIR", install / "output")
    out_dir = install / "output" / "books" / "Vault Book"
    vault_fs.mkdir(out_dir)
    payloads = {
        "00_Chapter.opus": b"chapter audio",
        "Vault Book_full.opus": b"opus bytes",
        "Vault Book_full.mp3": b"mp3 has a different plaintext length",
        "Vault Book_full.m4a": b"AAC bytes here",
    }
    for name, payload in payloads.items():
        vault_fs.write_bytes(out_dir / name, payload)

    assert not (out_dir / "Vault Book_full.mp3").exists(), "full export name remained plaintext"
    output = book_state.scan_book(out_dir)
    assert output["full_audiobooks"] == [
        {"file": "Vault Book_full.opus", "size": len(payloads["Vault Book_full.opus"])},
        {"file": "Vault Book_full.mp3", "size": len(payloads["Vault Book_full.mp3"])},
        {"file": "Vault Book_full.m4a", "size": len(payloads["Vault Book_full.m4a"])},
    ]
    assert output["full_size"] == len(payloads["Vault Book_full.opus"])

    physical_mp3 = store._vaults[0]._map("output/books/Vault Book/Vault Book_full.mp3")
    with vs.app.test_client() as client:
        response = client.delete(
            "/output/Vault%20Book/audiobook/Vault%20Book_full.mp3")
    assert response.status_code == 200, response.get_data(as_text=True)
    assert not physical_mp3.exists()
    assert vault_fs.read_bytes(out_dir / "00_Chapter.opus") == payloads["00_Chapter.opus"]
    assert vault_fs.read_bytes(out_dir / "Vault Book_full.opus") == payloads["Vault Book_full.opus"]
    assert vault_fs.read_bytes(out_dir / "Vault Book_full.m4a") == payloads["Vault Book_full.m4a"]
    assert [item["file"] for item in book_state.scan_book(out_dir)["full_audiobooks"]] == [
        "Vault Book_full.opus", "Vault Book_full.m4a"]
