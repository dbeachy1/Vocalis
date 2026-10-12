#!/usr/bin/env python3
"""Persist Playground renders with a sidecar containing the text and generation parameters. Derive identity from those inputs without a seed, atomically replace the matching take, and resume interrupted chunk work from its manifest. Ignore legacy seed fields when reading older sidecars."""
import datetime
import hashlib
import re
from pathlib import Path

import yaml
from loguru import logger

import enhance
import vault_fs
from book_to_audio import safe_name

PENDING_NAME = "pending.yaml"
_REF_RE = re.compile(r"[^/\\]+/[^/\\]+\Z")     # exactly "<voice-dir>/<stem>", no traversal
# A stem ends in '<H8>', optionally preceded by the '_enhanced' marker. The H8 is the
# LAST token in both shapes, because find_ref_by_hash globs on it and rename_clip
# anchors on it — put the marker after the hash and both of those break silently.
_STEM_RE = re.compile(r"_(enhanced_)?([0-9a-f]{8})\Z")


def _now() -> str:
    return datetime.datetime.now().replace(microsecond=0).isoformat()


def clip_hash(voice: str, exaggeration: float, cfg: float, temperature: float,
              text: str, narrate_actions: bool = True,
              enhanced: bool = False, nfe=None) -> str:
    """Return a stable identity over text, voice, generation settings, narration mode, and enhancement settings. Unenhanced audio retains its existing identity; include enhancement parameters only when enhancement is enabled. Seed and engine version are not part of the identity."""
    key = (f"{voice}|{exaggeration:.6g}|{cfg:.6g}|{temperature:.6g}|"
           f"{int(bool(narrate_actions))}|{text}")
    if enhanced:
        key += f"|enh={int(nfe or enhance.NFE_DEFAULT)}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def clip_stem(text: str, h: str, enhanced: bool = False) -> str:
    """'<first-words>[_enhanced]_<H8>' — human-scannable and unique. Only the head of the
    text feeds safe_name (the tail can be 100k+ chars)."""
    return stem_for(safe_name(text[:120], 30), h, enhanced)


def stem_for(words: str, h: str, enhanced: bool = False) -> str:
    """The one stem shape. `_enhanced` sits BEFORE the hash so the H8 stays terminal
    (_STEM_RE, find_ref_by_hash)."""
    return f"{words}{'_enhanced' if enhanced else ''}_{h[:8]}"


def clip_paths(root, ref: str):
    """(mp3, yaml) paths for a clip ref ('<voice-dir>/<stem>'), or (None, None) for a
    malformed/traversal ref. The shape check + containment check both guard."""
    root = Path(root)
    if not _REF_RE.fullmatch(ref or ""):
        return None, None
    p = (root / ref).resolve()
    if root.resolve() not in p.parents:
        return None, None
    return p.with_suffix(".mp3"), p.with_suffix(".yaml")


def write_clip_yaml(yaml_path: Path, meta: dict) -> dict:
    """Persist a clip's sidecar (adds `created` if absent). Atomic like every other
    on-disk record in the app — and atomic INSIDE the vault too: vault.open_write() writes
    <dest>.part and atomically replaces on close, through the same tts_utils.atomic_replace
    that retries the Windows sharing violation a UI poller causes."""
    meta = dict(meta)
    meta.setdefault("created", _now())
    vault_fs.write_yaml_atomic(yaml_path, meta)
    return meta


class ClipSidecarUnreadable(Exception):
    """A clip sidecar / pending manifest exists but can't be parsed. Writers must ABORT
    on this, never persist from an empty map.

    The sidecar is the ONLY record of a clip's text, voice and knobs — the render
    workspace is rmtree'd once the clip lands (vocalis_server.py:1499). So a writer that
    starts from `{}` on an unreadable file and saves doesn't degrade, it DESTROYS: one
    star click used to leave `{"favorite": true}` and nothing else.

    Same shape, same reason as voice_utils.SettingsUnreadable."""


def _read_yaml(p: Path, *, strict: bool = False):
    """Read a clip sidecar. In strict mode, raise ClipSidecarUnreadable on corruption so write paths cannot replace existing metadata with an empty mapping. An absent sidecar returns None. Vault authentication failures propagate unchanged."""
    if not vault_fs.exists(p):
        return None
    try:
        d = yaml.safe_load(vault_fs.read_text(p))
    except Exception as exc:                                  # noqa: BLE001
        # NOT {p}: a clip's stem is safe_name(the user's prompt) — the sidecar's PATH is
        # the words. logs/vocalis.log sits outside the vault.
        logger.exception("clip sidecar unreadable")
        if strict:
            raise ClipSidecarUnreadable(str(exc)) from exc
        return None
    if not isinstance(d, dict):
        if strict:
            raise ClipSidecarUnreadable(f"{p.name} is not a mapping ({type(d).__name__})")
        return None
    return d


def list_clips(root) -> list:
    """Return stored MP3 and YAML pairs with metadata for the library. Use cached bandwidth measurements to classify clips without decoding unchanged files; measure frequency content rather than relying on the enhanced flag."""
    root = Path(root)
    out = []
    for vdir_name in vault_fs.listdir(root):
        vdir = root / vdir_name
        if not vault_fs.is_dir(vdir):
            continue
        for yname in sorted(vault_fs.glob(vdir, "*.yaml")):
            y = vdir / yname
            mp3 = y.with_suffix(".mp3")
            if not vault_fs.exists(mp3):
                continue                       # half-written / half-deleted pair — not a clip
            # Only persist refreshed bandwidth metadata when the existing sidecar was readable. Listing may still compute a value for display when parsing fails, but must not overwrite metadata it could not read.
            # A missing sidecar is different from a malformed one: a new clip has no existing metadata to preserve and may receive the new measurement.
            try:
                meta = _read_yaml(y, strict=True) or {}
                readable = True
            except ClipSidecarUnreadable:
                meta, readable = {}, False
            # 🔴 NOT mp3.stat(). Inside the vault that is the CIPHERTEXT size, and the library
            # panel would report it to the user as the size of their clip — every clip in the
            # library wrong by the header plus 16 bytes a block, forever, and nothing failing.
            # vault_fs.stat is the LOGICAL stat: the plaintext size, derived in O(1).
            st = vault_fs.stat(mp3)
            if st is None:
                continue                       # deleted under us, mid-listing
            stem = mp3.stem
            hz, fresh = enhance.bandwidth_of(mp3, meta)
            if fresh and readable:             # measured just now — remember it
                meta.update(fresh)
                write_clip_yaml(y, meta)
            out.append({
                "ref": f"{vdir.name}/{stem}",
                # The sidecar's exact user-set name wins; else derive from the stem
                # (dropping the identity suffix, and the `_enhanced` marker with it —
                # the pill already says that, so the name needn't).
                "name": str(meta.get("name") or _STEM_RE.sub("", stem).replace("_", " ")),
                # The actual file on disk. The display name is the user's — renamed,
                # de-suffixed, and nothing like the filename — so there is otherwise no way
                # to see what a clip is really called or what format it is in.
                "file": mp3.name,
                "format": "mp3",
                "favorite": bool(meta.get("favorite")),
                "voice": meta.get("voice", ""),
                "voice_label": vdir.name,
                "exaggeration": meta.get("exaggeration"),
                "cfg": meta.get("cfg"),
                "temperature": meta.get("temperature"),
                "narrate_actions": bool(meta.get("narrate_actions", True)),
                "enhanced": bool(meta.get("enhanced")),
                "nfe": meta.get("nfe"),
                "bandwidth_hz": hz,
                "band_limited": enhance.is_band_limited(hz),
                "text": meta.get("text", ""),
                "created": meta.get("created"),
                "created_ts": st.mtime,
                "duration_s": meta.get("duration_s"),
                "size": st.size,
            })
    return out


def find_ref_by_hash(root, vdir_name: str, h: str):
    """Return the existing ref for a clip identity in a voice directory, or None. Match the hash suffix so renamed clips remain addressable. Use vault-aware logical directory listings so the lookup works with encrypted filenames."""
    d = Path(root) / vdir_name
    if not vault_fs.is_dir(d):
        return None
    for name in sorted(vault_fs.glob(d, f"*_{h[:8]}.mp3")):
        return f"{vdir_name}/{Path(name).stem}"
    return None


def rename_clip(root, ref: str, new_name: str):
    """Rename a clip's display name: both files move to '<safe(new_name)>_<H8>'
    in the same voice dir. The H8 identity suffix is PRESERVED, so a re-render of
    the same inputs still overwrites this clip (find_ref_by_hash). Returns the new
    ref; None if the clip doesn't exist; raises ValueError on an empty/unusable
    name or a name collision."""
    root = Path(root)
    mp3, y = clip_paths(root, ref)
    if mp3 is None or not vault_fs.exists(mp3):
        return None
    m = _STEM_RE.search(mp3.stem)
    if not m:
        raise ValueError("clip has no identity suffix — cannot rename safely")
    words = safe_name(new_name, 30)
    if not words or words == "section":            # safe_name's empty fallback
        raise ValueError("that name has no usable characters")
    # Carry the `_enhanced` marker across the rename. It is not decoration: it is how you
    # tell two clips of the same text apart in a flat library, and dropping it here would
    # quietly erase that the moment anyone tidied up a name.
    new_stem = stem_for(words, m.group(2), bool(m.group(1)))
    if new_stem == mp3.stem:
        return ref                                 # no-op rename
    new_mp3 = mp3.with_name(new_stem + ".mp3")
    if vault_fs.exists(new_mp3):
        raise ValueError("a clip with that name already exists for this voice")
    # A vault rename re-encrypts the NAME (SIV over the new logical name, bound to its parent)
    # and moves nothing else — the content key is unchanged, so not a byte of audio is rewritten.
    vault_fs.rename(mp3, new_mp3)
    new_y = y.with_name(new_stem + ".yaml")
    if vault_fs.exists(y):
        vault_fs.rename(y, new_y)
    # Store the EXACT name in the sidecar — the display name. The file stem goes
    # through safe_name (filesystem rules), which loses leading underscores,
    # punctuation, etc.; the sidecar keeps what the user actually typed.
    meta = _read_yaml(new_y, strict=True) or {}
    meta["name"] = new_name
    write_clip_yaml(new_y, meta)
    return f"{mp3.parent.name}/{new_stem}"


def delete_clips(root, refs: list) -> list:
    """Delete clips (mp3 + yaml each); prune a voice dir once emptied. Returns the
    refs actually removed — unknown/malformed refs are skipped, not errors."""
    root = Path(root)
    deleted = []
    for ref in refs:
        mp3, y = clip_paths(root, str(ref))
        if mp3 is None:
            continue
        existed = vault_fs.exists(mp3) or vault_fs.exists(y)
        vault_fs.unlink(mp3, missing_ok=True)
        vault_fs.unlink(y, missing_ok=True)
        if existed:
            deleted.append(str(ref))
        vault_fs.rmdir_if_empty(mp3.parent)
    return deleted


def encode_mp3(wav_path, mp3_path, bitrate: str = enhance.MP3_BITRATE_PLAIN) -> Path:
    """Encode a mono WAV to MP3 at the requested bitrate using an explicit target. Use scratch paths for child-process input and output when sources are vault-routed, then copy completed bytes back through the vault-aware writer. Preserve atomic replacement so an interrupted encode cannot replace a valid clip with a partial file."""
    import subprocess

    import scratch as scratch_mod

    mp3_path = Path(mp3_path)
    root = scratch_mod.scratch_root()
    with vault_fs.child_input(wav_path, root) as src, \
            scratch_mod.file(root, f"encode_mp3|{mp3_path}", ".mp3") as tmp:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-b:a", str(bitrate),
             "-f", "mp3", str(tmp), "-loglevel", "error"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg encode failed: {r.stderr.strip()}")
        vault_fs.from_scratch(tmp, mp3_path)
    return mp3_path


# ── chunk workspace (resume across cancel/crash, DESIGN_2.3 §2.1) ─────────────

def workspace(chunks_root, h: str) -> Path:
    return Path(chunks_root) / "playground" / h


def write_pending(ws: Path, meta: dict):
    """Manifest of what's rendering into this workspace — lets a later request
    with the same inputs recognize and resume it instead of starting over.
    Preserves keys already in the manifest that the caller doesn't send (the
    user-set `name` from rename_partial survives a resume's manifest rewrite)."""
    dest = Path(ws) / PENDING_NAME
    merged = _read_yaml(dest, strict=True) or {}
    merged.update(meta)
    # Write the manifest atomically so an interrupted update cannot leave a truncated record.
    # The pending manifest retains the full source text so a canceled render can resume. It contains user content; do not delete it solely because a cache sentinel is absent.
    vault_fs.write_yaml_atomic(dest, merged)


def read_pending(ws):
    """The workspace's pending.yaml manifest as a dict, or None."""
    return _read_yaml(Path(ws) / PENDING_NAME)     # _read_yaml already answers ABSENT with None


def set_clip_favorite(root, ref: str, fav: bool):
    """Toggle a clip's favorite flag (sidecar field). Returns the stored bool, or
    None for an unknown/malformed ref."""
    mp3, y = clip_paths(root, ref)
    if mp3 is None or not vault_fs.exists(mp3):
        return None
    meta = _read_yaml(y, strict=True) or {}
    meta["favorite"] = bool(fav)
    write_clip_yaml(y, meta)
    return bool(fav)


def set_partial_favorite(chunks_root, h: str, fav: bool):
    """Toggle a partial render's favorite flag (manifest field — carried into the
    finished clip's sidecar on completion). Returns the stored bool, or None for
    an unknown workspace."""
    if not re.fullmatch(r"[0-9a-f]{12}", str(h)):
        return None
    ws = workspace(chunks_root, h)
    if read_pending(ws) is None:
        return None
    write_pending(ws, {"favorite": bool(fav)})     # merge-write keeps the rest
    return bool(fav)


def rename_partial(chunks_root, h: str, new_name: str):
    """Set a partial render's display name (stored in its pending.yaml). It shows
    in the library row AND becomes the finished clip's stem when the render
    completes (_clip_ref_for reads it). Returns the stored name; None if there is
    no such workspace/manifest; raises ValueError on an unusable name."""
    if not re.fullmatch(r"[0-9a-f]{12}", str(h)):
        return None
    ws = workspace(chunks_root, h)
    m = read_pending(ws)
    if m is None:
        return None
    new_name = str(new_name or "").strip()
    if not new_name or safe_name(new_name, 30) in ("", "section"):
        raise ValueError("that name has no usable characters")
    m["name"] = new_name
    write_pending(ws, m)
    return new_name


def chunk_seconds(ws, i: int) -> float:
    """One banked chunk's duration, from its HEADER (no decode). The 60-minute cap counts in
    seconds of audio, and seconds of audio is not something you can infer from a chunk count:
    chunks vary from a clause to 400 characters.

    Through `wav_frames_sr` rather than a bare `sf.info(path)`, because that is the seam that
    already routes — and it stays O(1) in the vault: open_read() hands soundfile a SEEKABLE
    reader that decrypts only the blocks a read touches, so a header read costs one 64 KiB
    block, not the whole chunk."""
    from tts_utils import wav_frames_sr
    try:
        frames, sr = wav_frames_sr(Path(ws) / f"chunk_{int(i):04d}.wav")
        return frames / float(sr)
    except Exception:                          # noqa: BLE001 — unreadable chunk counts as nothing
        return 0.0                             # (a VaultAuthError is not an Exception, and passes)


def banked_prefix_seconds(ws) -> float:
    """Total seconds of a workspace's contiguous banked chunk prefix (chunk 0 up
    to the first gap) — what a resumed stream replays before rendering live. The
    register endpoint reports this so the player can start ~a minute behind the
    resume point instead of replaying from 0:00. Header reads only (no decode);
    0.0 for no workspace / no chunks / unreadable chunk."""
    from tts_utils import wav_frames_sr
    ws = Path(ws)
    total, i = 0.0, 0
    while vault_fs.exists(ws / f"chunk_{i:04d}.wav"):
        try:
            frames, sr = wav_frames_sr(ws / f"chunk_{i:04d}.wav")
            total += frames / float(sr)
        except Exception:                      # noqa: BLE001 — corrupt chunk ends the prefix
            break
        i += 1
    return round(total, 2)


def prefix_wav(chunks_root, h: str):
    """The contiguous banked prefix DECODED as one waveform — (wav, sr), or (None, 0)
    if nothing is playable. The heavy twin of banked_prefix_seconds (which reads
    headers only): same prefix, same stop-at-the-first-gap rule, so what a partial
    plays and what a partial exports are guaranteed to be the same audio. Used by the
    partial ▶/download route and by 'Send to Voice Training'."""
    import torch
    from tts_utils import load_wav
    ws = workspace(chunks_root, h)
    wavs, sr, i = [], 24000, 0
    while vault_fs.exists(ws / f"chunk_{i:04d}.wav"):
        try:
            w, sr = load_wav(str(ws / f"chunk_{i:04d}.wav"))   # load_wav routes (tts_utils)
            wavs.append(w)
        except Exception:                      # noqa: BLE001 — corrupt chunk ends the prefix
            break
        i += 1
    if not wavs:
        return None, 0
    return torch.cat(wavs, dim=-1), sr


def list_partials(chunks_root) -> list:
    """Interrupted renders (workspace + manifest) as library rows: the user sees what
    was in flight — voice, settings, text — can play the contiguous prefix
    ("the story so far"), and resumes by loading the row and generating (same inputs
    -> same H -> same workspace). Shaped to interleave with list_clips() entries."""
    base = Path(chunks_root) / "playground"
    out = []
    for dname in vault_fs.listdir(base):
        d = base / dname
        m = _read_yaml(d / PENDING_NAME)
        if not m:
            continue
        chunk_files = sorted(vault_fs.glob(d, "chunk_*.wav"))
        prefix = 0                              # gapless run from chunk 0 — the playable part
        while vault_fs.exists(d / f"chunk_{prefix:04d}.wav"):
            prefix += 1
        # LOGICAL stats. `size` below is the sum of these, and it is shown to the user as the
        # size of the partial — the ciphertext sum would be wrong by 16 bytes a block, per
        # chunk, and nothing would ever fail to say so.
        stats = [s for s in (vault_fs.stat(d / n) for n in chunk_files) if s is not None]
        dstat = vault_fs.stat(d)
        mtime = max((s.mtime for s in stats), default=(dstat.mtime if dstat else 0))
        text = m.get("text", "")
        out.append({
            "kind": "partial",
            "ref": d.name,                      # the workspace hash H
            "name": str(m.get("name") or (text[:48].rstrip() + ("…" if len(text) > 48 else ""))),
            # A partial is not ONE file — it is the banked chunk WAVs, and its size is
            # their sum. Say so, rather than implying a clip that isn't there yet.
            "file": f"{d.name}/chunk_*.wav  ({len(chunk_files)} file"
                    f"{'' if len(chunk_files) == 1 else 's'})",
            "format": "wav",
            "favorite": bool(m.get("favorite")),
            "voice": m.get("voice", ""),
            "exaggeration": m.get("exaggeration"),
            "cfg": m.get("cfg"),
            "temperature": m.get("temperature"),
            "narrate_actions": bool(m.get("narrate_actions", True)),
            # A partial's chunks are RAW Chatterbox — enhancement is a post-pass on the
            # finished clip, so this says what the render was ASKED for (and what loading
            # the row must restore), never what the audio on disk already is.
            "enhanced": bool(m.get("enhanced")),
            "nfe": m.get("nfe"),
            "text": text,
            "created": None,
            "created_ts": mtime,
            # The playable "story so far": header-only reads of the contiguous
            # banked prefix (same number the resume lead-in uses) — cheap, and
            # it's what ▶ actually plays for a partial.
            "duration_s": banked_prefix_seconds(d) or None,
            "size": sum(s.size for s in stats),
            "done": len(chunk_files),
            "total": m.get("total"),
            "prefix": prefix,
        })
    return out


def delete_partials(chunks_root, hs: list) -> list:
    """Remove interrupted-render workspaces by hash. Only bare workspace names are
    accepted (traversal-guarded); unknown/malformed entries are skipped."""
    base = Path(chunks_root) / "playground"
    deleted = []
    for h in hs:
        if not re.fullmatch(r"[0-9a-f]{12}", str(h)):
            continue
        d = base / str(h)
        if vault_fs.exists(d):
            vault_fs.rmtree(d)
            deleted.append(str(h))
    return deleted


# (find_adoptable is gone with the seeds: identity H is seedless, so the same
# inputs land on the same workspace directly — resume needs no adoption step.)
