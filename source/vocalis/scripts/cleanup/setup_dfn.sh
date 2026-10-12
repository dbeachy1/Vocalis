#!/usr/bin/env bash
# =============================================================================
# Vocalis "Clean up" denoiser toolchain installer -- DeepFilterNet3
# =============================================================================
# Builds the isolated environment for scripts/cleanup/denoise_dfn.py.
#
# WHY ITS OWN VENV, AND WHY PYTHON 3.11:
#   * DeepFilterNet publishes wheels only up to cp311 -- a 3.12/3.13 venv has no wheel and
#     falls back to a source build that needs a Rust toolchain. So this venv is PINNED to
#     Python 3.11. That is the single most common install failure, hence the hard check below.
#   * The package does NOT declare torch as a dependency, so we install torch BY HAND, first.
#
# WHY CPU TORCH BY DEFAULT:
#   CPU torch keeps cleanup from competing with rendering or training for a GPU. Override
#   TORCH_INDEX/TORCH_SPEC to install a different build.
#
# Standalone use (re-install, or a box where the main setup already ran):
#     ./scripts/cleanup/setup_dfn.sh
#
# Knobs:
#     DFN_VENV            where it lands            (default: $HOME/dfn-venv)
#     VOCALIS_DFN_PYTHON  the 3.11 interpreter      (default: python3.11)
#     TORCH_INDEX         the wheel index           (default: the CPU index)
#     TORCH_SPEC          the torch pins            (default: torch torchaudio)
# =============================================================================
set -euo pipefail

DFN_VENV="${DFN_VENV:-$HOME/dfn-venv}"
PY_BOOT="${VOCALIS_DFN_PYTHON:-python3.11}"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cpu}"
TORCH_SPEC="${TORCH_SPEC:-torch torchaudio}"

echo ">> Vocalis Clean-up denoiser toolchain (DeepFilterNet3)"
echo "   venv:   $DFN_VENV"
echo "   python: $PY_BOOT"
echo "   index:  $TORCH_INDEX"

if [ -x "$DFN_VENV/bin/python" ]; then
    echo "[1/4] Virtual environment already exists, skipping."
else
    echo "[1/4] Creating the isolated venv (via $PY_BOOT) ..."
    if ! command -v "$PY_BOOT" >/dev/null 2>&1; then
        echo "ERROR: '$PY_BOOT' not found. DeepFilterNet's wheels stop at cp311, so this venv" >&2
        echo "       must be Python 3.11. Install it (e.g. 'apt install python3.11 python3.11-venv'" >&2
        echo "       or 'pyenv install 3.11') or set VOCALIS_DFN_PYTHON to a 3.11 interpreter." >&2
        exit 1
    fi
    # Refuse anything that isn't 3.11 up front, rather than let pip fall through to a source
    # build against a Rust toolchain the box probably doesn't have.
    PYVER="$("$PY_BOOT" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
    if [ "$PYVER" != "3.11" ]; then
        echo "ERROR: '$PY_BOOT' is Python $PYVER, but DeepFilterNet needs 3.11 (wheels stop at" >&2
        echo "       cp311). Point VOCALIS_DFN_PYTHON at a 3.11 interpreter." >&2
        exit 1
    fi
    "$PY_BOOT" -m venv "$DFN_VENV"
fi

PY="$DFN_VENV/bin/python"

# A venv is not guaranteed to have pip (uv venv omits it); bootstrap rather than fail obscurely.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
    echo "      (this venv has no pip — bootstrapping it)"
    "$PY" -m ensurepip --upgrade >/dev/null
fi
"$PY" -m pip install --upgrade pip --quiet

echo "[2/4] Installing torch (must come BEFORE deepfilternet, which doesn't declare it) ..."
# shellcheck disable=SC2086  # TORCH_SPEC is intentionally word-split into args
"$PY" -m pip install --quiet $TORCH_SPEC --index-url "$TORCH_INDEX"

echo "[3/4] Installing DeepFilterNet + soundfile ..."
"$PY" -m pip install --quiet deepfilternet soundfile

echo "[4/4] Verifying (imports df + loads the model once) ..."
"$PY" - <<'PYEOF'
import sys
try:
    import torch  # noqa: F401
    import soundfile  # noqa: F401
    from df.enhance import init_df
    model, df_state, _ = init_df()
    sr = int(df_state.sr())
    assert sr == 48000, f"unexpected model sample rate {sr}"
    print(f"   OK: DeepFilterNet3 loaded, sr={sr} Hz")
except Exception as e:
    print(f"ERROR: DeepFilterNet did not come up cleanly: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF

echo
echo ">> Done. The Clean up denoise pass runs on CPU (design §2.2), so it never competes with"
echo "   a render or a training for a GPU."
