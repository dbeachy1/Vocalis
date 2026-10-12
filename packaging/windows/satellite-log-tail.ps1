# Follows the satellite's log file in a console window: prints the last lines of the file, then each new line as it is
# written. Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
#
# October 11, 2026. Doug, using the tray icon: "Give me an option that says tail the satellite log. You know, pop up in a
# new command prompt, simply tailing the log. And if I restart the satellite, keep that tail open, okay? Don't close it."
# The tray icon's menu item "Tail the satellite log" starts this script in its own console window:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File satellite-log-tail.ps1 -Path <root>\logs\satellite.log -Title "Vocalis Satellite log"
#
# What it does, and why it is a script and not "docker logs -f":
#   - It follows the FILE by name, not the container, so it keeps going when the satellite is stopped, started, restarted
#     or recreated, and when the tray icon exits. Only the person closing the window (or Ctrl+C) ends it.
#   - It opens the file for reading with every kind of sharing (read, write and delete), so it never stops the satellite
#     from writing the log or from rotating it. The satellite rotates at 10 MB by renaming satellite.log and starting a new
#     one under the same name; the script notices that the name now holds a different file (by the file's own identity
#     number, because a new file with the old name can inherit the old file's creation time on NTFS), reads what the old
#     file still had, and continues with the new file from its start. A file that becomes shorter is read from its start.
#   - A file that does not exist yet is announced in one line, and following starts when it appears.
#   - Lines are shown as written (UTF-8). A last line without its line break is held back until the break arrives.
#   - There is no pause at the end and no prompt: the window stays as long as the script runs.
#
#   - Nothing but the person closes the window: a log that cannot be read is said in one line and tried again.
#
# Nothing here decides anything about the satellite; it only reads one file and writes no file of its own (PowerShell
# compiles the small helper below through temporary files in the user's temp folder and removes them).
[CmdletBinding()]
param(
    # The log file to follow (<satellite folder>\logs\satellite.log).
    [Parameter(Mandatory = $true)][string]$Path,
    # The console window's title.
    [string]$Title = 'Vocalis Satellite log',
    # How many of the last lines to show first.
    [ValidateRange(0, 100000)][int]$Lines = 50,
    # How often the file is looked at, in milliseconds.
    [ValidateRange(20, 60000)][int]$PollMilliseconds = 250
)

$ErrorActionPreference = 'Stop'

# The window title. A host with no window (the tests run this with its output piped) refuses; that is not a failure.
try { $Host.UI.RawUI.WindowTitle = $Title } catch { }
# Show the lines as they are written, UTF-8, whatever the console's code page is. A host with no console refuses; the
# output is then whatever the host does with it.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# Do not sit in the folder this was started from. The tray icon starts it in the satellite's program folder, and Windows
# cannot remove a folder that is some running program's current folder: with a log window left open, an uninstall would
# leave the empty program folder behind until the window is closed.
$Path = [System.IO.Path]::GetFullPath($Path)
try {
    [Environment]::CurrentDirectory = $env:SystemRoot
    Set-Location -LiteralPath $env:SystemRoot
} catch { }

# The identity of an open file: the volume number and the file index. Two handles have the same one exactly when they
# are the same file, which is the only reliable way to tell a rotated file from a file that was only written to.
# A computer whose policy does not let PowerShell compile this helper still gets a working viewer: Get-FileId then falls
# back to the file's creation time, which misses only a rotation that reuses the name within a few seconds.
$nativeIdentity = $true
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SatelliteLogTailNative
{
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation information);

    public static string FileId(SafeFileHandle handle)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) return "unknown";
        return information.VolumeSerialNumber.ToString("x8") + ":" + information.FileIndexHigh.ToString("x8") + information.FileIndexLow.ToString("x8");
    }
}
'@
} catch {
    $nativeIdentity = $false
}

function Get-FileId([System.IO.FileStream]$Stream) {
    if ($script:nativeIdentity) { return [SatelliteLogTailNative]::FileId($Stream.SafeFileHandle) }
    return 'created:' + [System.IO.File]::GetCreationTimeUtc($Stream.Name).Ticks
}

# Opens the file for reading with every kind of sharing, or returns $null and says why in $script:openProblem:
# 'missing' (no such file or folder) or 'blocked' (it is there but cannot be opened now: in use without sharing, or no
# access). The two are different things to the loop below: a missing name can mean a rotation or a deleted file, a
# blocked one means only "try again", and must never make the viewer start the file over.
$openProblem = ''
function Open-Log {
    $script:openProblem = ''
    try {
        return New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
            ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete), 4096)
    } catch [System.IO.FileNotFoundException] {
        $script:openProblem = 'missing'
    } catch [System.IO.DirectoryNotFoundException] {
        $script:openProblem = 'missing'
    } catch [System.IO.IOException] {
        $script:openProblem = 'blocked'
    } catch [System.UnauthorizedAccessException] {
        $script:openProblem = 'blocked'
    }
    return $null
}

# The offset in the stream where its last $Count lines begin (0 when it has fewer). A final line break does not count as
# the start of another line. The search runs backwards in blocks, so a file of any size costs one read of the tail.
function Get-TailStart([System.IO.FileStream]$Stream, [int]$Count) {
    $length = $Stream.Length
    if ($Count -le 0) { return $length }
    $blockSize = 65536
    $block = New-Object byte[] $blockSize
    $found = 0
    $end = $length
    $first = $true
    while ($end -gt 0) {
        $start = [Math]::Max(0, $end - $blockSize)
        $size = [int]($end - $start)
        [void]$Stream.Seek($start, [System.IO.SeekOrigin]::Begin)
        $got = 0
        while ($got -lt $size) {
            $n = $Stream.Read($block, $got, $size - $got)
            if ($n -le 0) { break }
            $got += $n
        }
        for ($i = $got - 1; $i -ge 0; $i--) {
            if ($block[$i] -eq 10) {
                if ($first -and $i -eq $got - 1 -and $end -eq $length) { continue }
                $found++
                if ($found -eq $Count) { return ($start + $i + 1) }
            }
        }
        $first = $false
        $end = $start
    }
    return 0
}

$decoder = (New-Object System.Text.UTF8Encoding($false)).GetDecoder()
$buffer = New-Object byte[] 65536
$chars = New-Object char[] 65536
$carry = ''
$stream = $null
$identity = ''
$announcedMissing = $false
$firstOpen = $true
$missingTimer = $null

# Reads what the open file has beyond the stream's position and prints each complete line.
function Read-More {
    $text = New-Object System.Text.StringBuilder
    while ($true) {
        $got = $script:stream.Read($script:buffer, 0, $script:buffer.Length)
        if ($got -le 0) { break }
        $count = $script:decoder.GetChars($script:buffer, 0, $got, $script:chars, 0)
        [void]$text.Append($script:chars, 0, $count)
    }
    if ($text.Length -eq 0) { return }
    $all = $script:carry + $text.ToString()
    $parts = $all.Split([char]10)
    $out = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        [void]$out.Append($parts[$i].TrimEnd([char]13)).Append("`n")
    }
    $script:carry = $parts[$parts.Length - 1]
    if ($out.Length -gt 0) {
        [Console]::Out.Write($out.ToString())
        [Console]::Out.Flush()
    }
}

function Write-Notice([string]$Text) {
    [Console]::Out.Write($Text + "`n")
    [Console]::Out.Flush()
}

# Where the viewer was in the file it last let go of, so that the same file coming back is continued, not printed again.
$lastIdentity = ''
$lastPosition = 0
$lastTrouble = ''

while ($true) {
  # Nothing may close this window but the person using it: an error nobody foresaw (the drive went away, a read failed)
  # is said once in plain words, and the viewer starts over with the file as it then is.
  try {
    if ($null -eq $stream) {
        $stream = Open-Log
        if ($null -eq $stream) {
            if (-not $announcedMissing) {
                if ($openProblem -eq 'blocked') {
                    Write-Notice ("The log file cannot be opened right now (in use, or no access): " + $Path + " - waiting for it.")
                } else {
                    Write-Notice ("The log file does not exist yet: " + $Path + " - waiting for it.")
                }
                $announcedMissing = $true
            }
            Start-Sleep -Milliseconds $PollMilliseconds
            continue
        }
        $identity = Get-FileId $stream
        if ($firstOpen) {
            # The last lines of the file first, then the loop follows it from there.
            [void]$stream.Seek((Get-TailStart $stream $Lines), [System.IO.SeekOrigin]::Begin)
            $firstOpen = $false
        } elseif ($identity -eq $lastIdentity -and $stream.Length -ge $lastPosition) {
            # The same file as before (it was only out of reach for a while): continue where the viewer stopped.
            [void]$stream.Seek($lastPosition, [System.IO.SeekOrigin]::Begin)
        }
        $carry = ''
        $decoder.Reset()
        $lastTrouble = ''
    }

    Read-More

    # The file became shorter (it was emptied or replaced in place): continue from its start.
    if ($stream.Position -gt $stream.Length) {
        Write-Notice 'The log file became shorter; following it from its start.'
        [void]$stream.Seek(0, [System.IO.SeekOrigin]::Begin)
        $carry = ''
        $decoder.Reset()
        continue
    }

    # What does the name hold now? The same file (nothing to do), a different one (rotation), or nothing (the old file was
    # renamed and the new one is not there yet: keep reading the old one, which no longer grows).
    $current = Open-Log
    if ($null -ne $current) {
        $missingTimer = $null
        $currentId = Get-FileId $current
        if ($currentId -ne $identity) {
            # What the old file still had was written before it was renamed; read it to its end first.
            Read-More
            if ($carry.Length -gt 0) { Write-Notice $carry.TrimEnd([char]13); $carry = '' }
            $stream.Dispose()
            $stream = $current
            $identity = $currentId
            $decoder.Reset()
            Write-Notice 'The log file was replaced (rotated); following the new file from its start.'
            continue
        }
        $current.Dispose()
    } elseif ($openProblem -eq 'blocked') {
        # The name is there but cannot be opened a second time just now (another program has it without sharing). The
        # handle already open keeps working; there is nothing to conclude about rotation from this.
        $missingTimer = $null
    } else {
        # The name holds nothing: the file was renamed (a rotation is about to create the new one) or deleted. The open
        # handle keeps reading what the old file still gets. A file that has been gone for two seconds is let go, so that a
        # deleted file is really deleted (Windows keeps a deleted file until its last reader closes it, and meanwhile the
        # name cannot be created again); the loop then says the file does not exist and waits for it to appear.
        if ($null -eq $missingTimer) {
            $missingTimer = [System.Diagnostics.Stopwatch]::StartNew()
        } elseif ($missingTimer.ElapsedMilliseconds -ge 2000) {
            Read-More
            if ($carry.Length -gt 0) { Write-Notice $carry.TrimEnd([char]13); $carry = '' }
            $lastIdentity = $identity
            $lastPosition = $stream.Position
            $stream.Dispose()
            $stream = $null
            $missingTimer = $null
            $announcedMissing = $false
            continue
        }
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  } catch {
    $trouble = $_.Exception.Message
    if ($trouble -ne $lastTrouble) {
        try { Write-Notice ("The log could not be read (" + $trouble + "). Trying again.") } catch { }
        $lastTrouble = $trouble
    }
    if ($null -ne $stream) {
        try { $lastIdentity = $identity; $lastPosition = $stream.Position } catch { $lastIdentity = '' }
        try { $stream.Dispose() } catch { }
        $stream = $null
    }
    $missingTimer = $null
    $announcedMissing = $false
    Start-Sleep -Milliseconds 1000
  }
}
