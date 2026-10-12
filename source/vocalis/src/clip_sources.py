"""Provide a read-only catalog of scene, Playground, and uploaded audio rows. Rows use (kind, ref) identity and retain each store's own routes and lifecycle. Omit transcript text and incomplete Playground renders; do not write to any source store."""
from pathlib import Path

import playground_clips
import scenes
import speech_sources

# The three kinds, in the order the tab shows them when two rows share a timestamp. Scenes
# first because they are the artifacts this release is about.
SCENE, PLAYGROUND, UPLOAD = "scene", "playground", "upload"
KINDS = (SCENE, PLAYGROUND, UPLOAD)


def _q(ref: str) -> str:
    """Percent-encode a ref for a URL, keeping `/` — a playground ref is `vdir/stem` and the
    route that serves it is a `<path:ref>`, so the slash is structural and must survive."""
    from urllib.parse import quote
    return quote(str(ref), safe="/")


def audio_url(kind: str, ref: str) -> str:
    """Return the existing playback route for a row kind. Each source keeps its own route so Range handling and vault-routed file access remain with the owning store."""
    if kind == SCENE:
        return f"/clips/scenes/{_q(ref)}/audio"
    if kind == PLAYGROUND:
        return f"/playground/clips/{_q(ref)}/audio"
    if kind == UPLOAD:
        return f"/train/sources/{_q(ref)}/audio"
    raise ValueError(f"unknown clip kind {kind!r}")


def _scene_rows(output_dir) -> list:
    out = []
    for s in scenes.list_scenes(scenes.scenes_root(output_dir)):
        out.append({
            "kind": SCENE, "ref": s.get("ref"), "name": s.get("name") or "",
            "duration_s": s.get("duration_s"), "size": s.get("size") or 0,
            "created_ts": s.get("created_ts") or 0.0, "created": s.get("created"),
            "enhanced": bool(s.get("enhanced")),
            # Carry the parent scene reference so the UI can hide Enhance when a twin already exists.
            "raw_ref": s.get("raw_ref"),
            # Keep the owner and entry count to distinguish scenes from the same chat.
            "origin": s.get("owner") or "", "n_entries": s.get("n_entries"),
            # Carry character names for the Clips table and its character filter. An empty list means the source has no character metadata and remains eligible under the unknown filter.
            "characters": list(s.get("characters") or []),
            # Keep avatar filenames aligned with characters; use an empty value when older scenes lack an avatar.
            "character_avatars": list(s.get("character_avatars") or []),
            # Retain the skipped-entry count so the catalog does not make an incomplete scene appear complete.
            "n_skipped": s.get("n_skipped") or 0,
            # Keep the chat name searchable because the filter supports chat names as well as clip names.
            "chat": s.get("chat") or "",
            "audio_url": audio_url(SCENE, s.get("ref")),
        })
    return out


def _playground_rows(output_dir) -> list:
    out = []
    for c in playground_clips.list_clips(Path(output_dir) / "playground"):
        # `voice_label` is the Playground list's cosmetic override and is not computed here —
        # this row shows the voice's filename, which is what identity keys on anyway.
        out.append({
            "kind": PLAYGROUND, "ref": c.get("ref"), "name": c.get("name") or "",
            "duration_s": c.get("duration_s"), "size": c.get("size") or 0,
            "created_ts": c.get("created_ts") or 0.0, "created": c.get("created"),
            "enhanced": bool(c.get("enhanced")),
            "origin": c.get("voice") or "",
            # Playground rows have no character; use an empty list so the row shape stays consistent and the filter treats them as unknown.
            "characters": [],
            "character_avatars": [],
            "audio_url": audio_url(PLAYGROUND, c.get("ref")),
        })
    return out


def _upload_rows(vt_cfg) -> list:
    """The shared speech-material store — `/train/sources`, which the Speech tab calls
    "Speech clips": uploads, Playground imports and stem-split vocals in one place.

    ⚠️ These are the only rows that are NOT necessarily MP3. The store accepts wav/flac/ogg/
    m4a/opus, which is why §7's Join has to probe rather than assume (see `clip_join`).
    """
    out = []
    for s in speech_sources.list_sources(vt_cfg):
        out.append({
            "kind": UPLOAD, "ref": s.get("ref"), "name": s.get("name") or "",
            "duration_s": s.get("duration_s"), "size": s.get("size") or 0,
            "created_ts": s.get("mtime") or 0.0, "created": None,
            # An upload is never an ENHANCED artifact in §7.1's sense. `enhanced` on a source
            # row is a POINTER to a cached enhanced WAV used by training prep — a different
            # thing wearing the same word — and reading it here would put uploads under the
            # "enhanced" filter, which §7.1 built to separate the two takes of a render.
            "enhanced": False,
            "origin": s.get("provenance") or "",
            "characters": [],           # m4i / §9a.3 — an upload has no speaker of ours either
            "character_avatars": [],
            "audio_url": audio_url(UPLOAD, s.get("ref")),
        })
    return out


def list_items(output_dir, vt_cfg=None, *, kinds=None) -> list:
    """Every clip the tab can show, newest first, in one row shape.

    `kinds` filters at the SOURCE rather than in the client, so asking for scenes only does not
    stat the playground tree — the Clips tab opens on every tab switch and two of these three
    listings measure bandwidth and duration on anything new.

    A store that raises is SKIPPED, not fatal: uploads live behind `vt_cfg`, which depends on
    app settings that a fresh install may not have, and one unconfigured store must not take
    the whole tab down with it.
    """
    want = tuple(kinds) if kinds else KINDS
    rows = []
    for kind, fn in ((SCENE, lambda: _scene_rows(output_dir)),
                     (PLAYGROUND, lambda: _playground_rows(output_dir)),
                     (UPLOAD, lambda: _upload_rows(vt_cfg) if vt_cfg is not None else [])):
        if kind not in want:
            continue
        try:
            rows.extend(fn())
        except Exception:                    # noqa: BLE001 — one broken store is not an outage
            # 🔴 `Exception`, NOT `BaseException`, and that is deliberate. `VaultAuthError` is
            # not an Exception (5.0 M1 §1) precisely so it sails past catches like this one, and
            # here that is the behavior we want: a LOCKED vault must reach the app's lock
            # boundary and answer "log in to unlock", not be swallowed into an empty list. A
            # tab that says "no clips yet" when the clips are merely locked is the worse
            # failure — it looks like data loss. Widening this catch would cause exactly that.
            from loguru import logger
            logger.exception(f"clips: could not list {kind}")
    rows.sort(key=lambda r: (r.get("created_ts") or 0.0), reverse=True)
    return rows


def resolve(output_dir, vt_cfg, kind: str, ref: str):
    """`(kind, ref)` → the file on disk, or None. Vault-routed paths, not opened here.

    🔴 Each branch delegates to the store's OWN resolver, because each of them is where the
    traversal check lives: `voicetrain.source_path` refuses anything with a directory part,
    `playground_clips.clip_paths` validates the two-segment ref, and `scenes.scene_paths`
    validates a stem. A resolver written here would be a fourth place to get `../` wrong.
    """
    if kind == SCENE:
        mp3, _y = scenes.scene_paths(scenes.scenes_root(output_dir), str(ref))
        return mp3
    if kind == PLAYGROUND:
        # (None, None) for a malformed or traversal ref — a NON-EMPTY tuple, so it is truthy
        # and a `if not pair` guard would sail straight past it. Unpack instead.
        mp3, _y = playground_clips.clip_paths(Path(output_dir) / "playground", str(ref))
        return mp3
    if kind == UPLOAD:
        if vt_cfg is None:
            return None
        return speech_sources.source_path(vt_cfg, str(ref))
    return None
