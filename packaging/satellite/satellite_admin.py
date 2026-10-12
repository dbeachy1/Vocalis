#!/usr/bin/env python3
"""Provision a Docker satellite: GPU check, secret, configuration, certificate, model download.

Installed in the satellite image at /opt/vocalis/satellite-admin/satellite_admin.py and run in
one-shot containers by the two host scripts (satellite-setup.sh, satellite-setup.ps1):

    python /opt/vocalis/satellite-admin/satellite_admin.py <subcommand>

Added October 10, 2026 (the satellite package: one command per operating system). The host scripts stay thin and everything with rules in it
lives here, once, so Linux and Windows cannot drift apart. They parse this tool's standard output,
so its shape is a contract:

* for check-gpu, provision and show, standard output carries only `key=value` lines (a card line
  is `card=<index>` TAB `<name>`). fetch-model is the exception: its standard output is the
  fetcher's own progress text, and only its exit code is a contract;
* every other human message goes to standard error;
* exit codes: 0 ok, 1 failed (fetch-model), 2 usage, 3 no usable GPU (check-gpu),
  4 secret problem, 5 configuration or certificate problem.

Subcommands: check-gpu, provision, fetch-model, show.

Certificate addresses: the certificate covers exactly the --ip and --dns values given, and always
also `localhost` and 127.0.0.1, which are added to them. Nothing is taken from the container (its
own host name and addresses are never consulted).

The shared secret never appears in an argument, the environment, standard output, standard error,
a log record or an exception message: it is read from a file or typed without echo, and the only
place it is written is the secret file (mode 0600).
"""
from __future__ import annotations

import argparse
import contextlib
import getpass
import importlib.util
import ipaddress
import logging
import os
import re
import shutil
import sys
import time
import traceback
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, TextIO

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_NO_GPU = 3
EXIT_SECRET = 4
EXIT_CONFIG = 5

# The listener inside the container never changes; the user's port exists only on the host side
# of the published port (design, "Run specification").
LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 7880
SECRET_HEX_CHARS = 64            # proto.MASTER_BYTES * 2; checked against the protocol in the tests
SECRET_FILE_MAX_BYTES = 4096
NAME_MAX_CHARS = 64

log = logging.getLogger("satellite_admin")


class UsageError(Exception):
    """An argument the parser accepted but the tool refuses (exit 2)."""


class SecretError(Exception):
    """A secret that is missing, unreadable, malformed or cannot be stored (exit 4)."""


class ConfigError(Exception):
    """A configuration file, certificate or environment problem (exit 5)."""


# --- redaction ------------------------------------------------------------------------------

_SECRETS: set[str] = set()


def _redact(text: str) -> str:
    """Belt and braces: no code path puts the secret in a message, but a message is the last line
    of defense, so any registered secret is masked before a record leaves this process."""
    for value in _SECRETS:
        text = text.replace(value, "***")
    return text


class _RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return _redact(super().format(record))


def describe(exc: BaseException) -> str:
    """An exception for a message without its text, which could carry anything: the class name,
    and for a file error the system message and the path (a path never holds the secret)."""
    if isinstance(exc, OSError):
        return f"{type(exc).__name__}: {exc.strerror or 'error'} ({exc.filename})"
    return type(exc).__name__


# --- the injectable surroundings --------------------------------------------------------------

def _default_prompt() -> str:
    """Read the secret from the terminal without echo, or refuse.

    getpass quietly falls back to echoed input when it cannot switch echo off; the fallback only
    announces itself through a warning, so the warning is made an error and the fallback never
    reads (October 10, 2026: a secret must never be shown on screen or kept in scrollback).
    """
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass("Satellite secret (64 hexadecimal characters, not shown): ")
        except getpass.GetPassWarning as exc:
            raise SecretError("this terminal cannot hide what is typed, so the secret is not "
                              "read from it; use --secret-file instead") from exc
        except (EOFError, KeyboardInterrupt) as exc:
            raise SecretError("no secret was entered") from exc


def _stdin_is_tty() -> bool:
    try:
        return sys.stdin is not None and sys.stdin.isatty()
    except (ValueError, OSError):
        return False


def _load_module(name: str, path: Path):
    """Load a source file as a module under `name`, leaving no trace in sys.modules."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ConfigError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get(name)
    sys.modules[name] = module          # dataclasses resolve string annotations through it
    try:
        spec.loader.exec_module(module)
    finally:
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous
    return module


@dataclass
class Context:
    """Everything outside the process the commands touch, so tests can point it elsewhere."""
    config_file: Path | None = None
    secret_file: Path | None = None
    cert_dir: Path | None = None
    provision_secret: Path = Path("/run/provision/secret")
    satellite_dir: Path = Path("/opt/vocalis/satellite")
    fetch_models: Path = Path("/usr/share/vocalis-g1/models/fetch_models.py")
    manifest: Path = Path("/usr/share/vocalis-g1/chatterbox-model-manifest.json")
    models_root: str = "/models/vocalis"
    environ: Mapping[str, str] = field(default_factory=lambda: os.environ)
    stdin_is_tty: Callable[[], bool] = _stdin_is_tty
    prompt_secret: Callable[[], str] = _default_prompt
    hide_gpus: Callable[[], dict] | None = None        # default: the satellite's own helper
    load_torch: Callable[[], object] | None = None     # default: import torch
    load_fetcher: Callable[[Path], object] | None = None
    opener: object | None = None                       # fetch-model transport; default HTTPS
    sleep: Callable[[float], None] = time.sleep
    disk_free: Callable[[Path], int] = lambda path: shutil.disk_usage(path).free
    out: TextIO | None = None
    err: TextIO | None = None


def context_from_environ(environ: Mapping[str, str]) -> Context:
    """The image sets these three; a missing one is reported by the command that needs it."""
    def path(name: str) -> Path | None:
        value = environ.get(name, "").strip()
        return Path(value) if value else None
    return Context(config_file=path("VOCALIS_SATELLITE_CONFIG"),
                   secret_file=path("VOCALIS_SATELLITE_SECRET_FILE"),
                   cert_dir=path("VOCALIS_SATELLITE_CERT_DIR"),
                   environ=environ)


def _need(value: Path | None, variable: str) -> Path:
    if value is None:
        raise ConfigError(f"{variable} is not set; this tool runs inside the satellite image")
    if not value.is_absolute():
        raise ConfigError(f"{variable} must be an absolute path, got {value}")
    return value


def emit(ctx: Context, line: str) -> None:
    """One machine-readable line on standard output."""
    print(line, file=ctx.out or sys.stdout, flush=True)


# --- small file helpers --------------------------------------------------------------------

def atomic_write(path: Path, data: bytes, mode: int) -> None:
    """Write `data` to `path` by rename, created with `mode` from the start (never wider, even for
    an instant). The temporary sits beside the target so the rename stays on one mount."""
    temporary = path.with_name(f".{path.name}.new")
    with contextlib.suppress(FileNotFoundError):
        temporary.unlink()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        try:
            os.fchmod(fd, mode)             # the umask may have narrowed it
        except (AttributeError, OSError):
            pass                            # Windows has no modes
        with os.fdopen(fd, "wb") as stream:
            fd = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        if fd >= 0:
            os.close(fd)
        with contextlib.suppress(OSError):
            temporary.unlink()
        raise


# --- the secret ----------------------------------------------------------------------------

def validate_secret(text: str) -> str:
    """The secret as 64 lower-case hexadecimal characters, or a SecretError that does not quote it."""
    value = text.strip()
    if not value:
        raise SecretError("the secret is empty")
    if len(value) != SECRET_HEX_CHARS or not re.fullmatch(r"[0-9a-fA-F]+", value):
        raise SecretError(f"the secret must be exactly {SECRET_HEX_CHARS} hexadecimal characters "
                          f"(0-9 and a-f); what was given is {len(value)} characters long or "
                          "contains other characters. Copy the whole string Vocalis displayed")
    return value.lower()


def read_secret_file(path: Path) -> str:
    """The text of a secret file that holds plain ASCII only.

    A file written by PowerShell's Out-File is UTF-16 with a byte order mark; a text editor may add
    a UTF-8 mark. Either would otherwise show up as a baffling "not hexadecimal" error, so any byte
    outside printable ASCII and white space (a NUL included) gets its own message.
    """
    try:
        with open(path, "rb") as stream:
            raw = stream.read(SECRET_FILE_MAX_BYTES + 1)
    except OSError as exc:
        raise SecretError(f"cannot read the secret file ({describe(exc)})") from exc
    if len(raw) > SECRET_FILE_MAX_BYTES:
        raise SecretError(f"the secret file is larger than {SECRET_FILE_MAX_BYTES} bytes; "
                          "it must hold only the 64-character secret")
    if any(b == 0 or b >= 0x80 for b in raw):
        raise SecretError("the secret file is not plain ASCII text (it looks like UTF-16 or has a "
                          "byte order mark, which PowerShell's Out-File and some editors add). "
                          "Save it as plain ASCII or UTF-8 without a BOM, with only the secret in it")
    return raw.decode("ascii")


def obtain_secret(ctx: Context, args: argparse.Namespace) -> str:
    if args.secret_from_file:
        log.info("secret: reading it from the provision file %s", ctx.provision_secret)
        return validate_secret(read_secret_file(ctx.provision_secret))
    if not ctx.stdin_is_tty():
        raise SecretError("there is no terminal to type the secret on, and it is never read from "
                          "anything else; run with a terminal attached, or give the secret in a "
                          "file with --secret-from-file")
    return validate_secret(ctx.prompt_secret())


# --- certificate and configuration ---------------------------------------------------------

_HOST_LABEL = re.compile(r"(?!-)[A-Za-z0-9_-]{1,63}(?<!-)\Z")


def parse_ip(text: str) -> str:
    try:
        return str(ipaddress.ip_address(text.strip()))
    except ValueError:
        raise UsageError(f"--ip {text!r} is not an IP address") from None


def parse_dns(text: str) -> str:
    name = text.strip().rstrip(".").lower()
    labels = name.split(".")
    if (not name or len(name) > 253 or not all(_HOST_LABEL.match(label) for label in labels)):
        raise UsageError(f"--dns {text!r} is not a host name")
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return name
    raise UsageError(f"--dns {text!r} is an IP address; use --ip")


def parse_name(text: str) -> str:
    name = text.strip()
    if not name or len(name) > NAME_MAX_CHARS or not name.isprintable():
        raise UsageError(f"--name must be 1 to {NAME_MAX_CHARS} printable characters")
    return name


_SETUP_MODULES: dict[Path, object] = {}


def load_satellite_setup(ctx: Context):
    """The satellite's own setup.py, for its certificate functions (one construction, two callers)."""
    path = ctx.satellite_dir / "setup.py"
    if path in _SETUP_MODULES:
        return _SETUP_MODULES[path]
    if not path.is_file():
        raise ConfigError(f"the satellite setup module is missing: {path}")
    # setup.py puts its folder on sys.path and reconfigures the standard streams; both are
    # harmless in a one-shot container and undone here so a test process is left as found.
    path_before = list(sys.path)
    errors_before = {name: getattr(getattr(sys, name), "errors", None) for name in ("stdout", "stderr")}
    try:
        module = _load_module("vocalis_satellite_setup", path)
    finally:
        sys.path[:] = path_before
        for name, errors in errors_before.items():
            stream = getattr(sys, name)
            if errors is not None and getattr(stream, "errors", None) != errors:
                with contextlib.suppress(Exception):    # a capture object may not reconfigure
                    stream.reconfigure(errors=errors)
    _SETUP_MODULES[path] = module
    return module


def render_config(name: str) -> bytes:
    import yaml
    text = yaml.safe_dump({"name": name, "host": LISTEN_HOST, "port": LISTEN_PORT},
                          sort_keys=False, default_flow_style=False)
    return text.encode("utf-8")


def write_config(ctx: Context, name: str) -> str:
    config = _need(ctx.config_file, "VOCALIS_SATELLITE_CONFIG")
    wanted = render_config(name)
    try:
        if config.is_file() and config.read_bytes() == wanted:
            return "unchanged"
        atomic_write(config, wanted, 0o644)
    except OSError as exc:
        raise ConfigError(f"cannot write the configuration file {config} ({describe(exc)})") from exc
    return "written"


def certificate_state(cert_dir: Path) -> str:
    """'none', 'both' or the name of the one half that exists."""
    cert_p, key_p = cert_dir / "cert.pem", cert_dir / "key.pem"
    have_cert, have_key = os.path.lexists(cert_p), os.path.lexists(key_p)
    if have_cert and have_key:
        return "both"
    if have_cert:
        return "cert.pem"
    if have_key:
        return "key.pem"
    return "none"


def certificate_fields(ctx: Context, cert_dir: Path) -> tuple[str, list[str], list[str]]:
    """(fingerprint, IP addresses, DNS names) of the certificate in `cert_dir`."""
    setup = load_satellite_setup(ctx)
    cert_p = cert_dir / "cert.pem"
    try:
        fingerprint = setup.certificate_fingerprint(cert_p)
        ips, names = setup.certificate_addresses(cert_p)
    except Exception as exc:                                    # noqa: BLE001
        raise ConfigError(f"the certificate {cert_p} cannot be read ({describe(exc)}); "
                          "replace it with --new-certificate") from exc
    return fingerprint, ips, names


def emit_certificate(ctx: Context, cert_dir: Path) -> tuple[list[str], list[str]]:
    fingerprint, ips, names = certificate_fields(ctx, cert_dir)
    emit(ctx, f"fingerprint={fingerprint}")
    for address in ips:
        emit(ctx, f"ip={address}")
    for name in names:
        emit(ctx, f"dns={name}")
    return ips, names


# --- subcommands ---------------------------------------------------------------------------

def run_provision(ctx: Context, args: argparse.Namespace) -> int:
    started = time.monotonic()
    name = parse_name(args.name)
    ips = sorted({ipaddress.ip_address(parse_ip(a)) for a in args.ip} | {ipaddress.ip_address("127.0.0.1")},
                 key=lambda a: (a.version, a))
    dns = sorted({parse_dns(d) for d in args.dns} | {"localhost"})
    config = _need(ctx.config_file, "VOCALIS_SATELLITE_CONFIG")
    secret_file = _need(ctx.secret_file, "VOCALIS_SATELLITE_SECRET_FILE")
    cert_dir = _need(ctx.cert_dir, "VOCALIS_SATELLITE_CERT_DIR")
    log.info("provision: name=%r ips=%d dns=%d new_secret=%s new_certificate=%s secret_from_file=%s",
             name, len(ips) - 1, len(dns) - 1, args.new_secret, args.new_certificate,
             args.secret_from_file)

    # The state of all three products is read before anything is written, so a refusal leaves
    # the folder exactly as it was.
    secret_state = "missing"
    if os.path.lexists(secret_file):
        try:
            existing = validate_secret(read_secret_file(secret_file))
        except SecretError as exc:
            if not args.new_secret:
                raise SecretError(f"the stored secret is not usable ({exc}); replace it with "
                                  "--new-secret") from exc
            existing = None
        else:
            _SECRETS.add(existing)
        secret_state = "valid" if existing else "invalid"
    cert_state = certificate_state(cert_dir) if cert_dir.is_dir() else "none"
    if cert_state in ("cert.pem", "key.pem") and not args.new_certificate:
        other = "key.pem" if cert_state == "cert.pem" else "cert.pem"
        raise ConfigError(f"{cert_dir} holds {cert_state} but not {other}; a half pair is never "
                          "replaced silently. Use --new-certificate to make a new one "
                          "(Vocalis must then be given the new certificate file)")
    log.info("provision: stored secret is %s; certificate state is %s", secret_state, cert_state)

    keep_secret = secret_state == "valid" and not args.new_secret
    new_secret = None
    if not keep_secret:
        new_secret = obtain_secret(ctx, args)
        _SECRETS.add(new_secret)
    elif args.secret_from_file:
        log.info("secret: one is already stored, so the provision file is not read "
                 "(use --new-secret to replace it)")

    # --- from here on we write ---
    cert_dir_created = False
    try:
        if not cert_dir.is_dir():
            cert_dir.mkdir(parents=True, exist_ok=True)
            cert_dir_created = True
    except OSError as exc:
        raise ConfigError(f"cannot create the certificate folder {cert_dir} ({describe(exc)})") from exc
    log.info("config: %s (%s)", config, write_config(ctx, name))

    if new_secret is not None:
        try:
            if not secret_file.parent.is_dir():
                raise SecretError(f"the secrets folder {secret_file.parent} is missing; "
                                  "it must be mounted")
            atomic_write(secret_file, (new_secret + "\n").encode("ascii"), 0o600)
        except OSError as exc:
            raise SecretError(f"cannot store the secret in {secret_file} ({describe(exc)})") from exc
        emit(ctx, "secret=written")
    else:
        emit(ctx, "secret=kept")

    if args.new_certificate or cert_state == "none":
        setup = load_satellite_setup(ctx)
        try:
            setup.write_certificate_pair(cert_dir, dns, [str(a) for a in ips])
        except Exception as exc:                                # noqa: BLE001
            raise ConfigError(f"cannot create the certificate in {cert_dir} ({describe(exc)})") from exc
        certificate = "created"
    else:
        certificate = "kept"
    emit(ctx, f"certificate={certificate}")
    cert_ips, cert_names = emit_certificate(ctx, cert_dir)
    missing = [str(a) for a in ips if str(a) not in cert_ips] + [d for d in dns if d not in cert_names]
    if missing:
        log.warning("the kept certificate does not cover %s; use --new-certificate to include "
                    "them (Vocalis must then be given the new certificate file)", ", ".join(missing))
    log.info("provision: secret=%s certificate=%s cert_ips=%d cert_dns=%d cert_dir_created=%s in %d ms",
             "written" if new_secret is not None else "kept", certificate, len(cert_ips),
             len(cert_names), cert_dir_created, round((time.monotonic() - started) * 1000))
    return EXIT_OK


def run_show(ctx: Context, args: argparse.Namespace) -> int:
    cert_dir = _need(ctx.cert_dir, "VOCALIS_SATELLITE_CERT_DIR")
    if not (cert_dir / "cert.pem").is_file():
        log.error("there is no certificate in %s", cert_dir)
        return EXIT_CONFIG
    ips, names = emit_certificate(ctx, cert_dir)
    log.info("show: %d addresses, %d names", len(ips), len(names))
    return EXIT_OK


def _default_hide(ctx: Context) -> dict:
    """The satellite's own integrated-graphics rule, before torch is imported in this process."""
    sys.path.insert(0, str(ctx.satellite_dir))
    import vocalis_torch_backend
    return vocalis_torch_backend.hide_integrated_rocm_gpus()


def run_check_gpu(ctx: Context, args: argparse.Namespace) -> int:
    started = time.monotonic()
    decision = ctx.hide_gpus() if ctx.hide_gpus else _default_hide(ctx)
    log.info("check-gpu: integrated-graphics rule decided %s", decision)
    try:
        torch = ctx.load_torch() if ctx.load_torch else __import__("torch")
        available = bool(torch.cuda.is_available())
        count = int(torch.cuda.device_count()) if available else 0
        cards = []
        for index in range(count):
            name = " ".join(str(torch.cuda.get_device_name(index)).split())
            cards.append((index, name))
    except Exception as exc:                                    # noqa: BLE001
        log.error("check-gpu: PyTorch could not list the cards (%s)", describe(exc))
        return EXIT_NO_GPU
    for index, name in cards:
        emit(ctx, f"card={index}\t{name}")
    log.info("check-gpu: %d usable cards (cuda available=%s) in %d ms", len(cards), available,
             round((time.monotonic() - started) * 1000))
    if not cards:
        log.error("PyTorch in this image cannot use any GPU. Check the GPU options of the "
                  "container (NVIDIA runtime, or the /dev/kfd and /dev/dri devices).")
        return EXIT_NO_GPU
    return EXIT_OK


def chatterbox_plan(fm, environ: Mapping[str, str], manifest: Path, models_root: str) -> list:
    """The main package's own plan for the Chatterbox files, without the other models.

    The same functions and checks as the first part and the tail of fetch_models.build_plan: the
    destination from VOCALIS_CHATTERBOX_MODEL_DIR, its revision equal to the manifest's, every
    file an HTTPS URL with a size and a hash, no path named twice and no symlink in the way.
    """
    data = fm.read_json(manifest)
    directory = fm.env_directory(environ, "VOCALIS_CHATTERBOX_MODEL_DIR", models_root)
    fm.require_revision("VOCALIS_CHATTERBOX_MODEL_DIR", directory, data.get("revision"))
    plan = [fm.make_item("chatterbox", directory, entry) for entry in data.get("files", [])]
    if not plan:
        raise fm.Refusal(f"{manifest} lists no files")
    seen = set()
    for item in plan:
        if item.path in seen:
            raise fm.Refusal(f"{item.model}: {item.path} is named twice by the manifest")
        seen.add(item.path)
        fm.check_no_symlinks(Path(models_root), item.path)
    return plan


def run_fetch_model(ctx: Context, args: argparse.Namespace) -> int:
    started = time.monotonic()
    loader = ctx.load_fetcher or (lambda path: _load_module("fetch_models", path))
    try:
        fm = loader(ctx.fetch_models)
    except Exception as exc:                                    # noqa: BLE001
        log.error("cannot load the model fetcher %s (%s)", ctx.fetch_models, describe(exc))
        return EXIT_FAILED
    try:
        plan = chatterbox_plan(fm, ctx.environ, ctx.manifest, ctx.models_root)
        root = Path(ctx.models_root)
        if not root.is_dir():
            raise fm.Refusal(f"{ctx.models_root} is not a directory; the models mount is missing")
        log.info("fetch-model: %d files, %d bytes planned under %s", len(plan),
                 sum(item.size for item in plan), root)
        opener = ctx.opener if ctx.opener is not None else fm.make_opener()
        seeds = fm.seed_roots(ctx.environ.get(fm.SEEDS_VARIABLE) or "")
        with fm.exclusive_lock(root / fm.LOCK_NAME):
            code = fm.fetch(plan, root, opener, ctx.sleep, ctx.disk_free, time.monotonic(), seeds)
    except fm.Refusal as exc:
        log.error("model fetch refused: %s", exc)
        return EXIT_FAILED
    log.info("fetch-model: fetcher returned %d in %d ms", code, round((time.monotonic() - started) * 1000))
    return EXIT_OK if code == 0 else EXIT_FAILED


# --- entry point ---------------------------------------------------------------------------

class _Parser(argparse.ArgumentParser):
    def error(self, message: str):
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="satellite_admin.py", description="Provision a Vocalis Docker satellite.")
    sub = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    sub.add_parser("check-gpu", help="list the cards PyTorch can use; exit 3 when there are none")
    provision = sub.add_parser("provision", help="write the configuration, secret and certificate")
    provision.add_argument("--name", required=True, help="label for the satellite's log lines")
    provision.add_argument("--ip", action="append", default=[], metavar="ADDR",
                           help="an IP address the certificate must cover (repeatable)")
    provision.add_argument("--dns", action="append", default=[], metavar="NAME",
                           help="a host name the certificate must cover (repeatable)")
    provision.add_argument("--secret-from-file", action="store_true",
                           help="read the secret from /run/provision/secret instead of a terminal")
    provision.add_argument("--new-secret", action="store_true", help="replace the stored secret")
    provision.add_argument("--new-certificate", action="store_true",
                           help="replace the certificate and key")
    sub.add_parser("fetch-model", help="download and verify the Chatterbox model files")
    sub.add_parser("show", help="print the certificate's fingerprint and addresses")
    return parser


_COMMANDS = {"check-gpu": run_check_gpu, "provision": run_provision,
             "fetch-model": run_fetch_model, "show": run_show}
_FAILURE_EXIT = {"check-gpu": EXIT_NO_GPU, "provision": EXIT_CONFIG, "fetch-model": EXIT_FAILED,
                 "show": EXIT_CONFIG}


def main(argv: list[str] | None = None, ctx: Context | None = None) -> int:
    ctx = ctx or context_from_environ(os.environ)
    handler = logging.StreamHandler(ctx.err or sys.stderr)
    handler.setFormatter(_RedactingFormatter("%(levelname)s: %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False
    try:
        try:
            args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
        except SystemExit as exc:                               # argparse: usage error (2) or --help (0)
            return exc.code if isinstance(exc.code, int) else EXIT_USAGE
        try:
            return _COMMANDS[args.command](ctx, args)
        except UsageError as exc:
            log.error("%s", exc)
            return EXIT_USAGE
        except SecretError as exc:
            log.error("%s", exc)
            return EXIT_SECRET
        except ConfigError as exc:
            log.error("%s", exc)
            return EXIT_FAILED if args.command == "fetch-model" else EXIT_CONFIG
        except Exception as exc:                                # noqa: BLE001
            # The exception's own text is not printed (it could carry anything); the frames are.
            log.error("unexpected %s", describe(exc))
            log.error("%s", "".join(traceback.format_tb(exc.__traceback__)).rstrip())
            return _FAILURE_EXIT[args.command]
    finally:
        log.removeHandler(handler)
        handler.close()
        _SECRETS.clear()


if __name__ == "__main__":
    # A card name or a file name that the stream's encoding cannot hold must not end the run.
    for _stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            _stream.reconfigure(errors="replace")
    raise SystemExit(main())
