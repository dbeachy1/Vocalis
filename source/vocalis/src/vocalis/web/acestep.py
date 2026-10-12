"""Own `/acestep/*` routes for locally managed children, authorized models and render jobs."""
import random
import threading
import time
import uuid

from store_serve import RANGE_CHUNK_CAP, send_capped_bytes
from flask import Blueprint, Response, abort, jsonify, request
from loguru import logger

import folders
import vault_fs
from vault import VaultAuthError, VaultLocked

from vocalis.runtime import paths
from vocalis.runtime import (acecands, acegen, acelib, acerun, acestage, acestep, acetemplates,
                             jobs)
from vocalis.runtime.acequeue import AceQueue


# Audio responses must support HTTP Range requests so browser players can seek. Include an ETag
# based on the immutable candidate id and length so `If-Range` can validate subsequent requests.
# Cap each 206 response to release browser connections between reads; keep this alias tied to the
# shared cap so all audio routes use the same limit.
AUDIO_CHUNK_CAP = RANGE_CHUNK_CAP


# Candidate audio remains on the ACE-Step backend and is proxied on demand. A stopped backend
# makes those files temporarily unavailable but does not delete them from the vault. Explain a
# connection refusal with the affected backend and recovery action; preserve other exception text
# because unrelated failures do not establish that the audio is safe.
def _fetch_failed(exc: Exception, device: str) -> str:
    """The sentence a candidate whose backend is down deserves, in place of an errno."""
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, ConnectionRefusedError) or "refused" in str(reason).lower():
        where = f"{device}'s " if device else ""
        return (f"{where}ACE-Step backend is not running, so its candidates cannot be played or "
                f"saved right now. The audio is still on the box — press “▶ Start ACE-Step” in "
                f"the header above, then try again. Nothing has been deleted.")
    return f"could not fetch it from {device or 'its backend'}: {exc}"


def _audio_response(data: bytes, *, mimetype: str, etag: str) -> Response:
    """Serve audio through the shared capped-byte sender. Keep this wrapper because the
    ACE-Step routes call it by name; the shared sender applies the cap consistently across
    blueprints.
    """
    return send_capped_bytes(data, mimetype=mimetype, etag=etag)


#: Fetch candidate audio on demand without an in-flight cache or client-side preloading. Each
#: request reads its own bytes, avoiding cache ownership and race complexity. Keep HTTP Range
#: support for seeking; it is independent of caching.


#: The widest value ACE-Step's request model accepts, and the ceiling the Advanced box declares.
SEED_MAX = 2**31 - 2

#: url -> the model that backend reported on the last probe. Written by `_live_backends`, read by
#: `_dispatch`, which may not make a network call. See both for why.
_MODEL_BY_URL: dict = {}

#: url -> {model: [task_type, …]} from that backend's last `/v1/model_inventory` answer. Written
#: by `/acestep/models` and by generate (which warms it before enqueueing), read by `_can_run` —
#: which runs inside the queue's lock and therefore may NOT probe. The tasks are per MODEL and
#: the map is keyed model-inside-url, so a model swap on a card needs no invalidation.
_TASKS_BY_URL: dict = {}

#: (url, model, narrowed tasks) already logged by `_publisher_inventory`, so the log line appears once per change.
_NARROWED_LOGGED: set = set()


def _model_for(url: str, device: str) -> str:
    """What model a job aimed at this card should carry.

    What the card HOLDS, and — only when it holds nothing — what the user SELECTED for it. See
    `acestep.chosen_model`: an empty string here reaches upstream as `config_path=None`, which
    defaults to `acestep-v15-turbo` and quietly ignores the dropdown.

    ⚠️ ONE FUNCTION FOR ALL THREE JOB-BUILDING SITES (press, forever top-up, dispatch rebuild).
    They disagreed before only by accident; the rule belongs in one place because "which model
    does this render use" is exactly the question a second copy would answer differently.
    """
    loaded = _MODEL_BY_URL.get(url) or ""
    chosen = acestep.chosen_model(device) or ""
    answer = loaded or chosen or ""
    # Log the loaded model, selected model, and resolved choice once per card so generation
    # diagnostics show whether the render uses a loaded model or the user's selection.
    logger.info(f"ace-model: device={device} loaded={loaded!r} chosen={chosen!r} -> {answer!r}")
    return answer


def _note_models(insts, probes) -> None:
    """Record each card's actually loaded model from the health probes already collected by the
    caller. `models_initialized` determines whether a model is resident; when false, store
    an empty loaded-model value so the user's selection remains the fallback.
    """
    for _svc, url, _dev in insts:
        got = probes.get(url) or {}
        if got.get("up"):
            was = _MODEL_BY_URL.get(url)
            now = (got.get("model") or "") if got.get("model_loaded") else ""
            _MODEL_BY_URL[url] = now
            # 🔴 9.0.6 — LOGGED ON CHANGE ONLY, because this runs on every 4-second probe. A card
            # that silently stops holding what you loaded, or starts holding something you did
            # not, is the whole question behind "why did the second Generate use turbo" — and the
            # raw probe fields are here because `loaded_model` is a LABEL that is filled in even
            # on a card holding nothing (see this function's own docstring), so the pair is what
            # has to be read, never `model` alone.
            if was != now:
                logger.info(f"ace-model: {_dev} now holds {now!r} (was {was!r}) "
                            f"— probe model_loaded={got.get('model_loaded')!r} model={got.get('model')!r}")


def _url_can_task(url: str, task: str) -> bool:
    """Can the model this backend currently holds run `task`? Unknown = yes.

    ⚠️ THE PERMISSIVE FALLBACK IS DELIBERATE AND BOUNDED. Before the first inventory lands there
    is nothing to gate with, and a queue that refused everything until told would be a silent
    stall — the worse failure. Generate warms the cache on every press, so in practice the gate
    is armed by the time it matters; the fallback survives only on a box nobody has pressed
    Generate on, where there is also nothing to mis-dispatch.
    """
    model = _MODEL_BY_URL.get(url) or ""
    tasks = (_TASKS_BY_URL.get(url) or {}).get(model)
    if not tasks:
        # October 11, 2026: "unknown = yes" no longer covers a model the publisher's table knows. With
        # xl-sft loaded and no inventory yet, Extract used to pass this gate; the table answers without one.
        published = acegen.PUBLISHED_TASKS.get(model)
        return True if published is None else task in published
    # The cache holds the engine's answer narrowed by `_publisher_inventory`; narrowing again is
    # idempotent and keeps the gate right if anything ever stores the engine's raw list.
    return task in acegen.narrow_tasks(model, tasks)


def _publisher_inventory(url: str, inv: dict) -> dict:
    """`inv` (the engine's `/v1/model_inventory` answer, parsed) with each model's tasks narrowed to what its
    publisher lists, plus `task_models` (task -> the models whose publisher lists it) for the page's tooltips.

    The ONE place the page's mode buttons and the dispatch gate get their task lists from: the models route
    and generate's warm-up both come through here, and `_url_can_task` narrows the same way.
    """
    out = dict(inv)
    tasks = {}
    for model, reported in (inv.get("tasks") or {}).items():
        tasks[model] = acegen.narrow_tasks(model, reported)
        if tasks[model] != list(reported or []):
            # Logged on change only (this runs on every tab entry): what the engine claimed and what the
            # publisher's table leaves, because "why is Extract greyed out on xl-sft" is answered by this line.
            key = (url, model, tuple(tasks[model]))
            if key not in _NARROWED_LOGGED:
                _NARROWED_LOGGED.add(key)
                logger.info(f"ace-tasks: {url} {model}: engine reports {list(reported or [])}, "
                            f"publisher lists {tasks[model]}")
    # A backend that did not answer keeps exactly the shape it had (no tasks, nothing to name): the row still
    # renders, and the page takes `task_models` from any backend that did answer.
    if "tasks" in inv:
        out["tasks"] = tasks
    if inv.get("reachable"):
        out["task_models"] = acegen.models_by_task()
    return out


def _can_run(job_id, device, url) -> bool:
    """AceQueue's gate: may this job land on this card? (8.2.5)

    🔴 THE QUEUE IS AFFINITY-FREE AND THAT WAS THE HOLE. Generate makes one job per capable card,
    but a free backend takes the next PENDING job whatever it is — so with turbo and xl-sft live,
    an extract built for the sft card dispatched onto turbo the moment turbo freed first, ran a
    `task_type` that model cannot run, and "fails deeper, or quietly" burned the render. The tab's
    own gating is the UNION of card tasks (any card MAY take the job), which is exactly why the
    pairing has to be checked at the only place that knows which card actually takes it.

    October 11, 2026: the capable card in that story is now the one holding acestep-v15-xl-base (the
    publisher lists Extract, Replace and Complete for it alone; see `acegen.PUBLISHED_TASKS`); the rule
    and the failure it prevents are unchanged.
    """
    job = jobs.JOBS.get(job_id)
    if job is None:
        return True                     # pruned id: let dispatch's own missing-job path free it
    t = (job.detail or {}).get("template") or {}
    return (acestep.can_dispatch(device)
            and _url_can_task(url, acegen.task_type_for(t.get("mode"))))


def _seed_for(settings: dict):
    """This job's seed: the user's if they pinned one, otherwise a fresh random per card.

    🔴 PINNING IT DELIBERATELY BREAKS THE PER-CARD RULE, WHICH IS THE POINT.
    Generate draws one seed per card precisely so a two-card box is not a one-card box rendering
    the same song twice. A pinned seed overrides that, and must: "re-render this exact song with
    one word changed" is a different job from "give me two takes", and only the user knows which
    one they are doing. The Advanced hint says so; the code does not second-guess it.

    ⚠️ Clamped rather than rejected. A seed is a knob, not an instruction — a number out of range
    should render something, not 400 a press that took a paragraph of lyrics to set up.
    """
    raw = (settings or {}).get("seed")
    if raw is None or raw == "":
        return random.randrange(0, SEED_MAX)
    try:
        return max(0, min(SEED_MAX, int(raw)))
    except (TypeError, ValueError):
        return random.randrange(0, SEED_MAX)


def _dispatch(job_id, device, url):
    """AceQueue's hand-off: start one job's worker thread.

    🔴 IT MUST NOT BLOCK. The queue calls this while walking its free backends, and a dispatch
    that waited would hold the pump — `AceQueue.pump` deliberately calls it OUTSIDE its lock so
    this can start a thread without deadlocking.
    """
    job = jobs.JOBS.get(job_id)
    if job is None:
        # ⚠️ `release`, NOT `done` — this runs INSIDE the pump, and `done` pumps. A queue whose
        # head is a run of pruned ids would recurse once per id straight into the recursion
        # limit. Free the slot; the pump's own loop gives the next job its turn.
        QUEUE.release(job_id)
        return
    detail = job.detail or {}
    payload = detail.get("payload") or {}
    # 🔴 A JOB THAT WAS NOT BUILT FOR A PARTICULAR CARD IS REBUILT FOR THE ONE THAT TOOK IT.
    # Generate makes one job per card and bakes that card's model into the payload, which is
    # correct because each job is created for a named card. A Generate-forever top-up cannot work
    # that way: it creates ONE job to keep the queue at depth 1, and which card frees up next is
    # not known until this moment. Left alone it would carry the wrong card's `inference_steps` —
    # 8 turbo steps on an xl-sft card, or 50 on turbo — i.e. a visibly worse or needlessly slow
    # render with nothing on screen explaining it.
    # ⚠️ THE MODEL IS READ FROM A MAP, NEVER PROBED HERE. This must not block: the queue calls it
    # while walking its free backends. `_live_backends` records what each probe saw, and it ran
    # moments ago — the completion that freed this card is what asked for it.
    if detail.get("rebuild"):
        model = _MODEL_BY_URL.get(url) or detail.get("model") or acestep.chosen_model(device) or ""
        # ⚠️ THE REFERENCE IS NOT RE-STAGED HERE, IT IS CARRIED. Staging is I/O and this must not
        # block (see above), and the staged path is card-independent anyway — both units share
        # `/ai-output/acestep-tmp`, which is the reason the design requires a SHARED staging
        # directory rather than one per card.
        payload = acegen.build_payload(template=detail.get("template") or {},
                                       settings=detail.get("settings") or {},
                                       model=model, seed=detail.get("seed"),
                                       reference_path=detail.get("reference_path") or "",
                                       source_path=detail.get("source_path") or "")
        with job.lock:
            job.detail = dict(detail, payload=payload, model=model, device=device)
    threading.Thread(target=acerun.run_job, name=f"acestep-{job_id[:8]}",
                     args=(job, url, device, payload, QUEUE), daemon=True).start()


def _live_backends():
    """The authorized backends that are actually answering, `[(service, url, device)]`.

    🔴 THIS IS WHAT LETS THE QUEUE DRAIN ITSELF. `AceQueue.done` runs in a finished worker's
    `finally` and has to start the next job on the card it just freed, which means knowing what
    backends exist — so it asks this. Before it existed, `enqueue` was the only thing in the
    server that ever called `pump`, and the queue advanced only when new work arrived: three
    songs on two cards left the third at "queued" until you pressed Generate again.

    ⚠️ RE-ASKED EVERY TIME, NEVER CACHED, and both halves are deliberate. `instances()` is not
    cached because authorization is live — a card unticked mid-run must stop taking work — and
    `probe` is what distinguishes an authorized backend from a running one. A cached list would
    keep feeding a card the user has just taken away, or a backend that died ten minutes ago.

    ⚠️ It costs one `/health` request per authorized backend per finished job. Completion is not
    a hot path, and avoiding stale authorization or liveness data is more important than caching.
    """
    insts = acestep.instances()
    probes = acestep.probe_many(insts)
    # 📌 WHAT EACH PROBE SAW, KEPT FOR `_dispatch`. Not a cache of the backend list — that is the
    # thing the docstring above forbids — but a record of the model each url reported the last
    # time anyone asked. `_dispatch` must not block, so it cannot probe; and it runs moments after
    # this, because the job completion that freed the card is what called it.
    _note_models(insts, probes)
    return [(svc, url, dev) for svc, url, dev in insts
            if probes[url]["up"] and probes[url]["model_loaded"] is True
            and acestep.can_dispatch(dev)]


def _new_job(*, template, template_id, settings, device, model, rebuild=False, reference_path="",
             source_path=""):
    """Create and persist a queued ACE-Step job before it enters the queue. Persisting at
    creation lets restart recovery restore queued and in-progress work, not only completed
    candidates.
    """
    template, settings = dict(template or {}), dict(settings or {})
    seed = _seed_for(settings)
    payload = acegen.build_payload(template=template, settings=settings, model=model, seed=seed,
                                   reference_path=reference_path, source_path=source_path)
    job_id = uuid.uuid4().hex
    job = jobs.Job(id=job_id, docx="", voice="", params=None, gpus=device, workers=1,
                   kind="acestep", status="queued")
    # 🔴 THE SUBMITTED DICTS TRAVEL WITH THE JOB, ALONGSIDE THE RESOLVED PAYLOAD.
    # `payload` is what ACE-Step was actually sent, with every model-driven default already filled
    # in; `template`/`settings` are what the USER set, blanks and all. Save copies these onto the
    # library row so clicking it later restores the form exactly as it stood — and restoring the
    # payload instead would pin steps and DCW to one card's model, which is the failure
    # `js/ace/advanced.js` is written to prevent.
    # ⚠️ `acecands.remember` persists `detail`, so this survives a restart for free.
    job.detail = {"payload": payload, "device": device, "model": model, "seed": seed,
                  "template_id": template_id,
                  "template": template, "settings": settings,
                  # Carried so `_dispatch`'s rebuild does not have to re-stage — see there. The
                  # TOKEN stays in `template`; only this is the resolved path, and only this is
                  # allowed to be one (an absolute path saved onto a library row would rot).
                  "reference_path": reference_path or "",
                  # Same rule as the reference: the TOKEN stays on the template so a library row
                  # can restore the form, and only this is the resolved path.
                  "source_path": source_path or "",
                  "title": template.get("name") or "Untitled"}
    if rebuild:
        job.detail["rebuild"] = True
    with jobs.JOBS_LOCK:
        jobs.JOBS[job_id] = job
        jobs.prune_jobs()
    try:
        acecands.remember(job_id, "queued", 0.0, job.detail)
    except BaseException as exc:   # noqa: BLE001 — VaultAuthError is a BaseException
        logger.warning(f"acestep: {job_id} not remembered as queued: {exc}")
    return job


# Generate-forever is server-owned and starts a job only when a card is free. It uses the latest
# form recipe at dispatch time and draws a fresh seed for each job. The tab re-arms the mode after
# service restart from its remembered state; the service does not resume generation unattended.
_FOREVER: dict = {"on": False, "recipe": None, "stop": None, "thread": None}
_FOREVER_LOCK = threading.RLock()

#: Poll for an available card every two seconds; backend probes run only when a job can start.
FOREVER_TICK = 2.0


def forever_state() -> dict:
    with _FOREVER_LOCK:
        return {"on": bool(_FOREVER["on"])}


#: One top-up at a time. `set_forever(on, topup=True)` and the 2 s ticker both call
#: `_forever_topup`, and both could pass the pending-empty checks before either enqueued — two
#: jobs from a mode built to keep the queue at depth 1, one of them sitting queued. Non-blocking:
#: the loser of the race simply skips, because the winner is doing exactly its work.
_TOPUP_LOCK = threading.Lock()


def _forever_topup() -> int:
    """Start one song if a card is free and nothing is waiting. Returns how many were added."""
    if not _TOPUP_LOCK.acquire(blocking=False):
        return 0
    try:
        return _forever_topup_locked()
    finally:
        _TOPUP_LOCK.release()


def _forever_topup_locked() -> int:
    with _FOREVER_LOCK:
        if not _FOREVER["on"]:
            return 0
        recipe = dict(_FOREVER["recipe"] or {})
    # ⚠️ THE CHEAP QUESTION FIRST. `_live_backends` costs one /health per card and this runs on a
    # timer, so anything already waiting ends it here without touching the network. It also keeps
    # the queue honest: forever must never stack work behind a hand-pressed Generate.
    if QUEUE.snapshot()["pending"]:
        return 0
    live = _live_backends()
    # 🔴 RE-SNAPSHOTTED AFTER THE PROBE, because probing takes time and a card can finish during
    # it. Reading `inflight` from the earlier snapshot would let this start a second song on a
    # card that is still busy — the queue would then hold it, which is the one thing this must
    # not produce.
    snap = QUEUE.snapshot()
    if snap["pending"]:
        return 0
    template = recipe.get("template") or {}
    mode = str(template.get("mode") or "custom").lower()
    # ⚠️ FREE **AND ABLE**. The card that frees first may hold a model that cannot run this
    # recipe's mode (turbo has no extract) — a top-up aimed there would sit queued against the
    # busy capable card, and the pending-empty check above would then stop every further top-up.
    free = [(svc, url, dev) for svc, url, dev in live
            if dev not in snap["inflight"] and _url_can_task(url, acegen.task_type_for(mode))]
    if not free:
        return 0                      # every usable card busy: nothing starts, nothing is queued
    settings = dict(recipe.get("settings") or {})
    settings.pop("seed", None)        # forever means NEW songs — see the note above
    # ⚠️ A REFERENCE THAT HAS GONE MUST NOT KILL THE RUN. Generate can 400 at the user because
    # somebody is standing there having just pressed it; forever is the thing you switch on and
    # walk away from, and stopping it hours later over a deleted stem set would be the worse
    # failure. Logged and dropped — the next top-up tries again, and if the set comes back so
    # does the reference.
    try:
        reference_path = acestage.stage_reference(template.get("reference") or "")
    except (FileNotFoundError, OSError) as exc:
        logger.warning(f"acestep forever: rendering without the reference clip: {exc}")
        reference_path = ""
    # ⚠️ THE SOURCE IS NOT OPTIONAL THE WAY THE REFERENCE IS. A reference that has gone costs a
    # render some flavor; a SOURCE that has gone turns a remix into an unrelated new song, over
    # and over, unattended. So this arm STOPS rather than degrades — the run stays on, and the
    # next top-up tries again in case the song comes back.
    # 🔴 AND ONLY THE MODES THAT CONSUME IT STAGE IT — same rule as Generate. The form ships the
    # Source select's token whatever the mode, so a stale token used to fail the stage HERE,
    # before the needs_source test, and turn forever-in-Custom into a warning every 2 s and zero
    # songs, unattended.
    needs_source = mode in acegen.MODES_NEEDING_SOURCE
    source_path = ""
    if needs_source:
        try:
            source_path = acestage.stage_source(template.get("source") or "")
        except (FileNotFoundError, OSError) as exc:
            logger.warning(f"acestep forever: skipping a top-up, the source is unavailable: {exc}")
            return 0
        if not source_path:
            logger.warning("acestep forever: skipping a top-up, the mode needs a source "
                           "and has none")
            return 0
    if mode == "edit" and not (str(template.get("edit_from_caption") or "").strip()
                               or str(template.get("edit_from_lyrics") or "").strip()):
        # Same refusal Generate makes, at the same price: an Edit without the old words is an
        # ordinary render pretending, and forever would make them by the dozen.
        logger.warning("acestep forever: skipping a top-up, Edit has no source words to morph from")
        return 0
    _svc, url, dev = free[0]
    job = _new_job(template=template,
                   template_id=recipe.get("template_id"),
                   settings=settings, device=dev,
                   model=_model_for(url, dev),
                   reference_path=reference_path, source_path=source_path,
                   # 🔴 Still rebuilt at dispatch. This aims at a card that was free a moment ago,
                   # and the pump may legitimately hand it to a different one that freed in
                   # between — at which point the payload must carry THAT card's step count.
                   rebuild=True)
    QUEUE.enqueue(job.id, live)
    return 1


def _forever_loop(stop):
    """Tick until stopped. ⚠️ Every exception is swallowed and logged: this thread going down
    silently would leave the button saying "Generating forever" over a queue that never fills,
    which is the worst of both — a UI promising what the server is not keeping."""
    while not stop.wait(FOREVER_TICK):
        try:
            _forever_topup()
        except BaseException as exc:   # noqa: BLE001 — VaultAuthError is a BaseException
            logger.warning(f"acestep forever: top-up failed: {exc}")


def set_forever(on: bool, recipe: dict | None = None, *, topup: bool = True) -> dict:
    """Enable or disable Generate-forever, or update the recipe for a run already in progress.
    The tab pushes current form values so the next job uses the visible recipe; the job is
    created only when a backend becomes free.

    Refresh requests do not trigger a top-up, avoiding backend probes for each form edit.
    """
    with _FOREVER_LOCK:
        if on:
            _FOREVER["recipe"] = dict(recipe or {})
            if not _FOREVER["on"]:
                _FOREVER["on"] = True
                stop = threading.Event()
                _FOREVER["stop"] = stop
                t = threading.Thread(target=_forever_loop, args=(stop,),
                                     name="acestep-forever", daemon=True)
                _FOREVER["thread"] = t
                t.start()
        else:
            _FOREVER["on"] = False
            if _FOREVER["stop"] is not None:
                _FOREVER["stop"].set()
            _FOREVER["stop"] = _FOREVER["thread"] = None
    if on and topup:
        _forever_topup()              # outside the lock: it enqueues, which dispatches
    return forever_state()


#: 🔴 ONE QUEUE PER PROCESS, AT MODULE LEVEL — NOT PER BLUEPRINT. It was inside the factory
#: first, which was wrong twice: `create_app()` can be called more than once (the suite does),
#: giving two queues that each think they own the same two cards; and a closure variable is
#: unreachable, so no test could reset it and state leaked from one test into the next until a
#: spec that counted running jobs saw four. The cards are a process-wide resource, so the thing
#: that rations them is process-wide too.
QUEUE = AceQueue(_dispatch, _live_backends, _can_run)


def _self_heal(live) -> None:
    """Re-arm anything stranded, from the 4 s status poll's own fresh probes (8.0-m22).

    🔴 TWO WAYS WORK GOT STUCK WITH NOTHING LEFT TO START IT, both the same shape as the
    original pump-on-done stall (a queue that only advances on one event):

      * Untick both cards mid-queue and re-tick them: `done()` pumped into an EMPTY backend
        list while the cards were off, and nothing pumps when a card comes back — the pending
        songs sat at "queued" until the next Generate press.
      * `_rearm_unfinished` after a restart: if the ACE-Step units were still coming up when
        the first readable poll ran (the ordinary ordering when the whole box restarts), the
        re-queue path hit `if not live: return` — but `_rehydrated` was already latched, so
        the "next poll tries again" its comment promised never happened. Restored queued
        songs stranded in the tray forever.

    This runs on every status poll, costs two snapshots against probes the poll already paid
    for, and does nothing at all when nothing is stranded. `enqueue` is idempotent for a job
    the queue already tracks, so re-offering is safe by construction.
    """
    if not live:
        return
    tracked_snap = QUEUE.snapshot()
    tracked = set(tracked_snap["pending"]) | set(tracked_snap["inflight"].values())
    for job in list(jobs.JOBS.values()):
        if (getattr(job, "kind", "") == "acestep" and job.status == "queued"
                and job.id not in tracked):
            QUEUE.enqueue(job.id, live)
    snap = QUEUE.snapshot()
    if snap["pending"] and any(d not in snap["inflight"] for _s, _u, d in live):
        QUEUE.pump(live)


def _drop_queued(job_id: str) -> None:
    """Remove a job that was canceled while still queued, including its persisted record. Use
    `drop` rather than `forget` so this removal does not consume the single undo slot. Jobs
    already dispatched to a backend remain visible; their child is stopped through lifecycle
    controls rather than this queue.
    """
    jobs.JOBS.pop(job_id, None)
    try:
        acecands.drop(job_id)
    # ⚠️ NAMED, NOT `except BaseException`. Every other store call in this file catches the base
    # class with a BLE001 suppression beside it, because `VaultAuthError` is a BaseException
    # locked vault is the ordinary case — but the lint ratchet's own message is right that BLE001
    # is the one code that can hide a real failure, and this site has a short, knowable list. A
    # blanket catch here would also swallow the `KeyboardInterrupt` that stops a dev server.
    except (VaultAuthError, VaultLocked, acecands.CandidateStoreCorrupt, OSError, ValueError) as exc:
        logger.warning(f"acestep: canceled {job_id} not dropped from the store: {exc}")


def _reap_unwatched() -> int:
    """Observe stale job owners without treating a missed heartbeat as proof of idleness."""
    now = time.time()
    ghosts = [j for j in list(jobs.JOBS.values())
              if getattr(j, "kind", "") == "acestep" and j.status == "running"
              and acerun.is_stale(j, now)]
    for job in ghosts:
        detail = job.detail or {}
        if acerun.ensure_watcher(job, QUEUE):
            continue
        device = detail.get("device")
        if device:
            # State inspection delivers a confirmed owned-child exit to the job watcher. If the
            # child is still alive or its state is unknown, retain the queue reservation.
            acestep.process_state(device)
    return 0


def disable_unauthorized() -> list[dict]:
    """Stop children removed from the saved device authorization and cancel their queued work."""
    allowed = {device for _service, _url, device in acestep.instances()}
    revoked = [(service, device) for service, _url, device in acestep.installed()
               if device not in allowed]
    if not revoked:
        return []

    revoked_devices = {device for _service, device in revoked}
    if not allowed:
        set_forever(False)
    for job in list(jobs.JOBS.values()):
        if (getattr(job, "kind", "") != "acestep" or job.status != "queued"
                or (job.detail or {}).get("device") not in revoked_devices):
            continue
        if not QUEUE.remove(job.id):
            continue
        job_device = (job.detail or {}).get("device")
        reason = f"ACE-Step disabled for {job_device}"
        with job.lock:
            job.status = "canceled"
            job.error = reason
            snapshot = {**dict(job.detail or {}), "error": reason}
        jobs.emit(job, {"type": "canceled", "message": reason})
        try:
            acecands.remember(job.id, "canceled", job.started_at or 0.0, snapshot)
        except BaseException as exc:  # noqa: BLE001 — vault lock may be a BaseException
            logger.warning(f"acestep: canceled {job.id} not remembered: {exc}")

    results = []
    for _service, device in revoked:
        result = acestep.stop_instance(device=device, reason="feature-disabled")
        results.append(result)
        if not result.get("ok"):
            logger.warning(f"acestep: {device} remains owned after authorization was disabled: "
                           f"{result.get('error')}")
    return results


def create_acestep_blueprint() -> Blueprint:
    """Nothing injected — same as the ComfyUI blueprint, and for the same reason: every
    dependency is a runtime module both sides import normally."""
    bp = Blueprint("vocalis_acestep", __name__)

    @bp.route("/acestep/status")
    def acestep_status():
        """Return installed-device, child-process, HTTP, model, and authorization state."""
        insts = acestep.installed()
        if not insts:
            return jsonify({"available": False})
        authorized = {d for _s, _u, d in acestep.instances()}
        # 🔴 ONE ROUND OF PROBES, IN PARALLEL — this route is polled every 4 s and probed each
        # backend in TURN at a 3 s timeout, so two slow-to-answer backends cost 6 s per poll and
        # the polls piled up on each other. A stopped backend refuses instantly and was never
        # the problem; the timeout bites when the port is open and busy, i.e. mid-generation or
        # mid-model-load — the two moments this row is actually being watched.
        probes = acestep.probe_many(insts)
        # The same bookkeeping `_live_backends` does: `_dispatch` may not probe, so every fresh
        # probe result feeds the model map it reads instead.
        _note_models(insts, probes)
        # 🔴 BEFORE `_self_heal`, AND NOT GATED ON A LIVE BACKEND. A ghost row is at its most
        # likely when there is no backend at all — that is how it became one — and `_self_heal`
        # returns immediately in that case.
        _reap_unwatched()
        _self_heal([(svc, url, dev) for svc, url, dev in insts
                    if probes[url]["up"] and dev in authorized])
        unit_states = acestep.active_states(insts)
        queue_state = QUEUE.snapshot()
        busy_devices = set(queue_state["inflight"])
        backends = []
        for svc, url, dev in insts:
            h = probes[url]
            backends.append({"service": svc, "device": dev, "url": url,
                             "up": h["up"], "model_loaded": h["model_loaded"],
                             "model": h["model"],
                             # 🔴 A THIRD STATE, and the row needs it. /health cannot tell "no
                             # model" from "19 GB of xl-sft is 40 seconds into arriving", and
                             # those look identical to someone watching a dropdown that appears
                             # to have done nothing.
                             "loading": acestep.loading_model(dev),
                             "unit": unit_states.get(dev) or None,
                             "busy": (dev in busy_devices or bool(acestep.loading_model(dev))
                                      or unit_states.get(dev) in {"starting", "stopping"}),
                             # Whether this card may hold a MODEL. The row still renders when it
                             # may not — a card that vanishes from the panel because of a tick
                             # elsewhere is indistinguishable from a card that broke.
                             "authorized": dev in authorized})
        return jsonify({"available": True,
                        "instances": len(authorized),
                        "installed": len(insts),
                        # The map already in hand, so this costs no second `is-active`. Same
                        # number and same `None`-not-0 contract as before — `acePaint` reads
                        # `null` as "restart", so the difference is visible, not cosmetic.
                        "running": acestep.active_count(unit_states),
                        "backends": backends})

    @bp.route("/acestep/models")
    def acestep_models():
        """What each backend could load — the card rows' dropdown (§4.5.1).

        Separate from `/acestep/status` on purpose: status is polled every 4 s and this is not,
        because the inventory only changes when models appear on disk.

        ⚠️ A backend that is DOWN reports `reachable: false` with an empty list rather than an
        error. The row still has to render — it is the row that offers to start the service.
        """
        out = {}
        for _svc, url, dev in acestep.instances():
            out[dev] = _publisher_inventory(url, acestep.inventory(url))
            # Feed the queue's capability gate while we are holding a fresh inventory anyway —
            # `_can_run` may not probe, so it lives off what routes like this one saw last.
            if out[dev].get("reachable"):
                _TASKS_BY_URL[url] = dict(out[dev].get("tasks") or {})
        return jsonify({"backends": out})

    @bp.route("/acestep/init", methods=["POST"])
    def acestep_init():
        """Load a model onto one card. Returns immediately; the row polls for the result.

        🔴 202, NOT 200. Reading 19 GB takes minutes, so this route starts the load and answers.
        A synchronous version would hold a worker, time out mid-read, and leave the UI unable to
        say whether anything was still happening.
        """
        body = request.get_json(silent=True) or {}
        device, model = body.get("device"), body.get("model")
        if not device or not model:
            return jsonify({"error": "device and model are both required"}), 400
        match = [(u, d) for _s, u, d in acestep.instances() if d == device]
        if not match:
            return jsonify({"error": f"{device} is not an authorized ACE-Step card — tick it "
                                     f"for “ACE-Step” under ⚙ Settings ▸ Devices"}), 404
        url, _dev = match[0]
        # Refuse a model this backend does not have, rather than letting /v1/init decide to
        # DOWNLOAD one: `ensure_model_downloaded` would happily pull 19 GB from HuggingFace
        # because of a typo, and the first sign would be a full disk.
        inv = acestep.inventory(url)
        if inv["reachable"] and model not in inv["models"]:
            return jsonify({"error": f"{device} has no model named “{model}” — it offers "
                                     f"{', '.join(inv['models']) or 'nothing'}"}), 400
        if not inv.get("reachable"):
            return jsonify({"error": f"ACE-Step on {device} is not answering yet"}), 409
        result = acestep.start_init(
            url, device, model,
            busy_check=lambda: QUEUE.snapshot()["inflight"].get(device) is not None)
        if not result.get("ok"):
            return jsonify(result), 409
        return jsonify(result), 202

    @bp.route("/acestep/unload", methods=["POST"])
    def acestep_unload():
        """Unload one selected card by stopping only its locally owned child."""
        device = (request.get_json(silent=True) or {}).get("device")
        if not device or not any(d == device for _s, _u, d in acestep.installed()):
            return jsonify({"error": f"no ACE-Step backend on this host for {device!r}"}), 404
        result = acestep.stop_instance(device=device, reason="unload")
        return jsonify(result), (200 if result.get("ok") else 502)

    def _lifecycle(results: list[dict], action: str):
        if not results:
            return jsonify({"error": "no ACE-Step devices are configured", "action": action}), 409
        failed = [row for row in results if not row.get("ok")]
        body = {"ok": not failed, "action": action, "devices": results,
                "running": acestep.active_count()}
        return jsonify(body), 502 if failed else 200

    @bp.route("/acestep/start", methods=["POST"])
    def acestep_start():
        """Start each configured child without waiting for HTTP or model readiness."""
        return _lifecycle(acestep.start_all(), "start")

    @bp.route("/acestep/stop", methods=["POST"])
    def acestep_stop():
        """Stop all owned children and disable Generate-forever before termination."""
        set_forever(False)
        return _lifecycle(acestep.stop_all(reason="stop"), "stop")

    @bp.route("/acestep/restart", methods=["POST"])
    def acestep_restart():
        """Restart all owned children without initializing models in the new processes."""
        set_forever(False)
        return _lifecycle(acestep.restart_all(reason="restart"), "restart")

    # ── song templates (§4.5.2) ──────────────────────────────────────────────────────────────
    #
    # The verbs follow `/voices/templates` exactly — POST to the collection CREATES, POST to an
    # id UPDATES, DELETE deletes. Not because that shape is interesting, but because having ONE
    # convention is: a second one means another near-identical fetch wrapper in the client, and a
    # reader who has to check which store they are in before knowing what a POST does.
    #
    # 🔴 SAVE ALWAYS CREATES, for that file's stated reason rather than as a copied habit: two
    # templates may share a name, because the id is the identity. A save that quietly replaced a
    # same-named entry would destroy the older one silently, in a store whose whole job is not
    # losing the lyrics you spent twenty minutes on.

    # 🔴 `reference` IS ON THE TEMPLATE, NOT IN ADVANCED, and that follows the §4.5.2 rule rather
    # than bending it: Advanced holds how WELL a song renders, the template holds what makes it
    # THAT song — and "sing it like this" changes the song. It also gets the draft-survives-a-
    # bounce behavior for free, which is the paradigm this panel is held to.
    # ⚠️ It stores a TOKEN (`stem:<ref>`), never a path. See `acestage.references`.
    _FIELDS = ("name", "caption", "global_caption", "lyrics", "instrumental", "bpm",
               "key_scale", "time_signature", "vocal_language", "duration", "reference",
               # m3: the mode and what it works from. `source` is a TOKEN like `reference` is —
               # `song:<id>` / `cand:<job>` / `stem:<ref>` — never a path.
               "mode", "source", "repaint_start", "repaint_end", "cover_strength",
               # m4: ALWAYS a list on the wire, even for the modes that use exactly one. The
               # server is what knows whether this mode fills `track_name` or `track_classes`;
               # a client that decided would be a second opinion able to drift from it.
               "tracks",
               # m5: Retake perturbs a seed it was given; Edit needs the words the song HAD, to
               # subtract from the words it should have. Both are part of what the song IS.
               "retake_seed", "retake_variance", "edit_from_caption", "edit_from_lyrics",
               "favorite")

    # ── 8.1-m2b: the 5 Hz LM, without spending a render ──────────────────────────────────────
    #
    # Simple mode generates its caption and lyrics separately so the user can review, edit, and
# save them before rendering. This avoids a separate mode machine; Remix and Repaint still use
# the mode radio because they operate on source audio.
    # SOURCE AUDIO and change which fields mean anything. Simple never did.
    def _live_url_for_lm():
        """A backend that is up, or a (message, status) to hand back.

        ⚠️ Any card will do — the LM is not the diffusion model and is not what the card rows are
        about, so this deliberately does not care WHICH model is loaded. It takes the first live
        one and says so if there is none.
        """
        insts = acestep.instances()
        if not insts:
            return None, ("no authorized ACE-Step backend on this host — tick a card for "
                          "“ACE-Step” under ⚙ Settings ▸ Devices", 501)
        probes = acestep.probe_many(insts)
        live = [url for _svc, url, _dev in insts if probes[url]["up"]]
        if not live:
            return None, ("no ACE-Step backend is running — press Start ACE-Step in the header",
                          409)
        return live[0], None

    @bp.route("/acestep/compose", methods=["POST"])
    def acestep_compose():
        """Write a song from a description, or tidy up one already in the boxes.

        `{"query": "…"}` → the LM writes caption, lyrics and metadata from scratch.
        `{"format": true, "caption": …, "lyrics": …}` → it reworks what is there.

        Returns only the fields the LM actually filled in, so the client can write them over the
        form without blanking boxes the model said nothing about.

        ⚠️ SLOW ON THE FIRST CALL, and honestly so. Both routes lazily initialize the 5 Hz LM, so
        a cold backend spends a minute or two loading before it answers. The button says so.
        """
        d = request.get_json(silent=True) or {}
        url, problem = _live_url_for_lm()
        if problem:
            return jsonify({"error": problem[0]}), problem[1]
        try:
            if d.get("format"):
                # ⚠️ TRANSLATED, NOT PASSED THROUGH. The client speaks this app's names
                # (`keyscale`/`timesignature`, the `_as_song` dialect); `param_obj`'s inner names
                # upstream are `key_scale`/`time_signature` — a near-miss here is not an error,
                # it is a constraint the LM never hears.
                meta = {dst: d[src] for src, dst in (("bpm", "bpm"), ("duration", "duration"),
                                                     ("keyscale", "key_scale"),
                                                     ("timesignature", "time_signature"),
                                                     ("language", "language"))
                        if d.get(src) not in (None, "")}
                song = acestep.format_input(url, caption=d.get("caption") or "",
                                            lyrics=d.get("lyrics") or "", metadata=meta)
            else:
                song = acestep.create_sample(url, query=d.get("query") or "",
                                             instrumental=bool(d.get("instrumental")),
                                             vocal_language=d.get("vocal_language") or "unknown")
        # ⚠️ NARROW, AND IT IS THE WHOLE SURFACE. `test_m5_boundaries` fired on the blind version
        # and its doctrine is to narrow rather than move the bar. These two calls are one
        # `urlopen` and one `json.loads`: `URLError` and socket timeouts are `OSError`,
        # `JSONDecodeError` is a `ValueError`, and `RuntimeError` is what `_post_wrapped` raises
        # for the in-body failure code. Same list `inventory()` above uses, for the same reason.
        except (OSError, ValueError, RuntimeError) as exc:
            # The backend's own sentence is the useful part: "LLM not initialized. Set
            # ACESTEP_INIT_LLM=true in .env to enable." is precisely what a generic message hides.
            return jsonify({"error": f"the 5Hz LM could not write it: {exc}"}), 502
        if not song:
            return jsonify({"error": "the 5Hz LM answered with nothing at all"}), 502
        return jsonify({"song": song})

    # ── 8.1-m6: LoRA, which is a property of the CARD and not of the song ────────────────────
    #
    # 🔴 THE DESIGN PUT THESE IN ADVANCED AND THAT WOULD NOT HAVE WORKED. `lora` is not on the
    # request model at all — there is no per-render field to add. It is backend state behind five
    # routes, so it lives where the model dropdown lives, for the same reason: a backend is pinned
    # to its card, and a per-song control would be a second answer to a question the card owns.
    def _url_for_device(dev: str):
        for _svc, url, d in acestep.instances():
            if d == dev:
                return url
        return None

    @bp.route("/acestep/lora/<path:device>")
    def acestep_lora_status(device):
        """What adapter one card is holding. Never an error — the row has to render regardless."""
        url = _url_for_device(device)
        if url is None:
            return jsonify({"loaded": False, "use_lora": False, "scale": 1.0,
                            "reachable": False}), 200
        return jsonify(acestep.lora_status(url))

    @bp.route("/acestep/lora/<path:device>", methods=["POST"])
    def acestep_lora_act(device):
        """`{action: load|unload|toggle|scale, ...}` against one card.

        ⚠️ ONE ROUTE FOR FOUR VERBS because they are four steps of one workflow on one object, and
        four routes would each need the same device lookup, the same authorization check and the
        same "which backend" error. The action is validated against a table rather than dispatched
        by name so an unknown verb is a 400 and never an attribute lookup.
        """
        url = _url_for_device(device)
        if url is None:
            return jsonify({"error": f"{device} is not an authorized ACE-Step card"}), 404
        d = request.get_json(silent=True) or {}
        action = str(d.get("action") or "")
        try:
            with acestep.model_change(device):
                if QUEUE.snapshot()["inflight"].get(device) is not None:
                    return jsonify({"error": f"ACE-Step on {device} is busy with a render"}), 409
                if action == "load":
                    path = str(d.get("lora_path") or "").strip()
                    if not path:
                        return jsonify({"error": "no adapter path given"}), 400
                    out = acestep.lora_load(url, path, adapter_name=str(d.get("adapter_name") or ""))
                elif action == "unload":
                    out = acestep.lora_unload(url)
                elif action == "toggle":
                    out = acestep.lora_toggle(url, bool(d.get("use_lora")))
                elif action == "scale":
                    raw = d.get("scale")
                    if raw in (None, ""):
                        scale = 1.0
                    else:
                        try:
                            scale = float(raw)
                        except (TypeError, ValueError):
                            return jsonify({"error": f"scale must be a number, not {raw!r}"}), 400
                    out = acestep.lora_scale(url, scale,
                                             adapter_name=str(d.get("adapter_name") or ""))
                else:
                    return jsonify({"error": f"unknown lora action {action!r}"}), 400
        except acestep.BackendUnavailable as exc:
            return jsonify({"error": str(exc)}), 409
        # Narrow for the reason `test_m5_boundaries` keeps giving: one urlopen and one json.loads,
        # so OSError and ValueError are the surface, and RuntimeError is `_post_wrapped`'s own
        # raise for the failure code that arrives inside an HTTP 200.
        except (OSError, ValueError, RuntimeError) as exc:
            # The backend's sentence again — "Model not fully initialized" is precisely the thing
            # a generic message would hide, and it names the fix.
            return jsonify({"error": f"{device}: {exc}"}), 502
        return jsonify({"ok": True, "result": out, "status": acestep.lora_status(url)})

    @bp.route("/acestep/sources")
    def acestep_sources():
        """What Remix, Repaint and the track modes can work FROM — library, candidates, stems.

        ⚠️ Same rule as `/acestep/references`: a locked vault is an EMPTY LIST, not a 500. This is
        painted on tab load and the store is unreadable until someone logs in.
        """
        try:
            return jsonify({"sources": acestage.sources()})
        except BaseException as exc:    # noqa: BLE001 — VaultAuthError is a BaseException
            logger.debug(f"acestep: sources unavailable ({exc})")
            # ⚠️ FLAGGED, because "shut" and "empty" must not share a shape. The form's loaders
            # keep their last good list and retry when they see it — without the flag, a boot
            # that landed in the locked window painted "⚠ no longer in the library" over
            # sources that exist.
            return jsonify({"sources": [], "locked": True})

    @bp.route("/acestep/references")
    def acestep_references():
        """The "Sing it like" picker's options — every vocal stem in the Stems library.

        ⚠️ A LOCKED VAULT IS AN EMPTY LIST, NOT A 500. This is painted on tab load, and the store
        is unreadable until someone logs in; a raising route would take the whole form down over
        a control that is optional by design.
        """
        try:
            return jsonify({"references": acestage.references()})
        except BaseException as exc:    # noqa: BLE001 — VaultAuthError is a BaseException
            logger.debug(f"acestep: references unavailable ({exc})")
            # Same flag as `/acestep/sources`, same reason: the client must be able to tell
            # "the store is shut, keep what you have and retry" from "you have no clips".
            return jsonify({"references": [], "locked": True})

    @bp.route("/acestep/templates")
    def acestep_templates():
        """Every song template. The client sorts — by name, by newest, favorites first."""
        return jsonify({"templates": [t.to_dict() for t in acetemplates.list_templates()]})

    @bp.route("/acestep/templates", methods=["POST"])
    def acestep_templates_add():
        d = request.get_json(silent=True) or {}
        name = str(d.get("name") or "").strip()
        if not name:
            return jsonify({"error": "no name",
                            "message": "Give the song a title so you can find it again."}), 400
        fields = {k: v for k, v in d.items() if k in _FIELDS}
        fields["name"] = name
        try:
            return jsonify(acetemplates.save(fields).to_dict()), 201
        except ValueError as exc:
            return jsonify({"error": "too_many", "message": str(exc)}), 400

    @bp.route("/acestep/templates/<tpl_id>", methods=["POST"])
    def acestep_templates_update(tpl_id):
        """Rename, re-save the form over an existing template, or toggle its ★.

        ⚠️ ONLY THE KEYS ACTUALLY SENT ARE WRITTEN. A rename must not blank the lyrics it never
        mentioned — the store merges onto the existing row for exactly that reason, and a spec
        pins it because the first version of this clamped every field whether it was sent or not.
        """
        d = request.get_json(silent=True) or {}
        fields = {k: v for k, v in d.items() if k in _FIELDS}
        if not fields:
            return jsonify({"error": "nothing to change"}), 400
        # An unknown id here is a stale page or a bug, NOT a new song — unlike the store's own
        # `save()`, which creates so that a race cannot lose freshly typed lyrics. The route is
        # the layer that can tell the difference, because it knows the user aimed at a row.
        if not any(t.id == tpl_id for t in acetemplates.list_templates()):
            abort(404)
        try:
            return jsonify(acetemplates.save(fields, template_id=tpl_id).to_dict())
        except (ValueError, TypeError) as exc:
            return jsonify({"error": "bad_field", "message": str(exc)}), 400

    @bp.route("/acestep/templates/<tpl_id>", methods=["DELETE"])
    def acestep_templates_delete(tpl_id):
        if not acetemplates.delete(tpl_id):
            abort(404)
        return jsonify({"ok": True})

    # ── generating (§4.5.3) ──────────────────────────────────────────────────────────────────

    @bp.route("/acestep/generate", methods=["POST"])
    def acestep_generate():
        """One press = one song per available card (§4.5.3).

        🔴 EVERY CARD GETS ITS OWN SEED, AND THAT IS NOT A DETAIL. Two backends handed the same
        seed and the same template render the IDENTICAL song, which turns a two-card box into a
        one-card box that takes up twice the room. The seeds are drawn here, once, and travel in
        the payload — nothing downstream may re-randomize or default them.

        ⚠️ The model comes from the CARD, so each card's payload differs in more than the seed:
        steps and DCW follow whatever that backend is holding (§5.2). A draft and a final really
        are different renders, and that is the point of setting the cards differently.
        """
        d = request.get_json(silent=True) or {}
        template = d.get("template") or {}
        settings = d.get("settings") or {}
        mode = str(template.get("mode") or "custom").lower()

        # ⚠️ BACKENDS FIRST, STAGING SECOND. Staging decrypts vault audio into the backend-shared
        # plaintext directory; a press on a box with no backend must be refused before it pays
        # that, not after.
        insts = acestep.instances()
        if not insts:
            return jsonify({"error": "no authorized ACE-Step backend on this host — tick a card "
                                     "for “ACE-Step” under ⚙ Settings ▸ Devices"}), 501

        # A backend that is down cannot take work. Reported rather than queued: a song sitting
        # behind a stopped service looks identical to one that is simply slow.
        # ⚠️ PROBED ONCE PER BACKEND, AND THE RESULT IS KEPT. This asked twice — once to filter
        # for `up`, once again inside the loop for `model` — so every press cost two `/health`
        # round trips per card against a 3 s timeout, and the two answers could disagree: a
        # backend that died between them was dispatched with an empty model, which `steps_for`
        # then resolves to the 32-step fallback rather than the card's real 8 or 50.
        probes = acestep.probe_many(insts)
        live = [(svc, url, dev) for svc, url, dev in insts
                if probes[url]["up"] and probes[url]["model_loaded"] is True
                and acestep.can_dispatch(dev)]
        if not live:
            return jsonify({"error": "no authorized ACE-Step card has a loaded, ready model"}), 409

        # Same bookkeeping as `_live_backends`: these probes are fresh, and `_dispatch` reads
        # the map because it may not probe.
        _note_models(insts, probes)

        # 🔴 ONE JOB PER CARD *THAT CAN RUN THIS MODE* (8.2.5). The task types are per model —
        # turbo has no extract/lego/complete — and `task_type` is a bare `str` upstream, so a
        # press in Extract mode used to make one job per live card and hand turbo a task it
        # cannot run: a burned render that "fails deeper, or quietly". The inventory is warmed
        # here (cache-miss only — the models route refreshes it on every tab entry) so the
        # queue's `_can_run` gate has something to gate with.
        for _svc, url, _dev in live:
            if url not in _TASKS_BY_URL:
                inv = _publisher_inventory(url, acestep.inventory(url))
                if inv.get("reachable"):
                    _TASKS_BY_URL[url] = dict(inv.get("tasks") or {})
        task = acegen.task_type_for(mode)
        capable = [(svc, url, dev) for svc, url, dev in live if _url_can_task(url, task)]
        logger.info(f"ace-generate: mode={mode} task={task} live={[d for _s, _u, d in live]} "
                    f"capable={[d for _s, _u, d in capable]} "
                    f"loaded={[_MODEL_BY_URL.get(u) or '' for _s, u, _d in live]}")
        if not capable:
            models = ", ".join(sorted({(_MODEL_BY_URL.get(u) or "nothing") for _s, u, _d in live}))
            # October 11, 2026: names the model to load, from the publisher's table (acegen.PUBLISHED_TASKS),
            # e.g. "Extract needs the acestep-v15-xl-base model. Load it from a card's model menu."
            needs = acegen.published_models_for(task)
            label = mode.split('-')[0].title() if task != "lego" else "Replace"
            if needs:
                text = (f"{label} needs the {' or '.join(needs)} model. Load it from a card's model menu "
                        f"(loaded now: {models}).")
            else:
                text = (f"No running card holds a model that can run {label} — loaded: {models}. Load "
                        "one that supports it from the card's model menu.")
            logger.info(f"ace-generate: refused mode={mode} task={task}: {text}")
            return jsonify({"error": "mode_unsupported", "message": text}), 409

        # 🔴 STAGED ONCE, BEFORE ANY JOB EXISTS, AND A FAILURE IS A 400 RATHER THAN A QUIET
        # RENDER. `process_reference_audio` returns None for anything it cannot read and the
        # render then proceeds with no reference and nothing anywhere saying so (§8) — so a
        # reference the user picked and Vocalis could not deliver has to stop the press. Both
        # cards share the one staged file; see `acestage`'s header on why that is required rather
        # than merely convenient.
        try:
            reference_path = acestage.stage_reference(template.get("reference") or "")
        except (FileNotFoundError, OSError) as exc:
            return jsonify({"error": "reference_unavailable", "message": str(exc)}), 400

        # 🔴 A SOURCE MODE WITH NO SOURCE MUST NOT RENDER. This is the design's §5 failure shape
        # stated as a rule: send `task_type: "cover"` with an empty `src_audio_path` and the
        # backend produces a perfectly ordinary text2music song, with nothing anywhere saying the
        # remix did not happen. It is found by listening, which is the most expensive way to find
        # anything. So the press is refused with a sentence instead.
        # ⚠️ AND ONLY THE MODES THAT CONSUME IT STAGE IT. The form serializes whatever sits in
        # the Source select even in Custom mode, where the payload ignores it — so a stale token
        # (a remixed candidate that died with its backend) used to 400 a Custom press that never
        # needed the file, and turned Generate-forever in Custom into a zero-song loop.
        source_path = ""
        if mode in acegen.MODES_NEEDING_SOURCE:
            try:
                source_path = acestage.stage_source(template.get("source") or "")
            except (FileNotFoundError, OSError) as exc:
                return jsonify({"error": "source_unavailable", "message": str(exc)}), 400
            if not source_path:
                return jsonify({"error": "source_required",
                                "message": f"{mode.split('-')[0].title()} needs a song to work "
                                           "from — pick one under Source, or use the 🎛 menu on "
                                           "a candidate or a library row."}), 400

        # 🔴 EDIT WITHOUT THE SONG'S OLD WORDS IS AN ORDINARY RENDER WEARING THE WRONG BUTTON.
        # The morph integrates V_tar(new words) − V_src(old words); with both source fields empty
        # the delta is the whole target and the source audio is ignored — silently (see
        # `acegen.build_payload`). Refused with the same sentence-shape as `source_required`.
        if mode == "edit" and not (str(template.get("edit_from_caption") or "").strip()
                                   or str(template.get("edit_from_lyrics") or "").strip()):
            return jsonify({"error": "edit_source_words_required",
                            "message": "Edit morphs the song FROM its old words TO the ones in "
                                       "the form — use ✏️ Edit on a candidate or library row so "
                                       "its caption and lyrics are carried in as the "
                                       "starting point."}), 400

        made = []
        for _svc, url, dev in capable:
            # 🔴 THE CARD'S OWN CHOICE WHEN IT HOLDS NOTHING (8.9.9). `probes[url]["model"]` is
            # what is LOADED, and a backend that has just come up holds nothing — so this was ""
            # and upstream's `initialize_service` defaulted it to turbo while the dropdown said
            # xl-sft. `_model_for` is the one place that rule lives.
            # 🔴 THROUGH `_model_for`, NEVER FROM THE PROBE DIRECTLY. This read `probes[url]
            # ["model"]`, which is the backend's DEFAULT label and is filled in even on a card
            # holding nothing — see `_note_models`. `_model_for` reads the map that now records
            # only what is really resident, so the user's choice is the answer on an empty card.
            model = _model_for(url, dev)
            # 🔴 `rebuild=True` ON EVERY JOB, because "created FOR a named card" is not the same
            # as "runs ON that card". The queue is deliberately affinity-free — a free backend
            # takes the next job, full stop — so with one card mid-song, the job built for the
            # BUSY card dispatches onto the free one carrying the wrong card's payload: 8 turbo
            # steps on an xl-sft card (a visibly worse render), and a library row whose `model`
            # then lies about what made it. The rebuild at dispatch re-resolves model and steps
            # for whichever card actually takes the job — same seed, same words, same knobs.
            job = _new_job(template=template, template_id=d.get("template_id"),
                           settings=settings, device=dev, model=model, rebuild=True,
                           reference_path=reference_path, source_path=source_path)
            made.append({"job_id": job.id, "device": dev, "model": model,
                         "seed": job.detail["seed"]})
            QUEUE.enqueue(job.id, live)

        if d.get("template_id"):
            acetemplates.note_use(str(d["template_id"]))
        # Cheap, and here rather than only at boot because a box that is never restarted would
        # otherwise never sweep. One `listdir` of a directory holding a handful of entries.
        try:
            acestage.sweep()
        except OSError as exc:
            logger.debug(f"acestage: sweep skipped ({exc})")
        return jsonify({"ok": True, "jobs": made}), 202

    @bp.route("/acestep/forever", methods=["POST"])
    def acestep_forever():
        """Enable or disable Generate-forever, or refresh the recipe for an active run.
    `refresh=True` updates the values used by the next job without restarting the mode or
    triggering a top-up; the form is the source of current recipe values.
    """
        d = request.get_json(silent=True) or {}
        on = bool(d.get("on"))
        refresh = bool(d.get("refresh"))
        if on and not refresh and not acestep.instances():
            return jsonify({"error": "no authorized ACE-Step backend on this host — tick a card "
                                     "for “ACE-Step” under ⚙ Settings ▸ Devices"}), 501
        # A refresh for a run that is NOT on is a stale tab talking; answer the truth rather than
        # quietly starting one.
        if refresh and not forever_state()["on"]:
            return jsonify(forever_state())
        state = set_forever(on, {"template": d.get("template") or {},
                                 "template_id": d.get("template_id"),
                                 "settings": d.get("settings") or {}} if on else None,
                            topup=not refresh)
        return jsonify(state)

    #: Rehydrate only after a jobs poll can read the vault. Startup may occur while the vault is
    #: locked; retrying on a later poll distinguishes unavailable storage from an empty store.
    _rehydrated = {"done": False}

    def _rehydrate_once():
        if _rehydrated["done"]:
            return
        try:
            n = acecands.rehydrate(jobs)
        except BaseException as exc:    # noqa: BLE001 — VaultAuthError is a BaseException
            logger.debug(f"acestep: candidates not rehydrated yet: {exc}")
            return                       # locked or unreadable: try again next poll
        _rehydrated["done"] = True
        if n:
            logger.info(f"acestep: {n} candidate(s) restored from the last session")
        _rearm_unfinished()
        # The store has just been read, so this is the first moment it is safe to say which songs
        # in the engine's output folder nothing refers to (candidates from before this existed,
        # a render lost to a crash). It does nothing while a restored job is queued or running.
        acecands.reconcile_output(jobs)

    def _rearm_unfinished():
        """Reattach status polling only to owned children; requeue only known-unsent work."""
        live = None
        for job in list(jobs.JOBS.values()):
            if getattr(job, "kind", "") != "acestep" or job.status != "running":
                continue
            d = job.detail or {}
            if d.get("task_id") and acerun.ensure_watcher(job, QUEUE):
                continue
            if d.get("submission_state") == "not_submitted":
                with job.lock:          # the one convention this file must not break (module hdr)
                    job.status = "queued"
                    job.error = None
                continue
            device = d.get("device")
            if device:
                # An unresolved submitted job still owns its device until its result or exact
                # predecessor exit is known. Reclaim the slot after registry rehydration so a
                # second request cannot dispatch around an ambiguous render.
                QUEUE.claim(job.id, device)
            with job.lock:
                job.error = "render outcome is unresolved; no matching locally owned child is available"
        for job in list(jobs.JOBS.values()):
            if getattr(job, "kind", "") != "acestep" or job.status != "queued":
                continue
            if live is None:
                live = _live_backends()
            if not live:
                return          # nothing running to give them to; the next poll tries again
            QUEUE.enqueue(job.id, live)

    @bp.route("/acestep/jobs")
    def acestep_jobs():
        """Return known ACE-Step jobs newest-created first for the candidates tray and page
    reattachment. Preserve creation order: `started_at` changes from zero when a queued job
    starts and would otherwise move rows while the page is open.
    """
        _rehydrate_once()
        # 🔴 AFTER REHYDRATION, NEVER BEFORE, AND IN THE SAME REQUEST. `_rearm_unfinished` is what
        # gives a restored render its watcher and its first heartbeat; reaping first would kill
        # every song this restart was about to pick back up. Anything still unwatched by the time
        # both have run is a ghost, and the poll that paints the tray is exactly where it must be
        # caught — the tray may not render a row that nothing is watching.
        _reap_unwatched()
        now = time.time()
        with jobs.JOBS_LOCK:
            mine = [j for j in jobs.JOBS.values() if getattr(j, "kind", "") == "acestep"]
        out = []
        for j in reversed(mine):
            with j.lock:
                d = dict(j.detail or {})
                out.append({"id": j.id, "status": j.status, "error": j.error,
                            "device": d.get("device"), "model": d.get("model"),
                            "seed": d.get("seed"), "title": d.get("title"),
                            "template_id": d.get("template_id"),
                            "audio": d.get("audio") or [],
                            # 8.1-m2a: the caption, lyrics and metadata the 5 Hz LM actually
                            # rendered from, when it reported them. Absent on a job that has not
                            # finished, and on any candidate remembered before 8.1.
                            "rendered": d.get("rendered") or None,
                            "queue_position": QUEUE.position(j.id),
                            "started_at": j.started_at})
        # 🔴 THE RECYCLE BIN'S DEPTH RIDES THIS POLL, for the reason the forever flag does below:
        # the bin is on disk and survives a reload, so a tray that counted its own discards would
        # show 0 on a fresh page with a song still recoverable — the store remembering while the
        # BUTTON forgets. `undoable` is the server's answer and the button paints from it.
        #
        # ⚠️ A BROKEN BIN MUST NOT TAKE THE TRAY DOWN. `bin_size` reads the store, and the store
        # raises `CandidateStoreCorrupt` on a file that will not parse — deliberately, because
        # "corrupt" and "empty" are different answers. But this route paints the CANDIDATES, and
        # letting a recycle-bin problem 500 the list would trade a missing button for a missing
        # tab. Degrade to "nothing to undo" and let the store's own logging say why.
        try:
            undoable = acecands.bin_size()
        except acecands.CandidateStoreCorrupt:
            undoable = 0
        # Use the server timestamp so elapsed time does not depend on browser clock accuracy.
        # 🔴 THE FOREVER FLAG RIDES THE POLL THE TAB ALREADY MAKES. The server is the authority on
        # whether the mode is running — it survives the page being reloaded — so the button paints
        # from this rather than from what it last did. No new route, no second timer.
        return jsonify({"jobs": out, "now": now, "forever": forever_state(),
                        "undoable": undoable})

    @bp.route("/acestep/jobs/<job_id>/cancel", methods=["POST"])
    def acestep_cancel(job_id):
        """Remove queued work, or stop collecting an already-submitted render's result.

        Cancel does not interrupt backend inference. Its queue reservation remains held until a
        terminal result arrives or the exact owned child is confirmed exited; Stop and Unload
        terminate that child when the operator wants to end submitted work.
        """
        job = jobs.JOBS.get(job_id)
        if job is None:
            abort(404)
        if QUEUE.remove(job_id):
            with job.lock:
                job.status = "canceled"
            jobs.emit(job, {"type": "canceled"})
            _drop_queued(job_id)
            return jsonify({"ok": True, "removed": True, "was_running": False})
        with job.lock:
            if job.status in ("done", "failed", "canceled"):
                return jsonify({"ok": True, "removed": False, "was_running": False,
                                "status": job.status})
        job.cancel.set()
        return jsonify({"ok": True, "removed": False, "was_running": True,
                        "device": QUEUE.device_of(job_id),
                        "message": "Cancel stops waiting for this render but does not stop "
                                   "inference. Use Stop or Unload to terminate its backend child."}), 202

    @bp.route("/acestep/jobs/<job_id>/discard", methods=["POST"])
    def acestep_discard(job_id):
        """Forget one candidate for good — the server half of the tray's Discard.

        🔴 DISCARD USED TO BE CLIENT-SIDE ONLY, and persistence is what made that a bug. The tray
        kept a `DISCARDED` Set in the page, which was fine while the registry died with the
        process: everything vanished together. Now that candidates are remembered (8.0-m7), a
        discarded one would come BACK on the next restart, which is the opposite of what the
        button says.

        ⚠️ It does not delete the audio right away. The record goes to the one-slot undo bin and its
        file stays until a newer discard replaces the bin (2026-10-11; before that the file stayed
        for good, the engine having no delete call). Removing the files is `runtime/acecands.py`'s
        job; the pass at the end only collects files that nothing refers to.
        """
        acecands.forget(job_id)          # into the bin, not the void — see /candidates/undo
        job = jobs.JOBS.get(job_id)
        if job is not None and getattr(job, "kind", "") == "acestep" and job.status in (
                "done", "failed", "canceled"):
            jobs.JOBS.pop(job_id, None)
        acecands.reconcile_output(jobs)
        return jsonify({"ok": True})

    @bp.route("/acestep/candidates/discard_all", methods=["POST"])
    def acestep_discard_all():
        """Discard all finished candidates and return counts for the caller. Do not stop running
    jobs or remove queued jobs; those have separate controls. The records go to the undo bin
    together and their files stay until a newer discard replaces the bin (`runtime/acecands.py`
    deletes them then; 2026-10-11, before that they stayed for good).
    """
        gone = []
        for job_id, job in list(jobs.JOBS.items()):
            if getattr(job, "kind", None) != "acestep":
                continue
            if job.status not in ("done", "failed", "canceled"):
                continue
            jobs.JOBS.pop(job_id, None)
            gone.append(job_id)
        # 🔴 ONE CALL, NOT ONE PER ROW. `forget()` REPLACES the recycle bin, so a loop over it
        # would leave only the LAST candidate recoverable — forty discarded, one undoable. One
        # press is one undoable action; `forget_many` bins the whole set together.
        acecands.forget_many(gone)
        acecands.reconcile_output(jobs)
        left =[j for j in jobs.JOBS.values() if getattr(j, "kind", None) == "acestep"]
        return jsonify({"ok": True, "discarded": len(gone), "ids": gone,
                        "undoable": acecands.bin_size(),
                        "still_running": sum(1 for j in left if j.status == "running"),
                        "still_queued": sum(1 for j in left if j.status == "queued")})

    @bp.route("/acestep/candidates/undo", methods=["POST"])
    def acestep_undo_discard():
        """Restore the most recent discard action, including all records removed by that action,
    from a one-level undo slot. The files of binned records are kept until the bin is replaced
    or emptied, so restored candidates remain playable unless the backend has since restarted.
    """
        rows = acecands.undo()
        restored = sum(1 for rec in rows if acecands.rehydrate_one(jobs, rec))
        return jsonify({"ok": True, "restored": restored,
                        "ids": [r.get("id") for r in rows],
                        "undoable": acecands.bin_size()})

    @bp.route("/acestep/queue/clear", methods=["POST"])
    def acestep_queue_clear():
        """Drop everything still WAITING. Never touches a song already on a card.

        A queued job has not reached ACE-Step, so it can be removed exactly. Submitted work keeps
        its reservation until a terminal result or confirmed child exit; this route does not stop
        those children.

        Returns `cleared` and `still_running` so the caller can say something true afterward.
        """
        cleared = []
        for job_id, job in list(jobs.JOBS.items()):
            if getattr(job, "kind", None) != "acestep":
                continue
            if QUEUE.remove(job_id):
                with job.lock:
                    job.status = "canceled"
                jobs.emit(job, {"type": "canceled"})
                _drop_queued(job_id)
                cleared.append(job_id)
        still = [j for j in jobs.JOBS.values()
                 if getattr(j, "kind", None) == "acestep" and j.status == "running"]
        return jsonify({"ok": True, "cleared": len(cleared), "still_running": len(still)})

    # ── candidates and the library (§4.5.3/§4.5.4) ───────────────────────────────────────────

    @bp.route("/acestep/jobs/<job_id>/audio")
    def acestep_job_audio(job_id):
        """Stream one CANDIDATE, proxied from the backend that made it.

        🔴 NOTHING IS STORED UNTIL SAVE. Most candidates are discarded — that is what a candidates
        tray is for — so fetching every one would write tens of MB of FLAC per press for audio
        about to be thrown away, and then need a sweeper for whatever nobody discarded by hand.
        It also keeps a song from having three homes at once (§6.4).

        ⚠️ The cost is honest: a candidate does not survive its backend restarting. That is what a
        candidate IS, and the header button already says as much about stopping one mid-render.
        """
        job = jobs.JOBS.get(job_id)
        if job is None or getattr(job, "kind", "") != "acestep":
            abort(404)
        with job.lock:
            d = dict(job.detail or {})
        audio, url = (d.get("audio") or []), d.get("url")
        if not audio or not url:
            # Not an error: a job that is queued or running simply has nothing to play yet, and
            # the tray asks for every row it draws.
            return jsonify({"error": "no audio yet"}), 409
        try:
            data = acestep.fetch_audio(url, audio[0])      # measured at 0.017s for 27 MB
        except Exception as exc:      # noqa: BLE001 — a dead backend is a 502, not a 500
            return jsonify({"error": _fetch_failed(exc, d.get("device") or "")}), 502
        return _audio_response(data, mimetype="audio/flac",
                               etag=f"ace-job-{job_id}-{len(data)}")

    @bp.route("/acestep/jobs/<job_id>/save", methods=["POST"])
    def acestep_job_save(job_id):
        """Promote a candidate into the permanent library (§4.5.3).

        This is the moment the song becomes Vocalis's: the bytes are fetched once, written through
        the vault, and indexed with the words they were ACTUALLY rendered from — not a pointer to
        the template, which can be edited or deleted afterward and would then make the library
        lie about its own history.

        🔴 THE WHOLE SUBMITTED STATE GOES ON THE ROW, not just caption and lyrics. Clicking a
        library song has to put the form back exactly as it was — bpm, key, time signature,
        language, duration, instrumental and the Advanced knobs — and then decide whether that
        still matches the template it was saved under. Two fields cannot answer either question.
        ⚠️ A candidate remembered before 8.0-m9 has no `template` in its detail; it falls back to
        the payload below, which is where caption and lyrics have always come from.
        """
        job = jobs.JOBS.get(job_id)
        if job is None or getattr(job, "kind", "") != "acestep":
            abort(404)
        with job.lock:
            d = dict(job.detail or {})
        if not (d.get("audio") and d.get("url")):
            return jsonify({"error": "that song has not finished"}), 409
        body = request.get_json(silent=True) or {}
        payload = d.get("payload") or {}
        try:
            data = acestep.fetch_audio(d["url"], d["audio"][0])
            song = acelib.save(
                data,
                name=body.get("name") or d.get("title") or "Untitled",
                template_id=d.get("template_id"),
                caption=payload.get("prompt", ""), lyrics=payload.get("lyrics", ""),
                model=d.get("model", ""), seed=d.get("seed"), device=d.get("device", ""),
                template=d.get("template"), settings=d.get("settings"),
                # 8.1-m2a: what the LM actually rendered, when it said. `caption`/`lyrics` above
                # stay the SUBMITTED words on purpose — they are what the row is compared against
                # its template with, and the specs pin that. This is the other half of the truth.
                rendered=d.get("rendered"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:      # noqa: BLE001
            # ⚠️ The same sentence as the play path, and for the same reason: the two failures ARE
            # the same failure — one fetch, one dead backend — and answering them differently is
            # what made "could not save it: <urlopen error [Errno 111]>" read as data loss.
            return jsonify({"error": _fetch_failed(exc, d.get("device") or "")}), 502
        return jsonify(song.to_dict()), 201

    @bp.route("/acestep/library")
    def acestep_library():
        """The saved songs, newest first. `?template_id=` narrows to the songs made from one —
        which is what selecting a template in the picker does by default (§4.5.3)."""
        tid = request.args.get("template_id") or None
        rows = [s.to_dict() for s in acelib.list_songs(tid)]
        # 8.9 — stamp each song's virtual folder. Scope `acelib`, keyed on `id`.
        # 📌 NOT in `folders.RENAME_MOVES_REF`: the id is a uuid4 assigned once at save and the
        # rename route only writes `name`, so the key cannot move — the safest kind of scope,
        # with nothing for a future rename path to remember.
        # ⚠️ Stamped even when `?template_id=` narrows the list: a filtered VIEW must not change
        # what a row IS, or filing a song under one template would appear to unfile it under another.
        rows = folders.for_rows(paths.FOLDERS.parent, "acelib", rows, ref_key="id")
        return jsonify({"songs": rows})

    @bp.route("/acestep/library/<song_id>/audio")
    def acestep_library_audio(song_id):
        """Stream a saved song. `?format=opus` transcodes at 192k; anything else serves the FLAC.

        🔴 THE LIBRARY STAYS LOSSLESS AND THE TRANSCODE HAPPENS HERE, not at save time. Voice Swap
        and Demucs will eventually consume these, and both want the lossless copy; storing an Opus
        twin as well would double the space and make "which one is the song" ambiguous again.
        """
        p = acelib.audio_path(song_id)
        if not any(s.id == song_id for s in acelib.list_songs()):
            abort(404)
        want_opus = (request.args.get("format") or "").lower() == "opus"
        if not want_opus:
            data = vault_fs.read_bytes(p)                  # measured at 0.02s for 27 MB
            return _audio_response(data, mimetype="audio/flac",
                                   etag=f"ace-song-{song_id}-{len(data)}")
        try:
            data = acelib.to_opus(p)
        except Exception as exc:      # noqa: BLE001
            return jsonify({"error": f"could not transcode: {exc}"}), 500
        # ⚠️ Range-servable too, and not only for symmetry: this is what the download link uses,
        # and a browser download that cannot resume is a download that starts over on a blip.
        return _audio_response(data, mimetype="audio/ogg",
                               etag=f"ace-song-{song_id}-opus-{len(data)}")

    @bp.route("/acestep/library/<song_id>", methods=["POST"])
    def acestep_library_update(song_id):
        d = request.get_json(silent=True) or {}
        fields = {k: v for k, v in d.items() if k in ("name", "favorite")}
        if not fields:
            return jsonify({"error": "nothing to change"}), 400
        song = acelib.update(song_id, **fields)
        if song is None:
            abort(404)
        return jsonify(song.to_dict())

    @bp.route("/acestep/library/<song_id>", methods=["DELETE"])
    def acestep_library_delete(song_id):
        if not acelib.delete(song_id):
            abort(404)
        return jsonify({"ok": True})

    @bp.route("/acestep/library", methods=["DELETE"])
    def acestep_library_delete_many():
        """Delete multiple saved songs in one request and return `{deleted, missing}`. Use one
    store transaction so the index is read and written once, avoiding lost concurrent saves
    and partial client-side delete loops. Missing IDs are reported without failing the
    remaining deletions.
    """
        d = request.get_json(silent=True) or {}
        ids = d.get("ids")
        if not isinstance(ids, list) or not ids:
            return jsonify({"error": "`ids` must be a non-empty list"}), 400
        deleted, missing = [], []
        for sid in [str(x) for x in ids if str(x)]:
            (deleted if acelib.delete(sid) else missing).append(sid)
        return jsonify({"deleted": len(deleted), "missing": missing, "ids": deleted})

    return bp
