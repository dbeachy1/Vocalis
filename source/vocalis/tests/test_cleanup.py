"""Pure orchestration tests for the cleanup parent (`src/cleanup.py`).

The scorer and denoise children are covered separately. These tests pin pass identity, naming,
and validation so reruns do not create duplicate variants or overwrite an existing clip.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

import cleanup
import engine_process


# ── passes are validated and clamped, not trusted ────────────────────────────

def test_normalize_clamps_wet_and_atten():
    p = cleanup.normalize_passes({"denoise": {"enabled": True, "wet": 1.7, "atten": -3}})
    assert p["denoise"]["wet"] == 1.0            # clamped into [0, 1]
    assert p["denoise"]["atten"] == 0.0          # a negative cap is a typo → full strength


def test_normalize_coerces_types_and_bools():
    p = cleanup.normalize_passes({"trim": {"enabled": 1, "max_excess_db": "9"},
                                  "denoise": {"enabled": 0, "wet": "0.4"}})
    assert p["trim"]["enabled"] is True and p["trim"]["max_excess_db"] == 9.0
    assert p["denoise"]["enabled"] is False and p["denoise"]["wet"] == 0.4


def test_normalize_survives_garbage_numbers():
    p = cleanup.normalize_passes({"denoise": {"enabled": True, "wet": "x", "atten": None}})
    assert p["denoise"]["wet"] == cleanup.DEFAULT_PRESET["denoise"]["wet"]   # falls to default
    assert p["denoise"]["atten"] == 0.0


# ── the default preset (§3.1: one cleaned clip per source) ───────────────────

def test_the_default_preset_is_default():
    assert cleanup.is_default_preset(cleanup.DEFAULT_PRESET)
    assert cleanup.is_default_preset({"denoise": {"enabled": True, "wet": 1.0, "atten": 0.0}})


def test_changing_a_knob_is_not_the_default():
    assert not cleanup.is_default_preset(
        {"denoise": {"enabled": True, "wet": 0.7, "atten": 0.0}})
    assert not cleanup.is_default_preset(
        {"trim": {"enabled": True, "max_excess_db": 6.0},
         "denoise": {"enabled": True, "wet": 1.0, "atten": 0.0}})


# ── the effective-settings key: a disabled pass contributes nothing ──────────

def test_disabled_pass_does_not_enter_the_key():
    a = cleanup._passes_key({"trim": {"enabled": False, "max_excess_db": 6.0},
                             "denoise": {"enabled": True, "wet": 1.0, "atten": 0.0}})
    b = cleanup._passes_key({"denoise": {"enabled": True, "wet": 1.0, "atten": 0.0}})
    assert a == b


def test_settings_tag_is_stable_short_and_settings_only(tmp_path):
    """Six hex chars, deterministic, and independent of the source — so re-cleaning a re-saved
    file with the same knobs overwrites the same variant."""
    p = {"denoise": {"enabled": True, "wet": 0.7, "atten": 0.0}}
    tag = cleanup.settings_tag(p)
    assert len(tag) == 6 and all(c in "0123456789abcdef" for c in tag)
    assert cleanup.settings_tag(p) == tag                                   # deterministic
    assert cleanup.settings_tag({"denoise": {"enabled": True, "wet": 0.4}}) != tag


# ── cleanup_hash: source identity + settings ─────────────────────────────────

def test_cleanup_hash_depends_on_source_and_settings(tmp_path):
    f = tmp_path / "clip.wav"
    f.write_bytes(b"x" * 100)
    h1 = cleanup.cleanup_hash(f, cleanup.DEFAULT_PRESET)
    h2 = cleanup.cleanup_hash(f, {"denoise": {"enabled": True, "wet": 0.4}})
    assert h1 != h2 and len(h1) == 16
    f.write_bytes(b"y" * 200)                    # source changed → identity changed
    assert cleanup.cleanup_hash(f, cleanup.DEFAULT_PRESET) != h1


def test_cleanup_hash_of_an_unidentifiable_source_is_None_not_a_fabricated_id():
    """🔴 M10 §4.2 C4 — this test used to assert the BUG: that a source it could not stat still
    got a hash, built by `except OSError: ident = str(p)` from the path ALONE.

    That is not a lenient fallback, it is a wrong answer. Drop size and mtime and the identity
    stops describing the FILE and starts describing its NAME — so a clip re-recorded at the same
    path hashes identically to the one it replaced, and Clean up answers "already done" with the
    cleaning of audio that no longer exists. Encryption turns that from a rare case into the
    only case: `voice_training/` is routed, so the bare `p.stat()` raised every single time.

    None means "this source has no identity", the caller omits the key rather than recording a
    non-answer, and nothing downstream can mistake two unknowns for a match."""
    assert cleanup.cleanup_hash("/no/such/file.wav", cleanup.DEFAULT_PRESET) is None


# ── output naming (§3.1) ─────────────────────────────────────────────────────

def test_default_output_is_the_plain_cleaned_name():
    assert cleanup.output_stem("reading", cleanup.DEFAULT_PRESET) == "reading.cleaned"


def test_a_variant_output_carries_a_settings_tag():
    p = {"denoise": {"enabled": True, "wet": 0.7, "atten": 0.0}}
    stem = cleanup.output_stem("reading", p)
    assert stem.startswith("reading.cleaned.") and stem.endswith(cleanup.settings_tag(p))


def test_multiple_takes_are_numbered():
    p = {"trim": {"enabled": True, "max_excess_db": 6.0},
         "denoise": {"enabled": True, "wet": 1.0, "atten": 0.0}}
    s1 = cleanup.output_stem("reading", p, take_idx=1)
    s2 = cleanup.output_stem("reading", p, take_idx=2)
    assert s1.endswith(".take01") and s2.endswith(".take02") and s1 != s2


def test_output_stem_sanitizes_the_source_name():
    """A weird character in the source name must not reach a new file."""
    stem = cleanup.output_stem("../evil name", cleanup.DEFAULT_PRESET)
    assert "/" not in stem and ".." not in stem and stem.endswith(".cleaned")


# ── scratch is opaque (5.0 §8.3) ─────────────────────────────────────────────

def test_scratch_path_is_opaque_and_deterministic(tmp_path):
    cfg = cleanup.CleanupConfig(denoise_python=Path("x"), denoise_script=Path("y"),
                                trim_script=Path("z"), scratch=tmp_path)
    p1 = cleanup.scratch_path(cfg, "my_secret_prompt.wav", tag="den")
    p2 = cleanup.scratch_path(cfg, "my_secret_prompt.wav", tag="den")
    assert p1 == p2                                          # deterministic
    assert "my_secret_prompt" not in p1.name                # no source name leaks
    assert p1.parent == tmp_path and p1.suffix == ".wav"


# ── the denoise command (path in, path out) ──────────────────────────────────

def test_build_denoise_cmd_shape():
    cfg = cleanup.CleanupConfig(denoise_python=Path("/v/py"),
                                denoise_script=Path("/s/denoise_dfn.py"),
                                trim_script=Path("/s/trim_audio.py"), scratch=Path("/t"))
    cmd = cleanup.build_denoise_cmd(cfg, "in.wav", "out.wav", wet=1.0, atten=0.0)
    assert Path(cmd[0]) == Path("/v/py") and Path(cmd[1]).name == "denoise_dfn.py"
    assert "-i" in cmd and "in.wav" in cmd and "out.wav" in cmd
    assert "--wet" in cmd and "--device" in cmd
    assert cmd[cmd.index("--model-dir") + 1] == str(cleanup.DEFAULT_DFN_MODEL_ROOT)
    assert "--atten" not in cmd                              # omitted at 0 (full strength)


def test_build_denoise_cmd_includes_atten_when_capped():
    cfg = cleanup.CleanupConfig(denoise_python=Path("py"), denoise_script=Path("d"),
                                trim_script=Path("t"), scratch=Path("s"))
    cmd = cleanup.build_denoise_cmd(cfg, "in.wav", "out.wav", wet=1.0, atten=6.0)
    assert "--atten" in cmd and "6.0" in cmd


# ── config resolution (env → settings → default) ─────────────────────────────

def test_resolve_config_defaults_and_env(monkeypatch, tmp_path):
    monkeypatch.delenv("VOCALIS_DFN_VENV", raising=False)
    monkeypatch.delenv("VOCALIS_DFN_MODEL_ROOT", raising=False)
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    # Platform-agnostic: derive the expected path from engine_process.venv_python() for the current
    # platform instead of hardcoding a POSIX-only path tail.
    # hardcoded ("bin", "python") tail that only held on POSIX.
    assert cfg.denoise_python == engine_process.venv_python(cleanup.DEFAULT_DFN_VENV)
    assert cfg.denoise_script == tmp_path / "scripts" / "cleanup" / "denoise_dfn.py"
    assert cfg.denoise_model_root == cleanup.DEFAULT_DFN_MODEL_ROOT
    configured = tmp_path / "settings-model"
    cfg_from_settings = cleanup.resolve_config(
        {"cleanup": {"denoise_model_root": str(configured)}}, base_dir=tmp_path)
    assert cfg_from_settings.denoise_model_root == configured
    env_root = tmp_path / "env-model"
    monkeypatch.setenv("VOCALIS_DFN_MODEL_ROOT", str(env_root))
    cfg_from_env = cleanup.resolve_config(
        {"cleanup": {"denoise_model_root": str(configured)}}, base_dir=tmp_path)
    assert cfg_from_env.denoise_model_root == env_root
    monkeypatch.setenv("VOCALIS_DFN_VENV", str(tmp_path / "myvenv"))
    cfg2 = cleanup.resolve_config({}, base_dir=tmp_path)
    assert str(tmp_path / "myvenv") in str(cfg2.denoise_python)


def test_resolve_config_venv_python_windows_and_posix(monkeypatch, tmp_path):
    """`cleanup.resolve_config` builds denoise and trim-scorer interpreters through
    `engine_process.venv_python`, so this compares against that helper's current-platform result
    rather than assuming which path branch is active.
    venv_python's own default rather than assuming which branch ran. That alone is
    mutation-proof against reverting to a hardcoded 'bin'/'python' tail (the original bug:
    denoise_available/trim_scorer_available were always False on Windows). The injectable
    `windows` flag then proves the two branches are genuinely different paths, without
    monkeypatching os.name — which crashes on this pathlib (it re-derives
    WindowsPath/PosixPath from the REAL os.name on every Path(...) construction — see
    engine_process.venv_python's docstring)."""
    # The packaged image's ENV points these at its own environments; this is a test of the defaults.
    for name in ("VOCALIS_DFN_VENV", "VOCALIS_TRIM_VENV"):
        monkeypatch.delenv(name, raising=False)
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    assert cfg.denoise_python == engine_process.venv_python(cleanup.DEFAULT_DFN_VENV)
    assert cfg.trim_scorer_python == engine_process.venv_python(cleanup.DEFAULT_TRIM_VENV)
    assert (engine_process.venv_python(cleanup.DEFAULT_DFN_VENV, windows=True)
            != engine_process.venv_python(cleanup.DEFAULT_DFN_VENV, windows=False))


def test_availability_reflects_the_files(tmp_path):
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    assert cfg.denoise_available is False        # nothing installed under tmp_path
    python = tmp_path / "dfn" / "python"
    python.parent.mkdir()
    python.write_bytes(b"python")
    script = tmp_path / "scripts" / "cleanup" / "denoise_dfn.py"
    script.parent.mkdir(parents=True)
    script.write_bytes(b"script")
    local_cfg = cleanup.CleanupConfig(
        denoise_python=python,
        denoise_script=script,
        trim_script=tmp_path / "trim_audio.py",
        scratch=tmp_path / "scratch",
        denoise_model_root=tmp_path / "dfn-model",
    )
    local_cfg.denoise_model_root.mkdir()
    (local_cfg.denoise_model_root / cleanup.DFN_CONFIG).write_bytes(b"config")
    assert local_cfg.denoise_available is False  # checkpoint is required too
    checkpoint = local_cfg.denoise_model_root / cleanup.DFN_CHECKPOINT
    checkpoint.parent.mkdir()
    checkpoint.write_bytes(b"checkpoint")
    assert local_cfg.denoise_available is True
    real = cleanup.resolve_config({})            # the actual repo — trim script exists
    assert real.trim_available is True


def test_trim_scorer_available_gates_on_both_venv_and_script(tmp_path, monkeypatch):
    """The Trim scorer needs its isolated interpreter, child script and pinned local model."""
    monkeypatch.setenv("VOCALIS_TRIM_VENV", str(tmp_path / "trim-venv"))
    monkeypatch.setenv("VOCALIS_TRIM_MODEL_ROOT", str(tmp_path / "models"))
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    assert cfg.trim_scorer_script == tmp_path / "scripts" / "cleanup" / "trim_scores.py"
    assert cfg.trim_scorer_checkpoint == tmp_path / "models" / "Cnn14_mAP=0.431.pth"
    assert cfg.trim_scorer_labels == tmp_path / "models" / "class_labels_indices.csv"
    assert cfg.trim_scorer_available is False    # neither the venv python nor the script exists
    assert "environment is unavailable" in cfg.trim_scorer_unavailable_reason

    # The model root is mounted separately from the scorer environment.
    py = cfg.trim_scorer_python                    # wherever THIS box's venv_python() puts it
    py.parent.mkdir(parents=True, exist_ok=True); py.write_text("#!/bin/sh\n")
    cfg.trim_scorer_script.parent.mkdir(parents=True, exist_ok=True)
    cfg.trim_scorer_script.write_text("# child")
    assert cfg.trim_scorer_available is False
    assert "Trim scorer model is missing" in cfg.trim_scorer_unavailable_reason
    cfg.trim_scorer_checkpoint.parent.mkdir(parents=True, exist_ok=True)
    cfg.trim_scorer_checkpoint.write_bytes(b"checkpoint")
    assert "Trim scorer AudioSet labels are missing" in cfg.trim_scorer_unavailable_reason
    cfg.trim_scorer_labels.write_text("index,mid,display_name\n", encoding="utf-8")
    assert cfg.trim_scorer_available is True
    assert cfg.trim_scorer_unavailable_reason is None


def test_trim_scorer_child_command_uses_the_resolved_checkpoint(tmp_path):
    cfg = cleanup.CleanupConfig(
        denoise_python=tmp_path / "dfn" / "python",
        denoise_script=tmp_path / "denoise.py",
        trim_script=tmp_path / "trim.py",
        scratch=tmp_path / "scratch",
        trim_scorer_python=tmp_path / "trim" / "python",
        trim_scorer_script=tmp_path / "trim_scores.py",
        trim_model_root=tmp_path / "models")
    cmd = cleanup.build_trim_scorer_cmd(cfg, "input.wav", "scores.json")
    assert cmd == [str(cfg.trim_scorer_python), str(cfg.trim_scorer_script), "-i", "input.wav",
                   "-o", "scores.json", "--checkpoint",
                   str(tmp_path / "models" / "Cnn14_mAP=0.431.pth"), "--labels",
                   str(tmp_path / "models" / "class_labels_indices.csv"), "--device", "cpu"]


# ── the run refuses a no-op ──────────────────────────────────────────────────

def test_run_cleanup_rejects_no_passes(tmp_path):
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    with pytest.raises(ValueError):
        cleanup.run_cleanup(cfg, tmp_path / "x.wav",
                            {"trim": {"enabled": False}, "denoise": {"enabled": False}},
                            tmp_path, "x")


def test_denoise_only_decodes_the_source_before_the_child(tmp_path, monkeypatch):
    """The child reads WAV (soundfile can't read MP3), so a denoise-only pass must decode the
    source first and hand the child the DECODED wav — not the raw (possibly MP3) source."""
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    src = tmp_path / "clip.mp3"
    src.write_bytes(b"fake-mp3")
    seen = {}

    def fake_decode(s, d):
        Path(d).parent.mkdir(parents=True, exist_ok=True)
        Path(d).write_bytes(b"wav"); seen["decoded_from"] = str(s); seen["decoded_to"] = str(d)

    def fake_denoise(cfg, s, dst, wet=1.0, atten=0.0, **k):
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        Path(dst).write_bytes(b"denoised"); seen["child_input"] = str(s); return 0

    monkeypatch.setattr(cleanup, "_decode_wav", fake_decode)
    monkeypatch.setattr(cleanup, "run_denoise", fake_denoise)
    monkeypatch.setattr(cleanup, "ffprobe_duration", lambda p: 30.0)

    outs = cleanup.run_cleanup(cfg, src, {"denoise": {"enabled": True, "wet": 1.0}},
                               tmp_path / "out", "clip")
    assert seen["decoded_from"] == str(src)              # decoded the real source
    assert seen["child_input"] == seen["decoded_to"]     # child got the wav, never the mp3
    assert len(outs) == 1 and outs[0]["path"].name == "clip.cleaned.wav"


# ── _decode_wav actually runs ffmpeg (4.4 regression) ────────────────────────
#
# The denoise-only wiring test above monkeypatches _decode_wav — deliberately, it is pinning the
# "child gets the wav, never the mp3" seam. But that left the helper itself with NO coverage, and
# it shipped broken: the atomic temp was `<name>.wav.part`, and ffmpeg chooses its OUTPUT format
# from the extension, so it refused to init a muxer at all ("Unable to choose an output format").
# Every denoise-only run died, and the trim SCORER silently degraded to the SNR-only MVP on MP3
# sources (compute_scores swallows the failure by design) — i.e. imported training clips lost the
# VAD+tagger pass without saying so. So this one exercises the REAL binary.

_FFMPEG = shutil.which("ffmpeg")


@pytest.mark.skipif(not _FFMPEG, reason="needs the real ffmpeg binary")
def test_decode_wav_really_decodes_an_mp3(tmp_path):
    """MP3 in → readable mono WAV out, via the real ffmpeg. The source is an MP3 because that is
    what `speech_sources.import_clip` stores, so it is a format both callers actually meet."""
    import soundfile as sf
    src = tmp_path / "clip.mp3"
    subprocess.run([_FFMPEG, "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    str(src), "-loglevel", "error"], check=True, capture_output=True)

    dst = tmp_path / "scratch" / "abc123.wav"          # scratch_path's shape: <hash> + .wav
    cleanup._decode_wav(src, dst)

    audio, sr = sf.read(str(dst))                       # soundfile reads it => a real WAV
    assert audio.ndim == 1                              # -ac 1: the child wants mono
    assert sr > 0 and len(audio) > 0
    assert not list(dst.parent.glob("*.part*"))         # the atomic temp was cleaned up


@pytest.mark.skipif(not _FFMPEG, reason="needs the real ffmpeg binary")
def test_decode_wav_raises_and_leaves_nothing_behind_on_garbage(tmp_path):
    """A source ffmpeg cannot read must raise (the caller decides whether to degrade or die) and
    must not leave a half-written scratch file where the next run would trust it."""
    src = tmp_path / "not-audio.mp3"
    src.write_bytes(b"this is not audio")
    dst = tmp_path / "scratch" / "def456.wav"

    with pytest.raises(RuntimeError, match="could not decode"):
        cleanup._decode_wav(src, dst)
    assert not dst.exists()
    assert not list(dst.parent.glob("*.part*")) if dst.parent.exists() else True


def test_denoise_unavailable_reason_names_the_held_model_not_a_legacy_script(tmp_path):
    """2026-10-09, M1: the DeepFilterNet3 environment is in the image and setup downloads the model,
    so missing weights mean setup has not finished. Every refusal used to say to run
    scripts/cleanup/setup*.sh, which this edition does not have, and later that the weights were
    held for their licence, which stopped being true when setup began downloading them."""
    py = tmp_path / "dfn" / "python"
    script = tmp_path / "denoise.py"
    py.parent.mkdir()
    py.write_bytes(b"")
    script.write_bytes(b"")
    cfg = cleanup.CleanupConfig(
        denoise_python=py, denoise_script=script, trim_script=tmp_path / "trim.py",
        scratch=tmp_path / "scratch", denoise_model_root=tmp_path / "models" / "dfn3")
    assert not cfg.denoise_available
    reason = cfg.denoise_unavailable_reason
    assert "model" in reason and "setup command again" in reason
    assert "licence" not in reason and "setup.sh" not in reason and "scripts/" not in reason

    model = tmp_path / "models" / "dfn3"
    (model / cleanup.DFN_CHECKPOINT).parent.mkdir(parents=True)
    (model / cleanup.DFN_CONFIG).write_bytes(b"")
    (model / cleanup.DFN_CHECKPOINT).write_bytes(b"")
    assert cfg.denoise_available and cfg.denoise_unavailable_reason == ""

    py.unlink()
    assert cfg.denoise_unavailable_reason == "The DeepFilterNet3 cleanup environment is missing from this image."


# ── the trim pass explains an empty result (October 9, 2026) ─────────────────
#
# A trim that kept nothing always said "trim dropped everything at this threshold — loosen it",
# even when the audio had never decoded, which no threshold can fix. Seen live on a 4-second
# synthetic clip; four simultaneous trims of one clip also collided on one scratch name.

def _trim_fixture(tmp_path, monkeypatch, decoded, scored):
    import types
    import numpy as np
    import trim_audio
    cfg = cleanup.resolve_config({}, base_dir=tmp_path)
    src = tmp_path / "take.wav"
    src.write_bytes(b"not read: decode is stubbed")
    monkeypatch.setattr(trim_audio, "_probe_sample_rate", lambda p: 24000)
    monkeypatch.setattr(trim_audio, "decode_mono", lambda p, sr: np.asarray(decoded, dtype=np.float32))
    monkeypatch.setattr(cleanup, "compute_scores", lambda *a, **k: None)
    regions = [types.SimpleNamespace(**r) for r in scored]
    monkeypatch.setattr(cleanup, "_build_scored", lambda *a: (regions, "snr"))
    written = []
    monkeypatch.setattr(cleanup, "_write_wav", lambda dst, audio, sr: written.append(Path(dst)))
    return cfg, src, written


def test_trim_of_audio_that_did_not_decode_is_an_error_not_a_threshold_hint(tmp_path, monkeypatch):
    cfg, src, written = _trim_fixture(tmp_path, monkeypatch, decoded=[], scored=[])
    with pytest.raises(RuntimeError, match="could not decode take.wav for trimming"):
        cleanup._trim_to_scratch(cfg, src, 24.0, 0.5)
    assert written == []


def test_trim_that_keeps_nothing_logs_each_region_against_the_thresholds(tmp_path, monkeypatch):
    region = dict(start_s=0.2, end_s=3.9, dur_s=3.7, excess_db=31.5, music_sfx=0.12, keep=False)
    cfg, src, written = _trim_fixture(tmp_path, monkeypatch, decoded=[0.1] * 96000, scored=[region])
    lines = []
    assert cleanup._trim_to_scratch(cfg, src, 24.0, 0.5, on_line=lines.append) == []
    assert written == []
    assert lines == ["trim: 4.0s decoded at 24000 Hz, scorer snr; nothing within noise 24 dB and "
                     "music/SFX 0.5: 0.2-3.9s noise +31.5 dB music/SFX 0.12"]


def test_two_trims_of_one_clip_at_one_setting_write_separate_scratch_files(tmp_path, monkeypatch):
    region = dict(start_s=0.0, end_s=1.0, dur_s=1.0, excess_db=3.0, music_sfx=None, keep=True)
    cfg, src, written = _trim_fixture(tmp_path, monkeypatch, decoded=[0.1] * 48000, scored=[region])
    first = cleanup._trim_to_scratch(cfg, src, 24.0, 0.5)
    second = cleanup._trim_to_scratch(cfg, src, 24.0, 0.5)
    assert [n for n, _ in first + second] == [1, 1]
    assert len(set(written)) == 2 and written == [first[0][1], second[0][1]]
