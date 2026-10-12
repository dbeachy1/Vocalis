"""Shared authenticated framing for Vocalis and standalone render satellites.

The file has no Vocalis imports so the satellite directory can be copied and run
independently. TLS remains mandatory; per-request AES-GCM keys add payload
protection if transport verification is misconfigured.

A 32-byte per-satellite master secret is created during pairing and never sent.
Each request includes a fresh random salt; both peers derive a directional key
with HKDF:

    key = HKDF-SHA256(master, salt=salt, info=b"vocalis-satellite-v1|<direction>")

Separate direction labels prevent request and response keys from being reused.
Each stream frame uses a counter nonce under its request-specific key. An
authenticated END frame distinguishes a complete stream from a truncated one.
"""
import hashlib
import hmac
import json
import os
import struct

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PROTOCOL_VERSION = "vocalis-satellite-v1"

AAD = PROTOCOL_VERSION.encode("ascii")     # binds frames to this protocol version
SALT_BYTES = 32
MASTER_BYTES = 32
KEY_BYTES = 32                             # AES-256
_LEN = struct.Struct(">I")

DIR_TO_SATELLITE = "k2s"                   # Client to satellite.
DIR_TO_SERVER = "s2k"                      # Satellite to client.

TYPE_DATA = 0x01
TYPE_END = 0x02

# ── Payload tags (5.3-m4) ────────────────────────────────────────────────────
#
# These are NOT frame types and they change nothing about the cipher or the wire format — they
# are the first byte INSIDE a DATA frame's payload, so a progressive reply can say what each
# frame is as it arrives.
#
# Stream frames arrive incrementally, so explicit payload tags identify headers,
# audio, and the final status trailer without relying on frame position.
TAG_HEADER = b"H"       # JSON: {"sr": 24000} — always the first frame of a stream reply
TAG_AUDIO = b"A"        # little-endian int16 PCM at the header's sample rate
TAG_TRAILER = b"T"      # JSON: {"ok"|"canceled"|"error"} — always the last DATA frame

# A frame's plaintext is one type byte plus payload; 16 bytes of that is the GCM tag. The cap
# is a DoS bound on the reader: without it a hostile length prefix makes us allocate 4 GB
# before we have authenticated anything at all.
MAX_FRAME_BYTES = 8 * 1024 * 1024

# How much payload a single frame carries when `seal_bytes` splits a large body. Comfortably
# under the cap (the sealed frame adds a type byte and a 16-byte tag), and EVEN, so a split
# never lands mid-sample when the body is int16 PCM.
FRAME_PAYLOAD_BYTES = 4 * 1024 * 1024


class ProtocolError(Exception):
    """Malformed, truncated, or unauthenticated data on the satellite wire."""


def new_master() -> bytes:
    """Generate a fresh per-satellite master secret during pairing."""
    return os.urandom(MASTER_BYTES)


def new_salt() -> bytes:
    """A fresh per-request salt. Travels in the clear; that is by design."""
    return os.urandom(SALT_BYTES)


def derive_key(master: bytes, salt: bytes, direction: str) -> bytes:
    """HKDF-SHA256 (RFC 5869) — extract then expand. Implemented on hmac rather than pulled from
    `cryptography.hazmat.primitives.kdf` purely to keep this file's import surface to one name,
    since it is copied onto a machine whose venv we control less tightly.

    One output block is plenty: SHA-256 gives 32 bytes and we want exactly 32.
    """
    if len(master) < 16:
        raise ProtocolError("master secret is too short — expected 32 bytes")
    if len(salt) < 16:
        raise ProtocolError("salt is too short — expected 32 bytes")
    if direction not in (DIR_TO_SATELLITE, DIR_TO_SERVER):
        raise ProtocolError(f"unknown direction {direction!r}")
    prk = hmac.new(salt, master, hashlib.sha256).digest()
    info = f"{PROTOCOL_VERSION}|{direction}".encode("ascii")
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:KEY_BYTES]


def _nonce(counter: int) -> bytes:
    """96-bit big-endian counter. GCM's standard nonce width; anything else costs a rehash."""
    if counter < 0 or counter >= 1 << 64:
        raise ProtocolError("frame counter out of range")
    return b"\x00\x00\x00\x00" + counter.to_bytes(8, "big")


class SealedWriter:
    """Seals a stream of byte chunks into frames. One instance per request, never reused.

    Call `frame(data)` per chunk and `end()` exactly once. `end()` is not optional — see the
    module docstring.
    """

    def __init__(self, key: bytes):
        self._aes = AESGCM(key)
        self._counter = 0
        self._ended = False

    def _seal(self, type_byte: int, payload: bytes) -> bytes:
        if self._ended:
            raise ProtocolError("writer already ended")
        sealed = self._aes.encrypt(_nonce(self._counter),
                                   bytes([type_byte]) + payload, AAD)
        self._counter += 1
        if len(sealed) > MAX_FRAME_BYTES:
            raise ProtocolError(f"frame of {len(sealed)} bytes exceeds the "
                                f"{MAX_FRAME_BYTES}-byte cap")
        return _LEN.pack(len(sealed)) + sealed

    def frame(self, data: bytes) -> bytes:
        return self._seal(TYPE_DATA, data)

    def end(self) -> bytes:
        out = self._seal(TYPE_END, b"")
        self._ended = True
        return out


class SealedReader:
    """Unseals frames as bytes arrive. Feed it whatever the socket gave you, in any sizes.

    `feed(chunk)` yields fully-decrypted payloads. `complete` is True once the END frame has been
    authenticated; `finish()` raises if it has not.
    """

    def __init__(self, key: bytes):
        self._aes = AESGCM(key)
        self._counter = 0
        self._buf = bytearray()
        self.complete = False

    def feed(self, chunk: bytes):
        """Yield each complete frame's payload. Never yields anything unauthenticated —
        GCM verifies the tag before `decrypt` returns."""
        self._buf.extend(chunk)
        while True:
            if len(self._buf) < _LEN.size:
                return
            (n,) = _LEN.unpack_from(self._buf, 0)
            if n > MAX_FRAME_BYTES:
                raise ProtocolError(f"frame length {n} exceeds the {MAX_FRAME_BYTES}-byte cap "
                                    f"— refusing to allocate for unauthenticated data")
            if len(self._buf) < _LEN.size + n:
                return
            sealed = bytes(self._buf[_LEN.size:_LEN.size + n])
            del self._buf[:_LEN.size + n]
            if self.complete:
                raise ProtocolError("frame after END — the stream claims to have ended twice")
            try:
                plain = self._aes.decrypt(_nonce(self._counter), sealed, AAD)
            except Exception as exc:                       # noqa: BLE001 — InvalidTag et al
                raise ProtocolError(
                    f"frame {self._counter} failed authentication: {exc!r}. Either the key is "
                    f"wrong, the frames arrived out of order, or the data was tampered with — "
                    f"in every case the payload is discarded rather than used") from exc
            self._counter += 1
            if not plain:
                raise ProtocolError("empty frame — no type byte")
            kind, payload = plain[0], plain[1:]
            if kind == TYPE_END:
                if payload:
                    raise ProtocolError("END frame carried a payload")
                self.complete = True
                continue
            if kind != TYPE_DATA:
                raise ProtocolError(f"unknown frame type {kind:#04x}")
            yield payload

    def finish(self) -> None:
        """Raise unless the authenticated END frame and all input bytes were received."""
        if not self.complete:
            raise ProtocolError(
                "stream ended without an END frame — it was truncated. The partial payload must "
                "be discarded, never cached: on the server side a truncated render promoted into "
                "the vault would be served as the real thing forever")
        if self._buf:
            raise ProtocolError(f"{len(self._buf)} trailing bytes after END")


def seal_bytes(key: bytes, data: bytes) -> bytes:
    """Whole-message convenience: DATA frames plus END. For request bodies and small responses,
    where there is nothing to stream and buffering costs nothing.

    Large bodies are split into bounded DATA frames. The reader already joins
    DATA payloads, so this does not change the wire format or frame-size limit.
    """
    w = SealedWriter(key)
    parts = [w.frame(data[i:i + FRAME_PAYLOAD_BYTES])
             for i in range(0, len(data), FRAME_PAYLOAD_BYTES)]
    if not parts:                       # an empty body still needs one frame to carry "nothing"
        parts = [w.frame(b"")]
    return b"".join(parts) + w.end()


def open_frames(key: bytes, blob: bytes) -> list:
    """Every DATA frame's payload, as a list, with the END check applied.

    Frame boundaries are preserved because some replies are structured rather than a byte
    stream — the render reply is a JSON header frame followed by a PCM frame, and joining
    those would make the split ambiguous the moment a header contains a `}`.
    """
    r = SealedReader(key)
    out = list(r.feed(blob))
    r.finish()
    return out


def open_bytes(key: bytes, blob: bytes) -> bytes:
    """Inverse of `seal_bytes`, with the END check applied — so a truncated body raises here
    rather than silently returning a short result."""
    return b"".join(open_frames(key, blob))


# ── structured bodies: a JSON header plus binary parts (8.6) ─────────────────
#
# Structured payload boundaries use declared byte lengths because sealing may
# split a binary part across multiple DATA frames.

def pack_parts(header: dict, parts: list) -> bytes:
    """`uint32be(len(json)) || json || part0 || part1 || …`, ready for `seal_bytes`.

    `header["parts"]` is written here — a list of `[name, nbytes]` in wire order — so the
    receiver never has to guess where one part ends. Any other keys the caller put in the
    header are carried through untouched.
    """
    head = dict(header)
    head["parts"] = [[str(name), len(blob)] for name, blob in parts]
    blob = json.dumps(head).encode("utf-8")
    return _LEN.pack(len(blob)) + blob + b"".join(bytes(b) for _n, b in parts)


def unpack_parts(body: bytes) -> tuple:
    """Inverse of `pack_parts`. Returns `(header, {name: bytes})`.

    Raises `ProtocolError` rather than returning a short part: a truncated body that yielded
    half a WAV would be handed to a separator, which would answer with plausible audio for
    the wrong length of song.
    """
    if len(body) < _LEN.size:
        raise ProtocolError("structured body is too short to carry a header length")
    (n,) = _LEN.unpack_from(body, 0)
    if n > MAX_FRAME_BYTES or len(body) < _LEN.size + n:
        raise ProtocolError(f"structured body declares a {n}-byte header it does not carry")
    try:
        head = json.loads(body[_LEN.size:_LEN.size + n].decode("utf-8"))
    except Exception as exc:                                  # noqa: BLE001
        raise ProtocolError(f"structured body header is not JSON: {exc!r}") from exc
    if not isinstance(head, dict):
        raise ProtocolError("structured body header is not an object")
    out, off = {}, _LEN.size + n
    for item in head.get("parts") or []:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ProtocolError(f"malformed part descriptor {item!r}")
        name, size = str(item[0]), int(item[1])
        if size < 0 or off + size > len(body):
            raise ProtocolError(f"part {name!r} declares {size} bytes the body does not carry")
        out[name] = body[off:off + size]
        off += size
    if off != len(body):
        raise ProtocolError(f"{len(body) - off} trailing bytes after the last declared part")
    return head, out
