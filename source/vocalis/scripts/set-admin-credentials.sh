#!/usr/bin/env bash
# Set the Vocalis admin username + password, then restart the service so the new
# credentials take effect. Thin launcher — the logic lives in set-admin-credentials.py
# (which writes only the scrypt password HASH to admin_credentials.yaml).
#
#   ./set-admin-credentials.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"      # scripts/ — this wrapper + the .py live here
ROOT="$(cd "$HERE/.." && pwd)"             # repo root — venv/ + admin_credentials.yaml live here
PY="$ROOT/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"

# Which unit to bounce. HERE/ROOT already derive from this script's location, so a second
# install writes ITS OWN admin_credentials.yaml correctly — but the unit name was hardcoded
# to `vocalis.service`, so running this from a second install restarted the FIRST one and
# left the second still holding the old credentials. Both halves wrong, silently.
# Same shape as VOCALIS_COMFYUI_SERVICE (vocalis_server.py:282): a name with an override.
SERVICE="${VOCALIS_SERVICE:-vocalis.service}"

# 1. Prompt + write the new credentials (aborts here on empty/mismatch).
"$PY" "$HERE/set-admin-credentials.py" "$@"

# 2. Restart Vocalis so it re-reads the credentials at startup (read once, at boot —
#    there is deliberately no live password-reload endpoint).
echo
echo "Restarting $SERVICE (systemctl --user) so the change takes effect..."
if systemctl --user restart "$SERVICE" 2>/dev/null; then
    echo "Done. $SERVICE restarted with the new admin credentials."
    echo "(Watch it come up: journalctl --user -u $SERVICE -f)"
else
    echo "Could not restart $SERVICE via 'systemctl --user'." >&2
    echo "Restart Vocalis however you run it so the new login takes effect." >&2
    echo "(Running a second install? Set VOCALIS_SERVICE to ITS unit name — e.g." >&2
    echo " VOCALIS_SERVICE=vocalis-encrypted.service ./scripts/set-admin-credentials.sh)" >&2
    exit 1
fi
