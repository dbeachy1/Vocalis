#!/usr/bin/env python3
"""Post-install check for the neural-enhance venv. Run by BOTH setup.sh and setup.bat.

Shared on purpose. The two installers already hand-mirror each other, and the thing most
worth getting right — "did we end up with a GPU torch, and does the package actually
import?" — is exactly the thing you do not want written twice in two languages.

The GPU check is the point. A CPU-only torch is not a failed install, it is a SILENT
40x-slower one: pip will happily satisfy resemble-enhance's `torch==2.1.1` pin with a
CPU wheel and never mention it. An hour of audio then takes days instead of 95 minutes,
and the only symptom is that training seems to hang. So this exits non-zero rather than
warn.
"""
import sys
import types


def _stub_deepspeed() -> None:
    """Mirror enhance_audio.py's shim, so the import is exercised the way it will run.

    DeepSpeedConfig / DeepSpeedEngine must be CLASSES: resemble_enhance/utils/engine.py
    does `class Engine(DeepSpeedEngine)` at import time, and subclassing a function dies
    with "TypeError: function() argument 'code' must be code, not str".
    """
    class _Stub:
        pass

    def _refuse(*_a, **_k):
        raise RuntimeError("deepspeed is stubbed: this venv is inference-only")

    mods = {
        "deepspeed": {"DeepSpeedConfig": _Stub, "init_distributed": _refuse},
        "deepspeed.accelerator": {"get_accelerator": _refuse},
        "deepspeed.runtime": {},
        "deepspeed.runtime.engine": {"DeepSpeedEngine": _Stub},
        "deepspeed.runtime.utils": {"clip_grad_norm_": _refuse},
    }
    for name, attrs in mods.items():
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        sys.modules[name] = m


def main() -> int:
    _stub_deepspeed()

    try:
        import torch
    except Exception as e:
        print(f"   FAILED: torch does not import ({e})", file=sys.stderr)
        return 1

    try:
        from resemble_enhance.enhancer.inference import enhance  # noqa: F401
    except Exception as e:
        print(f"   FAILED: resemble-enhance does not import ({e})", file=sys.stderr)
        return 1

    print(f"   torch {torch.__version__}   GPUs: {torch.cuda.device_count()}")
    print("   resemble-enhance imports OK")

    if not torch.cuda.is_available():
        print()
        print("   *** NO GPU VISIBLE TO TORCH.", file=sys.stderr)
        print("   *** The enhancer would run on the CPU — roughly 40x slower. An hour of",
              file=sys.stderr)
        print("   *** audio would take days, not 95 minutes, and the only symptom you would",
              file=sys.stderr)
        print("   *** see is training appearing to hang.", file=sys.stderr)
        print("   ***", file=sys.stderr)
        print("   *** If this box has a GPU, the torch wheel above is the wrong flavor —",
              file=sys.stderr)
        print("   *** pip most likely satisfied resemble-enhance's torch==2.1.1 pin with a",
              file=sys.stderr)
        print("   *** CPU wheel. Re-run with the right --index-url.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
