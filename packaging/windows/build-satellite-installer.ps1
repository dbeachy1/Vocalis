# Builds the per-user Vocalis Satellite setup program, Vocalis-Satellite-Setup-<version>-x64.exe, with the pinned Inno
# Setup compiler (NuGet Tools.InnoSetup 6.7.3, restored in locked mode through Vocalis.InstallerBuild.csproj, the same
# project build-installer.ps1 uses). Keep this file ASCII: it also runs in Windows PowerShell 5.1. Nothing here pushes,
# publishes or uploads an image or anything else (repository policy): the setup program carries one image REFERENCE and no
# image bytes.
#
#   .\packaging\windows\build-satellite-installer.ps1 -SatelliteImage 'vocalis-satellite@sha256:<64 hex>'
#
# This script
# builds beside the main installer's build and follows it step for step, and adds three things the satellite needs:
#   1. the tray program (packaging\windows\tray\VocalisSatelliteTray.csproj) is restored in locked mode, built in
#      Release and its unit tests run before anything is packed; a signed build signs the program before it is packed
#      (a copy, so an ordinary build later never packs a signed file);
#   2. the three icon files must exist (vocalis.ico, and the tray icon's grey and grey-with-a-mark looks that
#      make_icon.py writes), and so must every wizard picture the .iss names (also written by make_icon.py): the build
#      refuses clearly when one is missing;
#   3. -TestIdentity <word> builds a setup program with a different AppId, program folder, Run value, mutex, Start menu
#      group, default satellite folder and file name, for tests. It is refused together with signing.
#
# Unsigned (the default) is for test builds. A release build passes -Sign (or the three signing paths): every path is
# read from the git-ignored packaging\windows\signing.local.json, never from the repository. See README.md here.
[CmdletBinding()]
param(
    # name@sha256:<64 hex>, the same rule as satellite-setup.ps1 and the main installer's references.
    [Parameter(Mandatory)] [string] $SatelliteImage,
    # Test builds only: a lowercase word (letters and digits). Every name the program shares with a real install changes.
    [string] $TestIdentity = '',
    [string] $OutputDirectory = '..\..\artifacts\windows',
    # Release build: sign the tray program, Setup and its uninstaller with Azure Artifact Signing. Missing paths are
    # read from signing.local.json beside this script ({"signToolPath": ..., "dlibPath": ..., "metadataPath": ...}).
    [switch] $Sign,
    [string] $SignToolPath,
    [string] $DlibPath,
    [string] $MetadataPath
)

$ErrorActionPreference = 'Stop'

# The same rule as validate_digest_ref in setup.sh and build-installer.ps1: [[ "$1" =~ ^[^[:space:]]+@sha256:[a-fA-F0-9]{64}$ ]].
# \z rather than $ so that a trailing newline does not slip through (bash's $ does not match before one).
# (These helpers are copied from build-installer.ps1, which runs its whole main flow when dot-sourced, so they cannot
# be shared; packaging/tests/test_satellite_windows_installer.py proves the two copies agree.)
$DigestReferencePattern = '^[^\s]+@sha256:[a-fA-F0-9]{64}\z'
# The version rule of design amendment 2: major.minor.patch with an optional -M<n> milestone suffix.
$VersionPattern = '^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(-M\d{1,9})?\z'
# A test identity is one lowercase word: it becomes part of an AppId seed, a folder name, a value name and a file name.
$TestIdentityPattern = '^[a-z0-9]{1,16}\z'
# The icon files the setup program installs and names (the tray program shows the other two as its stopped looks).
$IconFileNames = @('vocalis.ico', 'vocalis-satellite-stopped.ico', 'vocalis-satellite-nodocker.ico')

# The wizard's own pictures, named by the .iss (WizardSmallImageFile and WizardImageFile): the Vocalis V, drawn by
# make_icon.py, so no Inno stock picture is left in the wizard (October 11, 2026). The .iss holds the
# one list; this reads it so the build can name a missing file and what writes it, instead of the compiler's own error.
function Get-WizardPictureNames {
    param([string]$IssPath)
    $Names = @()
    foreach ($Line in (Get-Content -LiteralPath $IssPath)) {
        $Found = [regex]::Match($Line, '^\s*(WizardSmallImageFile|WizardImageFile)\s*=\s*(.+?)\s*$')
        if ($Found.Success) {
            foreach ($Item in ($Found.Groups[2].Value -split ',')) { $Names += $Item.Trim() }
        }
    }
    return $Names
}

function Test-DigestReference {
    param([string]$Reference)
    return ($Reference -cmatch $DigestReferencePattern)
}

# Docker's own rule for the registry host of a reference: the part before the first '/' is a host only when it
# is "localhost" or contains '.' or ':'. Returns the host, or $null for a reference with no registry host
# (a locally built image answers to a bare name such as vocalis-satellite@sha256:<image id>).
function Get-ImageRegistryHost {
    param([string]$Reference)
    $At = $Reference.IndexOf('@')
    $Name = if ($At -ge 0) { $Reference.Substring(0, $At) } else { $Reference }
    $Slash = $Name.IndexOf('/')
    if ($Slash -lt 1) { return $null }
    $First = $Name.Substring(0, $Slash)
    if ($First -ceq 'localhost' -or $First.Contains('.') -or $First.Contains(':')) { return $First }
    return $null
}

# A signed release build must name a published image: a registry host that is not this machine.
# Returns a problem description, or $null when the reference is acceptable for a release.
function Get-PublishedReferenceProblem {
    param([string]$Reference)
    $RegistryHost = Get-ImageRegistryHost $Reference
    if (-not $RegistryHost) { return "'$Reference' has no registry host (a locally built image); a signed release build needs an image reference on a registry." }
    $HostName = ($RegistryHost -replace ':\d+$', '').ToLowerInvariant()
    if ($HostName -eq 'localhost' -or $HostName.EndsWith('.localhost') -or $HostName -eq '127.0.0.1' -or $HostName -eq '[::1]') {
        return "'$Reference' names a registry on this machine ($RegistryHost); a signed release build needs an image reference on a published registry."
    }
    return $null
}

# The sha256:<hex> part of a validated reference.
function Get-ReferenceDigest {
    param([string]$Reference)
    return $Reference.Substring($Reference.IndexOf('@') + 1).ToLowerInvariant()
}

function Get-VocalisVersion {
    param([string]$TtsUtilsPath)
    $Text = [IO.File]::ReadAllText($TtsUtilsPath)
    $Found = [regex]::Match($Text, '(?m)^VERSION\s*=\s*"([^"]+)"')
    if (-not $Found.Success) { throw "Could not find VERSION in $TtsUtilsPath." }
    $Version = $Found.Groups[1].Value
    if ($Version -cnotmatch $VersionPattern) { throw "VERSION '$Version' in $TtsUtilsPath is not major.minor.patch with an optional -M<n> suffix." }
    return $Version
}

# 12.0.0-M1 -> 12.0.0.0 (the numeric part plus a fourth zero; the milestone lives in AppVersion).
function Get-VersionInfoVersion {
    param([string]$Version)
    $Found = [regex]::Match($Version, $VersionPattern)
    if (-not $Found.Success) { throw "Invalid version: $Version" }
    return '{0}.{1}.{2}.0' -f $Found.Groups[1].Value, $Found.Groups[2].Value, $Found.Groups[3].Value
}

# The AppId of a test build, derived from the word so that a rebuild with the same word is the same identity and a
# different word never is. It is formatted like a GUID, upper case, and can never equal the real program's AppId
# because it comes from a hash of a different seed.
function Get-TestIdentityGuid {
    param([string]$Word)
    $Sha = [Security.Cryptography.SHA256]::Create()
    try { $Bytes = $Sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("vocalis-satellite-test-identity:$Word")) } finally { $Sha.Dispose() }
    $Hex = ([BitConverter]::ToString($Bytes) -replace '-', '').Substring(0, 32)
    return ('{0}-{1}-{2}-{3}-{4}' -f $Hex.Substring(0, 8), $Hex.Substring(8, 4), $Hex.Substring(12, 4), $Hex.Substring(16, 4), $Hex.Substring(20, 12))
}

function ConvertTo-ArgumentString {
    param([string[]]$Arguments)
    $Parts = foreach ($Argument in $Arguments) {
        if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { $Argument }
        else { '"' + (($Argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }
    $Parts -join ' '
}

# -OutputDirectory is relative to this script by default; an absolute one is used as given. Join-Path would glue
# an absolute path onto the script folder (seen October 9, 2026: 'packaging\windows\<absolute path>'); Combine does not.
function Resolve-OutputRoot([string]$Base, [string]$Directory) {
    return [IO.Path]::GetFullPath([IO.Path]::Combine($Base, $Directory))
}

# The files the setup program copies, read from the [Files] section of the .iss so that one list serves the setup
# program and the manifest. Entries flagged dontcopy are only extracted to {tmp} at wizard time and are not installed.
# {#TrayExe} is the tray program the build packs ($TrayExePath); {srcexe} is the setup program itself (its own copy,
# whose hash the caller fills in once the program exists). Returns Source (as written), FullPath (null for the
# setup program itself) and InstalledAs.
function Get-SatelliteIssPackagedFiles {
    param([string]$IssPath, [string]$TrayExePath)
    $IssDirectory = Split-Path -Parent $IssPath
    $Section = ''
    foreach ($Line in (Get-Content -LiteralPath $IssPath)) {
        if ($Line -match '^\s*\[(\w+)\]\s*$') { $Section = $Matches[1]; continue }
        if ($Section -ne 'Files') { continue }
        if ($Line -notmatch '^\s*Source:\s*"([^"]+)"') { continue }
        $Source = $Matches[1]
        if ($Line -match '(?i)\bdontcopy\b') { continue }
        $InstalledAs = if ($Line -match 'DestName:\s*"([^"]+)"') { $Matches[1] } else { Split-Path -Leaf $Source }
        if ($Source -eq '{srcexe}') {
            $FullPath = $null
        } elseif ($Source -eq '{#TrayExe}') {
            $FullPath = $TrayExePath
        } else {
            $FullPath = [IO.Path]::GetFullPath((Join-Path $IssDirectory $Source))
        }
        [pscustomobject]@{ Source = $Source; FullPath = $FullPath; InstalledAs = $InstalledAs }
    }
}

# Runs a dotnet command, writing its output through, and refuses on a non-zero exit. The step is timed and named in the
# log, so a failure says which one and how long it ran.
function Invoke-DotNet {
    param([string]$Step, [string[]]$Arguments)
    $Started = [Diagnostics.Stopwatch]::StartNew()
    Write-Output "$Step : dotnet $($Arguments -join ' ')"
    & dotnet @Arguments
    $Code = $LASTEXITCODE
    Write-Output ("{0} : exit code {1} after {2} s." -f $Step, $Code, $Started.Elapsed.TotalSeconds.ToString('0.0'))
    if ($Code -ne 0) { throw "$Step failed (dotnet exit code $Code); see the output above." }
}

# ---- Main flow. Dot-sourcing for tests loads only the functions above (they extract them by name). ----
$Watch = [Diagnostics.Stopwatch]::StartNew()
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$PackagingRoot = Join-Path $RepoRoot 'packaging'
$IssPath = Join-Path $PSScriptRoot 'vocalis-satellite.iss'
$BuildProject = Join-Path $PSScriptRoot 'Vocalis.InstallerBuild.csproj'
$TrayProjectDirectory = Join-Path $PSScriptRoot 'tray'
$TrayProject = Join-Path $TrayProjectDirectory 'VocalisSatelliteTray.csproj'
$TrayTestsDirectory = Join-Path $TrayProjectDirectory 'tests'
$TrayExe = Join-Path $TrayProjectDirectory 'bin\Release\net48\VocalisSatelliteTray.exe'
$SigningConfigPath = Join-Path $PSScriptRoot 'signing.local.json'
$OutputRoot = Resolve-OutputRoot $PSScriptRoot $OutputDirectory

# Signing inputs: explicit parameters win; -Sign fills the rest from the ignored local file.
if ($Sign) {
    if (-not (Test-Path -LiteralPath $SigningConfigPath -PathType Leaf)) {
        throw "-Sign needs the git-ignored $SigningConfigPath with signToolPath, dlibPath and metadataPath (see README.md)."
    }
    $Config = Get-Content -LiteralPath $SigningConfigPath -Raw | ConvertFrom-Json
    if (-not $SignToolPath) { $SignToolPath = [string]$Config.signToolPath }
    if (-not $DlibPath) { $DlibPath = [string]$Config.dlibPath }
    if (-not $MetadataPath) { $MetadataPath = [string]$Config.metadataPath }
}
$SigningValues = @($SignToolPath, $DlibPath, $MetadataPath)
$SignedBuild = @($SigningValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -gt 0
if ($SignedBuild -and @($SigningValues | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    throw 'Signed builds require all three of SignToolPath, DlibPath and MetadataPath (parameters or signing.local.json).'
}
# A test identity is for automated tests of the setup program on a computer that may hold a real install. A signed
# program is a release; a signed program with a test identity would be a release nobody should install.
if ($TestIdentity -and $SignedBuild) {
    throw '-TestIdentity builds are for tests and are never signed: do not combine -TestIdentity with -Sign or the signing paths.'
}
if ($TestIdentity -and $TestIdentity -cnotmatch $TestIdentityPattern) {
    throw "-TestIdentity must be one lowercase word of 1 to 16 letters and digits (matching $TestIdentityPattern); got '$TestIdentity'."
}
if ($SignedBuild) {
    foreach ($Path in $SigningValues) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required signing file is missing: $Path" }
    }
    $SignToolPath = [IO.Path]::GetFullPath($SignToolPath)
    $DlibPath = [IO.Path]::GetFullPath($DlibPath)
    $MetadataPath = [IO.Path]::GetFullPath($MetadataPath)
}
Write-Output "Build mode: $(if ($SignedBuild) { 'signed release' } elseif ($TestIdentity) { "unsigned test build, identity '$TestIdentity'" } else { 'unsigned (test build)' })."

# Image reference: same rule as the main installer; a release names a published image; a local reference must be the
# image the local Docker holds under that ID (the containerd image store answers to <name>@sha256:<image id>).
if (-not (Test-DigestReference $SatelliteImage)) {
    throw "-SatelliteImage must be name@sha256:<64 hex digits> (the same rule as satellite-setup.ps1); got '$SatelliteImage'."
}
if ($SignedBuild) {
    $Problem = Get-PublishedReferenceProblem $SatelliteImage
    if ($Problem) { throw "-SatelliteImage: $Problem" }
    Write-Output "SatelliteImage: $SatelliteImage (registry $(Get-ImageRegistryHost $SatelliteImage))."
} elseif (Get-ImageRegistryHost $SatelliteImage) {
    Write-Output "SatelliteImage: $SatelliteImage (names a registry host; not checked against the local Docker)."
} else {
    $Docker = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $Docker) { throw "-SatelliteImage is a local reference, so docker.exe is needed to check it, and it was not found on PATH." }
    $Inspected = (& $Docker.Source image inspect --format '{{.Id}}' $SatelliteImage 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "-SatelliteImage: docker image inspect failed for '$SatelliteImage': $Inspected" }
    $Expected = Get-ReferenceDigest $SatelliteImage
    if ($Inspected -cne $Expected) { throw "-SatelliteImage: the local image '$SatelliteImage' has ID '$Inspected', not '$Expected'." }
    Write-Output "SatelliteImage: $SatelliteImage resolves locally to that exact image ID."
}

$Version = Get-VocalisVersion (Join-Path $RepoRoot 'source\vocalis\src\tts_utils.py')
$VersionInfo = Get-VersionInfoVersion $Version
$BaseName = "Vocalis-Satellite-Setup-$Version-x64"
if ($TestIdentity) { $BaseName = "$BaseName-test-$TestIdentity" }
Write-Output "Version $Version (file version $VersionInfo)."

# The icons: Doug, October 11, 2026, "Don't forget to use the correct icon in the setup and the system tray." The setup
# icon, the uninstall entry and every shortcut name vocalis.ico; the tray program draws the other two looks.
foreach ($Name in $IconFileNames) {
    $IconPath = Join-Path $PSScriptRoot $Name
    if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
        throw "Icon file is missing: $IconPath. make_icon.py writes vocalis.ico and the tray icon's two other looks (vocalis-satellite-stopped.ico, vocalis-satellite-nodocker.ico); the setup program cannot be built without all three."
    }
    Write-Output "Icon: $Name ($((Get-Item -LiteralPath $IconPath).Length) bytes)."
}

$WizardPictures = @(Get-WizardPictureNames $IssPath)
if ($WizardPictures.Count -eq 0) {
    throw "$IssPath names no wizard pictures (WizardSmallImageFile, WizardImageFile): Inno Setup's own stock pictures would be shown."
}
foreach ($PictureName in $WizardPictures) {
    $PicturePath = Join-Path $PSScriptRoot $PictureName
    if (-not (Test-Path -LiteralPath $PicturePath -PathType Leaf)) {
        throw "Wizard picture is missing: $PicturePath. make_icon.py writes the wizard pictures (vocalis-wizard-small-<n>.png and vocalis-wizard-large-<w>x<h>.png) beside it; the setup program cannot be built without them."
    }
}
Write-Output "Wizard pictures: $($WizardPictures.Count) files, all present."

# The files the .iss packages other than the tray program (which is built below).
$Packaged = @(Get-SatelliteIssPackagedFiles $IssPath $TrayExe)
if ($Packaged.Count -eq 0) { throw "No installed files were found in the [Files] section of $IssPath." }
foreach ($File in $Packaged) {
    if ($File.FullPath -and -not (Test-Path -LiteralPath $File.FullPath -PathType Leaf) -and $File.Source -ne '{#TrayExe}') {
        throw "Packaged file is missing: $($File.FullPath)"
    }
}
foreach ($Extracted in @('..\satellite\satellite-setup.ps1', 'vocalis-control.ps1', '..\windows-compose.ps1')) {
    $ExtractedPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Extracted))
    if (-not (Test-Path -LiteralPath $ExtractedPath -PathType Leaf)) { throw "Wizard-time file is missing: $ExtractedPath" }
}

# The tray program: locked restore, Release build, then its unit tests. Nothing is packed if any of that fails.
if (-not (Test-Path -LiteralPath $TrayProject -PathType Leaf)) {
    throw "The tray project is missing: $TrayProject (it is built into VocalisSatelliteTray.exe, which the setup program installs)."
}
Invoke-DotNet 'Tray restore' @('restore', $TrayProject, '--locked-mode', '--verbosity', 'minimal')
# The tray program's assembly version stays 1.0.0 unless it is given one: it gets the numeric part of the product
# version (12.0.0 for 12.0.0-M1), the same number the setup program's file version starts with.
$TrayVersion = $Version -replace '-M\d+$', ''
Invoke-DotNet 'Tray build' @('build', $TrayProject, '-c', 'Release', '--no-restore', "-p:Version=$TrayVersion", '--verbosity', 'minimal')
if (-not (Test-Path -LiteralPath $TrayExe -PathType Leaf)) { throw "The tray build did not produce $TrayExe." }
$TestProjects = @(Get-ChildItem -LiteralPath $TrayTestsDirectory -Filter '*.csproj' -File -ErrorAction SilentlyContinue)
if ($TestProjects.Count -ne 1) {
    throw "Expected exactly one tray test project in $TrayTestsDirectory; found $($TestProjects.Count)."
}
Invoke-DotNet 'Tray test restore' @('restore', $TestProjects[0].FullName, '--locked-mode', '--verbosity', 'minimal')
Invoke-DotNet 'Tray tests' @('test', $TestProjects[0].FullName, '-c', 'Release', '--no-restore', '--verbosity', 'minimal')
Write-Output "Tray program: $TrayExe ($((Get-Item -LiteralPath $TrayExe).Length) bytes)."

& dotnet restore $BuildProject --locked-mode --verbosity minimal
if ($LASTEXITCODE -ne 0) { throw 'Could not restore the pinned project-local Inno Setup compiler package in locked mode.' }
$CompilerOutput = & dotnet msbuild $BuildProject -getProperty:InnoSetupCompiler
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the pinned Inno Setup compiler path.' }
$Compiler = ($CompilerOutput | Out-String).Trim()
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw "Pinned Inno Setup compiler is missing: $Compiler" }

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$OutputFile = Join-Path $OutputRoot "$BaseName.exe"
$ManifestFile = "$OutputFile.files.json"
$HashFile = "$OutputFile.sha256"
foreach ($Path in @($OutputFile, $ManifestFile, $HashFile)) {
    if (Test-Path -LiteralPath $Path) { throw "Refusing to overwrite existing package artifact: $Path" }
}

$TempRoot = $null
$MarkerPath = $null
$OwnerMarker = [guid]::NewGuid().ToString('N')
try {
    $PackedTrayExe = $TrayExe
    $Environment = [ordered]@{
        VOCALIS_SATELLITE_VERSION = $Version
        VOCALIS_SATELLITE_VERSION_INFO = $VersionInfo
        VOCALIS_SATELLITE_IMAGE = $SatelliteImage
        VOCALIS_SATELLITE_TEST_IDENTITY = $TestIdentity
        VOCALIS_SATELLITE_TEST_GUID = $(if ($TestIdentity) { Get-TestIdentityGuid $TestIdentity } else { '' })
    }
    $Arguments = @("/O$OutputRoot", "/F$BaseName")
    if ($SignedBuild) {
        # The Vocalis-owned PE files are the tray program, Setup and its uninstaller. The tray program is signed
        # here, as a copy, before it is packed; Inno signs Setup and the uninstaller (SignedUninstaller) through this
        # command, and the verify below checks the signature, the signer and the timestamp of each.
        $TempRoot = Join-Path ([IO.Path]::GetTempPath()) "Vocalis.Packaging-WindowsBuild-$([guid]::NewGuid().ToString('N'))"
        $MarkerPath = Join-Path $TempRoot '.owner'
        New-Item -ItemType Directory -Path $TempRoot | Out-Null
        Set-Content -LiteralPath $MarkerPath -Value $OwnerMarker -NoNewline
        $SignedUninstallerDir = Join-Path $TempRoot 'signed-uninstaller'
        New-Item -ItemType Directory -Path $SignedUninstallerDir | Out-Null
        $SigningHelper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Invoke-WindowsArtifactSigning.ps1'))
        $PackedTrayExe = Join-Path $TempRoot 'VocalisSatelliteTray.exe'
        Copy-Item -LiteralPath $TrayExe -Destination $PackedTrayExe
        & $SigningHelper -Action Sign -SignToolPath $SignToolPath -DlibPath $DlibPath -MetadataPath $MetadataPath -Files @($PackedTrayExe)
        if ($LASTEXITCODE -ne 0) { throw 'Signing the tray program failed.' }
        $PowerShellExe = [IO.Path]::GetFullPath((Join-Path $PSHOME 'powershell.exe'))
        if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) { $PowerShellExe = [IO.Path]::GetFullPath((Join-Path $PSHOME 'pwsh.exe')) }
        if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) { throw 'Could not locate PowerShell to run the Inno signing callback.' }
        $Environment.VOCALIS_SATELLITE_SIGNED_BUILD = '1'
        $Environment.VOCALIS_SATELLITE_SIGNED_UNINSTALLER_DIR = $SignedUninstallerDir
        # Inno expands $q to a quote and $f to the file, and reads $$ as a literal dollar sign.
        $ForInno = { param($Text) $Text.Replace('$', '$$') }
        $SignCommand = '$q' + (& $ForInno $PowerShellExe) + '$q -NoProfile -File $q' + (& $ForInno $SigningHelper) +
            '$q -Action Sign -SignToolPath $q' + (& $ForInno $SignToolPath) + '$q -DlibPath $q' + (& $ForInno $DlibPath) +
            '$q -MetadataPath $q' + (& $ForInno $MetadataPath) + '$q -Files $f'
        $Arguments += "/Sazurecodesign=$SignCommand"
    }
    $Environment.VOCALIS_SATELLITE_TRAY_EXE = $PackedTrayExe
    $Arguments += $IssPath

    $StartInfo = New-Object Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $Compiler
    $StartInfo.Arguments = ConvertTo-ArgumentString $Arguments
    $StartInfo.WorkingDirectory = $PSScriptRoot
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    foreach ($Name in $Environment.Keys) { $StartInfo.EnvironmentVariables[$Name] = [string]$Environment[$Name] }
    $Process = [Diagnostics.Process]::Start($StartInfo)
    if ($null -eq $Process) { throw 'Could not start the pinned Inno Setup compiler.' }
    $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
    $StderrTask = $Process.StandardError.ReadToEndAsync()
    $CompilerPid = $Process.Id
    $CompilerStarted = $Process.StartTime.ToUniversalTime()
    if (-not $Process.WaitForExit(180000)) {
        $Running = Get-Process -Id $CompilerPid -ErrorAction Stop
        if ($Running.StartTime.ToUniversalTime() -ne $CompilerStarted -or
            [IO.Path]::GetFullPath($Running.Path) -ne [IO.Path]::GetFullPath($Compiler)) {
            throw 'Timed-out compiler identity changed; refusing to stop it.'
        }
        & taskkill.exe /T /F /PID $CompilerPid *> $null
        if (-not $Process.WaitForExit(10000)) { throw 'Owned Inno Setup compiler process tree did not exit.' }
        throw 'Inno Setup compilation exceeded 180 seconds.'
    }
    $CompilerExitCode = $Process.ExitCode
    $CompilerStdout = $StdoutTask.GetAwaiter().GetResult()
    $CompilerStderr = $StderrTask.GetAwaiter().GetResult()
    $Process.Dispose()
    if ($CompilerExitCode -ne 0) { throw "Inno Setup returned exit code $CompilerExitCode. Output: $CompilerStdout $CompilerStderr" }
    if (-not (Test-Path -LiteralPath $OutputFile -PathType Leaf)) { throw "Inno Setup did not produce the expected setup program: $OutputFile" }

    # The compiler's own parse of vocalis-satellite.iss is the .iss check: a warning is a defect to fix, not noise.
    $Warnings = @(($CompilerStdout + "`n" + $CompilerStderr) -split "[\r\n]+" | Where-Object { $_ -match '(?i)\bwarning\b' })
    foreach ($Line in $Warnings) { Write-Output "ISCC: $Line" }
    if ($Warnings.Count -gt 0) {
        Remove-Item -LiteralPath $OutputFile
        throw "Inno Setup reported $($Warnings.Count) warning(s) compiling vocalis-satellite.iss (listed above); the setup program was removed. Fix the script."
    }
    Write-Output "Inno Setup compiled vocalis-satellite.iss with no warnings ($($Watch.Elapsed.TotalSeconds.ToString('0.0')) s so far)."

    if ($SignedBuild) {
        & (Join-Path $PSScriptRoot 'Invoke-WindowsArtifactSigning.ps1') -Action Verify `
            -SignToolPath $SignToolPath -DlibPath $DlibPath -MetadataPath $MetadataPath -Files @($OutputFile, $PackedTrayExe)
        if ($LASTEXITCODE -ne 0) { throw 'Setup signature verification failed.' }
    }

    $Hash = (Get-FileHash -LiteralPath $OutputFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $Entries = foreach ($File in $Packaged) {
        if ($File.FullPath) {
            # The tray program that was packed (a signed copy in a release build), not the unsigned build output.
            $Path = if ($File.Source -eq '{#TrayExe}') { $PackedTrayExe } else { $File.FullPath }
            $Item = Get-Item -LiteralPath $Path
            [pscustomobject]@{
                path = $File.InstalledAs
                length = $Item.Length
                sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } else {
            # The installed copy of the setup program is the setup program.
            [pscustomobject]@{ path = $File.InstalledAs; length = (Get-Item -LiteralPath $OutputFile).Length; sha256 = $Hash }
        }
    }
    $Manifest = [pscustomobject]@{
        version = $Version
        installer = "$BaseName.exe"
        signed = $SignedBuild
        testIdentity = $TestIdentity
        satelliteImage = $SatelliteImage
        files = @($Entries)
    }
    [IO.File]::WriteAllText($ManifestFile, ($Manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Set-Content -LiteralPath $HashFile -Value "$Hash *$(Split-Path -Leaf $OutputFile)" -Encoding ascii
    Write-Output "Built $OutputFile ($((Get-Item -LiteralPath $OutputFile).Length) bytes) for Vocalis $Version."
    Write-Output "Manifest: $ManifestFile"
    Write-Output "SHA-256: $Hash"
}
finally {
    if ($TempRoot -and (Test-Path -LiteralPath $TempRoot)) {
        $CanonicalTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $CanonicalRoot = [IO.Path]::GetFullPath($TempRoot)
        if (-not $CanonicalRoot.StartsWith($CanonicalTemp, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Split-Path -Leaf $CanonicalRoot).StartsWith('Vocalis.Packaging-WindowsBuild-', [StringComparison]::Ordinal) -or
            -not (Test-Path -LiteralPath $MarkerPath -PathType Leaf) -or
            (Get-Content -LiteralPath $MarkerPath -Raw) -ne $OwnerMarker) {
            throw "Refusing to remove a Windows package build temp root without its ownership marker: $CanonicalRoot"
        }
        Remove-Item -LiteralPath $CanonicalRoot -Recurse
        if (Test-Path -LiteralPath $CanonicalRoot) { throw "Windows package build cleanup failed: $CanonicalRoot" }
    }
}
