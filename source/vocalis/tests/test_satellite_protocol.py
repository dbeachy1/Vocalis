"""The sealed satellite wire format.

These are the tests for the one piece of 5.3 whose failures are SILENT. A broken cipher does not
raise — it produces bytes that are merely wrong, and on the receiving side those get promoted
into the vault cache and served as real audio forever. So the assertions here are mostly about
what must be *refused*, not what must work.

Design: DESIGN_5_3_SATELLITES §7.
"""
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT

# The satellite folder is copied independently and must run standalone, so the host-side tests
# load its protocol module directly instead of keeping a second copy.
sys.path.insert(0, str(REPO_ROOT / "satellite"))

import vocalis_satellite_protocol as proto      # noqa: E402


@pytest.fixture
def keys():
    master = proto.new_master()
    salt = proto.new_salt()
    return (proto.derive_key(master, salt, proto.DIR_TO_SATELLITE),
            proto.derive_key(master, salt, proto.DIR_TO_SERVER),
            master, salt)


# ── derivation ───────────────────────────────────────────────────────────────

def test_the_two_directions_get_different_keys(keys):
    """Without this a recorded response replays as a request."""
    k2s, s2k, _, _ = keys
    assert k2s != s2k


def test_a_fresh_salt_gives_a_fresh_key():
    master = proto.new_master()
    a = proto.derive_key(master, proto.new_salt(), proto.DIR_TO_SATELLITE)
    b = proto.derive_key(master, proto.new_salt(), proto.DIR_TO_SATELLITE)
    assert a != b, "per-request salts must produce independent key material"


def test_derivation_is_deterministic_for_the_same_inputs():
    """Both boxes derive independently and never exchange the key; if this drifts they simply
    stop understanding each other."""
    master, salt = proto.new_master(), proto.new_salt()
    assert (proto.derive_key(master, salt, proto.DIR_TO_SATELLITE)
            == proto.derive_key(master, salt, proto.DIR_TO_SATELLITE))


def test_the_master_secret_never_appears_in_derived_material():
    master = b"\xab" * 32
    salt = proto.new_salt()
    key = proto.derive_key(master, salt, proto.DIR_TO_SATELLITE)
    assert master not in key and key != master


@pytest.mark.parametrize("bad", [b"", b"short", b"x" * 15])
def test_a_short_master_or_salt_is_refused(bad):
    ok = proto.new_master()
    with pytest.raises(proto.ProtocolError):
        proto.derive_key(bad, proto.new_salt(), proto.DIR_TO_SATELLITE)
    with pytest.raises(proto.ProtocolError):
        proto.derive_key(ok, bad, proto.DIR_TO_SATELLITE)


def test_an_unknown_direction_is_refused():
    with pytest.raises(proto.ProtocolError):
        proto.derive_key(proto.new_master(), proto.new_salt(), "sideways")


# ── round trip ───────────────────────────────────────────────────────────────

def test_round_trip(keys):
    k2s, _, _, _ = keys
    payload = b"the quick brown fox" * 100
    assert proto.open_bytes(k2s, proto.seal_bytes(k2s, payload)) == payload


def test_the_ciphertext_does_not_contain_the_plaintext(keys):
    """The whole point. A framing bug that forgot to encrypt would pass a round-trip test."""
    k2s, _, _, _ = keys
    secret = b'Test Character says something private'
    assert secret not in proto.seal_bytes(k2s, secret)


def test_streaming_frames_reassemble_in_order(keys):
    _, s2k, _, _ = keys
    w = proto.SealedWriter(s2k)
    chunks = [f"chunk-{i}".encode() * 50 for i in range(20)]
    wire = b"".join(w.frame(c) for c in chunks) + w.end()

    r = proto.SealedReader(s2k)
    got = list(r.feed(wire))
    r.finish()
    assert got == chunks


def test_the_reader_handles_arbitrary_socket_chunking(keys):
    """Bytes arrive in whatever sizes the network felt like; frames span reads."""
    _, s2k, _, _ = keys
    w = proto.SealedWriter(s2k)
    payloads = [bytes([i]) * (i * 37 + 1) for i in range(12)]
    wire = b"".join(w.frame(p) for p in payloads) + w.end()

    r = proto.SealedReader(s2k)
    got = []
    for i in range(0, len(wire), 7):            # deliberately awkward split size
        got.extend(r.feed(wire[i:i + 7]))
    r.finish()
    assert got == payloads


def test_empty_payloads_survive(keys):
    k2s, _, _, _ = keys
    assert proto.open_bytes(k2s, proto.seal_bytes(k2s, b"")) == b""


# ── 🔴 what must be REFUSED ──────────────────────────────────────────────────

def test_truncation_is_detected(keys):
    """A cut connection resembles a finished stream until the END frame is checked; incomplete
    renders must never be promoted to the cache as complete audio."""
    _, s2k, _, _ = keys
    w = proto.SealedWriter(s2k)
    wire = w.frame(b"first half") + w.frame(b"second half") + w.end()

    r = proto.SealedReader(s2k)
    list(r.feed(wire[:len(wire) // 2]))         # connection dies mid-stream
    assert not r.complete
    with pytest.raises(proto.ProtocolError, match="truncated"):
        r.finish()


def test_dropping_only_the_end_frame_is_detected(keys):
    """The nastiest truncation: every DATA frame arrived intact, so the payload looks whole."""
    _, s2k, _, _ = keys
    w = proto.SealedWriter(s2k)
    body = w.frame(b"a") + w.frame(b"b")
    end = w.end()

    r = proto.SealedReader(s2k)
    assert list(r.feed(body)) == [b"a", b"b"]   # all the data, and it is correct
    with pytest.raises(proto.ProtocolError, match="truncated"):
        r.finish()                              # ...and it is still not a complete stream
    assert end                                  # (the frame we withheld)


def test_the_wrong_key_is_refused_not_garbled(keys):
    k2s, s2k, _, _ = keys
    wire = proto.seal_bytes(k2s, b"payload")
    with pytest.raises(proto.ProtocolError, match="authentication"):
        proto.open_bytes(s2k, wire)


def test_a_flipped_bit_is_refused(keys):
    """GCM's tag is the reason a corrupted stream fails HERE rather than being re-encrypted into
    the vault as noise that plays forever."""
    k2s, _, _, _ = keys
    wire = bytearray(proto.seal_bytes(k2s, b"payload" * 20))
    wire[len(wire) // 2] ^= 0x01
    with pytest.raises(proto.ProtocolError, match="authentication"):
        proto.open_bytes(k2s, bytes(wire))


def test_reordered_frames_are_refused(keys):
    """Counter nonces mean frame N only decrypts in position N."""
    _, s2k, _, _ = keys
    w = proto.SealedWriter(s2k)
    f0, f1, end = w.frame(b"zero"), w.frame(b"one"), w.end()

    r = proto.SealedReader(s2k)
    with pytest.raises(proto.ProtocolError, match="authentication"):
        list(r.feed(f1 + f0 + end))


def test_a_replayed_frame_is_refused(keys):
    _, s2k, _, _ = keys
    w = proto.SealedWriter(s2k)
    f0 = w.frame(b"zero")
    r = proto.SealedReader(s2k)
    assert list(r.feed(f0)) == [b"zero"]
    with pytest.raises(proto.ProtocolError, match="authentication"):
        list(r.feed(f0))                        # same frame again, now at counter 1


def test_frames_after_end_are_refused(keys):
    _, s2k, _, _ = keys
    w = proto.SealedWriter(s2k)
    wire = w.frame(b"data") + w.end()
    w2 = proto.SealedWriter(s2k)                # an attacker appending a fresh stream
    r = proto.SealedReader(s2k)
    with pytest.raises(proto.ProtocolError, match="END"):
        list(r.feed(wire + w2.frame(b"extra")))


def test_an_oversized_length_prefix_is_refused_before_allocating(keys):
    """A hostile length prefix is unauthenticated by construction — it has to be bounded before
    it is trusted, or it is a one-packet memory bomb."""
    _, s2k, _, _ = keys
    r = proto.SealedReader(s2k)
    with pytest.raises(proto.ProtocolError, match="cap"):
        list(r.feed(b"\xff\xff\xff\xff" + b"x" * 10))


def test_the_writer_refuses_to_be_reused_after_end(keys):
    k2s, _, _, _ = keys
    w = proto.SealedWriter(k2s)
    w.frame(b"a")
    w.end()
    with pytest.raises(proto.ProtocolError, match="already ended"):
        w.frame(b"b")


def test_trailing_bytes_after_end_are_refused(keys):
    k2s, _, _, _ = keys
    with pytest.raises(proto.ProtocolError, match="trailing"):
        proto.open_bytes(k2s, proto.seal_bytes(k2s, b"x") + b"\x00\x00")


# ── the file itself ──────────────────────────────────────────────────────────

def test_the_protocol_module_has_no_vocalis_imports():
    """It is copied to a machine with no Vocalis on it. An import of anything in src/ would
    work here and fail there — the worst place to find out."""
    import ast
    src = (REPO_ROOT / "satellite" / "vocalis_satellite_protocol.py").read_text(encoding="utf-8")
    local = {p.stem for p in (REPO_ROOT / "src").glob("*.py")} | {"vocalis", "tts_utils"}
    bad = []
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            bad += [a.name for a in node.names if a.name.split(".")[0] in local]
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module.split(".")[0] in local:
                bad.append(node.module)
    assert not bad, (f"the satellite protocol imports Vocalis modules {bad} — it must stay "
                     f"standalone, because the satellite folder is copied to a box that has "
                     f"no src/ on it")
