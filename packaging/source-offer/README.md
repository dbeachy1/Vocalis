# Source offer and rebuild steps

This folder holds the program that makes the "Source code for this build" page and its source archive for
Taproom, and the rules for what goes in them. It also describes how to rebuild the FFmpeg that the main image
contains. For which license covers which part, and where the source of every third-party component is, read
[`../licenses/NOTICE.md`](../licenses/NOTICE.md).

## What the page and the archive contain

`build_source_offer.py` creates the required named build context for the Taproom image. It accepts only the
exact file list in `allowlist.json`; it fails if the selected source roots gain or lose files, if an input is a
symlink, or if a model-weight artifact is present. The same payload supplies the archive and the application
files copied into the image.

The archive `vocalis-<version>-source.zip` holds our own sources and everything we changed or built ourselves:
the Taproom, Vault, Mnemosyne, CacheLens, MCP Client and Vocalis extension sources, the Dockerfiles, lock files
and setup sources under `packaging/`, the patched Chatterbox wheel and its patch, the custom FFmpeg build recipe
and its locks, and the license notices. It does not contain model weights, nor the source of third-party
components that are used unmodified. Their source is published by their own projects or by Ubuntu; the license
notices (`packaging/licenses/NOTICE.md` in the archive, and the `*-source-artifacts.json` records beside it) give
the address of each one's source for the exact version in the images. The page says this in its "Other
third-party open-source components" entry and serves the notices file beside the page as `/source/NOTICE.md`.
The FFmpeg entry links the official FFmpeg 8.0.1 release tarball with its SHA-256.

## Make the page and the archive

From a clean checkout, generate a fresh output directory and use its two contexts when building
`packaging/taproom/Dockerfile`:

```powershell
python packaging/source-offer/build_source_offer.py --output <output folder>
docker buildx build --file <output folder>/build/Dockerfile `
  --build-context taproom-source=<output folder>/taproom-source `
  --build-context apt-runtime=<verified-runtime-deb-context> `
  --build-context apt-build=<verified-build-deb-context> <output folder>/build
```

Pass `--outside-codex` to use a new folder of your choice, anywhere except inside the archive's own source roots
(`packaging/`, `source/...`, `README.md`, `LICENSE`), where the generated files would show up as unlisted source
files. Without that option the script only accepts a folder under the ignored work folder that the project's
maintainers use, and its error message says so.

The generated `build` context contains only the Dockerfile. The explicit `taproom-source` context contains the
frozen payload and the generated page, manifest, ZIP and notices copy. The archive is uncompressed so its bytes
are deterministic across supported Python/zlib versions; its manifest and ZIP metadata use stable ordering and
timestamps. A new source file under a selected root requires a deliberate allowlist update. Source changes
alter the archive manifest and checksum. A downstream operator who modifies covered code must regenerate and
serve the matching offer.

## Rebuild the FFmpeg in the main image

The main image builds FFmpeg 8.0.1 (an LGPL-only build, described in the notices) from two named build
contexts: `ffmpeg-source` (the FFmpeg tarball) and `ffmpeg-debs` (nine Ubuntu audio packages). To make both from
the publishers' downloads:

```sh
python packaging/ffmpeg/prepare_ffmpeg_contexts.py --output <new folder>
```

The step downloads `https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz` and the nine packages from the Ubuntu
archive (the addresses are in `packaging/ffmpeg/build-contract.json`), checks every file's size and SHA-256
against `packaging/ffmpeg/build-contract.json` and `packaging/main-cuda/ffmpeg-native.lock`, and refuses with a
message naming the file on any mismatch. It keeps nothing unchecked: on a refusal the folder is removed. The
folder you name must not exist yet (or must be empty). The step needs only Python 3.9 or later.

If your system's certificates make Python reject a server certificate (one Windows machine did, because its
certificate store still held an expired intermediate certificate), run the step where the certificates are
current rather than turning checking off, for example in a container:

```sh
docker run --rm -v <checkout>:/repo:ro -v <parent of the new folder>:/out -w /repo python:3.12-slim \
  python packaging/ffmpeg/prepare_ffmpeg_contexts.py --output /out/ffmpeg-contexts
```

Then build with the prepared folder:

```sh
python packaging/build_main_app.py --inputs <inputs json> --ffmpeg-contexts <the folder>
```

Without `--ffmpeg-contexts`, `build_main_app.py` reads the same files from `--artifact-root` as before. The Dockerfile
checks the tarball's SHA-256 again before it builds, and the build helper checks every package again against the
lock before it starts. The recipe is the `ffmpeg-build` stage of `packaging/main-cuda/Dockerfile.app`; the
configure options, the pinned build packages and the replacement route are in the notices and in
[`../ffmpeg/README.md`](../ffmpeg/README.md).
