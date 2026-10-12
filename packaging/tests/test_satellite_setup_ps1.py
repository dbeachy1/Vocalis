"""Contract tests for packaging/satellite/satellite-setup.ps1, the Windows satellite setup (design section 9,
"Satellite package: one command per operating system", added October 10, 2026).

The script is run for real (Windows PowerShell 5.1) against a FAKE docker.exe that this module compiles with Add-Type,
the way test_setup_ps1.py does for setup.ps1. The fake records every call (arguments) and the environment of every call,
keeps a tiny container registry in a state folder, and plays the in-image tool (satellite_admin.py: check-gpu, provision,
show, fetch-model) closely enough that a rerun sees the files an earlier run made. It never contacts Docker or the
network. The Windows network cmdlets are stood in for by functions in a wrapper script (a function wins over a cmdlet of
the same name, and a script run with & sees its caller's functions), so the address rule runs on sample adapter data;
Start-Sleep is stood in for the same way, so the 180-second wait needs no real waiting. LOCALAPPDATA and every folder the
script touches are inside the test's own temporary folder. The ports used are free ports found at run time, never 7880.

Not provable here: the secret prompt itself (it needs a console, and every test run has redirected input, which is exactly
the case the script refuses). That call is proven by its shape: a direct native call at script scope, made with -it.
"""
from pathlib import Path
import datetime
import hashlib
import json
import os
import random
import re
import shutil
import socket
import subprocess
import time

import pytest


PACKAGING = Path(__file__).resolve().parents[1]
SCRIPT = PACKAGING / "satellite" / "satellite-setup.ps1"
POWERSHELL = shutil.which("powershell.exe") if os.name == "nt" else None
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="Windows PowerShell 5.1 is required")

IMAGE = "registry.example/vocalis-satellite-cuda@sha256:" + "a" * 64
NEW_IMAGE = "registry.example/vocalis-satellite-cuda@sha256:" + "b" * 64
SECRET = "0123456789abcdef" * 4  # what the fake treats as a valid 64 hex digit secret
SECOND_SECRET = "fedcba9876543210" * 4
ADMIN_TOOL = "/opt/vocalis/satellite-admin/satellite_admin.py"
OLD_ENV_KEYS = ["SATELLITE_ID", "GPU_VARIANT", "SATELLITE_ROOT", "SATELLITE_IMAGE", "SATELLITE_PORT", "SATELLITE_NAME",
                "SERVICE_UID", "SERVICE_GID", "GPU_GIDS", "IP_ADDRESSES", "DNS_NAMES"]
# AUTOSTART and CERT_FINGERPRINT are the twelfth and thirteenth keys (October 11, 2026).
ENV_KEYS = OLD_ENV_KEYS + ["AUTOSTART", "CERT_FINGERPRINT"]
# setup-result.txt: exactly these keys, in this order (design, "Script changes" item 4)
RESULT_KEYS = ["SCHEMA", "FINISHED", "MODE", "EXIT_CODE", "FAILURE", "SATELLITE_ID", "NAME", "PORT", "IMAGE", "CONTAINER", "RUNNING",
               "AUTOSTART", "URLS", "CERTIFICATE_FILE", "FINGERPRINT", "MADE_SECRET", "MADE_CERTIFICATE", "VOCALIS_STEPS", "LOG_FILE"]
# -ShowPlan: exactly these keys, in this order (design, "Script changes" item 7)
PLAN_KEYS = ["SATELLITE", "SATELLITE_ID", "NAME", "PORT", "CONTAINER", "AUTOSTART", "IMAGE", "ADDRESSES", "NEEDS_SECRET", "NEEDS_CERTIFICATE",
             "SETUP_FINISHED", "CERTIFICATE_FILE", "FINGERPRINT"]
# -NoPrompt with a needed secret and no -SecretFile: one fixed line
# (Reworded October 11, 2026: it reaches a setup program page, so it is plain English. The old line was
# "ERROR: A secret is needed and no -SecretFile was given; -NoPrompt never asks for it.")
NO_PROMPT_LINE = "ERROR: This satellite still needs its secret from Vocalis. Run setup again and paste the secret when it asks."
# A plain run on a folder whose setup never finished, given another image, adopts it and says so in this one line.
ADOPT_LINE = "This satellite was never finished; using the image this setup carries."
FINGERPRINT_1 = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:01"


# ---- sample adapter data -------------------------------------------------------------------------------------------
# Ethernet (index 12, metric 25) holds the lowest-metric default route, Wi-Fi (7, metric 35) is second; WSL, the Hyper-V
# default switch and a Docker adapter are virtual; the loopback, a link-local address and a disconnected adapter must
# all be left out.
def sample_network(wifi_metric=35):
    return {
        "adapters": [
            {"index": 12, "name": "Ethernet", "description": "Intel(R) Ethernet Connection", "status": "Up"},
            {"index": 7, "name": "Wi-Fi", "description": "Intel(R) Wi-Fi 6 AX201", "status": "Up"},
            {"index": 20, "name": "vEthernet (WSL)", "description": "Hyper-V Virtual Ethernet Adapter", "status": "Up"},
            {"index": 21, "name": "vEthernet (Default Switch)", "description": "Hyper-V Virtual Ethernet Adapter #2", "status": "Up"},
            {"index": 30, "name": "Ethernet 3", "description": "Docker Desktop Network Adapter", "status": "Up"},
            {"index": 40, "name": "Loopback Pseudo-Interface 1", "description": "Software Loopback Interface 1", "status": "Up"},
            {"index": 50, "name": "Ethernet 2", "description": "Realtek PCIe GbE", "status": "Disconnected"},
        ],
        "addresses": [
            {"index": 12, "ip": "192.168.1.50", "state": "Preferred"},
            {"index": 12, "ip": "169.254.5.5", "state": "Preferred"},
            {"index": 7, "ip": "192.168.1.60", "state": "Preferred"},
            {"index": 20, "ip": "172.20.0.1", "state": "Preferred"},
            {"index": 21, "ip": "172.30.0.1", "state": "Preferred"},
            {"index": 30, "ip": "172.17.0.1", "state": "Preferred"},
            {"index": 40, "ip": "127.0.0.1", "state": "Preferred"},
            {"index": 50, "ip": "10.9.9.9", "state": "Preferred"},
        ],
        "interfaces": [{"index": 12, "metric": 25}, {"index": 7, "metric": wifi_metric}, {"index": 20, "metric": 5000}],
        "routes": [
            {"prefix": "0.0.0.0/0", "index": 12, "metric": 0},
            {"prefix": "0.0.0.0/0", "index": 7, "metric": 0},
            {"prefix": "192.168.1.0/24", "index": 12, "metric": 256},
        ],
    }


NO_NETWORK = {"adapters": [], "addresses": [], "interfaces": [], "routes": []}


# ---- static checks -------------------------------------------------------------------------------------------------

def script_text():
    return SCRIPT.read_text(encoding="ascii")


def code_lines(text):
    return [line for line in text.splitlines() if not line.lstrip().startswith("#")]


def test_script_is_one_ascii_lf_file_that_needs_no_wsl_compose_helper_or_system_change():
    raw = SCRIPT.read_bytes()
    text = raw.decode("ascii")  # Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page
    assert b"\r" not in raw  # LF, like setup.ps1
    code = "\n".join(code_lines(text))
    assert not re.search(r"^\s*\.\s+[$'\"]", code, re.MULTILINE), "the script must not dot-source another file"
    for forbidden in ("windows-compose", "wsl.exe", "/mnt/", "Set-ExecutionPolicy", "Set-NetFirewall", "netsh advfirewall",
                      "Set-ItemProperty", "reg add", "SetEnvironmentVariable", "Start-Process"):
        assert forbidden not in code, forbidden
    assert not re.search(r"\$env:\w+\s*=", code, re.IGNORECASE)
    # the firewall command is only ever printed (to the screen by -Help, to the setup log by a run since October 11, 2026)
    for line in code.splitlines():
        if "New-NetFirewallRule" in line:
            assert line.strip().startswith(("Write-Host ", "Write-Hidden ")), line
    # a native program's output is never merged with 2>&1: Windows PowerShell 5.1 turns each stderr line into an error record
    assert "2>&1" not in code


def test_stamp_marker_is_one_exact_line_near_the_top():
    lines = script_text().splitlines()
    marks = [index for index, line in enumerate(lines) if line.strip() == "$DefaultImageCuda = ''"]
    # "near the top": in the setup block before the first function (the header comment grew with the options of October
    # 11, 2026, so a fixed line number no longer says that)
    first_function = next(index for index, line in enumerate(lines) if line.startswith("function "))
    assert len(marks) == 1 and lines[marks[0]] == "$DefaultImageCuda = ''" and marks[0] < first_function, marks
    assert script_text().count("$DefaultImageCuda = ''") == 1


def test_header_documents_the_exit_codes_the_script_produces():
    header = script_text().split("[CmdletBinding()]", 1)[0]
    documented = [int(code) for code in re.findall(r"^#\s+(\d+)\s{2}", header, re.MULTILINE)]
    assert documented == [0, 1, 10, 11, 12, 13, 14], documented  # 14 (the NVIDIA runtime, -CheckOnly) is new on October 11, 2026
    text = script_text()
    for code in (10, 11, 12, 13, 14):
        assert re.search(rf"\b{code}\b", "\n".join(code_lines(text))), code
    for switch in ("Update", "NewSecret", "NewCertificate", "Remove", "Help", "Autostart", "Verbose", "NoPrompt", "ShowPlan", "CheckOnly", "CheckPort"):
        assert f"-{switch}" in header


@needs_powershell
def test_script_parses_in_windows_powershell_and_declares_the_agreed_parameters():
    driver = (
        "param([string]$Script)\n"
        "$e = $null; $t = $null\n"
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$t, [ref]$e)\n"
        "if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }\n"
        "foreach ($p in $ast.ParamBlock.Parameters) {\n"
        "  $d = if ($p.DefaultValue) { $p.DefaultValue.Extent.Text } else { '' }\n"
        "  $v = ($p.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateRange' } | ForEach-Object { $_.Extent.Text }) -join ';'\n"
        "  ($p.StaticType.Name + ' ' + $p.Name.VariablePath.UserPath + ' = ' + $d + ' ' + $v).TrimEnd()\n"
        "}\n")
    result = run_driver(driver, "-Script", str(SCRIPT))
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.splitlines() == [
        "String Root =", "String Image =", "Int32 Port = 7880 [ValidateRange(1024, 65535)]", "String Name =",
        "String[] Address =", "String SecretFile =", "String Autostart =", "SwitchParameter Update =", "SwitchParameter NewSecret =",
        "SwitchParameter NewCertificate =", "SwitchParameter Remove =", "SwitchParameter ShowPlan =", "SwitchParameter CheckOnly =",
        "SwitchParameter CheckPort =", "SwitchParameter NoPrompt =", "SwitchParameter Help ="], result.stdout
    # -Verbose is PowerShell's own (the script is [CmdletBinding()]); no parameter of that name is declared
    assert "Verbose" not in [line.split(" ")[1] for line in result.stdout.splitlines()]


@needs_powershell
def test_the_prompting_provision_call_is_a_direct_native_call_at_script_scope():
    # setup.ps1 records the trap: a bounded wrapper closes the program's input, and a function turns the prompt into
    # buffered pipe text. The one call that prompts must therefore be `& $DockerPath @TerminalArguments`, outside every
    # function, and nothing else may carry the -it arguments.
    driver = (
        "param([string]$Script)\n"
        "$e = $null; $t = $null\n"
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$t, [ref]$e)\n"
        "$calls = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.InvocationOperator -eq 'Ampersand' }, $true)\n"
        "foreach ($c in $calls) {\n"
        "  $inFunction = $false; $p = $c.Parent\n"
        "  while ($p) { if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { $inFunction = $true }; $p = $p.Parent }\n"
        "  \"$inFunction`t$($c.Extent.Text)\"\n"
        "}\n")
    result = run_driver(driver, "-Script", str(SCRIPT))
    assert result.returncode == 0, result.stdout + result.stderr
    calls = [line.split("\t", 1) for line in result.stdout.splitlines()]
    prompting = [(in_function, text) for in_function, text in calls if "@TerminalArguments" in text]
    assert prompting == [("False", "& $DockerPath @TerminalArguments")], calls
    text = script_text()
    assert text.count("TerminalArguments") == 2  # the assignment and the call
    assert text.count("-Terminal") == 1
    # The pull at a terminal is a direct call too (Docker's own progress display). The model download is NOT direct since
    # October 11, 2026: it is captured by the script's own runner (standard output shown, standard error to the log); the
    # bounded helper never gets -it.
    joined = "".join(call[1] for call in calls)
    assert "pull $ActiveImage" in joined and "@FetchArguments" not in joined
    assert "Invoke-Streamed -FileName $DockerPath -Arguments $FetchArguments" in text
    assert "'-it'" in text and text.count("'-it'") == 1


# ---- the functions, extracted with the PowerShell parser -------------------------------------------------------------

def run_driver(driver_text, *args, env=None):
    path = Path(os.environ.get("TEMP", ".")) / f"satellite-driver-{os.getpid()}.ps1"
    path.write_text(driver_text, encoding="ascii")
    try:
        return subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path), *args],
                              capture_output=True, text=True, timeout=120, env=env, input="")
    finally:
        path.unlink(missing_ok=True)


def run_functions(names, body, *, tmp_path, env=None):
    """Defines the named functions of the script (taken from its AST, nothing else runs) and then runs `body`."""
    driver = tmp_path / "functions.ps1"
    driver.write_text(
        "param([string]$Script, [string]$Names, [string]$Body)\n"
        "$ErrorActionPreference = 'Stop'\n"
        "$e = $null; $t = $null\n"
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$t, [ref]$e)\n"
        "foreach ($name in $Names.Split(',')) {\n"
        "  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)\n"
        "  if (-not $fn) { throw \"no function $name\" }\n"
        "  . ([scriptblock]::Create($fn.Extent.Text))\n"
        "}\n"
        ". ([scriptblock]::Create($Body))\n",
        encoding="ascii")
    return subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(driver),
                           "-Script", str(SCRIPT), "-Names", ",".join(names), "-Body", body],
                          capture_output=True, text=True, timeout=120, input="", env=env)


def select_addresses(tmp_path, network):
    """Select-SatelliteAddresses on sample data -> {Primary, All, Skipped, Note}."""
    data = tmp_path / "network.json"
    data.write_text(json.dumps(network), encoding="ascii")
    body = (
        f"$s = Get-Content -Raw -LiteralPath '{data}' | ConvertFrom-Json\n"
        "$adapters = @($s.adapters | ForEach-Object { [pscustomobject]@{ Index = [int]$_.index; Name = $_.name; Description = $_.description; Status = $_.status } })\n"
        "$addresses = @($s.addresses | ForEach-Object { [pscustomobject]@{ InterfaceIndex = [int]$_.index; IPAddress = $_.ip; State = $_.state } })\n"
        "$routes = @($s.routes | Where-Object { $_.prefix -eq '0.0.0.0/0' } | ForEach-Object { [pscustomobject]@{ Index = [int]$_.index; Metric = [int]$_.metric } })\n"
        "$r = Select-SatelliteAddresses -Adapters $adapters -Addresses $addresses -Routes $routes\n"
        "[pscustomobject]@{ Primary = $r.Primary; All = @($r.All); Skipped = @($r.Skipped); Note = $r.Note } | ConvertTo-Json -Compress\n")
    result = run_functions(["ConvertTo-CanonicalIpv4", "Select-SatelliteAddresses"], body, tmp_path=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def total_metric_routes(network):
    """The sample's default routes with the interface metric added, as Get-SatelliteNetworkSnapshot computes them."""
    metric = {item["index"]: item["metric"] for item in network["interfaces"]}
    network = dict(network)
    network["routes"] = [dict(route, metric=route["metric"] + metric.get(route["index"], 0)) for route in network["routes"]]
    return network


@needs_powershell
def test_address_rule_keeps_up_physical_adapters_and_ranks_by_default_route_metric(tmp_path):
    answer = select_addresses(tmp_path, total_metric_routes(sample_network()))
    assert answer["Primary"] == "192.168.1.50"  # Ethernet: route 0 + interface 25 beats Wi-Fi 0 + 35
    assert answer["All"] == ["192.168.1.50", "192.168.1.60"]
    skipped = "\n".join(answer["Skipped"])
    for ip, reason in (("169.254.5.5", "link-local"), ("172.20.0.1", "virtual"), ("172.30.0.1", "virtual"), ("172.17.0.1", "virtual"),
                       ("127.0.0.1", "loopback"), ("10.9.9.9", "not up")):
        assert re.search(rf"^{re.escape(ip)} \(.*{reason}", skipped, re.MULTILINE), (ip, skipped)
    assert "primary 192.168.1.50 on Ethernet" in answer["Note"]


@needs_powershell
def test_address_rule_primary_follows_the_lowest_metric_not_the_adapter_order(tmp_path):
    answer = select_addresses(tmp_path, total_metric_routes(sample_network(wifi_metric=5)))
    assert answer["Primary"] == "192.168.1.60" and answer["All"] == ["192.168.1.60", "192.168.1.50"], answer


@needs_powershell
def test_address_rule_without_a_usable_default_route_takes_the_first_address_and_says_so(tmp_path):
    network = total_metric_routes(sample_network())
    network["routes"] = [route for route in network["routes"] if route["index"] not in (12, 7)]  # only the WSL-less table remains
    answer = select_addresses(tmp_path, network)
    assert answer["Primary"] == "192.168.1.60" and answer["All"] == ["192.168.1.60", "192.168.1.50"], answer  # lowest interface index first
    assert "no default route" in answer["Note"]


@needs_powershell
def test_address_rule_with_nothing_usable_gives_no_primary(tmp_path):
    answer = select_addresses(tmp_path, NO_NETWORK)
    assert answer["Primary"] is None and answer["All"] == [] and answer["Skipped"] == []
    network = sample_network()
    network["adapters"] = [dict(adapter, status="Disconnected") for adapter in network["adapters"]]
    assert select_addresses(tmp_path, total_metric_routes(network))["All"] == []


def address_lists(tmp_path, *values):
    literal = ",".join("'" + value.replace("'", "''") + "'" for value in values)
    body = ("try { $r = ConvertTo-AddressLists -Values @(" + literal + "); "
            "[pscustomobject]@{ Ips = @($r.Ips); Names = @($r.Names); Error = '' } | ConvertTo-Json -Compress } "
            "catch { [pscustomobject]@{ Ips = @(); Names = @(); Error = $_.Exception.Message } | ConvertTo-Json -Compress }")
    result = run_functions(["Stop-Setup", "ConvertTo-CanonicalIpv4", "ConvertTo-AddressLists"], body, tmp_path=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


@needs_powershell
def test_address_arguments_split_on_commas_and_sort_into_addresses_and_names(tmp_path):
    answer = address_lists(tmp_path, "192.168.1.99,NAS.Lan", " 10.0.0.5 ", "192.168.1.99", "satellite")
    assert answer == {"Ips": ["192.168.1.99", "10.0.0.5"], "Names": ["nas.lan", "satellite"], "Error": ""}


@needs_powershell
@pytest.mark.parametrize("value, message", [
    ("127.0.0.1", "loopback"),
    ("169.254.1.1", "link-local"),
    ("0.0.0.0", "unspecified"),
    ("224.0.0.1", "multicast"),
    ("255.255.255.255", "multicast"),
    ("localhost", "localhost is always part of the certificate"),
    ("LocalHost", "localhost is always part of the certificate"),
    ("300.1.1.1", "not a valid IPv4"),
    ("010.1.1.1", "not a valid IPv4"),
    ("192.168.1", "not a valid IPv4"),
    ("fe80::1", "IPv6"),
    ("bad name!", "neither an IPv4 address nor a plain host name"),
    ("-leading.hyphen", "neither an IPv4 address nor a plain host name"),
])
def test_address_arguments_that_cannot_work_are_refused_with_a_reason(tmp_path, value, message):
    assert message in address_lists(tmp_path, value)["Error"], value


@needs_powershell
def test_the_ise_is_recognized_by_its_host_name(tmp_path):
    body = "(Test-PowerShellIse -HostName 'Windows PowerShell ISE Host'), (Test-PowerShellIse -HostName 'ConsoleHost') -join ','"
    result = run_functions(["Test-PowerShellIse"], body, tmp_path=tmp_path)
    assert result.returncode == 0 and result.stdout.strip() == "True,False", result.stdout + result.stderr


def wildcard_port_check(tmp_path, port):
    result = run_functions(["Test-WindowsWildcardPort"], f"$r = Test-WindowsWildcardPort {port}; if ($r) {{ \"BUSY: $r\" }} else {{ 'FREE' }}", tmp_path=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout.strip()


def free_port():
    """A port nothing holds right now. October 11, 2026: asking the OS for port 0 gave a port from Windows' dynamic range
    (49152-65535), which other processes (the other xdist workers' test programs, outgoing connections) take at random; under
    `-n 6` the setup script then found it taken: "ERROR: The satellite port is not usable: port 55548 is already in use on
    Windows (socket error 10048)" (about one full run in six, also seen on the commit before this change). So the port comes
    from a slice of the range BELOW the dynamic ports that belongs to this xdist worker, and is still probed on the wildcard
    address, the way the script probes it."""
    worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
    slot = int(worker[2:]) if worker.startswith("gw") and worker[2:].isdigit() else 0
    first = 20000 + 1000 * (slot % 20)
    for _ in range(200):
        candidate = random.randrange(first, first + 1000)
        with socket.socket() as probe:
            try:
                probe.bind(("0.0.0.0", candidate))
            except OSError:
                continue
        return candidate
    raise RuntimeError(f"no free port found in {first}-{first + 999}")


@needs_powershell
def test_wildcard_port_check_accepts_a_free_port_releases_it_and_rejects_a_held_one(tmp_path):
    # The holders below are bound but never listen: a listening socket on a non-loopback address is what makes Windows
    # Defender Firewall ask a developer about the test program, and a bound port is just as taken for the script's own
    # (bind-only, exclusive) check.
    port = free_port()
    assert wildcard_port_check(tmp_path, port) == "FREE"
    assert wildcard_port_check(tmp_path, port) == "FREE"  # released
    with socket.socket() as holder:
        holder.bind(("0.0.0.0", port))
        verdict = wildcard_port_check(tmp_path, port)
    assert verdict.startswith("BUSY:") and f"port {port} is already in use on Windows (socket error 10048)" in verdict, verdict
    # a holder on one specific address blocks the wildcard too (that is what Docker's publish would collide with)
    with socket.socket() as holder:
        holder.bind(("127.0.0.1", port))
        assert wildcard_port_check(tmp_path, port).startswith("BUSY:")


# ---- fake docker.exe -------------------------------------------------------------------------------------------------
# One small console program installed as docker.exe. Records "docker\t<arg>\t<arg>..." per call in FAKE_LOG and every
# environment variable of every call in FAKE_ENVLOG. Container state lives in FAKE_STATE as <name>.container (status,
# restart count, started-at, spec label). Scripted by environment variables:
#   FAKE_INFO_EXIT, FAKE_IMAGE_LOCAL (1, or ';'-separated references), FAKE_PULL_EXIT, FAKE_INSPECT_EXIT,
#   FAKE_RUN_D_EXIT, FAKE_RUN_D_STATUS (running|exited), FAKE_NO_LISTEN=1, FAKE_BUMP_RESTART=1,
#   FAKE_EXIT_<subcommand with _ for -> (check_gpu, provision, show, fetch_model), FAKE_NO_CARDS=1,
#   FAKE_UPDATE_EXIT (docker update), FAKE_NO_NVIDIA=1 (docker info --format shows no nvidia runtime), FAKE_FLAGLOG (a file
#   that gets one line per pull saying whether its output went to a pipe or to the console).
# The tool half writes the files satellite_admin.py would (secret, certificate, satellite.yaml) into the mounted folders,
# so a rerun finds them. C# 5 only: Windows PowerShell 5.1 compiles with the .NET Framework compiler.

FAKE_DOCKER_SOURCE = r"""
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public static class FakeDocker {
    static string Env(string name) { return Environment.GetEnvironmentVariable(name); }

    static void Append(string envName, string line) {
        string path = Env(envName);
        if (!string.IsNullOrEmpty(path)) File.AppendAllText(path, line + "\n");
    }

    static int ExitFrom(string name, int fallback) {
        string v = Env(name);
        int n;
        return (v != null && int.TryParse(v, out n)) ? n : fallback;
    }

    static string StatePath(string container) { return Path.Combine(Env("FAKE_STATE"), container + ".container"); }

    static string[] ReadState(string container) {
        string p = StatePath(container);
        return File.Exists(p) ? File.ReadAllLines(p) : null;
    }

    // The state file is: status, restart count, started-at, spec label, restart policy (the fifth line since October 11,
    // 2026, when the script began to read .HostConfig.RestartPolicy.Name and to change it with `docker update`).
    static void WriteState(string container, string status, int restarts, string startedAt, string label, string policy) {
        File.WriteAllLines(StatePath(container), new string[] { status, restarts.ToString(), startedAt, label, policy });
    }

    static string PolicyOf(string[] state) { return state.Length > 4 ? state[4] : "unless-stopped"; }

    // The container log: "<timestamp>\t<text>" lines. `docker logs --since T` prints the lines at or after T, as the real one
    // does, so a script that forgets --since after a restart finds the OLD listening line. The real satellite logs to STDERR.
    static string LogPath(string container) { return Path.Combine(Env("FAKE_STATE"), container + ".log"); }

    static void LogLine(string container, string timestamp, string text) {
        File.AppendAllText(LogPath(container), timestamp + "\t" + text + "\n");
    }

    static void LogStart(string container, string timestamp) {
        LogLine(container, timestamp, "INFO fake satellite starting");
        if (Env("FAKE_NO_LISTEN") != "1") LogLine(container, timestamp, "INFO listening on https://0.0.0.0:7880");
    }

    static int CompareIps(string a, string b) {
        string[] x = a.Split('.'), y = b.Split('.');
        for (int i = 0; i < 4; i++) {
            int c = int.Parse(x[i]).CompareTo(int.Parse(y[i]));
            if (c != 0) return c;
        }
        return 0;
    }

    static string Tick() {
        string p = Path.Combine(Env("FAKE_STATE"), "clock.txt");
        int n = File.Exists(p) ? int.Parse(File.ReadAllText(p).Trim()) : 0;
        n++;
        File.WriteAllText(p, n.ToString());
        return "2026-10-10T" + (n / 3600).ToString("00") + ":" + ((n / 60) % 60).ToString("00") + ":" + (n % 60).ToString("00") + ".000000000Z";
    }

    public static int Main(string[] args) {
        Append("FAKE_LOG", "docker\t" + string.Join("\t", args));
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) Append("FAKE_ENVLOG", e.Key + "=" + e.Value);
        if (args.Length == 0) return 64;
        string last = args[args.Length - 1];
        string first = args[0];
        string second = args.Length > 1 ? args[1] : "";
        // A hung call (FAKE_HANG=<first argument>): the script's bounded runner must stop it and report it.
        if (Env("FAKE_HANG") == first) System.Threading.Thread.Sleep(120000);
        if (first == "info") {
            int code = ExitFrom("FAKE_INFO_EXIT", 0);
            if (code != 0) Console.Error.WriteLine("error during connect: the Docker engine is not running");
            else if (Array.IndexOf(args, "--format") >= 0) {
                // docker info --format {{json .Runtimes}}: the NVIDIA runtime is there unless FAKE_NO_NVIDIA=1
                Console.Out.WriteLine(Env("FAKE_NO_NVIDIA") == "1" ? "{\"runc\":{\"path\":\"runc\"}}" : "{\"nvidia\":{\"path\":\"nvidia-container-runtime\"},\"runc\":{\"path\":\"runc\"}}");
            }
            else Console.Out.WriteLine("fake docker info");
            return code;
        }
        if (first == "image" && second == "inspect") {
            string local = Env("FAKE_IMAGE_LOCAL");
            bool present = local != null && (local == "1" || Array.IndexOf(local.Split(';'), last) >= 0);
            if (present) { Console.Out.WriteLine("[{}]"); return 0; }
            Console.Error.WriteLine("Error: No such image: " + last);
            return 1;
        }
        if (first == "pull") {
            // Whether the script gave the pull a pipe (captured) or the console (Docker's own progress display).
            Append("FAKE_FLAGLOG", "pull stdout-redirected=" + Console.IsOutputRedirected + " stderr-redirected=" + Console.IsErrorRedirected);
            int code = ExitFrom("FAKE_PULL_EXIT", 0);
            if (code != 0) Console.Error.WriteLine("Error response from daemon: pull access denied for " + last);
            else { Console.Error.WriteLine("INFO: pull: a note on stderr after a successful pull"); Console.Out.WriteLine("Status: Downloaded newer image for " + last); }
            return code;
        }
        if (first == "container" && second == "inspect") {
            int code = ExitFrom("FAKE_INSPECT_EXIT", 0);
            if (code != 0) { Console.Error.WriteLine("Cannot connect to the Docker daemon"); return code; }
            int delay = ExitFrom("FAKE_INSPECT_DELAY_MS", 0);
            if (delay > 0) System.Threading.Thread.Sleep(delay);
            string[] state = ReadState(last);
            if (state == null) { Console.Error.WriteLine("Error: No such object: " + last); return 1; }
            int fmt = Array.IndexOf(args, "--format");
            if (fmt >= 0 && fmt + 1 < args.Length && args[fmt + 1] == "{{.State.Status}}") { Console.Out.WriteLine(state[0]); return 0; }
            Console.Out.WriteLine(state[0] + "|" + state[1] + "|" + state[2] + "|" + state[3] + "|" + PolicyOf(state));
            return 0;
        }
        if (first == "update") {
            // docker update --restart <policy> <container>: changes the policy only, never the state or the start time
            int code = ExitFrom("FAKE_UPDATE_EXIT", 0);
            if (code != 0) { Console.Error.WriteLine("Error response from daemon: fake update refused"); return code; }
            string[] state = ReadState(last);
            if (state == null) { Console.Error.WriteLine("Error response from daemon: No such container: " + last); return 1; }
            int at = Array.IndexOf(args, "--restart");
            if (at < 0 || at + 1 >= args.Length) { Console.Error.WriteLine("fake docker update: --restart is the only option this fake knows"); return 64; }
            WriteState(last, state[0], int.Parse(state[1]), state[2], state[3], args[at + 1]);
            Console.Out.WriteLine(last);
            return 0;
        }
        if (first == "rm") {
            string p = StatePath(last);
            if (!File.Exists(p)) { Console.Error.WriteLine("Error: No such container: " + last); return Array.IndexOf(args, "-f") >= 0 ? 0 : 1; }
            File.Delete(p);
            if (File.Exists(LogPath(last))) File.Delete(LogPath(last));
            Console.Out.WriteLine(last);
            return 0;
        }
        if (first == "start" || first == "restart" || first == "stop") {
            string[] state = ReadState(last);
            if (state == null) { Console.Error.WriteLine("Error: No such container: " + last); return 1; }
            if (first == "stop") WriteState(last, "exited", int.Parse(state[1]), state[2], state[3], PolicyOf(state));
            else {
                string startedAt = Tick();
                WriteState(last, "running", int.Parse(state[1]), startedAt, state[3], PolicyOf(state));
                LogStart(last, startedAt);
            }
            Console.Out.WriteLine(last);
            return 0;
        }
        if (first == "logs") {
            string[] state = ReadState(last);
            if (state == null) { Console.Error.WriteLine("Error: No such container: " + last); return 1; }
            bool tail = Array.IndexOf(args, "--tail") >= 0;
            if (!tail && Env("FAKE_BUMP_RESTART") == "1") WriteState(last, state[0], int.Parse(state[1]) + 1, state[2], state[3], PolicyOf(state));
            int sinceAt = Array.IndexOf(args, "--since");
            string since = sinceAt >= 0 ? args[sinceAt + 1] : null;
            string[] lines = File.Exists(LogPath(last)) ? File.ReadAllLines(LogPath(last)) : new string[0];
            int begin = tail ? Math.Max(0, lines.Length - 30) : 0;
            for (int i = begin; i < lines.Length; i++) {
                string[] parts = lines[i].Split(new char[] { '\t' }, 2);
                if (since != null && string.CompareOrdinal(parts[0], since) < 0) continue;
                Console.Error.WriteLine(parts[1]);
            }
            return 0;
        }
        if (first == "run") {
            if (second == "-d") return RunDetached(args);
            return RunOneShot(args);
        }
        Console.Error.WriteLine("fake docker: unsupported call");
        return 64;
    }

    static int RunDetached(string[] args) {
        int code = ExitFrom("FAKE_RUN_D_EXIT", 0);
        string name = null, label = "", policy = "no";
        for (int i = 0; i + 1 < args.Length; i++) {
            if (args[i] == "--name") name = args[i + 1];
            if (args[i] == "--restart") policy = args[i + 1];
            if (args[i] == "--label" && args[i + 1].StartsWith("vocalis.satellite.spec=")) label = args[i + 1].Substring("vocalis.satellite.spec=".Length);
        }
        if (name == null) { Console.Error.WriteLine("docker: --name is required by this fake"); return 125; }
        if (code != 0) {
            // like the real docker, a failed run can leave the container it created behind (FAKE_RUN_D_LEAVE=1)
            if (Env("FAKE_RUN_D_LEAVE") == "1") WriteState(name, "created", 0, "0001-01-01T00:00:00Z", label, policy);
            Console.Error.WriteLine("docker: Error response from daemon: fake failure");
            return code;
        }
        if (ReadState(name) != null) { Console.Error.WriteLine("docker: Error response from daemon: Conflict. The container name \"" + name + "\" is already in use"); return 125; }
        string status = Env("FAKE_RUN_D_STATUS");
        string startedAt = Tick();
        WriteState(name, string.IsNullOrEmpty(status) ? "running" : status, 0, startedAt, label, policy);
        if (status == "exited") LogLine(name, startedAt, "fatal: the fake satellite stopped on purpose");
        else LogStart(name, startedAt);
        // A container ID that is not the test secret's digits (the secret must be findable nowhere but in the secrets folder).
        Console.Out.WriteLine("a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718");
        return 0;
    }

    static int RunOneShot(string[] args) {
        int entry = Array.IndexOf(args, "--entrypoint");
        if (entry < 0 || entry + 4 >= args.Length) { Console.Error.WriteLine("fake docker: not a one-shot tool call"); return 64; }
        string sub = args[entry + 4];
        bool terminal = Array.IndexOf(args, "-it") >= 0;
        var mounts = new Dictionary<string, string>();
        var readOnly = new List<string>();
        for (int i = 0; i + 1 < args.Length; i++) {
            if (args[i] != "--mount") continue;
            string source = null, target = null;
            bool ro = false;
            foreach (string field in args[i + 1].Split(',')) {
                if (field.StartsWith("source=")) source = field.Substring(7);
                else if (field.StartsWith("target=")) target = field.Substring(7);
                else if (field == "readonly") ro = true;
            }
            if (target != null) { mounts[target] = source; if (ro) readOnly.Add(target); }
        }
        int forced = ExitFrom("FAKE_EXIT_" + sub.Replace('-', '_'), 0);
        // FAKE_STDERR_EXTRA: one more standard-error line (not an INFO: line) from every subcommand, for the rule that only
        // INFO: lines are hidden
        if (Env("FAKE_STDERR_EXTRA") != null) Console.Error.WriteLine(Env("FAKE_STDERR_EXTRA"));
        // Like the real tool, every subcommand writes INFO lines to STDERR on success: a script that read stderr as failure
        // (Windows PowerShell 5.1 does, under $ErrorActionPreference 'Stop') would fail every one of them.
        if (sub == "check-gpu") {
            if (forced == 0) Console.Error.WriteLine("INFO: check-gpu: looked at the cards PyTorch can use");
            if (forced == 0 && Env("FAKE_NO_CARDS") != "1") Console.Out.WriteLine("card=0\tNVIDIA GeForce RTX 4090");
            return forced;
        }
        if (sub == "fetch-model") {
            if (!mounts.ContainsKey("/models/vocalis") || readOnly.Contains("/models/vocalis")) { Console.Error.WriteLine("models mount missing or read-only"); return 1; }
            // progress is plain text on STDOUT (only the exit code is a contract) and INFO goes to stderr
            if (forced == 0) Console.Error.WriteLine("INFO: fetch-model: stderr line on success");
            Console.Out.WriteLine("fake fetch-model: " + (forced == 0 ? "all files verified" : "failed"));
            return forced;
        }
        if (sub == "show") {
            string certs = Path.Combine(mounts["/data/vocalis-satellite"], "certs");
            if (!File.Exists(Path.Combine(certs, "cert.pem"))) { Console.Error.WriteLine("no certificate"); return 5; }
            if (forced != 0) return forced;
            Console.Error.WriteLine("INFO: show: certificate read");
            Console.Out.WriteLine("fingerprint=" + File.ReadAllText(Path.Combine(certs, "fingerprint.txt")).Trim());
            // The real tool reports the certificate itself: loopback and localhost are always in its lists, and the
            // addresses come sorted numerically (not in the order they were given), so "primary first" in the script's
            // closing lines can only come from the script's own primary.
            var ipList = new List<string>();
            var dnsList = new List<string>();
            ipList.Add("127.0.0.1");
            dnsList.Add("localhost");
            foreach (string line in File.ReadAllLines(Path.Combine(certs, "addresses.txt"))) {
                if (line.StartsWith("ip=")) ipList.Add(line.Substring(3));
                else if (line.StartsWith("dns=")) dnsList.Add(line.Substring(4));
            }
            ipList.Sort(CompareIps);
            dnsList.Sort(StringComparer.Ordinal);
            foreach (string ip in ipList) Console.Out.WriteLine("ip=" + ip);
            Console.Out.WriteLine("ip=::1");
            foreach (string d in dnsList) Console.Out.WriteLine("dns=" + d);
            return 0;
        }
        if (sub == "provision") return Provision(args, entry + 5, mounts, readOnly, terminal, forced);
        Console.Error.WriteLine("fake docker: unknown subcommand " + sub);
        return 64;
    }

    static int Provision(string[] args, int from, Dictionary<string, string> mounts, List<string> readOnly, bool terminal, int forced) {
        if (forced != 0) { Console.Error.WriteLine("fake provision: failing on purpose"); return forced; }
        if (!mounts.ContainsKey("/data/vocalis-satellite") || readOnly.Contains("/data/vocalis-satellite") ||
            !mounts.ContainsKey("/run/secrets") || readOnly.Contains("/run/secrets")) {
            Console.Error.WriteLine("fake provision: data and secrets must be writable mounts");
            return 1;
        }
        string name = "", data = mounts["/data/vocalis-satellite"], secrets = mounts["/run/secrets"];
        bool fromFile = false, newSecret = false, newCert = false;
        var ips = new List<string>();
        var dns = new List<string>();
        for (int i = from; i < args.Length; i++) {
            if (args[i] == "--name") name = args[++i];
            else if (args[i] == "--ip") ips.Add(args[++i]);
            else if (args[i] == "--dns") dns.Add(args[++i]);
            else if (args[i] == "--secret-from-file") fromFile = true;
            else if (args[i] == "--new-secret") newSecret = true;
            else if (args[i] == "--new-certificate") newCert = true;
            else { Console.Error.WriteLine("fake provision: usage: " + args[i]); return 2; }
        }
        // Half a certificate pair is a configuration problem the real tool refuses (exit 5, naming --new-certificate)
        // before it replaces anything; it does not quietly make a new pair.
        string certDir = Path.Combine(data, "certs");
        if (!newCert && File.Exists(Path.Combine(certDir, "cert.pem")) != File.Exists(Path.Combine(certDir, "key.pem"))) {
            Console.Error.WriteLine("fake provision: only one of cert.pem and key.pem exists; use --new-certificate to replace the pair");
            return 5;
        }
        string secretPath = Path.Combine(secrets, "vocalis-satellite-master");
        if (newSecret || !File.Exists(secretPath)) {
            string value;
            if (fromFile) {
                if (!mounts.ContainsKey("/run/provision/secret") || !readOnly.Contains("/run/provision/secret")) { Console.Error.WriteLine("fake provision: the secret file must be a read-only mount"); return 4; }
                value = File.ReadAllText(mounts["/run/provision/secret"]).Trim();
                if (!Regex.IsMatch(value, "^[0-9a-fA-F]{64}$")) { Console.Error.WriteLine("The secret is not 64 hexadecimal characters."); return 4; }
            } else {
                if (!terminal) { Console.Error.WriteLine("The secret has to be typed at a terminal."); return 4; }
                value = new string('c', 64);
            }
            File.WriteAllText(secretPath, value);
            Console.Out.WriteLine("secret=written");
        } else {
            Console.Out.WriteLine("secret=kept");
        }
        string certs = Path.Combine(data, "certs");
        Directory.CreateDirectory(certs);
        if (newCert || !File.Exists(Path.Combine(certs, "cert.pem")) || !File.Exists(Path.Combine(certs, "key.pem"))) {
            File.WriteAllText(Path.Combine(certs, "cert.pem"), "FAKE CERTIFICATE\n");
            File.WriteAllText(Path.Combine(certs, "key.pem"), "FAKE PRIVATE KEY\n");
            var lines = new StringBuilder();
            foreach (string ip in ips) lines.Append("ip=" + ip + "\n");
            foreach (string d in dns) lines.Append("dns=" + d + "\n");
            File.WriteAllText(Path.Combine(certs, "addresses.txt"), lines.ToString());
            string counterPath = Path.Combine(certs, "counter.txt");
            int counter = File.Exists(counterPath) ? int.Parse(File.ReadAllText(counterPath).Trim()) : 0;
            counter++;
            File.WriteAllText(counterPath, counter.ToString());
            File.WriteAllText(Path.Combine(certs, "fingerprint.txt"), "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:" + counter.ToString("X2"));
            Console.Out.WriteLine("certificate=created");
        } else {
            Console.Out.WriteLine("certificate=kept");
        }
        File.WriteAllText(Path.Combine(data, "satellite.yaml"), "name: " + name + "\nhost: 0.0.0.0\nport: 7880\n");
        Console.Error.WriteLine("INFO: config: satellite.yaml (written)");
        Console.Out.WriteLine("fingerprint=" + File.ReadAllText(Path.Combine(certs, "fingerprint.txt")).Trim());
        Console.Out.WriteLine("ip=127.0.0.1");
        Console.Out.WriteLine("dns=localhost");
        return 0;
    }
}
"""


@pytest.fixture(scope="session")
def fake_docker(tmp_path_factory):
    """Path of the compiled fake docker (copied by each test to docker.exe). Compiled once per session."""
    if POWERSHELL is None:
        pytest.skip("Windows PowerShell 5.1 is required")
    work = tmp_path_factory.mktemp("fake-docker")
    source = work / "fake-docker.cs"
    source.write_text(FAKE_DOCKER_SOURCE, encoding="ascii")
    maker = work / "make-fake-docker.ps1"
    maker.write_text(
        "param([string]$Source, [string]$Out)\n"
        "Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $Source) -OutputAssembly $Out -OutputType ConsoleApplication\n",
        encoding="ascii")
    exe = work / "fake-docker.exe"
    result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(maker), "-Source", str(source), "-Out", str(exe)],
                            capture_output=True, text=True, timeout=180)
    assert result.returncode == 0 and exe.is_file(), result.stdout + result.stderr
    return exe


# ---- the bench: runs the real script against the fake ---------------------------------------------------------------

def forward(path):
    return str(path).replace("\\", "/")


def mount(source, target, readonly=False):
    return f"type=bind,source={forward(source)},target={target}" + (",readonly" if readonly else "")


def one_shot(image, subcommand, sub_args=(), mounts=(), *, terminal=False, network_none=True, gpu=False):
    """The one-shot argument list as the design's run specification and this script's documented order give it."""
    # The token order agreed with satellite-setup.sh (October 10, 2026): -it after --network none and before the mounts,
    # the GPU options after the mounts.
    arguments = ["run", "--rm", "--read-only", "--tmpfs", "/tmp", "--user", "1000:1000"]
    arguments += ["--network", "none"] if network_none else []
    arguments += ["-it"] if terminal else []
    for item in mounts:
        arguments += ["--mount", item]
    arguments += ["--gpus", "all"] if gpu else []
    return arguments + ["--entrypoint", "python", image, ADMIN_TOOL, subcommand, *sub_args]


def long_lived(satellite_id, port, image, root, restart="unless-stopped"):
    """(full argument list, spec hash). The hash covers the list after `run -d` without the hash label itself. `restart` is the
    --restart token: unless-stopped for -Autostart on (the default), no for off."""
    hashed = ["--name", f"vocalis-satellite-{satellite_id}", "--restart", restart, "--read-only", "--user", "1000:1000",
              "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m", "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
              "--label", f"vocalis.satellite.id={satellite_id}"]
    tail = ["--publish", f"0.0.0.0:{port}:7880",
            "--mount", mount(root / "data", "/data/vocalis-satellite", True),
            "--mount", mount(root / "secrets", "/run/secrets", True),
            "--mount", mount(root / "logs", "/logs/vocalis-satellite"),
            "--mount", mount(root / "work", "/work/vocalis-satellite"),
            "--mount", mount(root / "cache", "/cache/vocalis"),
            "--mount", mount(root / "models", "/models/vocalis", True),
            "--gpus", "all", image]
    digest = hashlib.sha256("\n".join(hashed + tail).encode("utf-8")).hexdigest()
    return ["run", "-d"] + hashed + ["--label", f"vocalis.satellite.spec={digest}"] + tail, digest


def ps_quote(token):
    if re.fullmatch(r"-[A-Za-z]+", token):
        return token
    return "'" + token.replace("'", "''") + "'"


class Result:
    def __init__(self, completed, calls, envlog, sleeps, flaglog=""):
        self.rc = completed.returncode
        self.out_bytes = completed.stdout
        self.err_bytes = completed.stderr
        # The script writes UTF-8 when its output is redirected (its first act), so that is how it is read here.
        self.out = completed.stdout.decode("utf-8", errors="replace")
        self.err = completed.stderr.decode("utf-8", errors="replace")
        self.text = self.out + self.err
        self.all_calls = calls  # docker argument lists, in order, every one
        self.calls = [call for call in calls if call_kind(call) != "result-inspect"]  # the run's own calls (see kinds())
        self.envlog = envlog
        self.sleeps = sleeps
        self.flaglog = flaglog

    def kinds(self):
        """The calls the run itself made. The one inspection at the end of a FAILED run (it asks Docker whether the satellite
        is running, for the result file) has its own kind, "result-inspect", and is left out here so that every
        assertion about what a run did stays about what it did; all_kinds() has it."""
        return [call_kind(call) for call in self.calls]

    def all_kinds(self):
        return [call_kind(call) for call in self.all_calls]

    def of_kind(self, kind):
        return [call for call in self.calls if call_kind(call) == kind]


def call_kind(call):
    if call[0] == "info":
        return "info"
    if call[:2] == ["image", "inspect"]:
        return "image-inspect"
    if call[0] == "pull":
        return "pull"
    if call[:2] == ["container", "inspect"]:
        return "result-inspect" if call[2:4] == ["--format", "{{.State.Status}}"] else "inspect"
    if call[0] in ("rm", "start", "restart", "stop", "update"):
        return call[0]
    if call[0] == "logs":
        return "logs-tail" if "--tail" in call else "logs"
    if call[0] == "run" and call[1] == "-d":
        return "run-d"
    if call[0] == "run" and "--entrypoint" in call:
        return call[call.index("--entrypoint") + 4]
    return "other:" + " ".join(call)


class Bench:
    def __init__(self, tmp_path, fake_docker_exe):
        self.tmp = tmp_path
        self.bin = tmp_path / "fakebin"
        self.bin.mkdir()
        shutil.copy(fake_docker_exe, self.bin / "docker.exe")
        self.state = tmp_path / "state"
        self.state.mkdir()
        self.localappdata = tmp_path / "localappdata"
        self.root = tmp_path / "sat root"  # a space on purpose: every mount source must survive it
        self.secret_file = tmp_path / "secret.txt"
        self.secret_file.write_text(SECRET, encoding="ascii")
        self.port = free_port()
        self.log = tmp_path / "fake.log"
        self.envlog = tmp_path / "fake-env.log"
        self.sleeplog = tmp_path / "sleeps.log"
        self.flaglog = tmp_path / "fake-flags.log"
        self.runs = 0
        self.script = SCRIPT  # the unstamped script; stamp() swaps in a temporary copy with a default image

    def stamp(self, image):
        """Runs from now on use a temporary copy of the script whose stamp line carries `image`, as a release does."""
        text = script_text()
        assert text.count("$DefaultImageCuda = ''") == 1
        folder = self.tmp / "stamped"
        folder.mkdir(exist_ok=True)
        self.script = folder / "satellite-setup.ps1"
        self.script.write_text(text.replace("$DefaultImageCuda = ''", f"$DefaultImageCuda = '{image}'"), encoding="ascii", newline="\n")

    @property
    def satellite_env(self):
        return self.root / "satellite.env"

    def env_values(self):
        return dict(line.split("=", 1) for line in self.satellite_env.read_text(encoding="utf-8").splitlines())

    def container_file(self, satellite_id=None):
        satellite_id = satellite_id or self.env_values()["SATELLITE_ID"]
        return self.state / f"vocalis-satellite-{satellite_id}.container"

    def run(self, *args, network=None, env=None, input="", docker=True, timeout=300, warp=1, cwd=None):
        """`warp` speeds up the clock the wait reads (Get-Date is stood in for: real elapsed time times `warp`, plus every
        Start-Sleep, which does not sleep). `cwd` is PowerShell's location (Set-Location) for the script, not the process's."""
        command, environment = self.launch(*args, network=network, env=env, docker=docker, warp=warp, cwd=cwd)
        completed = subprocess.run(command, capture_output=True, timeout=timeout, env=environment, input=input.encode("utf-8"))
        return self.collect(completed)

    def start(self, *args, **keywords):
        """Starts a run without waiting for it (a run the test will stop): the Popen, its stdout and stderr in files."""
        command, environment = self.launch(*args, **keywords)
        out = open(self.tmp / "started.out", "wb")
        err = open(self.tmp / "started.err", "wb")
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env=environment)
        process.test_files = (out, err)
        return process

    def collect(self, completed):
        calls = [line.split("\t")[1:] for line in self.log.read_text(encoding="utf-8").splitlines() if line.startswith("docker\t")]
        sleeps = [float(line) for line in self.sleeplog.read_text(encoding="ascii").split()]
        return Result(completed, calls, self.envlog.read_text(encoding="utf-8", errors="replace"), sleeps,
                      self.flaglog.read_text(encoding="utf-8"))

    def launch(self, *args, network=None, env=None, docker=True, warp=1, cwd=None):
        self.runs += 1
        for path in (self.log, self.envlog, self.sleeplog, self.flaglog):
            path.write_text("", encoding="ascii")
        data = self.tmp / "network.json"
        data.write_text(json.dumps(total_metric_routes(sample_network()) if network is None else network), encoding="ascii")
        wrapper = self.tmp / f"wrapper{self.runs}.ps1"
        wrapper.write_text(
            "$ErrorActionPreference = 'Stop'\n"
            f"$Sample = Get-Content -Raw -LiteralPath '{data}' | ConvertFrom-Json\n"
            "function Get-NetAdapter { @($Sample.adapters) | ForEach-Object { [pscustomobject]@{ Name = $_.name; InterfaceDescription = $_.description; InterfaceIndex = [int]$_.index; Status = $_.status } } }\n"
            "function Get-NetIPAddress { @($Sample.addresses) | ForEach-Object { [pscustomobject]@{ InterfaceIndex = [int]$_.index; IPAddress = $_.ip; AddressState = $_.state } } }\n"
            "function Get-NetIPInterface { @($Sample.interfaces) | ForEach-Object { [pscustomobject]@{ InterfaceIndex = [int]$_.index; InterfaceMetric = [int]$_.metric } } }\n"
            "function Get-NetRoute { @($Sample.routes) | ForEach-Object { [pscustomobject]@{ DestinationPrefix = $_.prefix; InterfaceIndex = [int]$_.index; RouteMetric = [int]$_.metric } } }\n"
            f"$global:ClockStart = [datetime]::UtcNow; $global:Slept = 0.0; $global:Warp = {warp}\n"
            "function Get-Date { ([datetime]'2026-01-01T00:00:00').AddSeconds((([datetime]::UtcNow - $global:ClockStart).TotalSeconds * $global:Warp) + $global:Slept) }\n"
            f"function Start-Sleep {{ param([double]$Seconds = 0, [int]$Milliseconds = 0) $global:Slept += $Seconds; Add-Content -LiteralPath '{self.sleeplog}' -Value \"$Seconds\" }}\n"
            + (f"Set-Location -LiteralPath '{cwd}'\n" if cwd else "") +
            f"& '{self.script}' " + " ".join(ps_quote(str(token)) for token in args) + "\n"
            "exit $LASTEXITCODE\n",
            encoding="utf-8-sig")
        environment = os.environ.copy()
        for name in [name for name in environment if name.upper().startswith("FAKE_")]:
            del environment[name]
        # System32 is on every real PATH (the script's bounded runner needs taskkill.exe from it); docker is only where the fake is.
        environment["PATH"] = ((str(self.bin) + os.pathsep if docker else "") + str(Path(POWERSHELL).parent)
                               + os.pathsep + os.path.join(os.environ["SystemRoot"], "System32"))
        environment["LOCALAPPDATA"] = str(self.localappdata)
        environment.update({"FAKE_LOG": str(self.log), "FAKE_ENVLOG": str(self.envlog), "FAKE_STATE": str(self.state), "FAKE_FLAGLOG": str(self.flaglog)})
        environment.update({key: str(value) for key, value in (env or {}).items()})
        return [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper)], environment

    # ---- what a run leaves in the satellite folder (the setup log and the result file) ----------------------------------
    def setup_logs(self):
        folder = self.root / "logs"
        return sorted(folder.glob("setup-*.log")) if folder.is_dir() else []

    def newest_log(self):
        logs = self.setup_logs()
        assert logs, f"no setup log in {self.root / 'logs'}"
        return max(logs, key=lambda path: path.stat().st_mtime_ns)

    def log_text(self):
        return self.newest_log().read_text(encoding="utf-8")

    @property
    def result_path(self):
        return self.root / "setup-result.txt"

    def result_file(self):
        """setup-result.txt as {KEY: VALUE}, in file order; asserts the form (UTF-8, no BOM, LF, KEY=VALUE, no blank lines)."""
        raw = self.result_path.read_bytes()
        assert not raw.startswith(b"\xef\xbb\xbf") and b"\r" not in raw and raw.endswith(b"\n"), raw[:40]
        lines = raw.decode("utf-8").splitlines()
        assert all(re.fullmatch(r"[A-Z_]+=.*", line) for line in lines), lines
        return dict(line.split("=", 1) for line in lines)

    def first_run(self, *extra, **keywords):
        """A complete first run: -Image, a free -Port, a name, the secret from a file."""
        arguments = ["-Root", str(self.root), "-Image", IMAGE, "-Port", str(self.port), "-Name", "sat-test",
                     "-SecretFile", str(self.secret_file), *extra]
        return self.run(*arguments, **keywords)

    def again(self, *extra, **keywords):
        """A later run of the same folder: only -Root is needed, the rest is recorded."""
        env = dict(keywords.pop("env", {}) or {})
        env.setdefault("FAKE_IMAGE_LOCAL", "1")
        return self.run("-Root", str(self.root), *extra, env=env, **keywords)


@pytest.fixture
def bench(tmp_path, fake_docker):
    return Bench(tmp_path, fake_docker)


def assert_clean_calls(result):
    """Every mount source is a Windows drive path with forward slashes; nothing mentions WSL or /mnt."""
    for call in result.calls:
        for index, argument in enumerate(call):
            assert "/mnt/" not in argument and "wsl" not in argument.lower(), call
            if argument == "--mount":
                source = re.search(r"source=([^,]*)", call[index + 1]).group(1)
                assert re.match(r"^[A-Za-z]:/", source) and "\\" not in source, call[index + 1]


def assert_secret_not_leaked(bench, result):
    for secret in (SECRET, SECOND_SECRET):
        assert secret not in result.text
        assert secret not in result.envlog
        assert not any(secret in argument for call in result.calls for argument in call)


# ---- first run ---------------------------------------------------------------------------------------------------------

@needs_powershell
def test_first_run_makes_exactly_the_calls_of_the_run_specification_in_order(bench):
    result = bench.first_run("-Address", "nas.lan,192.168.1.99")
    assert result.rc == 0, result.text
    env = bench.env_values()
    satellite_id = env["SATELLITE_ID"]
    assert re.fullmatch(r"vs-[0-9a-f]{12}", satellite_id)
    root, port = bench.root, bench.port
    cache = mount(root / "cache", "/cache/vocalis")
    data_rw = mount(root / "data", "/data/vocalis-satellite")
    secrets_rw = mount(root / "secrets", "/run/secrets")
    provision_args = ["--name", "sat-test", "--ip", "192.168.1.50", "--ip", "192.168.1.60", "--ip", "192.168.1.99",
                      "--dns", "nas.lan", "--secret-from-file"]
    run_d, digest = long_lived(satellite_id, port, IMAGE, root)
    name = f"vocalis-satellite-{satellite_id}"
    assert result.calls[:8] == [
        ["info"],
        ["image", "inspect", IMAGE],
        ["pull", IMAGE],
        one_shot(IMAGE, "check-gpu", mounts=[cache], gpu=True),
        one_shot(IMAGE, "provision", provision_args, [cache, data_rw, secrets_rw, mount(bench.secret_file, "/run/provision/secret", True)]),
        one_shot(IMAGE, "show", mounts=[cache, mount(root / "data", "/data/vocalis-satellite", True)]),
        one_shot(IMAGE, "fetch-model", mounts=[cache, mount(root / "models", "/models/vocalis")], network_none=False),
        run_d,
    ], result.calls
    started = bench.container_file(satellite_id).read_text(encoding="utf-8").splitlines()[2]
    # the wait: the container is read, then read again inside the loop, and the log is read since the daemon's own start time
    assert result.calls[8:] == [["container", "inspect", "--format", result.calls[8][3], name],
                                ["container", "inspect", "--format", result.calls[8][3], name],
                                ["logs", "--since", started, name]], result.calls[8:]
    # the inspect format gained the restart policy on October 11, 2026
    assert result.calls[8][3] == ('{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{index .Config.Labels "vocalis.satellite.spec"}}'
                                  '|{{.HostConfig.RestartPolicy.Name}}')
    assert f"vocalis.satellite.spec={digest}" in run_d
    assert bench.container_file(satellite_id).read_text(encoding="utf-8").splitlines()[3] == digest
    assert result.sleeps == []  # the first look found the listening line
    assert_clean_calls(result)
    assert_secret_not_leaked(bench, result)
    # the listening line the wait found: in the log (and -Verbose); the quiet screen says only that the satellite is running
    assert "The satellite is listening" in bench.log_text() and "listening on https://0.0.0.0:7880" in bench.log_text()
    assert "The satellite is listening" not in result.out and f"The satellite {name} is running on port {port}." in result.out


@needs_powershell
def test_the_long_lived_container_arguments_are_in_the_documented_order_with_windows_mount_sources(bench):
    result = bench.first_run()
    assert result.rc == 0, result.text
    run_d = result.of_kind("run-d")[0]
    satellite_id = bench.env_values()["SATELLITE_ID"]
    root = bench.root
    flags = [argument for argument in run_d if argument.startswith("--")]
    assert flags == ["--name", "--restart", "--read-only", "--user", "--tmpfs", "--log-driver", "--log-opt", "--log-opt", "--label", "--label",
                     "--publish", "--mount", "--mount", "--mount", "--mount", "--mount", "--mount", "--gpus"], flags
    assert run_d[run_d.index("--log-driver"):run_d.index("--log-driver") + 6] == ["--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3"]
    assert run_d[:2] == ["run", "-d"] and run_d[-1] == IMAGE and run_d[-3:-1] == ["--gpus", "all"]
    assert "--init" not in run_d and "--shm-size" not in run_d and "--privileged" not in run_d and "-e" not in run_d and "--env" not in run_d
    assert f"0.0.0.0:{bench.port}:7880" in run_d
    assert [a for a in run_d if a.startswith("type=bind")] == [
        mount(root / "data", "/data/vocalis-satellite", True), mount(root / "secrets", "/run/secrets", True),
        mount(root / "logs", "/logs/vocalis-satellite"), mount(root / "work", "/work/vocalis-satellite"),
        mount(root / "cache", "/cache/vocalis"), mount(root / "models", "/models/vocalis", True)]
    # the label hash is the one a Linux script computes: SHA-256 of the arguments after run -d without the hash label,
    # joined by a line feed
    expected, digest = long_lived(satellite_id, bench.port, IMAGE, root)
    assert run_d == expected
    assert satellite_id in run_d[run_d.index("--name") + 1]
    # The hash in the script's own label, recomputed here from the script's own argument list (not from the helper): drop
    # run -d and the two tokens of the spec label, join by a line feed.
    label_at = run_d.index("--label", run_d.index("--label") + 1)
    assert run_d[label_at + 1].startswith("vocalis.satellite.spec=")
    own = run_d[2:label_at] + run_d[label_at + 2:]
    assert run_d[label_at + 1] == "vocalis.satellite.spec=" + hashlib.sha256("\n".join(own).encode("utf-8")).hexdigest()
    assert len(own) == len(run_d) - 4


@needs_powershell
def test_satellite_env_is_ascii_lf_without_a_bom_with_the_agreed_keys(bench):
    result = bench.first_run("-Address", "nas.lan")
    assert result.rc == 0, result.text
    raw = bench.satellite_env.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r" not in raw and raw.endswith(b"\n")
    raw.decode("ascii")
    lines = raw.decode("ascii").splitlines()
    assert [line.split("=", 1)[0] for line in lines] == ENV_KEYS
    env = bench.env_values()
    assert env["GPU_VARIANT"] == "cuda" and env["SATELLITE_ROOT"] == str(bench.root) and env["SATELLITE_IMAGE"] == IMAGE
    assert env["SATELLITE_PORT"] == str(bench.port) and env["SATELLITE_NAME"] == "sat-test"
    assert env["SERVICE_UID"] == "1000" and env["SERVICE_GID"] == "1000" and env["GPU_GIDS"] == ""
    assert env["IP_ADDRESSES"] == "192.168.1.50,192.168.1.60" and env["DNS_NAMES"] == "nas.lan"
    for folder in ("data", "secrets", "models", "logs", "work", "cache"):
        assert (bench.root / folder).is_dir(), folder


@needs_powershell
def test_satellite_env_is_written_before_any_folder_and_before_the_image_pull(bench):
    # step 1 writes satellite.env first; a run that fails at the pull leaves a folder the same command accepts
    result = bench.first_run(env={"FAKE_PULL_EXIT": 1})
    assert result.rc == 1 and "docker pull failed with exit code 1" in result.out, result.text
    assert bench.satellite_env.is_file()
    assert result.kinds() == ["info", "image-inspect", "pull"]
    assert bench.env_values()["IP_ADDRESSES"] == ""
    again = bench.again("-SecretFile", str(bench.secret_file), "-Port", str(bench.port))  # image, name, port come from satellite.env
    assert again.rc == 0, again.text
    assert again.of_kind("run-d") and bench.env_values()["SATELLITE_IMAGE"] == IMAGE


@needs_powershell
def test_closing_lines_after_a_first_setup_are_the_short_block_and_the_rest_is_in_the_log(bench):
    result = bench.first_run("-Address", "nas.lan,192.168.1.99")
    assert result.rc == 0, result.text
    out = result.out
    satellite_id = bench.env_values()["SATELLITE_ID"]
    cert = bench.root / "data" / "certs" / "cert.pem"
    fingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:01"
    # the closing block of October 11, 2026, pinned line for line (design, "Script changes" item 3)
    lines = out.splitlines()
    start = lines.index("One thing left: give Vocalis this satellite's certificate.")
    assert lines[start:start + 6] == [
        "One thing left: give Vocalis this satellite's certificate.",
        f"  File to upload:  {cert}",
        f"  Fingerprint:     {fingerprint}",
        "If your browser is on another computer, copy that file there first.",
        "In Vocalis: Settings, Satellites, \"Upload certificate...\" on this satellite's row. Then tick its card.",
        f"Satellite address: https://192.168.1.50:{bench.port}",
    ], lines[start:start + 8]
    assert "Load" not in "\n".join(lines[start:start + 6]) and "three steps" not in out and "Press Load" not in out
    # One address on the screen (the primary); the others are in the result file and the log. A name is never a URL.
    assert f"https://192.168.1.60:{bench.port}" not in out and f"https://192.168.1.99:{bench.port}" not in out
    assert "https://nas.lan" not in out and "https://nas.lan" not in bench.result_file()["URLS"]
    assert bench.result_file()["URLS"] == ",".join(f"https://{ip}:{bench.port}" for ip in ("192.168.1.50", "192.168.1.60", "192.168.1.99"))
    # What left the closing lines (design item 3): the firewall command, the notes on restarting and the stop, start, update
    # and remove commands. One line points at the guide's Network section, and the log path is printed once, last.
    for gone in ("New-NetFirewallRule", "never forward the port from the internet", "Start Docker Desktop when you sign in",
                 "docker stop", "docker start", "-Update -Image", "-Remove", "as private as that folder", "Network:"):
        assert gone not in out, gone
    assert 'If Vocalis cannot reach this satellite, see "Network" in the satellite guide.' in lines[start + 6:]
    log_path = bench.newest_log()
    assert lines[-1] == f"Setup log: {log_path}" and out.count("Setup log:") == 1
    # ... and they are in the log
    log = bench.log_text()
    assert (f"New-NetFirewallRule -DisplayName 'Vocalis satellite {bench.port}' -Direction Inbound -Protocol TCP "
            f"-LocalPort {bench.port} -Action Allow -Profile Private") in log
    assert "never forward the port from the internet" in log
    assert "Start Docker Desktop when you sign in" in log and "nothing runs before you sign in" in log
    assert f"docker stop vocalis-satellite-{satellite_id}" in log and f"docker start vocalis-satellite-{satellite_id}" in log
    assert "-Update -Image" in log and "-Remove" in log and "as private as that folder" in log
    # the firewall command is only printed: nothing but known docker calls was made
    assert not any(kind.startswith("other:") for kind in result.kinds())
    # -Help carries them too (design: "they are in the guide, in --help, and in the log")
    help_text = bench.run("-Help").out
    assert "New-NetFirewallRule" in help_text and "docker stop vocalis-satellite-<id>" in help_text and "-Update" in help_text and "-Remove" in help_text


@needs_powershell
def test_the_default_folder_and_name_come_from_localappdata_and_the_computer_name(bench):
    result = bench.run("-Image", IMAGE, "-Port", str(bench.port), "-SecretFile", str(bench.secret_file))
    assert result.rc == 0, result.text
    root = bench.localappdata / "VocalisDocker" / "satellite"
    assert (root / "satellite.env").is_file()
    values = dict(line.split("=", 1) for line in (root / "satellite.env").read_text(encoding="utf-8").splitlines())
    assert values["SATELLITE_NAME"] == os.environ["COMPUTERNAME"].lower()
    assert values["SATELLITE_ROOT"] == str(root)


@needs_powershell
def test_an_address_the_adapters_cannot_supply_can_be_given_with_address(bench):
    result = bench.first_run("-Address", "192.168.1.5", network=NO_NETWORK)
    assert result.rc == 0, result.text
    provision = result.of_kind("provision")[0]
    ips = [provision[i + 1] for i, a in enumerate(provision) if a == "--ip"]
    assert ips == ["192.168.1.5"]
    assert bench.env_values()["IP_ADDRESSES"] == "192.168.1.5"


@needs_powershell
def test_the_primary_address_is_the_one_on_the_lowest_metric_default_route(bench):
    result = bench.first_run(network=total_metric_routes(sample_network(wifi_metric=5)))
    assert result.rc == 0, result.text
    provision = result.of_kind("provision")[0]
    assert [provision[i + 1] for i, a in enumerate(provision) if a == "--ip"] == ["192.168.1.60", "192.168.1.50"]
    # the screen shows the primary only; the result file has every URL, primary first
    assert f"Satellite address: https://192.168.1.60:{bench.port}" in result.out.splitlines()
    assert bench.result_file()["URLS"] == f"https://192.168.1.60:{bench.port},https://192.168.1.50:{bench.port}"


# ---- refusals (step 1) ------------------------------------------------------------------------------------------------

REFUSALS_BEFORE_DOCKER = [
    ("no image", [], "-Image is required"),
    ("tag, not digest", ["-Image", "registry.example/x:latest"], "@sha256:<64 hex digits>"),
    ("short digest", ["-Image", "registry.example/x@sha256:abc"], "@sha256:<64 hex digits>"),
    ("update with no image anywhere", ["-Update"], "-Update needs the image to switch to"),
    ("update with new secret", ["-Update", "-Image", NEW_IMAGE, "-NewSecret"], "cannot be combined"),
    ("remove with other options", ["-Remove", "-Port", "7000"], "-Remove stands alone"),
    ("bad address", ["-Image", IMAGE, "-Address", "fe80::1"], "IPv6"),
    ("loopback address", ["-Image", IMAGE, "-Address", "127.0.0.1"], "loopback"),
    ("bad name", ["-Image", IMAGE, "-Name", "bad name"], "must start with a letter or digit"),
    ("missing secret file", ["-Image", IMAGE, "-SecretFile", "{tmp}\\nope.txt"], "is not an existing file"),
    ("comma in root", ["-Image", IMAGE, "-Root", "{tmp}\\a,b"], "cannot contain a comma"),
    ("apostrophe in root", ["-Image", IMAGE, "-Root", "{tmp}\\it's"], "cannot contain an apostrophe"),
    ("line break in root", ["-Image", IMAGE, "-Root", "{tmp}\\a\nb"], "cannot contain a line break"),
    ("network folder root", ["-Image", IMAGE, "-Root", "\\\\server\\share\\sat"], "network (UNC) path"),
    ("comma in secret file path", ["-Image", IMAGE, "-SecretFile", "{tmp}\\a,b.txt"], "cannot contain a comma"),
    ("no console and no secret file", ["-Image", IMAGE], "no console is attached"),
]


@needs_powershell
@pytest.mark.parametrize("label, arguments, message", REFUSALS_BEFORE_DOCKER, ids=[case[0] for case in REFUSALS_BEFORE_DOCKER])
def test_refusals_happen_before_docker_is_called_and_before_anything_is_created(bench, label, arguments, message):
    arguments = [argument.replace("{tmp}", str(bench.tmp)) for argument in arguments]
    root_given = "-Root" in arguments
    if not root_given:
        arguments += ["-Root", str(bench.root)]
    result = bench.run(*arguments)
    assert result.rc == 1 and message in result.out, result.text
    assert "ERROR:" in result.out
    assert result.calls == [], result.calls
    if not root_given:
        assert not bench.root.exists()
    assert not (bench.localappdata / "VocalisDocker").exists()


@needs_powershell
def test_a_folder_that_is_neither_empty_nor_a_satellite_folder_is_refused_and_left_alone(bench):
    bench.root.mkdir()
    (bench.root / "photo.jpg").write_bytes(b"keep me")
    result = bench.first_run()
    assert result.rc == 1 and "not empty and is not a satellite folder" in result.out and result.calls == [], result.text
    assert [path.name for path in bench.root.iterdir()] == ["photo.jpg"] and (bench.root / "photo.jpg").read_bytes() == b"keep me"


@needs_powershell
def test_a_root_that_is_a_file_is_refused(bench):
    bench.root.write_text("not a folder", encoding="ascii")
    result = bench.first_run()
    assert result.rc == 1 and "is a file, not a folder" in result.out and result.calls == [], result.text


@needs_powershell
def test_a_drive_that_does_not_exist_is_refused(bench):
    letters = [letter for letter in "ZYXWVUTSRQPONMLKJ" if not Path(f"{letter}:\\").exists()]
    if not letters:
        pytest.skip("every drive letter is in use")
    result = bench.run("-Root", f"{letters[0]}:\\sat", "-Image", IMAGE, "-SecretFile", str(bench.secret_file))
    assert result.rc == 1 and "drive that does not exist" in result.out and result.calls == [], result.text


@needs_powershell
def test_without_any_usable_adapter_and_without_address_nothing_is_created(bench):
    result = bench.first_run(network=NO_NETWORK)
    assert result.rc == 1 and "No usable IPv4 address was found" in result.out and "-Address <IPv4 address>" in result.out, result.text
    assert result.calls == [] and not bench.root.exists()


@needs_powershell
def test_docker_missing_is_exit_10_and_an_unanswering_engine_is_exit_11(bench):
    missing = bench.first_run(docker=False)
    assert missing.rc == 10 and "docker.exe was not found on PATH" in missing.out and not bench.root.exists(), missing.text
    down = bench.first_run(env={"FAKE_INFO_EXIT": 1})
    assert down.rc == 11 and "docker info failed with exit code 1" in down.out and not bench.root.exists(), down.text
    assert down.kinds() == ["info"]


@needs_powershell
def test_a_busy_port_is_refused_before_anything_is_created(bench):
    with socket.socket() as holder:
        holder.bind(("0.0.0.0", bench.port))
        result = bench.first_run()
    assert result.rc == 1 and f"port {bench.port} is already in use on Windows" in result.out and "-Port <port>" in result.out, result.text
    assert result.kinds() == ["info"] and not bench.root.exists()


@needs_powershell
def test_a_port_held_by_this_folders_own_running_container_is_not_counted_as_taken(bench):
    assert bench.first_run().rc == 0
    with socket.socket() as holder:
        holder.bind(("0.0.0.0", bench.port))  # what Docker's published port looks like to a bind test
        running = bench.again()
        # a quiet run keeps the port line out of the screen (it is in the log); -Verbose shows it
        assert running.rc == 0 and "held by this satellite's own container" in bench.log_text(), running.text
        assert "held by this satellite's own container" not in running.out
        assert "held by this satellite's own container" in bench.again("-Verbose").out
        # stopped: it no longer holds the port, so the same busy port is now somebody else's
        lines = bench.container_file().read_text(encoding="utf-8").splitlines()
        lines[0] = "exited"
        bench.container_file().write_text("\n".join(lines) + "\n", encoding="utf-8")
        stopped = bench.again()
        assert stopped.rc == 1 and "already in use on Windows" in stopped.out, stopped.text
        # the port of an existing folder is fixed, so "choose another" would be wrong advice
        assert "not this satellite" in stopped.out and "the port is fixed for this folder" in stopped.out and "Choose another with -Port" not in stopped.out
        assert not stopped.of_kind("start") and not stopped.of_kind("run-d")


@needs_powershell
def test_no_card_in_the_container_is_exit_12_and_nothing_is_provisioned_or_started(bench):
    for env in ({"FAKE_EXIT_check_gpu": 3}, {"FAKE_NO_CARDS": 1}):
        result = bench.first_run(env=env)
        assert result.rc == 12 and "no NVIDIA card it can use" in result.out, result.text
        assert not result.of_kind("provision") and not result.of_kind("run-d")
        shutil.rmtree(bench.root)


@needs_powershell
def test_an_existing_folder_refuses_a_different_port_name_image_or_gpu_type_and_names_the_recorded_one(bench):
    assert bench.first_run().rc == 0
    different_port = bench.again("-Port", str(bench.port + 1))
    assert different_port.rc == 1 and f"uses port {bench.port}" in different_port.out and different_port.calls == [], different_port.text
    different_name = bench.again("-Name", "other")
    assert different_name.rc == 1 and "named 'sat-test'" in different_name.out and different_name.calls == [], different_name.text
    different_image = bench.again("-Image", NEW_IMAGE)
    assert different_image.rc == 1 and IMAGE in different_image.out and "-Update -Image" in different_image.out and different_image.calls == [], different_image.text
    same = bench.again("-Image", IMAGE, "-Port", str(bench.port), "-Name", "sat-test")
    assert same.rc == 0, same.text  # the recorded values, repeated, are fine
    text = bench.satellite_env.read_text(encoding="utf-8").replace("GPU_VARIANT=cuda", "GPU_VARIANT=rocm")
    bench.satellite_env.write_text(text, encoding="utf-8")
    rocm = bench.again()
    assert rocm.rc == 1 and "GPU type 'rocm'" in rocm.out and "NVIDIA (cuda) only" in rocm.out and rocm.calls == [], rocm.text


# ---- an unfinished folder adopts the image a plain run carries (October 11, 2026) ------------------------------

def make_unfinished(bench, missing):
    """A completed first run, then one of the products taken away: the folder is one whose setup never finished."""
    assert bench.first_run().rc == 0
    paths = {"secret": [bench.root / "secrets" / "vocalis-satellite-master"],
             "certificate": [bench.root / "data" / "certs" / "cert.pem", bench.root / "data" / "certs" / "key.pem"],
             "configuration": [bench.root / "data" / "satellite.yaml"]}[missing]
    for path in paths:
        path.unlink()


@needs_powershell
@pytest.mark.parametrize("missing", ["secret", "certificate", "configuration"])
def test_a_plain_run_with_another_image_adopts_it_on_a_folder_whose_setup_never_finished(bench, missing):
    make_unfinished(bench, missing)
    assert bench.env_values()["SATELLITE_IMAGE"] == IMAGE
    # the secret is needed only when it is the missing product: the wizard passes -SecretFile then, and not otherwise
    extra = ["-SecretFile", str(bench.secret_file)] if missing == "secret" else []
    result = bench.again("-Image", NEW_IMAGE, "-NoPrompt", *extra)
    assert result.rc == 0, result.text
    assert result.out.splitlines().count(ADOPT_LINE) == 1, result.text
    assert bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE  # recorded
    # the resumed first setup ran from the adopted image, and nothing was asked of the old one
    provision = result.of_kind("provision")
    assert len(provision) == 1 and NEW_IMAGE in provision[0] and not any(IMAGE in argument for call in result.calls for argument in call), result.calls
    assert not result.of_kind("pull") or all(NEW_IMAGE in call for call in result.of_kind("pull"))
    # MODE keeps the design's wording (item 4: first is "a secret or certificate still to be made"), and the steps left in
    # Vocalis follow it: a folder that lacked only its configuration file is a rerun with the hedged text, as on Linux.
    assert bench.result_file()["MODE"] == ("first" if missing != "configuration" else "rerun") and bench.result_file()["EXIT_CODE"] == "0"
    assert bench.result_file()["VOCALIS_STEPS"] == ("upload-and-tick" if missing != "configuration" else "maybe")
    assert bench.result_file()["IMAGE"] == NEW_IMAGE
    assert SECRET not in result.text
    # it is a finished satellite now: the next plain run with yet another image is refused again, and names -Update
    refused = bench.again("-Image", IMAGE)
    assert refused.rc == 1 and "-Update -Image" in refused.out and ADOPT_LINE not in refused.out and refused.calls == [], refused.text
    assert bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE


@needs_powershell
def test_the_same_image_on_an_unfinished_folder_says_nothing_about_adopting(bench):
    make_unfinished(bench, "certificate")
    result = bench.again("-Image", IMAGE)
    assert result.rc == 0 and ADOPT_LINE not in result.out and bench.env_values()["SATELLITE_IMAGE"] == IMAGE, result.text


@needs_powershell
def test_a_finished_folder_still_refuses_another_image_and_names_update_and_the_missing_configuration_makes_it_unfinished(bench):
    assert bench.first_run().rc == 0
    refused = bench.again("-Image", NEW_IMAGE)
    assert refused.rc == 1 and IMAGE in refused.out and "-Update -Image" in refused.out and ADOPT_LINE not in refused.out, refused.text
    assert refused.calls == [] and bench.env_values()["SATELLITE_IMAGE"] == IMAGE
    # -NewSecret and -NewCertificate do not make a finished folder an unfinished one
    for flag in ("-NewSecret", "-NewCertificate"):
        replaced = bench.again("-Image", NEW_IMAGE, flag, "-SecretFile", str(bench.secret_file))
        assert replaced.rc == 1 and "-Update -Image" in replaced.out and ADOPT_LINE not in replaced.out, (flag, replaced.text)
        assert bench.env_values()["SATELLITE_IMAGE"] == IMAGE
    # the same folder without its configuration file is unfinished, so the image is adopted
    (bench.root / "data" / "satellite.yaml").unlink()
    adopted = bench.again("-Image", NEW_IMAGE)
    assert adopted.rc == 0 and ADOPT_LINE in adopted.out and bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE, adopted.text


@needs_powershell
@pytest.mark.parametrize("missing", ["secret", "certificate", "configuration"])
def test_update_is_still_refused_on_an_unfinished_folder_and_does_not_adopt_anything(bench, missing):
    make_unfinished(bench, missing)
    result = bench.again("-Update", "-Image", NEW_IMAGE)
    assert result.rc == 1 and "not complete yet" in result.out and ADOPT_LINE not in result.out, result.text
    assert not result.of_kind("pull") and not result.of_kind("provision")
    assert bench.env_values()["SATELLITE_IMAGE"] == IMAGE


@needs_powershell
def test_the_small_autostart_operation_does_not_adopt_an_image_on_an_unfinished_folder(bench):
    # (-Remove stands alone, so it never reaches the image rule; the small -Autostart operation does, and keeps the refusal)
    make_unfinished(bench, "certificate")
    result = bench.again("-Autostart", "off", "-Image", NEW_IMAGE)
    assert result.rc == 1 and "-Update -Image" in result.out and ADOPT_LINE not in result.out, result.text
    assert bench.env_values()["SATELLITE_IMAGE"] == IMAGE


@needs_powershell
def test_an_adopted_image_with_a_needed_secret_and_no_secret_file_still_stops_on_the_fixed_plain_line(bench):
    make_unfinished(bench, "secret")
    result = bench.again("-Image", NEW_IMAGE, "-NoPrompt")
    # (an existing folder has a log, so its path follows the fixed line)
    assert result.rc == 1 and error_lines(result)[-1].startswith(NO_PROMPT_LINE) and ADOPT_LINE in result.out, result.text
    assert not result.of_kind("provision") and SECRET not in result.text


# ---- later runs -------------------------------------------------------------------------------------------------------

@needs_powershell
def test_rerun_with_the_same_label_and_a_running_container_leaves_it_alone_and_asks_for_nothing(bench):
    assert bench.first_run().rc == 0
    container = bench.container_file().read_bytes()
    result = bench.again()  # no -Image, -Port, -Name, -SecretFile and no console: nothing is needed
    assert result.rc == 0, result.text
    satellite_id = bench.env_values()["SATELLITE_ID"]
    name = f"vocalis-satellite-{satellite_id}"
    cache = mount(bench.root / "cache", "/cache/vocalis")
    # no check-gpu: the container is not going to be created again, so its card was proven when it was made
    assert [call_kind(call) for call in result.calls] == ["info", "inspect", "image-inspect", "show", "fetch-model", "inspect"], result.calls
    assert not result.of_kind("provision") and not result.of_kind("pull") and "GPU check skipped" in result.out
    assert result.of_kind("show")[0] == one_shot(IMAGE, "show", mounts=[cache, mount(bench.root / "data", "/data/vocalis-satellite", True)])
    log = bench.log_text()  # the decisions are in the log; the screen has the short form
    assert "left as it is" in log and "Port %d: held by this satellite's own container" % bench.port in log
    assert "left as it is" not in result.out and f"The satellite {name} is running on port {bench.port}." in result.out
    assert bench.container_file().read_bytes() == container  # untouched
    assert name in result.out


@needs_powershell
def test_rerun_with_a_missing_container_creates_it_again_with_the_same_arguments(bench):
    first = bench.first_run()
    assert first.rc == 0
    run_d = first.of_kind("run-d")[0]
    bench.container_file().unlink()
    result = bench.again()
    assert result.rc == 0, result.text
    assert result.of_kind("run-d") == [run_d] and not result.of_kind("rm") and not result.of_kind("provision")
    assert "creating it" in bench.log_text() and "creating it" not in result.out


@needs_powershell
def test_rerun_with_a_different_label_removes_the_container_and_creates_it_again(bench):
    first = bench.first_run()
    assert first.rc == 0
    run_d = first.of_kind("run-d")[0]
    name = run_d[run_d.index("--name") + 1]
    lines = bench.container_file().read_text(encoding="utf-8").splitlines()
    lines[3] = "0" * 64
    bench.container_file().write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = bench.again()
    assert result.rc == 0, result.text
    kinds = result.kinds()
    assert kinds.index("rm") < kinds.index("run-d") and result.of_kind("rm") == [["rm", "-f", name]]
    assert result.of_kind("run-d") == [run_d]
    assert "made with other settings" in bench.log_text() and "made with other settings" not in result.out


@needs_powershell
def test_rerun_with_the_same_label_and_a_stopped_container_starts_it_and_waits(bench):
    first = bench.first_run()
    assert first.rc == 0
    name = first.of_kind("run-d")[0][first.of_kind("run-d")[0].index("--name") + 1]
    lines = bench.container_file().read_text(encoding="utf-8").splitlines()
    lines[0] = "exited"
    bench.container_file().write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = bench.again()
    assert result.rc == 0, result.text
    assert result.of_kind("start") == [["start", name]] and not result.of_kind("run-d") and not result.of_kind("rm")
    assert result.kinds()[-3:] == ["inspect", "inspect", "logs"] and "listening on https://" in bench.log_text()
    assert "listening on https://" not in result.out  # the raw log line is for -Verbose and the log


@needs_powershell
def test_a_copied_or_moved_folder_is_refused_and_the_original_satellite_is_left_alone(bench):
    assert bench.first_run().rc == 0
    original_root = bench.root
    container_before = bench.container_file().read_bytes()
    copy = bench.tmp / "copied sat"
    shutil.copytree(original_root, copy)
    env_before = (copy / "satellite.env").read_bytes()
    # the copy carries the original's setup log and result file; a refused folder gets no new log and keeps its result file
    copied_result = (copy / "setup-result.txt").read_bytes()
    copied_logs = sorted(path.name for path in (copy / "logs").glob("setup-*.log"))
    assert copied_result and len(copied_logs) == 1
    bench.root = copy
    for arguments in ([], ["-Remove"], ["-Update", "-Image", NEW_IMAGE], ["-NewCertificate"]):
        result = bench.run("-Root", str(copy), *arguments)
        assert result.rc == 1, (arguments, result.text)
        assert "appears to have been moved or copied" in result.out and f"records the satellite folder as '{original_root}'" in result.out, result.text
        assert "new folder" in result.out and "-Remove" in result.out
        # nothing was asked of Docker, so the original's container is not touched
        assert result.calls == [], result.calls
    assert bench.container_file().read_bytes() == container_before
    assert (copy / "satellite.env").read_bytes() == env_before
    assert (copy / "setup-result.txt").read_bytes() == copied_result  # not deleted, not rewritten: the folder was refused
    assert sorted(path.name for path in (copy / "logs").glob("setup-*.log")) == copied_logs  # and no log was opened in it
    # the spelling of the same folder (case, a trailing separator) is not a move
    bench.root = original_root
    assert bench.run("-Root", str(original_root).upper() + "\\", env={"FAKE_IMAGE_LOCAL": "1"}).rc == 0


@needs_powershell
def test_a_certificate_that_no_longer_covers_the_address_is_reported_with_the_remedy(bench):
    assert bench.first_run().rc == 0
    # DHCP gave the machine another address: the certificate (192.168.1.50 and .60) no longer covers it
    moved = total_metric_routes(sample_network())
    for item in moved["addresses"]:
        if item["ip"] == "192.168.1.50":
            item["ip"] = "192.168.1.77"
    result = bench.again(network=moved)
    assert result.rc == 0, result.text
    assert "WARNING: the certificate does not cover 192.168.1.77" in result.out and "-NewCertificate" in result.out
    given = bench.again("-Address", "10.5.5.5,other.lan")
    assert given.rc == 0 and "does not cover 10.5.5.5, other.lan" in given.out, given.text
    assert not given.of_kind("provision")  # reported only; a new certificate is the user's decision


# ---- update ------------------------------------------------------------------------------------------------------------

@needs_powershell
def test_update_pulls_checks_the_model_with_the_new_image_and_only_then_records_and_recreates(bench):
    first = bench.first_run()
    assert first.rc == 0
    old_run = first.of_kind("run-d")[0]
    satellite_id = bench.env_values()["SATELLITE_ID"]
    name = f"vocalis-satellite-{satellite_id}"
    result = bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE)
    assert result.rc == 0, result.text
    kinds = result.kinds()
    # the agreed sequence: pull, check-gpu and fetch-model with the NEW image, record, recreate, wait, and only then show
    # The old container is stopped properly before it is removed, so the satellite writes its "exiting" line and the
    # break line to its log (October 11, 2026); the forced removal follows whatever the stop returned.
    assert kinds == ["info", "inspect", "image-inspect", "pull", "check-gpu", "fetch-model", "inspect", "stop", "rm", "run-d",
                     "inspect", "inspect", "logs", "show"], kinds
    assert result.of_kind("stop") == [["stop", "-t", "5", name]]
    assert result.of_kind("pull") == [["pull", NEW_IMAGE]]
    cache = mount(bench.root / "cache", "/cache/vocalis")
    assert result.of_kind("check-gpu") == [one_shot(NEW_IMAGE, "check-gpu", mounts=[cache], gpu=True)]
    assert result.of_kind("fetch-model") == [one_shot(NEW_IMAGE, "fetch-model", mounts=[cache, mount(bench.root / "models", "/models/vocalis")], network_none=False)]
    assert result.of_kind("show") == [one_shot(NEW_IMAGE, "show", mounts=[cache, mount(bench.root / "data", "/data/vocalis-satellite", True)])]
    new_run, new_digest = long_lived(satellite_id, bench.port, NEW_IMAGE, bench.root)
    assert result.of_kind("run-d") == [new_run] and new_run != old_run
    assert result.of_kind("rm") == [["rm", "-f", name]]
    assert not result.of_kind("provision")
    # the old image is used by nothing: no call after the first mention of the new image carries it
    assert not any(IMAGE in argument for call in result.calls for argument in call)
    assert bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE
    assert bench.container_file().read_text(encoding="utf-8").splitlines()[3] == new_digest
    assert_clean_calls(result)


@needs_powershell
@pytest.mark.parametrize("failure, code, message, last_call", [
    ({"FAKE_PULL_EXIT": 1}, 1, "docker pull failed with exit code 1", "pull"),
    ({"FAKE_EXIT_check_gpu": 3}, 12, "no NVIDIA card it can use", "check-gpu"),
    ({"FAKE_EXIT_fetch_model": 1}, 1, "model download or check did not finish (exit code 1)", "fetch-model"),
], ids=["pull", "gpu", "model"])
def test_an_update_that_fails_before_the_swap_leaves_the_running_satellite_and_satellite_env_as_they_were(bench, failure, code, message, last_call):
    first = bench.first_run()
    assert first.rc == 0, first.text
    env_before = bench.satellite_env.read_bytes()
    container_before = bench.container_file().read_bytes()
    result = bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE, env=failure)
    assert result.rc == code and message in result.out, result.text
    assert result.kinds()[-1] == last_call  # it stopped right there: nothing after it ran
    assert not result.of_kind("show") or last_call == "show"
    assert not result.of_kind("rm") and not result.of_kind("run-d") and not result.of_kind("start") and not result.of_kind("restart")
    assert bench.satellite_env.read_bytes() == env_before
    assert bench.container_file().read_bytes() == container_before


@needs_powershell
def test_update_with_a_local_image_does_not_pull_and_an_incomplete_folder_cannot_be_updated(bench):
    assert bench.first_run().rc == 0
    local = bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE, env={"FAKE_IMAGE_LOCAL": NEW_IMAGE})
    assert local.rc == 0 and not local.of_kind("pull") and "already on this machine" in local.out, local.text
    (bench.root / "secrets" / "vocalis-satellite-master").unlink()
    incomplete = bench.run("-Root", str(bench.root), "-Update", "-Image", IMAGE)
    assert incomplete.rc == 1 and "not complete yet" in incomplete.out, incomplete.text
    assert not incomplete.of_kind("pull")
    nothing = bench.run("-Root", str(bench.tmp / "nowhere"), "-Update", "-Image", IMAGE)
    assert nothing.rc == 1 and "nothing to update" in nothing.out and nothing.calls == [], nothing.text


@needs_powershell
def test_satellite_env_is_read_strictly_and_a_bad_file_is_refused_with_its_line_and_no_docker_call(bench):
    assert bench.first_run().rc == 0
    good = bench.satellite_env.read_text(encoding="utf-8")
    lines = good.splitlines()
    root_line = next(index for index, line in enumerate(lines) if line.startswith("SATELLITE_ROOT="))
    cases = {
        "missing SATELLITE_ROOT": ("\n".join(line for index, line in enumerate(lines) if index != root_line) + "\n", "has no SATELLITE_ROOT line"),
        "duplicated key": (good + "SATELLITE_PORT=7000\n", f"line {len(lines) + 1} repeats SATELLITE_PORT (first on line "),
        "malformed line": ("\n".join(lines[:3] + ["this is not a setting"] + lines[3:]) + "\n", "line 4 is not a KEY=VALUE line: 'this is not a setting'"),
        "unknown key": (good + "FUTURE_KEY=keep me\n", f"line {len(lines) + 1} has an unknown key 'FUTURE_KEY'"),
        "comment line": ("# written by hand\n" + good, "line 1 is not a KEY=VALUE line"),
        "blank line": (good + "\n", f"line {len(lines) + 1} is not a KEY=VALUE line"),
        "lower-case key": (good.replace("SERVICE_UID=", "service_uid="), "is not a KEY=VALUE line"),
    }
    for label, (text, message) in cases.items():
        bench.satellite_env.write_text(text, encoding="utf-8", newline="")
        for arguments in ([], ["-Remove"]):
            result = bench.again(*arguments)
            assert result.rc == 1 and message in result.out and str(bench.satellite_env) in result.out, (label, result.text)
            assert result.calls == [], (label, result.calls)
    # a file this script wrote is accepted, and an update keeps writing the same keys, each once
    bench.satellite_env.write_text(good, encoding="utf-8", newline="")
    assert bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE).rc == 0
    updated = bench.satellite_env.read_text(encoding="utf-8")
    assert [line.split("=", 1)[0] for line in updated.splitlines()] == ENV_KEYS and f"SATELLITE_IMAGE={NEW_IMAGE}" in updated and "\r" not in updated


# ---- the stamped default image (rule of October 10, 2026) ----------------------------------------------------------------

@needs_powershell
def test_a_first_run_uses_the_stamped_default_without_image_and_an_explicit_image_wins(bench):
    bench.stamp(IMAGE)
    result = bench.run("-Root", str(bench.root), "-Port", str(bench.port), "-Name", "sat-test", "-SecretFile", str(bench.secret_file))
    assert result.rc == 0 and result.of_kind("pull") == [["pull", IMAGE]], result.text
    assert bench.env_values()["SATELLITE_IMAGE"] == IMAGE
    other = bench.tmp / "other"
    bench.root = other
    result = bench.run("-Root", str(other), "-Image", NEW_IMAGE, "-Port", str(bench.port), "-Name", "sat-test", "-SecretFile", str(bench.secret_file))
    assert result.rc == 0 and result.of_kind("pull") == [["pull", NEW_IMAGE]], result.text
    assert bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE


@needs_powershell
def test_update_without_image_takes_the_new_image_from_the_stamped_default(bench):
    assert bench.first_run().rc == 0
    satellite_id = bench.env_values()["SATELLITE_ID"]
    bench.stamp(NEW_IMAGE)  # the setup file of the new release
    result = bench.run("-Root", str(bench.root), "-Update")
    assert result.rc == 0, result.text
    kinds = result.kinds()
    assert result.of_kind("pull") == [["pull", NEW_IMAGE]]
    assert kinds.index("pull") < kinds.index("fetch-model") < kinds.index("rm") < kinds.index("run-d")
    assert result.of_kind("run-d") == [long_lived(satellite_id, bench.port, NEW_IMAGE, bench.root)[0]]
    assert bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE
    assert "NOTE: this setup file is for a newer satellite image" not in result.out


@needs_powershell
def test_update_with_an_explicit_image_overrides_the_stamped_default(bench):
    assert bench.first_run().rc == 0
    third = "registry.example/vocalis-satellite-cuda@sha256:" + "c" * 64
    bench.stamp(NEW_IMAGE)
    result = bench.run("-Root", str(bench.root), "-Update", "-Image", third)
    assert result.rc == 0 and result.of_kind("pull") == [["pull", third]] and bench.env_values()["SATELLITE_IMAGE"] == third, result.text


@needs_powershell
@pytest.mark.parametrize("stamped, given", [(True, False), (False, True), (True, True)], ids=["stamped", "image", "both"])
def test_update_to_the_image_already_running_says_so_and_continues_as_a_plain_repair_run(bench, stamped, given):
    assert bench.first_run().rc == 0
    env_before = bench.satellite_env.read_bytes()
    container_before = bench.container_file().read_bytes()
    if stamped:
        bench.stamp(IMAGE)
    arguments = ["-Root", str(bench.root), "-Update"] + (["-Image", IMAGE] if given else [])
    result = bench.run(*arguments, env={"FAKE_IMAGE_LOCAL": "1"})
    assert result.rc == 0, result.text
    assert f"The satellite already runs that image ({IMAGE})" in result.out
    # a plain repair run: nothing pulled, nothing recreated, the model verified, the running container left alone
    assert not result.of_kind("pull") and not result.of_kind("rm") and not result.of_kind("run-d") and not result.of_kind("restart")
    assert result.of_kind("fetch-model") and result.of_kind("show")
    assert bench.satellite_env.read_bytes() == env_before and bench.container_file().read_bytes() == container_before


@needs_powershell
def test_a_plain_run_of_a_newer_releases_file_keeps_the_recorded_image_and_says_how_to_move(bench):
    assert bench.first_run().rc == 0
    bench.stamp(NEW_IMAGE)
    result = bench.again()  # no -Image, no -Update
    assert result.rc == 0, result.text
    assert not result.of_kind("pull") and not result.of_kind("rm") and not result.of_kind("run-d")
    assert bench.satellite_env.read_text(encoding="utf-8").count(f"SATELLITE_IMAGE={IMAGE}") == 1
    note = [line for line in result.out.splitlines() if line.startswith("NOTE: this setup file is for a newer satellite image")]
    assert len(note) == 1, result.out
    assert NEW_IMAGE in note[0] and IMAGE in note[0]
    assert f'-File "{bench.script}" -Root "{bench.root}" -Update' in note[0] and "-Update -Image" not in note[0] and note[0].endswith("-Update")
    # an explicit different -Image without -Update is still refused
    refused = bench.again("-Image", NEW_IMAGE)
    assert refused.rc == 1 and "-Update -Image" in refused.out and refused.calls == [], refused.text
    # no note when the stamped image is the recorded one, and none when -Image is given (it equals the recorded one)
    bench.stamp(IMAGE)
    assert "NOTE: this setup file" not in bench.again().out
    bench.stamp(NEW_IMAGE)
    assert "NOTE: this setup file" not in bench.again("-Image", IMAGE).out


@needs_powershell
@pytest.mark.parametrize("missing", ["secret", "certificate", "key", "configuration"])
def test_a_plain_run_with_no_image_adopts_the_stamped_default_on_an_unfinished_folder(bench, missing):
    assert bench.first_run().rc == 0
    paths = {"secret": bench.root / "secrets" / "vocalis-satellite-master", "certificate": bench.root / "data" / "certs" / "cert.pem",
             "key": bench.root / "data" / "certs" / "key.pem", "configuration": bench.root / "data" / "satellite.yaml"}
    paths[missing].unlink()
    bench.stamp(NEW_IMAGE)
    # the secret is the only product that needs the file; a missing half of the certificate pair is refused by the tool whatever
    # the image is, so for that case only the decision and the recorded value are checked
    extra = ["-SecretFile", str(bench.secret_file)] if missing == "secret" else []
    result = bench.again("-NoPrompt", *extra)
    assert result.out.splitlines().count(ADOPT_LINE) == 1 and "NOTE: this setup file" not in result.out, result.text
    assert bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE
    if missing in ("secret", "configuration"):
        assert result.rc == 0, result.text
        assert not any(IMAGE in argument for call in result.calls for argument in call), result.calls
        assert bench.result_file()["IMAGE"] == NEW_IMAGE


@needs_powershell
def test_a_finished_folder_keeps_the_note_and_the_recorded_image_with_a_stamped_default_and_the_small_operation_never_adopts(bench):
    assert bench.first_run().rc == 0
    bench.stamp(NEW_IMAGE)
    finished = bench.again()
    assert finished.rc == 0 and ADOPT_LINE not in finished.out and "NOTE: this setup file is for a newer satellite image" in finished.out, finished.text
    assert bench.env_values()["SATELLITE_IMAGE"] == IMAGE
    # the small -Autostart operation on an unfinished folder never adopts
    (bench.root / "data" / "certs" / "cert.pem").unlink()
    (bench.root / "data" / "certs" / "key.pem").unlink()
    small = bench.again("-Autostart", "off")
    assert ADOPT_LINE not in small.out and bench.env_values()["SATELLITE_IMAGE"] == IMAGE, small.text


@needs_powershell
def test_the_closing_update_line_is_short_when_the_file_is_stamped_and_names_the_image_when_it_is_not(bench):
    # The commands are in the setup log since October 11, 2026 (the closing lines no longer print them).
    unstamped = bench.first_run()
    assert unstamped.rc == 0 and "Update:" not in unstamped.out
    line = next(line for line in bench.log_text().splitlines() if "  Update:  " in line)
    assert line.endswith("-Update -Image <name>@sha256:<64 hex digits>") and "run from the setup file" not in line, line
    bench.stamp(IMAGE)
    stamped = bench.again()
    line = next(line for line in bench.log_text().splitlines() if "  Update:  " in line)
    assert "-Update " in line + " " and "-Update -Image" not in line and "(run from the setup file of the new release)" in line, line
    assert "-Update -Image" not in line.split("Update:")[1]
    help_text = bench.run("-Help").out
    assert "the one built into this file" in help_text


# ---- new secret, new certificate, remove -----------------------------------------------------------------------------------

@needs_powershell
def test_new_secret_replaces_the_secret_with_the_file_and_restarts_the_container(bench):
    first = bench.first_run()
    assert first.rc == 0
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    before = (bench.root / "data" / "certs" / "cert.pem").read_bytes()
    result = bench.again("-NewSecret", "-SecretFile", str(bench.secret_file))
    assert result.rc == 0, result.text
    cache = mount(bench.root / "cache", "/cache/vocalis")
    assert result.of_kind("provision") == [one_shot(IMAGE, "provision", ["--name", "sat-test", "--secret-from-file", "--new-secret"],
                                                    [cache, mount(bench.root / "data", "/data/vocalis-satellite"), mount(bench.root / "secrets", "/run/secrets"),
                                                     mount(bench.secret_file, "/run/provision/secret", True)])]
    assert result.of_kind("restart") == [["restart", name]] and not result.of_kind("rm") and not result.of_kind("run-d")
    assert result.kinds()[-3:] == ["inspect", "inspect", "logs"], "the restart is followed by the wait for the listening line"
    assert (bench.root / "secrets" / "vocalis-satellite-master").read_text(encoding="ascii") == SECOND_SECRET  # what the fake tool wrote
    assert (bench.root / "data" / "certs" / "cert.pem").read_bytes() == before  # the certificate is kept
    assert_secret_not_leaked(bench, result)
    # said at the prompt only: a secret that comes from a file was already copied out of Vocalis (log and -Verbose have it)
    assert 'choose "New secret..." for this satellite in Vocalis first' not in result.out
    assert 'choose "New secret..." for this satellite in Vocalis first' in bench.log_text()


@needs_powershell
def test_new_secret_without_a_file_or_console_is_refused_and_a_stopped_container_is_started_not_restarted(bench):
    assert bench.first_run().rc == 0
    refused = bench.again("-NewSecret")
    assert refused.rc == 1 and "no console is attached" in refused.out and refused.calls == [], refused.text
    lines = bench.container_file().read_text(encoding="utf-8").splitlines()
    lines[0] = "exited"
    bench.container_file().write_text("\n".join(lines) + "\n", encoding="utf-8")
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    stopped = bench.again("-NewSecret", "-SecretFile", str(bench.secret_file))
    assert stopped.rc == 0 and stopped.of_kind("start") and not stopped.of_kind("restart"), stopped.text


@needs_powershell
def test_new_certificate_replaces_it_says_vocalis_needs_the_new_file_and_restarts(bench):
    first = bench.first_run("-Address", "nas.lan")
    assert first.rc == 0
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    result = bench.again("-NewCertificate", "-Address", "nas.lan")
    assert result.rc == 0, result.text
    cache = mount(bench.root / "cache", "/cache/vocalis")
    assert result.of_kind("provision") == [one_shot(
        IMAGE, "provision", ["--name", "sat-test", "--ip", "192.168.1.50", "--ip", "192.168.1.60", "--dns", "nas.lan", "--new-certificate"],
        [cache, mount(bench.root / "data", "/data/vocalis-satellite"), mount(bench.root / "secrets", "/run/secrets")])]
    assert result.of_kind("restart") == [["restart", name]]
    assert "Vocalis must be given the new certificate file" in bench.log_text()  # the long sentence is for the log and -Verbose
    assert "Fingerprint:     AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:02" in result.out  # the new one, not the first
    assert "One thing left: give Vocalis this satellite's new certificate." in result.out
    assert (bench.root / "secrets" / "vocalis-satellite-master").read_text(encoding="ascii") == SECRET  # the secret is kept


@needs_powershell
def test_new_secret_and_new_certificate_together_restart_once(bench):
    assert bench.first_run().rc == 0
    result = bench.again("-NewSecret", "-NewCertificate", "-SecretFile", str(bench.secret_file))
    assert result.rc == 0, result.text
    provision = result.of_kind("provision")[0]
    assert provision[-3:] == ["--secret-from-file", "--new-secret", "--new-certificate"]
    assert len(result.of_kind("restart")) == 1


@needs_powershell
def test_remove_removes_the_container_only_and_prints_the_folder_it_left(bench):
    assert bench.first_run().rc == 0
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    def listing():
        # the folder's own products; each run adds a setup log and replaces the result file, which are checked elsewhere
        return sorted(str(path.relative_to(bench.root)) for path in bench.root.rglob("*")
                      if not path.name.startswith("setup-") and path.name != "setup-result.txt")

    folder_before = listing()
    env_before = bench.satellite_env.read_bytes()
    result = bench.run("-Root", str(bench.root), "-Remove")
    assert result.rc == 0, result.text
    assert result.kinds() == ["info", "inspect", "stop", "rm"] and result.of_kind("rm") == [["rm", "-f", name]]
    assert result.of_kind("stop") == [["stop", "-t", "5", name]], "stopped properly first, so its log ends with the exiting line"
    assert not bench.container_file().exists()
    assert f"The folder {bench.root} was left in place" in result.out
    assert listing() == folder_before
    assert bench.satellite_env.read_bytes() == env_before
    again = bench.run("-Root", str(bench.root), "-Remove")
    assert again.rc == 0 and again.kinds() == ["info", "inspect"] and "nothing to remove" in again.out, again.text
    nothing = bench.run("-Root", str(bench.tmp / "nowhere"), "-Remove")
    assert nothing.rc == 1 and "nothing to remove" in nothing.out and nothing.calls == [], nothing.text


# ---- resume ------------------------------------------------------------------------------------------------------------

@needs_powershell
def test_a_failed_model_download_is_resumed_without_provisioning_again(bench):
    failed = bench.first_run(env={"FAKE_EXIT_fetch_model": 1})
    assert failed.rc == 1 and "model download or check did not finish" in failed.out and "run the same command again" in failed.out, failed.text
    assert failed.of_kind("provision") and not failed.of_kind("run-d")
    assert (bench.root / "secrets" / "vocalis-satellite-master").is_file() and (bench.root / "data" / "certs" / "cert.pem").is_file()
    resumed = bench.again()  # nothing but -Root: the secret already exists, so no file and no console are needed
    assert resumed.rc == 0, resumed.text
    assert not resumed.of_kind("provision") and resumed.of_kind("run-d")
    assert (bench.root / "secrets" / "vocalis-satellite-master").read_text(encoding="ascii") == SECRET
    assert bench.env_values()["IP_ADDRESSES"] == "192.168.1.50,192.168.1.60"


@needs_powershell
def test_a_failed_provision_is_retried_by_the_same_command(bench):
    failed = bench.first_run(env={"FAKE_EXIT_provision": 5})
    assert failed.rc == 1 and "configuration or certificate could not be written" in failed.out, failed.text
    assert not failed.of_kind("fetch-model") and not failed.of_kind("run-d")
    retried = bench.again("-SecretFile", str(bench.secret_file))
    assert retried.rc == 0 and retried.of_kind("provision") and "--secret-from-file" in retried.of_kind("provision")[0], retried.text


@needs_powershell
def test_a_bad_secret_file_stops_before_anything_is_started(bench):
    bench.secret_file.write_text("not a secret", encoding="ascii")
    result = bench.first_run()
    assert result.rc == 1 and "The secret was not accepted" in result.out and "not 64 hexadecimal characters" in result.out, result.text
    assert not result.of_kind("fetch-model") and not result.of_kind("run-d")


# ---- the wait --------------------------------------------------------------------------------------------------------------

@needs_powershell
def test_a_satellite_that_never_reports_listening_is_exit_13_after_the_bounded_wait_with_the_log_end(bench):
    result = bench.first_run(env={"FAKE_NO_LISTEN": 1})
    assert result.rc == 13, result.text
    assert "did not report that it is listening within 180 s" in result.out and "The end of the satellite log" in result.out
    assert "INFO fake satellite starting" in result.out and "listening on https://" not in result.out.split("The end of the satellite log")[1]
    # 180 s in steps of 3, less what the Docker calls themselves took (each look at the container and the log is timed)
    assert 40 <= len(result.sleeps) <= 61 and set(result.sleeps) == {3.0}, len(result.sleeps)
    assert len(result.of_kind("logs-tail")) == 1


@needs_powershell
def test_a_container_that_exited_stops_the_wait_at_once_and_prints_the_log_end(bench):
    result = bench.first_run(env={"FAKE_RUN_D_STATUS": "exited"})
    assert result.rc == 13 and "The satellite stopped before it was listening (state exited" in result.out, result.text
    assert result.sleeps == [] and "fatal: the fake satellite stopped on purpose" in result.out


@needs_powershell
def test_a_container_that_restarted_during_the_wait_stops_it_early(bench):
    result = bench.first_run(env={"FAKE_NO_LISTEN": 1, "FAKE_BUMP_RESTART": 1})
    assert result.rc == 13 and "restarts 0 -> 1" in result.out, result.text
    assert len(result.sleeps) <= 1


# ---- the secret ------------------------------------------------------------------------------------------------------------

@needs_powershell
def test_the_secret_is_never_an_argument_an_environment_variable_or_output_of_the_script(bench):
    result = bench.first_run("-Address", "nas.lan")
    assert result.rc == 0, result.text
    assert_secret_not_leaked(bench, result)
    # the script never opens the secret file: the only place its content ends up is the mounted secrets folder (by the tool)
    provision = result.of_kind("provision")[0]
    assert "--secret-from-file" in provision and not any(argument.startswith("--secret=") for argument in provision)
    assert SECRET not in bench.satellite_env.read_text(encoding="utf-8")
    assert f"Reading the secret from the file {bench.secret_file} (its contents are not shown)." in bench.log_text()
    assert (bench.root / "secrets" / "vocalis-satellite-master").read_text(encoding="ascii") == SECRET
    # never in the setup log or the result file either: the secret value is in exactly one file of the folder
    holders = [path for path in bench.root.rglob("*") if path.is_file() and SECRET.encode("ascii") in path.read_bytes()]
    assert holders == [bench.root / "secrets" / "vocalis-satellite-master"], holders


# ---- review of October 10, 2026 -----------------------------------------------------------------------------------

# Golden vector shared with the Linux tests: the argument list of the long-lived container after `run -d`, without the spec
# label, for a folder at /srv/vocalis-satellite, and its SHA-256 (UTF-8, joined by a line feed, no trailing line feed).
GOLDEN_IMAGE = "registry.example/vocalis-satellite-cuda@sha256:" + "a" * 64
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
    "--gpus all " + GOLDEN_IMAGE).split(" ")
GOLDEN_SHA256 = "de519f8d426f98c35fb06625ee55e0d20f723be38e76b704303149824934cc7d"


def test_golden_vector_against_the_test_helper():
    assert len(GOLDEN_TOKENS) == 34
    assert hashlib.sha256("\n".join(GOLDEN_TOKENS).encode("utf-8")).hexdigest() == GOLDEN_SHA256
    arguments, digest = long_lived("vs-0123456789ab", 7880, GOLDEN_IMAGE, Path("/srv/vocalis-satellite"))
    assert digest == GOLDEN_SHA256
    label_at = arguments.index("--label", arguments.index("--label") + 1)
    assert arguments[2:label_at] + arguments[label_at + 2:] == GOLDEN_TOKENS


@needs_powershell
def test_golden_vector_against_the_scripts_own_hashing_and_argument_list(tmp_path):
    body = (
        "$ServiceUser = '1000:1000'; $ContainerPort = 7880\n"
        f"$tokens = '{' '.join(GOLDEN_TOKENS)}' -split ' '\n"
        "$spec = Get-LongLivedSpec -Id 'vs-0123456789ab' -HostPort 7880 -ImageReference '" + GOLDEN_IMAGE + "' -RootForward '/srv/vocalis-satellite'\n"
        "[pscustomobject]@{ Direct = (Get-SpecHash $tokens); Hash = $spec.Hash; Hashed = @($spec.Hashed); Arguments = @($spec.Arguments) } | ConvertTo-Json -Compress\n")
    result = run_functions(["Get-SpecHash", "New-BindMount", "Get-LongLivedSpec"], body, tmp_path=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    answer = json.loads(result.stdout.strip().splitlines()[-1])
    assert answer["Direct"] == GOLDEN_SHA256 and answer["Hash"] == GOLDEN_SHA256
    assert answer["Hashed"] == GOLDEN_TOKENS
    assert answer["Arguments"][:2] == ["run", "-d"] and f"vocalis.satellite.spec={GOLDEN_SHA256}" in answer["Arguments"]


@needs_powershell
def test_a_container_that_keeps_restarting_is_not_reported_as_running(bench):
    assert bench.first_run().rc == 0
    lines = bench.container_file().read_text(encoding="utf-8").splitlines()
    lines[0] = "restarting"
    bench.container_file().write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = bench.again()
    assert result.rc == 13, result.text
    assert "left as it is" not in result.out and "restarting over and over" in result.out
    assert "The satellite stopped before it was listening (state restarting" in result.out and "The end of the satellite log" in result.out
    assert result.of_kind("logs-tail") and not result.of_kind("start") and not result.of_kind("rm") and not result.of_kind("run-d")


@needs_powershell
def test_a_failed_docker_run_removes_what_it_left_behind_and_says_so(bench):
    result = bench.first_run(env={"FAKE_RUN_D_EXIT": 125, "FAKE_RUN_D_LEAVE": 1})
    assert result.rc == 1, result.text
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    assert result.kinds()[-2:] == ["run-d", "rm"] and result.of_kind("rm") == [["rm", "-f", name]]
    assert not bench.container_file().exists()  # the half-made container is gone
    assert "The satellite container could not be created" in result.out and "exit code 125" in result.out and "fake failure" in result.out
    assert f"docker rm -f {name} exited with code 0" in result.out
    # and the same command works afterwards
    assert bench.again().rc == 0


@needs_powershell
def test_the_wait_is_bounded_on_the_clock_so_slow_docker_calls_cannot_stretch_it(bench):
    # Every look at the container takes 0.3 s of real time, which the stand-in clock (warp 10) reads as 3 s. The loop
    # sleeps 3 s and reads the log (about 1.5 s on that clock) too, so about 8 s pass per round and 180 s hold about 22
    # rounds, and never more than 30 (3 s sleep + 3 s inspect at least). A bound that counted only the sleeps and the log
    # calls would allow about 40 rounds.
    result = bench.first_run(env={"FAKE_NO_LISTEN": 1, "FAKE_INSPECT_DELAY_MS": 300}, warp=10)
    assert result.rc == 13 and "did not report that it is listening within 180 s" in result.out, result.text
    assert 5 <= len(result.sleeps) <= 30, len(result.sleeps)


@needs_powershell
def test_the_wait_reads_the_log_since_the_new_start_so_an_old_listening_line_proves_nothing(bench):
    first = bench.first_run()
    assert first.rc == 0
    first_started = bench.container_file().read_text(encoding="utf-8").splitlines()[2]
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    # the restarted satellite never gets as far as listening; the first start's line is still in the log
    stuck = bench.again("-NewSecret", "-SecretFile", str(bench.secret_file), env={"FAKE_NO_LISTEN": 1}, warp=20)
    assert stuck.rc == 13 and "did not report that it is listening" in stuck.out, stuck.text
    restarted = bench.container_file().read_text(encoding="utf-8").splitlines()[2]
    assert restarted != first_started
    logs = stuck.of_kind("logs")
    assert logs and all(call[1] == "--since" and call[2] == restarted for call in logs), logs
    # a restart that does listen is found by the same call
    ok = bench.again("-NewCertificate")
    assert ok.rc == 0, ok.text
    assert [call[2] for call in ok.of_kind("logs")] == [bench.container_file().read_text(encoding="utf-8").splitlines()[2]]


@needs_powershell
def test_half_a_certificate_pair_stops_the_run_with_the_tools_message_and_nothing_replaced(bench):
    assert bench.first_run().rc == 0
    cert = bench.root / "data" / "certs" / "cert.pem"
    before = cert.read_bytes()
    (bench.root / "data" / "certs" / "key.pem").unlink()
    container_before = bench.container_file().read_bytes()
    result = bench.again()
    assert result.rc == 1 and "could not be written or read" in result.out and "Nothing was started and nothing was replaced" in result.out, result.text
    assert "only one of cert.pem and key.pem exists" in result.text  # the tool's own message is shown
    # no --ip/--dns (and no --new-certificate): no certificate is being made, and the tool refuses the half pair either way
    cache = mount(bench.root / "cache", "/cache/vocalis")
    assert result.kinds()[-1] == "provision"
    assert result.of_kind("provision") == [one_shot(IMAGE, "provision", ["--name", "sat-test"],
                                                    [cache, mount(bench.root / "data", "/data/vocalis-satellite"), mount(bench.root / "secrets", "/run/secrets")])]
    assert cert.read_bytes() == before and not (bench.root / "data" / "certs" / "key.pem").exists()
    assert bench.container_file().read_bytes() == container_before


@needs_powershell
def test_a_docker_inspect_that_fails_for_another_reason_than_a_missing_container_stops_the_run(bench):
    assert bench.first_run().rc == 0
    result = bench.again(env={"FAKE_INSPECT_EXIT": 1})
    assert result.rc == 1 and "docker container inspect failed with exit code 1: Cannot connect to the Docker daemon" in result.out, result.text
    assert result.kinds() == ["info", "inspect"]


@needs_powershell
def test_a_hung_docker_call_is_stopped_and_reported_plainly(tmp_path, fake_docker):
    exe = tmp_path / "hang" / "docker.exe"
    exe.parent.mkdir()
    shutil.copy(fake_docker, exe)
    env = os.environ.copy()
    env["FAKE_HANG"] = "info"
    body = (f"$r = Invoke-Bounded -FileName '{exe}' -Arguments @('info') -TimeoutSeconds 2\n"
            f"$left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq '{exe}' }}).Count\n"
            "[pscustomobject]@{ TimedOut = $r.TimedOut; Started = $r.Started; Ms = $r.Milliseconds; Left = $left } | ConvertTo-Json -Compress\n")
    result = run_functions(["ConvertTo-ArgumentString", "Invoke-Bounded"], body, tmp_path=tmp_path, env=env)
    assert result.returncode == 0, result.stdout + result.stderr
    answer = json.loads(result.stdout.strip().splitlines()[-1])
    assert answer["TimedOut"] is True and answer["Started"] is True and 1900 <= answer["Ms"] < 30000, answer
    assert answer["Left"] == 0, "the hung program must not be left running"


@needs_powershell
def test_a_docker_engine_that_hangs_is_exit_11_with_a_plain_message_after_the_bound(bench):
    result = bench.first_run(env={"FAKE_HANG": "info"}, timeout=200)
    assert result.rc == 11 and "docker info did not answer within 60 s" in result.out and "Start Docker Desktop" in result.out, result.text
    assert result.kinds() == ["info"] and not bench.root.exists()


@needs_powershell
@pytest.mark.parametrize("flag", ["-NewSecret", "-NewCertificate"])
def test_replacing_the_secret_or_certificate_of_a_folder_that_does_not_exist_is_refused(bench, flag):
    result = bench.run("-Root", str(bench.root), "-Image", IMAGE, flag, "-SecretFile", str(bench.secret_file))
    assert result.rc == 1 and "no secret or certificate to replace" in result.out, result.text
    assert result.calls == [] and not bench.root.exists()


@needs_powershell
def test_relative_root_and_secret_file_resolve_against_the_powershell_location(bench):
    work = bench.tmp / "work here"
    work.mkdir()
    (work / "relative-secret.txt").write_text(SECRET, encoding="ascii")
    assert Path.cwd() != work  # the process's own folder is somewhere else, which is what GetFullPath would have used
    result = bench.run("-Root", "relative sat", "-Image", IMAGE, "-Port", str(bench.port), "-Name", "sat-test",
                       "-SecretFile", "relative-secret.txt", cwd=str(work))
    assert result.rc == 0, result.text
    root = work / "relative sat"
    assert (root / "satellite.env").is_file() and not (Path.cwd() / "relative sat").exists()
    bench.root = root
    assert bench.env_values()["SATELLITE_ROOT"] == str(root)
    provision = result.of_kind("provision")[0]
    assert mount(work / "relative-secret.txt", "/run/provision/secret", True) in provision


@needs_powershell
def test_the_name_is_lower_cased_and_then_validated(bench):
    result = bench.run("-Root", str(bench.root), "-Image", IMAGE, "-Port", str(bench.port), "-Name", "Sat-TEST", "-SecretFile", str(bench.secret_file))
    assert result.rc == 0, result.text
    assert bench.env_values()["SATELLITE_NAME"] == "sat-test"
    provision = result.of_kind("provision")[0]
    assert provision[provision.index("--name") + 1] == "sat-test"
    assert bench.again("-Name", "SAT-test").rc == 0  # the same name in another case is the same name
    different = bench.again("-Name", "Other")
    assert different.rc == 1 and "named 'sat-test'" in different.out, different.text
    bad = bench.run("-Root", str(bench.tmp / "elsewhere"), "-Image", IMAGE, "-Name", "Bad Name", "-SecretFile", str(bench.secret_file))
    assert bad.rc == 1 and "must start with a letter or digit" in bad.out


def step_headers(result):
    """[(number, total, title)] of the '[n/N] Title' lines a run printed, in order."""
    return [(int(n), int(total), title.split(" ")[0]) for n, total, title in re.findall(r"^\[(\d+)/(\d+)\] (.*)$", result.out, re.MULTILINE)]


EIGHT_STEPS = [(1, 8, "Checks"), (2, 8, "Image"), (3, 8, "GPU"), (4, 8, "Addresses"), (5, 8, "Secret"), (6, 8, "Model"), (7, 8, "Start"), (8, 8, "Done")]


@needs_powershell
def test_step_headers_are_numbered_without_gaps_in_every_mode(bench):
    assert step_headers(bench.first_run()) == EIGHT_STEPS
    assert step_headers(bench.again()) == EIGHT_STEPS  # plain
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    assert step_headers(bench.again("-NewSecret", "-SecretFile", str(bench.secret_file))) == EIGHT_STEPS
    assert step_headers(bench.again("-NewCertificate")) == EIGHT_STEPS
    assert step_headers(bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE)) == EIGHT_STEPS
    removal = [(1, 2, "Checks"), (2, 2, "Remove")]
    assert step_headers(bench.run("-Root", str(bench.root), "-Remove")) == removal
    assert step_headers(bench.run("-Root", str(bench.root), "-Remove")) == removal  # nothing left to remove: same headers
    # a refusal stops after the first header, and says so under it
    refused = bench.run("-Root", str(bench.root), "-Image", "not-a-digest")
    assert refused.rc == 1 and step_headers(refused) == [(1, 8, "Checks")]


@needs_powershell
def test_an_empty_list_in_a_message_reads_none_not_an_empty_value(bench):
    # These lines are the log's and -Verbose's since October 11, 2026; the quiet screen has one short line for the certificate.
    quiet = bench.first_run()
    assert quiet.rc == 0, quiet.text
    for hidden in ("Certificate covers:", "Recorded in satellite.env", "secret to be written", "Certificate fingerprint:"):
        assert hidden not in quiet.out, hidden
    assert "  The new certificate covers: IPv4 192.168.1.50, 192.168.1.60; names (none)" in quiet.out
    log = bench.log_text()
    assert "Certificate covers: IPv4 192.168.1.50, 192.168.1.60; names (none)" in log
    assert "Recorded in satellite.env: addresses 192.168.1.50, 192.168.1.60, names (none)." in log
    assert not re.search(r"(names|addresses) \.|, \.|: \.", log)
    assert "secret to be written" in log and "certificate to be created for 192.168.1.50, 192.168.1.60" in log
    # -Verbose prints the same lines
    shutil.rmtree(bench.root)
    verbose = bench.first_run("-Verbose")
    assert verbose.rc == 0, verbose.text
    assert "Certificate covers: IPv4 192.168.1.50, 192.168.1.60; names (none)" in verbose.out
    assert "Recorded in satellite.env: addresses 192.168.1.50, 192.168.1.60, names (none)." in verbose.out
    assert "secret to be written" in verbose.out and "certificate to be created for 192.168.1.50, 192.168.1.60" in verbose.out


@needs_powershell
def test_the_for_reference_block_after_a_new_secret_or_an_update_has_the_file_and_the_primary_address_only(bench):
    assert bench.first_run().rc == 0
    cert = bench.root / "data" / "certs" / "cert.pem"
    fingerprint = (bench.root / "data" / "certs" / "fingerprint.txt").read_text(encoding="ascii").strip()
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    secret = bench.again("-NewSecret", "-SecretFile", str(bench.secret_file))
    update = bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE)
    for result in (secret, update):
        assert result.rc == 0, result.text
        lines = result.out.splitlines()
        at = lines.index("For reference:")
        assert lines[at:at + 4] == ["For reference:", f"  Certificate file:  {cert}", f"  Fingerprint:       {fingerprint}",
                                    f"  Satellite address: https://192.168.1.50:{bench.port}"], lines[at:at + 5]
        assert "Upload certificate" not in result.out and "two steps" not in result.out
    # after -NewCertificate the file to upload is the first thing said
    certificate = bench.again("-NewCertificate")
    lines = certificate.out.splitlines()
    at = lines.index("One thing left: give Vocalis this satellite's new certificate.")
    assert lines[at + 1].startswith("  File to upload:  ") and lines[at + 2].startswith("  Fingerprint:     ")
    assert lines[at + 3] == "If your browser is on another computer, copy that file there first."
    assert lines[at + 4] == 'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite\'s row.'
    assert lines[at + 5] == f"Satellite address: https://192.168.1.50:{bench.port}"
    assert "Then tick its card" not in certificate.out  # the card is still ticked after a new certificate


PLAIN_RUN_TEXT = [
    "If this satellite is already set up in Vocalis, nothing more has to be done there.",
    "If it is not (for example an earlier run stopped part way), two steps are left in Vocalis:",
    # "named below" (the file line comes after the sentence); agreed with satellite-setup.sh, October 11, 2026
    "  1. Copy the certificate file named below to the computer where you use Vocalis in a browser, then use \"Upload certificate...\" on the satellite's row:",
]


def assert_plain_run_text(result, bench):
    """The closing text of a run that created and replaced nothing: both sentences, then the first setup's two steps (shared
    word for word with satellite-setup.sh)."""
    lines = result.out.splitlines()
    start = lines.index(PLAIN_RUN_TEXT[0])
    assert lines[start:start + 3] == PLAIN_RUN_TEXT, lines[start:start + 3]
    cert = bench.root / "data" / "certs" / "cert.pem"
    fingerprint = (bench.root / "data" / "certs" / "fingerprint.txt").read_text(encoding="ascii").strip()
    assert lines[start + 3] == f"       {cert}"
    assert lines[start + 4] == f"     Check that the fingerprint Vocalis shows matches: {fingerprint}"
    assert "  2. Tick the satellite's cards in Settings; they load as soon as you tick them." in lines[start + 5:start + 10]
    assert "there are two steps left" not in result.out and "Nothing has to be done in Vocalis" not in result.out


@needs_powershell
def test_a_resumed_first_run_does_not_claim_that_nothing_is_left_to_do(bench):
    # The first run writes the secret and certificate and then stops at the model download: the certificate was never
    # uploaded and no card ticked. The rerun is a plain run and must say the steps are left unless Vocalis already has them.
    failed = bench.first_run(env={"FAKE_EXIT_fetch_model": 1})
    assert failed.rc == 1 and "model download or check did not finish" in failed.out
    resumed = bench.again()
    assert resumed.rc == 0 and not resumed.of_kind("provision"), resumed.text
    assert_plain_run_text(resumed, bench)


@needs_powershell
def test_the_closing_lines_say_only_what_is_left_to_do_after_each_kind_of_run(bench):
    first = bench.first_run()
    assert "One thing left: give Vocalis this satellite's certificate." in first.out and "Upload certificate..." in first.out
    assert "Then tick its card." in first.out and "two steps" not in first.out
    plain = bench.again()
    assert plain.rc == 0, plain.text
    assert_plain_run_text(plain, bench)
    update = bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE)
    assert update.rc == 0 and "two steps left" not in update.out, update.text
    assert f"The satellite now runs {NEW_IMAGE}. Nothing has to be paired again" in update.out
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    secret = bench.again("-NewSecret", "-SecretFile", str(bench.secret_file))
    assert secret.rc == 0 and "two steps left" not in secret.out, secret.text
    assert "Vocalis already has the new secret" in secret.out and "nothing needs uploading" in secret.out
    assert "Upload certificate" not in secret.out.split("The secret was replaced")[1]
    certificate = bench.again("-NewCertificate")
    assert certificate.rc == 0 and "two steps left" not in certificate.out, certificate.text
    assert "One thing left: give Vocalis this satellite's new certificate." in certificate.out and "File to upload:" in certificate.out
    assert 'on this satellite\'s row' in certificate.out
    assert "Vocalis already has the new secret" not in certificate.out and "tick its card" not in certificate.out


@needs_powershell
def test_replacing_the_secret_or_the_certificate_does_not_check_the_model_again(bench):
    assert bench.first_run().rc == 0
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    secret = bench.again("-NewSecret", "-SecretFile", str(bench.secret_file))
    certificate = bench.again("-NewCertificate")
    for result in (secret, certificate):
        assert result.rc == 0 and not result.of_kind("fetch-model"), result.text
        assert "Skipped: replacing the secret or the certificate does not touch the model." in result.out
    assert bench.again().of_kind("fetch-model")  # a plain run still verifies it


@needs_powershell
def test_a_new_certificate_lists_the_recorded_addresses_and_names_it_will_not_contain(bench):
    assert bench.first_run("-Address", "nas.lan,192.168.1.99").rc == 0
    assert bench.env_values()["IP_ADDRESSES"] == "192.168.1.50,192.168.1.60,192.168.1.99" and bench.env_values()["DNS_NAMES"] == "nas.lan"
    lost = bench.again("-NewCertificate")
    assert lost.rc == 0, lost.text
    assert "NOT in the new certificate (recorded for the old one): 192.168.1.99, nas.lan." in lost.out, lost.text
    provision = lost.of_kind("provision")[0]
    assert "--dns" not in provision and "192.168.1.99" not in provision  # nothing recorded is carried forward
    assert bench.env_values()["IP_ADDRESSES"] == "192.168.1.50,192.168.1.60" and bench.env_values()["DNS_NAMES"] == ""
    partly = bench.again("-NewCertificate", "-Address", "nas.lan")
    assert partly.rc == 0 and "NOT in the new certificate" not in partly.out and "Every address and name recorded" in bench.log_text(), partly.text
    kept = bench.again("-NewCertificate", "-Address", "nas.lan,10.1.1.1")
    assert "Every address and name recorded" in bench.log_text()
    shrunk = bench.again("-NewCertificate")
    assert "NOT in the new certificate (recorded for the old one): 10.1.1.1, nas.lan." in shrunk.out, shrunk.text


@needs_powershell
def test_a_secret_file_that_is_not_needed_is_not_mounted_and_the_run_says_so(bench):
    assert bench.first_run().rc == 0
    result = bench.again("-SecretFile", str(bench.secret_file))
    assert result.rc == 0, result.text
    assert "-SecretFile was given but no secret is needed on this run" in result.out
    assert not result.of_kind("provision")
    assert not any(str(bench.secret_file).replace("\\", "/") in argument for call in result.calls for argument in call)
    # the same when only the certificate is replaced: provision runs, but without the file
    cert = bench.again("-NewCertificate", "-SecretFile", str(bench.secret_file))
    provision = cert.of_kind("provision")[0]
    assert "--secret-from-file" not in provision and not any("/run/provision/secret" in argument for argument in provision)
    assert "-SecretFile was given but no secret is needed" in cert.out


@needs_powershell
def test_closing_urls_put_the_scripts_own_primary_first_not_the_tools_numeric_order(bench):
    # The fake tool lists ip= sorted numerically with 127.0.0.1 among them, as the real one does: .50 before .60. With the
    # lower-metric route on Wi-Fi the script's primary is .60, and only the script can put it first.
    result = bench.first_run(network=total_metric_routes(sample_network(wifi_metric=5)))
    assert result.rc == 0, result.text
    # The screen shows the one address, and it is the primary; the result file lists them all, primary first.
    after = result.out[result.out.index("One thing left: give Vocalis this satellite's certificate."):]
    assert re.findall(r"https://\S+", after) == [f"https://192.168.1.60:{bench.port}"]
    assert bench.result_file()["URLS"].split(",") == [f"https://192.168.1.60:{bench.port}", f"https://192.168.1.50:{bench.port}"]


# ---- the prompting call, with a console ---------------------------------------------------------------------------------

def run_in_hidden_console(bench, script_arguments, *, capture):
    """Runs the script in its own hidden console (a new console, window hidden, nothing on the desktop), so its input is a
    real console and [Console]::IsInputRedirected is false. With `capture` its output goes to a file by PowerShell's own
    redirection (the script still sees a console as its output); without it the output stays on the console, so
    [Console]::IsOutputRedirected is false and a native program the script calls directly inherits the console.
    Returns (return code, captured text or "", docker calls, the fake's flag log)."""
    log, envlog, state = bench.log, bench.envlog, bench.state
    for path in (log, envlog, bench.flaglog):
        path.write_text("", encoding="ascii")
    data = bench.tmp / "network.json"
    data.write_text(json.dumps(total_metric_routes(sample_network())), encoding="ascii")
    output = bench.tmp / "console-output.txt"
    output.unlink(missing_ok=True)
    wrapper = bench.tmp / "console-wrapper.ps1"
    wrapper.write_text(
        "$ErrorActionPreference = 'Stop'\n"
        f"$Sample = Get-Content -Raw -LiteralPath '{data}' | ConvertFrom-Json\n"
        "function Get-NetAdapter { @($Sample.adapters) | ForEach-Object { [pscustomobject]@{ Name = $_.name; InterfaceDescription = $_.description; InterfaceIndex = [int]$_.index; Status = $_.status } } }\n"
        "function Get-NetIPAddress { @($Sample.addresses) | ForEach-Object { [pscustomobject]@{ InterfaceIndex = [int]$_.index; IPAddress = $_.ip; AddressState = $_.state } } }\n"
        "function Get-NetIPInterface { @($Sample.interfaces) | ForEach-Object { [pscustomobject]@{ InterfaceIndex = [int]$_.index; InterfaceMetric = [int]$_.metric } } }\n"
        "function Get-NetRoute { @($Sample.routes) | ForEach-Object { [pscustomobject]@{ DestinationPrefix = $_.prefix; InterfaceIndex = [int]$_.index; RouteMetric = [int]$_.metric } } }\n"
        f"& '{SCRIPT}' " + " ".join(ps_quote(str(token)) for token in script_arguments) + (f" *> '{output}'\n" if capture else "\n") +
        "exit $LASTEXITCODE\n",
        encoding="utf-8-sig")
    environment = os.environ.copy()
    for name in [name for name in environment if name.upper().startswith("FAKE_")]:
        del environment[name]
    environment["PATH"] = str(bench.bin) + os.pathsep + str(Path(POWERSHELL).parent) + os.pathsep + os.path.join(os.environ["SystemRoot"], "System32")
    environment["LOCALAPPDATA"] = str(bench.localappdata)
    environment.update({"FAKE_LOG": str(log), "FAKE_ENVLOG": str(envlog), "FAKE_STATE": str(state), "FAKE_FLAGLOG": str(bench.flaglog)})
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0  # SW_HIDE
    process = subprocess.Popen([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper)], env=environment,
                               creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup,
                               stdin=None, stdout=None, stderr=None)
    try:
        process.wait(timeout=300)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    text = output.read_text(encoding="utf-16", errors="replace") if output.exists() else ""  # PowerShell's *> writes UTF-16
    calls = [line.split("\t")[1:] for line in log.read_text(encoding="utf-8").splitlines() if line.startswith("docker\t")]
    return process.returncode, text, calls, bench.flaglog.read_text(encoding="utf-8")


@needs_powershell
def test_with_a_console_attached_the_prompting_provision_runs_with_it_directly(bench):
    """No -SecretFile: the script must make the direct -it call. The fake does not read the console; it writes a dummy
    secret when it sees -it, as the real tool prompts only with a terminal."""
    returncode, text, calls, _ = run_in_hidden_console(
        bench, ["-Root", bench.root, "-Image", IMAGE, "-Port", bench.port, "-Name", "sat-test"], capture=True)
    assert returncode == 0, text
    provision = [call for call in calls if call_kind(call) == "provision"]
    cache = mount(bench.root / "cache", "/cache/vocalis")
    assert provision == [one_shot(IMAGE, "provision", ["--name", "sat-test", "--ip", "192.168.1.50", "--ip", "192.168.1.60"],
                                  [cache, mount(bench.root / "data", "/data/vocalis-satellite"), mount(bench.root / "secrets", "/run/secrets")],
                                  terminal=True)], calls
    assert "-it" in provision[0] and provision[0].index("-it") < provision[0].index("--mount")
    assert "Paste the secret at the prompt below" in text and "https://192.168.1.50:%d" % bench.port in text
    assert (bench.root / "secrets" / "vocalis-satellite-master").is_file()
    # the log has the exit code of that call and nothing the prompt showed (design table: "The exit code only")
    log = bench.log_text()
    assert "with the secret typed at the prompt" in log and "exit code 0" in log


@needs_powershell
def test_no_prompt_with_a_console_attached_still_never_opens_the_prompt(bench):
    # a console is attached (the prompt would work), but -NoPrompt is what the setup program and the tray icon pass
    returncode, text, calls, _ = run_in_hidden_console(
        bench, ["-Root", bench.root, "-Image", IMAGE, "-Port", bench.port, "-Name", "sat-test", "-NoPrompt"], capture=True)
    assert returncode == 1 and NO_PROMPT_LINE in text, text
    assert calls == [] and not bench.root.exists()


@needs_powershell
def test_the_pull_at_a_terminal_is_a_direct_call_with_docker_s_own_display_and_only_its_exit_code_is_logged(bench):
    # No redirection at all: the script's output is the console, so it is at a terminal, and the pull inherits the console
    # (the fake records that its output was NOT a pipe). The log then has the exit code of the pull and none of its text.
    returncode, text, calls, flags = run_in_hidden_console(
        bench, ["-Root", bench.root, "-Image", IMAGE, "-Port", bench.port, "-Name", "sat-test", "-SecretFile", bench.secret_file], capture=False)
    assert returncode == 0, calls
    assert [call for call in calls if call_kind(call) == "pull"] == [["pull", IMAGE]]
    assert flags.splitlines() == ["pull stdout-redirected=False stderr-redirected=False"], flags
    log = bench.log_text()
    assert "Docker's own progress display on the screen, not logged): exit code 0" in log
    assert "Status: Downloaded newer image" not in log and "INFO: pull: a note on stderr" not in log


@needs_powershell
def test_the_pull_without_a_terminal_is_captured_shown_line_by_line_and_every_line_is_logged(bench):
    result = bench.first_run()
    assert result.rc == 0, result.text
    assert result.flaglog.splitlines() == ["pull stdout-redirected=True stderr-redirected=True"], result.flaglog
    for line in ("Status: Downloaded newer image for " + IMAGE, "INFO: pull: a note on stderr after a successful pull"):
        assert line in result.out.splitlines(), line
        assert line in bench.log_text(), line
    assert "NativeCommandError" not in result.text and "CategoryInfo" not in result.text
    # a failed pull: the reason is shown (it is the pull's own standard error) and logged, in the one ERROR line's company
    shutil.rmtree(bench.root)
    failed = bench.first_run(env={"FAKE_PULL_EXIT": 1})
    assert failed.rc == 1 and "Error response from daemon: pull access denied" in failed.out
    assert "Error response from daemon: pull access denied" in bench.log_text()
    assert "NativeCommandError" not in failed.text and "CategoryInfo" not in failed.text


# ---- the in-image tool's real behavior (findings of October 10, 2026) ---------------------------------------

@needs_powershell
def test_stderr_output_of_every_subcommand_on_success_is_not_a_failure_and_reaches_the_user(bench):
    result = bench.first_run()
    assert result.rc == 0, result.text
    assert "NativeCommandError" not in result.text and "CategoryInfo" not in result.text
    # check-gpu, provision and show are read through the bounded helper: stderr is kept apart from stdout. In a quiet run
    # the tool's INFO: lines are hidden (they are in the log); a failed call shows its messages (see the exit 4 and 5 test).
    assert result.of_kind("check-gpu") and result.of_kind("provision") and result.of_kind("show")
    assert "INFO: config: satellite.yaml (written)" not in result.text and "INFO: check-gpu" not in result.text
    log = bench.log_text()
    for line in ("INFO: config: satellite.yaml (written)", "INFO: check-gpu: looked at the cards PyTorch can use", "INFO: show: certificate read"):
        assert line in log, line
    # The pull is captured when the output is not a terminal (it is not here) and shown line by line, both streams, with no
    # error record; the model download is captured too: its standard output is shown, its standard error goes to the log.
    assert "INFO: pull: a note on stderr after a successful pull" in result.text and "Status: Downloaded newer image" in result.text
    assert "INFO: pull: a note on stderr after a successful pull" in log
    assert "fake fetch-model: all files verified" in result.text
    assert "INFO: fetch-model: stderr line on success" not in result.text and "INFO: fetch-model: stderr line on success" in log
    # -Verbose shows every one of them, as the run did before the quiet output
    bench.container_file().unlink()
    again = bench.again("-Verbose")
    assert again.rc == 0 and "NativeCommandError" not in again.text, again.text
    for line in ("INFO: fetch-model: stderr line on success", "INFO: show: certificate read"):
        assert line in again.text, line
    # a later run with the container still to be created again runs the whole path with stderr output once more
    shutil.rmtree(bench.root)
    fresh = bench.first_run("-Verbose")
    assert fresh.rc == 0 and "NativeCommandError" not in fresh.text and "INFO: config: satellite.yaml (written)" in fresh.text, fresh.text


@needs_powershell
def test_fetch_model_output_is_passed_through_and_only_its_exit_code_decides(bench):
    ok = bench.first_run()
    assert ok.rc == 0 and "fake fetch-model: all files verified" in ok.out, ok.text
    bench.container_file().unlink()
    failed = bench.again(env={"FAKE_EXIT_fetch_model": 1})
    assert failed.rc == 1 and "fake fetch-model: failed" in failed.out and "model download or check did not finish (exit code 1)" in failed.out, failed.text
    assert not failed.of_kind("run-d")


@needs_powershell
def test_loopback_localhost_and_ipv6_lines_from_the_tool_are_left_out_of_urls_and_records(bench):
    result = bench.first_run("-Address", "nas.lan")
    assert result.rc == 0, result.text
    env = bench.env_values()
    assert env["IP_ADDRESSES"] == "192.168.1.50,192.168.1.60" and env["DNS_NAMES"] == "nas.lan"
    urls = re.findall(r"https://\S+", result.out[result.out.index("One thing left: give Vocalis this satellite's certificate."):])
    assert urls and all(re.fullmatch(rf"https://\d+\.\d+\.\d+\.\d+:{bench.port}", url) for url in urls), urls
    assert all(re.fullmatch(rf"https://\d+\.\d+\.\d+\.\d+:{bench.port}", url) for url in bench.result_file()["URLS"].split(","))
    assert "127.0.0.1" not in env["IP_ADDRESSES"] and "localhost" not in bench.log_text().split("Certificate covers:")[1].splitlines()[0]
    assert "localhost" not in result.out.split("The new certificate covers:")[1].splitlines()[0]
    # the address check on a later run compares the primary and each -Address against show's ip= lines, loopback aside
    later = bench.again("-Address", "127.0.0.2")
    assert later.rc == 1 and "loopback" in later.out  # refused as an -Address before it can be mistaken for coverage


@needs_powershell
@pytest.mark.parametrize("code, message", [(4, "The secret was not accepted"), (5, "could not be written or read")])
def test_provision_exit_4_and_5_show_the_tools_message_and_stop_without_replacing_anything(bench, code, message):
    result = bench.first_run(env={"FAKE_EXIT_provision": code})
    assert result.rc == 1 and message in result.out and "Nothing was started and nothing was replaced" in result.out, result.text
    assert "fake provision: failing on purpose" in result.text  # the tool's own message is shown
    assert not result.of_kind("show") and not result.of_kind("fetch-model") and not result.of_kind("run-d")
    assert len(result.of_kind("provision")) == 1  # no retry
    assert not (bench.root / "secrets" / "vocalis-satellite-master").exists()


@needs_powershell
def test_check_gpu_runs_only_when_the_container_is_to_be_created_and_before_the_secret_is_read(bench):
    first = bench.first_run()
    kinds = first.kinds()
    assert kinds.index("check-gpu") < kinds.index("provision")
    # a stopped container with current settings is started, not created: no GPU check; a replaced secret restarts: none either
    lines = bench.container_file().read_text(encoding="utf-8").splitlines()
    lines[0] = "exited"
    bench.container_file().write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert not bench.again().of_kind("check-gpu")
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    assert not bench.again("-NewSecret", "-SecretFile", str(bench.secret_file)).of_kind("check-gpu")
    # a missing container or other settings: it runs
    bench.container_file().unlink()
    assert bench.again().of_kind("check-gpu")


@needs_powershell
def test_new_certificate_tells_the_user_to_give_explicit_addresses_again(bench):
    assert bench.first_run("-Address", "nas.lan").rc == 0
    result = bench.again("-NewCertificate")
    assert result.rc == 0 and "nothing recorded earlier is carried forward" in bench.log_text(), result.text
    assert "NOT in the new certificate (recorded for the old one): nas.lan." in result.out and "-NewCertificate -Address <values>" in result.out
    assert bench.env_values()["DNS_NAMES"] == ""  # the name given on the first run was not remembered


@needs_powershell
def test_help_prints_the_usage_without_touching_docker(bench):
    result = bench.run("-Help")
    assert result.rc == 0 and "-SecretFile PATH" in result.out and "-NewCertificate" in result.out and result.calls == [], result.text
    assert "-Autostart on|off" in result.out and "-ShowPlan" in result.out and "-CheckOnly" in result.out and "-CheckPort" in result.out and "-NoPrompt" in result.out
    assert not bench.root.exists() and not bench.localappdata.exists()  # help writes nothing


# ======================================================================================================================
# October 11, 2026: the setup program and tray icon subsection of the design, "Script changes" items 1 to 7 and the
# feasibility rules (design section 9, "Satellite setup program and tray icon for Windows, and quieter setup output").
# ======================================================================================================================

def error_lines(result):
    return [line for line in result.out.splitlines() if line.startswith("ERROR:")]


# ("Exception calling" is not in the list: an unexpected .NET error's text legitimately sits INSIDE the one ERROR: line.)
ERROR_RECORD_NOISE = ("NativeCommandError", "CategoryInfo", "FullyQualifiedErrorId", "At line:", "+ ~", "TerminatingError")


def assert_one_error_line_and_no_error_record(result):
    """Every failure is ONE "ERROR:" line printed by the script, never a PowerShell error record, and nothing on stderr."""
    assert len(error_lines(result)) == 1, result.text
    # a PowerShell error record would put its text on lines of its own; the one ERROR: line is the only line about the error
    assert not any(line.startswith("Exception calling") for line in result.out.splitlines())
    for noise in ERROR_RECORD_NOISE:
        assert noise not in result.text, (noise, result.text)
    assert result.err.strip() == "", result.err


def tree_state(root):
    """Every file and folder under root with its size and modification time: equal before and after means nothing was written."""
    state = {}
    if root.exists():
        for path in root.rglob("*"):
            info = path.stat()
            state[str(path.relative_to(root))] = (path.is_dir(), 0 if path.is_dir() else info.st_size, info.st_mtime_ns)
    return state


def edit_container(bench, *, status=None, label=None, policy=None):
    """Changes the fake container's state file: line 1 status, line 4 spec label, line 5 restart policy."""
    lines = bench.container_file().read_text(encoding="utf-8").splitlines()
    if status is not None:
        lines[0] = status
    if label is not None:
        lines[3] = label
    if policy is not None:
        lines[4] = policy
    bench.container_file().write_text("\n".join(lines) + "\n", encoding="utf-8")


def container_policy(bench):
    return bench.container_file().read_text(encoding="utf-8").splitlines()[4]


# ---- item 1: quiet by default, full with PowerShell's own -Verbose --------------------------------------------------------

# (The pull's own standard-error lines are not the tool's INFO: lines: a pull that is captured shows every line it printed.)
HIDDEN_IN_A_QUIET_RUN = ("INFO: config", "INFO: check-gpu", "INFO: show", "INFO: fetch-model", "Recorded in satellite.env", "Certificate covers:", "Certificate fingerprint:", "left out:", "Docker answered in",
                         "Setup needs the satellite image", "Created the satellite folder", "Provisioning (", "Provisioning finished", "Waiting up to", "VERBOSE:")


# The sentence both scripts use for what a first setup needs (live test, October 11, 2026: "will download" was untrue when
# the image was already on the computer). It is a -Verbose line here, so a quiet run does not show it.
DOWNLOAD_SENTENCE = ("Setup needs the satellite image (about 10 GB) and the Chatterbox model files (about 3.2 GB). "
                     "Whatever is not already on this computer is downloaded; setup can be run again to resume.")


@needs_powershell
def test_a_quiet_run_prints_a_header_and_a_line_or_two_per_step_and_none_of_the_internal_lines(bench):
    first = bench.first_run()
    assert first.rc == 0, first.text
    for hidden in HIDDEN_IN_A_QUIET_RUN:
        assert hidden not in first.out, hidden
    assert not re.search(r"^(card|fingerprint|ip|dns|secret|certificate)=", first.out, re.MULTILINE), first.out
    # what stays, by step (design: "What stays on screen in a quiet run, by step")
    out = first.out
    assert f"Satellite folder: {bench.root}" in out
    assert "Pulling the image" in out and "Card 0: NVIDIA GeForce RTX 4090" in out
    assert "Found on this computer: 192.168.1.50, 192.168.1.60" in out
    assert "  secret: written" in out and "  certificate: created" in out
    assert "fake fetch-model: all files verified" in out and "The model is in place and verified." in out
    assert f"is running on port {bench.port}." in out
    assert step_headers(first) == EIGHT_STEPS
    # every step is a header and a few lines: nothing like the sixty lines of the October 10 run
    assert len(out.splitlines()) < 50, len(out.splitlines())
    # the other modes are quiet in the same way
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    for result in (bench.again(), bench.again("-NewSecret", "-SecretFile", str(bench.secret_file)), bench.again("-NewCertificate"),
                   bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE), bench.run("-Root", str(bench.root), "-Remove")):
        assert result.rc == 0, result.text
        for hidden in HIDDEN_IN_A_QUIET_RUN:
            assert hidden not in result.out, (hidden, result.out)
        assert not re.search(r"^(card|fingerprint|ip|dns|secret|certificate)=", result.out, re.MULTILINE)


@needs_powershell
def test_the_adapters_left_out_are_listed_only_when_nothing_usable_was_found_or_with_verbose(bench):
    quiet = bench.first_run()
    assert quiet.rc == 0 and "left out:" not in quiet.out, quiet.text
    assert "left out: 169.254.5.5 (link-local)" in bench.log_text()  # the log has them
    shutil.rmtree(bench.root)
    verbose = bench.first_run("-Verbose")
    assert "  left out: 169.254.5.5 (link-local)" in verbose.out and "left out: 172.20.0.1 (adapter vEthernet (WSL) is virtual)" in verbose.out
    # nothing usable on the adapters (all disconnected), an -Address given: the list says why they were passed over
    shutil.rmtree(bench.root)
    network = total_metric_routes(sample_network())
    network["adapters"] = [dict(adapter, status="Disconnected") for adapter in network["adapters"]]
    none = bench.first_run("-Address", "192.168.1.5", network=network)
    assert none.rc == 0, none.text
    assert "Found on this computer: no usable IPv4 address" in none.out
    assert "  left out: 192.168.1.50 (adapter Ethernet is not up)" in none.out and "  left out: 127.0.0.1 (adapter Loopback Pseudo-Interface 1 is not up)" in none.out


@needs_powershell
def test_verbose_prints_what_the_run_printed_before_the_quiet_output_and_no_verbose_lines_of_cmdlets(bench):
    result = bench.first_run("-Verbose")
    assert result.rc == 0, result.text
    out = result.out
    for shown in ("Docker answered in", "Port %d: can be bound on all interfaces on Windows." % bench.port, DOWNLOAD_SENTENCE,
                  "Created the satellite folder", "Provisioning (name sat-test; secret to be written;", "Provisioning finished with exit code 0.",
                  "INFO: config: satellite.yaml (written)", "Certificate fingerprint: " + FINGERPRINT_1, "Certificate covers: IPv4 192.168.1.50, 192.168.1.60; names (none)",
                  "Recorded in satellite.env: addresses 192.168.1.50, 192.168.1.60, names (none).", "INFO: fetch-model: stderr line on success",
                  "No container vocalis-satellite-", "Created vocalis-satellite-", "Waiting up to 180 s", "The satellite is listening after about"):
        assert shown in out, shown
    # -Verbose is read and reset: no cmdlet adds a "VERBOSE:" line of its own (New-Item, Move-Item and the rest would)
    assert "VERBOSE:" not in out and "VERBOSE:" not in result.err
    # and no parameter of that name is declared: PowerShell's own switch is what the script reads
    assert "[Parameter" not in script_text().split("param(", 1)[1].split(")", 1)[0]


@needs_powershell
def test_output_is_utf_8_without_a_byte_order_mark_when_it_is_not_a_terminal(bench):
    # the first act of the script (design, feasibility check of October 11, 2026): a non-ASCII path must reach a wrapper intact
    bench.root = bench.tmp / "sat éè ü root"
    result = bench.first_run()
    assert result.rc == 0, result.text
    assert not result.out_bytes.startswith(b"\xef\xbb\xbf"), result.out_bytes[:20]
    assert f"Satellite folder: {bench.root}".encode("utf-8") in result.out_bytes
    assert b"?" not in f"Satellite folder: {bench.root}".encode("utf-8")
    assert f"Satellite folder: {bench.root}" in bench.log_text()  # the log is UTF-8 too
    assert bench.env_values()["SATELLITE_ROOT"] == str(bench.root)
    assert bench.result_file()["CERTIFICATE_FILE"] == str(bench.root / "data" / "certs" / "cert.pem")


# ---- item 2: the log ------------------------------------------------------------------------------------------------------

@needs_powershell
def test_the_log_is_in_the_satellite_logs_folder_named_with_utc_time_and_process_id_and_has_every_line(bench):
    before = datetime.datetime.now(datetime.timezone.utc)
    result = bench.first_run()
    after = datetime.datetime.now(datetime.timezone.utc)
    assert result.rc == 0, result.text
    logs = bench.setup_logs()
    assert len(logs) == 1 and logs[0].parent == bench.root / "logs"
    match = re.fullmatch(r"setup-(\d{8})-(\d{6})-(\d+)\.log", logs[0].name)
    assert match, logs[0].name
    stamped = datetime.datetime.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S").replace(tzinfo=datetime.timezone.utc)
    assert before - datetime.timedelta(seconds=60) <= stamped <= after  # UTC, not local time
    text = bench.log_text()
    assert f"Setup log opened: process {match.group(3)}," in text  # the name's process ID is the run's own
    # the log holds every screen line (from the banner on, held in memory until the log could open) ...
    for line in result.out.splitlines():
        if line.strip():
            assert line in text, line
    # ... and the hidden ones, with every docker call and every line it returned
    for hidden in ("docker info", "  out: fake docker info", "  err: INFO: config: satellite.yaml (written)", "  out: card=0\tNVIDIA GeForce RTX 4090",
                   "  out: secret=written", "  out: fingerprint=" + FINGERPRINT_1, "  err: INFO: show: certificate read", "INFO: fetch-model: stderr line on success",
                   "Certificate covers:", "Recorded in satellite.env", "  satellite log: INFO listening on https://0.0.0.0:7880"):
        assert hidden in text, hidden
    assert text.count("docker run") >= 4 and "--entrypoint python" in text
    # the path is printed once, last
    assert result.out.count(str(logs[0])) == 1 and result.out.splitlines()[-1] == f"Setup log: {logs[0]}"
    assert SECRET not in text


@needs_powershell
def test_only_the_last_ten_setup_logs_are_kept_and_nothing_else_in_the_logs_folder_is_touched(bench):
    assert bench.first_run().rc == 0
    folder = bench.root / "logs"
    old = []
    for number in range(12):
        path = folder / f"setup-2020010{number % 10}-0000{number:02d}-{100 + number}.log"
        path.write_text("an old setup log\n", encoding="ascii")
        old.append(path)
    others = [folder / "vocalis-satellite.log", folder / "setup-notes.txt", folder / "setup-20200101-000000.log"]
    for path in others:
        path.write_text("not a setup log of this script\n", encoding="ascii")
    result = bench.again()
    assert result.rc == 0, result.text
    kept = bench.setup_logs()
    names = sorted(path.name for path in kept)
    # 10 in all: this run's, the first run's, and the eight newest old ones; the four oldest old ones are gone
    pattern = re.compile(r"setup-\d{8}-\d{6}-\d+\.log")
    assert len([name for name in names if pattern.fullmatch(name)]) == 10, names
    assert bench.newest_log().name in names
    assert not any(path.exists() for path in sorted(old)[:4]) and all(path.exists() for path in sorted(old)[-8:])
    assert all(path.exists() for path in others)


@needs_powershell
def test_a_refused_folder_gets_no_log_and_no_result_file_and_the_message_names_none(bench):
    # not empty and not a satellite folder
    bench.root.mkdir()
    (bench.root / "photo.jpg").write_bytes(b"keep me")
    before = tree_state(bench.root)
    result = bench.first_run()
    assert result.rc == 1 and "not empty and is not a satellite folder" in result.out and "Log:" not in result.out and "Setup log:" not in result.out
    assert tree_state(bench.root) == before and not (bench.root / "logs").exists() and not bench.result_path.exists()
    assert_one_error_line_and_no_error_record(result)
    # a satellite.env this script did not write
    shutil.rmtree(bench.root)
    assert bench.first_run().rc == 0
    good = bench.satellite_env.read_text(encoding="utf-8")
    bench.satellite_env.write_text(good + "FUTURE_KEY=1\n", encoding="utf-8")
    logs_before, result_before = [path.name for path in bench.setup_logs()], bench.result_path.read_bytes()
    unreadable = bench.again()
    assert unreadable.rc == 1 and "unknown key 'FUTURE_KEY'" in unreadable.out and "Log:" not in unreadable.out
    assert [path.name for path in bench.setup_logs()] == logs_before and bench.result_path.read_bytes() == result_before
    assert_one_error_line_and_no_error_record(unreadable)
    # a satellite.env that is locked by another program: the read throws an exception of its own, not a refusal of the script's
    bench.satellite_env.write_text(good, encoding="utf-8")
    handle = lock_exclusively(bench.satellite_env)
    try:
        locked = bench.again()
    finally:
        unlock(handle)
    assert locked.rc == 1 and "(unexpected error at line " in locked.out and "Log:" not in locked.out
    assert_one_error_line_and_no_error_record(locked)  # ONE line even for an unexpected error, never an error record
    assert [path.name for path in bench.setup_logs()] == logs_before and bench.result_path.read_bytes() == result_before


def lock_exclusively(path):
    """Opens the file with no sharing at all (CreateFileW with share mode 0), so any other open of it fails."""
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    handle = kernel32.CreateFileW(str(path), 0x80000000, 0, None, 3, 0x80, None)  # GENERIC_READ, no sharing, OPEN_EXISTING
    assert handle not in (None, wintypes.HANDLE(-1).value), ctypes.get_last_error()
    return handle


def unlock(handle):
    import ctypes
    ctypes.WinDLL("kernel32").CloseHandle(ctypes.c_void_p(handle))


@needs_powershell
def test_every_failure_after_the_folder_is_accepted_ends_with_the_log_path_and_a_refusal_of_the_arguments_is_logged_too(bench):
    assert bench.first_run().rc == 0
    result = bench.again("-Port", str(bench.port + 1))  # a refusal of an argument, after satellite.env was accepted
    assert result.rc == 1 and result.calls == []
    log = bench.newest_log()
    assert error_lines(result) == [f"ERROR: This satellite folder uses port {bench.port}, and the port of an existing folder is fixed; "
                                   f"-Port {bench.port + 1} is refused. Run without -Port, or remove the satellite and start in a new folder. Log: {log}"]
    assert "-Port" in log.read_text(encoding="utf-8") and "ERROR: This satellite folder uses port" in log.read_text(encoding="utf-8")
    assert_one_error_line_and_no_error_record(result)
    failed = bench.again(env={"FAKE_EXIT_fetch_model": 1})
    assert failed.rc == 1 and error_lines(failed)[0].endswith(f" Log: {bench.newest_log()}")


@needs_powershell
def test_an_unwritable_log_gives_one_warning_and_never_fails_the_run(bench):
    assert bench.first_run().rc == 0
    folder = bench.root / "logs"
    logs_before = [path.name for path in bench.setup_logs()]
    # Everyone is denied creating files in the logs folder (and the deny is lifted again below)
    subprocess.run(["icacls", str(folder), "/deny", "*S-1-1-0:(OI)(CI)(WD,AD)"], check=True, capture_output=True)
    try:
        result = bench.again()
    finally:
        subprocess.run(["icacls", str(folder), "/remove:d", "*S-1-1-0"], check=True, capture_output=True)
    assert result.rc == 0, result.text
    assert result.out.count("WARNING: the setup log could not be opened") == 1, result.out
    assert [path.name for path in bench.setup_logs()] == logs_before  # no new log
    assert "Setup log:" not in result.out
    assert bench.result_file()["LOG_FILE"] == "" and bench.result_file()["EXIT_CODE"] == "0"  # the result file is still written


# ---- item 4: the result file ----------------------------------------------------------------------------------------------

def assert_result(bench, expected, *, code=0):
    """setup-result.txt has exactly the agreed keys in order, the one-line values, and the expected ones."""
    result = bench.result_file()
    assert list(result) == RESULT_KEYS, list(result)
    assert result["SCHEMA"] == "1" and result["EXIT_CODE"] == str(code), result
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", result["FINISHED"]), result["FINISHED"]
    for key, value in expected.items():
        assert result[key] == value, (key, result)
    assert result["LOG_FILE"] == str(bench.newest_log())
    return result


def expected_row(bench, **overrides):
    satellite_id = bench.env_values()["SATELLITE_ID"]
    cert = bench.root / "data" / "certs" / "cert.pem"
    row = {"FAILURE": "", "SATELLITE_ID": satellite_id, "NAME": "sat-test", "PORT": str(bench.port), "IMAGE": IMAGE,
           "CONTAINER": f"vocalis-satellite-{satellite_id}", "RUNNING": "yes", "AUTOSTART": "on",
           "URLS": ",".join(f"https://{ip}:{bench.port}" for ip in ("192.168.1.50", "192.168.1.60")),
           "CERTIFICATE_FILE": str(cert), "FINGERPRINT": FINGERPRINT_1, "MADE_SECRET": "no", "MADE_CERTIFICATE": "no"}
    row.update(overrides)
    return row


@needs_powershell
def test_the_result_file_for_every_row_of_the_outcome_table(bench):
    # first setup finished: MODE first, upload-and-tick, running
    assert bench.first_run("-Address", "nas.lan").rc == 0
    assert_result(bench, expected_row(bench, MODE="first", VOCALIS_STEPS="upload-and-tick", MADE_SECRET="yes", MADE_CERTIFICATE="yes"))
    # plain rerun: rerun, maybe
    assert bench.again().rc == 0
    assert_result(bench, expected_row(bench, MODE="rerun", VOCALIS_STEPS="maybe"))
    # new secret only: renew, none; the certificate and its fingerprint are unchanged
    bench.secret_file.write_text(SECOND_SECRET, encoding="ascii")
    assert bench.again("-NewSecret", "-SecretFile", str(bench.secret_file)).rc == 0
    assert_result(bench, expected_row(bench, MODE="renew", VOCALIS_STEPS="none", MADE_SECRET="yes"))
    # new certificate alone: renew, upload, the NEW fingerprint
    assert bench.again("-NewCertificate").rc == 0
    second = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:02"
    assert_result(bench, expected_row(bench, MODE="renew", VOCALIS_STEPS="upload", MADE_CERTIFICATE="yes", FINGERPRINT=second))
    # new secret and new certificate together: renew, upload, both made
    assert bench.again("-NewSecret", "-NewCertificate", "-SecretFile", str(bench.secret_file)).rc == 0
    third = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:03"
    assert_result(bench, expected_row(bench, MODE="renew", VOCALIS_STEPS="upload", MADE_SECRET="yes", MADE_CERTIFICATE="yes", FINGERPRINT=third))
    # update: update, none, the new image
    assert bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE).rc == 0
    assert_result(bench, expected_row(bench, MODE="update", VOCALIS_STEPS="none", IMAGE=NEW_IMAGE, FINGERPRINT=third))
    # autostart alone: autostart, none, as inspected (running), the setting
    assert bench.again("-Autostart", "off").rc == 0
    assert_result(bench, expected_row(bench, MODE="autostart", VOCALIS_STEPS="none", IMAGE=NEW_IMAGE, AUTOSTART="off", FINGERPRINT=third))
    # remove: remove, remove-row, not running, the certificate still named (the folder is left)
    assert bench.run("-Root", str(bench.root), "-Remove").rc == 0
    assert_result(bench, expected_row(bench, MODE="remove", VOCALIS_STEPS="remove-row", IMAGE=NEW_IMAGE, AUTOSTART="off", RUNNING="no", FINGERPRINT=third))


@needs_powershell
def test_the_result_file_with_both_new_options_together(bench):
    # -Autostart off with a first run: MODE first, and the setting is in satellite.env, the container and the result
    result = bench.first_run("-Autostart", "off", "-Verbose")
    assert result.rc == 0, result.text
    assert_result(bench, expected_row(bench, MODE="first", VOCALIS_STEPS="upload-and-tick", AUTOSTART="off", MADE_SECRET="yes", MADE_CERTIFICATE="yes"))
    assert bench.env_values()["AUTOSTART"] == "off" and bench.env_values()["CERT_FINGERPRINT"] == FINGERPRINT_1
    # a plain rerun keeps the recorded value
    assert bench.again().rc == 0
    assert bench.result_file()["AUTOSTART"] == "off" and bench.env_values()["AUTOSTART"] == "off"
    # -Verbose together with the small operation: both apply, the result is the small operation's
    assert bench.again("-Autostart", "on", "-Verbose").rc == 0
    assert bench.result_file()["MODE"] == "autostart" and bench.result_file()["AUTOSTART"] == "on"


@needs_powershell
def test_the_result_file_is_deleted_at_the_start_and_a_run_that_is_killed_leaves_none(bench):
    assert bench.first_run().rc == 0 and bench.result_path.is_file()
    # The next run is stopped inside Docker's container inspect (the fake hangs there), so it never reaches the end.
    process = bench.start("-Root", str(bench.root), env={"FAKE_IMAGE_LOCAL": "1", "FAKE_HANG": "container"})
    try:
        deadline = time.monotonic() + 120
        # the real signal: the fake has logged the call it is now hanging in (a bounded safety deadline around it)
        while not any(line.startswith("docker\tcontainer\tinspect") for line in bench.log.read_text(encoding="utf-8").splitlines()):
            assert process.poll() is None and time.monotonic() < deadline, "the run ended or never reached the hanging call"
            time.sleep(0.1)
        assert not bench.result_path.exists(), "the previous run's result file must be gone before the run does anything else"
    finally:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True)
        process.wait(timeout=60)
        for handle in process.test_files:
            handle.close()
    assert not bench.result_path.exists()
    # nothing of the fake is left running, and the killed run's log is there but has no end
    left = subprocess.run([POWERSHELL, "-NoProfile", "-Command",
                           f"@(Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq '{bench.bin / 'docker.exe'}' }}).Count"],
                          capture_output=True, text=True, timeout=60)
    assert left.stdout.strip() == "0", left.stdout + left.stderr
    assert "Setup log:" not in bench.log_text() and "Wrote the result file" not in bench.log_text()


FAILURE_AT_EACH_STEP = [
    # (id, environment of the fake, exit code, text in the failure, running afterwards, certificate exists, made secret, made certificate)
    ("pull", {"FAKE_PULL_EXIT": 1}, 1, "docker pull failed with exit code 1", "no", False, "no", "no"),
    ("gpu", {"FAKE_EXIT_check_gpu": 3}, 12, "no NVIDIA card it can use", "no", False, "no", "no"),
    ("secret-refused", {"FAKE_EXIT_provision": 4}, 1, "The secret was not accepted", "no", False, "no", "no"),
    ("provision", {"FAKE_EXIT_provision": 5}, 1, "configuration or certificate could not be written or read", "no", False, "no", "no"),
    ("show", {"FAKE_EXIT_show": 5}, 1, "There is no readable certificate", "no", True, "yes", "yes"),
    ("model", {"FAKE_EXIT_fetch_model": 1}, 1, "model download or check did not finish (exit code 1)", "no", True, "yes", "yes"),
    ("create", {"FAKE_RUN_D_EXIT": 125}, 1, "The satellite container could not be created", "no", True, "yes", "yes"),
    ("listening", {"FAKE_NO_LISTEN": 1}, 13, "The satellite did not come up", "yes", True, "yes", "yes"),
]


@needs_powershell
@pytest.mark.parametrize("name, environment, code, message, running, has_cert, made_secret, made_cert", FAILURE_AT_EACH_STEP,
                         ids=[case[0] for case in FAILURE_AT_EACH_STEP])
def test_a_failure_at_each_step_is_one_error_line_that_ends_with_the_log_path_and_a_failure_result(
        bench, name, environment, code, message, running, has_cert, made_secret, made_cert):
    result = bench.first_run(env=environment)
    assert result.rc == code, result.text
    assert_one_error_line_and_no_error_record(result)
    log = bench.newest_log()
    failure = error_lines(result)[0]
    assert message in failure and failure.endswith(f" Log: {log}"), failure
    row = assert_result(bench, {"MODE": "first", "VOCALIS_STEPS": "unknown", "RUNNING": running, "MADE_SECRET": made_secret,
                                "MADE_CERTIFICATE": made_cert, "AUTOSTART": "on", "IMAGE": IMAGE, "PORT": str(bench.port), "NAME": "sat-test"}, code=code)
    # the failure text is the ERROR line's text, flattened to one line, without the prefix and without the log path
    assert row["FAILURE"] == failure[len("ERROR: "):-len(f" Log: {log}")] and "\n" not in row["FAILURE"]
    cert = bench.root / "data" / "certs" / "cert.pem"
    assert row["CERTIFICATE_FILE"] == (str(cert) if has_cert else "")
    if not has_cert:
        assert row["FINGERPRINT"] == "" and row["URLS"] == ""
    # the log ends with the same line, and the result inspection (RUNNING) was the last thing asked of Docker
    assert f"ERROR: {row['FAILURE']}" in log.read_text(encoding="utf-8")
    assert result.all_kinds()[-1] == "result-inspect"
    assert Path(row["LOG_FILE"]) == log


@needs_powershell
def test_a_failure_of_a_later_run_replaces_the_previous_result_and_running_is_what_docker_says(bench):
    assert bench.first_run().rc == 0
    assert bench.result_file()["EXIT_CODE"] == "0"
    # the satellite is running: the failed run says so
    failed = bench.again(env={"FAKE_EXIT_fetch_model": 1})
    assert failed.rc == 1
    assert_result(bench, expected_row(bench, MODE="rerun", VOCALIS_STEPS="unknown", RUNNING="yes",
                                      FAILURE=error_lines(failed)[0][len("ERROR: "):-len(f" Log: {bench.newest_log()}")]), code=1)
    # the container is stopped: no (a restarting container is not running either)
    edit_container(bench, status="exited")
    stopped = bench.again(env={"FAKE_EXIT_fetch_model": 1})
    assert stopped.rc == 1 and bench.result_file()["RUNNING"] == "no"
    edit_container(bench, status="restarting")
    looping = bench.again()
    assert looping.rc == 13 and bench.result_file()["RUNNING"] == "no" and bench.result_file()["EXIT_CODE"] == "13"
    # Docker answers the run's calls but not the final question: unknown (here every inspect fails)
    edit_container(bench, status="running")
    broken = bench.again(env={"FAKE_INSPECT_EXIT": 1})
    assert broken.rc == 1 and bench.result_file()["RUNNING"] == "unknown"
    assert_one_error_line_and_no_error_record(broken)


@needs_powershell
def test_when_docker_is_missing_or_not_answering_the_result_says_unknown_and_a_new_folder_gets_none(bench):
    assert bench.first_run().rc == 0
    down = bench.again(env={"FAKE_INFO_EXIT": 1})
    assert down.rc == 11 and down.kinds() == ["info"] and down.all_kinds() == ["info"], down.text  # no second question to a dead engine
    assert_result(bench, expected_row(bench, MODE="rerun", VOCALIS_STEPS="unknown", RUNNING="unknown",
                                      FAILURE=error_lines(down)[0][len("ERROR: "):-len(f" Log: {bench.newest_log()}")]), code=11)
    missing = bench.again(docker=False)
    assert missing.rc == 10 and bench.result_file()["RUNNING"] == "unknown" and bench.result_file()["EXIT_CODE"] == "10"
    assert_one_error_line_and_no_error_record(missing)
    # a folder that does not exist yet is not accepted (nothing was created), so there is neither a log nor a result file
    other = bench.tmp / "never created"
    refused = bench.run("-Root", str(other), "-Image", IMAGE, "-SecretFile", str(bench.secret_file), env={"FAKE_INFO_EXIT": 1})
    assert refused.rc == 11 and not other.exists() and "Log:" not in refused.out


@needs_powershell
def test_a_refusal_after_the_folder_is_accepted_writes_a_result_with_running_unknown_as_no_docker_call_was_made(bench):
    assert bench.first_run().rc == 0
    refused = bench.again("-Name", "other")
    assert refused.rc == 1 and refused.calls == [] and refused.all_kinds() == []
    assert_result(bench, expected_row(bench, MODE="rerun", VOCALIS_STEPS="unknown", RUNNING="unknown",
                                      FAILURE=error_lines(refused)[0][len("ERROR: "):-len(f" Log: {bench.newest_log()}")]), code=1)


# ---- item 5: start with Docker ---------------------------------------------------------------------------------------------

@needs_powershell
def test_the_restart_token_follows_autostart_and_the_golden_vector_is_unchanged(bench):
    on = bench.first_run()  # the default is on
    assert on.rc == 0, on.text
    satellite_id = bench.env_values()["SATELLITE_ID"]
    run_on = on.of_kind("run-d")[0]
    assert run_on[run_on.index("--restart") + 1] == "unless-stopped" and run_on == long_lived(satellite_id, bench.port, IMAGE, bench.root)[0]
    assert bench.env_values()["AUTOSTART"] == "on" and container_policy(bench) == "unless-stopped"
    shutil.rmtree(bench.root)
    off = bench.first_run("-Autostart", "off")
    assert off.rc == 0, off.text
    satellite_id = bench.env_values()["SATELLITE_ID"]
    run_off = off.of_kind("run-d")[0]
    assert run_off[run_off.index("--restart") + 1] == "no"
    expected, digest = long_lived(satellite_id, bench.port, IMAGE, bench.root, restart="no")
    assert run_off == expected and f"vocalis.satellite.spec={digest}" in run_off
    assert bench.env_values()["AUTOSTART"] == "off" and container_policy(bench) == "no"
    assert digest != long_lived(satellite_id, bench.port, IMAGE, bench.root)[1]  # the hash covers the restart token
    # the value is case-insensitive and anything else is refused before Docker is asked
    shutil.rmtree(bench.root)
    assert bench.first_run("-Autostart", "OFF").rc == 0 and bench.env_values()["AUTOSTART"] == "off"
    shutil.rmtree(bench.root)
    bad = bench.first_run("-Autostart", "maybe")
    assert bad.rc == 1 and "-Autostart must be on or off; 'maybe' is neither." in bad.out and bad.calls == [] and not bench.root.exists()
    assert_one_error_line_and_no_error_record(bad)


@needs_powershell
def test_the_golden_vector_function_takes_the_value_as_an_argument_that_defaults_to_on(tmp_path):
    body = (
        "$ServiceUser = '1000:1000'; $ContainerPort = 7880\n"
        "$on = Get-LongLivedSpec -Id 'vs-0123456789ab' -HostPort 7880 -ImageReference '" + GOLDEN_IMAGE + "' -RootForward '/srv/vocalis-satellite'\n"
        "$explicit = Get-LongLivedSpec -Id 'vs-0123456789ab' -HostPort 7880 -ImageReference '" + GOLDEN_IMAGE + "' -RootForward '/srv/vocalis-satellite' -Autostart 'on'\n"
        "$off = Get-LongLivedSpec -Id 'vs-0123456789ab' -HostPort 7880 -ImageReference '" + GOLDEN_IMAGE + "' -RootForward '/srv/vocalis-satellite' -Autostart 'off'\n"
        "[pscustomobject]@{ On = $on.Hash; Explicit = $explicit.Hash; Off = $off.Hash; OffTokens = @($off.Hashed) } | ConvertTo-Json -Compress\n")
    result = run_functions(["Get-SpecHash", "New-BindMount", "Get-LongLivedSpec"], body, tmp_path=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    answer = json.loads(result.stdout.strip().splitlines()[-1])
    assert answer["On"] == GOLDEN_SHA256 and answer["Explicit"] == GOLDEN_SHA256 and answer["Off"] != GOLDEN_SHA256
    assert answer["OffTokens"][answer["OffTokens"].index("--restart") + 1] == "no"
    assert [token for token in answer["OffTokens"] if token != "no"] == [token for token in GOLDEN_TOKENS if token != "unless-stopped"]


@needs_powershell
def test_the_two_small_operations_name_the_satellite_and_its_folder_under_the_checks_header(bench):
    # Live test, October 11, 2026: "[1/2] Checks" had one line under it in the setup path only; the two small operations
    # (-Autostart alone, -Remove) print "Satellite <id> in <folder>." there, the same sentence as satellite-setup.sh.
    assert bench.first_run().rc == 0
    line = f"Satellite {bench.env_values()['SATELLITE_ID']} in {bench.root}."
    for arguments in (("-Autostart", "off"), ("-Remove",)):
        result = bench.again(*arguments) if arguments[0] == "-Autostart" else bench.run("-Root", str(bench.root), *arguments)
        assert result.rc == 0, result.text
        lines = result.out.splitlines()
        checks = [number for number, text in enumerate(lines) if text.startswith("[1/2] Checks")]
        assert len(checks) == 1, (arguments, lines)
        assert lines[checks[0] + 1] == line, (arguments, lines[checks[0]:checks[0] + 3])
        assert result.out.count(line) == 1, arguments
    # the setup path keeps its own, present wording
    again = bench.again()
    assert f"Satellite folder: {bench.root}" in again.out and line not in again.out


@needs_powershell
def test_the_small_operation_makes_exactly_one_docker_update_and_nothing_else(bench):
    assert bench.first_run().rc == 0
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    container_before = bench.container_file().read_text(encoding="utf-8").splitlines()
    result = bench.again("-Autostart", "off")
    assert result.rc == 0, result.text
    # info, the one inspect the script always makes, and exactly one update: no pull, model check, recreate, restart or start
    assert result.kinds() == ["info", "inspect", "update"], result.kinds()
    assert result.of_kind("update") == [["update", "--restart", "no", name]]
    assert bench.env_values()["AUTOSTART"] == "off" and container_policy(bench) == "no"
    after = bench.container_file().read_text(encoding="utf-8").splitlines()
    assert after[:4] == container_before[:4] and after[4] == "no"  # status, restarts, start time and label are untouched
    assert step_headers(result) == [(1, 2, "Checks"), (2, 2, "Autostart")]
    assert "Start with Docker is now off for " + name in result.out and "was not restarted" in result.out
    assert error_lines(result) == [] and "NativeCommandError" not in result.text
    # and back: the label is the one made under on, which still counts as current
    back = bench.again("-Autostart", "on")
    assert back.rc == 0 and back.kinds() == ["info", "inspect", "update"] and back.of_kind("update") == [["update", "--restart", "unless-stopped", name]]
    assert bench.env_values()["AUTOSTART"] == "on" and container_policy(bench) == "unless-stopped"
    # the same value again is still one update (idempotent), and still nothing else
    same = bench.again("-Autostart", "on")
    assert same.kinds() == ["info", "inspect", "update"]


@needs_powershell
@pytest.mark.parametrize("state", ["no secret", "no certificate", "no configuration", "stopped container", "restarting container", "no container"])
def test_the_small_operation_is_always_the_small_operation_whatever_state_the_folder_is_in(bench, state):
    assert bench.first_run().rc == 0
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    secret, cert, key, yaml_ = (bench.root / "secrets" / "vocalis-satellite-master", bench.root / "data" / "certs" / "cert.pem",
                                bench.root / "data" / "certs" / "key.pem", bench.root / "data" / "satellite.yaml")
    if state == "no secret":
        secret.unlink()
    elif state == "no certificate":
        cert.unlink()
        key.unlink()
    elif state == "no configuration":
        yaml_.unlink()
    elif state == "stopped container":
        edit_container(bench, status="exited")
    elif state == "restarting container":
        edit_container(bench, status="restarting")
    elif state == "no container":
        bench.container_file().unlink()
    folder_before = {path: path.read_bytes() for path in bench.root.rglob("*") if path.is_file() and path.name not in ("satellite.env",)
                     and path.parent.name != "logs" and path.name != "setup-result.txt"}
    # a run that needs a secret would refuse here (no file, no console, -NoPrompt): the small operation never turns into a resumed first setup
    result = bench.again("-Autostart", "off", "-NoPrompt")
    assert result.rc == 0, result.text
    expected = ["info", "inspect"] + ([] if state == "no container" else ["update"])
    assert result.kinds() == expected, result.kinds()
    assert not any(kind in result.kinds() for kind in ("pull", "check-gpu", "provision", "show", "fetch-model", "rm", "run-d", "start", "restart"))
    assert bench.env_values()["AUTOSTART"] == "off" and bench.result_file()["MODE"] == "autostart"
    assert {path: path.read_bytes() for path in folder_before} == folder_before  # nothing else in the folder changed
    if state == "no container":
        assert "There is no container named" in result.out and bench.result_file()["RUNNING"] == "no"
    else:
        assert container_policy(bench) == "no"
        assert bench.result_file()["RUNNING"] == ("yes" if state in ("no secret", "no certificate", "no configuration") else "no")
    assert bench.result_file()["VOCALIS_STEPS"] == "none" and name in bench.result_file()["CONTAINER"]


@needs_powershell
def test_the_small_operation_needs_docker_to_answer_and_records_nothing_when_it_does_not(bench):
    assert bench.first_run().rc == 0
    env_before = bench.satellite_env.read_bytes()
    down = bench.again("-Autostart", "off", env={"FAKE_INFO_EXIT": 1})
    assert down.rc == 11 and down.kinds() == ["info"] and not down.of_kind("update"), down.text
    assert bench.satellite_env.read_bytes() == env_before and container_policy(bench) == "unless-stopped"
    missing = bench.again("-Autostart", "off", docker=False)
    assert missing.rc == 10 and bench.satellite_env.read_bytes() == env_before
    # Docker answers `info` but not the container inspect: the file is still untouched
    broken = bench.again("-Autostart", "off", env={"FAKE_INSPECT_EXIT": 1})
    assert broken.rc == 1 and not broken.of_kind("update") and bench.satellite_env.read_bytes() == env_before
    for result in (down, missing, broken):
        assert_one_error_line_and_no_error_record(result)


@needs_powershell
@pytest.mark.parametrize("had_the_line", [True, False], ids=["file with AUTOSTART", "file without AUTOSTART"])
def test_a_refused_docker_update_puts_the_recorded_value_back_and_shows_the_reason(bench, had_the_line):
    assert bench.first_run().rc == 0
    if not had_the_line:
        # a satellite.env written before this version: neither of the two new keys
        lines = [line for line in bench.satellite_env.read_text(encoding="utf-8").splitlines() if not line.startswith(("AUTOSTART=", "CERT_FINGERPRINT="))]
        bench.satellite_env.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="")
    env_before = bench.satellite_env.read_bytes()
    policy_before = container_policy(bench)
    result = bench.again("-Autostart", "off", env={"FAKE_UPDATE_EXIT": 1})
    assert result.rc == 1, result.text
    assert result.kinds() == ["info", "inspect", "update"]
    assert "Docker refused to change the restart policy" in result.out and "fake update refused" in result.out
    assert "The recorded setting was put back." in result.out
    assert bench.satellite_env.read_bytes() == env_before, "the file must be exactly as it was"
    assert container_policy(bench) == policy_before
    assert_one_error_line_and_no_error_record(result)
    assert_result(bench, {"MODE": "autostart", "AUTOSTART": "on", "VOCALIS_STEPS": "unknown", "RUNNING": "yes"}, code=1)


@needs_powershell
def test_autostart_given_with_another_operation_is_applied_by_that_operation(bench):
    assert bench.first_run().rc == 0
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    result = bench.again("-Autostart", "off", "-NewCertificate")
    assert result.rc == 0, result.text
    # not the small operation: the certificate is replaced, the container restarted, the setting applied by docker update
    assert result.of_kind("provision") and result.of_kind("restart") == [["restart", name]] and result.of_kind("update") == [["update", "--restart", "no", name]]
    assert not result.of_kind("rm") and not result.of_kind("run-d")  # the label made under on still counts as current
    assert bench.env_values()["AUTOSTART"] == "off" and container_policy(bench) == "no" and bench.result_file()["MODE"] == "renew"
    # with -Update the value is recorded with the image, after the checks, and a failure before that leaves the file as it was
    env_before = bench.satellite_env.read_bytes()
    failed = bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE, "-Autostart", "on", env={"FAKE_PULL_EXIT": 1})
    assert failed.rc == 1 and bench.satellite_env.read_bytes() == env_before
    updated = bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE, "-Autostart", "on")
    assert updated.rc == 0 and bench.env_values()["AUTOSTART"] == "on" and bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE
    assert run_d_restart(updated) == "unless-stopped" and container_policy(bench) == "unless-stopped"
    assert bench.result_file()["MODE"] == "update"


def run_d_restart(result):
    run_d = result.of_kind("run-d")[0]
    return run_d[run_d.index("--restart") + 1]


@needs_powershell
def test_a_label_made_under_the_other_restart_value_counts_as_current_at_both_comparison_sites_and_the_policy_is_corrected(bench):
    # A container made under off carries the off hash. Its folder says off, so nothing is recreated and nothing is corrected.
    assert bench.first_run("-Autostart", "off").rc == 0
    name = f"vocalis-satellite-{bench.env_values()['SATELLITE_ID']}"
    plain = bench.again()
    assert plain.rc == 0 and plain.kinds() == ["info", "inspect", "image-inspect", "show", "fetch-model", "inspect"], plain.kinds()
    assert "GPU check skipped" in plain.out
    # The folder is then switched to on by the small operation: the label stays the off one, the policy follows.
    assert bench.again("-Autostart", "on").rc == 0 and container_policy(bench) == "unless-stopped"
    on_over_off_label = bench.again()
    assert on_over_off_label.rc == 0
    # comparison site 1 (the GPU check) and site 2 (the recreate decision): the check is skipped, nothing is removed or created
    assert "GPU check skipped" in on_over_off_label.out and not on_over_off_label.of_kind("check-gpu")
    assert not on_over_off_label.of_kind("rm") and not on_over_off_label.of_kind("run-d") and not on_over_off_label.of_kind("update")
    # Policy and recorded value disagree (the small operation was interrupted, or someone ran docker update by hand): corrected
    edit_container(bench, policy="no")
    corrected = bench.again()
    assert corrected.rc == 0 and corrected.of_kind("update") == [["update", "--restart", "unless-stopped", name]]
    assert not corrected.of_kind("check-gpu") and not corrected.of_kind("rm") and not corrected.of_kind("run-d") and not corrected.of_kind("restart")
    assert container_policy(bench) == "unless-stopped"
    # a stopped container with the other value's label is started, not recreated, and its policy is corrected first
    bench.again("-Autostart", "off")
    edit_container(bench, status="exited", policy="unless-stopped")
    started = bench.again()
    assert started.rc == 0 and started.of_kind("start") == [["start", name]] and not started.of_kind("rm") and not started.of_kind("run-d")
    assert started.of_kind("update") == [["update", "--restart", "no", name]]
    assert started.kinds().index("update") < started.kinds().index("start")
    # a label that is neither of the two hashes is still "other settings": removed and created again, under the recorded value
    edit_container(bench, label="0" * 64)
    recreated = bench.again()
    assert recreated.rc == 0 and recreated.of_kind("rm") == [["rm", "-f", name]] and run_d_restart(recreated) == "no"


@needs_powershell
def test_a_satellite_env_from_before_autostart_and_cert_fingerprint_is_read_as_on_and_gains_the_lines_at_the_next_save(bench):
    assert bench.first_run().rc == 0
    old_lines = [line for line in bench.satellite_env.read_text(encoding="utf-8").splitlines() if not line.startswith(("AUTOSTART=", "CERT_FINGERPRINT="))]
    assert [line.split("=", 1)[0] for line in old_lines] == OLD_ENV_KEYS
    bench.satellite_env.write_text("\n".join(old_lines) + "\n", encoding="utf-8", newline="")
    result = bench.again()
    assert result.rc == 0, result.text
    assert not result.of_kind("update"), "an absent AUTOSTART is on, and the container's policy is unless-stopped: nothing to correct"
    saved = bench.satellite_env.read_text(encoding="utf-8").splitlines()
    assert [line.split("=", 1)[0] for line in saved] == ENV_KEYS and saved[:11] == old_lines
    assert bench.env_values()["AUTOSTART"] == "on" and bench.env_values()["CERT_FINGERPRINT"] == FINGERPRINT_1
    # every other missing key is still refused, naming it, and an AUTOSTART that is neither on nor off is refused too
    for key in ("SATELLITE_PORT", "DNS_NAMES"):
        without = [line for line in saved if not line.startswith(key + "=")]
        bench.satellite_env.write_text("\n".join(without) + "\n", encoding="utf-8", newline="")
        refused = bench.again()
        assert refused.rc == 1 and f"has no {key} line" in refused.out and refused.calls == [], refused.text
    bench.satellite_env.write_text("\n".join(line.replace("AUTOSTART=on", "AUTOSTART=maybe") for line in saved) + "\n", encoding="utf-8", newline="")
    odd = bench.again()
    assert odd.rc == 1 and "has AUTOSTART='maybe', which is neither on nor off" in odd.out and odd.calls == [], odd.text
    # a file that has the lines but empty values (a CERT_FINGERPRINT before the first show) is fine
    bench.satellite_env.write_text("\n".join(line if not line.startswith("CERT_FINGERPRINT=") else "CERT_FINGERPRINT=" for line in saved) + "\n", encoding="utf-8", newline="")
    assert bench.again().rc == 0 and bench.env_values()["CERT_FINGERPRINT"] == FINGERPRINT_1


# ---- item 6: the fingerprint is recorded ------------------------------------------------------------------------------------

@needs_powershell
def test_cert_fingerprint_is_recorded_after_show_and_follows_the_certificate(bench):
    assert bench.first_run().rc == 0
    assert bench.env_values()["CERT_FINGERPRINT"] == FINGERPRINT_1
    assert bench.again("-NewCertificate").rc == 0
    second = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:02"
    assert bench.env_values()["CERT_FINGERPRINT"] == second and bench.result_file()["FINGERPRINT"] == second
    assert bench.run("-Root", str(bench.root), "-Update", "-Image", NEW_IMAGE).rc == 0
    assert bench.env_values()["CERT_FINGERPRINT"] == second and bench.env_values()["SATELLITE_IMAGE"] == NEW_IMAGE
    # the key is written with the addresses: one save, and a first run that fails before `show` leaves it empty
    shutil.rmtree(bench.root)
    failed = bench.first_run(env={"FAKE_EXIT_show": 5})
    assert failed.rc == 1 and bench.env_values()["CERT_FINGERPRINT"] == "" and bench.env_values()["IP_ADDRESSES"] == ""


# ---- item 7: the plumbing modes ---------------------------------------------------------------------------------------------

def plan_of(result):
    """The KEY=VALUE lines of -ShowPlan: exactly the agreed keys, in order, and nothing else on standard output."""
    lines = result.out.splitlines()
    assert [line.split("=", 1)[0] for line in lines] == PLAN_KEYS, result.text
    return dict(line.split("=", 1) for line in lines)


def assert_nothing_changed(bench, before_tree, result, *, docker_calls=0):
    assert tree_state(bench.root) == before_tree, "a plumbing mode must write no file"
    assert not bench.localappdata.exists(), "...not even the default folder's parents"
    assert len(result.calls) == docker_calls
    # no banner, no step header, no log line
    assert "Vocalis satellite setup for Windows" not in result.out and not re.search(r"^\[\d+/\d+\]", result.out, re.MULTILINE)
    assert "Setup log:" not in result.out and "Log:" not in result.out


@needs_powershell
def test_show_plan_of_a_finished_satellite_is_the_key_value_lines_with_no_docker_call_and_no_file_written(bench):
    assert bench.first_run("-Address", "nas.lan").rc == 0
    before = tree_state(bench.root)
    result = bench.run("-ShowPlan", "-Root", str(bench.root))
    assert result.rc == 0, result.text
    satellite_id = bench.env_values()["SATELLITE_ID"]
    assert plan_of(result) == {
        "SATELLITE": "existing", "SATELLITE_ID": satellite_id, "NAME": "sat-test", "PORT": str(bench.port),
        "CONTAINER": f"vocalis-satellite-{satellite_id}", "AUTOSTART": "on", "IMAGE": IMAGE, "ADDRESSES": "192.168.1.50,192.168.1.60",
        "NEEDS_SECRET": "no", "NEEDS_CERTIFICATE": "no", "SETUP_FINISHED": "yes",
        "CERTIFICATE_FILE": str(bench.root / "data" / "certs" / "cert.pem"), "FINGERPRINT": FINGERPRINT_1}
    assert_nothing_changed(bench, before, result)
    assert result.out_bytes.endswith(b"\n") and not result.out_bytes.startswith(b"\xef\xbb\xbf")
    # an extra address is appended after the found ones (names are not addresses), the recorded values are what a repeat of them gives
    more = bench.run("-ShowPlan", "-Root", str(bench.root), "-Address", "192.168.1.99,other.lan", "-Port", str(bench.port), "-Name", "SAT-test")
    assert plan_of(more)["ADDRESSES"] == "192.168.1.50,192.168.1.60,192.168.1.99"
    assert_nothing_changed(bench, before, more)
    # the previous result file was not touched either (it is deleted by a real run only)
    assert tree_state(bench.root) == before


@needs_powershell
def test_show_plan_of_a_new_satellite_and_of_one_whose_secret_or_certificate_is_still_to_be_made(bench):
    result = bench.run("-ShowPlan", "-Root", str(bench.root), "-Port", str(bench.port), "-Name", "Plan-Name", "-Address", "10.0.0.7")
    assert result.rc == 0, result.text
    assert plan_of(result) == {
        "SATELLITE": "new", "SATELLITE_ID": "", "NAME": "plan-name", "PORT": str(bench.port), "CONTAINER": "", "AUTOSTART": "on", "IMAGE": "",
        "ADDRESSES": "192.168.1.50,192.168.1.60,10.0.0.7", "NEEDS_SECRET": "yes", "NEEDS_CERTIFICATE": "yes", "SETUP_FINISHED": "no",
        "CERTIFICATE_FILE": "", "FINGERPRINT": ""}
    assert not bench.root.exists() and not bench.localappdata.exists() and result.calls == []
    # the defaults: the default port, the computer's name in lower case, on
    defaults = plan_of(bench.run("-ShowPlan", "-Root", str(bench.root)))
    assert defaults["PORT"] == "7880" and defaults["NAME"] == os.environ["COMPUTERNAME"].lower() and defaults["AUTOSTART"] == "on"
    # no usable address at all is not an error: the plan says so with an empty ADDRESSES (the setup program then asks for one)
    none = bench.run("-ShowPlan", "-Root", str(bench.root), network=NO_NETWORK)
    assert none.rc == 0 and plan_of(none)["ADDRESSES"] == "" and not bench.root.exists()
    # a satellite that exists but lacks its secret, or its certificate
    assert bench.first_run().rc == 0
    (bench.root / "secrets" / "vocalis-satellite-master").unlink()
    no_secret = plan_of(bench.run("-ShowPlan", "-Root", str(bench.root)))
    assert (no_secret["SATELLITE"], no_secret["NEEDS_SECRET"], no_secret["NEEDS_CERTIFICATE"], no_secret["SETUP_FINISHED"]) == ("existing", "yes", "no", "no")
    (bench.root / "data" / "certs" / "cert.pem").unlink()
    (bench.root / "data" / "certs" / "key.pem").unlink()
    nothing = plan_of(bench.run("-ShowPlan", "-Root", str(bench.root)))
    assert (nothing["NEEDS_SECRET"], nothing["NEEDS_CERTIFICATE"], nothing["SETUP_FINISHED"], nothing["CERTIFICATE_FILE"]) == ("yes", "yes", "no", "")
    assert nothing["FINGERPRINT"] == FINGERPRINT_1  # the recorded one: no container is asked


@needs_powershell
def test_setup_finished_needs_the_satellites_configuration_file_as_well(bench):
    assert bench.first_run().rc == 0
    assert plan_of(bench.run("-ShowPlan", "-Root", str(bench.root)))["SETUP_FINISHED"] == "yes"
    yaml_path = bench.root / "data" / "satellite.yaml"
    saved = yaml_path.read_bytes()
    yaml_path.unlink()
    without = plan_of(bench.run("-ShowPlan", "-Root", str(bench.root)))
    # secret and certificate are there, so none is needed; only the finished verdict changes
    assert (without["NEEDS_SECRET"], without["NEEDS_CERTIFICATE"], without["SETUP_FINISHED"]) == ("no", "no", "no"), without
    yaml_path.write_bytes(saved)
    assert plan_of(bench.run("-ShowPlan", "-Root", str(bench.root)))["SETUP_FINISHED"] == "yes"


PLAN_REFUSALS = [
    ("bad address", lambda bench: ["-Address", "fe80::1"], "IPv6"),
    ("loopback address", lambda bench: ["-Address", "127.0.0.1"], "loopback"),
    ("bad name", lambda bench: ["-Name", "bad name"], "must start with a letter or digit"),
    ("different port", lambda bench: ["-Port", str(bench.port + 1)], "port of an existing folder is fixed"),
    ("different name", lambda bench: ["-Name", "other"], "name of an existing folder is fixed"),
    # -ShowPlan goes with -Root, -Port, -Name and -Address only (agreed with satellite-setup.sh, October 11, 2026)
    ("with autostart", lambda bench: ["-Autostart", "off"], "-ShowPlan goes with only"),
    ("with no prompt", lambda bench: ["-NoPrompt"], "-ShowPlan goes with only"),
    ("with remove", lambda bench: ["-Remove"], "-ShowPlan goes with only"),
    ("with an operation", lambda bench: ["-Update"], "-ShowPlan goes with only"),
    ("with the secret file", lambda bench: ["-SecretFile", str(bench.secret_file)], "-ShowPlan goes with only"),
    ("with check only", lambda bench: ["-CheckOnly"], "-ShowPlan and -CheckOnly cannot be combined"),
]


@needs_powershell
@pytest.mark.parametrize("label, arguments, message", PLAN_REFUSALS, ids=[case[0] for case in PLAN_REFUSALS])
def test_show_plan_refuses_invalid_input_with_one_error_line_and_exit_1_and_changes_nothing(bench, label, arguments, message):
    assert bench.first_run().rc == 0
    before = tree_state(bench.root)
    if label == "bad name":
        # the name of an existing satellite is fixed (a different one is refused), so a bad new name is tried on a new folder
        target = bench.tmp / "new sat"
        result = bench.run("-ShowPlan", "-Root", str(target), *arguments(bench))
        assert not target.exists()
    else:
        result = bench.run("-ShowPlan", "-Root", str(bench.root), *arguments(bench))
        assert tree_state(bench.root) == before
    assert result.rc == 1 and message in result.out, result.text
    assert_one_error_line_and_no_error_record(result)
    assert result.calls == [] and "Log:" not in result.out
    assert result.out.splitlines()[0].startswith("ERROR: ")  # nothing before it: no banner, no header


@needs_powershell
def test_show_plan_refuses_a_folder_the_script_would_refuse(bench):
    foreign = bench.tmp / "foreign"
    foreign.mkdir()
    (foreign / "photo.jpg").write_bytes(b"keep me")
    refused = bench.run("-ShowPlan", "-Root", str(foreign))
    assert refused.rc == 1 and "not empty and is not a satellite folder" in refused.out and refused.calls == [], refused.text
    assert_one_error_line_and_no_error_record(refused)
    assert [path.name for path in foreign.iterdir()] == ["photo.jpg"]
    assert bench.first_run().rc == 0
    copy = bench.tmp / "copied sat"
    shutil.copytree(bench.root, copy)
    before = tree_state(copy)
    moved = bench.run("-ShowPlan", "-Root", str(copy))
    assert moved.rc == 1 and "appears to have been moved or copied" in moved.out and tree_state(copy) == before
    bench.satellite_env.write_text(bench.satellite_env.read_text(encoding="utf-8") + "FUTURE_KEY=1\n", encoding="utf-8")
    unreadable = bench.run("-ShowPlan", "-Root", str(bench.root))
    assert unreadable.rc == 1 and "unknown key 'FUTURE_KEY'" in unreadable.out and unreadable.calls == []


# ---- -CheckOnly -------------------------------------------------------------------------------------------------------------

def check_lines(result):
    return [line for line in result.out.splitlines() if re.match(r"(OK  |FAIL|SKIP) ", line)]


@needs_powershell
def test_check_only_prints_one_line_per_check_and_exits_0_when_all_pass(bench):
    result = bench.run("-CheckOnly")
    assert result.rc == 0, result.text
    lines = check_lines(result)
    assert [re.match(r"(OK  |FAIL|SKIP) (.+?):", line).group(2) for line in lines] == ["docker.exe", "docker engine", "NVIDIA runtime"], lines
    assert all(line.startswith("OK   ") for line in lines), lines  # the form of setup.ps1 -CheckOnly: status padded to four, a space, name, colon
    assert re.fullmatch(r"OK   docker\.exe: found at .*docker\.exe\.", lines[0]) and re.fullmatch(r"OK   docker engine: answering \(\d+ ms\)\.", lines[1])
    assert re.fullmatch(r"OK   NVIDIA runtime: visible to Docker \(\d+ ms\)\.", lines[2]) and "Prerequisites: all checks passed." in result.out
    # it asks Docker two read-only questions and nothing else, and writes nothing
    assert result.calls == [["info"], ["info", "--format", "{{json .Runtimes}}"]]
    assert not bench.root.exists() and not bench.localappdata.exists() and "Vocalis satellite setup" not in result.out and not re.search(r"^\[\d", result.out, re.MULTILINE)


@needs_powershell
@pytest.mark.parametrize("label, environment, docker, code, expected", [
    ("docker missing", {}, False, 10, ["FAIL docker.exe: not found on PATH.", "SKIP docker engine: docker.exe is missing.", "SKIP NVIDIA runtime: the Docker engine is not answering."]),
    ("engine down", {"FAKE_INFO_EXIT": 1}, True, 11, ["OK   docker.exe:", "FAIL docker engine: docker info failed with exit code 1", "SKIP NVIDIA runtime: the Docker engine is not answering."]),
    ("no nvidia runtime", {"FAKE_NO_NVIDIA": 1}, True, 14, ["OK   docker.exe:", "OK   docker engine:", "FAIL NVIDIA runtime: not visible to Docker."]),
], ids=["docker missing", "engine down", "no nvidia runtime"])
def test_check_only_reports_each_failure_with_a_fix_and_exits_with_the_first_failures_code(bench, label, environment, docker, code, expected):
    result = bench.run("-CheckOnly", env=environment, docker=docker)
    assert result.rc == code, result.text
    lines = check_lines(result)
    assert len(lines) == 3 and all(line.startswith(prefix) for line, prefix in zip(lines, expected)), lines
    failed = [line for line in lines if line.startswith("FAIL")]
    assert len(failed) == 1 and " Fix: " in failed[0] and failed[0].index(" Fix: ") > failed[0].index(":"), failed
    # the last line says how many checks failed in plain words: no exit code, no internal check name (the code is the exit status)
    assert result.out.splitlines()[-1] == "Prerequisites: 1 check failed."
    assert "exit code" not in result.out.splitlines()[-1] and "(" not in result.out.splitlines()[-1]
    assert not bench.root.exists() and not bench.localappdata.exists()
    assert not any(kind in result.kinds() for kind in ("pull", "run-d", "rm", "start", "restart", "update", "provision"))


def test_check_only_bounds_every_check_to_the_60_second_limit():
    text = script_text()
    body = text[text.index("function Invoke-SatelliteCheckOnly"):text.index("function Invoke-SatelliteCheckPort")]
    assert body.count("Invoke-Bounded") == 2 and body.count("-TimeoutSeconds $CheckTimeoutSeconds") == 2
    assert "$CheckTimeoutSeconds = 60" in text


# ---- -CheckPort -------------------------------------------------------------------------------------------------------------

@needs_powershell
def test_check_port_exits_0_for_a_free_port_and_1_with_a_suggested_port_for_a_taken_one(bench):
    port = free_port()
    free = bench.run("-CheckPort", "-Port", str(port))
    assert free.rc == 0 and "Suggested port" not in free.out and free.calls == [], free.text
    with socket.socket() as holder, socket.socket() as second:
        holder.bind(("0.0.0.0", port))
        try:
            second.bind(("0.0.0.0", port + 1))  # the next one is taken too: the suggestion has to skip it
        except OSError:
            pytest.skip("the next port was taken by something else")
        taken = bench.run("-CheckPort", "-Port", str(port))
        suggested = re.findall(r"^Suggested port: (\d+)$", taken.out, re.MULTILINE)
    assert taken.rc == 1 and len(suggested) == 1, taken.text
    assert f"port {port} is already in use on Windows" in taken.out
    assert int(suggested[0]) > port + 1
    with socket.socket() as probe:
        probe.bind(("0.0.0.0", int(suggested[0])))  # the suggestion can be bound
    assert taken.calls == [] and not bench.localappdata.exists() and not bench.root.exists()
    assert "Vocalis satellite setup" not in taken.out and not re.search(r"^\[\d", taken.out, re.MULTILINE)


@needs_powershell
def test_the_plumbing_modes_cannot_be_combined_with_each_other_or_with_an_operation(bench):
    for arguments, message in ((["-CheckOnly", "-CheckPort"], "-CheckOnly and -CheckPort cannot be combined"),
                               (["-CheckPort", "-Root", str(bench.root)], "-CheckPort goes with only"),
                               (["-CheckOnly", "-Remove"], "-CheckOnly goes with only")):
        result = bench.run(*arguments)
        assert result.rc == 1 and message in result.out and result.calls == [], result.text
        assert_one_error_line_and_no_error_record(result)


# ---- -NoPrompt --------------------------------------------------------------------------------------------------------------

@needs_powershell
def test_no_prompt_with_a_needed_secret_and_no_secret_file_is_one_fixed_line_and_never_a_prompt(bench):
    result = bench.run("-Root", str(bench.root), "-Image", IMAGE, "-Port", str(bench.port), "-NoPrompt")
    assert result.rc == 1 and error_lines(result) == [NO_PROMPT_LINE], result.text
    # plain English for a setup program page: none of the option names, and a fixed line
    assert "-SecretFile" not in NO_PROMPT_LINE and "-NoPrompt" not in NO_PROMPT_LINE and NO_PROMPT_LINE.startswith("ERROR: ")
    assert result.calls == [] and not bench.root.exists()  # before anything is created, as every step 1 refusal is
    assert_one_error_line_and_no_error_record(result)
    # the fixed line is the same for a replaced secret on an existing satellite (a log and a result are written there: the folder was accepted)
    assert bench.first_run().rc == 0
    again = bench.again("-NewSecret", "-NoPrompt")
    assert again.rc == 1 and error_lines(again)[0].startswith(NO_PROMPT_LINE) and again.calls == [], again.text
    assert bench.result_file()["FAILURE"] == NO_PROMPT_LINE[len("ERROR: "):] and bench.result_file()["EXIT_CODE"] == "1"
    # nothing else is affected: a secret file, a run that needs no secret, and -Remove all work with it
    assert bench.again("-NewSecret", "-NoPrompt", "-SecretFile", str(bench.secret_file)).rc == 0
    assert bench.again("-NoPrompt").rc == 0
    assert bench.run("-Root", str(bench.root), "-Remove", "-NoPrompt").rc == 0
    # a missing secret on an existing folder is a first setup resumed: -NoPrompt refuses it the same way
    (bench.root / "secrets" / "vocalis-satellite-master").unlink()
    resumed = bench.again("-NoPrompt")
    assert resumed.rc == 1 and error_lines(resumed)[0].startswith(NO_PROMPT_LINE)
    assert not resumed.of_kind("provision")


@needs_powershell
def test_a_first_run_with_autostart_still_has_eight_steps_and_a_new_folder_is_not_the_small_operation(bench):
    result = bench.first_run("-Autostart", "off")
    assert result.rc == 0 and step_headers(result) == EIGHT_STEPS, result.text
    assert bench.result_file()["MODE"] == "first"


# ---- agreed with satellite-setup.sh, October 11, 2026 -----------------------------------------------------------------------

@needs_powershell
def test_only_the_tools_info_lines_are_hidden_any_other_standard_error_line_is_shown(bench):
    extra = "WARNING: the card is warm"
    result = bench.first_run(env={"FAKE_STDERR_EXTRA": extra})
    assert result.rc == 0, result.text
    # shown for the captured calls of the tool (check-gpu, provision, show) ...
    assert result.out.splitlines().count(f"  {extra}") == 3, result.out
    assert "INFO: config: satellite.yaml (written)" not in result.out
    # ... while the model download's standard error goes to the log only
    assert extra in bench.log_text() and result.out.count(extra) == 3
    # a failed model download shows its non-INFO standard-error lines, because they are the reason; INFO lines stay out
    shutil.rmtree(bench.root)
    failed = bench.first_run(env={"FAKE_STDERR_EXTRA": extra, "FAKE_EXIT_fetch_model": 1})
    assert failed.rc == 1 and result.out.count(extra) == 3
    assert failed.out.count(extra) == 4 and "INFO: fetch-model" not in failed.out
    # -Verbose shows all of them
    shutil.rmtree(bench.root)
    verbose = bench.first_run("-Verbose", env={"FAKE_STDERR_EXTRA": extra})
    assert "INFO: config: satellite.yaml (written)" in verbose.out and "INFO: fetch-model: stderr line on success" in verbose.out


@needs_powershell
def test_the_result_file_urls_are_primary_first_in_every_mode_and_running_is_asked_at_exit(bench):
    network = total_metric_routes(sample_network(wifi_metric=5))  # Wi-Fi's .60 is the primary
    assert bench.first_run(network=network).rc == 0
    primary_first = ",".join(f"https://{ip}:{bench.port}" for ip in ("192.168.1.60", "192.168.1.50"))
    assert bench.result_file()["URLS"] == primary_first
    # the small operation, and a refusal that happens before the addresses are read
    assert bench.again("-Autostart", "off", network=network).rc == 0 and bench.result_file()["URLS"] == primary_first
    early = bench.again("-Name", "other", network=network)
    assert early.rc == 1 and bench.result_file()["URLS"] == primary_first and bench.result_file()["RUNNING"] == "unknown"
    assert bench.run("-Root", str(bench.root), "-Remove", network=network).rc == 0 and bench.result_file()["URLS"] == primary_first
    # success also asks Docker at the end (a run that left the container running says yes, one that removed it says no)
    assert bench.again(network=network).all_kinds()[-1] == "result-inspect" and bench.result_file()["RUNNING"] == "yes"
    assert bench.run("-Root", str(bench.root), "-Remove", network=network).all_kinds()[-1] == "result-inspect"
    assert bench.result_file()["RUNNING"] == "no"
