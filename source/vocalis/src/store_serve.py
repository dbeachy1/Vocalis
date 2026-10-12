"""Serve vault-backed files over HTTP with Range support. Keep this helper independent of vocalis_server so both the server and streaming route can import it without a reverse import cycle or duplicate server initialization."""
import mimetypes
from pathlib import Path

from flask import Response, request, send_file

import vault_store


def parse_range(header, total: int):
    """An HTTP Range header → (start, end) INCLUSIVE, or None for "send the whole thing".

    Handles the three forms a browser actually sends: `bytes=0-499`, `bytes=500-` (to the end),
    and `bytes=-500` (the LAST 500 bytes — a suffix, not a negative offset, and getting that one
    backward serves the wrong end of the file). Anything malformed, multi-range, or out of
    bounds falls back to the full body, which is always a legal answer to a Range request.
    """
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    spec = header[6:].strip()
    try:
        first, _, last = spec.partition("-")
        if not first:                                   # bytes=-N  → the final N bytes
            n = int(last)
            if n <= 0:
                return None
            start, end = max(0, total - n), total - 1
        else:
            start = int(first)
            end = int(last) if last else total - 1
    except ValueError:
        return None
    end = min(end, total - 1)
    if start > end or start < 0 or start >= total:
        return None                                     # unsatisfiable — just send it all
    return start, end


#: The cap limits how long a media range occupies a response socket. A 1 MiB response was selected from browser playback checks: it keeps uncompressed PCM responses short while leaving enough data for efficient streaming. Compressed audio may request partial ranges; aborting and retrying is preferable to holding a socket during a slow drain.
RANGE_CHUNK_CAP = 1 * 1024 * 1024


def _read_range(p: Path, start: int, end: int):
    """Yield `p[start:end]` in blocks. Bounded memory, like the vault path beside it."""
    def gen():
        with open(p, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                b = fh.read(min(65536, left))
                if not b:
                    break
                left -= len(b)
                yield b
    return gen()


def _send_plain(p: Path, *, as_attachment: bool, download_name: str, mimetype: str):
    """A file this box does not route — an /ai-output song, or an unmigrated install.

    🔴 IT STILL GETS THE CAP. The first version of this fix capped only the VAULT branch and
    handed everything else to Werkzeug, which answers `bytes=0-` with the whole file — so every
    ACE-Step song, which lives in /ai-output and routes to None, kept the exact defect the fix
    was written for. A fix that covers one of two branches is the same shape as a fix that
    covers one of five blueprints.

    ⚠️ A DOWNLOAD IS NOT A PLAYER and keeps Werkzeug's path: an attachment fetch sends no Range,
    wants the whole body, and gets it in one response.
    """
    mt = mimetype or mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    if as_attachment:
        return send_file(str(p), as_attachment=True, download_name=download_name, mimetype=mt)
    try:
        total = p.stat().st_size
    except OSError:
        return send_file(str(p), download_name=download_name, mimetype=mt)
    rng = parse_range(request.headers.get("Range"), total)
    if rng is None:
        # No Range at all: Werkzeug's 200 is exactly right and already streams from disk.
        return send_file(str(p), download_name=download_name, mimetype=mt)
    start, end = rng
    end = min(end, start + RANGE_CHUNK_CAP - 1)
    resp = Response(_read_range(p, start, end), 206, mimetype=mt)
    resp.headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    resp.headers["Content-Length"] = str(end - start + 1)
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


def send_capped_bytes(data: bytes, *, mimetype: str, etag: str = None):
    """Serve audio already held in memory with the same bounded response behavior used by file-backed routes. Reuse this helper for previews and decoded stems so memory responses do not bypass connection limits."""
    total = len(data)
    rng = request.range
    # 🔴 `If-Range` GUARDS A MID-PLAYBACK SEEK, and it is not decoration. If the validator no
    # longer matches, the only correct answer is the WHOLE file as a 200 — never a slice of the
    # new bytes spliced into the old ones, which is audio that plays and is wrong. Rendered
    # audio is immutable per id so this never fires in practice, and "in practice" is not a
    # contract. Carried over verbatim from `web/acestep.py::_audio_response`; folding that
    # function into this one DROPPED it, and its own spec caught the regression.
    if rng is not None and etag:
        ir = request.if_range
        if ir is not None and ir.etag is not None and ir.etag != etag:
            rng = None
    if rng is not None:
        span = rng.range_for_length(total)
        if span is None:
            # 🔴 416, NOT A 200 OF THE WHOLE FILE. A range past the end is a client asking for
            # something that does not exist, and answering it with the entire body looks like
            # success to every layer above. Also lost in the fold, also caught by its spec.
            resp = Response(b"", 416, mimetype=mimetype)
            resp.headers["Content-Range"] = f"bytes */{total}"
            return resp
        start, stop = span
        stop = min(stop, start + RANGE_CHUNK_CAP)
        resp = Response(data[start:stop], 206, mimetype=mimetype)
        resp.headers["Content-Range"] = f"bytes {start}-{stop - 1}/{total}"
        resp.headers["Accept-Ranges"] = "bytes"
        if etag:
            resp.set_etag(etag)
        return resp
    resp = Response(data, mimetype=mimetype)
    resp.headers["Accept-Ranges"] = "bytes"
    if etag:
        resp.set_etag(etag)
        return resp.make_conditional(request, accept_ranges=True, complete_length=total)
    resp.headers["Content-Length"] = str(total)
    return resp


def send_store_file(p, *, as_attachment: bool = False, download_name: str = None,
                    mimetype: str = None):
    """Serve a stored file with byte-range support while routing reads through the vault. Stream only requested encrypted blocks for ranges and stream full responses without materializing the file in memory. Keep response caps in place for paths outside owned stores as well."""
    p = Path(p)
    r = vault_store.route(p)
    if r is None:
        return _send_plain(p, as_attachment=as_attachment, download_name=download_name,
                           mimetype=mimetype)

    v, logical = r
    total = v.stat(logical).size
    mt = mimetype or mimetypes.guess_type(p.name)[0] or "application/octet-stream"

    rng = parse_range(request.headers.get("Range"), total)
    if rng is not None:
        start, end = rng
        # Cap each Range response so a request for the whole media file does not hold a connection until the final byte. This shared sender serves stems, clips, the playground library, and voice-swap assets, so the limit belongs here rather than in one route. Each response is still freshly decrypted; this is neither a cache nor a preload. Requests without a Range header use the full-download path and remain unaffected. The WSGI handler closes each response, so the cap bounds per-response occupancy but does not provide keep-alive; changing the protocol version alone is not sufficient.
        end = min(end, start + RANGE_CHUNK_CAP - 1)
        # STREAMED, never materialized. `bytes=0-` is a browser's FIRST request for any
        # <audio> src and resolves to a range covering the WHOLE file, so handing that back as
        # one bytes object put the 200 MB-per-request allocation the full-body path below
        # exists to avoid straight back in through the range door. Same blocks decrypted,
        # bounded memory. Content-Length is the range's own length: parse_range has already
        # clamped `end` inside the file, so it matches the bytes that follow.
        resp = Response(v.stream_range_chunks(logical, start, end), 206, mimetype=mt)
        resp.headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        resp.headers["Content-Length"] = str(end - start + 1)
    else:
        # export_plaintext() is the same bytes as open_read — it exists so that a DELIBERATE
        # plaintext egress is greppable, and a download is exactly that.
        fh = v.export_plaintext(logical) if as_attachment else v.open_read(logical)
        resp = Response(iter(lambda: fh.read(65536), b""), 200, mimetype=mt)
        resp.headers["Content-Length"] = str(total)
    # `Accept-Ranges: bytes` is not decoration and it is not optional: without it Chrome treats
    # the resource as NON-SEEKABLE — seekable ends at 0, every currentTime write is discarded,
    # and the scrub bar silently snaps back. Dropping it for voice clips (M10d) is exactly how
    # that shipped. Every route through here serves ranges, so every route says so.
    resp.headers["Accept-Ranges"] = "bytes"
    if as_attachment:
        name = download_name or p.name
        resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return resp
