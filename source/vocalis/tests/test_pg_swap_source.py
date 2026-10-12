"""A Playground clip is a speech source at `pg/<voice-dir>/<stem>`. `resolve_source` must classify it as speech so the existing swap pipeline uses its mono 96 kHz speech encode without adding a new source kind. The ref contains a slash, so `_PG_RE` cannot enforce traversal safety by itself; `playground_clips.clip_paths` must resolve the path and require it to remain under the library root."""
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import playground_clips
import stems
import voiceswap


@pytest.fixture
def cfg(tmp_path):
    c = voiceswap.SwapConfig(
        venv=tmp_path / "venv",
        rvc_dir=tmp_path / "rvc",
        acestep_dir=tmp_path / "acestep",
        songs_dir=tmp_path / "uploads" / "songs",
        stems_dir=tmp_path / "output" / "stems",
        stem_uploads_dir=tmp_path / "uploads" / "stems",
        library_dir=tmp_path / "output" / "voiceswap",
        work_root=tmp_path / "work",
        preview_dir=tmp_path / "previews",
        scripts_dir=REPO_ROOT / "scripts" / "voiceswap",
        song_index=tmp_path / "cache" / "song_ids.yaml",
        training_dir=tmp_path / "voice_training",
        playground_dir=tmp_path / "output" / "playground",
        queue_file=tmp_path / "voiceswap_queue.yaml",
    )
    for d in (c.rvc_dir, c.acestep_dir, c.songs_dir, c.training_dir, c.playground_dir):
        d.mkdir(parents=True, exist_ok=True)
    return c


def _seed_clip(cfg, voice="Test_Character_One", stem="sample_clip_one_a1b2c3", content=b"ID3pgclip"):
    """A finished Playground clip: an MP3 and its sidecar, in the voice's directory."""
    d = Path(cfg.playground_dir) / voice
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{stem}.mp3").write_bytes(content)
    (d / f"{stem}.yaml").write_text("name: A quiet morning\n", encoding="utf-8")
    return f"{voice}/{stem}"


# ── it resolves, and it resolves as SPEECH ───────────────────────────────────

def test_a_playground_clip_resolves_as_a_speech_source(cfg):
    ref = _seed_clip(cfg)
    src = voiceswap.resolve_source(cfg, f"pg/{ref}")
    assert src is not None
    # 🔴 `speech` is the whole integration — see the module docstring. A `pg` kind here would
    # mean a new branch in the ETA, the stage numbering, the encode and the no-backing arm.
    assert src.kind == "speech"
    assert src.ref == f"pg/{ref}"
    assert src.path == cfg.playground_dir / f"{ref}.mp3"
    assert src.path.read_bytes() == b"ID3pgclip"


def test_the_clip_is_read_where_it_lies_and_never_copied(cfg):
    """The entire reason the feature exists: no second copy of the audio anywhere."""
    ref = _seed_clip(cfg)
    before = sorted(p.name for p in cfg.training_dir.iterdir())
    src = voiceswap.resolve_source(cfg, f"pg/{ref}")
    assert src.path.parent == cfg.playground_dir / "Test_Character_One"
    assert sorted(p.name for p in cfg.training_dir.iterdir()) == before
    assert sorted(p.name for p in cfg.songs_dir.iterdir()) == []


def test_the_swap_identity_is_the_clips_content(cfg):
    """`stems_id` for speech is the clip's content hash, so the same audio converts to the same
    identity however it got here — and a re-rendered clip under the same name is a new one."""
    ref = _seed_clip(cfg)
    src = voiceswap.resolve_source(cfg, f"pg/{ref}")
    assert voiceswap.stems_id(cfg, src) == stems.song_hash(src.path)


# ── 🔴 traversal: the pattern is not the guard ───────────────────────────────

@pytest.mark.parametrize("evil", [
    "pg/../../../etc/passwd",
    "pg/../voice_training/reading.wav",
    "pg/Test_Character_One/../../../secrets",
    "pg//etc/passwd",
    "pg/..",
])
def test_a_pg_ref_cannot_be_walked_out_of_the_playground_library(cfg, evil):
    """🔴 `_PG_RE` IS `(.+)` AND MATCHES EVERY ONE OF THESE. `clip_paths` resolves the path and
    requires the library root among its parents, and it is the only thing standing here — which
    is exactly why it is pinned rather than trusted."""
    _seed_clip(cfg)
    assert voiceswap.pg_path(cfg, evil) is None
    assert voiceswap.resolve_source(cfg, evil) is None


def test_a_clip_that_is_not_there_is_not_a_source(cfg):
    _seed_clip(cfg)
    assert voiceswap.resolve_source(cfg, "pg/Test_Character_One/never_rendered") is None
    assert voiceswap.resolve_source(cfg, "pg/NoSuchVoice/sample_clip_one_a1b2c3") is None


def test_a_partial_render_is_not_convertible_in_place(cfg):
    """A partial has a sidecar but NO MP3 — its audio is still banked chunks in a workspace. It
    must fail as "that clip isn't there" HERE, not halfway down a job that has already queued."""
    d = Path(cfg.playground_dir) / "Test_Character_One"
    d.mkdir(parents=True, exist_ok=True)
    (d / "half_done_ff01.yaml").write_text("name: Half done\n", encoding="utf-8")
    assert voiceswap.resolve_source(cfg, "pg/Test_Character_One/half_done_ff01") is None


def test_an_unconfigured_playground_library_is_simply_no_source(cfg):
    """The direct-SwapConfig constructions in the older tests leave it None. That must be "no
    playground sources", never an AttributeError halfway through resolve_source."""
    ref = _seed_clip(cfg)
    cfg.playground_dir = None
    assert voiceswap.pg_path(cfg, f"pg/{ref}") is None
    assert voiceswap.resolve_source(cfg, f"pg/{ref}") is None


# ── and the other three ref kinds are untouched ──────────────────────────────

def test_the_new_pattern_does_not_swallow_the_other_refs(cfg):
    """`_PG_RE` is `(.+)` and sits in the same chain as three narrower patterns. A ref that is
    NOT a playground clip must still miss it — the order in resolve_source is what guarantees
    that, and reordering the arms is the way this breaks."""
    (cfg.training_dir / "reading.wav").write_bytes(b"RIFFspeech")
    speech = voiceswap.resolve_source(cfg, "speech/reading.wav")
    assert speech is not None and speech.ref == "speech/reading.wav"
    assert speech.path.parent == cfg.training_dir          # NOT resolved under playground/
    assert voiceswap.pg_path(cfg, "speech/reading.wav") is None
    assert voiceswap.pg_path(cfg, "uploads/song.mp3") is None
