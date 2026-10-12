#!/usr/bin/env bash
# =============================================================================
# Vocalis neural-enhance toolchain installer
# =============================================================================
# Builds the ISOLATED venv for resemble-enhance -- neural bandwidth extension.
#
# Chatterbox synthesizes at 24 kHz, so a higher-rate RVC model would otherwise train against
# a band with little or no source content. Extension supplies synthesized high-frequency detail.
#
# Vocalis therefore refuses to train on band-limited audio, and this toolchain is how it
# stops being band-limited. setup.sh calls this script; you should not normally need to.
#
# WHY A SEPARATE VENV: resemble-enhance pins torch==2.1.1. Vocalis runs 2.13. They
# cannot share an environment -- but they are installed together, by the same setup.
#
# Standalone use (re-install, or a box where setup.sh already ran):
#     ./scripts/enhance/setup.sh
#
# Knobs (setup.sh passes the first three through so the two venvs agree):
#     ENHANCE_VENV     where it lands              (default: $HOME/enhance-venv)
#     VOCALIS_PYTHON   the bootstrap interpreter   (default: python3)
#     TORCH_INDEX      the wheel index             (default: probed from the GPU)
#     TORCH_SPEC       the torch/torchaudio pins   (default: unpinned)
# =============================================================================
set -euo pipefail

ENHANCE_VENV="${ENHANCE_VENV:-$HOME/enhance-venv}"
PY_BOOT="${VOCALIS_PYTHON:-python3}"

# Vendor probe -- only used when we are run standalone. setup.sh has already done this
# work and passes TORCH_INDEX in, so the enhance venv gets the SAME torch flavor as
# Vocalis's own. A CPU torch here is not a broken install, it is a 40x slower one, and
# nothing would tell you: hence the hard verify at the end.
if [ -z "${TORCH_INDEX:-}" ]; then
    if command -v nvidia-smi >/dev/null 2>&1; then
        TORCH_INDEX="https://download.pytorch.org/whl/cu124"
        TORCH_SPEC="${TORCH_SPEC:-torch==2.6.0+cu124 torchaudio==2.6.0+cu124}"
    elif command -v rocminfo >/dev/null 2>&1 || [ -d /opt/rocm ]; then
        TORCH_INDEX="https://download.pytorch.org/whl/rocm7.2"
        TORCH_SPEC="${TORCH_SPEC:-torch torchaudio}"
    else
        TORCH_INDEX="https://download.pytorch.org/whl/cpu"
        TORCH_SPEC="${TORCH_SPEC:-torch torchaudio}"
    fi
fi
TORCH_SPEC="${TORCH_SPEC:-torch torchaudio}"

echo ">> Vocalis neural-enhance toolchain"
echo "   venv:   $ENHANCE_VENV"
echo "   index:  $TORCH_INDEX"

if [ -x "$ENHANCE_VENV/bin/python" ]; then
    echo "[1/4] Virtual environment already exists, skipping."
else
    echo "[1/4] Creating the isolated venv (via $PY_BOOT) ..."
    if ! command -v "$PY_BOOT" >/dev/null 2>&1; then
        echo "ERROR: '$PY_BOOT' not found. Install Python 3.10+ or set VOCALIS_PYTHON." >&2
        exit 1
    fi
    "$PY_BOOT" -m venv "$ENHANCE_VENV"
fi

PY="$ENHANCE_VENV/bin/python"

# A venv is not guaranteed to have pip. `uv venv` omits it entirely, and re-running this
# script over one of those skips creation (it exists!) and then dies on `-m pip` with a
# bare "No module named pip". Bootstrap it rather than tell the user to delete a directory
# they had no reason to think was wrong.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
    echo "      (this venv has no pip — bootstrapping it)"
    "$PY" -m ensurepip --upgrade >/dev/null
fi
"$PY" -m pip install --upgrade pip --quiet

echo "[2/4] Installing torch (must come BEFORE resemble-enhance) ..."
# shellcheck disable=SC2086  # TORCH_SPEC is intentionally word-split into args
"$PY" -m pip install --quiet $TORCH_SPEC --index-url "$TORCH_INDEX"

echo "[3/4] Installing resemble-enhance ..."
# --no-deps IS LOAD-BEARING. resemble-enhance pins torch==2.1.1 (2023). Without this,
# pip happily downgrades the wheel we just installed to a CPU-only 2.1.1 and the
# enhancer silently runs ~40x slower with nothing to tell you why.
"$PY" -m pip install --quiet --no-deps resemble-enhance

echo "[4/4] Installing its real dependencies ..."
# The list lives in requirements.txt, which setup.bat reads TOO. Deliberately not two
# hand-mirrored copies: Vocalis's own setup.sh/setup.bat already keep their dep lists in
# sync by hand, nothing in the test suite guards the pair, and a careless merge silently
# drops one side. See the header of requirements.txt for what is missing from it and why.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$PY" -m pip install --quiet -r "$HERE/requirements.txt"

echo
echo ">> Verifying (this is what catches a CPU-only torch) ..."
"$PY" "$HERE/verify_install.py"

echo
echo ">> Done. Model weights (~200 MB) download from HuggingFace on first use."
