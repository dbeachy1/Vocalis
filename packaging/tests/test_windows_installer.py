"""Contract tests for the Windows installer in packaging/windows (design section 5, "Windows installer").

Pure-text checks (the .iss file list, version defaults, ASCII/LF rules, the no-push rule, the icon) run
everywhere. The checks that execute PowerShell functions, extracted from the scripts with the PowerShell
parser so nothing else in a script runs, need Windows PowerShell 5.1 and are skipped without it. Nothing here
runs the installer or Docker; the build itself (restore, artifacts) is proven by running build-installer.ps1.
One check does run the pinned Inno Setup compiler (restored by `dotnet restore packaging/windows/Vocalis.InstallerBuild.csproj
--locked-mode`; it skips only when that is not restored): it compiles vocalis.iss into a temporary folder and requires zero
warnings. The wizard's pictures (October 11, 2026) are checked against what make_icon.py draws.
"""
from pathlib import Path
import base64
import importlib.util
import json
import os
import re
import shutil
import struct
import subprocess

import pytest

# The fake docker.exe / wsl.exe programs and the helpers that drive them live in test_setup_ps1.py (they are shared
# with the setup.ps1 end-to-end tests); fake_tools is a fixture, imported so pytest finds it here too.
from test_setup_ps1 import (TAPROOM_MOUNTS, TAPROOM_PRUNE, VOCALIS_MOUNTS, _mnt, compose_calls, compose_verb, fake_calls, fake_env,  # noqa: F401
                            fake_tools, make_fake_bin, ownership_verb, write_instance)


PACKAGING = Path(__file__).resolve().parents[1]
REPO = PACKAGING.parent
WINDOWS = PACKAGING / "windows"
ISS = WINDOWS / "vocalis.iss"
BUILD_PS1 = WINDOWS / "build-installer.ps1"
CONTROL_PS1 = WINDOWS / "vocalis-control.ps1"
SETUP_PS1 = PACKAGING / "setup.ps1"
COMPOSE_HELPER = PACKAGING / "windows-compose.ps1"
SIGNING_PS1 = WINDOWS / "Invoke-WindowsArtifactSigning.ps1"
SETUP_SH = PACKAGING / "setup.sh"
ICON = WINDOWS / "vocalis.ico"
POWERSHELL = shutil.which("powershell.exe") if os.name == "nt" else None
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="Windows PowerShell 5.1 is required")

DIGEST = "a" * 64

# The wizard's own pictures (October 11, 2026), written by make_icon.py and named by BOTH .iss files:
# the sizes are those of Inno Setup 6.7.3's image areas at 100%, 125%, 150%, 175%, 200%, 225% and 250% display scaling
# (the WizardSmallImageFile and WizardImageFile help topics), so Setup always finds a file at exactly the size it needs.
WIZARD_SMALL = [f"vocalis-wizard-small-{size}.png" for size in (58, 77, 97, 116, 124, 143, 159)]
WIZARD_LARGE = [f"vocalis-wizard-large-{width}x{height}.png"
                for width, height in ((202, 386), (269, 515), (336, 643), (403, 772), (430, 824), (498, 953), (534, 1022))]
WIZARD_PICTURES = WIZARD_SMALL + WIZARD_LARGE
ISCC = WINDOWS / "obj" / "packages" / "tools.innosetup" / "6.7.3" / "tools" / "ISCC.exe"
needs_compiler = pytest.mark.skipif(
    os.name != "nt" or not ISCC.is_file(), reason="Windows only (the Linux test container sees ISCC.exe through the mount but cannot run it); or ""the pinned Inno Setup compiler is not restored (dotnet restore packaging/windows/Vocalis.InstallerBuild.csproj --locked-mode)")


# ---- helpers ----------------------------------------------------------------------------------------------

def _wizard_pictures_named(iss_text):
    """(WizardSmallImageFile names, WizardImageFile names) of an .iss, each directive a comma-separated list."""
    small = re.search(r"^WizardSmallImageFile=(.+)$", iss_text, re.MULTILINE)
    large = re.search(r"^WizardImageFile=(.+)$", iss_text, re.MULTILINE)
    assert small and large, "the .iss must name both wizard pictures"
    return [name.strip() for name in small.group(1).split(",")], [name.strip() for name in large.group(1).split(",")]


def _run_ps(tmp_path, script, body, *, functions=(), variables=(), data=None, timeout=120):
    """Loads the named functions and top-level variable assignments of `script` (PowerShell parser, nothing else
    runs), then runs `body` (PowerShell text) with $Data set from `data`. Returns the JSON the body printed.
    `script` may be one path or several: each name is taken from the first script that defines it (the shared
    helper windows-compose.ps1 holds functions the other scripts used to carry; October 10, 2026)."""
    driver = tmp_path / "ps-driver.ps1"
    driver.write_text(
        "param([string]$Scripts, [string]$Names, [string]$Variables, [string]$BodyFile, [string]$DataFile)\n"
        "$asts = @()\n"
        "foreach ($s in ($Scripts -split '\\|' | Where-Object { $_ })) {\n"
        "  $e = $null; $t = $null\n"
        "  $asts += [System.Management.Automation.Language.Parser]::ParseFile($s, [ref]$t, [ref]$e)\n"
        "  if ($e.Count) { $e | ForEach-Object { Write-Error $_.Message }; exit 2 }\n"
        "}\n"
        "foreach ($n in ($Names -split ',' | Where-Object { $_ })) {\n"
        "  $fn = $null\n"
        "  foreach ($ast in $asts) {\n"
        "    $fn = $ast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)\n"
        "    if ($fn) { break }\n"
        "  }\n"
        "  if (-not $fn) { Write-Error \"function $n not found\"; exit 3 }\n"
        "  . ([scriptblock]::Create($fn.Extent.Text))\n"
        "}\n"
        "foreach ($v in ($Variables -split ',' | Where-Object { $_ })) {\n"
        "  $a = $null\n"
        "  foreach ($ast in $asts) {\n"
        "    $a = $ast.Find({ param($x) $x -is [System.Management.Automation.Language.AssignmentStatementAst] -and $x.Left.VariablePath.UserPath -eq $v }, $false)\n"
        "    if ($a) { break }\n"
        "  }\n"
        "  if (-not $a) { Write-Error \"variable $v not found\"; exit 3 }\n"
        "  . ([scriptblock]::Create($a.Extent.Text))\n"
        "}\n"
        "$Data = if ($DataFile) { Get-Content -Raw -LiteralPath $DataFile | ConvertFrom-Json } else { $null }\n"
        ". $BodyFile\n",
        encoding="ascii")
    body_file = tmp_path / "ps-body.ps1"
    body_file.write_text(body, encoding="ascii")
    data_file = tmp_path / "ps-data.json"
    data_file.write_text(json.dumps(data), encoding="ascii")
    scripts = "|".join(str(path) for path in (script if isinstance(script, (list, tuple)) else [script]))
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(driver), "-Scripts", scripts,
         "-Names", ",".join(functions), "-Variables", ",".join(variables), "-BodyFile", str(body_file),
         "-DataFile", str(data_file)],
        capture_output=True, text=True, timeout=timeout)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


def _files_section():
    """(source, flags, dest_dir, line) for every [Files] entry of the .iss."""
    entries = []
    section = None
    for line in ISS.read_text(encoding="utf-8").splitlines():
        header = re.match(r"^\s*\[(\w+)\]\s*$", line)
        if header:
            section = header.group(1)
            continue
        if section != "Files" or line.lstrip().startswith(";"):
            continue
        source = re.match(r'^\s*Source:\s*"([^"]+)"', line)
        if not source:
            continue
        flags = re.search(r"Flags:\s*([^;]+)", line)
        dest = re.search(r'DestDir:\s*"([^"]+)"', line)
        entries.append((source.group(1), (flags.group(1) if flags else "").split(), dest.group(1) if dest else None, line))
    return entries


# ---- the installed file list ---------------------------------------------------------------------------------

def test_iss_installs_exactly_the_designed_files():
    entries = _files_section()
    installed = [(source, dest) for source, flags, dest, _ in entries if "dontcopy" not in flags]
    assert sorted(source.replace("\\", "/") for source, _ in installed) == sorted([
        "../compose.yaml", "../compose.cuda.yaml", "../compose.rocm.yaml", "../setup.sh", "../setup.ps1",
        "../README.md", "../../LICENSE", "vocalis.ico", "vocalis-control.ps1", "../windows-compose.ps1"]), installed
    assert {dest for _, dest in installed} == {"{app}"}
    for source, _ in installed:
        assert (WINDOWS / source.replace("\\", "/")).is_file(), source
    # Extracted to {tmp} for the wizard-time checks only, never installed. windows-compose.ps1 (amendment 15) is
    # dot-sourced by both scripts, so it is extracted beside them wherever either runs from {tmp}.
    assert sorted(source.replace("\\", "/") for source, flags, _, _ in entries if "dontcopy" in flags) == [
        "../setup.ps1", "../windows-compose.ps1", "vocalis-control.ps1"]
    # amendment 3 replaced installer-images.json with installer-state.json, which [Code] writes after the copy
    text = ISS.read_text(encoding="utf-8")
    assert "installer-images.json" not in text
    assert "installer-state.json" in text
    # amendment 13: the repository LICENSE is the only licence file
    assert re.search(r"^LicenseFile=\.\.\\\.\.\\LICENSE$", text, re.MULTILINE)
    assert not re.search(r"THIRD", "\n".join(line for *_, line in entries), re.IGNORECASE)


def test_iss_setup_directives_follow_the_design():
    text = ISS.read_text(encoding="utf-8")
    for directive in ("PrivilegesRequired=lowest", r"DefaultDirName={localappdata}\Programs\Vocalis", "WizardStyle=modern",
                      "ArchitecturesAllowed=x64compatible", "ArchitecturesInstallIn64BitMode=x64compatible",
                      "AppVersion={#AppVersion}", "VersionInfoVersion={#VersionInfo}",
                      "OutputBaseFilename=Vocalis-Setup-{#AppVersion}-x64", "SetupIconFile=vocalis.ico",
                      r"UninstallDisplayIcon={app}\vocalis.ico"):
        assert re.search(rf"^{re.escape(directive)}$", text, re.MULTILINE), directive
    # section 5 lists the Welcome page first; Inno Setup 6.7 leaves it out unless it is turned on (October 11, 2026)
    assert re.search(r"^DisableWelcomePage=no$", text, re.MULTILINE)
    # amendment 12: one fixed, permanent AppId, used again for the uninstall key
    guids = set(re.findall(r'#define AppGuid "([0-9A-F-]{36})"', text))
    assert len(guids) == 1
    assert "AppId={{{#AppGuid}}" in text
    assert "Uninstall\\{{#AppGuid}}_is1" in text
    assert len(set(re.findall(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}", text))) == 1
    # the signing hook exists only in a signed (release) build: each directive sits inside the #if for the signed flag
    signed_if = '#if GetEnv("VOCALIS_INSTALLER_SIGNED_BUILD") == "1"'
    for directive in ("SignTool=azurecodesign", "SignedUninstaller=yes"):
        before = text[:text.index("\n" + directive)]
        assert before.rfind(signed_if) > before.rfind("#endif"), directive
    # the wizard's defaults equal setup.sh's
    sh = SETUP_SH.read_text(encoding="utf-8")
    assert re.search(r"DefaultVocalisPort = '18770'", text) and "VOCALIS_PORT=${VOCALIS_PORT_ARG:-18770}" in sh
    assert re.search(r"DefaultTaproomPort = '18771'", text) and "TAPROOM_PORT=${TAPROOM_PORT_ARG:-18771}" in sh
    assert re.search(r"GpuVariant = 'cuda'", text)
    # shortcuts: Vocalis and Taproom are .url files written by [Code]; the rest are [Icons]
    for name in ("Start Vocalis", "Stop Vocalis", "Repair setup"):
        assert f'Name: "{{group}}\\{name}"' in text, name
    assert "{group}\\Vocalis.url" in text and "{group}\\Taproom.url" in text
    # passwords never pass through the wizard: no input field is a password field
    assert not re.search(r"\.Add\([^)]*,\s*True\)", text)
    assert "-Action repair" in text and "-Action down" in text


def test_the_helper_is_extracted_beside_every_script_the_wizard_runs_from_tmp():
    # Amendment 15 (October 10, 2026): setup.ps1 and vocalis-control.ps1 dot-source windows-compose.ps1 from their own
    # folder, so it must be in {tmp} before -CheckOnly, -CheckPorts (setup.ps1) or compare-version (the control script).
    text = ISS.read_text(encoding="utf-8")
    assert text.count("ExtractTemporaryFile('windows-compose.ps1')") == 1  # once, inside EnsureComposeHelper
    helper = text[text.index("procedure EnsureComposeHelper"):text.index("// Runs a script from {tmp}")]
    assert "ComposeHelperExtracted" in helper and "ExtractTemporaryFile('windows-compose.ps1')" in helper
    compare = text[text.index("function InstalledVersionIsNewer"):text.index("function InitializeSetup")]
    assert compare.index("EnsureComposeHelper;") < compare.index("ExtractTemporaryFile('vocalis-control.ps1')")
    wizard = text[text.index("procedure InitializeWizard"):text.index("// Prerequisites (amendment 8")]
    assert wizard.index("EnsureComposeHelper;") < wizard.index("ExtractTemporaryFile('setup.ps1')")
    # every script RunHiddenScript or Exec starts from {tmp} is one of those two
    assert set(re.findall(r"RunHiddenScript\('([\w.-]+)'", text)) == {"setup.ps1"}
    assert text.count("{tmp}\\vocalis-control.ps1") == 1 and "{tmp}\\windows-compose.ps1" not in text  # nothing runs the helper itself
    assert "fifteen review amendments" in text


def test_the_state_file_the_installer_writes_is_the_one_the_control_script_reads():
    iss = ISS.read_text(encoding="utf-8")
    control = CONTROL_PS1.read_text(encoding="ascii")
    written = re.findall(r"'  \"(\w+)\": '", iss)
    required = re.search(r"foreach \(\$Name in ([^)]*?)\) \{\s+if \(\$null -eq \$State", control).group(1)
    read = re.findall(r"'(\w+)'", required)
    # seedModels (October 9, 2026) is written only when the previous data folder holds models, so the control script
    # must not require it: it reads it as an optional value.
    assert read == ["version", "root", "variant", "vocalisImage", "taproomImage", "vocalisPort", "taproomPort"]
    assert written == [*read, "seedModels"]
    assert "$State.seedModels" in control and "seedModels" not in required
    assert re.search(r"if SeedModelsFolder <> '' then\s+Json := Json \+ ',' \+ #13#10 \+ '  \"seedModels\": ' \+ JsonString\(SeedModelsFolder\)", iss)


# ---- model reuse across data folders (October 9, 2026) ---------------------------------------------------------

def _registry_lines():
    section, lines = None, []
    for line in ISS.read_text(encoding="utf-8").splitlines():
        header = re.match(r"^\s*\[(\w+)\]\s*$", line)
        if header:
            section = header.group(1)
        elif section == "Registry" and line.strip() and not line.lstrip().startswith(";"):
            lines.append(line)
    return lines


def test_the_uninstaller_keeps_the_remembered_data_folder_so_a_reinstall_can_offer_it():
    lines = _registry_lines()
    assert len(lines) == 1 and 'ValueName: "DataFolder"' in lines[0] and "{code:GetDataFolder}" in lines[0], lines
    assert "uninsdeletekey" not in "\n".join(lines) and "uninsdeletevalue" not in "\n".join(lines)
    text = ISS.read_text(encoding="utf-8")
    # the uninstall message promises exactly that
    assert "it will offer this folder again" in text


def test_the_data_folder_is_read_whether_or_not_vocalis_is_installed_and_offered_when_it_still_exists():
    text = ISS.read_text(encoding="utf-8")
    start = text.index("function InitializeSetup")
    body = text[start:text.index("// A click on one of the Finish page", start)]
    read = body.index("RegQueryStringValue(HKCU, InstallerKey, 'DataFolder', SavedRoot)")
    installed = body.index("RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', InstalledVersionText)")
    assert read < installed, "the remembered folder is read before, and independent of, the uninstall key"
    # ExistingInstance stays tied to the uninstall key: it is only assigned inside that branch
    assert body.count("ExistingInstance :=") == 1 and body.index("ExistingInstance :=") > installed
    assert "InstalledHere := True" in body
    # the data page offers it when Vocalis is installed, or when the folder still exists after an uninstall
    assert "if (SavedRoot <> '') and (InstalledHere or DirExists(SavedRoot)) then" in text
    assert "DataPage.Values[0] := SavedRoot" in text
    # choosing an existing folder adopts it through the "use existing instance" path, not through ExistingInstance
    assert "else if FileExists(Dir + '\\instance.env') then\n      UseExisting := True" in text


def test_the_previous_data_folder_is_recorded_as_seed_models_only_when_a_different_folder_is_chosen():
    text = ISS.read_text(encoding="utf-8")
    start = text.index("procedure PrepareChoices")
    body = text[start:text.index("// installer-state.json (amendment 3)", start)]
    # the previous folder (from the registry, read before the registry value is rewritten) must differ from the choice
    # and hold models\vocalis; a name with ';' cannot be passed in setup.ps1's ';'-separated -SeedModels
    assert "CompareText(RemoveBackslashUnlessRoot(SavedRoot), ChosenRoot) <> 0" in body
    assert "DirExists(SavedRoot + '\\models\\vocalis')" in body
    assert "Pos(';', SavedRoot) > 0" in body
    assert "SeedModelsFolder := SavedRoot" in body
    assert body.index("SeedModelsFolder := ''") < body.index("SeedModelsFolder := SavedRoot")


def test_setup_ps1_accepts_the_seed_models_value_the_repair_plan_passes():
    setup = (PACKAGING / "setup.ps1").read_text(encoding="ascii")
    assert "[string]$SeedModels" in setup
    control = CONTROL_PS1.read_text(encoding="ascii")
    assert "$Parameters.SeedModels = [string]$State.seedModels" in control


# ---- no publication ------------------------------------------------------------------------------------------

def test_nothing_in_the_windows_packaging_pushes_or_publishes_an_image():
    # Repository policy: never push, publish or upload Vocalis or Taproom images; the build only names references.
    forbidden = [
        r"docker\s+(image\s+)?push", r"docker\s+compose\s+push", r"docker\s+buildx[^\n]*--push", r"--push\b",
        r"docker\s+login", r"docker\s+(image\s+)?tag\b", r"skopeo\s+(copy|sync)", r"crane\s+(push|copy|append)",
        r"oras\s+push", r"gh\s+(release|api)", r"\bpodman\s+push", r"regctl\s+image\s+copy"]
    scanned = 0
    for path in WINDOWS.rglob("*"):
        # Build output and Python's byte-code cache (left by running packaging/windows/tests) are generated, not source.
        if not path.is_file() or any(part in ("obj", "bin", "__pycache__") for part in path.relative_to(WINDOWS).parts):
            continue
        if path.suffix in (".ico", ".png"):  # binary pictures (make_icon.py writes the icons and the wizard pictures)
            continue
        scanned += 1
        text = path.read_text(encoding="utf-8")
        for pattern in forbidden:
            assert not re.search(pattern, text, re.IGNORECASE), f"{path.name} matches {pattern}"
    assert scanned >= 8
    # the shared helper (October 10, 2026) runs docker.exe compose run/up/stop/down only; it never pushes either
    helper = COMPOSE_HELPER.read_text(encoding="utf-8")
    for pattern in forbidden:
        assert not re.search(pattern, helper, re.IGNORECASE), f"windows-compose.ps1 matches {pattern}"


# ---- text rules ----------------------------------------------------------------------------------------------

def test_windows_scripts_are_ascii_and_lf_and_the_ps1_files_parse_in_5_1():
    for path in [*sorted(WINDOWS.glob("*.ps1")), COMPOSE_HELPER]:
        raw = path.read_bytes()
        raw.decode("ascii")  # Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page
        assert b"\r" not in raw, path.name
    for path in (ISS, WINDOWS / "README.md", WINDOWS / "make_icon.py", WINDOWS / "Vocalis.InstallerBuild.csproj"):
        assert b"\r" not in path.read_bytes(), path.name
    # setup.sh and the compose files run inside Linux; the build refuses CR bytes in them, so they must have none.
    for name in ("setup.sh", "compose.yaml", "compose.cuda.yaml", "compose.rocm.yaml"):
        assert b"\r" not in (PACKAGING / name).read_bytes(), name


@needs_powershell
def test_windows_ps1_files_parse_in_windows_powershell():
    for path in [*sorted(WINDOWS.glob("*.ps1")), COMPOSE_HELPER]:
        command = ("$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile("
                   f"'{path}',[ref]$t,[ref]$e);if($e.Count){{$e|%{{$_.Message}};exit 1}}")
        result = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command], capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, path.name + result.stdout + result.stderr


# ---- build-installer.ps1 -------------------------------------------------------------------------------------

DIGEST_CASES = [
    (f"vocalis-main-app-cuda@sha256:{DIGEST}", True),
    (f"ghcr.io/example/vocalis:tag@sha256:{('0123456789abcdefABCDEF' * 3)[:64]}", True),
    (f"x@sha256:{DIGEST}\n", False),  # setup.sh's $ does not match before a trailing newline
    (f"x@sha256:{'a' * 63}", False),
    (f"x@sha256:{'a' * 65}", False),
    (f"x@sha256:{'g' * 64}", False),
    (f"x y@sha256:{DIGEST}", False),
    (f"@sha256:{DIGEST}", False),
    (f"x@sha1:{'a' * 40}", False),
    (f"x@SHA256:{DIGEST}", False),
    ("", False),
    ("vocalis-main-app-cuda", False),
    (f"x@sha256:{DIGEST} ", False),
]


def test_the_build_validates_image_references_with_setup_shs_rule():
    sh = SETUP_SH.read_text(encoding="utf-8")
    bash_rule = re.search(r'\[\[ "\$1" =~ (\^.*\$) \]\]', sh).group(1)
    assert bash_rule == r"^[^[:space:]]+@sha256:[a-fA-F0-9]{64}$"
    ps = BUILD_PS1.read_text(encoding="ascii")
    ps_rule = re.search(r"\$DigestReferencePattern = '([^']+)'", ps).group(1)
    # the same rule, with \s for [:space:] and \z for $ (.NET's $ also matches before a trailing newline)
    assert ps_rule == bash_rule.replace("[^[:space:]]", r"[^\s]").replace("$", r"\z")
    # and the rule accepts and rejects what Python's equivalent does, for every case
    oracle = re.compile(r"[^\s]+@sha256:[a-fA-F0-9]{64}")
    for reference, expected in DIGEST_CASES:
        assert bool(oracle.fullmatch(reference)) is expected, reference


@needs_powershell
def test_build_installer_accepts_and_refuses_the_same_references_as_setup_sh(tmp_path):
    result = _run_ps(tmp_path, BUILD_PS1, "[pscustomobject]@{ r = @($Data | ForEach-Object { Test-DigestReference $_ }) } | ConvertTo-Json -Compress",
                     functions=("Test-DigestReference",), variables=("DigestReferencePattern",), data=[case for case, _ in DIGEST_CASES])
    assert result["r"] == [expected for _, expected in DIGEST_CASES]


@needs_powershell
def test_signed_builds_refuse_references_without_a_published_registry_host(tmp_path):
    cases = {
        f"vocalis-main-app-cuda@sha256:{DIGEST}": "no registry host",
        f"library/vocalis@sha256:{DIGEST}": "no registry host",  # a Docker Hub namespace is not a host
        f"localhost:5000/vocalis@sha256:{DIGEST}": "on this machine",
        f"127.0.0.1:5000/vocalis@sha256:{DIGEST}": "on this machine",
        f"registry.localhost/vocalis@sha256:{DIGEST}": "on this machine",
        f"ghcr.io/example/vocalis@sha256:{DIGEST}": None,
        f"registry.example:5443/vocalis:1@sha256:{DIGEST}": None,
    }
    result = _run_ps(tmp_path, BUILD_PS1,
                     "[pscustomobject]@{ r = @($Data | ForEach-Object { [string](Get-PublishedReferenceProblem $_) }) } | ConvertTo-Json -Compress",
                     functions=("Get-ImageRegistryHost", "Get-PublishedReferenceProblem"), data=list(cases))
    for reference, problem, expected in zip(cases, result["r"], cases.values()):
        if expected is None:
            assert problem == "", (reference, problem)
        else:
            assert expected in problem, (reference, problem)


@needs_powershell
def test_the_build_output_folder_is_script_relative_unless_absolute(tmp_path):
    # October 9, 2026: an absolute -OutputDirectory was glued onto the script folder and the build stopped.
    base = str(tmp_path / "packaging" / "windows")
    absolute = str(tmp_path / "elsewhere" / "out")
    relative = r"..\..\artifacts\windows"
    body = (f"[pscustomobject]@{{ rel = (Resolve-OutputRoot '{base}' '{relative}'); "
            f"abs = (Resolve-OutputRoot '{base}' '{absolute}') }} | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, BUILD_PS1, body, functions=("Resolve-OutputRoot",))
    assert result["rel"] == str(tmp_path / "artifacts" / "windows")
    assert result["abs"] == absolute


@needs_powershell
def test_the_build_reads_the_version_and_derives_the_file_version(tmp_path):
    tts = tmp_path / "tts_utils.py"
    tts.write_text('import os\nVERSION = "12.0.0-M1"\nOTHER = "x"\n', encoding="ascii")
    bad = tmp_path / "bad_tts_utils.py"
    bad.write_text('VERSION = "12.0-beta"\n', encoding="ascii")
    body = (
        f"$real = Get-VocalisVersion '{REPO / 'source' / 'vocalis' / 'src' / 'tts_utils.py'}'\n"
        f"$one = Get-VocalisVersion '{tts}'\n"
        "$refused = $false\n"
        f"try {{ [void](Get-VocalisVersion '{bad}') }} catch {{ $refused = $_.Exception.Message -like '*12.0-beta*' }}\n"
        "[pscustomobject]@{ real = $real; one = $one; info = (Get-VersionInfoVersion $one); final = (Get-VersionInfoVersion '13.2.7'); refused = $refused } | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, BUILD_PS1, body, functions=("Get-VocalisVersion", "Get-VersionInfoVersion"), variables=("VersionPattern",))
    assert result["one"] == "12.0.0-M1" and result["info"] == "12.0.0.0" and result["final"] == "13.2.7.0"
    assert result["refused"] is True
    # the real source version is one the build accepts, and it is the version the installer is named for
    assert re.fullmatch(r"\d+\.\d+\.\d+(-M\d+)?", result["real"])
    assert f'VERSION = "{result["real"]}"' in (REPO / "source" / "vocalis" / "src" / "tts_utils.py").read_text(encoding="utf-8")


@needs_powershell
def test_the_build_refuses_carriage_returns_in_linux_side_files(tmp_path):
    clean = tmp_path / "clean.sh"
    clean.write_bytes(b"#!/usr/bin/env bash\necho ok\n")
    dirty = tmp_path / "dirty.yaml"
    dirty.write_bytes(b"services:\r\n  a: {}\r\n")
    missing = tmp_path / "missing.yaml"
    body = (
        "$out = [ordered]@{}\n"
        f"try {{ Assert-NoCarriageReturns @('{clean}'); $out.clean = 'ok' }} catch {{ $out.clean = $_.Exception.Message }}\n"
        f"try {{ Assert-NoCarriageReturns @('{clean}', '{dirty}'); $out.dirty = 'ok' }} catch {{ $out.dirty = $_.Exception.Message }}\n"
        f"try {{ Assert-NoCarriageReturns @('{missing}'); $out.missing = 'ok' }} catch {{ $out.missing = $_.Exception.Message }}\n"
        "[pscustomobject]$out | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, BUILD_PS1, body, functions=("Assert-NoCarriageReturns",))
    assert result["clean"] == "ok"
    assert "carriage return" in result["dirty"] and "dirty.yaml" in result["dirty"] and "offset 9" in result["dirty"]
    assert "missing" in result["missing"]


@needs_powershell
def test_the_build_manifest_lists_what_the_iss_installs(tmp_path):
    body = (f"[pscustomobject]@{{ r = @(Get-IssPackagedFiles '{ISS}' | ForEach-Object {{ $_.InstalledAs }}) }} | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, BUILD_PS1, body, functions=("Get-IssPackagedFiles",))
    installed = [source for source, flags, _, _ in _files_section() if "dontcopy" not in flags]
    assert result["r"] == [Path(source.replace("\\", "/")).name for source in installed]
    assert "setup.ps1" in result["r"] and "LICENSE" in result["r"]
    assert "windows-compose.ps1" in result["r"]  # amendment 15: installed beside setup.ps1 and the control script


def test_the_build_script_keeps_its_safety_rules_in_the_text():
    ps = BUILD_PS1.read_text(encoding="ascii")
    assert "Refusing to overwrite existing package artifact" in ps
    assert ".sha256" in ps and ".files.json" in ps
    assert "--locked-mode" in ps
    assert "InnoSetupCompiler" in ps
    assert "signing.local.json" in ps
    assert "azurecodesign" in ps
    assert "Get-PublishedReferenceProblem" in ps
    # signing paths and accounts are never in the repository
    signing = SIGNING_PS1.read_text(encoding="ascii")
    assert "timestamp.acs.microsoft.com" in signing and "Douglas Beachy" in signing
    for text in (ps, signing, ISS.read_text(encoding="utf-8")):
        assert not re.search(r"(?i)(tenant|client[_-]?secret|endpoint\s*=|CertificateProfile|AZURE_)", text)


def test_the_restore_is_pinned_and_locked():
    csproj = (WINDOWS / "Vocalis.InstallerBuild.csproj").read_text(encoding="utf-8")
    assert 'Include="Tools.InnoSetup" Version="6.7.3"' in csproj
    assert "<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>" in csproj
    lock = json.loads((WINDOWS / "packages.lock.json").read_text(encoding="utf-8"))
    package = lock["dependencies"]["net10.0"]["Tools.InnoSetup"]
    assert package["resolved"] == "6.7.3" and package["type"] == "Direct" and package["contentHash"]


def test_build_outputs_are_git_ignored():
    ignore = (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()
    for entry in ("/artifacts/", "/packaging/windows/obj/", "/packaging/windows/bin/", "/packaging/windows/signing.local.json"):
        assert entry in ignore, entry


# ---- vocalis-control.ps1 -------------------------------------------------------------------------------------

VERSION_CASES = [
    # (installed, new, expected order of installed against new)
    ("12.0.0-M1", "12.0.0-M2", -1),
    ("12.0.0-M2", "12.0.0-M1", 1),
    ("12.0.0-M2", "12.0.0", -1),  # a final release is above every milestone
    ("12.0.0", "12.0.0-M9", 1),
    ("12.0.0-M1", "12.0.0-M1", 0),
    ("12.0.0", "12.0.0", 0),
    ("12.0.0-M10", "12.0.0-M9", 1),  # milestone numbers compare as numbers
    ("12.0.10", "12.0.9", 1),  # and so do the numeric parts
    ("12.0.1-M1", "12.0.0", 1),  # the numeric version decides before the suffix
    ("12.0.0", "12.0.1-M1", -1),
    ("11.9.9", "12.0.0-M1", -1),
    ("abc", "12.0.0", None),
    ("12.0", "12.0.0", None),
    ("12.0.0-rc1", "12.0.0", None),
    ("12.0.0-m1", "12.0.0", None),  # the milestone marker is an upper-case M
    ("12.0.0\n", "12.0.0", None),  # no trailing newline slips through
    ("", "12.0.0", None),
]


@needs_powershell
def test_version_order_is_numeric_then_milestone_with_no_suffix_highest(tmp_path):
    data = [[a, b] for a, b, _ in VERSION_CASES]
    result = _run_ps(tmp_path, CONTROL_PS1,
                     "[pscustomobject]@{ r = @($Data | ForEach-Object { $o = Compare-VocalisVersion $_[0] $_[1]; if ($null -eq $o) { 'null' } else { [string]$o } }) } | ConvertTo-Json -Compress",
                     functions=("ConvertTo-VocalisVersionKey", "Compare-VocalisVersion"), data=data)
    assert result["r"] == ["null" if expected is None else str(expected) for _, _, expected in VERSION_CASES]


@needs_powershell
def test_compare_version_action_exit_codes_are_what_the_installer_maps(tmp_path):
    expected_code = {-1: 40, 0: 41, 1: 42, None: 43}
    # Run the way the installer runs it: from {tmp}, where it extracts the control script and (since amendment 15) the
    # helper both scripts dot-source, and nothing else.
    extracted = tmp_path / "extracted tmp"
    extracted.mkdir()
    shutil.copy(CONTROL_PS1, extracted / "vocalis-control.ps1")
    shutil.copy(COMPOSE_HELPER, extracted / "windows-compose.ps1")
    for installed, new, order in [VERSION_CASES[0], VERSION_CASES[1], VERSION_CASES[4], VERSION_CASES[11]]:
        result = subprocess.run(
            [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(extracted / "vocalis-control.ps1"), "-Action", "compare-version",
             "-InstalledVersion", installed, "-NewVersion", new],
            capture_output=True, text=True, timeout=60)
        assert result.returncode == expected_code[order], (installed, new, result.stdout + result.stderr)
    # the installer refuses only on 42 (installed is higher) and reads these codes
    iss = ISS.read_text(encoding="utf-8")
    assert "Result := ResultCode = 42" in iss and "-Action compare-version" in iss


def _state(tmp_path, root):
    return {"version": "12.0.0-M1", "root": str(root), "variant": "cuda", "vocalisImage": f"vocalis-main-app-cuda@sha256:{'1' * 64}",
            "taproomImage": f"vocalis-g1-taproom@sha256:{'2' * 64}", "vocalisPort": 18770, "taproomPort": 18771}


@needs_powershell
def test_repair_plan_decides_first_install_rerun_or_update_from_the_saved_instance(tmp_path):
    state = _state(tmp_path, tmp_path / "data")
    same = {"VOCALIS_IMAGE": state["vocalisImage"], "TAPROOM_IMAGE": state["taproomImage"], "VOCALIS_PORT": "18999"}
    other_vocalis = dict(same, VOCALIS_IMAGE=f"vocalis-main-app-cuda@sha256:{'9' * 64}")
    other_taproom = dict(same, TAPROOM_IMAGE=f"vocalis-g1-taproom@sha256:{'9' * 64}")
    missing_keys = {"VOCALIS_PORT": "18999"}
    body = (
        "$out = foreach ($case in $Data.cases) {\n"
        "  $envValues = $null\n"
        "  if ($case.env) { $envValues = @{}; $case.env.PSObject.Properties | ForEach-Object { $envValues[$_.Name] = [string]$_.Value } }\n"
        "  $plan = Get-RepairPlan -State $Data.state -EnvValues $envValues\n"
        "  [pscustomobject]@{ mode = $plan.Mode; keys = @($plan.Parameters.Keys); params = $plan.Parameters }\n"
        "}\n"
        "[pscustomobject]@{ r = @($out) } | ConvertTo-Json -Compress -Depth 6")
    cases = [{"env": None}, {"env": same}, {"env": other_vocalis}, {"env": other_taproom}, {"env": missing_keys}]
    result = _run_ps(tmp_path, CONTROL_PS1, body, functions=("Get-RepairPlan",), data={"state": state, "cases": cases})["r"]
    assert [plan["mode"] for plan in result] == ["first", "rerun", "update", "update", "update"]
    first, rerun, update = result[0], result[1], result[2]
    # first install (instance.env absent): every first-install argument, the baked references and the ports
    assert sorted(first["keys"]) == sorted(["Root", "NoBrowser", "PauseOnFailure", "Variant", "VocalisImage", "TaproomImage", "VocalisPort", "TaproomPort"])
    assert first["params"]["Variant"] == "cuda" and first["params"]["VocalisPort"] == 18770 and first["params"]["TaproomPort"] == 18771
    # rerun: -Root only (plus the console switches); no images, no ports, no variant
    assert sorted(rerun["keys"]) == sorted(["Root", "NoBrowser", "PauseOnFailure"])
    assert rerun["params"]["Root"] == state["root"]
    # update: -Update with the baked references and root, never ports (setup.sh refuses a port change) or variant
    assert sorted(update["keys"]) == sorted(["Root", "NoBrowser", "PauseOnFailure", "Update", "VocalisImage", "TaproomImage"])
    assert update["params"]["VocalisImage"] == state["vocalisImage"] and update["params"]["TaproomImage"] == state["taproomImage"]
    for plan in result[1:]:
        assert "VocalisPort" not in plan["keys"] and "TaproomPort" not in plan["keys"] and "Variant" not in plan["keys"]
        assert plan["params"]["NoBrowser"] is True and plan["params"]["PauseOnFailure"] is True


@needs_powershell
def test_repair_plan_passes_the_recorded_previous_data_folder_as_seed_models_in_every_mode(tmp_path):
    state = _state(tmp_path, tmp_path / "data")
    same = {"VOCALIS_IMAGE": state["vocalisImage"], "TAPROOM_IMAGE": state["taproomImage"]}
    other = dict(same, VOCALIS_IMAGE=f"vocalis-main-app-cuda@sha256:{'9' * 64}")
    body = (
        "$out = foreach ($case in $Data.cases) {\n"
        "  $envValues = $null\n"
        "  if ($case.env) { $envValues = @{}; $case.env.PSObject.Properties | ForEach-Object { $envValues[$_.Name] = [string]$_.Value } }\n"
        "  $s = $Data.state.PSObject.Copy()\n"
        "  if ($case.seed -ne $null) { $s | Add-Member -NotePropertyName seedModels -NotePropertyValue $case.seed -Force }\n"
        "  $plan = Get-RepairPlan -State $s -EnvValues $envValues\n"
        "  [pscustomobject]@{ mode = $plan.Mode; keys = @($plan.Parameters.Keys); seed = [string]$plan.Parameters.SeedModels }\n"
        "}\n"
        "[pscustomobject]@{ r = @($out) } | ConvertTo-Json -Compress -Depth 6")
    previous = "E:\\Old Vocalis Data"
    cases = [{"env": None, "seed": previous}, {"env": same, "seed": previous}, {"env": other, "seed": previous},
             {"env": None}, {"env": same, "seed": ""}, {"env": other, "seed": "   "}]
    result = _run_ps(tmp_path, CONTROL_PS1, body, functions=("Get-RepairPlan",), data={"state": state, "cases": cases})["r"]
    assert [plan["mode"] for plan in result] == ["first", "rerun", "update", "first", "rerun", "update"]
    for plan in result[:3]:
        assert plan["seed"] == previous and "SeedModels" in plan["keys"], plan
    for plan in result[3:]:
        assert "SeedModels" not in plan["keys"], plan  # nothing recorded (or blank): the plan is exactly as before


@needs_powershell
def test_instance_env_and_state_are_read_as_setup_sh_writes_them(tmp_path):
    env = tmp_path / "instance.env"
    env.write_bytes(b"INSTANCE_ID=vi-50c78647a395\nGPU_VARIANT=cuda\nINSTANCE_ROOT='/mnt/e/Vocalis Docker/x'\n# comment\n\nVOCALIS_PORT=18770\n")
    state = tmp_path / "installer-state.json"
    state.write_text(json.dumps(_state(tmp_path, "E:\\Vocalis Docker\\x")), encoding="ascii")
    broken = tmp_path / "broken-state.json"
    broken.write_text(json.dumps({"version": "12.0.0-M1"}), encoding="ascii")
    body = (
        f"$values = Read-InstanceEnv '{env}'\n"
        f"$s = Read-InstallerState '{state}'\n"
        "$err = ''\n"
        f"try {{ [void](Read-InstallerState '{broken}') }} catch {{ $err = $_.Exception.Message }}\n"
        "[pscustomobject]@{ id = $values['INSTANCE_ID']; root = $values['INSTANCE_ROOT']; port = $values['VOCALIS_PORT']; stateRoot = $s.root; err = $err } | ConvertTo-Json -Compress")
    # Read-InstanceEnv lives in the shared helper since October 10, 2026; Read-InstallerState stays in the control script
    result = _run_ps(tmp_path, [COMPOSE_HELPER, CONTROL_PS1], body, functions=("Read-InstanceEnv", "Read-InstallerState"))
    assert result["id"] == "vi-50c78647a395" and result["root"] == "/mnt/e/Vocalis Docker/x" and result["port"] == "18770"
    assert result["stateRoot"] == "E:\\Vocalis Docker\\x"
    assert "no value for 'root'" in result["err"]


HELPER_FUNCTIONS = ("Read-InstanceEnv", "ConvertTo-WindowsInstanceRoot", "Get-ComposeChildEnvironment", "Test-SameFile", "Get-WindowsComposeCall",
                    "Get-OwnershipRuns", "Start-WindowsInstance")


def _ords(text):
    return [ord(c) for c in text]


# (recorded INSTANCE_ROOT, the Windows spelling or None when it is refused)
ROOT_CASES = [
    ("/mnt/e/Vocalis/x", "E:/Vocalis/x"),
    ("/mnt/e", "E:"),
    ("/mnt/c/Users/Some Body/My Vocalis Data", "C:/Users/Some Body/My Vocalis Data"),  # spaces
    ("/mnt/d/Vocalis/caf\u00e9/\u30dc\u30a4\u30b9", "D:/Vocalis/caf\u00e9/\u30dc\u30a4\u30b9"),  # non-ASCII
    ("/mnt/z/a-b_c.d/e", "Z:/a-b_c.d/e"),
    ("/srv/vocalis", None),             # not on a drive
    ("/mnt/wsl/instance", None),        # another mount under /mnt
    ("/mnt/E/Vocalis", None),           # upper-case letters are not WSL's spelling
    ("/mnt/ee/x", None),
    ("/mnt/", None),
    ("/mnt", None),
    ("E:/Vocalis", None),
    ("E:\\Vocalis", None),
    ("\\\\wsl$\\Ubuntu\\home\\x", None),  # a \\wsl$ path
    ("/home/x/.local/share/vocalis/instance", None),
    ("/mnt/e/Vocalis\nx", None),         # a line break
    ("", None),
]


@needs_powershell
def test_the_windows_root_is_derived_from_the_recorded_wsl_root_or_refused(tmp_path):
    body = (
        "$out = foreach ($case in $Data) {\n"
        "  try { $r = ConvertTo-WindowsInstanceRoot $case; ('ok:' + (($r.ToCharArray() | ForEach-Object { [int]$_ }) -join ',')) } catch { 'refused' }\n"
        "}\n"
        "[pscustomobject]@{ r = @($out) } | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=("ConvertTo-WindowsInstanceRoot",), data=[case for case, _ in ROOT_CASES])["r"]
    expected = ["refused" if windows is None else "ok:" + ",".join(str(code) for code in _ords(windows)) for _, windows in ROOT_CASES]
    assert result == expected


@needs_powershell
def test_the_helper_builds_setup_shs_exact_compose_invocation_with_a_windows_root(tmp_path):
    sh = SETUP_SH.read_text(encoding="utf-8")
    assert 'docker compose --project-name "vocalis-$INSTANCE_ID" --env-file "$ENV_FILE_FOR_COMPOSE" "${COMPOSE_FILES[@]}" "$@"' in sh
    assert 'COMPOSE_FILES=(-f "$BASE_COMPOSE" -f "$CUDA_COMPOSE")' in sh and 'COMPOSE_FILES=(-f "$BASE_COMPOSE" -f "$ROCM_COMPOSE")' in sh
    assert 'BASE_COMPOSE="$PACKAGING_DIR/compose.yaml"' in sh and 'CUDA_COMPOSE="$PACKAGING_DIR/compose.cuda.yaml"' in sh
    cuda = write_instance(tmp_path, name="cuda instance")
    rocm = write_instance(tmp_path, name="rocm instance")
    (rocm / "instance.env").write_text((rocm / "instance.env").read_text(encoding="utf-8").replace("GPU_VARIANT=cuda", "GPU_VARIANT=rocm"), encoding="utf-8")
    body = (
        "$packaging = $Data.packaging\n"
        "$ok = Get-WindowsComposeCall -InstanceFolder $Data.cuda -Verb @('stop') -PackagingFolder $packaging -InheritedEnvironment @{ KEEP = 'x' }\n"
        "$rocm = Get-WindowsComposeCall -InstanceFolder $Data.rocm -Verb @('up', '-d') -PackagingFolder $packaging -InheritedEnvironment @{ KEEP = 'x' }\n"
        "$bare = Get-WindowsComposeCall -InstanceFolder $Data.cuda -PackagingFolder $packaging -InheritedEnvironment @{}\n"
        "[pscustomobject]@{ ok = @($ok.Arguments); rocm = @($rocm.Arguments); bare = @($bare.Arguments); base = @($bare.Base); root = $ok.WindowsRoot; id = $ok.InstanceId } | ConvertTo-Json -Compress")
    packaging = str(tmp_path / "app dir")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=HELPER_FUNCTIONS[:5],
                     data={"cuda": str(cuda), "rocm": str(rocm), "packaging": packaging})
    head = ["compose", "--project-name", "vocalis-vi-50c78647a395", "--env-file", str(cuda / "instance.env"),
            "-f", packaging + "\\compose.yaml", "-f", packaging + "\\compose.cuda.yaml"]
    assert result["ok"] == head + ["stop"]
    assert result["bare"] == result["base"] == head
    assert result["rocm"] == ["compose", "--project-name", "vocalis-vi-50c78647a395", "--env-file", str(rocm / "instance.env"),
                              "-f", packaging + "\\compose.yaml", "-f", packaging + "\\compose.rocm.yaml", "up", "-d"]
    assert result["id"] == "vi-50c78647a395" and result["root"] == cuda.as_posix()[0].upper() + cuda.as_posix()[1:]


@needs_powershell
def test_the_helper_appends_compose_local_yaml_after_the_variant_file_exactly_when_setup_sh_does(tmp_path):
    # Design section 11, item 9 (October 10, 2026): <root>/compose.local.yaml is appended after the variant file by
    # setup.sh's compose() and by the Windows helper, and by nothing else; without the file both are unchanged.
    sh = SETUP_SH.read_text(encoding="utf-8")
    variant_line = sh.index('COMPOSE_FILES=(-f "$BASE_COMPOSE" -f "$CUDA_COMPOSE")')
    append_line = sh.index('COMPOSE_FILES+=(-f "$LOCAL_COMPOSE")')
    assert variant_line < append_line < sh.index("compose() {")
    assert 'LOCAL_COMPOSE="$INSTANCE_ROOT/compose.local.yaml"' in sh
    plain = write_instance(tmp_path, name="plain")
    with_local = write_instance(tmp_path, name="with local")
    rocm_local = write_instance(tmp_path, name="rocm local")
    as_folder = write_instance(tmp_path, name="local is a folder")
    as_link = write_instance(tmp_path, name="local is a link")
    (rocm_local / "instance.env").write_text((rocm_local / "instance.env").read_text(encoding="utf-8").replace("GPU_VARIANT=cuda", "GPU_VARIANT=rocm"), encoding="utf-8")
    (with_local / "compose.local.yaml").write_text("services: {}\n", encoding="utf-8")
    (rocm_local / "compose.local.yaml").write_text("services: {}\n", encoding="utf-8")
    (as_folder / "compose.local.yaml").mkdir()
    (as_link / "target.yaml").write_text("services: {}\n", encoding="utf-8")
    dangling = write_instance(tmp_path, name="local is a dangling link")
    body = (
        "$packaging = $Data.packaging\n"
        "function Try-Call($folder) { try { @((Get-WindowsComposeCall -InstanceFolder $folder -Verb @('stop') -PackagingFolder $packaging -InheritedEnvironment @{}).Arguments) } catch { 'refused:' + $_.Exception.Message } }\n"
        "$link = 'no-symlink-privilege'\n"
        "try { New-Item -ItemType SymbolicLink -Path (Join-Path $Data.asLink 'compose.local.yaml') -Target (Join-Path $Data.asLink 'target.yaml') -ErrorAction Stop | Out-Null; $link = Try-Call $Data.asLink } catch { }\n"
        "$dangling = 'no-symlink-privilege'\n"
        "try { New-Item -ItemType SymbolicLink -Path (Join-Path $Data.dangling 'compose.local.yaml') -Target (Join-Path $Data.dangling 'not-there.yaml') -ErrorAction Stop | Out-Null; $dangling = Try-Call $Data.dangling } catch { }\n"
        # a junction needs no privilege: made, then its target removed, it is a link to nothing (a dangling file symlink,
        # which Test-Path reports as absent, is exercised below when the account may create symlinks)
        "New-Item -ItemType Directory -Path (Join-Path $Data.junction 'gone') | Out-Null\n"
        "New-Item -ItemType Junction -Path (Join-Path $Data.junction 'compose.local.yaml') -Target (Join-Path $Data.junction 'gone') | Out-Null\n"
        "Remove-Item -LiteralPath (Join-Path $Data.junction 'gone') -Force\n"
        "$junction = Try-Call $Data.junction\n"
        "[pscustomobject]@{ junction = $junction; dangling = $dangling; plain = @(Try-Call $Data.plain); local = @(Try-Call $Data.withLocal); rocm = @(Try-Call $Data.rocmLocal); folder = Try-Call $Data.asFolder; link = $link } | ConvertTo-Json -Compress -Depth 4")
    packaging = str(tmp_path / "app dir")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=HELPER_FUNCTIONS[:5],
                     data={"plain": str(plain), "withLocal": str(with_local), "rocmLocal": str(rocm_local), "asFolder": str(as_folder),
                           "asLink": str(as_link), "dangling": str(dangling), "junction": str(write_instance(tmp_path, name="local is a dangling junction")),
                           "packaging": packaging})

    def call(folder, variant):
        return ["compose", "--project-name", "vocalis-vi-50c78647a395", "--env-file", str(folder / "instance.env"),
                "-f", packaging + "\\compose.yaml", "-f", packaging + f"\\compose.{variant}.yaml"]
    assert result["plain"] == call(plain, "cuda") + ["stop"]
    assert result["local"] == call(with_local, "cuda") + ["-f", str(with_local / "compose.local.yaml"), "stop"]
    assert result["rocm"] == call(rocm_local, "rocm") + ["-f", str(rocm_local / "compose.local.yaml"), "stop"]
    assert isinstance(result["folder"], str) and result["folder"].startswith("refused:") and "regular file" in result["folder"]
    assert isinstance(result["junction"], str) and result["junction"].startswith("refused:") and "not a link" in result["junction"], result["junction"]
    if result["dangling"] != "no-symlink-privilege":  # a link to nothing is refused too (Test-Path would call it absent)
        assert isinstance(result["dangling"], str) and result["dangling"].startswith("refused:") and "not a link" in result["dangling"], result["dangling"]
    if result["link"] != "no-symlink-privilege":  # creating a file symlink needs a privilege this account may lack
        assert isinstance(result["link"], str) and result["link"].startswith("refused:") and "not a link" in result["link"], result["link"]


@needs_powershell
def test_the_ownership_pass_uses_the_recorded_vocalis_paths_and_taproom_etc_and_data_mounts(tmp_path):
    # Design section 11, items 3 and 4: the two Vocalis stores come from instance.env (same defaults as compose.yaml
    # when the keys are absent) and Taproom's mounts are /etc/taproom and /data/taproom/data.
    body = (
        "function Mounts($values) { try { @((Get-OwnershipRuns $values) | ForEach-Object { ,@($_.Mounts) }) } catch { 'refused' } }\n"
        "$base = @{ VOCALIS_UID = '1000'; VOCALIS_GID = '1000'; TAPROOM_UID = '1001'; TAPROOM_GID = '1002' }\n"
        "$recorded = $base.Clone(); $recorded['VOCALIS_DATA_PATH'] = '/home/user/Vocalis'; $recorded['VOCALIS_CACHE_PATH'] = '/home/user/.cache/vocalis'\n"
        "$blank = $base.Clone(); $blank['VOCALIS_DATA_PATH'] = ''; $blank['VOCALIS_CACHE_PATH'] = ''\n"
        "$bad = @()\n"
        "foreach ($value in @('relative/x', '/has space', '/semi;colon', '', '/quote\"x')) {\n"
        "  if ($value -eq '') { continue }\n"
        "  $v = $base.Clone(); $v['VOCALIS_DATA_PATH'] = $value; $bad += (Mounts $v) -eq 'refused'\n"
        "}\n"
        "[pscustomobject]@{ absent = (Mounts $base); recorded = (Mounts $recorded); blank = (Mounts $blank); bad = $bad } | ConvertTo-Json -Compress -Depth 5")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=("Get-OwnershipRuns",))
    assert result["absent"] == [VOCALIS_MOUNTS, TAPROOM_MOUNTS] == result["blank"]
    assert result["recorded"] == [["/home/user/Vocalis", "/home/user/.cache/vocalis", "/models/vocalis", "/work/vocalis", "/logs"],
                                  ["/etc/taproom", "/data/taproom/data", "/logs"]]
    assert result["bad"] == [True] * 4


@needs_powershell
def test_a_data_folder_reached_through_a_junction_is_the_same_instance(tmp_path):
    # setup.sh records INSTANCE_ROOT with `pwd -P`, which resolves junctions, so the recorded root and the folder the
    # installer remembers are spelled differently; the helper compares the files themselves (review, October 10, 2026).
    real = write_instance(tmp_path, name="real data")
    link = tmp_path / "via junction"
    body = (
        "New-Item -ItemType Junction -Path $Data.link -Target $Data.real | Out-Null\n"
        "try { $c = Get-WindowsComposeCall -InstanceFolder $Data.link -PackagingFolder 'P:\\pkg' -InheritedEnvironment @{}; $r = 'ok:' + $c.WindowsRoot }\n"
        "catch { $r = 'refused:' + $_.Exception.Message }\n"
        "[pscustomobject]@{ r = $r; same = (Test-SameFile (Join-Path $Data.link 'instance.env') (Join-Path $Data.real 'instance.env'));"
        " other = (Test-SameFile (Join-Path $Data.real 'instance.env') $Data.missing) } | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=HELPER_FUNCTIONS[:5],
                     data={"real": str(real), "link": str(link), "missing": str(tmp_path / "nothing here")})
    assert result["r"] == "ok:" + real.as_posix()[0].upper() + real.as_posix()[1:], result
    assert result["same"] is True and result["other"] is False


@needs_powershell
def test_the_helper_refuses_a_bad_identity_a_missing_file_or_a_root_that_is_another_folder(tmp_path):
    good = write_instance(tmp_path, name="good")
    other = write_instance(tmp_path, name="the other folder")
    copied = write_instance(tmp_path, name="copied")
    # a copied or restored instance.env that still names another folder is refused, whatever the case of the drive letter
    (copied / "instance.env").write_text((other / "instance.env").read_text(encoding="utf-8"), encoding="utf-8")
    elsewhere = write_instance(tmp_path, name="elsewhere", root_line="INSTANCE_ROOT='/mnt/q/not/here'")
    text = (good / "instance.env").read_text(encoding="utf-8")
    bad_id = write_instance(tmp_path, name="bad id")
    (bad_id / "instance.env").write_text(text.replace("vi-50c78647a395", "Vi-1;rm").replace(_mnt(good), _mnt(bad_id)), encoding="utf-8")
    bad_variant = write_instance(tmp_path, name="bad variant")
    (bad_variant / "instance.env").write_text(text.replace("GPU_VARIANT=cuda", "GPU_VARIANT=cpu").replace(_mnt(good), _mnt(bad_variant)), encoding="utf-8")
    no_file = tmp_path / "no instance env"
    no_file.mkdir()
    # non-ASCII and spaces in the folder itself are fine (the root and the file agree)
    fancy = write_instance(tmp_path, name="caf\u00e9 \u30dc\u30a4\u30b9 data")
    # Windows paths are case-insensitive: a root recorded in another case is still this folder
    cased_folder = (tmp_path / "Cased Folder").resolve()
    cased = write_instance(tmp_path, name="Cased Folder", root_line=f"INSTANCE_ROOT='{_mnt(cased_folder).lower()}'")
    body = (
        "$out = [ordered]@{}\n"
        "foreach ($name in 'good', 'copied', 'elsewhere', 'badId', 'badVariant', 'noFile', 'fancy', 'cased') {\n"
        "  try { $c = Get-WindowsComposeCall -InstanceFolder $Data.folders.$name -PackagingFolder 'P:\\pkg' -InheritedEnvironment @{}; $out[$name] = 'ok:' + ($c.WindowsRoot -ceq $Data.expected.$name) }\n"
        "  catch { $out[$name] = 'refused:' + $_.Exception.Message }\n"
        "}\n"
        "[pscustomobject]$out | ConvertTo-Json -Compress")
    folders = {"good": good, "copied": copied, "elsewhere": elsewhere, "badId": bad_id, "badVariant": bad_variant, "noFile": no_file,
               "fancy": fancy, "cased": cased}
    windows = lambda folder: folder.as_posix()[0].upper() + folder.as_posix()[1:]
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=HELPER_FUNCTIONS[:5],
                     data={"folders": {k: str(v) for k, v in folders.items()}, "expected": {"good": windows(good), "fancy": windows(fancy)}})
    assert result["good"] == "ok:True" and result["fancy"] == "ok:True"  # spaces and non-ASCII come through unchanged
    assert result["cased"].startswith("ok:")  # the folder matched in another case; only the spelling of the root differs
    assert result["copied"].startswith("refused:") and "belongs to another folder" in result["copied"]
    assert result["elsewhere"].startswith("refused:") and "belongs to another folder" in result["elsewhere"]
    assert result["badId"].startswith("refused:") and "Invalid INSTANCE_ID" in result["badId"]
    assert result["badVariant"].startswith("refused:") and "Invalid GPU_VARIANT" in result["badVariant"]
    assert result["noFile"].startswith("refused:") and "No instance.env exists" in result["noFile"]


@needs_powershell
def test_the_child_environment_drops_instance_env_keys_and_compose_keys_whatever_their_case(tmp_path):
    inherited = {"PATH": "C:\\Windows", "SystemRoot": "C:\\Windows", "DOCKER_HOST": "npipe:////./pipe/docker", "UNRELATED": "kept",
                 "Vocalis_Port": "1", "vocalis_image": "stray", "TAPROOM_GID": "9", "instance_root": "/stray",
                 "COMPOSE_PROJECT_NAME": "stray", "compose_file": "stray.yml", "Compose_Profiles": "x",
                 # an old instance.env has neither key: a stray one must not override the defaults in compose.yaml
                 "Vocalis_Data_Path": "/stray/data", "VOCALIS_CACHE_PATH": "/stray/cache"}
    env_values = {"INSTANCE_ID": "vi-x", "VOCALIS_PORT": "18770", "VOCALIS_IMAGE": "i", "TAPROOM_GID": "5", "INSTANCE_ROOT": "/mnt/e/v"}
    body = (
        "$inh = @{}; $Data.inherited.PSObject.Properties | ForEach-Object { $inh[$_.Name] = [string]$_.Value }\n"
        "$vals = @{}; $Data.env.PSObject.Properties | ForEach-Object { $vals[$_.Name] = [string]$_.Value }\n"
        "$child = Get-ComposeChildEnvironment -EnvValues $vals -WindowsRoot 'E:/v' -Inherited $inh\n"
        "[pscustomobject]@{ keys = @($child.Keys | Sort-Object); root = $child['INSTANCE_ROOT']; docker = $child['DOCKER_HOST']; inheritedCount = $inh.Count } | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=("Get-ComposeChildEnvironment",), data={"inherited": inherited, "env": env_values})
    assert sorted(result["keys"], key=str.lower) == sorted(["PATH", "SystemRoot", "DOCKER_HOST", "UNRELATED", "INSTANCE_ROOT"], key=str.lower)
    assert result["root"] == "E:/v" and result["docker"] == "npipe:////./pipe/docker"
    assert result["inheritedCount"] == len(inherited)  # the inherited set itself is only read
    assert not any(key.upper() in ("VOCALIS_DATA_PATH", "VOCALIS_CACHE_PATH") for key in result["keys"])


@needs_powershell
def test_the_ownership_runs_cover_exactly_each_services_mounts_and_validate_the_ids(tmp_path):
    body = (
        "$ok = @(Get-OwnershipRuns @{ VOCALIS_UID = '1000'; VOCALIS_GID = '1000'; TAPROOM_UID = '1001'; TAPROOM_GID = '1002' })\n"
        "$bad = @()\n"
        "foreach ($pair in @(@('abc', '1'), @('1', ''), @('1;rm', '1'), @('-1', '1'), @('12345678901', '1'))) {\n"
        "  try { [void](Get-OwnershipRuns @{ VOCALIS_UID = $pair[0]; VOCALIS_GID = $pair[1]; TAPROOM_UID = '1'; TAPROOM_GID = '1' }); $bad += 'accepted' } catch { $bad += 'refused' }\n"
        "}\n"
        "try { [void](Get-OwnershipRuns @{ VOCALIS_UID = '1'; VOCALIS_GID = '1' }); $bad += 'accepted' } catch { $bad += 'refused' }\n"
        "[pscustomobject]@{ runs = @($ok | ForEach-Object { [pscustomobject]@{ service = $_.Service; verb = @($_.Verb) } }); bad = $bad } | ConvertTo-Json -Compress -Depth 5")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=("Get-OwnershipRuns",))
    assert [(run["service"], run["verb"]) for run in result["runs"]] == [
        ("vocalis", ownership_verb("vocalis", VOCALIS_MOUNTS, "1000", "1000")),
        ("taproom", ownership_verb("taproom", TAPROOM_MOUNTS, "1001", "1002", TAPROOM_PRUNE))]
    assert result["bad"] == ["refused"] * 6
    # only files whose owner differs are touched, and a symlink is never followed
    for run in result["runs"]:
        verb = run["verb"]
        assert "!" in verb and verb.index("!") < verb.index("chown") and "-o" in verb and "-h" in verb
        # chown runs only where owner or group differs; Taproom's nested data folder is pruned from the first walk
        assert verb.count("-prune") == (1 if run["service"] == "taproom" else 0)


@needs_powershell
def test_starting_an_instance_runs_the_ownership_pass_then_up_and_stops_at_the_first_failure(tmp_path):
    root = write_instance(tmp_path)
    # Invoke-Bounded and Write-Host are replaced: nothing runs, every call is recorded, and the case decides the answer.
    body = (
        "$script:Calls = @(); $script:Said = @()\n"
        "function Write-Host { param([Parameter(ValueFromRemainingArguments = $true)]$Text) $script:Said += ($Text -join ' ') }\n"
        "function Invoke-Bounded {\n"
        "  param([string]$FileName, [string[]]$Arguments, [int]$TimeoutSeconds = 60, [switch]$UnicodeOutput, [System.Collections.IDictionary]$Environment)\n"
        "  $script:Calls += ,@{ file = $FileName; args = @($Arguments); timeout = $TimeoutSeconds; hasEnvironment = ($null -ne $Environment); root = $Environment['INSTANCE_ROOT'] }\n"
        "  $step = $script:Calls.Count\n"
        "  $answer = $script:Plan[$step - 1]\n"
        "  [pscustomobject]@{ Started = $true; TimedOut = ($answer -eq 'timeout'); ExitCode = $(if ($answer -is [int]) { $answer } else { -1 }); Output = 'compose says hello'; Milliseconds = 5 }\n"
        "}\n"
        "$cases = @{}\n"
        "foreach ($name in 'good', 'vocalisRecovers', 'vocalisFails', 'vocalisTimesOut', 'taproomFails', 'upFails', 'upTimesOut') {\n"
        "  $script:Calls = @(); $script:Said = @()\n"
        "  $script:Plan = @{ good = @(0, 0, 0); vocalisRecovers = @(3, 0, 0, 0); vocalisFails = @(3, 3); vocalisTimesOut = @('timeout'); taproomFails = @(0, 4, 4); upFails = @(0, 0, 5); upTimesOut = @(0, 0, 'timeout') }[$name]\n"
        "  $r = Start-WindowsInstance -InstanceFolder $Data.root -DockerPath 'D:\\fake\\docker.exe' -PackagingFolder 'P:\\pkg'\n"
        "  $cases[$name] = [pscustomobject]@{ ok = $r.Success; refused = $r.Refused; message = $r.Message; calls = @($script:Calls | ForEach-Object { [pscustomobject]$_ }); said = ($script:Said -join '|') }\n"
        "}\n"
        "$script:Calls = @(); $script:Said = @()\n"
        "$refused = Start-WindowsInstance -InstanceFolder $Data.missing -DockerPath 'D:\\fake\\docker.exe' -PackagingFolder 'P:\\pkg'\n"
        "$cases['refused'] = [pscustomobject]@{ ok = $refused.Success; refused = $refused.Refused; message = $refused.Message; calls = @($script:Calls | ForEach-Object { [pscustomobject]$_ }); said = '' }\n"
        "[pscustomobject]$cases | ConvertTo-Json -Compress -Depth 6")
    result = _run_ps(tmp_path, COMPOSE_HELPER, body, functions=HELPER_FUNCTIONS,
                     variables=("OwnershipPassSeconds", "ComposeUpSeconds"), data={"root": str(root), "missing": str(tmp_path / "nowhere")})
    def verbs(case):
        # args: compose --project-name <id> --env-file <file> -f <base> -f <overlay> <verb...>
        return [call["args"][call["args"].index("-f", 7) + 2:] for call in case["calls"]]
    good = result["good"]
    recovers = result["vocalisRecovers"]  # a pass that fails once (a file vanished mid-walk) and then succeeds
    assert recovers["ok"] is True and [v[0] for v in verbs(recovers)] == ["run", "run", "run", "up"], recovers
    assert good["ok"] is True and good["refused"] is False
    assert [v[0] for v in verbs(good)] == ["run", "run", "up"] and verbs(good)[2] == ["up", "-d", "--no-build", "--pull", "never"]
    assert [call["timeout"] for call in good["calls"]] == [600, 600, 300]  # each step is bounded
    assert all(call["file"] == "D:\\fake\\docker.exe" and call["hasEnvironment"] for call in good["calls"])
    assert all(call["root"] == root.as_posix()[0].upper() + root.as_posix()[1:] for call in good["calls"])
    assert all(call["args"][call["args"].index("--env-file") + 1] == str(root / "instance.env") for call in good["calls"])
    # A failed pass gets one more walk (a file can vanish between listing and chown), so a pass that keeps failing runs twice.
    for name, steps, text in (("vocalisFails", 2, "ownership pass for vocalis failed with exit code 3"),
                              ("vocalisTimesOut", 1, "ownership pass for vocalis did not finish within 600 s"),
                              ("taproomFails", 3, "ownership pass for taproom failed with exit code 4"),
                              ("upFails", 3, "docker compose up failed with exit code 5"),
                              ("upTimesOut", 3, "docker compose up did not finish within 300 s")):
        case = result[name]
        assert case["ok"] is False and case["refused"] is False and len(case["calls"]) == steps, (name, case)
        assert text in case["message"], (name, case["message"])
        if "failed" in text and "ownership" in text:
            assert "compose says hello" in case["said"], name  # the Compose output is printed with the failure
    assert [v[0] for v in verbs(result["taproomFails"])] == ["run", "run", "run"] and [v[0] for v in verbs(result["upFails"])] == ["run", "run", "up"]
    refused = result["refused"]
    assert refused["ok"] is False and refused["refused"] is True and refused["calls"] == [] and "No instance.env exists" in refused["message"]


# ---- the control script, run against the fake docker.exe -----------------------------------------------------------

def _control_in(tmp_path, *, env_text=None, state_root=None, with_setup=False):
    """A copy of the control script and the helper it dot-sources beside a state file (the installed layout)."""
    app = tmp_path / "app"
    app.mkdir(exist_ok=True)
    shutil.copy(CONTROL_PS1, app / "vocalis-control.ps1")
    shutil.copy(COMPOSE_HELPER, app / "windows-compose.ps1")
    if with_setup:
        shutil.copy(SETUP_PS1, app / "setup.ps1")
        for name in ("compose.yaml", "compose.cuda.yaml", "compose.rocm.yaml"):
            shutil.copy(PACKAGING / name, app / name)
    root = tmp_path / "data"
    root.mkdir(exist_ok=True)
    if env_text is not None:
        (root / "instance.env").write_text(env_text, encoding="ascii")
    (app / "installer-state.json").write_text(json.dumps(_state(tmp_path, state_root or root)), encoding="ascii")
    return app, root


def _run_control(app, action, *extra):
    env = os.environ.copy()
    env["PATH"] = str(Path(POWERSHELL).parent)  # no docker.exe, no wsl.exe
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(app / "vocalis-control.ps1"), "-Action", action, "-NoPause", *extra],
        capture_output=True, text=True, timeout=60, env=env, input="")


def _run_control_fake(tmp_path, fake_tools, app, action, env_extra=None, names=("docker.exe",)):
    """The control script with the fake docker.exe only (no wsl.exe anywhere on PATH) and its calls."""
    bin_dir = make_fake_bin(tmp_path, fake_tools, names)
    env = fake_env(tmp_path, bin_dir, **(env_extra or {}))
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(app / "vocalis-control.ps1"), "-Action", action, "-NoPause"],
        capture_output=True, text=True, timeout=120, env=env, input="")
    return result, fake_calls(tmp_path)


@needs_powershell
def test_control_actions_report_distinct_codes_without_docker(tmp_path):
    app, root = _control_in(tmp_path)  # a saved state but no instance.env: setup has not finished
    down = _run_control(app, "down")
    assert down.returncode == 0 and "no containers to remove" in down.stdout, down.stdout + down.stderr
    for action in ("start", "stop"):
        result = _run_control(app, action)
        assert result.returncode == 21 and "Repair setup" in result.stdout, result.stdout + result.stderr
    # a complete instance.env whose root agrees with its folder, but no docker.exe on PATH: 20, and nothing was done
    write_instance(tmp_path, name="data")
    for action in ("start", "stop", "down"):
        result = _run_control(app, action)
        assert result.returncode == 20 and "nothing was done" in result.stdout and "docker.exe was not found" in result.stdout, (action, result.stdout + result.stderr)
    # an instance.env whose root cannot be derived (or is another folder's) is refused with 21 before Docker is even looked for
    (root / "instance.env").write_text("INSTANCE_ID=vi-abc123\nGPU_VARIANT=cuda\n", encoding="ascii")
    for action in ("start", "stop", "down"):
        result = _run_control(app, action)
        assert result.returncode == 21 and "Refusing to" in result.stdout and "docker.exe" not in result.stdout, (action, result.stdout + result.stderr)
    # a missing state file is a failure with its path named, not a crash
    (app / "installer-state.json").unlink()
    result = _run_control(app, "stop")
    assert result.returncode == 1 and "installer state file is missing" in result.stdout


def test_the_control_script_uses_docker_exe_from_windows_and_never_wsl():
    code = "\n".join(line for line in CONTROL_PS1.read_text(encoding="ascii").splitlines() if not line.lstrip().startswith("#"))
    assert "wsl" not in code.lower() and "wslpath" not in code
    assert "Get-WindowsComposeCall" in code and "Start-WindowsInstance" in code and ". $WindowsComposeHelper" in code
    for name in ("Invoke-Bounded", "ConvertTo-ArgumentString", "Read-InstanceEnv", "Get-ComposeArguments"):
        assert f"function {name}" not in code, name
    assert "10 through 19" in CONTROL_PS1.read_text(encoding="ascii")


@needs_powershell
def test_start_runs_the_ownership_pass_then_up_through_docker_exe_and_stop_and_down_run_alone(tmp_path, fake_tools):
    write_instance(tmp_path, name="data")
    app, _ = _control_in(tmp_path)
    dump = {"FAKE_DUMP_ENV": "INSTANCE_ROOT,VOCALIS_PORT,COMPOSE_PROJECT_NAME", "VOCALIS_PORT": "1111", "COMPOSE_PROJECT_NAME": "stray"}
    result, (calls, dumps) = _run_control_fake(tmp_path, fake_tools, app, "start", dump)
    assert result.returncode == 0 and "Vocalis is started." in result.stdout, result.stdout + result.stderr
    assert calls[0][:2] == ["docker", "info"]  # Docker is probed first
    assert all(call[0] == "docker" for call in calls), calls  # wsl.exe is not even on PATH, and nothing asked for it
    compose = compose_calls(calls)
    assert [compose_verb(call) for call in compose] == [
        ownership_verb("vocalis", VOCALIS_MOUNTS, "1000", "1000"), ownership_verb("taproom", TAPROOM_MOUNTS, "1001", "1002", TAPROOM_PRUNE),
        ["up", "-d", "--no-build", "--pull", "never"]]
    expected_root = (tmp_path / "data").resolve().as_posix()
    for call in compose:
        assert call[2:6] == ["--project-name", "vocalis-vi-50c78647a395", "--env-file", str(tmp_path / "data" / "instance.env")]
        assert call[7] == str(app / "compose.yaml") and call[9] == str(app / "compose.cuda.yaml")
    for verb, name, value in dumps:
        assert value == (expected_root[0].upper() + expected_root[1:] if name == "INSTANCE_ROOT" else "(unset)"), (verb, name, value)

    for action in ("stop", "down"):
        (tmp_path / "fake.log").unlink()
        result, (calls, dumps) = _run_control_fake(tmp_path, fake_tools, app, action, dump)
        assert result.returncode == 0, (action, result.stdout + result.stderr)
        assert [compose_verb(call) for call in compose_calls(calls)] == [[action]]  # no ownership pass, no up
        assert all(call[0] == "docker" for call in calls)
        assert {(name, value) for _, name, value in dumps} == {("INSTANCE_ROOT", expected_root[0].upper() + expected_root[1:]),
                                                              ("VOCALIS_PORT", "(unset)"), ("COMPOSE_PROJECT_NAME", "(unset)")}


@needs_powershell
def test_control_reports_1_for_a_failed_ownership_pass_up_or_stop_and_20_when_docker_does_not_answer(tmp_path, fake_tools):
    write_instance(tmp_path, name="data")
    app, _ = _control_in(tmp_path)
    for action, knob, verbs in (("start", {"FAKE_RUN_EXIT_vocalis": 1}, ["run", "run"]), ("start", {"FAKE_UP_EXIT": 1}, ["run", "run", "up"]),
                                ("stop", {"FAKE_STOP_EXIT": 1}, ["stop"]), ("down", {"FAKE_DOWN_EXIT": 1}, ["down"])):
        log = tmp_path / "fake.log"
        if log.exists():
            log.unlink()
        result, (calls, _) = _run_control_fake(tmp_path, fake_tools, app, action, knob)
        assert result.returncode == 1, (action, knob, result.stdout + result.stderr)
        assert [compose_verb(call)[0] for call in compose_calls(calls)] == verbs, (action, knob)
        assert "fake compose" in result.stdout  # the Compose output is printed
    (tmp_path / "fake.log").unlink()
    result, (calls, _) = _run_control_fake(tmp_path, fake_tools, app, "start", {"FAKE_INFO_EXIT": 1})
    assert result.returncode == 20 and "Docker is not running" in result.stdout and compose_calls(calls) == []


@needs_powershell
def test_control_refuses_an_unusable_root_with_21_before_any_docker_call(tmp_path, fake_tools):
    write_instance(tmp_path, name="data", root_line="INSTANCE_ROOT='/srv/vocalis/instance'")
    app, _ = _control_in(tmp_path)
    for action in ("start", "stop", "down"):
        result, (calls, _) = _run_control_fake(tmp_path, fake_tools, app, action)
        assert result.returncode == 21, (action, result.stdout + result.stderr)
        assert calls == [], (action, calls)  # not even `docker info`
        assert "not a folder on a Windows drive" in result.stdout


@needs_powershell
def test_repair_passes_setup_ps1s_exit_code_19_through(tmp_path, fake_tools):
    write_instance(tmp_path, name="data")
    app, root = _control_in(tmp_path, with_setup=True)
    state = json.loads((app / "installer-state.json").read_text(encoding="ascii"))
    # the saved instance already names the baked images (write_instance uses the same references): a plain rerun
    assert f"VOCALIS_IMAGE={state['vocalisImage']}" in (root / "instance.env").read_text(encoding="utf-8")
    result, (calls, _) = _run_control_fake(tmp_path, fake_tools, app, "repair", {"FAKE_UP_EXIT": 1}, names=("docker.exe", "wsl.exe"))
    assert result.returncode == 19, result.stdout + result.stderr
    assert "rerunning setup" in result.stdout
    setup_call = next(call for call in calls if call[:3] == ["wsl", "--exec", "bash"] and call[3].endswith("setup.sh"))
    assert "--defer-start" in setup_call
    assert [compose_verb(call)[0] for call in compose_calls(calls)] == ["run", "run", "up"]
    # compose files are taken from the installed folder, beside the scripts
    assert all(call[7] == str(app / "compose.yaml") for call in compose_calls(calls))


# ---- the icon ------------------------------------------------------------------------------------------------

def _ico_entries():
    data = ICON.read_bytes()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    assert (reserved, kind) == (0, 1)
    entries = []
    for index in range(count):
        width, height, _colors, _res, _planes, bits, size, offset = struct.unpack("<BBBBHHII", data[6 + 16 * index:22 + 16 * index])
        entries.append((width or 256, height or 256, bits, data[offset:offset + size]))
    return entries


def test_the_icon_has_exactly_the_designed_sizes():
    entries = _ico_entries()
    assert [(w, h) for w, h, _, _ in entries] == [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    assert all(bits == 32 and blob[:8] == b"\x89PNG\r\n\x1a\n" for _, _, bits, blob in entries)


def test_the_icon_script_reproduces_the_web_ui_favicon_geometry():
    html = (REPO / "source" / "vocalis" / "src" / "webui" / "index.html").read_text(encoding="utf-8")
    uri = re.search(r'rel="icon"[^>]*href="data:image/svg\+xml;base64,([A-Za-z0-9+/=]+)"', html).group(1)
    svg = base64.b64decode(uri).decode("utf-8")
    assert 'viewBox="0 0 64 64"' in svg and 'rx="14"' in svg and 'fill="#2a2d33"' in svg
    assert 'd="M18 18 L32 46 L46 18"' in svg and 'stroke="#ff7a18"' in svg and 'stroke-width="10"' in svg
    assert 'stroke-linecap="round"' in svg and 'stroke-linejoin="round"' in svg
    pytest.importorskip("PIL")
    spec = importlib.util.spec_from_file_location("vocalis_make_icon", WINDOWS / "make_icon.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scale = module.CANVAS // module.VIEWBOX
    assert (module.CANVAS, module.VIEWBOX, scale) == (1024, 64, 16)
    assert module.POINTS == [(18 * scale, 18 * scale), (32 * scale, 46 * scale), (46 * scale, 18 * scale)]
    assert module.STROKE_WIDTH == 10 * scale and module.CORNER_RADIUS == 14 * scale
    assert module.BACKGROUND[:3] == (0x2A, 0x2D, 0x33) and module.STROKE[:3] == (0xFF, 0x7A, 0x18)
    assert module.SIZES == (16, 24, 32, 48, 64, 128, 256)


def test_the_committed_icon_shows_an_orange_round_capped_v_on_a_dark_rounded_square():
    pytest.importorskip("PIL")
    from PIL import Image
    import io
    blob = next(blob for w, _, _, blob in _ico_entries() if w == 256)
    image = Image.open(io.BytesIO(blob)).convert("RGBA")
    assert image.size == (256, 256)
    assert image.getpixel((0, 0))[3] == 0  # the rounded square's corner is transparent
    assert image.getpixel((10, 128)) == (0x2A, 0x2D, 0x33, 255)  # background
    assert image.getpixel((128, 184)) == (0xFF, 0x7A, 0x18, 255)  # the bottom vertex of the V (32,46 of 64)
    assert image.getpixel((128, 100))[:3] == (0x2A, 0x2D, 0x33)  # inside the V's notch, between the strokes
    assert image.getpixel((72, 60))[:3] == (0xFF, 0x7A, 0x18)  # the left arm's round cap (centered at 72,72, radius 20)


@needs_powershell
def test_repair_runs_setup_ps1_with_the_planned_mode_and_passes_its_exit_code_through(tmp_path):
    app, root = _control_in(tmp_path)
    shutil.copy(PACKAGING / "setup.ps1", app / "setup.ps1")
    state = json.loads((app / "installer-state.json").read_text(encoding="ascii"))
    # no instance.env: the first-install plan; with no docker.exe on PATH setup.ps1 stops at check 10
    first = _run_control(app, "repair")
    assert first.returncode == 10, first.stdout + first.stderr
    assert "running the first-install setup" in first.stdout and "ERROR: docker.exe: not found on PATH." in first.stdout
    assert not (root / "instance.env").exists()
    # an instance.env that names the baked images: a rerun
    (root / "instance.env").write_text(f"VOCALIS_IMAGE={state['vocalisImage']}\nTAPROOM_IMAGE={state['taproomImage']}\n", encoding="ascii")
    rerun = _run_control(app, "repair")
    assert rerun.returncode == 10 and "rerunning setup" in rerun.stdout, rerun.stdout + rerun.stderr
    # different images: an update
    (root / "instance.env").write_text(f"VOCALIS_IMAGE=old@sha256:{'3' * 64}\nTAPROOM_IMAGE={state['taproomImage']}\n", encoding="ascii")
    update = _run_control(app, "repair")
    assert update.returncode == 10 and "updating it to this installer's images" in update.stdout, update.stdout + update.stderr
    # no state file: this script's own failure, code 1, reason shown
    (app / "installer-state.json").unlink()
    broken = _run_control(app, "repair")
    assert broken.returncode == 1 and "installer state file is missing" in broken.stdout


# ---- the wizard: the Welcome page and the Vocalis pictures (October 11, 2026) -------------

def test_the_main_wizard_shows_the_welcome_page_first_and_the_driver_steps_through_it():
    """Section 5 lists the Welcome page as the wizard's first page and Inno Setup 6.7.3 leaves it out unless
    DisableWelcomePage=no (the satellite setup program's probe found the same). Nothing in [Code] skips it."""
    text = ISS.read_text(encoding="utf-8")
    assert re.search(r"^DisableWelcomePage=no$", text, re.MULTILINE)
    code = text[text.index("\n[Code]"):]
    assert "wpWelcome" not in code, "no [Code] may skip or hide the Welcome page"
    skip = code[code.index("function ShouldSkipPage"):code.index("function NextButtonClick")]
    assert "wpWelcome" not in skip and "PageID = " in skip
    # the hidden-desktop driver presses Next on it, before the licence page, and says why
    driver = (WINDOWS / "tests" / "drive_installer.ps1").read_text(encoding="ascii")
    welcome = driver.index("'Welcome to the Vocalis Setup Wizard'")
    assert welcome < driver.index("'License Agreement'") and "Invoke-Button $wizard '^Next'" in driver[welcome:welcome + 600]
    assert "run -Installer through Welcome, License," in driver


def test_the_main_setup_program_names_the_same_two_pictures_as_the_satellite_one():
    small, large = _wizard_pictures_named(ISS.read_text(encoding="utf-8"))
    assert (small, large) == (WIZARD_SMALL, WIZARD_LARGE)
    satellite = _wizard_pictures_named((WINDOWS / "vocalis-satellite.iss").read_text(encoding="ascii"))
    assert (small, large) == satellite, "both setup programs show the same pictures"
    for name in WIZARD_PICTURES:
        assert (WINDOWS / name).is_file(), name
    text = ISS.read_text(encoding="utf-8")
    assert "compiler:" not in text and "WizClassic" not in text and re.search(r"^WizardStyle=modern$", text, re.MULTILINE)
    # the pictures are inputs of the compiler, not installed files: the installed file list is exactly the designed one
    assert not [source for source, *_ in _files_section() if source.endswith(".png")]


def test_the_wizard_pictures_are_what_make_icon_draws_at_the_sizes_inno_wants_and_the_icons_are_unchanged(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image
    import io
    spec = importlib.util.spec_from_file_location("vocalis_make_icon_pictures", WINDOWS / "make_icon.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.wizard_picture_names() == WIZARD_PICTURES
    written = module.build_wizard_pictures(tmp_path)
    assert [path.name for path in written] == WIZARD_PICTURES
    # equal to the committed files, byte for byte (the same check the icons have)
    for path in written:
        assert path.read_bytes() == (WINDOWS / path.name).read_bytes(), f"{path.name} is not what make_icon.py draws; rerun it and commit the files"
    # the sizes: small square at the seven small image area sizes, large at the seven tall sizes, aspect 164:314 within a pixel of rounding
    for name in WIZARD_SMALL:
        with Image.open(WINDOWS / name) as picture:
            size = int(re.search(r"small-(\d+)\.png", name).group(1))
            assert picture.size == (size, size) and picture.mode == "RGBA", name
    for name in WIZARD_LARGE:
        with Image.open(WINDOWS / name) as picture:
            width, height = (int(n) for n in re.search(r"large-(\d+)x(\d+)\.png", name).group(1, 2))
            assert picture.size == (width, height) and picture.mode == "RGB", name
            assert abs(width / height - 164 / 314) < 0.002, name
    # the Vocalis colours and the V: the small picture is the icon, smaller, with a transparent margin of 22 pixels at 159
    # (corner clear, dark tile, orange V; the margin is the header title's top at that scaling, see make_icon.py); the
    # large one is the icon's dark colour with the orange V on it, centered across and above the middle
    background, orange = (0x2A, 0x2D, 0x33), (0xFF, 0x7A, 0x18)
    with Image.open(WINDOWS / "vocalis-wizard-small-159.png") as small:
        assert small.getpixel((0, 0))[3] == 0 and small.getpixel((79, 3))[3] == 0  # the margin and the corner are clear
        assert small.getpixel((79, 105))[:3] == orange  # inside the V's bottom vertex (32,46 of 64 inside the tile)
        assert small.getpixel((79, 60))[:3] == background  # between the strokes, on the tile
    with Image.open(WINDOWS / "vocalis-wizard-large-534x1022.png") as large:
        assert large.getpixel((5, 5)) == background and large.getpixel((528, 1016)) == background
        # the V is the icon's, at the icon's own scale, with its middle at 36% of the height: its two round caps (18,18 and
        # 46,18 of 64) are 14 units either side of the center, 14 units (224 of 1024 px) above it; its bottom vertex is
        # below that; between the arms and well below the V it is the dark colour
        assert large.getpixel((150, 251)) == orange and large.getpixel((384, 251)) == orange  # the two round caps, symmetric about x = 267
        assert large.getpixel((267, 497)) == orange  # the bottom vertex
        assert large.getpixel((267, 300)) == background  # the notch between the arms
        assert large.getpixel((267, 800)) == background  # nothing in the lower half
    # the icons are what they were: vocalis.ico still equals the committed file (the tray test checks the other two)
    icon = tmp_path / "vocalis.ico"
    module.build_icon(icon, "colour")
    assert icon.read_bytes() == ICON.read_bytes()
    assert Image.open(io.BytesIO(icon.read_bytes())).ico.getimage((256, 256)).getpixel((128, 184)) == (*orange, 255)


def test_each_small_wizard_picture_has_its_dark_square_the_same_transparent_gap_from_all_four_edges():
    """October 11, 2026 (Doug: the picture in the header "needs a little bit more space between the icon edge and the edge of
    the frame on the top and the right"). The gap is the title label's Top at that display scaling (8 pixels at 100%,
    measured); Setup draws the file at its own size, so what is in the file is what is on screen."""
    pytest.importorskip("PIL")
    from PIL import Image
    spec = importlib.util.spec_from_file_location("vocalis_make_icon_small_gap", WINDOWS / "make_icon.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert set(module.WIZARD_SMALL_GAP) == set(module.WIZARD_SMALL_SIZES)
    assert module.WIZARD_SMALL_GAP[58] == 8  # measured at 100%: title label top 8, left 24, header 596x58
    for size in module.WIZARD_SMALL_SIZES:
        gap = module.WIZARD_SMALL_GAP[size]
        with Image.open(WINDOWS / f"vocalis-wizard-small-{size}.png") as picture:
            assert picture.size == (size, size) and picture.mode == "RGBA"
            box = picture.getchannel("A").point(lambda value: 255 if value > 127 else 0).getbbox()
        assert box == (gap, gap, size - gap, size - gap), (size, box)  # a square, centered, `gap` pixels from every edge
    # the gap grows with the scaling the way the title label's Top does (a rounding of 8 * size / 58)
    for size, gap in module.WIZARD_SMALL_GAP.items():
        assert gap == int(8 * size / 58 + 0.5), size


def test_both_setup_programs_share_one_header_picture_procedure_and_call_it_first_in_initializewizard():
    shared = (WINDOWS / "wizard-header-picture.iss").read_text(encoding="ascii")  # pure ASCII or this raises
    assert shared.count("procedure PlaceHeaderPicture;") == 1
    for name in ("vocalis.iss", "vocalis-satellite.iss"):
        text = (WINDOWS / name).read_text(encoding="ascii")
        assert text.count('#include "wizard-header-picture.iss"') == 1, name
        assert text.index('#include "wizard-header-picture.iss"') > text.index("[Code]"), name
        wizard = text[text.index("procedure InitializeWizard;"):]
        statements = wizard[wizard.index("begin") + len("begin"):]
        assert statements.split(";")[0].strip() == "PlaceHeaderPicture", name  # the first statement of InitializeWizard
        assert text.index('#include "wizard-header-picture.iss"') < text.index("procedure InitializeWizard;"), name
        # the wizard is not resizable, so the picture does not have to follow a resize (the shared comment says so)
        assert "WizardResizable" not in text, name
    # what the procedure does: the numbers come from the title label and the header, not from constants in the code
    for needed in ("WizardForm.PageNameLabel.Left", "WizardForm.PageNameLabel.Top", "WizardForm.MainPanel.ClientWidth",
                   "WizardForm.MainPanel.ClientHeight", "Picture.SetBounds(", "PageNameLabel.Width := WizardForm.PageNameLabel.Width - Shift",
                   "PageDescriptionLabel.Width := WizardForm.PageDescriptionLabel.Width - Shift"):
        assert needed in shared, needed
    assert "Stretch" not in shared and "Picture.Width :=" not in shared and "Picture.Height :=" not in shared  # the picture keeps its own size
    code = shared[shared.index("procedure PlaceHeaderPicture;"):]
    bare = re.sub(r"'[^']*'", "''", re.sub(r"//.*", "", code))  # no comments, no string texts
    assert set(re.findall(r"\b\d+\b", bare)) <= {"0", "2"}, "no pixel counts of one scaling in the procedure"
    assert "Log('Header picture:" in shared  # the numbers it worked from are logged


def test_the_header_measuring_tool_reports_the_three_gaps_of_a_capture(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image
    spec = importlib.util.spec_from_file_location("vocalis_measure_header", WINDOWS / "tests" / "measure_wizard_header.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # a capture with the client area at (8, 31), a white 596x58 header, and a 42x42 dark square 8 from the top and bottom
    # and 24 from the right edge
    image = Image.new("RGB", (612, 471), (240, 240, 240))
    image.paste((255, 255, 255), (8, 31, 8 + 596, 31 + 58))
    image.paste((0x2A, 0x2D, 0x33), (8 + 596 - 24 - 42, 31 + 8, 8 + 596 - 24, 31 + 8 + 42))
    path = tmp_path / "capture.png"
    image.save(path)
    result = module.measure(str(path), (8, 31, 596, 432), 58)
    assert result["gap_top"] == 8 and result["gap_bottom"] == 8 and result["gap_right"] == 24 and result["size"] == (42, 42)


@needs_compiler
def test_the_pinned_compiler_parses_the_main_script_with_no_warnings(tmp_path):
    """vocalis.iss compiled in place (every packaged file is in the repository) into a temporary folder. A warning is a defect."""
    env = dict(os.environ, VOCALIS_INSTALLER_VERSION="12.0.0-M1", VOCALIS_INSTALLER_VERSION_INFO="12.0.0.0",
               VOCALIS_INSTALLER_VOCALIS_IMAGE=f"vocalis@sha256:{DIGEST}", VOCALIS_INSTALLER_TAPROOM_IMAGE=f"taproom@sha256:{DIGEST}")
    out = tmp_path / "out"
    result = subprocess.run([str(ISCC), f"/O{out}", "/FVocalis-Setup-test", str(ISS)], capture_output=True, text=True, timeout=240, env=env)
    text = result.stdout + result.stderr
    assert result.returncode == 0, text
    assert "Successful compile" in result.stdout
    assert not re.search(r"(?i)\bwarning\b", text), text
    assert [path.name for path in out.glob("*.exe")] == ["Vocalis-Setup-test.exe"]
