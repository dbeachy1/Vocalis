# Vocalis render satellite

A satellite is optional. It lends the graphics card of a second computer to Vocalis for Chatterbox
speech. It is particularly useful when a large LLM runs on your main machine and you want speech on a
second machine, so it does not take memory away from the LLM for your SillyTavern chat or other tasks,
and for faster book rendering, where a large document means a great many Chatterbox chunks.

Speech is rendered on the satellite and sent back. Nothing is kept on that computer and it never talks
to your browser. Everything between Vocalis and a satellite is encrypted and checked with a secret
only the pair share, and Vocalis trusts only the one certificate you upload for it.

| Second computer | Supported |
| --- | --- |
| Linux with an NVIDIA card | Yes |
| Linux with an AMD card | Yes |
| Windows with an NVIDIA card | Yes, through Docker Desktop |
| Windows with an AMD card | No (Docker Desktop cannot give an AMD card to a container) |

One satellite per computer is enough: it uses the memory its cards have free and adjusts as other
programs take and release memory. For more speed, run a satellite on another computer; Vocalis can
use several at once.

## What the second computer needs

- Docker, running. On Windows that is Docker Desktop with the WSL 2 backend.
- A working driver for the card. Linux with NVIDIA also needs the NVIDIA Container Toolkit. Linux with
  AMD needs the kernel driver that provides `/dev/kfd` and `/dev/dri`.
- About 10 GB for the satellite image and 3.2 GB for the Chatterbox model.
- A fixed address on your network. Reserve the computer's address in your router: the satellite's
  certificate names the address, and Vocalis refuses a satellite whose address has changed.
- A network you trust. Never forward the satellite's port from the internet.

It does not need this repository, Python, `sudo` or administrator rights. On Windows the setup
program needs nothing else installed: it uses .NET Framework 4.8, which is part of Windows 10 (version
1903 and later) and of Windows 11.

## Set it up on Windows

You will go back and forth between the second computer and Vocalis once. Do the steps in this order.

1. **Download and run the setup program.** On the second computer, download
   `Vocalis-Satellite-Setup-<version>-x64.exe` from the Releases page and run it. It does not ask for
   administrator rights.

2. **Answer the setup pages.** They come in this order.

   - **Welcome, License.** What a satellite is, and the license.
   - **Prerequisites.** Checks that Docker Desktop is installed and running and that Docker can see
     the NVIDIA card. Each problem comes with a plain fix; press Retry after you fix it. Next stays
     off until every check passes. The page also shows the space needed (about 10 GB in Docker's
     disk, 3.2 GB in the satellite folder) and the free space on the folder's drive. It warns,
     without stopping you, when Docker Desktop is not set to start when you sign in (see "Start the
     satellite when Windows starts" below).
   - **Satellite folder.** Where the satellite keeps its files. The default is
     `%LOCALAPPDATA%\VocalisDocker\satellite`. Keep it unless you have a reason. If the folder
     already holds a satellite, the page offers "use this satellite" (see "Already have a satellite
     made with the script?" below).
   - **Port, name and starting.** The port (default 7880; setup tests it and suggests a free one if
     it is taken). A name for the satellite (default: the computer's name). An optional **Extra
     address** box, only for when Vocalis reaches this computer by an address setup does not find,
     for example through a VPN. And one tick box, on by default: **Start the satellite when Windows
     starts.**
   - **Pair with Vocalis.** The address to enter in Vocalis, with a Copy button, and a box for the
     secret. See step 3.
   - **Ready, Setting up.** Setup copies its files, then runs. It shows the current step. A first
     run can take several minutes (the image and the model are large downloads), and it cannot be
     canceled while it runs. If it is interrupted, run the setup program again: it continues, and
     finished downloads are kept.
   - **Finish.** The certificate file to give to Vocalis. See step 4.

3. **In Vocalis, add the satellite** (the first of three steps there). When setup shows the Pair page,
   open Vocalis, Settings, Satellites, Add satellite. Give it any name and the address from the
   Pair page. Vocalis shows a secret **once**, with a note for each kind of satellite; yours is the
   Docker one. Paste the secret into the box on the Pair page and press Next. The box checks only that
   the secret looks right (64 hexadecimal characters) and tells you plainly when it does not. Nothing
   is installed yet at this point, so Cancel is safe.

4. **In Vocalis, upload the certificate** (the second step). When setup is done, its last page says
   the satellite is running and shows the certificate file. Press **Show the file** to open Explorer
   with the file selected, or **Copy the path** to paste it into the browser's file dialog. If your
   browser is on another computer, copy the file there first. Then in Vocalis press "Upload
   certificate..." on the satellite's row. Vocalis shows the same fingerprint as the setup page; if
   the two differ, you uploaded the wrong file. Only the certificate (`cert.pem`) is copied. The
   private key beside it never leaves the satellite.

5. **In Vocalis, tick the satellite's cards** (the third step) in Settings. They load as soon as you
   tick them; the round-arrow button on the satellite's row applies the ticks again if you ever need
   it.

The finish page also says that the satellite's icon is now in the notification area (see below), and
points to the Network section of this guide in case Vocalis cannot reach the satellite.

When you run setup again later, the last page says what is left to do. After a new certificate it asks
you to upload the new file. After an update or a new secret it says nothing has to be done in
Vocalis. After a repair of a satellite that may never have been set up in Vocalis, it says: if it
already is, nothing more is needed; if not, the two steps above are left. In every case the page keeps
the Show the file and Copy the path buttons for the certificate.

If setup stops, the last page says "Setup did not finish", gives the reason and a button that opens
the setup log. The files stay installed. Fix the cause, then run the setup program again, or choose
**Repair satellite** from the Start menu. It continues where it stopped.

**Already have a satellite made with the script?** Run the setup program and choose the same folder on
the folder page ("use this satellite"). It takes the satellite over and nothing is paired again:
the secret and the certificate stay as they are, and the Pair page does not appear
(unless that satellite was never paired with Vocalis).

The setup program puts its files in `%LOCALAPPDATA%\Programs\VocalisSatellite`: the setup script,
the tray program, this guide (as `Vocalis-Satellite-Guide.md`), and a copy of the setup program for the
repair modes. It adds a Start menu group named "Vocalis Satellite" (nothing on the desktop) with
Vocalis Satellite (starts the icon), Repair satellite, Change secret, New certificate, Satellite
guide and Uninstall. While you paste the secret, the setup program keeps it in a small file in that
program folder for the length of the run and deletes it as soon as the run ends.

## The tray icon

The Vocalis icon appears in the notification area after every sign-in, and again whenever you start
**Vocalis Satellite** from the Start menu. (If you do not see it, open the arrow beside the
notification area: Windows may hide it there.) The last item in its menu, "Close this icon (the
satellite keeps running)", closes only the icon; the satellite is left as it is. To stop the
satellite, choose **Stop satellite**.

| The icon looks | It means |
| --- | --- |
| In color (the orange V) | The satellite is running. |
| Grey | The satellite is stopped, or starting, or there is nothing to run. |
| Grey with a small mark | Docker Desktop is not running. |

Hold the pointer over the icon for a one-line description with the satellite's name and port. The first
line of its menu says the same in more detail: running on port N; stopped; starting; Docker Desktop is
not running (and not set to start when you sign in, when that is so); the satellite's container is
missing (choose Repair); no satellite is set up; or the satellite folder cannot be read (for example
a drive that is not there). If your last command failed, the reason is on that line too.

| Menu item | What it does |
| --- | --- |
| Start satellite | Starts the satellite. It is ready in a few seconds, and Vocalis loads the model again on its next request. |
| Stop satellite | Stops the satellite. This frees the card's memory at once. |
| Start the satellite when Windows starts | A tick box. See below. |
| Show certificate file | Opens Explorer with the certificate selected. |
| Change secret... | Gives the satellite a new secret. In Vocalis press "New secret..." on the satellite's row first. The setup program opens with the pages it needs. |
| New certificate... | Makes a new certificate. Needed when the computer's address changes. Upload the new file in Vocalis afterwards. |
| Repair... | Runs setup again over the same satellite. Use it when the first menu line says the container is missing, or after a setup that did not finish. |
| Open the setup log | Opens the log of the last setup run. |
| Tail the satellite log | Opens a new command prompt window, titled "Vocalis Satellite log", that shows the last 50 lines of the satellite's own log and then each new line as it is written. See below. |
| Satellite guide | Opens this guide in Notepad. |
| Close this icon (the satellite keeps running) | Closes the icon only. The satellite is not stopped. |

Start and Stop are the only two commands. There is no Pause: pausing would keep the model in the
card's memory and Vocalis would see a satellite that stopped answering. To give the card back for a
while, use Stop. Start brings the satellite back in a few seconds.

**Tail the satellite log.** Each time you choose it, a new window opens and follows the file
`logs\satellite.log` in the satellite's folder. It follows the file, not the container, so the
window stays open and keeps printing when you stop, start or restart the satellite, when setup
recreates it (Repair, a new certificate, a new secret, an upgrade), when Docker restarts, and even
when you close the icon. In the log, every start begins at once with "Vocalis satellite <version>
starting" (the speech libraries then take a few seconds to load), and every stop ends with "stop
requested: the satellite is exiting" followed by a line of equal signs, so one run is easy to tell
from the next. Only you close it, with the window's close button or Ctrl+C. When
the satellite starts a new log file after the old one reaches 10 MB, the window carries on with the
new file from its start. If the log file is not there yet (a satellite that has never run), the
window says so in one line and starts following when the file appears. The window never keeps the
satellite from writing or replacing its log. It needs the satellite's folder, not Docker, so it works
while Docker Desktop is not running. It uses Windows PowerShell, which every supported Windows has.

**Start the satellite when Windows starts.** The icon itself always starts when you sign in. This tick
box is only about the satellite:

- **On:** after the computer or Docker restarts, a satellite that was running comes back. On Windows
  the icon goes one step further so the box means what it says: when it starts at sign-in and the
  satellite is not running, it starts the satellite once Docker Desktop answers, even if you stopped
  it before shutting down. Docker Desktop must itself be set to start when you sign in (Docker
  Desktop, Settings, General, "Start Docker Desktop when you sign in"); nothing runs before you sign
  in.
- **Off:** the satellite stays down until someone starts it, and it is also not restarted if it
  crashes. The icon is still there at every sign-in; use Start when you want the satellite.

The menu item is greyed while Docker is not running, because the setting cannot be changed then.

### Change it later, reinstall, uninstall

- **Change the secret or make a new certificate:** use the icon's menu or the Start menu group, as
  above.
- **Update to a new release:** download that release's setup program and run it. It updates the
  program and moves the satellite to the image the new release carries. Nothing is paired again. A
  setup program older than the installed one refuses to run.
- **Reinstall or repair:** Windows Settings, Apps, Installed apps, "Vocalis Satellite", **Modify**. It
  runs setup again over the same satellite.
- **Uninstall:** the same place, **Uninstall**. It closes the icon, removes the icon's
  start-with-Windows entry, removes the satellite's container, and removes the program files and the Start menu group.
  It leaves two things so you can decide: the satellite folder (certificate, secret, model, logs) and
  the image. Its last message names both. Delete the folder yourself, and the image with
  `docker image rm`, to free the space (about 10 GB for the image and 3.2 GB for the model).
  Remove the satellite's row in Vocalis too.
  If Docker is not running when you uninstall, the container is skipped and setup says so. If the
  satellite folder is already gone, setup says it could not look up the container and gives the
  command to find it: `docker ps -a --filter name=vocalis-satellite`.

## Set it up on Linux

The same order as above, with a script instead of a program. Do the steps in this order.

1. **On the second computer, download the setup file and run it.** Get `satellite-setup.sh` from the
   Releases page. On a computer without a browser, copy the file's link from that page on another
   computer and fetch it with `curl -fLO` followed by the link. Download first, then run; do not
   pipe it into a shell, because it needs your keyboard for the secret.

   ```sh
   bash satellite-setup.sh
   ```

   Setup checks Docker and the card, downloads the image, and then prints the address to use, for
   example `https://192.168.1.50:7880`, and asks for a secret. Its output is short: a header for
   each step and one or two lines under it. Everything else goes to a log, and the last line says
   where: `logs/setup-<date>-<time>-<number>.log` in the satellite folder. Add `--verbose` to see
   everything on screen as well.

2. **In Vocalis, add the satellite.** Settings, Satellites, Add satellite. Give it any name and the
   address setup printed. Vocalis shows a secret **once**, with a note for each kind of satellite;
   yours is the Docker one: paste it into the setup that is waiting.

3. **Back on the second computer, paste the secret** and press Enter. Nothing is shown as you paste.
   Setup then makes the certificate, downloads and checks the model, starts the satellite, and prints
   the certificate file to upload and its fingerprint.

4. **Copy that certificate file to the computer where you use Vocalis in a browser**, then in Vocalis
   use "Upload certificate..." on the satellite's row. Vocalis shows the same fingerprint; if the two
   differ, you uploaded the wrong file. Only the certificate (`cert.pem`) is copied. The private key
   beside it never leaves the satellite. See "Finding the certificate file" below.

5. **In Vocalis, tick the satellite's cards** in Settings. They load as soon as you tick them; the
   round-arrow button on the satellite's row applies the ticks again if you ever need it.

Docker starts the satellite again by itself after a restart; see "Start with the computer" below.

### The `vocalis-satellite` command

A successful setup installs one small command, `vocalis-satellite`, at `~/.local/bin/vocalis-satellite`,
to start the satellite, stop it and follow its log. The last lines of setup end with
"To run it: vocalis-satellite start | stop | status | logs".

| Command | What it does |
| --- | --- |
| `vocalis-satellite start` | Starts the satellite. |
| `vocalis-satellite stop` | Stops it. This frees the card's memory at once. |
| `vocalis-satellite restart` | Stops and starts it. |
| `vocalis-satellite status` | Whether it is running or stopped, since when, its port and address, its image, whether autostart is on or off, and the last five log lines. |
| `vocalis-satellite logs` | Follows the satellite's log, starting with the last 100 lines. Press Ctrl+C to stop following. |
| `vocalis-satellite logs -n N` | The same, starting with the last N lines. |
| `vocalis-satellite logs --no-follow` | Prints the lines and returns. |
| `vocalis-satellite autostart on` or `off` | Turns "start with the computer" on or off. See below. |
| `vocalis-satellite certificate` | The certificate file to upload, its fingerprint, and a ready `scp` line to fetch the file to the computer where your browser is. |
| `vocalis-satellite certificate --pem` | Prints the certificate itself. It is public. Use it to pipe the file over SSH, for example `ssh <user>@<address> '~/.local/bin/vocalis-satellite certificate --pem' > cert.pem`. |
| `vocalis-satellite help` | The list of commands. |

Each command prints one plain line when it works, and Docker's reason when it does not. If Docker is
not running, it says so.

**When the command is not found.** Setup never changes your `PATH` or your shell's start files. If
`~/.local/bin` is not on your `PATH`, run the command by its full path,
`~/.local/bin/vocalis-satellite`, or add that folder to your `PATH` yourself. The last lines of setup
give the full path when the folder is not on it.

The command belongs to one satellite folder, and one satellite per user is enough. If a file named
`vocalis-satellite` already exists there that setup did not write, or that belongs to another
satellite, setup leaves it alone, says so, and prints the `docker` commands for the satellite
instead. Setup replaces only a command it wrote itself.

**Start with the computer.** There is no systemd unit and nothing to install as a service. Docker
itself is the service: it starts the satellite at boot, before anyone signs in, and restarts it if it
crashes. What the setting `autostart` means:

- **On** (the default): after the computer or Docker restarts, a satellite that was running comes
  back. A satellite you stopped stays stopped until `vocalis-satellite start`.
- **Off:** the satellite stays down until you start it, and it is also not restarted if it crashes.

Change it with `vocalis-satellite autostart on` or `off`. It takes effect at once, without
restarting the satellite.

## Linux, and Windows from a prompt

On Linux the script is the way to set up and manage a satellite. On Windows you can use the same
script from a PowerShell prompt instead of the setup program. The setup program does not need this,
and the tray icon comes only with the setup program. Download `satellite-setup.ps1` from the
Releases page, then, in the folder you saved it to:

```powershell
powershell -ExecutionPolicy Bypass -File .\satellite-setup.ps1
```

Windows blocks a downloaded script by default; that command runs this one file without changing your
computer's settings. The steps in Vocalis are the same as under "Set it up on Windows": add the
satellite, upload the certificate, tick the card.

Linux options are shown; the Windows script takes the same ones as `-Root`, `-Image`, `-Port`,
`-Name`, `-Address`, `-SecretFile`, `-Autostart`, `-Verbose`, `-Update`, `-NewSecret`,
`-NewCertificate`, `-Remove`.

| Option | What it does |
| --- | --- |
| `--root PATH` | The satellite's folder. Default `~/.local/share/vocalis/satellite` (Linux), `%LOCALAPPDATA%\VocalisDocker\satellite` (Windows). |
| `--variant cuda\|rocm` | Linux only, and only needed when the computer has both an NVIDIA and an AMD card (integrated AMD graphics beside an NVIDIA card is common): `cuda` uses the NVIDIA card, `rocm` the AMD card. |
| `--image REF` | A satellite image other than the one this release names, as `<name>@sha256:<64 hex digits>`. |
| `--port N` | The port other computers use. Default 7880. |
| `--name NAME` | A label for the satellite's own log. Default: the computer's name, in lower case. |
| `--address VALUE` | An extra IPv4 address Vocalis may use to reach this computer. Setup already includes the computer's own network addresses. For more than one, repeat the option on Linux (`--address A --address B`) and give a comma list on Windows (`-Address A,B`). |
| `--secret-file PATH` | Read the secret from a file, not the keyboard. Create the file in an editor, not with `echo`, which leaves the secret in your shell history. Save it as plain text (not UTF-16). Delete it afterwards. |
| `--autostart on\|off` | Start with the computer or Docker (`on`, the default) or stay down until started (`off`). Used alone it changes only this setting, at once, and does nothing else. What the two values mean is under "Start with the computer" above. |
| `--verbose` | Show everything on screen, as the log does. On Windows this is PowerShell's own `-Verbose`. |

On Linux, `--help` lists the options. The other operations (`--update`, `--new-secret`,
`--new-certificate`, `--remove`) are under Later.

### Finding the certificate file

Setup prints the full path of the certificate file as `File to upload`. In the browser's file dialog,
paste that path into the "File name" box and press Enter. You do not have to find the folder by
clicking. This matters on Windows, where the default folder is under `%LOCALAPPDATA%`, which
Explorer hides. On Linux, `vocalis-satellite certificate` prints the path again, and a ready `scp`
line for copying the file to the computer where your browser is.

## Later

Windows: use the tray icon and the Start menu group, as described above. Linux: run the script again,
or use the `vocalis-satellite` command. Nothing has to be paired again except as noted.

Running the setup program (Windows) or the script (Linux) again at any time keeps the secret, the
certificate and your settings, checks the model, and starts the satellite if it is not running.

| To | Windows | Linux |
| --- | --- | --- |
| Stop it | Icon, Stop satellite. | `vocalis-satellite stop` |
| Start it | Icon, Start satellite. | `vocalis-satellite start`, or run setup again. |
| Update | Download the new release's setup program and run it. | Download the new release's `satellite-setup.sh` and run it with `--update`. (Or name an image yourself: `--update --image REF`.) |
| Use a new secret | In Vocalis press "New secret..." on the satellite's row, then icon, Change secret..., and paste it. | In Vocalis press "New secret..." on the satellite's row, then run setup with `--new-secret` and paste it. |
| Make a new certificate | Icon, New certificate..., then upload the new file in Vocalis. | Run setup with `--new-certificate`, then upload the new file in Vocalis. |
| Remove it | Windows Settings, Installed apps, Vocalis Satellite, Uninstall. | `--remove` removes the container and the `vocalis-satellite` command, and leaves the folder. |

A new certificate is needed when the computer's address changes. It names the computer's present
addresses; give any extra address you added before again (setup lists the ones it is dropping).

Removing a satellite leaves its folder and its image. Delete the folder yourself, and the image with
`docker image rm`, to free the space. Remove the satellite's row in Vocalis. On Linux, the kept script
is the way back: `bash <folder>/satellite-setup.sh`.

The port, the card type and the name are fixed for a satellite folder. To change one, remove the
satellite and set it up in a new folder. Do not copy or move a satellite folder: setup refuses a
folder that is not where it was created, because two copies would fight over one satellite.

## Network

The satellite listens on its port on every network interface of the computer, because being called
from another computer is its purpose. A stranger on your network cannot use it or read anything from
it, but the port is reachable, so run it only on a network you trust. Setup never changes a firewall.

- **Windows:** if Vocalis cannot reach the satellite, allow the port through Windows Firewall. Run
  this once in a PowerShell opened as administrator (right-click Windows PowerShell, Run as
  administrator). Use your port in place of 7880 if you chose another.

  ```powershell
  New-NetFirewallRule -DisplayName 'Vocalis satellite 7880' -Direction Inbound -Protocol TCP -LocalPort 7880 -Action Allow -Profile Private
  ```

- **Linux:** a port published by Docker is open even when `ufw` says otherwise. To limit who can
  reach it, add a rule to Docker's `DOCKER-USER` chain.

From a Vocalis that itself runs in Docker, use the IPv4 address, as setup prints it. A computer name
often does not resolve inside the Vocalis container.

## What is in the satellite folder

| Path | What |
| --- | --- |
| `satellite.env` | Settings: the satellite's ID, card type, image, port, addresses, whether it starts with the computer (`AUTOSTART`) and the certificate's fingerprint (`CERT_FINGERPRINT`). No secrets. |
| `setup-result.txt` | A short summary of the last setup run, as `KEY=VALUE` lines: what happened, the certificate file, the fingerprint. The setup program reads it for its last page. No secrets. |
| `data/satellite.yaml`, `data/certs/` | The satellite's configuration, its certificate `cert.pem` (upload this one) and private key `key.pem` (never copy this one). |
| `secrets/` | The shared secret. On Linux only you can read it. On Windows it is as private as the folder it is in; the default folder is inside your own profile. |
| `models/` | The Chatterbox model files. |
| `logs/` | The satellite's own log, and one `setup-<date>-<time>-<number>.log` for each setup run (the last ten are kept). Setup logs hold everything setup did, including the lines it does not show; they never hold the secret. |
| `work/`, `cache/` | Files in flight during a render, and caches. |
| `satellite-setup.sh` | Linux only. A copy of the setup script that setup keeps, so the `vocalis-satellite` command and a later `--update` always have it. A setup run from a newer download replaces it. |

## If something goes wrong

- **Setup finds no card.** The driver or Docker's GPU support is not working in containers. On
  Windows check that Docker Desktop uses the WSL 2 backend and the NVIDIA driver is current. On Linux
  with NVIDIA, install the NVIDIA Container Toolkit and restart Docker.
- **Setup did not finish.** The last page (Windows) or the last lines (Linux) give the reason and the
  setup log. Fix the cause and run setup again, or choose Repair on Windows; it continues where it
  stopped, and finished downloads are kept.
- **Vocalis says the certificate does not match.** The satellite's address has changed since the
  certificate was made, or the wrong file was uploaded. Run setup again; it says when the address is
  no longer in the certificate. Then make a new certificate (the icon's New certificate..., or
  `--new-certificate`) and upload the new file.
- **Vocalis says the satellite rejected the request.** The secrets differ. Press "New secret..." in
  Vocalis, then give the satellite the new one (the icon's Change secret..., or `--new-secret`).
- **Vocalis cannot reach the satellite.** See Network above, and check the address and port. On
  Windows also look at the icon: grey with a mark means Docker Desktop is not running, and grey means
  the satellite is stopped.
- **The icon says the satellite's container is missing.** Choose Repair... in its menu.
- **The satellite does not start with Windows.** Check that the tick box in the icon's menu is on, and
  that Docker Desktop is set to start when you sign in.
- **The satellite's own log** is in `logs/` in its folder, and `docker logs vocalis-satellite-<id>`
  shows it too. On Windows the icon's "Tail the satellite log" follows the file; on Linux,
  `vocalis-satellite logs` follows it. The setup logs are in the same folder.

## For maintainers: building the images and the release files

Two images, one per card type, each built on the verified Chatterbox dependency image for that type.
The build is offline and checks the base image's ID first:

```sh
python packaging/build_satellite.py --variant cuda --tag <tag>
python packaging/build_satellite.py --variant rocm --tag <tag>
```

| Card type | Base image | Python environment |
| --- | --- | --- |
| NVIDIA (`cuda`) | `vocalis-g1-main-cuda-deps:20261008-vocalis-0.1.7.1` (`sha256:00c74576a8d14dd533a5f56d6289d132cc837f42911ee17831b962afe6d422e0`) | `/opt/venv/3.12/bin` |
| AMD (`rocm`) | `vocalis-g1-main-rocm-app-deps:20261008-vocalis-0.1.7.1` (`sha256:8286bb78f73af7e8065bcf58c8e8022bee604f063e21f406149c7966b5a7d86a`) | `/opt/venv/chatterbox/bin` |

The recipe adds the satellite sources, the provisioning tool the setup files call
(`satellite_admin.py`), the model fetcher and Chatterbox manifest, and, for NVIDIA, the pinned
`nvidia-ml-py` wheel from `packaging/nvml`. It installs nothing from the network and copies no model
weights. The application code and model are read-only at run time; every write goes to a mounted
folder. A missing configuration, secret, certificate, log or work mount fails startup.

`stamp_release.py --cuda-image REF --rocm-image REF --out DIR [--release]` writes copies of the two
setup files with the release's image references filled in. The copies in this repository name no
image and require `--image`. None of these steps pushes an image to a registry.

The Windows setup program and the tray icon are built from the NVIDIA image's reference, beside the
main installer:

```powershell
.\packaging\windows\build-satellite-installer.ps1 `
  -SatelliteImage 'vocalis-satellite-cuda@sha256:<64 hex>'
```

- The reference must be `<name>@sha256:<64 hex>`. A local reference must resolve to exactly that
  image ID, and a release build refuses a reference that has no registry host. The setup program
  carries the reference and no image bytes.
- The build writes `Vocalis-Satellite-Setup-<version>-x64.exe` under `artifacts/windows/`, with its
  `.sha256` and `.files.json`, and refuses to overwrite an existing file. It builds the tray program
  (`packaging/windows/tray/`, .NET Framework 4.8) with the .NET SDK and packs it.
- Release builds sign the tray program and the setup program, then verify the signatures. Other builds
  are unsigned.
- `-TestIdentity <word>` (refused together with signing) builds a setup program with its own
  program folder, Start menu group, start-with-Windows entry and default satellite folder, so that a
  test install never touches a real one on the same computer. Use it for every test build.
- The setup program does not publish anything. See `packaging/windows/README.md` for the build
  prerequisites, the signing setup and the tests.

The exact `docker run` arguments the setup files use are in `satellite-setup.sh` and
`satellite-setup.ps1`.
