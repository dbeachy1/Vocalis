#!/usr/bin/env python3
"""Run the pinned VoxCPM model in an isolated process and serve line-delimited requests.

The parent owns process lifetime and physical-device assignment. This worker selects that
device before loading the model; the pinned model uses unindexed ``cuda`` allocations.
Stdout is reserved for ``VOXCPM_READY`` and ``VOXCPM_RES`` JSON records, while diagnostics
remain on stderr. Request text is final and is not recomposed here.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

# The shared policy module lives beside source in the satellite directory in both the
# source checkout and the packaged code tree.
SATELLITE_DIR = Path(__file__).resolve().parents[2] / "satellite"
sys.path.insert(0, str(SATELLITE_DIR))
from vocalis_torch_backend import apply_rocm_miopen_policy  # noqa: E402


MODEL_REVISION = "32279effe8c19989596f05d353d1447f51d9e915"
MODEL_FILES = (
    "audiovae.pth", "config.json", "model.safetensors", "README.md",
    "special_tokens_map.json", "tokenization_voxcpm2.py", "tokenizer_config.json",
    "tokenizer.json",
)

# Defensive: the tqdm race is a threads-in-one-process bug we don't have here, but its
# bars are pure noise in journald either way.
os.environ.setdefault("TQDM_DISABLE", "1")


def _emit(prefix: str, payload: dict) -> None:
    sys.stdout.write(f"{prefix} {json.dumps(payload)}\n")
    sys.stdout.flush()


def _load_model(model_dir: Path, optimize: bool, device: str):
    """Load the pinned model after selecting this child's assigned device.

    The parent keeps physical `cuda:N` IDs for worker ownership. Selecting the current device
    makes VoxCPM's unindexed `cuda` allocations use that card. CPU is explicit debug mode only.
    """
    if device == "cpu":
        # Hide accelerators only for the explicit debug path. GPU workers retain the inherited
        # ROCm visibility domains and select their assigned physical index below.
        for name in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"):
            os.environ[name] = ""
    else:
        match = re.fullmatch(r"cuda:(0|[1-9][0-9]*)", device)
        if match is None:
            raise ValueError("device must be cuda:N or cpu")
        import torch  # select the physical device before VoxCPM imports Torch

        apply_rocm_miopen_policy(torch)

        if not torch.cuda.is_available():
            raise RuntimeError(f"requested VoxCPM device {device}, but CUDA/HIP is unavailable")
        torch.cuda.set_device(int(match.group(1)))

    from voxcpm import VoxCPM  # device selection must precede model import

    return VoxCPM.from_pretrained(str(model_dir), load_denoiser=False,
                                  optimize=optimize)


def _generate_request(model, req: dict, torch_module):
    """Apply this request's seed to Torch before calling the pinned generate API.

    VoxCPM revision 32279eff has no `seed` argument. Its diffusion sampler uses Torch's global
    random generator, so seeding immediately before each serial generation gives each request
    its requested randomness without passing an unsupported keyword or leaking the previous
    request's RNG state.
    """
    torch_module.manual_seed(int(req["seed"]))
    return model.generate(
        text=str(req["text"]),
        cfg_value=float(req.get("cfg_value", 2.0)),
        inference_timesteps=int(req.get("steps", 30)),
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", required=True, help="physical cuda:N (or cpu — debug only)")
    ap.add_argument("--model", required=True,
                    help="local snapshot directory for the pinned VoxCPM2 revision")
    ap.add_argument("--optimize", action="store_true",
                    help="enable torch.compile — OFF by default: it recompiles per output "
                         "length (~55 s) and VoxCPM2 picks its own length per clip, so an "
                         "occasional creator pays the tax on every single generation")
    args = ap.parse_args()

    model_dir = Path(args.model)
    missing = [name for name in MODEL_FILES if not (model_dir / name).is_file()]
    if model_dir.name != MODEL_REVISION or missing:
        print("VoxCPM2 requires the complete local snapshot "
              f"{MODEL_REVISION}; missing or mismatched files: "
              f"{', '.join(missing) if missing else 'revision directory name'}",
              file=sys.stderr)
        return 2

    # Keep direct worker invocation offline too; the parent applies the same settings.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

    import numpy as np      # heavy imports after arg parsing fails fast
    import soundfile as sf
    # load_denoiser=False: its denoiser is INPUT-only (cloning references), useless for
    # design output — Vocalis's own DFN3 chain cleans the frozen clip (§5.1).
    model = _load_model(model_dir, args.optimize, args.device)
    import torch  # the per-request seed controls the pinned sampler's RNG
    _emit("VOXCPM_READY", {"sample_rate": int(model.tts_model.sample_rate),
                           "device": args.device})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except ValueError:
            _emit("VOXCPM_RES", {"id": None, "ok": False, "error": "unparseable request"})
            continue
        rid = req.get("id")
        try:
            t0 = time.time()
            wav = _generate_request(model, req, torch)
            wav = np.asarray(wav, dtype=np.float32).reshape(-1)
            sr = int(model.tts_model.sample_rate)
            out = str(req["out"])
            sf.write(out, wav, sr)
            _emit("VOXCPM_RES", {"id": rid, "ok": True, "out": out,
                                 "duration_s": round(len(wav) / sr, 2),
                                 "compute_s": round(time.time() - t0, 2)})
        except Exception as exc:  # noqa: BLE001 — one bad request must not kill the worker
            _emit("VOXCPM_RES", {"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
