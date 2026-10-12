"""Apply opt-in Torch backend settings shared by Vocalis worker processes."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Callable, Mapping, MutableMapping

_VISIBILITY_VARIABLES = ("HIP_VISIBLE_DEVICES", "CUDA_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES")
_DEVICE_PROBE = (
    "import json, torch\n"
    "hip = bool(getattr(torch.version, 'hip', None))\n"
    "count = torch.cuda.device_count() if hip else 0\n"
    "flags = [bool(torch.cuda.get_device_properties(i).is_integrated) for i in range(count)]\n"
    "print(json.dumps({'hip': hip, 'integrated': flags}))\n"
)


def hide_integrated_rocm_gpus(environ: MutableMapping[str, str] | None = None,
                              run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
                              kfd_present: bool | None = None) -> dict:
    """Set HIP_VISIBLE_DEVICES to the discrete AMD GPUs when an integrated one is present.

    ROCm enumerates a CPU's integrated GPU as one more device, and `--gpus all` then loads a
    model replica on it (2026-10-09, M1 on the AMD test host: a Chatterbox replica on the 2 GB Raphael iGPU,
    gfx1036, which the bundled gfx1201 PyTorch does not even target). The legacy install made
    the operator export HIP_VISIBLE_DEVICES=0,1; the packaged app applies the same rule itself.
    It must run before this process imports torch: the variable is read once at HIP init, and
    every engine child inherits it. A probe child imports torch to classify the devices.

    An explicit visibility setting always wins. A failed probe, a CUDA host, a machine without
    an integrated GPU, or one with only integrated GPUs leaves the environment unchanged.
    Returns what was decided, for the caller to log.
    """
    env = os.environ if environ is None else environ
    if kfd_present is None:
        kfd_present = os.path.exists("/dev/kfd")
    if not kfd_present:
        return {"action": "none", "reason": "no ROCm kernel driver"}
    explicit = [name for name in _VISIBILITY_VARIABLES if env.get(name) is not None]
    if explicit:
        return {"action": "none", "reason": f"{explicit[0]} set explicitly"}
    try:
        result = run([sys.executable, "-c", _DEVICE_PROBE], capture_output=True, text=True,
                     timeout=120, env=dict(env))
        report = json.loads(result.stdout.strip().splitlines()[-1]) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
        return {"action": "none", "reason": f"device probe failed: {type(exc).__name__}"}
    if report is None:
        return {"action": "none", "reason": f"device probe exited {result.returncode}"}
    flags = report.get("integrated") or []
    discrete = [str(i) for i, integrated in enumerate(flags) if not integrated]
    if not report.get("hip") or len(discrete) == len(flags):
        return {"action": "none", "reason": "no integrated GPU"}
    if not discrete:
        return {"action": "none", "reason": "only integrated GPUs present"}
    env["HIP_VISIBLE_DEVICES"] = ",".join(discrete)
    return {"action": "hid-integrated", "visible": env["HIP_VISIBLE_DEVICES"],
            "integrated": [i for i, integrated in enumerate(flags) if integrated]}


def apply_rocm_miopen_policy(torch_module, environ: Mapping[str, str] | None = None) -> bool:
    """Disable MIOpen only when explicitly requested in a ROCm process.

    Returns whether the policy applied. CUDA, unset, and non-ROCm processes retain
    their existing backend configuration.
    """
    env = os.environ if environ is None else environ
    if env.get("VOCALIS_ROCM_DISABLE_MIOPEN") != "1" or not getattr(
        getattr(torch_module, "version", None), "hip", None
    ):
        return False
    torch_module.backends.cudnn.enabled = False
    return True
