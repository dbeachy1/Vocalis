# Drive the Vocalis installer (or its uninstaller) through the real wizard with UI Automation, for tests.
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
#
# Run it ON the shared hidden desktop (packaging/windows/tests/hidden_desktop.py), because UI Automation
# only sees windows on its own desktop. Everything it starts (the installer, the setup console the
# installer opens, the uninstaller) then draws there, and nothing appears on the user's screen.
# Doug, October 9, 2026: "we're going to be testing this quite a bit going forward and we need to make it
# doable" - so this is a kept test tool, not a one-off.
#
# Actions:
#   install    run -Installer through Welcome, License, Prerequisites, Data folder (-DataFolder; skipped when
#              the installer finds an existing instance), Ports (defaults, or -VocalisPort/-TaproomPort),
#              Tasks, Ready, Install; answer the setup console's owner prompts from -Answers with
#              console_keys.py; uncheck "Open Vocalis now" and press Finish. Records the Finish text.
#   uninstall  run the installed uninstaller, confirm, and record its final message.
#
# Every window, dialog and message box the wizard shows is written to -Log as text. A message box the
# script did not expect stops the run with its text, because on a hidden desktop nobody would ever see it.
# The script only ever stops processes it started itself (by PID), never by name.
#
# Exit codes: 0 the wizard completed (the installer's own outcome is in the log: "Setup exit code N");
# 1 the wizard went somewhere unexpected (the log says where); 3 the installer refused before its wizard
# (the message is logged); 124 a step timed out.

param(
    [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall')][string]$Action,
    [string]$Installer,
    [string]$DataFolder,
    [string]$Answers,
    [int]$VocalisPort = 0,
    [int]$TaproomPort = 0,
    [Parameter(Mandatory = $true)][string]$Log,
    # A folder to write a PNG capture of every new wizard page into (final build live check, October 11, 2026: the
    # large and the small wizard picture must be the Vocalis artwork, which only a look at the page can show).
    [string]$CaptureDir,
    # Capture the Welcome page (with -CaptureDir), then Cancel and confirm: installs nothing.
    [switch]$WelcomeOnly,
    # Like -WelcomeOnly for any page (October 11, 2026, the wizard header picture check): when the page text matches this
    # regular expression (case-sensitive; for example the licence page's title), capture it as cancel-at-page.png into
    # -CaptureDir, then Cancel and confirm. Installs nothing.
    [string]$CancelAtPage,
    # With -CancelAtPage: before cancelling, make the wizard window this many pixels wider (and half as many taller) and
    # capture it again as cancel-at-page-wider.png, to see that the header picture keeps its place when the window grows.
    [int]$WidenBy = 0,
    # Passed to the installer as /LOG=<file>: Inno's own log of the run (it holds the header picture's measured numbers).
    [string]$InnoLog,
    # A first install downloads about 62.5 GB of models before the owner prompts appear.
    [int]$SetupTimeoutMinutes = 120
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Inno Setup's own controls (TNewButton, TNewRadioButton, TNewEdit...) reach UI Automation as plain panes with
# no Invoke/Selection/Value pattern (seen October 9, 2026), but each is a real window with a handle. So the
# driver finds controls through UI Automation and acts on them with ordinary window messages, which need
# neither the mouse nor focus. PostMessage for clicks: a click can start long work (the prerequisite checks),
# and the driver must not block on it.
Add-Type -Namespace VocalisTest -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace VocalisTest -Name Cap -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
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

function Fail([string]$Text, [int]$Code = 1) {
    Write-Step "FAILED: $Text"
    # What the wizard was showing, control by control, so the next fix does not need another run.
    foreach ($w in (Get-TopWindows (Get-Family $Started).Ids)) {
        Write-Step ("window: " + $w.Current.ClassName + " '" + $w.Current.Name + "'")
        foreach ($c in $w.FindAll($TreeScope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            $n = $c.Current.Name
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

# Controls are matched by window class (a regex: 'Button' matches Inno's TNewButton and a message box's
# Button) and by name; UI Automation's control type is not reliable for Inno's controls.
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

# A message box (#32770) from the wizard's process family: log its text. Returns the element or $null.
# Inno's own message boxes are owned by the wizard and show up under it in the UI Automation tree, not
# as top-level windows, so both places are searched.
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

# The press has taken effect when the window has visibly moved on: its text changed (the next wizard page),
# the button or its window went away (a message box answered, the wizard finished), or a message box came up
# over it (the page refused, with a reason). Without that, the next look at the window could still see the
# page just answered and press its button twice.
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

# Captures the window to a PNG with PrintWindow (the window paints itself, so the hidden desktop does not matter).
function Save-Capture($Window, [string]$Name) {
    if (-not $CaptureDir) { return }
    New-Item -ItemType Directory -Path $CaptureDir -Force | Out-Null
    $path = Join-Path $CaptureDir $Name
    $h = [IntPtr]$Window.Current.NativeWindowHandle
    $rect = New-Object VocalisTest.Cap+RECT
    [void][VocalisTest.Cap]::GetWindowRect($h, [ref]$rect)
    $w = $rect.Right - $rect.Left; $ht = $rect.Bottom - $rect.Top
    # Flag 0: the window paints itself into the bitmap (WM_PRINT). Flag 2 (PW_RENDERFULLCONTENT) reads the compositor's
    # last frame instead, and a hidden desktop has no reliable one: on October 11, 2026 it returned the Welcome page with
    # a blank white panel where the large picture is, at random (7 of 18 captures over six runs), while flag 0 taken in
    # the same instant showed the picture every time (15 of 15). That false "blank picture" was first reported as a defect.
    $bmp = New-Object System.Drawing.Bitmap($w, $ht)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [VocalisTest.Cap]::PrintWindow($h, $hdc, 0)
    $g.ReleaseHdc($hdc); $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    # Where the window's client area starts inside the picture and how big it is, so a measuring script can tell the wizard's
    # own pixels from the frame (the header picture check, October 11, 2026).
    $client = New-Object VocalisTest.Cap+RECT
    [void][VocalisTest.Cap]::GetClientRect($h, [ref]$client)
    $origin = New-Object VocalisTest.Cap+POINT
    [void][VocalisTest.Cap]::ClientToScreen($h, [ref]$origin)
    Write-Step ("capture " + $path + " " + $w + "x" + $ht + " PrintWindow=" + $ok + " client=" + ($origin.X - $rect.Left) + "," + ($origin.Y - $rect.Top) + "," + $client.Right + "," + $client.Bottom)
}

# -WelcomeOnly: the Welcome page has been captured; press Cancel, confirm, and end the run. Installs nothing.
function Exit-AtWelcome($Wizard, $Process) {
    Invoke-Button $Wizard '^Cancel'
    $confirm = Wait-Until { Get-MessageBox @($Process.Id) } 30 'the Exit Setup question'
    Write-Step ("cancel question: " + (Get-Texts $confirm))
    Invoke-Button $confirm '^Yes'
    $Process.WaitForExit(60000) | Out-Null
    Write-Step ("installer exited: " + $Process.HasExited + ", exit code " + $Process.ExitCode)
    exit 0
}

function Get-PageTitle($Wizard) {
    # The page caption is the first bold label in the top panel; its text is enough to tell pages apart.
    return (Get-Texts $Wizard)
}

# A console handed to Windows Terminal becomes a new tab in the Terminal already running on the visible
# desktop, hosted by a new OpenConsole.exe process, so new OpenConsole processes are the sign to look for.
function Assert-NoTerminalPopup([datetime]$Since) {
    $new = @(Get-Process WindowsTerminal, OpenConsole -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt $Since })
    if ($new.Count) { Write-Step ("WARNING: " + $new[0].Name + " pid " + $new[0].Id + " started during the run; a console may have opened on the visible desktop") }
}

$RunStart = Get-Date
Write-Step "drive_installer $Action on desktop session $([System.Diagnostics.Process]::GetCurrentProcess().SessionId)"

if ($Action -eq 'install') {
    if (-not (Test-Path -LiteralPath $Installer)) { Fail "installer not found: $Installer" }
    # The installer opens its setup console under the classic console host when this is set, so the console
    # stays on this hidden desktop instead of being handed to Windows Terminal on the visible one.
    $env:VOCALIS_INSTALLER_CONSOLE_HOST = 'conhost'
    $env:VOCALIS_INSTALLER_TEST_NO_BROWSER = '1'
    $installerArgs = @(); if ($InnoLog) { $installerArgs += "/LOG=`"$InnoLog`"" }
    $proc = if ($installerArgs.Count) { Start-Process -FilePath $Installer -ArgumentList $installerArgs -PassThru } else { Start-Process -FilePath $Installer -PassThru }
    $Started += $proc.Id
    Write-Step "started installer pid $($proc.Id)"
    # The installer can answer before any wizard exists (InitializeSetup's refusal to roll a newer
    # install back, design amendment 2): such a message is the run's outcome, logged and closed, and
    # the script exits 3 so a test can tell "refused" from "failed".
    $deadline0 = (Get-Date).AddSeconds(60)
    $wizard = $null
    while (-not $wizard -and (Get-Date) -lt $deadline0) {
        $early = Get-MessageBox @($proc.Id)
        if ($early) {
            Write-Step ("installer message before the wizard: " + (Get-Texts $early))
            Invoke-Button $early '^OK'
            $proc.WaitForExit(30000) | Out-Null
            Write-Step "installer exit code $($proc.ExitCode)"
            exit 3
        }
        $wizard = Get-WizardWindow @($proc.Id)
        if (-not $wizard) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $wizard) { Fail 'timed out after 60 s waiting for the wizard window' 124 }
    Write-Step ("wizard: " + $wizard.Current.Name)

    $seenSetupConsole = $false
    $finished = $false
    $deadline = (Get-Date).AddMinutes($SetupTimeoutMinutes + 30)
    $lastPage = ''
    $captureSeq = 0
    while (-not $finished -and (Get-Date) -lt $deadline) {
        $box = Get-MessageBox @($proc.Id)
        if ($box) {
            $boxText = Get-Texts $box
            # The ports page offers the next free pair when a port is busy (design amendment 4).
            if ($boxText -cmatch 'cannot be used on Windows' -and $boxText -cmatch 'instead\?') {
                Write-Step ("ports busy, accepting the suggested pair: " + $boxText)
                Invoke-Button $box '^Yes'
                continue
            }
            Fail ("unexpected message box: " + $boxText)
        }
        $wizard = Get-WizardWindow @($proc.Id)
        if (-not $wizard) {
            if ($proc.HasExited) { Write-Step "installer exited with code $($proc.ExitCode)"; break }
            Start-Sleep -Seconds 1; continue
        }
        $page = Get-PageTitle $wizard
        if ($page -ne $lastPage) {
            Write-Step ("page: " + $page.Substring(0, [Math]::Min(600, $page.Length))); $lastPage = $page
            if ($CaptureDir -and $captureSeq -lt 14) {
                $captureSeq++
                $tag = (($page -replace '[^A-Za-z0-9]+', '-').Trim('-'))
                if ($tag.Length -gt 28) { $tag = $tag.Substring(0, 28) }
                Save-Capture $wizard ('{0:D2}-{1}.png' -f $captureSeq, $tag)
            }
        }

        if ($CancelAtPage -and $page -cmatch $CancelAtPage) {
            Write-Step "page matches -CancelAtPage '$CancelAtPage': capturing it and cancelling"
            Save-Capture $wizard 'cancel-at-page.png'
            if ($WidenBy -gt 0) {
                $hw = [IntPtr]$wizard.Current.NativeWindowHandle
                $r = New-Object VocalisTest.Cap+RECT
                [void][VocalisTest.Cap]::GetWindowRect($hw, [ref]$r)
                $moved = [VocalisTest.Cap]::MoveWindow($hw, $r.Left, $r.Top, ($r.Right - $r.Left) + $WidenBy, ($r.Bottom - $r.Top) + [int]($WidenBy / 2), $true)
                Start-Sleep -Milliseconds 700
                $r2 = New-Object VocalisTest.Cap+RECT
                [void][VocalisTest.Cap]::GetWindowRect($hw, [ref]$r2)
                Write-Step ("widened by " + $WidenBy + ": MoveWindow=" + $moved + ", window now " + ($r2.Right - $r2.Left) + "x" + ($r2.Bottom - $r2.Top))
                Save-Capture $wizard 'cancel-at-page-wider.png'
            }
            Exit-AtWelcome $wizard $proc
        }

        # Most specific first, case-sensitive: some phrases ("data folder") appear on several pages.
        $finishButton = Find-Control $wizard 'Button' '^Finish'
        if ($finishButton) {
            # "Open Vocalis now" lives in a check list Inno draws itself, which window messages cannot untick
            # reliably; VOCALIS_INSTALLER_TEST_NO_BROWSER (set below) makes the installer skip it, because a
            # browser opened from here would appear on the visible desktop.
            Write-Step ("finish page: " + $page)
            Invoke-Button $wizard '^Finish'
            $finished = $true
        } elseif ($page -cmatch 'Setup did not finish') {
            Write-Step ("setup-failed page: " + $page)
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Welcome to the Vocalis Setup Wizard') {
            # The Welcome page (DisableWelcomePage=no in vocalis.iss, October 11, 2026): the wizard's
            # first page, with the Vocalis picture on its left. Inno's own default text; only Next is pressed.
            if ($WelcomeOnly) { Exit-AtWelcome $wizard $proc }
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Ready to Install') {
            Invoke-Button $wizard '^Install'
        } elseif ($page -cmatch 'License Agreement') {
            $accept = Find-Control $wizard 'RadioButton' '^I accept'
            if (-not $accept) { Fail 'no "I accept" choice on the licence page' }
            Select-Choice $accept
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Prerequisites') {
            $status = Wait-Until {
                $t = Get-Texts (Get-WizardWindow @($proc.Id))
                if ($t -cmatch 'All checks passed' -or $t -cmatch 'A check failed') { $t }
            } 900 'the prerequisite checks'
            if ($status -cmatch 'A check failed') { Fail ("prerequisites failed: " + $status) }
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Where should Vocalis keep its data') {
            $edit = Find-Control $wizard 'Edit' ''
            if ($DataFolder) {
                Set-Text $edit $DataFolder
                Write-Step "data folder set to $DataFolder"
            } else {
                # No folder given: keep what the installer offers (after an uninstall, the remembered one).
                Write-Step ("data folder left as offered: " + $edit.Current.Name + " / " + (Get-Texts $wizard | Select-String -Pattern '[A-Z]:\[^|]*' -AllMatches | ForEach-Object { $_.Matches.Value } | Select-Object -First 1))
            }
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Which local ports') {
            if ($VocalisPort -or $TaproomPort) {
                $edits = Find-Controls $wizard 'Edit'
                if ($VocalisPort) { Set-Text $edits[0] ([string]$VocalisPort) }
                if ($TaproomPort) { Set-Text $edits[1] ([string]$TaproomPort) }
            }
            Invoke-Button $wizard '^Next'
        } elseif ($page -cmatch 'Select Additional Tasks') {
            Invoke-Button $wizard '^Next'
        } else {
            # Installing: watch for the setup console and answer its owner prompts once.
            if (-not $seenSetupConsole) {
                $family = Get-Family @($proc.Id)
                $console = $family.Procs | Where-Object { $family.Ids -contains [int]$_.ProcessId -and $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'vocalis-control\.ps1' -and $_.CommandLine -match 'repair' } | Select-Object -First 1
                if ($console) {
                    $seenSetupConsole = $true
                    Write-Step "setup console pid $($console.ProcessId)"
                    if ($Answers) {
                        $err = Join-Path (Split-Path -Parent $Log) 'console-keys.err.txt'
                        $keys = Start-Process -FilePath 'python.exe' -ArgumentList @('-I', "`"$Here\console_keys.py`"", '--pid', $console.ProcessId, '--answers', "`"$Answers`"", '--timeout', ($SetupTimeoutMinutes * 60)) -NoNewWindow -RedirectStandardError $err -PassThru
                        $Started += $keys.Id
                        Write-Step "owner-prompt helper pid $($keys.Id) waiting for the prompts"
                    }
                }
            }
            Start-Sleep -Seconds 2
        }
    }
    if (-not $finished -and -not $proc.HasExited) { Fail "the wizard did not reach Finish within the time allowed" 124 }
    if ($keys -and -not $keys.HasExited) { $keys.Kill(); Write-Step "stopped the owner-prompt helper pid $($keys.Id) (it was still waiting)" }
    if ($keys) { Get-Content -LiteralPath (Join-Path (Split-Path -Parent $Log) 'console-keys.err.txt') -ErrorAction SilentlyContinue | ForEach-Object { Write-Step "owner prompts: $_" } }
    $proc.WaitForExit(60000) | Out-Null
    Write-Step "installer exit code $($proc.ExitCode)"
    Assert-NoTerminalPopup $RunStart
    exit 0
}

if ($Action -eq 'uninstall') {
    $key = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.PSChildName -like '{BA5A7A32-DF39-4E07-AA26-73BD3AA65681}*' } | Select-Object -First 1
    if (-not $key) { Fail 'Vocalis is not installed (no uninstall key)' }
    $command = (Get-ItemProperty $key.PSPath).UninstallString.Trim('"')
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
    Assert-NoTerminalPopup $RunStart
    exit 0
}
