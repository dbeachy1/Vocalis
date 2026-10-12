"""Prove the satellite stack stands up on this box, before any Vocalis code depends on it.

Six checks, in the order that a failure is most useful:

  1. CUDA torch is the ACTIVE install (not the CPU wheel pip loves to substitute)
  2. Chatterbox loads on the card, and what one replica actually costs in VRAM
  3. A voice sample decodes FROM MEMORY  <-- the load-bearing one
  4. ...including mp3, because Vocalis supports hand-dropped non-wav voices
  5. A real render happens, at what speed
  6. How many replicas would fit, measured rather than assumed

🔴 Check 3 is why this file exists. The whole security posture of DESIGN_5_3_SATELLITES.md
rests on "the satellite writes nothing to disk", and that in turn rests on chatterbox being
willing to take a file-like object instead of a path. `prepare_conditionals` calls
`librosa.load(wav_fpath)`, and librosa accepts file-like objects -- but that is a claim about
a library, and an earlier draft of the design got exactly this wrong in the other direction.
So it gets asserted on the real box rather than reasoned about.

Run standalone: venv\\Scripts\\python selftest.py
"""
import io
import sys
import time

FAIL = []


def ok(msg):
    print(f"  [OK]   {msg}")


def bad(msg):
    print(f"  [FAIL] {msg}")
    FAIL.append(msg)


def head(n, title):
    print(f"\n[{n}/6] {title}")


# ── 1. torch + CUDA ──────────────────────────────────────────────────────────
head(1, "torch / CUDA")
import torch                                                    # noqa: E402

print(f"       torch {torch.__version__}")
if "cu" not in torch.__version__:
    bad(f"CPU torch is active ({torch.__version__}) -- re-run step 3 of setup.bat")
    sys.exit(1)
if not torch.cuda.is_available():
    bad("torch.cuda.is_available() is False -- no usable CUDA device")
    sys.exit(1)
ok(f"{torch.cuda.get_device_name(0)}")
_free0, _total0 = torch.cuda.mem_get_info(0)
GB = 1024 ** 3
print(f"       {_free0 / GB:.1f} GB free of {_total0 / GB:.1f} GB before load")


# ── 2. Load the model ────────────────────────────────────────────────────────
head(2, "Chatterbox load (first run downloads ~3 GB of weights)")
from chatterbox.tts import ChatterboxTTS                        # noqa: E402

t0 = time.time()
model = ChatterboxTTS.from_pretrained(device="cuda")
load_s = time.time() - t0
free1, _ = torch.cuda.mem_get_info(0)
footprint = (_free0 - free1) / GB
ok(f"loaded in {load_s:.1f}s -- one replica costs ~{footprint:.1f} GB "
   f"({free1 / GB:.1f} GB still free)")
print(f"       sample rate: {model.sr} Hz")


# ── 3. Voice sample from MEMORY (the load-bearing check) ─────────────────────
head(3, "voice sample decoded from a BytesIO buffer (no file on disk)")
import numpy as np                                              # noqa: E402
import soundfile as sf                                          # noqa: E402

print(f"       soundfile {sf.__version__} / libsndfile {sf.__libsndfile_version__}")

# A synthetic 6-second reference. Quality is irrelevant -- this asserts the API
# contract (buffer accepted, conditionals built), not voice similarity.
sr_ref = 24000
t = np.linspace(0, 6.0, sr_ref * 6, endpoint=False)
ref = (0.3 * np.sin(2 * np.pi * 140 * t) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t))
       + 0.05 * np.random.randn(t.size)).astype(np.float32)

buf = io.BytesIO()
sf.write(buf, ref, sr_ref, format="WAV", subtype="PCM_16")
buf.seek(0)
try:
    model.prepare_conditionals(buf, exaggeration=0.5)
    ok("prepare_conditionals() accepted a BytesIO WAV -- no temp file needed")
except Exception as exc:                                        # noqa: BLE001
    bad(f"BytesIO WAV rejected: {exc!r}")
    bad("  -> DESIGN_5_3_SATELLITES.md section 5 is WRONG; the satellite would need a scratch")


# ── 4. ...and mp3, since Vocalis allows hand-dropped non-wav voices ──────────
head(4, "mp3 voice decoded from a buffer")
fmts = set(sf.available_formats())
if "MP3" not in fmts:
    bad(f"libsndfile has no MP3 support (needs 1.1+); formats: {sorted(fmts)}")
else:
    try:
        mbuf = io.BytesIO()
        sf.write(mbuf, ref, sr_ref, format="MP3")
        mbuf.seek(0)
        model.prepare_conditionals(mbuf, exaggeration=0.5)
        ok("prepare_conditionals() accepted a BytesIO MP3")
    except Exception as exc:                                    # noqa: BLE001
        bad(f"BytesIO MP3 rejected: {exc!r}")


# ── 5. A real render ─────────────────────────────────────────────────────────
head(5, "render")
TEXT = ("The satellite renders on the four ninety, and streams the audio back to the server, "
        "which caches it and passes it on exactly as it does today.")
t0 = time.time()
wav = model.generate(TEXT, exaggeration=0.5, cfg_weight=0.5, temperature=0.8)
gen_s = time.time() - t0
audio_s = wav.shape[-1] / model.sr
ok(f"{len(TEXT)} chars -> {audio_s:.1f}s audio in {gen_s:.1f}s "
   f"({audio_s / gen_s:.2f}x realtime, {len(TEXT) / gen_s:.0f} chars/s)")
print(f"       chars per audio-second: {len(TEXT) / audio_s:.1f}   "
      f"(the server's StreamConfig assumes 15.6)")


# ── 6. How many replicas fit ─────────────────────────────────────────────────
head(6, "capacity")
free2, total2 = torch.cuda.mem_get_info(0)
ACT_HEADROOM = 1.5           # tts_utils.WorkerPool default
fits = 1
while (free2 / GB) - fits * footprint >= (fits + 1) * ACT_HEADROOM:
    fits += 1
ok(f"~{fits} worker(s) fit on this card "
   f"({footprint:.1f} GB/replica + {ACT_HEADROOM} GB activation headroom each, "
   f"{free2 / GB:.1f} GB free)")
print("       NOTE: fitting is not the same as helping. Extra workers can be CPU-bound and may")
print("             not raise throughput; whether they help is a separate measurement, not")
print("             an inference from VRAM.")


# ── verdict ──────────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
if FAIL:
    print(f"  {len(FAIL)} CHECK(S) FAILED")
    for f in FAIL:
        print(f"    - {f}")
    print("=" * 60)
    sys.exit(1)
print("  ALL CHECKS PASSED -- the stack stands up on this box.")
print("=" * 60)
