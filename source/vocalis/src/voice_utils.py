#!/usr/bin/env python3
"""Ingest voice samples as normalized WAV files and own the shared voice_settings.yaml layout. Keep per-tab parameters in their own sections, use context defaults for missing values, and never fall back to another tab or a voice-level default. Route settings and sample access through the vault-aware store."""
import re
import subprocess
import threading
from pathlib import Path

import yaml
from loguru import logger

from tts_utils import atomic_replace

TARGET_DBFS = -1.0

# Serializes the whole read-modify-write of voice_settings.yaml — EVERY writer
# (the /voices settings PUTs, PUT /nomi, the ST registry) must funnel through
# this module so two concurrent saves can't lose an update or collide on the
# temp file. Reentrant because save_settings holds it AND calls
# save_context_settings.
_SETTINGS_LOCK = threading.RLock()


class SettingsUnreadable(Exception):
    """voice_settings.yaml exists but can't be parsed. Writers must ABORT on this,
    never persist from an empty map — doing so would wipe every tab's settings."""


def _max_volume_db(src) -> float:
    """Peak level (dBFS, <= 0) of an audio file via ffmpeg volumedetect, or None."""
    r = subprocess.run(["ffmpeg", "-i", str(src), "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", r.stderr)
    return float(m.group(1)) if m else None


def peak_dbfs(path) -> float:
    """Peak level of a stored clip, for the number the UI shows after a save.

    🔴 THROUGH `child_input`. `_max_volume_db` shells out to ffmpeg, and ffmpeg has no DEK: on
    an encrypted `voice_samples/` it is handed a plaintext path that does not exist, prints its
    error to stderr, and the regex below simply fails to match — so this returns None and the
    save reports `peak_dbfs: null` with no error anywhere. `transcode_normalize` calls
    `_max_volume_db` DIRECTLY and must keep doing so: it has already decrypted its input, and
    routing here as well would decrypt the same clip twice per upload."""
    import scratch as scratch_mod
    import vault_fs
    with vault_fs.child_input(path, scratch_mod.scratch_root()) as plain:
        return _max_volume_db(plain)


def transcode_normalize(src, dst, target_dbfs: float = TARGET_DBFS) -> Path:
    """Decode `src` (any format), peak-normalize to target_dbfs, write `dst` as
    16-bit PCM WAV. Lossless normalize (gain only). Raises on ffmpeg failure.

    🔴 M6 — THIS IS VOICE INGEST, and `dst` is `voice_samples/<name>.wav`: the reference clip
    of the user's own voice, which is the single most sensitive file this application holds.
    ffmpeg wrote it directly. An unrouted write here is not one leaked clip — it is every voice
    the user ever adds, in cleartext, in the store, forever, while everything works perfectly.

    ffmpeg goes to the scratch and `from_scratch` brings the bytes back through the cipher.
    `_max_volume_db(src)` is a second ffmpeg pass over `src`, so the decrypt is hoisted to cover
    both — src is normally already scratch (M3 put the raw upload there), in which case
    `child_input` copies nothing.

    Promote-on-success is preserved and still matters: a truncated or corrupt upload OVER AN
    EXISTING VOICE must not destroy the live reference clip. The `.part` temp used to do that
    job here; now the scratch does, and the atomic landing at `dst` is the vault's."""
    import scratch as scratch_mod
    import vault_fs

    dst = Path(dst)
    root = scratch_mod.scratch_root()
    with vault_fs.child_input(src, root) as plain_src:
        peak = _max_volume_db(plain_src)
        af = f"volume={target_dbfs - peak:.2f}dB" if peak is not None else "anull"
        with scratch_mod.file(root, f"normalize|{dst}", ".wav") as tmp:
            r = subprocess.run(
                # -f wav: force the container — ffmpeg's extension-based format inference is
                # defeated by the opaque scratch name, exactly as it was by the old `.part`.
                ["ffmpeg", "-y", "-i", str(plain_src), "-af", af, "-c:a", "pcm_s16le",
                 "-f", "wav", str(tmp), "-loglevel", "error"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            if r.returncode != 0:
                # Include the return code because ffmpeg can exit without stderr, such as when it is killed under load. Negative POSIX codes identify signal termination; on Windows they are exit statuses.
                # This distinguishes an invalid input from a process failure. Stderr may name the opaque scratch path, never the source filename or content.
                detail = r.stderr.strip() or "(no stderr — killed, or never started)"
                raise RuntimeError(f"ffmpeg normalize failed (exit {r.returncode}): {detail}")
            vault_fs.from_scratch(tmp, dst)
    return dst


# ── the tab-keyed settings store ───────────────────────────────────────────────

# The voice-keyed tab sections the /voices/<name>/settings?context= wire accepts.
# nomi/sillytavern are NOT contexts: they're entity-keyed sections with their own
# admin surfaces (PUT /nomi, PUT /st/characters).
CONTEXTS = ("book", "playground")

# `kobold` is not a voice tab — it is here because this file is ROUTED and app_settings.yaml
# is not. The KoboldCpp admin password is a SECRET, and app_settings.yaml is deliberately
# exempt from the vault (it must be readable while locked), so a password living there sits in
# plaintext on disk forever. The 4.7 exemption was justified as "no user content"; that went
# stale the moment the password moved in. It cannot be encrypted where it is — so it moves
# HERE, and is read after unlock like every other secret. See kobold.resolve_config.
# 🔴 AN ALLOWLIST, AND `get_section`/`replace_section` RAISE ValueError ON ANYTHING ELSE
# (:201, :213). A caller that stores a new kind of secret has to be added HERE or its read
# explodes at runtime rather than returning {} — and the callers deliberately do NOT catch
# ValueError, because an unknown section name is a bug in the CALL, not a missing value.
# 9.5: "llama" holds llama.cpp's optional `api_key`. It goes in the ROUTED (encrypted) settings
# file for the same reason Kobold's adminpassword does — a secret readable while the vault is
# locked is a secret sitting in plaintext, which is what 5.0 exists to stop.
# 11.1: "openrouter" and "featherless" hold the LLM ▸ API keys, for the same reason. Without these
# two entries the FIRST read of a stored key raises ValueError — after the key has been saved —
# which is the exact defect 9.5-m1 caught for "llama" before it shipped.
SECTIONS = ("global", "book", "playground", "nomi", "sillytavern", "kobold", "wbedit", "llama",
            "openrouter", "featherless")

CONTEXT_DEFAULTS = {
    "exaggeration": 0.5,
    "cfg": 0.5,
    "temperature": 0.8,
}

DEFAULT_ADVANCED = {"min_p": 0.05, "top_p": 1.0, "top_k": 1000, "repetition_penalty": 1.2}

# The /voices/<name>/settings wire contract; kept for the flat-view shims below.
DEFAULT_SETTINGS = {
    "exaggeration": 0.5,
    "cfg": 0.5,
    "temperature": 0.8,
    "advanced": dict(DEFAULT_ADVANCED),
}


def _load_all(settings_path, *, strict: bool = False) -> dict:
    """Load the whole settings map ({section: {key: entry}}). strict=True (the
    WRITE paths) raises SettingsUnreadable on a corrupt/unparseable file instead
    of returning {}: returning empty for a READ is fine (callers fall back to
    defaults), but using it as the base for a WRITE persists the empty map back
    and wipes every tab.

    🔴 And a wrong key is not a corrupt file: VaultAuthError is a BaseException and passes
    straight through the `except Exception` below, rather than degrading to {} — which on a
    WRITE path would persist the empty map and wipe every tab of every voice."""
    import vault_fs
    p = Path(settings_path)
    if not vault_fs.exists(p):
        return {}
    try:
        data = yaml.safe_load(vault_fs.read_text(p))
    except Exception as exc:                                  # noqa: BLE001
        logger.exception(f"voice settings unreadable: {p}")
        if strict:
            raise SettingsUnreadable(str(exc)) from exc
        return {}
    if data is None:
        return {}                                             # empty file — no settings yet
    if not isinstance(data, dict):
        if strict:
            raise SettingsUnreadable(f"voice_settings.yaml is not a mapping "
                                     f"({type(data).__name__})")
        return {}
    return data


def _save_all(settings_path, all_: dict):
    """voice_settings.yaml is USER CONTENT — per-voice knobs, Nomi IDs, ST CHARACTER NAMES —
    and it is registered in the router's allow-list (vault_store.ROUTES["install"]["files"]).
    Its NAME may stay in the clear: it is a constant, and the sweep confirmed character names
    appear only INSIDE it, never in a filename (sweep/voices_st.md:195)."""
    import vault_fs
    vault_fs.write_yaml_atomic(Path(settings_path), all_)


def get_section(settings_path, section: str) -> dict:
    """Copy of one tab section ({} if absent/corrupt — read paths default)."""
    if section not in SECTIONS:
        raise ValueError(f"unknown settings section: {section!r}")
    sec = _load_all(settings_path).get(section)
    if not isinstance(sec, dict):
        return {}
    return {k: (dict(v) if isinstance(v, dict) else v) for k, v in sec.items()}


def replace_section(settings_path, section: str, mapping: dict):
    """Replace one tab section wholesale (PUT semantics for the entity-keyed
    tabs). Strict load: raises SettingsUnreadable on a corrupt file instead of
    rebuilding it from just this section."""
    if section not in SECTIONS:
        raise ValueError(f"unknown settings section: {section!r}")
    with _SETTINGS_LOCK:
        all_ = _load_all(settings_path, strict=True)
        all_[section] = mapping
        _save_all(settings_path, all_)


def add_section_entry(settings_path, section: str, key: str, entry: dict) -> bool:
    """Idempotently add ONE entry (`key` -> `entry`) to a section if that key is
    absent; an existing key is left completely untouched. Returns True iff a new
    entry was written.

    Unlike replace_section, the read-modify-write here is entirely inside
    _SETTINGS_LOCK, so a concurrent PUT (replace_section, also under the lock)
    can't be lost: the two serialize. Strict load — the same wipe-guard the other
    writers have: a corrupt voice_settings.yaml raises SettingsUnreadable rather
    than being rebuilt from this one entry. This is the auto-create primitive for
    the Nomi map (NomiSpeaker.register_unknown) and the ST analog's upsert."""
    if section not in SECTIONS:
        raise ValueError(f"unknown settings section: {section!r}")
    with _SETTINGS_LOCK:
        all_ = _load_all(settings_path, strict=True)
        sec = all_.get(section)
        if not isinstance(sec, dict):
            sec = {}
        if key in sec:
            return False
        sec[key] = entry
        all_[section] = sec
        _save_all(settings_path, all_)
    return True


def get_labels(settings_path) -> dict:
    """{voice_filename: cosmetic display label} for every voice that has one
    (the `global` section). Labels are UI-only: every association (settings,
    Nomi map, book sidecars, clips) keys on the immutable FILENAME — renaming
    a label breaks nothing."""
    out = {}
    for name, entry in get_section(settings_path, "global").items():
        if isinstance(entry, dict) and entry.get("label"):
            out[name] = str(entry["label"])
    return out


def get_context_section(settings_path, voice_name: str, context: str):
    """The voice's RAW stored entry in the `context` tab section, or None if
    unset — callers that need set-vs-unset can't use a defaults-merged view."""
    if context not in CONTEXTS:
        raise ValueError(f"unknown settings context: {context!r}")
    entry = get_section(settings_path, context).get(voice_name)
    return dict(entry) if isinstance(entry, dict) else None


def get_context_settings(settings_path, voice_name: str, context: str) -> dict:
    """The voice's settings for `context`, defaults-merged (no entry -> pure
    CONTEXT_DEFAULTS — the no-fallback rule). Unknown keys in the YAML (e.g. the
    pre-3.x `seed:`) are ignored, so stale files read clean without a converter."""
    merged = dict(CONTEXT_DEFAULTS)
    sec = get_context_section(settings_path, voice_name, context)
    if sec:
        merged.update({k: v for k, v in sec.items() if k in CONTEXT_DEFAULTS})
    return merged


def save_context_settings(settings_path, voice_name: str, context: str, settings: dict) -> dict:
    """Merge + persist the voice's entry in the `context` tab section; returns
    the stored entry. Only CONTEXT_DEFAULTS keys are stored (typed); unknown
    keys are dropped."""
    if context not in CONTEXTS:
        raise ValueError(f"unknown settings context: {context!r}")
    with _SETTINGS_LOCK:
        all_ = _load_all(settings_path, strict=True)
        sec = all_.get(context) if isinstance(all_.get(context), dict) else {}
        cur = dict(sec.get(voice_name)) if isinstance(sec.get(voice_name), dict) else {}
        # Drop keys the schema no longer knows (pre-3.x `seed:`) — stale keys are
        # ignored on read and disappear on the entry's next write. No converter.
        cur = {k: v for k, v in cur.items() if k in CONTEXT_DEFAULTS}
        for k, d in CONTEXT_DEFAULTS.items():
            if k in settings and settings[k] is not None:
                cur[k] = bool(settings[k]) if isinstance(d, bool) else type(d)(settings[k])
        sec[voice_name] = cur
        all_[context] = sec
        _save_all(settings_path, all_)
    return cur


# ── flat-shape shims: the /voices/<name>/settings wire contract ────────────────
# The web UI reads/writes {exaggeration, cfg, temperature, advanced}; these views
# translate that onto one tab section plus the `global` section (label/advanced)
# so the panels keep working unchanged. (engine/turbo left the wire in 3.x; an
# incoming `engine` key from a stale client is simply ignored.)

def set_label(settings_path, voice_name: str, label: str) -> None:
    """Set or clear one voice display label while changing only the global section. An empty label removes the entry so the filename becomes the display fallback."""
    label = str(label or "").strip()
    with _SETTINGS_LOCK:
        all_ = _load_all(settings_path, strict=True)
        gsec = all_.get("global") if isinstance(all_.get("global"), dict) else {}
        entry = gsec.get(voice_name) if isinstance(gsec.get(voice_name), dict) else {}
        if label:
            entry["label"] = label
        else:
            entry.pop("label", None)
        if entry:
            gsec[voice_name] = entry
        else:
            gsec.pop(voice_name, None)          # nothing left worth an entry
        all_["global"] = gsec
        _save_all(settings_path, all_)


def get_settings(settings_path, voice_name: str, context: str = "book") -> dict:
    """Flat view of one tab section's entry (wire shape)."""
    s = get_context_settings(settings_path, voice_name, context)
    g = get_section(settings_path, "global").get(voice_name)
    advanced = g.get("advanced") if isinstance(g, dict) else None
    return {"exaggeration": s["exaggeration"], "cfg": s["cfg"],
            "temperature": s["temperature"],
            "advanced": advanced if isinstance(advanced, dict) else dict(DEFAULT_ADVANCED)}


def save_settings(settings_path, voice_name: str, settings: dict, context: str = "book") -> dict:
    """Persist a flat-shaped payload into one tab section (`advanced` and `label`,
    if sent, store in the `global` section — the label is the Voices-tab cosmetic
    rename, empty string = back to the filename). Returns the flat view."""
    sec = {k: settings[k] for k in ("exaggeration", "cfg", "temperature")
           if k in settings}
    with _SETTINGS_LOCK:                          # hold across BOTH cycles (context + global)
        save_context_settings(settings_path, voice_name, context, sec)   # re-enters the RLock
        top = {}
        if isinstance(settings.get("advanced"), dict):
            top["advanced"] = settings["advanced"]
        if "label" in settings:
            top["label"] = str(settings["label"] or "").strip()
        if top:
            all_ = _load_all(settings_path, strict=True)
            gsec = all_.get("global") if isinstance(all_.get("global"), dict) else {}
            entry = gsec.get(voice_name) if isinstance(gsec.get(voice_name), dict) else {}
            entry.update(top)
            if not entry.get("label"):
                entry.pop("label", None)         # empty = remove the cosmetic label
            gsec[voice_name] = entry
            all_["global"] = gsec
            _save_all(settings_path, all_)
    return get_settings(settings_path, voice_name, context)
