#!/usr/bin/env python3
"""Provide the configured workspace for plaintext files required by external tools that need seekable paths. Use opaque hash-derived names, the configured scratch root, and context-managed cleanup plus startup sweeping. Scratch is for active job work only; durable state and user uploads belong in the vault. Training outputs written there must be copied into the vault while the job runs. Keep ffmpeg on pipes when possible."""
from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import uuid
from pathlib import Path

from loguru import logger

from vocalis.runtime import paths

# The install root — the same anchor tts_utils and enhance use.
_BASE_DIR = paths.CODE_DIR

ENV_VAR = "VOCALIS_SCRATCH_DIR"


def default_root() -> Path:
    """Return the configured scratch directory, defaulting beneath the mounted data root."""
    return paths.SCRATCH_DIR


def scratch_root(app_settings: dict = None) -> Path:
    """env var → app_settings `scratch:` → default. The same precedence every other studio
    path in this app uses (voicetrain/voiceswap/enhance resolve_config), deliberately, so
    there is one rule to remember."""
    s = (app_settings or {}).get("scratch")
    return Path(os.environ.get(ENV_VAR) or s or default_root())


def opaque_name(key, suffix: str = "") -> str:
    """A name that spells NOTHING about what is in the file.

    Identical construction to `vault.decrypt_to_scratch` — sha256 of the key, first 16 hex,
    plus the suffix. `key` is whatever makes this temporary unique (a source path, a job id,
    a stage tag); it is HASHED, so it may safely contain the user's prose. That is the whole
    point: the caller gets to be descriptive and the filesystem still learns nothing."""
    return hashlib.sha256(str(key).encode("utf-8")).hexdigest()[:16] + (suffix or "")


def path_for(root, src, tag: str = "", suffix: str = ".wav") -> Path:
    """An opaque scratch path for `src`, under `root`. Does NOT create anything.

    `tag` separates two temporaries derived from the same source (e.g. the pre-enhance
    convert vs. the enhanced result), and should carry the job id when two jobs could be
    working on the same source at once — the hash of a bare path is the same in both, and
    two jobs sharing one scratch file is a race, not a cache."""
    return Path(root) / opaque_name(f"{src}|{tag}", suffix)


@contextlib.contextmanager
def file(root, key, suffix: str = ".wav"):
    """An opaque scratch PATH whose file is deleted on the way out — success, exception or
    cancel. Yields the Path; the file need not exist (a child may be about to create it).

    Use this instead of `tempfile.NamedTemporaryFile(delete=False)`, whose cleanup lived in
    a `finally` that a SIGKILL does not run — which is how the raw uploaded voice recording
    came to outlive the request that made it, permanently, in the OS temp dir."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    p = root / opaque_name(f"{key}|{uuid.uuid4().hex}", suffix)
    try:
        yield p
    finally:
        p.unlink(missing_ok=True)


@contextlib.contextmanager
def directory(root, key):
    """An opaque scratch DIRECTORY, rmtree'd on the way out. For a child that writes a tree
    rather than a file — Demucs emits `<model>/<song stem>/{vocals,no_vocals}.wav`, and that
    `<song stem>` is the SONG TITLE unless the input it was handed was already opaque."""
    root = Path(root)
    d = root / opaque_name(f"{key}|{uuid.uuid4().hex}")
    d.mkdir(parents=True, exist_ok=True)
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


# Bulk staging survives a service restart so `bulk.startup_recover()` can adopt its batches. The startup sweep runs before recovery and must skip this directory.
# Bulk owns expiration, crash-orphan cleanup, and explicit clearing. Scratch is still ephemeral across a host reboot, when the user must re-upload the batch.
BULK_SUBDIR = "bulk"

# This directory holds only active generation output and intermediate files. Persist finished candidates in the vault; these files are temporary and may be removed after a crash.
# The training owner removes the workspace when no training scope is active, so the exemption does not retain plaintext data indefinitely.
CANDIDATES_SUBDIR = "voxcpm_candidates"

# Cleanup preview snippets are short-lived, regenerable A/B samples. Do not exempt them from the startup sweep; the owner also prunes them after one hour.
CLEANUP_PREVIEW_SUBDIR = "cleanup_preview"

# The running instance's claim on this root (vocalis_server._claim_root). It is written BEFORE
# the startup sweep — the check has to precede the sweep, because on a shared root the sweep is
# the very thing that would eat the other instance's temporaries — so without this exemption the
# boot would immediately delete its own claim and leave the root looking unowned.
INSTANCE_MARKER = ".vocalis-instance"

def sweep(root, keep=(BULK_SUBDIR, INSTANCE_MARKER)) -> int:
    """Remove stale transient scratch entries while preserving bulk staging and ownership marker."""
    root = Path(root)
    if not root.is_dir():
        return 0
    n = 0
    for p in root.iterdir():
        if p.name in keep:
            continue
        try:
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
            n += 1
        except OSError as e:                            # a handle still open on Windows
            logger.warning(f"scratch sweep could not remove an entry ({type(e).__name__})")
    if n:
        # Count only — a scratch name is a hash, but the COUNT is the useful number anyway.
        logger.info(f"scratch: swept {n} orphaned item(s) left by a previous run")
    return n
