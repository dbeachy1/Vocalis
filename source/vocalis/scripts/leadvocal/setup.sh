#!/usr/bin/env bash
# Install the isolated environment and separation models used only by
# scripts/leadvocal/detect.py. Keeping its large PyTorch and ONNX dependencies outside the main
# Vocalis environment avoids changing the application's runtime packages.
#
# PyTorch and torchvision must be installed as a compatible pair. The installer pins both and
# verifies torchvision's NMS operator after installation because an incompatible pair can install
# successfully and fail only when the model loads.
#
# The de-reverb models use PyTorch and follow its selected device. The karaoke detector uses ONNX
# Runtime and needs a matching GPU execution provider to run on a GPU. CPU is the default;
# --rocm enables the PyTorch ROCm build, --cuda enables PyTorch and ONNX CUDA builds, and
# --ort-gpu selects an ONNX GPU build independently. Each virtual environment uses one runtime
# build. GPU execution shares device capacity with other Vocalis workloads; the application can
# serialize separation work with its existing swap lock or select the CPU device.
#
# Usage: ./scripts/leadvocal/setup.sh [--force] [--all-models] [--rocm|--cuda|--ort-gpu|--cpu]
#   --force       rebuild the virtual environment; keep downloaded models
#   --all-models  also download the optional de-reverb alternatives
#   --rocm        install the ROCm PyTorch pair
#   --cuda        install the CUDA PyTorch and ONNX Runtime pairs
#   --ort-gpu     install a GPU-enabled ONNX Runtime
#   --cpu         use CPU runtimes (default)
#   -h, --help    show this header
#
# LEADVOCAL_VENV / LEADVOCAL_MODELS select the environment and model directories. The *_SPEC
# variables override package pins, and ROCM_INDEX / CUDA_INDEX override wheel indexes. Defaults
# are under $HOME so installed environments and model files persist independently of disposable
# model caches. See the design document for package and model details.
set -euo pipefail

LEADVOCAL_VENV="${LEADVOCAL_VENV:-$HOME/leadvocal-venv}"
LEADVOCAL_MODELS="${LEADVOCAL_MODELS:-$HOME/leadvocal-models}"
PY_VERSION="3.11"
CPU_INDEX="https://download.pytorch.org/whl/cpu"
# The PyTorch de-reverb stage follows the device selected by the installed torch build. The ONNX
# detector requires its own GPU execution provider; the default CPU runtime leaves it on CPU.
# Runtime diagnostics report the device each stage actually uses.
ROCM_INDEX="${ROCM_INDEX:-https://download.pytorch.org/whl/rocm6.4}"
# CUDA, where BOTH halves of the chain can run on the card -- the satellite build.
CUDA_INDEX="${CUDA_INDEX:-https://download.pytorch.org/whl/cu128}"
TORCH_SPEC="${TORCH_SPEC:-torch==2.13.0 torchvision==0.28.0}"
# Keep the ROCm torch and torchvision versions paired. Pinning both prevents pip from treating
# an existing build as satisfying an unpinned request and catches incompatible operator builds.
ROCM_TORCH_SPEC="${ROCM_TORCH_SPEC:-torch==2.9.1+rocm6.4 torchvision==0.24.1+rocm6.4}"
# Keep the CUDA torch and torchvision versions paired; update and validate them together.
CUDA_TORCH_SPEC="${CUDA_TORCH_SPEC:-torch==2.11.0+cu128 torchvision==0.26.0+cu128}"
SEPARATOR_SPEC="audio-separator==0.44.5"
# These mutually exclusive wheels install into the same package directory. Remove existing
# variants before installing the selected runtime so pip cannot leave files from another build.
ORT_CPU_SPEC="${ORT_CPU_SPEC:-onnxruntime==1.28.0}"
ORT_ROCM_SPEC="${ORT_ROCM_SPEC:-onnxruntime-rocm==1.22.2.post3}"
# Pin an ONNX Runtime build compatible with the CUDA runtime used by PyTorch. Provider
# availability alone is insufficient, so the verification gate creates a session. Update this
# package together with CUDA_TORCH_SPEC and rerun that gate.
ORT_CUDA_SPEC="${ORT_CUDA_SPEC:-onnxruntime-gpu==1.22.0}"

# The chain detect.py actually runs: the karaoke model IS the detector, and UVR-DeEcho-DeReverb
# is its --dereverb-model default. These two alone make a working end-to-end install.
CORE_MODELS=(
    "UVR_MDXNET_KARA_2.onnx"
    "UVR-DeEcho-DeReverb.pth"
)
# §4b's alternatives, for A/B-ing the de-reverb pass -- the one stage whose output is kept and
# trained on. 1.9 GB of weights a default install never loads, hence the flag.
ALT_MODELS=(
    "UVR-De-Reverb-aufr33-jarredou.pth"
    "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"
    "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt"
)

die() { echo "!! $*" >&2; exit 1; }

# ---- arg parsing ------------------------------------------------------------
FORCE=0
ALL_MODELS="${LEADVOCAL_ALL_MODELS:-0}"
# Default OFF. A ROCm torch is ~4 GB against ~1 GB for the CPU one, and on a box with no AMD
# card it is dead weight that also makes `torch.cuda.is_available()` interesting for no reason.
# Select a GPU build only on systems with a compatible device and driver.
ROCM="${LEADVOCAL_ROCM:-0}"
# Default OFF for the same reason, and exclusive with --rocm: one venv gets one torch
# build, so asking for both is a typo rather than a configuration.
CUDA="${LEADVOCAL_CUDA:-0}"
# Move the ONNX DETECTOR onto the card too. Implied by --cuda; opt-in under --rocm,
# because onnxruntime-rocm is a different wheel line from the CPU one and downgrading
# the runtime is a real change to a working box.
ORT_GPU="${LEADVOCAL_ORT_GPU:-0}"
while [ $# -gt 0 ]; do
    case "$1" in
        --force)       FORCE=1; shift ;;
        --all-models)  ALL_MODELS=1; shift ;;
        --rocm)        ROCM=1; CUDA=0; shift ;;
        --cuda)        CUDA=1; ROCM=0; ORT_GPU=1; shift ;;
        --ort-gpu)     ORT_GPU=1; shift ;;
        --cpu)         ROCM=0; CUDA=0; ORT_GPU=0; shift ;;
        -h|--help)
            # The whole leading comment block, un-hashed. Stops at the first non-comment line
            # rather than a line number or a banner match, so the header is free to grow (and
            # the banner appears three times up there, which is what rules a range out).
            awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
            exit 0 ;;
        *) die "Unknown arg: $1 (try --help)" ;;
    esac
done

MODELS=("${CORE_MODELS[@]}")
[ "$ALL_MODELS" = "1" ] && MODELS+=("${ALT_MODELS[@]}")

echo ">> Vocalis lead-vocal toolchain (8.4)"
echo "   venv:        $LEADVOCAL_VENV"
echo "   models:      $LEADVOCAL_MODELS"
echo "   python:      $PY_VERSION"
echo "   torch index: $CPU_INDEX  (CPU by design -- see header)"
echo

# Virtual-environment executable paths differ by platform. Resolve both layouts and call this
# function again after creation so subsequent steps use the interpreter that now exists.
venv_py() {
    if [ -x "$LEADVOCAL_VENV/Scripts/python.exe" ]; then
        echo "$LEADVOCAL_VENV/Scripts/python.exe"
    else
        echo "$LEADVOCAL_VENV/bin/python"
    fi
}
venv_bin() {   # an entry-point script inside the venv, by name
    if [ -d "$LEADVOCAL_VENV/Scripts" ]; then
        echo "$LEADVOCAL_VENV/Scripts/$1"
    else
        echo "$LEADVOCAL_VENV/bin/$1"
    fi
}
PY="$(venv_py)"
HAVE_UV=0
command -v uv >/dev/null 2>&1 && HAVE_UV=1

echo ">> [1/5] Isolated venv (Python $PY_VERSION)"
if [ -x "$PY" ] && [ "$FORCE" -eq 0 ]; then
    echo "         already exists, skipping (--force to rebuild)"
else
    if [ "$FORCE" -eq 1 ] && [ -d "$LEADVOCAL_VENV" ]; then
        # --force is an rm -rf against a path an env var supplied. Refuse the values that
        # would take a home directory with them, rather than warn about them.
        case "$LEADVOCAL_VENV" in
            ""|"/"|"$HOME"|"$HOME/") die "refusing to --force over '$LEADVOCAL_VENV'" ;;
        esac
        echo "         --force: removing the existing venv"
        rm -rf "$LEADVOCAL_VENV"
    fi
    if [ "$HAVE_UV" -eq 1 ]; then
        # uv can provision the requested interpreter when it is not installed on the host.
        uv venv "$LEADVOCAL_VENV" --python "$PY_VERSION"
    elif command -v "python$PY_VERSION" >/dev/null 2>&1; then
        "python$PY_VERSION" -m venv "$LEADVOCAL_VENV"
    else
        die "neither 'uv' nor 'python$PY_VERSION' on PATH (curl -LsSf https://astral.sh/uv/install.sh | sh)"
    fi
fi

PY="$(venv_py)"          # re-resolve: which layout we got is only knowable now it exists

# A venv is not guaranteed to have pip: `uv venv` omits it entirely. Re-running this script
# over one of those on a box where uv has since gone away skips creation (it exists!) and then
# dies on `-m pip` with a bare "No module named pip". Bootstrap it rather than tell the user to
# delete a directory they had no reason to think was wrong.
if [ "$HAVE_UV" -eq 0 ] && ! "$PY" -m pip --version >/dev/null 2>&1; then
    echo "         (this venv has no pip -- bootstrapping it)"
    "$PY" -m ensurepip --upgrade >/dev/null
fi

pipi() {
    if [ "$HAVE_UV" -eq 1 ]; then
        uv pip install --python "$PY" "$@"
    else
        "$PY" -m pip install "$@"
    fi
}

echo ">> [2/5] torch + torchvision, CPU build, ONE command (read the header before editing)"
# --index-url, NOT --extra-index-url: this command must see ONE index and nothing else.
# With PyPI still in the mix pip is free to prefer its default torchvision, which on Linux is
# the CUDA-linked one, and we are straight back to the nms error the pairing exists to prevent.
# Resolve torch and torchvision together from the selected index so both use the same backend.
# shellcheck disable=SC2086  # the SPECs are intentionally word-split into args
if [ "$CUDA" = "1" ]; then
    echo "         CUDA build (BOTH halves on the card -- this is the satellite build)"
    # Uninstall first for the ROCm branch's reason, which was never specific to ROCm: `+cpu`,
    # `+rocm6.4` and `+cu128` are LOCAL VERSION LABELS on one version number, so a bare
    # requirement is satisfied by whichever build is already there and pip does nothing while
    # reporting success.
    "$PY" -m pip uninstall -y torch torchvision >/dev/null 2>&1 || true
    pipi $CUDA_TORCH_SPEC --index-url "$CUDA_INDEX"
elif [ "$ROCM" = "1" ]; then
    echo "         ROCm build (de-reverb on the card; the detector needs --ort-gpu too)"
    # Remove both packages before installing the selected pair. A backend change must not reuse
    # an already-installed CPU build that satisfies only the package name. Uninstalling just these
    # packages preserves shared dependencies that the backend-specific index may not contain.
    "$PY" -m pip uninstall -y torch torchvision >/dev/null 2>&1 || true
    pipi $ROCM_TORCH_SPEC --index-url "$ROCM_INDEX"
else
    pipi $TORCH_SPEC --index-url "$CPU_INDEX"
fi

echo ">> [3/5] audio-separator + the ONNX runtime (torch already satisfied -- pip leaves it alone)"
# shellcheck disable=SC2086  # same
pipi $SEPARATOR_SPEC

# These variants share one package directory. Remove all variants before installing the selected
# runtime so provider modules from a previous build cannot remain mixed in the environment.
"$PY" -m pip uninstall -y onnxruntime onnxruntime-gpu onnxruntime-rocm >/dev/null 2>&1 || true
if [ "$ORT_GPU" = "1" ] && [ "$CUDA" = "1" ]; then
    echo "         onnxruntime-gpu (CUDA) -- the detector runs on the card too"
    pipi $ORT_CUDA_SPEC
elif [ "$ORT_GPU" = "1" ]; then
    echo "         onnxruntime-rocm -- read the detector note in the verify gate before trusting it"
    pipi $ORT_ROCM_SPEC
else
    pipi $ORT_CPU_SPEC
fi

echo ">> [4/5] Models -> $LEADVOCAL_MODELS"
mkdir -p "$LEADVOCAL_MODELS"
# Driven through audio-separator rather than curl on purpose. A weights file on its own is not
# a usable model here: the roformer .ckpt is inert without its config yaml (both anvuew
# checkpoints share dereverb_mel_band_roformer_anvuew.yaml), and the loader also wants
# download_checks.json, mdx_model_data.json and vr_model_data.json beside it. Five curls would
# produce a directory that looks complete and fails at load; --download_model_only fetches each
# model's whole set into --model_file_dir, which is the same dir detect.py passes to Separator.
#
# No --force handling here, deliberately: a model filename IS its version, so a re-download can
# only reproduce the same bytes. Delete the file to re-fetch it.
for m in "${MODELS[@]}"; do
    if [ -s "$LEADVOCAL_MODELS/$m" ]; then
        echo "         $m -- present, skipping"
        continue
    fi
    echo "         $m -- downloading"
    "$(venv_bin audio-separator)" --download_model_only \
        -m "$m" --model_file_dir "$LEADVOCAL_MODELS"
done

echo
echo ">> [5/5] Verify gate (this is what catches a mismatched torchvision)"
LEADVOCAL_MODELS="$LEADVOCAL_MODELS" LEADVOCAL_WANT_ROCM="$ROCM" LEADVOCAL_WANT_CUDA="$CUDA" LEADVOCAL_WANT_ORT_GPU="$ORT_GPU" "$PY" - <<'PYEOF'
import logging
import os
import sys
import tempfile

model_dir = os.environ["LEADVOCAL_MODELS"]

import torch
import torchvision
import onnxruntime
print("   torch:", torch.__version__, "| torchvision:", torchvision.__version__,
      "| onnxruntime:", onnxruntime.__version__, "| python:", sys.version.split()[0])
# Check the installed build against the requested backend. A consistent pre-existing CPU build
# can pass package checks even when the caller requested ROCm or CUDA.
want_rocm = os.environ.get("LEADVOCAL_WANT_ROCM") == "1"
want_cuda = os.environ.get("LEADVOCAL_WANT_CUDA") == "1"
want_ort_gpu = os.environ.get("LEADVOCAL_WANT_ORT_GPU") == "1"
is_rocm = ("+rocm" in torch.__version__) or bool(getattr(torch.version, "hip", None))
is_cuda = ("+cu" in torch.__version__) and not is_rocm
if want_cuda and not is_cuda:
    print(f"   !! ASKED FOR CUDA AND GOT {torch.__version__} -- the install did not take.")
    print("      Nothing downstream would fail; it would just silently run on the CPU.")
    raise SystemExit(1)
if want_cuda:
    print("   CUDA build confirmed:", torch.__version__,
          "| torch.cuda.is_available():", torch.cuda.is_available())
    if not torch.cuda.is_available():
        print("   !! ...but no device is visible, so everything will run on the CPU anyway.")
        raise SystemExit(1)
if want_rocm and not is_rocm:
    print(f"   !! ASKED FOR ROCm AND GOT {torch.__version__} -- the install did not take.")
    print("      Nothing downstream would fail; it would just silently run on the CPU.")
    raise SystemExit(1)
if not want_rocm and not want_cuda and "+cpu" not in torch.__version__:
    print("   !! torch is not the CPU build, and neither --rocm nor --cuda was asked for")
if want_rocm:
    print("   ROCm build confirmed:", torch.__version__,
          "| torch.cuda.is_available():", torch.cuda.is_available())
    if not torch.cuda.is_available():
        print("   !! ...but no device is visible, so the de-reverb models will run on the CPU")
        print("      anyway. Check that this user can see the cards (rocm-smi, groups).")
        raise SystemExit(1)

try:
    # THE landmine, called for real. A torchvision compiled against a different torch imports
    # perfectly and fails right here -- and here is also where audio-separator's ONNX path
    # fails, because onnx2torch pulls torchvision.ops in at import time.
    from torchvision.ops import nms
    nms(torch.tensor([[0.0, 0.0, 1.0, 1.0]]), torch.tensor([0.9]), 0.5)
    print("   torchvision::nms: OK  (torch/torchvision pair is consistent)")
except Exception as exc:                                       # noqa: BLE001
    print(f"   torchvision::nms: FAILED -> {type(exc).__name__}: {exc}")
    print("   -> torch and torchvision were not installed together from the CPU index.")
    print("      Re-run this script with --force.")
    raise SystemExit(1)

try:
    from audio_separator.separator import Separator
    with tempfile.TemporaryDirectory() as tmp:
        sep = Separator(output_dir=tmp, model_file_dir=model_dir, log_level=logging.WARNING)
        sep.load_model(model_filename="UVR_MDXNET_KARA_2.onnx")
        primary = getattr(getattr(sep, "model_instance", None), "primary_stem_name", None)
    # detect.py reads this same attribute to decide which output file to keep, so a load that
    # cannot answer it is a broken install even though nothing raised.
    if not primary:
        raise RuntimeError("loaded, but primary_stem_name is empty -- detect.py needs it")
    print(f"   audio-separator: OK | karaoke model loads | primary stem: {primary!r}")
except Exception as exc:                                       # noqa: BLE001
    print(f"   audio-separator: FAILED -> {type(exc).__name__}: {exc}")
    raise SystemExit(1)

# A listed GPU provider does not prove its libraries can load. Create a real inference session so
# an incompatible provider fails installation instead of silently falling back to CPU.
#
# So the session is CREATED here, for real, on a throwaway model, and a failure is fatal.
if want_ort_gpu:
    import numpy as np
    import onnx
    from onnx import helper, TensorProto

    want_ep = "CUDAExecutionProvider" if want_cuda else "ROCMExecutionProvider"
    try:
        if want_ep not in onnxruntime.get_available_providers():
            raise RuntimeError(f"{want_ep} is not in this onnxruntime build "
                               f"({onnxruntime.get_available_providers()})")
        node = helper.make_node("Relu", ["x"], ["y"])
        graph = helper.make_graph([node], "g",
                                  [helper.make_tensor_value_info("x", TensorProto.FLOAT, [2])],
                                  [helper.make_tensor_value_info("y", TensorProto.FLOAT, [2])])
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
        # Match the checked-in model's IR version. A newer default can fail before the GPU provider
        # is exercised, so keep this probe compatible with the model and pinned runtime.
        model.ir_version = 8
        sess = onnxruntime.InferenceSession(model.SerializeToString(), providers=[want_ep])
        got = sess.get_providers()
        if want_ep not in got:
            raise RuntimeError(f"session fell back to {got}")
        sess.run(None, {"x": np.array([-1.0, 1.0], dtype=np.float32)})
        print(f"   onnxruntime {want_ep}: OK  (a session really ran on it)")
    except Exception as exc:                                   # noqa: BLE001
        print(f"   onnxruntime {want_ep}: FAILED -> {type(exc).__name__}: {exc}")
        print("   -> the ONNX half would silently run on the CPU. Usually a CUDA/cuDNN major")
        print("      mismatch between the onnxruntime-gpu wheel and the one torch brought:")
        print(f"      torch reports CUDA {getattr(torch.version, 'cuda', None)}.")
        print("      Pin ORT_CUDA_SPEC to an onnxruntime-gpu built for that major version.")
        raise SystemExit(1)
PYEOF

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo
echo ">> Setup done. detect.py runs out of this venv:"
echo "   $PY $HERE/detect.py -i vocals.wav --karaoke-out backing.wav \\"
echo "       --dereverb-out dry.wav --model-dir $LEADVOCAL_MODELS"
[ "$ALL_MODELS" = "1" ] || echo "   (§4b's three de-reverb alternatives were skipped -- --all-models fetches them)"
