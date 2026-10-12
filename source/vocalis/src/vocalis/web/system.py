"""`/health`, `/gpus*`, `/system/stats`, `/system/stream`, `/model/*`, `/engine/restart`,
`/enhance/info`, `/render/rate`, `/library` — the box's own status and controls (5.1-P4.17).

Eleven routes (`/system/stream` joined at 9.0.8), and **no injected dependency at all** — the
payoff the ledger predicted for doing `runtime/auth.py` (P4.15) before the route lifts. Everything here reaches a `vocalis.runtime`
module directly, so there is no parameter list to keep in step and no default that can quietly
fall back to an old binding. Measured: **12 names, 194 lines, 0 shared, reverse check empty, and
not one test rebinds any of it** — the cleanest domain of the whole refactor.

🔴 **`/health` IS OPEN AND UNAUTHENTICATED, LOCKED OR NOT, AND THAT MUST NOT CHANGE.** It is on
`_OPEN_PATHS` and on `_require_unlocked`'s exempt list, both of which are path-based and live in
`vocalis_server` — so this move did not touch them, and a rename of any URL here would. It is the
one thing a locked Vocalis still answers, which is what lets the Nomi and SillyTavern extensions
say "Vocalis is locked — log in" instead of hammering a path that will never succeed (design
§5.3), and how a still-open tab learns a restart happened so it can POST its SUK back.

⚠️ **`/enhance/info` and `/render/rate` are SYSTEM, not playground, even though they sat inside
the playground's block of the monolith** (§4.3: classify by what the body does, not by which
routes happen to be neighbors). Both answer "what can THIS BOX do, and how fast" — neither
touches a job, a clip or a stream. P4.12 deliberately left them behind for this phase; extracting
the playground by line range would have swept them in.

⚠️ **`/library` is filed here for the same reason**, and the P4.14 handoff flagged it explicitly:
it sits *inside* the books block and is not books. It reports what is on disk — sidecar-
independent, so books copied in from outside the app appear — which is a filesystem fact about
this box, not the Books tab's workflow.

🔴 **`OUTPUT_DIR` IS CAPTURED PER IMPORTER, AND THIS MODULE IS NOW A THIRD CAPTURE SITE.**
`from book_to_audio import OUTPUT_DIR` binds a name in *this* module; rebinding
`book_to_audio.OUTPUT_DIR` later does not reach it, and it is deliberately re-exported nowhere.
`tests/test_server.py`'s `tmp_output` fixture therefore had to gain
`monkeypatch.setattr(web_system, "OUTPUT_DIR", out)` in the same commit as this move — without it
`/library` reads the developer's REAL `output/` tree, and the negative assertions
(`assert all(b["book"] != "empty" …)`) pass vacuously while doing so. `vocalis_server` keeps its
own binding because the orphaned-regenbak sweep still reads it.
"""
import json
import os
import threading
import time

from flask import Blueprint, Response, jsonify, request

import book_state
import enhance
import folders
import render_rate
from book_to_audio import OUTPUT_DIR, books_root
from tts_utils import PRODUCT_NAME, VERSION

from vocalis.runtime import auth
from vocalis.runtime import comfyui
from vocalis.runtime import configs
from vocalis.runtime import enhancement
from vocalis.runtime import gpu
from vocalis.runtime import jobs
from vocalis.runtime import paths
from vocalis.runtime import pool as rt_pool
from vocalis.runtime import procs
from vocalis.runtime import voxcpm_pool
import voice_utils
from vocalis.runtime.gpu import GPUS
from vocalis.runtime.voxcpm_pool import VOX

# ── the hardware strip's push channel (9.0.8) ────────────────────────────────
# One held connection replaces four requests per second. The strip
# was costing a full request/response round trip 4x/s per open tab, forever, on a box that is
# also rendering. The sample it carries is unchanged — `gpu.strip_sample()`, the same shared,
# TTL'd read `/system/stats` returns — so this is the TRANSPORT changing and nothing else.
#
# ⚠️ `/system/stats` STAYS, and not for compatibility's sake. It is what the one-shot pokes use
# (`pollVram` after a model load, after a ComfyUI bounce, on becoming visible again), it is what
# the browser specs read directly, and it is the fallback below.

#: Matches the UI's own sample rate — `POLL_MS` in `js/sys/hwstrip.js`, and `vram_ticker`'s 0.25 s
#: while a job runs. Not a knob: the bars glide between samples and at 1 Hz the glide is a
#: visible staircase (jobs.vram_ticker's note has the whole argument).
STRIP_FRAME_S = 0.25

#: The blank line that ends an SSE event. Named because the frame is built by concatenation
#: here and a bare escaped newline pair inside an f-string is the kind of thing an editor eats. A
#: frame missing its terminator does not error anywhere, it just never arrives at the browser.
SSE_END = "\n\n"

#: 🔴 A HARD CAP, BECAUSE EACH OPEN STREAM OCCUPIES A SERVER THREAD FOR AS LONG AS THE TAB IS.
#: Vocalis serves through `make_server(..., threaded=True)`, so a long-lived response is a thread,
#: not a coroutine — the same reasoning, and the same number, as `wbedit/doorbell.py`'s cap. A
#: client refused here is NOT broken: it falls back to polling `/system/stats`, which is what it
#: did before this route existed, so the ceiling costs a tab its efficiency and never its strip.
MAX_STRIP_STREAMS = 8

_STRIP_STREAM_LOCK = threading.Lock()
_strip_streams = 0


def _strip_stream_open() -> bool:
    """Claim a slot. `False` when the cap is reached — the caller must not stream."""
    global _strip_streams
    with _STRIP_STREAM_LOCK:
        if _strip_streams >= MAX_STRIP_STREAMS:
            return False
        _strip_streams += 1
        return True


def _strip_stream_close() -> None:
    """Give a slot back.

    ⚠️ EXACTLY ONCE PER CLAIM, FROM THE GENERATOR'S `finally` AND NOWHERE ELSE. A leaked slot is
    permanent — nothing sweeps this counter — and eight leaks close the channel for every tab
    until the process restarts. A DOUBLE release is the mirror failure and hands out a ninth
    stream, which is why the route has one release path rather than a belt-and-braces second."""
    global _strip_streams
    with _STRIP_STREAM_LOCK:
        _strip_streams = max(0, _strip_streams - 1)


def strip_stream_count() -> int:
    """How many strips are being pushed right now.

    ⚠️ READ BY TESTS ONLY. It said "and for `/health`-style reads" when it was written, which
    described an intention rather than a caller — nothing in `/health` consults it. A reader who
    believed that sentence would go looking for a caller that has never existed."""
    with _STRIP_STREAM_LOCK:
        return _strip_streams


# /model/load and /model/unload take `which`: chatterbox (the default — the pre-4.8
# contract every existing caller relies on), voxcpm, or all. The two models' states
# are independent; "all" is both, refused atomically when the Chatterbox half can't.
_MODEL_WHICH = ("chatterbox", "voxcpm", "all")


def create_system_blueprint() -> Blueprint:
    """No arguments, and that is the point — see the module docstring."""
    bp = Blueprint("vocalis_system", __name__)

    @bp.route("/health")
    def health():
        """OPEN and unauthenticated, locked or not — and it must STAY that way.

        This is the one thing a locked Vocalis will still answer, and it is what lets the Nomi and
        SillyTavern extensions show "Vocalis is locked — log in" instead of silently failing or
        hammering a path that will never succeed (design §5.3). It is also how a still-open tab
        learns that a restart happened, so it can POST its SUK back and re-unlock silently.
        """
        v = configs.voxcpm_cfg()
        vox_devices = VOX.ready_devices_sorted()
        return jsonify({"status": "ok", "product": PRODUCT_NAME, "version": VERSION,
                        "model_ready": rt_pool.model_ready(), "model_loading": rt_pool.model_loading(),
                        "auth": auth.auth_enabled(), "comfyui": comfyui.comfyui_control_available(),
                        "initialized": auth.STORE.is_initialized(), "locked": auth.vault_locked(),
                        # The Docker package (VOCALIS_REQUIRE_VAULT). The page reads this ONE flag
                        # to word texts true for a container: host paths, `/logs`, loopback
                        # addresses and source-install commands mean something else there.
                        "docker": paths.docker_encrypted_mode(),
                        "dev_unlock": auth.STORE.is_dev_unlocked(),
                        # 4.8: the second loadable model. `available` gates the whole
                        # per-model UI — absent venv ⇒ the header keeps its single button.
                        # `devices` is one entry per card with a ready worker (two = the
                        # two-at-once path is live).
                        "voxcpm": {"available": v.available, "ready": bool(vox_devices),
                                   "loading": VOX.loading(), "devices": vox_devices},
                        # 4.8-m4h: engines running outside Vocalis. This rides /health rather
                        # than getting a poll of its own because /health is ALREADY on a 3 s
                        # tick, which is the cadence this wants anyway.
                        "foreign": procs.foreign_engines()})

    @bp.route("/model/unload", methods=["POST"])
    def model_unload():
        """Free a model's VRAM so another app can use the cards. Chatterbox drops its
        replicas (refused while a render holds the GPUs; rendering later auto-reloads);
        VoxCPM2's worker just dies — nothing schedules it in m1, so there is nothing to
        refuse for, and process death frees everything it held."""
        which = str((request.get_json(silent=True) or {}).get("which") or "chatterbox").lower()
        if which not in _MODEL_WHICH:
            return jsonify({"error": f"unknown model {which!r}"}), 400
        if which in ("chatterbox", "all"):
            if not GPUS.acquire(timeout=0.5):
                return jsonify({"error": "a render is in progress — cancel or wait for it to finish"}), 409
            try:
                rt_pool.drop_pool()
            finally:
                GPUS.release()
        if which in ("voxcpm", "all"):
            VOX.stop()
        if which in ("chatterbox", "all"):
            # The satellite half (5.3). In a THREAD, and not inside the GPUS block above: a
            # an offline satellite costs
            # Unload must not hang on a machine that is gone. Best-effort by design — its own
            # operator console is where the service can be stopped directly.
            from vocalis.runtime import satellites as rt_sat
            if rt_sat.configured():
                threading.Thread(target=rt_sat.unload_all, daemon=True).start()
        return jsonify({"ok": True, "model_ready": rt_pool.model_ready(), "voxcpm_ready": VOX.ready()})

    @bp.route("/model/load", methods=["POST"])
    def model_load():
        """Warm model(s) in the background; the UI polls /health. Chatterbox = the default
        pool (all cards, configured workers); VoxCPM2 = one worker on the emptiest card.
        No-op per model if already loaded or a load is in flight."""
        which = str((request.get_json(silent=True) or {}).get("which") or "chatterbox").lower()
        if which not in _MODEL_WHICH:
            return jsonify({"error": f"unknown model {which!r}"}), 400
        resp = {"ok": True}
        if which in ("voxcpm", "all"):
            cfg = configs.voxcpm_cfg()
            cards = voxcpm_pool.usable_cards()
            if not cfg.available:
                # Asked for by name → a real answer. Under "all" it is silently skipped:
                # /health says available:false and the UI never offers what isn't there.
                if which == "voxcpm":
                    return jsonify({"error": "voxcpm_unavailable",
                                    "message": cfg.unavailable_reason}), 503
            elif not cards:
                # A designed voice generates on ONE GPU (~7 GB, RTF≈0.6). CPU would take
                # tens of minutes per audition clip — refusing beats pretending.
                if which == "voxcpm":
                    return jsonify({"error": "no_gpu",
                                    "message": "VoxCPM2 needs a free GPU and the ⚙ Settings GPU "
                                               "selection has none available on this box."}), 501
            else:
                # ONE critical section: read the pool, diff it, check the flag, take the ticket.
                # Split any of that and two POSTs a millisecond apart both decide to load.
                # 🔴 5.1.1: `claim_load` returns [] for TWO different states — "nothing is
                # missing" and "something is missing but a load already holds the ticket" —
                # so the baseline's three-way branch collapsed into two and the `else` below
                # became unreachable. A POST arriving mid-load answered `already: true,
                # voxcpm_ready: false` (a state the old route could never produce) instead of
                # `voxcpm_loading: true`. Baseline computed `missing` AND `kick` separately
                # (49a5835:2458-2461); ask the pool the second question explicitly to get
                # those three branches back.
                missing = VOX.claim_load(cards)
                if missing:
                    threading.Thread(target=VOX.load_bg, args=(missing,), daemon=True).start()
                    resp["voxcpm_loading"] = True
                elif VOX.loading():
                    resp["voxcpm_loading"] = True    # a load is already in flight
                else:
                    resp.update(voxcpm_ready=VOX.ready(), already=True)
        if which in ("chatterbox", "all"):
            if rt_pool.model_ready():
                resp.update(model_ready=True, already=True)
            else:
                if not rt_pool.model_loading():
                    threading.Thread(target=rt_pool.preload_default_pool, daemon=True).start()
                resp["loading"] = True
        return jsonify(resp)

    @bp.route("/engine/restart", methods=["POST"])
    def engine_restart():
        """Fully free ALL VRAM — including the ~1.5 GB of ROCm runtime workspace that an
        in-process unload can't release — by exiting so systemd (Restart=always) starts a
        fresh, COLD process. The web UI stays reachable; the model reloads on demand.
        Refuses while a render holds the GPUs."""
        force = bool((request.get_json(silent=True) or {}).get("force"))
        if not force and not GPUS.acquire(timeout=0.5):
            return jsonify({"error": "render_in_progress"}), 409   # UI offers a force option
        # Deliberately keep GPUS (when acquired) — we're exiting, so nothing new should
        # grab the GPUs in the moment before the process dies.
        def _exit_soon():
            time.sleep(0.3)          # let the HTTP response flush to the browser first
            try:
                VOX.stop()          # the VoxCPM2 worker is OUR child: under systemd the
            except Exception:        # cgroup kill would catch it, but a dev-box process
                pass                 # exiting bare would orphan it holding a card
            os._exit(0)              # clean exit -> systemd restarts us cold (no preload)
        threading.Thread(target=_exit_soon, daemon=True).start()
        return jsonify({"ok": True, "restarting": True})

    @bp.route("/gpus")
    def gpus():
        """Return local GPU rows with the workloads each device is authorized to run. Build the capability list from the shared permission predicate so pickers and routes use the same policy; this handler joins the result to hardware rows."""
        rows = gpu.gpu_registry()
        perms = rt_pool.local_card_permissions([r["index"] for r in rows])
        for r in rows:
            r["allows"] = perms.get(r["index"], {})
        return jsonify(rows)

    @bp.route("/gpus/stats")
    def gpus_stats():
        return jsonify(gpu.gpu_stats())

    @bp.route("/system/stats")
    def system_stats():
        """The whole hardware strip in one poll: every card, plus the CPU line.

        A separate route rather than a new shape for /gpus/stats — that one returns a bare
        LIST and other callers rely on it. The UI polls this 4x/s; see gpu.strip_sample() for why
        the sample behind it is shared rather than taken per request."""
        return jsonify(gpu.strip_sample())

    @bp.route("/system/stream")
    def system_stream():
        """Stream the same sample as `/system/stats` over one held connection. When the stream limit is reached, return 503 so the client can fall back to polling `/system/stats`."""
        if not _strip_stream_open():
            return jsonify({"error": "too many streams", "max": MAX_STRIP_STREAMS}), 503

        # 🔴 THE SLOT IS CLAIMED HERE, BEFORE THE GENERATOR EXISTS, AND RELEASED IN ITS `finally`
        # — AND THAT IS ENOUGH, WHICH IS NOT OBVIOUS. A generator that is never STARTED never
        # entered its `try`, so closing it runs no `finally` at all; if that could happen here the
        # slot would leak for the life of the process, and eight leaks close the channel for every
        # tab until a restart. It cannot happen: WSGI requires `start_response` before the first
        # byte, so the server primes the iterator as part of dispatching the request. Measured on
        # this Flask/werkzeug rather than assumed — the generator is started before any read, and
        # its `finally` runs on close.
        #
        # ⚠️ SO DO NOT ADD A SECOND RELEASE PATH "FOR SAFETY". A `call_on_close` alongside the
        # `finally` was written, mutation-tested, and backed out: removing it changed no test,
        # because there is no reachable case it covers. What it WOULD add is a second way to
        # decrement one counter, and a double release hands out a ninth stream.
        def frames():
            try:
                # `retry:` is the client's reconnect interval and it is in the SSE spec rather
                # than a library feature — a tab that freezes under memory pressure and thaws
                # reconnects by itself. That is the difference from a poll: transient and
                # self-healing rather than permanent and silent.
                yield "retry: 3000" + SSE_END
                while True:
                    # 🔴 THIS WRITE IS ALSO HOW A CLOSED TAB IS DISCOVERED. Unlike the doorbell,
                    # which blocks on a queue and needs a separate keepalive to notice, this loop
                    # writes every 250 ms — so the socket error arrives within a frame, unwinds
                    # the generator, and runs the `finally`. No keepalive is needed BECAUSE the
                    # payload is the keepalive; that stops being true the moment anyone makes
                    # this conditional on the sample having changed.
                    yield "data: " + json.dumps(gpu.strip_sample()) + SSE_END
                    time.sleep(STRIP_FRAME_S)
            finally:
                _strip_stream_close()

        return Response(frames(), mimetype="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        })

    @bp.route("/enhance/info")
    def enhance_info():
        """What the UI needs to render the Enhance controls honestly: whether this box can do
        it at all (the Windows dev box cannot — no venv, no card), the step choices, and the
        per-step cost so the Book tab can quote a real number of HOURS before you commit to
        one. A 10-hour book at 32 steps is ~1.4 hours of GPU on two cards; that is not a number
        to discover afterward — in either direction. (It said EIGHT until the constants were
        measured rather than guessed, which is its own lesson about serving a number you have
        not timed.)

        THE COST IS THIS BOX'S OWN, OR IT IS ABSENT. `rates` carries only step counts this box
        has actually been timed at (enhance_rate.py); a step count it has never run is simply
        not in the map, and the UI must then say "no estimate yet" rather than draw one from
        somewhere. On a fresh install the map is empty — that is correct, not a bug."""
        from vocalis_streaming import StreamConfig
        # Measured on THIS box, per step count. {} until the first enhancement here has been
        # timed — which is the whole point: an un-run box has no rate, and says so.
        rates, startups = {}, {}
        for n in enhance.NFE_CHOICES:
            fit = enhance.measured(n)
            if fit:
                startups[str(n)], rates[str(n)] = round(fit[0], 2), round(fit[1], 4)
        return jsonify({
            "available": enhancement.enhance_available(),
            "installed": configs.enhance_cfg().available,
            "cards": len(enhancement.enhance_cards()),
            "nfe_choices": list(enhance.NFE_CHOICES),
            "nfe_default": enhance.NFE_DEFAULT,
            # Seconds of GPU per second of audio, per card — MEASURED HERE, keyed by step count.
            "seconds_per_audio_second": rates,
            # Model load, paid once per file enhanced. The client must add it or it will
            # nearly halve the quote for a short clip — at 25 seconds the load is about half
            # the wall clock. Also measured here, also per step count.
            "startup_seconds": startups,
            "full_band_hz": enhance.FULL_BAND_HZ,
            # Chars per second of AUDIO — the measured constant the streaming governor
            # already runs on. NOT the render rate (/render/rate), which is chars per second of
            # GPU and answers a completely different question; using that one here would quote
            # the time to RENDER the book as the time to ENHANCE it. This is what turns a book's
            # character count into an audio length, and an audio length into an honest ETA.
            "chars_per_audio_second": StreamConfig().chars_per_second,
            "cap_seconds": jobs.CAP_SECONDS,
            "message": None if enhancement.enhance_available() else enhancement.enhance_unavailable_reason(),
        })

    @bp.route("/render/rate")
    def render_rate_info():
        """What this box renders at, if it has been measured. `measured: false` means the UI must
        show no estimate. A card name alone cannot determine worker count or
        render throughput, so estimates are shown only for a measured configuration."""
        # The LOCAL cards, through the one helper that owns that question — the same answer as
        # `parse_devices(default_gpus())` (`cuda_count` filters to `cuda:` either way, and a
        # satellite id never starts with `cuda`), but without inheriting `parse_devices`'s
        # raise on a saved card index this box no longer enumerates. This route quoted an ETA;
        # it should not be able to 500 because ⚙ Settings remembers a card that is down.
        devices = rt_pool.local_cuda_devices()
        workers = rt_pool.default_workers()
        key = render_rate.key_for(render_rate.gpu_name(), gpu.cuda_count(devices), workers)
        rate = render_rate.get(key)
        return jsonify({
            "measured": rate is not None,
            "rate": rate,                       # chars/sec of WALL CLOCK, this box, this config
            "key": key,
            "min_chars": render_rate.MIN_CHARS,
            "min_seconds": render_rate.MIN_SECONDS,
        })

    @bp.route("/library")
    def library():
        """Every book on disk (any output/ subfolder with audio) — sidecar-independent
        (§5.2). Books copied in outside the app show up too."""
        # 5.3: books moved to output/books/, so the Library tab scans there. Scanning
        # OUTPUT_DIR would now walk the playground / stems / voiceswap stores as well and
        # offer them as library entries the moment one of them grew a `mp3/` folder.
        rows = book_state.scan_library(books_root(OUTPUT_DIR),
                                       voice_labels=voice_utils.get_labels(paths.VOICE_SETTINGS))
        # 8.9 — stamp each row's virtual folder. Scope `books`, keyed on `book`, which is the
        # output directory's own name. Display renames change only sidecar metadata, so the
        # stable key stays in its virtual folder without a `folders.RENAME_MOVES_REF` hook.
        return jsonify(folders.for_rows(paths.FOLDERS.parent, "books", rows, ref_key="book"))

    return bp
