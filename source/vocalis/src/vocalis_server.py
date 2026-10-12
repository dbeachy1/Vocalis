#!/usr/bin/env python3
"""Run the Flask application for book generation, speech, and library workflows. The server owns HTTP routes, asynchronous job coordination, and event streaming while delegating rendering and storage to the corresponding modules."""
import argparse
import errno
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import threading
import time
import types

from pathlib import Path

from flask import Flask, request, jsonify, session, redirect, url_for
from flask_cors import CORS
from loguru import logger

# Add `src/` to the import path before loading the runtime package that owns install paths.
import sys
sys.path.insert(0, str(Path(__file__).parent))
SATELLITE_DIR = Path(__file__).resolve().parents[1] / "satellite"
sys.path.insert(0, str(SATELLITE_DIR))

# Validate Docker bind mounts before importing model or route modules. These paths are resolved
# without creating directories, so a missing mount cannot be mistaken for a fresh data store.
from vocalis.runtime import paths as runtime_paths
runtime_paths.validate_runtime_roots()

# When launched as a script, this module is named `__main__`. Register the same module object under `vocalis_server` before lazy imports can import it by its package name. Otherwise the file executes twice and `vault_store.configure()` can replace the process-wide unlocked store with a new locked instance.
if __name__ == "__main__":
    sys.modules["vocalis_server"] = sys.modules[__name__]

# ROCm uses MIOpen FAST mode to avoid repeated exhaustive solver searches for the novel convolution shapes produced by sampling.
os.environ.setdefault("MIOPEN_FIND_MODE", "FAST")

from vocalis_torch_backend import apply_rocm_miopen_policy, hide_integrated_rocm_gpus

# Must precede `import torch`: HIP reads the visibility list once, and engine children inherit it.
_gpu_visibility = hide_integrated_rocm_gpus()
if _gpu_visibility["action"] != "none":
    logger.info(f"ROCm: hid integrated GPU(s) {_gpu_visibility['integrated']}; "
                f"HIP_VISIBLE_DEVICES={_gpu_visibility['visible']}")
elif _gpu_visibility["reason"] not in ("no ROCm kernel driver", "no integrated GPU"):
    logger.info(f"ROCm device visibility unchanged: {_gpu_visibility['reason']}")

import torch

apply_rocm_miopen_policy(torch)

import book_to_audio
import book_state
import bulk
import cleanup
import enhance
import render_rate
import scratch
import vault_fs
import vault_store
import voice_utils
import stems
from vault import VaultAuthError, VaultLocked
# Keep the shared library root available to `/library` and orphan cleanup; other book and
# playground helpers remain with their owning modules.
from book_to_audio import OUTPUT_DIR
# Keep file serving and Range parsing in `store_serve.py`, which can be imported by both the server and streaming route without a reverse import cycle or re-running server initialization.

# Application metadata and the cache root are owned by `tts_utils`.
from tts_utils import (setup_logging, PRODUCT_NAME, VERSION,
                       cache_root)

# generate_section relies on book_to_audio's torch module global (set in its main()).
book_to_audio.torch = torch

# ── Runtime configuration ─────────────────────────────────────────────────────
# Keep derived vault-key and admin-credential paths together here: their import-time globals
# must follow the same configured roots.
from vocalis.runtime import paths
# Config resolution is separate from lightweight settings because it imports model modules.
from vocalis.runtime import configs
# The pool owns worker state and synchronization; keep `VOX` as the shared object reference.
from vocalis.runtime import procs
from vocalis.runtime.voxcpm_pool import VOX

# Importing `auth` configures the store. Keep it before model/module initialization, which may
# read encrypted settings, and access authentication state through this module.
from vocalis.runtime import auth


# Nomi /speak config (the `nomi` section of voice_settings.yaml) + cache,
# served off the shared pool (2.1-M2).


# ── Device registry / VRAM ────────────────────────────────────────────────────

# ── Device ownership ──────────────────────────────────────────────────────────
# 5.1-P3: GpuGate moved to vocalis/runtime/gpu.py. GPUS is re-exported rather than
# accessed as gpu.GPUS because no test rebinds either name -- the object identity is
# what matters here, and a second name for the same gate is exactly as correct.
from vocalis.runtime import gpu
from vocalis.runtime.gpu import GpuGate, GPUS

# ── Whole-box power (7.3.6) ──────────────────────────────────────────────────
# A 4 Hz background sampler, started in main(). Nothing here reads it: `gpu.strip_sample()`
# picks the latest numbers up on its way to the header.
from vocalis.runtime import power

# ── Wall draw, off the UPS (7.3.18) ──────────────────────────────────────────
# The other half of the line above: `power` is what the silicon reports, this is what the meter
# the box is plugged into reports. A 5 s background poller, started in main(), read out through
# `gpu.strip_sample()` exactly like `power`.
from vocalis.runtime import ups

# ── The satellite's own GPU(s), in the same strip (10.21) ────────────────────
# One background poller per configured satellite, at up to 4 Hz while it answers and only
# while somebody is watching the strip — started in main(), read out through
# `gpu.strip_sample()` exactly like `power` and `ups` above.
from vocalis.runtime import satstats


# ── app_settings.yaml ─────────────────────────────────────────────────────────
# 5.1-P3.3: APP_SETTINGS and its load/save moved to vocalis/runtime/settings.py. Reached
# THROUGH the module, never re-exported: `APP_SETTINGS` is rebound by conftest and three
# test files, and a re-export here is exactly what would let one of those patches land on a
# name nothing reads (§6.2). It is the widest-reach thing in the runtime layer -- 16 of the
# 17 route groups get here -- and moving it is what unblocks runtime/pool.py, whose
# _default_gpus/_default_workers read it.
from vocalis.runtime import settings

# ── The Chatterbox worker pool ────────────────────────────────────────────────
# 5.1-P3.4: moved to vocalis/runtime/pool.py. Reached through the module at every call
# site and NOTHING is re-exported -- the suite rebinds `_pool`, `_pool_sig`, `get_pool`,
# `current_pool`, `preload_default_pool`, `WorkerPool` and both defaults, and a second name
# here is a patch target the pool itself never reads. `model_loading()` is a call rather
# than a bool for the same reason: a re-exported bool is a snapshot taken at import.
from vocalis.runtime import pool as rt_pool


# ── VoxCPM2 voice-design engine (4.8 — DESIGN_4_8_VOXCPM.md) ─────────────────
# The SECOND loadable model. Chatterbox's state is the pool above; VoxCPM2's is a
# per-card set of resident voxcpm.Workers — each a child process holding ONE card, in
# its own venv (§9). One-per-card is what makes m2's two-at-once real: a blank-seed
# Generate draws two seeds and runs one worker on each card, two candidates in the
# wall-clock of one (§7.2). They load and unload independently of Chatterbox: `which`
# on /model/load|unload picks one, "all" takes both.
#
# An idle resident VoxCPM2 is a VRAM NEIGHBOR (like KoboldCpp), not a GpuGate claim —
# holding weights doesn't reserve a card. A GENERATION does: it claims the card first
# (GPUS.claim_card), so it yields to renders and can't collide with an enhancement (§7.3).


# ── Bandwidth extension (4.1 — DESIGN_4_1_ENHANCE.md) ────────────────────────
# Chatterbox synthesizes at 24 kHz and is digitally silent above ~11 kHz. Enhancement
# invents plausible content up to ~22 kHz. It is a POST-PASS on finished audio, never
# part of the stream: what you hear live is raw, and the clip you keep is enhanced.
# That is intended, and it is the only shape that works — the enhancer is a ~21 GB
# child process in its own venv and takes ~1.6x realtime.

# 5.1-P4.12: `CAP_SECONDS` moved to `runtime/jobs.py`, beside the `cap60`/`cap_hit` fields it
# governs. It is read from both sides of the playground split — the enforcement went to
# `web/playground.py`, `/enhance/info` reports it and §4.3 files that route under system — so
# it needed a runtime home rather than a second copy. NOT re-exported: six test sites rebind it.

# Job has an `enhance` FIELD, and a field NAME shadows the module of the same name inside
# the class body — so `enhance.NFE_DEFAULT` as a default there resolves against the bool
# and dies at import with "'bool' object has no attribute 'NFE_DEFAULT'". voicetrain hit
# this first and aliased the import; here the module is used too widely for that to read
# well, so the one value the class body needs is lifted out instead.
NFE_DEFAULT = enhance.NFE_DEFAULT


# 5.1-P4.4: `enhance_cards`, `ENHANCE_BUSY`, `enhance_available`, `ENHANCE_MISSING` and
# `enhance_one` are `vocalis.runtime.enhancement` now — six call sites in five domains, so
# there was no blueprint for them to ride along with. It was imported as `enhancement` and
# never as `enh`, because `enh` is a LOCAL in the playground's post-render enhance
# (`enh = enhance.scratch_path(...)`), which is the shape that produced
# `pool = pool.current_pool()` in P3.4.
# 5.1.1: the import is gone -- the last reader in this module left with the blueprints.
# 6.0: AND IT IS BACK, for one line -- `create_stream_blueprint` took the scene enhancer as an
# injected callable (§3.5a).
# 6.3: AND IT IS GONE AGAIN. A scene build no longer enhances; enhancing a scene is a verb on
# its Clips row, and `web/clips.py` reaches `runtime.enhancement` directly, the way the other
# five enhance callers do. Nothing in this module reads the name any more.


# ── Jobs ──────────────────────────────────────────────────────────────────────

# 5.1-P2: the registry itself now lives in vocalis/runtime/jobs.py -- five domains write
# JOBS and six read it, so nothing could be split out of this file while it lived here.
#
# 5.1-P4.11/P4.12: BOTH runners have left -- `run_job` with the Books tab and
# `run_playground_job` with the Playground -- and with them the last reader in this module of
# `Job`, `JOBS`, `JOBS_LOCK`, `emit` and `prune_jobs`. **The re-export line is gone**, which is
# ~80 test sites now reaching `jobs_mod.X` instead of `vs.X`. That churn buys the §6.2 property:
# a name this module does not read cannot be a patch target that silently applies to nothing.
# 5.1.1: the import is gone too. This comment claimed until 5.1 that `jobs.CAP_SECONDS` and
# `jobs.job_sse` were "still read here" -- P4.17/P4.18 took both readers and the sentence went
# stale silently, which is the §11 "a claim in a comment is a HYPOTHESIS" trap in miniature.


# 5.1-P3: the request coercers live in vocalis/runtime/params.py, under names that say what
# they do; call as_bool/as_int. `_f` and the `rt_params` alias went with the playground and
# books -- the alias existed because two route bodies bind a LOCAL called `params`.
# 5.1.1: `_b`/`_i` are gone with them. They were re-exported "because the routes left in this
# file use those", and since P4.18 this file HAS no routes.
from vocalis.runtime import voices as rt_voices
from vocalis.runtime import nomi as rt_nomi


# ── Flask ─────────────────────────────────────────────────────────────────────

import logging
logging.getLogger("werkzeug").setLevel(logging.ERROR)


class _DropClientDisconnects(logging.Filter):
    """Drop only expected client-disconnect conditions such as broken pipes, TLS truncation, and idle-socket timeouts after a peer has gone away. Keep genuine TLS configuration and protocol errors at error level."""

    _GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)
    # Werkzeug does NOT attach the exception to the record: serving.py renders it with
    # DebugTraceback(e).render_traceback_text() and logs the traceback as plain TEXT
    # (`log("error", f"Error on request:\n{msg}")`). So record.exc_info is None and the
    # message is the only evidence there is. Matching on exc_info alone silently passed
    # every one of these through — the first version of this filter did exactly that.
    _TEXT = ("BrokenPipeError", "ConnectionResetError", "ConnectionAbortedError",
             "SSLEOFError", "UNEXPECTED_EOF_WHILE_READING",
             "APPLICATION_DATA_AFTER_CLOSE_NOTIFY")
    # …but never swallow a TLS failure that is genuinely OURS.
    _KEEP = ("CERTIFICATE_VERIFY_FAILED", "SSLCertVerificationError", "NO_SHARED_CIPHER",
             "WRONG_VERSION_NUMBER", "SSLZeroReturnError")

    def _is_client_gone(self, exc) -> bool:
        seen = set()
        while exc is not None and id(exc) not in seen:      # walk the __context__ chain
            seen.add(id(exc))
            if isinstance(exc, self._GONE) or isinstance(exc, ssl.SSLEOFError):
                return True
            if isinstance(exc, ssl.SSLError) and any(m in str(exc) for m in self._TEXT):
                return True
            exc = exc.__context__ or exc.__cause__
        return False

    def filter(self, record) -> bool:
        exc = record.exc_info[1] if record.exc_info else None
        if exc is not None and self._is_client_gone(exc):
            return self._drop(type(exc).__name__)
        try:
            msg = record.getMessage()
        except Exception:                                   # noqa: BLE001
            return True
        if any(k in msg for k in self._KEEP):
            return True                                     # a TLS failure that is OURS — never swallow
        if "Error on request" in msg and any(m in msg for m in self._TEXT):
            return self._drop(next(m for m in self._TEXT if m in msg))
        # The idle-socket twin of those resets: a client that finishes (often right after
        # playing a clip) and leaves its keep-alive socket OPEN rather than closing it. The
        # socket clock (SOCKET_TIMEOUT_S) expires and http.server logs "Request timed out:
        # TimeoutError(...)" — no "Error on request" traceback, so the branch above misses it.
        if "Request timed out" in msg:
            return self._drop("Request timed out")
        return True

    @staticmethod
    def _drop(what: str) -> bool:
        logger.debug(f"client hung up mid-response ({what}) — normal for a browser "
                     f"seeking in an audio file or recycling a keep-alive socket")
        return False


logging.getLogger("werkzeug").addFilter(_DropClientDisconnects())



class _VaultAuthWSGI:
    """BOUNDARY 1 of 5 — the Flask request boundary (SPEC_5_0_M5 §6).

    *** THIS CANNOT BE AN @app.errorhandler, AND THAT IS NOT A STYLE CHOICE. ***

    VaultAuthError subclasses BaseException, deliberately (vault.py:57, SPEC_5_0_M5 §2), and
    Flask's error handling is `except Exception` — verified against the installed Flask 3.1.3,
    not remembered:

        Flask.full_dispatch_request:  except Exception as e: rv = self.handle_user_exception(e)
        Flask.wsgi_app:               except Exception ... then a bare `except: raise`

    So an @app.errorhandler(VaultAuthError) would be code that SILENTLY NEVER RUNS: the
    exception sails straight past Flask and out into the WSGI server, and the client gets a
    dropped connection instead of an answer. Anyone "wiring the vault into Flask" will reach
    for errorhandler first. It does not work. Wrap wsgi_app — which is outside Flask's
    try/except — instead.

    Why 500 and not 401: a VaultAuthError from a DATA read is not "please log in", it is
    "these bytes did not authenticate" — a wrong DEK, tampering, truncation or real
    corruption. Telling the user to log in would be a lie that invites them to retry the thing
    that is failing. "Locked" is a 401 and it is a different gate entirely (_require_unlocked).
    The login/unlock routes catch it BY NAME themselves and DO return 401, because there it
    really does mean "wrong password".

    What matters most here is what this does NOT do: it does not delete, quarantine, "repair",
    or regenerate anything. It logs, and it gets out of the way.
    """

    def __init__(self, wsgi):
        self._wsgi = wsgi

    def __call__(self, environ, start_response):
        try:
            return self._wsgi(environ, start_response)
        except VaultAuthError as exc:
            logger.critical(f"VAULT AUTHENTICATION FAILED on {environ.get('PATH_INFO', '?')}: {exc}")
            logger.critical("Nothing has been read, judged, or deleted. The file is untouched.")
            body = json.dumps({"error": "vault_auth", "message": str(exc)}).encode("utf-8")
            start_response("500 INTERNAL SERVER ERROR",
                           [("Content-Type", "application/json"),
                            ("Content-Length", str(len(body)))])
            return [body]


# The ceiling the upload endpoints are raised TO. It has to be a NUMBER, not None: Flask 3.1's
# per-request setter stores None in `_max_content_length`, and the getter's first line is
# `if self._max_content_length is not None` — so None is indistinguishable from "never set" and
# falls straight back to the config above. "Unlimited" is simply not expressible per-request, and
# writing it that way fails SILENTLY (see _lift_body_cap_for_uploads). A big finite number is also
# the better answer: these routes stream to disk, so the real limit was always the platter, and a
# ceiling keeps a runaway upload from filling it. 8 GB clears the largest thing anyone can
# legitimately send by an order of magnitude — a 613 MB RVC .index beside its .pth is the current
# record holder — while staying far below the free space on any box that can run this app.
UPLOAD_BODY_CAP = int(os.environ.get("VOCALIS_MAX_FILE_UPLOAD_MB", "8192")) * 1024 * 1024

# ── Admin login (2.x web UI) ──────────────────────────────────────────────────
# LAN-only threat model: keep casual browsers out of the settings UI. This gates the
# web UI PAGE only — the machine endpoints (/speak, /v1/*, /health) stay open so
# SillyTavern and Nomi keep working. Credentials live ONLY in admin_credentials.yaml
# (gitignored): `username` in clear text + a salted one-way `password_hash`. Set them
# from the settings gear in the UI (CSRF-protected), or run ./scripts/set-admin-credentials.sh.
# No password set -> auth OFF (UI open on the LAN, as pre-2.x) + a boot warning.
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.serving import ThreadedWSGIServer, WSGIRequestHandler


# ── Auth guard ────────────────────────────────────────────────────────────────
# Everything the web UI calls is admin-only and requires the login cookie. The open set is
# now small: /health (extension pre-flight), /speak* (Nomi — knowingly open until its own
# milestone), plus the auth routes themselves. 7.0-m6: /v1/* (SillyTavern) is no longer open —
# it demands the pairing bearer, below. No password set -> auth off, all
# open (as pre-2.x). A caller with no session cookie (e.g. curl) gets 401, not data.
#
# /vault/recover is auth-OPEN on purpose: the user of that route has FORGOTTEN the password,
# so a login is the one thing they cannot produce. The recovery key IS its authentication
# (design §9.3) — and it is the single path back in, which is why there is deliberately no
# unauthenticated reset script.
_OPEN_PATHS = {"/health", "/login", "/logout", "/vault/recover"}


#: The `/speak/*` paths that demand the Nomi bearer (7.2-m4). `/speak/ping` joined them in m4b:
#: it is the extension's Test button, and it is only worth anything if it goes through the very
#: same gate the real call does.
_SPEAK_GATED = {"/speak", "/speak/stream", "/speak/ping"}


def _speak_is_capability_url(p: str) -> bool:
    """Return whether the path is one of the token-authenticated GET endpoints for streaming audio or status. The unguessable token is the credential, so media clients that cannot attach bearer headers must be able to use these paths. Keep the POST endpoints that mint tokens behind normal authentication."""
    return p.startswith("/speak/stream/")


def _configure_session_cookie(app: Flask) -> None:
    """Apply the optional per-instance cookie name used by packaged deployments."""
    name = os.environ.get("VOCALIS_SESSION_COOKIE_NAME")
    if name is None:
        name = "session"
    elif re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name) is None:
        raise ValueError("VOCALIS_SESSION_COOKIE_NAME must contain 1–64 letters, digits, '_' or '-'.")
    app.config["SESSION_COOKIE_NAME"] = name


# 5.1-P4.15: the credential STATE and the key DERIVATION are `runtime/auth.py`; INSTALLING the
# derived key on the Flask app is this module's job, and this two-line wrapper is the seam
# between them. It exists rather than three inlined `app.secret_key = auth.apply_admin_creds()`
# lines because that assignment IS the behavior `test_secret_key_is_stable_when_configured_and_
# rotates_on_change` checks: inlining it at every call site would leave the test asserting on a
# key that the test itself had installed, which proves nothing about the production path.
def _apply_admin_creds(target=None) -> None:
    """Reload admin_credentials.yaml and install the freshly derived session-signing key.

    🔴 THE ARGUMENT IS OPTIONAL, AND THAT IS NOT COSMETIC (5.1-P5). `create_app()` has to install
    the key on the app it is still building, which does not yet exist under the module-global
    name `app` — passing it in is the only way to keep the install at the same point in the
    sequence it has always been at. But `test_auth.py` calls `vs._apply_admin_creds()` with NO
    argument at twelve sites, and `vault_recover` / `admin_set_credentials` reach it the same way
    through `web/auth.py`'s injected seam, so the zero-arg form must keep meaning "the live app".
    Defaulting to the module global preserves both callers exactly. Changing the signature
    outright would have broken twelve tests loudly — and, far worse, silently repointed the two
    routes that rotate the signing key after a password change."""
    (target if target is not None else app).secret_key = auth.apply_admin_creds()




def _require_login():
    if paths.docker_encrypted_mode() and request.path == "/setup":
        return
    if not auth.auth_enabled() or request.method == "OPTIONS":
        return
    p = request.path
    # 🔴 `/pair/` IS EXEMPT HERE AND GATED SOMEWHERE ELSE — the one place in this file where
    # "exempt" does not mean "open". The extension calls from SillyTavern's origin, so
    # SameSite=Lax guarantees the session cookie is absent; demanding it would make the family
    # unreachable rather than secure. Its own bearer check runs as a before_request on the
    # blueprint (vocalis/web/pair.py) and `tests/test_pair_surface.py` walks the URL map to
    # prove no rule under it answers without a token. ⚠️ Never add a path here on the strength
    # of "the extension needs it" without that second half also being true.
    #
    # ⚠️ `/speak/stream/<token>` and `.../status` STAY OPEN, and that is not the milestone being
    # half-done — see the `/speak` gate below for why those two are capability URLs and must not
    # be given a second credential.
    if (p in _OPEN_PATHS or _speak_is_capability_url(p) or p.startswith("/pair/")):
        return
    # Require the Nomi bearer token for `POST /speak` and `POST /speak/stream`. These routes can consume GPU time and register persistent voice assignments, so leaving them open permits unauthenticated resource use and settings writes. Keep this token independent from SillyTavern pairing so either channel can rotate credentials without changing the other. Gate these routes here because the same blueprint also serves capability URLs that must remain open; include `/speak/ping` so the extension probe exercises the same credential check.
    if p in _SPEAK_GATED:
        # A LOCKED vault cannot verify a token — the token lives IN the vault. Fall through to
        # `_require_unlocked` for the same 401 LOCKED body `/v1/*` gets, so the extension can
        # tell "locked" from "not paired" and does not tell the user to re-copy a token that was
        # never wrong (m6 §3.4). `/speak` already 401'd while locked, so this changes nothing
        # about that path.
        if auth.vault_locked():
            return
        from wbedit import pairing
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() == "bearer" and pairing.NOMI.verify(token.strip()):
            return
        # The PATH only — never the header, never the body. The body of a /speak request is the
        # text being spoken, and a rejected request is exactly where a near-miss token would be
        # written to disk.
        logger.info(f"nomi: 401 {request.method} {p} from {request.remote_addr}")
        return jsonify({"error": "pairing token required — in the Vocalis web UI open the Nomi "
                                 "tab, copy the pairing token, and paste it into the Vocalis TTS "
                                 "for Nomi extension's Options page"}), 401
    # 🔴 7.0-m6 — `/v1/*` DEMANDS THE PAIRING BEARER. The 5.0-M0 exemption ("no user content")
    # died with one-Vocalis-per-user: anyone on the LAN could burn the GPUs, enumerate voice
    # names, confirm narrated text through /v1/audio/state, and cancel another user's builds
    # (m6 design §2.2–§2.3). The session cookie cannot stand in — SameSite=Lax means it never
    # arrives from SillyTavern's origin — so the pairing token IS the credential, sent exactly
    # the way OpenAI clients already authenticate (`Authorization: Bearer`), which makes the
    # family MORE OpenAI-compatible, not less (§3.1). Checked HERE, on the prefix, so every
    # current and future /v1/* route is covered by construction — never per-route decorators,
    # which fail silently on route thirteen (§3.2).
    if p.startswith("/v1/"):
        # A LOCKED vault cannot verify a token — the token lives IN the vault. Fall through to
        # `_require_unlocked` (registered right after this gate), which answers the same 401
        # LOCKED body it always has: the extension must be able to tell "locked" from "not
        # paired", or it tells the user to re-copy a token that was never wrong (§3.4).
        if auth.vault_locked():
            return
        from wbedit import pairing
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() == "bearer" and pairing.verify(token.strip()):
            return
        # The PATH only — never the header. A rejected request is exactly where a near-miss
        # token would be written to disk (`pair._check_pairing`'s rule, same reason). And one
        # 401 for "no token", "wrong token" and "unpaired install" alike: telling an
        # unauthenticated caller which is wrong tells it whether the install is worth attacking.
        logger.info(f"v1: 401 {request.method} {p} from {request.remote_addr}")
        return jsonify({"error": {
            "message": "pairing token required — in the Vocalis web UI open Settings → "
                       "SillyTavern pairing, copy the token, and send it as "
                       "'Authorization: Bearer <token>' (for OpenAI-compatible clients it "
                       "is simply the API key)",
            "type": "invalid_request_error"}}), 401
    if session.get("logged_in"):
        return
    if request.method == "GET" and request.headers.get("Sec-Fetch-Mode") == "navigate":
        # 🔴 QUALIFIED (5.1-P4.16): `login_page` is `vocalis_auth.login_page` since the auth
        # routes became a blueprint. A stale name here raises BuildError -> a 500 where the
        # login page should be, on the FIRST navigation an unauthenticated visitor makes. No
        # name-based audit can see a string, and this site had no test until P4.16 added
        # `test_auth.py::test_an_unauthenticated_browser_navigation_redirects_to_the_login_page`.
        return redirect(url_for("vocalis_auth.login_page"))   # a browser navigation -> the login page
    return jsonify({"error": "authentication required — log in to the Vocalis admin UI"}), 401


def _require_unlocked():
    """Enforce the locked-vault 401 after authentication middleware. While locked, reject every new audio, API, and UI request that needs vault data. Locking drains existing work rather than aborting it; requests already in flight may finish, and no new work starts."""
    if not auth.vault_locked() or request.method == "OPTIONS":
        return
    p = request.path
    if paths.docker_encrypted_mode() and p == "/setup":
        return
    if p in ("/health", "/login", "/logout") or p.startswith("/vault/"):
        return
    if request.method == "GET" and request.headers.get("Sec-Fetch-Mode") == "navigate":
        return redirect(url_for("vocalis_auth.login_page"))   # qualified — see _require_login
    # Path only, never the query string or body — those can carry the text being spoken.
    logger.info(f"locked-gate: 401 {request.method} {p} from {request.remote_addr} — the vault is locked")
    return jsonify(auth.LOCKED_BODY), 401


_DOCKER_FRESH_PATHS = frozenset({"/setup", "/health", "/login", "/logout",
                                 "/admin/set-credentials", "/vault/init"})
_DOCKER_RECOVERY_PATHS = frozenset({"/setup", "/health", "/login", "/logout",
                                    "/vault/recover"})


def _require_docker_bootstrap():
    """Keep the fresh-store surface small until existing credential/vault state is ready."""
    if not paths.docker_encrypted_mode():
        return
    if auth.STORE.is_initialized() and auth.auth_enabled() and not auth.creds_broken():
        return
    allowed = (_DOCKER_RECOVERY_PATHS if auth.STORE.is_initialized()
               else _DOCKER_FRESH_PATHS)
    if request.path in allowed or request.method == "OPTIONS":
        return
    if request.method == "GET" and request.headers.get("Sec-Fetch-Mode") == "navigate":
        return redirect(url_for("vocalis_auth.setup_page"))
    return jsonify({"error": "setup_required",
                    "message": "Complete Vocalis encrypted setup before using this route."}), 503


def _vault_locked_midrequest(exc):
    """Translate VaultLocked raised after the request passed the unlocked gate into the same clean 401 returned by that gate. This handles a concurrent logout during a read; it is a lock transition, not corruption, so do not repair or delete data."""
    return jsonify(auth.LOCKED_BODY), 401


# The endpoints that take a genuine file upload. Each reads request.files (multipart),
# which werkzeug spools to a tempfile past ~500 KB, and the save helpers copy it to its
# final home in chunks (shutil.copyfileobj) — the body is streamed to disk, never held
# in RAM. So the global MAX_CONTENT_LENGTH (a RAM guard for the open JSON routes) is the
# wrong instrument here: it would 413 a legitimate long WAV / big .epub for no gain. Lift
# it for just these (login-gated — _require_login already ran and let the request through)
# routes; everything else keeps the tight default. The only residual limit is disk, and an
# authenticated user filling the disk is a far milder, recoverable threat than an anon OOM.
_UPLOAD_ENDPOINTS = frozenset({
    "vocalis_voices.voices_add",                                     # ← 5.1-P4.9
    "vocalis_playground.playground_generate",                        # ← 5.1-P4.12
    "vocalis_songs.upload_song", "vocalis_stems.stems_upload",   # blueprint-qualified upload endpoints
    "vocalis_train.train_source_upload", "vocalis_books.books_upload",   # ← 5.1-P4.11
    "vocalis_bulk.bulk_start",
    # 🔴 5.1.1: `bulk_stage_add` was MISSING, and had been since the Bulk tab shipped in 4.5 —
    # this predates the refactor (49a5835 has the same nine names, unqualified). It reads
    # request.files.getlist("file") exactly as bulk_start does, so staging a batch of songs
    # into the Bulk tab 413'd at the 128 MB RAM guard instead of streaming to disk. Found by
    # asking the converse question the audit never asked: not "is every listed name real?"
    # but "is every route that READS request.files listed?" — see test_upload_body_cap.py.
    "vocalis_bulk.bulk_stage_add",
})


def _lift_body_cap_for_uploads():
    # Set a numeric per-request limit for upload endpoints. In Flask 3.1, assigning `None` unsets the request-specific value and falls back to the global limit; the failure appears only on uploads larger than that limit.
    if request.endpoint in _UPLOAD_ENDPOINTS:
        request.max_content_length = UPLOAD_BODY_CAP


# ── The auth routes are `vocalis/web/auth.py` (5.1-P4.16) ────────────────────
# `/login` (GET+POST), `/logout`, `/vault/init`, `/vault/unlock-suk`, `/vault/recover` and
# `/admin/set-credentials`, plus `_migrate_kobold_password`. Registered at the bottom with the
# other Phase 4 blueprints; the two `before_request` gates above keep the `url_for` for the
# login page, which is why they now name it `vocalis_auth.login_page`.
#
# ── The system routes are `vocalis/web/system.py` (5.1-P4.17) ─────────────────
# `/health`, `/gpus`, `/gpus/stats`, `/system/stats`, `/model/load`, `/model/unload`,
# `/engine/restart`, `/enhance/info`, `/render/rate` and `/library`, plus `_MODEL_WHICH`.
# Measured 12 names, 194 lines, **0 shared**, reverse check empty, and not one test rebinds
# any of it -- the cleanest domain of the refactor, and the payoff for doing the auth core
# first. `_gpu_name` went with it: its only reader was `/render/rate`, and it aliased
# `render_rate.gpu_name`, which is already the single definition its own comment asked for.
# ⚠️ `/health` stays on `_OPEN_PATHS` and `_require_unlocked`'s exempt list -- both PATH-based
# and both still here, so the move did not touch them, but renaming that URL would.


# ── serving a file OUT of the vault (5.0-M6) ──────────────────────────────────

# ── Voices management (2.0-M6) ────────────────────────────────────────────────


# ── Stems (4.0 M4 — the store, §5 · §7) ───────────────────────────────────────
# 5.1-P4.3: the whole tab is `vocalis/web/stems.py` now — ten routes, `_ss_job_or_404` and
# `_swaps_using`. Registered with the other Phase 4 blueprints at the bottom of this file.
# The `shared studio-job SSE` header that used to sit here went with `job_sse` in P4.2.


# ── Bulk (4.5 — DESIGN_4_5_BULK_ENHANCE.md) ───────────────────────────────────
# 5.1-P4.5: the whole tab is `vocalis/web/bulk.py` now — thirteen routes, the two per-file
# engines, and the GPU-picker resolver. Registered with the other Phase 4 blueprints below.


# `/train/*` retains shared source preparation and import paths; RVC job execution is excluded.


# ── Clean up (4.4): Trim + Denoise an uploaded clip into new clip(s) ───────────
# 5.1-P4.6: eight routes and three background jobs, all in `vocalis/web/cleanup.py` now. The
# 🔴 M10 §7.1 note that used to be here — transient decrypted A/B snippets go to the SCRATCH,
# never to output/ — moved with them; it is a property of those routes, not of this file.






# ── SillyTavern / OpenAI-compatible speech endpoint (2.1-M5) ──────────────────
# ST drives this as an "OpenAI-compatible" TTS source. ST splits a message into
# paragraphs itself, requests them sequentially, and plays in order — so a
# whole-file response per request already gives the streaming UX (no reorder buffer
# needed). Each request's chunks fan across all cards via the shared pool at
# INTERACTIVE priority, interleaving with any book render.




# ── Nomi /speak (2.1-M2) ──────────────────────────────────────────────────────
# The Nomi Chrome-extension contract, moved off the standalone nomi_server onto the
# shared pool. The MD5 audio cache is preserved; generation fans across cards at
# INTERACTIVE priority so a book render never blocks live Nomi speech.


# ── Streaming endpoints (3.0-M3/M4) ───────────────────────────────────────────
# POST /speak/stream (Nomi) + POST /webui/stream (Audition/Playground) + POST
# /v1/audio/stream (SillyTavern extension) + one-time GET /speak/stream/<token>
# + /status: one continuous progressive-MP3 stream, seconds to first audio. All
# logic lives in vocalis_stream_http (kept out of this file on purpose); the
# app-level CORS above (r"/speak.*" and r"/v1/*") covers the cross-origin
# routes. /webui/stream is same-origin only and login-gated (deliberately NOT
# on the auth guard's exempt list). The /v1 register borrows this file's voice
# resolver + tuned-settings lookup so it behaves EXACTLY like /v1/audio/speech.
# SillyTavern character registry (3.0-M4b): characters pushed by the ST extension
# land in voice_settings.yaml's `sillytavern` section; voices/params are assigned
# from the web UI's SillyTavern tab. /v1/st/characters is open (extension push);
# /st/characters is login-gated automatically (not on the exempt list).
# ══ The application factory (5.1-P5) ═════════════════════════════════════════
# 🔴 EVERYTHING IN HERE USED TO RUN AT IMPORT, SPREAD OVER ~470 LINES. Phase 5 changes not one
# byte of what it does, nor the order it does it in -- it gives the sequence a name and one
# place to read it. This was blocked until P4.18: the ledger's standing objection was that "a
# factory which does not own the routes still decorating this module is a second, fake way to
# get an app", and that was right until the last `@app.route` left.
#
# ⚠️ WHAT IS DELIBERATELY *NOT* IN HERE. `from vocalis.runtime import auth` (top of file)
# configures the vault STORE as an import-time side effect and must happen before the first
# routed read -- pulling it in here would re-arm a crash-at-boot that only appears on an
# encrypted install. So this gives you a fresh Flask app, NOT a fresh world: the process-wide
# vault store stays module state, which is why `conftest.py` must still retro-patch it (§12.6,
# and the 284/307 failures its docstring records). Calling this twice in one process is
# therefore not isolation, and is not supported.
#
# The module-level call below is the ONLY one. Every test reaches the singleton as `vs.app`
# (67 references across 21 files) and that contract is deliberately unchanged.
def create_app() -> Flask:
    """Build the Flask app: WSGI guard, config, CORS, credentials, gates, blueprints.

    🔴 5.1.1: `global ST_REGISTRY, STREAM_BP, _web_kobold` USED TO BE HERE, and the reason
    recorded for it was wrong. §11 and this file both claimed a second call would leave
    `vs.STREAM_BP` aimed at a blueprint the live app does not serve from, so playground tokens
    would be minted into one registry and looked up in another and streams would silently 404.
    That cannot happen: measured, all eight references to the three names are INSIDE this
    function (the blueprints take them as parameters — `create_playground_blueprint(stream_bp)`
    — and `create_stream_blueprint`'s token map is a closure local), and nothing outside reads
    `vs.STREAM_BP` or `vs.ST_REGISTRY` at all. They were module state that no module used.

    Locals now, so that hazard is gone rather than guarded. `_web_kobold` is still captured by
    the two injection lambdas below; a closure cell is if anything the safer binding, since each
    app's lambda then holds its own.

    ⚠️ A SECOND CALL IS STILL NOT SUPPORTED, for a reason the old comment did not name:
    `web/auth.py` and `web/ui.py` store their injected seams as MODULE globals, so building a
    second app repoints the FIRST app's auth and ui wiring at the second app's dependencies.
    That is the real cross-app coupling, and `tests/test_app_factory.py` still pins the
    single-call invariant."""
    a = Flask(__name__)
    _configure_session_cookie(a)

    a.wsgi_app = _VaultAuthWSGI(a.wsgi_app)

    # Cap request bodies so an unauthenticated caller on the open /speak and /v1/* routes
    # can't POST a multi-GB body that werkzeug buffers fully into RAM before parsing
    # (get_json() reads the whole body to parse it — OOM-kills the process). 128 MB by
    # default; werkzeug returns 413 past it. This is the GLOBAL default and it exists for
    # the RAM-buffering routes ONLY: the genuine file-upload endpoints stream the body
    # straight to disk (werkzeug spools the multipart part to a tempfile; the save helpers
    # copy in chunks), so a 2-hour WAV never sits in RAM — those routes lift the cap
    # per-request in _lift_body_cap_for_uploads() below and are NOT bound by this number.
    # (Text-length and concurrent-stream caps are separate, still-open DoS items.)
    a.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("VOCALIS_MAX_UPLOAD_MB", "128")) * 1024 * 1024

    # Use `SameSite=Lax` as the CSRF defense for state-changing UI routes. CORS controls whether the browser may read a response; it does not stop a simple cross-site request from being sent. Lax withholds the session cookie from cross-site POSTs while preserving it for top-level GET navigation. Machine endpoints use separate bearer credentials and do not depend on the session cookie.
    a.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    # Allow cross-origin pairing requests because the bearer token is the credential and every pairing route verifies it. Restricting by `Origin` would not authenticate non-browser clients and would prevent legitimate clients on another hostname from pairing.
    CORS(a, resources={r"/speak.*": {"origins": "*"}, r"/v1/*": {"origins": "*"},
                       r"/pair/*": {"origins": "*"},
                       r"/health": {"origins": "*"}},
         expose_headers=["X-Cache-Key"])

    # 🔴 REGISTRATION ORDER IS LOAD-BEARING, and it used to be implicit in the order the
    # `@app.before_request` decorators happened to appear in the file. Stated explicitly:
    #   _require_login    -> you are told to LOG IN ...
    #   _require_unlocked -> ...before you are told the vault is SHUT (its docstring says so)
    #   _lift_body_cap    -> after the auth gate, so request.endpoint is set and the cap is
    #                        raised before werkzeug enforces it on parse
    # `errorhandler(VaultLocked)` is separate from `_VaultAuthWSGI` on purpose: VaultLocked is an
    # ordinary Exception so a handler DOES fire, while VaultAuthError is a BaseException and can
    # only be caught outside Flask (see the class docstring).
    a.before_request(_require_docker_bootstrap)
    a.before_request(_require_login)
    a.before_request(_require_unlocked)
    a.before_request(_lift_body_cap_for_uploads)
    a.errorhandler(VaultLocked)(_vault_locked_midrequest)

    # 🔴 THE BOOT CALL, AND IT IS NOT OPTIONAL. Without it `_ADMIN_HASH` stays "" and
    # `app.secret_key` is never set: `auth_enabled()` answers False, so `/` hands a logged-in
    # session to any visitor and an anonymous LAN caller can POST themselves a new admin password —
    # the exact fail-OPEN that `CredentialsUnreadable` exists to prevent, arrived at by a different
    # road. It ran at module level before 5.1-P4.15 too; the move nearly dropped it, which is
    # P4.5a's shape (a boot-path caller left behind) pointed at the auth core.
    _apply_admin_creds(a)

    from st_characters import StCharacterRegistry, create_st_blueprint
    ST_REGISTRY = StCharacterRegistry(paths.VOICE_SETTINGS)
    a.register_blueprint(create_st_blueprint(ST_REGISTRY, voice_options=rt_voices.options))

    from vocalis_stream_http import create_stream_blueprint
    STREAM_BP = create_stream_blueprint(
        rt_pool.current_pool, rt_nomi.NOMI, voice_dir=paths.VOICE_SAMPLES,
        resolve_voice=rt_voices.resolve_ref,
        st_registry=ST_REGISTRY,
        # 5.2's pre-render gate. Injected because vocalis_stream_http must not grow an edge into
        # vocalis.runtime. `prerender_model_ready` answers whether the saved device selection can
        # build a pool; an enabled pre-render is explicitly allowed to perform that lazy load.
        # `model_ready` would instead strand every post-restart request until a foreground click.
        render_active=GPUS.render_active, model_ready=rt_pool.prerender_model_ready,
        # 6.0 §3.5a's enhancer injection is GONE (6.3): the build stops at the raw scene, and
        # the card scheduling now lives beside the other five enhance callers, in web/clips.py.
        output_dir=lambda: OUTPUT_DIR,
        # 6.0 §2.3's build-time estimate. The SAME key `/render/rate` quotes from (web/system.py),
        # built the same way — a second spelling would be a second rate, and the whole point of
        # render_rate is that there is one measured number per rendering configuration.
        render_rate_key=lambda: render_rate.key_for(
            render_rate.gpu_name(), gpu.cuda_count(rt_pool.local_cuda_devices()),
            rt_pool.default_workers()))
    a.register_blueprint(STREAM_BP)   # STREAM_BP.register_stream serves /playground/stream


    # ── Phase 4 blueprints (5.1) ──────────────────────────────────────────────────
    # Registered exactly as the two above are, which is the seam that has worked since 3.x.
    # ✅ 5.1-P5: this comment used to say "`create_app()` is still deferred: a factory that does
    # not own the 157 routes still decorating this module is a second, fake way to get an app".
    # That objection was correct and it expired at P4.18, when the last `@app.route` left — you
    # are reading this from inside the factory.
    #
    # 🔴 These take NO injected state, unlike the two above. That is the payoff from Phase 3:
    # everything they need is a `vocalis.runtime` module they can import directly, so there is no
    # parameter list to keep in step and no default that quietly falls back to the old binding.
    #
    # ⚠️ Registration QUALIFIES every endpoint name: `stems_upload` becomes
    # `vocalis_stems.stems_upload`. Anything that names an endpoint as a string — url_for, the
    # `_UPLOAD_ENDPOINTS` frozenset — has to move with the routes, and the only one of those that
    # fails quietly is the frozenset (a stale name just stops lifting the body cap). That is what
    # `test_upload_body_cap.py::test_every_name_in_UPLOAD_ENDPOINTS_IS_a_real_endpoint` is for.
    from vocalis.web.comfyui import create_comfyui_blueprint
    a.register_blueprint(create_comfyui_blueprint())

    from vocalis.web.acestep import create_acestep_blueprint
    a.register_blueprint(create_acestep_blueprint())

    from vocalis.web.stems import create_stems_blueprint
    a.register_blueprint(create_stems_blueprint())

    from vocalis.web.bulk import create_bulk_blueprint
    a.register_blueprint(create_bulk_blueprint())

    from vocalis.web.train import create_train_blueprint
    a.register_blueprint(create_train_blueprint())

    from vocalis.web.cleanup import create_cleanup_blueprint
    a.register_blueprint(create_cleanup_blueprint())

    from vocalis.web.songs import create_song_library_blueprint
    a.register_blueprint(create_song_library_blueprint())

    from vocalis.web.speech import create_speech_blueprint
    a.register_blueprint(create_speech_blueprint())

    from vocalis.web.nomi import create_nomi_blueprint
    a.register_blueprint(create_nomi_blueprint())

    from vocalis.web.voices import create_voices_blueprint
    a.register_blueprint(create_voices_blueprint())

    # 🔴 The kobold blueprint is registered FIRST, because TWO other domains borrow a function from
    # it. `_kobold_render_conflict` is kobold code by body and books code by caller (§4.3 applied to a
    # helper, 5.1-P4.13/P4.11b), and `_kobold_secrets` is the same shape with `/settings/app` as its
    # foreign caller (5.1-P4.18).
    #
    # ⚠️ 5.1.1: BOTH ARRIVE AS A LAMBDA, AND THE REASON RECORDED FOR IT WAS FALSE. This said the
    # object form "would freeze the pre-patch binding" because a dozen tests stub `_kobold_cfg`
    # after the app is built. Tested, twice, independently: capturing the function object freezes
    # WHICH FUNCTION RUNS, not what that function READS — `_kobold_render_conflict` does a
    # LOAD_GLOBAL on `_kobold_cfg` against `vocalis.web.kobold.__dict__` at call time, so a later
    # stub of `_kobold_cfg` is seen through a captured object just as well as through a lambda.
    # What the lambda actually defends against is a patch of `_kobold_render_conflict` /
    # `_kobold_secrets` THEMSELVES, which nothing in the suite performs. So the lambdas are
    # harmless but not load-bearing; they are kept only because changing them buys nothing.
    # The claim mattered more than the code: §11 repeated it into three other files, and it was
    # shaping how the next refactor would wire its seams. See 5.1-refactor §11.
    # 5.1-P4.18: `create_kobold_blueprint()` no longer takes anything. `_kobold_secrets` used to live
    # in THIS module and be injected downward, on the grounds that it reaches `vault_locked()` ->
    # `STORE` and the auth core could not move. P4.15 moved the auth core, so the premise expired and
    # the function went home to `web/kobold.py` — which retires that injection outright rather than
    # relocating it.
    from vocalis.web.kobold import create_kobold_blueprint
    import vocalis.web.kobold as _web_kobold
    a.register_blueprint(create_kobold_blueprint())

    # 9.5-m1 — llama.cpp, the SECOND model host. Registered beside Kobold because they are peers
    # and the LLM tab shows them as sibling sub-tabs; neither imports the other, and the shared
    # locality/TLS policy they both need lives in `src/modelhost.py` rather than in either one.
    # ⚠️ No render-conflict lambda yet: `/book/start` gains a second 409 at m3, and wiring the
    # hook before the helper exists would be a seam with nothing on the other side of it.
    from vocalis.web.llama import create_llama_blueprint
    import vocalis.web.llama as _web_llama
    a.register_blueprint(create_llama_blueprint())

    # 9.5-m3 - the ENGINE-AGNOSTIC card question, and the only place it is asked. AFTER both
    # engines because it imports both: a third module reaching down into two peers is fine,
    # and is what keeps llama.py and kobold.py from having to know about each other.
    from vocalis.web.llm import create_llm_blueprint
    a.register_blueprint(create_llm_blueprint())

    # 11.1 — LLM ▸ API (OpenRouter, Featherless) and `/llm/engine`, the worldbook editor's engine
    # choice. Its own module rather than grown into `web/llm.py`, whose one job is the
    # ticked-cards question and whose docstring says so.
    from vocalis.web.llmapi import create_llmapi_blueprint
    a.register_blueprint(create_llmapi_blueprint())

    from vocalis.web.books import create_books_blueprint
    a.register_blueprint(create_books_blueprint(lambda: _web_kobold._kobold_render_conflict()))

    # 7.0 — the Character & Worldbook editor. AFTER kobold, because a pass reads `_kobold_cfg`
    # to resolve the transport it talks to the model over (§7: reuse it, never re-derive the
    # SSL context and the bearer).
    from vocalis.web.wbedit import create_wbedit_blueprint
    a.register_blueprint(create_wbedit_blueprint())

    # 7.0-m2 — `/pair/*`, the SillyTavern extension's channel, gated by a bearer token rather
    # than the session cookie (which SameSite=Lax never sends from ST's origin). 🔴 The gate is a
    # `before_request` INSIDE that blueprint, so registering it is what installs the gate and a
    # future route in it cannot miss one. `tests/test_pair_surface.py` walks the URL map and
    # fails on any `/pair/*` rule that answers without a token.
    from vocalis.web.pair import create_pair_blueprint
    a.register_blueprint(create_pair_blueprint())

    # 🔴 §6.5, resolved: `/playground/stream` mints a token with `STREAM_BP.register_stream(...)`,
    # and STREAM_BP is built ~50 lines above. While the route lived in this module that only worked
    # because the call sat inside a function body, 3,100 lines from the construction — a forward
    # reference nothing checked. Handing the blueprint in makes the ordering a fact of THIS line
    # instead of luck, and the object is passed directly (not a lambda) because nothing rebinds
    # STREAM_BP: no test patches it, and the token map has to be the same registry the transport
    # layer serves from — a late lookup would buy nothing and could hand back a different one.
    from vocalis.web.playground import create_playground_blueprint
    a.register_blueprint(create_playground_blueprint(STREAM_BP))

    # 6.0 §7: the Clips tab. In m1 it took nothing — a view over `output/scenes`, which
    # `scenes.py` owns end to end. m2 widened it to list Playground clips and uploads too, and
    # the upload store is the one of the three that is NOT derived from OUTPUT_DIR: it lives
    # wherever app settings put the training directory. So `configs.vt_cfg` goes in, as the
    # CALLABLE and not its result — settings change under a running server and this blueprint
    # is built once (the same rule as the two injected callables documented just below).
    from vocalis.web.clips import create_clips_blueprint
    a.register_blueprint(create_clips_blueprint(configs.speech_cfg))

    # 8.9: virtual folders over every listing. Takes NOTHING — unlike the Clips tab above, this
    # blueprint reads no store's directory and resolves no config: it owns one small file whose
    # location is `paths.FOLDERS`, read per request so the suite's pin applies. A folder is a
    # label, so the routes cannot reach an item even in principle.
    from vocalis.web.folders import create_folders_blueprint
    a.register_blueprint(create_folders_blueprint())

    # 🔴 TWO INJECTED CALLABLES, AND THE TWO SHAPES ARE NOT INTERCHANGEABLE (5.1-P4.16).
    # `_apply_admin_creds` is passed as the OBJECT: it is defined ~800 lines above, and nothing
    # rebinds it (test_auth.py's twelve `vs._apply_admin_creds()` sites CALL it, they do not replace
    # it), so there is no patched binding to re-read. `run_store_startup_tasks` is passed as a LAMBDA
    # for a completely different reason — it is defined BELOW this line, so handing over the object
    # would be a forward reference and a NameError at import. Same §6.5 class as STREAM_BP's, caught
    # here by the definition-vs-registration line numbers rather than by luck.
    #   Both defaults in web/auth.py RAISE. An unwired `apply_admin_creds` would leave a password
    # change without a key rotation (the old cookie keeps working), and an unwired
    # `store_startup_tasks` would silently skip the first-unlock repairs — a quiet default would make
    # "never wired" and "nothing to do" the same answer, which is `kobold_secrets`' rule again.
    from vocalis.web.auth import create_auth_blueprint
    a.register_blueprint(create_auth_blueprint(_apply_admin_creds,
                                               lambda: run_store_startup_tasks()))

    # 5.1-P4.17: takes NOTHING, which is what the ledger predicted for every domain after the auth
    # core came down. 0 shared names, 0 test rebinds, and the reverse check was empty.
    from vocalis.web.system import create_system_blueprint
    a.register_blueprint(create_system_blueprint())

    # The root route serves the UI shell and belongs to the UI blueprint. Keep the `url_for` endpoint name aligned with that blueprint. The UI blueprint receives the Kobold secrets reader used by its settings status; it owns that dependency.
    from vocalis.web.ui import create_ui_blueprint
    # 9.5-m1: a SECOND injected secrets reader, for llama.cpp's optional API key. Both are
    # lambdas over the owning blueprint module's binding so a test stubbing `_kobold_secrets` /
    # `_llama_secrets` still lands — the idiom P4.18 settled on, applied to the new engine.
    a.register_blueprint(create_ui_blueprint(
        lambda: _web_kobold._kobold_secrets(),
        lambda: _web_llama._llama_secrets()))

    return a


# The one call. See the factory's comment for why this is not a per-test seam.
app = create_app()


def _sweep_stale_workdirs():
    """Remove per-job scratch directories left by a process that has already exited. Run at startup before accepting jobs, when no job in this process can own a work directory. Include scratch roots whose context-manager cleanup was skipped by process termination."""
    work_roots = ((configs.ss_cfg, "stemsplit"),)
    for cfg_fn, label in work_roots:
        try:
            root = Path(cfg_fn().work_root)
            if not root.is_dir():
                continue
            for d in root.iterdir():
                if d.is_dir():
                    shutil.rmtree(d, ignore_errors=True)
                    logger.info(f"swept stale {label} workdir from a dead process: {d.name}")
        except Exception as exc:                               # noqa: BLE001
            logger.warning(f"stale-workdir sweep ({label}) failed: {exc}")
    try:
        scratch.sweep(configs.scratch_root())
    except Exception as exc:                                   # noqa: BLE001
        logger.warning(f"scratch sweep failed: {exc}")
    # 8.1-m1. NOT part of the scratch sweep above and deliberately a different shape: the ACE-Step
    # staging directory is the BACKEND's tempdir, shared with a process Vocalis does not own, so
    # "delete everything" is wrong there — `acestage.sweep` takes only files it minted and only
    # once they are a day old. It leaves `api_audio/` alone: the engine's finished songs there are removed
    # by the candidate store, when nothing refers to them any more (acecands.reconcile_output).
    # ⚠️ NARROW, NOT BLIND, and deliberately so — `test_m5_boundaries` fired on the blind version
    # and its own doctrine is to narrow the handler rather than move the bar. The surface really
    # is this small: `sweep` walks a directory and unlinks, so every failure it can produce is an
    # `OSError`, and the import is the only other thing here that can throw. A locked vault cannot
    # reach this at all — `stage_root` reads `app_settings.yaml`, which is outside the vault by
    # design, and `VaultAuthError` is a BaseException that neither of these would catch anyway.
    try:
        from vocalis.runtime import acestage
        acestage.sweep()
        # (2026-10-11) The engine's loose audio leftovers. Here, and only here, because no ACE-Step
        # child of this process can exist yet; `sweep_loose` checks that anyway.
        acestage.sweep_loose()
    except (OSError, ImportError) as exc:
        logger.warning(f"acestep staging sweep failed: {exc}")



def _refuse_to_share_a_root_with_another_instance() -> None:
    """Called at startup, BEFORE the sweep that would eat a sibling's scratch."""
    for root, label in ((cache_root(), "cache"), (configs.scratch_root(), "scratch")):
        msg = procs.claim_root(Path(root), label)
        if msg:
            logger.error(msg)
            sys.exit(1)


_DOCKER_WORKSPACE_READY = False
_DOCKER_WORKSPACE_LOCK = threading.Lock()


def run_store_startup_tasks():
    """The boot-time repairs and migrations THAT READ THE STORE.

    🔴 ON AN ENCRYPTED INSTALL THESE CANNOT RUN AT BOOT, and for a long time nobody noticed
    they weren't. Startup happens with the vault LOCKED — the DEK arrives at login, which may
    be hours later or never — so every one of these was reaching into a store it could not
    open. They failed in the quietest possible way: each is individually wrapped in a
    `try/except` whose whole point is that a repair must not stop the server from booting, so
    a locked vault produced one WARNING line apiece and the app came up looking healthy with
    none of its repairs done. `stems migration failed: vault is locked` has been in the
    journal on every single boot.

    `_restore_orphaned_regenbaks` was worse than quiet: its `OUTPUT_DIR.rglob("*.regenbak")`
    matched ciphertext names, so it found nothing and did not even warn. Routing it is what
    surfaced this whole class — it went from silently doing nothing to loudly doing nothing,
    which is how it got noticed at all.

    So they run HERE, from two callers: at boot (the only time they can run on an unencrypted
    box, where `route()` is inert and everything works as it did in 4.x) and again on the
    first unlock, which is the earliest moment an encrypted box can do them. Every one is
    idempotent — they have always re-run on every boot, so running twice was already the
    normal case and is not a new requirement.
    """
    if (auth.vault_locked()
            or (paths.docker_encrypted_mode() and not auth.STORE.is_unlocked())):
        logger.info("store startup tasks deferred — the vault is locked; they will run as "
                    "soon as someone logs in")
        return
    global _DOCKER_WORKSPACE_READY
    if paths.docker_encrypted_mode():
        with _DOCKER_WORKSPACE_LOCK:
            if not _DOCKER_WORKSPACE_READY:
                # These writers and recovery workers run only after successful unlock in Docker.
                _refuse_to_share_a_root_with_another_instance()
                _sweep_stale_workdirs()
                import scene_enhance_queue
                scene_enhance_queue.boot()
                threading.Thread(target=VOX.reaper, daemon=True).start()
                _DOCKER_WORKSPACE_READY = True
    _restore_orphaned_regenbaks()
    # wbedit (7.0-m4q, §9a.13a): a pass that was live when the process went away still says
    # `running` on disk, and nothing was ever going to change that — the thread is gone. Close
    # those out with where they actually got to, so the record stops asserting something false.
    try:
        from vocalis.web.wbedit import reconcile_orphaned_passes
        for _pid in reconcile_orphaned_passes():
            logger.info(f"wbedit: marked orphaned pass {_pid} interrupted (no process behind it)")
    # ⚠️ Named rather than blind: `reconcile_orphaned_passes` swallows its own store faults by
    # contract, so what is left here is the import and a programming error inside it.
    except (ImportError, OSError, ValueError, RuntimeError) as exc:
        logger.warning(f"wbedit pass reconcile failed: {exc}")
    # 🔴 REVOKE A PAIRING TOKEN THAT WAS PUBLISHED.
    #
    # `_require_login` returns immediately when no admin password is set, so an install in that
    # state answers `GET /wbedit/pairing` — which returns the bearer token — to anyone on the
    # LAN. That much is the known auth-off posture. The escalation is that setting a password
    # LATER does not revoke it: `/pair/*` is bearer-gated and `origins: "*"`, so a token copied
    # during the open period keeps working afterward, from anywhere, with no session, forever.
    # Changing the admin password must also invalidate tokens minted while auth was disabled.
    #
    # ⚠️ Here rather than in `save_admin_creds`, and that is deliberate: `scripts/set-admin-
    # credentials.py` writes `admin_credentials.yaml` DIRECTLY (it must — `getpass` cannot be
    # piped on Windows), so a hook on the setter would miss the documented way of setting one.
    # Deciding at boot from the recorded fact covers every route to a password, including a file
    # copied in by hand.
    try:
        from wbedit import pairing
        if pairing.revoke_if_minted_open():
            logger.warning("wbedit: the pairing token was minted while this server had NO admin "
                           "password, so it was readable by anyone who asked. A password is set "
                           "now, so that token has been REVOKED. Re-pair SillyTavern from "
                           "Extensions -> Vocalis; narration stays off until you do.")
    except (ImportError, OSError, ValueError, RuntimeError) as exc:
        logger.warning(f"wbedit pairing revocation check failed: {exc}")
    # Re-adopt the most recent completed batch from its manifest after a restart, then reap crash orphans and expired batches. The manifest is the durable source of truth; retain one batch per mode.
    try:
        # {mode: manifest} — one retained batch PER MODE since §5b, so this can adopt two.
        for _mode, _m in (bulk.startup_recover(configs.bulk_cfg()) or {}).items():
            logger.info(f"bulk: re-adopted last {_mode} batch — {_m.get('count')} file(s), "
                        f"{_m.get('format_label')}")
    except Exception as exc:                                   # noqa: BLE001
        logger.warning(f"bulk startup recovery failed: {exc}")
    # Pre-M4 splits carry Demucs's own `no_vocals.wav` and no identity, so nothing
    # could find them BY SONG — meaning a swap of an already-split song would quietly
    # re-run Demucs, which is the one thing M4 exists to stop. Idempotent; a set whose
    # song has since been deleted keeps its stems and stays listed.
    try:
        for _ref in stems.migrate(configs.ss_cfg()):
            logger.info(f"stems: {_ref} migrated into the M4 store")
    except Exception as exc:                                   # noqa: BLE001
        logger.warning(f"stems migration failed: {exc}")


def _restore_orphaned_regenbaks():
    """A crash between a regen's swap and its resolve leaves *.regenbak files whose
    original is missing. Sweep at startup so no chapter stays invisible: restore
    the backup when the original is gone, drop it when the original exists."""
    try:
        # 🔴 Routed, and rglob ESPECIALLY. Path.rglob matches the on-disk names, which are
        # ciphertext here, so this swept an encrypted output/ and found nothing every time —
        # a startup repair that reported "clean" forever while chapters stayed invisible.
        for bak in vault_fs.rglob(OUTPUT_DIR, "*.regenbak"):
            orig = bak.with_name(bak.name[:-len(".regenbak")])
            if vault_fs.exists(orig):
                vault_fs.unlink(bak, missing_ok=True)
            else:
                try:
                    vault_fs.rename(bak, orig)
                    logger.info(f"restored orphaned regen backup: {orig.name}")
                except OSError:
                    logger.warning(f"could not restore orphaned regen backup {bak}")
    except Exception:                                          # never block startup
        logger.exception("regenbak sweep failed")


# Every accepted socket needs a timeout, and the TLS handshake needs a shorter independent timeout. Werkzeug performs TLS wrapping during accept, so an incomplete ClientHello can block the single accept loop before worker threads are created. The process remains alive but stops accepting useful requests while connections accumulate. Do not set a timeout on the listening socket: on some platforms `accept()` can make the accepted socket blocking, leaving the handshake without the intended bound. Accept connections first, then run the handshake on a per-connection worker so a slow peer does not serialize all new connections. A handshake timeout on the accept thread still delays each subsequent connection for the full timeout; `_TLSHandshakeHandler` performs TLS I/O on the connection worker instead.
HANDSHAKE_TIMEOUT_S = 10.0    # a LAN TLS handshake is milliseconds; 10 s is pure slack
SOCKET_TIMEOUT_S    = 60.0    # the ordinary per-operation budget for a live connection


def _bounded_tls_accept(self):
    """Accept TLS sockets without performing the handshake on the server accept thread. Run the handshake in the connection worker with a short timeout so a peer that never sends a ClientHello cannot block new connections."""
    # RAW accept: socket.socket.accept, NOT SSLSocket.accept — no handshake has happened
    # yet, and the bare TCP socket is the only place the short clock can be attached.
    sock, addr = socket.socket.accept(self.socket)
    sock.settimeout(HANDSHAKE_TIMEOUT_S)
    ssock = self.ssl_context.wrap_socket(sock, server_side=True,
                                         do_handshake_on_connect=False)
    return ssock, addr


class _TLSHandshakeHandler(WSGIRequestHandler):
    """Werkzeug's handler plus the TLS handshake, run HERE — in the worker thread.

    get_request hands over an un-handshaken SSLSocket wearing HANDSHAKE_TIMEOUT_S. Failure
    is routine, not exceptional — sleeping laptops, abandoned speculative browser sockets —
    so it gets one WARNING naming the peer (the telemetry that identifies production
    dawdlers) and a quiet drop, never a traceback. Anything that is not a socket/TLS error
    still propagates: a real bug must stay loud.
    """

    def handle(self):
        sock = self.connection
        if isinstance(sock, ssl.SSLSocket):
            t0 = time.monotonic()
            try:
                sock.do_handshake()
            except (ssl.SSLError, OSError) as exc:
                # socket.timeout, ConnectionError and SSLEOFError are all covered here.
                logger.warning(f"TLS handshake abandoned by {self.client_address[0]}:"
                               f"{self.client_address[1]} after "
                               f"{time.monotonic() - t0:.1f}s: {exc!r}")
                return
            dt = time.monotonic() - t0
            if dt >= 1.0:
                # A LAN handshake is milliseconds; log the near-misses so a recurrence of
                # the stall has evidence attached instead of vibes.
                logger.warning(f"slow TLS handshake from {self.client_address[0]}:"
                               f"{self.client_address[1]}: {dt:.2f}s")
            # Handshake done — hand the connection the ordinary budget, so a legitimate
            # slow body (a few-hundred-MB .pth upload) isn't cut off by the handshake's
            # deliberately short clock.
            sock.settimeout(SOCKET_TIMEOUT_S)
        super().handle()


def wire_tls_accept(srv):
    """Install the TLS accept path on a built server: the no-I/O accept AND the
    worker-thread handshake. ONE function, because the two halves are useless apart — the
    deferred accept hands out un-handshaken sockets that only _TLSHandshakeHandler knows
    to finish. The browser specs' `bound_server` harnesses call this too, so a test cannot
    quietly hand-assemble a server that skips half the path it claims to be testing."""
    srv.RequestHandlerClass = _TLSHandshakeHandler
    srv.get_request = types.MethodType(_bounded_tls_accept, srv)
    return srv


class PortInUseError(RuntimeError):
    """Something is already listening on the port this instance was asked to serve.

    This is intentionally not an `OSError`: Werkzeug catches bind-time `OSError` and exits,
    which would hide the address-conflict diagnosis from the caller.
    """


def _port_is_taken(exc: BaseException) -> bool:
    """Return whether an address-in-use bind failure occurred. On Windows, recognize WSAEADDRINUSE (10048) and winerror as well as errno.EADDRINUSE; preserve platform-specific error reporting."""
    return getattr(exc, "errno", None) == errno.EADDRINUSE or getattr(exc, "winerror", None) == 10048


class _VocalisWSGIServer(ThreadedWSGIServer):
    """Configure Werkzeug’s threaded server to prevent a second listener from binding an active port on Windows while preserving POSIX restart behavior. Raise PortInUseError outside Werkzeug’s handler so startup can report the address conflict reliably."""

    # 🔴 The one platform difference, and it is the fix. Do not "tidy" it to a constant.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)      # Windows only
        if excl is not None:
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, excl, 1)
            except OSError:
                # Never worth failing a start over: the bind is still exclusive without it, and
                # only the hijack-by-someone-else case goes unguarded.
                logger.debug("SO_EXCLUSIVEADDRUSE was refused; binding without it")
        try:
            super().server_bind()
        except OSError as e:
            if not _port_is_taken(e):
                raise                      # a different problem — werkzeug reports it as before
            self.server_close()            # ours to close: werkzeug's OSError handler never runs
            raise PortInUseError(
                f"port {self.port} is already in use — something is listening on "
                f"{self.host}:{self.port}, almost certainly another copy of Vocalis. This one "
                f"has NOT started. Stop the other one, or start this with --port <a free port>."
            ) from e


def build_server(app, host, port, ssl_context):
    """The WSGI server exactly as production wires it — used by main() and by
    tests/test_tls_accept_stall.py, which drives real sockets at this.

    Raises `PortInUseError` when something already holds the port, on every platform. Built by
    hand rather than through `make_server()`, which picks werkzeug's own class: the port
    behavior above lives in the class, so it has to be ours.
    """
    srv = _VocalisWSGIServer(host, port, app, ssl_context=ssl_context)
    if ssl_context is not None:
        wire_tls_accept(srv)
    return srv


#: The Docker-mode "app_settings tls ignored" notice is logged once per process, however many times
#: resolve_ssl_context is called.
_DOCKER_TLS_IGNORED_LOGGED = False


def resolve_ssl_context(cert, key, adhoc: bool, app_settings: dict = None):
    """Resolve TLS settings in precedence order: command-line cert and key, environment variables, app_settings.yaml, then plain HTTP. Return the app.run certificate tuple or a human-readable configuration error without binding a socket.

    In Docker mode the app_settings.yaml `tls` entry is skipped: it names files on the host that
    shares the data folder (a standalone install adopted in place, October 10, 2026), which do not
    exist in the container and would stop startup. HTTPS there comes from the proxy in front of the
    published port. The file is not changed, so the standalone install still serves HTTPS from it
    after a switch-back. The command line and VOCALIS_TLS_CERT / VOCALIS_TLS_KEY still apply."""
    global _DOCKER_TLS_IGNORED_LOGGED
    tls  = (app_settings or {}).get("tls") or {}
    if tls and paths.docker_encrypted_mode():
        if not _DOCKER_TLS_IGNORED_LOGGED:
            _DOCKER_TLS_IGNORED_LOGGED = True
            logger.info("app_settings.yaml `tls` ignored in Docker mode (cert "
                        f"{tls.get('cert') if isinstance(tls, dict) else tls!r}, key "
                        f"{tls.get('key') if isinstance(tls, dict) else tls!r}): HTTPS comes from "
                        "the proxy in front of the published port; --tls-cert/--tls-key and "
                        "VOCALIS_TLS_CERT/VOCALIS_TLS_KEY still apply")
        tls = {}
    cert = cert or os.environ.get("VOCALIS_TLS_CERT") or tls.get("cert")
    key  = key  or os.environ.get("VOCALIS_TLS_KEY")  or tls.get("key")
    where = "--tls-cert / VOCALIS_TLS_CERT / app_settings tls.cert"
    if cert and key:
        for label, path in ((f"cert ({where})", cert),
                            (f"key ({where.replace('cert', 'key')})", key)):
            if not Path(path).exists():
                return None, f"HTTPS {label} file not found: {path}"
        return (cert, key), None
    if cert or key:
        return None, ("HTTPS needs BOTH a cert and a key — pass --tls-cert and --tls-key, "
                      "set VOCALIS_TLS_CERT and VOCALIS_TLS_KEY, or put `tls: {cert, key}` "
                      "in app_settings.yaml.")
    if adhoc:
        return "adhoc", None
    return None, None


def main():
    ap = argparse.ArgumentParser(description="Vocalis book + Nomi + SillyTavern server")
    ap.add_argument("--port", type=int, default=7870)
    ap.add_argument("--host", default=None,
                    help="bind address (default 127.0.0.1, or 0.0.0.0 when TLS is on)")
    ap.add_argument("--tls-cert", default=None,
                    help="PEM certificate for intranet HTTPS (e.g. an mkcert cert). Requires "
                         "--tls-key. For a box that should ALWAYS serve HTTPS, prefer "
                         "`tls: {cert, key}` in app_settings.yaml — a flag only protects the "
                         "one command that remembers to pass it.")
    ap.add_argument("--tls-key", default=None,
                    help="PEM private key for HTTPS. Requires --tls-cert.")
    ap.add_argument("--tls-adhoc", action="store_true",
                    help="serve HTTPS with a throwaway self-signed cert (testing only; needs pyOpenSSL).")
    args = ap.parse_args()

    # Fixed filename (not a timestamped one) so it's easy to `tail -f logs/vocalis.log`;
    # loguru rotation (10 MB, keep 5) still bounds growth and keeps the live file current.
    # Append-only (rotation bounds growth) — colors are a user setting, default on.
    setup_logging(paths.LOG_DIR / "vocalis.log",
                  colorize_file=bool(settings.load_app_settings().get("log_ansi_colors", True)))
    # Startup banner — light green so every restart is instantly findable in a tail.
    _bar = "=" * 120
    logger.opt(colors=True).info(f"<light-green>{_bar}</light-green>")
    logger.opt(colors=True).info(
        f"<light-green>{PRODUCT_NAME} v{VERSION} starting up — book + Nomi + SillyTavern server</light-green>")
    logger.opt(colors=True).info(f"<light-green>{_bar}</light-green>")
    # Logged here (not at import) so it lands in the file sink setup_logging just
    # attached, not only stderr/journald. CHUNKS_ROOT shares the same cache_root().
    logger.info(f"cache dir: {cache_root()}  (audio_cache + chunks)")

    ssl_context, err = resolve_ssl_context(args.tls_cert, args.tls_key, args.tls_adhoc,
                                           settings.load_app_settings())
    if err:
        logger.error(err)
        sys.exit(1)
    scheme = "https" if ssl_context else "http"
    # TLS may be bound to a network interface; plain HTTP stays localhost-only unless the operator overrides `--host`.
    host = args.host or ("0.0.0.0" if ssl_context else "127.0.0.1")
    if ssl_context:
        logger.info("HTTPS enabled" + (" (adhoc self-signed cert)" if ssl_context == "adhoc"
                                        else f" (cert {ssl_context[0]})"))
    # Mark the session cookie Secure only when we are actually serving TLS. Unconditional
    # would be worse than useless on the plain-HTTP path: the browser would refuse to store
    # the cookie at all over http://127.0.0.1 and every login would silently fail to stick.
    # Set here rather than at import because that is where `ssl_context` is first known.
    # (SameSite=Lax — the actual CSRF defense — is unconditional, up at the CORS block.)
    app.config["SESSION_COOKIE_SECURE"] = bool(ssl_context)

    # BEFORE the sweep: _sweep_stale_workdirs() empties the scratch, so on a shared root the
    # act of booting would destroy the other instance's in-flight temporaries.
    if not paths.docker_encrypted_mode():
        _refuse_to_share_a_root_with_another_instance()
        _sweep_stale_workdirs()
        run_store_startup_tasks()
    try:
        logger.info(f"GPUs: {gpu.gpu_registry()}")
    except Exception as exc:                                   # noqa: BLE001
        logger.warning(f"GPUs: none detected ({exc})")
    shown_host = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    logger.info(f"Open {scheme}://{shown_host}:{args.port} in your browser")
    # Come up COLD by default: don't hold VRAM until it's actually needed, so the
    # cards stay free for other apps. The model lazy-loads on the first render (or a
    # click of "Load model" in the UI). Set VOCALIS_PRELOAD=1 to warm at boot instead
    # (e.g. if SillyTavern/Nomi want an instant first request after a restart).
    if auth.creds_broken():
        # The old code could not tell this state from the one below, and reported the
        # WRONG one: a corrupt credentials file logged "the UI is OPEN" — which was true,
        # and was the bug. Now it is closed, and says so.
        logger.error("admin_credentials.yaml is UNREADABLE — every route is locked and no "
                     "password can open it. Fix the file, or delete it to return to first-run.")
    elif not auth.auth_enabled():
        if paths.docker_encrypted_mode():
            logger.warning("encrypted setup is required before content routes are available")
        else:
            logger.warning("no admin password set — the web UI is OPEN on the LAN. Set one "
                           "via the settings gear in the UI, or run ./scripts/set-admin-credentials.sh.")

    # Use an environment variable for the development passphrase so it cannot be carried into an installation by a source update.
    if auth.STORE.is_initialized() and not paths.docker_encrypted_mode():
        try:
            if not auth.STORE.dev_unlock():
                logger.info("the vault is LOCKED — log in to unlock it")
        except VaultAuthError as exc:
            logger.error(f"{vault_store.DEV_ENV} is set but did NOT unlock the vault: {exc}")
            logger.error("Starting LOCKED. Fix the variable, or log in normally.")

    if os.environ.get("VOCALIS_PRELOAD") == "1" and not paths.docker_encrypted_mode():
        threading.Thread(target=rt_pool.preload_default_pool, daemon=True).start()
    # An idle VoxCPM2 worker pins a CPU core for its whole life on this ROCm stack, so it
    # can't be left resident "just in case" — see voxcpm.IDLE_S_DEFAULT. Harmless when
    # VoxCPM2 isn't installed: the pool is simply always empty.
    if not paths.docker_encrypted_mode():
        threading.Thread(target=VOX.reaper, daemon=True).start()
    # The header's power line, sampling for as long as this process lives. HERE rather than in
    # create_app() for the same reason as the reaper above: the suite builds hundreds of apps
    # and none of them should start reading the host's sensors. Returns None on a box with no
    # /sys (every Windows one), and the header line simply never appears there.
    if power.start():
        # The RATE comes from the module, never retyped here: this line is the only evidence the
        # sampler produces on a box nobody can log into, and a hardcoded "1 Hz" that outlived the
        # constant would make that evidence a lie.
        logger.info(f"power sampler: {power.SAMPLE_HZ} Hz (CPU package + GPUs)")
    # The header's UPS line — wall draw off NUT. Returns None where `upsc` is not installed,
    # which is every box that never had a UPS; the header line simply never appears there.
    # ⚠️ A thread here is NOT a reading: `upsc` exists on any box with nut-client installed,
    # UPS or no UPS. The poller's own first-sample log line is the evidence, not this one.
    if ups.start():
        logger.info(f"ups poller: every {ups.POLL_S:g}s via {ups.source_text()}")

    # The satellite's own GPU(s) in the strip (10.21). Unlike power/ups this has no hardware
    # gate — `start()` always returns a thread, since a box with no satellites configured yet
    # still needs the manager watching for one added later in Settings — so the log line names
    # the cadence rather than treating a truthy return as news.
    satstats.start()
    # 11.2.7 — a scene-enhancement queue saved before this restart carries on by itself once the
    # vault is unlocked. HERE rather than in create_app() for the reaper's reason above: the suite
    # builds hundreds of apps, and none of them should start a worker.
    if not paths.docker_encrypted_mode():
        import scene_enhance_queue
        scene_enhance_queue.boot()
    logger.info(f"satellite stats sampler: up to {1.0 / satstats.POLL_UP_S:g} Hz per satellite "
                f"while watched, reconciling satellites.configured() every "
                f"{satstats.MANAGE_S:g}s")

    # A global default so every socket this process creates has SOME clock on it, rather
    # than the "block forever" that is Python's default. Outbound calls are unaffected in
    # practice — every urlopen() in the tree already passes an explicit timeout, and an
    # explicit one always wins. It reaches the sockets that had nothing: the ones the WSGI
    # server accepts. Set BEFORE the server is built so the listener inherits it.
    socket.setdefaulttimeout(SOCKET_TIMEOUT_S)

    # Built explicitly rather than via app.run() so the TLS accept path can be bounded —
    # see _bounded_tls_accept / _TLSHandshakeHandler. run_simple() gives no hook for this.
    try:
        srv = build_server(app, host, args.port, ssl_context)
    except PortInUseError as e:
        # 🔴 THE MESSAGE, AND A NON-ZERO EXIT. The failure this replaces was silent, so the
        # thing to get right is that it is now impossible to miss: one line naming the port,
        # and a process that ends rather than one that sits looking alive.
        logger.error(str(e))
        raise SystemExit(1)
    if ssl_context is not None:
        logger.info(f"TLS handshake timeout {HANDSHAKE_TIMEOUT_S:g}s · "
                    f"socket timeout {SOCKET_TIMEOUT_S:g}s · handshakes run per-connection")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
