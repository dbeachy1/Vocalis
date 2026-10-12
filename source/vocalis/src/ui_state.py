"""Store account-level UI state as a flat string-to-string mapping in the vault-routed ui_state.yaml file. Keep device-only theme and volume preferences in the browser. Sanitize state at the single server-side read/write boundary and route all filesystem access through vault_fs."""
from __future__ import annotations

import threading
from pathlib import Path

from loguru import logger

# Theme and volume stay in localStorage; the sanitizer drops them from server posts.
# ui-font must be available before first paint, so localStorage keeps a bootstrap cache. App settings remains authoritative and refreshes it after load.
CLIENT_ONLY = frozenset({"vocalis-theme", "vocalis-vol", "vocalis-ui-font"})

# The 19 account-local keys, for documentation and for the tests. The sanitizer does NOT hard-code
# this list — it accepts any `vocalis-*` key that is not device-local — so a key added in a later
# milestone persists without a second edit here, while theme/vol still can't leak in. (An unknown
# key merely persists; it does not leak, so the strict-allow-list discipline the ROUTER needs is
# not needed here.)
ACCOUNT_KEYS = frozenset({
    "vocalis-tab", "vocalis-bktab", "vocalis-vstab",          # tabs / sub-tabs
    # Keep these tab selections in account state so they survive refresh and follow the account across browsers.
    "vocalis-sttab", "vocalis-blkmode",
    "vocalis-pg-text",                                        # the prose — the point of M8
    "vocalis-pg-voice", "vocalis-book-voice", "vocalis-book-select",
    "vocalis-vs-song", "vocalis-vs-voice", "vocalis-ss-song",
    "vocalis-vt-src", "vocalis-vt-sel",                       # selections (vt-sel is a JSON array)
    # Keep the selected KoboldCpp config in account state so it follows the account across browsers and takes precedence over the server default.
    "vocalis-kob-cfg",
    "vocalis-pg-enh", "vocalis-book-enh", "vocalis-pg-actions", "vocalis-pg-cap",  # toggles
})

# A sane ceiling on the whole blob. The only genuinely large value is the Playground prose, and a
# render caps well below this; the limit exists so a stale or hostile client can't stuff the vault
# file with megabytes. Values over it are truncated, not rejected — losing the tail of your prose
# beats a 400 that drops the save entirely.
_MAX_VALUE_LEN = 256 * 1024


def load(path) -> dict:
    """The stored blob ({key: str}), or {} if there is no file yet or it won't parse.

    Non-strict on purpose, exactly like `voice_utils._load_all`: a parse error on a CONVENIENCE
    store degrades to defaults rather than breaking the page. But `VaultAuthError` is a
    `BaseException` and sails straight through the `except Exception` — a wrong key is not a
    corrupt file, and this milestone's rule is that it stops loudly rather than being swallowed.
    """
    import yaml

    import vault_fs
    p = Path(path)
    if not vault_fs.exists(p):
        return {}
    try:
        data = yaml.safe_load(vault_fs.read_text(p))
    except Exception:                                    # noqa: BLE001 — VaultAuthError is NOT caught
        logger.warning(f"ui_state unreadable, starting from defaults: {p}")
        return {}
    if not isinstance(data, dict):
        return {}
    # Coerce to the flat str→str shape the browser expects back, dropping anything malformed.
    return {str(k): str(v) for k, v in data.items() if v is not None}


def sanitize(data) -> dict:
    """The write filter: keep only account-local `vocalis-*` keys, as bounded strings.

    Drops the device-local theme/vol (defense in depth for the ship gate), anything without the
    `vocalis-` prefix, and null values. This is what stands between "the browser POSTed something"
    and "we wrote it into the encrypted store".
    """
    if not isinstance(data, dict):
        return {}
    clean = {}
    for k, v in data.items():
        k = str(k)
        if not k.startswith("vocalis-") or k in CLIENT_ONLY or v is None:
            continue
        clean[k] = str(v)[:_MAX_VALUE_LEN]
    return clean


#: One writer at a time. Two tabs flushing deltas concurrently is the NORMAL case after a
#: service bounce (every open window reloads and flushes), and load-merge-write without a lock
#: would drop one tab's keys exactly then — the moment this store exists to survive.
_WRITE_LOCK = threading.Lock()


def save(path, data) -> dict:
    """Sanitize and persist the full legacy state blob using PUT semantics, returning the stored value. Route the write through vault_fs. New callers should use apply_delta so updates from one tab do not erase newer keys from another."""
    import vault_fs
    clean = sanitize(data)
    with _WRITE_LOCK:
        vault_fs.write_yaml_atomic(Path(path), clean, sort_keys=True)
    return clean


def apply_delta(path, set_map, del_list) -> dict:
    """Merge one tab's CHANGED keys into the stored blob: set `set_map` (sanitized exactly like
    a PUT), drop `del_list`. Returns the merged blob. This is what makes two open windows safe:
    each flushes only what it touched, so neither can revert the other's picks."""
    import vault_fs
    with _WRITE_LOCK:
        cur = load(path)
        cur.update(sanitize(set_map))
        for k in del_list:
            cur.pop(str(k), None)
        vault_fs.write_yaml_atomic(Path(path), cur, sort_keys=True)
    return cur
