#!/usr/bin/env python3
"""Own the shared stem store, identities, sidecars, listings, deletion, and pure command builders; job execution stays in voiceswap.py and stemsplit.py. Key a stem set by song content rather than split mode, and ensure every set includes a two-stem base with an instrumental. Record whether stems were uploaded or generated as sidecar provenance."""
import hashlib
import os
import re
import shutil
import threading
from pathlib import Path, PurePosixPath

import yaml
from loguru import logger

import folders
import vault_fs
from book_to_audio import safe_name
# THE IDENTITY SEAM (5.0 §7.7.2). tts_utils imports nothing local, so this is not a cycle —
# and it is the only way for this module to share ONE answer to "has this file changed?" with
# the enhance track: `enhance` imports `voiceswap`, which imports us.
from tts_utils import atomic_replace, source_stat
from vocalis.runtime import paths

DEMUCS_MODEL = "htdemucs"
SIDECAR = "stems.yaml"

# The on-disk name of each stem, and what we call it in the UI. `instrumental.wav`
# is OURS: Demucs calls it `no_vocals.wav` in 2-stem mode and doesn't produce it at
# all in 4-stem mode, and neither of those is a name a user should ever have to see.
STEM_LABELS = {"vocals.wav": "Vocals", "instrumental.wav": "Instrumental",
               "drums.wav": "Drums", "bass.wav": "Bass", "other.wav": "Other"}
# Display/pill order — instrumental first, because it's the one a swap borrows and
# the one the swap library's Stems view leads with.
STEM_ORDER = ["instrumental.wav", "vocals.wav", "drums.wav", "bass.wav", "other.wav"]

# What a set must hold to satisfy each mode. The two Demucs modes carry the 2-stem base;
# `vocals` (8.4) deliberately does not — see the DERIVED block below and §6.5.
MODE_STEMS = {"2stem": ["vocals.wav", "instrumental.wav"],
              "4stem": ["vocals.wav", "instrumental.wav",
                        "drums.wav", "bass.wav", "other.wav"],
              # 8.4 — the harvest stage 1 of "Lead vocals only" runs in. Demucs still runs
              # `--two-stems=vocals`, the same model pass at the same cost since it computes
              # the instrumental as mix − vocals either way, but ONLY the vocal is committed:
              # a full-length instrumental beside a truncated lead is a pair that can only
              # mislead, and this workflow never wants it (§0② · §6.4).
              "vocals": ["vocals.wav"]}
# The 2-stem base — what a SWAP needs, and the minimum for a usable set.
BASE_STEMS = ["vocals.wav", "instrumental.wav"]
# What Demucs itself writes, per mode, before we rename/sum.
DEMUCS_RAW = {"2stem": ["vocals.wav", "no_vocals.wav"],
              "4stem": ["vocals.wav", "drums.wav", "bass.wav", "other.wav"],
              # `vocals` runs the SAME child as 2stem and Demucs writes no_vocals.wav too —
              # but this list is what the run is CHECKED for, and failing a good split over a
              # by-product we are about to throw away would be a manufactured error.
              "vocals": ["vocals.wav"]}
# The parts a 4-stem run sums into the instrumental (mix − vocals, the long way).
SUM_PARTS = ["drums.wav", "bass.wav", "other.wav"]
# Pre-M4 splits wrote Demucs's own name. Read it, migrate it (see migrate()).
LEGACY_INSTRUMENTAL = "no_vocals.wav"

# ── 8.4: DERIVED stems (DESIGN_8_4_LEAD_VOCAL.md §6) ─────────────────────────
#
# `lead_solo.wav` is made FROM another stem in this set — the wet vocal, cut down to the
# passages where the lead singer is alone — so it is NOT a Demucs slot and must never be
# mistaken for one. It is enumerated for the widget and for ⬇ All (`DISPLAY_ORDER`), and it is
# invisible to `satisfies`, `has_base` and `mode_of`, which is what stops a folder holding one
# from reading as a differently-moded Demucs set and what keeps the mode badge honest (§6 R1).
#
# 🔴 IT IS STORED AS WAV, DELIBERATELY AGAINST THE OPUS RULE (7.5.25). It is the one file in
# this store that is a MODEL'S TRAINING INPUT rather than something an ear plays back, and the
# chain already spends a lossy generation on `vocals.opus` → decode → cut → training MP3.
# Storing it as Opus would buy a second one for ~10 MB (§5).
LEAD_SOLO = "lead_solo.wav"
LEAD_SPANS = "lead_spans.json"      # the provenance beside it — not audio, not a pill
#: derived stem → the extension it is stored under. The one place that knows a derived stem
#: does not follow STEM_EXTS.
DERIVED_EXTS = {"lead_solo": ".wav"}

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"}
_REF_RE = re.compile(r"[^/\\]+\Z")          # set refs are flat names — no traversal
_H_RE = re.compile(r"[0-9a-f]{8,64}")

# New stem sets use Opus to reduce storage; existing WAV sets remain supported. A stem is identified by its logical name, not its extension. `find_stem` checks the configured extension order, and `stem_key` removes the suffix so existing URLs and callers continue to resolve either format. Do not backfill existing WAVs automatically: re-encoding is lossy and irreversible. The swap key uses the song content identity from the index or upload sidecar, not the encoded stem bytes.
STEM_EXTS = (".opus", ".wav")               # lookup order: what we write now, then what we wrote
STEM_EXT = ".opus"                          # what a fresh set is stored as
STEM_BITRATE = "192k"                       # Preferred format for newly stored stems.

#: The bare stem names, derived so this cannot drift from the labels above.
STEM_NAMES = [Path(f).stem for f in STEM_ORDER]

# `STEM_LABELS` is keyed on the FILENAME and is imported by stemsplit and read by `row`, so it
# GROWS to cover the new extension rather than changing shape. Every existing lookup keeps
# working, and an `.opus` stem gets the same label its `.wav` twin would have.
STEM_LABELS.update({f"{n}{e}": STEM_LABELS[f"{n}.wav"]
                    for n in STEM_NAMES for e in STEM_EXTS})
STEM_LABELS[LEAD_SOLO] = "Lead vocal"

#: Everything a set can hold, in display order — the Demucs slots plus the derived lead. The
#: lead goes FIRST, ahead of the instrumental a swap borrows: on a set that has one it is what
#: you came for (§7). `STEM_ORDER` stays exactly what it was, because it is the DEMUCS slot
#: list and the mode questions are asked with it.
DISPLAY_ORDER = [LEAD_SOLO] + STEM_ORDER


def stem_key(x) -> str:
    """`'vocals.opus'` | `'vocals.wav'` | `'vocals'` → `'vocals'`; `''` for anything else.

    Traversal-safe: it takes the basename first, so `'../../etc/passwd'` cannot survive, and
    the result is only ever used against `STEM_NAMES`. Backslashes count as separators on every
    platform: the Docker edition runs on Linux, where `Path` would keep `..\\..\\lead_solo.wav`
    whole and reject a name Windows accepts (found 2026-10-09 running the suite in the image)."""
    name = PurePosixPath(str(x or "").replace("\\", "/")).name
    if not name:
        return ""
    stem = Path(name).stem if Path(name).suffix.lower() in AUDIO_EXTS else name
    return stem if stem in STEM_NAMES or stem in DERIVED_EXTS else ""


def stored_name(stem) -> str:
    """The filename a FRESH set stores `stem` under. Writers only — every reader resolves
    what is actually on disk with `find_stem`, because most sets predate this."""
    key = stem_key(stem)
    if key in DERIVED_EXTS:
        return f"{key}{DERIVED_EXTS[key]}"
    return f"{key}{STEM_EXT}" if key else ""


def find_stem(d: Path, stem):
    """The file holding `stem` in this set, whichever extension it is stored under, or None.

    THE ONE PLACE THAT KNOWS A SET MAY BE EITHER FORMAT. `has_base`, `satisfies`, `stem_files`
    and `stem_file` are all written in terms of it, so "does this set have a vocal?" cannot
    get a different answer in one of them than in another — which is the failure mode that
    would gray a perfectly swappable set out of the picker."""
    key = stem_key(stem)
    if not key:
        return None
    # A derived stem has exactly ONE legal extension and is never re-encoded, so it is not
    # searched across STEM_EXTS — a `lead_solo.opus` is a file nothing in this system writes,
    # and resolving one would quietly hand a second lossy generation to a trainer.
    for ext in (DERIVED_EXTS[key],) if key in DERIVED_EXTS else STEM_EXTS:
        p = Path(d) / f"{key}{ext}"
        if vault_fs.exists(p):
            return p
    return None


def _h8_of(d: Path) -> str:
    """The identity suffix of a stem-set dir, for logging.

    A set is named "<song title>_<h8>", so logging the dir NAME logs the song title into
    logs/ — which sits outside the vault. The h8 identifies the set just as uniquely for
    debugging and reveals nothing."""
    tail = Path(d).name.rsplit("_", 1)[-1]
    return tail if _H_RE.fullmatch(tail) else "????????"


# ── identity ─────────────────────────────────────────────────────────────────

def open_source(p):
    """A source file's PLAINTEXT bytes, wherever it lives. 🔴 **THE ROUTED READ** (5.0 M6).

    A song is now one of TWO different kinds of file and this is the only thing that can tell
    them apart:

      /ai-output/acestep/…   gocryptfs's. Already plaintext to us through the FUSE mount, and
                             the ownership rule is "we read /ai-output; we NEVER write there".
                             A plain open() is CORRECT.
      uploads/songs/…        OURS, and after M6 it is CIPHERTEXT on disk. A plain open() here
                             returns the ciphertext.

    md5 the wrong one and the SAME SONG gets a DIFFERENT IDENTITY: every entry in the swap
    library stops cache-hitting, every stem set fails find_by_hash, and Demucs re-runs across
    the lot. That is the exact catastrophe this milestone exists to prevent.
    """
    from vault_store import route      # deferred: keeps this a pure library at import time
    r = route(p)
    if r is None:
        return open(p, "rb")
    v, logical = r
    return v.open_read(logical)


def _md5_file(p: Path, h=None):
    h = h or hashlib.md5()
    with open_source(p) as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h


def song_hash(song: Path) -> str:
    """Return the content identity of the song that determines a generated stem set. Use content rather than filename so replacement audio under the same name gets a distinct set, while existing swap keys remain stable."""
    return _md5_file(song).hexdigest()


# `song_hash()` defines identity by hashing the full song, but computing it on every request would repeat file reads and decryption. `song_id()` is the single entry point and consults the index before hashing on a cache miss; the index does not redefine identity. Keep one regenerable index for uploaded songs and externally produced songs: uploads may carry sidecars, but the external output tree is read-only.

_H32 = re.compile(r"[0-9a-f]{32}")     # a song hash, exactly: never serve junk as an identity
_INDEX_LOCK = threading.Lock()         # record() is a read-modify-write; the probe thread,
                                       # the swap job and the split job all reach it at once


class SongIndexUnreadable(Exception):
    """The song-hash index exists and will not parse. Twin of enhance_rate.RateStoreUnreadable,
    and it is there for the same reason: record() must ABORT rather than write one key back
    over a file it could not read and erase every OTHER song's hash. The loss would be bounded
    (the cache is regenerable) but it would be a loss taken for nothing.

    Reads DEGRADE — an unreadable index just means the song gets re-hashed, which is slow and
    correct. ABSENT ≠ CORRUPT: a missing index has nothing to destroy, so it returns {} even
    when strict, and record() goes on to create it."""


def _index_path(cfg):
    """The index file, or None for a config that has no memo.

    A MISSING MEMO IS SLOW, NEVER WRONG — it re-hashes, which is exactly what the code did
    before M4. So it is never worth raising over: nothing may fail a swap, a split or a probe
    because a CACHE was unavailable. (The real configs always set it; a test driving this pure
    library with a bare tmp_path need not.)"""
    p = getattr(cfg, "song_index", None)
    return Path(p) if p else None


def _load_index(cfg, *, strict: bool = False) -> dict:
    p = _index_path(cfg)
    if p is None:
        return {}
    try:
        d = yaml.safe_load(vault_fs.read_text(p))
    except FileNotFoundError:
        return {}                                   # absent ≠ corrupt
    except Exception as e:                          # noqa: BLE001
        logger.warning(f"song index unreadable ({type(e).__name__}) — re-hashing from source")
        if strict:
            raise SongIndexUnreadable(str(e)) from e
        return {}
    if isinstance(d, dict):
        return d
    if strict:
        raise SongIndexUnreadable(f"not a mapping ({type(d).__name__})")
    return {}


def _record(cfg, key: str, h: str, st: tuple) -> None:
    p = _index_path(cfg)
    if p is None:
        return
    with _INDEX_LOCK:
        try:
            idx = _load_index(cfg, strict=True)
        except SongIndexUnreadable:
            logger.warning("song index unreadable — NOT overwriting it (every other song's "
                           "hash is still in there); this song re-hashes next time")
            return
        idx[key] = {"h": h, "size": st[0], "mtime": st[1]}
        try:
            vault_fs.write_yaml_atomic(p, idx)
        except OSError as e:
            # An index we cannot write is a slow lookup, never a wrong one.
            logger.warning(f"song index unwritable ({type(e).__name__}) — re-hashing next time")


def song_id(cfg, song: Path) -> str:
    """**THE FRONT DOOR.** The song's identity — the same md5 song_hash() has always returned,
    remembered so it is computed once per song instead of once per question.

    An entry is served only while the file's (size, mtime) still match, so a REGENERATED
    ACE-Step file under the same name is a different song and gets its own stem set: content,
    never filename (R4), exactly as before."""
    p = Path(song)
    before = source_stat(p)                     # the seam — one answer, shared with enhance
    if before is None:
        return song_hash(p)                     # gone: let the hash raise, as it always did

    key = str(p.resolve())
    e = _load_index(cfg).get(key)
    if isinstance(e, dict) and e.get("size") == before[0] and e.get("mtime") == before[1]:
        h = str(e.get("h") or "")
        if _H32.fullmatch(h):                   # a junk entry is a miss, never an identity
            return h

    h = song_hash(p)
    # Stat AGAIN. If the song changed while we were reading it, `h` is a torn mix of two files
    # and belongs to neither — remembering it against either stat would poison a library
    # entry's identity permanently, which is the one thing this milestone must not do.
    if source_stat(p) == before:
        _record(cfg, key, h, before)
    return h


def record_song_id(cfg, song: Path, h: str) -> None:
    """Seed the index with a hash the caller ALREADY has.

    save_upload() computes the full 32-hex hash at ingest and keeps 8 of them in the filename
    — it used to throw the other 24 away, and every later question re-read the whole file to
    get them back. An uploaded song is now never hashed twice."""
    st = source_stat(song)
    if st is not None and _H32.fullmatch(str(h or "")):
        _record(cfg, str(Path(song).resolve()), h, st)


def upload_hash(files: list) -> str:
    """An uploaded set has no song, so it is identified by the content of its stems
    (§3: "a stem set need not have a song"). Sorted by stem name so the hash doesn't
    depend on the order the browser handed us the files."""
    h = hashlib.md5()
    for name, path in sorted(files, key=lambda t: t[0]):
        h.update(name.encode("utf-8"))
        _md5_file(Path(path), h)
    return h.hexdigest()


def set_ref(name: str, h: str) -> str:
    return f"{safe_name(name, 48)}_{h[:8]}"


# ── the two stores ───────────────────────────────────────────────────────────
# Lookup order is uploads-then-output, exactly as §5's get_stems() has it: stems you
# brought yourself win over stems we made, because you brought them for a reason.

def stores(cfg) -> list:
    """The store roots, in lookup order. `cfg` is any config carrying both dirs —
    SwapConfig and StemConfig both do."""
    return [Path(cfg.stem_uploads_dir), Path(cfg.stems_dir)]


def set_dir(root, ref: str):
    """The folder for a ref under one root, or None for a malformed/traversal ref."""
    ref = str(ref or "")
    if not _REF_RE.fullmatch(ref) or ref.strip(".") == "":
        return None
    return Path(root) / ref


def find_dir(cfg, ref: str):
    """Resolve a ref across both stores (uploads first). None if it isn't a finished
    set anywhere — a folder without a sidecar is half-written and does not count."""
    for root in stores(cfg):
        d = set_dir(root, ref)
        if d is not None and vault_fs.is_dir(d) and vault_fs.exists(d / SIDECAR):
            return d
    return None


class StemsSidecarUnreadable(Exception):
    """A stem set's sidecar exists but will not parse. Writers and IDENTITY questions must
    ABORT on this; only display may degrade.

    Same shape, same reason as playground_clips.ClipSidecarUnreadable. What it protects is
    the answer to "have I already split this song?", because the caller's answer to `no` is
    to spend twenty minutes of GPU and then `commit()` — which os.replace's a fresh folder
    over the one whose sidecar we could not read. A set that is merely unreadable is not
    foreign, and treating it as foreign is how the good stems get overwritten by remade
    ones while the UI lists the set the whole time (list_sets tests that the sidecar
    EXISTS, not that it READS)."""


def read_meta(d: Path, *, strict: bool = False) -> dict:
    """strict=True (the WRITE and IDENTITY paths) raises StemsSidecarUnreadable on a
    corrupt sidecar instead of returning {}: {} is a fine basis for a row in the Stems tab
    and a catastrophic basis for "this set is not the one you're looking for".

    An ABSENT sidecar is not corrupt — it returns {} even when strict. A folder without one
    is half-written and does not count as a set anywhere (find_dir, list_sets), so there is
    nothing there to destroy."""
    try:
        m = yaml.safe_load(vault_fs.read_text(Path(d) / SIDECAR))
    except FileNotFoundError:
        return {}
    # A VaultAuthError is a BaseException and passes straight through: it must NOT become a
    # StemsSidecarUnreadable and must NOT degrade to {}. {} means "foreign set" here, and the
    # caller's answer to a foreign set is twenty minutes of Demucs and a commit() over the top.
    except Exception as e:                                     # noqa: BLE001
        # NOT {d}: a stem-set dir is named "<song title>_<h8>", so the path IS the title.
        # The h8 identifies the set uniquely and leaks nothing. Same below.
        logger.exception(f"stems sidecar unreadable — treating the set as foreign: …_{_h8_of(d)}")
        if strict:
            raise StemsSidecarUnreadable(f"…_{_h8_of(d)}: {type(e).__name__}") from e
        return {}
    if isinstance(m, dict):
        return m
    if strict:
        raise StemsSidecarUnreadable(f"…_{_h8_of(d)} is not a mapping ({type(m).__name__})")
    return {}


def write_meta(d: Path, meta: dict):
    """The sidecar. It is the LAST write of commit(), and it is what publishes a set."""
    vault_fs.write_yaml_atomic(Path(d) / SIDECAR, dict(meta))


def find_by_hash(cfg, h: str):
    """The set whose identity is H, or None. Globs on the `_<h8>` suffix (cheap) and
    then CONFIRMS against the sidecar's full hash, so an 8-hex coincidence between a
    song and an uploaded set can't serve the wrong stems.

    Reads STRICT (raises StemsSidecarUnreadable), because None here is not a shrug — it is
    a license. The callers answer it by running Demucs and committing the result over this
    very folder. A candidate that already matched the `_<h8>` glob and then would not parse
    is an UNKNOWN, and an unknown must never be reported as an absence."""
    if not h or not _H_RE.fullmatch(str(h)):
        return None
    for root in stores(cfg):
        root = Path(root)
        if not vault_fs.is_dir(root):
            continue
        for name in sorted(vault_fs.glob(root, f"*_{h[:8]}")):
            d = root / name
            if vault_fs.is_dir(d) and read_meta(d, strict=True).get("h") == h:
                return d
    return None


def stem_files(d: Path) -> list:
    """The stem files actually present in a set, in display order — whichever format each
    one is stored in (7.5.25). A set may hold `vocals.opus` beside a legacy `instrumental.wav`
    and both come back."""
    return [p for p in (find_stem(d, s) for s in DISPLAY_ORDER) if p is not None]


def has_base(d) -> bool:
    """Swap-ready: a vocal to convert AND an instrumental to put it back over. A lone
    uploaded instrumental is storable and downloadable but not swappable (§5) — that
    is what grays its row out in the swap picker, rather than failing at stage 2."""
    return all(find_stem(d, s) is not None for s in BASE_STEMS)


def satisfies(d, mode: str) -> bool:
    """Does this set already hold everything `mode` promises? This is what makes a
    re-split a no-op — and what makes a 4-stem request on a 2-stem set actually RUN
    rather than falsely reporting "already split"."""
    return all(find_stem(d, s) is not None for s in MODE_STEMS.get(mode, BASE_STEMS))


def has_lead(d) -> bool:
    """Does this set hold a `lead_solo.wav`? (8.4 — what puts the Lead vocal pill on the row,
    what makes 🎓 send the lead, and what "already done" means for a `lead` split.)"""
    return find_stem(d, "lead_solo") is not None


def mode_of(d) -> str:
    """The mode a set currently satisfies (what it HOLDS, not what was asked for).

    🔴 **IT MUST NOT ANSWER "2stem" FOR A SET WITH NO BASE** (8.4 §6 R6). Until 8.4 the final
    `else` was safe because every set carried vocals + instrumental; a "Lead vocals only" set
    holds one vocal and nothing else, and badging that *2-stem* is a lie the UI would then
    repeat everywhere — in the row, in the picker, in the library.

    The derived lead is deliberately not consulted: this answers what DEMUCS left, and a set
    is `vocals` whether or not a lead has been cut from it. `has_lead` is the separate
    question, badged separately (§6 R1)."""
    if satisfies(d, "4stem"):
        return "4stem"
    if has_base(d):
        return "2stem"
    # No base. Naming it after the vocal is only honest when there IS one — an uploaded
    # instrumental with no vocal is storable, unswappable and equally baseless, and calling
    # that "vocals" would be the old lie pointing the other way.
    return "vocals" if find_stem(d, "vocals") is not None else "partial"


def stem_file(cfg, ref: str, stem: str):
    """One stem of one set, or None for a malformed ref / unknown stem name / missing file.
    The only door the audio route opens.

    Takes `vocals`, `vocals.wav` or `vocals.opus` and answers with whatever this set actually
    holds — which is what keeps `/stems/library/<ref>/vocals.wav/audio` working after the
    format changed. Every URL already emitted (the bundle, a bookmark, the ST extension) says
    `.wav`, and none of them are going to be rewritten in step with the store."""
    d = find_dir(cfg, ref)
    return None if d is None else find_stem(d, stem)


def row(d: Path) -> dict:
    """One set, as the UI sees it: its pills, its provenance, and whether a swap can
    actually use it."""
    d = Path(d)
    meta = read_meta(d)
    # LOGICAL sizes. A raw stat reports the CIPHERTEXT size of every stem in the library.
    files = []
    for p in stem_files(d):
        st = vault_fs.stat(p)
        # `stem` is the IDENTITY ("vocals"); `file` is how this set happens to store it
        # ("vocals.opus" | "vocals.wav"). The page keys off `stem` — a row asking
        # `s.file === 'vocals.wav'` was correct for exactly as long as one format existed,
        # and it goes silently false on every new set rather than failing.
        # `derived` keeps the set's own accounting honest (§6 R1): the lead is a pill and a
        # zip entry, but it is not one of the N stems Demucs made, and the UI must be able to
        # tell the difference without re-deriving it from the name.
        files.append({"file": p.name, "stem": stem_key(p.name),
                      "label": STEM_LABELS[p.name],
                      "derived": stem_key(p.name) in DERIVED_EXTS,
                      "size": st.size if st else 0})
    dstat = vault_fs.stat(d)
    return {"ref": d.name, "h": meta.get("h"),
            "source": meta.get("source") or "demucs",
            "song": meta.get("song") or d.name, "song_ref": meta.get("song_ref") or "",
            "song_h": meta.get("song_h"),
            "mode": mode_of(d), "swappable": has_base(d),
            # The `lead:` block the lead job wrote (8.4 §6) — spans, kept_sec, which detector
            # and which de-reverb model made it, and `thin` when the song had almost no solo
            # lead in it. None on every set that has never been through that mode.
            "lead": meta.get("lead") or None,
            "duration_s": meta.get("duration_s"),
            "created": meta.get("created"),
            "created_ts": dstat.mtime if dstat else 0,
            "size": sum(s["size"] for s in files), "stems": files}


def list_sets(cfg) -> list:
    """Every finished set in both stores, newest first — the Stems tab's rows and the
    swap picker's stem-set sources."""
    out = []
    for root in stores(cfg):
        root = Path(root)
        for name in vault_fs.listdir(root):
            d = root / name
            # The sidecar is what makes a folder a SET — a half-written one has none and does
            # not count anywhere. That is also what makes commit()'s sidecar-last write atomic.
            if vault_fs.is_dir(d) and vault_fs.exists(d / SIDECAR):
                out.append(row(d))
    out.sort(key=lambda r: r["created_ts"], reverse=True)
    return out


def delete_sets(cfg, refs: list) -> list:
    """Delete sets. Unknown/malformed refs are skipped; a folder that survives the
    rmtree (a stem held open on Windows) is NOT reported deleted — the row stays in
    the library rather than silently lying about what's on disk.

    Nothing a swap owns is touched: its MP3 and its dry vocal are its own files. All
    that disappears is the borrowed instrumental, which is exactly what the delete
    warning says (§5) — and a re-split restores it."""
    deleted = []
    for ref in refs:
        d = find_dir(cfg, str(ref))
        if d is None:
            continue
        vault_fs.rmtree(d)
        if not vault_fs.exists(d):
            deleted.append(str(ref))
    return deleted


# ── writing a set (used by BOTH the split job and the swap's stage 1) ─────────

#: The one weight file `-n htdemucs` loads. Demucs 4.0.1 resolves the name through
#: `demucs/remote/htdemucs.yaml` (a bag of the single model `955717e8`) and `remote/files.txt`
#: (`hybrid_transformer/955717e8-8726e21a.th`), then hands the URL to
#: `torch.hub.load_state_dict_from_url(check_hash=True)`, which keeps it at
#: `<torch hub dir>/checkpoints/<file name>` and downloads it when that file is absent.
DEMUCS_WEIGHT_FILE = "955717e8-8726e21a.th"


def demucs_weight_path(env=None) -> Path:
    """Where `torch.hub` will look for the HTDemucs weights in a child started with `env`.

    The hub directory is `$TORCH_HOME/hub`; without TORCH_HOME it is `$XDG_CACHE_HOME/torch/hub`,
    and without that `~/.cache/torch/hub` (torch.hub `_get_torch_home`/`get_dir`, which
    Demucs never overrides). The packaged image sets TORCH_HOME=/work/vocalis/runtime-cache/torch
    (October 10, 2026: moved out of the Vocalis cache root, which an in-place switch may share with
    a standalone install; it was /cache/vocalis/torch), so there this is
    /work/vocalis/runtime-cache/torch/hub/checkpoints/955717e8-8726e21a.th. Nothing here
    hard-codes that: the path is always derived from `env`, which is the environment the child
    will actually get, so the answer is the child's, not the parent's.

    October 11, 2026: that runtime-cache path is now only the answer for an environment that
    `demucs_child_env` has not changed. In the packaged image setup downloads the weights under
    VOCALIS_STEMS_MODEL_ROOT (/models/vocalis/stems), `demucs_child_env` gives the Demucs child that
    folder as its TORCH_HOME, and so this returns
    /models/vocalis/stems/hub/checkpoints/955717e8-8726e21a.th for the child's environment."""
    env = os.environ if env is None else env
    home = env.get("TORCH_HOME", os.path.join(env.get("XDG_CACHE_HOME", "~/.cache"), "torch"))
    return Path(os.path.expanduser(home)) / "hub" / "checkpoints" / DEMUCS_WEIGHT_FILE


#: The packaged image sets this to the folder setup puts the HTDemucs weights in
#: (packaging/models/stems/model-file-lock.json; October 11, 2026). It is a torch home: the file
#: sits at <root>/hub/checkpoints/<DEMUCS_WEIGHT_FILE>. Unset (a non-Docker run) means no change.
STEMS_MODEL_ROOT_VARIABLE = "VOCALIS_STEMS_MODEL_ROOT"


def demucs_child_env(env=None) -> dict:
    """The environment for a Demucs child: a copy of `env` (default: this process's), with TORCH_HOME
    pointing at the setup-downloaded weights when VOCALIS_STEMS_MODEL_ROOT is set.

    Demucs resolves `htdemucs` to one file and loads it through `torch.hub`, which reads
    `<TORCH_HOME>/hub/checkpoints/<file>` and only downloads when that file is absent. Pointing the
    child's TORCH_HOME at the models folder makes the file setup downloaded the file Demucs reads, with
    no copy and no link (the models mount and the work mount are different mounts). `torch.hub` writes
    nothing there when the file exists (it only makes the checkpoints folder, which already exists), so
    a read-only models mount would also work. Only this child sees the changed TORCH_HOME; the image's
    own TORCH_HOME (the runtime cache) is untouched. Build the env once and use the SAME dict for the
    `require_demucs_model` check and the spawn, so the path checked is the path the child reads."""
    env = dict(os.environ if env is None else env)
    root = env.get(STEMS_MODEL_ROOT_VARIABLE)
    if root:
        logger.info(f"Demucs child: TORCH_HOME={root} ({STEMS_MODEL_ROOT_VARIABLE}; was "
                    f"{env.get('TORCH_HOME', '<unset>')})")
        env["TORCH_HOME"] = root
    return env


def require_demucs_model(env=None) -> None:
    """Raise RuntimeError unless the HTDemucs weights are already on disk as a regular file.

    🔴 Demucs would otherwise DOWNLOAD them from dl.fbaipublicfiles.com on first use, and it has
    no offline switch. Ordinary operation must never fetch a model, so this runs before the
    Demucs child is built, let alone spawned. Setup downloads the file from its publisher (size- and
    hash-checked; October 11, 2026, when the earlier licensing hold was lifted), so a missing file
    means setup has not finished or was not run again after an update. `env` is the child's
    environment from `demucs_child_env`. The message is shown to the user; the path goes to the log."""
    path = demucs_weight_path(env)
    if path.is_file():
        logger.info(f"HTDemucs weights present: {path}")
        return
    logger.warning(f"HTDemucs weights missing: {path} — refusing to start Demucs, "
                   f"nothing is downloaded")
    raise RuntimeError(
        f"Stems needs the HTDemucs model ({DEMUCS_WEIGHT_FILE}), which has not been downloaded yet. "
        f"Run setup again to fetch it; on Windows that is Start menu > Repair setup.")


def build_demucs_cmd(python, song: Path, work: Path, device: str, mode: str) -> list:
    launcher = Path(__file__).resolve().parents[1] / "scripts" / "stems" / "demucs_worker.py"
    cmd = [str(python), str(launcher)]
    if mode in ("2stem", "vocals"):
        # `vocals` asks for the same run: Demucs computes the instrumental as mix − vocals
        # whichever way it is invoked, so the two-stems form costs nothing extra, and the
        # HARVEST (voiceswap.get_stems) is what drops the half we are not keeping.
        cmd.append("--two-stems=vocals")
    cmd += ["-n", DEMUCS_MODEL, "-d", "cpu" if device == "cpu" else "cuda",
            "-o", str(work), str(song)]
    return cmd


def demucs_out_dir(work: Path, song: Path) -> Path:
    return Path(work) / DEMUCS_MODEL / Path(song).stem


def build_sum_cmd(parts: list, out_wav: Path) -> list:
    """drums + bass + other → instrumental (the 2-stem base of a 4-stem split).

    normalize=0 is load-bearing, exactly as it is in the swap's remix: amix divides
    every input by N by default, which would hand back an instrumental a third of the
    level Demucs's own no_vocals.wav has. The three sources add back to (mix − vocals)
    by construction, so the straight sum is the right one and cannot clip a mix that
    didn't."""
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning"]
    for p in parts:
        cmd += ["-i", str(p)]
    cmd += ["-filter_complex",
            f"amix=inputs={len(parts)}:duration=longest:normalize=0",
            "-c:a", "pcm_s16le", str(out_wav)]
    return cmd


def build_encode_cmd(src: Path, out: Path, bitrate: str = STEM_BITRATE) -> list:
    """Build the command that encodes a produced stem from WAV to Opus in the work directory. Exclude cover-art video streams because they are unsupported by the audio encoder; use the configured music bitrate for vocal and instrumental stems."""
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", str(src), "-vn", "-c:a", "libopus", "-b:a", str(bitrate),
            "-vbr", "on", "-application", "audio", str(out)]


def encode_plan(produced: dict, work: Path) -> list:
    """[(stem-name, source-path, opus-path)] for the stems in `produced` worth encoding.

    Skips anything already in the target format, so a re-run is a no-op, and skips names that
    are not stems at all rather than guessing. The caller runs the commands (it owns the
    cancellation and the log), then calls `encoded_produced` to build commit()'s mapping —
    that split is what lets a failed encode keep the WAV instead of losing the audio."""
    out = []
    for name, src in produced.items():
        key = stem_key(name)
        # 🔴 A DERIVED STEM IS NEVER ENCODED (8.4). `stem_key` answers for `lead_solo` now, and
        # without this line the lead would be planned for a libopus pass and committed as
        # `lead_solo.opus` — a filename `find_stem` deliberately REFUSES to resolve, so the file
        # would land and then be invisible. Silent lost audio, in the one file in this store
        # that is a model's training input. Latent today (the lead job commits directly and
        # never routes through here); this is the trap disarmed rather than stepped around.
        if not key or key in DERIVED_EXTS or Path(str(src)).suffix.lower() == STEM_EXT:
            continue
        out.append((key, Path(src), Path(work) / f"{key}{STEM_EXT}"))
    return out


def encoded_produced(produced: dict, plan: list) -> dict:
    """commit()'s mapping after an encode pass: `{stored name: path}`.

    🔴 A STEM WHOSE ENCODE DID NOT LAND KEEPS ITS WAV. The compression is an optimization and
    the audio is the job — Demucs has already run, and there is no version of "ffmpeg was
    unhappy" that is worth answering with an empty set. A mixed set (one Opus stem, one WAV)
    is a perfectly legal set: `find_stem` resolves each one independently."""
    done = {key: opus for key, _src, opus in plan if opus.exists()}
    out = {}
    for name, src in produced.items():
        key = stem_key(name)
        if key and key in done:
            out[f"{key}{STEM_EXT}"] = done[key]
        else:
            out[name] = src
    return out


def commit(dest: Path, produced: dict, meta: dict):
    """Land a finished set atomically. **THE PLAINTEXT → STORE BOUNDARY FOR STEMS** —
    `produced` holds the SCRATCH paths Demucs just wrote.

    A set never appears half-built, and the mechanism for that is unchanged: **the sidecar is
    the last write.** Every reader keys on it — `find_dir` and `list_sets` require it to exist,
    `find_by_hash` reads it strict — so a folder of stems with no sidecar "does not count as a
    set anywhere". A crashed job is invisible, not corrupt.

    A set that already exists is EXTENDED, not replaced — that's what makes a 4-stem
    split of an already-2-stem song add drums/bass/other to the same folder instead of
    forking a second one.

    Refuses to land on a set whose sidecar exists and will not parse. find_by_hash reads
    strict precisely so we never get here — but this is the line that actually destroys, and a
    destroy site that trusts its caller to have checked is a destroy site waiting for the next
    caller.

    🔴🔴 M7 — THE `.part` DIRECTORY HAD TO GO, AND FINDING OUT WHY WAS THE WHOLE MILESTONE.

    It assembled the set in a `<dest>.part` sibling and finished with ONE `os.replace` of the
    DIRECTORY. On a real filesystem that is the correct, idiomatic, textbook way to do this. In
    the vault it is a catastrophe:

        `_enc_name` binds every filename to its logical PARENT (§3.6 — it is what stops
        `chapter1.mp3` in two books encrypting identically). **So renaming a directory
        re-parents its children, and not one of them decrypts any more.**

    Verified by doing it: assemble in `<dest>.part`, rename the folder, and `listdir` comes back
    EMPTY while every read raises FileNotFoundError. The files are still on disk. They are simply
    unnameable, forever. **Twenty minutes of Demucs GPU lands as an empty set, and commit()
    reports success.** `vault.rename()` now REFUSES a directory outright so nobody can walk into
    this again — and it has to, because it used to at least be LOUD (an orphaned child raised
    VaultAuthError from listdir) and it is not any more: a crash-orphaned `.part` must not look
    like a wrong key.

    So the files go straight to their final logical paths. Nothing is lost by it: `open_write`
    is already atomic PER FILE (it writes `<name>.part` and replaces on close), and the set's
    visibility was never the directory's atomicity — it was always the sidecar's.
    """
    dest = Path(dest)
    read_meta(dest, strict=True)             # raises rather than land on what it can't read
    vault_fs.mkdir(dest)

    # The sidecar goes LAST, and until it does this folder is not a set to anyone. An existing
    # set is extended: its stems are already in place and simply stay there.
    stale = vault_fs.exists(dest / SIDECAR)
    if stale:
        vault_fs.unlink(dest / SIDECAR, missing_ok=True)   # un-publish before we mutate the set
    try:
        for name, src in produced.items():
            vault_fs.from_scratch(src, dest / name)        # a re-split's fresh copy wins
        write_meta(dest, meta)                             # ← this is what publishes it
    except BaseException:
        # Leave the stems where they are — M2.5's rule. What we must NOT leave is a sidecar
        # claiming a set that is half-rewritten, and we already removed it.
        raise
    return dest


# ── migration: pre-M4 splits ─────────────────────────────────────────────────

def migrate(cfg) -> list:
    """Migrate legacy split folders into the shared stem store without overwriting existing data. Convert the legacy instrumental filename and add the content identity sidecar; retain orphaned stems when their source song is missing."""
    moved = []
    root = Path(cfg.stems_dir)
    for name in sorted(vault_fs.listdir(root)):
        d = root / name
        if not vault_fs.is_dir(d) or not vault_fs.exists(d / SIDECAR):
            continue
        # Strict: migrate WRITES (write_meta, and an os.replace of the whole folder). A
        # sidecar that will not parse has no `h`, which reads exactly like "pre-M4" — so a
        # non-strict read would hand this loop a corrupt set to rewrite and rename.
        try:
            meta = read_meta(d, strict=True)
        except StemsSidecarUnreadable:
            logger.warning(f"stems: …_{_h8_of(d)} has an unreadable sidecar — leaving it "
                           f"exactly as it is (it is not a pre-M4 set, it is unknown)")
            continue
        if meta.get("h"):
            continue                                       # already an M4 set
        legacy = d / LEGACY_INSTRUMENTAL
        if vault_fs.exists(legacy) and not vault_fs.exists(d / "instrumental.wav"):
            vault_fs.rename(legacy, d / "instrumental.wav")     # a FILE rename — fine
        song = _resolve_song(cfg, meta.get("song_ref"))
        if song is None:
            logger.warning(f"stems: …_{_h8_of(d)} predates M4 and its song is gone — "
                           f"keeping the stems, but it can no longer be found by song")
            continue
        h = song_id(cfg, song)                    # the front door (M4) — memoized, same number
        meta.update({"h": h, "song_h": h, "source": "demucs",
                     "model": meta.get("model") or DEMUCS_MODEL})
        meta.pop("mode", None)                    # mode is now read off the files
        write_meta(d, meta)
        want = root / set_ref(meta.get("song") or song.stem, h)
        d_was = d
        if want != d and not vault_fs.exists(want):
            # 🔴 This was `os.replace(d, want)` — a DIRECTORY rename, and in the vault that
            # orphans every file inside it (each name is encrypted against its parent). Copy the
            # files across and publish the new set with its sidecar, exactly as commit() does;
            # then drop the old folder. vault.rename() refuses a directory outright now, so this
            # would raise rather than lose the stems — but raising at startup is not a fix.
            vault_fs.mkdir(want)
            for f in stem_files(d):
                vault_fs.rename(f, want / f.name)              # per-FILE: names re-encrypt
            write_meta(want, meta)                             # publishes it
            vault_fs.rmtree(d)
            # 🔴 THE REF IS THE FOLDER NAME, SO THIS MOVE IS A REKEY (8.9.7). A virtual folder
            # assignment is keyed on `ref`, and a set that changes name here would leave its
            # folder with nothing reporting it — the exact silent unfiling `folders.RENAME_MOVES_REF`
            # exists to make impossible. The window is narrow (a set can only be filed once it is
            # LISTED, and a listed set has normally migrated already) but "narrow" is how the star
            # went unnoticed from 6.2 to 8.8.6. `rekey` is a no-op that writes nothing when the
            # old ref was never filed, so the common startup path is unchanged.
            folders.rekey(paths.FOLDERS.parent, "stems_library", d_was.name, want.name)
            d = want
        moved.append(d.name)
        logger.info(f"stems: migrated …_{_h8_of(d)} into the M4 store (h={h[:8]})")
    return moved


def _resolve_song(cfg, ref):
    """'<source>/<file>' → path, for the two song sources. Local to the migration:
    voiceswap.song_path is the general resolver, and importing it here would put a
    cycle back into the module that exists to avoid one."""
    m = re.fullmatch(r"(acestep|uploads)/([^/\\]+)", str(ref or ""))
    if not m:
        return None
    base = cfg.acestep_dir if m.group(1) == "acestep" else cfg.songs_dir
    p = Path(base) / m.group(2)
    # acestep -> /ai-output (gocryptfs's, routes to None -> a plain check). uploads -> ours.
    return p if vault_fs.exists(p) else None
