"""Resolve shared feature configuration from current application settings.

Each accessor resolves on use so environment variables and edits to
`app_settings.yaml` take effect without restarting. This module groups values read
across feature boundaries, including startup recovery paths; it avoids placing
heavy feature imports in the lightweight settings module."""
from pathlib import Path

import bulk
import cleanup
import enhance
import scratch
import song_library
import speech_sources
import stemsplit
import voxcpm
from book_to_audio import OUTPUT_DIR
from tts_utils import cache_root

from vocalis.runtime import paths
from vocalis.runtime import settings


def scratch_root() -> Path:
    """Resolve the configured writable scratch directory on each use."""
    return scratch.scratch_root(settings.load_app_settings())


def enhance_cfg() -> enhance.EnhanceConfig:
    """Resolved fresh per use — app_settings.yaml edits apply live, env always wins."""
    return enhance.resolve_config(settings.load_app_settings(), paths.BASE_DIR)


def voxcpm_cfg() -> voxcpm.VoxcpmConfig:
    """Resolved fresh per use — app_settings.yaml edits apply live, env always wins."""
    return voxcpm.resolve_config(settings.load_app_settings(), paths.BASE_DIR)


# Shared configuration accessors used by routes in more than one feature domain.

def song_cfg() -> song_library.SongConfig:
    """Resolve the retained song shelf paths from the shared app settings."""
    return song_library.resolve_config(settings.load_app_settings(), paths.DATA_DIR,
                                       cache_root())


def ss_cfg() -> stemsplit.StemConfig:
    return stemsplit.resolve_config(settings.load_app_settings(), paths.BASE_DIR,
                                    OUTPUT_DIR, cache_root(), data_dir=paths.DATA_DIR)


def bulk_cfg() -> bulk.BulkConfig:
    """Configuration for bulk processing and startup recovery."""
    return bulk.resolve_config(settings.load_app_settings(), paths.BASE_DIR)


def speech_cfg() -> speech_sources.SpeechConfig:
    """Resolve the shared Speech clip store used by source preparation and Cleanup."""
    values = settings.load_app_settings()
    voice_settings = (values or {}).get("voiceswap") or {}
    import os
    from pathlib import Path
    root = Path(paths.DATA_DIR)
    training_dir = Path(os.environ.get("VOCALIS_TRAINING_DIR")
                        or voice_settings.get("training_dir")
                        or root / "voice_training")
    return speech_sources.SpeechConfig(training_dir=training_dir)


def cleanup_cfg() -> cleanup.CleanupConfig:
    """Cleanup configuration used by cleanup, bulk, and voice-design workflows."""
    return cleanup.resolve_config(settings.load_app_settings(), paths.BASE_DIR)
