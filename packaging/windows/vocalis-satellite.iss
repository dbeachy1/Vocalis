; Vocalis Satellite setup program (Inno Setup 6.7.3, the pinned Tools.InnoSetup package), added October 11, 2026.
; This is a per-user front end to packaging/satellite/satellite-setup.ps1, exactly as
; vocalis.iss is a front end to setup.ps1: every decision about the folder, the addresses, the certificate, the image,
; the model and the container stays in the script. The wizard collects the folder, port, name, optional extra address,
; the start-with-Windows choice and the pairing secret, runs the script once and hidden (-NoPrompt) after the copy,
; and builds its last page from the script's setup-result.txt. It installs the tray program
; (VocalisSatelliteTray.exe) and starts it at sign-in through a per-user Run entry. The setup program carries one image
; REFERENCE and no image bytes; nothing here pushes or publishes anything (repository policy).
;
; build-satellite-installer.ps1 supplies everything that varies through environment variables:
;   VOCALIS_SATELLITE_VERSION                 the full version, for example 12.0.0-M1 (AppVersion and file name)
;   VOCALIS_SATELLITE_VERSION_INFO            12.0.0.0 (VersionInfoVersion)
;   VOCALIS_SATELLITE_IMAGE                   name@sha256:<64 hex>, baked into the setup program
;   VOCALIS_SATELLITE_TRAY_EXE                the tray program to package (a signed copy in a release build)
;   VOCALIS_SATELLITE_TEST_IDENTITY           empty for the real program; a word for a test build (see below)
;   VOCALIS_SATELLITE_TEST_GUID               the AppId of a test build (derived from the word by the build script)
;   VOCALIS_SATELLITE_SIGNED_BUILD            "1" for a release build: SignTool=azurecodesign and a signed uninstaller
;   VOCALIS_SATELLITE_SIGNED_UNINSTALLER_DIR  where Inno keeps the signed uninstaller (signed builds only)
;
; A separate identity for tests (design: "A separate identity for tests"). With VOCALIS_SATELLITE_TEST_IDENTITY set,
; every name this program shares with a real install is different: the AppId (and so the uninstall key), the
; application name shown in Installed apps, the program folder, the Run value, the setup mutex, the Start menu group,
; the default satellite folder and the output file name. Without it a test install on a computer that has the real
; program (the owner's, once he has run the setup program over his own satellite) would be an upgrade of his install, and
; its uninstall test would remove his container, close his icon and delete his Run entry. The tray program derives its
; own mutex and event names from the folder it runs from, so a test install in its own folder never collides either.
;
; Test seam shared with the tray program: when the environment variable VOCALIS_SATELLITE_TEST_NO_SHELL is 1 the wizard
; opens no Explorer or Notepad window; it appends one line describing what it would have done to
; {app}\test-shell-actions.log. The tray icon is still started (see StartTrayIcon for why that is safe in a test).

; The permanent AppId of the real program. Never change it: it is the uninstall key that upgrades and repairs find. It
; differs from the main Vocalis installer's, so Vocalis and a satellite can both be installed on one computer.
#define RealAppGuid "DEA56953-B5EE-4D67-9CDD-19506AE58EEC"
#define TestIdentity GetEnv("VOCALIS_SATELLITE_TEST_IDENTITY")
#if TestIdentity == ""
  #define AppGuid RealAppGuid
  #define AppName "Vocalis Satellite"
  #define ProgramFolder "VocalisSatellite"
  #define RunValueName "Vocalis Satellite"
  #define MutexName "VocalisSatelliteSetupMutex"
  #define GroupName "Vocalis Satellite"
  #define SatelliteFolder "VocalisDocker\satellite"
  #define OutputSuffix ""
#else
  #define AppGuid GetEnv("VOCALIS_SATELLITE_TEST_GUID")
  #define AppName "Vocalis Satellite (test " + TestIdentity + ")"
  #define ProgramFolder "VocalisSatellite-test-" + TestIdentity
  #define RunValueName "Vocalis Satellite test " + TestIdentity
  #define MutexName "VocalisSatelliteSetupMutex-test-" + TestIdentity
  #define GroupName "Vocalis Satellite (test " + TestIdentity + ")"
  #define SatelliteFolder "VocalisDocker\satellite-test-" + TestIdentity
  #define OutputSuffix "-test-" + TestIdentity
#endif
#define AppVersion GetEnv("VOCALIS_SATELLITE_VERSION")
#define VersionInfo GetEnv("VOCALIS_SATELLITE_VERSION_INFO")
#define SatelliteImage GetEnv("VOCALIS_SATELLITE_IMAGE")
#define TrayExe GetEnv("VOCALIS_SATELLITE_TRAY_EXE")
#if GetEnv("VOCALIS_SATELLITE_SIGNED_BUILD") == "1"
  #define SignedUninstallerDir GetEnv("VOCALIS_SATELLITE_SIGNED_UNINSTALLER_DIR")
#endif

#if AppVersion == ""
  #error "VOCALIS_SATELLITE_VERSION must come from build-satellite-installer.ps1 (VERSION in source/vocalis/src/tts_utils.py)."
#endif
#if VersionInfo == ""
  #error "VOCALIS_SATELLITE_VERSION_INFO must come from build-satellite-installer.ps1."
#endif
#if SatelliteImage == ""
  #error "VOCALIS_SATELLITE_IMAGE must come from build-satellite-installer.ps1."
#endif
#if TrayExe == ""
  #error "VOCALIS_SATELLITE_TRAY_EXE must come from build-satellite-installer.ps1 (the built tray program)."
#endif
#if TestIdentity != "" && AppGuid == ""
  #error "VOCALIS_SATELLITE_TEST_GUID must come from build-satellite-installer.ps1 when a test identity is set."
#endif

[Setup]
AppId={{{#AppGuid}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Douglas Beachy
VersionInfoVersion={#VersionInfo}
VersionInfoProductName={#AppName}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
DefaultDirName={localappdata}\Programs\{#ProgramFolder}
DefaultGroupName={#GroupName}
DisableProgramGroupPage=yes
DisableDirPage=yes
; Inno Setup leaves the Welcome page out unless told otherwise (its default is yes; the feasibility probe of October 11,
; 2026, built with this compiler and without this line, opened on its first custom page). The design's first page is the
; Welcome page with its two sentences (what a satellite is, and that it is optional), so it is turned on here; a
; maintenance mode skips it (ShouldSkipPage).
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputBaseFilename=Vocalis-Satellite-Setup-{#AppVersion}-x64{#OutputSuffix}
LicenseFile=..\..\LICENSE
; The Vocalis icon (packaging/windows/vocalis.ico) is the icon of the setup program, of the wizard (SetupIconFile)
; and of the uninstaller, which Inno builds from the same icon. Doug, October 11, 2026: "Don't forget to use the
; correct icon in the setup and the system tray."
SetupIconFile=vocalis.ico
UninstallDisplayIcon={app}\vocalis.ico
; The wizard's own pictures are the Vocalis V too, so no Inno stock picture is left anywhere in the wizard (final code
; review, October 11, 2026). make_icon.py draws them: the square picture of the inner pages' corner at the seven sizes of
; the small image area at 100% through 250% display scaling, and the tall Welcome and Finish picture at the seven sizes of
; its area (Inno Setup 6.7.3 help, WizardSmallImageFile and WizardImageFile). Setup picks the file that best matches.
WizardSmallImageFile=vocalis-wizard-small-58.png,vocalis-wizard-small-77.png,vocalis-wizard-small-97.png,vocalis-wizard-small-116.png,vocalis-wizard-small-124.png,vocalis-wizard-small-143.png,vocalis-wizard-small-159.png
WizardImageFile=vocalis-wizard-large-202x386.png,vocalis-wizard-large-269x515.png,vocalis-wizard-large-336x643.png,vocalis-wizard-large-403x772.png,vocalis-wizard-large-430x824.png,vocalis-wizard-large-498x953.png,vocalis-wizard-large-534x1022.png
; Two setup programs never run at once (this includes the installed copy started in a maintenance mode).
SetupMutex={#MutexName}
WizardStyle=modern
; A maintenance run (/MODE=repair, newsecret, newcertificate) installs nothing, yet it rewrote unins000.exe and grew
; unins000.dat by about 104 KB each time (live test, October 11, 2026): the [UninstallDelete] entries and the program
; folder are logged by every run, and appending to the log rewrites the uninstaller. Inno Setup 6.7.3 help,
; Uninstallable: a scripted boolean expression, evaluated at run time, decides whether "uninstallation support is
; included" in this run. False in a maintenance mode, this run writes no uninstaller, no log entries and no uninstall
; key. The help does not say in words what happens to an EXISTING uninstaller; it says only that none is included in
; the run, and it gives no step that deletes one. Confirmed on a real install the same day (design, "Re-check of those
; fixes"): after two repairs and a new certificate unins000.exe and unins000.dat were byte-identical to what the install
; wrote, and the uninstall afterwards removed everything it removes after none. SetModifyEntry still sets ModifyPath
; and NoModify=0 in the existing key in every mode.
Uninstallable=FullInstall
; The tray program is closed by its own --exit command (PrepareToInstall, and first in the uninstaller), not by
; Restart Manager.
CloseApplications=no
SetupLogging=yes
Compression=lzma2
SolidCompression=yes
#if GetEnv("VOCALIS_SATELLITE_SIGNED_BUILD") == "1"
SignTool=azurecodesign
SignedUninstaller=yes
SignedUninstallerDir={#SignedUninstallerDir}
#endif

[Files]
; Extracted to {tmp} at wizard time (ExtractTemporaryFile) and never installed: the prerequisite, address and port
; checks run satellite-setup.ps1 from there before anything is copied, and the version comparison runs
; vocalis-control.ps1 (not edited here: one implementation of the version order) from there. vocalis-control.ps1
; dot-sources windows-compose.ps1 from its own folder, so that is extracted beside it. Listed first because the
; setup program is solid-compressed.
Source: "..\satellite\satellite-setup.ps1"; Flags: dontcopy noencryption
Source: "vocalis-control.ps1"; Flags: dontcopy noencryption
Source: "..\windows-compose.ps1"; Flags: dontcopy noencryption
; Installed. Every installed entry, shortcut and registry entry carries Check: FullInstall: in a maintenance mode
; (/MODE=repair, /MODE=newsecret, /MODE=newcertificate, run from the installed copy) Inno cannot skip its install
; step, so nothing is copied, no running file is overwritten and the tray icon is left running.
Source: "..\satellite\satellite-setup.ps1"; DestDir: "{app}"; Flags: ignoreversion; Check: FullInstall
Source: "{#TrayExe}"; DestDir: "{app}"; DestName: "VocalisSatelliteTray.exe"; Flags: ignoreversion; Check: FullInstall
; What the tray icon's "Tail the satellite log" item runs in its own console window (October 11, 2026). It is a plain
; script that only reads the satellite's log file, so it is not signed with the programs; Inno removes it at uninstall
; with every other installed file (it is not one of the generated files [UninstallDelete] names).
Source: "satellite-log-tail.ps1"; DestDir: "{app}"; Flags: ignoreversion; Check: FullInstall
; A copy of this setup program, for the maintenance modes and the Modify entry. Any Zone.Identifier stream is removed
; from the copy afterwards (RemoveZoneIdentifier) so Windows does not warn at each use.
Source: "{srcexe}"; DestDir: "{app}"; DestName: "Vocalis-Satellite-Setup.exe"; Flags: external ignoreversion; Check: FullInstall
Source: "..\satellite\README.md"; DestDir: "{app}"; DestName: "Vocalis-Satellite-Guide.md"; Flags: ignoreversion; Check: FullInstall
; The repository LICENSE is the only licence file installed (the image carries its own notices).
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion; Check: FullInstall
; The Vocalis icon and the tray icon's two other looks (grey, and grey with a small mark), all from make_icon.py.
Source: "vocalis.ico"; DestDir: "{app}"; Flags: ignoreversion; Check: FullInstall
Source: "vocalis-satellite-stopped.ico"; DestDir: "{app}"; Flags: ignoreversion; Check: FullInstall
Source: "vocalis-satellite-nodocker.ico"; DestDir: "{app}"; Flags: ignoreversion; Check: FullInstall

[Icons]
; Every shortcut names the Vocalis icon file. The group has nothing on the desktop. Start and Stop are in the tray
; icon's menu only (a second pair here would need another script for the same two commands).
Name: "{group}\Vocalis Satellite"; Filename: "{app}\VocalisSatelliteTray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "Show the Vocalis Satellite icon in the notification area"; Check: FullInstall
Name: "{group}\Repair satellite"; Filename: "{app}\Vocalis-Satellite-Setup.exe"; Parameters: "/MODE=repair"; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "Rerun setup for this satellite; finished downloads are kept"; Check: FullInstall
Name: "{group}\Change secret"; Filename: "{app}\Vocalis-Satellite-Setup.exe"; Parameters: "/MODE=newsecret"; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "Give the satellite the new secret Vocalis shows"; Check: FullInstall
Name: "{group}\New certificate"; Filename: "{app}\Vocalis-Satellite-Setup.exe"; Parameters: "/MODE=newcertificate"; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "Make a new certificate for the satellite"; Check: FullInstall
Name: "{group}\Satellite guide"; Filename: "{win}\notepad.exe"; Parameters: """{app}\Vocalis-Satellite-Guide.md"""; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "The satellite guide (a .md file has no program of its own on Windows)"; Check: FullInstall
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"; IconFilename: "{app}\vocalis.ico"; Comment: "Uninstall Vocalis Satellite (the satellite folder and the image are kept)"; Check: FullInstall

[Registry]
; The icon starts when the user signs in, always. This is separate from whether the satellite starts: Doug wants the
; icon every time and the satellite only when he says so (the tick box on the Port, name and starting page, and the
; icon's own menu item). --signin lets the icon start the satellite once for that sign-in when the recorded setting is on.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#RunValueName}"; ValueData: """{app}\VocalisSatelliteTray.exe"" --signin"; Flags: uninsdeletevalue; Check: FullInstall

[UninstallDelete]
; The files [Code] and the tray program write into {app} (the state file, a leftover pairing secret, the test seam's
; log, the tray program's own log and its one rotated copy) are generated, not installed, so Inno does not know them
; and the folder would stay. Each is named, and the folder goes only when it is then empty, as in vocalis.iss. It is
; never "filesandordirs" on {app} (October 11, 2026): Inno honors /DIR= on the command line even with
; the folder page off, and a setup program started with /DIR pointing at a folder the user keeps other things in would
; delete all of it at uninstall. The satellite folder and the image are never touched.
Type: files; Name: "{app}\satellite-installer-state.txt"
Type: files; Name: "{app}\pairing-secret.tmp"
Type: files; Name: "{app}\test-shell-actions.log"
Type: files; Name: "{app}\satellite-tray.log"
Type: files; Name: "{app}\satellite-tray.log.1"
Type: dirifempty; Name: "{app}"

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppGuid}}_is1';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  RunValueName = '{#RunValueName}';
  DockerDesktopRunValue = 'Docker Desktop';
  DotNetKey = 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full';
  // .NET Framework 4.8 (the tray program targets it; every supported Windows has it, but the check is cheap).
  MinimumDotNetRelease = 528040;
  DefaultPortText = '7880';
  // The model files need about 3.2 GB in the satellite folder; the 0.3 GB is margin. The image needs about 10 GB in
  // Docker's own disk (shown, not measured: it lives wherever Docker Desktop keeps it).
  MinimumFolderBytes = 3500000000;
  BakedImage = '{#SatelliteImage}';
  AppVersionText = '{#AppVersion}';
  StateFileName = 'satellite-installer-state.txt';
  SecretFileName = 'pairing-secret.tmp';
  TrayExeName = 'VocalisSatelliteTray.exe';
  SetupCopyName = 'Vocalis-Satellite-Setup.exe';
  ShellLogName = 'test-shell-actions.log';
  Nl = #13#10;

var
  PrereqPage: TWizardPage;
  PrereqNote: TNewStaticText;
  PrereqDockerNote: TNewStaticText;
  PrereqMemo: TNewMemo;
  PrereqStatus: TNewStaticText;
  PrereqRetry: TNewButton;
  PrereqPassed: Boolean;
  FolderPage: TInputDirWizardPage;
  PortPage: TInputQueryWizardPage;
  PortAddressNote: TNewStaticText;
  AutostartCheck: TNewCheckBox;
  CertPage: TInputQueryWizardPage;
  CertAddressMemo: TNewMemo;
  PairPage: TWizardPage;
  PairIntro: TNewStaticText;
  PairAddressMemo: TNewMemo;
  PairCopy: TNewButton;
  PairPrompt: TNewStaticText;
  PairSecret: TPasswordEdit;
  PairHint: TNewStaticText;
  RunPage: TOutputMarqueeProgressWizardPage;
  FinCertLabel: TNewStaticText;
  FinCertEdit: TNewEdit;
  FinShowFile: TNewButton;
  FinCopyPath: TNewButton;
  FinOpenLog: TNewButton;
  FinPrintLabel: TNewStaticText;
  FinPrintEdit: TNewEdit;
  FinMemo: TNewMemo;

  // How this run was started: '' for the normal wizard, or repair, newsecret, newcertificate (from the installed copy).
  RunMode: String;
  // The program is registered (the uninstall key exists), and where, and which version.
  InstalledHere: Boolean;
  InstalledApp: String;
  InstalledVersionText: String;
  // The installer state file of that install (satellite-installer-state.txt): what the wizard collected earlier.
  StateRoot, StateImage, StatePort, StateName, StateAddress, StateAutostart: String;
  // What this run uses: from the pages, or from the state file on an upgrade or a repair.
  ChosenRoot, ChosenPort, ChosenName, ChosenAddress, ChosenAutostart: String;
  // The chosen folder already holds a satellite (the folder page offered "use this satellite").
  UseExistingFolder: Boolean;
  // satellite-setup.ps1 -ShowPlan, the one reader of satellite.env (design: plumbing modes).
  PlanSatellite, PlanName, PlanPort, PlanAutostart, PlanImage, PlanAddresses, PlanNeedsSecret, PlanNeedsCertificate: String;
  PlanSetupFinished, PlanCertificateFile, PlanFingerprint, PlanError: String;
  // Output of the last captured script run.
  CapLines: TArrayOfString;
  CapCount: Integer;
  // The last few non-empty output lines of the setup run, for the "did not finish" page when no reason was recorded.
  TailLines: TArrayOfString;
  ScriptExtracted: Boolean;
  ComposeHelperExtracted: Boolean;
  // The pairing secret, in memory only between the Pair page and the end of the script run.
  SecretValue: String;
  // The open handle that keeps the secret file from being deleted under a running script (HoldFileAgainstDeletion).
  SecretHold: TFileStream;
  // The run of the script.
  SetupRan: Boolean;
  SetupExitCode: Integer;
  SetupRunning: Boolean;
  ResultFileRead: Boolean;
  ResVocalisSteps, ResCertificateFile, ResFingerprint, ResFailure, ResLogFile, ResRunning: String;
  ResultNote: String;
  UninstallMessage: String;

function GetDriveType(lpRootPathName: String): Cardinal;
  external 'GetDriveTypeW@kernel32.dll stdcall';

function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

// The copy buttons select a box's text and send it the standard copy message, since Inno has no clipboard function.
function NativeSendMessage(hWnd: Longint; Msg: Cardinal; wParam: Longint; lParam: Longint): Longint;
  external 'SendMessageW@user32.dll stdcall';

// Defined with the Finish page code further down; the page events and the wizard start-up above it call them.
procedure CreateFinishControls; forward;
procedure ShowFinishPage; forward;
procedure SetModifyEntry; forward;

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function Q(const Text: String): String;
begin
  Result := '"' + Text + '"';
end;

// The mode check on every installed entry: false in a maintenance mode.
function FullInstall: Boolean;
begin
  Result := RunMode = '';
end;

function DefaultSatelliteFolder: String;
begin
  Result := ExpandConstant('{localappdata}\{#SatelliteFolder}');
end;

function OnOff(const Value: Boolean): String;
begin
  if Value then Result := 'on' else Result := 'off';
end;

function GigabytesText(Bytes: Int64): String;
begin
  Result := IntToStr(Bytes div 1000000000) + ' GB';
end;

function FreeSpaceText(const Path: String): String;
var
  Free, Total: Int64;
begin
  if GetSpaceOnDisk64(ExtractFileDrive(Path) + '\', Free, Total) then
    Result := GigabytesText(Free) + ' free on ' + ExtractFileDrive(Path)
  else
    Result := 'the free space on ' + ExtractFileDrive(Path) + ' could not be read';
end;

function HasLineBreak(const Text: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to Length(Text) do
    if (Text[I] = #10) or (Text[I] = #13) then Result := True;
end;

// StringChangeEx changes its argument in place; this returns the changed copy.
function ReplaceAll(const Text, FromText, ToText: String): String;
var
  Work: String;
begin
  Work := Text;
  StringChangeEx(Work, FromText, ToText, True);
  Result := Work;
end;

function JoinLines(const Lines: TArrayOfString; const Count: Integer): String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to Count - 1 do
  begin
    if I > 0 then Result := Result + Nl;
    Result := Result + Lines[I];
  end;
end;

// Text in UTF-8 form (the script and the tray program write and read UTF-8 without a byte-order mark) into lines.
function SplitLines(const Text: String): TArrayOfString;
var
  Rest, Line: String;
  P, N: Integer;
begin
  SetArrayLength(Result, 0);
  N := 0;
  Rest := Text;
  while Length(Rest) > 0 do
  begin
    P := Pos(#10, Rest);
    if P = 0 then
    begin
      Line := Rest;
      Rest := '';
    end
    else
    begin
      Line := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end;
    if (Length(Line) > 0) and (Line[Length(Line)] = #13) then Line := Copy(Line, 1, Length(Line) - 1);
    SetArrayLength(Result, N + 1);
    Result[N] := Line;
    N := N + 1;
  end;
end;

// The value of Key in a KEY=VALUE file written as UTF-8 (satellite-installer-state.txt, setup-result.txt); '' when the
// file or the key is missing. The first match wins.
function FileValue(const FileName, Key: String): String;
var
  Raw: AnsiString;
  Lines: TArrayOfString;
  I, P: Integer;
begin
  Result := '';
  if not LoadStringFromFile(FileName, Raw) then Exit;
  Lines := SplitLines(Utf8Decode(Raw));
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    P := Pos('=', Lines[I]);
    if (P > 1) and (Copy(Lines[I], 1, P - 1) = Key) then
    begin
      Result := Trim(Copy(Lines[I], P + 1, Length(Lines[I])));
      Exit;
    end;
  end;
end;

// ---- the script runs: output captured line by line (UTF-8 arrives correctly: the script sets that encoding itself) ----

procedure OnCaptureLine(const S: String; const Error, FirstLine: Boolean);
begin
  if Error then
  begin
    Log('Output capture error: ' + S);
    Exit;
  end;
  SetArrayLength(CapLines, CapCount + 1);
  CapLines[CapCount] := S;
  CapCount := CapCount + 1;
end;

// First line of the captured output that is KEY=VALUE for this key; '' when none.
function CapturedValue(const Key: String): String;
var
  I: Integer;
  Prefix: String;
begin
  Result := '';
  Prefix := Key + '=';
  for I := 0 to CapCount - 1 do
    if Copy(CapLines[I], 1, Length(Prefix)) = Prefix then
    begin
      Result := Trim(Copy(CapLines[I], Length(Prefix) + 1, Length(CapLines[I])));
      Exit;
    end;
end;

// The script's reason: its first ERROR: line, else the last non-empty line.
function CapturedReason: String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to CapCount - 1 do
    if Copy(Trim(CapLines[I]), 1, 6) = 'ERROR:' then
    begin
      Result := Trim(Copy(Trim(CapLines[I]), 7, Length(CapLines[I])));
      Exit;
    end;
  for I := 0 to CapCount - 1 do
    if Trim(CapLines[I]) <> '' then Result := Trim(CapLines[I]);
end;

procedure EnsureScripts;
begin
  if not ScriptExtracted then
  begin
    ExtractTemporaryFile('satellite-setup.ps1');
    ScriptExtracted := True;
  end;
end;

// vocalis-control.ps1 dot-sources windows-compose.ps1 from its own folder, so the helper is extracted beside it.
procedure EnsureComposeHelper;
begin
  if not ComposeHelperExtracted then
  begin
    ExtractTemporaryFile('windows-compose.ps1');
    ComposeHelperExtracted := True;
  end;
end;

// Runs satellite-setup.ps1 from {tmp}, hidden, and keeps its output in CapLines. ExecAndLogOutput keeps the wizard
// repainting while it waits (checked October 11, 2026 on the hidden desktop), and each check inside the script is
// bounded by the script itself. The arguments are logged and never hold the secret (it is only ever in a file).
// Returns False when the script could not be started.
function RunScriptCaptured(const Arguments: String; var ExitCode: Integer): Boolean;
var
  Started: Cardinal;
begin
  Result := False;
  ExitCode := -1;
  SetArrayLength(CapLines, 0);
  CapCount := 0;
  EnsureScripts;
  Started := GetTickCount;
  try
    Result := ExecAndLogOutput(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File ' + Q(ExpandConstant('{tmp}') + '\satellite-setup.ps1') + ' ' + Arguments,
      ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode, @OnCaptureLine);
  except
    Log('Could not run satellite-setup.ps1 ' + Arguments + ': ' + GetExceptionMessage);
    Result := False;
  end;
  Log(Format('satellite-setup.ps1 %s: started %d, exit code %d, %d output lines, %d ms.', [Arguments, Ord(Result), ExitCode, CapCount, GetTickCount - Started]));
end;

procedure ClearPlan;
begin
  PlanSatellite := '';
  PlanName := '';
  PlanPort := '';
  PlanAutostart := '';
  PlanImage := '';
  PlanAddresses := '';
  PlanNeedsSecret := '';
  PlanNeedsCertificate := '';
  PlanSetupFinished := '';
  PlanCertificateFile := '';
  PlanFingerprint := '';
  PlanError := '';
end;

// satellite-setup.ps1 -ShowPlan -Root Root <Extra>: no Docker call, no file written. False (with PlanError set) when
// the script refuses the input (exit 1, its ERROR: line) or could not run.
function RunPlan(const Root, Extra: String): Boolean;
var
  Code: Integer;
begin
  ClearPlan;
  Result := False;
  if not RunScriptCaptured('-ShowPlan -Root ' + Q(Root) + Extra, Code) then
  begin
    PlanError := 'The setup script could not be started.';
    Exit;
  end;
  if Code <> 0 then
  begin
    PlanError := CapturedReason;
    if PlanError = '' then PlanError := 'The setup script refused the input (exit code ' + IntToStr(Code) + ').';
    Exit;
  end;
  PlanSatellite := CapturedValue('SATELLITE');
  PlanName := CapturedValue('NAME');
  PlanPort := CapturedValue('PORT');
  PlanAutostart := CapturedValue('AUTOSTART');
  PlanImage := CapturedValue('IMAGE');
  PlanAddresses := CapturedValue('ADDRESSES');
  PlanNeedsSecret := CapturedValue('NEEDS_SECRET');
  PlanNeedsCertificate := CapturedValue('NEEDS_CERTIFICATE');
  PlanSetupFinished := CapturedValue('SETUP_FINISHED');
  PlanCertificateFile := CapturedValue('CERTIFICATE_FILE');
  PlanFingerprint := CapturedValue('FINGERPRINT');
  Result := PlanSatellite <> '';
  if not Result then PlanError := 'The setup script gave no plan.';
  // (A line of [Code] must not start with a bracket: Inno reads that as a section tag.)
  Log(Format('Plan for "%s" %s: satellite %s, name %s, port %s, autostart %s, needs secret %s, needs certificate %s, finished %s, addresses "%s", image "%s".', [Root, Extra, PlanSatellite, PlanName, PlanPort, PlanAutostart, PlanNeedsSecret, PlanNeedsCertificate, PlanSetupFinished, PlanAddresses, PlanImage]));
end;

// The addresses of a plan as the URLs Vocalis is given, one per line, primary first.
function PlanUrlLines(const Port: String): String;
var
  Rest, Item: String;
  P: Integer;
begin
  Result := '';
  Rest := PlanAddresses;
  while Length(Rest) > 0 do
  begin
    P := Pos(',', Rest);
    if P = 0 then
    begin
      Item := Trim(Rest);
      Rest := '';
    end
    else
    begin
      Item := Trim(Copy(Rest, 1, P - 1));
      Rest := Copy(Rest, P + 1, Length(Rest));
    end;
    if Item <> '' then
    begin
      if Result <> '' then Result := Result + Nl;
      Result := Result + 'https://' + Item + ':' + Port;
    end;
  end;
end;

// ---- the installer state file: what the wizard collected, so a repair can pass it again ----

procedure LoadState(const AppDir: String);
var
  FileName: String;
begin
  FileName := AppDir + '\' + StateFileName;
  StateRoot := FileValue(FileName, 'ROOT');
  StateImage := FileValue(FileName, 'IMAGE');
  StatePort := FileValue(FileName, 'PORT');
  StateName := FileValue(FileName, 'NAME');
  StateAddress := FileValue(FileName, 'ADDRESS');
  StateAutostart := FileValue(FileName, 'AUTOSTART');
  Log(Format('State file "%s": folder "%s", image "%s", port %s, name %s, extra address "%s", autostart %s.', [FileName, StateRoot, StateImage, StatePort, StateName, StateAddress, StateAutostart]));
end;

// KEY=VALUE, UTF-8 without a byte-order mark. Never holds the secret.
procedure WriteState;
var
  Lines: TArrayOfString;
begin
  SetArrayLength(Lines, 7);
  Lines[0] := 'ROOT=' + ChosenRoot;
  Lines[1] := 'IMAGE=' + BakedImage;
  Lines[2] := 'VERSION=' + AppVersionText;
  Lines[3] := 'PORT=' + ChosenPort;
  Lines[4] := 'NAME=' + ChosenName;
  Lines[5] := 'ADDRESS=' + ChosenAddress;
  Lines[6] := 'AUTOSTART=' + ChosenAutostart;
  if SaveStringsToUTF8FileWithoutBOM(ExpandConstant('{app}\' + StateFileName), Lines, False) then
    Log(Format('Wrote %s: folder "%s", image "%s", version %s, port %s, name %s, extra address "%s", autostart %s.', [StateFileName, ChosenRoot, BakedImage, AppVersionText, ChosenPort, ChosenName, ChosenAddress, ChosenAutostart]))
  else
    Log('Could not write ' + StateFileName + '.');
end;

// ---- test seam and shell actions ----

function ShellSeam: Boolean;
begin
  Result := GetEnv('VOCALIS_SATELLITE_TEST_NO_SHELL') = '1';
end;

procedure NoteShellAction(const Text: String);
var
  Line: String;
begin
  Line := GetDateTimeString('yyyy/mm/dd hh:nn:ss', '-', ':') + ' would ' + Text + #10;
  ForceDirectories(ExpandConstant('{app}'));
  if SaveStringToFile(ExpandConstant('{app}\' + ShellLogName), Utf8Encode(Line), True) then
    Log('Test seam: would ' + Text)
  else
    Log('Test seam: could not write ' + ShellLogName);
end;

procedure ShowFileInExplorer(const FileName: String);
var
  Code: Integer;
begin
  if ShellSeam then
  begin
    NoteShellAction('show "' + FileName + '" in Explorer');
    Exit;
  end;
  Exec(ExpandConstant('{win}\explorer.exe'), '/select,' + Q(FileName), '', SW_SHOWNORMAL, ewNoWait, Code);
  Log('Opened Explorer on "' + FileName + '".');
end;

procedure OpenInNotepad(const FileName: String);
var
  Code: Integer;
begin
  if ShellSeam then
  begin
    NoteShellAction('open "' + FileName + '" in Notepad');
    Exit;
  end;
  Exec(ExpandConstant('{win}\notepad.exe'), Q(FileName), '', SW_SHOWNORMAL, ewNoWait, Code);
  Log('Opened Notepad on "' + FileName + '".');
end;

// The wizard starts the tray icon from code after the script has exited (not from a [Run] entry). Started without
// --signin: an icon started any other way never starts the satellite by itself. A second copy exits at once (its
// mutex), so starting it again while one runs is harmless.
procedure StartTrayIcon;
var
  Code: Integer;
  TrayPath: String;
begin
  TrayPath := ExpandConstant('{app}\' + TrayExeName);
  // The icon is started under the test seam too. It is this wizard's child, so it lands on the wizard's own desktop
  // (the hidden one in a test) and inherits the seam variable, which keeps it from opening anything itself. Explorer
  // and Notepad are different: they hand off to the visible desktop's shell, which is what the seam exists to stop.
  // The line in the seam log lets a test see that the wizard, not the test, started the icon.
  if ShellSeam then
    NoteShellAction('start the tray icon "' + TrayPath + '" (started)');
  if not FileExists(TrayPath) then
  begin
    Log('The tray program is not installed at "' + TrayPath + '"; not started.');
    Exit;
  end;
  if Exec(TrayPath, '', ExpandConstant('{app}'), SW_SHOWNORMAL, ewNoWait, Code) then
    Log('Started the tray icon "' + TrayPath + '".')
  else
    Log('Could not start the tray icon "' + TrayPath + '": ' + SysErrorMessage(Code));
end;

// Asks a running icon to close and waits (the tray program bounds the wait itself). A mutex can detect a program but
// cannot close it, so the setup program and the uninstaller use --exit.
// Exit codes of the tray program's --exit: 0 done (also when no icon is running), 1 refused or failed (reason on its
// standard error), 2 bad usage, 3 no icon running, 4 the icon did not answer in time. Returns True only for 0 and 3:
// the icon is closed, or none was running. Any other answer (1, 2, 4, or a program that could not be started at all)
// returns False, because an icon that may still be running holds its program file open: the caller must not copy over
// it (upgrade) or must say so (uninstall). Until October 11, 2026 only 4 stopped an upgrade,
// so an answer of 1 let it copy over a running program file.
function CloseTrayIcon(const AppDir: String): Boolean;
var
  TrayPath: String;
  Code: Integer;
  Started: Cardinal;
begin
  Result := True;
  TrayPath := AppDir + '\' + TrayExeName;
  if not FileExists(TrayPath) then
  begin
    Log('No tray program at "' + TrayPath + '" to close.');
    Exit;
  end;
  Started := GetTickCount;
  if Exec(TrayPath, '--exit', AppDir, SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Result := (Code = 0) or (Code = 3);
    Log(Format('"%s" --exit returned %d after %d ms; the icon is treated as closed: %d.', [TrayPath, Code, GetTickCount - Started, Ord(Result)]));
  end
  else
  begin
    Result := False;
    Log('Could not run "' + TrayPath + '" --exit: ' + SysErrorMessage(Code) + '; the icon is treated as not closed.');
  end;
end;

// The pairing secret file is plain ASCII with no byte-order mark (what the in-image tool requires). It is deleted at
// every start of the setup program, as soon as the script has exited, by the tray program at its start, and by
// uninstall, which covers a setup program that was killed. It is in the program folder, not in {tmp}.
procedure DeleteLeftoverSecret(const AppDir: String);
var
  FileName: String;
begin
  FileName := AppDir + '\' + SecretFileName;
  if FileExists(FileName) then
  begin
    if DeleteFile(FileName) then
      Log('Deleted a leftover pairing secret file from an earlier run.')
    else
      Log('Could not delete a leftover pairing secret file.');
  end;
end;

// ---- prerequisites ----

// The .NET Framework check the wizard makes itself (the tray program targets 4.8, which every supported Windows has).
function DotNetFrameworkOk(var Line: String): Boolean;
var
  Release: Cardinal;
begin
  Result := RegQueryDWordValue(HKLM, DotNetKey, 'Release', Release) and (Release >= MinimumDotNetRelease);
  if Result then
    Line := 'OK    .NET Framework 4.8 or later is installed (release ' + IntToStr(Release) + ').'
  else
    Line := 'FAIL  .NET Framework 4.8 or later was not found.' + Nl +
      '      Fix: install the .NET Framework 4.8 from Microsoft''s download page (https://dotnet.microsoft.com/download/dotnet-framework/net48), then choose Retry. Setup downloads nothing itself.';
  Log('.NET Framework check: ' + Line);
end;

procedure RunPrerequisiteChecks;
var
  Code: Integer;
  Text, DotNetText: String;
  ScriptOk, DotNetOk: Boolean;
begin
  PrereqPassed := False;
  PrereqStatus.Caption := 'Checking Docker Desktop and the NVIDIA runtime. This can take a minute...';
  PrereqMemo.Lines.Text := '';
  PrereqRetry.Enabled := False;
  WizardForm.NextButton.Enabled := False;
  WizardForm.BackButton.Enabled := False;
  WizardForm.CancelButton.Enabled := False;
  try
    ScriptOk := False;
    if RunScriptCaptured('-CheckOnly', Code) then
    begin
      Text := JoinLines(CapLines, CapCount);
      ScriptOk := Code = 0;
    end
    else
      Text := 'The checks did not start. Windows PowerShell could not be run.';
    DotNetOk := DotNetFrameworkOk(DotNetText);
    PrereqMemo.Lines.Text := Text + Nl + DotNetText;
    PrereqPassed := ScriptOk and DotNetOk;
  finally
    PrereqRetry.Enabled := True;
    WizardForm.BackButton.Enabled := True;
    WizardForm.CancelButton.Enabled := True;
  end;
  WizardForm.NextButton.Enabled := PrereqPassed;
  if PrereqPassed then
    PrereqStatus.Caption := 'All checks passed. Choose Next.'
  else
    PrereqStatus.Caption := 'A check failed. Follow the Fix text on the failed line, then choose Retry.';
  Log(Format('Prerequisite checks passed: %d (script exit code %d).', [Ord(PrereqPassed), Code]));
end;

procedure PrereqRetryClick(Sender: TObject);
begin
  RunPrerequisiteChecks;
end;

// ---- the satellite folder page ----

// Returns '' when Dir is usable, else the reason. UseExisting is set when Dir already holds a satellite. The script's
// own refusals (a comma, a folder that is not empty and not a satellite folder, unreadable settings) come through
// -ShowPlan, the one authority; the checks here are the main installer's, kept so the reason is given before a script runs.
function ValidateFolder(const Dir: String; var UseExisting: Boolean): String;
var
  Free, Total: Int64;
  AppDir: String;
begin
  Result := '';
  UseExisting := False;
  if (Pos('''', Dir) > 0) or HasLineBreak(Dir) then
    Result := 'The satellite folder path cannot contain an apostrophe or a line break: the setup script refuses it.' + Nl +
      'If the default folder under your user profile contains an apostrophe, choose another folder, for example on another drive.'
  else if (Length(Dir) < 4) or (Dir[2] <> ':') or (Dir[3] <> '\') then
    Result := 'Enter a full path that starts with a drive letter, for example E:\Satellite. A whole drive cannot be used; choose a folder on it.'
  else if GetDriveType(Copy(Dir, 1, 3)) = 4 then
    Result := 'A network drive cannot be used: the satellite folder holds the model files and logs, which need a local drive.'
  else
  begin
    AppDir := WizardDirValue;
    if (CompareText(Dir, RemoveBackslashUnlessRoot(AppDir)) = 0) or
       (Pos(Lowercase(RemoveBackslashUnlessRoot(AppDir) + '\'), Lowercase(Dir + '\')) = 1) then
      Result := 'The satellite folder cannot be inside the program folder (' + AppDir + '); uninstalling would remove it from under you.'
    else if not RunPlan(Dir, '') then
      Result := PlanError
    else if PlanSatellite = 'existing' then
      UseExisting := True
    else if GetSpaceOnDisk64(ExtractFileDrive(Dir) + '\', Free, Total) then
    begin
      if Free < MinimumFolderBytes then
        Result := 'The satellite folder needs about 3.2 GB for the model files, and ' + ExtractFileDrive(Dir) + ' has only ' + GigabytesText(Free) + ' free.';
    end
    else
      Result := 'The free space on ' + ExtractFileDrive(Dir) + ' could not be read. Choose a folder on a drive that exists.';
  end;
end;

// ---- the port, name and starting page (a new folder only) ----

// The shape both scripts want of a name or an extra address, as far as the command line is concerned: no quote and no
// line break. Everything else is judged by -ShowPlan.
function SafeForCommandLine(const Text: String): Boolean;
begin
  Result := (Pos('"', Text) = 0) and (not HasLineBreak(Text));
end;

function AddressArgument(const Address: String): String;
begin
  if Trim(Address) = '' then Result := '' else Result := ' -Address ' + Q(Trim(Address));
end;

procedure RefreshPortAddressNote;
begin
  if RunPlan(ChosenRoot, ' -Port ' + Trim(PortPage.Values[0]) + ' -Name ' + Q(Trim(PortPage.Values[1])) + AddressArgument(PortPage.Values[2])) then
  begin
    if PlanAddresses = '' then
      PortAddressNote.Caption := 'Setup found no network address for this computer. Fill in "Extra address" with the address Vocalis uses to reach it.'
    else
      PortAddressNote.Caption := 'Setup will name these addresses in the satellite''s certificate: ' + ReplaceAll(PlanAddresses, ',', ', ') + '.';
  end
  else
    PortAddressNote.Caption := 'Setup could not read the computer''s addresses yet: ' + PlanError;
end;

// Numeric, in range, then the Windows bind check through satellite-setup.ps1 -CheckPort (the same check a real setup
// runs; a busy port offers the next free one), then -ShowPlan on the whole set, which also needs an address.
function ValidatePortPage: Boolean;
var
  PortNumber, Suggested, Code: Integer;
  Suggestion: String;
  I: Integer;
begin
  Result := False;
  PortNumber := StrToIntDef(Trim(PortPage.Values[0]), 0);
  if (PortNumber < 1024) or (PortNumber > 65535) then
  begin
    MsgBox('The port must be a number from 1024 through 65535.', mbError, MB_OK);
    Exit;
  end;
  if (Trim(PortPage.Values[1]) = '') or (not SafeForCommandLine(PortPage.Values[1])) or (not SafeForCommandLine(PortPage.Values[2])) then
  begin
    MsgBox('Give the satellite a name, and use no quotation mark or line break in the name or the extra address.', mbError, MB_OK);
    Exit;
  end;
  if RunScriptCaptured('-CheckPort -Port ' + IntToStr(PortNumber), Code) then
  begin
    if Code = 1 then
    begin
      // The script prints "Suggested port: <n>" when the port is taken (exit 1).
      Suggestion := '';
      for I := 0 to CapCount - 1 do
        if Copy(Trim(CapLines[I]), 1, 15) = 'Suggested port:' then
          Suggestion := Trim(Copy(Trim(CapLines[I]), 16, Length(CapLines[I])));
      Suggested := StrToIntDef(Suggestion, 0);
      Log(Format('Port %d is taken; the script suggests "%s".', [PortNumber, Suggestion]));
      if Suggested >= 1024 then
      begin
        if MsgBox('Port ' + IntToStr(PortNumber) + ' cannot be used on this computer.' + Nl + Nl + 'Use port ' + IntToStr(Suggested) + ' instead?', mbConfirmation, MB_YESNO) = IDYES then
          PortPage.Values[0] := IntToStr(Suggested);
      end
      else
        MsgBox('Port ' + IntToStr(PortNumber) + ' cannot be used on this computer, and no free port was found nearby. Enter another port.', mbError, MB_OK);
      Exit;
    end
    else if Code <> 0 then
      // The script tests the port again before it creates the container, so a check that could not run is logged
      // and does not block the wizard.
      Log('The port check returned exit code ' + IntToStr(Code) + '; the setup script tests the port itself.');
  end
  else
    Log('The port check could not run; the setup script tests the port itself.');
  if not RunPlan(ChosenRoot, ' -Port ' + IntToStr(PortNumber) + ' -Name ' + Q(Trim(PortPage.Values[1])) + AddressArgument(PortPage.Values[2])) then
  begin
    MsgBox(PlanError, mbError, MB_OK);
    Exit;
  end;
  if PlanAddresses = '' then
  begin
    if Trim(PortPage.Values[2]) = '' then
      MsgBox('Setup found no network address for this computer. Fill in "Extra address" with the address Vocalis uses to reach it (an IPv4 address or a name).', mbError, MB_OK)
    else
      MsgBox('Setup still has no usable address with that extra address. Check it (an IPv4 address or a plain name).', mbError, MB_OK);
    Exit;
  end;
  ChosenPort := IntToStr(PortNumber);
  ChosenName := Trim(PortPage.Values[1]);
  ChosenAddress := Trim(PortPage.Values[2]);
  ChosenAutostart := OnOff(AutostartCheck.Checked);
  Log(Format('Port page accepted: port %s, name %s, extra address "%s", autostart %s.', [ChosenPort, ChosenName, ChosenAddress, ChosenAutostart]));
  Result := True;
end;

// ---- the new certificate page (/MODE=newcertificate) ----

function ValidateCertificatePage: Boolean;
begin
  Result := False;
  if not SafeForCommandLine(CertPage.Values[0]) then
  begin
    MsgBox('Use no quotation mark or line break in the extra address.', mbError, MB_OK);
    Exit;
  end;
  if not RunPlan(StateRoot, AddressArgument(CertPage.Values[0])) then
  begin
    MsgBox(PlanError, mbError, MB_OK);
    Exit;
  end;
  if PlanAddresses = '' then
  begin
    MsgBox('Setup has no usable address for the certificate. Fill in "Extra address" with the address Vocalis uses to reach this computer.', mbError, MB_OK);
    Exit;
  end;
  ChosenAddress := Trim(CertPage.Values[0]);
  Log(Format('Certificate page accepted: extra address "%s", the certificate will name %s.', [ChosenAddress, PlanAddresses]));
  Result := True;
end;

// ---- the Pair page ----

function IsHexDigit(const C: Char): Boolean;
begin
  Result := ((C >= '0') and (C <= '9')) or ((C >= 'a') and (C <= 'f')) or ((C >= 'A') and (C <= 'F'));
end;

// 64 hexadecimal characters after trimming: all this page checks (the tool in the image judges the rest).
function SecretHasShape(const Text: String): Boolean;
var
  I: Integer;
begin
  Result := Length(Text) = 64;
  if Result then
    for I := 1 to Length(Text) do
      if not IsHexDigit(Text[I]) then Result := False;
end;

procedure CopyEditText(Edit: TCustomEdit);
begin
  Edit.SelStart := 0;
  Edit.SelLength := Length(Edit.Text);
  NativeSendMessage(Edit.Handle, $0301, 0, 0);
end;

procedure PairCopyClick(Sender: TObject);
begin
  CopyEditText(PairAddressMemo);
end;

// True when a secret is still to be given on this run: always for a new secret, otherwise whenever the plan says so
// (a first install, or a satellite taken over or repaired before it was ever paired). Never in the certificate mode.
function PairPageWanted: Boolean;
begin
  if RunMode = 'newcertificate' then
    Result := False
  else if RunMode = 'newsecret' then
    Result := True
  else
    Result := PlanNeedsSecret = 'yes';
end;

// ---- version order ----

// Decides how this setup program orders against an installed copy by running the control script's compare-version
// action from {tmp}, so the rule has one implementation, which has its own tests. Exit code 42 means the installed
// version is higher: refuse. Anything else (including a failure to run) is logged and allowed.
function InstalledVersionIsNewer(const Installed: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  EnsureComposeHelper;
  ExtractTemporaryFile('vocalis-control.ps1');
  if Exec(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File ' + Q(ExpandConstant('{tmp}\vocalis-control.ps1')) +
    ' -Action compare-version -InstalledVersion ' + Q(Installed) + ' -NewVersion ' + Q(AppVersionText),
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Log(Format('Version comparison: installed %s, this setup program %s, control script exit code %d.', [Installed, AppVersionText, ResultCode]));
    Result := ResultCode = 42;
  end
  else
    Log('The version comparison could not run; continuing.');
end;

// ---- the program folder and the drive of the satellite folder ----

// Where the program files will go, as far as it is known before the wizard exists (WizardDirValue and {app} are not
// available yet): /DIR= when given (Inno honors it even with the folder page off), else the folder of an existing
// install (Inno's UsePreviousAppDir default), else the default folder.
function ProgramFolderCandidate: String;
begin
  Result := RemoveBackslashUnlessRoot(Trim(ExpandConstant('{param:DIR|}')));
  if Result = '' then Result := InstalledApp;
  if Result = '' then Result := ExpandConstant('{localappdata}\Programs\{#ProgramFolder}');
end;

// The reason the setup script cannot use Dir as the program folder, or ''. The pairing secret is written to
// {app}\pairing-secret.tmp and its path goes to the script as -SecretFile, and the script refuses a path with an
// apostrophe, a comma or a line break (October 11, 2026: the likely case is an apostrophe or comma in
// the Windows profile name, which the default folder lies under). Said before anything is changed, with the way out.
function ProgramFolderProblem(const Dir: String): String;
var
  What: String;
begin
  Result := '';
  What := '';
  if Pos('''', Dir) > 0 then
    What := 'an apostrophe'
  else if Pos(',', Dir) > 0 then
    What := 'a comma'
  else if HasLineBreak(Dir) then
    What := 'a line break';
  if What <> '' then
    Result := '{#AppName} cannot be set up in this program folder:' + Nl + Dir + Nl + Nl +
      'The folder path contains ' + What + ', and the setup script refuses such a path for the file that carries the pairing secret to it.' + Nl + Nl +
      'Start this setup program again with another folder, for example from a command prompt:' + Nl +
      '  ' + ExtractFileName(ExpandConstant('{srcexe}')) + ' /DIR="C:\VocalisSatellite"' + Nl +
      '(use /DIR="<another folder>" with any folder whose path has no apostrophe, comma or line break). Nothing was changed.';
  Log(Format('Program folder "%s": problem "%s".', [Dir, What]));
end;

// ---- start ----

function InitializeSetup(): Boolean;
var
  Problem: String;
begin
  Result := True;
  SetupExitCode := 0;
  RunMode := Lowercase(Trim(ExpandConstant('{param:MODE|}')));
  if (RunMode <> '') and (RunMode <> 'repair') and (RunMode <> 'newsecret') and (RunMode <> 'newcertificate') then
  begin
    SuppressibleMsgBox('/MODE=' + RunMode + ' is not a mode of this setup program. The modes are repair, newsecret and newcertificate.', mbError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  InstalledHere := RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', InstalledVersionText);
  if InstalledHere then
  begin
    if not RegQueryStringValue(HKCU, UninstallKey, 'Inno Setup: App Path', InstalledApp) then InstalledApp := '';
    InstalledApp := RemoveBackslashUnlessRoot(InstalledApp);
    if InstalledApp <> '' then
    begin
      LoadState(InstalledApp);
      DeleteLeftoverSecret(InstalledApp);
    end;
    // The installed copy started with no mode (a double click) must not try to copy itself over itself: it is a repair.
    if (RunMode = '') and (InstalledApp <> '') and (CompareText(ExpandConstant('{srcexe}'), InstalledApp + '\' + SetupCopyName) = 0) then
    begin
      RunMode := 'repair';
      Log('The installed copy was started without /MODE=; treated as /MODE=repair.');
    end;
    Log(Format('Installed {#AppName} %s found in "%s"; mode "%s".', [InstalledVersionText, InstalledApp, RunMode]));
  end
  else
    Log('No installed {#AppName} found: first install; mode "' + RunMode + '".');
  if FullInstall then
    Log('Uninstallable=FullInstall is true: this run writes the uninstaller, its log and the uninstall key.')
  else
    Log('Uninstallable=FullInstall is false (mode "' + RunMode + '"): this run leaves the uninstaller, its log and the uninstall key alone.');
  // A program folder the script cannot use for the secret file: stop here, before anything else, with the reason and the
  // /DIR= way out. PrepareToInstall checks the real {app} again.
  Problem := ProgramFolderProblem(ProgramFolderCandidate);
  if Problem <> '' then
  begin
    SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  if RunMode <> '' then
  begin
    // A maintenance mode runs from the installed copy: it needs the install and the folder it recorded.
    if (not InstalledHere) or (StateRoot = '') then
    begin
      SuppressibleMsgBox('{#AppName} is not set up on this computer, so there is nothing to ' + RunMode + '. Run the setup program you downloaded.', mbError, MB_OK, IDOK);
      Result := False;
      Exit;
    end;
    ChosenRoot := StateRoot;
  end
  else if InstalledHere and InstalledVersionIsNewer(InstalledVersionText) then
  begin
    SuppressibleMsgBox('{#AppName} ' + InstalledVersionText + ' is already installed, and it is newer than this setup program (' + AppVersionText + ').' + Nl + Nl +
      'Setup does not roll a satellite back to an older version. Uninstall {#AppName} first (your satellite folder is kept), then run this setup program to take that folder over.',
      mbError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  // An install that recorded a folder: ask the script what is there. A satellite whose folder was deleted by hand
  // (the plan says there is none) is offered a fresh setup; the certificate and secret modes cannot make one.
  if InstalledHere and (StateRoot <> '') then
  begin
    ChosenRoot := StateRoot;
    // An upgrade or a maintenance mode whose saved satellite folder is on a drive that is not there (a removable or
    // network-mapped drive that is not connected): say so, and the two ways out, instead of the script's bare refusal.
    if not DirExists(ExtractFileDrive(StateRoot) + '\') then
    begin
      Log(Format('The drive of the saved satellite folder "%s" is not there.', [StateRoot]));
      SuppressibleMsgBox('The satellite folder saved by the earlier setup is on a drive that is not available now:' + Nl + StateRoot + Nl + Nl +
        'Reconnect that drive and run this setup program again. If the drive is gone for good, uninstall {#AppName} first (Windows Settings, Installed apps; ' +
        'the uninstaller cannot reach the satellite''s container through that folder and says so), then run this setup program again and choose another folder. Nothing was changed.',
        mbError, MB_OK, IDOK);
      Result := False;
      Exit;
    end;
    if RunPlan(StateRoot, '') then
    begin
      if (PlanSatellite = 'new') and (RunMode <> '') then
      begin
        if (RunMode = 'repair') and (StatePort <> '') and (StateName <> '') then
        begin
          if SuppressibleMsgBox('No satellite is set up in' + Nl + StateRoot + Nl + 'The folder may have been deleted or moved. Set up a new satellite there with the saved port and name?',
            mbConfirmation, MB_YESNO, IDNO) <> IDYES then
          begin
            Result := False;
            Exit;
          end;
        end
        else
        begin
          SuppressibleMsgBox('No satellite is set up in' + Nl + StateRoot + Nl + 'The folder may have been deleted or moved. There is nothing to change; run the setup program you downloaded to set up a satellite again.',
            mbError, MB_OK, IDOK);
          Result := False;
          Exit;
        end;
      end;
    end
    else
    begin
      // A refused folder (a drive that is not there, unreadable settings): the pages cannot be decided; say why and stop.
      SuppressibleMsgBox('The satellite folder cannot be used:' + Nl + StateRoot + Nl + Nl + PlanError, mbError, MB_OK, IDOK);
      Result := False;
      Exit;
    end;
  end;
end;

// Nothing to do for a new install; on an upgrade the running tray icon is asked to close first, since its program file
// is about to be replaced. A leftover secret file is removed again. Skipped in a maintenance mode: the icon is left running.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  // The real program folder, now that the wizard has settled it: the same refusal as InitializeSetup's, which could only
  // work from /DIR=, the earlier install's folder and the default.
  Result := ProgramFolderProblem(ExpandConstant('{app}'));
  if Result <> '' then
  begin
    Log('Setup stopped before copying: ' + Result);
    Exit;
  end;
  if RunMode = '' then
  begin
    if InstalledHere and (InstalledApp <> '') then
      if not CloseTrayIcon(InstalledApp) then
      begin
        Result := 'The Vocalis Satellite icon in the notification area could not be closed (it did not close when asked), and it may be using the program files that are about to be replaced. ' +
          'Close it from its menu (right-click the icon in the notification area and choose "Close this icon"), then run this setup program again. Nothing was changed.';
        Log('Upgrade stopped: ' + Result);
        Exit;
      end;
    DeleteLeftoverSecret(ExpandConstant('{app}'));
  end;
end;

// ---- the wizard ----

// The header picture's place (wizard-header-picture.iss, shared with the other setup program).
#include "wizard-header-picture.iss"

procedure InitializeWizard;
var
  Top: Integer;
begin
  PlaceHeaderPicture;
  // Welcome: two sentences, what a satellite is and that it is optional.
  WizardForm.WelcomeLabel2.Caption := 'A satellite lets Vocalis use the NVIDIA graphics card of this computer to render speech, even when Vocalis itself runs on another computer. ' +
    'A satellite is optional: Vocalis works without one, and you can remove it at any time.';

  // Prerequisites: live, from satellite-setup.ps1 -CheckOnly, plus the wizard's own .NET Framework check.
  PrereqPage := CreateCustomPage(wpLicense, 'Prerequisites',
    'The satellite needs Docker Desktop with an NVIDIA GPU runtime.');
  PrereqNote := TNewStaticText.Create(PrereqPage);
  PrereqNote.Parent := PrereqPage.Surface;
  PrereqNote.AutoSize := False;
  PrereqNote.WordWrap := True;
  PrereqNote.Left := 0;
  PrereqNote.Top := 0;
  PrereqNote.Width := PrereqPage.SurfaceWidth;
  PrereqNote.Height := ScaleY(48);
  PrereqNote.Caption := 'Space needed: about 10 GB in Docker''s disk for the image, plus about 3.2 GB of model files in the satellite folder (' +
    FreeSpaceText(DefaultSatelliteFolder) + '; the folder page checks the drive you choose). ' +
    'Installing Docker, drivers or the NVIDIA runtime is never automatic; this page tells you what to fix.';
  PrereqDockerNote := TNewStaticText.Create(PrereqPage);
  PrereqDockerNote.Parent := PrereqPage.Surface;
  PrereqDockerNote.AutoSize := False;
  PrereqDockerNote.WordWrap := True;
  PrereqDockerNote.Left := 0;
  PrereqDockerNote.Top := PrereqNote.Height;
  PrereqDockerNote.Width := PrereqPage.SurfaceWidth;
  if RegValueExists(HKCU, RunKey, DockerDesktopRunValue) then
  begin
    PrereqDockerNote.Height := 0;
    PrereqDockerNote.Caption := '';
  end
  else
  begin
    PrereqDockerNote.Height := ScaleY(32);
    PrereqDockerNote.Caption := 'Docker Desktop is not set to start when you sign in to Windows, so the satellite can only start with Windows once you turn that on (Docker Desktop, Settings, General). This does not block setup.';
  end;
  PrereqMemo := TNewMemo.Create(PrereqPage);
  PrereqMemo.Parent := PrereqPage.Surface;
  PrereqMemo.Left := 0;
  PrereqMemo.Top := PrereqDockerNote.Top + PrereqDockerNote.Height + ScaleY(8);
  PrereqMemo.Width := PrereqPage.SurfaceWidth;
  PrereqMemo.Height := PrereqPage.SurfaceHeight - PrereqMemo.Top - ScaleY(40);
  PrereqMemo.ReadOnly := True;
  PrereqMemo.ScrollBars := ssVertical;
  PrereqMemo.WordWrap := True;
  PrereqRetry := TNewButton.Create(PrereqPage);
  PrereqRetry.Parent := PrereqPage.Surface;
  PrereqRetry.Caption := 'Retry';
  PrereqRetry.Left := 0;
  PrereqRetry.Width := ScaleX(90);
  PrereqRetry.Height := ScaleY(26);
  PrereqRetry.Top := PrereqPage.SurfaceHeight - PrereqRetry.Height - ScaleY(4);
  PrereqRetry.OnClick := @PrereqRetryClick;
  PrereqStatus := TNewStaticText.Create(PrereqPage);
  PrereqStatus.Parent := PrereqPage.Surface;
  PrereqStatus.Left := PrereqRetry.Width + ScaleX(12);
  PrereqStatus.Top := PrereqRetry.Top + ScaleY(5);
  PrereqStatus.Width := PrereqPage.SurfaceWidth - PrereqStatus.Left;
  PrereqStatus.AutoSize := False;
  PrereqStatus.Caption := '';

  // Satellite folder (first install). A folder that already holds a satellite is offered as "use this satellite".
  FolderPage := CreateInputDirPage(PrereqPage.ID, 'Satellite folder',
    'Where should the satellite keep its files?',
    'The satellite keeps its secret, certificate, model files and logs in one folder. Choose an empty or new folder on a local drive with enough space, ' +
    'or the folder of a satellite you already set up (for example with satellite-setup.ps1) to take it over.', False, '');
  FolderPage.Add('');
  FolderPage.Values[0] := DefaultSatelliteFolder;

  // Port, name and starting (a new folder only).
  PortPage := CreateInputQueryPage(FolderPage.ID, 'Port, name and starting',
    'Which port should the satellite use, and what is it called?',
    'Vocalis connects to the satellite on this port. Change the port only if another program already uses it.');
  PortPage.Add('Port:', False);
  PortPage.Add('Name (labels the satellite''s log lines):', False);
  PortPage.Add('Extra address (optional; only if Vocalis reaches this computer by an address setup does not find, for example through a VPN):', False);
  PortPage.Values[0] := DefaultPortText;
  PortPage.Values[1] := Lowercase(GetComputerNameString);
  Top := PortPage.Edits[2].Top + PortPage.Edits[2].Height + ScaleY(8);
  PortAddressNote := TNewStaticText.Create(PortPage);
  PortAddressNote.Parent := PortPage.Surface;
  PortAddressNote.AutoSize := False;
  PortAddressNote.WordWrap := True;
  PortAddressNote.Left := 0;
  PortAddressNote.Top := Top;
  PortAddressNote.Width := PortPage.SurfaceWidth;
  PortAddressNote.Height := ScaleY(32);
  AutostartCheck := TNewCheckBox.Create(PortPage);
  AutostartCheck.Parent := PortPage.Surface;
  AutostartCheck.Left := 0;
  AutostartCheck.Top := Top + PortAddressNote.Height + ScaleY(6);
  AutostartCheck.Width := PortPage.SurfaceWidth;
  AutostartCheck.Caption := 'Start the satellite when Windows starts. You can change this from the tray icon.';
  AutostartCheck.Checked := True;

  // New certificate (/MODE=newcertificate): the addresses the new certificate will name, and the extra address box.
  CertPage := CreateInputQueryPage(PortPage.ID, 'New certificate',
    'Make a new certificate for the satellite.',
    'Vocalis must be given the new certificate file afterwards. The old file will no longer match.');
  CertPage.Add('Extra address (optional; only if Vocalis reaches this computer by an address setup does not find):', False);
  // Starts with the Extra address saved at first setup (ADDRESS in satellite-installer-state.txt, read by LoadState in
  // InitializeSetup, which runs before this), so a VPN address given then is not silently dropped from the new
  // certificate (October 11, 2026). Empty when none was given, or when there is no install yet.
  CertPage.Values[0] := StateAddress;
  CertAddressMemo := TNewMemo.Create(CertPage);
  CertAddressMemo.Parent := CertPage.Surface;
  CertAddressMemo.Left := 0;
  CertAddressMemo.Top := CertPage.Edits[0].Top + CertPage.Edits[0].Height + ScaleY(12);
  CertAddressMemo.Width := CertPage.SurfaceWidth;
  CertAddressMemo.Height := ScaleY(70);
  CertAddressMemo.ReadOnly := True;
  CertAddressMemo.ScrollBars := ssVertical;
  CertAddressMemo.WordWrap := True;

  // Pair with Vocalis: before anything is installed, so Cancel here is an ordinary cancel.
  PairPage := CreateCustomPage(CertPage.ID, 'Pair with Vocalis',
    'Give the satellite the secret Vocalis shows.');
  PairIntro := TNewStaticText.Create(PairPage);
  PairIntro.Parent := PairPage.Surface;
  PairIntro.AutoSize := False;
  PairIntro.WordWrap := True;
  PairIntro.Left := 0;
  PairIntro.Top := 0;
  PairIntro.Width := PairPage.SurfaceWidth;
  PairIntro.Height := ScaleY(48);
  PairAddressMemo := TNewMemo.Create(PairPage);
  PairAddressMemo.Parent := PairPage.Surface;
  PairAddressMemo.Left := 0;
  PairAddressMemo.Top := PairIntro.Top + PairIntro.Height + ScaleY(4);
  PairAddressMemo.Width := PairPage.SurfaceWidth - ScaleX(100);
  PairAddressMemo.Height := ScaleY(54);
  PairAddressMemo.ReadOnly := True;
  PairAddressMemo.ScrollBars := ssVertical;
  PairAddressMemo.WordWrap := False;
  PairCopy := TNewButton.Create(PairPage);
  PairCopy.Parent := PairPage.Surface;
  PairCopy.Caption := 'Copy';
  PairCopy.Left := PairAddressMemo.Width + ScaleX(10);
  PairCopy.Top := PairAddressMemo.Top;
  PairCopy.Width := ScaleX(90);
  PairCopy.Height := ScaleY(26);
  PairCopy.OnClick := @PairCopyClick;
  PairPrompt := TNewStaticText.Create(PairPage);
  PairPrompt.Parent := PairPage.Surface;
  PairPrompt.AutoSize := False;
  PairPrompt.WordWrap := True;
  PairPrompt.Left := 0;
  PairPrompt.Top := PairAddressMemo.Top + PairAddressMemo.Height + ScaleY(14);
  PairPrompt.Width := PairPage.SurfaceWidth;
  PairPrompt.Height := ScaleY(18);
  PairPrompt.Caption := 'Vocalis shows a secret once. Paste it here:';
  PairSecret := TPasswordEdit.Create(PairPage);
  PairSecret.Parent := PairPage.Surface;
  PairSecret.Left := 0;
  PairSecret.Top := PairPrompt.Top + PairPrompt.Height + ScaleY(4);
  PairSecret.Width := PairPage.SurfaceWidth;
  PairSecret.Text := '';
  PairHint := TNewStaticText.Create(PairPage);
  PairHint.Parent := PairPage.Surface;
  PairHint.AutoSize := False;
  PairHint.WordWrap := True;
  PairHint.Left := 0;
  PairHint.Top := PairSecret.Top + PairSecret.Height + ScaleY(6);
  PairHint.Width := PairPage.SurfaceWidth;
  PairHint.Height := ScaleY(32);
  PairHint.Caption := 'The secret is 64 characters of 0-9 and a-f. It stays on this computer and is deleted from the program folder as soon as setup has used it.';

  // Setting up: shown from the post-install step while the script runs. It cannot be cancelled.
  // The description has room for two lines at 100% scaling (live test, October 11, 2026: the earlier, longer text was cut
  // off after "keeping"). It says the three facts: several minutes, no cancel here, and setup carries on when run again.
  RunPage := CreateOutputMarqueeProgressPage('Setting up the satellite',
    'A first run can take several minutes. It cannot be cancelled here; if it is interrupted, run setup again and it carries on.');

  CreateFinishControls;
end;

// The page set. A maintenance mode shows only the pages it needs: Pair when a secret is to be given, the certificate
// page for a new certificate, then Setting up and Finish.
function ShouldSkipPage(PageID: Integer): Boolean;
var
  Known: Boolean;
begin
  Result := False;
  Known := InstalledHere and (StateRoot <> '');
  if RunMode <> '' then
  begin
    if (PageID = wpWelcome) or (PageID = wpLicense) or (PageID = wpReady) or (PageID = PrereqPage.ID) or
       (PageID = FolderPage.ID) or (PageID = PortPage.ID) then
      Result := True
    else if PageID = CertPage.ID then
      Result := RunMode <> 'newcertificate'
    else if PageID = PairPage.ID then
      Result := not PairPageWanted;
  end
  else
  begin
    if PageID = FolderPage.ID then
      Result := Known
    else if PageID = PortPage.ID then
      Result := Known or UseExistingFolder
    else if PageID = CertPage.ID then
      Result := True
    else if PageID = PairPage.ID then
      Result := not PairPageWanted;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem, Dir, Typed: String;
begin
  Result := True;
  if CurPageID = FolderPage.ID then
  begin
    Dir := RemoveBackslashUnlessRoot(Trim(FolderPage.Values[0]));
    Problem := ValidateFolder(Dir, UseExistingFolder);
    if Problem <> '' then
    begin
      MsgBox(Problem, mbError, MB_OK);
      UseExistingFolder := False;
      Result := False;
    end
    else if UseExistingFolder and
      (MsgBox('This folder already holds a satellite' + Nl + Dir + Nl + Nl + 'Use this satellite? Setup keeps its secret, certificate and models, and its port and name stay as they are.', mbConfirmation, MB_YESNO) <> IDYES) then
    begin
      UseExistingFolder := False;
      Result := False;
    end
    else
    begin
      FolderPage.Values[0] := Dir;
      ChosenRoot := Dir;
      Log(Format('Satellite folder "%s" accepted; holds a satellite: %d.', [Dir, Ord(UseExistingFolder)]));
      if UseExistingFolder then
      begin
        // Taken over: the script's own record of the port, name and autostart value is the truth.
        ChosenPort := PlanPort;
        ChosenName := PlanName;
        ChosenAutostart := PlanAutostart;
        ChosenAddress := '';
      end;
    end;
  end
  else if CurPageID = PortPage.ID then
    Result := ValidatePortPage
  else if CurPageID = CertPage.ID then
    Result := ValidateCertificatePage
  else if CurPageID = PairPage.ID then
  begin
    Typed := Trim(PairSecret.Text);
    if not SecretHasShape(Typed) then
    begin
      MsgBox('That is not the shape of a Vocalis secret. It is 64 characters of 0-9 and a-f; what you pasted has ' + IntToStr(Length(Typed)) + ' characters.' + Nl + Nl +
        'Copy it again from Vocalis (it is shown once; "New secret..." on the satellite''s row shows a new one).', mbError, MB_OK);
      Result := False;
    end
    else
    begin
      SecretValue := Typed;
      Log('A secret of the right shape was entered on the Pair page.');
    end;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Extra: String;
begin
  if CurPageID = PrereqPage.ID then
  begin
    if PrereqPassed then
      WizardForm.NextButton.Enabled := True
    else
      RunPrerequisiteChecks;
  end
  else if CurPageID = PortPage.ID then
    RefreshPortAddressNote
  else if CurPageID = CertPage.ID then
  begin
    // The list shows what the certificate will name with the extra address the box starts with (the one saved at first setup).
    if SafeForCommandLine(CertPage.Values[0]) then Extra := AddressArgument(CertPage.Values[0]) else Extra := '';
    if RunPlan(ChosenRoot, Extra) then
      CertAddressMemo.Lines.Text := ReplaceAll(PlanAddresses, ',', Nl)
    else
      CertAddressMemo.Lines.Text := PlanError;
  end
  else if CurPageID = PairPage.ID then
  begin
    if RunMode = 'newsecret' then
      PairIntro.Caption := 'In Vocalis open Settings, Satellites, and choose "New secret..." on this satellite''s row. The satellite''s address is:'
    else
      PairIntro.Caption := 'In Vocalis open Settings, Satellites, and choose Add satellite. Address to enter:';
    if PlanPort <> '' then
      PairAddressMemo.Lines.Text := PlanUrlLines(PlanPort)
    else
      PairAddressMemo.Lines.Text := PlanUrlLines(ChosenPort);
    WizardForm.NextButton.Enabled := True;
  end
  else if CurPageID = wpFinished then
  begin
    ShowFinishPage;
    SetModifyEntry;
  end;
end;

// What the Ready page lists.
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'Install {#AppName} ' + AppVersionText + ' into:' + NewLine + Space + WizardDirValue + NewLine + NewLine;
  if InstalledHere and (StateRoot <> '') then
    Result := Result + 'Satellite folder (kept):' + NewLine + Space + StateRoot + NewLine +
      Space + 'Setup will rerun or update the satellite (finished downloads are kept).' + NewLine
  else if UseExistingFolder then
    Result := Result + 'Take over the satellite in:' + NewLine + Space + ChosenRoot + NewLine +
      Space + 'Its secret, certificate and models are kept.' + NewLine
  else
    Result := Result + 'New satellite folder:' + NewLine + Space + FolderPage.Values[0] + NewLine +
      'Port ' + PortPage.Values[0] + ', name ' + PortPage.Values[1] + ', start with Windows: ' + OnOff(AutostartCheck.Checked) + NewLine +
      Space + 'Setup then pulls the image if it is not on this computer and downloads about 3.2 GB of model files.' + NewLine;
  Result := Result + NewLine + 'The tray icon starts when you sign in to Windows.' + NewLine;
end;

// ---- install ----

// Settles the folder, port, name, extra address and autostart value before the copy: from the pages for a new satellite,
// from the state file for an upgrade or a repair, from the script's record for a take-over.
procedure PrepareChoices;
begin
  if (RunMode <> '') or (InstalledHere and (StateRoot <> '')) then
  begin
    ChosenRoot := StateRoot;
    ChosenPort := StatePort;
    ChosenName := StateName;
    ChosenAutostart := StateAutostart;
    // The extra address typed on the new certificate page is this run's own; every other run uses the recorded one.
    if RunMode <> 'newcertificate' then ChosenAddress := StateAddress;
  end;
  // A state file written by a run that stopped early may lack a value; these are the wizard's own defaults.
  if ChosenPort = '' then ChosenPort := DefaultPortText;
  if ChosenName = '' then ChosenName := Lowercase(GetComputerNameString);
  if ChosenAutostart = '' then ChosenAutostart := 'on';
  Log(Format('Choices: folder "%s", port %s, name %s, extra address "%s", autostart %s, mode "%s", take-over %d.', [ChosenRoot, ChosenPort, ChosenName, ChosenAddress, ChosenAutostart, RunMode, Ord(UseExistingFolder)]));
end;

procedure OnSetupLine(const S: String; const Error, FirstLine: Boolean);
var
  I, Slash, Close: Integer;
begin
  if Error then
  begin
    Log('Output capture error: ' + S);
    Exit;
  end;
  if Trim(S) = '' then Exit;
  // The last few non-empty lines, for a failure that left no reason in the result file.
  for I := 0 to GetArrayLength(TailLines) - 2 do TailLines[I] := TailLines[I + 1];
  TailLines[GetArrayLength(TailLines) - 1] := S;
  // A step header is "[n/N] title": it becomes the page's step title; every line is the latest output line.
  Slash := Pos('/', S);
  Close := Pos(']', S);
  if (Length(S) > 5) and (S[1] = '[') and (Slash > 2) and (Close > Slash) then
    RunPage.SetText(S, S)
  else
    RunPage.Msg2Label.Caption := S;
  RunPage.Animate;
end;

// The arguments of one run, by the table in the design. -Root and -NoPrompt always (under the wizard the secret prompt
// would be invisible and the run would wait forever). The secret is only ever named by its file.
function BuildScriptArguments(const SecretPath: String; var NeedsSecretFile: Boolean): String;
begin
  NeedsSecretFile := False;
  Result := '-Root ' + Q(ChosenRoot) + ' -NoPrompt';
  if RunMode = 'newsecret' then
  begin
    Result := Result + ' -NewSecret';
    NeedsSecretFile := True;
  end
  else if RunMode = 'newcertificate' then
    Result := Result + ' -NewCertificate' + AddressArgument(ChosenAddress)
  else if not RunPlan(ChosenRoot, '') then
    Log('The plan could not be read before the run: ' + PlanError)
  else if PlanSatellite = 'new' then
  begin
    // A first install (a new folder), or a repair after a first run that failed before satellite.env existed.
    Result := Result + ' -Image ' + Q(BakedImage) + ' -Port ' + ChosenPort + ' -Name ' + Q(ChosenName) + ' -Autostart ' + ChosenAutostart + AddressArgument(ChosenAddress);
    NeedsSecretFile := True;
  end
  else
  begin
    // An upgrade, a take-over or a repair of an existing satellite folder.
    if PlanSetupFinished = 'no' then
      // The folder's setup never finished (SETUP_FINISHED=no): nothing has ever run from the recorded image, so there is
      // nothing to update. The baked image is given with no -Update, whatever the recorded one is, and the script adopts
      // it and records it (design, arguments table; October 11, 2026: without this a first run that
      // failed after satellite.env existed could never be finished by a setup program carrying another image).
      Result := Result + ' -Image ' + Q(BakedImage)
    else if PlanImage <> BakedImage then
      // A finished satellite: a plain rerun when the recorded image is the baked one, an update otherwise.
      Result := Result + ' -Update -Image ' + Q(BakedImage);
    if PlanNeedsSecret = 'yes' then NeedsSecretFile := True;
  end;
  if NeedsSecretFile then
  begin
    if SecretValue <> '' then
      Result := Result + ' -SecretFile ' + Q(SecretPath)
    else
      NeedsSecretFile := False;
  end;
  // The decision with its values (the secret itself is never named here, only whether a file carries it).
  Log(Format('Script arguments decided: satellite %s, finished %s, recorded image "%s", baked image "%s", secret file %d, mode "%s".', [PlanSatellite, PlanSetupFinished, PlanImage, BakedImage, Ord(NeedsSecretFile), RunMode]));
end;

// Reads setup-result.txt after the run. The script deletes it as its first act once the folder is accepted, so a
// killed run leaves none; a failure before that point may leave an earlier run's file, which is told by EXIT_CODE.
procedure ReadResultFile(const ExitCode: Integer);
var
  FileName, Recorded: String;
begin
  FileName := ChosenRoot + '\setup-result.txt';
  ResultFileRead := False;
  ResVocalisSteps := '';
  ResCertificateFile := '';
  ResFingerprint := '';
  ResFailure := '';
  ResLogFile := '';
  ResRunning := '';
  ResultNote := '';
  if FileExists(FileName) then
  begin
    Recorded := FileValue(FileName, 'EXIT_CODE');
    if Recorded = IntToStr(ExitCode) then
    begin
      ResVocalisSteps := FileValue(FileName, 'VOCALIS_STEPS');
      ResCertificateFile := FileValue(FileName, 'CERTIFICATE_FILE');
      ResFingerprint := FileValue(FileName, 'FINGERPRINT');
      ResFailure := FileValue(FileName, 'FAILURE');
      ResLogFile := FileValue(FileName, 'LOG_FILE');
      ResRunning := FileValue(FileName, 'RUNNING');
      ResultFileRead := True;
    end
    else
      Log(Format('%s records exit code "%s", this run exited %d; not used.', [FileName, Recorded, ExitCode]));
  end
  else
    Log(FileName + ' does not exist.');
  if (not ResultFileRead) and (ExitCode = 0) then
  begin
    // It should not happen: the finish page falls back to the plan for the certificate path and fingerprint.
    ResultNote := 'The summary of this run could not be read, so what is shown comes from the satellite''s own record.';
    if RunPlan(ChosenRoot, '') then
    begin
      ResCertificateFile := PlanCertificateFile;
      ResFingerprint := PlanFingerprint;
    end;
    ResVocalisSteps := 'maybe';
  end;
  Log(Format('Result: read %d, steps "%s", running "%s", certificate "%s", fingerprint present %d, failure "%s", log "%s".', [Ord(ResultFileRead), ResVocalisSteps, ResRunning, ResCertificateFile, Ord(ResFingerprint <> ''), ResFailure, ResLogFile]));
end;

// The pairing secret file is held open for the length of the script run, with a handle that lets other programs read the
// file but not write it, delete it or rename it (October 11, 2026: the tray program deletes a
// leftover secret file at its own start, and a tray icon started while a setup was running deleted the file under it).
// TFileStream with fmOpenRead (read access only) and fmShareDenyWrite opens the file for reading with the Windows share
// mode FILE_SHARE_READ and nothing else: the setup script and Docker Desktop, which only read the file, still can; a
// delete or a rename, from the tray program or from anything else, fails with a sharing violation until the handle is
// closed. (Windows only allows deleting a file that is open when every handle on it was opened with FILE_SHARE_DELETE,
// which the Pascal Script stream never asks for.) Returns nil, with the reason logged, when the file cannot be opened:
// the run then goes on unprotected and the script says so itself if the file is gone.
function HoldFileAgainstDeletion(const FileName: String): TFileStream;
begin
  Result := nil;
  try
    Result := TFileStream.Create(FileName, fmOpenRead or fmShareDenyWrite);
    Log('Holding the pairing secret file open (read sharing only, no delete sharing) for the length of the run.');
  except
    Result := nil;
    Log('Could not hold the pairing secret file open against deletion: ' + GetExceptionMessage);
  end;
end;

// Closes the hold, right after the script has exited and before the wizard's own delete of the file. Harmless when none is held.
procedure ReleaseSecretHold;
begin
  if SecretHold <> nil then
  begin
    SecretHold.Free;
    SecretHold := nil;
    Log('Released the hold on the pairing secret file.');
  end;
end;

// Runs the script once, hidden, with the moving-bar page, then deletes the secret file on every path.
procedure RunSatelliteSetup;
var
  Arguments, SecretPath: String;
  NeedsSecretFile: Boolean;
  Started: Cardinal;
  I: Integer;
begin
  SecretPath := ExpandConstant('{app}\' + SecretFileName);
  SetArrayLength(TailLines, 6);
  for I := 0 to 5 do TailLines[I] := '';
  Arguments := BuildScriptArguments(SecretPath, NeedsSecretFile);
  SetupRunning := True;
  WizardForm.CancelButton.Enabled := False;
  RunPage.Show;
  try
    RunPage.SetText('Starting setup...', '');
    if NeedsSecretFile then
    begin
      // Plain ASCII, no byte-order mark: the in-image tool requires that. Never logged.
      if SaveStringToFile(SecretPath, AnsiString(SecretValue), False) then
      begin
        Log('Wrote the pairing secret file just before the run.');
        SecretHold := HoldFileAgainstDeletion(SecretPath);
      end
      else
        Log('Could not write the pairing secret file.');
    end;
    Started := GetTickCount;
    ResultFileRead := False;
    SetupExitCode := 1;
    Log(Format('Running the installed satellite-setup.ps1 with: %s', [Arguments]));
    try
      if not ExecAndLogOutput(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File ' + Q(ExpandConstant('{app}\satellite-setup.ps1')) + ' ' + Arguments,
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, SetupExitCode, @OnSetupLine) then
      begin
        SetupExitCode := 1;
        Log('The setup script could not be started.');
      end;
    except
      SetupExitCode := 1;
      Log('The setup script run raised: ' + GetExceptionMessage);
    end;
    // The script has exited (or never started): the hold ends here, before the delete below.
    ReleaseSecretHold;
    Log(Format('Run finished: exit code %d after %d ms.', [SetupExitCode, GetTickCount - Started]));
  finally
    RunPage.Hide;
    ReleaseSecretHold;
    if FileExists(SecretPath) then
    begin
      DeleteFile(SecretPath);
      Log(Format('Pairing secret file deleted after the run; still there: %d.', [Ord(FileExists(SecretPath))]));
    end;
    SecretValue := '';
    PairSecret.Text := '';
    SetupRunning := False;
  end;
  SetupRan := True;
  ReadResultFile(SetupExitCode);
end;

// A copy of this setup program is installed for the maintenance modes. A download carries a Zone.Identifier stream,
// and a copy that keeps it makes Windows warn at each use, so the stream is removed from the copy.
procedure RemoveZoneIdentifier;
var
  Stream: String;
begin
  Stream := ExpandConstant('{app}\' + SetupCopyName) + ':Zone.Identifier';
  if DeleteFile(Stream) then
    Log('Removed the Zone.Identifier stream from the setup program copy.')
  else
    Log('The setup program copy has no Zone.Identifier stream, or it could not be removed.');
end;

// "Vocalis Satellite" appears in Windows Settings under Installed apps with Modify and Uninstall (Doug: "there should be
// an entry in the program so I can reinstall it or uninstall it"). Modify runs the installed copy in repair mode. Inno
// writes the uninstall key itself with NoModify=1, so the two values are written after it has finished, at the end of
// setup (ssDone) and again when the Finish page shows; in every mode. (Superseded reason, October 11, 2026: a
// maintenance run used to make Inno write its values again; since [Setup] Uninstallable=FullInstall Inno writes nothing
// in a maintenance mode, so in that mode this only rewrites the same two values in the key that is already there.)
procedure SetModifyEntry;
begin
  if RegWriteStringValue(HKCU, UninstallKey, 'ModifyPath', Q(ExpandConstant('{app}\' + SetupCopyName)) + ' /MODE=repair') and
     RegWriteDWordValue(HKCU, UninstallKey, 'NoModify', 0) then
    Log('Wrote the Modify entry (ModifyPath and NoModify=0) of the uninstall key.')
  else
    Log('Could not write the Modify entry of the uninstall key.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    PrepareChoices
  else if CurStep = ssPostInstall then
  begin
    if RunMode = '' then
    begin
      RemoveZoneIdentifier;
      WriteState;
    end;
    RunSatelliteSetup;
    StartTrayIcon;
  end
  else if CurStep = ssDone then
    SetModifyEntry;
end;

// Closing the window or choosing Cancel while the script runs would abandon a half-finished setup; the script resumes
// when run again, but the wizard does not offer to stop it.
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if SetupRunning then
  begin
    Cancel := False;
    Confirm := False;
    Log('Cancel refused while the setup script is running.');
  end;
end;

// ---- the Finish page ----

procedure FinShowFileClick(Sender: TObject);
begin
  ShowFileInExplorer(FinCertEdit.Text);
end;

procedure FinCopyPathClick(Sender: TObject);
begin
  CopyEditText(FinCertEdit);
end;

procedure FinOpenLogClick(Sender: TObject);
begin
  OpenInNotepad(ResLogFile);
end;

// Built once, hidden; positioned and filled when the Finish page shows (the main installer does the same with its links).
procedure CreateFinishControls;
begin
  FinCertLabel := TNewStaticText.Create(WizardForm.FinishedPage);
  FinCertLabel.Parent := WizardForm.FinishedPage;
  FinCertLabel.AutoSize := False;
  FinCertLabel.Visible := False;
  FinCertEdit := TNewEdit.Create(WizardForm.FinishedPage);
  FinCertEdit.Parent := WizardForm.FinishedPage;
  FinCertEdit.ReadOnly := True;
  FinCertEdit.Visible := False;
  FinShowFile := TNewButton.Create(WizardForm.FinishedPage);
  FinShowFile.Parent := WizardForm.FinishedPage;
  FinShowFile.Caption := 'Show the file';
  FinShowFile.OnClick := @FinShowFileClick;
  FinShowFile.Visible := False;
  FinCopyPath := TNewButton.Create(WizardForm.FinishedPage);
  FinCopyPath.Parent := WizardForm.FinishedPage;
  FinCopyPath.Caption := 'Copy the path';
  FinCopyPath.OnClick := @FinCopyPathClick;
  FinCopyPath.Visible := False;
  FinOpenLog := TNewButton.Create(WizardForm.FinishedPage);
  FinOpenLog.Parent := WizardForm.FinishedPage;
  FinOpenLog.Caption := 'Open the log';
  FinOpenLog.OnClick := @FinOpenLogClick;
  FinOpenLog.Visible := False;
  FinPrintLabel := TNewStaticText.Create(WizardForm.FinishedPage);
  FinPrintLabel.Parent := WizardForm.FinishedPage;
  FinPrintLabel.AutoSize := False;
  FinPrintLabel.Caption := 'Fingerprint (SHA-256):';
  FinPrintLabel.Visible := False;
  FinPrintEdit := TNewEdit.Create(WizardForm.FinishedPage);
  FinPrintEdit.Parent := WizardForm.FinishedPage;
  FinPrintEdit.ReadOnly := True;
  FinPrintEdit.Visible := False;
  FinMemo := TNewMemo.Create(WizardForm.FinishedPage);
  FinMemo.Parent := WizardForm.FinishedPage;
  FinMemo.ReadOnly := True;
  FinMemo.ScrollBars := ssVertical;
  FinMemo.WordWrap := True;
  FinMemo.Visible := False;
end;

// The text under the lead sentence, keyed on VOCALIS_STEPS (the script's own words for what is left to do in Vocalis).
procedure ShowFinishPage;
var
  Heading, Lead, Body, Reference, Reason: String;
  Y, Left, Width, I: Integer;
  ShowCertificate: Boolean;
begin
  if not SetupRan then Exit;
  Left := WizardForm.FinishedLabel.Left;
  Width := WizardForm.FinishedLabel.Width;
  Reference := 'The certificate, for reference:';
  Body := '';
  ShowCertificate := False;
  if SetupExitCode = 0 then
  begin
    Heading := 'Vocalis Satellite is ready';
    ShowCertificate := ResCertificateFile <> '';
    if ResRunning = 'no' then
      Lead := 'Setup finished, but the satellite is not running. Start it from the tray icon.'
    else
      Lead := 'The satellite is running.';
    if ResVocalisSteps = 'upload-and-tick' then
    begin
      Lead := Lead + ' One thing is left: give Vocalis its certificate.';
      Reference := 'Certificate file to upload:';
      Body := 'If your browser is on another computer, copy the file there first.' + Nl +
        'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite''s row. Then tick its card.';
    end
    else if ResVocalisSteps = 'upload' then
    begin
      Lead := Lead + ' One thing is left: give Vocalis the new certificate.';
      Reference := 'Certificate file to upload:';
      Body := 'If your browser is on another computer, copy the file there first.' + Nl +
        'In Vocalis: Settings, Satellites, "Upload certificate..." on this satellite''s row.';
    end
    else if ResVocalisSteps = 'none' then
      Lead := Lead + ' Nothing has to be done in Vocalis.'
    else
      Body := 'If this satellite is already set up in Vocalis, nothing more has to be done there.' + Nl +
        'If it is not (for example an earlier run stopped part way), two steps are left in Vocalis (Settings, Satellites): ' +
        '1. Upload the certificate file below on the satellite''s row ("Upload certificate..."); if your browser is on another computer, copy the file there first. ' +
        '2. Tick the satellite''s cards; they load as soon as you tick them.';
    if Body <> '' then Body := Body + Nl + Nl;
    Body := Body + 'The satellite''s icon is now in the notification area (Windows may keep it behind the arrow beside the clock).' + Nl +
      'If Vocalis cannot reach the satellite, see the "Network" section of the satellite guide (Start menu, Vocalis Satellite, Satellite guide).';
    if ResultNote <> '' then Body := Body + Nl + Nl + ResultNote;
  end
  else
  begin
    Heading := 'Setup did not finish';
    Lead := 'Setup did not finish.';
    Reason := '';
    if ResultFileRead and (ResFailure <> '') then
      Reason := ResFailure
    else
      for I := 0 to GetArrayLength(TailLines) - 1 do
        if Trim(TailLines[I]) <> '' then
        begin
          if Reason <> '' then Reason := Reason + Nl;
          Reason := Reason + TailLines[I];
        end;
    if Reason = '' then Reason := 'The setup script gave no reason (exit code ' + IntToStr(SetupExitCode) + ').';
    Body := Reason + Nl + Nl;
    if ResLogFile <> '' then Body := Body + 'The log of this run: ' + ResLogFile + Nl + Nl;
    Body := Body + 'The program files stay installed. Run this setup program again, or choose "Repair satellite" in the Start menu, and setup resumes; finished downloads are kept.';
  end;
  WizardForm.FinishedHeadingLabel.Caption := Heading;
  WizardForm.FinishedLabel.Caption := Lead;
  WizardForm.FinishedLabel.AdjustHeight;
  Y := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(10);
  if ShowCertificate then
  begin
    FinCertLabel.Caption := Reference;
    FinCertLabel.SetBounds(Left, Y, Width, ScaleY(16));
    FinCertLabel.Visible := True;
    Y := Y + ScaleY(18);
    FinCertEdit.Text := ResCertificateFile;
    FinCertEdit.SetBounds(Left, Y, Width, ScaleY(22));
    FinCertEdit.Visible := True;
    Y := Y + ScaleY(28);
    FinShowFile.SetBounds(Left, Y, ScaleX(110), ScaleY(26));
    FinShowFile.Visible := True;
    FinCopyPath.SetBounds(Left + ScaleX(118), Y, ScaleX(110), ScaleY(26));
    FinCopyPath.Visible := True;
    Y := Y + ScaleY(32);
    FinPrintLabel.SetBounds(Left, Y, Width, ScaleY(16));
    FinPrintLabel.Visible := True;
    Y := Y + ScaleY(18);
    FinPrintEdit.Text := ResFingerprint;
    FinPrintEdit.SetBounds(Left, Y, Width, ScaleY(22));
    FinPrintEdit.Visible := True;
    Y := Y + ScaleY(30);
  end;
  if (SetupExitCode <> 0) and (ResLogFile <> '') then
  begin
    FinOpenLog.SetBounds(Left, Y, ScaleX(110), ScaleY(26));
    FinOpenLog.Visible := True;
    Y := Y + ScaleY(32);
  end;
  FinMemo.Text := Body;
  FinMemo.SetBounds(Left, Y, Width, WizardForm.FinishedPage.Height - Y - ScaleY(6));
  FinMemo.Visible := True;
  Log(Format('Finish page: exit code %d, steps "%s", certificate shown %d, log button %d.', [SetupExitCode, ResVocalisSteps, Ord(ShowCertificate), Ord(FinOpenLog.Visible)]));
end;

// ---- uninstall ----

// Uninstall, in this order: close the tray icon (--exit, first), remove its start-with-Windows entry, delete a leftover
// pairing secret, run satellite-setup.ps1 -Remove on the recorded satellite folder before the files go (the container
// only; each Docker call inside the script is bounded by the script), then let Inno remove the files and shortcuts.
// The satellite folder and the image are never deleted: the last message names the folder and the command that
// removes the image. Docker not running is "skipped", with the command to run later.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir, StateFile, ScriptPath, Root, Image: String;
  Code: Integer;
  Started: Cardinal;
  TrayClosed: Boolean;
begin
  if CurUninstallStep = usUninstall then
  begin
    AppDir := ExpandConstant('{app}');
    StateFile := AppDir + '\' + StateFileName;
    ScriptPath := AppDir + '\satellite-setup.ps1';
    TrayClosed := CloseTrayIcon(AppDir);
    if RegDeleteValue(HKCU, RunKey, RunValueName) then
      Log('Removed the Run entry "' + RunValueName + '".')
    else
      Log('The Run entry "' + RunValueName + '" was not there.');
    DeleteLeftoverSecret(AppDir);
    Root := FileValue(StateFile, 'ROOT');
    Image := FileValue(StateFile, 'IMAGE');
    UninstallMessage := '{#AppName} was uninstalled.' + Nl + Nl;
    if not TrayClosed then
      UninstallMessage := UninstallMessage + 'The icon in the notification area could not be closed, so its program file may remain until you choose "Close this icon" in its menu (or end VocalisSatelliteTray.exe in Task Manager) and delete the program folder.' + Nl + Nl;
    if (Root <> '') and FileExists(Root + '\satellite.env') and FileExists(ScriptPath) then
    begin
      Started := GetTickCount;
      Code := -1;
      if ExecAndLogOutput(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File ' + Q(ScriptPath) + ' -Root ' + Q(Root) + ' -Remove -NoPrompt',
        AppDir, SW_HIDE, ewWaitUntilTerminated, Code, nil) then
      begin
        Log(Format('satellite-setup.ps1 -Remove exited with code %d after %d ms.', [Code, GetTickCount - Started]));
        if Code = 0 then
          UninstallMessage := UninstallMessage + 'The satellite''s container was removed.' + Nl + Nl
        else if (Code = 10) or (Code = 11) then
          UninstallMessage := UninstallMessage + 'Docker is not running, so the satellite''s container was skipped. Start Docker Desktop and run:' + Nl +
            '  docker ps -a --filter name=vocalis-satellite' + Nl + 'then remove the container it lists with docker rm -f <name>.' + Nl + Nl
        else
          UninstallMessage := UninstallMessage + 'The satellite''s container could not be removed (exit code ' + IntToStr(Code) + '). Find it with:' + Nl +
            '  docker ps -a --filter name=vocalis-satellite' + Nl + 'and remove it with docker rm -f <name>.' + Nl + Nl;
      end
      else
      begin
        Log('Could not start the container removal.');
        UninstallMessage := UninstallMessage + 'The satellite''s container could not be removed (the removal did not start). Find it with:' + Nl +
          '  docker ps -a --filter name=vocalis-satellite' + Nl + Nl;
      end;
    end
    else
    begin
      Log(Format('No container removal: recorded folder "%s", satellite.env present %d, script present %d.', [Root, Ord((Root <> '') and FileExists(Root + '\satellite.env')), Ord(FileExists(ScriptPath))]));
      UninstallMessage := UninstallMessage + 'The satellite''s container could not be looked up because the satellite folder is gone or was never recorded. If the container still exists, find it with:' + Nl +
        '  docker ps -a --filter name=vocalis-satellite' + Nl + Nl;
    end;
    if Root <> '' then
      UninstallMessage := UninstallMessage + 'The satellite folder was not deleted:' + Nl + '  ' + Root + Nl +
        'It holds the satellite''s secret, certificate and model files. Delete that folder yourself only when you no longer need it. If you run the setup program again, it offers this folder again so you can take the satellite over.' + Nl + Nl;
    if Image <> '' then
      UninstallMessage := UninstallMessage + 'The Docker image was not removed. To remove it:' + Nl + '  docker image rm ' + Image;
  end
  else if CurUninstallStep = usDone then
    SuppressibleMsgBox(UninstallMessage, mbInformation, MB_OK, IDOK);
end;
