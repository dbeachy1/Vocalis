#!/usr/bin/env bash
# =============================================================================
# voiceswap.sh -- ACE-Step song -> voice-swapped track (ROCm)
# =============================================================================
# You make the song in ACE-Step's Gradio UI as usual. This script handles
# everything AFTER you have the finished mixed audio file:
#
#   input song ──► Demucs 2-stem ──► vocals.wav ──► RVC voice swap ──► swapped
#                       │                                                  │
#                       └──► no_vocals.wav (instrumental) ────────────────┤
#                                                                          ▼
#                                              ffmpeg remux ──► finished track
#
# ACE-Step's own `extract` is NOT used (it needs the xl-base model and isolates
# one instrument at a time). Demucs gives a clean vocal/instrumental split in
# one pass, which is what a remix wants -- so you can keep running xl-sft.
#
# Prereqs: ./setup.sh has been run, and you have an RVC target-voice model (.pth).
# =============================================================================
set -euo pipefail

# Default lives in $HOME, not /ai-models (that tree is treated as disposable).
# Vocalis and the shell both point here via the VOICESWAP_VENV env var.
VOICESWAP_VENV="${VOICESWAP_VENV:-$HOME/voiceswap-venv}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$VOICESWAP_VENV/bin/python"

# ---- defaults ---------------------------------------------------------------
DEMUCS_MODEL="htdemucs"   # htdemucs = default 4-source model; --two-stems collapses to vocals/no_vocals
PITCH=0                   # semitones for the voice swap (e.g. +12 to shift up an octave)
INDEX_RATE=0.5
RVC_INDEX=""
DEVICE="cuda:0"           # first R9700 under ROCm; use cuda:1 for the second card
WORKDIR=""
OUTPUT=""
KEEP_STEMS=0
VOCAL_GAIN="1.0"          # linear gain applied to the swapped vocal at remux
BACKING_GAIN="1.0"        # linear gain applied to the instrumental at remux

usage() {
  cat <<EOF
Usage: voiceswap.sh -i SONG -m RVC_MODEL.pth -o OUTPUT.wav [options]

Required:
  -i, --input FILE       Finished song (any ffmpeg-readable audio).
  -m, --model FILE       RVC target-voice model (.pth).
  -o, --output FILE      Output track (.wav recommended).

Options:
  --index FILE           RVC feature .index file (improves timbre match).
  --pitch N              f0 transpose in semitones (default 0).
  --index-rate F         0..1 adherence to target timbre (default $INDEX_RATE).
  --device DEV           Torch device: cuda:0 (default) or cuda:1.
  --demucs-model NAME    Demucs model (default $DEMUCS_MODEL).
  --vocal-gain F         Linear gain on swapped vocal at remux (default $VOCAL_GAIN).
  --backing-gain F       Linear gain on instrumental at remux (default $BACKING_GAIN).
  --workdir DIR          Where stems go (default: alongside output).
  --keep-stems           Keep intermediate stems instead of deleting them.
  -h, --help             This help.

Example:
  ./voiceswap.sh -i ~/song.wav -m /ai-models/rvc/alice.pth \\
      --index /ai-models/rvc/alice.index --pitch 0 -o ~/song_alice.wav
EOF
}

# ---- arg parsing ------------------------------------------------------------
INPUT=""; RVC_MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    -i|--input)        INPUT="$2"; shift 2 ;;
    -m|--model)        RVC_MODEL="$2"; shift 2 ;;
    -o|--output)       OUTPUT="$2"; shift 2 ;;
    --index)           RVC_INDEX="$2"; shift 2 ;;
    --pitch)           PITCH="$2"; shift 2 ;;
    --index-rate)      INDEX_RATE="$2"; shift 2 ;;
    --device)          DEVICE="$2"; shift 2 ;;
    --demucs-model)    DEMUCS_MODEL="$2"; shift 2 ;;
    --vocal-gain)      VOCAL_GAIN="$2"; shift 2 ;;
    --backing-gain)    BACKING_GAIN="$2"; shift 2 ;;
    --workdir)         WORKDIR="$2"; shift 2 ;;
    --keep-stems)      KEEP_STEMS=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "!! Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

# ---- validation -------------------------------------------------------------
die() { echo "!! $*" >&2; exit 1; }
[ -n "$INPUT" ]     || { usage; die "missing -i/--input"; }
[ -n "$RVC_MODEL" ] || { usage; die "missing -m/--model"; }
[ -n "$OUTPUT" ]    || { usage; die "missing -o/--output"; }
[ -f "$INPUT" ]     || die "input not found: $INPUT"
[ -f "$RVC_MODEL" ] || die "RVC model not found: $RVC_MODEL"
[ -x "$PY" ]        || die "venv python not found at $PY -- run scripts/voiceswap/setup.sh first"
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not on PATH"
[ -z "$RVC_INDEX" ] || [ -f "$RVC_INDEX" ] || die "RVC index not found: $RVC_INDEX"

# workdir defaults next to the output file
if [ -z "$WORKDIR" ]; then
  WORKDIR="$(dirname "$OUTPUT")/voiceswap_work"
fi
mkdir -p "$WORKDIR"

base="$(basename "${INPUT%.*}")"

echo "== voiceswap =="
echo "   input:   $INPUT"
echo "   model:   $RVC_MODEL"
echo "   output:  $OUTPUT"
echo "   device:  $DEVICE   pitch: $PITCH   index-rate: $INDEX_RATE"
echo "   workdir: $WORKDIR"
echo

# ---- step 1: Demucs 2-stem split -------------------------------------------
echo ">> [1/3] Demucs: splitting vocals / instrumental ($DEMUCS_MODEL)"
"$PY" -m demucs --two-stems=vocals -n "$DEMUCS_MODEL" -o "$WORKDIR" "$INPUT"
VOCALS="$WORKDIR/$DEMUCS_MODEL/$base/vocals.wav"
BACKING="$WORKDIR/$DEMUCS_MODEL/$base/no_vocals.wav"
[ -f "$VOCALS" ]  || die "expected vocals stem not produced: $VOCALS"
[ -f "$BACKING" ] || die "expected instrumental stem not produced: $BACKING"

# ---- step 2: RVC voice conversion on the vocal stem ------------------------
echo ">> [2/3] RVC: converting the vocal to the target voice"
SWAPPED="$WORKDIR/${base}_vocals_swapped.wav"
"$PY" "$SCRIPT_DIR/rvc_infer.py" \
  -i "$VOCALS" -o "$SWAPPED" -m "$RVC_MODEL" \
  ${RVC_INDEX:+--index "$RVC_INDEX"} \
  --pitch "$PITCH" --index-rate "$INDEX_RATE" --device "$DEVICE"
[ -f "$SWAPPED" ] || die "RVC did not produce output: $SWAPPED"

# ---- step 3: remux swapped vocal over the instrumental ---------------------
echo ">> [3/3] ffmpeg: remixing swapped vocal over instrumental"
# normalize=0 keeps original levels (default amix attenuates each input by 1/N).
ffmpeg -y -hide_banner -loglevel warning \
  -i "$SWAPPED" -i "$BACKING" \
  -filter_complex \
    "[0:a]volume=${VOCAL_GAIN}[v];[1:a]volume=${BACKING_GAIN}[b];[v][b]amix=inputs=2:duration=longest:normalize=0[out]" \
  -map "[out]" -c:a pcm_s16le "$OUTPUT"

echo
echo ">> Done: $OUTPUT"
if [ "$KEEP_STEMS" -eq 0 ]; then
  rm -rf "$WORKDIR"
  echo "   (intermediate stems removed; pass --keep-stems to keep them)"
else
  echo "   stems kept in: $WORKDIR"
fi
