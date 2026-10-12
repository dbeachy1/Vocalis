"""Tests for packaging/satellite/satellite_admin.py, the Docker satellite's provisioning tool.

The satellite package: one command per operating system (October 10, 2026), proof list. The tool's paths are image-only, so every test
points a Context at a temporary folder; nothing here needs a network, a GPU, a terminal or a sleep.
The real satellite/setup.py builds the certificates and the real fetch_models.py makes the plan.
"""

import contextlib
import email.message
import getpass
import hashlib
import http.client
import importlib.util
import io
import json
import logging
import os
import re
import socket
import sys
import urllib.error
import urllib.request
import urllib.response
import warnings
from pathlib import Path

import pytest
import yaml

PACKAGING = Path(__file__).resolve().parents[1]
REPO = PACKAGING.parent
SATELLITE_SOURCE = REPO / "source" / "vocalis" / "satellite"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses resolve string annotations through sys.modules
    spec.loader.exec_module(module)
    return module


admin = _load("satellite_admin", PACKAGING / "satellite" / "satellite_admin.py")
fm = _load("fetch_models", PACKAGING / "models" / "fetch_models.py")

SECRET = "0123456789abcdef" * 4          # 64 hexadecimal characters
OTHER_SECRET = "fedcba9876543210" * 4
MANIFEST = PACKAGING / "models" / "chatterbox" / "manifest.json"


class Run:
    """One invocation of the tool: its exit code and what it wrote, split by stream."""

    def __init__(self, code, out, err, records):
        self.code, self.err, self.records = code, err, records
        self.out = out
        self.lines = out.splitlines()

    def values(self, key):
        return [line.split("=", 1)[1] for line in self.lines if line.startswith(key + "=")]

    def everything(self):
        return self.out + self.err + "\n".join(self.records)


class Home:
    """A stand-in for the container: the three mounts, the provision file and a tool Context."""

    def __init__(self, tmp_path):
        self.root = tmp_path
        self.data = tmp_path / "data"
        self.secrets = tmp_path / "secrets"
        self.provision_dir = tmp_path / "provision"
        for folder in (self.data, self.secrets, self.provision_dir):
            folder.mkdir()
        self.config = self.data / "satellite.yaml"
        self.cert_dir = self.data / "certs"
        self.secret_file = self.secrets / "vocalis-satellite-master"
        self.provision_file = self.provision_dir / "secret"
        self.models = tmp_path / "models"
        self.models.mkdir()
        self.tty = False
        self.prompt = lambda: pytest.fail("the tool prompted but this test gave it no prompt")

    def context(self, **overrides):
        options = dict(
            config_file=self.config, secret_file=self.secret_file, cert_dir=self.cert_dir,
            provision_secret=self.provision_file, satellite_dir=SATELLITE_SOURCE,
            fetch_models=PACKAGING / "models" / "fetch_models.py", manifest=MANIFEST,
            models_root=str(self.models), environ={}, stdin_is_tty=lambda: self.tty,
            prompt_secret=lambda: self.prompt(), out=io.StringIO(), err=io.StringIO())
        options.update(overrides)
        return admin.Context(**options)

    def run(self, *argv, **overrides):
        ctx = self.context(**overrides)
        records = []

        class Collect(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        collector = Collect()
        admin.log.addHandler(collector)
        try:
            code = admin.main(list(argv), ctx)
        finally:
            admin.log.removeHandler(collector)
        return Run(code, ctx.out.getvalue(), ctx.err.getvalue(), records)

    def provision(self, *extra, secret=SECRET, write=True, name="sat-1"):
        if write and secret is not None:
            self.provision_file.write_text(secret + "\n", encoding="ascii")
        return self.run("provision", "--name", name, *extra)

    def stored_secret(self):
        return self.secret_file.read_text(encoding="ascii")

    def snapshot(self):
        files = [p for p in (self.data, self.secrets) for p in p.rglob("*") if p.is_file()]
        return {str(p.relative_to(self.root)): p.read_bytes() for p in files}


@pytest.fixture
def home(tmp_path):
    return Home(tmp_path)


@pytest.fixture(autouse=True)
def host_identity_is_never_consulted(monkeypatch):
    """The container's own name and addresses must never reach the certificate: any lookup fails."""
    def forbidden(*args, **kwargs):
        raise AssertionError("the tool asked the host for its name or addresses")
    for function in ("gethostname", "getfqdn", "getaddrinfo", "gethostbyname", "gethostbyname_ex"):
        monkeypatch.setattr(socket, function, forbidden)


def san(cert_dir):
    from cryptography import x509
    cert = x509.load_pem_x509_certificate((cert_dir / "cert.pem").read_bytes())
    names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return ([str(i) for i in names.get_values_for_type(x509.IPAddress)],
            list(names.get_values_for_type(x509.DNSName)))


# --- the secret ----------------------------------------------------------------------------

@pytest.fixture
def opened(monkeypatch):
    """Every os.open the tool makes, as (file name, mode argument): the created mode is checked
    on every platform this way, because Windows has no file modes to read back."""
    calls = []
    real = os.open

    def spy(path, flags, mode=0o777, *args, **kwargs):
        calls.append((Path(os.fspath(path)).name, mode))
        return real(path, flags, mode, *args, **kwargs)

    monkeypatch.setattr(os, "open", spy)
    return calls


def test_a_secret_file_is_stored_as_given_with_mode_0600_and_reported(home, opened):
    run = home.provision("--secret-from-file")
    assert run.code == 0, run.err
    assert home.stored_secret() == SECRET + "\n"
    assert run.values("secret") == ["written"]
    assert [mode for name, mode in opened if name == ".vocalis-satellite-master.new"] == [0o600], (
        "the secret file must be created with mode 0600 from the start")
    if os.name == "posix":
        assert (home.secret_file.stat().st_mode & 0o777) == 0o600


def test_an_upper_case_secret_is_accepted_and_stored_lower_case(home):
    assert home.provision("--secret-from-file", secret=SECRET.upper()).code == 0
    assert home.stored_secret() == SECRET + "\n"


def test_the_secret_length_agrees_with_the_protocols(home):
    proto_source = (SATELLITE_SOURCE / "vocalis_satellite_protocol.py").read_text(encoding="utf-8")
    assert re.search(r"^MASTER_BYTES\s*=\s*32\b", proto_source, re.MULTILINE)
    assert admin.SECRET_HEX_CHARS == 32 * 2


@pytest.mark.parametrize("bad", [
    "", "   \n", "ab" * 31, "ab" * 33, "xy" * 32, "ab" * 31 + "a ", "ab cd" + "ab" * 29 + "a",
    SECRET + "\n" + SECRET])
def test_a_malformed_secret_is_refused_and_nothing_is_written(home, bad):
    run = home.provision("--secret-from-file", secret=bad)
    assert run.code == 4, run.err
    assert not home.secret_file.exists() and not home.config.exists() and not home.cert_dir.exists()
    assert run.out == ""
    if bad.strip():
        assert bad.strip() not in run.err, "the refused value was quoted back"


def test_a_missing_secret_file_is_a_secret_problem(home):
    run = home.provision("--secret-from-file", write=False)
    assert run.code == 4
    assert "cannot read the secret file" in run.err


@pytest.mark.parametrize("label, payload", [
    ("UTF-16 with a byte order mark (PowerShell Out-File)", (SECRET + "\r\n").encode("utf-16")),
    ("UTF-16 without a mark", (SECRET + "\n").encode("utf-16-le")),
    ("UTF-8 with a byte order mark", b"\xef\xbb\xbf" + SECRET.encode("ascii") + b"\n"),
    ("a stray accented character", SECRET.encode("ascii") + "\xe9".encode("latin-1")),
])
def test_a_secret_file_that_is_not_plain_ascii_gets_a_message_saying_so(home, label, payload):
    home.provision_file.write_bytes(payload)
    run = home.run("provision", "--name", "sat-1", "--secret-from-file")
    assert run.code == 4, label
    assert "not plain ASCII" in run.err, run.err
    assert not home.secret_file.exists()
    assert SECRET not in run.everything()


def test_an_oversized_secret_file_is_refused_without_reading_it_all(home):
    home.provision_file.write_bytes(b"a" * 100_000)
    run = home.run("provision", "--name", "sat-1", "--secret-from-file")
    assert run.code == 4 and "larger than" in run.err


def test_without_a_terminal_the_tool_refuses_and_never_prompts(home):
    home.tty = False
    home.prompt = lambda: pytest.fail("prompted without a terminal")
    run = home.run("provision", "--name", "sat-1")
    assert run.code == 4
    assert "no terminal" in run.err
    assert not home.secret_file.exists() and not home.config.exists() and not home.cert_dir.exists()


def test_with_a_terminal_the_secret_comes_from_the_hidden_prompt(home):
    home.tty = True
    home.prompt = lambda: SECRET + "\n"
    run = home.run("provision", "--name", "sat-1")
    assert run.code == 0, run.err
    assert home.stored_secret() == SECRET + "\n"
    assert SECRET not in run.everything()


@pytest.mark.parametrize("typed", ["", "   "])
def test_empty_input_is_an_error(home, typed):
    home.tty = True
    home.prompt = lambda: typed
    run = home.run("provision", "--name", "sat-1")
    assert run.code == 4 and "empty" in run.err
    assert not home.secret_file.exists()


def test_the_prompt_never_falls_back_to_echoed_input(monkeypatch):
    """getpass reads echoed input when it cannot hide it, announcing only a warning. That fallback
    must never run: the warning is made an error before the fallback reads anything."""
    read = []

    def fallback_getpass(prompt="", stream=None):
        warnings.warn("Can not control echo on the terminal.", getpass.GetPassWarning)
        read.append("echoed read")
        return SECRET

    monkeypatch.setattr(admin.getpass, "getpass", fallback_getpass)
    with pytest.raises(admin.SecretError, match="cannot hide"):
        admin._default_prompt()
    assert read == [], "the echoed fallback ran"

    monkeypatch.setattr(admin.getpass, "getpass", lambda prompt="", stream=None: SECRET)
    assert admin._default_prompt() == SECRET


def test_a_terminal_that_cannot_hide_input_ends_the_run_with_nothing_stored(home, monkeypatch):
    def fallback_getpass(prompt="", stream=None):
        warnings.warn("Can not control echo on the terminal.", getpass.GetPassWarning)
        return SECRET

    monkeypatch.setattr(admin.getpass, "getpass", fallback_getpass)
    home.tty = True
    ctx = home.context(prompt_secret=admin._default_prompt)
    code = admin.main(["provision", "--name", "sat-1"], ctx)
    assert code == 4
    assert not home.secret_file.exists()
    assert SECRET not in ctx.out.getvalue() + ctx.err.getvalue()


def test_end_of_input_at_the_prompt_is_a_secret_problem(monkeypatch):
    def at_eof(prompt="", stream=None):
        raise EOFError

    monkeypatch.setattr(admin.getpass, "getpass", at_eof)
    with pytest.raises(admin.SecretError):
        admin._default_prompt()


def test_the_secret_is_never_in_arguments_environment_output_or_logs(home, monkeypatch, capsys):
    argv = ["provision", "--name", "sat-1", "--ip", "192.0.2.10", "--dns", "sat.lan",
            "--secret-from-file"]
    home.provision_file.write_text(SECRET + "\n", encoding="ascii")
    # What the tool itself did with the secret, not what the test passed it: the arguments it parsed
    # (the parser has no field that could hold it), every process it started, and the environment
    # it left behind.
    parsed, spawned = [], []
    real_provision = admin._COMMANDS["provision"]

    def recording(ctx, args):
        parsed.append(repr(vars(args)))
        return real_provision(ctx, args)

    monkeypatch.setitem(admin._COMMANDS, "provision", recording)
    import subprocess
    real_popen = subprocess.Popen
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: spawned.append((a, k)) or real_popen(*a, **k))
    env_before, argv_before = dict(os.environ), list(sys.argv)
    run = home.run(*argv)
    assert run.code == 0
    assert parsed and SECRET not in parsed[0], "the parsed arguments carry the secret"
    assert "'secret_from_file': True" in parsed[0], "the recorded arguments are the ones just parsed"
    assert spawned == [], "the tool started a process"
    assert dict(os.environ) == env_before, "the tool changed the environment"
    assert sys.argv == argv_before
    assert not any(SECRET in value for value in os.environ.values())
    assert SECRET not in run.out and SECRET not in run.err
    assert all(SECRET not in record for record in run.records)
    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err
    # ... and the only copy on disk outside the user's own file is the mode-0600 secret file.
    holders = [key for key, content in home.snapshot().items() if SECRET.encode() in content]
    assert holders == [str(home.secret_file.relative_to(home.root))]


def test_even_an_exception_that_quotes_the_secret_does_not_reach_any_stream(home, monkeypatch):
    def explode(path, data, mode):
        raise RuntimeError(f"disk full while writing {SECRET}")

    monkeypatch.setattr(admin, "atomic_write", explode)
    run = home.provision("--secret-from-file")
    assert run.code == 5
    assert "unexpected RuntimeError" in run.err
    assert SECRET not in run.everything()


def test_the_log_filter_masks_a_registered_secret(home):
    admin._SECRETS.add(SECRET)
    try:
        formatted = admin._RedactingFormatter("%(message)s").format(
            logging.LogRecord("x", logging.INFO, __file__, 1, f"oops {SECRET}", None, None))
    finally:
        admin._SECRETS.clear()
    assert SECRET not in formatted and "***" in formatted


def test_a_stored_secret_that_is_unusable_is_reported_with_the_way_out(home):
    home.secret_file.write_text("garbage\n", encoding="ascii")
    run = home.provision("--secret-from-file")
    assert run.code == 4 and "--new-secret" in run.err
    assert home.secret_file.read_text(encoding="ascii") == "garbage\n"
    run = home.provision("--secret-from-file", "--new-secret")
    assert run.code == 0 and home.stored_secret() == SECRET + "\n"


# --- the configuration file -----------------------------------------------------------------

def test_satellite_yaml_has_exactly_the_three_lines(home):
    assert home.provision("--secret-from-file", name="vocalis-satellite-workstation").code == 0
    assert home.config.read_text(encoding="utf-8") == (
        "name: vocalis-satellite-workstation\nhost: 0.0.0.0\nport: 7880\n")
    assert yaml.safe_load(home.config.read_text(encoding="utf-8")) == {
        "name": "vocalis-satellite-workstation", "host": "0.0.0.0", "port": 7880}


def test_a_name_that_looks_like_another_yaml_type_stays_a_string(home):
    assert home.provision("--secret-from-file", name="1234").code == 0
    assert yaml.safe_load(home.config.read_text(encoding="utf-8"))["name"] == "1234"


def test_the_configuration_is_rewritten_when_the_name_changes(home):
    assert home.provision("--secret-from-file", name="first").code == 0
    assert home.provision("--secret-from-file", name="second").code == 0
    assert yaml.safe_load(home.config.read_text(encoding="utf-8"))["name"] == "second"
    assert sorted(p.name for p in home.data.iterdir()) == ["certs", "satellite.yaml"]


@pytest.mark.parametrize("name", ["", "   ", "x" * 65, "line\nbreak"])
def test_a_bad_name_is_a_usage_error(home, name):
    run = home.provision("--secret-from-file", name=name)
    assert run.code == 2 and not home.config.exists()


def test_the_listener_is_the_satellites_own_default_port():
    server_source = (SATELLITE_SOURCE / "server.py").read_text(encoding="utf-8")
    assert 'cfg.get("port", 7880)' in server_source and admin.LISTEN_PORT == 7880


# --- the certificate ------------------------------------------------------------------------

def test_the_certificate_covers_exactly_the_given_addresses_plus_loopback(home):
    run = home.provision("--secret-from-file", "--ip", "192.0.2.10", "--ip", "198.51.100.7",
                         "--dns", "Satellite.Lan", "--dns", "box.example.test")
    assert run.code == 0, run.err
    ips, names = san(home.cert_dir)
    assert ips == ["127.0.0.1", "192.0.2.10", "198.51.100.7"]
    assert names == ["box.example.test", "localhost", "satellite.lan"]
    assert run.values("ip") == ips and run.values("dns") == names


def test_with_no_addresses_given_only_loopback_and_localhost_are_certified(home):
    run = home.provision("--secret-from-file")
    assert run.code == 0
    assert san(home.cert_dir) == (["127.0.0.1"], ["localhost"])


def test_repeated_and_loopback_addresses_are_not_duplicated(home):
    run = home.provision("--secret-from-file", "--ip", "192.0.2.10", "--ip", "192.0.2.10",
                         "--ip", "127.0.0.1", "--dns", "localhost")
    assert run.code == 0
    assert san(home.cert_dir) == (["127.0.0.1", "192.0.2.10"], ["localhost"])


@pytest.mark.parametrize("option, value", [
    ("--ip", "not-an-address"), ("--ip", "192.0.2.300"), ("--ip", ""),
    ("--dns", "bad name"), ("--dns", "-dash.example"), ("--dns", ""), ("--dns", "192.0.2.10"),
    ("--dns", "a" * 64 + ".example")])
def test_a_bad_address_is_a_usage_error_and_changes_nothing(home, option, value):
    run = home.provision("--secret-from-file", option, value)
    assert run.code == 2, run.err
    assert not home.secret_file.exists() and not home.cert_dir.exists()


def test_fingerprint_matches_the_certificate_file(home):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    run = home.provision("--secret-from-file", "--ip", "192.0.2.10")
    cert = x509.load_pem_x509_certificate((home.cert_dir / "cert.pem").read_bytes())
    digest = cert.fingerprint(hashes.SHA256()).hex().upper()
    assert run.values("fingerprint") == [":".join(digest[i:i + 2] for i in range(0, 64, 2))]
    assert re.fullmatch(r"([0-9A-F]{2}:){31}[0-9A-F]{2}", run.values("fingerprint")[0])


def test_the_standard_output_is_only_key_value_lines_in_the_designed_order(home):
    run = home.provision("--secret-from-file", "--ip", "192.0.2.10", "--dns", "sat.lan")
    keys = [line.split("=", 1)[0] for line in run.lines]
    assert keys == ["secret", "certificate", "fingerprint", "ip", "ip", "dns", "dns"]
    assert all(re.fullmatch(r"[a-z]+=\S+", line) for line in run.lines), run.lines
    assert run.values("certificate") == ["created"]


def test_the_private_key_is_mode_0600_and_the_pair_has_no_temporaries(home, opened):
    assert home.provision("--secret-from-file").code == 0
    assert sorted(p.name for p in home.cert_dir.iterdir()) == ["cert.pem", "key.pem"]
    assert sorted(p.name for p in home.secrets.iterdir()) == ["vocalis-satellite-master"]
    assert [mode for name, mode in opened if name == "key.pem.new"] == [0o600], (
        "the private key must be created with mode 0600 from the start")
    if os.name == "posix":
        assert (home.cert_dir / "key.pem").stat().st_mode & 0o777 == 0o600


# --- keep or replace --------------------------------------------------------------------------

def test_a_second_run_keeps_the_secret_the_certificate_and_every_byte(home):
    first = home.provision("--secret-from-file", "--ip", "192.0.2.10")
    before = home.snapshot()
    home.provision_file.write_text(OTHER_SECRET + "\n", encoding="ascii")
    second = home.run("provision", "--name", "sat-1", "--ip", "192.0.2.10", "--secret-from-file")
    assert second.code == 0, second.err
    assert second.values("secret") == ["kept"] and second.values("certificate") == ["kept"]
    assert second.values("fingerprint") == first.values("fingerprint")
    assert second.values("ip") == first.values("ip") and second.values("dns") == first.values("dns")
    after = {k: v for k, v in home.snapshot().items() if not k.startswith("provision")}
    assert after == {k: v for k, v in before.items() if not k.startswith("provision")}
    assert home.stored_secret() == SECRET + "\n", "the kept secret was overwritten by the file"


def test_a_kept_run_does_not_need_a_terminal_or_a_file(home):
    assert home.provision("--secret-from-file").code == 0
    home.provision_file.unlink()
    run = home.run("provision", "--name", "sat-1")
    assert run.code == 0 and run.values("secret") == ["kept"]


def test_new_secret_replaces_only_the_secret(home):
    first = home.provision("--secret-from-file")
    run = home.provision("--secret-from-file", "--new-secret", secret=OTHER_SECRET)
    assert run.code == 0
    assert run.values("secret") == ["written"] and run.values("certificate") == ["kept"]
    assert run.values("fingerprint") == first.values("fingerprint")
    assert home.stored_secret() == OTHER_SECRET + "\n"
    assert OTHER_SECRET not in run.everything()


def test_new_certificate_replaces_only_the_certificate(home):
    first = home.provision("--secret-from-file", "--ip", "192.0.2.10")
    run = home.provision("--secret-from-file", "--new-certificate", "--ip", "192.0.2.99",
                         secret=OTHER_SECRET)
    assert run.code == 0, run.err
    assert run.values("secret") == ["kept"] and run.values("certificate") == ["created"]
    assert run.values("fingerprint") != first.values("fingerprint")
    assert san(home.cert_dir)[0] == ["127.0.0.1", "192.0.2.99"]
    assert home.stored_secret() == SECRET + "\n"
    assert sorted(p.name for p in home.cert_dir.iterdir()) == ["cert.pem", "key.pem"]


def test_a_kept_certificate_that_misses_a_given_address_is_kept_and_the_gap_is_reported(home):
    home.provision("--secret-from-file", "--ip", "192.0.2.10")
    run = home.provision("--secret-from-file", "--ip", "192.0.2.77")
    assert run.code == 0 and run.values("certificate") == ["kept"]
    assert "192.0.2.77" in run.err and "--new-certificate" in run.err
    assert "192.0.2.77" not in run.values("ip")


@pytest.mark.parametrize("missing", ["cert.pem", "key.pem"])
def test_half_a_pair_is_never_replaced_silently(home, missing):
    assert home.provision("--secret-from-file").code == 0
    (home.cert_dir / missing).unlink()
    kept = {p.name: p.read_bytes() for p in home.cert_dir.iterdir()}
    run = home.provision("--secret-from-file")
    assert run.code == 5 and "--new-certificate" in run.err
    assert {p.name: p.read_bytes() for p in home.cert_dir.iterdir()} == kept
    fixed = home.provision("--secret-from-file", "--new-certificate")
    assert fixed.code == 0 and fixed.values("certificate") == ["created"]


def test_an_unreadable_kept_certificate_is_a_configuration_problem(home):
    assert home.provision("--secret-from-file").code == 0
    (home.cert_dir / "cert.pem").write_text("not a certificate", encoding="ascii")
    run = home.provision("--secret-from-file")
    assert run.code == 5 and "--new-certificate" in run.err


def test_the_tool_never_asks_a_question(home, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the tool asked a question")

    monkeypatch.setattr("builtins.input", refuse)
    for extra in ((), ("--new-secret",), ("--new-certificate",), ("--new-secret", "--new-certificate")):
        assert home.provision("--secret-from-file", *extra).code == 0


def test_the_standard_streams_are_left_as_found(home, capsys):
    before = {name: getattr(getattr(sys, name), "errors", None) for name in ("stdout", "stderr")}
    admin._SETUP_MODULES.clear()
    assert home.provision("--secret-from-file").code == 0
    after = {name: getattr(getattr(sys, name), "errors", None) for name in ("stdout", "stderr")}
    assert after == before


# --- exit codes and usage ---------------------------------------------------------------------

@pytest.mark.parametrize("argv", [
    [], ["unknown"], ["provision"], ["provision", "--name"], ["provision", "--name", "x", "--bogus"],
    ["show", "extra"], ["check-gpu", "--ip", "1.2.3.4"]])
def test_usage_errors_exit_2(home, argv):
    run = home.run(*argv)
    assert run.code == 2 and run.out == ""


def test_the_environment_must_name_the_mounted_files(home):
    home.provision_file.write_text(SECRET, encoding="ascii")
    run = home.run("provision", "--name", "x", "--secret-from-file", config_file=None)
    assert run.code == 5 and "VOCALIS_SATELLITE_CONFIG" in run.err
    run = home.run("show", cert_dir=None)
    assert run.code == 5 and "VOCALIS_SATELLITE_CERT_DIR" in run.err


def test_the_context_is_built_from_the_images_environment_variables():
    ctx = admin.context_from_environ({
        "VOCALIS_SATELLITE_CONFIG": "/data/vocalis-satellite/satellite.yaml",
        "VOCALIS_SATELLITE_CERT_DIR": "/data/vocalis-satellite/certs",
        "VOCALIS_SATELLITE_SECRET_FILE": "/run/secrets/vocalis-satellite-master"})
    assert ctx.config_file == Path("/data/vocalis-satellite/satellite.yaml")
    assert ctx.cert_dir == Path("/data/vocalis-satellite/certs")
    assert ctx.secret_file == Path("/run/secrets/vocalis-satellite-master")
    assert ctx.provision_secret == Path("/run/provision/secret")
    assert ctx.models_root == "/models/vocalis"
    assert str(ctx.fetch_models).replace("\\", "/") == "/usr/share/vocalis-g1/models/fetch_models.py"
    assert admin.context_from_environ({}).config_file is None


def test_the_images_environment_names_the_paths_the_tool_reads():
    """The tool takes its three paths from the variables the Dockerfile sets, so the two agree."""
    dockerfile = (PACKAGING / "satellite" / "Dockerfile").read_text(encoding="utf-8")
    env = dict(re.findall(r"^\s+(VOCALIS_[A-Z_]+)=(\S+?)(?: \\)?$", dockerfile, re.MULTILINE))
    assert env["VOCALIS_SATELLITE_CONFIG"] == "/data/vocalis-satellite/satellite.yaml"
    assert env["VOCALIS_SATELLITE_CERT_DIR"] == "/data/vocalis-satellite/certs"
    assert env["VOCALIS_SATELLITE_SECRET_FILE"] == "/run/secrets/vocalis-satellite-master"


# --- show --------------------------------------------------------------------------------------

def test_show_with_no_certificate_exits_5(home):
    run = home.run("show")
    assert run.code == 5 and run.out == ""


def test_show_prints_what_provision_printed_and_writes_nothing(home):
    made = home.provision("--secret-from-file", "--ip", "192.0.2.10", "--dns", "sat.lan")
    before = home.snapshot()
    run = home.run("show")
    assert run.code == 0
    assert run.lines == [line for line in made.lines if not line.startswith(("secret=", "certificate="))]
    assert home.snapshot() == before


def test_show_of_an_unreadable_certificate_exits_5(home):
    home.cert_dir.mkdir()
    (home.cert_dir / "cert.pem").write_text("junk", encoding="ascii")
    assert home.run("show").code == 5


# --- check-gpu ---------------------------------------------------------------------------------

class FakeTorch:
    class cuda:
        cards = ["NVIDIA GeForce RTX 4090", "AMD Radeon\tAI PRO\nR9700"]

        @classmethod
        def is_available(cls):
            return bool(cls.cards)

        @classmethod
        def device_count(cls):
            return len(cls.cards)

        @classmethod
        def get_device_name(cls, index):
            return cls.cards[index]


def test_check_gpu_prints_one_line_per_card_after_hiding_integrated_graphics(home):
    order = []
    run = home.run(
        "check-gpu",
        hide_gpus=lambda: order.append("hide") or {"action": "hid-integrated", "visible": "0,1"},
        load_torch=lambda: order.append("torch") or FakeTorch)
    assert order == ["hide", "torch"], "torch must be imported only after the hiding"
    assert run.code == 0, run.err
    assert run.lines == ["card=0\tNVIDIA GeForce RTX 4090", "card=1\tAMD Radeon AI PRO R9700"]
    assert any("hid-integrated" in line for line in run.records)


def test_check_gpu_with_no_card_exits_3_and_prints_no_card_line(home):
    class NoCards(FakeTorch):
        class cuda(FakeTorch.cuda):
            cards = []

    run = home.run("check-gpu", hide_gpus=lambda: {"action": "none"}, load_torch=lambda: NoCards)
    assert run.code == 3 and run.out == "" and "cannot use any GPU" in run.err


def test_check_gpu_when_torch_cannot_be_imported_exits_3(home):
    def broken():
        raise ImportError("no torch")

    run = home.run("check-gpu", hide_gpus=lambda: {"action": "none"}, load_torch=broken)
    assert run.code == 3 and "ImportError" in run.err


def test_the_default_hiding_is_the_satellites_own_helper(monkeypatch):
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(os.path, "exists", lambda p: False if p == "/dev/kfd" else os.path.lexists(p))
    sys.modules.pop("vocalis_torch_backend", None)
    decision = admin._default_hide(admin.Context(satellite_dir=SATELLITE_SOURCE))
    assert decision == {"action": "none", "reason": "no ROCm kernel driver"}
    import vocalis_torch_backend
    assert Path(vocalis_torch_backend.__file__).resolve() == (
        SATELLITE_SOURCE / "vocalis_torch_backend.py").resolve()


# --- fetch-model -------------------------------------------------------------------------------

@pytest.fixture
def fetcher():
    """A fetch_models module the test controls; the lock needs fcntl, which only Linux has."""
    module = _load("fetch_models_for_admin_tests", PACKAGING / "models" / "fetch_models.py")
    inner = module.exclusive_lock
    if os.name != "posix":
        @contextlib.contextmanager
        def inner(path):
            yield

    # Whichever lock is underneath, record taking and releasing it so a test can fail when the
    # tool never takes the lock, or does its work outside it.
    module.lock_events = []

    @contextlib.contextmanager
    def recording(path):
        module.lock_events.append(("take", Path(path).name))
        with inner(path):
            try:
                yield
            finally:
                module.lock_events.append(("release", Path(path).name))

    module.exclusive_lock = recording
    return module


def _dockerfile_env(path):
    text = path.read_text(encoding="utf-8")
    # LEADVOCAL_MODELS (October 11, 2026): the main image's fetcher plan also reads the Lead Vocal folder.
    return dict(re.findall(r"^\s+((?:VOCALIS|LEADVOCAL)_[A-Z_]+)=(\S+?)(?: \\)?$", text, re.MULTILINE))


def test_the_plan_is_the_chatterbox_files_of_the_main_packages_own_plan(tmp_path, fetcher):
    root = tmp_path / "models"
    root.mkdir()
    env = {name: value.replace("/models/vocalis", str(root), 1)
           for name, value in _dockerfile_env(PACKAGING / "main-cuda" / "Dockerfile.app").items()}
    full = fetcher.build_plan(env, PACKAGING / "models", MANIFEST, str(root))
    plan = admin.chatterbox_plan(fetcher, env, MANIFEST, str(root))
    assert {item.model for item in plan} == {"chatterbox"}
    assert len(plan) == 5 and len(full) > len(plan)
    assert plan == [item for item in full if item.model == "chatterbox"]
    assert sum(item.size for item in plan) == 3_191_966_992        # the manifest's five files, about 3.2 GB
    # The satellite image's own environment names the same directory the main image does.
    satellite_env = _dockerfile_env(PACKAGING / "satellite" / "Dockerfile")
    assert satellite_env["VOCALIS_CHATTERBOX_MODEL_DIR"] == _dockerfile_env(
        PACKAGING / "main-cuda" / "Dockerfile.app")["VOCALIS_CHATTERBOX_MODEL_DIR"]


def test_the_plan_applies_the_fetchers_refusals(tmp_path, fetcher):
    root = tmp_path / "models"
    root.mkdir()
    wrong_revision = {"VOCALIS_CHATTERBOX_MODEL_DIR": str(root / "chatterbox" / "not-the-revision")}
    with pytest.raises(fetcher.Refusal, match="lock"):
        admin.chatterbox_plan(fetcher, wrong_revision, MANIFEST, str(root))
    with pytest.raises(fetcher.Refusal, match="is not set"):
        admin.chatterbox_plan(fetcher, {}, MANIFEST, str(root))
    outside = {"VOCALIS_CHATTERBOX_MODEL_DIR": str(tmp_path / "elsewhere" / "rev")}
    with pytest.raises(fetcher.Refusal, match="not a directory under"):
        admin.chatterbox_plan(fetcher, outside, MANIFEST, str(root))


def sha256(body):
    return hashlib.sha256(body).hexdigest()


class FakeHttps(urllib.request.HTTPSHandler):
    def __init__(self, routes, events=None):
        super().__init__()
        self.routes, self.requested, self.events = routes, [], events

    def https_open(self, request):
        url = request.full_url
        self.requested.append(url)
        if self.events is not None:
            self.events.append(("request", url))
        if url not in self.routes:
            raise urllib.error.URLError(f"no route for {url}")
        message = email.message.Message()
        response = urllib.response.addinfourl(io.BytesIO(self.routes[url]), message, url, 200)
        response.msg = http.client.responses[200]
        return response


@pytest.fixture
def tiny_model(tmp_path, home):
    """A two-file Chatterbox manifest, its server, and the environment that names its folder."""
    bodies = {"ve.safetensors": b"voice encoder " * 5, "conds.pt": b"conditionals " * 7}
    routes = {f"https://hf.example/{name}": body for name, body in bodies.items()}
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"revision": "cbrev", "files": [
        {"path": name, "bytes": len(body), "sha256": sha256(body), "url": f"https://hf.example/{name}"}
        for name, body in bodies.items()]}), encoding="utf-8")
    environ = {"VOCALIS_CHATTERBOX_MODEL_DIR": str(home.models / "chatterbox" / "cbrev")}
    return bodies, routes, manifest, environ


def test_fetch_model_downloads_verifies_and_is_idempotent(home, fetcher, tiny_model):
    bodies, routes, manifest, environ = tiny_model
    handler = FakeHttps(routes, fetcher.lock_events)
    options = dict(manifest=manifest, environ=environ, load_fetcher=lambda path: fetcher,
                   opener=fetcher.make_opener(handler), sleep=lambda s: None,
                   disk_free=lambda path: 10 ** 12)
    run = home.run("fetch-model", **options)
    assert run.code == 0, run.err
    # The fetcher's lock is taken first, every download happens while it is held, and it is
    # released last: the tool relies on it to keep two setup runs from colliding.
    lock = fetcher.LOCK_NAME
    assert fetcher.lock_events == [("take", lock)] + [("request", url) for url in handler.requested] + [
        ("release", lock)], fetcher.lock_events
    assert len(handler.requested) == 2
    target = home.models / "chatterbox" / "cbrev"
    for name, body in bodies.items():
        assert (target / name).read_bytes() == body
    assert sorted(handler.requested) == sorted(routes)
    assert not [p for p in home.models.rglob("*") if p.name.startswith(fetcher.TEMP_PREFIX)]
    assert any("fetch-model: 2 files" in line for line in run.records)

    again = FakeHttps(routes)
    options["opener"] = fetcher.make_opener(again)
    assert home.run("fetch-model", **options).code == 0
    assert again.requested == [], "a verified file was downloaded again"


def test_fetch_model_never_overwrites_a_file_that_differs_and_exits_1(home, fetcher, tiny_model, capsys):
    bodies, routes, manifest, environ = tiny_model
    target = home.models / "chatterbox" / "cbrev"
    target.mkdir(parents=True)
    (target / "ve.safetensors").write_bytes(b"someone's own file of the wrong size")
    run = home.run("fetch-model", manifest=manifest, environ=environ,
                   load_fetcher=lambda path: fetcher, opener=fetcher.make_opener(FakeHttps(routes)),
                   sleep=lambda s: None, disk_free=lambda path: 10 ** 12)
    assert run.code == 1
    assert (target / "ve.safetensors").read_bytes() == b"someone's own file of the wrong size"
    assert "MISMATCH" in capsys.readouterr().out


def test_fetch_model_exits_1_when_the_download_fails(home, fetcher, tiny_model, capsys):
    _bodies, _routes, manifest, environ = tiny_model
    run = home.run("fetch-model", manifest=manifest, environ=environ,
                   load_fetcher=lambda path: fetcher, opener=fetcher.make_opener(FakeHttps({})),
                   sleep=lambda s: None, disk_free=lambda path: 10 ** 12)
    assert run.code == 1 and "FAILED" in capsys.readouterr().out


def test_fetch_model_refuses_when_the_models_mount_is_missing(home, fetcher, tiny_model):
    """The destination is well formed (inside the models root) but the root itself is not there:
    the refusal must be the mount one, reached after the plan is built and before any lock."""
    _bodies, _routes, manifest, _environ = tiny_model
    absent = home.root / "absent"
    run = home.run("fetch-model", manifest=manifest, models_root=str(absent), load_fetcher=lambda path: fetcher,
                   environ={"VOCALIS_CHATTERBOX_MODEL_DIR": str(absent / "chatterbox" / "cbrev")})
    assert run.code == 1
    assert "the models mount is missing" in run.err, run.err
    assert fetcher.lock_events == [], "a lock was taken on a folder that is not there"
    assert not absent.exists()


def test_fetch_model_refuses_a_destination_whose_revision_is_not_the_manifests(home, fetcher, tiny_model):
    _bodies, _routes, manifest, _environ = tiny_model
    run = home.run("fetch-model", manifest=manifest, load_fetcher=lambda path: fetcher,
                   environ={"VOCALIS_CHATTERBOX_MODEL_DIR": str(home.models / "chatterbox" / "other")})
    assert run.code == 1
    assert "names revision 'other' but its lock is for 'cbrev'" in run.err, run.err
    assert fetcher.lock_events == [] and not (home.models / "chatterbox").exists()


def test_fetch_model_exits_1_when_the_fetcher_cannot_be_loaded(home):
    run = home.run("fetch-model", fetch_models=home.root / "no-such-fetcher.py")
    assert run.code == 1 and "cannot load the model fetcher" in run.err


def test_the_default_loader_leaves_sys_modules_as_it_found_it():
    before = sys.modules.get("fetch_models")
    module = admin._load_module("fetch_models", PACKAGING / "models" / "fetch_models.py")
    assert hasattr(module, "build_plan") and sys.modules.get("fetch_models") is before


def test_the_tool_uses_the_fetchers_functions_and_does_not_copy_them():
    source = (PACKAGING / "satellite" / "satellite_admin.py").read_text(encoding="utf-8")
    for needed in ("fm.make_item", "fm.env_directory", "fm.require_revision", "fm.read_json",
                   "fm.check_no_symlinks", "fm.exclusive_lock", "fm.fetch("):
        assert needed in source, needed
    for copied in ("def hash_file", "def download", "def classify", "hashlib", "urllib.request"):
        assert copied not in source, f"the tool carries its own copy of {copied}"


# --- the fetcher is the main package's, unchanged ------------------------------------------------

# SHA-256 of packaging/models/fetch_models.py with line endings normalized to LF (a Windows checkout
# may hold CRLF). It is a recorded input of the main images and the satellite image copies it
# as it is (design section 9, item 7). If it is changed on purpose, the main images' record and
# this value change together.
# October 11, 2026: changed on purpose (it now also plans the HTDemucs and Lead Vocal locks from the main image's
# environment). The satellite uses only make_item/env_directory/fetch and its own Chatterbox plan, so its behavior
# is unchanged; its image carries this file as it is whenever that image is next rebuilt.
# Previous value: aaf9c78159277e9de03e7f79aa1ef9f49db5a5fb5dcc6bb60e60afda543f1583.
FETCH_MODELS_SHA256 = "d14d334ced00958fa0a2d8526ec77f12f3415f7b061bafbab22abc7a161d03ef"


def test_fetch_models_is_byte_identical_to_the_main_packages():
    content = (PACKAGING / "models" / "fetch_models.py").read_bytes().replace(b"\r\n", b"\n")
    assert sha256(content) == FETCH_MODELS_SHA256, (
        "packaging/models/fetch_models.py changed; the satellite package promises it does not")
