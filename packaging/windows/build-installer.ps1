# Builds the per-user Vocalis Windows installer, Vocalis-Setup-<version>-x64.exe, with the pinned Inno Setup
# compiler (NuGet Tools.InnoSetup 6.7.3, restored in locked mode). Keep this file ASCII: it also runs in
# Windows PowerShell 5.1. Nothing here pushes, publishes or uploads an image or anything else (repository policy):
# the installer carries two image REFERENCES and no image bytes.
#
#   .\packaging\windows\build-installer.ps1 `
#       -VocalisImage 'vocalis-main-app-cuda@sha256:<64 hex>' -TaproomImage 'vocalis-g1-taproom@sha256:<64 hex>'
#
# Unsigned (the default) is for test builds. A release build passes -Sign (or the three signing paths):
# every path is read from the git-ignored packaging\windows\signing.local.json, never from the repository.
# See README.md in this folder.
[CmdletBinding()]
param(
    # Each is name@sha256:<64 hex>, the same rule as setup.sh's validate_digest_ref.
    [Parameter(Mandatory)] [string] $VocalisImage,
    [Parameter(Mandatory)] [string] $TaproomImage,
    [string] $OutputDirectory = '..\..\artifacts\windows',
    # Release build: sign Setup and its uninstaller with Azure Artifact Signing. Missing paths are read
    # from signing.local.json beside this script ({"signToolPath": ..., "dlibPath": ..., "metadataPath": ...}).
    [switch] $Sign,
    [string] $SignToolPath,
    [string] $DlibPath,
    [string] $MetadataPath
)

$ErrorActionPreference = 'Stop'

# The same rule as validate_digest_ref in setup.sh: [[ "$1" =~ ^[^[:space:]]+@sha256:[a-fA-F0-9]{64}$ ]].
# \z rather than $ so that a trailing newline does not slip through (bash's $ does not match before one).
$DigestReferencePattern = '^[^\s]+@sha256:[a-fA-F0-9]{64}\z'
# The version rule of design amendment 2: major.minor.patch with an optional -M<n> milestone suffix.
$VersionPattern = '^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(-M\d{1,9})?\z'

function Test-DigestReference {
    param([string]$Reference)
    return ($Reference -cmatch $DigestReferencePattern)
}

# Docker's own rule for the registry host of a reference: the part before the first '/' is a host only when it
# is "localhost" or contains '.' or ':'. Returns the host, or $null for a reference with no registry host
# (a locally built image answers to a bare name such as vocalis-main-app-cuda@sha256:<image id>).
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

# A signed release build must name published images: a registry host that is not this machine.
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

# setup.sh and the compose files run inside Linux: a CR byte (a CRLF checkout) breaks bash and YAML parsing.
function Assert-NoCarriageReturns {
    param([string[]]$Paths)
    foreach ($Path in $Paths) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required packaged file is missing: $Path" }
        $Bytes = [IO.File]::ReadAllBytes($Path)
        $Position = [Array]::IndexOf($Bytes, [byte]13)
        if ($Position -ge 0) {
            throw "$Path contains a carriage return (CR) byte at offset $Position. It runs inside WSL and must use LF line endings; check git's autocrlf setting and re-checkout the file."
        }
    }
}

# The files the installer copies, read from the [Files] section of the .iss so that one list serves the
# installer and the manifest. Entries flagged dontcopy are only extracted to {tmp} at wizard time and are
# not part of the installation. Returns Source (as written, relative to the .iss), FullPath and InstalledAs.
function Get-IssPackagedFiles {
    param([string]$IssPath)
    $IssDirectory = Split-Path -Parent $IssPath
    $Section = ''
    foreach ($Line in (Get-Content -LiteralPath $IssPath)) {
        if ($Line -match '^\s*\[(\w+)\]\s*$') { $Section = $Matches[1]; continue }
        if ($Section -ne 'Files') { continue }
        if ($Line -notmatch '^\s*Source:\s*"([^"]+)"') { continue }
        $Source = $Matches[1]
        if ($Line -match '(?i)\bdontcopy\b') { continue }
        $InstalledAs = if ($Line -match 'DestName:\s*"([^"]+)"') { $Matches[1] } else { Split-Path -Leaf $Source }
        [pscustomobject]@{ Source = $Source; FullPath = [IO.Path]::GetFullPath((Join-Path $IssDirectory $Source)); InstalledAs = $InstalledAs }
    }
}

# The file names of the wizard's own pictures, read from the .iss (WizardSmallImageFile and WizardImageFile, each a
# comma-separated list), so that one list serves the compiler and this check. They sit beside the .iss.
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

# ---- Main flow. Dot-sourcing for tests loads only the functions above (they extract them by name). ----
$Watch = [Diagnostics.Stopwatch]::StartNew()
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$PackagingRoot = Join-Path $RepoRoot 'packaging'
$IssPath = Join-Path $PSScriptRoot 'vocalis.iss'
$BuildProject = Join-Path $PSScriptRoot 'Vocalis.InstallerBuild.csproj'
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
if ($SignedBuild) {
    foreach ($Path in $SigningValues) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required signing file is missing: $Path" }
    }
    $SignToolPath = [IO.Path]::GetFullPath($SignToolPath)
    $DlibPath = [IO.Path]::GetFullPath($DlibPath)
    $MetadataPath = [IO.Path]::GetFullPath($MetadataPath)
}
Write-Output "Build mode: $(if ($SignedBuild) { 'signed release' } else { 'unsigned (test build)' })."

# Image references: same rule as setup.sh; a release names published images; a local reference must be the image
# the local Docker holds under that ID (the containerd image store answers to <name>@sha256:<image id>).
foreach ($Entry in @(@('VocalisImage', $VocalisImage), @('TaproomImage', $TaproomImage))) {
    if (-not (Test-DigestReference $Entry[1])) {
        throw "-$($Entry[0]) must be name@sha256:<64 hex digits> (the same rule as setup.sh); got '$($Entry[1])'."
    }
    if ($SignedBuild) {
        $Problem = Get-PublishedReferenceProblem $Entry[1]
        if ($Problem) { throw "-$($Entry[0]): $Problem" }
        Write-Output "$($Entry[0]): $($Entry[1]) (registry $(Get-ImageRegistryHost $Entry[1]))."
    } elseif (Get-ImageRegistryHost $Entry[1]) {
        Write-Output "$($Entry[0]): $($Entry[1]) (names a registry host; not checked against the local Docker)."
    } else {
        $Docker = Get-Command docker.exe -ErrorAction SilentlyContinue
        if (-not $Docker) { throw "-$($Entry[0]) is a local reference, so docker.exe is needed to check it, and it was not found on PATH." }
        $Inspected = (& $Docker.Source image inspect --format '{{.Id}}' $Entry[1] 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "-$($Entry[0]): docker image inspect failed for '$($Entry[1])': $Inspected" }
        $Expected = Get-ReferenceDigest $Entry[1]
        if ($Inspected -cne $Expected) { throw "-$($Entry[0]): the local image '$($Entry[1])' has ID '$Inspected', not '$Expected'." }
        Write-Output "$($Entry[0]): $($Entry[1]) resolves locally to that exact image ID."
    }
}

$Version = Get-VocalisVersion (Join-Path $RepoRoot 'source\vocalis\src\tts_utils.py')
$VersionInfo = Get-VersionInfoVersion $Version
$BaseName = "Vocalis-Setup-$Version-x64"
Write-Output "Version $Version (file version $VersionInfo)."

# The Linux-side files must be LF; the build refuses CR bytes.
Assert-NoCarriageReturns @(
    (Join-Path $PackagingRoot 'setup.sh'), (Join-Path $PackagingRoot 'compose.yaml'),
    (Join-Path $PackagingRoot 'compose.cuda.yaml'), (Join-Path $PackagingRoot 'compose.rocm.yaml'))

$Packaged = @(Get-IssPackagedFiles $IssPath)
if ($Packaged.Count -eq 0) { throw "No installed files were found in the [Files] section of $IssPath." }
foreach ($File in $Packaged) {
    if (-not (Test-Path -LiteralPath $File.FullPath -PathType Leaf)) { throw "Packaged file is missing: $($File.FullPath)" }
}

# The wizard's own pictures (WizardSmallImageFile and WizardImageFile in the .iss) are the Vocalis V, drawn by make_icon.py
# (October 11, 2026). They are compile-time inputs, not installed files. The .iss holds the one list.
$WizardPictures = @(Get-WizardPictureNames $IssPath)
if ($WizardPictures.Count -eq 0) {
    throw "$IssPath names no wizard pictures (WizardSmallImageFile, WizardImageFile): Inno Setup's own stock pictures would be shown."
}
foreach ($PictureName in $WizardPictures) {
    $PicturePath = Join-Path $PSScriptRoot $PictureName
    if (-not (Test-Path -LiteralPath $PicturePath -PathType Leaf)) {
        throw "Wizard picture is missing: $PicturePath. make_icon.py writes the wizard pictures (vocalis-wizard-small-<n>.png and vocalis-wizard-large-<w>x<h>.png) beside it; the installer cannot be built without them."
    }
}
Write-Output "Wizard pictures: $($WizardPictures.Count) files, all present."

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
    $Environment = [ordered]@{
        VOCALIS_INSTALLER_VERSION = $Version
        VOCALIS_INSTALLER_VERSION_INFO = $VersionInfo
        VOCALIS_INSTALLER_VOCALIS_IMAGE = $VocalisImage
        VOCALIS_INSTALLER_TAPROOM_IMAGE = $TaproomImage
    }
    $Arguments = @("/O$OutputRoot", "/F$BaseName")
    if ($SignedBuild) {
        # The shipped files are scripts, compose files and an icon, so the only Vocalis-owned PE files are Setup
        # and its uninstaller; Inno signs both (SignedUninstaller) through this command, and the verify below
        # checks the signature, the signer and the timestamp.
        $TempRoot = Join-Path ([IO.Path]::GetTempPath()) "Vocalis.Packaging-WindowsBuild-$([guid]::NewGuid().ToString('N'))"
        $MarkerPath = Join-Path $TempRoot '.owner'
        New-Item -ItemType Directory -Path $TempRoot | Out-Null
        Set-Content -LiteralPath $MarkerPath -Value $OwnerMarker -NoNewline
        $SignedUninstallerDir = Join-Path $TempRoot 'signed-uninstaller'
        New-Item -ItemType Directory -Path $SignedUninstallerDir | Out-Null
        $SigningHelper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Invoke-WindowsArtifactSigning.ps1'))
        $PowerShellExe = [IO.Path]::GetFullPath((Join-Path $PSHOME 'powershell.exe'))
        if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) { $PowerShellExe = [IO.Path]::GetFullPath((Join-Path $PSHOME 'pwsh.exe')) }
        if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) { throw 'Could not locate PowerShell to run the Inno signing callback.' }
        $Environment.VOCALIS_INSTALLER_SIGNED_BUILD = '1'
        $Environment.VOCALIS_INSTALLER_SIGNED_UNINSTALLER_DIR = $SignedUninstallerDir
        # Inno expands $q to a quote and $f to the file, and reads $$ as a literal dollar sign.
        $ForInno = { param($Text) $Text.Replace('$', '$$') }
        $SignCommand = '$q' + (& $ForInno $PowerShellExe) + '$q -NoProfile -File $q' + (& $ForInno $SigningHelper) +
            '$q -Action Sign -SignToolPath $q' + (& $ForInno $SignToolPath) + '$q -DlibPath $q' + (& $ForInno $DlibPath) +
            '$q -MetadataPath $q' + (& $ForInno $MetadataPath) + '$q -Files $f'
        $Arguments += "/Sazurecodesign=$SignCommand"
    }
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
    if (-not (Test-Path -LiteralPath $OutputFile -PathType Leaf)) { throw "Inno Setup did not produce the expected installer: $OutputFile" }

    # The compiler's own parse of vocalis.iss is the .iss check: a warning is a defect to fix, not noise.
    $Warnings = @(($CompilerStdout + "`n" + $CompilerStderr) -split "[\r\n]+" | Where-Object { $_ -match '(?i)\bwarning\b' })
    foreach ($Line in $Warnings) { Write-Output "ISCC: $Line" }
    if ($Warnings.Count -gt 0) {
        Remove-Item -LiteralPath $OutputFile
        throw "Inno Setup reported $($Warnings.Count) warning(s) compiling vocalis.iss (listed above); the installer was removed. Fix the script."
    }
    Write-Output "Inno Setup compiled vocalis.iss with no warnings ($($Watch.Elapsed.TotalSeconds.ToString('0.0')) s so far)."

    if ($SignedBuild) {
        & (Join-Path $PSScriptRoot 'Invoke-WindowsArtifactSigning.ps1') -Action Verify `
            -SignToolPath $SignToolPath -DlibPath $DlibPath -MetadataPath $MetadataPath -Files @($OutputFile)
        if ($LASTEXITCODE -ne 0) { throw 'Setup signature verification failed.' }
    }

    $Entries = foreach ($File in $Packaged) {
        $Item = Get-Item -LiteralPath $File.FullPath
        [pscustomobject]@{
            path = $File.InstalledAs
            length = $Item.Length
            sha256 = (Get-FileHash -LiteralPath $File.FullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $Manifest = [pscustomobject]@{
        version = $Version
        installer = "$BaseName.exe"
        signed = $SignedBuild
        vocalisImage = $VocalisImage
        taproomImage = $TaproomImage
        files = @($Entries)
    }
    [IO.File]::WriteAllText($ManifestFile, ($Manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    $Hash = (Get-FileHash -LiteralPath $OutputFile -Algorithm SHA256).Hash.ToLowerInvariant()
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
