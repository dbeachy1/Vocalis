"""Does fp16/bf16 autocast fix the R9700 vocoder?

Research says the only tuned gfx12 conv kernels (Winograd Fury) are fp16-only and
the fp32 GEMM path is a known hipBLASLt gap on gfx120x. This measures S3Gen B=1
warm timings under fp32 (control), fp16 autocast, and bf16 autocast in one process,
plus output sample-count and RMS so a numerically-broken result cannot pass as fast.

    MIOPEN_USER_DB_PATH=$PWD/db-fp16 python bench-s3gen-autocast.py --device cuda:0
"""
import argparse
import contextlib
import statistics
import time

import torch

TOKEN_LEN = 260
VALID_TOKEN_MAX = 6561
WARM_CALLS = 4
TIMED_CALLS = 5


def make_row(device):
    g = torch.Generator(device="cpu").manual_seed(1234)
    return torch.randint(0, VALID_TOKEN_MAX, (TOKEN_LEN,), generator=g,
                         dtype=torch.long).to(device)


def vocode(model, row, device, ctx):
    padded = row.unsqueeze(0)
    lens_t = torch.LongTensor([row.numel()]).to(device)
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    with torch.inference_mode(), ctx:
        wav, _ = model.s3gen.inference(speech_tokens=padded, ref_dict=model.conds.gen,
                                       speech_token_lens=lens_t)
    torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    w = wav.float()
    return dt, w.numel(), w.pow(2).mean().sqrt().item(), bool(torch.isnan(w).any())


def run_arm(name, model, row, device, ctx):
    print(f"\n--- arm {name} ---", flush=True)
    for i in range(WARM_CALLS):
        dt, n, rms, nan = vocode(model, row, device, ctx)
        print(f"  warm  {i}: {dt:7.3f} s  samples={n}  rms={rms:.5f}  nan={nan}",
              flush=True)
    samples = []
    for i in range(TIMED_CALLS):
        dt, n, rms, nan = vocode(model, row, device, ctx)
        samples.append(dt)
        print(f"  timed {i}: {dt:7.3f} s  samples={n}  rms={rms:.5f}  nan={nan}",
              flush=True)
    med = statistics.median(samples)
    print(f"  ARM {name}: median {med:.3f} s  min {min(samples):.3f}  "
          f"max {max(samples):.3f}", flush=True)
    return med


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cuda:0")
    args = ap.parse_args()
    device = args.device

    print(f"torch {torch.__version__}  hip {torch.version.hip}")
    from chatterbox.tts import ChatterboxTTS
    t0 = time.perf_counter()
    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"model loaded in {time.perf_counter() - t0:.1f} s", flush=True)
    if getattr(model, "conds", None) is None:
        print("!! model.conds is None -- cannot run")
        return 2
    row = make_row(device)

    meds = {}
    meds["fp32"] = run_arm("fp32", model, row, device, contextlib.nullcontext())
    for dtype in (torch.float16, torch.bfloat16):
        name = str(dtype).split(".")[-1]
        try:
            ctx = torch.autocast(device_type="cuda", dtype=dtype)
            meds[name] = run_arm(name, model, row, device, ctx)
        except Exception as e:
            print(f"  ARM {name} FAILED: {type(e).__name__}: {e}", flush=True)

    print("\n=== summary (median s per B=1 call) ===")
    for k, v in meds.items():
        print(f"  {k:6} {v:7.3f} s   {meds['fp32'] / v:5.2f}x vs fp32")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
