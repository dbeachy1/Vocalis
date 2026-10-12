"""THE REGRESSION GUARDS FOR 5.0-M4 — the tests that must survive M5, M6 and M7 UNTOUCHED.

**M4 caches the song hash. It does not redefine it.** These pin the difference.

`stems.song_hash()` is md5-of-content, and `voiceswap.swap_hash()` eats its output as the first
component of every swap's identity — which is the filename of every swap entry.
Move the hash by one bit and the library silently re-renders: every stem set fails `find_by_hash`,
and Demucs re-runs across the lot.

**Every formula below is RECOMPUTED BY HAND here — never read back from the code** — so these tests
cannot agree with a mistake. Same construction, same reason, as M2.5b's
`test_the_seam_did_not_move_the_cache_key` (test_enhance.py).

If one of these goes red, the question is never "how do I update the test?".
"""
import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import stems  # noqa: E402
import voiceswap  # noqa: E402
import voicetrain  # noqa: E402
import vocalis_server as vs  # noqa: E402
import vocalis.runtime.configs as rt_configs


@pytest.fixture
def cfg(tmp_path):
    """Duck-typed, like test_stems.py's — the store never asks for more than it needs."""
    class C:
        stems_dir = tmp_path / "output" / "stems"
        stem_uploads_dir = tmp_path / "uploads" / "stems"
        acestep_dir = tmp_path / "acestep"
        songs_dir = tmp_path / "uploads" / "songs"
        song_index = tmp_path / "cache" / "song_ids.yaml"
    for d in (C.stems_dir, C.stem_uploads_dir, C.acestep_dir, C.songs_dir):
        Path(d).mkdir(parents=True, exist_ok=True)
    return C


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


# ── the hashes themselves ────────────────────────────────────────────────────

def test_the_song_hash_did_not_move(tmp_path):
    """md5 of the file's CONTENT, spelled out. Nothing else — not the name, not the size,
    not a prefix, not a salt."""
    raw = b"ID3\x04\x00" + bytes(range(256)) * 40
    song = tmp_path / "Buttons.mp3"
    song.write_bytes(raw)

    assert stems.song_hash(song) == hashlib.md5(raw).hexdigest()
    assert len(stems.song_hash(song)) == 32          # the FULL hash, not the h8 suffix


def test_the_upload_hash_did_not_move(tmp_path):
    """A stem set you brought is identified by its stems' content, name-then-bytes, sorted
    by stem name. It feeds `h` in the sidecar, which feeds stems_id → swap_hash."""
    v, i = tmp_path / "vocals.wav", tmp_path / "instrumental.wav"
    v.write_bytes(b"RIFFvocals")
    i.write_bytes(b"RIFFinstrumental")

    h = hashlib.md5()
    for name, raw in sorted([("vocals.wav", b"RIFFvocals"),
                             ("instrumental.wav", b"RIFFinstrumental")]):
        h.update(name.encode("utf-8"))
        h.update(raw)

    assert stems.upload_hash([("vocals.wav", v), ("instrumental.wav", i)]) == h.hexdigest()


def test_the_swap_hash_did_not_move(tmp_path):
    """The swap's identity: the stems it converts, the voice model (stem + size + mtime, so a
    retrained .pth under the same name re-renders), the INDEX, and the knobs. Device is
    deliberately NOT in it. %.6g keeps float spelling stable. sha256 → first 12 hex.

    ⚠ THIS PIN MOVED ONCE, ON PURPOSE, AND IT WAS NOT ENCRYPTION THAT MOVED IT. `main`'s 4.2-m0h
    added the `.index` to the key, and the re-render that causes is the POINT: RVC blends each
    frame toward its neighbors in the faiss index and `index_rate` is the blend amount, so a
    swap rendered WITHOUT an index is a different sound from the same swap rendered WITH one. The
    index was not in the key, so when two index-less voices gained their indexes,
    every cached identity kept its old hash and went on serving the pre-index audio — the caller
    could not distinguish the pre-index audio from the indexed version.
    The old identity was wrong. One re-render is necessary to reflect the new audio.

    🔴 What this file exists to guarantee is narrower and is UNTOUCHED: **M4, M5, M6 and M7 do not
    move this hash.** The formula below is still recomputed BY HAND from a RAW `.stat()`, while
    `swap_hash` reaches it through the `source_stat` SEAM — so if the seam ever started answering
    something other than the plaintext (size, mtime), this goes red. That the vault specifically
    does not move it is proved end-to-end, over a real encrypted store, by
    test_m6_e2e::test_a_voice_model_in_the_vault_keeps_its_swap_identity.

    If this goes red again, the question is still not "how do I update the test?" — it is "what
    did I just change about what a swap SOUNDS like, and am I willing to re-render the library?"
    """
    pth = tmp_path / "TestVoice.pth"
    pth.write_bytes(b"weights" * 100)
    st = pth.stat()

    source_id = "0123456789abcdef0123456789abcdef"        # a song's md5

    # (1) a voice with NO index — a real, distinct configuration, and it must hash differently
    #     from having one (that is the whole bug 4.2-m0h fixed)
    key = (f"{source_id}|TestVoice|{st.st_size}|{int(st.st_mtime)}|"
           f"3|0.5|1|1|rmvpe|rms0.25|idxnoindex")
    expected = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    assert voiceswap.swap_hash(source_id, pth, 3, 0.5, 1.0, 1.0, 0.25) == expected

    # (2) the same voice WITH one. A different sound ⇒ a different identity.
    idx = tmp_path / "TestVoice.index"
    idx.write_bytes(b"faiss" * 100)
    ist = idx.stat()
    key_i = (f"{source_id}|TestVoice|{st.st_size}|{int(st.st_mtime)}|"
             f"3|0.5|1|1|rmvpe|rms0.25|idx{ist.st_size}:{int(ist.st_mtime)}")
    expected_i = hashlib.sha256(key_i.encode("utf-8")).hexdigest()[:12]
    assert voiceswap.swap_hash(source_id, pth, 3, 0.5, 1.0, 1.0, 0.25) == expected_i
    assert expected_i != expected, "an indexed voice hashes the same as an index-less one"

    assert voiceswap.RMS_MIX_DEFAULT == 0.25
    assert voiceswap.F0_METHOD == "rmvpe"


# ── the memo returns exactly what the hash would ─────────────────────────────

def test_song_id_is_the_song_hash(cfg, tmp_path):
    """THE WHOLE MILESTONE IN ONE ASSERTION. The front door must answer with the hash — on a
    MISS (it computes it) and on a HIT (it remembers it). If these two ever disagree, the
    library has forked."""
    raw = b"ID3" + b"\xde\xad\xbe\xef" * 500
    song = Path(cfg.songs_dir) / "Buttons_deadbeef.mp3"
    song.write_bytes(raw)
    expected = hashlib.md5(raw).hexdigest()

    assert stems.song_id(cfg, song) == expected          # miss — computed
    assert stems.song_id(cfg, song) == expected          # hit  — remembered
    assert stems.song_hash(song) == expected             # and the definition is untouched


def test_song_id_never_serves_a_stale_hash(cfg, tmp_path):
    """A memo that outlives its file is worse than no memo. Rewrite the song and the index
    must NOT hand back the old identity — content, never filename (R4). A regenerated
    ACE-Step file under the same name is a DIFFERENT SONG and gets its own stem set."""
    song = Path(cfg.acestep_dir) / "take.mp3"
    song.write_bytes(b"first take")
    first = stems.song_id(cfg, song)
    assert first == hashlib.md5(b"first take").hexdigest()

    import os
    song.write_bytes(b"second take, quite different")
    os.utime(song, (1, 1))                     # a new mtime, as a real rewrite has

    second = stems.song_id(cfg, song)
    assert second == hashlib.md5(b"second take, quite different").hexdigest()
    assert second != first


def test_song_id_survives_a_wiped_cache(cfg):
    """cache_root() is documented AND CODED as regenerable. Deleting the index must cost one
    re-hash and nothing else — never a changed identity."""
    song = Path(cfg.songs_dir) / "a.mp3"
    song.write_bytes(b"content")
    h = stems.song_id(cfg, song)

    Path(cfg.song_index).unlink()
    assert stems.song_id(cfg, song) == h


def test_a_corrupt_index_costs_a_re_hash_and_destroys_nothing(cfg):
    """M2.5's rule, applied to the new store: never destroy on a failed read. A junk index
    still answers correctly (by re-hashing), and record() must NOT overwrite what it could
    not read — the same contract both rate stores were given."""
    song = Path(cfg.songs_dir) / "a.mp3"
    song.write_bytes(b"content")
    expected = hashlib.md5(b"content").hexdigest()

    Path(cfg.song_index).parent.mkdir(parents=True, exist_ok=True)
    Path(cfg.song_index).write_text("{{{ not yaml", encoding="utf-8")

    assert stems.song_id(cfg, song) == expected                     # degrades to a re-hash
    assert Path(cfg.song_index).read_text(encoding="utf-8") == "{{{ not yaml"   # not clobbered


def test_a_config_with_no_index_still_answers_correctly(tmp_path):
    """A missing memo is SLOW, never WRONG. Nothing may fail a swap, a split or a probe
    because a CACHE was unavailable — so a config that carries no index just re-hashes,
    exactly as the code did before M4."""
    class NoIndex:
        song_index = None
    song = tmp_path / "a.mp3"
    song.write_bytes(b"content")
    assert stems.song_id(NoIndex, song) == hashlib.md5(b"content").hexdigest()


def test_resolve_config_actually_sets_the_index(tmp_path):
    """...and because a forgotten index is silent (it degrades to re-hashing), the REAL
    config is pinned: the memo cannot go missing in production without this going red."""
    c = voiceswap.resolve_config({}, tmp_path, tmp_path / "output", tmp_path / "cache")
    assert c.song_index == tmp_path / "cache" / "song_ids.yaml"


# ── THE SHIP GATE: the whole point of the milestone ──────────────────────────

def test_opening_the_voice_training_tab_spawns_zero_ffprobes(tmp_path, monkeypatch):
    """The other half of the gate. _source_row shelled out to ffprobe ONCE PER CLIP, uncached,
    on every entry to the tab — 24 ms each, 0.73 s for thirty clips. Under encryption each of
    those subprocesses first needs the clip decrypted to scratch: decrypt, write, spawn, delete,
    per clip, per tab entry.

    The duration is already written into the sidecar we are already reading. Once it is warm,
    listing the tab must spawn NOTHING."""
    class C:
        training_dir = tmp_path / "clips"
    C.training_dir.mkdir(parents=True)
    for i in range(5):
        (C.training_dir / f"clip{i}.mp3").write_bytes(b"ID3" + bytes([i]) * 100)

    probes = []
    monkeypatch.setattr(voiceswap, "ffprobe_duration",
                        lambda p: probes.append(Path(p)) or 12.5)
    # bandwidth is the OTHER cached probe on this row; it is M2.5b's and already warm-caches.
    monkeypatch.setattr(voicetrain.enhance_mod, "measure_bandwidth", lambda p: 22050)

    first = voicetrain.list_sources(C)
    assert len(probes) == 5                          # cold: one probe per clip, once
    assert all(r["duration_s"] == 12.5 for r in first)

    probes.clear()
    again = voicetrain.list_sources(C)
    assert probes == [], f"the tab re-probed {len(probes)} clips — the sidecar cache is not read"
    assert [r["duration_s"] for r in again] == [12.5] * 5      # and the answer is unchanged


def test_a_replaced_clip_is_re_probed(tmp_path, monkeypatch):
    """The duration cache is keyed on the identity seam, so replacing a clip under the same
    name must re-probe it. A cache that outlives its file is worse than no cache."""
    import os

    class C:
        training_dir = tmp_path / "clips"
    C.training_dir.mkdir(parents=True)
    clip = C.training_dir / "a.mp3"
    clip.write_bytes(b"ID3short")

    monkeypatch.setattr(voicetrain.enhance_mod, "measure_bandwidth", lambda p: 22050)
    monkeypatch.setattr(voiceswap, "ffprobe_duration", lambda p: 10.0)
    assert voicetrain.list_sources(C)[0]["duration_s"] == 10.0

    clip.write_bytes(b"ID3a-much-longer-clip-entirely")
    os.utime(clip, (1, 1))
    monkeypatch.setattr(voiceswap, "ffprobe_duration", lambda p: 99.0)
    assert voicetrain.list_sources(C)[0]["duration_s"] == 99.0


def test_an_uploaded_song_is_hashed_exactly_once_ever(cfg, monkeypatch):
    """save_upload already computed the full hash and kept 8 of the 32 hex in the filename.
    It now remembers the other 24, so nothing ever re-reads the file to recover them."""
    import io

    raw = b"ID3" + b"\xab\xcd" * 5000
    row = voiceswap.save_upload(cfg, "My Song.mp3", io.BytesIO(raw))
    dest = Path(cfg.songs_dir) / Path(row["ref"]).name

    reads = []
    real = stems._md5_file
    monkeypatch.setattr(stems, "_md5_file", lambda p, h=None: reads.append(Path(p)) or real(p, h))

    assert stems.song_id(cfg, dest) == hashlib.md5(raw).hexdigest()
    assert reads == [], "the song was re-hashed after ingest — the 24 hex were thrown away again"
