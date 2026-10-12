# Drive the Vocalis Satellite setup program (or its installed copy in a maintenance mode, or its uninstaller) through the
# real wizard with UI Automation, for tests. Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file as the
# ANSI code page. It is the satellite counterpart of drive_installer.ps1 (that file is not changed; the helper functions
# below are copied from it, where they were proven on the hidden desktop on October 9, 2026) and adds the pages of
# packaging/windows/vocalis-satellite.iss: Welcome, Prerequisites (with Retry), Satellite folder, Port name and starting,
# New certificate, Pair with Vocalis, Ready, Setting up and Finish.
#
# Run it ON the shared hidden desktop (packaging/windows/tests/hidden_desktop.py), because UI Automation only sees
# windows on its own desktop. Everything it starts then draws there and nothing appears on the user's screen. Never
# run it on the visible desktop, and ALWAYS against a test-identity build (build-satellite-installer.ps1 -TestIdentity
# <word>): the real program's install is Doug's, and this driver refuses to touch it (-TestIdentity is mandatory).
#
# Actions:
#   install      run -Installer through the pages. The satellite folder is -Root; the port, name, extra address and
#                the start-with-Windows tick come from -Port, -Name, -ExtraAddress and -Autostart. The pairing secret
#                is read from -SecretFile (a file; the driver reads it into memory, types it into the page's masked box
#                with a window message, and never writes it to the log). The Copy buttons are never pressed: the hidden
#                desktop shares the clipboard with the visible one.
#   maintenance  run the installed copy with /MODE=<repair|newsecret|newcertificate> (-Mode), found through the
#                uninstall key of the test identity; the same page handling.
#   uninstall    run the installed uninstaller of the test identity, confirm, and record its final message.
#
# The setup program is started with VOCALIS_SATELLITE_TEST_NO_SHELL=1, so it opens no Explorer or Notepad; it appends
# what it would have done to <program folder>\test-shell-actions.log instead. It still starts the tray icon, which
# lands on this hidden desktop as the wizard's child and inherits the variable.
#
# Every window, dialog and message box the wizard shows is written to -Log as text (the secret never is). A message box
# the script did not expect stops the run with its text, because on a hidden desktop nobody would ever see it. The script
# only ever stops processes it started itself (by PID), never by name.
#
# Exit codes: 0 the wizard completed (the setup program's own outcome is in the log: "Finish page: ..." and the exit
# code); 1 the wizard went somewhere unexpected (the log says where); 3 the setup program refused before its wizard (the
# message is logged); 4 the prerequisite checks failed and -PrereqRetries was used up (the log has the page text);
# 5 the wizard completed on the "Setup did not finish" page; 6 the prerequisite checks failed and -CancelOnPrereqFailure
# cancelled the wizard (the log has Next's state and the setup program's exit code); 7 -CancelAtPage reached its page,
# captured it and cancelled; 124 a step timed out.

param(
    [Parameter(Mandatory = $true)][ValidateSet('install', 'maintenance', 'uninstall')][string]$Action,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{1,16}$')][string]$TestIdentity,
    [string]$Installer,
    [string]$Mode,
    [string]$Root,
    [int]$Port = 0,
    [string]$Name,
    [string]$ExtraAddress,
    [ValidateSet('on', 'off', '')][string]$Autostart = '',
    [string]$SecretFile,
    # How many times to press Retry on a failed prerequisites page before giving up (exit 4).
    [int]$PrereqRetries = 0,
    # On a failed prerequisites page (after the retries): log whether Next is enabled, capture the page, press Cancel,
    # confirm, and exit 6 instead of killing the wizard (exit 4).
    [switch]$CancelOnPrereqFailure,
    # October 11, 2026 (the wizard header picture check): when the page text matches this regular expression
    # (case-sensitive; for example 'License Agreement'), capture it as cancel-at-page.png into -CaptureDir, press Cancel,
    # confirm, and exit 7. Installs nothing.
    [string]$CancelAtPage,
    # A failure test: after the port page's Next, start a listener on this port (a child of this script, stopped by PID
    # when the wizard finishes), so the setup script's own port check, which runs later, finds the port taken.
    [int]$HoldPort = 0,
    # Passed to the setup program as /LOG=<file>: Inno's own log of the run (live re-check, October 11, 2026: it shows
    # whether a maintenance run wrote the uninstaller).
    [string]$InnoLog,
    # On the "Setup did not finish" page, press the button with this name (for example 'Open the log') before Finish.
    [string]$PressOnFailure,
    # A folder to write PNG captures of the wizard into (the first page, the Setting up page and the Finish page).
    [string]$CaptureDir,
    [Parameter(Mandatory = $true)][string]$Log,
    # A first run pulls an image and downloads the model files before the Finish page appears.
    [int]$SetupTimeoutMinutes = 120
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
$AE = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]
# Inno Setup's own controls (TNewButton, TNewCheckBox, TNewEdit, TPasswordEdit...) reach UI Automation as plain panes
# with no Invoke/Selection/Value pattern (seen October 9, 2026), but each is a real window with a handle. So the driver
# finds controls through UI Automation and acts on them with ordinary window messages, which need neither the mouse nor
# focus. PostMessage for clicks: a click can start long work (the prerequisite checks), and the driver must not block.
Add-Type -Namespace VocalisTest -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
'@
$BM_CLICK = 0x00F5
$BM_GETCHECK = 0x00F0
$WM_SETTEXT = 0x000C
$Started = @()   # PIDs this script started; the only ones it may stop

function Write-Step([string]$Text) {
    $line = (Get-Date).ToString('HH:mm:ss') + '  ' + $Text
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
}

# The AppId of a test-identity build: the same derivation as Get-TestIdentityGuid in build-satellite-installer.ps1
# (packaging/tests/test_satellite_windows_installer.py proves the two agree).
function Get-TestIdentityGuid {
    param([string]$Word)
    $Sha = [Security.Cryptography.SHA256]::Create()
    try { $Bytes = $Sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("vocalis-satellite-test-identity:$Word")) } finally { $Sha.Dispose() }
    $Hex = ([BitConverter]::ToString($Bytes) -replace '-', '').Substring(0, 32)
    return ('{0}-{1}-{2}-{3}-{4}' -f $Hex.Substring(0, 8), $Hex.Substring(8, 4), $Hex.Substring(12, 4), $Hex.Substring(16, 4), $Hex.Substring(20, 12))
}

function Fail([string]$Text, [int]$Code = 1) {
    Write-Step "FAILED: $Text"
    # What the wizard was showing, control by control, so the next fix does not need another run.
    foreach ($w in (Get-TopWindows (Get-Family $Started).Ids)) {
        Write-Step ("window: " + $w.Current.ClassName + " '" + $w.Current.Name + "'")
        foreach ($c in $w.FindAll($TreeScope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            $n = $c.Current.Name
            # A masked box has no readable name; a long text is cut. The secret is never read by this script back out
            # of the box, so it cannot appear here.
            if ($n.Length -gt 80) { $n = $n.Substring(0, 80) + '...' }
            Write-Step ("  " + $c.Current.ControlType.ProgrammaticName + " class=" + $c.Current.ClassName + " enabled=" + $c.Current.IsEnabled + " name='" + $n + "'")
        }
    }
    Stop-Started
    exit $Code
}

# Stops every process this script started and their descendants, by PID, children first. Nothing else.
function Stop-Started {
    if (-not $Started.Count) { return }
    $family = Get-Family $Started
    $ids = @($family.Ids)
    [array]::Reverse($ids)
    foreach ($id in $ids) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p) { Write-Step ("stopping pid " + $id + " (" + $p.ProcessName + ")"); Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    }
}

function Clean([string]$Name) { return ($Name -replace '&', '').Trim() }

function Get-TopWindows([int[]]$ProcessIds) {
    $all = $AE::RootElement.FindAll($TreeScope::Children, [System.Windows.Automation.Condition]::TrueCondition)
    return @($all | Where-Object { $ProcessIds -contains $_.Current.ProcessId })
}

# Every process id descended from the given roots (the Inno loader starts the real wizard as a child).
function Get-Family([int[]]$Roots) {
    $procs = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine)
    $family = New-Object System.Collections.Generic.List[int]
    foreach ($r in $Roots) { $family.Add($r) }
    $grew = $true
    while ($grew) {
        $grew = $false
        foreach ($p in $procs) {
            if ($family.Contains([int]$p.ParentProcessId) -and -not $family.Contains([int]$p.ProcessId)) {
                $family.Add([int]$p.ProcessId); $grew = $true
            }
        }
    }
    return @{ Ids = $family.ToArray(); Procs = $procs }
}

function Get-Texts($Element) {
    $texts = $Element.FindAll($TreeScope::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
        ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_.Trim() }
    return (@($texts) -join ' | ')
}

# Controls are matched by window class (a regex: 'Button' matches Inno's TNewButton and a message box's Button) and
# by name; UI Automation's control type is not reliable for Inno's controls.
function Find-Control($Window, [string]$ClassPattern, [string]$NamePattern) {
    foreach ($c in $Window.FindAll($TreeScope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($c.Current.ClassName -match $ClassPattern -and (-not $NamePattern -or (Clean $c.Current.Name) -match $NamePattern)) { return $c }
    }
    return $null
}

function Find-Controls($Window, [string]$ClassPattern) {
    return @($Window.FindAll($TreeScope::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object { $_.Current.ClassName -match $ClassPattern })
}

function Send-Click($Element) {
    [void][VocalisTest.Win32]::PostMessage([IntPtr]$Element.Current.NativeWindowHandle, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
}

function Set-Text($Element, [string]$Text) {
    [void][VocalisTest.Win32]::SendMessage([IntPtr]$Element.Current.NativeWindowHandle, $WM_SETTEXT, [IntPtr]::Zero, $Text)
}

function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $value = & $Test
        if ($value) { return $value }
        Start-Sleep -Milliseconds 500
    }
    Fail "timed out after $Seconds s waiting for $What" 124
}

# A message box (#32770) from the wizard's process family. Inno's own message boxes are owned by the wizard and show up
# under it in the UI Automation tree, not as top-level windows, so both places are searched.
function Get-MessageBox([int[]]$Roots) {
    foreach ($w in (Get-TopWindows (Get-Family $Roots).Ids)) {
        if ($w.Current.ClassName -eq '#32770') { return $w }
        $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770')
        $inner = $w.FindFirst($TreeScope::Descendants, $cond)
        if ($inner) { return $inner }
    }
    return $null
}

# The click is posted, so it lands after this returns; the choice is made when the radio reports itself checked.
function Select-Choice($Element) {
    $handle = [IntPtr]$Element.Current.NativeWindowHandle
    Send-Click $Element
    [void](Wait-Until { [VocalisTest.Win32]::SendMessage($handle, $BM_GETCHECK, [IntPtr]::Zero, [IntPtr]::Zero) -eq [IntPtr]1 } 30 "'$(Clean $Element.Current.Name)' to be selected")
    Write-Step ("selected '" + (Clean $Element.Current.Name) + "'")
}

# A check box is brought to the wanted state: read its state, click only when it differs, wait for the new state.
function Set-Check($Element, [bool]$Wanted) {
    $handle = [IntPtr]$Element.Current.NativeWindowHandle
    $now = ([VocalisTest.Win32]::SendMessage($handle, $BM_GETCHECK, [IntPtr]::Zero, [IntPtr]::Zero) -eq [IntPtr]1)
    if ($now -ne $Wanted) {
        Send-Click $Element
        [void](Wait-Until { (([VocalisTest.Win32]::SendMessage($handle, $BM_GETCHECK, [IntPtr]::Zero, [IntPtr]::Zero) -eq [IntPtr]1) -eq $Wanted) } 30 "'$(Clean $Element.Current.Name)' to be $Wanted")
    }
    Write-Step ("check box '" + (Clean $Element.Current.Name) + "' is now " + $Wanted)
}

# The press has taken effect when the window has visibly moved on: its text changed (the next wizard page), the button
# or its window went away (a message box answered, the wizard finished), or a message box came up over it (the page
# refused, with a reason). Without that, the next look at the window could still see the page just answered and press
# its button twice.
function Invoke-Button($Window, [string]$NamePattern) {
    $button = Wait-Until { $b = Find-Control $Window 'Button' $NamePattern; if ($b -and $b.Current.IsEnabled) { $b } } 30 "an enabled '$NamePattern' button"
    $buttonHandle = [IntPtr]$button.Current.NativeWindowHandle
    $windowHandle = [IntPtr]$Window.Current.NativeWindowHandle
    $owner = $Window.Current.ProcessId
    $before = Get-Texts $Window
    Write-Step ("press '" + (Clean $button.Current.Name) + "'")
    Send-Click $button
    [void](Wait-Until {
        if (-not [VocalisTest.Win32]::IsWindow($buttonHandle) -or -not [VocalisTest.Win32]::IsWindowVisible($windowHandle)) { return $true }
        if (Get-MessageBox @($owner) | Where-Object { $_.Current.NativeWindowHandle -ne $windowHandle }) { return $true }
        try { return (Get-Texts $Window) -ne $before } catch { return $true }
    } 120 "the window to respond to '$NamePattern'")
}

function Get-WizardWindow([int[]]$Roots) {
    foreach ($w in (Get-TopWindows (Get-Family $Roots).Ids)) {
        if ($w.Current.ClassName -eq 'TWizardForm' -or $w.Current.ClassName -eq 'TUninstallProgressForm') { return $w }
    }
    return $null
}

# Captures the window to a PNG with PrintWindow (the window paints itself, so the hidden desktop does not matter). The
# title bar in the capture shows the window icon: that is the evidence that the Vocalis icon is on the wizard.
function Save-Capture($Window, [string]$Name) {
    if (-not $CaptureDir) { return }
    New-Item -ItemType Directory -Path $CaptureDir -Force | Out-Null
    $path = Join-Path $CaptureDir $Name
    $h = [IntPtr]$Window.Current.NativeWindowHandle
    $rect = New-Object VocalisTest.Win32+RECT
    [void][VocalisTest.Win32]::GetWindowRect($h, [ref]$rect)
    $w = $rect.Right - $rect.Left; $ht = $rect.Bottom - $rect.Top
    $bmp = New-Object System.Drawing.Bitmap($w, $ht)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    # Flag 0 (the window paints itself), not 2 (the compositor's last frame, which a hidden desktop does not reliably
    # have): see Save-Capture in drive_installer.ps1 for the false blank picture flag 2 produced on October 11, 2026.
    $ok = [VocalisTest.Win32]::PrintWindow($h, $hdc, 0)
    $g.ReleaseHdc($hdc); $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    # Where the window's client area starts inside the picture and how big it is, so a measuring script can tell the wizard's
    # own pixels from the frame (the header picture check, October 11, 2026).
    $client = New-Object VocalisTest.Win32+RECT
    [void][VocalisTest.Win32]::GetClientRect($h, [ref]$client)
    $origin = New-Object VocalisTest.Win32+POINT
    [void][VocalisTest.Win32]::ClientToScreen($h, [ref]$origin)
    Write-Step ("capture " + $path + " " + $w + "x" + $ht + " PrintWindow=" + $ok + " client=" + ($origin.X - $rect.Left) + "," + ($origin.Y - $rect.Top) + "," + $client.Right + "," + $client.Bottom)
}

# A listener on all interfaces of the given port, in a child process of this script (a failure test: the setup script
# must find the port taken). Its PID is the only thing stopped later.
function Start-PortHolder([int]$HeldPort) {
    $code = "`$l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $HeldPort); `$l.Start(); Start-Sleep -Seconds 900"
    $holder = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-Command', $code) -PassThru -WindowStyle Hidden
    $script:HolderPid = $holder.Id
    $Started += $holder.Id
    $up = Wait-Until { try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $HeldPort); $c.Close(); $true } catch { $false } } 30 "the port holder on $HeldPort"
    Write-Step "port $HeldPort is now held by pid $($script:HolderPid)"
}

function Stop-PortHolder {
    if ($script:HolderPid) {
        Stop-Process -Id $script:HolderPid -Force -ErrorAction SilentlyContinue
        Write-Step "stopped the port holder pid $($script:HolderPid)"
        $script:HolderPid = 0
    }
}

# Answers the wizard's pages until it finishes. $Roots are the process ids the setup program was started as.
function Invoke-Wizard($Proc) {
    $secret = $null
    if ($SecretFile) {
        if (-not (Test-Path -LiteralPath $SecretFile -PathType Leaf)) { Fail "secret file not found: $SecretFile" }
        # Read into memory only; the value is never written to the log, and only its length is.
        $secret = ([IO.File]::ReadAllText($SecretFile)).Trim()
        Write-Step ("secret read from the file, length " + $secret.Length)
    }
    $deadline0 = (Get-Date).AddSeconds(60)
    $wizard = $null
    while (-not $wizard -and (Get-Date) -lt $deadline0) {
        # The setup program can answer before any wizard exists (the refusal to roll a newer install back, a mode with
        # nothing to do): such a message is the run's outcome, logged and closed, and the script exits 3.
        $early = Get-MessageBox @($Proc.Id)
        if ($early -and (Get-Texts $early) -cmatch 'No satellite is set up in' -and (Get-Texts $early) -cmatch 'Set up a new satellite') {
            # A repair of a folder that does not exist (a first run that failed before satellite.env was written): the
            # setup program offers a fresh setup with the saved port and name before its wizard opens. Accept it.
            Write-Step ("fresh setup offered before the wizard, accepting: " + (Get-Texts $early))
            Invoke-Button $early '^Yes'
            Start-Sleep -Seconds 2
            continue
        }
        if ($early) {
            Write-Step ("setup program message before the wizard: " + (Get-Texts $early))
            Invoke-Button $early '^OK'
            $Proc.WaitForExit(30000) | Out-Null
            Write-Step "setup program exit code $($Proc.ExitCode)"
            exit 3
        }
        $wizard = Get-WizardWindow @($Proc.Id)
        if (-not $wizard) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $wizard) { Fail 'timed out after 60 s waiting for the wizard window' 124 }
    Write-Step ("wizard: " + $wizard.Current.Name)

    $finished = $false
    $failurePage = $false
    $prereqTries = 0
    $captured = @{}
    $deadline = (Get-Date).AddMinutes($SetupTimeoutMinutes + 30)
    $lastPage = ''
    $captureSeq = 0
    $settingCaptures = 0
    while (-not $finished -and (Get-Date) -lt $deadline) {
        $box = Get-MessageBox @($Proc.Id)
        if ($box) {
            $boxText = Get-Texts $box
            # The folder page offers "use this satellite" for a folder that already holds one (a take-over).
            if ($boxText -cmatch 'already holds a satellite') {
                Write-Step ("take-over offered, accepting: " + $boxText)
                Invoke-Button $box '^Yes'
                continue
            }
            # The port page offers the next free port when the one asked for is busy.
            if ($boxText -cmatch 'cannot be used on this computer' -and $boxText -cmatch 'instead\?') {
                Write-Step ("port busy, accepting the suggested one: " + $boxText)
                Invoke-Button $box '^Yes'
                continue
            }
            # A satellite whose folder was deleted by hand: the repair mode offers a fresh setup there.
            if ($boxText -cmatch 'No satellite is set up in' -and $boxText -cmatch 'Set up a new satellite') {
                Write-Step ("fresh setup offered, accepting: " + $boxText)
                Invoke-Button $box '^Yes'
                continue
            }
            Fail ("unexpected message box: " + $boxText)
        }
        $wizard = Get-WizardWindow @($Proc.Id)
        if (-not $wizard) {
            if ($Proc.HasExited) { Write-Step "setup program exited with code $($Proc.ExitCode)"; break }
            Start-Sleep -Seconds 1; continue
        }
        $page = Get-Texts $wizard
        if ($page -ne $lastPage) {
            Write-Step ("page: " + $page.Substring(0, [Math]::Min(700, $page.Length))); $lastPage = $page
            # A capture of every new page (live run, October 11, 2026: the proof needs the look of each page, and two
            # captures of the Setting up page with different step titles). The Setting up page changes with every
            # output line, so it is capped.
            $isSetting = ($page -cmatch 'Setting up the satellite')
            if (-not $isSetting -or $settingCaptures -lt 8) {
                if ($isSetting) { $settingCaptures++ }
                $captureSeq++
                $tag = (($page -replace '[^A-Za-z0-9]+', '-').Trim('-'))
                if ($tag.Length -gt 28) { $tag = $tag.Substring(0, 28) }
                Save-Capture $wizard ('{0:D2}-{1}.png' -f $captureSeq, $tag)
            }
        }
        if (-not $captured.ContainsKey('first')) { Save-Capture $wizard 'wizard-first-page.png'; $captured['first'] = $true }

        if ($CancelAtPage -and $page -cmatch $CancelAtPage) {
            Write-Step "page matches -CancelAtPage '$CancelAtPage': capturing it and cancelling"
            Save-Capture $wizard 'cancel-at-page.png'
            Invoke-Button $wizard '^Cancel'
            $confirm = Wait-Until { Get-MessageBox @($Proc.Id) } 30 'the Exit Setup question'
            Write-Step ("cancel question: " + (Get-Texts $confirm))
            Invoke-Button $confirm '^Yes'
            $Proc.WaitForExit(60000) | Out-Null
            Write-Step ("setup program exited: " + $Proc.HasExited + ", exit code " + $Proc.ExitCode)
            exit 7
        }

        # Most specific first, case-sensitive: some phrases appear on several pages.
        $finishButton = Find-Control $wizard 'Button' '^Finish'
        if ($finishButton) {
            Write-Step ("finish page: " + $page)
            foreach ($e in (Find-Controls $wizard 'Edit')) {
                # The read-only boxes of the Finish page (the certificate path and the fingerprint) are public values.
                Write-Step ("finish box: " + $e.Current.ClassName + " '" + $e.Current.Name + "'")
            }
            Save-Capture $wizard 'wizard-finish-page.png'
            if ($page -cmatch 'Setup did not finish') {
                $failurePage = $true; Write-Step 'the Setup did not finish page is shown'
                if ($PressOnFailure) {
                    $extra = Find-Control $wizard 'Button' ('^' + [regex]::Escape($PressOnFailure))
                    if (-not $extra) { Fail "no '$PressOnFailure' button on the failure page" }
                    Send-Click $extra
                    Write-Step "pressed '$PressOnFailure' on the failure page"
                    Start-Sleep -Seconds 2
                }
            }
            Invoke-Button $wizard '^Finish'
            $finished = $true
        } elseif ($page -cmatch 'Welcome to the' -or $page -cmatch 'A satellite lets Vocalis') {
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'License Agreement') {
            $accept = Find-Control $wizard 'RadioButton' '^I accept'
            if (-not $accept) { Fail 'no "I accept" choice on the licence page' }
            Select-Choice $accept
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'The satellite needs Docker Desktop') {
            $status = Wait-Until {
                $t = Get-Texts (Get-WizardWindow @($Proc.Id))
                if ($t -cmatch 'All checks passed' -or $t -cmatch 'A check failed') { $t }
            } 900 'the prerequisite checks'
            if ($status -cmatch 'A check failed') {
                Write-Step ("prerequisites failed: " + $status)
                if ($prereqTries -lt $PrereqRetries) {
                    $prereqTries++
                    Write-Step "pressing Retry ($prereqTries of $PrereqRetries)"
                    Invoke-Button $wizard '^Retry'
                    continue
                }
                if ($CancelOnPrereqFailure) {
                    # Live run, October 11, 2026: the failed page must disable Next, and Cancel must leave nothing installed.
                    $next = Find-Control $wizard 'Button' '^Next'
                    Write-Step ("failed page: Next enabled = " + $next.Current.IsEnabled)
                    Save-Capture $wizard 'prerequisite-failure-page.png'
                    Invoke-Button $wizard '^Cancel'
                    $confirm = Wait-Until { Get-MessageBox @($Proc.Id) } 30 'the Exit Setup question'
                    Write-Step ("cancel question: " + (Get-Texts $confirm))
                    Invoke-Button $confirm '^Yes'
                    $Proc.WaitForExit(60000) | Out-Null
                    Write-Step ("setup program exited: " + $Proc.HasExited + ", exit code " + $Proc.ExitCode)
                    exit 6
                }
                Stop-Started
                exit 4
            }
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Where should the satellite keep its files') {
            if (-not $Root) { Fail 'the folder page needs -Root' }
            $edit = Find-Control $wizard 'Edit' ''
            Set-Text $edit $Root
            Write-Step "satellite folder set to $Root"
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Which port should the satellite use') {
            $edits = Find-Controls $wizard 'Edit'
            if ($Port) { Set-Text $edits[0] ([string]$Port); Write-Step "port set to $Port" }
            if ($Name) { Set-Text $edits[1] $Name; Write-Step "name set to $Name" }
            if ($ExtraAddress) { Set-Text $edits[2] $ExtraAddress; Write-Step "extra address set to $ExtraAddress" }
            if ($Autostart) {
                $tick = Find-Control $wizard 'CheckBox' 'Start the satellite when Windows starts'
                if (-not $tick) { Fail 'no "Start the satellite when Windows starts" box on the port page' }
                Set-Check $tick ($Autostart -eq 'on')
            }
            Invoke-Button $wizard '^Next'
            if ($HoldPort -and -not $script:HolderPid) { Start-PortHolder $HoldPort }
        } elseif ($page -cmatch 'Make a new certificate for the satellite') {
            if ($ExtraAddress) {
                $edit = Find-Control $wizard 'Edit' ''
                Set-Text $edit $ExtraAddress
                Write-Step "extra address set to $ExtraAddress"
            }
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Give the satellite the secret Vocalis shows') {
            if (-not $secret) { Fail 'the Pair page is shown and no -SecretFile was given' }
            $box = Find-Control $wizard 'PasswordEdit' ''
            if (-not $box) { Fail 'no masked box on the Pair page' }
            Set-Text $box $secret
            Write-Step 'the masked box was filled (the Copy button is never pressed)'
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Ready to Install') {
            Invoke-Button $wizard '^Install'
        } else {
            # Installing, or the Setting up page: log its step title and capture it once.
            if ($page -cmatch 'Setting up the satellite' -and -not $captured.ContainsKey('setup')) {
                Save-Capture $wizard 'wizard-setting-up.png'; $captured['setup'] = $true
            }
            Start-Sleep -Seconds 2
        }
    }
    if (-not $finished -and -not $Proc.HasExited) { Fail 'the wizard did not reach Finish within the time allowed' 124 }
    $Proc.WaitForExit(60000) | Out-Null
    Write-Step "setup program exit code $($Proc.ExitCode)"
    Stop-PortHolder
    if ($failurePage) { exit 5 }
}

function Get-UninstallKey {
    $guid = Get-TestIdentityGuid $TestIdentity
    $key = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.PSChildName -like "{$guid}*" } | Select-Object -First 1
    return @{ Guid = $guid; Key = $key }
}

Write-Step "drive_satellite_installer $Action (test identity $TestIdentity) on desktop session $([System.Diagnostics.Process]::GetCurrentProcess().SessionId)"
# Nothing may open on the desktop the test runs on: the setup program writes what it would have opened to a log instead.
$env:VOCALIS_SATELLITE_TEST_NO_SHELL = '1'

if ($Action -eq 'install') {
    if (-not (Test-Path -LiteralPath $Installer)) { Fail "setup program not found: $Installer" }
    $installerArgs = @(); if ($InnoLog) { $installerArgs += "/LOG=`"$InnoLog`"" }
    $proc = if ($installerArgs.Count) { Start-Process -FilePath $Installer -ArgumentList $installerArgs -PassThru } else { Start-Process -FilePath $Installer -PassThru }
    $Started += $proc.Id
    Write-Step "started setup program pid $($proc.Id)"
    Invoke-Wizard $proc
    exit 0
}

if ($Action -eq 'maintenance') {
    if (@('repair', 'newsecret', 'newcertificate') -notcontains $Mode) { Fail '-Mode must be repair, newsecret or newcertificate' }
    $found = Get-UninstallKey
    if (-not $found.Key) { Fail "the test identity '$TestIdentity' is not installed (no uninstall key $($found.Guid))" }
    $appPath = [string](Get-ItemProperty $found.Key.PSPath).'Inno Setup: App Path'
    $copy = Join-Path $appPath 'Vocalis-Satellite-Setup.exe'
    if (-not (Test-Path -LiteralPath $copy)) { Fail "the installed copy of the setup program is missing: $copy" }
    $modeArgs = @("/MODE=$Mode"); if ($InnoLog) { $modeArgs += "/LOG=`"$InnoLog`"" }
    $proc = Start-Process -FilePath $copy -ArgumentList $modeArgs -PassThru
    $Started += $proc.Id
    Write-Step "started the installed copy with /MODE=$Mode pid $($proc.Id)"
    Invoke-Wizard $proc
    exit 0
}

if ($Action -eq 'uninstall') {
    $found = Get-UninstallKey
    if (-not $found.Key) { Fail "the test identity '$TestIdentity' is not installed (no uninstall key $($found.Guid))" }
    $props = Get-ItemProperty $found.Key.PSPath
    # The Installed apps entry's icon path and Modify command, for the proof that the Vocalis icon and the Modify entry are there.
    Write-Step ("uninstall key: DisplayName '" + $props.DisplayName + "', DisplayIcon '" + $props.DisplayIcon + "', ModifyPath '" + $props.ModifyPath + "', NoModify " + $props.NoModify)
    $command = $props.UninstallString.Trim('"')
    $proc = Start-Process -FilePath $command -PassThru
    $Started += $proc.Id
    Write-Step "started uninstaller pid $($proc.Id)"
    $answeredConfirm = $false
    $deadline = (Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline) {
        $family = Get-Family @($proc.Id)
        $boxes = @(Get-TopWindows $family.Ids | Where-Object { $_.Current.ClassName -eq '#32770' })
        foreach ($box in $boxes) {
            $text = Get-Texts $box
            Write-Step ("message: " + $text)
            if (-not $answeredConfirm -and $text -match 'Are you sure') {
                Invoke-Button $box '^Yes'; $answeredConfirm = $true
            } elseif ($text -match 'was uninstalled|successfully removed') {
                Invoke-Button $box '^OK'
            } else {
                Fail ("unexpected uninstall message: " + $text)
            }
        }
        if ($family.Ids.Count -eq 1 -and $proc.HasExited) { break }
        Start-Sleep -Seconds 1
    }
    Write-Step "uninstaller finished"
    exit 0
}
