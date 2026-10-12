# Control script installed beside setup.ps1 by the Vocalis Windows installer. Keep this file ASCII:
# Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
#
# It is used only by the installer and its shortcuts. Every decision about roots, identity, images,
# ports and owners stays in setup.sh (reached through setup.ps1); this script only
#   start            runs the ownership pass, then brings this instance's two services up
#                    (`compose up -d --no-build --pull never`)
#   stop             stops them (`compose stop`)
#   down             removes this instance's containers (`compose down`, never -v: the stores are bind mounts)
#   repair           reruns setup.ps1 for the saved instance (design amendments 2 and 3; see Get-RepairPlan)
#   compare-version  tells the installer how its version orders against the installed one (amendment 2)
# Compose runs from Windows through docker.exe (design amendment 15, October 10, 2026, which supersedes the wsl.exe
# invocation of amendment 10), via windows-compose.ps1 beside this script: project vocalis-<INSTANCE_ID>,
# --env-file <root>\instance.env, the base file plus the GPU overlay beside this script, and INSTANCE_ROOT spelled as a
# Windows path (E:/...) derived from instance.env's own /mnt/<drive> root, so the containers' bind sources are Windows
# paths and Docker Desktop can restart them by itself. wsl.exe is not used here, and `start` is the quick retry when
# the services did not come back. The installer extracts windows-compose.ps1 beside this script in {tmp} for
# compare-version.
#
# Everything it needs about the install is in installer-state.json beside this script (written by the
# installer: root, variant, baked image references, ports, version). Passwords never pass through here.
#
# Exit codes:
#     0  success
#     1  the action failed, including an ownership pass or a Compose call that failed or timed out (the reason and
#        the Compose output are printed)
#    20  Docker is not running or not installed (docker.exe is missing or `docker info` does not answer), so
#        nothing was done
#    21  installer-state.json or instance.env is missing for an action that needs it, or instance.env's root
#        cannot be derived as a Windows folder or does not match the folder it was read from (refused before any
#        Docker call)
#    40  compare-version: the installed version is lower than the installer's (an upgrade)
#    41  compare-version: the same version (a repair)
#    42  compare-version: the installed version is higher (the installer refuses; no automatic rollback)
#    43  compare-version: a version string is not major.minor.patch[-M<n>]
#   repair passes through the exit code of setup.ps1 (10 through 19, or setup.sh's own).
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('start', 'stop', 'down', 'repair', 'compare-version')]
    [string]$Action,
    [string]$InstalledVersion,
    [string]$NewVersion,
    # No waits and no prompts: the uninstaller runs `down` hidden with this.
    [switch]$NoPause,
    # repair only: wait for Enter after a successful run too, so the Repair shortcut's window stays readable.
    [switch]$PauseAtEnd
)

$ErrorActionPreference = 'Stop'

# ConvertTo-ArgumentString, Invoke-Bounded, Read-InstanceEnv and the Windows docker.exe compose invocation (the
# ownership pass and `up` are bounded there, by $OwnershipPassSeconds and $ComposeUpSeconds) live in
# windows-compose.ps1, beside this script wherever it runs: the install folder, or {tmp} for compare-version.
$WindowsComposeHelper = Join-Path $PSScriptRoot 'windows-compose.ps1'
if (-not (Test-Path -LiteralPath $WindowsComposeHelper -PathType Leaf)) {
    Write-Host "ERROR: windows-compose.ps1 must be in the same folder as vocalis-control.ps1 ($PSScriptRoot); it was not found." -ForegroundColor Red
    exit 1
}
. $WindowsComposeHelper

# Bounds, in seconds.
$DockerProbeSeconds = 30
$StopSeconds = 120

# Version order (design amendment 2): the numeric major.minor.patch first, then the milestone suffix, where
# -M1 < -M2 < ... < no suffix (a final release is above all its milestones). Returns the four-part key
# (major, minor, patch, milestone; no suffix is the largest milestone), or $null for anything else.
function ConvertTo-VocalisVersionKey {
    param([string]$Version)
    if ($Version -cnotmatch '^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-M(\d{1,9}))?\z') { return $null }
    $Milestone = if ($Matches[4]) { [long]$Matches[4] } else { [long]::MaxValue }
    ,@([long]$Matches[1], [long]$Matches[2], [long]$Matches[3], $Milestone)
}

# -1 when $A orders below $B, 0 when equal, 1 when above, $null when either string is not a version.
function Compare-VocalisVersion {
    param([string]$A, [string]$B)
    $KeyA = ConvertTo-VocalisVersionKey $A
    $KeyB = ConvertTo-VocalisVersionKey $B
    if ($null -eq $KeyA -or $null -eq $KeyB) { return $null }
    for ($Index = 0; $Index -lt 4; $Index++) {
        if ($KeyA[$Index] -lt $KeyB[$Index]) { return -1 }
        if ($KeyA[$Index] -gt $KeyB[$Index]) { return 1 }
    }
    return 0
}

# installer-state.json: version, root, variant, vocalisImage, taproomImage, vocalisPort, taproomPort, and
# optionally seedModels (October 9, 2026): the previous data folder whose verified model files setup may copy
# instead of downloading them again. Only the first seven are required.
function Read-InstallerState {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "The installer state file is missing: $Path" }
    $State = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($Name in 'version', 'root', 'variant', 'vocalisImage', 'taproomImage', 'vocalisPort', 'taproomPort') {
        if ($null -eq $State.$Name -or "$($State.$Name)" -eq '') { throw "The installer state file has no value for '$Name': $Path" }
    }
    $State
}

# Rerun versus update, decided from the saved instance (design amendments 2 and 3). $EnvValues is the parsed
# instance.env, or $null when the file is absent. Returns Mode, Description and the setup.ps1 parameters.
#   instance.env absent                  -> the full first-install arguments (a first run that failed before
#                                           writing it), including the baked references and the ports;
#   its images equal the baked ones      -> a plain rerun, -Root only (repair/resume);
#   its images differ from the baked ones-> -Update with the baked references, -Root; never ports (they are
#                                           fixed for an existing instance, and setup.sh refuses a change).
# Always -NoBrowser (the installer's Finish page and the shortcuts open the plain address) and
# -PauseOnFailure (the console must not close before the reason can be read). When installer-state.json
# records seedModels (a different data folder was chosen and the previous one holds models), every mode also
# passes -SeedModels so setup.ps1 offers that folder to the model fetch; setup.sh skips it if it is gone.
function Get-RepairPlan {
    param($State, $EnvValues)
    $Parameters = [ordered]@{ Root = [string]$State.root; NoBrowser = $true; PauseOnFailure = $true }
    if ($State.seedModels -and "$($State.seedModels)".Trim()) { $Parameters.SeedModels = [string]$State.seedModels }
    if ($null -eq $EnvValues) {
        $Parameters.Variant = [string]$State.variant
        $Parameters.VocalisImage = [string]$State.vocalisImage
        $Parameters.TaproomImage = [string]$State.taproomImage
        $Parameters.VocalisPort = [int]$State.vocalisPort
        $Parameters.TaproomPort = [int]$State.taproomPort
        return [pscustomobject]@{ Mode = 'first'; Parameters = $Parameters; Description = 'No instance.env exists in the data folder yet: running the first-install setup.' }
    }
    $SameImages = ($EnvValues['VOCALIS_IMAGE'] -ceq [string]$State.vocalisImage) -and ($EnvValues['TAPROOM_IMAGE'] -ceq [string]$State.taproomImage)
    if ($SameImages) {
        return [pscustomobject]@{ Mode = 'rerun'; Parameters = $Parameters; Description = 'The saved instance already names this installer''s images: rerunning setup (finished downloads are kept).' }
    }
    $Parameters.Update = $true
    $Parameters.VocalisImage = [string]$State.vocalisImage
    $Parameters.TaproomImage = [string]$State.taproomImage
    [pscustomobject]@{ Mode = 'update'; Parameters = $Parameters; Description = 'The saved instance names different images: updating it to this installer''s images (root, identity and ports are kept).' }
}

# Waits for Enter (only when a person is at the console, never with -NoPause).
function Wait-ForEnter {
    param([string]$Message)
    if ($NoPause) { return }
    Write-Host ''
    Write-Host $Message -NoNewline
    [void][Console]::In.ReadLine()
}

# The compose actions: start, stop, down. Returns the exit code. Everything runs through windows-compose.ps1 (docker.exe
# from Windows, amendment 15). The call is built first, so an instance.env whose root cannot be derived (or belongs to
# another folder) is refused with 21 before any Docker call; then Docker itself is probed (20 means only "Docker is
# not running or not installed"). start also runs the ownership pass before `up`.
function Invoke-ComposeAction {
    param([string]$Verb, [string[]]$VerbArguments, [int]$TimeoutSeconds, [string]$Doing)
    $StatePath = Join-Path $PSScriptRoot 'installer-state.json'
    $State = Read-InstallerState $StatePath
    $EnvPath = Join-Path ([string]$State.root) 'instance.env'
    if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
        if ($Verb -eq 'down') {
            Write-Host "No instance.env exists in '$($State.root)', so there are no containers to remove."
            return 0
        }
        Write-Host "No instance.env exists in '$($State.root)'. Setup has not finished: run 'Repair setup' from the Start menu."
        return 21
    }
    try {
        $Call = Get-WindowsComposeCall -InstanceFolder ([string]$State.root) -Verb $VerbArguments
    } catch {
        Write-Host "Refusing to $Verb this instance from '$($State.root)': $($_.Exception.Message)"
        return 21
    }
    $Docker = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $Docker) {
        Write-Host 'Docker Desktop is not installed (docker.exe was not found); nothing was done.'
        return 20
    }
    $Info = Invoke-Bounded -FileName $Docker.Source -Arguments @('info') -TimeoutSeconds $DockerProbeSeconds
    if ($Info.TimedOut -or $Info.ExitCode -ne 0) {
        Write-Host "Docker is not running (docker info did not answer within $DockerProbeSeconds s or failed); nothing was done. Start Docker Desktop and try again."
        return 20
    }
    if ($Verb -eq 'start') {
        # The ownership pass, then `up`, both from Windows (Start-WindowsInstance in windows-compose.ps1).
        $Started = Start-WindowsInstance -InstanceFolder ([string]$State.root) -DockerPath $Docker.Source
        if ($Started.Success) { return 0 }
        Write-Host "The services could not be started. $($Started.Message)"
        if ($Started.Refused) { return 21 }
        return 1
    }
    Write-Host "$Doing instance $($Call.InstanceId) (docker compose $($VerbArguments -join ' '))..."
    $Run = Invoke-Bounded -FileName $Docker.Source -Arguments $Call.Arguments -TimeoutSeconds $TimeoutSeconds -Environment $Call.Environment
    if ($Run.TimedOut) {
        Write-Host "docker compose $Verb did not finish within $TimeoutSeconds s and was stopped."
        if ($Run.Output) { Write-Host $Run.Output }
        return 1
    }
    if ($Run.Output) { Write-Host $Run.Output }
    Write-Host "docker compose $Verb exited with code $($Run.ExitCode) after $($Run.Milliseconds) ms."
    if ($Run.ExitCode -ne 0) { return 1 }
    return 0
}

# The flow stays at script scope below the functions, so a test can load the functions alone.
$ExitCode = 1
try {
    switch ($Action) {
        'compare-version' {
            $Order = Compare-VocalisVersion $InstalledVersion $NewVersion
            if ($null -eq $Order) {
                Write-Host "Cannot order versions '$InstalledVersion' and '$NewVersion' (expected major.minor.patch with an optional -M<n> suffix)."
                $ExitCode = 43
            } elseif ($Order -lt 0) {
                Write-Host "Installed $InstalledVersion is lower than ${NewVersion}: upgrade."
                $ExitCode = 40
            } elseif ($Order -eq 0) {
                Write-Host "Installed $InstalledVersion equals ${NewVersion}: repair."
                $ExitCode = 41
            } else {
                Write-Host "Installed $InstalledVersion is higher than ${NewVersion}: refusing (no automatic rollback)."
                $ExitCode = 42
            }
        }
        'start' {
            $ExitCode = Invoke-ComposeAction -Verb 'start' -VerbArguments @('up', '-d', '--no-build', '--pull', 'never') -TimeoutSeconds $ComposeUpSeconds -Doing 'Starting'
            if ($ExitCode -eq 0) { Write-Host 'Vocalis is started. Use the Vocalis and Taproom shortcuts to open the pages.' }
        }
        'stop' {
            $ExitCode = Invoke-ComposeAction -Verb 'stop' -VerbArguments @('stop') -TimeoutSeconds $StopSeconds -Doing 'Stopping'
            if ($ExitCode -eq 0) { Write-Host 'Vocalis is stopped.' }
        }
        'down' {
            $ExitCode = Invoke-ComposeAction -Verb 'down' -VerbArguments @('down') -TimeoutSeconds $StopSeconds -Doing 'Removing the containers of'
        }
        'repair' {
            $State = Read-InstallerState (Join-Path $PSScriptRoot 'installer-state.json')
            $EnvPath = Join-Path ([string]$State.root) 'instance.env'
            $EnvValues = if (Test-Path -LiteralPath $EnvPath -PathType Leaf) { Read-InstanceEnv $EnvPath } else { $null }
            $Plan = Get-RepairPlan -State $State -EnvValues $EnvValues
            Write-Host $Plan.Description
            $SetupParameters = $Plan.Parameters
            & (Join-Path $PSScriptRoot 'setup.ps1') @SetupParameters
            $ExitCode = [int]$LASTEXITCODE
            if ($ExitCode -eq 0 -and $PauseAtEnd) { Wait-ForEnter 'Setup finished. Press Enter to close this window.' }
        }
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $ExitCode = 1
    $FailedHere = $true
}
# setup.ps1 (run by repair) pauses on its own failures with -PauseOnFailure; a failure of this script itself
# (a missing state file, say) in a console the installer or a shortcut opened must not close unread either.
if ($ExitCode -ne 0 -and ($Action -in @('start', 'stop') -or ($Action -eq 'repair' -and $FailedHere))) {
    Wait-ForEnter "Exit code $ExitCode. Press Enter to close this window."
} elseif ($ExitCode -eq 0 -and $Action -in @('start', 'stop') -and -not $NoPause) {
    # Long enough to read the result line before the console closes.
    Start-Sleep -Seconds 3
}
exit $ExitCode
