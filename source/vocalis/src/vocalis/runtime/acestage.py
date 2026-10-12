"""Stage plaintext audio in a directory accepted by the ACE-Step backend.

The backend validates audio paths against its temporary directory, so staged paths must resolve
under that directory, including when it is configured through a symlink. The staging directory
may be on a filesystem-encrypted mount, but files there are not protected by the application's
vault encryption; the backend must not receive the vault key.

References are shared by jobs dispatched to multiple cards. Staging names are deterministic and
files are retained for a bounded age instead of being deleted when one job finishes. The sweep
only removes this module's opaque filenames; the backend's `api_audio/` tree contains active
results and is outside this module's ownership. `stage()` verifies the staged file is non-empty
because the backend can silently ignore unreadable or invalid reference audio.

Files in `api_audio/` are removed by `acecands`, which knows which candidates still refer to them
(`output_dir()` below names the folder). That is not a staging sweep: age says nothing about
whether a song is still in the tray.
"""
from __future__ import annotations

import os
import shutil
import stat
import time
from pathlib import Path

from loguru import logger

import vault_fs
from scratch import opaque_name

ENV_VAR = "VOCALIS_ACESTEP_STAGE_DIR"

#: The ACE-Step service sets `ACESTEP_TMPDIR` to this, and `lifespan_runtime` promotes it to
#: `TMPDIR`. Shared between the two units on purpose: a generate job carries `rebuild=True` and
#: re-resolves onto whichever card takes it, so a per-card staging path would break re-resolution.
DEFAULT_STAGE_DIR = "/ai-output/acestep-tmp"

#: How long a staged file survives. Generous because the only cost of keeping one is disk inside
#: an already-encrypted mount, and the cost of dropping one early is a render that silently loses
#: its reference. A day covers any plausible queue.
STAGE_TTL_H = 24

#: The backend's own output tree, and anything else that is not a bare `<16 hex><suffix>` file.
#: Named so the sweep can say what it is skipping rather than merely skipping it.
BACKEND_SUBDIR = "api_audio"


def stage_root(app_settings: dict = None) -> Path:
    """Where staged audio goes: env var → app_settings `acestep: stage_dir:` → the configured default.

    The same precedence every other studio path in this app uses, deliberately, so there is one
    rule to remember. It is a config value and nothing more — on a dev box with no ACE-Step
    backend it can point anywhere writable, and nothing here behaves differently.
    """
    s = (app_settings if app_settings is not None else _app_settings()).get("acestep")
    if not isinstance(s, dict):          # a hand-edited `acestep: "oops"` must not raise here
        s = {}
    return Path(os.environ.get(ENV_VAR) or s.get("stage_dir") or DEFAULT_STAGE_DIR)


def output_dir():
    """The engine's output folder (`<stage root>/api_audio`), or None when it is not certain that
    the engine writing there is the child Vocalis starts. A pass that deletes files must not guess.

    The child takes its work folder from `VOCALIS_ACESTEP_STAGE_DIR` (`runtime/acestep.py`), and
    that variable is also the first thing `stage_root()` reads, so with it set the two sides name
    the same folder. With it unset they fall back to different defaults (`/ai-output/acestep-tmp`
    here, `/work/vocalis/acestep` in the child), so the folder is not assumed to be the engine's.
    None as well when the folder is missing, or is itself a link: a link could lead anywhere.
    """
    root = os.environ.get(ENV_VAR)
    if not root:
        return None
    out = Path(root) / BACKEND_SUBDIR
    if out.is_symlink() or not out.is_dir():
        return None
    return out


def _app_settings() -> dict:
    # Imported here rather than at module scope: `settings` reaches the store, and this module is
    # imported by `acegen`'s caller during boot.
    from vocalis.runtime import settings
    return settings.load_app_settings() or {}


def staged_name(src, suffix: str = "") -> str:
    """The name `src` always stages under. Deterministic — see the header on why it must be.

    Opaque by the same construction as `scratch.opaque_name` and `vault.decrypt_to_scratch`, so
    plaintext produced by this module is indistinguishable on disk from plaintext produced by
    either of those. The words must never arrive as filenames (`src/scratch.py` §1), and a stem
    set's directory name carries the song title.
    """
    return opaque_name(f"acestage|{src}", suffix or Path(str(src)).suffix)


def stage(src, *, root=None) -> str:
    """Materialize `src` where the backend can read it. Returns an absolute POSIX path.

    Raises `FileNotFoundError` if the source is gone and `OSError` if the copy did not land —
    never a path this has not confirmed. See the header: the backend swallows a bad reference
    without a word, so an unverified return here would surface as "the reference did nothing"
    with no error anywhere to explain it.

    `vault_fs.to_scratch` returns the original path for anything outside the vault, which is
    the correct answer for its own callers and the wrong one here — an /ai-output song is already
    plaintext but it is not inside the backend's tempdir, so it still needs copying in. The
    `dst.exists()` fast path is what stops that copy repeating on every press.
    """
    src = Path(src)
    root = Path(root) if root is not None else stage_root()
    root.mkdir(parents=True, exist_ok=True)
    dst = root / staged_name(src)

    # Already staged and non-empty: reuse it. A reference is picked once and rendered with fifty
    # times, and re-decrypting it per press is the waste the deterministic name exists to avoid.
    try:
        if dst.is_file() and dst.stat().st_size > 0:
            os.utime(dst, None)           # keep a reference in active use out of the sweep
            return dst.as_posix()
    except OSError:
        pass                              # unreadable for any reason -> fall through and re-make

    if not vault_fs.exists(src):
        raise FileNotFoundError(f"the reference clip is no longer in the library")

    # `to_scratch` decrypts INTO `root` under its own opaque name when the source is vault-backed,
    # and hands back `src` untouched when it is not. Both arms end with a plaintext path; only the
    # second one still needs moving.
    made = Path(vault_fs.to_scratch(src, root))
    if made != dst:
        try:
            # Write beside the destination, then replace atomically. A partial copy must not land
            # under the deterministic name, because the fast path would reuse it on later calls.
            # The temporary name also matches the sweep's ownership pattern if a crash leaves it.
            tmp = root / staged_name(f"part|{src}|{os.getpid()}|{time.time_ns()}",
                                     Path(str(src)).suffix)
            try:
                shutil.copyfile(made, tmp)
                os.replace(tmp, dst)
            finally:
                tmp.unlink(missing_ok=True)
        finally:
            # Only if `to_scratch` made it. Its own contract: the result is not the caller's to
            # delete when it is the original file, and that original is the user's actual stem.
            if made != src:
                made.unlink(missing_ok=True)

    if not (dst.is_file() and dst.stat().st_size > 0):
        raise OSError(f"the reference clip could not be staged for ACE-Step")
    return dst.as_posix()


def sweep(root=None, ttl_h: float = STAGE_TTL_H) -> int:
    """Delete staged files older than `ttl_h`. Returns how many went.

    Called at startup and after each Generate. Cheap: one `listdir` of a directory that holds a
    handful of entries, against a store whose files are minutes to hours apart.

    Remove only opaque filenames created by this module. The backend's `api_audio/` directory
    contains results being collected and is not part of the staging sweep.
    """
    root = Path(root) if root is not None else stage_root()
    if not root.is_dir():
        return 0
    cutoff = time.time() - max(0.0, float(ttl_h)) * 3600.0
    n = 0
    for p in root.iterdir():
        if p.is_dir() or not _is_ours(p.name):
            continue
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
                n += 1
        except OSError:                   # a handle still open; the next sweep gets it
            continue
    if n:
        # The count only. A staged name is a hash, and the count is the useful number anyway.
        logger.info(f"acestage: swept {n} staged reference(s) older than {ttl_h}h")
    return n


#: Audio suffixes the engine's `tempfile` leftovers carry. A positive list on purpose: the stage
#: root also holds the engine's own sub-folders, and anything that is not plainly audio is kept.
_LOOSE_AUDIO = frozenset({".flac", ".wav", ".mp3", ".ogg", ".opus", ".m4a", ".aac"})


def sweep_loose() -> int:
    """Delete the engine's loose audio files directly under the stage root. Returns how many went.

    (2026-10-11) `tempfile.tempdir` points the engine's temporary files at the stage root, and it
    never removes the audio ones it leaves (a FLAC and a WAV were found in a two-day-old test
    install). They are plain audio nobody can use again. Run once, at process start, BEFORE any
    ACE-Step child of this process exists: a child could be writing one this instant, and a
    process start is the only moment that cannot be the case. Everything Vocalis itself writes
    here has an opaque `_is_ours` name (`stage`, `_stage_candidate`, `vault.decrypt_to_scratch`
    and their part files), so those are kept, as is every sub-folder (`api_audio`, `local_redis`,
    the engine's caches) and every link: only a regular file directly in the folder is removed.
    Nothing happens unless `VOCALIS_ACESTEP_STAGE_DIR` is set and the folder exists, or while any
    child of this process is starting, running or stopping. Warning per file that cannot be
    removed, one info line with the count when something went, nothing otherwise.
    """
    root = os.environ.get(ENV_VAR)
    if not root or not Path(root).is_dir():
        return 0
    from vocalis.runtime import acestep
    states = acestep.active_states()
    if any(s not in ("stopped", "failed", "inactive") for s in states.values()):
        logger.debug(f"acestage: loose audio sweep skipped, an ACE-Step child is not stopped "
                     f"({states})")
        return 0
    real_root = os.path.realpath(root)
    removed = 0
    with os.scandir(real_root) as entries:
        loose = [e.name for e in entries
                 if e.is_file(follow_symlinks=False) and not _is_ours(e.name)
                 and os.path.splitext(e.name)[1].lower() in _LOOSE_AUDIO]
    for name in loose:
        target = os.path.join(real_root, name)
        try:
            if not stat.S_ISREG(os.lstat(target).st_mode):
                continue
            os.unlink(target)
            removed += 1
        except FileNotFoundError:
            continue
        except OSError as exc:
            logger.warning("acestage: could not remove a loose audio file the engine left "
                           f"({exc.strerror or type(exc).__name__})")
    if removed:
        logger.info(f"acestage: removed {removed} loose audio file(s) the engine left in the "
                    "stage folder")
    return removed


def _is_ours(name: str) -> bool:
    """Is `name` one this module minted? 16 lowercase hex, then a suffix, and nothing else.

    Conservative on purpose: the cost of a false negative is one stale file the next sweep also
    skips, and the cost of a false positive is deleting somebody else's render mid-job.
    """
    stem = Path(name).stem
    return len(stem) == 16 and all(c in "0123456789abcdef" for c in stem)


# What can be a reference and why it is selected from existing stems.
#
# The reference encoder sees the whole mix. `AceStepTimbreEncoder` is four layers on its own
# cross-attention path (`configuration_acestep_v15.py:182`) with NO speaker-identity objective
# anywhere in it — it moves vocal character toward the reference, and it does not clone a voice.
# RVC through Voice Swap remains the identity tool; this is a better STARTING vocal for it, at
# best, and the help text says so rather than letting the control imply otherwise.
#
# ∴ because the encoder sees the whole mix, a full song drags its arrangement along too. The
# useful reference is VOCAL-FORWARD — which is exactly what a Demucs `vocals` stem is, and
# Vocalis already makes those. So the picker is a list of the vocal stems already in the Stems
# library rather than a file input: preparing a reference is an existing one-click operation
# (split a song), and at generate time it is one click on a dropdown.
#
# A set without a vocal stem is not offered. An instrumental-only upload is storable and
# downloadable, and as a timbre reference it is silence where the voice should be —
# `process_reference_audio` would take three 10 s windows of backing track and move the vocal
# character toward an arrangement. Filtered here rather than explained in a tooltip.

#: `<kind>:<id>`. The reference picker offers only `stem:`; m3's SOURCE picker adds `song:` and
#: `cand:` against the same staging call, which is why this is a table rather than an `if`.
REF_KIND_STEM = "stem"
SRC_KIND_SONG = "song"     # a saved library song, app-encrypted, decrypted on the way out
SRC_KIND_CAND = "cand"     # an unsaved candidate, which lives on the BACKEND and not here

#: Which stem of a set is the reference. The identity, not the filename — a set stores it as
#: `vocals.opus` now and `vocals.wav` before 7.5.25, and `stems.stem_file` answers with whichever
#: this set actually holds.
REF_STEM = "vocals"


def references(cfg=None) -> list[dict]:
    """Every clip offerable as a reference, newest first — the "Sing it like" picker's options.

    `token` is what the song template stores. Deliberately NOT an absolute path: a template
    outlives any staging directory, and a path baked into one would rot the moment the store
    moved. The path is re-derived at dispatch, every time.
    """
    import stems
    from vocalis.runtime import configs
    cfg = cfg if cfg is not None else configs.ss_cfg()
    out = []
    for r in stems.list_sets(cfg):
        if not any(s.get("stem") == REF_STEM for s in r.get("stems") or []):
            continue
        out.append({"token": f"{REF_KIND_STEM}:{r['ref']}",
                    "label": r.get("song") or r["ref"],
                    "source": r.get("source") or "demucs",
                    "duration_s": r.get("duration_s")})
    return out


def sources(cfg=None) -> list[dict]:
    """Everything Remix, Repaint and the track modes can work FROM, newest-first within group.

    Three groups, and they are three different plumbing paths (design §7):

      * **library songs** — Vocalis owns the file, app-encrypted, decrypted at dispatch;
      * **candidates** — the render still sitting in the tray, which lives on its BACKEND and is
        fetched over HTTP. Only finished candidates are listed because an active render has no
        audio to fetch yet.
      * **stems** — an isolated vocal or instrumental, which is a perfectly good thing to remix
        and costs nothing to offer because the reference picker already resolves them.

    Candidates may disappear when their backend restarts. `stage_source` reports that condition
    directly so the caller can explain why the source is unavailable.

    Every entry with a seed includes it so the picker can distinguish takes with the same title.
    Keep `label` as the plain title because other client messages and row actions use that field;
    the client composes the display text.
    """
    out = []
    try:
        from vocalis.runtime import acelib
        for s in acelib.list_songs():
            out.append({"token": f"{SRC_KIND_SONG}:{s.id}", "label": s.name or "Untitled",
                        "seed": s.seed, "group": "Library"})
    except BaseException as exc:      # noqa: BLE001 — VaultAuthError is a BaseException
        logger.debug(f"acestage: library sources unavailable ({exc})")
    try:
        from vocalis.runtime import jobs as rt_jobs
        for job in reversed(list(rt_jobs.JOBS.values())):
            if getattr(job, "kind", "") != "acestep" or job.status != "done":
                continue
            d = job.detail or {}
            if not (d.get("audio") and d.get("url")):
                continue
            out.append({"token": f"{SRC_KIND_CAND}:{job.id}",
                        "label": d.get("title") or "Untitled",
                        "seed": d.get("seed"),
                        "group": "Candidates"})
    except (AttributeError, TypeError) as exc:
        logger.debug(f"acestage: candidate sources unavailable ({exc})")
    try:
        for r in references(cfg):
            out.append({"token": r["token"], "label": r["label"], "group": "Stems"})
    except BaseException as exc:      # noqa: BLE001
        logger.debug(f"acestage: stem sources unavailable ({exc})")
    return out


def resolve(token: str, cfg=None):
    """A reference token → the real file in the store, or None if it is gone.

    None is a normal answer, not an error: a template can name a stem set the user has since
    deleted, and the caller decides whether that is worth a message. It is — see `stage`.
    """
    kind, _, ident = str(token or "").partition(":")
    if kind != REF_KIND_STEM or not ident:
        return None
    import stems
    from vocalis.runtime import configs
    return stems.stem_file(cfg if cfg is not None else configs.ss_cfg(), ident, REF_STEM)


def stage_reference(token: str, *, cfg=None, root=None) -> str:
    """A reference token → an absolute path the backend can open. `""` for "no reference".

    Raises `FileNotFoundError` / `OSError` exactly as `stage` does, so a reference the user
    picked and Vocalis could not deliver reaches them as a message instead of as a render that
    quietly came out unchanged.
    """
    if not token:
        return ""
    src = resolve(token, cfg)
    if src is None:
        raise FileNotFoundError("that reference clip is no longer in the stems library")
    return stage(src, root=root)


# Source audio is the input being transformed, not a style reference.
#
# `src_audio_path` and `reference_audio_path` are easily conflated and are not the same kind of
# thing at all. The reference is optional flavor on an ordinary text2music render; the SOURCE
# *defines the operation* — remix this, repaint this range of this, extract a track out of this.
# A Remix with no source is not a weaker remix, it is a text2music song with a misleading button.
#
# The two source kinds take different paths. A library song is a
# file Vocalis owns, app-encrypted, and `stage()` decrypts it. A CANDIDATE is not ours at all: it
# lives in the backend's own outputs and the only way to it is `fetch_audio` over HTTP. So the
# candidate arm pulls the bytes and writes them into the staging directory itself.
#
# Candidates may disappear when their backend restarts. Report the missing source clearly instead
# of allowing a server error or rendering an unrelated input.


def stage_source(token: str, *, cfg=None, root=None, fetch=None) -> str:
    """A source token → an absolute path the backend can open. `""` for "no source".

    `fetch` is injected rather than imported so the candidate arm is drivable without a backend;
    it defaults to the real `acestep.fetch_audio`.
    """
    kind, _, ident = str(token or "").partition(":")
    if not token:
        return ""
    if kind == SRC_KIND_SONG:
        from vocalis.runtime import acelib
        # Validate the client-supplied id before joining it into a path. Library ids are
        # `uuid4().hex`; without this check, a crafted token could traverse outside the library
        # and cause decrypted content to be staged for the backend.
        if not (len(ident) == 32 and all(c in "0123456789abcdef" for c in ident)):
            raise FileNotFoundError("that song is no longer in the library")
        p = acelib.audio_path(ident)
        if not vault_fs.exists(p):
            raise FileNotFoundError("that song is no longer in the library")
        return stage(p, root=root)
    if kind == SRC_KIND_CAND:
        return _stage_candidate(ident, root=root, fetch=fetch)
    # A stem set is a legitimate source too — "remix my isolated vocal" is a real thing to want,
    # and it costs nothing to allow because the resolver already exists.
    if kind == REF_KIND_STEM:
        return stage_reference(token, cfg=cfg, root=root)
    raise FileNotFoundError(f"there is no source of kind {kind!r}")


def _stage_candidate(job_id: str, *, root=None, fetch=None) -> str:
    """Pull one candidate's audio off the backend that made it and put it in the staging dir.

    This does not use `stage()` because there is no local file to copy; the bytes arrive over HTTP.
    The naming and sweep rules are shared with other staged files.
    """
    from vocalis.runtime import acestep as rt_acestep
    from vocalis.runtime import jobs as rt_jobs
    job = rt_jobs.JOBS.get(job_id)
    if job is None or getattr(job, "kind", "") != "acestep":
        raise FileNotFoundError("that candidate is gone — candidates do not survive a restart")
    with job.lock:
        d = dict(job.detail or {})
    audio, url = (d.get("audio") or []), d.get("url")
    if not audio or not url:
        raise FileNotFoundError("that candidate has not finished rendering")

    root = Path(root) if root is not None else stage_root()
    root.mkdir(parents=True, exist_ok=True)
    # Keyed on the REMOTE path, so pressing Remix twice on the same candidate reuses one file —
    # the same reason `stage` is deterministic.
    dst = root / staged_name(f"cand|{audio[0]}", Path(str(audio[0])).suffix or ".flac")
    try:
        if dst.is_file() and dst.stat().st_size > 0:
            os.utime(dst, None)
            return dst.as_posix()
    except OSError:
        pass
    data = (fetch or rt_acestep.fetch_audio)(url, audio[0])
    if not data:
        raise OSError("the backend returned an empty file for that candidate")
    # Same atomicity rule as `stage()`: the name is deterministic and the fast path above trusts
    # any non-empty file, so a partial write must never be able to land under the final name.
    tmp = root / staged_name(f"part|cand|{audio[0]}|{os.getpid()}|{time.time_ns()}",
                             Path(str(audio[0])).suffix or ".flac")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dst)
    finally:
        tmp.unlink(missing_ok=True)
    return dst.as_posix()
