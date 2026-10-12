#!/usr/bin/env python3
"""Run resemble-enhance bandwidth extension as a path-in/path-out child process.

The caller stages opaque paths and owns vault access. Chatterbox output is sampled at 24 kHz, so
bandwidth extension adds high-frequency content needed by higher-rate RVC training. The added high
frequencies are synthesized, not recovered from the recording, so this is intended for generated
audio.

Compatibility shims stay in this wrapper instead of site-packages so dependency reinstalls do not
overwrite them. The wrapper stubs an unused DeepSpeed import and adapts the SciPy result for NumPy 2.
Weights must come from the mounted pinned snapshot; this child never downloads model files.
"""
import argparse
import sys
import time
import types
from pathlib import Path

SATELLITE_DIR = Path(__file__).resolve().parents[2] / "satellite"
sys.path.insert(0, str(SATELLITE_DIR))
from vocalis_torch_backend import apply_rocm_miopen_policy  # noqa: E402

_MODEL_REVISION = "f35e879924e339228db2e9752185a21ef8ffeb3e"
_MODEL_FILES = (
    "hparams.yaml",
    "ds/G/latest",
    "ds/G/default/mp_rank_00_model_states.pt",
)


def _shim_deepspeed() -> None:
    """Satisfy an import that inference never uses. See module docstring (1).

    DeepSpeedConfig and DeepSpeedEngine must be CLASSES, not functions: utils/engine.py
    does `class Engine(DeepSpeedEngine)` at import time, and you cannot subclass a
    function ("TypeError: function() argument 'code' must be code, not str" -- a
    genuinely unhelpful error, and the reason this comment exists). Subclassing must
    succeed; only INSTANTIATION needs to refuse, and nothing on the inference path
    instantiates either one.
    """
    if "deepspeed" in sys.modules:
        return

    class _Stub:
        def __init__(self, *_a, **_k):
            raise RuntimeError("deepspeed is stubbed: this venv is inference-only")

    def _refuse(*_a, **_k):
        raise RuntimeError("deepspeed is stubbed: this venv is inference-only")

    ds = types.ModuleType("deepspeed")
    ds.DeepSpeedConfig = _Stub
    ds.init_distributed = _refuse

    accel = types.ModuleType("deepspeed.accelerator")
    accel.get_accelerator = _refuse

    runtime = types.ModuleType("deepspeed.runtime")
    engine = types.ModuleType("deepspeed.runtime.engine")
    engine.DeepSpeedEngine = _Stub          # subclassed at import; see docstring
    utils = types.ModuleType("deepspeed.runtime.utils")
    utils.clip_grad_norm_ = _refuse

    ds.accelerator, ds.runtime = accel, runtime
    runtime.engine, runtime.utils = engine, utils

    sys.modules.update({
        "deepspeed": ds,
        "deepspeed.accelerator": accel,
        "deepspeed.runtime": runtime,
        "deepspeed.runtime.engine": engine,
        "deepspeed.runtime.utils": utils,
    })


def _patch_numpy2() -> None:
    """fsolve returns a 1-element array; numpy 2 refuses float() on it. Docstring (2)."""
    import scipy.optimize
    from resemble_enhance.enhancer.lcfm.cfm import Solver

    @staticmethod
    def exponential_decay_mapping(t, n=4):
        def h(t_, a_):
            return (a_ ** t_ - 1) / (a_ - 1)
        a = float(scipy.optimize.fsolve(lambda a_: h(1 / n, a_) - 0.5, x0=0)[0])
        return h(t, a_=a)

    Solver.exponential_decay_mapping = exponential_decay_mapping


class ModelUnavailableError(RuntimeError):
    """The configured local model directory is not the complete pinned snapshot."""


def _weights_dir(model_dir: str | Path) -> Path:
    """Return the pinned stage directory only when all loader inputs are present."""
    run_dir = Path(model_dir)
    if (run_dir.name != "enhancer_stage2"
            or run_dir.parent.name != _MODEL_REVISION):
        raise ModelUnavailableError(
            f"model directory must be the pinned Resemble Enhance snapshot {_MODEL_REVISION}")
    missing = tuple(name for name in _MODEL_FILES if not (run_dir / name).is_file())
    if missing:
        raise ModelUnavailableError(
            "pinned Resemble Enhance snapshot is incomplete (" + ", ".join(missing) + ")")
    return run_dir


def _local_model_loader(inference_module, run_dir: Path) -> None:
    """Replace the pinned upstream downloader with a local-only snapshot check.

    At this source revision `load_enhancer` calls its module-level `download` binding before
    reading the three files. Keeping that binding local-only closes the race where a file is
    removed after the initial preflight and prevents every upstream URL fallback.
    """
    expected = run_dir.resolve()

    def require_local_snapshot(requested_dir=None):
        if requested_dir is None or Path(requested_dir).resolve() != expected:
            raise ModelUnavailableError(
                "Resemble Enhance requested a model directory outside the pinned snapshot")
        return _weights_dir(expected)

    inference_module.download = require_local_snapshot


def main() -> int:
    ap = argparse.ArgumentParser(description="Neural bandwidth extension (one file).")
    ap.add_argument("-i", "--input", required=True, help="Input audio (any ffmpeg-readable).")
    ap.add_argument("-o", "--output", required=True, help="Output WAV (44.1 kHz mono).")
    ap.add_argument("--model-dir", required=True,
                    help="Run directory for the mounted pinned Resemble Enhance snapshot.")
    ap.add_argument("--nfe", type=int, default=32,
                    help="Denoising steps. Listening tests favored 32 over 16 or 8; "
                         "64 showed no improvement over 32 and costs about 2.3x. "
                         "The BANDWIDTH is the same at every setting -- the steps buy "
                         "coherence in the invented high end, not more of it.")
    ap.add_argument("--device", default="cuda:0",
                    help="Torch device. Under ROCm, select an available device such as cuda:0 or cuda:1.")
    ap.add_argument("--solver", default="midpoint", choices=("midpoint", "rk4", "euler"))
    ap.add_argument("--lambd", type=float, default=0.9,
                    help="Denoise strength. 0.9 (not the library's 0.5) because "
                         "Chatterbox output carries no room noise to preserve.")
    ap.add_argument("--tau", type=float, default=0.5)
    a = ap.parse_args()

    if not (1 <= a.nfe <= 128):
        print(f"ERROR: --nfe must be in 1..128, got {a.nfe}", file=sys.stderr)
        return 2

    src = Path(a.input)
    if not src.is_file():
        print(f"ERROR: input not found: {src}", file=sys.stderr)
        return 2

    try:
        run_dir = _weights_dir(a.model_dir)
    except ModelUnavailableError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 3

    _shim_deepspeed()

    try:
        import soundfile as sf
        import torch
        apply_rocm_miopen_policy(torch)
        import resemble_enhance.enhancer.inference as inf
    except Exception as e:  # pragma: no cover - install-time guidance
        print(f"ERROR: could not import the enhance stack ({e}).\n"
              f"Run scripts/enhance/setup.sh first.", file=sys.stderr)
        return 2

    _patch_numpy2()
    _local_model_loader(inf, run_dir)

    x, sr = sf.read(str(src), dtype="float32", always_2d=True)
    wav = torch.from_numpy(x.mean(1))          # mono; the enhancer is 1-D only
    audio_s = len(wav) / float(sr or 1)

    # LOAD THE MODEL FIRST, ON PURPOSE, SO IT CAN BE TIMED ON ITS OWN.
    #
    # Enhancement costs `startup + rate x audio_seconds`, and those two numbers are what
    # every ETA in the app is built from. inf.enhance() loads the model lazily on its first
    # call, which FUSES the two: one run then yields a single wall-clock number that cannot
    # be split, and the only way back to the two parameters is to regress them out of many
    # runs of differing lengths -- which needs data we may never get (a user who only ever
    # enhances 60-minute training clips gives us no short samples at all).
    #
    # load_enhancer is @cache'd, so calling it here means inf.enhance() below reuses this
    # instance instead of loading a second one. That makes ONE run of ANY length enough to
    # measure both parameters exactly, on whatever card the user actually has.
    #
    # Guarded: this reaches into the library's shape (a public function, but still theirs).
    # If it ever moves, enhancement must not care -- inf.enhance() would simply load the
    # model itself, exactly as before. We lose the timing for that run, not the run.
    load_s = 0.0
    try:
        t0 = time.perf_counter()
        inf.load_enhancer(run_dir, a.device)
        load_s = time.perf_counter() - t0
    except Exception as e:                     # noqa: BLE001 - timing is not the job
        print(f"(could not pre-load the enhancer for timing: {e})", file=sys.stderr)

    t0 = time.perf_counter()
    out, out_sr = inf.enhance(wav, sr, a.device, nfe=a.nfe, solver=a.solver,
                              lambd=a.lambd, tau=a.tau, run_dir=run_dir)
    compute_s = time.perf_counter() - t0

    dst = Path(a.output)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")    # never leave a half-written WAV behind
    try:
        # format="WAV" explicitly: soundfile otherwise sniffs it from the extension,
        # and ".part" is not one. Same call shape as tts_utils.save_wav_sf.
        sf.write(str(tmp), out.cpu().numpy(), out_sr, format="WAV", subtype="PCM_16")
        tmp.replace(dst)
    finally:
        tmp.unlink(missing_ok=True)

    # The machine-readable half of the run. The parent (enhance.run_enhance) records this
    # against the card it ran on, so the NEXT estimate is this box's own number rather than
    # a constant measured on somebody else's hardware. `load_s == 0` means the pre-load above
    # was refused: compute_s then still contains the model load, so the parent must not
    # record it -- an unmeasured box says "no estimate", it does not guess.
    print(f"VOCALIS_TIMING audio_s={audio_s:.3f} load_s={load_s:.3f} "
          f"compute_s={compute_s:.3f} nfe={a.nfe}")
    print(f"{sr} Hz -> {out_sr} Hz | {out.shape[-1] / out_sr:.1f}s | nfe={a.nfe}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
