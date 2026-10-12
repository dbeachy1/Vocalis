#!/usr/bin/env bash
# Install the isolated VoxCPM2 environment used by scripts/voxcpm/worker.py. The worker runs as
# a child process so Vocalis keeps the model's dependencies and GPU memory outside its main
# runtime.
#
# The PyPI package version is not the VoxCPM2 implementation. Build from the upstream repository
# with build isolation disabled; setuptools_scm needs an explicit version for shallow clones.
#
# The default configuration uses ROCm and one GPU. Set TORCH_INDEX and TORCH_SPEC for another
# backend, or use setup_voxcpm.bat for the Windows CUDA configuration. No CPU build is provided.
#
# Usage: ./scripts/voxcpm/setup_voxcpm.sh
# VOXCPM_VENV selects the environment; VOCALIS_VOXCPM_PYTHON selects Python 3.12.
# TORCH_INDEX / TORCH_SPEC override the package source and pins; VOXCPM_REF selects the source ref.
# =============================================================================
set -euo pipefail

VOXCPM_VENV="${VOXCPM_VENV:-$HOME/voxcpm-venv}"
PY_BOOT="${VOCALIS_VOXCPM_PYTHON:-python3.12}"
TORCH_INDEX="${TORCH_INDEX:-https://download-r2.pytorch.org/whl/rocm7.2}"
TORCH_SPEC="${TORCH_SPEC:-torch==2.13.0+rocm7.2 torchaudio==2.11.0+rocm7.2}"
VOXCPM_REF="${VOXCPM_REF:-main}"
VOXCPM_REPO="https://github.com/OpenBMB/VoxCPM"

echo ">> Vocalis Create-a-voice toolchain (VoxCPM2)"
echo "   venv:   $VOXCPM_VENV"
echo "   torch:  $TORCH_SPEC"
echo "   ref:    $VOXCPM_REF"

if [ -x "$VOXCPM_VENV/bin/python" ]; then
    echo "[1/5] Virtual environment already exists, skipping."
else
    echo "[1/5] Creating the isolated venv (Python 3.12) ..."
    # The ROCm wheels target CPython 3.12. Prefer uv so it can provision that version when the
    # system interpreter differs.
    if command -v uv >/dev/null 2>&1; then
        uv venv --python 3.12 "$VOXCPM_VENV"
    elif command -v "$PY_BOOT" >/dev/null 2>&1; then
        PYVER="$("$PY_BOOT" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
        if [ "$PYVER" != "3.12" ]; then
            echo "ERROR: '$PY_BOOT' is Python $PYVER, but the pinned ROCm wheels are cp312." >&2
            echo "       Point VOCALIS_VOXCPM_PYTHON at a 3.12 interpreter, or install uv." >&2
            exit 1
        fi
        "$PY_BOOT" -m venv "$VOXCPM_VENV"
    else
        echo "ERROR: no 'uv' and no '$PY_BOOT'. Install uv (https://astral.sh/uv) or a" >&2
        echo "       Python 3.12, then re-run." >&2
        exit 1
    fi
fi

PY="$VOXCPM_VENV/bin/python"

# A venv is not guaranteed to have pip (uv venv omits it); bootstrap rather than fail obscurely.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
    echo "      (this venv has no pip — bootstrapping it)"
    "$PY" -m ensurepip --upgrade >/dev/null
fi
"$PY" -m pip install --upgrade pip --quiet

echo "[2/5] Installing torch (the POC-proven ROCm pins) ..."
# shellcheck disable=SC2086  # TORCH_SPEC is intentionally word-split into args
"$PY" -m pip install --quiet $TORCH_SPEC --index-url "$TORCH_INDEX"

echo "[3/5] Installing the build toolchain (voxcpm builds --no-build-isolation) ..."
"$PY" -m pip install --quiet "setuptools>=77" wheel "setuptools_scm>=8" "packaging>=24.2"

echo "[4/5] Building voxcpm from the repo ($VOXCPM_REF) ..."
CLONE="$(mktemp -d)"
trap 'rm -rf "$CLONE"' EXIT
git clone --depth 1 --branch "$VOXCPM_REF" "$VOXCPM_REPO" "$CLONE/VoxCPM" 2>/dev/null \
    || { git clone "$VOXCPM_REPO" "$CLONE/VoxCPM" && git -C "$CLONE/VoxCPM" checkout "$VOXCPM_REF"; }
# A shallow clone has no tags for setuptools_scm to read — tell it the version.
SETUPTOOLS_SCM_PRETEND_VERSION="${SETUPTOOLS_SCM_PRETEND_VERSION:-2.0.0}" \
    "$PY" -m pip install --quiet --no-build-isolation "$CLONE/VoxCPM"
"$PY" -m pip install --quiet soundfile   # the worker writes its clips with soundfile

echo "[5/5] Verifying (imports only — the ~2 GB model downloads on first load) ..."
"$PY" - <<'PYEOF'
import sys
try:
    import importlib.metadata as md
    import torch  # noqa: F401
    import soundfile  # noqa: F401
    import voxcpm  # noqa: F401
    v = md.version("voxcpm")
    major = int(v.split(".")[0])
    # VoxCPM2 requires the v2 package line and its local snapshot loader.
    assert major >= 2, f"voxcpm {v} installed — that is the v1 line; the build did not take"
    print(f"   OK: voxcpm {v}, torch {torch.__version__}")
except Exception as e:
    print(f"ERROR: the VoxCPM2 toolchain did not come up cleanly: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF

echo
echo ">> Done. Vocalis finds this venv at \$HOME/voxcpm-venv (override: voxcpm.venv in"
echo "   app_settings.yaml, or VOCALIS_VOXCPM_VENV). Weights cache under HF_HOME."
