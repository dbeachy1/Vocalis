# Windows satellite setup: one command that turns a Windows machine with an NVIDIA card and Docker Desktop into a
# Vocalis render satellite (design section 9, "Satellite package: one command per operating system", added October 10,
# 2026). Run it from a regular PowerShell window (not the ISE), after downloading it:
#     powershell -ExecutionPolicy Bypass -File .\satellite-setup.ps1 -Image <name>@sha256:<64 hex digits>
# (-ExecutionPolicy Bypass applies to this one run; Windows blocks a downloaded script by default and this does not
# change the machine's policy.) A release copy has its image reference stamped in and needs no -Image.
#
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page. It is ONE self-contained
# file on purpose (a user downloads it alone, without the repository), so it carries its own small bounded-run helper
# instead of dot-sourcing windows-compose.ps1. It needs no administrator rights, no WSL distribution, no Python, and it
# changes no Windows setting (it never touches the firewall; the command to use is in -Help and in the setup log).
#
# Everything is done from Windows with docker.exe and Windows paths spelled with forward slashes (E:/...): amendment 15
# of the main package found that containers whose folders are mounted through a WSL distribution (/mnt/e/...) do not come
# back after a restart of Docker Desktop. The rules (the secret, the certificate, the configuration, the model download)
# live in one tool inside the image, /opt/vocalis/satellite-admin/satellite_admin.py, run in one-shot containers, so this
# script and satellite-setup.sh cannot drift apart. This script only checks, makes folders and calls docker.exe.
#
# Output (design section 9, "Satellite setup program and tray icon for Windows, and quieter setup output", added
# October 11, 2026): quiet by default (each step prints its header and a line or two), full with PowerShell's own
# -Verbose. Everything, the hidden lines included, goes to <root>\logs\setup-<UTC yyyymmdd-hhmmss>-<process id>.log (the last
# ten are kept; the secret is never written there), and the run ends with <root>\setup-result.txt, KEY=VALUE lines the
# setup program and the tray icon read. Neither file is written into a folder this script refuses. Every failure is
# printed as ONE line starting "ERROR:" (never as a PowerShell error record), and when the output is not a terminal it
# is written as UTF-8 so a wrapper reads non-ASCII paths correctly.
#
# Parameters (the same names the Linux script has, in the Windows spelling):
#   -Root PATH        The satellite folder. Default %LOCALAPPDATA%\VocalisDocker\satellite. Must be empty or already a
#                     satellite folder (one that holds satellite.env). No comma, apostrophe or line break in the path.
#   -Image REF        <name>@sha256:<64 hex digits>. Required unless this copy has a stamped default. A reference Docker
#                     already resolves locally is not pulled. On a folder that holds a finished setup, a different image than
#                     the recorded one is refused without -Update. On a folder whose setup never finished (no secret, no
#                     certificate or no configuration file) a plain run adopts the image given, records it in satellite.env and
#                     carries on as the resumed first setup; -Update stays refused on such a folder. The same happens with no
#                     -Image when this file carries a stamped default image that differs from the recorded one (a finished
#                     folder gets the note that names -Update instead). The small -Autostart operation never adopts.
#   -Port N           The port published on all interfaces (default 7880). Fixed for an existing folder.
#   -Name NAME        Labels the satellite's log lines (default: this computer's name in lower case). Fixed for an
#                     existing folder.
#   -Address VALUE    One or more IPv4 addresses (added to the certificate) or names (recorded for information only),
#                     separated by commas, on top of the addresses this script finds.
#   -SecretFile PATH  A plain ASCII text file holding the secret Vocalis shows, instead of typing it at the prompt.
#   -Autostart on|off Start with Docker. on (the default, and what an older folder is read as): the container is made with
#                     --restart unless-stopped, so after the computer or Docker restarts a satellite that was running comes
#                     back, and one you stopped stays stopped. off: --restart no, so it stays down until someone starts it
#                     and is also not restarted if it crashes. Recorded in satellite.env. Given alone for an existing
#                     satellite folder it is a small operation that only records the value and changes the container's
#                     restart policy with docker update (no pull, no model check, no recreate, no restart); it needs
#                     Docker to answer. Given with another operation, that operation applies it.
#   -Update           Pull the new image (-Image when given, otherwise the image stamped into this file), check the model with
#                     it, and only then switch the running satellite to it. Refused only when neither exists. When the
#                     new image is the one already running, it says so and carries on as a plain repair run.
#   -NewSecret        Replace the secret (after "New secret..." in Vocalis); restarts the satellite.
#   -NewCertificate   Replace the certificate (Vocalis must then be given the new file); restarts the satellite.
#   -Remove           Remove the container only; the folder is left in place.
#   -Verbose          PowerShell's own switch (no parameter is declared for it): print everything, as the script did before
#                     the quiet output. The log has everything either way.
#   -NoPrompt         Never ask for the secret. A run that needs one and was given no -SecretFile stops with one fixed
#                     plain-English line ("ERROR: This satellite still needs its secret from Vocalis. Run setup again and
#                     paste the secret when it asks."). The setup program and the tray icon always pass it (a prompt under
#                     them would be invisible).
#   -ShowPlan         Print KEY=VALUE lines (SATELLITE, SATELLITE_ID, NAME, PORT, CONTAINER, AUTOSTART, IMAGE, ADDRESSES,
#                     NEEDS_SECRET, NEEDS_CERTIFICATE, SETUP_FINISHED, CERTIFICATE_FILE, FINGERPRINT) for -Root and the
#                     optional -Port, -Name and -Address, and exit (any other option with it is refused). SETUP_FINISHED is
#                     yes only when satellite.env, the secret, the certificate and the satellite's configuration file
#                     (data/satellite.yaml) all exist. No Docker
#                     call, no banner, no step headers, no log or result file.
#   -CheckOnly        One OK, FAIL or SKIP line per prerequisite (docker.exe, the engine, the NVIDIA runtime), each bounded
#                     to 60 seconds, and exit. Changes nothing. The last line is "Prerequisites: all checks passed." or
#                     "Prerequisites: N check(s) failed." (no exit code or internal name on it; the exit code is the first
#                     failure's, see below).
#   -CheckPort        With -Port N: exit 0 when the port can be bound on all interfaces; otherwise exit 1 with a line
#                     "Suggested port: <n>". Changes nothing.
#   -Help             Print this summary and exit.
#
# Exit codes:
#     0  success
#     1  a refusal or a failure (the message says which); nothing that already worked is undone
#    10  docker.exe is not installed or not on PATH
#    11  the Docker engine is not answering
#    12  no NVIDIA card can be used inside a container
#    13  the satellite started but did not report that it is listening
#    14  the NVIDIA runtime is not visible to Docker (-CheckOnly only)
[CmdletBinding()]
param(
    [string]$Root,
    [string]$Image,
    [ValidateRange(1024, 65535)]
    [int]$Port = 7880,
    [string]$Name,
    [string[]]$Address,
    [string]$SecretFile,
    [string]$Autostart,
    [switch]$Update,
    [switch]$NewSecret,
    [switch]$NewCertificate,
    [switch]$Remove,
    [switch]$ShowPlan,
    [switch]$CheckOnly,
    [switch]$CheckPort,
    [switch]$NoPrompt,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# Output state. The log lines wait in memory until the log opens (it opens only once satellite.env has been read and
# accepted, or created); the plumbing modes (-ShowPlan, -CheckOnly, -CheckPort) and -Help never log.
$script:LogBuffer = New-Object System.Collections.ArrayList
$script:LogWriter = $null
$script:LogPath = ''
$script:LogDisabled = [bool]($ShowPlan -or $CheckOnly -or $CheckPort -or $Help)
$script:LogWarned = $false
# -ShowPlan prints only its own KEY=VALUE lines.
$script:Silent = [bool]$ShowPlan

# First act (design, feasibility check of October 11, 2026): when output is not a terminal, Windows PowerShell writes the
# old console code page, and a wrapper (the setup program) would show a non-ASCII path as question marks. UTF-8 without a
# byte-order mark fixes that. It can fail where there is no console at all; that is logged and nothing else changes.
$script:EncodingNote = $null
try {
    if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) }
} catch {
    $script:EncodingNote = "Could not set the console output encoding to UTF-8: $($_.Exception.Message)"
}

# -Verbose is PowerShell's own switch (this script declares [CmdletBinding()], so it exists without a parameter of its
# own). It is read here and then reset, so cmdlets add no VERBOSE: lines of their own; this script's own detail lines
# are printed or only logged by Write-Detail.
$script:VerboseRun = ($VerbosePreference -eq 'Continue')
$VerbosePreference = 'SilentlyContinue'

# Release stamping (design section 9, "Release stamping"): the release step writes the published image reference between
# the quotes of the next line. The copy in the repository carries no default, so it refuses to run without -Image.
$DefaultImageCuda = ''

# The fixed facts of the run specification (design section 9, "Run specification"). The service user is the image's own
# user on Windows; the listener inside the container never changes (the user's port exists only on the host side).
$ServiceUid = 1000
$ServiceGid = 1000
$ServiceUser = "${ServiceUid}:${ServiceGid}"
$ContainerPort = 7880
$AdminTool = '/opt/vocalis/satellite-admin/satellite_admin.py'
# Bounds, in seconds. The one-shot containers import PyTorch, so they get more than a plain docker call.
$CheckTimeoutSeconds = 60
$OneShotSeconds = 300
$ListenWaitSeconds = 180
$ListenPollSeconds = 3
$FolderNames = @('data', 'secrets', 'models', 'logs', 'work', 'cache')
# The order satellite.env is written in. Unknown lines in an existing file are kept as they are. AUTOSTART and
# CERT_FINGERPRINT (October 11, 2026) are the twelfth and thirteenth keys; a file written before them lacks both and is
# still accepted (AUTOSTART is then read as on), and they are written the next time the script saves the file.
$EnvKeys = @('SATELLITE_ID', 'GPU_VARIANT', 'SATELLITE_ROOT', 'SATELLITE_IMAGE', 'SATELLITE_PORT', 'SATELLITE_NAME',
    'SERVICE_UID', 'SERVICE_GID', 'GPU_GIDS', 'IP_ADDRESSES', 'DNS_NAMES', 'AUTOSTART', 'CERT_FINGERPRINT')
$OptionalEnvKeys = @('AUTOSTART', 'CERT_FINGERPRINT')
# Parameters PowerShell adds to every cmdlet-style script; they never count as "other options" of a stand-alone mode.
$CommonParameterNames = @('Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable',
    'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable')

# What the result file and the closing lines need to know, filled in as the run learns it. Root is empty until
# satellite.env has been accepted or created; the result file is written only once Root is known.
$script:ResultOn = $false
$script:ResultPath = ''
$script:IsAutostartOnly = $false
$script:ModeFirst = $false
$script:PrimaryAddress = $null
$script:R = @{
    Root = ''; Id = ''; Name = ''; Port = 0; Image = ''; Container = ''; Autostart = 'on'
    Ips = @(); Fingerprint = ''; MadeSecret = 'no'; MadeCertificate = 'no'; Steps = 'unknown'; Running = 'unknown'
}

# ---- output: the screen, the log and the verbose switch ---------------------------------------------------------------

# One line (or several, split) into the log: written at once when the log is open, held in memory before that. A write
# that fails turns the log off with one warning; a log never fails the run.
function Add-LogLine {
    param([string]$Text)
    if ($script:LogDisabled) { return }
    foreach ($Line in ($Text -split "\r?\n")) {
        $Stamped = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture) + '  ' + $Line
        if ($script:LogWriter) {
            try {
                $script:LogWriter.WriteLine($Stamped)
            } catch {
                $script:LogDisabled = $true
                $script:LogWriter = $null
                if (-not $script:LogWarned) {
                    $script:LogWarned = $true
                    Write-Host "WARNING: the setup log could not be written ($($_.Exception.Message)); the run goes on without it."
                }
            }
        } else {
            [void]$script:LogBuffer.Add($Stamped)
        }
    }
}

# A line the user sees, and the log keeps.
function Write-Screen {
    param([string]$Text = '', [string]$Color)
    if (-not $script:Silent) {
        if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
    }
    Add-LogLine $Text
}

# A line only -Verbose shows; the log keeps it either way.
function Write-Detail {
    param([string]$Text = '')
    if ($script:VerboseRun) { Write-Screen $Text } else { Add-LogLine $Text }
}

# A line that is only logged (a hidden line of a captured call, or a decision worth keeping).
function Write-Hidden {
    param([string]$Text = '')
    Add-LogLine $Text
}

# One line, for a message that goes into a result file or an ERROR: line.
function ConvertTo-OneLine {
    param([string]$Text)
    (([string]$Text) -replace '\s*[\r\n]+\s*', ' ').Trim()
}

function Open-SetupLog {
    param([string]$RootFull, [string]$ArgumentNames)
    if ($script:LogDisabled) { return }
    $LogFolder = Join-Path $RootFull 'logs'
    try {
        New-Item -ItemType Directory -Path $LogFolder -Force | Out-Null
        $Stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss', [System.Globalization.CultureInfo]::InvariantCulture)
        $Path = Join-Path $LogFolder "setup-$Stamp-$PID.log"
        $Stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $Writer = New-Object System.IO.StreamWriter($Stream, (New-Object System.Text.UTF8Encoding($false)))
        $Writer.NewLine = "`n"
        $Writer.AutoFlush = $true
        foreach ($Held in $script:LogBuffer) { $Writer.WriteLine($Held) }
        $script:LogBuffer.Clear()
        $script:LogWriter = $Writer
        $script:LogPath = $Path
    } catch {
        # One warning; the held lines are dropped with the log (there is nowhere to put them).
        $script:LogDisabled = $true
        $script:LogWriter = $null
        $script:LogPath = ''
        $script:LogBuffer.Clear()
        if (-not $script:LogWarned) {
            $script:LogWarned = $true
            Write-Host "WARNING: the setup log could not be opened ($($_.Exception.Message)); the run goes on without it."
        }
        return
    }
    Add-LogLine "Setup log opened: process $PID, script $PSCommandPath, options given: $ArgumentNames"
    if ($script:EncodingNote) { Add-LogLine $script:EncodingNote }
    # The last ten setup logs are kept (this one included). Only files named like this script's own logs are touched.
    try {
        $Others = @(Get-ChildItem -LiteralPath $LogFolder -Filter 'setup-*.log' -File |
            Where-Object { $_.Name -cmatch '^setup-\d{8}-\d{6}-\d+\.log$' -and $_.FullName -ne $script:LogPath } |
            Sort-Object -Property Name -Descending)
        if ($Others.Count -gt 9) {
            foreach ($Old in ($Others | Select-Object -Skip 9)) {
                try {
                    Remove-Item -LiteralPath $Old.FullName -Force
                    Add-LogLine "Removed the older setup log $($Old.Name) (the last ten are kept)."
                } catch {
                    Add-LogLine "Could not remove the older setup log $($Old.Name): $($_.Exception.Message)"
                }
            }
        }
    } catch {
        Add-LogLine "Could not list the older setup logs: $($_.Exception.Message)"
    }
}

function Close-SetupLog {
    if ($script:LogWriter) {
        try { $script:LogWriter.Dispose() } catch { Write-Host "WARNING: closing the setup log failed ($($_.Exception.Message))." }
        $script:LogWriter = $null
    }
}

# satellite.env has been accepted (or just created): from here the old result file is gone, the log opens (the held
# lines are written first) and the result file will be written at the end, on success and on failure.
function Start-SetupArtifacts {
    param([string]$RootFull, [string]$ArgumentNames)
    $script:R.Root = $RootFull
    $script:ResultPath = Join-Path $RootFull 'setup-result.txt'
    $script:ResultOn = $true
    $Stale = $null
    try {
        if (Test-Path -LiteralPath $script:ResultPath) { Remove-Item -LiteralPath $script:ResultPath -Force }
    } catch {
        $Stale = "Could not delete the previous setup-result.txt: $($_.Exception.Message)"
    }
    Open-SetupLog -RootFull $RootFull -ArgumentNames $ArgumentNames
    if ($Stale) { Add-LogLine $Stale }
}

function ConvertTo-ArgumentString {
    param([string[]]$Arguments)
    $Parts = foreach ($Argument in $Arguments) {
        if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { $Argument }
        else { '"' + (($Argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }
    $Parts -join ' '
}

# Runs one native program with redirected output and a hard time limit; a program still running at the limit is killed
# together with its children. Returns Started, TimedOut, ExitCode, Output (stdout then stderr, NULs removed), StdOut and StdErr
# (each alone) and Milliseconds. A program's stderr is never a failure here: callers decide by ExitCode, and parse StdOut
# only (the in-image tool writes INFO lines to stderr on success). Its input is closed, so it must never be used for the one call that prompts (that call is made
# directly at script scope, below). This is the same helper windows-compose.ps1 has, without the parts this script
# does not use.
function Invoke-Bounded {
    param(
        [string]$FileName,
        [string[]]$Arguments,
        [int]$TimeoutSeconds = 60
    )
    $Watch = [System.Diagnostics.Stopwatch]::StartNew()
    $Info = New-Object System.Diagnostics.ProcessStartInfo
    $Info.FileName = $FileName
    $Info.Arguments = ConvertTo-ArgumentString $Arguments
    $Info.UseShellExecute = $false
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Info.RedirectStandardInput = $true
    $Info.CreateNoWindow = $true
    $Info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $Info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $Info
    try {
        [void]$Process.Start()
    } catch {
        return [pscustomobject]@{ Started = $false; TimedOut = $false; ExitCode = -1; Output = $_.Exception.Message; StdOut = ''; StdErr = $_.Exception.Message; Milliseconds = $Watch.ElapsedMilliseconds }
    }
    $Process.StandardInput.Close()
    $OutputTask = $Process.StandardOutput.ReadToEndAsync()
    $ErrorTask = $Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        # Windows PowerShell 5.1 turns each line of a redirected native stderr into an error record, and 'Stop' makes
        # that terminating (checked October 10, 2026): a taskkill that reports a process of the tree already gone
        # would throw out of here instead of returning TimedOut. Local to this function.
        $ErrorActionPreference = 'Continue'
        & taskkill.exe /T /F /PID $Process.Id *> $null
        [void]$Process.WaitForExit(5000)
        $Partial = @()
        foreach ($Task in @($OutputTask, $ErrorTask)) {
            try { if ($Task.Wait(2000)) { $Partial += $Task.Result } } catch { $Partial += "(output unreadable: $($_.Exception.Message))" }
        }
        $Text = ($Partial -join "`n") -replace "`0", ''
        return [pscustomobject]@{ Started = $true; TimedOut = $true; ExitCode = -1; Output = $Text.Trim(); StdOut = $Text.Trim(); StdErr = ''; Milliseconds = $Watch.ElapsedMilliseconds }
    }
    $Process.WaitForExit()
    $Text = ($OutputTask.Result + "`n" + $ErrorTask.Result) -replace "`0", ''
    $StdOut = ($OutputTask.Result -replace "`0", '').Trim()
    $StdErr = ($ErrorTask.Result -replace "`0", '').Trim()
    [pscustomobject]@{ Started = $true; TimedOut = $false; ExitCode = $Process.ExitCode; Output = $Text.Trim(); StdOut = $StdOut; StdErr = $StdErr; Milliseconds = $Watch.ElapsedMilliseconds }
}

# For the two calls whose output is wanted line by line as it arrives, with no time limit (a pull and the model download
# are as long as the network): both streams are read as text and each non-empty line is handed to $OnLine as
# ($Stream, $Line), $Stream being 'out' or 'err'. Never a 2>&1 on the native program: Windows PowerShell 5.1 turns each
# standard-error line of a redirected program into an error record (see Invoke-Bounded). The input is closed. Returns
# Started, ExitCode and Milliseconds. The lines are read on this thread by polling two pending reads, so $OnLine runs
# where the caller's own functions are visible.
function Invoke-Streamed {
    param([string]$FileName, [string[]]$Arguments, [scriptblock]$OnLine)
    $Watch = [System.Diagnostics.Stopwatch]::StartNew()
    $Info = New-Object System.Diagnostics.ProcessStartInfo
    $Info.FileName = $FileName
    $Info.Arguments = ConvertTo-ArgumentString $Arguments
    $Info.UseShellExecute = $false
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Info.RedirectStandardInput = $true
    $Info.CreateNoWindow = $true
    $Info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $Info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $Info
    try {
        [void]$Process.Start()
    } catch {
        return [pscustomobject]@{ Started = $false; ExitCode = -1; Milliseconds = $Watch.ElapsedMilliseconds; Problem = $_.Exception.Message }
    }
    $Process.StandardInput.Close()
    $Readers = @(
        @{ Name = 'out'; Reader = $Process.StandardOutput; Task = $null; Open = $true },
        @{ Name = 'err'; Reader = $Process.StandardError; Task = $null; Open = $true })
    foreach ($Entry in $Readers) { $Entry.Task = $Entry.Reader.ReadLineAsync() }
    while (@($Readers | Where-Object { $_.Open }).Count -gt 0) {
        $Moved = $false
        foreach ($Entry in $Readers) {
            if (-not $Entry.Open -or -not $Entry.Task.IsCompleted) { continue }
            $Moved = $true
            $Line = $null
            try {
                $Line = $Entry.Task.Result
            } catch {
                Add-LogLine "A read from the $($Entry.Name) stream of $FileName failed: $($_.Exception.Message)"
                $Line = $null
            }
            if ($null -eq $Line) {
                $Entry.Open = $false
            } else {
                $Clean = $Line -replace "`0", ''
                if ($Clean.Trim()) { & $OnLine $Entry.Name $Clean }
                $Entry.Task = $Entry.Reader.ReadLineAsync()
            }
        }
        if (-not $Moved) {
            $Pending = [System.Threading.Tasks.Task[]]@($Readers | Where-Object { $_.Open } | ForEach-Object { $_.Task })
            [void][System.Threading.Tasks.Task]::WaitAny($Pending, 200)
        }
    }
    $Process.WaitForExit()
    [pscustomobject]@{ Started = $true; ExitCode = $Process.ExitCode; Milliseconds = $Watch.ElapsedMilliseconds; Problem = '' }
}

# A captured docker call: the command line, then every line of what came back, goes to the log (design table: "Log:
# every line"); the caller decides what, if anything, reaches the screen. $SkipOutputLog is for the wait loop, which logs
# the lines it has not logged yet itself.
function Invoke-LoggedDocker {
    param([string[]]$Arguments, [int]$TimeoutSeconds = 60, [switch]$SkipOutputLog)
    Add-LogLine ('docker ' + (ConvertTo-ArgumentString $Arguments))
    $Result = Invoke-Bounded -FileName $script:DockerPath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
    if (-not $SkipOutputLog) {
        foreach ($Line in ($Result.StdOut -split "[\r\n]+")) { if ($Line.Trim()) { Add-LogLine "  out: $Line" } }
        foreach ($Line in ($Result.StdErr -split "[\r\n]+")) { if ($Line.Trim()) { Add-LogLine "  err: $Line" } }
    }
    if ($Result.TimedOut) { Add-LogLine "  (no answer within $TimeoutSeconds s; the program was stopped)" }
    Add-LogLine "  exit code $($Result.ExitCode) in $($Result.Milliseconds) ms"
    $Result
}

# Every refusal and failure goes through here: the message is printed once by the catch at the bottom, and the exit
# code is the one given (see the table at the top).
function Stop-Setup {
    param([string]$Message, [int]$Code = 1)
    $script:FailureExitCode = $Code
    throw $Message
}

function Get-FirstLine {
    param([string]$Text)
    $Line = ($Text -split "[\r\n]+" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if (-not $Line) { return '' }
    $Line = $Line.Trim()
    if ($Line.Length -gt 200) { $Line = $Line.Substring(0, 200) }
    $Line
}

# Step headers are numbered 1 to $StepCount with no gaps: 8 for a setup, update or replaced secret or certificate (checks,
# image, GPU, addresses, secret and certificate, model, start, done) and 2 for -Remove (checks, remove) and for the small
# -Autostart operation (checks, autostart). A step that has nothing to do still prints its header and says so. The secret
# and the certificate share step 5 because one provision container makes both.
function Write-Step {
    param([int]$Number, [string]$Title)
    Write-Screen ''
    Write-Screen "[$Number/$script:StepCount] $Title"
}

# A list for a message: the values joined by ', ', or (none) when there are none.
function Format-ListOrNone {
    param($Values)
    $Items = @($Values | Where-Object { $_ })
    if ($Items.Count -gt 0) { $Items -join ', ' } else { '(none)' }
}

function Show-Help {
    Write-Host 'Vocalis satellite setup for Windows (Docker Desktop and an NVIDIA card).'
    Write-Host ''
    Write-Host 'Run:  powershell -ExecutionPolicy Bypass -File .\satellite-setup.ps1 [options]'
    Write-Host ''
    Write-Host '  -Root PATH        satellite folder (default %LOCALAPPDATA%\VocalisDocker\satellite)'
    Write-Host '  -Image REF        <name>@sha256:<64 hex digits> (required unless this copy has a default)'
    Write-Host '  -Port N           port published on all interfaces (default 7880)'
    Write-Host '  -Name NAME        label for the satellite log lines (default: this computer name)'
    Write-Host '  -Address A,B      IPv4 addresses (or names) to add to the certificate'
    Write-Host '  -SecretFile PATH  plain ASCII file holding the secret, instead of typing it'
    Write-Host '  -Autostart on|off start with Docker (default on). on: after the computer or Docker restarts, a satellite that was'
    Write-Host '                    running comes back, and one you stopped stays stopped. off: it stays down until you start it'
    Write-Host '                    (docker start), and it is not restarted after a crash either. Alone on an existing satellite'
    Write-Host '                    folder it only changes this setting.'
    Write-Host '  -Update           pull the new image (-Image, else the one built into this file), check the model, then switch the satellite to it'
    Write-Host '  -NewSecret        replace the secret and restart the satellite'
    Write-Host '  -NewCertificate   replace the certificate and restart the satellite'
    Write-Host '  -Remove           remove the container (the folder is left in place)'
    Write-Host '  -Verbose          print everything (the setup log has everything either way)'
    Write-Host '  -NoPrompt         never ask for the secret: stop when one is needed and there is no -SecretFile'
    Write-Host '  -ShowPlan         print what a setup would use for -Root (KEY=VALUE lines) and exit; changes nothing'
    Write-Host '  -CheckOnly        check docker.exe, the Docker engine and the NVIDIA runtime and exit; changes nothing'
    Write-Host '  -CheckPort        with -Port N: exit 0 when the port is free, else exit 1 and print "Suggested port: <n>"'
    Write-Host '  -Help             this summary'
    Write-Host ''
    Write-Host 'After setup (each run keeps these in its setup log, <folder>\logs\setup-*.log):'
    Write-Host '  Stop:    docker stop vocalis-satellite-<id>      Start:   docker start vocalis-satellite-<id>'
    Write-Host '  Update:  run this setup file again with -Update (the setup file of a new release has its image built in)'
    Write-Host '  Remove:  run this setup file with -Root <folder> -Remove (removes the container only; the folder stays)'
    Write-Host '  After a restart the satellite comes back by itself when you sign in and Docker Desktop starts, unless you'
    Write-Host '  stopped it (or -Autostart off). Docker Desktop''s "Start Docker Desktop when you sign in" setting must be on.'
    Write-Host '  Firewall: setup never changes it. If Vocalis on another computer cannot reach the satellite, run this once in a'
    Write-Host '  PowerShell opened as administrator:'
    Write-Host '    New-NetFirewallRule -DisplayName ''Vocalis satellite <port>'' -Direction Inbound -Protocol TCP -LocalPort <port> -Action Allow -Profile Private'
    Write-Host '  The port is open on every network interface. Run a satellite only on a network you trust, and never forward'
    Write-Host '  the port from the internet.'
}

# True in the PowerShell ISE, which cannot hide what is typed at the secret prompt (its console is not a terminal).
function Test-PowerShellIse {
    param([string]$HostName)
    $HostName -match 'ISE'
}

# True when a real console is attached to this script's input. The secret prompt runs in a container started with -it,
# which Docker refuses unless its input is a terminal; a redirected input (a pipe, a file, a scheduled task) is not.
function Test-ConsoleAttached {
    try { return (-not [Console]::IsInputRedirected) } catch { return $false }
}

# True when this script's standard output is a terminal. The image pull shows Docker's own progress display only then;
# under a wrapper (the setup program) the pull is captured and shown line by line.
function Test-OutputIsTerminal {
    try { return (-not [Console]::IsOutputRedirected) } catch { return $false }
}

# Turns a -Root or -SecretFile value into a full Windows drive path, or stops with the reason. The rules are
# setup.sh's (no line break, no apostrophe) plus the comma, which separates the fields of a --mount argument, and what
# a Docker Desktop bind mount can use: a local drive path (not a network share).
function Resolve-SatellitePath {
    param([string]$Path, [string]$What)
    if ($Path -match "[\r\n]") { Stop-Setup "$What cannot contain a line break." }
    if ($Path.Contains("'")) { Stop-Setup "$What cannot contain an apostrophe: $Path" }
    if ($Path.Contains(',')) { Stop-Setup "$What cannot contain a comma (it would break the Docker mount argument): $Path" }
    if ($Path.Contains('"')) { Stop-Setup "$What cannot contain a double quote: $Path" }
    if ($Path -match '^(\\\\|//)') { Stop-Setup "$What is a network (UNC) path; use a folder on a local drive: $Path" }
    if ($Path -match '^([A-Za-z]):' -and -not (Test-Path -LiteralPath ($Matches[1] + ':\'))) { Stop-Setup "$What is on a drive that does not exist: $Path" }
    try {
        # A relative path is relative to PowerShell's current location ($PWD), not to the process's working folder, which
        # [System.IO.Path]::GetFullPath alone would use and which differs after a Set-Location (review, October 10, 2026).
        $Full = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path))
    } catch {
        if ($_.Exception.Message -match 'Cannot find drive|drive.*does not exist') { Stop-Setup "$What is on a drive that does not exist: $Path" }
        Stop-Setup "$What is not a usable path ($($_.Exception.Message)): $Path"
    }
    if ($Full -notmatch '^[A-Za-z]:\\') { Stop-Setup "$What must be on a local drive with a drive letter, for example E:\Vocalis: $Path" }
    if ($Full.Substring(2).Contains(':')) { Stop-Setup "$What cannot contain a colon after the drive letter: $Path" }
    if ($Full.Length -gt 3) { $Full = $Full.TrimEnd('\') }
    if (-not (Test-Path -LiteralPath $Full.Substring(0, 3))) { Stop-Setup "$What is on a drive that does not exist: $Path" }
    $Full
}

# The IPv4 text of $Item in its canonical form (no leading zeros), or $null when it is not a dotted IPv4 address.
function ConvertTo-CanonicalIpv4 {
    param([string]$Item)
    if ($Item -cmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') {
        $Octets = @()
        for ($Index = 1; $Index -le 4; $Index++) {
            # A leading zero is refused: some parsers read 010 as octal, so the same text could name two addresses.
            if ($Matches[$Index].Length -gt 1 -and $Matches[$Index].StartsWith('0')) { return $null }
            $Value = [int]$Matches[$Index]
            if ($Value -gt 255) { return $null }
            $Octets += $Value
        }
        return ($Octets -join '.')
    }
    $null
}

# Splits the -Address values (each may hold several, separated by commas: with `powershell -File`, a comma list reaches
# the script as one string) into IPv4 addresses for the certificate and names recorded for information. The Vocalis
# client resolves the satellite URL to an IPv4 address and checks the certificate against it (design section 9, step 4),
# so only IPv4 addresses make a satellite reachable. Order is kept and repeats are dropped.
function ConvertTo-AddressLists {
    param([string[]]$Values)
    $Ips = @()
    $Names = @()
    foreach ($Raw in @($Values)) {
        foreach ($Piece in ([string]$Raw -split ',')) {
            $Item = $Piece.Trim()
            if (-not $Item) { continue }
            $Ip = ConvertTo-CanonicalIpv4 $Item
            if ($Ip) {
                if ($Ip -match '^(0|127)\.' -or $Ip -match '^169\.254\.' -or [int]($Ip.Split('.')[0]) -ge 224) {
                    Stop-Setup "-Address $Item cannot be used: a satellite is reached on a private LAN address, not a loopback, link-local, multicast or unspecified one."
                }
                if ($Ips -notcontains $Ip) { $Ips += $Ip }
            } elseif ($Item -match '^[\d.]+$') {
                Stop-Setup "-Address $Item is not a valid IPv4 address."
            } elseif ($Item.Contains(':')) {
                Stop-Setup "-Address $Item looks like an IPv6 address. Only IPv4 addresses are used (Vocalis reaches a satellite by its IPv4 address)."
            } elseif ($Item -cmatch '^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$') {
                $Lower = $Item.ToLowerInvariant()
                if ($Lower -eq 'localhost') { Stop-Setup "-Address $Item cannot be used: localhost is always part of the certificate and reaches nothing but this computer." }
                if ($Names -notcontains $Lower) { $Names += $Lower }
            } else {
                Stop-Setup "-Address $Item is neither an IPv4 address nor a plain host name."
            }
        }
    }
    [pscustomobject]@{ Ips = @($Ips); Names = @($Names) }
}

function Test-SatelliteImageReference {
    param([string]$Reference)
    # setup.sh's rule (validate_digest_ref): an immutable digest, so a pulled tag cannot change under the satellite.
    $Reference -match '^[^\s]+@sha256:[a-fA-F0-9]{64}$'
}

function New-SatelliteId {
    $Bytes = New-Object byte[] 6
    $Generator = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $Generator.GetBytes($Bytes) } finally { $Generator.Dispose() }
    'vs-' + (($Bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# satellite.env: KEY=VALUE lines. Blank lines and # comments are skipped; the value is everything after the first '='.
function Read-SatelliteEnv {
    param([string]$Path)
    # Strict, like satellite-setup.sh (acceptance pass, October 10, 2026): the file is one this script (or the Linux one)
    # wrote, so every line is KEY=VALUE for one of the known keys, every key is there exactly once, and anything else is
    # refused by name and line rather than guessed at. The value is everything after the first '=', as written (the root
    # is not quoted). The one softening (October 11, 2026): AUTOSTART and CERT_FINGERPRINT may be absent, because a file
    # written before they existed lacks them; AUTOSTART, when present, must be on or off.
    $Values = @{}
    $FirstLine = @{}
    $Number = 0
    foreach ($Line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
        $Number++
        if (-not ($Line -cmatch '^([A-Z][A-Z_]*)=(.*)$')) {
            Stop-Setup "satellite.env ($Path) line ${Number} is not a KEY=VALUE line: '$Line'. It is not a file this setup wrote, so nothing was done."
        }
        $Key = $Matches[1]
        if ($EnvKeys -cnotcontains $Key) {
            Stop-Setup "satellite.env ($Path) line ${Number} has an unknown key '$Key': '$Line'. It is not a file this setup wrote, so nothing was done."
        }
        if ($Values.ContainsKey($Key)) {
            Stop-Setup "satellite.env ($Path) line ${Number} repeats $Key (first on line $($FirstLine[$Key])). It is not a file this setup wrote, so nothing was done."
        }
        # The value is taken before any other -match/-cnotmatch runs: each of them replaces $Matches.
        $Value = $Matches[2]
        if ($Key -ceq 'AUTOSTART' -and $Value -cnotmatch '^(on|off)$') {
            Stop-Setup "satellite.env ($Path) line ${Number} has AUTOSTART='$Value', which is neither on nor off: '$Line'. It is not a file this setup wrote, so nothing was done."
        }
        $Values[$Key] = $Value
        $FirstLine[$Key] = $Number
    }
    foreach ($Key in $EnvKeys) {
        if (-not $Values.ContainsKey($Key) -and $OptionalEnvKeys -cnotcontains $Key) { Stop-Setup "satellite.env ($Path) has no $Key line. It is not a file this setup wrote, so nothing was done." }
    }
    $Values
}

# Writes the file as UTF-8 without a BOM and with LF line endings: byte for byte what ASCII gives, which every value is
# unless the folder path has a letter outside ASCII (a profile named for its owner, say), which ASCII would turn into
# '?'. Written to a neighbor first and moved into place, so a reader never sees half a file.
function Write-SatelliteEnvText {
    param([string]$Path, [string[]]$Lines)
    $Temp = $Path + '.tmp'
    [System.IO.File]::WriteAllText($Temp, (($Lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $Temp -Destination $Path -Force
}

function New-SatelliteEnvFile {
    param([string]$Path, [hashtable]$Values)
    Write-SatelliteEnvText -Path $Path -Lines @($EnvKeys | ForEach-Object { "$_=$($Values[$_])" })
}

# Changes the given keys of an existing satellite.env in place (order kept, unknown lines kept, new keys appended; a key
# the file lacks, such as AUTOSTART in a file from before it existed, is appended in the order of $EnvKeys).
function Update-SatelliteEnv {
    param([string]$Path, [hashtable]$Changes)
    $Seen = @{}
    $Lines = @()
    foreach ($Line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
        $Index = $Line.IndexOf('=')
        $Key = if ($Index -ge 1 -and $Line -notmatch '^\s*#') { $Line.Substring(0, $Index) } else { $null }
        if ($Key -and $Changes.ContainsKey($Key)) {
            $Lines += "$Key=$($Changes[$Key])"
            $Seen[$Key] = $true
        } else {
            $Lines += $Line
        }
    }
    $Ordered = @($EnvKeys | Where-Object { $Changes.ContainsKey($_) }) + @($Changes.Keys | Where-Object { $EnvKeys -notcontains $_ } | Sort-Object)
    foreach ($Key in $Ordered) {
        if (-not $Seen.ContainsKey($Key)) { $Lines += "$Key=$($Changes[$Key])" }
    }
    Write-SatelliteEnvText -Path $Path -Lines $Lines
}

# The IPv4 facts this machine can give, as plain objects (the only place the Windows network cmdlets are called, so a
# test can feed sample data by defining stand-ins for them): Adapters (Index, Name, Description, Status), Addresses
# (InterfaceIndex, IPAddress, State) and Routes (the default routes: Index and Metric, the route's own metric plus its
# interface's, which is what Windows adds to rank routes).
function Get-SatelliteNetworkSnapshot {
    $Adapters = @(Get-NetAdapter -ErrorAction Stop | ForEach-Object {
            [pscustomobject]@{ Index = [int]$_.InterfaceIndex; Name = [string]$_.Name; Description = [string]$_.InterfaceDescription; Status = [string]$_.Status }
        })
    $Addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object {
            [pscustomobject]@{ InterfaceIndex = [int]$_.InterfaceIndex; IPAddress = [string]$_.IPAddress; State = [string]$_.AddressState }
        })
    $InterfaceMetric = @{}
    foreach ($Interface in @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction Stop)) {
        $InterfaceMetric[[int]$Interface.InterfaceIndex] = [int]$Interface.InterfaceMetric
    }
    $Routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } | ForEach-Object {
            $Index = [int]$_.InterfaceIndex
            [pscustomobject]@{ Index = $Index; Metric = [int]$_.RouteMetric + [int]$InterfaceMetric[$Index] }
        })
    [pscustomobject]@{ Adapters = $Adapters; Addresses = $Addresses; Routes = $Routes }
}

# The address rule (design section 9, step 4, "Windows"): the IPv4 addresses of adapters that are up, minus loopback,
# link-local (169.254.x.x) and virtual ones (vEthernet, WSL, Hyper-V, Docker); the primary is the address of the
# interface that holds the lowest-metric default route. Returns Primary ($null when nothing qualifies), All (primary
# first, then the rest by interface index and address), Skipped (a line per address left out, with the reason) and Note.
function Select-SatelliteAddresses {
    param($Adapters, $Addresses, $Routes)
    $ByIndex = @{}
    foreach ($Adapter in @($Adapters)) { $ByIndex[[int]$Adapter.Index] = $Adapter }
    $Kept = @()
    $Skipped = @()
    foreach ($Entry in @($Addresses)) {
        $Ip = ConvertTo-CanonicalIpv4 ([string]$Entry.IPAddress)
        $Index = [int]$Entry.InterfaceIndex
        $Adapter = $ByIndex[$Index]
        $Reason = $null
        if (-not $Ip) { $Reason = 'not an IPv4 address' }
        elseif (-not $Adapter) { $Reason = 'its adapter is unknown' }
        elseif ([string]$Adapter.Status -ne 'Up') { $Reason = "adapter $($Adapter.Name) is not up" }
        elseif ("$($Adapter.Name) $($Adapter.Description)" -match 'vEthernet|WSL|Hyper-V|Docker') { $Reason = "adapter $($Adapter.Name) is virtual" }
        elseif ($Ip -match '^127\.') { $Reason = 'loopback' }
        elseif ($Ip -match '^169\.254\.') { $Reason = 'link-local' }
        elseif ($Entry.State -and [string]$Entry.State -ne 'Preferred') { $Reason = "the address is $($Entry.State), not preferred" }
        if ($Reason) {
            $Skipped += "$($Entry.IPAddress) ($Reason)"
        } else {
            $Kept += [pscustomobject]@{ Ip = $Ip; Index = $Index; Adapter = [string]$Adapter.Name }
        }
    }
    $Kept = @($Kept | Sort-Object -Property @{ Expression = { $_.Index } }, @{ Expression = { [version]$_.Ip } } -Unique)
    $Primary = $null
    $Note = ''
    if ($Kept.Count -gt 0) {
        $KeptIndexes = @($Kept | ForEach-Object { $_.Index })
        $Best = @($Routes | Where-Object { $KeptIndexes -contains [int]$_.Index } | Sort-Object -Property @{ Expression = { [int]$_.Metric } }, @{ Expression = { [int]$_.Index } } | Select-Object -First 1)
        if ($Best.Count -gt 0) {
            $First = @($Kept | Where-Object { $_.Index -eq [int]$Best[0].Index } | Select-Object -First 1)
            $Primary = $First[0].Ip
            $Note = "primary $Primary on $($First[0].Adapter) (default route metric $($Best[0].Metric))"
        } else {
            $Primary = $Kept[0].Ip
            $Note = "no default route on a usable adapter, so the first address, $Primary, is the primary"
        }
    }
    $All = @()
    if ($Primary) { $All += $Primary }
    foreach ($Item in $Kept) { if ($All -notcontains $Item.Ip) { $All += $Item.Ip } }
    [pscustomobject]@{ Primary = $Primary; All = @($All); Skipped = @($Skipped); Note = $Note }
}

# Binds 0.0.0.0:<port> on Windows and releases it. Returns $null when the port can be bound, else a description. The
# satellite port is published on all interfaces (design section 9, "Network"), so the wildcard address is the one to try.
# It binds without listening on purpose: a listening socket on a non-loopback address is what makes Windows Defender
# Firewall pop up its "allow this app" window. bind fails with 10048 for a port in use and 10013 for an excluded one.
function Test-WindowsWildcardPort {
    param([int]$Port)
    $Socket = $null
    try {
        $Socket = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Tcp)
        $Socket.ExclusiveAddressUse = $true
        $Socket.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, $Port)))
        return $null
    } catch [System.Net.Sockets.SocketException] {
        $Code = $_.Exception.NativeErrorCode
        if ($Code -eq 10048) { return "port $Port is already in use on Windows (socket error $Code)." }
        if ($Code -eq 10013) { return "port $Port cannot be used: Windows refused the bind (socket error $Code), usually because the port is inside a reserved range. 'netsh interface ipv4 show excludedportrange protocol=tcp' lists the reserved ranges." }
        return "port $Port could not be bound (socket error $Code, $($_.Exception.Message))."
    } catch {
        return "port $Port could not be bound ($($_.Exception.Message))."
    } finally {
        if ($Socket) {
            try { $Socket.Close() } catch { Write-Hidden "Releasing the test socket on port $Port failed: $($_.Exception.Message)" }
        }
    }
}

# --mount argument text. $Source is a Windows path; Docker Desktop is given it with forward slashes (E:/...), never a
# /mnt/... path (amendment 15). Commas were refused when the root was read, so the fields cannot be split.
function New-BindMount {
    param([string]$Source, [string]$Target, [switch]$ReadOnly)
    $Text = 'type=bind,source=' + $Source.Replace('\', '/') + ',target=' + $Target
    if ($ReadOnly) { $Text += ',readonly' }
    $Text
}

# One-shot container (design section 9, "Run specification"; the token order was agreed with satellite-setup.sh on
# October 10, 2026): docker run --rm --read-only --tmpfs /tmp --user <service user> [--network none] [-it] --mount ...
# [--gpus all] --entrypoint python <image> <tool> <subcommand> [arguments]. -it is added only for the call that must
# prompt for the secret; --network none for every subcommand but fetch-model; --gpus all for check-gpu only (the real
# GPU options of the long-lived container), after the mounts.
function Get-OneShotArguments {
    param(
        [string]$ImageReference,
        [string]$Subcommand,
        [string[]]$SubcommandArguments = @(),
        [string[]]$Mounts = @(),
        [switch]$Terminal,
        [switch]$NoNetwork,
        [switch]$Gpu
    )
    $Arguments = @('run', '--rm', '--read-only', '--tmpfs', '/tmp', '--user', $ServiceUser)
    if ($NoNetwork) { $Arguments += @('--network', 'none') }
    if ($Terminal) { $Arguments += '-it' }
    foreach ($Mount in $Mounts) { $Arguments += @('--mount', $Mount) }
    if ($Gpu) { $Arguments += @('--gpus', 'all') }
    $Arguments += @('--entrypoint', 'python', $ImageReference, $AdminTool, $Subcommand)
    $Arguments += @($SubcommandArguments)
    , $Arguments
}

# The spec hash: SHA-256 of the argument list (UTF-8, joined by a line feed, no trailing line feed), as lower-case hex.
# satellite-setup.sh computes the same for the same list; a golden vector in the tests holds both to it.
function Get-SpecHash {
    param([string[]]$Arguments)
    $Sha = [System.Security.Cryptography.SHA256]::Create()
    try { $Bytes = $Sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($Arguments -join "`n"))) } finally { $Sha.Dispose() }
    ($Bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

# The long-lived container (design section 9, "Run specification"). Returns Arguments (the whole docker.exe argument
# list, starting with run -d), Hashed (the arguments after run -d without the spec label, which is what the hash covers),
# Hash (SHA-256 of those, encoded as UTF-8 and joined by a line feed, so satellite-setup.sh computes the same for the
# same arguments) and Name. $RootForward is the satellite folder spelled with forward slashes (E:/...). $Autostart is the
# recorded start-with-Docker value (October 11, 2026): on is --restart unless-stopped (the default, so the golden vector
# of the October 10 tests is unchanged), off is --restart no. The mapping is written out here, not in a helper, so the
# tests can extract this function on its own.
function Get-LongLivedSpec {
    param([string]$Id, [int]$HostPort, [string]$ImageReference, [string]$RootForward, [string]$Autostart = 'on')
    $ContainerName = "vocalis-satellite-$Id"
    $RestartPolicy = if ($Autostart -eq 'off') { 'no' } else { 'unless-stopped' }
    # --log-driver json-file is explicit (review, October 10, 2026): the two --log-opt limits below only bound the log with
    # that driver, and a machine whose Docker default is another driver would otherwise ignore or reject them.
    $Head = @('--name', $ContainerName, '--restart', $RestartPolicy, '--read-only', '--user', $ServiceUser,
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m', '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
        '--label', "vocalis.satellite.id=$Id")
    $Tail = @('--publish', "0.0.0.0:${HostPort}:${ContainerPort}",
        '--mount', (New-BindMount "$RootForward/data" '/data/vocalis-satellite' -ReadOnly),
        '--mount', (New-BindMount "$RootForward/secrets" '/run/secrets' -ReadOnly),
        '--mount', (New-BindMount "$RootForward/logs" '/logs/vocalis-satellite'),
        '--mount', (New-BindMount "$RootForward/work" '/work/vocalis-satellite'),
        '--mount', (New-BindMount "$RootForward/cache" '/cache/vocalis'),
        '--mount', (New-BindMount "$RootForward/models" '/models/vocalis' -ReadOnly),
        '--gpus', 'all', $ImageReference)
    $Hashed = @($Head) + @($Tail)
    $Hash = Get-SpecHash $Hashed
    $Arguments = @('run', '-d') + @($Head) + @('--label', "vocalis.satellite.spec=$Hash") + @($Tail)
    [pscustomobject]@{ Arguments = @($Arguments); Hashed = @($Hashed); Hash = $Hash; Name = $ContainerName }
}

# The container's restart policy for a start-with-Docker value (the same mapping Get-LongLivedSpec writes).
function Get-AutostartPolicy {
    param([string]$Autostart)
    if ($Autostart -eq 'off') { 'no' } else { 'unless-stopped' }
}

# A container's label cannot be rewritten, so one made under the other start-with-Docker value (and later changed with
# docker update) still carries the hash of the other specification. A container whose label equals the hash of the
# present specification with EITHER restart value has the current settings (design, October 11, 2026); the caller then
# makes its actual restart policy match the recorded value.
function Test-SpecLabelCurrent {
    param($Container, $SpecOn, $SpecOff)
    [bool]($Container -and ($Container.SpecLabel -eq $SpecOn.Hash -or $Container.SpecLabel -eq $SpecOff.Hash))
}

# The container named $ContainerName: $null when there is none, else Status, RestartCount, StartedAt (the daemon's own
# clock, which is what `docker logs --since` compares with), SpecLabel (empty when the label is missing) and
# RestartPolicy (the policy name; an empty one is read as no, Docker's default).
function Get-SatelliteContainer {
    param([string]$ContainerName)
    $Format = '{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{index .Config.Labels "vocalis.satellite.spec"}}|{{.HostConfig.RestartPolicy.Name}}'
    $Result = Invoke-LoggedDocker -Arguments @('container', 'inspect', '--format', $Format, $ContainerName) -TimeoutSeconds $CheckTimeoutSeconds
    if ($Result.TimedOut) { Stop-Setup "docker container inspect did not answer within $CheckTimeoutSeconds s." }
    if ($Result.ExitCode -ne 0) {
        if ($Result.Output -match 'No such (object|container)') { return $null }
        Stop-Setup ("docker container inspect failed with exit code $($Result.ExitCode): " + (Get-FirstLine $Result.Output))
    }
    $Parts = (Get-FirstLine $Result.Output).Split('|')
    if ($Parts.Count -lt 5) { Stop-Setup "docker container inspect answered something unexpected: $(Get-FirstLine $Result.Output)" }
    $Policy = if ($Parts[4]) { $Parts[4] } else { 'no' }
    [pscustomobject]@{ Status = $Parts[0]; RestartCount = [int]$Parts[1]; StartedAt = $Parts[2]; SpecLabel = $Parts[3]; RestartPolicy = $Policy }
}

# Makes the container's restart policy the one for $Autostart (docker update --restart; it changes neither the container's
# start time nor its state, checked on a Windows and a Linux machine on October 11, 2026). Returns the call's result; the caller decides
# what a refusal means.
function Set-ContainerRestartPolicy {
    param([string]$ContainerName, [string]$Autostart)
    Invoke-LoggedDocker -Arguments @('update', '--restart', (Get-AutostartPolicy $Autostart), $ContainerName) -TimeoutSeconds 120
}

# Prints the end of the container's log, so a start that did not work shows its reason.
function Write-ContainerLogTail {
    param([string]$ContainerName)
    $Tail = Invoke-LoggedDocker -Arguments @('logs', '--tail', '30', $ContainerName) -TimeoutSeconds $CheckTimeoutSeconds
    Write-Screen "The end of the satellite log ($ContainerName):"
    if ($Tail.Output) { Write-Screen $Tail.Output } else { Write-Screen '(the log is empty)' }
}

# The wait after a create, start or restart (design section 9, "The wait"): up to $ListenWaitSeconds for a
# `listening on https://` line in the log written since this run of the container began, stopping early when the
# container is no longer running or has restarted. The bound is measured on the clock (Get-Date, which a test stands in
# for together with Start-Sleep) from the start of the wait, so it covers every call and sleep in the loop and a slow
# docker call cannot stretch it (review, October 10, 2026). Returns $true when the satellite is listening.
function Wait-SatelliteListening {
    param([string]$ContainerName)
    $Begin = Get-SatelliteContainer $ContainerName
    if (-not $Begin) { Stop-Setup "The container $ContainerName is not there after it was started." }
    Write-Detail "Waiting up to $ListenWaitSeconds s for the satellite to report that it is listening (container started $($Begin.StartedAt))..."
    $WaitStart = Get-Date
    $Waited = 0.0
    $LoggedLines = 0
    while ($Waited -lt $ListenWaitSeconds) {
        $Now = Get-SatelliteContainer $ContainerName
        if (-not $Now) {
            Write-Screen "The container $ContainerName disappeared while setup was waiting for it."
            return $false
        }
        if ($Now.Status -ne 'running' -or $Now.StartedAt -ne $Begin.StartedAt -or $Now.RestartCount -ne $Begin.RestartCount) {
            Write-Screen "The satellite stopped before it was listening (state $($Now.Status), restarts $($Begin.RestartCount) -> $($Now.RestartCount), started $($Begin.StartedAt) -> $($Now.StartedAt))."
            Write-ContainerLogTail $ContainerName
            return $false
        }
        $Logs = Invoke-LoggedDocker -Arguments @('logs', '--since', $Begin.StartedAt, $ContainerName) -TimeoutSeconds $CheckTimeoutSeconds -SkipOutputLog
        # Both streams of the log are read (Output is stdout then stderr): the satellite logs to stderr. Each poll returns
        # everything since the start, so only the lines not yet logged are added to the setup log.
        $LogLines = @($Logs.Output -split "[\r\n]+" | Where-Object { $_.Trim() })
        for ($Index = $LoggedLines; $Index -lt $LogLines.Count; $Index++) { Add-LogLine "  satellite log: $($LogLines[$Index])" }
        $LoggedLines = $LogLines.Count
        $Line = ($LogLines | Where-Object { $_ -match 'listening on https://' } | Select-Object -First 1)
        if ($Line) {
            Write-Detail "The satellite is listening after about $([int]((Get-Date) - $WaitStart).TotalSeconds) s: $($Line.Trim())"
            return $true
        }
        Start-Sleep -Seconds $ListenPollSeconds
        $Waited = ((Get-Date) - $WaitStart).TotalSeconds
    }
    Write-Screen "The satellite did not report that it is listening within $ListenWaitSeconds s."
    Write-ContainerLogTail $ContainerName
    return $false
}

# key=value lines printed by satellite_admin.py (card=, fingerprint=, ip=, dns=, secret=, certificate=).
function Get-AdminValues {
    param([string]$Text, [string]$Key)
    @($Text -split "[\r\n]+" | ForEach-Object { if ($_ -match ('^' + [regex]::Escape($Key) + '=(.*)$')) { $Matches[1].Trim() } })
}

# What a captured call of the in-image tool shows on the screen (design table, October 11, 2026): its INFO: lines are hidden
# (-Verbose shows them), its raw key=value result lines are hidden (the caller shows the ones that matter), and any other
# line, from either stream, is shown. Everything is in the log already (Invoke-LoggedDocker).
function Show-ToolMessages {
    param($Result, [string]$HiddenKeys = 'card|fingerprint|ip|dns|secret|certificate')
    foreach ($Line in (@($Result.StdOut -split "[\r\n]+") + @($Result.StdErr -split "[\r\n]+"))) {
        if (-not $Line.Trim()) { continue }
        if ($Line -match "^($HiddenKeys)=") { continue }
        if ($Line -match '^\s*INFO:') { Write-Detail "  $Line" } else { Write-Screen "  $Line" }
    }
}

# The certificate's fingerprint and addresses, read back from the folder with the `show` container (the one place that
# knows them). Returns Fingerprint, Ips and Names; stops the run when there is no readable certificate. The tool reports the
# certificate itself, so its lists include ip=127.0.0.1 and dns=localhost (and an IPv6 literal if one was ever given). Those
# are not addresses to use or to record: only IPv4 addresses that are not loopback, and names other than localhost, go on.
# The two summary lines are for -Verbose and the log; the closing lines carry what the user needs.
function Get-CertificateReport {
    param([string]$ImageReference, [string]$CacheMount, [string]$DataSource)
    $ShowArguments = Get-OneShotArguments -ImageReference $ImageReference -Subcommand 'show' -Mounts @($CacheMount, (New-BindMount $DataSource '/data/vocalis-satellite' -ReadOnly)) -NoNetwork
    $ShowResult = Invoke-LoggedDocker -Arguments $ShowArguments -TimeoutSeconds $OneShotSeconds
    if ($ShowResult.TimedOut) { Stop-Setup "Reading the certificate did not finish within $OneShotSeconds s." }
    if ($ShowResult.ExitCode -ne 0) { Stop-Setup ("There is no readable certificate in this satellite folder (exit code $($ShowResult.ExitCode)): " + (Get-FirstLine $ShowResult.StdErr) + ' Nothing was started and nothing was replaced.') }
    Show-ToolMessages $ShowResult
    $Report = [pscustomobject]@{
        Fingerprint = [string](Get-AdminValues $ShowResult.StdOut 'fingerprint' | Select-Object -First 1)
        Ips = @(Get-AdminValues $ShowResult.StdOut 'ip' | Where-Object { $Canonical = ConvertTo-CanonicalIpv4 $_; $Canonical -and $Canonical -notmatch '^127\.' })
        Names = @(Get-AdminValues $ShowResult.StdOut 'dns' | Where-Object { $_ -and $_ -ne 'localhost' })
    }
    Write-Detail "Certificate fingerprint: $($Report.Fingerprint)"
    Write-Detail "Certificate covers: IPv4 $(if ($Report.Ips.Count) { $Report.Ips -join ', ' } else { '(none)' }); names $(if ($Report.Names.Count) { $Report.Names -join ', ' } else { '(none)' })"
    $Report
}

# A DHCP change or a new -Address that the certificate does not cover shows up only as a certificate error in Vocalis, so
# say it here (design section 9, "Later runs"). A warning, not a failure.
function Write-CoverageWarning {
    param($Report, [string]$PrimaryAddress, $Addresses)
    $Uncovered = @()
    if ($PrimaryAddress -and $Report.Ips -notcontains $PrimaryAddress) { $Uncovered += $PrimaryAddress }
    foreach ($Ip in $Addresses.Ips) { if ($Report.Ips -notcontains $Ip -and $Uncovered -notcontains $Ip) { $Uncovered += $Ip } }
    foreach ($DnsName in $Addresses.Names) { if ($Report.Names -notcontains $DnsName) { $Uncovered += $DnsName } }
    if ($Uncovered.Count -gt 0) {
        Write-Screen "WARNING: the certificate does not cover $($Uncovered -join ', '). Vocalis will show a certificate error for it until the certificate is replaced: run this command again with -NewCertificate (and upload the new file in Vocalis)."
    }
}

# The satellite's URLs, the primary address first when the certificate has it (the tool lists addresses in numeric order,
# so only this script knows which one is the computer's main address). Loopback is never a URL.
function Get-SatelliteUrls {
    param([string[]]$Ips, [string]$Primary, [int]$HostPort)
    $UrlIps = @($Ips | Where-Object { $_ -and $_ -notmatch '^127\.' })
    $Urls = @()
    if ($Primary -and $UrlIps -contains $Primary) { $Urls += "https://${Primary}:${HostPort}" }
    foreach ($Ip in $UrlIps) { if ($Ip -ne $Primary) { $Urls += "https://${Ip}:${HostPort}" } }
    @($Urls)
}

# ---- the result file (design, "Script changes" item 4) -----------------------------------------------------------------

# yes, no or unknown: is the satellite's container running now? (restarting is not running.) Asked of Docker at the end of
# every run, for the result file; unknown when Docker does not answer, and not asked at all when the failure was that Docker
# is missing or not answering.
function Get-RunningState {
    param([string]$ContainerName)
    if (-not $script:DockerPath -or -not $ContainerName -or $script:FailureExitCode -in @(10, 11)) { return 'unknown' }
    try {
        $Result = Invoke-LoggedDocker -Arguments @('container', 'inspect', '--format', '{{.State.Status}}', $ContainerName) -TimeoutSeconds 20
        if ($Result.TimedOut) { return 'unknown' }
        if ($Result.ExitCode -ne 0) {
            if ($Result.Output -match 'No such (object|container)') { return 'no' }
            return 'unknown'
        }
        if ((Get-FirstLine $Result.StdOut).Split('|')[0] -eq 'running') { return 'yes' }
        return 'no'
    } catch {
        Add-LogLine "Could not ask Docker whether the satellite is running: $($_.Exception.Message)"
        return 'unknown'
    }
}

# MODE: the first that applies of remove, autostart (the small operation), update, renew (-NewSecret, -NewCertificate or
# both), first (when the run began the folder had no finished setup) and rerun.
function Get-RunMode {
    if ($Remove) { return 'remove' }
    if ($script:IsAutostartOnly) { return 'autostart' }
    if ($Update) { return 'update' }
    if ($NewSecret -or $NewCertificate) { return 'renew' }
    if ($script:ModeFirst) { return 'first' }
    'rerun'
}

# <root>\setup-result.txt: UTF-8 KEY=VALUE lines without a byte-order mark, written to a temporary name and renamed into
# place, on success and on failure. No value holds a line break and none is the secret. Not called before satellite.env
# is accepted or created ($script:ResultOn). A result file that cannot be written is a warning, not a second failure.
function Write-SetupResult {
    param([int]$Code, [string]$Failure = '')
    if (-not $script:ResultOn) { return }
    try {
        $State = $script:R
        # RUNNING is what Docker says now (yes only for running; restarting or missing is no; unknown when Docker does not
        # answer), asked once more here in every mode, success or failure.
        $State.Running = Get-RunningState $State.Container
        # The URLS are primary-first in every mode, also for a run that stopped before the addresses were read.
        if (-not $script:PrimaryAddress) {
            try {
                $Late = Get-SatelliteNetworkSnapshot
                $script:PrimaryAddress = (Select-SatelliteAddresses -Adapters $Late.Adapters -Addresses $Late.Addresses -Routes $Late.Routes).Primary
            } catch {
                Add-LogLine "Could not read this computer's network adapters for the result file: $($_.Exception.Message)"
            }
        }
        $CertFile = Join-Path $State.Root 'data\certs\cert.pem'
        $HasCert = Test-Path -LiteralPath $CertFile -PathType Leaf
        $Urls = if ($HasCert) { @(Get-SatelliteUrls -Ips $State.Ips -Primary $script:PrimaryAddress -HostPort $State.Port) } else { @() }
        # Each line is one string in its own parentheses or quotes: in an array literal the comma binds tighter than +.
        $Finished = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
        $Lines = @(
            'SCHEMA=1',
            "FINISHED=$Finished",
            "MODE=$(Get-RunMode)",
            "EXIT_CODE=$Code",
            "FAILURE=$(ConvertTo-OneLine $Failure)",
            "SATELLITE_ID=$($State.Id)",
            "NAME=$($State.Name)",
            "PORT=$($State.Port)",
            "IMAGE=$($State.Image)",
            "CONTAINER=$($State.Container)",
            "RUNNING=$($State.Running)",
            "AUTOSTART=$($State.Autostart)",
            "URLS=$($Urls -join ',')",
            "CERTIFICATE_FILE=$(if ($HasCert) { $CertFile } else { '' })",
            "FINGERPRINT=$(if ($HasCert) { $State.Fingerprint } else { '' })",
            "MADE_SECRET=$($State.MadeSecret)",
            "MADE_CERTIFICATE=$($State.MadeCertificate)",
            "VOCALIS_STEPS=$($State.Steps)",
            "LOG_FILE=$($script:LogPath)")
        Write-SatelliteEnvText -Path $script:ResultPath -Lines $Lines
        Add-LogLine "Wrote the result file $($script:ResultPath): mode $(Get-RunMode), exit code $Code, running $($State.Running), steps $($State.Steps)."
    } catch {
        Write-Screen "WARNING: the result file $($script:ResultPath) could not be written ($($_.Exception.Message))."
    }
}

# ---- the plumbing modes (design, "Script changes" item 7) --------------------------------------------------------------

# One plain line per check: "OK   name: detail", "FAIL name: detail Fix: how to fix it", "SKIP name: why" (the form
# packaging/setup.ps1 -CheckOnly prints). Never logged: -CheckOnly writes no file.
function Write-CheckLine {
    param([string]$Status, [string]$CheckName, [string]$Detail, [string]$Fix)
    $Line = '{0,-4} {1}: {2}' -f $Status, $CheckName, $Detail
    if ($Fix) { $Line += ' Fix: ' + $Fix }
    Write-Host $Line
}

# -CheckOnly: docker.exe, the engine, the NVIDIA runtime (the test setup.ps1 -CheckOnly makes, since the in-image check
# needs the image), each bounded; every check that can run is run. Returns the exit code: 0, or the first failure's (10 and
# 11 as in the table at the top, and 14 for the runtime; 12 stays the in-image card check).
function Invoke-SatelliteCheckOnly {
    $Timeout = "did not answer within $CheckTimeoutSeconds s"
    $Failures = @()
    $Engine = $false
    $DockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $DockerCommand) {
        Write-CheckLine 'FAIL' 'docker.exe' 'not found on PATH.' 'Install Docker Desktop for Windows, start it, and retry.'
        $Failures += [pscustomobject]@{ Code = 10; Name = 'docker.exe' }
        Write-CheckLine 'SKIP' 'docker engine' 'docker.exe is missing.'
    } else {
        Write-CheckLine 'OK' 'docker.exe' "found at $($DockerCommand.Source)."
        $Info = Invoke-Bounded -FileName $DockerCommand.Source -Arguments @('info') -TimeoutSeconds $CheckTimeoutSeconds
        if ($Info.TimedOut) {
            Write-CheckLine 'FAIL' 'docker engine' "docker info $Timeout." 'Start Docker Desktop and wait until it reports the engine is running, then retry.'
            $Failures += [pscustomobject]@{ Code = 11; Name = 'docker engine' }
        } elseif ($Info.ExitCode -ne 0) {
            Write-CheckLine 'FAIL' 'docker engine' ("docker info failed with exit code $($Info.ExitCode): " + (Get-FirstLine $Info.Output)) 'Start Docker Desktop and wait until it reports the engine is running, then retry.'
            $Failures += [pscustomobject]@{ Code = 11; Name = 'docker engine' }
        } else {
            Write-CheckLine 'OK' 'docker engine' "answering ($($Info.Milliseconds) ms)."
            $Engine = $true
        }
    }
    if (-not $Engine) {
        Write-CheckLine 'SKIP' 'NVIDIA runtime' 'the Docker engine is not answering.'
    } else {
        $Runtimes = Invoke-Bounded -FileName $DockerCommand.Source -Arguments @('info', '--format', '{{json .Runtimes}}') -TimeoutSeconds $CheckTimeoutSeconds
        if ($Runtimes.TimedOut) {
            Write-CheckLine 'FAIL' 'NVIDIA runtime' "docker info $Timeout." 'Restart Docker Desktop and retry.'
            $Failures += [pscustomobject]@{ Code = 14; Name = 'NVIDIA runtime' }
        } elseif ($Runtimes.ExitCode -ne 0 -or $Runtimes.Output -notmatch '(?i)nvidia') {
            Write-CheckLine 'FAIL' 'NVIDIA runtime' 'not visible to Docker.' 'Install the NVIDIA driver, make sure Docker Desktop is using the WSL 2 backend with GPU support, and retry; docker info should list an nvidia runtime.'
            $Failures += [pscustomobject]@{ Code = 14; Name = 'NVIDIA runtime' }
        } else {
            Write-CheckLine 'OK' 'NVIDIA runtime' "visible to Docker ($($Runtimes.Milliseconds) ms)."
        }
    }
    if ($Failures.Count -eq 0) {
        Write-Host 'Prerequisites: all checks passed.'
        return 0
    }
    $First = @($Failures | Sort-Object -Property Code)[0]
    # No exit code or internal name on the line (October 11, 2026): it is shown on a setup program page. The
    # exit code itself is returned below and does not change.
    Write-Host "Prerequisites: $($Failures.Count) $(if ($Failures.Count -eq 1) { 'check' } else { 'checks' }) failed."
    [int]$First.Code
}

# -CheckPort -Port N: the existing bind test. Exit 0 when the port is free; otherwise exit 1 with the reason and a line
# "Suggested port: <n>" (the next port above that can be bound, else the nearest below).
function Invoke-SatelliteCheckPort {
    param([int]$PortToCheck)
    $Problem = Test-WindowsWildcardPort $PortToCheck
    if (-not $Problem) {
        Write-Host "OK   port ${PortToCheck}: can be bound on all interfaces on Windows."
        return 0
    }
    Write-Host "FAIL port ${PortToCheck}: $Problem"
    $Suggestion = $null
    for ($Candidate = $PortToCheck + 1; $Candidate -le [Math]::Min(65535, $PortToCheck + 200) -and -not $Suggestion; $Candidate++) {
        if (-not (Test-WindowsWildcardPort $Candidate)) { $Suggestion = $Candidate }
    }
    for ($Candidate = $PortToCheck - 1; $Candidate -ge [Math]::Max(1024, $PortToCheck - 200) -and -not $Suggestion; $Candidate--) {
        if (-not (Test-WindowsWildcardPort $Candidate)) { $Suggestion = $Candidate }
    }
    if ($Suggestion) { Write-Host "Suggested port: $Suggestion" } else { Write-Host 'Suggested port: none found' }
    1
}

# Puts a file's earlier bytes back (a temporary neighbor, then moved into place), for the one case where a recorded change
# has to be undone: the small -Autostart operation when Docker refuses the matching docker update.
function Restore-FileBytes {
    param([string]$Path, [byte[]]$Bytes)
    $Temp = $Path + '.tmp'
    [System.IO.File]::WriteAllBytes($Temp, $Bytes)
    Move-Item -LiteralPath $Temp -Destination $Path -Force
}

# The setup flow stays at script scope on purpose: the one call that prompts for the secret must be a direct native
# call with the console attached (setup.ps1 records the same trap beside its call to setup.sh: a bounded wrapper
# closes the program's input, and a function whose output is captured turns the prompt into buffered pipe text).
$ExitCode = 1
$FailureExitCode = $null
$DockerPath = $null
try {
    if ($Help) {
        Show-Help
        exit 0
    }

    # ---- the plumbing modes: stand-alone, no banner, no step headers, no log, no result file, no change -------------------
    $PlumbingGiven = @()
    if ($ShowPlan) { $PlumbingGiven += '-ShowPlan' }
    if ($CheckOnly) { $PlumbingGiven += '-CheckOnly' }
    if ($CheckPort) { $PlumbingGiven += '-CheckPort' }
    if ($PlumbingGiven.Count -gt 1) { Stop-Setup ("$($PlumbingGiven -join ' and ') cannot be combined.") }
    if ($PlumbingGiven.Count -eq 1) {
        $AllowedWithPlumbing = if ($ShowPlan) { @('ShowPlan', 'Root', 'Port', 'Name', 'Address') }
        elseif ($CheckOnly) { @('CheckOnly', 'NoPrompt') }
        else { @('CheckPort', 'Port', 'NoPrompt') }
        $NotAllowed = @($PSBoundParameters.Keys | Where-Object { $_ -notin $AllowedWithPlumbing -and $_ -notin $CommonParameterNames })
        if ($NotAllowed.Count -gt 0) {
            Stop-Setup ("$($PlumbingGiven[0]) goes with only -$($AllowedWithPlumbing[1..($AllowedWithPlumbing.Count - 1)] -join ', -'); remove: -" + ($NotAllowed -join ', -') + '.')
        }
    }
    if ($CheckOnly) { exit (Invoke-SatelliteCheckOnly) }
    if ($CheckPort) { exit (Invoke-SatelliteCheckPort -PortToCheck $Port) }

    # ---- Step 1: checks. Nothing is created until every one has passed. -----------------------------------------------
    if (-not $ShowPlan) { Write-Screen 'Vocalis satellite setup for Windows' }
    if ($script:EncodingNote) { Write-Hidden $script:EncodingNote }
    $AutostartGiven = $PSBoundParameters.ContainsKey('Autostart')
    $AutostartText = $null
    # -Autostart with none of -Update, -NewSecret, -NewCertificate and -Remove is the small operation when the folder is a
    # satellite folder (decided below, once the folder has been read); it has two steps like -Remove, so the step count
    # looks at whether the folder is one before the first header is printed.
    $AutostartCandidate = $AutostartGiven -and -not ($Update -or $NewSecret -or $NewCertificate -or $Remove) -and -not $ShowPlan
    $StepCount = 8
    if ($Remove) {
        $StepCount = 2
    } elseif ($AutostartCandidate) {
        try {
            $ProbeRoot = if ($Root) { $Root } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'VocalisDocker\satellite' } else { '' }
            if ($ProbeRoot -and (Test-Path -LiteralPath (Join-Path (Resolve-SatellitePath -Path $ProbeRoot -What 'The satellite folder') 'satellite.env') -PathType Leaf)) { $StepCount = 2 }
        } catch {
            Write-Hidden "The step count was left at 8 because the folder could not be looked at yet ($($_.Exception.Message)); the checks below report it."
        }
        $FailureExitCode = $null
    }
    if (-not $ShowPlan) { Write-Step 1 'Checks' }
    if (Test-PowerShellIse -HostName $Host.Name) {
        Stop-Setup 'This is the PowerShell ISE. Run setup in a regular PowerShell window (Start menu, Windows PowerShell): the ISE cannot hide the secret as it is typed.'
    }
    if ($AutostartGiven) {
        $AutostartText = ([string]$Autostart).Trim().ToLowerInvariant()
        if ($AutostartText -cnotmatch '^(on|off)$') { Stop-Setup "-Autostart must be on or off; '$Autostart' is neither." }
    }
    if ($Remove) {
        $Others = @($PSBoundParameters.Keys | Where-Object { $_ -notin @('Remove', 'Root', 'Verbose', 'Debug', 'NoPrompt') })
        if ($Others.Count -gt 0) { Stop-Setup ("-Remove stands alone (only -Root may go with it); remove: -" + ($Others -join ', -') + '.') }
    }
    if ($Update -and -not ($PSBoundParameters.ContainsKey('Image') -and $Image) -and -not $DefaultImageCuda) {
        Stop-Setup '-Update needs the image to switch to: this copy of the script has no default image, so pass -Image <name>@sha256:<64 hex digits> with it (a newer release''s setup file has its image built in).'
    }
    if ($Update -and ($NewSecret -or $NewCertificate)) { Stop-Setup '-Update cannot be combined with -NewSecret or -NewCertificate; run them one at a time.' }

    $RootGiven = $Root
    if (-not $RootGiven) {
        if (-not $env:LOCALAPPDATA) { Stop-Setup 'LOCALAPPDATA is not set, so there is no default folder. Pass -Root <folder>.' }
        $RootGiven = Join-Path $env:LOCALAPPDATA 'VocalisDocker\satellite'
    }
    $RootFull = Resolve-SatellitePath -Path $RootGiven -What 'The satellite folder'
    # The Windows spelling Docker Desktop is given for every mount source: forward slashes (E:/...), never /mnt/...
    $RootForward = $RootFull.Replace('\', '/').TrimEnd('/')
    $SecretFileFull = $null
    if ($SecretFile) {
        $SecretFileFull = Resolve-SatellitePath -Path $SecretFile -What 'The -SecretFile path'
        if (-not (Test-Path -LiteralPath $SecretFileFull -PathType Leaf)) { Stop-Setup "The -SecretFile '$SecretFileFull' is not an existing file." }
    }
    $Addresses = ConvertTo-AddressLists -Values $Address

    # The folder: empty or missing (a new satellite), or one that holds satellite.env (an existing one). Anything else
    # is left alone.
    $EnvPath = Join-Path $RootFull 'satellite.env'
    if (Test-Path -LiteralPath $RootFull -PathType Leaf) { Stop-Setup "'$RootFull' is a file, not a folder." }
    $IsExisting = Test-Path -LiteralPath $EnvPath -PathType Leaf
    if (-not $IsExisting -and (Test-Path -LiteralPath $RootFull -PathType Container)) {
        $Entries = @(Get-ChildItem -LiteralPath $RootFull -Force)
        if ($Entries.Count -gt 0) {
            Stop-Setup "The folder '$RootFull' is not empty and is not a satellite folder (it has no satellite.env), so it is left alone. Choose an empty folder with -Root."
        }
    }
    if ($Remove -and -not $IsExisting) { Stop-Setup "There is no satellite folder at '$RootFull' (no satellite.env), so there is nothing to remove." }
    if ($Update -and -not $IsExisting) { Stop-Setup "There is no satellite folder at '$RootFull' (no satellite.env), so there is nothing to update. Run the command without -Update to set one up." }
    $IsAutostartOnly = $IsExisting -and $AutostartCandidate

    # What the folder holds now (design, "Script changes" item 4: MODE is first when the run began with no finished setup,
    # that is no satellite.env, or a secret or certificate still to be made).
    $SecretPath = Join-Path $RootFull 'secrets\vocalis-satellite-master'
    $CertPath = Join-Path $RootFull 'data\certs\cert.pem'
    $KeyPath = Join-Path $RootFull 'data\certs\key.pem'
    $YamlPath = Join-Path $RootFull 'data\satellite.yaml'
    $HaveSecret = Test-Path -LiteralPath $SecretPath -PathType Leaf
    $HaveCert = (Test-Path -LiteralPath $CertPath -PathType Leaf) -and (Test-Path -LiteralPath $KeyPath -PathType Leaf)
    $HaveYaml = Test-Path -LiteralPath $YamlPath -PathType Leaf
    $ModeFirst = (-not $IsExisting) -or (-not $HaveSecret) -or (-not $HaveCert)
    # The one definition of "this satellite's setup is finished" (October 11, 2026): satellite.env, the secret,
    # the certificate AND the satellite's configuration file all exist. -ShowPlan prints it as SETUP_FINISHED, and the rule
    # that lets a different -Image be adopted on a folder whose setup never finished uses the same value. (MODE stays as
    # the design's item 4 words it, a secret or certificate still to be made: it picks the closing lines, which are
    # decided by those two alone; a folder lacking only its configuration file is rebuilt by the provisioning step.)
    $SetupFinished = $IsExisting -and $HaveSecret -and $HaveCert -and $HaveYaml
    $ArgumentNames = ($PSBoundParameters.Keys | Sort-Object) -join ', '

    # The settings of this satellite: recorded ones for an existing folder, else the ones just given.
    $SatelliteName = $null
    $RecordedAutostart = 'on'
    $RecordedFingerprint = ''
    if ($IsExisting) {
        $Recorded = Read-SatelliteEnv $EnvPath
        foreach ($Key in @('SATELLITE_ID', 'GPU_VARIANT', 'SATELLITE_ROOT', 'SATELLITE_IMAGE', 'SATELLITE_PORT', 'SATELLITE_NAME', 'SERVICE_UID', 'SERVICE_GID')) {
            if (-not $Recorded[$Key]) { Stop-Setup "satellite.env ($EnvPath) has an empty $Key. Remove that folder's contents or choose another -Root." }
        }
        if ([string]$Recorded['SATELLITE_ID'] -cnotmatch '^vs-[0-9a-f]{12}$') { Stop-Setup "satellite.env records an invalid SATELLITE_ID: '$($Recorded['SATELLITE_ID'])'." }
        if ([string]$Recorded['GPU_VARIANT'] -ne 'cuda') {
            Stop-Setup "This folder was set up for GPU type '$($Recorded['GPU_VARIANT'])'. Windows supports NVIDIA (cuda) only, and the GPU type of an existing folder is fixed."
        }
        if ([string]$Recorded['SATELLITE_PORT'] -cnotmatch '^\d{1,5}$') { Stop-Setup "satellite.env records an invalid SATELLITE_PORT: '$($Recorded['SATELLITE_PORT'])'." }
        $SatelliteId = [string]$Recorded['SATELLITE_ID']
        $SatellitePort = [int]$Recorded['SATELLITE_PORT']
        $SatelliteName = [string]$Recorded['SATELLITE_NAME']
        $SatelliteImage = [string]$Recorded['SATELLITE_IMAGE']
        if ($Recorded.ContainsKey('AUTOSTART')) { $RecordedAutostart = [string]$Recorded['AUTOSTART'] }
        if ($Recorded.ContainsKey('CERT_FINGERPRINT')) { $RecordedFingerprint = [string]$Recorded['CERT_FINGERPRINT'] }
        # A copy of a satellite folder carries the original's satellite.env, so the same ID and container name. Running
        # setup on the copy would remove the original's container and put one on the copy (review, October 10, 2026).
        $RecordedRoot = [string]$Recorded['SATELLITE_ROOT']
        if ($RecordedRoot -and -not [string]::Equals($RecordedRoot.TrimEnd('\'), $RootFull.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            Stop-Setup ("This folder appears to have been moved or copied: satellite.env records the satellite folder as '$RecordedRoot', but this is '$RootFull'. " +
                "Setting up here would take the container away from the original folder. Set up a new satellite in a new folder with -Root, " +
                "or, if you moved this folder on purpose, run -Remove on the old path first and then correct the SATELLITE_ROOT line in satellite.env.")
        }
        # satellite.env is accepted (read, valid, and this folder's own): from here the old result file is gone, the log
        # is open and the result file will be written at the end. A refusal above wrote neither.
        if (-not $ShowPlan) {
            Start-SetupArtifacts -RootFull $RootFull -ArgumentNames $ArgumentNames
            $script:R.Id = $SatelliteId; $script:R.Name = $SatelliteName; $script:R.Port = $SatellitePort; $script:R.Image = $SatelliteImage
            $script:R.Container = "vocalis-satellite-$SatelliteId"; $script:R.Autostart = $RecordedAutostart
            $script:R.Ips = @(([string]$Recorded['IP_ADDRESSES']) -split ',' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
            $script:R.Fingerprint = $RecordedFingerprint
            if ($script:EncodingNote) { Write-Hidden $script:EncodingNote }
        }
        if ($PSBoundParameters.ContainsKey('Port') -and $Port -ne $SatellitePort) {
            Stop-Setup "This satellite folder uses port $SatellitePort, and the port of an existing folder is fixed; -Port $Port is refused. Run without -Port, or remove the satellite and start in a new folder."
        }
        if ($PSBoundParameters.ContainsKey('Name') -and $Name.ToLowerInvariant() -cne $SatelliteName) {
            Stop-Setup "This satellite folder is named '$SatelliteName', and the name of an existing folder is fixed; -Name $Name is refused."
        }
    } else {
        if ($NewSecret -or $NewCertificate) {
            Stop-Setup "There is no satellite folder at '$RootFull' (no satellite.env), so there is no secret or certificate to replace. Run the command without -NewSecret and -NewCertificate to set it up."
        }
        $SatelliteId = New-SatelliteId
        $SatellitePort = $Port
        # Lower case, like the default (the computer name in lower case) and like satellite-setup.sh.
        $SatelliteName = if ($PSBoundParameters.ContainsKey('Name')) { $Name.ToLowerInvariant() } else { [System.Environment]::MachineName.ToLowerInvariant() }
        $SatelliteImage = $null
    }
    if ($SatelliteName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') {
        Stop-Setup "The satellite name '$SatelliteName' must start with a letter or digit and use only letters, digits, '.', '_' and '-' (63 characters at most). Pass -Name."
    }
    # Start with Docker: the value given now, else the recorded one (a file from before the setting reads as on).
    $AutostartWanted = if ($AutostartText) { $AutostartText } elseif ($IsExisting) { $RecordedAutostart } else { 'on' }

    if (-not $ShowPlan) {
        # The image: the one given (it must be a digest reference), else the recorded one, else the stamped default.
        $ImageGiven = $PSBoundParameters.ContainsKey('Image') -and $Image
        if ($ImageGiven -and -not (Test-SatelliteImageReference $Image)) { Stop-Setup "-Image must end in @sha256:<64 hex digits>; '$Image' does not." }
        if ($IsExisting -and $ImageGiven -and -not $Update -and $Image -cne $SatelliteImage) {
            # A folder whose setup never finished (same test as the -Update refusal below, $SetupFinished) has never run from
            # the image it records, so there is nothing to update: a plain run given another image adopts it and records it
            # now, then carries on as the resumed first setup (October 11, 2026: otherwise a first run that
            # failed after satellite.env existed could never be finished by a newer setup program). It is recorded here and
            # not at the swap, so a run that goes on to finish provisioning cannot leave a finished folder that still names
            # the old image. A finished folder is still refused, and -Remove and the small -Autostart operation are not a
            # resumed setup, so they keep the refusal.
            if (-not $SetupFinished -and -not $Remove -and -not $IsAutostartOnly) {
                Update-SatelliteEnv -Path $EnvPath -Changes @{ SATELLITE_IMAGE = $Image }
                Write-Screen 'This satellite was never finished; using the image this setup carries.'
                Write-Hidden "Adopted the image $Image on an unfinished satellite folder (secret $HaveSecret, certificate $HaveCert, configuration $HaveYaml); satellite.env had $SatelliteImage."
                $SatelliteImage = $Image
                $script:R.Image = $Image
            } else {
                Write-Hidden "Refused -Image $Image against the recorded $SatelliteImage (setup finished $SetupFinished, remove $Remove, autostart-only $IsAutostartOnly)."
                Stop-Setup "This satellite folder runs $SatelliteImage. To switch to another image use -Update -Image <new image>; -Image alone is refused."
            }
        }
        # -Update (rule of October 10, 2026, agreed with satellite-setup.sh): the image to switch to is -Image when given,
        # else this file's stamped default (a user who downloads a newer release's file does not type a digest). If that
        # is the image the satellite already runs, say so and carry on as a plain repair run.
        $NewerImageNote = $null
        if ($Update) {
            $ActiveImage = if ($ImageGiven) { $Image } else { $DefaultImageCuda }
            if (-not (Test-SatelliteImageReference $ActiveImage)) { Stop-Setup "The image reference must end in @sha256:<64 hex digits>; '$ActiveImage' does not." }
            if ($ActiveImage -ceq $SatelliteImage) {
                Write-Screen "The satellite already runs that image ($SatelliteImage), so there is nothing to switch to; continuing as a plain repair run."
                $Update = [switch]$false
                $ActiveImage = $SatelliteImage
            }
        } elseif ($IsExisting) {
            $ActiveImage = $SatelliteImage
            # A newer release's file against an older satellite: keep running the recorded image and say how to move.
            if (-not $ImageGiven -and $DefaultImageCuda -and $DefaultImageCuda -cne $SatelliteImage -and -not $Remove) {
                if (-not $SetupFinished -and -not $IsAutostartOnly -and (Test-SatelliteImageReference $DefaultImageCuda)) {
                    # The same adoption as for a given -Image (above), for the image stamped into this file: on a folder whose
                    # setup never finished the note that names -Update would be a dead end, since -Update is refused there.
                    Update-SatelliteEnv -Path $EnvPath -Changes @{ SATELLITE_IMAGE = $DefaultImageCuda }
                    Write-Screen 'This satellite was never finished; using the image this setup carries.'
                    Write-Hidden "Adopted the stamped default image $DefaultImageCuda on an unfinished satellite folder (secret $HaveSecret, certificate $HaveCert, configuration $HaveYaml); satellite.env had $SatelliteImage."
                    $SatelliteImage = $DefaultImageCuda
                    $script:R.Image = $DefaultImageCuda
                    $ActiveImage = $DefaultImageCuda
                } else {
                    $NewerImageNote = $DefaultImageCuda
                }
            }
        } elseif ($ImageGiven) {
            $ActiveImage = $Image
        } elseif ($DefaultImageCuda) {
            $ActiveImage = $DefaultImageCuda
        } else {
            Stop-Setup '-Image is required: this copy of the script has no default image. Pass -Image <name>@sha256:<64 hex digits>.'
        }
        if (-not (Test-SatelliteImageReference $ActiveImage)) { Stop-Setup "The image reference must end in @sha256:<64 hex digits>; '$ActiveImage' does not." }
    }

    # What the run has to produce, from the products already in the folder (each later step is skipped when its product
    # exists, so running the same command again resumes).
    $NeedSecret = $NewSecret -or -not $HaveSecret
    $NeedCert = $NewCertificate -or -not $HaveCert
    # --ip and --dns are for a certificate that is being made: a replacement, or none at all. With half a pair (one of cert.pem
    # and key.pem) the tool refuses with exit 5 whatever it is given, so nothing is passed for a certificate it will not make.
    $MakeCert = $NewCertificate -or -not ((Test-Path -LiteralPath $CertPath -PathType Leaf) -or (Test-Path -LiteralPath $KeyPath -PathType Leaf))
    $RunProvision = $NeedSecret -or $NeedCert -or -not $HaveYaml
    if ($Update -and $RunProvision) {
        Stop-Setup "This satellite folder is not complete yet (it has no secret, certificate or configuration), so -Update cannot run. Run the same command without -Update to finish setting it up."
    }
    if (-not $Remove -and -not $IsAutostartOnly -and -not $ShowPlan -and $NeedSecret -and -not $SecretFileFull) {
        # -NoPrompt (the setup program and the tray icon always pass it): the prompt would be invisible under them and the run
        # would wait forever, so a needed secret with no file is one fixed line, and the prompt is never opened.
        if ($NoPrompt) {
            # Plain English on purpose (October 11, 2026): this one fixed line is shown on a setup program page.
            Stop-Setup 'This satellite still needs its secret from Vocalis. Run setup again and paste the secret when it asks.'
        }
        if (-not (Test-ConsoleAttached)) {
            Stop-Setup 'Setup has to ask for the secret and no console is attached to this script (its input is redirected). Run it in a regular PowerShell window, or put the secret in a plain text file (in an editor, not with echo) and pass -SecretFile <path>.'
        }
    }

    # The addresses go into the certificate, so they are needed only when one is to be created or checked. They are read
    # for every mode (the primary address orders the URLs in the result file) but a problem is only reported when it matters.
    $Collected = $null
    $CollectionProblem = $null
    try {
        $Snapshot = Get-SatelliteNetworkSnapshot
        $Collected = Select-SatelliteAddresses -Adapters $Snapshot.Adapters -Addresses $Snapshot.Addresses -Routes $Snapshot.Routes
    } catch {
        $CollectionProblem = $_.Exception.Message
        if ($Remove -or $IsAutostartOnly) {
            Write-Hidden "Could not read this computer's network adapters: $CollectionProblem"
        } else {
            Write-Screen "Could not read this computer's network adapters: $CollectionProblem"
        }
    }
    $CertificateIps = @()
    if ($Collected -and $Collected.All.Count -gt 0) { $CertificateIps += @($Collected.All) }
    foreach ($Ip in $Addresses.Ips) { if ($CertificateIps -notcontains $Ip) { $CertificateIps += $Ip } }
    $PrimaryAddress = if ($Collected -and $Collected.Primary) { $Collected.Primary } elseif ($CertificateIps.Count -gt 0) { $CertificateIps[0] } else { $null }
    if (-not $Remove -and -not $IsAutostartOnly -and -not $ShowPlan -and $MakeCert -and $CertificateIps.Count -eq 0) {
        Stop-Setup 'No usable IPv4 address was found on this computer (adapters that are up, minus loopback, link-local and virtual ones), so the certificate would cover nothing Vocalis can reach. Pass the address with -Address <IPv4 address> (the one other computers use for this one).'
    }

    # ---- -ShowPlan: what a setup would use, as KEY=VALUE lines; no Docker call, nothing written -------------------------
    if ($ShowPlan) {
        $PlanCertFile = if (Test-Path -LiteralPath $CertPath -PathType Leaf) { $CertPath } else { '' }
        # Each line is one string: in an array literal the comma binds tighter than +.
        $PlanLines = @(
            "SATELLITE=$(if ($IsExisting) { 'existing' } else { 'new' })",
            "SATELLITE_ID=$(if ($IsExisting) { $SatelliteId } else { '' })",
            "NAME=$SatelliteName",
            "PORT=$SatellitePort",
            "CONTAINER=$(if ($IsExisting) { "vocalis-satellite-$SatelliteId" } else { '' })",
            "AUTOSTART=$AutostartWanted",
            "IMAGE=$(if ($IsExisting) { $SatelliteImage } else { '' })",
            "ADDRESSES=$($CertificateIps -join ',')",
            "NEEDS_SECRET=$(if ($HaveSecret) { 'no' } else { 'yes' })",
            "NEEDS_CERTIFICATE=$(if ($HaveCert) { 'no' } else { 'yes' })",
            "SETUP_FINISHED=$(if ($SetupFinished) { 'yes' } else { 'no' })",
            "CERTIFICATE_FILE=$PlanCertFile",
            "FINGERPRINT=$RecordedFingerprint")
        foreach ($PlanLine in $PlanLines) { Write-Host $PlanLine }
        exit 0
    }
    $script:R.Steps = 'unknown'

    # Docker: docker.exe present and the engine answering, each bounded.
    $DockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $DockerCommand) { Stop-Setup 'docker.exe was not found on PATH. Install Docker Desktop for Windows, start it, and run this again.' 10 }
    $DockerPath = $DockerCommand.Source
    $Info = Invoke-LoggedDocker -Arguments @('info') -TimeoutSeconds $CheckTimeoutSeconds
    if ($Info.TimedOut) { Stop-Setup "docker info did not answer within $CheckTimeoutSeconds s. Start Docker Desktop, wait until it reports the engine is running, and run this again." 11 }
    if ($Info.ExitCode -ne 0) { Stop-Setup ("docker info failed with exit code $($Info.ExitCode): " + (Get-FirstLine $Info.Output) + ' Start Docker Desktop, wait until it reports the engine is running, and run this again.') 11 }
    Write-Detail "Docker answered in $($Info.Milliseconds) ms ($DockerPath)."
    # October 11, 2026: the two small operations (-Remove, and -Autostart alone) get the same sentence satellite-setup.sh
    # prints for them; the setup path keeps its present "Satellite folder:" line.
    if ($Remove -or $IsAutostartOnly) {
        Write-Screen "Satellite $SatelliteId in $RootFull."
    } else {
        Write-Screen "Satellite folder: $RootFull"
    }

    # A folder that is only now being created cannot have a container yet.
    $ContainerName = "vocalis-satellite-$SatelliteId"
    $Existing = if ($IsExisting) { Get-SatelliteContainer $ContainerName } else { $null }

    # ---- -Remove: the container only; the folder stays. ---------------------------------------------------------------
    if ($Remove) {
        Write-Step 2 'Remove the container'
        if ($Existing) {
            # Stop it properly first, so the satellite writes its "exiting" line and the break line to its log before it goes
            # (October 11, 2026; it exits within a second, and an image from before it handled the stop signal is ended by
            # Docker after 5 seconds). The result does not matter: the removal below is forced.
            [void](Invoke-LoggedDocker -Arguments @('stop', '-t', '5', $ContainerName) -TimeoutSeconds 60)
            $Removal = Invoke-LoggedDocker -Arguments @('rm', '-f', $ContainerName) -TimeoutSeconds 120
            if ($Removal.TimedOut -or $Removal.ExitCode -ne 0) { Stop-Setup ("Removing the container $ContainerName failed: " + (Get-FirstLine $Removal.Output)) }
            Write-Screen "Removed the container $ContainerName (it was $($Existing.Status))."
        } else {
            Write-Screen "There is no container named $ContainerName; nothing to remove."
        }
        Write-Screen "The folder $RootFull was left in place with the secret, certificate and model. Delete it yourself when you no longer need it."
        $script:R.Steps = 'remove-row'
        $ExitCode = 0
    } elseif ($IsAutostartOnly) {
        # ---- the small operation (design, "Script changes" item 5): record the value and make the container's restart
        # policy match. Docker has answered (above), so the file and the container cannot come to disagree for lack of it.
        # No pull, no model check, no recreate, no restart, whatever state the folder is in.
        Write-Step 2 'Autostart'
        $PreviousBytes = [System.IO.File]::ReadAllBytes($EnvPath)
        Update-SatelliteEnv -Path $EnvPath -Changes @{ AUTOSTART = $AutostartWanted }
        $script:R.Autostart = $AutostartWanted
        Write-Hidden "Recorded AUTOSTART=$AutostartWanted in satellite.env (it was $RecordedAutostart)."
        if ($Existing) {
            $Applied = Set-ContainerRestartPolicy -ContainerName $ContainerName -Autostart $AutostartWanted
            if ($Applied.TimedOut -or $Applied.ExitCode -ne 0) {
                $Why = if ($Applied.TimedOut) { 'docker update did not answer in time' } else { Get-FirstLine $Applied.Output }
                $Undone = 'The recorded setting was put back.'
                try {
                    Restore-FileBytes -Path $EnvPath -Bytes $PreviousBytes
                    $script:R.Autostart = $RecordedAutostart
                } catch {
                    $Undone = "The recorded setting could NOT be put back ($($_.Exception.Message)); satellite.env now says AUTOSTART=$AutostartWanted."
                }
                Stop-Setup "Docker refused to change the restart policy of $ContainerName ($Why). $Undone Nothing else was changed."
            }
            Write-Screen "Start with Docker is now $AutostartWanted for $ContainerName (restart policy $(Get-AutostartPolicy $AutostartWanted)). The satellite itself was not restarted."
        } else {
            Write-Screen "Start with Docker is now recorded as $AutostartWanted. There is no container named $ContainerName yet, so nothing else changed."
        }
        $script:R.Steps = 'none'
        $ExitCode = 0
    } else {
        # The port: free on Windows for the wildcard address, unless this folder's own running container holds it.
        $PortHeldByThisSatellite = $Existing -and $Existing.Status -in @('running', 'restarting')
        if ($PortHeldByThisSatellite) {
            Write-Detail "Port ${SatellitePort}: held by this satellite's own container ($ContainerName is $($Existing.Status)), not counted as taken."
        } else {
            $PortProblem = Test-WindowsWildcardPort $SatellitePort
            if ($PortProblem -and $IsExisting) {
                # The port of an existing folder is fixed, so the remedy is not "choose another".
                Stop-Setup ("The satellite port is not usable: $PortProblem What holds it is not this satellite, and the port is fixed for this folder. Stop whatever uses port $SatellitePort and run again, or remove this satellite and set up a new folder with another -Port.")
            }
            if ($PortProblem) {
                Stop-Setup ("The satellite port is not usable: $PortProblem Choose another with -Port <port> and run again.")
            }
            Write-Detail "Port ${SatellitePort}: can be bound on all interfaces on Windows."
        }
        if ($Update -or -not $IsExisting) {
            # October 11, 2026: the same sentence as satellite-setup.sh prints, true whether or not the image is already here.
            Write-Detail 'Setup needs the satellite image (about 10 GB) and the Chatterbox model files (about 3.2 GB). Whatever is not already on this computer is downloaded; setup can be run again to resume.'
        }

        # ---- the folder and satellite.env, first thing written after the checks -----------------------------------------
        if (-not $IsExisting) {
            New-Item -ItemType Directory -Path $RootFull -Force | Out-Null
            New-SatelliteEnvFile -Path $EnvPath -Values @{
                SATELLITE_ID = $SatelliteId; GPU_VARIANT = 'cuda'; SATELLITE_ROOT = $RootFull; SATELLITE_IMAGE = $ActiveImage
                SATELLITE_PORT = "$SatellitePort"; SATELLITE_NAME = $SatelliteName; SERVICE_UID = "$ServiceUid"; SERVICE_GID = "$ServiceGid"
                GPU_GIDS = ''; IP_ADDRESSES = ''; DNS_NAMES = ''; AUTOSTART = $AutostartWanted; CERT_FINGERPRINT = ''
            }
            # satellite.env has just been created: the log opens (the held lines are written first) and the result file
            # will be written at the end.
            Start-SetupArtifacts -RootFull $RootFull -ArgumentNames $ArgumentNames
            $script:R.Id = $SatelliteId; $script:R.Name = $SatelliteName; $script:R.Port = $SatellitePort; $script:R.Image = $ActiveImage
            $script:R.Container = $ContainerName; $script:R.Autostart = $AutostartWanted
            if ($script:EncodingNote) { Write-Hidden $script:EncodingNote }
            Write-Detail "Created the satellite folder $RootFull and satellite.env (satellite $SatelliteId, port $SatellitePort, name $SatelliteName)."
        }
        foreach ($FolderName in $FolderNames) { New-Item -ItemType Directory -Path (Join-Path $RootFull $FolderName) -Force | Out-Null }

        # Changes to satellite.env are collected here and saved after the model check (and, for a first run or a rerun,
        # right after the certificate is known), so an -Update that fails before the swap leaves the file as it was. The
        # start-with-Docker value rides along: a file from before it existed gets the line at this save.
        $EnvChanges = @{ AUTOSTART = $AutostartWanted }

        $CacheMount = New-BindMount "$RootForward/cache" '/cache/vocalis'

        # ---- Step 2: image ----------------------------------------------------------------------------------------------
        Write-Step 2 "Image $ActiveImage"
        $Present = Invoke-LoggedDocker -Arguments @('image', 'inspect', $ActiveImage) -TimeoutSeconds $CheckTimeoutSeconds
        if ($Present.TimedOut) { Stop-Setup "docker image inspect did not answer within $CheckTimeoutSeconds s." }
        if ($Present.ExitCode -eq 0) {
            Write-Screen 'The image is already on this machine; it is not pulled.'
        } else {
            Write-Screen 'Pulling the image (about 10 GB; Docker shows its progress). A stopped pull resumes when you run the same command again.'
            if (Test-OutputIsTerminal) {
                # At a terminal Docker's own progress display is shown directly (design table: the log gets the exit code
                # only). Direct native calls (this one and the prompt) show Docker's own progress. 'Continue' around them:
                # under 'Stop', Windows PowerShell 5.1 can turn a line the program writes to stderr into a terminating
                # error that hides the real exit code. (The model download was a direct call too until October 11, 2026;
                # it is captured now, as the per-call table in the design says.)
                $ErrorActionPreference = 'Continue'
                & $DockerPath pull $ActiveImage
                $PullExit = $LASTEXITCODE
                $ErrorActionPreference = 'Stop'
                Write-Hidden "docker pull $ActiveImage (Docker's own progress display on the screen, not logged): exit code $PullExit"
            } else {
                # Not a terminal (under the setup program): the pull is read as text, both streams, and every line is
                # shown and logged as it arrives. Never 2>&1 on the native program (each stderr line would become an error
                # record).
                Write-Hidden "docker pull $ActiveImage (output captured)"
                $Pulled = Invoke-Streamed -FileName $DockerPath -Arguments @('pull', $ActiveImage) -OnLine { param($Stream, $Line) Write-Screen $Line }
                $PullExit = $Pulled.ExitCode
                Write-Hidden "  exit code $PullExit in $($Pulled.Milliseconds) ms$(if (-not $Pulled.Started) { ' (docker could not be started: ' + $Pulled.Problem + ')' })"
            }
            if ($PullExit -ne 0) { Stop-Setup "docker pull failed with exit code $PullExit. Check the image reference and the network, then run the same command again." }
        }

        # ---- Step 3: GPU ------------------------------------------------------------------------------------------------
        # Only when the container is going to be created or created again (agreed with satellite-setup.sh, October 10,
        # 2026): a satellite that is already running with these settings has proven its card, and the check is a whole
        # extra PyTorch start. It runs before any prompt, so a machine without a usable card is told before the user
        # is asked for the secret.
        Write-Step 3 'GPU'
        $PlannedOn = Get-LongLivedSpec -Id $SatelliteId -HostPort $SatellitePort -ImageReference $ActiveImage -RootForward $RootForward -Autostart 'on'
        $PlannedOff = Get-LongLivedSpec -Id $SatelliteId -HostPort $SatellitePort -ImageReference $ActiveImage -RootForward $RootForward -Autostart 'off'
        if (Test-SpecLabelCurrent $Existing $PlannedOn $PlannedOff) {
            Write-Screen "GPU check skipped: the container $ContainerName already has these settings, so it is not created again."
        } else {
            $GpuArguments = Get-OneShotArguments -ImageReference $ActiveImage -Subcommand 'check-gpu' -Mounts @($CacheMount) -NoNetwork -Gpu
            $GpuResult = Invoke-LoggedDocker -Arguments $GpuArguments -TimeoutSeconds $OneShotSeconds
            if ($GpuResult.TimedOut) { Stop-Setup "The GPU check did not finish within $OneShotSeconds s." }
            $Cards = @($GpuResult.StdOut -split "[\r\n]+" | Where-Object { $_ -match '^card=' })
            if ($GpuResult.ExitCode -eq 3 -or ($GpuResult.ExitCode -eq 0 -and $Cards.Count -eq 0)) {
                Stop-Setup 'Docker started a container but it found no NVIDIA card it can use. Check that the NVIDIA driver is installed and current, and that Docker Desktop uses the WSL 2 backend (Settings, General); then run this again.' 12
            }
            if ($GpuResult.ExitCode -ne 0) { Stop-Setup ("The GPU check failed with exit code $($GpuResult.ExitCode) after $($GpuResult.Milliseconds) ms: " + (Get-FirstLine $GpuResult.Output)) }
            Show-ToolMessages $GpuResult
            foreach ($Card in $Cards) {
                $Fields = $Card.Substring(5) -split "`t", 2
                Write-Screen ("Card {0}: {1}" -f $Fields[0], $Fields[1])
            }
        }

        # ---- Step 4: addresses -----------------------------------------------------------------------------------------
        Write-Step 4 'Addresses'
        if ($Collected) {
            Write-Screen "Found on this computer: $(if ($Collected.All.Count) { $Collected.All -join ', ' } else { 'no usable IPv4 address' })"
            if ($Collected.Note) { Write-Screen "  $($Collected.Note)" }
            # The adapters left out are listed only when nothing usable was found, or with -Verbose (and always in the log).
            foreach ($Left in $Collected.Skipped) {
                if ($Collected.All.Count -eq 0) { Write-Screen "  left out: $Left" } else { Write-Detail "  left out: $Left" }
            }
        }
        if ($Addresses.Ips.Count -gt 0) { Write-Screen "Added with -Address: $($Addresses.Ips -join ', ')" }
        if ($Addresses.Names.Count -gt 0) { Write-Screen "Names recorded for information with -Address: $($Addresses.Names -join ', ') (Vocalis reaches a satellite by its IPv4 address)" }

        # ---- Step 5: secret and certificate (one provision container makes both) ----------------------------------------------
        Write-Step 5 'Secret and certificate'
        if ($SecretFileFull -and -not $NeedSecret) {
            Write-Screen "-SecretFile was given but no secret is needed on this run (the secret already exists and -NewSecret was not given), so the file is not used."
        }
        if ($RunProvision) {
            $ProvisionArguments = @('--name', $SatelliteName)
            if ($MakeCert) {
                foreach ($Ip in $CertificateIps) { $ProvisionArguments += @('--ip', $Ip) }
                foreach ($DnsName in $Addresses.Names) { $ProvisionArguments += @('--dns', $DnsName) }
            }
            if ($NeedSecret -and $SecretFileFull) { $ProvisionArguments += '--secret-from-file' }
            if ($NewSecret) { $ProvisionArguments += '--new-secret' }
            if ($NewCertificate) { $ProvisionArguments += '--new-certificate' }
            $ProvisionMounts = @($CacheMount, (New-BindMount "$RootForward/data" '/data/vocalis-satellite'), (New-BindMount "$RootForward/secrets" '/run/secrets'))
            if ($NeedSecret -and $SecretFileFull) { $ProvisionMounts += (New-BindMount $SecretFileFull '/run/provision/secret' -ReadOnly) }
            $Prompting = $NeedSecret -and -not $SecretFileFull

            if ($NewCertificate) {
                Write-Detail 'A new certificate will be created. Vocalis must be given the new certificate file afterwards ("Upload certificate..." on the satellite''s row in Settings, Satellites); the old file will no longer match.'
                Write-Detail '  It covers the addresses found on this computer now plus the -Address values given on this run (IPv4 addresses and names alike); nothing recorded earlier is carried forward.'
                # What the old certificate had that the new one will not: the concrete values, so they can be passed again.
                $RecordedIps = @(([string]$Recorded['IP_ADDRESSES']) -split ',' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
                $RecordedNames = @(([string]$Recorded['DNS_NAMES']) -split ',' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
                $LostIps = @($RecordedIps | Where-Object { $CertificateIps -notcontains $_ })
                $LostNames = @($RecordedNames | Where-Object { $Addresses.Names -notcontains $_ })
                if ($LostIps.Count + $LostNames.Count -gt 0) {
                    Write-Screen "  NOT in the new certificate (recorded for the old one): $((@($LostIps) + @($LostNames)) -join ', '). If you need any of them, run again with -NewCertificate -Address <values> (comma separated)."
                } else {
                    Write-Detail '  Every address and name recorded for the old certificate is in the new one.'
                }
            }
            # What to do in Vocalis before the secret is typed is said only when it is going to be typed here; a secret that
            # comes from a file was already copied out of Vocalis.
            if ($NeedSecret -and $NewSecret) {
                if ($Prompting) { Write-Screen 'Replacing the secret: choose "New secret..." for this satellite in Vocalis first, so you have the new one to paste.' }
                else { Write-Detail 'Replacing the secret: choose "New secret..." for this satellite in Vocalis first, so you have the new one to paste.' }
            } elseif ($NeedSecret) {
                $UrlForPrompt = if ($PrimaryAddress) { "https://${PrimaryAddress}:${SatellitePort}" } else { "https://<this computer's address>:${SatellitePort}" }
                if ($Prompting) {
                    Write-Screen 'Now add this satellite in Vocalis: Settings, Satellites, Add satellite.'
                    Write-Screen "  URL to enter: $UrlForPrompt"
                    Write-Screen '  Vocalis then shows a secret ONCE.'
                } else {
                    Write-Detail 'Now add this satellite in Vocalis: Settings, Satellites, Add satellite.'
                    Write-Detail "  URL to enter: $UrlForPrompt"
                    Write-Detail '  Vocalis then shows a secret ONCE.'
                }
            }
            Write-Detail "Provisioning (name $SatelliteName; $(if ($NeedSecret) { 'secret to be written' } else { 'secret kept' }); $(if ($MakeCert) { 'certificate to be created for ' + ($CertificateIps -join ', ') } elseif ($NeedCert) { 'certificate: only half a pair is there' } else { 'certificate kept' }))..."

            $ToolReason = ''
            if ($Prompting) {
                # The one call that prompts: -it, made directly at script scope with the console attached. The secret is
                # typed into the container's own prompt without echo; it is never in an argument, a variable or this
                # script's output. It is also the one call whose output is not captured, so the tool's own INFO: lines show
                # here (the stated exception to the quiet output) and the log gets the exit code only.
                Write-Screen 'Paste the secret at the prompt below and press Enter (nothing is shown as you paste). An empty answer stops setup with nothing started.'
                $TerminalArguments = Get-OneShotArguments -ImageReference $ActiveImage -Subcommand 'provision' -SubcommandArguments $ProvisionArguments -Mounts $ProvisionMounts -NoNetwork -Terminal
                $ErrorActionPreference = 'Continue'
                & $DockerPath @TerminalArguments
                $ProvisionExit = $LASTEXITCODE
                $ErrorActionPreference = 'Stop'
                Write-Hidden "docker run ... provision, with the secret typed at the prompt (the screen has its output; it is not logged): exit code $ProvisionExit"
            } else {
                if ($NeedSecret) { Write-Detail "Reading the secret from the file $SecretFileFull (its contents are not shown)." }
                $ProvisionRun = Get-OneShotArguments -ImageReference $ActiveImage -Subcommand 'provision' -SubcommandArguments $ProvisionArguments -Mounts $ProvisionMounts -NoNetwork
                $ProvisionResult = Invoke-LoggedDocker -Arguments $ProvisionRun -TimeoutSeconds $OneShotSeconds
                $ProvisionExit = if ($ProvisionResult.TimedOut) { -1 } else { $ProvisionResult.ExitCode }
                # stdout carries the results (secret=, certificate=); stderr carries the tool's own messages (INFO lines on
                # success, the reason on failure) and is never read as a failure. In a quiet run the made-or-kept lines show,
                # the tool's INFO: lines do not, and any other line does (a failure's reason is one); -Verbose shows all.
                foreach ($Line in ($ProvisionResult.StdOut -split "[\r\n]+")) {
                    if ($Line -match '^(secret|certificate)=(written|kept|created)$') { Write-Screen ("  {0}: {1}" -f $Matches[1], $Matches[2]) }
                }
                Show-ToolMessages $ProvisionResult
                $ToolReason = (Get-FirstLine (@($ProvisionResult.StdErr -split "[\r\n]+") | Where-Object { $_.Trim() -and $_ -notmatch '^\s*INFO:' } | Select-Object -First 1)).TrimEnd('.')
                if ($ProvisionResult.TimedOut) { Stop-Setup "The provisioning step did not finish within $OneShotSeconds s." }
            }
            Write-Detail "Provisioning finished with exit code $ProvisionExit."
            # 4 and 5 stop here with the tool's own message above (it names -NewSecret or -NewCertificate when that is the
            # remedy); nothing is retried or replaced for the user. The message is also in the failure line, so a wrapper that
            # shows only that line (the setup program's result file) has the reason.
            $ReasonText = if ($ToolReason) { "($ToolReason)" } else { '(the message above says why)' }
            if ($ProvisionExit -eq 4) { Stop-Setup "The secret was not accepted $ReasonText. Nothing was started and nothing was replaced." }
            if ($ProvisionExit -eq 5) { Stop-Setup "The satellite configuration or certificate could not be written or read $ReasonText. Nothing was started and nothing was replaced." }
            if ($ProvisionExit -ne 0) { Stop-Setup "The provisioning step failed with exit code $ProvisionExit $ReasonText. Nothing was started." }
            $script:R.MadeSecret = if ($NeedSecret) { 'yes' } else { 'no' }
            $script:R.MadeCertificate = if ($MakeCert) { 'yes' } else { 'no' }
            if ($MakeCert) {
                # The recorded fingerprint and addresses belong to the old certificate; the report below replaces them.
                $script:R.Ips = @()
                $script:R.Fingerprint = ''
            }
        } else {
            Write-Screen 'The secret, certificate and configuration are already in place; they are kept.'
        }

        # The certificate's fingerprint and addresses, read back from the folder. On -Update this waits until after the swap
        # (the sequence agreed with satellite-setup.sh, October 10, 2026: pull, check-gpu and fetch-model with the new
        # image, record, recreate, wait, and only then show for the closing lines).
        $CertificateReport = $null
        if (-not $Update) {
            $CertificateReport = Get-CertificateReport -ImageReference $ActiveImage -CacheMount $CacheMount -DataSource "$RootForward/data"
            Write-CoverageWarning -Report $CertificateReport -PrimaryAddress $PrimaryAddress -Addresses $Addresses
            if ($script:R.MadeCertificate -eq 'yes') {
                Write-Screen "  The new certificate covers: IPv4 $(Format-ListOrNone $CertificateReport.Ips); names $(Format-ListOrNone $CertificateReport.Names)"
            }
            $EnvChanges['IP_ADDRESSES'] = $CertificateReport.Ips -join ','
            $EnvChanges['DNS_NAMES'] = $CertificateReport.Names -join ','
            $EnvChanges['CERT_FINGERPRINT'] = $CertificateReport.Fingerprint
            Update-SatelliteEnv -Path $EnvPath -Changes $EnvChanges
            $script:R.Autostart = $AutostartWanted
            $script:R.Ips = @($CertificateReport.Ips)
            $script:R.Fingerprint = $CertificateReport.Fingerprint
            Write-Detail "Recorded in satellite.env: addresses $(Format-ListOrNone $CertificateReport.Ips), names $(Format-ListOrNone $CertificateReport.Names)."
            $EnvChanges = @{}
        }

        # ---- Step 6: model ---------------------------------------------------------------------------------------------
        # A replaced secret or certificate changes nothing about the model, and the check hashes 3.2 GB, so those runs skip it.
        Write-Step 6 'Model (Chatterbox, about 3.2 GB; files already present are verified, not downloaded again)'
        if ($NewSecret -or $NewCertificate) {
            Write-Screen 'Skipped: replacing the secret or the certificate does not touch the model.'
        } else {
            $FetchArguments = Get-OneShotArguments -ImageReference $ActiveImage -Subcommand 'fetch-model' -Mounts @($CacheMount, (New-BindMount "$RootForward/models" '/models/vocalis'))
            # Captured, with both streams read as text and no 2>&1: the standard output (one line per file) is shown as it
            # arrives, the standard error (the tool's INFO: lines) goes to the log and to -Verbose only. Only the exit code
            # decides.
            Write-Hidden ('docker ' + (ConvertTo-ArgumentString $FetchArguments))
            $FetchErrors = New-Object System.Collections.ArrayList
            $Fetched = Invoke-Streamed -FileName $DockerPath -Arguments $FetchArguments -OnLine { param($Stream, $Line) if ($Stream -eq 'out') { Write-Screen $Line } else { [void]$FetchErrors.Add($Line); Write-Detail $Line } }
            Write-Hidden "  exit code $($Fetched.ExitCode) in $($Fetched.Milliseconds) ms$(if (-not $Fetched.Started) { ' (docker could not be started: ' + $Fetched.Problem + ')' })"
            if ($Fetched.ExitCode -ne 0) {
                # A failed download shows the standard-error lines that are not INFO: lines, because they are the reason.
                foreach ($ErrorLine in $FetchErrors) { if ($ErrorLine -notmatch '^\s*INFO:' -and -not $script:VerboseRun) { Write-Screen $ErrorLine } }
                Stop-Setup "The model download or check did not finish (exit code $($Fetched.ExitCode)). Finished files are kept; run the same command again to resume."
            }
            Write-Screen 'The model is in place and verified.'
        }

        # The swap: only now is the new image recorded (an -Update that failed above changed nothing).
        if ($Update) {
            $EnvChanges['SATELLITE_IMAGE'] = $ActiveImage
        }
        if ($EnvChanges.Count -gt 0) {
            Update-SatelliteEnv -Path $EnvPath -Changes $EnvChanges
            $script:R.Autostart = $AutostartWanted
            if ($Update) { $script:R.Image = $ActiveImage }
            Write-Detail "Recorded in satellite.env: $(($EnvChanges.Keys | Sort-Object) -join ', ')."
            $EnvChanges = @{}
        }

        # ---- Step 7: start ---------------------------------------------------------------------------------------------
        Write-Step 7 'Start'
        $SpecOn = Get-LongLivedSpec -Id $SatelliteId -HostPort $SatellitePort -ImageReference $ActiveImage -RootForward $RootForward -Autostart 'on'
        $SpecOff = Get-LongLivedSpec -Id $SatelliteId -HostPort $SatellitePort -ImageReference $ActiveImage -RootForward $RootForward -Autostart 'off'
        $Spec = if ($AutostartWanted -eq 'off') { $SpecOff } else { $SpecOn }
        # Read again: the pull and the model check can take a long time.
        $Existing = if ($IsExisting) { Get-SatelliteContainer $ContainerName } else { $null }
        # A container made under the other start-with-Docker value (and changed since with docker update) still carries the
        # other value's hash; it has the current settings all the same, and only its restart policy is brought in line.
        $LabelCurrent = Test-SpecLabelCurrent $Existing $SpecOn $SpecOff
        $Restart = $NewSecret -or $NewCertificate
        $Changed = $true
        if (-not $Existing) {
            Write-Detail "No container $ContainerName yet: creating it (settings hash $($Spec.Hash.Substring(0, 12)))."
            $Action = 'create'
        } elseif (-not $LabelCurrent) {
            Write-Detail "The container $ContainerName was made with other settings (hash $(if ($Existing.SpecLabel) { $Existing.SpecLabel.Substring(0, [Math]::Min(12, $Existing.SpecLabel.Length)) } else { 'none' }), now $($Spec.Hash.Substring(0, 12))): removing it and creating it again."
            $Action = 'recreate'
        } elseif ($Existing.Status -notin @('running', 'restarting')) {
            Write-Detail "The container $ContainerName has the current settings but is $($Existing.Status): starting it."
            $Action = 'start'
        } elseif ($Restart) {
            Write-Detail "The container $ContainerName has the current settings and is $($Existing.Status); restarting it so it reads the new $(if ($NewSecret -and $NewCertificate) { 'secret and certificate' } elseif ($NewSecret) { 'secret' } else { 'certificate' })."
            $Action = 'restart'
        } elseif ($Existing.Status -eq 'restarting') {
            # Only 'running' counts as up (review, October 10, 2026): a container Docker keeps restarting is crash-looping
            # and must not be reported as running. Wait for its listening line; the wait fails with the log end if it does
            # not come.
            Write-Screen "The container $ContainerName has the current settings but is restarting over and over (a crash loop): waiting to see whether it comes up."
            $Action = 'wait'
        } else {
            Write-Detail "The container $ContainerName has the current settings and is running: left as it is."
            $Action = 'none'
            $Changed = $false
        }
        if ($LabelCurrent -and $Existing.RestartPolicy -ne (Get-AutostartPolicy $AutostartWanted)) {
            $PolicyResult = Set-ContainerRestartPolicy -ContainerName $ContainerName -Autostart $AutostartWanted
            if ($PolicyResult.TimedOut -or $PolicyResult.ExitCode -ne 0) {
                Stop-Setup ("Docker refused to change the restart policy of $ContainerName to $(Get-AutostartPolicy $AutostartWanted): " + (Get-FirstLine $PolicyResult.Output))
            }
            Write-Detail "The container's restart policy was $($Existing.RestartPolicy); it is now $(Get-AutostartPolicy $AutostartWanted) (start with Docker $AutostartWanted)."
        }
        if ($Action -eq 'recreate') {
            # Stop it properly first, so the satellite writes its "exiting" line and the break line to its log before it goes
            # (October 11, 2026; it exits within a second, and an image from before it handled the stop signal is ended by
            # Docker after 5 seconds). The result does not matter: the removal below is forced.
            [void](Invoke-LoggedDocker -Arguments @('stop', '-t', '5', $ContainerName) -TimeoutSeconds 60)
            $Removal = Invoke-LoggedDocker -Arguments @('rm', '-f', $ContainerName) -TimeoutSeconds 120
            if ($Removal.TimedOut -or $Removal.ExitCode -ne 0) { Stop-Setup ("Removing the old container $ContainerName failed: " + (Get-FirstLine $Removal.Output)) }
        }
        if ($Action -eq 'create' -or $Action -eq 'recreate') {
            $Created = Invoke-LoggedDocker -Arguments $Spec.Arguments -TimeoutSeconds 120
            if ($Created.TimedOut -or $Created.ExitCode -ne 0) {
                # A failed run can leave the container it created (for example one that could not start, with its port
                # taken): remove it by name, so a rerun does not find a half-made container, and say what happened.
                $Why = if ($Created.TimedOut) { 'docker run did not finish within 120 s' } else { "docker run failed with exit code $($Created.ExitCode): $($Created.Output)" }
                $Cleanup = Invoke-LoggedDocker -Arguments @('rm', '-f', $ContainerName) -TimeoutSeconds 120
                Write-Screen "Cleaning up after the failed start: docker rm -f $ContainerName exited with code $($Cleanup.ExitCode)$(if ($Cleanup.Output) { ': ' + (Get-FirstLine $Cleanup.Output) })."
                Stop-Setup "The satellite container could not be created. $Why. Nothing is left running; run the same command again once the cause is fixed."
            }
            Write-Detail "Created $ContainerName in $($Created.Milliseconds) ms."
        } elseif ($Action -eq 'start' -or $Action -eq 'restart') {
            $Verb = if ($Action -eq 'start') { 'start' } else { 'restart' }
            $Moved = Invoke-LoggedDocker -Arguments @($Verb, $ContainerName) -TimeoutSeconds 120
            if ($Moved.TimedOut -or $Moved.ExitCode -ne 0) { Stop-Setup ("docker $Verb failed: " + (Get-FirstLine $Moved.Output)) }
            Write-Detail "docker $Verb finished in $($Moved.Milliseconds) ms."
        }
        if ($Changed -and -not (Wait-SatelliteListening $ContainerName)) {
            Stop-Setup 'The satellite did not come up. The end of its log is above. Run the same command again once the cause is fixed.' 13
        }
        Write-Screen "The satellite $ContainerName is running on port $SatellitePort."

        # After an -Update the certificate is read last, for the closing lines (and the recorded addresses).
        if ($Update) {
            $CertificateReport = Get-CertificateReport -ImageReference $ActiveImage -CacheMount $CacheMount -DataSource "$RootForward/data"
            Write-CoverageWarning -Report $CertificateReport -PrimaryAddress $PrimaryAddress -Addresses $Addresses
            Update-SatelliteEnv -Path $EnvPath -Changes @{ IP_ADDRESSES = ($CertificateReport.Ips -join ','); DNS_NAMES = ($CertificateReport.Names -join ','); CERT_FINGERPRINT = $CertificateReport.Fingerprint }
            $script:R.Ips = @($CertificateReport.Ips)
            $script:R.Fingerprint = $CertificateReport.Fingerprint
            Write-Detail "Recorded in satellite.env: addresses $(Format-ListOrNone $CertificateReport.Ips), names $(Format-ListOrNone $CertificateReport.Names)."
        }
        $Fingerprint = $CertificateReport.Fingerprint
        $CertIps = @($CertificateReport.Ips)
        $script:R.Image = $ActiveImage

        # ---- Step 8: closing lines -------------------------------------------------------------------------------------
        # Short, and one thing (design, "Script changes" item 3). The firewall command, the notes on restarting and the
        # stop, start, update and remove commands are in -Help, the guide and (below) the log.
        # (Superseded October 11, 2026: the closing lines used to list every address as a URL block. The rule then was: "The
        # URL block is indented under the step it belongs to (the certificate step); after an update or a replaced secret
        # there is no such step, so it stands on its own at the left margin." The address is now one "Satellite address:"
        # line, so there is no block to indent.)
        Write-Step 8 'Done'
        $Urls = @(Get-SatelliteUrls -Ips $CertIps -Primary $PrimaryAddress -HostPort $SatellitePort)
        $AddressLine = if ($Urls.Count -gt 0) { "Satellite address: $($Urls[0])" } else { 'The certificate has no IPv4 address; Vocalis needs one. Run this again with -Address <IPv4 address> -NewCertificate.' }
        $ScriptPathText = if ($PSCommandPath) { $PSCommandPath } else { '.\satellite-setup.ps1' }
        $RootText = if ($Root) { " -Root `"$RootFull`"" } else { '' }
        $Prefix = "powershell -ExecutionPolicy Bypass -File `"$ScriptPathText`"$RootText"
        # What is left to do in Vocalis depends on what this run did (review, October 10, 2026): the full block only for a
        # first setup (something that did not exist was made), less after an update or a replaced secret or certificate.
        $FirstSetup = ($NeedSecret -and -not $NewSecret) -or ($NeedCert -and -not $NewCertificate)
        # A plain run (nothing created or replaced, no update) cannot know whether Vocalis was ever set up: an earlier run
        # may have stopped after the secret and certificate were written (a failed model download, say) and before the user
        # uploaded the certificate. So it says both, with the same two steps a first setup prints (wording shared with
        # satellite-setup.sh).
        $PlainRun = -not $FirstSetup -and -not $Update -and -not $NewSecret -and -not $NewCertificate
        if ($FirstSetup) {
            $script:R.Steps = 'upload-and-tick'
            Write-Screen "One thing left: give Vocalis this satellite's certificate."
            Write-Screen "  File to upload:  $CertPath"
            Write-Screen "  Fingerprint:     $Fingerprint"
            Write-Screen 'If your browser is on another computer, copy that file there first.'
            # Wording agreed with the Vocalis Settings page (October 10, 2026): there is no Load button; ticking a satellite's
            # card applies and loads it, and the satellite's row has "Upload certificate...".
            Write-Screen 'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite''s row. Then tick its card.'
            Write-Screen $AddressLine
        } elseif ($PlainRun) {
            $script:R.Steps = 'maybe'
            Write-Screen 'If this satellite is already set up in Vocalis, nothing more has to be done there.'
            Write-Screen 'If it is not (for example an earlier run stopped part way), two steps are left in Vocalis:'
            Write-Screen '  1. Copy the certificate file named below to the computer where you use Vocalis in a browser, then use "Upload certificate..." on the satellite''s row:'
            Write-Screen "       $CertPath"
            Write-Screen "     Check that the fingerprint Vocalis shows matches: $Fingerprint"
            Write-Screen '  2. Tick the satellite''s cards in Settings; they load as soon as you tick them.'
            Write-Screen $AddressLine
        } else {
            if ($Update) {
                Write-Screen "The satellite now runs $ActiveImage. Nothing has to be paired again: its secret and certificate are unchanged, so Vocalis keeps working with it."
            }
            if ($NewSecret) {
                Write-Screen 'The secret was replaced and the satellite restarted. Vocalis already has the new secret (you pasted it from "New secret..."), and nothing needs uploading for it.'
            }
            if ($NewCertificate) {
                $script:R.Steps = 'upload'
                Write-Screen "One thing left: give Vocalis this satellite's new certificate."
                Write-Screen "  File to upload:  $CertPath"
                Write-Screen "  Fingerprint:     $Fingerprint"
                Write-Screen 'If your browser is on another computer, copy that file there first.'
                Write-Screen 'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite''s row.'
            } else {
                $script:R.Steps = 'none'
                Write-Screen 'For reference:'
                Write-Screen "  Certificate file:  $CertPath"
                Write-Screen "  Fingerprint:       $Fingerprint"
                Write-Screen ('  ' + $AddressLine)
            }
            if ($NewCertificate) { Write-Screen $AddressLine }
        }
        if ($NewerImageNote) {
            Write-Screen ''
            Write-Screen "NOTE: this setup file is for a newer satellite image ($NewerImageNote); this satellite keeps running $SatelliteImage. To move to the newer image run: powershell -ExecutionPolicy Bypass -File `"$ScriptPathText`" -Root `"$RootFull`" -Update"
        }
        Write-Screen 'If Vocalis cannot reach this satellite, see "Network" in the satellite guide.'
        # What used to be printed here is kept in the log (and in -Help and the guide).
        Write-Hidden "Network: setup did not change Windows Firewall. If Vocalis on another computer cannot reach the satellite, run this once in a PowerShell opened as administrator (right-click Windows PowerShell, Run as administrator):"
        Write-Hidden "  New-NetFirewallRule -DisplayName 'Vocalis satellite $SatellitePort' -Direction Inbound -Protocol TCP -LocalPort $SatellitePort -Action Allow -Profile Private"
        Write-Hidden 'The port is open on every network interface of this computer. Run a satellite only on a network you trust, and never forward the port from the internet.'
        Write-Hidden 'After a restart: the satellite comes back by itself when you sign in and Docker Desktop starts, unless you stopped it. Docker Desktop''s "Start Docker Desktop when you sign in" setting (Settings, General) must be on; nothing runs before you sign in.'
        Write-Hidden "Stop:    docker stop $ContainerName"
        Write-Hidden "Start:   docker start $ContainerName"
        # A file with a stamped image is the new release's file: -Update alone moves to its image. An unstamped one has
        # none to move to, so the image is named.
        if ($DefaultImageCuda) {
            Write-Hidden "Update:  $Prefix -Update     (run from the setup file of the new release)"
        } else {
            Write-Hidden "Update:  $Prefix -Update -Image <name>@sha256:<64 hex digits>"
        }
        Write-Hidden "Remove:  $Prefix -Remove     (removes the container only; this folder stays)"
        Write-Hidden "Windows has no file modes: the secret and the private key in $RootFull are as private as that folder, which for the default folder is your own profile."
        $ExitCode = 0
    }
    if ($ExitCode -eq 0) {
        if ($script:LogPath) { Write-Screen "Setup log: $($script:LogPath)" }
        Write-SetupResult -Code 0
    }
} catch {
    # One line, always (design, feasibility check of October 11, 2026): the failure is printed here as a single "ERROR:"
    # line, never left to PowerShell's own error record, which would reach a wrapper as four lines of CategoryInfo noise.
    $FailureText = ConvertTo-OneLine $_.Exception.Message
    if (-not $FailureExitCode) {
        # Not one of the refusals above: an unexpected error. The position tells what to report.
        $FailureText += " (unexpected error at line $($_.InvocationInfo.ScriptLineNumber): $(ConvertTo-OneLine $_.InvocationInfo.Line))"
    }
    $ExitCode = if ($FailureExitCode) { $FailureExitCode } else { 1 }
    $LogTail = if ($script:LogPath) { " Log: $($script:LogPath)" } else { '' }
    Write-Host "ERROR: $FailureText$LogTail" -ForegroundColor Red
    Add-LogLine "ERROR: $FailureText"
    if ($script:ResultOn) {
        $script:R.Steps = 'unknown'
        Write-SetupResult -Code $ExitCode -Failure $FailureText
    }
}
Close-SetupLog
exit $ExitCode
