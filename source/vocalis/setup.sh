#!/usr/bin/env bash
# ==============================================================================
#  Vocalis cross-vendor setup  (Linux / macOS)
#  Companion to setup.bat (Windows/CUDA). Same venv, same dep list; the ONLY
#  difference is which PyTorch wheel gets installed, chosen by detected vendor:
#
#     nvidia-smi present          -> CUDA wheel   (download.pytorch.org/whl/cu124)
#     rocminfo or /opt/rocm       -> ROCm wheel   (download.pytorch.org/whl/rocm7.2)
#     neither                     -> CPU wheel    (download.pytorch.org/whl/cpu)
#
#  On ROCm, PyTorch speaks through the CUDA namespace via HIP, so all runtime
#  code (torch.cuda.*, .to("cuda:i")) is vendor-neutral. Cross-vendor is a
#  SETUP-TIME concern only — see DESIGN_2.0 §3.
#
#  Installing is only half of it. Setup also ASKS the six questions it used to
#  answer by silence (paths, admin login, encryption, service) — see the
#  configuration pass below and README "After setup". It is skipped whenever
#  stdin is not a tty, so CI and re-runs are unaffected.
#
#  Usage:
#     ./setup.sh                 auto-detect vendor, then configure
#     ./setup.sh --vendor rocm   force ROCm  (also: cuda | cpu)
#     ./setup.sh --cpu           shorthand for --vendor cpu
#     ./setup.sh --dry-run       print the resolved plan (vendor + wheel + index)
#                                and exit WITHOUT installing anything
#     ./setup.sh --no-configure  install only; ask nothing
#     ./setup.sh --configure-only  ask only; install nothing (an existing install)
#
#  Overridable via environment:
#     VOCALIS_VENDOR=rocm|cuda|cpu   same as --vendor
#     VOCALIS_PYTHON=python3.10      interpreter used to create the venv
#     VOCALIS_TORCH_SPEC="..."       override the full torch/torchaudio pip spec
#     VOCALIS_ROCM_DIR=/opt/rocm     dir probed for the ROCm-vendor fallback
#     VOCALIS_SETUP_ASSUME_TTY=1     take the answers from a pipe instead of a
#                                    terminal — the seam the tests drive
# ==============================================================================
set -euo pipefail

# ------------------------------------------------------------------ paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/venv"
PY_BOOT="${VOCALIS_PYTHON:-python3}"

echo "================================================"
echo " Vocalis Setup  -  cross-vendor (Linux/macOS)"
echo "================================================"
echo

# ------------------------------------------------------------------ arg parse
VENDOR="${VOCALIS_VENDOR:-}"
DRY_RUN=0
CONFIGURE=1
CONFIGURE_ONLY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --vendor) VENDOR="${2:-}"; shift 2 ;;
        --vendor=*) VENDOR="${1#*=}"; shift ;;
        --cpu) VENDOR="cpu"; shift ;;
        --dry-run|--print-plan) DRY_RUN=1; shift ;;
        --no-configure) CONFIGURE=0; shift ;;
        --configure-only) CONFIGURE_ONLY=1; CONFIGURE=1; shift ;;
        -h|--help)
            # To the closing banner, not a hard line number -- the header grows.
            sed -n '2,/^# =\{10,\}$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "ERROR: unknown argument '$1' (try --help)"; exit 1 ;;
    esac
done

# ------------------------------------------------------------------ vendor detect
# The ROCm filesystem probe is overridable (VOCALIS_ROCM_DIR) so detection can be
# exercised deterministically in tests regardless of the host's real /opt/rocm.
ROCM_DIR="${VOCALIS_ROCM_DIR:-/opt/rocm}"
detect_vendor() {
    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "cuda"; return
    fi
    if command -v rocminfo >/dev/null 2>&1 || [ -d "$ROCM_DIR" ] || ls -d "${ROCM_DIR}"* >/dev/null 2>&1; then
        echo "rocm"; return
    fi
    echo "cpu"
}

if [ -z "$VENDOR" ]; then
    VENDOR="$(detect_vendor)"
    echo "[detect] vendor: $VENDOR  (nvidia-smi/rocminfo probe)"
else
    echo "[detect] vendor: $VENDOR  (forced)"
fi

case "$VENDOR" in
    cuda|rocm|cpu) ;;
    *) echo "ERROR: invalid vendor '$VENDOR' (expected cuda|rocm|cpu)"; exit 1 ;;
esac

# The torch/torchaudio spec per vendor. CUDA/CPU mirror setup.bat's 2.6.0 pin.
# ROCm is deliberately UNpinned: the rocm7.2 index is new and its exact published
# versions aren't confirmed on hardware yet, so hard-pinning a specific version
# risks a guaranteed resolution failure (asking for a version the index doesn't
# carry). Installing "torch torchaudio" from the rocm7.2 index lets pip resolve the
# matched pair the index actually offers. Pin it explicitly via VOCALIS_TORCH_SPEC
# once a known-good pair is verified on the target hardware.
#   NOTE: finalize this on ROCm hardware — import torch, confirm torch.version.hip
#   is set and the expected devices are visible, then record the exact working versions
#   here as a reproducible pin.
case "$VENDOR" in
    cuda)
        TORCH_SPEC="${VOCALIS_TORCH_SPEC:-torch==2.6.0+cu124 torchaudio==2.6.0+cu124}"
        TORCH_INDEX="https://download.pytorch.org/whl/cu124"
        TORCH_LABEL="PyTorch 2.6.0 + CUDA 12.4" ;;
    rocm)
        TORCH_SPEC="${VOCALIS_TORCH_SPEC:-torch torchaudio}"
        TORCH_INDEX="https://download.pytorch.org/whl/rocm7.2"
        TORCH_LABEL="PyTorch (latest ROCm 7.2 build — pin after hardware verification)" ;;
    cpu)
        TORCH_SPEC="${VOCALIS_TORCH_SPEC:-torch==2.6.0 torchaudio==2.6.0}"
        TORCH_INDEX="https://download.pytorch.org/whl/cpu"
        TORCH_LABEL="PyTorch 2.6.0 (CPU-only)" ;;
esac

# ------------------------------------------------------------------ dry-run
# Print the resolved install plan and stop — nothing is created or downloaded.
# Machine-readable key=value lines so tooling/tests can assert on them.
if [ "$DRY_RUN" = "1" ]; then
    echo
    echo "--- dry run: resolved plan (no install) ---"
    echo "vendor=$VENDOR"
    echo "torch_spec=$TORCH_SPEC"
    echo "torch_index=$TORCH_INDEX"
    echo "torch_label=$TORCH_LABEL"
    exit 0
fi

# ==============================================================================
#  THE CONFIGURATION PASS
#
#  🔴 EVERYTHING ELSE IN THIS FILE INSTALLS. NONE OF IT CONFIGURES. That gap is
#  the whole reason this section exists: six deployment decisions were left for
#  the user to find in prose, and a script that never mentions them makes them
#  by staying quiet. One of the six cannot be un-made. `vault_migrate --enable`
#  refuses a store that already holds data, by design, so "I'll decide later"
#  resolves to "no, permanently, unless I wipe" -- and the ONLY moment the store
#  is guaranteed empty is right here, seconds after the install.
#
#  ⚠️ IT MUST ALWAYS BE SKIPPABLE. A setup script that blocks on a prompt breaks
#  CI, re-runs and every unattended install, so: --no-configure skips it, and it
#  skips ITSELF whenever stdin is not a tty. Nothing below is load-bearing for a
#  working install; every step can be done by hand later (README "After setup").
# ==============================================================================

# Interactive only when someone is actually there to answer. The env seam exists
# so the tests can drive the prompts from a pipe -- same reason VOCALIS_ROCM_DIR
# exists for vendor detection.
is_interactive() { [ -t 0 ] || [ "${VOCALIS_SETUP_ASSUME_TTY:-0}" = "1" ]; }

# The platform, resolved ONCE and overridable -- same reason VOCALIS_ROCM_DIR is
# overridable. Two of the four steps are Linux-only (encryption rests on yama
# ptrace_scope; units are systemd), and without this seam those branches could
# only ever be exercised on a Linux host, i.e. not on the machine the suite is
# usually run from. `systemctl` needs no seam: the tests stub PATH already.
SETUP_OS="${VOCALIS_SETUP_OS:-$(uname -s 2>/dev/null || echo Linux)}"

# `read` returns non-zero at EOF and this script runs under `set -e`, so every
# read is guarded -- an exhausted pipe must fall back to the default, not kill
# the install after the wheels are already down.
#
# 🔴 AND IT STRIPS THE CARRIAGE RETURN. A line arriving as CRLF -- piped from a
# Windows-side tool, an answers file saved on Windows, anything crossing MSYS --
# leaves `read` holding a lone "\r". That is NOT empty, so the default silently
# loses to it, and what gets written is a path ending in an invisible control
# character: a cache directory nobody can find and a unit that will not start.
# The symptom is a value that LOOKS empty when printed, because the CR sends the
# cursor back over it.
_answer() {  # _answer "<default>" -> the typed line, or the default
    local def="$1" ans=""
    read -r ans || ans=""
    ans="${ans%$'\r'}"
    [ -n "$ans" ] || ans="$def"
    printf '%s' "$ans"
}

ask() {  # ask "<question>" "<default>" -> answer on stdout
    local q="$1" def="$2"
    printf '    %s\n      [%s]: ' "$q" "$def" >&2
    _answer "$def"
}

ask_yn() {  # ask_yn "<question>" "y|n" -> exit 0 for yes
    local q="$1" def="$2" ans="" hint="y/N"
    [ "$def" = "y" ] && hint="Y/n"
    printf '    %s [%s]: ' "$q" "$hint" >&2
    ans="$(_answer "$def")"
    case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# Mirrors tts_utils.cache_root() for the platforms this script runs on. 🔴 If that
# function's defaults ever change, this changes with it -- a setup script that
# offers a "default" the app does not use is worse than offering nothing.
default_cache_dir() {
    case "$SETUP_OS" in
        Darwin) echo "$HOME/Library/Caches/vocalis" ;;
        *)      echo "${XDG_CACHE_HOME:-$HOME/.cache}/vocalis" ;;
    esac
}

# A suffix that names THIS install, for when another one already owns the shared
# defaults: Vocalis.encrypted -> "encrypted", Vocalis-test -> "test".
instance_suffix() {
    local b; b="$(basename "$SCRIPT_DIR" | tr '[:upper:]' '[:lower:]')"
    case "$b" in
        vocalis)       echo "" ;;
        vocalis[-._]*) echo "${b#vocalis?}" ;;
        *)             echo "$b" ;;
    esac
}

# Who else is on this box. The marker is written by procs.claim_root() as
# "<pid> <install root>"; an install path that is not ours means the shared
# default is taken. Units are the second signal -- a service can be installed
# and stopped, so its cache may hold no marker at all.
other_install_root() {
    local marker; marker="$(default_cache_dir)/.vocalis-instance"
    [ -f "$marker" ] || return 1
    local held; held="$(head -n 1 "$marker" | cut -d' ' -f2- | tr -d '\r')"
    [ -n "$held" ] && [ "$held" != "$SCRIPT_DIR" ] || return 1
    echo "$held"
}

other_unit_count() {
    local n=0 f
    for f in "$HOME"/.config/systemd/user/*vocalis*.service; do
        [ -e "$f" ] && n=$((n + 1))
    done
    echo "$n"
}

configure_pass() {
    local cache_def scratch_def applio_def suffix other units
    local cache scratch applio port answered_env=0 did_admin=0 did_crypt=0 did_unit=0

    echo
    echo "================================================"
    echo " Configuration - the part setup used to skip"
    echo "================================================"
    echo
    echo " Six decisions are yours, not the installer's. Press Enter to take"
    echo " every default; the whole pass is optional and re-runnable with"
    echo " ./setup.sh --configure-only. Full detail: README, 'After setup'."

    # ---------------------------------------------------------------- 0. neighbors
    suffix="$(instance_suffix)"; [ -n "$suffix" ] || suffix="2"
    cache_def="$(default_cache_dir)"
    scratch_def="$SCRIPT_DIR/work/scratch"
    applio_def="$HOME/Applio"
    other="$(other_install_root || true)"
    units="$(other_unit_count)"

    if [ -n "$other" ] || [ "$units" -gt 0 ]; then
        echo
        echo " ⚠️  ANOTHER VOCALIS IS ALREADY ON THIS BOX."
        [ -n "$other" ] && echo "     $cache_def is claimed by the install at: $other"
        [ "$units" -gt 0 ] && echo "     $units vocalis unit(s) in ~/.config/systemd/user/"
        echo
        echo "     Two installs sharing a cache is not allowed -- the second one"
        echo "     refuses to start -- and a shared ~/Applio silently trains both"
        echo "     into one workspace. The defaults below are suffixed for you."
        cache_def="$cache_def-$suffix"
        applio_def="$applio_def-$suffix"
    fi

    # ---------------------------------------------------------------- 1. paths
    echo
    echo " [1/4] Where this instance keeps its data"
    echo
    echo "   The cache holds the MD5 audio cache and chunk workspaces. It is"
    echo "   regenerable and safe to delete."
    cache="$(ask "cache directory" "$cache_def")"
    echo
    echo "   The scratch is the only place plaintext audio touches disk, for the"
    echo "   external tools that cannot be handed data in memory. Swept at every"
    echo "   start; put it on an encrypted volume if you have one."
    scratch="$(ask "scratch directory" "$scratch_def")"
    echo
    echo "   Applio's training workspace -- ~5 GB of your sliced voice per trained"
    echo "   model, kept forever, and NOTHING sweeps it."
    applio="$(ask "Applio workspace" "$applio_def")"

    # Only write the file when it says something the defaults do not. A single
    # install on default paths is correct with no file at all, and an empty
    # vocalis.env is one more thing to explain later.
    if [ "$cache" != "$(default_cache_dir)" ] || [ "$scratch" != "$SCRIPT_DIR/work/scratch" ] \
       || [ "$applio" != "$HOME/Applio" ]; then
        if [ -f "$SCRIPT_DIR/vocalis.env" ] && ! ask_yn "vocalis.env already exists - overwrite it?" "n"; then
            echo "      kept the existing vocalis.env unchanged."
        else
            # 🔴 A FILE, NOT `Environment=` LINES IN THE UNIT. A shell does not
            # inherit those, so vault_migrate.py run by hand would resolve the
            # cache to whichever install owns ~/.cache/vocalis and offer to clear
            # another live instance's data. systemd reads this file via
            # EnvironmentFile=; the tools read it via tts_utils.load_env_file().
            cat > "$SCRIPT_DIR/vocalis.env" <<ENV
# Per-instance paths for this Vocalis install -- written by setup.sh.
# systemd reads it via EnvironmentFile=; the hand-run maintenance tools read it
# themselves (tts_utils.load_env_file), so the two CANNOT disagree about whose
# data they are touching. Absolute paths only -- this format gets no shell
# expansion from either reader, so a variable or a tilde stays literal text.
VOCALIS_CACHE_DIR=$cache
VOCALIS_SCRATCH_DIR=$scratch
VOCALIS_APPLIO_DIR=$applio
ENV
            echo "      wrote $SCRIPT_DIR/vocalis.env"
            answered_env=1
        fi
    else
        echo "      all three are the defaults, so no vocalis.env is needed."
    fi

    # ---------------------------------------------------------------- 2. admin login
    echo
    echo " [2/4] The admin login"
    echo
    echo "   With no password set, the web UI and every setting in it is open to"
    echo "   anyone who can reach the port."
    if [ ! -x "$PYTHON" ]; then
        echo "      (no venv yet -- run scripts/set-admin-credentials.py after installing.)"
    elif ask_yn "set the admin login now?" "y"; then
        if "$PYTHON" "$SCRIPT_DIR/scripts/set-admin-credentials.py"; then
            did_admin=1
        else
            echo "      set-admin-credentials.py failed -- re-run it by hand; nothing else is affected."
        fi
    fi

    # ---------------------------------------------------------------- 3. encryption
    echo
    echo " [3/4] Encryption at rest"
    if [ "$SETUP_OS" != "Linux" ]; then
        echo "      Linux only (the guarantee rests on yama ptrace_scope) -- skipped."
        echo "      Use FileVault/BitLocker instead; README 'Why Linux only'."
    elif [ ! -x "$PYTHON" ]; then
        echo "      (no venv yet -- run src/vault_migrate.py after installing, before you render.)"
    else
        echo
        echo "   🔴 THIS IS THE ONE THAT CANNOT WAIT. Encryption can only be turned"
        echo "      on while the data store is EMPTY -- which it is, right now, and"
        echo "      will not be after your first render. Vocalis does not migrate"
        echo "      existing data in either direction, by design. Saying no here is"
        echo "      a real answer: unencrypted is a supported configuration."
        echo
        echo "      You will need the admin password from step 2 (it IS the vault"
        echo "      password), and it prints a recovery key ONCE. Write it down."
        if ask_yn "turn on encryption at rest now?" "n"; then
            # Export what was just chosen: vault_migrate prints the roots it
            # resolved before it touches anything, and those must be THIS
            # install's, not whichever one owns the $HOME default.
            if VOCALIS_CACHE_DIR="$cache" VOCALIS_SCRATCH_DIR="$scratch" \
               VOCALIS_APPLIO_DIR="$applio" "$PYTHON" "$SCRIPT_DIR/src/vault_migrate.py"; then
                did_crypt=1
            else
                echo "      vault_migrate did not complete -- the install is unencrypted and fine."
                echo "      Re-run it (README 'Encryption') BEFORE you generate anything."
            fi
        fi
    fi

    # ---------------------------------------------------------------- 4. systemd unit
    echo
    echo " [4/4] Running it as a service"
    if [ "$SETUP_OS" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
        echo "      no systemd here -- start it with ./scripts/start_web.sh."
    else
        echo
        echo "   Started by hand, Vocalis stops with your shell. A user unit with"
        echo "   linger survives logout and reboot. This writes the unit for you to"
        echo "   read; it does NOT install or start anything."
        if ask_yn "write a filled-in systemd unit?" "y"; then
            port="$(ask "port" "7870")"
            # 🔴 vocalis.py, NOT src/vocalis_server.py -- launching the module
            # directly makes it __main__, so a later `import vocalis_server`
            # re-executes the whole file under a second name and installs a fresh
            # LOCKED vault store over the live one.
            cat > "$SCRIPT_DIR/vocalis.service" <<UNIT
[Unit]
Description=Vocalis - Chatterbox TTS server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
# systemd does NOT read ~/.bashrc, so put box-wide env (HF_HOME,
# HIP_VISIBLE_DEVICES on an AMD box with an iGPU) here or in vocalis.env.
# The leading '-' means "fine if absent" -- a default single install needs no file.
EnvironmentFile=-$SCRIPT_DIR/vocalis.env
ExecStart=$SCRIPT_DIR/venv/bin/python $SCRIPT_DIR/vocalis.py --host 0.0.0.0 --port $port
# always, not on-failure: the web UI's "Free all VRAM" button restarts the
# process by exiting cleanly, and on-failure would leave it down.
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
            did_unit=1
            echo "      wrote $SCRIPT_DIR/vocalis.service. To install it:"
            echo "        cp $SCRIPT_DIR/vocalis.service ~/.config/systemd/user/"
            echo "        systemctl --user daemon-reload && systemctl --user enable --now vocalis"
            echo "        loginctl enable-linger \$USER      # survive logout/reboot"
            echo "      HTTPS, two instances on one box, logs and rollback: DEPLOYMENT.md"
        fi
    fi

    # ---------------------------------------------------------------- summary
    echo
    echo " ------------------------------------------------------------------"
    echo " Configured:"
    [ "$answered_env" = "1" ] && echo "   vocalis.env        per-instance paths" || echo "   paths              defaults (no vocalis.env needed)"
    [ "$did_admin" = "1" ]   && echo "   admin login        set" || echo "   admin login        NOT SET - the UI is open to the LAN"
    [ "$did_crypt" = "1" ]   && echo "   encryption         ON - keep that recovery key safe" || echo "   encryption         off - and this is the last easy moment to change it"
    [ "$did_unit" = "1" ]    && echo "   vocalis.service    written (not installed)" || echo "   service            none - start it by hand"
    echo " ------------------------------------------------------------------"
}

# --configure-only: an install that already exists just wants the questions.
if [ "$CONFIGURE_ONLY" = "1" ]; then
    PYTHON="$VENV/bin/python"
    if ! is_interactive; then
        echo "ERROR: --configure-only needs a terminal (stdin is not a tty)." >&2
        exit 1
    fi
    configure_pass
    exit 0
fi

# ------------------------------------------------------------------ 1. venv
if [ -x "$VENV/bin/python" ]; then
    echo "[1/6] Virtual environment already exists, skipping."
else
    echo "[1/6] Creating virtual environment in ./venv (via $PY_BOOT) ..."
    if ! command -v "$PY_BOOT" >/dev/null 2>&1; then
        echo "ERROR: '$PY_BOOT' not found. Install Python 3.10+ or set VOCALIS_PYTHON."
        exit 1
    fi
    "$PY_BOOT" -m venv "$VENV"
fi

PYTHON="$VENV/bin/python"

# ------------------------------------------------------------------ 2. pip
echo "[2/6] Upgrading pip..."
"$PYTHON" -m pip install --upgrade pip --quiet

# ------------------------------------------------------------------ 3. torch
echo "[3/6] Installing $TORCH_LABEL ..."
echo "      index: $TORCH_INDEX"
# shellcheck disable=SC2086  # TORCH_SPEC is intentionally word-split into args
"$PYTHON" -m pip install $TORCH_SPEC --index-url "$TORCH_INDEX"

# ------------------------------------------------------------------ 4. chatterbox (no-deps)
# --no-deps so pip doesn't drag in a CPU-only torch over the vendor wheel above.
echo "[4/6] Installing Chatterbox TTS package (no-deps)..."
"$PYTHON" -m pip install \
    "$SCRIPT_DIR/../../packaging/chatterbox/chatterbox_tts-0.1.7+vocalis.1-py3-none-any.whl" \
    --no-deps

# ------------------------------------------------------------------ 5. remaining deps
# Mirrors setup.bat exactly (torch/torchaudio excluded — installed above).
# resemble-perth clones from GitHub, so git must be on PATH.
echo "[5/6] Installing remaining dependencies..."
echo "      (resemble-perth clones from GitHub - git must be on PATH)"
"$PYTHON" -m pip install \
    "numpy>=2.0.0" \
    "librosa==0.11.0" \
    "s3tokenizer" \
    "transformers==5.2.0" \
    "diffusers==0.29.0" \
    "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@master" \
    "conformer==0.3.2" \
    "safetensors==0.5.3" \
    "spacy-pkuseg" \
    "pyloudnorm" \
    "omegaconf" \
    "pytest" \
    "pytest-xdist" \
    "pytest-timeout" \
    "python-docx" \
    "flask" \
    "flask-cors" \
    "loguru" \
    "lxml==6.1.3" \
    "soundfile" \
    "ruamel.yaml" \
    "cryptography>=42" \
    "argon2-cffi" \
    "pillow>=10"

# ------------------------------------------------------------------ verify
echo
echo "Verifying torch backend matches the '$VENDOR' target..."
VOCALIS_EXPECT_VENDOR="$VENDOR" "$PYTHON" - <<'PY'
import os, sys, torch
vendor = os.environ["VOCALIS_EXPECT_VENDOR"]
hip, cuda = torch.version.hip, torch.version.cuda
ok = True
if vendor == "rocm":
    ok = hip is not None
    detail = f"torch.version.hip={hip!r}  torch.version.cuda={cuda!r}"
elif vendor == "cuda":
    ok = cuda is not None and hip is None
    detail = f"torch.version.cuda={cuda!r}  torch.version.hip={hip!r}"
else:  # cpu
    ok = hip is None and cuda is None
    detail = f"torch.version.cuda={cuda!r}  torch.version.hip={hip!r}"
mark = "OK" if ok else "MISMATCH"
print(f"  torch {torch.__version__}  |  {detail}  --  {mark}")
if not ok:
    print(f"  WARNING: installed torch does not match expected vendor '{vendor}'.")
    print("  Re-run step 3 for the correct wheel, or force it with VOCALIS_TORCH_SPEC.")
    sys.exit(1)
try:
    print(f"  torch.cuda.is_available()={torch.cuda.is_available()}  "
          f"device_count={torch.cuda.device_count()}")
except Exception as exc:  # detection must never hard-fail setup
    print(f"  (device probe skipped: {exc})")
PY

# ------------------------------------------------------------------ 6. neural enhance
# NOT OPTIONAL. Chatterbox synthesizes at 24 kHz, so its output is digital silence above
# ~11 kHz. A 40 kHz RVC model trained on that is asked to reproduce a band that does not
# exist, which hands its discriminator a free tell ("any energy up there = fake") and the
# run can corrupt a training job. Vocalis refuses band-limited training audio, so this
# toolchain is required.
#
# It gets its OWN venv because resemble-enhance pins torch==2.1.1 and we run 2.13 -- they
# cannot share an environment. But they are installed together, here, by one setup. The
# vendor/torch resolution above is passed straight through so both venvs agree.
echo
echo "[6/6] Installing the neural-enhance toolchain (isolated venv)..."
ENHANCE_SETUP="$SCRIPT_DIR/scripts/enhance/setup.sh"
if [ -x "$ENHANCE_SETUP" ] || [ -f "$ENHANCE_SETUP" ]; then
    TORCH_INDEX="$TORCH_INDEX" TORCH_SPEC="$TORCH_SPEC" VOCALIS_PYTHON="$PY_BOOT"         bash "$ENHANCE_SETUP"
else
    echo "  ERROR: $ENHANCE_SETUP not found -- training will refuse to run without it." >&2
    exit 1
fi

echo
echo "================================================"
echo " Vocalis setup complete!  (vendor: $VENDOR)"
echo "================================================"
echo
echo " Launcher scripts:"
echo "   ./scripts/start_web.sh       Vocalis web app (port 7870)"
echo "   ./scripts/generate.sh        CLI generation  (./scripts/generate.sh --help)"
echo "   ./scripts/book_to_audio.sh   Book -> audiobook pipeline"
echo "   ./scripts/run_tests.sh       Test suite      (add --gpu for GPU tests)"
echo
echo " Models download from HuggingFace on first run (~3-5 GB)."
echo " ffmpeg/ffprobe must be on PATH for MP3 encoding + duration."
echo
# The configuration pass runs HERE, once the venv exists -- steps 2 and 3 drive
# tools that import Vocalis's own modules. It asks nothing when it cannot ask.
if [ "$CONFIGURE" = "1" ] && is_interactive; then
    configure_pass
else
    # Skipped. The user still has to know that setup configured NOTHING, because
    # that is how the encryption decision (install-time, effectively one-way) got
    # made by silence. Point at the one section that lists what is left.
    echo " ------------------------------------------------------------------"
    echo " NOT CONFIGURED YET. Setup installs; it does not configure."
    if [ "$CONFIGURE" = "1" ]; then
        echo " (no terminal to ask on -- re-run './setup.sh --configure-only'"
        echo "  from a shell to answer the questions interactively.)"
    fi
    echo " Six decisions are still yours: the admin login, encryption at rest,"
    echo " three per-instance paths, and whether it runs as a service."
    echo
    echo " ONE of them - encryption - can only be made while the store is"
    echo " EMPTY, so read this BEFORE your first render:"
    echo
    echo "   README.md, section 'After setup - what you still have to decide'"
    echo " ------------------------------------------------------------------"
fi
echo
