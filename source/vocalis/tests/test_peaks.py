"""The peaks envelope and its cache key (9.0-m8).

Pure-module specs: no vault, no master, no ffmpeg. That is the point of `peaks.py` doing no I/O —
every rule below is about arithmetic and identity, and none of them needs a card, a file or a
running server to be true.
"""
from __future__ import annotations

import json
import struct

import pytest

from vocalis.runtime import peaks


def _pcm(samples) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


def _peaks(pcm: bytes, buckets: int):
    return json.loads(peaks.render(pcm, buckets))["peaks"]


# ── the key ───────────────────────────────────────────────────────────────────

def test_the_bucket_count_is_part_of_the_key():
    """🔴 THE WHOLE REASON THIS KEY EXISTS. `thumbs.py`'s design note is that a cache keyed on
    only some of its inputs goes stale SILENTLY — there, a moved crop rect kept serving the old
    thumbnail. An envelope rendered for 800 buckets and served for a 1600-px timeline is the same
    failure in different clothes: it draws, it looks like a waveform, and it is the wrong shape.
    """
    a = peaks.key(1000, 1.0, 800)
    b = peaks.key(1000, 1.0, 1600)
    assert a != b, "two bucket counts share one cache entry - the timeline will draw a stale shape"


def test_the_key_is_a_stat_not_a_content_hash():
    """🔴 DELIBERATELY COPIED FROM `thumbs.key`. The question a cache asks is "is it the same
    FILE". Hashing a four-minute master on every timeline open pays exactly the cost the cache
    exists to avoid — and this function is never given the bytes, which is the structural version
    of that promise."""
    import inspect
    src = inspect.getsource(peaks.key)
    assert "pcm" not in src.split('"""')[-1], "the key reads audio content"
    assert peaks.key(1, 2.0, 800) != peaks.key(2, 2.0, 800), "size is not in the key"
    assert peaks.key(1, 2.0, 800) != peaks.key(1, 3.0, 800), "mtime is not in the key"


def test_a_float_wobble_in_mtime_does_not_rebuild_everything():
    """⚠️ mtime arrives as a float from two filesystems - the vault's logical stat and a plain
    `Path.stat`. A difference in the fifteenth decimal is the same file, and without rounding a
    re-serialized stat would rebuild every envelope for no change at all."""
    assert peaks.key(1000, 1234.5678000000001, 800) == peaks.key(1000, 1234.5678, 800)
    # ...but a real change still moves it. A rounding that swallowed a millisecond would be a
    # cache that cannot see an edit.
    assert peaks.key(1000, 1234.567, 800) != peaks.key(1000, 1234.568, 800)


def test_the_asset_name_carries_the_prefix_the_sweep_globs():
    """🔴 THE PREFIX IS CONTRACT. The sweep globs `peaks-*`, as thumbs globs `thumb-*.webp`.
    Change one half and the sweep stops finding old entries — which does not fail, it silently
    accumulates files in the vault for ever."""
    k = peaks.key(1, 2.0, 800)
    name = peaks.asset_name(k)
    assert name.startswith(peaks.PREFIX) and name.endswith(peaks.SUFFIX)
    assert k in name, "the key is not the filename, so existence stops being validity"


def test_bucket_counts_are_bounded():
    """⚠️ THE COUNT IS A KEY INPUT, so an unbounded one lets a caller mint unlimited cache entries
    for a single master — each a real file in the vault."""
    assert peaks.clamp_buckets(10 ** 9) == peaks.MAX_BUCKETS
    assert peaks.clamp_buckets(1) == peaks.MIN_BUCKETS
    assert peaks.clamp_buckets("banana") == peaks.DEFAULT_BUCKETS
    assert peaks.clamp_buckets(None) == peaks.DEFAULT_BUCKETS


# ── the envelope ──────────────────────────────────────────────────────────────

def test_render_honors_the_count_it_is_given_so_the_key_never_lies():
    """🔴 CLAMPING BELONGS AT THE ROUTE, BEFORE THE KEY IS TAKEN, AND NOWHERE ELSE.

    The first draft clamped inside `render` as well. That produced the precise divergence this
    module exists to prevent: `key(.., 16)` and `key(.., 64)` are different strings while both
    rendered 64 buckets - two cache entries with identical bodies, one filed under a key
    describing a shape it does not contain. A cache whose key and body disagree is worse than no
    cache, because every consumer trusts the key.

    So the order is: clamp -> key -> render, all on the SAME number.
    """
    asked = 3000
    n = peaks.clamp_buckets(asked)
    body = json.loads(peaks.render(_pcm([1000] * 10_000), n))
    assert body["buckets"] == n == len(body["peaks"])

    # And an unclamped call renders exactly what it was asked for, however silly.
    assert len(_peaks(_pcm([1000] * 100), 7)) == 7


def test_the_envelope_has_exactly_the_buckets_asked_for():
    for n in (64, 100, 800, 1000):
        assert len(_peaks(_pcm([1000] * 5000), n)) == n


def test_it_is_the_MAX_not_the_mean():
    """🔴 THE DIFFERENCE IS THE ENTIRE PURPOSE OF THE PICTURE. A mean over ~10,000 samples of a
    music track converges to something small and flat in every bucket, because the signal is
    symmetric about zero and busy. The timeline is used to find where things START — a drum hit, a
    vocal entry — and those are peaks by definition.

    A mean-rendered envelope still LOOKS like a waveform, which is why this needs a test rather
    than an eye: the failure is a picture that is plausible and useless.
    """
    # One loud sample in an otherwise quiet bucket. The mean of this is ~0.0002; the max is 1.0.
    quiet = [100] * 999 + [32767]
    got = _peaks(_pcm(quiet), 1)[0]
    assert got > 0.99, f"got {got} - this is a mean, not a max, and the transient has vanished"


def test_a_negative_peak_counts_and_never_exceeds_one():
    """⚠️ -32768 IS A LEGAL SAMPLE and dividing by 32767 would put it above 1.0 — which a client
    scaling by the canvas height draws past the top of the timeline."""
    got = _peaks(_pcm([-32768] * 1000), 1)[0]
    assert 0.99 < got <= 1.0, got


def test_the_last_bucket_gets_the_remainder():
    """⚠️ With `len(samples)` not divisible by `buckets`, a truncated stride leaves a tail of up to
    `buckets-1` samples unread. Inaudible mid-track; very visible at the END, where a fade-out
    that stops early makes the master look shorter than it is — and someone then places a shot
    boundary against that."""
    # 1003 samples into 10 buckets: the last 3 are only reachable if the tail is included.
    tail_loud = [0] * 1000 + [32767, 32767, 32767]
    assert _peaks(_pcm(tail_loud), 10)[-1] > 0.99, "the tail samples were dropped"


def test_more_buckets_than_samples_does_not_draw_a_comb():
    """A short master at a wide timeline. Emitting 0.0 for the empty buckets would draw a comb of
    gaps through a perfectly loud passage; repeating the neighbor is the honest picture of "we
    do not have finer detail than this"."""
    got = _peaks(_pcm([20000] * 10), 64)
    assert len(got) == 64
    assert all(v > 0.5 for v in got), f"gaps appeared in a constant-amplitude signal: {got}"


def test_an_empty_master_degrades_to_a_flat_rule():
    """🔴 A MISS DEGRADES, IT NEVER RAISES. §5.2b: no peaks means the timeline draws a flat rule
    and every shot boundary still works, because boundaries are NUMBERS, not pixels. A render that
    raised here would take the whole screen down over a decorative layer."""
    got = _peaks(b"", 128)
    assert got == [0.0] * 128


def test_an_odd_byte_count_does_not_raise():
    """A truncated decode - ffmpeg killed mid-write - hands back an odd number of bytes. That must
    round down to whole samples rather than raising out of `struct.unpack`."""
    assert len(_peaks(_pcm([500] * 100) + b"\x01", 16)) == 16


def test_the_ffmpeg_command_decodes_mono_pcm_to_stdout():
    """⚠️ MONO AND 8 kHz ON PURPOSE: the output is a picture and is never listened to, so this is
    the one place in the release where discarding audio quality is correct."""
    cmd = peaks.ffmpeg_pcm_cmd("/vault/master.flac")
    assert cmd[0] == "ffmpeg"
    assert cmd[-1] == "-", "the decode must go to stdout, not a temp file"
    assert "-nostdin" in cmd, "ffmpeg inherits the server's stdin and can consume it"
    for flag, value in (("-ac", "1"), ("-f", "s16le")):
        assert cmd[cmd.index(flag) + 1] == value
    assert "-c" not in cmd and "copy" not in cmd, "a stream copy cannot produce PCM"


@pytest.mark.parametrize("buckets", [64, 333, 800, 4096])
def test_every_value_is_in_range_for_real_looking_audio(buckets):
    """A sanity sweep: nothing outside 0.0-1.0 for any bucket count, including ones that do not
    divide the sample count."""
    import math
    sig = [int(30000 * math.sin(i / 50.0)) for i in range(11_111)]
    got = _peaks(_pcm(sig), buckets)
    assert len(got) == buckets
    assert all(0.0 <= v <= 1.0 for v in got), (min(got), max(got))
