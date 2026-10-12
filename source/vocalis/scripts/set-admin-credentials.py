#!/usr/bin/env python3
r"""Set the Vocalis admin username and password interactively.

The script stores a salted Werkzeug password hash and never writes the plaintext password. Use a
platform wrapper so the target service restarts after the credentials change:
  scripts/set-admin-credentials.sh   (Linux; service selected by VOCALIS_SERVICE)
  scripts\set-admin-credentials.bat  (Windows)

When credentials are unset, the web UI does not require login. On encrypted installs, the admin
password also unwraps the vault key; this script refuses updates because it writes only the login
hash. Change the password in the web UI, which updates the vault key and login hash together.

Use VOCALIS_SERVICE to select the correct unit when multiple installs share a host.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

import yaml
from werkzeug.security import generate_password_hash

REPO_ROOT = Path(__file__).resolve().parent.parent   # this file lives in scripts/; repo root is one up
DEFAULT_FILE = REPO_ROOT / "admin_credentials.yaml"
DEFAULT_KEYFILE = REPO_ROOT / "vault_keys.yaml"      # vault_migrate.py: roots[0] is the install root


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Set the Vocalis admin username + password (stores only the password hash).")
    ap.add_argument("--file", type=Path, default=DEFAULT_FILE, help="credentials file to write")
    ap.add_argument("--keyfile", type=Path, default=DEFAULT_KEYFILE,
                    help="vault keyfile to check for (default: <install root>/vault_keys.yaml); "
                         "matches vault_migrate.py's default, which is roots[0] = the install root")
    ap.add_argument("--force", action="store_true",
                    help="write the hash even though a vault exists. ONLY correct when the password "
                         "you are about to type is the SAME one the vault already holds — e.g. "
                         "admin_credentials.yaml was lost or corrupted and the vault is intact. "
                         "A DIFFERENT password here bricks unlock.")
    args = ap.parse_args()

    # See the module docstring. One password, two stores — and this script only writes one of them.
    if args.keyfile.exists() and not args.force:
        print(f"REFUSING: this install is encrypted — {args.keyfile} exists.", file=sys.stderr)
        print("", file=sys.stderr)
        print("The admin password is also the vault password. This script writes only the login", file=sys.stderr)
        print("hash, so a NEW password here would log you in and then fail to unlock: the DEK", file=sys.stderr)
        print("stays wrapped under the old one. Change it in the web UI instead — Settings ->", file=sys.stderr)
        print("admin credentials — which re-wraps the DEK and writes the hash together.", file=sys.stderr)
        print("", file=sys.stderr)
        print("Re-hashing the SAME password (lost admin_credentials.yaml, vault intact)?", file=sys.stderr)
        print("  --force", file=sys.stderr)
        return 3

    data: dict = {}
    if args.file.is_file():
        loaded = yaml.safe_load(args.file.read_text(encoding="utf-8")) or {}
        if isinstance(loaded, dict):
            data = loaded

    current_user = str(data.get("username", "admin"))
    username = input(f"Admin username [{current_user}]: ").strip() or current_user

    # Explain that this password also unlocks the vault before the user chooses it.
    print("\nVocalis has ONE password. This is your web-UI login — and if you turn encryption on,")
    print("the SAME password is what unlocks the vault: logging in is what unwraps the key.")
    print("Choose it accordingly.\n")
    pw = getpass.getpass("New admin password: ")
    if not pw:
        print("Aborted: empty password.", file=sys.stderr)
        return 2
    if pw != getpass.getpass("Confirm password: "):
        print("Aborted: passwords do not match.", file=sys.stderr)
        return 2

    data["username"] = username
    data["password_hash"] = generate_password_hash(pw)          # werkzeug hash, salted (scrypt default)

    # Atomic, and 0600 BEFORE it is visible at the real path. The old code wrote in place
    # (a crash mid-write left a truncated YAML — which the server then read on its
    # fail-open path and used to DISABLE authentication) and chmod'd afterward (so the
    # hash existed world-readable for a moment, permanently so if the chmod failed).
    args.file.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.file.with_suffix(".yaml.part")
    tmp.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    try:
        tmp.chmod(0o600)                                       # owner-only, best effort
    except OSError:
        pass
    os.replace(tmp, args.file)

    print(f"\nAdmin credentials updated (user: {username}) -> {args.file}")
    print("Only the scrypt hash was written; the plaintext was not stored.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
