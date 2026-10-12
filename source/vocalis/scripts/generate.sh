#!/usr/bin/env bash
# CLI single-file/inline generation. Mirror of generate.bat.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
exec "$DIR/venv/bin/python" src/generate.py "$@"
