#!/usr/bin/env bash
# =============================================================================
# Vocalis voice-swap toolchain installer (ROCm)
# =============================================================================
# Builds an ISOLATED venv so it never touches the working ACE-Step .venv.
# Installs, matching ACE-Step's known-good stack:
#   - PyTorch ROCm 6.4  (same build family as ACE-Step: torch 2.9.1+rocm6.4)
#   - Demucs            (clean 2-stem vocal / instrumental separation)
#   - rvc-python        (RVC voice conversion; the actual "voice swap")
#
# Compatibility requirements for the isolated voice-swap environment:
#   * Python 3.10 -- NOT 3.11/3.12. fairseq 0.12.2 and its old hydra-core/
#     omegaconf use dataclass instance defaults, which Python 3.11+ rejects
#     ("mutable default ... use default_factory"). 3.10 is the newest Python
#     where the rvc-python stack imports.
#   * numpy pinned 1.26.4 via uv override -- rvc-python pins ==1.25.2, which
#     won't build on modern Python (needs the removed distutils), and numpy 2.x
#     breaks the pyworld/parselmouth C-extensions. 1.26.4 satisfies torch 2.9.1,
#     numba, and the 1.x C-ABI at once.
#   * setuptools<81 + wheel -- pyworld imports pkg_resources; uv venvs omit
#     setuptools, and setuptools 81 removed pkg_resources.
#
# Run once:  ./scripts/voiceswap/setup.sh
# Override venv location:  VOICESWAP_VENV=/path ./scripts/voiceswap/setup.sh
# (The default lives in $HOME so the installed toolchain persists independently of disposable
# model storage.)
# =============================================================================
set -euo pipefail

VOICESWAP_VENV="${VOICESWAP_VENV:-$HOME/voiceswap-venv}"
ROCM_INDEX="https://download.pytorch.org/whl/rocm6.4"   # matches installed torch 2.9.1+rocm6.4
PY_VERSION="3.10"                                        # see header: fairseq can't import on 3.11+

echo ">> Voice-swap toolchain install"
echo "   venv:        $VOICESWAP_VENV"
echo "   python:      $PY_VERSION"
echo "   torch index: $ROCM_INDEX"
echo

if ! command -v uv >/dev/null 2>&1; then
  echo "!! 'uv' not found on PATH. Install it first (curl -LsSf https://astral.sh/uv/install.sh | sh)." >&2
  exit 1
fi

echo ">> [1/5] Creating isolated venv (Python $PY_VERSION)"
uv venv "$VOICESWAP_VENV" --python "$PY_VERSION"

PYBIN="$VOICESWAP_VENV/bin/python"
pipi() { uv pip install --python "$PYBIN" "$@"; }

echo ">> [2/5] Installing ROCm PyTorch (this is the big download, ~few GB)"
pipi torch torchaudio --index-url "$ROCM_INDEX"

echo ">> [3/5] Installing Demucs (stem separation)"
pipi demucs

echo ">> [4/5] Installing rvc-python (voice conversion, numpy overridden to 1.26.4)"
OVERRIDE_FILE="$(mktemp)"
trap 'rm -f "$OVERRIDE_FILE"' EXIT
printf 'numpy==1.26.4\n' > "$OVERRIDE_FILE"
pipi rvc-python --override "$OVERRIDE_FILE"

echo ">> [5/5] Installing setuptools<81 + wheel (pkg_resources for pyworld)"
pipi "setuptools<81" wheel

echo
echo ">> Verify gate:"
"$PYBIN" - <<'PYEOF'
import sys
import torch
print("   torch:", torch.__version__, "| HIP available:", torch.cuda.is_available(),
      "| devices:", torch.cuda.device_count())
try:
    import demucs; print("   demucs: OK")
except Exception as e:
    print("   demucs: FAILED ->", e)
try:
    import rvc_python
    from rvc_python.infer import RVCInference   # noqa: F401 -- the class the seam uses
    print("   rvc_python: OK | RVCInference import: OK")
except Exception as e:
    print("   rvc_python: FAILED ->", e)
import numpy, numba
print("   numpy:", numpy.__version__, "| numba:", numba.__version__,
      "| python:", sys.version.split()[0])
PYEOF

echo
echo ">> Setup done. Next: get an RVC target-voice model (.pth) -- see README -- then run:"
echo "   ./scripts/voiceswap/voiceswap.sh -i song.wav -m /path/to/target_voice.pth -o out.wav"
