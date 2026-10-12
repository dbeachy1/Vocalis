"""Load machine-level settings that must be available before the vault is unlocked.

`app_settings.yaml` is intentionally outside the encrypted vault: startup reads it to locate
storage and services before the vault key is available. Keep secrets in routed settings instead.
Machine settings live under `paths.DATA_DIR`, separate from the immutable code root.
"""
import os
import threading

import yaml
from loguru import logger

from tts_utils import atomic_replace

from vocalis.runtime import paths

APP_SETTINGS = paths.DATA_DIR / "app_settings.yaml"   # machine-level UI prefs (workers/card, …)

#: Serialize the full load→mutate→save transaction at the route boundary. Locking only the write
#: would still allow concurrent requests to overwrite one another's updates.
APP_LOCK = threading.RLock()


def load_app_settings() -> dict:
    if not APP_SETTINGS.exists():
        return {}
    try:
        d = yaml.safe_load(APP_SETTINGS.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        logger.warning("app_settings.yaml unreadable — ignoring")
        return {}


def save_app_settings(s: dict) -> None:
    """Atomic-write app_settings.yaml, 0600. allow_unicode so a ★ in a Kobold config name
    round-trips literally instead of escaping."""
    # Use a per-writer temp path so callers outside the route lock cannot race on one file.
    tmp = APP_SETTINGS.with_suffix(f".yaml.{os.getpid()}.{threading.get_ident()}.part")
    with APP_LOCK:
        tmp.write_text(yaml.safe_dump(s, sort_keys=False, allow_unicode=True), encoding="utf-8")
        atomic_replace(tmp, APP_SETTINGS)
    # Restrict permissions where supported; a chmod failure must not undo the successful write.
    try:
        APP_SETTINGS.chmod(0o600)
    except OSError:
        pass
