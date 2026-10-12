"""Contract tests for packaging/setup.ps1, the Windows launcher (design section 5, Windows installer).

The parts that need Windows PowerShell (parse check, the loopback bind test, the -CheckOnly and
-PauseOnFailure behavior) run only where powershell.exe exists. The prerequisite checks that need a
live Docker Desktop and WSL are proven by running the script on a real machine, not here.

October 10, 2026 (design amendment 15, "Windows services come back by themselves"): the end-to-end tests at the
bottom run the real setup.ps1 against FAKE docker.exe and wsl.exe programs that this module compiles with
Add-Type (a few lines of C#). The fakes record every call (arguments and selected environment variables) and
return scripted exit codes; they never contact Docker, WSL or the network, and LOCALAPPDATA points into the
test's own folder. test_windows_installer.py reuses the same fakes for the control script.
"""
from pathlib import Path
import json
import os
import re
import shutil
import socket
import subprocess

import pytest


PACKAGING = Path(__file__).resolve().parents[1]
SETUP_PS1 = PACKAGING / "setup.ps1"
SETUP_SH = PACKAGING / "setup.sh"
COMPOSE_HELPER = PACKAGING / "windows-compose.ps1"
POWERSHELL = shutil.which("powershell.exe") if os.name == "nt" else None
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="Windows PowerShell 5.1 is required")


def test_default_ports_match_setup_sh():
    ps1 = SETUP_PS1.read_text(encoding="ascii")
    sh = SETUP_SH.read_text(encoding="utf-8")
    ps1_ports = (int(re.search(r"\$DefaultVocalisPort = (\d+)", ps1).group(1)),
                 int(re.search(r"\$DefaultTaproomPort = (\d+)", ps1).group(1)))
    sh_ports = (int(re.search(r"VOCALIS_PORT=\$\{VOCALIS_PORT_ARG:-(\d+)\}", sh).group(1)),
                int(re.search(r"TAPROOM_PORT=\$\{TAPROOM_PORT_ARG:-(\d+)\}", sh).group(1)))
    assert ps1_ports == sh_ports == (18770, 18771)


def test_setup_ps1_is_ascii_lf_and_documents_its_switches_and_exit_codes():
    raw = SETUP_PS1.read_bytes()
    raw.decode("ascii")  # Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page
    assert b"\r" not in raw
    text = raw.decode("ascii")
    header = text.split("[CmdletBinding()]", 1)[0]
    for switch in ("CheckOnly", "CheckPorts", "PauseOnFailure", "NoBrowser"):
        assert f"[switch]${switch}" in text
        assert f"-{switch}" in header
    codes = [int(code) for code in re.findall(r"^#\s+(\d+)\s{2}", header, re.MULTILINE)]
    # October 10, 2026 (design amendment 15): 19 is "the services could not be started", produced after a finished setup
    assert codes == [0, 1, *range(10, 20)], codes
    for code in range(10, 19):
        assert f"Add-Failure {code} " in text, f"exit code {code} is documented but never produced"
    assert "$ServicesNotStartedExitCode = 19" in text
    assert "return $ServicesNotStartedExitCode" in text
    assert "19  setup.sh finished but the services could not be started" in header


@needs_powershell
def test_setup_ps1_parses_in_windows_powershell():
    command = ("$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile("
               f"'{SETUP_PS1}',[ref]$t,[ref]$e);if($e.Count){{$e|%{{$_.Message}};exit 1}}")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr


def _port_check(tmp_path, port):
    """Run setup.ps1's Test-WindowsLoopbackPort alone (extracted with the PowerShell parser)."""
    driver = tmp_path / "port-check.ps1"
    driver.write_text(
        "param([string]$Script, [int]$Port)\n"
        "$e = $null; $t = $null\n"
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$t, [ref]$e)\n"
        "$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-WindowsLoopbackPort' }, $true)\n"
        ". ([scriptblock]::Create($fn.Extent.Text))\n"
        "$r = Test-WindowsLoopbackPort $Port\n"
        "if ($r) { Write-Output \"BUSY: $r\" } else { Write-Output 'FREE' }\n",
        encoding="ascii")
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(driver), "-Script", str(SETUP_PS1), "-Port", str(port)],
        capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout.strip()


@needs_powershell
def test_windows_port_check_accepts_a_free_port_and_rejects_a_held_one(tmp_path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
    assert _port_check(tmp_path, free_port) == "FREE"
    # The check must release the port it tested: a second look still finds it free.
    assert _port_check(tmp_path, free_port) == "FREE"

    with socket.socket() as holder:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        held_port = holder.getsockname()[1]
        verdict = _port_check(tmp_path, held_port)
        assert verdict.startswith("BUSY:") and f"port {held_port} on 127.0.0.1" in verdict, verdict
        assert "already in use on Windows (socket error 10048)" in verdict, verdict


def _check_only_without_docker(tmp_path, *extra, stdin=""):
    # PATH holds only the PowerShell directory, so docker.exe and wsl.exe cannot be found: the first
    # failing check (docker.exe, code 10) decides the exit code and the dependent checks are skipped.
    env = os.environ.copy()
    env["PATH"] = str(Path(POWERSHELL).parent)
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SETUP_PS1), "-CheckOnly", *extra],
        capture_output=True, text=True, timeout=60, env=env, input=stdin)


@needs_powershell
def test_check_only_exits_with_the_distinct_code_of_the_first_failure(tmp_path):
    result = _check_only_without_docker(tmp_path)
    assert result.returncode == 10, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    assert any(line.startswith("FAIL docker.exe: not found on PATH.") for line in lines), lines
    assert any(line.startswith("SKIP docker engine:") for line in lines), lines
    assert any(line.startswith("FAIL wsl.exe:") for line in lines), lines
    assert any(line.startswith("SKIP NVIDIA runtime:") for line in lines), lines
    assert lines[-1] == "Prerequisites: 2 check(s) failed; exit code 10 (docker.exe).", lines
    assert "Press Enter" not in result.stdout


@needs_powershell
def test_a_normal_run_stops_on_a_failed_prerequisite_with_that_checks_code(tmp_path):
    env = os.environ.copy()
    env["PATH"] = str(Path(POWERSHELL).parent)
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SETUP_PS1),
         "-Root", str(tmp_path / "never created"), "-Variant", "cuda"],
        capture_output=True, text=True, timeout=60, env=env, input="")
    assert result.returncode == 10, result.stdout + result.stderr
    assert "ERROR: docker.exe: not found on PATH." in result.stdout
    assert not (tmp_path / "never created").exists(), "a failed prerequisite must not touch the instance root"


@needs_powershell
def test_pause_on_failure_waits_for_enter_and_keeps_the_exit_code(tmp_path):
    result = _check_only_without_docker(tmp_path, "-PauseOnFailure", stdin="\n")
    assert result.returncode == 10, result.stdout + result.stderr
    assert "Exit code 10. Press Enter to close this window." in result.stdout


def test_setup_ps1_declares_the_seed_models_option_that_setup_sh_accepts():
    # October 9, 2026 (model reuse): -SeedModels is a plain string split on ';', each entry passed on as --seed-models.
    text = SETUP_PS1.read_text(encoding="ascii")
    header = text.split("[CmdletBinding()]", 1)[0]
    assert "[string]$SeedModels" in text and "-SeedModels" in header
    assert "'--seed-models'" in text and "--seed-models) " in SETUP_SH.read_text(encoding="utf-8")


def _seed_arguments(tmp_path, seed_models, scan_parent, wsl="mapped"):
    """Runs setup.ps1's Get-SeedModelArguments alone (extracted with the PowerShell parser) with a stand-in
    wsl.exe function that maps X:\\a\\b to /mnt/x/a/b (or fails, for wsl='fails'). Returns (arguments, error)."""
    driver = tmp_path / "seed-arguments.ps1"
    driver.write_text(
        "param([string]$Script, [string]$SeedModels, [string]$ScanParent, [string]$Wsl)\n"
        "$e = $null; $t = $null\n"
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$t, [ref]$e)\n"
        "$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-SeedModelArguments' }, $true)\n"
        ". ([scriptblock]::Create($fn.Extent.Text))\n"
        "function wsl.exe {\n"
        "  $path = $args[3]\n"
        "  if ($Wsl -eq 'fails') { $global:LASTEXITCODE = 1; return }\n"
        "  $global:LASTEXITCODE = 0\n"
        "  '/mnt/' + $path.Substring(0, 1).ToLower() + '/' + ($path.Substring(3) -replace '\\\\', '/')\n"
        "}\n"
        "$ErrorActionPreference = 'Stop'\n"
        "$out = [ordered]@{ arguments = @(); error = '' }\n"
        "try { $out.arguments = @(Get-SeedModelArguments -SeedModels $SeedModels -ScanParent $ScanParent) } catch { $out.error = $_.Exception.Message }\n"
        "[pscustomobject]$out | ConvertTo-Json -Compress\n",
        encoding="ascii")
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(driver), "-Script", str(SETUP_PS1),
         "-SeedModels", seed_models, "-ScanParent", scan_parent, "-Wsl", wsl],
        capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    import json
    answer = json.loads(result.stdout.strip().splitlines()[-1])
    arguments = answer["arguments"]
    return ([arguments] if isinstance(arguments, str) else arguments), answer["error"]


def _mnt(path):
    path = str(path)
    return "/mnt/" + path[0].lower() + "/" + path[3:].replace("\\", "/")


@needs_powershell
def test_each_seed_models_entry_becomes_a_seed_models_argument_in_order(tmp_path):
    scan = tmp_path / "VocalisDocker"
    for name, has_env in (("instance", True), ("second", True), ("junk", False)):
        (scan / name).mkdir(parents=True)
        if has_env:
            (scan / name / "instance.env").write_text("INSTANCE_ID=vi-x\n", encoding="ascii")
    arguments, error = _seed_arguments(tmp_path, r"E:\Models A; D:\Old Vocalis ;;" + str(scan / "second"), str(scan))
    assert error == ""
    # explicit entries first (trimmed, empty ones skipped), then the instances found without being told (a folder
    # without instance.env is not offered, and one already named is not repeated)
    assert arguments == ["--seed-models", "/mnt/e/Models A", "--seed-models", "/mnt/d/Old Vocalis",
                         "--seed-models", _mnt(scan / "second"), "--seed-models", _mnt(scan / "instance")]


@needs_powershell
def test_nothing_is_offered_when_there_are_no_entries_and_no_instances(tmp_path):
    assert _seed_arguments(tmp_path, "", str(tmp_path / "VocalisDocker that does not exist")) == ([], "")
    assert _seed_arguments(tmp_path, " ; ;", "") == ([], "")


@needs_powershell
@pytest.mark.parametrize("entry, message", [
    (r"\\server\share\models", "network (UNC) path"),
    ("//server/share/models", "network (UNC) path"),
    (r"E:\models;relative\path", "not a full path that starts with a drive letter"),  # what a ';' in a name leaves behind
    (r"models", "not a full path that starts with a drive letter"),
    (r"E:", "not a full path that starts with a drive letter"),
])
def test_unc_and_non_drive_seed_entries_are_refused(tmp_path, entry, message):
    arguments, error = _seed_arguments(tmp_path, entry, "")
    assert message in error and arguments == [], (arguments, error)


@needs_powershell
def test_an_untranslatable_explicit_folder_is_refused_but_a_found_instance_is_only_skipped(tmp_path):
    scan = tmp_path / "VocalisDocker"
    (scan / "instance").mkdir(parents=True)
    (scan / "instance" / "instance.env").write_text("INSTANCE_ID=vi-x\n", encoding="ascii")
    arguments, error = _seed_arguments(tmp_path, r"E:\Models", str(scan), wsl="fails")
    assert "Could not translate the model folder 'E:\\Models'" in error and arguments == []
    arguments, error = _seed_arguments(tmp_path, "", str(scan), wsl="fails")
    assert error == "" and arguments == []


def _check_ports(*arguments):
    # -CheckPorts needs no Docker or WSL, so it runs with the ordinary PATH.
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SETUP_PS1), "-CheckPorts", *arguments],
        capture_output=True, text=True, timeout=60, input="")


def _free_pair():
    # Two free ports whose +2 neighbors are also free, so the suggestion for a busy first port is predictable.
    # Scans a fixed range below Windows' dynamic port range, so the answer does not depend on random picks.
    # October 11, 2026: the range is this xdist worker's own slice (400 ports per worker). With one shared range every worker
    # found the same pair, and a test holding it made another worker's check fail ("FAIL Vocalis port: port 30000 on
    # 127.0.0.1 is already in use on Windows (socket error 10048)") in test_the_tmp_runs_of_check_only_and_check_ports_...
    worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
    slot = int(worker[2:]) if worker.startswith("gw") and worker[2:].isdigit() else 0
    low = 30000 + 400 * (slot % 40)
    for first in range(low, low + 400, 4):
        try:
            for port in (first, first + 1, first + 2, first + 3):
                with socket.socket() as check:
                    check.bind(("127.0.0.1", port))
        except OSError:
            continue
        return first, first + 1
    raise AssertionError(f"no free run of four ports found between {low} and {low + 400}")


@needs_powershell
def test_check_ports_reports_free_ports_and_changes_nothing():
    vocalis, taproom = _free_pair()
    result = _check_ports("-VocalisPort", str(vocalis), "-TaproomPort", str(taproom))
    assert result.returncode == 0, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    assert lines[-1] == f"Ports: OK ({vocalis} and {taproom} can be bound on 127.0.0.1 on Windows).", lines
    assert any(line.startswith("OK   Vocalis port:") for line in lines) and any(line.startswith("OK   Taproom port:") for line in lines)
    # the test listeners were released: a second look still finds both free
    assert _check_ports("-VocalisPort", str(vocalis), "-TaproomPort", str(taproom)).returncode == 0


@needs_powershell
def test_check_ports_fails_a_busy_port_and_suggests_the_next_pair():
    vocalis, taproom = _free_pair()
    with socket.socket() as holder:
        holder.bind(("127.0.0.1", vocalis))
        holder.listen()
        result = _check_ports("-VocalisPort", str(vocalis), "-TaproomPort", str(taproom))
    assert result.returncode == 1, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    assert any(line.startswith(f"FAIL Vocalis port: port {vocalis} on 127.0.0.1 is already in use on Windows (socket error 10048)") for line in lines), lines
    assert any(line.startswith("OK   Taproom port:") for line in lines), lines
    assert lines[-1] == f"Suggested ports: {vocalis + 2} {taproom + 2}", lines


@needs_powershell
def test_check_ports_without_ports_tests_the_defaults_and_refuses_bad_combinations():
    result = _check_ports()
    assert result.returncode in (0, 1), result.stdout + result.stderr
    assert "Vocalis port:" in result.stdout and "Taproom port:" in result.stdout
    same = _check_ports("-VocalisPort", "20001", "-TaproomPort", "20001")
    assert same.returncode == 1 and "The Vocalis and Taproom ports must differ." in same.stdout
    both = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SETUP_PS1), "-CheckPorts", "-CheckOnly"],
                          capture_output=True, text=True, timeout=60, input="")
    assert both.returncode == 1 and "cannot be combined" in both.stdout


# ---- the shared helper, windows-compose.ps1 (October 10, 2026, design amendment 15) ---------------------------------

def test_windows_compose_helper_is_ascii_lf_and_uses_no_environment_assignment():
    raw = COMPOSE_HELPER.read_bytes()
    raw.decode("ascii")  # Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page
    assert b"\r" not in raw
    # The child environment is built explicitly (ProcessStartInfo); no script ever sets a variable of its own.
    for path in (COMPOSE_HELPER, SETUP_PS1, PACKAGING / "windows" / "vocalis-control.ps1"):
        text = path.read_text(encoding="ascii")
        code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
        assert not re.search(r"\$env:\w+\s*=", code, re.IGNORECASE), path.name
        assert not re.search(r"SetEnvironmentVariable|Set-Item\s+env:|Set-Content\s+env:|\[Environment\]::", code, re.IGNORECASE), path.name
    assert "EnvironmentVariables.Clear()" in raw.decode("ascii")


def test_setup_ps1_dot_sources_the_helper_and_no_longer_carries_its_own_copy_of_the_shared_functions():
    text = SETUP_PS1.read_text(encoding="ascii")
    assert ". $WindowsComposeHelper" in text and "'windows-compose.ps1'" in text
    for name in ("Invoke-Bounded", "ConvertTo-ArgumentString", "Read-InstanceEnv"):
        assert f"function {name}" not in text, name
        assert f"function {name}" in COMPOSE_HELPER.read_text(encoding="ascii"), name
    # the helper's default limit is setup.ps1's per-check limit
    helper = COMPOSE_HELPER.read_text(encoding="ascii")
    default = int(re.search(r"\[int\]\$TimeoutSeconds = (\d+)", helper).group(1))
    assert default == int(re.search(r"\$CheckTimeoutSeconds = (\d+)", text).group(1)) == 60


def test_setup_ps1_always_defers_the_start_and_starts_the_services_only_after_setup_sh_succeeds():
    text = SETUP_PS1.read_text(encoding="ascii")
    assert "$NativeArguments += '--defer-start'" in text
    # --defer-start is a real option of setup.sh
    assert "--defer-start) DEFER_START=1" in SETUP_SH.read_text(encoding="utf-8")
    # the start sits behind `$ExitCode -eq 0`, directly after the call to setup.sh, before the browser launch
    call = text.index("& wsl.exe --exec bash $LinuxSetup @NativeArguments")
    guard = text.index("if ($ExitCode -eq 0) {\n            $ExitCode = Start-InstanceAfterSetup -InstanceFolder $Root\n        }", call)
    assert call < guard < text.index("if ($NoBrowser)", guard)
    assert text.count("Start-InstanceAfterSetup -InstanceFolder") == 1


@needs_powershell
def test_setup_ps1_without_the_helper_beside_it_stops_with_a_clear_message(tmp_path):
    shutil.copy(SETUP_PS1, tmp_path / "setup.ps1")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp_path / "setup.ps1"), "-CheckPorts"],
                            capture_output=True, text=True, timeout=60, input="")
    assert result.returncode == 1 and "windows-compose.ps1 must be in the same folder as setup.ps1" in result.stdout, result.stdout + result.stderr


@needs_powershell
def test_the_tmp_runs_of_check_only_and_check_ports_work_with_the_helper_extracted_beside_setup_ps1(tmp_path):
    # The installer extracts setup.ps1 and windows-compose.ps1 to {tmp} and runs -CheckOnly and -CheckPorts from there.
    shutil.copy(SETUP_PS1, tmp_path / "setup.ps1")
    shutil.copy(COMPOSE_HELPER, tmp_path / "windows-compose.ps1")
    env = os.environ.copy()
    env["PATH"] = str(Path(POWERSHELL).parent)
    check = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp_path / "setup.ps1"), "-CheckOnly"],
                           capture_output=True, text=True, timeout=60, env=env, input="")
    assert check.returncode == 10 and check.stdout.splitlines()[-1] == "Prerequisites: 2 check(s) failed; exit code 10 (docker.exe).", check.stdout + check.stderr
    vocalis, taproom = _free_pair()
    ports = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp_path / "setup.ps1"),
                            "-CheckPorts", "-VocalisPort", str(vocalis), "-TaproomPort", str(taproom)],
                           capture_output=True, text=True, timeout=60, input="")
    assert ports.returncode == 0 and ports.stdout.splitlines()[-1].startswith("Ports: OK"), ports.stdout + ports.stderr


# ---- fake docker.exe and wsl.exe ----------------------------------------------------------------------------------
# One small console program, installed twice under the two names. It records "<tool>\t<arg>\t<arg>..." per call in
# FAKE_LOG (plus "ENV\t<verb>\t<name>\t<value or (unset)>" for each name in FAKE_DUMP_ENV on every compose call) and
# answers with scripted exit codes. It knows just enough of docker (info, compose version, compose run/up/stop/down)
# and wsl (-l -v, --exec bash, --exec wslpath) for setup.ps1's checks and flow.

FAKE_TOOL_SOURCE = r"""
using System;
using System.IO;
using System.Text;

public static class FakeTool {
    static string Tool;

    static void Log(string line) {
        string log = Environment.GetEnvironmentVariable("FAKE_LOG");
        if (!string.IsNullOrEmpty(log)) File.AppendAllText(log, line + "\n");
    }

    static int ExitFrom(string name, int fallback) {
        string v = Environment.GetEnvironmentVariable(name);
        int n;
        return (v != null && int.TryParse(v, out n)) ? n : fallback;
    }

    static void WriteUnicode(string text) {
        Stream o = Console.OpenStandardOutput();
        byte[] b = Encoding.Unicode.GetBytes(text);
        o.Write(b, 0, b.Length);
        o.Flush();
    }

    public static int Main(string[] args) {
        Tool = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        Log(Tool + "\t" + string.Join("\t", args));
        if (Tool == "docker") return Docker(args);
        if (Tool == "wsl") return Wsl(args);
        if (Tool == "taskkill") {
            // What the real one prints when a process of the tree is already gone; it kills nothing.
            Console.Error.WriteLine("ERROR: The process with PID 1 (child process of PID 2) could not be terminated.");
            return 128;
        }
        return 99;
    }

    static int Docker(string[] args) {
        if (args.Length == 0) return 64;
        if (args[0] == "info") {
            if (args.Length > 1) Console.Out.WriteLine("{\"nvidia\":{}}");
            return ExitFrom("FAKE_INFO_EXIT", 0);
        }
        if (args[0] != "compose") return 64;
        if (args.Length > 1 && args[1] == "version") { Console.Out.WriteLine("Docker Compose version v2.fake"); return 0; }
        string verb = "";
        foreach (string a in args) {
            if (a == "run" || a == "up" || a == "stop" || a == "down") { verb = a; break; }
        }
        string dump = Environment.GetEnvironmentVariable("FAKE_DUMP_ENV");
        if (!string.IsNullOrEmpty(dump)) {
            foreach (string name in dump.Split(',')) {
                string value = Environment.GetEnvironmentVariable(name);
                Log("ENV\t" + verb + "\t" + name + "\t" + (value == null ? "(unset)" : value));
            }
        }
        int code = 0;
        if (verb == "run") {
            string service = "";
            int at = Array.IndexOf(args, "find");
            if (at >= 0 && at + 1 < args.Length) service = args[at + 1];
            code = ExitFrom("FAKE_RUN_EXIT_" + service, ExitFrom("FAKE_RUN_EXIT", 0));
        } else if (verb == "up") code = ExitFrom("FAKE_UP_EXIT", 0);
        else if (verb == "stop") code = ExitFrom("FAKE_STOP_EXIT", 0);
        else if (verb == "down") code = ExitFrom("FAKE_DOWN_EXIT", 0);
        Console.Error.WriteLine("fake compose " + verb + " exiting " + code);
        return code;
    }

    static int Wsl(string[] args) {
        if (args.Length > 0 && args[0] == "-l") {
            WriteUnicode("  NAME              STATE           VERSION\r\n* Ubuntu            Running         2\r\n  docker-desktop    Running         2\r\n");
            return 0;
        }
        if (args.Length < 2 || args[0] != "--exec") return 64;
        if (args[1] == "wslpath") {
            string p = args[args.Length - 1];
            if (p.Length >= 3 && p[1] == ':') p = "/mnt/" + char.ToLowerInvariant(p[0]) + "/" + p.Substring(3).Replace('\\', '/');
            Console.Out.WriteLine(p);
            return 0;
        }
        if (args[1] == "bash") {
            if (args.Length > 3 && args[2] == "-lc") {
                if (args[3].StartsWith("docker --version")) Console.Out.WriteLine("Docker version fake");
                else if (args[3].StartsWith("docker compose version")) Console.Out.WriteLine("Docker Compose version v2.fake");
                return 0;
            }
            Console.Out.WriteLine("fake setup.sh");
            return ExitFrom("FAKE_SETUP_EXIT", 0);
        }
        return 64;
    }
}
"""


@pytest.fixture(scope="session")
def fake_tools(tmp_path_factory):
    """Path of the compiled fake tool (copied by each test to docker.exe and wsl.exe). Compiled once per session."""
    if POWERSHELL is None:
        pytest.skip("Windows PowerShell 5.1 is required")
    work = tmp_path_factory.mktemp("fake-tool")
    source = work / "fake-tool.cs"
    source.write_text(FAKE_TOOL_SOURCE, encoding="ascii")
    maker = work / "make-fake-tool.ps1"
    maker.write_text(
        "param([string]$Source, [string]$Out)\n"
        "Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $Source) -OutputAssembly $Out -OutputType ConsoleApplication\n",
        encoding="ascii")
    exe = work / "fake-tool.exe"
    result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(maker), "-Source", str(source), "-Out", str(exe)],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0 and exe.is_file(), result.stdout + result.stderr
    return exe


def make_fake_bin(tmp_path, fake_tools, names=("docker.exe", "wsl.exe")):
    """A folder holding the fake tool under the given names; the only folders on the test's PATH are it and PowerShell's."""
    bin_dir = tmp_path / "fakebin"
    bin_dir.mkdir(exist_ok=True)
    for name in names:
        # Copy once: the content never changes, and rewriting an exe a still-running fake (or a scanner) holds open raised
        # PermissionError in test_control_reports_1_for_a_failed_ownership_pass_... and test_start_runs_the_ownership_pass_...
        if not (bin_dir / name).exists():
            shutil.copy(fake_tools, bin_dir / name)
    return bin_dir


def fake_env(tmp_path, bin_dir, **extra):
    env = os.environ.copy()
    for name in [name for name in env if name.upper().startswith(("FAKE_", "COMPOSE_"))]:
        del env[name]
    env["PATH"] = str(bin_dir) + os.pathsep + str(Path(POWERSHELL).parent)
    env["LOCALAPPDATA"] = str(tmp_path / "localappdata")  # setup.ps1 scans %LOCALAPPDATA%\VocalisDocker for instances
    env["FAKE_LOG"] = str(tmp_path / "fake.log")
    env.update({key: str(value) for key, value in extra.items()})
    return env


def fake_calls(tmp_path):
    """([tool call argument lists], [(verb, name, value)] environment dumps), in the order they happened."""
    log = tmp_path / "fake.log"
    calls, dumps = [], []
    for line in (log.read_text(encoding="utf-8").splitlines() if log.exists() else []):
        parts = line.split("\t")
        if parts[0] == "ENV":
            dumps.append((parts[1], parts[2], parts[3]))
        else:
            calls.append(parts)
    return calls, dumps


def compose_calls(calls):
    """The docker compose calls that carry a project name (not `compose version`)."""
    return [call for call in calls if call[:2] == ["docker", "compose"] and "--project-name" in call]


def compose_verb(call):
    """What follows the second -f <file> of a compose call."""
    second = len(call) - 1 - call[::-1].index("-f")
    return call[second + 2:]


def write_instance(tmp_path, *, name="inst root", root_line=None, uids=("1000", "1000", "1001", "1002"), extra_lines=()):
    """An instance folder with a plausible instance.env whose INSTANCE_ROOT is this folder as WSL spells it.
    `extra_lines` are appended (for example the optional VOCALIS_DATA_PATH / VOCALIS_CACHE_PATH keys)."""
    root = (tmp_path / name).resolve()
    root.mkdir(parents=True, exist_ok=True)
    recorded = root_line if root_line is not None else f"INSTANCE_ROOT='{_mnt(root)}'"
    (root / "instance.env").write_text("\n".join([
        "INSTANCE_ID=vi-50c78647a395", "GPU_VARIANT=cuda", recorded, "HOST_BIND=127.0.0.1",
        "VOCALIS_PORT=18770", "TAPROOM_PORT=18771",
        "VOCALIS_PUBLIC_URL=http://127.0.0.1:18770", "TAPROOM_PUBLIC_URL=http://127.0.0.1:18771",
        f"VOCALIS_UID={uids[0]}", f"VOCALIS_GID={uids[1]}", f"TAPROOM_UID={uids[2]}", f"TAPROOM_GID={uids[3]}", "GPU_GID=0",
        "VOCALIS_IMAGE=vocalis-main-app-cuda@sha256:" + "1" * 64, "TAPROOM_IMAGE=vocalis-g1-taproom@sha256:" + "2" * 64, *extra_lines, ""]),
        encoding="utf-8")
    return root


VOCALIS_MOUNTS = ["/data/vocalis", "/cache/vocalis", "/models/vocalis", "/work/vocalis", "/logs"]
# Design section 11, item 3 (October 10, 2026): Taproom's configuration folder is bound at /etc/taproom and its data
# folder at /data/taproom/data (the ownership pass covers exactly these plus the logs).
TAPROOM_MOUNTS = ["/etc/taproom", "/data/taproom/data", "/logs"]


def ownership_verb(service, mounts, uid, gid, prune=None):
    """The find call of one ownership pass. `prune` is a nested mount the first walk must not enter (Taproom's data folder is
    also visible below /etc/taproom, design section 11, review item 8): ( -path <prune> -prune ) -o ( ( differs ) -exec ... )."""
    head = ["run", "--rm", "--no-deps", "--pull", "never", "--user", "0", "--entrypoint", "find", service] + mounts + ["-ignore_readdir_race"]
    differs = ["!", "-user", uid, "-o", "!", "-group", gid]
    chown = ["-exec", "chown", "-h", f"{uid}:{gid}", "{}", "+"]
    if prune:
        return head + ["(", "-path", prune, "-prune", ")", "-o", "(", "(", *differs, ")", *chown, ")"]
    return head + ["(", *differs, ")", *chown]


TAPROOM_PRUNE = "/etc/taproom/data"


def run_setup(tmp_path, fake_tools, *args, env_extra=None, input=""):
    bin_dir = make_fake_bin(tmp_path, fake_tools)
    env = fake_env(tmp_path, bin_dir, **(env_extra or {}))
    result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SETUP_PS1), *args],
                            capture_output=True, text=True, timeout=180, env=env, input=input)
    return result, fake_calls(tmp_path)


def test_the_ownership_targets_are_exactly_the_bind_mounts_of_compose_yaml():
    compose = (PACKAGING / "compose.yaml").read_text(encoding="utf-8")
    services = {}
    for block in re.split(r"^  (?=\w+:\n    image:)", compose, flags=re.MULTILINE)[1:]:
        services[block.split(":", 1)[0]] = re.findall(r"^        target: (\S+)$", block, re.MULTILINE)
    # The two Vocalis store targets are ${VOCALIS_DATA_PATH:-/data/vocalis} and ${VOCALIS_CACHE_PATH:-/cache/vocalis}
    # (design section 11, item 4); the helper uses the same defaults when instance.env has no such key.
    services = {name: [re.sub(r"^\$\{\w+:-([^}]+)\}$", r"\1", target) for target in targets] for name, targets in services.items()}
    assert services == {"vocalis": VOCALIS_MOUNTS, "taproom": TAPROOM_MOUNTS}, services


@needs_powershell
def test_after_a_successful_setup_the_ownership_pass_and_up_run_from_windows_in_that_order(tmp_path, fake_tools):
    root = write_instance(tmp_path)
    result, (calls, dumps) = run_setup(tmp_path, fake_tools, "-Root", str(root), "-NoBrowser")
    assert result.returncode == 0, result.stdout + result.stderr
    # setup.sh ran inside WSL with --defer-start, once
    setup_calls = [call for call in calls if call[:3] == ["wsl", "--exec", "bash"] and call[3].endswith("setup.sh")]
    assert len(setup_calls) == 1 and "--defer-start" in setup_calls[0] and setup_calls[0][setup_calls[0].index("--root") + 1] == _mnt(root)
    compose = compose_calls(calls)
    project = "vocalis-vi-50c78647a395"
    assert [compose_verb(call) for call in compose] == [
        ownership_verb("vocalis", VOCALIS_MOUNTS, "1000", "1000"),
        ownership_verb("taproom", TAPROOM_MOUNTS, "1001", "1002", TAPROOM_PRUNE),
        ["up", "-d", "--no-build", "--pull", "never"]]
    for call in compose:
        assert call[:6] == ["docker", "compose", "--project-name", project, "--env-file", str(root / "instance.env")], call
        assert call[6:10] == ["-f", str(PACKAGING / "compose.yaml"), "-f", str(PACKAGING / "compose.cuda.yaml")], call
    # nothing before the start used the compose project from WSL: the only docker.exe calls are the checks and the three above
    assert [call[1:3] for call in calls if call[0] == "docker" and call not in compose] == [["info"], ["compose", "version"]]
    assert "Ownership pass for vocalis" in result.stdout and "Ownership pass for taproom" in result.stdout
    assert "The Vocalis and Taproom services are started." in result.stdout
    # the services were started after setup.sh, never before it
    first_setup = next(index for index, call in enumerate(calls) if call[:3] == ["wsl", "--exec", "bash"] and call[3].endswith("setup.sh"))
    assert first_setup < calls.index(compose[0])


@needs_powershell
def test_the_child_environment_is_scrubbed_and_the_root_is_spelled_as_a_windows_path(tmp_path, fake_tools):
    root = write_instance(tmp_path)
    stray = {"VOCALIS_PORT": "1111", "vocalis_image": "stray@sha256:" + "9" * 64, "COMPOSE_PROJECT_NAME": "stray",
             "compose_file": "stray.yaml", "INSTANCE_ROOT": "/stray", "TAPROOM_UID": "7", "KEEP_ME": "kept"}
    names = ",".join(["VOCALIS_PORT", "VOCALIS_IMAGE", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "INSTANCE_ROOT", "TAPROOM_UID", "KEEP_ME", "FAKE_LOG"])
    result, (calls, dumps) = run_setup(tmp_path, fake_tools, "-Root", str(root), "-NoBrowser",
                                       env_extra={**stray, "FAKE_DUMP_ENV": names})
    assert result.returncode == 0, result.stdout + result.stderr
    expected_root = root.as_posix()
    expected_root = expected_root[0].upper() + expected_root[1:]
    by_verb = {}
    for verb, name, value in dumps:
        by_verb.setdefault(verb, []).append((name, value))
    assert list(by_verb) == ["run", "up"] and len(by_verb["run"]) == 2 * len(names.split(","))
    for verb, entries in by_verb.items():
        seen = dict(entries)
        # every key instance.env defines and every COMPOSE_* key is gone (whatever its case), nothing else of ours is
        for name in ("VOCALIS_PORT", "VOCALIS_IMAGE", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "TAPROOM_UID"):
            assert seen[name] == "(unset)", (verb, name, seen[name])
        assert seen["INSTANCE_ROOT"] == expected_root, (verb, seen["INSTANCE_ROOT"])
        assert seen["KEEP_ME"] == "kept" and seen["FAKE_LOG"] == str(tmp_path / "fake.log")


@needs_powershell
def test_setup_sh_failing_runs_neither_the_ownership_pass_nor_up_and_keeps_its_exit_code(tmp_path, fake_tools):
    root = write_instance(tmp_path)
    result, (calls, dumps) = run_setup(tmp_path, fake_tools, "-Root", str(root), "-NoBrowser", env_extra={"FAKE_SETUP_EXIT": 7})
    assert result.returncode == 7, result.stdout + result.stderr
    assert compose_calls(calls) == [] and dumps == []
    assert any(call[:3] == ["wsl", "--exec", "bash"] and call[3].endswith("setup.sh") for call in calls)
    assert "Starting the services from Windows" not in result.stdout


@needs_powershell
def test_a_failed_ownership_pass_is_exit_19_with_its_output_and_up_never_runs(tmp_path, fake_tools):
    root = write_instance(tmp_path)
    result, (calls, _) = run_setup(tmp_path, fake_tools, "-Root", str(root), "-NoBrowser", env_extra={"FAKE_RUN_EXIT_taproom": 2})
    assert result.returncode == 19, result.stdout + result.stderr
    verbs = [compose_verb(call)[0] for call in compose_calls(calls)]
    assert verbs == ["run", "run", "run"], verbs  # vocalis passed, taproom failed twice (one more walk), no up
    assert "The ownership pass for taproom failed with exit code 2" in result.stdout
    assert "fake compose run exiting 2" in result.stdout  # the Compose output is printed
    assert "Start Vocalis" in result.stdout and "could not be started" in result.stdout


@needs_powershell
def test_a_failed_up_is_exit_19_and_the_browser_step_is_not_reached(tmp_path, fake_tools):
    root = write_instance(tmp_path)
    result, (calls, _) = run_setup(tmp_path, fake_tools, "-Root", str(root), "-NoBrowser", env_extra={"FAKE_UP_EXIT": 1})
    assert result.returncode == 19, result.stdout + result.stderr
    assert [compose_verb(call)[0] for call in compose_calls(calls)] == ["run", "run", "up"]
    assert "docker compose up failed with exit code 1" in result.stdout and "fake compose up exiting 1" in result.stdout
    # the browser step (which says "Browser launch skipped" under -NoBrowser) is reached only after a successful start
    assert "Browser launch skipped" not in result.stdout


@needs_powershell
def test_a_failed_start_with_pause_on_failure_waits_for_enter_and_names_the_retry(tmp_path, fake_tools):
    root = write_instance(tmp_path)
    result, _ = run_setup(tmp_path, fake_tools, "-Root", str(root), "-NoBrowser", "-PauseOnFailure",
                          env_extra={"FAKE_UP_EXIT": 1}, input="\n")
    assert result.returncode == 19, result.stdout + result.stderr
    assert "Exit code 19. Press Enter to close this window." in result.stdout
    assert "Setup finished, but the services could not be started. Start Vocalis (Start menu)" in result.stdout


@needs_powershell
@pytest.mark.parametrize("root_line", [
    "INSTANCE_ROOT='/srv/vocalis/instance'",       # not on a Windows drive at all
    "INSTANCE_ROOT='/mnt/wsl/instance'",           # another automount-style root
    "INSTANCE_ROOT='/mnt/z/somewhere/else'",       # a drive path, but not this folder
])
def test_an_unusable_root_is_refused_before_any_docker_call_with_exit_19(tmp_path, fake_tools, root_line):
    root = write_instance(tmp_path, root_line=root_line)
    result, (calls, _) = run_setup(tmp_path, fake_tools, "-Root", str(root), "-NoBrowser")
    assert result.returncode == 19, result.stdout + result.stderr
    assert compose_calls(calls) == []
    assert "Cannot start instance" in result.stdout
    assert "could not be started" in result.stdout


@needs_powershell
def test_update_runs_setup_sh_deferred_and_then_the_same_start(tmp_path, fake_tools):
    root = write_instance(tmp_path)
    new_vocalis = "vocalis-main-app-cuda@sha256:" + "3" * 64
    new_taproom = "vocalis-g1-taproom@sha256:" + "4" * 64
    result, (calls, _) = run_setup(tmp_path, fake_tools, "-Root", str(root), "-Update", "-VocalisImage", new_vocalis,
                                   "-TaproomImage", new_taproom, "-NoBrowser")
    assert result.returncode == 0, result.stdout + result.stderr
    setup_call = next(call for call in calls if call[:3] == ["wsl", "--exec", "bash"] and call[3].endswith("setup.sh"))
    assert "--defer-start" in setup_call and "--update" in setup_call
    assert setup_call[setup_call.index("--vocalis-image") + 1] == new_vocalis
    assert [compose_verb(call)[0] for call in compose_calls(calls)] == ["run", "run", "up"]


@needs_powershell
def test_a_timed_out_run_returns_timed_out_even_when_taskkill_writes_to_stderr(tmp_path, fake_tools):
    # Windows PowerShell 5.1 turns a redirected native stderr line into a terminating error under
    # $ErrorActionPreference 'Stop', which setup.ps1 and the control script both set. A taskkill that reports a
    # process of the tree already gone must not throw out of Invoke-Bounded (it would turn a timed-out ownership pass
    # or `up` into exit 1 with taskkill's text instead of exit 19 with the timeout). The fake taskkill.exe on PATH
    # writes that line to stderr and kills nothing, so the child (one line, then a 3 s sleep) ends by itself.
    bin_dir = make_fake_bin(tmp_path, fake_tools, ("taskkill.exe",))
    env = fake_env(tmp_path, bin_dir)
    driver = tmp_path / "bounded.ps1"
    driver.write_text(
        "$ErrorActionPreference = 'Stop'\n"
        f". '{COMPOSE_HELPER}'\n"
        f"$r = Invoke-Bounded -FileName '{POWERSHELL}' -Arguments @('-NoProfile', '-Command', 'Write-Output before-the-stop; Start-Sleep -Seconds 3') -TimeoutSeconds 1\n"
        "'Output=' + $r.Output\n"
        "'TimedOut=' + $r.TimedOut\n",
        encoding="ascii")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(driver)],
                            capture_output=True, text=True, timeout=60, env=env, input="")
    assert result.returncode == 0 and result.stdout.strip().splitlines()[-1] == "TimedOut=True", result.stdout + result.stderr
    # what the program printed before the limit is kept, so a timed-out step is reported with its output
    assert "Output=before-the-stop" in result.stdout, result.stdout
    calls, _ = fake_calls(tmp_path)
    assert [call[0] for call in calls] == ["taskkill"]  # the fake, not the real one, was asked
