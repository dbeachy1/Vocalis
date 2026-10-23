"""The Vocalis render satellite.

A GPU worker controlled by Vocalis. Every route, including health, requires an authenticated sealed
request. Requests and responses use X-Vocalis-Salt plus direction-specific sealed frames (k2s inbound,
s2k outbound); distinct HKDF info values prevent cross-direction replay. Logs contain request ids and
hash prefixes, never submitted text or names."""
import argparse
import errno
import json
import logging
import os
import re
import signal
import socket
import sys
import threading
import time
import uuid
import warnings
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


# The version is diagnostic only; clients select optional routes through `capabilities` and protocol fields.
# Keep capability discovery backward-compatible so older clients can continue using single-chunk rendering.
SATELLITE_VERSION = "2.1.1"
REQUIRES_SERVER = "5.3-m1"          # informational minimum; startup compatibility is not enforced

# The line that ends one run in the log, so the next start is easy to find (Doug, October 11, 2026: "log me out a
# horizontal line of equal sign for like, I don't know, 60 characters so I can see a clean break on startup... Put that
# line right after it says the satellite is exiting").
RUN_BREAK = "=" * 60

# Where the stop handler writes its two lines; set when the program runs as the satellite (below).
_STOP_LOG_DIR = None


def _write_by_hand(log_dir, lines, now=None, console=None, break_first_if_missing=False):
    """Write lines to the satellite's log file and the console without the logging library.

    Two moments need this. At the very start, PyTorch and the speech libraries have not been loaded and the log is
    not configured yet (that happens in main(), seconds later). At a stop, the signal can arrive at any moment,
    including while a log call is in progress, and the lines must be written all the same. The lines have the log
    file's own format, and each call is one append, so they sit whole between the library's lines. This never
    creates the log folder and never raises: a folder that is missing or cannot be written is main()'s to report.

    With `break_first_if_missing`, RUN_BREAK is written first when the file has content that does not end with it."""
    stamp = time.localtime() if now is None else now
    prefix = f"{time.strftime('%Y-%m-%d %H:%M:%S', stamp)} | INFO    | "
    try:
        folder = Path(log_dir) if log_dir is not None else None
        if folder is not None and folder.is_dir():
            path = folder / "satellite.log"
            out = list(lines)
            if break_first_if_missing and path.is_file() and path.stat().st_size > 0:
                with open(path, "rb") as existing:
                    existing.seek(max(0, path.stat().st_size - 400))
                    if not existing.read().decode("utf-8", "replace").rstrip("\r\n").endswith(RUN_BREAK):
                        out.insert(0, RUN_BREAK)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write("".join(prefix + line + "\n" for line in out))
    except OSError:
        pass
    try:
        stream = console or sys.stderr
        stream.write("".join(f"{time.strftime('%H:%M:%S', stamp)} | INFO    | {line}\n" for line in lines))
        stream.flush()
    except (OSError, ValueError, RuntimeError):             # a closed or broken console, or a write the signal interrupted
        pass


def _announce_start(log_dir, now=None, console=None):
    """Say "starting", with the version, before anything slow happens.

    Loading the speech libraries takes several seconds and until then a start showed nothing at all (Doug, October
    11, 2026, watching the log window after pressing Start: "I hit start and nothing happened in the log for like, I
    don't know, some number of seconds... Have it log a line immediately that says service starting or satellite
    starting", and: "print the version of the satellite as the very first thing"). The name is not known yet; main()
    logs the full line with it as its first line.

    Each run is set off from the next by RUN_BREAK. A stop that was asked for writes it right after its "exiting"
    line (`_stop_on_sigterm`). A run that ended any other way (a crash, a kill, the power) left none, so it is
    written here first whenever the log does not already end with one."""
    _write_by_hand(log_dir, [f"Vocalis satellite {SATELLITE_VERSION} starting: loading the speech libraries, which takes a few seconds"],
                   now=now, console=console, break_first_if_missing=True)


def _stop_on_sigterm(signum, frame, _exit=os._exit, log_dir=None, now=None, console=None):
    """When asked to stop (`docker stop`, the tray icon's Stop, `vocalis-satellite stop`): say so, write the break
    line, and end the process at once. Always in that order (Doug, October 11, 2026: "You should always log the
    exiting line and then the equals line to separate and then you exit").

    Without a handler the satellite never stopped when asked. In its container it is the first process, and Linux
    does not deliver a signal to a container's first process unless that process handles it, so Docker waited out its
    10-second grace period and then killed it: every stop took 10 seconds and ended as exit 137 (measured October 11,
    2026 on the first 12.0.0 image). The handler is installed before the slow imports, so a stop during start-up is
    obeyed too. The exit is immediate and skips Python's normal shutdown on purpose: with render threads alive, that
    shutdown aborts inside the C++ runtime ("terminate called without an active exception", seen on the main server
    the same day). Nothing here needs it: the satellite keeps no state of its own, the two lines are written by hand
    (see `_write_by_hand`), and Vocalis handles a satellite disappearing. `_exit` and the rest are for the test."""
    _write_by_hand(_STOP_LOG_DIR if log_dir is None else log_dir,
                   ["stop requested: the satellite is exiting", RUN_BREAK], now=now, console=console)
    _exit(0)


if __name__ == "__main__":
    # Only when run as the satellite itself, never when a test or a tool imports this module.
    import vocalis_satellite_paths as _early_paths                    # noqa: E402 - small, no heavy imports
    _STOP_LOG_DIR = _early_paths.LOG_DIR
    _announce_start(_STOP_LOG_DIR)
    signal.signal(signal.SIGTERM, _stop_on_sigterm)

from vocalis_torch_backend import apply_rocm_miopen_policy, hide_integrated_rocm_gpus  # noqa: E402

# October 10, 2026: hide integrated AMD graphics BEFORE PyTorch is imported, by the helper the main
# server already uses (vocalis_server.py). HIP reads the visibility list once, at initialization.
# Without this an AMD satellite offers the CPU's integrated graphics as a card and a worker can
# land on it, as happened to the main server on the AMD Linux test machine on October 9 (a Chatterbox replica on the 2 GB
# Raphael iGPU, gfx1036). Nothing is logged yet: the log file is configured in main(), which
# writes the decision down with its values (`_log_gpu_visibility`).
_gpu_visibility = hide_integrated_rocm_gpus()

import torch  # noqa: E402

apply_rocm_miopen_policy(torch)

# Silence known upstream warnings that repeat during inference; keep failures visible.
# The CUDA SDPA deprecation and ignored attention-output warning are not consumed by this process.
warnings.filterwarnings("ignore", category=FutureWarning, message=".*sdp_kernel.*")
try:
    # transformers keeps its own log level, separate from the logging hierarchy — its API is the
    # only thing that turns this off. Errors still come through.
    from transformers.utils import logging as _hf_logging
    _hf_logging.set_verbosity_error()
except ImportError:                                   # a satellite that has not got there yet
    pass

import numpy as np
import yaml
from flask import Flask, Response, g, request
from loguru import logger
from werkzeug.serving import ThreadedWSGIServer

import vocalis_satellite_batch as batchmod           # noqa: E402
import vocalis_satellite_gpustats as gpustats        # noqa: E402
import vocalis_satellite_leadvocal as leadvocal       # noqa: E402
import vocalis_satellite_paths as satpaths           # noqa: E402
import vocalis_satellite_protocol as proto           # noqa: E402
import vocalis_stream_core as stream_core            # noqa: E402
from vocalis_satellite_engine import (               # noqa: E402
    ENGINE, GenerationCanceled, SatelliteError,
)

CONFIG_FILE = satpaths.CONFIG_FILE
KEYRING_SERVICE = "vocalis-satellite"
LOG_DIR = satpaths.LOG_DIR

app = Flask(__name__)
# Bound the complete buffered request before parsing; the sealed-frame limit is checked later.
# The additional space covers envelope overhead above the upstream upload limit.
app.config["MAX_CONTENT_LENGTH"] = 160 * 1024 * 1024
_MASTER = None
_NAME = "satellite"


# ── config + secret ──────────────────────────────────────────────────────────

def load_config() -> dict:
    explicit = satpaths.configured("VOCALIS_SATELLITE_CONFIG")
    if not CONFIG_FILE.exists():
        if explicit:
            raise RuntimeError(f"VOCALIS_SATELLITE_CONFIG file is missing: {CONFIG_FILE}")
        return {}
    d = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8"))
    if isinstance(d, dict):
        return d
    if explicit:
        raise RuntimeError(f"VOCALIS_SATELLITE_CONFIG must contain a YAML mapping: {CONFIG_FILE}")
    return {}


def load_master(name: str) -> bytes:
    """Load a validated master key from a mounted file, environment, or keyring."""
    def decode(value: str, source: str) -> bytes:
        candidate = value.strip()
        if len(candidate) != proto.MASTER_BYTES * 2 or not re.fullmatch(
                r"[0-9a-fA-F]+", candidate):
            raise SystemExit(
                f"Invalid satellite secret in {source}: expected "
                f"{proto.MASTER_BYTES * 2} hexadecimal characters.")
        return bytes.fromhex(candidate)

    secret_file = "VOCALIS_SATELLITE_SECRET_FILE"
    if secret_file in os.environ:
        raw_path = os.environ[secret_file].strip()
        if not raw_path:
            raise SystemExit(f"{secret_file} is set but empty")
        try:
            value = Path(raw_path).expanduser().read_text(encoding="ascii")
        except (OSError, UnicodeError) as exc:
            raise SystemExit(f"Cannot read satellite secret file from {secret_file}") from exc
        secret = decode(value, secret_file)
        logger.info("master secret: from the mounted secret file")
        return secret

    secret_env = "VOCALIS_SATELLITE_SECRET"
    raw_env = os.environ.get(secret_env)
    if raw_env:
        secret = decode(raw_env, secret_env)
        logger.info("master secret: from VOCALIS_SATELLITE_SECRET")
        return secret
    import keyring
    hexed = keyring.get_password(KEYRING_SERVICE, name)
    if not hexed:
        raise SystemExit(
            f"No shared secret stored for satellite {name!r}.\n"
            f"Run setup.bat (or `python setup.py`) and paste the secret Vocalis showed you "
            f"when you defined this satellite.")
    secret = decode(hexed, "the OS credential store")
    logger.info("master secret: from the OS credential store")
    return secret


# ── sealed request/response plumbing ─────────────────────────────────────────

class Sealed:
    """The unsealed request and the keys to answer it with."""

    def __init__(self, payload: bytes, k2s: bytes, s2k: bytes):
        self.payload, self.k2s, self.s2k = payload, k2s, s2k

    def json(self) -> dict:
        try:
            return json.loads(self.payload.decode("utf-8"))
        except Exception as exc:                              # noqa: BLE001
            raise SatelliteError(f"body is not JSON: {exc}") from exc


def unseal_request() -> Sealed:
    salt_hex = request.headers.get("X-Vocalis-Salt", "")
    try:
        salt = bytes.fromhex(salt_hex)
    except ValueError as exc:
        raise SatelliteError("X-Vocalis-Salt is missing or not hex") from exc
    k2s = proto.derive_key(_MASTER, salt, proto.DIR_TO_SATELLITE)
    s2k = proto.derive_key(_MASTER, salt, proto.DIR_TO_SERVER)
    s = Sealed(proto.open_bytes(k2s, request.get_data()), k2s, s2k)
    # Stashed so the error handlers can SEAL their replies. Set only after `open_bytes` has
    # authenticated the caller — an unauthenticated request must never get an encrypted answer.
    g.sealed = s
    return s


def sealed_json(s: Sealed, obj, status: int = 200) -> Response:
    body = proto.seal_bytes(s.s2k, json.dumps(obj).encode("utf-8"))
    return Response(body, status=status, mimetype="application/octet-stream")


@app.errorhandler(proto.ProtocolError)
def _bad_envelope(exc):
    # Deliberately terse and unsealed: we could not authenticate the caller, so we owe them
    # nothing and must not encrypt to a key we do not trust. Logged without the message body.
    logger.warning(f"rejected an unauthenticated request from {request.remote_addr}")
    return Response(b"unauthenticated", status=401, mimetype="text/plain")


# ── routes ───────────────────────────────────────────────────────────────────

def take_vram_cap(value, verb: str) -> float:
    """Apply a per-card VRAM cap supplied by a health, load, or capacity request.

    A changed value updates both the batch sizer and PyTorch allocator. `source` identifies the request in
    logs; nonpositive or invalid values clear the cap."""
    before = batchmod.vram_cap_gb()
    now = batchmod.set_vram_cap(value, source=f"/satellite/{verb}")
    if abs(now - before) <= 1e-6:
        return now
    for device in ENGINE.devices():
        # Never fatal, for `Engine._load_locked`'s reason: a satellite that cannot cap itself is
        # the satellite we already have, not a request to fail.
        try:
            batchmod.bound_process_memory(device)
        except Exception as exc:                              # noqa: BLE001
            logger.warning(f"{device}: the new cap could not be applied to torch "
                           f"({type(exc).__name__}: {exc}) — the "
                           f"sizer honors it, the allocator is still on the old bound")
    return now


def reapply_cap_for_card(device: str) -> bool:
    """Recompute the allocator cap for `device` on a capacity request, if it has workers.

    October 10, 2026: free memory now comes from the whole-card reading, so a cap computed while
    another program held memory would otherwise stay low after that program left, until Unload
    and Load. The cap never goes below what is already resident (the existing rule in
    `bound_process_memory`), and applying it does not disturb a render in flight. It is logged
    there only when the applied cap changes by 0.1 GB or more. Never fatal, for
    `take_vram_cap`'s reason. Returns whether a recompute ran."""
    if not device or device not in ENGINE.devices():
        return False                   # no workers on this card: nothing resident to bound
    try:
        batchmod.bound_process_memory(device, on_change_only=True)
    except Exception as exc:                                  # logged at warning, with its type
        logger.warning(f"{device}: the allocator cap could not be recomputed on this capacity "
                       f"request ({type(exc).__name__}: {exc}) — the previous bound stays")
        return False
    return True


@app.route("/satellite/health", methods=["POST"])
def health():
    s = unseal_request()
    # Apply a VRAM cap only when the health request includes the field. Empty or malformed health probes
    # remain successful liveness checks, and omission must not clear a previously configured cap.
    try:
        body = s.json()
    except SatelliteError:
        body = {}
    if isinstance(body, dict) and "vram_cap_gb" in body:
        take_vram_cap(body.get("vram_cap_gb"), "health")
    return sealed_json(s, {
        "satellite_version": SATELLITE_VERSION,
        # Compatibility is determined by advertised capabilities; clients fall back to single-chunk rendering
        # when `batch_render` is absent.
        "capabilities": (["render", "stream", "batch_render", "capacity"]
                         + (["leadvocal"] if leadvocal.installed(load_config()) else [])),
        # Report whether the isolated lead-vocal environment is installed and the script hash used to verify
        # a copied environment. Do not report live free VRAM in cached health data; use `/satellite/vram`.
        "leadvocal_ready": leadvocal.installed(load_config()),
        "leadvocal_script": leadvocal.script_sha(load_config()),
        "leadvocal_vram_gb": leadvocal.REQUIRED_VRAM_GB,
        # 8.6.2 — whether a warm separator is resident and how long it has been idle.
        # Diagnostic: it is what makes "why is 2 GB gone on my desktop" answerable
        # without a debugger. Nothing routes on it.
        "leadvocal_warm": leadvocal.warm(),
        # `max_batch` is an advisory build limit. The live `/satellite/capacity` result determines how much
        # work fits now; cached health data must not be treated as a memory allowance.
        "max_batch": batchmod.MAX_BATCH,
        # `alloc_ratio` is diagnostic telemetry. Schedulers use `/satellite/capacity`, not this cached value.
        "alloc_ratio": {d: round(batchmod.alloc_ratio(d), 3) for d in ENGINE.devices()},
        # Report the cap currently applied by the satellite; clients provide it through `/load`, `/capacity`,
        # or `/health`. Zero means uncapped.
        "vram_cap_gb": round(batchmod.vram_cap_gb(), 2),
        # …and what this process is actually holding per card, which is the number that says
        # whether the cap is doing anything. Free VRAM cannot answer that — it moves when
        # anything else on the desktop allocates.
        "vram_reserved_gb": {d: round(batchmod.reserved_gb(d), 2) for d in ENGINE.devices()},
        "requires_server": REQUIRES_SERVER,
        "protocol": proto.PROTOCOL_VERSION,
        "name": _NAME,
        "ready": ENGINE.ready(),
        "loading": ENGINE.loading(),
        "devices": ENGINE.devices(),
        # Report available devices separately from the devices currently loaded by the engine.
        "available_devices": ENGINE.available_devices(),
        "workers": ENGINE.worker_counts(),
        "sr": ENGINE.sample_rate(),
        "voices_warm": ENGINE.warm_voices(),
        "engines": ["chatterbox"],
        # Advertise supported routes explicitly. Older clients can infer absence of optional capabilities.
        "verbs": ["health", "load", "unload", "voice", "render", "stream", "cancel",
                  "vram", "leadvocal", "gpustats"],
    })


@app.route("/satellite/load", methods=["POST"])
def load():
    """Load the requested number of workers per device.

    Request: `{"plan": {"cuda:0": 2}}`. The call waits for loading to finish and may include `vram_cap_gb`.
    The response reports loaded workers, sample rate, and active devices."""
    s = unseal_request()
    body = s.json()
    plan = body.get("plan") or {}
    if not isinstance(plan, dict) or not plan:
        raise SatelliteError("'plan' must be a non-empty {device: workers} object")
    # Apply the allocator limit before loading each replica so the loaded model cannot retain an older cap.
    take_vram_cap(body.get("vram_cap_gb"), "load")
    got = ENGINE.load(plan)
    return sealed_json(s, {"loaded": got, "sr": ENGINE.sample_rate(),
                           "devices": ENGINE.devices()})


@app.route("/satellite/unload", methods=["POST"])
def unload():
    s = unseal_request()
    return sealed_json(s, {"unloaded": ENGINE.unload()})


@app.route("/satellite/capacity", methods=["POST"])
def capacity():
    """Report how many chunks this device can accept now.

    Request: `{"device": "cuda:0", "lengths": [412, 388]}`. Response: `{"take": 7}`. Sizing uses the
    same device-memory budget and chunk lengths as rendering so the scheduler can distribute work before
    dispatch."""
    s = unseal_request()
    d = s.json()
    # Apply the supplied cap before calculating capacity, then rebind the allocator through `take_vram_cap`.
    # An omitted value means uncapped for older clients.
    cap_before = batchmod.vram_cap_gb()
    take_vram_cap(d.get("vram_cap_gb"), "capacity")
    devs = ENGINE.devices()
    dev  = str(d.get("device") or "") or (devs[0] if devs else "")
    # October 10, 2026: a card that has workers gets its allocator cap recomputed on EVERY capacity
    # request, from the whole-card free memory of this moment. A changed cap value was already
    # applied to every loaded card by `take_vram_cap` just above, so that case is not repeated.
    if abs(batchmod.vram_cap_gb() - cap_before) <= 1e-6:
        reapply_cap_for_card(dev)
    lengths = [int(n) for n in (d.get("lengths") or [])]
    if not lengths:
        return sealed_json(s, {"take": 0})
    take = batchmod.batch_cap(dev, len(lengths), lengths=lengths)
    return sealed_json(s, {"take": int(max(1, min(int(take), len(lengths))))})


@app.route("/satellite/voice", methods=["POST"])
def voice():
    """Ship a voice this satellite does not have. Body: 64 hex chars of hash, then the audio.

    Content-addressed so it is sent once, not per render. The bytes are decoded from memory and
    only the prepared conditionals are retained — nothing reaches the disk.
    """
    s = unseal_request()
    if len(s.payload) < 64:
        raise SatelliteError("voice body must start with a 64-char hash")
    voice_hash = s.payload[:64].decode("ascii", "replace")
    audio = s.payload[64:]
    if not audio:
        raise SatelliteError("voice body carried no audio")
    n = ENGINE.add_voice(voice_hash, audio)
    return sealed_json(s, {"prepared_on": n})


@app.route("/satellite/render", methods=["POST"])
def render():
    """One chunk in, complete PCM out. The m1 verb: books, bulk, playground, audition, and
    chunks 2+ of a stream all land here.

    409 with `need_voice` is not an error — it is the content-addressed voice protocol working:
    The Vocalis server retries after POSTing the sample.
    """
    s = unseal_request()
    d = s.json()
    text = str(d.get("text", ""))
    voice_hash = str(d.get("voice_hash", ""))
    request_id = str(d.get("request_id") or uuid.uuid4().hex)
    # Batch requests identify each chunk. Keep the single-chunk route unchanged for compatibility.
    if isinstance(d.get("chunks"), list):
        return _render_batch(s, d, request_id, voice_hash)
    if not text:
        raise SatelliteError("'text' is required")
    if not ENGINE.ready():
        return sealed_json(s, {"error": "no model loaded"}, 503)
    if voice_hash and not ENGINE.has_voice(voice_hash):
        return sealed_json(s, {"need_voice": voice_hash}, 409)

    try:
        audio, sr = ENGINE.render(
            request_id, text, voice_hash,
            exaggeration=float(d.get("exaggeration", 0.5)),
            cfg=float(d.get("cfg", 0.5)),
            temperature=float(d.get("temperature", 0.8)),
            # Use the requested device when acquiring the worker so the lease matches the pool assignment.
            device=str(d.get("device") or "") or None)
    except GenerationCanceled:
        # Nothing is returned. A partial chunk handed back as real would be banked as final and
        # poison every resume of that render.
        logger.info(f"{request_id}: canceled mid-render, nothing returned")
        return sealed_json(s, {"canceled": True}, 409)
    except SatelliteError as exc:
        return sealed_json(s, {"error": str(exc)}, 400)

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    w = proto.SealedWriter(s.s2k)
    body = w.frame(json.dumps({"sr": sr, "samples": len(audio)}).encode("utf-8"))
    # Split oversized responses below the frame limit. Keep PCM frame boundaries sample-aligned; a stream
    # error after headers have been sent must be reported in the trailer.
    step = proto.FRAME_PAYLOAD_BYTES
    offsets = list(range(0, len(pcm), step)) or [0]   # silence still needs one PCM frame, so
    for i in offsets:                                 # `_parse`'s "at least 2" holds
        body += w.frame(pcm[i:i + step])
    body += w.end()
    return Response(body, mimetype="application/octet-stream")


# Hold a short remainder only when the caller confirms more work is coming. The per-device worker
# serializes each submission chain, and `_pass_lock` serializes GPU execution.
_HELD = {}
_HELD_MU = threading.Lock()


def _room_for(device, held: list) -> int:
    """How many MORE chunks this card wants on top of what it is already holding.

    Sized the same way every other decision on this card is — `batch_cap` at the held chunks'
    lengths — so the number the server acts on is the same number the render will use. At least 1, since
    a card asking for a top-up by definition wants one.
    """
    devs = ENGINE.devices()
    dev = str(device or "") or (devs[0] if devs else "")
    lengths = [len(t) for _cid, t in held]
    room = batchmod.batch_cap(dev, batchmod.MAX_BATCH, lengths=lengths or None)
    return max(1, int(room) - len(held))


def _take_held(dev_key: str) -> list:
    """Everything this card was holding, removed as it is handed over. Never returns None."""
    with _HELD_MU:
        return list(_HELD.pop(str(dev_key), ()))


def _peek_held(dev_key: str) -> list:
    """What this card is holding, WITHOUT removing it — for reporting on the stale ones before
    `_take_held` clears them."""
    with _HELD_MU:
        return list(_HELD.get(str(dev_key), ()))


def _put_held(dev_key: str, items: list) -> None:
    with _HELD_MU:
        if items:
            _HELD[str(dev_key)] = list(items)
        else:
            _HELD.pop(str(dev_key), None)


def _render_batch(s, d, request_id, voice_hash):
    """Render identified text chunks in batches and stream one header plus PCM frames per completed chunk.

    Each header preserves the caller's chunk id and sample count. Output remains in input order; a trailer
    reports completion, failure, or chunks held for a confirmed top-up."""
    chunks = d.get("chunks") or []
    items = []
    for i, c in enumerate(chunks):
        if not isinstance(c, dict):
            raise SatelliteError("each chunk must be an object with 'id' and 'text'")
        txt = str(c.get("text", ""))
        if not txt:
            raise SatelliteError(f"chunk {c.get('id', i)!r} has no text")
        items.append((str(c.get("id", i)), txt))
    # Prepend expected held chunks so output preserves request order. Drop chunks absent from the caller’s
    # held-id list; they belong to an abandoned submission.
    dev_key = str(d.get("device") or "") or "*"
    expected = {str(x) for x in (d.get("held") or [])}
    stale = [cid for cid, _t in _peek_held(dev_key) if cid not in expected]
    held_before = [(cid, txt) for cid, txt in _take_held(dev_key) if cid in expected]
    if stale:
        logger.warning(f"dropping {len(stale)} held chunk(s) on {dev_key} that the caller no "
                       f"longer expects: {stale}")
    items = held_before + items
    if not items:
        raise SatelliteError("'chunks' is empty")
    if not ENGINE.ready():
        return sealed_json(s, {"error": "no model loaded"}, 503)
    if voice_hash and not ENGINE.has_voice(voice_hash):
        return sealed_json(s, {"need_voice": voice_hash}, 409)

    # Capture request data before returning the streaming response; Flask tears down the request context
    # before the generator runs.
    kw = dict(exaggeration=float(d.get("exaggeration", 0.5)),
              cfg=float(d.get("cfg", 0.5)),
              temperature=float(d.get("temperature", 0.8)),
              device=str(d.get("device") or "") or None)
    sr = ENGINE.sample_rate()
    w = proto.SealedWriter(s.s2k)
    # Hold a remainder only when `more_available` is true. Missing fields from older clients mean no more work.
    more_available = bool(d.get("more_available"))
    held_idx = []

    def frames():
        """Yield a tagged header and PCM frames for each completed chunk, then a trailer.

        Each result is streamed as soon as it finishes. Once the response starts, later failures are
        reported in the trailer because the HTTP status can no longer change."""
        try:
            for idx, wav in ENGINE.render_batch_iter(
                    request_id, [t for _id, t in items], voice_hash,
                    more_available=more_available, held_out=held_idx, **kw):
                pcm = (np.clip(wav, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                yield w.frame(proto.TAG_HEADER + json.dumps(
                    {"id": items[idx][0], "samples": len(wav), "sr": sr}).encode("utf-8"))
                # The PCM may span several frames; a chunk boundary is defined by the header's
                # sample count, never by a frame edge. FRAME_PAYLOAD_BYTES is even, so a split
                # never lands mid-sample.
                step = proto.FRAME_PAYLOAD_BYTES
                for at in (list(range(0, len(pcm), step)) or [0]):
                    yield w.frame(proto.TAG_AUDIO + pcm[at:at + step])
            # Name held chunk ids in the trailer so the caller can send the next top-up without spending retries
            # on work that is still resident.
            trailer = {"status": "ok"}
            if held_idx:
                held = [items[j] for j in held_idx]
                _put_held(dev_key, held)
                trailer["held"] = [cid for cid, _t in held]
                trailer["want"] = _room_for(kw.get("device"), held)
            yield w.frame(proto.TAG_TRAILER + json.dumps(trailer).encode("utf-8"))
        except GenerationCanceled:
            logger.info(f"{request_id}: batch canceled mid-render, nothing further returned")
            yield w.frame(proto.TAG_TRAILER
                          + json.dumps({"status": "canceled"}).encode("utf-8"))
        except Exception as exc:                              # noqa: BLE001
            logger.exception(f"{request_id}: batch failed mid-flight")
            yield w.frame(proto.TAG_TRAILER
                          + json.dumps({"status": "error",
                                        "error": str(exc)}).encode("utf-8"))
        yield w.end()

    return Response(frames(), mimetype="application/octet-stream")


@app.route("/satellite/stream", methods=["POST"])
def stream():
    """Stream one rendered chunk as audio becomes available.

    The sealed stream contains a header, PCM frames, and a trailer. Capture request values before returning
    the response because Flask's request context ends before the generator runs."""
    s = unseal_request()
    d = s.json()
    text = str(d.get("text", ""))
    voice_hash = str(d.get("voice_hash", ""))
    request_id = str(d.get("request_id") or uuid.uuid4().hex)
    exaggeration = float(d.get("exaggeration", 0.5))
    cfg_w = float(d.get("cfg", 0.5))
    temperature = float(d.get("temperature", 0.8))
    config = stream_core.config_from_wire(d.get("config") or {})
    device = str(d.get("device") or "") or None      # the card owned by this worker (_acquire)
    s2k = s.s2k                      # the response key, captured out of the request context

    if not text:
        raise SatelliteError("'text' is required")
    if not ENGINE.ready():
        return sealed_json(s, {"error": "no model loaded"}, 503)
    if voice_hash and not ENGINE.has_voice(voice_hash):
        return sealed_json(s, {"need_voice": voice_hash}, 409)

    def frames():
        w = proto.SealedWriter(s2k)
        sent_header = False
        try:
            for kind, value in ENGINE.stream(request_id, text, voice_hash,
                                             exaggeration=exaggeration, cfg=cfg_w,
                                             temperature=temperature, config=config,
                                             device=device):
                if kind == "sr":
                    sent_header = True
                    yield w.frame(proto.TAG_HEADER
                                  + json.dumps({"sr": int(value)}).encode("utf-8"))
                else:
                    pcm = (np.clip(value, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                    yield w.frame(proto.TAG_AUDIO + pcm)
            yield w.frame(proto.TAG_TRAILER + json.dumps({"status": "ok"}).encode("utf-8"))
        except GenerationCanceled:
            logger.info(f"{request_id}: canceled mid-stream — the audio already sent stands")
            yield w.frame(proto.TAG_TRAILER
                          + json.dumps({"status": "canceled"}).encode("utf-8"))
        except Exception as exc:                                   # noqa: BLE001
            # In-band, because the status code went out with the first frame. If we have not
            # even sent the header yet the same trailer still reaches the client, which raises rather
            # than treating an empty stream as a silent success.
            logger.exception(f"{request_id}: stream failed after "
                             f"{'some' if sent_header else 'no'} audio: {exc}")
            yield w.frame(proto.TAG_TRAILER
                          + json.dumps({"status": "error", "error": str(exc)}).encode("utf-8"))
        yield w.end()

    return Response(frames(), mimetype="application/octet-stream")


@app.route("/satellite/vram", methods=["POST"])
def vram():
    """Return current free and total VRAM for a device.

    Request: `{"device": "cuda:0"}`. A device that cannot be measured reports `free_gb: null`; health is
    cached, so callers needing a live estimate must use this route immediately before dispatch."""
    s = unseal_request()
    d = s.json()
    devs = ENGINE.devices() or ENGINE.available_devices()
    dev = str(d.get("device") or "") or (devs[0] if devs else "")
    free = batchmod.free_gb(dev)
    return sealed_json(s, {
        "device": dev,
        # `None`, not `inf`: JSON has no infinity and `json.dumps` emits a bare `Infinity`
        # token that strict parsers reject. The client reads None as "this box cannot answer the
        # question", which is the honest meaning for a CPU-only satellite.
        "free_gb": None if free == float("inf") else round(free, 2),
        "leadvocal_running": leadvocal.running(),
    })


@app.route("/satellite/gpustats", methods=["POST"])
def gpustats_route():
    """Return per-device GPU telemetry using the field names shared with local devices.

    Optional NVML and Windows PDH providers may leave unsupported fields unavailable; telemetry failure must
    not take down the route."""
    s = unseal_request()
    gpustats.note_poll(request.remote_addr or "?")
    return sealed_json(s, gpustats.sample(ENGINE))


@app.route("/satellite/leadvocal", methods=["POST"])
def leadvocal_route():
    """Run isolated lead-vocal processing for one song.

    The request carries sealed audio parts and processing options; the response returns the backing and dry
    vocal parts. A refusal is a per-device availability result so the caller can route the work elsewhere."""
    s = unseal_request()
    head, parts = proto.unpack_parts(s.payload)
    wav = parts.get("vocals") or b""
    request_id = str(head.get("request_id") or uuid.uuid4().hex)
    device = str(head.get("device") or "") or (ENGINE.available_devices() or ["cpu"])[0]
    cfg = load_config()

    if not leadvocal.installed(cfg):
        return sealed_json(s, {"error": "the lead-vocal venv is not installed on this satellite"},
                           503)
    try:
        outputs, info = leadvocal.run(
            wav, device=device, dereverb=bool(head.get("dereverb", True)),
            karaoke_model=str(head.get("karaoke_model") or ""),
            dereverb_model=str(head.get("dereverb_model") or ""),
            request_id=request_id, cfg=cfg, free_gb=batchmod.free_gb,
            # Keep the separator warm only when the caller indicates more songs; an omitted field means this is
            # the last item and releases the worker.
            keep_warm=bool(head.get("keep_warm")))
    except leadvocal.LeadVocalError as exc:
        logger.warning(f"{request_id}: lead-vocal declined here — {exc}")
        return sealed_json(s, {"error": str(exc)}, 503)

    body = proto.pack_parts({"request_id": request_id, **info},
                            [(k, outputs[k]) for k in ("backing", "dry") if k in outputs])
    return Response(proto.seal_bytes(s.s2k, body), status=200,
                    mimetype="application/octet-stream")


@app.route("/satellite/cancel", methods=["POST"])
def cancel():
    s = unseal_request()
    rid = str(s.json().get("request_id", ""))
    if not rid:
        raise SatelliteError("'request_id' is required")
    # Cancel both the render worker and the isolated-vocal worker; either job may be running.
    return sealed_json(s, {"canceled": bool(ENGINE.cancel(rid)) or leadvocal.cancel(rid)})


@app.errorhandler(SatelliteError)
def _bad_request(exc):
    """Return a client error in the same sealed envelope after request authentication.

    The caller must be able to decrypt errors from authenticated routes just as it decrypts success replies."""
    logger.warning(f"bad request: {exc}")
    s = getattr(g, "sealed", None)
    if s is not None:
        return sealed_json(s, {"error": str(exc)}, status=400)
    return Response(str(exc).encode("ascii", "replace"), status=400, mimetype="text/plain")


@app.errorhandler(Exception)
def _unexpected(exc):
    """Return an internal error in the same sealed envelope after request authentication.

    Unauthenticated failures remain plain text because no response key is available."""
    from werkzeug.exceptions import HTTPException

    status = exc.code if isinstance(exc, HTTPException) else 500
    msg = str(exc) or type(exc).__name__
    if not isinstance(exc, HTTPException):
        logger.exception(f"unhandled error: {exc}")
    s = getattr(g, "sealed", None)
    if s is not None:
        return sealed_json(s, {"error": msg}, status=status)
    return Response(msg.encode("ascii", "replace"), status=status, mimetype="text/plain")


# ── entry ────────────────────────────────────────────────────────────────────

class _WerkzeugToLoguru(logging.Handler):
    """Forward Werkzeug request records through Loguru without duplicate output.

    Suppress only known startup banners. Preserve error logs and status colors; successful health and GPU
    polls are reduced to debug level, and the protocol's expected 409 voice handshake is not colored as an
    HTTP failure."""

    DROP = ("This is a development server", "Press CTRL+C to quit",
            "Debugger is active", "Debugger PIN")

    # Remove ANSI escapes before routing status messages. Keep normal colors except for the expected 409 voice handshake.

    _ANSI = re.compile(r"\x1b\[[0-9;]*m")
    _STATUS = re.compile(r'"\s+(\d{3})\s')

    # Lower successful health-poll access records to debug; keep authentication and server errors visible.

    _HEALTH_OK = re.compile(r'"[A-Z]+ /satellite/health[^"]*"\s+2\d\d\s')

    # GPU statistics are polled at 4 Hz. Lower successful access records, but retain errors and session state changes.

    _GPUSTATS_OK = re.compile(r'"[A-Z]+ /satellite/gpustats[^"]*"\s+2\d\d\s')

    # A client that closes its connection while a response is being written (Vocalis gives up on a status poll while
    # the satellite is busy loading a model, or closes a stream it has finished with). Nothing failed, but over TLS
    # Werkzeug logs it as "Error on request:" with a 30-line traceback: the write fails with BrokenPipeError, and
    # Werkzeug's follow-up read of the dead socket then raises ssl.SSLError (UNEXPECTED_EOF_WHILE_READING), which is
    # not a ConnectionError, so its own quiet handling of dropped connections does not apply. Seen October 11, 2026
    # on the final 12.0.0 satellite image: three such blocks in two minutes of normal use, and `vocalis-satellite
    # status` (which prints the last log lines) showed the tail of one. The traceback is plain text in the message;
    # Werkzeug attaches no exception to the record. These are the same lists as _DropClientDisconnects in
    # src/vocalis_server.py, which has dropped this for the main server since Vocalis 5; tests/test_satellite_setup.py
    # holds the two in step. A TLS failure that is ours (certificate, protocol version) is never swallowed.
    _CLIENT_GONE = ("BrokenPipeError", "ConnectionResetError", "ConnectionAbortedError",
                    "SSLEOFError", "UNEXPECTED_EOF_WHILE_READING",
                    "APPLICATION_DATA_AFTER_CLOSE_NOTIFY")
    _TLS_OURS = ("CERTIFICATE_VERIFY_FAILED", "SSLCertVerificationError", "NO_SHARED_CIPHER",
                 "WRONG_VERSION_NUMBER", "SSLZeroReturnError")

    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:                                   # noqa: BLE001
            return
        clean = self._ANSI.sub("", msg)
        if "Error on request" in clean and not any(k in clean for k in self._TLS_OURS):
            gone = next((m for m in self._CLIENT_GONE if m in clean), None)
            if gone:
                logger.debug(f"a client closed its connection mid-response ({gone}); nothing failed")
                return
        if self._HEALTH_OK.search(clean) or self._GPUSTATS_OK.search(clean):
            logger.debug(clean.strip())                     # still in the file if the level drops
            return
        status = self._STATUS.search(clean)
        if status and status.group(1) == "409":
            msg = clean                         # expected handshake — not an error, not red
        if any(d in msg for d in self.DROP):
            return
        if msg.startswith(" * Running on"):
            return                                          # main() already says where it listens
        logger.log("INFO" if record.levelno < logging.WARNING else record.levelname, msg.strip())


def _setup_logging(cfg):
    """Configure console and rotating-file logging, then install the Werkzeug forwarding handler.

    Logs are operational metadata only; request content is never written."""
    if satpaths.configured("VOCALIS_SATELLITE_LOG_DIR"):
        satpaths.require_directory(LOG_DIR, "VOCALIS_SATELLITE_LOG_DIR")
    else:
        LOG_DIR.mkdir(exist_ok=True)
    logger.remove()
    logger.add(sys.stderr, level="INFO",
               format="<green>{time:HH:mm:ss}</green> | <level>{level: <7}</level> | {message}")
    logger.add(LOG_DIR / "satellite.log", rotation="10 MB", retention=10,
               level="INFO", encoding="utf-8",
               format="{time:YYYY-MM-DD HH:mm:ss} | {level: <7} | {message}")
    _quiet_werkzeug()


def _quiet_werkzeug():
    """Install one handler and disable propagation so Werkzeug records are not emitted twice."""
    wl = logging.getLogger("werkzeug")
    wl.handlers = [_WerkzeugToLoguru()]
    wl.propagate = False
    wl.setLevel(logging.INFO)


class PortInUseError(RuntimeError):
    """Raised when another process owns the configured listening port.

    This is intentionally not an `OSError`: Werkzeug converts bind `OSError`s to `SystemExit` before the
    caller can report a useful diagnosis."""


def _port_is_taken(exc):
    """Return whether an address bind failed because the port is already in use.

    Windows reports WSAEADDRINUSE as 10048; POSIX uses `errno.EADDRINUSE`."""
    return getattr(exc, "errno", None) == errno.EADDRINUSE or getattr(exc, "winerror", None) == 10048


class _ExclusiveServer(ThreadedWSGIServer):
    """Use an exclusive listener on Windows so a second satellite cannot silently bind the same port.

    Keep address reuse on POSIX to support restart while old connections are in TIME_WAIT; a live listener
    still rejects a duplicate bind. The custom server keeps Werkzeug's bind failure visible to `main`."""

    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)      # Windows only
        if excl is not None:
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, excl, 1)
            except OSError:
                pass          # still an exclusive bind without it; only hijack-by-others is open
        try:
            super().server_bind()
        except OSError as e:
            if not _port_is_taken(e):
                raise                     # a different problem — werkzeug reports it as before
            self.server_close()           # ours to close: werkzeug's OSError handler never runs
            raise PortInUseError(
                f"port {self.port} is already in use — something is listening on "
                f"{self.host}:{self.port}, almost certainly another satellite window that is "
                f"still open. THIS ONE HAS NOT STARTED: close it, and use the one already "
                f"running (or start this with --port <a free port>)."
            ) from e


def _log_gpu_visibility(decision: dict) -> None:
    """Write down what the integrated-graphics step decided, with its values."""
    if decision.get("action") != "none":
        logger.info(f"ROCm: hid integrated GPU(s) {decision.get('integrated')}; "
                    f"HIP_VISIBLE_DEVICES={decision.get('visible')}")
    elif decision.get("reason") != "no ROCm kernel driver":
        # The main server suppresses this case too (vocalis_server.py): on an NVIDIA or Windows
        # satellite there is no ROCm to speak of, and "ROCm: no GPU hidden" would be noise on
        # every start. A ROCm host that hid nothing (no integrated GPU, a probe that failed, an
        # explicit visibility setting) still says so.
        logger.info(f"ROCm: no GPU hidden ({decision.get('reason')})")


#: The package source beside the satellite: `<satellite>/../src`. Always present in the Docker
#: images, which carry `tts_utils.py` (and `engine_process.py`, which it imports) there.
PACKAGE_SRC = HERE.parent / "src"


def settle_whole_card_source(package_src=None) -> str:
    """Decide ONCE, at start, where free-memory decisions get the whole card's number; log it.

    October 10, 2026. When the package source is present beside the satellite the value comes from
    `tts_utils.device_mem_gb` (AMD sysfs, then NVML, then PyTorch -- the main server's own order).
    A standalone satellite folder without it uses NVML, then PyTorch. This is settled here, after
    the integrated-graphics step and before the satellite serves, and not left to the first model
    load as the model check is: the memory routes (`/satellite/vram`, `/satellite/capacity`) run
    before any load, and would report PyTorch's number first and the true one later.

    A package source that cannot be imported is not fatal: it is logged with the reason and the
    standalone source is used. Returns the source's name."""
    src = Path(package_src) if package_src is not None else PACKAGE_SRC
    tts_path = src / "tts_utils.py"
    gpustats.set_package_readers(None)         # until the package source proves usable, below
    if not tts_path.is_file():
        batchmod.set_whole_card_reader(None, "NVML, then PyTorch (standalone satellite folder)")
        logger.info(f"whole-card memory source: {batchmod.whole_card_source()} -- no package "
                    f"source at {src}")
        return batchmod.whole_card_source()
    # Appended, not inserted: the satellite's own modules keep precedence, and the engine's
    # later `source_root not in sys.path` check (VOCALIS_REQUIRE_LOCALMODEL) then finds it there.
    if str(src) not in sys.path:
        sys.path.append(str(src))
    try:
        import tts_utils
        loaded = Path(tts_utils.__file__).resolve()
        if loaded != tts_path.resolve():
            raise ImportError(f"tts_utils loaded from {loaded}, not from {tts_path}")
        reader = tts_utils.device_mem_gb
    except Exception as exc:                                  # logged below, then not fatal
        batchmod.set_whole_card_reader(None, "NVML, then PyTorch (package source unusable)")
        logger.warning(f"whole-card memory source: the package source at {src} could not be "
                       f"used ({type(exc).__name__}: {exc}) -- using "
                       f"{batchmod.whole_card_source()}")
        return batchmod.whole_card_source()
    batchmod.set_whole_card_reader(
        reader, "package tts_utils.device_mem_gb (AMD sysfs, then NVML, then PyTorch)")
    logger.info(f"whole-card memory source: {batchmod.whole_card_source()} from {src}")
    # The same module's AMD readers fill the card readouts `/satellite/gpustats` sends (an AMD
    # card has no NVML handle). Only on a ROCm build and only for cards without a handle.
    in_use = gpustats.set_package_readers(tts_utils)
    logger.info(f"package card readers for AMD cards' readouts: "
                f"{'available' if in_use else 'not available'}")
    return batchmod.whole_card_source()


def _how_to_stop_line(in_container: bool) -> str:
    """The last start-up line: how this satellite is stopped. Started by run.bat it has a console window, and closing
    that is how. In a container (its folders are given by the environment) there is no window to close, and the old
    line told the reader of the log to close one (noticed October 11, 2026)."""
    if in_container:
        return ("ready. To stop it: Stop in the tray icon's menu, `vocalis-satellite stop`, or `docker stop`. "
                "Vocalis handles the satellite disappearing")
    return "close this window to stop — Vocalis handles the worker disappearing"


def main():
    global _MASTER, _NAME
    cfg = load_config()
    ap = argparse.ArgumentParser(description="Vocalis render satellite")
    ap.add_argument("--host", default=cfg.get("host", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(cfg.get("port", 7880)))
    ap.add_argument("--name", default=cfg.get("name", "satellite"))
    ap.add_argument("--no-tls", action="store_true",
                    help="DEVELOPMENT ONLY. The payload stays sealed either way, but you lose "
                         "forward secrecy and leak endpoint metadata.")
    args = ap.parse_args()

    _setup_logging(cfg)
    _NAME = args.name
    # First, who this is: the line to look for after a start (the hand-written "starting" line above it has the
    # version but not the name, which is only known here).
    logger.info(f"Vocalis satellite {SATELLITE_VERSION} '{_NAME}' "
                f"(protocol {proto.PROTOCOL_VERSION}, requires server {REQUIRES_SERVER}+)")
    _log_gpu_visibility(_gpu_visibility)
    # After the integrated-graphics step (module top) and before anything serves.
    settle_whole_card_source()
    _MASTER = load_master(_NAME)

    if satpaths.configured("VOCALIS_SATELLITE_WORK_DIR"):
        satpaths.require_directory(satpaths.WORK_DIR, "VOCALIS_SATELLITE_WORK_DIR")

    certs = satpaths.CERT_DIR
    ssl_ctx = None
    if args.no_tls:
        logger.warning("TLS DISABLED (--no-tls). Payloads are still sealed, but this is not a "
                       "supported configuration — see DESIGN_5_3_SATELLITES.md section 6.")
    else:
        if satpaths.configured("VOCALIS_SATELLITE_CERT_DIR"):
            satpaths.require_directory(certs, "VOCALIS_SATELLITE_CERT_DIR")
        cert, key = certs / "cert.pem", certs / "key.pem"
        if not (cert.exists() and key.exists()):
            raise SystemExit(
                f"No TLS certificate in {certs}.\nRun setup.bat (or `python setup.py`) to "
                f"generate one, then copy cert.pem to Vocalis and pin it there.")
        ssl_ctx = (str(cert), str(key))

    # Bind the port before cleanup or background-thread startup. A duplicate process must not alter
    # resources owned by the running satellite.
    try:
        srv = _ExclusiveServer(args.host, args.port, app, ssl_context=ssl_ctx)
    except PortInUseError as e:
        # Not a traceback. This window is the whole user interface, and the person reading it
        # has just started run.bat for the second time.
        logger.error(str(e))
        raise SystemExit(1)

    # Register process-exit cleanup before starting background work so closing the console releases owned resources.
    leadvocal.sweep_stale()
    # Start the idle reaper so abandoned render chains release their GPU worker.
    leadvocal.start_reaper()
    if leadvocal.installed(cfg):
        logger.info(f"lead-vocal chain available: {leadvocal.venv_python(cfg)} "
                    f"(child {leadvocal.script_sha(cfg)})")
    # Run GPU telemetry housekeeping on its own timer, outside request handling.
    gpustats.start_background()

    # Log the listening address only after the exclusive server bind succeeds.
    logger.info(f"listening on {'http' if ssl_ctx is None else 'https'}://{args.host}:{args.port}")
    logger.info(_how_to_stop_line(satpaths.configured("VOCALIS_SATELLITE_LOG_DIR")))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
