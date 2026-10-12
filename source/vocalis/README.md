# Vocalis

> **Vocalis 12.0 is released as a Docker package.** To install and use it, read the
> [README at the top of this repository](../../README.md). This file is the application's own README
> and describes installing it by hand from this source folder, without Docker. This release does not
> package or test that way of running it, and the text below mentions features that are not in this
> edition. Two documents it links, `DEPLOYMENT.md` and `docs/RESTORE_5_0.md`, are not part of this
> repository.

Local, self-hosted text-to-speech powered by [Chatterbox](https://github.com/resemble-ai/chatterbox)
by Resemble AI. One server (`vocalis_server`) drives everything:

- **A web app** (Flask, port 7870) — quick TTS playground, a `.docx`/`.epub` → audiobook
  pipeline with a library browser, voice management, and per-voice tuning.
- **Two chat integrations with real-time streaming (3.0)** — a **Nomi.ai** Chrome extension
  and a **SillyTavern** extension. Both play chat messages through your local Chatterbox
  voice; audio starts within seconds while the rest of the message is still rendering.
- **Command-line tools** — a CLI generator and a batch audiobook renderer.

Runs on **Windows + NVIDIA/CUDA** and on **Linux + AMD/ROCm** (see [Running on AMD / ROCm](#running-on-amd--rocm)).
For running it on a LAN with HTTPS as a background service, see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Prerequisites

- **Linux** (AMD ROCm / NVIDIA CUDA) — the primary target, and the platform every feature runs on.
  **Windows 10/11** (NVIDIA CUDA) runs the core app; see [Platform support](#platform-support) for
  the parts that are Linux-only.
- **Python 3.10+** in PATH (`python --version` to verify)
- A supported GPU: **NVIDIA** with CUDA (RTX 3090/4090-class recommended) or **AMD** with ROCm.
  CPU works but is very slow.
- **Git** (setup clones one dependency from GitHub)
- A [HuggingFace](https://huggingface.co) account and API token with **Read** access (model download)

---

## Platform support

**Linux is the reference platform.** Everything is developed and tested there. Windows runs the
core app — speech for every tab, the book pipeline, Voice Studio, the CLI — and the rest of this
table says where it stops.

| Part | Linux | Windows |
|---|---|---|
| Speech (Playground, Book, Bulk, Nomi, SillyTavern), Voice Studio, CLI | ✅ | ✅ |
| Hardware strip: CPU load, clock, RAM, uptime | ✅ | ✅ |
| Hardware strip: CPU temperature | ✅ (sysfs) | Only while **HWiNFO** or **LibreHardwareMonitor** is running — see below |
| Hardware strip: package power, load average, memory pressure, ZFS ARC, swap | ✅ | ❌ — no unprivileged Windows source, so those fields stay blank |
| Optional engines (VoxCPM2, enhance, DeepFilterNet, trim scorer) | ✅ | VoxCPM2 and enhance have Windows installers; **the VoxCPM2 one is untested** |
| **ACE-Step** (Music) and **ComfyUI** (LoRA Studio, Video) | ✅ | ❌ — Vocalis starts and stops their backends through `systemd --user`, which Windows has no equivalent of, so both are hidden |
| Encryption at rest | ✅ | ❌ by design — use BitLocker; see [Why Linux only](#why-linux-only) |

**CPU temperature on Windows.** There is no unprivileged API for it: a real sensor needs a kernel
driver. HWiNFO and LibreHardwareMonitor already load one, so Vocalis reads whichever of them is
*running* — HWiNFO needs **Settings ▸ Shared Memory Support**, LibreHardwareMonitor needs
**Options ▸ Remote Web Server** (port 8085 by default; override with `VOCALIS_LHM_PORT` or
`sensors: lhm_port:` in `app_settings.yaml`). With neither running the field is simply absent.

---

## Optional engines

None of these are installed by `setup.sh` / `setup.bat`, and Vocalis hides each feature until its
toolchain exists. Each lives in its **own** virtual environment — their torch builds conflict with
the one that serves every render.

| Engine | What it unlocks | Install |
|---|---|---|
| **VoxCPM2** | Voices → *Create a voice* (design a voice from a description) | `./scripts/voxcpm/setup_voxcpm.sh` · Windows: `scripts\voxcpm\setup_voxcpm.bat` (untested) |
| **resemble-enhance** | ✨ Enhance in Book and SillyTavern ▸ Clips | `./scripts/enhance/setup.sh` · Windows: `scripts\enhance\setup.bat` |
| **DeepFilterNet3** | Denoise in the clip cleanup pass | `./scripts/cleanup/setup_dfn.sh` (Linux only) |
| **Trim scorer** | Automatic clip trimming scores | `./scripts/cleanup/setup_trim.sh` (Linux only) |

Each installer takes a `*_VENV` environment variable to place its venv elsewhere; Vocalis finds it
through the matching setting (`VOCALIS_VOXCPM_VENV`, `VOCALIS_ENHANCE_VENV`, `VOCALIS_DFN_VENV`,
`VOCALIS_TRIM_VENV`, or the same keys in `app_settings.yaml`). The interpreter inside is resolved
per platform — `bin/python` on Linux, `Scripts\python.exe` on Windows — so a venv built by the
Windows installer is found without configuration.

---

## First-time Setup

**1. Set your HuggingFace token** (one-time; persists across reboots):

```cmd
setx HF_TOKEN "hf_your_token_here"
```

Open a **new** terminal afterward so the variable is picked up. (On Linux, export `HF_TOKEN`
in your shell profile instead.)

**2. Clone and run setup:**

```bash
git clone https://github.com/YOUR_USERNAME/Vocalis.git
cd Vocalis
./setup.sh           # Linux — installs the ROCm (or CUDA) PyTorch wheel + all deps
```

```cmd
setup.bat            :: Windows — installs PyTorch 2.6.0 + CUDA 12.4, Chatterbox, and all deps
```

Setup creates a virtual environment in `venv\` and does not touch your system Python or PATH.
It installs everything needed for the web app, the book pipeline (`python-docx` + `lxml`),
and the CLI. First run takes a few minutes.

**3. Launch the web app:**

```cmd
scripts\start_web.bat
```

Open **http://127.0.0.1:7870**. On first generation the Chatterbox model downloads from
HuggingFace (~3–5 GB); later runs load from cache and start in seconds.

> 🔴 **One of the questions `./setup.sh` asks cannot be answered later.** Encryption at rest is
> an install-time choice, and the moment you generate anything the answer is fixed at "no". If
> you skipped the questions — with `--no-configure`, on Windows, or because setup ran without a
> terminal — read **[After setup — what you still have to decide](#after-setup--what-you-still-have-to-decide)**
> below **before your first render.**

---

## After setup — what you still have to decide

Installing is only half of it. There are six decisions an installer cannot make for you, and
until 7.3.11 nothing asked — so they got made by silence, including one that cannot be un-made.

**`./setup.sh` now asks them**, in the order below, as soon as the install finishes. The pass is
always optional: press Enter through it to take every default, skip it entirely with
`--no-configure`, and it skips *itself* whenever stdin is not a terminal, so CI and unattended
re-runs are unaffected. To answer the questions later — or on an install you already have —
run **`./setup.sh --configure-only`**, which asks and installs nothing.

> ⚠️ **`setup.bat` (Windows) does not have the interactive pass** — it prints a pointer to this
> section instead. Two of the six do not apply on Windows at all (there is no systemd, and
> Vocalis's own at-rest encryption is Linux-only); the other four are the by-hand commands below.

The rest of this section is what it asks you, why each one matters, and how to do any of it by
hand.

| # | Decision | What you get if the question never gets answered | Revisit later? |
|---|---|---|---|
| 1 | **Admin login** | none — **anyone who can reach the port gets the settings, your voices and your books** | yes, any time |
| 2 | **Encryption at rest** (Linux only) | **off** | 🔴 **no — install-time, and effectively one-way** |
| 3 | **Cache location** — `VOCALIS_CACHE_DIR` | `~/.cache/vocalis` (`%LOCALAPPDATA%\Vocalis\cache` on Windows) — **keyed on who is logged in, not on where Vocalis is installed** | yes, at the cost of the cached audio |
| 4 | **Scratch location** — `VOCALIS_SCRATCH_DIR` | `<install>/work/scratch` — already per-install, and swept clean at every start | yes, freely |
| 5 | **Applio workspace** — `VOCALIS_APPLIO_DIR` | `~/Applio` — **also keyed on who is logged in** | yes, but move the ~5 GB workspace with it |
| 6 | **Running it as a service** | nothing — you start it by hand and it stops with your shell | yes, any time |

**Rows 3 and 5 only bite if you run two Vocalis installs on one machine**, and then they bite
hard: both default to a path under your home directory rather than under the install, so the
second install silently shares the first one's. Cache collisions are caught — each root carries a
`.vocalis-instance` marker naming the install and pid holding it, and a second instance **refuses
to start** while another *live* install holds that root, rather than mix its audio into someone
else's store. **`~/Applio` has no such guard**; two installs just train into one workspace.

> ### 🔴 Row 2 is the one that will not wait
>
> Encryption is an **install-time** choice. `vault_migrate` turns it on only while the data store
> is **empty**, and turns it back off again only while it is **still** empty — Vocalis does not
> migrate existing data in either direction, by design. So *"I'll decide later"* quietly resolves
> to **"no, permanently, unless I wipe and start over."**
>
> If there is any chance you want your audio, your books and your trained voices encrypted at
> rest, **decide it now, before you generate anything**. Full detail, including what living with
> it is like: [Encryption (optional)](#encryption-optional).

### Do them in this order

The order is not arbitrary — each step needs the one before it.

**1. Set the per-instance paths — but only if you need them.** A single install using the default
locations needs no file at all. If you run a second Vocalis on this box, or want the cache or the
scratch somewhere else (a faster disk, an encrypted volume), copy the template and edit it:

```bash
cp vocalis.env.example vocalis.env      # then edit the three paths
```

Both halves read that one file — systemd through `EnvironmentFile=`, and every hand-run
maintenance tool through `tts_utils.load_env_file()` — so the service and the tools cannot
disagree about which install's data they are touching. **Do not set these as `Environment=` lines
in the unit instead:** a shell does not inherit those, so `vault_migrate.py` run from a terminal
would resolve the cache to whichever install happens to own `~/.cache/vocalis`, report on *that*
instance, and offer to clear it. Anything already exported wins over the file, so a deliberate
one-off override still works.

**2. Set the admin login.**

```bash
venv/bin/python scripts/set-admin-credentials.py     # Linux — or ./scripts/set-admin-credentials.sh
```

```cmd
scripts\set-admin-credentials.bat
```

With no password set the web UI is **open**, and says so in a warning at boot. You can also set it
later from the UI (⚙ **Settings** → username + password), which takes effect live with no restart.

🔴 **If you are going to encrypt, this step is mandatory and it comes first.** The login password
*is* the vault password — logging in is the only thing that unwraps your key — so an encrypted
Vocalis with no login is one you can never unlock. `vault_migrate` refuses to enable encryption
without a login for exactly that reason.

**3. Decide encryption, while the store is still guaranteed empty.**

```bash
venv/bin/python src/vault_migrate.py
```

It prints the two stores it is about to operate on **first thing — read those paths before you
answer anything**, especially on a box with more than one install. It then asks for your admin
password and prints a **recovery key, once**: write that down and keep it somewhere that is not
this computer. The whole procedure — including the leak check (`scripts/m10-ship-gate.py`) and
what changes day-to-day once it is on — is under [Encryption (optional)](#encryption-optional).

Deliberately skipping it is a perfectly good answer: **unencrypted is a supported configuration,
not a degraded one.** On Windows it is the only answer — encryption is Linux-only, and
[BitLocker is the recommendation there](#why-linux-only).

**4. Run it as a service (Linux, optional).** Started by hand, Vocalis stops with your shell. For
anything left up on a LAN you want a `systemd --user` unit with linger enabled, HTTPS in front of
it, and — if you have two instances — the `EnvironmentFile=` line from step 1.
**[DEPLOYMENT.md](DEPLOYMENT.md)** has a complete unit to copy, the certificate setup (`mkcert`),
the two-instance collision table, and the log, restart and rollback procedures. Treat its
hostnames, ports, and service names as examples and adapt them to your installation.
Windows has no systemd; run
`scripts\start_web.bat`.

**5. Start it and log in** — `scripts/start_web.sh` (or `scripts\start_web.bat`), then
**http://127.0.0.1:7870**. On an encrypted install logging in is also the unlock, and `/health`
reports `"initialized": true` with `"locked": false` once it has happened.

### Just trying it out?

One install, one user, a plain disk, started by hand: **press Enter through the pass and set a
password when it offers** — that is step 2, and the defaults are right for you on the rest.
Steps 1, 3 and 4 exist for people running more than one instance, encrypting at rest, or leaving
the server up on a LAN, and none of them blocks a first render.

### Where your files actually end up

Two of these paths live *outside* the Vocalis folder and surprise people: the cache, and Applio's
training workspace. [Folder Structure](#folder-structure) has the table.
[The Scratch Directory](#the-scratch-directory-and-what-it-means-for-your-privacy) explains what
briefly touches the disk in plaintext, what Vocalis guarantees about it, and how to move it. And
if you ever have to get your data back — from a backup, or after losing a password —
that is **[docs/RESTORE_5_0.md](docs/RESTORE_5_0.md)**; the time to read its "what to back up"
list is before you need it.

---

## The Web App (port 7870)

`scripts\start_web.bat` runs the unified server. Everything below shares **one** model instance and
GPU worker pool. Tabs across the top:

| Tab | What it does |
|-----|--------------|
| **Playground** | Type text, pick a voice, tune exaggeration/cfg/temperature, generate. Streams audio as it renders; keeps a per-voice **clip library** (play / download / enhance / delete). |
| **Book** | Sub-tabs: **Generate** — upload a `.docx`/`.epub` and render it chapter-by-chapter into an audiobook (full resume support). **Library** — every rendered book on disk; pick one and its **chapters** appear below: play, download, re-render a single chapter, build a complete Opus, MP3, or Apple AAC audiobook, or clear the book. |
| **Voice Studio** | Sub-tabs: **Stems** (split a song into vocals/instrumental), **Speech** (the shared clip pool — upload a read, or send one here with 🎓 from a Playground clip, a Stem Split's vocals, or a SillyTavern scene), **Voice Training** (train an RVC voice from those clips), **Voice Swap** (re-sing/re-speak audio in a trained voice). |
| **Voices** | Add/replace reference voice clips and set **per-voice, per-context** generation settings (separate tuning for book / playground / Nomi / SillyTavern). |
| **LoRA Studio** | Train a character LoRA — either from **one photo** (Vocalis generates the training set for you) or from **images you already have**. See [LoRA Studio](#lora-studio--training-a-character-lora) below for how many images you need. |
| **Nomi** | Map Nomi IDs → voices and per-Nomi params for the Nomi Chrome extension. |
| **SillyTavern** | Assign voices + params to SillyTavern characters (the extension sends only character names; the server resolves the voice). |
| **⚙ Settings** | GPU selection, worker count, admin login. |

The web UI and the admin routes are login-gated; the `/speak` and OpenAI-compatible `/v1/*`
endpoints the extensions use are open. To set an admin password run `scripts\set-admin-credentials.bat`.
For LAN access and HTTPS, see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

On a GPU host that also runs **ComfyUI** as a neighbor service, the header gains a **Stop / Start
ComfyUI** button that frees the VRAM (and system RAM) ComfyUI holds on the shared card(s). It
controls **one** instance by default. A box running one ComfyUI **per GPU** must declare that with
`comfyui: instances: N` in `app_settings.yaml` — otherwise the button only ever sees the first
instance, and a second running one goes undetected and uncontrolled. Full detail (the generated
service names and ports, or explicit `services:`/`urls:` lists for non-standard names) is under
**How many instances** in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

> The old standalone Gradio single-textbox UI (`start_ui.*`, port 7860) was **removed in
> 5.0** — it was the stock upstream demo, shared no code with production, and was the only
> thing in the repo importing `gradio`. The port-7870 web app above is the interface.

---

## LoRA Studio — training a character LoRA

A **subject** is a person the LoRA will learn, and its **name is the trigger word** — keep it short
and unusual (`fixturetoken`, not `woman`), or it collides with words the base model already knows and the
LoRA fights them every time you use it.

There are **two stages, and the first one is optional.** They are the two sub-tabs across the top of
LoRA Studio:

| Sub-tab | What it is |
|---|---|
| **① Make images from a face** | Optional. Turns one photo into a set of training images. |
| **② Train from a set of images** | Produces the LoRA. Takes the images ① made, **or ones you upload**. |

**If you already have pictures of the person, start in ② and skip ① entirely.**

### ① Make images from a face — optional

This stage only **makes pictures**. Give it a single photo and it renders about 72 more of that
person, across this box's cards:

1. **Face** — one photo of the person.
2. **Prompts** — the situations to generate them in.
3. **Generate** — the images.

Its output is *a set of images*, which is exactly what stage ② takes. **Skip this stage entirely if
you already have pictures of the person.**

> The seed face is never trained on. It is a *conditioning input* on every render, which is why
> there is only ever **one** training run — this stage exists to manufacture a consistent set, not
> to learn a face first.

### ② Train from a set of images

The stage that produces the LoRA. It does not care where the images came from — stage ① made them,
or you upload your own photos, renders or screenshots:

1. **Upload** (only if you are starting here) — drop the whole folder in at once. Anything unusable
   is refused **by name** rather than silently skipped, so a stray `Thumbs.db` never costs you a
   file you thought had imported.
2. **Identity block** — the words every caption starts with (see below).
3. **Curate** — keep or reject each one. This is where the hours go, so it is keyboard-first:
   click or `space` toggles (space also advances), arrows navigate, `enter` is fullscreen,
   `shift+click` takes a range.
4. **Train**, then **Test**.

A trained subject then appears in the **Character** dropdown on **Video ▸ Productions**.

### 🔴 How many images do I need?

| | |
|---|---|
| **~20** | the working floor |
| **30–50** | the sweet spot — aim here |
| **100+** | buying training hours for very little |

🔴 **Variety beats count, and this is the one that actually bites.** Twenty genuinely varied shots
beat fifty near-identical ones. Vary **angle**, **expression**, **framing** (close / bust / full)
and **lighting**.

**The failure is silent.** Fifty frames pulled from one game are very often fifty frames of the same
three camera setups under the same lighting rig — the run completes normally, nothing warns you, and
the LoRA is simply *rigid*: it reproduces one pose and one light.

Images are converted to PNG on the way in and **their framing is left alone** — no square crop, no
resize to a fixed size, because that would throw away exactly the compositional variety this section
is about. The only geometry applied is a proportional cap on the long edge (2048 px), which is a
scale, not a reframe. The trainer buckets by aspect ratio itself.

### The identity block, and how to stop a style bleeding into your character

The identity block is the constant text prepended to every caption. It matters more for uploaded
images than for generated ones, because of one counterintuitive rule:

> **Words present in a caption attach to those words. Anything absent is absorbed into the trigger
> word.**

So if you train on 50 renders of a game character and caption nothing but `laura`, then **`laura`
means that-character-as-a-game-render** — the art direction, the engine lighting and the stylized
skin all become part of the trigger, and every image you ever generate carries them.

Put the style *in the identity block* instead — `laura, a 3D game render of a woman with a short
dark bob` — and those words carry the style while `laura` carries the face. At inference you simply
do not say them.

It is a mitigation, not a cure: the model has never seen the character outside that style, so *"a
photograph of laura"* is an extrapolation. Three knobs, in the order to reach for them:

1. **Style words in the identity block** — free, do it always.
2. **Lower the LoRA strength** on the Test screen — already built, costs nothing.
3. **Mix 10–15 off-style images into the set** — the real fix when 1 and 2 are not enough.

The block is composed into captions **at Build time, not at upload time**, so you can keep editing
it after the images are in and every caption follows. Per-image captions are optional and hold only
what *varies* in that shot; the identity block is added for you.

### What it costs to train

Measured on two AMD R9700s (32 GB each):

| Preset | Resolution | Steps | Rate | Peak VRAM | Wall clock |
|---|---|---|---|---|---|
| **Fast** | 512 | 2,000 | 6.58 s/it | 24.2 GiB | ≈ 3h40m |
| **Quality** (default) | 1024 | 2,000 | 17.3 s/it | 27.42 GiB | ≈ 9h40m |

Training holds **both cards for the whole run**, so LoRA Studio refuses to start while ComfyUI is
up and tells you which button to press rather than stopping it behind your back. Step count is a
form field (minimum 100), independent of dataset size — a 20-image set does not need a
proportionally shorter run.

---

## Chat Integrations

### Nomi.ai Chrome extension

Injects a local Vocalis play button into the Nomi web interface, replacing ElevenLabs TTS with
your configured Chatterbox voice. Uses the 3.0 streaming path with a whole-file fallback, and
caches generated audio by content hash.

1. Map your Nomi IDs to voices (and per-Nomi delivery settings) in the **Nomi** tab.
2. Run `scripts\start_web.bat` (serves the UI **and** `/speak` on port 7870).
3. Load `nomi\chrome_extension\` as an unpacked extension in Chrome. It defaults to a local
   server; set the URL (e.g. `https://vocalis-host:7870` for a LAN HTTPS host) in the extension's **Options**.

Full design: **[nomi/docs/DESIGN.md](nomi/docs/DESIGN.md)**.

### SillyTavern extension (3.0 streaming)

A speaker button on every SillyTavern message plays it through Vocalis's real-time streaming
path, with optional auto-narrate for new replies. **Voices are assigned server-side** in the
web app's **SillyTavern** tab — the extension only sends character names, and the server
resolves the voice + per-character params (auto-registering names it hasn't seen). If a stream
dies mid-generation, playback stops and a **[Retry] / [OK]** dialog appears.

Because Vocalis is a private repo, the extension is installed by **copying the folder** into
SillyTavern's third-party extensions directory (SillyTavern's "Install extension" button needs
a public git URL). Full instructions: **[sillytavern/README.md](sillytavern/README.md)**.

Any OpenAI-compatible TTS client can also use the whole-file endpoint `POST /v1/audio/speech`
(with `GET /v1/audio/voices`). **The pairing token is the API key**: paste it wherever the
client asks for one, and it rides as `Authorization: Bearer <token>` — the exact header OpenAI
clients already send. (7.0-m6 — an anonymous `/v1/*` call answers 401 in OpenAI's error shape.)

#### Several SillyTavern users? One Vocalis each.

**Vocalis is a single-user application and stays that way.** It has one vault, one password and
one owner. So when several people share a SillyTavern, they do not share a Vocalis — **each user
runs their own**, and the extension is built for that.

- **You do not need to be a SillyTavern admin to use Vocalis.** An admin installs the extension
  once, *globally*, and that is the only step that needs admin rights. After that every user opens
  **Extensions → Vocalis**, fills in **their own** server URL and **their own** pairing token, and
  those settings are saved to that user's own `settings.json`. Nobody can see or change anybody
  else's.
- **Each user's Vocalis is their own vault** — encrypted or not, their choice (see
  [Encryption](#encryption-optional)). They own their files completely. Another user's Vocalis
  cannot read them, and **Vocalis never reads SillyTavern's files at all** — everything crosses as
  HTTP through the extension.
- **The pairing token is per-instance, and it is the credential for everything the extension
  does** (7.0-m6): narration, pre-render, scene builds and the worldbook/card channel all send
  it as a bearer, and a Vocalis with an admin password set refuses `/v1/*` without it. Each
  Vocalis mints its own, rejected by every other, so two users' setups cannot get crossed even
  by accident — and one user cannot see, use, or cancel another's work.
- ⚠️ **What m6 did NOT close, said plainly:** the Nomi channel (`/speak`, `/speak/stream*` — 4
  routes) is still unauthenticated, pending its own milestone (its client is a separate Chrome
  extension with its own install path). And an install with **no admin password** runs in the
  pre-2.x first-run posture: everything open on the LAN, warned at boot. Multi-user means every
  instance sets a password.

**Your Vocalis can run on your own machine even when SillyTavern is somewhere else.** The
extension calls Vocalis *from your browser*, not from the SillyTavern server — so a SillyTavern
on a remote host works fine with a Vocalis on your own `127.0.0.1`.

> 📌 **That is also the most private arrangement**, because a Vocalis bound to `127.0.0.1` is
> reachable from nowhere but your own machine. Chrome and Firefox treat `http://127.0.0.1` as
> trustworthy, so an HTTPS SillyTavern page can call it with no TLS setup at all. **Safari does
> not** — on Safari, put Vocalis behind TLS (`--tls-adhoc` or a real cert).
>
> If instead you run Vocalis on an address others can reach, **anyone who can reach that port can
> use it**. Bind to loopback unless you have a reason not to.

---

## Command-line Tools

### CLI generation

Generate speech from a text file or inline text:

```cmd
scripts\generate.bat --file chapter01.txt -o chapter01.wav --voice voice_samples\Brianna_full.mp3
scripts\generate.bat "Hello, world." -o hello.wav --voice voice_samples\Brianna_full.mp3
```

Full options: `scripts\generate.bat --help`.

### Audiobook pipeline

Convert a Word `.docx` novel to a chapter-by-chapter audiobook (the CLI tool is `.docx`-only;
the web **Book** tab also accepts `.epub`):

```cmd
scripts\book_to_audio.bat "My Novel.docx" --voice voice_samples\Brianna_full.mp3
```

- Skips the table of contents automatically
- Splits on Heading 1 (parts) and Heading 2 (chapters) by default
- Chunks long text at sentence boundaries (~400 chars per Chatterbox call)
- Full resume support — re-running picks up where it left off
- Chunks are kept in `chunks\` for safe resume and truncation recovery
- Output WAVs land in `output\<docx_stem>\`

> Want a one-click shortcut for a voice you use often? Copy `book_to_audio.bat`, rename it,
> and hard-code your `--voice voice_samples\<your-file>.wav` in the copy.

#### Working with non-standard document styles

Word documents exported from Caliber or other tools often use non-standard paragraph style
names for chapter headings (e.g. `Para 08` instead of `Heading 2`).

**Step 1 — inspect the document's styles:**

```cmd
scripts\book_to_audio.bat "HisBook.docx" --list-styles
```

This prints every paragraph style with its paragraph count and how `book_to_audio` would
classify it. Look for the style(s) used for chapter headings.

**Step 2 — run with custom styles** (the flag replaces the default `Heading 2` and is repeatable):

```cmd
scripts\book_to_audio.bat "HisBook.docx" --voice voice_samples\Brianna_full.mp3 ^
    --chapter-style "Para 08" --chapter-style "Para 41"
```

**Step 3 — verify before a full run** by combining `--list-styles` with your flags; the custom
styles should show as `← SECTION BREAK`. `--part-style` works the same way for part/volume
headings and is also repeatable.

### WAV to MP3

Convert all WAVs in a folder to mono MP3 (originals untouched; safe to re-run; needs `ffmpeg` in PATH):

```cmd
scripts\wav_to_mp3.bat "D:\Audio\MyNovel"
```

---

## Voice Samples

The `voice_samples\` folder holds reference audio for voice cloning — each clip should be
~10–60 seconds of clean speech. `.wav` and `.mp3` references are both accepted. Add your own files
here and select them in the web app or via the `--voice` flag.

**One sample voice ships with the repo** — `Brianna_full.mp3` — so there's something to try on a
fresh install. Everything else in this folder is yours: the folder is gitignored, so your own clips
never land in a commit and `git pull` will never touch them.

---

## Reading the Output

Each chunk prints a stats line after it generates:

```
[3/7] She looked up at the skyline, wondering if...  [12.6s  31 c/s  |  723 tok  72% ⚠  |  2.3x ]
```

| Field | Meaning |
|-------|---------|
| `12.6s` | Wall-clock time to generate this chunk |
| `31 c/s` | Throughput — input characters per second of GPU time |
| `723 tok` | Speech tokens produced (25 tokens ≈ 1 second of audio) |
| `72%` | Percentage of the 1000-token / 40-second hard cap consumed |
| `✓ / ⚠ / ✗` | Quality zone (see below) |
| `2.3x` | Render rate — audio duration ÷ generation time; `1.0x` = real-time |

**Quality zones** (how close a chunk came to the model's 40-second hard cap):

| Symbol | Token % | Meaning |
|--------|---------|---------|
| `✓` | < 80 % | Well within safe range |
| `⚠` | 80–90 % | Approaching the degradation zone — slight voice drift possible |
| `✗` | > 90 % | Likely quality impact — consider shortening that passage |

You should rarely see `⚠`/`✗`, since the ~400-char chunker targets ~675 tokens (~67% of the cap).
An overall `c/s` average prints after each chapter (`book_to_audio`) or at the end of a run
(`generate`). To refine the upfront time estimate, update `CHARS_PER_SEC` in
`src/book_to_audio.py` to match the `c/s` you observe on a full run.

---

## Performance Notes

- **RTX 4090 / 5080**: ~1,865 chars/minute (~220,000-word novel in ~12 hours); **RTX 5090** ~1.7× faster
- Generation is memory-bandwidth-bound (autoregressive), not compute-bound — expect ~60% GPU
  utilization and modest power draw (~180 W vs 450 W for image gen on an RTX 4090)
- The model stays loaded in VRAM between chunks; no per-chunk reload
- **VRAM**: ~5–6 GB per worker

---

## Render satellites (a second machine's NVIDIA GPU)

A satellite is a small program on another machine — typically a Windows desktop with an NVIDIA
card — that lends that GPU to Vocalis. Its cards appear in ⚙ Settings next to the server's own and
are used like any other. Speech is rendered there and sent back; nothing is written to that
machine's disk, and it never talks to your browser. Everything between the two is encrypted and
authenticated with a secret only the pair share.

**Using the Docker package?** Do not follow the steps below. A satellite for the Docker package is
one downloaded command on the second machine (Linux with NVIDIA or AMD, or Windows with NVIDIA
through Docker Desktop): see the [satellite guide](../../packaging/satellite/README.md). The steps
below are the standalone Windows satellite (`setup.bat` and `run.bat`), which keeps working with
either kind of Vocalis.

**What the satellite machine needs:** an NVIDIA driver, Python 3.10+ on `PATH`, and `git` on
`PATH` (one dependency installs from GitHub).

### Installing one

1. Copy the repo's `satellite/` folder and the pinned wheel
   `packaging/chatterbox/chatterbox_tts-0.1.7+vocalis.1-py3-none-any.whl` to the machine,
   placing the wheel beside `setup.bat` (for example, in `C:\vocalis-satellite`).
2. In Vocalis, **⚙ Settings → Satellites → Add satellite**. Give it a name and the URL Vocalis
   will reach it on (`https://<machine>:7880`). Vocalis shows a shared secret **once** — keep it
   on screen.
3. On the satellite machine, run `setup.bat`. It builds a `venv`, installs PyTorch with CUDA
   (~2.5 GB) and the rest, asks you to paste the secret, and makes a TLS certificate. It ends with
   a self-test whose first run downloads the model (~3 GB).
4. Upload the satellite's `certs\cert.pem` to its entry in ⚙ Settings. Vocalis trusts only that
   certificate.
5. Start it with `run.bat`. It runs in a console window on purpose: closing the window frees the
   GPU, and Vocalis re-sends whatever was in flight.
6. In ⚙ Settings, tick the satellite's cards. They load as soon as you tick them.

`setup.bat` is safe to re-run: it keeps an existing `venv`, and asks before replacing the stored
secret or certificate.

### Updating one

The satellite runs from its own copy, so pulling the repo changes nothing on that machine until
you copy the new `satellite\*.py` files over it and restart `run.bat`. When a release adds
packages, install them into the satellite's own `venv` as well.

**2.0 (Vocalis 10.22) adds two packages** — NVIDIA's `nvidia-ml-py` and `pywin32`:

```
<satellite folder>\venv\Scripts\pip install nvidia-ml-py pywin32
```

Without them the satellite still renders, and its console log says which package is missing.
As of 2.1.0, missing NVML leaves the card name, whole-card VRAM and sensor readings unavailable;
the telemetry request does not initialize CUDA to fill those fields.

### The satellite in the header

With a 2.0 satellite running, the header's GPU strip gains one row per satellite card, below the
server's own — e.g. `satellite-host · cuda:0 NVIDIA GPU` — with the same readouts: the VRAM bar
(the satellite's own share and everything else on that card), busy %, core and memory clock,
power, temperature and fan speed. The browser still talks only to the Vocalis server; the server
polls the satellite 4× a second while a page is open, and once a second while it is not answering.
If it has not answered for 3 seconds the row disappears, and it comes back on the next answer.
An older (1.x) satellite simply has no row.

The satellite console prints one line when Vocalis starts polling it and one when it stops —
never one per poll.

---

## Running on AMD / ROCm

Vocalis is cross-vendor: on ROCm, PyTorch speaks through the CUDA namespace via HIP, so all
runtime code (`torch.cuda.*`, `--gpus`, the worker pool) is unchanged. Set up with `./setup.sh`
(it installs the ROCm PyTorch wheel — force it with `--vendor rocm` if `rocminfo`/`/opt/rocm`
isn't detected). A few environment variables are needed on an AMD box. Put them at the **top of
`~/.bashrc`, above the "if not running interactively, return" guard**:

```bash
# ~/.bashrc — ABOVE the interactive guard
export HF_HOME=/ai-models/hf
export HIP_VISIBLE_DEVICES=0,1   # exclude the CPU iGPU (e.g. cuda:2) from ROCm/HIP
# VOCALIS_DTYPE is deliberately NOT set — the default is per-vendor (see the table below).

# If not running interactively, don't do anything
case $- in *i*) ;; *) return;; esac
```

Bash sources `~/.bashrc` even for the non-interactive shells `sshd` spawns (`ssh remote-host 'cmd'`,
VS Code Remote-SSH, headless agents) — it just returns at the guard — so exports placed *above*
the guard reach those sessions too, with no root/`sudo`. (A `systemd` unit does **not** source
`~/.bashrc`; when running Vocalis as a service, set these in the unit via
`Environment=`/`EnvironmentFile=` — see [DEPLOYMENT.md](DEPLOYMENT.md).)

| Variable | Value | Why |
|---|---|---|
| `HIP_VISIBLE_DEVICES` | `0,1` | **Required** on a box whose CPU has an integrated GPU. ROCm enumerates the iGPU as a third device (e.g. `cuda:2`, `gfx1036`); the app defaults to `--gpus all`, which would pull the iGPU into the worker pool and stall/corrupt inference. This mask hides it. Must be set **before** `import torch`. |
| `HF_HOME` | `/ai-models/hf` | Put the HuggingFace model cache on the model drive instead of `~/.cache`. |
| `VOCALIS_DTYPE` | *unset* | Generation precision: `bf16` \| `fp16` \| `fp32`. **Leave it unset** — the default is per-vendor: **fp16 on ROCm**, **bf16 on CUDA**. fp32 cannot reach RDNA's WMMA matrix units, so on the Radeon AI PRO R9700 fp16 is 2.26× on the vocoder and 1.33× end to end over bf16 (DESIGN_6_2_BATCHING.md §6.2), while on the 4090 bf16 is 13.5% *slower* than fp32 — one value cannot be right for both. Setting it pins the precision on every card and silently discards that. Use `fp32` for exact-reference output; `VOCALIS_TTS_FP16=0` is the narrower switch that returns ROCm to bf16. |

**WAV writing uses `soundfile`, not `torchaudio.save`.** On the ROCm stack (torchaudio 2.11)
`torchaudio.save` routes through `torchcodec`, which isn't installed (and pins torch versions
that would clobber the ROCm build). `soundfile` is a declared dependency and works on every
platform, so all audio writes go through `tts_utils.save_wav_sf`; reads fall back to it via
`load_wav` if needed.

---

## Resuming Interrupted Runs

Both `generate.py` and `book_to_audio.py` resume automatically — re-run the same command and
already-completed chunks are skipped by file-existence check. Safe to Ctrl+C at any time. The
web **Book** renderer resumes the same way.

---

## Folder Structure

```
Vocalis\
  src\                    Python source — vocalis_server.py (the unified server) + modules
    webui\index.html      The web app UI — markup, CSS, three pre-paint blocks (served at :7870)
      js\                 The front end proper: 64 ES modules rooted at js\main.js (7.3)
  sillytavern\            SillyTavern streaming extension + install README
    extension\            Copy this into SillyTavern's third-party extensions dir
  nomi\                   Nomi.ai integration
    chrome_extension\     Load this folder as an unpacked Chrome extension
    docs\DESIGN.md        Nomi integration design (historical)
  voice_samples\          Reference clips for voice cloning (.wav / .mp3) — gitignored
  voice_training\         Your source recordings + prepped datasets for training — gitignored
  voice_models\           Trained RVC voices. 13-18 GPU-hours each and NOT re-downloadable
                          — the most irreplaceable thing here — gitignored
  books\                  Uploaded source documents (.docx / .epub) — gitignored
  output\                 Rendered audio + playground clip library — gitignored
  work\scratch\           Scratch — see below. Transient only; wiped at startup — gitignored
  docs\                   Design + deployment docs
  tests\                  Test suite (pytest)
  venv\                   Virtual environment — created by setup.bat / setup.sh (gitignored)
```

**Two things live OUTSIDE that folder, and both surprise people:**

| | Where | Why you should know |
|---|---|---|
| **The cache** — the shared MD5 audio cache and chunk working files for resume | `%LOCALAPPDATA%\Vocalis\cache` (Windows)<br>`~/.cache/vocalis` (Linux)<br>`~/Library/Caches/vocalis` (macOS) | It follows your OS's cache convention, so backup tools skip it and "safe to delete" is obvious. 🔴 **It is chosen by who is logged in, not by where Vocalis is installed** — so two copies of Vocalis on one machine share one cache and mix their audio together. `VOCALIS_CACHE_DIR` gives an instance its own. |
| **Applio's training workspace** | `~/Applio/logs` | 🔴 **If you train voices, this is the largest pile of your voice on the disk** — and it is not the scratch, and nothing sweeps it. See below. |

---

## The Scratch Directory (and what it means for your privacy)

Some of the tools Vocalis drives — **Demucs** (stem separation) and **RVC** (voice conversion) — are
separate programs. They can't be handed data in memory; they need a real file on a real disk that
they can open. So there is one place where your audio briefly exists as an ordinary, readable file.
That's the **scratch**.

> ### 🔴 Applio (voice training) is the exception — and it's the big one
>
> Everything in this section is about files that exist for minutes and are then deleted. **Applio
> does not use the scratch.** It keeps its own workspace at **`~/Applio/logs`**, and training a
> single voice leaves roughly **5 GB there permanently**:
>
> - your recordings, **sliced into thousands of clips** (~2.3 GB)
> - the resume checkpoints, so an interrupted run can continue (~1.3 GB)
> - **every candidate voice** the Deploy dropdown offers you days later (~880 MB, 13–18 GPU-hours)
>
> **Nothing sweeps it, and it survives every restart** — that's not a bug, it's the point: delete it
> and you've thrown away the training. But it does mean that if you train voices, the honest answer
> to *"where is my voice on this disk?"* is **`~/Applio/logs`**, not the scratch — and none of the
> scratch advice below touches it. See **[Encryption](#encryption-optional)** for what you can do
> about it.

**You do not have to configure anything.** By default it's `work/scratch` inside the Vocalis folder.
Everything Vocalis puts there is deleted when the job that needed it finishes, and the whole
directory is **swept clean every time Vocalis starts** — which covers the case a normal cleanup
can't, i.e. the machine losing power in the middle of a render.

Two things Vocalis guarantees about it, regardless of where you put it:

- **Nothing in it is named after your content.** Filenames are hashes. A book chapter, a chat line
  or a Playground prompt never becomes a filename — because a filename is data too, and it survives
  in directory entries longer than the file does.
- **Nothing persistent lives there.** It only ever holds a job's working audio. Wiping it costs you
  nothing but the time to redo an interrupted job.

### Making it more private (optional, and worth it)

`VOCALIS_SCRATCH_DIR` points the scratch anywhere you like:

```bash
export VOCALIS_SCRATCH_DIR=/path/to/somewhere        # Linux/macOS
setx VOCALIS_SCRATCH_DIR C:\path\to\somewhere        # Windows
```

| Where you point it | What someone with your powered-off drive could recover |
|---|---|
| **Anywhere on a plain, unencrypted disk** *(the default)* | **Deleted files are not erased files.** Vocalis removes each one, but the bytes stay in free space until something overwrites them, and ordinary recovery tools find them. SSD TRIM *usually* discards them — usually is not a guarantee. |
| **A folder on an encrypted disk** — BitLocker (Windows), LUKS (Linux), FileVault (macOS) | **Nothing.** ← **This is the recommendation.** No partitioning, no special setup, and most laptops already have it switched on. |
| **A dedicated encrypted, wiped-at-boot volume** | **Nothing**, and the key never touched the disk. This requires more setup than an encrypted folder. |

> ### ⚠ The one thing Vocalis genuinely cannot fix for you: **swap**
>
> Your operating system can page memory out to disk — the swap file / page file — and it does not
> ask permission. Anything Vocalis (or Demucs, or Applio) is holding **in memory** can land there,
> **in the clear**, and stay on the platter long after the program exits. Encrypting the scratch
> does nothing about it, because the data never went through the scratch.
>
> **Full-disk encryption is what covers this**, and it is the reason it's the recommendation above:
> it protects the swap file, the scratch, and everything else, in one setting you enable once.
> If you care about this at all, turn on BitLocker / LUKS / FileVault and stop worrying about the
> rest of this section.

---

## Encryption (optional)

Everything above describes a Vocalis that keeps your audio, your books and your trained voices as
ordinary files. **Vocalis can also encrypt all of it at rest** — off by default, opt-in, **Linux only**
(see below for why).

**Unencrypted is a real, supported configuration, not a degraded one.** If you never turn this on,
none of this section applies to you and Vocalis behaves exactly as documented above.

### Turning it on — the whole procedure, in order

**Do this on a fresh install, before you generate anything.** The order matters and the tool will
stop you if you get it wrong, but it is quicker to get it right.

**1. Install normally first** (Prerequisites and First-time Setup above — clone, `./setup.sh`).
Don't start the app yet.

**2. Set the admin login.** This is not optional when you encrypt, and it comes *first*:

```bash
venv/bin/python scripts/set-admin-credentials.py
```

(Every command in this section wants the venv Python — they import Vocalis's own modules. Use
`venv\Scripts\python` on Windows, though see *Why Linux only* below.)

> 🔴 **The login password IS the vault password. One password, two uses.** Logging in is the only
> thing that unwraps your key, so an encrypted Vocalis with no login is one you can never unlock.
> `vault_migrate` refuses to enable without a login for exactly that reason, and refuses a vault
> password that isn't your admin password — because the two are checked against different things
> and nothing else keeps them in step.

**3. Turn encryption on:**

```bash
venv/bin/python src/vault_migrate.py
```

> 🔴 **Running more than one Vocalis on this box? Set the environment first.** The instances are
> kept apart *entirely* by `Environment=` lines in their service units — and **a shell does not
> inherit those.** Run this from a plain terminal and it resolves the cache to whichever install
> owns `~/.cache/vocalis`, which may not be the one you are standing in. It then reports on that
> install, and advises you to "clear the data + cache" — of a live instance that is not yours to
> clear.
>
> `vault_migrate` prints the stores it is about to operate on, first thing. **Read those two
> paths before you answer anything.** If they are wrong:
>
> ```bash
> systemctl --user show -p Environment <your-vocalis-unit>   # or: systemctl show -p Environment
> export VOCALIS_CACHE_DIR=...   VOCALIS_SCRATCH_DIR=...     # the values from that output
> ```

It asks for your admin password, then prints a **recovery key, once**. Write it down before you
press anything. It also refuses if the store already holds data — see the box below.

**4. Check nothing leaks**, before you put anything real in it:

```bash
venv/bin/python scripts/m10-ship-gate.py
```

This builds a throwaway vault, drives a voice import, a cleaned clip and a queued swap through it,
and greps the bytes on the platter for anything readable. It touches nothing outside its own temp
directory. `PASS` means the seams are routed on *your* build.

**5. Start the app and log in.** The login unlocks the vault; everything Vocalis writes from then
on is encrypted at rest. `/health` will show `"initialized": true` and `"locked": false`.

**6. (Recommended — and usually already true.)** Make sure the disk holding Vocalis is
full-disk-encrypted and that **swap is encrypted**. The kernel can page plaintext out; an encrypted
store beside an unencrypted swap file still puts your words on the platter, and Vocalis cannot fix
that from inside the app.

No key files to place by hand, no per-file "encrypt this" flags, no volume to mount and remember to
unmount.

### Living with it

**Locking.** Logging out locks the vault and zeroes the key. A locked Vocalis serves **no audio to
anyone**, including the machine endpoints — `/speak` and `/v1/*` for SillyTavern and Nomi return
401 until you log in again. That is deliberate: a locked store is locked for everybody.

**Restarts.** The key lives in RAM only, so restarting the service leaves Vocalis locked. Your
*login* survives (a ~31-day cookie); the *unlock* does not. Log in again after a reboot, or the
integrations stay 401 and it looks like the server is down.

**Changing the password.** Do it **in the web UI**, not with `scripts/set-admin-credentials.py`.
That script writes only the login hash — the half that authenticates. It knows nothing about the
vault, so a new password set that way leaves your key wrapped under the *old* one: you log in
successfully and then fail to unlock, which reads like a broken server rather than a password
problem. The web UI re-wraps the key first and writes the new hash only once the vault has
accepted it, so the two halves cannot drift. The script now refuses outright when it sees a
`vault_keys.yaml`; its `--force` is for exactly one case — re-hashing the **same** password after
losing `admin_credentials.yaml` with the vault intact.

**If you forget the password.** `POST /vault/recover` with your recovery key. It unlocks the data
and resets the password in one action. This is the single way back in — there is deliberately no
reset script, because one would be a back door.

**One login, one vault.** Vocalis has a single admin account, not per-user vaults: one password,
one key, one recovery key. Anyone you give the login to gets the whole store, not a slice of it.

**Backups.** Back up `vault_keys.yaml` along with your data, and keep the recovery key somewhere
that is not this computer. Ciphertext without the keyfile is not recoverable by anyone, including
us — that is the point, and it is also the way to lose everything.

> ### ⚠ Two things to understand before you type that command
>
> **It's an install-time choice, and it's effectively one-way.** Vocalis does not migrate existing data
> in either direction, by design. You can turn encryption on only while the store is **empty**, and turn
> it back off only while it's **still** empty. Once real data exists, the decision is made. **Decide on
> a fresh install.**
>
> **The recovery key is the whole thing.** Lose the password *and* the recovery key and your data is
> gone — that is what encryption means, and there is no back door for us to offer you. Write it down
> and keep it somewhere that isn't this computer.

### Why Linux only

Not because the crypto doesn't run on Windows — it does. **The guarantee is what doesn't cross.**

Vocalis encrypts *inside the application*, rather than just telling you to mount an encrypted volume,
for one specific reason: so that a **poisoned dependency running as you** can't read the key out of
Vocalis's memory. Linux's `yama ptrace_scope=1` forbids one of your processes attaching to another;
Windows has no equivalent switched on by default. Shipping it there would still defend the stolen-disk
case, but quietly fail the case that motivated the whole design — while looking identical.

**On Windows, use BitLocker.** One switch, and it covers the install, the scratch and the page file.

### Hardening: Applio's training workspace

Recall that Applio keeps ~5 GB of your sliced voice at `~/Applio/logs`, outside everything Vocalis
encrypts — Applio writes that tree itself, so Vocalis can't encrypt it in place. Instead, **Vocalis
refuses to start a training** until you tell it the workspace is on an encrypted volume. You tell it by
placing a file:

```bash
touch ~/Applio/logs/.vocalis_encrypted
```

> **That file is a declaration, not a mechanism.** Vocalis cannot tell from inside a process whether a
> directory sits on an encrypted volume, so it asks you to assert it. Putting it on a plaintext folder
> buys you a green light and no protection. It's there so a *forgotten mount* fails loudly instead of
> silently writing your voice in the clear.

**If your disk is already full-disk-encrypted, that file is all you do.** The workspace is covered; the
sentinel just says so.

If it isn't — or you want that workspace encrypted separately from the rest of the disk —
**[gocryptfs](https://github.com/rfjakob/gocryptfs)** is the straightforward option. It gives you an
encrypted directory you mount, with no partitioning and no `crypttab`:

```bash
# one-time
mv ~/Applio/logs ~/Applio/logs.plaintext         # if you already have trainings
gocryptfs -init ~/.applio-cipher                 # create the store; choose a password
mkdir ~/Applio/logs
gocryptfs ~/.applio-cipher ~/Applio/logs         # mount it AT the path Applio uses
mv ~/Applio/logs.plaintext/* ~/Applio/logs/      # existing trainings move IN, encrypted
touch ~/Applio/logs/.vocalis_encrypted

# after each reboot, before training
gocryptfs ~/.applio-cipher ~/Applio/logs
```

Applio reads and writes ordinary files through the mount; the platter holds ciphertext. Applio needs no
flag and no patch — it has no setting for where its logs go, which is exactly why this is done at the
filesystem instead.

🔴 **Then erase the plaintext copy properly** (`shred -u`, or wipe the free space). `mv` off an
unencrypted disk leaves the original bytes recoverable — the same point the scratch table above makes.

**This is further than most people need.** A plain folder on a full-disk-encrypted laptop is the honest
default, and the table above says what that actually costs you.

---

## Further Documentation

**This file is the one to read first** — prerequisites, setup, everything setup leaves you to
decide, the app, the integrations and the CLI. The rest are the deeper dives:

- **[DEPLOYMENT.md](DEPLOYMENT.md)** — the runbook for leaving Vocalis **up on a LAN**: a
  complete `systemd --user` unit, HTTPS with `mkcert`, running **two instances on one box**
  without them colliding, GPU/VRAM controls, logs, restarts and rollback. Adapt its example
  hostnames and ports to your installation when completing step 4 of
  [After setup](#after-setup--what-you-still-have-to-decide).
- **[docs/RESTORE_5_0.md](docs/RESTORE_5_0.md)** — what to back up (six items, one of which is
  the whole ballgame) and how to get your data back, with or without the password
- **[sillytavern/README.md](sillytavern/README.md)** — SillyTavern extension install + usage
- **[nomi/docs/DESIGN.md](nomi/docs/DESIGN.md)** — Nomi integration design
- **`docs/`** — architecture and run-time notes

## License

Eligible Vocalis-authored application and runtime code in this repository is licensed under
Apache-2.0; see [LICENSE](LICENSE). The bundled SillyTavern extension remains licensed under
AGPL-3.0-only; see [sillytavern/extension/LICENSE](sillytavern/extension/LICENSE). Bundled engines,
dependencies, models, and other third-party material keep their own licenses and notices. These
project licenses do not relicense those components.
