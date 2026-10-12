"""Provision a satellite's shared secret and TLS certificate.

The certificate private key stays on the satellite; the public certificate is
pinned by the Vocalis server. The shared secret is entered interactively and
stored in the operating system credential store.
"""
import contextlib
import getpass
import ipaddress
import os
import socket
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Keep provisioning usable when output is redirected to a console with a limited
# encoding; diagnostics should not fail after credentials or certificates are written.
for _stream in (sys.stdout, sys.stderr):                # stderr too: argparse's error path,
    try:                                                # getpass's non-tty warning, and any
        _stream.reconfigure(errors="replace")           # traceback all go there
    except Exception:                                   # noqa: BLE001  (not a console; fine)
        pass

import vocalis_satellite_protocol as proto      # noqa: E402
import vocalis_satellite_paths as satpaths      # noqa: E402

KEYRING_SERVICE = "vocalis-satellite"
CERTS = satpaths.CERT_DIR
CONFIG_FILE = satpaths.CONFIG_FILE
CERT_YEARS = 10          # long enough that expiry is never an outage, and never a 2am downgrade


def _config() -> dict:
    """`satellite.yaml`, read exactly as `server.py` reads it — see `default_name`."""
    explicit = satpaths.configured("VOCALIS_SATELLITE_CONFIG")
    if not CONFIG_FILE.exists() and explicit:
        raise RuntimeError(f"VOCALIS_SATELLITE_CONFIG file is missing: {CONFIG_FILE}")
    try:
        import yaml
        d = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) \
            if CONFIG_FILE.exists() else {}
    except Exception as exc:                            # noqa: BLE001
        if explicit:
            raise RuntimeError(f"Cannot read VOCALIS_SATELLITE_CONFIG: {CONFIG_FILE}") from exc
        pass                                            # a broken yaml is the server's to report
    else:
        if isinstance(d, dict):
            return d
        if explicit:
            raise RuntimeError(
                f"VOCALIS_SATELLITE_CONFIG must contain a YAML mapping: {CONFIG_FILE}")
    return {}


def default_name() -> str:
    """Return the satellite name used to look up its shared secret."""
    return str(_config().get("name") or "satellite")


def save_name(name: str) -> bool:
    """Persist the name that the server uses to look up its shared secret."""
    if str(_config().get("name") or "satellite") == name:
        return False
    import yaml
    cfg = _config()
    cfg["name"] = name
    payload = yaml.safe_dump(cfg, sort_keys=False).encode("utf-8")
    fd = os.open(CONFIG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "wb") as stream:
            fd = -1
            stream.write(payload)
    finally:
        if fd >= 0:
            os.close(fd)
    print(f"  Recorded the name '{name}' in {CONFIG_FILE.name} - run.bat reads it from there.")
    return True


def default_port() -> int:
    """The port `server.py` will listen on, so the URLs printed at the end are the real ones."""
    try:
        return int(_config().get("port") or 7880)
    except (TypeError, ValueError):
        return 7880


def _bar(title):
    print("\n" + "=" * 62)
    print(f" {title}")
    print("=" * 62)


def store_secret(name: str) -> bool:
    import keyring
    _bar("1/2  Shared secret")
    existing = keyring.get_password(KEYRING_SERVICE, name)
    if existing:
        print(f"  A secret is already stored for satellite '{name}'.")
        if input("  Replace it? [y/N] ").strip().lower() != "y":
            print("  Keeping the existing secret.")
            return False
    print("  Paste the secret Vocalis showed you when you defined this satellite.")
    print("  (64 hex characters. Nothing is echoed.)")
    raw = getpass.getpass("  secret: ").strip()
    if not raw:
        print("  Nothing entered - skipping.")
        return False
    try:
        blob = bytes.fromhex(raw)
    except ValueError:
        sys.exit("  ERROR: that is not hex. Copy the whole string Vocalis displayed.")
    if len(blob) != proto.MASTER_BYTES:
        sys.exit(f"  ERROR: expected {proto.MASTER_BYTES} bytes "
                 f"({proto.MASTER_BYTES * 2} hex chars), got {len(blob)}.")
    keyring.set_password(KEYRING_SERVICE, name, blob.hex())
    print(f"  Stored in the OS credential store as '{KEYRING_SERVICE}/{name}'.")
    return True


def _san_names(extra):
    """Return DNS names and IPv4 addresses to include in the certificate SAN.

    Include the machine hostname and FQDN; TLS clients validate SAN entries,
    not the legacy Common Name.
    """
    host = socket.gethostname()
    fqdn = socket.getfqdn()
    # Include the resolved FQDN so the certificate covers the address clients
    # actually use. The short `.lan` alias supports common local DNS setups.
    names = {host, host.lower(), fqdn, fqdn.lower(), f"{host.lower()}.lan", "localhost"}
    ips = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(host, None):
            addr = info[4][0]
            # The server binds IPv4; IPv6 addresses would identify endpoints it
            # does not serve. Avoid temporary addresses that can change over time.
            if ":" not in addr:
                ips.add(addr)
    except OSError:
        pass
    for e in extra:
        try:
            ipaddress.ip_address(e)
            ips.add(e)
        except ValueError:
            names.add(e)
    return sorted(names), sorted(ips)


def build_certificate(names, ips):
    """Build a self-signed certificate for exactly these DNS names and IP addresses.

    Returns (key_pem, cert_pem) as bytes. It asks nothing, prints nothing and touches no file, so
    both callers share one construction: `make_cert` below (the interactive `setup.bat` path, which
    passes what `_san_names` computes) and the Docker package's provisioning tool
    (`packaging/satellite/satellite_admin.py`, October 10, 2026), which passes only the addresses
    the host script collected. Key type (ECDSA P-256), lifetime (CERT_YEARS) and layout are unchanged.
    The subject's common name is names[0]; `names` must not be empty.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    names, ips = list(names), list(ips)
    if not names:
        raise ValueError("a certificate needs at least one DNS name")
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])])
    now = datetime.now(timezone.utc)
    san = [x509.DNSName(n) for n in names] + \
          [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    cert = (x509.CertificateBuilder()
            .subject_name(subject).issuer_name(subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=365 * CERT_YEARS))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption())
    return key_pem, cert.public_bytes(serialization.Encoding.PEM)


def _write_new_file(path: Path, data: bytes, mode: int) -> None:
    """Create `path` (a temporary name) exclusively with `mode`, never following a symlink.

    A stale file of that name from an earlier failed run is removed first, so O_EXCL cannot be
    defeated by it and a planted link is not written through.
    """
    with contextlib.suppress(FileNotFoundError):
        path.unlink()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        try:
            os.fchmod(fd, mode)         # the umask may have narrowed it
        except (AttributeError, OSError):
            pass                        # Windows has no modes
        with os.fdopen(fd, "wb") as stream:
            fd = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        if fd >= 0:
            os.close(fd)


def write_certificate_pair(cert_dir: Path, names, ips, replace=os.replace):
    """Create `key.pem` and `cert.pem` in `cert_dir` (which must exist); returns (cert_p, key_p).

    Silent, like `build_certificate`. Whatever was there is replaced: the interactive caller asks
    first. The key is created with mode 0600 from the start, never chmod-ed after the write.
    Both new files are first written to temporary names (`*.new`, created exclusively without
    following links), then the certificate is renamed into place, then the key.

    What is guaranteed (October 10, 2026; the Docker tool replaces pairs unattended): a failure
    while writing leaves the old pair untouched; if the certificate rename fails the old pair is
    untouched; if the key rename fails the old certificate's content is put back (or, where there
    was no certificate, the new one is removed), so the old pair is again what is on disk. No
    temporary file is left behind on any failure path here.
    What is not guaranteed: two renames are not one atomic step. A crash or power loss between them
    leaves the new certificate beside the old key, and if putting the old certificate back also
    fails the same mismatch remains; the exception is then raised and the caller must treat the
    pair as unusable and replace it. `replace` is the rename used for the two moves (a test seam;
    the put-back uses the real `os.replace`).
    """
    key_pem, cert_pem = build_certificate(names, ips)
    cert_p, key_p = cert_dir / "cert.pem", cert_dir / "key.pem"
    key_tmp, cert_tmp = cert_dir / "key.pem.new", cert_dir / "cert.pem.new"
    restore_tmp = cert_dir / "cert.pem.restore"
    previous_cert = cert_p.read_bytes() if cert_p.is_file() else None
    try:
        _write_new_file(key_tmp, key_pem, 0o600)
        _write_new_file(cert_tmp, cert_pem, 0o644)
        replace(cert_tmp, cert_p)
        try:
            replace(key_tmp, key_p)
        except BaseException:
            # The key did not land: put the old certificate back so the old pair is intact.
            if previous_cert is None:
                with contextlib.suppress(FileNotFoundError):
                    cert_p.unlink()
            else:
                _write_new_file(restore_tmp, previous_cert, 0o644)
                os.replace(restore_tmp, cert_p)
            raise
    finally:
        for leftover in (key_tmp, cert_tmp, restore_tmp):
            with contextlib.suppress(OSError):
                leftover.unlink()
    return cert_p, key_p


def certificate_fingerprint(cert_p: Path) -> str:
    """SHA-256 fingerprint of a PEM certificate as upper-case hex pairs separated by colons."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    cert = x509.load_pem_x509_certificate(Path(cert_p).read_bytes())
    fp = cert.fingerprint(hashes.SHA256()).hex()
    return ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)).upper()


def certificate_addresses(cert_p: Path):
    """(IP addresses, DNS names) in a PEM certificate's subject alternative name, in file order."""
    from cryptography import x509
    cert = x509.load_pem_x509_certificate(Path(cert_p).read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return ([str(i) for i in san.get_values_for_type(x509.IPAddress)],
            list(san.get_values_for_type(x509.DNSName)))


def make_cert(extra_names) -> bool:
    _bar("2/2  TLS certificate")
    if satpaths.configured("VOCALIS_SATELLITE_CERT_DIR"):
        satpaths.require_directory(CERTS, "VOCALIS_SATELLITE_CERT_DIR")
    else:
        CERTS.mkdir(exist_ok=True)
    cert_p, key_p = CERTS / "cert.pem", CERTS / "key.pem"
    # Prompt if either half exists; replacing a partial pair can invalidate the
    # certificate pinned by the client.
    if cert_p.exists() or key_p.exists():
        half = not (cert_p.exists() and key_p.exists())
        if half:
            missing = key_p.name if cert_p.exists() else cert_p.name
            print(f"  WARNING: {missing} is missing but its pair is still here.")
        # Explain the trust impact before asking whether to replace the certificate.
        print(f"  A certificate already exists at {cert_p}" if cert_p.exists() else
              f"  A private key already exists at {key_p}")
        print("  Vocalis holds a copy of THIS file and trusts only this one - that is what")
        print("  'pinning' means. Making a new certificate does not update that copy, so this")
        print("  satellite becomes unreachable until you copy the new certs/cert.pem over and")
        print("  attach it to the satellite's entry again.")
        print("  Say yes if you have not attached it anywhere yet, or if it does not cover the")
        print("  name the Vocalis machine will use to reach this one.")
        if input("  Regenerate? [y/N] ").strip().lower() != "y":
            print("  Keeping the existing certificate.")
            if cert_p.exists():
                _print_fingerprint(cert_p)
            else:
                print(f"  {key_p.name} has no certificate beside it - this satellite cannot "
                      f"serve TLS until you regenerate.")
            return False

    names, ips = _san_names(extra_names)
    print(f"  names: {', '.join(names)}")
    print(f"  IPs  : {', '.join(ips)}")

    write_certificate_pair(CERTS, names, ips)
    # Keep the private key and uploadable certificate visually distinct. The
    # console encoding is normalized above so redirected output remains safe.
    print("\n  The private key stays here. Nothing copies it, and nothing asks you for it:")
    print(f"      {key_p}")
    print("\n  +-- THIS is the file to upload to Vocalis " + "-" * 28)
    print(f"  |   {cert_p}")
    print("  +" + "-" * 68)
    print("\n  In Vocalis: Settings > Satellites > this satellite's row > 'Upload")
    print("  certificate...'. It takes the file straight from this machine - you do not")
    print("  need to copy it anywhere by hand.\n")
    _print_fingerprint(cert_p)
    return True


def _print_fingerprint(cert_p):
    print(f"  SHA-256: {certificate_fingerprint(cert_p)}")
    print("  This is the certificate's fingerprint. Vocalis shows it too once you attach the")
    print("  file - if the two do not match, you copied the wrong file or something is wrong.")


def print_urls(port: int):
    """Print addresses present in the existing certificate SAN.

    List IPv4 literals first because the server binds an IPv4 socket.
    """
    from cryptography import x509
    cert_p = CERTS / "cert.pem"
    if not cert_p.exists():
        return
    cert = x509.load_pem_x509_certificate(cert_p.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    ips = [str(i) for i in san.get_values_for_type(x509.IPAddress)
           if not ipaddress.ip_address(str(i)).is_loopback]
    names = [n for n in san.get_values_for_type(x509.DNSName) if n != "localhost"]
    print("\n  Point Vocalis at ONE of these - it must match the certificate above:")
    for i, hostish in enumerate(ips + names):
        note = "   <- use this one unless it stops working" if i == 0 else ""
        print(f"      https://{hostish}:{port}{note}")
    print("  Whichever you pick, the machine running Vocalis has to resolve it AND reach this")
    print("  box on that port. A name that does not resolve there is not a certificate problem.")


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Provision this Vocalis satellite")
    ap.add_argument("--name", default=default_name(),
                    help="the satellite's name - defaults to satellite.yaml's, or 'satellite'")
    ap.add_argument("--san", nargs="*", default=[],
                    help="extra hostnames/IPs Vocalis will address this box by")
    ap.add_argument("--skip-secret", action="store_true")
    ap.add_argument("--skip-cert", action="store_true")
    args = ap.parse_args()

    print(f"Provisioning Vocalis satellite '{args.name}'")
    save_name(args.name)                # BEFORE the secret: it decides what name it is filed under
    if not args.skip_secret:
        store_secret(args.name)
    if not args.skip_cert:
        make_cert(args.san)

    port = default_port()
    _bar("Next")
    print("  1. In Vocalis: Settings > Satellites > this satellite's row > 'Upload")
    print("     certificate...', and pick certs/cert.pem from this machine. That is 'pinning',")
    print("     and it is what makes Vocalis trust this box - it shows the same fingerprint")
    print("     back, so you can check it against the one above.")
    print(f"  2. Start the satellite:  run.bat        (listens on port {port})")
    print("  3. In Vocalis, tick this satellite's cards in Settings; they load as soon as you")
    print("     tick them.")
    print_urls(port)
    print()


if __name__ == "__main__":
    main()
