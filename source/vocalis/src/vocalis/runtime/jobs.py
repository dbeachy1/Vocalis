"""The job registry: one `Job` shape and one `JOBS` dict, shared by five feature domains.

Moved out of `vocalis_server.py` in 5.1-P2 (5.1-refactor §5.1, §7 Phase 3).

**Why this was the first thing to move.** `JOBS` is written by playground, enhance, train,
cleanup and books, and read by six — discriminated only by the `kind` string field. As long as
it sat in the server module, none of those five could be split out of it: every one of them
would have had to reach back up for the registry, which is the import direction that took the
vault down (see `tests/test_import_graph.py`). Extracting it is a precondition for the rest of
the refactor, not a tidy-up.

**What did not move AT THE TIME, and where it all ended up.** This paragraph used to say that
`run_job`, `run_playground_job`, `_vram_ticker` and `_job_sse` "stay in `vocalis_server` until
the layers they depend on are here". That was true when written and is now false for all four,
so it is corrected rather than deleted — a stale "stays in X" sentence is the same hypothesis-
masquerading-as-fact that left ledger item 3.10 parked for three phases. `job_sse` came here in
P4.2 and `vram_ticker` (plus `job_or_404`) in P4.10a, once the pool and the GPU gate had runtime
homes; `run_job` left with the Books tab (P4.11) and `run_playground_job` with the Playground
(P4.12), because each turned out to be its domain's code rather than shared machinery. This
module is still deliberately narrow: the registry, a shape, a dict, a lock, and the helpers that
maintain them.

🔴 **`emit` is the only thread-safe thing here, and only for `events`/`subscribers`.** The rest
of a `Job`'s fields — `status`, `error`, `clip_ref`, `audio_s`, `cap_upto` — are written by
worker threads and read by HTTP pollers with no lock at all. That is pre-existing behavior and
this move does not change it; it is written down here because it is the sort of thing a reader
of a file called `jobs.py` will reasonably assume is handled, and it is not.

`JOBS_LOCK` guards **membership of the dict**, nothing more.
"""
import json
import queue
import threading
from dataclasses import dataclass, field
from pathlib import Path  # noqa: F401  (kept for annotations added later)

from flask import Response, abort

import enhance
from loguru import logger
from tts_utils import GenParams

# 5.1-P4.10a: `vram_ticker` samples the hardware strip. gpu.py imports nothing from this
# package, so this edge cannot close into a cycle.
from vocalis.runtime import gpu

# NOT enhance.NFE_DEFAULT read at call time: a Job's enhance settings are fixed when it starts,
# because they are part of the render's identity. Reading it here, once, is the point.
NFE_DEFAULT = enhance.NFE_DEFAULT

# The Playground's optional truncation. A budget over ONE clip: it stops a single render
# overshooting, and cannot stop you over-generating across several (training's 60-minute
# limit is a budget over the whole DATASET — a different thing with the same number).
#
# 5.1-P4.12: it lives here, beside `cap60`/`cap_hit`/`cap_upto`, because it is read from both
# sides of the playground split — `_pg_cap_check` enforces it and `/enhance/info` reports it,
# and §4.3 files that route under **system**. Two modules reading one constant is exactly the
# shape that needs a runtime home rather than a second copy. Reached THROUGH this module at
# both sites (`jobs.CAP_SECONDS`), never re-exported: six test sites rebind it to 2.0/3.0 to
# make the cap fire in a unit test, and a second name is one those patches would miss.
CAP_SECONDS = 3600.0


@dataclass
class Job:
    id: str
    docx: str
    voice: str
    params: GenParams
    gpus: str
    workers: int
    status: str = "queued"          # queued|running|done|failed|canceled
    error: str = None
    only_section: int = None        # regenerate a single chapter when set
    regen_swap: list = field(default_factory=list)       # [(orig, bak)] planned moves, executed under GPUS
    regen_chunks: str = None                             # chunks dir to drop when the swap runs
    regen_backups: list = field(default_factory=list)    # [(backup_path, original_path)] actually moved
    sections: list = field(default_factory=list)
    output_dir: str = None
    out_name: str = ""              # output folder / library name ("<book> (Narrator)")
    started_at: float = 0.0         # epoch when run_job began — lets a reloaded page restore real elapsed
    kind: str = "book"              # "book" | "playground" — routes a reloading page to the right tab
    text: str = ""                  # playground: the full text being rendered (restored on reload)
    narrate_actions: bool = True    # playground: speak *action* spans (False = dialogue only)
    clip_h: str = ""                # playground: identity hash — names the workspace + clip file suffix
    clip_ref: str = ""              # playground: the finished clip's ref — pollers (Audition) play it
    # 4.1 — bandwidth extension. Fixed at start (it is part of the clip's identity and,
    # for a book, of the book's), so it is never toggled mid-render.
    enhance: bool = False
    enhance_nfe: int = NFE_DEFAULT      # NOT enhance.NFE_DEFAULT — see the note above
    # 4.1 — the Playground's 60-minute cap. This one IS live: you may tick it during a
    # render, having realized the text is longer than you thought and wanting to walk
    # away. It is read at each chunk boundary, never mid-chunk.
    cap60: bool = False
    cap_hit: threading.Event = field(default_factory=threading.Event)
    cap_upto: int = 0               # chunks the cap froze the clip at (0 = the cap never fired)
    audio_s: float = 0.0            # contiguous banked audio so far — the live duration counter
    # 8.0-m1d — the ACE-Step escape hatch, and the ONLY field that kind adds.
    #
    # 🔴 A SONG'S ~70 PARAMETERS DO NOT BECOME NAMED FIELDS. This dataclass already carries two
    # kinds' worth — every `regen_*`, `cap*` and `clip_*` above means nothing to the other one —
    # and a third layer of that is how one shared shape turns into three shapes in a trenchcoat.
    # So ACE-Step's parameter set, its chosen backend and the upstream task_id live in here, and
    # `kind="acestep"` routes a reloading page to the right tab exactly as "book" and
    # "playground" already do.
    #
    # ⚠️ WRITE IT UNDER `lock`, unlike everything above it. See the 🔴 note in the module header:
    # `status`, `error` and friends are written by workers and read by pollers with NO lock, and
    # that has survived only because book and playground render ONE job at a time. ACE-Step means
    # two backends generating concurrently, each with its own result poller, plus the queue's own
    # writer — more concurrent writers than this registry has ever had. Do not inherit the
    # ambient convention here.
    detail: dict = field(default_factory=dict)
    events: list = field(default_factory=list)          # ring buffer for reconnect
    subscribers: list = field(default_factory=list)     # live SSE queues
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


JOBS = {}
JOBS_LOCK = threading.Lock()
EVENT_CAP = 5000
JOBS_KEEP = 30          # cap retained jobs so the dict + event buffers can't grow unbounded


def prune_jobs():
    """Drop the oldest FINISHED jobs beyond JOBS_KEEP so JOBS (and each job's up-to
    EVENT_CAP event buffer + subscriber list) can't grow without bound over a long
    server lifetime. Running/queued jobs are always kept. Call under JOBS_LOCK."""
    finished = [j for j in JOBS.values() if j.status in ("done", "failed", "canceled")]
    for j in finished[:max(0, len(JOBS) - JOBS_KEEP)]:
        JOBS.pop(j.id, None)


def emit(job: Job, ev: dict):
    """Append an event to the job's buffer and fan out to live SSE subscribers.
    Thread-safe: called from worker threads and the vram ticker.

    `vram` ticks (1/s, momentary state) are fanned out live but NOT buffered:
    buffering them would flood the replay ring within ~80 minutes and evict the
    structural events (job_start, sections, early log lines) that a reloaded
    page replays to rebuild its live log. Only the latest VRAM state matters,
    and a reconnecting client gets a fresh tick within a second anyway.

    `audio` (the running duration counter) is the same shape: it is a LEVEL, one per
    chunk, and only the newest value means anything. A reconnecting page reads the
    current figure straight off /book/status rather than replaying 600 stale ones."""
    with job.lock:
        if ev["type"] not in ("vram", "audio"):
            job.events.append(ev)
            if len(job.events) > EVENT_CAP:
                del job.events[:len(job.events) - EVENT_CAP]
        for q in job.subscribers:
            q.put(ev)

# ── The SSE tail ─────────────────────────────────────────────────────────────
# 5.1-P4.2: shared by voiceswap, stems, bulk and train — four domains, so it could not
# live in any one blueprint. §4 always had it here; Phase 2 moved the registry and left
# this behind because nothing needed it yet.

def job_sse(job):
    """Ring-buffer replay + live tail, ending at a terminal event — the same
    generator voiceswap/events uses, shared by the phase-②/③ routes."""
    def stream():
        q = queue.Queue()
        with job.lock:
            backlog = list(job.events)
            job.subscribers.append(q)
        terminal = ("job_done", "error", "canceled")
        try:
            for ev in backlog:
                yield f"data: {json.dumps(ev)}\n\n"
                if ev["type"] in terminal:
                    return
            while True:
                ev = q.get()
                yield f"data: {json.dumps(ev)}\n\n"
                if ev["type"] in terminal:
                    break
        finally:
            with job.lock:
                if q in job.subscribers:
                    job.subscribers.remove(q)

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# ── Shared with more than one blueprint (5.1-P4.10a) ─────────────────────────
# `vram_ticker` folds the hardware strip into a job's SSE stream and `job_or_404` is
# how every polling route reaches a job; books and playground each held a reference to
# both. They belong beside JOBS/emit rather than in either tab.

def vram_ticker(job: Job, stop: threading.Event):
    """Push a hardware-strip sample 4x/s while a job runs (folds the strip into the SSE
    stream so the UI needn't poll during a job — design §5.0b).

    4 Hz, not 1: the strip's bars glide from one sample to the next, and at 1 Hz that
    glide is a visible staircase.

    `cpu` rides along with the cards because the UI stops its idle poll for the duration
    of a job — without it here, the CPU line would sit frozen for the whole render, which
    is exactly the stretch worth watching."""
    warned = False
    while not stop.is_set():
        try:
            emit(job, {"type": "vram", **gpu.strip_sample()})
            warned = False
        except Exception:
            if not warned:              # log the first failure with traceback, not 4/s spam
                warned = True
                logger.exception("VRAM ticker failed — the UI strip will freeze until it recovers")
        stop.wait(0.25)


def job_or_404(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        abort(404)
    return job
