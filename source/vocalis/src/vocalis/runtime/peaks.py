"""Build a compact amplitude envelope for a production's master audio.

This module is pure: it converts PCM bytes into an envelope and builds the ffmpeg command. The
store owns cache I/O and keys each envelope by master identity and bucket count.
"""
from __future__ import annotations

import hashlib
import json
import struct

#: Prefix used by the store's cache sweep; keep it aligned with the asset naming pattern.
PREFIX = "peaks-"
SUFFIX = ".json"

#: 🔴 THE DECODE RATE, NAMED ONCE. `ffmpeg_pcm_cmd` asks for it and `render` divides by it
#: to report a duration. Two literals would drift, and the duration would silently scale
#: while still looking like a plausible number.
PCM_RATE = 8000

#: Bucket counts the route will accept. ⚠️ **BOUNDED BECAUSE THE COUNT IS A CACHE KEY INPUT.** An
#: unbounded count lets any caller mint an unlimited number of cache entries for one master, each
#: a file in the vault; and a 100,000-bucket envelope is finer than any screen can draw.
MIN_BUCKETS = 64
MAX_BUCKETS = 4096
DEFAULT_BUCKETS = 800


def key(size: int, mtime: float, buckets: int) -> str:
    """Cache identity from master size, rounded modification time, and output bucket count.

    Including every output-affecting input prevents an envelope with the wrong shape from being
    reused. Millisecond rounding avoids misses from insignificant float differences between
    filesystem stat implementations.
    """
    raw = f"{int(size)}:{round(float(mtime), 3)}:{int(buckets)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def asset_name(k: str) -> str:
    """Return the cache filename; file existence marks a cache hit."""
    return f"{PREFIX}{k}{SUFFIX}"


def clamp_buckets(value) -> int:
    """A bucket count the cache is willing to mint an entry for."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_BUCKETS
    return max(MIN_BUCKETS, min(MAX_BUCKETS, n))


def render(pcm: bytes, buckets: int, sample_rate: int = 0) -> bytes:
    """Signed 16-bit mono PCM in, a JSON envelope out. Pure.

    The envelope is `{"buckets": N, "duration_s": D, "peaks": [...]}` with one float per
    bucket in 0.0–1.0 — the **maximum absolute sample** in that bucket, not the mean.

    Each bucket stores the maximum absolute sample so transients remain visible in the timeline.

    ⚠️ **THE LAST BUCKET GETS THE REMAINDER.** With `len(samples)` not divisible by `buckets`,
    slicing by a truncated stride leaves a tail of up to `buckets-1` samples unread. That is
    inaudible in the middle of a track and very visible at the end of one — a fade-out that stops
    early looks like the master is shorter than it is, which is exactly the sort of thing someone
    would then place a shot boundary against.
    """
    # The caller clamps before computing the cache key. Do not clamp here: rendered bucket count
    # must match the count encoded in that key.
    n = max(1, int(buckets))
    count = len(pcm) // 2
    if count <= 0:
        # An empty master is not an error: the timeline draws a flat rule and every shot boundary
        # still works, because boundaries are numbers rather than pixels.
        return json.dumps({"buckets": n, "duration_s": 0.0,
                           "peaks": [0.0] * n}).encode("utf-8")

    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    out = []
    for i in range(n):
        lo = (i * count) // n
        hi = count if i == n - 1 else ((i + 1) * count) // n
        if hi <= lo:
            # More buckets than samples: nearest-sample upsample.
            #
            # More buckets than samples: use the nearest available sample, including at the edges.
            out.append(round(abs(samples[min(lo, count - 1)]) / 32768.0, 4))
            continue
        window = samples[lo:hi]
        # 32768 rather than 32767: -32768 is a legal sample and would otherwise exceed 1.0, which
        # a client scaling by the canvas height would draw past the top of the timeline.
        out.append(round(max(abs(s) for s in window) / 32768.0, 4))
    # Use the decoded sample count and rate so duration matches the envelope's audio data.
    duration = round(count / float(sample_rate or PCM_RATE), 3)
    return json.dumps({"buckets": n, "duration_s": duration, "peaks": out}).encode("utf-8")


def ffmpeg_pcm_cmd(src, ffmpeg: str = "ffmpeg") -> list:
    """Decode any master to signed 16-bit mono PCM on stdout.

    ⚠️ **MONO AND LOW-RATE ON PURPOSE.** The envelope is a picture; 8 kHz mono carries every
    transient a timeline can show and decodes a four-minute track in a fraction of the time full
    resolution takes. This is the one place in the release where throwing away audio quality is
    correct, because the output is never listened to.

    📌 `-nostdin` because ffmpeg inherits the server's stdin otherwise and can consume it.
    """
    return [ffmpeg, "-nostdin", "-v", "error", "-i", str(src),
            "-map", "0:a:0", "-ac", "1", "-ar", str(PCM_RATE),
            "-f", "s16le", "-acodec", "pcm_s16le", "-"]
