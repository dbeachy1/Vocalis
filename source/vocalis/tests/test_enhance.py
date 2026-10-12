"""Neural bandwidth extension — the pure logic.

The behavior around measured rates is pinned here because these failure modes can otherwise
ship silently:

  * the Nyquist shortcut (a 24 kHz file needs no decode to be known band-limited)
  * "unknown" must never mean "band-limited" (a failed probe must not launch 95 minutes of GPU)
  * the probe offset must be clamped to the file (a 30 s clip probed at 120 s reads as 0 Hz)
  * scratch and cache names must be OPAQUE (a Playground clip is named after the user's prompt)
  * the cache key must cover trim and nfe (or a retrain silently reuses the wrong audio)
"""
import errno
import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import enhance  # noqa: E402
import enhance_rate  # noqa: E402


# ── the verdict ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("hz,limited", [
    (11203, True),    # representative band-limited sample in a 48 kHz container
    (12000, True),    # Chatterbox, by Nyquist
    (13312, True),
    (15137, False),   # the lossy-encoder cluster — ordinary audio, leave it alone
    (18039, False),
    (19702, False),   # enhanced
    (0,     False),   # UNKNOWN. Not a license to burn 95 minutes of GPU on a guess.
    (None,  False),
    ("",    False),
])
def test_is_band_limited(hz, limited):
    assert enhance.is_band_limited(hz) is limited


def test_threshold_sits_in_the_empty_gap():
    """14 kHz, not 16. The fixture samples cluster at 9.7–13.3 kHz (band-limited) and 15.1–19.1 kHz (full-band).
    The 14 kHz threshold lies between the groups, avoiding a near-tie."""
    crippled = [9744, 10171, 10634, 11203, 12000, 13285]
    ordinary = [15137, 15720, 15923, 16166, 18039, 19083]
    assert all(enhance.is_band_limited(h) for h in crippled)
    assert not any(enhance.is_band_limited(h) for h in ordinary)
    assert max(crippled) < enhance.FULL_BAND_HZ < min(ordinary)


# ── the probe window ────────────────────────────────────────────────────────

def test_probe_offset_is_clamped_to_short_files():
    """A 30 s clip probed at a 120 s offset decodes NOTHING -> 0 Hz -> "unknown" -> never
    enhanced. That is the bug the first real test caught, and it would have silently
    excluded every short clip from enhancement."""
    assert enhance.probe_offset(30.0, probe_seconds=5.0) <= 25.0
    assert enhance.probe_offset(4.0, probe_seconds=5.0) == 0.0     # shorter than the window
    assert enhance.probe_offset(0, probe_seconds=5.0) == 0.0       # unknown duration
    for d in (6, 20, 77, 300, 3600, 12000):
        off = enhance.probe_offset(d, probe_seconds=5.0)
        assert 0 <= off <= d - 5.0, f"offset {off} runs off the end of a {d}s file"


def test_probe_takes_a_window_from_the_middle():
    """Not the head: a render's first seconds are often a lead-in, and silence has no
    spectrum to measure."""
    assert enhance.probe_offset(3600) == pytest.approx(900.0)


# ── the cheap gate ──────────────────────────────────────────────────────────

def test_nyquist_settles_low_rates_without_decoding(monkeypatch):
    """A 24 kHz file cannot hold anything above 12 kHz — that is arithmetic, not a
    measurement. It must not cost an FFT."""
    monkeypatch.setattr(enhance, "_probe_sample_rate", lambda _p: 24000)
    monkeypatch.setattr(enhance, "_decode_window",
                        lambda *a, **k: pytest.fail("decoded a file Nyquist already settled"))
    assert enhance.measure_bandwidth("anything.mp3") == 12000
    assert enhance.is_band_limited(12000)


def test_high_rate_files_are_ambiguous_and_do_get_decoded(monkeypatch):
    """44.1/48 kHz is exactly the case ffprobe CANNOT settle: genuinely full-band, or
    something band-limited that was upsampled; sample rate alone cannot tell the difference."""
    seen = []
    monkeypatch.setattr(enhance, "_probe_sample_rate", lambda _p: 48000)
    monkeypatch.setattr(enhance, "ffprobe_duration", lambda _p: 60.0)
    monkeypatch.setattr(enhance, "_decode_window",
                        lambda *a, **k: seen.append(1) or None)
    enhance.measure_bandwidth("upsampled.wav")
    assert seen, "a 48 kHz file must be decoded — its container proves nothing"


def test_unreadable_file_is_unknown_not_band_limited(monkeypatch):
    monkeypatch.setattr(enhance, "_probe_sample_rate", lambda _p: 0)
    assert enhance.measure_bandwidth("gone.wav") == 0
    assert not enhance.is_band_limited(0)


# ── the sidecar cache ───────────────────────────────────────────────────────

def test_cache_hit_does_not_touch_the_audio(tmp_path, monkeypatch):
    p = tmp_path / "clip.wav"
    p.write_bytes(b"x" * 100)
    st = p.stat()
    meta = {"bandwidth_hz": 19702, "bandwidth_size": st.st_size,
            "bandwidth_mtime": int(st.st_mtime)}
    monkeypatch.setattr(enhance, "measure_bandwidth",
                        lambda *a, **k: pytest.fail("re-measured a file that had not changed"))
    hz, fresh = enhance.bandwidth_of(p, meta)
    assert hz == 19702
    assert fresh == {}, "a cache hit must write nothing — a listing does no I/O"


def test_cache_is_invalidated_when_the_file_changes(tmp_path, monkeypatch):
    p = tmp_path / "clip.wav"
    p.write_bytes(b"x" * 100)
    stale = {"bandwidth_hz": 12000, "bandwidth_size": 999999, "bandwidth_mtime": 1}
    monkeypatch.setattr(enhance, "measure_bandwidth", lambda *a, **k: 19702)
    hz, fresh = enhance.bandwidth_of(p, stale)
    assert hz == 19702
    assert fresh["bandwidth_hz"] == 19702
    assert fresh["bandwidth_size"] == p.stat().st_size


def test_missing_sidecar_measures_and_returns_fields_to_persist(tmp_path, monkeypatch):
    """The self-healing case, and the one that matters for the two clips enhanced by hand
    outside Vocalis: no sidecar at all -> measure -> write."""
    p = tmp_path / "hand_enhanced.wav"
    p.write_bytes(b"x" * 100)
    monkeypatch.setattr(enhance, "measure_bandwidth", lambda *a, **k: 19702)
    hz, fresh = enhance.bandwidth_of(p, {})
    assert hz == 19702
    assert set(fresh) == {"bandwidth_hz", "bandwidth_size", "bandwidth_mtime"}


def test_we_cache_the_measurement_not_the_verdict(tmp_path, monkeypatch):
    """FULL_BAND_HZ is a judgment call that MOVES — it went 16000 -> 14000 an hour after
    it was written. Every verdict cached as a bool would now be silently wrong. Every
    measurement cached as Hz is still right."""
    p = tmp_path / "c.wav"
    p.write_bytes(b"x")
    monkeypatch.setattr(enhance, "measure_bandwidth", lambda *a, **k: 15000)
    _, fresh = enhance.bandwidth_of(p, {})
    assert "bandwidth_hz" in fresh
    assert not any(isinstance(v, bool) for v in fresh.values()), \
        "storing a bool bakes today's threshold into the cache forever"


# ── opaque names (5.0 §8.3) ─────────────────────────────────────────────────

def _prompt_named_clip(tmp_path):
    """Exactly what "Send to Voice Training" hands us: a Playground clip whose FILENAME is
    the user's prompt (playground_clips.clip_stem → safe_name(text[:120]))."""
    p = tmp_path / "She_told_him_the_truth_about_the_murder_a1b2c3d4.mp3"
    p.write_bytes(b"x" * 10)
    return p


def test_scratch_name_never_leaks_the_source_name(tmp_path):
    cfg = enhance.EnhanceConfig(python=Path("py"), script=Path("s"), scratch=tmp_path)
    src = _prompt_named_clip(tmp_path)
    out = enhance.scratch_path(cfg, src, tag="prep")
    assert "murder" not in out.name and "told" not in out.name
    assert out.suffix == ".wav"
    assert out.parent == tmp_path


def test_cache_name_never_leaks_the_source_name(tmp_path, monkeypatch):
    monkeypatch.setattr("tts_utils.cache_root", lambda: tmp_path)
    src = _prompt_named_clip(tmp_path)
    out = enhance.cache_path(src, nfe=32)
    assert "murder" not in out.name and "told" not in out.name
    assert out.suffix == ".wav"


def test_scratch_name_matches_the_vault_construction(tmp_path):
    """vault.decrypt_to_scratch uses sha256(...)[:16] + suffix. Ours must be
    indistinguishable from it on disk, or 5.0's M3 has two conventions to reconcile."""
    cfg = enhance.EnhanceConfig(python=Path("py"), script=Path("s"), scratch=tmp_path)
    out = enhance.scratch_path(cfg, Path("/x/y.mp3"), tag="t")
    stem = out.name[:-len(".wav")]
    assert len(stem) == 16 and all(c in "0123456789abcdef" for c in stem)


def test_scratch_names_are_distinct_per_source_and_tag(tmp_path):
    cfg = enhance.EnhanceConfig(python=Path("py"), script=Path("s"), scratch=tmp_path)
    a = enhance.scratch_path(cfg, Path("/x/a.mp3"), tag="prep|job1")
    b = enhance.scratch_path(cfg, Path("/x/b.mp3"), tag="prep|job1")
    c = enhance.scratch_path(cfg, Path("/x/a.mp3"), tag="prep|job2")
    assert len({a, b, c}) == 3, "two concurrent jobs must not collide on one scratch file"


# ── the enhanced-audio cache key ────────────────────────────────────────────

def test_cache_key_covers_nfe_and_trim(tmp_path, monkeypatch):
    """Both change the OUTPUT. A key that ignored them would hand a retrain the wrong
    audio — silently, and with no way to notice."""
    monkeypatch.setattr("tts_utils.cache_root", lambda: tmp_path)
    src = tmp_path / "a.wav"
    src.write_bytes(b"x" * 10)
    base = enhance.cache_path(src, nfe=32, trim_s=3600)
    assert enhance.cache_path(src, nfe=16, trim_s=3600) != base, "nfe must be in the key"
    assert enhance.cache_path(src, nfe=32, trim_s=None) != base, "trim must be in the key"
    assert enhance.cache_path(src, nfe=32, trim_s=3600) == base, "the key must be stable"


def test_cache_key_changes_when_the_source_changes(tmp_path, monkeypatch):
    monkeypatch.setattr("tts_utils.cache_root", lambda: tmp_path)
    src = tmp_path / "a.wav"
    src.write_bytes(b"x" * 10)
    before = enhance.cache_path(src, nfe=32)
    src.write_bytes(b"y" * 5000)                  # different size
    assert enhance.cache_path(src, nfe=32) != before


# ── the knobs ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,want", [
    (8, 8), (16, 16), (32, 32),
    ("16", 16),
    (64, enhance.NFE_DEFAULT),        # measured: no better than 32, and 2.3x the cost
    (0, enhance.NFE_DEFAULT),
    (-1, enhance.NFE_DEFAULT),
    (None, enhance.NFE_DEFAULT),
    ("banana", enhance.NFE_DEFAULT),
])
def test_validate_nfe(raw, want):
    assert enhance.validate_nfe(raw) == want


@pytest.fixture
def timed_box(tmp_path, monkeypatch):
    """A box that has enhanced something once, at 32 steps — so it HAS a rate.

    The fixture records separate startup and compute measurements. Assertions below use those
    observations rather than constants read back from the implementation.
    """
    monkeypatch.setattr(enhance_rate, "cache_root", lambda: tmp_path)
    monkeypatch.setattr(enhance, "_gpu_name", lambda: "AMD Radeon Graphics")
    enhance_rate.record(enhance_rate.key_for("AMD Radeon Graphics", 32),
                        audio_s=120.0, compute_s=32.53, startup_s=5.87)
    return tmp_path


def test_an_untimed_box_has_no_estimate_at_all(tmp_path, monkeypatch):
    """A rate measured on one GPU is not a default for another. Before this device has
    enhanced anything, the honest answer is None — and every caller must render it as such
    rather than reach for a default."""
    monkeypatch.setattr(enhance_rate, "cache_root", lambda: tmp_path)
    monkeypatch.setattr(enhance, "_gpu_name", lambda: "NVIDIA GeForce RTX 4090")
    assert enhance.estimate_seconds(3600, 32) is None
    assert enhance.measured(32) is None
    assert enhance.eta_note(None) == enhance.NO_ESTIMATE


def test_estimate_reproduces_what_the_hardware_actually_did(timed_box):
    """Load and compute are measured separately; these representative observations verify
    the estimate includes both components."""
    assert enhance.estimate_seconds(30, 32) == pytest.approx(14.0, abs=1.0)
    assert enhance.estimate_seconds(120, 32) == pytest.approx(38.4, abs=1.5)
    assert enhance.estimate_seconds(3600, 32) / 60 == pytest.approx(16, abs=2)


def test_a_step_count_this_box_never_ran_has_no_estimate(timed_box):
    """Only the configured step count has a measured rate. Do not extrapolate a rate to an
    unmeasured setting."""
    assert enhance.estimate_seconds(120, 32) is not None
    assert enhance.estimate_seconds(120, 8) is None
    assert enhance.estimate_seconds(120, 16) is None


def test_estimate_charges_the_model_load_per_file(timed_box):
    """~21 GB is loaded once per run_enhance call, so N files pay it N times. On a
    25-second Playground clip the load is about HALF the wall clock, so leaving it out
    does not shave a rounding error off the quote — it nearly halves it."""
    startup, rate = enhance.measured(32)
    one = enhance.estimate_seconds(25, 32, files=1)
    rate_only = 25 * rate
    assert one == pytest.approx(startup + rate_only, abs=0.5)
    assert rate_only / one < 0.6, "the model load is ~half a short clip's cost, not noise"
    # Ten chapters pay ten loads.
    ten = enhance.estimate_seconds(600, 32, files=10)
    assert ten - enhance.estimate_seconds(600, 32, files=1) == pytest.approx(9 * startup)


def test_estimate_only_divides_by_cards_it_can_actually_use(timed_box):
    """Two cards halve the wall clock only when there are two INDEPENDENT files to spread.
    One file runs on one card, and the UI must not promise a speed-up it cannot deliver."""
    assert enhance.estimate_seconds(3600, 32, cards=2) == \
        pytest.approx(enhance.estimate_seconds(3600, 32) / 2)
    assert enhance.estimate_seconds(3600, 32, cards=0) == enhance.estimate_seconds(3600, 32)


@pytest.mark.parametrize("seconds,want", [
    (0, "0s"), (13, "13s"), (89, "89s"),          # never "~0 min" — that reads as a bug
    (90, "2 min"), (981, "16 min"),               # an hour of audio at 32 steps
    (5400, "1.5 h"), (4914, "1.4 h"),             # a 10-hour book on two cards
])
def test_eta_str_never_rounds_a_real_wait_to_zero(seconds, want):
    assert enhance.eta_str(seconds) == want


# ── the child process ───────────────────────────────────────────────────────

def test_enhance_cmd_is_path_in_path_out():
    """It knows nothing about the vault — the caller owns decrypt/encrypt."""
    cfg = enhance.EnhanceConfig(python=Path("/v/bin/python"),
                                script=Path("/s/enhance_audio.py"), scratch=Path("/t"))
    cmd = enhance.build_enhance_cmd(cfg, Path("/t/in.wav"), Path("/t/out.wav"), nfe=32,
                                    device="cuda:1")
    # str(Path) is platform-native (backslashes on Windows), so compare as Paths.
    assert Path(cmd[0]) == Path("/v/bin/python")
    assert Path(cmd[1]) == Path("/s/enhance_audio.py")
    assert Path(cmd[cmd.index("-i") + 1]) == Path("/t/in.wav")
    assert Path(cmd[cmd.index("-o") + 1]) == Path("/t/out.wav")
    assert Path(cmd[cmd.index("--model-dir") + 1]) == enhance.DEFAULT_ENHANCE_MODEL_DIR
    assert cmd[cmd.index("--nfe") + 1] == "32"
    # _card_env made the chosen card the ONLY visible one, so the child addresses it as
    # cuda:0 whichever physical card we picked. Passing cuda:1 through would find nothing.
    assert cmd[cmd.index("--device") + 1] == "cuda:0"


def test_enhance_cmd_honors_cpu():
    cfg = enhance.EnhanceConfig(python=Path("py"), script=Path("s"), scratch=Path("t"))
    cmd = enhance.build_enhance_cmd(cfg, Path("i"), Path("o"), device="cpu")
    assert cmd[cmd.index("--device") + 1] == "cpu"


def test_run_enhance_keeps_rocm_chatter_out_of_the_users_log(tmp_path):
    """A perfectly good enhance run looked like a crash.

    Every torch child can print "(null): No such file or directory" three times — the
    libdrm probe, with the path rendered as a null pointer. NOISE_MARKERS matched the
    variant that names the path and missed this one, so three lines of a missing-file error
    landed in the job log of an otherwise successful run and looked like a failure.

    So the pump is driven for real here: a stand-in child prints those bytes,
    and only the line that means something is allowed through.
    """
    child = tmp_path / "child.py"
    child.write_text(
        "print('(null): No such file or directory')\n"
        "print('(null): No such file or directory')\n"
        "print('MIOpen(HIP): Warning [ParseDevName] Unknown device')\n"
        "print('24000 Hz -> 44100 Hz | 24.4s | nfe=32')\n"
        "open(__import__('sys').argv[__import__('sys').argv.index('-o') + 1], 'w').close()\n",
        encoding="utf-8")
    cfg = enhance.EnhanceConfig(python=Path(sys.executable), script=child, scratch=tmp_path)

    seen = []
    rc = enhance.run_enhance(cfg, tmp_path / "in.wav", tmp_path / "out.wav",
                             device="cpu", on_line=seen.append)

    assert rc == 0
    assert seen == ["24000 Hz -> 44100 Hz | 24.4s | nfe=32"]
    assert not any("No such file or directory" in ln for ln in seen)


def test_a_real_missing_file_still_reaches_the_user(tmp_path):
    """The counterpart, and the reason the marker is the WHOLE literal rather than a bare
    "No such file or directory": a genuine missing file NAMES the file. Swallowing that
    whole class of error to silence the ROCm probe is how a real failure goes silent."""
    child = tmp_path / "child.py"
    child.write_text(
        "print('/models/enhancer.pt: No such file or directory')\n"
        "raise SystemExit(1)\n", encoding="utf-8")
    cfg = enhance.EnhanceConfig(python=Path(sys.executable), script=child, scratch=tmp_path)

    seen = []
    rc = enhance.run_enhance(cfg, tmp_path / "in.wav", tmp_path / "out.wav",
                             device="cpu", on_line=seen.append)

    assert rc == 1
    assert seen == ["/models/enhancer.pt: No such file or directory"]


def test_unavailable_when_the_toolchain_is_not_installed(tmp_path):
    """Training REFUSES to run on band-limited audio, so this is what turns a cryptic
    FileNotFoundError three stages in into a sentence that says run setup.sh."""
    cfg = enhance.EnhanceConfig(python=tmp_path / "nope" / "python",
                                script=tmp_path / "nope.py", scratch=tmp_path)
    assert cfg.available is False
    assert "missing from this image" in cfg.unavailable_reason


def _write_enhance_snapshot(root):
    run_dir = root / enhance.ENHANCE_MODEL_REVISION / "enhancer_stage2"
    for name in enhance.ENHANCE_MODEL_FILES:
        path = run_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fixture")
    return run_dir


def test_enhance_availability_requires_the_complete_pinned_snapshot(tmp_path):
    py = tmp_path / "venv" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text("")
    script = tmp_path / "enhance_audio.py"
    script.write_text("")
    run_dir = _write_enhance_snapshot(tmp_path / "models")
    cfg = enhance.EnhanceConfig(python=py, script=script, scratch=tmp_path,
                                model_dir=run_dir)

    assert cfg.model_ready and cfg.available
    (run_dir / "ds" / "G" / "latest").unlink()
    assert not cfg.model_ready and not cfg.available
    assert cfg.model_missing_files == ("ds/G/latest",)
    assert "pinned Resemble Enhance model snapshot is incomplete" in cfg.unavailable_reason


def test_enhance_unavailable_reason_reports_missing_model(tmp_path, monkeypatch):
    from vocalis.runtime import enhancement as runtime_enhancement

    cfg = enhance.EnhanceConfig(
        python=tmp_path / "venv" / "bin" / "python",
        script=tmp_path / "enhance_audio.py",
        scratch=tmp_path,
        model_dir=tmp_path / enhance.ENHANCE_MODEL_REVISION / "enhancer_stage2")
    cfg.python.parent.mkdir(parents=True)
    cfg.python.write_text("")
    cfg.script.write_text("")
    monkeypatch.setattr(runtime_enhancement.configs, "enhance_cfg", lambda: cfg)

    reason = runtime_enhancement.enhance_unavailable_reason()
    assert "pinned Resemble Enhance model snapshot is incomplete" in reason
    assert "hparams.yaml" in reason
    assert "missing from this image" not in reason
    assert "setup command again" in reason


# ── the encode (DESIGN §7 — the correction that mattered) ────────────────────

def test_enhanced_speech_encodes_at_256k_not_192k():
    """Enhancement DOUBLES the bandwidth the encoder has to pay for, so the same bitrate
    stretches half as far. This file first said 192k — a number written before the
    measurement, which then put enhanced speech at 41.9 dB while 256k reaches 49.8 dB.
    96k stays right for un-enhanced Chatterbox: there is nothing above 11 kHz to lose."""
    assert enhance.mp3_bitrate(True) == "256k"
    assert enhance.mp3_bitrate(False) == "96k"
    assert enhance.MP3_BITRATE_ENHANCED == "256k"


def test_speech_bitrates_are_never_the_music_one():
    """voiceswap.MP3_BITRATE is 320k STEREO and answers a different question. Routing
    speech through it would double the file for a channel that carries nothing; routing
    MUSIC through here would throw a whole channel away (and SNR would call that an
    IMPROVEMENT — 50.7 dB mono vs 35.9 stereo — precisely because it deleted half the
    recording, DESIGN §7)."""
    import voiceswap
    assert voiceswap.MP3_BITRATE == "320k"
    assert enhance.mp3_bitrate(True) != voiceswap.MP3_BITRATE


# ── the identity seam (5.0 §7.7.2) ──────────────────────────────────────────
#
# The cache key is (path, size, mtime, nfe, trim), and encryption moves all three of the
# first ones: ciphertext is larger, migration rewrites every mtime, name-encryption changes
# the path. So the key had to stop being os.stat() of the bytes on disk and start being a
# question about the LOGICAL file — one seam (source_stat/source_key) that M6/M7 repoints at
# the vault, and nothing else in the track changes.
#
# Preserve the existing cache key while changing the path lookup. Changing the key would make
# every cached result unreachable and trigger unnecessary re-enhancement.

def test_the_seam_did_not_move_the_cache_key(tmp_path, monkeypatch):
    """THE REGRESSION GUARD. Pinned against the formula as it stood BEFORE the seam
    (enhance.py, pre-5.0-M2.5b) — recomputed here by hand, not read back from the code, so
    this test cannot agree with a mistake."""
    monkeypatch.setattr("tts_utils.cache_root", lambda: tmp_path)

    src = tmp_path / "Tell_me_a_secret.mp3"
    src.write_bytes(b"x" * 1234)
    st = src.stat()

    # the ORIGINAL construction, spelled out:
    ident = f"{src.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    key = f"{ident}|nfe=32|trim=0"
    expected = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24] + ".wav"

    assert enhance.cache_path(src, 32, None).name == expected


def test_source_key_falls_back_to_the_path_when_the_file_is_gone(tmp_path):
    """A missing file used to key on str(p) alone, so an entry minted then must still
    resolve. Preserved deliberately."""
    gone = tmp_path / "not_here.mp3"
    assert enhance.source_key(gone) == str(gone)
    assert enhance.source_stat(gone) is None


def test_source_stat_is_the_one_answer_the_cache_and_the_sidecar_share(tmp_path):
    src = tmp_path / "a.mp3"
    src.write_bytes(b"hello")
    size, mtime = enhance.source_stat(src)
    assert size == 5
    assert enhance.source_key(src) == f"{src.resolve()}|{size}|{mtime}"


# ── the plaintext→store boundary (5.0 §7.7.1) ───────────────────────────────
#
# The enhancer used to write its output straight into cache_root() — a child process writing
# plaintext audio directly into what 5.0 encrypts, the only such seam in the app. Now it
# writes scratch and store_cache lands it. Under 5.0 store_cache's body becomes
# vault.encrypt_from_scratch and NOTHING ELSE in the track changes.

def test_store_cache_lands_the_file_and_leaves_no_part(tmp_path):
    tmp = tmp_path / "scratch" / "abc.wav"
    tmp.parent.mkdir()
    tmp.write_bytes(b"RIFFdata")
    dst = tmp_path / "cache" / "enhanced" / "deadbeef.wav"

    enhance.store_cache(tmp, dst)

    assert dst.read_bytes() == b"RIFFdata"
    assert not tmp.exists(), "the scratch plaintext outlived the land"
    assert not list(dst.parent.glob("*.part")), "a .part was orphaned in the cache"


def test_store_cache_survives_a_cross_filesystem_scratch(tmp_path, monkeypatch):
    """os.replace across filesystems is EXDEV, and 5.0 §8.2 wants scratch on a
    boot-ephemeral mount — i.e. a DIFFERENT filesystem from the cache, always. Discovering
    that at the last step of a sixteen-minute job is not acceptable."""
    real_replace = __import__("os").replace
    calls = {"n": 0}

    def exdev_once(a, b):
        calls["n"] += 1
        if calls["n"] == 1:                       # the scratch → .part move
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return real_replace(a, b)

    monkeypatch.setattr(enhance.os, "replace", exdev_once)

    tmp = tmp_path / "scratch" / "abc.wav"
    tmp.parent.mkdir()
    tmp.write_bytes(b"RIFFdata")
    dst = tmp_path / "cache" / "deadbeef.wav"

    enhance.store_cache(tmp, dst)

    assert dst.read_bytes() == b"RIFFdata"
    assert not tmp.exists()
    assert not list(dst.parent.glob("*.part"))


def test_a_failed_land_leaves_no_half_written_cache_entry(tmp_path, monkeypatch):
    """Every caller treats `cached.is_file()` as 'this entry is complete' and skips a
    GPU-hour on it. A half-written WAV in the cache would be reused forever."""
    def boom(a, b):
        raise OSError(errno.EIO, "disk went away")

    monkeypatch.setattr(enhance.os, "replace", boom)

    tmp = tmp_path / "abc.wav"
    tmp.write_bytes(b"RIFFdata")
    dst = tmp_path / "cache" / "deadbeef.wav"

    with pytest.raises(OSError):
        enhance.store_cache(tmp, dst)

    assert not dst.exists(), "a failed land left a cache entry that callers will trust"
    assert not list(dst.parent.glob("*.part"))


def test_resolve_config_python_goes_through_venv_python(tmp_path, monkeypatch):
    """The enhance venv's interpreter must come from engine_process.venv_python, or on Windows
    (where scripts/enhance/setup.bat builds `Scripts/python.exe`) enhancement reads as never
    installed. Compare against the shared helper so the expected interpreter path is platform-correct."""
    import engine_process
    monkeypatch.delenv("VOCALIS_ENHANCE_VENV", raising=False)
    monkeypatch.delenv("VOCALIS_ENHANCE_MODEL_DIR", raising=False)
    cfg = enhance.resolve_config({}, base_dir=tmp_path)
    assert cfg.python == engine_process.venv_python(enhance.DEFAULT_ENHANCE_VENV)
    assert cfg.model_dir == enhance.DEFAULT_ENHANCE_MODEL_DIR
    cfg = enhance.resolve_config({"enhance": {"venv": str(tmp_path / "ev")}}, base_dir=tmp_path)
    assert cfg.python == engine_process.venv_python(tmp_path / "ev")
    model_dir = tmp_path / enhance.ENHANCE_MODEL_REVISION / "enhancer_stage2"
    cfg = enhance.resolve_config({"enhance": {"model_dir": str(model_dir)}}, base_dir=tmp_path)
    assert cfg.model_dir == model_dir
    env_dir = tmp_path / "env-model" / enhance.ENHANCE_MODEL_REVISION / "enhancer_stage2"
    monkeypatch.setenv("VOCALIS_ENHANCE_MODEL_DIR", str(env_dir))
    cfg = enhance.resolve_config({"enhance": {"model_dir": str(model_dir)}}, base_dir=tmp_path)
    assert cfg.model_dir == env_dir
