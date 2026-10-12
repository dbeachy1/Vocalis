"""TTS voice management and the VoxCPM2 create-a-voice workflow.

Design generation is a cancelable background job. Candidate audio and prompt metadata stay in
the declared scratch boundary until a selected candidate is saved into the routed voice store.
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from flask import Blueprint, abort, jsonify, request

import cleanup
import enhance
import folders
from engine_process import SETUP_HINT
import playground_clips
import scratch
import vault_fs
import voice_utils
import voiceclean
import voxcpm
from book_to_audio import OUTPUT_DIR
from loguru import logger
from store_serve import send_store_file

from vocalis.runtime import configs
from vocalis.runtime import enhancement
from vocalis.runtime import gpu
from vocalis.runtime import nomi as rt_nomi
from vocalis.runtime import params
from vocalis.runtime import paths
from vocalis.runtime import voice_batch
from vocalis.runtime import voice_templates
from vocalis.runtime import voices as rt_voices
from vocalis.runtime import voxcpm_pool
from vocalis.runtime.gpu import GPUS
from vocalis.runtime.params import as_bool as _b
from vocalis.runtime.voxcpm_pool import VOX


# ── Create a voice (4.8-m2 — VoxCPM2 design → freeze into the Voices store) ───
# Audition candidates are DURABLE and the list is APPEND-ONLY (7.0-m7, DESIGN_4_8_VOXCPM §18.5).
# Candidates are durable and append-only; regenerating adds another entry.
# Deleting a candidate is explicit. Saving one as a voice creates a separate copy in Voices.
#
# Durable candidates belong in the encrypted vault, not transient scratch. Scratch is re-keyed
# at boot and is suitable only for temporary plaintext work. VoxCPM2 and ffmpeg children cannot
# access the DEK, so generation stays in scratch and completed files cross through
# `vault_fs.from_scratch` into the vault.
#
# A FUNCTION, not a constant, for the work area: `scratch_root()` resolves fresh per use (env
# wins, then app_settings), so pinning it at import time would freeze whatever was true when the
# module loaded and ignore a later change — and the suite repoints the scratch per test.
def _design_candidates() -> Path:
    """The DURABLE store: finished candidates + their provenance, in the vault."""
    return paths.VOICE_CANDIDATES


def _design_work() -> Path:
    """The scratch work area: the worker's raw draw and the freeze's intermediates."""
    return configs.scratch_root() / scratch.CANDIDATES_SUBDIR


_TOKEN_RE = re.compile(r"[0-9a-f]{32}")


def _design_unavailable():
    """Return a status tuple when a required generation or freeze input is absent."""
    vox = configs.voxcpm_cfg()
    if not vox.python.is_file() or not vox.script.is_file():
        return ("voxcpm_unavailable", "The isolated VoxCPM2 worker is unavailable.", 501)
    if not vox.model_ready:
        missing = ", ".join(vox.model_missing_files)
        return ("voxcpm_model_unavailable",
                f"The pinned VoxCPM2 model snapshot is incomplete ({missing})." + SETUP_HINT, 503)
    ccfg = configs.cleanup_cfg()
    if not ccfg.denoise_available:
        return ("freeze_unavailable", "Voice design's freeze step needs DeepFilterNet3. "
                + ccfg.denoise_unavailable_reason, 503)
    if not configs.enhance_cfg().available:
        return ("freeze_unavailable", "The required Resemble Enhance environment is unavailable.", 503)
    if not enhancement.enhance_cards():
        return ("freeze_unavailable", "The freeze pipeline needs an authorized local GPU.", 503)
    return None


def _candidate_prov_path(token: str) -> Path:
    """The provenance JSON stored beside an audition WAV at generate time."""
    return _design_candidates() / (token + ".json")


def _write_candidate_prov(token: str, prompt: str, sample: str, seed: int,
                          steps: int, cfg: float, duration_s=None) -> None:
    """Atomically persist the provenance required to identify a generated candidate."""
    try:
        vault_fs.write_json_atomic(
            _candidate_prov_path(token),
            {"prompt": prompt, "sample_text": sample, "seed": int(seed),
             "steps": int(steps), "cfg": float(cfg), "created": time.time(),
             "duration_s": (float(duration_s) if duration_s is not None else None)})
    except OSError as exc:
        logger.warning(f"voxcpm design: couldn't write provenance for {token}: {exc}")
        raise


def _read_candidate_prov(token: str) -> dict:
    """A candidate's provenance, or `{}` — never an exception. The WAV is the artifact and the
    .json is a description of it, so an unreadable description must never hide the clip."""
    src = _candidate_prov_path(token)
    if not vault_fs.exists(src):
        return {}
    try:
        got = json.loads(vault_fs.read_text(src))
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError) as exc:
        logger.warning(f"voxcpm design: candidate provenance unreadable ({token}): {exc}")
        return {}


def _candidate_list() -> tuple:
    """Return stored candidates newest first and report their total plaintext size. Use vault-aware glob and stat calls because on-disk vault names are encrypted; the size shown to the user is the plaintext audio size."""
    root = _design_candidates()
    out, total = [], 0
    for name in vault_fs.glob(root, "*.wav"):
        token = name[:-4]
        if not _TOKEN_RE.fullmatch(token):
            continue
        st = vault_fs.stat(root / name)
        if st is None:                      # listed, then deleted under us — not an error
            continue
        total += st.size
        prov = _read_candidate_prov(token)
        pst = vault_fs.stat(_candidate_prov_path(token))
        if pst is not None:
            total += pst.size
        out.append({"token": token, "size": st.size,
                    # The provenance's own `created` is when the draw was made; `mtime` is the
                    # fallback for candidates that predate the field.
                    "created": float(prov.get("created") or st.mtime),
                    "seed": prov.get("seed"), "steps": prov.get("steps"),
                    "duration_s": prov.get("duration_s"),
                    "prompt": prov.get("prompt") or "",
                    "sample_text": prov.get("sample_text") or "",
                    "url": f"/voices/design/audio/{token}"})
    out.sort(key=lambda c: c["created"], reverse=True)
    return out, total


def _delete_candidates(tokens) -> tuple:
    """Delete candidates by token. Returns (how many clips went, how many bytes that freed).

    🔴 THE TOKEN IS VALIDATED HERE, not only at the route, because this is the one place that
    turns a caller's string into an unlink. `_TOKEN_RE.fullmatch` is what stops `..` and a
    separator ever reaching a path join — a bulk delete is exactly the shape where one
    unchecked element in a list of a hundred is easy to miss."""
    root = _design_candidates()
    gone, freed = 0, 0
    for token in tokens:
        token = str(token or "")
        if not _TOKEN_RE.fullmatch(token):
            continue
        wav, prov = root / (token + ".wav"), root / (token + ".json")
        st = vault_fs.stat(wav)
        if st is None:
            continue
        pst = vault_fs.stat(prov)
        try:
            vault_fs.unlink(wav, missing_ok=True)
        except OSError as exc:
            logger.warning(f"voxcpm design: couldn't delete candidate {token}: {exc}")
            continue
        gone += 1
        freed += st.size + (pst.size if pst is not None else 0)
        try:
            vault_fs.unlink(prov, missing_ok=True)
        except OSError:
            pass                  # the clip is gone; an orphan .json is not worth failing over
    return gone, freed


def _save_upload_provenance(dst: Path) -> None:
    """Stamp an uploaded voice: origin + when it landed (§14.6a). Uploads get a sidecar at
    upload time so "uploaded" is a recorded fact rather than an inference from absence."""
    rt_voices.write_sidecar(dst, {"origin": "uploaded", "created": time.time()})


def _save_voice_provenance(token: str, dst: Path) -> None:
    """Copy a candidate's provenance next to the voice it became, stamped with the engine
    and when it was frozen. Best-effort — the voice is already saved; a missing or corrupt
    candidate sidecar just means 'no recorded provenance', never a save failure."""
    prov = _read_candidate_prov(token)
    prov.update(origin="created", engine="voxcpm", model=configs.voxcpm_cfg().model,
                created=time.time())
    rt_voices.write_sidecar(dst, prov)


class _DesignCanceled(Exception):
    """The freeze was aborted by a cancel (the enhance child was killed) — distinct from a
    genuine cleanup failure, which drops the candidate; a cancel drops the whole job."""


# A Generate is a CANCELABLE BACKGROUND JOB (4.8-m2b): it can run 15–50 s, so the request
# returns a job id at once and the UI polls a live log and can abort. Cancel kills the
# in-flight worker(s) — voxcpm.Worker.generate() detects its dead child and raises — then
# reloads them so the pool self-heals for the next Generate. The worker protocol has no
# per-step line, so the log is COARSE ("designing candidate A… / A ready (8.3s)") — honest,
# not a fake progress bar.
@dataclass
class _DesignJob:
    id: str
    status: str = "running"                         # running|done|canceled|failed
    log: list = field(default_factory=list)         # coarse progress lines
    candidates: list = field(default_factory=list)  # finished audition candidates
    errors: list = field(default_factory=list)
    devices: list = field(default_factory=list)     # cards this job claimed — cancel stops their workers
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


_DESIGN_JOBS = {}


_DESIGN_JOBS_LOCK = threading.Lock()


_DESIGN_JOBS_KEEP = 8            # a handful of recent designs; the log is tiny and the pool is what matters


def _prune_design_jobs() -> None:
    """Drop the oldest FINISHED design jobs beyond the keep cap. Call under the lock."""
    done = [j for j in _DESIGN_JOBS.values() if j.status != "running"]
    for j in done[:max(0, len(_DESIGN_JOBS) - _DESIGN_JOBS_KEEP)]:
        _DESIGN_JOBS.pop(j.id, None)


def _design_log(job: "_DesignJob", msg: str) -> None:
    with job.lock:
        job.log.append(msg)
    logger.info(f"voxcpm design {job.id}: {msg}")


def _design_freeze(src: Path, dst: Path, device: str = None,
                   cancel: threading.Event = None) -> None:
    """Run required DFN3, high-pass, and Resemble Enhance stages in plaintext scratch."""
    ccfg = configs.cleanup_cfg()
    if not ccfg.denoise_available:
        raise RuntimeError(ccfg.denoise_unavailable_reason)
    if device is None:
        raise RuntimeError("the freeze pipeline requires the generation card for enhancement")
    ecfg = configs.enhance_cfg()
    if not ecfg.available:
        raise RuntimeError("required Resemble Enhance environment is unavailable")
    work = []
    cur = Path(src)
    # Child processes cannot access the vault key, so plaintext intermediates stay in scratch
    # until the completed candidate is ingested through vault_fs.from_scratch.
    wdir = _design_work()
    wdir.mkdir(parents=True, exist_ok=True)
    try:
        den = wdir / (uuid.uuid4().hex + ".den.wav"); work.append(den)
        rc = cleanup.run_denoise(ccfg, cur, den, wet=1.0, device="cpu")
        if rc != 0 or not den.is_file():
            raise RuntimeError(f"DFN3 cleanup failed (exit {rc})")
        cur = den
        hp = wdir / (uuid.uuid4().hex + ".hp.wav"); work.append(hp)
        r = subprocess.run(["ffmpeg", "-y", "-i", str(cur), "-af", "highpass=f=120:poles=2",
                            "-f", "wav", str(hp), "-loglevel", "error"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0 or not hp.is_file():
            raise RuntimeError(f"high-pass failed: {(r.stderr or '').strip()[:200]}")
        cur = hp
        enh = wdir / (uuid.uuid4().hex + ".enh.wav"); work.append(enh)
        rc = enhance.run_enhance(ecfg, cur, enh, device=device, cancel=cancel,
                                 on_line=lambda ln: logger.info(f"voxcpm freeze enhance: {ln}"))
        if rc == -1 or (cancel is not None and cancel.is_set()):
            raise _DesignCanceled()
        if rc != 0 or not enh.is_file():
            raise RuntimeError(f"Resemble Enhance failed (exit {rc})")
        cur = enh
        voice_utils.transcode_normalize(cur, dst)    # decode + peak −1 dBFS + 16-bit WAV
        if not Path(dst).is_file():
            raise RuntimeError("freeze normalization produced no candidate")
    finally:
        for p in work:
            Path(p).unlink(missing_ok=True)


def _design_run(job: "_DesignJob", text: str, prompt: str, sample: str,
                claimed: list, seeds: list, cfgv: float, steps: int) -> None:
    """Run each worker through the full freeze before publishing its candidate."""
    results, errors = {}, {}

    def _gen(i, device, seed):
        label = chr(65 + i)                       # A, B — matches the UI's candidate labels
        w = VOX.worker(device)
        # RESERVE across the whole candidate — the generate AND the freeze after it. The
        # reaper skips a held worker, so it cannot land between this lookup and the
        # generate() below, which is exactly the gap a bare `is it loaded?` check leaves
        # open when the user returns after the idle timeout and clicks Generate.
        if w is None or not w.reserve():
            # Two ways here now: the load above failed (its reason is already in the log,
            # right overhead), or a cancel killed this worker mid-job.
            why = "VoxCPM2 didn't start" if w is None else "the worker went away"
            errors[i] = why
            _design_log(job, f"candidate {label}: {why}")
            return
        try:
            _gen_held(i, label, device, seed, w)
        finally:
            w.release()

    def _gen_held(i, label, device, seed, w):
        # 🔴 The cancel check has to be HERE, after the worker is reserved and before the
        # generate — a cancel that lands during the LOAD must skip the generation (§14.4).
        # The load itself deliberately runs to completion and the model stays resident (it's
        # useful next time); only the draw is abandoned. Before 4.8-m2e this state couldn't
        # exist, because a cold Generate was refused with a 409 and there was no load phase to
        # cancel during — m2e's self-loading Generate is what opened the window.
        if job.cancel.is_set():
            _design_log(job, f"candidate {label}: canceled")
            return
        token = uuid.uuid4().hex
        work = _design_work()
        raw = work / (token + ".raw.wav")    # transient — freeze reads it, then it's gone
        frozen = work / (token + ".wav")     # plaintext, in the scratch, for as long as the ingest takes
        _design_log(job, f"designing candidate {label} on {device} (seed {seed})…")
        try:
            res = w.generate(text, raw, seed=seed, cfg_value=cfgv, steps=steps, timeout=600)
        except voxcpm.VoxcpmError as exc:
            if job.cancel.is_set():
                _design_log(job, f"candidate {label}: canceled")
            else:
                errors[i] = str(exc)
                _design_log(job, f"candidate {label} failed: {exc}")
            return
        _design_log(job, f"freezing candidate {label}…")
        try:
            _design_freeze(raw, frozen, device=device, cancel=job.cancel)
            # 🔴 THE SEAM, AND IT IS CROSSED HERE — at GENERATE time, not at save time (7.0-m7).
            # The freeze wrote plaintext into the scratch because ffmpeg and the worker cannot do
            # anything else; this is the single line that carries it into the encrypted store,
            # and it is the same `from_scratch` the save path already used one step further down.
            # It is inside the try so an ingest failure drops the candidate the same way a
            # cleanup failure does — a clip that never landed must not be offered to the user.
            vault_fs.mkdir(_design_candidates())
            candidate_path = _design_candidates() / (token + ".wav")
            vault_fs.from_scratch(frozen, candidate_path)
            try:
                _write_candidate_prov(token, prompt, sample, seed, steps, cfgv,
                                     res.get("duration_s"))
            except Exception:
                vault_fs.unlink(candidate_path, missing_ok=True)
                raise
        except _DesignCanceled:
            _design_log(job, f"candidate {label}: canceled")
            return
        except Exception as exc:                  # noqa: BLE001 — an incomplete freeze is not auditionable
            errors[i] = f"freeze failed: {exc}"
            _design_log(job, f"candidate {label} freeze failed: {exc}")
            return
        finally:
            raw.unlink(missing_ok=True)
            # `from_scratch` consumes `frozen` on both arms, so this only ever fires on a failure
            # path — which is exactly when a plaintext clip must not be left in the scratch.
            frozen.unlink(missing_ok=True)
        dur = res.get("duration_s")
        results[i] = {"token": token, "seed": seed, "device": device,
                      "duration_s": dur, "url": f"/voices/design/audio/{token}"}
        _design_log(job, f"candidate {label} ready" +
                    (f" ({float(dur):.1f}s)" if dur is not None else ""))

    # 🔴 THE RELEASE WRAPS THE LOAD TOO (7.0-m7), and it did not used to. `try` began below the
    # `VOX.ensure` block, so anything raising out of the load — an OOM on one card, an OSError
    # spawning the worker — walked past the release and the claimed cards were LOST until the
    # process restarted. A single Generate that dropped a card was already bad; a batch, which
    # runs this fifty times unattended overnight, would leak the box.
    try:
        # The engine may not be up: it comes up cold, and the reaper unloads it after an idle
        # spell (4.8-m2e). Generate is the trigger, so load it HERE, inside the job, where the
        # ~11 s per card can be narrated — a synchronous load would blow the POST's budget.
        # No-op when the workers are already resident, which is the common case mid-session.
        cold = VOX.cold(claimed)
        if cold and not job.cancel.is_set():
            _design_log(job, "VoxCPM2 isn't loaded — starting it (about 11s a card)…")
            VOX.ensure(cold, on_log=lambda m: _design_log(job, m))

        threads = [threading.Thread(target=_gen, args=(i, dev, s))
                   for i, (dev, s) in enumerate(zip(claimed, seeds))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        for dev in claimed:
            GPUS.release_card(dev)

    with job.lock:
        job.candidates = [results[i] for i in sorted(results)]
        job.errors = [errors[i] for i in sorted(errors)]
        if job.cancel.is_set():
            job.status = "canceled"
        elif job.candidates:
            job.status = "done"
        else:
            job.status = "failed"


def _claim_design_cards(seed_in):
    """Claim GPU cards for ONE round of design, and draw the seeds to go with them.

    Returns `(claimed, seeds, err)`, where `err` is `None` or `(code, message)` with code in
    `no_gpu` / `cards_busy`. Two callers now — the `/voices/design` route and the batch runner
    — which is the whole reason this moved out of the route: the batch runs the same round the
    button runs, and a round that claimed cards differently would be a second implementation of
    the yield-to-renders rule that §7.3 depends on.

    🔴 CLAIMING IS WHAT YIELDS TO RENDERS, and the batch needs that MORE than the button does,
    not less: it holds the box all night, so a render that arrives at 02:00 must be able to get
    in. The batch therefore claims and releases PER ROUND rather than holding the cards for the
    whole run, and treats `cards_busy` as "wait and try again", never as a failure.

    Filled seed = one card; otherwise ONE PER FREE CARD (§14.3). The count is a side effect of
    parallelism being free, never a target — the loop stops at the first card it cannot claim,
    so a one-card box draws one, as fast as possible. Warm cards FIRST, then cold ones: the
    engine loads on demand (the job does it), so a card without a worker is still a candidate,
    it just costs ~11 s — and ordering this way means a one-worker pool pays that only for the
    SECOND candidate, not the first."""
    warm = VOX.ready_devices()
    order = warm + [d for d in voxcpm_pool.usable_cards() if d not in warm]
    if not order:
        return [], [], ("no_gpu", "VoxCPM2 needs a free GPU and the ⚙ Settings GPU selection "
                                  "has none available on this box.")
    want = 1 if seed_in is not None else len(order)
    claimed, reason = [], ""
    for _ in range(want):
        dev, why = GPUS.claim_card(order)
        if dev is None:
            reason = why
            break
        claimed.append(dev)
    if not claimed:
        msg = ("a render is using the cards — voice creation yields to it. Try again when it "
               "finishes." if reason in ("render", "render_waiting")
               else "no free card for VoxCPM2 right now.")
        return [], [], ("cards_busy", msg)

    if seed_in is not None:
        seeds = [seed_in]
    else:
        seeds, pool = [], set()
        while len(seeds) < len(claimed):
            s = int.from_bytes(os.urandom(4), "big")
            if s not in pool:
                pool.add(s)
                seeds.append(s)
    return claimed, seeds, None


def _design_dirs_ready() -> None:
    """Create the temporary scratch work area and durable vault candidate store. Do not expire candidates automatically; the vault-backed store is user-managed."""
    _design_work().mkdir(parents=True, exist_ok=True)
    vault_fs.mkdir(_design_candidates())


# ── The overnight batch (7.0-m7, §18) ────────────────────────────────────────
# The STATE is `runtime/voice_batch.py` — persisted, framework-free, and it never comes back
# from disk running. What lives here is the RUNNER, for the same reason `_DESIGN_JOBS` lives
# here: this file already knows how to do one round, and the batch is that round repeated.
_BATCH = None
_BATCH_LOCK = threading.Lock()
# Publish the active round so a second stop request can cancel it. Between rounds, there is no
# active job to cancel and the second request is a harmless no-op.
_BATCH_JOB = None


def _batch():
    """The one batch, built on first use and REBUILT IF ITS PATH MOVES.

    Lazily, because `paths.VOICE_CANDIDATES` cannot be read at import time and be right: the
    suite repoints the whole install root per test, and a module-level `VoiceBatch(...)` would
    pin whichever root existed when the module first loaded — the same freeze `_design_work()`
    avoids by being a function. Keyed on the resolved path rather than a bare `if _BATCH is
    None`, so a repoint produces a new batch instead of a live object writing into a directory
    that no longer belongs to it."""
    global _BATCH
    path = paths.VOICE_CANDIDATES / "batch.yaml"
    with _BATCH_LOCK:
        if _BATCH is None or _BATCH.path != path:
            _BATCH = voice_batch.VoiceBatch(path)
        return _BATCH


# Wait up to ten minutes for a free card, checking every five seconds so stops stay responsive.
# A shorter limit abandons transient interruptions; an unlimited wait can report running without output.
#
# 📌 The 10 minutes is the budget; the 5 s is the RESPONSIVENESS, and they are separate numbers on
# purpose. A single long sleep spends the same budget but leaves the cards idle for most of the
# gap between the render finishing and the batch noticing.
_BATCH_CARD_WAIT_S = 5
_BATCH_CARD_TRIES = 120

# Consecutive rounds yielding not one candidate before the batch gives up. One bad round is a
# Five consecutive empty rounds indicate a systemic failure rather than a transient blip,
# and without this ceiling the loop would have held the GPUs until morning making nothing.
_BATCH_BARREN_MAX = 5


def _batch_run(batch) -> None:
    """Run rounds of one candidate per free card until the requested count is met, the user stops the batch, or the box cannot proceed. Hold worker reservations for the whole batch so the idle reaper does not unload the model between rounds; claim cards separately per round so foreground renders can use them."""
    global _BATCH_JOB
    held, ok = [], False
    try:
        unavailable = _design_unavailable()
        if unavailable is not None:
            batch.fail(unavailable[1])
            return
        _design_dirs_ready()
        text = f"({batch.prompt}){batch.sample_text}" if batch.prompt else batch.sample_text
        misses = 0
        barren = 0                    # consecutive rounds that produced nothing (see the ceiling)
        while True:
            with batch.lock:
                if batch.stopping or not batch.running or batch.done >= batch.total:
                    break
            claimed, seeds, err = _claim_design_cards(None)
            if err is not None:
                code, msg = err
                if code == "no_gpu":                 # not a wait — nothing will change by 06:00
                    batch.fail(msg)
                    return
                misses += 1
                if misses >= _BATCH_CARD_TRIES:
                    batch.fail("the GPUs stayed busy — " + msg)
                    return
                if misses == 1:
                    batch.add_log("waiting for a free card — a render has them…")
                # Interruptible: a stop pressed during a ten-minute wait must not sit here.
                _batch_sleep(batch, _BATCH_CARD_WAIT_S)
                continue
            misses = 0
            # Never overshoot the requested count.
            # otherwise finish at 101 of 100, and "a hundred" was a budget, not a rounding hint.
            want = min(len(claimed), batch.remaining())
            for dev in claimed[want:]:
                GPUS.release_card(dev)
            claimed, seeds = claimed[:want], seeds[:want]

            # The first stop request lets the active round finish and preserves its candidate. The wait is
# bounded by one round; a second stop request cancels the active job immediately.
            job = _DesignJob(id=uuid.uuid4().hex[:12], devices=list(claimed))
            # Reserve the workers ONCE, on the first round that has them — before this point
            # there may be no worker to reserve, because a cold box loads inside the job.
            held = _batch_hold(claimed, held)
            with _BATCH_LOCK:
                _BATCH_JOB = job
            # §19 — the round's own wall clock, so the log can say what a round actually costs.
            # `monotonic`, not `time()`: this is a duration and the only clock that cannot be
            # dragged backward by an NTP correction in the middle of an overnight run.
            round_t0 = time.monotonic()
            try:
                _design_run(job, text, batch.prompt, batch.sample_text, claimed, seeds,
                            batch.cfg, batch.steps)
            finally:
                with _BATCH_LOCK:
                    _BATCH_JOB = None
            batch.note_round(len(job.candidates), job.errors, canceled=job.cancel.is_set(),
                             seconds=max(0.0, time.monotonic() - round_t0))
            # 🔴 A batch where EVERY round fails must not hold the box all night making nothing.
            # Cancellation is user-requested and does not count as a failed round.
            if job.candidates:
                barren = 0
            elif not job.cancel.is_set():
                barren += 1
                if barren >= _BATCH_BARREN_MAX:
                    batch.fail(f"{barren} rounds in a row made nothing — something is wrong "
                               "with every round, not with one. See the log; ▶ Carry on "
                               "retries once the cause is fixed.")
                    return
        with batch.lock:
            if batch.done >= batch.total:
                batch.add_log(f"batch finished: {batch.done} candidates")
        ok = True
    finally:
        for w in held:
            w.release()
        if not ok and not batch.error:
            # We are unwinding on an exception (or a BaseException). Record WHY the morning shows
            # a stopped batch, then let it keep unwinding — `batch.fail` already logs, and the
            # stack lands in the thread excepthook.
            batch.fail("the batch stopped unexpectedly — see the log for the traceback")
        batch.set_running(False)


def _batch_hold(devices, held) -> list:
    """Reserve each device's CURRENT worker for the rest of the run. Returns the growing list of
    reservations the caller releases in its finally. A worker that refuses (retired, or not ready
    yet) is simply skipped — the round's own `reserve()` is what actually gates the work, so this
    is an optimization against the reaper and must never be a reason not to generate.

    ⚠️ IDENTITY, NOT DEVICE NAME. A cancel stops a worker and `VOX.drop`s it, so the pool can hand
    back a DIFFERENT worker object on the same card mid-run. Keyed on `cuda:0` this would see the
    card as already held and never reserve the replacement — and the reaper would then unload the
    model between rounds for the rest of the night, which is the single thing this function
    exists to prevent. The stale object stays in `held` and is released harmlessly at the end."""
    for dev in devices:
        w = VOX.worker(dev)
        if w is None or any(w is h for h in held):
            continue
        if w.reserve():
            held.append(w)
    return held


def _cancel_job_workers(job) -> None:
    """Kill a design job's in-flight worker(s) so generate() raises and the job unwinds to
    'canceled'. A killed worker loses its warm model, so drop it from the pool and reload it
    in the background — the pool self-heals for the next Generate. Shared by the interactive
    ✕ Cancel route and the batch's second ■ press, which are the same act on different jobs."""
    reload_devices = []
    for device in list(job.devices):
        w = VOX.worker(device)
        if w is not None and w.alive:
            w.stop()                            # kills the child → generate() detects it and raises
            VOX.drop(device, w)                 # so load_bg reloads it
            reload_devices.append(device)
    if reload_devices:
        VOX.loading_begin()                     # released by load_bg's finally
        threading.Thread(target=VOX.load_bg, args=(reload_devices,), daemon=True).start()


def _batch_sleep(batch, seconds: float) -> None:
    """Wait, but notice a stop. A bare `time.sleep(30)` here would make ■ Stop take up to half a
    minute to do anything, on the one control whose whole job is to be immediate."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        with batch.lock:
            if batch.stopping or not batch.running:
                return
        time.sleep(0.25)


def _place_voice(label: str, write, origin_writer):
    """Shared save path for BOTH ways a voice is born (upload, freeze a design).

    Order matters: reject the name BEFORE touching the disk, derive a filename that can't
    collide, let the caller put bytes there, then record the label and the sidecar. The label
    is stored even when it equals the stem — a recorded identity beats one inferred from a
    filename, and 5.x encrypts filenames anyway (§14.2)."""
    label = (label or "").strip()
    if not label:
        return jsonify({"error": "no name", "message": "Give the voice a name."}), 400
    hit = rt_voices.name_conflict(label)
    if hit:
        return jsonify({"error": "exists", "name": label,
                        "message": rt_voices.conflict_message(label, hit[0])}), 409
    target_name = rt_voices.unique_wav_name(label)
    dst = paths.VOICE_SAMPLES / target_name
    # The store need not exist yet. voice_samples/ used to ship as a tracked .gitkeep, so on a
    # fresh clone the directory was simply always there and nothing had to create it; the enable
    # gate (DEPLOYMENT_QA_5_0 §0 row 4) requires it to ship EMPTY, and dropping the .gitkeep
    # takes the directory with it. The design-freeze path already did this for itself — here it
    # covers the UPLOAD path too, which had no mkdir anywhere and would have failed on the very
    # first thing a new install does.
    vault_fs.mkdir(paths.VOICE_SAMPLES)
    err = write(dst)
    if err is not None:
        return err
    voice_utils.set_label(paths.VOICE_SETTINGS, target_name, label)
    origin_writer(dst)
    # vault_fs.stat, and its `size` is the PLAINTEXT size — the number the user is being shown
    # about their own clip, not the ciphertext's. A bare dst.stat() here raises
    # FileNotFoundError once the vault is on: the voice IS saved by this point, so the user
    # would watch a successful save return a 500.
    st = vault_fs.stat(dst)
    return jsonify({"name": target_name, "label": label,
                    "size": st.size if st is not None else 0,
                    "peak_dbfs": voice_utils.peak_dbfs(dst)})


def _save_voice(name_field):
    """Upload: transcode to WAV + normalize to -1 dBFS, under a name nothing else answers to.

    The name defaults to the uploaded file's stem — a filename is a meaningful default for an
    upload, because you picked that file. (A *designed* voice has nothing to fall back on,
    which is why Create demands a name; §14.2.)"""
    if "file" not in request.files:
        return jsonify({"error": "no file uploaded (form field 'file')"}), 400
    f = request.files["file"]
    label = (name_field or "").strip() or Path(f.filename or "").stem.strip() or "voice"

    def write(dst):
        # The RAW UPLOADED RECORDING — your voice, un-transcoded, exactly as you recorded it.
        # It used to land in the OS temp dir via NamedTemporaryFile(delete=False): outside the
        # install root, outside cache_root(), outside every path 5.0 encrypts, and outside
        # anything that would ever sweep it. `delete=False` with cleanup in a `finally` means a
        # SIGKILL, an OOM or a power cut during the ffmpeg transcode orphaned it THERE,
        # PERMANENTLY. Now: scratch — opaque name, deleted on the way out either way, and swept
        # at startup for the kills that skip the `finally` (5.0 §8, scratch.py).
        suffix = Path(f.filename or "").suffix or ".bin"
        with scratch.file(configs.scratch_root(), f"voice-upload|{dst.name}", suffix) as tmp:
            f.save(str(tmp))
            try:
                voice_utils.transcode_normalize(tmp, dst)
            except Exception as exc:                           # noqa: BLE001
                return jsonify({"error": f"transcode/normalize failed: {exc}"}), 400
        return None

    return _place_voice(label, write, _save_upload_provenance)


def _speaker_voices() -> dict:
    """Every speaker the message cache files audio under, mapped to the voice it speaks with
    now: `{owner: {voice filename, ...}}` ('' = no voice at all). 11.2.9.

    A SET, because two SillyTavern characters can share a display name and therefore one
    sub-tree while speaking with different voices. Their files count toward both
    voices, and clearing either one clears the shared sub-tree.

    🔴 THE CACHE IS FILED BY SPEAKER, NOT BY VOICE, and its keys are one-way MD5s — so "how much
    is cached for this voice" cannot be read off the files. It is answered the other way round:
    which speakers use this voice, and what is in THEIR sub-trees. The owner strings and the
    fallback chain below must match the two places that write the cache, or a speaker's files
    are counted under the wrong voice (or not at all):

      SillyTavern  `st:<character>` — vocalis_stream_http.resolve_st_request. `<character>` is the
                   DISPLAY name the extension sends, so an avatar-keyed row is filed under its
                   `name`, not its key. Voice: the row's own, else the ST
                   default, else the Nomi default. `st:` alone is a request with no character.
      Nomi         `nomi:<id>` — NomiSpeaker.request_context. Voice: its own, else the Nomi default.

    ⚠️ A request can also NAME a voice outright (`voice` in a /v1 body); those renders sit in
    the speaker's sub-tree and are counted under the speaker's mapped voice. The mtime bump in
    clear_cache is what still invalidates them.

    Read from voice_settings.yaml directly (voice_utils is the settings seam) rather than from
    the ST registry object, which this blueprint has no handle on and does not need: the file is
    the truth the registry itself persists to."""
    st = voice_utils.get_section(paths.VOICE_SETTINGS, "sillytavern")
    nm = voice_utils.get_section(paths.VOICE_SETTINGS, "nomi")
    nomi_def = str(nm.get("default_voice", "") or "")
    st_def = str(st.get("default_voice", "") or "") or nomi_def
    out = {"st:": {st_def}}
    for kind, _key, owner, voice in _speakers(st, nm):
        out.setdefault(owner, set()).add(voice or (st_def if kind == "st" else nomi_def))
    return out


def _speakers(st: dict = None, nm: dict = None) -> list:
    """Return `(kind, key, owner, voice)` rows for saved SillyTavern characters and Nomi. `key` identifies the settings entry; `owner` must match the cache folder used by the writers; `voice` is the row's explicit assignment or empty for default fallback. Characters sharing one owner folder also share cache totals and clearing."""
    if st is None:
        st = voice_utils.get_section(paths.VOICE_SETTINGS, "sillytavern")
    if nm is None:
        nm = voice_utils.get_section(paths.VOICE_SETTINGS, "nomi")
    out = []
    for key, e in st.items():
        if isinstance(e, dict):
            out.append(("st", str(key), f"st:{str(e.get('name') or key).strip()}",
                        str(e.get("voice", "") or "")))
    for nid, e in nm.items():
        if isinstance(e, dict):
            out.append(("nomi", str(nid), f"nomi:{nid}", str(e.get("voice", "") or "")))
    return out


def create_voices_blueprint() -> Blueprint:
    """No injected state — see web/comfyui.py."""
    bp = Blueprint("vocalis_voices", __name__)

    @bp.route("/voices")
    def voices():
        """Every voice, plus the flags its lists sort by: origin, ★, and when it arrived.

        🔴 The ORDER stays the filename order `rt_voices.files()` produced (§16.5). This payload
        feeds the Voices tab AND the Book/Playground dropdowns, and those order themselves —
        favorites first, then by DISPLAY name — in their own builder. Re-sorting here to suit
        one surface silently reorders every other one as a side effect.

        NB: Nomi and SillyTavern do NOT read this route — their dropdowns come from
        `rt_voices.options()`, which is wav+mp3 and carries its own copy of the picker flags."""
        labels = voice_utils.get_labels(paths.VOICE_SETTINGS)
        # M10 §4.6 — vault_fs.stat, and its `size` is the PLAINTEXT size. A bare p.stat() raises
        # FileNotFoundError once voice_samples/ is encrypted, which here is a 500 on the whole tab
        # rather than one wrong number; and the raw size would be the ciphertext's, i.e. ~750 bytes
        # of header per voice reported to the user as their own clip's size.
        out = []
        for p in rt_voices.files():
            st = vault_fs.stat(p)
            out.append({"name": p.name, "size": st.size if st is not None else 0,
                        "label": labels.get(p.name, ""), **rt_voices.meta(p)})
        # 8.9 — stamp each row's virtual folder. Keyed on `name`, the FILENAME, which §14.6
        # makes immutable for life: a rename here changes the LABEL only, so this scope needs
        # no `folders.rekey` hook and cannot silently unfile anything. (Scenes and RVC voices
        # are the two scopes where that is not true — see `folders.rekey`.)
        # 📌 Stamping does not reorder, so the filename order this docstring pins is intact.
        out = folders.for_rows(paths.FOLDERS.parent, "voices_tts", out, ref_key="name")
        return jsonify(out)


    @bp.route("/voices", methods=["POST"])
    def voices_add():
        return _save_voice(request.form.get("name"))


    @bp.route("/voices/design", methods=["POST"])
    def voices_design():
        """Start a background Generate: one or two audition candidates with VoxCPM2 (design
        mode, no reference), EACH already frozen (cleaned + enhanced) so what you audition is
        what Save keeps. Returns a job id at once (202); the UI polls /voices/design/status and
        can cancel (Generate can run 30–60 s incl. the enhance, so it must not block the request).

        Generate SELF-LOADS the engine (4.8-m2e) — it no longer refuses when VoxCPM2 is cold,
        because the reaper unloads an idle one out from under the user and being told to go and
        press Load is not an answer. The load runs inside the job (~11 s a card, narrated in the
        log), matching how Chatterbox lazy-loads on the first render. The ⬇ Load button survives
        as a deliberate pre-warm, not a prerequisite.

        Blank seed → two distinct random seeds, one worker per free card, IN PARALLEL — two
        candidates in the wall-clock of one (§7.2). A filled seed → one deterministic candidate.
        The description is prepended as the §4.2 parenthetical HERE; the worker never composes
        prompts. Cards are CLAIMED synchronously before the job starts (GPUS.claim_card) and held
        through the enhance, so a render in flight or waiting gets an immediate 'cards_busy' rather
        than a job that instantly dies — voice creation yields to renders (§7.3)."""
        unavailable = _design_unavailable()
        if unavailable is not None:
            code, message, status = unavailable
            return jsonify({"error": code, "message": message}), status
        d = request.get_json(silent=True) or {}
        prompt = str(d.get("prompt") or "").strip()
        sample = str(d.get("sample_text") or "").strip()
        if not sample:
            return jsonify({"error": "the sample text is required — it's what the voice will say."}), 400
        steps = max(4, min(30, int(d.get("steps") or 30)))
        cfgv = float(d.get("cfg") or 2.0)
        text = f"({prompt}){sample}" if prompt else sample
        seed_raw = str(d.get("seed") if d.get("seed") is not None else "").strip()
        seed_in = int(seed_raw) if seed_raw not in ("", "None") else None

        # Claim cards — THIS is what yields to renders (§7.3). Shared with the batch runner, so
        # both take the same round; see `_claim_design_cards`.
        claimed, seeds, err = _claim_design_cards(seed_in)
        if err is not None:
            code, msg = err
            return jsonify({"error": code, "message": msg}), (501 if code == "no_gpu" else 409)

        _design_dirs_ready()

        job = _DesignJob(id=uuid.uuid4().hex[:12], devices=list(claimed))
        with _DESIGN_JOBS_LOCK:
            _DESIGN_JOBS[job.id] = job
            _prune_design_jobs()
        try:
            threading.Thread(target=_design_run,
                             args=(job, text, prompt, sample, claimed, seeds, cfgv, steps),
                             daemon=True).start()
        except BaseException:          # no thread ⇒ no finally ⇒ the cards would be lost for good
            for dev in claimed:
                GPUS.release_card(dev)
            with _DESIGN_JOBS_LOCK:
                _DESIGN_JOBS.pop(job.id, None)
            raise
        return jsonify({"job_id": job.id, "n": len(claimed)}), 202


    @bp.route("/voices/design/status/<job_id>")
    def voices_design_status(job_id):
        """Poll a background Generate: its status, the live log, and (when done) the candidates."""
        with _DESIGN_JOBS_LOCK:
            job = _DESIGN_JOBS.get(job_id)
        if job is None:
            abort(404)
        with job.lock:
            return jsonify({"status": job.status, "log": list(job.log),
                            "candidates": list(job.candidates), "errors": list(job.errors)})


    @bp.route("/voices/design/cancel/<job_id>", methods=["POST"])
    def voices_design_cancel(job_id):
        """Abort a running Generate: kill the in-flight worker(s), which makes generate() raise
        and unwinds the job to 'canceled'. A killed worker loses its warm model, so drop it from
        the pool and reload it in the background — the pool self-heals for the next Generate."""
        with _DESIGN_JOBS_LOCK:
            job = _DESIGN_JOBS.get(job_id)
        if job is None:
            abort(404)
        with job.lock:
            if job.status != "running":
                return jsonify({"ok": True, "status": job.status})   # already finished — nothing to cancel
        job.cancel.set()
        _design_log(job, "canceling — stopping the worker(s)…")
        _cancel_job_workers(job)
        return jsonify({"ok": True, "status": "canceling"})


    # ── Voice-design templates (7.0-m7 §17) ──────────────────────────────────
    # Save the description, sample text, and quality steps as a named template.
# Language only populates sample text; the text itself carries the chosen language.
    @bp.route("/voices/templates")
    def voices_templates():
        """Every template, favorites first. The client re-sorts by name or newest (§16.5)."""
        return jsonify({"templates": [t.to_dict() for t in voice_templates.list_templates()]})


    @bp.route("/voices/templates", methods=["POST"])
    def voices_templates_add():
        """🔴 SAVE ALWAYS CREATES (§17.4). Editing is PATCH, by id. Two templates may share a
        name — the id is the identity — because a save that quietly replaced a same-named entry
        would destroy the older one with no warning, in a store whose whole job is not losing
        the thing you spent twenty minutes on."""
        d = request.get_json(silent=True) or {}
        name = str(d.get("name") or "").strip()
        if not name:
            return jsonify({"error": "no name",
                            "message": "Give the template a name so you can find it again."}), 400
        try:
            t = voice_templates.add(name=name, prompt=str(d.get("prompt") or ""),
                                    sample_text=str(d.get("sample_text") or ""),
                                    steps=max(4, min(30, int(d.get("steps") or 30))))
        except ValueError as exc:
            return jsonify({"error": "too_many", "message": str(exc)}), 400
        return jsonify(t.to_dict()), 201


    @bp.route("/voices/templates/<tpl_id>", methods=["POST"])
    def voices_templates_update(tpl_id):
        """Rename, re-save the form over an existing template, or toggle its ★.

        POST-to-the-id rather than PATCH, matching `POST /wbedit/instructions/<id>` — the store
        this one is modeled on. The verb is not the interesting part; having ONE convention is,
        because a second one means a fourth near-identical `jfetch` wrapper in `index.html`
        beside jget/jpost/jput/jdel."""
        d = request.get_json(silent=True) or {}
        fields = {k: v for k, v in d.items()
                  if k in ("name", "prompt", "sample_text", "steps", "favorite")}
        if not fields:
            return jsonify({"error": "nothing to change"}), 400
        try:
            return jsonify(voice_templates.update(tpl_id, **fields).to_dict())
        except KeyError:
            abort(404)
        except (ValueError, TypeError) as exc:
            return jsonify({"error": "bad_field", "message": str(exc)}), 400


    @bp.route("/voices/templates/<tpl_id>", methods=["DELETE"])
    def voices_templates_delete(tpl_id):
        try:
            voice_templates.delete(tpl_id)
        except KeyError:
            abort(404)
        return jsonify({"ok": True})


    @bp.route("/voices/templates/<tpl_id>/use", methods=["POST"])
    def voices_templates_use(tpl_id):
        """Count a load. Fire-and-forget from the UI: the form is filled from the list it already
        has, so this must never be on the path between clicking a template and seeing it."""
        voice_templates.note_used(tpl_id)
        return jsonify({"ok": True})


    @bp.route("/voices/design/batch")
    def voices_design_batch_status():
        """Poll the overnight run. Cheap enough to poll while the tab is open, and the ONLY way
        the morning learns what happened — the browser that started it may be a different one."""
        return jsonify(_batch().snapshot())


    @bp.route("/voices/design/batch", methods=["POST"])
    def voices_design_batch_start():
        """Arm a batch and start it. One press, because the deliberate act §18.2 asks for is the
        confirmation the UI puts in front of it — the modal that says this holds the GPUs, which
        ComfyUI and SwarmUI also want, until it is done or stopped.

        🔴 REFUSES WHILE ONE IS RUNNING rather than replacing it. Arming resets progress, so an
        accidental second press mid-run would zero a batch that is 60 candidates in and report
        0/100 with no way back to the real number."""
        unavailable = _design_unavailable()
        if unavailable is not None:
            code, message, status = unavailable
            return jsonify({"error": code, "message": message}), status
        batch = _batch()
        d = request.get_json(silent=True) or {}
        sample = str(d.get("sample_text") or "").strip()
        if not sample:
            return jsonify({"error": "the sample text is required — it's what the voice will say."}), 400
        try:
            count = int(d.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        if count < 1:
            return jsonify({"error": "bad_count",
                            "message": "How many candidates? Give it a number of 1 or more."}), 400
        if count > voice_batch.MAX_BATCH:
            return jsonify({"error": "bad_count",
                            "message": f"{voice_batch.MAX_BATCH} at a time is the ceiling — "
                                       f"that is already several nights of GPU."}), 400
        # 🔴 ARM AND START ARE ONE OPERATION, and the refusal comes OUT of it rather than from a
        # `status()` read above. Reading the status and then arming leaves a window, and arming
        # RESETS progress — so a double-click could zero a batch 60 candidates in and leave two
        # runner threads counting into the same total.
        if not batch.arm_and_run(count, str(d.get("prompt") or "").strip(), sample,
                                 max(4, min(30, int(d.get("steps") or 30))),
                                 float(d.get("cfg") or 2.0)):
            return jsonify({"error": "batch_running",
                            "message": "A batch is already running. Stop it first."}), 409
        return _batch_launch(batch)


    @bp.route("/voices/design/batch/resume", methods=["POST"])
    def voices_design_batch_resume():
        """Resume a stopped batch after the user explicitly requests it. Batch state may survive a restart, but a fresh process never resumes persisted work automatically."""
        unavailable = _design_unavailable()
        if unavailable is not None:
            code, message, status = unavailable
            return jsonify({"error": code, "message": message}), status
        batch = _batch()
        # The transition is atomic (see `arm_and_run`); the status is read only to word the
        # refusal, where being a moment stale costs nothing but a slightly wrong sentence.
        if not batch.resume():
            if batch.status() in ("running", "stopping"):
                return jsonify({"error": "batch_running",
                                "message": "It is already running."}), 409
            return jsonify({"error": "nothing_to_resume",
                            "message": "There is no unfinished batch to carry on."}), 409
        return _batch_launch(batch)


    @bp.route("/voices/design/batch/clear", methods=["POST"])
    def voices_design_batch_clear():
        """Discard a finished or stopped batch and return it to `idle`. Refuse while it is running, and leave generated candidates untouched so clearing batch state cannot stop work or delete results."""
        batch = _batch()
        if not batch.clear():
            return jsonify({"error": "batch_running",
                            "message": "It is still running — stop it first."}), 409
        return jsonify(batch.snapshot())


    @bp.route("/voices/design/batch/stop", methods=["POST"])
    def voices_design_batch_stop():
        """The first stop request lets the active round finish and preserves its candidates. A second request cancels the active round. Between rounds, there is no active job to cancel."""
        batch = _batch()
        with batch.lock:
            second = batch.running and batch.stopping
        if not second:
            batch.request_stop()
        else:
            with _BATCH_LOCK:
                job = _BATCH_JOB
            if job is not None and not job.cancel.is_set():
                job.cancel.set()
                batch.add_log("canceling the round in flight…")
                _cancel_job_workers(job)
        return jsonify(batch.snapshot())


    def _batch_launch(batch):
        """Shared by start and resume. The flag is ALREADY set by the atomic transition that got
        us here; this only launches the thread — and undoes the flag if it will not start, or the
        batch would say 'running' with nothing running and no way to clear it but a restart."""
        try:
            threading.Thread(target=_batch_run, args=(batch,), daemon=True).start()
        except BaseException:
            batch.set_running(False)
            raise
        return jsonify(batch.snapshot()), 202


    @bp.route("/voices/design/candidates")
    def voices_design_candidates():
        """The audition list: every stored candidate, newest first, with the total on disk.

        🔴 THE LIST LIVES ON THE SERVER NOW (§18.5). It used to be `vc.cands` in the browser and
        nowhere else, which meant a reload emptied it and Generate replaced it — both of which
        are the opposite of append-only. A batch that runs overnight while the tab sleeps has no
        browser to hold state in, so the server has to be the one that knows."""
        cands, total = _candidate_list()
        return jsonify({"candidates": cands, "total_bytes": total})


    @bp.route("/voices/design/delete", methods=["POST"])
    def voices_design_delete():
        """Delete candidates — ONE door for both the per-row ✕ and the mass-delete over a
        checkbox selection, because the UI's "delete one" is just a list of length one.

        A second endpoint for the single case is exactly the shape the 7.0 review kept finding:
        two paths that build the same thing, one of which grows a guard the other never gets."""
        d = request.get_json(silent=True) or {}
        tokens = d.get("tokens")
        if not isinstance(tokens, list) or not tokens:
            return jsonify({"error": "no tokens", "message": "Nothing selected to delete."}), 400
        if len(tokens) > 5000:
            return jsonify({"error": "too many", "message": "Delete fewer at a time."}), 400
        gone, freed = _delete_candidates(tokens)
        return jsonify({"deleted": gone, "freed_bytes": freed})


    @bp.route("/voices/design/audio/<token>")
    def voices_design_audio(token):
        """Serve a stored audition candidate (Range support for the player).

        `send_store_file`, not `send_file`: the candidate is in the vault now, so its name on
        disk is SIV-encrypted and Werkzeug would 404 on a file that is sitting right there —
        or, worse on a bad day, range over the ciphertext and serve the browser noise with a
        206. Range matters here specifically because the review UI is play-next-on-end down a
        list of a hundred clips."""
        if not _TOKEN_RE.fullmatch(token or ""):
            abort(404)
        p = _design_candidates() / (token + ".wav")
        if not vault_fs.exists(p):
            abort(404)
        return send_store_file(p, mimetype="audio/wav")


    @bp.route("/voices/design/save", methods=["POST"])
    def voices_design_save():
        """Keep a chosen candidate as a named voice + a provenance sidecar. The candidate is
        ALREADY frozen (cleaned, enhanced, −1 dBFS 16-bit WAV — the freeze ran at generate time),
        so this is an INSTANT atomic place-into-store, no GPU: what the user auditioned is exactly
        what lands, the same shape every uploaded clip is.

        🔴 There is NO name default here, and no overwrite (§14.2/§14.9.1): a designed voice has
        nothing to fall back on, and a default like "voice" teaches the user nothing about who it
        is when they meet it again in a picker three weeks later."""
        d = request.get_json(silent=True) or {}
        token = str(d.get("token") or "")
        if not _TOKEN_RE.fullmatch(token):
            return jsonify({"error": "bad candidate token"}), 400
        src = _design_candidates() / (token + ".wav")
        if not vault_fs.exists(src):
            return jsonify({"error": "that candidate is gone — generate it again."}), 404

        def write(dst):
            try:
                vault_fs.mkdir(paths.VOICE_SAMPLES)
                # 🔴 THIS IS VOICE INGEST, and it is the ONE ingest path that does not go through
                # `voice_utils.transcode_normalize` — the candidate is already frozen, so there is
                # nothing to transcode. It therefore also missed the routing that function's
                # docstring exists to explain: a raw `shutil.copyfile` + `atomic_replace` into
                # `voice_samples/` deposits a PLAINTEXT WAV of the user's voice inside the encrypted
                # store, silently, for every voice they ever create. Same shape as the candidates
                # leak fixed at 44e030c, one step further down the same pipeline.
                #
                # The `.part` sibling leaves the tree entirely: it was doing the atomic-landing job,
                # and inside the vault that job belongs to `from_scratch` (whose landing is
                # `vault.open_write()`'s own .part + atomic_replace). It must be a COPY, not a move
                # of `src` — `from_scratch` REMOVES its source, and `src` is the audition candidate,
                # which remains until explicitly deleted, so it can be saved again under
                # another name or keep auditioning it for a month.
                #
                # 🔴 AND `src` IS NOW CIPHERTEXT (7.0-m7). A bare `shutil.copyfile(src, tmp)` would
                # copy the ENCRYPTED bytes and hand them to `from_scratch`, which would encrypt
                # them a second time — a voice that saves without error, appears in every picker,
                # and plays as noise. `child_input` materializes the plaintext and removes it
                # afterward IF AND ONLY IF it was the one that made it, which is the arm that
                # matters on a box that has not migrated: there it returns `src` itself, and the
                # copy below is what keeps the candidate intact.
                with vault_fs.child_input(src, configs.scratch_root()) as plain, \
                        scratch.file(configs.scratch_root(), f"voice-freeze|{dst.name}", ".wav") as tmp:
                    shutil.copyfile(plain, tmp)
                    vault_fs.from_scratch(tmp, dst)
            except Exception as exc:                       # noqa: BLE001
                return jsonify({"error": f"could not save the voice: {exc}"}), 500
            return None

        return _place_voice(str(d.get("name") or ""), write,
                            lambda dst: _save_voice_provenance(token, dst))


    # ── 8.7: clean a voice (de-reverb / enhance) ──────────────────────────
    #
    # A background job, polled, for the same reason Generate is one: the chain is two GPU children
    # and runs tens of seconds, and a request that blocks for that long is a request the browser
    # eventually gives up on while the work carries on invisibly.

    @bp.route("/voices/<name>/clean", methods=["POST"])
    def voices_clean(name):
        """Start a cleaning of `name` and save the result as a NEW voice called `label`.

        🔴 THE ORIGINAL IS NEVER TOUCHED — see `voiceclean`. This validates the three things
        that must be true before a GPU child starts: the source exists, at least one box is
        ticked, and the new name is free. The name check runs AGAIN at save time, minutes later,
        because this one can only speak for the moment it ran (§14.9.1)."""
        p = rt_voices.resolve_ref(name)
        if p is None:
            abort(404)
        d = request.get_json(silent=True) or {}
        dereverb, do_enh = bool(d.get("dereverb")), bool(d.get("enhance"))
        if not (dereverb or do_enh):
            return jsonify({"error": "tick at least one of de-reverb or enhance — otherwise this "
                                     "would just copy the voice."}), 400
        label = str(d.get("label") or "").strip()
        if not label:
            return jsonify({"error": "the new voice needs a name."}), 400
        hit = rt_voices.name_conflict(label)
        if hit is not None:
            return jsonify({"error": rt_voices.conflict_message(label, hit[0])}), 409
        live = voiceclean.running_for(p.name)
        if live is not None:
            return jsonify({"error": "that voice is already being cleaned.",
                            "job_id": live.id}), 409
        job = voiceclean.start(p.name, label, dereverb=dereverb, do_enhance=do_enh)
        return jsonify({"job_id": job.id,
                        "stages": voiceclean.stage_total(dereverb, do_enh)}), 202


    @bp.route("/voices/clean/status/<job_id>")
    def voices_clean_status(job_id):
        job = voiceclean.get(job_id)
        if job is None:
            abort(404)
        with job.lock:
            return jsonify({"status": job.status, "stage": job.stage, "log": list(job.log),
                            "note": job.note,
                            "error": job.error, "voice": job.voice,
                            "dereverbed": job.did_dereverb, "enhanced": job.did_enhance,
                            "skipped": list(job.skipped)})


    @bp.route("/voices/clean/cancel/<job_id>", methods=["POST"])
    def voices_clean_cancel(job_id):
        job = voiceclean.get(job_id)
        if job is None:
            abort(404)
        job.cancel.set()
        return jsonify({"ok": True})


    @bp.route("/voices/<name>", methods=["DELETE"])
    def voices_delete(name):
        p = rt_voices.resolve_ref(name)          # real on-disk file, any audio ext (not just .wav)
        if p is None:
            abort(404)
        in_use = rt_voices.in_use(p.name)
        vault_fs.unlink(p)                    # §4.10 — voice_samples/ is routed; a raw unlink
                                              # raises FileNotFoundError on a voice that is there
        # its provenance sidecar, if it had one — through vault_fs, or under encryption the unlink
        # asks after a plaintext name that is not on disk and the sidecar outlives its voice.
        vault_fs.unlink(rt_voices.prov_path(p), missing_ok=True)
        return jsonify({"ok": True, "name": p.name, "in_use": in_use})


    @bp.route("/voices/<name>/audio")
    def voices_audio(name):
        p = rt_voices.resolve_ref(name)          # real on-disk file, any audio ext (not just .wav)
        if p is None:
            abort(404)
        # ?download=1 saves it under the LABEL, not the on-disk name (§14.2) — the filename is
        # plumbing (and opaque ciphertext in 5.x), so handing the user "Sarah warm_a3f9c.wav"
        # would export our bookkeeping instead of their voice.
        download = _b(request.args, "download")
        if not download:
            # 🔴 RANGE SUPPORT IS WHAT MAKES THE SCRUB BAR WORK — it is not "serving it in pieces".
            # A browser asks `Range: bytes=0-` and gets the WHOLE clip in one response either way;
            # what Accept-Ranges/206 additionally buys is SEEKABILITY. Turning it off here (M10d)
            # left a player that played perfectly and silently refused to scrub: Chrome reports a
            # seekable range ending at 0 and discards every currentTime write, so the playhead
            # snaps back as though the click never landed. Pinned by the seek assertions in
            # tests/voices_player_browser_spec.mjs.
            return send_store_file(p)
        label = voice_utils.get_labels(paths.VOICE_SETTINGS).get(p.name) or p.stem
        stem = Path(rt_voices.wav_name(label)).stem          # sanitized: a label may hold path characters
        return send_store_file(p, as_attachment=True,
                               download_name=stem + (p.suffix or ".wav"))


    @bp.route("/voices/<name>/settings", methods=["GET", "PUT"])
    def voices_settings(name):
        """Per-voice settings for ONE voice-keyed tab (?context=book|playground,
        default book) plus the shared `global` metadata (label/advanced). Nomi and
        SillyTavern settings are per-ENTITY, not per-voice — they live on PUT /nomi
        and PUT /st/characters, so those contexts are rejected here."""
        # Key by the REAL on-disk filename (what NomiSpeaker.resolve/st_speech/the stream
        # register all look up), not rt_voices.wav_name's forced '.wav' — otherwise a .mp3/.flac
        # voice's tuning is stored under a phantom '<stem>.wav' key and silently never
        # applied at render time (and a same-stem .wav voice gets clobbered). Falls back
        # to rt_voices.wav_name only when the voice doesn't resolve on disk.
        ref = rt_voices.resolve_ref(name)
        vname = ref.name if ref is not None else rt_voices.wav_name(name)
        context = request.args.get("context", "book")
        if context not in voice_utils.CONTEXTS:
            return jsonify({"error": f"unknown context: {context!r}"}), 400
        if request.method == "GET":
            return jsonify(voice_utils.get_settings(paths.VOICE_SETTINGS, vname, context))
        data = request.get_json(force=True) or {}
        # A rename is a rename of the IDENTITY (4.8-m3): the label is the uniqueness namespace
        # across both sub-tabs, so it gets the same conflict check a save does. `exclude=vname`
        # keeps a voice from colliding with itself (re-saving its own label, or changing only
        # its case). An empty label is "back to the filename" and is always allowed.
        if "label" in data:
            want = str(data.get("label") or "").strip()
            hit = rt_voices.name_conflict(want, exclude=vname) if want else None
            if hit:
                return jsonify({"error": "exists", "name": want,
                                "message": rt_voices.conflict_message(want, hit[0])}), 409
        try:
            return jsonify(voice_utils.save_settings(paths.VOICE_SETTINGS, vname, data, context))
        except voice_utils.SettingsUnreadable as exc:
            return jsonify({"error": f"voice_settings.yaml is corrupt — refusing to save, "
                                     f"which would wipe other voices ({exc}). Fix the file."}), 500


    @bp.route("/voices/<name>/favorite", methods=["POST"])
    def voices_favorite(name):
        """★ a voice. Body: {favorite: bool}. The fourth list on the one shape the other three
        already use (`_fav_body` and the /voiceswap favorite routes, 4.2-m0e).

        The flag lives in the sidecar the voice already has, NOT in a central favorites file
        (§16.2): the sidecar is written with the voice and deleted with it, and the filename is
        immutable for life (§14.6), so a favorite physically cannot detach from its voice or
        outlive it. A central store would need its own deletion hook and would accumulate an
        orphan entry for every voice ever deleted, silently, forever.

        🔴 A voice with no usable sidecar gets the FULL shape the backfill would have written,
        never a lone {"favorite": true} (§16.2a). backfill-voice-sidecars.py skips any voice that
        already has a sidecar — correct for its job, a trap for this one: a minimal write here
        would make it skip that voice PERMANENTLY, so it would never receive `origin` or
        `created`. Nothing would look broken either, because a missing origin reads as "uploaded",
        which is the right answer — the only symptom would be a voice with no add-date sitting in
        a list whose default order is by add-date. (An unreadable sidecar takes the same branch:
        the codebase already treats a corrupt one as "no recorded provenance" everywhere, so
        stamping it repairs the store rather than preserving bytes nothing can read.)

        🔴 The write RAISES rather than degrading to a warning (§16.8). Here the write IS the
        request, so a failure has to reach the user as a 5xx and fire favToggle's error modal."""
        p = rt_voices.resolve_ref(name)
        if p is None:
            abort(404)
        # vault_fs.stat: a bare p.stat() on an encrypted voice_samples/ raises FileNotFoundError,
        # and nothing here catches it — every ★ on a sidecar-less voice would 500. None means the
        # clip vanished under us mid-request, which is a backfilled date of 0 rather than a failure:
        # the ★ the user just clicked is the request, and the date is the guess beside it.
        st = vault_fs.stat(p)
        side = rt_voices.read_sidecar(p) or {"origin": "uploaded",
                                          "created": st.mtime if st is not None else 0.0,
                                          "backfilled": True}
        side["favorite"] = params.favorite_body()
        try:
            rt_voices.write_sidecar_or_raise(p, side)
        except OSError as exc:
            logger.warning(f"voices: couldn't save favorite for {p.name}: {exc}")
            return jsonify({"error": f"couldn't save the favorite: {exc}"}), 500
        return jsonify({"ok": True, "favorite": side["favorite"]})


    @bp.route("/voices/<name>/clear_cache", methods=["POST"])
    def voices_clear_cache(name):
        """Invalidate every cached render that used this voice — Nomi /speak AND
        SillyTavern messages. The MD5 cache key includes the voice file's mtime,
        so bumping it re-keys them all (no way to enumerate the one-way hashes).
        The audio conditionals are untouched — only the cache identity moves.

        Until 11.2.9 the bump was ALL it did, and the stale entries sat on disk
        until the per-speaker LRU cap aged them out. It now also deletes the cache
        sub-trees of every speaker currently on this voice (`_speaker_voices`),
        which is what makes the "cached messages" count beside the button fall.

        The playground clip library is a SEPARATE system (user-managed files) and
        is deliberately untouched — EXCEPT audition preview clips: if the caller
        sends {"audition_text": ...}, clips of that exact text with this voice are
        deleted too, so the cluster's cached-audition player doesn't keep replaying
        a take the user just cleared."""
        ref = rt_voices.resolve_ref(name)
        if ref is None:
            return jsonify({"error": f"unknown voice: {name}"}), 404
        # Routed: `ref` is a voice_samples/ path, so the bare os.utime raised FileNotFoundError
        # and this endpoint — whose ONLY mechanism is the mtime bump described above — 500'd
        # without invalidating anything. Every stale Nomi and SillyTavern render survived it.
        vault_fs.utime(ref)
        # 11.2.9 — and DELETE the sub-trees of every speaker on this voice, so the disk space
        # comes back and the "cached messages" field beside the button drops to zero. The
        # bump alone left every old file on disk until the per-speaker cap aged it out; see
        # NomiSpeaker.clear_owner.
        owners = sorted(o for o, vs in _speaker_voices().items() if ref.name in vs)
        msgs = size = 0
        for o in owners:
            n, b = rt_nomi.NOMI.clear_owner(o)
            msgs += n
            size += b
        data = request.get_json(force=True, silent=True) or {}
        aud_text = str(data.get("audition_text", "") or "")
        swept = []
        if aud_text:
            root = OUTPUT_DIR / "playground"
            refs = [c["ref"] for c in playground_clips.list_clips(root)
                    if c.get("text") == aud_text and c.get("voice") == ref.name]
            swept = playground_clips.delete_clips(root, refs)
        logger.info(f"voice cache cleared (mtime bump): {ref.name} — deleted {msgs} message(s), "
                    f"{size} bytes across {len(owners)} speaker(s)"
                    + (f" + {len(swept)} audition clip(s)" if swept else ""))
        return jsonify({"ok": True, "voice": ref.name,
                        "messages_deleted": msgs, "bytes_deleted": size,
                        "audition_clips_deleted": len(swept)})

    @bp.route("/voices/cache_stats")
    def voices_cache_stats():
        """`{"voices": {<voice filename>: {"messages": n, "bytes": b}}}` — how many Nomi and
        SillyTavern messages are cached for the speakers on each voice, and their size. The
        "cached messages" field beside every 🧹 Clear reads this (11.2.9).

        ONE request for every voice, not one per row: the SillyTavern tab can hold dozens of
        rows and each speaker's count is a stat per cached file. A voice nobody speaks with is
        absent, which the UI shows as zero. `bytes` is the PLAINTEXT size (vault_fs.stat)."""
        usage = {}
        by_owner = {}
        for owner, voices in _speaker_voices().items():
            n, b = rt_nomi.NOMI.owner_usage(owner)
            by_owner[owner] = {"messages": n, "bytes": b}
            if not n:
                continue
            for v in voices:
                if not v:
                    continue      # speaks with no voice at all; no 🧹 button can reach it
                u = usage.setdefault(v, {"messages": 0, "bytes": 0})
                u["messages"] += n
                u["bytes"] += b
        # 11.3.0 — per CHARACTER as well, keyed the way the UI rows are (ST registry key, Nomi
        # ID), from the same walk: each speaker folder is stat'd once for both answers.
        speakers = {"st": {}, "nomi": {}}
        for kind, key, owner, _v in _speakers():
            speakers[kind][key] = by_owner.get(owner, {"messages": 0, "bytes": 0})
        return jsonify({"voices": usage, "speakers": speakers})

    @bp.route("/voices/cache/clear_speaker", methods=["POST"])
    def voices_cache_clear_speaker():
        """Delete ONE character's (or one Nomi's) cached messages. Body: `{"kind": "st"|"nomi",
        "key": <registry key | Nomi ID>}`. 11.3.0 — the 🧹 on a character row.

        Unlike `/voices/<name>/clear_cache` there is NO mtime bump: that re-keys every speaker
        on the voice, which is exactly what clearing one character must not do. Deleting the
        folder is enough on its own — every entry this speaker can look up lives in it."""
        data = request.get_json(force=True, silent=True) or {}
        kind, key = str(data.get("kind", "")), str(data.get("key", ""))
        hit = [owner for k, kk, owner, _v in _speakers() if k == kind and kk == key]
        if not hit:
            return jsonify({"error": f"unknown {kind or 'speaker'}: {key!r} — save the row "
                                     f"first"}), 404
        n, b = rt_nomi.NOMI.clear_owner(hit[0])
        logger.info(f"speaker cache cleared: {kind} {key!r} — deleted {n} message(s), {b} bytes")
        return jsonify({"ok": True, "messages_deleted": n, "bytes_deleted": b})

    return bp
