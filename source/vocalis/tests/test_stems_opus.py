"""Stem sets can contain legacy WAV, newly encoded Opus, or a mix when encoding fails.

The set name identifies each stem; its extension describes the stored representation. Readers used by the picker, swap, download, and audio routes must resolve all supported formats. Mixed storage is valid because an encode failure retains the usable WAV output.

These tests cover filename normalization, path safety, display ordering, and compatibility of existing `.wav` URLs with Opus files.
"""
from pathlib import Path

import pytest

import stems


@pytest.fixture
def cfg(tmp_path):
    class C:
        stems_dir = tmp_path / "output" / "stems"
        stem_uploads_dir = tmp_path / "uploads" / "stems"
    for d in (C.stems_dir, C.stem_uploads_dir):
        Path(d).mkdir(parents=True, exist_ok=True)
    return C


def _set(root, name, h, files, **meta):
    d = Path(root) / stems.set_ref(name, h)
    d.mkdir(parents=True, exist_ok=True)
    for f in files:
        (d / f).write_bytes(b"RIFF" + f.encode())
    stems.write_meta(d, {"h": h, "song": name, **meta})
    return d


LEGACY = ["vocals.wav", "instrumental.wav"]
FRESH = ["vocals.opus", "instrumental.opus"]
MIXED = ["vocals.opus", "instrumental.wav"]        # an instrumental whose encode failed


# ── stem_key: the normalizer everything else is built on ─────────────────────

@pytest.mark.parametrize("given, want", [
    ("vocals", "vocals"),
    ("vocals.wav", "vocals"),
    ("vocals.opus", "vocals"),
    ("instrumental.wav", "instrumental"),
    ("VOCALS.WAV", ""),                 # names are lower-case on disk; we do not guess
    ("vocals.mp3", "vocals"),           # a container we accept elsewhere still names the stem
    ("", ""),
    ("nonsense", ""),
    ("nonsense.wav", ""),
])
def test_stem_key_normalizes_a_name_and_rejects_what_is_not_a_stem(given, want):
    assert stems.stem_key(given) == want


@pytest.mark.parametrize("evil", [
    "../../etc/passwd", "..\\..\\vocals.wav", "/etc/vocals.wav",
    "sub/vocals.wav", "vocals.wav/../../x",
])
def test_stem_key_cannot_be_walked_out_of_the_set(evil):
    """🔴 `stem_file` is the audio route's only door and its argument comes off the URL. The
    basename is taken FIRST and the result is checked against STEM_NAMES, so a traversal cannot
    survive even in the shapes where it ends in a legal stem name."""
    assert stems.stem_key(evil) in ("", "vocals")
    # …and where it does resolve, it resolves to the BARE name — never to a path.
    assert "/" not in stems.stem_key(evil) and "\\" not in stems.stem_key(evil)


# ── the five readers, against all three shapes ───────────────────────────────

@pytest.mark.parametrize("files, label", [(LEGACY, "legacy WAV"), (FRESH, "fresh Opus"),
                                          (MIXED, "mixed")])
def test_every_reader_agrees_a_set_is_swappable_whatever_it_is_stored_as(cfg, files, label):
    d = _set(cfg.stems_dir, "Song", "a" * 32, files, source="demucs")
    assert stems.has_base(d), f"{label}: has_base said no — the picker would gray this row out"
    assert stems.satisfies(d, "2stem"), f"{label}: satisfies said no — a re-split would RUN"
    assert stems.mode_of(d) == "2stem", label
    assert {p.name for p in stems.stem_files(d)} == set(files), label
    row = stems.row(d)
    assert row["swappable"] is True, label
    assert {s["stem"] for s in row["stems"]} == {"vocals", "instrumental"}, label
    assert {s["file"] for s in row["stems"]} == set(files), label
    # The label is what the UI prints, and it must not depend on the container either.
    assert {s["label"] for s in row["stems"]} == {"Vocals", "Instrumental"}, label


def test_find_stem_prefers_opus_when_a_set_somehow_holds_both(cfg):
    """Not a shape we write, but one a half-finished migration or a hand-copied file produces.
    The order in STEM_EXTS decides it, and it must be deterministic rather than
    filesystem-order — otherwise the same set answers differently on two boxes."""
    d = _set(cfg.stems_dir, "Song", "b" * 32, ["vocals.wav", "vocals.opus",
                                               "instrumental.wav"])
    assert stems.find_stem(d, "vocals").name == "vocals.opus"
    assert stems.find_stem(d, "instrumental").name == "instrumental.wav"


def test_a_set_missing_its_vocal_is_still_not_swappable(cfg):
    """The negative case, so the new resolver cannot pass by finding SOMETHING. A lone
    instrumental is storable and downloadable and must stay un-swappable (§5)."""
    d = _set(cfg.stems_dir, "Backing", "c" * 32, ["instrumental.opus"], source="uploaded")
    assert not stems.has_base(d)
    assert stems.row(d)["swappable"] is False
    assert stems.find_stem(d, "vocals") is None


def test_a_four_stem_opus_set_reports_four_stem(cfg):
    d = _set(cfg.stems_dir, "Song", "d" * 32,
             ["vocals.opus", "instrumental.opus", "drums.opus", "bass.opus", "other.opus"])
    assert stems.mode_of(d) == "4stem" and stems.satisfies(d, "4stem")
    # STEM_ORDER is the DISPLAY order and it is keyed on the .wav spellings — the resolver has
    # to map through it rather than compare filenames, or the pills come out in disk order.
    assert [p.name for p in stems.stem_files(d)] == [
        "instrumental.opus", "vocals.opus", "drums.opus", "bass.opus", "other.opus"]


# ── 🔴 the compatibility guarantee ───────────────────────────────────────────

def test_a_wav_url_resolves_an_opus_file(cfg):
    """Existing URLs may end in `.wav` even after a set is encoded as Opus. Resolve the requested stem name to the format actually stored, preserving both those URLs and access to existing WAV sets.
    """
    d = _set(cfg.stems_dir, "Song", "e" * 32, FRESH, source="demucs")
    ref = d.name
    for asked in ("vocals", "vocals.wav", "vocals.opus"):
        got = stems.stem_file(cfg, ref, asked)
        assert got is not None and got.name == "vocals.opus", asked
    # …and the reverse, for the eleven sets he already has.
    old = _set(cfg.stems_dir, "Older", "f" * 32, LEGACY, source="demucs")
    for asked in ("vocals", "vocals.wav", "vocals.opus"):
        got = stems.stem_file(cfg, old.name, asked)
        assert got is not None and got.name == "vocals.wav", asked


def test_stem_file_still_refuses_what_is_not_a_stem(cfg):
    d = _set(cfg.stems_dir, "Song", "0" * 32, FRESH)
    assert stems.stem_file(cfg, d.name, "stems.yaml") is None      # the sidecar is not a stem
    assert stems.stem_file(cfg, d.name, "../stems.yaml") is None
    assert stems.stem_file(cfg, "no-such-set", "vocals") is None


# ── the encode plan, and what happens when ffmpeg says no ────────────────────

def test_encode_plan_targets_every_stem_and_skips_what_is_already_opus(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    produced = {"vocals.wav": work / "v.wav", "instrumental.wav": work / "i.wav",
                "drums.opus": work / "d.opus"}
    plan = stems.encode_plan(produced, work)
    assert {key for key, _src, _out in plan} == {"vocals", "instrumental"}
    assert all(out.parent == work and out.suffix == ".opus" for _k, _s, out in plan)


def test_a_stem_whose_encode_failed_keeps_its_wav(tmp_path):
    """🔴 THE COMPRESSION IS AN OPTIMIZATION AND THE AUDIO IS THE JOB. Demucs has already run —
    twenty minutes of GPU — so a set that cannot be encoded is committed as WAV rather than
    lost. The result is a MIXED set, which every reader above is pinned against."""
    work = tmp_path / "work"
    work.mkdir()
    produced = {"vocals.wav": work / "v.wav", "instrumental.wav": work / "i.wav"}
    plan = stems.encode_plan(produced, work)
    (work / "vocals.opus").write_bytes(b"OggS")            # this one encoded
    # …and `instrumental.opus` was never written, i.e. ffmpeg failed on it.
    out = stems.encoded_produced(produced, plan)
    assert out == {"vocals.opus": work / "vocals.opus",
                   "instrumental.wav": work / "i.wav"}


def test_the_encode_command_is_opus_at_the_agreed_bitrate(tmp_path):
    cmd = stems.build_encode_cmd(tmp_path / "in.wav", tmp_path / "out.opus")
    assert cmd[0] == "ffmpeg"
    assert "libopus" in cmd and stems.STEM_BITRATE in cmd
    # 🔴 `-vn`. A Demucs WAV can carry a cover image forwarded from the source, and libopus in an
    # Ogg container refuses a video stream outright — which would fail the encode and cost the
    # compression on exactly the songs that have artwork.
    assert "-vn" in cmd
