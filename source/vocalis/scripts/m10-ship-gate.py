#!/usr/bin/env python3
"""THE M10 SHIP GATE — build a real vault, drive the converted surfaces, grep the bytes.

WHY A SCRIPT AND NOT A TEST
    Because the test suite structurally cannot answer this question, and DESIGN_5_0_M10 §8 says
    so in capitals. `vault_store.route()` is INERT until a vault is initialized, and only two
    test files ever initialize one — the other ~1,400 tests would be **exactly as green over a
    store that is 100% cleartext**. That inertness is deliberate (it is what let M6/M7 ship
    before M9's migration, and what keeps the suite runnable), and its price is that the routing
    is never exercised by default.

    So the only instrument that works is: turn the vault ON, run the real code, and go and look
    at the bytes on the platter. A missed write does not raise. It writes plaintext into the
    vault under its logical name, listdir steps over it, the app behaves perfectly, and nothing
    anywhere ever says so.

    This is the check to run BEFORE `vault_migrate --enable` on a real library
    (DEPLOYMENT_QA_5_0 §0, row 1). It touches nothing outside its own temp directory.

WHAT IT DRIVES
    The three surfaces §8 names, which are the three §9 spent its risk budget on:
      1. a VOICE IMPORT   — voice_models/, the registry: 13-18 GPU-hours per voice, no re-download
      2. a CLEANED CLIP   — voice_training/, the user's own recorded voice
      3. a QUEUED SWAP    — output/, whose queue file names the song and the voice in its body

WHAT IT LOOKS FOR
    Magic bytes at OFFSET ZERO ONLY, never scanned across the file. Ciphertext is random bytes,
    so a 2-byte marker like an MP3 frame sync occurs ~1.5x by chance per 96 KB — the whole-file
    scan measured 311 false positives in 400. A test that cries wolf about cleartext is worse
    than no test, because the second time it does it nobody believes the third. A header lives
    at the head; look at the head. Long text markers (5+ bytes) still scan whole files.

USAGE
    python scripts/m10-ship-gate.py          # exit 0 = clean, 1 = cleartext found

    Run it from the repo root, with the server's venv. It needs torch and soundfile.
"""

from __future__ import annotations

import io
import os
import pathlib
import shutil
import sys
import tempfile

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

PW = "correct horse battery staple"

# Offset 0 only — see the module docstring.
MAGIC = (b"RIFF",                       # a WAV
         b"ID3", b"\xff\xfb",           # an MP3, tagged or a bare frame
         b"PK\x03\x04")                 # a torch .pth — the trained-voice registry

# Scanned whole-file; each is long enough that a chance hit in ciphertext is ~1 in a million.
TEXT = (b"favorite:", b"created:", b"text:", b"voice:", b"song:", b"entries:",
        b'"origin"', b'"favorite"', b'"backfilled"', b'"sample_text"',   # the JSON sidecars
        b'Sample Track', b'Sample Voice')    # the names THIS run puts in


def main() -> int:
    root = pathlib.Path(tempfile.mkdtemp(prefix="m10-ship-gate-"))
    try:
        install, cache, scratch_dir = root / "install", root / "cache", root / "scratch"
        for d in (install, cache, scratch_dir):
            d.mkdir(parents=True)
        os.environ["VOCALIS_CACHE_DIR"] = str(cache)
        os.environ["VOCALIS_SCRATCH_DIR"] = str(scratch_dir)

        import vault
        import vault_store
        # A test-cost KDF: this gate is about routing, not about how long argon2 takes.
        vault.DEFAULT_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024,
                             "time_cost": 1, "parallelism": 1}
        store = vault_store.configure([("install", install), ("cache", cache)],
                                      install / "vault_keys.yaml")
        store.create(PW)
        print(f"vault created at {install}")

        import torch
        import cleanup
        import swap_queue
        import voiceswap
        from tts_utils import save_wav_sf

        # 1 ── import a brought-your-own RVC voice (§4.1)
        pth = scratch_dir / "upload.pth"
        torch.save({"weight": {"x": torch.zeros(4)}, "config": [1],
                    "sr": 40000, "f0": 1, "version": "v2"}, str(pth))
        with open(pth, "rb") as f:
            voiceswap.import_voice(install / "voice_models", 'Sample Voice', f,
                                   index_stream=io.BytesIO(b"INDEXBLOB" * 99))
        print("  ✓ imported an RVC voice")

        # 2 ── land a cleaned clip (§4.2 C1)
        take = scratch_dir / "take.wav"
        save_wav_sf(str(take), torch.zeros(1, 24000), 24000)
        cleanup._land(take, install / "voice_training" / "clip.cleaned.wav")
        print("  ✓ landed a cleaned clip")

        # 3 ── queue a swap (§4.3)
        q = swap_queue.SwapQueue(install / "output" / "voiceswap_queue.yaml")
        q.add({"song": 'Sample Track.mp3', "voice": 'Sample Voice'}, label='Sample Track')
        print("  ✓ queued a swap")

        # ── THE GREP ────────────────────────────────────────────────────────
        allow = {"vault_keys.yaml", vault.SENTINEL_NAME}
        offenders, checked = [], 0
        for p in sorted(install.rglob("*")):
            if not p.is_file() or p.name in allow:
                continue
            checked += 1
            blob = p.read_bytes()
            hit = [m for m in MAGIC if blob.startswith(m)]
            hit += [m for m in TEXT if m in blob]
            if p.name.endswith(".part"):
                hit.append(b"<A CLEARTEXT .part SIBLING>")
            if hit:
                offenders.append(f"{p.relative_to(install)} -> {hit}")

        print(f"\nchecked {checked} files in the install root")
        # The same guard assert_no_cleartext carries: a grep over an EMPTY tree passes,
        # beautifully, forever. If the drives above stop writing here, that is a failure of the
        # instrument, not a clean store.
        if checked < 4:
            print(f"FAIL — only {checked} files to check. The drives above did not write to the "
                  f"store, so this gate proves NOTHING.")
            return 1
        if offenders:
            print("FAIL — CLEARTEXT INSIDE THE VAULT. One of these sites is not routed:")
            for o in offenders:
                print(f"   {o}")
            return 1
        print("PASS — no RIFF, no ID3, no .pth magic, no .part sibling, and no song, voice or "
              "sidecar text anywhere in the store.")
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
