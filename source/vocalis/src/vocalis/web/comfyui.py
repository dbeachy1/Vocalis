"""Owns `/comfyui/*` routes for the local ComfyUI service. Runtime discovery, availability, and probes live in `vocalis.runtime.comfyui`. ComfyUI's `/api/free` does not release reserved ROCm memory on this stack; restarting the systemd unit releases the process's GPU allocations."""
import subprocess
import time

from flask import Blueprint, jsonify, request

from vocalis.runtime import comfyui
from vocalis.runtime import gpu
from vocalis.runtime import paths


def create_comfyui_blueprint() -> Blueprint:
    """Nothing is injected: every dependency is a runtime module both sides import normally.

    Contrast `create_stream_blueprint`, which takes `current_pool` and the voice resolver
    because those were still `vocalis_server`'s at the time. This one needs no such favor,
    which is the whole point of having done Phase 3 first.
    """
    bp = Blueprint("vocalis_comfyui", __name__)

    @bp.route("/comfyui/status")
    def comfyui_status():
        """For the header button: is ComfyUI controllable, and how much VRAM could a
        restart free right now (so the UI can disable the button when there's nothing to
        free and show an 'up to ≈X GB' tooltip). `vram_gb` = max(ComfyUI's self-report,
        non-Vocalis whole-card usage) — the self-report alone missed ~20 GB live (see
        comfyui_vram_bytes), so the light-green 'other' share is the honest estimate."""
        if not comfyui.comfyui_control_available():
            return jsonify({"available": False})
        vb = comfyui.comfyui_vram_bytes()
        freeable = max((vb or 0) / 2**30, gpu.other_vram_gb())
        return jsonify({"available": True, "up": vb is not None,
                        "vram_gb": round(freeable, 2),
                        "min_free_gb": comfyui.COMFYUI_MIN_FREE_GB,
                        "instances": len(comfyui.comfyui_instances()),
                        "running": comfyui.comfyui_active_count()})

    # 4.8-m4f: the header button became STOP / START rather than Restart, because ComfyUI's
    # cost is no longer only VRAM. An image-training run wants ~60 GB of SYSTEM RAM, and a
    # ComfyUI that is merely restarted takes its share straight back — the only way to hand
    # it over is to leave it stopped. Restart survives as a route (nothing else changed about
    # it) but nothing in the UI calls it now; stop→start is the same thing in two clicks, and
    # unlike Restart it shows you which state you are in.
    def _systemctl(action: str, wait_ready: bool, check_busy: bool):
        """Run one systemctl verb across EVERY instance and report what it freed.

        Shared by start/stop/restart because the interesting parts — attempt every unit even
        if one is dead, measure the whole-card delta rather than trusting a self-report, name
        the unit that failed — are identical for all three; only the verb, whether a
        running job blocks it, and whether we wait for the API to come back differ."""
        if paths.docker_encrypted_mode():
            return jsonify({"error": "not_available_in_docker",
                            "message": "Docker Vocalis does not control host ComfyUI services."}), 501
        insts = comfyui.comfyui_instances()
        if not insts:
            cfgd = ", ".join(s for s, _ in comfyui.comfyui_configured())
            return jsonify({"error": f"no controllable ComfyUI service ({cfgd}) on this host"}), 501
        force = bool((request.get_json(silent=True) or {}).get("force"))
        if check_busy and not force:
            # 🔴 9.0-m4: ASK OUR OWN RUN STATE FIRST, BECAUSE ComfyUI'S QUEUE LIES BETWEEN
            # SUBMISSIONS. `comfyui_queue_busy()` is truthy only when it can positively SEE work,
            # and a generation loop that holds N items locally and submits ONE at a time — which
            # is the `acequeue` pattern and is otherwise right — leaves the queue momentarily
            # EMPTY between two submissions. A click landing in that window read "not busy" and
            # stopped ComfyUI mid-run, losing every image still to come.
            #
            # 📌 The external LEASE is the run state, so there is no third source of truth to
            # drift: whatever holds a card via `GpuGate.claim_external` holds it for the whole
            # run, submissions and gaps alike.
            leased = gpu.GPUS.external()
            if leased:
                return jsonify({"error": "comfyui_busy", "running": len(leased), "pending": 0,
                                "holders": sorted(leased.values())}), 409
            busy = comfyui.comfyui_queue_busy()   # truthy ONLY when we can positively see work in flight
            if busy:
                return jsonify({"error": "comfyui_busy", "running": busy[0], "pending": busy[1]}), 409
        before = gpu.used_vram_gb_total()        # measured, not self-reported: the freed figure
        ram_before = gpu.used_ram_gb()           # is the whole-card delta (see comfyui_vram_bytes)
        failures = []
        for svc, _url in insts:               # attempt EVERY instance — one dead unit must
            try:                              # not strand the other's 20 GB
                r = subprocess.run(
                    ["systemctl", "--user", action, svc],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
                )
            except subprocess.TimeoutExpired:
                failures.append(f"{svc}: {action} timed out")
                continue
            except OSError as e:
                failures.append(f"{svc}: could not run systemctl: {e}")
                continue
            if r.returncode != 0:
                failures.append(f"{svc}: " + ((r.stderr or r.stdout or "").strip()
                                              or f"systemctl exited {r.returncode}"))
        if failures:
            return jsonify({"error": "; ".join(failures)}), 502
        ready, waited = (comfyui.comfyui_wait_ready(comfyui.COMFYUI_READY_TIMEOUT)
                         if wait_ready else (False, 0.0))
        time.sleep(1.0)                       # the AMD VRAM sensor lags ~1-2 s behind a free
        after, ram_after = gpu.used_vram_gb_total(), gpu.used_ram_gb()
        delta = lambda b, a: (round(max(0.0, b - a), 2) if b is not None and a is not None else None)  # noqa: E731
        return jsonify({"ok": True, "services": [s for s, _ in insts], "action": action,
                        "ready": ready, "waited_s": round(waited, 1),
                        "freed_gb": delta(before, after),
                        "freed_ram_gb": delta(ram_before, ram_after),
                        "running": comfyui.comfyui_active_count()})

    @bp.route("/comfyui/restart", methods=["POST"])
    def comfyui_restart():
        """Free the VRAM ComfyUI holds on the shared GPU(s) by restarting its process(es) —
        the only thing that works here (its /api/free releases nothing on this ROCm stack).
        Every configured instance restarts; multi-GPU hosts may run one instance per card. Refuses
        with 409 if ANY
        instance has a job running/queued (unless force), then waits until all are
        serviceable again and reports the GB reclaimed."""
        return _systemctl("restart", wait_ready=True, check_busy=True)

    @bp.route("/comfyui/stop", methods=["POST"])
    def comfyui_stop():
        """Stop every ComfyUI instance and leave it stopped — this is the one that hands back
        system RAM as well as VRAM. Same 409-unless-force busy guard as restart: killing a
        running render is the user's call, not ours. No ready-wait; there is nothing to come
        back."""
        return _systemctl("stop", wait_ready=False, check_busy=True)

    @bp.route("/comfyui/start", methods=["POST"])
    def comfyui_start():
        """Start every ComfyUI instance and wait until all answer their API. No busy check —
        a stopped ComfyUI has no queue to protect."""
        return _systemctl("start", wait_ready=True, check_busy=False)

    return bp
