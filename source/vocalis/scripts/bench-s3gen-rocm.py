"""Benchmark S3Gen independently and record each vocoder call.

The measurements separate several possible causes of latency:

  MIOpen tuning inside the timed region  -> find-db file size/mtime sampled per phase
  contention from ComfyUI/ACE/Applio     -> gpu_busy_percent + VRAM sampled per call
  first-call-per-shape warm-up           -> every repeat printed, not just the median
  a genuine batch>1 fallback solver      -> B=1 vs B=2,4,8 with all shapes pre-warmed

Speech tokens are RANDOM but valid and of realistic length. S3Gen's cost is shape-driven
(HiFiGAN is convolutional, the CFM decoder runs a fixed step count), so token *values*
cannot move the timing -- and this way the bench touches no voice data at all.

    python bench_s3gen_rocm.py [--device cuda:0] [--repeats 5] [--cold]
"""
import argparse
import json
import os
import statistics
import sys
import time

import torch

# Realistic speech-token lengths, from the PoC's four reference chunks.
TOKEN_LENS = [260, 245, 246, 181, 260, 245, 246, 181]
VALID_TOKEN_MAX = 6561


def find_db_paths():
    root = os.environ.get("MIOPEN_USER_DB_PATH") or os.path.expanduser("~/.config/miopen")
    if not os.path.isdir(root):
        return []
    return sorted(os.path.join(root, f) for f in os.listdir(root)
                  if f.endswith(".ufdb.txt") or f.endswith(".udb.txt"))


def find_db_state():
    out = {}
    for p in find_db_paths():
        try:
            st = os.stat(p)
            out[os.path.basename(p)] = (st.st_size, round(st.st_mtime, 1))
        except OSError:
            pass
    return out


def db_delta(before, after):
    """Bytes added to the MIOpen find/perf DBs. >0 means MIOpen tuned during the phase."""
    grew = 0
    for k, (size, _) in after.items():
        grew += size - before.get(k, (0, 0))[0]
    return grew


def card_stat(device):
    """(busy%, vram_used_GB) straight from sysfs -- the WHOLE card, other processes included."""
    idx = int(device.split(":")[1]) if ":" in device else 0
    # torch device N is not necessarily /sys card N; probe for the amdgpu cards in order.
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
    rows = []
    for i in range(n):
        L = TOKEN_LENS[i % len(TOKEN_LENS)]
        rows.append(torch.randint(0, VALID_TOKEN_MAX, (L,), generator=g,
                                  dtype=torch.long).to(device))
    return rows


def pad(rows, device):
    lens = [r.numel() for r in rows]
    lmax = max(lens)
    padded = torch.zeros((len(rows), lmax), dtype=torch.long, device=device)
    for i, r in enumerate(rows):
        padded[i, :r.numel()] = r
    return padded, torch.LongTensor(lens).to(device)


def timed_vocode(model, rows, device):
    """One S3Gen pass over len(rows) sequences. Returns (seconds, busy_before, busy_after)."""
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


def phase(name, fn, results):
    """Run fn, bracket it with a MIOpen DB snapshot, record how much the DB grew."""
    before = find_db_state()
    t0 = time.perf_counter()
    payload = fn()
    wall = time.perf_counter() - t0
    after = find_db_state()
    grew = db_delta(before, after)
    print(f"\n  [miopen] {name}: find-db grew {grew:+,} bytes over {wall:.1f} s wall")
    results.setdefault("miopen_db_growth", {})[name] = grew
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--sizes", type=int, nargs="+", default=[1, 2, 4, 8])
    ap.add_argument("--cold", action="store_true",
                    help="point MIOPEN_USER_DB_PATH at an empty dir first (set before torch init)")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    device = args.device
    results = {"device": device, "cold": args.cold, "repeats": args.repeats,
               "torch": torch.__version__, "hip": torch.version.hip}

    print(f"torch {torch.__version__}  hip {torch.version.hip}")
    print(f"MIOPEN_USER_DB_PATH={os.environ.get('MIOPEN_USER_DB_PATH', '(default)')}")
    print(f"MIOPEN_FIND_MODE={os.environ.get('MIOPEN_FIND_MODE', '(default)')}")
    for p in find_db_paths():
        print(f"  find-db {os.path.basename(p)}: {os.path.getsize(p):,} bytes")
    busy, vram = card_stat(device)
    print(f"card at start: busy {busy}%  vram used {vram:.2f} GB\n")
    results["card_at_start"] = {"busy": busy, "vram_used_gb": round(vram, 2)}

    from chatterbox.tts import ChatterboxTTS
    t0 = time.perf_counter()
    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"model loaded in {time.perf_counter() - t0:.1f} s")
    if getattr(model, "conds", None) is None:
        print("!! model.conds is None -- no built-in voice; cannot run without a reference.")
        return 2

    rows_all = make_tokens(max(args.sizes), device)

    # ── Phase 1: warm up every shape we are about to time ─────────────────────
    # ROCm compiles and tunes per tensor shape. Unwarmed, that lands inside the
    # timed region and the number is a compiler benchmark, not a vocoder one.
    def warm():
        for n in args.sizes:
            dt, _, _ = timed_vocode(model, rows_all[:n], device)
            print(f"    warm B={n:<2} {dt:7.3f} s")
    phase("warmup", warm, results)

    # ── Phase 2: batched, every repeat recorded ───────────────────────────────
    def batched():
        table = {}
        for n in args.sizes:
            samples = []
            for r in range(args.repeats):
                dt, b0, b1 = timed_vocode(model, rows_all[:n], device)
                samples.append(dt)
                print(f"    B={n:<2} rep{r} {dt:7.3f} s  ({dt / n:6.3f} s/chunk)"
                      f"  busy {b0:3d}%->{b1:3d}%")
            table[n] = samples
            lo, hi = min(samples), max(samples)
            print(f"    B={n:<2} median {statistics.median(samples):7.3f} s"
                  f"  min {lo:7.3f}  max {hi:7.3f}  spread {hi / lo:.2f}x"
                  f"  | per-chunk median {statistics.median(samples) / n:6.3f} s")
        return table
    results["batched"] = phase("batched", batched, results)

    # ── Phase 3: the serial arm -- the measurement that gave 1.78 vs 7.9 ──────
    def serial():
        samples = []
        for r in range(args.repeats):
            per = []
            for i in range(max(args.sizes)):
                dt, b0, b1 = timed_vocode(model, [rows_all[i]], device)
                per.append(dt)
            samples.append(per)
            print(f"    serial round{r}: total {sum(per):7.3f} s  "
                  f"per-chunk {sum(per) / len(per):6.3f} s  "
                  f"min {min(per):.3f} max {max(per):.3f}")
        flat = [x for rnd in samples for x in rnd]
        print(f"    serial ALL {len(flat)} calls: median {statistics.median(flat):.3f} s  "
              f"min {min(flat):.3f}  max {max(flat):.3f}  spread {max(flat) / min(flat):.2f}x")
        return samples
    results["serial"] = phase("serial", serial, results)

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 74)
    print(f"{'B':>3} {'median s':>10} {'s/chunk':>10} {'min':>8} {'max':>8} {'spread':>8}")
    for n in args.sizes:
        s = results["batched"][n]
        med = statistics.median(s)
        print(f"{n:>3} {med:>10.3f} {med / n:>10.3f} {min(s):>8.3f} {max(s):>8.3f} "
              f"{max(s) / min(s):>7.2f}x")
    flat = [x for rnd in results["serial"] for x in rnd]
    print(f"{'ser':>3} {statistics.median(flat):>10.3f} {statistics.median(flat):>10.3f} "
          f"{min(flat):>8.3f} {max(flat):>8.3f} {max(flat) / min(flat):>7.2f}x")
    print("=" * 74)
    print("miopen find-db growth per phase:", results["miopen_db_growth"])
    busy, vram = card_stat(device)
    print(f"card at end: busy {busy}%  vram used {vram:.2f} GB")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2, default=str)
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
