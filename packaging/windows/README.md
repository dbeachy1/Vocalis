# Vocalis Windows installer (build notes)

`Vocalis-Setup-<version>-x64.exe` is a per-user Inno Setup installer (`{localappdata}\Programs\Vocalis`, no
administrator rights). It is a front end to `packaging/setup.ps1` and `packaging/setup.sh`: it installs the package
files, checks the prerequisites (`setup.ps1 -CheckOnly`), collects the data folder and the two ports
(`setup.ps1 -CheckPorts`), then opens a visible console that runs setup. It carries two image *references* and no
image bytes, and nothing in this folder pushes or publishes an image (repository policy).

## Build

Prerequisites: Windows PowerShell 5.1 or PowerShell 7, the .NET SDK (the pinned compiler is restored as the NuGet
package `Tools.InnoSetup` 6.7.3 in locked mode into the git-ignored `obj/packages`), and, for a locally built
image, Docker.

```powershell
.\packaging\windows\build-installer.ps1 `
  -VocalisImage 'vocalis-main-app-cuda@sha256:<64 hex>' `
  -TaproomImage 'vocalis-g1-taproom@sha256:<64 hex>'
```

- Each reference must be `name@sha256:<64 hex>` (the same rule as `setup.sh`). With the containerd image store a
  locally built image answers to `<name>@sha256:<image id>`; for a reference with no registry host the build asks the
  local Docker and refuses unless the image has exactly that ID.
- The version is `VERSION` in `source/vocalis/src/tts_utils.py` (for example `12.0.0-M1`); it is `AppVersion` and the
  file name, and `VersionInfoVersion` is `12.0.0.0`.
- The build refuses CR bytes in `setup.sh` and the compose files, refuses to overwrite an existing artifact, treats any
  compiler warning as a failure, and writes under `artifacts/windows/`: the installer, `<exe>.sha256` and
  `<exe>.files.json` (the installed files with sizes and hashes, plus the baked references and the version).
- Unsigned is the default and is for test builds.

## Signed release builds

Release builds are signed and timestamped with Azure Artifact Signing: Setup and its uninstaller
(`SignTool=azurecodesign`, `SignedUninstaller=yes`), then verified (SignTool `/pa /all /tw`, a valid Authenticode
status, the signer `Douglas Beachy`, and a timestamp). The three local tool paths never enter the repository; put them
in the git-ignored `packaging/windows/signing.local.json`:

```json
{ "signToolPath": "<Windows SDK>\\signtool.exe", "dlibPath": "<package>\\Azure.CodeSigning.Dlib.dll", "metadataPath": "<private>\\metadata.json" }
```

and run the build with `-Sign` (or pass `-SignToolPath`, `-DlibPath`, `-MetadataPath`; all three or none). A signed
build also refuses image references that name no registry host or a registry on this machine.

## Files

| File | Purpose |
| --- | --- |
| `vocalis.iss` | The installer script (wizard pages, state file, shortcuts, uninstall). |
| `build-installer.ps1` | Validates the inputs, compiles with the pinned ISCC, writes the artifacts. |
| `vocalis-satellite.iss`, `build-satellite-installer.ps1` | The satellite setup program's script and build (see "Vocalis Satellite setup program" below). |
| `Invoke-WindowsArtifactSigning.ps1` | Signs and verifies. |
| `vocalis-control.ps1` | Installed beside `setup.ps1`: `start` (ownership pass, then `up`), `stop`, `down` (all `docker.exe` from Windows), `repair`, `compare-version`. |
| `../windows-compose.ps1` | Installed beside `setup.ps1` and `vocalis-control.ps1` (and extracted beside them in `{tmp}` for the wizard-time checks): the shared instance.env parser, bounded runner and Windows `docker.exe compose` invocation, so the services' data folders are mounted by Windows path and come back after Docker Desktop starts. |
| `Vocalis.InstallerBuild.csproj`, `packages.lock.json` | Restore the pinned compiler in locked mode. |
| `make_icon.py`, `vocalis.ico`, `vocalis-satellite-*.ico`, `vocalis-wizard-*.png` | The icon: the web UI favicon drawn with Pillow (`python packaging/windows/make_icon.py`). The same script draws the satellite tray icon's two other looks and the pictures both wizards show (the small corner picture and the large Welcome and Finish picture, one file per display scaling), so no stock picture is left in either setup program. The small picture is the dark square with a transparent margin equal to the page title's distance from the top of the header; `wizard-header-picture.iss` (included by both `.iss` files, so there is one copy) moves it so its gap from the right edge equals the title's distance from the left edge. |
| `wizard-header-picture.iss` | The `[Code]` procedure `PlaceHeaderPicture`, included by `vocalis.iss` and `vocalis-satellite.iss`: places the small wizard picture in the header and narrows the title and description labels so they never run under it. It writes the numbers it worked from to the Inno log (`/LOG=`). |
| `tests/measure_wizard_header.py` | Measures the dark square's three gaps in a capture of a wizard page (`drive_installer.ps1` or `drive_satellite_installer.ps1` with `-CancelAtPage` and `-CaptureDir`). |

Tests: `python -m pytest packaging/tests -q -p no:cacheprovider`.

## Vocalis Satellite setup program (build notes)

`Vocalis-Satellite-Setup-<version>-x64.exe` is a second per-user Inno Setup program
(`{localappdata}\Programs\VocalisSatellite`, no administrator rights), built beside the main installer with the same
pinned compiler. It is a front end to `packaging/satellite/satellite-setup.ps1`: the wizard collects the satellite
folder, port, name, an optional extra address, the start-with-Windows choice and the pairing secret; runs the script
once, hidden, with `-NoPrompt`; and builds its last page from the script's `setup-result.txt`. It also installs the
tray program (`VocalisSatelliteTray.exe`, built from `packaging/windows/tray/`) and starts it at sign-in through a
per-user Run entry. It carries one image *reference* and no image bytes, and nothing here pushes or publishes
anything.

```powershell
.\packaging\windows\build-satellite-installer.ps1 -SatelliteImage 'vocalis-satellite@sha256:<64 hex>'
```

- `-SatelliteImage` is `name@sha256:<64 hex>`, validated as the main build validates its references: a local
  reference must resolve to that exact image ID in the local Docker, and a signed release build refuses a reference
  with no registry host or one on this machine.
- The build first restores the tray project in locked mode, builds it in Release and runs its unit tests
  (`packaging/windows/tray/tests`); nothing is packed if any of that fails. A signed build signs a copy of the tray
  program before packing it, so an ordinary build never packs a signed file.
- The three icon files `vocalis.ico`, `vocalis-satellite-stopped.ico` and `vocalis-satellite-nodocker.ico` (all from
  `make_icon.py`) must exist; the build refuses clearly when one is missing. The Vocalis icon is the setup program's
  own icon (`SetupIconFile`), the Installed apps icon (`UninstallDisplayIcon`) and the icon of every shortcut.
- The version is `VERSION` in `source/vocalis/src/tts_utils.py`, as for the main installer. The build refuses to
  overwrite an existing artifact, treats any compiler warning as a failure, and writes under `artifacts/windows/`:
  the setup program, `<exe>.sha256` and `<exe>.files.json`.
- Signing is the same hook and the same `signing.local.json` as above (`-Sign`); Setup, its uninstaller and the tray
  program are signed and verified.

**Test identity.** `-TestIdentity <word>` (one lowercase word of letters and digits; refused together with signing)
builds a setup program whose AppId, program folder, Run value, setup mutex, Start menu group, default satellite
folder, application name and file name all differ from the real program's. Every automated test uses such a build:
without it a test install on a computer that holds a real one would be an upgrade of that install, and its
uninstall test would remove the real container, close the real icon and delete the real Run entry.

**Installed files.** `satellite-setup.ps1`, `VocalisSatelliteTray.exe`, `satellite-log-tail.ps1` (the console log
viewer behind the tray menu's "Tail the satellite log"; a plain script, run with Windows PowerShell 5.1 in its own
window, which only reads `<satellite folder>\logs\satellite.log` and follows it across restarts and rotation),
`Vocalis-Satellite-Setup.exe`, `Vocalis-Satellite-Guide.md`, `LICENSE` and the three icon files. Inno removes every
installed file at uninstall; the uninstaller's own list of generated files (state file, tray logs) is separate.

**Maintenance modes.** The installed copy `Vocalis-Satellite-Setup.exe` takes `/MODE=repair`, `/MODE=newsecret` and
`/MODE=newcertificate`; in a mode every installed file, shortcut and registry entry is skipped, so nothing is copied and
the tray icon stays running. The Start menu group and the Modify entry under Installed apps start these.

**Tests.** `packaging/tests/test_satellite_windows_installer.py` covers the script text, the build script and (when the
pinned compiler is restored) a compile of the script with zero warnings and a pixel comparison of the icon inside the
built program. The wizard itself is driven on the hidden desktop, with a test-identity build, by
`packaging/windows/tests/drive_satellite_installer.ps1` (never on the visible desktop; it is not run by pytest).
`VOCALIS_SATELLITE_TEST_NO_SHELL=1` keeps the wizard and the tray program from opening Explorer or Notepad: each
appends what it would have opened to `test-shell-actions.log` in the program folder. The wizard still starts the tray
icon at the end, on its own (hidden) desktop, and notes that in the same file.
