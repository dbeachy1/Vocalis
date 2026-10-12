#!/usr/bin/env python3
"""Run one RVC voice conversion through the version-sensitive `rvc-python` API.

The caller supplies staged input/output paths and owns storage. Call `vc_single` directly: the
`infer_file` wrapper can hide conversion exceptions and report a later write error instead. Under
ROCm, PyTorch exposes AMD devices through the CUDA device interface; select a card with `--device`
or `HIP_VISIBLE_DEVICES`.
"""
import argparse
import sys
import time
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="RVC voice conversion (one file).")
    ap.add_argument("-i", "--input", required=True, help="Input vocal stem (wav).")
    ap.add_argument("-o", "--output", required=True, help="Output swapped vocal (wav).")
    ap.add_argument("-m", "--model", required=True, help="RVC target-voice model (.pth).")
    ap.add_argument("--index", default="", help="Optional RVC feature .index file.")
    ap.add_argument("--pitch", type=int, default=0,
                    help="f0 transpose in semitones. +12 male->female-ish, -12 the reverse.")
    ap.add_argument("--index-rate", type=float, default=0.5,
                    help="0..1 timbre adherence to the target model (higher = more target).")
    ap.add_argument("--f0-method", default="rmvpe",
                    help="Pitch extractor (default rmvpe -- the PoC-proven choice; "
                         "rvc-python's own default is the slower harvest).")
    ap.add_argument("--rms-mix-rate", type=float, default=None,
                    help="0..1 volume envelope. 0 = rescale the output to follow the "
                         "ORIGINAL vocal's loudness envelope (it sits in the mix where "
                         "the original sat); 1 = keep RVC's own level, which is hotter "
                         "and flatter. rvc-python defaults to 1, i.e. no matching at "
                         "all -- which is why swapped vocals come out too loud.")
    ap.add_argument("--device", default="cuda:0",
                    help="Torch device. Under ROCm the R9700s are cuda:0 / cuda:1.")
    a = ap.parse_args()

    try:
        from rvc_python.infer import RVCInference
    except Exception as e:  # pragma: no cover - install-time guidance
        print(f"ERROR: could not import rvc_python ({e}).\n"
              f"Run scripts/voiceswap/setup.sh first, and see the README's "
              f"'Troubleshooting the RVC install' section.", file=sys.stderr)
        return 2

    # torch >= 2.6 defaults torch.load(weights_only=True), which refuses the
    # fairseq pickles inside hubert_base.pt (GLOBAL fairseq.data.dictionary.
    # Dictionary) — load_hubert dies and no conversion is possible. Restore the
    # old default HERE ONLY: this is a dedicated child process, and everything
    # it loads (hubert_base.pt / rmvpe.pt fetched by rvc-python, plus the
    # user's own voice .pth) is a local trusted model file.
    import torch
    _torch_load = torch.load

    def _load(*args, **kw):
        kw.setdefault("weights_only", False)
        return _torch_load(*args, **kw)
    torch.load = _load

    # Time the model load SEPARATELY from the conversion (enhance_audio.py's pattern):
    # the parent (voiceswap.run_swap_job) needs the two terms apart, because `startup`
    # -- spawn + imports + this model load -- is paid once per INVOCATION and does NOT
    # scale with the audio, while the conversion does. A single blended wall-clock number
    # cannot be split back out, and swap_rate would then need runs of differing lengths to
    # fit both parameters (see swap_rate.py's docstring, cribbed from enhance_rate.py).
    t_load = time.perf_counter()
    rvc = RVCInference(device=a.device)
    # index_path: the installed load_model defaults it to "" (not None) for the
    # no-index case -- match that exactly.
    rvc.load_model(a.model, index_path=(a.index or ""))
    load_s = time.perf_counter() - t_load

    # Mirror infer_file's call, minus its broken write. Unset knobs keep the
    # library's own defaults (filter_radius, resample_sr, protect).
    #
    # rms_mix_rate is the exception, and it matters: rvc-python defaults it to 1, and
    # RVC SKIPS envelope matching entirely at 1 (`if rms_mix_rate != 1: change_rms(...)`),
    # so the swapped vocal keeps whatever level the model produced -- hotter and flatter
    # than the stem it replaced, which is exactly why swapped vocals sit too loud. At 0
    # the output is rescaled to follow the ORIGINAL vocal's loudness envelope. RVC's own
    # WebUI ships 0.25 for this reason.
    file_index = (rvc.models.get(rvc.current_model) or {}).get("index") or ""
    vc_kwargs = dict(
        sid=0,
        f0_up_key=a.pitch,
        f0_file="",
        f0_method=a.f0_method,
        file_index=file_index,
        file_index2="",
        index_rate=a.index_rate,
        filter_radius=rvc.filter_radius,
        resample_sr=rvc.resample_sr,
        rms_mix_rate=(rvc.rms_mix_rate if a.rms_mix_rate is None else a.rms_mix_rate),
        protect=rvc.protect,
    )

    # Warm up MIOpen and the RVMPE model before timing the conversion. First-use setup is a
    # per-process cost; account for it as startup time rather than attributing it to audio length.
    # Kernels remain cached for the conversion. Warmup is best-effort; failure only affects timing.
    try:
        from scipy.io import wavfile as _wf
        _sr, _data = _wf.read(a.input)
        if len(_data):
            _wp = a.output + ".warmup.wav"
            _wf.write(_wp, _sr, _data[: max(1, int(_sr * 1.5))])
            t_warm = time.perf_counter()
            rvc.vc.vc_single(input_audio_path=_wp, **vc_kwargs)
            load_s += time.perf_counter() - t_warm
            Path(_wp).unlink()
    except Exception as e:                       # pragma: no cover - box/version dependent
        print(f"(swap warmup skipped, timing may be off: {e})", file=sys.stderr)

    t_compute = time.perf_counter()
    result = rvc.vc.vc_single(input_audio_path=a.input, **vc_kwargs)
    compute_s = time.perf_counter() - t_compute
    if result is None or isinstance(result, tuple):
        # vc_single's bare-except error path: (traceback_string, (None, None)).
        detail = result[0] if isinstance(result, tuple) and result else "no audio returned"
        print(f"ERROR: RVC conversion failed:\n{detail}", file=sys.stderr)
        return 1

    from scipy.io import wavfile
    wavfile.write(a.output, rvc.vc.tgt_sr, result)
    if not Path(a.output).stat().st_size:
        print(f"ERROR: RVC wrote an empty file: {a.output}", file=sys.stderr)
        return 1

    # The machine-readable half of the run: model load vs the actual conversion, and how
    # much audio came out. The parent parses this (swap_rate.py), never shows it, and
    # derives `startup = process_wall - compute_s`. EVERY FIELD IS NUMERIC on purpose --
    # swap_rate.parse_timing floats every token and drops the whole line on a non-number,
    # so f0/device/voice do NOT belong on it. audio_s is the OUTPUT length at the model's
    # own sample rate, which is the input length RVC actually processed.
    audio_s = (len(result) / float(rvc.vc.tgt_sr)) if getattr(rvc.vc, "tgt_sr", 0) else 0.0
    print(f"VOCALIS_TIMING audio_s={audio_s:.3f} load_s={load_s:.3f} "
          f"compute_s={compute_s:.3f}")
    print(f"RVC: wrote {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
