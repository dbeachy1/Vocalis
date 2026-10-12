#!/usr/bin/env python
"""Headless end-to-end smoke test: render ONE short song straight through the ACE-Step
stack, with no Vocalis and no web UI in the picture.

WHY THIS EXISTS. Vocalis talks to ACE-Step over HTTP, so every Vocalis-side test can be
green while the stack underneath cannot render at all. This drives the real
`generate_music()` API the way `cli.py` does, so a failure here is ACE-Step's and a
failure there is ours. It is the fastest way to answer "is the backend actually working"
without a browser, a queue or a job record.

The render occupies one GPU for several minutes. `ACESTEP_SMOKE_CARD` is required so the test
does not select a device implicitly or compete with another workload.

📌 `thinking=True` is not decoration — it is what pulls the 5Hz LM in at all. A render
with it off never loads the LM and so never exercises the path that
`scripts/acestep/lm-dtype.patch` is about.

Run from the ACE-Step checkout with its virtual environment:

    cd ~/ACE-Step-1.5
    ACESTEP_SMOKE_CARD=1 .venv/bin/python /path/to/Vocalis/scripts/acestep/smoke-render.py

Turbo DiT + 5Hz LM, ~30 s track, `pt` backend. Downloads anything missing.
"""
import os
import sys
import tempfile
import time

# ── the card, before torch is imported ──────────────────────────────────────────────
# Set the visible-device variables before importing torch; the runtime reads them during
# initialization.
_card = os.environ.get("ACESTEP_SMOKE_CARD", "").strip()
if not _card:
    sys.exit(
        "ACESTEP_SMOKE_CARD is not set. This renders on a real GPU for minutes at a "
        "time — name the card explicitly, e.g. ACESTEP_SMOKE_CARD=1. Refusing to guess."
    )
os.environ["HIP_VISIBLE_DEVICES"] = _card
os.environ["CUDA_VISIBLE_DEVICES"] = _card

# Match the units (see ~/.config/systemd/user/acestep-api*.service) so this measures the
# same configuration the service runs, not a second one nobody deploys.
os.environ.setdefault("ACESTEP_LM_BACKEND", "pt")
os.environ.setdefault("MIOPEN_FIND_MODE", "FAST")
os.environ.setdefault("ACESTEP_ROCM_DTYPE", "bfloat16")

from acestep.handler import AceStepHandler
from acestep.llm_inference import LLMHandler
from acestep.inference import GenerationParams, GenerationConfig, generate_music
from acestep.model_downloader import (
    ensure_main_model, ensure_lm_model, ensure_dit_model, get_checkpoints_dir,
)

# ⚠️ NOT `os.path.dirname(__file__)`. This script used to live inside the ACE-Step tree,
# where its own directory WAS the project root; it lives in the Vocalis repo now, so that
# expression would hand ACE-Step a path to Vocalis and the model lookups would come back
# empty with no error worth reading.
project_root = os.environ.get("ACESTEP_ROOT") or os.path.expanduser("~/ACE-Step-1.5")
if not os.path.isdir(os.path.join(project_root, "acestep")):
    sys.exit(f"No ACE-Step checkout at {project_root}. Set ACESTEP_ROOT.")

device = "cuda"  # HIP presents as cuda in torch
ckpt = get_checkpoints_dir()
print(f"[setup] card = {_card}", flush=True)
print(f"[setup] project_root    = {project_root}", flush=True)
print(f"[setup] checkpoints_dir = {ckpt}", flush=True)

print("[dl] ensuring main model (VAE/text encoders + core)...", flush=True)
ok, msg = ensure_main_model(ckpt)
print(f"[dl] main: {ok} {msg}", flush=True)

dit = AceStepHandler()
avail = dit.get_available_acestep_v15_models()
print(f"[dit] available: {avail}", flush=True)
config_path = "acestep-v15-turbo"
if config_path not in avail:
    print("[dl] downloading turbo DiT...", flush=True)
    ok, msg = ensure_dit_model(config_path, ckpt)
    print(f"[dl] turbo: {ok} {msg}", flush=True)
    avail = dit.get_available_acestep_v15_models()
if config_path not in avail:
    config_path = avail[0]
print(f"[dit] using: {config_path}", flush=True)

print("[dit] initialize_service (loads DiT onto GPU)...", flush=True)
dit.initialize_service(
    project_root=project_root, config_path=config_path, device=device,
    use_flash_attention=False, compile_model=False,
    offload_to_cpu=False, offload_dit_to_cpu=False, use_mlx_dit=False,
)

llm = LLMHandler()
lm_avail = llm.get_available_5hz_lm_models()
if not lm_avail:
    print("[dl] downloading 5Hz LM...", flush=True)
    ok, msg = ensure_lm_model(checkpoints_dir=ckpt)
    print(f"[dl] lm: {ok} {msg}", flush=True)
    lm_avail = llm.get_available_5hz_lm_models()
lm_model = lm_avail[0]
print(f"[lm] using: {lm_model}  (backend=pt)", flush=True)
# dtype=None means "let initialize() choose", which is bfloat16 on any CUDA/HIP device
# (llm_inference.py ~571). Passing float32 here is what the lm-dtype patch is about.
llm.initialize(checkpoint_dir=ckpt, lm_model_path=lm_model, backend="pt",
               device=device, offload_to_cpu=False, dtype=None)

params = GenerationParams(
    task_type="text2music",
    caption="upbeat indie pop, bright acoustic guitar, warm female vocal, catchy, mid-tempo, feel-good",
    lyrics="[verse]\nMorning light on the kitchen floor\nCoffee steam and an open door\n"
           "[chorus]\nWe are alive, we are alive tonight\nEverything is gonna be alright",
    vocal_language="en",
    duration=30.0,
    inference_steps=8,
    seed=42,
    thinking=True,
)
config = GenerationConfig(batch_size=1, audio_format="flac", use_random_seed=False, seeds=[42])

# ⚠️ NOT `<project_root>/gradio_outputs/`. That is inside upstream's git tree, where the
# output lands untracked-and-unignored and rides along on someone's next `git add -A`.
save_dir = os.path.join(tempfile.gettempdir(), "acestep-smoke")
os.makedirs(save_dir, exist_ok=True)
print(f"[gen] starting render -> {save_dir}", flush=True)
t0 = time.time()
result = generate_music(dit, llm, params, config, save_dir=save_dir)
dt = time.time() - t0
print(f"=== RENDER DONE in {dt:.1f}s ===", flush=True)
print(f"[result] {result}", flush=True)
