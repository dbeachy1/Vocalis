"""Persist a locked master track and the shots cut against its timeline.

A production is a finished track plus an ordered list of shots against its timeline. For example:

    Production "example-production"
      |- master audio      the locked, finished track
      |- subject           which trained LoRA plays this character
      \\- shots[]
           |- in / out     timecode on the master; length is DERIVED, never typed
           |- audio slice  cut on demand from the master - not a stored duplicate
           |- still        the reference image for this shot
           |- prompt       staging/motion for this shot
           \\- renders[]    each with its settings, log, and output

The master is referenced by its library identity rather than copied into the production. Shot
length is derived from in/out timecodes, so it cannot drift from a second stored duration. Each
render records the master's identity; changing the master marks existing renders stale.
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field as dc_field

import vault_fs
from loguru import logger

from . import paths, peaks

#: Generated ids only. Checked wherever an id becomes part of a path.
_SAFE_ID = re.compile(r"\A[0-9a-f]{8,32}\Z")

MAX_NAME = 120
MAX_PROMPT = 4000
MAX_PRODUCTIONS = 200
MAX_SHOTS = 500

#: Suggested shot duration for UI guidance only. Values outside this range remain valid.
TARGET_MIN_S = 10.0
TARGET_MAX_S = 20.0

#: The smallest slice worth cutting. Below one video frame at 25 FPS there is nothing to render.
MIN_SHOT_S = 0.04

#: §5.2's per-shot states.
STATUSES = ("not_started", "probed", "rendering", "done", "stale")


class ProductionStoreCorrupt(RuntimeError):
    """The index is there and unreadable. 409, never a silent rebuild — the same contract
    `lorasubj` keeps, and for the same reason: healing it silently is how a store gets destroyed."""


_LOCK = threading.RLock()


@dataclass
class Shot:
    id: str = ""
    in_s: float = 0.0
    out_s: float = 0.0
    still: str = ""
    prompt: str = ""
    status: str = "not_started"
    #: The master identity this shot was last rendered against. Empty until something is rendered.
    rendered_against: str = ""
    renders: list = dc_field(default_factory=list)

    @property
    def length(self) -> float:
        """Duration derived from timecodes so it cannot disagree with them."""
        return max(0.0, round(self.out_s - self.in_s, 3))

    def slice_name(self, index: int) -> str:
        """Return a readable filename based on the shot's timecodes.

        The filename uses whole seconds for display; the cut itself uses the original float
        timecodes.
        """
        return f"shot_{index:02d}_{int(self.in_s):04d}-{int(self.out_s):04d}.wav"

    def as_dict(self) -> dict:
        return {"id": self.id, "in_s": self.in_s, "out_s": self.out_s,
                "length": self.length, "still": self.still, "prompt": self.prompt,
                "status": self.status, "rendered_against": self.rendered_against,
                "renders": list(self.renders)}


@dataclass
class Production:
    id: str = ""
    name: str = ""
    #: The master's server-side reference, e.g. `acelib/<song id>`. Never bytes, never an upload.
    master_ref: str = ""
    #: Master size and modification time when the shots were rendered.
    master_id: str = ""
    subject_id: str = ""
    shots: list = dc_field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0

    def as_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "master_ref": self.master_ref,
                "master_id": self.master_id, "subject_id": self.subject_id,
                "shots": [s.as_dict() for s in self.shots],
                "created_at": self.created_at, "updated_at": self.updated_at}


def master_identity(size: int, mtime: float) -> str:
    """Return a stable identity from file size and modification time."""
    return f"{int(size)}:{round(float(mtime), 3)}"


def _path():
    return paths.PRODUCTIONS


def _shot_from(d: dict) -> Shot:
    s = Shot()
    s.id = str(d.get("id") or "")
    s.in_s = float(d.get("in_s") or 0.0)
    s.out_s = float(d.get("out_s") or 0.0)
    s.still = str(d.get("still") or "")
    s.prompt = str(d.get("prompt") or "")[:MAX_PROMPT]
    s.status = d.get("status") if d.get("status") in STATUSES else "not_started"
    s.rendered_against = str(d.get("rendered_against") or "")
    s.renders = list(d.get("renders") or [])
    # Ignore any persisted length; the property is derived from the timecodes.
    return s


def _read() -> list[Production]:
    p = _path()
    if not vault_fs.exists(p):
        return []
    try:
        raw = json.loads(vault_fs.read_text(p))
    except json.JSONDecodeError as exc:
        # Preserve corrupt data for diagnosis. Rebuilding an unreadable index would destroy the
        # shot list, which is the production's primary content.
        raise ProductionStoreCorrupt(f"{p.name} is not valid JSON: {exc}") from exc
    if not isinstance(raw, list):
        raise ProductionStoreCorrupt(f"{p.name} is not a list")
    out = []
    for d in raw:
        if not isinstance(d, dict):
            raise ProductionStoreCorrupt(f"{p.name} holds a non-object entry")
        pr = Production()
        pr.id = str(d.get("id") or "")
        pr.name = str(d.get("name") or "")[:MAX_NAME]
        pr.master_ref = str(d.get("master_ref") or "")
        pr.master_id = str(d.get("master_id") or "")
        pr.subject_id = str(d.get("subject_id") or "")
        pr.shots = [_shot_from(s) for s in (d.get("shots") or []) if isinstance(s, dict)]
        pr.created_at = float(d.get("created_at") or 0.0)
        pr.updated_at = float(d.get("updated_at") or 0.0)
        out.append(pr)
    return out


def _write(items: list[Production]) -> None:
    vault_fs.write_json_atomic(_path(), [p.as_dict() for p in items], indent=2)


def list_productions() -> list[Production]:
    with _LOCK:
        return _read()


def get(production_id: str) -> Production | None:
    with _LOCK:
        for p in _read():
            if p.id == production_id:
                return p
    return None


def create(name: str, master_ref: str, master_id: str, subject_id: str = "") -> Production:
    with _LOCK:
        items = _read()
        if len(items) >= MAX_PRODUCTIONS:
            raise ProductionStoreCorrupt(f"too many productions (max {MAX_PRODUCTIONS})")
        now = time.time()
        p = Production(id=uuid.uuid4().hex[:12], name=(name or "untitled").strip()[:MAX_NAME],
                       master_ref=master_ref, master_id=master_id, subject_id=subject_id,
                       created_at=now, updated_at=now)
        items.append(p)
        _write(items)
        return p


def save(production: Production) -> Production:
    with _LOCK:
        items = _read()
        for i, p in enumerate(items):
            if p.id == production.id:
                production.updated_at = time.time()
                items[i] = production
                _write(items)
                return production
    raise ProductionStoreCorrupt(f"no such production: {production.id}")


def delete(production_id: str) -> bool:
    with _LOCK:
        items = _read()
        keep = [p for p in items if p.id != production_id]
        if len(keep) == len(items):
            return False
        _write(keep)
        return True


def add_shot(production_id: str, in_s: float, out_s: float) -> Shot:
    """Mark a shot on the timeline.

    ⚠️ Ordered by `in_s` on every insert rather than appended. The shot INDEX is what names the
    slice file (`shot_03_...`), and §5.2 wants assembly to be mechanical — a list in click order
    would number the shots by the order somebody happened to mark them, which is not the order
    they play in.
    """
    with _LOCK:
        items = _read()
        for p in items:
            if p.id != production_id:
                continue
            if len(p.shots) >= MAX_SHOTS:
                raise ProductionStoreCorrupt(f"too many shots (max {MAX_SHOTS})")
            lo, hi = (float(in_s), float(out_s)) if out_s >= in_s else (float(out_s), float(in_s))
            if hi - lo < MIN_SHOT_S:
                raise ProductionStoreCorrupt(
                    f"a shot must be at least {MIN_SHOT_S}s - shorter than one video frame")
            s = Shot(id=uuid.uuid4().hex[:12], in_s=round(lo, 3), out_s=round(hi, 3))
            p.shots.append(s)
            p.shots.sort(key=lambda x: x.in_s)
            p.updated_at = time.time()
            _write(items)
            return s
    raise ProductionStoreCorrupt(f"no such production: {production_id}")


def update_shot(production_id: str, shot_id: str, **fields) -> Shot | None:
    with _LOCK:
        items = _read()
        for p in items:
            if p.id != production_id:
                continue
            for s in p.shots:
                if s.id != shot_id:
                    continue
                if "in_s" in fields:
                    s.in_s = round(float(fields["in_s"]), 3)
                if "out_s" in fields:
                    s.out_s = round(float(fields["out_s"]), 3)
                if "still" in fields:
                    s.still = str(fields["still"] or "")
                if "prompt" in fields:
                    s.prompt = str(fields["prompt"] or "")[:MAX_PROMPT]
                if "status" in fields and fields["status"] in STATUSES:
                    s.status = fields["status"]
                # 📌 `length` is deliberately not accepted. It is derived.
                p.shots.sort(key=lambda x: x.in_s)
                p.updated_at = time.time()
                _write(items)
                return s
    return None


def mark_rendered(production_id: str, shot_id: str) -> Shot | None:
    """Record that this shot was rendered against the master the production currently names.

    🔴 **NOTHING IN `src/` EVER WROTE `rendered_against`, SO STALE DETECTION COULD NOT FIRE.**
    `reconcile_master`'s condition is `s.rendered_against and s.rendered_against != current` — the
    field was `""` on every shot that has ever existed, so it short-circuited to False every time.
    `report["stale"]` was always `[]` and `video.js`'s `vidStale` was unreachable. The module's
    headline promise — *"LOCKING THE AUDIO IS A STATE, AND IT IS ENFORCED"* — was a promise no code
    kept. The render queue simply never wrote back to this store at all.

    ⚠️ **AND THE COVERAGE LOOKED GREEN BECAUSE THE TEST SUPPLIED THE INPUT ITSELF.**
    `tests/test_production.py:98` sets `got.shots[0].rendered_against = old` by hand before calling
    `reconcile_master`. That tests the comparison, which was correct; it cannot test whether anyone
    produces the value being compared. A unit test cannot prove someone calls the function.

    📌 Deliberately NOT part of `update_shot`'s `**fields`. The route's `allowed` list is what a
    client may set, and this is not client input — it is the queue reporting what it built. Keeping
    it out of that list is what stops a browser asserting a shot is fresh.
    """
    with _LOCK:
        items = _read()
        for p in items:
            if p.id != production_id:
                continue
            for s in p.shots:
                if s.id != shot_id:
                    continue
                s.rendered_against = p.master_id
                s.status = "done"
                p.updated_at = time.time()
                _write(items)
                return s
    return None


def delete_shot(production_id: str, shot_id: str) -> bool:
    with _LOCK:
        items = _read()
        for p in items:
            if p.id != production_id:
                continue
            keep = [s for s in p.shots if s.id != shot_id]
            if len(keep) == len(p.shots):
                return False
            p.shots = keep
            p.updated_at = time.time()
            _write(items)
            return True
    return False


def _drop_slices(production) -> int:
    """Delete all derived cut slices after the master changes; return the number removed.

    Unlike `sweep_slices`, this removes every slice because unchanged timecodes may now refer to
    different audio. Failures are logged and returned as zero so a page read does not fail on
    derived-file cleanup.
    """
    try:
        d = assets_dir(production.id)
        names = vault_fs.glob(d, "shot_*.wav")
        for name in names:
            vault_fs.unlink(d / name, missing_ok=True)
        return len(names)
    except (OSError, ValueError):
        logger.exception(f"production {production.id}: could not discard the cut slices")
        return 0


def reconcile_master(production_id: str, current_master_id: str) -> dict:
    """Mark rendered shots stale when their master changes and remove outdated cut slices.

    Unrendered shots keep their valid timecodes. Each rendered shot records its own master
    identity, so re-rendering one shot does not make others current. Slices are removed here
    rather than re-cut: cutting requires ffmpeg and scratch I/O, while this reconciliation runs
    during ordinary reads. `cut_slice` also checks identity for requests without a preceding read.
    """
    with _LOCK:
        items = _read()
        for p in items:
            if p.id != production_id:
                continue
            went_stale = []
            for s in p.shots:
                if s.status in ("done", "probed", "rendering") and \
                        s.rendered_against and s.rendered_against != current_master_id:
                    s.status = "stale"
                    went_stale.append(s.id)
            changed = p.master_id != current_master_id
            if changed:
                p.master_id = current_master_id
            dropped = _drop_slices(p) if changed else 0
            if went_stale or changed:
                p.updated_at = time.time()
                _write(items)
                if went_stale:
                    logger.warning(
                        f"production {p.name}: the master changed - {len(went_stale)} shot(s) "
                        "invalidated")
                if dropped:
                    logger.warning(
                        f"production {p.name}: the master changed - {dropped} cut slice(s) "
                        "discarded, they hold audio the master no longer has")
            return {"master_changed": changed, "stale": went_stale, "slices_dropped": dropped}
    raise ProductionStoreCorrupt(f"no such production: {production_id}")


def coverage(production: Production, master_len_s: float) -> dict:
    """What the shot list reports about itself: gaps, overlaps and out-of-target shots.

    Report coverage, but do not forbid gaps or out-of-target shots. Gaps are legitimate
    (an instrumental passage with no character on screen). This is information for a person, not
    a validator, which is why nothing here raises.
    """
    shots = sorted(production.shots, key=lambda s: s.in_s)
    gaps, overlaps, out_of_target = [], [], []
    cursor = 0.0
    for s in shots:
        if s.in_s > cursor + 0.001:
            gaps.append({"from": round(cursor, 3), "to": round(s.in_s, 3)})
        if s.in_s < cursor - 0.001:
            overlaps.append({"shot": s.id, "from": round(s.in_s, 3), "to": round(cursor, 3)})
        if not (TARGET_MIN_S <= s.length <= TARGET_MAX_S):
            out_of_target.append({"shot": s.id, "length": s.length})
        cursor = max(cursor, s.out_s)
    if master_len_s and cursor < master_len_s - 0.001:
        gaps.append({"from": round(cursor, 3), "to": round(float(master_len_s), 3)})
    return {"shots": len(shots), "covered_s": round(cursor, 3),
            "gaps": gaps, "overlaps": overlaps, "out_of_target": out_of_target}


def slice_cmd(master, out_path, in_s: float, out_s: float, ffmpeg: str = "ffmpeg") -> list:
    """Build the sample-accurate shot slice command.

    Seeking after `-i` decodes from the start and avoids frame-boundary seek error. PCM output
    preserves sample-accurate timecodes. Use `-t` for duration because `-to` can be interpreted
    against different timelines by ffmpeg versions.
    """
    lo = max(0.0, float(in_s))
    dur = max(0.0, float(out_s) - lo)
    return [ffmpeg, "-nostdin", "-v", "error", "-y",
            "-i", str(master),          # 🔴 -i FIRST: seeking after it is what makes this exact
            "-ss", f"{lo:.3f}",
            "-t", f"{dur:.3f}",
            "-map", "0:a:0", "-c:a", "pcm_s16le",
            str(out_path)]


# ── the peaks cache (the I/O half; `peaks.py` stays pure) ─────────────────────

def assets_dir(production_id: str):
    """Where one production's derived assets live. Routed, therefore encrypted."""
    if not _SAFE_ID.match(production_id or ""):
        raise ValueError(f"unsafe production id for a directory name: {production_id!r}")
    return paths.PRODUCTION_ASSETS / production_id


def master_path(master_ref: str):
    """Resolve a production master reference to a library path, or `None` if unavailable.

    References are parsed rather than joined to a filesystem path. Library song IDs are checked
    against the current listing before returning their audio path; voice-swap references are
    resolved by the voice-swap library.
    """
    ref = master_ref or ""
    if ref.startswith("acelib/"):
        from . import acelib

        song_id = ref[len("acelib/"):]
        if not _SAFE_ID.match(song_id):
            return None
        # Matched against what the library actually holds, so an id that is not a song resolves
        # to nothing rather than to a path that happens to exist.
        if not any(s.id == song_id for s in acelib.list_songs()):
            return None
        return acelib.audio_path(song_id)
    if ref.startswith("swaplib/"):
        import voiceswap

        from . import configs

        mp3, _y = voiceswap.result_paths(configs.vs_cfg().library_dir, ref[len("swaplib/"):])
        if mp3 is None or not vault_fs.exists(mp3):
            return None
        return mp3
    return None


def _sweep_peaks(d, spare: str) -> int:
    """Delete envelopes this production no longer uses.

    🔴 **AFTER THE WRITE, SPARING THE CURRENT NAME — NEVER BEFORE.** A crash between a delete and
    a write leaves a live timeline with no peaks and a master that is perfectly fine. The order is
    the entire safety property.

    ⚠️ **`vault_fs.glob` RETURNS NAMES, NOT PATHS** — its own docstring says so, and
    `wbedit/store/documents.py::_sweep_thumbnails` carries the scar from passing them straight to
    `unlink`: a bare name resolves against the process's working directory, so the sweep silently
    deletes nothing, and on a box where a file of that name sits beside the server it deletes the
    wrong one. Joined to `d` here, in the single place that sweeps.
    """
    gone = 0
    for name in vault_fs.glob(d, peaks.PREFIX + "*" + peaks.SUFFIX):
        if name == spare:
            continue
        vault_fs.unlink(d / name, missing_ok=True)
        gone += 1
    return gone


def envelope(production, buckets: int, *, ffmpeg: str = "ffmpeg"):
    """`(json_bytes, key)` for this production's master at this bucket count.

    🔴 **THE KEY IS THE FILENAME, SO EXISTENCE IS VALIDITY.** No sidecar, no stored timestamp, no
    second source of truth that could disagree with the first — which is what makes the hit path a
    single lock-free read.

    🔴 **A MISS DEGRADES; IT NEVER RAISES.** §5.2b: with no peaks the timeline draws a flat rule
    and every shot boundary still works, because boundaries are NUMBERS, not pixels. ffmpeg
    missing, a master that has been deleted, a decode that fails — all of them return an empty
    envelope, and the screen is usable. The cache is only ever an accelerator.
    """
    src = master_path(production.master_ref)
    st = vault_fs.stat(src) if src is not None else None
    if st is None:
        return peaks.render(b"", buckets), ""

    k = peaks.key(st.size, st.mtime, buckets)
    d = assets_dir(production.id)
    name = peaks.asset_name(k)
    hit = d / name
    if vault_fs.exists(hit):
        try:
            return vault_fs.read_bytes(hit), k
        except OSError:
            pass                       # a truncated cache entry is a miss, not an error

    # ⚠️ THE DECODE READS THE VAULT, SO IT CANNOT BE HANDED A PATH. ffmpeg is a separate process
    # with no DEK; pointed at a routed path it reads ciphertext and reports a corrupt file. The
    # scratch round trip is the established idiom for exactly this (`vault_fs.to_scratch`).
    import subprocess

    import scratch as scratch_mod

    try:
        # 🔴 THE PROJECT'S SCRATCH, NEVER `tempfile`. The OS temp dir is outside everything
        # 5.0 encrypts, so a decrypted master staged there is the plaintext leak the whole
        # release exists to prevent — and on Windows nothing ever sweeps %TEMP%, so it would
        # sit there indefinitely. `scratch.directory()` is on the encryptable side of the
        # fence, is swept at startup, and names itself opaquely so the filesystem does not
        # learn the song title. Caught by `test_no_module_in_src_uses_the_os_temp_dir`, which
        # exists because four earlier cases all looked defensible too.
        with scratch_mod.directory(scratch_mod.scratch_root(), f"peaks|{production.id}") \
                as scratch:
            # 🔴 `with`, BECAUSE `child_input` IS A CONTEXT MANAGER. Called as a plain function it
            # returns the manager object, `str()` of which is not a path — ffmpeg then fails and
            # this function degrades to a flat envelope. Silently, every time, for ever: the
            # timeline would simply never have a waveform and nothing would say why.
            #
            # ⚠️ It is a context manager on purpose: `to_scratch` returns the ORIGINAL path when
            # the file is not ours, so a caller that unlinked its "temp file" unconditionally
            # would delete the user's actual song out of a library we do not own.
            with vault_fs.child_input(src, scratch) as plain:
                r = subprocess.run(peaks.ffmpeg_pcm_cmd(plain, ffmpeg=ffmpeg),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        # Do not cache a flat fallback for a failed decode. Only successful output may be stored
        # under the master identity; an empty key tells callers to retry later.
        if r.returncode != 0:
            logger.info(f"peaks: ffmpeg exited {r.returncode} decoding {production.master_ref} "
                        "- not caching a failed decode")
            return peaks.render(b"", buckets), ""
        pcm = r.stdout or b""
    except (OSError, subprocess.SubprocessError) as exc:
        logger.info(f"peaks: cannot decode {production.master_ref} - {exc}")
        return peaks.render(b"", buckets), ""

    blob = peaks.render(pcm, buckets)
    try:
        vault_fs.mkdir(d)
        vault_fs.write_bytes(hit, blob)
        _sweep_peaks(d, spare=name)
    except OSError as exc:
        # An unwritable cache is a slow timeline, not a broken one.
        logger.info(f"peaks: cannot cache {production.id} - {exc}")
    return blob, k


# ── the slice, cut on demand ──────────────────────────────────────────────────

class SliceFailed(RuntimeError):
    """The slice could not be cut, and why.

    ⚠️ **NOT THE SAME CONTRACT AS A PEAKS MISS.** A missing envelope degrades to a flat rule and
    the screen stays usable, because boundaries are numbers. A missing slice has no such graceful
    half: there is nothing to listen to and nothing to render from, so it is an error the screen
    must show rather than a silence it should paper over.
    """


def slice_path(production_id: str, shot, index: int):
    """Where a shot's cut audio lives. Named by TIMECODE so assembly is mechanical (§5.2)."""
    return assets_dir(production_id) / shot.slice_name(index)


def cut_slice(production, shot, index: int, *, ffmpeg: str = "ffmpeg"):
    """Cut this shot from its master, or return the cached cut.

    The filename encodes timecodes, and the master identity is checked separately because the
    same interval in a re-timed master is different audio. Cuts are generated on demand to avoid
    duplicating audio that has not been requested. When the master changes, reconciliation removes
    stale slices; this function also checks identity for requests without a preceding read.
    """
    src = master_path(production.master_ref)
    st = vault_fs.stat(src) if src is not None else None
    if st is None:
        raise SliceFailed("the master is missing")
    if shot.length < MIN_SHOT_S:
        raise SliceFailed("that shot is shorter than one video frame")

    out = slice_path(production.id, shot, index)
    if vault_fs.exists(out):
        current = master_identity(st.size, st.mtime)
        if production.master_id == current:
            return out
        # A request can arrive without a preceding read/reconciliation. Re-cut rather than serve
        # audio whose timecodes match but whose master has changed.
        logger.info(f"production {production.name}: master changed, re-cutting {out.name}")

    import subprocess

    import scratch as scratch_mod

    try:
        with scratch_mod.directory(scratch_mod.scratch_root(), f"slice|{production.id}") as sc:
            # Both ends go through the scratch: ffmpeg holds no DEK, so it can neither read a
            # routed master nor write a routed destination.
            with vault_fs.child_input(src, sc) as plain:
                dst = sc / "cut.wav"
                r = subprocess.run(
                    slice_cmd(plain, dst, shot.in_s, shot.out_s, ffmpeg=ffmpeg),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
                if r.returncode != 0 or not dst.is_file():
                    err = (r.stderr or b"").decode("utf-8", "replace").strip()
                    raise SliceFailed(err.splitlines()[-1] if err else "ffmpeg failed")
                data = dst.read_bytes()
    except (OSError, subprocess.SubprocessError) as exc:
        raise SliceFailed(str(exc)) from exc

    if not data:
        raise SliceFailed("the cut produced no audio")

    vault_fs.mkdir(assets_dir(production.id))
    vault_fs.write_bytes(out, data)
    return out

def sweep_slices(production) -> dict:
    """Renumber the cuts that only moved position, delete the ones no shot wants.

    🔴 **AFTER THE WRITES, LIKE THE PEAKS SWEEP, AND BY THE SAME REASONING.** The names that
    should survive are computed from the CURRENT shot list, so a shot that was dragged leaves its
    old filename behind and it is collected here.

    🔴 **RENAMED, NOT RE-CUT, WHEN ONLY THE INDEX MOVED.** The index is positional, so deleting
    the FIRST shot renumbers every later one — and a name-only sweep would then throw away up to
    nineteen cuts whose audio is **byte-identical to what is needed**, forcing a full re-encode of
    the whole production because one shot was removed. The timecodes are the identity of the
    audio; the index is only where it sits in the list. So a file whose timecode half still
    matches a live shot is moved to its new number.

    ⚠️ **THE RENAME IS DONE IN TWO PASSES, VIA A TEMPORARY NAME.** Shots shifting down by one turn
    `shot_01 -> shot_00` while `shot_02 -> shot_01`, so a single pass renaming in place would
    overwrite a file it has not moved yet. Whether it collides depends on iteration order, which
    is the kind of bug that reproduces on one machine and not another.

    ⚠️ `vault_fs.glob` RETURNS NAMES, NOT PATHS — joined to the directory in this one place.
    """
    d = assets_dir(production.id)
    ordered = sorted(production.shots, key=lambda x: x.in_s)
    # timecode half -> the name it should have now
    wanted = {s.slice_name(i).split("_", 2)[2]: s.slice_name(i) for i, s in enumerate(ordered)}

    renamed, gone = 0, 0
    staged = []
    for name in vault_fs.glob(d, "shot_*.wav"):
        parts = name.split("_", 2)
        tail = parts[2] if len(parts) == 3 else ""
        target = wanted.get(tail)
        if target is None:
            vault_fs.unlink(d / name, missing_ok=True)
            gone += 1
        elif target != name:
            tmp = f".renaming-{uuid.uuid4().hex[:8]}-{target}"
            vault_fs.rename(d / name, d / tmp)
            staged.append((tmp, target))
    for tmp, target in staged:
        vault_fs.rename(d / tmp, d / target)
        renamed += 1
    return {"renamed": renamed, "deleted": gone}
