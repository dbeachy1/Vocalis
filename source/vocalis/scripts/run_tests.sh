#!/usr/bin/env bash
# Run the Vocalis test suite. Mirror of run_tests.bat.
#
# Usage:
#   ./run_tests.sh              -- fast unit tests only (chunker, docx parsing)
#   ./run_tests.sh --gpu        -- also runs GPU integration tests (loads TTS model)
#   ./run_tests.sh -k chunker   -- run only tests matching "chunker"
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# The venv layout differs by platform: POSIX puts the interpreter in bin/, Windows in
# Scripts/. Check both, because this script has to run under Git Bash on the dev box too
# -- the suite must be driven from bash there (a PowerShell run silently collects nothing
# for the tests that shell out to setup.sh, which reads as a pass, not as a skip).
if   [ -x "$DIR/venv/bin/python" ];         then PY="$DIR/venv/bin/python"
elif [ -x "$DIR/venv/Scripts/python.exe" ]; then PY="$DIR/venv/Scripts/python.exe"
else
  echo "No venv interpreter found (looked in venv/bin and venv/Scripts). Create one first." >&2
  exit 1
fi
exec "$PY" -m pytest tests/ -v "$@"
