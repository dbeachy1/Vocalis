#!/usr/bin/env python3
"""Clean a voice reference by optionally de-reverberating and enhancing it, then save the result as a new named voice. Preserve the original because both transforms are lossy. Normalize the final WAV with the same upload path so cleaned and uploaded samples share format and storage behavior."""
import os
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

import enhance
import leadvocal
import vault_fs
import voice_utils

#: How long a finished job stays readable before it is swept. The UI polls at 1 Hz and stops on
#: the terminal status, so this only has to outlive a browser that was closed mid-job.
JOB_TTL_S = 30 * 60
#: Keep at most this many finished jobs, newest wins. A cleaning is a deliberate one-at-a-time
#: action, so this is generous by an order of magnitude.
MAX_JOBS = 24


@dataclass
class CleanJob:
    """One cleaning. `voice` is the new voice's FILENAME once it exists, and it is the only
    thing the UI needs on success — it re-reads /voices for everything else."""
    id: str
    src: str
    label: str
    dereverb: bool
    enhance: bool
    status: str = "running"          # running | done | error | canceled
    stage: str = ""
    #: The last line WE wrote, as opposed to the last line the child printed. The row's status
    #: line shows this one — see `log`.
    note: str = ""
    error: str = ""
    voice: str = ""
    #: What actually happened, which is not what was ASKED for: a de-reverb that comes back
    #: unusable is skipped rather than fatal, and the badge must then not claim it.
    did_dereverb: bool = False
    did_enhance: bool = False
    #: Every TICKED step that did not run, as `{"step": <the tickbox's own words>, "why": <plain
    #: reason>}`. Without this a skipped de-reverb reached only the job log, and a finished job
    #: whose Enhance worked ended "Voice cleaned ... Enhanced." with no hint the other tick was
    #: dropped (release audit, 2026-10-11). The page reads it from the status route.
    skipped: list = field(default_factory=list)
    log: list = field(default_factory=list)
    started: float = 0.0
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


_JOBS: dict = {}
_JOBS_LOCK = threading.Lock()


def stage_total(dereverb: bool, enhance_it: bool) -> int:
    """Stages the strip counts down. The normalize+save is always the last one, so a job that
    does neither model is still a two-step job rather than a progress bar that starts at 100%."""
    return 1 + int(bool(dereverb)) + int(bool(enhance_it))


def log(job: CleanJob, line: str, *, child: bool = False) -> None:
    """Append a job log entry. When child=True, retain the child output in the detailed log without using it as the row status; the status should describe the current operation."""
    with job.lock:
        job.log.append(line)
        del job.log[:-200]
        if not child:
            job.note = line
    logger.info(f"voiceclean {job.id}: {line}")


#: The tickbox wording the page shows, so a skipped step is named the way the user ticked it.
STEP_DEREVERB = "Remove reverb / echo"
STEP_ENHANCE = "Enhance"


def note_skipped(job: CleanJob, step: str, why: str) -> None:
    """Record a ticked step that did not run. `why` is shown to the user, so it is plain words."""
    why = (why or "").strip().rstrip(".") or "no reason was given"
    with job.lock:
        job.skipped.append({"step": step, "why": why})
    logger.warning(f"voiceclean {job.id}: skipped {step!r}: {why}")


def get(job_id: str):
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def running_for(src: str):
    """The live job cleaning `src`, if there is one. Two cleanings of the same voice at once
    would race for the same new name and both take a GPU child; one is enough."""
    with _JOBS_LOCK:
        for j in _JOBS.values():
            if j.src == src and j.status == "running":
                return j
    return None


def _prune(now: float) -> None:
    """Caller holds _JOBS_LOCK."""
    dead = [k for k, j in _JOBS.items()
            if j.status != "running" and (now - j.started) > JOB_TTL_S]
    for k in dead:
        _JOBS.pop(k, None)
    if len(_JOBS) > MAX_JOBS:
        for k, _ in sorted(_JOBS.items(), key=lambda kv: kv[1].started)[:len(_JOBS) - MAX_JOBS]:
            if _JOBS[k].status != "running":
                _JOBS.pop(k, None)


def _resample_to(path: Path, sr: int, work: Path):
    """`(samples, reason_if_unusable)` — the child's answer on the SOURCE's sample rate.

    🔴 The two signals are compared sample for sample by `align_dry`, so they must share a rate.
    The separator answers at its own model rate (44.1 kHz) whatever it was fed, and a voice
    sample is routinely 24 kHz (Chatterbox's own output) or 48 kHz (anything from a DAW) — so on
    most real clips this conversion is the difference between a de-reverb that lands and one that
    is correctly, uselessly refused. Learned on the stems path, where the first live re-run of a
    song failed for exactly this reason and every test had passed because Demucs and the karaoke
    model happen to agree on 44.1 kHz."""
    x, x_sr = leadvocal.read_wav(path)
    if x_sr == sr:
        return x, ""
    fixed = work / f"{path.stem}_at{sr}.wav"
    r = subprocess.run(leadvocal.build_resample_cmd(path, fixed, sr),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not fixed.exists():
        return None, f"could not bring the de-reverbed clip from {x_sr} Hz onto the voice's {sr} Hz"
    x, x_sr = leadvocal.read_wav(fixed)
    return (x, "") if x_sr == sr else (None, f"the de-reverbed clip is still {x_sr} Hz")


def dereverb_wav(src: Path, dst: Path, *, cfg, device: str, model: str, work: Path,
                 cancel: threading.Event = None, on_line=None) -> str:
    """De-reverb `src` into `dst`, sample-aligned to it. `""` on success, else WHY it was skipped.

    ⚠️ **A skip is not a failure.** Every reason this returns is "the de-reverbed signal cannot be
    trusted to line up", and the honest answer to that is to keep the original audio and say so —
    the job carries on and the badge simply does not claim a de-reverb. The alternative, shipping
    a clip that is quietly misaligned against what the user auditioned, is worse than not cleaning
    it at all.
    """
    py, script = cfg.leadvocal_python, cfg.leadvocal_detect
    if not Path(py).exists() or not Path(script).exists():
        # The environment is part of the image (packaging/leadvocal), so a missing one is a broken
        # image; scripts/leadvocal/setup.sh, which this used to name, is not in the Docker edition.
        # The reason is shown to the user, so the server path goes to the log only (October 11, 2026).
        logger.error(f"voiceclean: the lead-vocal environment is missing: python {py} "
                     f"(exists: {Path(py).exists()}), script {script} (exists: {Path(script).exists()})")
        return "the lead-vocal environment is missing from this image"
    # The separator would download any model file it cannot find; check they are all there and
    # hand back the same plain-language reason the missing venv does, before anything is staged
    # or started. A skip is how this function reports an unavailable de-reverb (see above).
    try:
        leadvocal.require_models(cfg.leadvocal_models, model)
    except RuntimeError as exc:
        logger.warning(f"voiceclean: de-reverb skipped, models not installed ({exc})")
        return str(exc)
    # Stage the source under this job’s work directory before invoking the detector. Its scratch path is derived from the input parent, so passing a voice-library path could create temporary files inside the library; cleanup cannot be guaranteed after a killed child.
    staged = work / f"in{Path(src).suffix or '.wav'}"
    shutil.copyfile(src, staged)
    src = staged
    raw = work / f"{uuid.uuid4().hex}.dry.wav"
    # 🔴 NO `--karaoke-out`. The child runs whichever stages it is given outputs for, and the
    # karaoke separation is a second 1.6 GB model doing work nothing here reads — on a 20-second
    # voice clip that is most of the wall clock, spent to produce a file we delete.
    cmd = leadvocal.build_detect_cmd(py, script, src, dereverb_out=raw,
                                     model_dir=cfg.leadvocal_models, dereverb_model=model,
                                     device=device)
    env = leadvocal.detect_env(os.environ, device)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env=env)
    try:
        for line in proc.stdout or ():
            line = line.rstrip()
            if line and on_line:
                on_line(line)
            if cancel is not None and cancel.is_set():
                proc.kill()
                return "canceled"
        rc = proc.wait()
    finally:
        try:
            proc.kill()
        except OSError:
            pass
    if cancel is not None and cancel.is_set():
        return "canceled"
    if rc != 0:
        return f"the de-reverb model exited {rc}"
    if not raw.exists():
        return "the de-reverb model exited cleanly but wrote no file"

    wet, sr = leadvocal.read_wav(src)
    dry, why = _resample_to(raw, sr, work)
    if dry is None:
        return why
    # The separator returns stereo even for mono input. Convert the dry output to mono when the source is mono so alignment compares matching layouts and the saved clean preserves the source channel count.
    import numpy as np
    if np.ndim(wet) == 1 and np.ndim(dry) > 1:
        dry = np.asarray(dry, dtype=np.float32).mean(axis=1)
    aligned, why = leadvocal.align_dry(dry, wet, sr)
    if aligned is None:
        return why
    leadvocal.write_wav(dst, aligned, sr)
    return ""


def _pick_card(prefer_cuda: bool):
    """The emptiest TICKED card, or "cpu".

    🔴 `enhance_cards()`, never `gpu.pick_device()`. The playground carries the scar: a bare
    device pick enumerates every physical card and knows nothing about ⚙ Settings, so it put a
    ~21 GB enhancer child on the card the user had deliberately unticked and kept for the LLM —
    chosen *because* it was empty, and empty precisely because they had excluded it."""
    from vocalis.runtime import enhancement, gpu           # runtime imports stay off module load
    if not prefer_cuda:
        return "cpu"
    return (gpu.cards_emptiest_first(enhancement.enhance_cards()) or ["cpu"])[0]


def start(src: str, label: str, *, dereverb: bool, do_enhance: bool) -> CleanJob:
    """Register and launch a cleaning. The caller has already validated the name."""
    import time
    job = CleanJob(id=uuid.uuid4().hex[:12], src=src, label=label,
                   dereverb=bool(dereverb), enhance=bool(do_enhance), started=time.time())
    with _JOBS_LOCK:
        _JOBS[job.id] = job
        _prune(job.started)
    threading.Thread(target=_run, args=(job,), name=f"voiceclean-{job.id}", daemon=True).start()
    return job


def _finish(job: CleanJob, status: str, *, error: str = "", voice: str = "") -> None:
    with job.lock:
        job.status = status
        job.error = error
        job.voice = voice


def _run(job: CleanJob) -> None:
    """The whole chain, in a worker thread. Never raises out of here — a job that dies has to
    die as a readable `error` status, because the UI is polling and has nowhere else to look."""
    import scratch as scratch_mod
    from vocalis.runtime import configs, paths, voices as rt_voices

    src_path = paths.VOICE_SAMPLES / job.src
    cfg = configs.ss_cfg()
    root = scratch_mod.scratch_root()
    work = Path(root) / f"voiceclean-{job.id}"
    made = []
    try:
        work.mkdir(parents=True, exist_ok=True)
        # 🔴 THROUGH THE SEAM. `voice_samples/` is a vault root, and BOTH children here — the
        # separator in the leadvocal venv and the enhancer in its own — are DEK-less: handed the
        # plaintext path they would open a file that does not exist on disk. `child_input` hands
        # over a decrypted copy on the plaintext side and removes it after, and returns the
        # original untouched on a box with no vault.
        with vault_fs.child_input(src_path, root) as plain:
            cur = Path(plain)
            n = 0
            if job.dereverb:
                n += 1
                job.stage = "dereverb"
                log(job, f"[{n}/{stage_total(job.dereverb, job.enhance)}] Taking the reverb off "
                         f"{job.src} — this is the same model the Stems tab uses.")
                device = _pick_card(True)
                out = work / "dry.wav"
                why = dereverb_wav(cur, out, cfg=cfg, device=device,
                                   model=leadvocal.dereverb_model(""), work=work,
                                   cancel=job.cancel, on_line=lambda ln: log(job, ln, child=True))
                if job.cancel.is_set():
                    return _finish(job, "canceled")
                if why:
                    # Not fatal, and the badge must not claim it — see `dereverb_wav`.
                    note_skipped(job, STEP_DEREVERB, why)
                    log(job, f"Keeping the reverb — {why}. The rest of the clean still runs, and "
                             f"the new voice is not badged as de-reverbed.")
                else:
                    made.append(out)
                    cur = out
                    job.did_dereverb = True
                    log(job, "Reverb removed, and the result lines up with the original sample.")
            if job.enhance:
                n += 1
                job.stage = "enhance"
                device = _pick_card(True)
                if not str(device).startswith("cuda"):
                    from vocalis.runtime import enhancement
                    reason = enhancement.enhance_unavailable_reason()
                    note_skipped(job, STEP_ENHANCE, reason)
                    log(job, f"Skipping the enhance — {reason}")
                else:
                    log(job, f"[{n}/{stage_total(job.dereverb, job.enhance)}] Enhancing on "
                             f"{device} — bandwidth extension, the same pass a Playground clip "
                             f"gets.")
                    out = work / "enh.wav"
                    try:
                        rc = enhance.run_enhance(configs.enhance_cfg(), cur, out, device=device,
                                                 cancel=job.cancel,
                                                 on_line=lambda ln: log(job, ln, child=True))
                    except Exception as exc:      # noqa: BLE001 — see below
                        # An unavailable enhancement executable can raise `FileNotFoundError` before returning a status code. Treat that as an enhancement hiccup and preserve the already-completed de-reverb output, just as the nonzero-status path does.
                        log(job, f"The enhancer could not run ({exc}).")
                        note_skipped(job, STEP_ENHANCE, f"the enhancer could not run ({exc})")
                        rc = None
                    if rc == -1 or job.cancel.is_set():
                        return _finish(job, "canceled")
                    if rc == 0 and out.is_file():
                        made.append(out)
                        cur = out
                        job.did_enhance = True
                        log(job, "Enhanced.")
                    else:
                        # Same rule as the de-reverb: an enhancer hiccup must not lose the clean.
                        if rc is not None:      # None = the raise above already recorded its reason
                            note_skipped(job, STEP_ENHANCE,
                                         f"the enhancer exited {rc}" if rc
                                         else "the enhancer finished but wrote no file")
                        log(job, (f"The enhancer exited {rc} — " if rc is not None else "")
                                 + "saving the clip without it, and the new voice is not badged "
                                   "as enhanced.")
            if not (job.did_dereverb or job.did_enhance):
                why_all = "; ".join(f"{k['step']}: {k['why']}" for k in job.skipped)
                return _finish(job, "error",
                               error="nothing could be applied" + (f" ({why_all})" if why_all else "")
                                     + " — see the log")

            job.stage = "save"
            log(job, f"[{stage_total(job.dereverb, job.enhance)}/"
                     f"{stage_total(job.dereverb, job.enhance)}] Saving as “{job.label}”.")
            # 🔴 THE CONFLICT CHECK RUNS AGAIN, HERE. It ran at the route too, and that one is
            # the courtesy — this one is the guarantee. Minutes pass between them (two GPU
            # children), and a save that lands on a name taken in the meantime would REPLACE a
            # voice, which is the one loss in this store the user cannot undo (§14.9.1).
            hit = rt_voices.name_conflict(job.label)
            if hit is not None:
                return _finish(job, "error",
                               error=rt_voices.conflict_message(job.label, hit[0]))
            name = rt_voices.unique_wav_name(job.label)
            dst = paths.VOICE_SAMPLES / name
            voice_utils.transcode_normalize(cur, dst)      # decode + peak −1 dBFS + routed write
            voice_utils.set_label(paths.VOICE_SETTINGS, name, job.label)
            side = dict(rt_voices.read_sidecar(src_path))
            side.update({"origin": side.get("origin") or "uploaded",
                         "cleaned_from": job.src,
                         "dereverbed": bool(job.did_dereverb),
                         "enhanced": bool(job.did_enhance)})
            side.pop("favorite", None)      # a copy is not automatically a favorite
            rt_voices.write_sidecar(dst, side)
            log(job, f"Saved {name}.")
            _finish(job, "done", voice=name)
    except Exception as exc:                                # noqa: BLE001 — see the docstring
        logger.exception(f"voiceclean {job.id} failed")
        _finish(job, "error", error=str(exc) or exc.__class__.__name__)
    except BaseException as exc:
        # 🔴 A `VaultAuthError` IS A `BaseException` ON PURPOSE (SPEC_5_0_M5 §2) — a wrong key must
        # never be absorbed into an ordinary failure. But this is a worker THREAD, and letting it
        # out unmarked leaves the job "running" for ever with the UI polling a status that will
        # not change. So: record it so the browser stops spinning, then RE-RAISE, which is the
        # half a blind `except` would have thrown away.
        _finish(job, "error", error=f"{exc.__class__.__name__}: {exc}")
        raise
    finally:
        # Remove the entire per-job work directory. The child can leave raw output and resampled files there; removing only an empty directory would leave plaintext voice material in scratch.
        shutil.rmtree(work, ignore_errors=True)
