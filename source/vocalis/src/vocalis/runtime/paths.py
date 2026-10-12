"""Resolve immutable code paths and external data roots used by the application."""
import os
from pathlib import Path

from tts_utils import cache_root

# src/vocalis/runtime/paths.py -> src/vocalis/runtime -> src/vocalis -> src -> code root
CODE_DIR = Path(__file__).resolve().parents[3]
# Keep BASE_DIR as the legacy code-root name for engine/script configuration and process identity.
BASE_DIR = CODE_DIR

# A Docker image sets VOCALIS_DATA_DIR to its required mounted root. Legacy source installs keep
# their prior layout when the variable is absent.
DATA_DIR = Path(os.environ.get("VOCALIS_DATA_DIR") or CODE_DIR).expanduser()
LOG_DIR = Path(os.environ.get("VOCALIS_LOG_DIR") or (DATA_DIR / "logs")).expanduser()
SCRATCH_DIR = Path(os.environ.get("VOCALIS_SCRATCH_DIR") or (DATA_DIR / "work" / "scratch")).expanduser()
BULK_DIR = Path(os.environ.get("VOCALIS_BULK_DIR") or (SCRATCH_DIR / "bulk")).expanduser()


def docker_encrypted_mode() -> bool:
    """Whether this image requires an initialized encrypted vault before serving content."""
    return os.environ.get("VOCALIS_REQUIRE_VAULT", "0").strip().lower() in {"1", "true", "yes", "on"}


def validate_runtime_roots() -> None:
    """Fail before importing the app when required Docker mounts are absent or unwritable."""
    if not docker_encrypted_mode():
        return
    required_env = ("VOCALIS_DATA_DIR", "VOCALIS_CACHE_DIR", "VOCALIS_LOG_DIR",
                    "VOCALIS_SCRATCH_DIR", "VOCALIS_BULK_DIR")
    missing_env = [name for name in required_env if not os.environ.get(name, "").strip()]
    if missing_env:
        raise RuntimeError("Docker Vocalis requires explicit mounted roots: "
                           + ", ".join(missing_env))
    roots = (("data", DATA_DIR), ("cache", cache_root()), ("logs", LOG_DIR),
             ("scratch", SCRATCH_DIR), ("bulk", BULK_DIR))
    for label, root in roots:
        if not root.is_absolute():
            raise RuntimeError(f"required Vocalis {label} path must be absolute: {root}")
        if not root.is_dir():
            raise RuntimeError(f"required Vocalis {label} directory is missing: {root}")
        if not os.access(root, os.W_OK | os.X_OK):
            raise RuntimeError(f"required Vocalis {label} directory is not writable: {root}")

# Keep the source root literal so the vault audit can identify the code tree as an exempt prefix.
_SRC = CODE_DIR / "src"

VOICE_SAMPLES = DATA_DIR / "voice_samples"
VOICE_SETTINGS = DATA_DIR / "voice_settings.yaml"
UI_STATE = DATA_DIR / "ui_state.yaml"
CLIP_FAVORITES = DATA_DIR / "clip_favorites.yaml"
# 11.2.7: the scenes waiting to be enhanced, in order — the queue moved off the browser tab. In the
# vault for the same reason as the stars above: every ref's slug is a scene TITLE.
SCENE_ENHANCE_QUEUE = DATA_DIR / "scene_enhance_queue.yaml"
# Virtual folders and item references. The names and classifications are user-authored data.
FOLDERS = DATA_DIR / "folders.yaml"
BOOKS_DIR = DATA_DIR / "books"

# Character and worldbook documents, revisions, and editing proposals. These can contain full
# user-authored documents, so the tree is routed through the vault.
WBEDIT_DIR = DATA_DIR / "wbedit"

# Generated voice-audition candidates. The application ingests completed clips from scratch
# into this routed store so candidates persist across restarts and remain protected at rest.
VOICE_CANDIDATES = DATA_DIR / "voice_candidates"

# Saved Create-a-voice forms. The file is routed through the vault because its prompt and sample
# text are user-authored content; the filename contains no template content.
VOICE_TEMPLATES = DATA_DIR / "voice_templates.json"

# Saved song templates. The file is routed through the vault because it contains lyrics and
# other user-authored content; the filename contains no template content.
ACE_TEMPLATES = DATA_DIR / "ace_templates.json"

# Saved-song index and audio. The directory is routed as a store so both media and filenames are
# protected.
ACE_LIBRARY = DATA_DIR / "ace_library.json"
#: 8.0-m7 — the candidates tray, so it survives a restart. The INDEX only; the audio stays on
#: the ACE-Step box until Save promotes it. See runtime/acecands.py.
ACE_CANDIDATES = DATA_DIR / "ace_candidates.json"
ACE_LIBRARY_AUDIO = DATA_DIR / "ace_library"

# LoRA subject metadata and training datasets. Both are routed through the vault because datasets
# may contain identifiable images and captions.
#
# Filenames are protected with the contents. Dataset directories use generated IDs rather than
# subject names.
#
LORA_SUBJECTS = DATA_DIR / "lora_subjects.json"
LORA_DATASETS = DATA_DIR / "lora_datasets"

# Global LoRA prompt templates. These are user-authored and may outlive an individual subject.
LORA_PROMPT_TEMPLATES = DATA_DIR / "lora_prompt_templates.json"

# LoRA seed faces. This directory is routed as a tree because images may identify people and
# directory names also reveal stored content.
LORA_FACES = DATA_DIR / "lora_faces"

# Generated LoRA images are kept separate from curated datasets because Build may clear its
# output directory while curation must preserve generated originals.
LORA_GENERATED = DATA_DIR / "lora_generated"

# LoRA training runs include configuration, logs, and model output. The entire directory is
# routed through the vault because these artifacts may identify the trained subject.
LORA_TRAINING = DATA_DIR / "lora_training"

# Production index and derived assets. These include prompts and media derived from protected
# source content; the assets are regenerable cache files rather than a second media library.
# Generated seed-face candidates. Route them like `LORA_FACES`; unselected candidates may still
# contain identifiable images.
LORA_FACE_CANDIDATES = DATA_DIR / "lora_face_candidates"

# LoRA proof sheets contain subject images and are routed through the vault.
LORA_TESTS = DATA_DIR / "lora_tests"

PRODUCTIONS = DATA_DIR / "productions.json"
PRODUCTION_ASSETS = DATA_DIR / "productions"

# Under src/, not the install root — it is shipped code, not user data, and the router must
# never claim it (test_m6_router::test_the_router_does_not_claim_the_code_...).
WEBUI = _SRC / "webui"

# Reference-clip audio types accepted for a voice. Nomi refs include .mp3, so the
# SillyTavern + Nomi voice pickers list all of these (the Book /voices list is wav-only).
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"}

# Shared MD5 audio cache. Both Nomi /speak AND the SillyTavern streaming path key
# into it (3.0). It's a cache — regenerable and count-evicted — so it lives in the
# OS cache dir (cache_root(), e.g. ~/.cache/vocalis on Linux, %LOCALAPPDATA%\Vocalis
# on Windows), NOT the install root: backups skip it and it's obviously safe to wipe.
# Created lazily on first /speak (request_context mkdirs the shard). No in-code
# migration of a prior on-disk cache — it's throwaway data; a warm copy, if wanted,
# is a one-time manual step.
#
# Resolved at IMPORT, which is why `conftest.py` sets $VOCALIS_CACHE_DIR at conftest import
# rather than in a fixture — an autouse fixture runs far too late to catch this line.
AUDIO_CACHE = cache_root() / "audio_cache"
