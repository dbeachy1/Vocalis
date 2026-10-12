# Vocalis Docker instance setup

The package runs Vocalis and Taproom as an isolated Docker Compose project. Setup stores
nonsecret instance settings in `<instance-root>/instance.env`; account passwords, vault keys,
recovery material, provider credentials, and pairing tokens are entered through the services
and are never command-line or deployment-environment values.

## First setup

On Linux, run `packaging/setup.sh`. On Windows, run `packaging/setup.ps1` with Docker Desktop's
WSL integration enabled. The Windows launcher checks Docker Compose and delegates to the same
Linux setup script, then starts the services from Windows (see "Windows: services come back after
Docker Desktop starts" below) and opens the selected local pages; it does not install drivers, change WSL
settings, or require host Python. Linux setup prints those page URLs and opens them when a desktop
session and `xdg-open` are available.
Choose an empty instance root, the `cuda` or `rocm` runtime, and immutable Vocalis and Taproom
image references ending in `@sha256:<64 hex digits>`. Setup defaults to loopback ports 18770 and
18771 and refuses a missing mount source, an occupied port, or a root with unrelated contents.

The root contains the durable Vocalis and Taproom stores, separate cache/model/work roots, and
per-service logs. The setup command creates those paths only for a new instance. Re-running it
against an existing `instance.env` checks the same roots and identity. To update, pass
`--update` (PowerShell: `-Update`) and both new digest references. Update pulls those exact
images and recreates the same project with the same instance ID, ports, and mounts. It does not
reinitialize accounts, clear data, or remove any root. The prior settings file is retained as
`instance.env.previous`.

Every setup, rerun, and update also downloads the model weights the image needs into
`models/vocalis`, from the publisher URLs recorded in the image's model locks, and checks each
file's size and hash. The first run downloads about 62.5 GB (62,483,927,295 bytes, which includes
the 7,986,207-byte DeepFilterNet3 archive; the models installed on disk total 62,484,657,228 bytes,
because setup extracts only that archive's two files, 8,716,140 bytes, and deletes the archive).
Files already present and verified are
skipped, so rerunning the same command resumes an interrupted download, and a partly downloaded
file continues from where it stopped when the server supports it (otherwise it starts over; either
way the finished file is checked in full). A present file that fails verification is left in place and reported, never
overwritten. An update keeps older model revisions; remove them by hand once you no longer need to
roll back. HTDemucs (Stems) and the Lead Vocal models are downloaded at setup from their publishers,
like the rest; no image or archive carries them. DeepFilterNet3 (Denoise, Bulk clean up
and VoxCPM2 voice design) is downloaded at setup from its publisher; redistribution of it is a
separate, still open question.

Setup reuses model files that are already on this machine instead of downloading them again. A rerun,
upgrade or reinstall into the same data folder already downloads nothing, because the files are there.
The case this adds is a new data folder on a computer that already holds a verified set (a reinstall into
another folder, a second instance, a test install): setup offers the model download the models folders of
other Vocalis instances it can find, and each missing file that one of them holds with the same size is
copied, not downloaded. Every copied file is checked against the same hash as a download, so a damaged or
wrong copy is skipped and that file is downloaded. The other folders are only read, never changed, and the
copies are real copies (each instance keeps its own files). Setup looks, in this order, at: each folder you
name with `--seed-models <folder>` (PowerShell: `-SeedModels '<folder>;<folder>'`; repeat the option on
Linux, separate with `;` on Windows), which may be another instance's root folder or its models folder;
every instance under the default instance folder (`~/.local/share/vocalis/` on Linux; also
`%LOCALAPPDATA%\VocalisDocker\` on Windows) that has an `instance.env`; and the list of instance folders
setup has used before, kept at `${XDG_STATE_HOME:-~/.local/state}/vocalis/instance-roots` (on Windows,
inside the default WSL distribution). At most eight folders are used, the ones you name first, and setup
prints every folder it skips and why (missing, a symlink, this instance's own folder, a path with a colon,
comma, apostrophe or line break, or past the limit of eight). The list file is a convenience: if it cannot
be read or written, setup prints a warning and carries on.

To select nondefault ports on first setup, pass `--vocalis-port` and `--taproom-port` (PowerShell:
`-VocalisPort` and `-TaproomPort`). An existing instance keeps its saved ports. On Windows,
`setup.ps1` binds each new instance's two ports on `127.0.0.1` itself before it hands off (the
default pair when you pass none), because the Linux check inside WSL cannot see a port Windows is
using or has reserved; it then passes the ports to `setup.sh`, so no port question is asked.

Setup pulls only the images that are not already on this machine. For each of the two services it
runs `docker image inspect` on the pinned reference; a reference that resolves (for example an image
you built locally, which answers to `<name>@sha256:<image id>`) is not pulled, setup says which
services were found locally, and only the absent ones are pulled. A published reference that is not
present is pulled as before. `--update` applies the same rule to the new references, and it also
applies the owner rule of a rerun: if the Taproom owner store is empty (an earlier first install
was interrupted before the owner was created) it provisions the owner, otherwise it verifies the
owner, before starting the services.

`setup.ps1` has four more switches for an installer that runs it. `-CheckOnly` runs read-only
prerequisite checks (docker.exe, the Docker engine, Compose v2, WSL, a default WSL distribution that
is not `docker-desktop`, bash, docker and Compose inside it, and the NVIDIA runtime), prints one line
per check, bounds each to 60 seconds, and exits with a distinct code for the first failure (10
through 18; the table is at the top of the script, which also lists 19, the services could not be
started after a finished setup). `-PauseOnFailure` waits for Enter before the
window closes when the exit code is not zero. `-NoBrowser` skips opening the Vocalis and Taproom pages.
`-CheckPorts` only bind-tests `-VocalisPort` and `-TaproomPort` on Windows (the defaults when omitted);
when one is busy it exits 1 and prints the next free pair as `Suggested ports: <vocalis> <taproom>`.

## Windows: services come back after Docker Desktop starts

On Windows, use the Start menu shortcuts (Start Vocalis, Stop Vocalis, Repair setup) or `setup.ps1`.
`setup.ps1` runs `setup.sh` inside WSL with `--defer-start` (setup does everything but start the
services), then starts the two services itself with `docker.exe`, from Windows, so each data folder is
mounted by its Windows path (`E:/...`). Docker Desktop restarts such containers by itself. Containers
whose data folders are mounted through the WSL distribution (`/mnt/e/...`, which is what an `up` run
inside WSL creates) fail to restart after a reboot or a Docker Desktop restart, because Docker restarts
them before it has reconnected to the distribution, and Docker does not retry. Before the start,
`setup.ps1` and the Start shortcut give every file under each service's data folders to that service's
user (a one-shot container per service, changing only files whose owner differs). An existing instance
converts itself on the next Repair, upgrade or Start: the ownership pass, then both containers are
recreated with Windows-path sources on the same folders; no data moves.

`stop` and `start` from anywhere are harmless, but `up` must come from Windows: an `up` run from WSL puts
the instance back on `/mnt` mounts, and it stops coming back by itself. The services come back by
themselves only after you sign in, when Docker Desktop starts (Docker Desktop's "Start Docker Desktop
when you sign in to your computer" setting must be on), and only if you had not stopped them (the
containers use `restart: unless-stopped`). There is no Windows service and no startup item, and nothing
starts before sign-in.

For example, on Linux:

```sh
packaging/setup.sh --update --root "$HOME/.local/share/vocalis/instance" \
  --vocalis-image registry.example/vocalis@sha256:<64-hex-digits> \
  --taproom-image registry.example/taproom@sha256:<64-hex-digits>
```

## Bootstrap and pairing

Setup interactively provisions a passworded Taproom owner without placing the password in a
command or environment variable. It then starts both services and opens the local pages. Complete
Vocalis setup at `/setup`, initialize each application's vault, and retain each service's recovery
material separately. Pairing starts **PENDING**: after both vaults are ready, copy the Vocalis
owner token from Vocalis's SillyTavern pairing settings into the Vocalis extension's Taproom
settings, use the browser-reachable Vocalis URL printed by setup, and verify a short narration.
Enabling the extension is not proof of pairing. The Nomi extension uses its own separate token.

Publishing defaults to `127.0.0.1`; the containers bind internally while Compose exposes only
the selected loopback ports. For remote or forwarded access, use a trusted TLS/reverse-proxy
configuration and enter the browser-reachable URL in the extension. A custom remote origin also
needs a matching explicit browser-extension host permission and may require reloading or
reinstalling the extension. Do not publish directly to `0.0.0.0` as a substitute for TLS.

## Linked folders, host programs, and per-machine Compose additions

These apply to every instance.

**Linked responsibility folders.** The instance root has seven responsibility paths: `data/vocalis`,
`data/taproom/data`, `cache/vocalis`, `models/vocalis`, `work/vocalis`, `logs/vocalis` and
`logs/taproom`. Each may be a real folder (the default, which setup creates) or a symbolic link placed
exactly at that path to an existing real folder, for example on another drive. The root and the
folders above them (`data`, `data/taproom`, `cache`, `models`, `work`, `logs`) stay real folders. Setup
resolves each link with `cd -P` and refuses, naming the path: a dangling link or a link to a file; a
target that is `/`, the instance root, or a folder above it; two paths that resolve to the same folder or
one inside the other; and a target whose path has a character outside `A-Z a-z 0-9 . _ / -`. A link is
only ever a bind source, which Docker resolves on the host when it creates the container; if the target
disappears later (an unplugged drive), Compose fails to create the container and never starts on an
empty replacement. Setup prints each link and its target.

**Container paths of the two Vocalis stores.** `instance.env` may carry `VOCALIS_DATA_PATH` and
`VOCALIS_CACHE_PATH`, the paths at which the Vocalis container sees its data and cache folders
(defaults `/data/vocalis` and `/cache/vocalis`; an `instance.env` made before they existed keeps working
on the defaults). A new instance records the defaults; an instance whose stores are links
records the canonical target of each store that is a link. Setup checks them on every run: absolute, only the
characters above, normalized, different from each other and not nested, not `/`, `/tmp` or `/var`
themselves, and not equal to or inside `/opt`, `/usr`, `/etc`, `/bin`, `/sbin`, `/lib`, `/lib64`,
`/proc`, `/sys`, `/dev`, `/run`, `/models`, `/work`, `/logs`, `/data/taproom` or `/home/vocalis`, and not a
folder that contains one of those (`/home` or `/data` would hide `/home/vocalis` or `/data/taproom`). Edit
them only to a folder you really mean.

**Taproom's folders in its container.** `data/taproom` (holding `config.yaml` and
`mcp-servers.json`) is mounted at `/etc/taproom`, and the Taproom data folder `data/taproom/data` at
`/data/taproom/data`. `/data/taproom` itself is a folder in the image. The next `--update` recreates the
Taproom container with these paths on an existing instance; its host folders do not change.

**Reaching programs on this machine.** Both containers map `host.docker.internal` to the host gateway
(Docker Desktop already provides that name). In Taproom or Vocalis, use
`http://host.docker.internal:<port>` (or the machine's LAN name) for a program on the host; `127.0.0.1`
inside a container is the container itself. The program must listen on an address other than loopback
(all interfaces, or behind a host reverse proxy). Vocalis treats a llama.cpp or KoboldCpp address as on
this machine only when its host is loopback or the machine's own name, which is never true from inside the
container, so set `VOCALIS_LLAMA_LOCAL=1` or `VOCALIS_KOBOLD_LOCAL=1` (in `compose.local.yaml`, below)
when that server really is on this machine; its VRAM warnings and TLS handling then behave as before.

**`<instance-root>/compose.local.yaml`.** Optional, and never written or edited by setup. When it exists
(a regular file, not a link, owned by the user running setup) setup and the Windows helper add it as a
last `-f` file after the GPU file, and `docker compose config --quiet` validates the merged result on
every setup run. It is for what the package cannot know about one machine: extra host names, a private
certificate authority, environment overrides (preferred over editing an application's own settings files
when another install shares them). For example:

```yaml
services:
  vocalis:
    extra_hosts:
      - "myserver:host-gateway"
    environment:
      VOCALIS_LLAMA_URL: http://host.docker.internal:5004
      VOCALIS_LLAMA_LOCAL: "1"
  taproom:
    volumes:
      - type: bind
        source: /home/me/.local/share/mkcert/rootCA.pem
        target: /etc/ssl/local-ca.pem
        read_only: true
    environment:
      NODE_EXTRA_CA_CERTS: /etc/ssl/local-ca.pem
```

You own its effect: it must not publish ports beyond loopback, and a host name pinned to a DHCP address
needs updating (or a reserved address) when the address changes.

**UPS readout (optional).** If a NUT server (`upsd`) knows your UPS, Vocalis shows its load, battery and
runtime in the header. Name the UPS and its server in `compose.local.yaml`:

```yaml
services:
  vocalis:
    environment:
      VOCALIS_UPS: "myups@host.docker.internal"
```

The form is `name@host` or `name@host:port` (port 3493 when left out); `@host` takes the first UPS that
server lists. Vocalis asks the server directly over the network, so nothing has to be installed in the
container, and the server may be another machine. The server must listen on an address the container can
reach: `upsd` often listens on 127.0.0.1 only, which a container cannot. Without this setting there is
no UPS line.

**Public addresses behind a proxy.** For a new instance, `--vocalis-url URL` and `--taproom-url URL`
(`https://host[:port]`, or `http://127.0.0.1:port`; no path) record `VOCALIS_PUBLIC_URL` and
`TAPROOM_PUBLIC_URL` instead of the loopback defaults. Setup prints those addresses, and Taproom's
first-load seeding writes the Vocalis one as the Vocalis extension's server address for a user who has
never loaded it. Publishing stays on `127.0.0.1` (`HOST_BIND`); put a TLS reverse proxy in front.

**Extension names.** The Taproom image installs the Vocalis extension as `third-party/Vocalis` and
CacheLens as `third-party/taproom-cache-lens`, the names existing installs use, so a per-user copy of the
same name takes precedence as it does today. An existing Docker install loses the per-extension state
keyed by the old folder names `vocalis` and `cachelens` on its next update (the bundled extensions are now
`third-party/Vocalis` and `third-party/taproom-cache-lens`).

## Optional: a render satellite on a second computer

A satellite lends a second computer's graphics card to Vocalis for Chatterbox speech. It is optional,
and it is set up on that computer, not here. On Windows with Docker Desktop, run the downloaded setup
program (`Vocalis-Satellite-Setup-<version>-x64.exe`); it puts an icon in the notification area to
start and stop the satellite. On Linux, run the downloaded script (`satellite/satellite-setup.sh`);
it installs the `vocalis-satellite` command to start it, stop it and follow its log. Either way,
three steps in Vocalis Settings finish the job. See the [satellite guide](satellite/README.md).
Nothing in this instance's `instance.env`, Compose files or ports changes when you add one; Vocalis
calls out to the satellite.

## Stopped-service backup and restore

Stop this instance from the package directory with the same root:

```sh
docker compose --project-name vocalis-<instance-id> \
  --env-file <instance-root>/instance.env \
  -f packaging/compose.yaml -f packaging/compose.<cuda-or-rocm>.yaml stop
```

After Docker reports both services stopped, copy `instance.env`, `data/`, and any cache/work
content you want to preserve to a separate backup destination. Include `models/` only when you
prefer a local copy of redownloadable public model files. Preserve the directory layout. Do not
copy a running instance's SQLite/account stores or vault files as a live backup.

To restore, stop the target instance, restore those paths under its selected root, and keep a copy
of the original `instance.env` with the backup. Confirm all Compose bind sources exist before
starting. For an uncertain or older backup, restore to a separate test root first and edit that
test root's copy of `instance.env`: set `INSTANCE_ROOT` to the test root's canonical path. If the
original instance will remain present, also choose a distinct `INSTANCE_ID` and unused ports, then
update the saved public URLs to match those ports. Preserve the original backup and its settings
unchanged. Never run first-time owner provisioning against restored data; verify the existing
Taproom owner instead.


## Build inputs gathered outside the repository

The engine layers were built from inputs (wheels, source archives, model files) that were gathered in a local
work folder. That folder is `.codex/` at the root of the repository on the build machine; Git ignores it and it is
not part of this repository. A path that begins `.codex/` in a lock or manifest file here is relative to that
repository root on the build machine, so it cannot be followed in a clone. In the pip lock files (`*.lock`) such
paths appear only in the generated header and in `# via` comments, which show what the resolver was given; every
package entry carries its SHA-256 hashes. In the JSON manifests and verification records they name the local copy
of a gathered file beside the SHA-256 recorded for it, and each record identifies the file by its upstream name and
version, an upstream URL, or a repository revision (for example the Hugging Face revision in
`packaging/acestep/inputs/model-acquisition-verification.json` and the PyPI URL in
`packaging/acestep/dwt1d-source-artifact.lock.json`). The recipe in `packaging/trim/Dockerfile` copies its inputs from
fixed paths in the same folder, and a few build scripts use it as the default place to find build inputs or to write
build logs. These files are kept
exactly as the builds used them; they are build records, not setup instructions.
