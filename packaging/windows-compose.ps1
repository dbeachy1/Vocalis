# Shared Windows helper, dot-sourced at the top of packaging/setup.ps1 and packaging/windows/vocalis-control.ps1 (the
# installer puts it beside both in the install folder, and extracts it beside them in {tmp} wherever either runs from
# there). Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
#
# Why it exists (design section 5, "Windows installer", review amendment 15, October 10, 2026). Setup used to create
# the long-lived containers with `docker compose up` run inside the default WSL distribution, so their bind-mount
# sources were WSL paths (/mnt/e/...) that Docker Desktop serves through that distribution. After a reboot or a Docker
# Desktop restart Docker restarts `restart: unless-stopped` containers before it has reconnected to the distribution;
# the mount fails ("failed to fulfil mount request") and Docker does not retry. Containers whose sources are Windows
# paths (E:/...) come back by themselves. So every Compose call that creates or controls the long-lived containers is
# made here, from Windows, with docker.exe, and INSTANCE_ROOT spelled as a Windows path.
#
# What it holds, so the two scripts share one parser, one bounded runner and one Windows invocation:
#   Read-InstanceEnv         instance.env as setup.sh reads it
#   Invoke-Bounded           one native program, redirected output, a hard time limit, an optional explicit environment
#   Get-WindowsComposeCall   the docker.exe compose call for an instance folder (arguments and child environment)
#   Start-WindowsInstance    the ownership pass, then `up -d --no-build --pull never`
# Nothing here sets a variable in the script's own environment ($env:): the child environment is built explicitly.

# Where compose.yaml and the GPU overlays live: beside this file (packaging/ in the repository, the install folder
# when installed). Captured while this file is being dot-sourced, when $PSScriptRoot is this file's folder.
$WindowsComposePackaging = $PSScriptRoot

# Bounds, in seconds. The ownership pass walks every file under a service's mounts through the Windows file share, so
# it gets a long limit; `up` only creates and starts two containers.
$OwnershipPassSeconds = 600
$ComposeUpSeconds = 300

function ConvertTo-ArgumentString {
    param([string[]]$Arguments)
    $Parts = foreach ($Argument in $Arguments) {
        if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { $Argument }
        else { '"' + (($Argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }
    $Parts -join ' '
}

# Runs one native program with redirected output and a hard time limit. A program that is still running
# at the limit is killed together with its children (taskkill /T on the PID this function started).
# Returns Started, TimedOut, ExitCode, Output (stdout then stderr, NULs removed) and Milliseconds.
# -Environment, when given, is the complete environment of the child (the inherited one is discarded): this is how
# a caller keeps stray variables of its own out of docker.exe without touching $env: in its own process.
# The default limit equals setup.ps1's $CheckTimeoutSeconds (packaging/tests/test_setup_ps1.py compares them).
function Invoke-Bounded {
    param(
        [string]$FileName,
        [string[]]$Arguments,
        [int]$TimeoutSeconds = 60,
        [switch]$UnicodeOutput,
        [System.Collections.IDictionary]$Environment
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
    if ($UnicodeOutput) { $Info.StandardOutputEncoding = [System.Text.Encoding]::Unicode }
    if ($null -ne $Environment) {
        $Info.EnvironmentVariables.Clear()
        foreach ($Key in $Environment.Keys) { $Info.EnvironmentVariables[[string]$Key] = [string]$Environment[$Key] }
    }
    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $Info
    try {
        [void]$Process.Start()
    } catch {
        return [pscustomobject]@{ Started = $false; TimedOut = $false; ExitCode = -1; Output = $_.Exception.Message; Milliseconds = $Watch.ElapsedMilliseconds }
    }
    $Process.StandardInput.Close()
    $OutputTask = $Process.StandardOutput.ReadToEndAsync()
    $ErrorTask = $Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        # Windows PowerShell 5.1 turns each line of a redirected native stderr into an error record, and the callers'
        # $ErrorActionPreference 'Stop' makes that terminating (checked October 10, 2026): a taskkill that reports a
        # process of the tree already gone would throw out of here instead of returning TimedOut. Local to this function.
        $ErrorActionPreference = 'Continue'
        & taskkill.exe /T /F /PID $Process.Id *> $null
        [void]$Process.WaitForExit(5000)
        # What it printed before it was stopped, so a timed-out ownership pass or `up` is reported with the Compose
        # output too (amendment 15). Each read gets 2 s more: a pipe still held open elsewhere must not block the caller.
        $Partial = @()
        foreach ($Task in @($OutputTask, $ErrorTask)) {
            try { if ($Task.Wait(2000)) { $Partial += $Task.Result } } catch { $Partial += "(output unreadable: $($_.Exception.Message))" }
        }
        $Text = ($Partial -join "`n") -replace "`0", ''
        return [pscustomobject]@{ Started = $true; TimedOut = $true; ExitCode = -1; Output = $Text.Trim(); Milliseconds = $Watch.ElapsedMilliseconds }
    }
    $Process.WaitForExit()
    $Text = ($OutputTask.Result + "`n" + $ErrorTask.Result) -replace "`0", ''
    [pscustomobject]@{ Started = $true; TimedOut = $false; ExitCode = $Process.ExitCode; Output = $Text.Trim(); Milliseconds = $Watch.ElapsedMilliseconds }
}

# instance.env as setup.sh reads it: NAME=value lines, a single-quoted value unquoted. Returns a hashtable
# (case-insensitive keys, like the Windows environment it is compared with).
function Read-InstanceEnv {
    param([string]$Path)
    $Values = @{}
    foreach ($Line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        if ($Line -match '^\s*(#|$)') { continue }
        $Index = $Line.IndexOf('=')
        if ($Index -lt 1) { continue }
        $Value = $Line.Substring($Index + 1)
        if ($Value.Length -ge 2 -and $Value.StartsWith("'") -and $Value.EndsWith("'")) { $Value = $Value.Substring(1, $Value.Length - 2) }
        $Values[$Line.Substring(0, $Index)] = $Value
    }
    $Values
}

# The one place the Windows spelling of an instance root is derived, from the canonical INSTANCE_ROOT that setup.sh
# records in instance.env (a WSL path): /mnt/<drive letter> and the rest map to <UPPER>:<rest>, so /mnt/e/Vocalis/x
# gives E:/Vocalis/x and /mnt/e gives E:. Anything else (another automount root, \\wsl$, a non-drive root) throws:
# Windows cannot name it, so Docker Desktop could not mount it by itself either. setup.ps1 and the control script
# both come through here, so they cannot disagree about the spelling and the Compose config hash stays stable.
function ConvertTo-WindowsInstanceRoot {
    param([string]$LinuxRoot)
    if ($LinuxRoot -cmatch '^/mnt/([a-z])(/[^\r\n]*)?\z') {
        return ($Matches[1].ToUpperInvariant() + ':' + $Matches[2])
    }
    throw "The instance root '$LinuxRoot' recorded in instance.env is not a folder on a Windows drive as WSL mounts it (/mnt/<drive letter>/...), so Windows cannot start this instance by itself. Choose a data folder on a local drive, for example E:\Vocalis."
}

# The environment docker.exe is started with: the inherited one minus every name instance.env defines and every
# COMPOSE_* name (inside WSL the Windows environment never reached Compose; on Windows a stray VOCALIS_PORT or
# VOCALIS_IMAGE would override instance.env, because the process environment wins over --env-file), plus INSTANCE_ROOT
# spelled as a Windows path. Names compare without regard to case, as Windows does. $Inherited is a test seam; the
# default is this process's environment, read, never changed.
function Get-ComposeChildEnvironment {
    param([hashtable]$EnvValues, [string]$WindowsRoot, [System.Collections.IDictionary]$Inherited)
    $Source = if ($null -ne $Inherited) { $Inherited } else { [System.Environment]::GetEnvironmentVariables() }
    $Child = @{}
    foreach ($Key in @($Source.Keys)) {
        $Name = [string]$Key
        if (-not $Name) { continue }
        if ($EnvValues.ContainsKey($Name)) { continue }
        if ($Name -like 'COMPOSE_*') { continue }
        # The two Vocalis store paths always come from instance.env (or the defaults in compose.yaml when it has none):
        # a stray VOCALIS_DATA_PATH or VOCALIS_CACHE_PATH in this process must not override an old instance.env that
        # lacks the keys, because the process environment wins over --env-file (design section 11, item 4).
        if ($Name -eq 'VOCALIS_DATA_PATH' -or $Name -eq 'VOCALIS_CACHE_PATH') { continue }
        $Child[$Name] = [string]$Source[$Key]
    }
    $Child['INSTANCE_ROOT'] = $WindowsRoot
    $Child
}

# True when two paths name the same file (same volume and file index), whatever their spelling. setup.sh records
# INSTANCE_ROOT with `pwd -P`, which resolves junctions and symlinks, so a data folder reached through a junction is
# spelled differently on the two sides and a string comparison alone would refuse it every time (review, October 10,
# 2026). Missing or unreadable files are not the same file.
function Test-SameFile {
    param([string]$First, [string]$Second)
    # Inside the try: where Add-Type cannot compile (no csc, a locked-down language mode), the answer is "not the same
    # file", and the caller refuses with its own clear message instead of a compiler error.
    try {
        if (-not ('VocalisCompose.FileIdentity' -as [type])) {
            Add-Type -Namespace VocalisCompose -Name FileIdentity -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
}
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, out Info info);
public static string Of(string path) {
    using (var stream = new System.IO.FileStream(path, System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
        Info info;
        if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) return null;
        return info.VolumeSerial + ":" + info.IndexHigh + ":" + info.IndexLow;
    }
}
'@
        }
        $A = [VocalisCompose.FileIdentity]::Of($First)
        $B = [VocalisCompose.FileIdentity]::Of($Second)
        return ($null -ne $A -and $A -eq $B)
    } catch {
        return $false
    }
}

# The docker.exe compose call for an instance folder (the Windows folder that holds instance.env). Mirrors setup.sh's
#   docker compose --project-name "vocalis-$INSTANCE_ID" --env-file "$ENV_FILE_FOR_COMPOSE" -f base.yaml -f overlay.yaml [-f compose.local.yaml] "$@"
# with the overlay chosen by GPU_VARIANT and the optional per-machine file appended when it exists
# (packaging/tests/test_windows_installer.py compares the two). INSTANCE_ID and
# GPU_VARIANT are validated as setup.sh validates them. Throws, before anything touches Docker, when instance.env is
# missing or invalid, when its root cannot be derived (ConvertTo-WindowsInstanceRoot), or when the derived folder's
# instance.env is not the file that was read (a copied or restored instance.env that still names another folder).
# Returns Arguments (docker.exe's arguments: compose ... then the verb), Base (the same without the verb),
# Environment (see Get-ComposeChildEnvironment), EnvValues, EnvPath, InstanceId, GpuVariant and WindowsRoot.
function Get-WindowsComposeCall {
    param(
        [string]$InstanceFolder,
        [string[]]$Verb = @(),
        [string]$PackagingFolder = $WindowsComposePackaging,
        [System.Collections.IDictionary]$InheritedEnvironment
    )
    if (-not $PackagingFolder) { throw 'The packaging folder (the folder with compose.yaml) is not known.' }
    $EnvPath = Join-Path $InstanceFolder 'instance.env'
    if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) { throw "No instance.env exists in '$InstanceFolder'." }
    $ReadPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $EnvPath).ProviderPath)
    $EnvValues = Read-InstanceEnv $ReadPath
    $InstanceId = [string]$EnvValues['INSTANCE_ID']
    $GpuVariant = [string]$EnvValues['GPU_VARIANT']
    if ($InstanceId -cnotmatch '^[a-z0-9][a-z0-9-]{2,31}\z') { throw "Invalid INSTANCE_ID in instance.env: '$InstanceId'." }
    if ($GpuVariant -ne 'cuda' -and $GpuVariant -ne 'rocm') { throw "Invalid GPU_VARIANT in instance.env: '$GpuVariant'." }
    $WindowsRoot = ConvertTo-WindowsInstanceRoot ([string]$EnvValues['INSTANCE_ROOT'])
    try {
        $Derived = [System.IO.Path]::GetFullPath($WindowsRoot + '/instance.env')
    } catch {
        throw "The instance root '$($EnvValues['INSTANCE_ROOT'])' in instance.env cannot be used as a Windows path ($($_.Exception.Message))."
    }
    if (-not [string]::Equals($Derived, $ReadPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not (Test-SameFile $Derived $ReadPath)) {
        throw "instance.env was read from '$ReadPath' but records the instance root '$($EnvValues['INSTANCE_ROOT'])', which is '$Derived' on Windows. It belongs to another folder; refusing to start it from here."
    }
    $Overlay = if ($GpuVariant -eq 'cuda') { 'compose.cuda.yaml' } else { 'compose.rocm.yaml' }
    $Base = @('compose', '--project-name', "vocalis-$InstanceId", '--env-file', $ReadPath,
        '-f', (Join-Path $PackagingFolder 'compose.yaml'), '-f', (Join-Path $PackagingFolder $Overlay))
    # <root>/compose.local.yaml (design section 11, item 9, October 10, 2026): when present it is appended after the
    # variant file, exactly as setup.sh's compose() appends it. A reparse point (link, junction) is refused: setup.sh
    # refuses a link, and a link must not feed Compose a file from somewhere else. Setup.sh also requires the owner to be
    # the setup user; a Windows owner cannot be compared with a WSL uid, so that check stays with setup.sh, which
    # validates the same file (`compose config --quiet`) on every setup run.
    # The attributes are read with GetAttributes, which describes the link itself, so a dangling link (which Test-Path
    # reports as absent) is refused like any other, as setup.sh refuses it.
    $LocalCompose = Join-Path (Split-Path -Parent $ReadPath) 'compose.local.yaml'
    $LocalAttributes = $null
    try { $LocalAttributes = [System.IO.File]::GetAttributes($LocalCompose) } catch [System.IO.FileNotFoundException] { } catch [System.IO.DirectoryNotFoundException] { }
    if ($null -ne $LocalAttributes) {
        if (($LocalAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "compose.local.yaml must be a regular file, not a link: '$LocalCompose'." }
        if (($LocalAttributes -band [System.IO.FileAttributes]::Directory) -ne 0) { throw "compose.local.yaml must be a regular file: '$LocalCompose'." }
        $Base += @('-f', $LocalCompose)
    }
    [pscustomobject]@{
        Arguments = @($Base) + @($Verb)
        Base = $Base
        Environment = (Get-ComposeChildEnvironment -EnvValues $EnvValues -WindowsRoot $WindowsRoot -Inherited $InheritedEnvironment)
        EnvValues = $EnvValues
        EnvPath = $ReadPath
        InstanceId = $InstanceId
        GpuVariant = $GpuVariant
        WindowsRoot = $WindowsRoot
    }
}

# The ownership pass. The WSL /mnt mount shows files setup created earlier as 0:0 0777 through a Windows-path mount, and
# chmod, utime and copy2 onto them then fail with EPERM (design amendment 15, mount probe of October 10, 2026), so each
# service's files are given to its service user once, through the Windows invocation. One container per service, run as
# root with an explicit entrypoint, covering exactly that service's bind mounts in compose.yaml, and changing only files
# whose owner or group differs. `chown -h` so a symlink inside a store is never followed. `-ignore_readdir_race`
# because a rerun or Start can walk the folders while the services are still writing (logs, scratch): a file removed
# between listing and chown is not an error (a file listed and then removed before its chown batch still fails chown,
# so Start-WindowsInstance gives a failed pass one more walk, which touches only files that still differ). `--pull
# never` as for `up`: setup has just made sure the images are present. The uid and gid come from
# instance.env and are validated as plain numbers because they become container arguments.
function Get-OwnershipRuns {
    param([hashtable]$EnvValues)
    # The two Vocalis stores are at the container paths instance.env records (VOCALIS_DATA_PATH, VOCALIS_CACHE_PATH), with
    # the same defaults compose.yaml uses when a key is absent (design section 11, item 4); nothing on Windows sets them.
    # They become `find` arguments, so a value that is not a plain absolute path is refused.
    $DataPath = if ($EnvValues.ContainsKey('VOCALIS_DATA_PATH') -and $EnvValues['VOCALIS_DATA_PATH']) { [string]$EnvValues['VOCALIS_DATA_PATH'] } else { '/data/vocalis' }
    $CachePath = if ($EnvValues.ContainsKey('VOCALIS_CACHE_PATH') -and $EnvValues['VOCALIS_CACHE_PATH']) { [string]$EnvValues['VOCALIS_CACHE_PATH'] } else { '/cache/vocalis' }
    foreach ($Path in @($DataPath, $CachePath)) {
        if ($Path -cnotmatch '^/[A-Za-z0-9._/-]+\z') { throw "instance.env records a Vocalis folder path that is not a plain absolute path: '$Path'." }
    }
    $Runs = @()
    # Taproom: /etc/taproom is the configuration folder (data/taproom on the host) and /data/taproom/data its data folder
    # (design section 11, item 3). The data folder is also visible below the first as /etc/taproom/data, so that path is
    # pruned from the first walk and every file is looked at once (Spec[3]).
    foreach ($Spec in @(
            @('vocalis', 'VOCALIS', @($DataPath, $CachePath, '/models/vocalis', '/work/vocalis', '/logs'), $null),
            @('taproom', 'TAPROOM', @('/etc/taproom', '/data/taproom/data', '/logs'), '/etc/taproom/data'))) {
        $Uid = [string]$EnvValues["$($Spec[1])_UID"]
        $Gid = [string]$EnvValues["$($Spec[1])_GID"]
        if ($Uid -cnotmatch '^\d{1,10}\z' -or $Gid -cnotmatch '^\d{1,10}\z') {
            throw "instance.env has no valid $($Spec[1])_UID and $($Spec[1])_GID (found '$Uid' and '$Gid')."
        }
        $Verb = @('run', '--rm', '--no-deps', '--pull', 'never', '--user', '0', '--entrypoint', 'find', $Spec[0]) + @($Spec[2]) + @('-ignore_readdir_race')
        if ($Spec[3]) {
            # ( -path <nested mount> -prune ) -o ( ( differs ) -exec chown ... {} + )
            $Verb += @('(', '-path', $Spec[3], '-prune', ')', '-o', '(', '(', '!', '-user', $Uid, '-o', '!', '-group', $Gid, ')', '-exec', 'chown', '-h', "${Uid}:${Gid}", '{}', '+', ')')
        } else {
            $Verb += @('(', '!', '-user', $Uid, '-o', '!', '-group', $Gid, ')', '-exec', 'chown', '-h', "${Uid}:${Gid}", '{}', '+')
        }
        $Runs += [pscustomobject]@{ Service = $Spec[0]; Uid = $Uid; Gid = $Gid; Mounts = @($Spec[2]); Verb = $Verb }
    }
    $Runs
}

# After setup.sh (or from the Start shortcut): (a) the ownership pass, (b) `up -d --no-build --pull never`, both from
# Windows and both bounded and printed. The ownership pass runs first so the services never start on files they cannot
# chmod. Returns Success, Refused (the call could not be built; nothing touched Docker) and Message. Existing
# instances convert themselves here: `up` recreates both containers with Windows-path sources on the same folders and
# nothing is moved.
function Start-WindowsInstance {
    param([string]$InstanceFolder, [string]$DockerPath, [string]$PackagingFolder = $WindowsComposePackaging)
    $Watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $Call = Get-WindowsComposeCall -InstanceFolder $InstanceFolder -PackagingFolder $PackagingFolder
        $Runs = @(Get-OwnershipRuns $Call.EnvValues)
    } catch {
        Write-Host "Cannot start instance from '$InstanceFolder': $($_.Exception.Message)"
        return [pscustomobject]@{ Success = $false; Refused = $true; Message = $_.Exception.Message }
    }
    Write-Host "Starting instance $($Call.InstanceId) from Windows (INSTANCE_ROOT $($Call.WindowsRoot), project vocalis-$($Call.InstanceId))."
    foreach ($Run in $Runs) {
        Write-Host "Ownership pass for $($Run.Service): $($Run.Mounts.Count) mount(s) given to $($Run.Uid):$($Run.Gid) where they differ (limit $OwnershipPassSeconds s)..."
        $Result = Invoke-Bounded -FileName $DockerPath -Arguments ($Call.Base + $Run.Verb) -TimeoutSeconds $OwnershipPassSeconds -Environment $Call.Environment
        if (-not $Result.TimedOut -and $Result.ExitCode -ne 0) {
            # One more walk: a file can vanish between find listing it and its chown batch (see Get-OwnershipRuns).
            Write-Host "Ownership pass for $($Run.Service) exited with code $($Result.ExitCode); walking once more."
            if ($Result.Output) { Write-Host $Result.Output }
            $Result = Invoke-Bounded -FileName $DockerPath -Arguments ($Call.Base + $Run.Verb) -TimeoutSeconds $OwnershipPassSeconds -Environment $Call.Environment
        }
        if ($Result.TimedOut) {
            $Message = "The ownership pass for $($Run.Service) did not finish within $OwnershipPassSeconds s and was stopped."
            Write-Host $Message
            if ($Result.Output) { Write-Host $Result.Output }
            return [pscustomobject]@{ Success = $false; Refused = $false; Message = $Message }
        }
        if ($Result.ExitCode -ne 0) {
            $Message = "The ownership pass for $($Run.Service) failed with exit code $($Result.ExitCode) after $($Result.Milliseconds) ms."
            Write-Host $Message
            if ($Result.Output) { Write-Host $Result.Output }
            return [pscustomobject]@{ Success = $false; Refused = $false; Message = $Message }
        }
        Write-Host "Ownership pass for $($Run.Service) finished with exit code 0 after $($Result.Milliseconds) ms."
    }
    Write-Host "docker compose up -d --no-build --pull never (limit $ComposeUpSeconds s)..."
    $Up = Invoke-Bounded -FileName $DockerPath -Arguments ($Call.Base + @('up', '-d', '--no-build', '--pull', 'never')) -TimeoutSeconds $ComposeUpSeconds -Environment $Call.Environment
    if ($Up.TimedOut) {
        $Message = "docker compose up did not finish within $ComposeUpSeconds s and was stopped."
        Write-Host $Message
        if ($Up.Output) { Write-Host $Up.Output }
        return [pscustomobject]@{ Success = $false; Refused = $false; Message = $Message }
    }
    if ($Up.Output) { Write-Host $Up.Output }
    if ($Up.ExitCode -ne 0) {
        $Message = "docker compose up failed with exit code $($Up.ExitCode) after $($Up.Milliseconds) ms."
        Write-Host $Message
        return [pscustomobject]@{ Success = $false; Refused = $false; Message = $Message }
    }
    Write-Host "docker compose up exited with code 0 after $($Up.Milliseconds) ms; instance $($Call.InstanceId) started in $($Watch.ElapsedMilliseconds) ms."
    [pscustomobject]@{ Success = $true; Refused = $false; Message = '' }
}
