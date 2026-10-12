"""`scripts/set-admin-credentials.py` must REFUSE once a vault exists.

ONE PASSWORD, TWO STORES (SPEC_5_0_M5 §4.1). The admin password authenticates against the
werkzeug hash in admin_credentials.yaml AND unwraps the DEK via argon2id. This script writes
only the hash. Run it against an initialized vault with a NEW password and the halves drift:
the login succeeds, the unlock then fails, because the DEK is still wrapped under the old
password. The server looks broken and the failure names nothing that points here.

`vocalis_server.py`'s POST /admin/set-credentials is the supported path — it re-wraps the DEK
first and writes the hash only once the vault has accepted it. This test pins the refusal
that sends people there.
"""
import subprocess
import sys

from conftest import REPO_ROOT

SCRIPT = REPO_ROOT / "scripts" / "set-admin-credentials.py"
PYTHON = sys.executable


def _run(*args, **kw):
    return subprocess.run([PYTHON, str(SCRIPT), *args],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=120, **kw)


def test_refuses_when_a_vault_keyfile_exists(tmp_path):
    keyfile = tmp_path / "vault_keys.yaml"
    keyfile.write_text("kdf: {}\n", encoding="utf-8")     # contents are irrelevant; existence is the signal
    creds = tmp_path / "admin_credentials.yaml"

    # --file is ALWAYS passed: the script's default target is the real repo-root credentials
    # file, and a test must never write there.
    r = _run("--file", str(creds), "--keyfile", str(keyfile))

    assert r.returncode == 3, f"expected the refusal exit code\nstdout={r.stdout}\nstderr={r.stderr}"
    assert "REFUSING" in r.stderr
    assert not creds.exists(), "it refused but still wrote the hash — that is the brick it exists to prevent"


def test_the_refusal_names_the_supported_path(tmp_path):
    """A refusal that does not say what to do instead just gets --force'd."""
    keyfile = tmp_path / "vault_keys.yaml"
    keyfile.write_text("kdf: {}\n", encoding="utf-8")

    r = _run("--file", str(tmp_path / "admin_credentials.yaml"), "--keyfile", str(keyfile))

    assert "web UI" in r.stderr
    assert "--force" in r.stderr


def test_force_is_documented_as_same_password_only(tmp_path):
    h = _run("--help").stdout
    assert "--force" in h
    assert "--keyfile" in h
    assert "SAME" in h, "the only safe use of --force is re-hashing the password the vault already holds"
