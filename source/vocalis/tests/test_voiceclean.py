"""Tests for voice-cleaning stages, temporary-file cleanup, audio channel handling, and user-facing status."""
import types
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from conftest import install_lead_models

import leadvocal
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.voices as rt_voices
import vocalis_server as vs
import voiceclean


def _wav(path: Path, seconds=1.0, sr=24000, freq=220.0):
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    sf.write(str(path), (0.3 * np.sin(2 * np.pi * freq * t)).astype("float32"), sr, format="WAV")
    return path


@pytest.fixture
def voices_dir(tmp_path, monkeypatch):
    d = tmp_path / "voice_samples"
    d.mkdir()
    monkeypatch.setattr(rt_paths, "VOICE_SAMPLES", d)
    return d


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


# ── the arithmetic the strip counts down ─────────────────────────────────────

def test_a_job_that_runs_neither_model_is_still_a_one_stage_job():
    """The save is always a stage. Counting only the models would start a de-reverb-only job's
    progress at 1/1 before it had done anything."""
    assert voiceclean.stage_total(True, True) == 3
    assert voiceclean.stage_total(True, False) == 2
    assert voiceclean.stage_total(False, False) == 1


# ── the route's guards ───────────────────────────────────────────────────────

def test_cleaning_an_unknown_voice_is_a_404(client, voices_dir):
    r = client.post("/voices/nope.wav/clean", json={"dereverb": True, "label": "x"})
    assert r.status_code == 404


def test_cleaning_with_neither_box_ticked_is_refused(client, voices_dir):
    _wav(voices_dir / "her.wav")
    r = client.post("/voices/her.wav/clean",
                    json={"dereverb": False, "enhance": False, "label": "Her (clean)"})
    assert r.status_code == 400
    assert "at least one" in r.get_json()["error"]


def test_cleaning_without_a_name_is_refused(client, voices_dir):
    """The copy IS its name — it has to be findable in a picker beside the original."""
    _wav(voices_dir / "her.wav")
    r = client.post("/voices/her.wav/clean", json={"dereverb": True, "label": "   "})
    assert r.status_code == 400


def test_a_name_already_in_use_is_refused_before_any_gpu_work(client, voices_dir):
    """🔴 §14.9.1 — ONE RULE, NEVER OVERWRITE. Refused at the door, so the user is told now
    rather than after two model runs."""
    _wav(voices_dir / "her.wav")
    _wav(voices_dir / "taken.wav")
    r = client.post("/voices/her.wav/clean", json={"enhance": True, "label": "taken"})
    assert r.status_code == 409
    assert "already called" in r.get_json()["error"]


def test_a_valid_request_starts_a_job(client, voices_dir, monkeypatch):
    _wav(voices_dir / "her.wav")
    started = {}

    def fake_start(src, label, *, dereverb, do_enhance):
        started.update(src=src, label=label, dereverb=dereverb, enhance=do_enhance)
        return types.SimpleNamespace(id="job1")

    monkeypatch.setattr(voiceclean, "start", fake_start)
    r = client.post("/voices/her.wav/clean",
                    json={"dereverb": True, "enhance": False, "label": "Her (dry)"})
    assert r.status_code == 202
    assert r.get_json() == {"job_id": "job1", "stages": 2}
    assert started == {"src": "her.wav", "label": "Her (dry)", "dereverb": True, "enhance": False}


def test_status_of_an_unknown_job_is_a_404(client):
    assert client.get("/voices/clean/status/nosuchjob").status_code == 404


# ── the chain, with both children stubbed ────────────────────────────────────

def _run_clean(monkeypatch, voices_dir, *, dereverb, enhance_it,
               dereverb_reason="", enhance_rc=0, label="Her (clean)"):
    """Run one job to completion synchronously and hand back (job, new_voice_path_or_None)."""
    src = _wav(voices_dir / "her.wav", freq=220.0)
    monkeypatch.setattr(voiceclean, "_pick_card", lambda prefer: "cuda:0")

    def fake_dereverb(s, dst, **kw):
        if dereverb_reason:
            return dereverb_reason
        _wav(Path(dst), freq=330.0)          # a DIFFERENT tone, so "it was used" is observable
        return ""

    def fake_enhance(cfg, s, dst, **kw):
        if enhance_rc == 0:
            _wav(Path(dst), freq=440.0)
        return enhance_rc

    monkeypatch.setattr(voiceclean, "dereverb_wav", fake_dereverb)
    monkeypatch.setattr(voiceclean.enhance, "run_enhance", fake_enhance)
    job = voiceclean.CleanJob(id="t1", src="her.wav", label=label,
                              dereverb=dereverb, enhance=enhance_it)
    voiceclean._run(job)
    made = [p for p in voices_dir.iterdir() if p.suffix == ".wav" and p.name != "her.wav"]
    assert src.exists(), "🔴 the ORIGINAL was consumed — it must never be touched"
    return job, (made[0] if made else None)


def test_both_halves_produce_a_new_voice_with_both_badges(monkeypatch, voices_dir):
    job, made = _run_clean(monkeypatch, voices_dir, dereverb=True, enhance_it=True)
    assert job.status == "done", job.error
    assert made is not None and made.name == job.voice
    side = rt_voices.read_sidecar(made)
    assert side["dereverbed"] is True and side["enhanced"] is True
    assert side["cleaned_from"] == "her.wav"
    # …and the badges the list draws come off that sidecar.
    meta = rt_voices.meta(made)
    assert meta["dereverbed"] is True and meta["enhanced"] is True


def test_a_skipped_dereverb_does_not_badge_but_still_saves(monkeypatch, voices_dir):
    """🔴 THE ASSERTION THIS FILE EXISTS FOR. The de-reverb refused (its output did not line up),
    the enhance worked, and the copy must claim exactly one of the two. Badging the request
    rather than the result would put "de-reverbed" on a clip nothing de-reverbed."""
    job, made = _run_clean(monkeypatch, voices_dir, dereverb=True, enhance_it=True,
                           dereverb_reason="de-reverb output is offset by 91 samples")
    assert job.status == "done", job.error
    side = rt_voices.read_sidecar(made)
    assert side["dereverbed"] is False and side["enhanced"] is True
    assert any("Keeping the reverb" in ln for ln in job.log), job.log


def test_when_nothing_could_be_applied_no_voice_is_created(monkeypatch, voices_dir):
    """Both halves failed, so there is nothing to save — and saving an untouched copy under a
    new name would be a voice the user has to work out is a duplicate."""
    job, made = _run_clean(monkeypatch, voices_dir, dereverb=True, enhance_it=True,
                           dereverb_reason="no", enhance_rc=3)
    assert job.status == "error" and made is None


def test_the_name_is_checked_again_at_save_time(monkeypatch, voices_dir):
    """🔴 Minutes pass between the route's check and this one — two GPU children — and in that
    window another save can take the name. This check is the guarantee; the route's is the
    courtesy."""
    _wav(voices_dir / "taken.wav")
    job, _ = _run_clean(monkeypatch, voices_dir, dereverb=False, enhance_it=True, label="taken")
    assert job.status == "error"
    assert "already called" in job.error


def test_a_copy_does_not_inherit_the_star(monkeypatch, voices_dir):
    """★ is a per-voice choice about a list, not a property of the audio. A cleaned copy
    arriving pre-starred would reorder the picker for a voice nobody has chosen yet."""
    rt_voices.write_sidecar(voices_dir / "her.wav", {"origin": "uploaded", "favorite": True})
    _, made = _run_clean(monkeypatch, voices_dir, dereverb=False, enhance_it=True)
    assert rt_voices.meta(made)["favorite"] is False


def test_a_missing_leadvocal_venv_is_a_reason_not_a_crash(tmp_path):
    """Its absence has to arrive as the skip string the job already knows how to report. The
    environment ships in the image, so the reason says the image lacks it rather than naming a
    setup script the Docker edition does not have."""
    cfg = types.SimpleNamespace(leadvocal_python=tmp_path / "nope" / "python",
                                leadvocal_detect=tmp_path / "nope" / "detect.py",
                                leadvocal_models=tmp_path)
    why = voiceclean.dereverb_wav(tmp_path / "a.wav", tmp_path / "b.wav",
                                  cfg=cfg, device="cpu", model="m.pth", work=tmp_path)
    assert "missing from this image" in why and "setup.sh" not in why
    # The reason is shown to the user: no server path in it (the path is logged instead).
    assert str(tmp_path) not in why and "python" not in why


def test_missing_separator_models_are_a_reason_and_start_no_child(tmp_path, monkeypatch):
    """audio-separator downloads any model file it cannot find. The de-reverb half must instead
    arrive as the skip string the job already reports, before the clip is staged or a child
    exists."""
    spawned = []
    monkeypatch.setattr(voiceclean.subprocess, "Popen",
                        lambda cmd, **kw: spawned.append(cmd))
    work = tmp_path / "work"
    work.mkdir()
    cfg = types.SimpleNamespace(leadvocal_python=Path(__file__),
                                leadvocal_detect=Path(__file__),
                                leadvocal_models=tmp_path / "no-models-here")
    why = voiceclean.dereverb_wav(_wav(tmp_path / "a.wav"), work / "out.wav", cfg=cfg,
                                  device="cpu", model=leadvocal.DEREVERB_DEFAULT, work=work)
    assert leadvocal.DEREVERB_DEFAULT in why and "Run setup again" in why, why
    assert spawned == [], "a child was started for a model that is not installed"
    assert list(work.iterdir()) == [], "the clip was staged for a job that could not run"


def test_two_cleanings_of_one_voice_cannot_overlap(client, voices_dir, monkeypatch):
    """Both would race for the same new name and both would take a GPU child."""
    _wav(voices_dir / "her.wav")
    live = voiceclean.CleanJob(id="live1", src="her.wav", label="x",
                               dereverb=True, enhance=False)
    monkeypatch.setattr(voiceclean, "running_for", lambda src: live if src == "her.wav" else None)
    r = client.post("/voices/her.wav/clean", json={"dereverb": True, "label": "Her (clean)"})
    assert r.status_code == 409 and r.get_json()["job_id"] == "live1"


def test_the_scratch_directory_is_removed_even_when_the_child_left_files_in_it(monkeypatch, voices_dir, tmp_path):
    """The job removes its temporary working directory even when a child leaves files behind."""
    import scratch as scratch_mod
    root = tmp_path / "scratch"
    root.mkdir()
    monkeypatch.setattr(scratch_mod, "scratch_root", lambda *a, **k: root)

    def messy_dereverb(s, dst, *, work, **kw):
        Path(work).joinpath("leftover_raw.wav").write_bytes(b"RIFF plaintext")
        _wav(Path(dst), freq=330.0)
        return ""

    _wav(voices_dir / "her.wav")
    monkeypatch.setattr(voiceclean, "_pick_card", lambda prefer: "cpu")
    monkeypatch.setattr(voiceclean, "dereverb_wav", messy_dereverb)
    job = voiceclean.CleanJob(id="t9", src="her.wav", label="Her (dry)",
                              dereverb=True, enhance=False)
    voiceclean._run(job)
    assert job.status == "done", job.error
    left = list(root.rglob("*"))
    assert not left, f"the scratch still holds {[str(p.name) for p in left]}"


def test_an_enhancer_that_raises_does_not_lose_a_dereverb_that_worked(monkeypatch, voices_dir):
    """An enhancer launch failure does not discard completed dereverb output."""
    def boom(*a, **kw):
        raise FileNotFoundError("[WinError 2] The system cannot find the file specified")

    _wav(voices_dir / "her.wav")
    monkeypatch.setattr(voiceclean, "_pick_card", lambda prefer: "cuda:0")
    monkeypatch.setattr(voiceclean, "dereverb_wav",
                        lambda s, dst, **kw: (_wav(Path(dst), freq=330.0), "")[1])
    monkeypatch.setattr(voiceclean.enhance, "run_enhance", boom)
    job = voiceclean.CleanJob(id="t8", src="her.wav", label="Her (dry)",
                              dereverb=True, enhance=True)
    voiceclean._run(job)
    assert job.status == "done", job.error
    assert job.did_dereverb is True and job.did_enhance is False
    assert any("could not run" in ln for ln in job.log), job.log


def test_the_separator_child_never_runs_on_a_path_inside_the_voice_store(tmp_path, monkeypatch):
    """Separator scratch is placed outside the persistent voice library."""
    store = tmp_path / "voice_samples"
    store.mkdir()
    src = _wav(store / "her.wav")
    work = tmp_path / "work"
    work.mkdir()
    seen = {}

    class FakeProc:
        stdout = iter(())
        def wait(self):                     # noqa: D102
            return 1
        def kill(self):                     # noqa: D102
            pass

    def fake_popen(cmd, **kw):
        seen["cmd"] = [str(c) for c in cmd]
        return FakeProc()

    monkeypatch.setattr(voiceclean.subprocess, "Popen", fake_popen)
    install_lead_models(tmp_path, "m.pth")          # the child is only started once these exist
    cfg = types.SimpleNamespace(leadvocal_python=Path(__file__),      # any file that exists
                                leadvocal_detect=Path(__file__), leadvocal_models=tmp_path)
    voiceclean.dereverb_wav(src, work / "out.wav", cfg=cfg, device="cpu",
                            model="m.pth", work=work)
    given = Path(seen["cmd"][seen["cmd"].index("-i") + 1])
    assert given.parent == work, f"the child was pointed at {given}, inside the store"
    assert given.exists() and given.read_bytes() == src.read_bytes(), "the staged copy is not the clip"


def test_a_mono_voice_comes_back_mono(tmp_path, monkeypatch):
    """Mono input stays mono when the separator returns stereo output."""
    import leadvocal
    src = _wav(tmp_path / "mono.wav", seconds=0.5)
    work = tmp_path / "w"
    work.mkdir()

    class FakeProc:
        stdout = iter(())
        def wait(self):                     # noqa: D102
            return 0
        def kill(self):                     # noqa: D102
            pass

    def fake_popen(cmd, **kw):
        # The child's real behavior: a STEREO answer, whatever it was fed.
        out = Path(cmd[cmd.index("--dereverb-out") + 1])
        x, sr = leadvocal.read_wav(Path(cmd[cmd.index("-i") + 1]))
        leadvocal.write_wav(out, np.stack([x, x], axis=1), sr)
        return FakeProc()

    monkeypatch.setattr(voiceclean.subprocess, "Popen", fake_popen)
    install_lead_models(tmp_path, "m.pth")          # the child is only started once these exist
    cfg = types.SimpleNamespace(leadvocal_python=Path(__file__),
                                leadvocal_detect=Path(__file__), leadvocal_models=tmp_path)
    dst = work / "out.wav"
    why = voiceclean.dereverb_wav(src, dst, cfg=cfg, device="cpu", model="m.pth", work=work)
    assert why == "", why
    got, _ = leadvocal.read_wav(dst)
    assert got.ndim == 1, f"a mono clip came back with shape {got.shape}"


def test_the_row_status_line_is_ours_not_the_separators_log_spew():
    """The UI status line uses the job summary rather than raw child-process output."""
    job = voiceclean.CleanJob(id="tn", src="a.wav", label="b", dereverb=True, enhance=False)
    voiceclean.log(job, "Taking the reverb off a.wav")
    voiceclean.log(job, "2026-08-18 03:46:11,218 - INFO - vr_separator - Detected 16-bit input",
                   child=True)
    assert job.note == "Taking the reverb off a.wav", job.note
    assert len(job.log) == 2, "the child's line must still be kept for diagnosis"


def test_the_status_route_publishes_that_line(client, voices_dir, monkeypatch):
    """It is no use marking our own line if the UI cannot read it."""
    job = voiceclean.CleanJob(id="tr", src="a.wav", label="b", dereverb=True, enhance=False)
    voiceclean.log(job, "Taking the reverb off a.wav")
    voiceclean.log(job, "INFO - vr_separator - noise", child=True)
    monkeypatch.setattr(voiceclean, "get", lambda jid: job if jid == "tr" else None)
    body = client.get("/voices/clean/status/tr").get_json()
    assert body["note"] == "Taking the reverb off a.wav"
    assert body["log"][-1].endswith("noise"), "the full log is still available"


# ── release audit 2026-10-11, item 1: a ticked step that did not run is NAMED, with its reason ──

MODELS_WHY = ("Lead Vocal needs model files that have not been downloaded yet: "
              "UVR-DeEcho-DeReverb.pth. Run setup again to fetch them; on Windows that is Start menu > "
              "Repair setup.")


def test_a_skipped_dereverb_is_named_with_its_reason_when_the_job_still_finishes(
        monkeypatch, voices_dir, client):
    """THE CASE THE AUDIT FOUND: De-reverb is ticked by default, the models are missing, Enhance
    works, and the job ended "Voice cleaned ... Enhanced." with the skip only in the job log. The
    status route now carries the step and the reason, and the page prints them."""
    job, made = _run_clean(monkeypatch, voices_dir, dereverb=True, enhance_it=True,
                           dereverb_reason=MODELS_WHY)
    assert job.status == "done" and job.did_enhance and not job.did_dereverb
    assert job.skipped == [{"step": "Remove reverb / echo", "why": MODELS_WHY.rstrip(".")}], job.skipped
    monkeypatch.setattr(voiceclean, "get", lambda jid: job if jid == "t1" else None)
    body = client.get("/voices/clean/status/t1").get_json()
    assert body["status"] == "done" and body["enhanced"] is True and body["dereverbed"] is False
    assert body["skipped"] == job.skipped, "the route must publish what the page will print"
    assert "Run setup again" in body["skipped"][0]["why"]


def test_a_skipped_enhance_is_named_too(monkeypatch, voices_dir):
    job, _ = _run_clean(monkeypatch, voices_dir, dereverb=True, enhance_it=True, enhance_rc=3)
    assert job.status == "done" and job.did_dereverb and not job.did_enhance
    assert job.skipped == [{"step": "Enhance", "why": "the enhancer exited 3"}], job.skipped


def test_an_enhancer_that_could_not_start_is_named(monkeypatch, voices_dir):
    def boom(*a, **kw):
        raise FileNotFoundError("no enhancer here")

    _wav(voices_dir / "her.wav")
    monkeypatch.setattr(voiceclean, "_pick_card", lambda prefer: "cuda:0")
    monkeypatch.setattr(voiceclean, "dereverb_wav",
                        lambda s, dst, **kw: (_wav(Path(dst), freq=330.0), "")[1])
    monkeypatch.setattr(voiceclean.enhance, "run_enhance", boom)
    job = voiceclean.CleanJob(id="t9", src="her.wav", label="Her (dry)", dereverb=True, enhance=True)
    voiceclean._run(job)
    assert job.status == "done"
    assert job.skipped == [{"step": "Enhance",
                            "why": "the enhancer could not run (no enhancer here)"}], job.skipped


def test_nothing_skipped_means_an_empty_list(monkeypatch, voices_dir):
    job, _ = _run_clean(monkeypatch, voices_dir, dereverb=True, enhance_it=True)
    assert job.status == "done" and job.skipped == []


def test_when_nothing_could_be_applied_the_error_carries_the_reasons(monkeypatch, voices_dir):
    job, made = _run_clean(monkeypatch, voices_dir, dereverb=True, enhance_it=True,
                           dereverb_reason="the de-reverb model exited 7", enhance_rc=3)
    assert job.status == "error" and made is None
    assert "Remove reverb / echo: the de-reverb model exited 7" in job.error, job.error
    assert "Enhance: the enhancer exited 3" in job.error, job.error
