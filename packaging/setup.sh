#!/usr/bin/env bash
set -euo pipefail
umask 077

PACKAGING_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BASE_COMPOSE="$PACKAGING_DIR/compose.yaml"
CUDA_COMPOSE="$PACKAGING_DIR/compose.cuda.yaml"
ROCM_COMPOSE="$PACKAGING_DIR/compose.rocm.yaml"

usage() {
  cat <<'EOF'
Usage:
  setup.sh [--root PATH] [--variant cuda|rocm] [--vocalis-image REF] [--taproom-image REF]
            [--vocalis-port PORT] [--taproom-port PORT] [--seed-models DIR]...
  setup.sh --update --root PATH --vocalis-image REF --taproom-image REF [--seed-models DIR]...
  Either form also accepts --defer-start (used only by setup.ps1 on Windows).
  A new instance also accepts --vocalis-url URL and --taproom-url URL (the browser-facing addresses
  when a reverse proxy sits in front: https://host[:port], or http://127.0.0.1:port, no path) and
  --existing-data (Linux only): adopt data folders that an earlier standalone install already uses,
  placed (or linked) at the responsibility paths under the root, without converting anything.

Image references must include an immutable @sha256:<64 hex digits> digest.
--defer-start does everything else but does not start the services (no `compose up`): the Windows
launcher starts them from Windows so Docker Desktop can restart them by itself.
--seed-models DIR (repeatable) names another Vocalis data folder, or a models folder, whose verified
model files setup may copy instead of downloading them again. Setup also looks at the other instances
it can find on this machine; see the README.
The instance.env file contains deployment settings only; credentials and pairing tokens
are entered later through the applications.
EOF
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

ROOT_ARG=""
VARIANT_ARG=""
VOCALIS_IMAGE_ARG=""
TAPROOM_IMAGE_ARG=""
VOCALIS_PORT_ARG=""
TAPROOM_PORT_ARG=""
UPDATE=0
# Switching a standalone install to Docker in place (design section 11, added October 10, 2026), items 2 and 10.
# --existing-data adopts data folders an earlier standalone install already uses (Linux only; setup.ps1 never
# passes it); --vocalis-url / --taproom-url record the browser-facing addresses of a proxied install.
EXISTING_DATA=0
VOCALIS_URL_ARG=""
TAPROOM_URL_ARG=""
# --defer-start (design section 5, "Windows installer", amendment 15, October 10, 2026): used only by setup.ps1,
# always. Everything runs as without it (the update env swap, writability checks, model fetch, owner provisioning)
# except the two `compose up -d --no-build --pull never` calls, which setup.ps1 makes from Windows after this exits 0
# so the containers' bind sources are Windows paths and Docker Desktop can restart them by itself. The closing lines
# then say the Windows launcher starts the services. Without the flag (Linux) nothing changes.
# Invariant: this script's own one-shot containers (the writability checks, the model fetch, owner provisioning and
# --check) still mount the instance through WSL, while the services mount it by Windows path, and file locks are not
# shared between the two mounts. So a one-shot container here must only write models/ (which the services only read)
# or only read; it must not write a store the running services also use. (Owner provisioning is the one other writer:
# it runs only while the owner store is empty, which is before the services have ever been started on it.)
DEFER_START=0
NEW_INSTANCE=0
ADOPTED_PATHS=""
OWNER_PROVISIONED_THIS_RUN=0
SEED_MODEL_ARGS=()
SAVED_ROOT=""
CANDIDATE_ENV=""
# The --update candidate is a full copy of instance.env, and the model download between creating it
# and swapping it in can run for a long time (and be interrupted), so remove it on every exit. A
# pre-existing gap: a failed pull or a Ctrl-C used to leave .instance.env.update.<pid> behind.
# INT/TERM/HUP go through exit so that the EXIT trap runs for them too.
cleanup_candidate() { [[ -z "$CANDIDATE_ENV" ]] || rm -f -- "$CANDIDATE_ENV"; }
trap cleanup_candidate EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
while (($#)); do
  case "$1" in
    --root) (($# >= 2)) || fail "--root requires a path"; ROOT_ARG=$2; shift 2 ;;
    --variant) (($# >= 2)) || fail "--variant requires cuda or rocm"; VARIANT_ARG=$2; shift 2 ;;
    --vocalis-image) (($# >= 2)) || fail "--vocalis-image requires a digest reference"; VOCALIS_IMAGE_ARG=$2; shift 2 ;;
    --taproom-image) (($# >= 2)) || fail "--taproom-image requires a digest reference"; TAPROOM_IMAGE_ARG=$2; shift 2 ;;
    --vocalis-port) (($# >= 2)) || fail "--vocalis-port requires a port"; VOCALIS_PORT_ARG=$2; shift 2 ;;
    --taproom-port) (($# >= 2)) || fail "--taproom-port requires a port"; TAPROOM_PORT_ARG=$2; shift 2 ;;
    --seed-models) (($# >= 2)) || fail "--seed-models requires a folder"; SEED_MODEL_ARGS+=("$2"); shift 2 ;;
    --vocalis-url) (($# >= 2)) || fail "--vocalis-url requires an address"; VOCALIS_URL_ARG=$2; shift 2 ;;
    --taproom-url) (($# >= 2)) || fail "--taproom-url requires an address"; TAPROOM_URL_ARG=$2; shift 2 ;;
    --existing-data) EXISTING_DATA=1; shift ;;
    --update) UPDATE=1; shift ;;
    --defer-start) DEFER_START=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[[ "$EXISTING_DATA" == 0 || "$DEFER_START" == 0 ]] || fail "--existing-data is for Linux; setup.ps1 (--defer-start) never adopts existing data."

command -v docker >/dev/null || fail "Docker CLI is required. Install Docker Desktop or Docker Engine and retry."
docker info >/dev/null 2>&1 || fail "Docker is unavailable. Start Docker and retry."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

if [[ -z "$ROOT_ARG" ]]; then
  DEFAULT_ROOT="${HOME:?HOME is not set}/.local/share/vocalis/instance"
  if [[ -t 0 ]]; then
    read -r -p "Instance root [$DEFAULT_ROOT]: " ROOT_ARG
    ROOT_ARG=${ROOT_ARG:-$DEFAULT_ROOT}
  else
    ROOT_ARG=$DEFAULT_ROOT
  fi
fi
[[ "$ROOT_ARG" != *$'\n'* && "$ROOT_ARG" != *"'"* ]] || fail "The instance root cannot contain a newline or apostrophe."
mkdir -p -- "$ROOT_ARG"
[[ ! -L "$ROOT_ARG" ]] || fail "The selected instance root must not be a symlink."
INSTANCE_ROOT="$(cd -- "$ROOT_ARG" && pwd -P)"
[[ "$INSTANCE_ROOT" != / ]] || fail "The filesystem root cannot be used as an instance root."
ENV_FILE="$INSTANCE_ROOT/instance.env"

read_env_value() {
  local key=$1 line name value found=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || fail "Malformed instance.env line."
    name=${line%%=*}
    value=${line#*=}
    if [[ "$name" == "$key" ]]; then
      [[ -z "$found" ]] || fail "Duplicate $key in instance.env."
      found=$value
    fi
  done < "$ENV_FILE"
  [[ -n "$found" ]] || fail "instance.env is missing $key."
  if [[ "$found" == \'*\' ]]; then found=${found:1:${#found}-2}; fi
  printf '%s' "$found"
}

validate_digest_ref() {
  [[ "$1" =~ ^[^[:space:]]+@sha256:[a-fA-F0-9]{64}$ ]] || fail "Image references must end in @sha256:<64 hex digits>."
}

# Like read_env_value, but for the keys instance.env files made before October 10, 2026 do not have
# (VOCALIS_DATA_PATH, VOCALIS_CACHE_PATH, ADOPTED_PATHS): prints the value, or nothing when the key is absent.
read_env_optional() {
  local key=$1 line name value found=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || fail "Malformed instance.env line."
    name=${line%%=*}
    value=${line#*=}
    if [[ "$name" == "$key" ]]; then
      [[ -z "$found" ]] || fail "Duplicate $key in instance.env."
      found=$value
    fi
  done < "$ENV_FILE"
  if [[ "$found" == \'*\' ]]; then found=${found:1:${#found}-2}; fi
  printf '%s' "$found"
}

array_has() {
  local needle=$1 item
  shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

# True when $1 is $2 or lies inside it.
path_within() { [[ "$1" == "$2" || "$1" == "$2"/* ]]; }

# --vocalis-url / --taproom-url (design section 11, switching in place, item 10): https://host[:port] or
# http://127.0.0.1:port, nothing after the port. They go into instance.env unquoted and into the container
# environment, so the pattern is strict: no path, query, user information, space, quote or newline.
validate_public_url() {
  local name=$1 value=$2 port
  if [[ "$value" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ || "$value" =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]]; then
    if [[ "$value" =~ :([0-9]{1,5})$ ]]; then
      port=$((10#${BASH_REMATCH[1]}))
      (( port >= 1 && port <= 65535 )) || fail "$name has a port outside 1 through 65535: $value"
    fi
  else
    fail "$name must be https://host[:port] or http://127.0.0.1:port with no path (given: $value)."
  fi
}

# The two Vocalis store paths as the container sees them (design section 11, item 4). They are bind targets and
# become VOCALIS_DATA_DIR / VOCALIS_CACHE_DIR, so the rules keep them away from the image's own folders and from
# the other mounts. Checked on every run (a hand-edited instance.env is the failure this guards).
validate_container_path() {
  local name=$1 value=$2 prefix
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "$name must be an absolute path of letters, digits, '.', '_', '-' and '/': $value"
  case "$value/" in
    */../*|*/./*|*//*) fail "$name must be a normalized path (no '.', '..' or empty parts): $value" ;;
  esac
  case "$value" in
    /tmp|/var) fail "$name must not be $value itself: $value" ;;
  esac
  for prefix in /opt /usr /etc /bin /sbin /lib /lib64 /proc /sys /dev /run /models /work /logs /data/taproom /home/vocalis; do
    if path_within "$value" "$prefix"; then
      fail "$name must not be $prefix or inside it (the image or another mount uses it): $value"
    fi
    # An ancestor would shadow the protected folder (/home hides /home/vocalis, /data hides /data/taproom).
    if path_within "$prefix" "$value"; then
      fail "$name must not contain $prefix (it would shadow the folder the image or another mount uses): $value"
    fi
  done
}

validate_container_paths() {
  local data=$1 cache=$2
  validate_container_path VOCALIS_DATA_PATH "$data"
  validate_container_path VOCALIS_CACHE_PATH "$cache"
  [[ "$data" != "$cache" ]] || fail "VOCALIS_DATA_PATH and VOCALIS_CACHE_PATH must differ: $data"
  if path_within "$data" "$cache" || path_within "$cache" "$data"; then
    fail "VOCALIS_DATA_PATH ($data) and VOCALIS_CACHE_PATH ($cache) must not be nested."
  fi
}

# The seven responsibility paths (design section 11, item 1; section 4). Each is a real directory or a symlink placed
# exactly at that path whose target resolves, with `cd -P`, to an existing real directory. The parents (data,
# data/taproom, cache, models, work, logs) and the instance root stay real directories. Each link is only ever a bind
# *source*, which Docker resolves on the host when it creates the container (the Taproom container side has its own
# paths for exactly that reason, item 3). The first three are the stores a standalone install already holds; the order
# is relied on by ADOPTED_PATHS and by STORE_TARGET[n] below.
STORE_PATHS=(data/vocalis data/taproom/data cache/vocalis models/vocalis work/vocalis logs/vocalis logs/taproom)
STORE_TARGET=()

# Fills STORE_TARGET with the resolved directory of each responsibility path and refuses, naming the path: a dangling
# link or a link to a file; a target that is /, the instance root, an ancestor of it; a target containing a character
# outside [A-Za-z0-9._/-]; two paths resolving to the same directory or one inside another (which also covers a target
# inside another path's target); a link where a parent should be. $1 = 1 when a path may still be missing (a new
# instance, whose folders setup is about to create); 0 for an existing instance, where a missing path is an error and
# is never replaced by an empty folder.
resolve_store_paths() {
  local allow_missing=$1 i j rel full current target first second
  local -a comps
  STORE_TARGET=()
  for i in "${!STORE_PATHS[@]}"; do
    rel=${STORE_PATHS[$i]}
    full="$INSTANCE_ROOT/$rel"
    current="$INSTANCE_ROOT"
    IFS='/' read -r -a comps <<< "$rel"
    for ((j = 0; j < ${#comps[@]} - 1; j++)); do
      current="$current/${comps[$j]}"
      [[ ! -L "$current" ]] || fail "Only the responsibility folders themselves may be links; this parent is a link: $current"
      [[ ! -e "$current" || -d "$current" ]] || fail "Not a directory: $current"
    done
    if [[ -L "$full" ]]; then
      target=$(cd -P -- "$full" 2>/dev/null && pwd -P) || fail "The link $full does not lead to an existing directory (dangling link, a file, or a loop)."
      [[ "$target" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "The link $full leads to $target, which has a character outside A-Z a-z 0-9 . _ / - ."
      [[ "$target" != / ]] || fail "The link $full leads to the filesystem root."
      if [[ "$INSTANCE_ROOT" == "$target" || "$INSTANCE_ROOT" == "$target"/* ]]; then
        fail "The link $full leads to $target, which is the instance root or an ancestor of it."
      fi
    elif [[ -d "$full" ]]; then
      target=$full
    elif [[ -e "$full" ]]; then
      fail "Not a directory: $full"
    elif [[ "$allow_missing" == 1 ]]; then
      target=$full
    else
      fail "Required instance directory is missing: $full"
    fi
    STORE_TARGET+=("$target")
  done
  for ((i = 0; i < ${#STORE_TARGET[@]}; i++)); do
    for ((j = i + 1; j < ${#STORE_TARGET[@]}; j++)); do
      first=${STORE_TARGET[$i]}
      second=${STORE_TARGET[$j]}
      if path_within "$first" "$second" || path_within "$second" "$first"; then
        fail "${STORE_PATHS[$i]} and ${STORE_PATHS[$j]} resolve to $first and $second: the same folder, or one inside the other."
      fi
    done
  done
}

report_store_links() {
  local i
  for i in "${!STORE_PATHS[@]}"; do
    if [[ -L "$INSTANCE_ROOT/${STORE_PATHS[$i]}" ]]; then
      printf 'Linked folder: %s -> %s\n' "${STORE_PATHS[$i]}" "${STORE_TARGET[$i]}"
    fi
  done
}

# --existing-data (design section 11, item 2). The instance root may hold only the responsibility paths, the parents
# setup creates, and the two files an operator prepares ahead of a switch: compose.local.yaml and
# data/taproom/mcp-servers.json (each a regular file, not a link, owned by the user). Anything else is refused and
# named, so setup never sits on top of something it does not understand.
ADOPT_PARENTS=(data data/taproom cache models work logs)
ADOPT_FILES=(compose.local.yaml data/taproom/mcp-servers.json)
adopt_walk() {
  local rel=$1 dir child crel owner mode
  if [[ -z "$rel" ]]; then dir=$INSTANCE_ROOT; else dir="$INSTANCE_ROOT/$rel"; fi
  while IFS= read -r -d '' child; do
    crel=${child#"$INSTANCE_ROOT"/}
    if array_has "$crel" "${STORE_PATHS[@]}"; then continue; fi
    if array_has "$crel" "${ADOPT_PARENTS[@]}"; then
      [[ -d "$child" && ! -L "$child" ]] || fail "--existing-data: $child must be a real folder (only the responsibility folders may be links)."
      adopt_walk "$crel"
      continue
    fi
    if array_has "$crel" "${ADOPT_FILES[@]}"; then
      [[ -f "$child" && ! -L "$child" ]] || fail "--existing-data: $child must be a regular file, not a link or folder."
      owner=$(stat -c %u -- "$child") || fail "--existing-data: cannot read the owner of $child."
      [[ "$owner" == "$(id -u)" ]] || fail "--existing-data: $child is owned by uid $owner, not by the user running setup (uid $(id -u))."
      if [[ "$crel" == data/taproom/mcp-servers.json ]]; then
        mode=$(stat -c %a -- "$child") || fail "--existing-data: cannot read the permissions of $child."
        (( (8#$mode & 8#077) == 0 )) || fail "--existing-data: $child holds connection secrets in plain text and is readable by others (mode $mode). Fix it with: chmod 600 '$child'"
      fi
      continue
    fi
    fail "--existing-data: the instance root holds something setup does not know: $child. The root may hold only the responsibility folders, compose.local.yaml and data/taproom/mcp-servers.json."
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0)
}

# data/taproom/mcp-servers.json holds MCP connection secrets (an Authorization header, for example) in plain text, as on the
# standalone install, so it is kept to the owner. Adoption refuses a copy with group or other permission bits (above);
# every later run of an instance that has the file sets it to 0600 (the Taproom plugin writes it 0600 too) and says so.
# A data/taproom folder open to group or other only gets a warning: it also holds config.yaml.
secure_mcp_servers_file() {
  local file="$INSTANCE_ROOT/data/taproom/mcp-servers.json" folder="$INSTANCE_ROOT/data/taproom" mode
  # Not on a Windows drive seen through WSL (October 10, 2026, candidate review): /mnt/<drive> is a 9p mount with
  # no metadata option, where every file shows mode 777 and chmod does not change what is shown, so the warning
  # would repeat on every setup.ps1 run and could not be acted on. Windows file permissions protect it there.
  case "$(stat -f -c %T -- "$INSTANCE_ROOT" 2>/dev/null)" in v9fs|9p) return 0 ;; esac
  if [[ -f "$file" && ! -L "$file" ]]; then
    mode=$(stat -c %a -- "$file" 2>/dev/null) || mode=""
    if [[ -n "$mode" ]] && (( (8#$mode & 8#077) != 0 )); then
      if chmod 0600 -- "$file" 2>/dev/null; then
        printf 'MCP server list %s had mode %s (it holds connection secrets in plain text): set to 600.\n' "$file" "$mode"
      else
        printf 'WARNING: %s has mode %s and could not be changed to 600; run: chmod 600 %s\n' "$file" "$mode" "$file" >&2
      fi
    fi
  fi
  if [[ -d "$folder" && ! -L "$folder" ]]; then
    mode=$(stat -c %a -- "$folder" 2>/dev/null) || mode=""
    if [[ -n "$mode" ]] && (( (8#$mode & 8#077) != 0 )); then
      printf 'WARNING: %s has mode %s, so other users can list it (it holds config.yaml and the MCP server list); consider: chmod 700 %s\n' "$folder" "$mode" "$folder" >&2
    fi
  fi
}

dir_has_entries() { [[ -n "$(find -H "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; }

# An adopted store must look like what it claims, or it is refused with nothing touched. data/vocalis holds an
# initialized encrypted store (the Docker product requires the vault; a plaintext store is refused) when it is not
# empty; data/taproom/data holds the account store (_storage). An empty store is treated as new.
ADOPT_VOCALIS_EMPTY=0
ADOPT_TAPROOM_EMPTY=0
adopt_check_store_shape() {
  local vdata=${STORE_TARGET[0]} tdata=${STORE_TARGET[1]}
  if [[ -d "$vdata" ]] && dir_has_entries "$vdata"; then
    [[ -f "$vdata/admin_credentials.yaml" && -f "$vdata/vault_keys.yaml" ]] \
      || fail "--existing-data: $vdata is not an initialized encrypted Vocalis store (admin_credentials.yaml and vault_keys.yaml are both required; a plaintext or half-present store is refused). Nothing was changed."
  else
    ADOPT_VOCALIS_EMPTY=1
  fi
  if [[ -d "$tdata" ]] && dir_has_entries "$tdata"; then
    [[ -d "$tdata/_storage" ]] || fail "--existing-data: $tdata is not a Taproom data folder (it has no _storage folder). Nothing was changed."
  else
    ADOPT_TAPROOM_EMPTY=1
  fi
  printf 'Adoption: Vocalis store %s; Taproom store %s.\n' \
    "$([[ "$ADOPT_VOCALIS_EMPTY" == 1 ]] && echo 'is empty (treated as new)' || echo 'has an initialized vault')" \
    "$([[ "$ADOPT_TAPROOM_EMPTY" == 1 ]] && echo 'is empty (treated as new)' || echo 'has an account store')"
}

# Every adopted target and the files the services open at startup must be owned by the user running setup, whose
# UID/GID become the service user: otherwise the 0600 credential files are unreadable to the container, and files
# Docker writes would be unreadable to the standalone install.
adopt_check_owned() {
  local me path owner
  me=$(id -u)
  for path in "${STORE_TARGET[0]}" "${STORE_TARGET[1]}" "${STORE_TARGET[2]}" \
              "${STORE_TARGET[0]}/admin_credentials.yaml" "${STORE_TARGET[0]}/vault_keys.yaml" "${STORE_TARGET[0]}/app_settings.yaml" \
              "${STORE_TARGET[1]}/_storage" "${STORE_TARGET[1]}/cookie-secret.txt"; do
    [[ -e "$path" ]] || continue
    owner=$(stat -L -c %u -- "$path") || fail "--existing-data: cannot read the owner of $path."
    [[ "$owner" == "$me" ]] || fail "--existing-data: $path is owned by uid $owner, but setup runs as uid $me and that user becomes the service user. Fix the owner (chown) and run setup again. Nothing was changed."
  done
}

# The one-writer rule (design section 11, hard rule 3): neither application can see the other across the container
# boundary, so setup refuses while a standalone Vocalis or SillyTavern/Taproom of this user still runs on the adopted
# folders. A candidate is a process of this user that is a Python or a Node and
#   - runs vocalis.py or vocalis_server.py (Python) or server.js (Node) whose script path or working folder lies inside
#     an adopted target, or is the parent of the adopted Taproom data folder (how the standalone Vocalis and SillyTavern
#     run); or
#   - has any absolute command-line argument inside an adopted target (a worker or helper the application started); or
#   - is a Python whose VOCALIS_DATA_DIR or VOCALIS_CACHE_DIR (read from /proc/<pid>/environ; our own processes only, an
#     unreadable environment is skipped) is inside an adopted target.
# Other processes, such as a shell or an editor sitting in the folder, never block. A candidate is skipped only when it
# is inside a container (containers' processes are Docker's, and they run as the same user as setup): its root directory
# (`stat -L -c %d:%i /proc/<pid>/root`) differs from this host's `/`. A host process always matches, even under systemd
# PrivateTmp/ProtectHome, which give a unit its own mount namespace but not another root. (A mount-namespace comparison
# was used on October 10, 2026 and replaced the same day: a hardened unit has a namespace of its own and would have been
# skipped.) The targets are the union of ADOPTED_PATHS (three colon-separated canonical folders in the order of
# STORE_PATHS: the Vocalis data store, the Taproom data folder, the Vocalis cache) and the folders the responsibility paths
# resolve to now, so a link moved since adoption protects the old and the new folder. Repeated by fetch_models and
# start_services on every run of an adopted instance (including --update), because a legacy unit can be started again
# between runs; $1 names the moment for the log.
check_adopted_not_in_use() {
  local when=$1
  [[ -n "${ADOPTED_PATHS:-}" ]] || return 0
  local -a recorded targets parents=() argv envv blocked=()
  local target parent pdir pid base kind arg name script cwd abs resolved reason entry value host_root root_id
  local looked=0 candidates=0 in_container=0 unreadable=0 started=$SECONDS
  IFS=':' read -r -a recorded <<< "$ADOPTED_PATHS"
  ((${#recorded[@]} == 3)) && [[ -n "${recorded[0]}" && -n "${recorded[1]}" && -n "${recorded[2]}" ]] \
    || fail "ADOPTED_PATHS in instance.env must name three folders separated by colons."
  targets=("${recorded[@]}")
  parents=("$(dirname -- "${recorded[1]}")")
  if ((${#STORE_TARGET[@]} >= 3)); then
    targets+=("${STORE_TARGET[0]}" "${STORE_TARGET[1]}" "${STORE_TARGET[2]}")
    parents+=("$(dirname -- "${STORE_TARGET[1]}")")
  fi
  host_root=$(stat -L -c %d:%i / 2>/dev/null) || host_root=""
  for pdir in /proc/[0-9]*; do
    pid=${pdir#/proc/}
    [[ "$pid" != "$$" ]] || continue
    [[ -O "$pdir" ]] || continue
    looked=$((looked + 1))
    { mapfile -d '' -t argv < "$pdir/cmdline"; } 2>/dev/null || continue
    ((${#argv[@]} >= 1)) || continue
    base=${argv[0]##*/}
    case "$base" in
      python|python[0-9]*) kind=python ;;
      node|nodejs) kind=node ;;
      *) continue ;;
    esac
    reason=""
    cwd=$(readlink -- "$pdir/cwd" 2>/dev/null) || cwd=""
    # (1) the application's own script
    script=""
    for arg in "${argv[@]:1}"; do
      name=${arg##*/}
      if [[ "$kind" == python && ( "$name" == vocalis.py || "$name" == vocalis_server.py ) ]] || [[ "$kind" == node && "$name" == server.js ]]; then
        script=$arg
        break
      fi
    done
    if [[ -n "$script" ]]; then
      if [[ "$script" == /* ]]; then
        abs=$script
      elif [[ -n "$cwd" ]]; then
        abs="$cwd/$script"
      else
        abs=""
        unreadable=$((unreadable + 1))
      fi
      if [[ -n "$abs" ]]; then
        # Resolve links and dots so a script reached through a link still compares by its real location; when that
        # fails the unresolved path is compared (a deleted file, for example).
        if resolved=$(realpath -m -- "$abs" 2>/dev/null); then abs=$resolved; fi
        for target in "${targets[@]}"; do
          if path_within "$abs" "$target" || { [[ -n "$cwd" ]] && path_within "$cwd" "$target"; }; then reason="runs $script, which uses $target"; break; fi
        done
        if [[ -z "$reason" ]]; then
          for parent in "${parents[@]}"; do
            if [[ "$(dirname -- "$abs")" == "$parent" || "$cwd" == "$parent" ]]; then reason="runs $script from $parent, the parent of the Taproom data folder"; break; fi
          done
        fi
      fi
    fi
    # (2) any absolute argument inside an adopted folder
    if [[ -z "$reason" ]]; then
      for arg in "${argv[@]:1}"; do
        [[ "$arg" == /* ]] || continue
        value=$arg
        if resolved=$(realpath -m -- "$arg" 2>/dev/null); then value=$resolved; fi
        for target in "${targets[@]}"; do
          if path_within "$value" "$target"; then reason="has the argument $arg inside $target"; break 2; fi
        done
      done
    fi
    # (3) a Python started with the Vocalis data or cache folder in its environment
    if [[ -z "$reason" && "$kind" == python ]]; then
      { mapfile -d '' -t envv < "$pdir/environ"; } 2>/dev/null || envv=()
      for entry in ${envv[@]+"${envv[@]}"}; do
        case "$entry" in
          VOCALIS_DATA_DIR=*|VOCALIS_CACHE_DIR=*) ;;
          *) continue ;;
        esac
        value=${entry#*=}
        [[ "$value" == /* ]] || continue
        if resolved=$(realpath -m -- "$value" 2>/dev/null); then value=$resolved; fi
        for target in "${targets[@]}"; do
          if path_within "$value" "$target"; then reason="has ${entry%%=*}=$value inside $target"; break 2; fi
        done
      done
    fi
    [[ -n "$reason" ]] || continue
    candidates=$((candidates + 1))
    # Only now, for a process that would block, is it asked whether it lives in a container.
    root_id=$(stat -L -c %d:%i -- "$pdir/root" 2>/dev/null) || root_id=""
    if [[ -n "$root_id" && -n "$host_root" && "$root_id" != "$host_root" ]]; then in_container=$((in_container + 1)); continue; fi
    [[ -n "$root_id" ]] || unreadable=$((unreadable + 1))  # cannot tell: treated as a host process, which blocks
    blocked+=("$pid: ${argv[*]} ($reason)")
  done
  printf 'In-use check (%s): looked at %d process(es) of this user, %d Python or Node process(es) on the adopted folders, %d skipped (in a container), %d with an unreadable root or working folder, %d blocking, %d s.\n' \
    "$when" "$looked" "$candidates" "$in_container" "$unreadable" "${#blocked[@]}" $((SECONDS - started))
  if ((${#blocked[@]})); then
    printf 'A standalone Vocalis or SillyTavern is still running on the adopted data:\n' >&2
    for arg in "${blocked[@]}"; do printf '  PID %s\n' "$arg" >&2; done
    fail "Only one of the standalone install and Docker may run on the data at a time. Stop it first (for a systemd user unit: systemctl --user disable --now <unit>; a unit with Restart=always needs disable --now, not stop), then run setup again."
  fi
}

if [[ -L "$ENV_FILE" ]]; then fail "instance.env must not be a symlink."; fi
if [[ -f "$ENV_FILE" ]]; then
  [[ "$UPDATE" == 0 || ( -n "$VOCALIS_IMAGE_ARG" && -n "$TAPROOM_IMAGE_ARG" ) ]] || fail "Updates require both new pinned image references."
  INSTANCE_ID=$(read_env_value INSTANCE_ID)
  GPU_VARIANT=$(read_env_value GPU_VARIANT)
  SAVED_ROOT=$(read_env_value INSTANCE_ROOT)
  [[ "$(cd -- "$SAVED_ROOT" && pwd -P)" == "$INSTANCE_ROOT" ]] || fail "The selected root does not match instance.env."
  [[ "$INSTANCE_ID" =~ ^[a-z0-9][a-z0-9-]{2,31}$ ]] || fail "Invalid INSTANCE_ID in instance.env."
  [[ "$GPU_VARIANT" == cuda || "$GPU_VARIANT" == rocm ]] || fail "Invalid GPU_VARIANT in instance.env."
  [[ -z "$VARIANT_ARG" || "$VARIANT_ARG" == "$GPU_VARIANT" ]] || fail "Changing GPU runtime requires a separate instance."
  VOCALIS_IMAGE=$(read_env_value VOCALIS_IMAGE)
  TAPROOM_IMAGE=$(read_env_value TAPROOM_IMAGE)
  # October 10, 2026: a rerun of the command that created the instance repeats its image flags too (the hint
  # after a failed model download says "run the same setup command again"), so the recorded image is accepted
  # and only a different one needs --update. Until then any image flag was refused here, and a setup that had
  # stopped partway could not be resumed with the command that started it.
  if [[ "$UPDATE" == 0 ]]; then
    [[ -z "$VOCALIS_IMAGE_ARG" || "$VOCALIS_IMAGE_ARG" == "$VOCALIS_IMAGE" ]] || fail "Changing images on an existing instance requires --update."
    [[ -z "$TAPROOM_IMAGE_ARG" || "$TAPROOM_IMAGE_ARG" == "$TAPROOM_IMAGE" ]] || fail "Changing images on an existing instance requires --update."
  fi
  VOCALIS_PORT=$(read_env_value VOCALIS_PORT)
  TAPROOM_PORT=$(read_env_value TAPROOM_PORT)
  [[ -z "$VOCALIS_PORT_ARG" || "$VOCALIS_PORT_ARG" == "$VOCALIS_PORT" ]] || fail "Ports are fixed for an existing instance."
  [[ -z "$TAPROOM_PORT_ARG" || "$TAPROOM_PORT_ARG" == "$TAPROOM_PORT" ]] || fail "Ports are fixed for an existing instance."
  VOCALIS_PUBLIC_URL=$(read_env_value VOCALIS_PUBLIC_URL)
  TAPROOM_PUBLIC_URL=$(read_env_value TAPROOM_PUBLIC_URL)
  HOST_BIND=$(read_env_value HOST_BIND)
  VOCALIS_UID=$(read_env_value VOCALIS_UID)
  VOCALIS_GID=$(read_env_value VOCALIS_GID)
  TAPROOM_UID=$(read_env_value TAPROOM_UID)
  TAPROOM_GID=$(read_env_value TAPROOM_GID)
  GPU_GID=$(read_env_value GPU_GID)
  # Optional keys (design section 11, items 2 and 4): instance.env files made before October 10, 2026 lack them and
  # keep working with the old fixed container paths. ADOPTED_PATHS, when present, makes every later run repeat the
  # in-use check before the model fetch and before the services start.
  VOCALIS_DATA_PATH=$(read_env_optional VOCALIS_DATA_PATH)
  VOCALIS_CACHE_PATH=$(read_env_optional VOCALIS_CACHE_PATH)
  VOCALIS_DATA_PATH=${VOCALIS_DATA_PATH:-/data/vocalis}
  VOCALIS_CACHE_PATH=${VOCALIS_CACHE_PATH:-/cache/vocalis}
  ADOPTED_PATHS=$(read_env_optional ADOPTED_PATHS)
  validate_container_paths "$VOCALIS_DATA_PATH" "$VOCALIS_CACHE_PATH"
  [[ "$UPDATE" == 0 || "$EXISTING_DATA" == 0 ]] || fail "--existing-data adopts data into a new instance and cannot be combined with --update."
  if [[ "$EXISTING_DATA" == 1 && -z "$ADOPTED_PATHS" ]]; then
    fail "--existing-data applies to a new instance only; this root already has an instance.env that did not adopt existing data."
  fi
  # A rerun of the command that created the instance (for example to resume a model download) repeats its flags;
  # the recorded values are fixed, so the same value is accepted and a different one is refused.
  [[ -z "$VOCALIS_URL_ARG" || "$VOCALIS_URL_ARG" == "$VOCALIS_PUBLIC_URL" ]] || fail "The Vocalis address is fixed for an existing instance (recorded: $VOCALIS_PUBLIC_URL)."
  [[ -z "$TAPROOM_URL_ARG" || "$TAPROOM_URL_ARG" == "$TAPROOM_PUBLIC_URL" ]] || fail "The Taproom address is fixed for an existing instance (recorded: $TAPROOM_PUBLIC_URL)."
  [[ "$INSTANCE_ROOT" == "$SAVED_ROOT" ]] || fail "instance.env must record the canonical instance root."
  if [[ "$UPDATE" == 1 ]]; then
    validate_digest_ref "$VOCALIS_IMAGE_ARG"
    validate_digest_ref "$TAPROOM_IMAGE_ARG"
    CANDIDATE_ENV="$INSTANCE_ROOT/.instance.env.update.$$"
    awk -v vocalis_image="$VOCALIS_IMAGE_ARG" -v taproom_image="$TAPROOM_IMAGE_ARG" '
      /^VOCALIS_IMAGE=/ { print "VOCALIS_IMAGE=" vocalis_image; next }
      /^TAPROOM_IMAGE=/ { print "TAPROOM_IMAGE=" taproom_image; next }
      { print }
    ' "$ENV_FILE" > "$CANDIDATE_ENV"
    chmod 0600 "$CANDIDATE_ENV"
    VOCALIS_IMAGE=$VOCALIS_IMAGE_ARG
    TAPROOM_IMAGE=$TAPROOM_IMAGE_ARG
    ENV_FILE_FOR_COMPOSE=$CANDIDATE_ENV
  else
    ENV_FILE_FOR_COMPOSE=$ENV_FILE
  fi
else
  [[ "$UPDATE" == 0 ]] || fail "No instance.env exists at the selected root; setup is required before update."
  if [[ "$EXISTING_DATA" == 1 ]]; then
    # Adopting data a standalone install already uses (design section 11, item 2). Every refusal below happens before
    # instance.env is written and before anything is created inside an adopted folder.
    adopt_walk ""
    resolve_store_paths 1
    adopt_check_store_shape
    adopt_check_owned
    ADOPTED_PATHS="${STORE_TARGET[0]}:${STORE_TARGET[1]}:${STORE_TARGET[2]}"
    for adopted in "${STORE_TARGET[0]}" "${STORE_TARGET[1]}" "${STORE_TARGET[2]}"; do
      case "$adopted" in
        *:*|*$'\n'*|*"'"*) fail "--existing-data: an adopted folder path may not contain a colon, apostrophe or line break: $adopted" ;;
      esac
    done
    check_adopted_not_in_use "before adoption"
  elif [[ -n "$(find "$INSTANCE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    fail "The selected root is nonempty but has no instance.env; preserving it. Choose an empty root."
  fi
  [[ -z "$VOCALIS_URL_ARG" ]] || validate_public_url "--vocalis-url" "$VOCALIS_URL_ARG"
  [[ -z "$TAPROOM_URL_ARG" ]] || validate_public_url "--taproom-url" "$TAPROOM_URL_ARG"
  GPU_VARIANT=${VARIANT_ARG:-}
  if [[ -z "$GPU_VARIANT" ]]; then
    if [[ -t 0 ]]; then read -r -p "GPU runtime (cuda or rocm): " GPU_VARIANT; else fail "Supply --variant cuda or rocm."; fi
  fi
  [[ "$GPU_VARIANT" == cuda || "$GPU_VARIANT" == rocm ]] || fail "GPU runtime must be cuda or rocm."
  VOCALIS_IMAGE=${VOCALIS_IMAGE_ARG:-}
  TAPROOM_IMAGE=${TAPROOM_IMAGE_ARG:-}
  if [[ -z "$VOCALIS_IMAGE" && -t 0 ]]; then read -r -p "Pinned Vocalis image reference: " VOCALIS_IMAGE; fi
  if [[ -z "$TAPROOM_IMAGE" && -t 0 ]]; then read -r -p "Pinned Taproom image reference: " TAPROOM_IMAGE; fi
  validate_digest_ref "$VOCALIS_IMAGE"
  validate_digest_ref "$TAPROOM_IMAGE"
  NEW_INSTANCE=1
  INSTANCE_ID="vi-$(tr -d '-' </proc/sys/kernel/random/uuid | cut -c1-12)"
  VOCALIS_PORT=${VOCALIS_PORT_ARG:-18770}
  TAPROOM_PORT=${TAPROOM_PORT_ARG:-18771}
  if [[ -t 0 && -z "$VOCALIS_PORT_ARG" ]]; then
    read -r -p "Vocalis loopback port [$VOCALIS_PORT]: " answer; VOCALIS_PORT=${answer:-$VOCALIS_PORT}
  fi
  if [[ -t 0 && -z "$TAPROOM_PORT_ARG" ]]; then
    read -r -p "Taproom loopback port [$TAPROOM_PORT]: " answer; TAPROOM_PORT=${answer:-$TAPROOM_PORT}
  fi
  [[ "$VOCALIS_PORT" =~ ^[0-9]{1,5}$ && "$TAPROOM_PORT" =~ ^[0-9]{1,5}$ ]] || fail "Ports must be numeric."
  (( VOCALIS_PORT >= 1024 && VOCALIS_PORT <= 65535 && TAPROOM_PORT >= 1024 && TAPROOM_PORT <= 65535 && VOCALIS_PORT != TAPROOM_PORT )) || fail "Choose distinct ports from 1024 through 65535."
  for port in "$VOCALIS_PORT" "$TAPROOM_PORT"; do
    if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then fail "Loopback port $port is already in use."; fi
  done
  # The browser-facing addresses default to the loopback ports; a reverse proxy in front (item 10) gives its own.
  # Publishing stays loopback-only either way (HOST_BIND below).
  VOCALIS_PUBLIC_URL=${VOCALIS_URL_ARG:-"http://127.0.0.1:$VOCALIS_PORT"}
  TAPROOM_PUBLIC_URL=${TAPROOM_URL_ARG:-"http://127.0.0.1:$TAPROOM_PORT"}
  VOCALIS_UID=$(id -u)
  VOCALIS_GID=$(id -g)
  TAPROOM_UID=$VOCALIS_UID
  TAPROOM_GID=$VOCALIS_GID
  GPU_GID=0
  if [[ "$GPU_VARIANT" == rocm ]]; then
    [[ -e /dev/kfd && -d /dev/dri ]] || fail "ROCm requires /dev/kfd and /dev/dri to be available to Docker."
    if [[ -e /dev/dri/renderD128 ]]; then GPU_GID=$(stat -c '%g' /dev/dri/renderD128); fi
  else
    docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -qi nvidia || fail "NVIDIA Container Toolkit is not visible to Docker."
  fi
  # The container paths of the two Vocalis stores (item 4). A fresh instance records the defaults. An adopted
  # instance records the canonical target of each store that is a link, so every absolute path the standalone install
  # or Docker writes into a record (book sidecars, cache keys) is the same string on both sides and resolves on both;
  # a store that is a real folder keeps the default.
  VOCALIS_DATA_PATH=/data/vocalis
  VOCALIS_CACHE_PATH=/cache/vocalis
  if [[ "$EXISTING_DATA" == 1 ]]; then
    if [[ -L "$INSTANCE_ROOT/data/vocalis" ]]; then VOCALIS_DATA_PATH=${STORE_TARGET[0]}; fi
    if [[ -L "$INSTANCE_ROOT/cache/vocalis" ]]; then VOCALIS_CACHE_PATH=${STORE_TARGET[2]}; fi
  fi
  validate_container_paths "$VOCALIS_DATA_PATH" "$VOCALIS_CACHE_PATH"
  printf 'New instance %s: Vocalis data %s, cache %s (container paths); Vocalis %s, Taproom %s.\n' \
    "$INSTANCE_ID" "$VOCALIS_DATA_PATH" "$VOCALIS_CACHE_PATH" "$VOCALIS_PUBLIC_URL" "$TAPROOM_PUBLIC_URL"
  cat > "$ENV_FILE" <<EOF
INSTANCE_ID=$INSTANCE_ID
GPU_VARIANT=$GPU_VARIANT
INSTANCE_ROOT='$INSTANCE_ROOT'
HOST_BIND=127.0.0.1
VOCALIS_PORT=$VOCALIS_PORT
TAPROOM_PORT=$TAPROOM_PORT
VOCALIS_PUBLIC_URL=$VOCALIS_PUBLIC_URL
TAPROOM_PUBLIC_URL=$TAPROOM_PUBLIC_URL
VOCALIS_UID=$VOCALIS_UID
VOCALIS_GID=$VOCALIS_GID
TAPROOM_UID=$TAPROOM_UID
TAPROOM_GID=$TAPROOM_GID
GPU_GID=$GPU_GID
VOCALIS_IMAGE=$VOCALIS_IMAGE
TAPROOM_IMAGE=$TAPROOM_IMAGE
VOCALIS_DATA_PATH=$VOCALIS_DATA_PATH
VOCALIS_CACHE_PATH=$VOCALIS_CACHE_PATH
EOF
  if [[ -n "$ADOPTED_PATHS" ]]; then printf "ADOPTED_PATHS='%s'\n" "$ADOPTED_PATHS" >> "$ENV_FILE"; fi
  chmod 0600 "$ENV_FILE"
  ENV_FILE_FOR_COMPOSE=$ENV_FILE
  mkdir -p -- \
    "$INSTANCE_ROOT/data/vocalis" "$INSTANCE_ROOT/data/taproom/data" \
    "$INSTANCE_ROOT/cache/vocalis" "$INSTANCE_ROOT/models/vocalis" \
    "$INSTANCE_ROOT/work/vocalis/scratch" "$INSTANCE_ROOT/work/vocalis/bulk" \
    "$INSTANCE_ROOT/work/vocalis/voxcpm_candidates" "$INSTANCE_ROOT/work/vocalis/acestep" \
    "$INSTANCE_ROOT/logs/vocalis" "$INSTANCE_ROOT/logs/taproom"
fi

validate_digest_ref "$VOCALIS_IMAGE"
validate_digest_ref "$TAPROOM_IMAGE"
if [[ -n "$SAVED_ROOT" && "$INSTANCE_ROOT" != "$SAVED_ROOT" ]]; then fail "Instance root changed unexpectedly."; fi
[[ "${HOST_BIND:-127.0.0.1}" == 127.0.0.1 ]] || fail "Only loopback publishing is supported by this setup profile."

if [[ "$GPU_VARIANT" == cuda ]]; then COMPOSE_FILES=(-f "$BASE_COMPOSE" -f "$CUDA_COMPOSE"); else COMPOSE_FILES=(-f "$BASE_COMPOSE" -f "$ROCM_COMPOSE"); fi
# <root>/compose.local.yaml (design section 11, item 9): optional per-machine additions the package cannot know (extra
# host names, a private CA, environment overrides). Appended after the variant file by this function and by the Windows
# helper (windows-compose.ps1). It must be a regular file, not a link, owned by the user running setup, so a stranger's
# file or a link into somewhere else is never fed to Compose. Setup never writes or edits it; `compose config --quiet`
# below validates the merged result. The operator owns its effect (it must not publish ports beyond loopback).
LOCAL_COMPOSE="$INSTANCE_ROOT/compose.local.yaml"
if [[ -e "$LOCAL_COMPOSE" || -L "$LOCAL_COMPOSE" ]]; then
  [[ ! -L "$LOCAL_COMPOSE" ]] || fail "compose.local.yaml must be a regular file, not a link: $LOCAL_COMPOSE"
  [[ -f "$LOCAL_COMPOSE" ]] || fail "compose.local.yaml must be a regular file: $LOCAL_COMPOSE"
  LOCAL_OWNER=$(stat -c %u -- "$LOCAL_COMPOSE") || fail "Cannot read the owner of $LOCAL_COMPOSE."
  [[ "$LOCAL_OWNER" == "$(id -u)" ]] || fail "compose.local.yaml is owned by uid $LOCAL_OWNER, not by the user running setup (uid $(id -u)): $LOCAL_COMPOSE"
  COMPOSE_FILES+=(-f "$LOCAL_COMPOSE")
  printf 'Using %s as an additional Compose file.\n' "$LOCAL_COMPOSE"
fi
# Compose gives the process environment precedence over --env-file, and a VOCALIS_DATA_PATH or VOCALIS_CACHE_PATH
# inherited from the caller's environment would silently win over instance.env. These two are validated above (an old
# instance.env without them gets the defaults), so exporting them makes the validated value the one Compose sees.
export VOCALIS_DATA_PATH VOCALIS_CACHE_PATH
compose() {
  docker compose --project-name "vocalis-$INSTANCE_ID" --env-file "$ENV_FILE_FOR_COMPOSE" "${COMPOSE_FILES[@]}" "$@"
}

# Setup-time model acquisition (design section 5, "Model acquisition by setup"). The Vocalis image
# carries the fetcher and the locks it reads; this runs it as a one-shot container with the service
# user and the /models/vocalis mount. The interpreter is the image's pinned CPython 3.12.15, present
# in both the CUDA and ROCm profiles (Dockerfile.app tests it). The fetcher skips verified files, so a
# rerun of the same setup command is the resume path.
MODEL_FETCH_PYTHON=/opt/python/3.12.15/bin/python3.12
MODEL_FETCH_SCRIPT=/usr/share/vocalis-g1/models/fetch_models.py

# Reuse of model files already on this machine (design section 5, "Model acquisition by setup",
# amendment of October 9, 2026, later still; Doug: "The script should be smart enough to find them on
# an upgrade or reinstall."). A rerun, upgrade or reinstall into the same data folder already downloads
# nothing; the gap is a new data folder on a machine that already holds a verified set. Setup offers the
# fetcher other models folders to copy from, read-only. The fetcher verifies every byte by hash, so a
# wrong guess here only costs a skipped folder. Seed sources, in order: (1) each --seed-models; (2) every
# */ with an instance.env under the default instance parent ($HOME/.local/share/vocalis); (3) the
# per-user list of roots setup has used, ${XDG_STATE_HOME:-$HOME/.local/state}/vocalis/instance-roots.
# At most MODEL_SEED_CAP are used, explicit ones first. Everything about the list file is best effort: a
# problem with it prints one warning and never stops setup (an unwritable directory left by an earlier
# sudo run is the case this guards).
MODEL_SEED_CAP=8
INSTANCE_ROOTS_FILE=""
LISTED_ROOTS=()
LISTED_CHANGED=0
MODEL_SEED_DIRS=()
OWN_MODELS_DIR=""

in_list() {
  local needle=$1 item
  shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

instance_roots_file() {
  local state=${XDG_STATE_HOME:-}
  # The XDG rule: a relative value is invalid and ignored.
  if [[ "$state" != /* ]]; then
    [[ -n "${HOME:-}" ]] || return 1
    state=$HOME/.local/state
  fi
  printf '%s/vocalis/instance-roots' "$state"
}

# Reads the list into LISTED_ROOTS. Lines are absolute paths, re-canonicalized with `cd -P`. A line whose
# root is gone is dropped only when the root's parent directory still exists, so the lines of an unplugged
# drive are kept (and skipped for this run). LISTED_CHANGED says the file no longer matches what was kept.
read_instance_roots() {
  local file contents line canonical parent
  LISTED_ROOTS=()
  LISTED_CHANGED=0
  INSTANCE_ROOTS_FILE=""
  if ! file=$(instance_roots_file); then
    printf 'WARNING: HOME is not set, so setup cannot read or update the list of earlier Vocalis instances; continuing without it.\n' >&2
    return 0
  fi
  INSTANCE_ROOTS_FILE=$file
  [[ -e "$file" || -L "$file" ]] || return 0
  if ! contents=$(cat -- "$file" 2>/dev/null); then
    printf 'WARNING: cannot read %s; continuing without the list of earlier Vocalis instances.\n' "$file" >&2
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    if [[ "$line" != /* ]]; then LISTED_CHANGED=1; continue; fi
    if [[ -L "$line" ]]; then
      canonical=$line  # stays listed; it is refused as a seed for being a symlink
    elif [[ -d "$line" ]]; then
      canonical=$(cd -P -- "$line" 2>/dev/null && pwd -P) || canonical=$line
    elif [[ -e "$line" ]]; then
      LISTED_CHANGED=1; continue  # no longer a directory
    else
      parent=${line%/*}
      if [[ -d "${parent:-/}" ]]; then LISTED_CHANGED=1; continue; fi  # gone while its parent is there
      canonical=$line  # the parent is gone too: an unplugged drive, kept for later
    fi
    [[ "$canonical" == "$line" ]] || LISTED_CHANGED=1
    if in_list "$canonical" ${LISTED_ROOTS[@]+"${LISTED_ROOTS[@]}"}; then LISTED_CHANGED=1; continue; fi
    LISTED_ROOTS+=("$canonical")
  done <<< "$contents"
}

# Adds this instance's root and rewrites the list through a temporary file in the same directory (mode
# 0600), renamed into place. Called only after instance.env exists and the required-path checks passed, so a
# refused run is never listed. Nothing is written when the file already says what it should.
record_instance_root() {
  local dir tmp
  [[ -n "$INSTANCE_ROOTS_FILE" ]] || return 0
  if ! in_list "$INSTANCE_ROOT" ${LISTED_ROOTS[@]+"${LISTED_ROOTS[@]}"}; then
    LISTED_ROOTS+=("$INSTANCE_ROOT")
    LISTED_CHANGED=1
  fi
  [[ "$LISTED_CHANGED" == 1 ]] || return 0
  dir=$(dirname -- "$INSTANCE_ROOTS_FILE")
  if ! mkdir -p -- "$dir" 2>/dev/null || ! tmp=$(mktemp "$dir/.instance-roots.XXXXXX" 2>/dev/null); then
    printf 'WARNING: cannot write %s; this instance will not be offered to later installs as a model source.\n' "$INSTANCE_ROOTS_FILE" >&2
    return 0
  fi
  if printf '%s\n' "${LISTED_ROOTS[@]}" 2>/dev/null > "$tmp" && chmod 0600 -- "$tmp" 2>/dev/null \
     && mv -f -- "$tmp" "$INSTANCE_ROOTS_FILE" 2>/dev/null; then
    printf 'Recorded this instance in %s.\n' "$INSTANCE_ROOTS_FILE"
  else
    rm -f -- "$tmp" 2>/dev/null || true
    printf 'WARNING: cannot write %s; this instance will not be offered to later installs as a model source.\n' "$INSTANCE_ROOTS_FILE" >&2
  fi
}

skip_model_seed() {
  printf 'Model reuse: not using %s (%s): %s.\n' "$1" "$2" "$3"
}

# One candidate: an instance root (its models/vocalis is used) or a models folder itself. Used only when it is
# an existing, real (not symlinked) directory that is not this instance's own models folder and whose path has
# no ':', ',', newline or apostrophe (they would break the bind-mount argument). Every skip is printed.
consider_model_seed() {
  local given=$1 source=$2 models canonical
  while [[ "$given" == */ && "$given" != / ]]; do given=${given%/}; done
  if [[ -z "$given" || ! -d "$given" ]]; then skip_model_seed "$1" "$source" "it does not exist"; return 0; fi
  if [[ -L "$given" ]]; then skip_model_seed "$given" "$source" "it is a symlink"; return 0; fi
  if [[ -d "$given/models/vocalis" ]]; then
    if [[ -L "$given/models" || -L "$given/models/vocalis" ]]; then
      skip_model_seed "$given" "$source" "its models folder is a symlink"; return 0
    fi
    models=$given/models/vocalis
  else
    models=$given
  fi
  canonical=$(cd -P -- "$models" 2>/dev/null && pwd -P) || { skip_model_seed "$given" "$source" "it cannot be entered"; return 0; }
  # The own folder is said only when the user named it: the default-folder scan and the list find this
  # instance on every rerun, and a line about it each time would read like a problem when nothing is wrong.
  if [[ "$canonical" == "$OWN_MODELS_DIR" ]]; then
    [[ "$source" == "--seed-models" ]] && skip_model_seed "$given" "$source" "that is this instance's own models folder"
    return 0
  fi
  case "$canonical" in
    *:*|*,*|*\'*|*$'\n'*) skip_model_seed "$given" "$source" "its path has a colon, comma, apostrophe or line break"; return 0 ;;
  esac
  if in_list "$canonical" ${MODEL_SEED_DIRS[@]+"${MODEL_SEED_DIRS[@]}"}; then return 0; fi
  if ((${#MODEL_SEED_DIRS[@]} >= MODEL_SEED_CAP)); then
    skip_model_seed "$given" "$source" "more than $MODEL_SEED_CAP model folders were found"; return 0
  fi
  MODEL_SEED_DIRS+=("$canonical")
}

gather_model_seeds() {
  local dir
  MODEL_SEED_DIRS=()
  OWN_MODELS_DIR=$(cd -P -- "$INSTANCE_ROOT/models/vocalis" 2>/dev/null && pwd -P) || OWN_MODELS_DIR="$INSTANCE_ROOT/models/vocalis"
  for dir in ${SEED_MODEL_ARGS[@]+"${SEED_MODEL_ARGS[@]}"}; do
    consider_model_seed "$dir" "--seed-models"
  done
  if [[ -n "${HOME:-}" ]]; then
    for dir in "$HOME/.local/share/vocalis"/*/; do
      [[ -f "${dir}instance.env" ]] || continue
      consider_model_seed "$dir" "default instance folder"
    done
  fi
  for dir in ${LISTED_ROOTS[@]+"${LISTED_ROOTS[@]}"}; do
    consider_model_seed "$dir" "list of earlier instances"
  done
  printf 'Model reuse: %d local model folder(s) can supply missing files.\n' "${#MODEL_SEED_DIRS[@]}"
}

fetch_models() {
  local resume_hint=$1
  local seed_args=() seed_names="" dir n=0
  # An adopted instance: no standalone install may be running on the data before anything else uses it (item 2).
  check_adopted_not_in_use "before the model fetch"
  read_instance_roots || true
  gather_model_seeds || true
  record_instance_root || true
  # The fetch container sees each seed as a read-only bind mount at /models-seed/<n> and VOCALIS_MODEL_SEEDS
  # lists them. The candidate is checked once more here so the short -v syntax can never create a missing
  # host folder (the remaining check-then-mount race is accepted).
  for dir in ${MODEL_SEED_DIRS[@]+"${MODEL_SEED_DIRS[@]}"}; do
    if [[ ! -d "$dir" || -L "$dir" ]]; then
      skip_model_seed "$dir" "just before the model fetch" "it is no longer a real folder"
      continue
    fi
    n=$((n + 1))
    seed_args+=(-v "$dir:/models-seed/$n:ro")
    seed_names+="${seed_names:+:}/models-seed/$n"
    printf 'Model reuse: /models-seed/%d is %s (read-only).\n' "$n" "$dir"
  done
  if ((n > 0)); then seed_args+=(-e "VOCALIS_MODEL_SEEDS=$seed_names"); fi
  printf 'Acquiring model weights into %s/models/vocalis (the first run is a large download; sizes follow).\n' "$INSTANCE_ROOT"
  if compose run --rm --no-deps ${seed_args[@]+"${seed_args[@]}"} --entrypoint "$MODEL_FETCH_PYTHON" vocalis "$MODEL_FETCH_SCRIPT"; then
    printf 'Model weights: every file is present and verified.\n'
  else
    fail "Model download did not finish. $resume_hint"
  fi
}

# Local image skip (design section 5, Windows installer review amendment 11). Doug tests every image
# locally before anything is published, and a locally built image answers to
# <repo>@sha256:<image id> (proven on Windows with the containerd image store), so a reference that
# `docker image inspect` already resolves is not pulled, per service. Only absent references are
# pulled, one `compose pull <service>` each; a published reference that is not present behaves
# exactly as before. Service name -> reference: vocalis -> VOCALIS_IMAGE, taproom -> TAPROOM_IMAGE.
pull_absent_images() {
  local service ref
  local found=() absent=()
  for service in vocalis taproom; do
    if [[ "$service" == vocalis ]]; then ref=$VOCALIS_IMAGE; else ref=$TAPROOM_IMAGE; fi
    if docker image inspect "$ref" >/dev/null 2>&1; then found+=("$service"); else absent+=("$service"); fi
  done
  if ((${#found[@]})); then
    printf 'Images found locally, not pulled: %s\n' "${found[*]}"
  fi
  if ((${#absent[@]})); then
    printf 'Pulling images not present locally: %s\n' "${absent[*]}"
    for service in "${absent[@]}"; do
      compose pull "$service"
    done
  else
    printf 'No image pull needed.\n'
  fi
}

# The Taproom owner rule, shared by a first setup, a rerun, --update and an adopted install (review amendment 5; design
# section 11, item 2): provision only while the owner store is empty (a fresh instance's store always is; setup can
# leave instance.env before interactive provisioning completes, and --update over such an unfinished first install
# used to start Taproom with no owner), otherwise verify the owner with --check. The store is read through the
# resolved folder (STORE_TARGET[1]) with `find -H`: the path under the root may be a link, and a plain `find` on a
# link would list nothing and wrongly call a populated store empty. Taproom's configuration folder is mounted at
# /etc/taproom and its data folder at /data/taproom/data (item 3).
ensure_taproom_owner() {
  local owner_data_root=${STORE_TARGET[1]} provision_owner=0
  if [[ -z "$(find -H "$owner_data_root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    # setup can leave instance.env before interactive provisioning completes; an empty owner store is retryable.
    provision_owner=1
    printf 'Taproom owner store is empty: provisioning the owner.\n'
  else
    printf 'Taproom owner store has data: verifying the owner.\n'
    if ! compose run --rm --no-deps --entrypoint node taproom \
      /opt/taproom/provision-owner.mjs \
      --check --configPath /etc/taproom/config.yaml --dataRoot /data/taproom/data; then
      fail "Taproom data is nonempty but owner verification failed. Existing data was preserved; inspect it before retrying."
    fi
  fi
  if [[ "$provision_owner" == 1 ]]; then
    compose run --rm --no-deps --entrypoint node taproom \
      /opt/taproom/provision-owner.mjs \
      --configPath /etc/taproom/config.yaml --dataRoot /data/taproom/data
    OWNER_PROVISIONED_THIS_RUN=1
  fi
}

# The only two places this script starts the services (new instance / rerun, and --update). With --defer-start it
# says so instead and leaves the start to setup.ps1 (see DEFER_START at the top).
start_services() {
  # Repeated here because the model download and the owner step can run for a long time, and a standalone unit may have
  # been started again meanwhile (item 2). A no-op unless the instance adopted existing data.
  check_adopted_not_in_use "before the services start"
  if [[ "$DEFER_START" == 1 ]]; then
    printf 'Not starting the services here (--defer-start): the Windows launcher starts them.\n'
  else
    compose up -d --no-build --pull never
  fi
}

# Superseded October 10, 2026 (design section 11, item 1): this used to refuse every symlink in the seven responsibility
# paths and their parents. A responsibility path may now be a link exactly at that path to an existing real directory;
# resolve_store_paths (above) applies the rules and leaves each resolved folder in STORE_TARGET. The parents and the
# root stay real directories. Missing paths are still an error here: setup never replaces a missing store with an empty one.
resolve_store_paths 0
report_store_links
secure_mcp_servers_file

compose config --quiet
if [[ "$GPU_VARIANT" == cuda ]]; then
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -qi nvidia || fail "NVIDIA Container Toolkit is not visible to Docker."
else
  [[ -e /dev/kfd && -d /dev/dri ]] || fail "ROCm devices are unavailable."
fi

if [[ "$UPDATE" == 1 ]]; then
  pull_absent_images
  # The candidate environment names the new image, so the new image's own locks decide the model
  # set. Fetch before the candidate replaces instance.env: a failure then leaves the configuration
  # naming the image that is still running.
  fetch_models "The running instance and instance.env were not changed; run the same --update command again to resume. Finished files are kept."
  cp -- "$ENV_FILE" "$INSTANCE_ROOT/instance.env.previous"
  chmod 0600 "$INSTANCE_ROOT/instance.env.previous"
  mv -f -- "$CANDIDATE_ENV" "$ENV_FILE"
  ENV_FILE_FOR_COMPOSE=$ENV_FILE
  compose config --quiet
  # After the swap (the owner commands run on the new Taproom image, from the new instance.env) and
  # before the start: an unfinished first install gets its owner here instead of a Taproom with none.
  ensure_taproom_owner
  start_services
  if [[ "$DEFER_START" == 1 ]]; then
    printf 'Instance %s now names the new images, with the same data roots and identity; the Windows launcher starts the services. Prior settings are at %s.\n' "$INSTANCE_ID" "$INSTANCE_ROOT/instance.env.previous"
  else
    printf 'Updated instance %s using the same data roots and identity. Prior settings are at %s.\n' "$INSTANCE_ID" "$INSTANCE_ROOT/instance.env.previous"
  fi
  if [[ "$OWNER_PROVISIONED_THIS_RUN" == 1 ]]; then
    printf 'The Taproom owner was provisioned during this update (an earlier first install had not finished).\n'
    printf 'Vocalis bootstrap: %s/setup\n' "$VOCALIS_PUBLIC_URL"
    printf 'Taproom: %s\n' "$TAPROOM_PUBLIC_URL"
    printf 'Pairing: PENDING. After both vaults are initialized, copy the Vocalis pairing token into the Vocalis extension settings in Taproom and verify a short narration.\n'
  fi
  exit 0
fi

pull_absent_images
# The writability checks name the container paths the services actually use (design section 11, items 3 and 4): the
# two Vocalis stores are at the paths recorded in instance.env (VOCALIS_DATA_PATH, VOCALIS_CACHE_PATH; /data/vocalis and
# /cache/vocalis by default) and Taproom's configuration and data folders are at /etc/taproom and /data/taproom/data.
# The paths are passed as arguments to the shell, never spliced into its script.
compose run --rm --no-deps --entrypoint /bin/sh vocalis -c \
  'for p in "$@"; do test -d "$p" && test -w "$p" || { echo "Vocalis cannot write $p" >&2; exit 1; }; done' \
  sh "$VOCALIS_DATA_PATH" "$VOCALIS_CACHE_PATH" /models/vocalis /work/vocalis /logs
compose run --rm --no-deps --entrypoint /bin/sh taproom -c \
  'for p in "$@"; do test -d "$p" && test -w "$p" || { echo "Taproom cannot write $p" >&2; exit 1; }; done' \
  sh /etc/taproom /data/taproom/data /logs
# After the writability checks and before owner provisioning, on a new instance and on every rerun. A
# failed download then leaves the owner store empty, which the retry rule below treats as a clean resume.
fetch_models "Run the same setup command again to resume; finished files are kept."
ensure_taproom_owner
start_services

# The embedding model the Taproom instance configuration names (design section 11, item 11): the Docker default is the
# model existing stores use, and another old install that chose a different one needs this value set to its old value.
# A plain awk over the generated config.yaml (extensions: / models: / embedding:, two-space indents as the template
# has them); anything it cannot find is said so rather than guessed.
configured_embedding_model() {
  local config="$INSTANCE_ROOT/data/taproom/config.yaml" model=""
  if [[ -f "$config" ]]; then
    model=$(awk '
      /^[^ \t#]/ { in_ext = ($0 ~ /^extensions:/); in_models = 0; next }
      in_ext && /^  [^ \t#]/ { in_models = ($0 ~ /^  models:/); next }
      in_ext && in_models && /^    embedding:/ { sub(/^    embedding:[ \t]*/, ""); sub(/[ \t]*#.*$/, ""); gsub(/["\047]/, ""); print; exit }
    ' "$config" 2>/dev/null) || model=""
  fi
  printf '%s' "$model"
}

# An adopted instance ends here (item 2): the data is the user's existing data, so no /setup page, no "Pairing:
# PENDING" and no browser launch; the exact stop and start commands are what the switch-back runbook uses.
if [[ "$EXISTING_DATA" == 1 && "$NEW_INSTANCE" == 1 ]]; then
  embedding=$(configured_embedding_model)
  printf '\nExisting data adopted into instance %s; no existing file was converted or moved.\n' "$INSTANCE_ID"
  printf 'Vocalis: %s\n' "$VOCALIS_PUBLIC_URL"
  printf 'Taproom: %s\n' "$TAPROOM_PUBLIC_URL"
  printf 'Log in with your existing passwords. Pairing and settings are your existing ones; setup did not change or verify them.\n'
  if [[ "$ADOPT_VOCALIS_EMPTY" == 1 ]]; then
    printf 'The Vocalis data folder was empty, so Vocalis will redirect to its /setup page: open %s and initialize it.\n' "$VOCALIS_PUBLIC_URL"
  fi
  if [[ "$OWNER_PROVISIONED_THIS_RUN" == 1 ]]; then
    printf 'The Taproom data folder was empty, so its owner was created just now; log in to Taproom with that new owner.\n'
  fi
  printf 'Taproom memory embedding model: %s (extensions.models.embedding in %s/data/taproom/config.yaml).\n' \
    "${embedding:-not found in config.yaml}" "$INSTANCE_ROOT"
  printf 'If your old install used a different embedding model, set that value there and run: docker compose -p vocalis-%s restart taproom\n' "$INSTANCE_ID"
  # Switch-back removes the containers (the stores are host bind mounts, so no data is touched), which is also what
  # makes a standalone unit's start guard pass; a merely stopped container still exists and still blocks it. Coming
  # back to Docker is a setup rerun, which recreates them.
  printf 'To switch back to the standalone install: docker compose -p vocalis-%s down\n' "$INSTANCE_ID"
  printf '  (removes only the containers; your data stays where it is). To return to Docker, run: %s --root %s\n' "$PACKAGING_DIR/setup.sh" "$INSTANCE_ROOT"
  printf 'To pause Docker without switching back: docker compose -p vocalis-%s stop   (resume with: docker compose -p vocalis-%s start)\n' "$INSTANCE_ID" "$INSTANCE_ID"
  exit 0
fi

if [[ "$DEFER_START" == 1 ]]; then
  if [[ "$NEW_INSTANCE" == 1 ]]; then
    printf '\nSetup prepared instance %s; the Windows launcher starts the services.\n' "$INSTANCE_ID"
  else
    printf '\nExisting instance %s is prepared with its saved identity and roots; the Windows launcher starts the services.\n' "$INSTANCE_ID"
  fi
elif [[ "$NEW_INSTANCE" == 1 ]]; then
  printf '\nSetup started instance %s.\n' "$INSTANCE_ID"
else
  printf '\nExisting instance %s is running with its saved identity and roots.\n' "$INSTANCE_ID"
fi
# /setup is the first-run bootstrap page. An already-initialized instance is past it, so a plain
# rerun prints the plain Vocalis URL (the login page) instead of pointing at /setup.
if [[ "$NEW_INSTANCE" == 1 || "$OWNER_PROVISIONED_THIS_RUN" == 1 ]]; then
  printf 'Vocalis bootstrap: %s/setup\n' "$VOCALIS_PUBLIC_URL"
else
  printf 'Vocalis: %s\n' "$VOCALIS_PUBLIC_URL"
fi
printf 'Taproom: %s\n' "$TAPROOM_PUBLIC_URL"
if [[ "$NEW_INSTANCE" == 1 || "$OWNER_PROVISIONED_THIS_RUN" == 1 ]]; then
  printf 'Pairing: PENDING. After both vaults are initialized, copy the Vocalis pairing token into the Vocalis extension settings in Taproom and verify a short narration.\n'
  # Not with --defer-start: setup.ps1 opens the pages itself, after it has started the services (WSLg can
  # provide a display and xdg-open inside the distribution, and the pages would open before anything listens).
  if [[ "$DEFER_START" == 0 ]] && command -v xdg-open >/dev/null 2>&1 && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    xdg-open "$VOCALIS_PUBLIC_URL/setup" >/dev/null 2>&1 || true
    xdg-open "$TAPROOM_PUBLIC_URL" >/dev/null 2>&1 || true
  fi
else
  printf 'Pairing status was not changed or verified by this command.\n'
fi
