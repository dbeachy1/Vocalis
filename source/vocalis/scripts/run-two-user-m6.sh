#!/usr/bin/env bash
# Run the two-user acceptance spec against a real SillyTavern instance. It requires two test
# accounts and two isolated Vocalis instances, so it runs separately from pytest.
#
# Set ST_BASE or pass the SillyTavern base URL explicitly. Also set ST_TEST_USER_A / ST_TEST_PASS_A
# for an admin account and ST_TEST_USER_B / ST_TEST_PASS_B for a non-admin account, then run:
#   scripts/run-two-user-m6.sh [st-base] [chrome-path]
#
# Defaults: the ST base URL and Chrome executable can be overridden on the command line.
# Exit 0 means every acceptance claim passed.
set -uo pipefail

ST_BASE="${1:-${ST_BASE:-}}"
if [ -z "$ST_BASE" ]; then
    echo "refusing to start: pass the SillyTavern base URL or set ST_BASE." >&2
    exit 2
fi
CHROME="${2:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${VOCALIS_PYTHON:-$REPO/venv/Scripts/python.exe}"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"

for v in ST_TEST_USER_A ST_TEST_PASS_A ST_TEST_USER_B ST_TEST_PASS_B; do
    if [ -z "${!v:-}" ]; then
        echo "refusing to start: $v is not set — see the header of st_two_user_m6_spec.mjs." >&2
        echo "A default here would be a credential in git by another name." >&2
        exit 2
    fi
done

PORT_A="${M6_PORT_A:-7898}"
PORT_B="${M6_PORT_B:-7897}"
WORK="$(mktemp -d 2>/dev/null || mktemp -d -t m6)"
PIDS=()

cleanup() {
    # Stop only the two process IDs started by this script; never target processes by image name.
    for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
    sleep 1
    for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done

    # A belt-and-braces sweep for anything still listening on OUR two ports, because a leaked
    # Vocalis is not merely litter — it holds the port, so the NEXT run's instance fails to bind
    # and every claim goes red for a reason that names none of this.
    #
    # Match the server command and one of this run's ports so cleanup cannot target unrelated
    # Python processes.
    local stray
    stray="$(ps -W 2>/dev/null | grep -E "vocalis_server\.py --port ($PORT_A|$PORT_B)" \
             | awk '{print $1}' || true)"
    for p in $stray; do kill -9 "$p" 2>/dev/null; done
    # ⚠️ WINDOWS KEEPS THE HANDLE OPEN FOR A MOMENT AFTER THE PROCESS DIES, so an immediate
    # `rm -rf` fails on `logs/vocalis.log` with "Device or resource busy" and leaves the whole
    # tree behind. Retry briefly, then give up quietly — a leaked temp dir is litter, and a
    # cleanup that shouts is a cleanup that gets read as a failed run.
    for _ in 1 2 3 4 5; do
        rm -rf "$WORK" 2>/dev/null && break
        sleep 1
    done
}
trap cleanup EXIT

echo "==> building two isolated Vocalis trees in $WORK"
# Copy each instance to a separate temporary root. `paths.BASE_DIR` is derived from `__file__`,
# so the isolated roots keep settings, pairing tokens, and output away from the source install.
# Include `satellite/` because `vocalis_streaming` imports `vocalis_stream_core` from that tree.
for inst in vocA vocB; do
    mkdir -p "$WORK/$inst"
    cp -r "$REPO/src" "$WORK/$inst/"
    cp -r "$REPO/satellite" "$WORK/$inst/"
    mkdir -p "$WORK/$inst/voice_samples"
done

echo "==> writing admin credentials (auth ON — the gates under test are no-ops without it)"
"$PY" - "$WORK" <<'PY'
import sys, yaml
from pathlib import Path
from werkzeug.security import generate_password_hash
work = Path(sys.argv[1])
for inst in ("vocA", "vocB"):
    (work / inst / "admin_credentials.yaml").write_text(
        yaml.safe_dump({"username": "admin",
                        "password_hash": generate_password_hash("welcome")},
                       sort_keys=False), encoding="utf-8")
PY

echo "==> minting a synthetic TestVoice (constructed, never copied from a real voice library)"
"$PY" - "$WORK" <<'PY'
import sys, wave, math, struct
from pathlib import Path
work = Path(sys.argv[1])
sr, freq = 22050, 220.0
frames = b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / sr)))
                  for i in range(sr))
for inst in ("vocA", "vocB"):
    with wave.open(str(work / inst / "voice_samples" / "TestVoice.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(frames)
PY

start_one() {           # $1 = instance dir, $2 = port
    # `exec` makes `$!` identify the server process rather than the subshell, allowing cleanup to
    # stop the process it started. Set `VOCALIS_CACHE_DIR` because cache_root() otherwise uses the
    # OS cache directory outside the isolated instance root.
    ( cd "$WORK/$1" && VOCALIS_CACHE_DIR="$WORK/$1/cache" \
        exec "$PY" src/vocalis_server.py --port "$2" > "$WORK/$1.log" 2>&1 ) &
    PIDS+=("$!")
}
echo "==> starting Vocalis on $PORT_A and $PORT_B"
start_one vocA "$PORT_A"
start_one vocB "$PORT_B"

wait_up() {             # $1 = port
    for _ in $(seq 1 40); do
        if curl -sf --max-time 3 "http://127.0.0.1:$1/health" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    echo "instance on $1 never answered /health — see $WORK/*.log" >&2
    return 1
}
wait_up "$PORT_A" || exit 1
wait_up "$PORT_B" || exit 1

mint() {                # $1 = port -> prints the pairing token
    local jar="$WORK/cookies_$1.txt"
    curl -s -o /dev/null -c "$jar" --max-time 10 -X POST "http://127.0.0.1:$1/login" \
        -H "Content-Type: application/json" -d '{"username":"admin","password":"welcome"}'
    curl -s -b "$jar" --max-time 10 -X POST "http://127.0.0.1:$1/wbedit/pairing/rotate" \
        -H "Content-Type: application/json" -d '{}' \
        | "$PY" -c "import sys,json; print(json.load(sys.stdin)['token'])"
}
echo "==> pairing"
TOKEN_A="$(mint "$PORT_A")"
TOKEN_B="$(mint "$PORT_B")"
if [ -z "$TOKEN_A" ] || [ -z "$TOKEN_B" ]; then
    echo "could not mint a pairing token — see $WORK/*.log" >&2
    exit 1
fi

# A fixture self-check, because every one of the nine false failures above would have been caught
# by these three lines: own token accepted, other's refused, anonymous refused.
echo "==> checking the fixture before trusting the run"
own=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -H "Authorization: Bearer $TOKEN_A" "http://127.0.0.1:$PORT_A/v1/audio/voices")
cross=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -H "Authorization: Bearer $TOKEN_A" "http://127.0.0.1:$PORT_B/v1/audio/voices")
anon=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:$PORT_A/v1/audio/voices")
if [ "$own" != "200" ] || [ "$cross" != "401" ] || [ "$anon" != "401" ]; then
    echo "FIXTURE IS WRONG (own=$own want 200, cross=$cross want 401, anon=$anon want 401)." >&2
    echo "Do not read the spec's output as product failures until this line is clean." >&2
    exit 1
fi
echo "    own=200 cross=401 anon=401 — the gates are live"

echo "==> running the spec"
node "$REPO/tests/st_two_user_m6_spec.mjs" "$ST_BASE" "$CHROME" \
     "http://127.0.0.1:$PORT_A" "$TOKEN_A" \
     "http://127.0.0.1:$PORT_B" "$TOKEN_B"
rc=$?
echo "==> spec exit $rc"
exit $rc
