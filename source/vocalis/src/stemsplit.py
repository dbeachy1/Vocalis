#!/usr/bin/env python3
"""Own Stems import and split jobs, using the shared song and Stems stores."""
import itertools
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

import leadvocal
import scratch
import song_library
import stems
import stem_engine
import vault_fs
import vault_store
from vault import VaultAuthError       # 5.0-M5 boundary 2 of 5 — caught BY NAME below
from tts_utils import VocalisError
from stems import MODE_STEMS, SIDECAR, STEM_LABELS
from stem_engine import StageFailed, _run_stage, _stage_ok, emit, ffprobe_duration

EVENT_CAP = stem_engine.EVENT_CAP
JOBS_KEEP = stem_engine.JOBS_KEEP
JOBS = {}
JOBS_LOCK = threading.Lock()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")

DEFAULT_LEADVOCAL_VENV = Path("/opt/vocalis/venvs/leadvocal")
DEFAULT_LEADVOCAL_MODELS = Path("/models/vocalis/leadvocal")


# ── config ────────────────────────────────────────────────────────────────────

@dataclass
class StemConfig:
    """Paths used by Stems jobs and the retained song picker."""
    venv: Path
    acestep_dir: Path      # song sources (the picker reuses /voiceswap/songs)
    songs_dir: Path
    stems_dir: Path        # sets we made:  output/stems/
    stem_uploads_dir: Path  # sets you brought: uploads/stems/
    work_root: Path        # transient per-job workdirs — IN THE SCRATCH (5.0 §8.2)
    song_index: Path = None  # the song-hash memo shared with song uploads
    # The 8.0 ACE-Step library (m25) — the Stems picker reuses /voiceswap/songs, which lists
    # acelib rows now, so a split of one must resolve here too. Carried over from the swap
    # config below, like everything else in this class. Defaulted so direct StemConfig()
    # constructions in tests keep working (an acelib ref then just resolves to None).
    acelib_dir: Path = None
    # 8.4 — the "Lead vocals only" chain. Its own venv, ITS OWN INTERPRETER, and its own model
    # store: `audio-separator` drags torch + onnxruntime + torchvision, and neither the TTS venv
    # nor the swap venv may grow those (§4). Same boundary, same reason, as the swap's own
    # `venv` above and as `scripts/cleanup/trim_scores.py`.
    leadvocal_venv: Path = None
    leadvocal_models: Path = None
    leadvocal_scripts: Path = None
    #: "auto" | "cpu" | "cuda:N". 🔴 `auto` FOLLOWS THE JOB'S DEMUCS CARD, so ticking a card in
    #: ⚙ Settings is the only control anyone needs, and a box with no ROCm torch in the leadvocal
    #: venv still works — `audio-separator` finds no device and quietly stays on the CPU. Set it
    #: to `cpu` to keep the lead chain off the cards regardless (see the lock note in `_run_lead`).
    leadvocal_device: str = "auto"

    @property
    def python(self) -> Path:
        if os.name == "nt":
            return self.venv / "Scripts" / "python.exe"
        return self.venv / "bin" / "python"

    @property
    def demucs_python(self) -> Path:
        """Use the Stems-only interpreter shared by split jobs and swap's stem helper."""
        return self.python

    @property
    def leadvocal_python(self) -> Path:
        """`python` for the 8.4 venv. Falls back to the documented default rather than raising
        on None, so a bare `StemConfig()` in a test is still constructible — the job checks the
        interpreter EXISTS and says which script installs it, exactly as the swap venv does."""
        base = Path(self.leadvocal_venv or DEFAULT_LEADVOCAL_VENV)
        if os.name == "nt":
            return base / "Scripts" / "python.exe"
        return base / "bin" / "python"

    @property
    def leadvocal_detect(self) -> Path:
        base = Path(self.leadvocal_scripts or (Path(__file__).resolve().parent.parent
                                               / "scripts" / "leadvocal"))
        return base / "detect.py"


def resolve_config(app_settings: dict, base_dir: Path, output_dir: Path,
                   cache_dir: Path, *, data_dir: Path = None) -> StemConfig:
    # Scripts remain beneath the immutable code root; uploaded media belongs on the mounted
    # data root. Direct callers retain their prior base_dir default for standalone use/tests.
    data_root = Path(data_dir) if data_dir is not None else Path(base_dir)
    songs = song_library.resolve_config(app_settings, data_root, cache_dir)
    lv = (app_settings or {}).get("leadvocal") or {}
    stem_settings = (app_settings or {}).get("stems") or {}

    def pick(env_key, values, key, default):
        return Path(os.environ.get(env_key) or values.get(key) or default)

    return StemConfig(
                      venv=Path(os.environ.get("VOCALIS_STEMS_VENV")
                                or stem_settings.get("venv") or "/opt/vocalis/venvs/stems"),
                      acestep_dir=songs.acestep_dir, songs_dir=songs.songs_dir,
                      stems_dir=Path(output_dir) / "stems",
                      stem_uploads_dir=pick("VOCALIS_STEM_UPLOADS_DIR", stem_settings,
                                             "stem_uploads_dir",
                                             data_root / "uploads" / "stems"),
                      work_root=scratch.scratch_root(app_settings) / "stemsplit",
                      song_index=songs.song_index, acelib_dir=songs.acelib_dir,
                      # 8.4 — the same env-then-settings-then-default shape every other venv in
                      # this system resolves by, and the same paths scripts/leadvocal/setup.sh
                      # installs to. ⚠ An env var overrides SILENTLY here as it does above.
                      leadvocal_venv=pick("LEADVOCAL_VENV", lv, "venv", DEFAULT_LEADVOCAL_VENV),
                      leadvocal_models=pick("LEADVOCAL_MODELS", lv, "models", DEFAULT_LEADVOCAL_MODELS),
                      leadvocal_scripts=Path(base_dir) / "scripts" / "leadvocal",
                      leadvocal_device=str(os.environ.get("LEADVOCAL_DEVICE")
                                           or lv.get("device") or "auto").strip().lower())


# ── "I already have clean stems" (§7) ────────────────────────────────────────

def _slot(filename: str):
    """Which stem is this file? Matched on the STEM of the name, so `Vocals.wav`,
    `vocals.mp3` and Demucs's own `no_vocals.wav` all land where they belong — a user
    exporting from a DAW should not have to learn our filenames."""
    stem = Path(str(filename or "")).name
    ext = Path(stem).suffix.lower()
    if ext not in stems.AUDIO_EXTS:
        return None
    key = Path(stem).stem.strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {"no_vocals": "instrumental.wav", "novocals": "instrumental.wav",
               "instrumental": "instrumental.wav", "instrumentals": "instrumental.wav",
               "backing": "instrumental.wav", "accompaniment": "instrumental.wav",
               "karaoke": "instrumental.wav", "music": "instrumental.wav",
               "vocals": "vocals.wav", "vocal": "vocals.wav", "voice": "vocals.wav",
               "drums": "drums.wav", "drum": "drums.wav",
               "bass": "bass.wav", "other": "other.wav", "others": "other.wav"}
    return aliases.get(key)


def save_upload(cfg: StemConfig, name: str, files: list) -> dict:
    """Store a stem set you brought yourself. `files` is [(filename, stream), …].

    An uploaded set is a first-class object with its own identity, NOT a child of a
    song (§3) — you may have a vocal + instrumental pair and no mix file at all. So it
    is keyed on its own content, it stands on its own in the Stems tab, and it is
    selectable in the Voice Swap picker in its own right. A swap consumes it exactly as
    it consumes one Demucs made: provenance is a sidecar field, not a code path.

    ValueError if nothing recognizable came in. A set with no vocal is still STORED
    (you may just want the instrumental) — it simply can't be swapped, and the picker
    grays it out rather than failing at stage 2 (§5)."""
    d = Path(cfg.stem_uploads_dir)
    vault_fs.mkdir(d)
    # 🔴 M7: the staging dir used to be `<stem_uploads_dir>/.upload-<uuid>` — INSIDE the store,
    # holding the user's uploaded stems in cleartext. It is the scratch now, which is also what
    # stems.commit() expects: `landed` are the plaintext paths it encrypts INTO the store.
    with scratch.directory(scratch.scratch_root(), f"stem-upload|{name}") as work:
        landed = {}
        for filename, stream in files:
            slot = _slot(filename)
            if slot is None or slot in landed:
                continue                        # unknown name, or a duplicate stem
            with open(work / slot, "wb") as f:
                shutil.copyfileobj(stream, f)
            landed[slot] = work / slot
        if not landed:
            raise ValueError(
                "none of those files look like stems — name them vocals.wav, "
                "instrumental.wav, drums.wav, bass.wav, other.wav "
                "(no_vocals.wav is understood too)")
        label = str(name or "").strip() or "Stems"
        h = stems.upload_hash(list(landed.items()))
        dest = d / stems.set_ref(label, h)
        if vault_fs.is_dir(dest) and vault_fs.exists(dest / SIDECAR):
            return stems.row(dest)              # byte-identical re-upload: a no-op (R4)
        probe = landed.get("vocals.wav") or next(iter(landed.values()))
        stems.commit(dest, landed, {
            "h": h, "source": "uploaded", "song": label, "song_ref": "", "song_h": None,
            "duration_s": ffprobe_duration(probe), "created": _now(),
        })
        return stems.row(dest)


# ── Stems job registry ───────────────────────────────────────────────────────

@dataclass
class StemJob:
    id: str
    source_ref: str                 # the song being split — 'acestep/<f>' | 'uploads/<f>'
    song_name: str
    mode: str                       # "2stem" | "4stem" | "lead"
    device: str                     # resolved "cuda:N" | "cpu" — STAGE 1 ONLY (see below)
    h: str                          # the SET's identity = the song's content hash
    status: str = "queued"          # queued|running|done|failed|canceled
    stage: str = ""                 # ""|split|finalize
    error: str = None
    result_ref: str = ""
    stems_ref: str = ""
    demucs: bool = False
    started_at: float = 0.0
    last_line: str = ""
    events: list = field(default_factory=list)
    subscribers: list = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    # 8.4 — "Lead vocals only". The other two modes ignore all three. `device` above is the
    # DEMUCS device and does not reach these stages at all: the detector's onnxruntime GPU EP
    # is CUDA-only and de-reverb was measured fast enough on the CPU (§4), so stages 2-5 are
    # CPU by construction and take no card.
    dereverb: bool = True
    dereverb_model: str = ""
    params: dict = field(default_factory=dict)      # LeadParams overrides, clamped on use
    #: The client queue submits independent start requests, so each request reports whether more items remain. A satellite may keep its separator loaded only while the client can submit the next job; do not infer a lease from timing. The default of zero releases the worker after the current song, which costs a model reload rather than retaining VRAM indefinitely.
    queue_remaining: int = 0


def new_job(**kw) -> StemJob:
    job = StemJob(id=uuid.uuid4().hex[:12], **kw)
    with JOBS_LOCK:
        JOBS[job.id] = job
        finished = [j for j in JOBS.values() if j.status in ("done", "failed", "canceled")]
        for j in finished[:max(0, len(JOBS) - JOBS_KEEP)]:
            JOBS.pop(j.id, None)
    return job


def get_job(job_id: str):
    with JOBS_LOCK:
        return JOBS.get(job_id)


def live_h(h: str) -> bool:
    with JOBS_LOCK:
        return any(j.h == h and j.status in ("queued", "running") for j in JOBS.values())


# ── "Lead vocals only" — stages 2-5 (8.4, DESIGN_8_4_LEAD_VOCAL.md §3) ───────

def _canceled(job: StemJob) -> bool:
    """Between two in-process stages, where there is no child exit code for `_stage_ok` to
    read. The numpy stages are seconds, but the separations either side of them are minutes,
    so a ■ pressed during one must not be answered by committing anyway."""
    if not job.cancel.is_set():
        return False
    job.status = "canceled"
    emit(job, {"type": "log", "line": "Canceled — nothing was saved to the library."})
    emit(job, {"type": "canceled"})
    return True


# ── 8.6: where the separation runs ───────────────────────────────────────────

#: Rotate local separations across available cards so consecutive jobs do not all choose the first device. Keep the counter process-wide; a per-job counter would restart at the same device for every job.
_ROUND_ROBIN = itertools.count()


def _satellite_lead_devices(cfg_detect: Path):
    """Return satellite devices enabled for Stems that are healthy and running the same lead-separation child. Reject unavailable or mismatched devices and let routing fall back locally."""
    from vocalis.runtime import pool as rt_pool, satellites, subsystems
    from satellite_client import split_device

    try:
        devs = [d for d in rt_pool.default_devices(subsystems.STEMS)
                if satellites.is_satellite_device(d)]
    except VocalisError as exc:
        # BY NAME, matching how `local_cuda_devices` treats the same failure: a settings row
        # naming a card this box no longer enumerates. Staying local is the right answer to it,
        # and anything else reaching here is a bug that should surface rather than route around.
        logger.warning(f"lead routing: the device settings name a card this box no longer has "
                       f"({exc}) — staying local")
        return []
    if not devs:
        return []

    mine = leadvocal.detect_script_sha(cfg_detect)
    out, healths = [], {}
    for dev in devs:
        name, card = split_device(dev)
        h = healths.get(name)
        if h is None:
            h = healths[name] = satellites.health(name)
        if not h.get("reachable") or not h.get("leadvocal_ready"):
            # A ticked Stems on a satellite that cannot take it is ignored, never an error; the
            # work stays on this machine (release audit 2026-10-11, item 3).
            logger.info(f"lead routing: satellite {name!r} not used for {dev} "
                        f"(reachable={bool(h.get('reachable'))}, "
                        f"leadvocal_ready={bool(h.get('leadvocal_ready'))}) — staying local")
            continue
        theirs = str(h.get("leadvocal_script") or "")
        if theirs and mine and theirs != mine:
            logger.warning(
                f"lead routing: satellite {name!r} runs separator {theirs} but this Vocalis has "
                f"{mine} — NOT routing there. The satellite install is a copy; re-copy "
                f"scripts/leadvocal/detect.py and satellite/ to it.")
            continue
        try:
            v = satellites.client_for(name).vram(card)
        except Exception as exc:                                # noqa: BLE001
            logger.info(f"lead routing: satellite {name!r} did not answer /satellite/vram "
                        f"({exc}) — treating it as busy")
            continue
        out.append({"device": dev, "free_gb": v.get("free_gb"), "ok": True})
    return out


def _lead_device(job: StemJob, cfg: StemConfig) -> tuple:
    """Choose the lead-separation device and explanation. Honor an explicit leadvocal_device override; otherwise use a validated satellite, then rotate local cards, then fall back to CPU."""
    from vocalis.runtime import pool as rt_pool, subsystems

    want = str(cfg.leadvocal_device or "auto").strip() or "auto"
    cards = rt_pool.local_cuda_devices(subsystems.STEMS)

    # 🔴 A DELIBERATE CPU SPLIT STAYS A CPU JOB, WHOLE. `device: "cpu"` on a box that HAS ticked
    # cards is a choice — `auto` would have answered with one of them — and it means "keep off
    # my cards for this song". Routing the separation onto one anyway would take a card the user
    # had just declined AND make this job hold SWAP_LOCK for minutes, blocking every swap on the
    # box. Found by `test_swap_lock_is_released_before_the_cpu_only_stages` going red, which is
    # exactly the regression that spec was written to catch.
    #
    # ⚠️ The `cards` test is what makes this a CHOICE rather than an absence. With no ticked card
    # at all, `cpu` is not something the user picked, it is all there was — and a satellite is
    # then the only accelerator in the system, so the routing below must still run.
    if cards and not str(job.device).startswith("cuda") and want == "auto":
        return "cpu", "the split itself was asked to run on the CPU, so this stage does too"

    sats = _satellite_lead_devices(cfg.leadvocal_detect) if want == "auto" else []
    return leadvocal.route_lead(want, satellites=sats, local_cards=cards,
                                cursor=next(_ROUND_ROBIN))


def _local_lead_device(job: StemJob, cfg: StemConfig) -> tuple:
    """A card on THIS box for the separation — the fallback when a satellite will not take it.

    🔴 IT CANNOT ANSWER WITH A SATELLITE, and that is the point of it being its own function
    rather than a second call to `_lead_device`. Re-routing after a satellite refused would
    offer the same satellite again — it is still ticked, still healthy, and the reason it said
    no (a browser holding the card, a render in flight) is a *moment*, not a state the router
    can see. One retry is a fallback; a router that can re-choose the thing that just failed is
    a loop.
    """
    from vocalis.runtime import pool as rt_pool, subsystems
    # No guard: `local_cuda_devices` answers `[]` for the one thing it can raise on — a settings
    # row naming a card this box no longer has — and says so in the log. A blind catch on top of
    # a function that already degrades correctly hides the next real bug for nothing.
    cards = rt_pool.local_cuda_devices(subsystems.STEMS)
    return leadvocal.route_lead("auto", satellites=(), local_cards=cards,
                                cursor=next(_ROUND_ROBIN))


def _sat_mod():
    """`vocalis.runtime.satellites`, imported late.

    Deliberately not a module-level import: `satellites` reaches settings and the satellite
    client, and `stemsplit` is imported by the web layer during startup. Every other satellite
    touch in this file is inside a function for the same reason.
    """
    from vocalis.runtime import satellites
    return satellites


def _separate_remote(job: StemJob, device: str, wet_p: Path, backing_p: Path, dry_p: Path,
                     *, dereverb: bool, karaoke_model: str, dereverb_model: str,
                     keep_warm: bool = False) -> bool:
    """Submit a vocal stem for remote separation and land the result where the local child would write it. Return False for unavailable or failed remote work so the caller can run locally. Do not acquire the local swap lock for remote work."""
    from vocalis.runtime import satellites
    from satellite_client import split_device

    name, card = split_device(device)
    try:
        client = satellites.client_for(name)
        wav = wet_p.read_bytes()
    except Exception as exc:                                    # noqa: BLE001
        emit(job, {"type": "log",
                   "line": f"Satellite {name} could not take it ({exc}) — running it here."})
        return False

    emit(job, {"type": "log",
               "line": f"Sending the vocal to satellite {name} ({len(wav) / 1024 ** 2:.0f} MB) "
                       f"remote execution is available for this vocal."})
    # 🔴 ■ HAS TO CROSS THE WIRE OR IT IS A DECORATION. Everything else in this job cancels by
    # killing a local child; here the child is on another machine and this thread is parked in
    # a blocking POST that can legitimately last minutes. So a watcher turns the local flag
    # into `/satellite/cancel`, which kills the separator there — and the POST then returns a
    # refusal, which this function already knows how to answer.
    finished = threading.Event()

    def _bridge():
        while not finished.wait(0.5):
            if job.cancel.is_set():
                logger.info(f"stemsplit {job.id}: canceling the separation on satellite {name}")
                try:
                    client.cancel(job.id)
                except Exception as exc:                        # noqa: BLE001
                    logger.warning(f"satellite {name!r} did not take the cancel: {exc}")
                return

    threading.Thread(target=_bridge, name=f"leadcancel-{job.id}", daemon=True).start()
    try:
        status, err, head, parts = client.leadvocal(
            job.id, wav, device=card, dereverb=bool(dereverb),
            karaoke_model=karaoke_model, dereverb_model=dereverb_model,
            keep_warm=bool(keep_warm))
    except Exception as exc:                                    # noqa: BLE001
        emit(job, {"type": "log",
                   "line": f"Satellite {name} could not take it ({exc}) — running it here."})
        return False
    finally:
        finished.set()
    if status != 200 or not parts:
        # ⚠️ A CANCEL LOOKS EXACTLY LIKE A REFUSAL FROM HERE, and the two want opposite answers:
        # a refusal falls back to a local card, a cancel must stop. Deciding by the job's own
        # flag rather than by the reply keeps that correct even if the satellite never got the
        # cancel and simply died — the user pressed ■ either way.
        if job.cancel.is_set():
            return False
        emit(job, {"type": "log",
                   "line": f"Satellite {name} declined it "
                           f"({(err or {}).get('error', status)}) — running it here."})
        return False

    backing_p.write_bytes(parts.get("backing") or b"")
    if dereverb and parts.get("dry"):
        dry_p.write_bytes(parts["dry"])
    got = (head or {}).get("device_used") or "an unreported device"
    emit(job, {"type": "log",
               "line": f"Satellite {name} finished the separation in "
                       f"{(head or {}).get('took_s', '?')}s on {got}."})
    return True


def _require_lead_models(job: StemJob, cfg: StemConfig, p, model: str) -> None:
    """Fail the job, before any child starts, unless the separator's model files are on disk.

    The chain always runs the karaoke detector, and the de-reverb model only when the job asks
    for de-reverb (`p.dereverb`), so exactly those are required. The message the user sees comes
    from `leadvocal.require_models`; the `RuntimeError` reaches `run_split_job`'s handler, which
    puts it in `job.error` and the event stream."""
    wanted = [leadvocal.KARAOKE_MODEL] + ([model] if p.dereverb else [])
    logger.info(f"stemsplit {job.id}: checking lead-vocal models {wanted} in {cfg.leadvocal_models}")
    leadvocal.require_models(cfg.leadvocal_models, *wanted)


def _run_lead(job: StemJob, cfg: StemConfig, vocals: Path, ref: str, work: Path) -> bool:
    """Detect → de-reverb → spans → cut, over the vocal stage 1 just resolved. True on success;
    False if the job was canceled (status and events already emitted).

    THE ORDERING IS THE DESIGN AND IT IS NOT OBVIOUS (§3.5): the spans are measured on the WET
    vocal, de-reverb runs over the WET vocal at full length, and the cut lands on the DRY one.
    Detecting on a de-reverbed signal would take the one model whose accuracy decides what gets
    THROWN AWAY a second step out of distribution; de-reverbing after the cut would hand a
    context model a hard discontinuity every few seconds to smear across, on the material we
    keep. Doing it this way also biases the spans conservative for free, because on a wet signal
    a harmony's reverb tail extends past the harmony itself.

    Everything here is CPU and holds no lock (§9.2). Both separations are ONE child invocation:
    they share a 1.6 GB venv and a model cache, and paying process startup plus an import of
    torch twice, for a job that runs once per song, is waste."""
    d = stems.find_dir(cfg, ref)
    if d is None:
        raise RuntimeError("the stem set disappeared between the split and the cut")

    py, script = cfg.leadvocal_python, cfg.leadvocal_detect

    p = leadvocal.params_from({**(job.params or {}), "dereverb": bool(job.dereverb)})
    model = leadvocal.dereverb_model(job.dereverb_model)

    # The CPU path does not need a GPU lock. When separation uses a local GPU, acquire the lock only for that stage so it can coordinate with Demucs, RVC, and ACE-Step. The operator can select CPU to trade runtime for cross-job GPU concurrency.
    lv_device, why = _lead_device(job, cfg)
    remote = _sat_mod().is_satellite_device(lv_device)
    # Acquire the shared GPU lock only for a local CUDA device. Remote device identifiers also include a device name such as `cuda:0`; checking the remote flag first prevents them from taking a lock for a local card they do not use.
    on_gpu = (not remote) and str(lv_device).startswith("cuda")
    logger.info(f"stemsplit {job.id}: lead separation on {lv_device} — {why}")
    # A local run reads model files from this box; a satellite carries its own. Checking before
    # the decode child below means a job that cannot separate starts no process at all. A
    # satellite that declines is checked again where the local fallback begins.
    if not remote:
        _require_lead_models(job, cfg, p, model)
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    wet_p, backing_p, dry_p = (work / "vocals_wet.wav", work / "backing.wav", work / "dry.wav")

    # ── stage 2: separate ────────────────────────────────────────────────────
    job.stage = "separate"
    emit(job, {"type": "stage", "stage": "separate", "n": 2, "total": 4})

    # The stem is `vocals.opus` in the store (7.5.25) or the WAV this job's own Demucs run just
    # wrote. `child_input` materializes plaintext for a child either way — and removes it ONLY
    # if it was the one that made it, which is what stops a fresh work-dir WAV being deleted out
    # from under the cut. The decode after it normalizes both into one PCM that soundfile and
    # the models read without either of them learning about Opus or about the vault.
    emit(job, {"type": "log", "line": "Decoding the vocal stem…"})
    with vault_fs.child_input(vocals, work) as plain:
        rc = _run_stage(job, leadvocal.build_decode_cmd(plain, wet_p))
    if not _stage_ok(job, rc, "vocal decode"):
        return False

    emit(job, {"type": "log",
               "line": f"Finding the passages where she sings alone ({leadvocal.detector_name()})"
                       + (f", and taking the reverb off with {Path(model).stem}"
                          if p.dereverb else "")
                       + f" — {lv_device}, a few minutes…"})

    # The satellite is preferred when it has capacity, but it may be offline. If remote separation fails, retry locally when possible; unavailability alone is not a terminal job failure.
    done = remote and _separate_remote(
        job, lv_device, wet_p, backing_p, dry_p, dereverb=p.dereverb,
        karaoke_model=leadvocal.KARAOKE_MODEL, dereverb_model=model,
        keep_warm=int(job.queue_remaining or 0) > 0)
    # A canceled remote separation must not fall back locally. Check the job cancellation state before retrying, or cancellation would start the full separation again on a local card.
    if remote and not done and _canceled(job):
        return False
    if remote and not done:
        lv_device, why = _local_lead_device(job, cfg)
        on_gpu = str(lv_device).startswith("cuda")
        logger.info(f"stemsplit {job.id}: falling back to {lv_device} — {why}")
        emit(job, {"type": "log", "line": f"Running the separation here instead, on {lv_device}."})

    if not done:
        if remote:                              # the non-remote case was checked before the decode
            _require_lead_models(job, cfg, p, model)
        if not py.exists() or not script.exists():
            # Part of the image (packaging/leadvocal); scripts/leadvocal/setup.sh, which this used
            # to name, is not in the Docker edition. The error is shown to the user, so the server
            # path goes to the log only (October 11, 2026).
            logger.error(f"stemsplit {job.id}: the lead-vocal environment is missing: python {py} "
                         f"(exists: {py.exists()}), script {script} (exists: {script.exists()})")
            raise RuntimeError("the lead-vocal environment is missing from this image")
        cmd = leadvocal.build_detect_cmd(
            py, script, wet_p, karaoke_out=backing_p,
            dereverb_out=dry_p if p.dereverb else None,
            model_dir=cfg.leadvocal_models, karaoke_model=leadvocal.KARAOKE_MODEL,
            dereverb_model=model, device=lv_device)
        env = leadvocal.detect_env(os.environ, lv_device)
        if on_gpu:
            # For local GPU cards only.
            # acquire-with-cancel shape the split uses, because a ■ pressed while queued behind
            # a swap must still stop the job.
            waited = False
            while not stem_engine.STEMS_LOCK.acquire(timeout=0.5):
                if not waited:
                    waited = True
                    emit(job, {"type": "log",
                               "line": "Waiting for the card — a swap or split is using it…"})
                if job.cancel.is_set():
                    return not _canceled(job)
            try:
                rc = _run_stage(job, cmd, env)
            finally:
                stem_engine.STEMS_LOCK.release()
        else:
            rc = _run_stage(job, cmd, env)
        if not _stage_ok(job, rc, "lead-vocal separation"):
            return False
    if not backing_p.exists():
        raise RuntimeError("the detector exited cleanly but produced no backing stem to measure")

    # ── stage 3: spans ───────────────────────────────────────────────────────
    if _canceled(job):
        return False
    job.stage = "analyze"
    emit(job, {"type": "stage", "stage": "analyze", "n": 3, "total": 4})
    wet, sr = leadvocal.read_wav(wet_p)

    def _at_vocal_rate(path, what):
        """The child's output, on the VOCAL's sample rate. `(samples, reason_if_unusable)`.

        🔴 THIS IS WHY THE SECOND RUN OF A SONG USED TO FAIL. The envelopes are compared frame
        by frame, so the two signals must share a rate — and on a FRESH split they happened to
        (Demucs writes 44.1 kHz and the karaoke model answers 44.1 kHz), which is why every test
        and the first live run passed. On a RE-RUN the vocal comes out of the store, where a stem
        is Opus, and **Opus is a 48 kHz codec**: it decodes at 48000 whatever went in, the model
        still answers 44100, and the guard below correctly refused to cut. Correct, and useless —
        the re-run is §4b's whole escape hatch and all of m2's Extract action."""
        x, x_sr = leadvocal.read_wav(path)
        if x_sr == sr:
            return x, ""
        emit(job, {"type": "log",
                   "line": f"Resampling the {what} from {x_sr} Hz to the vocal's {sr} Hz…"})
        fixed = Path(str(path)).with_name(f"{Path(path).stem}_at{sr}.wav")
        rc = _run_stage(job, leadvocal.build_resample_cmd(path, fixed, sr))
        if rc != 0 or not fixed.exists():
            return None, f"could not bring the {what} from {x_sr} Hz onto the vocal's {sr} Hz"
        x, x_sr = leadvocal.read_wav(fixed)
        return (x, "") if x_sr == sr else (None, f"the {what} is still {x_sr} Hz")

    backing, why = _at_vocal_rate(backing_p, "detector output")
    if backing is None:
        # The backstop stays. A song cut at the wrong places is worse than a song not cut.
        raise RuntimeError(f"{why} — the spans would land in the wrong place")
    spans, lead_db, _on = leadvocal.analyze(wet, backing, sr, p)

    # An empty span set may mean either continuous backing or failed separation. Correlation can identify uncertain cases but cannot distinguish those causes, so log an advisory and preserve the spans for human review.
    echo = leadvocal.detection_looks_unreliable(
        lead_db, leadvocal.envelope_db(backing, leadvocal.peak_of(wet), p), p)
    if echo:
        emit(job, {"type": "log",
                   "line": f"⚠ Warning: {leadvocal.LEAD_WARNING} — {echo}. That happens both when "
                           f"the model fails to separate a song and when a song is stacked from "
                           f"end to end, and no measurement here can tell those apart. The full "
                           f"vocal is in the set: play it and decide."})

    # §3.5 — the de-reverbed file is used ONLY if it is sample-aligned with the wet one the
    # spans were measured on. Measured across four models: two come back a few hundred samples
    # SHORT with zero lag, so the tail is padded; a non-zero lag or a bigger deficit falls back
    # to cutting the wet file. A song with its reverb still in it is a usable dataset; a song
    # cut at the wrong places is not.
    cut_from, dereverb, skipped = wet, False, ""
    if p.dereverb:
        if not dry_p.exists():
            skipped = "the de-reverb stage produced no file"
        else:
            dry, why_sr = _at_vocal_rate(dry_p, "de-reverbed vocal")
            if dry is None:
                skipped = why_sr
            else:
                aligned, why = leadvocal.align_dry(dry, wet, sr)
                if aligned is None:
                    skipped = why
                else:
                    cut_from, dereverb = aligned, model
        if skipped:
            emit(job, {"type": "log",
                       "line": f"Keeping the reverb on this one — {skipped}. The cut is made on "
                               f"the original vocal instead, and the set records why."})

    # ── stage 4: cut, join, commit ───────────────────────────────────────────
    if _canceled(job):
        return False
    job.stage = "finalize"
    emit(job, {"type": "stage", "stage": "finalize", "n": 4, "total": 4})
    source_sec = len(wet) / float(sr)
    block = leadvocal.lead_block(spans, source_sec, detector=leadvocal.detector_name(),
                                 device=lv_device, dereverb=dereverb, params=p, built_at=_now(),
                                 dereverb_skipped=skipped, detector_warning=echo)

    produced = {}
    if spans:
        produced[stems.LEAD_SOLO] = leadvocal.write_wav(
            work / stems.LEAD_SOLO, leadvocal.cut_join(cut_from, sr, spans, p), sr)
    else:
        # 🔴 §9.5 — "this song is unusable for training" IS A REAL ANSWER and must not look like
        # a crash. It must not look like a success with a playable file either: a zero-length
        # WAV is a pill that plays nothing. So the set gets the `lead:` block explaining what
        # happened and no lead stem, and the row badges it thin.
        emit(job, {"type": "log",
                   "line": "No passages were found where the lead sings alone — nothing to cut. "
                           "That is a real answer about this song, not a failure: try one with "
                           "fewer stacked choruses."})
        # And the STALE one goes, or the sidecar would describe a file that is not the file on
        # disk. This is the one delete in the mode, and it only ever removes this mode's own
        # previous output (§6 R3: a re-run overwrites in place).
        old = stems.find_stem(d, "lead_solo")
        if old is not None:
            vault_fs.unlink(old, missing_ok=True)

    spans_p = work / stems.LEAD_SPANS
    report = leadvocal.spans_json(spans, source_sec, p, detector=leadvocal.detector_name(),
                                  dereverb=dereverb, dereverb_skipped=skipped)
    spans_p.write_text(report, encoding="utf-8")
    produced[stems.LEAD_SPANS] = spans_p

    # READ-MODIFY-WRITE, never a fresh dict: commit() writes the whole sidecar, so building one
    # here would erase the song's identity, its provenance and its duration — everything stage 1
    # recorded. The set is EXTENDED, exactly as a 4-stem split extends a 2-stem one.
    meta = dict(stems.read_meta(d, strict=True))
    meta["lead"] = block
    stems.commit(d, produced, meta)

    emit(job, {"type": "log",
               "line": f"[4/4] {block['spans']} span(s) kept — {block['kept_sec']:.0f}s of "
                       f"{block['source_sec']:.0f}s. Saved as the Lead vocal."})
    if block["thin"]:
        emit(job, {"type": "log",
                   "line": f"⚠ Only {block['kept_sec']:.0f}s came back, under the "
                           f"{leadvocal.MIN_USEFUL_SEC:.0f}s worth training on. Gather a few "
                           f"more songs by the same singer — a dataset is accumulated, not "
                           f"found in one track."})
    emit(job, {"type": "stems_saved", "ref": d.name})
    return True


# ── the job ──────────────────────────────────────────────────────────────────

def run_split_job(job: StemJob, cfg: StemConfig):
    """Split a song into the store while serializing GPU work through the Stems lock."""
    work = cfg.work_root / job.id
    try:
        job.status = "running"
        job.started_at = time.time()
        emit(job, {"type": "job_start", "id": job.id, "kind": "stemsplit"})

        if not cfg.python.exists():
            raise RuntimeError(
                f"Stems Demucs interpreter not found: {cfg.python} — set VOCALIS_STEMS_VENV "
                "to the image-owned Stems environment")

        lead = job.mode == "lead"
        # 🔴 "Lead vocals only" runs stage 1 in the `vocals` HARVEST mode (§6.4): the same
        # Demucs child and the same `--two-stems=vocals` pass, with ONLY the vocal committed.
        # The instrumental it computes is dropped, because the lead is about to be cut and a
        # full-length backing track beside a truncated vocal is a pair that can only mislead.
        harvest = "vocals" if lead else job.mode
        total = 4 if lead else 2

        waited = False
        while not stem_engine.STEMS_LOCK.acquire(timeout=0.5):
            if not waited:
                waited = True
                emit(job, {"type": "log",
                           "line": "Waiting for the running swap/split to finish…"})
            if job.cancel.is_set():
                job.status = "canceled"
                emit(job, {"type": "canceled"})
                return
        try:
            src = song_library.resolve_song(cfg, job.source_ref)
            if src is None or src.kind != "song":
                raise RuntimeError(f"the song is gone: {job.source_ref}")

            job.stage = "split"
            emit(job, {"type": "stage", "stage": "split", "n": 1, "total": total})
            vocals, _inst, ref = stem_engine.get_stems(job, cfg, src, harvest, work)
            if vocals is None:
                return                          # canceled inside — already reported
        finally:
            # 🔴 8.4 §9.2 — THE LOCK COVERS STAGE 1 AND STOPS THERE. It exists because Demucs
            # is the GPU-hungry child a swap runs too; the lead chain's remaining stages were
            # MEASURED CPU-only (§4), so holding it across them would block every swap on the
            # box for three minutes of work that never touches a card. Releasing here is safe
            # because what stage 1 hands back is either a work-dir WAV this job owns or a
            # committed file in the store — nothing the released lock was protecting.
            stem_engine.STEMS_LOCK.release()

        if lead and not _run_lead(job, cfg, vocals, ref, work):
            return                              # canceled inside — already reported
        if not lead:
            job.stage = "finalize"
            emit(job, {"type": "stage", "stage": "finalize", "n": 2, "total": 2})
            emit(job, {"type": "log", "line": "[2/2] Stems saved to the library."})

        job.result_ref = ref
        job.status = "done"
        job.stage = ""
        emit(job, {"type": "job_done", "ref": ref,
                   "duration_s": stems.read_meta(stems.find_dir(cfg, ref)
                                                 or Path(cfg.stems_dir) / ref
                                                 ).get("duration_s")})
    except VaultAuthError as exc:                              # BOUNDARY 2 of 5 — BY NAME
        vault_store.fail_job_on_vault_auth(job, exc, emit)
    except Exception as exc:                                   # noqa: BLE001
        job.status = "failed"
        # Same split as voiceswap: the child's output carries full paths (⇒ song titles),
        # so it reaches the browser via job.error/.detail but never str(exc), which is what
        # Keep child output in the authenticated job response, not the service log message.
        detail = getattr(exc, "detail", "")
        job.error = f"{exc}: {detail}" if detail else str(exc)
        logger.exception(f"stemsplit job {job.id} failed")
        emit(job, {"type": "error", "message": job.error})
    finally:
        job.stage = "" if job.status == "done" else job.stage
        shutil.rmtree(work, ignore_errors=True)
