#!/usr/bin/env bash
# =============================================================================
# Vocalis "Clean up" TRIM scorer toolchain installer -- Silero VAD + PANNs tagger
# =============================================================================
# Builds the isolated environment for the trained signals used by scripts/cleanup/trim_scores.py.
# The energy-based trim path cannot detect all music and sound effects, so this child adds:
#
#   * Silero VAD  -- clean speech / non-speech boundaries (replaces the plain energy gate).
#   * PANNs CNN14 -- an AudioSet tagger, so a region can be vetoed as music/SFX even when its
#                    noise floor looks clean.
#
# The child that USES them is scripts/cleanup/trim_scores.py -- path in, scores JSON out,
# ONE-SHOT (loads, scores, exits; nothing stays resident). The in-process DSP + thresholding
# (trim_audio.py / cleanup.py) stays exactly where it is; only the torch inference lives here.
#
# WHY ITS OWN VENV:
#   The main Vocalis environment does not include torch. Silero and PANNs use torch, so this
#   child has its own environment, separate from the DeepFilterNet child.
#
# WHY CPU TORCH BY DEFAULT:
#   The Trim scorer runs ONCE per file at analyze time and CPU torch keeps it off the cards --
#   so a Clean up never claims a GPU out from under a render or a training, and there is never
#   a model left resident in VRAM (a one-shot on CPU has no VRAM to leak). Override
#   TORCH_INDEX/TORCH_SPEC if you truly want it on a card.
#
# Standalone use (re-install, or a box where the main setup already ran):
#     ./scripts/cleanup/setup_trim.sh
#
# Knobs:
#     TRIM_VENV            where it lands            (default: $HOME/trim-venv)
#     VOCALIS_TRIM_PYTHON  the interpreter to build  (default: python3.11)
#     TORCH_INDEX          the wheel index           (default: the CPU index)
#     TORCH_SPEC           the torch pins            (default: torch torchaudio)
# =============================================================================
set -euo pipefail

TRIM_VENV="${TRIM_VENV:-$HOME/trim-venv}"
PY_BOOT="${VOCALIS_TRIM_PYTHON:-python3.11}"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cpu}"
TORCH_SPEC="${TORCH_SPEC:-torch torchaudio}"

echo ">> Vocalis Clean-up TRIM scorer toolchain (Silero VAD + PANNs CNN14)"
echo "   venv:   $TRIM_VENV"
echo "   python: $PY_BOOT"
echo "   index:  $TORCH_INDEX"

if [ -x "$TRIM_VENV/bin/python" ]; then
    echo "[1/5] Virtual environment already exists, skipping."
else
    echo "[1/5] Creating the isolated venv (via $PY_BOOT) ..."
    if ! command -v "$PY_BOOT" >/dev/null 2>&1; then
        echo "ERROR: '$PY_BOOT' not found. Install it (e.g. 'apt install python3.11 python3.11-venv')" >&2
        echo "       or set VOCALIS_TRIM_PYTHON to a Python interpreter (3.10-3.12 recommended)." >&2
        exit 1
    fi
    "$PY_BOOT" -m venv "$TRIM_VENV"
fi

PY="$TRIM_VENV/bin/python"

# A venv is not guaranteed to have pip (uv venv omits it); bootstrap rather than fail obscurely.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
    echo "      (this venv has no pip — bootstrapping it)"
    "$PY" -m ensurepip --upgrade >/dev/null
fi
"$PY" -m pip install --upgrade pip --quiet

echo "[2/5] Installing torch (CPU) BEFORE the model packages, so the CPU wheel is pinned ..."
# shellcheck disable=SC2086  # TORCH_SPEC is intentionally word-split into args
"$PY" -m pip install --quiet $TORCH_SPEC --index-url "$TORCH_INDEX"

echo "[3/5] Installing Silero VAD ..."
"$PY" -m pip install --quiet silero-vad soundfile

echo "[4/5] Installing the PANNs tagger (pulls librosa/torchlibrosa) ..."
"$PY" -m pip install --quiet panns-inference

echo "[5/5] Verifying (loads Silero + downloads/loads the PANNs CNN14 checkpoint once) ..."
# Constructing AudioTagging fetches Cnn14_mAP=0.431.pth (~327 MB) to ~/panns_data on first run,
# so this step PRE-FETCHES the weights and fails loudly here rather than at the user's first click.
"$PY" - <<'PYEOF'
import sys
try:
    import torch  # noqa: F401
    import soundfile  # noqa: F401
    from silero_vad import load_silero_vad
    vad = load_silero_vad()
    from panns_inference import AudioTagging
    at = AudioTagging(checkpoint_path=None, device="cpu")   # downloads the checkpoint if absent
    print("   OK: Silero VAD + PANNs CNN14 loaded (CPU)")
except Exception as e:
    print(f"ERROR: the Trim scorer toolchain did not come up cleanly: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF

echo
echo ">> Done. The Trim scorer runs ONCE per file on CPU (design §2.3): it never competes with a"
echo "   render or a training for a GPU, and nothing stays resident when the child exits."
