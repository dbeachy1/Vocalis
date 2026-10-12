#!/usr/bin/env bash
# Book -> audiobook pipeline. Mirror of book_to_audio.bat.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
exec "$DIR/venv/bin/python" src/book_to_audio.py "$@"
