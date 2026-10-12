#!/usr/bin/env python3
"""Store raw and enhanced scenes as separate immutable audio artifacts with manifests under output/scenes. Include creation identity in the scene hash so rebuilding the same message range cannot overwrite an earlier artifact. Keep manifest contents behind vault_fs and register the output directory as a structural container."""
import datetime
import hashlib
import re
import threading
from pathlib import Path

import yaml
from loguru import logger

import vault_fs
from book_to_audio import safe_name

SCENES_DIRNAME = "scenes"

# A scene ref is a BARE STEM — no directory component at all. Playground clips are filed under
# a voice dir because a clip has exactly one voice; a scene has many by definition (§1), so
# there is nothing to file it under and the store is flat. The ref shape is checked rather than
# assumed: `..` and any separator are rejected here, and containment is re-checked after
# resolve() in `scene_paths`, because one guard on a path is a guard you get to be wrong about.
_REF_RE = re.compile(r"[^/\\]+\Z")

# Same shape as playground_clips._STEM_RE, and pinned equal to it by test. `_enhanced` is
# optional and precedes the H8; the H8 is terminal.
_STEM_RE = re.compile(r"_(enhanced_)?([0-9a-f]{8})\Z")


def now() -> str:
    """PUBLIC, unlike its twin in `playground_clips`, because `scene_hash` folds the creation
    timestamp into a scene's identity (see below) — so the builder needs the same clock the
    manifest is stamped with, and reaching across for a `_`-prefixed name to get it would be a
    worse answer than exporting it."""
    return datetime.datetime.now().replace(microsecond=0).isoformat()


def now_exact() -> str:
    """Return a uniqueness token for one scene build, separate from the display timestamp. Add subsecond precision and a process counter so fast repeated joins cannot collide."""
    global _seq
    with _seq_lock:
        _seq += 1
        n = _seq
    return f"{datetime.datetime.now().isoformat()}#{n}"


_seq = 0
_seq_lock = threading.Lock()

_now = now      # the spelling the rest of this module was written with


class SceneManifestUnreadable(Exception):
    """A scene manifest exists but will not parse. Writers must ABORT on this, never persist
    from an empty map — the same rule, for the same reason, as `ClipSidecarUnreadable`.

    It is sharper here. A clip's sidecar can be reconstructed by re-rendering the text; a
    scene's manifest holds the ONLY record of which messages went into a file that may be an
    hour long, their order, their offsets and their cache keys. Nothing regenerates that. A
    writer that starts from `{}` on an unreadable manifest does not degrade the scene, it turns
    it into an anonymous hour of audio."""


def scenes_root(output_dir) -> Path:
    """`output/scenes`. Takes OUTPUT_DIR as an argument rather than importing it, exactly as
    the book and playground stores do: `book_to_audio.OUTPUT_DIR` is captured per importer and
    five test sites monkeypatch it, so a module-level constant computed here would be a second
    root that no patch reaches."""
    return Path(output_dir) / SCENES_DIRNAME


def scene_hash(*, title: str, owner: str, gap_s: float, cache_keys, created: str,
               enhanced: bool = False, nfe=None, nonce: str = "") -> str:
    """Identity for one BUILD of a scene — 12 hex, of which the stem carries the first 8.

    `created` participates, and that is the whole point (see this module's docstring): a scene
    is an artifact, not a render, so two builds of the same range are two scenes and the second
    must not be able to land on the first. Everything else in the key is here so the hash still
    describes what the scene IS — the ordered cache keys are the audio, and `gap_s` changes it
    audibly.

    The enhance terms are appended only when enhancing, mirroring `clip_hash` for the same
    reason it does: the raw scene must keep the hash it landed under when its enhanced twin
    appears minutes later (§3.5a keeps BOTH), and `nfe` means nothing to un-enhanced audio.

    ⚠️ `cache_keys` is the ordered list of per-message audio keys, NOT the message indices.
    §4 is explicit: `mesid` is an array index, it shifts when a message is deleted, and a swipe
    changes a message's text without changing it. An identity keyed on indices starts lying the
    first time either happens.
    """
    key = f"{title}|{owner}|{float(gap_s):.6g}|{created}|" + "|".join(cache_keys)
    if enhanced:
        import enhance
        key += f"|enh={int(nfe or enhance.NFE_DEFAULT)}"
    # 🔴 `created` is only second-resolution, so it does NOT on its own deliver the promise it
    # was folded in for — see `now_exact`. The nonce is what actually separates two builds of
    # the same inputs, and it is appended only when given so that a hash computed without one
    # is byte-identical to what this function returned before 6.0-m2.
    if nonce:
        key += f"|n={nonce}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def stem_for(words: str, h: str, enhanced: bool = False) -> str:
    """The one stem shape. `_enhanced` sits BEFORE the hash so the H8 stays terminal — see the
    module docstring, and `playground_clips.stem_for`, which this deliberately matches."""
    return f"{words}{'_enhanced' if enhanced else ''}_{h[:8]}"


def scene_stem(title: str, h: str, enhanced: bool = False) -> str:
    """Build `<slug>[_enhanced]_<H8>` from the scene title and identity. Never derive a filename from message content; keep the terminal hash stable for lookup after a title rename."""
    words = safe_name(title or "", 30)
    if not words or words == "section":        # safe_name's empty fallback
        words = "scene"
    return stem_for(words, h, enhanced)


def scene_paths(root, ref: str):
    """(mp3, yaml) for a scene ref, or (None, None) for a malformed/traversal ref."""
    root = Path(root)
    if not _REF_RE.fullmatch(ref or "") or ref in (".", ".."):
        return None, None
    p = (root / ref).resolve()
    if root.resolve() != p.parent:
        return None, None
    return p.with_suffix(".mp3"), p.with_suffix(".yaml")


def write_manifest(yaml_path: Path, meta: dict) -> dict:
    """Persist a scene's manifest (adds `created` if absent). Atomic, and atomic INSIDE the
    vault too — `vault_fs.write_yaml_atomic` writes `<dest>.part` and replaces on close."""
    meta = dict(meta)
    meta.setdefault("created", _now())
    vault_fs.write_yaml_atomic(yaml_path, meta)
    return meta


def read_manifest(p: Path, *, strict: bool = False):
    """strict=True (the WRITE paths) raises `SceneManifestUnreadable` rather than returning
    None: returning None for a READ is fine — the Clips tab shows a row with blanks — but using
    it as the base for a write persists the empty map back over the transcript.

    An ABSENT file is not corrupt: None even when strict, because there is nothing to destroy.

    🔴 A WRONG KEY IS NEITHER. `VaultAuthError` is a BaseException by deliberate design (5.0 M1
    §1), so it sails past `except Exception` here — it does not degrade to None, does not become
    a SceneManifestUnreadable, and is not answered by regenerating anything. Under encryption a
    wrong key and a corrupt file are the same event, and this is one of the functions that would
    otherwise answer that event by overwriting the file."""
    if not vault_fs.exists(p):
        return None
    try:
        d = yaml.safe_load(vault_fs.read_text(p))
    except Exception as exc:                                  # noqa: BLE001
        # The stem is derived from the user-supplied title, and logs are outside the vault.
        logger.exception("scene manifest unreadable")
        if strict:
            raise SceneManifestUnreadable(str(exc)) from exc
        return None
    if not isinstance(d, dict):
        if strict:
            raise SceneManifestUnreadable(f"{p.name} is not a mapping ({type(d).__name__})")
        return None
    return d


def _speakers(meta) -> list:
    """Distinct character names in a scene, in first-appearance order — 7.0-m4i / §9a.3.

    ⚠️ **BLANKS ARE DROPPED, NOT RENDERED AS AN EMPTY NAME.** An entry whose `character` is `""`
    is one the extension sent before it carried the name, or a narration with no speaker. The row
    has to say *unknown* for those, and it can only do that if it can tell "no names at all" from
    "a name that is the empty string" — so an empty list means unknown and there is never a blank
    face with a blank label beside the real ones.
    """
    seen, out = set(), []
    for e in (meta.get("entries") or []):
        if not isinstance(e, dict):
            continue
        name = str(e.get("character") or "").strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _speaker_avatars(meta) -> list:
    """Return speaker avatar filenames aligned with the speaker list, using an empty value when none was recorded. Keep the first non-empty avatar for a name so later messages without avatar metadata do not erase it."""
    names = _speakers(meta)
    found = {}
    for e in (meta.get("entries") or []):
        if not isinstance(e, dict):
            continue
        name = str(e.get("character") or "").strip()
        av = str(e.get("character_avatar") or "").strip()
        if name and av and name not in found:
            found[name] = av
    return [found.get(n, "") for n in names]


def display_name(meta, stem: str) -> str:
    """Return the manifest title or derive a readable label from the filename. Share this resolver across listing and import paths so both show the same name."""
    return str((meta or {}).get("title") or _STEM_RE.sub("", stem).replace("_", " "))


def list_scenes(root) -> list:
    """Every scene (mp3 + manifest pair) for the Clips tab, newest first.

    Deliberately NOT `enhance.bandwidth_of` per row, unlike `list_clips`. That measurement is
    cheap on a clip and would decode audio here: the Playground library measures because a
    clip's `enhanced` flag cannot be trusted (an imported full-band upload was never enhanced),
    whereas every scene in this store was made by us, minutes ago, and its manifest records
    exactly which pass produced it. A 46-minute file is also not something to decode to draw a
    list.

    ⚠️ Entries are NOT included. `entries` is the transcript (§5.1) and a listing is the one
    call the UI makes most often; shipping the whole conversation to draw a row would put it
    through a route, a JSON encoder and a browser's memory for no reason. The Clips tab asks
    for one scene's manifest when it opens the chapter list.
    """
    root = Path(root)
    if not vault_fs.is_dir(root):
        return []
    out = []
    for yname in sorted(vault_fs.glob(root, "*.yaml")):
        y = root / yname
        mp3 = y.with_suffix(".mp3")
        if not vault_fs.exists(mp3):
            continue                       # half-written / half-deleted pair — not a scene
        try:
            meta = read_manifest(y, strict=True) or {}
        except SceneManifestUnreadable:
            meta = {}
        # 🔴 NOT mp3.stat(). Inside the vault that is the CIPHERTEXT size, and the tab would
        # report it as the size of the scene — every row wrong by the header plus 16 bytes a
        # block, forever, and nothing failing. vault_fs.stat is the LOGICAL stat.
        st = vault_fs.stat(mp3)
        if st is None:
            continue                       # deleted under us, mid-listing
        stem = mp3.stem
        out.append({
            "ref": stem,
            "name": display_name(meta, stem),
            "file": mp3.name,
            "format": "mp3",
            "enhanced": bool(meta.get("enhanced")),
            "nfe": meta.get("nfe"),
            "raw_ref": meta.get("raw_ref"),          # the enhanced twin points at its parent
            "source": meta.get("source", ""),        # "st" | "nomi"
            "owner": meta.get("owner", ""),
            "chat": meta.get("chat", ""),
            "gap_s": meta.get("gap_s"),
            # 🔴 m4i / §9a.3 — WHO SPEAKS IN THIS SCENE, and the whole first item of that section
            # turned out to be already done. It reads *"this one starts at the EXTENSION, not in
            # the UI… a scene clip currently arrives as audio; the character who spoke it is not
            # sent, so there is nothing in the store to render or filter on."* Not so:
            # `scene_build.py:328` has written `"character": item.get("character", "")` onto every
            # entry since the first scene was built. Nothing was missing except a way to see it.
            #
            # ⚠️ **THE NAMES, NOT THE ENTRIES.** This listing's own docstring forbids shipping
            # `entries` — it is the transcript, and a listing is the call the UI makes most often.
            # A distinct name list is a handful of short strings and is not the conversation.
            #
            # 📌 First-appearance order, not sorted: for a two-hander that is who opened the
            # scene, which is more useful in a row than alphabetical.
            "characters": _speakers(meta),
            "character_avatars": _speaker_avatars(meta),   # 11.2.5 — aligned with `characters`
            "n_entries": len(meta.get("entries") or []),
            "n_skipped": len(meta.get("skipped") or []),
            "duration_s": meta.get("total_duration_s"),
            "created": meta.get("created"),
            "created_ts": st.mtime,
            "size": st.size,
        })
    out.sort(key=lambda r: (r["created_ts"] or 0), reverse=True)
    return out


def find_ref_by_hash(root, h: str, enhanced: bool = False):
    """Return the scene ref for identity H, or None. Match the terminal hash suffix so renamed scenes remain discoverable, including when resolving a raw scene for an enhanced twin."""
    root = Path(root)
    if not vault_fs.is_dir(root):
        return None
    pat = f"*_enhanced_{h[:8]}.mp3" if enhanced else f"*_{h[:8]}.mp3"
    for name in sorted(vault_fs.glob(root, pat)):
        stem = Path(name).stem
        if bool(_STEM_RE.search(stem).group(1)) == enhanced:
            return stem
    return None


def rename_scene(root, ref: str, new_name: str):
    """Rename a scene's display name: both files move to '<safe(new_name)>[_enhanced]_<H8>'.
    Returns the new ref; None if the scene doesn't exist; raises ValueError on an unusable name
    or a collision.

    The H8 and the `_enhanced` marker are both PRESERVED. The marker is not decoration — it is
    how the raw and enhanced takes of one build are told apart in a flat list, and §7.1's filter
    is built on it, so dropping it while tidying a name would quietly merge two rows into one."""
    root = Path(root)
    mp3, y = scene_paths(root, ref)
    if mp3 is None or not vault_fs.exists(mp3):
        return None
    m = _STEM_RE.search(mp3.stem)
    if not m:
        raise ValueError("scene has no identity suffix — cannot rename safely")
    words = safe_name(new_name, 30)
    if not words or words == "section":            # safe_name's empty fallback
        raise ValueError("that name has no usable characters")
    new_stem = stem_for(words, m.group(2), bool(m.group(1)))
    if new_stem == mp3.stem:
        return ref                                 # no-op rename
    new_mp3 = mp3.with_name(new_stem + ".mp3")
    if vault_fs.exists(new_mp3):
        raise ValueError("a scene with that name already exists")
    # A vault rename re-encrypts the NAME and moves nothing else — not a byte of audio is
    # rewritten, which matters rather more for an hour-long scene than for a clip.
    vault_fs.rename(mp3, new_mp3)
    new_y = y.with_name(new_stem + ".yaml")
    if vault_fs.exists(y):
        vault_fs.rename(y, new_y)
    meta = read_manifest(new_y, strict=True) or {}
    meta["title"] = new_name            # the EXACT name; the stem went through safe_name
    write_manifest(new_y, meta)
    return new_stem


def delete_scenes(root, refs: list) -> list:
    """Delete scenes (mp3 + manifest each). Returns the refs actually removed — unknown or
    malformed refs are skipped, not errors, so a stale browser tab cannot 500 the route.

    ⚠️ Deleting the raw scene does NOT delete its enhanced twin, or the other way round. They
    are two artifacts (§3.5a) and §7.1's whole cleanup workflow is "filter to not-enhanced,
    select all, delete" — a cascade would take the enhanced ones with them, which is the exact
    opposite of what that filter is for."""
    root = Path(root)
    deleted = []
    for ref in refs:
        mp3, y = scene_paths(root, str(ref))
        if mp3 is None:
            continue
        existed = vault_fs.exists(mp3) or vault_fs.exists(y)
        vault_fs.unlink(mp3, missing_ok=True)
        vault_fs.unlink(y, missing_ok=True)
        if existed:
            deleted.append(str(ref))
    return deleted
