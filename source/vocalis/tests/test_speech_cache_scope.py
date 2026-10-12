"""Tests that speech cache files and their count limits are scoped independently for each speaker."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from nomi_speak import NomiSpeaker                          # noqa: E402


def _speaker(tmp_path, cap=2):
    (tmp_path / "voice_samples").mkdir(exist_ok=True)
    settings = tmp_path / "voice_settings.yaml"
    settings.write_text("nomi:\n  default_voice: v.wav\n", encoding="utf-8")
    return NomiSpeaker(settings, tmp_path / "voice_samples", tmp_path / "cache",
                       max_cached_files=cap)


def _put(sp, key, owner, age=0.0):
    """Write one cache entry, `age` seconds old — eviction sorts on mtime, so the test has to
    control it rather than hope the filesystem's clock resolution separates two writes."""
    p = sp.cache_path(key, owner)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\xff\xfb\x00" * 16)
    if age:
        os.utime(p, (p.stat().st_atime, p.stat().st_mtime - age))
    return p


def _live(sp, owner, keys):
    return [k for k in keys if sp.cache_path(k, owner).exists()]


# ── the cap is per speaker ───────────────────────────────────────────────────

def test_each_speaker_gets_its_own_budget(tmp_path):
    """Two characters, a cap of 2, three entries each: both keep 2. Under the old global cap
    the same six files would have left 2 in TOTAL."""
    sp = _speaker(tmp_path, cap=2)
    for owner in ('st:Test User 1', 'st:Test User 2'):
        for i, k in enumerate(("aa11", "bb22", "cc33")):
            _put(sp, k, owner, age=(3 - i) * 10)
        sp.evict(owner)
    for owner in ('st:Test User 1', 'st:Test User 2'):
        assert _live(sp, owner, ("aa11", "bb22", "cc33")) == ["bb22", "cc33"], (
            f"{owner} did not keep its own newest two")


def test_a_busy_speaker_cannot_evict_another(tmp_path):
    """🔴 The harm the scoping exists to stop. One long conversation used to walk the whole
    store and delete whatever was oldest — which is every other character's audio, silently,
    with no setting that could protect them short of raising the cap for everybody."""
    sp = _speaker(tmp_path, cap=2)
    quiet = [_put(sp, k, 'st:Test User 2', age=999) for k in ("q1", "q2")]   # old, and someone else's
    for i, k in enumerate(("h1", "h2", "h3", "h4", "h5")):
        _put(sp, k, 'st:Test User 1', age=(5 - i))
    sp.evict('st:Test User 1')

    assert all(p.exists() for p in quiet), (
        "a busy speaker evicted a quiet one's audio — the cap is still global")
    assert _live(sp, 'st:Test User 1', ("h1", "h2", "h3", "h4", "h5")) == ["h4", "h5"]


def test_a_nomi_and_a_character_of_the_same_name_are_different_speakers(tmp_path):
    """Nomi and character IDs use separate namespaces, even when their subject IDs match."""
    sp = _speaker(tmp_path, cap=1)
    _put(sp, "k1", "nomi:subject-1", age=99)
    _put(sp, "k1", "st:subject-1")
    sp.evict("st:subject-1")
    assert sp.cache_path("k1", "nomi:subject-1").exists(), "the Nomi's entry was evicted by the character's"
    assert sp.cache_path("k1", "st:subject-1").exists()


def test_the_same_line_for_two_characters_is_cached_twice(tmp_path):
    """Identical text from different speakers uses separate cache paths and retains per-speaker caps."""
    sp = _speaker(tmp_path, cap=10)
    a = _put(sp, "same", 'st:Test User 1')
    b = _put(sp, "same", 'st:Test User 2')
    assert a != b and a.exists() and b.exists()


def test_the_directory_name_says_nothing_about_the_speaker(tmp_path):
    """The owner directory is opaque so it does not reveal the speaker identity."""
    sp = _speaker(tmp_path)
    d = sp.owner_dir('st:Test User 1')
    assert 'test user 1' not in d.lower() and "st" != d[:2].lower()
    assert len(d) == 16 and all(c in "0123456789abcdef" for c in d)
    assert d != sp.owner_dir('st:Test User 2')


# ── the entries written before the scoping ───────────────────────────────────

def test_the_old_flat_entries_are_deleted_because_nothing_can_reach_them(tmp_path):
    """🔴 They sit at `<root>/<shard>/<key>.mp3`, and every lookup now goes through
    `cache_path(key, owner)`, which cannot produce that path. Capping them would leave up to
    `max_cached` files of pure dead weight that no per-speaker sweep ever visits."""
    sp = _speaker(tmp_path, cap=2)
    legacy = []
    for k in ("old1", "old2", "old3"):
        p = sp.cache_path(k)                       # Omitting owner selects the legacy flat layout.
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\xff\xfb\x00" * 16)
        legacy.append(p)

    _put(sp, "new1", 'st:Test User 1')
    sp.evict('st:Test User 1')                       # the first SCOPED evict does the sweep

    assert not any(p.exists() for p in legacy), "unreachable entries survived the sweep"
    assert sp.cache_path("new1", 'st:Test User 1').exists(), "the sweep took a live entry with it"


def test_the_sweep_runs_once_not_on_every_write(tmp_path):
    """It walks the whole cache root, and on an encrypted box every listdir is a decrypt. Once
    per process is enough — nothing creates flat entries any more."""
    sp = _speaker(tmp_path, cap=5)
    calls = []
    real = sp.evict_legacy
    sp.evict_legacy = lambda: (calls.append(1), real())[1]
    for i in range(4):
        _put(sp, f"k{i}", 'st:Test User 1')
        sp.evict('st:Test User 1')
    assert len(calls) == 1, f"the legacy sweep ran {len(calls)} times"


def test_an_unscoped_evict_does_not_sweep_its_own_caller(tmp_path):
    """🔴 Found by running it: `evict(None)` IS working the flat layout, so sweeping there
    deletes the entry the caller just wrote. The sweep would be eating its own caller, and the
    only proof that flat entries are unreachable is that a SCOPED call was made."""
    sp = _speaker(tmp_path, cap=5)
    p = sp.cache_path("solo")                      # legacy layout, and legitimately in use
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\xff\xfb\x00" * 16)
    sp.evict()                                     # unscoped: must not sweep
    assert p.exists(), "an unscoped evict deleted the entry it was called to manage"


# ── the routes, not just the function ────────────────────────────────────────

def test_the_st_route_files_each_character_under_its_own_speaker(tmp_path, monkeypatch):
    """🔴 Every test above stops at `NomiSpeaker`. This one drives the real
    `/v1/audio/prerender` route for two characters and asserts the files land in DIFFERENT
    sub-trees — because a route that forgot to pass `owner` would still return 200, still
    cache, and quietly put everything back in one flat bucket under one shared cap.

    That is the shape design §15d says three 5.3.1 defects had: the function answered
    correctly and nothing used the answer.
    """
    from test_prerender import BODY, _mk_app, _wait

    client, nomi, q, flags, _ = _mk_app(tmp_path, monkeypatch)
    seen = {}
    for who in ('Test User 1', 'Test User 2'):
        body = {**BODY, "character": who}
        key = client.post("/v1/audio/prerender", json=body).get_json()["cache_key"]
        _wait(lambda k=key, w=who: nomi.cache_path(k, f"st:{w}").exists(),
              what=f"{who}'s cache entry")
        seen[who] = nomi.cache_path(key, f"st:{who}")

    assert seen['Test User 1'].parent.parent != seen['Test User 2'].parent.parent, (
        "both characters were filed under one speaker — the route is not passing `owner`")
    # And nothing landed in the flat layout, which is where a missing owner would put it.
    flat = [p for p in (tmp_path / "cache").glob("??/*.mp3")]
    assert flat == [], f"the route wrote pre-5.3.3 flat entries: {flat}"
