#!/usr/bin/env python3
"""Isolated child process for karaoke detection and de-reverb separation.

The child owns model loading and separation only; the caller manages jobs, storage, and audio
processing. It uses a dedicated environment so separator dependencies do not enter the TTS
runtime. Both stages share one process and model cache, and either stage can be omitted.

Karaoke separation is used only to detect multi-voice regions; de-reverb output is retained as
training material. Select outputs by each model's `primary_stem_name`, not by filenames, because
stem naming varies by model and secondary stems can have misleading names.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

SATELLITE_DIR = Path(__file__).resolve().parents[2] / "satellite"
sys.path.insert(0, str(SATELLITE_DIR))

# Force stable UTF-8 output so console code pages cannot turn successful work into a failed
# process exit. Replacement keeps diagnostics from raising on unencodable characters.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):        # not a TextIOWrapper, or already detached
        pass

#: `custom_output_names` maps a stem name to the basename we want it written under. Anything
#: unambiguous will do; this one cannot collide with a model's own naming.
_FORCED = "leadvocal_primary"


def _pin_onnx_provider(sep, device: str) -> None:
    """Choose the ONNX execution provider ourselves, because `audio-separator` cannot choose ROCm.

    `audio-separator` selects CUDA by provider name and does not select ROCm automatically.
    Set its provider attribute before model loading so the requested device controls both the
    PyTorch and ONNX stages.
    """
    import onnxruntime

    have = list(onnxruntime.get_available_providers())
    if not str(device).startswith("cuda"):
        sep.onnx_execution_provider = ["CPUExecutionProvider"]
        return
    if "CUDAExecutionProvider" in have:
        sep.onnx_execution_provider = ["CUDAExecutionProvider"]
        return
    # ROCm remains opt-in because its measured performance was slower than CPU for the tested
    # model. Keep the option available for reevaluation with newer runtimes.
    if "ROCMExecutionProvider" in have and os.environ.get("LEADVOCAL_ONNX_ROCM") == "1":
        sep.onnx_execution_provider = ["ROCMExecutionProvider"]
        return
    if "ROCMExecutionProvider" in have:
        sep.onnx_execution_provider = ["CPUExecutionProvider"]
        return
    # Nothing we know about. Leave the library's own choice alone rather than forcing the CPU —
    # it may know a provider this function does not.


def _refuse_downloads(sep, model_dir: Path) -> None:
    """Make this `Separator` unable to download anything; a file that is absent is an error.

    `audio-separator` fetches every model, catalog and parameter file it cannot find in its
    model directory (github.com) and has no switch to turn that off. This edition must never
    fetch a model at run time (setup downloads them; October 11, 2026),
    so the caller checks the files exist before starting this child (`leadvocal.require_models`)
    and this is the backstop for any file that check did not foresee, or that vanished since:
    the library's own existence test is kept, and only its download arm is removed.
    """
    def refuse(url, output_path):
        if os.path.isfile(output_path):
            return
        raise RuntimeError(
            f"{Path(output_path).name} is not installed in {model_dir}; this edition does not "
            f"download models. Nothing was downloaded.")
    sep.download_file_if_not_exists = refuse


#: (model filename, device) -> a loaded Separator. Empty and unused in one-shot mode; the whole
#: point of `--serve`. 8.6.2.
_LOADED = {}


def _get_sep(model: str, work: Path, model_dir: Path, device: str):
    """A loaded `Separator` for `model`, built once per worker and reused.

    Reuse a loaded separator within a worker to amortize process, device-context, and model-load
    costs across jobs. This is process reuse, not model batching. Keep `output_dir` fixed for the
    worker lifetime because the model captures it at load time; move each result afterward.
    """
    from audio_separator.separator import Separator

    key = (model, str(device))
    sep = _LOADED.get(key)
    if sep is not None:
        return sep
    work.mkdir(parents=True, exist_ok=True)
    sep = Separator(output_dir=str(work), output_format="WAV", model_file_dir=str(model_dir))
    _refuse_downloads(sep, model_dir)
    _pin_onnx_provider(sep, device)
    sep.load_model(model_filename=model)
    dev = getattr(sep, "torch_device", None)
    eps = getattr(sep, "onnx_execution_provider", None)
    print(f"[leadvocal] {model}: torch on {dev}, onnx providers {eps}", flush=True)
    primary = getattr(getattr(sep, "model_instance", None), "primary_stem_name", None)
    if not primary:
        raise RuntimeError(f"{model}: could not read primary_stem_name from the loaded model")
    print(f"[leadvocal] {model}: primary stem is {primary!r}", flush=True)
    _LOADED[key] = sep
    return sep


def _separate_primary(model: str, src: Path, out_path: Path, work: Path, model_dir: Path,
                      device: str = "cpu") -> Path:
    """Run `model` over `src` and land its PRIMARY stem at `out_path`. Returns `out_path`.

    Raises RuntimeError with a legible message for the job log."""
    sep = _get_sep(model, work, model_dir, device)

    # Report the device and provider selected by the loaded model; PyTorch and ONNX may use
    # different providers, so infer neither from the requested device alone.
    primary = getattr(getattr(sep, "model_instance", None), "primary_stem_name", None)
    produced = sep.separate(str(src), custom_output_names={primary: _FORCED})

    # `custom_output_names` is the fast path; the fallback exists because a version bump that
    # ignored it would otherwise write correct audio to a filename we never look at, and the job
    # would report "the model produced nothing" while the file sat right there.
    want = work / f"{_FORCED}.wav"
    if not want.exists():
        cands = [work / Path(str(p)).name for p in (produced or [])]
        cands = [p for p in cands if p.exists()]
        norm = primary.lower().replace(" ", "").replace("_", "")
        hit = [p for p in cands if norm in p.name.lower().replace(" ", "").replace("_", "")]
        if not hit:
            raise RuntimeError(
                f"{model}: no output matched the primary stem {primary!r} "
                f"(got {[p.name for p in cands]})")
        want = hit[0]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(want), str(out_path))

    # The secondary stem is the half we are throwing away — the karaoke model's lead, or the
    # de-reverb model's isolated reverb. Drop it here rather than leaving 37 MB per song for the
    # job's scratch sweep to find.
    for leftover in work.glob("*.wav"):
        leftover.unlink(missing_ok=True)
    return out_path


def _serve(model_dir: Path, device: str, work: Path) -> int:
    """Stay alive and take jobs on stdin, one JSON object per line, until told to stop.

    Keep the model process alive so queued jobs reuse the loaded models. The satellite server
    runs in a separate environment, so this child owns the warm model state.

    Protocol, deliberately dumb: a request line in, a reply line out, in lockstep. No ids, no
    concurrency, because a worker holds ONE card's models and a second job on it would contend
    with the first for the same VRAM rather than overlap with it.

        {"input": "...", "karaoke_out": "...", "dereverb_out": "...", ...}  ->  {"ok": true, ...}
        {"cmd": "quit"}                                                     ->  exits 0

    A failed job returns an error and leaves the worker available for later jobs. An unreadable
    stdin indicates the parent has gone away and ends the loop.
    """
    print("[leadvocal] serve: ready", flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except ValueError as exc:
            print(json.dumps({"ok": False, "error": f"bad request: {exc}"}), flush=True)
            continue
        if job.get("cmd") == "quit":
            print(json.dumps({"ok": True, "bye": True}), flush=True)
            return 0
        try:
            src = Path(job["input"])
            if not src.exists():
                raise RuntimeError(f"input not found: {src}")
            got = []
            if job.get("karaoke_out"):
                _separate_primary(job.get("karaoke_model") or "UVR_MDXNET_KARA_2.onnx", src,
                                  Path(job["karaoke_out"]), work, model_dir, device)
                got.append("backing")
            if job.get("dereverb_out"):
                _separate_primary(job.get("dereverb_model") or "UVR-DeEcho-DeReverb.pth", src,
                                  Path(job["dereverb_out"]), work, model_dir, device)
                got.append("dry")
            devs = sorted({str(getattr(s, "torch_device", "")) for s in _LOADED.values()} - {""})
            print(json.dumps({"ok": True, "produced": got, "device_used": ", ".join(devs),
                              "warm": sorted(m for m, _d in _LOADED)}), flush=True)
        except Exception as exc:                               # noqa: BLE001 — reported, never fatal
            print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="8.4 lead-vocal separator child")
    ap.add_argument("-i", "--input", help="the vocals stem, as plaintext WAV")
    ap.add_argument("--serve", action="store_true",
                    help="stay resident and take jobs on stdin, keeping the models loaded "
                         "between them (8.6.2). --work-dir is required with it.")
    ap.add_argument("--work-dir", help="scratch for --serve, fixed for the worker's lifetime")
    ap.add_argument("--karaoke-out", help="write the BACKING-vocal stem here (the detector)")
    ap.add_argument("--dereverb-out", help="write the DE-REVERBED signal here")
    ap.add_argument("--karaoke-model", default="UVR_MDXNET_KARA_2.onnx")
    ap.add_argument("--dereverb-model", default="UVR-DeEcho-DeReverb.pth")
    ap.add_argument("--model-dir", default=str(Path.home() / "leadvocal-models"))
    ap.add_argument("--device", default="cpu",
                    help="which device to ask for. It pins the ONNX execution provider directly "
                         "(_pin_onnx_provider); torch follows the visibility variables the parent "
                         "sets. Either half may still land elsewhere — both are printed.")
    args = ap.parse_args()

    if args.serve:
        if not args.work_dir:
            print("ERROR: --serve needs --work-dir", file=sys.stderr)
            return 2
        w = Path(args.work_dir)
        w.mkdir(parents=True, exist_ok=True)
        md = Path(args.model_dir)
        md.mkdir(parents=True, exist_ok=True)
        try:
            return _serve(md, args.device, w)
        finally:
            shutil.rmtree(w, ignore_errors=True)
    if not args.input:
        print("ERROR: -i/--input is required without --serve", file=sys.stderr)
        return 2

    src = Path(args.input)
    if not src.exists():
        print(f"ERROR: input not found: {src}", file=sys.stderr)
        return 2
    if not args.karaoke_out and not args.dereverb_out:
        print("ERROR: nothing to do — pass --karaoke-out and/or --dereverb-out", file=sys.stderr)
        return 2

    # Configure the inherited Torch policy before audio-separator imports its model stack.
    # Imported here, after the sys.path entry above, rather than at the top of the file: this
    # file is byte-identical to satellite/leadvocal_detect.py, and a module-level import after
    # the path setup needs a lint suppression in BOTH copies, which the E402 ratchet in
    # tests/test_webui_types.py refuses to grow.
    import torch
    from vocalis_torch_backend import apply_rocm_miopen_policy
    apply_rocm_miopen_policy(torch)

    model_dir = Path(args.model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    work = src.parent / "leadvocal-work"

    try:
        if args.karaoke_out:
            p = _separate_primary(args.karaoke_model, src, Path(args.karaoke_out),
                                  work, model_dir, args.device)
            print(f"[leadvocal] backing (detector, discarded after analysis) → {p}", flush=True)
        if args.dereverb_out:
            p = _separate_primary(args.dereverb_model, src, Path(args.dereverb_out),
                                  work, model_dir, args.device)
            print(f"[leadvocal] de-reverbed → {p}", flush=True)
    except Exception as exc:                                   # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
