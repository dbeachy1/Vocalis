"""Resolve voice files and maintain their sidecar metadata.

This storage layer is shared by the Voices tab, speech integrations, Nomi, and
playground routes. Read and write voice data through `vault_fs` so encrypted stores
preserve both filenames and contents.
"""
import hashlib
import json
import re
import uuid
from pathlib import Path

import vault_fs
import voice_utils
from loguru import logger

from vocalis.runtime import paths


def prov_path(voice: Path) -> Path:
    """A voice's sidecar: <stem>.voice.json beside the clip.

    Every voice records an explicit `origin` marker, so uploaded clips do not depend on
    inferring their type from missing metadata. The sidecar follows the clip on create or
    delete; clip filenames remain stable."""
    return voice.parent / (voice.stem + ".voice.json")


def read_sidecar(voice: Path) -> dict:
    """A voice's sidecar as a dict, or {} when it has none / it's unreadable. Never raises:
    a corrupt sidecar degrades a voice to "no recorded provenance", it never hides the voice
    or sinks the request that happened to read it.

    Read through `vault_fs` because voice samples and their sidecars may be encrypted.
    A vault authentication failure propagates; only ordinary file and JSON errors degrade
    to empty metadata."""
    p = prov_path(voice)
    if not vault_fs.exists(p):
        return {}
    try:
        got = json.loads(vault_fs.read_text(p))
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError) as exc:
        logger.warning(f"voices: sidecar unreadable for {voice.name}: {exc}")
        return {}


def resolve_ref(name: str):
    """Map an OpenAI/SillyTavern voice name to a reference clip in voice_samples/.
    Accepts the exact filename or a bare stem (matched against any audio extension,
    preferring .wav). Returns a Path or None. Path-traversal safe (leaf only)."""
    name = (name or "").strip()
    if not name:
        return None
    # §4.10 — vault_fs. Unrouted, BOTH arms fail: the exact hit answers False and the iterdir
    # yields ciphertext names, so this returns None for every voice in the store. It is what
    # /speak, /v1 (SillyTavern) and voices_delete all resolve through, so a silent None here is
    # "that voice does not exist" on every integration at once.
    leaf  = Path(name).name                      # strip any directory part
    exact = paths.VOICE_SAMPLES / leaf
    if exact.suffix.lower() in paths.AUDIO_EXTS and vault_fs.exists(exact):
        return exact
    stem = Path(leaf).stem.lower()
    matches = [paths.VOICE_SAMPLES / n for n in vault_fs.listdir(paths.VOICE_SAMPLES)
               if Path(n).suffix.lower() in paths.AUDIO_EXTS and Path(n).stem.lower() == stem]
    matches.sort(key=lambda f: (f.suffix.lower() != ".wav", f.name))   # prefer .wav
    return matches[0] if matches else None


def options():
    """All audio files in voice_samples/ as {name, stem, label, favorite} — for
    /v1/audio/voices and the Nomi + SillyTavern admin tabs (wav AND mp3; the
    Book /voices list stays wav-only). `label` is the cosmetic Voices-tab
    rename ('' if none) — every voice dropdown displays label||name, so this
    ONE helper must carry it or those tabs regress to raw filenames.

    🔴 `favorite` is here for the same reason, and it was missed once (4.8-m5): the ★
    sort/star is a property of the voice LIST, so the client builds every dropdown through
    one helper — but Nomi/ST feed that helper from THIS payload, not from `GET /voices`.
    A key absent here isn't a visibly broken dropdown, it's `undefined` → no star and a
    stable sort that quietly leaves favorites where they were. Any flag a picker renders
    must appear in BOTH payloads or it silently applies to only half the tabs."""
    # §4.10 — the same conversion `files()` got, and 5.1-P4.9 made it literally the same call
    # rather than a second copy of it. This payload feeds Nomi + SillyTavern while `files()`
    # feeds the Book tab, so routing one and not the other means half the app can see the
    # voices and half cannot — and two copies is how that happens. They were already
    # character-for-character identical (same listdir, same AUDIO_EXTS filter, same
    # name.lower() sort); the only thing keeping them apart was living in different files.
    labels = voice_utils.get_labels(paths.VOICE_SETTINGS)
    return [{"name": f.name, "stem": f.stem, "label": labels.get(f.name, ""),
             "favorite": bool(read_sidecar(f).get("favorite"))}
            for f in files()]


# ── The registry proper (5.1-P4.9) ────────────────────────────────────────────
# Everything below came out of `vocalis_server.py` with the Voices tab. It is here rather than
# in `web/voices.py` for the reason the four functions above are: these answer "what voices
# exist and what is recorded about them", which is a question the store answers, not a question
# a route answers. `web/voices.py` is the HTTP skin over this; nothing here imports Flask, and
# `test_m6_e2e` drives six of them directly with no app at all.
#
# 🔴 The two overwrite guards live here — `name_conflict` and `unique_wav_name`. §14.9.1's
# "ONE RULE — NEVER OVERWRITE" is enforced by nothing else, and both of them are only as good
# as `files()` below, which is why that one goes through `vault_fs.listdir`.


def files() -> list:
    """Every audio file in voice_samples/, name-sorted.

    Not just .wav. An uploaded clip is transcoded to WAV, but a clip dropped in by hand can be
    any format the model conditions on directly (Chatterbox loads the reference through
    librosa — mp3/flac/ogg/m4a/opus all decode). The play/delete/render paths resolve by real
    filename, so the list must surface these too — otherwise a hand-added .mp3 is invisible
    here and unusable everywhere. AUDIO_EXTS matches options() (the Nomi/ST/OpenAI
    list), which was already all-audio.

    🔴 `vault_fs.listdir`, and it is the whole Voices tab. `VOICE_SAMPLES.iterdir()` on an
    encrypted store yields SIV-ciphertext names whose suffixes are not in AUDIO_EXTS, and
    `.exists()` on the plaintext directory is False before that — so this returns [] and the
    tab is EMPTY. That much you would see. What you would not see is `name_conflict`
    walking the same empty list and therefore never finding a conflict: §14.9.1's "ONE RULE —
    NEVER OVERWRITE" is enforced entirely by this function, so a second voice saved under an
    existing label would sail past the 409, resolve to the same filename, and REPLACE the first
    one. Silent data loss in the one store the user cannot regenerate."""
    return sorted((paths.VOICE_SAMPLES / n for n in vault_fs.listdir(paths.VOICE_SAMPLES)
                   if Path(n).suffix.lower() in paths.AUDIO_EXTS),
                  key=lambda p: p.name.lower())


def wav_name(name: str) -> str:
    """Normalize an uploaded/target name to a safe <stem>.wav filename."""
    stem = Path(name).stem
    stem = re.sub(r'[^\w.\- ]', '', stem).strip() or "voice"
    return stem + ".wav"


def display_name(p: Path, labels: dict) -> str:
    """What the user calls this voice: its label, else its bare stem.

    The stem, NOT the filename — the extension is plumbing, and comparing a typed "Sarah"
    against a displayed "Sarah.wav" would miss the collision and then silently write a second
    voice beside the first (4.8-m3 §14.2: the label is the uniqueness namespace)."""
    return labels.get(p.name) or p.stem


def origin(voice: Path) -> str:
    """"created" (VoxCPM2 designed it) or "uploaded" (everything else).

    🔴 NO SIDECAR ⇒ UPLOADED, deliberately kept after the backfill. `GET /voices` lists every
    audio file in voice_samples/, and hand-dropping a .wav/.mp3 straight into the folder is an
    explicitly supported path — such a file arrives with no sidecar at any time, so the code
    needs a defined answer for it. We do NOT write sidecars from the read path; the backfill
    script is re-runnable precisely so those get stamped later, on purpose, not as a
    side effect of somebody opening the Voices tab."""
    return "created" if read_sidecar(voice).get("origin") == "created" else "uploaded"


def added_at(voice: Path, side: dict) -> tuple:
    """(when this voice arrived, whether that is a RECORDED fact) — the §16.3 ladder.

    A sidecar's `created` is a fact for an upload (stamped at upload time) and for a designed
    voice (stamped at freeze). A BACKFILLED sidecar carries `created` too — but the script
    took it from the file's mtime and said so, which is exactly why it writes
    `"backfilled": true`: so a later "recently added" sort can tell what we observed from
    what we guessed. A voice with no sidecar at all is that same guess without the marker.

    🔴 Sorting on an inferred date is fine; ASSERTING one is not — the UI must never print it
    as a hard date (§16.3), which is what the second element of this tuple is for."""
    got = side.get("created")
    if isinstance(got, (int, float)) and not isinstance(got, bool):
        return float(got), not bool(side.get("backfilled"))
    # vault_fs.stat, not voice.stat(): the clip is in voice_samples/ too, so under encryption a
    # bare stat() raises FileNotFoundError, the `except` below swallows it, and EVERY
    # sidecar-less voice dates to the epoch — a default-sorted list in silently arbitrary order.
    # vault_fs.stat returns None rather than raising, and its mtime is the real one (clear_cache
    # is nothing but an os.utime, so it has to be a number that moves).
    st = vault_fs.stat(voice)
    return (st.mtime if st is not None else 0.0), False


def meta(voice: Path) -> dict:
    """Everything `GET /voices` wants from a voice's sidecar, from ONE read of it.

    `origin` stays the helper for the paths that only want origin
    (`name_conflict`), but the list route needs three facts per voice and reading the
    same small JSON three times per voice per request is a silly way to build a list (§16.4)."""
    side = read_sidecar(voice)
    added, exact = added_at(voice, side)
    # 8.7 — the two CLEANING badges. They are recorded per voice rather than derived, because
    # nothing about the audio says whether a model has been over it, and the whole point of the
    # badge is that a cleaned copy and its original sit side by side in this list under names
    # the user chose. Only ever True for a copy `voiceclean` made, and only for the halves that
    # actually landed — a de-reverb that came back misaligned is skipped, and must not badge.
    return {"origin": "created" if side.get("origin") == "created" else "uploaded",
            "favorite": bool(side.get("favorite")),
            "dereverbed": bool(side.get("dereverbed")),
            "enhanced": bool(side.get("enhanced")),
            "cleaned_from": str(side.get("cleaned_from") or ""),
            "added": added, "added_exact": exact}


def name_conflict(label: str, exclude: str = ""):
    """(origin, path) of an existing voice already called `label`, else None.

    🔴 ONE RULE — NEVER OVERWRITE (§14.9.1). The namespace is every voice, both origins, and
    the check is case-insensitive because "sarah" and "Sarah" are the same person to a user.
    `exclude` skips one filename, so re-saving a voice's own label during a rename isn't a
    conflict with itself."""
    want = (label or "").strip().casefold()
    if not want:
        return None
    labels = voice_utils.get_labels(paths.VOICE_SETTINGS)
    for p in files():
        if p.name == exclude:
            continue
        if display_name(p, labels).strip().casefold() == want:
            return origin(p), p
    return None


def conflict_message(label: str, origin: str) -> str:
    """The rejection the user reads. It names WHERE the collision lives (§14.2) — being told
    only "that name is taken" while looking at a tab that doesn't contain it is a dead end."""
    kind = "A created voice" if origin == "created" else "An uploaded voice"
    return f"{kind} is already called {label}. Please choose a different name."


def unique_wav_name(label: str) -> str:
    """The on-disk filename for a voice the user named `label`.

    The label is already unique by rule, so this exists for SANITIZATION collisions only
    (§14.10): wav_name() strips non-word characters, so "Sarah (warm)" and "Sarah warm" both
    reduce to "Sarah warm.wav". Those get a short hash suffix — silently, because the user
    never sees filenames and so must never be asked to resolve one. Deterministic on the first
    try so the same label lands on the same name; the counter is a pure safety net."""
    # vault_fs.exists — a bare .exists() answers False for every name once the store is
    # encrypted, so this would hand back `base` unconditionally and the caller would write
    # straight over whatever already lives there. It is the second of the two guards against
    # overwriting a voice (the first is name_conflict), and both failed the same way.
    base = wav_name(label)
    if not vault_fs.exists(paths.VOICE_SAMPLES / base):
        return base
    stem = Path(base).stem
    for n in range(1, 1000):
        h = hashlib.sha1(f"{label}\x00{n}".encode("utf-8")).hexdigest()[:5]
        cand = f"{stem}_{h}.wav"
        if not vault_fs.exists(paths.VOICE_SAMPLES / cand):
            return cand
    return f"{stem}_{uuid.uuid4().hex[:5]}.wav"          # unreachable in practice


def write_sidecar_or_raise(dst: Path, data: dict) -> None:
    """The same write, letting OSError out. For ★ (§16.8), whose entire effect IS the write:
    swallowing a failure there answers 200 to a request that changed nothing, and "a star that
    only exists in the DOM is a lie the next refresh silently corrects". Every other caller
    wants the forgiving form above — by the time they call, the voice is already saved.

    🔴 THE SILENT HALF (vault_fs's own heading). A bare `write_text` here deposits plaintext
    JSON inside the encrypted store and raises NOTHING — and for a designed voice that JSON
    holds the prompt text and the sample text the user typed, i.e. precisely what 5.0 exists to
    encrypt. `write_yaml_atomic` is the wrong seam despite §5's table: it serializes with
    `yaml.safe_dump`, and every reader of this file is `json.loads`. The vault arm of
    `write_text` is atomic anyway — `vault.open_write()` does its own `.part` + atomic_replace,
    which is the property `write_yaml_atomic` was reaching for."""
    vault_fs.write_text(prov_path(dst), json.dumps(data, indent=2))


def write_sidecar(dst: Path, data: dict) -> None:
    """Write a voice's sidecar. Best-effort by design: the voice itself is already on disk and
    usable, so a failed sidecar write degrades origin to "uploaded" rather than failing a save
    the user watched succeed."""
    try:
        write_sidecar_or_raise(dst, data)
    except OSError as exc:
        logger.warning(f"voices: couldn't write sidecar for {dst.name}: {exc}")


def in_use(name: str) -> bool:
    """True when the Nomi map or a SillyTavern character (or either tab's
    default_voice) references this voice. Informational only — deletion
    proceeds regardless; the UI just warns."""
    for section in ("nomi", "sillytavern"):
        sec = voice_utils.get_section(paths.VOICE_SETTINGS, section)
        if sec.get("default_voice") == name:
            return True
        if any(e.get("voice") == name for e in sec.values() if isinstance(e, dict)):
            return True
    return False

# ── Shared with more than one blueprint (5.1-P4.10a) ─────────────────────────
# Both answer a question about a voice NAME, which is this module's job; books and
# playground each resolve one on the way into a render.

def narrator_name(voice: str) -> str:
    """Human narrator label from a voice filename: 'Lily_Patel_sample.wav' -> 'Lily_Patel'
    (strips a trailing 'sample' / 'NN second sample' suffix). '' for the model default."""
    n = Path(voice).stem if voice else ""
    return re.sub(r'[_ ]*(\d+[_ ]*second[_ ]*)?sample$', '', n, flags=re.I).strip('_ ') or n


def resolve_leaf(name: str) -> str:
    """A render request's `voice` field → the real on-disk clip's filename, any audio
    extension. The Voices tab and voice dropdowns now list mp3/flac/… alongside .wav, so
    the value posted back may carry any of those — _wav_name() would coerce it to a
    phantom '<stem>.wav' the render then can't find. Path-traversal-safe: resolve_ref
    reduces to the leaf and only returns a file that exists inside voice_samples/. Falls
    back to the bare leaf when nothing resolves, so _voice_file_error() reports a clean
    'not found' rather than silently dropping the caller's choice to the model default."""
    ref = resolve_ref(name)
    return ref.name if ref is not None else Path(name).name
