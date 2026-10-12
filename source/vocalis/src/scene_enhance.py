"""Enhance an existing scene only through an explicit Clips action, after the raw artifact is stored. Write a separate twin whose identity includes enhancement settings, carries the source nonce and raw_ref, and uses the enhanced speech bitrate. Keep enhancement outside the scene-build lock."""
import threading
import time
import uuid
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

import scenes
import scratch as scratch_mod
import vault_fs
from tts_utils import ffprobe_duration     # 7.5.1 — the twin's length is measured, not inherited

# The status vocabulary the client polls, kept the same shape as `scene_edit.EditJob` because the
# Clips tab polls both with one loop.
ACTIVE = ("queued", "enhancing")


class EnhanceBusy(RuntimeError):
    """Raised by `start()` when THIS scene is already being enhanced. Carries the job so the route
    can put its id in the 409 and the row can reattach to it rather than merely be refused.

    Same shape as `scene_edit.EditBusy` / `clip_join.JoinBusy`, and for the same reason.
    """

    def __init__(self, job):
        super().__init__("this scene is already being enhanced")
        self.job = job


@dataclass
class EnhanceJob:
    """One enhancement, from the 202 to the twin.

    ⚠️ **`lock`, `events` and `subscribers` are here to satisfy a DUCK TYPE**, exactly as
    `scene_build.SceneJob`'s are: `runtime.enhancement.enhance_one` takes a `runtime.jobs.Job`
    and uses `job.cancel` to abort mid-enhance and `emit(job, …)` to narrate. Reusing that
    function is the point — it is the one place in the app the enhancer is ever run — and a
    second enhancer invocation written to avoid a dataclass field is the kind of divergence this
    release keeps refusing to make.
    """
    id: str
    src_ref: str
    title: str = ""
    nfe: int = 32
    device: str = ""
    status: str = "queued"          # queued|enhancing|done|failed|canceled
    ref: str = None                 # the twin, once it exists
    error: str = None
    est_s: float = None
    created: float = field(default_factory=time.time)

    # Stamp started when enhancer work begins because the estimate includes model load and audio processing, but excludes decode and card wait.
    # The phase follows run_enhance so the UI can explain a zero-progress model load without guessing child state.
    started: float = None
    phase: str = ""                 # decoding|enhancing|encoding — see run_enhance

    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    events: list = field(default_factory=list)
    subscribers: list = field(default_factory=list)

    # `enhance_one` reads this off the job for its own logging; the scene's own job carried it
    # under the same name.
    @property
    def enhance_nfe(self) -> int:
        return self.nfe

    def last_line(self):
        """The most recent line the enhancer printed, or None.

        Derived from `events` rather than stored separately: `enhance_one` already emits every
        non-noise child line through `emit()`, which is what fills that list, so a second copy
        would be a second thing to keep in step. The one line worth surfacing is the card-lock
        wait ("Waiting for cuda:1 (a training is using it)…") — a job that has not started
        because something else owns the card, which is otherwise indistinguishable from a job
        that has stalled.

        ⚠️ Truncated. It is our own subprocess's output, not user data, but it reaches a table
        cell and a stray 4 KB traceback line would wreck the row.
        """
        with self.lock:
            for ev in reversed(self.events):
                if ev.get("type") == "log" and ev.get("line"):
                    return str(ev["line"])[:200]
        return None

    def as_dict(self) -> dict:
        return {"job_id": self.id, "status": self.status, "ref": self.ref,
                "src_ref": self.src_ref, "error": self.error, "device": self.device,
                "est_s": round(self.est_s, 1) if self.est_s else None,
                # 9.2.1 — the progress trio. `elapsed_s` is None until the enhancer starts, which
                # is the client's signal to show a phase rather than a fraction; `est_s` is None
                # on a box that has never been timed, which is its signal to sweep rather than
                # invent a percentage (`enhance.estimate_seconds`: "NONE IS A REAL ANSWER AND
                # CALLERS MUST RENDER IT").
                "phase": self.phase or None,
                "elapsed_s": round(time.time() - self.started, 1) if self.started else None,
                "line": self.last_line()}


JOBS = {}
JOBS_LOCK = threading.Lock()
JOBS_KEEP = 20
#: 11.2.7 — called with the job after it reaches a terminal status AND its card is released.
#: `scene_enhance_queue` registers here so a finishing enhancement fills its card at once rather
#: than on the queue's next 30 s retry. A hook that raises is logged and never reaches the job.
ON_FINISH: list = []


def running_for(ref: str):
    """An enhancement in flight for THIS scene, or None.

    Deliberately per-scene and not per-box: `claim_card` already gives one enhancement per CARD,
    and two scenes enhancing on two cards is two child processes on two cards — which is what
    the book's own post-pass has always done. What must not happen is the same scene twice, which
    would race two writers for one twin path.
    """
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.src_ref == ref and j.status in ACTIVE:
                return j
    return None


def start(src_ref: str, *, title: str, nfe: int, device: str, output_dir, est_s=None,
          scratch_root=None) -> EnhanceJob:
    """Register the job and run it on its own thread. The CARD IS ALREADY CLAIMED by the caller.

    🔴 The claim happens in the request, synchronously, not here and not on the thread — that is
    what closes the double-book window (`GpuGate.claim_card`'s own docstring), and it is what
    lets the route answer 409 with a reason a human can read instead of starting something that
    fails later.

    ⚠️ The caller must release the card if THIS raises: no thread means no `finally`, and the
    card is then lost for the life of the process. `playground_clip_enhance` learned that one.
    That now includes `EnhanceBusy` — a refusal is a raise like any other, and the card claimed
    for the request that lost the race has to go back.

    🔴 **The busy test and the registration are ONE atomic step, under `JOBS_LOCK`.** They used
    to be two, in two modules: the route called `running_for(ref)` and this function registered
    without re-testing. Between them sat `enhance.bandwidth_of` — an ffmpeg decode of the whole
    scene — so the window was hundreds of milliseconds wide. Two clicks on one row both passed
    the test, and on a two-card box `claim_card` gave each of them a card of its own, so two
    ~21 GB enhancers ran one scene and raced two writers for one twin path. On a ONE-card box it
    was hidden: the second request's `claim_card` returned None and it 409'd on the card instead.
    `scene_edit.start` and `clip_join.start` already carried this lesson; this one was written
    without it. `tests/test_scene_enhance_race.py` is the regression.
    """
    job = EnhanceJob(id=uuid.uuid4().hex[:12], src_ref=src_ref, title=title, nfe=int(nfe),
                     device=str(device), est_s=est_s)
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.src_ref == src_ref and j.status in ACTIVE:
                raise EnhanceBusy(j)
        for finished in [j for j in JOBS.values()
                         if j.status in ("done", "failed", "canceled")][:-JOBS_KEEP]:
            JOBS.pop(finished.id, None)
        JOBS[job.id] = job
    try:
        threading.Thread(target=run_enhance, args=(job,),
                         kwargs={"output_dir": output_dir, "scratch_root": scratch_root},
                         daemon=True, name=f"scene-enh-{job.id}").start()
    except BaseException:
        # 🔴 No thread means the job never runs, and `queued` is in ACTIVE — so leaving it in the
        # registry makes the scene permanently un-enhanceable: every later POST 409s against a
        # job that will never move, the poll reports `queued` for ever, and the pruning above
        # only touches terminal jobs. `v1_scene_create` handles the identical case the same way.
        with JOBS_LOCK:
            JOBS.pop(job.id, None)
        raise
    return job


def run_enhance(job: EnhanceJob, *, output_dir, scratch_root=None) -> EnhanceJob:
    """Enhance a raw scene into a separate 256 kbps artifact while retaining the original. Keep card release in finally so path, directory, or background-cleanup failures cannot strand the enhancement resource."""
    from vocalis.runtime.gpu import GPUS

    # ⚠️ `root` and `sroot` USED TO BE COMPUTED HERE, above the `try`, which contradicted the
    # docstring directly above: `scenes_root(output_dir)` raises TypeError on a None output_dir
    # and `scratch_root()` can raise on a misconfigured install, and either would kill this
    # thread with the card still in `GPUS._cards` — after which no render of any kind could ever
    # start again on the box, and no other enhancement could have that card, until a restart.
    stem = None
    try:
        root = Path(scratch_root) if scratch_root is not None else scratch_mod.scratch_root()
        sroot = scenes.scenes_root(output_dir)

        import enhance as enhance_mod
        import playground_clips

        from vocalis.runtime import enhancement

        job.status = "enhancing"
        job.phase = "decoding"
        root.mkdir(parents=True, exist_ok=True)
        raw_mp3 = sroot / f"{job.src_ref}.mp3"
        with ExitStack() as stack:
            src = stack.enter_context(scratch_mod.file(root, f"scene-enh-src|{job.id}", ".wav"))
            dst = stack.enter_context(scratch_mod.file(root, f"scene-enh-dst|{job.id}", ".wav"))
            # The enhancer reads with soundfile and cannot open an MP3, and ffmpeg has no DEK —
            # so the routed scene is materialized first and decoded in the scratch.
            with vault_fs.child_input(raw_mp3, root) as plain_mp3:
                enhancement.decode_to_wav(plain_mp3, src)
            # 🔴 THE CLOCK STARTS HERE, and `enhance_one` may still wait minutes or hours for a
            # card a training is holding — that wait is INSIDE this span and there is no way to
            # exclude it without splitting the shared helper. It is why the row shows the
            # enhancer's own "Waiting for cuda:N" line (see `last_line`) rather than a bar that
            # would be quietly wrong for the length of a training.
            job.phase = "enhancing"
            job.started = time.time()
            if not enhancement.enhance_one(job, src, dst, job.nfe, job.device, "the scene"):
                job.status = "canceled"
                return job
            # Check cancellation after enhancement and before encoding or writing the twin manifest; a late cancel must not create a completed twin that blocks a retry.
            if job.cancel.is_set():
                job.status = "canceled"
                return job
            created = scenes.now()
            manifest = scenes.read_manifest(sroot / f"{job.src_ref}.yaml") or {}
            h = scenes.scene_hash(
                title=manifest.get("title") or job.title,
                owner=manifest.get("owner") or "",
                gap_s=float(manifest.get("gap_s") or 0.0),
                cache_keys=[e.get("cache_key", "") for e in (manifest.get("entries") or [])],
                created=manifest.get("created") or created,
                # 🔴 The RAW scene's nonce, not a fresh one. Two raw scenes built in the same
                # second are told apart by their nonces; their twins are derived from the same
                # `created` and cache keys, so without carrying the nonce across the twins would
                # collide with each other even though the raws did not. Absent for a scene built
                # before 6.0-m2, which is exactly the pre-existing behavior.
                nonce=str(manifest.get("nonce") or ""),
                enhanced=True, nfe=job.nfe)
            stem = scenes.scene_stem(manifest.get("title") or job.title, h, enhanced=True)
            # Tens of seconds on a long scene, and NOT part of `est_s` — so the phase changes and
            # the bar holds at its ceiling rather than pretending the remaining time is compute.
            job.phase = "encoding"
            playground_clips.encode_mp3(dst, sroot / f"{stem}.mp3",
                                        bitrate=enhance_mod.mp3_bitrate(True))
            # Measure the enhanced output instead of copying the raw duration. Probe the plaintext source WAV; probing the vault-routed MP3 would see ciphertext and require materializing a large file.
            # If measurement fails, leave the duration absent rather than report the raw scene's value.
            measured = None
            try:
                measured = ffprobe_duration(str(dst))
            except BaseException:                        # noqa: BLE001
                logger.warning("could not measure the enhanced twin's duration")
            meta = dict(manifest)
            meta.pop("total_duration_s", None)
            if measured:
                meta["total_duration_s"] = round(float(measured), 2)
            meta.update({"enhanced": True, "nfe": job.nfe, "created": created,
                         # The pair is linked by DATA, not by a shared hash: `enhanced` is folded
                         # into the identity (the same rule `clip_hash` follows, so the two takes
                         # can never race for one path), which necessarily gives them different
                         # H8s. Without this field the Clips tab could not tell which raw scene
                         # an enhanced one came from.
                         "raw_ref": job.src_ref})
            scenes.write_manifest(sroot / f"{stem}.yaml", meta)
            job.ref = stem
        job.phase = ""
        job.status = "done"
    except BaseException as exc:                     # noqa: BLE001
        # BaseException catches VaultAuthError, which is deliberately not an Exception (5.0 M1
        # §1). A failed enhancement is a failed JOB, not a crashed thread: the status has to say
        # so, or the row polls something that never moves again. The RAW scene is untouched
        # either way — it is complete, playable and downloadable.
        logger.exception("scene enhance failed")
        job.status = "failed"
        job.error = str(exc) or exc.__class__.__name__
        if stem is not None and job.ref is None:
            # The twin's mp3 landed but its manifest did not — an mp3 with no manifest was never
            # a scene, and nothing else will ever clean it up. Same rule `build_scene` keeps.
            try:
                vault_fs.unlink(scenes.scenes_root(output_dir) / f"{stem}.mp3", missing_ok=True)
            except BaseException:                        # noqa: BLE001
                logger.warning(f"could not remove the orphaned twin {stem}.mp3")
    finally:
        # 🔴 §2.3's fix, the other half of it. The claim is in the request and the release is
        # here, in a `finally` that no early return and no exception can skip — including the
        # cancel path above, which returns from inside the `try`.
        GPUS.release_card(job.device)
        for hook in list(ON_FINISH):
            try:
                hook(job)
            except Exception:                            # noqa: BLE001 — a hook is not the job
                logger.exception(f"scene enhance: a finish hook raised for {job.id}")
    return job
