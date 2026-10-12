#!/usr/bin/env python3
"""Stamp every existing voice with a `<stem>.voice.json` sidecar (Vocalis 4.8-m3).

WHY THIS EXISTS
    Vocalis used to infer "this voice was uploaded" from the ABSENCE of a sidecar — a
    convention only our own code knew. 4.8-m3 replaced that with a positive `origin` marker on
    every voice (DESIGN_4_8_VOXCPM.md §14.6a), so the Voices tab can split into "Uploaded" and
    "Created" lists and each one can be counted honestly. Voices that predate m3 have no
    sidecar; this walks voice_samples/ and gives them one.

    It also completes the rename: sidecars written by 4.8-m2b..m2e were called
    `<stem>.voxcpm.json`. Those are moved to `<stem>.voice.json` and gain `origin: "created"`.
    (Legacy names are migrated so installs that ran an m2 build keep their origin metadata.)


RE-RUNNABLE, ON PURPOSE
    `GET /voices` lists every audio file in voice_samples/, and dropping a .wav in by hand is
    an explicitly supported path — such a file appears with no sidecar at any time. The server
    deliberately does NOT write sidecars from the read path (that would make opening a tab
    mutate the store), so this script is the way those get stamped. Running it twice is safe:
    a voice that already has a sidecar is left completely alone.

    An inferred timestamp is marked as one. `created` comes from the file's mtime, which is
    when the file was last written — near enough to "when it was added" to sort by, but not a
    recorded fact — so the entry also carries `"backfilled": true`. Anything that later sorts
    by "recently added" (§14.7) can tell the difference between what we observed and what we
    guessed.

IT GOES THROUGH THE VAULT (5.0-M10, §3a.2)
    `voice_samples/` is a routed tree. Walking it with `iterdir()` on an encrypted store hands
    back SIV-ciphertext names, whose suffixes are not audio extensions — so this script would
    match nothing, print "0 stamped", and EXIT 0. Every read and write below is therefore a
    `vault_fs` call, and the script asks for the vault password when the store is initialized.
    With no `vault_keys.yaml` the router is inert and every call is a plain `open()`, which is
    what makes today's unencrypted install behave exactly as it did before.

USAGE
    python scripts/backfill-voice-sidecars.py            # do it
    python scripts/backfill-voice-sidecars.py --dry-run  # say what it would do
    python scripts/backfill-voice-sidecars.py --dir /some/other/voice_samples
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

import vault_fs        # noqa: E402  — needs the path above
import vault_store     # noqa: E402

# Mirrors vocalis_server.AUDIO_EXTS — the set of things GET /voices will list.
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"}

DEFAULT_DIR = REPO_ROOT / "voice_samples"


def sidecar_path(voice: Path) -> Path:
    return voice.parent / (voice.stem + ".voice.json")


def legacy_path(voice: Path) -> Path:
    return voice.parent / (voice.stem + ".voxcpm.json")


def backfill(folder: Path, dry_run: bool = False) -> dict:
    """Give every audio file in `folder` a sidecar. Returns a counts dict."""
    counts = {"stamped": 0, "migrated": 0, "skipped": 0, "failed": 0}
    folder = folder.resolve()               # the router matches absolute paths, not relative ones
    if not vault_fs.is_dir(folder):
        print(f"no such folder: {folder}", file=sys.stderr)
        return counts

    # listdir, not iterdir: inside the vault it decrypts each entry NAME and opens zero files.
    # iterdir would hand back ciphertext names and quietly match no audio extension at all.
    for name in sorted(vault_fs.listdir(folder), key=str.lower):
        voice = folder / name
        if voice.suffix.lower() not in AUDIO_EXTS or vault_fs.is_dir(voice):
            continue
        dst, legacy = sidecar_path(voice), legacy_path(voice)

        if vault_fs.exists(dst):                # already has one — never touch it
            counts["skipped"] += 1
            continue

        if vault_fs.exists(legacy):
            # An m2-era created voice. Carry its provenance across intact and add the origin
            # the old shape never recorded (that file could ONLY ever be a designed voice).
            try:
                data = json.loads(vault_fs.read_text(legacy))
                if not isinstance(data, dict):
                    data = {}
            except (OSError, ValueError) as exc:
                print(f"  ! {voice.name}: unreadable {legacy.name} ({exc}) — treating as empty")
                data = {}
            data.setdefault("origin", "created")
            action, key = "migrated", "migrated"
        else:
            st = vault_fs.stat(voice)           # None only if it vanished between listdir and here
            data = {"origin": "uploaded", "created": st.mtime if st is not None else 0.0,
                    "backfilled": True}
            action, key = "stamped", "stamped"

        if dry_run:
            print(f"  would {action}: {voice.name} -> {dst.name} (origin={data['origin']})")
            counts[key] += 1
            continue

        try:
            vault_fs.write_text(dst, json.dumps(data, indent=2))
            if action == "migrated":
                vault_fs.unlink(legacy, missing_ok=True)  # only after the new one is safely written
            print(f"  {action}: {voice.name} -> {dst.name} (origin={data['origin']})")
            counts[key] += 1
        except OSError as exc:
            print(f"  ! {voice.name}: {exc}", file=sys.stderr)
            counts["failed"] += 1

    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR,
                    help=f"the voice_samples folder (default: {DEFAULT_DIR})")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would happen and change nothing")
    ap.add_argument("--keyfile", type=Path, default=None,
                    help="vault_keys.yaml location (default: <install root>/vault_keys.yaml)")
    args = ap.parse_args()

    # Same four lines as vault_migrate.main — one way to reach the store, not two. With no
    # keyfile `is_initialized()` is False, nothing prompts, and route() stays inert: a
    # pre-encryption install never notices this block exists. A DRY RUN still unlocks, because
    # without the DEK it cannot even READ the directory to tell you what it would do.
    roots = vault_store.default_roots()
    store = vault_store.configure(roots, args.keyfile or (roots[0][1] / "vault_keys.yaml"))
    if store.is_initialized():
        store.unlock_with_password(getpass.getpass("Vault password: "))

    print(f"{'(dry run) ' if args.dry_run else ''}backfilling sidecars in {args.dir}")
    c = backfill(args.dir, dry_run=args.dry_run)
    print(f"\n{c['stamped']} stamped uploaded, {c['migrated']} migrated from .voxcpm.json, "
          f"{c['skipped']} already had one, {c['failed']} failed.")
    return 1 if c["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
