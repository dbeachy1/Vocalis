"""Build ZIP archives incrementally for HTTP download without holding the full archive in memory. Open entries through routed readers rather than raw paths, use ZIP_STORED for already-compressed audio, and clamp timestamps to the ZIP-supported DOS epoch."""
import time
import zipfile
from pathlib import Path

ZIP_CHUNK = 256 * 1024
DOS_EPOCH = 315532800                                  # 1980-01-01T00:00:00Z


class ZipSink:
    """A write-only sink for `zipfile` — see this module's docstring, point 1."""
    __slots__ = ("_buf", "_pos")

    def __init__(self):
        self._buf = bytearray()
        self._pos = 0

    def write(self, b) -> int:
        self._buf += b
        self._pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self._pos

    def flush(self):
        pass

    def take(self) -> bytes:
        out = bytes(self._buf)
        del self._buf[:]
        return out


def unique_name(stem: str, used: set) -> str:
    """A name not already in `used`, case-insensitively, mutating `used`.

    The archive is FLAT — the user asked for their files, not for the store's folder layout —
    which means two entries can collide on a name, and a zip with two identical names unpacks as
    ONE FILE with no warning anywhere. Identity suffixes make that virtually impossible for
    clips and scenes; a partial's name comes from its text, where it is not.
    """
    name, n = stem, 2
    while name.lower() in used:
        p = Path(stem)
        name = f"{p.stem} ({n}){p.suffix}"
        n += 1
    used.add(name.lower())
    return name


def stream(items):
    """Yield a zip archive of `items` — an iterable of `(name, mtime, opener)`, where `opener()`
    returns a readable that must already be ROUTED (see point 2). Caller checks emptiness: an
    empty archive is a lie, not a degradation, so the route 404s rather than shipping one."""
    def _gen():
        sink = ZipSink()
        with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as z:
            for name, mtime, opener in items:
                info = zipfile.ZipInfo(name,
                                       date_time=time.localtime(max(mtime, DOS_EPOCH))[:6])
                info.compress_type = zipfile.ZIP_STORED
                with opener() as src, z.open(info, "w") as dst:
                    while True:
                        chunk = src.read(ZIP_CHUNK)
                        if not chunk:
                            break
                        dst.write(chunk)
                        if (out := sink.take()):
                            yield out
                if (out := sink.take()):
                    yield out
        if (out := sink.take()):                       # the central directory
            yield out
    return _gen()
