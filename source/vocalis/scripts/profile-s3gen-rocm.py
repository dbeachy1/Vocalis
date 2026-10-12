"""Profile ONE warm S3Gen B=1 call and say where the 1.75 s goes.

Kernel-level answer to DESIGN_6_2_BATCHING.md §6.2's open question. Mirrors the
timed call in scripts/bench-s3gen-rocm.py exactly (random tokens, same length,
same inference call), warms the shape first, then profiles 3 calls with
torch.profiler (CPU + device activities).

Run from /ai-output/temp/s3gen-bench with its own MIOPEN_USER_DB_PATH copy:
    MIOPEN_USER_DB_PATH=$PWD/db-prof python profile-s3gen.py --device cuda:0
"""
import argparse
import os
import time

import torch
from torch.profiler import ProfilerActivity, profile

TOKEN_LEN = 260          # first PoC reference chunk, same as bench harness
VALID_TOKEN_MAX = 6561
WARM_CALLS = 4
PROFILED_CALLS = 3


def make_row(device):
    g = torch.Generator(device="cpu").manual_seed(1234)
    return torch.randint(0, VALID_TOKEN_MAX, (TOKEN_LEN,), generator=g,
                         dtype=torch.long).to(device)


def vocode(model, row, device):
    padded = row.unsqueeze(0)
    lens_t = torch.LongTensor([row.numel()]).to(device)
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    with torch.inference_mode():
        model.s3gen.inference(speech_tokens=padded, ref_dict=model.conds.gen,
                              speech_token_lens=lens_t)
    torch.cuda.synchronize()
    return time.perf_counter() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--trace", default="profile-s3gen-trace.json")
    args = ap.parse_args()
    device = args.device

    print(f"torch {torch.__version__}  hip {torch.version.hip}")
    print(f"MIOPEN_USER_DB_PATH={os.environ.get('MIOPEN_USER_DB_PATH', '(default)')}")

    from chatterbox.tts import ChatterboxTTS
    t0 = time.perf_counter()
    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"model loaded in {time.perf_counter() - t0:.1f} s")
    if getattr(model, "conds", None) is None:
        print("!! model.conds is None -- cannot run")
        return 2

    row = make_row(device)

    for i in range(WARM_CALLS):
        print(f"  warm call {i}: {vocode(model, row, device):7.3f} s", flush=True)

    with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
                 record_shapes=True) as prof:
        for i in range(PROFILED_CALLS):
            print(f"  profiled call {i}: {vocode(model, row, device):7.3f} s",
                  flush=True)

    print("\n=== by op, self device time ===")
    print(prof.key_averages().table(sort_by="self_device_time_total", row_limit=45))
    print("\n=== by op + input shape, self device time ===")
    print(prof.key_averages(group_by_input_shape=True)
          .table(sort_by="self_device_time_total", row_limit=45))
    prof.export_chrome_trace(args.trace)
    print(f"wrote {args.trace}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
