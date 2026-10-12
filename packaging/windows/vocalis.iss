; Vocalis Windows installer (Inno Setup 6.7.3, the pinned Tools.InnoSetup package). The design went through
; fifteen review amendments (they win where they
; differ from the earlier text; amendment 15, October 10, 2026, supersedes the wsl.exe part of amendment 10). This is a per-user front end to the existing setup contract: it installs the
; package files, checks the prerequisites through `setup.ps1 -CheckOnly`, collects the data folder and the two
; ports, then opens a visible console that runs setup.ps1 (through vocalis-control.ps1 repair) so the image pull,
; the 62.5 GB model download (was 20 GB; see MinimumDataFolderBytes) and the hidden-input Taproom owner prompt happen in a real console. Passwords never
; pass through this wizard, a command line or the environment. The installer carries two image REFERENCES and no
; image bytes; nothing here pushes or publishes anything (repository policy).
;
; build-installer.ps1 supplies everything that varies through environment variables:
;   VOCALIS_INSTALLER_VERSION                 the full version, for example 12.0.0-M1 (AppVersion and file name)
;   VOCALIS_INSTALLER_VERSION_INFO            12.0.0.0 (VersionInfoVersion)
;   VOCALIS_INSTALLER_VOCALIS_IMAGE           name@sha256:<64 hex>, baked into installer-state.json
;   VOCALIS_INSTALLER_TAPROOM_IMAGE           name@sha256:<64 hex>, baked into installer-state.json
;   VOCALIS_INSTALLER_SIGNED_BUILD            "1" for a release build: SignTool=azurecodesign and a signed uninstaller
;   VOCALIS_INSTALLER_SIGNED_UNINSTALLER_DIR  where Inno keeps the signed uninstaller (signed builds only)

; The permanent AppId. Never change it: it is the uninstall key that upgrades and repairs find. The same GUID
; is used by [Code] for that key (packaging/tests/test_windows_installer.py asserts this is the only GUID).
#define AppGuid "BA5A7A32-DF39-4E07-AA26-73BD3AA65681"
#define AppName "Vocalis"
#define AppVersion GetEnv("VOCALIS_INSTALLER_VERSION")
#define VersionInfo GetEnv("VOCALIS_INSTALLER_VERSION_INFO")
#define VocalisImage GetEnv("VOCALIS_INSTALLER_VOCALIS_IMAGE")
#define TaproomImage GetEnv("VOCALIS_INSTALLER_TAPROOM_IMAGE")
#if GetEnv("VOCALIS_INSTALLER_SIGNED_BUILD") == "1"
  #define SignedUninstallerDir GetEnv("VOCALIS_INSTALLER_SIGNED_UNINSTALLER_DIR")
#endif

#if AppVersion == ""
  #error "VOCALIS_INSTALLER_VERSION must come from build-installer.ps1 (VERSION in source/vocalis/src/tts_utils.py)."
#endif
#if VersionInfo == ""
  #error "VOCALIS_INSTALLER_VERSION_INFO must come from build-installer.ps1."
#endif
#if VocalisImage == "" || TaproomImage == ""
  #error "VOCALIS_INSTALLER_VOCALIS_IMAGE and VOCALIS_INSTALLER_TAPROOM_IMAGE must come from build-installer.ps1."
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
DefaultDirName={localappdata}\Programs\Vocalis
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
; Section 5 lists the Welcome page as the wizard's first page, and Inno Setup 6.7 leaves it out unless told otherwise
; (DisableWelcomePage defaults to yes; the satellite setup program's feasibility probe of October 11, 2026 found the same
; with this compiler). October 11, 2026: turned on here. The default Welcome text is kept.
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputBaseFilename=Vocalis-Setup-{#AppVersion}-x64
LicenseFile=..\..\LICENSE
SetupIconFile=vocalis.ico
UninstallDisplayIcon={app}\vocalis.ico
; The wizard's own pictures are the Vocalis V too (October 11, 2026), the same files as the satellite
; setup program's; make_icon.py draws them at the sizes of Inno Setup 6.7.3's image areas at 100% through 250% scaling.
WizardSmallImageFile=vocalis-wizard-small-58.png,vocalis-wizard-small-77.png,vocalis-wizard-small-97.png,vocalis-wizard-small-116.png,vocalis-wizard-small-124.png,vocalis-wizard-small-143.png,vocalis-wizard-small-159.png
WizardImageFile=vocalis-wizard-large-202x386.png,vocalis-wizard-large-269x515.png,vocalis-wizard-large-336x643.png,vocalis-wizard-large-403x772.png,vocalis-wizard-large-430x824.png,vocalis-wizard-large-498x953.png,vocalis-wizard-large-534x1022.png
WizardStyle=modern
CloseApplications=no
SetupLogging=yes
Compression=lzma2
SolidCompression=yes
#if GetEnv("VOCALIS_INSTALLER_SIGNED_BUILD") == "1"
SignTool=azurecodesign
SignedUninstaller=yes
SignedUninstallerDir={#SignedUninstallerDir}
#endif

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut for Vocalis"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; Extracted to {tmp} at wizard time (ExtractTemporaryFile) and never installed: the prerequisite and port checks
; run setup.ps1 from there before anything is copied, and the version comparison runs vocalis-control.ps1 from
; there. Listed first because the installer is solid-compressed. windows-compose.ps1 (amendment 15) is dot-sourced at
; the top of both scripts, so it is extracted beside them wherever either runs from {tmp} (EnsureComposeHelper).
Source: "..\setup.ps1"; Flags: dontcopy noencryption
Source: "..\windows-compose.ps1"; Flags: dontcopy noencryption
Source: "vocalis-control.ps1"; Flags: dontcopy noencryption
; setup.sh reads compose.yaml, compose.cuda.yaml and compose.rocm.yaml from its own folder and selects the overlay.
Source: "..\compose.yaml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\compose.cuda.yaml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\compose.rocm.yaml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\setup.sh"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\setup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\windows-compose.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
; The repository LICENSE is the only licence file installed (the images carry their own notices).
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "vocalis.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "vocalis-control.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The Vocalis and Taproom shortcuts are .url files written by [Code] once the ports are known.
Name: "{group}\Start Vocalis"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\vocalis-control.ps1"" -Action start"; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "Start the Vocalis and Taproom containers"
Name: "{group}\Stop Vocalis"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\vocalis-control.ps1"" -Action stop"; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "Stop the Vocalis and Taproom containers"
Name: "{group}\Repair setup"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\vocalis-control.ps1"" -Action repair -PauseAtEnd"; WorkingDir: "{app}"; IconFilename: "{app}\vocalis.ico"; Comment: "Rerun setup for this instance; finished downloads are kept"

[Registry]
; Where this installation's data folder is, so an upgrade, a repair and the uninstaller find it. The writer of
; installer-state.json (WriteInstallerState) and this value come from the same variable. The key is deliberately
; NOT deleted on uninstall (October 9, 2026; it had the uninsdeletekey flag): the uninstaller keeps the data
; folder, and the next install reads this value to offer that folder again, so a reinstall adopts it (and its
; models) instead of downloading 62.5 GB again. ExistingInstance stays tied to the uninstall key, not to this one.
Root: HKCU; Subkey: "Software\Vocalis\Installer"; ValueType: string; ValueName: "DataFolder"; ValueData: "{code:GetDataFolder}"

[Run]
; The Finish page's "Open Vocalis now" box (checked): always the plain Vocalis address, which the server redirects
; to /setup for an uninitialized store (amendment 7). Shown only when setup succeeded.
Filename: "{code:GetVocalisUrl}"; Description: "Open Vocalis now"; Flags: postinstall shellexec nowait skipifsilent; Check: OfferOpenVocalis

[UninstallDelete]
; Files that [Code] writes after the copy. The data folder, its stores and the images are never touched.
Type: files; Name: "{app}\installer-state.json"
Type: files; Name: "{group}\Vocalis.url"
Type: files; Name: "{group}\Taproom.url"
Type: files; Name: "{userdesktop}\Vocalis.url"
Type: dirifempty; Name: "{group}"
Type: dirifempty; Name: "{app}"

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppGuid}}_is1';
  InstallerKey = 'Software\Vocalis\Installer';
  // These must equal the defaults in setup.sh and setup.ps1 (packaging/tests/test_windows_installer.py compares).
  DefaultVocalisPort = '18770';
  DefaultTaproomPort = '18771';
  // The data folder drive needs the models (about 62.5 GB) plus the fetcher's 1 GiB margin; Docker's own disk
  // needs about 75 GB for the two images (shown, not measured: it lives wherever Docker Desktop keeps it).
  // October 11, 2026: 42,531,269,218 bytes installed (the locks, with the two DFN3 members counted as installed)
  // plus 1,073,741,824 is 43,605,011,042, rounded up to 43,700,000,000. Was 20.3 GB and 21,500,000,000 before the
  // HTDemucs, Lead Vocal and ACE-Step XL SFT model files (2,245,772,054 and 19,953,387,374 bytes) joined the downloads.
  // Later the same day the ACE-Step XL Base model (19,953,388,010 bytes: Extract, Replace and Complete run only
  // on it) joined too: 62,484,657,228 bytes installed plus 1,073,741,824 is 63,558,399,052, rounded up.
  MinimumDataFolderBytes = 63600000000;
  GpuVariant = 'cuda';
  BakedVocalisImage = '{#VocalisImage}';
  BakedTaproomImage = '{#TaproomImage}';
  AppVersionText = '{#AppVersion}';

var
  PrereqPage: TWizardPage;
  PrereqNote: TNewStaticText;
  PrereqMemo: TNewMemo;
  PrereqStatus: TNewStaticText;
  PrereqRetry: TNewButton;
  PrereqPassed: Boolean;
  DataPage: TInputDirWizardPage;
  PortsPage: TInputQueryWizardPage;
  ResultPage: TOutputMsgWizardPage;
  VocalisLink: TNewLinkLabel;
  TaproomLink: TNewLinkLabel;
  // An instance already installed here (the saved data folder holds instance.env): upgrade or repair.
  ExistingInstance: Boolean;
  // Vocalis itself is registered as installed (the uninstall key exists), whether or not its data folder is intact.
  InstalledHere: Boolean;
  // The data folder remembered by the last install (HKCU\Software\Vocalis\Installer\DataFolder). It survives an
  // uninstall, so it is read whether or not Vocalis is installed.
  SavedRoot: String;
  // Model reuse (October 9, 2026): when a different data folder is chosen and the remembered one holds models, its
  // path, recorded in installer-state.json as seedModels so setup copies the verified files instead of downloading.
  SeedModelsFolder: String;
  InstalledVersionText: String;
  // The chosen data folder already holds instance.env (adopting an instance after an uninstall).
  UseExistingFolder: Boolean;
  // True when no instance.env existed before this run: the Finish page then carries the pairing guidance.
  FirstRun: Boolean;
  ChosenRoot: String;
  ChosenVocalisPort: Integer;
  ChosenTaproomPort: Integer;
  SetupExitCode: Integer;
  SetupWasRun: Boolean;
  // Uninstall: what the final page says.
  UninstallMessage: String;
  // windows-compose.ps1 has been extracted to {tmp} (it is needed beside setup.ps1 and vocalis-control.ps1 there).
  ComposeHelperExtracted: Boolean;

function GetDriveType(lpRootPathName: String): Cardinal;
  external 'GetDriveTypeW@kernel32.dll stdcall';

function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function DefaultDataFolder: String;
begin
  Result := ExpandConstant('{localappdata}\VocalisDocker\instance');
end;

// instance.env as setup.sh reads it: NAME=value, a single-quoted value unquoted.
function ReadEnvValue(const FileName, Key: String): String;
var
  Lines: TArrayOfString;
  I, P: Integer;
  Line: String;
begin
  Result := '';
  if not LoadStringsFromFile(FileName, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Lines[I];
    P := Pos('=', Line);
    if (P > 1) and (Copy(Line, 1, P - 1) = Key) then
    begin
      Result := Copy(Line, P + 1, Length(Line));
      if (Length(Result) >= 2) and (Result[1] = '''') and (Result[Length(Result)] = '''') then
        Result := Copy(Result, 2, Length(Result) - 2);
      Exit;
    end;
  end;
end;

function DirIsEmpty(const Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := True;
  if FindFirst(Dir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Result := False;
          Break;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
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

// ---- JSON for installer-state.json: ASCII only, so PowerShell reads it the same under any code page ----
function HexDigits4(Value: Integer): String;
var
  Digits: String;
begin
  Digits := '0123456789abcdef';
  Result := Copy(Digits, ((Value shr 12) and 15) + 1, 1) + Copy(Digits, ((Value shr 8) and 15) + 1, 1) +
    Copy(Digits, ((Value shr 4) and 15) + 1, 1) + Copy(Digits, (Value and 15) + 1, 1);
end;

function JsonString(const Text: String): String;
var
  I, Code: Integer;
  C: Char;
begin
  Result := '"';
  for I := 1 to Length(Text) do
  begin
    C := Text[I];
    Code := Ord(C);
    if C = '\' then
      Result := Result + '\\'
    else if C = '"' then
      Result := Result + '\"'
    else if (Code < 32) or (Code > 126) then
      Result := Result + '\u' + HexDigits4(Code)
    else
      Result := Result + C;
  end;
  Result := Result + '"';
end;

// setup.ps1 and vocalis-control.ps1 dot-source windows-compose.ps1 from their own folder (amendment 15), so it is
// extracted to {tmp} before either runs from there: -CheckOnly and -CheckPorts (setup.ps1) and compare-version
// (vocalis-control.ps1). Once only, however many of those happen in one run.
procedure EnsureComposeHelper;
begin
  if not ComposeHelperExtracted then
  begin
    ExtractTemporaryFile('windows-compose.ps1');
    ComposeHelperExtracted := True;
  end;
end;

// Runs a script from {tmp} with Windows PowerShell hidden, its output redirected by cmd.exe to a file, and waits
// for it (Exec with ewWaitUntilTerminated keeps the wizard repainting). Each check inside setup.ps1 is bounded to
// 60 seconds by setup.ps1 itself, so the wait is bounded too. Returns False when the script could not be started.
function RunHiddenScript(const ScriptName, ScriptArguments, OutFile: String; var Output: String): Boolean;
var
  CommandLine: String;
  ResultCode: Integer;
  Started: Cardinal;
  Raw: AnsiString;
begin
  Result := False;
  Output := '';
  DeleteFile(OutFile);
  CommandLine := '/D /C ""' + PowerShellExe + '" -NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}') + '\' + ScriptName + '" ' + ScriptArguments + ' > "' + OutFile + '" 2>&1"';
  Log(Format('Running %s %s hidden.', [ScriptName, ScriptArguments]));
  Started := GetTickCount;
  if not Exec(ExpandConstant('{cmd}'), CommandLine, ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Log(Format('Could not start %s: %s', [ScriptName, SysErrorMessage(ResultCode)]));
    Exit;
  end;
  if LoadStringFromFile(OutFile, Raw) then Output := String(Raw);
  Log(Format('%s exited with code %d after %d ms; %d characters of output.', [ScriptName, ResultCode, GetTickCount - Started, Length(Output)]));
  Result := True;
end;

procedure RunPrerequisiteChecks;
var
  Output: String;
begin
  PrereqPassed := False;
  PrereqStatus.Caption := 'Checking Docker Desktop, WSL and the NVIDIA runtime. This can take a minute...';
  PrereqMemo.Lines.Text := '';
  PrereqRetry.Enabled := False;
  WizardForm.NextButton.Enabled := False;
  WizardForm.BackButton.Enabled := False;
  WizardForm.CancelButton.Enabled := False;
  try
    if RunHiddenScript('setup.ps1', '-CheckOnly', ExpandConstant('{tmp}\vocalis-prereq.txt'), Output) then
    begin
      PrereqMemo.Lines.Text := Output;
      PrereqPassed := Pos('Prerequisites: all checks passed.', Output) > 0;
    end
    else
      PrereqMemo.Lines.Text := 'The checks did not finish. Docker Desktop or WSL is not answering. Start Docker Desktop, wait until it says the engine is running, and choose Retry.';
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
  Log(Format('Prerequisite checks passed: %d.', [Ord(PrereqPassed)]));
end;

procedure PrereqRetryClick(Sender: TObject);
begin
  RunPrerequisiteChecks;
end;

// True when the text holds a carriage return or a line feed.
function HasLineBreak(const Text: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to Length(Text) do
    if (Text[I] = #10) or (Text[I] = #13) then Result := True;
end;

// Returns '' when Dir is usable, else the reason. UseExisting is set when Dir already holds instance.env.
function ValidateDataFolder(const Dir: String; var UseExisting: Boolean): String;
var
  Free, Total: Int64;
  AppDir: String;
begin
  Result := '';
  UseExisting := False;
  if (Pos('''', Dir) > 0) or HasLineBreak(Dir) then
    Result := 'The data folder path cannot contain an apostrophe or a line break: setup.sh quotes the path in single quotes and refuses it.'
      + #13#10 + 'If the default folder under your user profile contains an apostrophe, choose another folder, for example on another drive.'
  else if (Length(Dir) < 4) or (Dir[2] <> ':') or (Dir[3] <> '\') then
    Result := 'Enter a full path that starts with a drive letter, for example E:\Vocalis. A whole drive cannot be used; choose a folder on it.'
  else if GetDriveType(Copy(Dir, 1, 3)) = 4 then
    Result := 'A network drive cannot be used: the data folder holds SQLite stores and the models, which need a local drive.'
  else
  begin
    AppDir := WizardDirValue;
    if (CompareText(Dir, RemoveBackslashUnlessRoot(AppDir)) = 0) or
       (Pos(Lowercase(RemoveBackslashUnlessRoot(AppDir) + '\'), Lowercase(Dir + '\')) = 1) then
      Result := 'The data folder cannot be inside the Vocalis program folder (' + AppDir + '); uninstalling would remove it from under you.'
    else if FileExists(Dir + '\instance.env') then
      UseExisting := True
    else if DirExists(Dir) and (not DirIsEmpty(Dir)) then
      Result := 'The folder is not empty and has no instance.env. Choose an empty or new folder, or an existing Vocalis data folder (one that holds instance.env).'
    else if GetSpaceOnDisk64(ExtractFileDrive(Dir) + '\', Free, Total) then
    begin
      if Free < MinimumDataFolderBytes then
        Result := 'The data folder needs about 62.5 GB for the model files plus 1 GiB of margin, and ' + ExtractFileDrive(Dir) + ' has only ' + GigabytesText(Free) + ' free.';
    end
    else
      Result := 'The free space on ' + ExtractFileDrive(Dir) + ' could not be read. Choose a folder on a drive that exists.';
  end;
end;

function SuggestedPortsFrom(const Output: String; var Vocalis, Taproom: Integer): Boolean;
var
  Marker, Rest: String;
  P: Integer;
begin
  Result := False;
  Marker := 'Suggested ports: ';
  P := Pos(Marker, Output);
  if P = 0 then Exit;
  Rest := Copy(Output, P + Length(Marker), Length(Output));
  P := Pos(' ', Rest);
  if P < 2 then Exit;
  Vocalis := StrToIntDef(Copy(Rest, 1, P - 1), 0);
  Rest := Copy(Rest, P + 1, Length(Rest));
  P := 1;
  while (P <= Length(Rest)) and (Rest[P] >= '0') and (Rest[P] <= '9') do P := P + 1;
  Taproom := StrToIntDef(Copy(Rest, 1, P - 1), 0);
  Result := (Vocalis >= 1024) and (Taproom >= 1024);
end;

function FailLines(const Output: String): String;
var
  Text, Line: String;
  P: Integer;
begin
  Result := '';
  Text := Output;
  while Length(Text) > 0 do
  begin
    P := Pos(#10, Text);
    if P = 0 then
    begin
      Line := Text;
      Text := '';
    end
    else
    begin
      Line := Copy(Text, 1, P - 1);
      Text := Copy(Text, P + 1, Length(Text));
    end;
    Line := Trim(Line);
    if Copy(Line, 1, 4) = 'FAIL' then Result := Result + Line + #13#10;
  end;
end;

// The ports page: numeric, in range, distinct, then the Windows bind check through setup.ps1 -CheckPorts (the
// same check a real setup runs). A busy pair offers the next free pair.
function ValidatePorts: Boolean;
var
  VocalisPort, TaproomPort, SuggestedVocalis, SuggestedTaproom: Integer;
  Output: String;
begin
  Result := False;
  VocalisPort := StrToIntDef(Trim(PortsPage.Values[0]), 0);
  TaproomPort := StrToIntDef(Trim(PortsPage.Values[1]), 0);
  if (VocalisPort < 1024) or (VocalisPort > 65535) or (TaproomPort < 1024) or (TaproomPort > 65535) then
  begin
    MsgBox('Each port must be a number from 1024 through 65535.', mbError, MB_OK);
    Exit;
  end;
  if VocalisPort = TaproomPort then
  begin
    MsgBox('The Vocalis and Taproom ports must be different.', mbError, MB_OK);
    Exit;
  end;
  if not RunHiddenScript('setup.ps1', Format('-CheckPorts -VocalisPort %d -TaproomPort %d', [VocalisPort, TaproomPort]),
    ExpandConstant('{tmp}\vocalis-ports.txt'), Output) then
  begin
    // setup.ps1 bind-tests the new instance's ports again before it hands them to setup.sh, so a check that
    // could not run is logged and does not block the wizard.
    Log('The port check could not run; setup.ps1 will test the ports itself.');
    Result := True;
    Exit;
  end;
  if Pos('Ports: OK', Output) > 0 then
  begin
    Result := True;
    Exit;
  end;
  if SuggestedPortsFrom(Output, SuggestedVocalis, SuggestedTaproom) then
  begin
    if MsgBox('These ports cannot be used on Windows:' + #13#10#13#10 + FailLines(Output) + #13#10 +
      'Use ' + IntToStr(SuggestedVocalis) + ' (Vocalis) and ' + IntToStr(SuggestedTaproom) + ' (Taproom) instead?',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      PortsPage.Values[0] := IntToStr(SuggestedVocalis);
      PortsPage.Values[1] := IntToStr(SuggestedTaproom);
    end;
  end
  else
    MsgBox('These ports cannot be used on Windows, and no free pair was found nearby:' + #13#10#13#10 + FailLines(Output)
      + #13#10 + 'Enter other ports.', mbError, MB_OK);
end;

// Decides how this installer orders against an installed copy (design amendment 2) by running the control script's
// compare-version action from {tmp}, so the rule has one implementation, which has its own tests. Exit code 42
// means the installed version is higher: refuse. Anything else (including a failure to run) is logged and allowed.
function InstalledVersionIsNewer(const Installed: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  EnsureComposeHelper;
  ExtractTemporaryFile('vocalis-control.ps1');
  if Exec(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\vocalis-control.ps1') +
    '" -Action compare-version -InstalledVersion "' + Installed + '" -NewVersion "' + AppVersionText + '"',
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Log(Format('Version comparison: installed %s, this installer %s, control script exit code %d.', [Installed, AppVersionText, ResultCode]));
    Result := ResultCode = 42;
  end
  else
    Log('The version comparison could not run; continuing.');
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  SetupExitCode := 0;
  // Read first and always: an uninstall keeps this value so the data folder can be offered again (October 9, 2026).
  if not RegQueryStringValue(HKCU, InstallerKey, 'DataFolder', SavedRoot) then
    SavedRoot := '';
  if RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', InstalledVersionText) then
  begin
    InstalledHere := True;
    ExistingInstance := (SavedRoot <> '') and FileExists(SavedRoot + '\instance.env');
    Log(Format('Installed Vocalis %s found; saved data folder "%s"; instance.env present: %d.', [InstalledVersionText, SavedRoot, Ord(ExistingInstance)]));
    if InstalledVersionIsNewer(InstalledVersionText) then
    begin
      SuppressibleMsgBox('Vocalis ' + InstalledVersionText + ' is already installed, and it is newer than this installer (' + AppVersionText + ').' + #13#10#13#10 +
        'Setup does not roll an instance back to an older version. Uninstall Vocalis first (your data folder is kept), then run this installer to adopt that data folder.',
        mbError, MB_OK, IDOK);
      Result := False;
    end;
  end
  else
    Log(Format('No installed Vocalis found: first install; remembered data folder "%s", present: %d.', [SavedRoot, Ord((SavedRoot <> '') and DirExists(SavedRoot))]));
end;

// A click on one of the Finish page's address links opens that address in the default browser.
procedure OpenAddress(Sender: TObject; const Link: String; LinkType: TSysLinkType);
var
  ErrorCode: Integer;
begin
  ShellExec('open', Link, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

// The header picture's place (wizard-header-picture.iss, shared with the other setup program).
#include "wizard-header-picture.iss"

procedure InitializeWizard;
begin
  PlaceHeaderPicture;
  EnsureComposeHelper;
  ExtractTemporaryFile('setup.ps1');

  // Prerequisites (amendment 8: one owner, setup.ps1 -CheckOnly).
  PrereqPage := CreateCustomPage(wpLicense, 'Prerequisites',
    'Vocalis needs Docker Desktop, WSL with Docker integration, and an NVIDIA GPU runtime.');
  PrereqNote := TNewStaticText.Create(PrereqPage);
  PrereqNote.Parent := PrereqPage.Surface;
  PrereqNote.AutoSize := False;
  PrereqNote.WordWrap := True;
  PrereqNote.Left := 0;
  PrereqNote.Top := 0;
  PrereqNote.Width := PrereqPage.SurfaceWidth;
  PrereqNote.Height := ScaleY(48);
  PrereqNote.Caption := 'Space needed: about 75 GB in Docker''s disk for the two images, plus about 62.5 GB of model files in the data folder (' +
    FreeSpaceText(DefaultDataFolder) + '; the data folder page checks the drive you choose). ' +
    'Installing Docker, drivers or WSL is never automatic; this page tells you what to fix.';
  PrereqMemo := TNewMemo.Create(PrereqPage);
  PrereqMemo.Parent := PrereqPage.Surface;
  PrereqMemo.Left := 0;
  PrereqMemo.Top := PrereqNote.Height + ScaleY(8);
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

  // Data folder (first install only).
  DataPage := CreateInputDirPage(PrereqPage.ID, 'Data folder',
    'Where should Vocalis keep its data?',
    'Vocalis stores its databases, caches, model files and logs in one folder. Choose an empty or new folder on a local drive with enough space, ' +
    'or the data folder of an earlier Vocalis installation to reuse it.', False, '');
  DataPage.Add('');
  // A first install whose setup failed before writing instance.env still saved its data folder: offer it again
  // rather than the default, so a rerun lands where the user chose. After an uninstall (Vocalis no longer
  // registered) the remembered folder is offered when it still exists; choosing it adopts the instance through
  // the existing-folder path of ValidateDataFolder (instance.env present), models and all.
  if (SavedRoot <> '') and (InstalledHere or DirExists(SavedRoot)) then
    DataPage.Values[0] := SavedRoot
  else
    DataPage.Values[0] := DefaultDataFolder;

  // Ports (first install only).
  PortsPage := CreateInputQueryPage(DataPage.ID, 'Ports',
    'Which local ports should Vocalis and Taproom use?',
    'Both pages listen only on this computer (127.0.0.1). Change a port only if another program already uses it.');
  PortsPage.Add('Vocalis port:', False);
  PortsPage.Add('Taproom port:', False);
  PortsPage.Values[0] := DefaultVocalisPort;
  PortsPage.Values[1] := DefaultTaproomPort;

  // Shown only when setup did not finish (amendment 6: no log claim).
  ResultPage := CreateOutputMsgPage(wpInstalling, 'Setup did not finish',
    'Vocalis is installed, but its setup did not finish.', '');

  // The Finish page's addresses, as clickable links (positioned in CurPageChanged).
  VocalisLink := TNewLinkLabel.Create(WizardForm.FinishedPage);
  VocalisLink.Parent := WizardForm.FinishedPage;
  VocalisLink.Visible := False;
  TaproomLink := TNewLinkLabel.Create(WizardForm.FinishedPage);
  TaproomLink.Parent := WizardForm.FinishedPage;
  TaproomLink.Visible := False;
  VocalisLink.OnLinkClick := @OpenAddress;
  TaproomLink.OnLinkClick := @OpenAddress;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = DataPage.ID then
    Result := ExistingInstance
  else if PageID = PortsPage.ID then
    Result := ExistingInstance or UseExistingFolder
  else if PageID = ResultPage.ID then
    Result := SetupExitCode = 0;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
  Dir: String;
begin
  Result := True;
  if CurPageID = DataPage.ID then
  begin
    Dir := RemoveBackslashUnlessRoot(Trim(DataPage.Values[0]));
    Problem := ValidateDataFolder(Dir, UseExistingFolder);
    if Problem <> '' then
    begin
      MsgBox(Problem, mbError, MB_OK);
      UseExistingFolder := False;
      Result := False;
    end
    else
    begin
      DataPage.Values[0] := Dir;
      Log(Format('Data folder "%s" accepted; holds instance.env: %d.', [Dir, Ord(UseExistingFolder)]));
    end;
  end
  else if CurPageID = PortsPage.ID then
    Result := ValidatePorts;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Text: String;
begin
  if CurPageID = PrereqPage.ID then
  begin
    if PrereqPassed then
      WizardForm.NextButton.Enabled := True
    else
      RunPrerequisiteChecks;
  end
  else if CurPageID = ResultPage.ID then
  begin
    // 19 (design amendment 15): setup itself finished, and only starting the services from Windows failed.
    if SetupExitCode = 19 then
      ResultPage.MsgLabel.Caption := 'Setup finished, but the services could not be started; the setup window showed the reason (code 19). Vocalis''s files are installed.'
        + #13#10#13#10 + 'Choose "Start Vocalis" in the Start menu to try again. If that also fails, choose "Repair setup".'
    else
      ResultPage.MsgLabel.Caption := 'The setup window showed the reason (setup exited with code ' + IntToStr(SetupExitCode) + '). Vocalis''s files are installed.'
        + #13#10#13#10 + 'To resume, run this installer again or choose "Repair setup" in the Start menu. Downloads that already finished are kept.';
  end
  else if CurPageID = wpFinished then
  begin
    if SetupExitCode = 0 then
    begin
      if FirstRun then
        Text := 'Vocalis and Taproom are installed and running.' + #13#10#13#10 +
          'Pairing: PENDING. After both vaults are initialized, copy the Vocalis pairing token into the Vocalis extension settings in Taproom and verify a short narration.'
      else
        Text := 'Vocalis was installed over the existing instance, and its services are running. Pairing status was not changed by this installer.';
      WizardForm.FinishedLabel.Caption := Text + #13#10#13#10 + 'Addresses (also in the Start menu):';
      WizardForm.FinishedLabel.AdjustHeight;
      VocalisLink.Caption := 'Vocalis: <a href="http://127.0.0.1:' + IntToStr(ChosenVocalisPort) + '">http://127.0.0.1:' + IntToStr(ChosenVocalisPort) + '</a>';
      VocalisLink.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(8);
      VocalisLink.Left := WizardForm.FinishedLabel.Left;
      VocalisLink.Visible := True;
      TaproomLink.Caption := 'Taproom: <a href="http://127.0.0.1:' + IntToStr(ChosenTaproomPort) + '">http://127.0.0.1:' + IntToStr(ChosenTaproomPort) + '</a>';
      TaproomLink.Top := VocalisLink.Top + VocalisLink.Height + ScaleY(6);
      TaproomLink.Left := WizardForm.FinishedLabel.Left;
      TaproomLink.Visible := True;
      WizardForm.RunList.Top := TaproomLink.Top + TaproomLink.Height + ScaleY(14);
    end
    else if SetupExitCode = 19 then
    begin
      WizardForm.FinishedLabel.Caption := 'Vocalis is installed and set up, but its services could not be started (exit code 19).' + #13#10#13#10 +
        'Choose "Start Vocalis" in the Start menu to try again; if that also fails, choose "Repair setup".';
      WizardForm.FinishedLabel.AdjustHeight;
    end
    else
    begin
      WizardForm.FinishedLabel.Caption := 'Vocalis is installed, but its setup did not finish (exit code ' + IntToStr(SetupExitCode) + ').' + #13#10#13#10 +
        'Run this installer again or choose "Repair setup" in the Start menu to resume; finished downloads are kept.';
      WizardForm.FinishedLabel.AdjustHeight;
    end;
  end;
end;

// What the Ready page lists.
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'Install Vocalis ' + AppVersionText + ' into:' + NewLine + Space + WizardDirValue + NewLine + NewLine;
  if ExistingInstance then
    Result := Result + 'Existing instance (kept: data folder, identity and ports):' + NewLine + Space + SavedRoot + NewLine +
      Space + 'Setup will rerun or update it (finished downloads are kept).' + NewLine
  else if UseExistingFolder then
    Result := Result + 'Reuse the Vocalis data folder:' + NewLine + Space + DataPage.Values[0] + NewLine +
      Space + 'Setup will rerun or update it (finished downloads are kept).' + NewLine
  else
    Result := Result + 'New data folder:' + NewLine + Space + DataPage.Values[0] + NewLine +
      'Ports:' + NewLine + Space + 'Vocalis ' + PortsPage.Values[0] + ', Taproom ' + PortsPage.Values[1] + NewLine +
      Space + 'Setup then downloads about 62.5 GB of models (the images are pulled only if not already on this computer).' + NewLine;
  if MemoTasksInfo <> '' then Result := Result + NewLine + MemoTasksInfo + NewLine;
end;

function GetDataFolder(Param: String): String;
begin
  Result := ChosenRoot;
end;

function GetVocalisUrl(Param: String): String;
begin
  Result := 'http://127.0.0.1:' + IntToStr(ChosenVocalisPort);
end;

function SetupSucceeded: Boolean;
begin
  Result := SetupWasRun and (SetupExitCode = 0);
end;

// The Finish page's "Open Vocalis now" entry. Test seam (packaging/windows/tests/drive_installer.ps1 sets it):
// a test runs this installer on a hidden desktop, where a browser it opened would appear on the visible one.
function OfferOpenVocalis: Boolean;
begin
  Result := SetupSucceeded and (GetEnv('VOCALIS_INSTALLER_TEST_NO_BROWSER') <> '1');
end;

// Settles root, ports and run mode before the copy (the [Registry] value reads ChosenRoot).
procedure PrepareChoices;
var
  EnvFile: String;
begin
  if ExistingInstance then
    ChosenRoot := SavedRoot
  else
    ChosenRoot := RemoveBackslashUnlessRoot(Trim(DataPage.Values[0]));
  EnvFile := ChosenRoot + '\instance.env';
  FirstRun := not FileExists(EnvFile);
  if FileExists(EnvFile) then
  begin
    // An existing instance keeps its ports (setup.sh refuses a change), so the shortcuts use the saved ones.
    ChosenVocalisPort := StrToIntDef(ReadEnvValue(EnvFile, 'VOCALIS_PORT'), StrToInt(DefaultVocalisPort));
    ChosenTaproomPort := StrToIntDef(ReadEnvValue(EnvFile, 'TAPROOM_PORT'), StrToInt(DefaultTaproomPort));
  end
  else
  begin
    ChosenVocalisPort := StrToIntDef(Trim(PortsPage.Values[0]), StrToInt(DefaultVocalisPort));
    ChosenTaproomPort := StrToIntDef(Trim(PortsPage.Values[1]), StrToInt(DefaultTaproomPort));
  end;
  Log(Format('Choices: data folder "%s", Vocalis port %d, Taproom port %d, first run %d.', [ChosenRoot, ChosenVocalisPort, ChosenTaproomPort, Ord(FirstRun)]));
  // Model reuse (October 9, 2026): a different folder was chosen and the remembered one still holds models, so
  // setup may copy the verified files from it. The registry value is rewritten from ChosenRoot after this, which
  // is why it is read in InitializeSetup and kept here. setup.ps1 splits -SeedModels on ';', so a folder whose
  // name has one cannot be passed and is not recorded; everything else (existence, symlinks, odd characters,
  // the hash of every file) is judged by setup.sh and the fetcher.
  SeedModelsFolder := '';
  if (SavedRoot <> '') and (CompareText(RemoveBackslashUnlessRoot(SavedRoot), ChosenRoot) <> 0) and DirExists(SavedRoot + '\models\vocalis') then
  begin
    if Pos(';', SavedRoot) > 0 then
      Log(Format('Previous data folder "%s" holds models but its name contains a semicolon; not offered for reuse.', [SavedRoot]))
    else
    begin
      SeedModelsFolder := SavedRoot;
      Log(Format('Previous data folder "%s" holds models; recorded as seedModels so setup can reuse them.', [SeedModelsFolder]));
    end;
  end
  else
    Log(Format('No previous data folder to reuse models from (remembered "%s").', [SavedRoot]));
end;

// installer-state.json (amendment 3): the single record vocalis-control.ps1 reads. The baked references and the
// version are fixed per installer; the root and ports are this installation's.
procedure WriteInstallerState;
var
  Json: String;
begin
  Json := '' + '{' + #13#10 +
    '  "version": ' + JsonString(AppVersionText) + ',' + #13#10 +
    '  "root": ' + JsonString(ChosenRoot) + ',' + #13#10 +
    '  "variant": ' + JsonString(GpuVariant) + ',' + #13#10 +
    '  "vocalisImage": ' + JsonString(BakedVocalisImage) + ',' + #13#10 +
    '  "taproomImage": ' + JsonString(BakedTaproomImage) + ',' + #13#10 +
    '  "vocalisPort": ' + IntToStr(ChosenVocalisPort) + ',' + #13#10 +
    '  "taproomPort": ' + IntToStr(ChosenTaproomPort);
  // Optional: only when the previous data folder holds models worth reusing (vocalis-control.ps1 passes it on
  // as setup.ps1 -SeedModels). Its absence is the ordinary case, so it is not in the control script's required list.
  if SeedModelsFolder <> '' then
    Json := Json + ',' + #13#10 + '  "seedModels": ' + JsonString(SeedModelsFolder);
  Json := Json + #13#10 + '}' + #13#10;
  if SaveStringToFile(ExpandConstant('{app}\installer-state.json'), AnsiString(Json), False) then
    Log('Wrote installer-state.json.')
  else
    Log('Could not write installer-state.json.');
end;

procedure WriteUrlFile(const FileName, Url: String);
begin
  if not SaveStringToFile(FileName, AnsiString('[InternetShortcut]' + #13#10 + 'URL=' + Url + #13#10 +
    'IconFile=' + ExpandConstant('{app}\vocalis.ico') + #13#10 + 'IconIndex=0' + #13#10), False) then
    Log('Could not write ' + FileName);
end;

procedure WriteShortcuts;
begin
  ForceDirectories(ExpandConstant('{group}'));
  WriteUrlFile(ExpandConstant('{group}\Vocalis.url'), 'http://127.0.0.1:' + IntToStr(ChosenVocalisPort));
  WriteUrlFile(ExpandConstant('{group}\Taproom.url'), 'http://127.0.0.1:' + IntToStr(ChosenTaproomPort));
  if WizardIsTaskSelected('desktopicon') then
    WriteUrlFile(ExpandConstant('{userdesktop}\Vocalis.url'), 'http://127.0.0.1:' + IntToStr(ChosenVocalisPort));
end;

// Opens the visible console that runs setup (amendment 3 and 6): vocalis-control.ps1 repair decides first run,
// rerun or update from the saved state and instance.env, then runs setup.ps1 with -NoBrowser -PauseOnFailure.
procedure RunSetupConsole;
var
  ResultCode: Integer;
  HostExe, Arguments, ExitFile: String;
  ExitText: AnsiString;
begin
  if FirstRun then
    WizardForm.StatusLabel.Caption := 'Running Vocalis setup in its own console window. A first install downloads about 62.5 GB of models unless they are already on this computer.'
  else
    WizardForm.StatusLabel.Caption := 'Running Vocalis setup in its own console window. Model files already in the data folder are checked and kept.';
  WizardForm.FilenameLabel.Caption := '';
  HostExe := PowerShellExe;
  Arguments := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\vocalis-control.ps1') + '" -Action repair';
  // Test seam (packaging/windows/tests/drive_installer.ps1 sets it): on Windows 11 a new console window is
  // handed to Windows Terminal, which lives on the visible desktop, so a test running this installer on a
  // hidden desktop would pop the setup console onto the user's screen (seen October 9, 2026). The classic
  // console host draws its window where it was started. Real installs keep the user's own default terminal.
  // conhost.exe always exits 0 whatever its child returned (measured October 9, 2026: a setup that failed
  // at the owner prompt showed "installed and running"), so under the seam the child writes its exit code
  // to a file and that file is the result.
  ExitFile := ExpandConstant('{tmp}\vocalis-setup-exit.txt');
  if GetEnv('VOCALIS_INSTALLER_CONSOLE_HOST') = 'conhost' then
  begin
    DeleteFile(ExitFile);
    Arguments := '"' + HostExe + '" -NoProfile -ExecutionPolicy Bypass -Command "& ''' +
      ExpandConstant('{app}\vocalis-control.ps1') + ''' -Action repair; $c = $LASTEXITCODE; ' +
      'Set-Content -LiteralPath ''' + ExitFile + ''' -Value $c; exit $c"';
    HostExe := ExpandConstant('{sys}\conhost.exe');
  end;
  Log('Starting the setup console with ' + HostExe + '.');
  if Exec(HostExe, Arguments, ExpandConstant('{app}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
  begin
    SetupExitCode := ResultCode;
    if GetEnv('VOCALIS_INSTALLER_CONSOLE_HOST') = 'conhost' then
    begin
      if LoadStringFromFile(ExitFile, ExitText) then
        SetupExitCode := StrToIntDef(Trim(String(ExitText)), 1)
      else
        SetupExitCode := 1;   // no exit file: the child never finished, which is not success
    end;
  end
  else
  begin
    SetupExitCode := 1;
    Log('Could not start the setup console: ' + SysErrorMessage(ResultCode));
  end;
  SetupWasRun := True;
  Log(Format('Setup console finished with exit code %d.', [SetupExitCode]));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    PrepareChoices
  else if CurStep = ssPostInstall then
  begin
    WriteInstallerState;
    WriteShortcuts;
    RunSetupConsole;
  end;
end;

// Uninstall (amendment 10; the control script has run docker.exe from Windows since amendment 15, which superseded the
// wsl.exe invocation): stop and remove this instance's containers through the control script (bounded, hidden), then
// let Inno remove the files. No -v: the stores are bind
// mounts. The data folder and the images are never deleted; the final message says how to remove them by hand.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Root, EnvFile, InstanceId, VocalisRef, TaproomRef, Control: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Root := '';
    RegQueryStringValue(HKCU, InstallerKey, 'DataFolder', Root);
    EnvFile := Root + '\instance.env';
    InstanceId := ReadEnvValue(EnvFile, 'INSTANCE_ID');
    VocalisRef := ReadEnvValue(EnvFile, 'VOCALIS_IMAGE');
    TaproomRef := ReadEnvValue(EnvFile, 'TAPROOM_IMAGE');
    Control := ExpandConstant('{app}\vocalis-control.ps1');
    UninstallMessage := 'Vocalis was uninstalled.' + #13#10#13#10;
    if (Root <> '') and FileExists(Control) then
    begin
      if Exec(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File "' + Control + '" -Action down -NoPause',
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      begin
        Log(Format('Container removal exited with code %d.', [ResultCode]));
        if ResultCode = 20 then
          UninstallMessage := UninstallMessage + 'Docker was not running, so the containers of this instance were not stopped or removed. Start Docker Desktop and run:' + #13#10 +
            '  docker compose --project-name vocalis-' + InstanceId + ' down' + #13#10#13#10
        else if ResultCode <> 0 then
          UninstallMessage := UninstallMessage + 'The containers of this instance could not be removed (exit code ' + IntToStr(ResultCode) + '). Remove them with:' + #13#10 +
            '  docker compose --project-name vocalis-' + InstanceId + ' down' + #13#10#13#10;
      end
      else
        Log('Could not start the container removal.');
    end
    else
      Log('No saved data folder or control script: no containers to remove.');
    if Root <> '' then
      UninstallMessage := UninstallMessage + 'Your data folder was not deleted:' + #13#10 + '  ' + Root + #13#10 +
        'It holds the vaults, databases and model files. Delete that folder yourself only when you no longer need it. If you run this installer again, it will offer this folder again so you can reuse it (or, if you choose another folder, copy its model files instead of downloading them again).' + #13#10#13#10;
    if (VocalisRef <> '') and (TaproomRef <> '') then
      UninstallMessage := UninstallMessage + 'The Docker images were not removed. To remove them:' + #13#10 +
        '  docker image rm ' + VocalisRef + ' ' + TaproomRef;
  end
  else if CurUninstallStep = usDone then
    SuppressibleMsgBox(UninstallMessage, mbInformation, MB_OK, IDOK);
end;
