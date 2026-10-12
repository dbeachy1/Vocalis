"""Join an ordered list of clips into a new scene. Probe each input; stream-copy matching codecs and re-encode mismatches to the best input profile. Store the output and per-entry offsets as a scene manifest."""
import subprocess
import threading
import time
import uuid
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

import clip_sources
import mp3_concat
import scenes
import scratch as scratch_mod
import vault_fs
from scene_build import DEFAULT_GAP_S, clamp_gap, interleave_with_gap, make_silence
from tts_utils import ffprobe_duration

# A joined scene's own ceiling. Join is unauthenticated only in the sense that everything behind
# the admin cookie is; this is a sanity bound on a list that arrives as JSON, and it is well past
# any real selection.
MAX_JOIN_ITEMS = 500

# Ceilings for the re-encode target, so a malformed probe cannot ask ffmpeg for something absurd.
MAX_BITRATE_K = 320
MAX_CHANNELS = 2


@dataclass
class JoinJob:
    """One Join, from the 202 to the scene.

    Deliberately NOT `scene_build.SceneJob`: that dataclass carries `cancel`/`lock`/`events`/
    `subscribers` to satisfy the enhancer's duck type, plus render bookkeeping (`cached`,
    `total` as "speakable messages") that means nothing here. Reusing it would mean explaining
    in five docstrings why half its fields are always zero. The *status vocabulary* is shared on
    purpose, because the client polls both the same way.
    """
    id: str
    title: str
    gap_s: float = DEFAULT_GAP_S
    status: str = "queued"          # queued|probing|assembling|done|failed|canceled
    total: int = 0
    done: int = 0
    ref: str = None
    error: str = None
    duration_s: float = 0.0
    reencoded: bool = False         # whether the profiles disagreed — shown, because it is slow
    created: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event)

    def as_dict(self) -> dict:
        return {"job_id": self.id, "status": self.status, "total": self.total,
                "done": self.done, "ref": self.ref, "error": self.error,
                "reencoded": self.reencoded,
                "duration_s": round(self.duration_s, 2) if self.duration_s else None}


JOBS = {}
JOBS_LOCK = threading.Lock()

# The statuses that mean "this join still owns the verb". Named ONCE because `running()` and
# `start()` both test it, and a guard whose two halves disagree about what "in flight" means is
# worse than no guard.
ACTIVE = ("queued", "probing", "assembling")


class JoinBusy(RuntimeError):
    """Raised by `start()` when a join is already in flight. Carries the job so the route can
    put its id in the 409 — the client uses it to reattach rather than just being refused."""

    def __init__(self, job):
        super().__init__("a join is already running")
        self.job = job


def probe(path) -> dict:
    """One input's audio profile: `{codec, sample_rate, channels, bit_rate}`.

    ffprobe rather than the sidecars, deliberately — the sidecars record what a store believes
    about its own files, and Join's whole risk is a file that is not what its store assumes.
    Missing fields come back as None and force the re-encode branch, which is the safe default:
    an unknown profile is exactly the case where a stream copy is a gamble.
    """
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate",
         "-of", "default=noprint_wrappers=1:nokey=0", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        return {"codec": None, "sample_rate": None, "channels": None, "bit_rate": None}
    got = {}
    for line in (r.stdout or "").splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            got[k.strip()] = v.strip()

    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None
    return {"codec": got.get("codec_name") or None,
            "sample_rate": _int(got.get("sample_rate")),
            "channels": _int(got.get("channels")),
            "bit_rate": _int(got.get("bit_rate"))}


def profiles_agree(profs) -> bool:
    """True when a stream copy is valid: every input is mp3 and agrees on rate and channels.

    ⚠️ **Bitrate is deliberately NOT part of this test.** The concat demuxer is happy to copy a
    96 kbps frame after a 256 kbps one — MP3 is a frame format and players handle mixed-rate
    files, which is what a VBR file already is. Rate and channel count are the two that actually
    break playback, because they are decoded per frame but drive one output device configuration.
    Including bitrate here would force a full re-encode every time a scene met its own enhanced
    twin, which is the single most likely thing anyone joins.
    """
    if not profs:
        return False
    if any(p.get("codec") != "mp3" for p in profs):
        return False
    if any(p.get("sample_rate") is None or p.get("channels") is None for p in profs):
        return False
    return (len({p["sample_rate"] for p in profs}) == 1
            and len({p["channels"] for p in profs}) == 1)


def target_profile(profs) -> dict:
    """The best of the inputs — see this module's docstring on why best and not default."""
    rates = [p["sample_rate"] for p in profs if p.get("sample_rate")]
    chans = [p["channels"] for p in profs if p.get("channels")]
    rates_k = [p["bit_rate"] for p in profs if p.get("bit_rate")]
    return {
        "sample_rate": max(rates) if rates else 24000,
        "channels": min(MAX_CHANNELS, max(chans)) if chans else 1,
        "bitrate_k": min(MAX_BITRATE_K, max(1, round(max(rates_k) / 1000))) if rates_k else 96,
    }


def transcode(src, dest, target: dict) -> Path:
    """One input re-encoded to the join's target profile."""
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(src),
         "-ar", str(target["sample_rate"]), "-ac", str(target["channels"]),
         "-b:a", f"{target['bitrate_k']}k", "-c:a", "libmp3lame",
         str(dest), "-loglevel", "error"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"could not re-encode {Path(src).name}: {r.stderr.strip()}")
    return dest


def _own_copy(stack: ExitStack, path: Path, root: Path) -> Path:
    """The same rule `scene_build._own_copy` exists for, and for the same reason.

    🔴 `vault_fs.child_input` returns THE ORIGINAL PATH on a plaintext install, by design. A
    join that leaned on it would be reading the user's live library files while ffmpeg walked
    them — and unlike a scene build, Join's inputs include the Playground store, which a render
    finishing in another tab can overwrite in place (clips are identity-keyed and a re-render
    replaces them). Copy unconditionally when `child_input` did not already copy.
    """
    import shutil
    plain = Path(stack.enter_context(vault_fs.child_input(path, root)))
    if plain != Path(path):
        return plain
    own = stack.enter_context(scratch_mod.file(root, f"join-src|{path}", plain.suffix or ".mp3"))
    shutil.copyfile(plain, own)
    return own


def run_join(job: JoinJob, items: list, *, output_dir, vt_cfg=None, scratch_root=None) -> JoinJob:
    """Resolve, probe, assemble, and write the scene. Mutates and returns `job`.

    `items` is the ORDERED list the user built: `[{kind, ref}, …]`. Order is the payload's
    order and nothing here re-sorts it — §7's "default order is the order ticked, arrows fix
    the rest" makes ordering the client's business entirely.
    """
    # 🔴 INSIDE the try, all three. They look like plain assignments, but `scenes_root` and
    # `scratch_root()` both touch the filesystem and can raise — and this runs on a thread whose
    # only report is `job.status`. A raise out here would leave the job at "queued" forever,
    # which `running()` reads as "a join is in flight", which 409s every future join for the
    # life of the process. Every exit from this function has to land on a terminal status.
    try:
        sroot = scenes.scenes_root(output_dir)
        root = scratch_root if scratch_root is not None else scratch_mod.scratch_root()
        job.total = len(items)
        with ExitStack() as stack:
            job.status = "probing"
            srcs, entries, profs = [], [], []
            for it in items:
                if job.cancel.is_set():
                    job.status = "canceled"
                    return job
                kind, ref = str(it.get("kind") or ""), str(it.get("ref") or "")
                p = clip_sources.resolve(output_dir, vt_cfg, kind, ref)
                if p is None or not vault_fs.exists(p):
                    # NAMED, not skipped silently. A join is an explicit ordered list the user
                    # built by hand; quietly dropping one of its items produces a file that is
                    # wrong in a way only careful listening finds (§9's rule about the skipped
                    # message, applied to the verb that has no cache to fall back on).
                    job.status = "failed"
                    job.error = f"{kind} clip {ref!r} is not there any more — nothing was joined."
                    return job
                own = _own_copy(stack, p, root)
                srcs.append(own)
                profs.append(probe(own))
                entries.append({"kind": kind, "ref": ref,
                                "name": str(it.get("name") or ref),
                                # What the part CONTRIBUTES to the join (packet durations),
                                # not its gapless-trimmed format duration — see
                                # `mp3_concat.contributed_s`.
                                "duration_s": round(
                                    mp3_concat.contributed_s(own, scratch_root=root), 3)})
                job.done += 1

            if not srcs:
                job.status = "failed"
                job.error = "nothing was selected to join"
                return job

            job.status = "assembling"
            target = None
            if not profiles_agree(profs):
                target = target_profile(profs)
                job.reencoded = True
                logger.info(f"join {job.id}: profiles differ, re-encoding to {target}")
                out = []
                for i, s in enumerate(srcs):
                    if job.cancel.is_set():
                        job.status = "canceled"
                        return job
                    dst = stack.enter_context(
                        scratch_mod.file(root, f"join-enc|{job.id}|{i}", ".mp3"))
                    out.append(transcode(s, dst, target))
                srcs = out
                # The durations were measured on the ORIGINALS; a re-encode can shift them by a
                # frame, and the offsets below are what the Chapters list seeks to. Re-measure.
                for e, s in zip(entries, srcs):
                    e["duration_s"] = round(
                        mp3_concat.contributed_s(s, scratch_root=root) or e["duration_s"], 3)

            gap = None
            if job.gap_s > 0:
                gap = stack.enter_context(scratch_mod.file(root, f"join-gap|{job.id}", ".mp3"))
                # 🔴 The silence must match the OUTPUT profile, not the app default. On the
                # re-encode branch that is the target; on the copy branch every input already
                # agrees, so the first one speaks for all of them. A 24 kHz mono silence spliced
                # into a 44.1 kHz stereo join is the exact failure `make_silence`'s own comment
                # warns about — the file plays at the wrong rate from the first gap onward.
                sr = (target or {}).get("sample_rate") or profs[0].get("sample_rate") or 24000
                ch = (target or {}).get("channels") or profs[0].get("channels") or 1
                make_silence(gap, job.gap_s, sample_rate=int(sr), channels=int(ch))

            # The gap is measured like the parts: a silence MP3 of `gap_s` is whole frames, so it
            # is longer than `gap_s` in the join (0.7 s -> 0.768 s at 24 kHz mono).
            gap_len = mp3_concat.contributed_s(gap, scratch_root=root) if gap else 0.0
            offset = 0.0
            for i, e in enumerate(entries):
                e["offset_s"] = round(offset, 3)
                offset += e["duration_s"] + (gap_len if i < len(entries) - 1 else 0.0)
            job.duration_s = offset                  # provisional: replaced by the file's probe
            logger.info(f"join {job.id}: {len(entries)} parts, gap {gap_len:.3f} s, "
                        f"summed length {offset:.3f} s")

            # Check cancellation after concatenation and before promotion; stream-copy is fast, but a cancel in this interval must still discard the result.
            if job.cancel.is_set():
                job.status = "canceled"
                return job

            created = scenes.now()
            # Identity: the ordered (kind, ref) pairs ARE what this scene is made of, standing
            # in for §4's cache keys. `created` participates for the same reason it does there —
            # a re-join is a second artifact and must not land on the first.
            #
            # 🔴 And the NONCE is what actually delivers that here. `created` is
            # second-resolution and a join of two short clips takes a tenth of one, so joining
            # the same selection twice in a row hashed identically and the second scene
            # overwrote the first. See `scenes.now_exact`.
            nonce = scenes.now_exact()
            h = scenes.scene_hash(title=job.title, owner="join", gap_s=job.gap_s,
                                  cache_keys=[f"{e['kind']}:{e['ref']}" for e in entries],
                                  created=created, nonce=nonce)
            stem = scenes.scene_stem(job.title, h)
            vault_fs.mkdir(sroot)
            mp3 = sroot / f"{stem}.mp3"
            mp3_concat.concat_mp3(interleave_with_gap(srcs, gap) if gap else srcs,
                                  mp3, scratch_root=root)

            # And again on the far side, because the concat is a single subprocess that is not
            # interrupted — a cancel pressed while it ran arrives here with the file already
            # landed. `concat_mp3` stages in the scratch and only calls `from_scratch` on
            # success, so there is exactly one artifact to take back and it is complete.
            #
            # ⚠️ Order matters: remove the MP3 *before* the manifest is written, never after.
            # A manifest with no audio is a row in the Clips tab that plays nothing, and
            # `list_scenes` would keep showing it; an mp3 that never gets a manifest was never
            # a scene at all.
            if job.cancel.is_set():
                vault_fs.unlink(mp3, missing_ok=True)
                job.status = "canceled"
                return job

            # The stored total is the finished file's own length, the figure a player shows.
            probed = ffprobe_duration(mp3)
            if probed:
                logger.info(f"join {job.id}: joined file probes {probed:.3f} s "
                            f"(summed {job.duration_s:.3f} s)")
                job.duration_s = probed
            else:
                logger.warning(f"join {job.id}: could not probe the joined file; "
                               f"keeping the summed {job.duration_s:.3f} s")

            scenes.write_manifest(sroot / f"{stem}.yaml", {
                "title": job.title, "source": "join", "owner": "join", "chat": "",
                "created": created, "gap_s": job.gap_s, "enhanced": False,
                "total_duration_s": round(job.duration_s, 2),
                "nonce": nonce, "reencoded": job.reencoded,
                "entries": entries, "skipped": [],
            })
            job.ref = stem
    except BaseException as exc:             # noqa: BLE001 — VaultAuthError is not an Exception
        logger.exception("join failed")
        job.status = "failed"
        job.error = str(exc) or exc.__class__.__name__
        return job
    job.status = "done"
    return job


def start(title: str, items: list, *, gap_s=None, output_dir, vt_cfg=None) -> JoinJob:
    """Kick a join off on its own thread and return the job immediately (the 202).

    ⚠️ ONE AT A TIME, like `/v1/audio/scene`, and for a plainer reason than the render pool:
    two joins both writing into `output/scenes/` through the scratch is fine, but a user who
    double-clicks Join gets two identical scenes with different timestamps and no way to tell
    which to keep. Raises `JoinBusy` (→ the route's 409) when one is already in flight.

    🔴 **The check and the claim are ONE atomic step, under `JOBS_LOCK`.** They used to be two:
    the route called `running()`, and if that came back None it called this function, which
    registered the job. Two requests could both pass the test before either registered —
    a double-click on a slow box, or the browser retrying a POST — and both joins would run.
    The nonce added above means they no longer overwrite each other, so the symptom would be
    exactly the pair of near-identical scenes this guard exists to prevent, which is the kind of
    race that is invisible in testing and reported as "why are there two of these?".
    """
    job = JoinJob(id=uuid.uuid4().hex[:12], title=title, gap_s=clamp_gap(
        DEFAULT_GAP_S if gap_s is None else gap_s))
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.status in ACTIVE:
                raise JoinBusy(j)
        JOBS[job.id] = job
    t = threading.Thread(target=run_join, args=(job, items),
                         kwargs={"output_dir": output_dir, "vt_cfg": vt_cfg},
                         daemon=True, name=f"join-{job.id}")
    t.start()
    return job


def running() -> JoinJob:
    """The join in flight, or None. READ-ONLY — a status view, not the guard.

    ⚠️ Do not gate a new join on this. By the time the caller acts on the answer another thread
    may have started one; `start()` holds the lock across both the test and the registration,
    which is why the guard lives there and this only reports.
    """
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.status in ACTIVE:
                return j
    return None
