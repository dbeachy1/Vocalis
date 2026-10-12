#!/usr/bin/env bash
# Vocalis render satellite: one command for Linux (design section 9, "Satellite package: one command per
# operating system", added October 10, 2026). This is ONE self-contained file: a user downloads it alone and runs
# it on the second machine. It needs Docker and nothing else from the repository; it never uses sudo and never
# changes a firewall. Everything with rules in it (reading the secret, the certificate, the configuration file and
# the model download) is done inside one-shot containers by the provisioning tool in the image
# (/opt/vocalis/satellite-admin/satellite_admin.py), so this script and satellite-setup.ps1 cannot drift apart.
#
# October 11, 2026 (design section 9, "Satellite setup program and tray icon for Windows, and quieter setup output",
# and "Linux: Docker is the daemon, and one command controls it"): quiet output by default and --verbose, a setup log
# for every run, setup-result.txt, --autostart on|off, the recorded certificate fingerprint, --show-plan, the kept copy
# of this script and the `vocalis-satellite` command that setup installs in ~/.local/bin.
#
# October 11, 2026 (same rules in satellite-setup.ps1): a satellite folder is FINISHED only when
# satellite.env, the secret, the certificate (cert.pem and key.pem) AND the configuration file (data/satellite.yaml)
# all exist; --show-plan's SETUP_FINISHED, the --update refusal and the adoption below all use that one definition
# (MODE=first in the result file stays "a secret or certificate still to be made", as the design words it). On a folder that is not finished, a plain run (no --update) given an --image other than the recorded one
# adopts that image, records it in satellite.env and carries on as the resumed first setup, because nothing ever ran
# from the recorded one; --update is still refused there. On a finished folder a different --image still needs --update.
# The same holds without --image when this copy of the script carries a stamped default image that differs from the
# recorded one: the stamped default is adopted (a finished folder instead gets the "newer image ... --update" note).
set -euo pipefail
umask 077

# Stamped by the release step (packaging/satellite/stamp_release.py), which fills these two lines in the copies it
# puts under artifacts/satellite/<commit>/. The copy in the repository carries no default and requires --image.
# Keep each marker as the single line KEY="" exactly; the stamp step refuses a missing or repeated marker.
DEFAULT_IMAGE_CUDA=""
DEFAULT_IMAGE_ROCM=""

# The pieces of the run specification (design section 9, "Run specification") that more than one place uses.
ADMIN_TOOL=/opt/vocalis/satellite-admin/satellite_admin.py
LISTEN_WAIT_SECONDS=180
LISTEN_POLL_SECONDS=2
# Where the AMD device nodes are looked for. A seam for the contract tests only; on a real machine it is /dev.
DEV_ROOT=${SATELLITE_DEV_ROOT:-/dev}

usage() {
  cat <<'EOF'
Usage:
  satellite-setup.sh [--root PATH] [--variant cuda|rocm] [--image REF] [--port N] [--name NAME]
                     [--address VALUE]... [--secret-file PATH] [--autostart on|off] [--verbose]
  satellite-setup.sh --update [--image REF] [--root PATH]
  satellite-setup.sh --new-secret [--secret-file PATH] [--root PATH]
  satellite-setup.sh --new-certificate [--address VALUE]... [--root PATH]
  satellite-setup.sh --autostart on|off [--root PATH]
  satellite-setup.sh --remove [--root PATH]
  satellite-setup.sh --show-plan [--root PATH] [--port N] [--name NAME] [--address VALUE]...

Run it as your own user (it never needs sudo). The first run sets the satellite up; running the same command
again repairs it or starts it, and keeps its secret, certificate and settings.

The output is short by default. Everything it did, the hidden lines included, is written to
<folder>/logs/setup-<UTC date and time>-<process id>.log (the last ten are kept), and the outcome of the run to
<folder>/setup-result.txt (KEY=VALUE lines). A successful setup also installs the command vocalis-satellite
(~/.local/bin) to start, stop and follow the satellite; see "After setup" below.

  --root PATH         The satellite folder (default ~/.local/share/vocalis/satellite). It must be empty or
                      already a satellite folder; anything else is refused and left alone.
  --variant cuda|rocm Your GPU type; detected when only one kind is present.
  --image REF         The satellite image, name@sha256:<64 hex digits>. Optional when the copy of this script
                      you downloaded already names one. A finished satellite keeps its image (changing it needs
                      --update); one whose setup never finished (no secret, certificate or configuration yet)
                      takes the image given here, or without --image the one this copy of the script names,
                      and records it.
  --port N            The port the satellite listens on (default 7880). Fixed once the folder exists.
  --name NAME         A label for the satellite's log lines (default: this computer's name in lower case).
  --address VALUE     Repeatable. An IPv4 address of this computer to put in the certificate besides the ones
                      found automatically, or a name (recorded for information only).
  --secret-file PATH  Read the secret Vocalis showed you from this file instead of asking for it. Create the
                      file in a text editor, not with echo (the shell would keep the secret in its history).
  --update            Move to a newer image: the one given with --image or, without it, the one this copy of the
                      script names (the setup file of a newer release does). It pulls the image, fetches its
                      model files, then replaces the container; nothing has to be paired again. A copy that
                      names no image needs --image. If the satellite already runs that image, this is a
                      plain run. A plain run without --image keeps the image the satellite runs, and says so
                      when this setup file names a newer one. It needs a finished satellite (secret,
                      certificate and configuration all present); one whose setup never finished is finished
                      by running the command without --update.
  --new-secret        Replace the secret (after "New secret..." in Vocalis) and restart the satellite.
  --new-certificate   Replace the certificate and restart the satellite. Vocalis needs the new file.
  --autostart on|off  Start with Docker. on (the default): after the computer or Docker restarts, a satellite that
                      was running comes back; one you stopped stays stopped until you start it. off: it stays
                      down until you start it, and it is also not restarted if it crashes. The value is kept in
                      satellite.env. On its own, on a satellite folder that exists, this only changes the
                      setting (one "docker update --restart"): no pull, no model check, no restart. It needs
                      Docker to answer. Given with another operation, that operation applies it.
  --verbose           Print everything: the in-image tool's INFO lines, the left-out details. The log always
                      has all of it.
  --remove            Remove the container only. The folder, with the secret, the certificate and the model
                      files, is left where it is.
  --show-plan         Print what a setup here would use, as KEY=VALUE lines (SATELLITE, SATELLITE_ID, NAME, PORT,
                      CONTAINER, AUTOSTART, IMAGE, ADDRESSES, NEEDS_SECRET, NEEDS_CERTIFICATE, SETUP_FINISHED,
                      CERTIFICATE_FILE, FINGERPRINT). SETUP_FINISHED is yes only when satellite.env, the secret,
                      the certificate and the configuration file (data/satellite.yaml) all exist. It makes no
                      Docker call and writes no log, no result file and no folder. May be combined only with
                      --root, --port, --name and --address.
  --help              This text.

After setup: the command vocalis-satellite (installed in ~/.local/bin; setup never edits PATH or a shell start
file) controls the satellite. Docker is the daemon: it starts the satellite at boot when --autostart is on and
the satellite had not been stopped.
  vocalis-satellite start | stop | restart | status
  vocalis-satellite logs [-n N] [--no-follow]
  vocalis-satellite autostart on|off
  vocalis-satellite certificate [--pem]
  vocalis-satellite help
Setup keeps a copy of this script at <folder>/satellite-setup.sh and the command uses that copy.

Network: the satellite port (default 7880) is open on every address of this computer, because being called from
another machine is its whole purpose. Docker opens a port it publishes even when a firewall such as ufw is turned
on; to limit who can reach it, add a rule to Docker's DOCKER-USER chain. Run a satellite only on a network you
trust, and never forward its port from the internet. This script never changes a firewall.

Image references must end in @sha256:<64 hex digits>.
EOF
}

# ---------------------------------------------------------------------------------------------------------------
# Output, log and result (design section 9, "Satellite setup program and tray icon for Windows, and quieter setup
# output", added October 11, 2026, script changes 1 to 4)
# ---------------------------------------------------------------------------------------------------------------
# Quiet by default: each step prints its header and a line or two. Everything, the hidden lines included, is also
# written to <root>/logs/setup-<UTC yyyymmdd-hhmmss>-<pid>.log once satellite.env has been read and accepted (or has
# just been created); lines produced before that are held in memory and written when the log opens, and a refusal
# before that point writes no log. outf prints on standard output and logs, errf prints on standard error and logs,
# logf only logs. A log that cannot be opened or written gives one warning and never fails the run.
VERBOSE=0
LOG_FILE=""
LOG_PENDING=()
LOG_STATE=pending   # pending (not opened yet), open, or off (could not be opened or written)
RESULT_ARMED=0
FAIL_REASON=""
TMP_FILES=()
STEP_COUNT=8

log_text() {
  local text=$1
  [[ "$text" == *$'\n' ]] || text+=$'\n'
  case "$LOG_STATE" in
    open)
      if ! { printf '%s' "$text" >> "$LOG_FILE"; } 2>/dev/null; then
        printf 'WARNING: the setup log %s cannot be written; carrying on without a log.\n' "$LOG_FILE" >&2
        LOG_FILE=""
        LOG_STATE=off
      fi
      ;;
    pending) LOG_PENDING+=("$text") ;;
  esac
}
outf() { local text; printf -v text "$@"; printf '%s' "$text"; log_text "$text"; }
errf() { local text; printf -v text "$@"; printf '%s' "$text" >&2; log_text "$text"; }
logf() { local text; printf -v text "$@"; log_text "$text"; }

# Every failure is one ERROR: line (never a shell error record) followed, once the log is open, by the log's path.
# The reason is kept for setup-result.txt.
fail() {
  FAIL_REASON=$*
  errf 'ERROR: %s\n' "$*"
  if [[ -n "$LOG_FILE" ]]; then errf 'Log: %s\n' "$LOG_FILE"; fi
  exit 1
}

# Step headers, numbered 1 to STEP_COUNT with no gaps (the setup program shows the latest header as its page title).
step() { outf '\n[%d/%d] %s\n' "$1" "$STEP_COUNT" "$2"; }

ROOT_ARG=""
VARIANT_ARG=""
IMAGE_ARG=""
PORT_ARG=""
NAME_ARG=""
SECRET_FILE_ARG=""
ADDRESS_ARGS=()
AUTOSTART_ARG=""
UPDATE=0
NEW_SECRET=0
NEW_CERT=0
REMOVE=0
SHOW_PLAN=0
# The temporary copy satellite.env is written through; removed on every exit, including Ctrl-C (INT/TERM/HUP go
# through exit so the EXIT trap runs for them, as in setup.sh).
ENV_TMP=""
# The EXIT trap: removes the temporary files, then (once satellite.env has been accepted) writes setup-result.txt for
# the outcome, success or failure. A run that is killed outright leaves no result file at all, because the file is
# deleted as soon as satellite.env is accepted; it is never the previous run's.
cleanup() {
  local rc=$? file
  trap - EXIT
  [[ -z "$ENV_TMP" ]] || rm -f -- "$ENV_TMP"
  for file in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do rm -f -- "$file"; done
  if [[ "$RESULT_ARMED" == 1 ]]; then write_result "$rc" || true; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# For the first lines of the setup log. Never holds a secret: the secret is typed at a prompt or read from a file
# whose path is all that is given here.
ORIGINAL_ARGS=("$@")

while (($#)); do
  case "$1" in
    --root) (($# >= 2)) || fail "--root requires a path"; ROOT_ARG=$2; shift 2 ;;
    --variant) (($# >= 2)) || fail "--variant requires cuda or rocm"; VARIANT_ARG=$2; shift 2 ;;
    --image) (($# >= 2)) || fail "--image requires a digest reference"; IMAGE_ARG=$2; shift 2 ;;
    --port) (($# >= 2)) || fail "--port requires a port"; PORT_ARG=$2; shift 2 ;;
    --name) (($# >= 2)) || fail "--name requires a name"; NAME_ARG=$2; shift 2 ;;
    --address) (($# >= 2)) || fail "--address requires an IPv4 address or a name"; ADDRESS_ARGS+=("$2"); shift 2 ;;
    --secret-file) (($# >= 2)) || fail "--secret-file requires a path"; SECRET_FILE_ARG=$2; shift 2 ;;
    --autostart) (($# >= 2)) || fail "--autostart requires on or off"; AUTOSTART_ARG=$2; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    --update) UPDATE=1; shift ;;
    --new-secret) NEW_SECRET=1; shift ;;
    --new-certificate) NEW_CERT=1; shift ;;
    --remove) REMOVE=1; shift ;;
    --show-plan) SHOW_PLAN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------------------

# The same rule as validate_digest_ref in packaging/setup.sh.
validate_digest_ref() {
  [[ "$1" =~ ^[^[:space:]]+@sha256:[a-fA-F0-9]{64}$ ]] || fail "Image references must end in @sha256:<64 hex digits>."
}

# A path that goes into a --mount argument may not contain a line break or an apostrophe (setup.sh's rule) or a
# comma, which separates the fields of --mount.
check_path_chars() {
  local what=$1 value=$2
  case "$value" in
    *$'\n'*|*"'"*) fail "$what cannot contain a line break or an apostrophe." ;;
    *,*) fail "$what cannot contain a comma (it separates the fields of the Docker --mount argument)." ;;
  esac
}

# Four decimal octets, 0 through 255, no leading zeros (010 is refused: some tools read it as octal).
is_ipv4() {
  local octet
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for octet in "${BASH_REMATCH[@]:1}"; do
    [[ "$octet" == 0 || "$octet" != 0* ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
  return 0
}

# An IPv4 address a remote Vocalis could use to reach this computer: not in 0.0.0.0/8 ("this network", 0.0.0.0
# included), loopback (127.x), link-local (169.254.x), or 224.0.0.0 and above (multicast 224-239, reserved 240-254 and
# the broadcast address 255.255.255.255), as the Windows script refuses them. Assumes is_ipv4 already passed.
is_usable_ipv4() {
  local a b c d
  IFS=. read -r a b c d <<< "$1"
  ((a == 0 || a == 127 || (a == 169 && b == 254) || a >= 224)) && return 1
  return 0
}

# Dot-separated labels of letters, digits and hyphens, each 1 to 63 characters and not starting or ending with a
# hyphen, 253 characters at most in all, and not "localhost" (the certificate holds that name already).
is_dns_name() {
  local name=$1 label
  local -a labels
  ((${#name} >= 1 && ${#name} <= 253)) || return 1
  [[ "${name,,}" != localhost ]] || return 1
  [[ "$name" != .* && "$name" != *. && "$name" != *..* ]] || return 1
  IFS=. read -r -a labels <<< "$name"
  for label in "${labels[@]}"; do
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || return 1
  done
  return 0
}

in_list() {
  local needle=$1 item
  shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

# join_by SEPARATOR ITEM... prints the items with the separator between them (nothing for no items).
join_by() {
  local separator=$1 out="" first=1 item
  shift
  for item in "$@"; do
    if ((first)); then out=$item; first=0; else out+="$separator$item"; fi
  done
  printf '%s' "$out"
}

# --mount type=bind,source=...,target=...[,readonly]: unlike -v it fails on a missing source instead of creating a
# root-owned folder, so every source is made by this script first.
mount_arg() {
  local source=$1 target=$2 mode=${3:-rw}
  if [[ "$mode" == ro ]]; then
    printf 'type=bind,source=%s,target=%s,readonly' "$source" "$target"
  else
    printf 'type=bind,source=%s,target=%s' "$source" "$target"
  fi
}

# The seams for waiting: the contract tests replace `date` and `sleep` on PATH with a fake clock, so the 180-second
# wait is proven without real waiting. The wait itself is a bounded loop around a real completion signal (the
# "listening on https://" line), not a sleep standing in for one.
clock_now() { date +%s; }
pause() { sleep "$1"; }

# ---------------------------------------------------------------------------------------------------------------
# Step 1 inputs that do not depend on the folder: the arguments themselves
# ---------------------------------------------------------------------------------------------------------------

# --remove may be combined only with --root (one behavior in both setup scripts, reviewed October 10, 2026).
if [[ "$REMOVE" == 1 ]] && [[ -n "$VARIANT_ARG$IMAGE_ARG$PORT_ARG$NAME_ARG$SECRET_FILE_ARG$AUTOSTART_ARG" || ${#ADDRESS_ARGS[@]} -gt 0 || $((UPDATE + NEW_SECRET + NEW_CERT + SHOW_PLAN)) -gt 0 ]]; then
  fail "--remove can only be combined with --root."
fi
# --show-plan makes no change and reads no secret: only the options that decide what a new setup would use.
if [[ "$SHOW_PLAN" == 1 ]] && [[ -n "$VARIANT_ARG$IMAGE_ARG$SECRET_FILE_ARG$AUTOSTART_ARG" || $((UPDATE + NEW_SECRET + NEW_CERT + REMOVE)) -gt 0 ]]; then
  fail "--show-plan can only be combined with --root, --port, --name and --address."
fi
[[ "$UPDATE" == 0 || $((NEW_SECRET + NEW_CERT)) == 0 ]] || fail "--update cannot be combined with --new-secret or --new-certificate."
[[ -z "$AUTOSTART_ARG" ]] || { AUTOSTART_ARG=${AUTOSTART_ARG,,}; [[ "$AUTOSTART_ARG" == on || "$AUTOSTART_ARG" == off ]] || fail "--autostart must be on or off."; }
[[ -z "$IMAGE_ARG" ]] || validate_digest_ref "$IMAGE_ARG"
[[ -z "$VARIANT_ARG" || "$VARIANT_ARG" == cuda || "$VARIANT_ARG" == rocm ]] || fail "--variant must be cuda or rocm."
if [[ -n "$PORT_ARG" ]]; then
  [[ "$PORT_ARG" =~ ^[0-9]{1,5}$ ]] && ((10#$PORT_ARG >= 1024 && 10#$PORT_ARG <= 65535)) || fail "--port must be a number from 1024 through 65535."
  PORT_ARG=$((10#$PORT_ARG))
fi
if [[ -n "$NAME_ARG" ]]; then
  [[ "$NAME_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || fail "--name may use letters, digits, '.', '_' and '-' (63 characters at most), starting with a letter or digit."
  NAME_ARG=${NAME_ARG,,}
fi

# Each --address is an IPv4 address (goes into the certificate and is checked on a later run) or a name (recorded
# in the certificate for information only: the Vocalis client resolves the URL's host to an IPv4 address and checks
# the certificate against that address, so a name alone never makes a satellite reachable).
EXTRA_IPS=()
EXTRA_DNS=()
# Checked here, before anything is created or pulled: a bad one used to fail only after the 10 GB pull.
for address in ${ADDRESS_ARGS[@]+"${ADDRESS_ARGS[@]}"}; do
  if [[ "$address" == *:* ]]; then
    fail "--address $address: IPv6 addresses are not supported (the Vocalis client dials an IPv4 address). Give an IPv4 address or a name."
  elif [[ "$address" =~ ^[0-9.]+$ ]]; then
    is_ipv4 "$address" || fail "--address $address is not a valid IPv4 address (four decimal numbers from 0 to 255, no leading zeros)."
    is_usable_ipv4 "$address" || fail "--address $address cannot be used: it is a loopback, link-local, multicast, 0.0.0.0 or broadcast address that another computer could not reach."
    in_list "$address" ${EXTRA_IPS[@]+"${EXTRA_IPS[@]}"} || EXTRA_IPS+=("$address")
  else
    is_dns_name "$address" || fail "--address $address is neither an IPv4 address nor a valid name (dot-separated labels of letters, digits and hyphens, each 1 to 63 characters and not starting or ending with a hyphen; not 'localhost')."
    address=${address,,}
    in_list "$address" ${EXTRA_DNS[@]+"${EXTRA_DNS[@]}"} || EXTRA_DNS+=("$address")
  fi
done

SECRET_FILE=""
if [[ -n "$SECRET_FILE_ARG" ]]; then
  check_path_chars "The --secret-file path" "$SECRET_FILE_ARG"
  [[ -f "$SECRET_FILE_ARG" ]] || fail "The --secret-file does not exist or is not a file: $SECRET_FILE_ARG"
  [[ -r "$SECRET_FILE_ARG" ]] || fail "The --secret-file cannot be read by this user: $SECRET_FILE_ARG"
  # Resolved here so the --mount source is absolute and never a link (the container sees the file itself).
  SECRET_FILE=$(realpath -- "$SECRET_FILE_ARG")
  check_path_chars "The --secret-file path" "$SECRET_FILE"
fi

# ---------------------------------------------------------------------------------------------------------------
# The satellite folder
# ---------------------------------------------------------------------------------------------------------------

if [[ -z "$ROOT_ARG" ]]; then ROOT_ARG="${HOME:?HOME is not set}/.local/share/vocalis/satellite"; fi
check_path_chars "The satellite folder path" "$ROOT_ARG"
[[ ! -L "$ROOT_ARG" ]] || fail "The satellite folder must not be a symlink: $ROOT_ARG"
[[ ! -e "$ROOT_ARG" || -d "$ROOT_ARG" ]] || fail "The satellite folder path exists and is not a folder: $ROOT_ARG"
ROOT=$(realpath -m -- "$ROOT_ARG")
check_path_chars "The satellite folder path" "$ROOT"
[[ "$ROOT" != / ]] || fail "The filesystem root cannot be used as a satellite folder."
ENV_FILE="$ROOT/satellite.env"
[[ ! -L "$ENV_FILE" ]] || fail "satellite.env must not be a symlink."

# The banner and the first step header (not for --show-plan, which prints nothing but its KEY=VALUE lines). The number of
# steps is 8 for a setup, update or replaced secret or certificate, and 2 for --remove and for the small
# --autostart operation (script change 5: --autostart alone, on a folder that has a satellite.env, never turns into
# a resumed first setup).
SMALL_OP=0
if [[ -n "$AUTOSTART_ARG" && $((UPDATE + NEW_SECRET + NEW_CERT + REMOVE + SHOW_PLAN)) == 0 && -f "$ENV_FILE" ]]; then SMALL_OP=1; fi
if [[ "$SHOW_PLAN" == 0 ]]; then
  if [[ "$REMOVE" == 1 || "$SMALL_OP" == 1 ]]; then STEP_COUNT=2; fi
  outf 'Vocalis satellite setup for Linux\n'
  step 1 Checks
fi

# satellite.env is read as strictly as the Windows script reads it (acceptance pass, October 10, 2026): it is a file
# this script wrote, so EVERY line is KEY=VALUE for one of the 11 keys below, and each key is there exactly once.
# Blank lines, comment lines, lower-case keys, unknown keys, repeated keys and malformed lines are refused, naming the
# file and the line number. This runs before any Docker call (the Docker checks come after the folder is read).
# October 11, 2026: two more keys exist, AUTOSTART (twelfth) and CERT_FINGERPRINT (thirteenth). A file written before
# this version has neither, so those two (and only those) may be absent: AUTOSTART is then read as on, the
# fingerprint as empty, and both are written the next time the script saves the file. Every other key must be there.
ENV_KEYS=(SATELLITE_ID GPU_VARIANT SATELLITE_ROOT SATELLITE_IMAGE SATELLITE_PORT SATELLITE_NAME SERVICE_UID SERVICE_GID GPU_GIDS IP_ADDRESSES DNS_NAMES)
ENV_OPTIONAL_KEYS=(AUTOSTART CERT_FINGERPRINT)
declare -A ENV_VALUES=()
parse_env_file() {
  local line number=0 key value
  local -A first_line=()
  ENV_VALUES=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    number=$((number + 1))
    if [[ ! "$line" =~ ^([A-Z][A-Z_]*)=(.*)$ ]]; then
      fail "satellite.env ($ENV_FILE) line $number is not a KEY=VALUE line: '$line'. It is not a file this setup wrote, so nothing was done."
    fi
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    in_list "$key" "${ENV_KEYS[@]}" "${ENV_OPTIONAL_KEYS[@]}" || fail "satellite.env ($ENV_FILE) line $number has an unknown key '$key': '$line'. It is not a file this setup wrote, so nothing was done."
    if [[ -n "${first_line[$key]:-}" ]]; then
      fail "satellite.env ($ENV_FILE) line $number repeats $key (first on line ${first_line[$key]}). It is not a file this setup wrote, so nothing was done."
    fi
    first_line[$key]=$number
    ENV_VALUES[$key]=$value
  done < "$ENV_FILE"
  for key in "${ENV_KEYS[@]}"; do
    [[ -n "${first_line[$key]:-}" ]] || fail "satellite.env ($ENV_FILE) has no $key line. It is not a file this setup wrote, so nothing was done."
  done
}

# read_env_value KEY: the value of KEY from the parsed file (the quoting setup.sh uses for instance.env: only the
# root is single-quoted). A few values may be empty.
read_env_value() {
  local found=${ENV_VALUES[$1]-}
  if [[ "$found" == \'*\' ]]; then found=${found:1:${#found}-2}; fi
  printf '%s' "$found"
}

# split_commas STRING: fills SPLIT from a comma-separated string (nothing for an empty one).
SPLIT=()
split_commas() {
  SPLIT=()
  if [[ -n "$1" ]]; then IFS=',' read -r -a SPLIT <<< "$1"; fi
}

# Everything below is the satellite.env data. Ordered as the design lists the keys.
SATELLITE_ID=""
GPU_VARIANT=""
SATELLITE_IMAGE=""
SATELLITE_PORT=""
SATELLITE_NAME=""
SERVICE_UID=""
SERVICE_GID=""
GPU_GIDS=()
IP_ADDRESSES=()
DNS_NAMES=()
CONTAINER_NAME=""
AUTOSTART=on          # the recorded value; "on" when a satellite.env written before this version has no AUTOSTART line
AUTOSTART_RECORDED=on
CERT_FINGERPRINT=""   # recorded after `show`; empty until then

load_env() {
  local saved_root gids ips dns item
  parse_env_file
  SATELLITE_ID=$(read_env_value SATELLITE_ID)
  GPU_VARIANT=$(read_env_value GPU_VARIANT)
  saved_root=$(read_env_value SATELLITE_ROOT)
  SATELLITE_IMAGE=$(read_env_value SATELLITE_IMAGE)
  SATELLITE_PORT=$(read_env_value SATELLITE_PORT)
  SATELLITE_NAME=$(read_env_value SATELLITE_NAME)
  SERVICE_UID=$(read_env_value SERVICE_UID)
  SERVICE_GID=$(read_env_value SERVICE_GID)
  gids=$(read_env_value GPU_GIDS)
  ips=$(read_env_value IP_ADDRESSES)
  dns=$(read_env_value DNS_NAMES)
  [[ "$SATELLITE_ID" =~ ^vs-[0-9a-f]{12}$ ]] || fail "Invalid SATELLITE_ID in satellite.env."
  [[ "$GPU_VARIANT" == cuda || "$GPU_VARIANT" == rocm ]] || fail "Invalid GPU_VARIANT in satellite.env."
  [[ "$(realpath -m -- "$saved_root")" == "$ROOT" ]] || fail "The selected folder does not match satellite.env, which records $saved_root (was the folder moved or copied?)."
  validate_digest_ref "$SATELLITE_IMAGE"
  [[ "$SATELLITE_PORT" =~ ^[0-9]{1,5}$ ]] && ((10#$SATELLITE_PORT >= 1 && 10#$SATELLITE_PORT <= 65535)) || fail "Invalid SATELLITE_PORT in satellite.env."
  [[ "$SATELLITE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || fail "Invalid SATELLITE_NAME in satellite.env."
  [[ "$SERVICE_UID" =~ ^[0-9]+$ && "$SERVICE_GID" =~ ^[0-9]+$ ]] || fail "Invalid SERVICE_UID or SERVICE_GID in satellite.env."
  [[ "$gids" =~ ^([0-9]+(,[0-9]+)*)?$ ]] || fail "Invalid GPU_GIDS in satellite.env."
  [[ "$GPU_VARIANT" == cuda || -n "$gids" ]] || fail "GPU_GIDS in satellite.env is empty for an AMD satellite."
  split_commas "$gids"; GPU_GIDS=(${SPLIT[@]+"${SPLIT[@]}"})
  split_commas "$ips"; IP_ADDRESSES=(${SPLIT[@]+"${SPLIT[@]}"})
  split_commas "$dns"; DNS_NAMES=(${SPLIT[@]+"${SPLIT[@]}"})
  for item in ${IP_ADDRESSES[@]+"${IP_ADDRESSES[@]}"}; do is_ipv4 "$item" || fail "Invalid IP_ADDRESSES in satellite.env."; done
  for item in ${DNS_NAMES[@]+"${DNS_NAMES[@]}"}; do is_dns_name "$item" || fail "Invalid DNS_NAMES in satellite.env."; done
  # The two optional keys: absent is on / empty; present must be well formed.
  AUTOSTART=$(read_env_value AUTOSTART)
  [[ -n "$AUTOSTART" ]] || { [[ -z "${ENV_VALUES[AUTOSTART]+set}" ]] && AUTOSTART=on; }
  [[ "$AUTOSTART" == on || "$AUTOSTART" == off ]] || fail "Invalid AUTOSTART in satellite.env (on or off)."
  AUTOSTART_RECORDED=$AUTOSTART
  CERT_FINGERPRINT=$(read_env_value CERT_FINGERPRINT)
  [[ "$CERT_FINGERPRINT" =~ ^([0-9A-Fa-f:]+)?$ ]] || fail "Invalid CERT_FINGERPRINT in satellite.env."
  CONTAINER_NAME="vocalis-satellite-$SATELLITE_ID"
}

# Written through a temporary file in the same folder and renamed into place, mode 0600, as setup.sh does for
# instance.env. Called right after step 1 (so a run that fails later leaves a folder the same command accepts) and
# again when a later step learns something (the addresses the certificate really holds, a new image).
write_env() {
  ENV_TMP="$ROOT/.satellite.env.tmp.$$"
  {
    printf 'SATELLITE_ID=%s\n' "$SATELLITE_ID"
    printf 'GPU_VARIANT=%s\n' "$GPU_VARIANT"
    printf "SATELLITE_ROOT='%s'\n" "$ROOT"
    printf 'SATELLITE_IMAGE=%s\n' "$SATELLITE_IMAGE"
    printf 'SATELLITE_PORT=%s\n' "$SATELLITE_PORT"
    printf 'SATELLITE_NAME=%s\n' "$SATELLITE_NAME"
    printf 'SERVICE_UID=%s\n' "$SERVICE_UID"
    printf 'SERVICE_GID=%s\n' "$SERVICE_GID"
    printf 'GPU_GIDS=%s\n' "$(join_by , ${GPU_GIDS[@]+"${GPU_GIDS[@]}"})"
    printf 'IP_ADDRESSES=%s\n' "$(join_by , ${IP_ADDRESSES[@]+"${IP_ADDRESSES[@]}"})"
    printf 'DNS_NAMES=%s\n' "$(join_by , ${DNS_NAMES[@]+"${DNS_NAMES[@]}"})"
    printf 'AUTOSTART=%s\n' "$AUTOSTART"
    printf 'CERT_FINGERPRINT=%s\n' "$CERT_FINGERPRINT"
  } > "$ENV_TMP"
  chmod 0600 -- "$ENV_TMP"
  mv -f -- "$ENV_TMP" "$ENV_FILE"
  ENV_TMP=""
  logf 'Wrote satellite.env (image %s, autostart %s, fingerprint %s)' "$SATELLITE_IMAGE" "$AUTOSTART" "${CERT_FINGERPRINT:-none}"
  AUTOSTART_RECORDED=$AUTOSTART
}

# The default image stamped into this copy of the script for a GPU type (empty in the repository's copy).
default_image_for() {
  if [[ "$1" == cuda ]]; then printf '%s' "$DEFAULT_IMAGE_CUDA"; else printf '%s' "$DEFAULT_IMAGE_ROCM"; fi
}
STAMPED_DEFAULT=""
NEWER_IMAGE_NOTICE=0

# ---------------------------------------------------------------------------------------------------------------
# The setup log and setup-result.txt (script changes 2 and 4). Defined before the folder is read so that a failure
# right after the folder is accepted can already write its result.
# ---------------------------------------------------------------------------------------------------------------

# State the result file and the closing lines read; filled in as the run goes.
SHOW_FINGERPRINT=""
SHOW_IPS=()
SHOW_DNS=()
ALL_IPS=()
PRIMARY=""
URL_LIST=()
MADE_SECRET=no
MADE_CERTIFICATE=no
FIRST_RUN=0
# 1 when a plain run on a never-finished folder took the --image it was given in place of the recorded one (written to
# satellite.env once the checks have passed).
IMAGE_ADOPTED=0
LOG_KEEP=10

# Opens <root>/logs/setup-<UTC yyyymmdd-hhmmss>-<process id>.log, writes the lines held in memory, and keeps the last
# LOG_KEEP setup logs. A folder that cannot hold it gives one warning and the run goes on without a log.
open_log() {
  local dir="$ROOT/logs" stamp name file count excess=0 index=0
  local -a files=()
  stamp=$(date -u +%Y%m%d-%H%M%S)
  name="setup-$stamp-$$.log"
  if [[ -L "$dir" || ( -e "$dir" && ! -d "$dir" ) ]]; then
    printf 'WARNING: %s is not a real folder, so this run has no setup log.\n' "$dir" >&2
    LOG_STATE=off
    return 0
  fi
  if ! mkdir -p -- "$dir" 2>/dev/null || ! { : > "$dir/$name"; } 2>/dev/null; then
    printf 'WARNING: the setup log %s cannot be created, so this run has no setup log.\n' "$dir/$name" >&2
    LOG_STATE=off
    return 0
  fi
  LOG_FILE="$dir/$name"
  LOG_STATE=open
  local text
  log_text "Vocalis satellite setup log"
  log_text "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for text in ${LOG_PENDING[@]+"${LOG_PENDING[@]}"}; do log_text "$text"; done
  LOG_PENDING=()
  # The last LOG_KEEP setup logs are kept (names sort by time: the stamp comes first, in fixed width).
  for file in "$dir"/setup-*.log; do
    [[ -f "$file" && ! -L "$file" && "${file##*/}" =~ ^setup-[0-9]{8}-[0-9]{6}-[0-9]+\.log$ ]] && files+=("$file")
  done
  count=${#files[@]}
  if ((count > LOG_KEEP)); then
    excess=$((count - LOG_KEEP))
    for ((index = 0; index < excess; index++)); do rm -f -- "${files[$index]}"; done
    logf 'Removed %d older setup log(s); the last %d are kept.' "$excess" "$LOG_KEEP"
  fi
}

# Primary address first; the same list the closing lines and the result file print. Uses what the certificate
# really holds when `show` has run, else the addresses satellite.env records.
build_urls() {
  local -a addrs=()
  local item
  URL_LIST=()
  if ((${#SHOW_IPS[@]})); then addrs=("${SHOW_IPS[@]}"); else addrs=(${IP_ADDRESSES[@]+"${IP_ADDRESSES[@]}"}); fi
  if [[ -n "$PRIMARY" ]] && in_list "$PRIMARY" ${addrs[@]+"${addrs[@]}"}; then URL_LIST+=("https://$PRIMARY:$SATELLITE_PORT"); fi
  for item in ${addrs[@]+"${addrs[@]}"}; do
    [[ "$item" == "$PRIMARY" ]] || URL_LIST+=("https://$item:$SATELLITE_PORT")
  done
}

# The first that applies of: remove; autostart (the small operation); update; renew (--new-secret, --new-certificate
# or both); first (the run began on a folder with no finished setup); rerun.
result_mode() {
  if [[ "$REMOVE" == 1 ]]; then printf 'remove'
  elif [[ "$SMALL_OP" == 1 ]]; then printf 'autostart'
  elif [[ "$UPDATE" == 1 ]]; then printf 'update'
  elif [[ "$NEW_SECRET" == 1 || "$NEW_CERT" == 1 ]]; then printf 'renew'
  elif [[ "$FIRST_RUN" == 1 ]]; then printf 'first'
  else printf 'rerun'
  fi
}

# What is left to do in Vocalis after a successful run of mode $1 (VOCALIS_STEPS in the result file, and which closing
# text is printed). A --new-secret or --new-certificate run on a folder whose setup never finished also makes the part
# that was missing (MADE_ is yes for something its replace option did not ask for); the satellite cannot be set up in
# Vocalis yet, so that is the first-setup case, as the Windows script has it.
result_steps() {
  case "$1" in
    remove) printf 'remove-row' ;;
    autostart|update) printf 'none' ;;
    renew)
      if [[ "$MADE_SECRET" == yes && "$NEW_SECRET" == 0 ]] || [[ "$MADE_CERTIFICATE" == yes && "$NEW_CERT" == 0 ]]; then printf 'upload-and-tick'
      elif [[ "$NEW_CERT" == 1 ]]; then printf 'upload'
      else printf 'none'
      fi
      ;;
    first) printf 'upload-and-tick' ;;
    *) printf 'maybe' ;;
  esac
}

# yes / no / unknown ("unknown" when Docker does not answer).
result_running() {
  local state
  docker info >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  state=$(docker container inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null) || { printf 'no'; return 0; }
  if [[ "$state" == running ]]; then printf 'yes'; else printf 'no'; fi
}

# One line per value, no line break inside any of them.
flat_text() { local value=${1//$'\r'/ }; value=${value//$'\n'/ }; printf '%s' "$value"; }

# <root>/setup-result.txt: UTF-8 KEY=VALUE lines, no byte-order mark, the same form as satellite.env; written through a
# temporary name and renamed, on success and on failure; never holds the secret. $1 is the exit status.
write_result() {
  local rc=$1 tmp="$ROOT/.setup-result.txt.tmp.$$" mode steps="" failure="" running certfile="" fingerprint="" urls=""
  mode=$(result_mode)
  if ((rc == 0)); then
    steps=$(result_steps "$mode")
  else
    steps=unknown
    if [[ -n "$FAIL_REASON" ]]; then
      failure=$(flat_text "$FAIL_REASON")
    elif ((rc == 130 || rc == 143 || rc == 129)); then
      failure="Setup was interrupted before it finished (exit status $rc)."
    else
      failure="Setup stopped unexpectedly (exit status $rc)."
    fi
  fi
  running=$(result_running)
  if [[ -s "$ROOT/data/certs/cert.pem" ]]; then
    certfile="$ROOT/data/certs/cert.pem"
    fingerprint=${SHOW_FINGERPRINT:-$CERT_FINGERPRINT}
    # The primary address first: found now when the run ended before it was looked for (the autostart operation, a
    # refusal or a failure early on). collect_addresses is defined further down the script, so a failure before that
    # point has no primary and lists the recorded addresses in their recorded order.
    if [[ -z "$PRIMARY" ]] && declare -F collect_addresses >/dev/null; then collect_addresses || true; fi
    build_urls
    urls=$(join_by , ${URL_LIST[@]+"${URL_LIST[@]}"})
  fi
  { {
    printf 'SCHEMA=1\n'
    printf 'FINISHED=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'MODE=%s\n' "$mode"
    printf 'EXIT_CODE=%s\n' "$rc"
    printf 'FAILURE=%s\n' "$failure"
    printf 'SATELLITE_ID=%s\n' "$SATELLITE_ID"
    printf 'NAME=%s\n' "$SATELLITE_NAME"
    printf 'PORT=%s\n' "$SATELLITE_PORT"
    printf 'IMAGE=%s\n' "$SATELLITE_IMAGE"
    printf 'CONTAINER=%s\n' "$CONTAINER_NAME"
    printf 'RUNNING=%s\n' "$running"
    printf 'AUTOSTART=%s\n' "$AUTOSTART"
    printf 'URLS=%s\n' "$urls"
    printf 'CERTIFICATE_FILE=%s\n' "$certfile"
    printf 'FINGERPRINT=%s\n' "$fingerprint"
    printf 'MADE_SECRET=%s\n' "$MADE_SECRET"
    printf 'MADE_CERTIFICATE=%s\n' "$MADE_CERTIFICATE"
    printf 'VOCALIS_STEPS=%s\n' "$steps"
    printf 'LOG_FILE=%s\n' "$LOG_FILE"
  } > "$tmp"; } 2>/dev/null && mv -f -- "$tmp" "$ROOT/setup-result.txt" 2>/dev/null || {
    rm -f -- "$tmp"
    printf 'WARNING: setup-result.txt could not be written in %s.\n' "$ROOT" >&2
    return 0
  }
  logf 'Result: mode=%s exit=%s running=%s steps=%s (written to %s)' "$mode" "$rc" "$running" "$steps" "$ROOT/setup-result.txt"
}

# Called once satellite.env has been read and accepted, or has just been created. Opens the log, deletes the previous
# run's result so that a run that is killed leaves none, and arms the result for the exit trap. $1 = 1 when this run
# began with no finished setup in the folder (no satellite.env, or a secret or certificate still to be made).
accept_folder() {
  FIRST_RUN=$1
  RESULT_ARMED=1
  open_log
  rm -f -- "$ROOT/setup-result.txt" "$ROOT"/.setup-result.txt.tmp.* 2>/dev/null || true
  logf 'Script: %s' "$0"
  logf 'Arguments: %s' "${ORIGINAL_ARGS[*]-}"
  logf 'Folder: %s  satellite: %s  user id: %s  first-run: %s' "$ROOT" "${SATELLITE_ID:-<new>}" "$(id -u)" "$FIRST_RUN"
}

# THE one definition of a finished setup (October 11, 2026: --show-plan's SETUP_FINISHED, the --update
# refusal and the adoption of another image on an unfinished folder all use it). A folder is finished only
# when satellite.env, the secret, both certificate files AND the configuration file all exist and are not empty.
#
# MODE=first in the result file is a different, narrower question (design, script change 4: "no satellite.env, or a
# secret or certificate still to be made"), answered by first_setup_pending below: it picks the closing lines and
# VOCALIS_STEPS, which depend on those two alone. A folder that lacks only data/satellite.yaml is not finished (it adopts
# an image, and --update is refused), but its secret and certificate may long since be in Vocalis, so its run is a
# rerun with the hedged "if this satellite is already set up" text, as in the Windows script.
# setup_missing_files fills MISSING_FILES with the names of the four files that are missing (satellite.env is the
# folder's own marker: a folder without it is not a satellite folder at all).
MISSING_FILES=()
setup_missing_files() {
  MISSING_FILES=()
  [[ -s "$ROOT/secrets/vocalis-satellite-master" ]] || MISSING_FILES+=("secrets/vocalis-satellite-master")
  [[ -s "$ROOT/data/certs/cert.pem" ]] || MISSING_FILES+=("data/certs/cert.pem")
  [[ -s "$ROOT/data/certs/key.pem" ]] || MISSING_FILES+=("data/certs/key.pem")
  [[ -s "$ROOT/data/satellite.yaml" ]] || MISSING_FILES+=("data/satellite.yaml")
}
setup_finished() {
  [[ -f "$ENV_FILE" ]] || return 1
  setup_missing_files
  ((${#MISSING_FILES[@]} == 0))
}
setup_unfinished() { ! setup_finished; }
# Whether a secret or a certificate is still to be made (MODE=first for an existing folder; see above).
first_setup_pending() {
  [[ ! -s "$ROOT/secrets/vocalis-satellite-master" || ! -s "$ROOT/data/certs/cert.pem" || ! -s "$ROOT/data/certs/key.pem" ]]
}

EXISTING=0
if [[ -f "$ENV_FILE" ]]; then
  EXISTING=1
elif [[ -d "$ROOT" && -n "$(find "$ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  fail "The selected folder is not empty and has no satellite.env, so it is not a satellite folder; leaving it alone. Choose an empty folder."
fi

if [[ "$EXISTING" == 0 ]]; then
  [[ "$UPDATE" == 0 ]] || fail "No satellite folder exists at $ROOT (no satellite.env); run setup without --update first."
  [[ "$REMOVE" == 0 ]] || fail "No satellite folder exists at $ROOT (no satellite.env), so there is nothing to remove."
  [[ "$NEW_SECRET" == 0 && "$NEW_CERT" == 0 ]] || fail "No satellite folder exists at $ROOT (no satellite.env); run setup first."
else
  load_env
  # The files belong to the user who ran the first setup, and the container runs as that user. Checked before the
  # folder is accepted: the log and the result are never written into a folder of another user.
  [[ "$(id -u)" == "$SERVICE_UID" ]] || fail "This satellite folder belongs to user id $SERVICE_UID, but you are user id $(id -u). Run the command as the same user (not with sudo). To remove only the container, run: docker rm -f $CONTAINER_NAME"
  FOLDER_UNFINISHED=0
  if setup_unfinished; then FOLDER_UNFINISHED=1; fi
  if [[ "$SHOW_PLAN" == 0 ]]; then
    if first_setup_pending; then accept_folder 1; else accept_folder 0; fi
  fi
  # A later run is the repair path: the recorded port, GPU type, name and image are fixed (design section 9, "Later
  # runs"). Repeating the same value, as a rerun of the first command does, is accepted.
  [[ -z "$VARIANT_ARG" || "$VARIANT_ARG" == "$GPU_VARIANT" ]] || fail "The GPU type of an existing satellite folder is fixed (recorded: $GPU_VARIANT)."
  [[ -z "$PORT_ARG" || "$PORT_ARG" == "$SATELLITE_PORT" ]] || fail "The port of an existing satellite folder is fixed (recorded: $SATELLITE_PORT)."
  [[ -z "$NAME_ARG" || "$NAME_ARG" == "$SATELLITE_NAME" ]] || fail "The name of an existing satellite folder is fixed (recorded: $SATELLITE_NAME)."
  # --update moves to the image given with --image or, without one, to the default stamped into this copy of the
  # script for the folder's GPU type (a user who downloads a newer release's file should not have to type a digest).
  # It is refused only when neither exists. October 10, 2026 rule.
  STAMPED_DEFAULT=$(default_image_for "$GPU_VARIANT")
  NEWER_IMAGE_NOTICE=0
  if [[ "$UPDATE" == 1 ]]; then
    UPDATE_TARGET=${IMAGE_ARG:-$STAMPED_DEFAULT}
    [[ -n "$UPDATE_TARGET" ]] || fail "--update needs a new image, and this copy of the script has no default image stamped in for $GPU_VARIANT. Give it as --image NAME@sha256:<64 hex digits>, or download the setup file of the newer release and run --update with that."
    validate_digest_ref "$UPDATE_TARGET"
    if [[ "$UPDATE_TARGET" == "$SATELLITE_IMAGE" ]]; then
      # Nothing to move to: carry on as a plain repair run, exit 0.
      outf 'The satellite already runs that image (%s); nothing to update. Carrying on as a plain run that checks and repairs.\n' "$SATELLITE_IMAGE"
      UPDATE=0
      IMAGE_ARG=""
    else
      IMAGE_ARG=$UPDATE_TARGET
    fi
  else
    if [[ -n "$IMAGE_ARG" && "$IMAGE_ARG" != "$SATELLITE_IMAGE" ]]; then
      # (Not for the small --autostart operation, which records one value and nothing else.)
      if [[ "$FOLDER_UNFINISHED" == 1 && "$SMALL_OP" == 0 ]]; then
        # October 11, 2026 (both scripts, one rule): nothing has ever run from the recorded image and there
        # is nothing to update, so a plain run on a folder whose setup never finished adopts the image it was given. It
        # is recorded in satellite.env (write_env, after the checks below) and the run carries on as the resumed first
        # setup. --update stays refused on such a folder (the incomplete-folder check below). A FINISHED folder still
        # refuses and names --update.
        logf 'Adopting image %s in place of the recorded %s on a folder whose setup never finished (missing: %s)' "$IMAGE_ARG" "$SATELLITE_IMAGE" "$(join_by ', ' "${MISSING_FILES[@]}")"
        outf 'This satellite was never finished; using the image this setup carries.\n'
        SATELLITE_IMAGE=$IMAGE_ARG
        IMAGE_ADOPTED=1
      else
        fail "Changing the image of an existing satellite needs --update (recorded: $SATELLITE_IMAGE)."
      fi
    fi
    # A plain run keeps the recorded image. When this file names a different one, say so at the end.
    if [[ -z "$IMAGE_ARG" && -n "$STAMPED_DEFAULT" && "$STAMPED_DEFAULT" != "$SATELLITE_IMAGE" ]]; then
      # The same rule without --image (October 11, 2026): on a never-finished folder (and not the small
      # --autostart operation) the image this setup file carries, its stamped default, is adopted as if it had been given,
      # because the "run --update" note would be a dead end there (--update is refused until setup has finished). On a
      # finished folder the note stays.
      if [[ "$FOLDER_UNFINISHED" == 1 && "$SMALL_OP" == 0 ]]; then
        validate_digest_ref "$STAMPED_DEFAULT"
        logf 'Adopting the stamped default image %s in place of the recorded %s on a folder whose setup never finished (missing: %s)' "$STAMPED_DEFAULT" "$SATELLITE_IMAGE" "$(join_by ', ' "${MISSING_FILES[@]}")"
        outf 'This satellite was never finished; using the image this setup carries.\n'
        SATELLITE_IMAGE=$STAMPED_DEFAULT
        IMAGE_ADOPTED=1
      else
        NEWER_IMAGE_NOTICE=1
      fi
    fi
  fi
  # --autostart given with another operation is applied by that operation: the value is taken now, and recorded
  # (satellite.env) before the container is created, started or corrected. On its own it is the small operation below.
  if [[ -n "$AUTOSTART_ARG" && "$SMALL_OP" == 0 ]]; then AUTOSTART=$AUTOSTART_ARG; fi
fi

# Docker is first asked here, after the arguments and the satellite folder (satellite.env included) have been
# checked: a refusal that does not need Docker makes no Docker call at all. (--show-plan never asks Docker.)
if [[ "$SHOW_PLAN" == 0 ]]; then
  command -v docker >/dev/null || fail "Docker is required. Install Docker Engine and retry."
  docker info >/dev/null 2>&1 || fail "Docker is unavailable. Start Docker, and make sure your user may use it (membership of the docker group; this script never uses sudo), then retry."
fi

# ---------------------------------------------------------------------------------------------------------------
# GPU type, image, port, name: a new folder decides them now; an existing one has them recorded
# ---------------------------------------------------------------------------------------------------------------

nvidia_runtime_visible() {
  local runtimes
  runtimes=$(docker info --format '{{json .Runtimes}}' 2>/dev/null) || return 1
  [[ "${runtimes,,}" == *nvidia* ]]
}

amd_devices_present() { [[ -e "$DEV_ROOT/kfd" && -d "$DEV_ROOT/dri" ]]; }

# The numeric groups the AMD container needs: /dev/kfd's, and the render node's when it differs (on the AMD test machine both are
# render, 990). Sets GPU_GIDS.
detect_amd_groups() {
  local kfd_gid render_node render_gid candidate
  kfd_gid=$(stat -c '%g' -- "$DEV_ROOT/kfd") || fail "Cannot read the group of $DEV_ROOT/kfd."
  render_node=""
  if [[ -e "$DEV_ROOT/dri/renderD128" ]]; then
    render_node="$DEV_ROOT/dri/renderD128"
  else
    # The first render node by name (a glob is sorted).
    for candidate in "$DEV_ROOT"/dri/renderD*; do
      if [[ -e "$candidate" ]]; then render_node=$candidate; break; fi
    done
  fi
  [[ -n "$render_node" ]] || fail "No GPU render node (renderD...) was found under $DEV_ROOT/dri, so the AMD card cannot be given to a container."
  render_gid=$(stat -c '%g' -- "$render_node") || fail "Cannot read the group of $render_node."
  GPU_GIDS=("$kfd_gid")
  if [[ "$render_gid" != "$kfd_gid" ]]; then GPU_GIDS+=("$render_gid"); fi
}

# Keep these two helpers beside collect_addresses: the sample output the contract tests feed them is `ip -o` text.
interface_lines() { ip -4 -o addr show up; }
default_route_line() { ip -4 route get 1.1.1.1; }

# The IPv4 addresses a Vocalis client could use to reach this machine (design section 9, step 4): interfaces that
# are up, minus loopback, link-local (169.254.x.x) and virtual ones (Docker bridges and veth pairs, libvirt). The
# primary is the source address of the default route, found without sending a packet (`ip route get` only asks the
# kernel), and goes first. Sets ALL_IPS (primary first) and PRIMARY.
ALL_IPS=()
PRIMARY=""
collect_addresses() {
  local line name family cidr addr route route_src="" found=()
  ALL_IPS=()
  PRIMARY=""
  if command -v ip >/dev/null 2>&1; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      # "2: eth0    inet 192.168.1.50/24 brd 192.168.1.255 scope global dynamic eth0\ valid_lft ..."
      read -r _ name family cidr _ <<< "$line"
      [[ "$family" == inet ]] || continue
      name=${name%%@*}
      case "$name" in
        lo|docker0|br-*|veth*|virbr*) continue ;;
      esac
      addr=${cidr%%/*}
      is_ipv4 "$addr" || continue
      is_usable_ipv4 "$addr" || continue  # loopback, link-local (169.254.x.x) and the like
      in_list "$addr" ${found[@]+"${found[@]}"} || found+=("$addr")
    done < <(interface_lines 2>/dev/null || true)
    if route=$(default_route_line 2>/dev/null); then
      # "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.50 uid 1000". The match is copied out before is_ipv4 runs,
      # because is_ipv4 does a match of its own and replaces BASH_REMATCH.
      if [[ "$route" =~ (^|[[:space:]])src[[:space:]]+([0-9.]+) ]]; then
        route_src=${BASH_REMATCH[2]}
        { is_ipv4 "$route_src" && is_usable_ipv4 "$route_src"; } || route_src=""
      fi
    fi
  fi
  if [[ -n "$route_src" ]]; then
    PRIMARY=$route_src
  elif ((${#found[@]})); then
    PRIMARY=${found[0]}
  elif ((${#EXTRA_IPS[@]})); then
    PRIMARY=${EXTRA_IPS[0]}
  fi
  [[ -n "$PRIMARY" ]] || return 1
  ALL_IPS=("$PRIMARY")
  for addr in ${found[@]+"${found[@]}"} ${EXTRA_IPS[@]+"${EXTRA_IPS[@]}"}; do
    in_list "$addr" "${ALL_IPS[@]}" || ALL_IPS+=("$addr")
  done
  logf 'Addresses found: %d usable (%s), primary %s, %d extra from --address' "${#ALL_IPS[@]}" "$(join_by ' ' "${ALL_IPS[@]}")" "$PRIMARY" "${#EXTRA_IPS[@]}"
  return 0
}

# Shown in step 4 ("Addresses"), after the GPU step, where the Windows script prints it too.
print_addresses() {
  outf 'Addresses of this computer: %s (primary: %s)\n' "$(join_by ' ' "${ALL_IPS[@]}")" "$PRIMARY"
}

# The default satellite name: this computer's name in lower case with anything else turned into '-'. Fails (naming
# --name) when it cannot be made valid; checked before satellite.env is written, so a computer name that cannot be made
# valid stops setup instead of leaving a folder load_env would refuse.
default_satellite_name() {
  local machine_name
  machine_name=$(uname -n 2>/dev/null || true)
  machine_name=${machine_name,,}
  machine_name=${machine_name//[^a-z0-9._-]/-}
  machine_name=${machine_name#[-._]}
  machine_name=${machine_name:0:63}
  [[ "$machine_name" =~ ^[a-z0-9][a-z0-9._-]{0,62}$ ]] || fail "This computer's name ('$(uname -n 2>/dev/null || true)') cannot be made into a valid satellite name (letters, digits, '.', '_' and '-', starting with a letter or digit, 63 characters at most). Give one with --name."
  DEFAULT_NAME=$machine_name
}
DEFAULT_NAME=""

# ---------------------------------------------------------------------------------------------------------------
# --show-plan (script change 7): what a setup here would use, as KEY=VALUE lines on standard output. No Docker call, no
# banner, no step header, no log, no result file, nothing created. The setup program, the Linux command and (on
# Windows) the tray icon read satellite.env through this and nowhere else.
# ---------------------------------------------------------------------------------------------------------------
if [[ "$SHOW_PLAN" == 1 ]]; then
  plan_secret=yes
  plan_cert=yes
  plan_finished=no
  plan_certfile=""
  if [[ "$EXISTING" == 1 ]]; then
    [[ -z "$PORT_ARG" || "$PORT_ARG" == "$SATELLITE_PORT" ]] || fail "The port of an existing satellite folder is fixed (recorded: $SATELLITE_PORT)."
    [[ -z "$NAME_ARG" || "$NAME_ARG" == "$SATELLITE_NAME" ]] || fail "The name of an existing satellite folder is fixed (recorded: $SATELLITE_NAME)."
    [[ -s "$ROOT/secrets/vocalis-satellite-master" ]] && plan_secret=no
    [[ -s "$ROOT/data/certs/cert.pem" && -s "$ROOT/data/certs/key.pem" ]] && plan_cert=no
    [[ -s "$ROOT/data/certs/cert.pem" ]] && plan_certfile="$ROOT/data/certs/cert.pem"
    if setup_finished; then plan_finished=yes; fi
    plan_exists=existing
  else
    plan_exists=new
    SATELLITE_PORT=${PORT_ARG:-7880}
    if [[ -n "$NAME_ARG" ]]; then SATELLITE_NAME=$NAME_ARG; else default_satellite_name; SATELLITE_NAME=$DEFAULT_NAME; fi
    SATELLITE_ID=""
    SATELLITE_IMAGE=""
    CONTAINER_NAME=""
    AUTOSTART=on
    CERT_FINGERPRINT=""
  fi
  collect_addresses || true
  printf 'SATELLITE=%s\n' "$plan_exists"
  printf 'SATELLITE_ID=%s\n' "$SATELLITE_ID"
  printf 'NAME=%s\n' "$SATELLITE_NAME"
  printf 'PORT=%s\n' "$SATELLITE_PORT"
  printf 'CONTAINER=%s\n' "$CONTAINER_NAME"
  printf 'AUTOSTART=%s\n' "$AUTOSTART"
  printf 'IMAGE=%s\n' "$SATELLITE_IMAGE"
  printf 'ADDRESSES=%s\n' "$(join_by , ${ALL_IPS[@]+"${ALL_IPS[@]}"})"
  printf 'NEEDS_SECRET=%s\n' "$plan_secret"
  printf 'NEEDS_CERTIFICATE=%s\n' "$plan_cert"
  printf 'SETUP_FINISHED=%s\n' "$plan_finished"
  printf 'CERTIFICATE_FILE=%s\n' "$plan_certfile"
  printf 'FINGERPRINT=%s\n' "$CERT_FINGERPRINT"
  exit 0
fi

NEW_RUN=0
MADE_THIS_RUN=0
if [[ "$EXISTING" == 0 ]]; then
  NEW_RUN=1
  # GPU type (design section 9, step 1). Both an NVIDIA runtime and AMD device nodes present is common (a Ryzen's
  # integrated graphics beside an NVIDIA card), and guessing would start the satellite on the wrong card.
  has_nvidia=0
  has_amd=0
  nvidia_runtime_visible && has_nvidia=1
  amd_devices_present && has_amd=1
  GPU_VARIANT=$VARIANT_ARG
  if [[ -z "$GPU_VARIANT" ]]; then
    if ((has_nvidia && has_amd)); then
      fail "Docker shows an NVIDIA runtime and this computer also has AMD graphics devices (a Ryzen's integrated graphics next to an NVIDIA card is common), so setup cannot tell which card you want. Run it again with --variant cuda to use the NVIDIA card, or --variant rocm to use the AMD card."
    elif ((has_nvidia)); then
      GPU_VARIANT=cuda
    elif ((has_amd)); then
      GPU_VARIANT=rocm
    else
      fail "No usable GPU was found: Docker shows no NVIDIA runtime (install the NVIDIA Container Toolkit) and there is no AMD /dev/kfd with /dev/dri. A satellite needs an NVIDIA or an AMD card."
    fi
  elif [[ "$GPU_VARIANT" == cuda ]]; then
    ((has_nvidia)) || fail "--variant cuda was given, but Docker shows no NVIDIA runtime. Install the NVIDIA Container Toolkit and retry."
  else
    ((has_amd)) || fail "--variant rocm was given, but $DEV_ROOT/kfd and $DEV_ROOT/dri are not both present, so an AMD card cannot be given to a container."
  fi
  GPU_GIDS=()
  if [[ "$GPU_VARIANT" == rocm ]]; then detect_amd_groups; fi

  STAMPED_DEFAULT=$(default_image_for "$GPU_VARIANT")
  SATELLITE_IMAGE=$IMAGE_ARG
  if [[ -z "$SATELLITE_IMAGE" ]]; then
    if [[ "$GPU_VARIANT" == cuda ]]; then SATELLITE_IMAGE=$DEFAULT_IMAGE_CUDA; else SATELLITE_IMAGE=$DEFAULT_IMAGE_ROCM; fi
    [[ -n "$SATELLITE_IMAGE" ]] || fail "--image is required: this copy of the script has no default image for $GPU_VARIANT. Give it as --image NAME@sha256:<64 hex digits>."
  fi
  validate_digest_ref "$SATELLITE_IMAGE"

  SATELLITE_PORT=${PORT_ARG:-7880}
  if [[ -n "$NAME_ARG" ]]; then
    SATELLITE_NAME=$NAME_ARG
  else
    # The same pattern the provisioning tool and load_env accept (see default_satellite_name).
    default_satellite_name
    SATELLITE_NAME=$DEFAULT_NAME
  fi
  AUTOSTART=${AUTOSTART_ARG:-on}
  SERVICE_UID=$(id -u)
  SERVICE_GID=$(id -g)
  SATELLITE_ID="vs-$(tr -d '-' </proc/sys/kernel/random/uuid | cut -c1-12)"
  CONTAINER_NAME="vocalis-satellite-$SATELLITE_ID"
fi
IMAGE=$SATELLITE_IMAGE
if [[ "$(id -u)" == 0 ]]; then
  errf 'WARNING: you are running as root. The satellite will run as root and own its files; normally run this as your own user, without sudo.\n'
fi

# ---------------------------------------------------------------------------------------------------------------
# Container specification (design section 9, "Run specification"). Every docker run below is built from these.
# ---------------------------------------------------------------------------------------------------------------

GPU_ARGS=()
build_gpu_args() {
  local gid
  GPU_ARGS=()
  if [[ "$GPU_VARIANT" == cuda ]]; then
    GPU_ARGS=(--gpus all)
  else
    GPU_ARGS=(--device /dev/kfd --device /dev/dri)
    for gid in "${GPU_GIDS[@]}"; do GPU_ARGS+=(--group-add "$gid"); done
  fi
}

# One-shot containers: `docker run --rm --read-only --tmpfs /tmp --user <service user>`, --network none (except
# fetch-model, which downloads), -it only when provision must prompt for the secret, the cache always mounted at
# /cache/vocalis, then what the subcommand needs, then `--entrypoint python IMAGE ADMIN_TOOL SUBCOMMAND ARGS`.
# The image is a parameter because --update runs fetch-model with the NEW image before anything is recorded.
PROMPT_TTY=0
ONESHOT_ARGS=()
oneshot_args() {
  local sub=$1 image=$2
  shift 2
  local -a args=(run --rm --read-only --tmpfs /tmp --user "$SERVICE_UID:$SERVICE_GID")
  if [[ "$sub" != fetch-model ]]; then args+=(--network none); fi
  if [[ "$sub" == provision && "$PROMPT_TTY" == 1 ]]; then args+=(-it); fi
  args+=(--mount "$(mount_arg "$ROOT/cache" /cache/vocalis)")
  case "$sub" in
    check-gpu)
      build_gpu_args
      args+=("${GPU_ARGS[@]}")
      ;;
    provision)
      args+=(--mount "$(mount_arg "$ROOT/data" /data/vocalis-satellite)")
      args+=(--mount "$(mount_arg "$ROOT/secrets" /run/secrets)")
      if [[ -n "$SECRET_FILE" ]]; then args+=(--mount "$(mount_arg "$SECRET_FILE" /run/provision/secret ro)"); fi
      ;;
    fetch-model)
      args+=(--mount "$(mount_arg "$ROOT/models" /models/vocalis)")
      ;;
    show)
      args+=(--mount "$(mount_arg "$ROOT/data" /data/vocalis-satellite ro)")
      ;;
  esac
  args+=(--entrypoint python "$image" "$ADMIN_TOOL" "$sub" "$@")
  ONESHOT_ARGS=("${args[@]}")
}

# The three ways a docker call is run, by what the screen and the log get (script change 1, per-call table):
#   direct   the call keeps this terminal. Only for what must (the typed-secret prompt, Docker's own pull progress);
#            the log gets the command and the exit status only.
#   capture  both streams are read as text (CAP_OUT, CAP_ERR, CAP_RC); the log gets every line; the caller decides
#            what is shown. A fixed rule for the in-image tool's standard error: its INFO: lines are shown only with
#            --verbose, anything else it printed (a WARNING:, an ERROR:, a message) always is.
#   stream   standard output is shown line by line as it arrives (and logged), standard error is read as text.
CAP_OUT=""
CAP_ERR=""
CAP_RC=0
elapsed_ms() { # $1 = EPOCHREALTIME at the start; prints milliseconds (empty when the shell has no EPOCHREALTIME)
  local start=${1//[.,]/} end=${EPOCHREALTIME:-}
  [[ -n "$start" && -n "$end" ]] || { printf '?'; return 0; }   # bash older than 5.0 has no EPOCHREALTIME
  end=${end//[.,]/}
  printf '%d' $(((10#$end - 10#$start) / 1000))
}
log_lines() { # $1 = label, $2 = text
  local line
  [[ -n "$2" ]] || return 0
  while IFS= read -r line; do logf '  %s: %s' "$1" "$line"; done <<< "$2"
}
capture() {
  local errfile started=${EPOCHREALTIME:-}
  errfile=$(mktemp "${TMPDIR:-/tmp}/vocalis-satellite-setup.XXXXXX" 2>/dev/null) || errfile=/dev/null
  [[ "$errfile" == /dev/null ]] || TMP_FILES+=("$errfile")
  CAP_RC=0
  CAP_OUT=$("$@" 2>"$errfile") || CAP_RC=$?
  CAP_ERR=""
  if [[ "$errfile" != /dev/null ]]; then CAP_ERR=$(<"$errfile"); rm -f -- "$errfile"; fi
  logf 'Ran: %s  (exit status %d, %s ms)' "$*" "$CAP_RC" "$(elapsed_ms "$started")"
  log_lines stdout "$CAP_OUT"
  log_lines stderr "$CAP_ERR"
}
# Shows the tool's standard error from the last capture on this program's standard error (see the rule above).
show_tool_stderr() {
  local line
  [[ -n "$CAP_ERR" ]] || return 0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ "$VERBOSE" == 1 || "$line" != INFO:* ]]; then printf '%s\n' "$line" >&2; fi
  done <<< "$CAP_ERR"
}
# Shows everything from the last capture's standard error (a failed call: the reason is the point).
show_all_stderr() { [[ -z "$CAP_ERR" ]] || printf '%s\n' "$CAP_ERR" >&2; }

# oneshot SUB IMAGE [ARGS...]: the container with the terminal (provision at the prompt) or as the caller redirects it.
oneshot() {
  oneshot_args "$@"
  docker "${ONESHOT_ARGS[@]}"
}
oneshot_capture() {
  oneshot_args "$@"
  capture docker "${ONESHOT_ARGS[@]}"
}

# The long-lived container. --log-driver json-file comes immediately before the two --log-opt arguments: a daemon whose
# default log driver is journald (Fedora and RHEL packages) refuses --log-opt max-size (code review, October 10, 2026).
# The spec hash is the SHA-256 of the ordered argument list after `run -d`, without the
# hash label itself, the arguments encoded as UTF-8 and joined by a line feed (no trailing one). A change of any
# argument (port, image, folder, GPU groups) therefore recreates the container; nothing else does.
# October 11, 2026: the `--restart` token carries the recorded AUTOSTART value (on is `unless-stopped`, as always; off is
# `no`). The function takes the value as its argument and defaults to on, so the hash for on is the one it always was
# (the golden vector and its tests are untouched). A container's label cannot be rewritten, so a container whose label
# equals the hash made under EITHER value has the current settings (see plan_container).
CONTAINER_ARGS=()
SPEC_HASH=""
build_container_args() {
  local autostart=${1:-on} restart_policy=unless-stopped
  local -a before after hashed
  if [[ "$autostart" == off ]]; then restart_policy=no; fi
  build_gpu_args
  before=(
    --name "$CONTAINER_NAME" --restart "$restart_policy" --read-only --user "$SERVICE_UID:$SERVICE_GID"
    --tmpfs /tmp:rw,noexec,nosuid,size=512m --log-driver json-file --log-opt max-size=10m --log-opt max-file=3
    --label "vocalis.satellite.id=$SATELLITE_ID"
  )
  after=(
    --publish "0.0.0.0:$SATELLITE_PORT:7880"
    --mount "$(mount_arg "$ROOT/data" /data/vocalis-satellite ro)"
    --mount "$(mount_arg "$ROOT/secrets" /run/secrets ro)"
    --mount "$(mount_arg "$ROOT/logs" /logs/vocalis-satellite)"
    --mount "$(mount_arg "$ROOT/work" /work/vocalis-satellite)"
    --mount "$(mount_arg "$ROOT/cache" /cache/vocalis)"
    --mount "$(mount_arg "$ROOT/models" /models/vocalis ro)"
    "${GPU_ARGS[@]}"
    "$SATELLITE_IMAGE"
  )
  hashed=("${before[@]}" "${after[@]}")
  SPEC_HASH=$(printf '%s' "$(join_by $'\n' "${hashed[@]}")" | sha256sum | cut -d' ' -f1)
  CONTAINER_ARGS=("${before[@]}" --label "vocalis.satellite.spec=$SPEC_HASH" "${after[@]}")
}

# ---------------------------------------------------------------------------------------------------------------
# The kept setup script and the `vocalis-satellite` command (design section 9, "Linux: Docker is the daemon, and one
# command controls it", October 11, 2026). Docker, a system service, is the daemon: it starts the container at boot
# (when AUTOSTART is on and the satellite had not been stopped) and restarts it if it crashes. No systemd unit of our own
# is added. What was missing is a plain way to run it, so a successful setup writes ~/.local/bin/vocalis-satellite.
# ---------------------------------------------------------------------------------------------------------------

# The mark is the command file's second line, exactly. Setup overwrites or deletes only a regular file that carries it;
# anything else at that path, a symbolic link included, is the user's own and is left alone.
COMMAND_MARK='# vocalis-satellite: written by Vocalis satellite setup; setup replaces this file.'
KEPT_SCRIPT="$ROOT/satellite-setup.sh"
COMMAND_STATE=""   # installed, other (another satellite's command), foreign (not ours), nohome or nodir
COMMAND_PATH=""

command_marked() {
  local second
  [[ -f "$1" && ! -L "$1" ]] || return 1
  second=$(sed -n '2p' "$1" 2>/dev/null || true)
  [[ "$second" == "$COMMAND_MARK" ]]
}

# The folder a marked command was written for: its third line, ROOT='...'. Prints nothing when it cannot be read.
command_root() {
  local third
  third=$(sed -n '3p' "$1" 2>/dev/null || true)
  if [[ "$third" =~ ^ROOT=\'(.*)\'$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
  return 0
}

# The command itself: three fixed header lines and the folder and container as single-quoted assignments (an apostrophe in
# the folder is already refused), then a fixed body. The body gets everything it shows from the kept copy of this script
# (--show-plan), so there is one reader of satellite.env.
write_command_file() {
  {
    printf '#!/usr/bin/env bash\n'
    printf '%s\n' "$COMMAND_MARK"
    printf "ROOT='%s'\n" "$ROOT"
    printf "CONTAINER='%s'\n" "$CONTAINER_NAME"
    cat <<'COMMAND_BODY'
set -u
KEPT="$ROOT/satellite-setup.sh"
declare -A PLAN=()

usage() {
  cat <<'USAGE'
vocalis-satellite: control the Vocalis render satellite on this computer.

  vocalis-satellite start                 Start the satellite (docker start).
  vocalis-satellite stop                  Stop it. This frees the card's memory at once.
  vocalis-satellite restart               Restart it.
  vocalis-satellite status                Running or stopped, since when, port and address, image, autostart, and
                                          the last five log lines.
  vocalis-satellite logs [-n N] [--no-follow]
                                          Follow the satellite's log, starting with its last 100 lines (-n N for
                                          another count; --no-follow prints them and returns).
  vocalis-satellite autostart on|off      on: after the computer or Docker restarts, a satellite that was running
                                          comes back; one you stopped stays stopped until you start it. off: it
                                          stays down until you start it, and it is also not restarted if it
                                          crashes. (Runs the kept setup script with --autostart.)
  vocalis-satellite certificate [--pem]   The certificate file to upload in Vocalis, its fingerprint, and the scp
                                          line that fetches it to the computer where your browser is. --pem
                                          prints the (public) certificate itself, for piping over ssh.
  vocalis-satellite help                  This text.

Docker is the daemon: it starts the satellite at boot (when autostart is on and you had not stopped it), so there is
no service to manage. Setup keeps a copy of itself at <folder>/satellite-setup.sh and this command uses that copy
(for example: bash <folder>/satellite-setup.sh --update).
USAGE
}

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# Nothing is changed when the satellite is not set up: the folder was deleted by hand.
require_folder() {
  [[ -f "$ROOT/satellite.env" ]] || die "The satellite is not set up: there is no satellite.env in $ROOT (was the folder deleted?). Nothing was changed. To set it up again, run the setup script you downloaded: bash satellite-setup.sh"
}

# $1 = what docker printed. Says why, in one line, and exits 1.
explain() {
  case "$1" in
    *"No such container"*)
      die "The satellite's container $CONTAINER does not exist (it was removed). Nothing was changed. To create it again, run: bash '$KEPT' --root '$ROOT'" ;;
  esac
  command -v docker >/dev/null 2>&1 || die "Docker is not installed (there is no docker command)."
  docker info >/dev/null 2>&1 || die "Docker is not running, or this user may not use it. Start Docker and run the command again."
  die "Docker said: $1"
}

# The facts come from the kept setup script's --show-plan: one reader of satellite.env.
load_plan() {
  local out line
  [[ -f "$KEPT" ]] || die "The kept setup script $KEPT is missing, so the satellite's settings cannot be read. Run the setup script you downloaded once more: bash satellite-setup.sh --root '$ROOT'"
  out=$(bash "$KEPT" --show-plan --root "$ROOT" 2>&1) || die "The satellite's settings could not be read: $out"
  while IFS= read -r line; do
    if [[ "$line" == *=* ]]; then PLAN[${line%%=*}]=${line#*=}; fi
  done <<< "$out"
  [[ "${PLAN[SATELLITE]:-}" == existing ]] || die "The satellite is not set up: the folder $ROOT has no usable satellite.env. Nothing was changed."
}

control() {
  local out
  require_folder
  if out=$(docker "$1" "$CONTAINER" 2>&1); then say "$2"; else explain "$out"; fi
}

primary_address() {
  local list=${PLAN[ADDRESSES]:-}
  printf '%s' "${list%%,*}"
}

status_command() {
  local info state started finished since address port meaning line
  require_folder
  load_plan
  info=$(docker container inspect --format '{{.State.Status}}|{{.State.StartedAt}}|{{.State.FinishedAt}}' "$CONTAINER" 2>&1) || explain "$info"
  IFS='|' read -r state started finished <<< "$info"
  case "$state" in
    running) since="running since $started" ;;
    restarting) since="restarting over and over (a crash loop; see the log lines below)" ;;
    *) since="stopped (state: $state, last stopped $finished)" ;;
  esac
  address=$(primary_address)
  port=${PLAN[PORT]:-}
  case "${PLAN[AUTOSTART]:-on}" in
    off) meaning="off (stays down until you start it; also not restarted if it crashes)" ;;
    *) meaning="on (comes back after a restart if it was running; a satellite you stopped stays stopped)" ;;
  esac
  say "Satellite ${PLAN[NAME]:-} (container $CONTAINER): $since"
  if [[ -n "$address" ]]; then say "  Port and address: $port, https://$address:$port"; else say "  Port and address: $port, no network address found"; fi
  say "  Image:            ${PLAN[IMAGE]:-}"
  say "  Autostart:        $meaning"
  say "  Last 5 log lines:"
  docker logs --tail 5 "$CONTAINER" 2>&1 | while IFS= read -r line; do say "    $line"; done
}

logs_command() {
  local count=100 follow=1 rc=0 probe
  while (($#)); do
    case "$1" in
      -n) [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || die "logs -n needs a number of lines."; count=$2; shift 2 ;;
      --no-follow) follow=0; shift ;;
      *) die "Unknown option for logs: $1 (use -n N or --no-follow)." ;;
    esac
  done
  require_folder
  if ((follow)); then docker logs --tail "$count" -f "$CONTAINER" || rc=$?; else docker logs --tail "$count" "$CONTAINER" || rc=$?; fi
  # 130 is Ctrl-C ending the follow: not a failure.
  if ((rc != 0 && rc != 130)); then
    if probe=$(docker container inspect --format '{{.Name}}' "$CONTAINER" 2>&1); then probe="docker logs exited with status $rc"; fi
    explain "$probe"
  fi
}

autostart_command() {
  case "${1:-}" in on|off) ;; *) die "Usage: vocalis-satellite autostart on|off" ;; esac
  require_folder
  [[ -f "$KEPT" ]] || die "The kept setup script $KEPT is missing. Run the setup script you downloaded once more: bash satellite-setup.sh --root '$ROOT' --autostart $1"
  exec bash "$KEPT" --root "$ROOT" --autostart "$1"
}

certificate_command() {
  local pem=0 file address fingerprint
  case "${1:-}" in
    "") ;;
    --pem) pem=1 ;;
    *) die "Usage: vocalis-satellite certificate [--pem]" ;;
  esac
  require_folder
  load_plan
  file=${PLAN[CERTIFICATE_FILE]:-}
  [[ -n "$file" && -f "$file" ]] || die "There is no certificate yet. Finish the setup first: bash '$KEPT' --root '$ROOT'"
  if ((pem)); then
    cat -- "$file"
    return 0
  fi
  address=$(primary_address)
  if [[ -z "$address" ]]; then address="<address of this computer>"; fi
  fingerprint=${PLAN[FINGERPRINT]:-}
  if [[ -z "$fingerprint" ]]; then fingerprint="not recorded yet (run: bash '$KEPT' --root '$ROOT')"; fi
  say "Certificate file to upload in Vocalis: $file"
  say "Fingerprint (SHA-256): $fingerprint"
  say "To fetch it to the computer where your browser is, run this on that computer:"
  say "  scp $(id -un)@$address:$file ."
  say "In Vocalis: Settings, Satellites, \"Upload certificate...\" on this satellite's row. Then tick its card."
}

verb=${1:-help}
if (($#)); then shift; fi
case "$verb" in
  start) control start "Started the satellite (container $CONTAINER)." ;;
  stop) control stop "Stopped the satellite (container $CONTAINER). This frees the card's memory at once." ;;
  restart) control restart "Restarted the satellite (container $CONTAINER)." ;;
  status) status_command ;;
  logs) logs_command "$@" ;;
  autostart) autostart_command "$@" ;;
  certificate) certificate_command "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
COMMAND_BODY
  }
}

# Installs ~/.local/bin/vocalis-satellite (mode 755). Never edits PATH or a shell start file. Sets COMMAND_STATE:
# installed; other (a marked command of another satellite whose folder still exists, left as it is: one satellite per
# user); foreign (a regular file without the mark, a symbolic link, or a folder: the user's own, left alone); nohome
# (HOME is not set) or nodir (the folder cannot be made or the file written). Never fails the run.
install_command() {
  local dir path tmp other_root
  COMMAND_STATE=""
  COMMAND_PATH=""
  if [[ -z "${HOME:-}" ]]; then
    errf 'WARNING: HOME is not set, so the vocalis-satellite command was not installed.\n'
    COMMAND_STATE=nohome
    return 0
  fi
  dir="$HOME/.local/bin"
  path="$dir/vocalis-satellite"
  COMMAND_PATH=$path
  if [[ -e "$path" || -L "$path" ]]; then
    if command_marked "$path"; then
      other_root=$(command_root "$path")
      if [[ -n "$other_root" && "$other_root" != "$ROOT" && -f "$other_root/satellite.env" ]]; then
        COMMAND_STATE=other
        outf 'The command %s belongs to another satellite (folder %s), which still exists, so it was left as it is. This satellite has no command of its own.\n' "$path" "$other_root"
        return 0
      fi
    else
      COMMAND_STATE=foreign
      outf '%s exists and was not written by this setup (a symbolic link or another file of yours), so it was left alone and no vocalis-satellite command was installed.\n' "$path"
      return 0
    fi
  fi
  if ! mkdir -p -- "$dir" 2>/dev/null; then
    errf 'WARNING: %s cannot be made, so the vocalis-satellite command was not installed.\n' "$dir"
    COMMAND_STATE=nodir
    return 0
  fi
  tmp="$dir/.vocalis-satellite.tmp.$$"
  TMP_FILES+=("$tmp")
  if { write_command_file > "$tmp"; } 2>/dev/null && chmod 755 -- "$tmp" 2>/dev/null && mv -f -- "$tmp" "$path" 2>/dev/null; then
    COMMAND_STATE=installed
    logf 'Command: installed %s for folder %s and container %s' "$path" "$ROOT" "$CONTAINER_NAME"
  else
    rm -f -- "$tmp"
    errf 'WARNING: %s could not be written, so the vocalis-satellite command was not installed.\n' "$path"
    COMMAND_STATE=nodir
  fi
}

# --remove deletes the command, but only when it is a regular file with the mark that was written for this folder.
REMOVED_COMMAND=0
remove_command() {
  local path other_root
  [[ -n "${HOME:-}" ]] || return 0
  path="$HOME/.local/bin/vocalis-satellite"
  if command_marked "$path"; then
    other_root=$(command_root "$path")
    if [[ "$other_root" == "$ROOT" ]]; then
      rm -f -- "$path"
      REMOVED_COMMAND=1
      outf 'Removed the command %s.\n' "$path"
    else
      outf 'The command %s belongs to another satellite (folder %s) and was left as it is.\n' "$path" "${other_root:-unknown}"
    fi
  fi
}

# Every successful run made from another file replaces <root>/satellite-setup.sh with that file (temporary name, then
# rename), so an update from a newer download refreshes it. Skipped when the running file is the kept copy or is not
# a regular file (a piped script). The command always calls the kept copy.
keep_script() {
  local running tmp
  if [[ ! -f "$0" ]]; then
    logf 'Kept script: the running file %s is not a regular file, so it was not copied.' "$0"
    return 0
  fi
  running=$(realpath -- "$0" 2>/dev/null) || running=$0
  if [[ "$running" == "$(realpath -m -- "$KEPT_SCRIPT")" ]]; then
    logf 'Kept script: this run is the kept copy.'
    return 0
  fi
  if [[ -d "$KEPT_SCRIPT" ]]; then
    errf 'WARNING: %s is a folder, so this script was not kept there.\n' "$KEPT_SCRIPT"
    return 0
  fi
  tmp="$ROOT/.satellite-setup.sh.tmp.$$"
  TMP_FILES+=("$tmp")
  if cp -- "$running" "$tmp" 2>/dev/null && chmod 755 -- "$tmp" 2>/dev/null && mv -f -- "$tmp" "$KEPT_SCRIPT" 2>/dev/null; then
    logf 'Kept script: copied %s to %s' "$running" "$KEPT_SCRIPT"
  else
    rm -f -- "$tmp"
    errf 'WARNING: this script could not be copied to %s; the vocalis-satellite command needs that copy.\n' "$KEPT_SCRIPT"
  fi
}

# The last line of every run's closing lines: how to run the satellite. The command's full path when ~/.local/bin is not
# on PATH (setup does not change PATH); the docker commands when no command could be installed.
print_run_line() {
  local on_path=0
  if [[ -n "${HOME:-}" ]]; then
    case ":${PATH:-}:" in *":$HOME/.local/bin:"*) on_path=1 ;; esac
  fi
  if [[ "$COMMAND_STATE" == installed ]]; then
    if ((on_path)); then
      outf 'To run it: vocalis-satellite start | stop | status | logs\n'
    else
      outf 'To run it: %s start | stop | status | logs   (%s is not on your PATH; setup does not change it)\n' "$COMMAND_PATH" "${COMMAND_PATH%/*}"
    fi
  else
    outf 'To run it: docker start %s | docker stop %s | docker logs --tail 100 -f %s\n' "$CONTAINER_NAME" "$CONTAINER_NAME" "$CONTAINER_NAME"
  fi
}

# ---------------------------------------------------------------------------------------------------------------
# Remove
# ---------------------------------------------------------------------------------------------------------------

# October 11, 2026 (live test): the two small operations print nothing under "[1/2] Checks" otherwise, because the
# "Satellite folder:" line below belongs to the setup path. The design keeps one line naming the satellite folder there;
# satellite-setup.ps1 prints this same sentence for these two operations.
if [[ "$REMOVE" == 1 || "$SMALL_OP" == 1 ]]; then
  outf 'Satellite %s in %s.\n' "$SATELLITE_ID" "$ROOT"
fi

if [[ "$REMOVE" == 1 ]]; then
  step 2 'Remove the container'
  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    # Stop it properly first, so the satellite writes its "exiting" line and the break line to its log before it goes
    # (October 11, 2026; it exits within a second, and an image from before it handled the stop signal is ended by
    # Docker after 5 seconds). The result does not matter: the removal below is forced.
    capture docker stop -t 5 "$CONTAINER_NAME" || true
    capture docker rm -f "$CONTAINER_NAME"
    if ((CAP_RC != 0)); then
      show_all_stderr
      fail "Docker could not remove the container $CONTAINER_NAME."
    fi
    outf 'Removed the container %s.\n' "$CONTAINER_NAME"
  else
    outf 'There is no container named %s (nothing to remove).\n' "$CONTAINER_NAME"
  fi
  remove_command
  keep_script
  outf 'The satellite folder was left in place: %s\n' "$ROOT"
  outf 'It still holds the secret, the certificate and the model files. Delete it yourself if you no longer want it.\n'
  if [[ -n "$LOG_FILE" ]]; then outf 'Log of this run: %s\n' "$LOG_FILE"; fi
  if [[ -f "$KEPT_SCRIPT" ]]; then
    outf 'To bring the satellite back (nothing has to be paired again): bash %s\n' "$KEPT_SCRIPT"
  else
    outf 'To bring the satellite back (nothing has to be paired again), run the setup command again.\n'
  fi
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------
# The small --autostart operation (script change 5)
# ---------------------------------------------------------------------------------------------------------------
# --autostart on|off alone, on a folder whose satellite.env was accepted, is always this operation, whatever state the
# folder is in (it never turns into a resumed first setup, which would ask for a secret). Docker had to answer (checked
# above), or nothing would have been recorded and the file and the container could come to disagree. It records the
# value and, when the container exists, runs ONE `docker update --restart <policy>` on it: no pull, no model check, no
# recreate, no restart. If Docker refuses the update, the recorded value is put back and the reason shown.
if [[ "$SMALL_OP" == 1 ]]; then
  step 2 'Start with Docker'
  policy=unless-stopped
  if [[ "$AUTOSTART_ARG" == off ]]; then policy=no; fi
  previous_autostart=$AUTOSTART_RECORDED
  logf 'Autostart: recorded %s, asked for %s, restart policy %s' "$previous_autostart" "$AUTOSTART_ARG" "$policy"
  # The file as it is now is kept aside, so that a refused update puts back exactly these bytes (an older file without the
  # AUTOSTART and CERT_FINGERPRINT lines stays as it was).
  env_backup="$ROOT/.satellite.env.backup.$$"
  TMP_FILES+=("$env_backup")
  cp -p -- "$ENV_FILE" "$env_backup"
  AUTOSTART=$AUTOSTART_ARG
  write_env
  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    capture docker update --restart "$policy" "$CONTAINER_NAME"
    if ((CAP_RC != 0)); then
      mv -f -- "$env_backup" "$ENV_FILE"
      AUTOSTART=$previous_autostart
      logf 'Restored satellite.env to its earlier contents after the refused docker update'
      show_all_stderr
      fail "Docker refused to change the restart policy of $CONTAINER_NAME (exit status $CAP_RC: ${CAP_ERR:-no reason given}). The setting was put back to $previous_autostart."
    fi
    outf 'Start with Docker is now %s for the container %s (restart policy %s).\n' "$AUTOSTART" "$CONTAINER_NAME" "$policy"
  else
    outf 'Start with Docker is now %s. There is no container %s yet; the setting applies when it is created.\n' "$AUTOSTART" "$CONTAINER_NAME"
  fi
  if [[ "$AUTOSTART" == on ]]; then
    outf 'After the computer or Docker restarts, a satellite that was running comes back; one you stopped stays stopped until you start it.\n'
  else
    outf 'The satellite stays down after a restart until you start it, and it is also not restarted if it crashes.\n'
  fi
  keep_script
  install_command
  if [[ -n "$LOG_FILE" ]]; then outf 'Log of this run: %s\n' "$LOG_FILE"; fi
  print_run_line
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------
# Step 1, continued: the rest of the checks, all before anything is created
# ---------------------------------------------------------------------------------------------------------------

container_status() { docker container inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null; }

port_in_use() { (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1; }

# Whether the secret has to come from the user in this run: it is missing, or --new-secret was given.
SECRET_PRESENT=0
if [[ "$EXISTING" == 1 && -s "$ROOT/secrets/vocalis-satellite-master" ]]; then SECRET_PRESENT=1; fi
NEED_SECRET_INPUT=0
if [[ "$UPDATE" == 0 ]] && { [[ "$SECRET_PRESENT" == 0 ]] || [[ "$NEW_SECRET" == 1 ]]; }; then NEED_SECRET_INPUT=1; fi
if [[ "$NEED_SECRET_INPUT" == 1 && -z "$SECRET_FILE" && ! -t 0 ]]; then
  fail "The secret has to be typed (or read from a file), and this command has no terminal to ask on. Run it from a terminal, or give the secret in a file with --secret-file PATH (create the file in a text editor, not with echo)."
fi
# The secret file is mounted, and --secret-from-file passed, only when a secret is actually needed.
if [[ "$NEED_SECRET_INPUT" == 0 && -n "$SECRET_FILE" ]]; then
  outf 'The --secret-file was not needed: a secret already exists. Use --new-secret to replace it. The file is not used.\n'
  SECRET_FILE=""
fi

# Whether a certificate will be made in this run: a new folder, --new-certificate, or neither certificate file exists.
# (Only one of the two present is a broken pair; the tool refuses it with exit 5 and never recreates it.)
CERT_WILL_BE_MADE=0
if [[ "$NEW_RUN" == 1 || "$NEW_CERT" == 1 ]] || [[ ! -e "$ROOT/data/certs/cert.pem" && ! -e "$ROOT/data/certs/key.pem" ]]; then CERT_WILL_BE_MADE=1; fi

# --update needs a complete folder: it changes only the image, so a missing secret, certificate or configuration must
# be finished by a plain run first (before anything is pulled).
if [[ "$UPDATE" == 1 ]]; then
  # The same definition as --show-plan's SETUP_FINISHED (setup_finished above); a refused --update stays refused, and a
  # plain run with another --image adopts it instead (see the image check near the top of the folder handling).
  if ! setup_finished; then
    fail "This satellite folder is incomplete (missing: $(join_by ', ' "${MISSING_FILES[@]}")), so it cannot be updated yet. Finish setup first by running the same command as before without --update."
  fi
fi

# The port must be free, except that on a later run this folder's own running container is what holds it. This
# includes --update (before anything is pulled or recorded): when the container is not running and something else
# holds the port, the recreate at the end would fail after a 10 GB pull and a changed satellite.env.
#
# A container of this satellite in state "restarting" counts as holding it too (its restart policy keeps taking the
# port between crashes), so a crash-looping satellite gets the crash-loop message later, not a port refusal here.
status_now=$(container_status || true)
if [[ "$status_now" != running && "$status_now" != restarting ]]; then
  if port_in_use "$SATELLITE_PORT"; then
    if [[ "$EXISTING" == 1 ]]; then
      fail "Port $SATELLITE_PORT is already in use on this computer, and the holder is not this satellite (its container is not running). The port is fixed for this satellite folder, so stop whatever uses it and run the command again."
    fi
    fail "Port $SATELLITE_PORT is already in use on this computer. Stop whatever uses it, or choose another with --port (only possible for a new satellite folder)."
  fi
fi

# A missing address is a refusal only when a certificate must be made now; otherwise the existing certificate
# decides, and the primary address (used for the URL hint and the address check) is simply unknown. --update
# collects them too, for the address check at its end. They are shown in step 4 ("Addresses").
ADDRESSES_FOUND=1
if ! collect_addresses; then
  ADDRESSES_FOUND=0
  if [[ "$CERT_WILL_BE_MADE" == 1 ]]; then
    fail "No network address of this computer was found. Give one with --address 192.168.x.y (the address the Vocalis computer uses to reach this one)."
  fi
fi

if [[ "$NEW_RUN" == 1 ]]; then
  # October 11, 2026 (live test): the old text said "will download" even when the image was already on this computer.
  # This wording is true either way, and is the same in satellite-setup.ps1 (where it is a -Verbose line).
  outf 'Setup needs the satellite image (about 10 GB) and the Chatterbox model files (about 3.2 GB). Whatever is not already on this computer is downloaded; setup can be run again to resume.\n'
  IP_ADDRESSES=("${ALL_IPS[@]}")
  DNS_NAMES=(${EXTRA_DNS[@]+"${EXTRA_DNS[@]}"})
  mkdir -p -- "$ROOT"
  write_env
  # satellite.env now exists: from here on the run has a log and a result file (script changes 2 and 4).
  accept_folder 1
  outf 'Created satellite %s in %s (%s, port %s).\n' "$SATELLITE_ID" "$ROOT" "$GPU_VARIANT" "$SATELLITE_PORT"
else
  # The adopted image is recorded now, before the pull, so a run that fails later leaves the folder asking for the right
  # image, the same moment a new folder's satellite.env is first written.
  if [[ "$IMAGE_ADOPTED" == 1 ]]; then write_env; fi
  outf 'Satellite folder: %s (satellite %s, %s, port %s).\n' "$ROOT" "$SATELLITE_ID" "$GPU_VARIANT" "$SATELLITE_PORT"
fi
logf 'Run: mode=%s autostart=%s (recorded %s) secret-needed=%s certificate-made=%s existing=%s' "$(result_mode)" "$AUTOSTART" "$AUTOSTART_RECORDED" "$NEED_SECRET_INPUT" "$CERT_WILL_BE_MADE" "$EXISTING"

# The folders the containers mount, made by this user. --mount fails on a missing source, which is what lets a
# resumed run notice a folder someone removed instead of Docker creating an empty root-owned one. A folder that is
# a link is refused: Docker would follow it somewhere this script has not checked.
for sub in data data/certs secrets logs work cache models; do
  [[ ! -L "$ROOT/$sub" ]] || fail "$ROOT/$sub must be a real folder, not a link."
  [[ ! -e "$ROOT/$sub" || -d "$ROOT/$sub" ]] || fail "$ROOT/$sub exists and is not a folder."
  mkdir -p -- "$ROOT/$sub"
done

# ---------------------------------------------------------------------------------------------------------------
# Steps 2 and 3: the image and the GPU
# ---------------------------------------------------------------------------------------------------------------

# The same local-image skip as setup.sh: a reference Docker already resolves (a locally built image answers to
# <name>@sha256:<image id>) is not pulled.
#
# The pull (script change 1, per-call table): when standard output is a terminal, Docker's own progress display is
# shown directly and the log gets the command and the exit status only; otherwise (under the setup program, or with the
# output redirected) the lines are read and shown one by one, and every line goes to the log.
ensure_image() {
  local ref=$1 status=0 line
  if docker image inspect "$ref" >/dev/null 2>&1; then
    outf 'Image found locally, not pulled: %s\n' "$ref"
  else
    outf 'Pulling the image (about 10 GB): %s\n' "$ref"
    if [[ -t 1 ]]; then
      docker pull "$ref" || status=$?
      logf 'Ran: docker pull %s  (exit status %d; Docker showed its progress on the terminal, which the log does not hold)' "$ref" "$status"
    else
      set +e
      docker pull "$ref" 2>&1 | while IFS= read -r line; do outf '%s\n' "$line"; done
      status=${PIPESTATUS[0]}
      set -e
      logf 'Ran: docker pull %s  (exit status %d)' "$ref" "$status"
    fi
    ((status == 0)) || fail "The image could not be pulled: $ref. Check the reference and the network, then run the same command again."
  fi
}

# A visible NVIDIA runtime or the presence of device nodes proves nothing about the container, and the satellite
# would otherwise start, report "listening" and offer no cards. Prints the cards PyTorch can use; fails without one.
check_gpu() {
  local image=${1:-$IMAGE} out rc=0 line count=0
  outf 'Checking that the container can use a GPU card...\n'
  oneshot_capture check-gpu "$image"
  out=$CAP_OUT
  rc=$CAP_RC
  show_tool_stderr
  if ((rc == 3)); then
    fail "The container found no GPU card it can use. Check the driver and the NVIDIA Container Toolkit (NVIDIA) or the /dev/kfd and /dev/dri permissions (AMD), then run the same command again."
  elif ((rc != 0)); then
    fail "The GPU check failed (exit status $rc); see the message above. Nothing was started."
  fi
  while IFS= read -r line; do
    if [[ "$line" == card=* ]]; then
      line=${line#card=}
      outf '  GPU card %s: %s\n' "${line%%$'\t'*}" "${line#*$'\t'}"
      count=$((count + 1))
    fi
  done <<< "$out"
  ((count > 0)) || fail "The GPU check printed no cards. Nothing was started."
}

# What the container will be told to do, decided from Docker's current state: create (missing), recreate (its
# spec label differs), start (same label, stopped), restarting (same label, in a restart loop) or leave (same label,
# running).
#
# October 11, 2026 (autostart): a container's label cannot be rewritten, so a container whose label equals the hash of the
# present specification made under EITHER restart value has the current settings. The script then makes the
# container's actual restart policy (the inspect format gains .HostConfig.RestartPolicy.Name) match the recorded
# AUTOSTART with `docker update --restart` when they differ (POLICY_FIX, applied by apply_container). This is the one
# place the Linux script compares the label.
PLAN=""
POLICY_FIX=""
plan_container() {
  local info status rest label policy wanted other=off
  [[ "$AUTOSTART" == on ]] || other=on
  build_container_args "$other"
  ALT_SPEC_HASH=$SPEC_HASH
  build_container_args "$AUTOSTART"
  wanted=unless-stopped
  [[ "$AUTOSTART" == on ]] || wanted=no
  PLAN=create
  POLICY_FIX=""
  if info=$(docker container inspect --format '{{.State.Status}}|{{index .Config.Labels "vocalis.satellite.spec"}}|{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER_NAME" 2>/dev/null); then
    status=${info%%|*}
    rest=${info#*|}
    label=${rest%%|*}
    policy=${rest#*|}
    [[ -n "$policy" ]] || policy=no   # Docker reports the default policy as "no" (older ones as empty)
    logf 'Container plan: status=%s label=%s hash-now=%s hash-other-restart-value=%s policy=%s wanted-policy=%s' "$status" "$label" "$SPEC_HASH" "$ALT_SPEC_HASH" "$policy" "$wanted"
    if [[ "$label" != "$SPEC_HASH" && "$label" != "$ALT_SPEC_HASH" ]]; then
      PLAN=recreate
    else
      # The current settings under either restart value; only the policy may need correcting.
      if [[ "$policy" != "$wanted" ]]; then POLICY_FIX=$wanted; fi
      if [[ "$status" == running ]]; then
        PLAN=leave
      elif [[ "$status" == restarting ]]; then
        # Docker's restart policy is bringing it back over and over: a crash loop. `docker start` does nothing for a
        # restarting container (its StartedAt stays that of the last crashed run), so it is its own plan.
        PLAN=restarting
      else
        PLAN=start
      fi
    fi
  fi
  logf 'Container plan decided: %s (restart policy correction: %s)' "$PLAN" "${POLICY_FIX:-none}"
}
ALT_SPEC_HASH=""

# ---------------------------------------------------------------------------------------------------------------
# The wait (design section 9, "The wait")
# ---------------------------------------------------------------------------------------------------------------

# After a create, start or restart: wait up to 180 seconds for a `listening on https://` line written since that
# moment. The start time is read from Docker (the daemon's own clock, so a skewed clock on this machine cannot hide
# a line). It stops early, printing the end of the log, when the container has exited or restarted.
wait_listening() {
  local started restarts logs state deadline rounds=0
  started=$(docker container inspect --format '{{.State.StartedAt}}' "$CONTAINER_NAME") || fail "Docker cannot inspect $CONTAINER_NAME."
  restarts=$(docker container inspect --format '{{.RestartCount}}' "$CONTAINER_NAME") || fail "Docker cannot inspect $CONTAINER_NAME."
  deadline=$(($(clock_now) + LISTEN_WAIT_SECONDS))
  logf 'Waiting up to %d seconds for the satellite to report that it is listening (started %s, restarts %s)' "$LISTEN_WAIT_SECONDS" "$started" "$restarts"
  while :; do
    rounds=$((rounds + 1))
    # The state is checked BEFORE the log on every round: a crash loop leaves "listening" lines of earlier runs in the
    # log, and reading the log first could report success for a container that is no longer running.
    state=$(docker container inspect --format '{{.State.Status}} {{.RestartCount}} {{.State.StartedAt}}' "$CONTAINER_NAME" 2>/dev/null || true)
    if [[ "$state" != "running $restarts $started" ]]; then
      errf 'The satellite container stopped or restarted before it reported that it was listening (state: %s). The end of its log:\n' "${state:-gone}"
      print_log_tail
      fail "The satellite did not start. The log above says why; fix that and run the same command again."
    fi
    logs=$(docker logs --since "$started" "$CONTAINER_NAME" 2>&1 || true)
    if [[ "$logs" == *"listening on https://"* ]]; then
      logf 'The listening line was found after %d round(s)' "$rounds"
      outf 'The satellite is listening.\n'
      return 0
    fi
    if (($(clock_now) >= deadline)); then
      errf 'The end of the satellite log:\n'
      print_log_tail
      fail "The satellite did not report that it was listening within $LISTEN_WAIT_SECONDS seconds. Run the same command again to check on it; the log above may say why."
    fi
    pause "$LISTEN_POLL_SECONDS"
  done
}

# The end of the satellite's own log, on standard error and in the setup log: shown when the satellite does not come up.
print_log_tail() {
  local text
  text=$(docker logs --tail 40 "$CONTAINER_NAME" 2>&1 || true)
  errf '%s\n' "$text"
}

# Applies the recreate rule (design section 9, "When the container is recreated"). $1 = 1 restarts an identical
# running container too (a replaced secret or certificate is read once, at the satellite's start).
apply_container() {
  local force_restart=${1:-0}
  plan_container
  # What is about to happen, in words (October 11, 2026: this line used to print the plan's internal word,
  # "Container <name>: leave."). A container that is left running or is in a crash loop gets its own line further down.
  case "$PLAN" in
    create) outf 'Creating the satellite container %s.\n' "$CONTAINER_NAME" ;;
    recreate) outf 'The container %s was made with other settings: removing it and creating it again.\n' "$CONTAINER_NAME" ;;
    start) outf 'The container %s is stopped: starting it.\n' "$CONTAINER_NAME" ;;
  esac
  logf 'Container %s: %s' "$CONTAINER_NAME" "$PLAN"
  # The container has the current settings under the other restart value: correct its actual policy to the recorded one
  # (the label cannot be rewritten). Not for create or recreate, which build it with the recorded value.
  if [[ -n "$POLICY_FIX" ]]; then
    capture docker update --restart "$POLICY_FIX" "$CONTAINER_NAME"
    if ((CAP_RC != 0)); then
      show_all_stderr
      fail "Docker could not change the restart policy of $CONTAINER_NAME to $POLICY_FIX (exit status $CAP_RC)."
    fi
    outf 'The restart policy of %s is now %s (start with Docker: %s).\n' "$CONTAINER_NAME" "$POLICY_FIX" "$AUTOSTART"
  fi
  case "$PLAN" in
    create|recreate)
      if [[ "$PLAN" == recreate ]]; then
        # Stop it properly first, so the satellite writes its "exiting" line and the break line to its log before it goes
        # (October 11, 2026; it exits within a second, and an image from before it handled the stop signal is ended by
        # Docker after 5 seconds). The result does not matter: the removal below is forced.
        capture docker stop -t 5 "$CONTAINER_NAME" || true
        capture docker rm -f "$CONTAINER_NAME"
        if ((CAP_RC != 0)); then show_all_stderr; fail "Docker could not remove the old container $CONTAINER_NAME."; fi
      fi
      capture docker run -d "${CONTAINER_ARGS[@]}"
      if ((CAP_RC != 0)); then
        show_all_stderr
        # A failed publish leaves a created container behind; take it away so a rerun starts clean.
        capture docker rm -f "$CONTAINER_NAME" || true
        fail "Docker could not start the satellite container (see the message above). If the port is in use, stop the program that uses it; for a new satellite folder you can delete the folder and run setup again with --port."
      fi
      wait_listening
      ;;
    start)
      capture docker start "$CONTAINER_NAME"
      if ((CAP_RC != 0)); then show_all_stderr; fail "Docker could not start $CONTAINER_NAME."; fi
      wait_listening
      ;;
    restarting)
      if [[ "$force_restart" == 1 ]]; then
        # This run replaced the secret or the certificate (often the repair for exactly this crash loop): restart the
        # container so it reads them, then wait as usual.
        outf 'Restarting the satellite so that it reads what was replaced.\n'
        capture docker restart "$CONTAINER_NAME"
        if ((CAP_RC != 0)); then show_all_stderr; fail "Docker could not restart $CONTAINER_NAME."; fi
        wait_listening
      else
        errf 'The satellite container is restarting over and over (a crash loop), so it is not running. The end of its log:\n'
        print_log_tail
        fail "The satellite keeps crashing; the log above says why. If it is the secret or the certificate, replace it with --new-secret or --new-certificate (which also restart it); otherwise fix the cause and run the same command again."
      fi
      ;;
    leave)
      if [[ "$force_restart" == 1 ]]; then
        outf 'Restarting the satellite so that it reads what was replaced.\n'
        capture docker restart "$CONTAINER_NAME"
        if ((CAP_RC != 0)); then show_all_stderr; fail "Docker could not restart $CONTAINER_NAME."; fi
        wait_listening
      else
        outf 'The satellite container is already running with these settings; left as it is.\n'
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------------
# Provision, show, model
# ---------------------------------------------------------------------------------------------------------------

SHOW_FINGERPRINT=""
SHOW_IPS=()
SHOW_DNS=()
# `show` prints the certificate's fingerprint and addresses, for the closing lines and for the address check.
run_show() {
  local out rc=0 line
  # Only the exit code and stdout are the contract. The call is captured: the log gets every line, and the screen gets
  # the tool's standard error except its INFO: lines (all of it with --verbose).
  oneshot_capture show "$IMAGE"
  out=$CAP_OUT
  rc=$CAP_RC
  show_tool_stderr
  if ((rc != 0)); then
    if [[ "${UPDATED:-0}" == 1 ]]; then
      # After --update the image is recorded and the container recreated, so say what is true.
      fail "The satellite was updated to $IMAGE and is running; only the closing summary could not be read (exit status $rc; the message above says why). Run the setup command again to see the summary."
    fi
    fail "Reading the certificate failed (exit status $rc); the message above says what is wrong and what to do. The satellite container was not touched."
  fi
  SHOW_FINGERPRINT=""
  SHOW_IPS=()
  SHOW_DNS=()
  # The tool reports the certificate itself, so its lines include ip=127.0.0.1, dns=localhost and possibly IPv6
  # literals. Only IPv4 addresses make a satellite reachable (the client dials an IPv4 address), and loopback and
  # localhost are never recorded or shown as addresses to use.
  while IFS= read -r line; do
    line=${line%$'\r'}
    case "$line" in
      fingerprint=*) SHOW_FINGERPRINT=${line#fingerprint=} ;;
      ip=*)
        line=${line#ip=}
        if is_ipv4 "$line"; then
          case "$line" in 127.*) ;; *) SHOW_IPS+=("$line") ;; esac
        fi
        ;;
      dns=*)
        line=${line#dns=}
        if [[ "${line,,}" != localhost ]] && is_dns_name "$line"; then SHOW_DNS+=("${line,,}"); fi
        ;;
    esac
  done <<< "$out"
  [[ -n "$SHOW_FINGERPRINT" ]] || fail "The certificate check printed no fingerprint."
}

# Provision writes the secret, satellite.yaml and the certificate in one container run; each is kept when it
# already exists unless its replace option is given. It is skipped when nothing needs it. --ip and --dns are passed
# only when a certificate is going to be created (none yet, or --new-certificate); a kept certificate gets none.
# --secret-from-file is passed only when a secret is actually needed (SECRET_FILE is empty otherwise).
run_provision() {
  local -a extra=(--name "$SATELLITE_NAME")
  local ip dns rc=0
  if [[ "$CERT_WILL_BE_MADE" == 1 ]]; then
    for ip in ${CERT_IPS[@]+"${CERT_IPS[@]}"}; do extra+=(--ip "$ip"); done
    for dns in ${CERT_DNS[@]+"${CERT_DNS[@]}"}; do extra+=(--dns "$dns"); done
  fi
  [[ -z "$SECRET_FILE" ]] || extra+=(--secret-from-file)
  [[ "$NEW_SECRET" == 0 ]] || extra+=(--new-secret)
  [[ "$NEW_CERT" == 0 ]] || extra+=(--new-certificate)
  PROMPT_TTY=0
  if [[ "$NEED_SECRET_INPUT" == 1 && -z "$SECRET_FILE" ]]; then PROMPT_TTY=1; fi
  if [[ "$PROMPT_TTY" == 1 ]]; then
    # The one call that keeps the terminal (script change 1, per-call table): the hidden prompt needs it, so the tool's
    # INFO: lines show on screen too (the one stated exception to "quiet"). The log gets the exit status only; nothing
    # that was typed, and nothing the container printed, is in it.
    oneshot provision "$IMAGE" "${extra[@]}" || rc=$?
    logf 'Ran: docker %s  (exit status %d; the container kept the terminal for the secret prompt, so the log holds the exit status only)' "${ONESHOT_ARGS[*]}" "$rc"
  else
    oneshot_capture provision "$IMAGE" "${extra[@]}"
    rc=$CAP_RC
    show_tool_stderr
    # With --verbose the tool's key=value lines show as well, as they always did.
    if [[ "$VERBOSE" == 1 && -n "$CAP_OUT" ]]; then printf '%s\n' "$CAP_OUT"; fi
  fi
  PROMPT_TTY=0
  # The tool's message (stderr, already shown) says what is wrong and which option fixes it (for a stored secret that
  # is not valid it names --new-secret; for half a certificate pair, --new-certificate). Stop; never retry or replace
  # anything here.
  case "$rc" in
    0) ;;
    4) fail "The secret was not accepted or could not be used (exit status 4); the message above says what to do. Nothing was started." ;;
    5) fail "The configuration or the certificate is not usable (exit status 5); the message above says what to do. Nothing was started." ;;
    *) fail "Provisioning failed (exit status $rc); see the message above. Nothing was started." ;;
  esac
}

# The model fetch (script change 1, per-call table): its standard output is shown as it arrives (it already prints one line
# per file) and logged; its standard error goes to the log only, and is shown only when the download fails (or with
# --verbose), because then it is the reason.
fetch_model() {
  local image=$1 resume_hint=$2 errfile status=0 line started=${EPOCHREALTIME:-}
  outf 'Fetching and verifying the model files into %s/models (the first run is a large download).\n' "$ROOT"
  errfile=$(mktemp "${TMPDIR:-/tmp}/vocalis-satellite-setup.XXXXXX" 2>/dev/null) || errfile=/dev/null
  [[ "$errfile" == /dev/null ]] || TMP_FILES+=("$errfile")
  oneshot_args fetch-model "$image"
  set +e
  docker "${ONESHOT_ARGS[@]}" 2>"$errfile" | while IFS= read -r line; do outf '%s\n' "$line"; done
  status=${PIPESTATUS[0]}
  set -e
  CAP_ERR=""
  if [[ "$errfile" != /dev/null ]]; then CAP_ERR=$(<"$errfile"); rm -f -- "$errfile"; fi
  logf 'Ran: docker %s  (exit status %d, %s ms; its standard output is the lines above)' "${ONESHOT_ARGS[*]}" "$status" "$(elapsed_ms "$started")"
  log_lines stderr "$CAP_ERR"
  if ((status == 0)); then
    if [[ "$VERBOSE" == 1 ]]; then show_tool_stderr; fi
    outf 'Model files: every file is present and verified.\n'
  else
    show_tool_stderr
    fail "The model download did not finish. $resume_hint"
  fi
}

# The addresses that go into a certificate made by this run: the IPv4 addresses detected now, then this run's
# --address values (IPv4 addresses and names alike). Nothing is carried forward from the old certificate (a DHCP
# leftover would otherwise live on); the message before a --new-certificate lists what is dropped.
CERT_IPS=()
CERT_DNS=()
if [[ "$UPDATE" == 0 ]]; then
  CERT_IPS=(${ALL_IPS[@]+"${ALL_IPS[@]}"})
  CERT_DNS=(${EXTRA_DNS[@]+"${EXTRA_DNS[@]}"})
fi

SELF=$0

# The stop, start, update and remove commands. October 11, 2026: they left the closing lines (the guide, --help and the
# vocalis-satellite command have them); they are in the setup log, so the log is a complete record.
print_manage_lines() {
  logf 'To stop it:    docker stop %s' "$CONTAINER_NAME"
  logf 'To start it:   docker start %s   (or run the setup command again)' "$CONTAINER_NAME"
  # A copy with a stamped default image moves to it with plain --update (run from the newer release's file); an
  # unstamped copy needs the image typed.
  if [[ -n "$STAMPED_DEFAULT" ]]; then
    logf 'To update it:  bash %s --root %s --update   (run from the setup file of the newer release)' "$SELF" "$ROOT"
  else
    logf 'To update it:  bash %s --root %s --update --image NAME@sha256:<64 hex digits>' "$SELF" "$ROOT"
  fi
  logf 'To remove it:  bash %s --root %s --remove   (removes the container only; the folder stays)' "$SELF" "$ROOT"
}

# The address check on a later run (and the same check right after a certificate is made, and at the end of
# --update): if this machine's primary address, or an --address, is not in the certificate, the only symptom would be
# a certificate error in Vocalis, so say so. It is a warning: the satellite still works for the addresses the
# certificate holds. Needs SHOW_IPS / SHOW_DNS from run_show.
ADDRESS_WARNINGS=()
check_addresses() {
  local item
  ADDRESS_WARNINGS=()
  if [[ -n "$PRIMARY" ]] && ! in_list "$PRIMARY" ${SHOW_IPS[@]+"${SHOW_IPS[@]}"}; then
    ADDRESS_WARNINGS+=("This computer's primary address $PRIMARY is not in the certificate (the certificate holds: $(join_by ' ' ${SHOW_IPS[@]+"${SHOW_IPS[@]}"}))")
  fi
  for item in ${EXTRA_IPS[@]+"${EXTRA_IPS[@]}"}; do
    if ! in_list "$item" ${SHOW_IPS[@]+"${SHOW_IPS[@]}"}; then ADDRESS_WARNINGS+=("--address $item is not in the certificate"); fi
  done
  for item in ${EXTRA_DNS[@]+"${EXTRA_DNS[@]}"}; do
    if ! in_list "$item" ${SHOW_DNS[@]+"${SHOW_DNS[@]}"}; then ADDRESS_WARNINGS+=("--address $item is not in the certificate"); fi
  done
}
print_address_warnings() {
  local warning
  for warning in ${ADDRESS_WARNINGS[@]+"${ADDRESS_WARNINGS[@]}"}; do
    errf 'WARNING: %s. Vocalis would report a certificate error for that address. Run this command again with --new-certificate (and every --address you want) to make a certificate that holds it; Vocalis then needs the new file.\n' "$warning"
  done
}

# Step 4 ("Addresses") for the paths that print it: the addresses Vocalis can use, primary first (found by
# collect_addresses before anything was created), or the note that none was found when the existing certificate decides.
print_address_step() {
  if [[ "$ADDRESSES_FOUND" == 1 ]]; then
    print_addresses
  else
    outf 'No network address of this computer was found; the existing certificate is kept as it is.\n'
  fi
}

# ---------------------------------------------------------------------------------------------------------------
# The closing lines (script change 3): short, and they say one thing. Everything else that used to be here (the
# firewall and DOCKER-USER note, the stop, start, update and remove commands) is in the satellite guide, in --help
# and in the setup log.
# ---------------------------------------------------------------------------------------------------------------

# The certificate block, for a first setup and for a new certificate. $1 = new for a replaced certificate (the `upload`
# case of the result file): the first line says "new certificate" and the "Then tick its card" sentence is left out,
# because the cards stay ticked in Vocalis (design, script change 3; the Windows script prints the same two texts).
closing_upload_block() {
  local kind=${1:-first}
  if [[ "$kind" == new ]]; then
    outf '\nOne thing left: give Vocalis this satellite'"'"'s new certificate.\n'
  else
    outf '\nOne thing left: give Vocalis this satellite'"'"'s certificate.\n'
  fi
  outf '  File to upload:  %s\n' "$ROOT/data/certs/cert.pem"
  outf '  Fingerprint:     %s\n' "$SHOW_FINGERPRINT"
  outf 'If your browser is on another computer, copy that file there first.\n'
  if [[ "$kind" == new ]]; then
    outf 'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite'"'"'s row.\n'
  else
    outf 'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite'"'"'s row. Then tick its card.\n'
  fi
  if [[ -n "${URL_LIST[0]:-}" ]]; then outf 'Satellite address: %s\n' "${URL_LIST[0]}"; fi
}

# After an update, a new secret or a plain rerun: the sentence for that case, then the file and address lines "for
# reference".
closing_reference_lines() {
  outf '\nFor reference:\n'
  outf '  Certificate file:  %s\n' "$ROOT/data/certs/cert.pem"
  outf '  Fingerprint:       %s\n' "$SHOW_FINGERPRINT"
  if [[ -n "${URL_LIST[0]:-}" ]]; then outf '  Satellite address: %s\n' "${URL_LIST[0]}"; fi
}

print_closing() {
  local mode
  mode=$(result_mode)
  # The primary comes from this script's own route lookup, not from the order of the tool's ip= lines (the tool lists
  # them sorted, loopback among them).
  build_urls
  outf '\nSatellite %s (%s) is running.\n' "$SATELLITE_NAME" "$SATELLITE_ID"
  case "$mode" in
    first)
      # A first setup, or the rerun of one that stopped before the secret was given: it made the secret and the
      # certificate now, so the satellite cannot have been set up in Vocalis yet.
      closing_upload_block
      ;;
    renew)
      case "$(result_steps "$mode")" in
        # The run also made a secret or a certificate that did not exist (a satellite that was never finished): the
        # satellite cannot be set up in Vocalis yet, so this is the first-setup text, as in the Windows script.
        upload-and-tick) closing_upload_block ;;
        upload) closing_upload_block new ;;
        *)
          outf 'Vocalis now has the new secret; nothing else has to change there.\n'
          closing_reference_lines
          ;;
      esac
      ;;
    update)
      outf 'The satellite now runs %s.\n' "$IMAGE"
      outf 'It keeps its secret and certificate, so nothing has to be paired again in Vocalis.\n'
      closing_reference_lines
      ;;
    *)
      # Wording as the Vocalis Settings page has it: ticking a satellite's cards applies and loads them by itself (there
      # is no Load button); the round-arrow button on the satellite's row re-applies.
      # A run that made neither cannot tell whether Vocalis was ever set up (an earlier run may have stopped part
      # way), so it says both (the same text in the Windows script). The certificate file is named in the lines that
      # follow ("for reference"), after this text.
      outf '\nIf this satellite is already set up in Vocalis, nothing more has to be done there.\n'
      outf 'If it is not (for example an earlier run stopped part way), two steps are left in Vocalis:\n'
      outf '  1. Copy the certificate file named below to the computer where you use Vocalis in a browser, and choose "Upload certificate..." on the satellite'"'"'s row. Check that the fingerprint matches.\n'
      outf '  2. Tick the satellite'"'"'s cards in Settings. They load as soon as you tick them.\n'
      closing_reference_lines
      ;;
  esac
  if ((${#SHOW_IPS[@]} == 0)); then
    errf 'WARNING: the certificate has no IPv4 address, and Vocalis needs one. Run this command again with --address <IPv4 address of this computer> --new-certificate.\n'
  fi
  outf '\nIf Vocalis cannot reach this satellite, see the "Network" section of the satellite guide.\n'
  # What used to be printed here, kept in the log: the network note and the manage commands.
  logf 'Network: the satellite port %s is open on every address of this computer, because being called from another machine is its whole purpose. Docker opens a port it publishes even when a firewall such as ufw is turned on; to limit who can reach it, add a rule to Docker'"'"'s DOCKER-USER chain. Run a satellite only on a network you trust, and never forward its port from the internet. This script never changes a firewall.' "$SATELLITE_PORT"
  print_manage_lines
  if [[ "$NEWER_IMAGE_NOTICE" == 1 ]]; then
    outf '\nNOTE: this setup file is for a newer satellite image (%s) than the one this satellite runs (%s), which is kept. To move to the newer one, run: bash %s --root %s --update\n' "$STAMPED_DEFAULT" "$IMAGE" "$SELF" "$ROOT"
  fi
  print_address_warnings
}

# Everything a successful run does after the satellite is up, in order: keep this script, install the command, print
# the closing lines, name the log, and end with how to run it.
finish_run() {
  keep_script
  install_command
  print_closing
  if [[ -n "$LOG_FILE" ]]; then outf 'Log of this run: %s\n' "$LOG_FILE"; fi
  print_run_line
}

# ---------------------------------------------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------------------------------------------

if [[ "$UPDATE" == 1 ]]; then
  step 2 'Image'
  outf 'Updating the satellite %s to %s\n' "$SATELLITE_ID" "$IMAGE_ARG"
  ensure_image "$IMAGE_ARG"
  # The new image must find a card and its own model set must be complete BEFORE anything is recorded: a failure up
  # to here leaves the running satellite and satellite.env exactly as they were, and the same command resumes.
  step 3 'GPU'
  check_gpu "$IMAGE_ARG"
  step 4 'Addresses'
  print_address_step
  step 5 'Secret and certificate'
  outf 'Secret and certificate: kept (an update does not touch them).\n'
  step 6 'Model (Chatterbox, about 3.2 GB; files already present are verified, not downloaded again)'
  fetch_model "$IMAGE_ARG" "The running satellite and satellite.env were not changed; run the same --update command again to resume. Finished files are kept."
  step 7 'Start'
  SATELLITE_IMAGE=$IMAGE_ARG
  IMAGE=$IMAGE_ARG
  write_env
  apply_container 0
  UPDATED=1  # from here on the satellite is updated and running; run_show words its failure message accordingly
  step 8 'Done'
  run_show
  check_addresses
  finish_run
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------
# New secret, new certificate, and the first run / repair path
# ---------------------------------------------------------------------------------------------------------------

step 2 'Image'
ensure_image "$IMAGE"

# Step 3. Only when a container is going to be created: that is when a missing GPU would otherwise show up as a
# satellite that listens and offers no cards, and it must show up before the user is asked to paste a secret.
step 3 'GPU'
plan_container
if [[ "$PLAN" == create || "$PLAN" == recreate ]]; then
  check_gpu
else
  outf 'GPU: not checked again, because the container already exists with these settings.\n'
fi

step 4 'Addresses'
print_address_step

if [[ -n "$PRIMARY" ]]; then
  URL_HINT="https://$PRIMARY:$SATELLITE_PORT"
elif ((${#IP_ADDRESSES[@]})); then
  URL_HINT="https://${IP_ADDRESSES[0]}:$SATELLITE_PORT"
else
  URL_HINT="https://<this computer's address>:$SATELLITE_PORT"
fi
CERT_FILES_PRESENT=0
if [[ -s "$ROOT/data/certs/cert.pem" && -s "$ROOT/data/certs/key.pem" ]]; then CERT_FILES_PRESENT=1; fi
PROVISION_NEEDED=0
if [[ "$SECRET_PRESENT" == 0 || "$CERT_FILES_PRESENT" == 0 || ! -s "$ROOT/data/satellite.yaml" || "$NEW_SECRET" == 1 || "$NEW_CERT" == 1 ]]; then
  PROVISION_NEEDED=1
fi

step 5 'Secret and certificate'
if [[ "$PROVISION_NEEDED" == 1 ]]; then
  if [[ "$NEW_CERT" == 1 ]]; then
    outf 'Replacing the certificate. Vocalis must be given the new certificate file afterwards (Settings, Satellites).\n'
    outf 'Addresses for the new certificate: %s\n' "$(join_by ' ' ${CERT_IPS[@]+"${CERT_IPS[@]}"} ${CERT_DNS[@]+"${CERT_DNS[@]}"})"
    # The new certificate is made from the addresses detected now plus this run's --address values; nothing is carried
    # forward. Recorded addresses AND names that are not among them would be lost silently (a DHCP leftover, or an
    # --address from an earlier run), so name each one for the user to pass again.
    dropped=()
    for item in ${IP_ADDRESSES[@]+"${IP_ADDRESSES[@]}"}; do
      in_list "$item" ${CERT_IPS[@]+"${CERT_IPS[@]}"} || dropped+=("$item")
    done
    for item in ${DNS_NAMES[@]+"${DNS_NAMES[@]}"}; do
      in_list "$item" ${CERT_DNS[@]+"${CERT_DNS[@]}"} || dropped+=("$item")
    done
    if ((${#dropped[@]})); then
      outf 'The old certificate held these addresses and names, which will NOT be in the new one: %s\n' "$(join_by ' ' "${dropped[@]}")"
      outf 'If one of them is still needed, run this command again with --address for each (for example --address %s).\n' "${dropped[0]}"
    fi
  fi
  if [[ "$NEED_SECRET_INPUT" == 1 ]]; then
    if [[ "$NEW_SECRET" == 1 ]]; then
      outf '\nIn Vocalis, open Settings, Satellites, choose "New secret..." for this satellite, and copy the secret it shows (it is shown once).\n'
    else
      outf '\nNow add this satellite in Vocalis: Settings, Satellites, Add satellite, with the URL %s\n' "$URL_HINT"
      outf 'Vocalis shows a secret once.\n'
    fi
    if [[ -n "$SECRET_FILE" ]]; then
      outf 'Reading the secret from the file you gave.\n'
    else
      outf 'Paste the secret below; what you type is not shown. Empty input ends setup with nothing started.\n'
    fi
  fi
  run_provision
  # What this run made, as against kept: the result file's MADE_ keys and the lines below. (Which closing text is
  # printed follows the MODE of the run, see print_closing.)
  if [[ "$NEED_SECRET_INPUT" == 1 ]]; then
    MADE_SECRET=yes
    outf 'Secret: saved.\n'
  else
    outf 'Secret: kept (the one already there).\n'
  fi
  if [[ "$CERT_WILL_BE_MADE" == 1 ]]; then
    MADE_CERTIFICATE=yes
    if [[ "$NEW_CERT" == 1 ]]; then
      outf 'Certificate: made.\n'
    else
      outf 'Certificate: made. It covers: %s\n' "$(join_by ' ' ${CERT_IPS[@]+"${CERT_IPS[@]}"} ${CERT_DNS[@]+"${CERT_DNS[@]}"})"
    fi
  else
    outf 'Certificate: kept.\n'
  fi
else
  outf 'Secret and certificate: both kept (nothing to make).\n'
fi

run_show

# Record the addresses the certificate really holds (a resumed run may have kept an older certificate), and, in the same
# place, its fingerprint (only the one-shot `show` container can compute it; the read-only plan, the setup program and the
# vocalis-satellite command then need no container to show it). A satellite.env written before this version has no
# fingerprint line until the first run that gets here.
NEW_IPS=$(join_by , ${SHOW_IPS[@]+"${SHOW_IPS[@]}"})
NEW_DNS=$(join_by , ${SHOW_DNS[@]+"${SHOW_DNS[@]}"})
if [[ "$NEW_IPS" != "$(join_by , ${IP_ADDRESSES[@]+"${IP_ADDRESSES[@]}"})" || "$NEW_DNS" != "$(join_by , ${DNS_NAMES[@]+"${DNS_NAMES[@]}"})" || "$SHOW_FINGERPRINT" != "$CERT_FINGERPRINT" ]]; then
  logf 'Recording in satellite.env: addresses %s, names %s, fingerprint %s' "$NEW_IPS" "$NEW_DNS" "$SHOW_FINGERPRINT"
  IP_ADDRESSES=(${SHOW_IPS[@]+"${SHOW_IPS[@]}"})
  DNS_NAMES=(${SHOW_DNS[@]+"${SHOW_DNS[@]}"})
  CERT_FINGERPRINT=$SHOW_FINGERPRINT
  write_env
fi

check_addresses
print_address_warnings

# Step 6. A later run verifies the model too. This is not quick: the fetcher does not trust file names or sizes, it
# re-reads and hashes all of the model files (about 3.2 GB) on every run, and only downloads what is missing or wrong.
# Not for the two replace options, which only touch the secret or the certificate and never run fetch-model.
step 6 'Model (Chatterbox, about 3.2 GB; files already present are verified, not downloaded again)'
if [[ "$NEW_SECRET" == 0 && "$NEW_CERT" == 0 ]]; then
  fetch_model "$IMAGE" "Run the same command again to resume; finished files are kept."
else
  outf 'Model: not checked (--new-secret and --new-certificate only touch the secret or the certificate).\n'
fi

# Step 7. A replaced secret or certificate is read once, at the satellite's start, so both restart it. A --autostart
# given with this run is recorded first (when write_env above has not already), then the container follows it.
step 7 'Start'
if [[ "$AUTOSTART" != "$AUTOSTART_RECORDED" ]]; then write_env; fi
FORCE_RESTART=0
if [[ "$NEW_SECRET" == 1 || "$NEW_CERT" == 1 ]]; then FORCE_RESTART=1; fi
apply_container "$FORCE_RESTART"

step 8 'Done'
finish_run
