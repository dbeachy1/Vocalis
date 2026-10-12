#!/usr/bin/env python3
"""Build a scene by rendering or reusing a contiguous message range, joining entries with configured gaps, and writing the scene artifact. Explicit builds use the normal interactive render path even when the model is cold; they do not wait behind speculative prerenders. Copy source entries into owned scratch for the full render and concat interval so cache eviction cannot shorten the result. The route layer owns HTTP and job registration."""
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

import mp3_concat
import scenes
import scratch as scratch_mod
import vault_fs
from mp3_render import cache_hit
from tts_utils import ffprobe_duration
from vocalis.runtime.gpu import GPUS

# The gap between messages (§3.4). Back-to-back is too fast to listen to — it reads as one
# person talking over themselves — and there is a mechanical reason too: MP3 frame boundaries
# leave a small artifact at every join that a stream copy cannot avoid. A silence at the same
# profile solves both at once, because the artifact then lands inside a deliberate pause.
DEFAULT_GAP_S = 0.7
MAX_GAP_S = 10.0

# The app-standard speech profile. Every ST cache entry is encoded by `mp3_render` at the pool's
# sample rate, mono, 96 kbps — which is what makes `-c copy` valid across the whole scene. The
# silence MUST match it or the concat produces a file whose second half plays at the wrong rate.
SILENCE_BITRATE = "96k"
DEFAULT_SR = 24000


@dataclass
class SceneJob:
    """One build, from the 202 to the second artifact.

    ⚠️ **`cancel`, `lock`, `events` and `subscribers` are here to satisfy a DUCK TYPE, not
    because a scene needs an event stream.** They were for `runtime.enhancement.enhance_one`,
    which takes a `runtime.jobs.Job` and uses exactly those four. 6.3 moved the enhancement out
    to `scene_enhance.EnhanceJob`, which carries the same four for the same reason — `cancel`
    stays here because the BUILD is cancellable, and the rest because the render path emits
    through them.
    """
    id: str
    title: str
    owner: str
    gap_s: float = DEFAULT_GAP_S
    # 6.3: `enhance` and `enhance_nfe` are gone with the phase they configured. The request
    # field went too rather than being defaulted false — a field the server ignores is a worse
    # lie than no field.
    source: str = "st"                  # "st" | "nomi" — §8, and never a route that assumes
    chat: str = ""

    status: str = "queued"              # queued|rendering|assembling|done|failed|canceled
    total: int = 0                      # speakable messages in the range
    done: int = 0                       # finished, cached or freshly rendered
    cached: int = 0                     # of those, ones that cost nothing
    skipped: list = field(default_factory=list)
    error: str = None
    ref: str = None                     # the scene — set the moment the manifest lands
    duration_s: float = 0.0
    created: float = field(default_factory=time.time)

    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    events: list = field(default_factory=list)
    subscribers: list = field(default_factory=list)

    def as_dict(self) -> dict:
        """What `GET /v1/audio/scene/<id>` answers.

        ⚠️ No message text, no character names, and no per-entry anything. This is polled every
        second or two for the length of a build, and §5.1's rule about the manifest applies with
        more force to something that crosses the wire that often.
        """
        # 6.3: `enhanced_ref` and `enhancing` are GONE, not defaulted. A build no longer
        # enhances, so a field that was always null and a flag that was always false would be
        # two lies the extension would go on branching on — and its "cancel keeps the
        # un-enhanced one" copy would describe a state that cannot happen.
        return {"job_id": self.id, "status": self.status, "total": self.total,
                "done": self.done, "cached": self.cached, "skipped": len(self.skipped),
                "ref": self.ref,
                "duration_s": round(self.duration_s, 2) if self.duration_s else None,
                "error": self.error}


class LinkedCancel(threading.Event):
    """An Event that is set when EITHER it or the build's own cancel is set.

    🔴 WITHOUT THIS, THE FIRST MESSAGE CANCELS THE WHOLE SCENE. `Mp3Render.close()` ends with
    `self.cancel.set()` — deliberately, and correctly: it is how a disconnected client's GPU work
    is stopped, and it runs on EVERY close, including the clean one at the end of a successful
    render. `prerender` never noticed because its Event is per-job and the job is over by then.
    A scene build renders 74 messages against ONE job, so handing `job.cancel` straight to
    `Mp3Render` means message 1 finishes, sets it, and messages 2–74 are skipped as canceled.

    The symptom is a scene that is one message long and a job that reports `canceled` having
    done everything right. Found by test, not by reading — which is the argument for the test.

    So each render gets its own flag, and reads the build's through this. `wait()` is overridden
    too: nothing on the render path calls it, but an Event whose `is_set` and `wait` disagreed
    would be a trap laid for whoever adds the first caller.
    """

    def __init__(self, parent: threading.Event):
        super().__init__()
        self._parent = parent

    def is_set(self) -> bool:
        return super().is_set() or self._parent.is_set()

    def wait(self, timeout=None) -> bool:
        if self._parent.is_set():
            return True
        return super().wait(timeout)


def clamp_gap(value) -> float:
    """A gap the user typed, made safe. Negative is meaningless and a large one is a way to
    turn a 46-minute scene into an eight-hour one by typo."""
    try:
        g = float(value)
    except (TypeError, ValueError):
        return DEFAULT_GAP_S
    return max(0.0, min(MAX_GAP_S, g))


def make_silence(dest: Path, seconds: float, *, sample_rate: int = DEFAULT_SR,
                 channels: int = 1) -> Path:
    """Generate one silence MP3 at the active speech sample rate and channel count so it matches the concat output profile."""
    import subprocess
    dest.parent.mkdir(parents=True, exist_ok=True)
    layout = "mono" if int(channels) <= 1 else "stereo"
    r = subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={int(sample_rate)}:cl={layout}",
         "-t", f"{max(0.0, float(seconds)):.3f}", "-b:a", SILENCE_BITRATE,
         str(dest), "-loglevel", "error"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"could not make the gap silence: {r.stderr.strip()}")
    return dest


def _own_copy(stack: ExitStack, cpath: Path, root: Path) -> Path:
    """Return a plaintext copy owned by this build and remove it on exit. child_input may return the original path on an unencrypted store, so make an explicit copy when the path did not change; this protects the build from cache eviction on every install."""
    import shutil
    plain = Path(stack.enter_context(vault_fs.child_input(cpath, root)))
    if plain != Path(cpath):
        return plain                    # child_input decrypted it into the scratch: already ours
    own = stack.enter_context(scratch_mod.file(root, f"scene-src|{cpath}", ".mp3"))
    shutil.copyfile(plain, own)
    return own


def interleave_with_gap(paths: list, gap: Path) -> list:
    """Interleave sources with a gap only between adjacent entries, never at the beginning or end. Shared by scene builds and clip joins so both paths use identical gap semantics."""
    out = []
    for i, p in enumerate(paths):
        if i:
            out.append(gap)
        out.append(p)
    return out


def build_scene(job: SceneJob, items: list, *, render_one, output_dir, nomi=None,
                sample_rate: int = DEFAULT_SR, scratch_root=None, render_many=None) -> SceneJob:
    """Run one build to completion. Mutates and returns `job`.

    `items` are RESOLVED requests — the dicts `resolve_st_request` returns, each carrying
    `key`, `cpath`, `text`, `gen_kwargs`, `character` and `owner`. Resolution happens in the
    route, synchronously, so a bad range fails at the door with a real error instead of inside a
    background thread nobody is watching.

    `render_one(item, cancel)` renders one message and promotes it into the speech cache. It is
    a parameter because it is the only part of this that needs a GPU.

    6.3: there is no `enhance_fn` any more. A build lands the scene and stops; enhancing it is
    a verb on the row (`scene_enhance.start`).
    """
    root = Path(scratch_root) if scratch_root is not None else scratch_mod.scratch_root()
    root.mkdir(parents=True, exist_ok=True)
    sroot = scenes.scenes_root(output_dir)

    job.total = len(items)
    job.status = "rendering"

    # Scene builds share the GPU lock with Books and Playground renders. Acquiring the lock prevents a build from loading a replica while enhancement or another render owns card memory. Use a timed, cancellation-aware wait so users can cancel before acquiring it.
    waited = False
    while not GPUS.acquire(timeout=0.5):
        if job.cancel.is_set():
            job.status = "canceled"
            return job
        if not waited:
            waited = True
            logger.info("scene build: waiting for the GPUs (another render or an enhancement "
                        "is using them)…")
    try:
        # 🔴 ONE ExitStack over BOTH phases — see the module docstring. The plaintext copies
        # collected here are what the concat reads, so nothing is looked up in the cache again
        # after this point and an eviction mid-build cannot shorten the scene.
        with ExitStack() as stack:
            plains, entries = [], []
            # 🔴 6.2-m6 — render everything that is MISSING in batched submissions FIRST, so the
            # loop below finds it cached. Deliberately a pre-pass rather than a rewrite of the
            # loop: the ordering, the ExitStack, the skip reporting and the per-message fallback
            # all stay exactly as they were, and anything this does not manage is simply still
            # missing when the loop reaches it. See `render_group_through_the_pool` for why the
            # per-message path could not batch — 69-80% of messages never produced two batchable
            # chunks, so a scene build was running at an effective batch size of about 1.3.
            # 🔴 What the pre-pass PRODUCED, so the loop below does not count it as a cache hit.
            # `hit` is derived from `cache_hit(cpath)` AFTER the batch has populated the
            # cache, so without this every message the pre-pass just rendered read as free: a
            # 74-message cold build reported "74 were cached" for four minutes of GPU, and
            # `cached` is the number the estimate bar is calibrated against.
            prebatched = set()
            if render_many is not None:
                missing = [i for i in items if not cache_hit(Path(i["cpath"]))]
                if len(missing) > 1:
                    produced = render_many(missing, LinkedCancel(job.cancel))
                    prebatched = set(produced or ())
                    if job.cancel.is_set():
                        job.status = "canceled"
                        return job
            for item in items:
                if job.cancel.is_set():
                    job.status = "canceled"
                    return job
                cpath = Path(item["cpath"])
                hit = cache_hit(cpath)
                if not hit:
                    # Its OWN flag, linked to the build's — see LinkedCancel. Handing
                    # `job.cancel` down here is a one-message scene.
                    render_one(item, LinkedCancel(job.cancel))
                    if job.cancel.is_set():
                        job.status = "canceled"
                        return job
                    if not cache_hit(cpath):
                        # Use `cache_hit`, not `exists`: a render may leave a file that is too short to contain audio. Skipping it prevents a silent placeholder from entering the scene.
                        job.skipped.append({"mesid": item.get("mesid"),
                                            "reason": "render produced no audio"})
                        continue
                plain = _own_copy(stack, cpath, root)
                # 🔴 What this part CONTRIBUTES to the join (its packet durations), not its
                # gapless-trimmed format duration — see `mp3_concat.contributed_s`. The offsets
                # below are sums of these, so they have to be the lengths the join really has.
                dur = mp3_concat.contributed_s(plain, scratch_root=root)
                entries.append({
                    "mesid": item.get("mesid"),
                    "character": item.get("character", ""),
                    # 11.2.5 — SillyTavern's own avatar filename for that speaker, when the
                    # extension sent one. The Clips row's face is looked up by it; by name alone,
                    # a card and a persona (or two cards) sharing a name drew only the initial.
                    "character_avatar": item.get("character_avatar", ""),
                    "voice": (item.get("gen_kwargs") or {}).get("voice") or "",
                    # 🔴 §4: the CACHE KEY is the identity — a hash of the cleaned text, which
                    # is what the audio actually is. `mesid` rides along as a hint for jumping
                    # back to the message and is never the identity: it is an array index, it
                    # shifts when a message is deleted, and a swipe changes a message's text
                    # without changing it.
                    "cache_key": item["key"],
                    "chars": len(item.get("text") or ""),
                    "duration_s": round(dur, 3),
                    "text": item.get("text", ""),
                })
                plains.append(plain)
                job.done += 1
                job.cached += 1 if (hit and item["key"] not in prebatched) else 0

            if not plains:
                job.status = "failed"
                job.error = ("nothing in that range had any speakable audio"
                             if items else "the range was empty")
                return job
            if job.cancel.is_set():
                job.status = "canceled"
                return job

            # ── assemble (§3.3, §3.4) ────────────────────────────────────────────────────
            job.status = "assembling"
            gap = None
            if job.gap_s > 0:
                gap = stack.enter_context(scratch_mod.file(root, f"scene-gap|{job.id}", ".mp3"))
                make_silence(gap, job.gap_s, sample_rate=sample_rate)

            # The gap is measured the same way as the parts: a 0.7 s silence MP3 is 32 frames =
            # 0.768 s in the join, and `job.gap_s` would under-count it by 68 ms every time.
            gap_len = mp3_concat.contributed_s(gap, scratch_root=root) if gap else 0.0
            offset = 0.0
            for i, e in enumerate(entries):
                e["offset_s"] = round(offset, 3)     # §5: this is the chapter list, free
                offset += e["duration_s"] + (gap_len if i < len(entries) - 1 else 0.0)
            job.duration_s = offset                  # provisional: replaced by the file's own probe
            logger.info(f"scene {job.id}: {len(entries)} parts, gap {gap_len:.3f} s, "
                        f"summed length {offset:.3f} s")

            created = scenes.now()
            # `nonce` is what makes a rebuild a SECOND artifact — `created` is second-resolution
            # and an all-cached rebuild finishes inside one second. Persisted below so the
            # enhanced twin can key off the same build rather than off the same clock reading.
            nonce = scenes.now_exact()
            h = scenes.scene_hash(title=job.title, owner=job.owner, gap_s=job.gap_s,
                                  cache_keys=[e["cache_key"] for e in entries], created=created,
                                  nonce=nonce)
            stem = scenes.scene_stem(job.title, h)
            vault_fs.mkdir(sroot)                    # routed: a plain mkdir names it in cleartext
            scene_mp3 = sroot / f"{stem}.mp3"
            mp3_concat.concat_mp3(interleave_with_gap(plains, gap) if gap else plains,
                                  scene_mp3, scratch_root=root)

            # Check cancellation after concatenation and before writing the manifest. If canceled, remove the unpromoted audio and return without a scene reference. Audio without a manifest is not a scene; a manifest without audio would leave a broken Clips entry.
            if job.cancel.is_set():
                vault_fs.unlink(scene_mp3, missing_ok=True)
                job.status = "canceled"
                return job

            # The stored total is the FINISHED file's own length — the truth the player sees —
            # not the sum above, which is the offsets' arithmetic and runs ~50 ms ahead of what
            # a player reports (the joined file's leading delay and end padding are trimmed).
            probed = ffprobe_duration(scene_mp3)
            if probed:
                logger.info(f"scene {job.id}: joined file probes {probed:.3f} s "
                            f"(summed {job.duration_s:.3f} s)")
                job.duration_s = probed
            else:
                logger.warning(f"scene {job.id}: could not probe the joined file; "
                               f"keeping the summed {job.duration_s:.3f} s")

            scenes.write_manifest(sroot / f"{stem}.yaml", {
                "title": job.title, "source": job.source, "owner": job.owner, "chat": job.chat,
                "created": created, "gap_s": job.gap_s, "enhanced": False,
                "nonce": nonce,
                "total_duration_s": round(job.duration_s, 2),
                "entries": entries, "skipped": job.skipped,
            })
            # §3.5a step 1: THE SCENE EXISTS NOW. Playable, downloadable, in the Clips tab —
            # before a single second of enhancement. He hears it seconds after the render
            # instead of a quarter of an hour later, and if the range is wrong he finds out
            # BEFORE the box spends fifteen minutes and a whole card on it.
            job.ref = stem
    except BaseException as exc:                     # noqa: BLE001 — see below
        # BaseException catches VaultAuthError, which is deliberately not an Exception (5.0 M1
        # §1). A build that cannot write is a failed build, not a crashed thread: the status has
        # to say so, or the UI polls a job that never moves again.
        logger.exception("scene build failed")
        job.status = "failed"
        job.error = str(exc) or exc.__class__.__name__
        return job
    finally:
        # Every path out of the try — done, failed, canceled, and each early `return job` inside
        # it. A leaked render gate is worse than the bug this fixes: `claim_card` refuses while
        # `_render` is held, so no enhancement and no other render could ever start again.
        GPUS.release()

    # Scene creation stops after the playable source is saved. Enhancement is a separate Clips action, so the scene is available immediately and a long enhancement does not hold the build lock or block the next build. The enhancement route owns derivation of the enhanced copy.
    job.status = "done"
    return job


def render_through_the_real_path(pool, item, cancel, *, nomi, config=None, scratch_root=None):
    """Render ONE message the way a click does, and promote it into the speech cache.

    This is `prerender._produce` with the queue, the gate and the spool-following taken out —
    it is the same `Mp3Render` on the same pool, which is the point of §3.2. What it is NOT is a
    submission to `PrerenderQueue`: that gate declines while the model is cold, and a scene
    build is an explicit request that must load the model rather than wait for someone to click
    something else.
    """
    from mp3_render import Mp3Render
    from tts_utils import GenParams

    root = Path(scratch_root) if scratch_root is not None else scratch_mod.scratch_root()
    root.mkdir(parents=True, exist_ok=True)
    spool = root / scratch_mod.opaque_name(f"scene|{item['key']}|{uuid.uuid4().hex}", ".mp3")
    render = Mp3Render(pool, item["text"], GenParams(**item["gen_kwargs"]), cancel=cancel,
                       config=config, label=f"scene {item['key'][:8]}")
    render.start()
    try:
        with open(spool, "wb") as fh:
            for block in render.blocks():
                fh.write(block)
    finally:
        render.close()
    if not render.promotable:
        spool.unlink(missing_ok=True)
        return None
    # promote_temp UNLINKS what it is given, so the spool is consumed here rather than leaked.
    nomi.promote_temp(spool, item["key"], item["owner"])
    return render.audio_s


def render_group_through_the_pool(pool, items, cancel, *, nomi, config=None, scratch_root=None):
    """Render MANY messages in one batched submission, then promote each one separately.

    🔴 WHY THIS EXISTS: a scene build was getting almost none of 6.2's batching.

    `build_scene` renders message by message, and a message goes through `Mp3Render` ->
    `stream_message`, which is the low-latency STREAMING path: its first chunk is a `_StreamJob`,
    and `WorkerPool._worker_loop` excludes `_StreamJob` from batching by design. So the only
    chunks that could ever batch were chunks 2..n of a SINGLE message — and measured against
    realistic message lengths, **69–80% of messages never produce two of those**, leaving a mean
    effective batch size of about 1.3 where books were running at 16–32.

    That was a correct decision that quietly stopped being correct. §3 of DESIGN_6_2_BATCHING put
    "interactive streaming" out of scope because streaming trades throughput for latency — right
    when someone is listening to a click. **A scene build is a background job with nobody
    listening**, and it was paying streaming's structure while collecting none of its benefit.

    So the missing messages are rendered here instead: every chunk of every message of one voice
    goes into ONE `run_chunks` submission at BATCH priority, which is the path that batches.

    ⚠️ **The audio and the caching are deliberately unchanged.** This reuses `Mp3Render` — same
    ffmpeg settings, same `promotable` rule, same `promote_temp` — and only swaps where the
    samples come from, through the `make` hook it already had. Nothing here re-implements an
    encode, because "the render is done" and "the render is promotable" is the pair that drifts.

    Grouped by params, because a batch is one voice: `_Batch` carries `params`, and
    `_drain_batch_mates` refuses a job whose batch differs. A two-character scene therefore
    becomes two submissions, not one, and that is not a limitation this can lift.

    Returns {key: audio_seconds} for whatever was promoted; anything absent is left for the
    caller's per-message fallback rather than being reported as done.
    """
    from mp3_render import Mp3Render
    from tts_utils import GenParams, render_messages_in_one_batch

    root = Path(scratch_root) if scratch_root is not None else scratch_mod.scratch_root()
    root.mkdir(parents=True, exist_ok=True)
    done = {}
    # ⚠️ Normalized ONCE, here. The two guards below used to test `cancel is not None` while the
    # per-message `LinkedCancel(cancel)` further down was built unconditionally — so a caller
    # that took those guards at face value and passed None got an `AttributeError` on the writer
    # thread at the first `is_set()`, not the uncancellable render the guards imply. `build_scene`
    # always passes one, so this was latent; it was a trap for the next caller and for any test.
    if cancel is None:
        cancel = threading.Event()

    for _sig, group in _by_params(items):
        if cancel.is_set():
            return done
        params = GenParams(**group[0]["gen_kwargs"])
        try:
            # The flattening and the index bookkeeping live in `tts_utils` because the
            # pre-render queue needs exactly the same thing (6.3-m4) and a second copy of a
            # flat-index-to-message map is precisely where a silent mis-assembly comes from.
            wavs = render_messages_in_one_batch(pool, [i["text"] for i in group], params,
                                                cancel=cancel)
        except Exception as exc:                       # noqa: BLE001
            # A failed submission is not a failed BUILD: every message it covered is simply
            # still missing, and `build_scene`'s existing per-message path renders it. Falling
            # back one message at a time is slow, which is strictly better than a hole.
            logger.warning(f"scene: batched render failed ({exc}) — falling back per message")
            continue

        for pos, item in enumerate(group):
            if cancel.is_set():
                return done
            wav = wavs[pos]
            if wav is None:
                continue                               # incomplete — leave it to the fallback
            spool = root / scratch_mod.opaque_name(f"scene|{item['key']}|{uuid.uuid4().hex}",
                                                   ".mp3")
            # `make` is Mp3Render's own hook for "get the samples from somewhere else". The
            # encode, the promotable rule and the failure handling stay exactly as they are.
            # 🔴 `LinkedCancel`, NOT the caller's flag — the same trap that class was written
            # for, one layer down. `Mp3Render.close()` ends with `self.cancel.set()` on EVERY
            # close, including the clean one, so sharing one Event across the group means
            # message 1 finishes, sets it, and every message after it is skipped as canceled.
            # Caught here by the test asserting both messages are promoted; the symptom in
            # production would have been "the batch only ever renders the first one", which
            # looks like the batching not working rather than like a cancel.
            render = Mp3Render(pool, item["text"], params, cancel=LinkedCancel(cancel),
                               config=config, label=f"scene {item['key'][:8]}",
                               make_stream=lambda _p, _c, _cfg, _w=wav: iter([_w]))
            render.start()
            try:
                with open(spool, "wb") as fh:
                    for block in render.blocks():
                        fh.write(block)
            finally:
                render.close()
            if not render.promotable:
                spool.unlink(missing_ok=True)
                continue
            nomi.promote_temp(spool, item["key"], item["owner"])
            done[item["key"]] = render.audio_s
    return done


def _by_params(items):
    """Group messages by their generation params, preserving order within a group.

    A batch is one voice — `_Batch` carries `params` and `_drain_batch_mates` will not mix two
    batches — so grouping is not an optimization here, it is what makes the submission legal.
    """
    groups = OrderedDict()
    for item in items:
        kw = item.get("gen_kwargs") or {}
        sig = tuple(sorted((k, str(v)) for k, v in kw.items()))
        groups.setdefault(sig, []).append(item)
    return list(groups.items())
