"""Contract tests for packaging/satellite/satellite-setup.sh (design section 9, "Satellite package: one command per
operating system", added October 10, 2026), with a stand-in `docker` on PATH as test_setup_contract.py has.

The stand-in is a small stateful fake of Docker AND of the in-image provisioning tool: it records every call (its
argument list and its environment) and answers `container inspect`, `logs`, `run`, `start`, `restart` and `rm` from a
JSON state file, and it plays satellite_admin.py's subcommands (check-gpu, provision, fetch-model, show) against the
mounted folders. That lets the tests check the exact `docker run` arguments of the run specification and also what
a second or third run of the same command does. A stand-in `ip` feeds sample interface lists, and stand-in `sleep`
and `date` make the 180-second wait a fake clock, so no test waits.

These tests run the Bash script, so on Windows Python they are skipped; run them in a Linux container as the
repository's other contract tests are.
"""

from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile

import pytest

# `pty` needs `termios`, which Windows Python does not have, and a plain `import pty` there fails the whole
# collection run instead of skipping this file (seen on the first combined run, October 10, 2026).
pty = pytest.importorskip("pty", reason="these tests run a Bash script on a pseudo-terminal; run them on Linux")


SATELLITE = Path(__file__).resolve().parents[1] / "satellite"
SCRIPT = SATELLITE / "satellite-setup.sh"
ADMIN = "/opt/vocalis/satellite-admin/satellite_admin.py"
IMAGE = "registry.example/vocalis-satellite-cuda@sha256:" + "a" * 64
IMAGE2 = "registry.example/vocalis-satellite-cuda@sha256:" + "b" * 64
ROCM_IMAGE = "registry.example/vocalis-satellite-rocm@sha256:" + "c" * 64
SECRET = "0123456789abcdef" * 4  # 64 hexadecimal characters, the shape Vocalis shows
SECRET2 = "fedcba9876543210" * 4

SAMPLE_ADDRESSES = (
    "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n"
    "2: eth0    inet 192.168.1.50/24 brd 192.168.1.255 scope global dynamic eth0\\       valid_lft 86000sec preferred_lft 86000sec\n"
    "3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever\n"
    "4: br-1a2b3c4d5e6f    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-1a2b3c4d5e6f\\       valid_lft forever preferred_lft forever\n"
    "5: wlan0    inet 10.0.0.7/24 brd 10.0.0.255 scope global dynamic wlan0\\       valid_lft 3000sec preferred_lft 3000sec\n"
    "6: veth0a1b2c3@if4    inet 172.19.0.2/16 scope global veth0a1b2c3\\       valid_lft forever preferred_lft forever\n"
    "7: virbr0    inet 192.168.122.1/24 brd 192.168.122.255 scope global virbr0\\       valid_lft forever preferred_lft forever\n"
    "8: eth1    inet 169.254.33.4/16 brd 169.254.255.255 scope link eth1\\       valid_lft forever preferred_lft forever\n"
)
SAMPLE_ROUTE = "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.50 uid 0 \\    cache \n"

FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys

D = os.environ["FAKE_DIR"]
ARGV = sys.argv[1:]
ADMIN = "/opt/vocalis/satellite-admin/satellite_admin.py"


def load(name, default):
    path = os.path.join(D, name)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    return default


def save(name, value):
    with open(os.path.join(D, name), "w", encoding="utf-8") as handle:
        json.dump(value, handle)


cfg = load("config.json", {})
state = load("state.json", {"containers": {}, "counter": 0, "serial": 0})

with open(os.path.join(D, "calls.jsonl"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"argv": ARGV, "env": dict(os.environ), "tty": sys.stdin.isatty()}) + "\n")


def out(text=""):
    sys.stdout.write(text)
    sys.stdout.flush()


def err(text):
    sys.stderr.write(text)
    sys.stderr.flush()


def finish(code=0):
    save("state.json", state)
    sys.exit(code)


def stamp():
    # Increasing timestamps in the format Docker prints, so `--since` can be honoured by string comparison.
    state["counter"] += 1
    n = state["counter"]
    return "2026-10-10T10:%02d:%02d.000000000Z" % (n // 60, n % 60)


def log_line(container, text):
    # The container's log persists across restarts, as Docker's does: a line from an earlier start stays in it.
    container.setdefault("log", []).append([container["started_at"], text])


def new_start(container):
    container["started_at"] = stamp()
    container["polls"] = 0
    container["listened"] = False
    container["scenario"] = cfg.get("wait", {"listen_after": 0})
    log_line(container, "starting up")
    if container["scenario"].get("die_after_listening"):
        # Started, logged "listening on https://" and died at once (a crash loop's last run): the log has the line,
        # the container is not running. A script that reads the log before the state would report success.
        container["listened"] = True
        log_line(container, "Vocalis satellite listening on https://0.0.0.0:7880")
        container["status"] = "exited"


def render(fmt, container):
    fmt = fmt.replace("{{.State.Status}}", container["status"])
    fmt = fmt.replace("{{.State.StartedAt}}", container["started_at"])
    fmt = fmt.replace("{{.State.FinishedAt}}", container.get("finished_at", "0001-01-01T00:00:00Z"))
    fmt = fmt.replace("{{.RestartCount}}", str(container["restart_count"]))
    fmt = fmt.replace("{{.HostConfig.RestartPolicy.Name}}", container.get("restart_policy", "no"))
    fmt = fmt.replace("{{.Name}}", "/" + container.get("name", "x"))
    for key, value in container["labels"].items():
        fmt = fmt.replace('{{index .Config.Labels "%s"}}' % key, value)
    return fmt


def ip_key(ip):
    # The real tool prints the certificate's addresses sorted numerically (127.0.0.1 among them).
    return tuple(int(part) for part in ip.split("."))


def option_values(args, flag):
    return [args[i + 1] for i, item in enumerate(args) if item == flag and i + 1 < len(args)]


def kill_the_script():
    """SIGKILL the outermost process whose command line is the setup script: a run that is killed outright, with no
    chance to run its EXIT trap (the stand-in's way of proving that a killed run leaves no result file)."""
    import signal
    target = None
    pid = os.getppid()
    while pid > 1:
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as handle:
                cmdline = handle.read()
            with open("/proc/%d/stat" % pid, encoding="utf-8") as handle:
                parent = int(handle.read().rsplit(")", 1)[1].split()[1])
        except OSError:
            break
        if b"satellite-setup.sh" in cmdline:
            target = pid
        pid = parent
    if target:
        os.kill(target, signal.SIGKILL)
    sys.exit(137)


def mounts_of(args):
    found = {}
    for value in option_values(args, "--mount"):
        fields = dict(part.split("=", 1) if "=" in part else (part, "") for part in value.split(","))
        found[fields["target"]] = (fields["source"], "readonly" in fields)
    return found


command = ARGV[0] if ARGV else ""

if cfg.get("docker_down"):
    # Docker is not running: every call, the plain `info` included, fails the way the real client does.
    err("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n")
    finish(1)

if command == "update":
    # docker update --restart POLICY NAME: changes the policy of a container (it keeps running, StartedAt unchanged).
    if cfg.get("update_exit"):
        err("Error response from daemon: update refused as scripted\n")
        finish(cfg["update_exit"])
    container = state["containers"].get(ARGV[-1])
    if container is None:
        err("Error response from daemon: No such container: %s\n" % ARGV[-1])
        finish(1)
    container["restart_policy"] = option_values(ARGV, "--restart")[0]
    out(ARGV[-1] + "\n")
    finish(0)

if command == "info":
    if cfg.get("info_exit"):
        err("Cannot connect to the Docker daemon\n")
        finish(cfg["info_exit"])
    if "--format" in ARGV:
        out('{"io.containerd.runc.v2":{},"nvidia":{},"runc":{}}\n' if cfg.get("nvidia", True) else '{"runc":{}}\n')
    finish(0)

if command == "image" and ARGV[1] == "inspect":
    finish(0 if ARGV[2] in cfg.get("local_images", []) + state.setdefault("pulled", []) else 1)

if command == "pull":
    if cfg.get("pull_exit"):
        err("Error response from daemon: pull access denied\n")
        finish(cfg["pull_exit"])
    # A pulled image is local from then on, as in Docker.
    state.setdefault("pulled", []).append(ARGV[1])
    out("pulled %s\n" % ARGV[1])
    finish(0)

if command == "container" and ARGV[1] == "inspect":
    name = ARGV[-1]
    container = state["containers"].get(name)
    if container is None:
        err("Error response from daemon: No such container: %s\n" % name)
        finish(1)
    if "--format" in ARGV:
        out(render(ARGV[ARGV.index("--format") + 1], container) + "\n")
    else:
        out(json.dumps([{"Name": name}]) + "\n")
    finish(0)

if command == "logs":
    name = ARGV[-1]
    container = state["containers"].get(name)
    if container is None:
        err("Error: No such container: %s\n" % name)
        finish(1)
    # The satellite writes its log lines (the "listening on https://" line included) to STDERR, and `docker logs`
    # replays them on its own stderr: a script that reads only stdout never sees them.
    if "--tail" in ARGV:
        for stamped, text in container.get("log", []):
            err(text + "\n")
        err("LOG-TAIL-LINE one\nLOG-TAIL-LINE two\n")
        finish(0)
    since = ARGV[ARGV.index("--since") + 1] if "--since" in ARGV else ""
    container["polls"] += 1
    scenario = container["scenario"]
    polls = container["polls"]
    if scenario.get("exit_after") is not None and polls >= scenario["exit_after"]:
        container["status"] = "exited"
        log_line(container, "Traceback: something broke")
    elif scenario.get("restart_after") is not None and polls >= scenario["restart_after"] and not container.get("restarted"):
        container["restart_count"] += 1
        container["restarted"] = True
        container["started_at"] = stamp()
        log_line(container, "starting up")
    elif (scenario.get("listen_after") is not None and polls > scenario["listen_after"]
          and container["status"] == "running" and not container.get("listened")):
        container["listened"] = True
        log_line(container, "Vocalis satellite listening on https://0.0.0.0:7880")
    for stamped, text in container.get("log", []):
        if stamped >= since:
            err(text + "\n")
    finish(0)

if command in ("start", "restart", "stop"):
    container = state["containers"].get(ARGV[-1])
    if container is None:
        err("Error: No such container: %s\n" % ARGV[-1])
        finish(1)
    if command == "stop":
        container["status"] = "exited"
        container["finished_at"] = stamp()
    elif command == "start" and container["status"] == "restarting":
        pass  # as real Docker: `docker start` does nothing for a container in a restart loop (StartedAt unchanged)
    else:
        container["status"] = "running"
        container["restarted"] = False
        new_start(container)
    finish(0)

if command == "rm":
    name = ARGV[-1]
    if name not in state["containers"]:
        err("Error: No such container: %s\n" % name)
        finish(1)
    del state["containers"][name]
    finish(0)

if command == "run" and ARGV[1] == "-d":
    args = ARGV[2:]
    name = option_values(args, "--name")[0]
    labels = dict(item.split("=", 1) for item in option_values(args, "--label"))
    container = {"labels": labels, "args": args, "status": "running", "restart_count": 0, "restarted": False,
                 "name": name, "restart_policy": option_values(args, "--restart")[0]}
    new_start(container)
    state["containers"][name] = container
    if cfg.get("run_exit"):
        container["status"] = "created"
        err("docker: Error response from daemon: driver failed programming external connectivity: port is already allocated.\n")
        finish(cfg["run_exit"])
    out("c0ffee00" * 8 + "\n")  # a container id; deliberately not the test secret (the log tests look for the secret)
    finish(0)

if command == "run" and ADMIN in ARGV:
    index = ARGV.index(ADMIN)
    sub = ARGV[index + 1]
    args = ARGV[index + 2:]
    mounts = mounts_of(ARGV[:index])
    if sub == "check-gpu":
        out(cfg.get("check_gpu_stdout", "card=0\tFake RTX 4090\n"))
        err("INFO: check-gpu: listed the cards\n")
        finish(cfg.get("check_gpu_exit", 0))
    if sub == "fetch-model":
        # The real fetcher's progress is on stdout (no key=value); only its exit code is a contract.
        out("fetch-model: progress 100%\n")
        err("INFO: fetch-model: verifying files\n")
        if cfg.get("kill_script_on") == "fetch-model":
            kill_the_script()
        if cfg.get("fetch_exit"):
            err("ERROR: fetch-model: scripted failure (disk full)\n")
            finish(cfg["fetch_exit"])
        with open(os.path.join(mounts["/models/vocalis"][0], "chatterbox.ok"), "w", encoding="utf-8") as handle:
            handle.write(ARGV[index - 1])
        finish(0)
    if sub == "show":
        if cfg.get("show_exit"):
            err("show: failing as scripted\n")
            finish(cfg["show_exit"])
        cert = os.path.join(mounts["/data/vocalis-satellite"][0], "certs", "cert.pem")
        if not os.path.exists(cert):
            err("There is no certificate.\n")
            finish(5)
        err("INFO: show: read the certificate\n")
        with open(cert, encoding="utf-8") as handle:
            out(handle.read())
        finish(0)
    if sub == "provision":
        # The real tool validates its arguments first (exit 2): an IPv4 address of four decimal octets with no
        # leading zeros, a name of valid DNS labels. The script must have refused anything else long before.
        for ip in option_values(args, "--ip"):
            parts = ip.split(".")
            if len(parts) != 4 or not all(p.isdigit() and (p == "0" or not p.startswith("0")) and int(p) <= 255 for p in parts):
                err("provision: invalid --ip %s\n" % ip)
                finish(2)
        for dns in option_values(args, "--dns"):
            labels = dns.split(".")
            if len(dns) > 253 or not all(
                    1 <= len(l) <= 63 and l[0] != "-" and l[-1] != "-" and all(c.isalnum() or c == "-" for c in l)
                    for l in labels):
                err("provision: invalid --dns %s\n" % dns)
                finish(2)
        if cfg.get("provision_exit"):
            err("provision: failing as scripted\n")
            finish(cfg["provision_exit"])
        data = mounts["/data/vocalis-satellite"][0]
        secrets = mounts["/run/secrets"][0]
        secret_path = os.path.join(secrets, "vocalis-satellite-master")
        lines = []
        if os.path.exists(secret_path) and "--new-secret" not in args:
            lines.append("secret=kept")
        else:
            if "--secret-from-file" in args:
                with open(mounts["/run/provision/secret"][0], encoding="utf-8") as handle:
                    value = handle.read().strip()
            elif "-it" in ARGV[:index]:
                value = cfg.get("prompt_secret", "")
            else:
                err("provision: no terminal to ask on\n")
                finish(4)
            if len(value) != 64 or any(ch not in "0123456789abcdefABCDEF" for ch in value):
                err("provision: that is not a valid secret\n")
                finish(4)
            with open(secret_path, "w", encoding="utf-8") as handle:
                handle.write(value)
            lines.append("secret=written")
        name = option_values(args, "--name")[0]
        with open(os.path.join(data, "satellite.yaml"), "w", encoding="utf-8") as handle:
            handle.write("name: %s\nhost: 0.0.0.0\nport: 7880\n" % name)
        cert = os.path.join(data, "certs", "cert.pem")
        key = os.path.join(data, "certs", "key.pem")
        if "--new-certificate" not in args and os.path.exists(cert) != os.path.exists(key):
            # Half a pair: the real tool never recreates it silently; it exits 5 and names the option.
            err("provision: only one of cert.pem and key.pem exists; use --new-certificate to replace the pair\n")
            finish(5)
        if os.path.exists(cert) and "--new-certificate" not in args:
            lines.append("certificate=kept")
            with open(cert, encoding="utf-8") as handle:
                lines += [line for line in handle.read().splitlines() if line]
        else:
            state["serial"] += 1
            fingerprint = "AA:BB:%02X" % state["serial"]
            body = ["fingerprint=" + fingerprint]
            body += ["ip=" + ip for ip in sorted(set(option_values(args, "--ip") + ["127.0.0.1"]), key=ip_key)]
            body += ["ip=::1"]
            body += ["dns=" + dns for dns in sorted(set(option_values(args, "--dns") + ["localhost"]))]
            with open(cert, "w", encoding="utf-8") as handle:
                handle.write("\n".join(body) + "\n")
            with open(key, "w", encoding="utf-8") as handle:
                handle.write("KEY\n")
            lines.append("certificate=created")
            lines += body
        err("INFO: provision: wrote the configuration and checked the certificate\n")
        out("\n".join(lines) + "\n")
        finish(0)
    err("fake docker: unknown subcommand %s\n" % sub)
    finish(64)

err("fake docker: unexpected call %s\n" % " ".join(ARGV))
finish(64)
'''

FAKE_IP = r'''#!/bin/sh
case "$*" in
  "-4 -o addr show up") cat "$FAKE_DIR/ip-addr.txt" ;;
  "-4 route get 1.1.1.1") if [ -f "$FAKE_DIR/ip-route.txt" ]; then cat "$FAKE_DIR/ip-route.txt"; else echo "RTNETLINK answers: Network is unreachable" >&2; exit 2; fi ;;
  *) echo "fake ip: unexpected call $*" >&2; exit 64 ;;
esac
'''

FAKE_SLEEP = r'''#!/bin/sh
clock=$(cat "$FAKE_DIR/clock")
echo $((clock + ${1%%.*})) > "$FAKE_DIR/clock"
echo "$1" >> "$FAKE_DIR/sleeps"
'''

FAKE_DATE = r'''#!/bin/sh
if [ "$1" = "+%s" ]; then cat "$FAKE_DIR/clock"; else exec REAL_DATE "$@"; fi
'''


def _require_bash():
    if os.name != "posix" or not shutil.which("bash") or not shutil.which("python3"):
        pytest.skip("the satellite script is exercised in its Linux Bash runtime")


def _free_port():
    """A port nothing listens on, from the ephemeral range (so at least 1024, as --port requires)."""
    while True:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        if port >= 1024:
            return port


class Harness:
    """One test's sandbox: the fake tools, the fake machine, and a way to run the script and inspect Docker's log."""

    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.home = tmp_path / "home"
        self.home.mkdir()
        self.dev = tmp_path / "dev"
        self.dev.mkdir()
        self.root = Path(os.path.realpath(tmp_path)) / "satellite folder"
        self.uid = os.getuid()
        self.gid = os.getgid()
        self.port = _free_port()
        self.config_data = {"nvidia": True, "local_images": [], "wait": {"listen_after": 0}}
        self._write_tools()
        self.config()
        (self.fake / "ip-addr.txt").write_text(SAMPLE_ADDRESSES, encoding="utf-8")
        (self.fake / "ip-route.txt").write_text(SAMPLE_ROUTE, encoding="utf-8")
        (self.fake / "clock").write_text("1000000", encoding="utf-8")
        self.secret_file = tmp_path / "secret.txt"
        self.secret_file.write_text(SECRET + "\n", encoding="utf-8")
        self.env = os.environ.copy()
        self.env.update({
            "PATH": os.pathsep.join((str(self.bin), os.environ.get("PATH", ""))),
            "FAKE_DIR": str(self.fake),
            "HOME": str(self.home),
            "SATELLITE_DEV_ROOT": str(self.dev),
        })

    def _write_tools(self):
        real_date = shutil.which("date")
        for name, text in (("docker", FAKE_DOCKER), ("ip", FAKE_IP), ("sleep", FAKE_SLEEP),
                           ("date", FAKE_DATE.replace("REAL_DATE", real_date))):
            tool = self.bin / name
            tool.write_text(text, encoding="utf-8")
            tool.chmod(0o755)

    def config(self, **changes):
        self.config_data.update(changes)
        (self.fake / "config.json").write_text(json.dumps(self.config_data), encoding="utf-8")

    def amd_devices(self, kfd_gid=None, render_gid=None):
        """Fake AMD device nodes under the SATELLITE_DEV_ROOT seam. A group that is the current user's own needs no
        chown, so the single-group case runs for any user; two different groups need root."""
        (self.dev / "kfd").write_text("", encoding="utf-8")
        (self.dev / "dri").mkdir(exist_ok=True)
        (self.dev / "dri" / "renderD128").write_text("", encoding="utf-8")
        try:
            if kfd_gid is not None and kfd_gid != self.gid:
                os.chown(self.dev / "kfd", -1, kfd_gid)
            if render_gid is not None and render_gid != self.gid:
                os.chown(self.dev / "dri" / "renderD128", -1, render_gid)
        except PermissionError:
            pytest.skip("changing a file's group needs root; the contract tests run as root in their container")

    def machine_name(self, name):
        """The name `uname -n` answers (the script derives the default satellite name from it)."""
        tool = self.bin / "uname"
        tool.write_text(f"#!/bin/sh\nif [ \"$1\" = \"-n\" ]; then echo '{name}'; else exec {shutil.which('uname')} \"$@\"; fi\n", encoding="utf-8")
        tool.chmod(0o755)

    def run(self, *args, expected=0, tty=False, root=True, env=None, script=None, auto_port=True):
        command = ["bash", str(script or SCRIPT)]
        if root:
            command += ["--root", str(self.root)]
        # Nearly every test would otherwise use the default port 7880, which the script really probes on 127.0.0.1,
        # so a machine with something on 7880 would fail them. Each test gets its own free port; --remove takes no
        # other option, and one test (test_the_default_port_is_7880) runs without this.
        words = [str(item) for item in args]
        if auto_port and "--port" not in words and "--help" not in words and "--remove" not in words:
            words += ["--port", str(self.port)]
        command += words
        run_env = dict(self.env, **(env or {}))
        if tty:
            master, slave = pty.openpty()
            try:
                result = subprocess.run(command, stdin=slave, capture_output=True, text=True, timeout=60, env=run_env)
            finally:
                os.close(master)
                os.close(slave)
        else:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, env=run_env)
        assert result.returncode == expected, f"exit {result.returncode}\n--- stdout\n{result.stdout}\n--- stderr\n{result.stderr}"
        return result

    # ----- what Docker was asked -----

    def calls(self):
        path = self.fake / "calls.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def argvs(self):
        return [call["argv"] for call in self.calls()]

    def forget_calls(self):
        (self.fake / "calls.jsonl").write_text("", encoding="utf-8")

    def runs(self):
        """Every `docker run`, classified: ('check-gpu'|'provision'|'fetch-model'|'show'|'long', argv)."""
        found = []
        for argv in self.argvs():
            if argv[0] != "run":
                continue
            kind = "long" if argv[1] == "-d" else argv[argv.index(ADMIN) + 1]
            found.append((kind, argv))
        return found

    def kinds(self):
        return [kind for kind, _ in self.runs()]

    def run_of(self, kind):
        matches = [argv for found, argv in self.runs() if found == kind]
        assert len(matches) == 1, f"{kind}: expected one docker run, got {len(matches)}: {self.kinds()}"
        return matches[0]

    def verbs(self):
        """The Docker verbs in order, with `run` split into its kind (for sequence assertions)."""
        verbs = []
        for argv in self.argvs():
            if argv[0] == "run":
                verbs.append("run:" + ("long" if argv[1] == "-d" else argv[argv.index(ADMIN) + 1]))
            elif argv[0] == "container":
                continue
            else:
                verbs.append(argv[0])
        return verbs

    def container_state(self):
        return json.loads((self.fake / "state.json").read_text(encoding="utf-8"))["containers"]

    def set_container(self, **changes):
        state = json.loads((self.fake / "state.json").read_text(encoding="utf-8"))
        (container,) = state["containers"].values()
        for key, value in changes.items():
            if key == "label_spec":
                container["labels"]["vocalis.satellite.spec"] = value
            else:
                container[key] = value
        (self.fake / "state.json").write_text(json.dumps(state), encoding="utf-8")

    # ----- the satellite folder -----

    def env_file(self):
        values = {}
        for line in (self.root / "satellite.env").read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            values[key] = value
        return values

    def sat_id(self):
        return self.env_file()["SATELLITE_ID"]

    def result(self):
        """setup-result.txt as a dict (KEY=VALUE lines)."""
        values = {}
        for line in (self.root / "setup-result.txt").read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            values[key] = value
        return values

    def log_text(self):
        """The setup log of the run that wrote the present setup-result.txt."""
        return Path(self.result()["LOG_FILE"]).read_text(encoding="utf-8")

    def urls(self):
        """The addresses of the last run, primary first, from the result file."""
        value = self.result()["URLS"]
        return value.split(",") if value else []

    def clock(self):
        return int((self.fake / "clock").read_text(encoding="utf-8"))

    # ----- the run specification, written out independently of the script -----

    @property
    def user(self):
        return f"{self.uid}:{self.gid}"

    @staticmethod
    def mnt(source, target, readonly=False):
        return f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")

    def gpu(self, variant="cuda", gids=()):
        if variant == "cuda":
            return ["--gpus", "all"]
        found = ["--device", "/dev/kfd", "--device", "/dev/dri"]
        for gid in gids:
            found += ["--group-add", str(gid)]
        return found

    def oneshot(self, sub, *extra, image=IMAGE, tty=False, secret_file=None, variant="cuda", gids=()):
        root = self.root
        argv = ["run", "--rm", "--read-only", "--tmpfs", "/tmp", "--user", self.user]
        if sub != "fetch-model":
            argv += ["--network", "none"]
        if tty:
            argv.append("-it")
        argv += ["--mount", self.mnt(root / "cache", "/cache/vocalis")]
        if sub == "check-gpu":
            argv += self.gpu(variant, gids)
        elif sub == "provision":
            argv += ["--mount", self.mnt(root / "data", "/data/vocalis-satellite")]
            argv += ["--mount", self.mnt(root / "secrets", "/run/secrets")]
            if secret_file:
                argv += ["--mount", self.mnt(secret_file, "/run/provision/secret", True)]
        elif sub == "fetch-model":
            argv += ["--mount", self.mnt(root / "models", "/models/vocalis")]
        elif sub == "show":
            argv += ["--mount", self.mnt(root / "data", "/data/vocalis-satellite", True)]
        argv += ["--entrypoint", "python", image, ADMIN, sub, *extra]
        return argv

    def long_lived(self, image=IMAGE, port=None, variant="cuda", gids=(), sat_id=None, root=None, user=None, autostart="on"):
        sat_id = sat_id or self.sat_id()
        port = port or self.port
        root = root or self.root
        # October 11, 2026: the --restart token carries the recorded AUTOSTART value (on is unless-stopped, off is no).
        policy = "unless-stopped" if autostart == "on" else "no"
        before = [
            "--name", f"vocalis-satellite-{sat_id}", "--restart", policy, "--read-only",
            "--user", user or self.user, "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
            "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
            "--label", f"vocalis.satellite.id={sat_id}",
        ]
        after = [
            "--publish", f"0.0.0.0:{port}:7880",
            "--mount", self.mnt(root / "data", "/data/vocalis-satellite", True),
            "--mount", self.mnt(root / "secrets", "/run/secrets", True),
            "--mount", self.mnt(root / "logs", "/logs/vocalis-satellite"),
            "--mount", self.mnt(root / "work", "/work/vocalis-satellite"),
            "--mount", self.mnt(root / "cache", "/cache/vocalis"),
            "--mount", self.mnt(root / "models", "/models/vocalis", True),
            *self.gpu(variant, gids),
            image,
        ]
        digest = hashlib.sha256("\n".join(before + after).encode("utf-8")).hexdigest()
        return ["run", "-d", *before, "--label", f"vocalis.satellite.spec={digest}", *after]


@pytest.fixture
def h(tmp_path):
    _require_bash()
    return Harness(tmp_path)


def _first_run(h, *extra, tty=False):
    return h.run("--image", IMAGE, "--secret-file", h.secret_file, *extra, tty=tty)


def _no_docker_run(h):
    assert h.runs() == [], f"nothing may be started or run, but: {h.kinds()}"


# ---------------------------------------------------------------------------------------------------------------
# Step 1: every refusal happens before anything is created
# ---------------------------------------------------------------------------------------------------------------

def test_the_script_is_valid_bash_and_has_no_carriage_returns():
    _require_bash()
    assert subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True).returncode == 0
    assert b"\r" not in SCRIPT.read_bytes()


def test_help_prints_the_usage_and_touches_nothing(h):
    result = h.run("--help", root=False)
    assert "satellite-setup.sh [--root PATH]" in result.stdout and "--new-certificate" in result.stdout
    assert h.calls() == []


REFUSALS = [
    # (arguments after --image IMAGE --secret-file FILE, a fragment of the message)
    (["--port", "80"], "--port must be a number from 1024 through 65535"),
    (["--port", "abc"], "--port must be a number"),
    (["--port", "70000"], "--port must be a number"),
    (["--name", "bad name"], "--name may use letters"),
    (["--name", "-leading"], "--name may use letters"),
    (["--variant", "tpu"], "--variant must be cuda or rocm"),
    (["--bogus"], "unknown argument: --bogus"),
]

# Item J: --address is validated up front, before anything is created or pulled (these used to pass step 1 and fail
# after the 10 GB pull). (value, fragment of the message)
BAD_ADDRESSES = [
    ("1.2.3.256", "not a valid IPv4 address"),
    ("1.2.3", "not a valid IPv4 address"),
    ("010.1.1.1", "no leading zeros"),
    ("1.02.3.4", "no leading zeros"),
    ("127.0.0.1", "cannot be used"),
    ("127.1.2.3", "cannot be used"),
    ("169.254.10.10", "cannot be used"),
    ("224.0.0.1", "cannot be used"),
    ("239.255.255.255", "cannot be used"),
    ("0.0.0.0", "cannot be used"),
    ("0.1.2.3", "cannot be used"),            # 0.0.0.0/8
    ("0.255.255.255", "cannot be used"),
    ("240.0.0.1", "cannot be used"),          # 240.0.0.0 and above (reserved) up to the broadcast address
    ("250.1.2.3", "cannot be used"),
    ("255.255.255.254", "cannot be used"),
    ("255.255.255.255", "cannot be used"),
    ("::1", "IPv6"),
    ("fe80::1", "IPv6"),
    ("2001:db8::7", "IPv6"),
    ("a..b", "neither an IPv4 address nor a valid name"),
    ("bad name!", "neither an IPv4 address nor a valid name"),
    ("-a.example", "neither an IPv4 address nor a valid name"),
    ("a-.example", "neither an IPv4 address nor a valid name"),
    ("a.", "neither an IPv4 address nor a valid name"),
    (".a", "neither an IPv4 address nor a valid name"),
    ("localhost", "neither an IPv4 address nor a valid name"),
    ("LocalHost", "neither an IPv4 address nor a valid name"),
    ("a" * 64 + ".example", "neither an IPv4 address nor a valid name"),
    (".".join(["a" * 60] * 5), "neither an IPv4 address nor a valid name"),  # 304 characters
    ("under_score.example", "neither an IPv4 address nor a valid name"),
]


@pytest.mark.parametrize("value,message", BAD_ADDRESSES)
def test_a_bad_address_is_refused_before_anything_is_created_or_pulled(h, value, message):
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, "--address", value, expected=1)
    assert message in result.stderr, result.stderr
    assert not h.root.exists()
    assert h.runs() == [] and "pull" not in h.verbs()


@pytest.mark.parametrize("value", ["192.168.1.99", "10.0.0.250", "172.16.0.1", "1.0.0.1", "223.255.255.254", "sat-1.example.lan",
                                    "A.B", "a" * 63 + ".example", "x" * 63, "9lives", ".".join(["a" * 61] * 4)])
def test_valid_addresses_pass_step_1(h, value):
    h.run("--image", IMAGE, "--secret-file", h.secret_file, "--address", value)
    assert (h.root / "satellite.env").is_file()


def test_the_fake_tool_validates_like_the_real_one_so_a_bad_value_that_got_through_would_fail(h):
    # Guard on the stand-in itself (item O): it rejects what the real tool rejects, with exit 2.
    result = subprocess.run(
        [str(h.bin / "docker"), "run", "--entrypoint", "python", IMAGE, ADMIN, "provision", "--name", "x", "--ip", "010.1.1.1"],
        capture_output=True, text=True, env=dict(h.env), timeout=30,
    )
    assert result.returncode == 2 and "invalid --ip" in result.stderr


@pytest.mark.parametrize("arguments,message", REFUSALS)
def test_bad_arguments_are_refused_before_anything_is_created(h, arguments, message):
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, *arguments, expected=1)
    assert message in result.stderr
    assert not h.root.exists()
    _no_docker_run(h)


def test_an_option_without_its_value_is_refused(h):
    result = h.run("--port", expected=1, root=False)
    assert "--port requires a port" in result.stderr


def test_the_default_port_is_7880(h):
    # The one test that runs without a per-test port (the script really probes 127.0.0.1:7880).
    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", 7880))
    except OSError:
        pytest.skip("something on this machine already uses port 7880")
    finally:
        probe.close()
    h.run("--image", IMAGE, "--secret-file", h.secret_file, auto_port=False)
    assert h.env_file()["SATELLITE_PORT"] == "7880"
    assert h.run_of("long") == h.long_lived(port=7880)
    assert "0.0.0.0:7880:7880" in h.run_of("long")


def test_no_image_and_no_stamped_default_requires_image(h):
    result = h.run("--secret-file", h.secret_file, expected=1)
    assert "--image is required" in result.stderr and "cuda" in result.stderr
    assert not h.root.exists()
    _no_docker_run(h)


def _stamped_copy(tmp_path, cuda="", rocm=""):
    """What stamp_release.py makes: the script with its two marker lines filled in."""
    text = SCRIPT.read_text(encoding="utf-8")
    text = text.replace('DEFAULT_IMAGE_CUDA=""\n', f'DEFAULT_IMAGE_CUDA="{cuda}"\n', 1)
    text = text.replace('DEFAULT_IMAGE_ROCM=""\n', f'DEFAULT_IMAGE_ROCM="{rocm}"\n', 1)
    copy = tmp_path / "stamped-setup.sh"
    copy.write_text(text, encoding="utf-8")
    return copy


def test_a_stamped_default_image_is_used_for_the_detected_gpu_type(h, tmp_path):
    stamped = _stamped_copy(tmp_path, cuda=IMAGE, rocm=ROCM_IMAGE)
    h.run("--secret-file", h.secret_file, script=stamped)
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE
    assert h.run_of("long") == h.long_lived(image=IMAGE)


def test_a_stamped_amd_default_image_is_used_on_an_amd_machine(h, tmp_path):
    h.config(nvidia=False)
    h.amd_devices(kfd_gid=h.gid, render_gid=h.gid)
    stamped = _stamped_copy(tmp_path, cuda=IMAGE, rocm=ROCM_IMAGE)
    h.run("--secret-file", h.secret_file, script=stamped)
    assert h.env_file()["SATELLITE_IMAGE"] == ROCM_IMAGE


def test_an_explicit_image_overrides_the_stamped_default(h, tmp_path):
    stamped = _stamped_copy(tmp_path, cuda=IMAGE, rocm=ROCM_IMAGE)
    h.run("--image", IMAGE2, "--secret-file", h.secret_file, script=stamped)
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2


def test_a_stamped_default_for_the_other_gpu_type_does_not_count(h, tmp_path):
    stamped = _stamped_copy(tmp_path, cuda="", rocm=ROCM_IMAGE)
    result = h.run("--secret-file", h.secret_file, script=stamped, expected=1)
    assert "--image is required" in result.stderr
    assert not h.root.exists()


def test_a_secret_file_that_is_not_needed_is_said_so(h):
    _first_run(h)
    h.forget_calls()
    result = h.run("--secret-file", h.secret_file)
    assert "--secret-file was not needed" in result.stdout
    assert h.kinds() == ["show", "fetch-model"]


@pytest.mark.parametrize("reference", ["registry.example/x:latest", "name@sha256:" + "a" * 63, "name@sha256:" + "z" * 64])
def test_an_image_without_a_valid_digest_is_refused(h, reference):
    result = h.run("--image", reference, "--secret-file", h.secret_file, expected=1)
    assert "@sha256:<64 hex digits>" in result.stderr
    assert not h.root.exists()


def test_docker_not_answering_is_refused(h):
    h.config(info_exit=1)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "Docker is unavailable" in result.stderr
    assert not h.root.exists()


def test_a_nonempty_folder_without_satellite_env_is_refused_and_left_alone(h):
    h.root.mkdir()
    (h.root / "precious.txt").write_text("keep me", encoding="utf-8")
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "not a satellite folder" in result.stderr
    assert sorted(path.name for path in h.root.iterdir()) == ["precious.txt"]
    _no_docker_run(h)


def test_a_symlink_as_the_folder_is_refused(h, tmp_path):
    target = tmp_path / "real"
    target.mkdir()
    h.root.symlink_to(target)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "must not be a symlink" in result.stderr
    assert list(target.iterdir()) == []


@pytest.mark.parametrize("name", ["it's here", "has,comma"])
def test_a_folder_path_with_an_apostrophe_or_comma_is_refused(h, tmp_path, name):
    result = h.run("--root", tmp_path / name, "--image", IMAGE, "--secret-file", h.secret_file, expected=1, root=False)
    assert "cannot contain" in result.stderr
    assert not (tmp_path / name).exists()


def test_a_folder_path_with_a_line_break_is_refused(h, tmp_path):
    result = h.run("--root", str(tmp_path / "two\nlines"), "--image", IMAGE, "--secret-file", h.secret_file,
                   expected=1, root=False)
    assert "line break" in result.stderr


def test_a_missing_secret_file_is_refused(h):
    result = h.run("--image", IMAGE, "--secret-file", h.tmp / "nope.txt", expected=1)
    assert "does not exist" in result.stderr
    assert not h.root.exists()


def test_a_secret_file_path_with_a_comma_is_refused(h):
    odd = h.tmp / "se,cret.txt"
    odd.write_text(SECRET, encoding="utf-8")
    result = h.run("--image", IMAGE, "--secret-file", odd, expected=1)
    assert "cannot contain a comma" in result.stderr
    assert not h.root.exists()


def test_a_port_in_use_is_refused(h):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    try:
        port = listener.getsockname()[1]
        if port < 1024:
            pytest.skip("the ephemeral port is below 1024")
        result = h.run("--image", IMAGE, "--secret-file", h.secret_file, "--port", port, expected=1)
    finally:
        listener.close()
    assert f"Port {port} is already in use" in result.stderr
    assert not h.root.exists()
    _no_docker_run(h)


def test_no_terminal_and_no_secret_file_is_refused(h):
    result = h.run("--image", IMAGE, expected=1)
    assert "no terminal" in result.stderr and "--secret-file" in result.stderr
    assert not h.root.exists()
    _no_docker_run(h)


def test_both_an_nvidia_runtime_and_amd_devices_stop_setup_and_name_both_choices(h):
    h.amd_devices()
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "--variant cuda" in result.stderr and "--variant rocm" in result.stderr
    assert "NVIDIA" in result.stderr and "AMD" in result.stderr
    assert not h.root.exists()
    _no_docker_run(h)


def test_neither_gpu_stops_setup(h):
    h.config(nvidia=False)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "No usable GPU" in result.stderr
    assert not h.root.exists()


def test_an_explicit_variant_must_match_the_hardware(h):
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, "--variant", "rocm", expected=1)
    assert "--variant rocm was given" in result.stderr
    h.config(nvidia=False)
    h.amd_devices()
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, "--variant", "cuda", expected=1)
    assert "--variant cuda was given" in result.stderr
    assert not h.root.exists()


def test_no_usable_address_is_refused_unless_one_is_given(h):
    (h.fake / "ip-addr.txt").write_text(SAMPLE_ADDRESSES.splitlines()[0] + "\n" + SAMPLE_ADDRESSES.splitlines()[2] + "\n", encoding="utf-8")
    (h.fake / "ip-route.txt").unlink()
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "No network address" in result.stderr and "--address" in result.stderr
    assert not h.root.exists()
    _no_docker_run(h)
    ok = h.run("--image", IMAGE, "--secret-file", h.secret_file, "--address", "10.1.2.3")
    assert "primary: 10.1.2.3" in ok.stdout


@pytest.mark.parametrize("arguments,message", [
    (["--update", "--new-secret", "--image", IMAGE], "--update cannot be combined"),
])
def test_conflicting_actions_are_refused(h, arguments, message):
    result = h.run(*arguments, expected=1)
    assert message in result.stderr
    assert not h.root.exists()


@pytest.mark.parametrize("other", [
    ["--update"], ["--update", "--image", IMAGE], ["--new-secret"], ["--new-certificate"], ["--image", IMAGE],
    ["--variant", "cuda"], ["--port", "7999"], ["--name", "box"], ["--address", "10.0.0.9"],
    ["--secret-file", "SECRET_FILE"],
])
def test_remove_may_be_combined_only_with_root(h, other):
    _first_run(h)
    h.forget_calls()
    other = [str(h.secret_file) if item == "SECRET_FILE" else item for item in other]
    result = h.run("--remove", *other, expected=1)
    assert "--remove can only be combined with --root" in result.stderr
    assert h.argvs() == [] or all(argv[0] == "info" for argv in h.argvs())  # nothing was removed
    assert len(h.container_state()) == 1
    # --root alone is fine.
    h.run("--remove")
    assert h.container_state() == {}


@pytest.mark.parametrize("arguments", [["--update", "--image", IMAGE2], ["--update"], ["--remove"], ["--new-secret"], ["--new-certificate"]])
def test_actions_on_a_folder_that_does_not_exist_are_refused(h, arguments):
    result = h.run(*arguments, expected=1)
    assert "No satellite folder exists" in result.stderr
    assert not h.root.exists()


# ---------------------------------------------------------------------------------------------------------------
# Variant detection and the address rule
# ---------------------------------------------------------------------------------------------------------------

def test_nvidia_only_is_detected_as_cuda(h):
    _first_run(h)
    env = h.env_file()
    assert env["GPU_VARIANT"] == "cuda" and env["GPU_GIDS"] == ""
    assert h.run_of("check-gpu") == h.oneshot("check-gpu", variant="cuda")


def test_amd_only_is_detected_as_rocm_with_one_group_when_both_nodes_share_it(h):
    h.config(nvidia=False)
    h.amd_devices(kfd_gid=h.gid, render_gid=h.gid)
    h.run("--image", ROCM_IMAGE, "--secret-file", h.secret_file)
    env = h.env_file()
    assert env["GPU_VARIANT"] == "rocm" and env["GPU_GIDS"] == str(h.gid)
    assert env["SATELLITE_IMAGE"] == ROCM_IMAGE
    assert h.run_of("check-gpu") == h.oneshot("check-gpu", image=ROCM_IMAGE, variant="rocm", gids=[h.gid])
    # The AMD long-lived argument list is pinned here for any user (the SATELLITE_DEV_ROOT seam supplies the nodes):
    # --device /dev/kfd --device /dev/dri and one --group-add, where it used to need root to run.
    long_lived = h.run_of("long")
    assert long_lived == h.long_lived(image=ROCM_IMAGE, variant="rocm", gids=[h.gid])
    assert long_lived[-7:] == ["--device", "/dev/kfd", "--device", "/dev/dri", "--group-add", str(h.gid), ROCM_IMAGE]
    assert "--gpus" not in long_lived


def test_amd_with_different_kfd_and_render_groups_adds_both_in_that_order(h):
    h.config(nvidia=False)
    h.amd_devices(kfd_gid=4242, render_gid=4343)
    h.run("--image", ROCM_IMAGE, "--secret-file", h.secret_file)
    assert h.env_file()["GPU_GIDS"] == "4242,4343"
    assert h.run_of("long") == h.long_lived(image=ROCM_IMAGE, variant="rocm", gids=[4242, 4343])


def test_both_present_with_an_explicit_variant_picks_that_card(h):
    h.amd_devices(kfd_gid=h.gid, render_gid=h.gid)
    h.run("--image", IMAGE, "--secret-file", h.secret_file, "--variant", "cuda")
    assert h.env_file()["GPU_VARIANT"] == "cuda"
    assert "--gpus" in h.run_of("long")


def test_the_address_rule_keeps_up_physical_ipv4_addresses_with_the_route_source_first(h):
    _first_run(h)
    provision = h.run_of("provision")
    ips = [provision[i + 1] for i, item in enumerate(provision) if item == "--ip"]
    # Loopback, Docker bridges, veth, virbr and link-local are out; 192.168.1.50 is the default route's source.
    assert ips == ["192.168.1.50", "10.0.0.7"]
    # satellite.env then records what the certificate holds, in the order the tool reports it: sorted numerically
    # (and without 127.0.0.1, which the tool lists too).
    assert h.env_file()["IP_ADDRESSES"] == "10.0.0.7,192.168.1.50"


def test_the_primary_is_the_route_source_even_when_another_interface_is_listed_first(h):
    (h.fake / "ip-route.txt").write_text("1.1.1.1 via 10.0.0.1 dev wlan0 src 10.0.0.7 uid 1000 \\    cache \n", encoding="utf-8")
    result = _first_run(h)
    assert "primary: 10.0.0.7" in result.stdout
    # The closing lines name the primary only; the result file has the whole list, primary first.
    assert f"Satellite address: https://10.0.0.7:{h.port}\n" in result.stdout
    assert h.urls() == [f"https://10.0.0.7:{h.port}", f"https://192.168.1.50:{h.port}"]


def test_primary_first_comes_from_the_scripts_own_route_not_from_the_tools_ip_lines(h):
    # The stand-in tool prints ip= lines sorted numerically, so the FIRST ip= line is 10.0.0.7 while the route's
    # source (the primary) is 192.168.1.50: the closing lines must still list 192.168.1.50 first.
    result = _first_run(h)
    certificate = (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8")
    assert [line for line in certificate.splitlines() if line.startswith("ip=")][0] == "ip=10.0.0.7"
    assert f"Satellite address: https://192.168.1.50:{h.port}\n" in result.stdout
    assert h.urls() == [f"https://192.168.1.50:{h.port}", f"https://10.0.0.7:{h.port}"]


def test_without_a_default_route_the_first_usable_address_is_the_primary(h):
    (h.fake / "ip-route.txt").unlink()
    result = _first_run(h)
    assert "primary: 192.168.1.50" in result.stdout


def test_address_arguments_split_into_ipv4_addresses_and_names(h):
    _first_run(h, "--address", "192.168.1.99", "--address", "Sat.Lan", "--address", "192.168.1.50")
    provision = h.run_of("provision")
    assert [provision[i + 1] for i, item in enumerate(provision) if item == "--ip"] == ["192.168.1.50", "10.0.0.7", "192.168.1.99"]
    assert [provision[i + 1] for i, item in enumerate(provision) if item == "--dns"] == ["sat.lan"]
    env = h.env_file()
    assert env["IP_ADDRESSES"] == "10.0.0.7,192.168.1.50,192.168.1.99" and env["DNS_NAMES"] == "sat.lan"


# ---------------------------------------------------------------------------------------------------------------
# First run: the exact docker run arguments, the folder, satellite.env and the closing lines
# ---------------------------------------------------------------------------------------------------------------

def test_first_run_with_a_secret_file_runs_exactly_the_specified_containers_in_order(h):
    result = _first_run(h, "--name", "Workhorse")
    sat_id = h.sat_id()
    assert re.fullmatch(r"vs-[0-9a-f]{12}", sat_id)
    assert h.kinds() == ["check-gpu", "provision", "show", "fetch-model", "long"]
    assert h.run_of("check-gpu") == h.oneshot("check-gpu")
    assert h.run_of("provision") == h.oneshot(
        "provision", "--name", "workhorse", "--ip", "192.168.1.50", "--ip", "10.0.0.7", "--secret-from-file",
        secret_file=Path(os.path.realpath(h.secret_file)))
    assert h.run_of("show") == h.oneshot("show")
    assert h.run_of("fetch-model") == h.oneshot("fetch-model")
    assert h.run_of("long") == h.long_lived()
    # The --secret-file path asked for no terminal (no -it) and had none.
    provision_calls = [call for call in h.calls() if call["argv"][0] == "run" and "provision" in call["argv"]]
    assert len(provision_calls) == 1 and "-it" not in provision_calls[0]["argv"] and provision_calls[0]["tty"] is False
    # Pull comes before the first container; the image is not local here.
    verbs = h.verbs()
    assert verbs.index("pull") < verbs.index("run:check-gpu")
    assert ("Setup needs the satellite image (about 10 GB) and the Chatterbox model files (about 3.2 GB). "
            "Whatever is not already on this computer is downloaded; setup can be run again to resume.") in result.stdout
    assert "Setup will download" not in result.stdout  # live test, October 11, 2026: untrue when the image is already here


def test_the_long_lived_container_label_is_the_hash_of_its_other_arguments(h):
    _first_run(h)
    argv = h.run_of("long")
    spec = [item for item in argv if item.startswith("vocalis.satellite.spec=")][0].split("=", 1)[1]
    index = argv.index("vocalis.satellite.spec=" + spec)
    hashed = argv[2:index - 1] + argv[index + 1:]
    assert hashlib.sha256("\n".join(hashed).encode("utf-8")).hexdigest() == spec
    assert argv[index - 1] == "--label"
    # The recorded container carries both labels.
    (container,) = h.container_state().values()
    assert container["labels"] == {"vocalis.satellite.id": h.sat_id(), "vocalis.satellite.spec": spec}


def test_satellite_env_is_written_first_with_the_specified_keys_and_quoting(h):
    _first_run(h, "--port", "7999", "--name", "box")
    text = (h.root / "satellite.env").read_text(encoding="utf-8")
    keys = [line.split("=", 1)[0] for line in text.splitlines()]
    # October 11, 2026: AUTOSTART (twelfth) and CERT_FINGERPRINT (thirteenth) join the eleven.
    assert keys == ["SATELLITE_ID", "GPU_VARIANT", "SATELLITE_ROOT", "SATELLITE_IMAGE", "SATELLITE_PORT", "SATELLITE_NAME",
                    "SERVICE_UID", "SERVICE_GID", "GPU_GIDS", "IP_ADDRESSES", "DNS_NAMES", "AUTOSTART", "CERT_FINGERPRINT"]
    env = h.env_file()
    assert env["AUTOSTART"] == "on" and env["CERT_FINGERPRINT"] == "AA:BB:01"
    assert env["SATELLITE_ROOT"] == f"'{h.root}'"
    assert env["SATELLITE_IMAGE"] == IMAGE and env["SATELLITE_PORT"] == "7999" and env["SATELLITE_NAME"] == "box"
    assert env["SERVICE_UID"] == str(h.uid) and env["SERVICE_GID"] == str(h.gid)
    assert (h.root / "satellite.env").stat().st_mode & 0o777 == 0o600
    assert not list(h.root.glob(".satellite.env.tmp.*"))
    assert h.run_of("long") == h.long_lived(port=7999)


def test_the_folder_layout_and_the_default_name(h):
    _first_run(h)
    for sub in ("data", "data/certs", "secrets", "logs", "work", "cache", "models"):
        assert (h.root / sub).is_dir(), sub
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET
    expected = re.sub(r"[^a-z0-9._-]", "-", socket.gethostname().lower())[:63]
    assert h.env_file()["SATELLITE_NAME"] == expected


def test_satellite_env_exists_before_any_container_is_created(h):
    h.config(check_gpu_exit=3)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "no GPU card" in result.stderr
    # The GPU check failed at step 3: satellite.env was already written, no container or secret exists.
    assert (h.root / "satellite.env").is_file()
    assert not (h.root / "secrets" / "vocalis-satellite-master").exists()
    assert h.kinds() == ["check-gpu"]


def test_the_closing_lines(h):
    # October 11, 2026 (script change 3): the closing lines are short and say one thing; the network note and the stop,
    # start, update and remove commands are in --help, the guide and the log, not here.
    result = _first_run(h)
    out = result.stdout
    cert = h.root / "data" / "certs" / "cert.pem"
    closing = out[out.index("One thing left"):]
    assert closing.startswith(
        "One thing left: give Vocalis this satellite's certificate.\n"
        f"  File to upload:  {cert}\n"
        "  Fingerprint:     AA:BB:01\n"
        "If your browser is on another computer, copy that file there first.\n"
        'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite\'s row. Then tick its card.\n'
        f"Satellite address: https://192.168.1.50:{h.port}\n")
    assert h.urls() == [f"https://192.168.1.50:{h.port}", f"https://10.0.0.7:{h.port}"]
    # One line points at the guide's Network section, then the log and how to run it, which is the last line.
    assert 'see the "Network" section of the satellite guide' in closing
    assert f"Log of this run: {h.result()['LOG_FILE']}\n" in closing
    assert out.rstrip("\n").splitlines()[-1].startswith("To run it: ")
    # What left the closing lines (they are in the log).
    for gone in ("ufw", "DOCKER-USER", "docker stop", "docker start", "--update --image", "--remove", "Two steps are left",
                 "Certificate fingerprint (SHA-256)", "Address to use in Vocalis"):
        assert gone not in out, gone
    log = h.log_text()
    sat = f"vocalis-satellite-{h.sat_id()}"
    assert "ufw" in log and "DOCKER-USER" in log and "never forward its port from the internet" in log
    assert f"docker stop {sat}" in log and f"docker start {sat}" in log and "--update --image" in log and "--remove" in log
    assert "sudo" not in out.replace("without sudo", "").replace("never uses sudo", "")


def test_a_local_image_is_not_pulled(h):
    h.config(local_images=[IMAGE])
    result = _first_run(h)
    assert "pull" not in h.verbs()
    assert "Image found locally, not pulled" in result.stdout


def test_the_interactive_secret_prompt_attaches_a_terminal_and_mounts_no_file(h):
    h.config(prompt_secret=SECRET)
    result = h.run("--image", IMAGE, tty=True)
    provision = h.run_of("provision")
    assert provision == h.oneshot("provision", "--name", h.env_file()["SATELLITE_NAME"], "--ip", "192.168.1.50", "--ip", "10.0.0.7", tty=True)
    assert "-it" in provision and "--secret-from-file" not in provision
    assert not any("/run/provision/secret" in item for item in provision)
    # The prompting provision really had a terminal on its stdin (the stand-in records it).
    assert [call["tty"] for call in h.calls() if call["argv"][0] == "run" and "provision" in call["argv"]] == [True]
    assert f"https://192.168.1.50:{h.port}" in result.stdout  # the URL to give Vocalis is printed before the prompt
    assert result.stdout.index("Now add this satellite in Vocalis") < result.stdout.index("One thing left")
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET


def test_empty_input_at_the_prompt_ends_setup_with_nothing_started(h):
    h.config(prompt_secret="", provision_exit=4)
    result = h.run("--image", IMAGE, tty=True, expected=1)
    assert "secret was not accepted or could not be used" in result.stderr
    assert "long" not in h.kinds() and "fetch-model" not in h.kinds()
    assert not (h.fake / "state.json").exists() or h.container_state() == {}


# ---------------------------------------------------------------------------------------------------------------
# The secret never appears anywhere the script controls
# ---------------------------------------------------------------------------------------------------------------

def _assert_secret_nowhere(h, *results):
    # The VALUE of a secret appears in no recorded argument and in no environment VALUE (nor name) of any call.
    for call in h.calls():
        for argument in call["argv"]:
            assert SECRET not in argument and SECRET2 not in argument, argument
        for name, value in call["env"].items():
            assert SECRET not in value and SECRET2 not in value, name
            assert SECRET not in name and SECRET2 not in name
    for result in results:
        assert SECRET not in result.stdout + result.stderr
        assert SECRET2 not in result.stdout + result.stderr
    assert SECRET not in (h.root / "satellite.env").read_text(encoding="utf-8")


def test_the_secret_is_in_no_argument_environment_or_output_with_a_file(h):
    result = _first_run(h)
    _assert_secret_nowhere(h, result)
    # The only thing that crosses is the path of the user's file, as a read-only single-file mount.
    mounts = [item for item in h.run_of("provision") if item.endswith("target=/run/provision/secret,readonly")]
    assert len(mounts) == 1
    assert h.calls(), "the check above must have had calls to look at"


def test_the_secret_is_in_no_argument_environment_or_output_at_the_prompt(h):
    h.config(prompt_secret=SECRET)
    result = h.run("--image", IMAGE, tty=True)
    _assert_secret_nowhere(h, result)


# ---------------------------------------------------------------------------------------------------------------
# The wait
# ---------------------------------------------------------------------------------------------------------------

def test_the_wait_succeeds_when_the_listening_line_appears_later(h):
    h.config(wait={"listen_after": 5})
    result = _first_run(h)
    assert "The satellite is listening." in result.stdout
    start = 1000000
    assert start < h.clock() < start + 180


def test_the_wait_gives_up_after_180_seconds_and_prints_the_end_of_the_log(h):
    h.config(wait={"listen_after": None})
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert h.clock() - 1000000 >= 180
    assert "did not report that it was listening within 180 seconds" in result.stderr
    assert "LOG-TAIL-LINE" in result.stderr
    # The folder is a satellite folder: the same command resumes.
    assert (h.root / "satellite.env").is_file()


def test_the_wait_stops_early_when_the_container_exits(h):
    h.config(wait={"exit_after": 2})
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "stopped or restarted before it reported" in result.stderr
    assert "LOG-TAIL-LINE" in result.stderr
    assert h.clock() - 1000000 < 30


def test_the_wait_stops_early_when_the_container_restarts(h):
    h.config(wait={"restart_after": 1})
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "stopped or restarted before it reported" in result.stderr
    assert h.clock() - 1000000 < 30


def test_a_failed_docker_run_removes_the_leftover_container_and_says_what_to_do(h):
    h.config(run_exit=125)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "port is already allocated" in result.stderr and "could not start the satellite container" in result.stderr
    assert h.container_state() == {}
    assert "rm" in h.verbs()


# ---------------------------------------------------------------------------------------------------------------
# A later run: the repair path and the three recreate cases
# ---------------------------------------------------------------------------------------------------------------

def test_rerun_with_the_container_running_and_the_same_label_changes_nothing(h):
    _first_run(h)
    spec_before = json.dumps(h.container_state(), sort_keys=True)
    h.forget_calls()
    # No terminal and no --secret-file: a later run needs neither, the secret exists.
    result = h.run()
    assert h.kinds() == ["show", "fetch-model"], h.kinds()
    assert h.run_of("fetch-model") == h.oneshot("fetch-model")
    assert not {"start", "restart", "rm", "logs", "pull"} & set(h.verbs())
    assert json.dumps(h.container_state(), sort_keys=True) == spec_before
    assert "left as it is" in result.stdout
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET


def test_rerun_with_the_container_stopped_and_the_same_label_starts_it_and_waits(h):
    _first_run(h)
    h.set_container(status="exited")
    h.forget_calls()
    result = h.run()
    assert h.kinds() == ["show", "fetch-model"]
    verbs = h.verbs()
    assert "start" in verbs and "rm" not in verbs and "logs" in verbs
    assert "The satellite is listening." in result.stdout
    (container,) = h.container_state().values()
    assert container["status"] == "running"


def test_rerun_with_a_different_label_removes_and_creates_the_container(h):
    _first_run(h)
    h.set_container(label_spec="0" * 64)
    h.forget_calls()
    h.run()
    # Replaced, so the GPU check runs again before the old container is touched.
    assert h.kinds() == ["check-gpu", "show", "fetch-model", "long"]
    verbs = h.verbs()
    assert verbs.index("run:check-gpu") < verbs.index("rm") < verbs.index("run:long")
    assert h.run_of("long") == h.long_lived()


def test_rerun_with_the_container_missing_creates_it(h):
    _first_run(h)
    state = json.loads((h.fake / "state.json").read_text(encoding="utf-8"))
    state["containers"] = {}
    (h.fake / "state.json").write_text(json.dumps(state), encoding="utf-8")
    h.forget_calls()
    h.run()
    assert h.kinds() == ["check-gpu", "show", "fetch-model", "long"]
    assert "rm" not in h.verbs()
    assert h.run_of("long") == h.long_lived()


def test_rerun_repeating_the_first_commands_flags_is_accepted(h):
    _first_run(h, "--port", "7999", "--name", "box")
    h.forget_calls()
    _first_run(h, "--port", "7999", "--name", "box", "--variant", "cuda")
    assert "long" not in h.kinds() and "provision" not in h.kinds()


def test_rerun_refuses_a_different_port_variant_name_or_image(h):
    _first_run(h, "--port", "7999", "--name", "box")
    for arguments, message in (
        (["--port", "7998"], "port of an existing satellite folder is fixed (recorded: 7999)"),
        (["--variant", "rocm"], "GPU type of an existing satellite folder is fixed (recorded: cuda)"),
        (["--name", "other"], "name of an existing satellite folder is fixed (recorded: box)"),
        (["--image", IMAGE2], "needs --update (recorded: " + IMAGE + ")"),
    ):
        h.forget_calls()
        result = h.run(*arguments, expected=1, auto_port=False)
        assert message in result.stderr, result.stderr
        assert h.runs() == []


def test_rerun_by_a_different_user_is_refused(h):
    _first_run(h)
    env = (h.root / "satellite.env").read_text(encoding="utf-8")
    (h.root / "satellite.env").write_text(re.sub(r"SERVICE_UID=\d+", "SERVICE_UID=4242", env), encoding="utf-8")
    h.forget_calls()
    result = h.run(expected=1)
    assert "belongs to user id 4242" in result.stderr and "docker rm -f vocalis-satellite-" in result.stderr
    assert h.runs() == []


def test_a_copied_folder_whose_env_names_another_root_is_refused(h, tmp_path):
    _first_run(h)
    moved = tmp_path / "moved"
    shutil.copytree(h.root, moved)
    result = h.run("--root", moved, root=False, expected=1)
    assert "does not match satellite.env" in result.stderr


def _damaged_env_cases(good):
    lines = good.splitlines()
    root_line = next(index for index, line in enumerate(lines) if line.startswith("SATELLITE_ROOT="))
    port_line = next(index for index, line in enumerate(lines) if line.startswith("SATELLITE_PORT="))
    return {
        "missing SATELLITE_ROOT": ("\n".join(line for index, line in enumerate(lines) if index != root_line) + "\n",
                                   "has no SATELLITE_ROOT line"),
        "duplicated key": (good + "SATELLITE_PORT=7000\n", f"line {len(lines) + 1} repeats SATELLITE_PORT (first on line {port_line + 1})"),
        "malformed line": ("\n".join(lines[:3] + ["this is not a setting"] + lines[3:]) + "\n",
                           "line 4 is not a KEY=VALUE line: 'this is not a setting'"),
        "unknown key": (good + "FUTURE_KEY=keep me\n", f"line {len(lines) + 1} has an unknown key 'FUTURE_KEY'"),
        "comment line": ("# written by hand\n" + good, "line 1 is not a KEY=VALUE line"),
        "blank line": (good + "\n", f"line {len(lines) + 1} is not a KEY=VALUE line"),
        "lower-case key": (good.replace("SERVICE_UID=", "service_uid="), "is not a KEY=VALUE line"),
    }


@pytest.mark.parametrize("case", ["missing SATELLITE_ROOT", "duplicated key", "malformed line", "unknown key",
                                  "comment line", "blank line", "lower-case key"])
@pytest.mark.parametrize("remove", [False, True])
def test_a_satellite_env_that_this_script_did_not_write_is_refused_before_any_docker_call(h, case, remove):
    _first_run(h)
    path = h.root / "satellite.env"
    good = path.read_text(encoding="utf-8")
    damaged, message = _damaged_env_cases(good)[case]
    path.write_text(damaged, encoding="utf-8")
    h.forget_calls()
    result = h.run("--remove", expected=1) if remove else h.run(expected=1)
    output = result.stdout + result.stderr
    assert str(path) in output and message in output, output
    assert "It is not a file this setup wrote, so nothing was done." in output
    assert h.argvs() == [], "no Docker call may be made for a settings file that is refused"
    assert path.read_text(encoding="utf-8") == damaged  # untouched
    assert len(h.container_state()) == 1  # the container was not removed


def test_a_satellite_env_this_script_wrote_still_loads_with_the_quoted_root(h):
    _first_run(h)
    assert h.env_file()["SATELLITE_ROOT"] == f"'{h.root}'"
    h.run()  # reads it back strictly
    h.run("--remove")


def test_a_later_run_does_not_count_its_own_running_container_as_holding_the_port(h):
    port = h.port
    _first_run(h)
    # The real container would hold the port; here a listener plays it, and the fake says the container runs.
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(1)
    try:
        h.run()  # container is running: accepted
        h.set_container(status="exited")
        refused = h.run(expected=1)  # container is not running: the listener is someone else
        assert f"Port {port} is already in use" in refused.stderr
    finally:
        listener.close()


def test_a_later_run_warns_when_the_primary_address_is_not_in_the_certificate(h):
    _first_run(h)
    (h.fake / "ip-route.txt").write_text("1.1.1.1 via 10.9.9.1 dev eth0 src 10.9.9.50 uid 0 \\    cache \n", encoding="utf-8")
    (h.fake / "ip-addr.txt").write_text("2: eth0    inet 10.9.9.50/24 brd 10.9.9.255 scope global eth0\\       valid_lft forever\n", encoding="utf-8")
    h.forget_calls()
    result = h.run()
    assert "primary address 10.9.9.50 is not in the certificate" in result.stderr
    assert "--new-certificate" in result.stderr
    # Still repaired and still reported.
    assert "  Fingerprint:       AA:BB:01\n" in result.stdout


def test_a_later_run_warns_for_an_address_argument_that_is_not_in_the_certificate(h):
    _first_run(h)
    result = h.run("--address", "192.168.1.77", "--address", "other.lan")
    assert "--address 192.168.1.77 is not in the certificate" in result.stderr
    assert "--address other.lan is not in the certificate" in result.stderr
    ok = h.run("--address", "192.168.1.50")
    # (The only warning left is the one about running as root, which these tests do in their container.)
    assert "not in the certificate" not in ok.stderr


# ---------------------------------------------------------------------------------------------------------------
# Resume after a failure in a later step
# ---------------------------------------------------------------------------------------------------------------

def test_a_failed_model_download_leaves_a_folder_the_same_command_resumes(h):
    h.config(fetch_exit=1)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "model download did not finish" in result.stderr and "Run the same command again" in result.stderr
    assert "long" not in h.kinds()
    secret_before = (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8")
    cert_before = (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8")
    assert h.env_file()["IP_ADDRESSES"] == "10.0.0.7,192.168.1.50"

    h.config(fetch_exit=0)
    h.forget_calls()
    # The same command, now without a terminal and without the secret file: nothing more is asked of the user.
    h.run("--image", IMAGE)
    assert h.kinds() == ["check-gpu", "show", "fetch-model", "long"]
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == secret_before
    assert (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8") == cert_before


def test_a_secret_that_is_not_accepted_stops_before_the_model_and_the_container(h):
    h.secret_file.write_text("not a secret\n", encoding="utf-8")
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "secret was not accepted or could not be used" in result.stderr
    assert "not a valid secret" in result.stderr  # the tool's own message passes through
    assert h.kinds() == ["check-gpu", "provision"]
    assert not (h.root / "secrets" / "vocalis-satellite-master").exists()
    # Fixing the file and running the same command finishes the setup.
    h.secret_file.write_text(SECRET + "\n", encoding="utf-8")
    h.forget_calls()
    h.run("--image", IMAGE, "--secret-file", h.secret_file)
    assert h.kinds() == ["check-gpu", "provision", "show", "fetch-model", "long"]


def test_a_failed_certificate_step_is_reported_with_its_own_message(h):
    h.config(provision_exit=5)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "configuration or the certificate is not usable (exit status 5)" in result.stderr
    assert "provision: failing as scripted" in result.stderr
    # Stop: no retry, nothing replaced, nothing started.
    assert h.kinds() == ["check-gpu", "provision"]
    assert not (h.root / "data" / "certs" / "cert.pem").exists()


@pytest.mark.parametrize("code", [4, 5])
def test_exit_4_or_5_on_a_later_run_stops_without_replacing_anything(h, code):
    _first_run(h)
    cert = (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8")
    secret = (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8")
    (h.root / "data" / "certs" / "key.pem").unlink()  # half a pair: the next provision is needed
    h.config(provision_exit=code)
    h.forget_calls()
    result = h.run(expected=1)
    assert f"exit status {code}" in result.stderr
    assert h.kinds() == ["provision"]
    assert (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8") == cert
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == secret


def test_loopback_localhost_and_ipv6_lines_of_the_certificate_are_left_out(h):
    result = _first_run(h)
    # The fake tool's certificate holds 127.0.0.1, ::1 and localhost besides the real addresses, as the real one does.
    cert = (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8")
    assert "ip=127.0.0.1" in cert and "ip=::1" in cert and "dns=localhost" in cert
    env = h.env_file()
    assert env["IP_ADDRESSES"] == "10.0.0.7,192.168.1.50" and env["DNS_NAMES"] == ""
    assert h.urls() == [f"https://192.168.1.50:{h.port}", f"https://10.0.0.7:{h.port}"]
    # The tool's INFO lines are never mistaken for failure; since October 11, 2026 they are not shown by default (they are
    # in the log, and shown with --verbose).
    assert "INFO" not in result.stderr and "INFO" not in result.stdout
    assert "INFO: provision:" in h.log_text() and "INFO: show:" in h.log_text()
    # A later run compares the primary address and each --address with the filtered list: no warning.
    later = h.run("--address", "10.0.0.7")
    assert "not in the certificate" not in later.stderr
    assert "INFO" not in later.stderr
    verbose = h.run("--address", "10.0.0.7", "--verbose")
    assert "INFO: show:" in verbose.stderr


def test_the_gpu_check_comes_before_the_secret_is_asked_for(h):
    h.config(check_gpu_exit=3)
    result = h.run("--image", IMAGE, tty=True, expected=1)
    assert "no GPU card" in result.stderr
    assert h.kinds() == ["check-gpu"]
    assert "Now add this satellite in Vocalis" not in result.stdout


def test_a_gpu_check_that_prints_no_cards_is_refused(h):
    h.config(check_gpu_stdout="")
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "printed no cards" in result.stderr


# ---------------------------------------------------------------------------------------------------------------
# --update
# ---------------------------------------------------------------------------------------------------------------

def test_update_pulls_fetches_with_the_new_image_then_records_and_recreates(h):
    _first_run(h)
    old_spec = h.run_of("long")
    h.forget_calls()
    result = h.run("--update", "--image", IMAGE2)
    # The sequence (item B): pull the new image; check-gpu AND fetch-model with the NEW image; only then record it and
    # replace the container; wait; show for the closing lines. No provision.
    assert h.kinds() == ["check-gpu", "fetch-model", "long", "show"]
    assert ["pull", IMAGE2] in h.argvs() and [argv for argv in h.argvs() if argv[0] == "pull"] == [["pull", IMAGE2]]
    assert h.run_of("check-gpu") == h.oneshot("check-gpu", image=IMAGE2)
    assert h.run_of("fetch-model") == h.oneshot("fetch-model", image=IMAGE2)
    assert h.run_of("long") == h.long_lived(image=IMAGE2)
    assert h.run_of("show") == h.oneshot("show", image=IMAGE2)
    assert h.run_of("long") != old_spec
    verbs = h.verbs()
    order = [verb for verb in verbs if verb in ("pull", "run:check-gpu", "run:fetch-model", "rm", "run:long", "run:show")]
    assert order == ["pull", "run:check-gpu", "run:fetch-model", "rm", "run:long", "run:show"]
    assert verbs.index("logs") > verbs.index("run:long") and verbs.index("logs") < verbs.index("run:show")
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2
    assert "nothing has to be paired again" in result.stdout and "  Fingerprint:       AA:BB:01\n" in result.stdout
    # Secret and certificate are untouched.
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET
    # The fetch ran from the model folder the new image wrote.
    assert (h.root / "models" / "chatterbox.ok").read_text(encoding="utf-8") == IMAGE2


def test_update_with_a_failed_pull_leaves_the_running_satellite_and_env_alone(h):
    _first_run(h)
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.config(pull_exit=1)
    h.forget_calls()
    result = h.run("--update", "--image", IMAGE2, expected=1)
    assert "could not be pulled" in result.stderr
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == env_before
    assert json.dumps(h.container_state(), sort_keys=True) == state_before
    assert h.runs() == [] and not {"rm", "start", "restart"} & set(h.verbs())


def test_update_with_a_failed_model_fetch_leaves_the_running_satellite_and_env_alone(h):
    _first_run(h)
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.config(fetch_exit=1)
    h.forget_calls()
    result = h.run("--update", "--image", IMAGE2, expected=1)
    assert "The running satellite and satellite.env were not changed" in result.stderr
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == env_before
    assert json.dumps(h.container_state(), sort_keys=True) == state_before
    assert h.kinds() == ["check-gpu", "fetch-model"] and not {"rm", "start", "restart"} & set(h.verbs())
    # The same command resumes.
    h.config(fetch_exit=0)
    h.run("--update", "--image", IMAGE2)
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2


def test_update_where_the_new_image_finds_no_card_stops_before_anything_is_recorded(h):
    _first_run(h)
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.config(check_gpu_exit=3)
    h.forget_calls()
    result = h.run("--update", "--image", IMAGE2, expected=1)
    assert "no GPU card" in result.stderr
    assert h.kinds() == ["check-gpu"] and h.run_of("check-gpu") == h.oneshot("check-gpu", image=IMAGE2)
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == env_before
    assert json.dumps(h.container_state(), sort_keys=True) == state_before
    assert not {"rm", "start", "restart"} & set(h.verbs())


@pytest.mark.parametrize("missing", ["secrets/vocalis-satellite-master", "data/certs/cert.pem", "data/certs/key.pem", "data/satellite.yaml"])
def test_update_on_an_incomplete_folder_is_refused_before_anything_is_pulled(h, missing):
    _first_run(h)
    (h.root / missing).unlink()
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    h.forget_calls()
    result = h.run("--update", "--image", IMAGE2, expected=1)
    assert "incomplete" in result.stderr and missing in result.stderr and "Finish setup first" in result.stderr
    assert "pull" not in h.verbs() and h.runs() == []
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == env_before


IMAGE3 = "registry.example/vocalis-satellite-cuda@sha256:" + "d" * 64


def test_update_without_image_on_an_unstamped_script_is_refused_and_changes_nothing(h):
    _first_run(h)
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.forget_calls()
    result = h.run("--update", expected=1)
    assert "no default image stamped in" in result.stderr and "--image" in result.stderr
    assert h.runs() == [] and not {"pull", "rm", "start", "restart"} & set(h.verbs())
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == env_before
    assert json.dumps(h.container_state(), sort_keys=True) == state_before


def test_update_without_image_uses_the_stamped_default(h, tmp_path):
    _first_run(h)
    stamped = _stamped_copy(tmp_path, cuda=IMAGE2, rocm=ROCM_IMAGE)
    h.forget_calls()
    result = h.run("--update", script=stamped)
    assert h.kinds() == ["check-gpu", "fetch-model", "long", "show"]
    assert [argv for argv in h.argvs() if argv[0] == "pull"] == [["pull", IMAGE2]]
    assert h.run_of("check-gpu") == h.oneshot("check-gpu", image=IMAGE2)
    assert h.run_of("fetch-model") == h.oneshot("fetch-model", image=IMAGE2)
    assert h.run_of("long") == h.long_lived(image=IMAGE2)
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2
    assert "pull" in h.verbs() and "nothing has to be paired again" in result.stdout


def test_update_with_an_explicit_image_wins_over_the_stamped_default(h, tmp_path):
    _first_run(h)
    stamped = _stamped_copy(tmp_path, cuda=IMAGE2, rocm=ROCM_IMAGE)
    h.forget_calls()
    h.run("--update", "--image", IMAGE3, script=stamped)
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE3
    assert h.run_of("fetch-model") == h.oneshot("fetch-model", image=IMAGE3)
    (container,) = h.container_state().values()
    assert container["args"][-1] == IMAGE3


@pytest.mark.parametrize("stamped_default,argument", [("", IMAGE), (IMAGE, None)])
def test_update_to_the_image_already_recorded_is_a_plain_run_with_exit_0(h, tmp_path, stamped_default, argument):
    _first_run(h)
    script = _stamped_copy(tmp_path, cuda=stamped_default, rocm=ROCM_IMAGE) if stamped_default else SCRIPT
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.forget_calls()
    args = ["--update"] + (["--image", argument] if argument else [])
    result = h.run(*args, script=script)
    assert "already runs that image" in result.stdout
    # A plain repair run: verify the certificate and the model, leave the identical running container alone.
    assert h.kinds() == ["show", "fetch-model"]
    assert not {"pull", "rm", "start", "restart"} & set(h.verbs())
    assert json.dumps(h.container_state(), sort_keys=True) == state_before
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE


def test_a_plain_run_with_a_newer_stamped_default_keeps_the_recorded_image_and_says_how_to_move(h, tmp_path):
    _first_run(h)
    stamped = _stamped_copy(tmp_path, cuda=IMAGE2, rocm=ROCM_IMAGE)
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.forget_calls()
    result = h.run(script=stamped)
    assert h.kinds() == ["show", "fetch-model"]
    assert h.run_of("fetch-model") == h.oneshot("fetch-model", image=IMAGE)
    assert not {"pull", "rm", "start", "restart"} & set(h.verbs())
    assert json.dumps(h.container_state(), sort_keys=True) == state_before
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE
    notes = [line for line in result.stdout.splitlines() if line.startswith("NOTE: this setup file is for a newer satellite image")]
    assert len(notes) == 1
    assert IMAGE2 in notes[0] and IMAGE in notes[0]
    assert f"bash {stamped} --root {h.root} --update" in notes[0]
    # It is near the end: after the closing lines, before the log path and how to run it.
    assert result.stdout.index("Satellite address:") < result.stdout.index("NOTE: this setup file") < result.stdout.index("To run it:")


def test_a_plain_run_with_the_same_stamped_default_or_none_prints_no_newer_image_note(h, tmp_path):
    _first_run(h)
    same = _stamped_copy(tmp_path, cuda=IMAGE, rocm=ROCM_IMAGE)
    assert "newer satellite image" not in h.run(script=same).stdout
    assert "newer satellite image" not in h.run().stdout
    # An explicit --image equal to the recorded one with a different stamped default: the user chose, no note.
    other = _stamped_copy(tmp_path, cuda=IMAGE2, rocm=ROCM_IMAGE)
    assert "newer satellite image" not in h.run("--image", IMAGE, script=other).stdout


def test_a_plain_run_with_a_different_explicit_image_is_still_refused(h, tmp_path):
    _first_run(h)
    stamped = _stamped_copy(tmp_path, cuda=IMAGE2, rocm=ROCM_IMAGE)
    result = h.run("--image", IMAGE3, script=stamped, expected=1)
    assert "needs --update" in result.stderr


# ----- A folder whose setup never finished adopts another --image on a plain run (October 11, 2026) -----

ADOPTED_LINE = "This satellite was never finished; using the image this setup carries."


def test_a_finished_folder_still_refuses_a_different_image_and_names_update(h):
    _first_run(h)
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    h.forget_calls()
    result = h.run("--image", IMAGE2, expected=1)
    assert "needs --update (recorded: " + IMAGE + ")" in result.stderr
    assert ADOPTED_LINE not in result.stdout + result.stderr
    assert h.runs() == [] and (h.root / "satellite.env").read_text(encoding="utf-8") == env_before


def test_an_unfinished_folder_with_the_secret_still_needed_adopts_a_different_image(h):
    _first_run(h)
    (h.root / "secrets" / "vocalis-satellite-master").unlink()
    h.forget_calls()
    result = h.run("--image", IMAGE2, "--secret-file", h.secret_file)
    assert result.stdout.splitlines().count(ADOPTED_LINE) == 1, result.stdout
    # Recorded in satellite.env, then every Docker call of the resumed first setup uses the adopted image.
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2
    assert [argv for argv in h.argvs() if argv[0] == "pull"] == [["pull", IMAGE2]]
    assert h.run_of("check-gpu") == h.oneshot("check-gpu", image=IMAGE2)
    assert h.run_of("fetch-model") == h.oneshot("fetch-model", image=IMAGE2)
    assert h.run_of("long") == h.long_lived(image=IMAGE2)
    assert (h.root / "secrets" / "vocalis-satellite-master").is_file()
    # It is the resumed first setup: a secret was made, and the closing lines are the first setup's.
    values = h.result()
    assert (values["MODE"], values["MADE_SECRET"]) == ("first", "yes")
    assert FIRST_SETUP_TEXT in result.stdout
    # The adoption and the image are in the log (a decision logged with its values); the secret is in neither place.
    log = h.log_text()
    assert "Adopting image " + IMAGE2 in log and "in place of the recorded " + IMAGE in log
    assert SECRET not in result.stdout + result.stderr + log


def test_an_unfinished_folder_with_the_secret_present_adopts_a_different_image(h):
    # Only the configuration file is missing (the run died between the secret and the configuration).
    _first_run(h)
    (h.root / "data" / "satellite.yaml").unlink()
    h.forget_calls()
    result = h.run("--image", IMAGE2)
    assert result.stdout.splitlines().count(ADOPTED_LINE) == 1, result.stdout
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2
    assert [argv for argv in h.argvs() if argv[0] == "pull"] == [["pull", IMAGE2]]
    assert h.run_of("fetch-model") == h.oneshot("fetch-model", image=IMAGE2)
    assert h.run_of("long") == h.long_lived(image=IMAGE2)
    # MODE keeps the design's wording (script change 4: first is "a secret or certificate still to be made"). Both exist
    # here and may long since be in Vocalis, so the run is a rerun with the hedged closing text, as in the Windows script;
    # the folder still counts as never finished for the adoption above.
    values = h.result()
    assert (values["MODE"], values["VOCALIS_STEPS"], values["MADE_SECRET"], values["MADE_CERTIFICATE"]) == ("rerun", "maybe", "no", "no")
    assert PLAIN_RUN_TEXT in result.stdout and FIRST_SETUP_TEXT not in result.stdout


@pytest.mark.parametrize("missing", ["secrets/vocalis-satellite-master", "data/certs/cert.pem", "data/certs/key.pem", "data/satellite.yaml"])
def test_adoption_happens_for_each_missing_file_and_a_second_run_is_then_plain(h, missing):
    _first_run(h)
    (h.root / missing).unlink()
    if missing.startswith("data/certs/"):
        (h.root / "data" / "certs" / ("key.pem" if missing.endswith("cert.pem") else "cert.pem")).unlink()  # a broken pair is refused, not recreated
    h.secret_file.write_text(SECRET + "\n", encoding="utf-8")
    first = h.run("--image", IMAGE2, "--secret-file", h.secret_file)
    assert ADOPTED_LINE in first.stdout and h.env_file()["SATELLITE_IMAGE"] == IMAGE2
    # Now finished and recorded: the same command is a plain rerun with no adoption line.
    h.forget_calls()
    second = h.run("--image", IMAGE2)
    assert ADOPTED_LINE not in second.stdout and h.env_file()["SATELLITE_IMAGE"] == IMAGE2


def test_an_unfinished_folder_given_its_own_image_prints_no_adoption_line(h):
    _first_run(h)
    (h.root / "data" / "satellite.yaml").unlink()
    result = h.run("--image", IMAGE)
    assert ADOPTED_LINE not in result.stdout and h.env_file()["SATELLITE_IMAGE"] == IMAGE


def test_an_unfinished_folder_without_image_adopts_the_stamped_default_instead_of_the_update_note(h, tmp_path):
    _first_run(h)
    (h.root / "data" / "satellite.yaml").unlink()
    stamped = _stamped_copy(tmp_path, cuda=IMAGE2, rocm=ROCM_IMAGE)
    h.forget_calls()
    result = h.run(script=stamped)
    assert result.stdout.splitlines().count(ADOPTED_LINE) == 1, result.stdout
    assert "newer satellite image" not in result.stdout and "--update" not in result.stdout.replace("--update-", "")
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2
    assert [argv for argv in h.argvs() if argv[0] == "pull"] == [["pull", IMAGE2]]
    assert h.run_of("check-gpu") == h.oneshot("check-gpu", image=IMAGE2)
    assert h.run_of("fetch-model") == h.oneshot("fetch-model", image=IMAGE2)
    assert h.run_of("long") == h.long_lived(image=IMAGE2)
    assert h.result()["MODE"] == "rerun"  # only the configuration file was missing: no secret or certificate to make
    assert "Adopting the stamped default image " + IMAGE2 in h.log_text()


def test_a_finished_folder_without_image_keeps_the_newer_image_note_and_adopts_nothing(h, tmp_path):
    _first_run(h)
    stamped = _stamped_copy(tmp_path, cuda=IMAGE2, rocm=ROCM_IMAGE)
    h.forget_calls()
    result = h.run(script=stamped)
    assert ADOPTED_LINE not in result.stdout
    assert "NOTE: this setup file is for a newer satellite image" in result.stdout
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE and "pull" not in h.verbs()


@pytest.mark.parametrize("missing", ["secrets/vocalis-satellite-master", "data/certs/cert.pem", "data/satellite.yaml"])
def test_update_on_an_unfinished_folder_is_still_refused_and_adopts_nothing(h, missing):
    _first_run(h)
    (h.root / missing).unlink()
    if missing == "data/certs/cert.pem":
        (h.root / "data" / "certs" / "key.pem").unlink()
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    h.forget_calls()
    result = h.run("--update", "--image", IMAGE2, expected=1)
    assert "incomplete" in result.stderr and "Finish setup first" in result.stderr
    assert ADOPTED_LINE not in result.stdout + result.stderr
    assert "pull" not in h.verbs() and h.runs() == []
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == env_before


def test_the_update_line_is_short_with_a_stamped_default_and_long_without(h, tmp_path):
    # The update command left the closing lines on October 11, 2026; it is in the setup log of every run.
    result = _first_run(h)
    assert "To update it:" not in result.stdout
    line = [item for item in h.log_text().splitlines() if item.startswith("To update it:")][0]
    assert "--update --image NAME@sha256:<64 hex digits>" in line
    stamped = _stamped_copy(tmp_path, cuda=IMAGE, rocm=ROCM_IMAGE)
    h.run(script=stamped)
    line = [item for item in h.log_text().splitlines() if item.startswith("To update it:")][0]
    assert f"bash {stamped} --root {h.root} --update" in line and "--image" not in line and "NAME@sha256" not in line


def test_the_help_text_describes_update_without_a_required_image(h):
    out = h.run("--help", root=False).stdout
    assert "satellite-setup.sh --update [--image REF] [--root PATH]" in out
    assert "needs --image)" not in out and "A copy that\n                      names no image needs --image." in out


def test_update_with_a_local_image_does_not_pull(h):
    _first_run(h)
    h.config(local_images=[IMAGE2])
    h.forget_calls()
    h.run("--update", "--image", IMAGE2)
    assert "pull" not in h.verbs()


# ---------------------------------------------------------------------------------------------------------------
# --new-secret, --new-certificate, --remove
# ---------------------------------------------------------------------------------------------------------------

def test_new_secret_with_a_file_replaces_the_secret_and_restarts_the_container(h):
    _first_run(h)
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    h.forget_calls()
    result = h.run("--new-secret", "--secret-file", h.secret_file)
    assert h.kinds() == ["provision", "show"]
    # The certificate is kept, so provision gets no --ip/--dns (item D); the secret is needed, so the file is mounted (E).
    assert h.run_of("provision") == h.oneshot(
        "provision", "--name", h.env_file()["SATELLITE_NAME"],
        "--secret-from-file", "--new-secret", secret_file=Path(os.path.realpath(h.secret_file)))
    verbs = h.verbs()
    assert verbs.index("run:provision") < verbs.index("restart") and "rm" not in verbs and "run:long" not in verbs
    assert "run:fetch-model" not in verbs and "run:check-gpu" not in verbs  # item C: no model fetch
    assert "logs" in verbs  # waited for the listening line after the restart
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET2
    assert "New secret..." in result.stdout
    _assert_secret_nowhere(h, result)


def test_new_secret_at_a_terminal_prompts_and_restarts(h):
    _first_run(h)
    h.config(prompt_secret=SECRET2)
    h.forget_calls()
    result = h.run("--new-secret", tty=True)
    provision = h.run_of("provision")
    assert provision == h.oneshot("provision", "--name", h.env_file()["SATELLITE_NAME"], "--new-secret", tty=True)
    assert "restart" in h.verbs() and "run:fetch-model" not in h.verbs()
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET2
    _assert_secret_nowhere(h, result)


def test_new_secret_without_a_terminal_or_file_is_refused(h):
    _first_run(h)
    h.forget_calls()
    result = h.run("--new-secret", expected=1)
    assert "no terminal" in result.stderr
    assert h.runs() == []


def test_new_certificate_replaces_the_certificate_keeps_the_secret_and_restarts(h):
    _first_run(h, "--address", "sat.lan")
    first_fingerprint = "AA:BB:01"
    h.forget_calls()
    result = h.run("--new-certificate")
    # Item F: the new certificate is made from the addresses detected now plus this run's --address values; the name
    # given on the first run is NOT carried forward (it is listed as lost instead). No secret input is needed, and no
    # model fetch happens (item C).
    assert h.run_of("provision") == h.oneshot(
        "provision", "--name", h.env_file()["SATELLITE_NAME"], "--ip", "192.168.1.50", "--ip", "10.0.0.7", "--new-certificate")
    assert h.kinds() == ["provision", "show"]
    assert "restart" in h.verbs() and "rm" not in h.verbs()
    assert "  Fingerprint:     AA:BB:02\n" in result.stdout and first_fingerprint not in result.stdout
    # The closing lines of the `upload` case (design, script change 3): "new certificate", and no tick sentence, because
    # the cards stay ticked in Vocalis. The same two lines the Windows script prints.
    closing = result.stdout[result.stdout.index("One thing left"):]
    assert closing.startswith(
        "One thing left: give Vocalis this satellite's new certificate.\n"
        f"  File to upload:  {h.root / 'data' / 'certs' / 'cert.pem'}\n"
        "  Fingerprint:     AA:BB:02\n"
        "If your browser is on another computer, copy that file there first.\n"
        'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite\'s row.\n'
        "Satellite address: https://192.168.1.50:"), closing
    assert "tick its card" not in result.stdout
    assert "One thing left: give Vocalis this satellite's certificate." not in result.stdout
    assert "Vocalis must be given the new certificate file" in result.stdout
    assert "will NOT be in the new one: sat.lan" in result.stdout
    assert '"Upload certificate..."' in result.stdout and "Load" not in result.stdout
    assert h.env_file()["CERT_FINGERPRINT"] == "AA:BB:02"
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET
    assert h.env_file()["DNS_NAMES"] == ""
    # Passing the name again keeps it, as --dns.
    again = h.run("--new-certificate", "--address", "sat.lan")
    assert "--dns" in h.runs()[-2][1] and h.env_file()["DNS_NAMES"] == "sat.lan"
    assert "will NOT be in the new one" not in again.stdout


def test_new_certificate_uses_the_addresses_of_now_not_the_old_ones(h):
    _first_run(h)
    (h.fake / "ip-route.txt").write_text("1.1.1.1 via 10.9.9.1 dev eth0 src 10.9.9.50 uid 0 \\    cache \n", encoding="utf-8")
    (h.fake / "ip-addr.txt").write_text("2: eth0    inet 10.9.9.50/24 brd 10.9.9.255 scope global eth0\\       valid_lft forever\n", encoding="utf-8")
    result = h.run("--new-certificate")
    assert h.env_file()["IP_ADDRESSES"] == "10.9.9.50"
    assert "not in the certificate" not in result.stderr
    assert f"Satellite address: https://10.9.9.50:{h.port}\n" in result.stdout and h.urls() == [f"https://10.9.9.50:{h.port}"]


def test_new_certificate_names_every_recorded_address_and_name_the_new_certificate_will_lack(h):
    _first_run(h, "--address", "192.168.1.99", "--address", "sat.lan")
    result = h.run("--new-certificate")
    # 192.168.1.99 and sat.lan were given on the first run and are neither detected now nor given again: both named.
    assert "will NOT be in the new one: 192.168.1.99 sat.lan" in result.stdout
    assert "--address 192.168.1.99" in result.stdout
    assert h.env_file()["IP_ADDRESSES"] == "10.0.0.7,192.168.1.50" and h.env_file()["DNS_NAMES"] == ""
    # Giving them again keeps them, and nothing is announced as lost.
    again = h.run("--new-certificate", "--address", "192.168.1.99", "--address", "sat.lan")
    assert "will NOT be in the new one" not in again.stdout
    assert h.env_file()["IP_ADDRESSES"] == "10.0.0.7,192.168.1.50,192.168.1.99" and h.env_file()["DNS_NAMES"] == "sat.lan"


def test_new_certificate_lists_old_detected_addresses_that_are_gone_now(h):
    _first_run(h)
    (h.fake / "ip-route.txt").write_text("1.1.1.1 via 10.9.9.1 dev eth0 src 10.9.9.50 uid 0 \\    cache \n", encoding="utf-8")
    (h.fake / "ip-addr.txt").write_text("2: eth0    inet 10.9.9.50/24 brd 10.9.9.255 scope global eth0\\       valid_lft forever\n", encoding="utf-8")
    result = h.run("--new-certificate")
    assert "will NOT be in the new one: 10.0.0.7 192.168.1.50" in result.stdout


def test_new_certificate_with_no_address_at_all_is_refused_but_a_plain_run_is_not(h):
    # Item H: "no usable address" refuses only when a certificate has to be made on this run.
    _first_run(h)
    (h.fake / "ip-addr.txt").write_text("1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever\n", encoding="utf-8")
    (h.fake / "ip-route.txt").unlink()
    h.forget_calls()
    refused = h.run("--new-certificate", expected=1)
    assert "No network address" in refused.stderr and h.runs() == []
    h.forget_calls()
    plain = h.run()  # the certificate exists: no address needed, none checked
    assert h.kinds() == ["show", "fetch-model"]
    assert "No network address of this computer was found; the existing certificate is kept" in plain.stdout
    assert "primary address" not in plain.stderr
    # No primary is known, so the certificate's own order stands (sorted numerically).
    assert f"  Satellite address: https://10.0.0.7:{h.port}\n" in plain.stdout
    assert h.urls() == [f"https://10.0.0.7:{h.port}", f"https://192.168.1.50:{h.port}"]


def test_a_missing_certificate_with_no_address_is_refused(h):
    _first_run(h)
    (h.root / "data" / "certs" / "cert.pem").unlink()
    (h.root / "data" / "certs" / "key.pem").unlink()
    (h.fake / "ip-addr.txt").write_text("1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever\n", encoding="utf-8")
    (h.fake / "ip-route.txt").unlink()
    result = h.run(expected=1)
    assert "No network address" in result.stderr


def test_after_a_restart_only_log_lines_since_the_restart_count(h):
    _first_run(h)
    # The container already logged "listening on https://" at its first start. After --new-secret restarts it, a
    # script that did not pass --since would find that OLD line at once; the stand-in honours --since, so it must not.
    h.config(wait={"listen_after": None})
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    h.forget_calls()
    result = h.run("--new-secret", "--secret-file", h.secret_file, expected=1)
    assert "within 180 seconds" in result.stderr
    logs = [argv for argv in h.argvs() if argv[0] == "logs" and "--tail" not in argv]
    assert logs and all(argv[1] == "--since" and argv[2].startswith("2026-10-10T") for argv in logs)
    (container,) = h.container_state().values()
    assert logs[0][2] == container["started_at"]  # the start time of the restart, read from Docker
    # And the same for --new-certificate.
    h.forget_calls()
    h.run("--new-certificate", expected=1)
    assert [argv for argv in h.argvs() if argv[0] == "logs" and "--tail" not in argv and "--since" in argv]


def test_the_listening_line_is_read_from_stderr_of_docker_logs(h):
    # The satellite logs to stderr and the stand-in replays it there: a script that dropped `2>&1` could not pass.
    result = _first_run(h)
    assert "The satellite is listening." in result.stdout
    logs_script = SCRIPT.read_text(encoding="utf-8")
    assert 'docker logs --since "$started" "$CONTAINER_NAME" 2>&1' in logs_script


def test_new_secret_with_a_missing_container_creates_it_instead(h):
    _first_run(h)
    state = json.loads((h.fake / "state.json").read_text(encoding="utf-8"))
    state["containers"] = {}
    (h.fake / "state.json").write_text(json.dumps(state), encoding="utf-8")
    h.forget_calls()
    h.run("--new-secret", "--secret-file", h.secret_file)
    assert h.kinds() == ["check-gpu", "provision", "show", "long"]


def test_remove_removes_the_container_only_and_says_where_the_folder_is(h):
    _first_run(h)
    sat = f"vocalis-satellite-{h.sat_id()}"
    h.forget_calls()
    result = h.run("--remove")
    assert ["rm", "-f", sat] in h.argvs()
    assert h.runs() == []
    assert h.container_state() == {}
    assert f"The satellite folder was left in place: {h.root}" in result.stdout
    assert (h.root / "secrets" / "vocalis-satellite-master").is_file() and (h.root / "satellite.env").is_file()
    # Removing again is harmless.
    again = h.run("--remove")
    assert "nothing to remove" in again.stdout
    # And the same command as before brings it back, without pairing again.
    h.forget_calls()
    h.run()
    assert h.kinds() == ["check-gpu", "show", "fetch-model", "long"]


# ---------------------------------------------------------------------------------------------------------------
# Review items D, E, I, K, P, R: provision arguments, the derived name, a restarting container, the golden vector
# ---------------------------------------------------------------------------------------------------------------

def test_provision_gets_no_addresses_when_the_certificate_is_kept_and_the_file_only_when_a_secret_is_needed(h):
    _first_run(h)
    (h.root / "secrets" / "vocalis-satellite-master").unlink()  # a secret is needed again; the certificate stays
    h.forget_calls()
    h.run("--secret-file", h.secret_file)
    assert h.run_of("provision") == h.oneshot(
        "provision", "--name", h.env_file()["SATELLITE_NAME"], "--secret-from-file",
        secret_file=Path(os.path.realpath(h.secret_file)))
    assert (h.root / "secrets" / "vocalis-satellite-master").read_text(encoding="utf-8") == SECRET


def test_a_secret_file_that_is_not_needed_is_neither_passed_nor_mounted_when_provision_runs_anyway(h):
    _first_run(h)
    (h.root / "data" / "certs" / "cert.pem").unlink()  # a certificate is needed again; the secret stays
    (h.root / "data" / "certs" / "key.pem").unlink()
    h.forget_calls()
    result = h.run("--secret-file", h.secret_file)
    assert "--secret-file was not needed" in result.stdout and "The file is not used" in result.stdout
    assert h.run_of("provision") == h.oneshot(
        "provision", "--name", h.env_file()["SATELLITE_NAME"], "--ip", "192.168.1.50", "--ip", "10.0.0.7")
    assert not any("/run/provision/secret" in item for item in h.run_of("provision"))
    assert "--secret-from-file" not in h.run_of("provision")


def test_half_a_certificate_pair_stops_with_the_tools_exit_5_and_is_never_recreated(h):
    _first_run(h)
    cert = (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8")
    (h.root / "data" / "certs" / "key.pem").unlink()
    h.forget_calls()
    result = h.run(expected=1)
    assert "exit status 5" in result.stderr and "use --new-certificate" in result.stderr  # the tool's own message
    # No --ip/--dns (a certificate is not being made), nothing started, nothing replaced.
    assert h.kinds() == ["provision"]
    assert "--ip" not in h.run_of("provision") and "--dns" not in h.run_of("provision")
    assert (h.root / "data" / "certs" / "cert.pem").read_text(encoding="utf-8") == cert
    assert not (h.root / "data" / "certs" / "key.pem").exists()
    # The user's explicit choice replaces the pair.
    h.run("--new-certificate")
    assert (h.root / "data" / "certs" / "key.pem").exists()


@pytest.mark.parametrize("uname_n,expected", [
    ("Work_Horse.Lan", "work_horse.lan"),
    ("big box", "big-box"),
    ("x" * 70, "x" * 63),
    ("-sat", "sat"),
])
def test_the_derived_default_name_is_made_valid(h, uname_n, expected):
    h.machine_name(uname_n)
    _first_run(h)
    assert h.env_file()["SATELLITE_NAME"] == expected
    h.run()  # load_env accepts what was written


@pytest.mark.parametrize("uname_n", ["___", "", "..."])
def test_a_computer_name_that_cannot_be_made_valid_is_refused_before_satellite_env_is_written(h, uname_n):
    h.machine_name(uname_n)
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "cannot be made into a valid satellite name" in result.stderr and "--name" in result.stderr
    assert not h.root.exists()
    assert h.runs() == [] and "pull" not in h.verbs()
    # --name gets around it.
    h.run("--image", IMAGE, "--secret-file", h.secret_file, "--name", "Box")
    assert h.env_file()["SATELLITE_NAME"] == "box"


def test_the_model_fetch_comment_no_longer_calls_the_check_quick():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "so this is quick" not in text
    assert "re-reads and hashes all of the model files" in text


def test_a_plain_run_on_a_restarting_container_fails_at_once_with_the_log_end_and_never_calls_start(h):
    _first_run(h)
    h.set_container(status="restarting")
    h.forget_calls()
    clock_before = h.clock()
    result = h.run(expected=1)
    # Same label, but "restarting" is a crash loop: `docker start` does nothing for it, so none is made, the end of the
    # log is printed, and the script fails at once (no 180-second wait).
    assert "restarting over and over (a crash loop)" in result.stderr and "LOG-TAIL-LINE" in result.stderr
    assert "The satellite keeps crashing" in result.stderr and "--new-secret" in result.stderr
    verbs = h.verbs()
    assert "start" not in verbs and "restart" not in verbs and "rm" not in verbs and "run:long" not in verbs
    assert h.clock() == clock_before  # no pause: nothing waited
    assert "left as it is" not in result.stdout and "The satellite is listening." not in result.stdout
    assert [argv for argv in h.argvs() if argv[0] == "logs" and "--since" in argv] == []


@pytest.mark.parametrize("option", ["--new-secret", "--new-certificate"])
def test_replacing_the_secret_or_certificate_restarts_a_crash_looping_container_and_waits(h, option):
    _first_run(h)
    h.set_container(status="restarting")
    h.forget_calls()
    extra = ["--secret-file", h.secret_file] if option == "--new-secret" else []
    result = h.run(option, *extra)
    verbs = h.verbs()
    assert "restart" in verbs and "start" not in verbs and "logs" in verbs
    assert "The satellite is listening." in result.stdout and "crash loop" not in result.stderr
    (container,) = h.container_state().values()
    assert container["status"] == "running"
    # If the new start crashes again, the wait stops early with the log tail.
    h.set_container(status="restarting")
    h.config(wait={"restart_after": 1})
    crashed = h.run(option, *extra, expected=1)
    assert "stopped or restarted before it reported" in crashed.stderr and "LOG-TAIL-LINE" in crashed.stderr


def test_the_wait_checks_the_state_before_the_log_on_every_round(h):
    # The container logged "listening on https://" and then died at once: the line is in the log, but it is not
    # running. Reading the log first would call that success.
    h.config(wait={"die_after_listening": True})
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert "stopped or restarted before it reported" in result.stderr
    assert "The satellite is listening." not in result.stdout
    assert [argv for argv in h.argvs() if argv[0] == "logs" and "--since" in argv] == []  # never even read the log


GOLDEN_TOKENS = (
    "--name vocalis-satellite-vs-0123456789ab --restart unless-stopped --read-only --user 1000:1000 "
    "--tmpfs /tmp:rw,noexec,nosuid,size=512m --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 "
    "--label vocalis.satellite.id=vs-0123456789ab --publish 0.0.0.0:7880:7880 "
    "--mount type=bind,source=/srv/vocalis-satellite/data,target=/data/vocalis-satellite,readonly "
    "--mount type=bind,source=/srv/vocalis-satellite/secrets,target=/run/secrets,readonly "
    "--mount type=bind,source=/srv/vocalis-satellite/logs,target=/logs/vocalis-satellite "
    "--mount type=bind,source=/srv/vocalis-satellite/work,target=/work/vocalis-satellite "
    "--mount type=bind,source=/srv/vocalis-satellite/cache,target=/cache/vocalis "
    "--mount type=bind,source=/srv/vocalis-satellite/models,target=/models/vocalis,readonly "
    "--gpus all registry.example/vocalis-satellite-cuda@sha256:" + "a" * 64
).split(" ")
GOLDEN_HASH = "de519f8d426f98c35fb06625ee55e0d20f723be38e76b704303149824934cc7d"


def test_the_golden_vector_hash_matches_the_test_helper(h):
    # The vector shared with the Windows tests: 34 tokens, each flag and value separate, joined by LF, UTF-8, no
    # trailing newline.
    assert len(GOLDEN_TOKENS) == 34
    assert hashlib.sha256("\n".join(GOLDEN_TOKENS).encode("utf-8")).hexdigest() == GOLDEN_HASH
    argv = h.long_lived(image=IMAGE, port=7880, sat_id="vs-0123456789ab", root=Path("/srv/vocalis-satellite"), user="1000:1000")
    label = [item for item in argv if item.startswith("vocalis.satellite.spec=")][0]
    assert label == "vocalis.satellite.spec=" + GOLDEN_HASH
    index = argv.index(label)
    assert argv[2:index - 1] + argv[index + 1:] == GOLDEN_TOKENS


def test_the_golden_vector_hash_is_what_the_script_puts_in_the_label(h):
    """Runs the script itself as user 1000 on /srv/vocalis-satellite with the golden ID, port and image, so its label
    must be the shared hash. Needs root (to become user 1000 and to make /srv/vocalis-satellite) and a free port 7880."""
    if os.getuid() != 0:
        pytest.skip("becoming user 1000 and creating /srv/vocalis-satellite needs root; the contract tests run as root in their container")
    root = Path("/srv/vocalis-satellite")
    if root.exists():
        pytest.skip("/srv/vocalis-satellite already exists on this machine")
    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", 7880))
    except OSError:
        pytest.skip("something on this machine already uses port 7880")
    finally:
        probe.close()
    sandbox = Path(tempfile.mkdtemp(dir="/tmp"))
    try:
        os.chmod(sandbox, 0o755)
        sandbox_h = Harness(sandbox)
        for sub in ("data/certs", "secrets", "logs", "work", "cache", "models"):
            (root / sub).mkdir(parents=True)
        (root / "secrets" / "vocalis-satellite-master").write_text(SECRET, encoding="utf-8")
        (root / "data" / "satellite.yaml").write_text("name: golden\nhost: 0.0.0.0\nport: 7880\n", encoding="utf-8")
        (root / "data" / "certs" / "cert.pem").write_text("fingerprint=AA:BB:01\nip=192.168.1.50\n", encoding="utf-8")
        (root / "data" / "certs" / "key.pem").write_text("KEY\n", encoding="utf-8")
        (root / "satellite.env").write_text(
            "SATELLITE_ID=vs-0123456789ab\nGPU_VARIANT=cuda\nSATELLITE_ROOT='/srv/vocalis-satellite'\n"
            f"SATELLITE_IMAGE={IMAGE}\nSATELLITE_PORT=7880\nSATELLITE_NAME=golden\nSERVICE_UID=1000\nSERVICE_GID=1000\n"
            "GPU_GIDS=\nIP_ADDRESSES=192.168.1.50\nDNS_NAMES=\n", encoding="utf-8")
        for path in [root, sandbox, *root.rglob("*"), *sandbox.rglob("*")]:
            os.chown(path, 1000, 1000)
        sandbox_h.config(local_images=[IMAGE])
        result = subprocess.run(
            ["bash", str(SCRIPT), "--root", str(root)], stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=60, env=dict(sandbox_h.env, HOME=str(sandbox_h.home)), user=1000, group=1000,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        long_lived = sandbox_h.run_of("long")
        label = [item for item in long_lived if item.startswith("vocalis.satellite.spec=")][0]
        assert label == "vocalis.satellite.spec=" + GOLDEN_HASH
        index = long_lived.index(label)
        assert long_lived[2:index - 1] + long_lived[index + 1:] == GOLDEN_TOKENS
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


# ---------------------------------------------------------------------------------------------------------------
# Acceptance pass: the closing lines of a plain run, --update's port and address checks, show failing after an update
# ---------------------------------------------------------------------------------------------------------------

PLAIN_RUN_TEXT = (
    "\nIf this satellite is already set up in Vocalis, nothing more has to be done there.\n"
    "If it is not (for example an earlier run stopped part way), two steps are left in Vocalis:\n"
    "  1. Copy the certificate file named below to the computer where you use Vocalis in a browser, and choose "
    "\"Upload certificate...\" on the satellite's row. Check that the fingerprint matches.\n"
    "  2. Tick the satellite's cards in Settings. They load as soon as you tick them.\n"
)
# October 11, 2026: the first setup (and a new certificate) says one thing; the old "Two steps are left" text is gone.
# The plain-run text now names the certificate file *below* (the "for reference" lines follow it), where it said "above".
# After a new certificate the first line says "new certificate" and the tick sentence is left out (the cards stay ticked).
FIRST_SETUP_TEXT = "One thing left: give Vocalis this satellite's certificate.\n"
NEW_CERTIFICATE_TEXT = "One thing left: give Vocalis this satellite's new certificate.\n"
TICK_SENTENCE = "Then tick its card."


def test_a_plain_rerun_prints_both_cases_and_the_two_numbered_steps(h):
    first = _first_run(h)
    assert FIRST_SETUP_TEXT in first.stdout
    assert "If this satellite is already set up" not in first.stdout  # the first setup keeps its own text
    result = h.run()
    # Pinned: this exact text, in this order, right after the address lines (the Windows script prints the same).
    assert PLAIN_RUN_TEXT in result.stdout
    assert FIRST_SETUP_TEXT not in result.stdout
    # The path step 1 refers to ("named below"), and the fingerprint, as the "for reference" lines after the text.
    assert f"  Certificate file:  {h.root / 'data' / 'certs' / 'cert.pem'}\n" in result.stdout
    assert "  Fingerprint:       AA:BB:01\n" in result.stdout
    assert result.stdout.index(PLAIN_RUN_TEXT) < result.stdout.index("For reference:")


def test_a_resumed_first_run_prints_the_plain_run_text(h):
    h.config(fetch_exit=1)
    h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)  # secret and certificate written, then it stops
    assert (h.root / "secrets" / "vocalis-satellite-master").is_file() and (h.root / "data" / "certs" / "cert.pem").is_file()
    h.config(fetch_exit=0)
    h.forget_calls()
    result = h.run("--image", IMAGE)  # the same command, finishing the setup
    assert h.kinds() == ["check-gpu", "show", "fetch-model", "long"]
    assert PLAIN_RUN_TEXT in result.stdout
    assert "nothing more has to be done there" in result.stdout and "Nothing has to be done" not in result.stdout


def test_the_rerun_of_a_first_run_that_stopped_before_the_secret_prints_the_first_setup_text(h):
    # The first run stops at the secret (a bad value): no secret and no certificate exist yet, though satellite.env does.
    h.secret_file.write_text("not a secret\n", encoding="utf-8")
    h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert not (h.root / "secrets" / "vocalis-satellite-master").exists() and not (h.root / "data" / "certs" / "cert.pem").exists()
    h.secret_file.write_text(SECRET + "\n", encoding="utf-8")
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file)
    # It makes the secret and the certificate now, so it is a first setup as far as the user is concerned.
    assert FIRST_SETUP_TEXT in result.stdout
    assert "If this satellite is already set up" not in result.stdout
    # A rerun that makes neither prints the hedged text.
    again = h.run()
    assert "If this satellite is already set up in Vocalis, nothing more has to be done there." in again.stdout
    assert FIRST_SETUP_TEXT not in again.stdout


def test_a_rerun_that_makes_only_the_certificate_or_only_the_secret_prints_the_first_setup_text(h):
    _first_run(h)
    (h.root / "data" / "certs" / "cert.pem").unlink()
    (h.root / "data" / "certs" / "key.pem").unlink()
    certificate_only = h.run()
    assert FIRST_SETUP_TEXT in certificate_only.stdout
    (h.root / "secrets" / "vocalis-satellite-master").unlink()
    secret_only = h.run("--secret-file", h.secret_file)
    assert FIRST_SETUP_TEXT in secret_only.stdout


def test_a_crash_looping_container_holds_the_port_so_a_plain_run_gets_the_crash_loop_message(h):
    _first_run(h)
    h.set_container(status="restarting")
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", h.port))  # something holds the port between the crashes, as the real container would
    listener.listen(1)
    try:
        h.forget_calls()
        result = h.run(expected=1)
    finally:
        listener.close()
    assert "restarting over and over (a crash loop)" in result.stderr
    assert "is already in use" not in result.stderr
    assert "start" not in h.verbs()
    # Stopped (not restarting) with the same holder is still a port refusal.
    h.set_container(status="exited")
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", h.port))
    listener.listen(1)
    try:
        refused = h.run(expected=1)
    finally:
        listener.close()
    assert f"Port {h.port} is already in use" in refused.stderr


def test_the_other_kinds_of_run_keep_their_own_closing_texts(h):
    _first_run(h)
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    for arguments in (["--new-secret", "--secret-file", h.secret_file], ["--new-certificate"], ["--update", "--image", IMAGE2]):
        result = h.run(*arguments)
        assert "If this satellite is already set up" not in result.stdout, arguments
        assert "Two steps are left in Vocalis" not in result.stdout, arguments
        # Only a new certificate has something to upload, and it says "new certificate" with no tick sentence (the cards
        # stay ticked); a new secret and an update have nothing to upload. None of them prints the first-setup block.
        assert (NEW_CERTIFICATE_TEXT in result.stdout) == (arguments[0] == "--new-certificate"), arguments
        assert FIRST_SETUP_TEXT not in result.stdout and TICK_SENTENCE not in result.stdout, arguments


def test_a_new_secret_on_a_satellite_that_has_no_certificate_yet_is_a_first_setup_for_vocalis(h):
    # The run was asked for a new secret only, but it also makes the certificate that was missing (a satellite whose
    # setup never finished). Nothing can have been uploaded yet, so the closing lines and the result file are the
    # first setup's (upload, then tick), as the Windows script has it; MODE stays renew.
    _first_run(h)
    (h.root / "data" / "certs" / "cert.pem").unlink()
    (h.root / "data" / "certs" / "key.pem").unlink()
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    result = h.run("--new-secret", "--secret-file", h.secret_file)
    assert FIRST_SETUP_TEXT in result.stdout and TICK_SENTENCE in result.stdout
    assert "nothing else has to change there" not in result.stdout
    values = h.result()
    assert (values["MODE"], values["VOCALIS_STEPS"], values["MADE_SECRET"], values["MADE_CERTIFICATE"]) == (
        "renew", "upload-and-tick", "yes", "yes")


def test_update_refuses_when_something_else_holds_the_port_before_pulling_anything(h):
    _first_run(h)
    h.set_container(status="exited")
    env_before = (h.root / "satellite.env").read_text(encoding="utf-8")
    state_before = json.dumps(h.container_state(), sort_keys=True)
    h.forget_calls()
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", h.port))
    listener.listen(1)
    try:
        result = h.run("--update", "--image", IMAGE2, expected=1)
    finally:
        listener.close()
    assert f"Port {h.port} is already in use" in result.stderr
    assert "the holder is not this satellite" in result.stderr and "The port is fixed" in result.stderr
    assert "pull" not in h.verbs() and h.runs() == []
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == env_before
    assert json.dumps(h.container_state(), sort_keys=True) == state_before


def test_update_with_the_satellite_itself_holding_the_port_goes_ahead(h):
    _first_run(h)  # the container runs; a listener plays the real container holding the port
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", h.port))
    listener.listen(1)
    try:
        h.run("--update", "--image", IMAGE2)
    finally:
        listener.close()
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2


def test_update_warns_when_the_current_address_is_not_in_the_certificate(h):
    _first_run(h)
    (h.fake / "ip-route.txt").write_text("1.1.1.1 via 10.9.9.1 dev eth0 src 10.9.9.50 uid 0 \\    cache \n", encoding="utf-8")
    (h.fake / "ip-addr.txt").write_text("2: eth0    inet 10.9.9.50/24 brd 10.9.9.255 scope global eth0\\       valid_lft forever\n", encoding="utf-8")
    result = h.run("--update", "--image", IMAGE2)
    assert "primary address 10.9.9.50 is not in the certificate" in result.stderr and "--new-certificate" in result.stderr
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2  # a warning only: the update still happens
    # Without any address at all the update is not refused and nothing is warned about.
    (h.fake / "ip-addr.txt").write_text("1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever\n", encoding="utf-8")
    (h.fake / "ip-route.txt").unlink()
    none = h.run("--update", "--image", IMAGE)
    assert "is not in the certificate" not in none.stderr and h.env_file()["SATELLITE_IMAGE"] == IMAGE


def test_update_without_an_address_change_prints_no_address_warning(h):
    _first_run(h)
    result = h.run("--update", "--image", IMAGE2)
    assert "is not in the certificate" not in result.stderr


def test_a_failed_show_after_an_update_says_the_satellite_was_updated_and_is_running(h):
    _first_run(h)
    h.config(show_exit=5)
    result = h.run("--update", "--image", IMAGE2, expected=1)
    assert f"The satellite was updated to {IMAGE2} and is running" in result.stderr
    assert "only the closing summary could not be read" in result.stderr and "Run the setup command again" in result.stderr
    assert "Nothing was changed" not in result.stderr
    # And that is true: the image is recorded and the container was recreated.
    assert h.env_file()["SATELLITE_IMAGE"] == IMAGE2
    (container,) = h.container_state().values()
    assert container["args"][-1] == IMAGE2 and container["status"] == "running"


def test_a_failed_show_on_a_plain_run_says_the_container_was_not_touched(h):
    _first_run(h)
    h.config(show_exit=5)
    h.forget_calls()
    result = h.run(expected=1)
    assert "The satellite container was not touched" in result.stderr and "Nothing was changed" not in result.stderr
    assert not {"rm", "start", "restart"} & set(h.verbs())


# ---------------------------------------------------------------------------------------------------------------
# October 11, 2026 (design section 9, "Satellite setup program and tray icon for Windows, and quieter setup output"):
# quiet output and --verbose, the setup log, setup-result.txt, --autostart, the recorded fingerprint, --show-plan
# ---------------------------------------------------------------------------------------------------------------

# A line of the in-image tool's raw output (what quiet output no longer echoes).
RAW_TOOL_LINE = re.compile(r"^(secret|certificate|fingerprint|ip|dns|card)=", re.MULTILINE)
RESULT_KEYS = ["SCHEMA", "FINISHED", "MODE", "EXIT_CODE", "FAILURE", "SATELLITE_ID", "NAME", "PORT", "IMAGE", "CONTAINER",
               "RUNNING", "AUTOSTART", "URLS", "CERTIFICATE_FILE", "FINGERPRINT", "MADE_SECRET", "MADE_CERTIFICATE",
               "VOCALIS_STEPS", "LOG_FILE"]
ROOT_WARNING = "WARNING: you are running as root"


def _other_stderr(result):
    """Standard error without the root warning (the contract tests run as root in their container)."""
    return [line for line in result.stderr.splitlines() if not line.startswith(ROOT_WARNING)]


def _run_with_terminal_output(h, *args):
    """Runs the script with standard output on a pseudo-terminal (so `[[ -t 1 ]]` holds); returns (screen, stderr, code)."""
    master, slave = pty.openpty()
    command = ["bash", str(SCRIPT), "--root", str(h.root), *[str(item) for item in args], "--port", str(h.port)]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE, text=True, env=h.env)
    os.close(slave)
    chunks = []
    try:
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:  # EIO: the other end is closed
                break
            if not data:
                break
            chunks.append(data)
        _, error = process.communicate(timeout=60)
    finally:
        os.close(master)
    return b"".join(chunks).decode("utf-8", "replace").replace("\r\n", "\n"), error, process.returncode


# ----- quiet output -----

def test_a_quiet_first_run_shows_the_step_headers_and_a_line_or_two_per_step(h):
    result = _first_run(h)
    out = result.stdout
    assert out.startswith("Vocalis satellite setup for Linux\n")
    headers = re.findall(r"^\[(\d)/8\] (.*)$", out, re.MULTILINE)
    assert [number for number, _ in headers] == list("12345678")
    assert [title.split(" (")[0] for _, title in headers] == [
        "Checks", "Image", "GPU", "Addresses", "Secret and certificate", "Model", "Start", "Done"]
    # What stays on screen, by step. A line that survives keeps its present wording.
    assert f"Created satellite {h.sat_id()} in {h.root} (cuda, port {h.port})." in out
    assert "GPU card 0: Fake RTX 4090" in out
    assert "Addresses of this computer: 192.168.1.50 10.0.0.7 (primary: 192.168.1.50)" in out
    assert "Secret: saved." in out and "Certificate: made. It covers: 192.168.1.50 10.0.0.7" in out
    assert "fetch-model: progress 100%" in out  # the model download keeps its one line per file
    assert "Model files: every file is present and verified." in out
    assert "The satellite is listening." in out
    # What no longer does.
    assert not RAW_TOOL_LINE.search(out), out
    assert "INFO" not in out and "INFO" not in result.stderr
    assert "Recorded in" not in out and "left out" not in out.lower()
    assert _other_stderr(result) == []


def test_verbose_output_shows_the_tools_info_lines_and_its_raw_lines(h):
    result = _first_run(h, "--verbose")
    assert "INFO: check-gpu: listed the cards" in result.stderr
    assert "INFO: provision: wrote the configuration" in result.stderr
    assert "INFO: show: read the certificate" in result.stderr
    assert "INFO: fetch-model: verifying files" in result.stderr
    assert "fingerprint=AA:BB:01" in result.stdout and "certificate=created" in result.stdout
    assert re.search(r"^\[8/8\] Done$", result.stdout, re.MULTILINE)  # the headers are not a verbose thing


def test_the_help_text_describes_the_new_options_and_the_command(h):
    out = h.run("--help", root=False).stdout
    for fragment in ("--autostart on|off", "--verbose", "--show-plan", "setup-result.txt", "logs/setup-<UTC date and time>-<process id>.log",
                     "vocalis-satellite start | stop | restart | status", "vocalis-satellite logs [-n N] [--no-follow]",
                     "vocalis-satellite certificate [--pem]", "also not restarted if it crashes", "DOCKER-USER",
                     "<folder>/satellite-setup.sh", "never edits PATH"):
        assert fragment in out, fragment
    assert h.calls() == []


def test_every_kind_of_quiet_run_hides_the_tools_lines_and_the_recorded_lines(h):
    _first_run(h)
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    for arguments in ([], ["--new-secret", "--secret-file", h.secret_file], ["--new-certificate"], ["--update", "--image", IMAGE2],
                      ["--autostart", "off"], ["--remove"]):
        result = h.run(*arguments, auto_port=False)
        label = " ".join(str(item) for item in arguments) or "(plain run)"
        assert not RAW_TOOL_LINE.search(result.stdout), label
        assert "INFO" not in result.stdout + result.stderr, label
        assert "Recorded in" not in result.stdout and "left out" not in result.stdout.lower(), label
        assert _other_stderr(result) == [], label


def test_a_remove_is_two_steps_and_a_quiet_one(h):
    _first_run(h)
    result = h.run("--remove")
    assert re.findall(r"^\[(\d/\d)\] ", result.stdout, re.MULTILINE) == ["1/2", "2/2"]
    assert "INFO" not in result.stderr and not RAW_TOOL_LINE.search(result.stdout)


def test_the_two_small_operations_name_the_satellite_and_its_folder_under_the_checks_header(h):
    # Live test, October 11, 2026: "[1/2] Checks" had nothing under it. The line is the same sentence as in
    # satellite-setup.ps1: "Satellite <id> in <folder>."
    _first_run(h)
    line = f"Satellite {h.sat_id()} in {h.root}."
    for arguments in (["--autostart", "off"], ["--remove"]):
        result = h.run(*arguments, auto_port=False)
        lines = result.stdout.splitlines()
        checks = [number for number, text in enumerate(lines) if text.startswith("[1/2] Checks")]
        assert len(checks) == 1, (arguments, lines)
        assert lines[checks[0] + 1] == line, (arguments, lines[checks[0]:checks[0] + 3])
        assert lines[checks[0] + 2].startswith("[2/2] ") or lines[checks[0] + 2] == "", (arguments, lines[checks[0]:checks[0] + 4])
        assert result.stdout.count(line) == 1, arguments


# ----- the per-call table: what the screen and the log get -----

def test_the_pull_without_a_terminal_is_read_line_by_line_and_every_line_is_logged(h):
    result = _first_run(h)
    assert f"pulled {IMAGE}" in result.stdout
    assert f"pulled {IMAGE}" in h.log_text()


def test_the_pull_on_a_terminal_is_shown_directly_and_only_its_exit_status_is_logged(h):
    screen, error, code = _run_with_terminal_output(h, "--image", IMAGE, "--secret-file", h.secret_file)
    assert code == 0, screen + error
    assert f"pulled {IMAGE}" in screen  # Docker's own output, straight to the terminal
    log = h.log_text()
    assert f"pulled {IMAGE}" not in log
    assert f"Ran: docker pull {IMAGE}  (exit status 0" in log


def test_the_typed_secret_provision_call_keeps_the_terminal_and_logs_only_its_exit_status(h):
    h.config(prompt_secret=SECRET)
    result = h.run("--image", IMAGE, tty=True)
    # The one stated exception to "quiet": the tool's INFO lines show, because the hidden prompt needs the terminal.
    assert "INFO: provision: wrote the configuration" in result.stderr
    log = h.log_text()
    assert "INFO: provision" not in log and "secret=written" not in log
    assert "provision" in log and "(exit status 0; the container kept the terminal for the secret prompt" in log
    assert SECRET not in log + result.stdout + result.stderr


def test_the_other_captured_calls_log_every_line_and_show_only_the_kept_ones(h):
    result = _first_run(h)
    log = h.log_text()
    for fragment in ("stderr: INFO: check-gpu: listed the cards", "stdout: card=0\tFake RTX 4090", "stdout: secret=written",
                     "stdout: fingerprint=AA:BB:01", "stdout: ip=127.0.0.1", "stdout: ip=::1", "stdout: dns=localhost",
                     "stderr: INFO: provision:", "stderr: INFO: show:", "stderr: INFO: fetch-model: verifying files"):
        assert fragment in log, fragment
    assert "stdout: c0ffee00c0ffee00" in log  # the container id `docker run -d` printed
    for hidden in ("c0ffee00c0ffee00", "ip=::1", "secret=written"):
        assert hidden not in result.stdout + result.stderr


def test_the_model_fetch_shows_its_output_and_keeps_its_standard_error_for_the_log(h):
    result = _first_run(h)
    assert "verifying files" not in result.stdout + result.stderr
    assert "INFO: fetch-model: verifying files" in h.log_text()
    # When the download fails, its standard error is the reason, so that is shown.
    h.config(fetch_exit=1)
    failed = h.run(expected=1)
    assert "ERROR: fetch-model: scripted failure (disk full)" in failed.stderr
    assert "INFO: fetch-model" not in failed.stderr


# ----- the log -----

def test_the_log_is_named_with_the_time_and_the_process_id_and_holds_everything_but_the_secret(h):
    result = _first_run(h)
    path = Path(h.result()["LOG_FILE"])
    assert path.parent == h.root / "logs" and re.fullmatch(r"setup-\d{8}-\d{6}-\d+\.log", path.name)
    text = path.read_text(encoding="utf-8")
    assert text.startswith("Vocalis satellite setup log\n")
    # Everything on the screen is in it (the step headers, the closing lines), besides the hidden lines.
    for line in result.stdout.splitlines():
        if line.strip() and not line.startswith("Log of this run:"):
            assert line in text, line
    assert SECRET not in text and SECRET not in (h.root / "setup-result.txt").read_text(encoding="utf-8")
    # The log path is printed once, at the end, just before how to run it.
    assert result.stdout.count(str(path)) == 1
    assert result.stdout.index(f"Log of this run: {path}") < result.stdout.index("To run it:")


def test_a_failure_message_ends_with_the_log_path_but_a_refusal_before_the_folder_is_accepted_names_none(h):
    refused = h.run("--image", IMAGE, "--secret-file", h.secret_file, "--port", 80, expected=1, auto_port=False)
    assert "Log:" not in refused.stderr and not h.root.exists()
    h.config(fetch_exit=1)
    failed = h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert failed.stderr.rstrip("\n").splitlines()[-1] == f"Log: {h.result()['LOG_FILE']}"
    assert "The model download did not finish" in failed.stderr and "ERROR:" in failed.stderr


def test_only_the_last_ten_setup_logs_are_kept(h):
    _first_run(h)
    logs = h.root / "logs"
    for index in range(12):
        (logs / f"setup-20200101-0000{index:02d}-1.log").write_text("old\n", encoding="utf-8")
    (logs / "satellite.log").write_text("the satellite's own log\n", encoding="utf-8")
    (logs / "setup-notes.txt").write_text("mine\n", encoding="utf-8")
    h.run()
    mine = sorted(path.name for path in logs.glob("setup-*.log") if re.fullmatch(r"setup-\d{8}-\d{6}-\d+\.log", path.name))
    assert len(mine) == 10
    assert Path(h.result()["LOG_FILE"]).name in mine
    assert "setup-20200101-000000-1.log" not in mine and "setup-20200101-000001-1.log" not in mine
    assert (logs / "satellite.log").is_file() and (logs / "setup-notes.txt").is_file()


def test_a_log_that_cannot_be_opened_warns_once_and_never_fails_the_run(h):
    # A `date` that puts the log in a folder that does not exist (the contract tests run as root, so permissions cannot
    # make a folder unwritable).
    real_date = shutil.which("date")
    tool = h.bin / "date"
    tool.write_text(
        '#!/bin/sh\n'
        'if [ "$1" = "+%s" ]; then cat "$FAKE_DIR/clock";\n'
        'elif [ "$1" = "-u" ] && [ "$2" = "+%Y%m%d-%H%M%S" ]; then echo "no-such-folder/stamp";\n'
        f'else exec {real_date} "$@"; fi\n', encoding="utf-8")
    tool.chmod(0o755)
    result = _first_run(h)
    assert result.stderr.count("WARNING: the setup log") == 1
    assert "Log of this run" not in result.stdout
    assert h.result()["LOG_FILE"] == "" and h.result()["EXIT_CODE"] == "0"
    assert "The satellite is listening." in result.stdout


def _tree(root):
    return {str(path.relative_to(root)): (path.read_bytes() if path.is_file() else None) for path in sorted(root.rglob("*"))}


def test_a_refused_folder_gets_no_log_and_no_result(h, tmp_path):
    # Not empty and not a satellite folder.
    h.root.mkdir()
    (h.root / "precious.txt").write_text("keep me", encoding="utf-8")
    h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert sorted(path.name for path in h.root.iterdir()) == ["precious.txt"]
    # Unreadable settings, a folder that was moved or copied, another user's folder: the earlier log and result stay as
    # they were and nothing is added.
    shutil.rmtree(h.root)
    _first_run(h)
    assert (h.root / "setup-result.txt").is_file() and list((h.root / "logs").glob("setup-*.log"))
    path = h.root / "satellite.env"
    good = path.read_text(encoding="utf-8")
    path.write_text(good + "FUTURE_KEY=keep me\n", encoding="utf-8")
    damaged = _tree(h.root)
    h.run(expected=1)
    assert _tree(h.root) == damaged
    path.write_text(good, encoding="utf-8")
    moved = tmp_path / "moved"
    shutil.copytree(h.root, moved)
    copied = _tree(moved)
    h.run("--root", moved, root=False, expected=1)
    assert _tree(moved) == copied
    path.write_text(re.sub(r"SERVICE_UID=\d+", "SERVICE_UID=4242", good), encoding="utf-8")
    foreign = _tree(h.root)
    h.run(expected=1)
    assert _tree(h.root) == foreign


# ----- the closing lines, per mode -----

def test_the_closing_lines_of_every_kind_of_run_end_with_how_to_run_it(h):
    _first_run(h)
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    for arguments in ([], ["--new-secret", "--secret-file", h.secret_file], ["--new-certificate"], ["--update", "--image", IMAGE2],
                      ["--autostart", "off"]):
        result = h.run(*arguments, auto_port=False)
        last = result.stdout.rstrip("\n").splitlines()[-1]
        assert last.startswith("To run it: "), (arguments, last)
        assert f"Log of this run: {h.result()['LOG_FILE']}" in result.stdout
    removed = h.run("--remove")
    assert removed.stdout.rstrip("\n").splitlines()[-1] == f"To bring the satellite back (nothing has to be paired again): bash {h.root}/satellite-setup.sh"


def test_a_new_secret_says_nothing_else_has_to_change_and_gives_the_file_for_reference(h):
    _first_run(h)
    result = h.run("--new-secret", "--secret-file", h.secret_file)
    assert "Vocalis now has the new secret; nothing else has to change there." in result.stdout
    assert FIRST_SETUP_TEXT not in result.stdout and "\nFor reference:\n" in result.stdout
    assert f"  Certificate file:  {h.root / 'data' / 'certs' / 'cert.pem'}\n" in result.stdout


def test_an_update_gives_the_file_and_address_for_reference_after_its_sentence(h):
    _first_run(h)
    result = h.run("--update", "--image", IMAGE2)
    out = result.stdout
    assert out.index("It keeps its secret and certificate, so nothing has to be paired again in Vocalis.") < out.index("For reference:")
    assert f"  Satellite address: https://192.168.1.50:{h.port}\n" in out
    assert "Satellite " in out and "is running." in out


# ----- setup-result.txt -----

def _result_lines(h):
    return (h.root / "setup-result.txt").read_bytes().decode("utf-8").splitlines()


def test_the_result_file_has_exactly_the_keys_in_order_and_no_byte_order_mark(h):
    _first_run(h)
    raw = (h.root / "setup-result.txt").read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r" not in raw
    assert [line.partition("=")[0] for line in raw.decode("utf-8").splitlines()] == RESULT_KEYS
    assert not list(h.root.glob(".setup-result.txt.tmp.*"))
    values = h.result()
    assert values["SCHEMA"] == "1" and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", values["FINISHED"])
    assert SECRET not in raw.decode("utf-8")


def test_the_result_of_a_first_setup(h):
    _first_run(h, "--name", "Workhorse")
    values = h.result()
    sat = h.sat_id()
    assert values["MODE"] == "first" and values["EXIT_CODE"] == "0" and values["FAILURE"] == ""
    assert values["SATELLITE_ID"] == sat and values["NAME"] == "workhorse" and values["PORT"] == str(h.port)
    assert values["IMAGE"] == IMAGE and values["CONTAINER"] == f"vocalis-satellite-{sat}"
    assert values["RUNNING"] == "yes" and values["AUTOSTART"] == "on"
    assert values["URLS"] == f"https://192.168.1.50:{h.port},https://10.0.0.7:{h.port}"
    assert values["CERTIFICATE_FILE"] == str(h.root / "data" / "certs" / "cert.pem") and values["FINGERPRINT"] == "AA:BB:01"
    assert values["MADE_SECRET"] == "yes" and values["MADE_CERTIFICATE"] == "yes"
    assert values["VOCALIS_STEPS"] == "upload-and-tick"
    assert values["LOG_FILE"].startswith(str(h.root / "logs" / "setup-"))


RESULT_ROWS = [
    # (arguments, MODE, VOCALIS_STEPS, MADE_SECRET, MADE_CERTIFICATE, RUNNING)
    (["--new-certificate"], "renew", "upload", "no", "yes", "yes"),
    (["--new-certificate", "--new-secret", "--secret-file", "SECRET_FILE"], "renew", "upload", "yes", "yes", "yes"),
    (["--new-secret", "--secret-file", "SECRET_FILE"], "renew", "none", "yes", "no", "yes"),
    (["--update", "--image", IMAGE2], "update", "none", "no", "no", "yes"),
    ([], "rerun", "maybe", "no", "no", "yes"),
    (["--autostart", "off"], "autostart", "none", "no", "no", "yes"),
]


@pytest.mark.parametrize("arguments,mode,steps,made_secret,made_certificate,running", RESULT_ROWS)
def test_the_result_of_each_kind_of_later_run(h, arguments, mode, steps, made_secret, made_certificate, running):
    _first_run(h)
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    arguments = [str(h.secret_file) if item == "SECRET_FILE" else item for item in arguments]
    h.run(*arguments, auto_port=False)
    values = h.result()
    assert (values["MODE"], values["VOCALIS_STEPS"], values["MADE_SECRET"], values["MADE_CERTIFICATE"], values["RUNNING"]) == (
        mode, steps, made_secret, made_certificate, running)
    assert values["EXIT_CODE"] == "0" and values["FAILURE"] == ""
    # The certificate, its fingerprint and the addresses are set whenever a certificate exists.
    assert values["CERTIFICATE_FILE"] == str(h.root / "data" / "certs" / "cert.pem") and values["FINGERPRINT"].startswith("AA:BB:")
    assert values["URLS"].startswith(f"https://192.168.1.50:{h.port}")


def test_the_result_of_a_remove_and_a_stopped_satellite(h):
    _first_run(h)
    h.run("--remove")
    values = h.result()
    assert (values["MODE"], values["VOCALIS_STEPS"], values["RUNNING"], values["EXIT_CODE"]) == ("remove", "remove-row", "no", "0")
    assert values["CERTIFICATE_FILE"] == str(h.root / "data" / "certs" / "cert.pem")  # the folder is left, certificate in it
    # Autostart alone on a stopped container: RUNNING is what was inspected.
    h.run()
    h.set_container(status="exited")
    h.run("--autostart", "off", auto_port=False)
    assert h.result()["RUNNING"] == "no" and h.result()["MODE"] == "autostart" and h.result()["AUTOSTART"] == "off"


def test_mode_follows_its_precedence(h):
    _first_run(h)
    h.secret_file.write_text(SECRET2 + "\n", encoding="utf-8")
    cases = [
        (["--update", "--image", IMAGE2, "--autostart", "off"], "update"),     # the small operation only stands alone
        (["--new-secret", "--secret-file", h.secret_file, "--autostart", "on"], "renew"),
        (["--new-certificate", "--new-secret", "--secret-file", h.secret_file], "renew"),
        (["--autostart", "off"], "autostart"),
        ([], "rerun"),
    ]
    for arguments, mode in cases:
        h.run(*arguments, auto_port=False)
        assert h.result()["MODE"] == mode, arguments


def test_a_first_run_that_resumes_is_first_until_the_secret_and_certificate_exist(h):
    h.config(fetch_exit=1)
    h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    assert h.result()["MODE"] == "first"
    h.config(fetch_exit=0)
    h.run("--image", IMAGE)  # the secret and certificate exist now: this run is a plain rerun
    assert h.result()["MODE"] == "rerun" and h.result()["VOCALIS_STEPS"] == "maybe"


FAILURES = [
    # (config, arguments, a fragment of the reason, a certificate exists, RUNNING)
    ({"pull_exit": 1}, ["--image", IMAGE, "--secret-file", "SECRET_FILE"], "The image could not be pulled", False, "no"),
    ({"check_gpu_exit": 3}, ["--image", IMAGE, "--secret-file", "SECRET_FILE"], "The container found no GPU card", False, "no"),
    ({"provision_exit": 4}, ["--image", IMAGE, "--secret-file", "SECRET_FILE"], "secret was not accepted", False, "no"),
    ({"fetch_exit": 1}, ["--image", IMAGE, "--secret-file", "SECRET_FILE"], "The model download did not finish", True, "no"),
    ({"run_exit": 125}, ["--image", IMAGE, "--secret-file", "SECRET_FILE"], "Docker could not start the satellite container", True, "no"),
    ({"wait": {"listen_after": None}}, ["--image", IMAGE, "--secret-file", "SECRET_FILE"], "did not report that it was listening", True, "yes"),
]


@pytest.mark.parametrize("config,arguments,reason,has_certificate,running", FAILURES)
def test_a_failure_at_each_step_writes_a_result_that_says_so(h, config, arguments, reason, has_certificate, running):
    h.config(**config)
    arguments = [str(h.secret_file) if item == "SECRET_FILE" else item for item in arguments]
    h.run(*arguments, expected=1)
    values = h.result()
    assert values["EXIT_CODE"] == "1" and reason in values["FAILURE"] and "\n" not in values["FAILURE"]
    assert values["VOCALIS_STEPS"] == "unknown" and values["MODE"] == "first" and values["RUNNING"] == running
    assert values["SATELLITE_ID"] == h.sat_id() and values["PORT"] == str(h.port)
    if has_certificate:
        assert values["CERTIFICATE_FILE"] == str(h.root / "data" / "certs" / "cert.pem") and values["FINGERPRINT"]
        assert values["URLS"].startswith("https://")
    else:
        assert values["CERTIFICATE_FILE"] == "" and values["FINGERPRINT"] == "" and values["URLS"] == ""
    assert values["LOG_FILE"] and Path(values["LOG_FILE"]).is_file()


def test_a_failure_to_read_the_certificate_still_names_the_certificate_file(h):
    h.config(show_exit=5)
    h.run("--image", IMAGE, "--secret-file", h.secret_file, expected=1)
    values = h.result()
    assert "Reading the certificate failed" in values["FAILURE"] and values["VOCALIS_STEPS"] == "unknown"
    assert values["CERTIFICATE_FILE"] == str(h.root / "data" / "certs" / "cert.pem") and values["FINGERPRINT"] == ""
    assert values["MADE_SECRET"] == "yes" and values["MADE_CERTIFICATE"] == "yes"  # what had been made when it stopped


def test_docker_not_answering_after_the_folder_is_accepted_writes_a_failure_with_unknown_state(h):
    _first_run(h)
    h.config(docker_down=True)
    h.run(expected=1)
    values = h.result()
    assert values["RUNNING"] == "unknown" and values["VOCALIS_STEPS"] == "unknown" and "Docker is unavailable" in values["FAILURE"]
    assert values["CERTIFICATE_FILE"]  # a certificate exists at that moment


def test_the_previous_result_is_gone_as_soon_as_the_folder_is_accepted_and_a_killed_run_leaves_none(h):
    _first_run(h)
    (h.root / "setup-result.txt").write_text("SCHEMA=1\nSTALE=yes\n", encoding="utf-8")
    h.config(kill_script_on="fetch-model")
    killed = h.run(expected=-9)
    assert killed.returncode == -9
    assert not (h.root / "setup-result.txt").exists()
    assert not list(h.root.glob(".setup-result.txt.tmp.*"))
    # A run that is merely stopped by a signal it can handle still writes a failure result.
    h.config(kill_script_on=None)
    h.run()
    assert h.result()["MODE"] == "rerun" and "STALE" not in (h.root / "setup-result.txt").read_text(encoding="utf-8")


# ----- --autostart and the recorded fingerprint -----

@pytest.mark.parametrize("value,policy", [("on", "unless-stopped"), ("off", "no")])
def test_the_restart_token_carries_the_recorded_autostart_value(h, value, policy):
    _first_run(h, "--autostart", value)
    assert h.env_file()["AUTOSTART"] == value and h.result()["AUTOSTART"] == value
    argv = h.run_of("long")
    assert argv == h.long_lived(autostart=value)
    assert argv[argv.index("--restart") + 1] == policy
    (container,) = h.container_state().values()
    assert container["restart_policy"] == policy


def test_autostart_on_keeps_the_golden_vector_and_off_is_a_different_specification(h):
    # The golden vector (and its two tests above) is untouched: the default value is on. Off differs only by its token.
    on = h.long_lived(image=IMAGE, port=7880, sat_id="vs-0123456789ab", root=Path("/srv/vocalis-satellite"), user="1000:1000")
    off = h.long_lived(image=IMAGE, port=7880, sat_id="vs-0123456789ab", root=Path("/srv/vocalis-satellite"), user="1000:1000",
                       autostart="off")
    assert "vocalis.satellite.spec=" + GOLDEN_HASH in on and on[on.index("--restart") + 1] == "unless-stopped"
    assert "vocalis.satellite.spec=" + GOLDEN_HASH not in off and off[off.index("--restart") + 1] == "no"


def test_a_bad_autostart_value_is_refused(h):
    result = h.run("--image", IMAGE, "--secret-file", h.secret_file, "--autostart", "maybe", expected=1)
    assert "--autostart must be on or off" in result.stderr and not h.root.exists()
    missing = h.run("--autostart", expected=1, root=False, auto_port=False)
    assert "--autostart requires on or off" in missing.stderr


def test_autostart_alone_is_one_docker_update_and_nothing_else(h):
    _first_run(h)
    h.forget_calls()
    result = h.run("--autostart", "off", auto_port=False)
    verbs = h.verbs()
    assert verbs.count("update") == 1 and not {"pull", "rm", "start", "restart", "logs"} & set(verbs)
    assert not any(verb.startswith("run:") for verb in verbs), verbs
    assert ["update", "--restart", "no", f"vocalis-satellite-{h.sat_id()}"] in h.argvs()
    assert h.env_file()["AUTOSTART"] == "off"
    assert re.findall(r"^\[(\d/\d)\] ", result.stdout, re.MULTILINE) == ["1/2", "2/2"]
    assert "Start with Docker is now off" in result.stdout and "also not restarted if it crashes" in result.stdout
    (container,) = h.container_state().values()
    assert container["restart_policy"] == "no" and container["status"] == "running"
    # And back.
    h.forget_calls()
    h.run("--autostart", "on", auto_port=False)
    assert ["update", "--restart", "unless-stopped", f"vocalis-satellite-{h.sat_id()}"] in h.argvs()
    assert h.env_file()["AUTOSTART"] == "on"


@pytest.mark.parametrize("state", ["stopped container", "unfinished folder", "no container", "restarting container"])
def test_autostart_alone_is_the_small_operation_whatever_state_the_folder_is_in(h, state):
    _first_run(h)
    if state == "stopped container":
        h.set_container(status="exited")
    elif state == "unfinished folder":
        (h.root / "secrets" / "vocalis-satellite-master").unlink()
        (h.root / "data" / "certs" / "cert.pem").unlink()
        (h.root / "data" / "certs" / "key.pem").unlink()
    elif state == "no container":
        stored = json.loads((h.fake / "state.json").read_text(encoding="utf-8"))
        stored["containers"] = {}
        (h.fake / "state.json").write_text(json.dumps(stored), encoding="utf-8")
    else:
        h.set_container(status="restarting")
    h.forget_calls()
    # No terminal and no secret file: a resumed first setup would refuse; the small operation does not ask.
    result = h.run("--autostart", "off", auto_port=False)
    verbs = h.verbs()
    expected_updates = 0 if state == "no container" else 1
    assert verbs.count("update") == expected_updates
    assert not {"pull", "rm", "start", "restart", "logs"} & set(verbs) and not any(v.startswith("run:") for v in verbs)
    assert h.env_file()["AUTOSTART"] == "off" and h.result()["MODE"] == "autostart"
    assert "secret" not in result.stdout.lower().replace("secret and certificate", "")
    if state == "no container":
        assert "no container" in result.stdout.lower() or "There is no container" in result.stdout


def test_autostart_alone_without_docker_refuses_and_records_nothing(h):
    _first_run(h)
    before = (h.root / "satellite.env").read_text(encoding="utf-8")
    h.config(docker_down=True)
    h.forget_calls()
    result = h.run("--autostart", "off", auto_port=False, expected=1)
    assert "Docker is unavailable" in result.stderr
    assert (h.root / "satellite.env").read_text(encoding="utf-8") == before
    assert "update" not in h.verbs()


def test_a_refused_docker_update_puts_the_recorded_value_back_exactly(h):
    _first_run(h)
    # An older file (no AUTOSTART, no CERT_FINGERPRINT): a refused update must leave exactly these bytes.
    path = h.root / "satellite.env"
    older = "".join(line + "\n" for line in path.read_text(encoding="utf-8").splitlines()
                    if not line.startswith(("AUTOSTART=", "CERT_FINGERPRINT=")))
    path.write_text(older, encoding="utf-8")
    h.config(update_exit=1)
    result = h.run("--autostart", "off", auto_port=False, expected=1)
    assert path.read_text(encoding="utf-8") == older
    assert "update refused as scripted" in result.stderr and "put back to on" in result.stderr
    assert h.result()["AUTOSTART"] == "on" and "update refused as scripted" in h.result()["FAILURE"]
    assert not list(h.root.glob(".satellite.env.*"))


def test_autostart_given_with_another_operation_is_applied_by_that_operation(h):
    _first_run(h)
    h.forget_calls()
    h.run("--new-secret", "--secret-file", h.secret_file, "--autostart", "off")
    sat = f"vocalis-satellite-{h.sat_id()}"
    assert h.env_file()["AUTOSTART"] == "off"
    assert ["update", "--restart", "no", sat] in h.argvs() and "restart" in h.verbs()
    assert h.result()["MODE"] == "renew" and h.result()["AUTOSTART"] == "off"
    # An update creates the container under the recorded value.
    h.forget_calls()
    h.run("--update", "--image", IMAGE2, "--autostart", "on")
    assert h.run_of("long") == h.long_lived(image=IMAGE2, autostart="on")
    assert h.env_file()["AUTOSTART"] == "on" and h.env_file()["SATELLITE_IMAGE"] == IMAGE2


def test_a_container_made_under_the_other_restart_value_counts_as_current_and_its_policy_is_corrected(h):
    _first_run(h, "--autostart", "off")  # the label is the hash made under "off"
    h.run("--autostart", "on", auto_port=False)  # recorded on, policy updated; the label cannot be rewritten
    (container,) = h.container_state().values()
    assert container["restart_policy"] == "unless-stopped"
    h.forget_calls()
    result = h.run()
    # Same settings under either value: no recreate, no start, and the policy already matches, so no update either.
    assert h.kinds() == ["show", "fetch-model"] and not {"rm", "start", "restart", "update"} & set(h.verbs())
    assert "left as it is" in result.stdout
    # Now the policy and the record disagree: one docker update puts the container right, nothing is recreated.
    h.set_container(restart_policy="no")
    h.forget_calls()
    again = h.run()
    assert h.verbs().count("update") == 1 and "rm" not in h.verbs() and "run:long" not in h.verbs()
    assert ["update", "--restart", "unless-stopped", f"vocalis-satellite-{h.sat_id()}"] in h.argvs()
    assert "The restart policy of" in again.stdout and "is now unless-stopped" in again.stdout
    (container,) = h.container_state().values()
    assert container["restart_policy"] == "unless-stopped"
    # A stopped container gets its policy corrected and is then started.
    h.set_container(status="exited", restart_policy="no")
    h.forget_calls()
    h.run()
    assert h.verbs().count("update") == 1 and "start" in h.verbs() and "rm" not in h.verbs()


def test_a_container_made_under_a_different_specification_is_still_recreated(h):
    _first_run(h)
    h.set_container(label_spec="1" * 64)
    h.forget_calls()
    h.run()
    assert "rm" in h.verbs() and h.kinds()[-1] == "long"


def test_a_satellite_env_from_before_this_version_loads_and_gains_the_two_lines_at_the_next_save(h):
    _first_run(h)
    path = h.root / "satellite.env"
    older = "".join(line + "\n" for line in path.read_text(encoding="utf-8").splitlines()
                    if not line.startswith(("AUTOSTART=", "CERT_FINGERPRINT=")))
    path.write_text(older, encoding="utf-8")
    h.forget_calls()
    h.run()  # reads it (AUTOSTART is on), records the fingerprint it just read, and so saves the file
    env = h.env_file()
    assert env["AUTOSTART"] == "on" and env["CERT_FINGERPRINT"] == "AA:BB:01"
    assert not {"rm", "run:long", "update"} & set(h.verbs())  # on is the policy the container has


@pytest.mark.parametrize("key", ["SATELLITE_ID", "GPU_VARIANT", "SATELLITE_ROOT", "SATELLITE_IMAGE", "SATELLITE_PORT",
                                 "SATELLITE_NAME", "SERVICE_UID", "SERVICE_GID", "GPU_GIDS", "IP_ADDRESSES", "DNS_NAMES"])
def test_every_key_but_the_two_new_ones_is_still_required(h, key):
    _first_run(h)
    path = h.root / "satellite.env"
    text = "".join(line + "\n" for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith(key + "="))
    path.write_text(text, encoding="utf-8")
    h.forget_calls()
    result = h.run(expected=1)
    assert f"has no {key} line" in result.stderr and "It is not a file this setup wrote, so nothing was done." in result.stderr
    assert h.argvs() == [] and path.read_text(encoding="utf-8") == text


@pytest.mark.parametrize("line", ["AUTOSTART=maybe", "AUTOSTART=", "CERT_FINGERPRINT=not a fingerprint"])
def test_a_malformed_optional_key_is_refused(h, line):
    _first_run(h)
    path = h.root / "satellite.env"
    text = "".join(item + "\n" for item in path.read_text(encoding="utf-8").splitlines() if not item.startswith(line.split("=")[0] + "="))
    path.write_text(text + line + "\n", encoding="utf-8")
    h.forget_calls()
    result = h.run(expected=1)
    assert f"Invalid {line.split('=')[0]} in satellite.env" in result.stderr
    assert h.argvs() == []


def test_the_fingerprint_is_recorded_where_the_addresses_are_and_not_by_an_update(h):
    _first_run(h)
    assert h.env_file()["CERT_FINGERPRINT"] == "AA:BB:01"
    h.run("--new-certificate")
    assert h.env_file()["CERT_FINGERPRINT"] == "AA:BB:02"
    path = h.root / "satellite.env"
    path.write_text(path.read_text(encoding="utf-8").replace("CERT_FINGERPRINT=AA:BB:02", "CERT_FINGERPRINT="), encoding="utf-8")
    h.run("--update", "--image", IMAGE2)   # an update calls `show` but does not record
    assert h.env_file()["CERT_FINGERPRINT"] == ""
    h.run()
    assert h.env_file()["CERT_FINGERPRINT"] == "AA:BB:02"


# ----- --show-plan -----

PLAN_KEYS = ["SATELLITE", "SATELLITE_ID", "NAME", "PORT", "CONTAINER", "AUTOSTART", "IMAGE", "ADDRESSES", "NEEDS_SECRET",
             "NEEDS_CERTIFICATE", "SETUP_FINISHED", "CERTIFICATE_FILE", "FINGERPRINT"]


def _plan(result):
    lines = result.stdout.splitlines()
    assert [line.partition("=")[0] for line in lines] == PLAN_KEYS, result.stdout
    return {line.partition("=")[0]: line.partition("=")[2] for line in lines}


def test_show_plan_for_a_new_folder_prints_what_a_setup_would_use_and_makes_nothing(h):
    result = h.run("--show-plan", "--port", 7999, "--name", "Box", "--address", "192.168.1.99", "--address", "sat.lan", auto_port=False)
    assert _plan(result) == {
        "SATELLITE": "new", "SATELLITE_ID": "", "NAME": "box", "PORT": "7999", "CONTAINER": "", "AUTOSTART": "on", "IMAGE": "",
        "ADDRESSES": "192.168.1.50,10.0.0.7,192.168.1.99", "NEEDS_SECRET": "yes", "NEEDS_CERTIFICATE": "yes",
        "SETUP_FINISHED": "no", "CERTIFICATE_FILE": "", "FINGERPRINT": ""}
    assert h.calls() == [] and not h.root.exists()
    assert "Vocalis satellite setup" not in result.stdout and "[1/" not in result.stdout and result.stderr == ""
    # The default name is this computer's, as a setup would derive it.
    h.machine_name("Work_Horse.Lan")
    assert _plan(h.run("--show-plan", auto_port=False))["NAME"] == "work_horse.lan"
    assert _plan(h.run("--show-plan", auto_port=False))["PORT"] == "7880"


def test_show_plan_for_a_finished_folder_reads_satellite_env_and_changes_nothing(h):
    _first_run(h, "--name", "box", "--autostart", "off")
    before = _tree(h.root)
    h.forget_calls()
    result = h.run("--show-plan", auto_port=False)
    plan = _plan(result)
    assert plan == {
        "SATELLITE": "existing", "SATELLITE_ID": h.sat_id(), "NAME": "box", "PORT": str(h.port),
        "CONTAINER": f"vocalis-satellite-{h.sat_id()}", "AUTOSTART": "off", "IMAGE": IMAGE,
        "ADDRESSES": "192.168.1.50,10.0.0.7", "NEEDS_SECRET": "no", "NEEDS_CERTIFICATE": "no", "SETUP_FINISHED": "yes",
        "CERTIFICATE_FILE": str(h.root / "data" / "certs" / "cert.pem"), "FINGERPRINT": "AA:BB:01"}
    assert h.calls() == [] and _tree(h.root) == before  # no Docker call, no log, no result, no file touched
    assert _other_stderr(result) == []


def test_show_plan_setup_finished_needs_the_configuration_file_too(h):
    # SETUP_FINISHED is yes only when satellite.env, the secret, the certificate AND data/satellite.yaml all exist.
    _first_run(h)
    plan = _plan(h.run("--show-plan", auto_port=False))
    assert (plan["NEEDS_SECRET"], plan["NEEDS_CERTIFICATE"], plan["SETUP_FINISHED"]) == ("no", "no", "yes")
    yaml_path = h.root / "data" / "satellite.yaml"
    saved = yaml_path.read_bytes()
    yaml_path.unlink()
    plan = _plan(h.run("--show-plan", auto_port=False))
    assert (plan["NEEDS_SECRET"], plan["NEEDS_CERTIFICATE"], plan["SETUP_FINISHED"]) == ("no", "no", "no")
    # An empty file is as missing as an absent one.
    yaml_path.write_bytes(b"")
    assert _plan(h.run("--show-plan", auto_port=False))["SETUP_FINISHED"] == "no"
    yaml_path.write_bytes(saved)
    assert _plan(h.run("--show-plan", auto_port=False))["SETUP_FINISHED"] == "yes"
    # MODE is the narrower question (design, script change 4: first is "a secret or certificate still to be made"): with
    # only the configuration file missing a plain run rebuilds it and is a rerun, as in the Windows script.
    yaml_path.unlink()
    h.run()
    assert "first-run: 0" in h.log_text() and h.result()["MODE"] == "rerun"
    assert yaml_path.is_file()


def test_show_plan_says_what_is_still_to_be_made(h):
    _first_run(h)
    (h.root / "secrets" / "vocalis-satellite-master").unlink()
    plan = _plan(h.run("--show-plan", auto_port=False))
    assert plan["NEEDS_SECRET"] == "yes" and plan["NEEDS_CERTIFICATE"] == "no" and plan["SETUP_FINISHED"] == "no"
    (h.root / "data" / "certs" / "cert.pem").unlink()
    plan = _plan(h.run("--show-plan", auto_port=False))
    assert plan["NEEDS_CERTIFICATE"] == "yes" and plan["CERTIFICATE_FILE"] == ""
    # An older satellite.env (no AUTOSTART, no CERT_FINGERPRINT): on, and no fingerprint.
    path = h.root / "satellite.env"
    path.write_text("".join(line + "\n" for line in path.read_text(encoding="utf-8").splitlines()
                            if not line.startswith(("AUTOSTART=", "CERT_FINGERPRINT="))), encoding="utf-8")
    plan = _plan(h.run("--show-plan", auto_port=False))
    assert plan["AUTOSTART"] == "on" and plan["FINGERPRINT"] == ""


@pytest.mark.parametrize("arguments,message", [
    (["--port", "80"], "--port must be a number"),
    (["--name", "bad name"], "--name may use letters"),
    (["--address", "999.1.1.1"], "not a valid IPv4 address"),
    (["--update"], "--show-plan can only be combined with"),
    (["--remove"], "--remove can only be combined with --root"),
    (["--image", IMAGE], "--show-plan can only be combined with"),
    (["--autostart", "off"], "--show-plan can only be combined with"),
])
def test_show_plan_with_invalid_input_is_exit_1_with_the_usual_error_line(h, arguments, message):
    result = h.run("--show-plan", *arguments, expected=1, auto_port=False)
    assert result.stdout == "" and message in result.stderr and result.stderr.startswith("ERROR: ")
    assert h.calls() == [] and not h.root.exists()


def test_show_plan_refuses_a_refused_folder(h, tmp_path):
    h.root.mkdir()
    (h.root / "precious.txt").write_text("keep me", encoding="utf-8")
    assert "not a satellite folder" in h.run("--show-plan", expected=1, auto_port=False).stderr
    shutil.rmtree(h.root)
    _first_run(h, "--port", "7999")
    assert "port of an existing satellite folder is fixed" in h.run("--show-plan", "--port", "7998", expected=1, auto_port=False).stderr
    path = h.root / "satellite.env"
    path.write_text(path.read_text(encoding="utf-8") + "FUTURE_KEY=1\n", encoding="utf-8")
    assert "unknown key 'FUTURE_KEY'" in h.run("--show-plan", expected=1, auto_port=False).stderr
