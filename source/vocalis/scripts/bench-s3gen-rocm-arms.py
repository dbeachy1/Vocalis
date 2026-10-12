"""Can the R9700's S3Gen collapse be fixed by giving MIOpen a workspace?

The baseline run proves every S3Gen convolution takes this path:

    [GetSolutionsFallback WTI] Solver <GemmFwdRest>, workspace required: N, provided ptr: 0 size: 0

`GetSolutionsFallback` is MIOpen's IMMEDIATE mode -- which is what PyTorch uses when
`torch.backends.cudnn.benchmark` is False (the default). Immediate mode passes workspace=0,
GemmFwdRest needs 12-176 MB, so it is rejected and the conv drops to a naive direct kernel
with no batch amortization at all. Hence 9.96/17.81/33.92 s at B=1/2/4 -- dead linear.

`benchmark=True` switches PyTorch to the Find API, which allocates a real workspace and lets
MIOpen keep the solver it actually wanted. This measures whether that is the whole story.

Each arm gets its OWN COPY of the MIOpen user find-db, so arms cannot warm each other and
none of them can corrupt the live install's database.

    python bench_s3gen_fix.py --arm baseline|benchmark|findnormal --device cuda:1
"""
import argparse
import json
import os
import statistics
import sys
import time

import torch

TOKEN_LENS = [260, 245, 246, 181, 260, 245, 246, 181]
VALID_TOKEN_MAX = 6561


def card_stat(device):
    idx = int(device.split(":")[1]) if ":" in device else 0
    cards = sorted(d for d in os.listdir("/sys/class/drm")
                   if d.startswith("card") and d[4:].isdigit()
                   and os.path.exists(f"/sys/class/drm/{d}/device/gpu_busy_percent"))
    if idx >= len(cards):
        return (-1, -1.0)
    base = f"/sys/class/drm/{cards[idx]}/device"
    try:
        with open(f"{base}/gpu_busy_percent") as f:
            busy = int(f.read().strip())
        with open(f"{base}/mem_info_vram_used") as f:
            vram = int(f.read().strip()) / 1024 ** 3
        return (busy, vram)
    except (OSError, ValueError):
        return (-1, -1.0)


def make_tokens(n, device, seed=1234):
    g = torch.Generator(device="cpu").manual_seed(seed)
    return [torch.randint(0, VALID_TOKEN_MAX, (TOKEN_LENS[i % len(TOKEN_LENS)],),
                          generator=g, dtype=torch.long).to(device) for i in range(n)]


def pad(rows, device):
    lens = [r.numel() for r in rows]
    padded = torch.zeros((len(rows), max(lens)), dtype=torch.long, device=device)
    for i, r in enumerate(rows):
        padded[i, :r.numel()] = r
    return padded, torch.LongTensor(lens).to(device)


def timed_vocode(model, rows, device):
    padded, lens_t = pad(rows, device)
    b0, _ = card_stat(device)
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    with torch.inference_mode():
        model.s3gen.inference(speech_tokens=padded, ref_dict=model.conds.gen,
                              speech_token_lens=lens_t)
    torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    b1, _ = card_stat(device)
    return dt, b0, b1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True,
                    choices=["baseline", "benchmark", "findnormal"])
    ap.add_argument("--device", default="cuda:1")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--sizes", type=int, nargs="+", default=[1, 2, 4, 8])
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    device = args.device

    # `benchmark=True` is the actual variable under test: it moves PyTorch off MIOpen's
    # immediate mode (workspace=0) and onto the Find API, which allocates one.
    if args.arm in ("benchmark", "findnormal"):
        torch.backends.cudnn.benchmark = True

    print(f"arm={args.arm}  device={device}")
    print(f"torch {torch.__version__}  hip {torch.version.hip}")
    print(f"cudnn.benchmark = {torch.backends.cudnn.benchmark}")
    print(f"MIOPEN_USER_DB_PATH = {os.environ.get('MIOPEN_USER_DB_PATH', '(default)')}")
    print(f"MIOPEN_FIND_MODE    = {os.environ.get('MIOPEN_FIND_MODE', '(default)')}")
    busy, vram = card_stat(device)
    print(f"card at start: busy {busy}%  vram {vram:.2f} GB\n", flush=True)

    from chatterbox.tts import ChatterboxTTS
    t0 = time.perf_counter()
    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"model loaded in {time.perf_counter() - t0:.1f} s", flush=True)
    if getattr(model, "conds", None) is None:
        print("!! no built-in conditionals")
        return 2

    rows_all = make_tokens(max(args.sizes), device)
    results = {"arm": args.arm, "device": device,
               "benchmark": bool(torch.backends.cudnn.benchmark),
               "find_mode": os.environ.get("MIOPEN_FIND_MODE", "(default)"),
               "warm": {}, "timed": {}}

    print("\n--- warm-up (per shape; ROCm compiles and tunes inside this) ---", flush=True)
    for n in args.sizes:
        dt, _, _ = timed_vocode(model, rows_all[:n], device)
        results["warm"][n] = dt
        print(f"  warm B={n:<2} {dt:8.3f} s", flush=True)

    print("\n--- timed ---", flush=True)
    for n in args.sizes:
        samples = []
        for r in range(args.repeats):
            dt, b0, b1 = timed_vocode(model, rows_all[:n], device)
            samples.append(dt)
            print(f"  B={n:<2} rep{r} {dt:8.3f} s ({dt / n:6.3f} s/chunk) busy {b0:3d}->{b1:3d}%",
                  flush=True)
        results["timed"][n] = samples

    print("\n" + "=" * 66)
    print(f"ARM {args.arm}")
    print(f"{'B':>3} {'median s':>10} {'s/chunk':>10} {'min':>8} {'max':>8}")
    for n in args.sizes:
        s = results["timed"][n]
        med = statistics.median(s)
        print(f"{n:>3} {med:>10.3f} {med / n:>10.3f} {min(s):>8.3f} {max(s):>8.3f}")
    base = statistics.median(results["timed"][args.sizes[0]])
    big = statistics.median(results["timed"][args.sizes[-1]])
    print(f"batch amortization B={args.sizes[0]}->{args.sizes[-1]}: "
          f"{(base * args.sizes[-1]) / big:.2f}x "
          f"(1.0x = none, {args.sizes[-1]}.0x = perfect)")
    print("=" * 66)

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
