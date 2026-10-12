#!/usr/bin/env bash
# Apply and verify the Vocalis M0 API-widening overlay on an ACE-Step checkout.
#
# ACE-Step's /release_task cannot reach ~25 parameters that its own pipeline
# applies on every job — Retake, Edit/morph, DCW, sampler mode, normalization,
# fades — so they sit at dataclass defaults nobody chose.  This overlay wires
# them through.  It is additive only: three files, no logic changed.
#
# The service runs this verifier at startup and refuses to start if the overlay is missing or
# incomplete. That prevents a checkout update from silently dropping request parameters.
#
# Idempotent — safe to run on every start.  Never hand-edit the checkout.
#
# Usage:  scripts/acestep/apply-overlay.sh
# Env:    ACESTEP_HOME    checkout root      (default ~/ACE-Step-1.5)
#         ACESTEP_PYTHON  interpreter        (default $ACESTEP_HOME/.venv/bin/python)

set -euo pipefail

ACESTEP_HOME="${ACESTEP_HOME:-$HOME/ACE-Step-1.5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$HERE/verify-overlay.py"
PYTHON="${ACESTEP_PYTHON:-$ACESTEP_HOME/.venv/bin/python}"

# Apply each patch independently. `git apply` is atomic, so separate patches allow one overlay to
# be applied when another is already present.
PATCHES=(api-widening.patch lm-dtype.patch tempdir-cache.patch)

die() { echo "acestep-overlay: $*" >&2; exit 1; }

[ -d "$ACESTEP_HOME" ] || die "no ACE-Step checkout at $ACESTEP_HOME"
[ -f "$VERIFY" ]       || die "verifier not found: $VERIFY"
[ -x "$PYTHON" ]       || die "no ACE-Step interpreter at $PYTHON"
for p in "${PATCHES[@]}"; do
  [ -f "$HERE/$p" ] || die "patch not found: $HERE/$p"
done

cd "$ACESTEP_HOME"

if "$PYTHON" "$VERIFY" "$ACESTEP_HOME" >/dev/null 2>&1; then
  echo "acestep-overlay: already present and verified"
  exit 0
fi

for p in "${PATCHES[@]}"; do
  PATCH="$HERE/$p"
  # ⚠️ `--reverse --check` IS THE IDEMPOTENCY TEST, not the verifier.  The verifier
  # answers one question about the whole overlay; this asks "is THIS hunk already in
  # the tree?", which is what lets one patch land on a checkout that already carries
  # its siblings.  It succeeds only when the patch could be undone, i.e. it is present.
  if git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "acestep-overlay: $p already applied"
    continue
  fi
  echo "acestep-overlay: applying $p"
  if git apply --check "$PATCH" 2>/dev/null; then
    git apply "$PATCH"
  elif git apply --3way --check "$PATCH" 2>/dev/null; then
    git apply --3way "$PATCH"
  else
    die "$p no longer applies to this checkout — upstream has moved.
    Regenerate scripts/acestep/$p against the current source in the Vocalis
    repo and redeploy.  Do NOT hand-edit the checkout: a patch that only
    exists in the working tree is the exact failure this guards."
  fi
done

# Re-verify after applying.  A patch that applies is not a patch that works —
# upstream can rename a pipeline field and leave the diff still applying cleanly.
if ! "$PYTHON" "$VERIFY" "$ACESTEP_HOME"; then
  die "overlay applied but verification failed — refusing to declare it good"
fi
