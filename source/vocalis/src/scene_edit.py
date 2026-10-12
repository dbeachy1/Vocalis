"""Edit a scene by stitching existing audio without decoding or re-rendering. Treat untouched runs as source ranges, use replacement or inserted clips as-is, and add fresh gaps between pieces. Coalesce consecutive untouched entries so the number of ffmpeg inputs stays bounded by the number of edits."""
import subprocess
import threading
import time
import uuid
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

import clip_join
import clip_sources
import mp3_concat
import scenes
import scratch as scratch_mod
import vault_fs
from scene_build import DEFAULT_GAP_S, clamp_gap, interleave_with_gap, make_silence
from tts_utils import ffprobe_duration

# A sanity bound on a list that arrives as JSON, well past any real edit session. Same role as
# `clip_join.MAX_JOIN_ITEMS`.
MAX_EDIT_OPS = 200

OPS = ("replace", "insert_before", "insert_after")


class EditError(ValueError):
    """A bad plan — rejected at the door, synchronously, so the client gets a real message
    instead of a job that fails on a thread nobody is watching."""


@dataclass
class EditJob:
    """One Apply, from the 202 to the new scene. Same status vocabulary as `JoinJob` because the
    client polls both the same way; a separate dataclass for the same reason `JoinJob` is not
    `SceneJob` — half of the other's fields would be permanently zero here."""
    id: str
    title: str
    src_ref: str
    gap_s: float = DEFAULT_GAP_S
    status: str = "queued"          # queued|cutting|assembling|done|failed|canceled
    total: int = 0                  # pieces to produce
    done: int = 0
    ref: str = None
    error: str = None
    duration_s: float = 0.0
    created: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event)

    def as_dict(self) -> dict:
        return {"job_id": self.id, "status": self.status, "total": self.total,
                "done": self.done, "ref": self.ref, "error": self.error,
                "src_ref": self.src_ref,
                "duration_s": round(self.duration_s, 2) if self.duration_s else None}


JOBS = {}
JOBS_LOCK = threading.Lock()

# Named ONCE because `running()` and `start()` both test it. A guard whose two halves disagree
# about what "in flight" means is worse than no guard.
ACTIVE = ("queued", "cutting", "assembling")


class EditBusy(RuntimeError):
    """Raised by `start()` when an edit is already in flight. Carries the job so the route can put
    its id in the 409 and the client can reattach rather than merely be refused."""

    def __init__(self, job):
        super().__init__("an edit is already running")
        self.job = job


# ── the plan ──────────────────────────────────────────────────────────────────────────────────

def normalize_ops(ops, n_entries: int) -> list:
    """Validate and order the ops. Raises `EditError` with something a human can act on.

    🔴 **Ops are keyed to ORIGINAL entry indices and are normalized against the ORIGINAL manifest**
    (§6). Two edits must not shift each other's targets: if `replace 3` and `insert_after 7` were
    applied in sequence to a mutating list, the second would land on whatever had moved into 7.
    Nothing in here renumbers anything.
    """
    if not isinstance(ops, list) or not ops:
        raise EditError("there are no edits to apply")
    if len(ops) > MAX_EDIT_OPS:
        raise EditError(f"an edit is capped at {MAX_EDIT_OPS} operations")
    if n_entries <= 0:
        raise EditError("that scene has no entries to edit")

    out, replaced = [], set()
    for raw in ops:
        if not isinstance(raw, dict):
            raise EditError("every edit must be an object")
        op = str(raw.get("op") or "")
        if op not in OPS:
            raise EditError(f"unknown edit {op!r} — expected one of {', '.join(OPS)}")
        try:
            idx = int(raw.get("index"))
        except (TypeError, ValueError):
            raise EditError("every edit needs an integer `index`") from None
        if not 0 <= idx < n_entries:
            raise EditError(f"entry {idx} is not in this scene (it has {n_entries})")
        kind, ref = str(raw.get("kind") or ""), str(raw.get("ref") or "")
        if kind not in clip_sources.KINDS or not ref:
            raise EditError("every edit needs a known `kind` and a `ref`")
        if op == "replace":
            # Two replacements of one entry is not a merge, it is a contradiction: the second
            # would silently win and he would have no way to see which. Refuse it by name.
            if idx in replaced:
                raise EditError(f"entry {idx} is replaced twice — pick one")
            replaced.add(idx)
        out.append({"op": op, "index": idx, "kind": kind, "ref": ref,
                    "text": str(raw.get("text") or "")})

    # Stable by target, then by the payload's own order within a target: several inserts after
    # the same entry keep the order he staged them in, which is the only order he can mean.
    return sorted(out, key=lambda o: (o["index"], OPS.index(o["op"])))


def plan_units(entries: list, ops: list) -> list:
    """The output as an ordered list of units, before any coalescing.

    `('orig', i)` — original entry i, still in the scene.
    `('clip', op)` — a replacement or an inserted clip.

    Walking the ORIGINAL indices in order is what makes insert-before-the-first and
    insert-after-the-last ordinary cases rather than special ones.
    """
    before, after, repl = {}, {}, {}
    for o in ops:
        if o["op"] == "insert_before":
            before.setdefault(o["index"], []).append(o)
        elif o["op"] == "insert_after":
            after.setdefault(o["index"], []).append(o)
        else:
            repl[o["index"]] = o

    units = []
    for i in range(len(entries)):
        units.extend(("clip", o) for o in before.get(i, []))
        units.append(("clip", repl[i]) if i in repl else ("orig", i))
        units.extend(("clip", o) for o in after.get(i, []))
    return units


def coalesce(units: list) -> list:
    """Consecutive `('orig', …)` units become one `('cut', first, last)` piece — see the module
    docstring on why this is not an optimization but the difference between 5 ffmpeg calls and 75.
    """
    out = []
    for u in units:
        if u[0] == "orig" and out and out[-1][0] == "cut" and out[-1][2] == u[1] - 1:
            out[-1] = ("cut", out[-1][1], u[1])
        elif u[0] == "orig":
            out.append(("cut", u[1], u[1]))
        else:
            out.append(u)
    return out


def cut(src: Path, dest: Path, start: float, dur: float) -> Path:
    """Build a fast-seek stream-copy slice from a scene. MP3 frames can be copied at frame boundaries; accept the small frame-level boundary tolerance instead of cutting through a gap."""
    r = subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{max(0.0, start):.3f}", "-t", f"{max(0.0, dur):.3f}",
         "-i", str(src), "-c", "copy", str(dest), "-loglevel", "error"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"could not cut the scene: {r.stderr.strip()}")
    return dest


# ── the stitch ────────────────────────────────────────────────────────────────────────────────

def run_edit(job: EditJob, entries: list, ops: list, *, output_dir, vt_cfg=None,
             src_meta: dict, scratch_root=None) -> EditJob:
    """Cut, gap, concat and write the new scene. Mutates and returns `job`."""
    # 🔴 INSIDE the try, all of it. This runs on a thread whose only report is `job.status`, and
    # `scenes_root`/`scratch_root()` both touch the filesystem and can raise. A raise outside
    # would leave the job at "queued" forever, which `running()` reads as "in flight", which 409s
    # every future edit for the life of the process. Every exit lands on a terminal status.
    try:
        sroot = scenes.scenes_root(output_dir)
        root = scratch_root if scratch_root is not None else scratch_mod.scratch_root()
        src_mp3, _y = scenes.scene_paths(sroot, job.src_ref)
        if src_mp3 is None or not vault_fs.exists(src_mp3):
            job.status = "failed"
            job.error = f"scene {job.src_ref!r} is not there any more — nothing was edited."
            return job

        pieces = coalesce(plan_units(entries, ops))
        job.total = len(pieces)

        with ExitStack() as stack:
            job.status = "cutting"
            # ONE plaintext copy of the scene for the whole job — the same rule
            # `scene_build._own_copy` exists for. `vault_fs.child_input` returns THE ORIGINAL PATH
            # on a plaintext install by design, so leaning on it alone would mean ffmpeg reading
            # the live store while another tab could be writing it.
            plain_src = Path(stack.enter_context(vault_fs.child_input(src_mp3, root)))
            prof = clip_join.probe(plain_src)

            # The gap is made BEFORE the loop (it was after) because the cursor below advances by
            # its MEASURED length: a silence MP3 is whole frames, so a 0.7 s gap contributes
            # 0.768 s to the join — see `mp3_concat.contributed_s`.
            gap = None
            if job.gap_s > 0 and len(pieces) > 1:
                gap = stack.enter_context(scratch_mod.file(root, f"edit-gap|{job.id}", ".mp3"))
                # 🔴 §4.2 — the silence matches the SCENE, not the app default. This is 6.0-m2's
                # `cl=mono` defect waiting to happen a second time, and it is likelier here: a
                # scene may have been rendered by a satellite at another rate while the app
                # default is 24 kHz mono. `make_silence` takes both dimensions since 6.0-m2.
                make_silence(gap, job.gap_s,
                             sample_rate=int(prof.get("sample_rate") or 24000),
                             channels=int(prof.get("channels") or 1))
            gap_len = mp3_concat.contributed_s(gap, scratch_root=root) if gap else 0.0

            paths, new_entries, cursor = [], [], 0.0
            for n, piece in enumerate(pieces):
                if job.cancel.is_set():
                    job.status = "canceled"
                    return job
                if n:
                    cursor += gap_len            # interleave_with_gap puts one BETWEEN each piece

                if piece[0] == "cut":
                    lo, hi = piece[1], piece[2]
                    start = float(entries[lo].get("offset_s") or 0.0)
                    end = (float(entries[hi].get("offset_s") or 0.0)
                           + float(entries[hi].get("duration_s") or 0.0))
                    dst = stack.enter_context(
                        scratch_mod.file(root, f"edit-cut|{job.id}|{n}", ".mp3"))
                    cut(plain_src, dst, start, end - start)
                    # MEASURED, not assumed: a frame-boundary copy is not exactly the arithmetic
                    # length, and these offsets are what the Chapters list seeks to.
                    # What the slice CONTRIBUTES to the join (packet durations): the slice is a
                    # stream-copy MP3 whose own gapless metadata would shorten a format probe.
                    got = mp3_concat.contributed_s(dst, scratch_root=root) or (end - start)
                    for i in range(lo, hi + 1):
                        e = dict(entries[i])
                        # Relative position inside the run is preserved exactly — the run's
                        # internal gaps came along inside the cut.
                        e["offset_s"] = round(cursor + (float(e.get("offset_s") or 0.0) - start), 3)
                        new_entries.append(e)
                    paths.append(dst)
                    cursor += got
                else:
                    op = piece[1]
                    p = clip_sources.resolve(output_dir, vt_cfg, op["kind"], op["ref"])
                    if p is None or not vault_fs.exists(p):
                        # NAMED, never skipped. He chose this clip for this line; dropping it
                        # quietly produces a scene that is wrong in a way only careful listening
                        # finds.
                        job.status = "failed"
                        job.error = (f"{op['kind']} clip {op['ref']!r} is not there any more — "
                                     "nothing was edited.")
                        return job
                    own = clip_join._own_copy(stack, p, root)
                    cprof = clip_join.probe(own)
                    # §4.3 — only the INCOMING clip is ever re-encoded, and only when it disagrees
                    # with the scene. The scene itself is never re-encoded; that is the whole
                    # economy of this feature.
                    if not clip_join.profiles_agree([prof, cprof]):
                        dst = stack.enter_context(
                            scratch_mod.file(root, f"edit-enc|{job.id}|{n}", ".mp3"))
                        own = clip_join.transcode(own, dst, {
                            "sample_rate": prof.get("sample_rate") or 24000,
                            "channels": prof.get("channels") or 1,
                            "bitrate_k": min(clip_join.MAX_BITRATE_K,
                                             max(1, round((prof.get("bit_rate") or 96000) / 1000))),
                        })
                    got = mp3_concat.contributed_s(own, scratch_root=root)
                    if op["op"] == "replace":
                        # 🔴 It stops claiming a `cache_key` that no longer describes its audio.
                        old = dict(entries[op["index"]])
                        old.pop("cache_key", None)
                        old["replaced_with"] = {"kind": op["kind"], "ref": op["ref"]}
                        old["text"] = op["text"] or old.get("text") or ""
                        old["duration_s"] = round(got, 3)
                        old["offset_s"] = round(cursor, 3)
                        new_entries.append(old)
                    else:
                        # 🔴 An inserted entry is NOT a chat message and must not pretend to be
                        # one: no `mesid` (there is nothing to jump back to) and no `cache_key`
                        # (its audio was never in the speech cache). §4's "mesid is a hint, never
                        # the identity" is what makes a null one safe — but every reader has to
                        # tolerate it, which is why the Chapters list grew a row shape for it.
                        new_entries.append({
                            "mesid": None, "inserted": True,
                            "character": "", "text": op["text"] or "",
                            "source_clip": {"kind": op["kind"], "ref": op["ref"]},
                            "duration_s": round(got, 3), "offset_s": round(cursor, 3)})
                    paths.append(own)
                    cursor += got
                job.done += 1

            job.status = "assembling"
            job.duration_s = cursor                  # provisional: replaced by the file's probe
            logger.info(f"edit {job.id}: {len(pieces)} pieces, gap {gap_len:.3f} s, "
                        f"summed length {cursor:.3f} s")

            # 🔴 Cancel on BOTH sides of the concat, and the mp3 removed BEFORE any manifest is
            # written — 6.0-m2a and m2b both had to learn this, in two modules, after the fact.
            # An mp3 with no manifest was never a scene; a manifest with no audio is a permanent
            # row in the Clips tab that plays nothing.
            if job.cancel.is_set():
                job.status = "canceled"
                return job

            created = scenes.now()
            # §5.1 — a NEW scene, never an overwrite. The nonce is what actually delivers that:
            # an edit takes about a second, so two edits of one scene land in the same second and
            # would hash identically without it. That bug was found and fixed in 6.0-m2; this is
            # the third module that must not reintroduce it.
            nonce = scenes.now_exact()
            h = scenes.scene_hash(
                title=job.title, owner="edit", gap_s=job.gap_s,
                cache_keys=[job.src_ref] + [f"{o['op']}:{o['index']}:{o['kind']}:{o['ref']}"
                                            for o in ops],
                created=created, nonce=nonce)
            stem = scenes.scene_stem(job.title, h)
            vault_fs.mkdir(sroot)
            mp3 = sroot / f"{stem}.mp3"
            mp3_concat.concat_mp3(interleave_with_gap(paths, gap) if gap else paths,
                                  mp3, scratch_root=root)

            if job.cancel.is_set():
                vault_fs.unlink(mp3, missing_ok=True)
                job.status = "canceled"
                return job

            # The stored total is the finished file's own length, the figure a player shows.
            probed = ffprobe_duration(mp3)
            if probed:
                logger.info(f"edit {job.id}: edited file probes {probed:.3f} s "
                            f"(summed {job.duration_s:.3f} s)")
                job.duration_s = probed
            else:
                logger.warning(f"edit {job.id}: could not probe the edited file; "
                               f"keeping the summed {job.duration_s:.3f} s")

            scenes.write_manifest(sroot / f"{stem}.yaml", {
                "title": job.title, "source": src_meta.get("source") or "edit", "owner": "edit",
                "chat": src_meta.get("chat") or "", "created": created,
                "gap_s": job.gap_s, "enhanced": False,
                "total_duration_s": round(job.duration_s, 2),
                "nonce": nonce,
                # §5.2 — the pair is linked by DATA, the way `raw_ref` links an enhanced twin.
                "edited_from": job.src_ref,
                "entries": new_entries, "skipped": src_meta.get("skipped") or [],
            })
            job.ref = stem
    except BaseException as exc:            # noqa: BLE001 — VaultAuthError is not an Exception
        logger.exception("scene edit failed")
        job.status = "failed"
        job.error = str(exc) or exc.__class__.__name__
        return job
    job.status = "done"
    return job


def start(src_ref: str, title: str, ops: list, *, entries: list, src_meta: dict,
          gap_s=None, output_dir, vt_cfg=None) -> EditJob:
    """Kick an edit off on its own thread and return the job immediately (the 202).

    🔴 **The check and the claim are ONE atomic step, under `JOBS_LOCK`** — `clip_join.start`'s
    comment explains what happened when they were two, in two separate modules. A `running()`
    call in the route followed by a `start()` here is a test whose answer can go stale before the
    next statement acts on it, and both requests then pass.
    """
    job = EditJob(id=uuid.uuid4().hex[:12], title=title, src_ref=src_ref,
                  gap_s=clamp_gap(DEFAULT_GAP_S if gap_s is None else gap_s))
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.status in ACTIVE:
                raise EditBusy(j)
        JOBS[job.id] = job
    t = threading.Thread(target=run_edit, args=(job, entries, ops),
                         kwargs={"output_dir": output_dir, "vt_cfg": vt_cfg,
                                 "src_meta": src_meta},
                         daemon=True, name=f"edit-{job.id}")
    t.start()
    return job


def running() -> EditJob:
    """The edit in flight, or None. READ-ONLY — a status view, not the guard. Do not gate a new
    edit on this; `start()` holds the lock across both the test and the registration."""
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.status in ACTIVE:
                return j
    return None
