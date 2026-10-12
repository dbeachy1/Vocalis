# Windows launcher for the shared Linux setup contract (packaging/setup.sh, run inside the default WSL
# distribution). Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
#
# Switches added for the Windows installer (design section 5, "Windows installer", review amendments):
#   -CheckOnly        Read-only prerequisite checks, run as the current user, each bounded to 60 seconds;
#                     prints one plain line per check and exits with the code of the first failure.
#   -PauseOnFailure   On a non-zero exit, wait for Enter before returning, so a console window the
#                     installer opened does not close before the reason can be read.
#   -NoBrowser        Do not open the Vocalis and Taproom pages after a successful setup.
#   -CheckPorts       Read-only: bind-test -VocalisPort and -TaproomPort (the defaults when omitted) on
#                     127.0.0.1 on Windows with Test-WindowsLoopbackPort, release them, and change nothing.
#                     Prints "OK   <name> port: ..." or "FAIL <name> port: ..." per port. When both can be
#                     bound the last line starts "Ports: OK" and the exit code is 0; otherwise the last
#                     line is "Suggested ports: <vocalis> <taproom>" (the next pair, stepping both by 2,
#                     where both can be bound; "none found" when there is none) and the exit code is 1.
#                     The installer's port page calls this so it and a real setup use one check.
#                     It cannot be combined with -CheckOnly.
#   -SeedModels       One or more Windows folders, separated by ';', whose verified model files setup may
#                     copy instead of downloading them again (October 9, 2026; design section 5, "reuse
#                     model files already on this machine"). Each entry is an earlier Vocalis data folder
#                     or a models folder and must be a full path with a drive letter (a UNC path is
#                     refused, and so is an entry that is not a drive path, which is what a folder name
#                     containing ';' leaves behind). Each is translated with wslpath and passed to
#                     setup.sh as --seed-models. Instances found under %LOCALAPPDATA%\VocalisDocker\ (a
#                     folder holding instance.env) are offered the same way without being asked for.
#
# Services start from Windows (design section 5, "Windows installer", amendment 15, October 10, 2026): setup.sh is
# always run with --defer-start, so it does everything it does today except the two `compose up -d` calls. When it
# exits 0 this script then (a) gives every file under each service's mounts to the service user (one-shot root
# containers, only files whose owner differs) and (b) runs `docker.exe compose up -d --no-build --pull never`, both
# through windows-compose.ps1 with INSTANCE_ROOT spelled as a Windows path (E:/...), so Docker Desktop can restart the
# containers by itself after a reboot or a restart (a /mnt/... source is served through the WSL distribution, which is
# not back yet when Docker restarts the containers). Neither runs when setup.sh failed.
#
# Exit codes:
#     0  success (with -CheckOnly: every check passed)
#     1  setup failed (message printed); this includes a Windows port that cannot be bound
#    10  docker.exe is not installed or not on PATH
#    11  the Docker engine is not answering (docker info failed or took over 60 seconds)
#    12  Docker Compose v2 is not available from docker.exe
#    13  wsl.exe is not installed
#    14  no usable default WSL distribution (none installed, or only docker-desktop)
#    15  the default WSL distribution cannot run bash
#    16  docker is not reachable inside the default WSL distribution (Docker Desktop WSL integration off)
#    17  docker compose v2 is not reachable inside the default WSL distribution
#    18  the NVIDIA runtime is not visible to Docker
#    19  setup.sh finished but the services could not be started from Windows (the ownership pass or
#        `docker compose up` failed or timed out, or the instance root could not be derived from
#        instance.env); the Compose output is printed and Start Vocalis is the quick retry
#   Any other value is the exit code of setup.sh (for example 130 after Ctrl-C), passed through.
#   With -CheckOnly every check that can run is run and one line is printed for each; the exit code is
#   that of the first failing check in the order above. A check whose prerequisite failed prints SKIP.
#   A normal run does the same checks first (all but the NVIDIA runtime, which setup.sh tests for the
#   cuda variant) and, when one fails, stops with that check's code (10 through 17).
[CmdletBinding()]
param(
    [string]$Root,
    [ValidateSet('cuda', 'rocm')]
    [string]$Variant,
    [string]$VocalisImage,
    [string]$TaproomImage,
    [ValidateRange(1024, 65535)]
    [int]$VocalisPort,
    [ValidateRange(1024, 65535)]
    [int]$TaproomPort,
    [string]$SeedModels,
    [switch]$Update,
    [switch]$CheckOnly,
    [switch]$CheckPorts,
    [switch]$PauseOnFailure,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# ConvertTo-ArgumentString, Invoke-Bounded and Read-InstanceEnv (moved out of this file on October 10, 2026) and the
# Windows docker.exe compose invocation live in windows-compose.ps1, which must sit beside this script. The installer
# copies it beside setup.ps1 in the install folder and extracts it beside the {tmp} copy used for -CheckOnly and -CheckPorts.
$WindowsComposeHelper = Join-Path $PSScriptRoot 'windows-compose.ps1'
if (-not (Test-Path -LiteralPath $WindowsComposeHelper -PathType Leaf)) {
    Write-Host "ERROR: windows-compose.ps1 must be in the same folder as setup.ps1 ($PSScriptRoot); it was not found." -ForegroundColor Red
    exit 1
}
. $WindowsComposeHelper

# Each prerequisite check is bounded so a wedged engine or a stalled WSL start cannot hang the caller.
# Invoke-Bounded's own default limit is the same 60 seconds; packaging/tests/test_setup_ps1.py compares them.
$CheckTimeoutSeconds = 60
# These two must equal the defaults in setup.sh (VOCALIS_PORT_ARG:-18770 and TAPROOM_PORT_ARG:-18771);
# packaging/tests/test_setup_ps1.py compares them.
$DefaultVocalisPort = 18770
$DefaultTaproomPort = 18771
# The exit code for "setup finished but the services could not be started" (amendment 15).
$ServicesNotStartedExitCode = 19

function Get-FirstLine {
    param([string]$Text)
    $Line = ($Text -split "[\r\n]+" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if (-not $Line) { return '' }
    $Line = $Line.Trim()
    if ($Line.Length -gt 200) { $Line = $Line.Substring(0, 200) }
    $Line
}

# One plain line per check: "OK   name: detail", "FAIL name: detail Fix: how to fix it", "SKIP name: why".
function Write-Check {
    param([string]$Status, [string]$Name, [string]$Detail, [string]$Fix)
    $Line = '{0,-4} {1}: {2}' -f $Status, $Name, $Detail
    if ($Fix) { $Line += ' Fix: ' + $Fix }
    Write-Host $Line
}

# Read-only prerequisite checks, as the current user, changing nothing (starting the default WSL
# distribution to ask it a question is the only side effect). Failures are collected in
# $script:PrerequisiteFailures in the order of the exit-code table at the top of this file.
function Invoke-PrerequisiteChecks {
    param([switch]$IncludeGpu)
    $script:PrerequisiteFailures = @()
    $Timeout = "did not answer within $CheckTimeoutSeconds s"

    function Add-Failure {
        param([int]$Code, [string]$Name, [string]$Detail, [string]$Fix)
        Write-Check 'FAIL' $Name $Detail $Fix
        $script:PrerequisiteFailures += [pscustomobject]@{ Code = $Code; Name = $Name; Detail = $Detail; Fix = $Fix }
    }

    # 10: docker.exe
    $DockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    $DockerReady = $false
    if (-not $DockerCommand) {
        Add-Failure 10 'docker.exe' 'not found on PATH.' 'Install Docker Desktop for Windows, start it, and retry.'
        Write-Check 'SKIP' 'docker engine' 'docker.exe is missing.'
        Write-Check 'SKIP' 'docker compose' 'docker.exe is missing.'
    } else {
        Write-Check 'OK' 'docker.exe' "found at $($DockerCommand.Source)."
        $DockerPath = $DockerCommand.Source
        # 11: engine answering
        $Info = Invoke-Bounded -FileName $DockerPath -Arguments @('info')
        if ($Info.TimedOut) {
            Add-Failure 11 'docker engine' "docker info $Timeout." 'Start Docker Desktop and wait until it reports the engine is running, then retry.'
        } elseif ($Info.ExitCode -ne 0) {
            Add-Failure 11 'docker engine' ("docker info failed with exit code $($Info.ExitCode): " + (Get-FirstLine $Info.Output)) 'Start Docker Desktop and wait until it reports the engine is running, then retry.'
        } else {
            Write-Check 'OK' 'docker engine' "answering ($($Info.Milliseconds) ms)."
            $DockerReady = $true
        }
        # 12: Compose v2 from docker.exe
        $Compose = Invoke-Bounded -FileName $DockerPath -Arguments @('compose', 'version')
        if ($Compose.TimedOut) {
            Add-Failure 12 'docker compose' "docker compose version $Timeout." 'Restart Docker Desktop and retry.'
        } elseif ($Compose.ExitCode -ne 0) {
            Add-Failure 12 'docker compose' ("Docker Compose v2 is not available: " + (Get-FirstLine $Compose.Output)) 'Update Docker Desktop to a version that includes Docker Compose v2.'
        } else {
            Write-Check 'OK' 'docker compose' ((Get-FirstLine $Compose.Output) + " ($($Compose.Milliseconds) ms).")
        }
    }

    # 13..17: WSL, its default distribution, and what runs inside it
    $WslCommand = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $WslCommand) {
        Add-Failure 13 'wsl.exe' 'not found.' "Install WSL 2 ('wsl --install' in an elevated PowerShell, then restart), install a Linux distribution such as Ubuntu, and retry."
        foreach ($Name in 'default WSL distribution', 'bash in WSL', 'docker in WSL', 'docker compose in WSL') { Write-Check 'SKIP' $Name 'wsl.exe is missing.' }
    } else {
        $WslPath = $WslCommand.Source
        Write-Check 'OK' 'wsl.exe' "found at $WslPath."
        $DefaultDistribution = $null
        $Distributions = @()
        $List = Invoke-Bounded -FileName $WslPath -Arguments @('-l', '-v') -UnicodeOutput
        if ($List.TimedOut) {
            Add-Failure 14 'default WSL distribution' "wsl -l -v $Timeout." "Run 'wsl --shutdown', wait a few seconds, and retry."
        } else {
            foreach ($Line in ($List.Output -split "[\r\n]+")) {
                if ($Line -match '^\s*(\*)?\s+(\S+)\s+\S+\s+\d\s*$') {
                    $Distributions += $Matches[2]
                    if ($Matches[1]) { $DefaultDistribution = $Matches[2] }
                }
            }
            $Real = @($Distributions | Where-Object { $_ -notmatch '^docker-desktop(-data)?$' })
            if (-not $DefaultDistribution) {
                Add-Failure 14 'default WSL distribution' 'no WSL distribution is installed.' "Install one ('wsl --install -d Ubuntu'), turn on its Docker Desktop WSL integration (Docker Desktop > Settings > Resources > WSL integration), and retry."
            } elseif ($DefaultDistribution -match '^docker-desktop(-data)?$') {
                if ($Real.Count -gt 0) {
                    Add-Failure 14 'default WSL distribution' "the default is '$DefaultDistribution', Docker Desktop's internal distribution, which cannot run setup." "Make one of your distributions the default ('wsl --set-default $($Real[0])'), turn on its Docker Desktop WSL integration, and retry."
                } else {
                    Add-Failure 14 'default WSL distribution' "only '$DefaultDistribution' exists, and Docker Desktop's internal distribution cannot run setup." "Install a distribution ('wsl --install -d Ubuntu'), turn on its Docker Desktop WSL integration (Docker Desktop > Settings > Resources > WSL integration), and retry."
                }
            } else {
                Write-Check 'OK' 'default WSL distribution' "$DefaultDistribution ($($List.Milliseconds) ms)."
            }
        }
        if (-not $DefaultDistribution -or $DefaultDistribution -match '^docker-desktop(-data)?$') {
            foreach ($Name in 'bash in WSL', 'docker in WSL', 'docker compose in WSL') { Write-Check 'SKIP' $Name 'no usable default WSL distribution.' }
        } else {
            $Bash = Invoke-Bounded -FileName $WslPath -Arguments @('--exec', 'bash', '-lc', 'exit 0')
            if ($Bash.TimedOut) {
                Add-Failure 15 'bash in WSL' "starting bash in '$DefaultDistribution' $Timeout." "Run 'wsl --shutdown', wait a few seconds, and retry."
                foreach ($Name in 'docker in WSL', 'docker compose in WSL') { Write-Check 'SKIP' $Name 'bash is not available.' }
            } elseif ($Bash.ExitCode -ne 0) {
                Add-Failure 15 'bash in WSL' ("'$DefaultDistribution' cannot run bash: " + (Get-FirstLine $Bash.Output)) "Use a distribution that includes bash (for example Ubuntu: 'wsl --set-default Ubuntu'), turn on its Docker Desktop WSL integration, and retry."
                foreach ($Name in 'docker in WSL', 'docker compose in WSL') { Write-Check 'SKIP' $Name 'bash is not available.' }
            } else {
                Write-Check 'OK' 'bash in WSL' "available in '$DefaultDistribution' ($($Bash.Milliseconds) ms)."
                $WslDocker = Invoke-Bounded -FileName $WslPath -Arguments @('--exec', 'bash', '-lc', 'docker --version')
                if ($WslDocker.TimedOut) {
                    Add-Failure 16 'docker in WSL' "docker in '$DefaultDistribution' $Timeout." 'Restart Docker Desktop and retry.'
                    Write-Check 'SKIP' 'docker compose in WSL' 'docker is not reachable in WSL.'
                } elseif ($WslDocker.ExitCode -ne 0) {
                    Add-Failure 16 'docker in WSL' ("docker is not reachable in '$DefaultDistribution': " + (Get-FirstLine $WslDocker.Output)) "In Docker Desktop open Settings > Resources > WSL integration, turn on '$DefaultDistribution' (or make an integrated distribution the default with 'wsl --set-default <name>'), click Apply & Restart, and retry."
                    Write-Check 'SKIP' 'docker compose in WSL' 'docker is not reachable in WSL.'
                } else {
                    Write-Check 'OK' 'docker in WSL' ((Get-FirstLine $WslDocker.Output) + " in '$DefaultDistribution' ($($WslDocker.Milliseconds) ms).")
                    $WslCompose = Invoke-Bounded -FileName $WslPath -Arguments @('--exec', 'bash', '-lc', 'docker compose version')
                    if ($WslCompose.TimedOut) {
                        Add-Failure 17 'docker compose in WSL' "docker compose version in '$DefaultDistribution' $Timeout." 'Restart Docker Desktop and retry.'
                    } elseif ($WslCompose.ExitCode -ne 0) {
                        Add-Failure 17 'docker compose in WSL' ("Docker Compose v2 is not reachable in '$DefaultDistribution': " + (Get-FirstLine $WslCompose.Output)) 'Update Docker Desktop to a version that includes Docker Compose v2, check its WSL integration, and retry.'
                    } else {
                        Write-Check 'OK' 'docker compose in WSL' ((Get-FirstLine $WslCompose.Output) + " in '$DefaultDistribution' ($($WslCompose.Milliseconds) ms).")
                    }
                }
            }
        }
    }

    # 18: the NVIDIA runtime, with the same test setup.sh uses
    if ($IncludeGpu) {
        if (-not $DockerReady) {
            Write-Check 'SKIP' 'NVIDIA runtime' 'the Docker engine is not answering.'
        } else {
            $Runtimes = Invoke-Bounded -FileName $DockerPath -Arguments @('info', '--format', '{{json .Runtimes}}')
            if ($Runtimes.TimedOut) {
                Add-Failure 18 'NVIDIA runtime' "docker info $Timeout." 'Restart Docker Desktop and retry.'
            } elseif ($Runtimes.ExitCode -ne 0 -or $Runtimes.Output -notmatch '(?i)nvidia') {
                Add-Failure 18 'NVIDIA runtime' 'not visible to Docker.' 'Install the NVIDIA driver, make sure Docker Desktop is using the WSL 2 backend with GPU support, and retry; docker info should list an nvidia runtime.'
            } else {
                Write-Check 'OK' 'NVIDIA runtime' "visible to Docker ($($Runtimes.Milliseconds) ms)."
            }
        }
    }
    $script:PrerequisiteFailures = @($script:PrerequisiteFailures | Sort-Object Code)
}

# Binds 127.0.0.1:<port> on Windows and releases it. Returns $null when the port can be bound, else a
# description. setup.sh's own probe runs inside WSL's loopback and cannot see ports held on Windows or
# inside a Hyper-V / WinNAT excluded range; bind fails with 10048 for a port in use and 10013 for an
# excluded one.
function Test-WindowsLoopbackPort {
    param([int]$Port)
    $Listener = $null
    try {
        $Listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $Listener.ExclusiveAddressUse = $true
        $Listener.Start()
        return $null
    } catch [System.Net.Sockets.SocketException] {
        $Code = $_.Exception.NativeErrorCode
        if ($Code -eq 10048) { return "port $Port on 127.0.0.1 is already in use on Windows (socket error $Code)." }
        if ($Code -eq 10013) { return "port $Port on 127.0.0.1 cannot be used: Windows refused the bind (socket error $Code), usually because the port is inside a reserved range. 'netsh interface ipv4 show excludedportrange protocol=tcp' lists the reserved ranges." }
        return "port $Port on 127.0.0.1 could not be bound (socket error $Code, $($_.Exception.Message))."
    } catch {
        return "port $Port on 127.0.0.1 could not be bound ($($_.Exception.Message))."
    } finally {
        if ($Listener) {
            try { $Listener.Stop() } catch { Write-Verbose "Releasing the test listener on port $Port failed: $($_.Exception.Message)" }
        }
    }
}

# Model reuse (October 9, 2026): the setup.sh arguments ('--seed-models', <Linux path>, ...) for the folders
# named by -SeedModels and for the instances found under $ScanParent (%LOCALAPPDATA%\VocalisDocker). The
# explicit entries come first and a bad one stops setup with the reason (the person asked for it); a found
# instance that cannot be translated is skipped, because it was only offered. setup.sh decides what is
# usable (existing, real, not this instance's own folder, safe characters) and prints every skip.
function Get-SeedModelArguments {
    param([string]$SeedModels, [string]$ScanParent)
    $Windows = @()
    if ($SeedModels) {
        foreach ($Entry in ($SeedModels -split ';')) {
            $Path = $Entry.Trim()
            if (-not $Path) { continue }
            if ($Path -match '^(\\\\|//)') {
                throw "The model folder '$Path' is a network (UNC) path; use a folder on a local drive."
            }
            if ($Path -notmatch '^[A-Za-z]:[\\/]') {
                throw "The model folder '$Path' is not a full path that starts with a drive letter, for example E:\Vocalis. Folder names containing ';' cannot be passed in -SeedModels."
            }
            $Windows += $Path
        }
    }
    $Explicit = $Windows.Count
    if ($ScanParent -and (Test-Path -LiteralPath $ScanParent -PathType Container)) {
        foreach ($Folder in (Get-ChildItem -LiteralPath $ScanParent -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
            if (($Folder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if (-not (Test-Path -LiteralPath (Join-Path $Folder.FullName 'instance.env') -PathType Leaf)) { continue }
            if ($Windows -contains $Folder.FullName) { continue }
            $Windows += $Folder.FullName
        }
    }
    $Arguments = @()
    for ($Index = 0; $Index -lt $Windows.Count; $Index++) {
        $Linux = (& wsl.exe --exec wslpath -a $Windows[$Index])
        $Linux = if ($Linux) { ([string]($Linux | Select-Object -First 1)).Trim() } else { '' }
        if ($LASTEXITCODE -ne 0 -or -not $Linux) {
            if ($Index -lt $Explicit) { throw "Could not translate the model folder '$($Windows[$Index])' into the selected WSL distribution." }
            Write-Host "Model reuse: skipping '$($Windows[$Index])', which could not be translated into WSL."
            continue
        }
        Write-Host "Model reuse: offering '$($Windows[$Index])' as $Linux."
        $Arguments += @('--seed-models', $Linux)
    }
    $Arguments
}

# Amendment 15: after setup.sh exited 0 (first install, rerun and --update alike) the services are started from
# Windows, ownership pass first (Start-WindowsInstance in windows-compose.ps1). Returns 0, or
# $ServicesNotStartedExitCode (19) when anything on the way failed, timed out or was refused; the reason and the
# Compose output have been printed by then. Called only when setup.sh succeeded.
function Start-InstanceAfterSetup {
    param([string]$InstanceFolder)
    $Docker = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $Docker) {
        Write-Host 'ERROR: The services could not be started: docker.exe was not found on PATH.' -ForegroundColor Red
        return $ServicesNotStartedExitCode
    }
    Write-Host 'Setup finished. Starting the services from Windows, so Docker Desktop can bring them back by itself after a restart.'
    $Result = Start-WindowsInstance -InstanceFolder $InstanceFolder -DockerPath $Docker.Source
    if ($Result.Success) {
        Write-Host 'The Vocalis and Taproom services are started.'
        return 0
    }
    Write-Host "ERROR: The services could not be started. $($Result.Message)" -ForegroundColor Red
    Write-Host 'Setup itself finished. Start Vocalis (Start menu) is the quick retry; running setup again also retries the start.'
    return $ServicesNotStartedExitCode
}

# The setup flow stays at script scope on purpose: the native call to setup.sh must keep the console
# (its prompts, including the hidden-input Taproom owner prompt, need direct console I/O, which a
# function whose output is captured by a caller would turn into buffered pipe text).
$ExitCode = 1
try {
    if ($CheckOnly -and $CheckPorts) {
        throw '-CheckOnly and -CheckPorts cannot be combined.'
    } elseif ($CheckPorts) {
        $FirstPort = if ($VocalisPort) { $VocalisPort } else { $DefaultVocalisPort }
        $SecondPort = if ($TaproomPort) { $TaproomPort } else { $DefaultTaproomPort }
        if ($FirstPort -eq $SecondPort) { throw 'The Vocalis and Taproom ports must differ.' }
        $Busy = 0
        foreach ($Entry in @(@('Vocalis', $FirstPort), @('Taproom', $SecondPort))) {
            $Problem = Test-WindowsLoopbackPort ([int]$Entry[1])
            if ($Problem) {
                $Busy++
                Write-Host "FAIL $($Entry[0]) port: $Problem"
            } else {
                Write-Host "OK   $($Entry[0]) port: $($Entry[1]) can be bound on 127.0.0.1 on Windows."
            }
        }
        if ($Busy -eq 0) {
            Write-Host "Ports: OK ($FirstPort and $SecondPort can be bound on 127.0.0.1 on Windows)."
            $ExitCode = 0
        } else {
            # The next pair, stepping both ports by 2 so the pair keeps its spacing and the two stay distinct.
            $Suggestion = $null
            for ($Step = 1; $Step -le 100 -and -not $Suggestion; $Step++) {
                $NextFirst = $FirstPort + 2 * $Step
                $NextSecond = $SecondPort + 2 * $Step
                if ($NextFirst -gt 65535 -or $NextSecond -gt 65535) { break }
                if (-not (Test-WindowsLoopbackPort $NextFirst) -and -not (Test-WindowsLoopbackPort $NextSecond)) {
                    $Suggestion = "$NextFirst $NextSecond"
                }
            }
            if ($Suggestion) { Write-Host "Suggested ports: $Suggestion" } else { Write-Host 'Suggested ports: none found' }
            $ExitCode = 1
        }
    } elseif ($CheckOnly) {
        Write-Host "Checking prerequisites (each check is limited to $CheckTimeoutSeconds s; nothing is changed)."
        Invoke-PrerequisiteChecks -IncludeGpu
        if ($script:PrerequisiteFailures.Count -eq 0) {
            Write-Host 'Prerequisites: all checks passed.'
            $ExitCode = 0
        } else {
            $First = $script:PrerequisiteFailures[0]
            Write-Host "Prerequisites: $($script:PrerequisiteFailures.Count) check(s) failed; exit code $($First.Code) ($($First.Name))."
            $ExitCode = [int]$First.Code
        }
    } else {
        # The same checks, so the normal path and -CheckOnly cannot disagree; the NVIDIA runtime is left to
        # setup.sh, which tests it for the cuda variant only.
        Invoke-PrerequisiteChecks
        if ($script:PrerequisiteFailures.Count -gt 0) {
            $First = $script:PrerequisiteFailures[0]
            $FailureExitCode = [int]$First.Code
            throw "$($First.Name): $($First.Detail) $($First.Fix)"
        }

        if (-not $Root) {
            $Root = Join-Path $env:LOCALAPPDATA 'VocalisDocker\instance'
        }
        # setup.sh only shows the /setup bootstrap page for a new instance; an existing one is past it, so
        # open the plain address (the login page) for a rerun instead of a first-run page it has outgrown.
        $NewInstance = -not (Test-Path -LiteralPath (Join-Path $Root 'instance.env'))
        $NativeArguments = @()
        # Always (amendment 15): setup.sh does not start the services; Start-InstanceAfterSetup does, from Windows.
        $NativeArguments += '--defer-start'
        if ($Update) { $NativeArguments += '--update' }
        if ($Root) {
            $LinuxRoot = (& wsl.exe --exec wslpath -a $Root).Trim()
            if ($LASTEXITCODE -ne 0 -or -not $LinuxRoot) { throw 'Could not translate the instance root into the selected WSL distribution.' }
            $NativeArguments += @('--root', $LinuxRoot)
        }
        if ($Variant) { $NativeArguments += @('--variant', $Variant) }
        if ($VocalisImage) { $NativeArguments += @('--vocalis-image', $VocalisImage) }
        if ($TaproomImage) { $NativeArguments += @('--taproom-image', $TaproomImage) }
        $ScanParent = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'VocalisDocker' } else { '' }
        $NativeArguments += @(Get-SeedModelArguments -SeedModels $SeedModels -ScanParent $ScanParent)
        if ($NewInstance -and -not $Update) {
            # A new instance gets its ports chosen and bind-tested here, on Windows, where the browser and
            # the Docker port publishing live. They are passed to setup.sh explicitly, so its interactive
            # port prompt (which could pick a port this check never saw) is not reached from Windows.
            $VocalisPortToUse = if ($VocalisPort) { $VocalisPort } else { $DefaultVocalisPort }
            $TaproomPortToUse = if ($TaproomPort) { $TaproomPort } else { $DefaultTaproomPort }
            foreach ($Entry in @(@('Vocalis', $VocalisPortToUse, '-VocalisPort'), @('Taproom', $TaproomPortToUse, '-TaproomPort'))) {
                $Problem = Test-WindowsLoopbackPort ([int]$Entry[1])
                if ($Problem) {
                    Write-Host "FAIL $($Entry[0]) port: $Problem"
                    throw "The $($Entry[0]) port is not usable. Choose another with $($Entry[2]) <port> and run setup again."
                }
                Write-Host "OK   $($Entry[0]) port: $($Entry[1]) can be bound on 127.0.0.1 on Windows."
            }
            $NativeArguments += @('--vocalis-port', "$VocalisPortToUse", '--taproom-port', "$TaproomPortToUse")
        } else {
            if ($VocalisPort) { $NativeArguments += @('--vocalis-port', "$VocalisPort") }
            if ($TaproomPort) { $NativeArguments += @('--taproom-port', "$TaproomPort") }
        }

        $LinuxPackaging = (& wsl.exe --exec wslpath -a $PSScriptRoot).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $LinuxPackaging) { throw 'Could not translate the packaging directory into WSL.' }
        $LinuxSetup = "$LinuxPackaging/setup.sh"
        & wsl.exe --exec bash $LinuxSetup @NativeArguments
        $ExitCode = $LASTEXITCODE

        if ($ExitCode -eq 0) {
            $ExitCode = Start-InstanceAfterSetup -InstanceFolder $Root
        }

        if ($ExitCode -eq 0 -and -not $Update) {
            if ($NoBrowser) {
                Write-Host 'Browser launch skipped (-NoBrowser).'
            } else {
                $EnvFile = Join-Path $Root 'instance.env'
                $Settings = @{}
                foreach ($Line in Get-Content -LiteralPath $EnvFile) {
                    if ($Line -match '^(VOCALIS_PUBLIC_URL|TAPROOM_PUBLIC_URL)=(https?://[^\s]+)$') {
                        $Settings[$Matches[1]] = $Matches[2]
                    }
                }
                if ($Settings.ContainsKey('VOCALIS_PUBLIC_URL')) {
                    $VocalisPage = if ($NewInstance) { "$($Settings['VOCALIS_PUBLIC_URL'])/setup" } else { $Settings['VOCALIS_PUBLIC_URL'] }
                    Start-Process $VocalisPage -ErrorAction SilentlyContinue
                }
                if ($Settings.ContainsKey('TAPROOM_PUBLIC_URL')) {
                    Start-Process $Settings['TAPROOM_PUBLIC_URL'] -ErrorAction SilentlyContinue
                }
            }
        }
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    # A failed prerequisite keeps its own code from the table above; any other failure is 1.
    $ExitCode = if ($FailureExitCode) { $FailureExitCode } else { 1 }
}
if ($ExitCode -ne 0 -and $PauseOnFailure) {
    Write-Host ''
    if ($ExitCode -eq $ServicesNotStartedExitCode) {
        Write-Host 'Setup finished, but the services could not be started. Start Vocalis (Start menu), or running setup again, retries the start.'
    } elseif (-not $CheckOnly) {
        Write-Host 'Setup did not finish. Running it again resumes it; finished downloads are kept.'
    }
    Write-Host "Exit code $ExitCode. Press Enter to close this window." -NoNewline
    [void][Console]::In.ReadLine()
}
exit $ExitCode
