"""Temporarily expose an encrypted LoRA to ComfyUI for one test run.

The lending context manager writes an opaque, uniquely named copy to the ComfyUI model directory
and removes it on exit. Startup cleanup removes matching files left by an interrupted process.
"""
from __future__ import annotations

import contextlib
import os
import uuid
from pathlib import Path

import vault_fs
from loguru import logger

ENV_VAR = "VOCALIS_COMFYUI_LORA_DIR"

#: Default ComfyUI LoRA directory. Override per host and probe before offering the feature.
DEFAULT_DIR = Path("/ai-models/Image Models/loras")

#: Identifies temporary files created by Vocalis so startup cleanup can remove them without
#: inspecting model contents.
PREFIX = "vocalis-test-"
SUFFIX = ".safetensors"


def lora_dir(app_settings: dict | None = None) -> Path:
    """env var → app_settings `comfyui_lora_dir` → default. The precedence every other studio path
    in this app uses (`scratch.scratch_root`, voicetrain, enhance), deliberately."""
    s = (app_settings or {}).get("comfyui_lora_dir")
    return Path(os.environ.get(ENV_VAR) or s or DEFAULT_DIR)


def available(app_settings: dict | None = None) -> bool:
    """Can we lend at all? Probed, never assumed — the Test screen must say "not on this host"
    rather than offering a model it cannot hand over."""
    try:
        return lora_dir(app_settings).is_dir()
    except OSError:
        return False


def sweep(app_settings: dict | None = None) -> int:
    """Delete every model we ever lent. Call at startup, before anything runs.

    Matching files were created for a run in a prior process and are no longer needed.
    """
    d = lora_dir(app_settings)
    n = 0
    try:
        if not d.is_dir():
            return 0
        for p in d.iterdir():
            if not (p.name.startswith(PREFIX) and p.name.endswith(SUFFIX)):
                continue
            try:
                p.unlink()
                n += 1
            except OSError as exc:
                logger.warning(f"lora publish: could not sweep a lent model ({type(exc).__name__})")
    except OSError as exc:
        logger.warning(f"lora publish: sweep could not read the lora directory - {exc}")
    if n:
        # The count only. The name is a hash, but there is nothing useful in it anyway.
        logger.info(f"lora publish: swept {n} model(s) left lent by a previous run")
    return n


@contextlib.contextmanager
def lent(src, *, app_settings: dict | None = None):
    """`with lent(vault_path) as name:` — the name ComfyUI will accept, removed on the way out.

    `src` is a LOGICAL vault path; the bytes come back through `vault_fs.read_bytes`, because on
    an encrypted install that file is not on the platter under that name. `None` yields `None`, so
    a caller can wrap unconditionally.

    Cleanup is unconditional: the copied model is plaintext in a shared directory and must not
    outlive the test run.
    """
    if src is None:
        yield None
        return

    d = lora_dir(app_settings)
    if not d.is_dir():
        raise OSError(f"ComfyUI's lora directory is not on this host: {d}")

    name = f"{PREFIX}{uuid.uuid4().hex[:16]}{SUFFIX}"
    dst = d / name
    dst.write_bytes(vault_fs.read_bytes(src))
    logger.info(f"lora publish: lent a trained model to ComfyUI as {name}")
    try:
        yield name
    finally:
        try:
            dst.unlink(missing_ok=True)
            logger.info(f"lora publish: took {name} back")
        except OSError as exc:
            # Left behind, but not left unnoticed AND not left for ever: `sweep()` at the next
            # startup is what makes this recoverable rather than a silent permanent leak.
            logger.error(f"lora publish: could not remove {name} - {exc}")
