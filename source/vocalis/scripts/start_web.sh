#!/usr/bin/env bash
# Start the web server in the foreground for local development and smoke tests. Managed
# installations should use their service manager so restart policy and process ownership remain
# consistent.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
echo "===================================="
echo " Vocalis — Book / Playground Web UI"
echo "===================================="
echo
# The server resolves TLS settings from flags, environment, and app_settings.yaml, then prints
# the resulting URL.
echo "Press Ctrl+C to stop the server. The URL is printed below once TLS is resolved."
echo
# vocalis.py, not src/vocalis_server.py: launching the module directly makes it __main__, so
# `vocalis_server` is absent from sys.modules and any import of it re-executes the whole file
# under a second name — a second vault_store.configure(), and a locked vault behind an
# /health that says otherwise. See 5.1-refactor §2.1.
exec "$DIR/venv/bin/python" vocalis.py "$@"
