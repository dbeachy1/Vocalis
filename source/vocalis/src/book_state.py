#!/usr/bin/env python3
"""Per-book metadata sidecar and state helpers. The sidecar records render parameters and per-chapter status, voice, and duration; it drives the Output and Library views, mismatch warnings, and voice-change guard."""
import datetime
import re
import subprocess
import threading
from pathlib import Path

import yaml
from loguru import logger

import mp3_concat
import scratch
import vault_fs
from tts_utils import atomic_replace, ffprobe_duration

SIDECAR_NAME = "vocalis-book.yaml"

# Sidecar writes are load-modify-write; two threads updating one book's sidecar
# (a running render's update_chapter racing a second job's init_sidecar) would
# silently drop one writer's changes. One lock per book serializes them.
_SIDECAR_LOCKS: dict = {}
_SIDECAR_LOCKS_GUARD = threading.Lock()


def _sidecar_lock(out_dir) -> threading.Lock:
    key = str(Path(out_dir).resolve())
    with _SIDECAR_LOCKS_GUARD:
        lock = _SIDECAR_LOCKS.get(key)
        if lock is None:
            lock = _SIDECAR_LOCKS[key] = threading.Lock()
        return lock


def sidecar_path(out_dir) -> Path:
    return Path(out_dir) / SIDECAR_NAME


def _natkey(stem: str):
    """Sort key ordering by the leading numeric index, so '99_x' precedes '100_x'
    (lexical sort would scramble any book with >= 100 chapters)."""
    m = re.match(r'(\d+)', stem)
    return (int(m.group(1)) if m else 1 << 62, stem)


def _now() -> str:
    return datetime.datetime.now().replace(microsecond=0).isoformat()


class SidecarUnreadable(Exception):
    """A book's sidecar exists but will not parse. Writers must ABORT on this, never start
    a render from the empty map.

    Same shape, same reason as playground_clips.ClipSidecarUnreadable. The sidecar is the
    only record of which chapters are DONE, what voice made them, how long they are, when
    the book was started and how long it runs. init_sidecar read a failure as ABSENCE and
    rebuilt from {} — resetting every chapter to `pending`, dropping `created` and
    `total_duration_s`. The MP3s survive (a chapter is skipped because its MP3 exists, not
    because the sidecar says so), and everything the sidecar knew about them does not."""


def load_sidecar(out_dir, *, strict: bool = False):
    """Return the sidecar dict, or None if absent. strict=True raises SidecarUnreadable
    when it is present but corrupt, instead of reporting it as absent.

    Locked: on Windows, an open READ handle makes a concurrent writer's os.replace
    fail (WinError 5 — no delete-sharing on Python's open()), and a hot reader (the
    UI polling /book/status every 50ms-2s) can exhaust atomic_replace's whole retry
    budget and kill the render thread mid-job. Serializing same-process reads with
    writers under the per-book lock closes that entirely; POSIX never needed it but
    is unharmed. Callers already holding the lock use _load_sidecar_unlocked."""
    with _sidecar_lock(out_dir):
        return _load_sidecar_unlocked(out_dir, strict=strict)


def _load_sidecar_unlocked(out_dir, *, strict: bool = False):
    """ABSENT is not CORRUPT: a book with no sidecar yet returns None under both, because
    there is nothing there to destroy and init_sidecar must be free to create one."""
    p = sidecar_path(out_dir)
    if not vault_fs.exists(p):
        return None
    try:
        data = yaml.safe_load(vault_fs.read_text(p))
    # A VaultAuthError is a BaseException and passes straight through this: it must NOT become a
    # SidecarUnreadable and must NOT degrade to None. `None` here means ABSENT, and absent resets
    # every chapter to pending and wipes the titles.
    except Exception as exc:                                   # noqa: BLE001
        # NOT {p}: the sidecar sits in a directory named after the BOOK, and
        # logs/vocalis.log sits outside the vault.
        logger.exception("book sidecar unreadable")
        if strict:
            raise SidecarUnreadable(str(exc)) from exc
        return None
    if isinstance(data, dict):
        return data
    if strict:
        raise SidecarUnreadable(f"the sidecar is not a mapping ({type(data).__name__})")
    return None


def write_sidecar(out_dir, data: dict):
    """Locked write (see load_sidecar). Callers already holding the per-book lock
    use _write_sidecar_unlocked."""
    with _sidecar_lock(out_dir):
        _write_sidecar_unlocked(out_dir, data)


def _write_sidecar_unlocked(out_dir, data: dict):
    vault_fs.write_yaml_atomic(sidecar_path(out_dir), data)


def voice_mtime(voice_path) -> int:
    from tts_utils import source_stat        # the identity seam: voice_samples/ is in the vault
    try:
        st = source_stat(voice_path)
        return int(st[1]) if st else 0
    except Exception:
        return 0


def init_sidecar(out_dir, source_docx: str, voice: str, voice_path, params: dict, sections: list,
                 source_docx_path: str = None, enhance: bool = False,
                 enhance_nfe: int = None) -> dict:
    """Create or refresh the sidecar for a run. Preserves per-chapter records for
    chapters already marked done (resume), resets the rest to pending.

    `enhance` is recorded because it is a property of the BOOK, not of a render: an
    audiobook whose chapters 1-3 are dull and 4-12 are crisp is worse than either one
    consistently, so the setting a book was started with is the setting it must finish
    with. The server reads this back to refuse a mid-book flip (see book_enhance_lock)."""
    with _sidecar_lock(out_dir):
        return _init_sidecar_locked(out_dir, source_docx, voice, voice_path, params,
                                    sections, source_docx_path, enhance, enhance_nfe)


def _init_sidecar_locked(out_dir, source_docx, voice, voice_path, params, sections,
                         source_docx_path, enhance=False, enhance_nfe=None):
    # STRICT. This is the one read-modify-write that starts from {}, and starting a render
    # by forgetting what the book already is costs every finished chapter's record: status,
    # voice, duration, `created`, `total_duration_s`. A render must not begin by destroying
    # the ledger of the render before it. Absent still returns None — a book's FIRST render
    # has no sidecar, and that case must keep working.
    existing = _load_sidecar_unlocked(out_dir, strict=True) or {}
    prev = {c.get("index"): c for c in existing.get("chapters", [])}
    chapters = []
    for s in sections:
        old = prev.get(s["index"], {})
        done = old.get("status") == "done"
        chapters.append({
            "index": s["index"], "title": s["title"], "filename": s["filename"],
            "status": old.get("status", "pending") if done else "pending",
            "voice": old.get("voice") if done else None,
            "duration_s": old.get("duration_s") if done else None,
        })
    data = {
        "source_docx": source_docx,
        "source_docx_path": source_docx_path or existing.get("source_docx_path"),
        "created": existing.get("created", _now()),
        "updated": _now(),
        "voice": voice,
        "voice_mtime": voice_mtime(voice_path),
        "params": params,
        "enhance": bool(enhance),
        "enhance_nfe": int(enhance_nfe) if enhance and enhance_nfe else None,
        "total_duration_s": existing.get("total_duration_s"),
        "chapters": chapters,
    }
    # A user title belongs to the book, not to one render. Resume must retain it
    # even when the current voice label or render settings change. Keep the field
    # absent on ordinary books so it remains genuinely optional in the sidecar.
    if isinstance(existing.get("display_name"), str):
        data["display_name"] = existing["display_name"]
    _write_sidecar_unlocked(out_dir, data)
    return data


def _rename_book_unlocked(out_dir, data: dict, name: str) -> dict:
    """Write an explicit title into a strict-read sidecar while its lock is held."""
    data["display_name"] = name
    data["updated"] = _now()
    _write_sidecar_unlocked(out_dir, data)
    return data


def presentation_name(book: str, sidecar: dict, labels: dict) -> tuple[str, str]:
    """Return (friendly book title, current voice label) for API presentation.

    Keep runtime/Flask dependencies out of this state module: the caller supplies
    current voice labels from the configured voice-settings store.
    """
    voice = sidecar.get("voice") if isinstance(sidecar, dict) else None
    voice = voice if isinstance(voice, str) else ""
    label = labels.get(voice, "") if voice else ""
    label = label if isinstance(label, str) else ""
    explicit = sidecar.get("display_name") if isinstance(sidecar, dict) else None
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip(), label

    source = sidecar.get("source_docx") if isinstance(sidecar, dict) else None
    if isinstance(source, str) and source.strip():
        stem = Path(source).stem
    else:
        return book, label
    # The filename-derived narrator remains useful for old sidecars whose current
    # voice has no label. The empty voice is the model default and has no suffix.
    if voice:
        narrator = label or re.sub(
            r"[_ ]*(\d+[_ ]*second[_ ]*)?sample$", "", Path(voice).stem,
            flags=re.I).strip("_ ") or Path(voice).stem
        if narrator:
            stem = f"{stem} ({narrator})"
    return stem, label


def rendered_chapters(out_dir) -> int:
    """How many chapters this book has actually committed to disk. A book with none is
    not yet committed to anything — which is what makes its enhance setting still free to
    change (see book_enhance_lock)."""
    sc = load_sidecar(out_dir) or {}
    return sum(1 for c in sc.get("chapters", []) if c.get("status") == "done")


def book_enhance_lock(out_dir):
    """(enhance, nfe) this book is already committed to, or None if nothing is rendered
    yet and the choice is still open.

    Only a book with finished chapters locks: an empty folder (or one whose render was
    stopped before chapter 1 landed) has nothing to be inconsistent WITH."""
    if not rendered_chapters(out_dir):
        return None
    sc = load_sidecar(out_dir) or {}
    return bool(sc.get("enhance")), sc.get("enhance_nfe")


def update_chapter(out_dir, index: int, *, status: str, voice: str, duration_s):
    with _sidecar_lock(out_dir):
        _update_chapter_locked(out_dir, index, status=status, voice=voice,
                               duration_s=duration_s)


def _update_chapter_locked(out_dir, index: int, *, status: str, voice: str, duration_s):
    data = _load_sidecar_unlocked(out_dir)
    if not data:
        return
    for c in data.get("chapters", []):
        if c.get("index") == index:
            c["status"] = status
            c["voice"] = voice
            c["duration_s"] = duration_s
            break
    data["updated"] = _now()
    _write_sidecar_unlocked(out_dir, data)


def finalize(out_dir, total_duration_s):
    with _sidecar_lock(out_dir):
        _finalize_locked(out_dir, total_duration_s)


def _finalize_locked(out_dir, total_duration_s):
    data = _load_sidecar_unlocked(out_dir)
    if not data:
        return
    data["total_duration_s"] = round(total_duration_s, 1) if total_duration_s else None
    data["updated"] = _now()
    _write_sidecar_unlocked(out_dir, data)


_DURATION_CACHE: dict = {}   # (path, mtime_ns, size) -> seconds


def mp3_duration(mp3_path) -> float:
    """Duration in seconds via ffprobe (tts_utils.ffprobe_duration — the one shared
    probe), or 0.0 if unavailable. Cached by (path, mtime, size): scan_book calls
    this once per chapter on EVERY Output-tab view, and for a sidecar-less
    100-chapter book that was 100 subprocess spawns per page load probing files
    that never change."""
    import scratch as scratch_mod
    from tts_utils import source_stat
    p = Path(mp3_path)
    st = source_stat(p)                 # the identity seam — the LOGICAL (size, mtime)
    if st is None:
        return 0.0
    key = (str(p), st[1], st[0])
    if key in _DURATION_CACHE:
        return _DURATION_CACHE[key]
    try:
        # ffprobe is a CHILD PROCESS: it cannot open a path in the vault, and it answers failure
        # with 0.0 — a chapter of unknown length, silently, on every Output-tab view. The cache
        # above is what keeps this from being a decrypt per chapter per page load.
        with vault_fs.child_input(p, scratch_mod.scratch_root()) as plain:
            secs = ffprobe_duration(plain) or 0.0
    except FileNotFoundError:
        return 0.0                      # no ffprobe on PATH — don't cache; it may appear
    _DURATION_CACHE[key] = secs
    if len(_DURATION_CACHE) > 4096:     # bound it; keys churn only when files change
        _DURATION_CACHE.clear()
    return secs


def _title_from_stem(stem: str) -> str:
    """'00_Chapter_1' -> 'Chapter 1' (best-effort reverse of safe_name for files
    that arrived without a sidecar)."""
    s = re.sub(r'^\d+[_-]', '', stem)
    return s.replace('_', ' ').strip() or stem


def _book_stems(out_dir: Path) -> list:
    """Chapter stems that actually exist on disk (WAV or Opus in the book dir;
    Opus or MP3 in mp3/), excluding the concatenated <book>_full. This is the source of truth —
    a book is whatever audio is in the folder, sidecar or not."""
    out_dir = Path(out_dir)
    stems = set()
    # vault_fs.glob returns LOGICAL names — the chapter titles, decrypted. The `.part` filters
    # still matter: they are the plain-arm temps (an un-migrated box), and in the vault
    # open_write's own `.part` is skipped by listdir before it ever gets here.
    # 7.5.27 — a chapter master is a WAV **or an Opus**. The store held WAV and only WAV, so the
    # extension was the identity; converting a book's masters to Opus without this makes all 43
    # chapters vanish from the tab while every byte is still on disk. Same rule as the stem store:
    # the NAME is the chapter, the extension is how it happens to be kept.
    for ext in ("*.wav", "*.opus"):
        for name in vault_fs.glob(out_dir, ext):
            if name.endswith(".part.wav") or name.endswith(".part.opus"):
                continue                   # in-progress save temp — not a finished chapter
            stem = Path(name).stem
            if not stem.endswith("_full"):
                stems.add(stem)
    for ext in ENCODED_EXTS:
        for name in vault_fs.glob(out_dir / "mp3", f"*{ext}"):
            if name.endswith(f".part{ext}"):
                continue
            stem = Path(name).stem
            if not stem.endswith("_full"):
                stems.add(stem)
    return sorted(stems, key=_natkey)


#: A surviving working file means encoding did not complete. Keep it for retry; it may be the only remaining copy. It is not an archive or reusable master.
CHAPTER_EXTS = (".opus", ".wav")

#: The ENCODED chapter, in `mp3/` — the artifact a finished chapter is supposed to be.
#: `.opus` from 7.5.30; `.mp3` for everything rendered before it. The directory keeps its name
#: because renaming it would break every existing book and every stored chapter URL for nothing.
ENCODED_EXTS = (".opus", ".mp3")


def chapter_encoded(out_dir, stem: str):
    """The encoded chapter in `mp3/`, whichever format, or None."""
    d = Path(out_dir) / "mp3"
    for ext in ENCODED_EXTS:
        p = d / f"{stem}{ext}"
        if vault_fs.exists(p):
            return p
    return None


#: Complete-audiobook containers, in display and legacy-field preference order.
FULL_EXTS = (".opus", ".mp3", ".m4a")


def full_audiobook(out_dir):
    """The concatenated audiobook for this book, whichever container, or None."""
    exports = full_audiobooks(out_dir)
    return Path(out_dir) / exports[0]["file"] if exports else None


def full_audiobooks(out_dir):
    """Every completed full-book export, in the UI's stable format order.

    Paths and sizes are resolved through the vault so encrypted books report logical
    plaintext sizes just like chapter inventory.
    """
    out_dir = Path(out_dir)
    exports = []
    for ext in FULL_EXTS:
        path = out_dir / f"{out_dir.name}_full{ext}"
        st = vault_fs.stat(path)
        if st is not None:
            exports.append({"file": path.name, "size": st.size})
    return exports


def chapter_master(out_dir, stem: str):
    """The lossless-or-compressed master for one chapter, whichever format it is stored in,
    or None. The MP3 in `mp3/` is a separate thing and is not considered here.

    🔴 EVERY READER GOES THROUGH THIS. `_book_stems` finds the chapter, this resolves it, and
    `scan_book` reports `wav` as the real filename rather than reconstructing `stem + ".wav"`.
    Reconstructing is what made a converted book show 43 chapters with no audio: the stems were
    found by the `.opus` glob and then every path built from them pointed at a `.wav` that was
    no longer there."""
    out_dir = Path(out_dir)
    for ext in CHAPTER_EXTS:
        p = out_dir / f"{stem}{ext}"
        if vault_fs.exists(p):
            return p
    return None


def scan_book(out_dir, voice_labels: dict = None) -> dict:
    """Enumerate a book's chapters FROM DISK, overlaying the sidecar (title,
    voice, per-chapter status/duration) when present. Works for books rendered
    by 2.0 (with sidecar) and for audio copied in manually (no sidecar)."""
    out_dir = Path(out_dir)
    sc = load_sidecar(out_dir) or {}
    recorded_voice = sc.get("voice")
    sc_by = {c.get("filename"): c for c in sc.get("chapters", [])}
    rows, total = [], 0.0
    for i, stem in enumerate(_book_stems(out_dir)):
        mp3 = chapter_encoded(out_dir, stem)         # .opus or .mp3 — whichever this one is
        wav = chapter_master(out_dir, stem)          # the working file, if the encode failed
        mp3_st = vault_fs.stat(mp3) if mp3 is not None else None
        wav_st = vault_fs.stat(wav) if wav is not None else None   # LOGICAL sizes, or None
        scc = sc_by.get(stem, {})
        # The sidecar is written at render time and can become stale. Count actual files and measured durations so the UI reports the completed output.
        src = mp3 if mp3_st else (wav if wav_st else None)
        probed = round(mp3_duration(src), 1) if src is not None else None
        dur = probed if probed else scc.get("duration_s")
        total += dur or 0
        voice = scc.get("voice") or recorded_voice
        rows.append({
            # TRUE section index from the sidecar, not the on-disk enumerate position:
            # the regenerate button POSTs this as the section, and book_regenerate
            # matches it against the sidecar's c["index"]. When on-disk chapters aren't
            # a contiguous 0..k-1 prefix (a deleted file, or a section that rendered no
            # audio), the positions diverge and the wrong chapter gets regenerated.
            "index": scc.get("index", i),
            "title": scc.get("title") or _title_from_stem(stem),
            "filename": stem,
            "status": scc.get("status", "done"),          # on disk => done
            "voice": voice,
            "mismatch": bool(voice and recorded_voice and voice != recorded_voice),
            # LOGICAL sizes. A raw stat reports the CIPHERTEXT size of every chapter, in the
            # Output tab, on every view — wrong by 16 bytes a block and nothing ever failing.
            "size": (mp3_st.size if mp3_st else wav_st.size if wav_st else None),
            "duration_s": dur,
            "mp3": mp3.name if mp3_st else None,      # the REAL filename, .opus or .mp3
            "wav": wav.name if wav_st else None,      # the REAL filename, .opus or .wav
            # Report encoded and working-file sizes separately. A large WAV can remain after encoding fails even when the encoded-size column is small.
            "wav_size": wav_st.size if wav_st else None,
            "mp3_size": mp3_st.size if mp3_st else None,
            # What the SIDECAR claimed, kept beside the measurement so a disagreement is
            # visible rather than silently resolved in favor of one of them.
            "duration_claimed": scc.get("duration_s"),
        })
    full_audiobooks_found = full_audiobooks(out_dir)
    full = (out_dir / full_audiobooks_found[0]["file"]
            if full_audiobooks_found else None)
    display_name, voice_label = presentation_name(out_dir.name, sc, voice_labels or {})
    render_metadata = (
        isinstance(sc.get("source_docx"), str)
        or isinstance(sc.get("voice"), str)
        or isinstance(sc.get("params"), dict)
        or isinstance(sc.get("chapters"), list)
    )
    return {
        "book": out_dir.name,
        "display_name": display_name,
        "voice_label": voice_label,
        "voice": recorded_voice,
        "params": sc.get("params"),
        "source_docx": sc.get("source_docx"),
        "has_sidecar": vault_fs.exists(sidecar_path(out_dir)),
        "has_render_metadata": render_metadata,
        "enhance": bool(sc.get("enhance")),
        "enhance_nfe": sc.get("enhance_nfe"),
        # Build the total from measured chapter durations rather than the cached sidecar summary, which may be stale.
        "total_duration_s": round(total, 1),
        "total_claimed_s": sc.get("total_duration_s"),
        "chapters": rows,
        # The single audiobook, whichever container it is in (7.5.27). The key keeps its name
        # so nothing that reads it has to change; what it holds is now the REAL filename.
        "full_mp3": full.name if full is not None else None,
        "full_audiobooks": full_audiobooks_found,
        # What the book actually costs, split by what you can get back (7.5.27).
        "wav_bytes": sum(r["wav_size"] or 0 for r in rows),
        "mp3_bytes": sum(r["mp3_size"] or 0 for r in rows),
        "full_size": full_audiobooks_found[0]["size"] if full_audiobooks_found else None,
        # Chapters whose WAV is the ONLY copy. These are what the reclaim must never touch, and
        # the count is shown so "reclaim" can say what it is leaving behind rather than quietly
        # doing less than the number above implies.
        "wav_only": sum(1 for r in rows if r["wav_size"] and not r["mp3_size"]),
    }


def convert_chapter_masters(out_dir, bitrate: str = "192k", progress=None) -> dict:
    """Re-encode this book's WAV chapter masters to Opus, in place. Returns what changed.

    🔴 THIS RUNS INSIDE THE SERVICE, AND THAT IS THE WHOLE POINT. The book tree is encrypted at
    the application layer and the key lives in the memory of the running Vocalis process. A
    standalone CLI script is a DIFFERENT process with no key: it sees base64 filenames and reports
    an empty book, which looks exactly like "your files are gone". Nothing outside this process
    can do this job, so it is a route and a button rather than a script.
    (gocryptfs is unrelated and is not what "encrypted" means here.)

    🔴 WRITE, VERIFY, THEN DELETE. ffmpeg exiting 0 is not proof it produced audio — a killed
    child leaves a truncated or empty file — so the Opus replacement is stat'd in the store
    before the WAV is unlinked. Backward, a bad encode costs a chapter of an eleven-hour
    audiobook that exists nowhere else.

    ⚠️ Deliberately different from `reclaim_chapter_wavs`: that one DELETES masters, so it refuses
    any chapter whose WAV is the only copy. This one REPLACES a master with a smaller master, so
    "only copy" is not a reason to leave 100 MB of WAV on the disk. Never touches `mp3/<stem>.mp3`
    or `<book>_full.mp3`.
    """
    out_dir = Path(out_dir)
    done, failed, before_total, after_total = [], [], 0, 0
    rows = [r for r in scan_book(out_dir)["chapters"]
            if r["wav"] and r["wav"].lower().endswith(".wav")]
    for i, r in enumerate(rows, 1):
        master = out_dir / r["wav"]
        dest = master.with_suffix(".opus")
        if progress:
            progress(i, len(rows), r["filename"])
        st = vault_fs.stat(master)
        before = st.size if st else 0
        try:
            root = scratch.scratch_root()
            with scratch.file(root, f"bookconv-in|{master}", master.suffix) as src_tmp, \
                    scratch.file(root, f"bookconv-out|{master}", ".opus") as out_tmp:
                src_tmp.write_bytes(vault_fs.read_bytes(master))
                res = subprocess.run(
                    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                     "-i", str(src_tmp), "-vn", "-c:a", "libopus", "-b:a", str(bitrate),
                     "-vbr", "on", "-application", "audio", str(out_tmp)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace")
                if res.returncode != 0 or not out_tmp.exists() or out_tmp.stat().st_size < 1024:
                    raise RuntimeError(res.stderr.strip()[:200] or "ffmpeg produced no audio")
                vault_fs.from_scratch(out_tmp, dest)
            ns = vault_fs.stat(dest)
            if ns is None or ns.size < 1024:                  # the verify — see the docstring
                raise RuntimeError("the encoded chapter did not land in the store")
            vault_fs.unlink(master, missing_ok=True)
            done.append(r["filename"])
            before_total += before
            after_total += ns.size
        except Exception as exc:                              # noqa: BLE001
            # One bad chapter must not abandon the other forty-two. The WAV is untouched by
            # construction, so this is safe to carry on from.
            logger.warning(f"book master convert failed for one chapter: {exc}")
            failed.append(r["filename"])
    return {"converted": done, "failed": failed,
            "before_bytes": before_total, "after_bytes": after_total,
            "freed_bytes": max(0, before_total - after_total)}


def finish_chapters(out_dir, bitrate: str = "192k", progress=None) -> dict:
    """Finish encoding chapters that have a working WAV or Opus file but no encoded counterpart. Promote compatible Opus files without another lossy encode; encode WAV files normally. Never remove the working copy until a nonempty encoded file is verified, and never modify chapters that already have an encoded file."""
    out_dir = Path(out_dir)
    promoted, encoded, failed = [], [], []
    rows = [r for r in scan_book(out_dir)["chapters"] if r["wav"] and not r["mp3"]]
    for i, r in enumerate(rows, 1):
        work = out_dir / r["wav"]
        if progress:
            progress(i, len(rows), r["filename"])
        try:
            if work.suffix.lower() == ".opus":
                dest = out_dir / "mp3" / f"{Path(r['wav']).stem}.opus"
                vault_fs.mkdir(out_dir / "mp3")
                vault_fs.rename(work, dest)
                st = vault_fs.stat(dest)
                if st is None or st.size < 1024:
                    raise RuntimeError("the promoted chapter is not in the store")
                promoted.append(r["filename"])
            else:
                from tts_utils import wav_to_opus
                dest = wav_to_opus(work, bitrate=bitrate)
                st = vault_fs.stat(dest)
                if st is None or st.size < 1024:
                    raise RuntimeError("the encoded chapter is not in the store")
                vault_fs.unlink(work, missing_ok=True)
                encoded.append(r["filename"])
        except Exception as exc:                                   # noqa: BLE001
            logger.warning(f"finishing a chapter failed: {exc}")
            failed.append(r["filename"])
    return {"promoted": promoted, "encoded": encoded, "failed": failed,
            "finished": len(promoted) + len(encoded)}


def reclaim_chapter_wavs(out_dir, dry_run: bool = False) -> dict:
    """Delete chapter WAVs only when a nonempty encoded counterpart exists. With dry_run enabled, report planned removals without deleting. Return removed and retained names and byte totals; preserve WAV-only chapters and the concatenated audiobook."""
    out_dir = Path(out_dir)
    info = scan_book(out_dir)
    freed, kept, gone = 0, [], []
    for r in info["chapters"]:
        if not r["wav"]:
            continue
        if not r["mp3"]:
            kept.append(r["filename"])          # the only copy — leave it exactly where it is
            continue
        if not dry_run:
            vault_fs.unlink(out_dir / r["wav"], missing_ok=True)
        freed += r["wav_size"] or 0
        gone.append(r["filename"])
    return {"deleted": gone, "kept_only_copy": kept, "freed_bytes": freed,
            "dry_run": bool(dry_run)}


def scan_library(output_dir, voice_labels: dict = None) -> list:
    """Every book on disk: any output/ subfolder that contains audio, whether or
    not it has a sidecar. Sidecar (if present) enriches voice/duration."""
    output_dir = Path(output_dir)
    books = []
    for name in vault_fs.listdir(output_dir):
        d = output_dir / name
        if not vault_fs.is_dir(d):
            continue
        if name == "playground":               # reserved: the Playground clip library (2.3), not a book
            continue
        stems = _book_stems(d)
        sc = load_sidecar(d) or {}
        # A folder with chapter audio OR a sidecar is a book. Sidecar-only = a render
        # stopped before its first chapter finished — it must STAY listed (browse it,
        # resume it later), not vanish the moment the render stops.
        if not stems and not sc:
            continue
        done = len([c for c in sc.get("chapters", []) if c.get("status") == "done"])
        # "last rendered" = the newest AUDIO artifact mtime. The rglob is spelled out because a vault
        # directory cannot be rglob'd — its entry names are ciphertext on disk and only
        # listdir() reads them back. A book is exactly two levels deep (<book>/*.wav and
        # <book>/mp3/*.mp3), so this is the whole tree, not a simplification of it.
        try:
            mtimes = []
            # Count WAV-only chapters from the existing listing to avoid another filesystem scan, and surface failed encodes in the book status.
            top, enc = set(), set()
            for sub, bucket in ((d, top), (d / "mp3", enc)):
                for name in vault_fs.listdir(sub):
                    is_audio = Path(name).suffix.lower() in (*CHAPTER_EXTS, *ENCODED_EXTS)
                    stem = Path(name).stem
                    is_audio = is_audio and not stem.endswith(".part")
                    if is_audio:
                        st = vault_fs.stat(sub / name)
                        if st is not None:
                            mtimes.append(st.mtime)
                    if is_audio and not stem.endswith("_full") and not stem.endswith(".part"):
                        bucket.add(stem)
            unencoded = len(top - enc)
            rendered_at = max(mtimes, default=0)
        except OSError:
            rendered_at = 0
            unencoded = 0
        display_name, voice_label = presentation_name(d.name, sc, voice_labels or {})
        has_sidecar = vault_fs.exists(sidecar_path(d))
        # Surface all completed whole-book exports on the shelf itself. The first entry also
        # backs the legacy single-file fields shared with scan_book.
        full_audiobooks_found = full_audiobooks(d)
        full = (d / full_audiobooks_found[0]["file"]
                if full_audiobooks_found else None)
        render_metadata = (
            isinstance(sc.get("source_docx"), str)
            or isinstance(sc.get("voice"), str)
            or isinstance(sc.get("params"), dict)
            or isinstance(sc.get("chapters"), list)
        )
        books.append({
            "book": d.name,
            "display_name": display_name,
            "voice_label": voice_label,
            "source_docx": sc.get("source_docx"),
            "voice": sc.get("voice"),
            # With a sidecar the REAL total is its chapter list — a mid-render book
            # shows "3/26", not "3/3". No sidecar: whatever audio is on disk.
            "chapters": (len(sc["chapters"]) if sc.get("chapters") else len(stems)),
            # With a usable sidecar report the real done count (a mid-render book
            # must NOT look complete). No sidecar — or one whose chapters list is
            # empty/missing — falls back to "everything on disk is done".
            "done": (done if (sc and sc.get("chapters")) else len(stems)),
            "total_duration_s": sc.get("total_duration_s"),
            "updated": sc.get("updated"),
            "rendered_at": rendered_at,
            "has_sidecar": has_sidecar,
            "has_render_metadata": render_metadata,
            # Chapters with a working file but no encoded one — i.e. the encode failed and the
            # WAV was kept as the only copy. The card shows it; "43/43" alone was a lie.
            "unencoded": unencoded,
            # Keep the scan_book field names for compatibility: both resolve the actual
            # container (Opus or MP3), and size is the logical file size through vault_fs.
            "full_mp3": full.name if full is not None else None,
            "full_audiobooks": full_audiobooks_found,
            "full_size": full_audiobooks_found[0]["size"] if full_audiobooks_found else None,
        })
    return books


def concat_book_mp3(out_dir, book_slug: str) -> Path:
    """Concatenate all encoded chapter files in filename order into `<book>_full.mp3` using ffmpeg stream copy. Return the output path and raise on missing audio or ffmpeg failure. Feed the concat list through stdin and stage decrypted inputs under opaque names so chapter titles do not persist in scratch files or reach ffmpeg as arguments."""
    out_dir = Path(out_dir)
    mp3_dir = out_dir / "mp3"
    names = [n for ext in ENCODED_EXTS for n in vault_fs.glob(mp3_dir, f"*{ext}")
             if not Path(n).stem.endswith("_full") and not n.endswith(f".part{ext}")]
    names.sort(key=lambda n: _natkey(Path(n).stem))   # chapter order, 100 after 99 (not lexical)
    if not names:
        raise FileNotFoundError("no per-chapter MP3s to concatenate")
    # Reject incomplete chapter sets; a partial concatenation must not be reported as a complete audiobook.
    have = {Path(n).stem for n in names}
    missing = [s for s in _book_stems(out_dir) if s not in have]
    if missing:
        raise FileNotFoundError(
            f"only {len(have)} of {len(have) + len(missing)} chapters have an MP3 — "
            f"this would build a {len(have)}-chapter audiobook and call it the book. "
            f"Build the Opus audiobook instead (it uses the chapter masters), or re-render "
            f"the {len(missing)} chapters that have no MP3")

    # Every chapter is 96 kbps mono (`wav_to_mp3` → `enhance.MP3_BITRATE_PLAIN`), which is what
    # makes the stream copy valid — see concat_mp3's docstring on who owns that question.
    return mp3_concat.concat_mp3([mp3_dir / n for n in names],
                                 out_dir / f"{book_slug}_full.mp3")


SINGLE_BOOK_BITRATES = (64, 96, 128, 160, 192)


def concat_book(out_dir, book_slug: str, fmt: str = "opus", bitrate: str = "192k") -> Path:
    """Build one audiobook in Opus, MP3, or AAC/M4A from every chapter.

    🔴 IT SOURCES FROM THE CHAPTER MASTERS, NOT THE MP3s. The masters are the WAVs (or already
    Opus); the `mp3/` copies are finished chapter audio and may be Opus or MP3. Prefer masters
    when present to preserve their quality, then fall back to either encoded format for books
    whose masters have been reclaimed.

    ⚠️ A book part-way through a master conversion has some `.opus` chapters and some `.wav`.
    That is a legal state (the converter goes one chapter at a time), and the normalized concat
    filter handles those different sources while encoding the requested audiobook settings.

    Every format passes through the shared concat filter and encoder, so the selected bitrate
    and mono output apply even when every source is already Opus.
    """
    specs = {
        "opus": (".opus", "libopus", []),
        "mp3": (".mp3", "libmp3lame", []),
        "aac": (".m4a", "aac", ["-movflags", "+faststart"]),
    }
    if fmt not in specs:
        raise ValueError(f"unsupported audiobook format: {fmt}")
    ext, codec, extra = specs[fmt]
    if bitrate not in {f"{rate}k" for rate in SINGLE_BOOK_BITRATES}:
        raise ValueError(f"unsupported audiobook bitrate: {bitrate}")
    out_dir = Path(out_dir)
    stems = _book_stems(out_dir)
    srcs, missing = [], []
    for stem in stems:
        m = chapter_master(out_dir, stem)
        if m is None:
            m = chapter_encoded(out_dir, stem)
            if m is None:
                missing.append(stem)
                continue
        srcs.append(m)
    if not srcs:
        raise FileNotFoundError("no chapter audio to concatenate")
    # A requested chapter without audio is a hard failure, not a reason to silently shorten the output.
    if missing:
        raise FileNotFoundError(
            f"{len(missing)} of {len(stems)} chapters have no audio at all "
            f"({', '.join(missing[:3])}{'…' if len(missing) > 3 else ''}) — "
            f"re-render them, or delete them from the book, before building the audiobook")
    encode = ["-c:a", codec, "-b:a", bitrate, "-ac", "1", *extra]
    if fmt == "opus":
        encode += ["-vbr", "on", "-application", "audio"]
    return mp3_concat.concat_mp3(srcs, out_dir / f"{book_slug}_full{ext}", encode=encode)


def concat_book_opus(out_dir, book_slug: str, bitrate: str = "192k") -> Path:
    """Compatibility wrapper for callers that explicitly request the legacy Opus helper."""
    # Preserve the helper's historical stream-copy behavior for all-Opus sources. The product
    # route uses concat_book directly and always encodes at the selected rate.
    out_dir = Path(out_dir)
    stems = _book_stems(out_dir)
    srcs, all_opus, missing = [], True, []
    for stem in stems:
        m = chapter_master(out_dir, stem) or chapter_encoded(out_dir, stem)
        if m is None:
            missing.append(stem)
            continue
        all_opus = all_opus and m.suffix.lower() == ".opus"
        srcs.append(m)
    if missing:
        raise FileNotFoundError(f"{len(missing)} of {len(stems)} chapters have no audio")
    encode = None if all_opus else ["-c:a", "libopus", "-b:a", str(bitrate),
                                    "-vbr", "on", "-application", "audio"]
    return mp3_concat.concat_mp3(srcs, out_dir / f"{book_slug}_full.opus", encode=encode)
